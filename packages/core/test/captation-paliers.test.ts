import { expect, it } from 'vitest';
import {
  ControleEnvois,
  DecisionEnvoi,
  FakeChannel,
  FicheClient,
  FicheUnique,
  PaliersBascule,
  PaliersCanaux,
  SqlJournalStore,
  SqlSendJournal,
  applyMigrations,
  captationAutomation,
  createCaptation,
  fromSyncSqlite,
  rolloutBucket,
  trialChannels,
  type OutboundChannel,
  type OutboundChannelName,
  type SendOrder,
  type SqlDatabase,
} from '../src/index.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

// Un mardi à 10 h, heure de Paris.
const TUESDAY_10H = Date.parse('2026-12-08T09:00:00.000Z');
const HOUR = 3_600_000;
const LONG_AGO = new Date('2026-01-01T00:00:00.000Z');
const EMAIL = 'lea.exemple@example.test';

async function setup(realChannels: readonly OutboundChannel[] = []) {
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  let clock = TUESDAY_10H;
  const now = (): Date => new Date(clock);
  const journal = new SqlJournalStore(db);
  const store = new FicheClient(db, { now });
  const fiche = new FicheUnique(db, store, { now });
  const network = await store.createNetwork('Réseau test');
  const agent = await store.createAgent({ networkId: network.id, firstName: 'Paul', lastName: 'Essai' });
  const person = await store.createPerson({ networkId: network.id, agentId: agent.id, firstName: 'Léa', lastName: 'Exemple' });
  await store.addIdentifier({ networkId: network.id, personId: person.id, kind: 'email', value: EMAIL });
  await store.addIdentifier({ networkId: network.id, personId: person.id, kind: 'instagram', value: 'lea_exemple' });
  for (const purpose of ['suivi', 'review_request']) {
    await store.addConsent({ networkId: network.id, personId: person.id, purpose, channel: 'email', proof: 'formulaire test', givenAt: LONG_AGO });
  }
  const staging = new PaliersCanaux(db, journal, { now, realChannels });
  const controle = new ControleEnvois(db, fiche, new DecisionEnvoi(db, store, fiche, { now }), {
    channels: trialChannels(db, journal, now),
    journal: new SqlSendJournal(db, undefined, now),
    now,
    staging,
  });
  const order = (over: Partial<SendOrder> = {}): SendOrder => ({
    networkId: network.id,
    agentId: agent.id,
    personId: person.id,
    channel: 'email',
    kind: 'follow_up',
    purpose: 'suivi',
    subject: 'suivi:1',
    rolloutRef: 'message-1',
    fallbackTexts: ['Bonjour Léa, voici la suite de votre dossier.'],
    figures: [],
    ...over,
  });
  /** Pose directement un palier : l'avancée elle-même est éprouvée par la bascule (B04a). */
  const setStage = (channel: OutboundChannelName, stage: 'shadow' | 'ten_percent' | 'everywhere') =>
    db.run(
      `INSERT INTO automation_rollouts (network_id, automation, stage, stage_since, requests) VALUES (?, ?, ?, ?, 0)
       ON CONFLICT (network_id, automation) DO UPDATE SET stage = excluded.stage`,
      [network.id, captationAutomation(channel), stage, new Date(clock).toISOString()],
    );
  const stageOf = async (channel: OutboundChannelName) =>
    (await db.first<{ stage: string; requests: number }>('SELECT stage, requests FROM automation_rollouts WHERE network_id = ? AND automation = ?', [network.id, captationAutomation(channel)])) ?? null;
  const boxed = async () => (await db.all('SELECT message_id FROM trial_outbox')).length;
  return { db, now, journal, store, fiche, network, agent, person, staging, controle, order, setStage, stageOf, boxed, setClock: (t: number) => (clock = t) };
}

/** Une référence dont le rang tombe dans les 10 % tirés, ou hors d'eux. */
async function refIn(channel: OutboundChannelName, drawn: boolean): Promise<string> {
  for (let i = 0; ; i++) {
    const ref = `message-${i}`;
    if ((await rolloutBucket(captationAutomation(channel), ref)) < 10 === drawn) return ref;
  }
}

describeWithSqlite('C09b · le palier de chaque canal de captation', () => {
  it('[R26] sans vrai canal, rien ne part, à aucun palier', async () => {
    for (const stage of ['shadow', 'ten_percent', 'everywhere'] as const) {
      const t = await setup();
      await t.setStage('email', stage);
      const r = await t.controle.send(t.order({ rolloutRef: await refIn('email', true) }));
      expect(r, stage).toMatchObject({ status: 'sent', trial: true });
      expect(await t.boxed()).toBe(1);
    }
  });

  it('[R26] un vrai canal en essai ne reçoit rien ; partout, il reçoit tout, et plus rien ne va à la boîte', async () => {
    const real = new FakeChannel('email');
    const t = await setup([real]);
    expect(await t.controle.send(t.order())).toMatchObject({ status: 'sent', trial: true });
    expect(real.sent).toHaveLength(0);
    await t.setStage('email', 'everywhere');
    expect(await t.controle.send(t.order())).toMatchObject({ status: 'sent', trial: false });
    expect(real.sent).toHaveLength(1);
    expect(await t.boxed()).toBe(1);
  });

  it('[R26] à 10 %, le tirage est fixe par message, et sans référence rien ne part', async () => {
    const real = new FakeChannel('email');
    const t = await setup([real]);
    await t.setStage('email', 'ten_percent');
    let drawn = 0;
    for (let i = 0; i < 200; i++) {
      const first = await t.staging.route(t.network.id, 'email', `message-${i}`);
      const again = await t.staging.route(t.network.id, 'email', `message-${i}`);
      expect(again.real).toBe(first.real);
      if (first.real) drawn += 1;
    }
    expect(drawn).toBeGreaterThan(5);
    expect(drawn).toBeLessThan(45);
    expect((await t.staging.route(t.network.id, 'email', null)).real).toBeNull();
    const { rolloutRef: _none, ...unref } = t.order();
    await t.setStage('email', 'everywhere');
    expect(await t.controle.send(unref)).toMatchObject({ status: 'sent', trial: true });
    expect(real.sent).toHaveLength(0);
  });

  it('[R26] le palier compte en essai, et à 10 % seulement les messages vraiment partis', async () => {
    const real = new FakeChannel('email');
    const t = await setup([real]);
    await t.controle.send(t.order());
    expect((await t.stageOf('email'))!.requests).toBe(1);
    await t.db.run("UPDATE automation_rollouts SET stage = 'ten_percent', requests = 0");
    await t.controle.send(t.order({ subject: 'suivi:2', fallbackTexts: ['Bonjour Léa, votre dossier avance.'], rolloutRef: await refIn('email', false) }));
    expect((await t.stageOf('email'))!.requests).toBe(0);
    await t.controle.send(t.order({ subject: 'suivi:3', fallbackTexts: ['Bonjour Léa, votre dossier avance bien.'], rolloutRef: await refIn('email', true) }));
    expect((await t.stageOf('email'))!.requests).toBe(1);
    expect(real.sent).toHaveLength(1);
  });

  it('[R26] [R12] une panne ramène ce canal en essai sans toucher aux autres, et l’agent est prévenu', async () => {
    const real = new FakeChannel('email');
    const insta = new FakeChannel('instagram');
    const t = await setup([real, insta]);
    await t.setStage('email', 'everywhere');
    await t.setStage('instagram', 'everywhere');
    real.failWith = new Error(`refusé pour ${EMAIL}`);
    const failed = await t.controle.send(t.order());
    expect(failed.status).toBe('failed');
    expect((await t.stageOf('email'))!.stage).toBe('shadow');
    expect((await t.stageOf('instagram'))!.stage).toBe('everywhere');
    // Relancé : le même message reste cette fois dans la boîte d'essai, le vrai canal n'est plus appelé.
    real.failWith = null;
    expect(await t.controle.send(t.order())).toMatchObject({ status: 'sent', trial: true });
    expect(real.sent).toHaveLength(0);
    const incident = (await t.journal.all()).filter((e) => e.type === 'bascule.retour_arriere');
    expect(incident.map((e) => e.data)).toEqual([{ automation: 'captation_email', from: 'everywhere', to: 'shadow', kind: 'failure', rule: null }]);
  });

  it('[R12] par la chaîne : la réponse tombée va à l’agent, qui est alerté une fois', async () => {
    const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
    await applyMigrations(db, loadMigrations());
    const now = (): Date => new Date(TUESDAY_10H);
    const real = new FakeChannel('email');
    real.failWith = new Error('panne');
    const { chaine, store } = createCaptation(db, new SqlJournalStore(db), { now, realChannels: [real], withQualification: false, withOrigin: false });
    const network = await store.createNetwork('Réseau test');
    await db.run("INSERT INTO automation_rollouts (network_id, automation, stage, stage_since, requests) VALUES (?, 'captation_email', 'everywhere', ?, 0)", [network.id, new Date(TUESDAY_10H).toISOString()]);
    await chaine.receive(network.id, 'site_form', { submissionId: 'f-1', email: EMAIL, firstName: 'Léa', message: 'Je souhaite vendre ma maison.' });
    expect(real.sent).toHaveLength(0);
    const alerts = await db.all<{ reason: string }>('SELECT reason FROM agent_alerts');
    expect(alerts.map((a) => a.reason)).toEqual(['needs_reply']);
    expect((await db.first<{ stage: string }>("SELECT stage FROM automation_rollouts WHERE automation = 'captation_email'"))!.stage).toBe('shadow');
  });

  it('[R26] par la chaîne, sans vrai canal : la réponse est prête et reste dans la boîte', async () => {
    const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
    await applyMigrations(db, loadMigrations());
    const { chaine, store } = createCaptation(db, new SqlJournalStore(db), { now: () => new Date(TUESDAY_10H), withQualification: false, withOrigin: false });
    const network = await store.createNetwork('Réseau test');
    const results = await chaine.receive(network.id, 'site_form', { submissionId: 'f-1', email: EMAIL, firstName: 'Léa', message: 'Je souhaite vendre ma maison.' });
    expect(results[0]).toMatchObject({ status: 'replied' });
    expect(await db.all('SELECT message_id FROM trial_outbox')).toHaveLength(1);
  });

  it('[R05] un message de la boîte d’essai ne compte pas : ni pour le sujet, ni pour le texte', async () => {
    const real = new FakeChannel('email');
    const t = await setup([real]);
    expect(await t.controle.send(t.order())).toMatchObject({ status: 'sent', trial: true });
    expect(await t.controle.send(t.order())).toMatchObject({ status: 'sent', trial: true });
    await t.setStage('email', 'everywhere');
    expect(await t.controle.send(t.order())).toMatchObject({ status: 'sent', trial: false });
    expect(real.sent).toHaveLength(1);
    // Un message vraiment parti, lui, compte.
    expect(await t.controle.send(t.order())).toMatchObject({ status: 'refused', rule: 'R05' });
    expect(await t.controle.send(t.order({ subject: 'suivi:2' }))).toMatchObject({ status: 'refused', rule: 'R05' });
  });

  it('[R06] un message de la boîte d’essai ne vaut pas mention : le premier vraiment parti la porte', async () => {
    const real = new FakeChannel('email');
    const t = await setup([real]);
    expect(await t.controle.send(t.order())).toMatchObject({ trial: true, withMention: true });
    await t.setStage('email', 'everywhere');
    const first = await t.controle.send(t.order({ subject: 'suivi:2', fallbackTexts: ['Bonjour Léa, votre dossier avance.'] }));
    expect(first).toMatchObject({ trial: false, withMention: true });
    expect(real.sent[0]!.body).toContain('assistant IA de Paul');
    const second = await t.controle.send(t.order({ subject: 'suivi:3', fallbackTexts: ['Votre dossier avance bien.'] }));
    expect(second).toMatchObject({ trial: false, withMention: false });
  });

  it('[R11] un message de la boîte d’essai ne prend pas de place dans le plafond du jour', async () => {
    const real = new FakeChannel('email');
    const t = await setup([real]);
    const review = (i: number) => t.order({ kind: 'review_request', purpose: 'review_request', subject: `avis:${i}`, fallbackTexts: [`Bonjour Léa, votre avis numéro ${'abcdef'[i]} compterait.`] });
    for (let i = 0; i < 3; i++) expect(await t.controle.send(review(i)), String(i)).toMatchObject({ status: 'sent', trial: true });
    await t.setStage('email', 'everywhere');
    expect(await t.controle.send(review(3))).toMatchObject({ status: 'sent', trial: false });
    expect(await t.controle.send(review(4))).toMatchObject({ status: 'sent', trial: false });
    expect(await t.controle.send(review(5))).toMatchObject({ status: 'refused', rule: 'R11' });
  });

  it('[R22] un message de la boîte d’essai ne rouvre ni ne ferme la fenêtre de 24 heures', async () => {
    const t = await setup();
    await t.store.recordMessage({ networkId: t.network.id, personId: t.person.id, conversationId: 'instagram:fil-1', channel: 'instagram', direction: 'in', authorKind: 'person', body: 'Bonjour', occurredAt: new Date(TUESDAY_10H) });
    const order = t.order({ channel: 'instagram', kind: 'reply', conversationId: 'instagram:fil-1', subject: undefined, purpose: undefined as unknown as string, fallbackTexts: ['Merci pour ton message.'] });
    expect(await t.controle.send(order)).toMatchObject({ status: 'sent', trial: true });
    t.setClock(TUESDAY_10H + 23 * HOUR);
    expect(await t.controle.send(order)).toMatchObject({ status: 'sent', trial: true });
    t.setClock(TUESDAY_10H + 25 * HOUR);
    expect(await t.controle.send(order)).toMatchObject({ status: 'refused', rule: 'R22' });
  });

  it('[R13] le journal ne porte ni adresse, ni texte, même quand le canal tombe en citant l’adresse', async () => {
    const real = new FakeChannel('email');
    const t = await setup([real]);
    await t.setStage('email', 'everywhere');
    real.failWith = new Error(`refusé pour ${EMAIL}`);
    await t.controle.send(t.order());
    await t.controle.send(t.order());
    const dump = JSON.stringify(await t.journal.all());
    for (const secret of [EMAIL, 'voici la suite', 'lea_exemple']) expect(dump).not.toContain(secret);
    const log = JSON.stringify(await t.db.all('SELECT * FROM send_log'));
    expect(log).not.toContain(EMAIL);
  });

  it('[R26] le passage d’un canal à 10 % reste un geste de la direction, fermé par défaut', async () => {
    const t = await setup([new FakeChannel('email')]);
    const direction = { role: 'direction', userId: 'direction-test', networkId: t.network.id } as never;
    const closed = new PaliersBascule(t.db, t.journal, { now: t.now });
    expect(await closed.advance(direction, captationAutomation('email'))).toEqual({ ok: false, rule: 'R26', code: 'not_open' });
  });

  it('sans palier, le contrôle reste ce qu’il était : un message de la boîte compte [R05]', async () => {
    const t = await setup();
    const plain = new ControleEnvois(t.db, t.fiche, new DecisionEnvoi(t.db, t.store, t.fiche, { now: t.now }), {
      channels: trialChannels(t.db, t.journal, t.now),
      journal: new SqlSendJournal(t.db, undefined, t.now),
      now: t.now,
    });
    const first = await plain.send(t.order());
    expect(first.status).toBe('sent');
    expect(first.trial).toBeUndefined();
    expect(await plain.send(t.order())).toMatchObject({ status: 'refused', rule: 'R05' });
  });
});
