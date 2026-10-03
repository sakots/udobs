import assert from 'node:assert/strict';
import test from 'node:test';
import { parseConfig, toObsClientOptions } from '../src/config.js';
import { createObsAuthentication } from '../src/obs.js';

test('コマンドライン引数を設定へ反映する', () => {
  const config = parseConfig([
    '--input-name', '字幕', '--obs-url', 'ws://localhost:4455', '--reconnect-ms', '500',
    '--previous-input-name', '字幕_ひとつ前',
    '--udtalk-url', 'https://live.udtalk.jp/808d4ebbbea1b85b855b0accd09562ccb531a9b52c8079c95c7295cd3c7cb265', '--poll-ms', '500',
  ], {});
  assert.equal(config.inputName, '字幕'); assert.equal(config.reconnectMs, 500);
  assert.equal(config.previousInputName, '字幕_ひとつ前'); assert.equal(config.pollMs, 500);
});
test('OBSの認証値はv5仕様の二段階SHA-256になる', () => assert.equal(createObsAuthentication('password', 'salt', 'challenge'), 'zTM5ki6L2vVvBQiTG9ckH1Lh64AbnCf6XZ226UmnkIA='));
test('テキストソース名を要求する', () => assert.throws(() => parseConfig([], {}), /テキストソース名/));
test('OBS設定をクライアントが使うキー名へ変換する', () => {
  const options = toObsClientOptions({ obsUrl: 'ws://example.test:4455', obsPassword: 'secret' } as never);
  assert.equal(options.url, 'ws://example.test:4455'); assert.equal(options.password, 'secret');
});

test('UDトークの待ち時間は環境変数とCLIで設定でき、範囲を検証する', () => {
  const env = { OBS_INPUT_NAME: '字幕', UDTALK_PUBLIC_URL: `https://live.udtalk.jp/${'a'.repeat(64)}` };
  const defaults = parseConfig([], env);
  assert.equal(defaults.udtalkRequestTimeoutMs, 5000);
  assert.equal(defaults.udtalkRetryMaxMs, 10000);
  const config = parseConfig(['--udtalk-request-timeout-ms', '3000', '--udtalk-retry-max-ms', '8000'],
    { ...env, UDTALK_REQUEST_TIMEOUT_MS: '6000', UDTALK_RETRY_MAX_MS: '12000' });
  assert.equal(config.udtalkRequestTimeoutMs, 3000);
  assert.equal(config.udtalkRetryMaxMs, 8000);
  assert.equal(parseConfig([], { ...env, UDTALK_REQUEST_TIMEOUT_MS: '6000' }).udtalkRequestTimeoutMs, 6000);
  for (const value of ['0', '-1', 'NaN', '1.5', '4294967296']) {
    assert.throws(() => parseConfig(['--udtalk-request-timeout-ms', value], env), /udtalk-request-timeout-ms/);
  }
  assert.throws(() => parseConfig(['--udtalk-retry-max-ms', '999'], env), /udtalk-retry-max-ms/);
});
