import { helpText, parseConfig, toObsClientOptions } from './config.js';
import type { Config } from './config.js';
import { ObsClient } from './obs.js';
import { wrapText } from './text-wrap.js';
import { UdtalkWebClient } from './udtalk-web-client.js';
import { CaptionHistory } from './caption-history.js';
import { startLogging } from './logging.js';

// 設定読込より先にログ保存を始め、起動時のエラーも残す。
try { console.info(`ログ保存先: ${startLogging()}`); }
catch (error: unknown) {
  console.error(`ログ保存を開始できません: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

// .envがない場合は、環境変数とCLI引数だけで起動できる。
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
const history = new CaptionHistory();
const udtalk = new UdtalkWebClient({
  url: config.udtalkPublicUrl,
  pollMs: config.pollMs,
  onText: (text, utterance) => {
    // 表示用に改行してから履歴を更新し、変化した字幕ペアだけを送る。
    const caption = wrapText(text, config.maxCharsPerLine);
    const pair = history.update(caption, utterance);
    if (!pair) return;
    obs.setCaptionPair(pair.current, config.previousInputName, pair.previous);
    console.info(`字幕を更新: ${pair.current}`);
  },
});
obs.connect();
void udtalk.start();

let shuttingDown = false;
function shutdown(): void {
  // シグナルが重なっても、停止処理は一度だけ実行する。
  if (shuttingDown) return;
  shuttingDown = true;
  console.info('終了処理を開始します。');
  udtalk.stop();
  obs.stop();
  process.exitCode = 0;
  // 通信の終了を待ちつつ、ハンドルが残った場合は終了を打ち切る。
  const forceExit = setTimeout(() => process.exit(0), 500);
  forceExit.unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('SIGBREAK', shutdown);
