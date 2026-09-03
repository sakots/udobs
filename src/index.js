import { parseConfig, toObsClientOptions, helpText } from './config.js';
import { ObsClient } from './obs.js';
import { UdtalkWebClient } from './udtalk-web-client.js';

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
const udtalk = new UdtalkWebClient({
  url: config.udtalkPublicUrl,
  pollMs: config.pollMs,
  onText: (text) => { obs.setText(text); console.info(`字幕を更新: ${text}`); },
});
udtalk.start();

function shutdown() {
  udtalk.stop();
  console.info('終了しました。');
  process.exit(0);
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
