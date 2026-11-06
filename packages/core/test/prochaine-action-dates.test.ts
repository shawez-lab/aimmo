import { describe, expect, it } from 'vitest';
import { FicheClient, FicheUnique, SqlJournalStore, applyMigrations, fromSyncSqlite, type SqlDatabase } from '../src/index.ts';
import { DATES_PURPOSE, DEFAULT_DATES_SETTINGS, DatesClients, occasionDays, occasionOf } from '../src/automatismes/dates-clients.ts';
import { FiltresFiches, parseFilter } from '../src/automatismes/filtres.ts';
import { ProchaineAction } from '../src/automatismes/prochaine-action.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

// Un mardi d'octobre, 10 h à Paris. Réseau, agents, personnes et adresses inventés.
const TUE_10H = Date.parse('2027-10-12T08:00:00.000Z');
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const BIRTHDAY_TEXTS = ['Bonjour {prenom}, joyeux anniversaire ! Belle journée à vous.', 'Bonjour {prenom}, très bel anniversaire, avec toutes mes pensées.'];

async function setup() {
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  let clock = TUE_10H;
  const now = (): Date => new Date(clock);
  let n = 0;
  const newId = (): string => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
  const journal = new SqlJournalStore(db);
  const store = new FicheClient(db, { now });
  const unique = new FicheUnique(db, store, { now });
  const network = await store.createNetwork('Réseau test');
  const other = await store.createNetwork('Autre réseau');
  const alex = await store.createAgent({ networkId: network.id, firstName: 'Alex', lastName: 'Agent' });
  const lea = await store.createAgent({ networkId: network.id, firstName: 'Léa', lastName: 'Agent' });
  const direction = { role: 'direction' as const, userId: 'dir-1', networkId: network.id };
  const asAgent = (id: string) => ({ role: 'agent' as const, userId: id, networkId: network.id });
  const person = async (firstName: string, agentId: string | null = alex.id, networkId = network.id) => {
    const p = await store.createPerson({ networkId, agentId, firstName });
    await store.addIdentifier({ networkId, personId: p.id, kind: 'email', value: `${firstName.toLowerCase()}@example.test` });
    return p.id;
  };
  const consent = (personId: string, at = clock - DAY) => store.addConsent({ networkId: network.id, personId, purpose: DATES_PURPOSE, channel: 'email', proof: 'case cochée (test)', givenAt: new Date(at) });
  const lines = async () => (await journal.all()).map((l) => ({ type: l.type, data: JSON.stringify(l.data) }));
  const outbox = () => db.all<{ body: string; person_id: string }>('SELECT m.body, m.person_id FROM trial_outbox o JOIN messages m ON m.id = o.message_id ORDER BY m.rowid');
  return {
    db,
    journal,
    store,
    unique,
    network,
    other,
    alex,
    lea,
    direction,
    asAgent,
    person,
    consent,
    lines,
    outbox,
    actions: new ProchaineAction(db, journal, { now }),
    filtres: new FiltresFiches(db, journal, { now }),
    dates: new DatesClients(db, journal, { now, newId }),
    setClock: (t: number) => (clock = t),
    now,
  };
}

describe('HX25 · jours de date, sans base', () => {
  it('[R405] le dimanche se souhaite le lundi, jamais une date plus ancienne ; le 29 février le 28 les années sans 29', () => {
    expect(occasionDays('2027-10-18', DEFAULT_DATES_SETTINGS.window)).toEqual(['2027-10-18', '2027-10-17']);
    expect(occasionDays('2027-10-19', DEFAULT_DATES_SETTINGS.window)).toEqual(['2027-10-19']);
    expect(occasionDays('2027-10-16', DEFAULT_DATES_SETTINGS.window)).toEqual(['2027-10-16']);
    expect(occasionOf(2, 29, 2027)).toBe('2027-02-28');
    expect(occasionOf(2, 29, 2028)).toBe('2028-02-29');
    expect(occasionOf(10, 7, 2027)).toBe('2027-10-07');
  });

  it('[R407] un filtre est en liste fermée', () => {
    for (const bad of [null, [], { budget: 1 }, { budgetMin: -1 }, { budgetMin: 1.5 }, { budgetMin: 300_000, budgetMax: 200_000 }, { sectors: 'Dijon' }, { sectors: [''] }, { kinds: ['achat'] }, { openOnly: 'oui' }]) {
      expect(parseFilter(bad)).toMatchObject({ ok: false, rule: 'R407' });
    }
    expect(parseFilter({ sectors: ['Chenôve'], kinds: ['buy', 'buy'] })).toEqual({ ok: true, value: { budgetMin: null, budgetMax: null, sectors: ['chenove'], kinds: ['buy'], openOnly: true } });
  });
});

describeWithSqlite('HX25 · prochaine action, filtres et dates des clients', () => {
  it('[R406] chaque action proposée cite sa raison : un fait daté de la fiche, retrouvé dans la base', async () => {
    const t = await setup();
    const me = t.asAgent(t.alex.id);
    const cases: { id: string; action: string; table: string; text: RegExp }[] = [];

    // Aucun projet : qualifier, d'après la date de la fiche.
    const sam = await t.person('Sam');
    cases.push({ id: sam, action: 'qualifier', table: 'persons', text: /^Qualifier le projet : fiche créée le 12\/10, aucun projet noté\.$/ });

    // Dernier message de la personne : répondre.
    const noa = await t.person('Noa');
    await t.store.createProject({ networkId: t.network.id, agentId: t.alex.id, personId: noa, kind: 'buy' });
    await t.store.recordMessage({ networkId: t.network.id, agentId: t.alex.id, personId: noa, channel: 'email', direction: 'out', authorKind: 'agent', body: 'Bonjour Noa.', occurredAt: new Date(TUE_10H - 3 * HOUR) });
    await t.store.recordMessage({ networkId: t.network.id, agentId: t.alex.id, personId: noa, channel: 'email', direction: 'in', authorKind: 'person', body: 'Bonjour, des nouvelles ?', occurredAt: new Date(TUE_10H - HOUR) });
    cases.push({ id: noa, action: 'repondre', table: 'messages', text: /^Répondre : message reçu le 12\/10 à 9 h 00, sans réponse depuis\.$/ });

    // Un projet ouvert, dernier échange il y a 20 jours : relancer.
    const eli = await t.person('Eli');
    await t.store.createProject({ networkId: t.network.id, agentId: t.alex.id, personId: eli, kind: 'sell' });
    await t.store.recordMessage({ networkId: t.network.id, agentId: t.alex.id, personId: eli, channel: 'email', direction: 'out', authorKind: 'agent', body: 'Bonjour Eli.', occurredAt: new Date(TUE_10H - 20 * DAY) });
    cases.push({ id: eli, action: 'relancer', table: 'messages', text: /^Relancer le projet de vente : dernier échange le 22\/09, il y a 20 jours\.$/ });

    // Un projet ouvert, dernier échange il y a 3 jours : attendre, et jusqu'à quand.
    const ari = await t.person('Ari');
    await t.store.createProject({ networkId: t.network.id, agentId: t.alex.id, personId: ari, kind: 'rent_out' });
    await t.store.recordMessage({ networkId: t.network.id, agentId: t.alex.id, personId: ari, channel: 'email', direction: 'out', authorKind: 'agent', body: 'Bonjour Ari.', occurredAt: new Date(TUE_10H - 3 * DAY) });
    cases.push({ id: ari, action: 'attendre', table: 'messages', text: /^Rien à faire avant le 23\/10 : dernier échange le 09\/10\.$/ });

    // Arrêt demandé : ne pas relancer, même avec un message sans réponse.
    const zoe = await t.person('Zoé');
    await t.store.createProject({ networkId: t.network.id, agentId: t.alex.id, personId: zoe, kind: 'buy' });
    await t.store.recordMessage({ networkId: t.network.id, agentId: t.alex.id, personId: zoe, channel: 'email', direction: 'in', authorKind: 'person', body: 'Stop.', occurredAt: new Date(TUE_10H - 2 * DAY) });
    await t.store.addExclusion({ networkId: t.network.id, agentId: t.alex.id, personId: zoe, reason: 'stop', notedAt: new Date(TUE_10H - 2 * DAY) });
    cases.push({ id: zoe, action: 'ne_pas_relancer', table: 'exclusions', text: /^Ne pas relancer : la personne a demandé l’arrêt le 10\/10\.$/ });

    // Une tâche de scénario arrivée à son jour.
    const tim = await t.person('Tim');
    await t.store.createProject({ networkId: t.network.id, agentId: t.alex.id, personId: tim, kind: 'buy' });
    await t.store.recordMessage({ networkId: t.network.id, agentId: t.alex.id, personId: tim, channel: 'email', direction: 'out', authorKind: 'agent', body: 'Bonjour Tim.', occurredAt: new Date(TUE_10H - DAY) });
    await t.db.run("INSERT INTO automation_scenarios (id, version, network_id, definition, created_by, created_at) VALUES ('sc-1', 1, ?, '{}', 'direction:dir-1', ?)", [t.network.id, new Date(TUE_10H).toISOString()]);
    await t.db.run("INSERT INTO automation_runs (id, network_id, scenario_id, version, trigger_ref, person_id, triggered_at, due_at, status, created_at) VALUES ('run-1', ?, 'sc-1', 1, 'x', ?, ?, ?, 'fait', ?)", [t.network.id, tim, ...Array(3).fill(new Date(TUE_10H - 2 * DAY).toISOString())]);
    await t.db.run("INSERT INTO automation_tasks (id, network_id, run_id, agent_id, person_id, title, due_day, created_at) VALUES ('task-1', ?, 'run-1', ?, ?, 'Appeler le nouveau contact', '2027-10-11', ?)", [t.network.id, t.alex.id, tim, new Date(TUE_10H - 2 * DAY).toISOString()]);
    cases.push({ id: tim, action: 'faire_tache', table: 'automation_tasks', text: /^Faire la tâche « Appeler le nouveau contact », prévue le 11\/10, en retard\.$/ });

    const refTable: Record<string, string> = { fiche: 'persons', message: 'messages', arret: 'exclusions', tache: 'automation_tasks', projet: 'projects' };
    for (const c of cases) {
      const r = await t.actions.suggest(me, c.id);
      if (!r.ok) throw new Error(`refusé : ${r.code}`);
      expect(r.value.action).toBe(c.action);
      expect(r.value.reason).toMatch(c.text);
      expect(r.value.reason).not.toContain('\n');
      // Le fait cité existe, sur cette fiche.
      const [kind, id] = r.value.basis.ref.split(':') as [string, string];
      expect(refTable[kind]).toBe(c.table);
      expect(await t.db.first(`SELECT id FROM ${c.table} WHERE id = ?`, [id])).not.toBeNull();
    }
    // Le journal garde la lecture, jamais la raison [R13].
    const all = JSON.stringify(await t.lines());
    expect(all).not.toContain('Relancer');
    expect(all).not.toContain('Appeler le nouveau contact');
  });

  it('[R406] [R16] la prochaine action d’une fiche se lit sous droits', async () => {
    const t = await setup();
    const sam = await t.person('Sam');
    expect(await t.actions.suggest(t.asAgent(t.lea.id), sam)).toMatchObject({ ok: false, rule: 'R16', code: 'not_assigned' });
    expect(await t.actions.suggest({ role: 'direction', userId: 'd', networkId: t.other.id }, sam)).toMatchObject({ ok: false, rule: 'R16' });
    expect(await t.actions.suggest(t.direction, sam)).toMatchObject({ ok: true, value: { action: 'qualifier' } });
  });

  it('[R407] [R16] un filtre ne montre jamais une fiche hors des droits de l’agent, fiche réunie comprise', async () => {
    const t = await setup();
    const project = (personId: string, agentId: string, extra: Record<string, unknown>) =>
      t.store.createProject({ networkId: t.network.id, agentId, personId, kind: 'buy', budgetMinEur: 180_000, budgetMaxEur: 240_000, criteria: { city: 'Chenôve', postalCode: '21300' }, ...extra });
    const mine = await t.person('Sam');
    await project(mine, t.alex.id, {});
    const hers = await t.person('Noa', t.lea.id);
    await project(hers, t.lea.id, {});
    // Une fiche d'Alex réunie à une fiche de Léa : elle n'est plus seulement à Alex.
    const shared = await t.person('Eli');
    await project(shared, t.alex.id, {});
    const leaSide = await t.person('Eli');
    await t.unique.merge({ survivorId: leaSide, mergedId: shared, reason: 'même mail (test)' });
    // Puis la fiche gardée passe à Léa (réattribution) : la fiche réunie n'est plus seulement à Alex.
    await t.db.run('UPDATE persons SET agent_id = ? WHERE id = ?', [t.lea.id, leaSide]);
    const elsewhere = await t.person('Ari', null, t.other.id);
    await t.store.createProject({ networkId: t.other.id, personId: elsewhere, kind: 'buy', budgetMinEur: 180_000, budgetMaxEur: 240_000, criteria: { city: 'Chenôve' } });

    const filter = { budgetMin: 200_000, budgetMax: 260_000, sectors: ['chenove'], kinds: ['buy'] };
    const alex = await t.filtres.filter(t.asAgent(t.alex.id), filter);
    expect(alex).toMatchObject({ ok: true });
    if (!alex.ok) return;
    expect(alex.value.map((f) => f.personId)).toEqual([mine]);
    const dir = await t.filtres.filter(t.direction, filter);
    if (!dir.ok) throw new Error('refusé');
    expect(dir.value.map((f) => f.personId).sort()).toEqual([mine, hers, leaSide].sort());
    // La fiche réunie est montrée une fois, avec le projet de la fiche fusionnée.
    expect(dir.value.find((f) => f.personId === leaSide)!.projectIds).toHaveLength(1);
    expect(await t.filtres.filter({ role: 'partner', userId: 'p', networkId: t.network.id }, filter)).toMatchObject({ ok: false, rule: 'R16' });
    const otherDir = await t.filtres.filter({ role: 'direction', userId: 'd2', networkId: t.other.id }, { sectors: ['21'] });
    expect(otherDir).toMatchObject({ ok: true, value: [] });

    // Un agent au dossier incomplet ne filtre rien [R82].
    await t.db.run(
      "INSERT INTO agent_file_pieces (id, network_id, agent_id, kind, version, ref, issued_on, valid_until, is_draft, recorded_by, recorded_at) VALUES ('piece-1', ?, ?, 'contrat_agent_commercial', 1, 'ref-1', '2026-01-01', NULL, 0, 'test', ?)",
      [t.network.id, t.alex.id, t.now().toISOString()],
    );
    expect(await t.filtres.filter(t.asAgent(t.alex.id), filter)).toMatchObject({ ok: false, code: 'agent_file_incomplete' });
    // Le journal garde les noms des critères, jamais leurs valeurs [R13].
    const filtered = (await t.lines()).filter((l) => l.type === 'fiches.filtrees');
    expect(filtered.length).toBeGreaterThan(0);
    expect(JSON.stringify(filtered)).not.toMatch(/chenove|200000|260000/);
  });

  it('[R407] chaque critère tient sur le même projet : budget qui se touche, secteur par ville ou code postal, sorte', async () => {
    const t = await setup();
    const me = t.asAgent(t.alex.id);
    const sam = await t.person('Sam');
    await t.store.createProject({ networkId: t.network.id, agentId: t.alex.id, personId: sam, kind: 'buy', budgetMaxEur: 150_000, criteria: { city: 'Dijon', postalCode: '21000' } });
    await t.store.createProject({ networkId: t.network.id, agentId: t.alex.id, personId: sam, kind: 'sell', budgetMinEur: 300_000, criteria: { city: 'Beaune' } });
    const noBudget = await t.person('Noa');
    await t.store.createProject({ networkId: t.network.id, agentId: t.alex.id, personId: noBudget, kind: 'buy', criteria: { city: 'Dijon' } });
    const closed = await t.person('Eli');
    await t.store.createProject({ networkId: t.network.id, agentId: t.alex.id, personId: closed, kind: 'buy', stage: 'acte_signe', budgetMaxEur: 150_000, criteria: { city: 'Dijon' } });

    const ids = async (f: unknown) => {
      const r = await t.filtres.filter(me, f);
      if (!r.ok) throw new Error(r.code);
      return r.value.map((x) => x.personId).sort();
    };
    expect(await ids({ budgetMin: 100_000, budgetMax: 160_000 })).toEqual([sam]);
    // Achat à Beaune : aucun projet ne tient les deux à la fois.
    expect(await ids({ kinds: ['buy'], sectors: ['Beaune'] })).toEqual([]);
    expect(await ids({ kinds: ['sell'], sectors: ['beaune'], budgetMin: 400_000 })).toEqual([sam]);
    expect(await ids({ sectors: ['21'] })).toEqual([sam]);
    expect(await ids({ sectors: ['DIJON'] })).toEqual([sam, noBudget].sort());
    expect(await ids({ sectors: ['dijon'], openOnly: false })).toEqual([sam, noBudget, closed].sort());
    expect(await t.filtres.filter(me, { secteur: 'Dijon' })).toMatchObject({ ok: false, rule: 'R407', code: 'unknown_field' });
  });

  it('[R404] aucun message de date sans date donnée et accord rangé', async () => {
    const t = await setup();
    const me = t.asAgent(t.alex.id);
    expect(await t.dates.setTexts(t.direction, { kind: 'anniversaire', channel: 'email', texts: BIRTHDAY_TEXTS })).toMatchObject({ ok: true });

    // Accord rangé, mais aucune date donnée : rien.
    const noDate = await t.person('Sam');
    await t.consent(noDate);
    // Date donnée, sans accord : rien.
    const noConsent = await t.person('Noa');
    expect(await t.dates.recordDate(me, { personId: noConsent, kind: 'anniversaire', month: 10, day: 12, proof: 'dit au téléphone (test)' })).toMatchObject({ ok: true });
    // Date et accord, mais accord retiré : rien.
    const withdrawn = await t.person('Eli');
    await t.dates.recordDate(me, { personId: withdrawn, kind: 'anniversaire', month: 10, day: 12, proof: 'formulaire du site (test)' });
    const c = await t.consent(withdrawn);
    await t.store.withdrawConsent(c.id, new Date(TUE_10H - HOUR));
    // Accord d'une autre finalité : rien.
    const otherPurpose = await t.person('Ari');
    await t.dates.recordDate(me, { personId: otherPurpose, kind: 'anniversaire', month: 10, day: 12, proof: 'dit en visite (test)' });
    await t.store.addConsent({ networkId: t.network.id, personId: otherPurpose, purpose: 'automatismes', channel: 'email', proof: 'case (test)', givenAt: new Date(TUE_10H - DAY) });
    // Date et accord : préparé.
    const ok = await t.person('Zoé');
    await t.dates.recordDate(me, { personId: ok, kind: 'anniversaire', month: 10, day: 12, proof: 'dit au téléphone (test)' });
    await t.consent(ok);

    // Date et accord, mais la personne a demandé l'arrêt : le contrôle central refuse, rien ne part [R04].
    const stopped = await t.person('Tim');
    await t.dates.recordDate(me, { personId: stopped, kind: 'anniversaire', month: 10, day: 12, proof: 'dit au téléphone (test)' });
    await t.consent(stopped);
    await t.store.addExclusion({ networkId: t.network.id, agentId: t.alex.id, personId: stopped, reason: 'stop', notedAt: new Date(TUE_10H - HOUR) });

    const report = await t.dates.tick(t.network.id);
    expect(report).toMatchObject({ closed: false, messagesInTrial: 1, refused: 1, withoutConsent: 3 });
    // Le message passe par le contrôle central, en relance avec son sujet : chaque essai y est écrit.
    expect(await t.db.all("SELECT person_id, outcome, rule FROM send_log WHERE kind = 'follow_up' ORDER BY person_id = ? DESC", [ok])).toEqual([
      { person_id: ok, outcome: 'sent', rule: null },
      { person_id: stopped, outcome: 'refused', rule: 'R04' },
    ]);
    expect(await t.outbox()).toEqual([{ person_id: ok, body: expect.stringContaining('Zoé, joyeux anniversaire') }]);
    const rows = await t.db.all<{ person_id: string; status: string }>('SELECT person_id, status FROM client_date_messages ORDER BY person_id');
    expect(rows).toEqual([{ person_id: ok, status: 'essai' }, { person_id: stopped, status: 'refuse' }].sort((a, b) => a.person_id.localeCompare(b.person_id)));
    // Une seule fois par an : un second passage le même jour ne prépare rien.
    expect(await t.dates.tick(t.network.id)).toMatchObject({ messagesInTrial: 0 });
    expect(await t.outbox()).toHaveLength(1);

    // Une date sans d'où elle vient, invalide, ou rangée par un agent qui ne suit pas la fiche : refusée.
    expect(await t.dates.recordDate(me, { personId: ok, kind: 'fete', month: 2, day: 30, proof: 'x' })).toMatchObject({ ok: false, rule: 'R404', code: 'bad_date' });
    expect(await t.dates.recordDate(me, { personId: ok, kind: 'fete', month: 2, day: 29, proof: '  ' })).toMatchObject({ ok: false, rule: 'R404', code: 'no_proof' });
    expect(await t.dates.recordDate(me, { personId: ok, kind: 'mariage', month: 2, day: 2, proof: 'x' })).toMatchObject({ ok: false, code: 'bad_kind' });
    expect(await t.dates.recordDate(t.asAgent(t.lea.id), { personId: ok, kind: 'fete', month: 2, day: 2, proof: 'x' })).toMatchObject({ ok: false, rule: 'R16', code: 'not_assigned' });
    // Le journal ne garde ni la date ni le texte [R13].
    const all = JSON.stringify(await t.lines());
    expect(all).not.toContain('anniversaire !');
    expect(all).not.toMatch(/"month"|"day"/);
  });

  it('[R405] [R01] jamais la nuit ni le dimanche : une date du dimanche se souhaite le lundi, une seule fois', async () => {
    const t = await setup();
    await t.dates.setTexts(t.direction, { kind: 'anniversaire', channel: 'email', texts: BIRTHDAY_TEXTS });
    const sun = await t.person('Sam');
    await t.consent(sun);
    await t.dates.recordDate(t.asAgent(t.alex.id), { personId: sun, kind: 'anniversaire', month: 10, day: 17, proof: 'dit au téléphone (test)' });
    const SUN = Date.parse('2027-10-17T08:00:00.000Z');
    // Dimanche 10 h : rien n'est regardé.
    t.setClock(SUN);
    expect(await t.dates.tick(t.network.id)).toMatchObject({ closed: true, messagesInTrial: 0 });
    // Samedi 22 h, la veille : la nuit, rien non plus.
    t.setClock(Date.parse('2027-10-16T20:00:00.000Z'));
    expect(await t.dates.tick(t.network.id)).toMatchObject({ closed: true });
    // Lundi 7 h 30 : encore la nuit.
    t.setClock(Date.parse('2027-10-18T05:30:00.000Z'));
    expect(await t.dates.tick(t.network.id)).toMatchObject({ closed: true });
    expect(await t.outbox()).toHaveLength(0);
    // Lundi 8 h : souhaitée.
    t.setClock(Date.parse('2027-10-18T06:00:00.000Z'));
    expect(await t.dates.tick(t.network.id)).toMatchObject({ messagesInTrial: 1 });
    // Mardi : plus rien, et jamais deux fois.
    t.setClock(Date.parse('2027-10-19T08:00:00.000Z'));
    expect(await t.dates.tick(t.network.id)).toMatchObject({ messagesInTrial: 0 });
    expect(await t.outbox()).toHaveLength(1);
    const sent = await t.db.all<{ at: string }>("SELECT occurred_at AS at FROM send_log WHERE outcome <> 'refused'");
    for (const s of sent) expect(new Date(s.at).getUTCDay()).not.toBe(0);
  });

  it('[R405] [R403] seule la direction écrit les textes, contrôlés, sans chiffre ; l’an suivant prend un autre texte', async () => {
    const t = await setup();
    const me = t.asAgent(t.alex.id);
    expect(await t.dates.setTexts(me, { kind: 'anniversaire', channel: 'email', texts: BIRTHDAY_TEXTS })).toMatchObject({ ok: false, rule: 'R16', code: 'not_direction' });
    expect(await t.dates.setTexts(t.direction, { kind: 'anniversaire', channel: 'email', texts: ['Bonjour {prenom}, -10 % pour votre anniversaire.'] })).toMatchObject({ ok: false, rule: 'R10' });
    expect(await t.dates.setTexts(t.direction, { kind: 'anniversaire', channel: 'email', texts: ['Joyeux anniversaire !'] })).toMatchObject({ ok: false, code: 'first_name_slot' });
    expect(await t.dates.setTexts(t.direction, { kind: 'anniversaire', channel: 'instagram', texts: BIRTHDAY_TEXTS })).toMatchObject({ ok: false, code: 'bad_channel' });
    expect(await t.dates.setTexts(t.direction, { kind: 'anniversaire', channel: 'email', texts: [] })).toMatchObject({ ok: false, code: 'bad_texts' });
    expect(await t.dates.setTexts(t.direction, { kind: 'anniversaire', channel: 'email', texts: BIRTHDAY_TEXTS })).toEqual({ ok: true, value: { seq: 1 } });

    const sam = await t.person('Sam');
    await t.consent(sam);
    await t.dates.recordDate(me, { personId: sam, kind: 'anniversaire', month: 10, day: 12, proof: 'dit au téléphone (test)' });
    await t.dates.tick(t.network.id);
    // L'an suivant, le même jour (un mercredi) : le premier texte est déjà parti, le second est pris [R05].
    t.setClock(Date.parse('2028-10-12T08:00:00.000Z'));
    expect(await t.dates.tick(t.network.id)).toMatchObject({ messagesInTrial: 1 });
    const bodies = (await t.outbox()).map((o) => o.body);
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toContain('joyeux anniversaire');
    expect(bodies[1]).toContain('très bel anniversaire');
  });
});
