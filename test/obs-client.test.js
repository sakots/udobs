import test from 'node:test';
import assert from 'node:assert/strict';
import { ObsClient } from '../src/obs.js';

test('OBSクライアントは設定されたURLを保持する', () => {
  const client = new ObsClient({
    url: 'ws://127.0.0.1:4455', password: '', inputName: '字幕', reconnectMs: 0,
  });
  assert.equal(client.url, 'ws://127.0.0.1:4455');
});
