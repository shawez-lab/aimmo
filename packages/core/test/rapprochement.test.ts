import { expect, it } from 'vitest';
import {
  Acces,
  FicheAcquereur,
  FicheClient,
  FicheUnique,
  Rapprochement,
  SqlJournalStore,
  applyMigrations,
  fromSyncSqlite,
  checkSearchChanges,
  matchBuyer,
  verifyChain,
  type BuyerSearch,
  type DiffusionGate,
  type PropertyKind,
  type SqlDatabase,
} from '../src/index.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

const START = Date.parse('2026-12-08T09:00:00.000Z');
const COMMUNES = ['Dijon', 'Talant', 'Chenôve', 'Quetigny', 'Longvic'];

/** Un tirage pseudo-aléatoire reproductible, pour un fichier inventé. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/** Le contrôle indépendant du test : le bien remplit-il strictement tous les critères obligatoires de la recherche ? */
function respectsAll(p: { kind: PropertyKind; city: string; price: number; surface: number; rooms: number }, s: BuyerSearch): boolean {
  if (s.propertyKinds.length > 0) {
    const ok = p.kind === 'home' ? s.propertyKinds.some((k) => k === 'house' || k === 'apartment') : s.propertyKinds.includes(p.kind === 'land' ? 'land' : 'building');
    if (!ok) return false;
  }
  if (s.communes.length > 0 && !s.communes.includes(p.city)) return false;
  if (s.budgetMaxEur !== null && p.price > s.budgetMaxEur) return false;
  if (s.surfaceMinM2 !== null && p.surface < s.surfaceMinM2) return false;
  if (s.roomsMin !== null && p.rooms < s.roomsMin) return false;
  if (s.bedroomsMin !== null) return false;
  return true;
}

async function setup(gate?: DiffusionGate) {
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  let clock = START;
  const now = (): Date => new Date((clock += 1000));
  const journal = new SqlJournalStore(db);
  const store = new FicheClient(db, { now });
  const fiche = new FicheUnique(db, store, { now });
  const acces = new Acces(db, store, fiche, journal, { now });
  const acquereurs = new FicheAcquereur(db, journal, { now });
  const blocked = new Set<string>();
  const diffusion: DiffusionGate = gate ?? {
    canDiffuse: async (_n, propertyId) => (blocked.has(propertyId) ? { allowed: false, reason: 'withdrawal_period' } : { allowed: true, reason: 'allowed' }),
  };
  const rapprochement = new Rapprochement(db, fiche, diffusion, journal, { now });
  const network = await store.createNetwork('Réseau test');
  const alex = await store.createAgent({ networkId: network.id, firstName: 'Alex', lastName: 'Agent' });
  const sam = await store.createAgent({ networkId: network.id, firstName: 'Sam', lastName: 'Agent' });
  const direction = { role: 'direction' as const, userId: 'd1', networkId: network.id };
  /** Un acquéreur inventé, suivi par un agent, avec sa recherche. */
  const buyer = async (agentId: string, firstName: string, search: Partial<BuyerSearch>) => {
    const person = await store.createPerson({ networkId: network.id, agentId, firstName });
    const project = await store.createProject({ networkId: network.id, agentId, personId: person.id, kind: 'buy' });
    const r = await acquereurs.update(acces, direction, project.id, search);
    if (!r.ok) throw new Error(`recherche refusée : ${r.code}`);
    return { person, project };
  };
  const property = (agentId: string, ref: string, p: { kind?: PropertyKind; city: string; price: number; surface: number; rooms: number }) =>
    store.createProperty({ networkId: network.id, agentId, reference: ref, kind: p.kind ?? 'home', city: p.city, priceEur: p.price, surfaceM2: p.surface, rooms: p.rooms, status: 'available' });
  const as = (role: 'agent' | 'direction' | 'compliance' | 'partner', userId: string) => ({ role, userId, networkId: network.id });
  return { db, store, fiche, journal, acces, acquereurs, rapprochement, network, alex, sam, direction, buyer, property, as, blocked, setClock: (t: number) => (clock = t) };
}

describeWithSqlite('T02 · rapprochement des acquéreurs', () => {
  it('sur 10 biens tests et un fichier inventé, au moins 8 des 10 premiers proposés respectent tous les critères obligatoires [R51]', async () => {
    const t = await setup();
    const rand = rng(42);
    const pick = <T,>(list: readonly T[]): T => list[Math.floor(rand() * list.length)]!;
    const searches = new Map<string, BuyerSearch>();
    for (let i = 0; i < 400; i += 1) {
      const search: BuyerSearch = {
        propertyKinds: rand() < 0.85 ? [pick(['house', 'apartment'] as const)] : [],
        communes: rand() < 0.9 ? [pick(COMMUNES), ...(rand() < 0.4 ? [pick(COMMUNES)] : [])].filter((c, k, a) => a.indexOf(c) === k) : [],
        features: rand() < 0.3 ? [pick(['garden', 'balcony', 'parking'] as const)] : [],
        surfaceMinM2: rand() < 0.8 ? 40 + Math.floor(rand() * 80) : null,
        roomsMin: rand() < 0.6 ? 2 + Math.floor(rand() * 3) : null,
        bedroomsMin: null,
        budgetMaxEur: rand() < 0.9 ? 150_000 + Math.floor(rand() * 30) * 10_000 : null,
        financing: pick(['cash', 'loan_needed', null] as const),
        urgency: pick(['now', 'within_3_months', 'later', null] as const),
      };
      const { project } = await t.buyer(i % 2 === 0 ? t.alex.id : t.sam.id, `Acheteur${i}`, search);
      searches.set(project.id, search);
    }
    let checked = 0;
    for (let b = 0; b < 10; b += 1) {
      const p = { city: COMMUNES[b % COMMUNES.length]!, price: 160_000 + b * 25_000, surface: 50 + b * 9, rooms: 2 + (b % 4) };
      const prop = await t.property(t.alex.id, `B${b}`, p);
      const r = await t.rapprochement.propose(t.acces, t.direction, prop.id);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value.length).toBeGreaterThan(0);
      const top = r.value.slice(0, 10);
      // Le fichier inventé porte assez d'acquéreurs pour chaque bien : la mesure a du sens.
      expect([...searches.values()].filter((s) => respectsAll({ kind: 'home', ...p }, s)).length, `bien B${b}`).toBeGreaterThanOrEqual(10);
      expect(top).toHaveLength(10);
      const strict = top.filter((x) => respectsAll({ kind: 'home', ...p }, searches.get(x.projectId)!)).length;
      expect(strict, `bien B${b}`).toBeGreaterThanOrEqual(8);
      for (const x of top) expect(x.reasons.length).toBeGreaterThan(0);
      checked += 1;
    }
    expect(checked).toBe(10);
  });

  it('chaque proposition porte ses raisons ; ceux qui remplissent tout passent avant ceux dans la tolérance', async () => {
    const t = await setup();
    const tol = await t.buyer(t.alex.id, 'Tolérée', { propertyKinds: ['house'], communes: ['Talant'], budgetMaxEur: 290_000 });
    const ok = await t.buyer(t.alex.id, 'Remplie', { propertyKinds: ['house'], communes: ['Talant'], budgetMaxEur: 320_000, surfaceMinM2: 80 });
    await t.buyer(t.alex.id, 'Écartée', { communes: ['Dijon'] });
    const prop = await t.property(t.alex.id, 'B1', { city: 'Talant', price: 300_000, surface: 95, rooms: 4 });
    const r = await t.rapprochement.propose(t.acces, t.as('agent', t.alex.id), prop.id);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.map((x) => x.projectId)).toEqual([ok.project.id, tol.project.id]);
    expect(r.value[0]).toMatchObject({ rank: 1, status: 'match', firstName: 'Remplie' });
    expect(r.value[0]!.reasons).toEqual(['Type cherché : maison.', 'Commune cherchée : Talant.', 'Prix 300 000 € dans le budget de 320 000 €.', 'Surface 95 m² pour 80 m² au moins.']);
    expect(r.value[1]!.status).toBe('tolerated');
    expect(r.value[1]!.reasons).toContain('Prix 3,45 % au-dessus du budget, dans la tolérance de 5 %.');
  });

  it('AU071 · une recherche au seul équipement impératif compte : proposée pour un bien qui l’a, pas pour un autre', async () => {
    const t = await setup();
    const b = await t.buyer(t.alex.id, 'Ascenseur', { requiredFeatures: ['elevator'] });
    const lift = await t.property(t.alex.id, 'ASC', { city: 'Dijon', price: 150_000, surface: 50, rooms: 2 });
    const stairs = await t.property(t.alex.id, 'ESC', { city: 'Dijon', price: 150_000, surface: 50, rooms: 2 });
    await t.db.run('INSERT INTO property_sheets (id, property_id, network_id, version, data, created_by, created_at) VALUES (?, ?, ?, 1, ?, ?, ?)', [
      'sheet-asc', lift.id, t.network.id, JSON.stringify({ characteristics: { elevator: true }, media: [] }), 'direction:d1', '2026-01-01T00:00:00.000Z',
    ]);
    const proposed = async (id: string) => {
      const r = await t.rapprochement.propose(t.acces, t.direction, id);
      if (!r.ok) throw new Error('refus');
      return r.value.map((x) => x.projectId);
    };
    expect(await proposed(lift.id)).toEqual([b.project.id]);
    expect(await proposed(stairs.id)).toEqual([]);
  });

  it('AU072 · étage, classe énergie et terrain lus dans la fiche du bien ; impératifs, ils écartent, souhaits, ils n’écartent pas', async () => {
    const t = await setup();
    const strict = await t.buyer(t.alex.id, 'Étage', { communes: ['Dijon'], floorMin: 1, energyClassMax: 'D' });
    const soft = await t.buyer(t.alex.id, 'Souhait', { communes: ['Dijon'], floorMin: 1, energyClassMax: 'D', softCriteria: ['floorMin', 'energy'] });
    const sheet = (id: string, ref: string, data: object) =>
      t.db.run('INSERT INTO property_sheets (id, property_id, network_id, version, data, created_by, created_at) VALUES (?, ?, ?, 1, ?, ?, ?)', [`sheet-${ref}`, id, t.network.id, JSON.stringify(data), 'direction:d1', '2026-01-01T00:00:00.000Z']);
    const proposed = async (id: string) => {
      const r = await t.rapprochement.propose(t.acces, t.direction, id);
      if (!r.ok) throw new Error('refus');
      return r.value.map((x) => x.projectId).sort();
    };
    const up = await t.property(t.alex.id, 'HAUT', { city: 'Dijon', price: 150_000, surface: 50, rooms: 2 });
    await sheet(up.id, 'HAUT', { characteristics: { floor: 3 }, energy: { energyClass: 'C' }, media: [] });
    expect(await proposed(up.id)).toEqual([strict.project.id, soft.project.id].sort());
    const ground = await t.property(t.alex.id, 'RDC', { city: 'Dijon', price: 150_000, surface: 50, rooms: 2 });
    await sheet(ground.id, 'RDC', { characteristics: { floor: 0 }, energy: { energyClass: 'F' }, media: [] });
    expect(await proposed(ground.id)).toEqual([soft.project.id]);
    // Sans fiche, l'étage et la classe sont inconnus : un impératif n'est pas rempli.
    const bare = await t.property(t.alex.id, 'NU', { city: 'Dijon', price: 150_000, surface: 50, rooms: 2 });
    expect(await proposed(bare.id)).toEqual([soft.project.id]);
    // La recherche se refuse hors bornes ou hors liste.
    const check = (v: object) => checkSearchChanges(v);
    expect(check({ floorMin: 3, floorMax: 1 })).toMatchObject({ ok: false, field: 'floorMin' });
    expect(check({ energyClassMax: 'H' })).toMatchObject({ ok: false, field: 'energyClassMax' });
    expect(check({ softCriteria: ['budget'] })).toMatchObject({ ok: false, field: 'softCriteria' });
  });

  it('AU072 · un terrain seul se rapproche par sa surface enregistrée', async () => {
    const t = await setup();
    const want = await t.buyer(t.alex.id, 'Terrain', { propertyKinds: ['land'], communes: ['Dijon'], landMinM2: 500 });
    const proposed = async (id: string) => {
      const r = await t.rapprochement.propose(t.acces, t.direction, id);
      if (!r.ok) throw new Error('refus');
      return r.value.map((x) => x.projectId);
    };
    const big = await t.property(t.alex.id, 'T600', { kind: 'land', city: 'Dijon', price: 80_000, surface: 600, rooms: 0 });
    expect(await proposed(big.id)).toEqual([want.project.id]);
    const small = await t.property(t.alex.id, 'T300', { kind: 'land', city: 'Dijon', price: 80_000, surface: 300, rooms: 0 });
    expect(await proposed(small.id)).toEqual([]);
  });

  it('AU072 · un souhait d’étage, de classe ou de terrain rempli fait passer devant, à critères égaux', async () => {
    const t = await setup();
    const plain = await t.buyer(t.alex.id, 'Sans souhait', { communes: ['Dijon'], urgency: 'now' });
    const wish = await t.buyer(t.alex.id, 'Souhait', { communes: ['Dijon'], energyClassMax: 'C', softCriteria: ['energy'], urgency: 'later' });
    const p = await t.property(t.alex.id, 'CLASSE', { city: 'Dijon', price: 150_000, surface: 50, rooms: 2 });
    await t.db.run('INSERT INTO property_sheets (id, property_id, network_id, version, data, created_by, created_at) VALUES (?, ?, ?, 1, ?, ?, ?)', ['sheet-classe', p.id, t.network.id, JSON.stringify({ characteristics: {}, energy: { energyClass: 'B' }, media: [] }), 'direction:d1', '2026-01-01T00:00:00.000Z']);
    const r = await t.rapprochement.propose(t.acces, t.direction, p.id);
    if (!r.ok) throw new Error('refus');
    expect(r.value.map((x) => x.projectId)).toEqual([wish.project.id, plain.project.id]);
  });

  it('le classement ne tient jamais compte du financement [R14] ; à égalité, l’urgence déclarée puis la recherche la plus fraîche', async () => {
    const t = await setup();
    const base = { propertyKinds: ['apartment'], communes: ['Dijon'], budgetMaxEur: 200_000 } as const;
    const cash = await t.buyer(t.alex.id, 'Comptant', { ...base, propertyKinds: [...base.propertyKinds], communes: [...base.communes], financing: 'cash', urgency: 'later' });
    const loan = await t.buyer(t.alex.id, 'Prêt', { ...base, propertyKinds: [...base.propertyKinds], communes: [...base.communes], financing: 'loan_needed', urgency: 'now' });
    const prop = await t.property(t.alex.id, 'B1', { city: 'Dijon', price: 180_000, surface: 50, rooms: 2 });
    const r = await t.rapprochement.propose(t.acces, t.direction, prop.id);
    if (!r.ok) throw new Error('refus');
    expect(r.value.map((x) => x.projectId)).toEqual([loan.project.id, cash.project.id]);
    // Même recherche, seul le financement change : l'ordre ne bouge pas.
    for (const financing of ['cash', 'loan_approved', 'loan_in_progress', 'loan_needed', null] as const) {
      const s: BuyerSearch = { propertyKinds: ['apartment'], communes: ['Dijon'], features: [], surfaceMinM2: null, roomsMin: null, bedroomsMin: null, budgetMaxEur: 200_000, financing, urgency: 'now' };
      expect(matchBuyer({ kind: 'home', city: 'Dijon', priceEur: 180_000, surfaceM2: 50, rooms: 2, bedrooms: null, features: [] }, s)).toMatchObject({ status: 'match', gap: 0 });
    }
  });

  it('jamais une personne exclue ou qui a demandé l’arrêt [R02, R04] ; une exclusion levée la rend de nouveau proposable', async () => {
    const t = await setup();
    const search = { propertyKinds: ['house'] as ('house')[], communes: ['Talant'] };
    const stop = await t.buyer(t.alex.id, 'Arrêt', search);
    const listed = await t.buyer(t.alex.id, 'Liste', search);
    const keep = await t.buyer(t.alex.id, 'Gardé', search);
    await t.store.addExclusion({ networkId: t.network.id, personId: stop.person.id, reason: 'stop', notedAt: new Date(START) });
    const ex = await t.store.addExclusion({ networkId: t.network.id, personId: listed.person.id, reason: 'network_list', notedAt: new Date(START) });
    const prop = await t.property(t.alex.id, 'B1', { city: 'Talant', price: 250_000, surface: 90, rooms: 4 });
    const r1 = await t.rapprochement.propose(t.acces, t.direction, prop.id);
    if (!r1.ok) throw new Error('refus');
    expect(r1.value.map((x) => x.projectId)).toEqual([keep.project.id]);
    await t.store.liftExclusion(ex.id, new Date(START + 5000));
    const r2 = await t.rapprochement.propose(t.acces, t.direction, prop.id);
    if (!r2.ok) throw new Error('refus');
    expect(r2.value.map((x) => x.projectId).sort()).toEqual([keep.project.id, listed.project.id].sort());
  });

  it('fichier commun : le bien de Sam est proposé aux clients d’Alex, et chacun ne voit que ses clients [R16]', async () => {
    const t = await setup();
    const search = { propertyKinds: ['house'] as ('house')[], communes: ['Talant'] };
    const a = await t.buyer(t.alex.id, 'ClientAlex', search);
    const s = await t.buyer(t.sam.id, 'ClientSam', search);
    const prop = await t.property(t.sam.id, 'B1', { city: 'Talant', price: 250_000, surface: 90, rooms: 4 });
    const forAlex = await t.rapprochement.propose(t.acces, t.as('agent', t.alex.id), prop.id);
    const forSam = await t.rapprochement.propose(t.acces, t.as('agent', t.sam.id), prop.id);
    const forDirection = await t.rapprochement.propose(t.acces, t.direction, prop.id);
    if (!forAlex.ok || !forSam.ok || !forDirection.ok) throw new Error('refus');
    expect(forAlex.value.map((x) => x.projectId)).toEqual([a.project.id]);
    expect(forSam.value.map((x) => x.projectId)).toEqual([s.project.id]);
    expect(forDirection.value).toHaveLength(2);
    // Un partenaire, la conformité, un autre réseau : refusés, au journal.
    expect(await t.rapprochement.propose(t.acces, t.as('partner', 'p1'), prop.id)).toMatchObject({ ok: false, rule: 'R16' });
    expect(await t.rapprochement.propose(t.acces, t.as('compliance', 'c1'), prop.id)).toMatchObject({ ok: false, rule: 'R16' });
    expect(await t.rapprochement.propose(t.acces, { role: 'direction', userId: 'd1', networkId: 'autre' }, prop.id)).toMatchObject({ ok: false, rule: 'R16' });
    // Un bien retiré n'est plus au fichier commun : Alex ne peut plus le lire.
    await t.db.run("UPDATE properties SET status = 'withdrawn' WHERE id = ?", [prop.id]);
    expect(await t.rapprochement.propose(t.acces, t.as('agent', t.alex.id), prop.id)).toMatchObject({ ok: false, rule: 'R16' });
    const entries = await t.journal.all();
    expect(entries.filter((e) => e.type === 'acces.refuse').length).toBeGreaterThanOrEqual(4);
    expect((await verifyChain(entries)).ok).toBe(true);
  });

  it('une personne à deux projets d’achat ouverts est proposée pour son projet qui correspond, une seule fois', async () => {
    const t = await setup();
    const x = await t.buyer(t.alex.id, 'Deux', { propertyKinds: ['house'], communes: ['Talant'], budgetMaxEur: 300_000 });
    const y = await t.store.createProject({ networkId: t.network.id, agentId: t.alex.id, personId: x.person.id, kind: 'buy' });
    await t.acquereurs.update(t.acces, t.direction, y.id, { propertyKinds: ['apartment'], communes: ['Dijon'], budgetMaxEur: 150_000 });
    const prop = await t.property(t.alex.id, 'B1', { city: 'Talant', price: 280_000, surface: 90, rooms: 4 });
    const r = await t.rapprochement.propose(t.acces, t.direction, prop.id);
    if (!r.ok) throw new Error('refus');
    expect(r.value.map((v) => v.projectId)).toEqual([x.project.id]);
    const map = await t.rapprochement.demandMap(t.acces, t.direction, prop.id);
    expect(map).toEqual({ ok: true, value: { activeBuyers: 1, matching: 1, nearMisses: [] } });
  });

  it('une recherche sans critère sur le bien n’est jamais proposée sans raison [R51] ; une fiche du bien illisible va au journal', async () => {
    const t = await setup();
    await t.buyer(t.alex.id, 'Vide', { urgency: 'now', features: ['garden'] });
    const ok = await t.buyer(t.alex.id, 'Pleine', { communes: ['Talant'] });
    const prop = await t.property(t.alex.id, 'B1', { city: 'Talant', price: 250_000, surface: 90, rooms: 4 });
    await t.db.run("INSERT INTO property_sheets (id, property_id, network_id, version, data, created_by, created_at) VALUES ('s1', ?, ?, 1, '\"illisible\"', 'agent:x', ?)", [prop.id, t.network.id, new Date(START).toISOString()]);
    const r = await t.rapprochement.propose(t.acces, t.direction, prop.id);
    if (!r.ok) throw new Error('refus');
    expect(r.value.map((v) => v.projectId)).toEqual([ok.project.id]);
    for (const v of r.value) expect(v.reasons.length).toBeGreaterThan(0);
    expect(await t.rapprochement.demandMap(t.acces, t.direction, prop.id)).toMatchObject({ ok: true, value: { activeBuyers: 1, matching: 1 } });
    expect(matchBuyer({ kind: 'home', city: 'Talant', priceEur: 1, surfaceM2: 1, rooms: 1, bedrooms: null, features: [] }, { propertyKinds: [], communes: [], features: [], surfaceMinM2: null, roomsMin: null, bedroomsMin: null, budgetMaxEur: null, financing: 'cash', urgency: 'now' })).toMatchObject({ status: 'miss' });
    expect((await t.journal.all()).some((e) => e.type === 'rapprochement.fiche_illisible')).toBe(true);
  });

  it('la limite de tolérance se compare sans arrondi', () => {
    const s: BuyerSearch = { propertyKinds: [], communes: [], features: [], surfaceMinM2: 79, roomsMin: null, bedroomsMin: null, budgetMaxEur: 200_000, financing: null, urgency: null };
    expect(matchBuyer({ kind: 'home', city: null, priceEur: 210_000, surfaceM2: 71.1, rooms: null, bedrooms: null, features: [] }, s)).toMatchObject({ status: 'tolerated', unmet: [] });
    expect(matchBuyer({ kind: 'home', city: null, priceEur: 210_001, surfaceM2: 71.1, rooms: null, bedrooms: null, features: [] }, s)).toMatchObject({ status: 'miss', unmet: ['budget'] });
    expect(matchBuyer({ kind: 'home', city: null, priceEur: 200_000, surfaceM2: 71.09, rooms: null, bedrooms: null, features: [] }, s)).toMatchObject({ status: 'miss', unmet: ['surface'] });
  });

  it('aucun acquéreur proposé pour un bien que la diffusion refuse [R42]', async () => {
    const t = await setup();
    await t.buyer(t.alex.id, 'Inès', { propertyKinds: ['house'], communes: ['Talant'] });
    const prop = await t.property(t.alex.id, 'B1', { city: 'Talant', price: 250_000, surface: 90, rooms: 4 });
    t.blocked.add(prop.id);
    expect(await t.rapprochement.propose(t.acces, t.as('agent', t.alex.id), prop.id)).toEqual({ ok: false, rule: 'R42', code: 'withdrawal_period' });
    expect((await t.journal.all()).some((e) => e.type === 'rapprochement.refuse')).toBe(true);
  });

  it('un projet clos, ou une recherche sans nouvelle depuis plus de 180 jours, ne compte plus ; une fiche réunie ne compte qu’une fois', async () => {
    const t = await setup();
    const search = { propertyKinds: ['house'] as ('house')[], communes: ['Talant'] };
    const closed = await t.buyer(t.alex.id, 'Close', search);
    await t.db.run("UPDATE projects SET stage = 'lost' WHERE id = ?", [closed.project.id]);
    const a = await t.buyer(t.alex.id, 'Double', search);
    const b = await t.buyer(t.alex.id, 'Double', search);
    // Les deux fiches de la même personne sont réunies : une seule ligne.
    await t.fiche.merge({ survivorId: a.person.id, mergedId: b.person.id, reason: 'même personne' });
    const prop = await t.property(t.alex.id, 'B1', { city: 'Talant', price: 250_000, surface: 90, rooms: 4 });
    const r = await t.rapprochement.propose(t.acces, t.direction, prop.id);
    if (!r.ok) throw new Error('refus');
    expect(r.value.map((x) => x.projectId)).not.toContain(closed.project.id);
    expect(r.value).toHaveLength(1);
    expect(r.value[0]!.personId).toBe(a.person.id);
    t.setClock(START + 181 * 86_400_000);
    const later = await t.rapprochement.propose(t.acces, t.direction, prop.id);
    if (!later.ok) throw new Error('refus');
    expect(later.value).toEqual([]);
  });

  it('AU074 · une recherche dite toujours d’actualité reste active sans changer un critère ; 180 jours après la confirmation, plus', async () => {
    const t = await setup();
    const search = { propertyKinds: ['house'] as ('house')[], communes: ['Talant'] };
    const a = await t.buyer(t.alex.id, 'Fidèle', search);
    const prop = await t.property(t.alex.id, 'B1', { city: 'Talant', price: 250_000, surface: 90, rooms: 4 });
    t.setClock(START + 170 * 86_400_000);
    expect(await t.acquereurs.confirm(t.acces, t.as('agent', t.alex.id), a.project.id)).toMatchObject({ ok: true });
    // La conformité ne confirme rien ; un agent sans droit sur la fiche non plus.
    expect(await t.acquereurs.confirm(t.acces, t.as('compliance', 'c1'), a.project.id)).toMatchObject({ ok: false });
    t.setClock(START + 181 * 86_400_000);
    const kept = await t.rapprochement.propose(t.acces, t.direction, prop.id);
    expect(kept.ok && kept.value.map((x) => x.projectId)).toEqual([a.project.id]);
    expect(await t.db.all('SELECT version FROM buyer_searches WHERE project_id = ?', [a.project.id])).toHaveLength(1);
    t.setClock(START + 351 * 86_400_000);
    const gone = await t.rapprochement.propose(t.acces, t.direction, prop.id);
    expect(gone.ok && gone.value).toEqual([]);
  });

  it('carte de la demande : comptes justes sur un jeu inventé, critère seul qui écarte le plus, sans aucun nom', async () => {
    const t = await setup();
    // 3 remplissent, 4 écartés seulement par la surface, 2 seulement par la commune, 1 par deux critères.
    for (let i = 0; i < 3; i += 1) await t.buyer(t.alex.id, `Oui${i}`, { propertyKinds: ['house'], communes: ['Talant'], surfaceMinM2: 80 });
    for (let i = 0; i < 4; i += 1) await t.buyer(t.sam.id, `Surface${i}`, { propertyKinds: ['house'], communes: ['Talant'], surfaceMinM2: 150 });
    for (let i = 0; i < 2; i += 1) await t.buyer(t.alex.id, `Commune${i}`, { propertyKinds: ['house'], communes: ['Dijon'] });
    await t.buyer(t.sam.id, 'Deux', { communes: ['Dijon'], budgetMaxEur: 100_000 });
    const prop = await t.property(t.alex.id, 'B1', { city: 'Talant', price: 250_000, surface: 90, rooms: 4 });
    const map = await t.rapprochement.demandMap(t.acces, t.as('agent', t.alex.id), prop.id);
    expect(map).toEqual({
      ok: true,
      value: { activeBuyers: 10, matching: 3, nearMisses: [{ criterion: 'surface', count: 4 }, { criterion: 'commune', count: 2 }] },
    });
    // Un autre agent voit la carte d'un bien du fichier commun, sans aucun nom ni identifiant.
    const forSam = await t.rapprochement.demandMap(t.acces, t.as('agent', t.sam.id), prop.id);
    expect(forSam).toEqual(map);
    const text = JSON.stringify(forSam);
    expect(text).not.toMatch(/Oui|Surface\d|Commune\d|Deux|person/);
    const logged = (await t.journal.all()).filter((e) => e.type === 'demande.lue');
    expect(JSON.stringify(logged)).not.toMatch(/Oui|Surface\d|person:/);
  });

  it('une valeur du bien inconnue ne remplit pas le critère qui la demande ; la fiche complète donne les chambres', () => {
    const s: BuyerSearch = { propertyKinds: [], communes: [], features: ['garden'], surfaceMinM2: 60, roomsMin: null, bedroomsMin: 2, budgetMaxEur: null, financing: null, urgency: null };
    const unknown = matchBuyer({ kind: 'home', city: 'Dijon', priceEur: 200_000, surfaceM2: null, rooms: 3, bedrooms: null, features: [] }, s);
    expect(unknown).toMatchObject({ status: 'miss', unmet: ['surface', 'bedrooms'] });
    const known = matchBuyer({ kind: 'home', city: 'Dijon', priceEur: 200_000, surfaceM2: 61, rooms: 3, bedrooms: 2, features: ['garden'] }, s);
    expect(known).toMatchObject({ status: 'match', unmet: [], featuresMet: ['garden'] });
  });
});

it('[R51] AU071 · un équipement impératif absent ou inconnu écarte le bien, nommé ; un souhait ne fait que classer', () => {
  const base: BuyerSearch = { propertyKinds: [], communes: ['Talant'], features: [], surfaceMinM2: null, roomsMin: null, bedroomsMin: null, budgetMaxEur: null, requiredFeatures: [], budgetStrict: false, financing: null, urgency: null };
  const flat = { kind: 'home' as const, city: 'Talant', priceEur: 200_000, surfaceM2: 60, rooms: 3, bedrooms: 2, features: [] as BuyerSearch['features'] };
  expect(matchBuyer(flat, { ...base, features: ['elevator'] })).toMatchObject({ status: 'match', featuresMet: [] });
  const m = matchBuyer(flat, { ...base, requiredFeatures: ['elevator'] });
  expect(m).toMatchObject({ status: 'miss', unmet: ['features'] });
  expect(m.checks.find((c) => c.criterion === 'features')?.reason).toBe('Impératif absent ou inconnu : ascenseur.');
  expect(matchBuyer({ ...flat, features: ['elevator'] }, { ...base, requiredFeatures: ['elevator'] })).toMatchObject({ status: 'match' });
});

it('[R51] AU115 · un budget dit infranchissable n’a aucune tolérance ; sans cette mention, 5 % au plus', () => {
  const base: BuyerSearch = { propertyKinds: [], communes: [], features: [], surfaceMinM2: null, roomsMin: null, bedroomsMin: null, budgetMaxEur: 200_000, requiredFeatures: [], budgetStrict: false, financing: null, urgency: null };
  const p = { kind: 'home' as const, city: 'Talant', priceEur: 205_000, surfaceM2: 60, rooms: 3, bedrooms: 2, features: [] as BuyerSearch['features'] };
  expect(matchBuyer(p, base)).toMatchObject({ status: 'tolerated' });
  const strict = matchBuyer(p, { ...base, budgetStrict: true });
  expect(strict).toMatchObject({ status: 'miss', unmet: ['budget'] });
  expect(strict.checks[0]!.reason).toBe('Prix au-dessus du budget, que l’acquéreur dit infranchissable.');
  expect(matchBuyer({ ...p, priceEur: 200_000 }, { ...base, budgetStrict: true })).toMatchObject({ status: 'match' });
});
