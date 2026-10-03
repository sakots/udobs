import assert from 'node:assert/strict';
import test from 'node:test';
import { channel } from 'node:diagnostics_channel';
import { EventEmitter } from 'node:events';
import { UdtalkWebClient } from '../src/udtalk-web-client.js';

test('取得失敗ごとに内部原因と所要時間を記録し、取得位置を維持する', async (t) => {
  const id = 'b'.repeat(64);
  const key = 'fictional-session-key';
  const warnings: string[] = [];
  const positions: number[] = [];
  let polls = 0;
  let ticks = 0;
  t.mock.method(performance, 'now', () => ++ticks * 25);
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request, options?: RequestInit) => {
    const path = String(url);
    if (path.startsWith('https://live.udtalk.jp')) return new Response(`<udtalk token-txt="{&quot;hash&quot;:&quot;${id}&quot;}">`);
    if (path.includes('initialize/')) return Response.json({ status: 1, userid: 'fictional-user' });
    if (path.includes('/webTalk/')) return Response.json({ status: 1, key });
    if (path.includes('signWebTalk/')) return Response.json({ status: 1 });
    if (path.includes('webTalkCurrent/')) return Response.json({ status: 1, number: 10, current: 20 });
    positions.push(JSON.parse(String(options?.body)).l);
    polls++;
    if (polls === 1) {
      const socket = new EventEmitter();
      channel('undici:client:beforeConnect').publish({ connectParams: { hostname: 'app.udtalk.jp' } });
      channel('net.client.socket').publish({ socket });
      socket.emit('lookup', null, '203.0.113.10', 4, 'app.udtalk.jp');
      socket.emit('connect');
      throw new TypeError('fetch failed', { cause: Object.assign(new Error('connect timeout'), { code: 'UND_ERR_CONNECT_TIMEOUT' }) });
    }
    if (polls === 2) throw new TypeError('fetch failed', { cause: new AggregateError([Object.assign(new Error('DNS failed'), { code: 'EAI_AGAIN' })]) });
    if (polls === 3) throw new TypeError('fetch failed', { cause: Object.assign(new Error(`socket closed ${key} ${path}`), { code: 'UND_ERR_SOCKET' }) });
    if (polls === 4) return new Response('', { status: 503 });
    if (polls === 5) return Object.assign(new Response(), { json: async () => { throw new TypeError('body failed', { cause: Object.assign(new Error('reset'), { code: 'ECONNRESET' }) }); } });
    return Response.json({ status: 1, number: 11, current: 21, messages: [[{ qualify: 1, meta: JSON.stringify({ phase: 'finalized', utteranceIdentifier: 'test', text: '架空の発話' }) }]] });
  });
  let complete!: () => void;
  const finished = new Promise<void>(resolve => { complete = resolve; });
  const received: string[] = [];
  const client = new UdtalkWebClient({ url: `https://live.udtalk.jp/${id}`, pollMs: 1,
    log: { info() {}, warn(text) { warnings.push(text); } },
    onText(text) { received.push(text); client.stop(); complete(); },
  });
  t.after(() => client.stop());
  await client.start();
  await Promise.race([finished, new Promise<void>((_, reject) => { const timer = setTimeout(() => reject(new Error('取得未完了')), 1000); timer.unref(); })]);
  const diagnostics = warnings.filter(text => text.startsWith('UDトーク通信失敗:'));
  assert.equal(diagnostics.length, 5);
  for (const line of diagnostics) {
    assert.match(line, /処理=web\/pull\/webTalkMessage, 経過=\d+ms/);
    assert.match(line, /タイムアウト設定=5000ms/);
    assert.ok(!line.includes(id));
    assert.ok(!line.includes(key));
  }
  assert.match(diagnostics[0], /経過=75ms/);
  assert.match(diagnostics[0], /IP=203\.0\.113\.10, TCP=成立\(25ms\), TLS=未観測/);
  assert.match(diagnostics[0], /接続再利用=なし\(新規\)/);
  assert.match(diagnostics[1], /ソケット情報=未観測/);
  for (const code of ['UND_ERR_CONNECT_TIMEOUT', 'EAI_AGAIN', 'UND_ERR_SOCKET', 'HTTP 503', 'ECONNRESET']) assert.ok(diagnostics.some(line => line.includes(code)));
  assert.deepEqual(positions, [10, 10, 10, 10, 10, 10]);
  assert.deepEqual(received, ['架空の発話']);
});

test('公開ページ取得のタイムアウトにも所要時間を記録する', async (t) => {
  const warnings: string[] = [];
  t.mock.method(globalThis, 'fetch', async () => { throw new DOMException('timeout', 'TimeoutError'); });
  const client = new UdtalkWebClient({ url: `https://live.udtalk.jp/${'c'.repeat(64)}`, pollMs: 1000, onText() {}, log: { info() {}, warn(text) { warnings.push(text); } } });
  t.after(() => client.stop());
  await client.start();
  assert.match(warnings[0], /処理=公開ページ取得, 経過=\d+ms/);
  assert.match(warnings[0], /name=TimeoutError/);
});

test('終了操作による通信中断は失敗として記録しない', async (t) => {
  const warnings: string[] = [];
  const channels = ['net.client.socket', 'undici:request:create', 'undici:client:beforeConnect', 'undici:client:sendHeaders'];
  const baseline = channels.map(name => channel(name).hasSubscribers);
  t.mock.method(globalThis, 'fetch', (_url: unknown, options: RequestInit) => new Promise((_resolve, reject) => {
    options.signal?.addEventListener('abort', () => reject(options.signal?.reason), { once: true });
  }));
  const client = new UdtalkWebClient({ url: `https://live.udtalk.jp/${'d'.repeat(64)}`, pollMs: 1, onText() {}, log: { info() {}, warn(text) { warnings.push(text); } } });
  t.after(() => client.stop());
  const pending = client.start();
  client.stop();
  await pending;
  assert.deepEqual(warnings, []);
  assert.deepEqual(channels.map(name => channel(name).hasSubscribers), baseline);
});
