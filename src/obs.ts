import { createHash } from 'node:crypto';
import type { ObsClientOptions } from './config.js';

interface Logger { info(message: string): void; warn(message: string): void; error(message: string): void; }
interface ObsMessage { op: number; d: Record<string, unknown>; }

function sha256Base64(value: string): string { return createHash('sha256').update(value).digest('base64'); }
export function createObsAuthentication(password: string, salt: string, challenge: string): string {
  return sha256Base64(`${sha256Base64(`${password}${salt}`)}${challenge}`);
}

export class ObsClient {
  #socket?: WebSocket;
  #ready = false;
  #sequence = 0;
  #pendingTexts = new Map<string, string>();
  #reconnectTimer?: NodeJS.Timeout;
  readonly url: string;
  readonly password: string;
  readonly inputName: string;
  readonly reconnectMs: number;
  readonly log: Logger;

  constructor({ url, password, inputName, reconnectMs, log = console }: ObsClientOptions & { log?: Logger }) {
    this.url = url; this.password = password; this.inputName = inputName; this.reconnectMs = reconnectMs; this.log = log;
  }

  connect(): void {
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
      this.log.warn(`OBSとの接続が切れました（code: ${code}）。${reason ? ` 理由: ${reason}` : ''} ${this.reconnectMs}ms後に再接続します。`);
      this.#reconnectTimer = setTimeout(() => this.connect(), this.reconnectMs);
    });
    this.#socket.addEventListener('error', () => {});
  }

  setText(text: string): void { this.setTextForInput(this.inputName, text); }
  setTextForInput(inputName: string, text: string): void {
    if (!inputName) return;
    this.#pendingTexts.set(inputName, text);
    this.#flushTexts();
  }

  #handleMessage(raw: unknown): void {
    let message: ObsMessage;
    try { message = JSON.parse(String(raw)) as ObsMessage; } catch { return; }
    if (message.op === 0) {
      const authentication = message.d.authentication as { salt?: string; challenge?: string } | undefined;
      const identify: Record<string, unknown> = { rpcVersion: 1, eventSubscriptions: 0 };
      if (authentication?.salt && authentication.challenge) {
        if (!this.password) this.log.error('OBSは認証を要求していますが、OBS_PASSWORD が空です。.env にパスワードを設定してください。');
        identify.authentication = createObsAuthentication(this.password, authentication.salt, authentication.challenge);
      }
      this.#send({ op: 1, d: identify });
    } else if (message.op === 2) {
      this.#ready = true;
      this.log.info('OBS WebSocketの認証が完了しました。');
      this.#flushTexts();
    } else if (message.op === 7) {
      const status = message.d.requestStatus as { result?: boolean; comment?: string; code?: number } | undefined;
      if (!status?.result) this.log.error(`OBS更新エラー: ${status?.comment || status?.code}`);
    }
  }

  #flushTexts(): void {
    if (!this.#ready) return;
    for (const [inputName, text] of this.#pendingTexts) {
      this.#pendingTexts.delete(inputName);
      this.#send({ op: 6, d: { requestType: 'SetInputSettings', requestId: `udtalk-${++this.#sequence}`, requestData: { inputName, inputSettings: { text }, overlay: true } } });
    }
  }

  #send(message: ObsMessage): void {
    if (this.#socket?.readyState === WebSocket.OPEN) this.#socket.send(JSON.stringify(message));
  }
}

function messageOf(error: unknown): string { return error instanceof Error ? error.message : String(error); }
