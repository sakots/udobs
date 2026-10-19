import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

test('複数URLの並行取得・再接続・訂正を共通字幕へ反映し、終了時は全通信を中断する', { timeout: 10000 }, async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'udobs-multiple-'));
  const a = 'a'.repeat(64);
  const b = 'b'.repeat(64);
  // 実際のエントリポイントを子プロセスで起動し、外部通信だけを架空の応答に置き換える。
  const script = `
    const notify = value => process.send(value);
    const ids = ${JSON.stringify([a, b])};
    const connections = [0, 0];
    const polls = [0, 0];
    const { promise: waitForB, resolve: releaseA } = Promise.withResolvers();
    const message = (text, timestamp, id = 'shared-id') => ({ qualify: 1,
      meta: JSON.stringify({ phase: 'finalized', utteranceIdentifier: id, text, timestamp }) });
    globalThis.fetch = async (input, options) => {
      const url = new URL(String(input));
      const source = ids.indexOf(url.pathname.split('/').at(-1));
      if (source < 0) throw new Error('Unexpected network request');
      if (url.hostname === 'live.udtalk.jp') {
        if (source === 0 && connections[0] === 0) await waitForB;
        return new Response('<udtalk token-txt="{&quot;hash&quot;:&quot;' + ids[source] + '&quot;}">');
      }
      const operation = url.pathname.split('/').at(-2);
      if (operation === 'checkAuth') return Response.json({ status: 1, requires: false });
      if (operation === 'initialize') {
        connections[source]++;
        return Response.json({ status: 1, userid: 'user-' + source });
      }
      if (operation === 'webTalk') return Response.json({ status: 1, key: 'key-' + source });
      if (operation === 'signWebTalk') return Response.json({ status: 1 });
      if (operation === 'webTalkCurrent') return Response.json({ status: 1,
        number: source === 1 ? 100 : connections[0] === 1 ? 10 : 12,
        current: source === 1 ? 200 : connections[0] === 1 ? 20 : 22 });
      if (operation !== 'webTalkMessage') throw new Error('Unexpected API operation');
      const body = JSON.parse(options.body);
      notify({ kind: 'poll', source, position: [body.l, body.c] });
      const poll = ++polls[source];
      if (source === 1 && poll <= 2) {
        releaseA();
        return Response.json({ status: 1, number: 100 + poll, current: 200 + poll,
          messages: [[message('B', 2)]] });
      }
      if (source === 0 && poll === 1) return Response.json({ status: 7 });
      if (source === 0 && poll === 2) return Response.json({ status: 1, number: 12, current: 22,
        messages: [[message('A', 1), message('A訂正', 1), message('A訂正', 1), message('B', 3, 'another-id')]] });
      const { promise, reject } = Promise.withResolvers();
      options.signal.addEventListener('abort', () => {
        notify({ kind: 'aborted', source });
        reject(options.signal.reason);
      }, { once: true });
      notify({ kind: 'pending', source });
      return promise;
    };
    globalThis.WebSocket = class extends EventTarget {
      static OPEN = 1;
      readyState = 1;
      constructor() { super(); queueMicrotask(() => this.receive({ op: 2, d: {} })); }
      receive(value) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(value) })); }
      send(raw) {
        const request = JSON.parse(raw);
        if (request.op !== 8) throw new Error('Expected caption pair');
        notify({ kind: 'caption', pair: request.d.requests.map(item => item.requestData.inputSettings.text) });
        queueMicrotask(() => this.receive({ op: 9, d: { requestId: request.d.requestId,
          results: request.d.requests.map(() => ({ requestStatus: { result: true } })) } }));
      }
      close() { this.readyState = 3; this.dispatchEvent(new Event('close')); }
    };
    // WindowsでもOSによる強制終了ではなく、アプリの終了ハンドラーを通す。
    process.once('message', () => { process.emit('SIGTERM'); process.disconnect(); });
    // 通信の差し替え後にモジュールの起動処理を実行するため、静的importにはしない。
    await import(${JSON.stringify(new URL('../src/index.js', import.meta.url).href)});
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
    cwd,
    env: {
      PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
      OBS_INPUT_NAME: '字幕', OBS_PREVIOUS_INPUT_NAME: '前字幕',
      UDTALK_PUBLIC_URL: `https://live.udtalk.jp/${a},https://live.udtalk.jp/${b}`,
      POLL_MS: '250', UDTALK_REQUEST_TIMEOUT_MS: '5000',
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await once(child, 'close');
    }
    await rm(cwd, { recursive: true, force: true });
  });
  let output = '';
  child.stdout!.on('data', data => { output += String(data); });
  child.stderr!.on('data', data => { output += String(data); });
  const pairs: string[][] = [];
  const positions: number[][][] = [[], []];
  const pending = new Set<number>();
  const aborted: number[] = [];
  child.on('message', (event: { kind: string; source: number; pair: string[]; position: number[] }) => {
    if (event.kind === 'caption') pairs.push(event.pair);
    if (event.kind === 'poll') positions[event.source].push(event.position);
    if (event.kind === 'aborted') aborted.push(event.source);
    if (event.kind === 'pending') {
      pending.add(event.source);
      if (pending.size === 2) child.send('shutdown');
    }
  });
  const [code, signal] = await once(child, 'close');
  assert.deepEqual({ code, signal }, { code: 0, signal: null }, output);
  assert.deepEqual(pairs, [['B', ''], ['B', 'A'], ['B', 'A訂正']], output);
  assert.deepEqual(positions, [
    [[10, 20], [10, 20], [12, 22]],
    [[100, 200], [101, 201], [102, 202]],
  ], output);
  assert.deepEqual(aborted.sort(), [0, 1], output);
});
