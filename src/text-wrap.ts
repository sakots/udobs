export function wrapText(text: string, maxCharsPerLine: number): string {
  return text.split(/\r?\n/).flatMap((line) => wrapLine(line, maxCharsPerLine)).join('\n');
}

function wrapLine(line: string, maxChars: number): string[] {
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
  const minimum = Math.ceil(maxChars * 0.65);
  for (let index = maxChars; index >= minimum; index -= 1) {
    if (/[、。！？!?\s]/.test(characters[index - 1])) return index;
  }
  return maxChars;
}
