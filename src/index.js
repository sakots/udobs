import { parseConfig, toObsClientOptions, helpText } from './config.js';
import { ObsClient } from './obs.js';

try {
  process.loadEnvFile('.env');
} catch (error) {
  if (error.code !== 'ENOENT') {
    console.error(`.env を読み込めません: ${error.message}`);
    process.exit(1);
  }
}

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(helpText);
  process.exit(0);
}

let config;
try {
  config = parseConfig(process.argv.slice(2));
} catch (error) {
  console.error(`設定エラー: ${error.message}`);
  console.error('\n' + helpText);
  process.exit(1);
}

const obs = new ObsClient(toObsClientOptions(config));
obs.connect();

let yncSocket;
let yncReconnectTimer;
function connectYnc() {
  clearTimeout(yncReconnectTimer);
  try {
    yncSocket = new WebSocket(config.yncUrl);
  } catch (error) {
    console.error(`UDトーク入力URLが不正です: ${JSON.stringify(config.yncUrl)} (${error.message})`);
    yncReconnectTimer = setTimeout(connectYnc, config.reconnectMs);
    return;
  }
  yncSocket.addEventListener('open', () => console.info(`UDトーク入力に接続しました: ${config.yncUrl}`));
  yncSocket.addEventListener('message', ({ data }) => {
    const text = String(data).trim();
    if (!text) return;
    obs.setText(text);
    console.info(`字幕を更新: ${text}`);
  });
  yncSocket.addEventListener('close', () => {
    console.warn(`UDトーク入力との接続が切れました。${config.reconnectMs}ms後に再接続します。`);
    yncReconnectTimer = setTimeout(connectYnc, config.reconnectMs);
  });
  yncSocket.addEventListener('error', () => {});
}
connectYnc();

function shutdown() {
  clearTimeout(yncReconnectTimer);
  yncSocket?.close();
  console.info('終了しました。');
  process.exit(0);
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
