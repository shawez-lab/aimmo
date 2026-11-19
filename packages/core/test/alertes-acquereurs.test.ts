import { expect, it } from 'vitest';
import {
  ALERT_PURPOSE,
  Acces,
  Alertes,
  FicheAcquereur,
  FicheClient,
  FicheUnique,
  Planificateur,
  SqlJournalStore,
  alertsJob,
  applyMigrations,
  fromSyncSqlite,
  verifyChain,
  type AlertBrief,
  type BuyerSearch,
  type DiffusionGate,
  type SqlDatabase,
} from '../src/index.ts';
import { loadMigrations } from './migrations.ts';
import type { Viewer } from '../src/index.ts';
import { EngagementsTenus } from '../src/pilotage/index.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

// Un mardi à 10 h, heure de Paris.
const TUESDAY_10H = Date.parse('2026-12-08T09:00:00.000Z');
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

async function setup(options: { writer?: { write(brief: AlertBrief): Promise<string> } } = {}) {
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  let clock = TUESDAY_10H;
  const now = (): Date => new Date(clock);
  const journal = new SqlJournalStore(db);
  const store = new FicheClient(db, { now });
  const fiche = new FicheUnique(db, store, { now });
  const acces = new Acces(db, store, fiche, journal, { now });
  const acquereurs = new FicheAcquereur(db, journal, { now });
  const blocked = new Set<string>();
  const diffusion: DiffusionGate = {
    canDiffuse: async (_n, id) => (blocked.has(id) ? { allowed: false, reason: 'withdrawal_period' } : { allowed: true, reason: 'allowed' }),
  };
  const alertes = new Alertes(db, journal, { now, diffusion, unsubscribeBase: BASE, ...(options.writer ? { writer: options.writer } : {}) });
  const network = await store.createNetwork('Réseau test');
  const alex = await store.createAgent({ networkId: network.id, firstName: 'Alex', lastName: 'Agent' });
  const direction = { role: 'direction' as const, userId: 'd1', networkId: network.id };
  let n = 0;
  /** Un acquéreur inventé, avec sa recherche, son mail et, s'il le faut, son accord pour les alertes. */
  const buyer = async (firstName: string, search: Partial<BuyerSearch>, consent: string | null = 'email') => {
    n += 1;
    const person = await store.createPerson({ networkId: network.id, agentId: alex.id, firstName });
    await store.addIdentifier({ networkId: network.id, personId: person.id, kind: 'email', value: `acheteur${n}@example.test` });
    await store.addIdentifier({ networkId: network.id, personId: person.id, kind: 'instagram', value: `acheteur_${n}` });
    if (consent) await store.addConsent({ networkId: network.id, personId: person.id, purpose: ALERT_PURPOSE, channel: consent as 'email', proof: 'formulaire de test', givenAt: new Date(TUESDAY_10H - 10 * DAY) });
    const project = await store.createProject({ networkId: network.id, agentId: alex.id, personId: person.id, kind: 'buy' });
    const r = await acquereurs.update(acces, direction, project.id, search);
    if (!r.ok) throw new Error(r.code);
    return { person, project };
  };
  const property = (ref: string, p: { city: string; price: number; surface: number; rooms: number }) =>
    store.createProperty({ networkId: network.id, agentId: alex.id, reference: ref, kind: 'home', dwelling: 'house', city: p.city, priceEur: p.price, surfaceM2: p.surface, rooms: p.rooms, status: 'available' });
  const sent = (personId?: string) =>
    db.all<{ id: string; body: string; channel: string; person_id: string }>(
      `SELECT m.id, m.body, m.channel, m.person_id FROM messages m JOIN trial_outbox t ON t.message_id = m.id ${personId ? 'WHERE m.person_id = ?' : ''} ORDER BY m.occurred_at`,
      personId ? [personId] : [],
    );
  return { db, store, journal, alertes, diffusion, network, alex, buyer, property, sent, blocked, setClock: (t: number) => (clock = t), clock: () => clock };
}

const BASE = 'https://aimmo.example.test/alertes/desinscription/';
const TALANT = { propertyKinds: ['house' as const], communes: ['Talant'], budgetMaxEur: 300_000 };
const MAISON = { city: 'Talant', price: 280_000, surface: 95, rooms: 4 };

describeWithSqlite('T03 · alertes aux acquéreurs, en mode essai', () => {
  it('une alerte seulement à l’acquéreur qui l’a demandée, avec son lien de désinscription, rangée dans la boîte d’essai [R49]', async () => {
    const t = await setup();
    const yes = await t.buyer('Inès', TALANT);
    const no = await t.buyer('Léo', TALANT, null);
    const other = await t.buyer('Noé', TALANT, null);
    await t.store.addConsent({ networkId: t.network.id, personId: other.person.id, purpose: 'suivi_estimation', channel: 'email', proof: 'test', givenAt: new Date(TUESDAY_10H - DAY) });
    const prop = await t.property('B1', MAISON);
    const outcomes = await t.alertes.forProperty(t.network.id, prop.id);
    expect(outcomes.find((o) => o.personId === yes.person.id)).toMatchObject({ status: 'sent' });
    expect(outcomes.find((o) => o.personId === no.person.id)).toMatchObject({ status: 'no_consent', rule: 'R49' });
    expect(outcomes.find((o) => o.personId === other.person.id)).toMatchObject({ status: 'no_consent' });
    const messages = await t.sent();
    expect(messages).toHaveLength(1);
    expect(messages[0]!.person_id).toBe(yes.person.id);
    expect(messages[0]!.channel).toBe('email');
    expect(messages[0]!.body).toContain('Bonjour Inès,');
    expect(messages[0]!.body).toContain('280 000 €');
    expect(messages[0]!.body).toContain('agent immobilier');
    expect(messages[0]!.body).toMatch(/Ne plus recevoir ces alertes : https:\/\/\S+\/[a-z]{32}$/);
  });

  it('le lien de désinscription retire l’accord : plus aucune alerte ensuite [R49]', async () => {
    const t = await setup();
    const b = await t.buyer('Inès', TALANT);
    const p1 = await t.property('B1', MAISON);
    await t.alertes.forProperty(t.network.id, p1.id);
    const token = /\/([a-z]{32})$/.exec((await t.sent())[0]!.body)![1]!;
    expect(await t.alertes.unsubscribe(token)).toBe(true);
    expect(await t.alertes.unsubscribe(token)).toBe(true);
    expect(await t.alertes.unsubscribe('inconnu')).toBe(false);
    const consents = await t.store.listConsents(b.person.id);
    expect(consents.every((c) => c.withdrawn_at !== null)).toBe(true);
    const p2 = await t.property('B2', { ...MAISON, price: 270_000 });
    expect(await t.alertes.forProperty(t.network.id, p2.id)).toEqual([{ propertyId: p2.id, personId: b.person.id, status: 'no_consent', rule: 'R49' }]);
    expect(await t.sent()).toHaveLength(1);
  });

  it('aucun doublon sur 30 jours, passage du planificateur toutes les heures, deux canaux d’accord et deux passages simultanés [R05]', async () => {
    const t = await setup();
    const a = await t.buyer('Inès', TALANT);
    await t.store.addConsent({ networkId: t.network.id, personId: a.person.id, purpose: ALERT_PURPOSE, channel: 'instagram', proof: 'test', givenAt: new Date(TUESDAY_10H - DAY) });
    const b = await t.buyer('Léo', TALANT);
    const props = [await t.property('B1', MAISON), await t.property('B2', { ...MAISON, price: 250_000 })];
    // Deux passages en même temps : un seul message par bien et par personne.
    await Promise.all([t.alertes.run(), t.alertes.run()]);
    const planificateur = new Planificateur(t.db, t.journal, [alertsJob(t.db, t.journal, { now: () => new Date(t.clock()), unsubscribeBase: BASE, diffusion: { canDiffuse: async () => ({ allowed: true, reason: 'allowed' }) } })], { now: () => new Date(t.clock()) });
    for (let h = 1; h <= 30 * 24; h += 1) {
      t.setClock(TUESDAY_10H + h * HOUR);
      await planificateur.tick();
    }
    for (const who of [a, b]) {
      const mine = await t.sent(who.person.id);
      expect(mine).toHaveLength(props.length);
    }
    const subjects = await t.db.all<{ person_id: string; subject: string; n: number }>('SELECT person_id, subject, count(*) AS n FROM message_subjects GROUP BY person_id, subject');
    expect(subjects).toHaveLength(4);
    for (const s of subjects) expect(Number(s.n)).toBe(1);
  });

  it('[R01] [R216] IN14 : un bien sorti la nuit ou à 19 h 30 a son alerte au passage de 8 h, dans sa limite, en mode essai', async () => {
    const t = await setup();
    await t.db.run('PRAGMA foreign_keys = OFF');
    const buyer = await t.buyer('Inès', TALANT);
    const now = () => new Date(t.clock());
    const planificateur = new Planificateur(t.db, t.journal, [alertsJob(t.db, t.journal, { now, unsubscribeBase: BASE, diffusion: t.diffusion })], { now });
    const onSale = (id: string, at: string) => t.db.run("INSERT INTO property_on_sale (property_id, network_id, mandate_id, on_sale_at, noted_at) VALUES (?, ?, 'm', ?, ?)", [id, t.network.id, at, at]);
    const count = async () => (await t.sent(buyer.person.id)).length;

    const night = await t.property('B1', MAISON);
    await onSale(night.id, '2026-12-09T02:00:00.000Z'); // mercredi, 3 h à Paris
    t.setClock(Date.parse('2026-12-09T06:05:00.000Z')); // 7 h 05 : le passage n'a pas lieu
    await planificateur.tick();
    expect(await count()).toBe(0);
    t.setClock(Date.parse('2026-12-09T07:00:05.000Z')); // 8 h 00 min 05 s
    await planificateur.tick();
    expect(await count()).toBe(1);

    const evening = await t.property('B2', { ...MAISON, price: 250_000 });
    await onSale(evening.id, '2026-12-09T18:30:00.000Z'); // 19 h 30, après le passage de 19 h
    t.setClock(Date.parse('2026-12-09T19:00:05.000Z')); // 20 h 00 min 05 s : ni passage ni envoi
    await planificateur.tick();
    expect(await count()).toBe(1);
    t.setClock(Date.parse('2026-12-10T07:00:05.000Z')); // le lendemain, 8 h 00 min 05 s
    await planificateur.tick();
    expect(await count()).toBe(2);

    const sunday = await t.property('B3', { ...MAISON, price: 240_000 });
    await onSale(sunday.id, '2026-12-13T09:00:00.000Z');
    t.setClock(Date.parse('2026-12-13T07:00:05.000Z')); // dimanche, 8 h : aucun passage
    await planificateur.tick();
    expect(await count()).toBe(2);
    t.setClock(Date.parse('2026-12-14T07:00:05.000Z')); // lundi, 8 h
    await planificateur.tick();
    expect(await count()).toBe(3);

    // Chaque message est resté en boîte d'essai, et chacun est parti dans sa limite : rien de manqué.
    t.setClock(Date.parse('2027-01-05T10:00:00.000Z'));
    const read = await new EngagementsTenus(t.db, t.journal, { now }).ofMonth({ role: 'direction', userId: 'd1', networkId: t.network.id } as Viewer, '2026-12');
    if (!read.ok) throw new Error(read.code);
    const line = read.value.lines.find((l) => l.code === 'alerte_heure')!;
    expect(line.inTrial).toBe(3);
    expect(line.missedDays).toEqual([]);
  });

  it('sans lien de désinscription réglé, aucune alerte ne part, et le journal le dit [R49]', async () => {
    const t = await setup();
    await t.buyer('Inès', TALANT);
    await t.property('B1', MAISON);
    const sans = new Alertes(t.db, t.journal, { diffusion: t.diffusion, now: () => new Date(t.clock()) });
    expect(await sans.run()).toEqual([]);
    expect(await t.sent()).toHaveLength(0);
    expect((await t.journal.all()).some((e) => e.type === 'alerte.sans_lien')).toBe(true);
    expect(() => new Alertes(t.db, t.journal, { unsubscribeBase: 'https://aimmo.example.test/v1/desinscription/' })).toThrow();
  });

  it('un refus qui tient au canal laisse essayer le canal accordé suivant [R22]', async () => {
    const t = await setup();
    const b = await t.buyer('Inès', TALANT, 'instagram');
    await t.store.addIdentifier({ networkId: t.network.id, personId: b.person.id, kind: 'phone', value: '+33 6 00 00 00 01' });
    await t.store.addConsent({ networkId: t.network.id, personId: b.person.id, purpose: ALERT_PURPOSE, channel: 'sms', proof: 'test', givenAt: new Date(TUESDAY_10H - 10 * DAY) });
    // Dernier message Instagram il y a trois jours : la fenêtre de Meta est fermée.
    await t.store.recordMessage({ networkId: t.network.id, personId: b.person.id, channel: 'instagram', direction: 'in', authorKind: 'person', body: 'Bonjour', occurredAt: new Date(TUESDAY_10H - 3 * DAY) });
    const prop = await t.property('B1', MAISON);
    expect(await t.alertes.forProperty(t.network.id, prop.id)).toMatchObject([{ status: 'sent' }]);
    const msgs = await t.sent();
    expect(msgs.map((m) => m.channel)).toEqual(['sms']);
  });

  it('un bien déjà envoyé à la personne par un autre chemin, WhatsApp de l’agent compris, bloque l’alerte [R05]', async () => {
    const t = await setup();
    const b = await t.buyer('Inès', TALANT);
    const prop = await t.property('B1', MAISON);
    const earlier = await t.store.recordMessage({ networkId: t.network.id, personId: b.person.id, channel: 'whatsapp', direction: 'out', authorKind: 'agent', body: 'Je vous envoie ce bien.', occurredAt: new Date(TUESDAY_10H - DAY) });
    await t.db.run('INSERT INTO message_subjects (message_id, network_id, person_id, subject, created_at) VALUES (?, ?, ?, ?, ?)', [earlier.id, t.network.id, b.person.id, `bien:${prop.id}`, new Date(TUESDAY_10H - DAY).toISOString()]);
    expect(await t.alertes.forProperty(t.network.id, prop.id)).toMatchObject([{ status: 'refused', rule: 'R05' }]);
    expect(await t.sent()).toHaveLength(0);
    // Refus définitif : le passage suivant ne réessaie pas.
    expect(await t.alertes.forProperty(t.network.id, prop.id)).toMatchObject([{ status: 'done' }]);
  });

  it('une désinscription pendant la rédaction l’emporte, Instagram compris [R49]', async () => {
    let withdraw: (() => Promise<void>) | null = null;
    const t = await setup({
      writer: {
        write: async () => {
          await withdraw?.();
          return 'une maison à Talant correspond à ta recherche.';
        },
      },
    });
    const b = await t.buyer('Inès', TALANT, 'instagram');
    await t.store.recordMessage({ networkId: t.network.id, personId: b.person.id, channel: 'instagram', direction: 'in', authorKind: 'person', body: 'Bonjour', occurredAt: new Date(TUESDAY_10H - HOUR) });
    withdraw = async () => {
      for (const c of await t.store.listConsents(b.person.id)) await t.store.withdrawConsent(c.id, new Date(TUESDAY_10H));
    };
    const prop = await t.property('B1', MAISON);
    expect(await t.alertes.forProperty(t.network.id, prop.id)).toMatchObject([{ status: 'refused', rule: 'R03' }]);
    expect(await t.sent()).toHaveLength(0);
  });

  it('une surface à virgule passe le contrôle des chiffres du texte de secours [R10]', async () => {
    const t = await setup();
    await t.buyer('Inès', TALANT);
    const prop = await t.property('B1', { ...MAISON, surface: 95.5 });
    expect(await t.alertes.forProperty(t.network.id, prop.id)).toMatchObject([{ status: 'sent' }]);
    expect((await t.sent())[0]!.body).toContain('95,5 m²');
  });

  it('un bien qui ne peut plus être diffusé pendant la rédaction ne part pas, et l’alerte attend [R42]', async () => {
    let block: (() => void) | null = null;
    const t = await setup({ writer: { write: async () => { block?.(); return 'une maison à Talant correspond à votre recherche.'; } } });
    await t.buyer('Inès', TALANT);
    const prop = await t.property('B1', MAISON);
    block = () => t.blocked.add(prop.id);
    expect(await t.alertes.forProperty(t.network.id, prop.id)).toMatchObject([{ status: 'waiting', rule: 'R42' }]);
    expect(await t.sent()).toHaveLength(0);
    block = null;
    t.blocked.delete(prop.id);
    expect(await t.alertes.forProperty(t.network.id, prop.id)).toMatchObject([{ status: 'sent' }]);
  });

  it('le contrôle central garde exclusions, arrêt et horaires [R01, R02, R04] ; une alerte refusée pour l’heure part au passage suivant', async () => {
    const t = await setup();
    const stop = await t.buyer('Arrêt', TALANT);
    await t.store.addExclusion({ networkId: t.network.id, personId: stop.person.id, reason: 'stop', notedAt: new Date(TUESDAY_10H - 10 * DAY) });
    const night = await t.buyer('Nuit', TALANT);
    const prop = await t.property('B1', MAISON);
    // Un dimanche à 23 h : rien ne part, l'alerte attend [R01].
    t.setClock(Date.parse('2026-12-06T22:00:00.000Z'));
    const first = await t.alertes.forProperty(t.network.id, prop.id);
    expect(first.find((o) => o.personId === night.person.id)).toMatchObject({ status: 'waiting', rule: 'R01' });
    t.setClock(TUESDAY_10H);
    const second = await t.alertes.forProperty(t.network.id, prop.id);
    expect(second.find((o) => o.personId === night.person.id)).toMatchObject({ status: 'sent' });
    // La personne qui a demandé l'arrêt n'est même pas rapprochée [R02, R04].
    expect([...first, ...second].some((o) => o.personId === stop.person.id)).toBe(false);
    expect(await t.sent(stop.person.id)).toHaveLength(0);
  });

  it('aucune alerte pour un bien que la diffusion refuse [R42], ni à un acquéreur seulement dans les tolérances', async () => {
    const t = await setup();
    await t.buyer('Inès', TALANT);
    const tol = await t.buyer('Tolérée', { ...TALANT, budgetMaxEur: 270_000 });
    const prop = await t.property('B1', MAISON);
    t.blocked.add(prop.id);
    expect(await t.alertes.forProperty(t.network.id, prop.id)).toEqual([]);
    t.blocked.delete(prop.id);
    const outcomes = await t.alertes.forProperty(t.network.id, prop.id);
    expect(outcomes).toHaveLength(1);
    expect(outcomes.some((o) => o.personId === tol.person.id)).toBe(false);
  });

  it('l’IA ne reçoit ni nom, ni coordonnée, ni adresse [R15] ; un chiffre inventé ou « gratuit » laisse la place au secours [R07, R10]', async () => {
    const briefs: AlertBrief[] = [];
    const texts = ['superbe maison de 120 m² à Talant, à voir vite.', 'estimation gratuite et maison à Talant.'];
    const t = await setup({
      writer: {
        write: async (brief) => {
          briefs.push(brief);
          return texts.shift() ?? 'une maison à Talant de 95 m² correspond à votre recherche.';
        },
      },
    });
    await t.buyer('Inès', TALANT);
    await t.buyer('Léo', TALANT);
    await t.buyer('Noé', TALANT);
    const prop = await t.property('B1', MAISON);
    await t.alertes.forProperty(t.network.id, prop.id);
    const bodies = (await t.sent()).map((m) => m.body);
    expect(bodies, JSON.stringify(bodies)).toHaveLength(3);
    expect(bodies.filter((b) => b.includes('120'))).toHaveLength(0);
    expect(bodies.filter((b) => b.includes('gratuit'))).toHaveLength(0);
    expect(bodies.filter((b) => /Bonjour \p{L}+, une maison à Talant de 95 m²/u.test(b))).toHaveLength(1);
    const brief = JSON.stringify(briefs);
    expect(brief).not.toMatch(/Inès|Léo|Noé|example\.test|acheteur|B1/);
    expect(Object.keys(briefs[0]!.property).sort()).toEqual(['bedrooms', 'city', 'features', 'kind', 'priceEur', 'rooms', 'surfaceM2']);
  });

  it('une IA en panne laisse le texte de secours ; rien de personnel au journal [R12, R13]', async () => {
    const t = await setup({ writer: { write: async () => Promise.reject(new Error('panne')) } });
    await t.buyer('Inès', TALANT);
    const prop = await t.property('B1', MAISON);
    expect(await t.alertes.forProperty(t.network.id, prop.id)).toMatchObject([{ status: 'sent' }]);
    expect((await t.sent())[0]!.body).toContain('Bonjour Inès, un bien correspond à votre recherche');
    const entries = await t.journal.all();
    expect(JSON.stringify(entries)).not.toMatch(/Inès|example\.test|280 000|Talant/);
    expect((await verifyChain(entries)).ok).toBe(true);
  });

  it('sur Instagram, le texte de secours tutoie [R08]', async () => {
    const t = await setup();
    const b = await t.buyer('Inès', TALANT, 'instagram');
    // Un message reçu récemment ouvre la fenêtre de Meta [R22].
    await t.store.recordMessage({ networkId: t.network.id, personId: b.person.id, channel: 'instagram', direction: 'in', authorKind: 'person', body: 'Bonjour', occurredAt: new Date(TUESDAY_10H - HOUR) });
    const prop = await t.property('B1', MAISON);
    expect(await t.alertes.forProperty(t.network.id, prop.id)).toMatchObject([{ status: 'sent' }]);
    const body = (await t.sent())[0]!.body;
    expect(body).toContain('correspond à ta recherche');
    expect(body).not.toMatch(/\bvous\b/);
  });
});
