output "aws_region" { value = var.aws_region }
output "app_url" { value = local.app_url }
output "image_tag" { value = var.image_tag }
output "ecr_repository_url" { value = aws_ecr_repository.app.repository_url }
output "ecs_cluster" { value = aws_ecs_cluster.main.name }
output "ecs_service" { value = aws_ecs_service.app.name }
output "task_definitions" { value = { for kind, task in aws_ecs_task_definition.app : kind => task.arn } }
output "task_subnet_ids" { value = aws_subnet.app[*].id }
output "task_security_group_ids" { value = [aws_security_group.app.id] }
output "log_group" { value = aws_cloudwatch_log_group.app.name }
output "alb_dns_name" { value = aws_lb.main.dns_name }
output "db_identifier" { value = aws_db_instance.main.identifier }
output "secret_arns" {
  value = {
    owner   = aws_secretsmanager_secret.owner.arn
    runtime = aws_secretsmanager_secret.runtime.arn
    admin   = aws_secretsmanager_secret.admin.arn
  }
}
