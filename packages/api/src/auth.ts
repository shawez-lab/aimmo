import { ROLES, type Viewer } from '@aimmo/core';

/**
 * Les clés d'accès à l'API. Le secret Cloudflare `API_KEYS` ne contient que l'empreinte SHA-256 de chaque clé,
 * avec l'identité qu'elle porte : la clé elle-même n'est écrite nulle part, ni dans le dépôt, ni dans la base.
 *
 *   [{ "sha256": "<64 caractères hexadécimaux>", "role": "agent", "userId": "<id>", "networkId": "<id>" }]
 */
export interface ApiKeyEntry extends Viewer {
  sha256: string;
  /**
   * `mcp` : la clé qu'un agent confie à son assistant (BR08). Elle n'ouvre que `POST /v1/mcp`, toute autre route la
   * refuse ; et `POST /v1/mcp` n'accepte qu'elle [R590, R591]. Réservée au rôle `agent`.
   */
  scope?: 'mcp';
  /**
   * AU108 · le dernier jour de Paris où la clé ouvre l'API (AAAA-MM-JJ). Passé ce jour, elle est refusée comme une
   * clé inconnue. Une clé rangée à la main n'est qu'un secours technique : elle porte sa date de fin.
   */
  expiresOn?: string;
  /** AU108 · la clé d'application remise par un lien (Z02), et non une clé du secret. */
  fromInvitation?: true;
}

/** Une clé plus courte est refusée sans même être comparée. */
export const MIN_KEY_LENGTH = 32;

const HEX64 = /^[0-9a-f]{64}$/;
const DAY = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

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
    const { sha256, role, userId, networkId, scope, expiresOn } = item as Record<string, unknown>;
    // Une date de fin mal écrite ferme l'API : lecture prudente [AU108].
    if (expiresOn !== undefined && (typeof expiresOn !== 'string' || !DAY.test(expiresOn))) return null;
    if (typeof sha256 !== 'string' || !HEX64.test(sha256)) return null;
    if (typeof role !== 'string' || !(ROLES as readonly string[]).includes(role)) return null;
    if (typeof userId !== 'string' || userId === '' || typeof networkId !== 'string' || networkId === '') return null;
    // Une portée inconnue, ou la portée « mcp » sur un autre rôle que l'agent, ferme l'API : lecture prudente.
    if (scope !== undefined && (scope !== 'mcp' || role !== 'agent')) return null;
    entries.push({ sha256, role: role as Viewer['role'], userId, networkId, ...(scope === 'mcp' ? { scope: 'mcp' as const } : {}), ...(typeof expiresOn === 'string' ? { expiresOn } : {}) });
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

/**
 * Rend l'identité portée par la clé de la requête, ou `null`. `today` (jour de Paris, AAAA-MM-JJ) : une clé dont la
 * date de fin est passée est refusée [AU108].
 */
export async function viewerFromRequest(request: Request, keys: readonly ApiKeyEntry[], today?: string): Promise<Viewer | null> {
  const header = request.headers.get('authorization') ?? '';
  const match = /^Bearer ([^\s]+)$/.exec(header);
  const key = match?.[1];
  if (key === undefined || key.length < MIN_KEY_LENGTH) return null;
  const hash = await sha256Hex(key);
  let found: ApiKeyEntry | null = null;
  for (const entry of keys) if (sameHex(entry.sha256, hash)) found = entry;
  if (found !== null && found.expiresOn !== undefined && (today === undefined || today > found.expiresOn)) return null;
  if (found?.scope === 'mcp') MCP_KEY_REQUESTS.add(request);
  if (found?.fromInvitation) INVITATION_KEY_REQUESTS.set(request, found.sha256);
  return found === null ? null : { role: found.role, userId: found.userId, networkId: found.networkId };
}

/** Les demandes ouvertes par une clé d'application remise par un lien, avec l'empreinte de cette clé [AU108]. */
const INVITATION_KEY_REQUESTS = new WeakMap<Request, string>();
export function invitationKeyOf(request: Request): string | null {
  return INVITATION_KEY_REQUESTS.get(request) ?? null;
}

/** Les demandes ouvertes par une clé de portée « mcp », marquées à l'authentification (BR08). */
const MCP_KEY_REQUESTS = new WeakSet<Request>();
export function fromMcpKey(request: Request): boolean {
  return MCP_KEY_REQUESTS.has(request);
}
/** Marque une demande ouverte par la clé d'assistant qu'un agent a créée lui-même (BR09) : portée « mcp ». */
export function markMcpKey(request: Request): void {
  MCP_KEY_REQUESTS.add(request);
}

/** La clé portée par la requête (`Authorization: Bearer <clé>`), si elle a la longueur d'une clé ; sinon `null`. */
export function bearerKey(request: Request): string | null {
  const key = /^Bearer ([^\s]+)$/.exec(request.headers.get('authorization') ?? '')?.[1];
  return key === undefined || key.length < MIN_KEY_LENGTH ? null : key;
}

/**
 * Les clés de dépôt : chacune ne sert qu'à une source du site, pour un réseau, et ne lit aucune fiche.
 * `site_form` dépose un formulaire « Être rappelé » ; `site_chat` ouvre et fait parler l'assistant du site (C08) ;
 * `site_auto` demande au socle si un envoi d'une automatisation du site peut partir (B01) ;
 * `site_estimate` demande la fourchette de prix au m² d'une commune (E05) ; `site_booking` liste les créneaux libres
 * d'un agent et réserve un rendez-vous pour le site, l'assistant et l'espace client (V08).
 * Le secret `INTAKE_KEYS` ne contient que leur empreinte :
 *
 *   [{ "sha256": "<64 caractères hexadécimaux>", "networkId": "<id>", "source": "site_form" | "site_chat" | "site_auto" | "site_estimate" | "site_booking" }]
 */
export const INTAKE_SOURCES = ['site_form', 'site_chat', 'site_auto', 'site_estimate', 'site_booking'] as const;
export type IntakeSource = (typeof INTAKE_SOURCES)[number];

export interface IntakeKeyEntry {
  sha256: string;
  networkId: string;
  source: IntakeSource;
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
    if (typeof networkId !== 'string' || networkId === '') return null;
    if (typeof source !== 'string' || !(INTAKE_SOURCES as readonly string[]).includes(source)) return null;
    entries.push({ sha256, networkId, source: source as IntakeSource });
  }
  if (new Set(entries.map((entry) => entry.sha256)).size !== entries.length) return null;
  return entries;
}

/** Rend la clé de dépôt de la requête, seulement si elle sert à cette source ; sinon `null`. */
export async function intakeFromRequest(request: Request, keys: readonly IntakeKeyEntry[], source: IntakeSource): Promise<IntakeKeyEntry | null> {
  const header = request.headers.get('authorization') ?? '';
  const key = /^Bearer ([^\s]+)$/.exec(header)?.[1];
  if (key === undefined || key.length < MIN_KEY_LENGTH) return null;
  const hash = await sha256Hex(key);
  let found: IntakeKeyEntry | null = null;
  for (const entry of keys) if (sameHex(entry.sha256, hash)) found = entry;
  return found?.source === source ? found : null;
}
