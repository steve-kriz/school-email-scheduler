# =============================================================================
# DynamoDB: School Calendar Google account connections
# =============================================================================
# One row per connected Google account. Holds the encrypted Gmail refresh token
# (the app's only copy of the OAuth grant), the school/domain matching config,
# the scan watermark, and the user's scan schedule preferences.
#
# The table is schemaless beyond the `userId` hash key, so the attribute list
# below is documentation rather than a declaration: adding, renaming or retyping
# an attribute (as TASK-053 did for schoolName -> schoolNames, and TASK-055 did
# for schoolNames/searchDomains -> processingJobs) is an application change and
# needs no change to this resource.
#
# Every access path is a GetItem or PutItem by `userId`, so there is deliberately
# no GSI and no range key - adding one would only add write cost.
#
# Schema (all fields are strings unless noted):
#   userId (PK)         : "google#<google sub claim>"
#   email               : the connected Google account address
#   processingJobs (L of M) : the user's named "search + extract" configurations
#                         (up to 20, TASK-055). Stored as a LIST OF MAPS - the
#                         first nested attribute on this table; every other one is
#                         a scalar or a string set. List order is the user's own
#                         and is preserved (a List is ordered, unlike an SS).
#                         Each map has exactly these five keys:
#                           id (S)          : server-generated UUID, stable across
#                                             a rename. Extracted events are
#                                             attributed to it (TASK-056), so it is
#                                             never re-minted once assigned; a PUT
#                                             is a whole-list replace and keeps an
#                                             id only when the client echoes it.
#                           name (S)        : display name, unique per user
#                                             (case-insensitively), <= 120 code
#                                             points, stored exactly as typed.
#                           schoolName (S)  : one school name, <= 120 code points.
#                           domain (S)      : one sender domain, normalised and
#                                             lower-cased, e.g. "stmarys.edu.au".
#                           searchTerms (L of S) : 0-20 free-text terms, each <= 80
#                                             code points. An EMPTY list is stored
#                                             as an empty L - legal, unlike an
#                                             empty SS.
#                         All text is stored RAW/unescaped; escaping happens on
#                         render and in the prompt builder.
#   schoolNames (SS)    : LEGACY (pre-TASK-055), free-text school names, up to 10.
#   searchDomains (SS)  : LEGACY (pre-TASK-055), sender domains, e.g.
#                         ["stmarys.nsw.edu.au", "schoolbytes.education"]
#   schoolName (S)      : LEGACY (pre-TASK-053), a single school name; superseded
#                         first by schoolNames and now by processingJobs.
#                         All three legacy attributes are READ-MIGRATED, not
#                         batch-migrated: a row that still carries them projects
#                         through connections.mjs's toPublicJson as ONE synthesised
#                         "Default" processing job (first sorted school name and
#                         domain, every remaining entry folded in as a search
#                         term), and the owner's next settings save SETs
#                         processingJobs and REMOVEs all three in the same
#                         UpdateItem. No row carries both shapes; rows convert one
#                         at a time as they are saved.
#   refreshTokenEnc     : base64 KMS ciphertext of the Gmail refresh token. The
#                         PLAINTEXT TOKEN IS NEVER WRITTEN TO THIS TABLE - there
#                         is intentionally no `refreshToken` attribute anywhere
#                         in this schema. Encrypt/decrypt with the CMK in
#                         kms_calendar.tf.
#   refreshTokenKeyId   : the CMK ARN used to wrap refreshTokenEnc, so a key
#                         rotation or key change can be detected per row and the
#                         token re-wrapped rather than silently failing to
#                         decrypt.
#   lastHistoryId       : Gmail history ID watermark from the last successful
#                         scan; lets the next scan fetch only new messages.
#   lastScanAt          : ISO-8601 timestamp the incremental watermark is
#                         pinned to (see scan.mjs) - NOT necessarily "when the
#                         last scan ran": a truncated or time-stopped scan pins
#                         this at the query floor it used rather than advancing
#                         it, so a later scan still re-covers whatever this one
#                         dropped.
#   lastScanStatus      : "ok" | "partial" | "reauth_required" | "error"
#   lastScanError       : last error message (short, never a token/body/subject)
#   lastScanMessagesScanned, lastScanEventsCreated, lastScanEventsUpdated,
#   lastScanSkipped, lastScanTruncated (BOOL) : counts/flags from the last scan
#                         (scan.mjs), surfaced by GET /calendar/api/scan/status.
#   scanInProgress (BOOL), scanStartedAt : the per-user scan lock (scan.mjs /
#                         connections.mjs's acquireScanLock+releaseScanLock).
#                         A lock older than SCAN_LOCK_STALE_MS is treated as
#                         abandoned rather than active.
#   scheduleEnabled (BOOL) : master switch for the automated scan
#   scheduleFrequency   : "daily" | "weekly"
#   scheduleHour        : hour-of-day (0-23) in `timezone` to run the scan
#   scheduleDayOfWeek   : 0 (Sunday) - 6 (Saturday); set only when
#                         scheduleFrequency is "weekly"
#   timezone            : IANA zone, e.g. "Australia/Sydney"
#   createdAt           : ISO-8601, when the account was first connected
#   updatedAt           : ISO-8601, last mutation
#
# point_in_time_recovery is ON (unlike the chatbot tables): this table holds the
# only copy of each user's OAuth grant, and an accidental delete would force
# every user to re-consent. server_side_encryption uses the project CMK so the
# stored ciphertext is protected by two independent keys.
# =============================================================================

resource "aws_dynamodb_table" "calendar_connections" {
  name         = "${local.name_prefix}-calendar-connections"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "userId"

  attribute {
    name = "userId"
    type = "S"
  }

  point_in_time_recovery {
    enabled = true
  }

  server_side_encryption {
    enabled     = true
    kms_key_arn = aws_kms_key.calendar.arn
  }

  tags = merge(var.tags, {
    Purpose = "School Calendar Google account connections"
  })
}

output "calendar_connections_table_name" {
  description = "Name of the school calendar connections table"
  value       = aws_dynamodb_table.calendar_connections.name
}

output "calendar_connections_table_arn" {
  description = "ARN of the school calendar connections table"
  value       = aws_dynamodb_table.calendar_connections.arn
}
