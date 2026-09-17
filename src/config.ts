export interface Config {
  obsUrl: string;
  obsPassword: string;
  inputName: string;
  previousInputName: string;
  reconnectMs: number;
  udtalkPublicUrl: string;
  pollMs: number;
  maxCharsPerLine: number;
}

export interface ObsClientOptions extends Config {
  url: string;
  password: string;
}

const defaults: Config = {
  obsUrl: 'ws://127.0.0.1:4455', obsPassword: '', inputName: '', previousInputName: '',
  reconnectMs: 2000, udtalkPublicUrl: '', pollMs: 1000, maxCharsPerLine: 24,
};

const optionToKey: Record<string, keyof Config> = {
  '--obs-url': 'obsUrl', '--obs-password': 'obsPassword', '--input-name': 'inputName',
  '--previous-input-name': 'previousInputName', '--reconnect-ms': 'reconnectMs',
  '--udtalk-url': 'udtalkPublicUrl', '--poll-ms': 'pollMs', '--max-chars-per-line': 'maxCharsPerLine',
};

const numericKeys = new Set<keyof Config>(['reconnectMs', 'pollMs', 'maxCharsPerLine']);

export function parseConfig(argv: string[], env: NodeJS.ProcessEnv = process.env): Config {
  const config: Config = {
    ...defaults,
    obsUrl: env.OBS_URL || defaults.obsUrl,
    obsPassword: env.OBS_PASSWORD || defaults.obsPassword,
    inputName: env.OBS_INPUT_NAME || defaults.inputName,
    previousInputName: env.OBS_PREVIOUS_INPUT_NAME || defaults.previousInputName,
    reconnectMs: Number(env.RECONNECT_MS || defaults.reconnectMs),
    udtalkPublicUrl: env.UDTALK_PUBLIC_URL || defaults.udtalkPublicUrl,
    pollMs: Number(env.POLL_MS || defaults.pollMs),
    maxCharsPerLine: Number(env.MAX_CHARS_PER_LINE || defaults.maxCharsPerLine),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const key = optionToKey[argv[index]];
    if (!key) continue;
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`${argv[index]} には値が必要です。`);
    if (numericKeys.has(key)) config[key] = Number(value) as never;
    else config[key] = value.trim() as never;
    index += 1;
  }
  config.obsUrl = config.obsUrl.trim();
  config.inputName = config.inputName.trim();
  config.previousInputName = config.previousInputName.trim();
  config.udtalkPublicUrl = config.udtalkPublicUrl.trim();
  if (!config.inputName) throw new Error('OBSのテキストソース名を --input-name または OBS_INPUT_NAME で指定してください。');
  if (config.previousInputName === config.inputName) throw new Error('OBS_PREVIOUS_INPUT_NAME は OBS_INPUT_NAME と異なるテキストソース名にしてください。');
  if (!Number.isFinite(config.reconnectMs) || config.reconnectMs < 0) throw new Error('reconnect-ms は0以上の数値にしてください。');
  if (!config.udtalkPublicUrl) throw new Error('UDトークのWeb公開URLを UDTALK_PUBLIC_URL または --udtalk-url で指定してください。');
  try {
    const url = new URL(config.udtalkPublicUrl);
    if (url.protocol !== 'https:' || url.hostname !== 'live.udtalk.jp' || !/^\/[0-9a-z]{64}$/.test(url.pathname)) throw new Error();
  } catch { throw new Error('UDTALK_PUBLIC_URL は https://live.udtalk.jp/ で始まるWeb公開URLにしてください。'); }
  if (!Number.isFinite(config.pollMs) || config.pollMs < 250) throw new Error('poll-ms は250以上のミリ秒にしてください。');
  if (!Number.isInteger(config.maxCharsPerLine) || config.maxCharsPerLine < 1) throw new Error('max-chars-per-line は1以上の整数にしてください。');
  try {
    const url = new URL(config.obsUrl);
    if (!['ws:', 'wss:'].includes(url.protocol)) throw new Error();
  } catch { throw new Error(`OBS URL（${JSON.stringify(config.obsUrl)}）は ws:// または wss:// のURLにしてください。`); }
  return config;
}

export function toObsClientOptions(config: Config): ObsClientOptions {
  return { ...config, url: config.obsUrl, password: config.obsPassword };
}

export const helpText = `UDトーク → OBS テキスト ブリッジ

使い方:
  npm start -- --input-name 字幕

オプション:
  --input-name <名前>       更新するOBSテキストソース名（必須）
  --previous-input-name <名前>  ひとつ前の発話を表示するOBSテキストソース名
  --obs-password <パスワード>
  --obs-url <URL>           既定: ws://127.0.0.1:4455
  --udtalk-url <URL>        UDトークのWeb公開URL（必須）
  --poll-ms <ミリ秒>        会話の取得間隔。既定: 1000
  --max-chars-per-line <数>  字幕を改行する文字数。既定: 24
  --reconnect-ms <ミリ秒>   既定: 2000

同名の環境変数（OBS_INPUT_NAME, OBS_PREVIOUS_INPUT_NAME, OBS_PASSWORD, OBS_URL, UDTALK_PUBLIC_URL, POLL_MS, MAX_CHARS_PER_LINE, RECONNECT_MS）も使えます。`;
