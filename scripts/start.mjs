import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

function run(command, args) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolveRun();
      else reject(new Error(`終了コード: ${code ?? signal ?? 'unknown'}`));
    });
  });
}

let app;
let stopping = false;

function shutdown() {
  stopping = true;
  // 同じコンソールの子プロセスにも Ctrl+C は配信されるため、ここでは終了を待つ。
  // 二重送信するとWindowsで強制終了になり、アプリ側の終了処理が走らない。
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('SIGBREAK', shutdown);

try {
  await run(process.execPath, [resolve('node_modules/typescript/bin/tsc')]);
  app = spawn(process.execPath, [resolve('dist/src/index.js')], { stdio: 'inherit' });
  app.once('error', (error) => {
    console.error(`アプリを起動できません: ${error.message}`);
    process.exitCode = 1;
  });
  app.once('exit', (code, signal) => {
    process.exitCode = stopping ? 0 : (code ?? (signal ? 1 : 0));
  });
} catch (error) {
  console.error(`起動準備に失敗しました: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
