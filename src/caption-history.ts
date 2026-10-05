export interface Utterance { id: string; timestamp?: number; }
interface CaptionChange { reason: '新規発話' | '訂正'; changed: string; current: string; previous: string; }

// 発話IDごとの履歴から、最新字幕と内容の異なる前字幕を選ぶ。
export class CaptionHistory {
  #entries: { id: string; text: string; timestamp?: number; order: number }[] = [];
  #sequence = 0;
  #lastPair = '';
  #lastCurrent = '';
  #lastPrevious = '';

  constructor(readonly onChange: (change: CaptionChange) => void = () => {}) {}

  update(text: string, utterance: Utterance): { current: string; previous: string } | undefined {
    const existing = this.#entries.find((entry) => entry.id === utterance.id);
    // 同じ発話の訂正では本文だけを更新し、履歴上の位置は動かさない。
    if (existing) existing.text = text;
    else {
      this.#entries.push({ ...utterance, text, order: ++this.#sequence });
      // 比較する両方に時刻があれば時刻順、それ以外は受信順を使う。
      this.#entries.sort((a, b) => a.timestamp !== undefined && b.timestamp !== undefined
        ? a.timestamp - b.timestamp || a.order - b.order : a.order - b.order);
      if (this.#entries.length > 1000) this.#entries.shift();
    }
    // 同じ表示内容で前字幕を繰り上げない。
    const current = this.#entries.at(-1)?.text ?? '';
    const previous = [...this.#entries].reverse().find((entry) => entry.text !== current)?.text ?? '';
    const key = JSON.stringify([current, previous]);
    // 古い発話の変更などで表示が変わらない場合は、再送を省く。
    if (key === this.#lastPair) return;
    const changed = [current !== this.#lastCurrent ? '現在字幕' : '', previous !== this.#lastPrevious ? '前字幕' : ''].filter(Boolean).join('・');
    this.#lastPair = key;
    this.#lastCurrent = current;
    this.#lastPrevious = previous;
    this.onChange({ reason: existing ? '訂正' : '新規発話', changed, current, previous });
    return { current, previous };
  }
}
