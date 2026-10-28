import { UNSUBSCRIBE_PATH, handleUnsubscribe } from './alertes.ts';
import {
  AIMMO_VERSION,
  ATTRIBUTION_RULES,
  ControleBaseLegale,
  AUTOMATION_NAMES,
  Acces,
  Automatisations,
  REF_PATTERN,
  DEFAULT_ATTRIBUTION_SETTINGS,
  CHANNELS,
  DecisionEnvoi,
  FicheClient,
  CATEGORIES,
  ChronologieMandat,
  ControlesSignature,
  SignatureEnLigne,
  SignatureAvenant,
  EcheancesMandats,
  Diffusion,
  SignaturePapier,
  FicheAgent,
  Modeles,
  FicheUnique,
  JourneeRendezVous,
  Qualification,
  ROUTES as NEXT_MODULES,
  PlansDuJour,
  RegistreMandats,
  UsageMatin,
  Rappels,
  Reception,
  ReconnaissanceBien,
  SEND_KINDS,
  SqlJournalStore,
  appendEvent,
  createCaptation,
  decideAccess,
  personSubject,
  verifyChain,
  type AccessResult,
  type Automation,
  type Channel,
  type JournalStore,
  type SendKind,
  type SendRequest,
  type SqlDatabase,
  type Viewer,
} from '@aimmo/core';
import { intakeFromRequest, parseApiKeys, parseIntakeKeys, viewerFromRequest } from './auth.ts';
import { INVITATION_PATH, handleInvitation, invitedKeys, mergeKeys } from './acces.ts';
import { ASSISTANT_PATH, handleAssistant, type AssistantLimits } from './assistant.ts';
import type { ReplyWriter } from '@aimmo/core';
import { META_PATH, handleMeta, type MetaConfig } from './meta.ts';
import { handleAgentApp } from './agent-app.ts';
import { ESTIMATION_PATH, handleEstimation, type EstimationLimits } from './estimation.ts';
import { BOOKING_PATH, BOOKING_SLOTS_PATH, handleBooking, type BookingLimits } from './rendezvous.ts';
import type { DetailedSales, Geocoder } from '@aimmo/core';
import { m08Routes } from './acquereurs.ts';
import { annonceRoutes } from './annonces.ts';
import { offreRoutes } from './offres.ts';
import { dossierRoutes, type DossierRoute, type PieceStore } from './dossiers.ts';
import { pilotageRoutes } from './pilotage.ts';
import { APRES_VENTE_PATH, apresVentePublicError, apresVenteRoutes, handleApresVentePublic } from './apres-vente.ts';
import { handleVitrine, type MediaStore } from './vitrine.ts';

/** Préfixe de version : une API versionnée unique (cahier, Architecture technique). */
export const API_PREFIX = '/v1';

/**
 * Seul mode admis tant qu'aucune tâche du plan n'a mis d'envoi réel en service : l'API décide, elle n'envoie rien.
 */
export const TRIAL_MODE = 'essai';

export interface ApiConfig {
  db: SqlDatabase;
  /** Secret `API_KEYS` : empreintes des clés et identité de chacune (voir auth.ts). */
  apiKeys: string | undefined;
  /** Variable `MODE` : doit valoir « essai ». */
  mode: string | undefined;
  /** Secret `INTAKE_KEYS` : clés qui ne peuvent que déposer un formulaire du site (voir auth.ts). */
  intakeKeys?: string | undefined;
  /** Notifications de Meta (C07) : secrets et variables `META_*`, voir meta.ts. */
  meta?: Omit<MetaConfig, 'db' | 'now'>;
  /** Limites d'appels de l'assistant du site (C08) ; absentes : les réglages par défaut. */
  assistantLimits?: AssistantLimits;
  /** L'IA qui rédige les réponses de l'assistant du site, une fois branchée (H13). */
  writer?: ReplyWriter;
  /** Estimation en ligne du site (E05) : Base adresse nationale et ventes DVF ; absents, le service est fermé. */
  estimation?: { geocoder: Geocoder; sales: DetailedSales };
  estimationLimits?: EstimationLimits;
  /** Réservation des rendez-vous (V08) : limites d'appels, et début du lien pour décaler ou annuler (`RDV_LINK_BASE`). */
  bookingLimits?: BookingLimits;
  appointmentLinkBase?: string | undefined;
  /** Début du lien de désinscription des alertes (`ALERT_UNSUBSCRIBE_BASE`) : sans lui, aucune alerte WhatsApp de l'agent [R49]. */
  alertUnsubscribeBase?: string | undefined;
  /** Les médias des biens (R2, `MEDIA`) ; absent, aucune photo n'est servie. */
  media?: MediaStore;
  /** Les pièces des dossiers de vente (R2, `PIECES`) ; absent, les routes de M10 sont fermées. */
  pieces?: PieceStore;
  now?: () => Date;
}

const MAX_BODY_BYTES = 10_000;
/** Un modèle de mandat tient sur plusieurs pages. */
const TEMPLATE_BODY_BYTES = 120_000;

const modeles = (s: Services): Modeles => new Modeles(s.db, s.acces, s.journal, { now: s.now });
const controles = (s: Services): ControlesSignature => new ControlesSignature(s.db, s.acces, s.journal, { now: s.now });

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  });

const failure = (status: number, code: string, message: string): Response =>
  json(status, { ok: false, code, message });

const refusal = (result: { rule: 'R16'; code: string }): Response =>
  json(result.code === 'unknown' ? 404 : 403, { ok: false, rule: result.rule, code: result.code });

const answer = <T>(result: AccessResult<T>): Response =>
  result.ok ? json(200, { ok: true, mode: TRIAL_MODE, view: result.view, data: result.value }) : refusal(result);

interface Services {
  db: SqlDatabase;
  journal: JournalStore;
  acces: Acces;
  decision: DecisionEnvoi;
  rappels: Rappels;
  qualification: Qualification;
  now: () => Date;
}

function services(db: SqlDatabase, now: () => Date): Services {
  const fiches = new FicheClient(db, { now });
  const unique = new FicheUnique(db, fiches, { now });
  const journal = new SqlJournalStore(db);
  return {
    db,
    journal,
    acces: new Acces(db, fiches, unique, journal, { now }),
    decision: new DecisionEnvoi(db, fiches, unique, { now }),
    rappels: new Rappels(db, unique, journal, { now }),
    qualification: new Qualification(db, fiches, unique, new Reception(db, undefined, now), new ReconnaissanceBien(db), journal, { now }),
    now,
  };
}

type Route = (s: Services, viewer: Viewer, params: string[], request: Request) => Promise<Response>;

interface RouteDef {
  method: 'GET' | 'POST';
  pattern: RegExp;
  /** Nom de la route pour le journal : jamais l'identifiant demandé. */
  name: string;
  handle: Route;
}

const ID = '([A-Za-z0-9_-]{1,64})';

const ROUTES: RouteDef[] = [
  {
    method: 'GET',
    pattern: /^\/moi$/,
    name: 'moi',
    // Qui porte la clé : le rôle, et le prénom pour un agent en activité ; rien d'autre [R16].
    handle: async (s, viewer) => {
      if (viewer.role !== 'agent') return json(200, { ok: true, mode: TRIAL_MODE, data: { role: viewer.role, firstName: null } });
      const agent = await s.db.first<{ first_name: string; status: string; network_id: string }>('SELECT first_name, status, network_id FROM agents WHERE id = ?', [viewer.userId]);
      if (!agent || agent.status !== 'active' || agent.network_id !== viewer.networkId) {
        await appendEvent(s.journal, { type: 'acces.refuse', actor: `agent:${viewer.userId}`, subject: null, data: { rule: 'R16', role: 'agent', kind: 'session', code: 'agent_inactive' } }, s.now);
        return refusal({ rule: 'R16', code: 'agent_inactive' });
      }
      return json(200, { ok: true, mode: TRIAL_MODE, data: { role: 'agent', firstName: agent.first_name } });
    },
  },
  {
    method: 'GET',
    pattern: /^\/fiches$/,
    name: 'fiches',
    handle: async (s, viewer) => answer(await s.acces.listPersons(viewer)),
  },
  {
    method: 'GET',
    pattern: new RegExp(`^/fiches/${ID}$`),
    name: 'fiche',
    handle: async (s, viewer, [id]) => answer(await s.acces.readFiche(viewer, id!)),
  },
  {
    method: 'GET',
    pattern: new RegExp(`^/fiches/${ID}/resume$`),
    name: 'fiche.resume',
    // La fiche pour l'application de l'agent : projets, origines, accords, derniers messages, rappels, numéro à
    // appeler ; refusée hors des droits [R16] ; sans numéro pour une personne exclue ou arrêtée [R02, R04].
    handle: async (s, viewer, [id]) => {
      const fiche = await new FicheAgent(s.db, s.acces, { now: s.now }).read(viewer, id!);
      return fiche.ok ? json(200, { ok: true, mode: TRIAL_MODE, data: fiche.value }) : refusal({ rule: fiche.rule, code: fiche.code });
    },
  },
  {
    method: 'POST',
    pattern: new RegExp(`^/rappels/${ID}/fait$`),
    name: 'rappel.fait',
    // « Rappel fait » : la tâche garde sa ligne [R17] ; seul celui qui voit la fiche en entier la marque [R16].
    // Une tâche inconnue est refusée comme une tâche d'un autre : rien n'est dit de son existence.
    handle: async (s, viewer, [id]) =>
      (await s.rappels.done(s.acces, viewer, id!)) ? json(200, { ok: true, mode: TRIAL_MODE, sent: false }) : json(403, { ok: false, rule: 'R16', code: 'not_assigned' }),
  },
  {
    method: 'GET',
    pattern: new RegExp(`^/fiches/${ID}/journal$`),
    name: 'fiche.journal',
    handle: async (s, viewer, [id]) => answer(await s.acces.readJournalOf(viewer, id!)),
  },
  {
    method: 'GET',
    pattern: new RegExp(`^/biens/${ID}$`),
    name: 'bien',
    handle: async (s, viewer, [id]) => answer(await s.acces.readProperty(viewer, id!)),
  },
  {
    method: 'POST',
    pattern: /^\/envois\/decision$/,
    name: 'envois.decision',
    handle: sendDecision,
  },
  {
    method: 'POST',
    pattern: new RegExp(`^/qualifications/${ID}/correction$`),
    name: 'qualification.correction',
    handle: correctQualification,
  },
  {
    method: 'GET',
    pattern: /^\/contacts-chauds$/,
    name: 'contacts.chauds',
    // Les contacts chauds à rappeler : un agent ne voit que les siens [R16], jamais une personne exclue [R25].
    handle: async (s, viewer) => {
      const list = await s.rappels.hotList(s.acces, viewer);
      return list.ok ? json(200, { ok: true, mode: TRIAL_MODE, data: list.value }) : refusal({ rule: list.rule, code: list.code });
    },
  },
  {
    method: 'GET',
    pattern: /^\/plan-du-jour$/,
    name: 'plan_du_jour',
    // Le plan du jour figé à 7 h 30 : l'agent seul lit le sien [R16] ; `null` tant qu'il n'est pas encore figé.
    handle: async (s, viewer) => {
      const plan = await new PlansDuJour(s.db, s.journal, { now: s.now }).read(viewer);
      return plan.ok ? json(200, { ok: true, mode: TRIAL_MODE, data: plan.value }) : refusal({ rule: plan.rule, code: plan.code });
    },
  },
  {
    method: 'GET',
    pattern: /^\/rendez-vous\/jour$/,
    name: 'rendez_vous.jour',
    // Les rendez-vous du jour de l'agent, heure de Paris, avec leur brief rangé : l'agent seul lit les siens [R16].
    handle: async (s, viewer) => {
      const day = await new JourneeRendezVous(s.db, s.journal, { now: s.now }).read(viewer);
      return day.ok ? json(200, { ok: true, mode: TRIAL_MODE, data: day.value }) : refusal({ rule: day.rule, code: day.code });
    },
  },
  {
    method: 'GET',
    pattern: /^\/usage\/matin$/,
    name: 'usage.matin',
    // L'usage du matin sur 7 jours : l'agent voit ses jours ; la direction, des nombres du réseau, sans classement [R14].
    handle: async (s, viewer) => {
      const usage = await new UsageMatin(s.db, s.journal, { now: s.now }).read(viewer);
      return usage.ok ? json(200, { ok: true, mode: TRIAL_MODE, data: usage.value }) : refusal({ rule: usage.rule, code: usage.code });
    },
  },
  {
    method: 'GET',
    pattern: /^\/plan-du-jour\/controle$/,
    name: 'plan_du_jour.controle',
    // Les écarts du contrôle de la base légale sur 30 jours : des nombres seulement ; direction et conformité [R16].
    handle: async (s, viewer) => {
      const alerts = await new ControleBaseLegale(s.db, s.journal, { now: s.now }).alerts(viewer);
      return alerts.ok ? json(200, { ok: true, mode: TRIAL_MODE, data: alerts.value }) : refusal({ rule: alerts.rule, code: alerts.code });
    },
  },
  {
    method: 'POST',
    pattern: /^\/registre\/reglage$/,
    name: 'registre.reglage',
    // Le format du registre des mandats : la direction seule, une fois, avant la première inscription [R39].
    handle: async (s, viewer, _params, request) => {
      const body = await readJson(request);
      if (body === null) return failure(400, 'invalid_body', 'Corps JSON attendu.');
      if (Object.keys(body).some((k) => !['prefix', 'firstNumber', 'width'].includes(k))) return failure(400, 'unexpected_field', 'Seuls prefix, firstNumber, width sont admis.');
      const r = await new RegistreMandats(s.db, s.journal, { now: s.now }).configure(viewer, { prefix: body.prefix as string, firstNumber: body.firstNumber as number, width: body.width as number });
      if (r.ok) return json(200, { ok: true, mode: TRIAL_MODE });
      return r.rule === 'R16' ? refusal({ rule: 'R16', code: r.code }) : json(r.code === 'already_configured' ? 409 : 400, { ok: false, code: r.code });
    },
  },
  {
    method: 'GET',
    pattern: /^\/registre\/controle$/,
    name: 'registre.controle',
    // Le contrôle d'intégrité du registre : rangs, empreintes, liens, numéros, mandats figés [R39] ; direction, conformité.
    handle: async (s, viewer) => {
      const r = await new RegistreMandats(s.db, s.journal, { now: s.now }).verify(viewer);
      return r.ok ? json(200, { ok: true, mode: TRIAL_MODE, data: r.value }) : refusal({ rule: r.rule, code: r.code });
    },
  },
  {
    method: 'GET',
    pattern: new RegExp(`^/mandats/${ID}/registre$`),
    name: 'mandat.registre',
    // Les lignes du registre d'un mandat : son agent, la direction, la conformité [R16].
    handle: async (s, viewer, [id]) => {
      const r = await new RegistreMandats(s.db, s.journal, { now: s.now }).linesOf(viewer, id!);
      return r.ok ? json(200, { ok: true, mode: TRIAL_MODE, data: r.lines }) : refusal({ rule: r.rule, code: r.code });
    },
  },
  {
    method: 'GET',
    pattern: /^\/modeles$/,
    name: 'modeles',
    // Les modèles du réseau, toutes versions, avec leur état « essai » ou « validé » [R40].
    handle: async (s, viewer) => {
      const r = await modeles(s).list(viewer);
      return r.ok ? json(200, { ok: true, mode: TRIAL_MODE, data: r.templates }) : refusal(r);
    },
  },
  {
    method: 'POST',
    pattern: /^\/modeles$/,
    name: 'modeles.version',
    // Une nouvelle version d'un modèle, à l'état « essai » : la direction seule [R40].
    handle: async (s, viewer, _params, request) => {
      const body = await readJson(request, TEMPLATE_BODY_BYTES);
      if (body === null) return failure(400, 'invalid_body', 'Corps JSON attendu.');
      if (Object.keys(body).some((k) => !['kind', 'body'].includes(k))) return failure(400, 'unexpected_field', 'Seuls kind et body sont admis.');
      const r = await modeles(s).createVersion(viewer, body.kind as never, body.body as string);
      if (r.ok) return json(200, { ok: true, mode: TRIAL_MODE, data: r.template });
      return r.rule === 'R16' ? refusal(r) : json(400, { ok: false, rule: r.rule, code: r.code });
    },
  },
  {
    method: 'POST',
    pattern: new RegExp(`^/modeles/${ID}/validation$`),
    name: 'modeles.validation',
    // Le modèle passe « validé » : la conformité seule, jamais le code (H08).
    handle: async (s, viewer, [id]) => {
      const r = await modeles(s).validate(viewer, id!);
      if (r.ok) return json(200, { ok: true, mode: TRIAL_MODE, data: r.template });
      return r.rule === 'R16' ? refusal(r) : json(r.code === 'unknown_template' ? 404 : 409, { ok: false, code: r.code });
    },
  },
  {
    method: 'POST',
    pattern: /^\/documents$/,
    name: 'documents.generation',
    // Un document généré depuis la dernière version du modèle, pour une fiche et un bien vus en entier [R16, R40].
    handle: async (s, viewer, _params, request) => {
      const body = await readJson(request);
      if (body === null) return failure(400, 'invalid_body', 'Corps JSON attendu.');
      if (Object.keys(body).some((k) => !['kind', 'personId', 'propertyId', 'inputs', 'mandateId'].includes(k))) return failure(400, 'unexpected_field', 'Seuls kind, personId, propertyId, inputs, mandateId sont admis.');
      const { kind, personId, propertyId, inputs, mandateId } = body;
      if (mandateId !== undefined && (typeof mandateId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(mandateId))) return failure(400, 'invalid_ids', 'mandateId mal formé.');
      if (typeof personId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(personId) || typeof propertyId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(propertyId)) {
        return failure(400, 'invalid_ids', 'personId et propertyId attendus.');
      }
      if (inputs !== undefined && (inputs === null || typeof inputs !== 'object' || Array.isArray(inputs))) return failure(400, 'invalid_inputs', 'inputs : un objet.');
      const r = await modeles(s).generate(viewer, { kind: kind as never, personId, propertyId, ...(inputs ? { inputs: inputs as never } : {}), ...(mandateId ? { mandateId } : {}) });
      if (r.ok) return json(200, { ok: true, mode: TRIAL_MODE, data: r.document });
      return r.rule === 'R16' ? refusal(r) : json(r.code === 'no_template' ? 409 : 400, { ok: false, rule: r.rule, code: r.code });
    },
  },
  {
    method: 'GET',
    pattern: new RegExp(`^/documents/${ID}$`),
    name: 'document',
    // Un document : celui qui voit la fiche en entier [R16].
    handle: async (s, viewer, [id]) => {
      const r = await modeles(s).read(viewer, id!);
      return r.ok ? json(200, { ok: true, mode: TRIAL_MODE, data: r.document }) : refusal(r);
    },
  },
  {
    method: 'POST',
    pattern: /^\/honoraires\/bareme$/,
    name: 'honoraires.bareme',
    // Le barème des honoraires du réseau : taux maximal du prix et minimum ; la direction seule, en ajout seul [R41].
    handle: async (s, viewer, _params, request) => {
      const body = await readJson(request);
      if (body === null) return failure(400, 'invalid_body', 'Corps JSON attendu.');
      if (Object.keys(body).some((k) => !['maxRatePercent', 'minEur'].includes(k))) return failure(400, 'unexpected_field', 'Seuls maxRatePercent et minEur sont admis.');
      const r = await controles(s).setFeeSchedule(viewer, { maxRatePercent: body.maxRatePercent as number, minEur: body.minEur as number });
      if (r.ok) return json(200, { ok: true, mode: TRIAL_MODE });
      return r.rule === 'R16' ? refusal(r) : json(400, { ok: false, code: r.code });
    },
  },
  {
    method: 'POST',
    pattern: new RegExp(`^/fiches/${ID}/identite$`),
    name: 'fiche.identite',
    // L'identité vérifiée : la nature de la pièce vue et quand ; jamais son numéro ni sa copie [R15, R41].
    handle: async (s, viewer, [id], request) => {
      const body = await readJson(request);
      if (body === null) return failure(400, 'invalid_body', 'Corps JSON attendu.');
      if (Object.keys(body).some((k) => !['piece', 'seenAt'].includes(k))) return failure(400, 'unexpected_field', 'Seuls piece et seenAt sont admis.');
      if (typeof body.seenAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{3})?)?Z$/.test(body.seenAt)) return failure(400, 'invalid_date', 'seenAt : un instant ISO en UTC.');
      const r = await controles(s).recordIdentity(viewer, id!, { piece: String(body.piece), seenAt: new Date(body.seenAt) });
      if (r.ok) return json(200, { ok: true, mode: TRIAL_MODE, data: { id: r.id } });
      return r.rule === 'R16' ? refusal(r) : json(400, { ok: false, code: r.code });
    },
  },
  {
    method: 'POST',
    pattern: new RegExp(`^/documents/${ID}/controle$`),
    name: 'document.controle',
    // Le contrôle avant signature, ligne par ligne ; un seul échec et le document ne se signe pas [R41].
    handle: async (s, viewer, [id]) => {
      const r = await controles(s).check(viewer, id!);
      if (r.ok) return json(200, { ok: true, mode: TRIAL_MODE, data: r.value });
      return r.rule === 'R16' ? refusal(r) : json(400, { ok: false, code: r.code });
    },
  },
  {
    method: 'POST',
    pattern: new RegExp(`^/documents/${ID}/signature-papier$`),
    name: 'document.signature_papier',
    // Un mandat signé sur papier : contrôlé à l'instant, rangé avec sa source, numéroté, exemplaire produit [R39, R41].
    handle: async (s, viewer, [id], request) => {
      const body = await readJson(request);
      if (body === null) return failure(400, 'invalid_body', 'Corps JSON attendu.');
      if (Object.keys(body).some((k) => !['signedAt', 'place', 'scanRef', 'source', 'sourceDetail'].includes(k))) return failure(400, 'unexpected_field', 'Seuls signedAt, place, scanRef, source, sourceDetail sont admis.');
      if (typeof body.signedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{3})?)?Z$/.test(body.signedAt)) return failure(400, 'invalid_date', 'signedAt : un instant ISO en UTC.');
      const r = await new SignaturePapier(s.db, s.acces, s.journal, { now: s.now }).register(viewer, id!, {
        signedAt: new Date(body.signedAt),
        place: body.place as never,
        scanRef: body.scanRef as string,
        source: typeof body.source === 'string' ? body.source : null,
        sourceDetail: typeof body.sourceDetail === 'string' ? body.sourceDetail : null,
      });
      if (r.ok) return json(200, { ok: true, mode: TRIAL_MODE, data: r.value });
      if (r.rule === 'R16') return refusal(r);
      return json(r.code === 'already_signed' ? 409 : 400, { ok: false, rule: r.rule, code: r.code, ...('check' in r ? { check: r.check } : {}) });
    },
  },
  {
    method: 'GET',
    pattern: new RegExp(`^/documents/${ID}/exemplaire$`),
    name: 'document.exemplaire',
    // L'exemplaire du mandant, avec son numéro au registre [R39] : qui voit la fiche en entier [R16].
    handle: async (s, viewer, [id]) => {
      const r = await new SignaturePapier(s.db, s.acces, s.journal, { now: s.now }).copy(viewer, id!);
      if (r.ok) return json(200, { ok: true, mode: TRIAL_MODE, data: { number: r.number, content: r.content } });
      return r.rule === 'R16' ? refusal(r) : json(404, { ok: false, code: r.code });
    },
  },
  {
    method: 'GET',
    pattern: new RegExp(`^/biens/${ID}/diffusion$`),
    name: 'bien.diffusion',
    // Le bien peut-il être diffusé : mandat signé, numéroté, en cours, hors délai de rétractation [R42].
    handle: async (s, viewer, [id]) => {
      const r = await new Diffusion(s.db, s.acces, s.journal, { now: s.now }).read(viewer, id!);
      return r.ok ? json(200, { ok: true, mode: TRIAL_MODE, data: r.value }) : refusal(r);
    },
  },
  {
    method: 'POST',
    pattern: new RegExp(`^/mandats/${ID}/debut-anticipe$`),
    name: 'mandat.debut_anticipe',
    // La demande écrite du vendeur de diffuser avant la fin du délai de rétractation, avec sa preuve [R42].
    handle: async (s, viewer, [id], request) => {
      const body = await readJson(request);
      if (body === null) return failure(400, 'invalid_body', 'Corps JSON attendu.');
      if (Object.keys(body).some((k) => !['proof', 'receivedAt'].includes(k))) return failure(400, 'unexpected_field', 'Seuls proof et receivedAt sont admis.');
      if (typeof body.receivedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{3})?)?Z$/.test(body.receivedAt)) return failure(400, 'invalid_date', 'receivedAt : un instant ISO en UTC.');
      const r = await new Diffusion(s.db, s.acces, s.journal, { now: s.now }).recordEarlyStart(viewer, id!, { proof: body.proof as string, receivedAt: new Date(body.receivedAt) });
      if (r.ok) return json(200, { ok: true, mode: TRIAL_MODE });
      return r.rule === 'R16' ? refusal(r) : json(r.code === 'unknown_mandate' ? 404 : r.code === 'already_recorded' ? 409 : 400, { ok: false, rule: r.rule, code: r.code });
    },
  },
  {
    method: 'POST',
    pattern: new RegExp(`^/mandats/${ID}/retractation$`),
    name: 'mandat.retractation',
    // La rétractation reçue dans le délai : le mandat s'arrête, son inscription est annulée [R42].
    handle: async (s, viewer, [id], request) => {
      const body = await readJson(request);
      if (body === null) return failure(400, 'invalid_body', 'Corps JSON attendu.');
      if (Object.keys(body).some((k) => !['proof', 'receivedAt'].includes(k))) return failure(400, 'unexpected_field', 'Seuls proof et receivedAt sont admis.');
      if (typeof body.receivedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{3})?)?Z$/.test(body.receivedAt)) return failure(400, 'invalid_date', 'receivedAt : un instant ISO en UTC.');
      const r = await new Diffusion(s.db, s.acces, s.journal, { now: s.now }).recordWithdrawal(viewer, id!, { proof: body.proof as string, receivedAt: new Date(body.receivedAt) });
      if (r.ok) return json(200, { ok: true, mode: TRIAL_MODE });
      return r.rule === 'R16' ? refusal(r) : json(r.code === 'unknown_mandate' ? 404 : r.code === 'already_recorded' ? 409 : 400, { ok: false, rule: r.rule, code: r.code });
    },
  },
  {
    method: 'GET',
    pattern: /^\/mandats\/echeances$/,
    name: 'mandats.echeances',
    // Les tâches d'échéance de l'agent lui-même : fin de mandat, fin de période exclusive [R16].
    handle: async (s, viewer) => {
      const r = await new EcheancesMandats(s.db, s.journal, { now: s.now }).list(viewer);
      return r.ok ? json(200, { ok: true, mode: TRIAL_MODE, data: r.tasks }) : refusal(r);
    },
  },
  {
    method: 'POST',
    pattern: new RegExp(`^/documents/${ID}/signature-avenant$`),
    name: 'document.signature_avenant',
    // Un avenant signé sur papier : contrôlé à l'instant, rangé avec son exemplaire ; le mandat change alors [R41].
    handle: async (s, viewer, [id], request) => {
      const body = await readJson(request);
      if (body === null) return failure(400, 'invalid_body', 'Corps JSON attendu.');
      if (Object.keys(body).some((k) => !['signedAt', 'place', 'scanRef'].includes(k))) return failure(400, 'unexpected_field', 'Seuls signedAt, place, scanRef sont admis.');
      if (typeof body.signedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{3})?)?Z$/.test(body.signedAt)) return failure(400, 'invalid_date', 'signedAt : un instant ISO en UTC.');
      const r = await new SignatureAvenant(s.db, s.acces, s.journal, { now: s.now }).register(viewer, id!, { signedAt: new Date(body.signedAt), place: body.place as never, scanRef: body.scanRef as string });
      if (r.ok) return json(200, { ok: true, mode: TRIAL_MODE, data: r.value });
      if (r.rule === 'R16') return refusal(r);
      return json(r.code === 'already_signed' ? 409 : 400, { ok: false, rule: r.rule, code: r.code, ...('check' in r ? { check: r.check } : {}) });
    },
  },
  {
    method: 'GET',
    pattern: new RegExp(`^/mandats/${ID}/conditions$`),
    name: 'mandat.conditions',
    // Les conditions en vigueur d'un mandat (prix, durée) et l'historique de ses avenants signés [R16].
    handle: async (s, viewer, [id]) => {
      const r = await new SignatureAvenant(s.db, s.acces, s.journal, { now: s.now }).terms(viewer, id!);
      if (r.ok) return json(200, { ok: true, mode: TRIAL_MODE, data: r.value });
      return r.rule === 'R16' ? refusal(r) : json(404, { ok: false, code: r.code });
    },
  },
  {
    method: 'GET',
    pattern: new RegExp(`^/mandats/${ID}/chronologie$`),
    name: 'mandat.chronologie',
    // La chronologie d'un mandat, de l'avis validé au numéro : la mesure du critère de M06 ; direction, conformité.
    handle: async (s, viewer, [id]) => {
      const r = await new ChronologieMandat(s.db, s.journal, { now: s.now }).read(viewer, id!);
      if (r.ok) return json(200, { ok: true, mode: TRIAL_MODE, data: r.value });
      return r.rule === 'R16' ? refusal(r) : json(404, { ok: false, code: r.code });
    },
  },
  {
    method: 'POST',
    pattern: new RegExp(`^/documents/${ID}/signature-en-ligne$`),
    name: 'document.signature_en_ligne',
    // Ouvre une session de signature en ligne, en essai : le code passe par le contrôle central et reste dans la boîte
    // d'essai tant que H05 n'est pas fait ; la signature ne rend jamais un mandat réel tant que H24 n'est pas fait [R41].
    handle: async (s, viewer, [id], request) => {
      const body = await readJson(request);
      if (body === null) return failure(400, 'invalid_body', 'Corps JSON attendu.');
      if (Object.keys(body).some((k) => k !== 'consentProof')) return failure(400, 'unexpected_field', 'Seul consentProof est admis.');
      const r = await new SignatureEnLigne(s.db, s.acces, s.journal, { now: s.now }).start(viewer, id!, { consentProof: typeof body.consentProof === 'string' ? body.consentProof : '' });
      if (r.ok) return json(200, { ok: true, mode: TRIAL_MODE, data: r.value });
      if (r.code !== 'send_refused' && r.rule === 'R16') return refusal({ rule: 'R16', code: r.code });
      return json(400, { ok: false, rule: r.rule, code: r.code, ...('check' in r ? { check: r.check } : {}) });
    },
  },
  {
    method: 'POST',
    pattern: new RegExp(`^/signatures/${ID}$`),
    name: 'signature.code',
    // La signature par le code reçu, et le tracé à l'écran s'il y en a un : toujours une signature d'essai.
    handle: async (s, viewer, [id], request) => {
      const body = await readJson(request, 220_000);
      if (body === null) return failure(400, 'invalid_body', 'Corps JSON attendu.');
      if (Object.keys(body).some((k) => !['code', 'drawing'].includes(k))) return failure(400, 'unexpected_field', 'Seuls code et drawing sont admis.');
      const r = await new SignatureEnLigne(s.db, s.acces, s.journal, { now: s.now }).sign(viewer, id!, {
        code: typeof body.code === 'string' ? body.code : '',
        drawing: typeof body.drawing === 'string' ? body.drawing : null,
      });
      if (r.ok) return json(200, { ok: true, mode: TRIAL_MODE, data: r.value });
      if (r.code !== 'send_refused' && r.rule === 'R16') return refusal({ rule: 'R16', code: r.code });
      return json(r.code === 'unknown_session' ? 404 : r.code === 'already_signed' || r.code === 'blocked' ? 409 : 400, { ok: false, code: r.code });
    },
  },
  {
    method: 'GET',
    pattern: new RegExp(`^/signatures/${ID}/exemplaire$`),
    name: 'signature.exemplaire',
    // L'exemplaire d'une signature en ligne d'essai, et s'il est parti au signataire [R16].
    handle: async (s, viewer, [id]) => {
      const r = await new SignatureEnLigne(s.db, s.acces, s.journal, { now: s.now }).copy(viewer, id!);
      if (r.ok) return json(200, { ok: true, mode: TRIAL_MODE, data: { content: r.content, sent: r.sent } });
      return r.rule === 'R16' ? refusal(r) : json(404, { ok: false, code: r.code });
    },
  },
  {
    method: 'POST',
    pattern: new RegExp(`^/signatures/${ID}/exemplaire$`),
    name: 'signature.exemplaire_envoi',
    // Reprend l'envoi de l'exemplaire refusé plus tôt (heure, exclusion…), par le contrôle central.
    handle: async (s, viewer, [id]) => {
      const sent = await new SignatureEnLigne(s.db, s.acces, s.journal, { now: s.now }).sendCopy(viewer, id!);
      return json(sent ? 200 : 409, { ok: sent, mode: TRIAL_MODE, sent });
    },
  },
  {
    method: 'GET',
    pattern: /^\/attribution\/regles$/,
    name: 'attribution.regles',
    // Les règles d'attribution, publiées, les mêmes pour tous [R25] : rien de personnel.
    handle: async () =>
      json(200, {
        ok: true,
        mode: TRIAL_MODE,
        data: {
          rules: ATTRIBUTION_RULES,
          callbackHours: { hot: DEFAULT_ATTRIBUTION_SETTINGS.hotCallbackHours, other: DEFAULT_ATTRIBUTION_SETTINGS.otherCallbackHours },
          communes: DEFAULT_ATTRIBUTION_SETTINGS.communes,
        },
      }),
  },
  {
    method: 'GET',
    pattern: /^\/journal\/verification$/,
    name: 'journal.verification',
    handle: verifyJournal,
  },
];

async function readJson(request: Request, max = MAX_BODY_BYTES): Promise<Record<string, unknown> | null> {
  if (!(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) return null;
  const text = await request.text();
  if (new TextEncoder().encode(text).length > max) return null;
  try {
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * La décision d'envoi, en mode essai : elle dit si un message pourrait partir et quelle règle a décidé.
 * Elle n'envoie rien et ne range aucun message. La fiche est lue sous droits d'accès [R16] et la décision
 * est écrite au journal avec sa règle [R13].
 */
async function sendDecision(s: Services, viewer: Viewer, _params: string[], request: Request): Promise<Response> {
  const body = await readJson(request);
  if (body === null) return failure(400, 'invalid_body', 'Corps JSON attendu.');
  const { personId, channel, kind, purpose, conversationId, at } = body;
  if (typeof personId !== 'string' || !new RegExp(`^${ID}$`).test(personId)) {
    return failure(400, 'invalid_person', 'personId manquant ou mal formé.');
  }
  if (typeof channel !== 'string' || !(CHANNELS as readonly string[]).includes(channel)) {
    return failure(400, 'invalid_channel', `channel attendu parmi : ${CHANNELS.join(', ')}.`);
  }
  if (typeof kind !== 'string' || !(SEND_KINDS as readonly string[]).includes(kind)) {
    return failure(400, 'invalid_kind', `kind attendu parmi : ${SEND_KINDS.join(', ')}.`);
  }
  if (purpose !== undefined && (typeof purpose !== 'string' || !/^[a-z_]{1,40}$/.test(purpose))) {
    return failure(400, 'invalid_purpose', 'purpose mal formé.');
  }
  if (conversationId !== undefined && conversationId !== null && (typeof conversationId !== 'string' || conversationId.length > 200)) {
    return failure(400, 'invalid_conversation', 'conversationId mal formé.');
  }
  const when = at === undefined ? s.now() : typeof at === 'string' ? new Date(at) : new Date(Number.NaN);
  if (Number.isNaN(when.getTime())) return failure(400, 'invalid_at', 'at doit être une date ISO.');

  const fiche = await s.acces.readFiche(viewer, personId);
  if (!fiche.ok) return refusal(fiche);

  const sendRequest: SendRequest = {
    channel: channel as Channel,
    kind: kind as SendKind,
    at: when,
    ...(purpose === undefined ? {} : { purpose }),
    ...(conversationId === undefined ? {} : { conversationId }),
  };
  const decision = await s.decision.decide(fiche.value.person.id, sendRequest);
  await appendEvent(
    s.journal,
    {
      type: 'envoi.decision.essai',
      actor: `${viewer.role}:${viewer.userId}`,
      subject: personSubject(fiche.value.person.id),
      data: {
        mode: TRIAL_MODE,
        allowed: decision.allowed,
        rule: decision.rule,
        checked: decision.checked,
        reason: decision.reason,
        channel,
        kind,
        at: when.toISOString(),
      },
    },
    s.now,
  );
  return json(200, { ok: true, mode: TRIAL_MODE, sent: false, data: decision });
}

/**
 * La correction du classement par l'agent : gardée telle quelle, elle rejoint les cas de mesure. Seul celui qui voit
 * la fiche en entier corrige [R16] ; la qualification d'origine reste [R17].
 */
async function correctQualification(s: Services, viewer: Viewer, [id]: string[], request: Request): Promise<Response> {
  const body = await readJson(request);
  if (body === null) return failure(400, 'invalid_body', 'Corps JSON attendu.');
  const { category, route } = body;
  if (typeof category !== 'string' || !(CATEGORIES as readonly string[]).includes(category)) {
    return failure(400, 'invalid_category', `category attendue parmi : ${CATEGORIES.join(', ')}.`);
  }
  if (route !== undefined && route !== null && (typeof route !== 'string' || !(NEXT_MODULES as readonly string[]).includes(route))) {
    return failure(400, 'invalid_route', `route attendue parmi : ${NEXT_MODULES.join(', ')}, ou null.`);
  }
  const row = await s.db.first<{ network_id: string }>('SELECT network_id FROM qualifications WHERE id = ?', [id!]);
  if (!row || row.network_id !== viewer.networkId) return json(404, { ok: false, rule: 'R16', code: 'unknown' });
  const done = await s.qualification.correct(s.acces, viewer, id!, category as (typeof CATEGORIES)[number], (route ?? null) as (typeof NEXT_MODULES)[number] | null);
  return done ? json(200, { ok: true, mode: TRIAL_MODE }) : json(403, { ok: false, rule: 'R16', code: 'not_assigned' });
}

/** Vérifie toute la chaîne du journal. Direction et conformité seulement [R16]. */
async function verifyJournal(s: Services, viewer: Viewer): Promise<Response> {
  const decision = decideAccess(viewer, { kind: 'journal', networkId: viewer.networkId });
  const actor = `${viewer.role}:${viewer.userId}`;
  if (!decision.allowed) {
    await appendEvent(s.journal, { type: 'acces.refuse', actor, subject: null, data: { rule: 'R16', role: viewer.role, kind: 'journal', code: decision.code } }, s.now);
    return refusal(decision);
  }
  const entries = await s.journal.all();
  const result = await verifyChain(entries);
  await appendEvent(s.journal, { type: 'journal.verifie', actor, subject: null, data: { rule: 'R16', ok: result.ok, lines: entries.length } }, s.now);
  return json(200, { ok: true, mode: TRIAL_MODE, data: { ...result, lines: entries.length } });
}

/**
 * Le formulaire « Être rappelé » du site, de bout en bout jusqu'à la réponse, en mode essai : la réponse est
 * prête et écrite au journal, jamais envoyée. Une clé de dépôt ne lit rien : elle ne rend que des statuts.
 */
async function intakeForm(request: Request, config: ApiConfig, now: () => Date): Promise<Response> {
  if (request.method !== 'POST') return failure(405, 'method_not_allowed', 'Méthode non admise.');
  const keys = parseIntakeKeys(config.intakeKeys);
  if (keys === null) return failure(503, 'keys_not_configured', 'Dépôt fermé : aucune clé configurée.');
  const intake = await intakeFromRequest(request, keys, 'site_form');
  if (intake === null) return failure(401, 'unauthorized', 'Clé absente ou refusée.');
  const body = await readJson(request);
  if (body === null) return failure(400, 'invalid_body', 'Corps JSON attendu.');
  const journal = new SqlJournalStore(config.db);
  try {
    const { chaine } = createCaptation(config.db, journal, { now });
    await chaine.receive(intake.networkId, 'site_form', body);
    // Rien de plus : le sort du formulaire (personne exclue, déjà connue…) ne regarde pas le déposant [R02, R16].
    return json(200, { ok: true, mode: TRIAL_MODE, sent: false, received: true });
  } catch (error) {
    await journalError(journal, 'intake:site_form', 'captation.formulaire', error, now);
    return failure(500, 'internal_error', 'Erreur interne, écrite au journal.');
  }
}

/** Une adresse plausible, sans la normaliser ici : la fiche le fait, et une adresse inconnue est simplement refusée. */
const MAX_EMAIL_LENGTH = 254;
const MAX_TEXT_LENGTH = 4_000;
const MAX_FIGURES = 30;

/**
 * Une automatisation du site demande si son envoi peut partir (B01), en mode essai : le socle décide par le contrôle
 * central et n'envoie rien [R26]. La clé `site_auto` ne lit aucune fiche : seule la décision et sa règle reviennent.
 */
async function automationSend(request: Request, config: ApiConfig, now: () => Date): Promise<Response> {
  if (request.method !== 'POST') return failure(405, 'method_not_allowed', 'Méthode non admise.');
  const keys = parseIntakeKeys(config.intakeKeys);
  if (keys === null) return failure(503, 'keys_not_configured', 'Demandes fermées : aucune clé configurée.');
  const intake = await intakeFromRequest(request, keys, 'site_auto');
  if (intake === null) return failure(401, 'unauthorized', 'Clé absente ou refusée.');
  const body = await readJson(request);
  if (body === null) return failure(400, 'invalid_body', 'Corps JSON attendu.');
  const { automation, email, ref, text, figures } = body;
  if (typeof automation !== 'string' || !(AUTOMATION_NAMES as readonly string[]).includes(automation)) {
    return failure(400, 'invalid_automation', `automation attendue parmi : ${AUTOMATION_NAMES.join(', ')}.`);
  }
  if (typeof email !== 'string' || email.length > MAX_EMAIL_LENGTH || !email.includes('@')) return failure(400, 'invalid_email', 'email manquant ou mal formé.');
  if (typeof ref !== 'string' || !REF_PATTERN.test(ref)) return failure(400, 'invalid_ref', 'ref manquante ou mal formée.');
  if (typeof text !== 'string' || text.trim() === '' || text.length > MAX_TEXT_LENGTH) return failure(400, 'invalid_text', 'text manquant ou trop long.');
  if (
    figures !== undefined &&
    (!Array.isArray(figures) ||
      figures.length > MAX_FIGURES ||
      !figures.every((f) => (typeof f === 'string' && f.length <= 40) || (typeof f === 'number' && Number.isFinite(f))))
  ) {
    return failure(400, 'invalid_figures', 'figures doit être une courte liste de nombres ou de textes courts.');
  }
  const journal = new SqlJournalStore(config.db);
  try {
    const decision = await new Automatisations(config.db, journal, { now }).request({
      networkId: intake.networkId,
      automation: automation as Automation,
      email,
      ref,
      text,
      ...(figures === undefined ? {} : { figures: figures as (string | number)[] }),
    });
    return json(200, { ok: true, mode: TRIAL_MODE, sent: false, data: { status: decision.status, rule: decision.rule, code: decision.code, reason: decision.reason } });
  } catch (error) {
    await journalError(journal, 'intake:site_auto', 'automatisations.envoi', error, now);
    return failure(500, 'internal_error', 'Erreur interne, écrite au journal.');
  }
}

/** Les routes de M10 avec le stockage des pièces ; sans lui, chacune répond 503, sans rien lire. */
function m10Routes(pieces: PieceStore | null): RouteDef[] {
  return dossierRoutes().map((r: DossierRoute) => ({
    ...r,
    handle: (s, viewer, params, request) => (pieces ? r.handle({ ...s, pieces }, viewer, params, request) : Promise.resolve(failure(503, 'pieces_not_configured', 'Dossiers fermés : aucun stockage des pièces.'))),
  }));
}

/** Jamais d'erreur avalée : une ligne au journal, sans le détail qui pourrait porter une donnée [R13]. */
export async function journalError(journal: JournalStore, actor: string, route: string, error: unknown, now: () => Date): Promise<void> {
  try {
    await appendEvent(journal, { type: 'api.erreur', actor, subject: null, data: { route, error: error instanceof Error ? error.name : 'unknown' } }, now);
  } catch {
    console.error('aimmo-api : erreur sans journal', route);
  }
}

/**
 * Le point d'entrée de l'API du socle. Tout passe ici : clé, droits, journal.
 * Lecture prudente : sans clé valable, sans configuration ou hors mode essai, rien n'est lu.
 */
export async function handleRequest(request: Request, config: ApiConfig): Promise<Response> {
  const now = config.now ?? (() => new Date());
  const url = new URL(request.url);
  // L'application de l'agent (A01) : une coquille sans aucune donnée, servie seulement en mode essai.
  const app = handleAgentApp(request);
  if (app) return config.mode === TRIAL_MODE ? app : failure(503, 'not_in_trial_mode', 'API fermée : seul le mode essai est admis.');
  // La désinscription des alertes (T03) : une page publique, sans clé, hors de /v1 pour que le lien n'ait aucun chiffre.
  if (url.pathname.startsWith(UNSUBSCRIBE_PATH)) {
    if (config.mode !== TRIAL_MODE) return failure(503, 'not_in_trial_mode', 'API fermée : seul le mode essai est admis.');
    try {
      const page = await handleUnsubscribe(request, { db: config.db, now });
      if (page) return page;
    } catch (error) {
      await journalError(new SqlJournalStore(config.db), 'public:desinscription', 'alertes.desinscription', error, now);
      return failure(500, 'internal_error', 'Erreur interne, écrite au journal.');
    }
  }
  // Les pages publiques de l'après-vente (F07) : désinscription des relances, note de satisfaction, carnet du propriétaire.
  if (url.pathname.startsWith(APRES_VENTE_PATH)) {
    if (config.mode !== TRIAL_MODE) return failure(503, 'not_in_trial_mode', 'API fermée : seul le mode essai est admis.');
    try {
      const page = await handleApresVentePublic(request, { db: config.db, now });
      if (page) return page;
    } catch (error) {
      await apresVentePublicError(config.db, error, now);
      return failure(500, 'internal_error', 'Erreur interne, écrite au journal.');
    }
  }
  // La vitrine des biens (P10) : la page publique, la fiche imprimable et les photos de la version publiée.
  if (url.pathname.startsWith('/biens/') || url.pathname.startsWith('/medias/')) {
    if (config.mode !== TRIAL_MODE) return failure(503, 'not_in_trial_mode', 'API fermée : seul le mode essai est admis.');
    try {
      const page = await handleVitrine(request, config.db, config.media, now);
      if (page) return page;
    } catch (error) {
      await journalError(new SqlJournalStore(config.db), 'public:vitrine', 'vitrine', error, now);
      return failure(500, 'internal_error', 'Erreur interne, écrite au journal.');
    }
  }
  if (!url.pathname.startsWith(`${API_PREFIX}/`)) return failure(404, 'not_found', 'Adresse inconnue.');
  const path = url.pathname.slice(API_PREFIX.length);

  if (config.mode !== TRIAL_MODE) return failure(503, 'not_in_trial_mode', 'API fermée : seul le mode essai est admis.');

  if (path === '/sante') {
    if (request.method !== 'GET') return failure(405, 'method_not_allowed', 'Méthode non admise.');
    return json(200, { ok: true, version: AIMMO_VERSION, mode: TRIAL_MODE });
  }

  if (path === '/captation/formulaire') return intakeForm(request, config, now);

  if (path === '/automatisations/envoi') return automationSend(request, config, now);

  if (path === ESTIMATION_PATH) {
    try {
      return await handleEstimation(request, {
        db: config.db,
        intakeKeys: config.intakeKeys,
        ...(config.estimation ? { services: config.estimation } : {}),
        ...(config.estimationLimits ? { limits: config.estimationLimits } : {}),
        now,
      });
    } catch (error) {
      await journalError(new SqlJournalStore(config.db), 'intake:site_estimate', 'estimation.commune', error, now);
      return failure(500, 'internal_error', 'Erreur interne, écrite au journal.');
    }
  }

  if (path === ASSISTANT_PATH || path.startsWith(`${ASSISTANT_PATH}/`)) {
    try {
      return await handleAssistant(request, path, {
        db: config.db,
        intakeKeys: config.intakeKeys,
        ...(config.assistantLimits ? { limits: config.assistantLimits } : {}),
        ...(config.writer ? { writer: config.writer } : {}),
        now,
      });
    } catch (error) {
      await journalError(new SqlJournalStore(config.db), 'intake:site_chat', 'assistant', error, now);
      return failure(500, 'internal_error', 'Erreur interne, écrite au journal.');
    }
  }

  if (path === BOOKING_SLOTS_PATH || path === BOOKING_PATH) {
    try {
      return await handleBooking(request, path, {
        db: config.db,
        intakeKeys: config.intakeKeys,
        ...(config.bookingLimits ? { limits: config.bookingLimits } : {}),
        linkBase: config.appointmentLinkBase ?? null,
        now,
      });
    } catch (error) {
      await journalError(new SqlJournalStore(config.db), 'intake:site_booking', 'rendez-vous', error, now);
      return failure(500, 'internal_error', 'Erreur interne, écrite au journal.');
    }
  }

  if (path === META_PATH) {
    const meta = config.meta ?? { appSecret: undefined, verifyTokenSha256: undefined, networkId: undefined, ownIds: undefined, appIds: undefined };
    return handleMeta(request, { ...meta, db: config.db, now });
  }

  // L'accès en un clic (Z02) : un jeton d'invitation, à usage unique, échangé contre des clés neuves.
  if (`/v1${path}` === INVITATION_PATH) {
    try {
      return await handleInvitation(request, config.db, now());
    } catch (error) {
      await journalError(new SqlJournalStore(config.db), 'public:invitation', 'acces.invitation', error, now);
      return failure(500, 'internal_error', 'Erreur interne, écrite au journal.');
    }
  }

  // Les clés du secret `API_KEYS`, et celles remises par une invitation (Z02). Un secret présent mais mal formé
  // ferme toute l'API, même s'il existe des clés d'invitation : lecture prudente.
  const secretKeys = config.apiKeys === undefined || config.apiKeys.trim() === '' ? [] : parseApiKeys(config.apiKeys);
  if (secretKeys === null) return failure(503, 'keys_not_configured', 'API fermée : aucune clé configurée.');
  const keys = mergeKeys(secretKeys, await invitedKeys(config.db));
  if (keys.length === 0) return failure(503, 'keys_not_configured', 'API fermée : aucune clé configurée.');
  const viewer = await viewerFromRequest(request, keys);
  if (viewer === null) return failure(401, 'unauthorized', 'Clé absente ou refusée.');

  // Une même adresse peut servir à lire (GET) et à écrire (POST) : la route est choisie par l'adresse et la méthode.
  // Les routes de M08 (T08) suivent celles du socle ; elles portent le lien de désinscription du réseau.
  // Puis celles de M07 (P10) : fiche, contrôle, annonce, publication ; puis celles de M09 (O09) : les offres ; puis
  // celles de M10 (N09) : les dossiers de vente, fermés sans le stockage des pièces ; puis celles de M11 (F07) ; puis
  // celles de M13 (K08) : le pilotage.
  const routes: RouteDef[] = [...ROUTES, ...m08Routes({ unsubscribeBase: config.alertUnsubscribeBase ?? null }), ...annonceRoutes(), ...offreRoutes(), ...m10Routes(config.pieces ?? null), ...apresVenteRoutes(), ...pilotageRoutes()];
  const matching = routes.filter((candidate) => candidate.pattern.test(path));
  if (matching.length === 0) return failure(404, 'not_found', 'Adresse inconnue.');
  const route = matching.find((candidate) => candidate.method === request.method);
  if (!route) return failure(405, 'method_not_allowed', 'Méthode non admise.');
  const params = (route.pattern.exec(path) ?? []).slice(1);

  const s = services(config.db, now);
  try {
    return await route.handle(s, viewer, params, request);
  } catch (error) {
    // Jamais d'erreur avalée : une ligne au journal, sans le détail qui pourrait porter une donnée [R13].
    try {
      await appendEvent(
        s.journal,
        { type: 'api.erreur', actor: `${viewer.role}:${viewer.userId}`, subject: null, data: { route: route.name, error: error instanceof Error ? error.name : 'unknown' } },
        now,
      );
    } catch {
      console.error('aimmo-api : erreur sans journal', route.name);
    }
    return failure(500, 'internal_error', 'Erreur interne, écrite au journal.');
  }
}
