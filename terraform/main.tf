data "aws_route53_zone" "domain" {
  name = data.terraform_remote_state.basestack.outputs.domain_name
}

data "aws_secretsmanager_secret_version" "school_calendar_services" {
  secret_id = local.secret_name
}

data "aws_lb" "web_app_alb" {
  name = "${local.name_prefix}-web-app-alb"
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

data "aws_lb_listener" "web_app_alb_listener_443" {
  load_balancer_arn = data.aws_lb.web_app_alb.id
  port              = 443
}

resource "aws_route53_record" "this" {
  zone_id = data.aws_route53_zone.domain.zone_id
  name    = "${var.sub_domain}.${data.terraform_remote_state.basestack.outputs.domain_name}"
  type    = "A"

  alias {
    name                   = data.aws_lb.web_app_alb.dns_name
    zone_id                = data.aws_lb.web_app_alb.zone_id
    evaluate_target_health = false
  }
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
