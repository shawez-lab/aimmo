import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import {
  Acces,
  AppelsFiche,
  ControleEnvois,
  DecisionEnvoi,
  FakeChannel,
  FicheAgent,
  FicheClient,
  FicheUnique,
  PlanDuJour,
  SqlJournalStore,
  SqlSendJournal,
  applyMigrations,
  fromSyncSqlite,
  sequenceProspection,
  type Channel,
  type SqlDatabase,
  type Viewer,
} from '../src/index.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

const { SequencesProspection, addDays } = sequenceProspection;
type OppositionList = sequenceProspection.OppositionList;

// Un mardi, 11 h à Paris. Personnes, numéros et adresses inventés.
const START = Date.parse('2027-06-08T09:00:00.000Z');
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

class FakeOpposition implements OppositionList {
  listed = new Set<string>();
  down = false;
  asked: string[] = [];
  async check(phone: string): Promise<'listed' | 'not_listed' | 'unavailable'> {
    this.asked.push(phone);
    if (this.down) return 'unavailable';
    return this.listed.has(phone) ? 'listed' : 'not_listed';
  }
}

async function setup(options: { consents?: { channel: Channel; purpose: string }[]; opposition?: FakeOpposition | null } = {}) {
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  let clock = START;
  const now = (): Date => new Date(clock);
  const journal = new SqlJournalStore(db);
  const store = new FicheClient(db, { now });
  const unique = new FicheUnique(db, store, { now });
  const acces = new Acces(db, store, unique, journal, { now });
  const decisions = new DecisionEnvoi(db, store, unique, { now });
  const channels = (['email', 'sms', 'whatsapp', 'instagram', 'facebook', 'phone'] as Channel[]).map((c) => new FakeChannel(c));
  const controle = new ControleEnvois(db, unique, decisions, { channels, journal: new SqlSendJournal(db, undefined, now), now });
  const ficheAgent = new FicheAgent(db, acces, { now });
  const opposition = options.opposition === undefined ? new FakeOpposition() : options.opposition;
  const sequences = new SequencesProspection(db, acces, unique, controle, ficheAgent, journal, { now, ...(opposition ? { opposition } : {}) });
  const network = await store.createNetwork('Réseau test');
  const alexAgent = await store.createAgent({ networkId: network.id, firstName: 'Alex', lastName: 'Essai' });
  const samAgent = await store.createAgent({ networkId: network.id, firstName: 'Sam', lastName: 'Essai' });
  const alex: Viewer = { role: 'agent', userId: alexAgent.id, networkId: network.id };
  const sam: Viewer = { role: 'agent', userId: samAgent.id, networkId: network.id };
  const person = await store.createPerson({ networkId: network.id, agentId: alexAgent.id, firstName: 'Léa', lastName: 'Inventée' });
  await store.addIdentifier({ networkId: network.id, personId: person.id, kind: 'phone', value: '06 00 00 00 01' });
  await store.addIdentifier({ networkId: network.id, personId: person.id, kind: 'email', value: 'lea@exemple.test' });
  const given = new Date(START - 10 * DAY);
  const consents = options.consents ?? [
    { channel: 'email', purpose: 'prospecting' },
    { channel: 'sms', purpose: 'prospecting' },
    { channel: 'phone', purpose: 'prospecting' },
  ];
  for (const c of consents) await store.addConsent({ networkId: network.id, personId: person.id, purpose: c.purpose, channel: c.channel, proof: 'accord de test', givenAt: given });
  const sent = (c: Channel) => channels.find((x) => x.channel === c)!.sent;
  const allSent = () => channels.reduce((n, c) => n + c.sent.length, 0);
  const steps = async (sequenceId: string) =>
    db.all<{ position: number; channel: string; outcome: string | null; rule: string | null; message_id: string | null }>(
      'SELECT position, channel, outcome, rule, message_id FROM prospecting_sequence_steps WHERE sequence_id = ? ORDER BY position',
      [sequenceId],
    );
  const sequence = async (sequenceId: string) => db.first<{ status: string; end_reason: string | null; end_rule: string | null }>('SELECT status, end_reason, end_rule FROM prospecting_sequences WHERE id = ?', [sequenceId]);
  const startOk = async (steps: sequenceProspection.StepInput[], who = person.id) => {
    const r = await sequences.start(alex, { personId: who, steps });
    if (!r.ok) throw new Error(`${r.rule} ${r.code}`);
    return r.value.sequenceId;
  };
  return {
    db,
    store,
    unique,
    acces,
    journal,
    network,
    alex,
    sam,
    alexAgent,
    person,
    sequences,
    opposition,
    ficheAgent,
    appels: new AppelsFiche(db, acces, journal, { now }),
    sent,
    allSent,
    steps,
    sequence,
    startOk,
    setClock: (t: number) => (clock = t),
    now,
  };
}

const FULL: sequenceProspection.StepInput[] = [
  { channel: 'email', afterDays: 0, text: 'Bonjour Léa, je suis Alex, agent du quartier. Je reste à votre écoute pour votre projet.' },
  { channel: 'phone', afterDays: 2 },
  { channel: 'sms', afterDays: 7, text: 'Bonjour Léa, c’est Alex, agent du quartier. Un mot suffit si vous voulez en parler.' },
  { channel: 'letter', afterDays: 14 },
  { channel: 'door', afterDays: 21 },
];

describeWithSqlite('HX20 · séquence de prospection sur plusieurs canaux', () => {
  it('[R300] le mail du jour part par le contrôle central, avec sa finalité et son sujet, et rien d’autre ne part au départ', async () => {
    const t = await setup();
    const id = await t.startOk(FULL);
    expect(t.allSent()).toBe(0);
    expect(await t.sequences.run()).toMatchObject({ sent: 1 });
    expect(t.sent('email')).toHaveLength(1);
    expect(t.allSent()).toBe(1);
    const [first] = await t.steps(id);
    expect(first).toMatchObject({ channel: 'email', outcome: 'sent' });
    // Le message rangé est celui du contrôle central : même identifiant, sortant, à la personne.
    const msg = await t.db.first<{ direction: string; person_id: string; channel: string }>('SELECT direction, person_id, channel FROM messages WHERE id = ?', [first!.message_id]);
    expect(msg).toEqual({ direction: 'out', person_id: t.person.id, channel: 'email' });
    // Un second passage ne renvoie rien : l'étape suivante n'est pas due.
    expect(await t.sequences.run()).toMatchObject({ sent: 0 });
    expect(t.allSent()).toBe(1);
  });

  it('[R300] la séquence va au bout : chaque canal à son jour, le SMS par le contrôle central, puis elle est finie', async () => {
    const t = await setup();
    const id = await t.startOk(FULL);
    await t.sequences.run();
    // Le SMS du jour 7 attend l'appel du jour 2 : une étape à la fois.
    t.setClock(START + 7 * DAY);
    expect(await t.sequences.run()).toMatchObject({ sent: 0 });
    let today = await t.sequences.today(t.alex);
    const call = today.ok ? today.value.steps[0]! : null;
    expect(call).toMatchObject({ action: 'call', proposed: true });
    expect(await t.sequences.markDone(t.alex, call!.stepId)).toMatchObject({ ok: true });
    expect(await t.sequences.run()).toMatchObject({ sent: 1 });
    expect(t.sent('sms')).toHaveLength(1);
    t.setClock(START + 21 * DAY);
    for (const action of ['letter', 'door']) {
      today = await t.sequences.today(t.alex);
      const step = today.ok ? today.value.steps[0]! : null;
      expect(step).toMatchObject({ action, proposed: true });
      expect(await t.sequences.markDone(t.alex, step!.stepId)).toMatchObject({ ok: true, value: { finished: action === 'door' } });
    }
    expect((await t.steps(id)).map((s) => s.outcome)).toEqual(['sent', 'done', 'sent', 'done', 'done']);
    expect(await t.sequence(id)).toMatchObject({ status: 'finished' });
    expect(t.allSent()).toBe(2);
  });

  it('[R300] hors des heures d’envoi, le mail attend le passage suivant sans être perdu', async () => {
    const t = await setup();
    t.setClock(Date.parse('2027-06-12T21:00:00.000Z')); // samedi 23 h à Paris
    const id = await t.startOk(FULL.slice(0, 1));
    expect(await t.sequences.run()).toMatchObject({ sent: 0, waiting: 1 });
    expect((await t.steps(id))[0]).toMatchObject({ outcome: null });
    t.setClock(Date.parse('2027-06-14T09:00:00.000Z')); // lundi 11 h
    expect(await t.sequences.run()).toMatchObject({ sent: 1 });
    expect(await t.sequence(id)).toMatchObject({ status: 'finished' });
  });

  it('[R300] sans accord de prospection sur le canal, le contrôle refuse : rien ne part, le refus est rangé avec sa règle', async () => {
    const t = await setup({ consents: [{ channel: 'phone', purpose: 'prospecting' }] });
    const id = await t.startOk([
      { channel: 'sms', afterDays: 0, text: 'Bonjour, Alex, agent du quartier.' },
      { channel: 'letter', afterDays: 0 },
    ]);
    expect(await t.sequences.run()).toMatchObject({ sent: 0, skipped: 1 });
    expect(t.allSent()).toBe(0);
    expect(await t.steps(id)).toMatchObject([{ outcome: 'skipped', rule: 'R03', message_id: null }, { outcome: null }]);
  });

  it('[R300] la base refuse une étape « partie » sans message rangé, ou un appel noté comme envoyé', async () => {
    const t = await setup();
    const id = await t.startOk(FULL);
    await expect(t.db.run(`UPDATE prospecting_sequence_steps SET outcome = 'sent', ended_at = 'x' WHERE sequence_id = ? AND position = 1`, [id])).rejects.toThrow();
    await expect(t.db.run(`UPDATE prospecting_sequence_steps SET outcome = 'sent', ended_at = 'x', message_id = 'inconnu' WHERE sequence_id = ? AND position = 2`, [id])).rejects.toThrow();
  });

  it('[R300] le module n’appelle jamais un canal : seul le contrôle central envoie', () => {
    const source = readFileSync(new URL('../src/sequence-prospection/sequence.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/\.deliver\(/);
    expect(source).not.toMatch(/from '\.\.\/envoi\/canaux\.ts'/);
    expect(source).toMatch(/this\.controle\.send\(/);
  });

  it('[R301] une demande d’arrêt arrête la séquence sur tous les canaux, pour de bon', async () => {
    const t = await setup();
    const id = await t.startOk(FULL);
    await t.sequences.run();
    await t.store.addExclusion({ networkId: t.network.id, personId: t.person.id, reason: 'stop', channel: 'email', notedAt: new Date(START + HOUR) });
    // Plus tard, chaque canal arriverait à son jour : rien ne part, rien n'est proposé.
    for (const d of [2, 7, 14, 21]) {
      t.setClock(START + d * DAY);
      await t.sequences.run();
      const today = await t.sequences.today(t.alex);
      expect(today.ok && today.value.steps).toEqual([]);
    }
    expect(t.allSent()).toBe(1);
    expect(await t.sequence(id)).toEqual({ status: 'stopped', end_reason: 'excluded', end_rule: 'R04' });
    // Lever l'exclusion ne relance pas la séquence.
    const ex = await t.db.first<{ id: string }>('SELECT id FROM exclusions WHERE person_id = ?', [t.person.id]);
    await t.store.liftExclusion(ex!.id, new Date(START + 22 * DAY));
    t.setClock(START + 23 * DAY);
    await t.sequences.run();
    expect((await t.sequence(id))?.status).toBe('stopped');
    // Et la base refuse toute issue d'une étape d'une séquence arrêtée.
    await expect(t.db.run(`UPDATE prospecting_sequence_steps SET outcome = 'done', ended_at = 'x' WHERE sequence_id = ? AND position = 4`, [id])).rejects.toThrow();
  });

  it('[R301] la première réponse de la personne arrête tout, même sur une fiche réunie', async () => {
    const t = await setup();
    const id = await t.startOk(FULL);
    await t.sequences.run();
    const twin = await t.store.createPerson({ networkId: t.network.id, agentId: t.alexAgent.id, firstName: 'Léa', lastName: 'Inventée' });
    await t.unique.merge({ survivorId: t.person.id, mergedId: twin.id, reason: 'même personne', agentId: t.alexAgent.id });
    // La réponse arrive sur l'autre fiche, réunie à celle de la séquence.
    await t.store.recordMessage({ networkId: t.network.id, personId: twin.id, channel: 'sms', direction: 'in', authorKind: 'person', body: 'Merci, pas pour le moment.', occurredAt: new Date(START + 3 * HOUR) });
    t.setClock(START + 7 * DAY);
    await t.sequences.run();
    expect(t.sent('sms')).toHaveLength(0);
    expect(await t.sequence(id)).toMatchObject({ status: 'stopped', end_reason: 'reply' });
  });

  it('[R301] un accord retiré, un refus noté au téléphone ou la liste d’opposition arrêtent aussi tout', async () => {
    const withdrawn = await setup();
    const a = await withdrawn.startOk(FULL);
    const consent = await withdrawn.db.first<{ id: string }>(`SELECT id FROM consents WHERE person_id = ? AND channel = 'sms'`, [withdrawn.person.id]);
    await withdrawn.store.withdrawConsent(consent!.id, new Date(START + HOUR));
    withdrawn.setClock(START + 2 * HOUR);
    await withdrawn.sequences.run();
    expect(withdrawn.allSent()).toBe(0);
    expect(await withdrawn.sequence(a)).toMatchObject({ status: 'stopped', end_reason: 'withdrawn' });

    const refused = await setup();
    const b = await refused.startOk(FULL);
    await refused.sequences.run();
    refused.setClock(START + 2 * DAY);
    expect(await refused.appels.note(refused.alex, refused.person.id, { outcome: 'refused' })).toMatchObject({ ok: true });
    refused.setClock(START + 7 * DAY);
    await refused.sequences.run();
    expect(refused.sent('sms')).toHaveLength(0);
    expect(await refused.sequence(b)).toMatchObject({ status: 'stopped', end_reason: 'call_refused' });

    const listed = await setup();
    listed.opposition!.listed.add('+33600000001');
    const c = await listed.startOk(FULL);
    await listed.sequences.run();
    listed.setClock(START + 2 * DAY);
    const today = await listed.sequences.today(listed.alex);
    expect(today.ok && today.value.steps).toEqual([]);
    expect(await listed.sequence(c)).toMatchObject({ status: 'stopped', end_reason: 'opposition_list', end_rule: 'R302' });
    listed.setClock(START + 7 * DAY);
    await listed.sequences.run();
    expect(listed.sent('sms')).toHaveLength(0);
  });

  it('[R301] une personne déjà opposée ne reçoit pas de séquence ; une seule séquence en cours par fiche', async () => {
    const t = await setup();
    await t.startOk(FULL);
    expect(await t.sequences.start(t.alex, { personId: t.person.id, steps: FULL })).toMatchObject({ ok: false, code: 'already_active' });
    const other = await t.store.createPerson({ networkId: t.network.id, agentId: t.alexAgent.id, firstName: 'Noé', lastName: 'Inventé' });
    await t.store.addExclusion({ networkId: t.network.id, personId: other.id, reason: 'network_list', notedAt: new Date(START - DAY) });
    expect(await t.sequences.start(t.alex, { personId: other.id, steps: FULL })).toMatchObject({ ok: false, rule: 'R02' });
  });

  it('[R302] un appel n’est proposé que dans les heures permises, et vérifié hors de la liste d’opposition', async () => {
    const t = await setup();
    const id = await t.startOk([{ channel: 'phone', afterDays: 1 }]);
    // Le mardi : pas encore le jour.
    let today = await t.sequences.today(t.alex);
    expect(today.ok && today.value.steps).toEqual([]);
    // Le mercredi à 9 h, heure de Paris : trop tôt.
    t.setClock(START + DAY - 2 * HOUR);
    today = await t.sequences.today(t.alex);
    expect(today.ok && today.value.steps).toMatchObject([{ action: 'call', proposed: false, reason: 'outside_hours', call: null }]);
    const stepId = today.ok ? today.value.steps[0]!.stepId : '';
    expect(await t.sequences.markDone(t.alex, stepId)).toMatchObject({ ok: false, rule: 'R302', code: 'outside_hours' });
    // 13 h 30 : la pause du décret.
    t.setClock(START + DAY + 2.5 * HOUR);
    today = await t.sequences.today(t.alex);
    expect(today.ok && today.value.steps[0]).toMatchObject({ proposed: false, reason: 'outside_hours' });
    // 15 h : proposé, avec la fin du créneau.
    t.setClock(START + DAY + 4 * HOUR);
    today = await t.sequences.today(t.alex);
    expect(today.ok && today.value.steps[0]).toMatchObject({ proposed: true, call: 'tel:+33600000001', callClosesAt: '2027-06-09T18:00:00.000Z' });
    expect(t.opposition!.asked).toContain('+33600000001');
    // Le samedi : jamais.
    t.setClock(START + 4 * DAY);
    today = await t.sequences.today(t.alex);
    expect(today.ok && today.value.steps[0]).toMatchObject({ proposed: false, reason: 'outside_hours' });
    // De nouveau dans les heures : l'agent note l'appel fait, la séquence est finie.
    t.setClock(START + 6 * DAY);
    expect(await t.sequences.markDone(t.alex, stepId)).toEqual({ ok: true, value: { finished: true } });
    expect(await t.sequence(id)).toMatchObject({ status: 'finished', end_reason: 'done' });
  });

  it('[R302] sans liste d’opposition vérifiable, un appel de prospection n’est pas proposé ; une demande de rappel l’est à toute heure', async () => {
    const t = await setup({ opposition: null });
    await t.startOk([{ channel: 'phone', afterDays: 0 }]);
    let today = await t.sequences.today(t.alex);
    expect(today.ok && today.value.steps[0]).toMatchObject({ proposed: false, reason: 'opposition_unchecked' });

    const down = new FakeOpposition();
    down.down = true;
    const d = await setup({ opposition: down });
    await d.startOk([{ channel: 'phone', afterDays: 0 }]);
    today = await d.sequences.today(d.alex);
    expect(today.ok && today.value.steps[0]).toMatchObject({ proposed: false, reason: 'opposition_unchecked' });

    const asked = await setup({ opposition: null, consents: [{ channel: 'phone', purpose: 'rappel_demande' }] });
    await asked.startOk([{ channel: 'phone', afterDays: 0 }]);
    asked.setClock(START + 12 * HOUR); // 23 h, heure de Paris
    today = await asked.sequences.today(asked.alex);
    expect(today.ok && today.value.steps[0]).toMatchObject({ proposed: true, call: 'tel:+33600000001', callClosesAt: null });
  });

  it('les étapes du jour entrent dans le plan du jour (G01), courrier et porte-à-porte compris', async () => {
    const t = await setup();
    await t.startOk([
      { channel: 'letter', afterDays: 0 },
      { channel: 'door', afterDays: 3 },
    ]);
    const plan = new PlanDuJour(t.db, t.unique, { now: t.now, sequences: t.sequences });
    let r = await plan.compute(t.acces, t.alex);
    expect(r.ok && r.value.sequenceSteps).toMatchObject([{ action: 'letter', proposed: true, firstName: 'Léa' }]);
    const stepId = r.ok ? r.value.sequenceSteps![0]!.stepId : '';
    // Seul l'agent de la fiche note l'étape faite.
    expect(await t.sequences.markDone(t.sam, stepId)).toMatchObject({ ok: false, rule: 'R16' });
    expect(await t.sequences.markDone(t.alex, stepId)).toEqual({ ok: true, value: { finished: false } });
    r = await plan.compute(t.acces, t.alex);
    expect(r.ok && r.value.sequenceSteps).toEqual([]);
    t.setClock(START + 3 * DAY);
    r = await plan.compute(t.acces, t.alex);
    expect(r.ok && r.value.sequenceSteps).toMatchObject([{ action: 'door', proposed: true }]);
    // Sam n'a rien de cette séquence dans son plan.
    const other = await t.sequences.today(t.sam);
    expect(other.ok && other.value.steps).toEqual([]);
  });

  it('[R16] seul l’agent de la fiche prépare une séquence ; la direction n’en prépare pas', async () => {
    const t = await setup();
    expect(await t.sequences.start(t.sam, { personId: t.person.id, steps: FULL })).toMatchObject({ ok: false, rule: 'R16' });
    const direction: Viewer = { role: 'direction', userId: 'direction-1', networkId: t.network.id };
    expect(await t.sequences.start(direction, { personId: t.person.id, steps: FULL })).toMatchObject({ ok: false, rule: 'R16' });
    expect(await t.sequences.start(t.alex, { personId: t.person.id, steps: [{ channel: 'email', afterDays: 0 }] })).toMatchObject({ ok: false, code: 'text' });
    expect(await t.sequences.start(t.alex, { personId: t.person.id, steps: [{ channel: 'letter', afterDays: 5 }, { channel: 'door', afterDays: 2 }] })).toMatchObject({ ok: false, code: 'after_days' });
  });

  it('[R13] le journal ne garde ni texte ni coordonnée', async () => {
    const t = await setup();
    await t.startOk(FULL);
    await t.sequences.run();
    const lines = JSON.stringify((await t.journal.all()).filter((e) => e.type.startsWith('sequence.')));
    expect(lines).toContain('sequence.preparee');
    expect(lines).toContain('sequence.etape');
    expect(lines).not.toMatch(/agent du quartier|lea@|0600|Léa/);
  });

  it('addDays compte au calendrier, changement d’heure compris', () => {
    expect(addDays('2027-03-27', 1)).toBe('2027-03-28');
    expect(addDays('2027-10-30', 2)).toBe('2027-11-01');
  });
});
