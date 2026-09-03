# UDトーク → OBS テキスト ブリッジ

UDトークの会話を、ゆかりねっとコネクターNEO（ゆかコネNEO）のWebSocketから受け、OBSの既存テキストソースへそのまま表示する最小のNode.jsアプリです。

UDトーク自身の会話プロトコルは公開されていないため、UDトークの会話への参加・受信はゆかコネNEOに任せます。このアプリは字幕の転送だけを行い、会話ログの保存、翻訳、画面描画は行いません。

## 必要なもの

- Node.js 22以降
- OBS Studio 28以降（OBS WebSocket v5を有効化）
- ゆかコネNEO。UDトークのトークルームに接続済みであること
- OBS内に作成済みのテキストソース

## セットアップと起動

OBSの「ツール」→「WebSocketサーバー設定」でサーバーを有効にし、ポート（通常 `4455`）とパスワードを確認します。

OBSでテキストソースを作ります。例: `字幕`

ゆかコネNEOをUDトークのトークルームへ接続します。

[.env.example](/home/sakots/dev/udobs/.env.example) をコピーして、プロジェクト直下に `.env` を作ります。

PowerShellでは次を実行します。

```powershell
Copy-Item .env.example .env
```

コマンドプロンプトでは次を実行します。

```bat
copy .env.example .env
```

`.env` を開き、OBSのパスワードとテキストソース名を設定します。

```dotenv
OBS_PASSWORD=OBSで設定したパスワード
OBS_INPUT_NAME=字幕
OBS_URL=ws://127.0.0.1:4455
YNC_URL=ws://127.0.0.1:11901/textonly
```

`OBS_PASSWORD` と `OBS_INPUT_NAME` は必須です。OBSまたはゆかコネNEOのポートを変更していなければ、それ以外の行はそのままでかまいません。

起動します。

```bash
npm start
```

`UDトーク入力に接続しました` と `OBS WebSocketの認証が完了しました` が表示されれば準備完了です。UDトークで確定した発話が、指定したOBSテキストソースに表示されます。

`.env` はGitの管理対象外なので、パスワードはコミットされません。

## ポートを変更している場合

ゆかコネNEOのWebSocketポートが既定値と異なる場合は、`.env` の `YNC_URL` を変更します。使用中のポート番号は、ゆかコネNEOのレジストリ設定に記録されています。

```dotenv
YNC_URL=ws://127.0.0.1:実際のポート番号/textonly
```

OBS WebSocketのポートを変更している場合も、同様に `OBS_URL` を変更してください。

```dotenv
OBS_URL=ws://127.0.0.1:実際のポート番号
```

`/textonly` は、確定済み・未表示・未削除の原文だけを流すゆかコネNEOのエンドポイントです。発話途中や翻訳の再送でOBSの字幕が揺れません。

## オプション

```text
--input-name <名前>       更新するOBSテキストソース名（必須）
--obs-password <パスワード>
--obs-url <URL>           既定: ws://127.0.0.1:4455
--ync-url <URL>           既定: ws://127.0.0.1:11901/textonly
--reconnect-ms <ミリ秒>   既定: 2000
```

`.env` の設定より一時的に優先したいときだけ、同名の環境変数またはコマンドライン引数を使えます。接続が切れた場合は自動で再接続します。

## 動作確認

```bash
npm test
```
