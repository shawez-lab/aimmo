// HX51 · La publication relit chaque vidéo générée [R498].
import { expect, it } from 'vitest';
import { AnnoncesTraduites, CHANNELS, MediasBien, Publication } from '../src/annonces/index.ts';
import { GENERATED_VIDEO_MENTION, VideosGenerees, consentText, likenessMention } from '../src/medias/index.ts';
import { CertificatsPhotos } from '../src/studio/index.ts';
import { FakeChannel, setupAnnonce } from './annonces-jeu.ts';
import { describeWithSqlite } from './sqlite.ts';

const sha = (c: string) => c.repeat(64);

async function setup() {
  const t = await setupAnnonce();
  const video = `biens/${t.propertyId}/0b6f1d2e-3333-4a2b-8c3d-000000000003.mp4`;
  // Les photos certifiées du Studio, celles que relit la vidéo générée (X02) : les fichiers sont tous là.
  const certs = new CertificatsPhotos(t.db, t.acces, t.journal, { has: async () => true }, { now: t.now });
  const medias = new MediasBien(t.db, t.acces, t.journal, { now: t.now });
  const videos = new VideosGenerees(t.db, t.acces, t.journal, certs, medias, new AnnoncesTraduites(t.db, t.acces, t.journal, { now: t.now }), { now: t.now });
  // L'accord écrit d'Alex pour sa voix, puis la vidéo générée avec sa voix, rangée sous la référence de la fiche.
  const text = consentText('voix', 'Alex', 'Agent');
  const consent = await videos.giveConsent(t.agent, { kind: 'voix', sampleSha256: sha('c'), acceptedText: text, processedOn: 'appareil' });
  if (!consent.ok) throw new Error(`accord ${consent.code}`);
  const plan = await videos.plan(t.agent, t.propertyId);
  if (!plan.ok) throw new Error(`plan ${plan.code}`);
  const recorded = await videos.record(t.agent, t.propertyId, {
    videoRef: video, videoSha256: sha('f'), durationSeconds: plan.value.plan.totalSeconds, planSha256: plan.value.planSha256,
    voice: true, voiceSampleSha256: sha('c'), mentions: [GENERATED_VIDEO_MENTION, likenessMention(true, false)],
    subtitles: { fr: ['Séjour lumineux avec balcon'] }, caption: 'Visite en images', processedOn: 'appareil',
  });
  if (!recorded.ok) throw new Error(`vidéo ${recorded.code}`);
  // Les annonces relisent la vidéo avec les mêmes photos certifiées.
  const channels = CHANNELS.map((c) => new FakeChannel(c));
  const publication = new Publication(t.db, t.acces, t.journal, { now: t.now, channels, generatedVideoPhotos: certs });
  t.setClock(new Date('2027-02-12T10:00:00.000Z'));
  const v = await t.annonces.validate(t.agent, t.draftId);
  if (!v.ok) throw new Error(`validation ${v.code}`);
  let minute = 0;
  /** Un passage du planificateur ; rend les médias de la dernière annonce reçue par chaque canal. */
  const sync = async () => {
    t.setClock(new Date(Date.parse('2027-03-01T08:00:00.000Z') + ++minute * 15 * 60_000));
    await publication.sync(t.network.id, t.propertyId);
    return channels.map((c) => c.received.at(-1)!.media);
  };
  const sheetVersion = (await t.db.first<{ v: number }>('SELECT max(version) AS v FROM property_sheets WHERE property_id = ?', [t.propertyId]))!.v;
  return { ...t, video, certs, videos, consentId: consent.value.id, channels, sync, sheetVersion, publication };
}

const hasVideo = (all: { ref: string }[][], ref: string) => all.map((media) => media.some((m) => m.ref === ref));

describeWithSqlite('HX51 · la publication relit chaque vidéo générée', () => {
  it('[R498] la vidéo générée part tant qu’elle est diffusable ; l’accord retiré, elle n’est plus dans aucune annonce publiée', async () => {
    const t = await setup();
    expect(await t.videos.diffusable(t.propertyId, t.video)).toEqual({ ok: true });
    const first = await t.sync();
    expect(first).toHaveLength(CHANNELS.length);
    expect(hasVideo(first, t.video).every(Boolean)).toBe(true);
    // Alex retire son accord : au passage suivant, chaque canal reçoit l'annonce sans la vidéo.
    const r = await t.videos.revokeConsent(t.agent, t.consentId);
    expect(r.ok).toBe(true);
    const after = await t.sync();
    expect(hasVideo(after, t.video).some(Boolean)).toBe(false);
    // Les photos, elles, partent toujours.
    expect(after.every((media) => media.some((m) => m.kind === 'photo'))).toBe(true);
  });

  it('[R498] le bien repris par un autre agent, ou l’agent parti : la vidéo avec sa voix ne part plus', async () => {
    const t = await setup();
    const medias = new MediasBien(t.db, t.acces, t.journal, { now: t.now, generatedVideoPhotos: t.certs });
    const refs = async () => (await medias.publishable(t.propertyId, t.sheetVersion)).map((m) => m.ref);
    expect(await refs()).toContain(t.video);
    const sam = t.sam.userId;
    await t.db.run('UPDATE properties SET agent_id = ? WHERE id = ?', [sam, t.propertyId]);
    expect(await refs()).not.toContain(t.video);
    await t.db.run('UPDATE properties SET agent_id = ? WHERE id = ?', [t.alexId, t.propertyId]);
    await t.db.run("UPDATE agents SET status = 'left' WHERE id = ?", [t.alexId]);
    expect(await refs()).not.toContain(t.video);
  });

  it('[R498] les photos du plan changent : la vidéo ne part plus, même publiée avec la version de fiche d’avant', async () => {
    const t = await setup();
    expect(hasVideo(await t.sync(), t.video).every(Boolean)).toBe(true);
    // Une nouvelle version de la fiche sans la photo aménagée : le plan des photos du moment n'est plus celui de la vidéo.
    const sheet = await t.db.first<{ data: string }>('SELECT data FROM property_sheets WHERE property_id = ? AND version = ?', [t.propertyId, t.sheetVersion]);
    const data = JSON.parse(sheet!.data) as { media: { ref: string; kind: string; edit: string }[] };
    const fewer = { ...data, media: data.media.filter((m) => m.edit !== 'amenagement_virtuel') };
    await t.db.run("INSERT INTO property_sheets (id, property_id, network_id, version, data, created_by, created_at) VALUES ('hx51-s', ?, ?, ?, ?, 'agent:a', '2027-03-01')", [t.propertyId, t.network.id, t.sheetVersion + 1, JSON.stringify(fewer)]);
    expect(await t.videos.diffusable(t.propertyId, t.video)).toEqual({ ok: false, code: 'photos_changees' });
    const medias = new MediasBien(t.db, t.acces, t.journal, { now: t.now, generatedVideoPhotos: t.certs });
    expect((await medias.publishable(t.propertyId, t.sheetVersion)).map((m) => m.ref)).not.toContain(t.video);
    expect(hasVideo(await t.sync(), t.video).some(Boolean)).toBe(false);
  });

  it('[R498] [R133] une même référence portant un montage et une vidéo générée suit la règle la plus stricte', async () => {
    const t = await setup();
    const medias = new MediasBien(t.db, t.acces, t.journal, { now: t.now, generatedVideoPhotos: t.certs });
    const refs = async () => (await medias.publishable(t.propertyId, t.sheetVersion)).map((m) => m.ref);
    // Un montage rangé sous la même référence, avec une musique sous licence.
    await t.db.run(
      "INSERT INTO licensed_assets (id, network_id, kind, title, source, licence, attribution, valid_until, proof_ref, recorded_by, recorded_at) VALUES ('mus-1', ?, 'musique', 'Air de test', 'banque_sous_licence', 'abonnement', NULL, NULL, 'preuves/mus-1.pdf', 'direction:d', '2027-01-01')",
      [t.network.id],
    );
    await t.db.run(
      "INSERT INTO video_montages (id, property_id, network_id, video_ref, video_sha256, template_sha256, clips_count, duration_s, music_id, processed_on, recorded_by, recorded_at) VALUES ('m-1', ?, ?, ?, ?, ?, 5, 20, 'mus-1', 'appareil', 'agent:a', '2027-01-01')",
      [t.propertyId, t.network.id, t.video, sha('1'), sha('2')],
    );
    expect(await refs()).toContain(t.video);
    // La licence de la musique retirée : la vidéo générée, pourtant diffusable, ne part plus.
    await t.db.run("INSERT INTO licensed_asset_withdrawals (id, asset_id, reason, withdrawn_by, withdrawn_at) VALUES ('w-1', 'mus-1', 'licence_retiree', 'direction:d', '2027-03-01')");
    expect(await t.videos.diffusable(t.propertyId, t.video)).toEqual({ ok: true });
    expect(await refs()).not.toContain(t.video);
  });

  it('[R498] [R46] un montage et un contrôle de texte réussis sous la même référence ne font pas partir une vidéo générée non diffusable', async () => {
    const t = await setup();
    const medias = new MediasBien(t.db, t.acces, t.journal, { now: t.now, generatedVideoPhotos: t.certs });
    await t.db.run(
      "INSERT INTO video_montages (id, property_id, network_id, video_ref, video_sha256, template_sha256, clips_count, duration_s, music_id, processed_on, recorded_by, recorded_at) VALUES ('m-2', ?, ?, ?, ?, ?, 5, 20, NULL, 'appareil', 'agent:a', '2027-01-01')",
      [t.propertyId, t.network.id, t.video, sha('1'), sha('2')],
    );
    expect(await medias.checkVideoText(t.agent, t.propertyId, t.video, { subtitles: ['Visite lumineuse.'], caption: 'Visite' })).toEqual({ ok: true });
    expect((await medias.publishable(t.propertyId, t.sheetVersion)).map((m) => m.ref)).toContain(t.video);
    await t.videos.revokeConsent(t.agent, t.consentId);
    expect((await medias.publishable(t.propertyId, t.sheetVersion)).map((m) => m.ref)).not.toContain(t.video);
  });

  it('[R498] sans les photos certifiées pour la relire, une vidéo générée ne part dans aucune annonce', async () => {
    const t = await setup();
    const blind = new MediasBien(t.db, t.acces, t.journal, { now: t.now });
    expect((await blind.publishable(t.propertyId, t.sheetVersion)).map((m) => m.ref)).not.toContain(t.video);
    const plain = new Publication(t.db, t.acces, t.journal, { now: t.now, channels: CHANNELS.map((c) => new FakeChannel(c)) });
    t.setClock(new Date('2027-03-01T08:00:00.000Z'));
    await plain.sync(t.network.id, t.propertyId);
    const version = await t.db.first<{ payload: string }>('SELECT payload FROM listing_versions WHERE property_id = ? ORDER BY seq DESC LIMIT 1', [t.propertyId]);
    expect(version!.payload).not.toContain(t.video);
  });
});
