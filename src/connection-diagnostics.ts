import { AsyncLocalStorage } from 'node:async_hooks';
import { channel } from 'node:diagnostics_channel';
import { isIP, type Socket } from 'node:net';
import type { TLSSocket } from 'node:tls';

interface Connection {
  id: number;
  started: number;
  ips: Set<string>;
  tcpMs?: number;
  tlsMs?: number;
  tlsSessionReused?: boolean;
  alpn?: string;
  uses: number;
}

// fetchの実装・設定は変更せず、対象の通信コンテキスト内だけを観測する。
const context = new AsyncLocalStorage<ConnectionTrace>();

export class ConnectionDiagnostics {
  #connections = new WeakMap<Socket, Connection>();
  #sequence = 0;
  #reported = new Set<string>();
  #failed = new Set<string>();

  begin(hostname: string): ConnectionTrace { return new ConnectionTrace(this, hostname); }

  connection(socket: Socket, fresh: boolean): Connection {
    let connection = this.#connections.get(socket);
    if (!connection) {
      connection = { id: ++this.#sequence, started: performance.now(), ips: new Set(), uses: 0 };
      this.#connections.set(socket, connection);
      // 新規作成を観測していないソケットは、接続所要時間を推測しない。
      if (!fresh && socket.remoteAddress && isIP(socket.remoteAddress)) connection.ips.add(socket.remoteAddress);
    }
    return connection;
  }

  shouldReportSuccess(operation: string, trace: ConnectionTrace): boolean {
    if (!trace.observed) return false;
    const key = `${operation}:${trace.mode}`;
    const report = !this.#reported.has(key) || this.#failed.has(operation);
    this.#reported.add(key);
    this.#failed.delete(operation);
    return report;
  }

  failure(operation: string): void { this.#failed.add(operation); }
}

export class ConnectionTrace {
  #active = true;
  #connecting = false;
  #attempts = 0;
  #sent = false;
  #requests = new WeakSet<object>();
  #sockets = new Map<Socket, { connection: Connection; fresh: boolean; reused?: boolean }>();
  #cleanup: (() => void)[] = [];

  constructor(readonly diagnostics: ConnectionDiagnostics, readonly hostname: string) {
    this.#subscribe('undici:client:beforeConnect', message => {
      const params = message.connectParams as { hostname?: string } | undefined;
      if (context.getStore() !== this || params?.hostname !== hostname) return;
      this.#connecting = true;
      this.#attempts++;
    });
    this.#subscribe('net.client.socket', message => {
      if (context.getStore() !== this || !this.#connecting) return;
      const socket = message.socket as Socket | undefined;
      if (socket && typeof socket.on === 'function') this.#watch(socket, true);
    });
    this.#subscribe('undici:request:create', message => {
      const request = message.request as { origin?: string } | undefined;
      if (context.getStore() !== this || !request) return;
      if (new URL(String(request.origin)).hostname === hostname) this.#requests.add(request);
    });
    this.#subscribe('undici:client:sendHeaders', message => {
      const request = message.request as object | undefined;
      const socket = message.socket as Socket | undefined;
      if (!request || !this.#requests.has(request) || !socket) return;
      this.#sent = true;
      const entry = this.#watch(socket, false);
      entry.reused = entry.connection.uses > 0 ? true : entry.fresh ? false : undefined;
      entry.connection.uses++;
    });
  }

  run<T>(task: () => Promise<T>): Promise<T> { return context.run(this, task); }
  get observed(): boolean { return this.#attempts > 0 || this.#sockets.size > 0; }
  get mode(): string {
    const values = [...this.#sockets.values()];
    if (values.some(entry => entry.reused === true)) return '再利用';
    if (values.some(entry => entry.fresh)) return '新規';
    return '未判定';
  }

  summary(): string {
    const details = [...this.#sockets.values()].map(({ connection: c, fresh, reused }) => {
      const tcp = c.tcpMs === undefined ? '未観測' : `成立(${c.tcpMs}ms)`;
      const tls = c.tlsMs === undefined ? '未観測' : `成立(${c.tlsMs}ms)`;
      const reuse = reused === true ? 'あり' : reused === false || fresh ? 'なし(新規)' : '未判定';
      return `接続#${c.id}: IP=${[...c.ips].join('/') || '未観測'}, TCP=${tcp}, TLS=${tls}, 接続再利用=${reuse}, TLSセッション再開=${c.tlsSessionReused === undefined ? '未観測' : c.tlsSessionReused ? 'あり' : 'なし'}, ALPN=${c.alpn || '未観測'}`;
    });
    return `接続診断={新規接続試行=${this.#attempts}, HTTPヘッダー送信通知=${this.#sent ? 'あり' : '未観測'}, ${details.join('; ') || 'ソケット情報=未観測'}}`;
  }

  #watch(socket: Socket, fresh: boolean) {
    const existing = this.#sockets.get(socket);
    if (existing) return existing;
    const connection = this.diagnostics.connection(socket, fresh);
    const entry = { connection, fresh, reused: undefined as boolean | undefined };
    this.#sockets.set(socket, entry);
    const rememberIP = (address: unknown) => { if (typeof address === 'string' && isIP(address)) connection.ips.add(address); };
    const elapsed = () => Math.round(performance.now() - connection.started);
    this.#listen(socket, 'lookup', (_error, address) => rememberIP(address));
    this.#listen(socket, 'connectionAttempt', address => rememberIP(address));
    this.#listen(socket, 'connect', () => {
      rememberIP(socket.remoteAddress);
      connection.tcpMs = elapsed();
    });
    this.#listen(socket, 'secureConnect', () => {
      rememberIP(socket.remoteAddress);
      connection.tlsMs = elapsed();
      const tls = socket as TLSSocket;
      if (typeof tls.isSessionReused === 'function') connection.tlsSessionReused = tls.isSessionReused();
      if (tls.alpnProtocol === 'h2' || tls.alpnProtocol === 'http/1.1') connection.alpn = tls.alpnProtocol;
      else if (tls.alpnProtocol === false) connection.alpn = 'ネゴシエーションなし';
    });
    return entry;
  }

  #subscribe(name: string, handler: (message: Record<string, unknown>) => void): void {
    const target = channel(name);
    const callback = (message: unknown) => {
      // 診断チャンネルの仕様差や通知遅延が、本来の通信を壊さないようにする。
      if (!this.#active || typeof message !== 'object' || message === null) return;
      try { handler(message as Record<string, unknown>); } catch { /* 未取得の情報は未観測として扱う。 */ }
    };
    target.subscribe(callback);
    this.#cleanup.push(() => target.unsubscribe(callback));
  }

  #listen(socket: Socket, event: string, handler: (...args: unknown[]) => void): void {
    const callback = (...args: unknown[]) => {
      if (!this.#active) return;
      try { handler(...args); } catch { /* 診断の失敗を通信側へ伝播させない。 */ }
    };
    socket.on(event, callback);
    this.#cleanup.push(() => socket.off(event, callback));
  }

  close(): void {
    this.#active = false;
    for (const cleanup of this.#cleanup.splice(0)) cleanup();
    this.#sockets.clear();
  }
}
