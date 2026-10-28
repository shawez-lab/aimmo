import { expect, it } from 'vitest';
import {
  Acces,
  ControleEnvois,
  DecisionEnvoi,
  FakeChannel,
  FicheClient,
  FicheUnique,
  Planificateur,
  SqlJournalStore,
  SqlSendJournal,
  agentState,
  applyMigrations,
  fromSyncSqlite,
  reseau,
  verifyChain,
  type SqlDatabase,
  type Viewer,
} from '../src/index.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

// Réseau, agents, clients, biens et pièces inventés. Les jeux restent en hiver : Paris = UTC + 1.
let n = 0;
const uuid = (): string => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
const PIECES = ['contrat_agent_commercial', 'attestation_habilitation', 'immatriculation_rsac', 'assurance_rcp', 'attestation_vigilance'] as const;

async function setup() {
  let clock = Date.parse('2027-01-11T09:00:00.000Z'); // lundi 11 janvier 2027, 10 h à Paris
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  const now = (): Date => new Date(clock);
  const journal = new SqlJournalStore(db);
  const store = new FicheClient(db, { now });
  const fiche = new FicheUnique(db, store, { now });
  const acces = new Acces(db, store, fiche, journal, { now });
  const network = (await store.createNetwork('Réseau test')).id;
  const direction: Viewer = { role: 'direction', userId: 'dir-1', networkId: network };
  const as = (id: string): Viewer => ({ role: 'agent', userId: id, networkId: network });
  /** Range une pièce signée ; `validUntil` nul pour le contrat. */
  const piece = async (agentId: string, kind: (typeof PIECES)[number], issuedOn: string, validUntil: string | null): Promise<void> => {
    const v = await db.first<{ v: number | null }>('SELECT MAX(version) AS v FROM agent_file_pieces WHERE agent_id = ? AND kind = ?', [agentId, kind]);
    await db.run(
      'INSERT INTO agent_file_pieces (id, network_id, agent_id, kind, version, ref, issued_on, valid_until, is_draft, recorded_by, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)',
      [uuid(), network, agentId, kind, Number(v?.v ?? 0) + 1, `agents/${agentId}/${uuid()}.pdf`, issuedOn, validUntil, 'direction:dir-1', now().toISOString()],
    );
  };
  /** Un dossier complet : habilitation jusqu'au `habilitationUntil`, le reste valable longtemps. */
  const completeFile = async (agentId: string, habilitationUntil = '2028-12-31'): Promise<void> => {
    await piece(agentId, 'contrat_agent_commercial', '2026-12-01', null);
    await piece(agentId, 'attestation_habilitation', '2026-12-01', habilitationUntil);
    await piece(agentId, 'immatriculation_rsac', '2026-12-01', null);
    await piece(agentId, 'assurance_rcp', '2026-12-01', '2027-12-31');
    await piece(agentId, 'attestation_vigilance', '2026-12-01', '2027-05-31');
  };
  const agent = async (lastName: string): Promise<string> => (await store.createAgent({ networkId: network, firstName: 'Camille', lastName })).id;
  const alex = await agent('Alex');
  const sam = await agent('Sam');
  const client = (await store.createPerson({ networkId: network, agentId: alex, firstName: 'Léa', lastName: 'Exemple' })).id;
  const draft = (await store.createProperty({ networkId: network, agentId: alex, reference: 'REF-J13-1', kind: 'home', status: 'draft' })).id;
  const onSale = (await store.createProperty({ networkId: network, agentId: alex, reference: 'REF-J13-2', kind: 'home', status: 'available' })).id;
  return {
    db,
    journal,
    store,
    fiche,
    acces,
    network,
    direction,
    as,
    piece,
    completeFile,
    agent,
    alex,
    sam,
    client,
    draft,
    onSale,
    now,
    setClock: (iso: string) => {
      clock = Date.parse(iso);
    },
  };
}

describeWithSqlite('J13 · branchement de M14 dans le socle', () => {
  it('[R82] [R16] un agent au dossier incomplet ne lit aucune fiche client, ni un bien hors du fichier commun ; complet, il lit', async () => {
    const t = await setup();
    await t.piece(t.alex, 'contrat_agent_commercial', '2026-12-01', null);
    expect(await agentState(t.db, t.network, t.alex, t.now())).toBe('dossier_incomplet');
    expect(await t.acces.readFiche(t.as(t.alex), t.client)).toEqual({ ok: false, rule: 'R16', code: 'agent_file_incomplete' });
    expect(await t.acces.listPersons(t.as(t.alex))).toEqual({ ok: false, rule: 'R16', code: 'agent_file_incomplete' });
    // Son propre bien en brouillon : refusé ; son bien en vente : seulement comme fiche commune.
    expect(await t.acces.readProperty(t.as(t.alex), t.draft)).toEqual({ ok: false, rule: 'R16', code: 'not_assigned' });
    expect(await t.acces.readProperty(t.as(t.alex), t.onSale)).toMatchObject({ ok: true, view: 'shared' });
    const refusals = (await t.journal.all()).filter((e) => e.type === 'acces.refuse' && e.data['code'] === 'agent_file_incomplete');
    expect(refusals.length).toBe(2);
    // Aucun nom au journal [R13].
    expect(JSON.stringify(await t.journal.all())).not.toMatch(/Léa|Exemple|Camille/);

    // Les quatre autres pièces rangées : le dossier est complet, la fiche s'ouvre en entier.
    await t.completeFile(t.alex);
    expect(await agentState(t.db, t.network, t.alex, t.now())).toBe('actif');
    expect(await t.acces.readFiche(t.as(t.alex), t.client)).toMatchObject({ ok: true, view: 'full' });
    expect(await t.acces.readProperty(t.as(t.alex), t.draft)).toMatchObject({ ok: true, view: 'full' });
    expect(await verifyChain(await t.journal.all())).toMatchObject({ ok: true });
  });

  it('[R82] une pièce échue ferme l’accès le jour même, à minuit à Paris ; une nouvelle version le rouvre', async () => {
    const t = await setup();
    await t.completeFile(t.alex, '2027-01-12');
    expect((await t.acces.readFiche(t.as(t.alex), t.client)).ok).toBe(true);
    // Le 12 à 23 h 59 à Paris, l'habilitation vaut encore ; le 13 à 0 h 01, elle est échue.
    t.setClock('2027-01-12T22:59:00.000Z');
    expect((await t.acces.readFiche(t.as(t.alex), t.client)).ok).toBe(true);
    t.setClock('2027-01-12T23:01:00.000Z');
    expect(await t.acces.readFiche(t.as(t.alex), t.client)).toEqual({ ok: false, rule: 'R16', code: 'agent_file_incomplete' });
    await t.piece(t.alex, 'attestation_habilitation', '2027-01-12', '2028-01-12');
    expect((await t.acces.readFiche(t.as(t.alex), t.client)).ok).toBe(true);
  });

  it('[R82] un agent entré par M14 sans aucune pièce est refusé ; un agent de l’agence sans dossier garde ses droits', async () => {
    const t = await setup();
    // Sam est entré par une candidature retenue (J04) : son dossier est vide, donc incomplet.
    const candidate = uuid();
    await t.db.run(
      "INSERT INTO candidates (id, network_id, first_name, email, current_status, experience, source, created_at) VALUES (?, ?, 'Sam', 'sam.candidat@example.test', 'autre_metier', 'aucune', 'page', ?)",
      [candidate, t.network, t.now().toISOString()],
    );
    await t.db.run('INSERT INTO agent_onboardings (agent_id, network_id, candidate_id, created_by, created_at) VALUES (?, ?, ?, ?, ?)', [t.sam, t.network, candidate, 'direction:dir-1', t.now().toISOString()]);
    const samClient = (await t.store.createPerson({ networkId: t.network, agentId: t.sam, firstName: 'Noé', lastName: 'Exemple' })).id;
    expect(await t.acces.readFiche(t.as(t.sam), samClient)).toEqual({ ok: false, rule: 'R16', code: 'agent_file_incomplete' });
    // Alex, créé hors de M14 et sans dossier, lit ses clients (décision écrite au plan).
    expect(await agentState(t.db, t.network, t.alex, t.now())).toBe('actif');
    expect((await t.acces.readFiche(t.as(t.alex), t.client)).ok).toBe(true);
    // La direction et la conformité ne sont jamais concernées.
    expect((await t.acces.readFiche(t.direction, samClient)).ok).toBe(true);
  });

  it('[R86] [R16] un agent parti ne lit plus rien dès minuit le jour de son départ, avant le passage du planificateur', async () => {
    const t = await setup();
    await t.completeFile(t.alex);
    const departs = new reseau.Departs(t.db, t.journal, { now: t.now });
    const scheduled = await departs.schedule(t.direction, t.alex, { noticeGivenOn: '2027-01-11', leavesOn: '2027-01-13', reason: 'accord_mutuel', contractStartedOn: '2026-12-01' });
    expect(scheduled.ok).toBe(true);
    t.setClock('2027-01-12T22:59:00.000Z');
    expect((await t.acces.readFiche(t.as(t.alex), t.client)).ok).toBe(true);
    t.setClock('2027-01-12T23:00:00.000Z');
    expect((await t.store.getAgent(t.alex))!.status).toBe('active');
    expect(await agentState(t.db, t.network, t.alex, t.now())).toBe('parti');
    expect(await t.acces.readFiche(t.as(t.alex), t.client)).toEqual({ ok: false, rule: 'R16', code: 'agent_inactive' });
    expect(await t.acces.listPersons(t.as(t.alex))).toEqual({ ok: false, rule: 'R16', code: 'agent_inactive' });
    expect(await t.acces.readProperty(t.as(t.alex), t.onSale)).toEqual({ ok: false, rule: 'R16', code: 'agent_inactive' });
  });

  it('[R86] le contrôle central refuse tout envoi au nom de l’agent parti ou préparé par lui, avant le planificateur', async () => {
    const t = await setup();
    const decisions = new DecisionEnvoi(t.db, t.store, t.fiche, { now: t.now });
    const email = new FakeChannel('email');
    const controle = new ControleEnvois(t.db, t.fiche, decisions, { channels: [email], journal: new SqlSendJournal(t.db), budget: { allows: async () => false }, now: t.now });
    await t.store.addIdentifier({ networkId: t.network, personId: t.client, kind: 'email', value: 'lea.exemple@example.test' });
    await t.store.addConsent({ networkId: t.network, personId: t.client, purpose: 'follow_up', channel: 'email', proof: 'formulaire test', givenAt: new Date('2026-01-01T00:00:00.000Z') });
    const departs = new reseau.Departs(t.db, t.journal, { now: t.now });
    expect((await departs.schedule(t.direction, t.alex, { noticeGivenOn: '2027-01-11', leavesOn: '2027-01-13', reason: 'accord_mutuel', contractStartedOn: '2026-12-01' })).ok).toBe(true);
    let k = 0;
    const TEXTS = [
      'Bonjour Léa, votre agent revient vers vous cette semaine au sujet de votre projet.',
      'Bonjour Léa, un point sur votre projet vous sera proposé très bientôt.',
      'Bonjour Léa, nous gardons votre projet en tête et reprenons contact sous peu.',
      'Bonjour Léa, votre projet avance : votre agent vous appelle prochainement.',
      'Bonjour Léa, nous restons à votre écoute pour la suite de votre projet.',
      'Bonjour Léa, la suite de votre projet vous sera présentée par téléphone.',
      'Bonjour Léa, merci pour votre confiance, nous revenons vers vous.',
    ];
    const order = (extra: { agentId?: string | null; preparedBy?: string | null }) => ({
      networkId: t.network,
      personId: t.client,
      channel: 'email' as const,
      kind: 'follow_up' as const,
      subject: `relance:j13-${++k}`,
      fallbackTexts: [TEXTS[k % TEXTS.length]!],
      ...extra,
    });
    // La veille, l'agent est encore là : l'envoi préparé en son nom part.
    t.setClock('2027-01-12T09:00:00.000Z');
    expect((await controle.send(order({ agentId: t.alex }))).status).toBe('sent');
    // Le jour du départ, à 10 h, le planificateur n'a pas encore passé : rien ne part plus en son nom ni de sa main.
    t.setClock('2027-01-13T09:00:00.000Z');
    expect((await t.store.getAgent(t.alex))!.status).toBe('active');
    expect(await controle.send(order({ agentId: t.alex }))).toMatchObject({ status: 'refused', rule: 'R86', messageId: null });
    expect(await controle.send(order({ agentId: t.sam, preparedBy: t.alex }))).toMatchObject({ status: 'refused', rule: 'R86' });
    expect(email.sent.length).toBe(1);
    // Le refus est au journal des envois, avec sa règle.
    const log = await t.db.all<{ rule: string | null; outcome: string }>("SELECT rule, outcome FROM send_log WHERE outcome = 'refused' ORDER BY rowid");
    expect(log).toEqual([
      { rule: 'R86', outcome: 'refused' },
      { rule: 'R86', outcome: 'refused' },
    ]);
    // Un envoi d'un autre agent, sans lien avec l'agent parti, part toujours.
    const other = await controle.send(order({ agentId: t.sam }));
    expect([other.status, other.rule]).toEqual(['sent', null]);
    expect(email.sent.length).toBe(2);
    // Après la reprise par la direction, un suivi du système rangé au nom de l'agent parti part au nom du réseau ; ce qu'il
    // avait préparé, jamais.
    expect((await departs.runDue(t.network)).map((d) => d.agentId)).toEqual([t.alex]);
    expect((await t.store.getPerson(t.client))!.agent_id).toBeNull();
    t.setClock('2027-01-14T09:00:00.000Z');
    const follow = await controle.send(order({ agentId: t.alex }));
    expect([follow.status, follow.rule]).toEqual(['sent', null]);
    expect(await controle.send(order({ agentId: null, preparedBy: t.alex }))).toMatchObject({ status: 'refused', rule: 'R86' });
    expect(await t.db.first<{ agent_id: string | null }>('SELECT agent_id FROM send_log WHERE message_id = ?', [follow.messageId])).toEqual({ agent_id: null });
  });

  it('[R86] [R18] le planificateur fait les départs du jour au premier passage après minuit, une fois par créneau', async () => {
    const t = await setup();
    await t.completeFile(t.alex);
    const departs = new reseau.Departs(t.db, t.journal, { now: t.now });
    expect((await departs.schedule(t.direction, t.alex, { noticeGivenOn: '2027-01-11', leavesOn: '2027-01-13', reason: 'accord_mutuel', contractStartedOn: '2026-12-01' })).ok).toBe(true);
    const planificateur = new Planificateur(t.db, t.journal, reseau.reseauJobs(t.db, t.journal, { now: t.now }), { now: t.now });
    t.setClock('2027-01-12T22:30:00.000Z'); // 23 h 30 la veille
    expect((await planificateur.tick()).ran).toEqual([reseau.RESEAU_HOURLY_JOB]);
    expect((await t.store.getAgent(t.alex))!.status).toBe('active');
    t.setClock('2027-01-12T23:10:00.000Z'); // 0 h 10 le jour du départ
    expect(await planificateur.tick()).toMatchObject({ ran: [reseau.RESEAU_HOURLY_JOB], failed: [] });
    expect((await t.store.getAgent(t.alex))!.status).toBe('left');
    expect((await t.store.getPerson(t.client))!.agent_id).toBeNull();
    // Le déclencheur repasse dans la même heure : rien ne repasse.
    t.setClock('2027-01-12T23:40:00.000Z');
    expect(await planificateur.tick()).toMatchObject({ ran: [], skipped: [reseau.RESEAU_HOURLY_JOB] });
    expect((await t.journal.all()).filter((e) => e.type === 'agent.parti')).toHaveLength(1);
  });

  it('[R82] [R85] [R18] à 6 h, les échéances des pièces et de la formation sont rangées une seule fois, sans nom ni référence', async () => {
    const t = await setup();
    // L'assurance de Sam finit dans 20 jours : une alerte, une seule.
    await t.completeFile(t.sam);
    await t.piece(t.sam, 'assurance_rcp', '2026-12-01', '2027-01-31');
    const planificateur = new Planificateur(t.db, t.journal, reseau.reseauJobs(t.db, t.journal, { now: t.now }), { now: t.now });
    t.setClock('2027-01-12T05:10:00.000Z'); // 6 h 10 à Paris
    const first = await planificateur.tick();
    expect(first.ran).toEqual([reseau.RESEAU_HOURLY_JOB, reseau.RESEAU_DAILY_JOB]);
    const alerts = (await t.journal.all()).filter((e) => e.type === 'dossier_agent.alerte');
    expect(alerts.map((e) => [e.subject, e.data['kind'], e.data['validUntil']])).toEqual([[`agent:${t.sam}`, 'assurance_rcp', '2027-01-31']]);
    expect(JSON.stringify(alerts)).not.toContain('agents/');
    expect(await t.db.first('SELECT count(*) AS n FROM agent_file_alerts')).toEqual({ n: 1 });
    // Le lendemain à 6 h : la même pièce n'alerte plus.
    t.setClock('2027-01-13T05:10:00.000Z');
    expect((await planificateur.tick()).ran).toContain(reseau.RESEAU_DAILY_JOB);
    expect((await t.journal.all()).filter((e) => e.type === 'dossier_agent.alerte')).toHaveLength(1);
    expect(await verifyChain(await t.journal.all())).toMatchObject({ ok: true });
  });
});
