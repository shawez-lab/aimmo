import { expect, it } from 'vitest';
import { Remerciements, THANK_YOU_JOB, THANK_YOU_PURPOSE, thankYouGreeted, thankYouJob, thankYouText, type ClosedSale } from '../src/apres-vente/index.ts';
import { checkText } from '../src/envoi/texte.ts';
import { FicheClient } from '../src/db/fiche-client.ts';
import { FicheUnique } from '../src/fiche/fusion.ts';
import { mergeWithDouble } from './doublon.ts';
import { setupAnnonce } from './annonces-jeu.ts';
import { FakeDossiersClos } from './apres-vente-jeu.ts';
import { describeWithSqlite } from './sqlite.ts';

// Mars 2027, avant le passage à l'heure d'été : Paris = UTC+1.
const paris = (day: string, hour: number, minute = 0) => new Date(`${day}T${String(hour - 1).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00.000Z`);

it('[R08] [R10] le message préparé est écrit par le code et passe le contrôle du texte', () => {
  for (const side of ['vendeur', 'acquereur'] as const) {
    const text = thankYouText('Léa', side, { city: 'Dijon', reference: 'REF-T-1' });
    expect(text.startsWith('Bonjour Léa, merci pour votre confiance')).toBe(true);
    expect(checkText(text, { audience: 'client', channel: 'email', figures: [1], firstOfConversation: true, firstName: 'Léa' })).toEqual([]);
  }
  expect(thankYouText(null, 'acquereur', { city: null, reference: 'A' })).toContain("l'achat de votre bien, référence A.");
  const job = thankYouJob(undefined as never, undefined as never, new FakeDossiersClos());
  expect(job.name).toBe(THANK_YOU_JOB);
  expect(job.weekdays).toEqual([1, 2, 3, 4, 5, 6]);
  expect(Math.max(...job.hours)).toBeLessThan(20);
});

it('SV13 · seule la salutation suit le prénom d’aujourd’hui, le reste du message préparé ne bouge pas', () => {
  const draft = thankYouText('Léa', 'vendeur', { city: 'Dijon', reference: 'REF-T-1' });
  expect(thankYouGreeted(draft, 'Lia')).toBe(thankYouText('Lia', 'vendeur', { city: 'Dijon', reference: 'REF-T-1' }));
  expect(thankYouGreeted(draft, null)).toBe(thankYouText(null, 'vendeur', { city: 'Dijon', reference: 'REF-T-1' }));
  expect(thankYouGreeted(thankYouText(null, 'vendeur', { city: 'Dijon', reference: 'REF-T-1' }), 'Lia')).toBe(thankYouText('Lia', 'vendeur', { city: 'Dijon', reference: 'REF-T-1' }));
  expect(thankYouGreeted(draft, 'L$&a')).toContain('Bonjour L$&a,');
});

describeWithSqlite('F03 · remerciement : l’agent appelle, le message est préparé', () => {
  let n = 0;
  async function setup() {
    const t = await setupAnnonce();
    const dossiers = new FakeDossiersClos();
    const merci = new Remerciements(t.db, t.journal, dossiers, { now: t.now });
    const client = async (firstName: string, lastName = 'Exemple') => {
      n += 1;
      const p = await t.store.createPerson({ networkId: t.network.id, agentId: t.alexId, firstName, lastName });
      await t.store.addIdentifier({ networkId: t.network.id, personId: p.id, kind: 'email', value: `merci${n}@example.test` });
      await t.store.addConsent({ networkId: t.network.id, personId: p.id, purpose: THANK_YOU_PURPOSE, channel: 'email', proof: 'mandat', givenAt: new Date('2027-02-10T09:00:00.000Z') });
      return p.id;
    };
    const close = (fileId: string, closedOn: string, clients: ClosedSale['clients']) => dossiers.sales.push({ fileId, agentId: t.alexId, closedOn, city: 'Dijon', reference: `REF-${fileId}`, clients });
    const outbox = async () => (await t.db.first<{ n: number }>('SELECT COUNT(*) AS n FROM trial_outbox'))?.n ?? 0;
    const inbox = (personId: string) => t.db.all<{ body: string }>('SELECT m.body FROM messages m JOIN trial_outbox o ON o.message_id = m.id WHERE m.person_id = ?', [personId]);
    return { ...t, dossiers, merci, client, close, outbox, inbox };
  }

  it('[R18] une tâche par client et par dossier, fiches réunies comprises ; aucune en double, passage après passage', async () => {
    const t = await setup();
    const s = await t.client('Sara', 'Vend');
    const b = await t.client('Bruno', 'Achat');
    const b2 = await t.client('Bruno', 'Achat');
    await new FicheUnique(t.db, new FicheClient(t.db, { now: t.now }), { now: t.now }).merge({ survivorId: b, mergedId: b2, reason: 'même personne, test' });
    t.close('f1', '2027-03-08', [{ personId: s, side: 'vendeur' }, { personId: b, side: 'acquereur' }, { personId: b2, side: 'acquereur' }]);
    t.close('f2', '2027-03-09', [{ personId: s, side: 'acquereur' }]);
    for (const at of [paris('2027-03-08', 18), paris('2027-03-09', 9), paris('2027-03-09', 15), paris('2027-03-10', 9)]) {
      t.setClock(at);
      await t.merci.run(t.network.id);
    }
    const list = await t.merci.list(t.agent);
    expect(list.ok && list.value.map((x) => [x.fileId, x.side, x.firstName])).toEqual([
      ['f1', 'acquereur', 'Bruno'],
      ['f1', 'vendeur', 'Sara'],
      ['f2', 'acquereur', 'Sara'],
    ]);
    expect(list.ok && list.value.every((x) => x.decision === null && x.calledAt === null && x.sendStatus === null)).toBe(true);
    // Rien ne part tant que l'agent n'a pas validé.
    expect(await t.outbox()).toBe(0);
    // Le message préparé ne nomme jamais un client de l'autre côté [R19].
    const forSara = list.ok ? list.value.find((x) => x.fileId === 'f1' && x.side === 'vendeur')! : null;
    expect(forSara?.draft).not.toMatch(/Bruno|Achat/);
  });

  it('SV13 · prénom corrigé après la préparation : l’écran montre le nouveau, il part, et le texte rangé reste [R17]', async () => {
    const t = await setup();
    const s = await t.client('Sara');
    t.close('f1', '2027-03-08', [{ personId: s, side: 'vendeur' }]);
    t.setClock(paris('2027-03-08', 18));
    await t.merci.run(t.network.id);
    await t.db.run("UPDATE persons SET first_name = 'Sarah' WHERE id = ?", [s]);
    t.setClock(paris('2027-03-09', 11));
    const list = await t.merci.list(t.agent);
    if (!list.ok) throw new Error(list.code);
    expect(list.value[0]!.draft.startsWith('Bonjour Sarah, merci')).toBe(true);
    expect(await t.merci.decide(t.agent, 'f1', s, 'send')).toEqual({ ok: true, status: 'sent' });
    const [sent] = await t.inbox(s);
    expect(sent!.body).toContain(list.value[0]!.draft);
    expect(sent!.body).not.toContain('Sara,');
    expect((await t.db.first<{ draft: string }>('SELECT draft FROM thank_you_tasks WHERE file_id = ?', ['f1']))!.draft).toContain('Bonjour Sara,');
  });

  it('SV13 · validé un dimanche, corrigé avant le lundi : le message qui attendait part avec le nouveau prénom', async () => {
    const t = await setup();
    const s = await t.client('Sara');
    t.close('f1', '2027-03-08', [{ personId: s, side: 'vendeur' }]);
    t.setClock(paris('2027-03-08', 18));
    await t.merci.run(t.network.id);
    t.setClock(paris('2027-03-14', 20));
    expect(await t.merci.decide(t.agent, 'f1', s, 'send')).toEqual({ ok: true, status: 'waiting' });
    await t.db.run("UPDATE persons SET first_name = 'Sarah' WHERE id = ?", [s]);
    t.setClock(paris('2027-03-15', 10));
    await t.merci.run(t.network.id);
    const [sent] = await t.inbox(s);
    expect(sent!.body).toContain('Bonjour Sarah, merci');
  });

  it('[R26] validé, le message passe par le contrôle central et va dans la boîte d’essai ; non validé, rien ne part', async () => {
    const t = await setup();
    const s = await t.client('Sara');
    const b = await t.client('Bruno');
    t.close('f1', '2027-03-08', [{ personId: s, side: 'vendeur' }, { personId: b, side: 'acquereur' }]);
    t.setClock(paris('2027-03-08', 18));
    await t.merci.run(t.network.id);
    t.setClock(paris('2027-03-09', 11));
    expect(await t.merci.decide(t.agent, 'f1', s, 'send')).toEqual({ ok: true, status: 'sent' });
    expect(await t.merci.decide(t.agent, 'f1', b, 'decline')).toEqual({ ok: true, status: null });
    // Une décision rangée ne change plus.
    expect(await t.merci.decide(t.agent, 'f1', b, 'send')).toEqual({ ok: false, rule: null, code: 'already_decided' });
    for (let d = 9; d <= 12; d++) {
      t.setClock(paris(`2027-03-${String(d).padStart(2, '0')}`, 14));
      await t.merci.run(t.network.id);
    }
    expect(await t.inbox(s)).toHaveLength(1);
    expect(await t.inbox(b)).toHaveLength(0);
    expect((await t.inbox(s))[0]!.body).toContain('merci pour votre confiance');
    // L'appel fait sort la tâche de la liste des choses à faire, une fois la décision prise.
    expect(await t.merci.markCalled(t.agent, 'f1', s)).toEqual({ ok: true });
    const open = await t.merci.list(t.agent, { open: true });
    expect(open.ok && open.value.map((x) => x.personId)).toEqual([b]);
    // Le journal ne garde ni texte ni coordonnée [R13].
    expect(JSON.stringify(await t.journal.bySubject('sale_file:f1'))).not.toMatch(/Bonjour|example\.test|Sara|Bruno/);
  });

  it('[R01] [R02] validé un dimanche soir, le message attend le lundi ; une personne exclue ne reçoit rien', async () => {
    const t = await setup();
    const s = await t.client('Sara');
    const x = await t.client('Xavier');
    await t.store.addExclusion({ networkId: t.network.id, personId: x, reason: 'stop', notedAt: new Date('2027-03-01T09:00:00.000Z') });
    t.close('f1', '2027-03-13', [{ personId: s, side: 'vendeur' }, { personId: x, side: 'acquereur' }]);
    t.setClock(paris('2027-03-13', 18));
    await t.merci.run(t.network.id);
    t.setClock(paris('2027-03-14', 21));
    expect(await t.merci.decide(t.agent, 'f1', s, 'send')).toEqual({ ok: true, status: 'waiting' });
    expect(await t.merci.decide(t.agent, 'f1', x, 'send')).toMatchObject({ ok: true });
    t.setClock(paris('2027-03-15', 8, 5));
    await t.merci.run(t.network.id);
    expect(await t.inbox(s)).toHaveLength(1);
    expect(await t.inbox(x)).toHaveLength(0);
    const list = await t.merci.list(t.agent);
    expect(list.ok && list.value.find((r) => r.personId === x)).toMatchObject({ sendStatus: 'refused' });
  });

  it('un message validé qui n’a pas pu partir dans les 7 jours est clos ; un dossier trop ancien ne crée pas de tâche', async () => {
    const t = await setup();
    const s = await t.client('Sara');
    const old = await t.client('Olga');
    t.close('f1', '2027-03-06', [{ personId: s, side: 'vendeur' }]);
    t.close('f0', '2027-02-20', [{ personId: old, side: 'vendeur' }]);
    // Samedi 21 h : la tâche, puis la validation, hors des heures d'envoi.
    t.setClock(paris('2027-03-06', 21));
    await t.merci.run(t.network.id);
    await t.merci.decide(t.agent, 'f1', s, 'send');
    // Aucun passage pendant 8 jours.
    t.setClock(paris('2027-03-15', 10));
    await t.merci.run(t.network.id);
    expect(await t.inbox(s)).toHaveLength(0);
    const list = await t.merci.list(t.agent);
    expect(list.ok && list.value.map((r) => [r.fileId, r.sendStatus, r.rule])).toEqual([['f1', 'closed', 'delai_depasse']]);
  });

  it('[R18] [R05] une fiche réunie après la création de sa tâche n’en crée pas une autre ; deux envois simultanés n’en font qu’un', async () => {
    const t = await setup();
    const s = await t.client('Sara');
    const s2 = await t.client('Sara');
    t.close('f1', '2027-03-08', [{ personId: s2, side: 'vendeur' }]);
    t.setClock(paris('2027-03-08', 18));
    await t.merci.run(t.network.id);
    await new FicheUnique(t.db, new FicheClient(t.db, { now: t.now }), { now: t.now }).merge({ survivorId: s, mergedId: s2, reason: 'même personne, test' });
    t.setClock(paris('2027-03-09', 9));
    await t.merci.run(t.network.id);
    const list = await t.merci.list(t.agent);
    expect(list.ok && list.value).toHaveLength(1);
    // La décision et un passage en même temps : un seul message, et l'issue rangée est celle de l'envoi.
    t.setClock(paris('2027-03-09', 21));
    expect(await t.merci.decide(t.agent, 'f1', s2, 'send')).toEqual({ ok: true, status: 'waiting' });
    t.setClock(paris('2027-03-10', 10));
    await Promise.all([t.merci.run(t.network.id), t.merci.run(t.network.id), t.merci.run(t.network.id)]);
    expect(await t.outbox()).toBe(1);
    const after = await t.merci.list(t.agent);
    expect(after.ok && after.value.map((r) => [r.sendStatus, r.rule])).toEqual([['sent', null]]);
  });

  it('[R05] un passage interrompu après l’envoi, avant d’en ranger l’issue : la reprise range l’envoi, pas un refus', async () => {
    const t = await setup();
    const s = await t.client('Sara');
    t.close('f1', '2027-03-08', [{ personId: s, side: 'vendeur' }]);
    t.setClock(paris('2027-03-08', 18));
    await t.merci.run(t.network.id);
    t.setClock(paris('2027-03-09', 21));
    await t.merci.decide(t.agent, 'f1', s, 'send');
    // Une panne juste avant de ranger l'issue : l'envoi est fait, la tâche reste prise.
    const update = t.db.run.bind(t.db);
    t.db.run = async (sql: string, params?: readonly unknown[]) => {
      if (sql.startsWith('UPDATE thank_you_tasks SET send_status = ?, rule = ?')) throw new Error('panne simulée');
      return update(sql, params as never);
    };
    t.setClock(paris('2027-03-10', 10));
    await expect(t.merci.run(t.network.id)).rejects.toThrow('panne simulée');
    t.db.run = update;
    expect(await t.outbox()).toBe(1);
    // Vingt minutes plus tard, la reprise.
    t.setClock(paris('2027-03-10', 10, 20));
    await t.merci.run(t.network.id);
    expect(await t.outbox()).toBe(1);
    const list = await t.merci.list(t.agent);
    expect(list.ok && list.value.map((r) => [r.sendStatus, r.rule])).toEqual([['sent', null]]);
  });

  it('[R05] une réservation sans remise ne fait pas croire à un envoi : la tâche reste refusée, avec sa règle', async () => {
    const t = await setup();
    const s = await t.client('Sara');
    t.close('f1', '2027-03-08', [{ personId: s, side: 'vendeur' }]);
    t.setClock(paris('2027-03-08', 18));
    await t.merci.run(t.network.id);
    t.setClock(paris('2027-03-09', 21));
    await t.merci.decide(t.agent, 'f1', s, 'send');
    // Un passage arrêté net juste après avoir lié le message à sa réservation, avant la remise : la réservation existe,
    // le message n'a jamais été remis.
    const m = await t.store.recordMessage({ networkId: t.network.id, personId: s, channel: 'email', direction: 'out', authorKind: 'system', body: 'brouillon jamais remis', occurredAt: t.now() });
    await t.db.run('INSERT INTO send_reservations (person_id, key, reservation_id, network_id, message_id, created_at) VALUES (?, ?, ?, ?, ?, ?)', [s, 'sujet:merci:f1', 'reservation-test', t.network.id, m.id, t.now().toISOString()]);
    t.setClock(paris('2027-03-10', 10, 20));
    await t.merci.run(t.network.id);
    expect(await t.outbox()).toBe(0);
    const list = await t.merci.list(t.agent);
    expect(list.ok && list.value.map((r) => [r.sendStatus, r.rule])).toEqual([['refused', 'R05']]);
  });

  it('[R16] seul l’agent du dossier, encore actif, voit et décide', async () => {
    const t = await setup();
    const s = await t.client('Sara');
    t.close('f1', '2027-03-08', [{ personId: s, side: 'vendeur' }]);
    t.setClock(paris('2027-03-08', 18));
    await t.merci.run(t.network.id);
    expect(await t.merci.decide(t.sam, 'f1', s, 'send')).toEqual({ ok: false, rule: 'R16', code: 'role' });
    expect(await t.merci.decide(t.direction, 'f1', s, 'send')).toEqual({ ok: false, rule: 'R16', code: 'role' });
    expect(await t.merci.markCalled(t.sam, 'f1', s)).toEqual({ ok: false, rule: 'R16', code: 'role' });
    expect(await t.merci.decide(t.agent, 'f9', s, 'send')).toEqual({ ok: false, rule: null, code: 'unknown_task' });
    expect(await t.merci.decide(t.agent, 'f1', s, 'peut-être' as 'send')).toEqual({ ok: false, rule: null, code: 'invalid_decision' });
    const sam = await t.merci.list(t.sam);
    expect(sam.ok && sam.value).toEqual([]);
    await t.db.run("UPDATE agents SET status = 'left' WHERE id = ?", [t.alexId]);
    expect(await t.merci.list(t.agent)).toEqual({ ok: false, rule: 'R16', code: 'agent_inactive' });
    expect(await t.merci.decide(t.agent, 'f1', s, 'send')).toEqual({ ok: false, rule: 'R16', code: 'agent_inactive' });
    expect(await t.outbox()).toBe(0);
    await expect(t.db.run('DELETE FROM thank_you_tasks')).rejects.toThrow();
    await expect(t.db.run("UPDATE thank_you_tasks SET draft = 'autre texte, test'")).rejects.toThrow();
  });

  it('[R08] AC11 : sur une fiche réunie, le remerciement porte le prénom de la fiche gardée', async () => {
    const t = await setup();
    const s = await t.client('Sara', 'Vend');
    const expected = await mergeWithDouble(t.db, new FicheClient(t.db, { now: t.now }), s, 'Inna');
    t.close('f1', '2027-03-08', [{ personId: s, side: 'vendeur' }]);
    t.setClock(paris('2027-03-09', 9));
    await t.merci.run(t.network.id);
    const list = await t.merci.list(t.agent);
    expect(list.ok && list.value.map((x) => x.firstName)).toEqual([expected]);
  });
});
