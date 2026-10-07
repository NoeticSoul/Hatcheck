# All resources/data below are mocked. This test never contacts/provisions AWS.
mock_provider "aws" {
  mock_data "aws_availability_zones" {
    defaults = { names = ["us-east-1a", "us-east-1b"] }
  }
  mock_data "aws_caller_identity" {
    defaults = { account_id = "123456789012" }
  }
  mock_data "aws_partition" {
    defaults = { partition = "aws" }
  }
  mock_data "aws_iam_policy_document" {
    defaults = { json = "{}" }
  }
  mock_resource "aws_db_instance" {
    defaults = {
      address = "hatcheck.example.test"
      master_user_secret = [{
        secret_arn    = "arn:aws:secretsmanager:us-east-1:123456789012:secret:hatcheck-master-synthetic"
        secret_status = "active"
        kms_key_id    = "arn:aws:kms:us-east-1:123456789012:key/synthetic"
      }]
    }
  }
  mock_resource "aws_iam_role" {
    defaults = { arn = "arn:aws:iam::123456789012:role/synthetic" }
  }
  mock_resource "aws_lb" {
    defaults = { arn = "arn:aws:elasticloadbalancing:us-east-1:123456789012:loadbalancer/app/synthetic/1234567890123456" }
  }
  mock_resource "aws_lb_target_group" {
    defaults = { arn = "arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/synthetic/1234567890123456" }
  }
  mock_resource "aws_ecr_repository" {
    defaults = { arn = "arn:aws:ecr:us-east-1:123456789012:repository/synthetic", repository_url = "123456789012.dkr.ecr.us-east-1.amazonaws.com/synthetic" }
  }
  mock_resource "aws_cloudwatch_log_group" {
    defaults = { arn = "arn:aws:logs:us-east-1:123456789012:log-group:/ecs/synthetic" }
  }
  mock_resource "aws_ecs_cluster" {
    defaults = { arn = "arn:aws:ecs:us-east-1:123456789012:cluster/synthetic", id = "arn:aws:ecs:us-east-1:123456789012:cluster/synthetic" }
  }
  mock_resource "aws_ecs_task_definition" {
    defaults = { arn = "arn:aws:ecs:us-east-1:123456789012:task-definition/synthetic:1" }
  }
}

override_resource {
  target = aws_secretsmanager_secret.owner
  values = { arn = "arn:aws:secretsmanager:us-east-1:123456789012:secret:owner-synthetic" }
}
override_resource {
  target = aws_secretsmanager_secret.runtime
  values = { arn = "arn:aws:secretsmanager:us-east-1:123456789012:secret:runtime-synthetic" }
}
override_resource {
  target = aws_secretsmanager_secret.admin
  values = { arn = "arn:aws:secretsmanager:us-east-1:123456789012:secret:admin-synthetic" }
}

variables {
  aws_region            = "us-east-1"
  domain_name           = "hatcheck.example.test"
  certificate_arn       = "arn:aws:acm:us-east-1:123456789012:certificate/synthetic"
  initial_admin_email   = "admin@example.test"
  allowed_ingress_cidrs = ["203.0.113.0/24"]
}

run "safe_initial_deployment" {
  command = apply

  assert {
    condition     = aws_ecs_service.app.desired_count == 0
    error_message = "Initial provisioning must not start an unmigrated server."
  }
  assert {
    condition     = !aws_db_instance.main.publicly_accessible && aws_db_instance.main.storage_encrypted && aws_db_instance.main.deletion_protection && aws_db_instance.main.backup_retention_period >= 14
    error_message = "Database must be private, encrypted, protected, and backed up."
  }
  assert {
    condition     = !aws_ecs_service.app.network_configuration[0].assign_public_ip
    error_message = "Application tasks must not have public IP addresses."
  }
  assert {
    condition     = length(local.secret_permissions.runtime) == 1 && local.secret_permissions.runtime[0] == aws_secretsmanager_secret.runtime.arn && !contains(local.secret_permissions.runtime, aws_secretsmanager_secret.owner.arn) && !contains(local.secret_permissions.runtime, aws_secretsmanager_secret.admin.arn)
    error_message = "Runtime execution must receive only the restricted database secret."
  }
  assert {
    condition     = contains(local.task_environment.runtime, { name = "HATCHECK_PG_SSL_MODE", value = "verify-full" }) && contains(local.task_environment.migrate, { name = "HATCHECK_PG_SSL_MODE", value = "verify-full" })
    error_message = "Both application and migration connections must verify RDS TLS."
  }
  assert {
    condition     = contains(local.task_environment.runtime, { name = "HATCHECK_TRUSTED_PROXIES", value = join(",", local.public) }) && contains(local.task_environment.runtime, { name = "HATCHECK_SKIP_MIGRATIONS", value = "true" }) && contains(local.task_environment.runtime, { name = "HATCHECK_SKIP_BOOTSTRAP", value = "true" })
    error_message = "Trust only ALB subnet peers and never initialize through the runtime role."
  }
  assert {
    condition     = jsondecode(aws_ecs_task_definition.app["runtime"].container_definitions)[0].readonlyRootFilesystem && jsondecode(aws_ecs_task_definition.app["runtime"].container_definitions)[0].user == "bun" && strcontains(jsondecode(aws_ecs_task_definition.app["runtime"].container_definitions)[0].healthCheck.command[1], "/api/v1/live")
    error_message = "Runtime must be nonroot/read-only with process liveness independent of RDS."
  }
}

run "explicit_activation" {
  command = plan
  variables { service_enabled = true }
  assert {
    condition     = aws_ecs_service.app.desired_count == 1
    error_message = "Activation currently supports exactly one steady-state process."
  }
}
