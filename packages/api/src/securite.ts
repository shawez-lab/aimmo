/**
 * Les routes des réclamations (HX58) et du contrôle du gel des avoirs (HX57), sous `/v1/securite` (BR01).
 *
 * Chaque route passe par les droits de la couche métier [R16], qui écrit chaque refus au journal : l'agent qui suit la
 * fiche ou la direction pour les réclamations ; le responsable de la conformité seul pour le registre du gel et ses
 * résultats ; l'agent peut demander le contrôle d'un dossier de son client, et lit toujours le même mot [R605].
 * Rien n'est envoyé : la proposition du médiateur passe par le contrôle central et les seuls canaux du mode essai [R26,
 * R607]. Les passages restent ceux du planificateur (`securite.reclamations`, `securite.gel_avoirs`).
 */
import type { Acces, JournalStore, SqlDatabase, Viewer } from '@aimmo/core';
import { ControleGels, lireRegistreDgTresor, Reclamations } from '../../core/src/securite/index.ts';

export const TRIAL_MODE = 'essai';
const MAX_BODY_BYTES = 8_000;
/** Le registre du gel compte quelques milliers de noms : son import seul a droit à un corps plus gros. */
const MAX_REGISTRY_BYTES = 4_000_000;
const ID = '([A-Za-z0-9_-]{1,64})';
/**
 * Le fichier publié par la DG Trésor porte, pour chaque entrée, tous ses champs (adresses, motifs, dates…) : bien plus
 * lourd que le registre lu. Au-delà, le téléchargement ou le dépôt est refusé sans rien ranger (BR85).
 */
export const MAX_DGTRESOR_BYTES = 40_000_000;
/** L'adresse du dernier fichier JSON publié, d'après la documentation de l'API de la DG Trésor ; à relire au premier import. */
export const REGISTRE_GELS_URL = 'https://gels-avoirs.dgtresor.gouv.fr/ApiPublic/api/v1/publication/derniere-publication-fichier-json';
/** L'API publique refuse un appel sans `User-Agent` : celui d'AIMMO, sans nom ni adresse de personne. */
export const REGISTRE_GELS_USER_AGENT = 'AIMMO-conformite/1.0 (registre national des gels)';
const DOWNLOAD_TIMEOUT_MS = 60_000;

/** Le téléchargement du fichier public du registre des gels (BR85) : une lecture en GET, jamais un envoi. */
export interface RegistreGelsSource {
  fetch: (request: Request) => Promise<Response>;
  url: string;
  userAgent: string;
}

export interface SecuriteServices {
  db: SqlDatabase;
  journal: JournalStore;
  acces: Acces;
  now: () => Date;
  /** Absent : l'import depuis la DG Trésor est fermé (503), le dépôt du fichier reste ouvert. */
  registreGels?: RegistreGelsSource | null;
}

export interface SecuriteRoute {
  method: 'GET' | 'POST';
  pattern: RegExp;
  /** Nom de la route pour le journal : jamais l'identifiant demandé. */
  name: string;
  handle: (s: SecuriteServices, viewer: Viewer, params: string[], request: Request) => Promise<Response>;
}

const HEADERS = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...HEADERS } });

type Outcome = { ok: true; value?: unknown; [k: string]: unknown } | { ok: false; rule: string | null; code: string; [k: string]: unknown };

/** 200 ; 403 pour un refus de droits ; 404 inconnu ; 409 pour une règle ; 400 sinon. */
function reply(result: Outcome): Response {
  if (result.ok) {
    const { ok: _ok, value, ...rest } = result;
    return json(200, { ok: true, mode: TRIAL_MODE, data: value ?? null, ...rest });
  }
  const { ok: _ok, ...rest } = result;
  if (result.rule === 'R16') return json(result.code === 'unknown' ? 404 : 403, { ok: false, ...rest });
  if (/^unknown/.test(result.code)) return json(404, { ok: false, ...rest });
  return json(result.rule ? 409 : 400, { ok: false, ...rest });
}

async function readJson(request: Request, limit = MAX_BODY_BYTES): Promise<Record<string, unknown> | null> {
  if (!(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) return null;
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > limit) return null;
  const text = await request.text();
  if (new TextEncoder().encode(text).length > limit) return null;
  try {
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const badBody = (): Response => json(400, { ok: false, rule: null, code: 'invalid_body', message: 'Corps JSON attendu.' });
const query = (r: Request, name: string): string | null => new URL(r.url).searchParams.get(name);

// Sans `send`, les réclamations ne passent que par les canaux du mode essai : rien ne part vraiment [R26, R607].
const reclamations = (s: SecuriteServices) => new Reclamations(s.db, s.acces, s.journal, { now: s.now });
const gels = (s: SecuriteServices) => new ControleGels(s.db, s.acces, s.journal, { now: s.now });

/**
 * Le rôle, relu par le cœur avant tout téléchargement ou lecture du fichier : il écrit lui-même le refus au journal
 * [R16]. `null` : le responsable de la conformité, qui peut continuer.
 */
async function complianceOnly(s: SecuriteServices, v: Viewer): Promise<Response | null> {
  if (v.role === 'compliance') return null;
  return reply(await gels(s).importRegistry(v, { publishedAt: null, entries: null }));
}

/** Le corps d'une réponse, lu morceau par morceau et arrêté au-delà de `limit` : jamais un fichier entier en trop. */
type Capped = { ok: true; text: string } | { ok: false; why: 'too_big' | 'bad_text' };
async function readCapped(response: Request | Response, limit: number): Promise<Capped> {
  const declared = Number(response.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > limit) return { ok: false, why: 'too_big' };
  if (!response.body) return { ok: true, text: '' };
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => undefined);
      return { ok: false, why: 'too_big' };
    }
    parts.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const p of parts) {
    all.set(p, at);
    at += p.byteLength;
  }
  try {
    return { ok: true, text: new TextDecoder('utf-8', { fatal: true }).decode(all) };
  } catch {
    return { ok: false, why: 'bad_text' };
  }
}

/**
 * Le fichier publié, lu entier ou refusé entier avec sa raison et l'identifiant de l'entrée fautive, jamais un nom
 * [R13] ; lu, il passe tel quel par `importRegistry`, qui recontrôle aussitôt chaque dossier en cours [R603, R605].
 */
async function importPublished(s: SecuriteServices, v: Viewer, text: string): Promise<Response> {
  let file: unknown;
  try {
    file = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch {
    return json(400, { ok: false, rule: null, code: 'bad_file', entryId: null });
  }
  const read = lireRegistreDgTresor(file);
  if (!read.ok) return json(400, { ok: false, rule: null, code: read.code, entryId: read.entryId });
  const { publishedAt, entries, vessels } = read.value;
  const done = await gels(s).importRegistry(v, { publishedAt, entries });
  if (!done.ok) return reply(done);
  return reply({ ok: true, value: { ...done.value, publishedAt, vessels } });
}

/** Le fichier du jour, téléchargé en GET avec l'adresse et le `User-Agent` de la configuration ; rien n'est envoyé. */
async function download(source: RegistreGelsSource): Promise<{ ok: true; text: string } | { ok: false; code: 'telechargement_echoue' | 'fichier_trop_gros' }> {
  let response: Response;
  try {
    const signal = typeof AbortSignal !== 'undefined' && 'timeout' in AbortSignal ? AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) : undefined;
    response = await source.fetch(new Request(source.url, { method: 'GET', headers: { accept: 'application/json', 'user-agent': source.userAgent }, ...(signal ? { signal } : {}) }));
  } catch {
    return { ok: false, code: 'telechargement_echoue' };
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    return { ok: false, code: 'telechargement_echoue' };
  }
  try {
    const read = await readCapped(response, MAX_DGTRESOR_BYTES);
    if (read.ok) return read;
    return read.why === 'too_big' ? { ok: false, code: 'fichier_trop_gros' } : { ok: true, text: '' };
  } catch {
    return { ok: false, code: 'telechargement_echoue' };
  }
}

/** Les routes de `/v1/securite`, à ajouter à celles de `app.ts`. */
export function securiteRoutes(): SecuriteRoute[] {
  type Handler = (s: SecuriteServices, v: Viewer, params: string[], body: Record<string, unknown>) => Promise<Response>;
  const withBody = (fn: Handler, limit = MAX_BODY_BYTES): SecuriteRoute['handle'] => async (s, v, params, request) => {
    const body = await readJson(request, limit);
    if (!body) return badBody();
    return fn(s, v, params, body);
  };
  const P = '^/securite';
  const R = `${P}/reclamations`;
  const G = `${P}/gel`;
  return [
    // Réclamations (HX58).
    {
      method: 'GET',
      pattern: new RegExp(`${R}$`),
      name: 'securite.reclamations',
      handle: async (s, v, _p, request) => {
        // Un seul paramètre admis, `fiche` (BR71) : le groupe des fiches réunies à celle-ci.
        const params = new URL(request.url).searchParams;
        const keys = [...params.keys()];
        if (keys.some((k) => k !== 'fiche') || params.getAll('fiche').length > 1) return json(400, { ok: false, rule: null, code: 'unexpected_field' });
        const fiche = params.get('fiche');
        return reply(await reclamations(s).list(v, fiche === null ? {} : { fiche }));
      },
    },
    {
      method: 'GET',
      pattern: new RegExp(`${R}/reglage$`),
      name: 'securite.reclamations.reglage_lu',
      handle: async (s, v) => reply(await reclamations(s).currentSettings(v)),
    },
    {
      method: 'POST',
      pattern: new RegExp(`${R}/reglage$`),
      name: 'securite.reclamations.reglage',
      handle: withBody(async (s, v, _p, b) => reply(await reclamations(s).configure(v, { responseDays: b.responseDays, mediatorName: b.mediatorName, mediatorSite: b.mediatorSite }))),
    },
    {
      method: 'POST',
      pattern: new RegExp(`${P}/fiches/${ID}/reclamations$`),
      name: 'securite.reclamations.ranger',
      handle: withBody(async (s, v, [personId], b) => {
        const reply_ = b.reply;
        if (reply_ !== undefined && reply_ !== null && (typeof reply_ !== 'object' || Array.isArray(reply_))) return badBody();
        const r = reply_ as { channel?: unknown; conversationId?: unknown } | null | undefined;
        return reply(
          await reclamations(s).record(v, personId!, {
            receivedOn: b.receivedOn,
            receivedBy: b.receivedBy,
            summary: b.summary,
            reply: r ? { channel: r.channel, conversationId: r.conversationId } : null,
          }),
        );
      }),
    },
    {
      method: 'POST',
      pattern: new RegExp(`${R}/${ID}/reponse$`),
      name: 'securite.reclamations.reponse',
      handle: withBody(async (s, v, [id], b) => reply(await reclamations(s).answer(v, id!, { outcome: b.outcome, note: b.note }))),
    },
    {
      method: 'POST',
      pattern: new RegExp(`${R}/${ID}/mediateur-remis$`),
      name: 'securite.reclamations.mediateur_remis',
      handle: async (s, v, [id]) => reply(await reclamations(s).handed(v, id!)),
    },
    // Gel des avoirs (HX57).
    {
      method: 'POST',
      pattern: new RegExp(`${G}/registre$`),
      name: 'securite.gel.registre',
      handle: withBody(async (s, v, _p, b) => reply(await gels(s).importRegistry(v, { publishedAt: b.publishedAt, entries: b.entries })), MAX_REGISTRY_BYTES),
    },
    {
      // BR85 : le fichier du jour téléchargé par le serveur, en un appui du responsable.
      method: 'POST',
      pattern: new RegExp(`${G}/registre/dgtresor$`),
      name: 'securite.gel.registre_dgtresor',
      handle: async (s, v) => {
        const refused = await complianceOnly(s, v);
        if (refused) return refused;
        if (!s.registreGels) return json(503, { ok: false, rule: null, code: 'telechargement_absent' });
        const got = await download(s.registreGels);
        if (!got.ok) return json(502, { ok: false, rule: null, code: got.code });
        return importPublished(s, v, got.text);
      },
    },
    {
      // BR85 : le même fichier, déposé tel qu'il est publié quand le téléchargement échoue.
      method: 'POST',
      pattern: new RegExp(`${G}/registre/fichier$`),
      name: 'securite.gel.registre_fichier',
      handle: async (s, v, _p, request) => {
        const refused = await complianceOnly(s, v);
        if (refused) return refused;
        if (!(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) return badBody();
        const read = await readCapped(request, MAX_DGTRESOR_BYTES).catch((): Capped => ({ ok: false, why: 'bad_text' }));
        if (!read.ok) return read.why === 'too_big' ? json(413, { ok: false, rule: null, code: 'fichier_trop_gros' }) : json(400, { ok: false, rule: null, code: 'bad_file', entryId: null });
        return importPublished(s, v, read.text);
      },
    },
    {
      method: 'POST',
      pattern: new RegExp(`${G}/controle$`),
      name: 'securite.gel.controle',
      // Le même mot pour tous : l'agent ne lit jamais le résultat [R605].
      handle: withBody(async (s, v, _p, b) => reply(await gels(s).checkCase(v, b.caseRef))),
    },
    {
      method: 'GET',
      pattern: new RegExp(`${G}/controles$`),
      name: 'securite.gel.controles',
      handle: async (s, v, _p, r) => {
        const caseRef = query(r, 'dossier');
        if (caseRef === null || caseRef.length > 80) return badBody();
        return reply(await gels(s).checks(v, caseRef));
      },
    },
    {
      method: 'GET',
      pattern: new RegExp(`${G}/sans-nom$`),
      name: 'securite.gel.sans_nom',
      handle: async (s, v) => reply(await gels(s).unnamedCases(v)),
    },
    {
      method: 'GET',
      pattern: new RegExp(`${G}/correspondances$`),
      name: 'securite.gel.correspondances',
      handle: async (s, v) => reply(await gels(s).matches(v)),
    },
    {
      method: 'GET',
      pattern: new RegExp(`${G}/correspondances/${ID}/fige$`),
      name: 'securite.gel.fige',
      handle: async (s, v, [id]) => reply(await gels(s).checkFrozen(v, id!)),
    },
    {
      method: 'POST',
      pattern: new RegExp(`${G}/correspondances/${ID}/decision$`),
      name: 'securite.gel.decision',
      handle: withBody(async (s, v, [id], b) => reply(await gels(s).decide(v, id!, { decision: b.decision, reason: b.reason, validatorName: b.validatorName }))),
    },
  ];
}
