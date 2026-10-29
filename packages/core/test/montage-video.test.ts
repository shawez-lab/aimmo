import { expect, it } from 'vitest';
import { Acces, FicheClient, FicheUnique, SqlJournalStore, annonces, applyMigrations, fromSyncSqlite, type SqlDatabase } from '../src/index.ts';
import { MAX_PLAN_CLIPS, Montages, montageTemplate, type MusicLibrary } from '../src/studio/index.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

const { MediasBien, publicTextProblems } = annonces;
type Sheet = Parameters<typeof montageTemplate>[0]['sheet'];

const sheetOf = (c: Record<string, unknown>, media: unknown[] = [], energyClass: string | null = 'D'): Sheet =>
  ({
    characteristics: { bedrooms: null, floor: null, floorsTotal: null, buildYear: null, heating: null, outdoor: [], landM2: null, parkingSpaces: null, elevator: null, ...c },
    energy: energyClass ? { energyClass, climateClass: energyClass } : null,
    coownership: null,
    risks: null,
    media,
  }) as unknown as Sheet;

it('[R10] [R46] le modèle suit le plan de tournage, ses sous-titres viennent de la fiche seule, sans adresse', () => {
  const t = montageTemplate({ kind: 'home', surfaceM2: 72, rooms: 3, sheet: sheetOf({ bedrooms: 2, outdoor: ['balcon', 'jardin'], parkingSpaces: 1, elevator: true }) });
  expect(t.clips.map((c) => [c.kind, c.source, c.subtitle])).toEqual([
    ['accroche', 'rooms', 'Logement de 72 m² · DPE D'],
    ['plan', 'rooms', '3 pièces principales'],
    ['plan', 'bedrooms', '2 chambres'],
    ['plan', 'outdoor', 'Balcon'],
    ['plan', 'outdoor', 'Jardin'],
    ['plan', 'parkingSpaces', '1 place de stationnement'],
    ['plan', 'elevator', 'Ascenseur'],
    ['fin_marque', 'marque', null],
  ]);
  expect(t.clips.map((c) => c.order)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  for (const c of t.clips) if (c.subtitle) expect(publicTextProblems(c.subtitle), c.subtitle).toEqual([]);
  expect(t.neverFilm.length).toBeGreaterThan(3);
  // Rien d'inventé : sans chambre, extérieur ni surface dits, aucun plan ni chiffre de plus.
  const bare = montageTemplate({ kind: 'home', surfaceM2: null, rooms: null, sheet: sheetOf({}, [], null) });
  expect(bare.clips.map((c) => [c.kind, c.subtitle])).toEqual([
    ['accroche', 'Logement'],
    ['fin_marque', null],
  ]);
  const land = montageTemplate({ kind: 'land', surfaceM2: 1200, rooms: null, sheet: sheetOf({ landM2: 1200 }, [], null) });
  expect(land.clips.map((c) => c.subtitle)).toEqual(['Terrain de 1 200 m²', 'Terrain de 1 200 m²', null]);
});

it('le modèle tient en 10 minutes de montage, même pour le plus grand bien', () => {
  const t = montageTemplate({ kind: 'home', surfaceM2: 72, rooms: 3, sheet: sheetOf({ bedrooms: 2, outdoor: ['balcon', 'jardin'], parkingSpaces: 1, elevator: true }) });
  // 8 plans de 4 s ; 7 plans à choisir, la musique, relire, valider : 10 gestes de 20 s, et deux visionnages.
  expect(t).toMatchObject({ totalSeconds: 32, gestures: 10 });
  expect(t.estimatedMinutes).toBe(Math.ceil((10 * 20 + 32 * 2) / 60));
  expect(t.estimatedMinutes).toBe(5);
  const biggest = montageTemplate({
    kind: 'home',
    surfaceM2: 400,
    rooms: 12,
    sheet: sheetOf({ bedrooms: 8, outdoor: ['balcon', 'terrasse', 'jardin', 'cour'], landM2: 3000, parkingSpaces: 4, elevator: true }),
  });
  expect(biggest.clips.filter((c) => c.kind === 'plan').length).toBeLessThanOrEqual(MAX_PLAN_CLIPS);
  expect(biggest.estimatedMinutes).toBeLessThanOrEqual(10);
  expect(biggest.totalSeconds).toBeLessThanOrEqual(60);
});

const VIDEO = (p: string) => `biens/${p}/0000000a-0000-4000-8000-000000000000.mp4`;
const PHOTO = (p: string) => `biens/${p}/0000000b-0000-4000-8000-000000000000.jpg`;
const SHA = 'e'.repeat(64);

async function setup() {
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  let clock = Date.parse('2027-10-08T08:00:00.000Z');
  const now = (): Date => new Date((clock += 1000));
  const journal = new SqlJournalStore(db);
  const store = new FicheClient(db, { now });
  const acces = new Acces(db, store, new FicheUnique(db, store, { now }), journal, { now });
  const medias = new MediasBien(db, acces, journal, { now });
  // La bibliothèque inventée : une musique sous licence en cours, une expirée (null), une inconnue (null).
  const library: MusicLibrary & { asked: string[]; ccBy: boolean } = {
    asked: [],
    ccBy: false,
    licensedMusic: async (networkId: string, id: string) => {
      library.asked.push(id);
      if (networkId !== network.id) return null;
      if (id !== 'musique-sous-licence') return null;
      return library.ccBy ? { id, licence: 'cc_by', attribution: 'Musique : Camille Inventée, CC BY 4.0' } : { id };
    },
  };
  const montages = new Montages(db, acces, journal, medias, library, { now });
  const network = await store.createNetwork('Réseau test');
  const alex = await store.createAgent({ networkId: network.id, firstName: 'Alexandrine', lastName: 'Fictive' });
  const sam = await store.createAgent({ networkId: network.id, firstName: 'Samuel', lastName: 'Inventé' });
  // La même musique, rangée dans la bibliothèque du réseau : relue au moment de publier [R133].
  await db.run(
    "INSERT INTO licensed_assets (id, network_id, kind, title, source, licence, attribution, valid_until, proof_ref, recorded_by, recorded_at) VALUES ('musique-sous-licence', ?, 'musique', 'Air inventé', 'achat_unitaire', 'licence_achetee', NULL, '2027-12-31', 'bibliotheque/preuve.pdf', 'direction:d1', '2027-10-01')",
    [network.id],
  );
  const p = await store.createProperty({ networkId: network.id, agentId: alex.id, reference: 'VID-3', kind: 'home', city: 'Villebrune', priceEur: 230_000, surfaceM2: 72, rooms: 3, status: 'available' });
  const sheet = sheetOf({ bedrooms: 2, outdoor: ['balcon'] }, [
    { ref: VIDEO(p.id), kind: 'video', edit: 'aucune' },
    { ref: PHOTO(p.id), kind: 'photo', edit: 'aucune' },
  ]);
  await db.run("INSERT INTO property_sheets (id, property_id, network_id, version, data, created_by, created_at) VALUES ('s-1', ?, ?, 1, ?, 'agent:a', '2027-10-01')", [p.id, network.id, JSON.stringify(sheet)]);
  const as = (role: 'agent' | 'direction' | 'compliance' | 'assistant', userId: string) => ({ role, userId, networkId: network.id }) as never;
  const input = (over: Record<string, unknown> = {}) => ({
    videoRef: VIDEO(p.id),
    videoSha256: SHA,
    durationSeconds: 24,
    subtitles: ['Logement de 72 m² · DPE D', '3 pièces principales', '2 chambres', 'Balcon'],
    caption: 'Trois pièces lumineux avec balcon.',
    musicId: 'musique-sous-licence',
    processedOn: 'appareil',
    ...over,
  });
  return { db, medias, montages, library, network, alex, sam, p, as, input, setClock: (iso: string) => (clock = Date.parse(iso)) };
}

describeWithSqlite('X03 · montage vidéo sur l’appareil', () => {
  it('un montage contrôlé est rangé par sa description seule, et la vidéo devient publiable', async () => {
    const t = await setup();
    const alex = t.as('agent', t.alex.id);
    const tpl = await t.montages.template(alex, t.p.id);
    expect(tpl).toMatchObject({ ok: true, value: { clips: expect.any(Array) } });
    expect(await t.medias.publishable(t.p.id, 1)).toEqual([{ ref: PHOTO(t.p.id), kind: 'photo', overlay: null }]);
    const r = await t.montages.record(alex, t.p.id, t.input());
    expect(r).toMatchObject({ ok: true, value: { videoRef: VIDEO(t.p.id), durationSeconds: 24, musicId: 'musique-sous-licence' } });
    expect((await t.medias.publishable(t.p.id, 1)).map((m) => m.ref)).toEqual([VIDEO(t.p.id), PHOTO(t.p.id)]);
    const row = await t.db.first<Record<string, unknown>>('SELECT * FROM video_montages');
    expect(row).toMatchObject({ video_ref: VIDEO(t.p.id), video_sha256: SHA, processed_on: 'appareil', music_id: 'musique-sous-licence', duration_s: 24 });
    // Au journal : le nombre de plans, la durée, s'il y a une musique ; jamais un texte.
    const ev = await t.db.all<{ data: string }>("SELECT data FROM journal WHERE type = 'studio.montage.range'");
    expect(JSON.parse(ev[0]!.data)).toEqual({ clips: 5, seconds: 24, music: true });
  });

  it('[R133] une musique sans licence rangée, expirée ou inconnue est refusée ; sans musique, c’est admis', async () => {
    const t = await setup();
    const alex = t.as('agent', t.alex.id);
    for (const musicId of ['musique-expiree', 'piste-du-commerce', '', 12]) {
      expect(await t.montages.record(alex, t.p.id, t.input({ musicId })), String(musicId)).toEqual({ ok: false, rule: 'R133', code: 'musique_sans_licence' });
    }
    expect(await t.db.all('SELECT id FROM video_montages')).toEqual([]);
    // Après ce refus, un contrôle de texte fait à part ne rend pas la vidéo publiable : il lui faut son montage.
    expect(await t.medias.checkVideoText(alex, t.p.id, VIDEO(t.p.id), { subtitles: ['2 chambres'], caption: 'Visite' })).toEqual({ ok: true });
    expect((await t.medias.publishable(t.p.id, 1)).map((m) => m.kind)).toEqual(['photo']);
    expect(await t.montages.record(alex, t.p.id, t.input({ musicId: null }))).toMatchObject({ ok: true, value: { musicId: null } });
    expect(t.library.asked).toEqual(['musique-expiree', 'piste-du-commerce', '']);
  });

  it('[R133] une musique CC BY exige la mention de son auteur dans la légende', async () => {
    const t = await setup();
    const alex = t.as('agent', t.alex.id);
    t.library.ccBy = true;
    expect(await t.montages.record(alex, t.p.id, t.input())).toEqual({ ok: false, rule: 'R133', code: 'mention_auteur_absente' });
    expect((await t.medias.publishable(t.p.id, 1)).map((m) => m.kind)).toEqual(['photo']);
    expect((await t.montages.record(alex, t.p.id, t.input({ caption: 'Trois pièces lumineux avec balcon. Musique : Camille Inventée, CC BY 4.0' }))).ok).toBe(true);
  });

  it('[R133] une musique retirée ou expirée après le montage retire la vidéo des médias à publier', async () => {
    const t = await setup();
    const alex = t.as('agent', t.alex.id);
    expect((await t.montages.record(alex, t.p.id, t.input())).ok).toBe(true);
    await t.medias.checkVideoText(alex, t.p.id, VIDEO(t.p.id), { subtitles: t.input().subtitles, caption: t.input().caption });
    expect((await t.medias.publishable(t.p.id, 1)).map((m) => m.kind)).toEqual(['video', 'photo']);
    // La licence expire : le lendemain de son dernier jour, à Paris, la vidéo ne part plus.
    t.setClock('2027-12-31T22:30:00.000Z');
    expect((await t.medias.publishable(t.p.id, 1)).map((m) => m.kind)).toEqual(['video', 'photo']);
    t.setClock('2027-12-31T23:30:00.000Z');
    expect((await t.medias.publishable(t.p.id, 1)).map((m) => m.kind)).toEqual(['photo']);
    t.setClock('2027-10-09T08:00:00.000Z');
    expect((await t.medias.publishable(t.p.id, 1)).map((m) => m.kind)).toEqual(['video', 'photo']);
    // La direction la retire : la vidéo sort aussitôt.
    await t.db.run("INSERT INTO licensed_asset_withdrawals (id, asset_id, reason, withdrawn_by, withdrawn_at) VALUES ('w-1', 'musique-sous-licence', 'licence_retiree', 'direction:d1', '2027-10-09')");
    expect((await t.medias.publishable(t.p.id, 1)).map((m) => m.kind)).toEqual(['photo']);
  });

  it('[R46] [R132] un sous-titre ou une légende qui porte une adresse est refusé, et la vidéo ne peut pas être publiée', async () => {
    const t = await setup();
    const alex = t.as('agent', t.alex.id);
    const r = await t.montages.record(alex, t.p.id, t.input({ subtitles: ['Au 12', 'rue des Essais', '2 chambres'] }));
    expect(r).toMatchObject({ ok: false, rule: 'R46', code: 'texte_refuse' });
    expect(await t.montages.record(alex, t.p.id, t.input({ caption: 'Visite au 8 avenue Imaginaire' }))).toMatchObject({ ok: false, rule: 'R46', code: 'texte_refuse' });
    expect(await t.db.all('SELECT id FROM video_montages')).toEqual([]);
    expect((await t.medias.publishable(t.p.id, 1)).map((m) => m.kind)).toEqual(['photo']);
    const ev = await t.db.all<{ data: string }>("SELECT data FROM journal WHERE type = 'studio.montage.refuse'");
    // Le refus au journal ne porte jamais le texte refusé [R13].
    expect(ev.map((e) => JSON.parse(e.data))).toEqual([
      { rule: 'R46', code: 'texte_refuse' },
      { rule: 'R46', code: 'texte_refuse' },
    ]);
    expect(ev.map((e) => e.data).join('')).not.toMatch(/Essais|Imaginaire/);
  });

  it('[R130] aucun fichier vidéo ne passe par le serveur, seule sa référence ; le montage se fait sur l’appareil', async () => {
    const t = await setup();
    const alex = t.as('agent', t.alex.id);
    for (const key of ['file', 'data', 'base64', 'contenu', 'video', 'bytes']) {
      expect(await t.montages.record(alex, t.p.id, { ...t.input(), [key]: 'AAAA' }), key).toEqual({ ok: false, rule: 'R130', code: 'fichier_refuse' });
    }
    expect(await t.montages.record(alex, t.p.id, t.input({ processedOn: 'serveur' }))).toEqual({ ok: false, rule: 'R130', code: 'traitement_hors_appareil' });
    expect(await t.montages.record(alex, t.p.id, { ...t.input(), autre: 1 })).toEqual({ ok: false, rule: 'R10', code: 'saisie_invalide' });
    // Une référence qui n'est pas une vidéo de la fiche.
    expect(await t.montages.record(alex, t.p.id, t.input({ videoRef: PHOTO(t.p.id) }))).toEqual({ ok: false, rule: 'R10', code: 'video_inconnue' });
    expect(await t.montages.record(alex, t.p.id, t.input({ videoRef: `biens/${t.p.id}/0000000c-0000-4000-8000-000000000000.mp4` }))).toEqual({ ok: false, rule: 'R10', code: 'video_inconnue' });
    expect(await t.montages.record(alex, t.p.id, t.input({ videoSha256: 'x' }))).toEqual({ ok: false, rule: 'R10', code: 'empreinte_invalide' });
    // Plus long que le modèle (20 s) et sa marge : refusé ; zéro aussi.
    expect(await t.montages.record(alex, t.p.id, t.input({ durationSeconds: 120 }))).toEqual({ ok: false, rule: 'R10', code: 'duree_invalide' });
    expect(await t.montages.record(alex, t.p.id, t.input({ durationSeconds: 0 }))).toEqual({ ok: false, rule: 'R10', code: 'duree_invalide' });
    expect(await t.db.all('SELECT id FROM video_montages')).toEqual([]);
    await expect(
      t.db.run("INSERT INTO video_montages (id, property_id, network_id, video_ref, video_sha256, template_sha256, clips_count, duration_s, music_id, processed_on, recorded_by, recorded_at) VALUES ('x', ?, ?, 'v', ?, ?, 3, 20, NULL, 'serveur', 'a', 'b')", [t.p.id, t.network.id, SHA, SHA]),
    ).rejects.toThrow();
  });

  it('[R16] [R17] seuls l’agent du bien et la direction rangent un montage ; il ne change plus', async () => {
    const t = await setup();
    expect(await t.montages.record(t.as('agent', t.sam.id), t.p.id, t.input())).toMatchObject({ ok: false, rule: 'R16' });
    expect(await t.montages.template(t.as('agent', t.sam.id), t.p.id)).toMatchObject({ ok: false, rule: 'R16' });
    expect(await t.montages.record(t.as('compliance', 'c1'), t.p.id, t.input())).toEqual({ ok: false, rule: 'R16', code: 'role' });
    expect(await t.montages.record(t.as('direction', 'd1'), t.p.id, t.input())).toMatchObject({ ok: true });
    expect(await t.montages.record(t.as('agent', t.alex.id), t.p.id, t.input())).toEqual({ ok: false, rule: 'R10', code: 'deja_rangee' });
    await expect(t.db.run('DELETE FROM video_montages')).rejects.toThrow(/rien ne s'efface/);
    await expect(t.db.run('UPDATE video_montages SET duration_s = 1')).rejects.toThrow(/ne change plus/);
  });
});
