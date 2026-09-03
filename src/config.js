const defaults = {
  yncUrl: 'ws://127.0.0.1:11901/textonly',
  obsUrl: 'ws://127.0.0.1:4455',
  obsPassword: '',
  inputName: '',
  reconnectMs: 2000,
};

const optionToKey = {
  '--ync-url': 'yncUrl',
  '--obs-url': 'obsUrl',
  '--obs-password': 'obsPassword',
  '--input-name': 'inputName',
  '--reconnect-ms': 'reconnectMs',
};

export function parseConfig(argv, env = process.env) {
  const config = {
    ...defaults,
    yncUrl: env.YNC_URL || defaults.yncUrl,
    obsUrl: env.OBS_URL || defaults.obsUrl,
    obsPassword: env.OBS_PASSWORD || defaults.obsPassword,
    inputName: env.OBS_INPUT_NAME || defaults.inputName,
    reconnectMs: Number(env.RECONNECT_MS || defaults.reconnectMs),
  };

  for (let index = 0; index < argv.length; index += 1) {
    const key = optionToKey[argv[index]];
    if (!key) continue;
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`${argv[index]} には値が必要です。`);
    }
    config[key] = key === 'reconnectMs' ? Number(value) : value.trim();
    index += 1;
  }

  config.yncUrl = config.yncUrl.trim();
  config.obsUrl = config.obsUrl.trim();
  config.inputName = config.inputName.trim();

  if (!config.inputName) {
    throw new Error('OBSのテキストソース名を --input-name または OBS_INPUT_NAME で指定してください。');
  }
  if (!Number.isFinite(config.reconnectMs) || config.reconnectMs < 0) {
    throw new Error('reconnect-ms は0以上の数値にしてください。');
  }
  for (const [name, value] of [['YNC URL', config.yncUrl], ['OBS URL', config.obsUrl]]) {
    try {
      const url = new URL(value);
      if (!['ws:', 'wss:'].includes(url.protocol)) throw new Error();
    } catch {
      throw new Error(`${name}（${JSON.stringify(value)}）は ws:// または wss:// のURLにしてください。`);
    }
  }
  return config;
}

export const helpText = `UDトーク → OBS テキスト ブリッジ

使い方:
  npm start -- --input-name 字幕

オプション:
  --input-name <名前>       更新するOBSテキストソース名（必須）
  --obs-password <パスワード>
  --obs-url <URL>           既定: ws://127.0.0.1:4455
  --ync-url <URL>           既定: ws://127.0.0.1:11901/textonly
  --reconnect-ms <ミリ秒>   既定: 2000

同名の環境変数（OBS_INPUT_NAME, OBS_PASSWORD, OBS_URL, YNC_URL, RECONNECT_MS）も使えます。`;
