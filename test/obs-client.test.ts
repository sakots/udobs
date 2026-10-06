import assert from 'node:assert/strict';
import test from 'node:test';
import { ObsClient } from '../src/obs.js';
test('OBSクライアントは設定されたURLを保持する', () => {
  const client = new ObsClient({ url: 'ws://127.0.0.1:4455', password: '', inputName: '字幕', reconnectMs: 0 } as never);
  assert.equal(client.url, 'ws://127.0.0.1:4455'); assert.equal(client.password, '');
});

class Socket extends EventTarget {
  static OPEN = 1;
  static instances: Socket[] = [];
  readyState = 0;
  sent: { op: number; d: { requestId: string } }[] = [];
  constructor() { super(); Socket.instances.push(this); }
  send(raw: string) { this.sent.push(JSON.parse(raw)); }
  close() { this.readyState = 3; this.dispatchEvent(new Event('close')); }
  open() { this.readyState = 1; this.dispatchEvent(new Event('open')); }
  receive(data: unknown) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(data) })); }
}

test('OBS接続・認証待ちを打ち切り、古いイベントと停止後の再接続を無視する', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.property(globalThis, 'WebSocket', Socket as unknown as typeof WebSocket);
  Socket.instances = [];
  const logs: string[] = [];
  const log = { info: (m: string) => logs.push(m), warn: (m: string) => logs.push(m), error: (m: string) => logs.push(m) };
  const client = new ObsClient({ url: 'ws://localhost:4455', password: '', inputName: '字幕', reconnectMs: 1000, log });
  t.after(() => client.stop());
  client.connect();
  const first = Socket.instances[0];
  t.mock.timers.tick(5000);
  assert.match(logs.join('\n'), /接続待ち.*タイムアウト/);
  t.mock.timers.tick(1000);
  const second = Socket.instances[1];
  first.receive({ op: 2, d: {} });
  first.close();
  second.open();
  t.mock.timers.tick(5000);
  t.mock.timers.tick(1000);
  assert.equal(Socket.instances.length, 3);
  client.stop();
  assert.match(logs.join('\n'), /再接続失敗集計.*認証待ち.*タイムアウト/);
  t.mock.timers.tick(20000);
  assert.equal(Socket.instances.length, 3);
});

test('OBS再接続失敗を1分ごとに集計し、復旧で集計をリセットして最新字幕を再送する', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.property(globalThis, 'WebSocket', Socket as unknown as typeof WebSocket);
  Socket.instances = [];
  const logs: string[] = [];
  const log = { info: (m: string) => logs.push(m), warn: (m: string) => logs.push(m), error: (m: string) => logs.push(m) };
  const client = new ObsClient({ url: 'ws://localhost:4455', password: '', inputName: '字幕', reconnectMs: 2000, log });
  t.after(() => client.stop());
  client.connect();
  const first = Socket.instances[0];
  first.open(); first.receive({ op: 2, d: {} });
  client.setCaptionPair('B', '前字幕', 'A'); // 応答前に切断する
  const closing = Object.assign(new Event('close'), { code: 1001, reason: 'Server stopping.' });
  first.dispatchEvent(closing);
  assert.match(logs.at(-1)!, /接続が切れました.*1001.*Server stopping/);
  for (let i = 0; i < 29; i++) {
    t.mock.timers.tick(2000);
    Socket.instances.at(-1)!.close();
  }
  assert.equal(logs.filter(m => m.includes('再接続に失敗しました')).length, 0);
  t.mock.timers.tick(2000);
  assert.match(logs.join('\n'), /再接続失敗集計: 件数=29/);
  const recovered = Socket.instances.at(-1)!;
  recovered.close();
  client.setCaptionPair('C', '前字幕', 'B');
  t.mock.timers.tick(2000);
  const final = Socket.instances.at(-1)!;
  final.open();
  assert.ok(!logs.some(m => m.includes('接続が復旧'))); // 認証完了まで復旧としない
  final.receive({ op: 2, d: {} });
  assert.match(logs.join('\n'), /再接続失敗集計: 件数=1/);
  assert.ok(logs.some(m => m.includes('OBSとの接続が復旧しました')));
  assert.match(JSON.stringify(final.sent), /C.*B/);
  final.close();
  assert.match(logs.at(-1)!, /接続が切れました/);
  client.stop();
  const count = logs.length;
  const instances = Socket.instances.length;
  t.mock.timers.tick(120000);
  assert.equal(logs.length, count);
  assert.equal(Socket.instances.length, instances);
});

test('OBS成功ログは対応する全ソースの成功応答後だけに出す', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.property(globalThis, 'WebSocket', Socket as unknown as typeof WebSocket);
  Socket.instances = [];
  const logs: string[] = [];
  const log = { info: (m: string) => logs.push(m), warn() {}, error: (m: string) => logs.push(m) };
  const client = new ObsClient({ url: 'ws://localhost:4455', password: '', inputName: '字幕', reconnectMs: 1000, log });
  t.after(() => client.stop());
  client.connect();
  const socket = Socket.instances[0];
  socket.open(); socket.receive({ op: 2, d: {} });
  client.setCaptionPair('B', '前字幕', 'A');
  assert.ok(!logs.some(m => m.includes('OBS更新確認')));
  const requestId = socket.sent[0].d.requestId;
  socket.receive({ op: 9, d: { requestId, results: [{ requestStatus: { result: true } }] } });
  assert.ok(!logs.some(m => m.includes('OBS更新確認')));
  client.setText('C');
  socket.receive({ op: 9, d: { requestId, results: [{ requestStatus: { result: true } }, { requestStatus: { result: true } }] } });
  assert.equal(socket.sent.length, 2); // 遅い応答で次の要求を解除しない
  socket.receive({ op: 7, d: { requestId: socket.sent[1].d.requestId, requestStatus: { result: true } } });
  assert.equal(logs.filter(m => m.includes('OBS更新確認')).length, 1);
  assert.match(logs.at(-1)!, /udtalk-2/);
  client.setCaptionPair('D', '前字幕', 'C');
  socket.receive({ op: 9, d: { requestId: socket.sent[2].d.requestId, results: [
    { requestStatus: { result: true } }, { requestStatus: { result: false, code: 600 } },
  ] } });
  assert.equal(logs.filter(m => m.includes('OBS更新確認')).length, 1);
  t.mock.timers.tick(10000); // 認証・更新完了後の期限は解除される
  assert.equal(Socket.instances.length, 1);
  assert.equal(socket.readyState, 1);
});
