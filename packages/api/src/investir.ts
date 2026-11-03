/**
 * Les routes de M17 Investir (Y07), sous `/v1/investir` : profil de l'investisseur, import des loyers de marché par la
 * direction, règles des communes, commune d'un bien, calcul du rendement, contraintes, note d'investissement et sa
 * validation, alertes aux investisseurs.
 *
 * Chaque route dit les rôles qu'elle admet ; un autre rôle est refusé et écrit au journal avant que le corps de la
 * requête soit lu [R16]. Les droits fins (fiche suivie, bien du fichier commun) restent ceux de la couche métier, qui
 * écrit aussi ses refus au journal. Aucun chiffre n'est calculé ailleurs que dans le code du serveur [R121] ; une note
 * rendue affiche toujours ses sources et ses hypothèses [R126] ; rien n'est envoyé d'ici : les alertes passent par le
 * contrôle central, en mode essai [R26].
 *
 * Après l'achat, la mise en location et les partenaires passent par les routes existantes de M15 (`/v1/location`) et
 * de M18 (`/v1/partenaires`) : rien de neuf ici. Ce fichier ne touche à aucun fichier du socle ; Y08 (voie 1) le
 * branchera au routeur.
 */
import { Acces, FicheClient, FicheUnique, appendEvent, type JournalStore, type SqlDatabase, type Viewer } from '@aimmo/core';
import {
  AlertesInvestisseurs,
  CalculInvestissement,
  Contraintes,
  LoyersMarche,
  MARKET_RENT_KINDS,
  HistoriqueProjet,
  NotesInvestissement,
  ProfilInvestisseur,
  type MarketRentKind,
  type NoteHypotheses,
  type NoteWriter,
  type Sourced,
} from '../../core/src/investir/index.ts';

export const TRIAL_MODE = 'essai';
/** Le corps d'une requête ordinaire. */
export const MAX_INVESTIR_BODY_BYTES = 64 * 1024;
/** Un fichier de la Carte des loyers : moins de 36 000 communes, quelques mégaoctets. */
export const MAX_RENTS_FILE_BYTES = 8 * 1024 * 1024;
const ID = '([A-Za-z0-9_-]{1,64})';

export interface InvestirServices {
  db: SqlDatabase;
  journal: JournalStore;
  now: () => Date;
  /** L'IA qui rédige la note ; absente, le secours sans IA [R126]. */
  noteWriter?: NoteWriter;
  /** Le barème des frais d'acquisition réglé par la direction, pour les alertes ; absent, aucune alerte de rendement. */
  feesRateBp?: Sourced<number> | null;
  /** Le début du lien de désinscription des alertes ; absent, aucune alerte [R49]. */
  unsubscribeBase?: string | null;
  newId?: () => string;
}

type Role = Viewer['role'];
const WRITERS: readonly Role[] = ['agent', 'direction'];
const READERS: readonly Role[] = ['agent', 'direction', 'compliance'];

export interface InvestirRoute {
  method: 'GET' | 'POST';
  pattern: RegExp;
  /** Nom de la route pour le journal : jamais l'identifiant demandé. */
  name: string;
  /** Les rôles admis : un autre est refusé avant toute lecture du corps [R16]. */
  roles: readonly Role[];
  /** La taille permise du corps, si elle n'est pas celle d'une requête ordinaire. */
  maxBytes?: number;
  handle: (s: InvestirServices, viewer: Viewer, params: string[], request: Request) => Promise<Response>;
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
  });

type Outcome = { ok: true; value?: unknown } | { ok: false; rule: string | null; code: string; [k: string]: unknown };

/** 200 ; 403 pour un refus de droits ; 404 inconnu ; 409 pour une règle ; 400 sinon. */
function reply(result: Outcome): Response {
  if (result.ok) return json(200, { ok: true, mode: TRIAL_MODE, data: result.value ?? null });
  const { rule, code } = result;
  const extra = Object.fromEntries(Object.entries(result).filter(([k]) => !['ok', 'rule', 'code'].includes(k)));
  if (rule === 'R16') return json(code === 'unknown' ? 404 : 403, { ok: false, rule, code });
  if (/^unknown/.test(code)) return json(404, { ok: false, rule, code });
  return json(rule ? 409 : 400, { ok: false, rule, code, ...extra });
}

async function readJson(request: Request, max: number): Promise<Record<string, unknown> | null> {
  if (!(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) return null;
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (declared > max) return null;
  const text = await request.text();
  if (new TextEncoder().encode(text).length > max) return null;
  try {
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const withBody =
  (fn: (s: InvestirServices, v: Viewer, p: string[], b: Record<string, unknown>) => Promise<Response>, max = MAX_INVESTIR_BODY_BYTES) =>
  async (s: InvestirServices, v: Viewer, p: string[], r: Request): Promise<Response> => {
    const body = await readJson(r, max);
    return body ? fn(s, v, p, body) : json(400, { ok: false, rule: null, code: 'invalid_body' });
  };

/** Les objets métier, faits à chaque requête sur les mêmes services. */
export function investirCore(s: InvestirServices) {
  const opts = { now: s.now, ...(s.newId ? { newId: s.newId } : {}) };
  const store = new FicheClient(s.db, { now: s.now });
  const acces = new Acces(s.db, store, new FicheUnique(s.db, store, { now: s.now }), s.journal, { now: s.now });
  const profils = new ProfilInvestisseur(s.db, s.journal, opts);
  const loyers = new LoyersMarche(s.db, s.journal, opts);
  const calculs = new CalculInvestissement(s.db, s.journal, { ...opts, loyers });
  const contraintes = new Contraintes(s.db, s.journal, opts);
  const notes = new NotesInvestissement(s.db, s.journal, calculs, contraintes, profils, { ...opts, ...(s.noteWriter ? { writer: s.noteWriter } : {}) });
  const alertes = new AlertesInvestisseurs(s.db, s.journal, {
    now: s.now,
    feesRateBp: s.feesRateBp ?? null,
    unsubscribeBase: s.unsubscribeBase ?? null,
  });
  return { acces, profils, loyers, calculs, contraintes, notes, alertes, historique: new HistoriqueProjet(s.db, s.journal, { now: s.now }) };
}

const core = investirCore;
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

/** Les contraintes d'un bien que le lecteur voit, pour un projet de sa fiche ou sans projet [R16, R124]. */
async function constraintsRoute(s: InvestirServices, v: Viewer, propertyId: string, b: Record<string, unknown>): Promise<Outcome> {
  const c = core(s);
  const read = await c.acces.readProperty(v, propertyId);
  if (!read.ok) return { ok: false, rule: 'R16', code: read.code };
  let rentalTarget = null;
  const projectId = str(b.projectId);
  if (projectId !== null) {
    const profile = await c.profils.read(c.acces, v, projectId);
    if (!profile.ok) return profile;
    rentalTarget = profile.value.current?.profile.rentalTarget ?? null;
  }
  const kwh = b.finalEnergyKwh;
  if (kwh !== undefined && kwh !== null && (typeof kwh !== 'number' || !Number.isFinite(kwh) || kwh < 0 || kwh > 100_000)) return { ok: false, rule: 'R124', code: 'consommation' };
  const cls = str(b.energyClass);
  const set = await c.contraintes.forProperty({
    networkId: v.networkId,
    propertyId,
    inseeCode: str(b.inseeCode),
    energyClass: cls !== null && ['A', 'B', 'C', 'D', 'E', 'F', 'G'].includes(cls) ? (cls as 'A') : null,
    finalEnergyKwh: typeof kwh === 'number' ? kwh : null,
    energySource: `dit par ${v.role}:${v.userId}`,
    rentalTarget,
  });
  return { ok: true, value: set };
}

/** Les investisseurs que le lecteur suit : chaque fiche repasse par R16, et la liste va au journal. */
async function myInvestors(s: InvestirServices, v: Viewer): Promise<Outcome> {
  const c = core(s);
  const persons = await c.acces.listPersons(v);
  if (!persons.ok) return { ok: false, rule: 'R16', code: persons.code };
  // Les fiches visibles filtrent en mémoire : une liste d'identifiants liée à la requête dépasserait la limite de
  // paramètres de la base (100) dès qu'un agent suit beaucoup de fiches.
  const visible = new Set(persons.value.map((p) => p.id));
  if (visible.size === 0) return { ok: true, value: [] };
  const all = await s.db.all<{ id: string; person_id: string; created_at: string }>(
    "SELECT id, person_id, created_at FROM projects WHERE network_id = ? AND kind = 'invest' ORDER BY created_at DESC, id",
    [v.networkId],
  );
  const projects = all.filter((p) => visible.has(p.person_id)).slice(0, 100);
  const names = new Map(persons.value.map((p) => [p.id, p.first_name]));
  const out = [];
  for (const p of projects) {
    const profile = await c.profils.current(p.id);
    out.push({ projectId: p.id, firstName: names.get(p.person_id) ?? null, openedAt: p.created_at, profile: profile?.profile ?? null, version: profile?.version ?? null });
  }
  return { ok: true, value: out };
}

/** Les biens qu'on peut calculer : ceux du lecteur et ceux du fichier commun, dont la commune est rangée [R16]. */
/** Les logements de la personne dont la commune manque (X20), lus directement : jamais déduits de deux listes tronquées. */
async function propertiesWithoutCommune(s: InvestirServices, v: Viewer): Promise<Outcome> {
  type Row = { id: string; reference: string; city: string | null; postal_code: string | null };
  const rows = await s.db.all<Row>(
    `SELECT p.id, p.reference, p.city, p.postal_code FROM properties p LEFT JOIN property_communes c ON c.property_id = p.id
     WHERE p.network_id = ? ${v.role === 'agent' ? 'AND p.agent_id = ?' : ''} AND c.property_id IS NULL AND p.kind IN ('home', 'building') AND p.status NOT IN ('sold', 'rented', 'withdrawn')
     ORDER BY p.updated_at DESC, p.id LIMIT 100`,
    v.role === 'agent' ? [v.networkId, v.userId] : [v.networkId],
  );
  const c = core(s);
  const seen: Row[] = [];
  for (const r of rows) {
    const read = await c.acces.readProperty(v, r.id);
    if (read.ok && read.view === 'full') seen.push(r);
  }
  return { ok: true, value: seen.map((r) => ({ propertyId: r.id, reference: r.reference, city: r.city, postalCode: r.postal_code })) };
}

async function calculableProperties(s: InvestirServices, v: Viewer): Promise<Outcome> {
  type Row = { id: string; reference: string; city: string | null; price_eur: number | null; surface_m2: number | null; insee_code: string; rent_kind: string };
  const SELECT = 'SELECT p.id, p.reference, p.city, p.price_eur, p.surface_m2, c.insee_code, c.rent_kind FROM properties p JOIN property_communes c ON c.property_id = p.id';
  let rows: Row[];
  if (v.role === 'agent') {
    // Les biens de l'agent sont lus à part : le fichier commun, même plein, ne les pousse jamais hors de la liste.
    const own = await s.db.all<Row>(`${SELECT} WHERE p.network_id = ? AND p.agent_id = ? ORDER BY p.updated_at DESC, p.id LIMIT 200`, [v.networkId, v.userId]);
    const shared = await s.db.all<Row>(
      `${SELECT} WHERE p.network_id = ? AND (p.agent_id IS NULL OR p.agent_id <> ?) AND p.status IN ('available', 'under_offer') ORDER BY p.updated_at DESC, p.id LIMIT 100`,
      [v.networkId, v.userId],
    );
    rows = [...own, ...shared];
  } else {
    rows = await s.db.all<Row>(`${SELECT} WHERE p.network_id = ? ORDER BY p.updated_at DESC, p.id LIMIT 100`, [v.networkId]);
  }
  // Chaque bien repasse par la couche d'accès : lecteur actif, dossier d'agent valide (sinon le fichier commun seul,
  // R82), lecture ou refus écrits au journal bien par bien [R16].
  const c = core(s);
  const seen: Row[] = [];
  for (const r of rows) if ((await c.acces.readProperty(v, r.id)).ok) seen.push(r);
  return {
    ok: true,
    value: seen.map((r) => ({ propertyId: r.id, reference: r.reference, city: r.city, priceCents: r.price_eur === null ? null : r.price_eur * 100, surfaceHundredths: r.surface_m2 === null ? null : Math.round(r.surface_m2 * 100), inseeCode: r.insee_code, rentKind: r.rent_kind })),
  };
}

const ROUTES: InvestirRoute[] = [
  /* Les investisseurs suivis et les biens calculables, pour l'écran « Investir » (Y09) [R16]. */
  { method: 'GET', pattern: /^\/investir\/projets$/, name: 'investir.projets', roles: WRITERS, handle: async (s, v) => reply(await myInvestors(s, v)) },
  { method: 'GET', pattern: /^\/investir\/biens$/, name: 'investir.biens', roles: WRITERS, handle: async (s, v) => reply(await calculableProperties(s, v)) },
  { method: 'GET', pattern: /^\/investir\/biens\/sans-commune$/, name: 'investir.biens.sans_commune', roles: WRITERS, handle: async (s, v) => reply(await propertiesWithoutCommune(s, v)) },
  /* Les calculs et les notes rangés d'un projet, pour les retrouver à l'écran (Y14) [R16]. */
  { method: 'GET', pattern: new RegExp(`^/investir/projets/${ID}/historique$`), name: 'investir.historique', roles: WRITERS, handle: async (s, v, [id]) => { const c = core(s); return reply(await c.historique.of(c.acces, v, id!)); } },
  /* Le profil de l'investisseur (Y01) [R123, R17]. */
  { method: 'GET', pattern: new RegExp(`^/investir/projets/${ID}/profil$`), name: 'investir.profil.lu', roles: READERS, handle: async (s, v, [id]) => { const c = core(s); return reply(await c.profils.read(c.acces, v, id!)); } },
  {
    method: 'POST',
    pattern: new RegExp(`^/investir/projets/${ID}/profil$`),
    name: 'investir.profil',
    roles: WRITERS,
    handle: withBody(async (s, v, [id], b) => {
      const c = core(s);
      return reply(await c.profils.update(c.acces, v, id!, b.changes, b.from ?? 'agent'));
    }),
  },

  /* Les loyers de marché (Y02) [R122] : import par la direction, lecture par commune. */
  {
    method: 'POST',
    pattern: /^\/investir\/loyers$/,
    name: 'investir.loyers.import',
    roles: ['direction'],
    maxBytes: MAX_RENTS_FILE_BYTES,
    handle: withBody(async (s, v, _p, b) => {
      const r = await core(s).loyers.importAnil(v, { kind: b.kind, vintage: b.vintage, csv: b.csv });
      // Un gros fichier se range en plusieurs appels : `en_cours` dit de rappeler avec le même fichier.
      return reply(r.ok ? { ok: true, value: { importId: r.importId, rows: r.rows, stored: r.stored, status: r.status, created: r.created } } : r);
    }, MAX_RENTS_FILE_BYTES),
  },
  {
    method: 'GET',
    pattern: /^\/investir\/loyers$/,
    name: 'investir.loyers.lu',
    roles: READERS,
    handle: async (s, v, _p, r) => {
      const q = new URL(r.url).searchParams;
      const kind = q.get('type') ?? 'apartment';
      if (!(MARKET_RENT_KINDS as readonly string[]).includes(kind)) return reply({ ok: false, rule: 'R122', code: 'type' });
      return reply({ ok: true, value: await core(s).loyers.marketRent(v.networkId, q.get('insee') ?? '', kind as MarketRentKind) });
    },
  },

  /* Les règles des communes et la commune d'un bien (Y04, Y06). */
  {
    method: 'GET',
    pattern: /^\/investir\/regles$/,
    name: 'investir.regles.lues',
    roles: READERS,
    handle: async (s, v, _p, r) => reply(await core(s).contraintes.communeRulesScreen(v, new URL(r.url).searchParams.get('insee'))),
  },
  {
    method: 'POST',
    pattern: /^\/investir\/regles$/,
    name: 'investir.regle',
    roles: ['direction'],
    handle: withBody(async (s, v, _p, b) =>
      reply(await core(s).contraintes.recordCommuneRule(v, { inseeCode: b.inseeCode, rule: b.rule, effectiveFrom: b.effectiveFrom, effectiveUntil: b.effectiveUntil, source: b.source, sourceDate: b.sourceDate })),
    ),
  },
  {
    method: 'POST',
    pattern: new RegExp(`^/investir/biens/${ID}/commune$`),
    name: 'investir.bien.commune',
    roles: WRITERS,
    handle: withBody(async (s, v, [id], b) => {
      const c = core(s);
      return reply(await c.alertes.recordPropertyCommune(c.acces, v, id!, { inseeCode: b.inseeCode, rentKind: b.rentKind }));
    }),
  },
  { method: 'POST', pattern: new RegExp(`^/investir/biens/${ID}/contraintes$`), name: 'investir.contraintes', roles: READERS, handle: withBody(async (s, v, [id], b) => reply(await constraintsRoute(s, v, id!, b))) },

  /* Le calcul (Y03) [R120, R121]. */
  {
    method: 'POST',
    pattern: /^\/investir\/calculs$/,
    name: 'investir.calcul',
    roles: WRITERS,
    handle: withBody(async (s, v, _p, b) => {
      const c = core(s);
      return reply(await c.calculs.compute(c.acces, v, { propertyId: b.propertyId, projectId: b.projectId, inputs: b.inputs ?? {}, marketRentQuery: b.marketRentQuery }));
    }),
  },
  { method: 'GET', pattern: new RegExp(`^/investir/calculs/${ID}$`), name: 'investir.calcul.lu', roles: READERS, handle: async (s, v, [id]) => { const c = core(s); return reply(await c.calculs.read(c.acces, v, id!)); } },

  /* La note (Y05) [R122, R124, R125, R126]. */
  {
    method: 'POST',
    pattern: /^\/investir\/notes$/,
    name: 'investir.note',
    roles: WRITERS,
    handle: withBody(async (s, v, _p, b) => {
      const c = core(s);
      const calculationId = str(b.calculationId);
      const projectId = str(b.projectId);
      if (!calculationId || !projectId) return reply({ ok: false, rule: null, code: 'invalid_body' });
      const h = b.hypotheses;
      const hypotheses = h && typeof h === 'object' && !Array.isArray(h) ? (h as NoteHypotheses) : undefined;
      const energy = b.energy && typeof b.energy === 'object' && !Array.isArray(b.energy) ? (b.energy as { energyClass?: unknown; finalEnergyKwh?: unknown }) : undefined;
      return reply(
        await c.notes.draft(c.acces, v, { calculationId, projectId, ...(hypotheses ? { hypotheses } : {}), inseeCode: str(b.inseeCode), ...(energy ? { energy } : {}) }),
      );
    }),
  },
  { method: 'GET', pattern: new RegExp(`^/investir/notes/${ID}$`), name: 'investir.note.lue', roles: WRITERS, handle: async (s, v, [id]) => { const c = core(s); return reply(await c.notes.read(c.acces, v, id!)); } },
  {
    method: 'POST',
    pattern: new RegExp(`^/investir/notes/${ID}/validation$`),
    name: 'investir.note.validation',
    // L'agent de la fiche, et lui seul, valide [R126].
    roles: ['agent'],
    handle: withBody(async (s, v, [id], b) => {
      const c = core(s);
      const sha = str(b.textSha256);
      if (!sha) return reply({ ok: false, rule: null, code: 'invalid_body' });
      const energy = b.energy && typeof b.energy === 'object' && !Array.isArray(b.energy) ? (b.energy as { energyClass?: unknown; finalEnergyKwh?: unknown }) : undefined;
      return reply(await c.notes.validate(c.acces, v, id!, { textSha256: sha, inseeCode: str(b.inseeCode), ...(energy ? { energy } : {}) }));
    }),
  },

  /* Les alertes aux investisseurs (Y06), en mode essai : un passage pour un bien, lancé par la direction [R26]. */
  {
    method: 'POST',
    pattern: new RegExp(`^/investir/biens/${ID}/alertes$`),
    name: 'investir.alertes',
    roles: ['direction'],
    handle: async (s, v, [id]) => reply({ ok: true, value: await core(s).alertes.forProperty(v.networkId, id!) }),
  },
];

/**
 * Les routes de M17, prêtes pour le routeur du socle (Y08) : chacune contrôle le rôle avant tout, écrit le refus au
 * journal, puis passe la main à la couche métier [R16].
 */
export function investirRoutes(): InvestirRoute[] {
  return ROUTES.map((route) => ({
    ...route,
    handle: async (s, viewer, params, request) => {
      if (!route.roles.includes(viewer.role)) {
        await appendEvent(
          s.journal,
          { type: 'acces.refuse', actor: `${String(viewer.role)}:${viewer.userId}`, subject: `network:${viewer.networkId}`, data: { rule: 'R16', role: String(viewer.role), kind: route.name, code: 'role' } },
          s.now,
        );
        return reply({ ok: false, rule: 'R16', code: 'role' });
      }
      return route.handle(s, viewer, params, request);
    },
  }));
}
