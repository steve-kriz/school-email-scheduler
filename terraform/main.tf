# TASK-049 removed four things that used to live here: data.aws_lb.web_app_alb,
# data.aws_lb_listener.web_app_alb_listener_443, aws_route53_record.this (an
# A-ALIAS from <sub_domain>.<domain_name> to that ALB) and the
# data.aws_route53_zone.domain lookup the record needed.
#
# The app is no longer reachable through the shared basestack ALB, so the two
# data sources had no remaining reader and the DNS record would have pointed a
# hostname at a load balancer that no longer routes to this app - a name that
# resolves but 404s, or worse lands on whatever else the ALB serves. The app now
# answers on aws_lambda_function_url.calendar (see lambda_calendar.tf).
#
# The ALB, its 443 listener and the chatbot's priority-119 listener rule are
# basestack-owned and untouched by this repo.

data "aws_secretsmanager_secret_version" "school_calendar_services" {
  secret_id = local.secret_name
}

locals {
  secrets = jsondecode(data.aws_secretsmanager_secret_version.school_calendar_services.secret_string)
}

# Every read goes through lookup() with an empty default, so a
# partially-populated secret (e.g. ANTHROPIC_API_KEY not yet set in a new
# environment) still plans cleanly instead of erroring on a missing key.
locals {
  google_client_id     = lookup(local.secrets, "GOOGLE_CLIENT_ID", "")
  google_client_secret = lookup(local.secrets, "GOOGLE_CLIENT_SECRET", "")
  anthropic_api_key    = lookup(local.secrets, "ANTHROPIC_API_KEY", "")
  session_secret       = lookup(local.secrets, "SESSION_SECRET", "")
  allowed_origins      = lookup(local.secrets, "ALLOWED_ORIGINS", "")
}

# Lambda Assume Role Policy Document. The execution role itself is defined by
# the Lambda ticket with a purpose-scoped policy; this trust policy is shared.
data "aws_iam_policy_document" "lambda_assume_role_policy" {
  statement {
    effect = "Allow"

    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }

    actions = ["sts:AssumeRole"]
  }
}
