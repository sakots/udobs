import { appendFileSync, closeSync, mkdirSync, openSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { Writable } from 'node:stream';

// 保存する本文には触れず、端末では既知の正常・診断ログだけを省略する。
const terminalDetail = /^(?:\[Web公開\d+\] )?(?:OBS更新(?:送信|確認)|UDトーク(?:接続診断|ソケット終了|ソケット正常終了集計|会話の再試行待ち)): /;

// 同期書き込みにして、Ctrl+C直前のログもバッファに残さない。
export function saveOutputToFile(
  filePath: string,
  stdout: Writable = process.stdout,
  stderr: Writable = process.stderr,
): () => void {
  mkdirSync(dirname(filePath), { recursive: true });
  const fd = openSync(filePath, 'a', 0o600);
  let failed = false;
  const originalOut = stdout.write;
  const originalErr = stderr.write;

  function capture(stream: Writable, original: Writable['write'], level: string): Writable['write'] {
    let atLineStart = true;
    // 先に元の内容を保存し、保存できた標準出力だけ端末用に簡略化する。
    return function (...args: Parameters<Writable['write']>) {
      let text = '';
      if (!failed) {
        try {
          const [chunk, encoding] = args;
          text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString(typeof encoding === 'string' ? encoding : 'utf8');
          const timestamp = new Date().toISOString();
          const lines = text.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');
          appendFileSync(fd, lines.map(line => `[${timestamp}] [${level}] ${line}\n`).join(''), 'utf8');
        } catch {
          // 保存失敗を繰り返し出力せず、画面へのログだけは継続する。
          failed = true;
          originalErr.call(stderr, 'ログファイルへの書き込みに失敗しました。以後は画面への出力だけを続けます。\n', 'utf8');
        }
      }
      if (!failed && level === 'INFO') {
        const completeLine = atLineStart && text.indexOf('\n') === text.length - 1;
        if (text) atLineStart = text.endsWith('\n');
        if (completeLine && terminalDetail.test(text)) {
          // 空の書き込みで順序・コールバック・戻り値を元のstreamに任せる。
          args[0] = '';
        }
      }
      return original.apply(stream, args);
    } as Writable['write'];
  }

  stdout.write = capture(stdout, originalOut, 'INFO');
  stderr.write = capture(stderr, originalErr, 'WARN/ERROR');
  let closed = false;
  return () => {
    if (closed) return;
    closed = true;
    stdout.write = originalOut;
    stderr.write = originalErr;
    closeSync(fd);
  };
}

export function startLogging(): string {
  // Windowsで使えないコロンを避け、起動ごとに別のログファイルを作る。
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filePath = resolve(join('logs', `udobs-${timestamp}-${process.pid}.log`));
  const close = saveOutputToFile(filePath);
  process.once('exit', close);
  return filePath;
}
