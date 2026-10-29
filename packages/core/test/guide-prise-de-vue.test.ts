import { expect, it } from 'vitest';
import { Acces, FicheClient, FicheUnique, SqlJournalStore, applyMigrations, fromSyncSqlite, type SqlDatabase } from '../src/index.ts';
import { DO_NOT_FORGET, GuidePriseDeVue, SHOT_ADVICE, guideViews } from '../src/studio/index.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

const AT = Date.parse('2027-10-05T08:00:00.000Z');
const ref = (p: string, n: number) => `biens/${p}/0000000${n}-0000-4000-8000-000000000000.jpg`;

it('[R10] chaque pièce que la fiche dit a ses vues et sa consigne ; rien n’est inventé', () => {
  const flat = guideViews({ kind: 'home', rooms: 4, bedrooms: 2, outdoor: ['balcon'], parkingSpaces: 1 });
  expect(flat.map((v) => [v.key, v.mandatory])).toEqual([
    ['entree', true],
    ['sejour', true],
    ['cuisine', true],
    ['chambre_1', true],
    ['chambre_2', true],
    ['salle_d_eau', true],
    ['exterieur_balcon', true],
    ['stationnement', true],
    ['facade', false],
    ['vue', false],
  ]);
  for (const v of flat) {
    expect(v.place.length, v.key).toBeGreaterThan(10);
    expect(v.height.length, v.key).toBeGreaterThan(5);
    expect(v.light.length, v.key).toBeGreaterThan(5);
  }
  // Sans chambre ni extérieur ni stationnement dits : aucune vue de plus.
  expect(guideViews({ kind: 'home', rooms: 1, bedrooms: null, outdoor: [], parkingSpaces: null }).map((v) => v.key)).toEqual(['entree', 'sejour', 'cuisine', 'salle_d_eau', 'facade', 'vue']);
  expect(guideViews({ kind: 'land', rooms: null, bedrooms: null, outdoor: [], parkingSpaces: null }).map((v) => v.key)).toEqual(['terrain']);
  expect(guideViews({ kind: 'commercial', rooms: null, bedrooms: null, outdoor: [], parkingSpaces: 2 }).map((v) => v.key)).toEqual(['local', 'facade', 'stationnement']);
  expect(guideViews({ kind: 'building', rooms: 8, bedrooms: 0, outdoor: ['cour', 'piscine'], parkingSpaces: 0 }).map((v) => v.key)).toEqual(['facade', 'entree', 'sejour', 'cuisine', 'salle_d_eau', 'exterieur_cour', 'vue']);
  // La façade et la vue rappellent : aucune plaque ni numéro lisible.
  expect(SHOT_ADVICE.facade!.place).toMatch(/sans numéro/);
  expect(DO_NOT_FORGET.some((d) => /Aucune personne/.test(d))).toBe(true);
});

async function setup() {
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  let clock = AT;
  const now = (): Date => new Date((clock += 1000));
  const journal = new SqlJournalStore(db);
  const store = new FicheClient(db, { now });
  const acces = new Acces(db, store, new FicheUnique(db, store, { now }), journal, { now });
  const guide = new GuidePriseDeVue(db, acces, journal, { now });
  const network = await store.createNetwork('Réseau test');
  const alex = await store.createAgent({ networkId: network.id, firstName: 'Alex', lastName: 'Agent' });
  const sam = await store.createAgent({ networkId: network.id, firstName: 'Sam', lastName: 'Agent' });
  const p = await store.createProperty({ networkId: network.id, agentId: alex.id, reference: 'G-1', kind: 'home', city: 'X', priceEur: 200_000, surfaceM2: 70, rooms: 3, status: 'available' });
  const photos = [1, 2, 3, 4, 5, 6, 7].map((n) => ({ ref: ref(p.id, n), kind: 'photo', edit: 'aucune' }));
  const sheet = (v: number, media: unknown[]) =>
    db.run("INSERT INTO property_sheets (id, property_id, network_id, version, data, created_by, created_at) VALUES (?, ?, ?, ?, ?, 'agent:a', '2027-10-01')", [
      `s-${v}`,
      p.id,
      network.id,
      v,
      JSON.stringify({ characteristics: { bedrooms: 1, outdoor: ['jardin'], parkingSpaces: 0 }, energy: null, coownership: null, risks: null, media }),
    ]);
  await sheet(1, photos);
  const as = (role: 'agent' | 'direction' | 'compliance', userId: string) => ({ role, userId, networkId: network.id });
  return { db, journal, guide, network, alex, sam, p, photos, sheet, as };
}

describeWithSqlite('X01 · guide de prise de vue', () => {
  it('une vue obligatoire manquante empêche « prêt » ; la photo vient de la fiche du bien', async () => {
    const t = await setup();
    const alex = t.as('agent', t.alex.id);
    const g = await t.guide.progress(alex, t.p.id);
    if (!g.ok) throw new Error(g.code);
    expect(g.value.views.map((v) => v.key)).toEqual(['entree', 'sejour', 'cuisine', 'chambre_1', 'salle_d_eau', 'exterieur_jardin', 'facade', 'vue']);
    expect(g.value.ready).toBe(false);
    expect(g.value.missing).toHaveLength(6);
    const keys = ['entree', 'sejour', 'cuisine', 'chambre_1', 'salle_d_eau'];
    for (const [i, k] of keys.entries()) expect(await t.guide.recordShot(alex, t.p.id, { viewKey: k, mediaRef: t.photos[i]!.ref })).toMatchObject({ ok: true });
    const almost = await t.guide.progress(alex, t.p.id);
    expect(almost.ok && almost.value.missing).toEqual(['exterieur_jardin']);
    expect(await t.guide.validate(t.as('direction', 'd1'), t.p.id)).toEqual({ ok: false, rule: 'R10', code: 'pas_pret' });
    // Une photo qui n'est pas dans la fiche, ou une vue que le guide n'a pas : refusées.
    expect(await t.guide.recordShot(alex, t.p.id, { viewKey: 'exterieur_jardin', mediaRef: 'biens/autre/00000009-0000-4000-8000-000000000000.jpg' })).toMatchObject({ ok: false, code: 'photo_inconnue' });
    expect(await t.guide.recordShot(alex, t.p.id, { viewKey: 'piscine', mediaRef: t.photos[5]!.ref })).toMatchObject({ ok: false, code: 'vue_inconnue' });
    const done = await t.guide.recordShot(alex, t.p.id, { viewKey: 'exterieur_jardin', mediaRef: t.photos[5]!.ref });
    expect(done.ok && done.value.ready).toBe(true);
    // Une photo retirée de la fiche : la vue redevient à faire.
    await t.sheet(2, t.photos.filter((_, i) => i !== 5));
    const back = await t.guide.progress(alex, t.p.id);
    expect(back.ok && back.value.missing).toEqual(['exterieur_jardin']);
  });

  it('[R17] la direction valide un bien prêt, une seule fois ; ensuite plus rien ne change', async () => {
    const t = await setup();
    const alex = t.as('agent', t.alex.id);
    const keys = ['entree', 'sejour', 'cuisine', 'chambre_1', 'salle_d_eau', 'exterieur_jardin'];
    for (const [i, k] of keys.entries()) await t.guide.recordShot(alex, t.p.id, { viewKey: k, mediaRef: t.photos[i]!.ref });
    expect(await t.guide.validate(alex, t.p.id)).toMatchObject({ ok: false, rule: 'R16', code: 'role' });
    const v = await t.guide.validate(t.as('direction', 'd1'), t.p.id);
    expect(v.ok && v.value.validated).toMatchObject({ by: 'direction:d1' });
    expect(await t.guide.validate(t.as('direction', 'd2'), t.p.id)).toMatchObject({ ok: true, value: { validated: { by: 'direction:d1' } } });
    expect(await t.guide.recordShot(alex, t.p.id, { viewKey: 'vue', mediaRef: t.photos[6]!.ref })).toMatchObject({ ok: false, code: 'deja_valide' });
    await expect(t.db.run('DELETE FROM photo_guide_validations')).rejects.toThrow(/rien ne s'efface/);
    await expect(t.db.run("UPDATE photo_guide_shots SET view_key = 'vue'")).rejects.toThrow(/ne change plus/);
  });

  it('[R16] un autre agent ne voit ni n’écrit le guide d’un bien qui n’est pas le sien ; la conformité lit sans écrire', async () => {
    const t = await setup();
    const sam = t.as('agent', t.sam.id);
    expect(await t.guide.progress(sam, t.p.id)).toMatchObject({ ok: false, rule: 'R16' });
    expect(await t.guide.recordShot(sam, t.p.id, { viewKey: 'entree', mediaRef: t.photos[0]!.ref })).toMatchObject({ ok: false, rule: 'R16' });
    expect(await t.guide.progress(t.as('compliance', 'c1'), t.p.id)).toMatchObject({ ok: true });
    expect(await t.guide.recordShot(t.as('compliance', 'c1'), t.p.id, { viewKey: 'entree', mediaRef: t.photos[0]!.ref })).toMatchObject({ ok: false, rule: 'R16', code: 'role' });
    expect((await t.journal.all()).filter((e) => e.type === 'acces.refuse').length).toBeGreaterThanOrEqual(2);
  });

  it('[R17] une fiche ou une photo changée après la validation la rend caduque : le guide se complète et se valide de nouveau', async () => {
    const t = await setup();
    const alex = t.as('agent', t.alex.id);
    const keys = ['entree', 'sejour', 'cuisine', 'chambre_1', 'salle_d_eau', 'exterieur_jardin'];
    for (const [i, k] of keys.entries()) await t.guide.recordShot(alex, t.p.id, { viewKey: k, mediaRef: t.photos[i]!.ref });
    await t.guide.validate(t.as('direction', 'd1'), t.p.id);
    // La fiche passe à 2 chambres : une vue de plus, la validation ne tient plus.
    await t.db.run("INSERT INTO property_sheets (id, property_id, network_id, version, data, created_by, created_at) VALUES ('s-9', ?, ?, 2, ?, 'agent:a', '2027-10-02')", [
      t.p.id,
      t.network.id,
      JSON.stringify({ characteristics: { bedrooms: 2, outdoor: ['jardin'], parkingSpaces: 0 }, energy: null, coownership: null, risks: null, media: t.photos }),
    ]);
    const stale = await t.guide.progress(alex, t.p.id);
    expect(stale.ok && [stale.value.ready, stale.value.validated]).toEqual([false, null]);
    expect(await t.guide.recordShot(alex, t.p.id, { viewKey: 'chambre_2', mediaRef: t.photos[6]!.ref })).toMatchObject({ ok: true, value: { ready: true, validated: null } });
    const again = await t.guide.validate(t.as('direction', 'd2'), t.p.id);
    expect(again.ok && again.value.validated).toMatchObject({ by: 'direction:d2' });
    expect(Number((await t.db.first<{ n: number }>('SELECT count(*) AS n FROM photo_guide_validations'))!.n)).toBe(2);
  });

  it('[R10] une image d’aménagement virtuel ne remplit jamais une vue', async () => {
    const t = await setup();
    const virtual = { ref: ref(t.p.id, 8), kind: 'photo', edit: 'amenagement_virtuel' };
    await t.sheet(2, [...t.photos, virtual]);
    expect(await t.guide.recordShot(t.as('agent', t.alex.id), t.p.id, { viewKey: 'sejour', mediaRef: virtual.ref })).toMatchObject({ ok: false, code: 'photo_inconnue' });
  });
});
