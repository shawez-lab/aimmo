/**
 * AU045 · Le vrai raccordement téléphonique de l'assistant vocal (HX22, HX21) [R710, R246, R242, R248, R13, R18].
 *
 * L'agent garde son seul numéro et règle chez son opérateur un renvoi conditionnel (non-réponse, occupation, absence de
 * réseau) vers le numéro du service téléphonique (Twilio). Ce numéro n'est jamais dit ni donné [R246]. Le service appelle
 * le Worker à chaque étape, en formulaire signé :
 *
 *   POST /v1/telephonie/appel  (« A call comes in ») : décroche, dit la mention de l'assistant puis l'annonce de
 *                              l'enregistrement et la demande d'accord [R246, R242], et écoute la réponse ;
 *   POST /v1/telephonie/tour   (l'écoute, `<Gather input="speech">`) : ce que l'appelant vient de dire, la réponse fixe de
 *                              l'assistant, et une nouvelle écoute, ou la fin et le passage de main à l'agent [R247, R248] ;
 *   POST /v1/telephonie/fin    (« Call status changes ») : l'appel est fini, même raccroché au milieu : il est rangé par
 *                              HX21 et la main passe à l'agent, une seule fois [R18].
 *
 * Fermé (503) tant que tout n'est pas réglé : `TELEPHONIE_MODE=reel`, `TWILIO_ACCOUNT_SID`, le secret `TWILIO_AUTH_TOKEN`.
 * Chaque requête porte la signature `X-Twilio-Signature` (HMAC-SHA1 de l'adresse et des champs, clé du compte),
 * comparée à temps constant, et le numéro de compte réglé ; sinon 403 et rien n'est lu [R710].
 *
 * La reconnaissance de la parole est celle du service ; ce qui est dit n'est gardé que le temps d'un tour, jamais au
 * journal [R13]. L'état de l'appel est gardé entre deux tours, puis effacé à la fin (le numéro de l'appelant n'y reste
 * pas). Aucun enregistrement n'est demandé au service : l'appel est rangé « sans enregistrement », avec son accord dit
 * s'il a été donné, et la fiche de l'appelant est créée ou retrouvée par son numéro [R244].
 */
import { Acces, FicheClient, FicheUnique, SqlJournalStore, appendEvent, type SqlDatabase } from '@aimmo/core';
import { ReservationEnLigne } from '../../core/src/rendezvous/en-ligne.ts';
import { Appels } from '../../core/src/voix/appels.ts';
import { AssistantVocal, bookingProofOf, type AssistantState } from '../../core/src/voix/assistant.ts';

export const TELEPHONIE_PATHS = Object.freeze({ appel: '/telephonie/appel', tour: '/telephonie/tour', fin: '/telephonie/fin' });
export const TELEPHONIE_PROVIDER = 'twilio';
/** Un formulaire du service est court : au-delà, il n'est pas lu. */
export const MAX_TELEPHONIE_BODY_BYTES = 16_384;
const CALL_SID = /^CA[0-9a-f]{32}$/;
const ACCOUNT_SID = /^AC[0-9a-f]{32}$/;
/** Les états qui disent un appel fini, chez Twilio. */
const ENDED = new Set(['completed', 'busy', 'failed', 'no-answer', 'canceled']);
/** Ce que Twilio met à la place d'un numéro masqué. */
const MASKED = new Set(['anonymous', 'restricted', 'unknown', 'private', 'unavailable', '+266696687', '+86282452253', '+8656696', '+2562533']);

export interface TelephonieSettings {
  mode: string | undefined;
  accountSid: string | undefined;
  authToken: string | undefined;
}

export interface TelephonieConfig extends TelephonieSettings {
  db: SqlDatabase;
  now: () => Date;
  /** L'adresse des liens de rendez-vous (V08), comme la réservation en ligne. */
  linkBase: string | null;
}

/** Les phrases fixes dites quand l'assistant ne prend pas l'appel : jamais de numéro, jamais de nom [R246]. */
export const TELEPHONIE_REFUS: Readonly<Record<string, string>> = Object.freeze({
  not_forwarded: 'Bonjour, ce numéro ne prend aucun appel direct. Merci de rappeler votre agent AIMMO à son numéro habituel.',
  no_line: 'Bonjour, ce numéro ne prend aucun appel direct. Merci de rappeler votre agent AIMMO à son numéro habituel.',
  line_off: 'Bonjour, votre agent AIMMO ne peut pas vous répondre pour le moment. Merci de le rappeler un peu plus tard.',
  bad_call: 'Bonjour, cet appel ne peut pas être pris. Merci de rappeler votre agent AIMMO un peu plus tard.',
});

/** Les réglages sont complets : seulement alors le raccordement est ouvert [R710]. */
export function telephonieOpen(s: TelephonieSettings): boolean {
  return s.mode === 'reel' && typeof s.accountSid === 'string' && ACCOUNT_SID.test(s.accountSid) && typeof s.authToken === 'string' && s.authToken.length >= 16;
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });

const twiml = (body: string): Response =>
  new Response(`<?xml version="1.0" encoding="UTF-8"?><Response>${body}</Response>`, {
    status: 200,
    headers: { 'content-type': 'text/xml; charset=utf-8', 'cache-control': 'no-store' },
  });

const escapeXml = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

const say = (lines: readonly string[]): string => lines.map((l) => `<Say language="fr-FR">${escapeXml(l)}</Say>`).join('');

/** Les phrases dites, puis l'écoute de la réponse, renvoyée au tour suivant. Rien n'est enregistré par le service. */
function listen(lines: readonly string[], tourUrl: string): Response {
  return twiml(
    `${say(lines)}<Gather input="speech" language="fr-FR" speechTimeout="auto" actionOnEmptyResult="true" method="POST" action="${escapeXml(tourUrl)}"></Gather><Hangup/>`,
  );
}

const hangUp = (lines: readonly string[]): Response => twiml(`${say(lines)}<Hangup/>`);

function base64(bytes: ArrayBuffer): string {
  let s = '';
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s);
}

/** La signature de Twilio : HMAC-SHA1 de l'adresse suivie des champs triés par nom (nom puis valeur), en base 64. */
export async function twilioSignature(authToken: string, url: string, params: URLSearchParams): Promise<string> {
  const names = [...new Set([...params.keys()])].sort();
  let data = url;
  for (const name of names) for (const value of params.getAll(name)) data += name + value;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(authToken), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  return base64(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data)));
}

function sameText(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

async function readForm(request: Request): Promise<URLSearchParams | null> {
  if (!(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/x-www-form-urlencoded')) return null;
  if (Number(request.headers.get('content-length') ?? '0') > MAX_TELEPHONIE_BODY_BYTES) return null;
  const text = await request.text();
  if (new TextEncoder().encode(text).length > MAX_TELEPHONIE_BODY_BYTES) return null;
  return new URLSearchParams(text);
}

/** Le numéro de l'appelant tel que Twilio le donne ; null s'il est masqué [R244]. */
export function callerOf(from: string | null): string | null {
  if (from === null) return null;
  const v = from.trim();
  if (v === '' || MASKED.has(v.toLowerCase())) return null;
  return v;
}

interface SessionRow {
  id: string;
  network_id: string;
  state: string | null;
  turns: number;
  last_reply: string | null;
}

/** La dernière réponse rangée : redite telle quelle à une livraison répétée du même tour [R18]. */
interface StoredReply {
  say: string[];
  done: boolean;
}

function services(config: TelephonieConfig) {
  const journal = new SqlJournalStore(config.db);
  const store = new FicheClient(config.db, { now: config.now });
  const fiche = new FicheUnique(config.db, store, { now: config.now });
  const acces = new Acces(config.db, store, fiche, journal, { now: config.now });
  // Sans enregistrement demandé au service, aucun transcripteur : l'appel est rangé avec son accord, sans texte [R242].
  const appels = new Appels(config.db, journal, store, fiche, null, { now: config.now });
  const reservation = new ReservationEnLigne(config.db, journal, { now: config.now, linkBase: config.linkBase });
  return { journal, assistant: new AssistantVocal(config.db, journal, acces, reservation, appels, { now: config.now }) };
}

const findSession = (db: SqlDatabase, callSid: string): Promise<SessionRow | null> =>
  db.first<SessionRow>('SELECT id, network_id, state, turns, last_reply FROM voice_assistant_sessions WHERE provider = ? AND call_id = ?', [TELEPHONIE_PROVIDER, callSid]);

/** Au-delà, celui qui tenait l'appel est réputé tombé : un autre peut le reprendre. */
export const TELEPHONIE_LEASE_MS = 60_000;
/** Un appel plus long n'est pas lisible par HX21 : la fin rangée n'est jamais au-delà. */
const MAX_CALL_MS = 4 * 3600_000 - 1000;

/**
 * Prend l'appel pour un tour ou pour sa fin : un seul à la fois, du début du tour (réservation comprise) jusqu'à l'état
 * rangé. Rend le jeton, ou null si l'appel est déjà tenu, fini, ou n'est plus au tour attendu [R18, R710].
 */
async function claim(config: Pick<TelephonieConfig, 'db' | 'now'>, id: string, turns: number | null): Promise<string | null> {
  const at = config.now();
  const token = crypto.randomUUID();
  const stale = new Date(at.getTime() - TELEPHONIE_LEASE_MS).toISOString();
  const { changes } = await config.db.run(
    `UPDATE voice_assistant_sessions SET lease_token = ?, lease_at = ?
     WHERE id = ? AND ended_at IS NULL AND (lease_token IS NULL OR lease_at < ?)${turns === null ? '' : ' AND turns = ?'}`,
    [token, at.toISOString(), id, stale, ...(turns === null ? [] : [turns])],
  );
  return changes === 1 ? token : null;
}

const release = (db: SqlDatabase, id: string, token: string): Promise<unknown> =>
  db.run('UPDATE voice_assistant_sessions SET lease_token = NULL, lease_at = NULL WHERE id = ? AND lease_token = ?', [id, token]);

/** L'heure de fin dite par le service, s'il l'a dite. */
const endingOf = async (db: SqlDatabase, callSid: string): Promise<string | null> =>
  (await db.first<{ ended_at: string }>('SELECT ended_at FROM voice_call_endings WHERE provider = ? AND call_id = ?', [TELEPHONIE_PROVIDER, callSid]))?.ended_at ?? null;

/**
 * Un tour a pu réserver puis tomber avant de ranger son état : le rendez-vous pris pendant ce tour est retrouvé par la
 * preuve d'accord écrite avec lui, qui porte la référence de cet appel (`bookingProofOf`), jamais par le seul créneau,
 * qu'un autre appelant a pu prendre [R248, R710]. Une réservation refusée a son accord fermé à sa propre date : elle ne
 * compte pas.
 */
async function reconcileBooking(db: SqlDatabase, state: AssistantState, since: string): Promise<AssistantState> {
  if (state.booked !== null || state.pending === null || state.phase !== 'confirm') return state;
  const proof = bookingProofOf(state.provider, state.callId);
  const found = await db.first<{ kind: AssistantState['kind']; start_at: string }>(
    `SELECT a.kind, a.start_at FROM appointments a
     JOIN consents c ON c.network_id = a.network_id AND c.person_id = a.person_id
     WHERE a.network_id = ? AND a.agent_id = ? AND a.source = 'assistant' AND a.status = 'booked' AND a.start_at = ? AND a.created_at >= ?
       AND substr(c.proof, -length(?)) = ? AND c.given_at >= ? AND a.created_at >= c.given_at
       AND (c.withdrawn_at IS NULL OR c.withdrawn_at <> c.given_at)
     ORDER BY a.created_at LIMIT 1`,
    [state.networkId, state.agentId, state.pending, since, proof, proof, since],
  );
  return found ? { ...state, booked: { kind: found.kind, start: found.start_at }, pending: null, phase: 'done' } : state;
}

/**
 * L'appel est fini, tenu par `token` : rangé par HX21 avec l'heure de fin dite par le service (sinon la dernière
 * nouvelle de l'appel), la main passe à l'agent, puis l'état (et le numéro qu'il porte) est effacé [R18]. Si HX21 ne
 * range pas l'appel, rien n'est effacé : l'appel reste à reprendre.
 */
async function endSession(config: Pick<TelephonieConfig, 'db' | 'now'>, assistant: AssistantVocal, id: string, token: string): Promise<void> {
  const row = await config.db.first<{ state: string | null; call_id: string; updated_at: string }>(
    'SELECT state, call_id, updated_at FROM voice_assistant_sessions WHERE id = ? AND lease_token = ?',
    [id, token],
  );
  if (!row || row.state === null) return;
  const state = await reconcileBooking(config.db, JSON.parse(row.state) as AssistantState, row.updated_at);
  const started = Date.parse(state.startedAt);
  const said = Date.parse((await endingOf(config.db, row.call_id)) ?? row.updated_at);
  const endedAt = new Date(Math.min(Math.max(Number.isFinite(said) ? said : started, started), started + MAX_CALL_MS));
  const handoff = await assistant.finish(state, { endedAt, recordingRef: null });
  if (handoff.call === null) throw new Error('Appel non rangé par HX21 : à reprendre.');
  const at = config.now().toISOString();
  await config.db.run(
    `UPDATE voice_assistant_sessions SET state = NULL, last_reply = NULL, ended_at = ?, updated_at = ?, lease_token = NULL, lease_at = NULL
     WHERE id = ? AND lease_token = ? AND ended_at IS NULL`,
    [at, at, id, token],
  );
}

/** Rend l'appel ; si la fin est arrivée pendant qu'il était tenu, le reprend et le finit [R18]. */
async function releaseOrFinish(config: TelephonieConfig, assistant: AssistantVocal, id: string, callSid: string, token: string): Promise<void> {
  if ((await endingOf(config.db, callSid)) !== null) return endSession(config, assistant, id, token);
  await release(config.db, id, token);
  // La fin a pu arriver entre la lecture et la libération, sans pouvoir prendre l'appel : on la refait ici.
  if ((await endingOf(config.db, callSid)) !== null) {
    const again = await claim(config, id, null);
    if (again) await endSession(config, assistant, id, again);
  }
}

/** Le tour attendu, porté par l'adresse de l'écoute (signée avec elle) : `?n=<tour>`. */
function turnOf(url: string): number | null {
  const n = new URL(url).searchParams.get('n');
  return n !== null && /^\d{1,3}$/.test(n) ? Number(n) : null;
}

export async function handleTelephonie(request: Request, path: string, config: TelephonieConfig): Promise<Response> {
  if (request.method !== 'POST') return json(405, { ok: false, code: 'method_not_allowed', message: 'Méthode non admise.' });
  if (!telephonieOpen(config)) return json(503, { ok: false, code: 'not_configured', message: 'Raccordement téléphonique fermé : réglages incomplets.' });
  const form = await readForm(request);
  if (form === null) return json(400, { ok: false, code: 'invalid_body', message: 'Formulaire attendu.' });
  const signature = request.headers.get('x-twilio-signature') ?? '';
  const expected = await twilioSignature(config.authToken!, request.url, form);
  // Une signature fausse, ou un autre compte du service : rien n'est lu ni rangé [R710].
  if (signature === '' || !sameText(signature, expected) || form.get('AccountSid') !== config.accountSid) {
    return json(403, { ok: false, code: 'bad_signature', message: 'Requête non signée par le service téléphonique.' });
  }
  const callSid = form.get('CallSid') ?? '';
  if (!CALL_SID.test(callSid)) return json(400, { ok: false, code: 'bad_call', message: 'Appel mal formé.' });
  // Le tour suivant, à côté de l'adresse appelée : /v1/telephonie/<étape> → /v1/telephonie/tour?n=<tour attendu>.
  const tourUrl = (turns: number): string => {
    const u = new URL('tour', request.url);
    u.search = `?n=${turns}`;
    return u.toString();
  };
  const { journal, assistant } = services(config);

  if (path === TELEPHONIE_PATHS.appel) {
    const held = await findSession(config.db, callSid);
    // Une seconde livraison du même appel : il reste pris une seule fois, la dernière réponse est redite [R18].
    if (held) return replay(held, tourUrl);
    const forwardedFrom = form.get('ForwardedFrom');
    const started = forwardedFrom
      ? await assistant.start({
          provider: TELEPHONIE_PROVIDER,
          callId: callSid,
          from: callerOf(form.get('From')),
          forwardedFrom,
          forwardReason: 'conditional',
          startedAt: config.now(),
          propertyId: null,
          originCode: null,
        })
      : ({ ok: false, code: 'not_forwarded' } as const);
    if (!started.ok) {
      // Au journal : la raison seulement, ni numéro ni nom [R13].
      await appendEvent(journal, { type: 'voix.telephonie_refus', actor: 'system', subject: 'telephonie', data: { rule: 'R710', code: started.code } }, config.now);
      return hangUp([TELEPHONIE_REFUS[started.code] ?? TELEPHONIE_REFUS.bad_call!]);
    }
    const at = config.now().toISOString();
    const id = crypto.randomUUID();
    const reply: StoredReply = { say: started.say, done: false };
    try {
      await config.db.run(
        'INSERT INTO voice_assistant_sessions (id, network_id, agent_id, provider, call_id, state, turns, last_reply, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?)',
        [id, started.state.networkId, started.state.agentId, TELEPHONIE_PROVIDER, callSid, JSON.stringify(started.state), JSON.stringify(reply), at, at],
      );
    } catch (error) {
      if (/UNIQUE/i.test(String(error))) {
        const other = await findSession(config.db, callSid);
        return other ? replay(other, tourUrl) : hangUp([]);
      }
      throw error;
    }
    // L'appelant a pu raccrocher pendant que l'appel était décroché : sa fin, rangée à part, le finit tout de suite.
    if ((await endingOf(config.db, callSid)) !== null) {
      const token = await claim(config, id, null);
      if (token) await endSession(config, assistant, id, token);
      return hangUp([]);
    }
    return listen(started.say, tourUrl(0));
  }

  if (path === TELEPHONIE_PATHS.tour) {
    const row = await findSession(config.db, callSid);
    if (!row || row.state === null) return hangUp([]);
    const expectedTurn = turnOf(request.url);
    // Un tour déjà fait, livré de nouveau : sa réponse est redite, rien n'est rejoué [R18].
    if (expectedTurn === null || expectedTurn !== row.turns) return replay(row, tourUrl);
    // Le tour tient l'appel de bout en bout : une fin livrée pendant la réservation ne range pas un état périmé [R18].
    const token = await claim(config, row.id, row.turns);
    if (token === null) return listen([], tourUrl(row.turns));
    const held = await config.db.first<{ state: string | null }>('SELECT state FROM voice_assistant_sessions WHERE id = ? AND lease_token = ?', [row.id, token]);
    if (!held || held.state === null) return hangUp([]);
    let turn;
    let stored = false;
    try {
      turn = await assistant.hear(JSON.parse(held.state) as AssistantState, (form.get('SpeechResult') ?? '').slice(0, 1000));
      const reply: StoredReply = { say: turn.say, done: turn.done };
      await config.db.run('UPDATE voice_assistant_sessions SET state = ?, turns = ?, last_reply = ?, updated_at = ? WHERE id = ? AND lease_token = ?', [
        JSON.stringify(turn.state),
        turn.state.turns,
        JSON.stringify(reply),
        config.now().toISOString(),
        row.id,
        token,
      ]);
      stored = true;
      if (turn.done) await endSession(config, assistant, row.id, token);
      else await releaseOrFinish(config, assistant, row.id, callSid, token);
    } catch (error) {
      // Le tour tombe : l'appel est rendu ; si la fin est déjà arrivée, il est fini (rendez-vous retrouvé compris) [R18].
      await release(config.db, row.id, token);
      if ((await endingOf(config.db, callSid)) !== null) {
        const again = await claim(config, row.id, null);
        if (again) await endSession(config, assistant, row.id, again).catch(() => release(config.db, row.id, again));
      }
      if (!stored) throw error;
      // L'état est rangé : la réponse est dite, la fin sera reprise par le passage de reprise.
    }
    return turn!.done ? hangUp(turn!.say) : listen(turn!.say, tourUrl(turn!.state.turns));
  }

  if (path === TELEPHONIE_PATHS.fin) {
    if (!ENDED.has(form.get('CallStatus') ?? '')) return twiml('');
    // La fin est rangée d'abord, à part : elle vaut même si l'appel n'est pas encore décroché ou si un tour le tient.
    const at = config.now().toISOString();
    await config.db.run('INSERT INTO voice_call_endings (provider, call_id, ended_at, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (provider, call_id) DO NOTHING', [
      TELEPHONIE_PROVIDER,
      callSid,
      at,
      at,
    ]);
    const row = await findSession(config.db, callSid);
    if (!row || row.state === null) return twiml('');
    // Un tour en cours tient l'appel : c'est lui qui le finira, avec l'état qu'il range [R18, R248, R04].
    const token = await claim(config, row.id, null);
    if (token) await endSession(config, assistant, row.id, token);
    return twiml('');
  }

  return json(404, { ok: false, code: 'not_found', message: 'Adresse inconnue.' });
}

/** Redit la dernière réponse rangée, avec l'écoute du tour attendu ; un appel fini raccroche [R18]. */
function replay(row: SessionRow, tourUrl: (turns: number) => string): Response {
  if (row.state === null) return hangUp([]);
  const last: StoredReply = row.last_reply ? (JSON.parse(row.last_reply) as StoredReply) : { say: [], done: false };
  return last.done ? hangUp(last.say) : listen(last.say, tourUrl(row.turns));
}

/** Un appel sans nouvelle depuis ce délai est réputé fini, même si le service ne l'a pas dit. */
export const TELEPHONIE_SILENCE_MS = 30 * 60_000;

/**
 * Le passage de reprise (chaque quart d'heure) : un appel dit fini que personne n'a pu finir (tour tombé, fin livrée
 * pendant un tour en panne), ou resté sans nouvelle, est fini ici, rangé une fois et passé à l'agent [R18, R710].
 * Une panne sur un appel est écrite au journal et n'arrête pas les autres. Rend le nombre d'appels finis.
 */
export async function runTelephoniePass(config: Pick<TelephonieConfig, 'db' | 'now' | 'linkBase'>): Promise<number> {
  const full: TelephonieConfig = { ...config, mode: undefined, accountSid: undefined, authToken: undefined };
  const at = config.now();
  const stale = new Date(at.getTime() - TELEPHONIE_LEASE_MS).toISOString();
  const silent = new Date(at.getTime() - TELEPHONIE_SILENCE_MS).toISOString();
  const rows = await config.db.all<{ id: string }>(
    `SELECT s.id FROM voice_assistant_sessions s
     WHERE s.ended_at IS NULL AND (s.lease_token IS NULL OR s.lease_at < ?)
       AND (s.updated_at < ? OR EXISTS (SELECT 1 FROM voice_call_endings e WHERE e.provider = s.provider AND e.call_id = s.call_id))
     ORDER BY s.updated_at LIMIT 50`,
    [stale, silent],
  );
  const { journal, assistant } = services(full);
  let ended = 0;
  for (const { id } of rows) {
    const token = await claim(full, id, null);
    if (!token) continue;
    try {
      await endSession(full, assistant, id, token);
      ended += 1;
    } catch (error) {
      await release(config.db, id, token);
      await appendEvent(journal, { type: 'voix.telephonie_reprise_echec', actor: 'system', subject: 'telephonie', data: { rule: 'R710', error: error instanceof Error ? error.name : 'unknown' } }, config.now);
    }
  }
  return ended;
}
