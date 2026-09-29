import { helpText, parseConfig, toObsClientOptions } from './config.js';
import type { Config } from './config.js';
import { ObsClient } from './obs.js';
import { wrapText } from './text-wrap.js';
import { UdtalkWebClient } from './udtalk-web-client.js';

try { process.loadEnvFile('.env'); }
catch (error: unknown) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
    console.error(`.env を読み込めません: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
if (process.argv.includes('--help') || process.argv.includes('-h')) { console.log(helpText); process.exit(0); }

let config: Config;
try { config = parseConfig(process.argv.slice(2)); }
catch (error: unknown) {
  console.error(`設定エラー: ${error instanceof Error ? error.message : String(error)}`);
  console.error(`\n${helpText}`); process.exit(1);
}

const obs = new ObsClient(toObsClientOptions(config));
let previousCaption = '';
const udtalk = new UdtalkWebClient({
  url: config.udtalkPublicUrl,
  pollMs: config.pollMs,
  onText: (text) => {
    const caption = wrapText(text, config.maxCharsPerLine);
    if (caption === previousCaption) return;
    if (config.previousInputName) obs.setTextForInput(config.previousInputName, previousCaption);
    obs.setText(caption);
    previousCaption = caption;
    console.info(`字幕を更新: ${caption}`);
  },
});
obs.connect();
void udtalk.start();

let shuttingDown = false;
function shutdown(): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.info('終了処理を開始します。');
  udtalk.stop();
  obs.stop();
  process.exitCode = 0;
  const forceExit = setTimeout(() => process.exit(0), 500);
  forceExit.unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('SIGBREAK', shutdown);
