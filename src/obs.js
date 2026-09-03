import { createHash } from 'node:crypto';

function sha256Base64(value) {
  return createHash('sha256').update(value).digest('base64');
}

export function createObsAuthentication(password, salt, challenge) {
  return sha256Base64(`${sha256Base64(`${password}${salt}`)}${challenge}`);
}

export class ObsClient {
  #socket;
  #ready = false;
  #sequence = 0;
  #pendingText;
  #reconnectTimer;

  constructor({ url, password, inputName, reconnectMs, log = console }) {
    this.url = url;
    this.password = password;
    this.inputName = inputName;
    this.reconnectMs = reconnectMs;
    this.log = log;
  }

  connect() {
    clearTimeout(this.#reconnectTimer);
    try {
      this.#socket = new WebSocket(this.url);
    } catch (error) {
      this.log.error(`OBS URLが不正です: ${JSON.stringify(this.url)} (${error.message})`);
      this.#reconnectTimer = setTimeout(() => this.connect(), this.reconnectMs);
      return;
    }
    this.#socket.addEventListener('open', () => this.log.info(`OBSに接続しました: ${this.url}`));
    this.#socket.addEventListener('message', ({ data }) => this.#handleMessage(data));
    this.#socket.addEventListener('close', ({ code, reason }) => {
      this.#ready = false;
      const detail = reason ? ` 理由: ${reason}` : '';
      this.log.warn(`OBSとの接続が切れました（code: ${code}）。${detail} ${this.reconnectMs}ms後に再接続します。`);
      this.#reconnectTimer = setTimeout(() => this.connect(), this.reconnectMs);
    });
    this.#socket.addEventListener('error', () => {}); // close イベントで再接続する
  }

  setText(text) {
    this.#pendingText = text;
    this.#flushText();
  }

  #handleMessage(raw) {
    let message;
    try { message = JSON.parse(String(raw)); } catch { return; }
    if (message.op === 0) {
      const authentication = message.d.authentication;
      const identify = { rpcVersion: 1, eventSubscriptions: 0 };
      if (authentication) {
        if (!this.password) {
          this.log.error('OBSは認証を要求していますが、OBS_PASSWORD が空です。.env にパスワードを設定してください。');
        }
        identify.authentication = createObsAuthentication(
          this.password, authentication.salt, authentication.challenge,
        );
      }
      this.#send({ op: 1, d: identify });
    } else if (message.op === 2) {
      this.#ready = true;
      this.log.info('OBS WebSocketの認証が完了しました。');
      this.#flushText();
    } else if (message.op === 7 && !message.d.requestStatus?.result) {
      this.log.error(`OBS更新エラー: ${message.d.requestStatus?.comment || message.d.requestStatus?.code}`);
    }
  }

  #flushText() {
    if (!this.#ready || this.#pendingText === undefined) return;
    const text = this.#pendingText;
    this.#pendingText = undefined;
    this.#send({
      op: 6,
      d: {
        requestType: 'SetInputSettings',
        requestId: `udtalk-${++this.#sequence}`,
        requestData: { inputName: this.inputName, inputSettings: { text }, overlay: true },
      },
    });
  }

  #send(message) {
    if (this.#socket?.readyState === WebSocket.OPEN) this.#socket.send(JSON.stringify(message));
  }
}
