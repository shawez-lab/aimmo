// Jeu de test commun aux tâches de M07 : un réseau, un bien, un vendeur et un mandat inventés, prêts à publier.
import {
  Acces,
  ControlesSignature,
  FicheClient,
  FicheUnique,
  Modeles,
  RegistreMandats,
  SignatureAvenant,
  SignaturePapier,
  SqlJournalStore,
  applyMigrations,
  fromSyncSqlite,
  type SqlDatabase,
  type Viewer,
} from '../src/index.ts';
import { Annonces, CHANNELS, FicheBien, MentionsAnnonce, Publication, type Channel, type ListingChannel, type ListingPayload } from '../src/annonces/index.ts';
import { loadMigrations } from './migrations.ts';
import { openMemoryDatabase } from './sqlite.ts';
import { identiteAuCoffre } from './identite-coffre.ts';
import { AmenagementsVirtuels } from '../src/medias/index.ts';
import { CertificatsPhotos } from '../src/studio/index.ts';
import { designerTout } from './designation-jeu.ts';
import { rangerStatut } from './statut-agent-jeu.ts';

// Réseau, bien, vendeur et mandat inventés.
const MANDATE = 'Mandat de test : {{mandant.nom}}, {{bien.prix}}, {{honoraires.montant}} {{honoraires.charge}}, {{mandat.duree_mois}}.\n\nNuméro : {{registre.numero}} · {{bien.adresse}} · {{bien.cadastre}} · {{mandant.domicile}}.';
const AMENDMENT = 'Avenant de test au mandat n° {{mandat.numero}} : {{avenant.objet}}.\n\nMandant : {{mandant.nom}}. Signé le {{signature.date}}, {{signature.lieu}}.';
export const SIGNED = new Date('2027-02-10T09:00:00.000Z'); // un mercredi, hors de l'agence : délai jusqu'au 24 février inclus
export const DELAY_END = new Date('2027-02-24T23:00:00.000Z'); // 25 février, 0 h à Paris
export const MIN = 60_000;

/** Un canal de test qui garde ce qu'il reçoit, et peut tomber en panne à la demande. */
export class FakeChannel implements ListingChannel {
  received: ListingPayload[] = [];
  failNext = 0;
  /** Quand il est posé, l'envoi attend qu'on le libère : un envoi lent, encore en cours. */
  gate: Promise<void> | null = null;
  constructor(readonly channel: Channel) {}
  async push(payload: ListingPayload): Promise<void> {
    if (this.gate) await this.gate;
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error('portail_indisponible');
    }
    this.received.push(payload);
  }
}

export async function setupAnnonce(options: { card?: boolean; statut?: boolean; twin?: boolean; diagnosedOn?: string; signedAt?: Date } = {}) {
  // Un autre jour de signature décale tout le jeu : l'horloge part une heure après.
  const signedAt = options.signedAt ?? SIGNED;
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  let clock = new Date(signedAt.getTime() + 60 * 60 * 1000);
  const now = () => clock;
  const journal = new SqlJournalStore(db);
  const store = new FicheClient(db, { now });
  const acces = new Acces(db, store, new FicheUnique(db, store, { now }), journal, { now });
  const modeles = new Modeles(db, acces, journal, { now });
  const controles = new ControlesSignature(db, acces, journal, { now });
  const network = await store.createNetwork('Réseau test');
  const alex = await store.createAgent({ networkId: network.id, firstName: 'Alex', lastName: 'Agent' });
  const sam = await store.createAgent({ networkId: network.id, firstName: 'Sam', lastName: 'Agent' });
  const as = (role: string, userId: string): Viewer => ({ role, userId, networkId: network.id }) as Viewer;
  const agent = as('agent', alex.id);
  const direction = as('direction', 'direction-1');
  for (const [kind, body] of [['mandat_vente_simple', MANDATE], ['avenant_mandat', AMENDMENT]] as const) {
    const v = await modeles.createVersion(direction, kind, body);
    if (!v.ok) throw new Error(v.code);
    await modeles.validate(as('compliance', 'c-1'), v.template.id);
  }
  await controles.setFeeSchedule(direction, { maxRatePercent: 6, minEur: 0 });
  await new RegistreMandats(db, journal, { now }).configure(direction, { prefix: 'T-', firstNumber: 1, width: 3 });
  const p = await store.createPerson({ networkId: network.id, agentId: alex.id, firstName: 'Léa', lastName: 'Exemple' });
  // AU070 : la nature du logement n'existe qu'après la migration 4011 (certains tests rejouent une base plus ancienne).
  const dwelling = (await db.all<{ name: string }>('PRAGMA table_info(properties)')).some((c) => c.name === 'dwelling') ? { dwelling: 'house' as const } : {};
  const b = await store.createProperty({ networkId: network.id, agentId: alex.id, reference: 'REF-T-1', kind: 'home', ...dwelling, postalCode: '21000', city: 'Dijon', surfaceM2: 62, rooms: 3, priceEur: 200000 });
  const project = await store.createProject({ networkId: network.id, agentId: alex.id, personId: p.id, kind: 'sell' });
  await store.linkProjectProperty({ networkId: network.id, agentId: alex.id, projectId: project.id, propertyId: b.id, role: 'owned' });
  await identiteAuCoffre({ db, acces, journal, now }, agent, p.id, { piece: 'carte_identite', seenAt: signedAt });
  await new FicheBien(db, acces, journal, { now }).save(agent, b.id, {
    characteristics: { bedrooms: 2, floor: 3, floorsTotal: 5, buildYear: 1965, heating: 'collectif', outdoor: ['balcon'], parkingSpaces: 1, elevator: true },
    energy: { energyClass: 'D', climateClass: 'C', annualCostMinEur: 1100, annualCostMaxEur: 1550, costReferenceYear: 2023, diagnosedOn: options.diagnosedOn ?? '2027-01-15' },
    coownership: { isCoownership: true, lots: 24, annualChargesEur: 1800, proceedings: false },
    risks: { inRiskZone: false },
    media: [
      { ref: `biens/${b.id}/0b6f1d2e-1111-4a2b-8c3d-000000000001.jpg`, kind: 'photo', edit: 'lumiere_cadrage' },
      { ref: `biens/${b.id}/0b6f1d2e-2222-4a2b-8c3d-000000000002.jpg`, kind: 'photo', edit: 'amenagement_virtuel' },
      { ref: `biens/${b.id}/0b6f1d2e-3333-4a2b-8c3d-000000000003.mp4`, kind: 'video', edit: 'aucune' },
    ],
  });
  // La photo aménagée a sa jumelle réelle déclarée, tirée du même cliché (HX41) : elle part juste après elle [R494].
  // Un test qui s'arrête à une migration plus ancienne n'a pas encore les jumelles : il s'en passe.
  const hasTwins = (await db.first<{ n: number }>("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'virtual_stagings'"))!.n === 1;
  if (options.twin !== false && hasTwins) {
    const real = `biens/${b.id}/0b6f1d2e-1111-4a2b-8c3d-000000000001.jpg`;
    const staged = `biens/${b.id}/0b6f1d2e-2222-4a2b-8c3d-000000000002.jpg`;
    const original = `biens/${b.id}/originaux/0b6f1d2e-1111-4a2b-8c3d-00000000000a.jpg`;
    const stored = new Set([real, staged, original]);
    let t = 0;
    const certs = new CertificatsPhotos(db, acces, journal, { has: async (r: string) => stored.has(r) }, { now, newToken: () => (++t).toString(16).padStart(32, 'e') });
    for (const [resultRef, c] of [[real, 'a'], [staged, 'c']] as const) {
      const r = await certs.record(agent, b.id, { resultRef, resultSha256: c.repeat(64), originalRef: original, originalSha256: 'a'.repeat(64), operations: [], processedOn: 'appareil' });
      if (!r.ok) throw new Error(`certificat ${r.code}`);
    }
    const d = await new AmenagementsVirtuels(db, acces, journal, { now }).declare(agent, b.id, { stagedRef: staged, realRef: real, changes: [{ kind: 'meubler', style: 'scandinave' }] });
    if (!d.ok) throw new Error(`jumelle ${d.code}`);
  }
  if (options.card !== false) await new MentionsAnnonce(db, acces, journal, { now }).setCardNumber(direction, 'CPI 2101 2027 000 000 001');
  // Le statut des agents, rangé par la direction : sans lui, l'annonce ne part pas (AU007) [R152].
  if (options.statut !== false) await rangerStatut(db, journal, now, direction, [alex.id, sam.id]);
  await designerTout(db);
  const d = await modeles.generate(agent, { kind: 'mandat_vente_simple', personId: p.id, propertyId: b.id, inputs: { 'honoraires.montant': 10000, 'honoraires.charge': 'acquereur', 'mandat.duree_mois': 12 } });
  if (!d.ok) throw new Error(d.code);
  const signed = await new SignaturePapier(db, acces, journal, { now }).register(agent, d.document.id, { signedAt, place: 'hors_agence', scanRef: 'scans/mandat.pdf', source: 'referral' });
  if (!signed.ok) throw new Error(signed.code);
  const annonces = new Annonces(db, acces, journal, { now });
  const draft = await annonces.propose(agent, b.id);
  if (!draft.ok) throw new Error(draft.code);
  const channels = CHANNELS.map((c) => new FakeChannel(c));
  const publication = new Publication(db, acces, journal, { now, channels });
  const amend = async (priceEur: number) => {
    const a = await modeles.generate(agent, { kind: 'avenant_mandat', personId: p.id, propertyId: b.id, mandateId: signed.value.mandateId, inputs: { 'avenant.prix': priceEur } });
    if (!a.ok) throw new Error(a.code);
    const r = await new SignatureAvenant(db, acces, journal, { now }).register(agent, a.document.id, { signedAt: clock, place: 'agence', scanRef: `scans/avenant-${priceEur}.pdf` });
    if (!r.ok) throw new Error(r.code);
  };
  /** Un avenant de durée, signé à `signedAt`. */
  const amendDuration = async (months: number, signedAt: Date = clock) => {
    const a = await modeles.generate(agent, { kind: 'avenant_mandat', personId: p.id, propertyId: b.id, mandateId: signed.value.mandateId, inputs: { 'avenant.duree_mois': months } });
    if (!a.ok) throw new Error(a.code);
    const r = await new SignatureAvenant(db, acces, journal, { now }).register(agent, a.document.id, { signedAt, place: 'agence', scanRef: `scans/avenant-duree-${months}.pdf` });
    if (!r.ok) throw new Error(r.code);
  };
  /** Un nouveau mandat sur le même bien, signé à `signedAt`. */
  const signNewMandate = async (feeEur: number, signedAt: Date = clock, place: 'agence' | 'hors_agence' = 'agence') => {
    await designerTout(db);
    const n = await modeles.generate(agent, { kind: 'mandat_vente_simple', personId: p.id, propertyId: b.id, inputs: { 'honoraires.montant': feeEur, 'honoraires.charge': 'acquereur', 'mandat.duree_mois': 12 } });
    if (!n.ok) throw new Error(n.code);
    const r = await new SignaturePapier(db, acces, journal, { now }).register(agent, n.document.id, { signedAt, place, scanRef: `scans/mandat-${feeEur}.pdf`, source: 'referral' });
    if (!r.ok) throw new Error(r.code);
    return r.value.mandateId;
  };
  return {
    db, journal, acces, annonces, publication, channels, agent, direction, alexId: alex.id, store, personId: p.id, sam: as('agent', sam.id), network, propertyId: b.id, draftId: draft.value.id, mandateId: signed.value.mandateId, amend, amendDuration, signNewMandate,
    now, setClock: (at: Date) => (clock = at),
    /** Les passages du planificateur, toutes les 15 minutes, de `from` à `to` inclus ; rend l'heure du premier passage qui publie. */
    async runEvery15(from: Date, to: Date): Promise<Date | null> {
      let first: Date | null = null;
      for (let t = from.getTime(); t <= to.getTime(); t += 15 * MIN) {
        clock = new Date(t);
        const r = await publication.sync(network.id, b.id);
        if (first === null && r.created) first = clock;
      }
      return first;
    },
  };
}

