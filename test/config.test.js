import test from 'node:test';
import assert from 'node:assert/strict';
import { parseConfig, toObsClientOptions } from '../src/config.js';
import { createObsAuthentication } from '../src/obs.js';

test('コマンドライン引数を設定へ反映する', () => {
  const config = parseConfig([
    '--input-name', '字幕', '--obs-url', 'ws://localhost:4455', '--reconnect-ms', '500',
    '--input-port', '3123',
  ], {});
  assert.equal(config.inputName, '字幕');
  assert.equal(config.reconnectMs, 500);
  assert.equal(config.inputPort, 3123);
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

test('OBS設定をクライアントが使うキー名へ変換する', () => {
  const options = toObsClientOptions({ obsUrl: 'ws://example.test:4455', obsPassword: 'secret' });
  assert.equal(options.url, 'ws://example.test:4455');
  assert.equal(options.password, 'secret');
});
