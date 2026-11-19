import { describe, expect, it } from 'vitest';
import {
  Acces,
  FicheAcquereur,
  FicheClient,
  FicheUnique,
  Rapprochement,
  SqlJournalStore,
  applyMigrations,
  fromSyncSqlite,
  verifyChain,
  type BuyerFeature,
  type DiffusionGate,
  type PropertyKind,
  type SqlDatabase,
} from '../src/index.ts';
import { DISCRIMINATING_TERMS } from '../src/acquereurs/fiche-acquereur.ts';
import { RechercheLangage, applyRefusal, judge, parsePhrase, type PhraseSearch, type PropertyReader } from '../src/recherche/langage-courant.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

// Réseau, agents, personnes et biens inventés.
const START = Date.parse('2027-03-09T09:00:00.000Z');

const PHRASES = [
  'Maison 4 pièces avec jardin à Dijon ou Talant, 100 m² mini, budget 350 000 €, si possible un garage, pas de piscine',
  'T3 lumineux à Fontaine-lès-Dijon, max 250k, idéalement un balcon, pour ma famille avec enfants',
  'appart 2 chambres Chenôve moins de 180000, ascenseur indispensable',
  'Local commercial à Quetigny, 1,2 million au plus',
  'Nous sommes un couple de religion juive, on cherche un studio à Dijon, sans cave, de préférence calme',
  'TERRAIN À BÂTIR À LONGVIC, 600 M2, 90 K€',
];

describe('HX28 · lecture de la phrase', () => {
  it('chaque critère renvoie aux mots exacts de la phrase [R420]', () => {
    for (const phrase of PHRASES) {
      const { criteria } = parsePhrase(phrase);
      expect(criteria.length, phrase).toBeGreaterThan(0);
      for (const c of criteria) {
        expect(c.source.kind).toBe('phrase');
        if (c.source.kind !== 'phrase') continue;
        expect(c.source.words.trim().length).toBeGreaterThan(0);
        expect(phrase.slice(c.source.start, c.source.end)).toBe(c.source.words);
      }
    }
  });

  it('lit types, communes, nombres et contraintes, indispensables et préférences à part', () => {
    const { criteria, ignored } = parsePhrase(PHRASES[0]!);
    const get = (field: string) => criteria.filter((c) => c.field === field).map((c) => [c.value, c.strength]);
    expect(get('propertyKinds')).toEqual([['house', 'must']]);
    expect(get('communes')).toEqual([
      ['Dijon', 'must'],
      ['Talant', 'must'],
    ]);
    expect(get('roomsMin')).toEqual([[4, 'must']]);
    expect(get('surfaceMinM2')).toEqual([[100, 'must']]);
    expect(get('budgetMaxEur')).toEqual([[350_000, 'must']]);
    expect(get('features')).toEqual([
      ['garden', 'must'],
      ['garage', 'nice'],
    ]);
    // « pas de piscine » ne fait aucun critère, et se dit.
    expect(ignored).toEqual([expect.objectContaining({ words: 'piscine', reason: 'negation' })]);

    const t3 = parsePhrase(PHRASES[1]!).criteria;
    expect(t3.find((c) => c.field === 'communes')?.value).toBe('Fontaine-lès-Dijon');
    expect(t3.filter((c) => c.field === 'communes')).toHaveLength(1);
    expect(t3.find((c) => c.field === 'roomsMin')?.value).toBe(3);
    expect(t3.find((c) => c.field === 'budgetMaxEur')?.value).toBe(250_000);
    expect(t3.find((c) => c.value === 'balcony')?.strength).toBe('nice');
    expect(parsePhrase(PHRASES[3]!).criteria.find((c) => c.field === 'budgetMaxEur')?.value).toBe(1_200_000);
    const budget = (phrase: string) => parsePhrase(phrase).criteria.find((c) => c.field === 'budgetMaxEur')?.value;
    expect(budget('maison à Dijon, budget 1.2 million')).toBe(1_200_000);
    expect(budget('maison à Dijon, 250.5k')).toBe(250_500);
    expect(budget('maison à Dijon, 350.000 €')).toBe(350_000);
    expect(budget('maison à Dijon, 350 000 euros')).toBe(350_000);
    expect(budget('maison à Dijon, budget 300k, pas de 500k')).toBe(300_000);
    const surface = (phrase: string) => parsePhrase(phrase).criteria.find((c) => c.field === 'surfaceMinM2');
    expect(surface('maison à Dijon, 80,5 m² minimum')).toMatchObject({ value: 81, source: { words: '80,5 m²' } });
    expect(surface('maison à Dijon, 80.5 m²')?.value).toBe(81);
    expect(surface('terrain à Dijon, 1 200 m² minimum')).toMatchObject({ value: 1200, source: { words: '1 200 m²' } });
    expect(surface('terrain à Dijon, 1\u00a0000 m²')?.value).toBe(1000);
    expect(surface('terrain à Dijon, 12 000 m2')?.value).toBe(12_000);
    expect(surface('terrain à Dijon, 1 200,5 m² minimum')).toMatchObject({ value: 1201, source: { words: '1 200,5 m²' } });
    expect(surface('terrain à Dijon, pas de 1 200,5 m²')).toBeUndefined();
    // Un nombre ne commence jamais au milieu d'un autre : « 1 200,55 m² » ne fait pas « 200,55 m² ».
    expect(surface('terrain à Dijon, 1 200,555 m²')).toBeUndefined();
    expect(surface('terrain à Dijon, pas de 1 200 m²')).toBeUndefined();
    expect(parsePhrase('terrain à Dijon, pas de 1 200 m²').ignored.map((i) => i.words)).toEqual(['1 200 m²']);
    const strength = (phrase: string) => parsePhrase(phrase).criteria.filter((c) => c.field === 'features').map((c) => [c.value, c.strength]);
    expect(strength('maison, si possible un jardin et un garage')).toEqual([
      ['garden', 'nice'],
      ['garage', 'nice'],
    ]);
    expect(strength('maison avec jardin et si possible un garage')).toEqual([
      ['garden', 'must'],
      ['garage', 'nice'],
    ]);
    expect(strength('si possible un jardin, un garage')).toEqual([
      ['garden', 'nice'],
      ['garage', 'must'],
    ]);
    const terrain = parsePhrase(PHRASES[5]!).criteria;
    expect(terrain.map((c) => [c.field, c.value])).toEqual([
      ['propertyKinds', 'land'],
      ['communes', 'Longvic'],
      ['surfaceMinM2', 600],
      ['budgetMaxEur', 90_000],
    ]);
  });

  it('un mot discriminant ne devient jamais un critère : il est écarté et dit [R50]', () => {
    for (const phrase of [PHRASES[1]!, PHRASES[4]!]) {
      const { criteria, ignored } = parsePhrase(phrase);
      expect(ignored.filter((i) => i.reason === 'R50').length).toBeGreaterThan(0);
      for (const c of criteria) {
        if (c.source.kind !== 'phrase') continue;
        for (const i of ignored) expect(c.source.end <= i.start || c.source.start >= i.end).toBe(true);
      }
    }
    expect(parsePhrase(PHRASES[4]!).ignored.map((i) => i.words)).toEqual(['couple', 'religion', 'cave']);
    // Chaque mot de la liste fermée est écarté, seul dans une phrase.
    for (const term of DISCRIMINATING_TERMS) {
      const { criteria, ignored } = parsePhrase(`maison à Dijon, ${term}`);
      expect(ignored.some((i) => i.reason === 'R50'), term).toBe(true);
      expect(criteria.map((c) => c.field).sort()).toEqual(['communes', 'propertyKinds']);
    }
  });

  it('une négation ne fait jamais un critère, quel qu’il soit [R420]', () => {
    const t1 = parsePhrase('pas de T1, plutôt une maison');
    expect(t1.criteria.map((c) => [c.field, c.value])).toEqual([['propertyKinds', 'house']]);
    expect(t1.ignored).toEqual([expect.objectContaining({ words: 'T1', reason: 'negation' })]);
    for (const phrase of ['sans Chenôve, à Dijon', 'surtout pas à Chenôve, à Dijon', 'hors Chenôve, à Dijon']) {
      const r = parsePhrase(phrase);
      expect(r.criteria.map((c) => c.value), phrase).toEqual(['Dijon']);
      expect(r.ignored.map((i) => i.words), phrase).toEqual(['Chenôve']);
    }
    expect(parsePhrase('maison, pas de jardin ni de garage, ni d’ascenseur').criteria.map((c) => c.value)).toEqual(['house']);
    expect(parsePhrase('maison à Dijon, pas de 3 chambres, sans 200 m²').criteria.map((c) => c.field)).toEqual(['propertyKinds', 'communes']);
  });

  it('une phrase trop longue est lue sur 500 caractères', () => {
    const { criteria } = parsePhrase(`${'a '.repeat(260)} maison à Dijon`);
    expect(criteria).toEqual([]);
  });
});

describe('HX28 · refus', () => {
  const base = (phrase: string): PhraseSearch => ({ ...parsePhrase(phrase), excludedCommunes: [], excludedKinds: [], refusedPropertyIds: [] });
  const prop = (over: Partial<{ priceEur: number; surfaceM2: number; rooms: number; city: string; features: BuyerFeature[] }> = {}) => ({
    kind: 'home' as PropertyKind,
    city: over.city ?? 'Dijon',
    priceEur: over.priceEur ?? 300_000,
    surfaceM2: over.surfaceM2 ?? 90,
    rooms: over.rooms ?? 4,
    bedrooms: 3,
    features: over.features ?? (['garden'] as BuyerFeature[]),
  });

  it('chaque raison cite les mots du critère qui a servi, préférences comprises [R420]', () => {
    const talant = judge(base('maison, idéalement à Dijon ou Talant'), prop({ city: 'Talant' }))!;
    expect(talant.reasons.find((r) => r.text.includes('Commune'))).toEqual({ text: 'Préférence remplie. Commune cherchée : Talant.', from: '« Talant »' });
    const dijon = judge(base('maison à Dijon ou Talant'), prop({ city: 'Dijon' }))!;
    expect(dijon.reasons.find((r) => r.text.includes('Commune'))!.from).toBe('« Dijon »');
    const two = judge(base('maison à Dijon, 60 m², ou plutôt 80 m²'), prop({ surfaceM2: 90 }))!;
    expect(two.reasons.find((r) => r.text.startsWith('Surface'))).toEqual({ text: 'Surface 90 m² pour 80 m² au moins.', from: '« 80 m² »' });
  });

  it('trop cher : le budget passe sous ce prix, tolérance comprise, et le bien ne revient plus [R424]', () => {
    const s = base('maison à Dijon, budget 350 000 €');
    const refused = prop({ priceEur: 340_000 });
    expect(judge(s, refused)).not.toBeNull();
    const after = applyRefusal(s, { id: 'b1', match: refused }, 'trop_cher', undefined);
    expect(after.refusedPropertyIds).toEqual(['b1']);
    const budget = after.criteria.find((c) => c.field === 'budgetMaxEur')!;
    expect(budget.source).toEqual({ kind: 'refus', propertyId: 'b1', reason: 'trop_cher' });
    expect(judge(after, prop({ priceEur: 340_000 }))).toBeNull();
    // Au plus juste : le nouveau budget, tolérance comprise, reste sous le prix refusé.
    const max = budget.value as number;
    expect(Math.floor((max * 105) / 100)).toBeLessThan(340_000);
    expect(judge(after, prop({ priceEur: Math.floor((max * 105) / 100) }))).not.toBeNull();
    expect(judge(after, prop({ priceEur: Math.floor(((max + 1) * 105) / 100) + 1 }))).toBeNull();
    // Le budget ne remonte jamais après un second refus moins cher.
    const again = applyRefusal(after, { id: 'b2', match: prop({ priceEur: 330_000 }) }, 'trop_cher', undefined);
    const lower = applyRefusal(again, { id: 'b3', match: prop({ priceEur: 345_000 }) }, 'trop_cher', undefined);
    expect(lower.criteria.find((c) => c.field === 'budgetMaxEur')!.value).toBe(again.criteria.find((c) => c.field === 'budgetMaxEur')!.value);
  });

  it('trop petit, pièces, commune, type et contrainte manquante ajustent chacun leur critère [R424]', () => {
    const s = base('maison à Dijon ou Talant, 80 m², si possible un garage');
    const small = applyRefusal(s, { id: 'b1', match: prop({ surfaceM2: 85 }) }, 'trop_petit', undefined);
    expect(judge(small, prop({ surfaceM2: 85 }))).toBeNull();
    expect(judge(small, prop({ surfaceM2: 95 }))).not.toBeNull();
    const rooms = applyRefusal(s, { id: 'b1', match: prop({ rooms: 3 }) }, 'pas_assez_de_pieces', undefined);
    expect(judge(rooms, prop({ rooms: 3 }))).toBeNull();
    expect(judge(rooms, prop({ rooms: 4 }))).not.toBeNull();
    const commune = applyRefusal(s, { id: 'b1', match: prop({ city: 'Talant' }) }, 'commune', undefined);
    expect(judge(commune, prop({ city: 'Talant' }))).toBeNull();
    expect(judge(commune, prop({ city: 'Dijon' }))).not.toBeNull();
    const kind = applyRefusal(s, { id: 'b1', match: prop() }, 'type', undefined);
    expect(judge(kind, prop())).toBeNull();
    const garage = applyRefusal(s, { id: 'b1', match: prop() }, 'manque', 'garage');
    expect(garage.criteria.find((c) => c.value === 'garage')?.strength).toBe('must');
    expect(judge(garage, prop({ features: ['garden'] }))).toBeNull();
    expect(judge(garage, prop({ features: ['garage'] }))).not.toBeNull();
  });
});

async function setup() {
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
  const diffusion: DiffusionGate = {
    canDiffuse: async (_n, id) => (blocked.has(id) ? { allowed: false, reason: 'withdrawal_period' } : { allowed: true, reason: 'allowed' }),
  };
  const rapprochement = new Rapprochement(db, fiche, diffusion, journal, { now });
  const features = new Map<string, BuyerFeature[]>();
  const reader: PropertyReader = {
    propertyForMatch: async (p) => ({ ...(await rapprochement.propertyForMatch(p)), features: features.get(p.id) ?? [] }),
  };
  const recherche = new RechercheLangage(db, reader, diffusion, journal, { now });
  const network = await store.createNetwork('Réseau test');
  const alex = await store.createAgent({ networkId: network.id, firstName: 'Alex', lastName: 'Agent' });
  const sam = await store.createAgent({ networkId: network.id, firstName: 'Sam', lastName: 'Agent' });
  const as = (role: 'agent' | 'direction', userId: string) => ({ role, userId, networkId: network.id });
  const property = async (ref: string, p: { kind?: PropertyKind; city: string; price: number; surface: number; rooms: number; status?: 'available' | 'sold'; features?: BuyerFeature[] }) => {
    const created = await store.createProperty({
      networkId: network.id,
      agentId: alex.id,
      reference: ref,
      kind: p.kind ?? 'home',
      city: p.city,
      priceEur: p.price,
      surfaceM2: p.surface,
      rooms: p.rooms,
      status: p.status ?? 'available',
    });
    features.set(created.id, p.features ?? []);
    return created;
  };
  const buyer = async (agentId: string) => {
    const person = await store.createPerson({ networkId: network.id, agentId, firstName: 'Camille' });
    const project = await store.createProject({ networkId: network.id, agentId, personId: person.id, kind: 'buy' });
    return { person, project };
  };
  const consent = async (personId: string, purpose: string, withdrawnAt: string | null = null) => {
    const id = crypto.randomUUID();
    const at = new Date(START - 86_400_000).toISOString();
    await db.run(
      `INSERT INTO consents (id, network_id, agent_id, person_id, purpose, channel, proof, given_at, withdrawn_at, created_at) VALUES (?, ?, ?, ?, ?, 'email', 'formulaire inventé', ?, ?, ?)`,
      [id, network.id, alex.id, personId, purpose, at, withdrawnAt, at],
    );
    return id;
  };
  return { db, journal, acces, acquereurs, recherche, network, alex, sam, as, property, buyer, consent, blocked };
}

const PHRASE = 'Maison 4 pièces à Dijon, 100 m² mini, budget 350 000 €, si possible un garage';

describeWithSqlite('HX28 · recherche sur la base', () => {
  it('seuls des biens diffusables sont montrés, sans adresse, chacun avec ses raisons [R421] [R420]', async () => {
    const t = await setup();
    const ok = await t.property('A1', { city: 'Dijon', price: 320_000, surface: 110, rooms: 5, features: ['garage'] });
    const tolerated = await t.property('A2', { city: 'Dijon', price: 360_000, surface: 100, rooms: 4 });
    const blocked = await t.property('A3', { city: 'Dijon', price: 300_000, surface: 120, rooms: 5 });
    await t.property('A4', { city: 'Dijon', price: 300_000, surface: 120, rooms: 5, status: 'sold' });
    await t.property('A5', { city: 'Dijon', price: 500_000, surface: 120, rooms: 5 });
    await t.property('A6', { city: 'Dijon', kind: 'land', price: 100_000, surface: 900, rooms: 0 });
    t.blocked.add(blocked.id);
    const r = await t.recherche.search(t.network.id, PHRASE);
    expect(r.results.map((x) => x.reference)).toEqual(['A1', 'A2']);
    expect(r.results.map((x) => x.propertyId)).toEqual([ok.id, tolerated.id]);
    expect(r.results[0]!.status).toBe('match');
    expect(r.results[1]!.status).toBe('tolerated');
    expect(r.results[0]!.preferencesMet).toBe(1);
    for (const x of r.results) {
      expect(Object.keys(x).sort()).toEqual(['city', 'kind', 'neighbourOf', 'preferencesMet', 'priceEur', 'propertyId', 'reasons', 'reference', 'rooms', 'status', 'surfaceM2']);
      expect(x.reasons.length).toBeGreaterThan(0);
      for (const reason of x.reasons) expect(reason.from).toMatch(/^« .+ »$/);
    }
    expect(r.results[0]!.reasons.map((x) => x.from)).toEqual(['« Maison »', '« Dijon »', '« 350 000 € »', '« 100 m² »', '« 4 pièces »', '« garage »']);
  });

  it('les communes voisines sont proposées à part et marquées, jamais ajoutées sans un geste [R423]', async () => {
    const t = await setup();
    const talant = await t.property('V1', { city: 'Talant', price: 300_000, surface: 110, rooms: 5 });
    await t.property('V2', { city: 'Beaune', price: 300_000, surface: 110, rooms: 5 });
    const r = await t.recherche.search(t.network.id, PHRASE);
    expect(r.results).toEqual([]);
    expect(r.proposedNeighbours).toContainEqual({ commune: 'Talant', of: 'Dijon' });
    expect(r.neighbours.map((x) => [x.propertyId, x.neighbourOf])).toEqual([[talant.id, 'Dijon']]);
    expect(r.neighbours[0]!.reasons[0]!.text).toBe("Commune voisine de Dijon, proposée : Talant n'est pas dans la recherche.");
    expect(r.search.criteria.some((c) => c.value === 'Talant')).toBe(false);
    const accepted = await t.recherche.search(t.network.id, PHRASE, [{ acceptNeighbour: 'Talant' }]);
    expect(accepted.results.map((x) => x.propertyId)).toEqual([talant.id]);
    expect(accepted.results[0]!.neighbourOf).toBeNull();
    expect(accepted.results[0]!.reasons.find((x) => x.text.startsWith('Commune'))!.from).toBe('commune voisine de Dijon, acceptée');
    // Une commune qui n'est pas voisine ne s'accepte pas par un geste.
    const forged = await t.recherche.search(t.network.id, PHRASE, [{ acceptNeighbour: 'Beaune' }]);
    expect(forged.search.criteria.some((c) => c.value === 'Beaune')).toBe(false);
  });

  it('après un refus, le bien ne revient plus et les critères s’ajustent [R424]', async () => {
    const t = await setup();
    const a = await t.property('R1', { city: 'Dijon', price: 340_000, surface: 110, rooms: 5 });
    const b = await t.property('R2', { city: 'Dijon', price: 345_000, surface: 120, rooms: 5 });
    const c = await t.property('R3', { city: 'Dijon', price: 290_000, surface: 105, rooms: 4 });
    const first = await t.recherche.search(t.network.id, PHRASE);
    expect(first.results.map((x) => x.propertyId).sort()).toEqual([a.id, b.id, c.id].sort());
    const after = await t.recherche.search(t.network.id, PHRASE, [{ refuse: a.id, reason: 'trop_cher' }]);
    expect(after.results.map((x) => x.propertyId)).toEqual([c.id]);
    expect(after.search.criteria.find((x) => x.field === 'budgetMaxEur')!.source).toEqual({ kind: 'refus', propertyId: a.id, reason: 'trop_cher' });
    expect(after.results[0]!.reasons.find((x) => x.text.startsWith('Prix'))!.from).toBe('ajusté après un refus (trop cher)');
    // Un bien qui ne peut pas être montré ne se refuse pas : rien de lui ne passe dans les critères [R421].
    const hidden = await t.property('R4', { city: 'Dijon', price: 333_333, surface: 101, rooms: 4 });
    const sold = await t.property('R5', { city: 'Talant', price: 312_345, surface: 99, rooms: 4, status: 'sold' });
    t.blocked.add(hidden.id);
    for (const reason of ['trop_cher', 'trop_petit', 'pas_assez_de_pieces', 'commune'] as const) {
      const leak = await t.recherche.search(t.network.id, PHRASE, [{ refuse: hidden.id, reason }, { refuse: sold.id, reason }]);
      expect(leak.search).toEqual(first.search);
      const text = JSON.stringify(leak);
      for (const secret of [hidden.id, sold.id, '317460', '297471']) expect(text).not.toContain(secret);
    }
    // Un refus fait quand le bien était en vente garde son effet après la vente : le budget ne remonte pas.
    await t.db.run("UPDATE properties SET status = 'sold' WHERE id = ?", [a.id]);
    // La mise en vente rangée par IN11 ; son mandat n'importe pas ici, les clés étrangères sont coupées le temps de l'écrire.
    await t.db.run('PRAGMA foreign_keys = OFF');
    await t.db.run('INSERT INTO property_on_sale (property_id, network_id, mandate_id, on_sale_at, noted_at) VALUES (?, ?, ?, ?, ?)', [a.id, t.network.id, 'mandat-invente', new Date(START).toISOString(), new Date(START).toISOString()]);
    await t.db.run('PRAGMA foreign_keys = ON');
    const later = await t.recherche.search(t.network.id, PHRASE, [{ refuse: a.id, reason: 'trop_cher' }]);
    expect(later.search.criteria.find((x) => x.field === 'budgetMaxEur')).toEqual(after.search.criteria.find((x) => x.field === 'budgetMaxEur'));
    await t.db.run("UPDATE properties SET status = 'available' WHERE id = ?", [a.id]);
    // Un bien d'un autre réseau ou une raison hors liste ne changent rien.
    const odd = await t.recherche.search(t.network.id, PHRASE, [{ refuse: 'inconnu', reason: 'trop_cher' }, { refuse: c.id, reason: 'moche' as never }]);
    expect(odd.results).toHaveLength(3);
  });
});

describeWithSqlite('HX28 · rangement dans la fiche acquéreur', () => {
  it('sans accord en cours de la personne, aucune fiche acquéreur n’est créée [R422]', async () => {
    const t = await setup();
    const { person, project } = await t.buyer(t.alex.id);
    const none = await t.recherche.save(t.acces, t.as('agent', t.alex.id), t.acquereurs, project.id, PHRASE);
    expect(none).toEqual({ ok: false, rule: 'R422', code: 'sans_accord' });
    // Un accord pour une autre finalité, ou retiré, ne vaut pas.
    await t.consent(person.id, 'alert');
    await t.consent(person.id, 'buyer_search', new Date(START - 3_600_000).toISOString());
    const other = await t.recherche.save(t.acces, t.as('agent', t.alex.id), t.acquereurs, project.id, PHRASE);
    expect(other).toEqual({ ok: false, rule: 'R422', code: 'sans_accord' });
    expect(await t.db.all('SELECT id FROM buyer_searches')).toEqual([]);
    expect(await t.db.all('SELECT id FROM phrase_searches')).toEqual([]);
    expect((await t.journal.all()).filter((e) => e.type === 'recherche.refuse').map((e) => e.data)).toEqual([
      { rule: 'R422', code: 'sans_accord' },
      { rule: 'R422', code: 'sans_accord' },
    ]);
  });

  it('avec l’accord, la recherche devient une fiche acquéreur, critères et mots gardés, jamais la phrase [R422] [R420] [R13]', async () => {
    const t = await setup();
    const { person, project } = await t.buyer(t.alex.id);
    const consentId = await t.consent(person.id, 'buyer_search');
    const phrase = `${PHRASE}, pour notre famille, contact Camille au 06 00 00 00 00`;
    const saved = await t.recherche.save(t.acces, t.as('agent', t.alex.id), t.acquereurs, project.id, phrase, [{ acceptNeighbour: 'Talant' }]);
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    const current = await t.acquereurs.current(project.id);
    expect(current?.id).toBe(saved.value.buyerSearchId);
    expect(current?.search).toMatchObject({
      propertyKinds: ['house'],
      communes: ['Dijon', 'Talant'],
      features: ['garage'],
      surfaceMinM2: 100,
      roomsMin: 4,
      budgetMaxEur: 350_000,
      // Le garage n'est qu'un souhait : il classe, il n'écarte pas (AU071) ; le budget garde sa tolérance (AU115).
      requiredFeatures: [],
      budgetStrict: false,
    });
    const rows = await t.db.all<{ consent_id: string; criteria: string; buyer_search_id: string }>('SELECT * FROM phrase_searches');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.consent_id).toBe(consentId);
    const criteria = JSON.parse(rows[0]!.criteria) as { field: string; strength: string; source: { kind: string; words?: string } }[];
    expect(criteria.find((c) => c.field === 'features')).toMatchObject({ strength: 'nice', source: { kind: 'phrase', words: 'garage' } });
    expect(criteria.find((c) => c.source.kind === 'voisine')).toMatchObject({ field: 'communes', source: { kind: 'voisine', of: 'Dijon' } });
    for (const forbidden of ['Camille', '06 00', 'famille', 'contact']) expect(rows[0]!.criteria).not.toContain(forbidden);
    // Rien de la recherche au journal [R13].
    const entries = await t.journal.all();
    // Les données de l'entrée seulement : un identifiant tiré au hasard peut contenir « 350 ».
    // Les identifiants (UUID) sont retirés : tirés au hasard, ils peuvent contenir « 350 » (test instable vu sur HX56).
    const text = JSON.stringify(entries.filter((e) => e.type.startsWith('recherche.')).map((e) => e.data)).replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<id>');
    for (const forbidden of ['Dijon', '350', 'garage', 'Camille']) expect(text).not.toContain(forbidden);
    expect((await verifyChain(entries)).ok).toBe(true);
  });

  it('une commune refusée ne reste jamais dans la fiche rangée [R424]', async () => {
    const t = await setup();
    const { person, project } = await t.buyer(t.alex.id);
    await t.consent(person.id, 'buyer_search');
    const dijon = await t.property('C1', { city: 'Dijon', price: 300_000, surface: 110, rooms: 5 });
    const agent = t.as('agent', t.alex.id);
    expect((await t.recherche.save(t.acces, agent, t.acquereurs, project.id, PHRASE)).ok).toBe(true);
    // Refuser la dernière commune cherchée : rien n'est rangé, la fiche ne garde pas Dijon en silence.
    const last = await t.recherche.save(t.acces, agent, t.acquereurs, project.id, PHRASE, [{ refuse: dijon.id, reason: 'commune' }]);
    expect(last).toEqual({ ok: false, rule: 'R424', code: 'a_preciser' });
    // Avec une autre commune qui reste, la liste rangée remplace l'ancienne, sans la commune refusée.
    const phrase = 'Maison 4 pièces à Dijon ou Talant, 100 m² mini, budget 350 000 €';
    const ok = await t.recherche.save(t.acces, agent, t.acquereurs, project.id, phrase, [{ refuse: dijon.id, reason: 'commune' }]);
    expect(ok.ok).toBe(true);
    expect((await t.acquereurs.current(project.id))?.search.communes).toEqual(['Talant']);
  });

  it('un autre agent ne range rien dans la fiche d’un client qui n’est pas le sien [R16]', async () => {
    const t = await setup();
    const { person, project } = await t.buyer(t.alex.id);
    await t.consent(person.id, 'buyer_search');
    const r = await t.recherche.save(t.acces, t.as('agent', t.sam.id), t.acquereurs, project.id, PHRASE);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.rule).toBe('R16');
    expect(await t.db.all('SELECT id FROM buyer_searches')).toEqual([]);
    expect(await t.db.all('SELECT id FROM phrase_searches')).toEqual([]);
  });

  it('une phrase sans critère ne range rien ; une recherche rangée ne change ni ne s’efface [R17]', async () => {
    const t = await setup();
    const { person, project } = await t.buyer(t.alex.id);
    await t.consent(person.id, 'buyer_search');
    expect(await t.recherche.save(t.acces, t.as('direction', 'd1'), t.acquereurs, project.id, 'bonjour, je voudrais des infos')).toEqual({
      ok: false,
      rule: 'R420',
      code: 'aucun_critere',
    });
    const ok = await t.recherche.save(t.acces, t.as('direction', 'd1'), t.acquereurs, project.id, PHRASE);
    expect(ok.ok).toBe(true);
    await expect(t.db.run("UPDATE phrase_searches SET criteria = '[]'")).rejects.toThrow();
    await expect(t.db.run('DELETE FROM phrase_searches')).rejects.toThrow();
    // La même recherche rangée deux fois ne crée pas de seconde version de la fiche.
    const again = await t.recherche.save(t.acces, t.as('direction', 'd1'), t.acquereurs, project.id, PHRASE);
    expect(again.ok && again.value.buyerSearchId).toBeNull();
    expect(await t.db.all('SELECT id FROM buyer_searches')).toHaveLength(1);
  });
});

describeWithSqlite('AU071 · AU115 · l’indispensable et le budget ferme de la phrase', () => {
  it('[R420] « avec ascenseur » devient un impératif, « si possible une cave » un souhait ; « budget ferme » ôte la tolérance', async () => {
    const t = await setup();
    const { person, project } = await t.buyer(t.alex.id);
    await t.consent(person.id, 'buyer_search');
    const saved = await t.recherche.save(t.acces, t.as('agent', t.alex.id), t.acquereurs, project.id, 'Appartement à Dijon avec ascenseur, si possible une cave, budget ferme 250 000 euros');
    expect(saved.ok).toBe(true);
    const current = await t.acquereurs.current(project.id);
    expect(current?.search.requiredFeatures).toEqual(['elevator']);
    expect(current?.search.features?.sort()).toEqual(['cellar', 'elevator']);
    expect(current?.search.budgetStrict).toBe(true);
    expect(current?.search.budgetMaxEur).toBe(250_000);
  });
});
