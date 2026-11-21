/**
 * AU018 · La visite sans réseau, branchée à l'API de l'application de l'agent (HX12) :
 *
 *   GET  /v1/hors-ligne/paquet?jour=AAAA-MM-JJ : le paquet du jour, sans rien d'un client, gardé par le téléphone [R278]
 *   POST /v1/hors-ligne/saisies { deviceId, ops } : les saisies faites sans réseau, reçues chacune une seule fois [R276]
 *   GET  /v1/hors-ligne/depart/<rendez-vous> : ce qui manque encore avant de repartir [R277]
 *   POST /v1/hors-ligne/photos/<appareil>/<saisie> : le fichier JPEG de l'image entière d'une photo déjà reçue, rangé
 *        seulement s'il est celui que la saisie annonçait [R677]
 *   POST /v1/hors-ligne/prive : le mode privé du jour, sur le geste de l'agent : adresse du bien, nom et numéro de la
 *        personne rencontrée, chiffrés ensuite sur le téléphone sous un code qui ne le quitte jamais [R676]
 *
 * Seul l'agent en activité prépare et envoie ; la couche métier refuse tout autre rôle et l'écrit au journal [R16].
 * Le rôle est contrôlé avant que le corps soit lu. Rien n'est envoyé à personne.
 */
import { horsLigne, type JournalStore, type SqlDatabase, type Viewer } from '@aimmo/core';
import { readCapped } from './studio.ts';

/**
 * Un envoi du téléphone : au plus `BATCH_LIMIT` saisies, chacune avec au plus cinq prises réduites de 128 points de
 * côté. Le téléphone coupe ses envois pour rester dessous.
 */
export const MAX_SAISIES_BODY_BYTES = 1_000_000;
/** Le téléphone n'envoie pas plus de tant de saisies à la fois : avec des photos, l'envoi reste sous la limite. */
export const BATCH_LIMIT = 8;
/** Le fichier d'une image entière, au plus [R677]. */
export const MAX_IMAGE_BODY_BYTES = horsLigne.IMAGE_MAX_BYTES;
const ID = /^[A-Za-z0-9_-]{8,64}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

export interface HorsLigneServices {
  db: SqlDatabase;
  journal: JournalStore;
  now: () => Date;
  /** Le rangement des images entières (R2) ; absent, le fichier reste sur le téléphone, qui le renverra [R677]. */
  images?: horsLigne.VisitImageStore | null;
}

export interface HorsLigneRoute {
  method: 'GET' | 'POST';
  pattern: RegExp;
  name: string;
  handle: (s: HorsLigneServices, viewer: Viewer, params: string[], request: Request) => Promise<Response>;
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
const failure = (status: number, code: string): Response => json(status, { ok: false, rule: null, code });

type Refusal = { ok: false; rule: string | null; code: string };
function refused(r: Refusal): Response {
  if (r.rule === 'R16') return json(403, { ok: false, rule: 'R16', code: r.code });
  if (r.code === 'unknown_appointment' || r.code === 'photo_inconnue') return json(404, { ok: false, rule: null, code: r.code });
  if (r.rule === null && /^bad_/.test(r.code)) return json(400, { ok: false, rule: null, code: r.code });
  return json(409, { ok: false, rule: r.rule, code: r.code });
}

/**
 * La marque de l'agent sur son téléphone : une empreinte de son réseau et de son identifiant, jamais l'identifiant ni la
 * clé. Le téléphone y range sa boîte et son paquet, pour que deux agents sur le même appareil ne se mélangent pas [R16].
 */
export async function ownerMark(viewer: Viewer): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`aimmo-hors-ligne:${viewer.networkId}:${viewer.userId}`)));
  return [...bytes.slice(0, 16)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const server = (s: HorsLigneServices) => new horsLigne.HorsLigne(s.db, s.journal, { now: s.now });

/** Le corps d'un envoi, lu seulement s'il est du JSON sous la limite. */
async function readBatch(request: Request): Promise<Record<string, unknown> | 'trop_lourd' | null> {
  if (!(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) return null;
  const length = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(length) && length > MAX_SAISIES_BODY_BYTES) return 'trop_lourd';
  // Lu par morceaux, coupé dès la limite passée : un envoi sans longueur annoncée n'est jamais gardé en entier.
  const bytes = await readCapped(request, MAX_SAISIES_BODY_BYTES);
  if (bytes === null) return 'trop_lourd';
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function horsLigneRoutes(): HorsLigneRoute[] {
  return [
    {
      method: 'GET',
      pattern: /^\/hors-ligne\/paquet$/,
      name: 'hors_ligne.paquet',
      handle: async (s, viewer, _params, request) => {
        const jour = new URL(request.url).searchParams.get('jour');
        if (jour !== null && !DAY.test(jour)) return failure(400, 'bad_day');
        const r = await server(s).pack(viewer, jour ?? undefined);
        if (!r.ok) return refused(r);
        return json(200, { ok: true, mode: 'essai', sent: false, data: { pack: r.pack, batchLimit: BATCH_LIMIT, owner: await ownerMark(viewer) } });
      },
    },
    {
      method: 'POST',
      pattern: /^\/hors-ligne\/saisies$/,
      name: 'hors_ligne.saisies',
      handle: async (s, viewer, _params, request) => {
        // Le rôle d'abord : un autre rôle est refusé, et le refus écrit au journal, sans que le corps soit lu [R16].
        if (viewer.role !== 'agent') {
          const r = await server(s).receive(viewer, {});
          return r.ok ? failure(500, 'internal') : refused(r);
        }
        const body = await readBatch(request);
        if (body === 'trop_lourd') return failure(413, 'trop_lourd');
        if (!body) return failure(400, 'invalid_body');
        if (Object.keys(body).some((k) => k !== 'deviceId' && k !== 'ops')) return failure(400, 'unexpected_field');
        const r = await server(s).receive(viewer, { deviceId: body.deviceId, ops: body.ops });
        if (!r.ok) return refused(r);
        return json(200, { ok: true, mode: 'essai', sent: false, data: { results: r.results } });
      },
    },
    {
      method: 'POST',
      pattern: /^\/hors-ligne\/photos\/([A-Za-z0-9_-]{1,64})\/([A-Za-z0-9_-]{1,64})$/,
      name: 'hors_ligne.photo',
      handle: async (s, viewer, params, request) => {
        // Le rôle d'abord, avant de lire le fichier [R16].
        if (viewer.role !== 'agent') {
          const r = await server(s).depositImage(viewer, params[0], params[1], null, null);
          return r.ok ? failure(500, 'internal') : refused(r);
        }
        if ((request.headers.get('content-type') ?? '').toLowerCase().split(';')[0]?.trim() !== horsLigne.IMAGE_TYPE) return failure(415, 'type_image');
        const length = Number(request.headers.get('content-length') ?? '0');
        if (Number.isFinite(length) && length > MAX_IMAGE_BODY_BYTES) return failure(413, 'trop_lourd');
        const bytes = await readCapped(request, MAX_IMAGE_BODY_BYTES);
        if (bytes === null) return failure(413, 'trop_lourd');
        const r = await server(s).depositImage(viewer, params[0], params[1], bytes, s.images ?? null);
        if (!r.ok) return r.code === 'depot_indisponible' ? json(503, { ok: false, rule: null, code: r.code }) : refused(r);
        return json(200, { ok: true, mode: 'essai', sent: false, data: { rangee: true, again: r.again } });
      },
    },
    {
      method: 'POST',
      pattern: /^\/hors-ligne\/prive$/,
      name: 'hors_ligne.prive',
      // Aucun corps n'est lu : le code de l'agent ne part jamais au serveur [R676].
      handle: async (s, viewer) => {
        const r = await server(s).privatePack(viewer);
        if (!r.ok) return refused(r);
        return json(200, { ok: true, mode: 'essai', sent: false, data: { pack: r.pack, owner: await ownerMark(viewer) } });
      },
    },
    {
      method: 'GET',
      pattern: /^\/hors-ligne\/depart\/([A-Za-z0-9_-]{1,64})$/,
      name: 'hors_ligne.depart',
      handle: async (s, viewer, params) => {
        const id = params[0] ?? '';
        if (!ID.test(id)) return failure(400, 'bad_appointment');
        const r = await server(s).departure(viewer, id);
        if (!r.ok) return refused(r);
        return json(200, { ok: true, mode: 'essai', sent: false, data: { check: r.check } });
      },
    },
  ];
}
