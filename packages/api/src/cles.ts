/**
 * Les routes des clés d'accès par appareil et du second facteur (HX56), sous `/v1/cles`, et de l'export complet de
 * l'agent (HX62), sous `/v1/export` (BR05).
 *
 * Chaque route dit les rôles qu'elle admet ; un autre rôle est refusé et écrit au journal avant que le corps soit lu
 * [R16]. La couche métier refait ses contrôles derrière : la direction seule accepte une clé, sur la preuve de sa propre
 * clé ; chacun retire les siennes, la direction toute clé de son réseau [R600] ; une preuve ne vaut que pour son action,
 * son objet et cinq minutes, une fois [R601].
 *
 * Sans site WebAuthn réglé (`rpId` et origines), ces routes sont fermées : 503, rien n'est rangé.
 *
 * La connexion par une clé (BR06) : `/v1/cles/connexion/debut` et `/v1/cles/connexion/fin`, publiques, limitées en
 * débit par adresse et par réseau. Tout refus y a la même réponse, sans dire pourquoi ; la raison est au
 * journal. La séance rendue s'utilise comme une clé d'API (`Authorization: Bearer <jeton>`) et se relit à chaque
 * demande : une clé retirée ou un agent parti la coupent tout de suite [R600, R82].
 *
 * L'export complet n'est tiré que par l'agent actif lui-même, sur une preuve « export_complet » de sa clé faite pour
 * lui ; AIMMO ne range que l'empreinte, jamais le contenu [R561, R601, R13].
 *
 * La reprise des données de l'agence sous licence (HX74, BR17), sous `/v1/export/agence` : sa direction seule tire le
 * fichier complet de son réseau, sur une preuve « export_complet » pour `licence:<id>` ; la direction du réseau qui
 * donne les licences n'en a pas [R657, R658, R659, R601].
 *
 * Le dossier de la lutte contre le blanchiment de l'agence sous licence (HX76, BR113), sous `/v1/export/agence/lcb` :
 * son responsable de la conformité seul le tire, sur une preuve « export_complet » pour `licence_lcb:<id>`, et le
 * vérifie ; ni sa direction, ni le réseau qui donne les licences. AIMMO ne range que l'empreinte [R662, R663, R664, R601].
 *
 * Le contenu des fichiers de cette reprise (BR82), sous `/v1/export/agence/contenus` : sa direction seule, sur un
 * fichier de reprise qu'AIMMO lui a remis et une preuve « export_complet » par appel, reçoit les octets en base64, par
 * lots de 8 Mo au plus (la mémoire d'un Worker), et les plus grosses pièces tranche par tranche [R666, R667, R663]. Sans
 * compartiment de fichiers, ces routes sont fermées (503).
 */
import { SqlJournalStore, appendEvent, type JournalStore, type SqlDatabase, type Viewer } from '@aimmo/core';
import { invitableAgents, inviteAgent } from './acces.ts';
import { takeSlot } from './assistant.ts';
import { sha256Hex } from './auth.ts';
import { ContenusRepriseAgence, RepriseDonneesAgence, TRANCHE_OCTETS, type StockageFichiersPlages } from '../../core/src/licences/index.ts';
import { DossierLcbAgences } from '../../core/src/conformite/index.ts';
import { ExportAgent } from '../../core/src/rapports/index.ts';
import { ClesAppareil, ClesAssistant, type AssertionPayload, type RegistrationPayload } from '../../core/src/securite/index.ts';

export const TRIAL_MODE = 'essai';
const MAX_BODY_BYTES = 8_000;
/** Un fichier d'export à vérifier peut être gros : sa vérification seule a droit à un corps plus gros. */
const MAX_EXPORT_BYTES = 4_000_000;
const ID = '([A-Za-z0-9_-]{1,64})';

export interface ClesConfig {
  /** L'identifiant du site WebAuthn (le domaine de l'application), sans schéma. */
  rpId: string;
  /** Les origines admises, en https. */
  origins: readonly string[];
}

export interface ClesServices {
  db: SqlDatabase;
  journal: JournalStore;
  now: () => Date;
  /** Le site WebAuthn ; absent, les routes sont fermées. */
  site: ClesConfig | null;
  /** Les fichiers déposés (R2 : médias, pièces, commerces ; jamais le coffre) ; absents, les routes des contenus sont fermées (BR82). */
  fichiers?: StockageFichiersPlages | null;
}

/** Un lot remis par la route : une tranche au plus, pour que ses octets en base64 tiennent dans la mémoire d'un Worker (BR82). */
export const LOT_ROUTE_OCTETS = TRANCHE_OCTETS;

/** Des octets en base64, par morceaux : jamais une chaîne d'arguments trop longue. */
export function base64Of(bytes: Uint8Array): string {
  let out = '';
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) out += String.fromCharCode(...bytes.subarray(i, i + step));
  return btoa(out);
}

type Role = Viewer['role'];
const DEVICE_USERS: readonly Role[] = ['agent', 'direction', 'compliance'];
const DIRECTION: readonly Role[] = ['direction'];
const AGENT: readonly Role[] = ['agent'];
const COMPLIANCE: readonly Role[] = ['compliance'];

export interface ClesRoute {
  method: 'GET' | 'POST';
  pattern: RegExp;
  /** Nom de la route pour le journal : jamais l'identifiant demandé. */
  name: string;
  /** Les rôles admis : un autre est refusé avant toute lecture du corps [R16]. */
  roles: readonly Role[];
  handle: (s: ClesServices, viewer: Viewer, params: string[], request: Request) => Promise<Response>;
}

const HEADERS = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...HEADERS } });

/** Ce qui n'existe pas pour ce lecteur : 404, sans dire s'il existe ailleurs. */
const NOT_FOUND = new Set(['unknown', 'unknown_device', 'appareil_inconnu']);
/** Une règle de nombre, pas de droit : 409. */
const CONFLICT = new Set(['limite_atteinte']);

type Outcome = { ok: true; value?: unknown } | { ok: false; rule: string | null; code: string };

/** 200 ; 403 pour un refus de droits ; 404 introuvable ; 409 pour une règle ; 400 sinon. */
function reply(result: Outcome): Response {
  if (result.ok) return json(200, { ok: true, mode: TRIAL_MODE, data: result.value ?? null });
  const { rule, code } = result;
  if (rule === 'R16') return json(NOT_FOUND.has(code) ? 404 : 403, { ok: false, rule, code });
  if (NOT_FOUND.has(code)) return json(404, { ok: false, rule, code });
  return json(rule || CONFLICT.has(code) ? 409 : 400, { ok: false, rule, code });
}

async function readJson(request: Request, max = MAX_BODY_BYTES): Promise<Record<string, unknown> | null> {
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

const badBody = (): Response => json(400, { ok: false, rule: null, code: 'invalid_body', message: 'Corps JSON attendu.' });
const unknownField = (): Response => json(400, { ok: false, rule: null, code: 'unknown_field' });

type Handler = (s: ClesServices & { site: ClesConfig }, v: Viewer, params: string[], body: Record<string, unknown>) => Promise<Response>;
/** Un corps JSON qui ne porte que les clés prévues ; une autre est refusée sans rien ranger. */
const withBody =
  (keys: readonly string[], fn: Handler, max = MAX_BODY_BYTES): ClesRoute['handle'] =>
  async (s, v, params, request) => {
    const body = await readJson(request, max);
    if (!body) return badBody();
    if (Object.keys(body).some((k) => !keys.includes(k))) return unknownField();
    return fn(s as ClesServices & { site: ClesConfig }, v, params, body);
  };

const cles = (s: ClesServices & { site: ClesConfig }) => new ClesAppareil(s.db, s.journal, { rpId: s.site.rpId, origins: s.site.origins, now: s.now });
const assistant = (s: ClesServices & { site: ClesConfig }) => new ClesAssistant(s.db, s.journal, cles(s), { now: s.now });
const AGENT_OR_DIRECTION: readonly Role[] = ['agent', 'direction'];
/** Le contenu des fichiers de la reprise, sur les seuls compartiments donnés ; sans eux, `null` (BR82). */
const contenus = (s: ClesServices & { site: ClesConfig }) =>
  s.fichiers ? new ContenusRepriseAgence(s.db, s.journal, cles(s), s.fichiers, { now: s.now, maxBytes: LOT_ROUTE_OCTETS }) : null;
const closedFiles = (): Response => json(503, { ok: false, rule: null, code: 'fichiers_non_branches', message: 'Aucun stockage des fichiers branché.' });

const REGISTRATION = ['challengeId', 'credentialId', 'publicKey', 'clientDataJSON', 'authenticatorData', 'label', 'stepUpId'] as const;
const ASSERTION = ['challengeId', 'credentialId', 'clientDataJSON', 'authenticatorData', 'signature'] as const;

/** Les routes de `/v1/cles` et `/v1/export`, à ajouter à celles de `app.ts`. */
export function clesRoutes(): ClesRoute[] {
  const P = '^/cles';
  const routes: ClesRoute[] = [
    // Enregistrer la clé de cet appareil [R600].
    {
      method: 'POST',
      pattern: new RegExp(`${P}/enregistrement/debut$`),
      name: 'cles.enregistrement.debut',
      roles: DEVICE_USERS,
      handle: async (s, v) => reply(await cles(s as ClesServices & { site: ClesConfig }).beginRegistration(v)),
    },
    {
      method: 'POST',
      pattern: new RegExp(`${P}/enregistrement/fin$`),
      name: 'cles.enregistrement.fin',
      roles: DEVICE_USERS,
      handle: withBody(REGISTRATION, async (s, v, _p, b) => reply(await cles(s).finishRegistration(v, b as unknown as RegistrationPayload))),
    },
    // Ses propres clés, pour chacun (BR18) : sans clé publique ni identifiant de clé [R600].
    {
      method: 'GET',
      pattern: new RegExp(`${P}/mes-appareils$`),
      name: 'cles.mes_appareils',
      roles: DEVICE_USERS,
      handle: async (s, v) => reply(await cles(s as ClesServices & { site: ClesConfig }).listOwnDevices(v)),
    },
    // Les clés du réseau, pour la direction ; l'accord d'une clé en attente, sur la preuve de sa propre clé [R600, R601].
    {
      method: 'GET',
      pattern: new RegExp(`${P}/appareils$`),
      name: 'cles.appareils',
      roles: DIRECTION,
      handle: async (s, v) => reply(await cles(s as ClesServices & { site: ClesConfig }).listDevices(v)),
    },
    {
      method: 'POST',
      pattern: new RegExp(`${P}/appareils/${ID}/accord$`),
      name: 'cles.appareils.accord',
      roles: DIRECTION,
      handle: withBody(['stepUpId'], async (s, v, [id], b) => reply(await cles(s).approveDevice(v, id, b.stepUpId))),
    },
    // Retirer une clé, d'un geste, sans second facteur : c'est un geste qui protège [R600].
    {
      method: 'POST',
      pattern: new RegExp(`${P}/appareils/${ID}/retrait$`),
      name: 'cles.appareils.retrait',
      roles: DEVICE_USERS,
      handle: async (s, v, [id]) => reply(await cles(s as ClesServices & { site: ClesConfig }).revokeDevice(v, id)),
    },
    // AU023 · Qui je suis, pour que l'appareil se souvienne à qui proposer sa clé à la connexion : rien de secret.
    {
      method: 'GET',
      pattern: new RegExp(`${P}/identite$`),
      name: 'cles.identite',
      roles: DEVICE_USERS,
      handle: async (_s, v) => reply({ ok: true, value: { networkId: v.networkId, role: v.role, userId: v.userId } }),
    },
    // AU023 · La direction invite un agent de son réseau sur un nouvel appareil, par un lien nominatif à usage unique,
    // sur la preuve de sa propre clé ; appareil perdu : les anciens accès de l'agent sont retirés d'abord [R600, R601, R13].
    {
      method: 'GET',
      pattern: new RegExp(`${P}/invitations/agents$`),
      name: 'cles.invitations.agents',
      roles: DIRECTION,
      handle: async (s, v) => reply(await invitableAgents(s.db, v)),
    },
    {
      method: 'POST',
      pattern: new RegExp(`${P}/invitations$`),
      name: 'cles.invitations',
      roles: DIRECTION,
      handle: withBody(['userId', 'stepUpId', 'retirerAnciens'], async (s, v, _p, b) => {
        const service = cles(s);
        return reply(
          await inviteAgent(
            s.db,
            s.journal,
            v,
            b,
            async (subject, stepUpId) => {
              const r = await service.requireSecondFactor(v, 'modifier_droits', subject, stepUpId);
              return r.ok ? { ok: true } : r;
            },
            async (deviceId) => (await service.revokeDevice(v, deviceId)).ok,
            s.now(),
          ),
        );
      }),
    },
    // La preuve d'une action sensible précise, sur un objet précis [R601].
    {
      method: 'POST',
      pattern: new RegExp(`${P}/preuve/debut$`),
      name: 'cles.preuve.debut',
      roles: DEVICE_USERS,
      handle: withBody(['action', 'subject'], async (s, v, _p, b) => reply(await cles(s).beginStepUp(v, b.action, b.subject))),
    },
    {
      method: 'POST',
      pattern: new RegExp(`${P}/preuve/fin$`),
      name: 'cles.preuve.fin',
      roles: DEVICE_USERS,
      handle: withBody(ASSERTION, async (s, v, _p, b) => reply(await cles(s).finishStepUp(v, b as unknown as AssertionPayload))),
    },
    // La clé de l'assistant de l'agent (BR09) : créée depuis l'application seule, sur la preuve de sa clé d'appareil,
    // rendue une fois ; seule l'empreinte est rangée [R601, R590, R13]. Lue sans empreinte ; retirée d'un geste [R600].
    {
      method: 'GET',
      pattern: new RegExp(`${P}/assistant$`),
      name: 'cles.assistant',
      roles: AGENT,
      handle: async (s, v) => reply(await assistant(s as ClesServices & { site: ClesConfig }).listOwn(v)),
    },
    {
      method: 'POST',
      pattern: new RegExp(`${P}/assistant$`),
      name: 'cles.assistant.creation',
      roles: AGENT,
      handle: async (s, v, params, request) => {
        // Une clé d'API, qu'un assistant peut tenir, ne fabrique pas de clé : la séance d'une clé d'appareil seule [R601].
        if (!fromDeviceSession(request)) {
          await appendEvent(s.journal, { type: 'acces.refuse', actor: `${String(v.role)}:${v.userId}`, subject: `network:${v.networkId}`, data: { rule: 'R601', role: String(v.role), kind: 'cles.assistant.creation', code: 'application_requise' } }, s.now);
          return json(403, { ok: false, rule: 'R601', code: 'application_requise', message: 'Depuis l’application seulement, avec la clé de cet appareil.' });
        }
        return withBody(['stepUpId', 'label'], async (s2, v2, _p, b) => {
          const made = await assistant(s2).create(v2, b.stepUpId, b.label);
          if (!made.ok) return reply(made);
          const { key, ...rest } = made.value;
          return reply({ ok: true, value: { ...rest, cle: key } });
        })(s, v, params, request);
      },
    },
    {
      method: 'POST',
      pattern: new RegExp(`${P}/assistant/${ID}/retrait$`),
      name: 'cles.assistant.retrait',
      roles: AGENT_OR_DIRECTION,
      handle: async (s, v, [id]) => reply(await assistant(s as ClesServices & { site: ClesConfig }).revoke(v, id)),
    },
    // L'export complet de l'agent, sur sa preuve « export_complet » ; l'empreinte seule est rangée [R561, R601].
    {
      method: 'POST',
      pattern: /^\/export\/agent$/,
      name: 'export.agent',
      roles: AGENT,
      // AU110 · avec l'autorisation de reprise de la direction, l'export porte aussi ses clients et, s'il le dit, ses pièces.
      handle: withBody(['stepUpId', 'authorizationId'], async (s, v, _p, b) =>
        reply(await new ExportAgent(s.db, s.journal, cles(s), { now: s.now }).make(v, b.stepUpId, typeof b.authorizationId === 'string' ? { authorizationId: b.authorizationId } : {})),
      ),
    },
    // AU110 · la direction autorise l'export de reprise d'un agent, au vu d'un contrat : périmètre, contrat, durée [R16].
    {
      method: 'POST',
      pattern: new RegExp(`^/export/agents/${ID}/autorisation$`),
      name: 'export.agent.autorisation',
      roles: DIRECTION,
      handle: withBody(['scope', 'contractRef', 'days'], async (s, v, [id], b) => reply(await new ExportAgent(s.db, s.journal, cles(s), { now: s.now }).authorize(v, id!, { scope: b.scope, contractRef: b.contractRef, ...(b.days !== undefined ? { days: b.days } : {}) }))),
    },
    // Vérifier un fichier d'export : son empreinte recalculée est-elle celle qu'AIMMO a rangée ? Rien n'est gardé [R561].
    {
      method: 'POST',
      pattern: /^\/export\/agent\/verification$/,
      name: 'export.agent.verification',
      roles: DEVICE_USERS,
      handle: withBody(
        ['document'],
        async (s, v, _p, b) => {
          // Un fichier d'un autre réseau ne se vérifie pas d'ici : rien n'est lu.
          const doc = b.document;
          const sameNetwork = doc !== null && typeof doc === 'object' && (doc as { networkId?: unknown }).networkId === v.networkId;
          if (!sameNetwork) return reply({ ok: true, value: { verified: false, fingerprint: null } });
          return reply({ ok: true, value: await new ExportAgent(s.db, s.journal, cles(s), { now: s.now }).verify(doc) });
        },
        MAX_EXPORT_BYTES,
      ),
    },
    // La reprise des données de l'agence sous licence, sur sa preuve « export_complet » pour `licence:<id>` ; l'empreinte
    // et les comptes seuls sont rangés [R657, R658, R659, R601].
    {
      method: 'POST',
      pattern: /^\/export\/agence$/,
      name: 'export.agence',
      roles: DIRECTION,
      handle: withBody(['stepUpId'], async (s, v, _p, b) => reply(await new RepriseDonneesAgence(s.db, s.journal, cles(s), { now: s.now }).make(v, b.stepUpId))),
    },
    // Vérifier un fichier de reprise : est-il celui qu'AIMMO a remis, et couvre-t-il chaque table d'aujourd'hui ? Rien
    // n'est gardé ; un fichier d'un autre réseau n'est pas lu [R659].
    {
      method: 'POST',
      pattern: /^\/export\/agence\/verification$/,
      name: 'export.agence.verification',
      roles: DIRECTION,
      handle: withBody(
        ['document'],
        async (s, v, _p, b) => {
          const doc = b.document;
          const sameNetwork = doc !== null && typeof doc === 'object' && (doc as { networkId?: unknown }).networkId === v.networkId;
          if (!sameNetwork) return reply({ ok: true, value: { verified: false, fingerprint: null, complete: false, missing: [] } });
          return reply({ ok: true, value: await new RepriseDonneesAgence(s.db, s.journal, cles(s), { now: s.now }).verify(doc) });
        },
        MAX_EXPORT_BYTES,
      ),
    },
    // La licence de l'agence, que la preuve du dossier désigne (BR114) ; rien d'autre [R662, R16].
    {
      method: 'GET',
      pattern: /^\/export\/agence\/lcb$/,
      name: 'export.agence.lcb.licence',
      roles: COMPLIANCE,
      handle: async (s, v) => reply(await new DossierLcbAgences(s.db, s.journal, cles(s as ClesServices & { site: ClesConfig }), { now: s.now }).licence(v)),
    },
    // Le dossier de la lutte contre le blanchiment de l'agence sous licence, pour son responsable de la conformité seul,
    // sur sa preuve « export_complet » pour `licence_lcb:<id>` ; l'empreinte seule est rangée [R662, R663, R664, R601].
    {
      method: 'POST',
      pattern: /^\/export\/agence\/lcb$/,
      name: 'export.agence.lcb',
      roles: COMPLIANCE,
      handle: withBody(['stepUpId'], async (s, v, _p, b) => reply(await new DossierLcbAgences(s.db, s.journal, cles(s), { now: s.now }).make(v, b.stepUpId))),
    },
    // Vérifier un dossier : est-il celui qu'AIMMO a remis, couvre-t-il chaque table du traitement, sa liste des pièces
    // est-elle entière ? Rien n'est gardé ; d'un dossier d'un autre réseau, rien n'est dit [R664, R662].
    {
      method: 'POST',
      pattern: /^\/export\/agence\/lcb\/verification$/,
      name: 'export.agence.lcb.verification',
      roles: COMPLIANCE,
      handle: withBody(['document'], async (s, v, _p, b) => reply(await new DossierLcbAgences(s.db, s.journal, cles(s), { now: s.now }).verify(v, b.document)), MAX_EXPORT_BYTES),
    },
    // Le contenu des fichiers de la reprise : un lot, l'empreinte d'une pièce en tranches, une tranche ; une preuve par
    // appel, jamais de référence ni de contenu au journal [R666, R667, R663, R601, R13].
    {
      method: 'POST',
      pattern: /^\/export\/agence\/contenus$/,
      name: 'export.agence.contenus',
      roles: DIRECTION,
      handle: withBody(
        ['document', 'stepUpId', 'depuis'],
        async (s, v, _p, b) => {
          const c = contenus(s);
          if (!c) return closedFiles();
          const r = await c.remettre(v, b.document, b.stepUpId, b.depuis ?? 0);
          if (!r.ok) return reply(r);
          return reply({ ok: true, value: { ...r.value, pieces: r.value.pieces.map((p) => ({ ...p, contenu: p.contenu === null ? null : base64Of(p.contenu) })) } });
        },
        MAX_EXPORT_BYTES,
      ),
    },
    {
      method: 'POST',
      pattern: /^\/export\/agence\/contenus\/piece$/,
      name: 'export.agence.contenus.piece',
      roles: DIRECTION,
      handle: withBody(
        ['document', 'stepUpId', 'index'],
        async (s, v, _p, b) => {
          const c = contenus(s);
          if (!c) return closedFiles();
          return reply(await c.empreintePiece(v, b.document, b.stepUpId, b.index));
        },
        MAX_EXPORT_BYTES,
      ),
    },
    {
      method: 'POST',
      pattern: /^\/export\/agence\/contenus\/tranche$/,
      name: 'export.agence.contenus.tranche',
      roles: DIRECTION,
      handle: withBody(
        ['document', 'stepUpId', 'index', 'debut', 'attendue'],
        async (s, v, _p, b) => {
          const c = contenus(s);
          if (!c) return closedFiles();
          const r = await c.remettreTranche(v, b.document, b.stepUpId, b.index, b.debut, b.attendue);
          if (!r.ok) return reply(r);
          return reply({ ok: true, value: { ...r.value, contenu: r.value.contenu === null ? null : base64Of(r.value.contenu) } });
        },
        MAX_EXPORT_BYTES,
      ),
    },
  ];
  return routes.map((route) => ({
    ...route,
    handle: async (s, v, params, request) => {
      if (!route.roles.includes(v.role)) {
        await appendEvent(s.journal, { type: 'acces.refuse', actor: `${String(v.role)}:${v.userId}`, subject: `network:${v.networkId}`, data: { rule: 'R16', role: String(v.role), kind: route.name, code: 'role' } }, s.now);
        return json(403, { ok: false, rule: 'R16', code: 'role' });
      }
      if (!s.site) return json(503, { ok: false, rule: null, code: 'cles_non_configurees', message: 'Clés d’accès fermées : aucun site WebAuthn réglé.' });
      return route.handle(s, v, params, request);
    },
  }));
}

/**
 * Lit le réglage du site WebAuthn depuis les variables du Worker : `CLES_RP_ID` (le domaine, sans schéma) et
 * `CLES_ORIGINS` (les origines en https, séparées par des virgules). Un réglage absent ou refusé par `ClesAppareil`
 * ferme les routes, sans jamais deviner.
 */
export function readClesConfig(rpId: string | undefined, origins: string | undefined): ClesConfig | null {
  if (!rpId || !origins) return null;
  const list = origins
    .split(',')
    .map((o) => o.trim())
    .filter((o) => o !== '');
  try {
    new ClesAppareil({} as SqlDatabase, {} as JournalStore, { rpId, origins: list });
  } catch {
    return null;
  }
  return { rpId, origins: list };
}

// ---------------------------------------------------------------- connexion par une clé (BR06)

export const CONNEXION_DEBUT_PATH = '/v1/cles/connexion/debut';
export const CONNEXION_FIN_PATH = '/v1/cles/connexion/fin';

/**
 * Les limites d'appels de la connexion, par heure. L'adresse d'abord ; le réseau ne compte que les défis émis, qu'un
 * utilisateur inventé ne remplit pas. Pas de limite par utilisateur : n'importe qui pourrait la remplir au nom d'un agent et l'empêcher d'entrer ; un
 * défi ne sert qu'une fois et ne se signe qu'avec la clé, rien ne se devine en le redemandant.
 */
export interface ConnexionLimits {
  /** Demandes d'une même adresse (`cf-connecting-ip`), début et fin ensemble. */
  perIp: number;
  /** Défis émis pour un même réseau (utilisateur actif avec une clé active). */
  perNetwork: number;
}
export const DEFAULT_CONNEXION_LIMITS: ConnexionLimits = Object.freeze({ perIp: 30, perNetwork: 2000 });

export interface ConnexionServices {
  db: SqlDatabase;
  now: () => Date;
  site: ClesConfig | null;
  limits?: ConnexionLimits;
}

const NETWORK_ID = /^[A-Za-z0-9_-]{1,64}$/;
/** Un seul refus, quelle qu'en soit la raison : ni l'utilisateur, ni la clé, ni le défi ne se devinent d'ici. */
const refusedLogin = (): Response => json(403, { ok: false, rule: 'R600', code: 'connexion_refusee' });
const tooMany = (): Response => json(429, { ok: false, rule: null, code: 'too_many_requests', message: 'Trop de demandes : réessayez plus tard.' });

/** Prend une place à l'adresse ; l'adresse n'est rangée qu'en empreinte d'une heure. Sans adresse connue, rien. */
async function ipSlot(s: ConnexionServices, request: Request, networkId: string): Promise<boolean> {
  const ip = request.headers.get('cf-connecting-ip');
  if (!ip) return true;
  const at = s.now();
  return takeSlot(s.db, networkId, `cles_connexion_adresse:${await sha256Hex(`${ip}:${at.toISOString().slice(0, 13)}`)}`, (s.limits ?? DEFAULT_CONNEXION_LIMITS).perIp, at);
}

/** Le réseau a-t-il encore de la place cette heure ? Lu avant d'émettre, pour qu'un réseau plein ne range plus aucun défi. */
async function networkHasRoom(s: ConnexionServices, networkId: string): Promise<boolean> {
  const at = s.now();
  const row = await s.db.first<{ n: number }>('SELECT count(*) AS n FROM assistant_calls WHERE network_id = ? AND scope = ? AND bucket = ?', [networkId, 'cles_connexion:reseau', at.toISOString().slice(0, 13)]);
  return Number(row?.n ?? 0) < (s.limits ?? DEFAULT_CONNEXION_LIMITS).perNetwork;
}

/** Prend une place au réseau, pour un défi vraiment émis : un utilisateur inventé n'en prend aucune. */
const networkSlot = (s: ConnexionServices, networkId: string): Promise<boolean> =>
  takeSlot(s.db, networkId, 'cles_connexion:reseau', (s.limits ?? DEFAULT_CONNEXION_LIMITS).perNetwork, s.now());

/** Un refus que la couche métier n'écrit pas elle-même (rôle ou identifiant mal formé), après la limite de l'adresse [R600, R16]. */
async function journalRefusal(s: ConnexionServices, code: string): Promise<Response> {
  await appendEvent(new SqlJournalStore(s.db), { type: 'securite.refus', actor: 'public:connexion', subject: null, data: { rule: 'R600', step: 'debut', code } }, s.now);
  return refusedLogin();
}

const ROLE_OF_DEVICE = new Set<string>(DEVICE_USERS);
const USER_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** Les deux routes publiques de la connexion ; `null` si l'adresse n'en est pas une. */
export async function handleConnexion(request: Request, s: ConnexionServices): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  if (path !== CONNEXION_DEBUT_PATH && path !== CONNEXION_FIN_PATH) return null;
  if (request.method !== 'POST') return json(405, { ok: false, rule: null, code: 'method_not_allowed' });
  if (!s.site) return json(503, { ok: false, rule: null, code: 'cles_non_configurees', message: 'Clés d’accès fermées : aucun site WebAuthn réglé.' });
  const body = await readJson(request);
  if (!body) return badBody();
  const service = new ClesAppareil(s.db, new SqlJournalStore(s.db), { rpId: s.site.rpId, origins: s.site.origins, now: s.now });

  if (path === CONNEXION_DEBUT_PATH) {
    if (Object.keys(body).some((k) => !['networkId', 'role', 'userId'].includes(k))) return unknownField();
    const { networkId, role, userId } = body;
    // Un réseau inconnu ne concerne personne : refusé sans rien écrire, pour qu'aucune boucle ne remplisse le journal.
    if (typeof networkId !== 'string' || !NETWORK_ID.test(networkId) || !(await s.db.first('SELECT 1 FROM networks WHERE id = ?', [networkId]))) return refusedLogin();
    if (!(await ipSlot(s, request, networkId))) return tooMany();
    if (typeof role !== 'string' || !ROLE_OF_DEVICE.has(role) || typeof userId !== 'string' || !USER_ID.test(userId)) return journalRefusal(s, 'bad_input');
    if (!(await networkHasRoom(s, networkId))) return tooMany();
    const challenge = await service.beginLogin(networkId, role, userId);
    if (!challenge.ok) return refusedLogin();
    // Le défi émis compte au réseau ; plein, il n'est pas rendu et expire sans servir.
    if (!(await networkSlot(s, networkId))) return tooMany();
    return json(200, { ok: true, mode: TRIAL_MODE, data: challenge.value });
  }

  if (Object.keys(body).some((k) => !(ASSERTION as readonly string[]).includes(k))) return unknownField();
  // Le réseau est celui du défi, lu dans la base : jamais celui qu'annonce l'appelant. Un défi inconnu ne concerne
  // personne : refusé sans rien écrire. Les défis connus sont bornés par ceux émis, déjà comptés au réseau.
  const { challengeId } = body;
  const owner =
    typeof challengeId === 'string' && USER_ID.test(challengeId)
      ? await s.db.first<{ network_id: string }>("SELECT network_id FROM security_challenges WHERE id = ? AND purpose = 'login'", [challengeId])
      : null;
  if (!owner) return refusedLogin();
  if (!(await ipSlot(s, request, owner.network_id))) return tooMany();
  const session = await service.finishLogin(body as unknown as AssertionPayload);
  if (!session.ok) return refusedLogin();
  const { token, expiresAt, viewer, deviceId } = session.value;
  return json(200, { ok: true, mode: TRIAL_MODE, data: { token, expiresAt, viewer, deviceId } });
}

/**
 * Qui tient la séance de la requête (`Authorization: Bearer <jeton>`), relu dans la base à cet instant : `null` si la
 * séance est inconnue ou finie, si sa clé a été retirée, ou si l'agent est parti [R600, R82].
 */
export async function sessionViewer(request: Request, s: { db: SqlDatabase; now: () => Date; site: ClesConfig }): Promise<Viewer | null> {
  const token = /^Bearer ([^\s]+)$/.exec(request.headers.get('authorization') ?? '')?.[1];
  if (token === undefined) return null;
  const found = await new ClesAppareil(s.db, new SqlJournalStore(s.db), { rpId: s.site.rpId, origins: s.site.origins, now: s.now }).authenticate(token);
  return found === null ? null : found.viewer;
}

/** Les demandes ouvertes par la séance d'une clé d'appareil (BR06), marquées par le socle après l'authentification. */
const DEVICE_SESSIONS = new WeakSet<Request>();
export function markDeviceSession(request: Request): void {
  DEVICE_SESSIONS.add(request);
}
/** Vrai si la demande vient de l'application, par une clé d'appareil, et non d'une clé d'API qu'un assistant peut tenir. */
export function fromDeviceSession(request: Request): boolean {
  return DEVICE_SESSIONS.has(request);
}
