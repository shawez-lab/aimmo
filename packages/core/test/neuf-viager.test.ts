import { expect, it } from 'vitest';
import { Acces, FicheClient, FicheUnique, SqlJournalStore, applyMigrations, fromSyncSqlite, type SqlDatabase, type Viewer } from '../src/index.ts';
import {
  ProgrammesNeufs,
  VIAGER_NOTICE,
  Viager,
  computeViager,
  feesOf,
  monthlyRent,
  usufructPercent,
  type ExpertViagerRelation,
  type ViagerInputs,
} from '../src/neuf-viager/index.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

// Jeu de test inventé : âges, valeurs, taux, table d'espérance et promoteur n'ont rien de réel.
const src = <T>(value: T, hypothesis = 'saisi pour le test') => ({ value, source: 'test', asOf: '2027-03-01', hypothesis });
const FULL: ViagerInputs = {
  marketValue: src(20_000_000),
  occupied: src(true),
  headAges: src([75]),
  bouquet: src(3_000_000),
  annualRateBp: src(300),
  expectancies: src([128], 'table inventée'),
};

it('[R530] la rente se calcule en entiers et suit la formule écrite', () => {
  // À taux nul : capital / n.
  expect(monthlyRent(10_000_000, 120, 0)).toBe(83_333);
  // À 3 % par an, 120 mois : c × t / (1 − (1 + t)^−n), au centime près de la formule en flottants.
  const t = 0.03 / 12;
  const expected = (10_000_000 * t) / (1 - (1 + t) ** -120);
  expect(Math.abs(monthlyRent(10_000_000, 120, 300) - expected)).toBeLessThanOrEqual(1);
  expect(monthlyRent(0, 120, 300)).toBe(0);
  // Barème de l'usufruit (CGI art. 669).
  expect([20, 21, 45, 60, 61, 75, 85, 90, 91, 100].map(usufructPercent)).toEqual([90, 80, 60, 50, 40, 30, 20, 20, 10, 10]);
});

it('[R530] un calcul de viager se rejoue à l’identique, et chaque chiffre porte sa source, sa date et son hypothèse', () => {
  const a = computeViager(FULL, '2027-03-01T10:00:00.000Z');
  const b = computeViager(JSON.parse(JSON.stringify(FULL)) as ViagerInputs, '2027-03-01T10:00:00.000Z');
  expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  if (a.status !== 'complet') throw new Error('incomplet');
  for (const l of a.lines) {
    expect(l.source.length).toBeGreaterThan(0);
    expect(l.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(l.hypothesis.length).toBeGreaterThan(2);
  }
  const v = (k: string) => a.lines.find((l) => l.key === k)!.value;
  // Occupé à 75 ans : usufruit 30 % × 60 % = 18 % de la valeur libre.
  expect(v('usageRight')).toBe(3_600_000);
  expect(v('occupiedValue')).toBe(16_400_000);
  expect(v('capital')).toBe(13_400_000);
  expect(v('months')).toBe(154);
  expect(a.monthlyRentCents).toBe(monthlyRent(13_400_000, 154, 300));
  expect(v('rentTotal')).toBe(a.monthlyRentCents * 154);
  expect(a.notice).toBe(VIAGER_NOTICE);
  // Viager libre : aucun droit d'usage retenu.
  const libre = computeViager({ ...FULL, occupied: src(false) }, '2027-03-01T10:00:00.000Z');
  if (libre.status !== 'complet') throw new Error('incomplet');
  expect(libre.lines.find((l) => l.key === 'usageRight')!.value).toBe(0);
  // Deux têtes : la plus longue espérance, l'âge de la plus jeune pour l'usufruit.
  const couple = computeViager({ ...FULL, headAges: src([75, 68]), expectancies: src([128, 175]) }, '2027-03-01T10:00:00.000Z');
  if (couple.status !== 'complet') throw new Error('incomplet');
  expect(couple.lines.find((l) => l.key === 'expectancyRetained')!.value).toBe(175);
  expect(couple.lines.find((l) => l.key === 'usageRight')!.value).toBe(20_000_000 * 0.4 * 0.6);
  // Une entrée manquante : incomplet, avec ce qui manque, jamais un chiffre [R10].
  const inc = computeViager({ ...FULL, expectancies: null }, '2027-03-01T10:00:00.000Z');
  expect(inc).toEqual({ status: 'incomplet', formulaVersion: 1, missing: ['expectancies'], notice: VIAGER_NOTICE });
});

it('[R534] les frais d’un lot se calculent en centimes, arrondis au plus proche', () => {
  expect(feesOf(25_000_000, 250)).toBe(625_000);
  expect(feesOf(19_999_999, 250)).toBe(500_000);
});

describeWithSqlite('HX48 · programmes neufs et viager', () => {
  async function setup() {
    const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
    await applyMigrations(db, loadMigrations());
    let clock = new Date('2027-03-01T10:00:00.000Z');
    const now = () => clock;
    const journal = new SqlJournalStore(db);
    const store = new FicheClient(db, { now });
    const acces = new Acces(db, store, new FicheUnique(db, store, { now }), journal, { now });
    const network = await store.createNetwork('Réseau test');
    const alex = await store.createAgent({ networkId: network.id, firstName: 'Alex', lastName: 'Agent' });
    const sam = await store.createAgent({ networkId: network.id, firstName: 'Sam', lastName: 'Agent' });
    const as = (role: string, userId: string): Viewer => ({ role, userId, networkId: network.id }) as Viewer;
    const agent = as('agent', alex.id);
    const other = as('agent', sam.id);
    const direction = as('direction', 'direction-1');
    const person = await store.createPerson({ networkId: network.id, agentId: alex.id, firstName: 'Léa', lastName: 'Exemple' });
    const project = await store.createProject({ networkId: network.id, agentId: alex.id, personId: person.id, kind: 'sell' });
    const calls: unknown[] = [];
    const relation: ExpertViagerRelation = {
      async propose(_viewer, input) {
        calls.push(input);
        return { ok: true, value: { referralId: 'ref-1', shown: [] } };
      },
    };
    const viager = new Viager(db, journal, { now, relation });
    const neuf = new ProgrammesNeufs(db, journal, { now });
    const partner = async (trade: string, name: string) => {
      const id = crypto.randomUUID();
      await db.run('INSERT INTO partners (id, network_id, trade, business_name, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)', [
        id,
        network.id,
        trade,
        name,
        'direction:direction-1',
        clock.toISOString(),
      ]);
      return id;
    };
    const table = async (rows = [{ age: 68, expectancyTenths: 175 }, { age: 75, expectancyTenths: 128 }]) => {
      const r = await viager.importLifeTable(direction, { vintage: '2024', source: 'Table inventée pour les tests, ensemble des deux sexes', rows });
      if (!r.ok) throw new Error(r.code);
      return r.value.tableId;
    };
    const typed = {
      marketValue: { value: 20_000_000, hypothesis: 'valeur libre de l’avis de valeur' },
      occupied: { value: true, hypothesis: 'le vendeur garde l’usage' },
      headAges: { value: [75], hypothesis: 'âge déclaré' },
      bouquet: { value: 3_000_000, hypothesis: 'convenu avec le vendeur' },
      annualRateBp: { value: 300, hypothesis: 'taux technique retenu' },
    };
    return {
      db,
      journal,
      acces,
      store,
      network,
      alex,
      agent,
      other,
      direction,
      project,
      viager,
      neuf,
      partner,
      table,
      typed,
      calls,
      setClock: (d: Date) => {
        clock = d;
      },
    };
  }

  it('[R530] le calcul rangé se rejoue à l’identique, et ne change plus', async () => {
    const t = await setup();
    await t.table();
    const r = await t.viager.compute(t.acces, t.agent, { projectId: t.project.id, inputs: t.typed });
    if (!r.ok) throw new Error(r.code);
    expect(r.value.result.status).toBe('complet');
    // Ce que l'agent saisit porte son nom comme source, quoi qu'il écrive.
    expect(r.value.inputs.bouquet!.source).toBe(`saisi:agent:${t.alex.id}`);
    expect(await t.viager.replay(t.network.id, r.value.id)).toEqual({ same: true, result: r.value.result });
    await expect(t.db.run("UPDATE viager_calculations SET result = '{}' WHERE id = ?", [r.value.id])).rejects.toThrow(/R530/);
    await expect(t.db.run('DELETE FROM viager_calculations WHERE id = ?', [r.value.id])).rejects.toThrow(/efface/);
    // Le journal ne garde ni montant ni âge.
    const events = await t.journal.all();
    expect(events.some((e) => e.type === 'viager.calcul')).toBe(true);
    expect(JSON.stringify(events)).not.toMatch(/20000000|3000000|"75"|\b75\b/);
  });

  it('[R531] l’espérance de vie vient de la table de la direction, jamais saisie, sans colonne de sexe, et ne change plus', async () => {
    const t = await setup();
    // Sans table : incomplet, jamais une espérance inventée.
    const none = await t.viager.compute(t.acces, t.agent, { inputs: t.typed });
    if (!none.ok) throw new Error(none.code);
    expect(none.value.result).toMatchObject({ status: 'incomplet', missing: ['expectancies'] });
    // Saisie par l'agent : refusée.
    expect(await t.viager.compute(t.acces, t.agent, { inputs: { ...t.typed, expectancies: { value: [300], hypothesis: 'je pense' } } })).toEqual({
      ok: false,
      rule: 'R531',
      code: 'esperance_saisie',
      field: 'expectancies',
    });
    // Une table par sexe : refusée ; un agent ne l'importe pas.
    expect(
      await t.viager.importLifeTable(t.direction, { vintage: '2024', source: 'Table inventée pour les tests', rows: [{ age: 75, expectancyTenths: 128, sex: 'f' }] }),
    ).toEqual({ ok: false, rule: 'R531', code: 'colonnes' });
    expect(await t.viager.importLifeTable(t.agent, { vintage: '2024', source: 'Table inventée', rows: [{ age: 75, expectancyTenths: 128 }] })).toMatchObject({
      ok: false,
      rule: 'R16',
    });
    const tableId = await t.table();
    await expect(t.db.run('UPDATE life_table_rows SET expectancy_tenths = 500 WHERE table_id = ?', [tableId])).rejects.toThrow(/R531/);
    // Aucune ligne ne s'ajoute à une table importée.
    await expect(t.db.run('INSERT INTO life_table_rows (table_id, age, expectancy_tenths) VALUES (?, 90, 60)', [tableId])).rejects.toThrow(/R531/);
    const r = await t.viager.compute(t.acces, t.agent, { inputs: t.typed });
    if (!r.ok) throw new Error(r.code);
    expect(r.value.inputs.expectancies).toMatchObject({ value: [128] });
    expect(r.value.inputs.expectancies!.source).toContain(`table:${tableId}`);
    expect(r.value.inputs.expectancies!.source).toContain('millésime 2024');
    // Un âge absent de la table : incomplet.
    const absent = await t.viager.compute(t.acces, t.agent, { inputs: { ...t.typed, headAges: { value: [90], hypothesis: 'âge déclaré' } } });
    if (!absent.ok) throw new Error(absent.code);
    expect(absent.value.result.status).toBe('incomplet');
  });

  it('[R532] ni offre ni conseil : la mention toujours, le bouquet borné, l’expert du viager proposé par M18', async () => {
    const t = await setup();
    const refused = { ok: false, rule: 'R532', code: 'bouquet_trop_haut', field: 'bouquet' };
    // Sans table (calcul incomplet), le bouquet reste borné par la valeur occupée, ou par la valeur libre.
    expect(await t.viager.compute(t.acces, t.agent, { inputs: { ...t.typed, bouquet: { value: 17_000_000, hypothesis: 'convenu' } } })).toEqual(refused);
    const { occupied: _o, ...noOccupied } = t.typed;
    expect(await t.viager.compute(t.acces, t.agent, { inputs: { ...noOccupied, bouquet: { value: 50_000_000, hypothesis: 'convenu' } } })).toEqual(refused);
    expect(await t.db.first<{ n: number }>('SELECT count(*) AS n FROM viager_calculations')).toEqual({ n: 0 });
    await t.table();
    // Le bouquet égal à la valeur occupée passe : rente nulle.
    const edge = await t.viager.compute(t.acces, t.agent, { inputs: { ...t.typed, bouquet: { value: 16_400_000, hypothesis: 'convenu' } } });
    expect(edge.ok && edge.value.result.status === 'complet' && edge.value.result.monthlyRentCents).toBe(0);
    expect(await t.viager.compute(t.acces, t.agent, { inputs: { ...t.typed, bouquet: { value: 16_400_001, hypothesis: 'convenu' } } })).toEqual(refused);
    const r = await t.viager.compute(t.acces, t.agent, { projectId: t.project.id, inputs: t.typed });
    if (!r.ok) throw new Error(r.code);
    expect(r.value.result.notice).toBe(VIAGER_NOTICE);
    expect(await t.viager.proposeExpert(t.acces, t.agent, r.value.id, '21000')).toEqual({ ok: true, value: { referralId: 'ref-1' } });
    expect(t.calls).toEqual([{ projectId: t.project.id, trade: 'expert_viager', postcode: '21000' }]);
    // Un autre agent ne lit ni ne propose sur le calcul d'un projet qu'il ne suit pas.
    expect(await t.viager.read(t.acces, t.other, r.value.id)).toMatchObject({ ok: false, rule: 'R16' });
    expect(await t.viager.proposeExpert(t.acces, t.other, r.value.id)).toMatchObject({ ok: false, rule: 'R16' });
    expect(t.calls).toHaveLength(1);
  });

  it('[R532] le calcul d’un autre sur un bien vu en partage ne se lit pas, et un agent parti ne calcule ni ne lit plus', async () => {
    const t = await setup();
    await t.table();
    const own = await t.viager.compute(t.acces, t.other, { inputs: t.typed });
    if (!own.ok) throw new Error(own.code);
    expect((await t.viager.read(t.acces, t.other, own.value.id)).ok).toBe(true);
    // Le calcul d'un autre, rattaché à rien : refusé.
    expect(await t.viager.read(t.acces, t.agent, own.value.id)).toMatchObject({ ok: false, rule: 'R16', code: 'not_assigned' });
    // Rattaché à un bien du fichier commun (vu en partage) : seul celui qui voit le bien en entier, ou son auteur, le lit.
    const prop = await t.store.createProperty({ networkId: t.network.id, agentId: t.alex.id, reference: 'REF-V-1', kind: 'home', postalCode: '21000', city: 'Dijon', surfaceM2: 62, rooms: 3, priceEur: 200000, status: 'available' });
    const onProp = await t.viager.compute(t.acces, t.agent, { propertyId: prop.id, inputs: t.typed });
    if (!onProp.ok) throw new Error(onProp.code);
    expect((await t.viager.read(t.acces, t.agent, onProp.value.id)).ok).toBe(true);
    const shared = await t.acces.readProperty(t.other, prop.id);
    expect(shared).toMatchObject({ ok: true, view: 'shared' });
    expect(await t.viager.read(t.acces, t.other, onProp.value.id)).toMatchObject({ ok: false, rule: 'R16', code: 'not_assigned' });
    // Un agent parti : plus de calcul ni de lecture, même rattachés à rien.
    await t.db.run("UPDATE agents SET status = 'left' WHERE id = ?", [t.alex.id]);
    expect(await t.viager.compute(t.acces, t.agent, { inputs: t.typed })).toMatchObject({ ok: false, rule: 'R16', code: 'agent_inactive' });
    expect(await t.viager.read(t.acces, t.agent, onProp.value.id)).toMatchObject({ ok: false, rule: 'R16', code: 'agent_inactive' });
  });

  async function program(t: Awaited<ReturnType<typeof setup>>) {
    const promoter = await t.partner('promoteur', 'Promoteur Inventé');
    const p = await t.neuf.createProgram(t.direction, { promoterPartnerId: promoter, agentId: t.alex.id, name: 'Les Jardins Test', city: 'Dijon', postalCode: '21000' });
    if (!p.ok) throw new Error(p.code);
    const lot = (lotRef: string, status: string, confirmedOn = '2027-03-01', priceCents = 25_000_000) =>
      t.neuf.recordLot(t.agent, p.value.programId, { lotRef, typology: 't3', livingAreaHundredths: 6500, floor: 2, priceCents, status, confirmedOn });
    return { programId: p.value.programId, lot };
  }

  it('[R533] un lot vendu disparaît de la grille publiée et ne revient jamais', async () => {
    const t = await setup();
    const { programId, lot } = await program(t);
    for (const ref of ['A01', 'A02', 'A03', 'A04']) expect((await lot(ref, 'disponible')).ok).toBe(true);
    expect((await t.neuf.publishedGrid(t.network.id, programId))!.lots.map((l) => l.lotRef)).toEqual(['A01', 'A02', 'A03', 'A04']);
    await lot('A01', 'vendu');
    await lot('A02', 'reserve');
    await lot('A03', 'option');
    expect((await t.neuf.publishedGrid(t.network.id, programId))!.lots.map((l) => l.lotRef)).toEqual(['A04']);
    // Un désistement rend le lot réservé disponible ; un lot vendu ne revient pas, ni par le code ni par la base.
    await lot('A02', 'disponible');
    expect(await lot('A01', 'disponible')).toEqual({ ok: false, rule: 'R533', code: 'vendu' });
    await expect(
      t.db.run(
        "INSERT INTO new_program_lot_versions (program_id, lot_ref, version, typology, living_area_hundredths, floor, price_cents, status, confirmed_on, created_by, created_at) VALUES (?, 'A01', 3, 't3', 6500, 2, 25000000, 'disponible', '2027-03-01', 'x', 'x')",
        [programId],
      ),
    ).rejects.toThrow(/R533/);
    await expect(t.db.run("UPDATE new_program_lot_versions SET status = 'disponible' WHERE lot_ref = 'A01'")).rejects.toThrow(/ne change plus/);
    expect((await t.neuf.publishedGrid(t.network.id, programId))!.lots.map((l) => l.lotRef)).toEqual(['A02', 'A04']);
  });

  it('[R533] un lot non reconfirmé depuis 14 jours sort de la grille publiée, la grille ne dit rien de personne', async () => {
    const t = await setup();
    const { programId, lot } = await program(t);
    await lot('B01', 'disponible', '2027-03-01');
    await lot('B02', 'disponible', '2027-03-01');
    t.setClock(new Date('2027-03-15T10:00:00.000Z'));
    expect((await t.neuf.publishedGrid(t.network.id, programId))!.lots).toHaveLength(2);
    t.setClock(new Date('2027-03-16T10:00:00.000Z'));
    await lot('B02', 'disponible', '2027-03-16');
    const grid = (await t.neuf.publishedGrid(t.network.id, programId))!;
    expect(grid.lots.map((l) => l.lotRef)).toEqual(['B02']);
    const mine = await t.neuf.agentGrid(t.agent, programId);
    if (!mine.ok) throw new Error(mine.code);
    expect(mine.value.toConfirm).toEqual(['B01']);
    // Une date de confirmation à venir est refusée.
    expect(await lot('B03', 'disponible', '2027-03-20')).toMatchObject({ ok: false, code: 'confirmed_on' });
    // Aucune donnée personnelle dans la grille publiée.
    const text = JSON.stringify(grid);
    for (const s of [t.alex.id, 'Alex', 'agent:', 'direction']) expect(text).not.toContain(s);
    // Un autre agent ne tient pas la grille.
    expect(await t.neuf.recordLot(t.other, programId, { lotRef: 'B09', typology: 't2', livingAreaHundredths: 4500, floor: 1, priceCents: 18_000_000, status: 'disponible', confirmedOn: '2027-03-16' })).toMatchObject({
      ok: false,
      rule: 'R16',
    });
  });

  it('[R534] les frais réduits du neuf viennent du barème de la direction, sourcés ; sans barème, aucun chiffre', async () => {
    const t = await setup();
    const { programId, lot } = await program(t);
    await lot('C01', 'disponible');
    expect((await t.neuf.publishedGrid(t.network.id, programId))!.lots[0]!.fees).toBeNull();
    expect(await t.neuf.setFeeScale(t.agent, { kind: 'neuf', rateBp: 250, source: 'Barème inventé', validFrom: '2027-01-01' })).toMatchObject({ ok: false, rule: 'R16' });
    expect((await t.neuf.setFeeScale(t.direction, { kind: 'neuf', rateBp: 250, source: 'Barème du neuf inventé pour les tests', validFrom: '2027-01-01' })).ok).toBe(true);
    // Le neuf seul ne suffit pas pour dire l'écart.
    expect((await t.neuf.publishedGrid(t.network.id, programId))!.lots[0]!.fees).toBeNull();
    expect((await t.neuf.setFeeScale(t.direction, { kind: 'ancien', rateBp: 750, source: 'Barème de l’ancien inventé pour les tests', validFrom: '2027-01-01' })).ok).toBe(true);
    // Un barème qui ne commence que plus tard ne compte pas encore.
    expect((await t.neuf.setFeeScale(t.direction, { kind: 'neuf', rateBp: 300, source: 'Barème futur inventé', validFrom: '2027-06-01' })).ok).toBe(true);
    const fees = (await t.neuf.publishedGrid(t.network.id, programId))!.lots[0]!.fees!;
    expect(fees.newFees.value).toBe(625_000);
    expect(fees.oldFees.value).toBe(1_875_000);
    expect(fees.saving.value).toBe(1_250_000);
    expect(fees.newFees.source).toContain('Barème du neuf inventé');
    expect(fees.oldFees.source).toContain('Barème de l’ancien inventé');
    for (const f of [fees.newFees, fees.oldFees, fees.saving]) expect(f.hypothesis.length).toBeGreaterThan(5);
  });

  it('un programme ne vient que d’un promoteur partenaire, par la direction', async () => {
    const t = await setup();
    const notary = await t.partner('notaire', 'Notaire Inventé');
    expect(await t.neuf.createProgram(t.direction, { promoterPartnerId: notary, agentId: t.alex.id, name: 'Test', city: 'Dijon', postalCode: '21000' })).toMatchObject({
      ok: false,
      code: 'not_promoter',
    });
    await expect(
      t.db.run("INSERT INTO new_programs (id, network_id, promoter_partner_id, agent_id, name, city, postal_code, created_by, created_at) VALUES ('p', ?, ?, ?, 'Test', 'Dijon', '21000', 'x', 'x')", [
        t.network.id,
        notary,
        t.alex.id,
      ]),
    ).rejects.toThrow(/promoteur/);
    const promoter = await t.partner('promoteur', 'Promoteur Inventé');
    expect(await t.neuf.createProgram(t.agent, { promoterPartnerId: promoter, agentId: t.alex.id, name: 'Test', city: 'Dijon', postalCode: '21000' })).toMatchObject({
      ok: false,
      rule: 'R16',
    });
  });
});
