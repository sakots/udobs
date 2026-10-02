export function redactErrorText(text: string, secrets: string[] = []): string {
  let safe = text;
  for (const secret of [...secrets].filter(Boolean).sort((a, b) => b.length - a.length)) {
    safe = safe.split(secret).join('[非公開]');
  }
  return safe.replace(/https?:\/\/[^\s"'<>]+/gi, '[URL非公開]')
    .replace(/[0-9a-f]{64}/gi, '[ID非公開]').replace(/[\r\n\t]+/g, ' ').slice(0, 500);
}

// オブジェクト全体やスタックは出力せず、通信診断に必要な項目だけを残す。
export function describeError(error: unknown, secrets: string[] = []): string {
  const seen = new Set<object>();
  function describe(value: unknown, depth: number): string {
    if (depth > 4) return '[省略]';
    if (typeof value !== 'object' || value === null) return redactErrorText(String(value), secrets);
    if (seen.has(value)) return '[循環参照]';
    seen.add(value);
    const fields = value as { name?: unknown; message?: unknown; code?: unknown; cause?: unknown; errors?: unknown };
    const parts: string[] = [];
    for (const key of ['name', 'code', 'message'] as const) {
      const field = fields[key];
      if (typeof field === 'string' || typeof field === 'number') parts.push(`${key}=${redactErrorText(String(field), secrets)}`);
    }
    if (fields.cause !== undefined) parts.push(`cause={${describe(fields.cause, depth + 1)}}`);
    if (Array.isArray(fields.errors)) {
      parts.push(`errors=[${fields.errors.slice(0, 5).map(item => describe(item, depth + 1)).join('; ')}${fields.errors.length > 5 ? '; [省略]' : ''}]`);
    }
    return parts.join(', ') || '詳細なし';
  }
  return describe(error, 0);
}
