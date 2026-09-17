const appBaseUrl = 'https://app.udtalk.jp';
interface Logger { info(message: string): void; warn(message: string): void; }
interface Session { publicId: string; token: string; user: string; key: string; number: number; current: number; }
interface ApiResponse { status: number; userid?: string; key?: string; number?: number; current?: number; messages?: UdtalkMessage[][]; }
interface UdtalkMessage { qualify: number; meta?: string; }
interface Meta { phase?: string; text?: string; utteranceIdentifier?: string; }

export function parsePublicUrl(value: string): { viewerUrl: string; publicId: string } {
  const url = new URL(value);
  const match = url.pathname.match(/^\/([0-9a-z]{64})$/);
  if (url.protocol !== 'https:' || url.hostname !== 'live.udtalk.jp' || !match) throw new Error('UDトークのWeb公開URLではありません。');
  return { viewerUrl: url.toString(), publicId: match[1] };
}

export class UdtalkWebClient {
  #stopped = false; #timer?: NodeJS.Timeout; #session?: Session; #lastTextKey = ''; #consecutivePollFailures = 0; #reportedPollFailure = false;
  readonly url: string; readonly pollMs: number; readonly onText: (text: string) => void; readonly log: Logger;
  constructor({ url, pollMs, onText, log = console }: { url: string; pollMs: number; onText: (text: string) => void; log?: Logger }) {
    this.url = url; this.pollMs = pollMs; this.onText = onText; this.log = log;
  }
  async start(): Promise<void> { this.#stopped = false; await this.#connect(); }
  stop(): void { this.#stopped = true; clearTimeout(this.#timer); }
  async #connect(): Promise<void> {
    try {
      const { viewerUrl, publicId } = parsePublicUrl(this.url);
      const html = await (await requireOk(fetch(viewerUrl))).text();
      const token = html.match(/token-txt="[^"]*&quot;hash&quot;:&quot;([0-9a-z]{64})/)?.[1];
      if (!token) throw new Error('公開ページの会話トークンを取得できませんでした。パスコード付きの公開には未対応です。');
      const initialize = await this.#post(`web/push/initialize/${publicId}`, { t: token });
      if (!initialize.userid) throw new Error('UDトークAPIのユーザー情報を取得できませんでした。');
      const keyData = await this.#post(`web/pull/webTalk/${publicId}`, { t: token, u: initialize.userid });
      if (!keyData.key) throw new Error('UDトークAPIの接続情報が不完全です。');
      await this.#post(`web/push/signWebTalk/${publicId}`, { t: token, u: initialize.userid, k: keyData.key });
      const current = await this.#post(`web/pull/webTalkCurrent/${publicId}`, { t: token, u: initialize.userid, k: keyData.key });
      if (current.number === undefined || current.current === undefined) throw new Error('UDトークAPIの会話位置を取得できませんでした。');
      this.#session = { publicId, token, user: initialize.userid, key: keyData.key, number: current.number, current: current.current };
      this.log.info('UDトークWeb公開に接続しました。新しい確定発話をOBSへ転送します。'); this.#schedulePoll(0);
    } catch (error) { this.log.warn(`UDトークWeb公開への接続に失敗しました: ${messageOf(error)}。${this.pollMs}ms後に再試行します。`); this.#scheduleConnect(); }
  }
  #scheduleConnect(): void { if (!this.#stopped) this.#timer = setTimeout(() => void this.#connect(), this.pollMs); }
  #schedulePoll(delay = this.pollMs): void { if (!this.#stopped) this.#timer = setTimeout(() => void this.#poll(), delay); }
  async #poll(): Promise<void> {
    try {
      const s = this.#session; if (!s) throw new Error('UDトークの接続情報がありません。');
      const data = await this.#post(`web/pull/webTalkMessage/${s.publicId}`, { u: s.user, t: s.token, k: s.key, l: s.number, c: s.current }, [1, 5]);
      s.number = data.number ?? s.number; s.current = data.current ?? s.current;
      for (const group of data.messages || []) for (const message of group) this.#handleMessage(message);
      if (this.#reportedPollFailure) this.log.info('UDトーク会話の取得が復旧しました。');
      this.#consecutivePollFailures = 0; this.#reportedPollFailure = false; this.#schedulePoll();
    } catch (error) {
      const message = messageOf(error);
      if (/UDトークAPIの応答 status=(4|7)/.test(message)) { this.log.warn(`UDトーク会話のセッションが無効です: ${message}。再接続します。`); this.#scheduleConnect(); }
      else { this.#consecutivePollFailures += 1; if (this.#consecutivePollFailures >= 3 && !this.#reportedPollFailure) { this.log.warn(`UDトーク会話の取得に${this.#consecutivePollFailures}回連続で失敗しました: ${message}。同じ位置から再試行します。`); this.#reportedPollFailure = true; } this.#schedulePoll(); }
    }
  }
  #handleMessage(message: UdtalkMessage): void {
    if (message.qualify !== 1 || !message.meta) return;
    let meta: Meta; try { meta = JSON.parse(message.meta) as Meta; } catch { return; }
    if (meta.phase !== 'finalized' || !meta.text?.trim()) return;
    const text = meta.text.trim(); const key = `${meta.utteranceIdentifier}:${text}`;
    if (key === this.#lastTextKey) return; this.#lastTextKey = key; this.onText(text);
  }
  async #post(path: string, body: Record<string, string | number>, acceptedStatuses = [1]): Promise<ApiResponse> {
    const response = await requireOk(fetch(`${appBaseUrl}/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));
    const data = await response.json() as ApiResponse;
    if (!acceptedStatuses.includes(data.status)) throw new Error(`UDトークAPIの応答 status=${data.status}`);
    return data;
  }
}
async function requireOk(response: Promise<Response> | Response): Promise<Response> { const value = await response; if (!value.ok) throw new Error(`HTTP ${value.status}`); return value; }
function messageOf(error: unknown): string { return error instanceof Error ? error.message : String(error); }
