# =============================================================================
# EventBridge Scheduler — one recurring Gmail scan schedule per user (TASK-008)
# =============================================================================
# Unlike the chatbot's single, deployment-wide summary schedule
# (ohq-chatbot2/terraform/lambda_chatbot.tf), the calendar Lambda manages ONE
# SCHEDULE PER CONNECTED USER, created/updated/deleted on demand by
# src/lambda/calendar/backend/scan-schedule.mjs from the settings page. Each
# schedule's Name is a hash of the user's userId (never the raw value - see
# scan-schedule.mjs's scheduleNameFor), so nothing here or in CloudTrail ever
# names a user directly.
#
# Two IAM principals are involved, exactly as in the chatbot's own scheduler
# setup:
#   - aws_iam_role.calendar_scheduler_role: assumed BY EventBridge Scheduler,
#     to invoke this Lambda when a schedule fires. Scoped to invoke only this
#     function.
#   - aws_iam_role_policy.calendar_scheduler_manage: attached to the Lambda's
#     OWN execution role, so the Lambda itself can call scheduler:CreateSchedule
#     etc. when a user saves a schedule from the settings page. Scoped to this
#     deployment's schedule name PREFIX (not account-wide), and its PassRole
#     statement is conditioned so this Lambda can hand out
#     calendar_scheduler_role and nothing else, to no service but Scheduler.
# =============================================================================

# --- EventBridge Scheduler invoke-role ---
# EventBridge Scheduler assumes this role to invoke the calendar Lambda when a
# user's scan schedule fires. It is the RoleArn scan-schedule.mjs sets on every
# schedule's target; the Lambda passes it via iam:PassRole (see
# calendar_scheduler_manage below).
resource "aws_iam_role" "calendar_scheduler_role" {
  name = "${local.name_prefix}-calendar-sched-role"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect    = "Allow"
        Principal = { Service = "scheduler.amazonaws.com" }
        Action    = "sts:AssumeRole"
      }
    ]
  })
  tags = var.tags
}

resource "aws_iam_role_policy" "calendar_scheduler_invoke" {
  name = "invoke-calendar-lambda"
  role = aws_iam_role.calendar_scheduler_role.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = ["lambda:InvokeFunction"]
        Resource = [
          aws_lambda_function.calendar.arn,
          "${aws_lambda_function.calendar.arn}:*"
        ]
      }
    ]
  })
}

# --- Extend the calendar Lambda's OWN execution role (TASK-003) ---
# A separate policy + attachment, rather than editing
# aws_iam_policy.calendar_lambda_policy in lambda_calendar.tf directly, so this
# ticket's scheduler permissions live in one place together with the resources
# they govern.
resource "aws_iam_policy" "calendar_scheduler_manage" {
  name        = "${local.name_prefix}-school-calendar-scheduler-policy"
  description = "Lets the school calendar Lambda manage its users' EventBridge scan schedules"

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        # Manage only THIS deployment's per-user scan schedules - the
        # "default" group, names starting with SCAN_SCHEDULE_PREFIX - not
        # account-wide schedule management. The account id comes from
        # data.aws_caller_identity.current since TASK-051 removed
        # var.account_id; same value, same source as local.calendar_function_arn.
        Sid    = "ManageScanSchedules"
        Effect = "Allow"
        Action = [
          "scheduler:GetSchedule",
          "scheduler:CreateSchedule",
          "scheduler:UpdateSchedule",
          "scheduler:DeleteSchedule",
          "scheduler:ListSchedules"
        ]
        Resource = "arn:aws:scheduler:${var.region}:${data.aws_caller_identity.current.account_id}:schedule/default/${local.name_prefix}-calendar-scan-*"
      },
      {
        # CreateSchedule/UpdateSchedule attach calendar_scheduler_role to the
        # schedule's target, which requires iam:PassRole on that role. The
        # condition restricts the pass to EventBridge Scheduler so the Lambda
        # cannot hand this role to any other service.
        Sid      = "PassCalendarSchedulerRole"
        Effect   = "Allow"
        Action   = ["iam:PassRole"]
        Resource = aws_iam_role.calendar_scheduler_role.arn
        Condition = {
          StringEquals = {
            "iam:PassedToService" = "scheduler.amazonaws.com"
          }
        }
      }
    ]
  })
}

resource "aws_iam_role_policy_attachment" "calendar_scheduler_manage_attach" {
  role       = aws_iam_role.calendar_lambda_exec_role.name
  policy_arn = aws_iam_policy.calendar_scheduler_manage.arn
}
