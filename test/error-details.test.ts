import assert from 'node:assert/strict';
import test from 'node:test';
import { describeError } from '../src/error-details.js';

test('内部原因とAggregateErrorの子エラーを記録し秘密情報は隠す', () => {
  const id = 'a'.repeat(64);
  const secret = 'fictional-session-key';
  const cause = new AggregateError([
    Object.assign(new Error(`connect https://example.test/${id} ${secret}`), { code: 'ETIMEDOUT' }),
    Object.assign(new Error('DNS failed'), { code: 'EAI_AGAIN' }),
  ], '複数の接続に失敗');
  const details = describeError(new TypeError('fetch failed', { cause }), [secret]);
  for (const text of ['TypeError', 'fetch failed', 'AggregateError', 'ETIMEDOUT', 'EAI_AGAIN']) assert.ok(details.includes(text));
  for (const text of [secret, id, 'https://example.test']) assert.ok(!details.includes(text));
});

test('循環するcauseがあってもログ生成を停止しない', () => {
  const error = new Error('test');
  error.cause = error;
  assert.match(describeError(error), /循環参照/);
});
