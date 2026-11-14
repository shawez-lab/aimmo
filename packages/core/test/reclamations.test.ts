import { expect, it } from 'vitest';
import { ControleEnvois, DecisionEnvoi, FakeChannel, FicheUnique, SqlSendJournal, verifyChain, type Channel, type Viewer } from '../src/index.ts';
import { Reclamations, complaintsJob, mediatorOfferText, type Complaint } from '../src/securite/index.ts';
import { setupAnnonce } from './annonces-jeu.ts';
import { describeWithSqlite } from './sqlite.ts';

// Clients, agents, direction et médiateur inventés. Le mardi 9 mars 2027, à 10 h à Paris.
const NOW = new Date('2027-03-09T09:00:00.000Z');
const at = (day: string, hour = '10:00') => new Date(`${day}T${hour}:00+01:00`);
const MEDIATOR = { responseDays: 30, mediatorName: 'Médiation Exemple', mediatorSite: 'https://mediation.example.test' };

async function setup() {
  const t = await setupAnnonce();
  t.setClock(NOW);
  const fiche = new FicheUnique(t.db, t.store, { now: t.now });
  const decisions = new DecisionEnvoi(t.db, t.store, fiche, { now: t.now });
  const outbox = (['email', 'sms'] as Channel[]).map((c) => new FakeChannel(c));
  const controle = new ControleEnvois(t.db, fiche, decisions, { channels: outbox, journal: new SqlSendJournal(t.db), budget: { allows: async () => false }, now: t.now });
  await t.store.addIdentifier({ networkId: t.network.id, personId: t.personId, kind: 'email', value: 'lea.exemple@example.test' });
  const reclamations = new Reclamations(t.db, t.acces, t.journal, { now: t.now, send: (o) => controle.send(o) });
  const as = (role: string, userId: string): Viewer => ({ role, userId, networkId: t.network.id }) as Viewer;
  /** Un mail du client, reçu à `when`, dans la conversation `conv`. */
  const mailIn = (conv: string, when: Date) =>
    t.store.recordMessage({ networkId: t.network.id, agentId: t.alexId, personId: t.personId, conversationId: conv, channel: 'email', direction: 'in', authorKind: 'person', body: 'Je ne suis pas satisfaite du suivi.', occurredAt: when });
  const record = async (input: Parameters<Reclamations['record']>[2]) => {
    const r = await reclamations.record(t.agent, t.personId, input);
    if (!r.ok) throw new Error(r.code);
    return r.value;
  };
  return { ...t, reclamations, outbox, mailIn, record, compliance: as('compliance', 'conformite-1'), partner: as('partner', 'partenaire-1') };
}

const one = async (t: Awaited<ReturnType<typeof setup>>, id: string): Promise<Complaint> => {
  const l = await t.reclamations.list(t.direction);
  if (!l.ok) throw new Error(l.code);
  return l.value.find((c) => c.complaintId === id)!;
};

describeWithSqlite('HX58 · réclamations des clients et médiateur', () => {
  it('[R606] chaque réclamation a son échéance, écrite par la base, et ses alertes à 7 jours, 2 jours et le jour même, une fois chacune', async () => {
    const t = await setup();
    expect(await t.reclamations.configure(t.direction, MEDIATOR)).toEqual({ ok: true, version: 1 });
    const c = await t.record({ receivedOn: '2027-03-09', receivedBy: 'courrier', summary: 'Visites trop rares.' });
    expect(c).toMatchObject({ receivedOn: '2027-03-09', responseDays: 30, dueOn: '2027-04-08', status: 'ouverte', alerts: [], mediator: null });
    const days: [string, string[]][] = [
      ['2027-03-31', []],
      ['2027-04-01', ['j7']],
      ['2027-04-05', ['j7']],
      ['2027-04-06', ['j7', 'j2']],
      ['2027-04-07', ['j7', 'j2']],
      ['2027-04-08', ['j7', 'j2', 'echeance', 'a_remettre']],
      ['2027-04-09', ['j7', 'j2', 'echeance', 'a_remettre']],
    ];
    for (const [day, kinds] of days) {
      t.setClock(at(day));
      await t.reclamations.tick(t.network.id);
      await t.reclamations.tick(t.network.id);
      expect((await one(t, c.complaintId)).alerts.map((a) => a.kind)).toEqual(kinds);
    }
    // La base écrit l'échéance et ne la laisse pas changer.
    await expect(t.db.run("UPDATE complaints SET due_on = '2027-05-01'")).rejects.toThrow('ne change plus');
    await expect(
      t.db.run(
        "INSERT INTO complaints (id, network_id, person_id, agent_id, received_on, received_via, summary, response_days, due_on, recorded_by, recorded_at) VALUES ('c-x', ?, ?, NULL, '2027-03-01', 'oral', 'x', 30, '2027-05-01', 'x', 'x')",
        [t.network.id, t.personId],
      ),
    ).rejects.toThrow('CHECK');
    await expect(t.db.run('DELETE FROM complaint_alerts')).rejects.toThrow('rien ne s');
    // Sans réglage, le délai par défaut : 30 jours.
    expect((await t.record({ receivedOn: '2027-04-09', receivedBy: 'oral', summary: 'Retard.' })).dueOn).toBe('2027-05-09');
  });

  it('[R606] une réponse réglée avant l’échéance arrête les alertes, sans médiateur ; une réponse antidatée ou deux réponses sont refusées', async () => {
    const t = await setup();
    await t.reclamations.configure(t.direction, MEDIATOR);
    const c = await t.record({ receivedOn: '2027-03-09', receivedBy: 'courrier', summary: 'Visites trop rares.' });
    t.setClock(at('2027-04-02'));
    await t.reclamations.tick(t.network.id);
    expect(await t.reclamations.answer(t.agent, c.complaintId, { outcome: 'reglee', note: 'Visites chaque semaine, accord de la cliente.' })).toMatchObject({ ok: true, value: { status: 'reglee', answer: { answeredOn: '2027-04-02', late: false } } });
    expect(await t.reclamations.answer(t.agent, c.complaintId, { outcome: 'non_reglee', note: 'x' })).toEqual({ ok: false, rule: null, code: 'already_answered' });
    t.setClock(at('2027-04-20'));
    await t.reclamations.tick(t.network.id);
    expect(await one(t, c.complaintId)).toMatchObject({ alerts: [{ kind: 'j7' }], mediator: null });
    await expect(
      t.db.run("INSERT INTO complaint_mediator_offers (complaint_id, network_id, cause, settings_version, text, status, created_on, created_at) VALUES (?, ?, 'echeance', 1, 'x', 'a_remettre', '2027-04-20', 'x')", [c.complaintId, t.network.id]),
    ).rejects.toThrow('R607');
    const d = await t.record({ receivedOn: '2027-04-10', receivedBy: 'oral', summary: 'Autre.' });
    await expect(
      t.db.run("INSERT INTO complaint_answers (complaint_id, network_id, outcome, note, answered_on, late, answered_by, at) VALUES (?, ?, 'reglee', 'x', '2027-04-01', 0, 'x', 'x')", [d.complaintId, t.network.id]),
    ).rejects.toThrow('R606');
    // Le jour de Paris de l'écriture, ni la veille ni le lendemain, heure d'hiver comme d'été.
    const direct = (day: string, iso: string, late: number) =>
      t.db.run("INSERT INTO complaint_answers (complaint_id, network_id, outcome, note, answered_on, late, answered_by, at) VALUES (?, ?, 'reglee', 'x', ?, ?, 'x', ?)", [d.complaintId, t.network.id, day, late, iso]);
    await expect(direct('2027-05-10', '2027-05-11T12:00:00.000Z', 0)).rejects.toThrow('R606');
    await expect(direct('2027-05-11', '2027-05-10T12:00:00.000Z', 1)).rejects.toThrow('R606');
    await expect(direct('2027-06-30', '2027-06-30T22:30:00.000Z', 1)).rejects.toThrow('R606');
    await expect(direct('2027-07-01', '2027-06-30T22:30:00.000Z', 1)).resolves.toMatchObject({ changes: 1 });
  });

  it('[R607] Jamais vu : à l’échéance sans réponse réglée, le médiateur est proposé de lui-même, par le contrôle central, en réponse dans la conversation', async () => {
    const t = await setup();
    await t.reclamations.configure(t.direction, MEDIATOR);
    await t.mailIn('conv-reclamation', at('2027-03-09', '09:30'));
    const c = await t.record({ receivedOn: '2027-03-09', receivedBy: 'mail', summary: 'Suivi insuffisant.', reply: { channel: 'email', conversationId: 'conv-reclamation' } });
    t.setClock(at('2027-04-07'));
    expect(await t.reclamations.tick(t.network.id)).toMatchObject({ offers: 0 });
    expect(t.outbox[0]!.sent).toHaveLength(0);
    t.setClock(at('2027-04-08'));
    expect(await t.reclamations.tick(t.network.id)).toMatchObject({ offers: 1 });
    expect(await t.reclamations.tick(t.network.id)).toMatchObject({ offers: 0 });
    const text = mediatorOfferText({ name: 'Médiation Exemple', site: 'https://mediation.example.test' }, 'Léa');
    expect(text.startsWith('Bonjour Léa, ')).toBe(true);
    expect(t.outbox[0]!.sent.map((m) => m.to)).toEqual(['lea.exemple@example.test']);
    expect(t.outbox[0]!.sent[0]!.body).toContain(text);
    expect(await one(t, c.complaintId)).toMatchObject({ mediator: { cause: 'echeance', status: 'envoye', text, createdOn: '2027-04-08' }, alerts: [{ kind: 'j7' }, { kind: 'j2' }, { kind: 'echeance' }] });
    // Une réponse réglée en retard ne retire pas la proposition ; elle est notée en retard.
    t.setClock(at('2027-04-10'));
    expect(await t.reclamations.answer(t.agent, c.complaintId, { outcome: 'reglee', note: 'Accord trouvé.' })).toMatchObject({ ok: true, value: { answer: { late: true }, mediator: { status: 'envoye' } } });
    await expect(t.db.run("UPDATE complaint_mediator_offers SET status = 'remis', handed_at = 'x', handed_by = 'x'")).rejects.toThrow('R607');
  });

  it('[R607] une réponse « non réglée » propose le médiateur aussitôt ; un envoi impossible est à remettre par l’agent, qui note la remise', async () => {
    const t = await setup();
    await t.reclamations.configure(t.direction, MEDIATOR);
    const c = await t.record({ receivedOn: '2027-03-09', receivedBy: 'courrier', summary: 'Honoraires contestés.' });
    const r = await t.reclamations.answer(t.agent, c.complaintId, { outcome: 'non_reglee', note: 'Les honoraires restent ceux du mandat.' });
    expect(r).toMatchObject({ ok: true, value: { status: 'non_reglee', mediator: { cause: 'non_reglee', status: 'a_remettre', createdOn: '2027-03-09' }, alerts: [{ kind: 'a_remettre' }] } });
    expect(t.outbox.flatMap((c) => c.sent)).toHaveLength(0);
    // Par mail, mais l'agent a déjà répondu dans la conversation : le contrôle se tait [R21], l'agent la remet.
    await t.mailIn('conv-2', at('2027-03-09', '08:00'));
    await t.store.recordMessage({ networkId: t.network.id, agentId: t.alexId, personId: t.personId, conversationId: 'conv-2', channel: 'email', direction: 'out', authorKind: 'agent', body: 'Bien reçu.', occurredAt: at('2027-03-09', '08:30') });
    const d = await t.record({ receivedOn: '2027-03-09', receivedBy: 'mail', summary: 'Autre point.', reply: { channel: 'email', conversationId: 'conv-2' } });
    const rd = await t.reclamations.answer(t.agent, d.complaintId, { outcome: 'non_reglee', note: 'Refus.' });
    expect(rd).toMatchObject({ ok: true, value: { mediator: { status: 'a_remettre', sendRule: 'R21' }, alerts: [{ kind: 'a_remettre' }] } });
    expect(await t.reclamations.handed(t.sam, c.complaintId)).toEqual({ ok: false, rule: 'R16', code: 'not_assigned' });
    expect(await t.reclamations.handed(t.agent, c.complaintId)).toMatchObject({ ok: true, value: { mediator: { status: 'remis' } } });
    expect(await t.reclamations.handed(t.agent, c.complaintId)).toEqual({ ok: false, rule: null, code: 'nothing_to_hand' });
  });

  it('[R607] un médiateur dont le nom ou le site porte des chiffres est proposé quand même', async () => {
    const t = await setup();
    await t.reclamations.configure(t.direction, { responseDays: 30, mediatorName: 'Médiation 21 Exemple', mediatorSite: 'https://mediation2.example.test' });
    await t.mailIn('conv-21', at('2027-03-09', '09:30'));
    const c = await t.record({ receivedOn: '2027-03-09', receivedBy: 'mail', summary: 'Suivi.', reply: { channel: 'email', conversationId: 'conv-21' } });
    t.setClock(at('2027-04-08'));
    await t.reclamations.tick(t.network.id);
    expect(await one(t, c.complaintId)).toMatchObject({ mediator: { status: 'envoye' } });
    expect(t.outbox[0]!.sent[0]!.body).toContain('Médiation 21 Exemple, https://mediation2.example.test');
  });

  it('[R607] en mode essai, rien ne part vraiment : la proposition reste à remettre, l’agent est alerté', async () => {
    const t = await setup();
    const trial = new Reclamations(t.db, t.acces, t.journal, { now: t.now });
    await trial.configure(t.direction, MEDIATOR);
    await t.mailIn('conv-essai', at('2027-03-09', '09:30'));
    const r = await trial.record(t.agent, t.personId, { receivedOn: '2027-03-09', receivedBy: 'mail', summary: 'Suivi.', reply: { channel: 'email', conversationId: 'conv-essai' } });
    if (!r.ok) throw new Error(r.code);
    t.setClock(at('2027-04-08'));
    await trial.tick(t.network.id);
    const l = await trial.list(t.direction);
    expect(l.ok && l.value[0]).toMatchObject({ mediator: { status: 'a_remettre', sendRule: 'R26' }, alerts: expect.arrayContaining([{ kind: 'a_remettre', createdOn: '2027-04-08' }]) });
  });

  it('[R607] un envoi interrompu n’est jamais renvoyé : une heure après, la proposition est à remettre, l’agent alerté', async () => {
    const t = await setup();
    let calls = 0;
    const broken = new Reclamations(t.db, t.acces, t.journal, { now: t.now, send: async () => { calls++; throw new Error('Worker interrompu'); } });
    await broken.configure(t.direction, MEDIATOR);
    await t.mailIn('conv-x', at('2027-03-09', '09:30'));
    const r = await broken.record(t.agent, t.personId, { receivedOn: '2027-03-09', receivedBy: 'mail', summary: 'Suivi.', reply: { channel: 'email', conversationId: 'conv-x' } });
    if (!r.ok) throw new Error(r.code);
    t.setClock(at('2027-04-08'));
    await expect(broken.tick(t.network.id)).rejects.toThrow('Worker interrompu');
    await broken.tick(t.network.id);
    expect(calls).toBe(1);
    t.setClock(at('2027-04-08', '11:30'));
    await broken.tick(t.network.id);
    expect(calls).toBe(1);
    expect(await one(t, r.value.complaintId)).toMatchObject({ mediator: { status: 'a_remettre', sendRule: 'interrompu' }, alerts: expect.arrayContaining([{ kind: 'a_remettre', createdOn: '2027-04-08' }]) });
  });

  it('[R607] sans médiateur réglé, rien n’est inventé : la direction est alertée, la proposition part après le réglage', async () => {
    const t = await setup();
    const c = await t.record({ receivedOn: '2027-03-09', receivedBy: 'courrier', summary: 'Visites trop rares.' });
    t.setClock(at('2027-04-08'));
    await t.reclamations.tick(t.network.id);
    expect(await one(t, c.complaintId)).toMatchObject({ mediator: null, alerts: [{ kind: 'j7' }, { kind: 'j2' }, { kind: 'echeance' }, { kind: 'mediateur_manquant' }] });
    expect(await t.reclamations.configure(t.agent, MEDIATOR)).toEqual({ ok: false, rule: 'R16', code: 'role' });
    for (const bad of [{ ...MEDIATOR, responseDays: 0 }, { ...MEDIATOR, mediatorName: ' ' }, { ...MEDIATOR, mediatorSite: 'http://mediation.example.test' }, { ...MEDIATOR, mediatorSite: 'pas une adresse' }]) {
      expect(await t.reclamations.configure(t.direction, bad)).toMatchObject({ ok: false, rule: null });
    }
    await t.reclamations.configure(t.direction, MEDIATOR);
    // Le passage planifié de chaque réseau.
    t.setClock(at('2027-04-09'));
    await complaintsJob(t.db, t.journal, t.acces, { now: t.now }).run({} as never);
    expect(await one(t, c.complaintId)).toMatchObject({ mediator: { cause: 'echeance', status: 'a_remettre' } });
  });

  it('[R607] BR70 · la direction seule relit le réglage en service : rien d’inventé sans réglage, les réclamations en attente comptées', async () => {
    const t = await setup();
    expect(await t.reclamations.currentSettings(t.direction)).toEqual({
      ok: true,
      value: { version: null, setAt: null, responseDays: 30, mediator: null, offerText: null, waitingForMediator: 0 },
    });
    const c = await t.record({ receivedOn: '2027-03-09', receivedBy: 'courrier', summary: 'Visites trop rares.' });
    t.setClock(at('2027-04-08'));
    await t.reclamations.tick(t.network.id);
    await t.reclamations.tick(t.network.id);
    expect(await t.reclamations.currentSettings(t.direction)).toMatchObject({ ok: true, value: { mediator: null, offerText: null, waitingForMediator: 1 } });
    for (const v of [t.agent, t.compliance, t.partner]) {
      const before = (await t.journal.all()).filter((e) => e.type === 'acces.refuse').length;
      expect(await t.reclamations.currentSettings(v)).toEqual({ ok: false, rule: 'R16', code: 'role' });
      expect((await t.journal.all()).filter((e) => e.type === 'acces.refuse').length).toBe(before + 1);
    }
    await t.reclamations.configure(t.direction, { ...MEDIATOR, responseDays: 21 });
    const read = await t.reclamations.currentSettings(t.direction);
    expect(read).toEqual({
      ok: true,
      value: {
        version: 1,
        setAt: at('2027-04-08').toISOString(),
        responseDays: 21,
        mediator: { name: 'Médiation Exemple', site: 'https://mediation.example.test' },
        offerText: mediatorOfferText({ name: 'Médiation Exemple', site: 'https://mediation.example.test' }),
        waitingForMediator: 1,
      },
    });
    // Ni motif ni nom de client dans la lecture [R13].
    expect(JSON.stringify(read)).not.toContain('Visites');
    // Le passage fait la proposition : plus rien n'attend.
    await t.reclamations.tick(t.network.id);
    expect((await one(t, c.complaintId)).mediator).not.toBeNull();
    expect(await t.reclamations.currentSettings(t.direction)).toMatchObject({ ok: true, value: { waitingForMediator: 0 } });
    await t.reclamations.configure(t.direction, { responseDays: 45, mediatorName: 'Médiation 21 Exemple', mediatorSite: 'https://mediation2.example.test' });
    expect(await t.reclamations.currentSettings(t.direction)).toMatchObject({ ok: true, value: { version: 2, responseDays: 45, mediator: { name: 'Médiation 21 Exemple' } } });
  });

  it('[R16] une réclamation d’une fiche réunie, même par plusieurs fusions, est dans la liste de l’agent du groupe', async () => {
    const t = await setup();
    const a = await t.store.createPerson({ networkId: t.network.id, firstName: 'Fiche', lastName: 'Ancienne' });
    const b = await t.store.createPerson({ networkId: t.network.id, firstName: 'Fiche', lastName: 'Intermédiaire' });
    const r = await t.reclamations.record(t.direction, a.id, { receivedOn: '2027-03-09', receivedBy: 'oral', summary: 'Ancienne fiche.' });
    if (!r.ok) throw new Error(r.code);
    const unique = new FicheUnique(t.db, t.store, { now: t.now });
    await unique.merge({ survivorId: b.id, mergedId: a.id, reason: 'même mail' });
    await unique.merge({ survivorId: t.personId, mergedId: b.id, reason: 'même téléphone' });
    const l = await t.reclamations.list(t.agent);
    expect(l.ok && l.value.map((c) => c.complaintId)).toEqual([r.value.complaintId]);
  });

  it('[R606] [R16] seuls l’agent qui suit la fiche et la direction rangent et lisent ; le journal ne garde que des codes', async () => {
    const t = await setup();
    for (const v of [t.sam, t.compliance, t.partner]) {
      const r = await t.reclamations.record(v, t.personId, { receivedOn: '2027-03-09', receivedBy: 'oral', summary: 'x' });
      expect(r.ok).toBe(false);
    }
    expect(await t.reclamations.record(t.agent, t.personId, { receivedOn: '2027-03-10', receivedBy: 'oral', summary: 'x' })).toEqual({ ok: false, rule: null, code: 'future_date' });
    expect(await t.reclamations.record(t.agent, t.personId, { receivedOn: '2027-02-30', receivedBy: 'oral', summary: 'x' })).toEqual({ ok: false, rule: null, code: 'bad_date' });
    for (const day of ['2027-13-01', '2027-03-32', '9 mars']) expect(await t.reclamations.record(t.agent, t.personId, { receivedOn: day, receivedBy: 'oral', summary: 'x' })).toEqual({ ok: false, rule: null, code: 'bad_date' });
    expect(await t.reclamations.record(t.agent, t.personId, { receivedOn: '2027-03-09', receivedBy: 'oral', summary: 'x', reply: { channel: 'email', conversationId: 'c' } })).toEqual({ ok: false, rule: null, code: 'bad_reply' });
    const c = await t.record({ receivedOn: '2027-03-09', receivedBy: 'oral', summary: 'Motif confidentiel.' });
    const before = (await t.journal.all()).length;
    expect(await t.reclamations.list(t.sam)).toEqual({ ok: true, value: [] });
    // Sam ne suit pas la fiche : sa liste ne tente aucune lecture, le journal n'écrit aucun faux refus.
    expect((await t.journal.all()).length).toBe(before);
    // La direction lit : la lecture de la fiche est écrite au journal avant que rien ne soit rendu.
    await t.reclamations.list(t.direction);
    expect((await t.journal.all()).slice(before).map((e) => [e.type, e.subject])).toEqual([['fiche.lue', `person:${t.personId}`]]);
    expect(await t.reclamations.list(t.compliance)).toEqual({ ok: false, rule: 'R16', code: 'role' });
    expect(await t.reclamations.answer(t.sam, c.complaintId, { outcome: 'reglee', note: 'x' })).toEqual({ ok: false, rule: 'R16', code: 'not_assigned' });
    expect((await t.reclamations.list(t.agent)).ok && ((await t.reclamations.list(t.agent)) as { value: Complaint[] }).value.map((x) => x.complaintId)).toEqual([c.complaintId]);
    await t.reclamations.answer(t.direction, c.complaintId, { outcome: 'non_reglee', note: 'Réponse confidentielle.' });
    const all = await t.journal.all();
    const text = JSON.stringify(all);
    for (const word of ['confidentiel', 'Médiation', 'mediation.example']) expect(text).not.toContain(word);
    expect(all.filter((e) => e.type.startsWith('reclamation.')).every((e) => (e.subject ?? '').startsWith('complaint:') || (e.subject ?? '').startsWith('network:'))).toBe(true);
    expect(await verifyChain(all)).toMatchObject({ ok: true });
  });
});

it('[R607] le texte du médiateur est écrit par le code, sans chiffre, avec le nom et le site', () => {
  const text = mediatorOfferText({ name: 'Médiation Exemple', site: 'https://mediation.example.test' });
  expect(text).toContain('Médiation Exemple, https://mediation.example.test');
  expect(text).toContain('sans frais pour vous');
  expect(text).not.toMatch(/gratuit/i);
  expect(text).toContain('un an à compter de votre réclamation écrite');
  expect(text.replace('https://mediation.example.test', '')).not.toMatch(/\d/);
});
