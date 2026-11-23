/**
 * Les routes de M19 Studio (X09), sous `/v1/studio` : guide de prise de vue, photos corrigées et leur certificat,
 * modèle et description du montage, plan du logement, publications et leur validation, supports imprimés,
 * bibliothèque sous licence, options payantes et mesure des visuels.
 *
 * Chaque route dit les rôles qu'elle admet ; un autre rôle est refusé et écrit au journal avant que le corps de la
 * requête soit lu [R16]. Les droits fins (bien confié, agent du bien) restent ceux de la couche métier, qui écrit
 * aussi ses refus au journal. Aucune image ni vidéo ne passe par ces routes : seulement des références, des empreintes
 * et des descriptions [R130], sauf le dépôt d'un fichier fini (X12), rangé tel quel, sans aucun traitement. Rien ne part réellement : les réseaux sont en mode essai [R26, R134].
 *
 * Le certificat d'une photo est public : `studioCertificate` le rend sans aucune donnée personnelle ; sa page publique
 * et le branchement de ces routes au routeur viennent avec X10 (voie 1, fichiers du socle).
 */
import { Acces, FicheClient, FicheUnique, appendEvent, type JournalStore, type SqlDatabase, type Viewer } from '@aimmo/core';
import { MAX_UPLOAD_BYTES, UPLOAD_TYPES, sha256Hex } from './partenaires.ts';
import { Annonces } from '../../core/src/annonces/annonces.ts';
import { MediasBien } from '../../core/src/annonces/medias.ts';
import { computeMentions, MentionsAnnonce } from '../../core/src/annonces/mentions.ts';
import { PageBien } from '../../core/src/annonces/page-bien.ts';
import { OrigineContacts } from '../../core/src/attirer/origine-contacts.ts';
import { Diffusion } from '../../core/src/documents/retractation.ts';
import { Annuaire } from '../../core/src/partenaires/annuaire.ts';
import { MiseEnRelation } from '../../core/src/partenaires/mise-en-relation.ts';
import {
  AtelierStudio,
  Bibliotheque,
  DepotsStudio,
  CertificatsPhotos,
  GuidePriseDeVue,
  Montages,
  OptionsStudio,
  PlanLogement,
  Publications,
  SOCIAL_CHANNELS,
  Supports,
  trialSocialChannel,
  type SocialChannel,
  type SocialWriter,
  type StudioUploadStore,
} from '../../core/src/studio/index.ts';

export const TRIAL_MODE = 'essai';
export const MAX_STUDIO_BODY_BYTES = 32 * 1024;
const ID = '([A-Za-z0-9_-]{1,64})';

export interface StudioServices {
  db: SqlDatabase;
  journal: JournalStore;
  now: () => Date;
  /** Le stockage des fichiers (photos, originaux, preuves, accords) : seule l'existence d'une référence est lue. */
  files: { has(ref: string): Promise<boolean> };
  /** Le stockage où les fichiers finis sont rangés tels quels (X12) ; absent, le dépôt est fermé. */
  uploads?: StudioUploadStore | null;
  /** L'IA qui rédige le corps d'une publication ; absente, le texte de secours. */
  writer?: SocialWriter | null;
  /** Les réseaux, chacun derrière son interface ; par défaut, tous en essai. Un canal réel exige `live` [R26, R134]. */
  channels?: readonly SocialChannel[];
  /** La mise en service des vrais réseaux (AU036), donnée par le Worker seul quand le compte du réseau est rangé. */
  live?: boolean;
  /** La porte de diffusion ; par défaut celle de D05 [R42]. */
  diffusion?: { canDiffuse(networkId: string, propertyId: string, at?: Date): Promise<{ allowed: boolean }> };
  /** Les mentions obligatoires ; par défaut celles de M07, calculées par `computeMentions` [R43]. */
  mentions?: { checklist(networkId: string, propertyId: string): Promise<{ complete: boolean; text: string; publishedPriceEur: number | null } | null> };
  newId?: () => string;
}

type Role = Viewer['role'];
const WORK: readonly Role[] = ['agent', 'direction'];
const DIRECTION: readonly Role[] = ['direction'];
const AGENT: readonly Role[] = ['agent'];

export interface StudioRoute {
  method: 'GET' | 'POST';
  pattern: RegExp;
  /** Nom de la route pour le journal : jamais l'identifiant demandé. */
  name: string;
  /** Les rôles admis : un autre est refusé avant toute lecture du corps [R16]. */
  roles: readonly Role[];
  handle: (s: StudioServices, viewer: Viewer, params: string[], request: Request) => Promise<Response>;
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
  });

const html = (page: string): Response =>
  new Response(page, {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    },
  });

/** Ce qui n'existe pas pour ce lecteur : 404, sans dire s'il existe ailleurs. */
const NOT_FOUND = new Set(['unknown', 'unknown_property', 'publication_inconnue', 'entree_inconnue', 'agent_inconnu', 'bien_inconnu']);

type Outcome = { ok: true; value?: unknown } | { ok: false; rule: string | null; code: string; [k: string]: unknown };

/** 200 ; 403 pour un refus de droits ; 404 inconnu ; 409 pour une règle ; 400 sinon. */
function reply(result: Outcome): Response {
  if (result.ok) return json(200, { ok: true, mode: TRIAL_MODE, data: result.value ?? null });
  const { rule, code } = result;
  const extra = Object.fromEntries(Object.entries(result).filter(([k]) => !['ok', 'rule', 'code'].includes(k)));
  if (rule === 'R16') return json(code === 'unknown' ? 404 : 403, { ok: false, rule, code });
  if (NOT_FOUND.has(code)) return json(404, { ok: false, rule, code, ...extra });
  return json(rule ? 409 : 400, { ok: false, rule, code, ...extra });
}

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  if (!(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) return null;
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (declared > MAX_STUDIO_BODY_BYTES) return null;
  const text = await request.text();
  if (new TextEncoder().encode(text).length > MAX_STUDIO_BODY_BYTES) return null;
  try {
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const withBody =
  (fn: (s: StudioServices, v: Viewer, p: string[], b: Record<string, unknown>) => Promise<Response>) =>
  async (s: StudioServices, v: Viewer, p: string[], r: Request): Promise<Response> => {
    const body = await readJson(r);
    return body ? fn(s, v, p, body) : json(400, { ok: false, rule: null, code: 'invalid_body' });
  };

/** Les objets métier, faits à chaque requête sur les mêmes services. */
export function studioCore(s: StudioServices) {
  const opts = { now: s.now, ...(s.newId ? { newId: s.newId } : {}) };
  const store = new FicheClient(s.db, { now: s.now });
  const acces = new Acces(s.db, store, new FicheUnique(s.db, store, { now: s.now }), s.journal, { now: s.now });
  const certs = new CertificatsPhotos(s.db, acces, s.journal, s.files, opts);
  const medias = new MediasBien(s.db, acces, s.journal, opts);
  const bibliotheque = new Bibliotheque(s.db, s.journal, s.files, opts);
  const annuaire = new Annuaire(s.db, s.files, s.journal, opts);
  const relations = new MiseEnRelation(s.db, annuaire, s.files, s.journal, opts);
  const pages = new PageBien(s.db, acces, s.journal, opts);
  return {
    acces,
    certs,
    guide: new GuidePriseDeVue(s.db, acces, s.journal, opts),
    montages: new Montages(s.db, acces, s.journal, medias, bibliotheque, opts),
    plans: new PlanLogement(s.db, acces, s.journal, opts),
    publications: new Publications(
      s.db,
      acces,
      s.journal,
      {
        facts: new Annonces(s.db, acces, s.journal, { now: s.now }),
        certs,
        diffusion: s.diffusion ?? new Diffusion(s.db, acces, s.journal, { now: s.now }),
        mentions: s.mentions ?? {
          checklist: async (networkId: string, propertyId: string) => {
            const input = await new MentionsAnnonce(s.db, acces, s.journal, { now: s.now }).inputFor(networkId, propertyId);
            return input ? computeMentions(input) : null;
          },
        },
        consents: s.files,
        channels: s.channels ?? SOCIAL_CHANNELS.map((c) => trialSocialChannel(c)),
        origin: new OrigineContacts(s.db, s.journal, { now: s.now }),
      },
      { ...opts, writer: s.writer ?? null, ...(s.live === true ? { live: true } : {}) },
    ),
    supports: new Supports(s.db, acces, s.journal, pages, { now: s.now }),
    bibliotheque,
    options: new OptionsStudio(s.db, s.journal, relations, opts),
    atelier: new AtelierStudio(s.db, acces, s.journal, certs, { now: s.now, origin: new OrigineContacts(s.db, s.journal, { now: s.now }) }),
  };
}

const core = studioCore;

/** Lit le corps d'une requête, au plus `max` octets, sans rien transformer ; null au-delà [R130]. */
export async function readCapped(request: Request, max: number): Promise<Uint8Array | null> {
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    parts.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.byteLength;
  }
  return out;
}

/** Le statut d'un refus de dépôt : trop lourd, type refusé et stockage en panne ont le leur. */
const DEPOSIT_STATUS: Record<string, number> = { trop_lourd: 413, type_refuse: 415, stockage_indisponible: 503 };

/**
 * Le dépôt d'un fichier fini (X12) : le corps est le fichier, tel quel ; son type dans `content-type`, son empreinte
 * dite par l'appareil dans `x-aimmo-sha256`, la retouche d'une photo dans `?retouche=`. Le serveur ne le transforme
 * jamais : il le range et l'ajoute à la fiche s'il est une photo ou une vidéo [R130].
 */
async function depositRoute(s: StudioServices, v: Viewer, [id, kind]: string[], r: Request): Promise<Response> {
  if (!s.uploads) return json(503, { ok: false, rule: null, code: 'depot_ferme' });
  const length = r.headers.get('content-length');
  const declaredSize = length === null || length.trim() === '' ? null : /^\d{1,12}$/.test(length.trim()) ? Number(length.trim()) : Number.NaN;
  const result = await new DepotsStudio(s.db, core(s).acces, s.journal, s.uploads, { now: s.now, ...(s.newId ? { newId: s.newId } : {}) }).deposit(v, id!, {
    kind,
    edit: new URL(r.url).searchParams.get('retouche') ?? undefined,
    contentType: r.headers.get('content-type'),
    sha256: r.headers.get('x-aimmo-sha256'),
    declaredSize,
    read: (max) => readCapped(r, max),
  });
  if (!result.ok && DEPOSIT_STATUS[result.code]) return json(DEPOSIT_STATUS[result.code]!, { ok: false, rule: result.rule, code: result.code });
  return reply(result);
}

/**
 * La direction dépose la preuve d'une licence, en PDF, JPEG ou PNG, et le serveur choisit la référence que l'entrée de la
 * bibliothèque reprend [R133]. Le rôle d'abord, avant de lire un octet ; le contenu n'est jamais lu au-delà de sa
 * signature, et le journal ne garde que l'empreinte [R13]. Rangée hors de `biens/`, la preuve n'est jamais publiée.
 */
async function depositLibraryProof(s: StudioServices, v: Viewer, _p: string[], r: Request): Promise<Response> {
  const type = (r.headers.get('content-type') ?? '').toLowerCase().split(';')[0]!.trim();
  const kind = UPLOAD_TYPES.find((t) => t.type === type);
  if (!kind) return json(415, { ok: false, rule: null, code: 'bad_type' });
  if (!s.uploads) return json(503, { ok: false, rule: null, code: 'storage_unavailable' });
  const bytes = await readCapped(r, MAX_UPLOAD_BYTES);
  if (!bytes) return json(413, { ok: false, rule: null, code: 'too_large' });
  if (bytes.byteLength < kind.magic.length || !kind.magic.every((b, i) => bytes[i] === b)) return json(415, { ok: false, rule: null, code: 'bad_type' });
  const proofRef = `bibliotheque/preuves/${crypto.randomUUID()}.${kind.ext}`;
  const sha256 = await sha256Hex(bytes);
  await s.uploads.put(proofRef, bytes, kind.type);
  await appendEvent(s.journal, { type: 'studio.bibliotheque.preuve_deposee', actor: `${String(v.role)}:${v.userId}`, subject: `network:${v.networkId}`, data: { rule: 'R133', sha256 } }, s.now);
  return reply({ ok: true, value: { proofRef } });
}

const ROUTES: StudioRoute[] = [
  // L'atelier du bien (X11) : photos de la fiche, celles qui ont leur certificat, publications préparées.
  { method: 'GET', pattern: new RegExp(`^/studio/biens/${ID}$`), name: 'studio.atelier', roles: WORK, handle: async (s, v, [id]) => reply(await core(s).atelier.read(v, id!)) },
  // Les liens marqués de ce que l'agent poste lui-même (AT20).
  { method: 'GET', pattern: new RegExp(`^/studio/biens/${ID}/liens$`), name: 'studio.liens', roles: WORK, handle: async (s, v, [id]) => reply(await core(s).atelier.links(v, id!)) },
  // Guide de prise de vue (X01).
  { method: 'GET', pattern: /^\/studio\/guides-a-valider$/, name: 'studio.guides_a_valider', roles: DIRECTION, handle: async (s, v, _p, r) => reply(await core(s).guide.toValidate(v, new URL(r.url).searchParams.get('apres'))) },
  { method: 'GET', pattern: new RegExp(`^/studio/biens/${ID}/guide$`), name: 'studio.guide', roles: WORK, handle: async (s, v, [id]) => reply(await core(s).guide.progress(v, id!)) },
  {
    method: 'POST',
    pattern: new RegExp(`^/studio/biens/${ID}/guide/vues$`),
    name: 'studio.guide.vue',
    roles: WORK,
    handle: withBody(async (s, v, [id], b) => reply(await core(s).guide.recordShot(v, id!, { viewKey: b.viewKey, mediaRef: b.mediaRef }))),
  },
  { method: 'POST', pattern: new RegExp(`^/studio/biens/${ID}/guide/validation$`), name: 'studio.guide.validation', roles: DIRECTION, handle: async (s, v, [id]) => reply(await core(s).guide.validate(v, id!)) },
  // Photos corrigées sur l'appareil et leur certificat (X02).
  {
    method: 'POST',
    pattern: new RegExp(`^/studio/biens/${ID}/photos$`),
    name: 'studio.photo',
    roles: WORK,
    handle: withBody(async (s, v, [id], b) =>
      reply(
        await core(s).certs.record(v, id!, {
          resultRef: b.resultRef,
          resultSha256: b.resultSha256,
          originalRef: b.originalRef,
          originalSha256: b.originalSha256,
          operations: b.operations,
          processedOn: b.processedOn,
        }),
      ),
    ),
  },
  // Dépôt des fichiers finis, rangés tels quels (X12).
  { method: 'POST', pattern: new RegExp(`^/studio/biens/${ID}/fichiers/(photo|original|video)$`), name: 'studio.depot', roles: WORK, handle: depositRoute },
  // Montage (X03).
  { method: 'GET', pattern: new RegExp(`^/studio/biens/${ID}/montage$`), name: 'studio.montage.modele', roles: WORK, handle: async (s, v, [id]) => reply(await core(s).montages.template(v, id!)) },
  { method: 'POST', pattern: new RegExp(`^/studio/biens/${ID}/montage$`), name: 'studio.montage', roles: WORK, handle: withBody(async (s, v, [id], b) => reply(await core(s).montages.record(v, id!, b))) },
  // Plan du logement (X04).
  { method: 'GET', pattern: new RegExp(`^/studio/biens/${ID}/plan$`), name: 'studio.plan', roles: WORK, handle: async (s, v, [id]) => reply(await core(s).plans.current(v, id!)) },
  { method: 'POST', pattern: new RegExp(`^/studio/biens/${ID}/plan$`), name: 'studio.plan.saisie', roles: WORK, handle: withBody(async (s, v, [id], b) => reply(await core(s).plans.save(v, id!, { rooms: b.rooms }))) },
  // Publications (X05).
  {
    method: 'POST',
    pattern: new RegExp(`^/studio/biens/${ID}/publications$`),
    name: 'studio.publication',
    roles: WORK,
    handle: withBody(async (s, v, [id], b) => reply(await core(s).publications.prepare(v, id!, { event: b.event, visuals: b.visuals }))),
  },
  { method: 'GET', pattern: new RegExp(`^/studio/publications/${ID}$`), name: 'studio.publication.lire', roles: WORK, handle: async (s, v, [id]) => reply(await core(s).publications.read(v, id!)) },
  {
    method: 'POST',
    pattern: new RegExp(`^/studio/publications/${ID}/visuels$`),
    name: 'studio.publication.visuel',
    roles: AGENT,
    handle: withBody(async (s, v, [id], b) =>
      reply(
        await core(s).publications.checkVisual(v, id!, {
          ref: b.ref,
          addressVisible: b.addressVisible,
          personVisible: b.personVisible,
          consentRef: b.consentRef,
          stagingLabelVisible: b.stagingLabelVisible,
        }),
      ),
    ),
  },
  { method: 'POST', pattern: new RegExp(`^/studio/publications/${ID}/validation$`), name: 'studio.publication.validation', roles: AGENT, handle: async (s, v, [id]) => reply(await core(s).publications.validate(v, id!)) },
  { method: 'POST', pattern: new RegExp(`^/studio/publications/${ID}/envoi$`), name: 'studio.publication.envoi', roles: AGENT, handle: withBody(async (s, v, [id], b) => reply(await core(s).publications.publish(v, id!, b.targets))) },
  // Supports imprimés (X06) : la page à imprimer, en HTML.
  {
    method: 'GET',
    pattern: new RegExp(`^/studio/biens/${ID}/supports/(fiche|panneau|flyer|lettre_quartier)$`),
    name: 'studio.support',
    roles: WORK,
    handle: async (s, v, [id, kind]) => {
      const r = await core(s).supports.render(v, id!, kind);
      return r.ok ? html(r.html) : reply(r);
    },
  },
  {
    method: 'GET',
    pattern: new RegExp(`^/studio/agents/${ID}/carte$`),
    name: 'studio.carte',
    roles: WORK,
    handle: async (s, v, [id]) => {
      const r = await core(s).supports.businessCard(v, id!);
      return r.ok ? html(r.html) : reply(r);
    },
  },
  // Bibliothèque sous licence (X07).
  { method: 'GET', pattern: /^\/studio\/bibliotheque\/(musique|image)$/, name: 'studio.bibliotheque.choix', roles: WORK, handle: async (s, v, [kind]) => reply(await core(s).bibliotheque.choices(v, kind)) },
  { method: 'POST', pattern: /^\/studio\/bibliotheque\/preuves$/, name: 'studio.bibliotheque.preuve', roles: DIRECTION, handle: depositLibraryProof },
  { method: 'GET', pattern: /^\/studio\/bibliotheque$/, name: 'studio.bibliotheque', roles: DIRECTION, handle: async (s, v) => reply(await core(s).bibliotheque.all(v)) },
  {
    method: 'POST',
    pattern: /^\/studio\/bibliotheque$/,
    name: 'studio.bibliotheque.ajout',
    roles: DIRECTION,
    handle: withBody(async (s, v, _p, b) =>
      reply(await core(s).bibliotheque.add(v, { kind: b.kind, title: b.title, source: b.source, licence: b.licence, attribution: b.attribution, validUntil: b.validUntil, proofRef: b.proofRef })),
    ),
  },
  {
    method: 'POST',
    pattern: new RegExp(`^/studio/bibliotheque/${ID}/retrait$`),
    name: 'studio.bibliotheque.retrait',
    roles: DIRECTION,
    handle: withBody(async (s, v, [id], b) => reply(await core(s).bibliotheque.withdraw(v, id!, b.reason))),
  },
  // Options payantes et mesure des visuels (X08).
  {
    method: 'POST',
    pattern: /^\/studio\/options$/,
    name: 'studio.option',
    roles: WORK,
    handle: withBody(async (s, v, _p, b) => reply(await core(s).options.requestOption(v, { projectId: b.projectId, propertyId: b.propertyId, option: b.option, postcode: b.postcode }))),
  },
  { method: 'GET', pattern: /^\/studio\/mesure-visuels$/, name: 'studio.mesure', roles: DIRECTION, handle: async (s, v) => reply(await core(s).options.measureVisuals(v)) },
];

/** Les routes de M19, à ajouter à celles de `app.ts` (X10). */
export function studioRoutes(): StudioRoute[] {
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

/** Le certificat public d'une photo, sans compte : aucune donnée personnelle, aucun identifiant du bien [R46, R13]. */
export async function studioCertificate(s: StudioServices, token: string): Promise<Response> {
  const cert = await core(s).certs.certificate(token);
  return cert ? json(200, { ok: true, data: cert }) : json(404, { ok: false, rule: null, code: 'unknown' });
}
