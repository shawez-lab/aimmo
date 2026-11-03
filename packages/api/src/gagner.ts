/**
 * Les routes de M20 complet, Gagner des mandats (G11), sous `/v1/gagner` : lettres de quartier (G06),
 * recommandations des partenaires et file « à appeler » (G08), relances des anciens contacts (G09), mesure mensuelle
 * des sources (G10), dossier de présentation des rendez-vous de mandat et engagements de service (G07) ; et les deux
 * listes que lit l'écran « Gagner des mandats » de l'application (G13) : campagnes et biens permis, rendez-vous à venir.
 *
 * Chaque route dit les rôles qu'elle admet : un autre rôle est refusé avant que le corps soit lu, et le refus est écrit
 * au journal [R16]. La couche métier refait ses propres contrôles de droits. Rien n'est envoyé réellement : les
 * relances passent par le contrôle central, en mode essai [R26]. Les routes sont branchées dans `app.ts` par G12, avec
 * les passages du planificateur (`gagnerJobs`) : la liste des relances d'anciens contacts et l'avis de la mesure du mois.
 */
import {
  Acces,
  AnciensContacts,
  FicheClient,
  DossierPresentation,
  FicheUnique,
  LettresQuartier,
  MesureSources,
  RecommandationsGagner,
  appendEvent,
  type CostProofStore,
  type DossierDrafter,
  type Geocoder,
  type LetterDrafter,
  type JournalStore,
  type OldContactDrafter,
  type Role,
  type ScheduledJob,
  type SqlDatabase,
  type Viewer,
} from '@aimmo/core';
import { Annuaire } from '../../core/src/partenaires/index.ts';
import { renderDossier } from '../../core/src/mandats/gagner/dossier-presentation.ts';
import { UPLOAD_TYPES, readUpload, sha256Hex, type PartnerUploadStore } from './partenaires.ts';

export const TRIAL_MODE = 'essai';
const MAX_BODY_BYTES = 8_000;
const ID = '([A-Za-z0-9_-]{1,64})';

export interface GagnerServices {
  db: SqlDatabase;
  journal: JournalStore;
  acces: Acces;
  now: () => Date;
  /** Le stockage des preuves (coûts des sources, justificatifs des partenaires) ; absent, la saisie d'un coût est refusée. */
  proofs?: CostProofStore | null;
  /** Le dépôt des preuves de coût ; absent, l'envoi d'un fichier est refusé (503) et rien n'est rangé. */
  uploads?: PartnerUploadStore | null;
  /** La rédaction des relances par l'IA ; absente, le texte de secours du code. */
  drafter?: OldContactDrafter | null;
  /** Le géocodage des adresses des lettres ; absent, aucune campagne ne peut vérifier son rayon. */
  geocoder?: Geocoder | null;
  /** La rédaction des lettres par l'IA ; absente, le texte du code. */
  letterDrafter?: LetterDrafter | null;
  /** La phrase d'accueil du dossier par l'IA ; absente, celle du code. */
  dossierDrafter?: DossierDrafter | null;
}

export interface GagnerRoute {
  method: 'GET' | 'POST';
  pattern: RegExp;
  /** Nom de la route pour le journal : jamais l'identifiant demandé. */
  name: string;
  /** Les rôles admis : tout autre est refusé avant la lecture du corps [R16]. */
  roles: readonly Role[];
  handle: (s: GagnerServices, viewer: Viewer, params: string[], request: Request) => Promise<Response>;
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
  });

type Outcome = { ok: true; value?: unknown } | { ok: false; rule: string | null; code: string };

/** 200 ; 403 pour un refus de droits ; 404 inconnu ; 409 pour une règle ; 400 sinon. */
function reply(result: Outcome): Response {
  if (result.ok) return json(200, { ok: true, mode: TRIAL_MODE, data: result.value ?? null });
  const { ok: _ok, ...rest } = result;
  if (result.rule === 'R16') return json(result.code === 'unknown' ? 404 : 403, { ok: false, ...rest });
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

const badBody = (): Response => json(400, { ok: false, rule: null, code: 'invalid_body', message: 'Corps JSON attendu.' });

/** Aucun fichier n'est jamais lu : le stockage absent refuse toute preuve. */
const NO_PROOFS: CostProofStore = { has: async () => false };

const services = (s: GagnerServices) => {
  const store = new FicheClient(s.db, { now: s.now });
  const fiche = new FicheUnique(s.db, store, { now: s.now });
  const proofs = s.proofs ?? NO_PROOFS;
  return {
    recommandations: new RecommandationsGagner(s.db, store, fiche, s.acces, new Annuaire(s.db, proofs, s.journal, { now: s.now }), s.journal, { now: s.now }),
    anciens: new AnciensContacts(s.db, s.journal, { now: s.now, drafter: s.drafter ?? null }),
    mesure: new MesureSources(s.db, proofs, s.journal, { now: s.now }),
    dossier: new DossierPresentation(s.db, s.journal, { now: s.now, drafter: s.dossierDrafter ?? null }),
    lettres: new LettresQuartier(s.db, s.journal, { now: s.now, geocoder: s.geocoder ?? null, drafter: s.letterDrafter ?? null }),
  };
};

/**
 * La direction dépose la preuve d'un coût, en PDF, JPEG ou PNG : le serveur contrôle le format par sa signature, choisit
 * la référence et la rend ; la saisie du coût la reprend [R144]. Le contenu n'est jamais lu au-delà de sa signature, et
 * le journal ne garde que l'empreinte [R13].
 */
async function depositProof(s: GagnerServices, viewer: Viewer, request: Request): Promise<Response> {
  const type = (request.headers.get('content-type') ?? '').toLowerCase().split(';')[0]!.trim();
  const kind = UPLOAD_TYPES.find((t) => t.type === type);
  if (!kind) return json(415, { ok: false, rule: null, code: 'bad_type' });
  if (!s.uploads) return json(503, { ok: false, rule: null, code: 'storage_unavailable' });
  const bytes = await readUpload(request);
  if (!bytes) return json(413, { ok: false, rule: null, code: 'too_large' });
  if (bytes.byteLength < kind.magic.length || !kind.magic.every((b, i) => bytes[i] === b)) return json(415, { ok: false, rule: null, code: 'bad_type' });
  const proofRef = `mesure-sources/${viewer.networkId}/${crypto.randomUUID()}.${kind.ext}`;
  const sha256 = await sha256Hex(bytes);
  await s.uploads.put(proofRef, bytes, kind.type);
  await appendEvent(s.journal, { type: 'mesure_sources.preuve', actor: `${String(viewer.role)}:${viewer.userId}`, subject: null, data: { rule: 'R144', sha256 } }, s.now);
  return reply({ ok: true, value: { proofRef } });
}

/** Le rôle d'abord : un rôle non admis est refusé, au journal, sans que le corps soit lu [R16, R13]. */
export function guarded(route: GagnerRoute): GagnerRoute['handle'] {
  return async (s, viewer, params, request) => {
    if (!route.roles.includes(viewer.role)) {
      await appendEvent(s.journal, { type: 'acces.refuse', actor: `${String(viewer.role)}:${viewer.userId}`, subject: null, data: { rule: 'R16', role: String(viewer.role), kind: `route.${route.name}`, code: 'role' } }, s.now);
      return json(403, { ok: false, rule: 'R16', code: 'role' });
    }
    return route.handle(s, viewer, params, request);
  };
}

export function gagnerRoutes(): GagnerRoute[] {
  const withBody =
    (fn: (s: GagnerServices, v: Viewer, params: string[], body: Record<string, unknown>) => Promise<Response>): GagnerRoute['handle'] =>
    async (s, v, params, request) => {
      const body = await readJson(request);
      return body ? fn(s, v, params, body) : badBody();
    };
  const P = '^/gagner';
  const AGENT: readonly Role[] = ['agent'];
  const DIRECTION: readonly Role[] = ['direction'];
  const PARTNER: readonly Role[] = ['partner'];
  const routes: GagnerRoute[] = [
    // G06 · lettres de quartier
    { method: 'GET', pattern: new RegExp(`${P}/lettres$`), name: 'gagner.lettres_liste', roles: AGENT, handle: async (s, v) => reply(await services(s).lettres.overview(v)) },
    { method: 'POST', pattern: new RegExp(`${P}/lettres$`), name: 'gagner.lettres_campagne', roles: AGENT, handle: withBody(async (s, v, _p, b) => reply(await services(s).lettres.createCampaign(v, b))) },
    { method: 'GET', pattern: new RegExp(`${P}/lettres/${ID}$`), name: 'gagner.lettres', roles: AGENT, handle: async (s, v, [id]) => reply(await services(s).lettres.letters(v, id!)) },
    {
      method: 'GET',
      pattern: new RegExp(`${P}/lettres/${ID}/impression$`),
      name: 'gagner.lettres_impression',
      roles: AGENT,
      handle: async (s, v, [id]) => {
        const r = await services(s).lettres.printable(v, id!);
        if (!r.ok) return reply(r);
        return new Response(r.value.html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'", 'x-content-type-options': 'nosniff' } });
      },
    },
    { method: 'POST', pattern: new RegExp(`${P}/lettres/lettre/${ID}/deposee$`), name: 'gagner.lettre_deposee', roles: AGENT, handle: async (s, v, [id]) => reply(await services(s).lettres.deposited(v, id!)) },
    // G07 · dossier de présentation et engagements de service
    { method: 'GET', pattern: new RegExp(`${P}/rendez-vous$`), name: 'gagner.rendez_vous', roles: AGENT, handle: async (s, v) => reply(await services(s).dossier.upcoming(v)) },
    { method: 'GET', pattern: new RegExp(`${P}/rendez-vous/${ID}/dossier$`), name: 'gagner.dossier', roles: AGENT, handle: async (s, v, [id]) => reply(await services(s).dossier.build(v, id!)) },
    {
      method: 'GET',
      pattern: new RegExp(`${P}/rendez-vous/${ID}/dossier/page$`),
      name: 'gagner.dossier_page',
      roles: AGENT,
      handle: async (s, v, [id]) => {
        const r = await services(s).dossier.build(v, id!);
        if (!r.ok) return reply(r);
        const agent = await s.db.first<{ first_name: string; last_name: string }>('SELECT first_name, last_name FROM agents WHERE id = ?', [v.userId]);
        return new Response(renderDossier(r.value, agent ? `${agent.first_name} ${agent.last_name}` : ''), { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'", 'x-content-type-options': 'nosniff' } });
      },
    },
    { method: 'GET', pattern: new RegExp(`${P}/engagements$`), name: 'gagner.engagements', roles: DIRECTION, handle: async (s, v) => reply(await services(s).dossier.commitments(v)) },
    { method: 'POST', pattern: new RegExp(`${P}/engagements$`), name: 'gagner.engagement', roles: DIRECTION, handle: withBody(async (s, v, _p, b) => reply(await services(s).dossier.setCommitment(v, b))) },
    // G08 · recommandations
    { method: 'POST', pattern: new RegExp(`${P}/recommandations$`), name: 'gagner.recommandation', roles: PARTNER, handle: withBody(async (s, v, _p, b) => reply(await services(s).recommandations.recommend(v, b))) },
    { method: 'GET', pattern: new RegExp(`${P}/recommandations/mes-envois$`), name: 'gagner.recommandations_envois', roles: PARTNER, handle: async (s, v) => reply(await services(s).recommandations.mine(v)) },
    { method: 'GET', pattern: new RegExp(`${P}/recommandations/agents$`), name: 'gagner.recommandations_agents', roles: DIRECTION, handle: async (s, v) => reply(await services(s).recommandations.assignableAgents(v)) },
    { method: 'GET', pattern: new RegExp(`${P}/recommandations/a-appeler$`), name: 'gagner.recommandations_a_appeler', roles: ['agent', 'direction'], handle: async (s, v) => reply(await services(s).recommandations.toCall(v)) },
    {
      method: 'POST',
      pattern: new RegExp(`${P}/recommandations/${ID}/attribuer$`),
      name: 'gagner.recommandation_attribuer',
      roles: DIRECTION,
      handle: withBody(async (s, v, [id], b) => (typeof b.agentId === 'string' ? reply(await services(s).recommandations.assign(v, id!, b.agentId)) : badBody())),
    },
    { method: 'POST', pattern: new RegExp(`${P}/recommandations/${ID}/appel-fait$`), name: 'gagner.recommandation_appel_fait', roles: AGENT, handle: async (s, v, [id]) => reply(await services(s).recommandations.callDone(v, id!)) },
    // G09 · anciens contacts
    { method: 'GET', pattern: new RegExp(`${P}/fiches/${ID}/fin-de-bail$`), name: 'gagner.fins_de_bail', roles: AGENT, handle: async (s, v, [id]) => reply(await services(s).anciens.leaseEnds(v, id!)) },
    { method: 'POST', pattern: new RegExp(`${P}/fiches/${ID}/fin-de-bail$`), name: 'gagner.fin_de_bail', roles: AGENT, handle: withBody(async (s, v, [id], b) => reply(await services(s).anciens.noteLeaseEnd(v, id!, b.onDay))) },
    { method: 'GET', pattern: new RegExp(`${P}/relances$`), name: 'gagner.relances', roles: AGENT, handle: async (s, v) => reply(await services(s).anciens.toValidate(v)) },
    {
      method: 'POST',
      pattern: new RegExp(`${P}/relances/${ID}/valider$`),
      name: 'gagner.relance_valider',
      roles: AGENT,
      handle: withBody(async (s, v, [id], b) => reply(await services(s).anciens.validate(v, id!, { ...(b.channel === undefined ? {} : { channel: b.channel }), ...(b.text === undefined ? {} : { text: b.text }) }))),
    },
    // G10 · mesure des sources
    { method: 'GET', pattern: new RegExp(`${P}/mesure/(\\d{4}-\\d{2})$`), name: 'gagner.mesure', roles: DIRECTION, handle: async (s, v, [month]) => reply(await services(s).mesure.report(v, month)) },
    { method: 'POST', pattern: new RegExp(`${P}/mesure/preuves$`), name: 'gagner.mesure_preuve', roles: DIRECTION, handle: (s, v, _p, request) => depositProof(s, v, request) },
    { method: 'POST', pattern: new RegExp(`${P}/mesure/couts$`), name: 'gagner.mesure_cout', roles: DIRECTION, handle: withBody(async (s, v, _p, b) => reply(await services(s).mesure.enterCost(v, b))) },
    { method: 'POST', pattern: new RegExp(`${P}/mesure/decisions$`), name: 'gagner.mesure_decision', roles: DIRECTION, handle: withBody(async (s, v, _p, b) => reply(await services(s).mesure.decide(v, b))) },
  ];
  return routes.map((r) => ({ ...r, handle: guarded(r) }));
}

export const OLD_CONTACTS_JOB = 'gagner.relances_anciens_contacts';
export const SOURCE_MEASURE_JOB = 'gagner.mesure_mensuelle';
const TIME_ZONE = 'Europe/Paris';

/** Le jour de Paris, `AAAA-MM-JJ`. */
function parisDay(at: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(at);
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** Le mois qui précède `AAAA-MM`. */
function previousMonth(month: string): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return m === 1 ? `${String(y - 1).padStart(4, '0')}-12` : `${String(y).padStart(4, '0')}-${String(m - 1).padStart(2, '0')}`;
}

/**
 * Les passages de M20 complet au planificateur (G12) :
 * - chaque jour à 6 h, la liste du mois des relances d'anciens contacts (G09) : une relance au plus par personne et par
 *   mois, et par période réglée, rangée à valider pour son agent ; passer chaque jour ne fait aucun doublon et prend
 *   le moment dès qu'il arrive (fin de bail dans les 90 jours). Rien n'est envoyé : la relance part seulement quand
 *   l'agent la valide, par le contrôle central, en mode essai [R143, R26] ;
 * - le 1er du mois à 8 h, l'avis à la direction que la mesure du mois passé (G10) se lit : une ligne au journal, sans
 *   aucun nombre ni donnée personnelle ; le compte rendu reste calculé à la lecture, et la décision à la direction [R144].
 * Une panne sur un réseau n'arrête pas les autres ; elle remonte ensuite au planificateur, jamais avalée [R13].
 */
export function gagnerJobs(db: SqlDatabase, journal: JournalStore, options: { now?: () => Date; drafter?: OldContactDrafter | null } = {}): ScheduledJob[] {
  const now = options.now ?? (() => new Date());
  const eachNetwork = async (fn: (networkId: string) => Promise<void>): Promise<void> => {
    let failure: unknown = null;
    for (const n of await db.all<{ id: string }>('SELECT id FROM networks ORDER BY id')) {
      try {
        await fn(n.id);
      } catch (error) {
        failure ??= error;
      }
    }
    if (failure !== null) throw failure;
  };
  return [
    {
      name: OLD_CONTACTS_JOB,
      hours: [6],
      run: async () => {
        const anciens = new AnciensContacts(db, journal, { now, drafter: options.drafter ?? null });
        await eachNetwork(async (id) => {
          const prepared = await anciens.prepareMonth(id);
          await appendEvent(journal, { type: 'anciens_contacts.passage', actor: 'system:planificateur', subject: `network:${id}`, data: { mode: TRIAL_MODE, prepared } }, now);
        });
      },
    },
    {
      name: SOURCE_MEASURE_JOB,
      hours: [8],
      run: async () => {
        const today = parisDay(now());
        if (!today.endsWith('-01')) return;
        const month = previousMonth(today.slice(0, 7));
        await eachNetwork(async (id) => {
          await appendEvent(journal, { type: 'gagner.mesure_a_lire', actor: 'system:planificateur', subject: `network:${id}`, data: { rule: 'R144', month } }, now);
        });
      },
    },
  ];
}
