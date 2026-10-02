import { createHash } from 'node:crypto';
import type { ObsClientOptions } from './config.js';

interface Logger { info(message: string): void; warn(message: string): void; error(message: string): void; }
interface ObsMessage { op: number; d: Record<string, unknown>; }

function sha256Base64(value: string): string { return createHash('sha256').update(value).digest('base64'); }
export function createObsAuthentication(password: string, salt: string, challenge: string): string {
  // OBS WebSocket v5の認証では、SHA-256とBase64変換を二段階で行う。
  return sha256Base64(`${sha256Base64(`${password}${salt}`)}${challenge}`);
}

export class ObsClient {
  #socket?: WebSocket;
  #ready = false;
  #sequence = 0;
  // 送信待ちと、再接続後にも保持する最新の表示内容を別々に管理する。
  #pendingTexts = new Map<string, string>();
  #desiredTexts = new Map<string, string>();
  #requests = new Map<string, { inputNames: string[]; timer: NodeJS.Timeout }>();
  #reconnectTimer?: NodeJS.Timeout;
  #stopped = false;
  readonly url: string;
  readonly password: string;
  readonly inputName: string;
  readonly reconnectMs: number;
  readonly log: Logger;

  constructor({ url, password, inputName, reconnectMs, log = console }: ObsClientOptions & { log?: Logger }) {
    this.url = url; this.password = password; this.inputName = inputName; this.reconnectMs = reconnectMs; this.log = log;
  }

  connect(): void {
    if (this.#stopped) return;
    clearTimeout(this.#reconnectTimer);
    try { this.#socket = new WebSocket(this.url); }
    catch (error) {
      this.log.error(`OBS URLが不正です: ${JSON.stringify(this.url)} (${messageOf(error)})`);
      this.#reconnectTimer = setTimeout(() => this.connect(), this.reconnectMs);
      return;
    }
    this.#socket.addEventListener('open', () => this.log.info(`OBSに接続しました: ${this.url}`));
    this.#socket.addEventListener('message', ({ data }: MessageEvent) => this.#handleMessage(data));
    this.#socket.addEventListener('close', ({ code, reason }: CloseEvent) => {
      this.#ready = false;
      this.#clearRequests();
      if (this.#stopped) return;
      this.log.warn(`OBSとの接続が切れました（code: ${code}）。${reason ? ` 理由: ${reason}` : ''} ${this.reconnectMs}ms後に再接続します。`);
      this.#reconnectTimer = setTimeout(() => this.connect(), this.reconnectMs);
    });
    this.#socket.addEventListener('error', () => {});
  }

  stop(): void {
    this.#stopped = true;
    this.#ready = false;
    clearTimeout(this.#reconnectTimer);
    this.#clearRequests();
    this.#socket?.close();
    this.#socket = undefined;
  }

  setText(text: string): void { this.setTextForInput(this.inputName, text); }
  setCaptionPair(current: string, previousInputName: string, previous: string): void {
    // 両ソースの値をそろえてから送信し、別の世代の字幕が混ざるのを防ぐ。
    for (const [name, text] of [[this.inputName, current], [previousInputName, previous]]) {
      if (!name) continue;
      this.#desiredTexts.set(name, text);
      this.#pendingTexts.set(name, text);
    }
    this.#flushTexts();
  }
  setTextForInput(inputName: string, text: string): void {
    if (!inputName) return;
    this.#desiredTexts.set(inputName, text);
    this.#pendingTexts.set(inputName, text);
    this.#flushTexts();
  }

  #handleMessage(raw: unknown): void {
    let message: ObsMessage;
    try { message = JSON.parse(String(raw)) as ObsMessage; } catch { return; }
    if (message.op === 0) {
      // Helloへの応答で認証し、不要なOBSイベントは購読しない。
      const authentication = message.d.authentication as { salt?: string; challenge?: string } | undefined;
      const identify: Record<string, unknown> = { rpcVersion: 1, eventSubscriptions: 0 };
      if (authentication?.salt && authentication.challenge) {
        if (!this.password) this.log.error('OBSは認証を要求していますが、OBS_PASSWORD が空です。.env にパスワードを設定してください。');
        identify.authentication = createObsAuthentication(this.password, authentication.salt, authentication.challenge);
      }
      this.#send({ op: 1, d: identify });
    } else if (message.op === 2) {
      // 認証完了後は、切断中に更新した字幕も含めて保持値を再送する。
      this.#ready = true;
      this.#pendingTexts = new Map(this.#desiredTexts);
      this.log.info('OBS WebSocketの認証が完了しました。');
      this.#flushTexts();
    } else if (message.op === 7 || message.op === 9) {
      // 単発・バッチとも、対応する応答を受け取ってから次の更新へ進む。
      const requestId = String(message.d.requestId);
      const request = this.#requests.get(requestId);
      if (!request) return;
      clearTimeout(request.timer);
      this.#requests.delete(requestId);
      const results = message.op === 9 ? message.d.results as { requestStatus?: { result?: boolean; comment?: string; code?: number } }[] : [message.d];
      for (const [index, result] of (results || []).entries()) {
        const status = result.requestStatus as { result?: boolean; comment?: string; code?: number } | undefined;
        if (!status?.result) this.log.error(`OBS更新エラー（${request.inputNames[index]}）: ${status?.comment || status?.code}`);
      }
      this.#flushTexts();
    }
  }

  #flushTexts(): void {
    // 応答待ちは一度に一件。待っている間の更新は最新値へ集約する。
    if (!this.#ready || this.#socket?.readyState !== WebSocket.OPEN || this.#requests.size || !this.#pendingTexts.size) return;
    const texts = [...this.#pendingTexts];
    const requestId = `udtalk-${++this.#sequence}`;
    const timer = setTimeout(() => {
      // 応答を確認できない場合は、再接続後に保持値を送り直す。
      this.log.warn('OBS更新の応答がありません。再接続して最新字幕を再送します。');
      this.#ready = false;
      this.#clearRequests();
      this.#socket?.close();
    }, 5000);
    this.#requests.set(requestId, { inputNames: texts.map(([name]) => name), timer });
    this.#pendingTexts.clear();
    const requests = texts.map(([inputName, text]) => ({ requestType: 'SetInputSettings', requestData: { inputName, inputSettings: { text }, overlay: true } }));
    // 二つの字幕は、描画処理に同期するSerialFrameバッチでまとめて更新する。
    this.#send(requests.length === 1
      ? { op: 6, d: { ...requests[0], requestId } }
      : { op: 8, d: { requestId, executionType: 1, haltOnFailure: false, requests } });
  }

  #clearRequests(): void {
    for (const request of this.#requests.values()) clearTimeout(request.timer);
    this.#requests.clear();
  }

  #send(message: ObsMessage): void {
    if (this.#socket?.readyState === WebSocket.OPEN) this.#socket.send(JSON.stringify(message));
  }
}

function messageOf(error: unknown): string { return error instanceof Error ? error.message : String(error); }
