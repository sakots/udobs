# 設定と起動・終了

## Purpose

UDトークとOBSへの接続設定、OS共通の起動、停止時の資源解放を定義する。

実装: [config.ts](../../../src/config.ts)、[index.ts](../../../src/index.ts)、[start.mjs](../../../scripts/start.mjs)。確認用テスト: [config.test.ts](../../../test/config.test.ts)。利用手順は[README](../../../README.md)を参照する。

| 環境変数 | CLI引数 | 未設定時の値 |
| --- | --- | --- |
| `OBS_INPUT_NAME` | `--input-name` | 必須 |
| `OBS_PREVIOUS_INPUT_NAME` | `--previous-input-name` | 空文字（前字幕なし） |
| `OBS_PASSWORD` | `--obs-password` | 空文字 |
| `OBS_URL` | `--obs-url` | `ws://127.0.0.1:4455` |
| `RECONNECT_MS` | `--reconnect-ms` | `2000` |
| `UDTALK_PUBLIC_URL` | `--udtalk-url`（繰り返し可） | 1件以上必須 |
| `UDTALK_PASSCODE` | `--udtalk-passcode` | 空文字（個別指定がないURLの共通値） |
| `UDTALK_PASSCODES` | `--udtalk-passcodes` | `{}`（URLをキー、パスコード文字列を値とするJSON） |
| `POLL_MS` | `--poll-ms` | `1000` |
| `UDTALK_REQUEST_TIMEOUT_MS` | `--udtalk-request-timeout-ms` | `5000` |
| `UDTALK_RETRY_MAX_MS` | `--udtalk-retry-max-ms` | `10000` |
| `MAX_CHARS_PER_LINE` | `--max-chars-per-line` | `24` |

時間の単位はミリ秒。`.env.example` の `POLL_MS=500` は設定例であり、未設定時の既定値とは異なる。

## Requirements

### Requirement: 設定の読み込みと優先順位

アプリは上表の設定項目と既定値に従い、既定値、環境変数、CLI引数の順で設定を上書きしなければならない（MUST）。起動時に作業ディレクトリの `.env` を読み込み、既に存在する環境変数は上書きしない（MUST）。`.env` が存在しない場合は起動を続け、それ以外の読み込みエラーでは終了しなければならない（MUST）。

#### Scenario: CLI引数で環境変数を上書きする

- **GIVEN** 必須設定があり、環境変数の `UDTALK_REQUEST_TIMEOUT_MS` が `6000` である
- **WHEN** `--udtalk-request-timeout-ms 3000` を指定する
- **THEN** 通信全体の上限は `3000` ミリ秒になる

#### Scenario: Web公開のパスコードを任意に指定する

- **WHEN** `UDTALK_PASSCODE` または `--udtalk-passcode` を指定する
- **THEN** CLI引数を優先し、先頭のゼロや前後の空白を含めた文字列をそのまま認証へ渡す
- **AND** 未設定でも設定エラーにはせず、パスコードなしの公開へ接続できる

#### Scenario: .envを作らず起動する

- **GIVEN** `.env` が存在せず、環境変数に必須設定がある
- **WHEN** アプリを起動する
- **THEN** `.env` 不在を設定エラーとせず、環境変数を使って起動する

### Requirement: 複数のWeb公開URL設定

アプリは `UDTALK_PUBLIC_URL` のカンマ区切り・改行区切りのURL一覧と、繰り返し指定した `--udtalk-url` を受け付けなければならない（MUST）。環境変数の一覧では各要素の前後の空白と空要素を除去する（MUST）。CLIの各URLは前後の空白を除去し、空の指定を拒否する（MUST）。1件以上のURLを要求し、全URLを接続前に検証しなければならない（MUST）。CLIにURL指定がある場合は環境変数の一覧全体を置き換える（MUST）。同じ公開IDは設定順で最初のURLだけを保持し、重複接続してはならない（MUST NOT）。通信間隔・タイムアウトは全URL共通とする。

#### Scenario: CLIでURL一覧を置き換える

- **GIVEN** 環境変数にURL AとBが設定されている
- **WHEN** `--udtalk-url C --udtalk-url D` を指定する
- **THEN** CとDだけを同時に取得する

#### Scenario: 2件目以降のURLが不正

- **WHEN** URL一覧の途中に不正なURLがある
- **THEN** どのURLにも接続せず、秘密のURLを含めない設定エラーで終了する

### Requirement: URL別のWeb公開パスコード

アプリは `UDTALK_PASSCODES` または `--udtalk-passcodes` に、公開URLをキー、パスコード文字列を値とするJSONオブジェクトを受け付けなければならない（MUST）。CLIの指定は環境変数の個別設定全体を置き換える（MUST）。各URLには公開IDが一致する個別値を優先し、個別指定がない場合だけ `UDTALK_PASSCODE` の共通値を使わなければならない（MUST）。空文字の個別値、先頭ゼロ、前後の空白、区切り文字を保持しなければならない（MUST）。URL一覧の並べ替え・CLIによる置き換え・重複除去によって対応するパスコードを取り違えてはならない（MUST NOT）。個別設定だけでは接続先を追加しない。

設定値全体を接続前に検証し、不正なJSON、オブジェクト以外、文字列でない値、不正な公開URL、同じ公開IDに対する異なるパスコードを拒否しなければならない（MUST）。未使用URLの有効な個別設定は許可する。設定エラーには入力JSON、実際のURL、パスコードを含めてはならない（MUST NOT）。

#### Scenario: 異なるパスコードで複数URLへ接続する

- **GIVEN** URL AとBの個別パスコードが異なる
- **WHEN** URLをB、Aの順に指定して起動する
- **THEN** BとAはそれぞれ対応する個別値で認証し、再接続でも同じ対応を維持する

#### Scenario: 共通値より空の個別値を優先する

- **GIVEN** 共通パスコードと、URL Aに空文字の個別値が設定されている
- **WHEN** URL Aと、個別指定のないURL Bを設定する
- **THEN** Aのパスコードは空文字、Bは共通値になる



### Requirement: 接続前の設定検証

アプリは接続開始前に設定を検証し、不正な場合はエラーとヘルプを表示して終了コード `1` で終了しなければならない（MUST）。

- 現在字幕のソース名と1件以上のWeb公開URLは必須。
- 前字幕のソース名は空欄にできるが、現在字幕と同じ名前にはできない。
- OBS URLのスキームは `ws:` または `wss:`。
- Web公開URLは `https:`、ホスト名は `live.udtalk.jp`、パスは `/` に続く小文字英数字64文字。
- `RECONNECT_MS` は有限の0以上の数値。
- `POLL_MS` は有限の250以上の数値。
- `UDTALK_REQUEST_TIMEOUT_MS` は1〜2147483647の整数。
- `UDTALK_RETRY_MAX_MS` は `POLL_MS` 以上、2147483647以下の整数。
- `MAX_CHARS_PER_LINE` は1以上の整数。
- 認識するCLIオプションには値が必要。

#### Scenario: 同じソースへの二重指定を拒否する

- **WHEN** 現在字幕と前字幕に同じソース名を指定する
- **THEN** OBSへ接続せず設定エラーで終了する

#### Scenario: 再試行の上限が通常の待ち時間より短い

- **WHEN** `POLL_MS=1000`、`UDTALK_RETRY_MAX_MS=999` を指定する
- **THEN** 設定エラーで終了する

### Requirement: OS共通のビルドと起動

`pnpm start` と `node scripts/start.mjs` は、TypeScriptのビルド成功後にアプリを起動しなければならない（MUST）。ランチャーはWindowsのPowerShellとLinuxで共通のNode.js子プロセスAPIを使い、Unix専用のシェル操作に依存してはならない（MUST NOT）。

#### Scenario: ビルドが失敗する

- **WHEN** 起動ランチャー内のTypeScriptコンパイルが失敗する
- **THEN** アプリは起動せず、ランチャーは終了コード `1` を設定する

### Requirement: 終了操作と通信停止

アプリは `SIGINT`、`SIGTERM`、`SIGBREAK` を受けると、全URLの取得処理とOBS接続の停止を一度だけ実行し、正常終了の終了コードを設定しなければならない（MUST）。停止後に再接続や取得のタイマーを作ってはならない（MUST NOT）。アプリは通信終了を待ちつつ、ハンドルが残る場合に備え500ミリ秒後の終了処理を用意しなければならない（MUST）。

#### Scenario: 終了シグナルが重なる

- **WHEN** 終了処理の開始後にもう一度終了シグナルを受ける
- **THEN** 停止処理を重複実行しない
- **AND** 取得とOBSの再接続を再開しない

#### Scenario: pnpm経由で中断する

- **WHEN** 利用者が `pnpm start` で起動したアプリを `Ctrl+C` で停止する
- **THEN** アプリは通信停止処理を実行する
- **AND** pnpm自身が表示することのある `ELIFECYCLE` は、アプリの終了失敗とは区別して扱う
