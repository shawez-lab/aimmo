/**
 * Les routes de M16 Commerces et entreprises (CE09), sous `/v1/commerces` : fiche, estimation, présentation anonyme,
 * demandes d'accès et engagement de confidentialité, dossier protégé, repreneurs, cession et sa vigilance.
 *
 * Chaque route dit les rôles qu'elle admet ; un autre rôle est refusé et écrit au journal avant que le corps de la
 * requête soit lu [R16]. Les droits fins (agent du bien, fiches lisibles en entier) restent ceux de la couche métier,
 * qui écrit aussi ses refus au journal.
 *
 * Aucune route ne rend un champ confidentiel hors de la porte de CE04 [R110, R113] : la vue publique, la fourchette
 * validée et la présentation contrôlée seulement ; la fiche complète à qui voit le bien en entier ; le dossier au seul
 * lecteur qui passe la porte et son code. Les deux routes du lecteur (`dossierReaderRoutes`) ne prennent aucun compte :
 * le jeton du lien, l'adresse et le code reçu font foi, et chaque ouverture ou refus est journalisé [R114].
 *
 * Rien n'est envoyé d'ici : codes et liens passent par le contrôle central, en mode essai [R26]. Les routes sont prêtes
 * pour le routeur du socle, qui les branchera dans CE10 : ce fichier ne touche à aucun fichier du socle.
 */
import { Acces, FicheClient, FicheUnique, appendEvent, type JournalStore, type SqlDatabase, type Viewer } from '@aimmo/core';
import {
  CessionCommerce,
  TachesBail,
  ConfidentialiteCommerce,
  DossierCommerce,
  EstimationCommerce,
  FicheCommerce,
  PresentationCommerce,
  RepreneursCommerce,
  VigilanceCession,
  type BusinessDiffusionGate,
  type DossierStorage,
  type IdentityState,
  type PresentationWriter,
  type VaultDeposits,
} from '../../core/src/commerces/index.ts';

export const TRIAL_MODE = 'essai';
/** Un texte à tracer peut être long ; tout autre corps tient largement dans cette borne. */
export const MAX_COMMERCES_BODY_BYTES = 2 * 1024 * 1024;
const ID = '([A-Za-z0-9_-]{1,64})';
const TOKEN = '([a-z]{20,80})';

/** Ce que le dépôt lit et écrit du compartiment des dossiers protégés (R2) : du texte, le dossier n'en sert pas d'autre [R114]. */
export interface R2DossierBucket {
  put(key: string, value: string, options?: { httpMetadata?: { contentType?: string } }): Promise<unknown>;
  get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>;
}

/** Le stockage réel des documents du dossier (H38) : un texte par référence, ou rien. */
export class R2DossierStorage implements DossierStorage {
  constructor(private readonly bucket: R2DossierBucket) {}
  async read(ref: string): Promise<string | null> {
    const object = await this.bucket.get(ref);
    // `text()` de R2 retirerait une marque d'ordre en tête : le texte relu ne serait plus celui déposé, ni son empreinte.
    return object ? new TextDecoder('utf-8', { ignoreBOM: true }).decode(await object.arrayBuffer()) : null;
  }
  async write(ref: string, content: string): Promise<void> {
    await this.bucket.put(ref, content, { httpMetadata: { contentType: 'text/plain; charset=utf-8' } });
  }
}

export interface CommercesServices {
  db: SqlDatabase;
  journal: JournalStore;
  now: () => Date;
  /** L'état d'identité vérifiée au coffre de la conformité (M12) : jamais la pièce [R15]. */
  identity: IdentityState;
  /** Les documents du dossier protégé, par leur référence de stockage (H38 pour le stockage réel). */
  storage: DossierStorage;
  /** Ce que la vigilance de la cession lit du coffre : déposé ou non [R15]. */
  vault: VaultDeposits;
  /** La porte de diffusion de D05 : le rapprochement n'en montre que les biens diffusables. */
  diffusion: BusinessDiffusionGate;
  /** L'IA qui rédige la présentation ; absente, le secours sans IA [R12]. */
  presentationWriter?: PresentationWriter;
  newId?: () => string;
  newCode?: () => string;
  newToken?: () => string;
  baseUrl?: string;
}

type Role = Viewer['role'];
const WRITERS: readonly Role[] = ['agent', 'direction'];
const READERS: readonly Role[] = ['agent', 'direction', 'compliance'];

export interface CommercesRoute {
  method: 'GET' | 'POST';
  pattern: RegExp;
  /** Nom de la route pour le journal : jamais l'identifiant demandé. */
  name: string;
  /** Les rôles admis : un autre est refusé avant toute lecture du corps [R16]. */
  roles: readonly Role[];
  handle: (s: CommercesServices, viewer: Viewer, params: string[], request: Request) => Promise<Response>;
}

export interface DossierReaderRoute {
  method: 'POST';
  pattern: RegExp;
  name: string;
  handle: (s: CommercesServices, params: string[], request: Request) => Promise<Response>;
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
  });

type Outcome = { ok: true; value?: unknown; [extra: string]: unknown } | { ok: false; rule: string | null; code: string };

/** 200 ; 403 pour un refus de droits ; 404 inconnu ; 409 pour une règle ; 400 sinon. */
function reply(result: Outcome): Response {
  if (result.ok) {
    // Ce qui accompagne un succès suit (les phrases de l'IA refusées d'une présentation, par exemple).
    const { ok: _ok, value, ...rest } = result;
    return json(200, { ok: true, mode: TRIAL_MODE, data: value ?? null, ...rest });
  }
  const { rule, code } = result;
  // Les détails d'un refus (phrases refusées, étapes manquantes, codes de la porte) suivent, sans donnée personnelle.
  const extra = Object.fromEntries(Object.entries(result).filter(([k]) => !['ok', 'rule', 'code'].includes(k)));
  if (rule === 'R16') return json(code === 'unknown' ? 404 : 403, { ok: false, rule, code });
  if (/^unknown|^inconnu$/.test(code)) return json(404, { ok: false, rule, code });
  return json(rule ? 409 : 400, { ok: false, rule, code, ...extra });
}

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  if (!(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) return null;
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (declared > MAX_COMMERCES_BODY_BYTES) return null;
  const text = await request.text();
  if (new TextEncoder().encode(text).length > MAX_COMMERCES_BODY_BYTES) return null;
  try {
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const withBody =
  (fn: (s: CommercesServices, v: Viewer, p: string[], b: Record<string, unknown>) => Promise<Response>) =>
  async (s: CommercesServices, v: Viewer, p: string[], r: Request): Promise<Response> => {
    const body = await readJson(r);
    return body ? fn(s, v, p, body) : json(400, { ok: false, rule: null, code: 'invalid_body' });
  };

/** Les objets métier, faits à chaque requête sur les mêmes services. */
export function commercesCore(s: CommercesServices) {
  const opts = { now: s.now, ...(s.newId ? { newId: s.newId } : {}) };
  const store = new FicheClient(s.db, { now: s.now });
  const acces = new Acces(s.db, store, new FicheUnique(s.db, store, { now: s.now }), s.journal, { now: s.now });
  const fiches = new FicheCommerce(s.db, s.journal, opts);
  const estimations = new EstimationCommerce(s.db, s.journal, fiches, opts);
  const presentations = new PresentationCommerce(s.db, s.journal, fiches, estimations, { ...opts, ...(s.presentationWriter ? { writer: s.presentationWriter } : {}) });
  const confidentialite = new ConfidentialiteCommerce(s.db, s.journal, fiches, presentations, s.identity, { ...opts, ...(s.newCode ? { newCode: s.newCode } : {}) });
  const dossier = new DossierCommerce(s.db, s.journal, fiches, confidentialite, s.storage, {
    ...opts,
    ...(s.newCode ? { newCode: s.newCode } : {}),
    ...(s.newToken ? { newToken: s.newToken } : {}),
    ...(s.baseUrl ? { baseUrl: s.baseUrl } : {}),
  });
  return {
    acces,
    fiches,
    estimations,
    presentations,
    confidentialite,
    dossier,
    repreneurs: new RepreneursCommerce(s.db, s.journal, fiches, estimations, presentations, s.diffusion, opts),
    cessions: new CessionCommerce(s.db, s.journal, fiches, opts),
    bail: new TachesBail(s.db, s.journal, fiches, opts),
    vigilance: new VigilanceCession(s.db, s.journal, s.vault, opts),
  };
}
const core = commercesCore;

/** La vue publique d'un commerce et sa présentation publiable : ce que tout le monde peut voir [R110]. */
async function publicOf(s: CommercesServices, v: Viewer, id: string): Promise<Outcome> {
  const c = core(s);
  const read = await c.acces.readProperty(v, id);
  if (!read.ok) return { ok: false, rule: 'R16', code: read.code };
  const view = await c.fiches.publicView(id);
  if (!view) return { ok: false, rule: null, code: 'sorte' };
  const shown = await c.presentations.publishable(v.networkId, id);
  return { ok: true, value: { publicView: view, presentation: shown ? { title: shown.title, body: shown.body } : null } };
}

const ROUTES: CommercesRoute[] = [
  /* La liste de l'écran « Commerces » (CE11) : référence, sorte, commune, rien de confidentiel [R16, R110]. */
  { method: 'GET', pattern: /^\/commerces$/, name: 'commerces.liste', roles: READERS, handle: async (s, v) => reply(await core(s).fiches.list(v)) },
  { method: 'GET', pattern: new RegExp(`^/commerces/${ID}/demandes$`), name: 'commerces.demandes', roles: WRITERS, handle: async (s, v, [id]) => { const c = core(s); return reply(await c.confidentialite.requests(c.acces, v, id!)); } },
  { method: 'GET', pattern: new RegExp(`^/commerces/${ID}/cession$`), name: 'commerces.cession.du_bien', roles: READERS, handle: async (s, v, [id]) => { const c = core(s); return reply(await c.cessions.forProperty(c.acces, v, id!)); } },
  /* La fiche du commerce (CE01) [R110]. */
  { method: 'GET', pattern: new RegExp(`^/commerces/${ID}/fiche$`), name: 'commerces.fiche', roles: READERS, handle: async (s, v, [id]) => { const c = core(s); return reply(await c.fiches.read(c.acces, v, id!)); } },
  { method: 'POST', pattern: new RegExp(`^/commerces/${ID}/fiche$`), name: 'commerces.fiche.modifiee', roles: WRITERS, handle: withBody(async (s, v, [id], b) => { const c = core(s); return reply(await c.fiches.update(c.acces, v, id!, b)); }) },
  { method: 'GET', pattern: new RegExp(`^/commerces/${ID}/public$`), name: 'commerces.public', roles: READERS, handle: async (s, v, [id]) => reply(await publicOf(s, v, id!)) },
  /* L'estimation (CE02) [R111]. */
  { method: 'GET', pattern: /^\/commerces\/baremes$/, name: 'commerces.baremes', roles: ['direction'], handle: async (s, v) => reply(await core(s).estimations.scales(v)) },
  { method: 'POST', pattern: /^\/commerces\/baremes$/, name: 'commerces.bareme', roles: ['direction'], handle: withBody(async (s, v, _p, b) => reply(await core(s).estimations.recordScale(v, b))) },
  { method: 'POST', pattern: new RegExp(`^/commerces/${ID}/estimations$`), name: 'commerces.estimation', roles: ['agent'], handle: withBody(async (s, v, [id], b) => { const c = core(s); return reply(await c.estimations.estimate(c.acces, v, id!, b.method)); }) },
  { method: 'GET', pattern: new RegExp(`^/commerces/${ID}/estimations$`), name: 'commerces.estimations', roles: READERS, handle: async (s, v, [id]) => { const c = core(s); return reply(await c.estimations.read(c.acces, v, id!)); } },
  { method: 'POST', pattern: new RegExp(`^/commerces/estimations/${ID}/validation$`), name: 'commerces.estimation.validee', roles: ['agent'], handle: async (s, v, [id]) => { const c = core(s); return reply(await c.estimations.validate(c.acces, v, id!)); } },
  /* La présentation anonyme (CE03) [R110, R112]. */
  { method: 'POST', pattern: new RegExp(`^/commerces/${ID}/presentations$`), name: 'commerces.presentation', roles: WRITERS, handle: async (s, v, [id]) => { const c = core(s); return reply(await c.presentations.propose(c.acces, v, id!)); } },
  { method: 'POST', pattern: new RegExp(`^/commerces/${ID}/presentations/texte$`), name: 'commerces.presentation.corrigee', roles: WRITERS, handle: withBody(async (s, v, [id], b) => { const c = core(s); return reply(await c.presentations.correct(c.acces, v, id!, { title: b.title, body: b.body })); }) },
  { method: 'GET', pattern: new RegExp(`^/commerces/${ID}/presentation$`), name: 'commerces.presentation.lue', roles: READERS, handle: async (s, v, [id]) => { const c = core(s); return reply(await c.presentations.read(c.acces, v, id!)); } },
  { method: 'POST', pattern: new RegExp(`^/commerces/presentations/${ID}/validation$`), name: 'commerces.presentation.validee', roles: ['agent'], handle: async (s, v, [id]) => { const c = core(s); return reply(await c.presentations.validate(c.acces, v, id!)); } },
  /* Demandes d'accès et engagement de confidentialité (CE04) [R113]. */
  { method: 'GET', pattern: /^\/commerces\/engagements\/modeles$/, name: 'commerces.engagement.modele_lu', roles: ['direction'], handle: async (s, v) => reply(await core(s).confidentialite.currentTemplate(v)) },
  { method: 'GET', pattern: new RegExp(`^/commerces/engagements/${ID}$`), name: 'commerces.engagement.texte', roles: WRITERS, handle: async (s, v, [id]) => { const c = core(s); return reply(await c.confidentialite.text(c.acces, v, id!)); } },
  { method: 'POST', pattern: /^\/commerces\/engagements\/modeles$/, name: 'commerces.engagement.modele', roles: ['direction'], handle: withBody(async (s, v, _p, b) => reply(await core(s).confidentialite.recordTemplate(v, b.body))) },
  { method: 'POST', pattern: new RegExp(`^/commerces/${ID}/demandes$`), name: 'commerces.demande', roles: WRITERS, handle: withBody(async (s, v, [id], b) => { const c = core(s); return reply(await c.confidentialite.requestAccess(c.acces, v, id!, String(b.personId ?? ''))); }) },
  { method: 'POST', pattern: new RegExp(`^/commerces/${ID}/informations$`), name: 'commerces.informations', roles: WRITERS, handle: withBody(async (s, v, [id], b) => { const c = core(s); return reply(await c.confidentialite.sendPublicInfo(c.acces, v, id!, String(b.personId ?? ''), { consentProof: b.consentProof }, s.diffusion)); }) },
  { method: 'POST', pattern: new RegExp(`^/commerces/engagements/${ID}/signature$`), name: 'commerces.engagement.signature', roles: WRITERS, handle: withBody(async (s, v, [id], b) => { const c = core(s); return reply(await c.confidentialite.startSignature(c.acces, v, id!, { consentProof: b.consentProof })); }) },
  { method: 'POST', pattern: new RegExp(`^/commerces/signatures/${ID}$`), name: 'commerces.engagement.signe', roles: WRITERS, handle: withBody(async (s, v, [id], b) => { const c = core(s); return reply(await c.confidentialite.sign(c.acces, v, id!, { code: b.code, drawing: b.drawing })); }) },
  { method: 'POST', pattern: new RegExp(`^/commerces/engagements/${ID}/revocation$`), name: 'commerces.engagement.revoque', roles: WRITERS, handle: withBody(async (s, v, [id], b) => { const c = core(s); return reply(await c.confidentialite.revoke(c.acces, v, id!, b.reason)); }) },
  /* Le dossier protégé (CE05) [R113, R114]. */
  { method: 'POST', pattern: new RegExp(`^/commerces/${ID}/documents$`), name: 'commerces.dossier.document', roles: WRITERS, handle: withBody(async (s, v, [id], b) => { const c = core(s); return reply(await c.dossier.addDocument(c.acces, v, id!, { kind: b.kind, title: b.title, storageRef: b.storageRef })); }) },
  { method: 'POST', pattern: new RegExp(`^/commerces/${ID}/documents/texte$`), name: 'commerces.dossier.depot', roles: WRITERS, handle: withBody(async (s, v, [id], b) => { const c = core(s); return reply(await c.dossier.depositText(c.acces, v, id!, { kind: b.kind, title: b.title, content: b.content })); }) },
  { method: 'GET', pattern: new RegExp(`^/commerces/${ID}/documents$`), name: 'commerces.dossier.documents', roles: WRITERS, handle: async (s, v, [id]) => { const c = core(s); return reply(await c.dossier.documents(c.acces, v, id!)); } },
  { method: 'POST', pattern: new RegExp(`^/commerces/${ID}/dossiers$`), name: 'commerces.dossier.envoi', roles: WRITERS, handle: withBody(async (s, v, [id], b) => { const c = core(s); return reply(await c.dossier.send(c.acces, v, id!, String(b.personId ?? ''), { consentProof: b.consentProof })); }) },
  { method: 'GET', pattern: new RegExp(`^/commerces/${ID}/liens$`), name: 'commerces.dossier.liens', roles: WRITERS, handle: async (s, v, [id]) => { const c = core(s); return reply(await c.dossier.links(c.acces, v, id!)); } },
  { method: 'POST', pattern: new RegExp(`^/commerces/liens/${ID}/revocation$`), name: 'commerces.dossier.lien_revoque', roles: WRITERS, handle: async (s, v, [id]) => { const c = core(s); return reply(await c.dossier.revokeLink(c.acces, v, id!)); } },
  { method: 'GET', pattern: new RegExp(`^/commerces/${ID}/ouvertures$`), name: 'commerces.dossier.ouvertures', roles: READERS, handle: async (s, v, [id]) => { const c = core(s); return reply(await c.dossier.accesses(c.acces, v, id!)); } },
  { method: 'POST', pattern: new RegExp(`^/commerces/${ID}/tracage$`), name: 'commerces.dossier.tracage', roles: WRITERS, handle: withBody(async (s, v, [id], b) => { const c = core(s); return reply(await c.dossier.trace(c.acces, v, id!, b.text)); }) },
  /* Les repreneurs (CE06) [R115, R14]. */
  { method: 'GET', pattern: /^\/commerces\/repreneurs$/, name: 'commerces.repreneurs', roles: WRITERS, handle: async (s, v) => { const c = core(s); return reply(await c.repreneurs.list(c.acces, v)); } },
  { method: 'GET', pattern: new RegExp(`^/commerces/repreneurs/${ID}$`), name: 'commerces.repreneur', roles: READERS, handle: async (s, v, [id]) => { const c = core(s); return reply(await c.repreneurs.read(c.acces, v, id!)); } },
  { method: 'POST', pattern: new RegExp(`^/commerces/repreneurs/${ID}$`), name: 'commerces.repreneur.modifie', roles: WRITERS, handle: withBody(async (s, v, [id], b) => { const c = core(s); return reply(await c.repreneurs.update(c.acces, v, id!, b)); }) },
  { method: 'GET', pattern: new RegExp(`^/commerces/repreneurs/${ID}/biens$`), name: 'commerces.repreneur.biens', roles: READERS, handle: async (s, v, [id]) => { const c = core(s); return reply(await c.repreneurs.match(c.acces, v, id!)); } },
  /* La cession (CE07) [R116, R117]. */
  { method: 'POST', pattern: /^\/commerces\/perimetres$/, name: 'commerces.cession.perimetre', roles: ['direction'], handle: withBody(async (s, v, _p, b) => reply(await core(s).cessions.recordCommune(v, b))) },
  { method: 'POST', pattern: new RegExp(`^/commerces/${ID}/cession$`), name: 'commerces.cession.ouverte', roles: WRITERS, handle: async (s, v, [id]) => { const c = core(s); return reply(await c.cessions.open(c.acces, v, id!)); } },
  { method: 'GET', pattern: new RegExp(`^/commerces/cessions/${ID}$`), name: 'commerces.cession', roles: READERS, handle: async (s, v, [id]) => { const c = core(s); return reply(await c.cessions.read(c.acces, v, id!)); } },
  { method: 'POST', pattern: new RegExp(`^/commerces/cessions/${ID}/dates$`), name: 'commerces.cession.date', roles: WRITERS, handle: withBody(async (s, v, [id], b) => { const c = core(s); return reply(await c.cessions.record(c.acces, v, id!, { kind: b.kind, day: b.day, proofRef: b.proofRef })); }) },
  { method: 'POST', pattern: new RegExp(`^/commerces/cessions/${ID}/sequestre$`), name: 'commerces.cession.sequestre', roles: WRITERS, handle: withBody(async (s, v, [id], b) => { const c = core(s); return reply(await c.cessions.setEscrow(c.acces, v, id!, { kind: b.kind, name: b.name })); }) },
  { method: 'POST', pattern: new RegExp(`^/commerces/cessions/${ID}/prete$`), name: 'commerces.cession.prete', roles: WRITERS, handle: async (s, v, [id]) => { const c = core(s); return reply(await c.cessions.declareReady(c.acces, v, id!)); } },
  { method: 'GET', pattern: /^\/commerces\/taches-cession$/, name: 'commerces.cession.taches', roles: ['agent'], handle: async (s, v) => reply(await core(s).cessions.tasksOf(v)) },
  /* AU101b · Les jours limites de congé des baux commerciaux de l'agent. */
  { method: 'GET', pattern: /^\/commerces\/taches-bail$/, name: 'commerces.bail.taches', roles: ['agent'], handle: async (s, v) => reply(await core(s).bail.tasksOf(v)) },
  /* La vigilance de la cession (CE08) [R118, R14]. */
  { method: 'POST', pattern: new RegExp(`^/commerces/cessions/${ID}/acquereur$`), name: 'commerces.cession.acquereur', roles: WRITERS, handle: withBody(async (s, v, [id], b) => { const c = core(s); return reply(await c.vigilance.setBuyer(c.acces, v, id!, { personId: b.personId, legalPerson: b.legalPerson })); }) },
  { method: 'GET', pattern: new RegExp(`^/commerces/cessions/${ID}/acquereur$`), name: 'commerces.cession.acquereur_lu', roles: WRITERS, handle: async (s, v, [id]) => { const c = core(s); return reply(await c.vigilance.buyer(c.acces, v, id!)); } },
  { method: 'GET', pattern: new RegExp(`^/commerces/cessions/${ID}/demande-fonds$`), name: 'commerces.cession.demande_fonds', roles: WRITERS, handle: async (s, v, [id]) => { const c = core(s); return reply(await c.vigilance.fundsRequest(c.acces, v, id!)); } },
  { method: 'GET', pattern: /^\/commerces\/vigilance$/, name: 'commerces.vigilance', roles: ['compliance'], handle: async (s, v) => reply(await core(s).vigilance.list(v)) },
  { method: 'POST', pattern: new RegExp(`^/commerces/vigilance/${ID}/decision$`), name: 'commerces.vigilance.decision', roles: ['compliance'], handle: withBody(async (s, v, [id], b) => reply(await core(s).vigilance.decide(v, id!, { decision: b.decision, reason: b.reason, validatorName: b.validatorName }))) },
];

/**
 * Les routes de M16, prêtes pour le routeur du socle (CE10) : chacune contrôle le rôle avant tout, écrit le refus au
 * journal, puis passe la main à la couche métier [R16].
 */
export function commercesRoutes(): CommercesRoute[] {
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

/**
 * Les deux routes du lecteur d'un dossier protégé, sans compte : demander le code d'ouverture, puis ouvrir. Le jeton du
 * lien, l'adresse et le code reçu à cette adresse font foi ; la porte de CE04 est revérifiée à chaque ouverture [R113].
 */
export function dossierReaderRoutes(): DossierReaderRoute[] {
  const body = async (r: Request) => (await readJson(r)) ?? {};
  return [
    {
      method: 'POST',
      pattern: new RegExp(`^/dossier/${TOKEN}/code$`),
      name: 'commerces.dossier.code',
      handle: async (s, [token], r) => reply(await core(s).dossier.requestCode(token, (await body(r)).email)),
    },
    {
      method: 'POST',
      pattern: new RegExp(`^/dossier/${TOKEN}$`),
      name: 'commerces.dossier.ouverture',
      handle: async (s, [token], r) => {
        const b = await body(r);
        const opened = await core(s).dossier.open(token, b.email, b.code);
        // Une panne de stockage ne consomme rien : le lecteur réessaie avec le même code (CE23).
        if (!opened.ok && opened.code === 'stockage_indisponible') return json(503, { ok: false, rule: null, code: opened.code });
        // Le lecteur sans compte ne lit jamais pourquoi la porte est fermée : seulement qu'elle l'est.
        return reply(opened.ok ? opened : { ok: false, rule: opened.rule, code: opened.code });
      },
    },
  ];
}
