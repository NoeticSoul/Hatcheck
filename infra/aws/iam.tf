locals {
  task_kinds = ["runtime", "migrate", "initialize"]
  secret_permissions = {
    runtime    = [aws_secretsmanager_secret.runtime.arn]
    migrate    = [aws_secretsmanager_secret.owner.arn, aws_secretsmanager_secret.admin.arn]
    initialize = [aws_db_instance.main.master_user_secret[0].secret_arn, aws_secretsmanager_secret.owner.arn, aws_secretsmanager_secret.runtime.arn]
  }
}

data "aws_iam_policy_document" "ecs_trust" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }
    condition {
      test     = "ArnLike"
      variable = "aws:SourceArn"
      values   = ["arn:${data.aws_partition.current.partition}:ecs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:*"]
    }
  }
}

resource "aws_iam_role" "execution" {
  for_each           = toset(local.task_kinds)
  name               = "${local.name}-${each.key}-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_trust.json
}

resource "aws_iam_role" "task" {
  name               = "${local.name}-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_trust.json
  # No AWS API permissions for application code. Secret delivery and log
  # publication belong to the separate ECS execution roles.
}

data "aws_iam_policy_document" "execution" {
  for_each = toset(local.task_kinds)
  statement {
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }
  statement {
    actions   = ["ecr:BatchCheckLayerAvailability", "ecr:GetDownloadUrlForLayer", "ecr:BatchGetImage"]
    resources = [aws_ecr_repository.app.arn]
  }
  statement {
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.app.arn}:*"]
  }
  statement {
    actions   = ["secretsmanager:GetSecretValue"]
    resources = local.secret_permissions[each.key]
  }
}

resource "aws_iam_role_policy" "execution" {
  for_each = toset(local.task_kinds)
  role     = aws_iam_role.execution[each.key].id
  policy   = data.aws_iam_policy_document.execution[each.key].json
}
