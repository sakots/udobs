import assert from 'node:assert/strict';
import test from 'node:test';
import { UdtalkWebClient } from '../src/udtalk-web-client.js';

const id = 'e'.repeat(64);
const url = `https://live.udtalk.jp/${id}`;
const quiet = { info() {}, warn(_text: string) {} };
const flush = () => new Promise<void>(resolve => setImmediate(resolve));

test('閲覧セッション作成の失敗にも上限付きの再試行を適用し、停止後は通信しない', async t => {
  const queued: { run: () => void; delay: number }[] = [];
  t.mock.method(globalThis, 'setTimeout', (run: () => void, delay: number) => {
    queued.push({ run, delay }); return {} as NodeJS.Timeout;
  });
  let calls = 0;
  const warnings: string[] = [];
  t.mock.method(globalThis, 'fetch', async () => { calls++; throw new TypeError('fetch failed'); });
  const client = new UdtalkWebClient({ url, pollMs: 1000, retryMaxMs: 3000, onText() {},
    log: { info() {}, warn(text) { warnings.push(text); } } });
  t.after(() => client.stop());
  await client.start();
  for (const delay of [1000, 2000, 3000, 3000]) {
    assert.equal(queued.length, 1);
    const next = queued.shift()!;
    assert.equal(next.delay, delay);
    next.run();
    await flush();
  }
  assert.ok(warnings.some(line => line.includes('3000ms後に再試行')));
  const pending = queued.shift()!;
  client.stop();
  pending.run();
  await flush();
  assert.equal(calls, 5);
  assert.equal(queued.length, 0);
});

test('連続失敗で待ち時間を上限まで延ばし、復旧後は通常間隔と次の取得位置に戻る', async t => {
  const queued: { run: () => void; delay: number }[] = [];
  t.mock.method(globalThis, 'setTimeout', (run: () => void, delay: number) => {
    queued.push({ run, delay }); return {} as NodeJS.Timeout;
  });
  const positions: number[] = [];
  const texts: string[] = [];
  let polls = 0;
  t.mock.method(globalThis, 'fetch', async (target: unknown, options?: RequestInit) => {
    const path = String(target);
    if (path.startsWith('https://live.')) return new Response(`<x token-txt="&quot;hash&quot;:&quot;${id}">`);
    if (path.includes('initialize/')) return Response.json({ status: 1, userid: 'fictional-user' });
    if (path.includes('/webTalk/')) return Response.json({ status: 1, key: 'fictional-key' });
    if (path.includes('signWebTalk/')) return Response.json({ status: 1 });
    if (path.includes('webTalkCurrent/')) return Response.json({ status: 1, number: 10, current: 20 });
    positions.push(JSON.parse(String(options?.body)).l);
    polls++;
    if (polls <= 5 || polls === 7) throw new TypeError('fetch failed');
    const message = { qualify: 1, meta: JSON.stringify({ phase: 'finalized', utteranceIdentifier: 'fictional-id', text: '復旧後の架空字幕' }) };
    return Response.json({ status: 1, number: 11, current: 21, messages: [[message, message]] });
  });
  const client = new UdtalkWebClient({ url, pollMs: 1000, retryMaxMs: 5000, log: quiet, onText(text) { texts.push(text); } });
  t.after(() => client.stop());
  await client.start();
  for (const delay of [0, 1000, 2000, 4000, 5000, 5000, 1000]) {
    assert.equal(queued.length, 1);
    const next = queued.shift()!;
    assert.equal(next.delay, delay);
    next.run();
    await flush();
  }
  assert.equal(queued[0].delay, 1000); // 復旧後の失敗は再び最短間隔。
  assert.deepEqual(positions, [10, 10, 10, 10, 10, 10, 11]);
  assert.deepEqual(texts, ['復旧後の架空字幕']);
  const scheduled = queued.shift()!;
  client.stop();
  scheduled.run();
  await flush();
  assert.equal(polls, 7);
  assert.equal(queued.length, 0);
});

test('通信上限で待機中のfetchを中断し、停止後は再試行しない', async t => {
  const warnings: string[] = [];
  let signal: AbortSignal | null | undefined;
  t.mock.method(globalThis, 'fetch', (_target: unknown, options: RequestInit) => new Promise((_resolve, reject) => {
    signal = options.signal;
    signal?.addEventListener('abort', () => reject(signal?.reason), { once: true });
  }));
  const client = new UdtalkWebClient({ url, pollMs: 1000, requestTimeoutMs: 30, onText() {},
    log: { info() {}, warn(text) { warnings.push(text); } } });
  t.after(() => client.stop());
  const deadline = setTimeout(() => client.stop(), 1000);
  try { await client.start(); } finally { clearTimeout(deadline); }
  assert.equal(signal?.aborted, true);
  assert.match(warnings[0], /タイムアウト設定=30ms.*name=TimeoutError/);
  client.stop();
});
