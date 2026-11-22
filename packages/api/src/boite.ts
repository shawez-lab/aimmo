/**
 * La boîte mail de l'agent, reliée pour de vrai (AU043), sous `/v1/boite`, et son passage des quarts d'heure.
 *
 * Les vraies boîtes Gmail et Outlook ne sont faites que si tout est rangé (H55) : `BOITE_MODE` vaut `reel`, le client
 * OAuth de Google (`BOITE_GOOGLE_CLIENT_ID`, `BOITE_GOOGLE_CLIENT_SECRET`) ou de Microsoft (`BOITE_MICROSOFT_CLIENT_ID`,
 * `BOITE_MICROSOFT_CLIENT_SECRET`, `BOITE_MICROSOFT_TENANT`), et le secret `BOITE_JETONS` : pour chaque agent qui a donné
 * son accord, le jeton de rafraîchissement de sa boîte, en JSON `{"<agent>":{"gmail":"…","outlook":"…"}}`. Il manque une
 * pièce, ou l'une est mal formée : aucune boîte n'est lue [R683].
 *
 * L'agent en activité seul lit et voit sa boîte ; la direction n'en a pas [R16]. Chaque mail lu passe par le tri de HX26
 * (`BoiteMail`) : rattaché à sa fiche sous droits [R408], dans la conversation de son fil, jamais deux fois [R18], rien
 * ne part [R409]. Au journal, pour chaque lecture : le fournisseur, le nombre de mails et le code d'une panne ; ni
 * adresse, ni objet, ni jeton [R13].
 */
import type { JournalStore, SqlDatabase, Viewer } from '@aimmo/core';
import { appendEvent } from '../../core/src/journal/journal.ts';
import { BoiteMail, MAIL_PROVIDERS, type DossierFileStore, type MailProvider, type MailboxProvider } from '../../core/src/automatismes/boite-mail.ts';
import { GmailMailbox, MailboxError, OutlookMailbox, type HttpFn } from '../../core/src/automatismes/boite-mail-reelle.ts';

export const TRIAL_MODE = 'essai';

export interface BoiteEnv {
  BOITE_MODE?: string | undefined;
  BOITE_GOOGLE_CLIENT_ID?: string | undefined;
  BOITE_GOOGLE_CLIENT_SECRET?: string | undefined;
  BOITE_MICROSOFT_CLIENT_ID?: string | undefined;
  BOITE_MICROSOFT_CLIENT_SECRET?: string | undefined;
  BOITE_MICROSOFT_TENANT?: string | undefined;
  BOITE_JETONS?: string | undefined;
}

/** Les boîtes reliées de chaque agent. */
export interface MailboxDirectory {
  /** Les boîtes de cet agent, Gmail puis Outlook ; aucune : liste vide. */
  of(agentId: string): MailboxProvider[];
  /** Les agents qui ont relié au moins une boîte, dans l'ordre des identifiants. */
  agents(): string[];
}

const AGENT_ID = /^[A-Za-z0-9_-]{1,64}$/;
const GOOGLE_CLIENT = /^[A-Za-z0-9-]{1,100}\.apps\.googleusercontent\.com$/;
const MS_CLIENT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MS_TENANT = /^(?:common|organizations|consumers|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[a-z0-9-]{1,63}(?:\.[a-z0-9-]{1,63})+)$/i;
const TOKEN = /^[\x21-\x7e]{10,4096}$/;

/** Les jetons de `BOITE_JETONS`, par fournisseur ; une entrée mal formée est écartée, jamais devinée. */
export function parseMailboxTokens(raw: string | undefined): Record<MailProvider, Map<string, string>> {
  const out: Record<MailProvider, Map<string, string>> = { gmail: new Map(), outlook: new Map() };
  if (!raw || raw.trim() === '') return out;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return out;
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return out;
  for (const [agentId, boxes] of Object.entries(data as Record<string, unknown>)) {
    if (!AGENT_ID.test(agentId) || boxes === null || typeof boxes !== 'object' || Array.isArray(boxes)) continue;
    for (const provider of MAIL_PROVIDERS) {
      const t = (boxes as Record<string, unknown>)[provider];
      if (typeof t === 'string' && TOKEN.test(t.trim())) out[provider].set(agentId, t.trim());
    }
  }
  return out;
}

/** Les vraies boîtes des agents, ou `null` tant que la mise en service n'est pas complète [R683]. */
export function mailboxesFromEnv(env: BoiteEnv, http: HttpFn): MailboxDirectory | null {
  if (env.BOITE_MODE !== 'reel') return null;
  const tokens = parseMailboxTokens(env.BOITE_JETONS);
  const gId = env.BOITE_GOOGLE_CLIENT_ID?.trim() ?? '';
  const gSecret = env.BOITE_GOOGLE_CLIENT_SECRET?.trim() ?? '';
  const mId = env.BOITE_MICROSOFT_CLIENT_ID?.trim() ?? '';
  const mSecret = env.BOITE_MICROSOFT_CLIENT_SECRET?.trim() ?? '';
  const tenant = env.BOITE_MICROSOFT_TENANT?.trim() || 'common';
  const gmail = GOOGLE_CLIENT.test(gId) && gSecret !== '' && tokens.gmail.size > 0 ? new GmailMailbox({ client: { clientId: gId, clientSecret: gSecret }, refreshTokens: tokens.gmail, http }) : null;
  const outlook =
    MS_CLIENT.test(mId) && mSecret !== '' && MS_TENANT.test(tenant) && tokens.outlook.size > 0
      ? new OutlookMailbox({ client: { clientId: mId, clientSecret: mSecret, tenant }, refreshTokens: tokens.outlook, http })
      : null;
  if (!gmail && !outlook) return null;
  return {
    of: (agentId) => [...(gmail?.connected(agentId) ? [gmail] : []), ...(outlook?.connected(agentId) ? [outlook] : [])],
    agents: () => [...new Set([...(gmail ? tokens.gmail.keys() : []), ...(outlook ? tokens.outlook.keys() : [])])].sort(),
  };
}

/** Le stockage des pièces des dossiers, tiré des pièces de M10 (`PIECES`) ; absent : aucune lecture. */
export function dossierFilesOf(pieces: { upload(key: string, bytes: Uint8Array, contentType: string): Promise<void> } | null | undefined): DossierFileStore | null {
  return pieces ? { put: (key, bytes, type) => pieces.upload(key, bytes, type) } : null;
}

export interface BoiteServices {
  db: SqlDatabase;
  journal: JournalStore;
  now: () => Date;
  mailboxes: MailboxDirectory | null;
  files: DossierFileStore | null;
}

export interface BoiteRoute {
  method: 'GET' | 'POST';
  pattern: RegExp;
  name: string;
  handle: (s: BoiteServices, viewer: Viewer, params: string[], request: Request) => Promise<Response>;
}

export interface MailboxRead {
  provider: MailProvider;
  ok: boolean;
  /** Les mails lus et triés dans cette lecture, déjà triés compris (`outcome` null). */
  lus: number;
  rattaches: number;
  /** Le code fermé d'une panne de la boîte, ou d'un refus du tri. */
  code: string | null;
}

const HEADERS = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...HEADERS } });

const MESSAGES: Readonly<Record<string, string>> = {
  role: 'Seul un agent en activité lit sa boîte mail.',
  boite_non_reliee: "Votre boîte mail n'est pas encore reliée à AIMMO : rien n'est lu.",
  stockage_indisponible: "Le rangement des pièces n'est pas encore ouvert : la boîte n'est pas lue.",
  connexion: "L'accord donné à AIMMO pour lire la boîte a été retiré ou a expiré : reliez la boîte de nouveau.",
  droits: "Le droit de lire les mails n'a pas été accordé à AIMMO.",
  limite: 'Le service de mail limite les lectures : nouvel essai au prochain passage.',
  trop: 'Trop de mails à lire en une fois : la lecture reprend au prochain passage.',
  panne: 'Le service de mail ne répond pas : nouvel essai au prochain passage.',
  unknown_field: 'Cette demande ne prend aucun paramètre.',
};

async function refuse(s: BoiteServices, viewer: Viewer, code: string, status: number, rule: string): Promise<Response> {
  await appendEvent(s.journal, { type: 'acces.refuse', actor: `${String(viewer.role)}:${viewer.userId}`, subject: null, data: { rule, role: String(viewer.role), kind: 'mailbox', code } }, s.now);
  return json(status, { ok: false, rule, code, message: MESSAGES[code] ?? code });
}

/** L'agent en activité du réseau [R16]. */
async function activeAgent(s: BoiteServices, viewer: Viewer): Promise<boolean> {
  if (String(viewer.role) !== 'agent') return false;
  return (await s.db.first("SELECT 1 FROM agents WHERE id = ? AND network_id = ? AND status = 'active'", [viewer.userId, viewer.networkId])) !== null;
}

/**
 * Lit chaque boîte reliée de l'agent et trie ses mails. Une boîte en panne n'arrête pas l'autre ; la panne est dite par
 * son code et écrite au journal, sans rien de la réponse du service [R13]. Un mail lu deux fois n'est trié qu'une [R18].
 */
export async function readMailboxes(s: BoiteServices & { mailboxes: MailboxDirectory; files: DossierFileStore }, viewer: Viewer): Promise<MailboxRead[]> {
  const boite = new BoiteMail(s.db, s.journal, s.files, { now: s.now });
  const out: MailboxRead[] = [];
  for (const provider of s.mailboxes.of(viewer.userId)) {
    let read: MailboxRead;
    try {
      const r = await boite.sync(viewer, provider);
      read = r.ok
        ? { provider: provider.provider, ok: true, lus: r.value.length, rattaches: r.value.filter((m) => m.outcome === 'rattache').length, code: null }
        : { provider: provider.provider, ok: false, lus: 0, rattaches: 0, code: r.code };
    } catch (error) {
      read = { provider: provider.provider, ok: false, lus: 0, rattaches: 0, code: error instanceof MailboxError ? error.code : 'panne' };
    }
    await appendEvent(
      s.journal,
      { type: 'boite.lecture', actor: `agent:${viewer.userId}`, subject: null, data: { rule: 'R683', provider: read.provider, ok: read.ok, lus: read.lus, rattaches: read.rattaches, code: read.code } },
      s.now,
    );
    out.push(read);
  }
  return out;
}

/**
 * Le passage des quarts d'heure : la boîte de chaque agent en activité qui l'a reliée est lue, comme s'il appuyait
 * lui-même sur « lire ». Un agent parti ou inconnu n'est pas lu. Une panne d'un agent n'arrête pas les autres.
 */
export async function runMailboxPass(s: BoiteServices): Promise<{ agentId: string; reads: MailboxRead[] }[]> {
  if (!s.mailboxes || !s.files) return [];
  const out: { agentId: string; reads: MailboxRead[] }[] = [];
  for (const agentId of s.mailboxes.agents()) {
    const agent = await s.db.first<{ network_id: string }>("SELECT network_id FROM agents WHERE id = ? AND status = 'active'", [agentId]);
    if (!agent) continue;
    try {
      out.push({ agentId, reads: await readMailboxes({ ...s, mailboxes: s.mailboxes, files: s.files }, { role: 'agent', userId: agentId, networkId: agent.network_id }) });
    } catch {
      out.push({ agentId, reads: [] });
    }
  }
  return out;
}

const LIST_LIMIT = 50;

function noParams(request: Request): string | null {
  for (const k of new URL(request.url).searchParams.keys()) return k;
  return null;
}

/** Les routes de `/v1/boite`, à ajouter à celles de `app.ts`. */
export function boiteRoutes(): BoiteRoute[] {
  return [
    {
      // La file de l'agent : ses boîtes reliées et ses derniers mails lus, chacun avec sa fiche, son dossier et le
      // message de la fiche, dans la conversation de son fil chez le fournisseur.
      method: 'GET',
      pattern: /^\/boite$/,
      name: 'boite.file',
      handle: async (s, viewer, _params, request) => {
        if (!(await activeAgent(s, viewer))) return refuse(s, viewer, 'role', 403, 'R16');
        const field = noParams(request);
        if (field) return json(400, { ok: false, rule: null, code: 'unknown_field', field, message: MESSAGES.unknown_field });
        const rows = await s.db.all<{ id: string; provider: string; status: string; person_id: string | null; project_id: string | null; message_id: string | null; conversation_id: string | null; received_at: string; done_at: string | null }>(
          `SELECT b.id, b.provider, b.status, b.person_id, b.project_id, b.message_id, m.conversation_id, b.received_at, b.done_at
             FROM mailbox_mails b LEFT JOIN messages m ON m.id = b.message_id
            WHERE b.network_id = ? AND b.agent_id = ? ORDER BY b.received_at DESC, b.id DESC LIMIT ${LIST_LIMIT}`,
          [viewer.networkId, viewer.userId],
        );
        const reliees = (s.mailboxes?.of(viewer.userId) ?? []).map((p) => p.provider);
        return json(200, {
          ok: true,
          mode: TRIAL_MODE,
          data: {
            reliees,
            ...(reliees.length === 0 ? { message: MESSAGES.boite_non_reliee } : {}),
            mails: rows.map((r) => ({
              id: r.id,
              provider: r.provider,
              status: r.status,
              personId: r.person_id,
              projectId: r.project_id,
              messageId: r.message_id,
              conversationId: r.conversation_id,
              receivedAt: r.received_at,
              doneAt: r.done_at,
            })),
          },
        });
      },
    },
    {
      // Lire maintenant : chaque boîte reliée de l'agent, puis le tri de HX26. Rien ne part [R409].
      method: 'POST',
      pattern: /^\/boite\/lecture$/,
      name: 'boite.lecture',
      handle: async (s, viewer, _params, request) => {
        if (!(await activeAgent(s, viewer))) return refuse(s, viewer, 'role', 403, 'R16');
        const field = noParams(request);
        if (field) return json(400, { ok: false, rule: null, code: 'unknown_field', field, message: MESSAGES.unknown_field });
        if (!s.mailboxes || s.mailboxes.of(viewer.userId).length === 0) return json(409, { ok: false, rule: 'R683', code: 'boite_non_reliee', message: MESSAGES.boite_non_reliee });
        if (!s.files) return json(503, { ok: false, rule: 'R683', code: 'stockage_indisponible', message: MESSAGES.stockage_indisponible });
        const reads = await readMailboxes({ ...s, mailboxes: s.mailboxes, files: s.files }, viewer);
        return json(200, { ok: true, mode: TRIAL_MODE, data: reads.map((r) => ({ ...r, ...(r.code ? { message: MESSAGES[r.code] ?? r.code } : {}) })) });
      },
    },
  ];
}
