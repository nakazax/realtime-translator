# Azure Realtime Translation API — 実機検証結果

検証日: 2026-06-10
リソース: `hinak-foundry-20260610-fwcr` (francecentral) / deployments: `gpt-realtime-translate`, `gpt-realtime-whisper` (2026-05-06, GlobalStandard)
ツール: `node scripts/smoke-azure.mjs` (ログ: /tmp/smoke-azure.log) + 補完curlプローブ

## 結論 (アプリ実装が依存する確定事項)

| 項目 | 確定値 |
|---|---|
| 動作する транспорト | **WebSocketのみ**: `wss://{resource}.openai.azure.com/openai/v1/realtime/translations?model={translate-deployment}` |
| WS認証 (サーバ間) | `api-key: <KEY>` ヘッダ → 101 |
| WS認証 (代替) | `?api-key=<KEY>` クエリパラメータ → 101 (キーが露出するためデバッグ専用) |
| セッション設定 | 接続後に `session.update` を送信: `{"type":"session.update","session":{"audio":{"input":{"transcription":{"model":"<whisper-deployment>"},"noise_reduction":null},"output":{"language":"ja"}}}}` |
| 音声送信 | `{"type":"session.input_audio_buffer.append","audio":"<base64 PCM16@24k mono>"}` (200ms = 9,600バイト目安) |
| イベント語彙 | **翻訳ファミリー**: `session.created` / `session.updated` / `session.input_transcript.delta` / `session.output_transcript.delta` / `session.output_audio.delta` (PCM16@24k base64, `elapsed_ms`付き) |
| 出力音声の形態 | **連続吹き替えトラック** (2026-06-11 ブラウザ実機で確認): `session.output_audio.delta` は入力タイムライン全体を9,600バイト=200ms固定フレームでリアルタイムに流し続ける。大半は合成無音 (ピーク振幅 ≤63 int16)、発話バーストは ≥1024 で二峰性が明確。発話していない間も無音フレームが届き続けるため、クライアントは無音ゲートで間引かないと再生遅延がネットワーク停滞のたびに蓄積する (`client/audio-playback.js` の `SILENT_FRAME_PEAK`) |
| session.created の中身 | `"type":"translation"`, model `gpt-realtime-translate-2026-05-06` (typeはサーバ側が自動決定) |
| ephemeral mint | **全パターン不可** (下表)。client secretは存在しない前提で設計する |
| WebRTC | **不可**。`/realtime/calls` はephemeralトークン必須 + translationセッションはmint不可のため到達不能 |
| CORS | `/realtime/calls` のpreflightは `Access-Control-Allow-Origin: *` (本アプリでは未使用) |

### 実証エビデンス (P3フルループ)

入力: macOS `say` 生成の英語音声 6.3秒 ("The quick brown fox... real time translation.")

- 訳文 (output_transcript連結): `「そのきれいなキツネが、のんびりした犬を飛び越える」AIがリアルタイム翻訳を変えています。`
- 原文 (input_transcript連結): ` The quick brown fox jumps over the lazy dog. Artificial intelligence is transforming real-time translation.` (既知文との語一致率 0.87)
- `session.output_audio.delta` 48件 (翻訳音声PCM)
- イベント数: `{"session.created":1,"session.updated":1,"session.input_transcript.delta":18,"session.output_audio.delta":48,"session.output_transcript.delta":36}`

## アーキテクチャ決定: WebSocketプロキシ

当初プラン (WebRTC + バックエンドSDPプロキシ) は **不成立**。確定アーキテクチャ:

```
ブラウザ ──(同一オリジン WS /api/ws?target=ja)──> FastAPI ──(WS + api-keyヘッダ)──> Azure
  ↑ AudioWorkletでマイク/タブ音声をPCM16@24kに変換して送信
  ↓ session.output_audio.delta をWeb Audioで再生、*_transcript.delta を字幕表示
```

- ブラウザはWSヘッダを設定できず、subprotocol認証 (`openai-insecure-api-key.*`) はAzure未対応 (401) のため、ブラウザ直結はAPIキー露出なしには不可能 → バックエンドWSプロキシが唯一の安全な構成
- Databricks Appsのプロキシは音声フレームが200ms間隔で常時流れるためアイドルタイムアウトの影響なし
- デモ同梱の `pcm16-capture.worklet.js` (WebRTC経路では未使用だった) をキャプチャに使用

## プローブ全結果

### P1: ephemeral mint (全滅)

| プローブ | URL | Body | 結果 |
|---|---|---|---|
| P1a(+pv) | `POST /openai/v1/realtime/translations/client_secrets` | translation形状 | **404** `DeploymentNotFound` |
| P1b | `POST /openai/v1/realtime/client_secrets` | translation形状 (type無し) | **400** `InvalidSessionType` |
| P1c | 同上 | + `"type":"translation"` | **400** `InvalidSessionType` |
| P1d | 同上 | `type:realtime` + translateデプロイ + instructions | **400** `OpperationNotSupported` ("The realtime operation does not work with the specified model") |

→ Azureのmintは `type: realtime|transcription` のみ受理。translation型は未対応 (公開OpenAPI specと一致)。translateデプロイをrealtime型として使うことも不可。

### P2: WSハンドシェイク

| パス | 認証 | 結果 |
|---|---|---|
| `/openai/v1/realtime/translations?model=TD` | `api-key` ヘッダ | **101** ✅ |
| 同上 | `openai-insecure-api-key.<KEY>` subprotocol | 401 |
| 同上 | `?api-key=<KEY>` クエリ | **101** ✅ |
| 同上 | `Authorization: Bearer <Entra token (cognitiveservices scope)>` | 401 PermissionDenied (ロール未割当の可能性、未深掘り) |
| `/openai/v1/realtime?model=TD` (標準パス) | `api-key` ヘッダ | **400** `OpperationNotSupported` → translateは標準realtimeパスでは動かない |

### P4: WebRTC SDP calls

| パス | 認証 | 結果 |
|---|---|---|
| `POST /openai/v1/realtime/calls` | `api-key` ヘッダ | **401** "Realtime session ephemeral token is required." → パスは存在するがephemeral必須 |
| `POST /openai/v1/realtime/translations/calls` (+pv) | 同上 | **404** Resource not found |

### P5: CORS preflight (`/openai/v1/realtime/calls`)

- Origin `http://127.0.0.1:8000` / `https://*.databricksapps.com` とも: 200, `Access-Control-Allow-Origin: *`, `Access-Control-Allow-Headers: authorization,content-type`

## 再検証手順

リソース再作成時や Azure 仕様変更を疑うとき:

```bash
node scripts/smoke-azure.mjs 2>&1 | tee /tmp/smoke-azure.log
```

将来 mint (P1) が 2xx を返すようになったら、WebRTC構成 (低遅延・メディアブラウザ直結) への移行を再検討する価値あり。
