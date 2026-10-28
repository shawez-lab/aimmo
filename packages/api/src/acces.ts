/**
 * L'accès en un clic (Z02). Une invitation, préparée par le travail GitHub « Créer l'accès de Shawez », ne garde en
 * base que l'empreinte de son jeton ; le jeton n'existe que dans le lien remis par mail, après `#`, que le navigateur
 * n'envoie jamais au serveur. La page de l'application l'échange ici, une seule fois et avant son échéance, contre des
 * clés tirées au hasard par le Worker : la réponse est la seule trace des clés en clair ; la base n'en garde que
 * l'empreinte, le journal ni l'une ni l'autre [R13].
 *
 * Les clés remises s'ajoutent à celles du secret `API_KEYS`, qui ne change jamais : aucune empreinte déjà présente
 * n'est perdue.
 */
import { ROLES, SqlJournalStore, appendEvent, type SqlDatabase } from '@aimmo/core';
import { MIN_KEY_LENGTH, sha256Hex, type ApiKeyEntry } from './auth.ts';

export const INVITATION_PATH = '/v1/acces/invitation';

/** Un jeton d'invitation : 32 octets au hasard, en base64url sans remplissage. */
export const INVITATION_TOKEN = /^[A-Za-z0-9_-]{43}$/;

/** Durée de validité d'une invitation, fixée par Z02. */
export const INVITATION_TTL_MS = 24 * 60 * 60 * 1000;

export interface Grant {
  role: ApiKeyEntry['role'];
  userId: string;
}

/** Tire `bytes` octets au hasard et les rend en base64url, sans remplissage. */
export function randomToken(bytes = 32): string {
  const raw = crypto.getRandomValues(new Uint8Array(bytes));
  let binary = '';
  for (const byte of raw) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Lit la liste des identités d'une invitation ; mal formée, elle n'ouvre rien. */
export function parseGrants(raw: string): Grant[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return null;
  const grants: Grant[] = [];
  for (const item of parsed as unknown[]) {
    if (item === null || typeof item !== 'object') return null;
    const { role, userId } = item as Record<string, unknown>;
    if (typeof role !== 'string' || !(ROLES as readonly string[]).includes(role)) return null;
    if (typeof userId !== 'string' || userId === '') return null;
    if (grants.some((g) => g.role === role)) return null;
    grants.push({ role: role as Grant['role'], userId });
  }
  return grants;
}

/** Les clés remises par invitation et non retirées, sous la même forme que celles du secret `API_KEYS`. */
export async function invitedKeys(db: SqlDatabase): Promise<ApiKeyEntry[]> {
  const rows = await db.all<{ sha256: string; role: string; user_id: string; network_id: string }>(
    // Seulement les clés d'une invitation qui a servi : celles d'un échange interrompu n'ouvrent rien.
    `SELECT k.sha256, k.role, k.user_id, k.network_id FROM access_keys k JOIN access_invitations i ON i.id = k.invitation_id
     WHERE k.revoked_at IS NULL AND i.used_at IS NOT NULL ORDER BY k.created_at, k.sha256`,
  );
  return rows
    .filter((r) => (ROLES as readonly string[]).includes(r.role))
    .map((r) => ({ sha256: r.sha256, role: r.role as ApiKeyEntry['role'], userId: r.user_id, networkId: r.network_id }));
}

/**
 * Réunit les clés du secret et celles des invitations. Toutes celles du secret restent, telles quelles ; une empreinte
 * d'invitation déjà présente dans le secret n'y change rien.
 */
export function mergeKeys(fromSecret: readonly ApiKeyEntry[], invited: readonly ApiKeyEntry[]): ApiKeyEntry[] {
  const known = new Set(fromSecret.map((k) => k.sha256));
  return [...fromSecret, ...invited.filter((k) => !known.has(k.sha256))];
}

export type ExchangeResult =
  | { ok: true; keys: { role: Grant['role']; key: string }[] }
  | { ok: false; status: number; code: 'invalid_token' | 'unknown_invitation' | 'invitation_used' | 'invitation_expired' | 'invalid_invitation'; message: string };

/**
 * Échange un jeton contre des clés neuves, une seule fois.
 */
export async function exchangeInvitation(db: SqlDatabase, token: unknown, now: Date): Promise<ExchangeResult> {
  if (typeof token !== 'string' || !INVITATION_TOKEN.test(token)) {
    return { ok: false, status: 400, code: 'invalid_token', message: 'Lien d’invitation mal formé.' };
  }
  const hash = await sha256Hex(token);
  const invitation = await db.first<{ id: string; network_id: string; grants: string; expires_at: string; used_at: string | null }>(
    'SELECT id, network_id, grants, expires_at, used_at FROM access_invitations WHERE token_sha256 = ?',
    [hash],
  );
  const journal = new SqlJournalStore(db);
  if (!invitation) return { ok: false, status: 404, code: 'unknown_invitation', message: 'Lien d’invitation inconnu.' };
  if (invitation.used_at !== null) {
    await appendEvent(journal, { type: 'acces.invitation_refusee', actor: 'invitation', subject: invitation.id, data: { reason: 'used' } }, () => now);
    return { ok: false, status: 410, code: 'invitation_used', message: 'Ce lien a déjà servi. Demandez-en un nouveau.' };
  }
  const nowIso = now.toISOString();
  if (!(invitation.expires_at > nowIso)) {
    await appendEvent(journal, { type: 'acces.invitation_refusee', actor: 'invitation', subject: invitation.id, data: { reason: 'expired' } }, () => now);
    return { ok: false, status: 410, code: 'invitation_expired', message: 'Ce lien a expiré. Demandez-en un nouveau.' };
  }
  const grants = parseGrants(invitation.grants);
  if (grants === null) return { ok: false, status: 409, code: 'invalid_invitation', message: 'Invitation mal formée : rien n’est ouvert.' };

  // Les clés sont rangées d'abord, mais ne servent qu'une fois l'invitation marquée « utilisée » (voir
  // `invitedKeys`) ; le marquage vient en dernier, par une seule écriture conditionnelle. Une panne avant lui laisse
  // le lien intact, à rouvrir ; deux échanges simultanés ne peuvent pas réussir tous les deux.
  const keys: { role: Grant['role']; key: string; sha256: string }[] = [];
  const revoke = async () => {
    for (const k of keys) await db.run('UPDATE access_keys SET revoked_at = ? WHERE sha256 = ? AND revoked_at IS NULL', [nowIso, k.sha256]);
  };
  try {
    for (const grant of grants) {
      const key = randomToken(32);
      if (key.length < MIN_KEY_LENGTH) throw new Error('clé trop courte');
      const sha256 = await sha256Hex(key);
      await db.run('INSERT INTO access_keys (sha256, network_id, role, user_id, invitation_id, created_at) VALUES (?, ?, ?, ?, ?, ?)', [
        sha256,
        invitation.network_id,
        grant.role,
        grant.userId,
        invitation.id,
        nowIso,
      ]);
      keys.push({ role: grant.role, key, sha256 });
    }
    // Au journal : l'invitation et les rôles ouverts, jamais le jeton, une clé ni son empreinte [R13].
    await appendEvent(journal, { type: 'acces.invitation_utilisee', actor: 'invitation', subject: invitation.id, data: { roles: grants.map((g) => g.role) } }, () => now);
    const claimed = await db.run('UPDATE access_invitations SET used_at = ? WHERE id = ? AND used_at IS NULL AND expires_at > ?', [nowIso, invitation.id, nowIso]);
    if (claimed.changes !== 1) {
      await revoke();
      await appendEvent(journal, { type: 'acces.invitation_refusee', actor: 'invitation', subject: invitation.id, data: { reason: 'used' } }, () => now);
      return { ok: false, status: 410, code: 'invitation_used', message: 'Ce lien a déjà servi. Demandez-en un nouveau.' };
    }
  } catch (error) {
    // Aucune clé de cet essai n'a été remise : elles sont retirées, puis l'erreur remonte au journal de la route.
    try {
      await revoke();
    } catch {
      /* les clés restent inconnues de tous ; l'erreur d'origine est écrite au journal par la route */
    }
    throw error;
  }
  return { ok: true, keys: keys.map(({ role, key }) => ({ role, key })) };
}

const NO_STORE = { 'cache-control': 'no-store', 'content-type': 'application/json; charset=utf-8', 'referrer-policy': 'no-referrer' };

/** La route publique d'échange : `POST /v1/acces/invitation` avec `{ "jeton": "…" }`. */
export async function handleInvitation(request: Request, db: SqlDatabase, now: Date): Promise<Response> {
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ ok: false, error: { code: 'method_not_allowed', message: 'Méthode non admise.' } }), { status: 405, headers: { ...NO_STORE, allow: 'POST' } });
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    body = null;
  }
  const token = body !== null && typeof body === 'object' ? (body as Record<string, unknown>).jeton : undefined;
  const result = await exchangeInvitation(db, token, now);
  if (!result.ok) {
    return new Response(JSON.stringify({ ok: false, error: { code: result.code, message: result.message } }), { status: result.status, headers: NO_STORE });
  }
  return new Response(JSON.stringify({ ok: true, data: { cles: result.keys.map((k) => ({ role: k.role, cle: k.key })) } }), { status: 200, headers: NO_STORE });
}
