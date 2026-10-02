import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { Console } from 'node:console';
import test from 'node:test';
import { saveOutputToFile } from '../src/logging.js';

test('標準出力と標準エラーを画面に残しながら日時付きで保存する', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'udobs-logging-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'logs', 'test.log');
  let output = '';
  let errors = '';
  const stdout = new Writable({ write(chunk, _encoding, callback) { output += chunk.toString(); callback(); } });
  const stderr = new Writable({ write(chunk, _encoding, callback) { errors += chunk.toString(); callback(); } });
  const originalOut = stdout.write;
  const originalErr = stderr.write;
  const close = saveOutputToFile(file, stdout, stderr);
  t.after(close);
  const console = new Console({ stdout, stderr });
  console.log('字幕を更新: 架空の発話\n二行目');
  console.info('接続しました');
  console.warn('接続が切れました');
  console.error('テストエラー');
  console.debug('デバッグ');
  stderr.write(Buffer.from('直接出力\n'));
  const saved = readFileSync(file, 'utf8'); // 終了前でもすべて書き込まれている
  assert.match(saved, /\[\d{4}-\d{2}-\d{2}T[^\]]+Z\] \[INFO\] 字幕を更新: 架空の発話/);
  for (const text of ['二行目', '接続しました', '接続が切れました', 'テストエラー', 'デバッグ', '直接出力']) assert.ok(saved.includes(text));
  assert.equal(output, '字幕を更新: 架空の発話\n二行目\n接続しました\nデバッグ\n');
  assert.equal(errors, '接続が切れました\nテストエラー\n直接出力\n');
  close();
  close();
  assert.equal(stdout.write, originalOut);
  assert.equal(stderr.write, originalErr);
  stdout.write('保存終了後\n');
  assert.equal(readFileSync(file, 'utf8'), saved);
});

test('同じファイルを開いても既存ログを上書きしない', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'udobs-logging-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'test.log');
  const stdout = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  const stderr = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  for (const text of ['初回', '再起動']) {
    const close = saveOutputToFile(file, stdout, stderr);
    try { stdout.write(`${text}\n`); } finally { close(); }
  }
  const saved = readFileSync(file, 'utf8');
  assert.ok(saved.includes('初回'));
  assert.ok(saved.includes('再起動'));
});
