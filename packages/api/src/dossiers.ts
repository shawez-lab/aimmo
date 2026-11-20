/**
 * Les routes de M10 Compromis et acte (N08), sous `/v1/dossiers`, et les passages des dossiers pour le planificateur.
 *
 * Comme `offres.ts` à sa création, ce fichier ne touche pas aux fichiers du socle : il expose `dossierRoutes()`, de la
 * même forme que les routes de `app.ts`, `syncDossiers` et les tâches planifiées, branchés dans le socle par N09.
 *
 * Chaque route passe par les droits de la couche métier [R16], qui écrit chaque refus au journal. Rien n'est envoyé
 * réellement : relances et rappels passent par le contrôle central, en mode essai [R26]. Aucune route ne reçoit ni
 * ne suit de fonds [R62].
 */
import { journalError } from './app.ts';
import { readCapped } from './studio.ts';
import { Acces, FicheClient, FicheUnique, dossiers as m10, localTime, type JournalStore, type ScheduledJob, type SqlDatabase, type Viewer } from '@aimmo/core';

const { ActeVente, ArretDossier, BouclierFonds, CheminCritique, ConditionsDossier, DepotsDossier, Echeancier, FinancementDossier, ObligationsLocales, PiecesDossier, RelancesPieces } = m10;
export type PieceStore = m10.PieceStore;

export const TRIAL_MODE = 'essai';
const MAX_BODY_BYTES = 16_000;
const ID = '([A-Za-z0-9_-]{1,64})';
/** Le filet du bouclier relit les messages reçus de ces dernières heures. */
export const SHIELD_LOOKBACK_HOURS = 48;

export interface DossierServices {
  db: SqlDatabase;
  journal: JournalStore;
  acces: Acces;
  now: () => Date;
  /** Le stockage des pièces (R2) : il dit seulement si une référence existe. */
  pieces: PieceStore;
}

export interface DossierRoute {
  method: 'GET' | 'POST';
  pattern: RegExp;
  /** Nom de la route pour le journal : jamais l'identifiant demandé. */
  name: string;
  handle: (s: DossierServices, viewer: Viewer, params: string[], request: Request) => Promise<Response>;
}

/** Le stockage R2 des pièces : seule l'existence d'une référence est lue, jamais son contenu. */
export interface R2Like {
  head(key: string): Promise<unknown | null>;
  /** Les pièces de M15 déposées depuis le téléphone (W14) ; les pièces de M10 ne font que `head`. */
  put?(key: string, value: Uint8Array, options?: { httpMetadata?: { contentType?: string } }): Promise<unknown>;
}

export class R2PieceStore implements PieceStore {
  constructor(private readonly bucket: R2Like) {}
  async has(ref: string): Promise<boolean> {
    return (await this.bucket.head(ref)) !== null;
  }
  /** Range les octets reçus tels quels ; une panne remonte à la couche métier, qui ne rend aucune référence. */
  async upload(key: string, bytes: Uint8Array, contentType: string): Promise<void> {
    if (!this.bucket.put) throw new Error('stockage sans écriture');
    await this.bucket.put(key, bytes, { httpMetadata: { contentType } });
  }
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
  });

type Outcome = { ok: true; value?: unknown; [k: string]: unknown } | { ok: false; rule: string | null; code: string; [k: string]: unknown };

/** 200 ; 403 pour un refus de droits ; 404 inconnu ; 409 pour une règle ; 400 sinon. */
function reply(result: Outcome): Response {
  if (result.ok) {
    const { ok: _ok, value, ...rest } = result;
    return json(200, { ok: true, mode: TRIAL_MODE, data: value ?? null, ...rest });
  }
  const { ok: _ok, ...rest } = result;
  if (result.rule === 'R16') return json(403, { ok: false, ...rest });
  if (/^unknown/.test(result.code)) return json(404, { ok: false, ...rest });
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

const badBody = (): Response => json(400, { ok: false, code: 'invalid_body', message: 'Corps JSON attendu.' });

const services = (s: DossierServices) => ({
  pieces: new PiecesDossier(s.db, s.acces, s.journal, s.pieces, { now: s.now }),
  echeancier: new Echeancier(s.db, s.acces, s.journal, { now: s.now, proofs: s.pieces }),
  financement: new FinancementDossier(s.db, s.acces, s.journal, { now: s.now }),
  conditions: new ConditionsDossier(s.db, s.acces, s.journal, { now: s.now, proofs: s.pieces }),
  acte: new ActeVente(s.db, s.acces, s.journal, s.pieces, { now: s.now, proofs: s.pieces }),
  arret: new ArretDossier(s.db, s.acces, s.journal, s.pieces, { now: s.now }),
  chemin: new CheminCritique(s.db, s.acces, s.journal, s.pieces, { now: s.now }),
  relances: new RelancesPieces(s.db, s.acces, s.journal, s.pieces, { now: s.now }),
  bouclier: new BouclierFonds(s.db, s.acces, s.journal, { now: s.now }),
  obligations: new ObligationsLocales(s.db, s.acces, s.journal, { now: s.now }),
});

const depositAs = (kind: m10.FileDepositKind): DossierRoute['handle'] => async (s, v, [id], r) => {
  const upload = s.pieces.upload?.bind(s.pieces);
  if (!upload) return json(503, { ok: false, rule: null, code: 'depot_ferme' });
  const length = r.headers.get('content-length');
  const declaredSize = length === null || length.trim() === '' ? null : /^\d{1,12}$/.test(length.trim()) ? Number(length.trim()) : Number.NaN;
  const result = await new DepotsDossier(s.db, s.acces, { put: (key, bytes, type) => upload(key, bytes, type) }, s.journal, { now: s.now }).deposit(v, id!, {
    kind,
    contentType: r.headers.get('content-type'),
    sha256: r.headers.get('x-aimmo-sha256'),
    declaredSize,
    read: (max) => readCapped(r, max),
  });
  const status = result.ok ? null : ({ trop_lourd: 413, type_refuse: 415, stockage_indisponible: 503 } as Record<string, number>)[result.code];
  if (status && !result.ok) return json(status, { ok: false, rule: result.rule, code: result.code });
  return reply(result as Outcome);
};

/** Les routes de M10, à ajouter à celles de `app.ts`. */
export function dossierRoutes(): DossierRoute[] {
  const withBody = (fn: (s: DossierServices, v: Viewer, params: string[], body: Record<string, unknown>) => Promise<Response>): DossierRoute['handle'] => async (s, v, params, request) => {
    const body = await readJson(request);
    return body ? fn(s, v, params, body) : badBody();
  };
  return [
    { method: 'GET', pattern: new RegExp(`^/dossiers/${ID}/pieces$`), name: 'dossiers.pieces', handle: async (s, v, [id]) => reply(await services(s).pieces.status(v, id!)) },
    {
      method: 'POST',
      pattern: new RegExp(`^/dossiers/${ID}/pieces$`),
      name: 'dossiers.piece',
      handle: withBody(async (s, v, [id], b) => reply(await services(s).pieces.add(v, id!, { piece: String(b.piece ?? ''), ref: String(b.ref ?? ''), issuedOn: String(b.issuedOn ?? '') }))),
    },
    // Le dépôt d'une pièce (N12) et de la preuve d'une date ou de l'acte (N13) : le corps est le fichier ; déposer ne joint rien [R16].
    { method: 'POST', pattern: new RegExp(`^/dossiers/${ID}/fichiers$`), name: 'dossiers.depot', handle: depositAs('piece') },
    { method: 'POST', pattern: new RegExp(`^/dossiers/${ID}/preuves$`), name: 'dossiers.preuve', handle: depositAs('preuve') },
    { method: 'GET', pattern: new RegExp(`^/dossiers/${ID}/echeancier$`), name: 'dossiers.echeancier', handle: async (s, v, [id]) => reply(await services(s).echeancier.schedule(v, id!)) },
    { method: 'POST', pattern: new RegExp(`^/dossiers/${ID}/dates$`), name: 'dossiers.date', handle: withBody(async (s, v, [id], b) => reply(await services(s).echeancier.record(v, id!, { kind: b.kind, day: b.day, proofRef: b.proofRef, personId: b.personId }))) },
    // Les conditions suspensives autres que le prêt, chacune son responsable, sa date, son état, sa preuve (AU082).
    { method: 'GET', pattern: new RegExp(`^/dossiers/${ID}/conditions$`), name: 'dossiers.conditions', handle: async (s, v, [id]) => reply(await services(s).conditions.conditions(v, id!)) },
    {
      method: 'POST',
      pattern: new RegExp(`^/dossiers/${ID}/conditions$`),
      name: 'dossiers.condition',
      handle: withBody(async (s, v, [id], b) => reply(await services(s).conditions.record(v, id!, { kind: b.kind, responsible: b.responsible, day: b.day, state: b.state, proofRef: b.proofRef }))),
    },
    { method: 'GET', pattern: new RegExp(`^/dossiers/${ID}/financement$`), name: 'dossiers.financement', handle: async (s, v, [id]) => reply(await services(s).financement.financing(v, id!)) },
    { method: 'POST', pattern: new RegExp(`^/dossiers/${ID}/financement$`), name: 'dossiers.financement.etape', handle: withBody(async (s, v, [id], b) => reply(await services(s).financement.declare(v, id!, b))) },
    { method: 'GET', pattern: new RegExp(`^/dossiers/${ID}/arret$`), name: 'dossiers.arret', handle: async (s, v, [id]) => reply(await services(s).arret.of(v, id!)) },
    { method: 'POST', pattern: new RegExp(`^/dossiers/${ID}/arret$`), name: 'dossiers.arret.note', handle: withBody(async (s, v, [id], b) => reply(await services(s).arret.stop(v, id!, { reason: b.reason, proofRef: b.proofRef }))) },
    { method: 'GET', pattern: new RegExp(`^/dossiers/${ID}/acte$`), name: 'dossiers.acte', handle: async (s, v, [id]) => reply(await services(s).acte.closing(v, id!)) },
    { method: 'POST', pattern: new RegExp(`^/dossiers/${ID}/acte$`), name: 'dossiers.acte.signe', handle: withBody(async (s, v, [id], b) => reply(await services(s).acte.record(v, id!, { signedOn: b.signedOn, proofRef: b.proofRef }))) },
    { method: 'GET', pattern: new RegExp(`^/dossiers/${ID}/chemin$`), name: 'dossiers.chemin', handle: async (s, v, [id]) => reply(await services(s).chemin.of(v, id!)) },
    { method: 'GET', pattern: new RegExp(`^/dossiers/${ID}/relances$`), name: 'dossiers.relances', handle: async (s, v, [id]) => reply(await services(s).relances.ofFile(v, id!)) },
    // AU011 : la direction range la lecture d'un arrêté local pour une commune ; l'agent du bien ou la direction déclare le
    // raccordement du bien du dossier aux eaux usées. Les droits sont ceux de la couche métier, refus au journal [R16].
    {
      method: 'POST',
      pattern: /^\/dossiers\/obligations-locales$/,
      name: 'dossiers.obligations_locales',
      handle: withBody(async (s, v, _p, b) => reply(await services(s).obligations.recordZone(v, { postalCode: b.postalCode, city: b.city, hazard: b.hazard, inZone: b.inZone, title: b.title, url: b.url, datedOn: b.datedOn, readOn: b.readOn }))),
    },
    {
      method: 'POST',
      pattern: new RegExp(`^/dossiers/${ID}/assainissement$`),
      name: 'dossiers.assainissement',
      handle: withBody(async (s, v, [id], b) => {
        const file = await s.db.first<{ property_id: string }>('SELECT property_id FROM sale_files WHERE id = ? AND network_id = ?', [id!, v.networkId]);
        if (!file) return reply({ ok: false, rule: null, code: 'unknown_file' });
        return reply(await services(s).obligations.recordSanitation(v, file.property_id, b.mode));
      }),
    },
    { method: 'GET', pattern: /^\/dossiers\/taches$/, name: 'dossiers.taches', handle: async (s, v) => reply((await services(s).echeancier.tasksOf(v)) as Outcome) },
    {
      method: 'GET',
      pattern: /^\/dossiers\/alertes$/,
      name: 'dossiers.alertes',
      // Les alertes de l'agent : financement, bouclier contre le faux RIB, conditions suspensives (AU082), pour lui seul [R16].
      handle: async (s, v) => {
        const sv = services(s);
        const financing = await sv.financement.alertsOf(v);
        if (!financing.ok) return reply(financing);
        const funds = await sv.bouclier.alertsOf(v);
        if (!funds.ok) return reply(funds);
        const conditions = await sv.conditions.tasksOf(v);
        if (!conditions.ok) return reply(conditions);
        return reply({ ok: true, value: { financement: financing.alerts, fonds: funds.alerts, conditions: conditions.tasks } });
      },
    },
  ];
}

/**
 * Le passage d'un réseau : échéances, alertes de financement, filet du bouclier, relances des pièces. Chaque partie
 * est indépendante : la panne de l'une n'empêche pas les autres ; la première panne est relancée à la fin. Rejoué, il
 * n'ajoute rien.
 */
export async function syncDossiers(s: DossierServices, networkId: string): Promise<{ deadlines: number; financing: number; funds: number; reminders: number; conditions: number }> {
  const sv = services(s);
  let failure: unknown = null;
  // Chaque panne est écrite au journal sous le nom de son étape, sans donnée [R13] ; la première est relancée à la fin.
  const step = async (name: string, fn: () => Promise<number>): Promise<number> => {
    try {
      return await fn();
    } catch (error) {
      await journalError(s.journal, 'system:planificateur', `${DOSSIERS_JOB}.${name}`, error, s.now);
      failure ??= error;
      return 0;
    }
  };
  const deadlines = await step('echeances', () => sv.echeancier.run(networkId));
  const financing = await step('financement', () => sv.financement.run(networkId));
  const conditions = await step('conditions', () => sv.conditions.run(networkId));
  const funds = await step('bouclier', () => sv.bouclier.run(networkId, new Date(s.now().getTime() - SHIELD_LOOKBACK_HOURS * 3_600_000)));
  // Le dimanche, aucune relance ne part [R01] : le passage ne les prépare pas, pour ne laisser aucune attente vaine.
  const reminders = localTime(s.now(), 'Europe/Paris').weekday === 7 ? 0 : await step('relances', () => sv.relances.run(networkId));
  if (failure !== null) throw failure;
  return { deadlines, financing, funds, reminders, conditions };
}

export const DOSSIERS_JOB = 'dossiers.passage';

/**
 * Le passage des dossiers au planificateur (N09) : chaque réseau, d'heure en heure de 9 h à 19 h, heure de Paris,
 * tous les jours, pour qu'une échéance du lundi soit annoncée dès la veille ; une fois par créneau (réservé par le
 * planificateur). Échéances et alertes sont idempotentes ; les relances ne sont pas préparées le dimanche, et tout
 * envoi respecte les heures d'envoi par le contrôle central [R01].
 */
export function dossiersJob(db: SqlDatabase, journal: JournalStore, pieces: PieceStore, options: { now?: () => Date } = {}): ScheduledJob {
  const now = options.now ?? (() => new Date());
  return {
    name: DOSSIERS_JOB,
    hours: [9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19],
    run: async () => {
      const store = new FicheClient(db, { now });
      const s: DossierServices = { db, journal, acces: new Acces(db, store, new FicheUnique(db, store, { now }), journal, { now }), now, pieces };
      const networks = await db.all<{ id: string }>('SELECT id FROM networks ORDER BY id');
      // Chaque réseau passe, même si un autre tombe en panne ; chaque panne va au journal, sans donnée [R13].
      let failed = 0;
      for (const n of networks) {
        try {
          await syncDossiers(s, n.id);
        } catch (error) {
          failed += 1;
          await journalError(journal, 'system:planificateur', DOSSIERS_JOB, error, now);
        }
      }
      if (failed > 0) throw new Error('dossiers_en_panne');
    },
  };
}
