// Web閲覧ページが利用する通信先。公開された安定API仕様ではない点に注意。
const appBaseUrl = 'https://app.udtalk.jp';
import type { Utterance } from './caption-history.js';
import { describeError, redactErrorText } from './error-details.js';
import { ConnectionDiagnostics } from './connection-diagnostics.js';
import { Agent } from 'undici';
interface Logger { info(message: string): void; warn(message: string): void; }
interface Session { publicId: string; token: string; user: string; key: string; number: number; current: number; }
interface ApiResponse { status: number; requires?: boolean; userid?: string; key?: string; number?: number; current?: number; messages?: UdtalkMessage[][]; }
interface UdtalkMessage { qualify: number; meta?: string; }
interface Meta { phase?: string; text?: string; utteranceIdentifier?: string; timestamp?: string | number; }

export function parsePublicUrl(value: string): { viewerUrl: string; publicId: string } {
  const url = new URL(value);
  const match = url.pathname.match(/^\/([0-9a-z]{64})$/);
  if (url.protocol !== 'https:' || url.hostname !== 'live.udtalk.jp' || !match) throw new Error('UDトークのWeb公開URLではありません。');
  return { viewerUrl: url.toString(), publicId: match[1] };
}

export class UdtalkWebClient {
  #dispatcher?: Agent;
  #passcode: string;
  #authToken = '';
  #authSecrets: string[] = [];
  #connectionDiagnostics: ConnectionDiagnostics;
  #consecutiveConnectFailures = 0;
  #stopped = false; #timer?: NodeJS.Timeout; #abortController?: AbortController; #session?: Session; #seenTextKeys = new Set<string>(); #consecutivePollFailures = 0; #reportedPollFailure = false;
  readonly url: string; readonly pollMs: number; readonly onText: (text: string, utterance: Utterance) => void; readonly log: Logger;
  readonly requestTimeoutMs: number; readonly retryMaxMs: number;
  constructor({ url, passcode = '', pollMs, requestTimeoutMs = 5000, retryMaxMs = 10000, onText, log = console }: { url: string; passcode?: string; pollMs: number; requestTimeoutMs?: number; retryMaxMs?: number; onText: (text: string, utterance: Utterance) => void; log?: Logger }) {
    this.url = url; this.pollMs = pollMs; this.onText = onText; this.log = log;
    this.#passcode = passcode;
    this.requestTimeoutMs = requestTimeoutMs; this.retryMaxMs = retryMaxMs;
    this.#connectionDiagnostics = new ConnectionDiagnostics(message => { if (!this.#stopped) this.log.info(message); });
  }
  async start(): Promise<void> {
    this.#stopped = false;
    // 全体のAbortSignalだけでは接続中ソケットが残るため、接続処理にも上限を設ける。
    this.#dispatcher ??= new Agent({ connect: { timeout: Math.min(2000, this.requestTimeoutMs) }, allowH2: true });
    this.#connectionDiagnostics.start(); await this.#connect();
  }
  stop(): void {
    this.#connectionDiagnostics.stop();
    this.#stopped = true; clearTimeout(this.#timer); this.#abortController?.abort();
    const dispatcher = this.#dispatcher; this.#dispatcher = undefined;
    if (dispatcher) void dispatcher.destroy().catch(error => this.log.warn(`UDトーク通信の終了に失敗しました: ${this.#safeMessage(error)}`));
  }
  async #connect(): Promise<void> {
    if (this.#stopped) return;
    try {
      const { viewerUrl, publicId } = parsePublicUrl(this.url);
      this.#authToken = ''; this.#authSecrets = [];
      const { html, cookies } = await this.#communicate('公開ページ取得', 'live.udtalk.jp', [publicId], async signal => {
        const response = await requireOk(fetch(viewerUrl, { signal, dispatcher: this.#dispatcher } as RequestInit & { dispatcher: Agent }));
        const cookies = response.headers.getSetCookie().map(cookie => cookie.split(';', 1)[0]);
        this.#authSecrets = cookies.map(cookie => cookie.slice(cookie.indexOf('=') + 1));
        return { html: await response.text(), cookies };
      });
      if (this.#stopped) return;
      const token = html.match(/token-txt="[^"]*&quot;hash&quot;:&quot;([0-9a-z]{64})/)?.[1];
      if (!token) throw new Error('公開ページの会話トークンを取得できませんでした。Web公開が有効か確認してください。');
      await this.#authenticate(publicId, cookies);
      if (this.#stopped) return;
      // 閲覧セッションを作成し、取得開始位置を問い合わせる。
      const initialize = await this.#post(`web/push/initialize/${publicId}`, { t: token });
      if (!initialize.userid) throw new Error('UDトークAPIのユーザー情報を取得できませんでした。');
      const keyData = await this.#post(`web/pull/webTalk/${publicId}`, { t: token, u: initialize.userid });
      if (!keyData.key) throw new Error('UDトークAPIの接続情報が不完全です。');
      await this.#post(`web/push/signWebTalk/${publicId}`, { t: token, u: initialize.userid, k: keyData.key });
      const current = await this.#post(`web/pull/webTalkCurrent/${publicId}`, { t: token, u: initialize.userid, k: keyData.key });
      if (current.number === undefined || current.current === undefined) throw new Error('UDトークAPIの会話位置を取得できませんでした。');
      const previous = this.#session;
      // 初回は最新位置から開始。同じトークの再接続では未取得位置を引き継ぐ。
      const resume = previous?.token === token && previous.number <= current.number && previous.current <= current.current;
      this.#session = { publicId, token, user: initialize.userid, key: keyData.key,
        number: resume ? previous.number : current.number,
        current: resume ? previous.current : current.current };
      this.#consecutiveConnectFailures = 0;
      this.log.info('UDトークWeb公開に接続しました。新しい確定発話をOBSへ転送します。'); this.#schedulePoll(0);
    } catch (error) {
      if (this.#stopped) return;
      const delay = this.#retryDelay(++this.#consecutiveConnectFailures);
      this.log.warn(`UDトークWeb公開への接続に失敗しました: ${this.#safeMessage(error)}。${delay}ms後に再試行します。`); this.#scheduleConnect(delay);
    }
  }
  async #authenticate(publicId: string, cookies: string[]): Promise<void> {
    const auth = await this.#post(`web/pull/checkAuth/${publicId}`, { t: publicId });
    if (this.#stopped) return;
    if (auth.requires === false) return;
    if (auth.requires !== true) throw new Error('UDトークのパスコード認証の要否を確認できませんでした。');
    if (!this.#passcode) throw new Error('Web公開にはパスコードが必要です。UDTALK_PASSCODES（--udtalk-passcodes）のURL別設定、または共通値 UDTALK_PASSCODE（--udtalk-passcode）を設定してください。');
    const xsrfCookie = cookies.find(cookie => cookie.startsWith('XSRF-TOKEN='));
    if (!xsrfCookie) throw new Error('パスコード認証に必要なCookieを取得できませんでした。');
    const xsrf = decodeURIComponent(xsrfCookie.slice('XSRF-TOKEN='.length));
    this.#authSecrets.push(xsrf);
    await this.#communicate('パスコード認証', 'live.udtalk.jp', [publicId], async signal => {
      const response = await requireOk(fetch('https://live.udtalk.jp/api/login', {
        method: 'POST', redirect: 'error',
        headers: { 'content-type': 'application/json', accept: 'application/json', cookie: cookies.join('; '), 'X-XSRF-TOKEN': xsrf },
        body: JSON.stringify({ url: publicId, passcode: this.#passcode }), signal, dispatcher: this.#dispatcher,
      } as RequestInit & { dispatcher: Agent }));
      const data = await response.json() as { status: number; token?: unknown };
      if (data.status !== 1) throw new Error('パスコード認証に失敗しました。UDTALK_PASSCODES の該当URLの値、または共通値 UDTALK_PASSCODE を確認してください。');
      if (typeof data.token !== 'string' || !data.token) throw new Error('パスコード認証のトークンを取得できませんでした。');
      this.#authToken = data.token;
    });
  }
  #scheduleConnect(delay = this.pollMs): void { if (!this.#stopped) this.#timer = setTimeout(() => void this.#connect(), delay); }
  // 最初の失敗は通常間隔。連続失敗時だけ指数的に延ばし、上限を守る。
  #retryDelay(failures: number): number { return Math.min(this.retryMaxMs, this.pollMs * 2 ** Math.min(failures - 1, 31)); }
  // 取得の完了後に次回を予約し、複数の取得を並行して走らせない。
  #schedulePoll(delay = this.pollMs): void { if (!this.#stopped) this.#timer = setTimeout(() => void this.#poll(), delay); }
  async #poll(): Promise<void> {
    if (this.#stopped) return;
    try {
      const s = this.#session; if (!s) throw new Error('UDトークの接続情報がありません。');
      const data = await this.#post(`web/pull/webTalkMessage/${s.publicId}`, { u: s.user, t: s.token, k: s.key, l: s.number, c: s.current }, [1, 5]);
      if (this.#stopped) return;
      // 発話を処理してから取得位置を進め、失敗時の取りこぼしを防ぐ。
      for (const group of data.messages || []) for (const message of group) this.#handleMessage(message);
      s.number = data.number ?? s.number; s.current = data.current ?? s.current;
      if (this.#reportedPollFailure) this.log.info('UDトーク会話の取得が復旧しました。');
      this.#consecutivePollFailures = 0; this.#reportedPollFailure = false; this.#schedulePoll();
    } catch (error) {
      if (this.#stopped) return;
      const message = this.#safeMessage(error);
      // セッション無効時だけ再接続し、一時的な通信失敗は同じ位置から再試行する。
      const apiError = error instanceof Error ? error.cause : undefined;
      if (apiError instanceof UdtalkApiError && (apiError.status === 4 || apiError.status === 7)) { this.log.warn(`UDトーク会話のセッションが無効です: ${message}。再接続します。`); this.#scheduleConnect(); }
      else {
        this.#consecutivePollFailures += 1;
        const delay = this.#retryDelay(this.#consecutivePollFailures);
        if (this.#consecutivePollFailures >= 3 && !this.#reportedPollFailure) { this.log.warn(`UDトーク会話の取得に${this.#consecutivePollFailures}回連続で失敗しました: ${message}。同じ位置から再試行します。`); this.#reportedPollFailure = true; }
        this.log.info(`UDトーク会話の再試行待ち: 連続失敗=${this.#consecutivePollFailures}回, 待ち時間=${delay}ms。同じ位置から再試行します。`);
        this.#schedulePoll(delay);
      }
    }
  }
  #handleMessage(message: UdtalkMessage): void {
    // 確定発話だけを転送。同じIDでも本文が訂正された場合は再処理する。
    if (message.qualify !== 1 || !message.meta) return;
    let meta: Meta; try { meta = JSON.parse(message.meta) as Meta; } catch { return; }
    if (meta.phase !== 'finalized' || !meta.text?.trim()) return;
    const text = meta.text.trim(); const key = `${meta.utteranceIdentifier}:${text}`;
    if (this.#seenTextKeys.has(key)) return;
    const timestamp = meta.timestamp === undefined ? undefined : Number(meta.timestamp);
    this.onText(text, { id: meta.utteranceIdentifier || key,
      timestamp: timestamp !== undefined && Number.isFinite(timestamp) ? timestamp : undefined });
    this.#seenTextKeys.add(key);
    if (this.#seenTextKeys.size > 1_000) this.#seenTextKeys.delete(this.#seenTextKeys.values().next().value as string);
  }
  async #post(path: string, body: Record<string, string | number>, acceptedStatuses = [1]): Promise<ApiResponse> {
    return this.#communicate(path.split('/').slice(0, 3).join('/'), 'app.udtalk.jp', Object.values(body).filter((value): value is string => typeof value === 'string'), async signal => {
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (this.#authToken) headers['X-UD-Authorization'] = this.#authToken;
      const response = await requireOk(fetch(`${appBaseUrl}/${path}`, {
        method: 'POST', redirect: 'error', headers, body: JSON.stringify(body), signal, dispatcher: this.#dispatcher,
      } as RequestInit & { dispatcher: Agent }));
      const data = await response.json() as ApiResponse;
      if (!acceptedStatuses.includes(data.status)) throw new UdtalkApiError(data.status);
      return data;
    });
  }
  #secrets(): string[] {
    const s = this.#session;
    return [this.url, this.#passcode, this.#authToken, ...this.#authSecrets, ...(s ? [s.publicId, s.token, s.user, s.key] : [])];
  }
  #safeMessage(error: unknown): string { return redactErrorText(messageOf(error), this.#secrets()); }
  async #communicate<T>(operation: string, hostname: string, secrets: string[], run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    // 本文の受信・解析まで計測し、通信失敗時だけ安全な診断ログを出す。
    this.#abortController = new AbortController();
    const started = performance.now();
    const trace = this.#connectionDiagnostics.begin(hostname, operation);
    try {
      const result = await trace.run(() => run(AbortSignal.any([this.#abortController!.signal, AbortSignal.timeout(this.requestTimeoutMs)])));
      if (!this.#stopped && this.#connectionDiagnostics.shouldReportSuccess(operation, trace)) this.log.info(`UDトーク接続診断: 処理=${operation}, ${trace.summary()}`);
      return result;
    } catch (error) {
      if (!this.#stopped) {
        this.#connectionDiagnostics.failure(operation);
        this.log.warn(`UDトーク通信失敗: 処理=${operation}, 経過=${Math.round(performance.now() - started)}ms, タイムアウト設定=${this.requestTimeoutMs}ms, 接続待ち上限=${Math.min(2000, this.requestTimeoutMs)}ms, ${describeError(error, [...this.#secrets(), ...secrets])}, ${trace.summary()}`);
      }
      throw new Error(redactErrorText(messageOf(error), [...this.#secrets(), ...secrets]), { cause: error });
    } finally {
      trace.close();
    }
  }
}
class UdtalkApiError extends Error {
  constructor(readonly status: number) { super(`UDトークAPIの応答 status=${status}`); }
}
async function requireOk(response: Promise<Response> | Response): Promise<Response> { const value = await response; if (!value.ok) throw new Error(`HTTP ${value.status}`); return value; }
function messageOf(error: unknown): string { return error instanceof Error ? error.message : String(error); }
