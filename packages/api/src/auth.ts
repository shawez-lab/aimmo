import { ROLES, type Viewer } from '@aimmo/core';

/**
 * Les clés d'accès à l'API. Le secret Cloudflare `API_KEYS` ne contient que l'empreinte SHA-256 de chaque clé,
 * avec l'identité qu'elle porte : la clé elle-même n'est écrite nulle part, ni dans le dépôt, ni dans la base.
 *
 *   [{ "sha256": "<64 caractères hexadécimaux>", "role": "agent", "userId": "<id>", "networkId": "<id>" }]
 */
export interface ApiKeyEntry extends Viewer {
  sha256: string;
}

/** Une clé plus courte est refusée sans même être comparée. */
export const MIN_KEY_LENGTH = 32;

const HEX64 = /^[0-9a-f]{64}$/;

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Lit la configuration des clés. Lecture prudente : une configuration absente ou mal formée ferme toute l'API,
 * elle n'ouvre jamais rien.
 */
export function parseApiKeys(raw: string | undefined): ApiKeyEntry[] | null {
  if (raw === undefined || raw.trim() === '') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return null;
  const entries: ApiKeyEntry[] = [];
  for (const item of parsed as unknown[]) {
    if (item === null || typeof item !== 'object') return null;
    const { sha256, role, userId, networkId } = item as Record<string, unknown>;
    if (typeof sha256 !== 'string' || !HEX64.test(sha256)) return null;
    if (typeof role !== 'string' || !(ROLES as readonly string[]).includes(role)) return null;
    if (typeof userId !== 'string' || userId === '' || typeof networkId !== 'string' || networkId === '') return null;
    entries.push({ sha256, role: role as Viewer['role'], userId, networkId });
  }
  if (new Set(entries.map((entry) => entry.sha256)).size !== entries.length) return null;
  return entries;
}

/** Compare deux empreintes de même longueur sans s'arrêter au premier écart. */
function sameHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Rend l'identité portée par la clé de la requête, ou `null`. */
export async function viewerFromRequest(request: Request, keys: readonly ApiKeyEntry[]): Promise<Viewer | null> {
  const header = request.headers.get('authorization') ?? '';
  const match = /^Bearer ([^\s]+)$/.exec(header);
  const key = match?.[1];
  if (key === undefined || key.length < MIN_KEY_LENGTH) return null;
  const hash = await sha256Hex(key);
  let found: ApiKeyEntry | null = null;
  for (const entry of keys) if (sameHex(entry.sha256, hash)) found = entry;
  return found === null ? null : { role: found.role, userId: found.userId, networkId: found.networkId };
}

/**
 * Les clés de dépôt : elles ne servent qu'à déposer un formulaire du site, pour un réseau, et ne lisent rien.
 * Le secret `INTAKE_KEYS` ne contient que leur empreinte :
 *
 *   [{ "sha256": "<64 caractères hexadécimaux>", "networkId": "<id>", "source": "site_form" }]
 */
export interface IntakeKeyEntry {
  sha256: string;
  networkId: string;
  source: 'site_form';
}

export function parseIntakeKeys(raw: string | undefined): IntakeKeyEntry[] | null {
  if (raw === undefined || raw.trim() === '') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return null;
  const entries: IntakeKeyEntry[] = [];
  for (const item of parsed as unknown[]) {
    if (item === null || typeof item !== 'object') return null;
    const { sha256, networkId, source } = item as Record<string, unknown>;
    if (typeof sha256 !== 'string' || !HEX64.test(sha256)) return null;
    if (typeof networkId !== 'string' || networkId === '' || source !== 'site_form') return null;
    entries.push({ sha256, networkId, source });
  }
  if (new Set(entries.map((entry) => entry.sha256)).size !== entries.length) return null;
  return entries;
}

export async function intakeFromRequest(request: Request, keys: readonly IntakeKeyEntry[]): Promise<IntakeKeyEntry | null> {
  const header = request.headers.get('authorization') ?? '';
  const key = /^Bearer ([^\s]+)$/.exec(header)?.[1];
  if (key === undefined || key.length < MIN_KEY_LENGTH) return null;
  const hash = await sha256Hex(key);
  let found: IntakeKeyEntry | null = null;
  for (const entry of keys) if (sameHex(entry.sha256, hash)) found = entry;
  return found;
}
