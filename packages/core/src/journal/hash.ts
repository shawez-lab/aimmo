import type { JsonValue, JournalEntryWithoutHash } from './types.ts';

function canonicalize(value: JsonValue): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalize(value[key]!)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export async function hashEntry(entry: JournalEntryWithoutHash): Promise<string> {
  const serialized = canonicalize({
    seq: entry.seq,
    at: entry.at,
    type: entry.type,
    actor: entry.actor,
    subject: entry.subject,
    data: entry.data,
    prevHash: entry.prevHash,
  });
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(serialized));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}
