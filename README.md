# realtime-translator

[日本語版 README はこちら](README.ja.md)

Realtime translation / transcription web app for web meetings and in-person
meetings, built on Azure AI Foundry realtime models
(`gpt-realtime-translate` + `gpt-realtime-whisper`) and deployable to
Databricks Apps.

Based on OpenAI's
[browser-translation-demo](https://github.com/openai/openai-cookbook/tree/main/examples/voice_solutions/realtime_translation_guide/browser-translation-demo),
re-architected for Azure: translation sessions on Azure only work over a
server-authenticated WebSocket, so the FastAPI backend proxies the session
(see `docs/api-verification.md` for the verified API contract).

```
Browser ──(same-origin WS /api/ws?target=ja)──> FastAPI ──(WS + api-key header)──> Azure OpenAI
  ↑ AudioWorklet converts tab/mic audio to PCM16@24kHz chunks
  ↓ plays session.output_audio.delta via Web Audio, renders *_transcript.delta captions
```

## Features

- **Subtitles**: two columns, one-way (source/translation) or bidirectional
  ja ⇄ en (left collects everything in English, right everything in Japanese)
- **Three voice modes**: Manual (the operator plays translations with the
  ▶ Speak queue, for in-person meetings) / Simultaneous (speaks as
  translations arrive, for watching webinars) / After pause (waits for the
  speaker to pause, then reads the queue, consecutive-interpretation style)
- **Echo suppression**: segments that merely re-speak same-language input
  (en→en, ja→ja) are detected, hidden, and never read aloud
- **History**: subtitles survive Stop/Start (with a divider); Clear wipes,
  Export downloads an Excel-ready CSV
- **Compose box**: draft in Japanese, get natural spoken English via the
  Databricks Foundation Model API (streaming)

## Setup

### 1. Azure resources

```bash
az login
./infra/setup.sh        # creates RG + Azure OpenAI resource, deploys both models, writes .env
```

Sandbox subscriptions often delete resources periodically. Recovery is the
same command: re-run `./infra/setup.sh` (then refresh the two secrets and
redeploy if the Databricks App is live; see the deployment section).

### 2. Local development

```bash
uv venv && uv pip install -e ".[dev]"
COMPOSE_PROFILE=<databricks-cli-profile> .venv/bin/python -m server   # http://localhost:8000
```

`COMPOSE_PROFILE` names the Databricks CLI profile used by the compose box
(`/api/compose`, Foundation Model API). It is only needed locally; on
Databricks Apps the service principal credentials are ambient. The endpoint
defaults to `databricks-claude-haiku-4-5` (override with
`COMPOSE_SERVING_ENDPOINT`).

Manual test: open `scripts/fixtures/source.html` in another tab (it loops an
English speech sample), click "Choose tab to start translating", pick that
tab with audio sharing enabled.

### 3. Tests

```bash
.venv/bin/pytest                    # backend
node --test client/tests/*.test.js  # client logic
node scripts/smoke-azure.mjs        # live Azure API contract re-verification
node scripts/e2e-ws.mjs             # local server end-to-end (server must be running)
```

## Databricks Apps deployment

Set these once per shell (any workspace with Apps and pay-per-token
Foundation Model endpoints works):

```bash
PROFILE=<databricks-cli-profile>
APP=realtime-translator
WS_PATH=/Workspace/Users/<your-user>/$APP
```

The Azure endpoint and API key both reach the app through secret-backed
app resources (`valueFrom` in `app.yaml`), so neither lives in the repo.

```bash
# One-time: secret scope + the two secrets + the app with resources bound
databricks secrets create-scope realtime-translator -p $PROFILE
source .env
databricks secrets put-secret realtime-translator azure-openai-endpoint \
  --string-value "$AZURE_OPENAI_ENDPOINT" -p $PROFILE
databricks secrets put-secret realtime-translator azure-openai-api-key \
  --string-value "$AZURE_OPENAI_API_KEY" -p $PROFILE
databricks apps create -p $PROFILE --json '{"name":"'$APP'","resources":[
  {"name":"azure-openai-api-key","secret":{"scope":"realtime-translator","key":"azure-openai-api-key","permission":"READ"}},
  {"name":"azure-openai-endpoint","secret":{"scope":"realtime-translator","key":"azure-openai-endpoint","permission":"READ"}},
  {"name":"compose-endpoint","serving_endpoint":{"name":"databricks-claude-haiku-4-5","permission":"CAN_QUERY"}}]}'

# Every release (sync respects .gitignore, so .env/.venv stay local)
databricks sync . $WS_PATH -p $PROFILE
databricks apps deploy $APP --source-code-path $WS_PATH -p $PROFILE
```

The `compose-endpoint` resource grants the app's service principal CAN_QUERY
on the Foundation Model API endpoint used by the compose box.

After recreating the Azure resource, re-run the two `put-secret` commands
with the new `.env` values, then deploy again. `app.yaml` needs no edits.

The long-lived WebSocket (browser → app → Azure) flows through the Databricks
Apps proxy; audio frames every 200ms keep it from idling out (verified end to
end).

## Costs

GlobalStandard hourly billing while a session is open:
`gpt-realtime-translate` $2.04/h + `gpt-realtime-whisper` $1.02/h ≈ **$3.06/h**
per direction. Bidirectional (two sessions) ≈ $6.12/h. Sessions close when
you press Stop or close the page.

## Data handling

The app itself stores no conversation content. The FastAPI proxy only relays
audio frames and session events between the browser and Azure OpenAI; it logs
connection errors, never transcripts or audio. Subtitles and buffered
translation audio live in browser memory only and are gone after a page
reload (use Export for a CSV copy).

Speech is processed in real time by Azure OpenAI. Microsoft states that
prompts (inputs) and completions (outputs) are not available to OpenAI, are
not used to train foundation models, and that the models are stateless (no
prompts or completions are stored in the model); samples may be stored for
abuse-monitoring review unless the subscription is approved for modified
monitoring. Compose-box text goes to the Databricks workspace's Foundation
Model API instead of Azure. See
[Data, privacy, and security for Foundry Models sold by Azure](https://learn.microsoft.com/azure/foundry/responsible-ai/openai/data-privacy)
for the current terms.

## Repository layout

| Path | Purpose |
|---|---|
| `server/` | FastAPI backend: static serving, `/api/config`, `/api/ws` proxy, `/api/compose` |
| `client/` | Vanilla JS frontend (no build step), ported from the OpenAI demo |
| `infra/setup.sh` | Azure resource + model deployment provisioning |
| `scripts/smoke-azure.mjs` | Zero-dep API verification matrix (mint/WS/WebRTC/CORS) |
| `docs/api-verification.md` | Verified Azure API contract and probe evidence |
