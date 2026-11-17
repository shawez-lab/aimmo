import { expect, it } from 'vitest';
import { Acces, FicheAcquereur, FicheClient, FicheUnique, SqlJournalStore, annonces, applyMigrations, fromSyncSqlite, type SqlDatabase } from '../../core/src/index.ts';
import { ALERT_PURPOSE } from '../../core/src/index.ts';
import { CalendrierPublications, LETTER_PURPOSE, type CalendarDeps } from '../../core/src/marketing/index.ts';
import { Publications, trialSocialChannel, type CertifiedPhoto, type SocialPayload } from '../../core/src/studio/index.ts';
import { DELAY_END, MIN, setupAnnonce } from '../../core/test/annonces-jeu.ts';
import { loadMigrations } from '../../core/test/migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from '../../core/test/sqlite.ts';
import { handleRequest, type ApiConfig } from '../src/app.ts';
import { CALENDAR_JOB, LETTER_EDITION_DAYS, LETTER_JOB, LETTER_UNSUBSCRIBE_PATH, calendarJob, letterUnsubscribeBase, marketingJobs } from '../src/marketing-passage.ts';
import { runScheduler } from '../src/planificateur.ts';
import { runListingSync } from '../src/vitrine.ts';

// Réseau, agents, biens, personnes, adresses et textes inventés.
type Facts = Parameters<typeof annonces.fallbackListing>[0];
const FACTS: Facts = {
  kind: 'home',
  city: 'Villebrune',
  postalCode: null,
  surfaceM2: 72,
  rooms: 3,
  bedrooms: 2,
  floor: null,
  floorsTotal: null,
  buildYear: null,
  heating: null,
  outdoor: ['balcon'],
  landM2: null,
  parkingSpaces: null,
  elevator: null,
  energyClass: 'C',
  climateClass: 'C',
};
const MENTIONS = 'Prix : 230 000 € honoraires inclus, dont 4,55 % TTC à la charge de l’acquéreur.\nClasse énergie C, classe climat C.\nCarte professionnelle n° CPI 0000 0000 000 000 000.';
const photo = (p: string) => `biens/${p}/00000001-0000-4000-8000-000000000000.jpg`;
const BASE = 'https://aimmo.example.test/lettre/desinscription/';

/** Dimanche 10 octobre 2027, 8 h à Paris : le calendrier réglé vaut à partir du lundi 11 ; le créneau de 9 h est à 7 h UTC. */
const START = '2027-10-10T06:00:00.000Z';

/** Le calendrier avec la vraie classe de publication de X05 (`Publications`), ses canaux d'essai et un lien marqué inventé. */
async function setupCalendar() {
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  let clock = Date.parse(START);
  const now = (): Date => new Date(clock);
  const journal = new SqlJournalStore(db);
  const store = new FicheClient(db, { now });
  const acces = new Acces(db, store, new FicheUnique(db, store, { now }), journal, { now });
  const network = await store.createNetwork('Réseau test');
  const alex = await store.createAgent({ networkId: network.id, firstName: 'Alexandrine', lastName: 'Fictive' });
  const offline = new Set<string>();
  const links = {
    studioLink: async (_n: string, _k: 'publication', ref: string, propertyId: string) => ({ contentId: `c-${ref}`, link: offline.has(propertyId) ? null : `https://exemple.test/biens/${propertyId}?o=c-${ref}` }),
    linkPost: async () => ({ ok: true }),
  };
  const received: (SocialPayload & { channel: string })[] = [];
  const channels = (['instagram', 'facebook'] as const).map((c) => ({
    ...trialSocialChannel(c),
    post: async (payload: SocialPayload) => {
      received.push({ ...payload, channel: c });
    },
  }));
  const diffusion = { canDiffuse: async () => ({ allowed: true }) };
  const pubs = new Publications(
    db,
    acces,
    journal,
    {
      facts: { factsFor: async () => ({ facts: structuredClone(FACTS) }) },
      certs: { publishable: async (id: string): Promise<CertifiedPhoto[]> => [{ ref: photo(id), overlay: null, retouchMention: null, retouches: [], certificateToken: 'a'.repeat(32), certificatePath: `/certificat-photo/${'a'.repeat(32)}` }] },
      diffusion,
      mentions: { checklist: async () => ({ complete: true, text: MENTIONS, publishedPriceEur: 230_000 }) },
      consents: { has: async () => true },
      channels,
      origin: links,
    },
    { now, writer: null },
  );
  let calls = 0;
  const deps = (): CalendarDeps => ({
    gate: {
      publish: async (viewer, postId, targets, options) => {
        calls++;
        return pubs.publish(viewer, postId, targets, options);
      },
    },
    diffusion,
    links,
  });
  const cal = new CalendrierPublications(db, journal, deps(), { now });
  const alexV = { role: 'agent', userId: alex.id, networkId: network.id } as never;
  /** Un bien d'Alexandrine et une publication prête (préparée, visuel contrôlé, validée). */
  const property = async (reference: string) => {
    const p = await store.createProperty({ networkId: network.id, agentId: alex.id, reference, kind: 'home', city: 'Villebrune', priceEur: 230_000, surfaceM2: 72, rooms: 3, status: 'available' });
    const prep = await pubs.prepare(alexV, p.id, { event: 'nouveau_bien', visuals: [photo(p.id)] });
    if (!prep.ok) throw new Error(prep.code);
    await pubs.checkVisual(alexV, prep.value.id, { ref: photo(p.id), addressVisible: false, personVisible: false });
    const ok = await pubs.validate(alexV, prep.value.id);
    if (!ok.ok) throw new Error(ok.code);
    return p.id;
  };
  const tick = (mode = 'essai') => runScheduler({ db, mode, now, jobs: [calendarJob(db, journal, deps, { now })] });
  const outcomes = async () => {
    const s = await cal.slots(alexV, '2027-10-11', '2027-10-11');
    if (!s.ok) throw new Error(s.code);
    return s.value.map((x) => ({ channel: x.channel, outcome: x.outcome, reason: x.reason }));
  };
  return { db, journal, cal, alexV, property, received, offline, deps, tick, outcomes, calls: () => calls, setClock: (iso: string) => (clock = Date.parse(iso)) };
}

describeWithSqlite('BR112 · le passage des créneaux du calendrier au planificateur, en mode essai', () => {
  it('[R26] hors mode essai, aucun créneau ne passe, rien ne part', async () => {
    const t = await setupCalendar();
    await t.property('CAL-1');
    await t.cal.setRules(t.alexV, { perDay: { instagram: 1 }, hours: ['09:00'] });
    expect(await t.cal.planWeek(t.alexV, '2027-10-11')).toMatchObject({ ok: true });
    t.setClock('2027-10-11T07:00:30.000Z');
    for (const mode of ['reel', 'production', '']) expect(await t.tick(mode)).toBeNull();
    expect(await t.db.first('SELECT count(*) AS n FROM social_calendar_runs')).toEqual({ n: 0 });
    expect(t.calls()).toBe(0);
    expect(t.received).toEqual([]);
  });

  it('[R582] un créneau dû passe une seule fois, par la porte de publication de X05, même rejoué ou en même temps', async () => {
    const t = await setupCalendar();
    const a = await t.property('CAL-1');
    await t.cal.setRules(t.alexV, { perDay: { instagram: 1, facebook: 1 }, hours: ['09:30'] });
    expect(await t.cal.planWeek(t.alexV, '2027-10-11')).toMatchObject({ ok: true });
    // Le passage de 9 h tombe avant l'heure du créneau : rien ne part.
    t.setClock('2027-10-11T07:00:30.000Z');
    expect(await t.tick()).toMatchObject({ ran: [CALENDAR_JOB] });
    expect(t.received).toEqual([]);
    // Le passage de 10 h : chaque créneau part une fois, au canal d'essai, avec son lien marqué.
    t.setClock('2027-10-11T08:00:30.000Z');
    const [first, second] = await Promise.all([t.tick(), t.tick()]);
    expect([...(first?.ran ?? []), ...(second?.ran ?? [])]).toEqual([CALENDAR_JOB]);
    expect(t.received.map((r) => r.channel).sort()).toEqual(['facebook', 'instagram']);
    for (const r of t.received) expect(r.link).toBe(`https://exemple.test/biens/${a}?o=c-${r.postId}`);
    // Le même travail rejoué à la main, deux fois en même temps, puis le passage suivant : rien de plus.
    const job = calendarJob(t.db, t.journal, t.deps, { now: () => new Date('2027-10-11T08:20:00.000Z') });
    await Promise.all([job.run({ job: job.name, slot: 'x', at: new Date() }), job.run({ job: job.name, slot: 'x', at: new Date() })]);
    t.setClock('2027-10-11T09:00:30.000Z');
    await t.tick();
    expect(t.calls()).toBe(2);
    expect(t.received).toHaveLength(2);
    expect(await t.outcomes()).toEqual([
      { channel: 'facebook', outcome: 'envoye', reason: null },
      { channel: 'instagram', outcome: 'envoye', reason: null },
    ]);
    // Au journal : issues et règles, jamais le texte ni le lien [R13].
    for (const e of await t.db.all<{ data: string }>("SELECT data FROM journal WHERE type LIKE 'marketing.%'")) expect(e.data).not.toMatch(/https?:|€|Villebrune/);
  });

  it('[R582] sans lien marqué vers la page du bien, rien ne part ; un créneau manqué ne part jamais en retard', async () => {
    const t = await setupCalendar();
    const a = await t.property('CAL-1');
    await t.cal.setRules(t.alexV, { perDay: { instagram: 1 }, hours: ['09:00'] });
    expect(await t.cal.planWeek(t.alexV, '2027-10-11')).toMatchObject({ ok: true });
    t.offline.add(a);
    t.setClock('2027-10-11T07:00:30.000Z');
    await t.tick();
    expect(t.calls()).toBe(0);
    expect(t.received).toEqual([]);
    expect(await t.outcomes()).toEqual([{ channel: 'instagram', outcome: 'refuse', reason: 'sans_lien' }]);

    // Le lendemain, aucun passage pendant plus de deux heures après le créneau : il est manqué, jamais envoyé.
    t.offline.delete(a);
    t.setClock('2027-10-12T09:30:30.000Z');
    await t.tick();
    expect(t.received).toEqual([]);
    expect(await t.db.first("SELECT count(*) AS n FROM social_calendar_runs r JOIN social_calendar_slots c ON c.id = r.slot_id WHERE c.day = '2027-10-12'")).toEqual({ n: 0 });
  });

  it('sans le stockage des fichiers du studio, le passage du calendrier n’est pas inscrit ; avec lui, il l’est, à chaque heure', () => {
    const db = {} as SqlDatabase;
    const journal = {} as never;
    const now = () => new Date(START);
    expect(marketingJobs(db, journal, { now, files: null, letterUnsubscribeBase: null }).map((j) => j.name)).toEqual([LETTER_JOB]);
    const jobs = marketingJobs(db, journal, { now, files: { has: async () => true }, letterUnsubscribeBase: null });
    expect(jobs.map((j) => j.name)).toEqual([CALENDAR_JOB, LETTER_JOB]);
    expect(jobs[0]!.hours).toHaveLength(24);
    expect(jobs[1]).toMatchObject({ hours: [10, 16], weekdays: [1, 2, 3, 4, 5, 6] });
  });
});

/** Jeudi 25 février 2027, 10 h à Paris : le bien du jeu est publié, la lettre passe. */
const THURSDAY_10H = new Date('2027-02-25T09:00:30.000Z');

/** La lettre branchée comme au Worker (`marketingJobs`), sur le bien publié du jeu des annonces. */
async function setupLetter() {
  const t = await setupAnnonce();
  const v = await t.annonces.validate(t.agent, t.draftId);
  if (!v.ok) throw new Error(v.code);
  t.setClock(new Date(DELAY_END.getTime() + 5 * MIN));
  await runListingSync(t.db, t.now);
  t.setClock(THURSDAY_10H);
  const acquereurs = new FicheAcquereur(t.db, t.journal, { now: t.now });
  let n = 0;
  /** Un acquéreur inventé dont la recherche couvre le bien du jeu, avec ou sans accord pour la lettre. */
  const buyer = async (firstName: string, letter: boolean) => {
    n++;
    const p = await t.store.createPerson({ networkId: t.network.id, agentId: t.alexId, firstName });
    await t.store.addIdentifier({ networkId: t.network.id, personId: p.id, kind: 'email', value: `acquereur${n}@example.test` });
    if (letter) await t.store.addConsent({ networkId: t.network.id, personId: p.id, purpose: LETTER_PURPOSE, channel: 'email', proof: 'formulaire de test', givenAt: new Date('2027-02-01T09:00:00.000Z') });
    const project = await t.store.createProject({ networkId: t.network.id, agentId: t.alexId, personId: p.id, kind: 'buy' });
    const r = await acquereurs.update(t.acces, t.direction, project.id, { budgetMaxEur: 300_000 });
    if (!r.ok) throw new Error(r.code);
    return p.id;
  };
  const edition = async (title: string) => {
    const { LettreInformation } = await import('../../core/src/marketing/index.ts');
    const e = await new LettreInformation(t.db, t.journal, { now: t.now }).createEdition(t.direction, title);
    if (!e.ok) throw new Error(e.code);
    return e.id;
  };
  const tick = (base: string | null, mode = 'essai') => runScheduler({ db: t.db, mode, now: t.now, jobs: marketingJobs(t.db, t.journal, { now: t.now, files: null, letterUnsubscribeBase: base }) });
  const letters = () => t.db.all<{ person_id: string; body: string }>("SELECT m.person_id, m.body FROM messages m JOIN trial_outbox o ON o.message_id = m.id WHERE m.body LIKE '%Ne plus recevoir cette lettre%' ORDER BY m.occurred_at");
  return { ...t, buyer, edition, tick, letters };
}

describeWithSqlite('BR112 · l’envoi des éditions de la lettre au planificateur, en mode essai', () => {
  it('le lien de désinscription de la lettre : https, sans chiffre, terminé par la page de la lettre, sinon aucun', () => {
    expect(letterUnsubscribeBase(BASE)).toBe(BASE);
    expect(letterUnsubscribeBase(` ${BASE} `)).toBe(BASE);
    for (const bad of [undefined, null, '', 'http://aimmo.example.test/lettre/desinscription/', 'https://aimmo2.example.test/lettre/desinscription/', 'https://aimmo.example.test/alertes/desinscription/', 'https://aimmo.example.test/lettre/desinscription', 'https://aimmo example.test/lettre/desinscription/']) {
      expect(letterUnsubscribeBase(bad), String(bad)).toBeNull();
    }
  });

  it('[R584] sans lien de désinscription réglé, aucune lettre ne part, et le journal le dit sans donnée', async () => {
    const t = await setupLetter();
    await t.buyer('Inès', true);
    const id = await t.edition('Lettre de février');
    expect(await t.tick(null)).toMatchObject({ ran: [LETTER_JOB], failed: [] });
    expect(await t.letters()).toEqual([]);
    expect(await t.db.first('SELECT count(*) AS n FROM newsletter_letters')).toEqual({ n: 0 });
    const ev = await t.db.all<{ subject: string; data: string }>("SELECT subject, data FROM journal WHERE type = 'lettre.sans_lien'");
    expect(ev).toEqual([{ subject: `edition:${id}`, data: JSON.stringify({ rule: 'R584' }) }]);
  });

  it('[R26] hors mode essai, aucune lettre ne part, même avec le lien réglé', async () => {
    const t = await setupLetter();
    await t.buyer('Inès', true);
    await t.edition('Lettre de février');
    for (const mode of ['reel', 'production']) expect(await t.tick(BASE, mode)).toBeNull();
    expect(await t.letters()).toEqual([]);
  });

  it('[R583] [R05] une lettre seulement aux accords de la lettre en vigueur ; une édition envoyée une fois, même rejouée', async () => {
    const t = await setupLetter();
    const yes = await t.buyer('Inès', true);
    const none = await t.buyer('Léo', false);
    const other = await t.buyer('Noé', false);
    await t.store.addConsent({ networkId: t.network.id, personId: other, purpose: ALERT_PURPOSE, channel: 'email', proof: 'test', givenAt: new Date('2027-02-01T09:00:00.000Z') });
    const gone = await t.buyer('Zoé', true);
    for (const c of await t.store.listConsents(gone)) await t.store.withdrawConsent(c.id, new Date('2027-02-20T09:00:00.000Z'));
    const id = await t.edition('Lettre de février');
    expect(await t.tick(BASE)).toMatchObject({ ran: [LETTER_JOB], failed: [] });
    const sent = await t.letters();
    expect(sent.map((m) => m.person_id)).toEqual([yes]);
    expect(sent[0]!.body).toMatch(/Ne plus recevoir cette lettre : https:\/\/aimmo\.example\.test\/lettre\/desinscription\/[a-z]{32}$/);
    expect(sent.map((m) => m.person_id)).not.toContain(none);
    // Le même passage rejoué, celui de 16 h, puis celui du lendemain : toujours une seule lettre pour l'édition.
    expect(await t.tick(BASE)).toMatchObject({ ran: [], skipped: [LETTER_JOB] });
    t.setClock(new Date('2027-02-25T15:00:30.000Z'));
    expect(await t.tick(BASE)).toMatchObject({ ran: [LETTER_JOB] });
    t.setClock(new Date('2027-02-26T09:00:30.000Z'));
    expect(await t.tick(BASE)).toMatchObject({ ran: [LETTER_JOB] });
    expect((await t.letters()).map((m) => m.person_id)).toEqual([yes]);
    expect(await t.db.all('SELECT person_id, status FROM newsletter_letters WHERE edition_id = ?', [id])).toEqual([{ person_id: yes, status: 'sent' }]);
    // Au journal : l'issue et sa règle, jamais le texte [R13].
    for (const e of await t.db.all<{ data: string }>("SELECT data FROM journal WHERE type LIKE 'lettre.%'")) expect(e.data).not.toMatch(/https?:|€|Dijon/);
  });

  it('[R583] une édition ouverte depuis plus de sept jours n’est plus envoyée ; le dimanche, aucune lettre', async () => {
    const t = await setupLetter();
    await t.buyer('Inès', true);
    t.setClock(new Date(THURSDAY_10H.getTime() - (LETTER_EDITION_DAYS * 24 + 1) * 3_600_000));
    await t.edition('Lettre ancienne');
    t.setClock(new Date('2027-02-28T09:00:30.000Z')); // dimanche
    const fresh = await t.edition('Lettre du dimanche');
    expect(await t.tick(BASE)).toMatchObject({ ran: [] });
    expect(await t.letters()).toEqual([]);
    t.setClock(new Date('2027-03-01T09:00:30.000Z')); // lundi
    expect(await t.tick(BASE)).toMatchObject({ ran: [LETTER_JOB] });
    expect(await t.db.all('SELECT edition_id FROM newsletter_letters')).toEqual([{ edition_id: fresh }]);
  });

  it('[R584] la page de désinscription : le GET ne change rien, le bouton retire l’accord de la lettre seul', async () => {
    const t = await setupLetter();
    const p = await t.buyer('Inès', true);
    await t.store.addConsent({ networkId: t.network.id, personId: p, purpose: ALERT_PURPOSE, channel: 'email', proof: 'test', givenAt: new Date('2027-02-01T09:00:00.000Z') });
    await t.edition('Lettre de février');
    await t.tick(BASE);
    const [letter] = await t.letters();
    const token = /desinscription\/([a-z]{32})$/.exec(letter!.body)![1]!;
    const config: ApiConfig = { db: t.db, apiKeys: '[]', mode: 'essai', now: t.now };
    const call = (method: string, path: string, mode = 'essai') => handleRequest(new Request(`https://aimmo.example.test${path}`, { method }), { ...config, mode });
    const inForce = async () => (await t.store.listConsents(p)).filter((c) => c.withdrawn_at === null).map((c) => c.purpose).sort();
    expect(await inForce()).toEqual([ALERT_PURPOSE, LETTER_PURPOSE].sort());

    expect((await call('POST', `${LETTER_UNSUBSCRIBE_PATH}${token}`, 'reel')).status).toBe(503);
    const get = await call('GET', `${LETTER_UNSUBSCRIBE_PATH}${token}`);
    expect(get.status).toBe(200);
    expect(get.headers.get('content-security-policy')).toContain("default-src 'none'");
    const html = await get.text();
    expect(html).toContain(`<form method="post" action="${LETTER_UNSUBSCRIBE_PATH}${token}">`);
    expect(html).not.toMatch(/Inès|acquereur/);
    expect(await inForce()).toEqual([ALERT_PURPOSE, LETTER_PURPOSE].sort());

    for (const bad of ['abc', 'a'.repeat(31), 'b'.repeat(32)]) expect((await call('POST', `${LETTER_UNSUBSCRIBE_PATH}${bad}`)).status).toBe(404);
    expect((await call('PUT', `${LETTER_UNSUBSCRIBE_PATH}${token}`)).status).toBe(405);
    const post = await call('POST', `${LETTER_UNSUBSCRIBE_PATH}${token}`);
    expect(post.status).toBe(200);
    expect(await inForce()).toEqual([ALERT_PURPOSE]);
    // Une nouvelle édition : plus de lettre pour elle.
    await t.edition('Lettre de mars');
    t.setClock(new Date('2027-02-25T15:00:30.000Z'));
    await t.tick(BASE);
    expect(await t.letters()).toHaveLength(1);
  });
});

it('le planificateur du Worker inscrit les deux passages du marketing, et rien d’autre ne change', async () => {
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  const now = () => new Date('2027-03-02T09:00:30.000Z'); // mardi, 10 h à Paris
  const withMedia = await runScheduler({ db, mode: 'essai', now, studioFiles: { has: async () => false }, letterUnsubscribeBase: BASE });
  expect(withMedia?.ran).toEqual(expect.arrayContaining([CALENDAR_JOB, LETTER_JOB]));
  expect(withMedia?.failed).toEqual([]);
  const other: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(other, loadMigrations());
  const without = await runScheduler({ db: other, mode: 'essai', now });
  expect(without?.ran).toContain(LETTER_JOB);
  expect(without?.ran).not.toContain(CALENDAR_JOB);
  // Sans le marketing, les autres passages sont exactement les mêmes.
  expect(withMedia?.ran.filter((j) => !j.startsWith('marketing.'))).toEqual(without?.ran.filter((j) => !j.startsWith('marketing.')));
});
