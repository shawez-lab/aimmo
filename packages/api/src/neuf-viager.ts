/**
 * Les routes des programmes neufs et du viager (HX48, BR75), sous `/v1/neuf` et `/v1/viager`.
 *
 * Chaque route dit les rôles qu'elle admet ; un autre rôle est refusé et écrit au journal avant que le corps de la
 * requête soit lu [R16]. Les droits fins (agent du programme, fiche suivie, bien vu en entier, agent parti) restent
 * ceux de la couche métier, qui écrit aussi ses refus au journal. Aucun chiffre n'est calculé ailleurs que dans le code
 * de la couche métier : frais du neuf et de l'ancien [R544], bouquet et rente [R540]. Un lot vendu ne revient jamais
 * [R543] ; la table d'espérance de vie n'a pas de colonne de sexe [R541] ; le bouquet ne dépasse jamais la valeur
 * occupée et l'expert du viager passe par la mise en relation de M18 [R542]. Rien n'est envoyé d'ici.
 */
import { Acces, FicheClient, FicheUnique, agentState, appendEvent, type JournalStore, type SqlDatabase, type Viewer } from '@aimmo/core';
import { ProgrammesNeufs, Viager, type ExpertViagerRelation } from '../../core/src/neuf-viager/index.ts';

export const TRIAL_MODE = 'essai';
/** Le corps d'une requête ordinaire ; une table d'espérance de vie (121 lignes au plus) y tient largement. */
export const MAX_NEUF_VIAGER_BODY_BYTES = 16 * 1024;
const ID = '([A-Za-z0-9_-]{1,64})';

export interface NeufViagerServices {
  db: SqlDatabase;
  journal: JournalStore;
  now: () => Date;
  /** La mise en relation de M18, avec le stockage des fichiers des partenaires ; absente, aucun expert proposé [R542]. */
  relation?: ExpertViagerRelation | null;
  newId?: () => string;
}

type Role = Viewer['role'];
const WRITERS: readonly Role[] = ['agent', 'direction'];
const DIRECTION: readonly Role[] = ['direction'];

export interface NeufViagerRoute {
  method: 'GET' | 'POST';
  pattern: RegExp;
  /** Nom de la route pour le journal : jamais l'identifiant demandé. */
  name: string;
  /** Les rôles admis : un autre est refusé avant toute lecture du corps [R16]. */
  roles: readonly Role[];
  handle: (s: NeufViagerServices, viewer: Viewer, params: string[], request: Request) => Promise<Response>;
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
  });

type Outcome = { ok: true; value?: unknown } | { ok: false; rule: string | null; code: string; field?: string };

/** 200 ; 403 pour un refus de droits ; 404 inconnu ; 409 pour une règle ; 400 sinon. */
function reply(result: Outcome): Response {
  if (result.ok) return json(200, { ok: true, mode: TRIAL_MODE, data: result.value ?? null });
  const { rule, code } = result;
  const extra = result.field ? { field: result.field } : {};
  if (code === 'unknown') return json(404, { ok: false, rule, code });
  if (rule === 'R16') return json(403, { ok: false, rule, code });
  return json(rule ? 409 : 400, { ok: false, rule, code, ...extra });
}

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  if (!(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) return null;
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > MAX_NEUF_VIAGER_BODY_BYTES) return null;
  const text = await request.text();
  if (new TextEncoder().encode(text).length > MAX_NEUF_VIAGER_BODY_BYTES) return null;
  try {
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const withBody =
  (fn: (s: NeufViagerServices, v: Viewer, p: string[], b: Record<string, unknown>) => Promise<Response>) =>
  async (s: NeufViagerServices, v: Viewer, p: string[], r: Request): Promise<Response> => {
    const body = await readJson(r);
    return body ? fn(s, v, p, body) : json(400, { ok: false, rule: null, code: 'invalid_body' });
  };

/** Les objets métier, faits à chaque requête sur les mêmes services. */
export function neufViagerCore(s: NeufViagerServices) {
  const opts = { now: s.now, ...(s.newId ? { newId: s.newId } : {}) };
  const store = new FicheClient(s.db, { now: s.now });
  const acces = new Acces(s.db, store, new FicheUnique(s.db, store, { now: s.now }), s.journal, { now: s.now });
  return {
    acces,
    neuf: new ProgrammesNeufs(s.db, s.journal, opts),
    viager: new Viager(s.db, s.journal, { ...opts, ...(s.relation ? { relation: s.relation } : {}) }),
  };
}

const core = neufViagerCore;

async function refuse(s: NeufViagerServices, v: Viewer, kind: string, code: string): Promise<Outcome> {
  await appendEvent(
    s.journal,
    { type: 'acces.refuse', actor: `${String(v.role)}:${v.userId}`, subject: `network:${v.networkId}`, data: { rule: 'R16', role: String(v.role), kind, code } },
    s.now,
  );
  return { ok: false, rule: 'R16', code };
}

/**
 * Les programmes que le lecteur tient : tous pour la direction, les siens pour un agent en activité. Un agent parti ou
 * sorti ne voit plus rien, dès le jour de son départ [R86, R16].
 */
async function programs(s: NeufViagerServices, v: Viewer): Promise<Outcome> {
  if (v.role === 'agent') {
    const agent = await s.db.first<{ status: string }>('SELECT status FROM agents WHERE id = ? AND network_id = ?', [v.userId, v.networkId]);
    if (!agent || agent.status !== 'active' || (await agentState(s.db, v.networkId, v.userId, s.now())) === 'parti') return refuse(s, v, 'neuf.programmes', 'agent_left');
  }
  const rows = await s.db.all<{ id: string; name: string; city: string; postal_code: string; promoter: string; agent_id: string; created_at: string }>(
    `SELECT g.id, g.name, g.city, g.postal_code, p.business_name AS promoter, g.agent_id, g.created_at
     FROM new_programs g JOIN partners p ON p.id = g.promoter_partner_id AND p.network_id = g.network_id
     WHERE g.network_id = ? ${v.role === 'agent' ? 'AND g.agent_id = ?' : ''}
     ORDER BY g.created_at DESC, g.id LIMIT 200`,
    v.role === 'agent' ? [v.networkId, v.userId] : [v.networkId],
  );
  return {
    ok: true,
    value: rows.map((r) => ({
      programId: r.id,
      name: r.name,
      city: r.city,
      postalCode: r.postal_code,
      promoter: r.promoter,
      // L'agent du programme ne se lit que par la direction, qui le confie.
      ...(v.role === 'direction' ? { agentId: r.agent_id } : {}),
      createdAt: r.created_at,
    })),
  };
}

/** Le rejeu d'un calcul, lu seulement par qui peut relire ce calcul [R540, R16]. */
async function replay(s: NeufViagerServices, v: Viewer, id: string): Promise<Outcome> {
  const c = core(s);
  const read = await c.viager.read(c.acces, v, id);
  if (!read.ok) return read;
  const r = await c.viager.replay(v.networkId, read.value.id);
  if (!r) return { ok: false, rule: 'R16', code: 'unknown' };
  return { ok: true, value: { same: r.same, result: r.result } };
}

const ROUTES: NeufViagerRoute[] = [
  /* Les programmes neufs (HX48) [R543, R544]. */
  {
    method: 'POST',
    pattern: /^\/neuf\/baremes$/,
    name: 'neuf.bareme',
    roles: DIRECTION,
    handle: withBody(async (s, v, _p, b) => reply(await core(s).neuf.setFeeScale(v, { kind: b.kind, rateBp: b.rateBp, source: b.source, validFrom: b.validFrom }))),
  },
  /* BR79 : les barèmes rangés, celui qui fait foi ce jour, ceux à venir et ceux remplacés, pour la direction seule. */
  { method: 'GET', pattern: /^\/neuf\/baremes$/, name: 'neuf.baremes', roles: DIRECTION, handle: async (s, v) => reply(await core(s).neuf.listFeeScales(v)) },
  { method: 'GET', pattern: /^\/neuf\/programmes$/, name: 'neuf.programmes', roles: WRITERS, handle: async (s, v) => reply(await programs(s, v)) },
  {
    method: 'POST',
    pattern: /^\/neuf\/programmes$/,
    name: 'neuf.programme',
    roles: DIRECTION,
    handle: withBody(async (s, v, _p, b) =>
      reply(await core(s).neuf.createProgram(v, { promoterPartnerId: b.promoterPartnerId, agentId: b.agentId, name: b.name, city: b.city, postalCode: b.postalCode })),
    ),
  },
  { method: 'GET', pattern: new RegExp(`^/neuf/programmes/${ID}$`), name: 'neuf.grille', roles: WRITERS, handle: async (s, v, [id]) => reply(await core(s).neuf.agentGrid(v, id!)) },
  {
    method: 'POST',
    pattern: new RegExp(`^/neuf/programmes/${ID}/lots$`),
    name: 'neuf.lot',
    roles: WRITERS,
    handle: withBody(async (s, v, [id], b) =>
      reply(
        await core(s).neuf.recordLot(v, id!, {
          lotRef: b.lotRef,
          typology: b.typology,
          livingAreaHundredths: b.livingAreaHundredths,
          floor: b.floor,
          priceCents: b.priceCents,
          status: b.status,
          confirmedOn: b.confirmedOn,
        }),
      ),
    ),
  },

  /* Le viager (HX48) [R540, R541, R542]. */
  {
    method: 'POST',
    pattern: /^\/viager\/tables$/,
    name: 'viager.table',
    roles: DIRECTION,
    handle: withBody(async (s, v, _p, b) => reply(await core(s).viager.importLifeTable(v, { vintage: b.vintage, source: b.source, rows: b.rows }))),
  },
  /* BR80 : les tables importées, sans leurs lignes, et celle qui sert aux calculs ce jour, pour la direction seule. */
  { method: 'GET', pattern: /^\/viager\/tables$/, name: 'viager.tables', roles: DIRECTION, handle: async (s, v) => reply(await core(s).viager.listLifeTables(v)) },
  {
    method: 'POST',
    pattern: /^\/viager\/calculs$/,
    name: 'viager.calcul',
    roles: WRITERS,
    handle: withBody(async (s, v, _p, b) => {
      const c = core(s);
      return reply(await c.viager.compute(c.acces, v, { propertyId: b.propertyId ?? null, projectId: b.projectId ?? null, inputs: b.inputs }));
    }),
  },
  {
    method: 'GET',
    pattern: new RegExp(`^/viager/calculs/${ID}$`),
    name: 'viager.calcul.lu',
    roles: WRITERS,
    handle: async (s, v, [id]) => {
      const c = core(s);
      return reply(await c.viager.read(c.acces, v, id!));
    },
  },
  /*
   * BR84 : les calculs rangés d'un bien, du plus récent au plus ancien, 50 au plus, chacun dit s'il se rejoue à
   * l'identique et si sa table d'espérance a été remplacée ; sous les droits de la relecture d'un calcul [R540, R541, R16].
   */
  {
    method: 'GET',
    pattern: new RegExp(`^/viager/biens/${ID}/calculs$`),
    name: 'viager.bien.calculs',
    roles: WRITERS,
    handle: async (s, v, [id]) => {
      const c = core(s);
      return reply(await c.viager.listForProperty(c.acces, v, id!));
    },
  },
  { method: 'GET', pattern: new RegExp(`^/viager/calculs/${ID}/rejeu$`), name: 'viager.calcul.rejeu', roles: WRITERS, handle: async (s, v, [id]) => reply(await replay(s, v, id!)) },
  {
    method: 'POST',
    pattern: new RegExp(`^/viager/calculs/${ID}/expert$`),
    name: 'viager.expert',
    roles: WRITERS,
    handle: withBody(async (s, v, [id], b) => {
      const c = core(s);
      return reply(await c.viager.proposeExpert(c.acces, v, id!, b.postcode));
    }),
  },
];

/**
 * Les routes du neuf et du viager, prêtes pour le routeur de `app.ts` : chacune contrôle le rôle avant tout, écrit le
 * refus au journal, puis passe la main à la couche métier [R16].
 */
export function neufViagerRoutes(): NeufViagerRoute[] {
  return ROUTES.map((route) => ({
    ...route,
    handle: async (s, viewer, params, request) => {
      if (!route.roles.includes(viewer.role)) {
        await refuse(s, viewer, route.name, 'role');
        return reply({ ok: false, rule: 'R16', code: 'role' });
      }
      return route.handle(s, viewer, params, request);
    },
  }));
}
