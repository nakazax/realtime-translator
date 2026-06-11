# realtime-translator

[English README is here](README.md)

Web会議・対面ミーティング向けのリアルタイム翻訳/文字起こしWebアプリです。
Azure AI Foundryのリアルタイムモデル (`gpt-realtime-translate` +
`gpt-realtime-whisper`) を使い、Databricks Appsにデプロイできます。

OpenAIの
[browser-translation-demo](https://github.com/openai/openai-cookbook/tree/main/examples/voice_solutions/realtime_translation_guide/browser-translation-demo)
をベースに、Azure向けに再設計しています。Azureのtranslationセッションは
サーバ認証付きWebSocketでしか動かないため、FastAPIバックエンドが
セッションを中継します (検証済みのAPI契約は `docs/api-verification.md`)。

```
ブラウザ ──(同一オリジン WS /api/ws?target=ja)──> FastAPI ──(WS + api-keyヘッダ)──> Azure OpenAI
  ↑ AudioWorkletがタブ/マイク音声をPCM16@24kHzチャンクに変換して送信
  ↓ session.output_audio.delta をWeb Audioで再生、*_transcript.delta を字幕表示
```

## 主な機能

- **字幕**: 左右2カラム。単方向 (原文/訳文) と ja ⇄ en 双方向 (左=英語のすべて、右=日本語のすべて)
- **読み上げ3モード**: Manual (▶ Speakボタンで人がタイミングを決める、対面向け) /
  Simultaneous (届いた訳を即読み上げ、ウェビナー視聴向け) /
  After pause (話者が黙ったのを検知して自動でまとめて読み上げ、逐次通訳風)
- **エコー抑制**: 同言語で復唱されただけの段落 (en→en等) を自動判定して非表示・読み上げ対象外に
- **履歴**: Stop→Startで字幕を保持 (区切り線入り)。Clearで全消去、CSVエクスポート (Excel日本語対応)
- **発言を組み立てる**: 日本語で下書き→自然な話し言葉の英語に変換 (Databricks基盤モデルAPI、ストリーミング)

## セットアップ

### 1. Azureリソース

```bash
az login
./infra/setup.sh        # RG + Azure OpenAIリソース作成、両モデルをデプロイ、.envを書き出し
```

サンドボックス系のサブスクリプションはリソースを定期削除することがあります。
復旧も同じコマンドです: `./infra/setup.sh` を再実行 (Databricks Appが稼働中なら
シークレット2つを更新して再デプロイ。デプロイの節を参照)。

### 2. ローカル開発

```bash
uv venv && uv pip install -e ".[dev]"
COMPOSE_PROFILE=<databricks-cli-profile> .venv/bin/python -m server   # http://localhost:8000
```

`COMPOSE_PROFILE` は発言ボックス (`/api/compose`、基盤モデルAPI) が使う
Databricks CLIプロファイル名です。必要なのはローカルのみで、Databricks Apps上では
サービスプリンシパルの認証情報が自動で使われます。エンドポイントの既定は
`databricks-claude-haiku-4-5` (`COMPOSE_SERVING_ENDPOINT` で変更可)。

手動テスト: 別タブで `scripts/fixtures/source.html` を開く (英語スピーチを
ループ再生)、アプリでBrowser tabキャプチャを選び、そのタブを音声共有付きで選択。

### 3. テスト

```bash
.venv/bin/pytest                    # バックエンド
node --test client/tests/*.test.js  # クライアントロジック
node scripts/smoke-azure.mjs        # Azure API契約の実機再検証
node scripts/e2e-ws.mjs             # ローカルサーバのE2E (サーバ起動が必要)
```

## Databricks Appsへのデプロイ

シェルごとに一度設定します (Appsとpay-per-tokenの基盤モデルエンドポイントが
あるワークスペースならどこでも動きます):

```bash
PROFILE=<databricks-cli-profile>
APP=realtime-translator
WS_PATH=/Workspace/Users/<your-user>/$APP
```

AzureのエンドポイントとAPIキーはどちらもシークレット由来のアプリリソース
(`app.yaml` の `valueFrom`) 経由で渡るため、リポジトリには含まれません。

```bash
# 初回のみ: シークレットスコープ + シークレット2つ + リソースを紐付けたアプリ作成
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

# リリースのたび (syncは.gitignoreを尊重するので.env/.venvはローカルに残る)
databricks sync . $WS_PATH -p $PROFILE
databricks apps deploy $APP --source-code-path $WS_PATH -p $PROFILE
```

`compose-endpoint` リソースは、発言ボックスが使う基盤モデルAPIエンドポイントへの
CAN_QUERYをアプリのサービスプリンシパルに付与します。

Azureリソースを再作成したときは、新しい `.env` の値で `put-secret` を2回
やり直して再デプロイするだけです。`app.yaml` の編集は不要です。

長寿命のWebSocket (ブラウザ → アプリ → Azure) はDatabricks Appsのプロキシを
通ります。200msごとの音声フレームが流れ続けるためアイドルタイムアウトには
なりません (エンドツーエンドで検証済み)。

## コスト

セッションを開いている間、GlobalStandardの時間課金が発生します:
`gpt-realtime-translate` $2.04/h + `gpt-realtime-whisper` $1.02/h ≈ **約$3/h**
(1方向あたり)。双方向 (2セッション) は約$6/h。Stopを押すかページを閉じると
セッションは終了します。

## データの扱い

このアプリ自体は会話内容を保存しません。FastAPIプロキシはブラウザとAzure OpenAIの
間で音声フレームとセッションイベントを中継するだけで、ログに残すのは接続エラーのみ
です (字幕や音声は記録しません)。字幕とバッファ済みの翻訳音声はブラウザのメモリ
にだけ存在し、ページを再読み込みすると消えます (残したい場合はCSVエクスポート)。

音声はAzure OpenAIがリアルタイムに処理します。Microsoftは、入力 (プロンプト) と
出力がOpenAIに渡らないこと、基盤モデルの学習に使われないこと、モデルがステートレス
であること (モデル内に入出力が保存されない) を明記しています。不正利用監視のために
サンプルが保存される場合があります (監視変更が承認されたサブスクリプションを除く)。
発言ボックスの文章はAzureではなくDatabricksワークスペースの基盤モデルAPIで処理
されます。最新の規約は
[Data, privacy, and security for Foundry Models sold by Azure](https://learn.microsoft.com/azure/foundry/responsible-ai/openai/data-privacy)
を参照してください。

## リポジトリ構成

| パス | 役割 |
|---|---|
| `server/` | FastAPIバックエンド: 静的配信、`/api/config`、`/api/ws` プロキシ、`/api/compose` |
| `client/` | Vanilla JSフロントエンド (ビルド不要)、OpenAIデモからの移植 |
| `infra/setup.sh` | Azureリソース + モデルデプロイのプロビジョニング |
| `scripts/smoke-azure.mjs` | 依存ゼロのAPI検証マトリクス (mint/WS/WebRTC/CORS) |
| `docs/api-verification.md` | 検証済みAzure API契約とプローブの証跡 |
