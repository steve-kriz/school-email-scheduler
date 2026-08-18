# =============================================================================
# School Calendar Lambda - Gmail scanner + calendar UI behind the shared ALB
# =============================================================================
# This Lambda serves dual purpose:
#   1. Frontend: serves the calendar SPA (month view, needs-attention list)
#   2. Backend: Google OAuth callback, Gmail scan, Anthropic extraction and the
#      events API, all under the /calendar* path prefix
# =============================================================================


# --- Lambda Package ---
# The AWS SDK v3 is provided by the nodejs24.x runtime, so node_modules only
# ever carries the handful of third-party deps declared in package.json.
data "archive_file" "calendar_lambda_zip" {
  type        = "zip"
  source_dir  = "../src/lambda/calendar"
  output_path = "packages/lambda_function_calendar.zip"
  excludes = [
    "CLAUDE.md",
    ".deployment",
    "package-lock.json",
    "__test_shims__"
  ]
}

# --- App-config secret metadata ---
# main.tf reads the secret VALUE (data.aws_secretsmanager_secret_version) to
# build local.secrets. This lookup exists only for the secret's ARN, so the IAM
# policy below can be scoped to exactly this secret. The version data source
# also exposes an `arn`, but that attribute is deprecated in AWS provider 6.x.
data "aws_secretsmanager_secret" "app_config" {
  name = local.secret_name
}

# --- CloudWatch Log Group ---
# The log group is auto-created by the Lambda runtime the first time the
# function writes a log event. We only need its NAME to pass to the Lambda
# via the CALENDAR_LOG_GROUP_NAME env var — we do not need Terraform to
# manage the resource itself (which would conflict with the auto-created
# group that already exists in every deployed environment).
#
# For NEW environments the Lambda has never run, so the group does not exist
# yet and the CloudWatch metric filters in alerting.tf fail with
# ResourceNotFoundException. Setting var.manage_lambda_log_groups = true
# creates the group here first. For existing environments whose group is
# already present (auto-created, unmanaged), leave the flag false to avoid a
# ResourceAlreadyExistsException — or `terraform import` the group and flip it.
locals {
  calendar_log_group_name = "/aws/lambda/${local.name_prefix}-school-calendar"

  # The Lambda needs its own ARN at runtime (self-invocation for background
  # scans, and the scheduled-scan target in a later ticket). We construct the
  # function ARN from known parts rather than referencing
  # aws_lambda_function.calendar.arn to avoid a self-referential cycle in the
  # function's own environment block.
  calendar_function_arn = "arn:aws:lambda:${var.region}:${var.account_id}:function:${local.name_prefix}-school-calendar"

  # Public origin of the calendar app. Google OAuth redirect URIs and the
  # frontend's own fetch() calls are both derived from this.
  calendar_public_base_url = "https://${var.sub_domain}.${data.terraform_remote_state.basestack.outputs.domain_name}"
}

# --- CloudWatch Log Group (new environments only) ---
# Gated by var.manage_lambda_log_groups. When enabled, Terraform owns the
# group so the metric filters in alerting.tf have a target on a fresh deploy.
# The Lambda runtime reuses an existing group of the same name, so once this
# exists the auto-create is a no-op.
resource "aws_cloudwatch_log_group" "calendar_lambda_logs" {
  count = var.manage_lambda_log_groups ? 1 : 0

  name = local.calendar_log_group_name
  tags = var.tags
}

# --- Lambda Function ---
resource "aws_lambda_function" "calendar" {
  # Ensure the log group exists before the function so a health-check
  # invocation during apply cannot auto-create it and collide with the
  # managed resource above. No-op when the flag is off (count = 0).
  depends_on = [aws_cloudwatch_log_group.calendar_lambda_logs]

  filename         = data.archive_file.calendar_lambda_zip.output_path
  function_name    = "${local.name_prefix}-school-calendar"
  description      = "School Calendar - Gmail scan, Anthropic event extraction and calendar UI"
  role             = aws_iam_role.calendar_lambda_exec_role.arn
  handler          = "index.handler"
  runtime          = "nodejs24.x"
  timeout          = 60
  memory_size      = 512
  source_code_hash = data.archive_file.calendar_lambda_zip.output_base64sha256

  tags = merge(var.tags, {
    Purpose = "School Calendar"
  })

  vpc_config {
    security_group_ids = [aws_security_group.calendar_sg.id]
    subnet_ids         = data.terraform_remote_state.basestack.outputs.private_subnet_ids
  }

  environment {
    variables = {
      # DynamoDB tables (TASK-002)
      CALENDAR_CONNECTIONS_TABLE = aws_dynamodb_table.calendar_connections.name
      CALENDAR_EVENTS_TABLE      = aws_dynamodb_table.calendar_events.name

      # CMK used to wrap Gmail refresh tokens. The ARN is accepted anywhere KMS
      # takes a key id, and it is the value recorded in each connection row's
      # `refreshTokenKeyId` so a future key migration can find stale rows.
      CALENDAR_KMS_KEY_ID = aws_kms_key.calendar.arn

      # Log group name — used by the alerting/diagnostics tooling to run
      # CloudWatch Insights queries against this Lambda's own logs. The group
      # itself is auto-created by the Lambda runtime (see locals above).
      CALENDAR_LOG_GROUP_NAME = local.calendar_log_group_name

      # none | basic | verbose — verbose logs per-email extraction detail and
      # must never be left on in prod (email subjects are personal data).
      CALENDAR_LOG_LEVEL = var.calendar_log_level

      # Public origin, used to build the Google OAuth redirect_uri.
      PUBLIC_BASE_URL = local.calendar_public_base_url

      # Its own ARN, derived from locals (never from the resource) so the
      # environment block does not depend on the function it belongs to.
      CALENDAR_FUNCTION_ARN = local.calendar_function_arn

      # CORS: empty string = allow all origins (*), comma-separated list =
      # restrict to specific domains.
      ALLOWED_ORIGINS = lookup(local.secrets, "ALLOWED_ORIGINS", "")

      # Google OAuth client used for the Gmail read-only consent flow.
      GOOGLE_CLIENT_ID     = lookup(local.secrets, "GOOGLE_CLIENT_ID", "")
      GOOGLE_CLIENT_SECRET = lookup(local.secrets, "GOOGLE_CLIENT_SECRET", "")

      # HMAC key for the signed session cookie.
      SESSION_SECRET = lookup(local.secrets, "SESSION_SECRET", "")

      # Anthropic API — event extraction from email bodies.
      ANTHROPIC_API_KEY = lookup(local.secrets, "ANTHROPIC_API_KEY", "")
      ANTHROPIC_MODEL   = var.anthropic_model
    }
  }
}

# --- IAM Role ---
resource "aws_iam_role" "calendar_lambda_exec_role" {
  name               = "${local.name_prefix}-school-calendar-exec-role"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume_role_policy.json
  tags               = var.tags
}

# --- IAM Policy ---
# Deliberately scoped: every statement names its resource except the two that
# AWS does not allow to be scoped (CloudWatch Logs stream creation and the VPC
# network-interface actions).
resource "aws_iam_policy" "calendar_lambda_policy" {
  name        = "${local.name_prefix}-school-calendar-policy"
  description = "Policy for school calendar Lambda - CloudWatch Logs + VPC + DynamoDB + KMS + Secrets Manager"

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "CloudWatchLogs"
        Effect = "Allow"
        Action = [
          "logs:CreateLogGroup",
          "logs:CreateLogStream",
          "logs:PutLogEvents"
        ]
        Resource = "arn:aws:logs:*:*:*"
      },
      {
        # Required for any VPC-attached Lambda: the service creates and tears
        # down ENIs in the private subnets on the function's behalf. These
        # actions do not support resource-level restrictions, so Resource
        # must be "*".
        Sid    = "VPCNetworkInterfaces"
        Effect = "Allow"
        Action = [
          "ec2:CreateNetworkInterface",
          "ec2:DescribeNetworkInterfaces",
          "ec2:DeleteNetworkInterface",
          "ec2:AssignPrivateIpAddresses",
          "ec2:UnassignPrivateIpAddresses"
        ]
        Resource = "*"
      },
      {
        # Read/write on the two calendar tables: connections (OAuth state and
        # the wrapped refresh token) and events (extracted calendar entries).
        Sid    = "DynamoDBCalendarTables"
        Effect = "Allow"
        Action = [
          "dynamodb:GetItem",
          "dynamodb:PutItem",
          "dynamodb:UpdateItem",
          "dynamodb:DeleteItem",
          "dynamodb:Query",
          "dynamodb:BatchWriteItem",
          "dynamodb:DescribeTable"
        ]
        # DynamoDB evaluates index queries against the INDEX ARN, not the table
        # ARN, so "<events table arn>/index/*" MUST be listed explicitly.
        # Without it the AttentionIndex ("needs attention" list) and
        # StartsAtIndex (month view) Queries fail at runtime with
        # AccessDeniedException even though GetItem on the table succeeds.
        Resource = [
          aws_dynamodb_table.calendar_connections.arn,
          aws_dynamodb_table.calendar_events.arn,
          "${aws_dynamodb_table.calendar_events.arn}/index/*"
        ]
      },
      {
        # Wrap/unwrap the Gmail refresh token, and let DynamoDB decrypt the
        # tables' server-side encryption. Scoped to this deployment's CMK only
        # (TASK-002) - the Lambda can decrypt nothing else in the account.
        Sid    = "KMSCalendarKey"
        Effect = "Allow"
        Action = [
          "kms:Encrypt",
          "kms:Decrypt",
          "kms:GenerateDataKey",
          "kms:DescribeKey"
        ]
        Resource = aws_kms_key.calendar.arn
      },
      {
        # Read the app-config secret (Google client secret, session secret,
        # Anthropic key) at runtime for rotation without a redeploy. Scoped to
        # this deployment's secret ARN.
        Sid      = "SecretsManagerAppConfig"
        Effect   = "Allow"
        Action   = ["secretsmanager:GetSecretValue"]
        Resource = data.aws_secretsmanager_secret.app_config.arn
      }
    ]
  })
}

resource "aws_iam_role_policy_attachment" "calendar_policy_attach" {
  role       = aws_iam_role.calendar_lambda_exec_role.name
  policy_arn = aws_iam_policy.calendar_lambda_policy.arn
}

# --- Security Group ---
# Egress-only. No ingress rule is needed or wanted: the ALB reaches a Lambda
# target through the Lambda service API, not over the network, so nothing ever
# opens a connection to this ENI.
resource "aws_security_group" "calendar_sg" {
  name        = "${local.name_prefix}-school-calendar-sg"
  description = "Security group for school calendar Lambda"
  vpc_id      = data.terraform_remote_state.basestack.outputs.vpc_id

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = var.tags
}

# --- ALB Target Group ---
# AWS caps target-group names at 32 characters, so this uses
# local.name_prefix_short (e.g. "au-dev-rhq-cal-tg") rather than the full
# name_prefix, which would overflow for every tenant.
resource "aws_lb_target_group" "calendar_lambda_tg" {
  name        = "${local.name_prefix_short}-cal-tg"
  target_type = "lambda"
  vpc_id      = data.terraform_remote_state.basestack.outputs.vpc_id

  health_check {
    enabled             = true
    interval            = 300
    path                = "/calendar/api/health"
    matcher             = "200-299"
    timeout             = 10
    healthy_threshold   = 3
    unhealthy_threshold = 3
  }

  lambda_multi_value_headers_enabled = true

  tags = var.tags
}

# --- ALB Permission ---
resource "aws_lambda_permission" "calendar_allow_alb" {
  statement_id  = "AllowExecutionFromALB"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.calendar.function_name
  principal     = "elasticloadbalancing.amazonaws.com"
  source_arn    = aws_lb_target_group.calendar_lambda_tg.arn
}

# --- ALB Listener Rule ---
# Priority 121: this ALB is shared with the chatbot, which already owns 119.
# Duplicate priorities on the same listener fail at apply time.
resource "aws_lb_listener_rule" "calendar_listener_rule" {
  listener_arn = data.aws_lb_listener.web_app_alb_listener_443.arn
  priority     = 121

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.calendar_lambda_tg.arn
  }

  condition {
    host_header {
      values = ["${var.sub_domain}.${data.terraform_remote_state.basestack.outputs.domain_name}"]
    }
  }

  condition {
    path_pattern {
      values = ["/calendar*"]
    }
  }
}

# --- Target Group Attachment ---
resource "aws_lb_target_group_attachment" "calendar_lambda_attachment" {
  target_group_arn = aws_lb_target_group.calendar_lambda_tg.arn
  target_id        = aws_lambda_function.calendar.arn

  # The permission must exist before the attachment, otherwise the
  # registration call is rejected with "does not have permission".
  depends_on = [aws_lambda_permission.calendar_allow_alb]
}
