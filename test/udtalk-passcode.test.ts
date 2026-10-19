import assert from 'node:assert/strict';
import test from 'node:test';
import { UdtalkWebClient } from '../src/udtalk-web-client.js';

const id = 'a'.repeat(64);
const token = 'b'.repeat(64);
const url = `https://live.udtalk.jp/${id}`;
const passcode = '0012 &+#';
const quiet = { info() {}, warn() {} };
function page(withCookies = true): Response {
  const headers = new Headers();
  if (withCookies) {
    headers.append('set-cookie', 'XSRF-TOKEN=fictional%2Bcsrf%3D; Path=/; Secure');
    headers.append('set-cookie', 'udtalk-session=fictional-session; Path=/; HttpOnly');
  }
  return new Response(`<udtalk token-txt="{&quot;hash&quot;:&quot;${token}&quot;}">`, { headers });
}
function sessionResponse(path: string): Response {
  if (path.includes('initialize/')) return Response.json({ status: 1, userid: 'fictional-user' });
  if (path.includes('/webTalk/')) return Response.json({ status: 1, key: 'fictional-key' });
  if (path.includes('signWebTalk/')) return Response.json({ status: 1 });
  throw new Error(`Unexpected request: ${path}`);
}

for (const passcode of ['0012 &+#', '7']) test('パスコード認証後に新規発話を取得し、再認証でも未取得位置と重複排除を維持する', async t => {
  const queued: (() => void)[] = [];
  t.mock.method(globalThis, 'setTimeout', (run: () => void) => { queued.push(run); return {} as NodeJS.Timeout; });
  let logins = 0;
  let polls = 0;
  const positions: [number, number][] = [];
  const texts: string[] = [];
  const message = (text: string) => ({ qualify: 1, meta: JSON.stringify({ phase: 'finalized', utteranceIdentifier: text, text }) });
  t.mock.method(globalThis, 'fetch', async (target: unknown, options?: RequestInit) => {
    const path = String(target);
    const headers = new Headers(options?.headers);
    if (path === url) return page();
    if (path === 'https://live.udtalk.jp/api/login') {
      assert.deepEqual(JSON.parse(String(options?.body)), { url: id, passcode });
      assert.equal(headers.get('x-xsrf-token'), 'fictional+csrf=');
      assert.equal(headers.get('cookie'), 'XSRF-TOKEN=fictional%2Bcsrf%3D; udtalk-session=fictional-session');
      return Response.json({ status: 1, token: `fictional-auth-${++logins}` });
    }
    assert.equal(headers.get('cookie'), null, '閲覧Cookieを別ホストへ送らない');
    if (path.includes('/checkAuth/')) {
      assert.deepEqual(JSON.parse(String(options?.body)), { t: id });
      assert.equal(headers.get('x-ud-authorization'), null, '再接続時に古い認証値を送らない');
      return Response.json({ status: 1, requires: true });
    }
    assert.equal(headers.get('x-ud-authorization'), `fictional-auth-${logins}`);
    if (path.includes('webTalkCurrent/')) return Response.json({ status: 1, number: logins === 1 ? 10 : 14, current: logins === 1 ? 20 : 24 });
    if (!path.includes('webTalkMessage/')) return sessionResponse(path);
    const body = JSON.parse(String(options?.body));
    positions.push([body.l, body.c]);
    if (++polls === 2) return Response.json({ status: 7 });
    return Response.json({ status: 1, number: polls === 1 ? 11 : 14, current: polls === 1 ? 21 : 24,
      messages: [[message('架空の最初の字幕'), ...(polls === 1 ? [] : [message('架空の復旧中の字幕')])]] });
  });
  const options = { url, passcode, pollMs: 1000, log: quiet, onText(text: string) { texts.push(text); } };
  const client = new UdtalkWebClient(options);
  t.after(() => client.stop());
  await client.start();
  for (let step = 0; step < 4; step++) {
    assert.ok(queued.length, '取得または再接続を予約する');
    queued.shift()!();
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  assert.equal(logins, 2);
  assert.deepEqual(positions, [[10, 20], [11, 21], [11, 21]]);
  assert.deepEqual(texts, ['架空の最初の字幕', '架空の復旧中の字幕']);
});

for (const configured of ['', passcode]) test(`パスコード不要の公開では認証せず発話を取得する（設定${configured ? 'あり' : 'なし'}）`, async t => {
  const queued: (() => void)[] = [];
  t.mock.method(globalThis, 'setTimeout', (run: () => void) => { queued.push(run); return {} as NodeJS.Timeout; });
  const texts: string[] = [];
  t.mock.method(globalThis, 'fetch', async (target: unknown, options?: RequestInit) => {
    const path = String(target);
    if (path === url) return page(false);
    assert.ok(path.startsWith('https://app.udtalk.jp/'), '不要なログインをしない');
    assert.equal(new Headers(options?.headers).get('x-ud-authorization'), null);
    if (path.includes('/checkAuth/')) return Response.json({ status: 1, requires: false });
    if (path.includes('webTalkCurrent/')) return Response.json({ status: 1, number: 10, current: 20 });
    if (path.includes('webTalkMessage/')) return Response.json({ status: 1, messages: [[{
      qualify: 1, meta: JSON.stringify({ phase: 'finalized', text: '架空のパスコードなし字幕' }),
    }]] });
    return sessionResponse(path);
  });
  const options = { url, passcode: configured, pollMs: 1000, log: quiet, onText(text: string) { texts.push(text); } };
  const client = new UdtalkWebClient(options);
  t.after(() => client.stop());
  await client.start();
  assert.ok(queued.length);
  queued.shift()!();
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual(texts, ['架空のパスコードなし字幕']);
});

for (const failure of ['未設定', '不一致', 'トークン欠落', 'Cookie欠落'] as const) test(`認証失敗時は字幕取得へ進まない: ${failure}`, async t => {
  const warnings: string[] = [];
  let loginCalls = 0;
  let sessionCalls = 0;
  t.mock.method(globalThis, 'fetch', async (target: unknown) => {
    const path = String(target);
    if (path === url) return page(failure !== 'Cookie欠落');
    if (path.includes('/checkAuth/')) return Response.json({ status: 1, requires: true });
    if (path === 'https://live.udtalk.jp/api/login') {
      loginCalls++;
      return Response.json(failure === '不一致' ? { status: 7 } : { status: 1 });
    }
    sessionCalls++;
    return sessionResponse(path);
  });
  const options = { url, passcode: failure === '未設定' ? '' : passcode, pollMs: 10000, onText() { assert.fail('字幕を転送した'); },
    log: { info() {}, warn(text: string) { warnings.push(text); } } };
  const client = new UdtalkWebClient(options);
  t.after(() => client.stop());
  await client.start();
  assert.equal(loginCalls, failure === '未設定' || failure === 'Cookie欠落' ? 0 : 1);
  assert.equal(sessionCalls, 0, '認証失敗後にセッション作成へ進まない');
  assert.match(warnings.join('\n'), failure === '未設定' ? /UDTALK_PASSCODE/ : /パスコード認証/);
  assert.ok(warnings.every(text => !text.includes(passcode)));
});

for (const stage of ['login', 'api']) test(`認証の秘密値を通信失敗ログに残さない: ${stage}`, async t => {
  const logs: string[] = [];
  t.mock.method(globalThis, 'fetch', async (target: unknown) => {
    const path = String(target);
    if (path === url) return page();
    if (path.includes('/checkAuth/')) return Response.json({ status: 1, requires: true });
    if (path.endsWith('/api/login') && stage === 'api') return Response.json({ status: 1, token: 'fictional-auth-secret' });
    throw new TypeError('fictional failure', { cause: new Error(`${passcode} fictional-session fictional%2Bcsrf%3D fictional+csrf= fictional-auth-secret`) });
  });
  const options = { url, passcode, pollMs: 10000, onText() {}, log: { info(text: string) { logs.push(text); }, warn(text: string) { logs.push(text); } } };
  const client = new UdtalkWebClient(options);
  t.after(() => client.stop());
  await client.start();
  assert.match(logs.join('\n'), /fictional failure/);
  for (const secret of [passcode, 'fictional-session', 'fictional%2Bcsrf%3D', 'fictional+csrf=', ...(stage === 'api' ? ['fictional-auth-secret'] : [])]) {
    assert.ok(logs.every(text => !text.includes(secret)), `秘密値を伏せる: ${secret}`);
  }
});

for (const stop of [true, false]) test(`認証待機を${stop ? '停止' : 'タイムアウト'}で中断する`, async t => {
  let entered!: () => void;
  const loginStarted = new Promise<void>(resolve => { entered = resolve; });
  let signal: AbortSignal | null | undefined;
  const timeout = new AbortController();
  t.mock.method(AbortSignal, 'timeout', () => timeout.signal);
  const warnings: string[] = [];
  t.mock.method(globalThis, 'fetch', async (target: unknown, options?: RequestInit) => {
    const path = String(target);
    if (path === url) return page();
    if (path.includes('/checkAuth/')) return Response.json({ status: 1, requires: true });
    assert.equal(path, 'https://live.udtalk.jp/api/login');
    signal = options?.signal;
    entered();
    return new Promise<Response>((_resolve, reject) => { signal?.addEventListener('abort', () => reject(signal?.reason), { once: true }); });
  });
  const options = { url, passcode, pollMs: 10000, requestTimeoutMs: stop ? 5000 : 30, onText() {},
    log: { info() {}, warn(text: string) { warnings.push(text); } } };
  const client = new UdtalkWebClient(options);
  t.after(() => client.stop());
  const pending = client.start();
  await Promise.race([loginStarted, pending]);
  assert.ok(signal, '認証待機に到達する');
  if (stop) client.stop();
  else timeout.abort(new DOMException('fictional timeout', 'TimeoutError'));
  await pending;
  assert.equal(signal?.aborted, true);
  if (stop) assert.deepEqual(warnings, []);
  else assert.match(warnings.join('\n'), /TimeoutError/);
  client.stop();
});
