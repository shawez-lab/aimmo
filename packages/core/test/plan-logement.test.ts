import { expect, it } from 'vitest';
import { Acces, FicheClient, FicheUnique, SqlJournalStore, applyMigrations, fromSyncSqlite, type SqlDatabase } from '../src/index.ts';
import { PLAN_MENTION, PlanLogement, checkRooms, describeRooms, drawPlan, formatM2, type PlanRoom, type RoomKind } from '../src/studio/index.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

/** Des pièces posées côte à côte, de gauche à droite : elles se touchent par un mur, sans se recouvrir. */
function row(rooms: [RoomKind, number, number][]): PlanRoom[] {
  let x = 0;
  return rooms.map(([kind, widthCm, depthCm]) => {
    const r = { kind, xCm: x, yCm: 0, widthCm, depthCm };
    x += widthCm;
    return r;
  });
}

/** Cinq plans tests, chacun avec ses surfaces calculées à la main. */
const PLANS: { name: string; rooms: PlanRoom[]; areas: number[]; inside: number; annex: number; insideText: string; annexText: string; labels: string[] }[] = [
  {
    name: 'studio',
    rooms: row([['sejour', 520, 410], ['salle_d_eau', 180, 210], ['entree', 150, 120]]),
    areas: [213_200, 37_800, 18_000],
    inside: 269_000,
    annex: 0,
    insideText: '26,90 m²',
    annexText: '0,00 m²',
    labels: ['Séjour', 'Salle d’eau', 'Entrée'],
  },
  {
    name: 'deux pièces avec balcon',
    rooms: row([['sejour', 437, 523], ['cuisine', 251, 287], ['chambre', 312, 341], ['salle_de_bains', 198, 223], ['wc', 92, 143], ['balcon', 400, 150]]),
    areas: [228_551, 72_037, 106_392, 44_154, 13_156, 60_000],
    inside: 464_290,
    annex: 60_000,
    insideText: '46,43 m²',
    annexText: '6,00 m²',
    labels: ['Séjour', 'Cuisine', 'Chambre', 'Salle de bains', 'WC', 'Balcon'],
  },
  {
    name: 'trois pièces, deux chambres numérotées',
    rooms: row([['chambre', 300, 300], ['chambre', 280, 315], ['sejour', 600, 450], ['cuisine', 300, 250], ['degagement', 400, 100], ['salle_d_eau', 200, 200]]),
    areas: [90_000, 88_200, 270_000, 75_000, 40_000, 40_000],
    inside: 603_200,
    annex: 0,
    insideText: '60,32 m²',
    annexText: '0,00 m²',
    labels: ['Chambre 1', 'Chambre 2', 'Séjour', 'Cuisine', 'Dégagement', 'Salle d’eau'],
  },
  {
    name: 'maison avec garage et terrasse',
    rooms: row([['sejour', 735, 512], ['cuisine', 345, 298], ['garage', 600, 300], ['terrasse', 500, 400]]),
    areas: [376_320, 102_810, 180_000, 200_000],
    inside: 479_130,
    annex: 380_000,
    insideText: '47,91 m²',
    annexText: '38,00 m²',
    labels: ['Séjour', 'Cuisine', 'Garage', 'Terrasse'],
  },
  {
    name: 'cotes impaires',
    rooms: row([['bureau', 293, 187], ['wc', 87, 111], ['cellier', 133, 97]]),
    areas: [54_791, 9_657, 12_901],
    inside: 77_349,
    annex: 0,
    insideText: '7,73 m²',
    annexText: '0,00 m²',
    labels: ['Bureau', 'WC', 'Cellier'],
  },
];

it('[R135] sur 5 plans tests, les surfaces sont celles du calcul fait à la main, au cm² près', () => {
  for (const p of PLANS) {
    const checked = checkRooms(p.rooms);
    expect(checked.ok, p.name).toBe(true);
    const rooms = describeRooms(p.rooms);
    expect(rooms.map((r) => r.areaCm2), p.name).toEqual(p.areas);
    expect(rooms.map((r) => r.label), p.name).toEqual(p.labels);
    expect(rooms.filter((r) => r.inside).reduce((s, r) => s + r.areaCm2, 0), p.name).toBe(p.inside);
    expect(rooms.filter((r) => !r.inside).reduce((s, r) => s + r.areaCm2, 0), p.name).toBe(p.annex);
    expect(formatM2(p.inside), p.name).toBe(p.insideText);
    expect(formatM2(p.annex), p.name).toBe(p.annexText);
  }
  expect(formatM2(1_234_567)).toBe('123,46 m²');
  expect(formatM2(12_345_678)).toBe('1 234,57 m²');
  expect(formatM2(50)).toBe('0,01 m²');
});

it('[R10] une cote absente ou impossible, une sorte inconnue, deux pièces qui se recouvrent : refusé', () => {
  const ok = { kind: 'sejour', xCm: 0, yCm: 0, widthCm: 400, depthCm: 300 };
  expect(checkRooms([{ ...ok, widthCm: undefined }])).toMatchObject({ ok: false, code: 'cote_absente', index: 0 });
  expect(checkRooms([{ ...ok, depthCm: null }])).toMatchObject({ ok: false, code: 'cote_absente' });
  expect(checkRooms([{ kind: 'sejour', xCm: 0, yCm: 0, widthCm: 400 }])).toMatchObject({ ok: false, code: 'cote_absente' });
  for (const bad of [{ widthCm: -400 }, { widthCm: 0 }, { widthCm: 20 }, { widthCm: 400.5 }, { depthCm: 3001 }, { widthCm: '400' }, { xCm: -1 }, { yCm: Number.NaN }, { xCm: 10_001 }]) {
    expect(checkRooms([{ ...ok, ...bad }]), JSON.stringify(bad)).toMatchObject({ ok: false, code: 'cote_impossible' });
  }
  // Ni texte libre, donc ni adresse ni nom possibles dans le plan.
  expect(checkRooms([{ ...ok, kind: 'chambre de Mme Exemple' }])).toMatchObject({ ok: false, code: 'sorte_inconnue' });
  expect(checkRooms([{ ...ok, kind: 'toString' }])).toMatchObject({ ok: false, code: 'sorte_inconnue' });
  expect(checkRooms([{ ...ok, label: '12 rue Imaginaire' }])).toMatchObject({ ok: false, code: 'pieces_invalides' });
  expect(checkRooms([])).toMatchObject({ ok: false, code: 'pieces_invalides' });
  expect(checkRooms('séjour')).toMatchObject({ ok: false, code: 'pieces_invalides' });
  // Recouvrement refusé ; deux pièces qui se touchent par un mur admises.
  expect(checkRooms([ok, { ...ok, kind: 'cuisine', xCm: 399 }])).toMatchObject({ ok: false, code: 'chevauchement', index: 1 });
  expect(checkRooms([ok, { ...ok, kind: 'cuisine', xCm: 100, yCm: 100, widthCm: 100, depthCm: 100 }])).toMatchObject({ ok: false, code: 'chevauchement' });
  expect(checkRooms([ok, { ...ok, kind: 'cuisine', xCm: 400 }])).toMatchObject({ ok: true });
  expect(checkRooms([ok, { ...ok, kind: 'cuisine', yCm: 300 }])).toMatchObject({ ok: true });
});

it('[R135] [R46] le plan dessiné porte toujours la mention, ses surfaces calculées, et ni adresse ni nom', () => {
  for (const p of PLANS) {
    const rooms = describeRooms(p.rooms);
    const svg = drawPlan(rooms, { inside: p.insideText, annex: p.annexText, annexCm2: p.annex });
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"'), p.name).toBe(true);
    expect(svg, p.name).toContain(`<title id="plan-titre">${PLAN_MENTION}</title>`);
    expect(svg.match(/Plan indicatif, non contractuel/g)!.length, p.name).toBeGreaterThanOrEqual(2);
    expect(svg, p.name).toMatch(new RegExp(`>Surface des pièces</text><text [^>]*>${p.insideText}</text>`));
    for (const r of rooms) expect(svg, `${p.name} ${r.label}`).toContain(`>${r.area}</text>`);
    expect(svg, p.name).toContain('role="img"');
    expect(svg, p.name).not.toMatch(/rue|avenue|boulevard|place |\d{5}/i);
  }
  expect(PLAN_MENTION).toBe('Plan indicatif, non contractuel');
});

async function setup() {
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  let clock = Date.parse('2027-10-07T08:00:00.000Z');
  const now = (): Date => new Date((clock += 1000));
  const journal = new SqlJournalStore(db);
  const store = new FicheClient(db, { now });
  const acces = new Acces(db, store, new FicheUnique(db, store, { now }), journal, { now });
  const plans = new PlanLogement(db, acces, journal, { now });
  const network = await store.createNetwork('Réseau test');
  const alex = await store.createAgent({ networkId: network.id, firstName: 'Alexandrine', lastName: 'Fictive' });
  const sam = await store.createAgent({ networkId: network.id, firstName: 'Samuel', lastName: 'Inventé' });
  const p = await store.createProperty({ networkId: network.id, agentId: alex.id, reference: 'PLAN-12', kind: 'home', city: 'Villebrune', priceEur: 180_000, surfaceM2: 70, rooms: 2, status: 'available' });
  const as = (role: 'agent' | 'direction' | 'compliance' | 'assistant', userId: string) => ({ role, userId, networkId: network.id }) as never;
  return { db, plans, network, alex, sam, p, as };
}

describeWithSqlite('X04 · plan simple du logement', () => {
  it('[R135] une saisie rangée donne le plan, ses surfaces, sa mention, et l’écart avec la fiche ; chaque saisie est une version', async () => {
    const t = await setup();
    const alex = t.as('agent', t.alex.id);
    expect(await t.plans.current(alex, t.p.id)).toEqual({ ok: true, value: null });
    const first = await t.plans.save(alex, t.p.id, { rooms: PLANS[0]!.rooms });
    if (!first.ok) throw new Error(first.code);
    expect(first.value).toMatchObject({ version: 1, insideCm2: 269_000, inside: '26,90 m²', mention: 'Plan indicatif, non contractuel' });
    // 26,90 m² saisis contre 70 m² dans la fiche : −61,6 %, signalé.
    expect(first.value.gapWithSheet).toEqual({ sheetM2: 70, percent: -61.6, warn: true });
    const second = await t.plans.save(alex, t.p.id, { rooms: row([['sejour', 700, 500], ['chambre', 500, 400], ['salle_d_eau', 100, 150]]) });
    if (!second.ok) throw new Error(second.code);
    // 350 000 + 200 000 + 15 000 = 565 000 cm² : 56,50 m², −19,3 % de 70 m².
    expect(second.value).toMatchObject({ version: 2, insideCm2: 565_000, inside: '56,50 m²', gapWithSheet: { percent: -19.3, warn: true } });
    const close = await t.plans.save(alex, t.p.id, { rooms: row([['sejour', 700, 600], ['chambre', 500, 500]]) });
    // 420 000 + 250 000 = 670 000 cm² : −4,3 %, dans la marge.
    expect(close).toMatchObject({ ok: true, value: { version: 3, gapWithSheet: { percent: -4.3, warn: false } } });
    const cur = await t.plans.current(t.as('direction', 'd1'), t.p.id);
    expect(cur).toMatchObject({ ok: true, value: { version: 3, insideCm2: 670_000 } });
    expect(await t.db.all('SELECT version FROM floor_plans ORDER BY version')).toEqual([{ version: 1 }, { version: 2 }, { version: 3 }]);
    await expect(t.db.run('DELETE FROM floor_plans')).rejects.toThrow(/rien ne s'efface/);
    await expect(t.db.run('UPDATE floor_plans SET rooms = ?', ['{}'])).rejects.toThrow(/ne change plus/);
    // Le plan ne porte ni la ville, ni la référence, ni le nom de l'agent.
    const svg = (cur.ok && cur.value?.svg) || '';
    for (const s of ['Villebrune', 'PLAN-12', 'Alexandrine', 'Fictive', t.p.id]) expect(svg, s).not.toContain(s);
  });

  it('[R10] une saisie refusée n’est pas rangée, et le refus va au journal sans rien d’autre', async () => {
    const t = await setup();
    const res = await t.plans.save(t.as('agent', t.alex.id), t.p.id, { rooms: [{ kind: 'sejour', xCm: 0, yCm: 0, widthCm: 400 }] });
    expect(res).toEqual({ ok: false, rule: 'R10', code: 'cote_absente', index: 0 });
    expect(await t.plans.save(t.as('agent', t.alex.id), t.p.id, {} as never)).toMatchObject({ ok: false, code: 'pieces_invalides' });
    expect(await t.db.all('SELECT id FROM floor_plans')).toEqual([]);
    const ev = await t.db.all<{ data: string }>("SELECT data FROM journal WHERE type = 'studio.plan.refuse'");
    expect(ev.map((e) => JSON.parse(e.data))).toEqual([
      { rule: 'R10', code: 'cote_absente' },
      { rule: 'R10', code: 'pieces_invalides' },
    ]);
  });

  it('[R16] seuls l’agent du bien et la direction saisissent ; un autre agent ne lit pas le plan', async () => {
    const t = await setup();
    await t.plans.save(t.as('agent', t.alex.id), t.p.id, { rooms: PLANS[1]!.rooms });
    expect(await t.plans.save(t.as('agent', t.sam.id), t.p.id, { rooms: PLANS[1]!.rooms })).toMatchObject({ ok: false, rule: 'R16' });
    expect(await t.plans.current(t.as('agent', t.sam.id), t.p.id)).toMatchObject({ ok: false, rule: 'R16' });
    expect(await t.plans.save(t.as('compliance', 'c1'), t.p.id, { rooms: PLANS[1]!.rooms })).toEqual({ ok: false, rule: 'R16', code: 'role' });
    expect(await t.plans.save(t.as('direction', 'd1'), t.p.id, { rooms: PLANS[1]!.rooms })).toMatchObject({ ok: true, value: { version: 2 } });
    expect(await t.db.all('SELECT id FROM floor_plans')).toHaveLength(2);
  });
});
