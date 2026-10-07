#!/usr/bin/env python3
"""Explicit operator actions for the reviewed AWS deployment; never auto-applies IaC.

Python standard library + installed AWS CLI v2, Terraform, and Docker only.
AWS credentials use the ordinary CLI credential chain (prefer AWS SSO).
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import secrets
import subprocess
import sys
import tempfile
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
INFRA = ROOT / "infra" / "aws"
CA = INFRA / "rds-ca" / "global-bundle.pem"


class DeploymentError(RuntimeError):
    pass


def run(arguments, *, input_bytes=None, cwd=ROOT):
    result = subprocess.run(arguments, cwd=cwd, input=input_bytes, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False)
    if result.returncode:
        # Avoid relaying tool output: a tool could include a secret-bearing
        # request or environment value in an error. Diagnose safely in its UI.
        raise DeploymentError(f"{arguments[0]} {arguments[1] if len(arguments) > 1 else ''} failed (exit {result.returncode}); inspect the operation in the AWS console")
    return result.stdout


def aws(*arguments, region):
    return json.loads(run(["aws", "--region", region, "--no-cli-pager", "--output", "json", *arguments]) or b"null")


def outputs():
    state = json.loads(run(["terraform", f"-chdir={INFRA}", "output", "-json"]))
    required = ["aws_region", "app_url", "image_tag", "ecr_repository_url", "ecs_cluster", "ecs_service", "task_definitions", "task_subnet_ids", "task_security_group_ids", "secret_arns", "db_identifier", "log_group"]
    missing = [key for key in required if key not in state]
    if missing:
        raise DeploymentError("Terraform infrastructure has not been applied or outputs are incomplete")
    return {key: state[key]["value"] for key in required}


def ca_preflight():
    checksum = CA.with_suffix(".sha256")
    if not CA.is_file() or not checksum.is_file():
        raise DeploymentError("Fetch and review the official RDS CA bundle before building: python3 scripts/aws/fetch-rds-ca.py")
    expected = checksum.read_text(encoding="ascii").split()[0]
    if hashlib.sha256(CA.read_bytes()).hexdigest() != expected:
        raise DeploymentError("RDS CA bundle does not match its recorded checksum")
    run(["openssl", "crl2pkcs7", "-nocrl", "-certfile", str(CA), "-outform", "PEM"])


def require_image(state):
    repository = state["ecr_repository_url"].split("/", 1)[1]
    response = aws("ecr", "describe-images", "--repository-name", repository, "--image-ids", f"imageTag={state['image_tag']}", region=state["aws_region"])
    if len(response.get("imageDetails", [])) != 1:
        raise DeploymentError("The selected immutable image tag is not available in ECR")
    return response["imageDetails"][0]["imageDigest"]


def require_stopped_service(state):
    response = aws("ecs", "describe-services", "--cluster", state["ecs_cluster"], "--services", state["ecs_service"], region=state["aws_region"])
    services = response.get("services", [])
    if response.get("failures") or len(services) != 1:
        raise DeploymentError("Cannot establish ECS service status")
    service = services[0]
    if any(service.get(key, 0) != 0 for key in ["desiredCount", "runningCount", "pendingCount"]):
        raise DeploymentError("Stop the ECS service through a reviewed Terraform plan before role initialization or migrations")
    # A draining task may have desiredStatus STOPPED while lastStatus is
    # DEACTIVATING/STOPPING. Query both filters and inspect actual task status.
    task_arns = set()
    for desired in ["RUNNING", "STOPPED"]:
        tasks = aws("ecs", "list-tasks", "--cluster", state["ecs_cluster"], "--service-name", state["ecs_service"], "--desired-status", desired, region=state["aws_region"])
        task_arns.update(tasks.get("taskArns", []))
    pending = list(task_arns)
    for offset in range(0, len(pending), 100):
        selected = pending[offset:offset + 100]
        details = aws("ecs", "describe-tasks", "--cluster", state["ecs_cluster"], "--tasks", *selected, region=state["aws_region"])
        if details.get("failures") or len(details.get("tasks", [])) != len(selected) or any(task.get("lastStatus") != "STOPPED" for task in details["tasks"]):
            raise DeploymentError("Wait until every old service task has stopped")


def require_secrets(state):
    for arn in state["secret_arns"].values():
        description = aws("secretsmanager", "describe-secret", "--secret-id", arn, region=state["aws_region"])
        if not any("AWSCURRENT" in stages for stages in description.get("VersionIdsToStages", {}).values()):
            raise DeploymentError("Password secrets are empty; run prepare-secrets first")


def prepare_secrets(state):
    for kind, arn in state["secret_arns"].items():
        description = aws("secretsmanager", "describe-secret", "--secret-id", arn, region=state["aws_region"])
        if any("AWSCURRENT" in stages for stages in description.get("VersionIdsToStages", {}).values()):
            print(f"{kind}: existing secret retained")
            continue
        # File payload keeps the password out of process arguments and shell
        # history on Linux/Windows. The temporary file is removed immediately.
        path = None
        try:
            with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", prefix="hatcheck-secret-", suffix=".json", delete=False) as payload:
                path = Path(payload.name)
                os.chmod(path, 0o600)
                json.dump({"password": secrets.token_urlsafe(36)}, payload)
            aws("secretsmanager", "put-secret-value", "--secret-id", arn, "--secret-string", f"file://{path}", region=state["aws_region"])
        finally:
            if path:
                path.unlink(missing_ok=True)
        print(f"{kind}: random password stored securely; value not printed")


def one_off(state, kind, timeout=1200):
    network = {"awsvpcConfiguration": {"subnets": state["task_subnet_ids"], "securityGroups": state["task_security_group_ids"], "assignPublicIp": "DISABLED"}}
    response = aws("ecs", "run-task", "--cluster", state["ecs_cluster"], "--task-definition", state["task_definitions"][kind], "--launch-type", "FARGATE", "--platform-version", "1.4.0", "--network-configuration", json.dumps(network), region=state["aws_region"])
    if response.get("failures") or len(response.get("tasks", [])) != 1:
        raise DeploymentError(f"ECS could not launch the {kind} task")
    arn = response["tasks"][0]["taskArn"]
    print(f"{kind} task started: {arn}", flush=True)
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        status = aws("ecs", "describe-tasks", "--cluster", state["ecs_cluster"], "--tasks", arn, region=state["aws_region"])
        if status.get("failures") or len(status.get("tasks", [])) != 1:
            raise DeploymentError(f"Cannot determine {kind} task status")
        task = status["tasks"][0]
        if task.get("lastStatus") == "STOPPED":
            containers = task.get("containers", [])
            if len(containers) != 1 or containers[0].get("exitCode") != 0:
                raise DeploymentError(f"{kind} task did not succeed; inspect {state['log_group']} (no activation permitted)")
            print(f"{kind} task completed successfully")
            return arn
        time.sleep(5)
    raise DeploymentError(f"{kind} task did not stop within {timeout} seconds; inspect it before retrying")


def save_receipt(state, image, task):
    # A local nonsecret receipt binds the successful owner migration task to
    # the exact deployed task definition and immutable image, never to a guess.
    (INFRA / ".migration-receipt.json").write_text(json.dumps({"task": task, "task_definition": state["task_definitions"]["migrate"], "image": image, "cluster": state["ecs_cluster"]}, indent=2) + "\n", encoding="utf-8")


def require_receipt(state):
    path = INFRA / ".migration-receipt.json"
    if not path.is_file():
        raise DeploymentError("Run a successful owner migration task before creating an activation plan")
    receipt = json.loads(path.read_text(encoding="utf-8"))
    if receipt.get("image") != require_image(state) or receipt.get("cluster") != state["ecs_cluster"] or receipt.get("task_definition") != state["task_definitions"]["migrate"]:
        raise DeploymentError("Migration receipt does not match the current image/task definition")
    response = aws("ecs", "describe-tasks", "--cluster", state["ecs_cluster"], "--tasks", receipt["task"], region=state["aws_region"])
    tasks = response.get("tasks", [])
    if response.get("failures") or len(tasks) != 1 or tasks[0].get("lastStatus") != "STOPPED" or tasks[0].get("taskDefinitionArn") != receipt["task_definition"] or len(tasks[0].get("containers", [])) != 1 or tasks[0]["containers"][0].get("exitCode") != 0:
        raise DeploymentError("The migration task's successful exit can no longer be verified; rerun migrate")


def validate_activation_plan(state, plan):
    document = json.loads(run(["terraform", f"-chdir={INFRA}", "show", "-json", str(plan)]))
    for resource in document.get("resource_changes", []):
        if resource.get("mode") != "managed" or resource["change"]["actions"] == ["no-op"]:
            continue
        if resource["address"] != "aws_ecs_service.app" or resource["change"]["actions"] != ["update"]:
            raise DeploymentError("Activation plan also changes infrastructure/image inputs; apply those with service disabled and rerun migration first")
        after = resource["change"].get("after", {})
        if after.get("task_definition") != state["task_definitions"]["runtime"] or after.get("desired_count") != 1:
            raise DeploymentError("Activation plan must start the already reviewed and migrated runtime task definition")


def publish_image(state):
    ca_preflight()
    image = f"{state['ecr_repository_url']}:{state['image_tag']}"
    print(f"Building Linux amd64 image {image}", flush=True)
    subprocess.run(["docker", "build", "--platform", "linux/amd64", "--tag", image, "."], cwd=ROOT, check=True)
    token = run(["aws", "--region", state["aws_region"], "--no-cli-pager", "ecr", "get-login-password"])
    registry = state["ecr_repository_url"].split("/", 1)[0]
    with tempfile.TemporaryDirectory(prefix="hatcheck-docker-login-") as configuration:
        run(["docker", "--config", configuration, "login", "--username", "AWS", "--password-stdin", registry], input_bytes=token)
        try:
            subprocess.run(["docker", "--config", configuration, "push", image], cwd=ROOT, check=True)
        finally:
            run(["docker", "--config", configuration, "logout", registry])
    print("Image pushed. Review ECR vulnerability scan findings before initialization.")


def check(state):
    service = aws("ecs", "describe-services", "--cluster", state["ecs_cluster"], "--services", state["ecs_service"], region=state["aws_region"])
    services = service.get("services", [])
    if service.get("failures") or len(services) != 1:
        raise DeploymentError("Cannot determine service health")
    selected = services[0]
    if selected.get("desiredCount") != 1 or selected.get("runningCount") != 1 or selected.get("pendingCount") != 0 or len(selected.get("deployments", [])) != 1 or selected["deployments"][0].get("rolloutState") != "COMPLETED" or selected.get("taskDefinition") != state["task_definitions"]["runtime"]:
        raise DeploymentError("The selected runtime deployment is not yet healthy/stable")
    # Default certificate validation and hostname checks remain enabled.
    with urllib.request.urlopen(f"{state['app_url']}/api/v1/ready", timeout=20) as response:
        payload = json.load(response)
        if response.status != 200 or payload.get("status") != "ok" or payload.get("db") != "postgres":
            raise DeploymentError("HTTPS readiness check failed")
    print(f"Healthy central Hatcheck service: {state['app_url']}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["prepare-secrets", "publish-image", "initialize", "migrate", "activation-plan", "check"])
    args = parser.parse_args()
    state = outputs()
    if args.action == "prepare-secrets":
        prepare_secrets(state)
    elif args.action == "publish-image":
        publish_image(state)
    elif args.action in ["initialize", "migrate"]:
        require_stopped_service(state)
        require_secrets(state)
        image = require_image(state)
        database = aws("rds", "describe-db-instances", "--db-instance-identifier", state["db_identifier"], region=state["aws_region"])
        instances = database.get("DBInstances", [])
        if len(instances) != 1 or instances[0].get("DBInstanceStatus") != "available":
            raise DeploymentError("RDS is not available")
        if args.action == "initialize":
            one_off(state, "initialize")
        task = one_off(state, "migrate")
        save_receipt(state, image, task)
    elif args.action == "activation-plan":
        require_receipt(state)
        plan = INFRA / "activation.tfplan"
        subprocess.run(["terraform", f"-chdir={INFRA}", "plan", "-var=service_enabled=true", f"-out={plan}"], check=True)
        try:
            validate_activation_plan(state, plan)
        except DeploymentError:
            plan.unlink(missing_ok=True)
            raise
        print("Review activation.tfplan. Apply only after approval; this script does not apply it.")
        print("Persist service_enabled=true in your local terraform.tfvars after approval so future plans retain the running service.")
    elif args.action == "check":
        check(state)


if __name__ == "__main__":
    try:
        main()
    except (DeploymentError, subprocess.CalledProcessError, OSError, ValueError) as error:
        # OSError/ValueError may include user files, not credentials; omit
        # details for non-DeploymentError exceptions nonetheless.
        print(str(error) if isinstance(error, DeploymentError) else f"Deployment operation failed ({type(error).__name__})", file=sys.stderr)
        sys.exit(1)
