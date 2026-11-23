/**
 * Les routes de M09 Offres (O08), sous `/v1/offres`, et le passage quotidien des offres pour le planificateur.
 *
 * Comme `annonces.ts`, ce fichier ne touche pas aux fichiers du socle : il expose `offreRoutes()`, de la même forme que
 * les routes de `app.ts`, et `syncOffres` (offres non transmises, échéances). Leur branchement dans `app.ts` et au
 * planificateur est laissé à la voie qui tient le socle (PROTOCOLE, section 8).
 *
 * Chaque route passe par les droits de la couche métier [R16], qui écrit chaque refus au journal. Aucune route
 * n'accepte, ne refuse ni ne négocie : seule une réponse rapportée avec preuve change l'état d'une offre [R57].
 */
import { journalError } from './app.ts';
import { readCapped } from './studio.ts';
import { Acces, FicheClient, FicheUnique, dossiers as m10, offres as m09, type JournalStore, type ScheduledJob, type SqlDatabase, type Viewer } from '@aimmo/core';

const { ComparatifOffres, ContreOffres, ControlesOffre, DepotsOffres, DossiersVente, EcheancesOffres, RegistreOffres, SuiviOffres, TransmissionOffres } = m09;

export const TRIAL_MODE = 'essai';
const MAX_BODY_BYTES = 16_000;
const ID = '([A-Za-z0-9_-]{1,64})';

export interface OffreServices {
  db: SqlDatabase;
  journal: JournalStore;
  acces: Acces;
  now: () => Date;
}

export interface OffreRoute {
  method: 'GET' | 'POST';
  pattern: RegExp;
  /** Nom de la route pour le journal : jamais l'identifiant demandé. */
  name: string;
  handle: (s: OffreServices, viewer: Viewer, params: string[], request: Request) => Promise<Response>;
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

/** Le stockage où une offre signée ou une preuve est rangée (O10) ; sans lui, le dépôt est fermé. */
export interface OfferUploadStore {
  has(ref: string): Promise<boolean>;
  upload?(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
}

const DEPOSIT_STATUS: Readonly<Record<string, number>> = { trop_lourd: 413, type_refuse: 415, stockage_indisponible: 503 };

/** Les routes de M09, à ajouter à celles de `app.ts`. */
export function offreRoutes(pieces: OfferUploadStore | null = null): OffreRoute[] {
  const o = (s: OffreServices) => ({
    registre: new RegistreOffres(s.db, s.acces, s.journal, { now: s.now }),
    controles: new ControlesOffre(s.db, s.acces, s.journal, { now: s.now }),
    transmission: new TransmissionOffres(s.db, s.acces, s.journal, { now: s.now }),
    contre: new ContreOffres(s.db, s.acces, s.journal, { now: s.now }),
    comparatif: new ComparatifOffres(s.db, s.acces, s.journal, { now: s.now }),
    dossiers: new DossiersVente(s.db, s.acces, s.journal, { now: s.now }),
    echeances: new EcheancesOffres(s.db, s.journal, { now: s.now }),
  });
  const withBody = (fn: (s: OffreServices, v: Viewer, params: string[], body: Record<string, unknown>) => Promise<Response>): OffreRoute['handle'] => async (s, v, params, request) => {
    const body = await readJson(request);
    return body ? fn(s, v, params, body) : badBody();
  };
  return [
    {
      method: 'POST',
      pattern: new RegExp(`^/offres/biens/${ID}$`),
      name: 'offres.enregistrer',
      // Enregistrée et contrôlée dans le même appel ; la clé d'envoi évite un doublon au registre.
      handle: withBody(async (s, v, [id], b) => reply(await o(s).controles.recordAndCheck(v, id!, {
        buyerPersonId: b.buyerPersonId, coBuyerPersonIds: b.coBuyerPersonIds, amountEur: b.amountEur, conditions: b.conditions, validUntil: b.validUntil,
        downPaymentEur: b.downPaymentEur, loanEur: b.loanEur, signedRef: b.signedRef, receivedAt: b.receivedAt, requestKey: b.requestKey,
      }))),
    },
    // Le collègue qui suit l'acquéreur autorise l'agent du bien à présenter son offre, pour ce seul bien (AU081).
    { method: 'POST', pattern: new RegExp(`^/offres/biens/${ID}/partages$`), name: 'offres.partage', handle: withBody(async (s, v, [id], b) => reply(await o(s).registre.shareBuyer(v, id!, b.buyerPersonId))) },
    { method: 'POST', pattern: new RegExp(`^/offres/partages/${ID}/retrait$`), name: 'offres.partage_retrait', handle: async (s, v, [id]) => reply(await o(s).registre.revokeShare(v, id!)) },
    { method: 'GET', pattern: new RegExp(`^/offres/biens/${ID}$`), name: 'offres.liste', handle: async (s, v, [id]) => reply(await new SuiviOffres(s.db, s.acces, s.journal, { now: s.now }).listFor(v, id!)) },
    // L'écran de l'agent (O10) : le suivi, les contacts qui peuvent être l'acquéreur, le dépôt d'une pièce.
    { method: 'GET', pattern: new RegExp(`^/offres/biens/${ID}/suivi$`), name: 'offres.suivi', handle: async (s, v, [id]) => reply(await new SuiviOffres(s.db, s.acces, s.journal, { now: s.now }).board(v, id!)) },
    { method: 'GET', pattern: new RegExp(`^/offres/biens/${ID}/contacts$`), name: 'offres.contacts', handle: async (s, v, [id]) => reply(await new SuiviOffres(s.db, s.acces, s.journal, { now: s.now }).buyers(v, id!)) },
    {
      method: 'POST',
      pattern: new RegExp(`^/offres/biens/${ID}/fichiers/(signee|preuve)$`),
      name: 'offres.depot',
      handle: async (s, v, [id, kind], r) => {
        const upload = pieces?.upload?.bind(pieces);
        if (!upload) return json(503, { ok: false, rule: null, code: 'depot_ferme' });
        const length = r.headers.get('content-length');
        const declaredSize = length === null || length.trim() === '' ? null : /^\d{1,12}$/.test(length.trim()) ? Number(length.trim()) : Number.NaN;
        const result = await new DepotsOffres(o(s).registre, { put: (key, bytes, type) => upload(key, bytes, type) }, s.journal, { now: s.now }).deposit(v, id!, {
          kind,
          contentType: r.headers.get('content-type'),
          sha256: r.headers.get('x-aimmo-sha256'),
          declaredSize,
          read: (max) => readCapped(r, max),
        });
        if (!result.ok && DEPOSIT_STATUS[result.code]) return json(DEPOSIT_STATUS[result.code]!, { ok: false, rule: result.rule, code: result.code });
        return reply(result as Outcome);
      },
    },
    { method: 'GET', pattern: new RegExp(`^/offres/biens/${ID}/comparatif$`), name: 'offres.comparatif', handle: async (s, v, [id]) => reply(await o(s).comparatif.table(v, id!)) },
    { method: 'GET', pattern: new RegExp(`^/offres/${ID}/historique$`), name: 'offres.historique', handle: async (s, v, [id]) => reply(await o(s).contre.history(v, id!)) },
    { method: 'POST', pattern: new RegExp(`^/offres/${ID}/controle$`), name: 'offres.controle', handle: async (s, v, [id]) => reply(await o(s).controles.check(v, id!)) },
    { method: 'POST', pattern: new RegExp(`^/offres/${ID}/transmission$`), name: 'offres.transmission', handle: withBody(async (s, v, [id], b) => reply(await o(s).transmission.transmit(v, id!, { via: b.via, channel: b.channel, at: b.at }))) },
    { method: 'POST', pattern: new RegExp(`^/offres/${ID}/reponse$`), name: 'offres.reponse', handle: withBody(async (s, v, [id], b) => reply(await o(s).transmission.respond(v, id!, { outcome: b.outcome, proofRef: b.proofRef, respondedAt: b.respondedAt }))) },
    { method: 'POST', pattern: new RegExp(`^/offres/${ID}/propositions$`), name: 'offres.proposition', handle: withBody(async (s, v, [id], b) => reply(await o(s).contre.propose(v, id!, { amountEur: b.amountEur, validUntil: b.validUntil, proofRef: b.proofRef }))) },
    { method: 'POST', pattern: new RegExp(`^/offres/propositions/${ID}/transmission$`), name: 'offres.proposition.transmission', handle: withBody(async (s, v, [id], b) => reply(await o(s).contre.transmit(v, id!, { via: b.via, at: b.at }))) },
    { method: 'POST', pattern: new RegExp(`^/offres/propositions/${ID}/reponse$`), name: 'offres.proposition.reponse', handle: withBody(async (s, v, [id], b) => reply(await o(s).contre.respond(v, id!, { outcome: b.outcome, proofRef: b.proofRef, respondedAt: b.respondedAt }))) },
    { method: 'POST', pattern: new RegExp(`^/offres/${ID}/dossier$`), name: 'offres.dossier', handle: async (s, v, [id]) => reply(await o(s).dossiers.open(v, id!)) },
    { method: 'POST', pattern: new RegExp(`^/offres/dossiers/${ID}/compromis$`), name: 'offres.compromis', handle: async (s, v, [id]) => reply(await o(s).dossiers.startCompromis(v, id!)) },
    { method: 'GET', pattern: /^\/offres\/taches$/, name: 'offres.taches', handle: async (s, v) => reply(await o(s).echeances.tasksOf(v) as Outcome) },
    // L'accueil de l'agent (W26) : ici et non chez M10, fermé sans le stockage des pièces, qui ne sert pas à ces lectures.
    { method: 'GET', pattern: /^\/offres\/a-tenir$/, name: 'offres.a_tenir', handle: async (s, v) => reply(await new m10.ATenirVente(s.db, s.acces, s.journal, { now: s.now }).of(v) as Outcome) },
  ];
}

/** Le passage quotidien des offres d'un réseau : offres non transmises signalées, tâches d'échéance rangées. */
export async function syncOffres(s: OffreServices, networkId: string): Promise<{ untransmitted: number; deadlines: number }> {
  // Les deux contrôles sont indépendants : la panne de l'un n'empêche pas l'autre ; elle est relancée ensuite.
  let failure: unknown = null;
  let untransmitted: string[] = [];
  let deadlines: string[] = [];
  try {
    untransmitted = await new TransmissionOffres(s.db, s.acces, s.journal, { now: s.now }).alertUntransmitted(networkId);
  } catch (error) {
    failure = error;
  }
  try {
    deadlines = await new EcheancesOffres(s.db, s.journal, { now: s.now }).run(networkId);
  } catch (error) {
    failure ??= error;
  }
  if (failure !== null) throw failure;
  return { untransmitted: untransmitted.length, deadlines: deadlines.length };
}

export const OFFERS_DAILY_JOB = 'offres.quotidien';

/**
 * Le passage quotidien des offres au planificateur (O09) : chaque réseau, à 6 h, heure de Paris, une fois par jour
 * (le créneau est réservé par le planificateur). Rien n'est envoyé : signalements et tâches pour l'agent [R56, R59].
 */
export function offersDailyJob(db: SqlDatabase, journal: JournalStore, options: { now?: () => Date } = {}): ScheduledJob {
  const now = options.now ?? (() => new Date());
  return {
    name: OFFERS_DAILY_JOB,
    hours: [6],
    run: async () => {
      const store = new FicheClient(db, { now });
      const s: OffreServices = { db, journal, acces: new Acces(db, store, new FicheUnique(db, store, { now }), journal, { now }), now };
      const networks = await db.all<{ id: string }>('SELECT id FROM networks ORDER BY id');
      // Chaque réseau passe, même si un autre tombe en panne ; chaque panne va au journal, sans donnée [R13], et le
      // créneau est marqué en erreur à la fin.
      let failed = 0;
      for (const n of networks) {
        try {
          await syncOffres(s, n.id);
        } catch (error) {
          failed += 1;
          await journalError(journal, 'system:planificateur', OFFERS_DAILY_JOB, error, now);
        }
      }
      if (failed > 0) throw new Error('offres_en_panne');
    },
  };
}
