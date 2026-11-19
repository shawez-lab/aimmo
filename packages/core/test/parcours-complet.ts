// SV04 · Le parcours complet fictif de chaque mois : un seul scénario inventé traverse les vrais modules, du premier
// message à l'après-vente. Chaque étape est vérifiée par ses données et par son journal ; une étape cassée se nomme.
// Tout est inventé : personnes, adresses, biens, ventes. Tourne en mémoire, jamais sur une vraie base.
import {
  Acces,
  AvisDeValeur,
  CompleterNom,
  ControlesSignature,
  Diffusion,
  NouveauBien,
  Fourchette,
  Modeles,
  RegistreMandats,
  RendezVous,
  SignaturePapier,
  SqlJournalStore,
  Visites,
  applyMigrations,
  createCaptation,
  euros,
  fromSyncSqlite,
  parisInstant,
  type JournalEntry,
  type OutboundChannel,
  type Sale,
  type SqlDatabase,
  type Viewer,
} from '../src/index.ts';
import { Annonces, CHANNELS, FicheBien, MentionsAnnonce, Publication, type Channel, type ListingChannel, type ListingPayload } from '../src/annonces/index.ts';
import { CarnetsProprietaire, DemandesAvis, REVIEW_PURPOSE, SqlBiensVendus, SqlDossiersClos } from '../src/apres-vente/index.ts';
import { ActeVente, Echeancier, PiecesDossier, type PieceStore } from '../src/dossiers/index.ts';
import { lieuConnu } from './dossiers-jeu.ts';
import { DossiersVente, RegistreOffres, TransmissionOffres } from '../src/offres/index.ts';
import { identiteAuCoffre } from './identite-coffre.ts';
import { loadMigrations } from './migrations.ts';
import { openMemoryDatabase } from './sqlite.ts';
import { designerTout } from './designation-jeu.ts';
import { rangerStatut } from './statut-agent-jeu.ts';

export interface JourneyStep<W> {
  /** L'identifiant de l'étape, celui que nomme une panne. */
  readonly id: string;
  /** L'étape en français, telle qu'on la lit dans le compte rendu. */
  readonly label: string;
  /** Les événements que cette étape doit avoir écrits au journal. */
  readonly events: readonly string[];
  /** Fait l'étape avec les vrais modules, et vérifie ce qu'elle a rangé ; lève une erreur si quelque chose manque. */
  run(world: W): Promise<void>;
}

export type JourneyResult =
  | { ok: true; done: readonly string[] }
  | { ok: false; done: readonly string[]; failed: { step: string; label: string; reason: string }; notRun: readonly string[] };

/** Déroule les étapes dans l'ordre ; la première cassée arrête tout et se nomme : les suivantes sont dites non jouées. */
export async function runJourney<W extends { readEntries(): Promise<readonly JournalEntry[]> }>(
  world: W,
  steps: readonly JourneyStep<W>[],
  options: { beforeStep?: (id: string) => Promise<void> } = {},
): Promise<JourneyResult> {
  const done: string[] = [];
  for (const [index, step] of steps.entries()) {
    const failure = (reason: string): JourneyResult => ({
      ok: false,
      done,
      failed: { step: step.id, label: step.label, reason },
      notRun: steps.slice(index + 1).map((s) => s.id),
    });
    try {
      await options.beforeStep?.(step.id);
      const before = (await world.readEntries()).length;
      await step.run(world);
      const written = new Set((await world.readEntries()).slice(before).map((e) => e.type));
      const missing = step.events.filter((type) => !written.has(type));
      if (missing.length > 0) return failure(`journal sans ${missing.join(', ')}`);
    } catch (error) {
      return failure(error instanceof Error ? error.message : 'erreur inconnue');
    }
    done.push(step.id);
  }
  return { ok: true, done };
}

/** Une vérification de données : son texte nomme ce qui manque. */
export function must(condition: unknown, what: string): asserts condition {
  if (!condition) throw new Error(what);
}

function accepted<R extends { ok: boolean }>(result: R, what: string): Extract<R, { ok: true }> {
  if (!result.ok) throw new Error(`${what} refusé : ${JSON.stringify(result)}`);
  return result as Extract<R, { ok: true }>;
}

const paris = (day: string, hhmm: string): Date => {
  const [h, m] = hhmm.split(':').map(Number) as [number, number];
  return parisInstant(day, h * 60 + m)!;
};

const MANDATE = 'Mandat de test : {{mandant.nom}}, {{bien.prix}}, {{honoraires.montant}} {{honoraires.charge}}, {{mandat.duree_mois}}.\n\nNuméro : {{registre.numero}} · {{bien.adresse}} · {{bien.cadastre}} · {{mandant.domicile}}.';
const SLIP = 'BON DE VISITE · {{reseau.nom}}\n\nJe soussigné {{visiteur.nom}} reconnais avoir visité le bien {{bien.reference}}, {{bien.type}} à {{bien.commune}}, {{bien.surface}}, {{bien.pieces}} pièces, au prix de {{bien.prix}}, le {{visite.date}} à {{visite.heure}}, avec {{agent.nom}}.\n\nFait le {{signature.date}}.';
export const SELLER_EMAIL = 'lea.vendeuse@example.test';
export const BUYER_EMAIL = 'noe.acheteur@example.test';
export const SELLER_LAST_NAME = 'Vendeuse';
export const BUYER_LAST_NAME = 'Acheteur';
const REVIEW_LINK = 'https://g.page/r/CexempleParcours/review';
const PROOF = 'preuves/0b6f1d2e-9999-4a2b-8c3d-00000000a001.pdf';
const ACT_PROOF = 'preuves/0b6f1d2e-7777-4a2b-8c3d-00000000a002.pdf';
const SIGNED_OFFER = 'offres/0b6f1d2e-1111-4a2b-8c3d-00000000a003.pdf';

/** Des ventes inventées autour d'un point fictif. */
const SALES: readonly Sale[] = Array.from({ length: 14 }, (_, i) => ({
  id: `parcours:${i}`,
  kind: 'apartment' as const,
  lat: 47.3225 + i * 0.0002,
  lon: 5.0412,
  surface: 55 + i,
  pricePerM2: 2800 + i * 20,
  month: `2026-0${(i % 9) + 1}`,
}));
const SALES_SOURCE = {
  coverage: async () => ({ department: '21', lastSale: '2026-09-30', years: [2024, 2025, 2026], source: 'Ventes inventées du parcours' }),
  within: async (kind: Sale['kind']) => SALES.filter((s) => s.kind === kind),
};

/** Le portail d'essai du parcours : il garde ce qu'il reçoit, rien ne sort. */
class HeldPortal implements ListingChannel {
  readonly received: ListingPayload[] = [];
  constructor(readonly channel: Channel) {}
  async push(payload: ListingPayload): Promise<void> {
    this.received.push(payload);
  }
}

class HeldPieces implements PieceStore {
  readonly refs = new Set<string>();
  async has(ref: string): Promise<boolean> {
    return this.refs.has(ref);
  }
}

/**
 * Le piège de l'envoi réel : un vrai canal branché, comme en production, qui compte ce qu'on lui demande. Il ne doit
 * jamais être appelé : les paliers restent en essai pendant tout le parcours [R26].
 */
export class TrapChannel implements OutboundChannel {
  calls = 0;
  constructor(readonly channel: OutboundChannel['channel']) {}
  async deliver(): Promise<never> {
    this.calls += 1;
    throw new Error('envoi réel tenté');
  }
}

export async function journeyWorld() {
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  let clock = paris('2027-02-01', '09:00');
  const now = () => clock;
  const setClock = (at: Date) => {
    clock = at;
  };
  const journal = new SqlJournalStore(db);
  const trap = [new TrapChannel('email'), new TrapChannel('sms'), new TrapChannel('whatsapp')];
  const captation = createCaptation(db, journal, { now, realChannels: trap });
  const { store, acces } = captation;

  // Le réseau tel qu'il est avant le premier message : un agent, sa zone, ses modèles validés, son registre.
  const network = await store.createNetwork('Réseau du parcours');
  const alex = await store.createAgent({ networkId: network.id, firstName: 'Alex', lastName: 'Parcours' });
  const as = (role: string, userId: string): Viewer => ({ role, userId, networkId: network.id }) as Viewer;
  const agent = as('agent', alex.id);
  const direction = as('direction', 'direction-parcours');
  await captation.attribution.addZone(network.id, alex.id, 'Dijon');
  const modeles = new Modeles(db, acces, journal, { now });
  const template = await modeles.createVersion(direction, 'mandat_vente_simple', MANDATE);
  if (!template.ok) throw new Error(template.code);
  await modeles.validate(as('compliance', 'conformite-parcours'), template.template.id);
  await new ControlesSignature(db, acces, journal, { now }).setFeeSchedule(direction, { maxRatePercent: 6, minEur: 0 });
  await new RegistreMandats(db, journal, { now }).configure(direction, { prefix: 'P-', firstNumber: 1, width: 3 });
  await new MentionsAnnonce(db, acces, journal, { now }).setCardNumber(direction, 'CPI 2101 2027 000 000 002');
  await rangerStatut(db, journal, now, direction, [alex.id]);

  const portals = CHANNELS.map((c) => new HeldPortal(c));
  const pieces = new HeldPieces();
  return {
    db, journal, captation, store, acces, modeles, network, alexId: alex.id, agent, direction, as, trap, portals, pieces, now, setClock,
    readEntries: () => journal.all(),
    /** Ce que le parcours se transmet d'une étape à la suivante. */
    reference: '', seller: '', buyer: '', buyerProject: '', propertyId: '', mandateId: '', appointmentId: '', offerId: '', fileId: '',
  };
}

export type JourneyWorld = Awaited<ReturnType<typeof journeyWorld>>;

/** La personne derrière une adresse de mail, telle que la réception l'a rangée. */
async function personOf(w: JourneyWorld, email: string): Promise<string> {
  const row = await w.db.first<{ person_id: string }>("SELECT person_id FROM person_identifiers WHERE network_id = ? AND kind = 'email' AND value = ?", [w.network.id, email]);
  must(row, `aucune fiche pour ${email}`);
  return row.person_id;
}

export const JOURNEY: readonly JourneyStep<JourneyWorld>[] = [
  {
    id: 'premier_message',
    label: 'Un vendeur écrit, il reçoit sa réponse',
    events: ['envoi.essai'],
    async run(w) {
      const [r] = await w.captation.chaine.receive(w.network.id, 'site_form', {
        submissionId: 'parcours-vendeur',
        firstName: 'Léa',
        email: SELLER_EMAIL,
        message: 'Bonjour, je souhaite vendre mon appartement à Dijon rapidement. Pouvez-vous l’estimer ?',
      });
      must(r?.status === 'replied', `réponse attendue, reçu ${String(r?.status)}`);
      w.seller = await personOf(w, SELLER_EMAIL);
      const incoming = await w.db.all("SELECT id FROM messages WHERE person_id = ? AND direction = 'in'", [w.seller]);
      must(incoming.length === 1, 'le message du vendeur n’est pas dans sa fiche');
      const reply = await w.db.all('SELECT m.id FROM messages m JOIN trial_outbox o ON o.message_id = m.id WHERE m.person_id = ?', [w.seller]);
      must(reply.length === 1, 'la réponse n’est pas dans la boîte d’essai');
    },
  },
  {
    id: 'qualification',
    label: 'Le contact est classé, attribué, et l’agent le rappelle',
    events: ['rappel.fait'],
    async run(w) {
      const q = await w.db.first<{ category: string }>('SELECT category FROM qualifications WHERE person_id = ?', [w.seller]);
      must(q?.category === 'seller', `vendeur attendu, reçu ${String(q?.category)}`);
      const a = await w.captation.attribution.current(w.seller);
      must(a?.agent_id === w.alexId, 'le contact n’est pas attribué à l’agent de la zone');
      const hot = accepted(await w.captation.rappels.hotList(w.acces, w.agent), 'liste des rappels');
      const task = hot.value.contacts.find((c) => c.personId === w.seller);
      must(task, 'aucune tâche de rappel');
      must(await w.captation.rappels.done(w.acces, w.agent, task.taskId), 'rappel non noté');
    },
  },
  {
    id: 'rendez_vous',
    label: 'Le rendez-vous d’estimation est pris',
    events: ['bien.cree', 'rdv.reserve'],
    async run(w) {
      const created = accepted(await new NouveauBien(w.db, w.acces, w.journal, { now: w.now }).create(w.agent, w.seller, { requestId: crypto.randomUUID(), kind: 'home', postalCode: '21000', city: 'Dijon', surfaceM2: 62, rooms: 3, priceEur: 200000 }), 'bien');
      const b = { id: created.value.propertyId };
      w.propertyId = b.id;
      w.reference = created.value.reference;
      const owned = await w.db.first("SELECT 1 AS ok FROM project_properties pp JOIN projects p ON p.id = pp.project_id WHERE p.person_id = ? AND p.kind = 'sell' AND pp.property_id = ? AND pp.role = 'owned'", [w.seller, b.id]);
      must(owned, 'le bien n’est pas lié à son vendeur');
      const rdv = new RendezVous(w.db, w.journal, { now: w.now });
      accepted(await rdv.setAvailability(w.agent, { weekly: [1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, from: '09:00', to: '19:00' })) }), 'agenda');
      const booked = accepted(await rdv.book({ networkId: w.network.id, agentId: w.alexId, personId: w.seller, propertyId: b.id, kind: 'estimation', start: paris('2027-02-03', '10:00'), source: 'agent' }), 'rendez-vous');
      w.appointmentId = booked.appointment.id;
      must((await rdv.get(booked.appointment.id))?.status === 'booked', 'rendez-vous non rangé');
    },
  },
  {
    id: 'estimation',
    label: 'L’avis de valeur est fait, puis validé par l’agent',
    events: ['avis.valide'],
    async run(w) {
      w.setClock(paris('2027-02-03', '11:00'));
      const range = await new Fourchette(SALES_SOURCE, undefined, w.now).estimate({ kind: 'apartment', surface: 62, lat: 47.3225, lon: 5.0412, postalCode: '21000' });
      must(range.ok, 'aucune fourchette');
      const avis = new AvisDeValeur(w.db, w.journal, { now: w.now });
      const draft = await avis.draft({ networkId: w.network.id, propertyId: w.propertyId, kind: 'apartment', surface: 62, range });
      accepted(await avis.validate(w.agent, draft.id), 'avis');
      const row = await w.db.first<{ status: string; validated_by: string }>('SELECT status, validated_by FROM valuation_reports WHERE id = ?', [draft.id]);
      must(row?.status === 'validated' && row.validated_by === w.alexId, 'avis non validé par l’agent');
    },
  },
  {
    id: 'mandat',
    label: 'Le mandat est signé et inscrit au registre',
    events: ['fiche.nom_complete', 'registre.inscrit', 'mandat.signe'],
    async run(w) {
      const signedAt = paris('2027-02-10', '10:00');
      accepted(await new CompleterNom(w.db, w.acces, w.journal, { now: w.now }).complete(w.agent, w.seller, { lastName: SELLER_LAST_NAME }), 'nom du vendeur');
      w.setClock(paris('2027-02-10', '11:00'));
      accepted(await identiteAuCoffre({ db: w.db, acces: w.acces, journal: w.journal, now: w.now }, w.agent, w.seller, { piece: 'carte_identite', seenAt: signedAt }), 'identité du vendeur');
      accepted(
        await new FicheBien(w.db, w.acces, w.journal, { now: w.now }).save(w.agent, w.propertyId, {
          characteristics: { bedrooms: 2, floor: 3, floorsTotal: 5, buildYear: 1965, heating: 'collectif', outdoor: ['balcon'], parkingSpaces: 1, elevator: true },
          energy: { energyClass: 'D', climateClass: 'C', annualCostMinEur: 1100, annualCostMaxEur: 1550, costReferenceYear: 2023, diagnosedOn: '2027-01-15' },
          coownership: { isCoownership: true, lots: 24, annualChargesEur: 1800, proceedings: false },
          risks: { inRiskZone: false },
          media: [{ ref: `biens/${w.propertyId}/0b6f1d2e-1111-4a2b-8c3d-00000000b001.jpg`, kind: 'photo', edit: 'lumiere_cadrage' }],
        }),
        'fiche du bien',
      );
      await designerTout(w.db);
      const d = await w.modeles.generate(w.agent, { kind: 'mandat_vente_simple', personId: w.seller, propertyId: w.propertyId, inputs: { 'honoraires.montant': 10000, 'honoraires.charge': 'acquereur', 'mandat.duree_mois': 12 } });
      if (!d.ok) throw new Error(`mandat refusé : ${d.code}`);
      const signed = accepted(await new SignaturePapier(w.db, w.acces, w.journal, { now: w.now }).register(w.agent, d.document.id, { signedAt, place: 'hors_agence', scanRef: 'scans/mandat-parcours.pdf', source: 'referral' }), 'signature');
      w.mandateId = signed.value.mandateId;
      const line = await w.db.first<{ number: string }>("SELECT number FROM mandate_register WHERE mandate_id = ? AND kind = 'inscription'", [w.mandateId]);
      must(line?.number === 'P-001', `numéro du registre attendu P-001, reçu ${String(line?.number)}`);
    },
  },
  {
    id: 'annonce',
    label: 'L’annonce est validée, puis publiée une fois le délai passé',
    events: ['annonce.validee', 'annonce.publiee', 'bien.disponible'],
    async run(w) {
      const annonces = new Annonces(w.db, w.acces, w.journal, { now: w.now });
      const publication = new Publication(w.db, w.acces, w.journal, { now: w.now, channels: w.portals });
      const draft = accepted(await annonces.propose(w.agent, w.propertyId), 'annonce');
      accepted(await annonces.validate(w.agent, draft.value.id), 'validation de l’annonce');
      // Pendant le délai de rétractation, rien ne sort [R42].
      await publication.sync(w.network.id, w.propertyId);
      must(w.portals.every((p) => p.received.length === 0), 'annonce sortie pendant le délai de rétractation');
      const held = await w.db.first<{ status: string }>('SELECT status FROM properties WHERE id = ?', [w.propertyId]);
      must(held?.status === 'draft', 'bien dit disponible pendant le délai de rétractation');
      w.setClock(paris('2027-02-25', '10:00'));
      const r = await publication.sync(w.network.id, w.propertyId);
      must(r.created, 'annonce non publiée après le délai');
      must(w.portals.every((p) => p.received.length === 1), 'un portail n’a pas reçu l’annonce');
      const listed = await w.db.first<{ status: string }>('SELECT status FROM properties WHERE id = ?', [w.propertyId]);
      must(listed?.status === 'available', `bien disponible attendu, reçu ${String(listed?.status)}`);
    },
  },
  {
    id: 'acquereur',
    label: 'Un acquéreur écrit au sujet du bien',
    events: ['envoi.essai', 'qualification.rangee', 'acquereur.fiche'],
    async run(w) {
      w.setClock(paris('2027-02-26', '10:00'));
      const [r] = await w.captation.chaine.receive(w.network.id, 'site_form', {
        submissionId: 'parcours-acquereur',
        firstName: 'Noé',
        email: BUYER_EMAIL,
        message: 'Bonjour, je cherche à acheter à Dijon, je voudrais visiter cet appartement. Mon budget est de 210 000 €.',
        propertyRef: w.reference,
      });
      must(r?.status === 'replied', `réponse attendue, reçu ${String(r?.status)}`);
      w.buyer = await personOf(w, BUYER_EMAIL);
      const reply = await w.db.first<{ body: string }>('SELECT m.body FROM messages m JOIN trial_outbox o ON o.message_id = m.id WHERE m.person_id = ?', [w.buyer]);
      must(reply?.body.includes('est disponible'), 'la réponse ne dit pas que le bien publié est disponible');
      const published = w.portals[0]!.received.at(-1)!.priceEur;
      must(published !== null && published !== 200000, 'le jeu doit distinguer le prix publié de celui de la fiche');
      must(reply?.body.includes(euros(published)), 'la réponse ne donne pas le prix de l’annonce');
      const q = await w.db.first<{ category: string }>('SELECT category FROM qualifications WHERE person_id = ?', [w.buyer]);
      must(q?.category === 'buyer', `acquéreur attendu, reçu ${String(q?.category)}`);
      const project = await w.db.first<{ id: string }>("SELECT id FROM projects WHERE person_id = ? AND kind = 'buy'", [w.buyer]);
      must(project, 'aucun projet d’achat');
      w.buyerProject = project.id;
      const interested = await w.db.first('SELECT 1 AS ok FROM project_properties WHERE project_id = ? AND property_id = ? AND role = ?', [project.id, w.propertyId, 'interested']);
      must(interested, 'le message de l’acquéreur n’est pas relié au bien');
      must((await w.captation.attribution.current(w.buyer))?.agent_id === w.alexId, 'l’acquéreur n’est pas attribué à l’agent de la zone');
    },
  },
  {
    id: 'visite',
    label: 'La visite est fixée et le bon de visite signé',
    events: ['fiche.nom_complete', 'visite.fixee', 'bon_visite.signe'],
    async run(w) {
      w.setClock(paris('2027-03-01', '10:00'));
      accepted(await new CompleterNom(w.db, w.acces, w.journal, { now: w.now }).complete(w.agent, w.buyer, { lastName: BUYER_LAST_NAME }), 'nom de l’acquéreur');
      const rdv = new RendezVous(w.db, w.journal, { now: w.now });
      const diffusion = new Diffusion(w.db, w.acces, w.journal, { now: w.now });
      const visites = new Visites(w.db, w.journal, w.acces, { diffusion, rendezVous: rdv, now: w.now });
      const tpl = await visites.createSlipTemplate(w.direction, SLIP);
      if (!tpl.ok) throw new Error(`modèle refusé : ${tpl.code}`);
      accepted(await visites.validateSlipTemplate(w.as('compliance', 'conformite-parcours'), tpl.id), 'modèle de bon');
      const v = await visites.schedule(w.agent, { propertyId: w.propertyId, projectId: w.buyerProject, start: paris('2027-03-02', '10:00') });
      if (!v.ok) throw new Error(`visite refusée : ${v.code}`);
      w.setClock(paris('2027-03-02', '11:00'));
      const signed = await visites.recordPaperSignature(w.agent, v.visit.appointment.id, { signedAt: paris('2027-03-02', '10:30'), scanRef: 'scans/bon-parcours.pdf' });
      if (!signed.ok) throw new Error(`bon refusé : ${signed.code}`);
      must(signed.slip.signedAt !== null, 'bon de visite sans signature');
    },
  },
  {
    id: 'offre',
    label: 'L’offre est reçue, transmise au vendeur, acceptée',
    events: ['offre.enregistree', 'offre.transmise', 'offre.reponse'],
    async run(w) {
      w.setClock(paris('2027-03-03', '10:00'));
      const offer = accepted(
        await new RegistreOffres(w.db, w.acces, w.journal, { now: w.now }).record(w.agent, w.propertyId, {
          buyerPersonId: w.buyer,
          amountEur: 195000,
          conditions: [{ kind: 'pret', amountEur: 150000, durationMonths: 240 }],
          validUntil: '2027-03-12',
          downPaymentEur: 60000,
          loanEur: 150000,
          signedRef: SIGNED_OFFER,
          receivedAt: paris('2027-03-03', '09:30').toISOString(),
        }),
        'offre',
      );
      w.offerId = offer.value.id;
      const transmission = new TransmissionOffres(w.db, w.acces, w.journal, { now: w.now });
      accepted(await transmission.transmit(w.agent, w.offerId, { via: 'telephone' }), 'transmission');
      w.setClock(paris('2027-03-03', '12:00'));
      accepted(await transmission.respond(w.agent, w.offerId, { outcome: 'acceptee', proofRef: PROOF, respondedAt: paris('2027-03-03', '11:00').toISOString() }), 'réponse du vendeur');
    },
  },
  {
    id: 'compromis_acte',
    label: 'Le dossier suit le compromis jusqu’à l’acte',
    events: ['dossier.ouvert', 'dossier.compromis_en_preparation', 'dossier.acte_signe'],
    async run(w) {
      const dossiers = new DossiersVente(w.db, w.acces, w.journal, { now: w.now });
      w.fileId = accepted(await dossiers.open(w.agent, w.offerId), 'dossier').value.id;
      must(await w.db.first('SELECT 1 AS ok FROM sale_file_sellers WHERE file_id = ? AND person_id = ?', [w.fileId, w.seller]), 'le vendeur n’est pas au dossier');
      accepted(await identiteAuCoffre({ db: w.db, acces: w.acces, journal: w.journal, now: w.now }, w.agent, w.buyer, { piece: 'passeport', seenAt: w.now() }), 'identité de l’acquéreur');
      accepted(await dossiers.startCompromis(w.agent, w.fileId), 'compromis');
      w.setClock(paris('2027-03-11', '09:00'));
      const echeancier = new Echeancier(w.db, w.acces, w.journal, { now: w.now });
      for (const [kind, day] of [['compromis_signe', '2027-03-10'], ['notification_acquereur', '2027-03-11'], ['dia_recue', '2027-03-11'], ['date_limite_pret', '2027-05-10']] as const) {
        accepted(await echeancier.record(w.agent, w.fileId, { kind, day, proofRef: PROOF }), `échéance ${kind}`);
      }
      // La commune du bien hors zone et le bien raccordé, rangés par la direction et l'agent (AU011).
      await lieuConnu(w, w.propertyId);
      const pieces = new PiecesDossier(w.db, w.acces, w.journal, w.pieces, { now: w.now });
      const status = accepted(await pieces.status(w.agent, w.fileId), 'pièces');
      let n = 0;
      for (const piece of status.value.missing) {
        const ref = `dossiers/${w.fileId}/0b6f1d2e-4444-4a2b-8c3d-${String(++n).padStart(12, '0')}.pdf`;
        w.pieces.refs.add(ref);
        accepted(await pieces.add(w.agent, w.fileId, { piece, ref, issuedOn: '2027-03-11' }), `pièce ${piece}`);
      }
      w.setClock(paris('2027-06-11', '09:00'));
      accepted(await new ActeVente(w.db, w.acces, w.journal, w.pieces, { now: w.now }).record(w.agent, w.fileId, { signedOn: '2027-06-10', proofRef: ACT_PROOF }), 'acte');
      const closed = await new SqlDossiersClos(w.db).byId(w.network.id, w.fileId);
      must(closed?.closedOn === '2027-06-10', 'le dossier n’est pas clos à la date de l’acte');
      const sold = await w.db.first<{ status: string }>('SELECT status FROM properties WHERE id = ?', [w.propertyId]);
      must(sold?.status === 'sold', `bien vendu attendu, reçu ${String(sold?.status)}`);
      await new Publication(w.db, w.acces, w.journal, { now: w.now, channels: w.portals }).sync(w.network.id, w.propertyId);
      must(w.portals.every((p) => p.received.at(-1)?.state === 'vendu'), 'les portails ne disent pas le bien vendu');
    },
  },
  {
    id: 'apres_vente',
    label: 'Les clients reçoivent la demande d’avis, le vendeur son carnet',
    events: ['apres_vente.demande_avis', 'apres_vente.carnet'],
    async run(w) {
      const dossiers = new SqlDossiersClos(w.db);
      const sale = await dossiers.byId(w.network.id, w.fileId);
      must(sale, 'dossier clos introuvable');
      for (const personId of [w.seller, w.buyer]) {
        await w.store.addConsent({ networkId: w.network.id, personId, purpose: REVIEW_PURPOSE, channel: 'email', proof: 'accord noté au dossier', givenAt: paris('2027-03-03', '12:00') });
      }
      const avis = new DemandesAvis(w.db, w.journal, dossiers, { now: w.now });
      accepted(await avis.setReviewLink(w.agent, w.alexId, REVIEW_LINK), 'lien d’avis');
      w.setClock(paris('2027-06-11', '10:05'));
      await avis.run(w.network.id);
      for (const personId of [w.seller, w.buyer]) {
        const held = await w.db.all<{ body: string }>('SELECT m.body FROM messages m JOIN trial_outbox o ON o.message_id = m.id WHERE m.person_id = ? AND m.body LIKE ?', [personId, `%${REVIEW_LINK}%`]);
        must(held.length === 1, 'demande d’avis absente de la boîte d’essai');
      }
      const carnets = new CarnetsProprietaire(w.db, w.journal, new SqlBiensVendus(w.db), SALES_SOURCE, { now: w.now, base: 'https://aimmo.example.test/carnet/' });
      const link = await carnets.create(w.network.id, sale, w.seller);
      must(link, 'carnet non fait');
      const read = await carnets.read(link.split('/').pop()!);
      must(read?.carnet, 'carnet illisible par son lien');
    },
  },
];
