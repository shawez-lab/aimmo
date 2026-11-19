/**
 * Les routes de M15 Louer (W09), sous `/v1/location` : contrôle du logement, honoraires, annonce, candidatures, choix du
 * propriétaire, bail, signature en ligne du bail, état des lieux, remise des clés et gestion par un partenaire.
 *
 * Chaque route dit les rôles qu'elle admet ; un autre rôle est refusé et écrit au journal avant que le corps de la
 * requête soit lu [R16]. Les droits fins (agent actif du bien, fiches lisibles en entier) restent ceux de la couche
 * métier, qui écrit aussi ses refus au journal [R16].
 *
 * Rien n'est envoyé d'ici : codes, avis et échéances passent par le contrôle central, en mode essai [R26]. Aucune route
 * ne rend de note, de rang ni de tri des candidats [R105]. Une pièce n'est jamais lue : seule sa référence circule ;
 * l'annexe, la preuve et la notice se déposent depuis le téléphone (W14), rangées telles quelles, jamais relues ici.
 * La remise des clés lit la signature réelle du bail (`signedAt`), jamais celle d'essai [R108].
 *
 * Les routes sont prêtes pour le routeur du socle, qui les branchera dans W10 (voie 1) : ce fichier ne touche à aucun
 * fichier du socle.
 */
import { Acces, FicheClient, FicheUnique, appendEvent, type JournalStore, type SqlDatabase, type Viewer } from '@aimmo/core';
import {
  AnnoncesLocation,
  BauxLocation,
  DepotsLocation,
  type PieceDepositPlace,
  Candidatures,
  ChoixProprietaire,
  EtatsDesLieux,
  HonorairesLocation,
  MisesEnLocation,
  RemisesDesCles,
  SignaturesBail,
  type IdentityState,
  type InventoryFormatter,
  type RentalAdWriter,
  type RentalFileStore,
} from '../../core/src/location/index.ts';
import { Annuaire, MiseEnRelation } from '../../core/src/partenaires/index.ts';
import { readCapped } from './studio.ts';

export const TRIAL_MODE = 'essai';
/** Un état des lieux dicté pièce par pièce et une signature tracée tiennent dans 256 Ko. */
export const MAX_LOCATION_BODY_BYTES = 256 * 1024;
const ID = '([A-Za-z0-9_-]{1,64})';

export interface LocationServices {
  db: SqlDatabase;
  journal: JournalStore;
  now: () => Date;
  /** Diagnostics, preuves, pièces des candidats, notice et photos : seule l'existence d'une référence est lue. */
  files: RentalFileStore;
  /** L'identité vérifiée d'un candidat ou d'un garant, par le coffre de conformité (L01) : seul son état est lu. */
  identity: IdentityState;
  /** L'IA qui rédige l'annonce ; absente, le secours sans IA [R103]. */
  adWriter?: RentalAdWriter;
  /** L'IA qui met en forme le dicté de l'état des lieux ; absente, le dicté tel quel [R106]. */
  inventoryFormatter?: InventoryFormatter | null;
  newId?: () => string;
}

type Role = Viewer['role'];
const WRITERS: readonly Role[] = ['agent', 'direction'];
const READERS: readonly Role[] = ['agent', 'direction', 'compliance'];

export interface LocationRoute {
  method: 'GET' | 'POST';
  pattern: RegExp;
  /** Nom de la route pour le journal : jamais l'identifiant demandé. */
  name: string;
  /** Les rôles admis : un autre est refusé avant toute lecture du corps [R16]. */
  roles: readonly Role[];
  handle: (s: LocationServices, viewer: Viewer, params: string[], request: Request) => Promise<Response>;
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
  const { rule, code } = result;
  // Les détails d'un refus (problèmes d'une annonce, pièce manquante) suivent, sans donnée personnelle.
  const extra = Object.fromEntries(Object.entries(result).filter(([k]) => !['ok', 'rule', 'code'].includes(k)));
  if (rule === 'R16') return json(code === 'unknown' ? 404 : 403, { ok: false, rule, code });
  if (/^unknown/.test(code)) return json(404, { ok: false, rule, code });
  return json(rule ? 409 : 400, { ok: false, rule, code, ...extra });
}

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  if (!(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) return null;
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (declared > MAX_LOCATION_BODY_BYTES) return null;
  const text = await request.text();
  if (new TextEncoder().encode(text).length > MAX_LOCATION_BODY_BYTES) return null;
  try {
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const withBody =
  (fn: (s: LocationServices, v: Viewer, p: string[], b: Record<string, unknown>) => Promise<Response>) =>
  async (s: LocationServices, v: Viewer, p: string[], r: Request): Promise<Response> => {
    const body = await readJson(r);
    return body ? fn(s, v, p, body) : json(400, { ok: false, rule: null, code: 'invalid_body' });
  };

/** Les objets métier, faits à chaque requête sur les mêmes services. */
export function locationCore(s: LocationServices) {
  const opts = { now: s.now, ...(s.newId ? { newId: s.newId } : {}) };
  const store = new FicheClient(s.db, { now: s.now });
  const acces = new Acces(s.db, store, new FicheUnique(s.db, store, { now: s.now }), s.journal, { now: s.now });
  const listings = new MisesEnLocation(s.db, s.files, s.journal, opts);
  const fees = new HonorairesLocation(s.db, listings, s.journal, { now: s.now });
  const applications = new Candidatures(s.db, listings, s.identity, s.files, s.journal, opts);
  const choices = new ChoixProprietaire(s.db, listings, applications, s.files, s.journal, opts);
  const leases = new BauxLocation(s.db, listings, fees, choices, s.files, acces, s.journal, opts);
  const signatures = new SignaturesBail(s.db, listings, leases, choices, acces, s.journal, opts);
  const inventories = new EtatsDesLieux(s.db, listings, leases, choices, s.files, acces, s.inventoryFormatter ?? null, s.journal, opts);
  const annuaire = new Annuaire(s.db, s.files, s.journal, opts);
  const relations = new MiseEnRelation(s.db, annuaire, s.files, s.journal, opts);
  return {
    listings,
    fees,
    ads: new AnnoncesLocation(s.db, listings, fees, s.journal, { ...opts, writer: s.adWriter }),
    applications,
    choices,
    leases,
    signatures,
    inventories,
    // La remise des clés lit la signature réelle : jamais une signature d'essai [R108].
    handovers: new RemisesDesCles(s.db, listings, fees, leases, inventories, signatures, relations, annuaire, s.journal, opts),
  };
}

const core = locationCore;

/**
 * L'avancée d'une mise en location (W11) : les derniers faits rangés, les honoraires en vigueur, le bail en vigueur et ses signatures d'essai,
 * l'état des lieux clos ou en cours de signature. Rien d'une personne (hors le contenu de l'état des lieux, document des deux parties) : ni nom, ni coordonnée. La lecture est au journal [R16].
 */
async function progress(s: LocationServices, v: Viewer, id: string): Promise<Outcome> {
  const c = core(s);
  const listing = await c.listings.listing(v, id, false);
  if ('ok' in listing) return listing;
  await appendEvent(s.journal, { type: 'location.lue', actor: `${String(v.role)}:${v.userId}`, subject: `rental:${listing.id}`, data: { rule: 'R16', what: 'progress' } }, s.now);
  const facts = await c.listings.currentFacts(listing.id);
  const lease = await c.leases.current(listing.networkId, listing.id);
  const signed = lease ? await c.signatures.status(listing.networkId, lease.leaseId) : null;
  const closed = await c.inventories.closedInventory(listing.networkId, listing.id);
  const f = await c.fees.current(listing.networkId, listing.id);
  const open = lease ? await c.inventories.pending(v, listing.id) : null;
  return {
    ok: true,
    value: {
      facts,
      fees: f ? { tenantCents: f.tenantCents, tenantInventoryCents: f.tenantInventoryCents, landlordCents: f.landlordCents, landlordInventoryCents: f.landlordInventoryCents, depositCents: f.depositCents } : null,
      lease: lease ? { leaseId: lease.leaseId, mode: lease.mode, complete: lease.complete, bailleur: signed?.bailleur ?? null, locataire: signed?.locataire ?? null, colocataires: signed?.colocataires ?? [], signedAt: signed?.signedAt ?? null, copiesSent: signed?.copiesSent ?? [], cotenantCopiesSent: signed?.cotenantCopiesSent ?? [] } : null,
      inventoryClosed: closed !== null && lease !== null && closed.leaseId === lease.leaseId,
      closedInventoryId: closed !== null && lease !== null && closed.leaseId === lease.leaseId ? closed.inventoryId : null,
      // L'état des lieux du bail en vigueur, rangé mais pas encore signé des deux parties : à signer sans le refaire.
      inventory: open && lease && open.leaseId === lease.leaseId ? open : null,
      handedOn: await c.handovers.handedOn(listing.networkId, listing.id),
    },
  };
}

const DEPOSIT_STATUS: Readonly<Record<string, number>> = { trop_lourd: 413, type_refuse: 415, stockage_indisponible: 503 };

/**
 * Le dépôt d'une pièce (W14) : le corps est le fichier, tel quel ; son type dans `content-type`, son empreinte dite par
 * l'appareil dans `x-aimmo-sha256`. Il rend la référence que le geste de M15 attend ; sans écriture possible, il est fermé.
 */
async function depositRoute(s: LocationServices, v: Viewer, [id, kind]: string[], r: Request, place?: PieceDepositPlace): Promise<Response> {
  const files = s.files;
  if (!files.upload) return json(503, { ok: false, rule: null, code: 'depot_ferme' });
  const length = r.headers.get('content-length');
  const declaredSize = length === null || length.trim() === '' ? null : /^\d{1,12}$/.test(length.trim()) ? Number(length.trim()) : Number.NaN;
  const store = { put: (key: string, bytes: Uint8Array, type: string) => files.upload!(key, bytes, type) };
  const result = await new DepotsLocation(core(s).listings, store, s.journal, core(s).applications, { now: s.now, ...(s.newId ? { newId: s.newId } : {}) }).deposit(v, id, {
    kind,
    contentType: r.headers.get('content-type'),
    sha256: r.headers.get('x-aimmo-sha256'),
    declaredSize,
    read: (max) => readCapped(r, max),
  }, place);
  if (!result.ok && DEPOSIT_STATUS[result.code]) return json(DEPOSIT_STATUS[result.code]!, { ok: false, rule: result.rule, code: result.code });
  return reply(result);
}

/** Le dépôt d'une pièce de candidature (W18) : la candidature et le titulaire, `?holder=`, sont contrôlés avant de lire un seul octet [R16]. */
async function depositPieceRoute(s: LocationServices, v: Viewer, [id]: string[], r: Request): Promise<Response> {
  const place = await core(s).applications.placeOf(v, id, new URL(r.url).searchParams.get('holder'));
  if (!place.ok) return reply(place);
  const { listingId, ...piece } = place.value;
  return depositRoute(s, v, [listingId, 'piece'], r, piece);
}

const ROUTES: LocationRoute[] = [
  /* Les mises en location lisibles et l'avancée de l'une d'elles, pour l'écran « Louer » (W11) [R16]. */
  /* Avant la route d'un logement, dont l'identifiant pourrait se lire pareil (W17). */
  { method: 'GET', pattern: /^\/location\/modeles-bail$/, name: 'location.modeles_bail', roles: ['direction', 'compliance'], handle: async (s, v) => reply(await core(s).leases.templates(v)) },
  { method: 'GET', pattern: /^\/location$/, name: 'location.liste', roles: READERS, handle: async (s, v, _p, r) => reply(await core(s).listings.mine(v, new URL(r.url).searchParams.get('page') ?? 0)) },
  { method: 'GET', pattern: new RegExp(`^/location/${ID}/suivi$`), name: 'location.suivi', roles: READERS, handle: async (s, v, [id]) => reply(await progress(s, v, id!)) },
  { method: 'GET', pattern: new RegExp(`^/location/${ID}/presentation$`), name: 'location.presentation.lue', roles: READERS, handle: async (s, v, [id]) => reply(await core(s).choices.last(v, id)) },

  /* Le dépôt d'une annexe, d'une preuve ou de la notice depuis le téléphone (W14) [R16]. */
  { method: 'POST', pattern: new RegExp(`^/location/${ID}/fichiers/(annexe|preuve|notice)$`), name: 'location.depot', roles: WRITERS, handle: depositRoute },
  { method: 'POST', pattern: new RegExp(`^/location/candidatures/${ID}/fichiers/piece$`), name: 'location.candidature.depot', roles: WRITERS, handle: depositPieceRoute },

  /* Le logement et son contrôle (W01) [R100, R101]. */
  {
    method: 'POST',
    pattern: /^\/location$/,
    name: 'location.creation',
    roles: WRITERS,
    handle: withBody(async (s, v, _p, b) => reply(await core(s).listings.create(v, { propertyId: b.propertyId, ownerPersonId: b.ownerPersonId }))),
  },
  { method: 'GET', pattern: new RegExp(`^/location/${ID}$`), name: 'location.etat', roles: READERS, handle: async (s, v, [id]) => reply(await core(s).listings.status(v, id)) },
  { method: 'POST', pattern: new RegExp(`^/location/${ID}/faits$`), name: 'location.faits', roles: WRITERS, handle: withBody(async (s, v, [id], b) => reply(await core(s).listings.recordFacts(v, id, b))) },
  {
    method: 'POST',
    pattern: new RegExp(`^/location/${ID}/annexes$`),
    name: 'location.annexe',
    roles: WRITERS,
    handle: withBody(async (s, v, [id], b) => reply(await core(s).listings.addAnnex(v, id, { kind: b.kind, ref: b.ref, diagnosedOn: b.diagnosedOn }))),
  },
  { method: 'POST', pattern: new RegExp(`^/location/${ID}/controle$`), name: 'location.controle', roles: WRITERS, handle: async (s, v, [id]) => reply(await core(s).listings.check(v, id)) },
  { method: 'GET', pattern: new RegExp(`^/location/${ID}/echeances$`), name: 'location.echeances', roles: READERS, handle: async (s, v, [id]) => reply(await core(s).listings.notices(v, id)) },

  /* Honoraires et dépôt de garantie (W02) [R102]. */
  { method: 'GET', pattern: /^\/location\/zones$/, name: 'location.zones', roles: ['direction'], handle: async (s, v, _p, r) => reply(await core(s).fees.zonesOf(v, new URL(r.url).searchParams.get('insee') ?? '')) },
  {
    method: 'POST',
    pattern: /^\/location\/zones$/,
    name: 'location.zone',
    roles: ['direction'],
    handle: withBody(async (s, v, _p, b) => reply(await core(s).fees.recordZone(v, { inseeCode: b.inseeCode, zone: b.zone, effectiveFrom: b.effectiveFrom, source: b.source }))),
  },
  { method: 'POST', pattern: new RegExp(`^/location/${ID}/commune$`), name: 'location.commune', roles: WRITERS, handle: withBody(async (s, v, [id], b) => reply(await core(s).fees.setCommune(v, id, b.inseeCode))) },
  { method: 'GET', pattern: new RegExp(`^/location/${ID}/plafonds$`), name: 'location.plafonds', roles: READERS, handle: async (s, v, [id]) => reply(await core(s).fees.ceilings(v, id)) },
  {
    method: 'POST',
    pattern: new RegExp(`^/location/${ID}/honoraires$`),
    name: 'location.honoraires',
    roles: WRITERS,
    handle: withBody(async (s, v, [id], b) =>
      reply(
        await core(s).fees.record(v, id, {
          tenantCents: b.tenantCents,
          tenantInventoryCents: b.tenantInventoryCents,
          landlordCents: b.landlordCents,
          landlordInventoryCents: b.landlordInventoryCents,
          depositCents: b.depositCents,
        }),
      ),
    ),
  },

  /* L'annonce (W03) [R103]. */
  { method: 'POST', pattern: new RegExp(`^/location/${ID}/annonces/brouillon$`), name: 'location.annonce.brouillon', roles: WRITERS, handle: async (s, v, [id]) => reply(await core(s).ads.draft(v, id)) },
  {
    method: 'POST',
    pattern: new RegExp(`^/location/${ID}/annonces$`),
    name: 'location.annonce.ecrite',
    roles: WRITERS,
    handle: withBody(async (s, v, [id], b) => reply(await core(s).ads.write(v, id, { title: b.title, body: b.body }))),
  },
  { method: 'GET', pattern: new RegExp(`^/location/${ID}/annonces$`), name: 'location.annonces', roles: READERS, handle: async (s, v, [id]) => reply(await core(s).ads.list(v, id)) },
  { method: 'POST', pattern: new RegExp(`^/location/annonces/${ID}/validation$`), name: 'location.annonce.validation', roles: ['agent'], handle: async (s, v, [id]) => reply(await core(s).ads.validate(v, id)) },

  /* Les candidatures (W04) [R104]. */
  {
    method: 'POST',
    pattern: new RegExp(`^/location/${ID}/candidatures$`),
    name: 'location.candidature',
    roles: WRITERS,
    handle: withBody(async (s, v, [id], b) => reply(await core(s).applications.apply(v, id, { personId: b.personId, dossierFacileUrl: b.dossierFacileUrl }))),
  },
  { method: 'GET', pattern: new RegExp(`^/location/${ID}/contacts$`), name: 'location.contacts', roles: WRITERS, handle: async (s, v, [id]) => reply(await core(s).applications.addableContacts(v, id)) },
  { method: 'GET', pattern: new RegExp(`^/location/${ID}/candidatures$`), name: 'location.candidatures', roles: READERS, handle: async (s, v, [id]) => reply(await core(s).applications.list(v, id)) },
  { method: 'GET', pattern: new RegExp(`^/location/candidatures/${ID}$`), name: 'location.candidature.lue', roles: READERS, handle: async (s, v, [id]) => reply(await core(s).applications.read(v, id)) },
  {
    method: 'POST',
    pattern: new RegExp(`^/location/candidatures/${ID}/garants$`),
    name: 'location.candidature.garant',
    roles: WRITERS,
    handle: withBody(async (s, v, [id], b) => reply(await core(s).applications.addGuarantor(v, id, { kind: b.kind, personId: b.personId }))),
  },
  {
    // AU097 · un colocataire ajouté ou retiré : un locataire de plus du même bail, avec ses pièces et sa signature.
    method: 'POST',
    pattern: new RegExp(`^/location/candidatures/${ID}/colocataires$`),
    name: 'location.candidature.colocataire',
    roles: WRITERS,
    handle: withBody(async (s, v, [id], b) => reply(await core(s).applications.setCotenant(v, id, { personId: b.personId, action: b.action }))),
  },
  {
    method: 'POST',
    pattern: new RegExp(`^/location/candidatures/${ID}/pieces$`),
    name: 'location.candidature.piece',
    roles: WRITERS,
    handle: withBody(async (s, v, [id], b) => reply(await core(s).applications.addPiece(v, id, { holder: b.holder, sort: b.sort, ref: b.ref, sha256: b.sha256 }))),
  },

  /* La présentation au propriétaire et son choix (W05) [R105]. */
  { method: 'POST', pattern: new RegExp(`^/location/${ID}/presentation$`), name: 'location.presentation', roles: WRITERS, handle: async (s, v, [id]) => reply(await core(s).choices.present(v, id)) },
  {
    method: 'POST',
    pattern: new RegExp(`^/location/${ID}/choix$`),
    name: 'location.choix',
    roles: WRITERS,
    handle: withBody(async (s, v, [id], b) =>
      reply(await core(s).choices.recordChoice(v, id, { presentationId: b.presentationId, applicationId: b.applicationId, decidedAt: b.decidedAt, channel: b.channel, proofRef: b.proofRef })),
    ),
  },
  {
    method: 'GET',
    pattern: new RegExp(`^/location/${ID}/presentations/${ID}/recus$`),
    name: 'location.recus',
    roles: READERS,
    handle: async (s, v, [id, pid]) => reply(await core(s).choices.receipts(v, id, pid)),
  },

  /* Le bail (W06) et sa signature en ligne (W12) [R101, R102, R105, R108]. */
  { method: 'POST', pattern: /^\/location\/modeles-bail$/, name: 'location.modele_bail', roles: ['direction'], handle: withBody(async (s, v, _p, b) => reply(await core(s).leases.createTemplate(v, b.kind, b.body))) },
  {
    method: 'POST',
    pattern: new RegExp(`^/location/modeles-bail/${ID}/validation$`),
    name: 'location.modele_bail.validation',
    roles: ['compliance'],
    handle: async (s, v, [id]) => reply(await core(s).leases.validateTemplate(v, id)),
  },
  {
    method: 'POST',
    pattern: new RegExp(`^/location/${ID}/bail$`),
    name: 'location.bail',
    roles: WRITERS,
    handle: withBody(async (s, v, [id], b) =>
      reply(await core(s).leases.generate(v, id, { address: b.address, ownerAddress: b.ownerAddress, habitat: b.habitat, equipment: b.equipment, professionalCard: b.professionalCard, noticeRef: b.noticeRef, landlord: b.landlord, variant: b.variant })),
    ),
  },
  {
    method: 'POST',
    pattern: new RegExp(`^/location/${ID}/bail/signatures$`),
    name: 'location.bail.signature_ouverte',
    roles: WRITERS,
    handle: withBody(async (s, v, [id], b) => reply(await core(s).signatures.start(v, id, { party: b.party, personId: b.personId, consentProof: b.consentProof }))),
  },
  {
    method: 'POST',
    pattern: new RegExp(`^/location/signatures-bail/${ID}$`),
    name: 'location.bail.signature',
    roles: WRITERS,
    handle: withBody(async (s, v, [id], b) => reply(await core(s).signatures.sign(v, id, { code: b.code, drawing: b.drawing }))),
  },
  { method: 'GET', pattern: new RegExp(`^/location/${ID}/bail/texte$`), name: 'location.bail.texte', roles: WRITERS, handle: async (s, v, [id]) => reply(await core(s).signatures.text(v, id)) },
  { method: 'POST', pattern: new RegExp(`^/location/${ID}/bail/exemplaires$`), name: 'location.bail.exemplaires', roles: WRITERS, handle: async (s, v, [id]) => reply(await core(s).signatures.sendCopies(v, id)) },
  {
    method: 'GET',
    pattern: new RegExp(`^/location/${ID}/baux/${ID}/exemplaire$`),
    name: 'location.bail.exemplaire',
    roles: WRITERS,
    handle: async (s, v, [id, leaseId]) => reply(await core(s).signatures.copy(v, id, leaseId)),
  },

  /* L'état des lieux d'entrée (W07) [R106]. */
  {
    method: 'POST',
    pattern: new RegExp(`^/location/${ID}/etat-des-lieux$`),
    name: 'location.etat_des_lieux',
    roles: WRITERS,
    handle: withBody(async (s, v, [id], b) =>
      reply(await core(s).inventories.record(v, id, { address: b.address, ownerAddress: b.ownerAddress, rooms: b.rooms, meters: b.meters, keys: b.keys, furniture: b.furniture })),
    ),
  },
  {
    method: 'POST',
    pattern: new RegExp(`^/location/etats-des-lieux/${ID}/signatures$`),
    name: 'location.etat_des_lieux.signature',
    roles: WRITERS,
    handle: withBody(async (s, v, [id], b) => reply(await core(s).inventories.sign(v, id, { party: b.party, contentSha256: b.contentSha256, drawing: b.drawing }))),
  },
  {
    method: 'GET',
    pattern: new RegExp(`^/location/etats-des-lieux/${ID}/exemplaires/(bailleur|locataire)$`),
    name: 'location.etat_des_lieux.exemplaire',
    roles: WRITERS,
    handle: async (s, v, [id, party]) => reply(await core(s).inventories.copy(v, id, party)),
  },

  /* La remise des clés et la gestion par un partenaire carte G (W08) [R107, R74, R73]. */
  { method: 'POST', pattern: new RegExp(`^/location/${ID}/remise-des-cles$`), name: 'location.remise_des_cles', roles: WRITERS, handle: withBody(async (s, v, [id], b) => reply(await core(s).handovers.handOver(v, id, { handedOn: b.handedOn }))) },
  { method: 'GET', pattern: new RegExp(`^/location/${ID}/remise-des-cles$`), name: 'location.remise_des_cles.lue', roles: READERS, handle: async (s, v, [id]) => reply(await core(s).handovers.state(v, id)) },
  { method: 'GET', pattern: new RegExp(`^/location/${ID}/honoraires-dus$`), name: 'location.honoraires_dus', roles: READERS, handle: async (s, v, [id]) => reply(await core(s).handovers.feesDue(v, id)) },
  { method: 'POST', pattern: new RegExp(`^/location/${ID}/gestion$`), name: 'location.gestion', roles: WRITERS, handle: withBody(async (s, v, [id], b) => reply(await core(s).handovers.linkManagement(v, id, b.referralId))) },
];

/**
 * Les routes de M15, prêtes pour le routeur du socle (W10) : chacune contrôle le rôle avant tout, écrit le refus au
 * journal, puis passe la main à la couche métier [R16].
 */
export function locationRoutes(): LocationRoute[] {
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
