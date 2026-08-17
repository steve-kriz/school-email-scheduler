# =============================================================================
# KMS: School Calendar customer-managed key (CMK)
# =============================================================================
# Protects the Gmail OAuth refresh tokens at rest. The scanner Lambda calls
# kms:Encrypt once when a user connects their Google account and kms:Decrypt on
# every scheduled scan; the resulting ciphertext is stored base64-encoded in the
# connections table's `refreshTokenEnc` attribute. The plaintext refresh token is
# never persisted anywhere.
#
# The same key is also set as the DynamoDB server-side-encryption key for both
# the connections and the events tables, so a stolen table export or PITR
# snapshot is useless without kms:Decrypt on this key.
#
# Key policy: the account root gets full control and NOTHING ELSE is granted
# here. Deliberately no principal-specific statements - the Lambda execution
# role receives kms:Encrypt / kms:Decrypt from its own IAM policy (TASK-003),
# scoped to this key ARN. Keeping all grants on the identity side means one
# place to audit "who can read the tokens".
#
# Rotation is enabled (AWS rotates the backing key material annually and retains
# old material so existing ciphertext still decrypts). `refreshTokenKeyId` on
# each connection row records which CMK ARN encrypted that token so a future key
# migration can find rows that still need re-wrapping.
# =============================================================================

data "aws_iam_policy_document" "calendar_kms_key" {
  # Account root full control. Without this statement the key would be
  # unmanageable (KMS requires the policy to allow at least one principal to
  # administer it), and IAM policies in this account cannot grant access to the
  # key unless the key policy delegates to the account root.
  statement {
    sid    = "EnableIAMUserPermissions"
    effect = "Allow"

    principals {
      type        = "AWS"
      identifiers = ["arn:${data.aws_partition.current.partition}:iam::${data.aws_caller_identity.current.account_id}:root"]
    }

    actions   = ["kms:*"]
    resources = ["*"]
  }
}

resource "aws_kms_key" "calendar" {
  description             = "${local.name_prefix} school calendar - Gmail refresh token and DynamoDB encryption"
  enable_key_rotation     = true
  deletion_window_in_days = 30
  policy                  = data.aws_iam_policy_document.calendar_kms_key.json

  tags = merge(var.tags, {
    Purpose = "School Calendar refresh token and table encryption"
  })
}

resource "aws_kms_alias" "calendar" {
  name          = "alias/${local.name_prefix}-school-calendar"
  target_key_id = aws_kms_key.calendar.key_id
}

# --- Outputs consumed by later tickets (Lambda IAM policy, app env vars) ---
output "calendar_kms_key_arn" {
  description = "ARN of the school calendar CMK - scope the Lambda role's kms:Encrypt/kms:Decrypt to this exact ARN"
  value       = aws_kms_key.calendar.arn
}

output "calendar_kms_key_id" {
  description = "Key ID of the school calendar CMK"
  value       = aws_kms_key.calendar.key_id
}

output "calendar_kms_alias" {
  description = "Alias of the school calendar CMK"
  value       = aws_kms_alias.calendar.name
}
