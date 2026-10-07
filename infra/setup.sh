#!/usr/bin/env bash
set -euo pipefail

#
# Azure Foundry resource + model deployment for realtime-translator.
#
# Usage:
#   ./infra/setup.sh                                          # Create new resources
#   ./infra/setup.sh --rg my-rg --name my-foundry             # Use existing resource
#   ./infra/setup.sh --region eastus                           # Custom region
#   ./infra/setup.sh --sub <subscription-id>                   # Override the subscription (see also infra/subscription.local)
#
# When --rg and --name point to an existing resource, the script skips creation
# and just deploys models (if missing) + writes .env.
#
# Prerequisites:
#   - az CLI logged in
#   - Subscription with Azure OpenAI quota
#   - owner tag (required by some sandbox subscription policies)
#

# Generate a date+random suffix for ephemeral environments.
# Sandbox subscriptions often clean up resources periodically.
RAND="$(LC_ALL=C tr -dc 'a-z0-9' </dev/urandom | head -c4 || true)"
SUFFIX="$(date +%Y%m%d)-${RAND}"

RESOURCE_GROUP="${RESOURCE_GROUP:-realtime-translator-rg-${SUFFIX}}"
RESOURCE_NAME="${RESOURCE_NAME:-realtime-translator-${SUFFIX}}"
# Subscription resolution order: --sub / $SUBSCRIPTION, then infra/subscription.local (gitignored,
# one subscription id per line; use it to pin a sandbox subscription whose model quota is free),
# then the az CLI default. Rationale (2026-09-17): a shared subscription's GlobalStandard quota for
# gpt-realtime-translate was fully held by another deployment, so creation there fails.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -z "${SUBSCRIPTION:-}" && -f "$SCRIPT_DIR/subscription.local" ]]; then
  SUBSCRIPTION="$(grep -vE '^\s*(#|$)' "$SCRIPT_DIR/subscription.local" | head -n1)"
fi
SUBSCRIPTION="${SUBSCRIPTION:-$(az account show --query id -o tsv)}"
# Resource group tag; some cleanup jobs respect RemoveAfter=YYYY-MM-DD.
REMOVE_AFTER="${REMOVE_AFTER:-$(date -v+90d +%Y-%m-%d 2>/dev/null || date -d '+90 days' +%Y-%m-%d)}"
OWNER_TAG="${OWNER_TAG:-$(az account show --query user.name -o tsv)}"

# Candidate regions for resource creation (GlobalStandard deployments are
# region-agnostic for inference, but the resource itself must live somewhere).
# Ordered by preference. The script tries each until one succeeds.
# Both gpt-realtime-translate and gpt-realtime-whisper (2026-05-06) are only
# offered in: canadacentral, centralus, eastus2, francecentral, swedencentral, southindia.
CANDIDATE_REGIONS=("francecentral" "swedencentral" "eastus2" "canadacentral" "centralus" "southindia")

# Model deployments
WHISPER_MODEL="gpt-realtime-whisper"
TRANSLATE_MODEL="gpt-realtime-translate"
MODEL_VERSION="2026-05-06"
WHISPER_DEPLOYMENT="gpt-realtime-whisper"
TRANSLATE_DEPLOYMENT="gpt-realtime-translate"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --rg)        RESOURCE_GROUP="$2"; shift 2 ;;
    --region)    CANDIDATE_REGIONS=("$2"); shift 2 ;;
    --name)      RESOURCE_NAME="$2"; shift 2 ;;
    --sub)       SUBSCRIPTION="$2"; shift 2 ;;
    *)           echo "Unknown option: $1"; exit 1 ;;
  esac
done

echo "=== Azure Foundry Setup for realtime-translator ==="
echo "Subscription:   $SUBSCRIPTION"
echo "Resource Group: $RESOURCE_GROUP"
echo "Resource Name:  $RESOURCE_NAME"
echo ""

# Every az call below passes --subscription instead of `az account set`, which would
# change the default subscription for every other shell sharing ~/.azure.

# --- Ensure resource group exists ---
if ! az group show --subscription "$SUBSCRIPTION" --name "$RESOURCE_GROUP" &>/dev/null; then
  echo "Creating resource group $RESOURCE_GROUP in ${CANDIDATE_REGIONS[0]}..."
  az group create --subscription "$SUBSCRIPTION" --name "$RESOURCE_GROUP" --location "${CANDIDATE_REGIONS[0]}" \
    --tags "owner=$OWNER_TAG" "Owner=$OWNER_TAG" "RemoveAfter=$REMOVE_AFTER" --output none
fi

# --- Create OpenAI resource (try each region until quota allows) ---
existing_location=$(az cognitiveservices account show \
  --subscription "$SUBSCRIPTION" --name "$RESOURCE_NAME" --resource-group "$RESOURCE_GROUP" \
  --query "location" -o tsv 2>/dev/null || true)

if [[ -n "$existing_location" ]]; then
  echo "Resource $RESOURCE_NAME already exists in $existing_location."
  REGION="$existing_location"
else
  REGION=""
  for candidate in "${CANDIDATE_REGIONS[@]}"; do
    echo "Trying to create resource in $candidate..."
    if az cognitiveservices account create \
        --subscription "$SUBSCRIPTION" \
        --name "$RESOURCE_NAME" \
        --resource-group "$RESOURCE_GROUP" \
        --kind OpenAI \
        --sku S0 \
        --location "$candidate" \
        --tags "owner=$OWNER_TAG" \
        --output none 2>/dev/null; then
      REGION="$candidate"
      echo "Created resource in $REGION."
      break
    else
      echo "  Failed in $candidate (likely quota). Trying next..."
    fi
  done

  if [[ -z "$REGION" ]]; then
    echo "ERROR: Could not create resource in any region. Check quota."
    exit 1
  fi
fi

# --- Deploy models ---
deploy_model() {
  local deployment_name="$1"
  local model_name="$2"
  local model_version="$3"

  existing=$(az cognitiveservices account deployment show \
    --subscription "$SUBSCRIPTION" --name "$RESOURCE_NAME" --resource-group "$RESOURCE_GROUP" \
    --deployment-name "$deployment_name" \
    --query "name" -o tsv 2>/dev/null || true)

  if [[ -n "$existing" ]]; then
    echo "Deployment $deployment_name already exists. Skipping."
    return
  fi

  echo "Deploying $deployment_name ($model_name $model_version)..."
  az cognitiveservices account deployment create \
    --subscription "$SUBSCRIPTION" \
    --name "$RESOURCE_NAME" \
    --resource-group "$RESOURCE_GROUP" \
    --deployment-name "$deployment_name" \
    --model-name "$model_name" \
    --model-version "$model_version" \
    --model-format OpenAI \
    --sku-capacity 1 \
    --sku-name GlobalStandard \
    --output none
  echo "  Deployed $deployment_name."
}

deploy_model "$WHISPER_DEPLOYMENT" "$WHISPER_MODEL" "$MODEL_VERSION"
deploy_model "$TRANSLATE_DEPLOYMENT" "$TRANSLATE_MODEL" "$MODEL_VERSION"

# --- Output connection info ---
ENDPOINT=$(az cognitiveservices account show \
  --subscription "$SUBSCRIPTION" --name "$RESOURCE_NAME" --resource-group "$RESOURCE_GROUP" \
  --query "properties.endpoint" -o tsv)

API_KEY=$(az cognitiveservices account keys list \
  --subscription "$SUBSCRIPTION" --name "$RESOURCE_NAME" --resource-group "$RESOURCE_GROUP" \
  --query "key1" -o tsv)

echo ""
echo "=== Setup Complete ==="
echo "Endpoint:  $ENDPOINT"
echo "Region:    $REGION"
echo "API Key:   ${API_KEY:0:8}...***"
echo ""
echo "Deployments:"
az cognitiveservices account deployment list \
  --subscription "$SUBSCRIPTION" --name "$RESOURCE_NAME" --resource-group "$RESOURCE_GROUP" \
  --query "[].{name: name, model: properties.model.name, version: properties.model.version, sku: properties.model.skuName}" \
  -o table

echo ""
echo "To use in the app, set these environment variables:"
echo "  export AZURE_OPENAI_ENDPOINT=$ENDPOINT"
echo "  export AZURE_OPENAI_API_KEY=$API_KEY"

# --- Write .env file for convenience ---
ENV_FILE="$(cd "$(dirname "$0")/.." && pwd)/.env"
cat > "$ENV_FILE" <<ENVEOF
AZURE_OPENAI_ENDPOINT=$ENDPOINT
AZURE_OPENAI_API_KEY=$API_KEY
AZURE_OPENAI_WHISPER_DEPLOYMENT=$WHISPER_DEPLOYMENT
AZURE_OPENAI_TRANSLATE_DEPLOYMENT=$TRANSLATE_DEPLOYMENT
ENVEOF
echo "Written to $ENV_FILE"
