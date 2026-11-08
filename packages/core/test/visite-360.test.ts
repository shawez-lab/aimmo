import { expect, it } from 'vitest';
import { Acces, FicheClient, FicheUnique, Reception, ReconnaissanceBien, SqlJournalStore, applyMigrations, fromSyncSqlite, annonces, type SqlDatabase } from '../src/index.ts';
import { VIEW_ATTESTATION, VIEW_ATTESTATION_TEXT, VisitesVirtuelles, checkTourViews, roomNames, tourViewsOut } from '../src/medias/index.ts';
import { PlanLogement, type PlanRoom } from '../src/studio/index.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

const AT = Date.parse('2027-11-06T08:00:00.000Z');
const sha = (c: string) => c.repeat(64);
const view = (p: string, n: number, roomIndex: number | null, extra: Record<string, unknown> = {}) => ({ viewRef: `biens/${p}/360/vue-${n}.jpg`, sha256: sha(String(n)), roomIndex, attestation: VIEW_ATTESTATION, ...extra });
const room = (kind: PlanRoom['kind'], xCm: number): PlanRoom => ({ kind, xCm, yCm: 0, widthCm: 300, depthCm: 300 });
const ROOMS: PlanRoom[] = [room('sejour', 0), room('chambre', 300), room('chambre', 600), room('balcon', 900), room('garage', 1200)];

it('[R499] [R500] chaque vue va dans une pièce intérieure du plan, nommée par le code, avec l’attestation de l’agent', () => {
  expect(roomNames(ROOMS)).toEqual(['Séjour', 'Chambre 1', 'Chambre 2', 'Balcon', 'Garage']);
  expect(checkTourViews('b1', [view('b1', 1, 0), view('b1', 2, 2), view('b1', 3, null)], ROOMS)).toMatchObject({ ok: true });
  // Une pièce qui n'est pas dans le plan.
  expect(checkTourViews('b1', [view('b1', 1, 9)], ROOMS)).toMatchObject({ ok: false, rule: 'R10', code: 'piece_inconnue', index: 0 });
  // Balcon et garage : d'où la rue ou le numéro se voient. Refusés.
  expect(checkTourViews('b1', [view('b1', 1, 0), view('b1', 2, 3)], ROOMS)).toMatchObject({ ok: false, rule: 'R500', code: 'piece_exterieure_ou_annexe', index: 1 });
  expect(checkTourViews('b1', [view('b1', 1, 4)], ROOMS)).toMatchObject({ ok: false, rule: 'R500', code: 'piece_exterieure_ou_annexe' });
  // Sans l'attestation, vue par vue : refusé.
  expect(checkTourViews('b1', [view('b1', 1, 0, { attestation: undefined })], ROOMS)).toMatchObject({ ok: false, rule: 'R500', code: 'sans_attestation' });
  expect(VIEW_ATTESTATION_TEXT).toContain('le numéro de la maison');
  expect(VIEW_ATTESTATION_TEXT).toContain('la plaque de la rue');
  // Un nom libre, une image d'un autre bien, un détour, une vue deux fois : refusés.
  expect(checkTourViews('b1', [view('b1', 1, 0, { title: '12 rue des Essais' })], ROOMS)).toMatchObject({ ok: false, code: 'vue_invalide' });
  expect(checkTourViews('b1', [view('b2', 1, 0)], ROOMS)).toMatchObject({ ok: false, code: 'reference_invalide' });
  expect(checkTourViews('b1', [view('b1', 1, 0, { viewRef: 'biens/b1/360/../b2/360/x.jpg' })], ROOMS)).toMatchObject({ ok: false, code: 'reference_invalide' });
  expect(checkTourViews('b1', [view('b1', 1, 0), view('b1', 1, 1)], ROOMS)).toMatchObject({ ok: false, code: 'vue_en_double' });
  expect(checkTourViews('b1', [], ROOMS)).toMatchObject({ ok: false, code: 'vues_invalides' });
  // Ce qui se publie : seulement les vues rattachées, sur le plan du moment.
  const views = [view('b1', 1, 0), view('b1', 2, null)] as never;
  expect(tourViewsOut(views, ROOMS, 1, 1).map((v) => [v.room, v.status])).toEqual([['Séjour', 'publiee'], [null, 'sans_piece']]);
  expect(tourViewsOut(views, ROOMS, 1, 2).map((v) => v.status)).toEqual(['plan_refait', 'sans_piece']);
});

async function setup() {
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  let clock = AT;
  const now = (): Date => new Date((clock += 1000));
  const journal = new SqlJournalStore(db);
  const store = new FicheClient(db, { now });
  const acces = new Acces(db, store, new FicheUnique(db, store, { now }), journal, { now });
  const plans = new PlanLogement(db, acces, journal, { now });
  const published = new Map<string, annonces.PublishedMedia[]>();
  let n = 0;
  const reception = new Reception(db, () => `in-${++n}`, now);
  const visites = new VisitesVirtuelles(db, acces, journal, { current: async (id) => published.get(id) ?? [] }, reception, { now });
  const network = await store.createNetwork('Réseau test');
  const alex = await store.createAgent({ networkId: network.id, firstName: 'Alexandrine', lastName: 'Fictive' });
  const sam = await store.createAgent({ networkId: network.id, firstName: 'Samuel', lastName: 'Inventé' });
  const p = await store.createProperty({ networkId: network.id, agentId: alex.id, reference: 'VT-43', kind: 'home', city: 'Villebrune', priceEur: 210_000, surfaceM2: 64, rooms: 3, status: 'available' });
  const tour = `biens/${p.id}/visite-360`;
  await db.run('INSERT INTO property_sheets (id, property_id, network_id, version, data, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [
    's-1', p.id, network.id, 1, JSON.stringify({ characteristics: { bedrooms: 2, outdoor: ['balcon'], parkingSpaces: 0 }, energy: null, coownership: null, risks: null, media: [{ ref: tour, kind: 'visite_virtuelle', edit: 'aucune' }] }), 'agent:a', '2027-10-01',
  ]);
  const as = (role: 'agent' | 'direction' | 'assistant', userId: string) => ({ role, userId, networkId: network.id }) as never;
  const alexV = as('agent', alex.id);
  const samV = as('agent', sam.id);
  return { db, plans, visites, published, network, p, tour, alexV, samV, as, recon: new ReconnaissanceBien(db) };
}

describeWithSqlite('HX43 · visite à 360 degrés avec contact', () => {
  it('[R499] une vue sans pièce rattachée n’est pas publiée, ni une visite sur un plan refait depuis', async () => {
    const t = await setup();
    // Sans plan du logement, aucune visite.
    expect(await t.visites.save(t.alexV, t.p.id, { tourRef: t.tour, views: [view(t.p.id, 1, 0)] })).toMatchObject({ ok: false, rule: 'R499', code: 'sans_plan' });
    expect((await t.plans.save(t.alexV, t.p.id, { rooms: ROOMS })).ok).toBe(true);
    // Seul l'agent du bien, ou la direction ; une visite que la fiche ne porte pas est refusée.
    expect(await t.visites.save(t.samV, t.p.id, { tourRef: t.tour, views: [view(t.p.id, 1, 0)] })).toMatchObject({ ok: false, rule: 'R16' });
    expect(await t.visites.save(t.alexV, t.p.id, { tourRef: `biens/${t.p.id}/autre`, views: [view(t.p.id, 1, 0)] })).toMatchObject({ ok: false, code: 'visite_inconnue' });
    expect(await t.visites.save(t.alexV, t.p.id, { tourRef: t.tour, views: [view(t.p.id, 1, 3)] })).toMatchObject({ ok: false, rule: 'R500' });

    const saved = await t.visites.save(t.alexV, t.p.id, { tourRef: t.tour, views: [view(t.p.id, 1, 0), view(t.p.id, 2, null), view(t.p.id, 3, 2)] });
    expect(saved).toMatchObject({ ok: true, value: { version: 1, planVersion: 1, publishedViews: 2 } });
    if (!saved.ok) throw new Error('visite');
    expect(saved.value.views.map((v) => [v.room, v.status])).toEqual([['Séjour', 'publiee'], [null, 'sans_piece'], ['Chambre 2', 'publiee']]);

    // Tant que la fiche publiée ne porte pas la visite : rien pour le visiteur.
    expect(await t.visites.publicTour(t.p.id, t.tour)).toBeNull();
    t.published.set(t.p.id, [{ ref: t.tour, kind: 'visite_virtuelle', overlay: null }]);
    const pub = await t.visites.publicTour(t.p.id, t.tour);
    expect(pub?.views).toEqual([{ viewRef: view(t.p.id, 1, 0).viewRef, room: 'Séjour' }, { viewRef: view(t.p.id, 3, 2).viewRef, room: 'Chambre 2' }]);
    expect(JSON.stringify(pub)).not.toContain('Villebrune');

    // Le plan refait : les vues citent l'ancien, plus rien ne se publie tant qu'elles ne sont pas reliées de nouveau.
    expect((await t.plans.save(t.alexV, t.p.id, { rooms: ROOMS.slice(0, 3) })).ok).toBe(true);
    expect(await t.visites.publicTour(t.p.id, t.tour)).toBeNull();
    const cur = await t.visites.current(t.alexV, t.p.id, t.tour);
    expect(cur.ok && cur.value?.views.map((v) => v.status)).toEqual(['plan_refait', 'sans_piece', 'plan_refait']);
    expect(await t.visites.save(t.alexV, t.p.id, { tourRef: t.tour, views: [view(t.p.id, 1, 1)] })).toMatchObject({ ok: true, value: { version: 2, planVersion: 2, publishedViews: 1 } });
    expect((await t.visites.publicTour(t.p.id, t.tour))?.views).toEqual([{ viewRef: view(t.p.id, 1, 1).viewRef, room: 'Chambre 1' }]);

    // Une version rangée ne change plus, ne s'efface pas.
    await expect(t.db.run('UPDATE virtual_tours SET plan_version = 2')).rejects.toThrow();
    await expect(t.db.run('DELETE FROM virtual_tours')).rejects.toThrow();
  });

  it('[R501] un contact pris dans la visite arrive dans la réception, rattaché au bien et à son origine, une seule fois', async () => {
    const t = await setup();
    await t.plans.save(t.alexV, t.p.id, { rooms: ROOMS });
    await t.visites.save(t.alexV, t.p.id, { tourRef: t.tour, views: [view(t.p.id, 1, 0), view(t.p.id, 2, null)] });
    const form = { tourRef: t.tour, viewRef: view(t.p.id, 1, 0).viewRef, submissionId: 'envoi-0001', firstName: 'Lucille', email: 'lucille@exemple.test', message: 'Je voudrais visiter samedi.' };
    // Visite pas encore publiée : refusé.
    expect(await t.visites.contact(t.p.id, form)).toMatchObject({ ok: false, rule: 'R499', code: 'visite_non_publiee' });
    t.published.set(t.p.id, [{ ref: t.tour, kind: 'visite_virtuelle', overlay: null }]);
    // Depuis une vue non publiée, sans coordonnées, ou avec un champ inconnu : refusé.
    expect(await t.visites.contact(t.p.id, { ...form, viewRef: view(t.p.id, 2, null).viewRef })).toMatchObject({ ok: false, code: 'vue_non_publiee' });
    expect(await t.visites.contact(t.p.id, { ...form, email: undefined })).toMatchObject({ ok: false, rule: 'R501', code: 'sans_coordonnees' });
    expect(await t.visites.contact(t.p.id, { ...form, iban: 'x' })).toMatchObject({ ok: false, code: 'contact_invalide' });

    const first = await t.visites.contact(t.p.id, form);
    expect(first).toMatchObject({ ok: true, value: { duplicate: false } });
    if (!first.ok) throw new Error('contact');
    // Le même envoi reçu deux fois : un seul message [R18].
    expect(await t.visites.contact(t.p.id, form)).toEqual({ ok: true, value: { inboundId: first.value.inboundId, duplicate: true } });
    const rows = await t.db.all<{ channel: string; kind: string; property_ref: string; body: string }>('SELECT channel, kind, property_ref, body FROM inbound_messages');
    expect(rows).toEqual([{ channel: 'site', kind: 'form', property_ref: 'VT-43', body: 'Je voudrais visiter samedi.' }]);
    // Le message désigne le bien, reconnu par C02.
    const recognized = await t.recon.recognize(t.network.id, { propertyRef: rows[0]!.property_ref, text: rows[0]!.body } as never);
    expect(recognized).toMatchObject({ status: 'recognized', property: { id: t.p.id } });
    // Son origine : la visite, sa version, la vue et sa pièce ; lue par l'agent du bien seulement.
    expect(await t.visites.origin(t.alexV, first.value.inboundId)).toMatchObject({ ok: true, value: { origin: 'visite_360', propertyId: t.p.id, tourRef: t.tour, tourVersion: 1, viewRef: form.viewRef, room: 'Séjour' } });
    expect(await t.visites.origin(t.samV, first.value.inboundId)).toMatchObject({ ok: false, rule: 'R16' });
    // Le journal ne garde rien du visiteur.
    const events = await t.db.all<{ type: string; data: string }>("SELECT type, data FROM journal WHERE type LIKE 'medias.visite360.%'");
    expect(events.filter((e) => e.type === 'medias.visite360.contact')).toHaveLength(2);
    expect(JSON.stringify(events)).not.toMatch(/lucille|exemple\.test|samedi/i);
  });
});
