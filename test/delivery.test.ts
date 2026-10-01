import assert from 'node:assert/strict';
import test from 'node:test';
import { ObsClient } from '../src/obs.js';
import { UdtalkWebClient } from '../src/udtalk-web-client.js';

const logger = { info() {}, warn() {}, error() {} };

test('OBS切断中の最新字幕と前字幕を再認証後に再送する', async (t) => {
  class Socket extends EventTarget {
    static OPEN = 1;
    static instances: Socket[] = [];
    readyState = 1;
    sent: { op: number; d: { requestId: string; requests?: { requestData: { inputName: string; inputSettings: { text: string } } }[]; requestData?: { inputName: string; inputSettings: { text: string } } } }[] = [];
    constructor() { super(); Socket.instances.push(this); }
    send(raw: string) { this.sent.push(JSON.parse(raw)); }
    close() { this.readyState = 3; this.dispatchEvent(new Event('close')); }
    receive(data: unknown) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(data) })); }
  }
  const originalSocket = globalThis.WebSocket;
  globalThis.WebSocket = Socket as unknown as typeof WebSocket;
  t.after(() => { globalThis.WebSocket = originalSocket; });
  const client = new ObsClient({ url: 'ws://localhost:4455', password: '', inputName: '字幕', reconnectMs: 0, log: logger });
  t.after(() => client.stop());
  client.connect();
  const first = Socket.instances[0];
  first.receive({ op: 2, d: {} });
  client.setText('送信中');
  first.close(); // 更新応答を受け取る前に切断
  client.setText('最新');
  client.setTextForInput('前字幕', 'ひとつ前');
  await new Promise((resolve) => setTimeout(resolve, 10));
  const second = Socket.instances[1];
  second.receive({ op: 2, d: {} });
  assert.equal(second.sent[0].op, 8);
  assert.deepEqual(second.sent[0].d.requests?.map((m) => m.requestData), [
    { inputName: '字幕', inputSettings: { text: '最新' }, overlay: true },
    { inputName: '前字幕', inputSettings: { text: 'ひとつ前' }, overlay: true },
  ]);
  client.setText('次');
  assert.equal(second.sent.length, 1); // ペア全体の応答を待つ
  second.receive({ op: 9, d: { requestId: second.sent[0].d.requestId, results: [{ requestStatus: { result: true } }, { requestStatus: { result: true } }] } });
  assert.equal(second.sent[1].d.requestData?.inputSettings.text, '次');
  client.setCaptionPair('C', '前字幕', 'B');
  client.setCaptionPair('D', '前字幕', 'C');
  assert.equal(second.sent.length, 2);
  second.receive({ op: 7, d: { requestId: second.sent[1].d.requestId, requestStatus: { result: true } } });
  assert.deepEqual(second.sent[2].d.requests?.map((m) => m.requestData.inputSettings.text), ['D', 'C']);
});

test('UDトーク再接続時に未取得の発話位置を飛ばさない', async (t) => {
  const id = 'a'.repeat(64);
  const positions: number[] = [];
  let connections = 0;
  let polls = 0;
  let complete!: () => void;
  const finished = new Promise<void>((resolve) => { complete = resolve; });
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request, options?: RequestInit) => {
    const path = String(url);
    let data: unknown;
    if (path.startsWith('https://live.udtalk.jp')) return new Response(`<udtalk token-txt="{&quot;hash&quot;:&quot;${id}&quot;}">`);
    if (path.includes('initialize/')) { connections++; data = { status: 1, userid: 'user' }; }
    else if (path.includes('/webTalk/')) data = { status: 1, key: 'key' };
    else if (path.includes('signWebTalk/')) data = { status: 1 };
    else if (path.includes('webTalkCurrent/')) data = { status: 1, number: connections === 1 ? 10 : 12, current: connections === 1 ? 20 : 22 };
    else {
      const body = JSON.parse(String(options?.body));
      positions.push(body.l);
      if (++polls === 1) data = { status: 7 };
      else data = { status: 1, number: 12, current: 22, messages: [[{ qualify: 1, meta: JSON.stringify({ phase: 'finalized', utteranceIdentifier: 'missed', text: '復旧中の発話' }) }]] };
    }
    return Response.json(data);
  });
  const received: string[] = [];
  const client = new UdtalkWebClient({ url: `https://live.udtalk.jp/${id}`, pollMs: 1, log: logger,
    onText(text, utterance) {
      assert.equal(utterance.id, 'missed');
      received.push(text); client.stop(); complete();
    } });
  t.after(() => client.stop());
  await client.start();
  await Promise.race([finished, new Promise<void>((_, reject) => { const timer = setTimeout(() => reject(new Error('取得が完了しません')), 1000); timer.unref(); })]);
  assert.deepEqual(positions, [10, 10]);
  assert.deepEqual(received, ['復旧中の発話']);
});
