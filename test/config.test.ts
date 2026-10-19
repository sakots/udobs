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

test('Web公開パスコードは任意で、CLI優先の文字列として扱う', () => {
  const env = { OBS_INPUT_NAME: '字幕', UDTALK_PUBLIC_URL: `https://live.udtalk.jp/${'a'.repeat(64)}` };
  assert.equal(parseConfig([], env).udtalkPasscode, '');
  assert.equal(parseConfig([], { ...env, UDTALK_PASSCODE: '0012' }).udtalkPasscode, '0012');
  const config = parseConfig(['--udtalk-passcode', ' 00 &+# '], { ...env, UDTALK_PASSCODE: '9999' });
  assert.equal(config.udtalkPasscode, ' 00 &+# ');
  assert.throws(() => parseConfig(['--udtalk-passcode'], env), /値が必要/);
});

test('Web公開URLの単一設定とカンマ・改行区切りの一覧を読み込む', () => {
  const a = `https://live.udtalk.jp/${'a'.repeat(64)}`;
  const b = `https://live.udtalk.jp/${'b'.repeat(64)}`;
  const c = `https://live.udtalk.jp/${'c'.repeat(64)}`;
  assert.deepEqual(parseConfig([], { OBS_INPUT_NAME: '字幕', UDTALK_PUBLIC_URL: a }).udtalkPublicUrls, [a]);
  assert.deepEqual(parseConfig([], {
    OBS_INPUT_NAME: '字幕', UDTALK_PUBLIC_URL: ` ${a}, \r\n ${b}\n${c}, `,
  }).udtalkPublicUrls, [a, b, c]);
});

test('繰り返したCLIのURL指定は環境変数の一覧全体を置き換える', () => {
  const a = `https://live.udtalk.jp/${'a'.repeat(64)}`;
  const b = `https://live.udtalk.jp/${'b'.repeat(64)}`;
  assert.deepEqual(parseConfig(['--udtalk-url', ` ${a} `, '--udtalk-url', b], {
    OBS_INPUT_NAME: '字幕', UDTALK_PUBLIC_URL: 'invalid',
  }).udtalkPublicUrls, [a, b]);
  assert.throws(() => parseConfig(['--udtalk-url', a, '--udtalk-url'], { OBS_INPUT_NAME: '字幕' }), /値が必要/);
});

test('同じ公開IDのURLは先頭だけを保持し、別の公開IDは残す', () => {
  const a = `https://live.udtalk.jp/${'a'.repeat(64)}`;
  const b = `https://live.udtalk.jp/${'b'.repeat(64)}`;
  assert.deepEqual(parseConfig([], {
    OBS_INPUT_NAME: '字幕', UDTALK_PUBLIC_URL: `${a},${b},${a}?viewer=duplicate#fragment`,
  }).udtalkPublicUrls, [a, b]);
});

test('URL一覧全体を検証し、エラーに秘密のURLを含めない', () => {
  const a = `https://live.udtalk.jp/${'a'.repeat(64)}`;
  for (const value of ['', ' , \r\n ', `${a},https://example.test/private`, `${a},not-a-url`]) {
    assert.throws(() => parseConfig([], { OBS_INPUT_NAME: '字幕', UDTALK_PUBLIC_URL: value }), error =>
      error instanceof Error && /Web公開URL/.test(error.message)
      && !error.message.includes(a) && !error.message.includes('example.test/private'));
  }
});

test('URL別パスコードは順番や重複除去に依存せず、共通値より優先する', () => {
  const a = `https://live.udtalk.jp/${'a'.repeat(64)}`;
  const b = `https://live.udtalk.jp/${'b'.repeat(64)}`;
  const c = `https://live.udtalk.jp/${'c'.repeat(64)}`;
  const secret = ' 0012, &+#"\\ ';
  const config = parseConfig([], {
    OBS_INPUT_NAME: '字幕', UDTALK_PUBLIC_URL: `${b},${a},${b}#duplicate,${c}`,
    UDTALK_PASSCODE: 'common',
    UDTALK_PASSCODES: JSON.stringify({ [`${a}?viewer=alternate`]: secret, [b]: '' }),
  });
  assert.deepEqual(config.udtalkPublicUrls, [b, a, c]);
  assert.deepEqual(config.udtalkPasscodes, { [b]: '', [a]: secret, [c]: 'common' });
});

test('個別設定のCLI指定は環境変数全体を置き換え、未指定URLには共通値を使う', () => {
  const a = `https://live.udtalk.jp/${'a'.repeat(64)}`;
  const b = `https://live.udtalk.jp/${'b'.repeat(64)}`;
  const env = {
    OBS_INPUT_NAME: '字幕', UDTALK_PUBLIC_URL: a, UDTALK_PASSCODE: 'environment-common',
    UDTALK_PASSCODES: 'invalid-json',
  };
  const config = parseConfig([
    '--udtalk-url', b, '--udtalk-url', a, '--udtalk-passcode', 'cli-common',
    '--udtalk-passcodes', JSON.stringify({ [a]: '0012' }),
  ], env);
  assert.deepEqual(config.udtalkPasscodes, { [b]: 'cli-common', [a]: '0012' });
  assert.deepEqual(parseConfig(['--udtalk-passcodes', '{}'], env).udtalkPasscodes, { [a]: 'environment-common' });
  assert.throws(() => parseConfig(['--udtalk-passcodes'], env), /値が必要/);
});

test('未使用URLの個別設定で接続先を増やさず、同一公開IDの同じ値は許可する', () => {
  const a = `https://live.udtalk.jp/${'a'.repeat(64)}`;
  const b = `https://live.udtalk.jp/${'b'.repeat(64)}`;
  const config = parseConfig([], {
    OBS_INPUT_NAME: '字幕', UDTALK_PUBLIC_URL: a,
    UDTALK_PASSCODES: JSON.stringify({ [a]: '0012', [`${a}#alternate`]: '0012', [b]: 'unused' }),
  });
  assert.deepEqual(config.udtalkPublicUrls, [a]);
  assert.deepEqual(config.udtalkPasscodes, { [a]: '0012' });
});

test('不正な個別設定と競合する値を拒否し、JSON・URL・パスコードをエラーへ出さない', () => {
  const a = `https://live.udtalk.jp/${'a'.repeat(64)}`;
  const secret = 'private-passcode-marker';
  const invalid = [
    `{\"${a}\":\"${secret}`, 'null', '[]', 'true', '12', '\"text\"',
    ...[12, null, true, {}, []].map(value => JSON.stringify({ [a]: value })),
    JSON.stringify({ 'https://example.test/private-url-marker': secret }),
    JSON.stringify({ [a]: secret, [`${a}#alternate`]: 'conflicting' }),
  ];
  for (const value of invalid) {
    assert.throws(() => parseConfig([], {
      OBS_INPUT_NAME: '字幕', UDTALK_PUBLIC_URL: a, UDTALK_PASSCODES: value,
    }), error => error instanceof Error
      && !error.message.includes(a) && !error.message.includes(secret)
      && !error.message.includes('private-url-marker') && !error.message.includes(value));
  }
});
