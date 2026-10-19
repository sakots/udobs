# 開発と仕様の管理

## 資料の役割

| 資料 | 内容 |
| --- | --- |
| [README](../README.md) | 利用者向けの準備、設定、起動・終了、表示調整 |
| [.env.example](../.env.example) | 設定ファイルのテンプレート |
| [トラブルシューティング](troubleshooting.md) | ログの読み方、通信設定、障害の切り分け |
| [OpenSpecの現行仕様](../openspec/specs/) | 実装が満たす要件と具体的なシナリオ |
| [OpenSpecの変更](../openspec/changes/) | 今後の変更ごとの提案、仕様差分、設計、作業タスク |
| [更新履歴](../CHANGELOG.md) | 過去の変更。現行仕様そのものではない |

今回のOpenSpecへの整理は既存実装の文書化です。未実装機能の提案ではなく、過去の変更に対する提案・タスクを後付けで作成していません。

## 現行仕様の一覧

| 仕様 | 主な内容 |
| --- | --- |
| [configuration-runtime](../openspec/specs/configuration-runtime/spec.md) | 設定の優先順位、既定値、検証、起動と終了 |
| [udtalk-acquisition](../openspec/specs/udtalk-acquisition/spec.md) | Web公開の取得、取得位置、重複排除、再試行 |
| [caption-display](../openspec/specs/caption-display/spec.md) | 自動改行、発話訂正、現在字幕と前字幕の選択 |
| [obs-delivery](../openspec/specs/obs-delivery/spec.md) | OBS v5認証、送信順序、応答確認、再接続後の再送 |
| [diagnostics](../openspec/specs/diagnostics/spec.md) | ログ保存、通信診断、秘匿、終了ログの集約 |

## 実装の構成

処理はWeb公開からの取得、表示用の改行、発話履歴の更新、OBSへの送信・応答確認の順です。取得側が発話を処理済みとして進める境界と、OBSの成功応答を確認する境界は異なります。OBS切断中は字幕を最新値へ集約するため、受信した全発話がOBS上で順番に表示される保証はありません。

| ファイル | 責務 |
| --- | --- |
| `src/index.ts` | 設定と各処理の接続、終了シグナルの処理 |
| `src/config.ts` | 環境変数・CLI引数の検証とOBS設定への変換 |
| `src/udtalk-web-client.ts` | 閲覧セッション、定期取得、取得位置と重複の管理 |
| `src/text-wrap.ts` | 表示用テキストの改行 |
| `src/caption-history.ts` | 発話の訂正・順序と表示ペアの管理 |
| `src/obs.ts` | OBS認証、応答待ち、再接続、保持字幕の再送 |
| `src/logging.ts` | 標準出力・標準エラーのファイル保存 |
| `src/error-details.ts` | 通信エラーの整形と秘密情報の伏せ字 |
| `src/connection-diagnostics.ts` | 接続・ヘッダー・ソケット終了の観測 |
| `scripts/start.mjs` | WindowsとLinuxに共通のビルド・起動 |
| `test/` | Node.js標準テストランナーによるテスト |
| `dist/` | TypeScriptの生成物。直接編集しない |

## 変更の進め方

1. 関連する現行仕様と実装・テストを確認する。
2. 変更の資料を先に更新し、対象範囲と対象外を明確にする。
3. 利用者に影響する変更には、必要な回帰テストを書いてから最小実装する。
4. 変更した動作を実際に試し、テストと資料の整合性を確認する。
5. 完了した変更をアーカイブし、仕様差分を現行仕様へ反映する。

OpenSpecの成果物は日本語で書きます。要件とシナリオの見出しはOpenSpecの形式を使い、要件には `MUST` または `SHALL`、シナリオには `WHEN`・`THEN` で条件と結果を記述します。変更の提案には対象外を含め、転送や再接続の設計では取得位置、字幕保持値、応答待ちの扱いを明記してください。これらの指針は [openspec/config.yaml](../openspec/config.yaml) に設定しています。

### AI支援のワークフロー

OpenSpec対応のAIツールでは、次の順で依頼できます。

- `/opsx:propose <変更名または変更内容>`: 提案、仕様差分、必要な設計、タスクを作成する。
- `/opsx:apply <変更名>`: 作成済みのタスクを実装する。
- `/opsx:archive <変更名>`: 完了した変更をアーカイブする。

提案作成と実装は別の段階です。提案を作っただけでは実装済みになりません。

### CLIでの確認

```bash
# 現行仕様と進行中の変更
openspec list --specs
openspec list

# 仕様本文の確認
openspec show udtalk-acquisition --type spec

# 変更ごとの成果物の状態
openspec status --change <変更名>

# 全仕様・変更の形式検証
openspec validate --all --strict --no-interactive
```

## ビルドと検証

Node.js 22以降とpnpmを使用します。TypeScript、ES Modules、strictモードで実装しています。

```bash
pnpm install
pnpm build
pnpm test
git diff --check
```

`pnpm test` はビルド後に `dist/test/` のテストを実行します。CLIの設定項目はビルド後に `node dist/src/index.js --help` で確認できます。アプリは作業ディレクトリの `.env` を読み込みます。

転送・再接続を変更するときは、切断前後の未取得会話、OBS応答前の切断、字幕の重複を再現してください。外部サービスへの接続はテストではモックに置き換え、架空のURLと発話を使います。実際の `.env`、公開URL、OBSパスワード、会話本文を資料・テストに含めないでください。

テストが通ったことと実機での確認は区別します。WindowsやOBSで実際に確認していない場合は、検証済みとして報告しないでください。Web閲覧ページの通信方式を変更するときも、実際のページと応答を調べ、未確認の推測を仕様の事実として書かないでください。
