import { describe, expect, it } from 'vitest';
import { FicheClient, SqlJournalStore, applyMigrations, fromSyncSqlite, type SqlDatabase } from '../src/index.ts';
import { checkText } from '../src/envoi/texte.ts';
import {
  AnnoncesLocation,
  HonorairesLocation,
  MisesEnLocation,
  checkRentalAd,
  euros,
  rentalCriteria,
  rentalMentions,
  type RentalAdFacts,
  type RentalFacts,
} from '../src/location/index.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

// Réseau, agents, propriétaire, logement et commune inventés. Le 12 juillet 2027 est un lundi.
let clock = Date.parse('2027-07-12T08:00:00.000Z');
let n = 0;
const uuid = (): string => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
const CITY = 'Villeneuve-Essai';
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
  gas: 'aucune',
  leaseStart: '2027-09-01',
  chargesMode: 'provision',
};
const FEES = { tenantCents: 34_000, tenantInventoryCents: 12_750, landlordCents: 34_000, landlordInventoryCents: 12_750, depositCents: 65_000 };
const ENERGY = { climateClass: 'C', annualCostMinEur: 640, annualCostMaxEur: 900, costReferenceYear: 2025 };
const AD_FACTS: RentalAdFacts = {
  kind: 'home', city: CITY, postalCode: '21000', surfaceM2: 42.5, rooms: 2, bedrooms: 1, floor: 2, floorsTotal: 4, buildYear: 1985, heating: 'collectif',
  outdoor: ['balcon'], landM2: null, parkingSpaces: null, elevator: true, energyClass: 'D', climateClass: 'C', furnished: false,
};

describe('W03 · texte et mentions de l’annonce', () => {
  it('[R103] les critères propres à la location sont refusés, sous leurs formes', () => {
    expect(rentalCriteria('Appartement lumineux, CDI exigé.')).toEqual(['cdi', 'cdi exige']);
    expect(rentalCriteria('Garant en France obligatoire')).toEqual(['garant en france']);
    expect(rentalCriteria('Idéal étudiantes')).toEqual(['etudiantes']);
    expect(rentalCriteria('Revenus égaux à trois fois le loyer')).toEqual(['revenus', 'trois fois le loyer']);
    expect(rentalCriteria('Pas d’APL')).toEqual(["pas d'apl"]);
    expect(rentalCriteria('Deux pièces avec balcon, au calme.')).toEqual([]);
    // Un sigle à points ou à tirets se lit d'un bloc.
    for (const text of ['C.D.I. exigé.', 'C.D.I exigé', 'C-D-I exigé.', 'Pas de R.S.A.']) expect(rentalCriteria(text), text).not.toEqual([]);
    expect(checkRentalAd('Logement', 'C.D.I. exigé.', AD_FACTS).ok).toBe(false);
    // Vide ou meublé : le texte dit ce que disent les faits.
    expect(checkRentalAd('Logement', 'Location meublée.', AD_FACTS).problems).toEqual([{ code: 'fait_sans_source', value: 'meublee' }]);
    expect(checkRentalAd('Logement', 'Appartement non meublé.', AD_FACTS).ok).toBe(true);
    expect(checkRentalAd('Logement', 'Location vide.', { ...AD_FACTS, furnished: true }).ok).toBe(false);
    expect(checkRentalAd('Logement', 'Logement non meublé.', { ...AD_FACTS, furnished: true }).ok).toBe(false);
    expect(checkRentalAd('Logement', 'Studio meublé.', { ...AD_FACTS, furnished: true }).ok).toBe(true);
    // Santé, situation de famille, ressources, sexe, et le garant lié à la France sous toutes ses tournures.
    for (const text of ['Locataire en bonne santé.', 'Pas de malade.', 'Personne valide.', 'Marié uniquement.', 'Personne seule.', 'Pas de chômeurs.', 'Pas de RSA.', 'Pour monsieur.',
      'Garant obligatoire en France.', 'Garant résidant en France.', 'Caution domiciliée en France.', 'Garants français exigés.', 'En France, un garant est demandé.']) {
      expect(rentalCriteria(text), text).not.toEqual([]);
    }
    // La liste de M07 vaut aussi : origine, famille, âge, sexe, religion…
    const fam = checkRentalAd('Deux pièces', 'Réservé à un couple sans enfants.', AD_FACTS);
    expect(fam.ok).toBe(false);
    expect(fam.problems.map((p) => p.code)).toContain('critere_discriminant');
    expect(checkRentalAd('Logement, 2 pièces', `Logement de 42,5 m² à ${CITY}, 2 pièces dont 1 chambre. Balcon.`, AD_FACTS)).toEqual({ ok: true, problems: [] });
    // Un montant écrit dans le texte n'a pas de source : seules les mentions du code en portent.
    expect(checkRentalAd('Deux pièces', 'Loyer de 700 euros.', AD_FACTS).ok).toBe(false);
  });

  it('[R102] [R103] chaque mention obligatoire vient des données, écrite par le code', () => {
    const m = rentalMentions(FACTS, FEES, CITY, ENERGY);
    expect(m).toContain('Location vide.');
    expect(m).toContain('Loyer : 700 € par mois charges comprises, dont 50 € de charges en provision, avec régularisation annuelle.');
    expect(m).toContain("Honoraires à la charge du locataire : 467,50 € TTC, dont 127,50 € pour l'état des lieux.");
    expect(m).toContain('Dépôt de garantie : 650 €.');
    expect(m).toContain('Surface habitable : 42,50 m².');
    expect(m).toContain(`Commune : ${CITY}.`);
    expect(m).toContain('Classe énergie D, classe climat C.');
    expect(m).toContain('entre 640 € et 900 € par an. Prix moyens des énergies indexés au 1er janvier 2025 (abonnements compris).');
    expect(m).not.toContain('excessive');
    const f = rentalMentions({ ...FACTS, energyClass: 'F', furnished: true }, FEES, CITY, ENERGY);
    expect(f).toContain('Location meublée.');
    expect(rentalMentions({ ...FACTS, furnished: true, chargesMode: 'forfait' }, FEES, CITY, ENERGY)).toContain('dont 50 € de charges forfaitaires.');
    expect(f).toContain('Logement à consommation énergétique excessive.');
    expect(euros(5)).toBe('0,05');
    expect(euros(100_000)).toBe('1000');
    // Les mentions ne parlent jamais de l'IA, ni de « gratuit » ni de « mandataire » [R06, R07].
    expect(checkText(m, { audience: 'public', figures: [700, 50, 467, 50, 127, 50, 650, 42, 50, 640, 900, 2025] }).filter((p) => p.rule === 'R06' || p.rule === 'R07')).toEqual([]);
  });
});

async function setup(options: { writer?: (f: RentalAdFacts) => Promise<{ title: string; body: string }>; timeoutMs?: number } = {}) {
  clock = Date.parse('2027-07-12T08:00:00.000Z');
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  const now = (): Date => new Date((clock += 1000));
  const journal = new SqlJournalStore(db);
  const store = new FicheClient(db, { now });
  const refs = new Set<string>();
  const listings = new MisesEnLocation(db, { has: async (r) => refs.has(r) }, journal, { now, newId: uuid });
  const fees = new HonorairesLocation(db, listings, journal, { now });
  const seen: RentalAdFacts[] = [];
  const writer = options.writer ? { write: (f: RentalAdFacts) => (seen.push(f), options.writer!(f)) } : undefined;
  const ads = new AnnoncesLocation(db, listings, fees, journal, { now, newId: uuid, writer, timeoutMs: options.timeoutMs ?? 50 });
  const network = await store.createNetwork('Réseau Essai');
  const alex = await store.createAgent({ networkId: network.id, firstName: 'Alex', lastName: 'Essai' });
  const bea = await store.createAgent({ networkId: network.id, firstName: 'Béa', lastName: 'Essai' });
  const owner = await store.createPerson({ networkId: network.id, agentId: alex.id, firstName: 'Bailleur', lastName: 'Inventé' });
  const home = await store.createProperty({ networkId: network.id, agentId: alex.id, reference: 'L-1', kind: 'home', postalCode: '21000', city: CITY, rooms: 2 });
  const agent = { role: 'agent' as const, userId: alex.id, networkId: network.id };
  const other = { role: 'agent' as const, userId: bea.id, networkId: network.id };
  const dir = { role: 'direction' as const, userId: 'dir-1', networkId: network.id };
  const sheet = async (energyClass = 'D', version = 1) =>
    db.run("INSERT INTO property_sheets (id, property_id, network_id, version, data, created_by, created_at) VALUES (?, ?, ?, ?, ?, 'agent:x', ?)", [
      uuid(),
      home.id,
      network.id,
      version,
      JSON.stringify({
        characteristics: { bedrooms: 1, floor: 2, floorsTotal: 4, buildYear: 1985, heating: 'collectif', outdoor: ['balcon'], landM2: null, parkingSpaces: null, elevator: true },
        energy: { energyClass, climateClass: 'C', annualCostMinEur: 640, annualCostMaxEur: 900, costReferenceYear: 2025, diagnosedOn: '2026-01-10' },
        coownership: null,
        risks: null,
        media: [],
      }),
      new Date(clock).toISOString(),
    ]);
  /** Un logement contrôlé louable, sa commune fixée, son barème rangé, sa fiche du bien faite. */
  const ready = async (facts: Partial<RentalFacts> = {}, withSheet = true, erpOn = '2027-07-01') => {
    const c = await listings.create(agent, { propertyId: home.id, ownerPersonId: owner.id });
    if (!c.ok) throw new Error(c.code);
    const id = c.value.listingId;
    expect((await listings.recordFacts(agent, id, { ...FACTS, ...facts })).ok).toBe(true);
    for (const kind of ['dpe', 'erp', 'surface_habitable']) {
      const ref = `location/${id}/${uuid()}.pdf`;
      refs.add(ref);
      expect((await listings.addAnnex(agent, id, { kind, ref, diagnosedOn: kind === 'erp' ? erpOn : '2027-07-01' })).ok).toBe(true);
    }
    await listings.check(agent, id);
    expect((await fees.setCommune(agent, id, '21999')).ok).toBe(true);
    expect((await fees.record(agent, id, FEES)).ok).toBe(true);
    if (withSheet) await sheet(facts.energyClass ?? 'D');
    return id;
  };
  const events = (type: string) => db.all<{ data: string }>('SELECT data FROM journal WHERE type = ? ORDER BY seq', [type]);
  return { db, listings, fees, ads, agent, other, dir, ready, sheet, events, seen, refs };
}

describeWithSqlite('W03 · annonce de location conforme', () => {
  it('[R103] le texte de l’IA conforme est gardé, avec les mentions du code ; l’IA ne reçoit ni nom ni montant', async () => {
    const t = await setup({ writer: async () => ({ title: `Deux pièces avec balcon à ${CITY}`, body: `Logement de 42,5 m² à ${CITY}, 2 pièces dont 1 chambre, au 2e étage sur 4 avec ascenseur. Balcon. Chauffage collectif.` }) });
    const id = await t.ready();
    const r = await t.ads.draft(t.agent, id);
    expect(r).toMatchObject({ ok: true, value: { origin: 'ia', version: 1, validatedAt: null } });
    expect(r.ok && r.value.mentions).toContain('Dépôt de garantie : 650 €.');
    expect(t.seen).toHaveLength(1);
    expect(JSON.stringify(t.seen[0])).not.toMatch(/Bailleur|Inventé|65000|rentCents|deposit|tenant/);
    // Rien n'est publiable avant la validation de l'agent.
    expect(await t.ads.publishable(t.agent.networkId, id)).toBeNull();
    expect((await t.ads.validate(t.agent, r.ok ? r.value.adId : '')).ok).toBe(true);
    const pub = await t.ads.publishable(t.agent.networkId, id);
    expect(pub?.title).toBe(`Deux pièces avec balcon à ${CITY}`);
    expect(pub?.mentions).toContain('Classe énergie D, classe climat C.');
  });

  it('[R103] un texte de l’IA discriminant, inventé, trop lent ou absent laisse place au secours, qui passe le contrôle', async () => {
    for (const writer of [
      async () => ({ title: 'Deux pièces', body: 'Idéal pour étudiant, garant en France exigé.' }),
      async () => ({ title: 'Deux pièces', body: 'Avec piscine et cave.' }),
      async () => ({ title: 'Deux pièces', body: 'Loyer 700 euros.' }),
      async () => ({ title: 'Deux pièces', body: 'C.D.I. exigé.' }),
      async () => ({ title: 'Deux pièces meublé', body: 'Location meublée.' }),
      () => new Promise<{ title: string; body: string }>(() => undefined),
      async () => {
        throw new Error('panne');
      },
    ]) {
      const t = await setup({ writer, timeoutMs: 20 });
      const id = await t.ready();
      const r = await t.ads.draft(t.agent, id);
      expect(r).toMatchObject({ ok: true, value: { origin: 'secours' } });
      expect(r.ok && checkRentalAd(r.value.title, r.value.body, { ...AD_FACTS }).ok).toBe(true);
      expect(r.ok && r.value.body).not.toMatch(/etudiant|étudiant|piscine|700|C\.D\.I|meublé/);
    }
    const t = await setup({ writer: async () => ({ title: 'Deux pièces', body: 'Réservé aux fonctionnaires.' }) });
    await t.ads.draft(t.agent, await t.ready());
    const refused = await t.events('location.annonce_ia_refusee');
    expect(refused).toHaveLength(1);
    // Le journal garde les codes, jamais le texte refusé.
    expect(refused[0]!.data).not.toContain('fonctionnaire');
  }, 30_000);

  it('[R103] le texte de l’agent est contrôlé de même : refusé avec ses problèmes, ou rangé en nouvelle version', async () => {
    const t = await setup();
    const id = await t.ready();
    expect(await t.ads.write(t.agent, id, { title: 'Deux pièces', body: 'C.D.I. exigé.' })).toMatchObject({ ok: false, rule: 'R103', code: 'text_refused' });
    expect(await t.ads.write(t.agent, id, { title: 'Deux pièces', body: 'Location meublée.' })).toMatchObject({ ok: false, rule: 'R103', code: 'text_refused' });
    const bad = await t.ads.write(t.agent, id, { title: 'Deux pièces', body: 'CDI exigé, sans enfants.' });
    expect(bad).toMatchObject({ ok: false, rule: 'R103', code: 'text_refused' });
    expect(!bad.ok && bad.problems?.map((p) => p.code).sort()).toEqual(['critere_discriminant', 'critere_location', 'critere_location']);
    expect(await t.db.all('SELECT 1 FROM rental_ads')).toHaveLength(0);
    const first = await t.ads.draft(t.agent, id);
    const mine = await t.ads.write(t.agent, id, { title: 'Deux pièces au calme', body: `Logement de 42,5 m² à ${CITY}. Balcon.` });
    expect(mine).toMatchObject({ ok: true, value: { origin: 'agent', version: 2 } });
    // La première version n'est plus validable : une plus récente existe.
    expect(await t.ads.validate(t.agent, first.ok ? first.value.adId : '')).toEqual({ ok: false, rule: null, code: 'superseded' });
    const all = await t.ads.list(t.agent, id);
    expect(all.ok && all.value.map((a) => a.origin)).toEqual(['secours', 'agent']);
    await expect(t.db.run("UPDATE rental_ads SET body = 'x'")).rejects.toThrow(/ne change plus/);
  });

  it('[R100] [R101] [R102] aucune annonce sans contrôle louable, sans barème en vigueur, ni sans dépenses d’énergie', async () => {
    const t = await setup();
    // Classe G : bloqué par W01.
    const g = await t.ready({ energyClass: 'G' });
    expect(await t.ads.draft(t.agent, g)).toEqual({ ok: false, rule: 'R100', code: 'not_advertisable' });
    // Sans fiche du bien : pas de dépenses d'énergie estimées.
    const t2 = await setup();
    const noSheet = await t2.ready({}, false);
    expect(await t2.ads.draft(t2.agent, noSheet)).toEqual({ ok: false, rule: null, code: 'missing_energy_cost' });
    // Une fiche d'une autre classe que la mise en location.
    await t2.sheet('E');
    expect(await t2.ads.draft(t2.agent, noSheet)).toEqual({ ok: false, rule: 'R100', code: 'energy_mismatch' });
    // Des faits changés rendent le barème caduc : plus d'annonce tant qu'un nouveau barème n'est pas rangé.
    const t3 = await setup();
    const id = await t3.ready();
    expect((await t3.ads.draft(t3.agent, id)).ok).toBe(true);
    await t3.listings.recordFacts(t3.agent, id, { ...FACTS, livingAreaHundredths: 3_000 });
    await t3.listings.check(t3.agent, id);
    expect(await t3.ads.draft(t3.agent, id)).toEqual({ ok: false, rule: 'R102', code: 'no_fees' });
    expect(await t3.ads.publishable(t3.agent.networkId, id)).toBeNull();
  });

  it('[R100] [R101] une annonce validée cesse d’être publiable quand le logement ne l’est plus, ou que sa fiche change', async () => {
    const t = await setup();
    // L'état des risques du 15 janvier vaut jusqu'au 14 juillet, jour du début du bail.
    const id = await t.ready({ leaseStart: '2027-07-14' }, true, '2027-01-15');
    const r = await t.ads.draft(t.agent, id);
    expect((await t.ads.validate(t.agent, r.ok ? r.value.adId : '')).ok).toBe(true);
    expect(await t.ads.publishable(t.agent.networkId, id)).not.toBeNull();
    clock = Date.parse('2027-07-15T08:00:00.000Z');
    expect(await t.ads.publishable(t.agent.networkId, id)).toBeNull();
    const t2 = await setup();
    const id2 = await t2.ready();
    const r2 = await t2.ads.draft(t2.agent, id2);
    expect((await t2.ads.validate(t2.agent, r2.ok ? r2.value.adId : '')).ok).toBe(true);
    await t2.sheet('D', 2);
    expect(await t2.ads.publishable(t2.agent.networkId, id2)).toBeNull();
  });

  it('[R103] le mode des charges est dit : aucune annonce sans lui ; un logement vide n’est jamais au forfait', async () => {
    const t = await setup();
    const id = await t.ready({ chargesMode: null });
    expect(await t.ads.draft(t.agent, id)).toEqual({ ok: false, rule: null, code: 'missing_charges_mode' });
    expect(await t.listings.recordFacts(t.agent, id, { ...FACTS, chargesMode: 'forfait' })).toEqual({ ok: false, rule: null, code: 'invalid', field: 'chargesMode' });
    expect((await t.listings.recordFacts(t.agent, id, { ...FACTS, furnished: true, chargesMode: 'forfait' })).ok).toBe(true);
  });

  it('[R16] l’agent du logement et la direction proposent ; seul l’agent du logement valide ; un autre agent est refusé', async () => {
    const t = await setup();
    const id = await t.ready();
    expect(await t.ads.draft(t.other, id)).toEqual({ ok: false, rule: 'R16', code: 'not_assigned' });
    const r = await t.ads.draft(t.dir, id);
    expect(r.ok).toBe(true);
    expect(await t.ads.validate(t.dir, r.ok ? r.value.adId : '')).toEqual({ ok: false, rule: 'R16', code: 'role' });
    expect(await t.ads.validate(t.other, r.ok ? r.value.adId : '')).toEqual({ ok: false, rule: 'R16', code: 'not_assigned' });
    expect((await t.ads.validate(t.agent, r.ok ? r.value.adId : '')).ok).toBe(true);
    expect(await t.ads.validate(t.agent, r.ok ? r.value.adId : '')).toEqual({ ok: false, rule: null, code: 'already_validated' });
    expect(await t.ads.validate(t.agent, 'inconnue')).toMatchObject({ ok: false, rule: 'R16', code: 'unknown' });
    const reads = await t.ads.list(t.dir, id);
    expect(reads.ok).toBe(true);
    expect((await t.events('location.lue')).map((e) => JSON.parse(e.data).what)).toContain('ads');
  });
});
