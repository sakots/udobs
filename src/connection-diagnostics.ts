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
  operation: string;
  response?: { status?: number; connection: string; keepAlive: string };
}

// 許可したヘッダーの既知の値だけを残し、未知の拡張値は保存しない。
export function connectionHeaders(headers: unknown): { connection: string; keepAlive: string } {
  const selected: Record<string, string[]> = { connection: [], 'keep-alive': [] };
  const add = (key: unknown, value: unknown) => {
    const name = Buffer.isBuffer(key) ? key.toString('utf8').toLowerCase() : String(key).toLowerCase();
    if (name !== 'connection' && name !== 'keep-alive') return;
    const values = Array.isArray(value) ? value : [value];
    for (const item of values) if (typeof item === 'string' || Buffer.isBuffer(item)) selected[name].push(item.toString());
  };
  if (typeof headers === 'string') {
    for (const line of headers.split(/\r?\n/)) {
      const match = line.match(/^(connection|keep-alive):\s*(.*)$/i);
      if (match) add(match[1], match[2]);
    }
  } else if (Array.isArray(headers)) {
    for (let index = 0; index < headers.length; index += 2) add(headers[index], headers[index + 1]);
  } else if (headers && typeof headers === 'object') {
    for (const [key, value] of Object.entries(headers)) add(key, value);
  }
  const connection = selected.connection.flatMap(value => value.split(',')).map(value => {
    const token = value.trim().toLowerCase();
    return ['close', 'keep-alive', 'upgrade'].includes(token) ? token : '[その他非公開]';
  });
  const keepAlive = selected['keep-alive'].flatMap(value => value.split(',')).map(value => {
    const match = value.trim().match(/^(timeout|max)\s*=\s*(\d{1,10}(?:\.\d{1,6})?)$/i);
    return match ? `${match[1].toLowerCase()}=${match[2]}` : '[その他非公開]';
  });
  return { connection: [...new Set(connection)].join(',').slice(0, 160) || 'なし', keepAlive: keepAlive.join(',').slice(0, 160) || 'なし' };
}

// fetchの実装・設定は変更せず、対象の通信コンテキスト内だけを観測する。
const context = new AsyncLocalStorage<ConnectionTrace>();

export class ConnectionDiagnostics {
  #connections = new WeakMap<Socket, Connection>();
  #sequence = 0;
  #reported = new Set<string>();
  #failed = new Set<string>();
  #socketCleanups = new Map<Socket, () => void>();
  #stopped = false;

  constructor(readonly log: (message: string) => void = () => {}) {}

  begin(hostname: string, operation = '未指定'): ConnectionTrace { return new ConnectionTrace(this, hostname, operation); }

  connection(socket: Socket, fresh: boolean, operation: string): Connection {
    let connection = this.#connections.get(socket);
    if (!connection) {
      connection = { id: ++this.#sequence, started: performance.now(), ips: new Set(), uses: 0, operation };
      this.#connections.set(socket, connection);
      // 新規作成を観測していないソケットは、接続所要時間を推測しない。
      if (!fresh && socket.remoteAddress && isIP(socket.remoteAddress)) connection.ips.add(socket.remoteAddress);
    }
    connection.operation = operation;
    if (!this.#stopped && !socket.destroyed && !this.#socketCleanups.has(socket)) this.#watchEnd(socket, connection);
    return connection;
  }

  #watchEnd(socket: Socket, connection: Connection): void {
    // end/closeはfetch完了後にも届くため、ソケット寿命まで別途観測する。
    let receivedEnd = false;
    let sentEnd = false;
    let errorCode = '未観測';
    const onEnd = () => { receivedEnd = true; };
    const onFinish = () => { sentEnd = true; };
    const onError = (error: unknown) => {
      const code = (error as { code?: unknown } | null)?.code;
      errorCode = typeof code === 'string' && /^[A-Z0-9_.-]{1,80}$/.test(code) ? code : 'コードなし';
    };
    const cleanup = () => {
      socket.off('end', onEnd); socket.off('finish', onFinish);
      socket.off('error', onError); socket.off('close', onClose);
      this.#socketCleanups.delete(socket);
    };
    const onClose = (hadError: boolean) => {
      cleanup();
      const response = connection.response;
      try {
        this.log(`UDトークソケット終了: 処理=${connection.operation}, 接続#${connection.id}, ソケット経過=${Math.round(performance.now() - connection.started)}ms, 使用回数=${connection.uses}, HTTP=${response?.status ?? '未観測'}, 応答Connection=${response?.connection ?? '未観測'}, 応答Keep-Alive=${response?.keepAlive ?? '未観測'}, 受信終了(end)=${receivedEnd ? 'あり' : '未観測'}, 送信終了(finish)=${sentEnd ? 'あり' : '未観測'}, close.hadError=${Boolean(hadError)}, エラーコード=${errorCode}`);
      } catch { /* 終了ログの失敗で通信処理を壊さない。 */ }
    };
    socket.on('end', onEnd); socket.on('finish', onFinish);
    socket.on('error', onError); socket.on('close', onClose);
    this.#socketCleanups.set(socket, cleanup);
  }

  stop(): void {
    this.#stopped = true;
    for (const cleanup of [...this.#socketCleanups.values()]) cleanup();
  }

  start(): void { this.#stopped = false; }

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
  #requestSockets = new WeakMap<object, Connection>();
  #response?: { status?: number; connection: string; keepAlive: string };
  #requestConnection = '未観測';
  #sockets = new Map<Socket, { connection: Connection; fresh: boolean; reused?: boolean }>();
  #cleanup: (() => void)[] = [];

  constructor(readonly diagnostics: ConnectionDiagnostics, readonly hostname: string, readonly operation: string) {
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
      this.#requestConnection = connectionHeaders(message.headers).connection;
      const entry = this.#watch(socket, false);
      entry.reused = entry.connection.uses > 0 ? true : entry.fresh ? false : undefined;
      entry.connection.uses++;
      this.#requestSockets.set(request, entry.connection);
    });
    this.#subscribe('undici:request:headers', message => {
      const request = message.request as object | undefined;
      if (!request || !this.#requests.has(request)) return;
      const response = message.response as { statusCode?: unknown; headers?: unknown } | undefined;
      if (!response) return;
      this.#response = { status: typeof response.statusCode === 'number' ? response.statusCode : undefined, ...connectionHeaders(response.headers) };
      const connection = this.#requestSockets.get(request);
      if (connection) connection.response = this.#response;
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
    return `接続診断={新規接続試行=${this.#attempts}, HTTPヘッダー送信通知=${this.#sent ? 'あり' : '未観測'}, 要求Connection=${this.#requestConnection}, HTTP=${this.#response?.status ?? '未観測'}, 応答Connection=${this.#response?.connection ?? '未観測'}, 応答Keep-Alive=${this.#response?.keepAlive ?? '未観測'}, ${details.join('; ') || 'ソケット情報=未観測'}}`;
  }

  #watch(socket: Socket, fresh: boolean) {
    const existing = this.#sockets.get(socket);
    if (existing) return existing;
    const connection = this.diagnostics.connection(socket, fresh, this.operation);
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
