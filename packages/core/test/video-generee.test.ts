import { expect, it } from 'vitest';
import { Acces, FicheClient, FicheUnique, SqlJournalStore, annonces, applyMigrations, fromSyncSqlite, type SqlDatabase } from '../src/index.ts';
import { AmenagementsVirtuels, GENERATED_VIDEO_MENTION, VideosGenerees, checkSubtitleTranslations, consentText, generatedVideoPlan, likenessMention } from '../src/medias/index.ts';
import { CertificatsPhotos } from '../src/studio/index.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

const AT = Date.parse('2027-11-05T08:00:00.000Z');
const ref = (p: string, n: number) => `biens/${p}/0000000${n}-0000-4000-8000-000000000000.jpg`;
const orig = (p: string, n: number) => `biens/${p}/originaux/0000000${n}-0000-4000-8000-00000000000a.jpg`;
const vid = (p: string, n: number) => `biens/${p}/videos/0000000${n}-0000-4000-8000-0000000000v0.mp4`;
const sha = (c: string) => c.repeat(64);

it('[R496] [R493] le plan anime chaque photo réelle, fait apparaître le mobilier depuis sa jumelle, et porte « Vidéo générée » partout', () => {
  const real = (r: string) => ({ ref: r, overlay: null, retouchMention: null });
  const staged = (r: string, twin?: string) => ({ ref: r, overlay: 'Aménagement virtuel' as const, retouchMention: null, ...(twin ? { twin } : {}) });
  const plan = generatedVideoPlan([real('r1'), staged('s1', 'r1'), { ...real('r2'), retouchMention: 'Photo retouchée' }, staged('s2'), staged('s3', 'r1')]);
  expect(plan.clips.map((c) => [c.animation, c.photoRef, c.fromRef])).toEqual([
    ['zoom_avant', 'r1', null],
    ['apparition_amenagement', 's1', 'r1'],
    ['panoramique_droite', 'r2', null],
    ['fin_marque', null, null],
  ]);
  // Chaque plan, la fin comprise, porte la mention ; l'image aménagée garde la sienne, la photo retouchée aussi.
  expect(plan.clips.every((c) => c.overlays[0] === GENERATED_VIDEO_MENTION)).toBe(true);
  expect(plan.clips[1]!.overlays).toEqual([GENERATED_VIDEO_MENTION, 'Aménagement virtuel']);
  expect(plan.clips[2]!.overlays).toEqual([GENERATED_VIDEO_MENTION, 'Photo retouchée']);
  expect(plan.totalSeconds).toBe(16);
  // Une image aménagée seule, ou en premier : rien ne part.
  expect(generatedVideoPlan([staged('s1', 'r1')]).clips).toEqual([]);
  // Au plus 12 plans, la fin comprise.
  expect(generatedVideoPlan(Array.from({ length: 20 }, (_, i) => real(`r${i}`))).clips).toHaveLength(12);
  expect(likenessMention(true, false)).toBe('Voix de synthèse de l’agent, avec son accord écrit');
  expect(likenessMention(false, false)).toBeNull();
});

it('[R497] [R46] chaque sous-titre traduit garde ses nombres, et aucune voie nommée ne passe, dans aucune langue', () => {
  const fr = ['Séjour lumineux de 64 m²', 'Chambres au calme'];
  expect(checkSubtitleTranslations(fr, new Map([['en', ['Bright living room of 64 m²', 'Quiet bedrooms']]]))).toEqual([]);
  const bad = checkSubtitleTranslations(fr, new Map([['en', ['Bright living room of 46 m²', 'Quiet bedrooms on Test Street']]]));
  expect(bad.map((p) => p.line)).toEqual([0, 1]);
  expect(bad[0]!.problems).toContain('chiffre_manquant');
  expect(bad[1]!.problems).toContain('adresse');
  expect(checkSubtitleTranslations(fr, new Map([['en', ['Bright living room of 64 m²']]]))).toEqual([{ language: 'en', line: -1, problems: ['texte_vide'] }]);
  // Chaque ligne passe seule, mais à la suite elles disent une adresse : refusé.
  const cut = checkSubtitleTranslations(['Au 12', 'Pièce lumineuse', 'Vue dégagée'], new Map([['en', ['At 12', 'chemin', 'des Essais']]]));
  expect(cut).toEqual([{ language: 'en', line: null, problems: expect.arrayContaining(['adresse']) }]);
  const cutStreet = checkSubtitleTranslations(['Au 12', 'Pièce lumineuse'], new Map([['en', ['At 12', 'Test Street']]]));
  expect(cutStreet.some((p) => p.problems.includes('adresse'))).toBe(true);
  // Un « A » en tête de ligne n'est pas une lettre de classe ajoutée.
  expect(checkSubtitleTranslations(['Séjour lumineux', 'Une cuisine équipée'], new Map([['en', ['Bright living room', 'A fitted kitchen']]]))).toEqual([]);
});

async function setup() {
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  let clock = AT;
  const now = (): Date => new Date((clock += 1000));
  const journal = new SqlJournalStore(db);
  const store = new FicheClient(db, { now });
  const acces = new Acces(db, store, new FicheUnique(db, store, { now }), journal, { now });
  let t = 0;
  const stored = new Set<string>();
  const certs = new CertificatsPhotos(db, acces, journal, { has: async (r: string) => stored.has(r) }, { now, newToken: () => (++t).toString(16).padStart(32, 'e') });
  const amenagements = new AmenagementsVirtuels(db, acces, journal, { now });
  const medias = new annonces.MediasBien(db, acces, journal, { now });
  const langues = new annonces.AnnoncesTraduites(db, acces, journal, { now });
  const videos = new VideosGenerees(db, acces, journal, certs, medias, langues, { now });
  const network = await store.createNetwork('Réseau test');
  const alex = await store.createAgent({ networkId: network.id, firstName: 'Alexandrine', lastName: 'Fictive' });
  const sam = await store.createAgent({ networkId: network.id, firstName: 'Samuel', lastName: 'Inventé' });
  const p = await store.createProperty({ networkId: network.id, agentId: alex.id, reference: 'VG-42', kind: 'home', city: 'Villebrune', priceEur: 210_000, surfaceM2: 64, rooms: 3, status: 'available' });
  const q = await store.createProperty({ networkId: network.id, agentId: sam.id, reference: 'VG-43', kind: 'home', city: 'Villebrune', priceEur: 150_000, surfaceM2: 40, rooms: 2, status: 'available' });
  const media = (id: string) => [
    { ref: ref(id, 1), kind: 'photo', edit: 'lumiere_cadrage' },
    { ref: ref(id, 2), kind: 'photo', edit: 'amenagement_virtuel' },
    { ref: ref(id, 3), kind: 'photo', edit: 'lumiere_cadrage' },
    { ref: vid(id, 1), kind: 'video', edit: 'aucune' },
    { ref: vid(id, 2), kind: 'video', edit: 'aucune' },
  ];
  let s = 0;
  const sheet = async (id: string, version: number, m: unknown[]) =>
    db.run('INSERT INTO property_sheets (id, property_id, network_id, version, data, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [
      `s-${++s}`, id, network.id, version, JSON.stringify({ characteristics: { bedrooms: 2, outdoor: [], parkingSpaces: 0 }, energy: null, coownership: null, risks: null, media: m }), 'agent:a', '2027-10-01',
    ]);
  await sheet(p.id, 1, media(p.id));
  await sheet(q.id, 1, media(q.id));
  const as = (role: 'agent' | 'direction' | 'assistant', userId: string) => ({ role, userId, networkId: network.id }) as never;
  const alexV = as('agent', alex.id);
  const samV = as('agent', sam.id);
  for (const [prop, viewer] of [[p, alexV], [q, samV]] as const) {
    for (let n = 1; n <= 3; n += 1) stored.add(ref(prop.id, n)).add(orig(prop.id, n));
    const k = prop === p ? 0 : 4;
    const one = (n: number, o: string, operations: unknown[]) =>
      certs.record(viewer, prop.id, { resultRef: ref(prop.id, n), resultSha256: sha(String(n + k)), originalRef: orig(prop.id, n), originalSha256: sha(o), operations, processedOn: 'appareil' });
    const lumiere = [{ op: 'exposition', ev: 0.4 }];
    const r = [await one(1, k ? 'c' : 'a', lumiere), await one(2, k ? 'c' : 'a', []), await one(3, k ? 'd' : 'b', lumiere)];
    if (!r.every((x) => x.ok)) throw new Error('certificats ' + JSON.stringify(r));
    const d = await amenagements.declare(viewer, prop.id, { stagedRef: ref(prop.id, 2), realRef: ref(prop.id, 1), changes: [{ kind: 'meubler', style: 'scandinave' }] });
    if (!d.ok) throw new Error('aménagement');
  }
  await langues.declareLanguages(alexV, alex.id, ['en', 'ar']);
  return { db, videos, langues, network, alex, sam, p, q, as, alexV, samV, sheet, media };
}

const SUBS = { fr: ['Séjour lumineux de 64 m²', 'Le mobilier apparaît : aménagement virtuel'], en: ['Bright living room of 64 m²', 'The furniture appears: virtual staging'] };

describeWithSqlite('HX42 · vidéo depuis les photos, voix off et avatar', () => {
  it('[R495] [R496] [R497] Jamais vu : la voix de l’agent seulement avec son accord écrit, la mention sur la vidéo, les sous-titres dans ses langues', async () => {
    const t = await setup();
    const plan = await t.videos.plan(t.alexV, t.p.id);
    if (!plan.ok) throw new Error('plan');
    expect(plan.value.languages).toEqual(['fr', 'en', 'ar']);
    expect(plan.value.voice).toBe(false);
    expect(plan.value.plan.clips.map((c) => c.animation)).toEqual(['zoom_avant', 'apparition_amenagement', 'panoramique_droite', 'fin_marque']);
    const base = { videoRef: vid(t.p.id, 1), videoSha256: sha('f'), durationSeconds: 16, planSha256: plan.value.planSha256, subtitles: SUBS, caption: 'Visite en images', processedOn: 'appareil' };

    // Sans accord écrit : aucune voix.
    const voiceInput = { ...base, voice: true, voiceSampleSha256: sha('c'), mentions: [GENERATED_VIDEO_MENTION, likenessMention(true, false)] };
    expect(await t.videos.record(t.alexV, t.p.id, voiceInput)).toMatchObject({ ok: false, rule: 'R495', code: 'sans_accord' });
    // L'accord : le texte recopié à l'identique, par l'agent lui-même ; la direction ne le donne pas pour lui.
    const text = consentText('voix', 'Alexandrine', 'Fictive');
    expect(await t.videos.consentTextFor(t.alexV, 'voix')).toEqual({ ok: true, value: text });
    expect(await t.videos.giveConsent(t.as('direction', 'dir-1'), { kind: 'voix', sampleSha256: sha('c'), acceptedText: text, processedOn: 'appareil' })).toMatchObject({ ok: false, rule: 'R495', code: 'pas_l_agent_lui_meme' });
    expect(await t.videos.giveConsent(t.alexV, { kind: 'voix', sampleSha256: sha('c'), acceptedText: 'oui', processedOn: 'appareil' })).toMatchObject({ ok: false, rule: 'R495', code: 'texte_non_accepte' });
    expect(await t.videos.giveConsent(t.alexV, { kind: 'voix', sampleSha256: sha('c'), audio: 'xx', acceptedText: text, processedOn: 'appareil' })).toMatchObject({ ok: false, rule: 'R130', code: 'fichier_refuse' });
    const consent = await t.videos.giveConsent(t.alexV, { kind: 'voix', sampleSha256: sha('c'), acceptedText: text, processedOn: 'appareil' });
    expect(consent).toMatchObject({ ok: true, value: { kind: 'voix', sampleSha256: sha('c'), textVersion: 'HX42-2026-11-08', revokedAt: null } });
    if (!consent.ok) throw new Error('accord');
    // Un autre enregistrement que celui de l'accord : refusé. Pas d'avatar sans accord pour l'avatar.
    expect(await t.videos.record(t.alexV, t.p.id, { ...voiceInput, voiceSampleSha256: sha('d') })).toMatchObject({ ok: false, rule: 'R495', code: 'enregistrement_sans_accord' });
    expect(await t.videos.record(t.alexV, t.p.id, { ...voiceInput, avatar: true, avatarSampleSha256: sha('c') })).toMatchObject({ ok: false, rule: 'R495', code: 'sans_accord' });
    // La direction range une vidéo du bien, mais jamais avec la voix de l'agent.
    expect(await t.videos.record(t.as('direction', 'dir-1'), t.p.id, voiceInput)).toMatchObject({ ok: false, rule: 'R495', code: 'pas_l_agent_lui_meme' });
    // La mention « Vidéo générée » et celle de la voix de synthèse, sinon refusé.
    expect(await t.videos.record(t.alexV, t.p.id, { ...voiceInput, mentions: [GENERATED_VIDEO_MENTION] })).toMatchObject({ ok: false, rule: 'R496', code: 'mention_absente' });
    expect(await t.videos.record(t.alexV, t.p.id, { ...base, mentions: [] })).toMatchObject({ ok: false, rule: 'R496', code: 'mention_absente' });
    // Une langue que l'agent ne parle pas n'est pas ouverte.
    expect(await t.videos.record(t.alexV, t.p.id, { ...voiceInput, subtitles: { ...SUBS, el: ['Φωτεινό σαλόνι 64 m²', 'Έπιπλα'] } })).toMatchObject({ ok: false, rule: 'R497', code: 'langue_non_ouverte' });

    const ok = await t.videos.record(t.alexV, t.p.id, voiceInput);
    expect(ok).toMatchObject({ ok: true, value: { mentions: [GENERATED_VIDEO_MENTION, 'Voix de synthèse de l’agent, avec son accord écrit'], languages: ['fr', 'en'], voice: true, avatar: false } });
    expect(await t.videos.diffusable(t.p.id, vid(t.p.id, 1))).toEqual({ ok: true });
    const row = await t.db.first<{ mentions: string; voice_consent_id: string }>('SELECT mentions, voice_consent_id FROM generated_videos WHERE video_ref = ?', [vid(t.p.id, 1)]);
    expect(row).toEqual({ mentions: JSON.stringify([GENERATED_VIDEO_MENTION, 'Voix de synthèse de l’agent, avec son accord écrit']), voice_consent_id: consent.value.id });
    expect(await t.videos.record(t.alexV, t.p.id, voiceInput)).toMatchObject({ ok: false, code: 'deja_rangee' });

    // Le bien repris par un autre agent : la voix d'Alexandrine ne part plus avec lui ; rendu, elle repart.
    await t.db.run('UPDATE properties SET agent_id = ? WHERE id = ?', [t.sam.id, t.p.id]);
    expect(await t.videos.diffusable(t.p.id, vid(t.p.id, 1))).toEqual({ ok: false, code: 'accord_hors_agent_du_bien' });
    await t.db.run('UPDATE properties SET agent_id = ? WHERE id = ?', [t.alex.id, t.p.id]);
    // Alexandrine partie du réseau : plus de diffusion non plus.
    await t.db.run("UPDATE agents SET status = 'left' WHERE id = ?", [t.alex.id]);
    expect(await t.videos.diffusable(t.p.id, vid(t.p.id, 1))).toEqual({ ok: false, code: 'accord_hors_agent_du_bien' });
    await t.db.run("UPDATE agents SET status = 'active' WHERE id = ?", [t.alex.id]);
    expect(await t.videos.diffusable(t.p.id, vid(t.p.id, 1))).toEqual({ ok: true });

    // L'accord retiré : la vidéo n'est plus diffusable, et aucune nouvelle ne prend la voix.
    expect(await t.videos.revokeConsent(t.samV, consent.value.id)).toMatchObject({ ok: false, code: 'accord_inconnu' });
    expect(await t.videos.revokeConsent(t.alexV, consent.value.id)).toMatchObject({ ok: true, value: { revokedAt: expect.any(String) } });
    expect(await t.videos.diffusable(t.p.id, vid(t.p.id, 1))).toEqual({ ok: false, code: 'accord_retire' });
    expect(await t.videos.record(t.alexV, t.p.id, { ...voiceInput, videoRef: vid(t.p.id, 2) })).toMatchObject({ ok: false, rule: 'R495', code: 'sans_accord' });
    expect((await t.videos.consents(t.alexV)).ok).toBe(true);
    await expect(t.db.run('DELETE FROM agent_likeness_consents')).rejects.toThrow();
    await expect(t.db.run('DELETE FROM agent_likeness_revocations')).rejects.toThrow();
    // Le journal ne garde aucun texte de sous-titre.
    const events = await t.db.all<{ data: string }>("SELECT data FROM journal WHERE type LIKE 'medias.%'");
    expect(events.length).toBeGreaterThan(0);
    expect(events.some((e) => e.data.includes('Séjour'))).toBe(false);
  });

  it('[R495] la voix d’un agent ne sert jamais pour le bien d’un autre', async () => {
    const t = await setup();
    const text = consentText('avatar', 'Alexandrine', 'Fictive');
    const c = await t.videos.giveConsent(t.alexV, { kind: 'avatar', sampleSha256: sha('a'), acceptedText: text, processedOn: 'appareil' });
    expect(c.ok).toBe(true);
    // Sam, sur son bien, ne peut prendre l'avatar d'Alexandrine ; et Alexandrine ne voit pas le bien de Sam.
    const plan = await t.videos.plan(t.samV, t.q.id);
    if (!plan.ok) throw new Error('plan');
    expect(plan.value.avatar).toBe(false);
    // Sam ne déclare aucune langue : le français seul, l'anglais n'est plus ouvert d'office (AU113).
    expect(plan.value.languages).toEqual(['fr']);
    const input = { videoRef: vid(t.q.id, 1), videoSha256: sha('f'), durationSeconds: 16, planSha256: plan.value.planSha256, avatar: true, avatarSampleSha256: sha('a'), mentions: [GENERATED_VIDEO_MENTION, likenessMention(false, true)], subtitles: { fr: ['Deux pièces'] }, caption: 'Visite', processedOn: 'appareil' };
    expect(await t.videos.record(t.samV, t.q.id, input)).toMatchObject({ ok: false, rule: 'R495', code: 'sans_accord' });
    expect(await t.videos.record(t.alexV, t.q.id, input)).toMatchObject({ ok: false, rule: 'R16' });
  });

  it('[R46] [R497] [R130] une adresse exacte est refusée dans la voix off, les sous-titres et la légende ; rien ne passe par le serveur', async () => {
    const t = await setup();
    const plan = await t.videos.plan(t.alexV, t.p.id);
    if (!plan.ok) throw new Error('plan');
    const base = { videoRef: vid(t.p.id, 1), videoSha256: sha('f'), durationSeconds: 16, planSha256: plan.value.planSha256, mentions: [GENERATED_VIDEO_MENTION], subtitles: SUBS, caption: 'Visite en images', processedOn: 'appareil' };
    expect(await t.videos.record(t.alexV, t.p.id, { ...base, subtitles: { fr: ['Au 12 rue des Essais', 'Séjour lumineux'] } })).toMatchObject({ ok: false, rule: 'R46', code: 'texte_refuse' });
    // Coupée entre deux sous-titres, l'adresse est lue d'un bloc.
    expect(await t.videos.record(t.alexV, t.p.id, { ...base, subtitles: { fr: ['Au 12', 'rue des Essais'] } })).toMatchObject({ ok: false, rule: 'R46' });
    expect(await t.videos.record(t.alexV, t.p.id, { ...base, caption: 'Visite au 3 avenue Fictive' })).toMatchObject({ ok: false, rule: 'R46' });
    const en = await t.videos.record(t.alexV, t.p.id, { ...base, subtitles: { fr: SUBS.fr, en: ['Bright living room of 64 m² on Test Street', SUBS.en[1]] } });
    expect(en).toMatchObject({ ok: false, rule: 'R497', code: 'traduction_refusee', problems: [{ language: 'en', line: 0 }] });
    expect(await t.videos.record(t.alexV, t.p.id, { ...base, video: 'AAAA' })).toMatchObject({ ok: false, rule: 'R130', code: 'fichier_refuse' });
    expect(await t.videos.record(t.alexV, t.p.id, { ...base, processedOn: 'serveur' })).toMatchObject({ ok: false, rule: 'R130', code: 'traitement_hors_appareil' });
    // Une vidéo hors de la fiche, ou d'un plan de photos périmé : refusée.
    expect(await t.videos.record(t.alexV, t.p.id, { ...base, videoRef: 'biens/autre.mp4' })).toMatchObject({ ok: false, code: 'video_inconnue' });
    expect(await t.videos.record(t.alexV, t.p.id, { ...base, planSha256: sha('0') })).toMatchObject({ ok: false, code: 'plan_perime' });
    // Sans voix ni avatar, la direction range la vidéo, avec sa seule mention.
    const ok = await t.videos.record(t.as('direction', 'dir-1'), t.p.id, base);
    expect(ok).toMatchObject({ ok: true, value: { mentions: [GENERATED_VIDEO_MENTION], voice: false, avatar: false } });
    // Les photos changent : la vidéo ne suit plus le plan et n'est plus diffusable.
    await t.sheet(t.p.id, 2, t.media(t.p.id).filter((m) => m.ref !== ref(t.p.id, 3)));
    expect(await t.videos.diffusable(t.p.id, vid(t.p.id, 1))).toEqual({ ok: false, code: 'photos_changees' });
    // La base refuse une vidéo sans la mention, et ne laisse rien s'effacer.
    await expect(t.db.run("UPDATE generated_videos SET mentions = '[]'")).rejects.toThrow();
    await expect(t.db.run('DELETE FROM generated_videos')).rejects.toThrow();
  });
});
