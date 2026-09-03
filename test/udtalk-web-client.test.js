import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePublicUrl } from '../src/udtalk-web-client.js';

test('UDトークWeb公開URLから公開IDを取得する', () => {
  const result = parsePublicUrl('https://live.udtalk.jp/808d4ebbbea1b85b855b0accd09562ccb531a9b52c8079c95c7295cd3c7cb265');
  assert.equal(result.publicId, '808d4ebbbea1b85b855b0accd09562ccb531a9b52c8079c95c7295cd3c7cb265');
});

test('別サイトのURLは拒否する', () => {
  assert.throws(() => parsePublicUrl('https://example.com/talk'), /Web公開URL/);
});
