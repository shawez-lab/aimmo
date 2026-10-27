import { describe, expect, it } from 'vitest';
import { MediasBien, NEVER_FILM, parseSheet, shootingPlan, VIRTUAL_STAGING_LABEL } from '../src/annonces/index.ts';
import { setupAnnonce } from './annonces-jeu.ts';
import { describeWithSqlite } from './sqlite.ts';

// Biens, vidéos et sous-titres inventés.
describe('P06 · photos et plan de tournage', () => {
  it('une retouche au-delà de la lumière et du cadrage n’a pas de case : elle est refusée à la saisie', () => {
    const ref = 'biens/b1/0b6f1d2e-1111-4a2b-8c3d-000000000001.jpg';
    for (const edit of ['defaut_efface', 'ciel_remplace', 'agrandissement', 'retouche']) {
      expect(parseSheet({ media: [{ ref, kind: 'photo', edit }] }, new Date('2027-03-01T10:00:00Z'), 'b1')).toEqual({ ok: false, field: 'media.0.edit' });
    }
    expect(parseSheet({ media: [{ ref, kind: 'photo', edit: 'lumiere_cadrage' }] }, new Date('2027-03-01T10:00:00Z'), 'b1').ok).toBe(true);
  });

  it('le plan de tournage ne demande que ce que la fiche dit exister, et dit ce qu’il ne faut jamais filmer', () => {
    const plan = shootingPlan({
      rooms: 3,
      sheet: { characteristics: { bedrooms: 2, floor: 1, floorsTotal: 3, buildYear: null, heating: null, outdoor: ['balcon', 'cour'], landM2: null, parkingSpaces: 1, elevator: false }, energy: null, coownership: null, risks: null, media: [] },
    });
    expect(plan.shots.map((s) => s.source)).toEqual(['rooms', 'bedrooms', 'outdoor', 'outdoor', 'parkingSpaces']);
    expect(plan.shots.map((s) => s.shot)).toEqual([
      'Chacune des 3 pièces principales, en plan large depuis l’entrée de la pièce',
      'Les 2 chambres, fenêtre comprise',
      'Le balcon : un plan large, sans la rue ni les voisins',
      'La cour : un plan large, sans la rue ni les voisins',
      'La place de stationnement, sans plaque d’immatriculation',
    ]);
    expect(plan.neverFilm).toBe(NEVER_FILM);
    expect(NEVER_FILM.join(' ')).toMatch(/numéro de la maison/);
    expect(shootingPlan({ rooms: null, sheet: null }).shots).toEqual([]);
  });
});

describeWithSqlite('P06 · publication des photos et vidéos', () => {
  it('[R48] une photo d’aménagement virtuel n’est publiée qu’avec sa mention à poser sur l’image', async () => {
    const t = await setupAnnonce();
    t.setClock(new Date('2027-02-12T10:00:00.000Z'));
    await t.annonces.validate(t.agent, t.draftId);
    t.setClock(new Date('2027-03-01T08:00:00.000Z'));
    await t.publication.sync(t.network.id, t.propertyId);
    for (const c of t.channels) {
      const photos = c.received.at(-1)!.media.filter((m) => m.kind === 'photo');
      expect(photos).toHaveLength(2);
      expect(photos.map((p) => p.overlay)).toEqual([null, VIRTUAL_STAGING_LABEL]);
      expect(photos.every((p) => (p.ref.includes('2222') ? p.overlay === 'Aménagement virtuel' : p.overlay === null))).toBe(true);
    }
  });

  it('[R46] une vidéo n’est publiée qu’après un contrôle réussi de ses sous-titres et de sa légende : jamais d’adresse', async () => {
    const t = await setupAnnonce();
    const medias = new MediasBien(t.db, t.acces, t.journal, { now: t.now });
    const video = `biens/${t.propertyId}/0b6f1d2e-3333-4a2b-8c3d-000000000003.mp4`;
    t.setClock(new Date('2027-02-12T10:00:00.000Z'));
    await t.annonces.validate(t.agent, t.draftId);
    t.setClock(new Date('2027-03-01T08:00:00.000Z'));
    await t.publication.sync(t.network.id, t.propertyId);
    expect(t.channels[0]!.received.at(-1)!.media.some((m) => m.kind === 'video')).toBe(false);
    // Trois vidéos refusées, chacune pour une adresse dite autrement.
    for (const subtitles of [['Bienvenue au 12 rue des Essais.'], ['Rendez-vous place Darcy.', 'Au 3e étage.'], ['Nous sommes avenue de l’Exemple, au calme.']]) {
      const r = await medias.checkVideoText(t.agent, t.propertyId, video, { subtitles, caption: 'Visite du logement' });
      expect(r).toMatchObject({ ok: false, rule: 'R46', code: 'refused_text' });
    }
    expect(await medias.checkVideoText(t.agent, t.propertyId, video, { subtitles: ['Visite.'], caption: 'Idéal pour une famille' })).toMatchObject({ ok: false, rule: 'R46' });
    // Une adresse ou un critère coupé entre deux sous-titres est lu d'un bloc.
    expect(await medias.checkVideoText(t.agent, t.propertyId, video, { subtitles: ['Bienvenue au 12', 'rue', 'des Essais.'], caption: 'Visite' })).toMatchObject({ ok: false, rule: 'R46' });
    expect(await medias.checkVideoText(t.agent, t.propertyId, video, { subtitles: ['Sans', 'enfants.'], caption: 'Visite' })).toMatchObject({ ok: false, rule: 'R46' });
    expect(await medias.checkVideoText(t.agent, t.propertyId, video, { subtitles: ['Bienvenue au 12 av. des Essais.'], caption: 'Visite' })).toMatchObject({ ok: false, rule: 'R46' });
    expect(await medias.checkVideoText(t.agent, t.propertyId, video, { subtitles: ['Visite.'], caption: 'Au 3 bd. de l’Essai.' })).toMatchObject({ ok: false, rule: 'R46' });
    await t.publication.sync(t.network.id, t.propertyId);
    expect(t.channels[0]!.received.at(-1)!.media.some((m) => m.kind === 'video')).toBe(false);
    // Un texte propre : la vidéo part au passage suivant, partout.
    expect(await medias.checkVideoText(t.agent, t.propertyId, video, { subtitles: ['Le séjour, lumineux.', 'Au 3e étage avec ascenseur.'], caption: 'Visite du logement' })).toEqual({ ok: true });
    expect(await t.publication.sync(t.network.id, t.propertyId)).toMatchObject({ created: true, pushed: ['site', 'reseaux', 'google', 'portails'] });
    expect(t.channels.every((c) => c.received.at(-1)!.media.some((m) => m.ref === video && m.kind === 'video'))).toBe(true);
    // Un nouveau contrôle refusé retire la vidéo au passage suivant : seul le dernier compte.
    await medias.checkVideoText(t.agent, t.propertyId, video, { subtitles: ['Au 4 impasse des Tests.'], caption: 'Visite' });
    await t.publication.sync(t.network.id, t.propertyId);
    expect(t.channels[0]!.received.at(-1)!.media.some((m) => m.kind === 'video')).toBe(false);
    // Au journal : l'issue et les codes, jamais le texte.
    const entries = (await t.journal.bySubject(`property:${t.propertyId}`)).filter((e) => e.type === 'video.texte_controle');
    expect(entries.map((e) => (e.data as { outcome: string }).outcome)).toEqual(['refuse', 'refuse', 'refuse', 'refuse', 'refuse', 'refuse', 'refuse', 'refuse', 'ok', 'refuse']);
    expect(JSON.stringify(entries)).not.toMatch(/Essais|Darcy|Tests|famille/);
  });

  it('[R16] seuls l’agent du bien et la direction contrôlent une vidéo ; une photo ou une référence inconnue ne passe pas', async () => {
    const t = await setupAnnonce();
    const medias = new MediasBien(t.db, t.acces, t.journal, { now: t.now });
    const video = `biens/${t.propertyId}/0b6f1d2e-3333-4a2b-8c3d-000000000003.mp4`;
    const text = { subtitles: ['Visite.'], caption: 'Visite' };
    expect(await medias.checkVideoText(t.sam, t.propertyId, video, text)).toMatchObject({ ok: false, rule: 'R16' });
    expect(await medias.checkVideoText(t.agent, t.propertyId, `biens/${t.propertyId}/0b6f1d2e-1111-4a2b-8c3d-000000000001.jpg`, text)).toEqual({ ok: false, rule: null, code: 'unknown_media' });
    expect(await medias.checkVideoText(t.agent, t.propertyId, 'biens/x/inconnue.mp4', text)).toEqual({ ok: false, rule: null, code: 'unknown_media' });
    expect(await medias.checkVideoText(t.agent, t.propertyId, video, { subtitles: 'pas une liste', caption: 'x' })).toEqual({ ok: false, rule: null, code: 'bad_text' });
    expect(await medias.checkVideoText(t.direction, t.propertyId, video, text)).toEqual({ ok: true });
    await expect(t.db.run('DELETE FROM video_text_checks')).rejects.toThrow(/rien ne s'efface/);
  });
});
