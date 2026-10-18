#!/usr/bin/env bash
set -Eeuo pipefail

#
# Self-healing for sandbox subscriptions that delete resources on a schedule.
#
# Usage:
#   ./infra/heal.sh            # check; rebuild the Azure resource if it is gone
#   ./infra/heal.sh --check    # check only, never rebuild (exit 1 if unhealthy)
#   ./infra/heal.sh --force    # rebuild even if the current resource still exists (it is left in place)
#
# Checks that the Azure OpenAI resource behind .env still exists and that the
# Databricks App is running. When the resource is gone it runs infra/setup.sh,
# refreshes the two app secrets, redeploys the app, and verifies the WebSocket
# path end to end with scripts/check-app-ws.py. Meant to run unattended (launchd
# or cron) shortly after the subscription's cleanup window. A rebuild that fails
# after setup.sh (for example on an expired Databricks login) resumes from the
# secrets on the next run instead of reporting the new resource as healthy.
#
# Configuration: infra/deploy.local (gitignored), sourced as bash:
#   PROFILE=<databricks-cli-profile>
#   APP=realtime-translator
#   WS_PATH=/Workspace/Users/<your-user>/realtime-translator
#   SECRET_SCOPE=realtime-translator   # optional; this is the default
#   on_failure() { ...; }             # optional; called with a one-line message
#
# Logs go to stdout. A run that finds another run's lock exits quietly.
#

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
STATE_DIR="${STATE_DIR:-$HOME/.local/state/realtime-translator}"
MODE="heal"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --check) MODE="check"; shift ;;
    --force) MODE="force"; shift ;;
    *)       echo "Unknown option: $1"; exit 1 ;;
  esac
done

log() { printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }

notify() {  # best effort: unattended runs have no terminal to print to
  osascript -e 'on run argv' -e 'display notification (item 1 of argv) with title "realtime-translator"' \
    -e 'end run' "$1" >/dev/null 2>&1 || true
}

STEP="startup"
fail() {
  # With set -E a failing command substitution fires the trap in its subshell too;
  # report once, from the main shell.
  ((BASH_SUBSHELL == 0)) || exit 1
  local message="heal.sh failed at: $STEP"
  log "ERROR: $message"
  notify "$message"
  if declare -F on_failure >/dev/null; then
    on_failure "$message" || log "on_failure hook failed"
  fi
  exit 1
}
trap fail ERR

# Retry a command; az and databricks calls fail for a while after the Mac wakes
# from sleep, before the network is back.
retry() {
  local attempts="$1" i
  shift
  for ((i = 1; i <= attempts; i++)); do
    "$@" && return 0
    ((i < attempts)) && sleep 60
  done
  return 1
}

STEP="read infra/deploy.local"
# shellcheck source=/dev/null
source "$SCRIPT_DIR/deploy.local"
: "${PROFILE:?set PROFILE in infra/deploy.local}" "${APP:?set APP}" "${WS_PATH:?set WS_PATH}"
SECRET_SCOPE="${SECRET_SCOPE:-realtime-translator}"

mkdir -p "$STATE_DIR"
LOCK="$STATE_DIR/heal.lock"
if ! mkdir "$LOCK" 2>/dev/null; then
  log "another run holds $LOCK (remove it if no run is active); exiting"
  exit 0
fi
trap 'rmdir "$LOCK"' EXIT

# Same subscription resolution as setup.sh: $SUBSCRIPTION, infra/subscription.local, az default.
if [[ -z "${SUBSCRIPTION:-}" && -f "$SCRIPT_DIR/subscription.local" ]]; then
  SUBSCRIPTION="$(grep -vE '^\s*(#|$)' "$SCRIPT_DIR/subscription.local" | head -n1)"
fi
SUBSCRIPTION="${SUBSCRIPTION:-$(az account show --query id -o tsv)}"
export SUBSCRIPTION

load_env() {
  AZURE_OPENAI_ENDPOINT=""
  if [[ -f "$REPO_ROOT/.env" ]]; then
    set -a
    # shellcheck source=/dev/null
    source "$REPO_ROOT/.env"
    set +a
  fi
}

find_account() {
  az cognitiveservices account list --subscription "$SUBSCRIPTION" \
    --query "[?properties.endpoint=='$AZURE_OPENAI_ENDPOINT'].name | [0]" -o tsv
}

app_field() {  # app_field <python expression over d>
  databricks apps get "$APP" -p "$PROFILE" -o json |
    python3 -c "import json, sys; d = json.load(sys.stdin); print($1)"
}

STEP="look up the Azure resource for .env"
load_env
account=""
if [[ -n "$AZURE_OPENAI_ENDPOINT" ]]; then
  account="$(retry 5 find_account)"
fi

# Marks a rebuild that created the Azure resource but did not finish redeploying
# the app; the app still holds the old secrets, so the next run must resume.
PENDING="$STATE_DIR/rebuild.pending"

if [[ -n "$account" && "$MODE" != "force" && ! -f "$PENDING" ]]; then
  STEP="read the Databricks App status"
  state="$(retry 5 app_field 'd.get("app_status", {}).get("state", "")')"
  if [[ "$state" != "RUNNING" ]]; then
    STEP="app $APP is $state (not rebuilt automatically; check the workspace)"
    fail
  fi
  log "healthy: Azure resource $account exists, app $APP is RUNNING"
  exit 0
fi

if [[ "$MODE" == "check" ]]; then
  if [[ -n "$account" ]]; then
    log "unhealthy: a rebuild of $account did not finish redeploying app $APP"
  else
    log "unhealthy: no Azure resource in $SUBSCRIPTION serves ${AZURE_OPENAI_ENDPOINT:-<no .env>}"
  fi
  exit 1
fi

if [[ -n "$account" && "$MODE" != "force" ]]; then
  log "resuming an unfinished rebuild ($AZURE_OPENAI_ENDPOINT)"
else
  log "rebuilding (mode=$MODE, previous endpoint ${AZURE_OPENAI_ENDPOINT:-<none>})"
  touch "$PENDING"

  STEP="infra/setup.sh"
  # setup.sh prints the full API key in its export hint; keep it out of the log.
  "$SCRIPT_DIR/setup.sh" | sed -E '/API_KEY|API Key/d'
  load_env
fi

STEP="update the Databricks secrets"
databricks secrets put-secret "$SECRET_SCOPE" azure-openai-endpoint \
  --string-value "$AZURE_OPENAI_ENDPOINT" -p "$PROFILE"
databricks secrets put-secret "$SECRET_SCOPE" azure-openai-api-key \
  --string-value "$AZURE_OPENAI_API_KEY" -p "$PROFILE"

STEP="databricks apps deploy"
# A stop/start keeps the old secret values; only a deploy picks up the new ones.
databricks apps deploy "$APP" --source-code-path "$WS_PATH" -p "$PROFILE" -o json >/dev/null

STEP="verify the app WebSocket"
app_url="$(app_field 'd["url"]')"
"$REPO_ROOT/.venv/bin/python" "$REPO_ROOT/scripts/check-app-ws.py" --profile "$PROFILE" --url "$app_url"

rm -f "$PENDING"
log "rebuilt: $AZURE_OPENAI_ENDPOINT"
notify "Azure resource rebuilt and app redeployed"
