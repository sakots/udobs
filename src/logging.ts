import { appendFileSync, closeSync, mkdirSync, openSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { Writable } from 'node:stream';

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
    // 標準出力・標準エラーを保存しつつ、元の画面出力もそのまま呼び出す。
    return function (...args: Parameters<Writable['write']>) {
      if (!failed) {
        try {
          const [chunk, encoding] = args;
          const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString(typeof encoding === 'string' ? encoding : 'utf8');
          const timestamp = new Date().toISOString();
          const lines = text.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');
          appendFileSync(fd, lines.map(line => `[${timestamp}] [${level}] ${line}\n`).join(''), 'utf8');
        } catch {
          // 保存失敗を繰り返し出力せず、画面へのログだけは継続する。
          failed = true;
          originalErr.call(stderr, 'ログファイルへの書き込みに失敗しました。以後は画面への出力だけを続けます。\n', 'utf8');
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
