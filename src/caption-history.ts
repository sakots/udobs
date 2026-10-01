export interface Utterance { id: string; timestamp?: number; }

export class CaptionHistory {
  #entries: { id: string; text: string; timestamp?: number; order: number }[] = [];
  #sequence = 0;
  #lastPair = '';

  update(text: string, utterance: Utterance): { current: string; previous: string } | undefined {
    const existing = this.#entries.find((entry) => entry.id === utterance.id);
    if (existing) existing.text = text;
    else {
      this.#entries.push({ ...utterance, text, order: ++this.#sequence });
      this.#entries.sort((a, b) => a.timestamp !== undefined && b.timestamp !== undefined
        ? a.timestamp - b.timestamp || a.order - b.order : a.order - b.order);
      if (this.#entries.length > 1000) this.#entries.shift();
    }
    // 同じ表示内容で前字幕を繰り上げない。
    const current = this.#entries.at(-1)?.text ?? '';
    const previous = [...this.#entries].reverse().find((entry) => entry.text !== current)?.text ?? '';
    const key = JSON.stringify([current, previous]);
    if (key === this.#lastPair) return;
    this.#lastPair = key;
    return { current, previous };
  }
}
