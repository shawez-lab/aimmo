import { expect, it } from 'vitest';
import type { DiffusionDecision } from '../src/documents/retractation.ts';
import { Panneaux, cleanAddress, signPickupsJob } from '../src/panneaux/panneaux.ts';
import { Acces, FicheClient, FicheUnique, SqlJournalStore, applyMigrations, fromSyncSqlite, verifyChain, type SqlDatabase } from '../src/index.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

// Réseau, agents, bien et adresses inventés.
const MONDAY_9H = Date.parse('2026-12-07T08:00:00.000Z');
const DAY = 24 * 3_600_000;
const ADDRESS = { streetNumber: '12 bis', street: 'Rue des Essais', postcode: '21240', city: 'Talant' };

async function setup() {
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  let clock = MONDAY_9H;
  const now = (): Date => new Date(clock);
  const journal = new SqlJournalStore(db);
  const store = new FicheClient(db, { now });
  const fiche = new FicheUnique(db, store, { now });
  const acces = new Acces(db, store, fiche, journal, { now });
  // La porte de diffusion de D05, remplacée : chaque bien a sa décision, que le test change.
  const decisions = new Map<string, DiffusionDecision>();
  const allowed = (mandateId = 'm1'): DiffusionDecision => ({ allowed: true, reason: 'allowed', mandateId, withdrawalLastDay: null });
  const gate = { canDiffuse: async (_n: string, propertyId: string) => decisions.get(propertyId) ?? { allowed: false, reason: 'no_mandate' as const, mandateId: null, withdrawalLastDay: null } };
  const panneaux = new Panneaux(db, acces, gate, journal, { now });
  const network = await store.createNetwork('Réseau test');
  const alex = await store.createAgent({ networkId: network.id, firstName: 'Alex', lastName: 'Agent' });
  const sam = await store.createAgent({ networkId: network.id, firstName: 'Sam', lastName: 'Bienveillant' });
  const as = (role: 'agent' | 'direction' | 'compliance', userId: string) => ({ role, userId, networkId: network.id });
  const agentAlex = as('agent', alex.id);
  const agentSam = as('agent', sam.id);
  const direction = as('direction', 'd1');
  const property = await store.createProperty({ networkId: network.id, agentId: sam.id, reference: 'B1', kind: 'home', postalCode: '21240', city: 'Talant', priceEur: 250_000, surfaceM2: 90, rooms: 4, status: 'available' });
  const other = await store.createProperty({ networkId: network.id, agentId: alex.id, reference: 'B2', kind: 'home', postalCode: '21000', city: 'Dijon', priceEur: 180_000, surfaceM2: 70, rooms: 3, status: 'available' });
  decisions.set(property.id, allowed('m1'));
  decisions.set(other.id, allowed('m2'));
  return { db, journal, panneaux, gate, decisions, store, network, alex, sam, agentAlex, agentSam, direction, as, acces, property, other, setClock: (t: number) => (clock = t) };
}

it('[R282] l’adresse d’une pose est une adresse, remise en forme, sans retour à la ligne', () => {
  expect(cleanAddress({ streetNumber: ' 12  bis ', street: ' Rue  des Essais ', postcode: '21240', city: ' Talant ' })).toEqual(ADDRESS);
  expect(cleanAddress({ ...ADDRESS, streetNumber: '3' })).toMatchObject({ streetNumber: '3' });
  for (const bad of [
    { ...ADDRESS, streetNumber: 'douze' },
    { ...ADDRESS, streetNumber: '12345' },
    { ...ADDRESS, street: 'Rue\ndes Essais' },
    { ...ADDRESS, street: '12' },
    { ...ADDRESS, postcode: '2124' },
    { ...ADDRESS, city: '' },
    { ...ADDRESS, city: 42 },
    null,
    'Rue des Essais',
  ]) expect(cleanAddress(bad)).toBeNull();
});

describeWithSqlite('HX14 · le stock de panneaux', () => {
  it('[R282] chaque panneau a son numéro, donné par le code, unique dans le réseau ; seule la direction en ajoute', async () => {
    const t = await setup();
    expect(await t.panneaux.addToStock(t.direction, 'grand', 2)).toEqual({ ok: true, numbers: [1, 2] });
    expect(await t.panneaux.addToStock(t.direction, 'petit')).toEqual({ ok: true, numbers: [3] });
    expect(await t.panneaux.addToStock(t.agentSam, 'grand')).toMatchObject({ ok: false, rule: 'R16' });
    expect(await t.panneaux.addToStock(t.direction, 'géant')).toEqual({ ok: false, rule: 'R282', code: 'bad_size' });
    expect(await t.panneaux.addToStock(t.direction, 'grand', 0)).toEqual({ ok: false, rule: 'R282', code: 'bad_count' });
    await expect(t.db.run("UPDATE signs SET size = 'petit' WHERE number = 1")).rejects.toThrow();
    await expect(t.db.run('DELETE FROM signs WHERE number = 1')).rejects.toThrow();
  });

  it('[R282] un panneau posé est rattaché à un bien, par son agent ou la direction, à l’adresse du bien', async () => {
    const t = await setup();
    await t.panneaux.addToStock(t.direction, 'grand', 3);
    const r = await t.panneaux.place(t.agentSam, { signNumber: 1, propertyId: t.property.id, address: ADDRESS });
    expect(r).toMatchObject({ ok: true });
    if (!r.ok) return;
    const row = await t.db.first<{ property_id: string; agent_id: string; mandate_id: string }>('SELECT property_id, agent_id, mandate_id FROM sign_placements WHERE id = ?', [r.placementId]);
    expect(row).toEqual({ property_id: t.property.id, agent_id: t.sam.id, mandate_id: 'm1' });
    // La direction pose aussi ; la pose reste à l'agent du bien.
    const d = await t.panneaux.place(t.direction, { signNumber: 2, propertyId: t.property.id, address: { ...ADDRESS, streetNumber: '14', city: 'TALANT' } });
    expect(d).toMatchObject({ ok: true });
    if (d.ok) expect((await t.db.first<{ agent_id: string }>('SELECT agent_id FROM sign_placements WHERE id = ?', [d.placementId]))!.agent_id).toBe(t.sam.id);
    // Sans bien, sur le bien d'un autre, ou ailleurs que dans sa commune : refusé.
    expect(await t.panneaux.place(t.agentSam, { signNumber: 3, propertyId: null, address: ADDRESS })).toEqual({ ok: false, rule: 'R282', code: 'sans_bien' });
    expect(await t.panneaux.place(t.agentAlex, { signNumber: 3, propertyId: t.property.id, address: ADDRESS })).toMatchObject({ ok: false, rule: 'R16' });
    expect(await t.panneaux.place(t.agentSam, { signNumber: 3, propertyId: t.property.id, address: { ...ADDRESS, postcode: '21000' } })).toEqual({ ok: false, rule: 'R282', code: 'hors_du_bien' });
    expect(await t.panneaux.place(t.agentSam, { signNumber: 3, propertyId: t.property.id, address: { ...ADDRESS, city: 'Dijon' } })).toEqual({ ok: false, rule: 'R282', code: 'hors_du_bien' });
    expect(await t.panneaux.place(t.agentSam, { signNumber: 9, propertyId: t.property.id, address: ADDRESS })).toEqual({ ok: false, rule: 'R282', code: 'unknown_sign' });
    expect(await t.panneaux.place(t.as('compliance', 'c1'), { signNumber: 3, propertyId: t.property.id, address: ADDRESS })).toMatchObject({ ok: false, rule: 'R16' });
    // La base refuse une pose sans bien.
    const sign = await t.db.first<{ id: string }>('SELECT id FROM signs WHERE number = 3');
    await expect(
      t.db.run("INSERT INTO sign_placements (id, network_id, sign_id, property_id, agent_id, mandate_id, street_number, street, postcode, city, placed_by, placed_at) VALUES ('x', ?, ?, 'nulle-part', ?, 'm1', '1', 'Rue des Essais', '21240', 'Talant', 'test', 'now')", [t.network.id, sign!.id, t.sam.id]),
    ).rejects.toThrow();
  });

  it('[R282] [R42] un panneau ne se pose que si le bien peut être diffusé, et jamais sur un bien vendu', async () => {
    const t = await setup();
    await t.panneaux.addToStock(t.direction, 'grand');
    t.decisions.set(t.property.id, { allowed: false, reason: 'withdrawal_period', mandateId: 'm1', withdrawalLastDay: '2026-12-10' });
    expect(await t.panneaux.place(t.agentSam, { signNumber: 1, propertyId: t.property.id, address: ADDRESS })).toEqual({ ok: false, rule: 'R42', code: 'withdrawal_period' });
    t.decisions.set(t.property.id, { allowed: true, reason: 'allowed', mandateId: 'm1', withdrawalLastDay: null });
    await t.db.run("UPDATE properties SET status = 'sold' WHERE id = ?", [t.property.id]);
    expect(await t.panneaux.place(t.agentSam, { signNumber: 1, propertyId: t.property.id, address: ADDRESS })).toEqual({ ok: false, rule: 'R282', code: 'bien_vendu' });
    expect(await t.db.first<{ n: number }>('SELECT COUNT(*) AS n FROM sign_placements')).toEqual({ n: 0 });
  });

  it('[R282] un panneau n’est posé qu’à un endroit à la fois, même demandé deux fois en même temps ; perdu, il ne se pose plus', async () => {
    const t = await setup();
    await t.panneaux.addToStock(t.direction, 'grand');
    const both = await Promise.all([
      t.panneaux.place(t.agentSam, { signNumber: 1, propertyId: t.property.id, address: ADDRESS }),
      t.panneaux.place(t.agentAlex, { signNumber: 1, propertyId: t.other.id, address: { streetNumber: '3', street: 'Rue du Test', postcode: '21000', city: 'Dijon' } }),
    ]);
    expect(both.filter((r) => r.ok)).toHaveLength(1);
    expect(both.filter((r) => !r.ok)).toEqual([{ ok: false, rule: 'R282', code: 'pas_au_stock' }]);
    const first = both.find((r) => r.ok) as { ok: true; placementId: string };
    const owner = both[0].ok ? t.agentSam : t.agentAlex;
    // La base garde la même règle, même sans le code.
    const sign = await t.db.first<{ id: string }>('SELECT id FROM signs WHERE number = 1');
    await expect(
      t.db.run("INSERT INTO sign_placements (id, network_id, sign_id, property_id, agent_id, mandate_id, street_number, street, postcode, city, placed_by, placed_at) VALUES ('x', ?, ?, ?, ?, 'm1', '1', 'Rue des Essais', '21240', 'Talant', 'test', 'now')", [t.network.id, sign!.id, t.property.id, t.sam.id]),
    ).rejects.toThrow(/déjà posé/);
    // Récupéré, il revient au stock et se pose de nouveau ; perdu, plus jamais.
    expect(await t.panneaux.remove(owner, first.placementId, 'recupere')).toEqual({ ok: true });
    expect(await t.panneaux.remove(owner, first.placementId, 'perdu')).toEqual({ ok: false, rule: 'R283', code: 'deja_retire' });
    const again = await t.panneaux.place(t.agentSam, { signNumber: 1, propertyId: t.property.id, address: ADDRESS });
    expect(again).toMatchObject({ ok: true });
    if (!again.ok) return;
    expect(await t.panneaux.remove(t.agentAlex, again.placementId, 'perdu')).toMatchObject({ ok: false, rule: 'R16' });
    expect(await t.panneaux.remove(t.agentSam, again.placementId, 'jeté')).toEqual({ ok: false, rule: 'R283', code: 'bad_outcome' });
    expect(await t.panneaux.remove(t.direction, again.placementId, 'perdu')).toEqual({ ok: true });
    expect(await t.panneaux.place(t.agentSam, { signNumber: 1, propertyId: t.property.id, address: ADDRESS })).toEqual({ ok: false, rule: 'R282', code: 'pas_au_stock' });
    await expect(t.db.run('DELETE FROM sign_removals')).rejects.toThrow();
    await expect(t.db.run("UPDATE sign_removals SET outcome = 'recupere'")).rejects.toThrow();
  });

  it('[R283] à la fin du mandat, la tâche « récupérer le panneau » est créée toute seule, une seule fois, avec l’adresse dans la tournée', async () => {
    const t = await setup();
    await t.panneaux.addToStock(t.direction, 'moyen', 2);
    const r = await t.panneaux.place(t.agentSam, { signNumber: 1, propertyId: t.property.id, address: ADDRESS });
    if (!r.ok) throw new Error(r.code);
    // Mandat en cours : rien à récupérer.
    expect(await t.panneaux.run()).toBe(0);
    expect(await t.panneaux.pickups(t.agentSam)).toEqual({ ok: true, stops: [] });
    // Le mandat arrive à son terme : le passage du lendemain range la tâche.
    t.setClock(MONDAY_9H + 30 * DAY);
    t.decisions.set(t.property.id, { allowed: false, reason: 'expired', mandateId: 'm1', withdrawalLastDay: null });
    expect(await t.panneaux.run()).toBe(1);
    // Rejoué, et par la tâche du planificateur : jamais deux fois.
    expect(await t.panneaux.run()).toBe(0);
    await signPickupsJob(t.db, t.acces, t.gate, t.journal, { now: () => new Date(MONDAY_9H + 30 * DAY) }).run({} as never);
    expect(await t.db.first<{ n: number }>('SELECT COUNT(*) AS n FROM sign_pickup_tasks')).toEqual({ n: 1 });
    const stops = await t.panneaux.pickups(t.agentSam);
    expect(stops).toEqual({
      ok: true,
      stops: [{ kind: 'panneau', placementId: r.placementId, signNumber: 1, propertyId: t.property.id, reference: 'B1', reason: 'fin_mandat', text: 'Mandat terminé : récupérer le panneau.', dueDay: '2027-01-06', address: ADDRESS }],
    });
    expect((await t.db.first<{ detail: string; agent_id: string }>('SELECT detail, agent_id FROM sign_pickup_tasks'))).toEqual({ detail: 'expired', agent_id: t.sam.id });
    // Récupéré : la tâche est faite, l'arrêt sort de la tournée, le panneau revient au stock.
    expect(await t.panneaux.remove(t.agentSam, r.placementId, 'recupere')).toEqual({ ok: true });
    expect(await t.panneaux.pickups(t.agentSam)).toEqual({ ok: true, stops: [] });
    const s = await t.panneaux.stock(t.direction);
    expect(s).toMatchObject({ ok: true, counts: { total: 2, enStock: 2, poses: 0, aRecuperer: 0, perdus: 0 } });
    await expect(t.db.run('DELETE FROM sign_pickup_tasks')).rejects.toThrow();
  });

  it('[R283] un mandat rétracté ou un bien vendu rangent aussi la tâche', async () => {
    const t = await setup();
    await t.panneaux.addToStock(t.direction, 'grand', 3);
    const a = await t.panneaux.place(t.agentSam, { signNumber: 1, propertyId: t.property.id, address: ADDRESS });
    const b = await t.panneaux.place(t.agentAlex, { signNumber: 2, propertyId: t.other.id, address: { streetNumber: '3', street: 'Rue du Test', postcode: '21000', city: 'Dijon' } });
    if (!a.ok || !b.ok) throw new Error('pose');
    await t.db.run("UPDATE properties SET status = 'sold' WHERE id = ?", [t.property.id]);
    t.decisions.set(t.other.id, { allowed: false, reason: 'withdrawn', mandateId: 'm2', withdrawalLastDay: null });
    expect(await t.panneaux.run()).toBe(2);
    const reasons = await t.db.all<{ placement_id: string; reason: string; detail: string | null }>('SELECT placement_id, reason, detail FROM sign_pickup_tasks ORDER BY reason');
    expect(reasons).toEqual([
      { placement_id: b.placementId, reason: 'fin_mandat', detail: 'withdrawn' },
      { placement_id: a.placementId, reason: 'vendu', detail: null },
    ]);
    const samStops = await t.panneaux.pickups(t.agentSam);
    expect(samStops.ok && samStops.stops.map((x) => x.text)).toEqual(['Bien vendu : récupérer le panneau.']);
    // Le mandat rétracté, plus aucun panneau ne se pose sur ce bien.
    const c = await t.panneaux.place(t.agentAlex, { signNumber: 3, propertyId: t.other.id, address: { streetNumber: '5', street: 'Rue du Test', postcode: '21000', city: 'Dijon' } });
    expect(c).toEqual({ ok: false, rule: 'R42', code: 'withdrawn' });
  });

  it('[R283] une panne sur une pose n’empêche pas la tâche des autres, et remonte au planificateur', async () => {
    const t = await setup();
    await t.panneaux.addToStock(t.direction, 'grand', 2);
    const a = await t.panneaux.place(t.agentSam, { signNumber: 1, propertyId: t.property.id, address: ADDRESS });
    const b = await t.panneaux.place(t.agentAlex, { signNumber: 2, propertyId: t.other.id, address: { streetNumber: '3', street: 'Rue du Test', postcode: '21000', city: 'Dijon' } });
    if (!a.ok || !b.ok) throw new Error('pose');
    const broken = {
      canDiffuse: async (_n: string, propertyId: string): Promise<DiffusionDecision> => {
        if (propertyId === t.property.id) throw new Error('panne');
        return { allowed: false, reason: 'cancelled', mandateId: 'm2', withdrawalLastDay: null };
      },
    };
    const p = new Panneaux(t.db, t.acces, broken, t.journal, { now: () => new Date(MONDAY_9H) });
    await expect(p.run()).rejects.toThrow('panne');
    expect(await t.db.all<{ placement_id: string }>('SELECT placement_id FROM sign_pickup_tasks')).toEqual([{ placement_id: b.placementId }]);
  });

  it('[R284] la direction voit tout le stock ; l’agent voit les comptes et ses seules poses, avec leur adresse', async () => {
    const t = await setup();
    await t.panneaux.addToStock(t.direction, 'grand', 3);
    await t.panneaux.addToStock(t.direction, 'petit', 2);
    const a = await t.panneaux.place(t.agentSam, { signNumber: 1, propertyId: t.property.id, address: ADDRESS });
    const b = await t.panneaux.place(t.agentAlex, { signNumber: 4, propertyId: t.other.id, address: { streetNumber: '3', street: 'Rue du Test', postcode: '21000', city: 'Dijon' } });
    const c = await t.panneaux.place(t.agentAlex, { signNumber: 5, propertyId: t.other.id, address: { streetNumber: '5', street: 'Rue du Test', postcode: '21000', city: 'Dijon' } });
    if (!a.ok || !b.ok || !c.ok) throw new Error('pose');
    await t.panneaux.remove(t.agentAlex, c.placementId, 'perdu');
    t.decisions.set(t.property.id, { allowed: false, reason: 'expired', mandateId: 'm1', withdrawalLastDay: null });
    await t.panneaux.run();
    const counts = { total: 5, enStock: 2, poses: 2, aRecuperer: 1, perdus: 1, bySize: { grand: { enStock: 2, poses: 1 }, moyen: { enStock: 0, poses: 0 }, petit: { enStock: 0, poses: 1 } } };
    const all = await t.panneaux.stock(t.direction);
    expect(all).toMatchObject({ ok: true, counts });
    if (!all.ok) return;
    expect(all.placed.map((p) => [p.signNumber, p.reference, p.pickup?.reason ?? null])).toEqual([
      [1, 'B1', 'fin_mandat'],
      [4, 'B2', null],
    ]);
    const sam = await t.panneaux.stock(t.agentSam);
    expect(sam).toMatchObject({ ok: true, counts });
    if (!sam.ok) return;
    expect(sam.placed).toHaveLength(1);
    expect(sam.placed[0]).toMatchObject({ signNumber: 1, address: ADDRESS, agentId: t.sam.id });
    const alex = await t.panneaux.stock(t.agentAlex);
    if (!alex.ok) throw new Error('alex');
    expect(alex.placed.map((p) => p.signNumber)).toEqual([4]);
    // Ni la conformité, ni un agent parti, ni un agent d'un autre réseau ne voient rien.
    expect(await t.panneaux.stock(t.as('compliance', 'c1'))).toMatchObject({ ok: false, rule: 'R16' });
    expect(await t.panneaux.pickups({ role: 'agent', userId: t.sam.id, networkId: 'autre' })).toMatchObject({ ok: false, rule: 'R16' });
    // La direction voit les arrêts de tout le réseau.
    const stops = await t.panneaux.pickups(t.direction);
    expect(stops.ok && stops.stops.map((s) => s.signNumber)).toEqual([1]);
    expect(await t.panneaux.pickups(t.agentAlex)).toEqual({ ok: true, stops: [] });
  });

  it('[R13] [R282] au journal : identifiants, numéros et raisons, jamais l’adresse ; la chaîne tient', async () => {
    const t = await setup();
    await t.panneaux.addToStock(t.direction, 'grand');
    const r = await t.panneaux.place(t.agentSam, { signNumber: 1, propertyId: t.property.id, address: ADDRESS });
    if (!r.ok) throw new Error(r.code);
    t.decisions.set(t.property.id, { allowed: false, reason: 'cancelled', mandateId: 'm1', withdrawalLastDay: null });
    await t.panneaux.run();
    await t.panneaux.remove(t.agentSam, r.placementId, 'recupere');
    const events = await t.db.all<{ type: string; data: string }>("SELECT type, data FROM journal WHERE type LIKE 'panneau.%' ORDER BY rowid");
    expect(events.map((e) => e.type)).toEqual(['panneau.ajoute', 'panneau.pose', 'panneau.a_recuperer', 'panneau.retire']);
    const text = JSON.stringify(await t.db.all('SELECT actor, subject, data FROM journal'));
    for (const word of ['Essais', '12 bis', 'Talant']) expect(text).not.toContain(word);
    expect((await verifyChain(await t.journal.all())).ok).toBe(true);
  });
});
