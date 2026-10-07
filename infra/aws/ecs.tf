resource "aws_ecr_repository" "app" {
  name                 = local.name
  image_tag_mutability = "IMMUTABLE"
  force_delete         = false
  image_scanning_configuration { scan_on_push = true }
  encryption_configuration { encryption_type = "AES256" }
  lifecycle { prevent_destroy = true }
}

resource "aws_cloudwatch_log_group" "app" {
  name              = "/ecs/${local.name}"
  retention_in_days = var.log_retention_days
}

resource "aws_ecs_cluster" "main" {
  name = local.name
  setting {
    name  = "containerInsights"
    value = "enabled"
  }
}

locals {
  common_environment = [
    { name = "NODE_ENV", value = "production" },
    { name = "PORT", value = "3000" },
    { name = "APP_URL", value = local.app_url },
    { name = "HATCHECK_DB", value = "postgres" },
    { name = "PGHOST", value = aws_db_instance.main.address },
    { name = "PGPORT", value = "5432" },
    { name = "PGDATABASE", value = local.db_name },
    { name = "HATCHECK_PG_SSL_MODE", value = "verify-full" },
    { name = "HATCHECK_PG_SSL_ROOT_CERT", value = "/app/infra/aws/rds-ca/global-bundle.pem" },
    { name = "TMPDIR", value = "/app/runtime-tmp" },
  ]
  task_environment = {
    runtime = concat(local.common_environment, [
      { name = "PGUSER", value = local.app_role },
      { name = "HATCHECK_SKIP_MIGRATIONS", value = "true" },
      { name = "HATCHECK_SKIP_BOOTSTRAP", value = "true" },
      { name = "HATCHECK_TRUST_PROXY", value = "true" },
      { name = "HATCHECK_TRUSTED_PROXIES", value = join(",", local.public) },
    ])
    migrate = concat(local.common_environment, [
      { name = "PGUSER", value = local.owner_role },
      { name = "POSTGRES_RUNTIME_ROLE", value = local.app_role },
      { name = "HATCHECK_SKIP_MIGRATIONS", value = "false" },
      { name = "HATCHECK_SKIP_BOOTSTRAP", value = "false" },
      { name = "HATCHECK_INIT_ADMIN_EMAIL", value = var.initial_admin_email },
    ])
    initialize = concat(local.common_environment, [
      { name = "HATCHECK_SKIP_MIGRATIONS", value = "true" },
      { name = "HATCHECK_SKIP_BOOTSTRAP", value = "true" },
    ])
  }
  task_secrets = {
    runtime = [
      { name = "PGPASSWORD", valueFrom = "${aws_secretsmanager_secret.runtime.arn}:password::" },
    ]
    migrate = [
      { name = "PGPASSWORD", valueFrom = "${aws_secretsmanager_secret.owner.arn}:password::" },
      { name = "HATCHECK_SEED_ADMIN_PASSWORD", valueFrom = "${aws_secretsmanager_secret.admin.arn}:password::" },
    ]
    initialize = [
      { name = "PGUSER", valueFrom = "${aws_db_instance.main.master_user_secret[0].secret_arn}:username::" },
      { name = "PGPASSWORD", valueFrom = "${aws_db_instance.main.master_user_secret[0].secret_arn}:password::" },
      { name = "POSTGRES_OWNER_PASSWORD", valueFrom = "${aws_secretsmanager_secret.owner.arn}:password::" },
      { name = "POSTGRES_APP_PASSWORD", valueFrom = "${aws_secretsmanager_secret.runtime.arn}:password::" },
    ]
  }
  task_commands = {
    runtime    = ["bun", "src/server/index.ts"]
    migrate    = ["bun", "scripts/migrate.ts"]
    initialize = ["bun", "scripts/aws/init-database.ts"]
  }
}

resource "aws_ecs_task_definition" "app" {
  for_each                 = toset(local.task_kinds)
  family                   = "${local.name}-${each.key}"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "512"
  memory                   = "1024"
  execution_role_arn       = aws_iam_role.execution[each.key].arn
  task_role_arn            = aws_iam_role.task.arn
  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }
  container_definitions = jsonencode([
    merge({
      name                   = "hatcheck"
      image                  = "${aws_ecr_repository.app.repository_url}:${var.image_tag}"
      essential              = true
      user                   = "bun"
      readonlyRootFilesystem = true
      stopTimeout            = 30
      command                = local.task_commands[each.key]
      environment            = local.task_environment[each.key]
      secrets                = local.task_secrets[each.key]
      mountPoints            = [{ sourceVolume = "temporary", containerPath = "/app/runtime-tmp", readOnly = false }]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.app.name
          "awslogs-region"        = var.aws_region
          "awslogs-stream-prefix" = each.key
        }
      }
      linuxParameters = { initProcessEnabled = true }
      }, jsondecode(each.key == "runtime" ? jsonencode({
        portMappings = [{ containerPort = 3000, hostPort = 3000, protocol = "tcp" }]
        healthCheck = {
          command     = ["CMD-SHELL", "bun -e 'const r = await fetch(\"http://127.0.0.1:3000/api/v1/live\"); process.exit(r.ok ? 0 : 1)'"]
          interval    = 30
          timeout     = 5
          startPeriod = 60
          retries     = 3
        }
    }) : "{}"))
  ])
  volume { name = "temporary" }
  depends_on = [aws_iam_role_policy.execution]
}

resource "aws_ecs_service" "app" {
  name                               = local.name
  cluster                            = aws_ecs_cluster.main.id
  task_definition                    = aws_ecs_task_definition.app["runtime"].arn
  desired_count                      = var.service_enabled ? 1 : 0
  launch_type                        = "FARGATE"
  platform_version                   = "1.4.0"
  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200
  health_check_grace_period_seconds  = 90
  enable_execute_command             = false
  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }
  network_configuration {
    subnets          = aws_subnet.app[*].id
    security_groups  = [aws_security_group.app.id]
    assign_public_ip = false
  }
  load_balancer {
    target_group_arn = aws_lb_target_group.app.arn
    container_name   = "hatcheck"
    container_port   = 3000
  }
  depends_on = [aws_lb_listener.https, aws_route_table_association.app]
}
