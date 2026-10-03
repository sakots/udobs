import assert from 'node:assert/strict';
import { channel } from 'node:diagnostics_channel';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { ConnectionDiagnostics } from '../src/connection-diagnostics.js';

class FakeSocket extends EventEmitter {
  remoteAddress = '203.0.113.10';
  alpnProtocol = 'http/1.1';
  isSessionReused() { return true; }
}
const names = ['undici:client:beforeConnect', 'net.client.socket', 'undici:request:create', 'undici:client:sendHeaders'];
const beginConnect = (socket: FakeSocket) => {
  channel(names[0]).publish({ connectParams: { hostname: 'app.udtalk.jp' } });
  channel(names[1]).publish({ socket });
};
const send = (socket: FakeSocket) => {
  const request = { origin: 'https://app.udtalk.jp', path: `/${'a'.repeat(64)}`, body: 'fictional-secret' };
  channel(names[2]).publish({ request });
  channel(names[3]).publish({ request, socket, headers: 'fictional-secret' });
};

test('TCP成立後のTLS未成立を記録し、購読とリスナーを解除する', async (t) => {
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  const baseline = names.map(name => channel(name).hasSubscribers);
  const diagnostics = new ConnectionDiagnostics();
  const trace = diagnostics.begin('app.udtalk.jp');
  t.after(() => trace.close());
  const socket = new FakeSocket();
  await trace.run(async () => {
    beginConnect(socket);
    socket.emit('lookup', null, socket.remoteAddress, 4, 'app.udtalk.jp');
    now = 12;
    socket.emit('connect');
  });
  const summary = trace.summary();
  assert.match(summary, /新規接続試行=1/);
  assert.match(summary, /IP=203\.0\.113\.10, TCP=成立\(12ms\), TLS=未観測/);
  assert.match(summary, /HTTPヘッダー送信通知=未観測/);
  assert.match(summary, /接続再利用=なし\(新規\)/);
  trace.close();
  trace.close();
  assert.deepEqual(socket.eventNames(), []);
  assert.deepEqual(names.map(name => channel(name).hasSubscribers), baseline);
});

test('同じソケットの再利用とTLSセッション再開を区別する', async (t) => {
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  const diagnostics = new ConnectionDiagnostics();
  const socket = new FakeSocket();
  const first = diagnostics.begin('app.udtalk.jp');
  t.after(() => first.close());
  await first.run(async () => {
    beginConnect(socket);
    now = 10; socket.emit('connect');
    now = 40; socket.emit('secureConnect');
    send(socket);
  });
  assert.match(first.summary(), /TCP=成立\(10ms\), TLS=成立\(40ms\)/);
  assert.match(first.summary(), /接続再利用=なし\(新規\), TLSセッション再開=あり, ALPN=http\/1\.1/);
  assert.ok(!first.summary().includes('fictional-secret'));
  assert.ok(!first.summary().includes('a'.repeat(64)));
  assert.equal(diagnostics.shouldReportSuccess('取得', first), true);
  assert.equal(diagnostics.shouldReportSuccess('取得', first), false);
  first.close();

  const second = diagnostics.begin('app.udtalk.jp');
  t.after(() => second.close());
  await second.run(async () => send(socket));
  assert.match(second.summary(), /新規接続試行=0/);
  assert.match(second.summary(), /接続#1:/);
  assert.match(second.summary(), /接続再利用=あり/);
  assert.equal(second.mode, '再利用');
  assert.equal(diagnostics.shouldReportSuccess('取得', second), true);
  assert.equal(diagnostics.shouldReportSuccess('取得', second), false);
  diagnostics.failure('取得');
  assert.equal(diagnostics.shouldReportSuccess('取得', second), true);
});

test('接続前の失敗・イベント非対応を成功と誤判定しない', async (t) => {
  const diagnostics = new ConnectionDiagnostics();
  const trace = diagnostics.begin('app.udtalk.jp');
  t.after(() => trace.close());
  const socket = new FakeSocket();
  await trace.run(async () => beginConnect(socket));
  assert.match(trace.summary(), /IP=未観測, TCP=未観測, TLS=未観測/);
  trace.close();
  const missing = diagnostics.begin('app.udtalk.jp');
  t.after(() => missing.close());
  assert.match(missing.summary(), /ソケット情報=未観測/);
  assert.equal(diagnostics.shouldReportSuccess('取得', missing), false);
});

test('異なる通信コンテキスト・接続先のイベントを混ぜない', async (t) => {
  const diagnostics = new ConnectionDiagnostics();
  const first = diagnostics.begin('app.udtalk.jp');
  const second = diagnostics.begin('app.udtalk.jp');
  t.after(() => { first.close(); second.close(); });
  await first.run(async () => {
    channel(names[0]).publish({ connectParams: { hostname: 'example.test' } });
    channel(names[1]).publish({ socket: new FakeSocket() });
  });
  assert.equal(first.observed, false);
  await second.run(async () => beginConnect(new FakeSocket()));
  assert.equal(first.observed, false);
  assert.equal(second.observed, true);
  channel(names[0]).publish({ connectParams: { hostname: 'app.udtalk.jp' } });
  assert.match(first.summary(), /新規接続試行=0/);
});

test('通知の仕様差があっても診断だけを無視する', async (t) => {
  const diagnostics = new ConnectionDiagnostics();
  const trace = diagnostics.begin('app.udtalk.jp');
  t.after(() => trace.close());
  await trace.run(async () => {
    for (const name of names) channel(name).publish(null);
    channel(names[2]).publish({ request: { origin: 'invalid' } });
  });
  assert.equal(trace.observed, false);
  // 初めて見た既存ソケットでは再利用の有無を推測しない。
  await trace.run(async () => send(new FakeSocket()));
  assert.match(trace.summary(), /接続再利用=未判定/);
});
