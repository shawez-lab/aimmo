import { expect, it } from 'vitest';
import { Acces, CALL_REQUEST_DAYS, FicheAgent, Qualification, inProspectingHours, FicheClient, FicheUnique, Rappels, SqlJournalStore, applyMigrations, fromSyncSqlite, type Viewer } from '../src/index.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

// Tout est inventé.
const NOW = new Date('2026-11-10T09:00:00.000Z');

async function world() {
  const now = () => NOW;
  const db = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  const store = new FicheClient(db, { now });
  const unique = new FicheUnique(db, store, { now });
  const journal = new SqlJournalStore(db);
  const acces = new Acces(db, store, unique, journal, { now });
  const net = await store.createNetwork('Réseau test');
  const paul = await store.createAgent({ networkId: net.id, firstName: 'Paul', lastName: 'Essai' });
  const lise = await store.createAgent({ networkId: net.id, firstName: 'Lise', lastName: 'Essai' });
  const asPaul: Viewer = { role: 'agent', userId: paul.id, networkId: net.id };
  const asLise: Viewer = { role: 'agent', userId: lise.id, networkId: net.id };
  const lea = await store.createPerson({ networkId: net.id, agentId: paul.id, firstName: 'Léa', lastName: 'Exemple' });
  await store.addIdentifier({ networkId: net.id, personId: lea.id, kind: 'phone', value: '06 00 00 00 01' });
  await store.addSource({ networkId: net.id, agentId: paul.id, personId: lea.id, channel: 'site', detail: 'formulaire test', occurredAt: new Date('2026-10-01T10:00:00Z') });
  await store.createProject({ networkId: net.id, agentId: paul.id, personId: lea.id, kind: 'sell', budgetMinEur: 200000, budgetMaxEur: 230000 });
  await store.addConsent({ networkId: net.id, personId: lea.id, purpose: 'valuation_follow_up', channel: 'email', proof: 'case cochée test', givenAt: new Date('2026-10-01T10:00:00Z') });
  for (let i = 1; i <= 12; i++) {
    await store.recordMessage({ networkId: net.id, personId: lea.id, channel: 'email', conversationId: 'c1', direction: i % 2 ? 'in' : 'out', authorKind: i % 2 ? 'person' : 'agent', body: `Message test ${i}`, occurredAt: new Date(Date.parse('2026-10-02T09:00:00Z') + i * 3_600_000) });
  }
  await db.run(`INSERT INTO inbound_messages (id, network_id, dedup_key, channel, kind, body, status, person_id, received_at, created_at) VALUES ('in-1', ?, 'k1', 'email', 'email', 'x', 'processed', ?, ?, ?)`, [net.id, lea.id, NOW.toISOString(), NOW.toISOString()]);
  await db.run(`INSERT INTO qualifications (id, network_id, inbound_id, person_id, category, deadline, financing, criteria, source, created_at) VALUES ('q-1', ?, 'in-1', ?, 'seller', 'within_3_months', NULL, '[]', 'rules', ?)`, [net.id, lea.id, NOW.toISOString()]);
  await db.run(`INSERT INTO callback_tasks (id, network_id, person_id, project_id, qualification_id, dedup_key, reason, due_at, created_at, done_at) VALUES ('t-1', ?, ?, NULL, 'q-1', 'k-t1', 'Vendeur sous 3 mois', ?, ?, NULL)`, [net.id, lea.id, NOW.toISOString(), NOW.toISOString()]);
  const fiche = new FicheAgent(db, acces, { now });
  const rappels = new Rappels(db, unique, journal, { now });
  return { db, store, unique, net, paul, lise, asPaul, asLise, lea, acces, fiche, rappels, journal };
}

describeWithSqlite('A03 · fiche du client dans l’application', () => {
  it('projets, origines, accords, derniers messages, rappels et numéro à appeler, pour l’agent de la fiche', async () => {
    const w = await world();
    await w.store.addConsent({ networkId: w.net.id, personId: w.lea.id, purpose: 'reply', channel: 'phone', proof: 'message reçu test', givenAt: new Date('2026-10-02T10:00:00Z') });
    const r = await w.fiche.read(w.asPaul, w.lea.id);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const f = r.value;
    expect(f).toMatchObject({ personId: w.lea.id, firstName: 'Léa', lastName: 'Exemple', contact: { allowed: true, reasons: [] }, call: 'tel:+33600000001', callRefusal: null });
    expect(f.projects).toEqual([{ kind: 'sell', stage: 'new', deadline: null, budgetMinEur: 200000, budgetMaxEur: 230000 }]);
    expect(f.sources).toEqual([{ channel: 'site', detail: 'formulaire test', occurredAt: '2026-10-01T10:00:00.000Z' }]);
    expect(f.consents).toEqual([{ id: expect.any(String), purpose: 'valuation_follow_up', channel: 'email', givenAt: '2026-10-01T10:00:00.000Z', withdrawnAt: null }, { id: expect.any(String), purpose: 'reply', channel: 'phone', givenAt: '2026-10-02T10:00:00.000Z', withdrawnAt: null }]);
    expect(f.messages).toHaveLength(10);
    expect(f.messages[0]!.body).toBe('Message test 12');
    expect(f.callbacks).toEqual([{ taskId: 't-1', reason: 'Vendeur sous 3 mois', dueAt: NOW.toISOString(), doneAt: null }]);
    const entries = await w.journal.all();
    expect(entries.filter((e) => e.type === 'fiche.lue').map((e) => e.subject)).toEqual([`person:${w.lea.id}`]);
  });

  it('[R16] la fiche d’un autre agent est refusée, et le refus est au journal', async () => {
    const w = await world();
    expect(await w.fiche.read(w.asLise, w.lea.id)).toMatchObject({ ok: false, rule: 'R16' });
    expect(await w.fiche.read(w.asLise, 'inconnue')).toMatchObject({ ok: false, rule: 'R16' });
    const refused = (await w.journal.all()).filter((e) => e.type === 'acces.refuse');
    expect(refused).toHaveLength(2);
    expect(JSON.stringify(refused)).not.toMatch(/Léa|Exemple|\+336/);
  });

  it('[R02, R04] une personne exclue ou arrêtée est signalée et n’a pas de numéro à appeler ; une exclusion levée le rend', async () => {
    for (const reason of ['stop', 'network_list', 'refused', 'sold', 'followed_elsewhere'] as const) {
      const w = await world();
      await w.store.addExclusion({ networkId: w.net.id, personId: w.lea.id, reason, channel: reason === 'stop' ? 'sms' : null, notedAt: new Date('2026-11-01T00:00:00Z') });
      const r = await w.fiche.read(w.asPaul, w.lea.id);
      expect(r.ok && r.value.contact, reason).toEqual({ allowed: false, reasons: [reason] });
      expect(r.ok && r.value.call, reason).toBeNull();
    }
    const w = await world();
    const ex = await w.store.addExclusion({ networkId: w.net.id, personId: w.lea.id, reason: 'stop', notedAt: new Date('2026-11-01T00:00:00Z') });
    await w.db.run('UPDATE exclusions SET lifted_at = ? WHERE id = ?', ['2026-11-05T00:00:00.000Z', ex.id]);
    await w.store.addConsent({ networkId: w.net.id, personId: w.lea.id, purpose: 'prospecting', channel: 'phone', proof: 'accord test', givenAt: new Date('2026-11-06T00:00:00Z') });
    const r = await w.fiche.read(w.asPaul, w.lea.id);
    expect(r.ok && r.value.call).toBe('tel:+33600000001');
  });

  it('[R03] sans accord par téléphone ni demande de la personne, pas de numéro, et la fiche dit pourquoi', async () => {
    const w = await world();
    // L'accord par mail ne vaut pas pour le téléphone ; un rappel à faire n'est pas une demande.
    const r = await w.fiche.read(w.asPaul, w.lea.id);
    expect(r.ok && r.value.call).toBeNull();
    expect(r.ok && r.value.callRefusal).toBe('no_consent');
    expect(r.ok && r.value.contact.allowed).toBe(true);
    expect(r.ok && r.value.callbacks).toHaveLength(1);
    expect(JSON.stringify(r)).not.toContain('+336');
  });

  it('[R03] la prospection acceptée et la demande de la personne ouvrent l’appel ; leur retrait le referme', async () => {
    for (const purpose of ['reply', 'prospecting', 'rappel_demande']) {
      const w = await world();
      const c = await w.store.addConsent({ networkId: w.net.id, personId: w.lea.id, purpose, channel: 'phone', proof: 'accord test', givenAt: new Date('2026-10-02T10:00:00Z') });
      const open = await w.fiche.read(w.asPaul, w.lea.id);
      expect(open.ok && open.value.call, purpose).toBe('tel:+33600000001');
      await w.store.withdrawConsent(c.id, new Date('2026-10-20T10:00:00Z'));
      const closed = await w.fiche.read(w.asPaul, w.lea.id);
      expect(closed.ok && closed.value.call, purpose).toBeNull();
      expect(closed.ok && closed.value.callRefusal, purpose).toBe('no_consent');
    }
  });

  it('[R03] un accord pour un autre sujet, ou la parole d’un tiers, n’ouvre pas l’appel', async () => {
    for (const purpose of ['route_share', 'alertes_biens', 'valuation_follow_up', 'suivi_vente', 'recommandation', 'appointment']) {
      const w = await world();
      await w.store.addConsent({ networkId: w.net.id, personId: w.lea.id, purpose, channel: 'phone', proof: 'accord test', givenAt: new Date('2026-10-02T10:00:00Z') });
      const r = await w.fiche.read(w.asPaul, w.lea.id);
      expect(r.ok && r.value.callRefusal, purpose).toBe('no_consent');
    }
  });

  it('[R03] une demande vaut 13 mois ; la prospection acceptée reste jusqu’à son retrait', async () => {
    const oneDay = 86_400_000;
    const check = async (purpose: string, days: number) => {
      const w = await world();
      await w.store.addConsent({ networkId: w.net.id, personId: w.lea.id, purpose, channel: 'phone', proof: 'accord test', givenAt: new Date(NOW.getTime() - days * oneDay) });
      const r = await w.fiche.read(w.asPaul, w.lea.id);
      return r.ok && r.value.callRefusal;
    };
    expect(await check('reply', CALL_REQUEST_DAYS - 2)).toBeNull();
    expect(await check('reply', CALL_REQUEST_DAYS + 1)).toBe('no_consent');
    expect(await check('rappel_demande', CALL_REQUEST_DAYS + 1)).toBe('no_consent');
    expect(await check('prospecting', CALL_REQUEST_DAYS + 1)).toBeNull();
  });

  it('[R03] un retrait par téléphone ferme aussi les accords plus anciens d’une autre finalité, pas un accord donné après', async () => {
    const w = await world();
    await w.store.addConsent({ networkId: w.net.id, personId: w.lea.id, purpose: 'reply', channel: 'phone', proof: 'message reçu', givenAt: new Date('2026-09-01T10:00:00Z') });
    const taken = await w.store.addConsent({ networkId: w.net.id, personId: w.lea.id, purpose: 'prospecting', channel: 'phone', proof: 'accord test', givenAt: new Date('2026-09-02T10:00:00Z') });
    await w.store.withdrawConsent(taken.id, new Date('2026-10-01T10:00:00Z'));
    const closed = await w.fiche.read(w.asPaul, w.lea.id);
    expect(closed.ok && closed.value.callRefusal).toBe('no_consent');
    await w.store.addConsent({ networkId: w.net.id, personId: w.lea.id, purpose: 'rappel_demande', channel: 'phone', proof: 'nouvelle demande', givenAt: new Date('2026-10-05T10:00:00Z') });
    const open = await w.fiche.read(w.asPaul, w.lea.id);
    expect(open.ok && open.value.callRefusal).toBeNull();
  });

  it('[R03] le numéro composé est le dernier donné', async () => {
    const w = await world();
    // Une seconde plus tard : l'horloge du test est figée, et à la même date l'ordre tomberait au hasard des identifiants.
    const later = new FicheClient(w.db, { now: () => new Date(NOW.getTime() + 1000) });
    await later.addIdentifier({ networkId: w.net.id, personId: w.lea.id, kind: 'phone', value: '+33600000099' });
    await w.store.addConsent({ networkId: w.net.id, personId: w.lea.id, purpose: 'reply', channel: 'phone', proof: 'message reçu', givenAt: new Date('2026-10-02T10:00:00Z') });
    const r = await w.fiche.read(w.asPaul, w.lea.id);
    expect(r.ok && r.value.call).toBe('tel:+33600000099');
  });

  it('[R203] les heures de la prospection, à l’heure de Paris, été comme hiver', () => {
    const cases: [string, boolean][] = [
      ['2026-11-10T08:59:00Z', false], // mardi 9 h 59, hiver
      ['2026-11-10T09:00:00Z', true],
      ['2026-11-10T11:59:00Z', true],
      ['2026-11-10T12:00:00Z', false], // 13 h
      ['2026-11-10T12:59:00Z', false],
      ['2026-11-10T13:00:00Z', true], // 14 h
      ['2026-11-10T18:59:00Z', true],
      ['2026-11-10T19:00:00Z', false], // 20 h
      ['2026-11-14T10:00:00Z', false], // samedi
      ['2026-11-15T10:00:00Z', false], // dimanche
      ['2026-11-11T10:00:00Z', false], // mercredi 11 novembre, férié
      ['2027-05-17T10:00:00Z', false], // lundi de Pentecôte
      ['2027-06-08T08:00:00Z', true], // mardi 10 h, été
      ['2027-06-08T07:59:00Z', false],
      ['2027-06-08T17:59:00Z', true], // 19 h 59, été
      ['2027-06-08T18:00:00Z', false],
    ];
    for (const [at, expected] of cases) expect(inProspectingHours(new Date(at)), at).toBe(expected);
  });

  it('[R203] hors des heures, la prospection acceptée ferme l’appel ; une demande de la personne reste ouverte', async () => {
    const saturday = new Date('2026-11-14T10:00:00.000Z');
    const read = async (purposes: string[]) => {
      const w = await world();
      for (const purpose of purposes) await w.store.addConsent({ networkId: w.net.id, personId: w.lea.id, purpose, channel: 'phone', proof: 'accord test', givenAt: new Date('2026-10-02T10:00:00Z') });
      const r = await new FicheAgent(w.db, w.acces, { now: () => saturday }).read(w.asPaul, w.lea.id);
      return r.ok ? { call: r.value.call, callRefusal: r.value.callRefusal } : null;
    };
    expect(await read(['prospecting'])).toEqual({ call: null, callRefusal: 'outside_hours' });
    expect(await read(['reply'])).toEqual({ call: 'tel:+33600000001', callRefusal: null });
    expect(await read(['rappel_demande'])).toEqual({ call: 'tel:+33600000001', callRefusal: null });
    expect(await read(['prospecting', 'reply'])).toEqual({ call: 'tel:+33600000001', callRefusal: null });
    expect(await read([])).toEqual({ call: null, callRefusal: 'no_consent' });
  });

  it('[R203] la fiche donne la fin du créneau pour la prospection acceptée, rien pour une demande', async () => {
    const read = async (purpose: string, at: string) => {
      const w = await world();
      await w.store.addConsent({ networkId: w.net.id, personId: w.lea.id, purpose, channel: 'phone', proof: 'accord test', givenAt: new Date('2026-10-02T10:00:00Z') });
      const r = await new FicheAgent(w.db, w.acces, { now: () => new Date(at) }).read(w.asPaul, w.lea.id);
      return r.ok ? r.value.callClosesAt : 'refusé';
    };
    expect(await read('prospecting', '2026-11-10T09:30:42.500Z')).toBe('2026-11-10T12:00:00.000Z'); // 13 h à Paris
    expect(await read('prospecting', '2026-11-10T13:00:00.000Z')).toBe('2026-11-10T19:00:00.000Z'); // 20 h à Paris
    expect(await read('reply', '2026-11-10T09:30:00.000Z')).toBeNull();
    expect(await read('prospecting', '2026-11-14T10:00:00.000Z')).toBeNull();
  });

  it('[R03] un accord daté du futur n’ouvre pas l’appel', async () => {
    const w = await world();
    await w.store.addConsent({ networkId: w.net.id, personId: w.lea.id, purpose: 'prospecting', channel: 'phone', proof: 'accord test', givenAt: new Date(NOW.getTime() + 86_400_000) });
    const r = await w.fiche.read(w.asPaul, w.lea.id);
    expect(r.ok && r.value.callRefusal).toBe('no_consent');
  });

  it('[R03] un retrait sur une fiche réunie n’est pas rouvert par un accord plus ancien du doublon', async () => {
    const w = await world();
    const double = await w.store.createPerson({ networkId: w.net.id, agentId: w.paul.id, firstName: 'Léa', lastName: 'Double' });
    const taken = await w.store.addConsent({ networkId: w.net.id, personId: w.lea.id, purpose: 'prospecting', channel: 'phone', proof: 'accord test', givenAt: new Date('2026-09-01T10:00:00Z') });
    await w.store.withdrawConsent(taken.id, new Date('2026-10-20T10:00:00Z'));
    await w.store.addConsent({ networkId: w.net.id, personId: double.id, purpose: 'prospecting', channel: 'phone', proof: 'accord du doublon', givenAt: new Date('2026-09-15T10:00:00Z') });
    await w.unique.merge({ survivorId: w.lea.id, mergedId: double.id, reason: 'test' });
    const r = await w.fiche.read(w.asPaul, w.lea.id);
    expect(r.ok && r.value.callRefusal).toBe('no_consent');
  });

  it('[R02, R04] un accord plus ancien qu’une levée d’exclusion n’ouvre pas l’appel', async () => {
    const w = await world();
    await w.store.addConsent({ networkId: w.net.id, personId: w.lea.id, purpose: 'prospecting', channel: 'phone', proof: 'accord test', givenAt: new Date('2026-09-01T10:00:00Z') });
    const ex = await w.store.addExclusion({ networkId: w.net.id, personId: w.lea.id, reason: 'stop', notedAt: new Date('2026-10-01T00:00:00Z') });
    await w.db.run('UPDATE exclusions SET lifted_at = ? WHERE id = ?', ['2026-10-05T00:00:00.000Z', ex.id]);
    const r = await w.fiche.read(w.asPaul, w.lea.id);
    expect(r.ok && r.value.callRefusal).toBe('no_consent');
  });

  it('une fiche sans numéro le dit, même avec un accord', async () => {
    const w = await world();
    const bare = await w.store.createPerson({ networkId: w.net.id, agentId: w.paul.id, firstName: 'Sans', lastName: 'Numéro' });
    await w.store.addConsent({ networkId: w.net.id, personId: bare.id, purpose: 'prospecting', channel: 'phone', proof: 'accord test', givenAt: new Date('2026-10-02T10:00:00Z') });
    const r = await w.fiche.read(w.asPaul, bare.id);
    expect(r.ok && r.value).toMatchObject({ call: null, callRefusal: 'no_phone' });
  });

  it('[R17, R16] « rappel fait » garde la ligne, une seule fois au journal ; refusé à un autre agent et pour une tâche inconnue', async () => {
    const w = await world();
    expect(await w.rappels.done(w.acces, w.asLise, 't-1')).toBe(false);
    expect(await w.rappels.done(w.acces, w.asPaul, 'inconnue')).toBe(false);
    expect(await w.rappels.done(w.acces, w.asPaul, 't-1')).toBe(true);
    expect(await w.rappels.done(w.acces, w.asPaul, 't-1')).toBe(true);
    const row = await w.db.first<{ done_at: string | null }>(`SELECT done_at FROM callback_tasks WHERE id = 't-1'`);
    expect(row?.done_at).toBe(NOW.toISOString());
    const r = await w.fiche.read(w.asPaul, w.lea.id);
    expect(r.ok && r.value.callbacks).toEqual([{ taskId: 't-1', reason: 'Vendeur sous 3 mois', dueAt: NOW.toISOString(), doneAt: NOW.toISOString() }]);
    const entries = await w.journal.all();
    expect(entries.filter((e) => e.type === 'rappel.fait').map((e) => [e.subject, e.data])).toEqual([[`person:${w.lea.id}`, { task: 't-1' }]]);
    expect(entries.filter((e) => e.type === 'acces.refuse')).toHaveLength(2);
  });

  it('Q08 · la fiche montre le dernier classement, sans note ni auteur ; la correction garde l’origine et rejoint la mesure [R16] [R17]', async () => {
    const w = await world();
    await w.db.run(`INSERT INTO contact_scores (qualification_id, network_id, person_id, score, temperature, reason, created_at) VALUES ('q-1', ?, ?, 80, 'hot', 'test', ?)`, [w.net.id, w.lea.id, NOW.toISOString()]);
    const qualification = new Qualification(w.db, w.store, w.unique, {} as never, {} as never, w.journal, { now: () => NOW });
    const shown = async () => {
      const r = await w.fiche.read(w.asPaul, w.lea.id);
      if (!r.ok) throw new Error('fiche refusée');
      return r.value.qualification;
    };
    expect(await shown()).toEqual({ id: 'q-1', category: 'seller', route: null, classifiedAt: NOW.toISOString(), correction: null });

    expect(await qualification.correct(w.acces, w.asLise, 'q-1', 'buyer', null)).toBe(false);
    expect(await w.db.all('SELECT id FROM qualification_corrections')).toEqual([]);
    expect(await qualification.correct(w.acces, w.asPaul, 'q-1', 'rent_out', null)).toBe(true);
    expect(await qualification.correct(w.acces, w.asPaul, 'q-1', 'buyer', 'M17')).toBe(true);

    const after = await shown();
    expect(after).toEqual({ id: 'q-1', category: 'seller', route: null, classifiedAt: NOW.toISOString(), correction: { category: 'buyer', route: 'M17', correctedAt: NOW.toISOString() } });
    expect(JSON.stringify(after)).not.toMatch(/score|temperature|hot|rules|actor|agent:/);
    expect(await w.db.first('SELECT category FROM qualifications WHERE id = ?', ['q-1'])).toEqual({ category: 'seller' });
    expect(await qualification.correctedCases(w.net.id)).toEqual([{ inboundId: 'in-1', category: 'buyer', route: 'M17' }]);
  });

  it('Q08 · fusion défaite : le classement de l’autre fiche n’est plus montré ni corrigible [R16]', async () => {
    const w = await world();
    const marc = await w.store.createPerson({ networkId: w.net.id, firstName: 'Marc', lastName: 'Exemple' });
    const later = '2026-11-10T10:00:00.000Z';
    await w.db.run(`INSERT INTO inbound_messages (id, network_id, dedup_key, channel, kind, body, status, person_id, received_at, created_at) VALUES ('in-3', ?, 'k3', 'email', 'email', 'x', 'processed', ?, ?, ?)`, [w.net.id, marc.id, later, later]);
    await w.db.run(`INSERT INTO qualifications (id, network_id, inbound_id, person_id, category, deadline, financing, criteria, source, created_at) VALUES ('q-3', ?, 'in-3', ?, 'buyer', NULL, NULL, '[]', 'rules', ?)`, [w.net.id, marc.id, later]);
    const merged = await w.unique.merge({ survivorId: w.lea.id, mergedId: marc.id, reason: 'test' });
    const joined = await w.fiche.read(w.asPaul, w.lea.id);
    expect(joined.ok && joined.value.qualification?.id).toBe('q-3');
    await w.unique.undoMerge(merged.id, { journal: w.journal, actor: 'agent:test' });
    const apart = await w.fiche.read(w.asPaul, w.lea.id);
    expect(apart.ok && apart.value.qualification?.id).toBe('q-1');
    const qualification = new Qualification(w.db, w.store, w.unique, {} as never, {} as never, w.journal, { now: () => NOW });
    expect(await qualification.correct(w.acces, w.asPaul, 'q-3', 'spam', null)).toBe(false);
    expect(await w.db.all('SELECT id FROM qualification_corrections')).toEqual([]);
  });

  it('Q08 · le plus récent des classements gagne, fiches réunies comprises ; une correction d’un ancien ne le suit pas ; aucun classement : rien', async () => {
    const w = await world();
    const double = await w.store.createPerson({ networkId: w.net.id, agentId: w.paul.id, firstName: 'Léa', lastName: 'Exemple' });
    const none = await w.fiche.read(w.asPaul, double.id);
    expect(none.ok && none.value.qualification).toBeNull();
    const later = '2026-11-10T10:00:00.000Z';
    await w.db.run(`INSERT INTO inbound_messages (id, network_id, dedup_key, channel, kind, body, status, person_id, received_at, created_at) VALUES ('in-2', ?, 'k2', 'email', 'email', 'x', 'processed', ?, ?, ?)`, [w.net.id, double.id, later, later]);
    await w.db.run(`INSERT INTO qualifications (id, network_id, inbound_id, person_id, category, route, deadline, financing, criteria, source, created_at) VALUES ('q-2', ?, 'in-2', ?, 'rent_out', 'M15', NULL, NULL, '[]', 'rules', ?)`, [w.net.id, double.id, later]);
    await w.db.run(`INSERT INTO qualification_corrections (id, network_id, qualification_id, actor, category, route, created_at) VALUES ('c-1', ?, 'q-1', 'agent:x', 'spam', NULL, ?)`, [w.net.id, NOW.toISOString()]);
    await w.unique.merge({ survivorId: w.lea.id, mergedId: double.id, reason: 'test' });
    const r = await w.fiche.read(w.asPaul, w.lea.id);
    expect(r.ok && r.value.qualification).toEqual({ id: 'q-2', category: 'rent_out', route: 'M15', classifiedAt: later, correction: null });
  });
});
