import { describe, expect, it } from 'vitest';
import { classesOf, compareOnline, DiffusionSurveillee, missingFields, plainText, type OnlineListing, type OnlineListingReader } from '../src/diffusion/surveillance.ts';
import { setupAnnonce } from './annonces-jeu.ts';
import { describeWithSqlite } from './sqlite.ts';

// Réseau, biens, personnes, portails réglés et annonces en ligne inventés.
const PAYLOAD = {
  reference: 'REF-T-1',
  state: 'en_vente' as const,
  title: 'Appartement de 3 pièces',
  body: 'Lumineux, au calme.',
  priceEur: 210000,
  mentions: 'Prix : 210 000 € honoraires inclus.\nClasse énergie D, classe climat C. Logement test.\nCarte professionnelle n° CPI 0000.',
  media: [{ ref: 'biens/x/1.jpg', kind: 'photo' as const, overlay: null }],
};

describe('HX38 · champs exigés et comparaison, sans base', () => {
  it('[R470] les champs exigés manquants sont dits un par un, photos comprises', () => {
    expect(missingFields(PAYLOAD, { requiredFields: ['titre', 'texte', 'prix', 'mentions', 'classe_energie'], minPhotos: 1 })).toEqual([]);
    expect(missingFields({ ...PAYLOAD, title: ' ', mentions: 'Prix seul.' }, { requiredFields: ['titre', 'classe_energie'], minPhotos: 3 })).toEqual(['titre', 'classe_energie', 'photos']);
    expect(classesOf(PAYLOAD.mentions)).toEqual({ energy: 'D', climate: 'C' });
  });

  it('[R473] un écart de prix, de diagnostic ou de mention est signalé, une espace insécable n’en est pas un', () => {
    const online = { found: true as const, priceEur: 210000, energyClass: 'D', climateClass: 'C', text: plainText(PAYLOAD.mentions).replace(/ /g, '  ') };
    expect(compareOnline(PAYLOAD, online)).toEqual([]);
    expect(compareOnline(PAYLOAD, { ...online, priceEur: 199000 })).toEqual([{ field: 'prix', published: 210000, online: 199000 }]);
    expect(compareOnline(PAYLOAD, { ...online, energyClass: 'B' })).toEqual([{ field: 'classe_energie', published: 'D', online: 'B' }]);
    expect(compareOnline(PAYLOAD, { ...online, text: online.text.replace('CPI', '') })).toEqual([{ field: 'mention', line: 3 }]);
  });
});

class FakeReader implements OnlineListingReader {
  pages = new Map<string, OnlineListing | 'panne'>();
  async read(_portal: string, url: string): Promise<OnlineListing> {
    const p = this.pages.get(url);
    if (p === 'panne') throw new Error('illisible');
    return p ?? { found: false };
  }
}

async function setup() {
  const t = await setupAnnonce();
  t.setClock(new Date('2027-02-12T10:00:00.000Z'));
  await t.annonces.validate(t.agent, t.draftId);
  t.setClock(new Date('2027-03-01T08:00:00.000Z'));
  await t.publication.sync(t.network.id, t.propertyId);
  let n = 0;
  const d = new DiffusionSurveillee(t.db, t.acces, t.journal, { now: t.now, newId: () => `id-${++n}` });
  expect(await d.setPortal(t.direction, { code: 'seloger', label: 'SeLoger', host: 'www.seloger.com', requiredFields: ['titre', 'texte', 'prix', 'mentions', 'classe_energie'], minPhotos: 1 })).toEqual({ ok: true });
  expect(await d.setPortal(t.direction, { code: 'leboncoin', label: 'leboncoin', host: 'www.leboncoin.fr', requiredFields: ['prix'], minPhotos: 0 })).toEqual({ ok: true });
  const version = async () => (await t.db.first<{ seq: number; payload: string }>('SELECT seq, payload FROM listing_versions WHERE property_id = ? ORDER BY seq DESC LIMIT 1', [t.propertyId]))!;
  const online = async (): Promise<OnlineListing> => {
    const v = JSON.parse((await version()).payload) as typeof PAYLOAD;
    const c = classesOf(v.mentions);
    return { found: true, priceEur: v.priceEur, energyClass: c.energy, climateClass: c.climate, text: `${v.title} ${v.mentions}` };
  };
  return { ...t, d, version, online, reader: new FakeReader() };
}

const URL_SL = 'https://www.seloger.com/annonces/achat/appartement/dijon-21/123.htm';

describeWithSqlite('HX38 · diffusion surveillée portail par portail', () => {
  it('[R470] un bien ne va qu’aux portails choisis pour lui, aux champs exigés remplis', async () => {
    const t = await setup();
    let plan = await t.d.plan(t.network.id, t.propertyId);
    expect(plan.map((p) => [p.portal, p.status])).toEqual([['leboncoin', 'non_choisi'], ['seloger', 'non_choisi']]);
    expect(await t.d.portalListings(t.network.id, 'seloger')).toEqual([]);
    expect(await t.d.choose(t.agent, t.propertyId, 'seloger', true)).toEqual({ ok: true });
    plan = await t.d.plan(t.network.id, t.propertyId);
    expect(plan.find((p) => p.portal === 'seloger')).toEqual({ portal: 'seloger', status: 'a_diffuser', missing: [], until: null });
    expect((await t.d.portalListings(t.network.id, 'seloger')).map((l) => l.reference)).toEqual(['REF-T-1']);
    expect(await t.d.portalListings(t.network.id, 'leboncoin')).toEqual([]);
    // Un portail qui exige plus de photos que l'annonce n'en a : le bien n'y va pas, et l'agent voit pourquoi.
    await t.d.setPortal(t.direction, { code: 'seloger', label: 'SeLoger', host: 'www.seloger.com', requiredFields: ['prix'], minPhotos: 5 });
    plan = await t.d.plan(t.network.id, t.propertyId);
    expect(plan.find((p) => p.portal === 'seloger')).toMatchObject({ status: 'champs_manquants', missing: ['photos'] });
    expect(await t.d.portalListings(t.network.id, 'seloger')).toEqual([]);
    // Écarté : il sort du flux.
    await t.d.setPortal(t.direction, { code: 'seloger', label: 'SeLoger', host: 'www.seloger.com', requiredFields: ['prix'], minPhotos: 0 });
    await t.d.choose(t.agent, t.propertyId, 'seloger', false);
    expect(await t.d.portalListings(t.network.id, 'seloger')).toEqual([]);
  });

  it('[R470] [R16] seuls l’agent du bien et la direction choisissent ; un portail inconnu ou hors domaine est refusé', async () => {
    const t = await setup();
    expect(await t.d.choose(t.sam, t.propertyId, 'seloger', true)).toMatchObject({ ok: false, rule: 'R16' });
    expect(await t.d.choose(t.agent, t.propertyId, 'portail-invente', true)).toEqual({ ok: false, rule: 'R470', code: 'portail_inconnu' });
    expect(await t.d.setPortal(t.agent, { code: 'pap', label: 'PAP', host: 'www.pap.fr', requiredFields: [], minPhotos: 0 })).toMatchObject({ ok: false, rule: 'R16' });
    expect(await t.d.setPortal(t.direction, { code: 'pap', label: 'PAP', host: 'www.exemple.test', requiredFields: [], minPhotos: 0 })).toEqual({ ok: false, rule: 'R470', code: 'hors_du_portail' });
    expect(await t.d.setPortal(t.direction, { code: 'pap', label: 'PAP', host: 'www.pap.fr', requiredFields: ['note'], minPhotos: 0 })).toEqual({ ok: false, rule: 'R470', code: 'bad_fields' });
    expect(await t.d.choose(t.direction, t.propertyId, 'leboncoin', true)).toEqual({ ok: true });
  });

  it('[R471] un rejet crée une seule tâche de correction, même répété ; une version acceptée ensuite la ferme', async () => {
    const t = await setup();
    await t.d.choose(t.agent, t.propertyId, 'seloger', true);
    const { seq } = await t.version();
    const r1 = await t.d.recordFeedback(t.network.id, { portal: 'seloger', propertyId: t.propertyId, seq, outcome: 'rejet', code: 'photo_trop_petite', detail: 'Photo 1 : 640 px au lieu de 800.' });
    const r2 = await t.d.recordFeedback(t.network.id, { portal: 'seloger', propertyId: t.propertyId, seq, outcome: 'rejet', code: 'photo_trop_petite', detail: 'Photo 1 : 640 px au lieu de 800.' });
    const r3 = await t.d.recordFeedback(t.network.id, { portal: 'seloger', propertyId: t.propertyId, seq, outcome: 'rejet', code: 'texte_trop_court' });
    expect(r1).toMatchObject({ ok: true, stored: true });
    expect(r2).toMatchObject({ ok: true, stored: false });
    expect(r3).toMatchObject({ ok: true, stored: true });
    if (!r1.ok || !r2.ok || !r3.ok) return;
    expect(r2.taskId).toBe(r1.taskId);
    expect(r3.taskId).toBe(r1.taskId);
    let tasks = await t.d.tasks(t.agent);
    expect(tasks.ok && tasks.tasks.map((x) => [x.portal, x.kind, x.rejection?.code])).toEqual([['seloger', 'rejet', 'texte_trop_court']]);
    expect(await t.d.tasks(t.sam)).toEqual({ ok: true, tasks: [] });
    // La base refuse une seconde tâche ouverte, même écrite à la main.
    await expect(t.db.run("INSERT INTO diffusion_portal_tasks (id, network_id, property_id, portal, kind, first_ref, created_at) VALUES ('x', ?, ?, 'seloger', 'rejet', 'y', 'z')", [t.network.id, t.propertyId])).rejects.toThrow(/déjà ouverte/);
    // Le texte du rejet n'entre jamais au journal.
    const lines = await t.db.all<{ data: string }>("SELECT data FROM journal WHERE type LIKE 'diffusion.%'");
    expect(lines.length).toBeGreaterThan(0);
    expect(JSON.stringify(lines)).not.toContain('640 px');
    // Acceptée : la tâche se ferme.
    expect(await t.d.recordFeedback(t.network.id, { portal: 'seloger', propertyId: t.propertyId, seq, outcome: 'acceptee', onlineUrl: URL_SL })).toMatchObject({ ok: true, stored: true });
    tasks = await t.d.tasks(t.agent);
    expect(tasks.ok && tasks.tasks).toEqual([]);
    // Un nouveau rejet, plus tard, rouvre une nouvelle tâche, une seule.
    const r4 = await t.d.recordFeedback(t.network.id, { portal: 'seloger', propertyId: t.propertyId, seq, outcome: 'rejet', code: 'doublon' });
    expect(r4.ok && r4.taskId).not.toBe(r1.taskId);
    tasks = await t.d.tasks(t.direction);
    expect(tasks.ok && tasks.tasks.length).toBe(1);
  });

  it('[R471] une acceptation d’une version plus ancienne que le dernier rejet ne ferme pas la tâche', async () => {
    const t = await setup();
    await t.d.choose(t.agent, t.propertyId, 'seloger', true);
    const first = (await t.version()).seq;
    await t.amend(190000);
    await t.publication.sync(t.network.id, t.propertyId);
    const second = (await t.version()).seq;
    expect(second).toBeGreaterThan(first);
    await t.d.recordFeedback(t.network.id, { portal: 'seloger', propertyId: t.propertyId, seq: second, outcome: 'rejet', code: 'prix_illisible' });
    await t.d.recordFeedback(t.network.id, { portal: 'seloger', propertyId: t.propertyId, seq: first, outcome: 'acceptee', onlineUrl: URL_SL });
    let tasks = await t.d.tasks(t.agent);
    expect(tasks.ok && tasks.tasks.length).toBe(1);
    await t.d.recordFeedback(t.network.id, { portal: 'seloger', propertyId: t.propertyId, seq: second, outcome: 'acceptee', onlineUrl: URL_SL });
    tasks = await t.d.tasks(t.agent);
    expect(tasks.ok && tasks.tasks.length).toBe(0);
    // Écarter le portail ferme aussi ce qui reste ouvert.
    await t.d.recordFeedback(t.network.id, { portal: 'seloger', propertyId: t.propertyId, seq: second, outcome: 'rejet', code: 'autre_chose' });
    await t.d.choose(t.agent, t.propertyId, 'seloger', false);
    tasks = await t.d.tasks(t.agent);
    expect(tasks.ok && tasks.tasks.length).toBe(0);
  });

  it('[R471] un rejet reçu deux fois, ou d’une version plus ancienne que la dernière acceptée, ne rouvre rien', async () => {
    const t = await setup();
    await t.d.choose(t.agent, t.propertyId, 'seloger', true);
    const first = (await t.version()).seq;
    await t.d.recordFeedback(t.network.id, { portal: 'seloger', propertyId: t.propertyId, seq: first, outcome: 'rejet', code: 'photo_trop_petite' });
    await t.amend(190000);
    await t.publication.sync(t.network.id, t.propertyId);
    const second = (await t.version()).seq;
    await t.d.recordFeedback(t.network.id, { portal: 'seloger', propertyId: t.propertyId, seq: second, outcome: 'acceptee', onlineUrl: URL_SL });
    expect((await t.d.tasks(t.agent))).toEqual({ ok: true, tasks: [] });
    // Le même rejet renvoyé : déjà rangé, rien ne s'ouvre.
    expect(await t.d.recordFeedback(t.network.id, { portal: 'seloger', propertyId: t.propertyId, seq: first, outcome: 'rejet', code: 'photo_trop_petite' })).toEqual({ ok: true, stored: false, taskId: null });
    // Un rejet tardif de la version 1, après l'acceptation de la version 2 : rangé, sans tâche.
    expect(await t.d.recordFeedback(t.network.id, { portal: 'seloger', propertyId: t.propertyId, seq: first, outcome: 'rejet', code: 'texte_trop_court' })).toEqual({ ok: true, stored: true, taskId: null });
    expect((await t.d.tasks(t.agent))).toEqual({ ok: true, tasks: [] });
  });

  it('[R473] une adresse en ligne hors du domaine du portail, ou sans https, est refusée', async () => {
    const t = await setup();
    const { seq } = await t.version();
    for (const onlineUrl of ['http://www.seloger.com/a', 'https://seloger.com.exemple.test/a', 'https://www.leboncoin.fr/a', 'pas une adresse', 'https://x:y@www.seloger.com/a']) {
      const r = await t.d.recordFeedback(t.network.id, { portal: 'seloger', propertyId: t.propertyId, seq, outcome: 'acceptee', onlineUrl });
      expect(r.ok, onlineUrl).toBe(false);
    }
    expect(await t.d.recordFeedback(t.network.id, { portal: 'seloger', propertyId: t.propertyId, seq: 99, outcome: 'acceptee', onlineUrl: URL_SL })).toEqual({ ok: false, rule: 'R471', code: 'version_inconnue' });
  });

  it('[R472] un retrait temporaire sort le bien du portail jusqu’à sa date ou sa reprise, rien ne s’efface', async () => {
    const t = await setup();
    await t.d.choose(t.agent, t.propertyId, 'seloger', true);
    const s = await t.d.suspend(t.agent, { propertyId: t.propertyId, portal: 'seloger', reason: 'photos_a_refaire', until: '2027-03-05T08:00:00.000Z' });
    expect(s.ok).toBe(true);
    if (!s.ok) return;
    expect(await t.d.suspend(t.agent, { propertyId: t.propertyId, portal: 'seloger', reason: 'travaux' })).toEqual({ ok: false, rule: 'R472', code: 'deja_retire' });
    expect(await t.d.suspend(t.agent, { propertyId: t.propertyId, portal: 'leboncoin', reason: 'travaux', until: '2027-02-01T00:00:00.000Z' })).toEqual({ ok: false, rule: 'R472', code: 'until_passe' });
    let plan = await t.d.plan(t.network.id, t.propertyId);
    expect(plan.find((p) => p.portal === 'seloger')).toMatchObject({ status: 'suspendu', until: '2027-03-05T08:00:00.000Z' });
    expect(await t.d.portalListings(t.network.id, 'seloger')).toEqual([]);
    // La date passée, le bien revient seul.
    t.setClock(new Date('2027-03-05T08:00:00.000Z'));
    plan = await t.d.plan(t.network.id, t.propertyId);
    expect(plan.find((p) => p.portal === 'seloger')?.status).toBe('a_diffuser');
    // Sans date : jusqu'à la reprise.
    const s2 = await t.d.suspend(t.agent, { propertyId: t.propertyId, portal: 'seloger', reason: 'demande_vendeur' });
    expect(s2.ok).toBe(true);
    if (!s2.ok) return;
    expect(await t.d.resume(t.sam, s2.suspensionId)).toMatchObject({ ok: false, rule: 'R16' });
    expect(await t.d.resume(t.agent, s2.suspensionId)).toEqual({ ok: true });
    expect(await t.d.resume(t.agent, s2.suspensionId)).toEqual({ ok: false, rule: 'R472', code: 'deja_repris' });
    expect((await t.d.portalListings(t.network.id, 'seloger')).length).toBe(1);
    await expect(t.db.run('DELETE FROM diffusion_portal_suspensions')).rejects.toThrow(/efface/);
    // Deux retraits demandés en même temps : un seul passe, et la base refuse un second écrit à la main.
    const both = await Promise.all([
      t.d.suspend(t.agent, { propertyId: t.propertyId, portal: 'seloger', reason: 'travaux' }),
      t.d.suspend(t.agent, { propertyId: t.propertyId, portal: 'seloger', reason: 'correction' }),
    ]);
    expect(both.filter((x) => x.ok).length).toBe(1);
    await expect(
      t.db.run("INSERT INTO diffusion_portal_suspensions (id, network_id, property_id, portal, reason, by_actor, at) VALUES ('z', ?, ?, 'seloger', 'autre', 'x', '2027-03-06T00:00:00.000Z')", [t.network.id, t.propertyId]),
    ).rejects.toThrow(/déjà en cours/);
  });

  it('[R473] l’annonce en ligne est relue : un écart de prix avec la version publiée est signalé et ouvre une tâche, une relecture conforme la ferme', async () => {
    const t = await setup();
    await t.d.choose(t.agent, t.propertyId, 'seloger', true);
    const { seq } = await t.version();
    await t.d.recordFeedback(t.network.id, { portal: 'seloger', propertyId: t.propertyId, seq, outcome: 'acceptee', onlineUrl: URL_SL });
    t.reader.pages.set(URL_SL, await t.online());
    expect(await t.d.verify(t.network.id, t.propertyId, 'seloger', t.reader)).toEqual({ ok: true, outcome: 'conforme', gaps: [] });
    // Le prix baisse par avenant ; le portail montre encore l'ancien.
    const before = await t.online();
    await t.amend(190000);
    await t.publication.sync(t.network.id, t.propertyId);
    const now = JSON.parse((await t.version()).payload) as typeof PAYLOAD;
    const r = await t.d.verify(t.network.id, t.propertyId, 'seloger', t.reader);
    expect(r.ok && r.outcome).toBe('ecart');
    expect(r.ok && r.gaps[0]).toEqual({ field: 'prix', published: now.priceEur, online: (before as { priceEur: number }).priceEur });
    let tasks = await t.d.tasks(t.agent);
    expect(tasks.ok && tasks.tasks.map((x) => [x.kind, x.gaps[0]?.field])).toEqual([['ecart', 'prix']]);
    // Relu deux fois avec le même écart : toujours une seule tâche.
    await t.d.verify(t.network.id, t.propertyId, 'seloger', t.reader);
    tasks = await t.d.tasks(t.agent);
    expect(tasks.ok && tasks.tasks.length).toBe(1);
    t.reader.pages.set(URL_SL, await t.online());
    expect((await t.d.verify(t.network.id, t.propertyId, 'seloger', t.reader)).ok).toBe(true);
    tasks = await t.d.tasks(t.agent);
    expect(tasks.ok && tasks.tasks).toEqual([]);
  });

  it('[R473] une annonce absente, illisible, ou retirée mais encore en ligne est dite', async () => {
    const t = await setup();
    await t.d.choose(t.agent, t.propertyId, 'seloger', true);
    const { seq } = await t.version();
    expect(await t.d.verify(t.network.id, t.propertyId, 'seloger', t.reader)).toEqual({ ok: false, rule: 'R473', code: 'pas_en_ligne' });
    await t.d.recordFeedback(t.network.id, { portal: 'seloger', propertyId: t.propertyId, seq, outcome: 'acceptee', onlineUrl: URL_SL });
    expect(await t.d.verify(t.network.id, t.propertyId, 'seloger', t.reader)).toEqual({ ok: true, outcome: 'introuvable', gaps: [{ field: 'absente' }] });
    t.reader.pages.set(URL_SL, 'panne');
    expect(await t.d.verify(t.network.id, t.propertyId, 'seloger', t.reader)).toEqual({ ok: true, outcome: 'illisible', gaps: [] });
    t.reader.pages.set(URL_SL, await t.online());
    await t.d.suspend(t.agent, { propertyId: t.propertyId, portal: 'seloger', reason: 'correction' });
    expect(await t.d.verify(t.network.id, t.propertyId, 'seloger', t.reader)).toEqual({ ok: true, outcome: 'toujours_en_ligne', gaps: [{ field: 'retrait' }] });
  });

  it('[R473] la relecture suit l’adresse de la version acceptée la plus récente, même si une plus ancienne est acceptée après', async () => {
    const t = await setup();
    await t.d.choose(t.agent, t.propertyId, 'seloger', true);
    const first = (await t.version()).seq;
    await t.amend(190000);
    await t.publication.sync(t.network.id, t.propertyId);
    const second = (await t.version()).seq;
    const newUrl = 'https://www.seloger.com/annonces/achat/appartement/dijon-21/456.htm';
    await t.d.recordFeedback(t.network.id, { portal: 'seloger', propertyId: t.propertyId, seq: second, outcome: 'acceptee', onlineUrl: newUrl });
    t.setClock(new Date('2027-03-01T09:00:00.000Z'));
    await t.d.recordFeedback(t.network.id, { portal: 'seloger', propertyId: t.propertyId, seq: first, outcome: 'acceptee', onlineUrl: URL_SL });
    t.reader.pages.set(newUrl, await t.online());
    expect(await t.d.verify(t.network.id, t.propertyId, 'seloger', t.reader)).toEqual({ ok: true, outcome: 'conforme', gaps: [] });
    expect((await t.d.sellerLinks(t.network.id, t.propertyId)).map((l) => l.url)).toEqual([newUrl]);
  });

  it('[R474] le vendeur n’a le lien que d’une annonce relue conforme à la version publiée du moment', async () => {
    const t = await setup();
    await t.d.choose(t.agent, t.propertyId, 'seloger', true);
    const { seq } = await t.version();
    await t.d.recordFeedback(t.network.id, { portal: 'seloger', propertyId: t.propertyId, seq, outcome: 'acceptee', onlineUrl: URL_SL });
    // Acceptée mais pas encore relue : pas de lien.
    expect(await t.d.sellerLinks(t.network.id, t.propertyId)).toEqual([]);
    t.reader.pages.set(URL_SL, { ...((await t.online()) as Extract<OnlineListing, { found: true }>), energyClass: 'A' });
    await t.d.verify(t.network.id, t.propertyId, 'seloger', t.reader);
    expect(await t.d.sellerLinks(t.network.id, t.propertyId)).toEqual([]);
    t.reader.pages.set(URL_SL, await t.online());
    await t.d.verify(t.network.id, t.propertyId, 'seloger', t.reader);
    const links = await t.d.sellerLinks(t.network.id, t.propertyId);
    expect(links).toEqual([{ portal: 'seloger', label: 'SeLoger', url: URL_SL, verifiedAt: '2027-03-01T08:00:00.000Z', seq }]);
    // Retiré pour un temps, relu absent comme il se doit, puis repris : pas de lien avant une nouvelle relecture.
    const s = await t.d.suspend(t.agent, { propertyId: t.propertyId, portal: 'seloger', reason: 'travaux' });
    t.reader.pages.delete(URL_SL);
    expect(await t.d.verify(t.network.id, t.propertyId, 'seloger', t.reader)).toEqual({ ok: true, outcome: 'retiree_absente', gaps: [] });
    if (s.ok) await t.d.resume(t.agent, s.suspensionId);
    expect(await t.d.sellerLinks(t.network.id, t.propertyId)).toEqual([]);
    t.reader.pages.set(URL_SL, await t.online());
    await t.d.verify(t.network.id, t.propertyId, 'seloger', t.reader);
    expect((await t.d.sellerLinks(t.network.id, t.propertyId)).length).toBe(1);
    // Une nouvelle version pas encore relue retire le lien.
    await t.amend(190000);
    await t.publication.sync(t.network.id, t.propertyId);
    expect(await t.d.sellerLinks(t.network.id, t.propertyId)).toEqual([]);
  });

  it('[R475] le classement des portails se fait sur les contacts et les mandats réels de la période', async () => {
    const t = await setup();
    await t.d.setPortal(t.direction, { code: 'bienici', label: "Bien'ici", host: 'www.bienici.com', requiredFields: [], minPhotos: 0 });
    let m = 0;
    const person = async () => (await t.store.createPerson({ networkId: t.network.id, agentId: t.alexId, firstName: `Personne${++m}`, lastName: 'Inventée' })).id;
    const inbound = async (personId: string, portal: string, at: string) => {
      const id = `in-${++m}`;
      await t.db.run(
        `INSERT INTO inbound_messages (id, network_id, dedup_key, channel, kind, portal, body, status, person_id, received_at, created_at) VALUES (?, ?, ?, 'email', 'portal_email', ?, 'Bonjour', 'processed', ?, ?, 'x')`,
        [id, t.network.id, `k-${id}`, portal, personId, at],
      );
    };
    const mandate = async (personId: string, source: string, at: string) =>
      t.db.run(`INSERT INTO mandates (id, network_id, agent_id, person_id, signed_at, source_kind, recorded_by, created_at) VALUES (?, ?, ?, ?, ?, ?, 'agent:x', 'x')`, [`m-${++m}`, t.network.id, t.alexId, personId, at, source]);
    const a = await person();
    const b = await person();
    const c = await person();
    const d = await person();
    // leboncoin : trois contacts (dont un deux fois), aucun mandat.
    await inbound(a, 'leboncoin', '2027-03-02T10:00:00.000Z');
    await inbound(a, 'leboncoin', '2027-03-03T10:00:00.000Z');
    await inbound(b, 'leboncoin', '2027-03-04T10:00:00.000Z');
    await inbound(c, 'leboncoin', '2027-03-04T11:00:00.000Z');
    // seloger : un contact, devenu un mandat « portail ».
    await inbound(d, 'seloger', '2027-03-05T10:00:00.000Z');
    await mandate(d, 'portal', '2027-03-10T10:00:00.000Z');
    // Un mandat d'une autre source ne compte pour aucun portail ; un contact hors période non plus.
    await mandate(a, 'referral', '2027-03-11T10:00:00.000Z');
    await inbound(await person(), 'bienici', '2027-05-01T10:00:00.000Z');
    expect(await t.d.ranking(t.agent, { from: '2027-03-01T00:00:00.000Z', to: '2027-04-01T00:00:00.000Z' })).toMatchObject({ ok: false, rule: 'R16' });
    const r = await t.d.ranking(t.direction, { from: '2027-03-01T00:00:00.000Z', to: '2027-04-01T00:00:00.000Z' });
    expect(r).toEqual({
      ok: true,
      ranks: [
        { rank: 1, portal: 'seloger', label: 'SeLoger', contacts: 1, mandates: 1 },
        { rank: 2, portal: 'leboncoin', label: 'leboncoin', contacts: 3, mandates: 0 },
        { rank: 3, portal: 'bienici', label: "Bien'ici", contacts: 0, mandates: 0 },
      ],
    });
    expect(await t.d.ranking(t.direction, { from: '2027-04-01T00:00:00.000Z', to: '2027-03-01T00:00:00.000Z' })).toEqual({ ok: false, rule: 'R475', code: 'bad_period' });
    expect(await t.d.ranking(t.direction, { from: '2027-13-45T00:00:00Z', to: '2027-03-01T00:00:00.000Z' })).toEqual({ ok: false, rule: 'R475', code: 'bad_period' });
  });
});
