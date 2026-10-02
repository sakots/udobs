export function wrapText(text: string, maxCharsPerLine: number): string {
  // 既存の改行は残し、長い行だけを折り返す。
  return text.split(/\r?\n/).flatMap((line) => wrapLine(line, maxCharsPerLine)).join('\n');
}

function wrapLine(line: string, maxChars: number): string[] {
  // サロゲートペアを含む文字を途中で分割しないよう、コードポイント単位で扱う。
  const characters = Array.from(line);
  if (characters.length <= maxChars) return [line];
  const lines: string[] = [];
  let rest = characters;
  while (rest.length > maxChars) {
    const breakAt = preferredBreak(rest, maxChars);
    lines.push(rest.slice(0, breakAt).join('').trimEnd());
    rest = rest.slice(breakAt);
  }
  lines.push(rest.join('').trimEnd());
  return lines;
}

function preferredBreak(characters: string[], maxChars: number): number {
  // 行が短くなりすぎない範囲で、句読点や空白を優先して改行する。
  const minimum = Math.ceil(maxChars * 0.65);
  for (let index = maxChars; index >= minimum; index -= 1) {
    if (/[、。！？!?\s]/.test(characters[index - 1])) return index;
  }
  return maxChars;
}
