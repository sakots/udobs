import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, type Socket } from 'node:net';
import test from 'node:test';
import type { Agent } from 'undici';
import { UdtalkWebClient } from '../src/udtalk-web-client.js';

const id = 'f'.repeat(64);
const url = `https://live.udtalk.jp/${id}`;
const quiet = { info() {}, warn() {} };
type TransportOptions = RequestInit & { dispatcher?: Agent };

test('公開ページとAPIで専用エージェントを共有し、停止時に破棄する', async t => {
  const dispatchers: (Agent | undefined)[] = [];
  t.mock.method(globalThis, 'fetch', async (target: unknown, options?: TransportOptions) => {
    dispatchers.push(options?.dispatcher);
    const path = String(target);
    if (path.startsWith('https://live.')) return new Response(`<x token-txt="&quot;hash&quot;:&quot;${id}">`);
    if (path.includes('initialize/')) return Response.json({ status: 1, userid: 'fictional-user' });
    if (path.includes('/webTalk/')) return Response.json({ status: 1, key: 'fictional-key' });
    if (path.includes('signWebTalk/')) return Response.json({ status: 1 });
    return Response.json({ status: 1, number: 10, current: 20 });
  });
  const client = new UdtalkWebClient({ url, pollMs: 10000, onText() {}, log: quiet });
  t.after(() => client.stop());
  await client.start();
  const dispatcher = dispatchers[0];
  assert.ok(dispatcher, 'fetchに接続タイムアウト付きエージェントを渡す');
  assert.equal(dispatchers.length, 5);
  assert.ok(dispatchers.every(value => value === dispatcher));
  client.stop();
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(dispatcher.destroyed, true);
  await client.start();
  assert.ok(dispatchers[5]);
  assert.notEqual(dispatchers[5], dispatcher, '再起動時は破棄済みエージェントを再利用しない');
});

for (const requestTimeoutMs of [100, 5000]) test(`TLS接続待ちは通信全体${requestTimeoutMs}msより短い上限でソケットを閉じる`, { timeout: 6000 }, async t => {
  const nativeFetch = globalThis.fetch;
  const sockets = new Set<Socket>();
  let socketClosed!: () => void;
  const closed = new Promise<void>(resolve => { socketClosed = resolve; });
  // TCPのみ受け付け、TLSハンドシェイクには応答しないローカルのモック。
  const server = createServer(socket => {
    sockets.add(socket);
    socket.resume();
    socket.on('error', () => {});
    socket.on('close', () => { sockets.delete(socket); socketClosed(); });
  });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  let dispatcher: Agent | undefined;
  t.mock.method(globalThis, 'fetch', async (_target: unknown, options?: TransportOptions) => {
    dispatcher = options?.dispatcher;
    throw new TypeError('fictional failure');
  });
  const client = new UdtalkWebClient({ url, pollMs: 10000, requestTimeoutMs, onText() {}, log: quiet });
  t.after(() => client.stop());
  await client.start();
  assert.ok(dispatcher);
  const started = performance.now();
  await assert.rejects(nativeFetch(`https://127.0.0.1:${address.port}`, {
    dispatcher, signal: AbortSignal.timeout(4000),
  } as TransportOptions), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal((error.cause as { code?: string })?.code, 'UND_ERR_CONNECT_TIMEOUT');
    return true;
  });
  await closed;
  assert.ok(performance.now() - started < Math.min(requestTimeoutMs, 2000) + 1000, '接続待ちを最大2秒で打ち切る');
});

test('接続後の本文受信は2秒を超えても通信全体の上限まで待つ', async t => {
  let aborted: boolean | undefined;
  t.mock.method(globalThis, 'fetch', async (_target: unknown, options?: TransportOptions) => {
    return { ok: true, async text() {
      await new Promise(resolve => setTimeout(resolve, 2100));
      aborted = options?.signal?.aborted;
      return 'fictional page without token';
    } } as Response;
  });
  const client = new UdtalkWebClient({ url, pollMs: 10000, onText() {}, log: quiet });
  t.after(() => client.stop());
  await client.start();
  assert.equal(aborted, false);
});
