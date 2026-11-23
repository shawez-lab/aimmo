/**
 * Les routes de M13 Pilotage et finances (K08), sous `/v1/pilotage`, et ses passages au planificateur.
 *
 * Chaque route passe par les droits de la couche métier [R16], qui écrit chaque refus au journal : un agent ne lit que
 * ses chiffres, ses commissions et ses reversements [R68] ; la direction lit le réseau ; la conformité n'a pas les
 * chiffres. Aucune route ne reçoit un montant [R63, R67] : les commissions et les factures sont calculées par le code.
 * Aucune facture réelle : la plateforme est celle du mode essai tant que H26 n'est pas fait [R26].
 *
 * Les passages : chaque heure, commissions, factures et reversements (`pilotage.passage`) ; à 6 h, les alertes de
 * pilotage, avec les échéances des pièces du dossier d'agent (M14) ; du lundi au vendredi à 7 h 30, le rapport du matin.
 */
import { copyWatchJob, restoreWatchJob, pilotage, RecusParcours, RecusRestauration, SuiviCopies, type JournalStore, type ScheduledJob, type SqlDatabase, type Viewer, type Acces } from '@aimmo/core';

export const TRIAL_MODE = 'essai';
const MAX_BODY_BYTES = 8_000;
const ID = '([A-Za-z0-9_-]{1,64})';
const DAY = /^\d{4}-\d{2}-\d{2}$/;

export interface PilotageServices {
  db: SqlDatabase;
  journal: JournalStore;
  acces: Acces;
  now: () => Date;
  /** La supervision de la disponibilité (IN09) ; absente tant qu'aucune n'est branchée (H48) : « non mesuré ». */
  supervision?: pilotage.SupervisionProvider | null;
}

export interface PilotageRoute {
  method: 'GET' | 'POST';
  pattern: RegExp;
  /** Nom de la route pour le journal : jamais l'identifiant demandé. */
  name: string;
  handle: (s: PilotageServices, viewer: Viewer, params: string[], request: Request) => Promise<Response>;
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

/** Un export au format tableur, téléchargé sous un nom sans donnée personnelle. */
function csv(result: { ok: true; value: string } | Outcome, filename: string): Response {
  if (!result.ok) return reply(result);
  return new Response(String(result.value), {
    status: 200,
    headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${filename}"`, ...HEADERS },
  });
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

const badBody = (): Response => json(400, { ok: false, rule: null, code: 'invalid_body', message: 'Corps JSON attendu.' });
const badPeriod = (): Response => json(400, { ok: false, rule: null, code: 'bad_period' });
const query = (r: Request, name: string): string | null => new URL(r.url).searchParams.get(name);

/** Aucun montant n'entre par une route [R63, R67] : un corps qui en porte un est refusé, sans rien ranger. */
const AMOUNT_KEYS = /amount|montant|cents|eur|fee|honorair|price|prix/i;
const carriesAmount = (body: Record<string, unknown>): boolean => Object.keys(body).some((k) => AMOUNT_KEYS.test(k));

const services = (s: PilotageServices) => ({
  commissions: new pilotage.Commissions(s.db, s.acces, s.journal, { now: s.now }),
  factures: new pilotage.Factures(s.db, s.acces, s.journal, { now: s.now }),
  encaissements: new pilotage.Encaissements(s.db, s.acces, s.journal, { now: s.now }),
  agent: new pilotage.TableauAgent(s.db, s.journal, { now: s.now }),
  reseau: new pilotage.TableauReseau(s.db, s.journal, { now: s.now }),
  rapport: new pilotage.RapportMatin(s.db, s.journal, { now: s.now }),
  alertes: new pilotage.AlertesPilotage(s.db, s.journal, { now: s.now, documents: new pilotage.SqlEcheancesDocumentsAgent(s.db) }),
  export: new pilotage.ExportQuotidien(s.db, s.journal, { now: s.now }),
  parcours: new pilotage.IndicateursParcours(s.db, s.journal, { now: s.now }),
  indicateursReseau: new pilotage.IndicateursReseau(s.db, s.journal, { now: s.now }),
  engagementsTenus: new pilotage.EngagementsTenus(s.db, s.journal, { now: s.now }),
  tempsGagne: new pilotage.TempsGagne(s.db, s.journal, { now: s.now }),
  manques: new pilotage.EngagementsManques(s.db, s.journal, { now: s.now }),
  disponibilite: new pilotage.DisponibiliteService(s.journal, { now: s.now, supervision: s.supervision ?? null }),
  copies: new SuiviCopies(s.db, s.journal, { now: s.now }),
  restauration: new RecusRestauration(s.db, s.journal, { now: s.now }),
  parcoursDuMois: new RecusParcours(s.db, s.journal, { now: s.now }),
  preuve: new pilotage.CompteurPreuve(s.db, s.journal, { now: s.now }),
  sceaux: new pilotage.SceauxPreuve(s.db, s.journal, { now: s.now }),
});

/** Les routes de M13, à ajouter à celles de `app.ts`. */
export function pilotageRoutes(): PilotageRoute[] {
  const withBody = (fn: (s: PilotageServices, v: Viewer, params: string[], body: Record<string, unknown>) => Promise<Response>): PilotageRoute['handle'] => async (s, v, params, request) => {
    const body = await readJson(request);
    if (!body) return badBody();
    if (carriesAmount(body)) return json(400, { ok: false, rule: 'R67', code: 'amount_refused', message: 'Aucun montant ne se saisit : il est calculé par le code.' });
    return fn(s, v, params, body);
  };
  const P = '^/pilotage';
  return [
    {
      method: 'GET',
      pattern: new RegExp(`${P}/mes-chiffres$`),
      name: 'pilotage.mes_chiffres',
      // L'agent lit ses chiffres ; la direction lit ceux d'un agent par `agent` ; chaque chiffre avec ses lignes.
      handle: async (s, v, _p, r) => {
        const agent = query(r, 'agent');
        if (agent !== null && !new RegExp(`^${ID}$`).test(agent)) return badBody();
        return reply(await services(s).agent.of(v, { from: query(r, 'du'), to: query(r, 'au'), ...(agent ? { agentId: agent } : {}) }));
      },
    },
    { method: 'GET', pattern: new RegExp(`${P}/preuve$`), name: 'pilotage.preuve', handle: async (s, v) => reply(await services(s).preuve.read(v)) },
    { method: 'GET', pattern: new RegExp(`${P}/parcours$`), name: 'pilotage.parcours', handle: async (s, v, _p, r) => reply(await services(s).parcours.of(v, { from: query(r, 'du'), to: query(r, 'au') })) },
    { method: 'GET', pattern: new RegExp(`${P}/preuve/sceaux$`), name: 'pilotage.preuve_sceaux', handle: async (s, v) => reply(await services(s).sceaux.read(v)) },
    {
      method: 'POST',
      pattern: new RegExp(`${P}/preuve/sceau$`),
      name: 'pilotage.preuve_sceau',
      // Le comptage manuel n'est pas un montant : `withBody` refuse les montants, ce nombre de mandats passe.
      handle: withBody(async (s, v, _p, body) => reply(await services(s).sceaux.seal(v, { month: body.month, manualCount: body.manualCount }))),
    },
    { method: 'GET', pattern: new RegExp(`${P}/agents-actifs$`), name: 'pilotage.agents_actifs', handle: async (s, v, _p, r) => reply(await services(s).indicateursReseau.people(v, query(r, 'mois'))) },
    { method: 'GET', pattern: new RegExp(`${P}/contacts-par-zone$`), name: 'pilotage.contacts_par_zone', handle: async (s, v, _p, r) => reply(await services(s).indicateursReseau.contactsByZone(v, query(r, 'mois'))) },
    { method: 'GET', pattern: new RegExp(`${P}/engagements-tenus$`), name: 'pilotage.engagements_tenus', handle: async (s, v, _p, r) => reply(await services(s).engagementsTenus.ofMonth(v, query(r, 'mois'))) },
    { method: 'GET', pattern: new RegExp(`${P}/temps-gagne$`), name: 'pilotage.temps_gagne', handle: async (s, v, _p, r) => reply(await services(s).tempsGagne.mine(v, query(r, 'semaine'))) },
    { method: 'POST', pattern: new RegExp(`${P}/temps-gagne$`), name: 'pilotage.temps_gagne_declare', handle: withBody(async (s, v, _p, body) => reply(await services(s).tempsGagne.declare(v, { week: body.week, minutes: body.minutes }))) },
    { method: 'GET', pattern: new RegExp(`${P}/temps-gagne/reseau$`), name: 'pilotage.temps_gagne_reseau', handle: async (s, v, _p, r) => reply(await services(s).tempsGagne.network(v, query(r, 'semaine'))) },
    { method: 'GET', pattern: new RegExp(`${P}/engagements-manques$`), name: 'pilotage.engagements_manques', handle: async (s, v) => reply(await services(s).manques.open(v)) },
    { method: 'POST', pattern: new RegExp(`${P}/engagements-manques/${ID}/fait$`), name: 'pilotage.engagement_manque_fait', handle: withBody(async (s, v, [id], body) => reply(await services(s).manques.close(v, id!, body.outcome))) },
    { method: 'GET', pattern: new RegExp(`${P}/disponibilite$`), name: 'pilotage.disponibilite', handle: async (s, v, _p, r) => reply(await services(s).disponibilite.ofMonth(v, query(r, 'mois'))) },
    { method: 'GET', pattern: new RegExp(`${P}/copies/restauration$`), name: 'pilotage.copies_restauration', handle: async (s, v) => reply(await services(s).restauration.status(v)) },
    { method: 'GET', pattern: new RegExp(`${P}/parcours-du-mois$`), name: 'pilotage.parcours_du_mois', handle: async (s, v) => reply(await services(s).parcoursDuMois.status(v)) },
    { method: 'GET', pattern: new RegExp(`${P}/copies$`), name: 'pilotage.copies', handle: async (s, v) => reply(await services(s).copies.status(v)) },
    { method: 'GET', pattern: new RegExp(`${P}/reseau$`), name: 'pilotage.reseau', handle: async (s, v, _p, r) => reply(await services(s).reseau.of(v, { from: query(r, 'du'), to: query(r, 'au') })) },
    {
      method: 'GET',
      pattern: new RegExp(`${P}/rapport-matin$`),
      name: 'pilotage.rapport_matin',
      handle: async (s, v, _p, r) => {
        const day = query(r, 'jour');
        if (day !== null && !DAY.test(day)) return badPeriod();
        return reply(await services(s).rapport.read(v, day ?? undefined));
      },
    },
    { method: 'GET', pattern: new RegExp(`${P}/alertes$`), name: 'pilotage.alertes', handle: async (s, v) => reply(await services(s).alertes.list(v)) },
    { method: 'GET', pattern: new RegExp(`${P}/reglages$`), name: 'pilotage.reglages_lire', handle: async (s, v) => reply(await services(s).alertes.readSettings(v)) },
    { method: 'GET', pattern: new RegExp(`${P}/grille$`), name: 'pilotage.grille_lire', handle: async (s, v) => reply(await services(s).commissions.currentGrid(v)) },
    {
      method: 'POST',
      pattern: new RegExp(`${P}/reglages$`),
      name: 'pilotage.reglages',
      // Le budget de l'IA est un plafond réglé par la direction, pas le montant d'une opération : il garde sa clé.
      handle: async (s, v, _p, r) => {
        const body = await readJson(r);
        if (!body) return badBody();
        const allowed = ['aiMonthlyBudgetCents', 'aiAlertBp', 'dropAlertBp', 'documentNoticeDays'];
        if (Object.keys(body).some((k) => !allowed.includes(k))) return badBody();
        return reply(await services(s).alertes.setSettings(v, body as Partial<pilotage.PilotageSettings>));
      },
    },
    { method: 'GET', pattern: new RegExp(`${P}/commissions$`), name: 'pilotage.commissions', handle: async (s, v) => reply(await services(s).commissions.list(v)) },
    { method: 'GET', pattern: new RegExp(`${P}/commissions/a-trancher$`), name: 'pilotage.commissions_a_trancher', handle: async (s, v) => reply(await services(s).commissions.blocked(v)) },
    {
      // AU091 · la direction approuve, avec son motif, la régularisation qu'un avenant d'honoraires appelle ; le code
      // recalcule tout, aucun montant n'entre [R678].
      method: 'POST',
      pattern: new RegExp(`${P}/commissions/${ID}/regularisation$`),
      name: 'pilotage.commission_regularisation',
      handle: withBody(async (s, v, [id], b) => {
        if (typeof b.reason !== 'string' || (b.expectedVersion !== undefined && typeof b.expectedVersion !== 'number') || Object.keys(b).some((k) => k !== 'reason' && k !== 'expectedVersion')) return badBody();
        return reply((await services(s).commissions.regularize(v, id!, { reason: b.reason, expectedVersion: b.expectedVersion })) as Outcome);
      }),
    },
    {
      method: 'POST',
      pattern: new RegExp(`${P}/grille$`),
      name: 'pilotage.grille',
      handle: withBody(async (s, v, _p, b) => {
        if (typeof b.validFrom !== 'string' || typeof b.defaultRateBp !== 'number' || (b.agents !== undefined && !Array.isArray(b.agents)) || (b.expectedVersion !== undefined && b.expectedVersion !== null && typeof b.expectedVersion !== 'number')) return badBody();
        return reply((await services(s).commissions.setGrid(v, b as unknown as pilotage.GridInput)) as Outcome);
      }),
    },
    { method: 'GET', pattern: new RegExp(`${P}/factures$`), name: 'pilotage.factures', handle: async (s, v) => reply(await services(s).factures.list(v)) },
    { method: 'GET', pattern: new RegExp(`${P}/factures/brouillons$`), name: 'pilotage.brouillons', handle: async (s, v) => reply(await services(s).factures.drafts(v)) },
    { method: 'POST', pattern: new RegExp(`${P}/factures/brouillons/${ID}/valider$`), name: 'pilotage.valider', handle: async (s, v, [id]) => reply(await services(s).factures.validate(v, id!)) },
    {
      method: 'POST',
      pattern: new RegExp(`${P}/factures/${ID}/avoir$`),
      name: 'pilotage.avoir',
      handle: withBody(async (s, v, [id], b) => (typeof b.reason === 'string' ? reply(await services(s).factures.credit(v, id!, b.reason)) : badBody())),
    },
    {
      method: 'GET',
      pattern: new RegExp(`${P}/factures/export$`),
      name: 'pilotage.export_factures',
      handle: async (s, v, _p, r) => {
        const from = query(r, 'du');
        const to = query(r, 'au');
        if (!from || !to) return badPeriod();
        return csv(await services(s).factures.exportCsv(v, from, to), `factures-${from}-${to}.csv`.replace(/[^A-Za-z0-9.-]/g, ''));
      },
    },
    {
      method: 'POST',
      pattern: new RegExp(`${P}/dossiers/${ID}/encaissement$`),
      name: 'pilotage.encaissement',
      handle: withBody(async (s, v, [id], b) => {
        const r = await services(s).encaissements.recordReceipt(v, id!, { receivedAt: b.receivedAt, proofRef: b.proofRef });
        return reply(r.ok ? { ok: true, value: { payoutDueAt: r.payoutDueAt } } : r);
      }),
    },
    {
      method: 'POST',
      pattern: new RegExp(`${P}/dossiers/${ID}/reversement$`),
      name: 'pilotage.reversement',
      handle: withBody(async (s, v, [id], b) => {
        const r = await services(s).encaissements.recordPayout(v, id!, { paidAt: b.paidAt, proofRef: b.proofRef });
        return reply(r.ok ? { ok: true, value: { late: r.late } } : r);
      }),
    },
    { method: 'GET', pattern: new RegExp(`${P}/reversements$`), name: 'pilotage.reversements', handle: async (s, v) => reply(await services(s).encaissements.tasks(v)) },
    {
      method: 'GET',
      pattern: new RegExp(`${P}/export-quotidien$`),
      name: 'pilotage.export_quotidien',
      handle: async (s, v, _p, r) => {
        const day = query(r, 'jour');
        if (!day || !DAY.test(day)) return badPeriod();
        return csv(await services(s).export.csv(v, day), `chiffres-${day}.csv`);
      },
    },
  ];
}

/** Les passages de M13 au planificateur. */
export function pilotageJobs(db: SqlDatabase, journal: JournalStore, options: { now?: () => Date } = {}): ScheduledJob[] {
  return [
    pilotage.pilotageHourlyJob(db, journal, options),
    pilotage.pilotageAlertsJob(db, journal, { ...options, documents: new pilotage.SqlEcheancesDocumentsAgent(db) }),
    pilotage.morningReportJob(db, journal, options),
    // La copie de la nuit (SV02) : de 6 h à 8 h, une nuit sans copie réussie alerte la direction, sans aucun envoi [R230].
    copyWatchJob(db, journal, options),
    // AU109 · le test de restauration du mois : sans reçu réussi, une alerte par mois, même si GitHub a cessé [R232].
    restoreWatchJob(db, journal, options),
  ];
}
