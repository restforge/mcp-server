export type EnvEntry =
  | { kind: 'kv'; key: string; value: string; commentInline?: string }
  | { kind: 'comment'; text: string }
  | { kind: 'blank' };

export type EnvFieldValue = string | number | boolean;

const KV_REGEX = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/;

function stripQuotes(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

function splitInlineComment(rawValue: string): { value: string; comment?: string } {
  const trimmed = rawValue.trimStart();
  if (trimmed.startsWith('"') || trimmed.startsWith("'")) {
    const quote = trimmed[0];
    const closingIdx = trimmed.indexOf(quote, 1);
    if (closingIdx !== -1) {
      const afterQuote = trimmed.slice(closingIdx + 1);
      const hashIdx = afterQuote.indexOf('#');
      if (hashIdx !== -1) {
        return {
          value: trimmed.slice(0, closingIdx + 1),
          comment: afterQuote.slice(hashIdx + 1).trim(),
        };
      }
      return { value: trimmed };
    }
    return { value: trimmed };
  }
  const hashIdx = trimmed.indexOf(' #');
  if (hashIdx !== -1) {
    return {
      value: trimmed.slice(0, hashIdx).trimEnd(),
      comment: trimmed.slice(hashIdx + 2).trim(),
    };
  }
  return { value: trimmed.trimEnd() };
}

export function parseEnvFile(content: string): EnvEntry[] {
  const lines = content.split(/\r?\n/);
  const entries: EnvEntry[] = [];

  const lastIsTrailingNewline =
    lines.length > 0 && lines[lines.length - 1] === '';
  const effectiveLines = lastIsTrailingNewline ? lines.slice(0, -1) : lines;

  for (const rawLine of effectiveLines) {
    const trimmed = rawLine.trim();
    if (trimmed === '') {
      entries.push({ kind: 'blank' });
      continue;
    }
    if (trimmed.startsWith('#')) {
      entries.push({ kind: 'comment', text: rawLine });
      continue;
    }
    const match = KV_REGEX.exec(rawLine);
    if (!match) {
      entries.push({ kind: 'comment', text: rawLine });
      continue;
    }
    const key = match[1];
    const { value: rawValue, comment } = splitInlineComment(match[2]);
    const value = stripQuotes(rawValue);
    const entry: EnvEntry = { kind: 'kv', key, value };
    if (comment !== undefined) entry.commentInline = comment;
    entries.push(entry);
  }

  return entries;
}

function needsQuoting(value: string): boolean {
  if (value === '') return false;
  return /[\s#"'=]/.test(value);
}

function quoteValue(value: string): string {
  const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `"${escaped}"`;
}

function formatValue(value: string): string {
  return needsQuoting(value) ? quoteValue(value) : value;
}

export function serializeEnvFile(entries: EnvEntry[]): string {
  const out: string[] = [];
  for (const entry of entries) {
    if (entry.kind === 'blank') {
      out.push('');
    } else if (entry.kind === 'comment') {
      out.push(entry.text);
    } else {
      const valuePart = formatValue(entry.value);
      const line = entry.commentInline
        ? `${entry.key}=${valuePart} # ${entry.commentInline}`
        : `${entry.key}=${valuePart}`;
      out.push(line);
    }
  }
  return out.join('\n') + '\n';
}

function normalizeFieldValue(value: EnvFieldValue): string {
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return String(value);
  return value;
}

export interface MergeResult {
  entries: EnvEntry[];
  updated: Array<{ key: string; before: string; after: string }>;
  added: Array<{ key: string; value: string }>;
  unchanged: string[];
}

export function mergeEnvEntries(
  existing: EnvEntry[],
  updates: Record<string, EnvFieldValue>
): MergeResult {
  const updateKeys = new Set(Object.keys(updates));
  const updated: MergeResult['updated'] = [];
  const added: MergeResult['added'] = [];
  const unchanged: string[] = [];

  const next: EnvEntry[] = existing.map((entry) => {
    if (entry.kind !== 'kv') return entry;
    if (!updateKeys.has(entry.key)) {
      unchanged.push(entry.key);
      return entry;
    }
    const newValue = normalizeFieldValue(updates[entry.key]);
    updateKeys.delete(entry.key);
    if (entry.value === newValue) {
      unchanged.push(entry.key);
      return entry;
    }
    updated.push({ key: entry.key, before: entry.value, after: newValue });
    return { ...entry, value: newValue };
  });

  for (const remainingKey of updateKeys) {
    const value = normalizeFieldValue(updates[remainingKey]);
    next.push({ kind: 'kv', key: remainingKey, value });
    added.push({ key: remainingKey, value });
  }

  return { entries: next, updated, added, unchanged };
}

const SENSITIVE_KEYS = new Set([
  'LICENSE',
  'DB_PASSWORD',
  'REDIS_PASSWORD',
  'KAFKA_SASL_PASSWORD',
]);

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEYS.has(key);
}

export function maskValue(value: string): string {
  if (value === '') return '';
  return '****';
}
