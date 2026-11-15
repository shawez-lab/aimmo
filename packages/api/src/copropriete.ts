/**
 * Les routes de la copropriété et de l'urbanisme résumés (HX35, RC42, RC43 ; RC52), sous
 * `/v1/dossiers/<id>/copropriete`.
 *
 * - `POST …/prelecture` : la prélecture des documents (RC42), rien n'est rangé ; sans lecteur IA, tout est à lire.
 * - `POST …/resume` : le résumé préparé par l'agent du bien (HX35), phrases vérifiées contre leur page [R448].
 * - `GET …/resume` : le dernier résumé, pour qui voit le dossier en entier [R16].
 * - `GET …/acquereur` : les travaux votés à venir, tels qu'ils se disent à l'acquéreur [R451].
 *
 * Jamais vu : les données publiques ne sont jamais reçues de l'écran. Un corps qui en porte est refusé [R449]. La zone
 * du plan d'urbanisme est lue ici, au Géoportail, au point du bien : l'agent tape l'adresse du bien, la Base adresse
 * nationale la géocode, et la zone n'est demandée que si l'adresse trouvée est sûre et dans la commune du bien (même
 * code postal). Seuls la position et le code INSEE partent au Géoportail ; l'adresse n'est ni gardée ni écrite au
 * journal [R13]. Le dossier est contrôlé avant tout géocodage : un refus ne fait partir aucune requête [R16].
 *
 * Le registre des copropriétés reste « non collecté » : il n'a pas d'API ouverte stable.
 */
import { Acces, FicheClient, FicheUnique, appendEvent, type JournalStore, type SqlDatabase, type Viewer } from '@aimmo/core';
import { CoproprieteUrbanisme, PUBLIC_SOURCES, type PublicFact, type UrbanismValue } from '../../core/src/documents/copropriete-urbanisme.ts';
import { LectureCopropriete, type CoproReader, type UrbanismPoint } from '../../core/src/documents/index.ts';
import { gateSaleFile } from '../../core/src/dossiers/acces-dossier.ts';
import type { Geocoder } from '../../core/src/estimation/collecte.ts';

export const TRIAL_MODE = 'essai';
/** Le corps d'une requête : le texte des pages de 30 documents tient largement dans 4 Mo. */
export const MAX_COPROPRIETE_BODY_BYTES = 4 * 1024 * 1024;
/** La confiance minimale du géocodage pour demander la zone : en dessous, l'adresse n'est pas sûre. */
export const MIN_GEOCODE_SCORE = 0.6;
const MAX_ADDRESS = 200;
const ID = '([A-Za-z0-9_-]{1,64})';

export interface CoproprieteServices {
  db: SqlDatabase;
  journal: JournalStore;
  now: () => Date;
  newId?: () => string;
  /** Le lecteur IA de la prélecture ; absent, aucune phrase n'est proposée et tout est à lire [R12]. */
  reader?: CoproReader | null;
  /** La Base adresse nationale ; absente, la zone n'est pas collectée. */
  geocoder?: Geocoder | null;
  /** Le Géoportail de l'urbanisme (`GpuUrbanism`) ; absent, la zone n'est pas collectée. */
  urbanism?: { collect(point: UrbanismPoint): Promise<PublicFact<UrbanismValue>> } | null;
}

type Role = Viewer['role'];
const WRITER: readonly Role[] = ['agent'];
const READERS: readonly Role[] = ['agent', 'direction', 'compliance'];

export interface CoproprieteRoute {
  method: 'GET' | 'POST';
  pattern: RegExp;
  /** Nom de la route pour le journal : jamais l'identifiant demandé. */
  name: string;
  /** Les rôles admis : un autre est refusé, au journal, avant toute lecture du corps [R16]. */
  roles: readonly Role[];
  handle: (s: CoproprieteServices, viewer: Viewer, params: string[], request: Request) => Promise<Response>;
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
  });

type Outcome = { ok: true; value?: unknown } | { ok: false; rule: string | null; code: string };

/** 200 ; 403 refus de droits ; 404 dossier ou résumé inconnu ; 409 dossier arrêté ou préparation simultanée ; 400 sinon. */
function reply(result: Outcome): Response {
  if (result.ok) return json(200, { ok: true, mode: TRIAL_MODE, data: result.value ?? null });
  const { rule, code } = result;
  if (code === 'unknown_file' || code === 'no_summary') return json(404, { ok: false, rule, code });
  if (rule === 'R16') return json(403, { ok: false, rule, code });
  if (code === 'file_stopped' || code === 'busy') return json(409, { ok: false, rule, code });
  return json(400, { ok: false, rule, code });
}

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  if (!(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) return null;
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > MAX_COPROPRIETE_BODY_BYTES) return null;
  const text = await request.text();
  if (new TextEncoder().encode(text).length > MAX_COPROPRIETE_BODY_BYTES) return null;
  try {
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Les objets métier, faits à chaque requête sur les mêmes services. */
export function coproprieteCore(s: CoproprieteServices) {
  const store = new FicheClient(s.db, { now: s.now });
  const acces = new Acces(s.db, store, new FicheUnique(s.db, store, { now: s.now }), s.journal, { now: s.now });
  return {
    acces,
    summary: new CoproprieteUrbanisme(s.db, acces, s.journal, { now: s.now, ...(s.newId ? { newId: s.newId } : {}) }),
    preReading: new LectureCopropriete(s.db, acces, s.journal, s.reader ?? null, { now: s.now }),
  };
}

const actor = (v: Viewer): string => `${String(v.role)}:${v.userId}`;

/** Un rôle que la route n'admet pas : refusé et écrit au journal, avant toute lecture [R16]. */
async function refuseRole(s: CoproprieteServices, v: Viewer, fileId: string): Promise<Response> {
  await appendEvent(s.journal, { type: 'acces.refuse', actor: actor(v), subject: `sale_file:${fileId}`, data: { rule: 'R16', role: String(v.role), kind: 'coownership_summary', code: 'role' } }, s.now);
  return reply({ ok: false, rule: 'R16', code: 'role' });
}

const guarded =
  (roles: readonly Role[], fn: (s: CoproprieteServices, v: Viewer, fileId: string, request: Request) => Promise<Response>) =>
  async (s: CoproprieteServices, v: Viewer, [fileId]: string[], request: Request): Promise<Response> =>
    roles.includes(v.role) ? fn(s, v, fileId!, request) : refuseRole(s, v, fileId!);

type Collection = 'trouve' | 'introuvable' | 'panne' | 'non_collecte';

/**
 * La zone d'urbanisme au point du bien, ou `undefined` quand elle n'est pas collectée. L'adresse tapée ne sert qu'au
 * géocodage : elle n'est ni rendue, ni gardée, ni écrite au journal [R13].
 */
async function collectUrbanism(s: CoproprieteServices, propertyId: string, address: string | null): Promise<{ fact: PublicFact<UrbanismValue> | undefined; outcome: Collection; why: string | null }> {
  if (address === null || !s.geocoder || !s.urbanism) return { fact: undefined, outcome: 'non_collecte', why: address === null ? 'sans_adresse' : 'service_absent' };
  const failed = (reason: 'introuvable' | 'panne', why: string) => ({
    fact: { ok: false as const, source: PUBLIC_SOURCES.urbanism, collectedAt: s.now().toISOString(), reason },
    outcome: reason,
    why,
  });
  const property = await s.db.first<{ postal_code: string | null }>('SELECT postal_code FROM properties WHERE id = ?', [propertyId]);
  let place;
  try {
    place = await s.geocoder.geocode(address);
  } catch {
    return failed('panne', 'geocodage_en_panne');
  }
  if (!place) return failed('introuvable', 'adresse_introuvable');
  if (!(typeof place.score === 'number' && place.score >= MIN_GEOCODE_SCORE)) return failed('introuvable', 'adresse_incertaine');
  // La zone n'est demandée que dans la commune du bien : une adresse d'ailleurs ne décrit pas ce bien.
  if (!property?.postal_code || place.postalCode !== property.postal_code) return failed('introuvable', 'autre_commune');
  if (!Number.isFinite(place.lat) || !Number.isFinite(place.lon) || typeof place.inseeCode !== 'string') return failed('introuvable', 'adresse_introuvable');
  try {
    const fact = await s.urbanism.collect({ lat: place.lat, lon: place.lon, inseeCode: place.inseeCode });
    return { fact, outcome: fact.ok ? 'trouve' : fact.reason, why: null };
  } catch {
    return failed('panne', 'geoportail_en_panne');
  }
}

async function prepare(s: CoproprieteServices, v: Viewer, fileId: string, request: Request): Promise<Response> {
  const body = await readJson(request);
  if (!body) return json(400, { ok: false, rule: null, code: 'invalid_body' });
  // Une donnée publique ne vient jamais de l'écran : elle est collectée ici, à sa source [R449].
  if ('publicData' in body || 'registry' in body || 'urbanism' in body) return json(400, { ok: false, rule: 'R449', code: 'public_data_not_accepted' });
  const rawAddress = body.address;
  if (rawAddress !== undefined && rawAddress !== null && (typeof rawAddress !== 'string' || rawAddress.length > MAX_ADDRESS)) return json(400, { ok: false, rule: null, code: 'invalid_address' });
  const address = typeof rawAddress === 'string' && rawAddress.trim().length > 0 ? rawAddress.trim() : null;

  const c = coproprieteCore(s);
  // Le dossier d'abord : un refus ne fait partir aucune requête, ni au géocodage ni au Géoportail [R16].
  const g = await gateSaleFile({ db: s.db, acces: c.acces, journal: s.journal, now: s.now }, v, fileId, true, 'coownership_summary');
  if (!g.ok) return reply(g);
  if (!Array.isArray(body.documents) || !Array.isArray(body.sentences)) return json(400, { ok: false, rule: null, code: 'bad_documents' });

  const urbanism = await collectUrbanism(s, g.file.property_id, address);
  await appendEvent(
    s.journal,
    { type: 'dossier.urbanisme_collecte', actor: actor(v), subject: `sale_file:${fileId}`, data: { rule: 'R449', outcome: urbanism.outcome, why: urbanism.why } },
    s.now,
  );
  const r = await c.summary.prepare(v, fileId, {
    documents: body.documents as never,
    sentences: body.sentences as never,
    publicData: urbanism.fact ? { urbanism: urbanism.fact } : {},
  });
  return reply(r);
}

async function preRead(s: CoproprieteServices, v: Viewer, fileId: string, request: Request): Promise<Response> {
  const body = await readJson(request);
  if (!body) return json(400, { ok: false, rule: null, code: 'invalid_body' });
  return reply(await coproprieteCore(s).preReading.preRead(v, fileId, { documents: body.documents }));
}

export function coproprieteRoutes(): CoproprieteRoute[] {
  return [
    { method: 'POST', pattern: new RegExp(`^/dossiers/${ID}/copropriete/prelecture$`), name: 'copropriete.prelecture', roles: WRITER, handle: guarded(WRITER, preRead) },
    { method: 'POST', pattern: new RegExp(`^/dossiers/${ID}/copropriete/resume$`), name: 'copropriete.preparer', roles: WRITER, handle: guarded(WRITER, prepare) },
    {
      method: 'GET',
      pattern: new RegExp(`^/dossiers/${ID}/copropriete/resume$`),
      name: 'copropriete.resume',
      roles: READERS,
      handle: guarded(READERS, async (s, v, fileId) => reply(await coproprieteCore(s).summary.latest(v, fileId))),
    },
    {
      method: 'GET',
      pattern: new RegExp(`^/dossiers/${ID}/copropriete/acquereur$`),
      name: 'copropriete.acquereur',
      roles: READERS,
      handle: guarded(READERS, async (s, v, fileId) => reply(await coproprieteCore(s).summary.buyerNotice(v, fileId))),
    },
  ];
}
