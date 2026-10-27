/**
 * Les routes de M07 Commercialiser (P09), sous `/v1/annonces`, et le passage de publication pour le planificateur.
 *
 * Ce fichier ne touche pas aux fichiers du socle : il expose `ANNONCE_ROUTES`, de la même forme que les routes de
 * `app.ts`, et `syncAnnonces` pour un passage toutes les 15 minutes. Leur branchement dans `app.ts` et `worker.ts`
 * (une ligne chacun) est laissé à la voie 1 du chantier, qui tient les fichiers du socle (PROTOCOLE, section 8).
 *
 * Chaque route passe par les droits de la couche métier [R16] ; les refus y sont écrits au journal. Aucune route ne
 * publie elle-même : la publication passe par la porte de diffusion, la liste de contrôle et la validation [R42, R43,
 * R47], au passage suivant ou par la route de passage immédiat.
 */
import { appendEvent, type Acces, type JournalStore, type SqlDatabase, type Viewer } from '@aimmo/core';
// Le module M07 n'est pas encore exporté par `@aimmo/core` (fichier du socle) : on le lit à sa place.
import {
  Annonces,
  FicheBien,
  MediasBien,
  MentionsAnnonce,
  MesureBiens,
  Publication,
  shootingPlan,
  type ListingChannel,
  type ListingWriter,
  type PropertySheet,
} from '../../core/src/annonces/index.ts';

export const TRIAL_MODE = 'essai';
const MAX_BODY_BYTES = 64_000;
const ID = '([A-Za-z0-9_-]{1,64})';

export interface AnnonceServices {
  db: SqlDatabase;
  journal: JournalStore;
  acces: Acces;
  now: () => Date;
}

export interface AnnonceOptions {
  writer?: ListingWriter;
  channels?: readonly ListingChannel[];
}

export interface AnnonceRoute {
  method: 'GET' | 'POST';
  pattern: RegExp;
  /** Nom de la route pour le journal : jamais l'identifiant demandé. */
  name: string;
  handle: (s: AnnonceServices, viewer: Viewer, params: string[], request: Request) => Promise<Response>;
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
  });
const failure = (status: number, code: string, message: string): Response => json(status, { ok: false, code, message });

type Outcome = { ok: true; value?: unknown; [k: string]: unknown } | { ok: false; rule: string | null; code: string; [k: string]: unknown };

/** Une réponse de la couche métier : 200, 403 pour un refus de droits, 404 inconnu, 409 pour une règle, 400 sinon. */
function reply(result: Outcome): Response {
  if (result.ok) {
    const { ok: _ok, value, ...rest } = result;
    return json(200, { ok: true, mode: TRIAL_MODE, data: value ?? null, ...rest });
  }
  const { ok: _ok, ...rest } = result;
  if (result.rule === 'R16') return json(403, { ok: false, ...rest });
  if (/^unknown|^no_/.test(result.code)) return json(404, { ok: false, ...rest });
  return json(result.rule ? 409 : 400, { ok: false, ...rest });
}

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  if (!(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) return null;
  const text = await request.text();
  if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) return null;
  try {
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const badBody = (): Response => failure(400, 'invalid_body', 'Corps JSON attendu.');

/** Les routes de M07, à ajouter à celles de `app.ts`. `options` porte l'IA et les canaux, absents : secours et essai. */
export function annonceRoutes(options: AnnonceOptions = {}): AnnonceRoute[] {
  const fiches = (s: AnnonceServices) => new FicheBien(s.db, s.acces, s.journal, { now: s.now });
  const mentions = (s: AnnonceServices) => new MentionsAnnonce(s.db, s.acces, s.journal, { now: s.now });
  const annonces = (s: AnnonceServices) => new Annonces(s.db, s.acces, s.journal, { now: s.now, ...(options.writer ? { writer: options.writer } : {}) });
  const publication = (s: AnnonceServices) => new Publication(s.db, s.acces, s.journal, { now: s.now, ...(options.channels ? { channels: options.channels } : {}) });
  const medias = (s: AnnonceServices) => new MediasBien(s.db, s.acces, s.journal, { now: s.now });
  const mesure = (s: AnnonceServices) => new MesureBiens(s.db, s.acces, s.journal, { now: s.now });
  return [
    { method: 'GET', pattern: new RegExp(`^/annonces/${ID}/fiche$`), name: 'annonces.fiche', handle: async (s, v, [id]) => reply(await fiches(s).read(v, id!)) },
    {
      method: 'POST',
      pattern: new RegExp(`^/annonces/${ID}/fiche$`),
      name: 'annonces.fiche.enregistrer',
      handle: async (s, v, [id], request) => {
        const body = await readJson(request);
        return body ? reply(await fiches(s).save(v, id!, body)) : badBody();
      },
    },
    { method: 'GET', pattern: new RegExp(`^/annonces/${ID}/controle$`), name: 'annonces.controle', handle: async (s, v, [id]) => reply(await mentions(s).check(v, id!)) },
    { method: 'GET', pattern: new RegExp(`^/annonces/${ID}/brouillon$`), name: 'annonces.brouillon', handle: async (s, v, [id]) => reply(await annonces(s).read(v, id!)) },
    { method: 'POST', pattern: new RegExp(`^/annonces/${ID}/brouillon$`), name: 'annonces.brouillon.proposer', handle: async (s, v, [id]) => reply(await annonces(s).propose(v, id!)) },
    {
      method: 'POST',
      pattern: new RegExp(`^/annonces/${ID}/correction$`),
      name: 'annonces.correction',
      handle: async (s, v, [id], request) => {
        const body = await readJson(request);
        return body ? reply(await annonces(s).correct(v, id!, { title: body.title, body: body.body })) : badBody();
      },
    },
    { method: 'POST', pattern: new RegExp(`^/annonces/brouillons/${ID}/validation$`), name: 'annonces.validation', handle: async (s, v, [id]) => reply(await annonces(s).validate(v, id!)) },
    { method: 'GET', pattern: new RegExp(`^/annonces/${ID}/publication$`), name: 'annonces.publication', handle: async (s, v, [id]) => reply(await publication(s).status(v, id!)) },
    {
      method: 'POST',
      pattern: new RegExp(`^/annonces/${ID}/publication$`),
      name: 'annonces.publication.passage',
      // Un passage immédiat pour ce bien, après une validation ou un avenant : mêmes portes que le passage planifié.
      handle: async (s, v, [id]) => {
        const status = await publication(s).status(v, id!);
        if (!status.ok) return reply(status);
        if (v.role !== 'agent' && v.role !== 'direction') {
          await appendEvent(s.journal, { type: 'acces.refuse', actor: `${String(v.role)}:${v.userId}`, subject: `property:${id}`, data: { rule: 'R16', role: String(v.role), kind: 'listing_sync', code: 'role' } }, s.now);
          return reply({ ok: false, rule: 'R16', code: 'role' });
        }
        return reply({ ok: true, value: await publication(s).sync(v.networkId, id!) });
      },
    },
    {
      method: 'GET',
      pattern: new RegExp(`^/annonces/${ID}/semaine$`),
      name: 'annonces.semaine',
      handle: async (s, v, [id], request) => reply(await mesure(s).weekly(v, id!, new URL(request.url).searchParams.get('lundi') ?? '')),
    },
    {
      method: 'POST',
      pattern: new RegExp(`^/annonces/${ID}/videos/controle$`),
      name: 'annonces.video.controle',
      handle: async (s, v, [id], request) => {
        const body = await readJson(request);
        if (!body || typeof body.ref !== 'string') return badBody();
        return reply(await medias(s).checkVideoText(v, id!, body.ref, { subtitles: body.subtitles, caption: body.caption }));
      },
    },
    {
      method: 'GET',
      pattern: new RegExp(`^/annonces/${ID}/plan-de-tournage$`),
      name: 'annonces.plan_tournage',
      handle: async (s, v, [id]) => {
        const sheet = await fiches(s).read(v, id!);
        if (!sheet.ok && sheet.code !== 'no_sheet') return reply(sheet);
        const property = await s.db.first<{ rooms: number | null }>('SELECT rooms FROM properties WHERE id = ?', [id!]);
        const plan = shootingPlan({ rooms: property?.rooms ?? null, sheet: sheet.ok ? (sheet.value.sheet as PropertySheet) : null });
        return reply({ ok: true, value: plan });
      },
    },
  ];
}

/**
 * Un passage de publication pour un réseau, à lancer toutes les 15 minutes par le planificateur : publié partout en
 * moins d'une heure après la fin du délai de rétractation, prix répercuté en moins de 15 minutes.
 */
export async function syncAnnonces(s: AnnonceServices, networkId: string, options: AnnonceOptions = {}): Promise<{ properties: number; failed: number }> {
  const all = await new Publication(s.db, s.acces, s.journal, { now: s.now, ...(options.channels ? { channels: options.channels } : {}) }).syncAll(networkId);
  return { properties: all.length, failed: all.filter((r) => r.result === null).length };
}
