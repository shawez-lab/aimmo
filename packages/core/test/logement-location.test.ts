import { describe, expect, it } from 'vitest';
import { FicheClient, SqlJournalStore, applyMigrations, fromSyncSqlite, type SqlDatabase } from '../src/index.ts';
import { checkText } from '../src/envoi/texte.ts';
import {
  MisesEnLocation,
  annexValidUntil,
  banDate,
  checkDwelling,
  decencyOf,
  territoryOf,
  ownerNoticeText,
  parseFacts,
  rentCeilingCents,
  requiredAnnexes,
  type RentalFacts,
} from '../src/location/index.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

// Réseau, agents, propriétaire et logements inventés. Le 12 juillet 2027 est un lundi.
let clock = Date.parse('2027-07-12T08:00:00.000Z');
let n = 0;
const uuid = (): string => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;

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
};
const ALL_VALID = [
  { kind: 'dpe' as const, diagnosedOn: '2026-01-10', validUntil: '2036-01-09' },
  { kind: 'erp' as const, diagnosedOn: '2027-07-01', validUntil: '2027-12-31' },
  { kind: 'surface_habitable' as const, diagnosedOn: '2026-01-10', validUntil: null },
];

describe('W01 · règles écrites du contrôle du logement', () => {
  it('[R100] chaque classe est jugée à la veille et au jour de sa date d’interdiction', () => {
    const at = (energyClass: RentalFacts['energyClass'], leaseStart: string) => checkDwelling({ ...FACTS, energyClass, leaseStart }, ALL_VALID, '2020-01-01').map((r) => r.code).filter((c) => !c.startsWith('annex'));
    expect(at('G', '2024-12-31')).toEqual([]);
    expect(at('G', '2025-01-01')).toEqual(['energy_class']);
    expect(at('F', '2027-12-31')).toEqual([]);
    expect(at('F', '2028-01-01')).toEqual(['energy_class']);
    expect(at('E', '2033-12-31')).toEqual([]);
    expect(at('E', '2034-01-01')).toEqual(['energy_class']);
    for (const c of ['A', 'B', 'C', 'D'] as const) expect(at(c, '2060-01-01')).toEqual([]);
    expect(banDate('G')).toBe('2025-01-01');
    expect(banDate('D')).toBeNull();
  });

  it('[R100] au-delà de 450 kWh/m²/an en énergie finale, interdit pour un bail à partir du 1er janvier 2023', () => {
    const at = (finalEnergyKwh: number, leaseStart: string) => checkDwelling({ ...FACTS, energyClass: 'F', finalEnergyKwh, leaseStart }, ALL_VALID, '2020-01-01').map((r) => r.code).filter((c) => !c.startsWith('annex'));
    expect(at(450, '2023-01-01')).toEqual([]);
    expect(at(451, '2022-12-31')).toEqual([]);
    expect(at(451, '2023-01-01')).toEqual(['final_energy']);
  });

  it('[R100] une date de bail passée ne rouvre rien : la classe est jugée au plus tard du bail et du jour', () => {
    const codes = (energyClass: RentalFacts['energyClass'], leaseStart: string, today: string) =>
      checkDwelling({ ...FACTS, energyClass, leaseStart }, ALL_VALID, today).map((r) => r.code).filter((c) => !c.startsWith('annex'));
    expect(codes('G', '2024-12-31', '2027-07-12')).toEqual(['energy_class']);
    expect(codes('F', '2027-12-31', '2028-01-01')).toEqual(['energy_class']);
    expect(checkDwelling({ ...FACTS, energyClass: 'F', finalEnergyKwh: 460, leaseStart: '2022-06-01' }, ALL_VALID, '2027-07-12').map((r) => r.code)).toContain('final_energy');
  });

  it('[R101] moins de 9 m² habitables, ou une annexe manquante, échue ou datée du futur, bloque avec sa raison', () => {
    const today = '2027-07-12';
    const small = { ...FACTS, livingAreaHundredths: 899, mainRoomHundredths: 899, ceilingHeightCm: 250 };
    expect(checkDwelling(small, ALL_VALID, today)).toEqual([{ code: 'living_area', livingAreaHundredths: 899, mainRoomHundredths: 899, ceilingHeightCm: 250, habitableVolumeHundredths: null }]);
    expect(checkDwelling({ ...small, livingAreaHundredths: 900, mainRoomHundredths: 900 }, ALL_VALID, today)).toEqual([]);
    expect(checkDwelling(FACTS, ALL_VALID.filter((a) => a.kind !== 'erp'), today)).toEqual([{ code: 'annex_missing', kind: 'erp' }]);
    // L'état des risques vaut 6 mois : échu avant le début du bail.
    const oldErp = [...ALL_VALID.filter((a) => a.kind !== 'erp'), { kind: 'erp' as const, diagnosedOn: '2027-01-15', validUntil: annexValidUntil('erp', '2027-01-15') }];
    expect(checkDwelling(FACTS, oldErp, today)).toEqual([{ code: 'annex_expired', kind: 'erp', validUntil: '2027-07-14' }]);
    const future = [...ALL_VALID.filter((a) => a.kind !== 'dpe'), { kind: 'dpe' as const, diagnosedOn: '2027-08-01', validUntil: '2037-07-31' }];
    expect(checkDwelling(FACTS, future, today)).toEqual([{ code: 'annex_future', kind: 'dpe' }]);
  });

  it('[R101] les annexes exigées suivent l’âge de l’immeuble et des installations', () => {
    expect(requiredAnnexes(FACTS)).toEqual(['dpe', 'erp', 'surface_habitable']);
    expect(requiredAnnexes({ buildYear: 1948, electricityOver15: true, gas: 'plus_de_15_ans' })).toEqual(['dpe', 'erp', 'surface_habitable', 'crep', 'electricite', 'gaz']);
    expect(requiredAnnexes({ buildYear: 1949, electricityOver15: false, gas: 'moins_de_15_ans' })).toEqual(['dpe', 'erp', 'surface_habitable']);
    expect(checkDwelling({ ...FACTS, buildYear: 1930 }, ALL_VALID, '2027-07-12')).toEqual([{ code: 'annex_missing', kind: 'crep' }]);
  });

  it('[R101] fin de validité des annexes calculée par le code', () => {
    expect(annexValidUntil('dpe', '2016-05-02')).toBe('2022-12-31');
    expect(annexValidUntil('dpe', '2019-03-01')).toBe('2024-12-31');
    expect(annexValidUntil('dpe', '2021-07-01')).toBe('2031-06-30');
    expect(annexValidUntil('erp', '2027-08-31')).toBe('2028-02-28');
    expect(annexValidUntil('electricite', '2024-02-29')).toBe('2030-02-27');
    expect(annexValidUntil('surface_habitable', '2001-01-01')).toBeNull();
  });

  it('les faits sont contrôlés champ par champ ; un champ inconnu est refusé', () => {
    expect(parseFacts(FACTS)).toEqual({ ok: true, value: FACTS });
    expect(parseFacts({ ...FACTS, tenantIncome: 1 })).toEqual({ ok: false, field: 'tenantIncome' });
    expect(parseFacts({ ...FACTS, energyClass: 'H' })).toEqual({ ok: false, field: 'energyClass' });
    expect(parseFacts({ ...FACTS, leaseStart: '2027-02-30' })).toEqual({ ok: false, field: 'leaseStart' });
    expect(parseFacts({ ...FACTS, rentCents: 650.5 })).toEqual({ ok: false, field: 'rentCents' });
  });

  it('[R06] [R07] le texte de l’échéance passe le contrôle des textes et ne parle que de la classe et de la date', () => {
    for (const [c, d, today] of [['F', '2028-01-01', '2027-07-12'], ['G', '2025-01-01', '2027-07-12'], ['E', '2034-01-01', '2027-07-12']] as const) {
      const text = ownerNoticeText(c, d, today);
      expect(checkText(text, { audience: 'client', channel: 'email', figures: [Number(d.slice(0, 4)), 1] }).filter((p) => p.rule !== 'R08'), c).toEqual([]);
      expect(text).toContain(`classé ${c}`);
      expect(text).toContain(`1er janvier ${d.slice(0, 4)}`);
      expect(text).not.toMatch(/\bIA\b|intelligence artificielle|mandataire|gratuit|€/i);
    }
    expect(ownerNoticeText('G', '2025-01-01', '2027-07-12')).toContain('Depuis le 1er janvier 2025');
    expect(ownerNoticeText('F', '2028-01-01', '2027-07-12')).toContain('À partir du 1er janvier 2028');
  });
});

class FakeFiles {
  readonly refs = new Set<string>();
  put(listingId: string): string {
    const ref = `location/${listingId}/${uuid()}.pdf`;
    this.refs.add(ref);
    return ref;
  }
  async has(ref: string): Promise<boolean> {
    return this.refs.has(ref);
  }
}

async function setup() {
  clock = Date.parse('2027-07-12T08:00:00.000Z');
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  const now = (): Date => new Date((clock += 1000));
  const journal = new SqlJournalStore(db);
  const store = new FicheClient(db, { now });
  const files = new FakeFiles();
  const location = new MisesEnLocation(db, files, journal, { now, newId: uuid });
  const network = await store.createNetwork('Réseau Essai');
  const alex = await store.createAgent({ networkId: network.id, firstName: 'Alex', lastName: 'Essai' });
  const bea = await store.createAgent({ networkId: network.id, firstName: 'Béa', lastName: 'Essai' });
  const owner = await store.createPerson({ networkId: network.id, agentId: alex.id, firstName: 'Bailleur', lastName: 'Inventé' });
  const home = await store.createProperty({ networkId: network.id, agentId: alex.id, reference: 'L-1', kind: 'home', postalCode: '21000' });
  const shop = await store.createProperty({ networkId: network.id, agentId: alex.id, reference: 'L-2', kind: 'commercial', postalCode: '21000' });
  const agent = { role: 'agent' as const, userId: alex.id, networkId: network.id };
  const other = { role: 'agent' as const, userId: bea.id, networkId: network.id };
  const dir = { role: 'direction' as const, userId: 'dir-1', networkId: network.id };
  const compliance = { role: 'compliance' as const, userId: 'conf-1', networkId: network.id };
  const partner = { role: 'partner' as const, userId: 'p-1', networkId: network.id };
  const open = async (facts: Partial<RentalFacts> = {}) => {
    const c = await location.create(agent, { propertyId: home.id, ownerPersonId: owner.id });
    if (!c.ok) throw new Error(c.code);
    const id = c.value.listingId;
    expect((await location.recordFacts(agent, id, { ...FACTS, ...facts })).ok).toBe(true);
    return id;
  };
  const annexes = async (id: string, kinds = ['dpe', 'erp', 'surface_habitable'], diagnosedOn = '2027-07-01') => {
    for (const kind of kinds) expect((await location.addAnnex(agent, id, { kind, ref: files.put(id), diagnosedOn })).ok, kind).toBe(true);
  };
  const events = (type: string) => db.all<{ data: string }>('SELECT data FROM journal WHERE type = ? ORDER BY seq', [type]);
  return { db, location, files, network, owner, home, shop, agent, other, dir, compliance, partner, open, annexes, events };
}

describeWithSqlite('W01 · mise en location contrôlée avant toute annonce', () => {
  it('[R100] un logement classé G est bloqué avant toute annonce, et son propriétaire reçoit son échéance, préparée une seule fois', async () => {
    const t = await setup();
    const id = await t.open({ energyClass: 'G', finalEnergyKwh: 400 });
    await t.annexes(id);
    const r = await t.location.check(t.agent, id);
    expect(r).toMatchObject({ ok: true, value: { decision: 'bloque', reasons: [{ code: 'energy_class', energyClass: 'G', bannedFrom: '2025-01-01' }], bannedFrom: '2025-01-01' } });
    expect(await t.location.advertisable(t.network.id, id)).toBe(false);
    await t.location.check(t.agent, id);
    const notices = await t.location.notices(t.agent, id);
    expect(notices.ok && notices.value).toHaveLength(1);
    expect(notices.ok && notices.value[0]!.text).toContain('Depuis le 1er janvier 2025');
    expect(await t.events('location.echeance_preparee')).toHaveLength(1);
    // Rien n'est envoyé d'ici : aucune ligne dans la boîte d'essai ni dans les messages.
    expect(await t.db.all('SELECT 1 FROM messages')).toHaveLength(0);
    const control = await t.events('location.controle');
    expect(JSON.parse(control[0]!.data)).toEqual({ rule: 'R100', decision: 'bloque', reasons: ['energy_class'], factsVersion: 1 });
  });

  it('[R100] un logement classé F se loue pour un bail commençant avant 2028, avec l’échéance de 2028 préparée', async () => {
    const t = await setup();
    const id = await t.open({ energyClass: 'F', finalEnergyKwh: 330, leaseStart: '2027-12-31' });
    await t.annexes(id);
    expect(await t.location.check(t.agent, id)).toMatchObject({ ok: true, value: { decision: 'louable', reasons: [], bannedFrom: '2028-01-01' } });
    expect(await t.location.advertisable(t.network.id, id)).toBe(true);
    const notices = await t.location.notices(t.agent, id);
    expect(notices.ok && notices.value[0]).toMatchObject({ energyClass: 'F', bannedFrom: '2028-01-01' });
    // Le même logement, pour un bail au 1er janvier 2028 : nouvelle version des faits, bloqué.
    expect(await t.location.recordFacts(t.agent, id, { ...FACTS, energyClass: 'F', finalEnergyKwh: 330, leaseStart: '2028-01-01' })).toEqual({ ok: true, value: { version: 2 } });
    expect(await t.location.advertisable(t.network.id, id)).toBe(false);
    expect(await t.location.check(t.agent, id)).toMatchObject({ ok: true, value: { decision: 'bloque', factsVersion: 2 } });
  });

  it('[R100] un logement classé F louable fin 2027 cesse d’être annonçable le 1er janvier 2028 ; un bail ne commence pas dans le passé', async () => {
    const t = await setup();
    const id = await t.open({ energyClass: 'F', finalEnergyKwh: 330, leaseStart: '2027-12-31' });
    // L'état des risques fait le jour même vaut jusqu'au 11 janvier 2028 : seule la classe joue ici.
    await t.annexes(id, ['dpe', 'erp', 'surface_habitable'], '2027-07-12');
    expect(await t.location.check(t.agent, id)).toMatchObject({ ok: true, value: { decision: 'louable' } });
    clock = Date.parse('2027-12-31T22:00:00.000Z');
    expect(await t.location.advertisable(t.network.id, id)).toBe(true);
    expect(await t.location.status(t.agent, id)).toMatchObject({ ok: true, value: { stale: false } });
    clock = Date.parse('2027-12-31T23:30:00.000Z');
    expect(await t.location.advertisable(t.network.id, id)).toBe(false);
    // Le statut dit la même chose : le contrôle d'hier ne vaut plus.
    expect(await t.location.status(t.agent, id)).toMatchObject({ ok: true, value: { check: { decision: 'louable' }, stale: true } });
    clock = Date.parse('2027-07-12T08:00:00.000Z');
    expect(await t.location.recordFacts(t.agent, id, { ...FACTS, energyClass: 'G', leaseStart: '2024-12-31' })).toEqual({ ok: false, rule: 'R100', code: 'invalid', field: 'leaseStart' });
  });

  it('[R101] [R17] une annexe manquante bloque ; une nouvelle version la corrige, l’ancienne reste ; un contrôle ancien ne vaut plus', async () => {
    const t = await setup();
    const id = await t.open({ buildYear: 1930 });
    await t.annexes(id);
    expect(await t.location.check(t.agent, id)).toMatchObject({ ok: true, value: { decision: 'bloque', reasons: [{ code: 'annex_missing', kind: 'crep' }] } });
    expect(await t.events('location.controle').then((e) => JSON.parse(e[0]!.data).rule)).toBe('R101');
    await t.annexes(id, ['crep']);
    expect(await t.location.status(t.agent, id)).toMatchObject({ ok: true, value: { stale: true, required: ['dpe', 'erp', 'surface_habitable', 'crep'] } });
    expect(await t.location.check(t.agent, id)).toMatchObject({ ok: true, value: { decision: 'louable' } });
    expect(await t.location.advertisable(t.network.id, id)).toBe(true);
    // Une nouvelle annexe change ce qu'a vu le contrôle : il faut contrôler de nouveau.
    await t.annexes(id, ['erp']);
    expect(await t.location.advertisable(t.network.id, id)).toBe(false);
    expect(await t.db.all("SELECT version FROM rental_annexes WHERE listing_id = ? AND kind = 'erp' ORDER BY version", [id])).toEqual([{ version: 1 }, { version: 2 }]);
    await expect(t.db.run('DELETE FROM rental_annexes')).rejects.toThrow(/rien ne s'efface/);
    await expect(t.db.run("UPDATE rental_facts SET energy_class = 'A'")).rejects.toThrow(/ne change plus/);
    await expect(t.db.run('DELETE FROM rental_checks')).rejects.toThrow(/rien ne s'efface/);
  });

  it('[R101] le temps qui passe rend une annexe échue : le logement n’est plus annonçable sans nouveau contrôle', async () => {
    const t = await setup();
    const id = await t.open({ leaseStart: '2027-07-14' });
    await t.annexes(id, ['dpe', 'surface_habitable']);
    await t.annexes(id, ['erp'], '2027-01-15');
    expect(await t.location.check(t.agent, id)).toMatchObject({ ok: true, value: { decision: 'louable' } });
    expect(await t.location.advertisable(t.network.id, id)).toBe(true);
    clock = Date.parse('2027-07-15T08:00:00.000Z');
    expect(await t.location.advertisable(t.network.id, id)).toBe(false);
  });

  it('[R101] références et dates des annexes contrôlées ; rien n’est rangé sans preuve stockée', async () => {
    const t = await setup();
    const id = await t.open();
    expect(await t.location.addAnnex(t.agent, id, { kind: 'dpe', ref: `location/${id}/${uuid()}.pdf`, diagnosedOn: '2027-07-01' })).toEqual({ ok: false, rule: null, code: 'not_stored' });
    expect(await t.location.addAnnex(t.agent, id, { kind: 'dpe', ref: `ailleurs/${uuid()}.pdf`, diagnosedOn: '2027-07-01' })).toEqual({ ok: false, rule: null, code: 'bad_ref' });
    expect(await t.location.addAnnex(t.agent, id, { kind: 'releve_bancaire', ref: t.files.put(id), diagnosedOn: '2027-07-01' })).toEqual({ ok: false, rule: null, code: 'bad_kind' });
    expect(await t.location.addAnnex(t.agent, id, { kind: 'dpe', ref: t.files.put(id), diagnosedOn: '2027-08-01' })).toEqual({ ok: false, rule: null, code: 'bad_date' });
    const ref = t.files.put(id);
    expect((await t.location.addAnnex(t.agent, id, { kind: 'dpe', ref, diagnosedOn: '2027-07-01' })).ok).toBe(true);
    expect(await t.location.addAnnex(t.agent, id, { kind: 'erp', ref, diagnosedOn: '2027-07-01' })).toEqual({ ok: false, rule: null, code: 'ref_used' });
    expect(await t.location.check(t.agent, 'inconnu')).toMatchObject({ ok: false, rule: 'R16', code: 'unknown' });
    const empty = await t.location.create(t.agent, { propertyId: t.home.id, ownerPersonId: t.owner.id });
    expect(await t.location.check(t.agent, empty.ok ? empty.value.listingId : '')).toEqual({ ok: false, rule: null, code: 'no_facts' });
  });

  it('[R16] l’agent du logement et la direction écrivent ; la conformité lit ; tout autre est refusé, au journal', async () => {
    const t = await setup();
    const id = await t.open();
    expect(await t.location.check(t.other, id)).toEqual({ ok: false, rule: 'R16', code: 'not_assigned' });
    expect(await t.location.check(t.partner, id)).toEqual({ ok: false, rule: 'R16', code: 'role' });
    expect(await t.location.recordFacts(t.compliance, id, FACTS)).toEqual({ ok: false, rule: 'R16', code: 'role' });
    expect((await t.location.status(t.compliance, id)).ok).toBe(true);
    expect((await t.location.notices(t.compliance, id)).ok).toBe(true);
    // Chaque lecture est au journal avant d'être rendue [R16].
    expect((await t.events('location.lue')).map((e) => JSON.parse(e.data).what)).toEqual(['status', 'notices']);
    expect((await t.location.check(t.dir, id)).ok).toBe(true);
    expect(await t.location.create(t.other, { propertyId: t.home.id, ownerPersonId: t.owner.id })).toEqual({ ok: false, rule: 'R16', code: 'not_assigned' });
    expect(await t.location.create(t.agent, { propertyId: t.shop.id, ownerPersonId: t.owner.id })).toEqual({ ok: false, rule: null, code: 'not_a_home' });
    expect(await t.location.create(t.agent, { propertyId: t.home.id, ownerPersonId: 'personne' })).toEqual({ ok: false, rule: null, code: 'unknown_owner' });
    const refused = await t.events('acces.refuse');
    expect(refused.length).toBe(4);
    for (const e of refused) expect(e.data).not.toMatch(/Bailleur|Inventé/);
    // Un agent devenu inactif ne touche plus à la mise en location.
    await t.db.run("UPDATE agents SET status = 'left' WHERE id = ?", [t.agent.userId]);
    expect(await t.location.check(t.agent, id)).toEqual({ ok: false, rule: 'R16', code: 'agent_inactive' });
  });

  it('[R13] [R107] le journal ne garde ni nom, ni montant ; aucune table ne fait recevoir un loyer ou un dépôt', async () => {
    const t = await setup();
    const id = await t.open({ energyClass: 'E' });
    await t.annexes(id);
    await t.location.check(t.agent, id);
    const all = await t.db.all<{ data: string }>('SELECT data FROM journal');
    for (const e of all) {
      expect(e.data).not.toContain('65000');
      expect(e.data).not.toMatch(/Bailleur|Inventé/);
    }
    const columns = await t.db.all<{ name: string }>("SELECT p.name FROM sqlite_master m JOIN pragma_table_info(m.name) p WHERE m.type = 'table' AND m.name LIKE 'rental_%'");
    for (const c of columns) expect(c.name).not.toMatch(/iban|bic|paid|received|deposit_received|encaiss/i);
  });
});

describe('AU017 · décence : pièce principale et hauteur, ou volume', () => {
  const today = '2026-11-18';
  const base = { ...FACTS, leaseStart: '2027-09-01' };
  const without = (f: typeof base) => {
    const { mainRoomHundredths: _r, ceilingHeightCm: _h, ...rest } = f;
    return rest;
  };
  it('[R101] 9 m² sans hauteur ni volume : jamais « louable », la raison dit ce qui manque', () => {
    const f = { ...without(base), livingAreaHundredths: 900 };
    expect(decencyOf(f)).toBe('inconnue');
    const reasons = checkDwelling(f, ALL_VALID, today);
    expect(reasons).toContainEqual({ code: 'dimensions_missing' });
    expect(reasons.some((r) => r.code === 'living_area')).toBe(false);
    // Une hauteur seule ne suffit pas à juger : il faut la pièce principale avec.
    expect(decencyOf({ ...f, ceilingHeightCm: 250 })).toBe('inconnue');
  });
  it('[R101] 9 m² sous 2,20 m : décent ; sous 2,19 m sans volume : non décent', () => {
    const f = { ...without(base), mainRoomHundredths: 900, ceilingHeightCm: 220 };
    expect(decencyOf(f)).toBe('oui');
    expect(decencyOf({ ...f, ceilingHeightCm: 219 })).toBe('non');
    expect(checkDwelling({ ...f, ceilingHeightCm: 219 }, ALL_VALID, today)[0]).toMatchObject({ code: 'living_area', ceilingHeightCm: 219 });
    expect(decencyOf({ ...f, mainRoomHundredths: 899 })).toBe('non');
  });
  it('[R101] la voie du volume : 20 m³ suffisent même avec une pièce de 8 m², 19,99 m³ non', () => {
    const f = { ...without(base), mainRoomHundredths: 800, ceilingHeightCm: 250 };
    expect(decencyOf({ ...f, habitableVolumeHundredths: 2_000 })).toBe('oui');
    expect(decencyOf({ ...f, habitableVolumeHundredths: 1_999 })).toBe('non');
    expect(decencyOf({ ...without(base), habitableVolumeHundredths: 2_000 })).toBe('oui');
  });
  it('[R101] une pièce principale plus grande que le logement, une hauteur hors bornes : refusées à la saisie', () => {
    const raw = { ...without(base), chargesMode: 'provision' };
    expect(parseFacts({ ...raw, mainRoomHundredths: 4_251 })).toEqual({ ok: false, field: 'mainRoomHundredths' });
    expect(parseFacts({ ...raw, ceilingHeightCm: 99 })).toEqual({ ok: false, field: 'ceilingHeightCm' });
    expect(parseFacts({ ...raw, habitableVolumeHundredths: 0 })).toEqual({ ok: false, field: 'habitableVolumeHundredths' });
    expect(parseFacts({ ...raw, mainRoomHundredths: 1_800, ceilingHeightCm: 250, habitableVolumeHundredths: 10_500 })).toMatchObject({ ok: true, value: { mainRoomHundredths: 1_800, ceilingHeightCm: 250, habitableVolumeHundredths: 10_500 } });
  });
});

describe('AU017 · la règle locale plus stricte, lue et datée, avant « louable »', () => {
  const today = '2026-11-18';
  const { localRules: _l, ...national } = FACTS;
  it('[R101] le seuil national rempli ne suffit pas : sans règle locale lue, jamais « louable »', () => {
    expect(decencyOf(national)).toBe('oui');
    expect(checkDwelling(national, ALL_VALID, today)).toContainEqual({ code: 'local_rules_unchecked' });
    expect(checkDwelling(FACTS, ALL_VALID, today).some((r) => r.code.startsWith('local_rules'))).toBe(false);
  });
  it('[R101] une règle locale non respectée bloque avec sa référence, même au-dessus du seuil national', () => {
    const f = { ...FACTS, localRules: { reference: 'Règlement sanitaire départemental, art. 40-1', checkedOn: '2027-01-04', compliant: false } };
    expect(checkDwelling(f, ALL_VALID, today)).toContainEqual({ code: 'local_rules_failed', reference: 'Règlement sanitaire départemental, art. 40-1' });
  });
  it('[R101] la règle locale se saisit avec sa référence et son jour, rien d’autre', () => {
    const raw = { ...national, chargesMode: 'provision' };
    expect(parseFacts({ ...raw, localRules: { reference: 'RS', checkedOn: '2027-01-04', compliant: true } })).toEqual({ ok: false, field: 'localRules' });
    expect(parseFacts({ ...raw, localRules: { reference: 'RSD art. 40', checkedOn: 'hier', compliant: true } })).toEqual({ ok: false, field: 'localRules' });
    expect(parseFacts({ ...raw, localRules: { reference: 'RSD art. 40', checkedOn: '2027-01-04', compliant: true, note: 'x' } })).toEqual({ ok: false, field: 'localRules' });
    expect(parseFacts({ ...raw, localRules: { reference: ' RSD art. 40 ', checkedOn: '2027-01-04', compliant: true } })).toMatchObject({ ok: true, value: { localRules: { reference: 'RSD art. 40', checkedOn: '2027-01-04', compliant: true } } });
  });
});

describe('AU098 · le calendrier énergétique de l’outre-mer', () => {
  it('[R100] Guadeloupe, Martinique, Guyane, La Réunion, Mayotte : G en 2028, F en 2031, pas de date pour E ; la métropole garde le sien', () => {
    expect(territoryOf('97100')).toBe('outre_mer');
    expect(territoryOf('97600')).toBe('outre_mer');
    expect(territoryOf('97700')).toBe('metropole');
    expect(territoryOf('20000')).toBe('metropole');
    expect(territoryOf('21000')).toBe('metropole');
    expect(banDate('G', 'outre_mer')).toBe('2028-01-01');
    expect(banDate('F', 'outre_mer')).toBe('2031-01-01');
    expect(banDate('E', 'outre_mer')).toBeNull();
    expect(banDate('G')).toBe('2025-01-01');
    const g = { ...FACTS, energyClass: 'G' as const, finalEnergyKwh: 460, leaseStart: '2027-09-01' };
    // Un G ultramarin se loue encore en 2027, sans le seuil métropolitain des 450 kWh ; en métropole, il est bloqué.
    expect(checkDwelling(g, ALL_VALID, '2026-11-18', 'outre_mer').some((r) => r.code === 'energy_class' || r.code === 'final_energy')).toBe(false);
    expect(checkDwelling(g, ALL_VALID, '2026-11-18').map((r) => r.code)).toEqual(expect.arrayContaining(['energy_class', 'final_energy']));
    expect(checkDwelling({ ...g, leaseStart: '2028-01-01' }, ALL_VALID, '2026-11-18', 'outre_mer')).toContainEqual({ code: 'energy_class', energyClass: 'G', bannedFrom: '2028-01-01' });
  });
});

describeWithSqlite('AU098 · un logement ultramarin contrôlé avec son calendrier', () => {
  it('[R100] un G de La Réunion se loue pour un bail de 2027, s’annonce, et son échéance dit le 1er janvier 2028', async () => {
    const t = await setup();
    const reunion = await t.db.first<{ id: string }>('SELECT id FROM properties WHERE id = ?', [t.home.id]);
    await t.db.run('UPDATE properties SET postal_code = ? WHERE id = ?', ['97400', reunion!.id]);
    const id = await t.open({ energyClass: 'G', finalEnergyKwh: 460 });
    await t.annexes(id);
    expect(await t.location.check(t.agent, id)).toMatchObject({ ok: true, value: { decision: 'louable', reasons: [], bannedFrom: '2028-01-01' } });
    expect(await t.location.advertisable(t.network.id, id)).toBe(true);
    // L'état relu ne dit pas le contrôle périmé : l'écran garde « Préparer l'annonce ».
    expect(await t.location.status(t.agent, id)).toMatchObject({ ok: true, value: { stale: false } });
    const notices = await t.location.notices(t.agent, id);
    expect(notices.ok && notices.value[0]).toMatchObject({ energyClass: 'G', bannedFrom: '2028-01-01' });
  });
});

describe('AU016 · le gel des loyers des logements F et G', () => {
  const today = '2026-11-18';
  const { firstLetting: _f, ...unknown } = { ...FACTS, energyClass: 'F' as const, finalEnergyKwh: 330, leaseStart: '2027-09-01' };
  it('[R100] un F sans loyer précédent ni première location n’est jamais louable ; un D n’est pas concerné', () => {
    expect(checkDwelling(unknown, ALL_VALID, today)).toContainEqual({ code: 'previous_rent_missing' });
    expect(checkDwelling({ ...unknown, energyClass: 'D' }, ALL_VALID, today).some((r) => r.code === 'previous_rent_missing')).toBe(false);
    expect(checkDwelling({ ...unknown, firstLetting: true }, ALL_VALID, today).some((r) => r.code === 'previous_rent_missing' || r.code === 'rent_freeze')).toBe(false);
  });
  it('[R100] un F reloué plus cher que le dernier loyer est bloqué ; au même loyer ou moins, il passe', () => {
    expect(checkDwelling({ ...unknown, previousRentCents: FACTS.rentCents - 1 }, ALL_VALID, today)).toContainEqual({ code: 'rent_freeze', previousRentCents: FACTS.rentCents - 1 });
    expect(checkDwelling({ ...unknown, previousRentCents: FACTS.rentCents }, ALL_VALID, today).some((r) => r.code === 'rent_freeze')).toBe(false);
    expect(checkDwelling({ ...unknown, energyClass: 'G', previousRentCents: FACTS.rentCents - 1 }, ALL_VALID, today, 'outre_mer')).toContainEqual({ code: 'rent_freeze', previousRentCents: FACTS.rentCents - 1 });
  });
  it('[R100] la saisie : un loyer précédent positif, ou la première location, jamais les deux', () => {
    const raw = { ...unknown, chargesMode: 'provision' };
    expect(parseFacts({ ...raw, previousRentCents: 0 })).toEqual({ ok: false, field: 'previousRentCents' });
    expect(parseFacts({ ...raw, firstLetting: true, previousRentCents: 60_000 })).toEqual({ ok: false, field: 'firstLetting' });
    expect(parseFacts({ ...raw, firstLetting: 'oui' })).toEqual({ ok: false, field: 'firstLetting' });
    expect(parseFacts({ ...raw, previousRentCents: 60_000 })).toMatchObject({ ok: true, value: { previousRentCents: 60_000 } });
  });
});

describeWithSqlite('AU016 · le loyer précédent rangé avec les faits', () => {
  it('[R100] rangé, relu au contrôle : un F reloué plus cher est bloqué de bout en bout', async () => {
    const t = await setup();
    const id = await t.open({ energyClass: 'F', finalEnergyKwh: 330, leaseStart: '2027-12-31', firstLetting: null, previousRentCents: 60_000 });
    await t.annexes(id);
    expect(await t.location.check(t.agent, id)).toMatchObject({ ok: true, value: { decision: 'bloque', reasons: [{ code: 'rent_freeze', previousRentCents: 60_000 }] } });
  });
});

// Arrêté préfectoral inventé : 20 € de référence, 24 € majoré, par m² et par mois.
const RC = { decree: 'Arrêté préfectoral inventé n° 0000-00', readOn: '2027-07-01', referenceCentsPerM2: 2_000, majoredCentsPerM2: 2_400, complementCents: 0, complementReason: null };

describe('AU015 · encadrement des loyers, règles écrites', () => {
  it('[R101] dans une commune encadrée, le loyer de base ne dépasse pas le loyer de référence majoré fois la surface ; au centime près', () => {
    const today = '2027-07-12';
    // 42,50 m² × 24 € = 1 020 € par mois.
    const at = (rentCents: number, complementCents = 0, complementReason: string | null = null) =>
      checkDwelling({ ...FACTS, rentCents, rentControl: { ...RC, complementCents, complementReason } }, ALL_VALID, today, 'metropole', true);
    expect(rentCeilingCents(RC, 4_250)).toBe(102_000);
    expect(at(102_000)).toEqual([]);
    expect(at(102_001)).toEqual([{ code: 'rent_above_ceiling', baseRentCents: 102_001, ceilingCents: 102_000 }]);
    // Un complément justifié s'ajoute au loyer de base ; sans justification, il est dit.
    expect(at(112_000, 10_000, 'Terrasse de 40 m² avec vue dégagée, rare dans le quartier')).toEqual([]);
    expect(at(112_000, 10_000)).toEqual([{ code: 'complement_unjustified' }]);
    // Jamais de complément pour un F ou un G.
    expect(checkDwelling({ ...FACTS, energyClass: 'F', rentControl: { ...RC, complementCents: 1_000, complementReason: 'Terrasse de 40 m² avec vue dégagée' } }, ALL_VALID, today, 'metropole', true)).toEqual([{ code: 'complement_forbidden', energyClass: 'F' }]);
    // Encadrée sans l'arrêté lu : jamais louable ; hors encadrement, l'arrêté n'est pas demandé.
    expect(checkDwelling(FACTS, ALL_VALID, today, 'metropole', true)).toEqual([{ code: 'rent_control_missing' }]);
    expect(checkDwelling(FACTS, ALL_VALID, today, 'metropole', false)).toEqual([]);
  });

  it('[R101] l’arrêté se saisit avec sa référence, son jour, deux loyers au m² dont le majoré au moins égal ; un complément vient avec sa justification', () => {
    expect(parseFacts({ ...FACTS, rentControl: RC })).toMatchObject({ ok: true, value: { rentControl: RC } });
    for (const bad of [
      { ...RC, majoredCentsPerM2: 1_999 },
      { ...RC, decree: '' },
      { ...RC, readOn: '2027-02-30' },
      { ...RC, complementCents: 0, complementReason: 'Une justification sans complément' },
      { ...RC, complementCents: 65_000 },
      { ...RC, inconnu: 1 },
    ]) expect(parseFacts({ ...FACTS, rentControl: bad })).toEqual({ ok: false, field: 'rentControl' });
  });
});

describeWithSqlite('AU015 · encadrement des loyers, à la mise en location', () => {
  it('[R101] la commune encadrée par une règle rangée : sans l’arrêté, bloqué ; au-dessus du plafond, bloqué ; dans le plafond, louable ; une règle finie ne compte plus', async () => {
    const t = await setup();
    const id = await t.open();
    await t.annexes(id);
    expect(await t.location.check(t.agent, id)).toMatchObject({ ok: true, value: { decision: 'louable' } });
    await t.db.run('INSERT INTO rental_listing_communes (listing_id, insee_code, recorded_by, recorded_at) VALUES (?, ?, ?, ?)', [id, '21999', 'agent:a', '2027-07-12T08:00:00.000Z']);
    const rule = (rid: string, until: string | null, recordedAt: string) =>
      t.db.run(
        "INSERT INTO commune_rental_rules (id, network_id, insee_code, rule, effective_from, effective_until, source, source_date, recorded_by, recorded_at) VALUES (?, ?, '21999', 'encadrement_loyers', '2027-01-01', ?, 'Arrêté inventé', '2026-12-01', 'direction:d', ?)",
        [rid, t.network.id, until, recordedAt],
      );
    await rule('r1', null, '2027-01-02T00:00:00.000Z');
    // La règle rangée rend le dernier contrôle caduc : plus annonçable sans nouveau contrôle.
    expect(await t.location.advertisable(t.network.id, id)).toBe(false);
    expect(await t.location.check(t.agent, id)).toMatchObject({ ok: true, value: { decision: 'bloque', reasons: [{ code: 'rent_control_missing' }] } });
    // 650 € pour 42,50 m² : sous un majoré de 15 € (637,50 €) ? Non : bloqué ; sous 24 € : louable.
    expect((await t.location.recordFacts(t.agent, id, { ...FACTS, rentControl: { ...RC, majoredCentsPerM2: 1_500, referenceCentsPerM2: 1_250 } })).ok).toBe(true);
    expect(await t.location.check(t.agent, id)).toMatchObject({ value: { decision: 'bloque', reasons: [{ code: 'rent_above_ceiling', baseRentCents: 65_000, ceilingCents: 63_750 }] } });
    expect((await t.location.recordFacts(t.agent, id, { ...FACTS, rentControl: RC })).ok).toBe(true);
    expect(await t.location.check(t.agent, id)).toMatchObject({ value: { decision: 'louable' } });
    expect(await t.location.advertisable(t.network.id, id)).toBe(true);
    // La fin de l'encadrement rangée plus tard (au 31 août 2027, avant le bail) : l'arrêté n'est plus demandé.
    await rule('r2', '2027-08-31', '2027-07-12T09:00:00.000Z');
    expect(await t.location.rentControlledOn({ id, network_id: t.network.id }, '2027-09-01')).toBe(false);
    expect(await t.location.rentControlledOn({ id, network_id: t.network.id }, '2027-08-31')).toBe(true);
  });
});
