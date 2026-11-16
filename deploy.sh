#!/usr/bin/env bash
# Deploy the school-calendar Lambda code (no infrastructure changes).
#
# Mirrors what terraform/lambda_calendar.tf does for the code package:
#   npm ci --omit=dev --ignore-scripts -> verify deps -> zip -> update-function-code
# For IAM / env var / schedule changes use `terraform apply` instead.
#
# Usage:
#   ./deploy.sh              run unit tests, then deploy
#   ./deploy.sh --skip-tests deploy without running tests
#   ./deploy.sh --dry-run    build the zip only, do not touch AWS
#
# Overrides: FUNCTION_NAME, AWS_REGION, AWS_PROFILE

set -euo pipefail

FUNCTION_NAME="${FUNCTION_NAME:-au-prod-receptionhq-school-calendar}"
AWS_REGION="${AWS_REGION:-ap-southeast-2}"

SKIP_TESTS=false
DRY_RUN=false
for arg in "$@"; do
  case "$arg" in
    --skip-tests) SKIP_TESTS=true ;;
    --dry-run) DRY_RUN=true ;;
    -h|--help) sed -n '2,13p' "$0"; exit 0 ;;
    *) echo "Unknown option: $arg" >&2; exit 2 ;;
  esac
done

# Don't let Git Bash rewrite /aws/... style arguments into Windows paths.
export MSYS_NO_PATHCONV=1
export AWS_REGION AWS_DEFAULT_REGION="$AWS_REGION"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$ROOT/src/lambda/calendar"
OUT_DIR="$ROOT/terraform/packages"
ZIP="$OUT_DIR/lambda_function_calendar.zip"

log() { echo "==> $*"; }
# Native Windows programs (node, 7z, python) need Windows-style paths under Git Bash.
winpath() { cygpath -w "$1" 2>/dev/null || echo "$1"; }

if [ "$SKIP_TESTS" = false ]; then
  log "Running unit tests"
  (cd "$ROOT" && node --test "tests/unit/**/*.test.js")
fi

log "Installing production dependencies"
(cd "$SRC" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund)

log "Verifying dependencies"
node "$(winpath "$ROOT/scripts/verify-lambda-package-deps.mjs")" "$(winpath "$SRC")"

log "Building $ZIP"
mkdir -p "$OUT_DIR"
rm -f "$ZIP"
EXCLUDES=("CLAUDE.md" ".deployment" "package-lock.json" "__test_shims__")

if command -v zip >/dev/null 2>&1; then
  (cd "$SRC" && zip -qr "$ZIP" . -x "CLAUDE.md" ".deployment" "package-lock.json" "__test_shims__/*")
else
  # No `zip` (stock Git Bash on Windows): stage the files, then use 7-Zip or Python.
  STAGE="$(mktemp -d)"
  trap 'rm -rf "$STAGE"' EXIT
  cp -r "$SRC/." "$STAGE/"
  for e in "${EXCLUDES[@]}"; do rm -rf "${STAGE:?}/$e"; done
  if command -v 7z >/dev/null 2>&1; then
    (cd "$STAGE" && 7z a -tzip -bso0 -bsp0 "$(winpath "$ZIP")" . )
  elif command -v python >/dev/null 2>&1 || command -v python3 >/dev/null 2>&1; then
    PY="$(command -v python3 || command -v python)"
    "$PY" - "$(winpath "$STAGE")" "$(winpath "$ZIP")" <<'PYEOF'
import os, sys, zipfile
stage, out = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
    for d, _, files in os.walk(stage):
        for f in files:
            p = os.path.join(d, f)
            z.write(p, os.path.relpath(p, stage).replace(os.sep, "/"))
PYEOF
  else
    echo "No zip, 7z or python found to build the package." >&2
    exit 1
  fi
fi

echo "    $(du -h "$ZIP" | cut -f1) package"

if [ "$DRY_RUN" = true ]; then
  log "Dry run: skipping AWS upload"
  exit 0
fi

log "Uploading to $FUNCTION_NAME ($AWS_REGION)"
aws lambda update-function-code \
  --function-name "$FUNCTION_NAME" \
  --zip-file "fileb://$ZIP" \
  --query '{Function:FunctionName,Modified:LastModified,Size:CodeSize}' \
  --output table

log "Waiting for the update to finish"
aws lambda wait function-updated --function-name "$FUNCTION_NAME"

log "Deployed. Last modified: $(aws lambda get-function-configuration \
  --function-name "$FUNCTION_NAME" --query LastModified --output text)"
