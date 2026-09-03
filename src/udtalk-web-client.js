const appBaseUrl = 'https://app.udtalk.jp';

export function parsePublicUrl(value) {
  const url = new URL(value);
  const match = url.pathname.match(/^\/([0-9a-z]{64})$/);
  if (url.protocol !== 'https:' || url.hostname !== 'live.udtalk.jp' || !match) {
    throw new Error('UDトークのWeb公開URLではありません。');
  }
  return { viewerUrl: url.toString(), publicId: match[1] };
}

export class UdtalkWebClient {
  #stopped = false;
  #timer;
  #session;
  #lastTextKey = '';

  constructor({ url, pollMs, onText, log = console }) {
    this.url = url;
    this.pollMs = pollMs;
    this.onText = onText;
    this.log = log;
  }

  async start() {
    this.#stopped = false;
    await this.#connect();
  }

  stop() {
    this.#stopped = true;
    clearTimeout(this.#timer);
  }

  async #connect() {
    try {
      const { viewerUrl, publicId } = parsePublicUrl(this.url);
      const page = await fetch(viewerUrl).then(requireOk);
      const html = await page.text();
      const tokenMatch = html.match(/token-txt="[^"]*&quot;hash&quot;:&quot;([0-9a-z]{64})/);
      if (!tokenMatch) throw new Error('公開ページの会話トークンを取得できませんでした。パスコード付きの公開には未対応です。');
      const token = tokenMatch[1];
      const initialize = await this.#post(`web/push/initialize/${publicId}`, { t: token });
      const keyData = await this.#post(`web/pull/webTalk/${publicId}`, { t: token, u: initialize.userid });
      await this.#post(`web/push/signWebTalk/${publicId}`, { t: token, u: initialize.userid, k: keyData.key });
      const current = await this.#post(`web/pull/webTalkCurrent/${publicId}`, { t: token, u: initialize.userid, k: keyData.key });
      this.#session = { publicId, token, user: initialize.userid, key: keyData.key, number: current.number, current: current.current };
      this.log.info('UDトークWeb公開に接続しました。新しい確定発話をOBSへ転送します。');
      this.#schedulePoll(0);
    } catch (error) {
      this.log.warn(`UDトークWeb公開への接続に失敗しました: ${error.message}。${this.pollMs}ms後に再試行します。`);
      this.#scheduleConnect();
    }
  }

  #scheduleConnect() {
    if (!this.#stopped) this.#timer = setTimeout(() => this.#connect(), this.pollMs);
  }

  #schedulePoll(delay = this.pollMs) {
    if (!this.#stopped) this.#timer = setTimeout(() => this.#poll(), delay);
  }

  async #poll() {
    try {
      const s = this.#session;
      const data = await this.#post(
        `web/pull/webTalkMessage/${s.publicId}`,
        { u: s.user, t: s.token, k: s.key, l: s.number, c: s.current },
        [1, 5],
      );
      s.number = data.number ?? s.number;
      s.current = data.current ?? s.current;
      for (const group of data.messages || []) {
        for (const message of group) this.#handleMessage(message);
      }
      this.#schedulePoll();
    } catch (error) {
      this.log.warn(`UDトーク会話の取得に失敗しました: ${error.message}。再接続します。`);
      this.#scheduleConnect();
    }
  }

  #handleMessage(message) {
    if (message.qualify !== 1 || !message.meta) return;
    let meta;
    try { meta = JSON.parse(message.meta); } catch { return; }
    if (meta.phase !== 'finalized' || !meta.text?.trim()) return;
    const text = meta.text.trim();
    const key = `${meta.utteranceIdentifier}:${text}`;
    if (key === this.#lastTextKey) return;
    this.#lastTextKey = key;
    this.onText(text);
  }

  async #post(path, body, acceptedStatuses = [1]) {
    const response = await fetch(`${appBaseUrl}/${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }).then(requireOk);
    const data = await response.json();
    if (!acceptedStatuses.includes(data.status)) throw new Error(`UDトークAPIの応答 status=${data.status}`);
    return data;
  }
}

function requireOk(response) {
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response;
}
