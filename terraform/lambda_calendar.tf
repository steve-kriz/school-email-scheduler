# =============================================================================
# School Calendar Lambda - Gmail scanner + calendar UI behind the shared ALB
# =============================================================================
# This Lambda serves dual purpose:
#   1. Frontend: serves the calendar SPA (month view, needs-attention list)
#   2. Backend: Google OAuth callback, Gmail scan, Anthropic extraction and the
#      events API, all under the /calendar* path prefix
# =============================================================================


# --- Lambda Dependency Install (TASK-038) ---
# `data.archive_file` below zips ../src/lambda/calendar AS-IS. node_modules is
# gitignored and never committed, so without this the zip ships
# `package.json` but none of its dependencies — the Lambda still boots
# (TASK-007's Anthropic client is imported lazily for exactly this reason),
# but every extraction then fails at first use with no error surfaced to the
# user. See TASK-038.
#
# `npm ci --omit=dev --ignore-scripts` (not `npm install`): exact,
# reproducible install pinned to the committed package-lock.json, production
# dependencies only, with dependency lifecycle scripts (preinstall/
# postinstall/etc.) disabled — this runs on whatever host holds deploy
# credentials, so a compromised/malicious transitive dependency should not get
# to run arbitrary code there.
#
# The verify step is the loud-failure guard the ticket asked for: if a
# declared dependency did not land in node_modules (network failure, npm
# install error, or a manifest change without a regenerated lockfile), OR if
# source imports an @aws-sdk/* package that is neither declared here nor
# guaranteed bundled by the runtime (see the decision below), this fails
# `terraform apply` before the archive is built, rather than shipping a zip
# that boots and silently degrades.
#
# `working_dir` + `abspath(...)` (TASK-038 rework, review cycle 1): the
# previous version of this command did `cd "${path.module}/../src/lambda/
# calendar" && ... "${path.module}/../scripts/verify-...mjs" "${path.module}/
# ../src/lambda/calendar"`. `path.module` is `.` in this (root) module, so
# after the `cd` the shell's cwd changed but the REMAINING `${path.module}/../`
# expressions were already-substituted plain relative strings that then
# resolved against the NEW cwd — the script path resolved to
# `src/lambda/scripts/verify-lambda-package-deps.mjs` (does not exist) and the
# directory argument resolved to `src/lambda/src/lambda/calendar` (does not
# exist). `npm ci` succeeded and `node` then died with `Cannot find module` on
# every single apply — `terraform validate` cannot catch a bad path inside a
# command string, and nothing else did either. Using the provisioner's own
# `working_dir` (so there is no `cd` for later path fragments to be evaluated
# against) and `abspath(...)` (so every path is fully resolved BEFORE the
# shell ever changes directory) removes the whole class of bug.
#
# `triggers.always_run` (TASK-038 rework, review cycle 1): this resource's
# state lives in the shared S3 backend, so `package_lock_hash` /
# `package_json_hash` alone are compared against whatever the LAST host to
# apply recorded — not against whether THIS host's `node_modules` actually
# exists. Host A applies once, records the hashes; host B (or a fresh CI
# runner checking out the same commit) sees matching hashes and Terraform
# skips this resource's provisioner entirely, on ANY apply after the first,
# so the install AND the verify guard both silently never run there.
# `archive_file` would then zip a directory with no `node_modules` at all,
# with no failure anywhere in the chain — the exact quiet-degradation bug this
# ticket exists to prevent, just moved one level up. Hashing `timestamp()`
# forces this resource to be considered changed, and its provisioner to run,
# on every single apply, on every host, unconditionally.
resource "null_resource" "calendar_lambda_npm_install" {
  triggers = {
    always_run = timestamp()
    # `can(...)` catches filesha256's own fatal "no file exists" error rather
    # than letting it abort the plan with a generic function-argument error
    # naming a path, not the fix. The precondition below then reports the
    # SAME underlying problem with a clear, actionable message instead
    # (TASK-038 rework, review cycle 1: package-lock.json is committed-pending
    # as of this ticket, so a fresh checkout without it must fail loudly here,
    # not with a cryptic "Invalid function argument").
    package_lock_hash = can(filesha256("${path.module}/../src/lambda/calendar/package-lock.json")) ? filesha256("${path.module}/../src/lambda/calendar/package-lock.json") : "MISSING"
    package_json_hash = filesha256("${path.module}/../src/lambda/calendar/package.json")
  }

  provisioner "local-exec" {
    working_dir = "${path.module}/../src/lambda/calendar"
    command     = "npm ci --omit=dev --ignore-scripts && node \"${abspath("${path.module}/../scripts/verify-lambda-package-deps.mjs")}\" \"${abspath("${path.module}/../src/lambda/calendar")}\""
  }

  lifecycle {
    precondition {
      condition     = fileexists("${path.module}/../src/lambda/calendar/package-lock.json")
      error_message = "src/lambda/calendar/package-lock.json is missing from this checkout. 'npm ci' requires a committed lockfile - generate it with 'npm install' in src/lambda/calendar and commit the result before applying (TASK-038)."
    }
  }
}

# --- Lambda Package ---
# AWS SDK v3 is provided by the nodejs24.x runtime — but only PARTIALLY:
# nodejs24.x bundles ONLY @aws-sdk/client-dynamodb, @aws-sdk/lib-dynamodb and
# @aws-sdk/client-s3, not the whole @aws-sdk/* namespace. TASK-038 decision
# (revised in review cycle 1, correcting the
# first pass of this same ticket): @aws-sdk/client-dynamodb and
# @aws-sdk/lib-dynamodb are REMOVED from src/lambda/calendar/package.json,
# relying on the runtime's bundled copy. @aws-sdk/client-kms
# (backend/crypto.mjs — wraps/unwraps every Gmail refresh token, used on
# every OAuth connect and every scan) and @aws-sdk/client-scheduler
# (backend/scan-schedule.mjs — TASK-008 recurring scan schedules) are NOT part
# of the runtime's bundled set, were declared nowhere, and are KEPT/added as
# explicit dependencies here — the first pass of this ticket removed all
# three @aws-sdk/* packages uniformly and would have broken every OAuth
# connect and every scan on the first deploy. `scripts/verify-lambda-package-
# deps.mjs` additionally scans source for @aws-sdk/* imports and fails if one
# is neither declared here nor in its own runtime-bundled allowlist, so this
# class of gap (an import with no matching declaration) fails loudly instead
# of shipping silently again.
data "archive_file" "calendar_lambda_zip" {
  depends_on  = [null_resource.calendar_lambda_npm_install]
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

  # `timeout` is 900s (15 minutes, the Lambda ceiling) rather than the original
  # 60s (TASK-008): a full scan makes one sequential Anthropic call per email
  # (TASK-007) and cannot bound that worst case mathematically (a single retry
  # sequence can itself wait tens of seconds). scan.mjs's extraction loop is
  # additionally deadline-aware via getRemainingTimeInMillis, so a scan that is
  # about to run out of THIS budget stops early - loudly and resumably -
  # rather than being killed by the platform with nothing recorded; raising
  # the ceiling here is what gives that loop enough runway to be useful.
  filename         = data.archive_file.calendar_lambda_zip.output_path
  function_name    = "${local.name_prefix}-school-calendar"
  description      = "School Calendar - Gmail scan, Anthropic event extraction and calendar UI"
  role             = aws_iam_role.calendar_lambda_exec_role.arn
  handler          = "index.handler"
  runtime          = "nodejs24.x"
  timeout          = 900
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

      # EventBridge Scheduler — one recurring scan schedule per user
      # (TASK-008). SCAN_SCHEDULER_ROLE_ARN and CALENDAR_FUNCTION_ARN are both
      # required for scan-schedule.mjs's isScheduleEnabled() to report the
      # feature available; either being empty degrades to "scheduling is not
      # configured" rather than a failure (see scheduler_calendar.tf).
      SCAN_SCHEDULE_PREFIX    = "${local.name_prefix}-calendar-scan"
      SCAN_SCHEDULE_GROUP     = "default"
      SCAN_SCHEDULER_ROLE_ARN = aws_iam_role.calendar_scheduler_role.arn
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
