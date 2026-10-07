"""Local failure-path tests; mocks all AWS calls and never creates resources."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("hatcheck_deploy", Path(__file__).with_name("deploy.py"))
deploy = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(deploy)

STATE = {
    "aws_region": "us-east-1", "ecs_cluster": "synthetic", "ecs_service": "synthetic",
    "task_definitions": {"initialize": "init-synthetic", "migrate": "migrate-synthetic"},
    "task_subnet_ids": ["subnet-synthetic"], "task_security_group_ids": ["sg-synthetic"],
    "log_group": "/ecs/synthetic", "secret_arns": {"runtime": "secret-synthetic"},
    "ecr_repository_url": "123456789012.dkr.ecr.us-east-1.amazonaws.com/synthetic", "image_tag": "synthetic",
}


class DeploymentSafetyTests(unittest.TestCase):
    def test_stopped_task_requires_explicit_zero_exit(self):
        for containers in [[], [{"name": "hatcheck"}], [{"name": "hatcheck", "exitCode": 1}]]:
            with self.subTest(containers=containers), patch.object(deploy, "aws", side_effect=[{"tasks": [{"taskArn": "task-synthetic"}]}, {"tasks": [{"lastStatus": "STOPPED", "containers": containers}]}]):
                with self.assertRaises(deploy.DeploymentError):
                    deploy.one_off(STATE, "initialize")

    def test_successful_task_is_accepted(self):
        with patch.object(deploy, "aws", side_effect=[{"tasks": [{"taskArn": "task-synthetic"}]}, {"tasks": [{"lastStatus": "STOPPED", "containers": [{"exitCode": 0}]}]}]):
            self.assertEqual(deploy.one_off(STATE, "migrate"), "task-synthetic")

    def test_run_task_partial_failure_is_rejected(self):
        with patch.object(deploy, "aws", return_value={"tasks": [{"taskArn": "task-synthetic"}], "failures": [{"reason": "RESOURCE"}]}):
            with self.assertRaises(deploy.DeploymentError):
                deploy.one_off(STATE, "migrate")

    def test_active_service_blocks_role_changes(self):
        with patch.object(deploy, "aws", return_value={"services": [{"desiredCount": 1, "runningCount": 0}]}):
            with self.assertRaises(deploy.DeploymentError):
                deploy.require_stopped_service(STATE)

    def test_draining_task_blocks_role_changes(self):
        with patch.object(deploy, "aws", side_effect=[{"services": [{"desiredCount": 0, "runningCount": 0, "pendingCount": 0}]}, {"taskArns": []}, {"taskArns": ["task-draining"]}, {"tasks": [{"desiredStatus": "STOPPED", "lastStatus": "STOPPING"}]}]):
            with self.assertRaises(deploy.DeploymentError):
                deploy.require_stopped_service(STATE)

    def test_fully_stopped_historical_task_is_allowed(self):
        with patch.object(deploy, "aws", side_effect=[{"services": [{"desiredCount": 0, "runningCount": 0, "pendingCount": 0}]}, {"taskArns": []}, {"taskArns": ["task-old"]}, {"tasks": [{"lastStatus": "STOPPED"}]}]):
            deploy.require_stopped_service(STATE)

    def test_activation_rejects_a_new_unmigrated_image(self):
        plan = {"resource_changes": [{"mode": "managed", "address": 'aws_ecs_task_definition.app["runtime"]', "change": {"actions": ["delete", "create"]}}]}
        with patch.object(deploy, "run", return_value=json.dumps(plan).encode()), self.assertRaises(deploy.DeploymentError):
            deploy.validate_activation_plan(STATE, Path("synthetic.tfplan"))

    def test_secret_payload_is_private_and_removed(self):
        payload_path = None

        def response(*args, **kwargs):
            nonlocal payload_path
            if args[1] == "describe-secret":
                return {"VersionIdsToStages": {}}
            self.assertEqual(args[1], "put-secret-value")
            payload_path = Path(args[-1].removeprefix("file://"))
            self.assertEqual(payload_path.stat().st_mode & 0o777, 0o600)
            self.assertGreaterEqual(len(json.loads(payload_path.read_text())["password"]), 24)
            return {}

        with patch.object(deploy, "aws", side_effect=response):
            deploy.prepare_secrets(STATE)
        self.assertIsNotNone(payload_path)
        self.assertFalse(payload_path.exists())

    def test_existing_secret_is_not_rotated(self):
        with patch.object(deploy, "aws", return_value={"VersionIdsToStages": {"synthetic": ["AWSCURRENT"]}}) as api:
            deploy.prepare_secrets(STATE)
            self.assertEqual(api.call_count, 1)

    def test_ca_mismatch_fails_before_build(self):
        with tempfile.TemporaryDirectory() as directory:
            ca = Path(directory) / "global-bundle.pem"
            ca.write_text("synthetic CA")
            ca.with_suffix(".sha256").write_text("0" * 64 + "  global-bundle.pem\n")
            with patch.object(deploy, "CA", ca), self.assertRaises(deploy.DeploymentError):
                deploy.ca_preflight()


if __name__ == "__main__":
    unittest.main()
