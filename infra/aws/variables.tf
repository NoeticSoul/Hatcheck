variable "aws_region" {
  description = "AWS region selected by the operator; no resources are provisioned by the repository."
  type        = string
  validation {
    condition     = can(regex("^[a-z]{2}(-[a-z]+)+-[0-9]+$", var.aws_region))
    error_message = "Supply an AWS region, such as us-east-1."
  }
}

variable "environment" {
  description = "Short resource-name suffix."
  type        = string
  default     = "pilot"
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{0,14}$", var.environment))
    error_message = "Use 1-15 lowercase letters, digits, or hyphens, beginning with a letter."
  }
}

variable "domain_name" {
  description = "Canonical DNS name for HTTPS and the MSI hosted-server launcher."
  type        = string
  validation {
    condition     = length(var.domain_name) <= 253 && length(split(".", var.domain_name)) >= 2 && alltrue([for label in split(".", var.domain_name) : can(regex("^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$", label))])
    error_message = "Use a lowercase DNS name without a scheme, path, wildcard, or port."
  }
}

variable "certificate_arn" {
  description = "Already validated ACM certificate in aws_region covering domain_name."
  type        = string
  validation {
    condition     = can(regex("^arn:[^:]+:acm:[^:]+:[0-9]{12}:certificate/.+$", var.certificate_arn))
    error_message = "Supply an ACM certificate ARN."
  }
}

variable "route53_zone_id" {
  description = "Optional existing public Route 53 zone; null means create the DNS alias with your DNS provider."
  type        = string
  default     = null
}

variable "allowed_ingress_cidrs" {
  description = "Explicit IPv4 networks allowed to reach HTTPS. Public access is 0.0.0.0/0; prefer your VPN/office egress."
  type        = list(string)
  validation {
    condition     = length(var.allowed_ingress_cidrs) > 0 && alltrue([for cidr in var.allowed_ingress_cidrs : can(cidrnetmask(cidr))])
    error_message = "Supply at least one valid IPv4 CIDR."
  }
}

variable "vpc_cidr" {
  description = "Dedicated /16 IPv4 VPC, chosen to avoid existing network ranges."
  type        = string
  default     = "10.80.0.0/16"
  validation {
    condition     = can(cidrnetmask(var.vpc_cidr)) && endswith(var.vpc_cidr, "/16")
    error_message = "Supply an IPv4 /16 network."
  }
}

variable "nat_gateway_per_az" {
  description = "False uses one NAT gateway for a pilot; true avoids that single-AZ egress dependency. Both incur ongoing cost."
  type        = bool
  default     = false
}

variable "db_instance_class" {
  description = "RDS PostgreSQL instance class; size after measuring the pilot workload."
  type        = string
  default     = "db.t4g.micro"
}

variable "db_multi_az" {
  description = "Enable a standby in another AZ for production availability (additional cost)."
  type        = bool
  default     = false
}

variable "db_engine_version" {
  description = "PostgreSQL 17 version accepted by RDS in aws_region; partial major allows the current minor."
  type        = string
  default     = "17"
  validation {
    condition     = can(regex("^17([.][0-9]+)?$", var.db_engine_version))
    error_message = "This parameter group supports PostgreSQL 17."
  }
}

variable "image_tag" {
  description = "Immutable ECR tag chosen for this release, preferably the reviewed Git commit."
  type        = string
  default     = "initial"
  validation {
    condition     = can(regex("^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$", var.image_tag)) && var.image_tag != "latest"
    error_message = "Use an explicit ECR tag, not latest."
  }
}

variable "service_enabled" {
  description = "Set true only after image push and successful init/migration tasks. Disabled creates a service with zero tasks."
  type        = bool
  default     = false
}

variable "initial_admin_email" {
  description = "Operator-selected initial administrator email. Required; no seed users/assets are created."
  type        = string
  validation {
    condition     = can(regex("^[^@[:space:]]+@[^@[:space:]]+[.][^@[:space:]]+$", var.initial_admin_email))
    error_message = "Supply the administrator's email address."
  }
}

variable "log_retention_days" {
  description = "CloudWatch operational log retention; application audit records remain in the database."
  type        = number
  default     = 30
  validation {
    condition     = contains([7, 14, 30, 60, 90, 120, 150, 180, 365], var.log_retention_days)
    error_message = "Choose a supported CloudWatch retention period."
  }
}
