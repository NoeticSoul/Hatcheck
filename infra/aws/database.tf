resource "aws_db_subnet_group" "main" {
  name       = local.name
  subnet_ids = aws_subnet.database[*].id
}

resource "aws_db_parameter_group" "main" {
  name_prefix = "${local.name}-"
  family      = "postgres17"
  parameter {
    name         = "rds.force_ssl"
    value        = "1"
    apply_method = "pending-reboot"
  }
  # Utility statements can contain authentication verifiers. Preserve error
  # messages while suppressing statement text/parameter logging in RDS logs.
  parameter {
    name  = "log_statement"
    value = "none"
  }
  parameter {
    name  = "log_min_error_statement"
    value = "panic"
  }
  parameter {
    name  = "log_min_duration_statement"
    value = "-1"
  }
  lifecycle { create_before_destroy = true }
}

resource "aws_db_instance" "main" {
  identifier                          = local.name
  engine                              = "postgres"
  engine_version                      = var.db_engine_version
  instance_class                      = var.db_instance_class
  db_name                             = local.db_name
  username                            = "hatcheck_bootstrap"
  manage_master_user_password         = true
  allocated_storage                   = 20
  max_allocated_storage               = 100
  storage_type                        = "gp3"
  storage_encrypted                   = true
  db_subnet_group_name                = aws_db_subnet_group.main.name
  vpc_security_group_ids              = [aws_security_group.database.id]
  parameter_group_name                = aws_db_parameter_group.main.name
  publicly_accessible                 = false
  multi_az                            = var.db_multi_az
  backup_retention_period             = 14
  backup_window                       = "03:00-04:00"
  maintenance_window                  = "sun:05:00-sun:06:00"
  auto_minor_version_upgrade          = true
  copy_tags_to_snapshot               = true
  deletion_protection                 = true
  skip_final_snapshot                 = false
  final_snapshot_identifier           = "${local.name}-final"
  delete_automated_backups            = false
  enabled_cloudwatch_logs_exports     = ["postgresql", "upgrade"]
  iam_database_authentication_enabled = false
  apply_immediately                   = false
  lifecycle { prevent_destroy = true }
}

# Deliberately create only secret containers. Their random password values
# are written by scripts/aws/deploy.py after apply, never through Terraform.
resource "aws_secretsmanager_secret" "owner" {
  name                    = "${local.name}/database-owner"
  recovery_window_in_days = 30
  lifecycle { prevent_destroy = true }
}

resource "aws_secretsmanager_secret" "runtime" {
  name                    = "${local.name}/database-runtime"
  recovery_window_in_days = 30
  lifecycle { prevent_destroy = true }
}

resource "aws_secretsmanager_secret" "admin" {
  name                    = "${local.name}/initial-admin"
  recovery_window_in_days = 30
  lifecycle { prevent_destroy = true }
}
