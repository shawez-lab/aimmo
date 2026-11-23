import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Acces, FicheClient, FicheUnique, SqlJournalStore, applyMigrations, fromSyncSqlite, type SqlDatabase } from '../src/index.ts';
import { bankDetailsIn, fundsInOutgoing } from '../src/envoi/texte.ts';
import { Annuaire, MiseEnRelation } from '../src/partenaires/index.ts';
import {
  BauxLocation,
  Candidatures,
  ChoixProprietaire,
  EtatsDesLieux,
  HonorairesLocation,
  MisesEnLocation,
  RemisesDesCles,
  type RentalFacts,
} from '../src/location/index.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';
import { signRentalMandate } from './mandat-location-jeu.ts';

// Réseau, agents, propriétaire, candidats, logement et adresse inventés. Le 12 juillet 2027 est un lundi.
let clock = Date.parse('2027-07-12T08:00:00.000Z');
let n = 0;
const uuid = (): string => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
const SHA = 'a'.repeat(64);
const FACTS: RentalFacts = {
  furnished: false,
  rentCents: 65_000,
  chargesCents: 5_000,
  livingAreaHundredths: 4_250,
  energyClass: 'D',
  finalEnergyKwh: 210,
  buildYear: 1985,
  electricityOver15: false,
  mainRoomHundredths: 1_800,
  ceilingHeightCm: 250,
  localRules: { reference: 'Règlement sanitaire départemental, art. 40', checkedOn: '2027-01-04', compliant: true },
  firstLetting: true,
  gas: 'aucune',
  leaseStart: '2027-09-01',
  chargesMode: 'provision',
};
const INPUT = { address: '12 allée des Essais', ownerAddress: '3 chemin des Exemples, Ailleurs-Essai', habitat: 'collectif', landlord: 'physique', equipment: 'Cuisine équipée, cave', professionalCard: 'CPI 2101 2027 000 000 001' };
const FEES = { tenantCents: 34_000, tenantInventoryCents: 12_750, landlordCents: 34_000, landlordInventoryCents: 12_750, depositCents: 65_000 };
const BODY = [
  'Bail de {{bail.type}} entre {{bailleur.nom}}, domicilié {{bailleur.domicile}}, bailleur, et {{locataire.nom}}, locataire.',
  'Mandataire : {{reseau.nom}}, représenté par {{agent.nom}}, carte professionnelle {{mandataire.carte}}.',
  'Désignation : {{logement.habitat}}, {{logement.pieces}} pièces principales ; équipements : {{logement.equipements}}.',
  'Logement : {{logement.adresse}}, {{logement.commune}}, surface habitable {{logement.surface_habitable}}, classe énergie {{logement.classe_energie}}.',
  'Prise d’effet le {{bail.debut}}, pour {{bail.duree}}.',
  'Loyer : {{loyer.hors_charges}} ; charges : {{charges.montant}}, en {{charges.mode}} ; dépôt de garantie : {{depot.montant}}.',
  'Honoraires du locataire : {{honoraires.locataire}}, dont état des lieux {{honoraires.etat_des_lieux}} ; du bailleur : {{honoraires.bailleur}}.',
  'Annexes : {{annexes.liste}}.',
  'Fait le {{signature.date}} à {{signature.lieu}}.',
].join('\n\n');

async function setup() {
  clock = Date.parse('2027-07-12T08:00:00.000Z');
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  const now = (): Date => new Date((clock += 60_000));
  const journal = new SqlJournalStore(db);
  const store = new FicheClient(db, { now });
  const refs = new Set<string>();
  const files = { has: async (r: string) => refs.has(r) };
  const put = (prefix: string) => {
    const r = `${prefix}/${uuid()}.pdf`;
    refs.add(r);
    return r;
  };
  const listings = new MisesEnLocation(db, files, journal, { now, newId: uuid });
  const fees = new HonorairesLocation(db, listings, journal, { now });
  const identity = { state: async () => ({ identityVerifiedOn: '2027-07-10' }) };
  const apps = new Candidatures(db, listings, identity, files, journal, { now, newId: uuid });
  const choix = new ChoixProprietaire(db, listings, apps, files, journal, { now, newId: uuid });
  const acces = new Acces(db, store, new FicheUnique(db, store, { now }), journal, { now });
  const baux = new BauxLocation(db, listings, fees, choix, files, acces, journal, { now, newId: uuid });
  const formatter = { reply: null as null | ((d: string) => string), calls: [] as { room: string; dictation: string }[], hook: null as null | (() => Promise<void>) };
  const ai = {
    format: async (x: { room: string; dictation: string }) => {
      formatter.calls.push(x);
      if (formatter.hook) await formatter.hook();
      if (!formatter.reply) throw new Error('indisponible');
      return formatter.reply(x.dictation);
    },
  };
  const edl = new EtatsDesLieux(db, listings, baux, choix, files, acces, ai, journal, { now, newId: uuid });
  const signed = new Map<string, string>();
  const signatures = { signedAt: async (_n: string, leaseId: string) => signed.get(leaseId) ?? null };
  const annuaire = new Annuaire(db, files, journal, { now, newId: uuid });
  const relations = new MiseEnRelation(db, annuaire, files, journal, { now, newId: uuid, newSeed: () => 1 });
  const remises = new RemisesDesCles(db, listings, fees, baux, edl, signatures, relations, annuaire, journal, { now, newId: uuid });
  const network = await store.createNetwork('Réseau Essai');
  const alex = await store.createAgent({ networkId: network.id, firstName: 'Alex', lastName: 'Essai' });
  const bea = await store.createAgent({ networkId: network.id, firstName: 'Béa', lastName: 'Essai' });
  const owner = await store.createPerson({ networkId: network.id, agentId: alex.id, firstName: 'Bailleur', lastName: 'Inventé' });
  const home = await store.createProperty({ networkId: network.id, agentId: alex.id, reference: 'L-1', kind: 'home', postalCode: '21000', city: 'Villeneuve-Essai', rooms: 2 });
  // AU014 : la location se fait sous un mandat de location signé et inscrit.
  await signRentalMandate(db, { networkId: network.id, agentId: alex.id, personId: owner.id, propertyId: home.id });
  const agent = { role: 'agent' as const, userId: alex.id, networkId: network.id };
  const other = { role: 'agent' as const, userId: bea.id, networkId: network.id };
  const dir = { role: 'direction' as const, userId: 'dir-1', networkId: network.id };
  const compliance = { role: 'compliance' as const, userId: 'conf-1', networkId: network.id };
  /** Le logement louable, son barème, deux candidats complets présentés ; le choix rangé si demandé. */
  const ready = async (facts: Partial<RentalFacts> = {}, choose = true) => {
    const c = await listings.create(agent, { propertyId: home.id, ownerPersonId: owner.id });
    const id = c.ok ? c.value.listingId : '';
    expect((await listings.recordFacts(agent, id, { ...FACTS, ...facts })).ok).toBe(true);
    for (const kind of ['dpe', 'erp', 'surface_habitable']) expect((await listings.addAnnex(agent, id, { kind, ref: put(`location/${id}`), diagnosedOn: '2027-07-01' })).ok).toBe(true);
    await listings.check(agent, id);
    await fees.setCommune(agent, id, '21999');
    expect((await fees.record(agent, id, FEES)).ok).toBe(true);
    const ids: string[] = [];
    for (const i of [1, 2]) {
      const pid = (await store.createPerson({ networkId: network.id, agentId: alex.id, firstName: `Candidat${i}`, lastName: 'Inventé' })).id;
      const a = await apps.apply(agent, id, { personId: pid });
      const aid = a.ok ? a.value.applicationId : '';
      for (const sort of ['quittances_loyer', 'contrat_travail', 'bulletins_salaire']) await apps.addPiece(agent, aid, { holder: 'candidat', sort, ref: put(`location/${id}/candidatures/${aid}`), sha256: SHA });
      ids.push(aid);
    }
    const p = await choix.present(agent, id);
    if (choose) {
      const r = await choix.recordChoice(agent, id, { presentationId: p.ok ? p.value.presentationId : '', applicationId: ids[1]!, decidedAt: new Date(clock).toISOString(), channel: 'ecrit', proofRef: put(`location/${id}/choix`) });
      expect(r.ok).toBe(true);
    }
    return id;
  };
  const template = async (kind = 'bail_vide', body = BODY) => {
    const r = await baux.createTemplate(dir, kind, body);
    if (!r.ok) throw new Error(r.code);
    return r.value;
  };
  const inp = (id: string) => ({ ...INPUT, noticeRef: put(`location/${id}/bail`) });
  const photo = (id: string) => {
    const r = `location/${id}/etat-des-lieux/${uuid()}.jpg`;
    refs.add(r);
    return r;
  };
  /** Le logement louable, choisi, avec son bail d'essai complet. */
  const leased = async (facts: Partial<RentalFacts> = {}) => {
    await template(facts.furnished ? 'bail_meuble' : 'bail_vide');
    const id = await ready(facts);
    const l = await baux.generate(agent, id, inp(id));
    expect(l).toMatchObject({ ok: true, value: { status: 'complet', mode: 'essai' } });
    return id;
  };
  return { db, journal, store, network, home, alex, signed, annuaire, relations, remises, refs, listings, fees, baux, edl, formatter, agent, other, dir, compliance, ready, template, inp, put, photo, leased, owner, bea };
}

const ROOMS = [{ name: 'Séjour', elements: [{ name: 'Murs', state: 'bon' }] }];
const FULL = {
  address: '12 allée des Essais',
  ownerAddress: '3 chemin des Exemples, Ailleurs-Essai',
  rooms: ROOMS,
  meters: [{ kind: 'electricite', index: '012345' }],
  keys: [{ kind: 'Clé de la porte d’entrée', count: 2 }],
};
const DRAW = 'data:image/png;base64,AAAAexemple';
const ROOT = join(__dirname, '..', '..', '..');

/** Le logement loué, son état des lieux clos ; le bail signé si demandé. */
async function closed(t: Awaited<ReturnType<typeof setup>>, sign = true) {
  const id = await t.leased();
  const r = await t.edl.record(t.agent, id, FULL);
  if (!r.ok) throw new Error(r.code);
  for (const party of ['bailleur', 'locataire']) await t.edl.sign(t.agent, r.value.inventoryId, { party, contentSha256: r.value.contentSha256, drawing: DRAW });
  const lease = await t.baux.current(t.agent.networkId, id);
  if (sign) t.signed.set(lease!.leaseId, '2027-07-12T09:00:00.000Z');
  return { id, leaseId: lease!.leaseId };
}

function files(dir: string, re: RegExp): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...files(p, re));
    else if (re.test(e.name)) out.push(p);
  }
  return out;
}

describe('W08 · aucun fonds pour AIMMO', () => {
  it('[R107] aucune table ne fait recevoir par AIMMO un loyer ou un dépôt, aucune colonne bancaire n’existe', () => {
    // Le code SQL seul, sans ses commentaires (qui disent justement qu'aucun RIB n'est rangé).
    const sql = files(join(ROOT, 'db', 'migrations'), /\.sql$/)
      .map((f) => readFileSync(f, 'utf8').replace(/--[^\n]*/g, ''))
      .join('\n');
    // Aucune coordonnée bancaire rangée, aucune table d'encaissement ou de séquestre.
    expect(sql).not.toMatch(/\b(?:iban|bic|rib|bank_account|account_number|compte_bancaire)\b/i);
    expect(sql).not.toMatch(/CREATE TABLE[^(]*(?:sequestre|escrow|encaissement|rent_payment|deposit_payment|loyers_recus)/i);
    // Dans les tables de la location, tout versement déclaré va au seul propriétaire.
    const paid = [...sql.matchAll(/(\w+_payee)\s+TEXT NOT NULL CHECK \(([^)]*)\)/g)];
    expect(paid.map((m) => m[1])).toEqual(['deposit_payee', 'first_rent_payee']);
    for (const m of paid) expect(m[2]).toBe(`${m[1]} = 'proprietaire'`);
  });

  it('[R107] aucun texte ni aucune route de la location ne propose un compte bancaire au locataire', () => {
    // Le code de la location, et toutes les routes et tous les écrans de l'API : aucune ne peut proposer un compte.
    const location = files(join(ROOT, 'packages', 'core', 'src', 'location'), /\.ts$/);
    const api = [...files(join(ROOT, 'packages', 'api', 'src'), /\.ts$/), ...files(join(ROOT, 'packages', 'api', 'app'), /\.(?:ts|html|js)$/)];
    expect(location.length).toBeGreaterThan(5);
    expect(api.length).toBeGreaterThan(5);
    const sources = [...location, ...api];
    for (const f of sources) {
      // Le code et ses textes, sans les commentaires (qui citent le RIB parmi les pièces refusées).
      const text = readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      expect(text, f).not.toMatch(/\b(?:IBAN|RIB|BIC|iban|rib)\b/);
      expect(text, f).not.toMatch(/compte (?:bancaire|séquestre) d[’']AIMMO|virement (?:à|vers|sur le compte d[’'])\s*AIMMO/i);
    }
  });
});

describeWithSqlite('W08 · remise des clés', () => {
  it('[R107] [R106] la remise des clés suit le bail signé et l’état des lieux clos ; dépôt et premier loyer vont au seul propriétaire', async () => {
    const t = await setup();
    const id = await t.leased();
    expect(await t.remises.handOver(t.agent, id, { handedOn: '2027-07-12' })).toEqual({ ok: false, rule: 'R107', code: 'lease_not_signed' });
    const lease = await t.baux.current(t.agent.networkId, id);
    t.signed.set(lease!.leaseId, '2027-07-12T09:00:00.000Z');
    expect(await t.remises.handOver(t.agent, id, { handedOn: '2027-07-12' })).toEqual({ ok: false, rule: 'R106', code: 'inventory_not_closed' });
    const r = await t.edl.record(t.agent, id, FULL);
    if (!r.ok) throw new Error(r.code);
    for (const party of ['bailleur', 'locataire']) await t.edl.sign(t.agent, r.value.inventoryId, { party, contentSha256: r.value.contentSha256, drawing: DRAW });
    expect(await t.remises.handOver(t.agent, id, { handedOn: '2099-01-01' })).toEqual({ ok: false, rule: null, code: 'bad_date' });
    expect(await t.remises.handOver(t.agent, id, { handedOn: 'hier' })).toEqual({ ok: false, rule: null, code: 'bad_date' });
    expect(await t.remises.handOver(t.agent, id, { handedOn: '2027-02-31' })).toEqual({ ok: false, rule: null, code: 'bad_date' });
    const h = await t.remises.handOver(t.agent, id, { handedOn: '2027-07-12' });
    expect(h).toMatchObject({ ok: true, value: { depositPaidTo: 'proprietaire', firstRentPaidTo: 'proprietaire', depositCents: 65_000, firstRentCents: 70_000 } });
    const text = h.ok ? h.value.text : '';
    expect(text).toContain('Le dépôt de garantie, 650 €, et le premier loyer, 700 € charges comprises, sont réglés directement au propriétaire.');
    expect(text).toContain('Réseau Essai et l’agent immobilier ne reçoivent ni loyer');
    expect(text).not.toMatch(/mandataire|\bIA\b/i);
    expect(fundsInOutgoing(text)).toBe(false);
    expect(bankDetailsIn(text)).toBe(false);
    expect(await t.remises.handOver(t.agent, id, { handedOn: '2027-07-12' })).toEqual({ ok: false, rule: null, code: 'already_handed_over' });
    // La base refuse tout autre destinataire que le propriétaire, et rien ne s'efface.
    await expect(
      t.db.run("INSERT INTO rental_handovers (id, listing_id, network_id, lease_id, inventory_id, handed_on, deposit_payee, first_rent_payee, deposit_cents, first_rent_cents, text, text_sha256, recorded_by, recorded_at) SELECT 'x', listing_id, network_id, lease_id, inventory_id, handed_on, 'aimmo', first_rent_payee, 1, 1, 't', text_sha256, 'a', 'b' FROM rental_handovers"),
    ).rejects.toThrow(/CHECK/);
    await expect(t.db.run('DELETE FROM rental_handovers')).rejects.toThrow(/rien ne s/);
    await expect(t.db.run("UPDATE rental_handovers SET deposit_payee = 'aimmo'")).rejects.toThrow(/ne change plus|CHECK/);
    expect(await t.remises.handOver(t.other, id, { handedOn: '2027-07-12' })).toEqual({ ok: false, rule: 'R16', code: 'not_assigned' });
  });

  it('[R106] un état des lieux clos sous un autre bail ne vaut pas pour la remise des clés', async () => {
    const t = await setup();
    const { id } = await closed(t);
    // Un nouveau bail, signé à son tour : l'état des lieux clos l'a été sous l'ancien.
    expect((await t.baux.generate(t.agent, id, t.inp(id))).ok).toBe(true);
    const b = await t.baux.current(t.agent.networkId, id);
    t.signed.set(b!.leaseId, '2027-07-12T10:00:00.000Z');
    expect(await t.remises.handOver(t.agent, id, { handedOn: '2027-07-12' })).toEqual({ ok: false, rule: 'R106', code: 'inventory_other_lease' });
    // Le nouveau bail reçoit son propre état des lieux ; clos, il ouvre la remise des clés.
    const r = await t.edl.record(t.agent, id, FULL);
    if (!r.ok) throw new Error(r.code);
    for (const party of ['bailleur', 'locataire']) await t.edl.sign(t.agent, r.value.inventoryId, { party, contentSha256: r.value.contentSha256, drawing: DRAW });
    expect((await t.remises.handOver(t.agent, id, { handedOn: '2027-07-12' })).ok).toBe(true);
  });

  it('[R102] les honoraires ne sont dus qu’une fois le bail signé, au montant du barème', async () => {
    const t = await setup();
    const { id, leaseId } = await closed(t, false);
    expect(await t.remises.feesDue(t.agent, id)).toEqual({ ok: true, value: { due: false, dueSince: null, tenantCents: 46_750, landlordCents: 46_750 } });
    t.signed.set(leaseId, '2027-07-12T09:00:00.000Z');
    expect(await t.remises.feesDue(t.agent, id)).toEqual({ ok: true, value: { due: true, dueSince: '2027-07-12T09:00:00.000Z', tenantCents: 46_750, landlordCents: 46_750 } });
    // Un nouveau bail, non signé, remplace le bail signé : plus rien n'est dû tant qu'il n'est pas signé.
    expect((await t.baux.generate(t.agent, id, t.inp(id))).ok).toBe(true);
    expect(await t.remises.feesDue(t.agent, id)).toMatchObject({ ok: true, value: { due: false } });
  });

  it('[R74] [R73] la gestion locative est confiée par la mise en relation, avec l’accord du propriétaire, à un gestionnaire carte G valide ce jour', async () => {
    const t = await setup();
    const { id } = await closed(t);
    const day = (d: number) => new Date(Date.parse('2027-07-12T00:00:00Z') + d * 86_400_000).toISOString().slice(0, 10);
    const partner = async (trade: string, until: number) => {
      const r = await t.annuaire.addPartner(t.dir, { trade, businessName: `Partenaire ${trade} ${until}`, postcodes: ['21000'] });
      if (!r.ok) throw new Error(r.code);
      const kinds = trade === 'gestionnaire' ? ['assurance_rcp', 'carte_g'] : ['assurance_rcp'];
      for (const kind of kinds) await t.annuaire.addCredential(t.dir, r.value.partnerId, { kind, number: 'N-1', validFrom: day(-30), validUntil: day(until), proofRef: t.put(`partenaires/${r.value.partnerId}`) });
      return r.value.partnerId;
    };
    const project = await t.store.createProject({ networkId: t.network.id, agentId: t.alex.id, personId: t.owner.id, kind: 'rent_out' });
    await t.store.linkProjectProperty({ networkId: t.network.id, agentId: t.alex.id, projectId: project.id, propertyId: t.home.id, role: 'owned' });
    const manager = await partner('gestionnaire', 300);
    const referral = async (trade: string, consent = true, confide = true) => {
      const p = await t.relations.propose(t.agent, { projectId: project.id, trade, propertyId: t.home.id });
      if (!p.ok) throw new Error(p.code);
      const rid = p.value.referralId;
      if (consent) {
        const c = await t.relations.recordConsent(t.agent, rid, { partnerId: p.value.shown[0]!.partnerId, consentAt: new Date(Date.now() > 0 ? Date.parse(p.value.createdAt) + 1 : 0).toISOString(), channel: 'ecrit', proofRef: t.put(`relations/${rid}`) });
        if (!c.ok) throw new Error(c.code);
        if (confide) await t.relations.entrust(t.agent, rid);
      }
      return rid;
    };
    const noConsent = await referral('gestionnaire', false);
    expect(await t.remises.linkManagement(t.agent, id, noConsent)).toEqual({ ok: false, rule: 'R74', code: 'not_entrusted' });
    const notConfided = await referral('gestionnaire', true, false);
    expect(await t.remises.linkManagement(t.agent, id, notConfided)).toEqual({ ok: false, rule: 'R74', code: 'not_entrusted' });
    await partner('photographe', 300);
    const photo = await referral('photographe');
    expect(await t.remises.linkManagement(t.agent, id, photo)).toEqual({ ok: false, rule: 'R73', code: 'not_manager' });
    const ok = await referral('gestionnaire');
    expect(await t.remises.linkManagement(t.other, id, ok)).toEqual({ ok: false, rule: 'R16', code: 'not_assigned' });
    expect(await t.remises.linkManagement(t.agent, id, ok)).toEqual({ ok: true, value: { partnerId: manager } });
    expect(await t.remises.linkManagement(t.agent, id, ok)).toEqual({ ok: false, rule: null, code: 'already_linked' });
    // La carte G échue ce jour : plus de gestion confiée à ce gestionnaire.
    const late = await referral('gestionnaire');
    await t.annuaire.addCredential(t.dir, manager, { kind: 'carte_g', number: 'N-2', validFrom: day(-30), validUntil: day(-1), proofRef: t.put(`partenaires/${manager}`) });
    expect(await t.remises.linkManagement(t.agent, id, late)).toEqual({ ok: false, rule: 'R73', code: 'partner_unavailable' });
    // W16 : l'écran lit ce que le geste accepterait, sans jamais demander de référence.
    const seen = await t.remises.state(t.agent, id);
    expect(seen).toMatchObject({ ok: true, value: { managers: [{ partnerName: `Partenaire gestionnaire 300` }], entrustable: [{ referralId: late, partnerName: 'Partenaire gestionnaire 300', available: false }] } });
    expect(seen.ok && seen.value.entrustable.map((c) => c.referralId)).not.toContain(noConsent);
    expect(seen.ok && seen.value.entrustable.map((c) => c.referralId)).not.toContain(notConfided);
    expect(seen.ok && seen.value.entrustable.map((c) => c.referralId)).not.toContain(photo);
    expect(seen.ok && seen.value.entrustable.map((c) => c.referralId)).not.toContain(ok);
    expect(await t.remises.state(t.dir, id)).toMatchObject({ ok: true, value: { writable: true, entrustable: [{ referralId: late }] } });
    // Qui lit sans agir ne reçoit aucune mise en relation à confier [R16].
    expect(await t.remises.state(t.compliance, id)).toMatchObject({ ok: true, value: { writable: false, entrustable: [] } });
  });

  it('[R108] [R16] W16 : l’écran lit la signature réelle, le récapitulatif rangé et la lecture va au journal', async () => {
    const t = await setup();
    const { id, leaseId } = await closed(t, false);
    expect(await t.remises.state(t.agent, id)).toEqual({ ok: true, value: { writable: true, leaseSigned: false, inventoryClosed: true, handover: null, managers: [], entrustable: [] } });
    t.signed.set(leaseId, '2027-07-12T09:00:00.000Z');
    expect(await t.remises.handedOn(t.agent.networkId, id)).toBeNull();
    const h = await t.remises.handOver(t.agent, id, { handedOn: '2027-07-12' });
    if (!h.ok) throw new Error(h.code);
    expect(await t.remises.state(t.agent, id)).toEqual({ ok: true, value: { writable: true, leaseSigned: true, inventoryClosed: true, handover: h.value, managers: [], entrustable: [] } });
    expect(await t.remises.handedOn(t.agent.networkId, id)).toBe('2027-07-12');
    expect(await t.remises.state(t.other, id)).toEqual({ ok: false, rule: 'R16', code: 'not_assigned' });
    expect(await t.remises.state(t.other, 42)).toMatchObject({ ok: false, rule: 'R16' });
    const logged = await t.db.all<{ data: string }>("SELECT data FROM journal WHERE type = 'location.lue'");
    expect(logged.some((e) => JSON.parse(e.data).what === 'handover')).toBe(true);
  });
});
