import { parsePublicUrl } from './udtalk-web-client.js';

// アプリ全体の設定と、OBSクライアントが受け取る設定を分ける。
export interface Config {
  obsUrl: string;
  obsPassword: string;
  inputName: string;
  previousInputName: string;
  reconnectMs: number;
  udtalkPublicUrls: string[];
  udtalkPasscode: string;
  // 接続するURLをキーとし、個別指定と共通値を解決済みのパスコードを保持する。
  udtalkPasscodes: Record<string, string>;
  pollMs: number;
  udtalkRequestTimeoutMs: number;
  udtalkRetryMaxMs: number;
  maxCharsPerLine: number;
}

export interface ObsClientOptions {
  url: string;
  password: string;
  inputName: string;
  reconnectMs: number;
}

const defaults: Config = {
  obsUrl: 'ws://127.0.0.1:4455', obsPassword: '', inputName: '', previousInputName: '',
  reconnectMs: 2000, udtalkPublicUrls: [], pollMs: 1000, maxCharsPerLine: 24,
  udtalkPasscode: '', udtalkPasscodes: {},
  udtalkRequestTimeoutMs: 5000, udtalkRetryMaxMs: 10000,
};

const optionToKey: Record<string, keyof Config> = {
  '--obs-url': 'obsUrl', '--obs-password': 'obsPassword', '--input-name': 'inputName',
  '--previous-input-name': 'previousInputName', '--reconnect-ms': 'reconnectMs',
  '--udtalk-url': 'udtalkPublicUrls', '--poll-ms': 'pollMs', '--max-chars-per-line': 'maxCharsPerLine',
  '--udtalk-passcode': 'udtalkPasscode', '--udtalk-passcodes': 'udtalkPasscodes',
  '--udtalk-request-timeout-ms': 'udtalkRequestTimeoutMs', '--udtalk-retry-max-ms': 'udtalkRetryMaxMs',
};

const numericKeys = new Set<keyof Config>(['reconnectMs', 'pollMs', 'maxCharsPerLine', 'udtalkRequestTimeoutMs', 'udtalkRetryMaxMs']);

export function parseConfig(argv: string[], env: NodeJS.ProcessEnv = process.env): Config {
  // 既定値 → 環境変数 → CLI引数の順に上書きする。
  const config: Config = {
    ...defaults,
    obsUrl: env.OBS_URL || defaults.obsUrl,
    obsPassword: env.OBS_PASSWORD || defaults.obsPassword,
    inputName: env.OBS_INPUT_NAME || defaults.inputName,
    previousInputName: env.OBS_PREVIOUS_INPUT_NAME || defaults.previousInputName,
    reconnectMs: Number(env.RECONNECT_MS || defaults.reconnectMs),
    udtalkPublicUrls: (env.UDTALK_PUBLIC_URL || '').split(/[,\r\n]+/).map(url => url.trim()).filter(Boolean),
    udtalkPasscode: env.UDTALK_PASSCODE || defaults.udtalkPasscode,
    udtalkPasscodes: {},
    pollMs: Number(env.POLL_MS || defaults.pollMs),
    udtalkRequestTimeoutMs: Number(env.UDTALK_REQUEST_TIMEOUT_MS || defaults.udtalkRequestTimeoutMs),
    udtalkRetryMaxMs: Number(env.UDTALK_RETRY_MAX_MS || defaults.udtalkRetryMaxMs),
    maxCharsPerLine: Number(env.MAX_CHARS_PER_LINE || defaults.maxCharsPerLine),
  };
  let cliUrls: string[] | undefined;
  let passcodesJson = env.UDTALK_PASSCODES || '{}';
  for (let index = 0; index < argv.length; index += 1) {
    const key = optionToKey[argv[index]];
    if (!key) continue;
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`${argv[index]} には値が必要です。`);
    if (key === 'udtalkPublicUrls') (cliUrls ??= []).push(value.trim());
    else if (key === 'udtalkPasscodes') passcodesJson = value;
    else if (numericKeys.has(key)) config[key] = Number(value) as never;
    else config[key] = (key === 'udtalkPasscode' ? value : value.trim()) as never;
    index += 1;
  }
  // 接続前に必須項目・URL・数値の範囲を検証する。
  config.obsUrl = config.obsUrl.trim();
  config.inputName = config.inputName.trim();
  config.previousInputName = config.previousInputName.trim();
  config.udtalkPublicUrls = cliUrls ?? config.udtalkPublicUrls;
  if (!config.inputName) throw new Error('OBSのテキストソース名を --input-name または OBS_INPUT_NAME で指定してください。');
  if (config.previousInputName === config.inputName) throw new Error('OBS_PREVIOUS_INPUT_NAME は OBS_INPUT_NAME と異なるテキストソース名にしてください。');
  if (!Number.isFinite(config.reconnectMs) || config.reconnectMs < 0) throw new Error('reconnect-ms は0以上の数値にしてください。');
  if (!config.udtalkPublicUrls.length) throw new Error('UDトークのWeb公開URLを UDTALK_PUBLIC_URL または --udtalk-url で指定してください。');
  const urlsByPublicId = new Map<string, string>();
  for (const value of config.udtalkPublicUrls) {
    try {
      const { publicId } = parsePublicUrl(value);
      if (!urlsByPublicId.has(publicId)) urlsByPublicId.set(publicId, value);
    } catch { throw new Error('UDTALK_PUBLIC_URL は https://live.udtalk.jp/ で始まるWeb公開URLにしてください。'); }
  }
  config.udtalkPublicUrls = [...urlsByPublicId.values()];
  const passcodesByPublicId = parsePasscodes(passcodesJson);
  for (const [publicId, url] of urlsByPublicId) {
    config.udtalkPasscodes[url] = passcodesByPublicId.get(publicId) ?? config.udtalkPasscode;
  }
  if (!Number.isFinite(config.pollMs) || config.pollMs < 250) throw new Error('poll-ms は250以上のミリ秒にしてください。');
  if (!Number.isInteger(config.udtalkRequestTimeoutMs) || config.udtalkRequestTimeoutMs < 1 || config.udtalkRequestTimeoutMs > 2147483647) throw new Error('udtalk-request-timeout-ms は1〜2147483647の整数にしてください。');
  if (!Number.isInteger(config.udtalkRetryMaxMs) || config.udtalkRetryMaxMs < config.pollMs || config.udtalkRetryMaxMs > 2147483647) throw new Error('udtalk-retry-max-ms はpoll-ms以上、2147483647以下の整数にしてください。');
  if (!Number.isInteger(config.maxCharsPerLine) || config.maxCharsPerLine < 1) throw new Error('max-chars-per-line は1以上の整数にしてください。');
  try {
    const url = new URL(config.obsUrl);
    if (!['ws:', 'wss:'].includes(url.protocol)) throw new Error();
  } catch { throw new Error(`OBS URL（${JSON.stringify(config.obsUrl)}）は ws:// または wss:// のURLにしてください。`); }
  return config;
}

function parsePasscodes(value: string): Map<string, string> {
  try {
    const data: unknown = JSON.parse(value);
    if (data === null || typeof data !== 'object' || Array.isArray(data)) throw new Error();
    const passcodes = new Map<string, string>();
    for (const [url, passcode] of Object.entries(data)) {
      if (typeof passcode !== 'string') throw new Error();
      const { publicId } = parsePublicUrl(url);
      if (passcodes.has(publicId) && passcodes.get(publicId) !== passcode) throw new Error();
      passcodes.set(publicId, passcode);
    }
    return passcodes;
  } catch {
    // JSON.parseの例外には秘密値が含まれ得るため、入力も内部原因も公開しない。
    throw new Error('UDTALK_PASSCODES はWeb公開URLをキー、パスコード文字列を値とするJSONオブジェクトにしてください。同じ公開IDには同じ値を指定してください。');
  }
}

export function toObsClientOptions(config: Config): ObsClientOptions {
  // UDトークのパスコードなど、OBSに不要な設定は渡さない。
  return { url: config.obsUrl, password: config.obsPassword, inputName: config.inputName, reconnectMs: config.reconnectMs };
}

export const helpText = `UDトーク → OBS テキスト ブリッジ

使い方:
  pnpm start -- --input-name 字幕

オプション:
  --input-name <名前>       更新するOBSテキストソース名（必須）
  --previous-input-name <名前>  ひとつ前の発話を表示するOBSテキストソース名
  --obs-password <パスワード>
  --obs-url <URL>           既定: ws://127.0.0.1:4455
  --udtalk-url <URL>        UDトークのWeb公開URL（必須、複数は繰り返し指定）
  --udtalk-passcode <パスコード>  個別指定がないURLに使う共通値
  --udtalk-passcodes <JSON>  URL別パスコード。例: {"公開URL":"0012"}
  --poll-ms <ミリ秒>        会話の取得間隔。既定: 1000
  --udtalk-request-timeout-ms <ミリ秒>  通信全体の上限。既定: 5000
  --udtalk-retry-max-ms <ミリ秒>  連続失敗時の再試行間隔の上限。既定: 10000
  --max-chars-per-line <数>  字幕を改行する文字数。既定: 24
  --reconnect-ms <ミリ秒>   既定: 2000

同名の環境変数（OBS_INPUT_NAME, OBS_PREVIOUS_INPUT_NAME, OBS_PASSWORD, OBS_URL, UDTALK_PUBLIC_URL, UDTALK_PASSCODE, UDTALK_PASSCODES, POLL_MS, UDTALK_REQUEST_TIMEOUT_MS, UDTALK_RETRY_MAX_MS, MAX_CHARS_PER_LINE, RECONNECT_MS）も使えます。

UDTALK_PUBLIC_URL はカンマ・改行区切りで複数指定できます。
--udtalk-url を指定すると、環境変数のURL一覧全体を置き換えます。
UDTALK_PASSCODES のキーは公開URL、値はパスコード文字列です。個別値を共通値より優先します。
--udtalk-passcodes を指定すると、環境変数の個別設定全体を置き換えます。`;
