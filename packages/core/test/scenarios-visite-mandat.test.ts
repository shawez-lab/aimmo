import { expect, it } from 'vitest';
import { FicheClient, SqlJournalStore, applyMigrations, fromSyncSqlite, type SqlDatabase } from '../src/index.ts';
import { AUTOMATION_PURPOSE, ScenariosAutomatiques, parseScenario } from '../src/automatismes/scenarios.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

// Un mardi d'octobre, 10 h à Paris. Réseau, agents, personnes et biens inventés.
const TUE_10H = Date.parse('2027-10-12T08:00:00.000Z');
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const AFTER_VISIT = {
  name: 'Après la visite',
  trigger: 'visite_faite',
  waitHours: 2,
  message: { channel: 'email', text: 'Bonjour {prenom}, merci pour la visite. Dites-moi ce que vous en avez pensé.' },
  task: { title: 'Rappeler après la visite', dueInDays: 1 },
};

const AFTER_MANDATE = {
  name: 'Mandat signé',
  trigger: 'mandat_signe',
  waitHours: 24,
  message: { channel: 'email', text: 'Bonjour {prenom}, merci pour votre confiance. Je vous tiens au courant de chaque étape.' },
  task: { title: 'Préparer les photos', dueInDays: 2 },
};

async function setup() {
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  let clock = TUE_10H;
  const now = (): Date => new Date(clock);
  let n = 0;
  const newId = (): string => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
  const journal = new SqlJournalStore(db);
  const store = new FicheClient(db, { now });
  const scenarios = new ScenariosAutomatiques(db, journal, { now, newId });
  const network = await store.createNetwork('Réseau test');
  const other = await store.createNetwork('Autre réseau');
  const alex = await store.createAgent({ networkId: network.id, firstName: 'Alex', lastName: 'Agent' });
  const ailleurs = await store.createAgent({ networkId: other.id, firstName: 'Basile', lastName: 'Agent' });
  const direction = { role: 'direction' as const, userId: 'dir-1', networkId: network.id };
  const iso = (): string => new Date(clock).toISOString();
  const agentOf = (net: string): string => (net === network.id ? alex.id : ailleurs.id);
  /** Une personne avec son mail et son accord aux messages de scénario. */
  const person = async (firstName: string, net = network.id) => {
    const p = await store.createPerson({ networkId: net, agentId: agentOf(net), firstName });
    await store.addIdentifier({ networkId: net, personId: p.id, kind: 'email', value: `${firstName.toLowerCase()}@example.test` });
    await store.addConsent({ networkId: net, personId: p.id, purpose: AUTOMATION_PURPOSE, channel: 'email', proof: 'case cochée (test)', givenAt: new Date(clock - 60 * DAY) });
    return p.id;
  };
  let k = 0;
  const property = async (net = network.id): Promise<string> => {
    const id = `bien-${++k}`;
    await db.run("INSERT INTO properties (id, network_id, agent_id, reference, kind, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'home', 'draft', ?, ?)", [id, net, agentOf(net), `REF-${id}`, iso(), iso()]);
    return id;
  };
  /** Un rendez-vous pris, de la sorte dite ; pour une visite, relié à un bien et au projet d'achat de la personne. */
  const appointment = async (personId: string, kind: 'visite' | 'estimation', net = network.id): Promise<string> => {
    const id = `rdv-${++k}`;
    const propertyId = await property(net);
    const start = new Date(clock - HOUR).toISOString();
    await db.run(
      "INSERT INTO appointments (id, network_id, agent_id, person_id, property_id, kind, start_at, end_at, status, token_hash, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'booked', ?, 'agent', ?, ?)",
      [id, net, agentOf(net), personId, propertyId, kind, start, iso(), `hash-${id}`, iso(), iso()],
    );
    if (kind === 'visite') {
      const project = await store.createProject({ networkId: net, agentId: agentOf(net), personId, kind: 'buy' });
      await db.run('INSERT INTO visits (appointment_id, network_id, property_id, project_id, person_id, agent_id, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [id, net, propertyId, project.id, personId, agentOf(net), 'agent:test', iso()]);
    }
    return id;
  };
  /** Le statut final noté à l'heure de l'horloge, comme le fait l'écran des rendez-vous (V06). */
  const mark = (id: string, status: 'honored' | 'absent' | 'cancelled') => db.run("UPDATE appointments SET status = ?, updated_at = ? WHERE id = ? AND status = 'booked'", [status, iso(), id]);
  const seqs = new Map<string, number>();
  /** Un mandat signé du mandant, inscrit au registre à l'heure de l'horloge sauf `inscribe` faux. */
  const mandate = async (personId: string, inscribe = true, net = network.id): Promise<string> => {
    const id = `mandat-${++k}`;
    await db.run("INSERT INTO mandates (id, network_id, agent_id, person_id, signed_at, source_kind, recorded_by, created_at) VALUES (?, ?, ?, ?, ?, 'referral', 'agent:test', ?)", [id, net, agentOf(net), personId, iso(), iso()]);
    if (inscribe) {
      const seq = (seqs.get(net) ?? 0) + 1;
      seqs.set(net, seq);
      await db.run("INSERT INTO mandate_register (network_id, seq, kind, mandate_id, number_value, number, agent_id, signed_at, at, actor, prev_hash, hash) VALUES (?, ?, 'inscription', ?, ?, ?, ?, ?, ?, 'test', 'p', ?)", [
        net,
        seq,
        id,
        seq,
        `T-${seq}`,
        agentOf(net),
        iso(),
        iso(),
        `h-${id}`,
      ]);
    }
    return id;
  };
  const cancelMandate = async (id: string, reason: 'error' | 'withdrawal' | 'termination') => {
    const line = await db.first<{ seq: number; number_value: number; number: string; agent_id: string; signed_at: string }>("SELECT seq, number_value, number, agent_id, signed_at FROM mandate_register WHERE mandate_id = ? AND kind = 'inscription'", [id]);
    const seq = (seqs.get(network.id) ?? 0) + 1;
    seqs.set(network.id, seq);
    await db.run("INSERT INTO mandate_register (network_id, seq, kind, mandate_id, number_value, number, agent_id, signed_at, cancels_seq, reason, at, actor, prev_hash, hash) VALUES (?, ?, 'annulation', ?, ?, ?, ?, ?, ?, ?, ?, 'test', 'p', ?)", [
      network.id,
      seq,
      id,
      line!.number_value,
      line!.number,
      line!.agent_id,
      line!.signed_at,
      line!.seq,
      reason,
      iso(),
      `a-${id}`,
    ]);
  };
  const withdraw = (id: string) => db.run('INSERT INTO mandate_withdrawals (mandate_id, network_id, proof, received_at, recorded_by, created_at) VALUES (?, ?, ?, ?, ?, ?)', [id, network.id, 'lettre reçue (test)', iso(), 'agent:test', iso()]);
  const outbox = () => db.all<{ body: string; person_id: string }>('SELECT m.body, m.person_id FROM trial_outbox o JOIN messages m ON m.id = o.message_id ORDER BY m.rowid');
  const runs = () => db.all<{ trigger_ref: string; person_id: string; status: string; message_status: string | null; task_id: string | null }>('SELECT trigger_ref, person_id, status, message_status, task_id FROM automation_runs ORDER BY rowid');
  const composed = async (def: unknown): Promise<string> => {
    const made = await scenarios.compose(direction, def);
    if (!made.ok) throw new Error(made.code);
    return made.value.scenarioId;
  };
  return { db, scenarios, network, other, direction, person, appointment, mark, mandate, cancelMandate, withdraw, outbox, runs, composed, setClock: (t: number) => (clock = t) };
}

describeWithSqlite('RC18 · une visite faite et un mandat signé déclenchent un scénario', () => {
  it('[R403] les deux déclencheurs entrent dans la liste fermée, sans type de projet', () => {
    expect(parseScenario(AFTER_VISIT)).toMatchObject({ ok: true, value: { trigger: 'visite_faite', projectKind: null } });
    expect(parseScenario(AFTER_MANDATE)).toMatchObject({ ok: true, value: { trigger: 'mandat_signe', projectKind: null } });
    expect(parseScenario({ ...AFTER_VISIT, projectKind: 'buy' })).toMatchObject({ ok: false, code: 'bad_project_kind' });
    expect(parseScenario({ ...AFTER_MANDATE, projectKind: 'sell' })).toMatchObject({ ok: false, code: 'bad_project_kind' });
    expect(parseScenario({ ...AFTER_VISIT, trigger: 'visite' })).toMatchObject({ ok: false, code: 'bad_trigger' });
  });

  it('[R400] [R403] l’essai compte seulement les visites notées honorées, pour l’acquéreur', async () => {
    const t = await setup();
    t.setClock(TUE_10H - 10 * DAY);
    const ines = await t.person('Inès');
    const bruno = await t.person('Bruno');
    const lise = await t.person('Lise');
    const vendeur = await t.person('Vendeur');
    const ailleurs = await t.person('Ailleurs', t.other.id);
    await t.mark(await t.appointment(ines, 'visite'), 'honored');
    await t.mark(await t.appointment(bruno, 'visite'), 'absent');
    await t.mark(await t.appointment(lise, 'visite'), 'cancelled');
    await t.appointment(lise, 'visite');
    // Une estimation honorée n'est pas une visite ; une visite d'un autre réseau n'est pas d'ici.
    await t.mark(await t.appointment(vendeur, 'estimation'), 'honored');
    await t.mark(await t.appointment(ailleurs, 'visite', t.other.id), 'honored');
    // Trop vieille pour l'essai.
    t.setClock(TUE_10H - 40 * DAY);
    const vieux = await t.person('Vieux');
    await t.mark(await t.appointment(vieux, 'visite'), 'honored');
    t.setClock(TUE_10H);
    const id = await t.composed(AFTER_VISIT);
    const report = await t.scenarios.simulate(t.direction, id);
    expect(report).toMatchObject({ ok: true, value: { messages: 1, persons: 1, tasks: 1, refused: {}, canSwitchOn: true } });
    expect(await t.outbox()).toEqual([]);
  });

  it('[R400] [R39] l’essai compte seulement les mandats inscrits et jamais retirés, pour le mandant', async () => {
    const t = await setup();
    t.setClock(TUE_10H - 10 * DAY);
    const names = ['Inès', 'Bruno', 'Lise', 'Marc', 'Nora', 'Paul'];
    const p: Record<string, string> = {};
    for (const name of names) p[name] = await t.person(name);
    await t.mandate(p['Inès']!);
    await t.mandate(p['Bruno']!, false);
    await t.cancelMandate(await t.mandate(p['Lise']!), 'error');
    await t.cancelMandate(await t.mandate(p['Marc']!), 'termination');
    await t.withdraw(await t.mandate(p['Nora']!));
    await t.mandate(await t.person('Ailleurs', t.other.id), true, t.other.id);
    t.setClock(TUE_10H);
    const id = await t.composed(AFTER_MANDATE);
    expect(await t.scenarios.simulate(t.direction, id)).toMatchObject({ ok: true, value: { messages: 1, persons: 1, tasks: 1, canSwitchOn: true } });
  });

  it('[R401] allumé, une visite faite ensuite envoie au seul acquéreur, par le contrôle central en essai, une fois', async () => {
    const t = await setup();
    t.setClock(TUE_10H - 2 * DAY);
    const avant = await t.person('Avant');
    await t.mark(await t.appointment(avant, 'visite'), 'honored');
    t.setClock(TUE_10H);
    const id = await t.composed(AFTER_VISIT);
    await t.scenarios.simulate(t.direction, id);
    expect(await t.scenarios.switchOn(t.direction, id)).toMatchObject({ ok: true });
    t.setClock(TUE_10H + HOUR);
    const ines = await t.person('Inès');
    const bruno = await t.person('Bruno');
    await t.mark(await t.appointment(ines, 'visite'), 'honored');
    await t.mark(await t.appointment(bruno, 'visite'), 'absent');
    expect(await t.scenarios.tick(t.network.id)).toMatchObject({ created: 1, messagesInTrial: 0 });
    t.setClock(TUE_10H + 3 * HOUR + 1);
    expect(await t.scenarios.tick(t.network.id)).toMatchObject({ created: 0, messagesInTrial: 1, tasks: 1 });
    expect(await t.outbox()).toEqual([expect.objectContaining({ person_id: ines, body: expect.stringContaining('Bonjour Inès, merci pour la visite.') })]);
    expect(await t.runs()).toEqual([expect.objectContaining({ person_id: ines, status: 'fait', message_status: 'essai' })]);
    expect((await t.runs())[0]!.trigger_ref).toMatch(/^visit:/);
    // Repassé, rien ne repart.
    expect(await t.scenarios.tick(t.network.id)).toMatchObject({ created: 0, messagesInTrial: 0 });
  });

  it('[R401] [RC18] un mandat retiré avant le passage n’envoie rien et ne donne aucune tâche ; un autre part au mandant', async () => {
    const t = await setup();
    const id = await t.composed(AFTER_MANDATE);
    await t.scenarios.simulate(t.direction, id);
    expect(await t.scenarios.switchOn(t.direction, id)).toMatchObject({ ok: true });
    t.setClock(TUE_10H + HOUR);
    const ines = await t.person('Inès');
    const lise = await t.person('Lise');
    const nora = await t.person('Nora');
    await t.mandate(ines);
    const annule = await t.mandate(lise);
    const retracte = await t.mandate(nora);
    expect(await t.scenarios.tick(t.network.id)).toMatchObject({ created: 3 });
    // Retirés après le rangement du passage, avant son heure.
    t.setClock(TUE_10H + 5 * HOUR);
    await t.cancelMandate(annule, 'withdrawal');
    await t.withdraw(retracte);
    t.setClock(TUE_10H + 26 * HOUR);
    expect(await t.scenarios.tick(t.network.id)).toMatchObject({ messagesInTrial: 1, tasks: 1 });
    expect((await t.outbox()).map((o) => o.person_id)).toEqual([ines]);
    const byPerson = new Map((await t.runs()).map((r) => [r.person_id, r]));
    expect(byPerson.get(ines)).toMatchObject({ status: 'fait', message_status: 'essai' });
    expect(byPerson.get(lise)).toMatchObject({ status: 'annule', message_status: null, task_id: null });
    expect(byPerson.get(nora)).toMatchObject({ status: 'annule', message_status: null, task_id: null });
    expect(await t.db.first<{ n: number }>('SELECT COUNT(*) AS n FROM automation_tasks')).toEqual({ n: 1 });
    // Rien ne s'efface : les passages annulés restent [R17].
    expect((await t.runs()).length).toBe(3);
  });
});
