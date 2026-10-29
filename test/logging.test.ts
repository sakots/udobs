import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { Console } from 'node:console';
import { finished } from 'node:stream/promises';
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

test('端末だけ詳細を省略し、字幕・状態・警告と保存ログの全内容を維持する', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'udobs-compact-'));
  const file = join(directory, 'test.log');
  let output = '';
  let errors = '';
  const stdout = new Writable({ write(chunk, _encoding, callback) { output += chunk.toString(); callback(); } });
  const stderr = new Writable({ write(chunk, _encoding, callback) { errors += chunk.toString(); callback(); } });
  const close = saveOutputToFile(file, stdout, stderr);
  t.after(() => { close(); rmSync(directory, { recursive: true, force: true }); });
  const visible = [
    '字幕を送信待ちに登録: 理由=新規発話, 変更=現在字幕, 現在字幕="架空の字幕"',
    '[Web公開2] UDトークWeb公開に接続しました。',
    'OBSとの接続が復旧しました。',
    '終了処理を開始します。',
  ];
  const details = [
    'OBS更新送信: 要求=example-1, ソース数=2',
    'OBS更新確認: 要求=example-1, ソース数=2',
    'UDトーク接続診断: 処理=example, TCP=成立',
    '[Web公開2] UDトークソケット終了: 接続#1',
    '[Web公開2] UDトークソケット正常終了集計: 件数=1',
    '[Web公開2] UDトーク会話の再試行待ち: 連続失敗=1回',
  ];
  const warning = '[Web公開2] UDトーク通信失敗: 架空の接続エラー\n';
  const error = 'OBS更新エラー: 架空の応答エラー\n';
  for (const text of [...visible, ...details]) stdout.write(Buffer.from(`${text}\n`));
  stderr.write(warning);
  stderr.write(error);
  // 標準エラーは、詳細と同じ書式の内容でも省略しない。
  stderr.write(`${details[0]}\n`);
  assert.equal(output, `${visible.join('\n')}\n`);
  assert.equal(errors, warning + error + `${details[0]}\n`);
  const saved = readFileSync(file, 'utf8').replace(/^\[[^\]]+\] \[(?:INFO|WARN\/ERROR)\] /gm, '');
  assert.equal(saved, `${[...visible, ...details].join('\n')}\n` + errors);
});

test('非表示ログでも書き込み順序・コールバック・バックプレッシャーを維持する', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'udobs-compact-stream-'));
  let output = '';
  const callbacks: string[] = [];
  const stdout = new Writable({
    highWaterMark: 1,
    write(chunk, _encoding, callback) { output += chunk.toString(); setImmediate(callback); },
  });
  const stderr = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  const close = saveOutputToFile(join(directory, 'test.log'), stdout, stderr);
  t.after(() => { close(); rmSync(directory, { recursive: true, force: true }); });
  assert.equal(stdout.write('前\n', () => callbacks.push('前')), false);
  assert.equal(stdout.write('OBS更新送信: 要求=example-1\n', 'utf8', () => callbacks.push('非表示')), false);
  stdout.write('後\n', () => callbacks.push('後'));
  // ヘルプなどの複数行出力や、分割された書き込みは変更しない。
  stdout.write('使い方\nOBS更新確認: 複数行内の文字列\n');
  stdout.write('OBS更新送信: 分割');
  stdout.write('された出力\n');
  stdout.write('本文の続き: ');
  stdout.write('');
  stdout.write('OBS更新確認: 行の途中から始まる文字列\n');
  stdout.write('[Web公開1] UDトーク接続診断: CRLFの詳細\r\n');
  stdout.end();
  await finished(stdout);
  assert.deepEqual(callbacks, ['前', '非表示', '後']);
  assert.equal(output, '前\n後\n使い方\nOBS更新確認: 複数行内の文字列\nOBS更新送信: 分割された出力\n本文の続き: OBS更新確認: 行の途中から始まる文字列\n');
});

test('保存失敗時は一度だけ警告し、失敗した行から詳細も端末に残す', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'udobs-compact-failure-'));
  const file = join(directory, 'test.log');
  let output = '';
  let errors = '';
  const stdout = new Writable({ write(chunk, _encoding, callback) { output += chunk.toString(); callback(); } });
  const stderr = new Writable({ write(chunk, _encoding, callback) { errors += chunk.toString(); callback(); } });
  const close = saveOutputToFile(file, stdout, stderr);
  const append = t.mock.method(fs, 'appendFileSync', () => { throw new Error('fictional disk full'); });
  syncBuiltinESMExports();
  t.after(() => {
    append.mock.restore();
    syncBuiltinESMExports();
    close();
    rmSync(directory, { recursive: true, force: true });
  });
  const details = 'OBS更新送信: 要求=example-1\nOBS更新確認: 要求=example-1\n';
  for (const line of details.trimEnd().split('\n')) stdout.write(`${line}\n`);
  assert.equal(output, details);
  assert.equal(errors.split('\n').filter(Boolean).length, 1);
  assert.equal(readFileSync(file, 'utf8'), '');
});
