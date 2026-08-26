# =============================================================================
# CloudWatch alerting for the school calendar Lambda (TASK-011)
# =============================================================================
# Mirrors ohq-chatbot2/terraform/alerting.tf: log metric filters over the
# Lambda's log group, plus CloudWatch alarms that notify the shared SNS topic
# (var.Alert_SNS_ARN). Naming, tagging and the "the SNS topic MUST be in this
# alarm's own region" rule all follow that file.
#
# TWO DELIBERATE DIFFERENCES FROM THE CHATBOT, both explained where they occur:
#
#   1. EVERY ALARM IS GUARDED BY count = var.Alert_SNS_ARN == "" ? 0 : 1
#      rather than the chatbot's "empty actions list" trick. dev/au sets
#      Alert_SNS_ARN = "" (see config/dev/au.tfvars), and that is the first
#      environment the calendar deploys to: an alarm with no action there is
#      pure cost and noise, so it is not created at all. The metric FILTERS are
#      NOT guarded - they are free, and letting the metrics accumulate in dev
#      means the alarms have history the moment a topic is configured.
#
#   2. ALARM PERIODS ARE SINGLE-DATAPOINT, not the chatbot's 3-of-3. This
#      Lambda is invoked sparsely (one scheduled scan per connected user per
#      day, plus interactive settings/scan requests - see
#      scheduler_calendar.tf), so a rule requiring three CONSECUTIVE breaching
#      5-minute periods would essentially never fire: errors arrive in a single
#      period and then the function is idle again.
#
# LOG-GROUP ORDERING (the same problem the chatbot documents):
# A metric filter requires its log group to already exist. The calendar log
# group is normally auto-created by the Lambda runtime on first invocation and
# is NOT Terraform-managed (see lambda_calendar.tf), so on a FRESH environment
# where the function has never run it does not exist yet and these filters fail
# with ResourceNotFoundException. A fresh environment must therefore apply with
# var.manage_lambda_log_groups = true, which makes
# aws_cloudwatch_log_group.calendar_lambda_logs create the group first; the
# depends_on on each filter below then orders the filter after it. When
# var.manage_lambda_log_groups is false the depends_on is a no-op (count = 0)
# and the pre-existing auto-created group is used as-is.
#
# PRIVACY: nothing in this file is a log destination. The metric filters emit
# COUNTS only (value = "1"), never matched log content, and no alarm carries a
# request body, a cookie or an Authorization header anywhere. Message bodies,
# subjects and tokens are kept out of the Lambda's logs by the backend modules
# themselves; nothing here can reintroduce them.
# =============================================================================

locals {
  # One namespace for every custom calendar metric, matching the chatbot's
  # "Lambda/Chatbot" convention.
  calendar_metric_namespace = "Lambda/SchoolCalendar"

  # Structured log tokens the Lambda emits for operational events, and the
  # single source of truth for the filter patterns below. The emitters live in
  # src/lambda/calendar/backend/alarms.mjs - the constants there and these
  # strings are ONE CONTRACT. Changing one without the other does not fail
  # anything loudly; the filter just silently stops matching.
  calendar_extraction_failed_token = "CALENDAR_EXTRACTION_FAILED"
  calendar_reauth_required_token   = "CALENDAR_REAUTH_REQUIRED"

  # Alarms are created only when there is somewhere to send the notification.
  # Written once here and reused by every alarm below.
  calendar_alarms_enabled = var.Alert_SNS_ARN == "" ? 0 : 1
}

# -----------------------------------------------------------------------------
# Lambda runtime alarms (AWS/Lambda metrics - no filter needed)
# -----------------------------------------------------------------------------

# --- Errors ---
# Threshold 0 over a single 5-minute datapoint: ANY invocation error is worth
# notifying on here. A failed SCHEDULED scan is completely silent to the user -
# nobody is watching a browser when it runs - so CloudWatch is the only place
# it ever surfaces.
resource "aws_cloudwatch_metric_alarm" "calendar_lambda_errors" {
  count = local.calendar_alarms_enabled

  alarm_name          = "${local.name_prefix}-school-calendar-lambda-errors"
  namespace           = "AWS/Lambda"
  metric_name         = "Errors"
  comparison_operator = "GreaterThanThreshold"
  threshold           = 0
  period              = 300
  evaluation_periods  = 1
  datapoints_to_alarm = 1
  statistic           = "Sum"
  treat_missing_data  = "notBreaching"

  dimensions = {
    FunctionName = aws_lambda_function.calendar.function_name
  }

  alarm_description = "School calendar Lambda reported one or more invocation errors in a 5-minute period"

  # The SNS topic MUST be in this alarm's region (var.region).
  alarm_actions = [var.Alert_SNS_ARN]
  ok_actions    = [var.Alert_SNS_ARN]

  tags = var.tags
}

# --- Throttles ---
# Concurrency exhaustion. A throttled scheduled scan is never run at all, and a
# throttled interactive request is a 502 at the ALB, so any throttle is a real
# fault - never a normal operating condition for this workload.
resource "aws_cloudwatch_metric_alarm" "calendar_lambda_throttles" {
  count = local.calendar_alarms_enabled

  alarm_name          = "${local.name_prefix}-school-calendar-lambda-throttles"
  namespace           = "AWS/Lambda"
  metric_name         = "Throttles"
  comparison_operator = "GreaterThanThreshold"
  threshold           = 0
  period              = 300
  evaluation_periods  = 1
  datapoints_to_alarm = 1
  statistic           = "Sum"
  treat_missing_data  = "notBreaching"

  dimensions = {
    FunctionName = aws_lambda_function.calendar.function_name
  }

  alarm_description = "School calendar Lambda was throttled - a scheduled scan may have been dropped entirely"

  alarm_actions = [var.Alert_SNS_ARN]
  ok_actions    = [var.Alert_SNS_ARN]

  tags = var.tags
}

# -----------------------------------------------------------------------------
# Extraction failures (log metric filter + alarm)
# -----------------------------------------------------------------------------
# A per-message extraction failure is TOLERATED BY DESIGN: scan.mjs catches it,
# records it in the run's errors list and reports the run as "partial" rather
# than failing the whole batch. That is the right behaviour for one unreadable
# email - but it also means a SYSTEMIC problem (Anthropic 5xx/429, the model
# refusing every message, an expired API key) produces no AWS/Lambda Errors
# datapoint at all and would otherwise be invisible. Hence a dedicated token
# and a spike alarm.
resource "aws_cloudwatch_log_metric_filter" "calendar_extraction_failed" {
  # Ordered after the managed log group when we own it (fresh environments).
  # No-op when var.manage_lambda_log_groups is false.
  depends_on = [aws_cloudwatch_log_group.calendar_lambda_logs]

  name           = "${local.name_prefix}-school-calendar-ExtractionFailed"
  log_group_name = local.calendar_log_group_name

  # Quoted term filter: matches the token anywhere in the log event, which is
  # how this runtime's text-format logs have to be matched (the chatbot filters
  # on "ERROR" exactly the same way).
  pattern = "\"${local.calendar_extraction_failed_token}\""

  metric_transformation {
    name          = "CalendarExtractionFailedCount"
    namespace     = local.calendar_metric_namespace
    value         = "1"
    default_value = "0"
  }
}

resource "aws_cloudwatch_metric_alarm" "calendar_extraction_failures" {
  count = local.calendar_alarms_enabled

  alarm_name          = "${local.name_prefix}-school-calendar-extraction-failures"
  namespace           = aws_cloudwatch_log_metric_filter.calendar_extraction_failed.metric_transformation[0].namespace
  metric_name         = aws_cloudwatch_log_metric_filter.calendar_extraction_failed.metric_transformation[0].name
  comparison_operator = "GreaterThanThreshold"
  # Above the handful of genuinely unparseable emails a large scan may hit, and
  # far below "every message in the batch failed".
  threshold           = 5
  period              = 300
  evaluation_periods  = 1
  datapoints_to_alarm = 1
  statistic           = "Sum"
  treat_missing_data  = "notBreaching"

  alarm_description = "More than 5 ${local.calendar_extraction_failed_token} events in 5 minutes - model refusals or Anthropic API failures, not one bad email"

  alarm_actions = [var.Alert_SNS_ARN]
  ok_actions    = [var.Alert_SNS_ARN]

  tags = var.tags
}

# -----------------------------------------------------------------------------
# Re-authorisation required (log metric filter + alarm)
# -----------------------------------------------------------------------------
# One user's grant expiring is routine and self-service. MANY users needing to
# reconnect at once is not: it means the grant was invalidated fleet-wide by an
# OAuth consent-screen change, a client-secret rotation, or the app being moved
# in or out of testing mode. Every affected user's scans then stop silently.
#
# Measured over an HOUR rather than 5 minutes: scheduled scans are spread
# across the day, so a 5-minute window would never accumulate enough of them to
# distinguish "one user" from "everyone".
#
# The token is emitted at the one point a grant is OBSERVED to be revoked
# (google-token.mjs, the invalid_grant branch), and NOT when a user simply has
# no stored grant yet - a first-time visitor is not a revocation. It counts
# EVENTS, not distinct users, because a log metric filter cannot count distinct
# anything; the threshold below is therefore set above the handful of events one
# user retrying a scan can produce on their own.
resource "aws_cloudwatch_log_metric_filter" "calendar_reauth_required" {
  depends_on = [aws_cloudwatch_log_group.calendar_lambda_logs]

  name           = "${local.name_prefix}-school-calendar-ReauthRequired"
  log_group_name = local.calendar_log_group_name

  pattern = "\"${local.calendar_reauth_required_token}\""

  metric_transformation {
    name          = "CalendarReauthRequiredCount"
    namespace     = local.calendar_metric_namespace
    value         = "1"
    default_value = "0"
  }
}

resource "aws_cloudwatch_metric_alarm" "calendar_reauth_required" {
  count = local.calendar_alarms_enabled

  alarm_name          = "${local.name_prefix}-school-calendar-reauth-required"
  namespace           = aws_cloudwatch_log_metric_filter.calendar_reauth_required.metric_transformation[0].namespace
  metric_name         = aws_cloudwatch_log_metric_filter.calendar_reauth_required.metric_transformation[0].name
  comparison_operator = "GreaterThanThreshold"
  threshold           = 10
  period              = 3600
  evaluation_periods  = 1
  datapoints_to_alarm = 1
  statistic           = "Sum"
  treat_missing_data  = "notBreaching"

  alarm_description = "More than 10 ${local.calendar_reauth_required_token} events in an hour - the Gmail grant looks revoked broadly, not for one retrying user"

  alarm_actions = [var.Alert_SNS_ARN]
  ok_actions    = [var.Alert_SNS_ARN]

  tags = var.tags
}

# -----------------------------------------------------------------------------
# ALB target-group health
# -----------------------------------------------------------------------------
# The calendar target group is a Lambda target health-checked against
# /calendar/api/health every 300s (see lambda_calendar.tf). An unhealthy target
# means the ALB has stopped forwarding: the app is down from a browser's point
# of view even though the Lambda itself may publish no Errors datapoint at all
# (a bad handler path, a packaging failure, or an env var the health route
# rejects all look like this).
#
# Both ALB dimensions are required, and both must be the metric-friendly
# arn_suffix - not the ARN.
resource "aws_cloudwatch_metric_alarm" "calendar_target_group_unhealthy_hosts" {
  count = local.calendar_alarms_enabled

  alarm_name          = "${local.name_prefix}-school-calendar-tg-unhealthy-hosts"
  namespace           = "AWS/ApplicationELB"
  metric_name         = "UnHealthyHostCount"
  comparison_operator = "GreaterThanThreshold"
  threshold           = 0
  # Two consecutive periods: the health-check interval is 300s, so one
  # breaching period is a single failed probe. Two in a row is an outage.
  period              = 300
  evaluation_periods  = 2
  datapoints_to_alarm = 2
  statistic           = "Maximum"
  # A Lambda target group publishes this metric only while the ALB is actively
  # health-checking it, so gaps are normal and must not alarm.
  treat_missing_data = "notBreaching"

  dimensions = {
    TargetGroup  = aws_lb_target_group.calendar_lambda_tg.arn_suffix
    LoadBalancer = data.aws_lb.web_app_alb.arn_suffix
  }

  alarm_description = "The school calendar ALB target group has an unhealthy target - /calendar/api/health is failing and the app is unreachable"

  alarm_actions = [var.Alert_SNS_ARN]
  ok_actions    = [var.Alert_SNS_ARN]

  tags = var.tags
}
