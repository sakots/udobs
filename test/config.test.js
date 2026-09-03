import test from 'node:test';
import assert from 'node:assert/strict';
import { parseConfig } from '../src/config.js';
import { createObsAuthentication } from '../src/obs.js';

test('コマンドライン引数を設定へ反映する', () => {
  const config = parseConfig([
    '--input-name', '字幕', '--obs-url', 'ws://localhost:4455', '--reconnect-ms', '500',
  ], {});
  assert.equal(config.inputName, '字幕');
  assert.equal(config.reconnectMs, 500);
});

test('OBSの認証値はv5仕様の二段階SHA-256になる', () => {
  assert.equal(
    createObsAuthentication('password', 'salt', 'challenge'),
    'zTM5ki6L2vVvBQiTG9ckH1Lh64AbnCf6XZ226UmnkIA=',
  );
});

test('テキストソース名を要求する', () => {
  assert.throws(() => parseConfig([], {}), /テキストソース名/);
});
