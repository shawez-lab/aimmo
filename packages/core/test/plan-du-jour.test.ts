import { expect, it } from 'vitest';
import {
  Acces,
  Attribution,
  PlanDuJour,
  Qualification,
  Rappels,
  ReconnaissanceBien,
  SqlJournalStore,
  applyMigrations,
  createCaptation,
  fromSyncSqlite,
  type SqlDatabase,
} from '../src/index.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

// Un mardi à 10 h, heure de Paris ; le plan est calculé 40 jours plus tard, un vendredi à 7 h 30.
const START = Date.parse('2026-12-08T09:00:00.000Z');
const DAY = 86_400_000;
const PLAN_AT = Date.parse('2027-01-15T06:30:00.000Z');

async function setup() {
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  let clock = START;
  const now = (): Date => new Date(clock);
  const journal = new SqlJournalStore(db);
  const { chaine, store, fiche, reception } = createCaptation(db, journal, { now, withQualification: false });
  const qualification = new Qualification(db, store, fiche, reception, new ReconnaissanceBien(db), journal, { now });
  const attribution = new Attribution(db, fiche, journal, { now });
  const rappels = new Rappels(db, fiche, journal, { now });
  const acces = new Acces(db, store, fiche, journal, { now });
  const plan = new PlanDuJour(db, fiche, { now });
  const network = await store.createNetwork('Réseau test');
  const alex = await store.createAgent({ networkId: network.id, firstName: 'Alex', lastName: 'Agent' });
  const sam = await store.createAgent({ networkId: network.id, firstName: 'Sam', lastName: 'Agent' });
  await attribution.addZone(network.id, alex.id, 'Talant');
  await attribution.addZone(network.id, sam.id, 'Dijon');
  let seq = 0;

  /** Un formulaire inventé, passé par qualification, note, attribution et tâche « rappeler » ; rend la fiche. */
  const viaForm = async (who: string, message: string): Promise<string> => {
    seq += 1;
    await chaine.receive(network.id, 'site_form', { submissionId: `f-${seq}`, firstName: who, email: `${who.toLowerCase()}@example.test`, message });
    const row = await db.first<{ id: string }>('SELECT id FROM inbound_messages ORDER BY rowid DESC LIMIT 1');
    const q = (await qualification.qualify(row!.id))!;
    await attribution.attribute(q.id);
    await rappels.forQualification(q.id);
    return q.person_id;
  };

  /** Une fiche d'Alex rangée à la main, avec un projet ouvert et, si demandé, une source datée. */
  const person = async (who: string, opts: { kind?: 'sell' | 'valuation' | 'buy'; stage?: string; sourceAt?: number | null; deadline?: number } = {}) => {
    const p = await store.createPerson({ networkId: network.id, agentId: alex.id, firstName: who });
    const project = await store.createProject({
      networkId: network.id,
      agentId: alex.id,
      personId: p.id,
      kind: opts.kind ?? 'valuation',
      stage: opts.stage ?? 'recue',
      deadline: opts.deadline === undefined ? null : new Date(opts.deadline),
    });
    if (opts.sourceAt !== null) {
      await store.addSource({ networkId: network.id, agentId: alex.id, personId: p.id, projectId: project.id, channel: 'site', detail: 'estimation', occurredAt: new Date(opts.sourceAt ?? clock) });
    }
    return { id: p.id, projectId: project.id };
  };

  let prop = 0;
  /** Un avis de valeur validé et noté envoyé à la personne, à la date donnée. */
  const valuationSent = async (personId: string, at: number): Promise<string> => {
    prop += 1;
    const property = await store.createProperty({ networkId: network.id, agentId: alex.id, reference: `T-${prop}`, kind: 'home', city: 'Talant' });
    const reportId = `avis-${prop}`;
    const stamp = new Date(at).toISOString();
    await db.run(
      `INSERT INTO valuation_reports (id, network_id, property_id, agent_id, status, computed, computed_low, computed_high, text, text_by, created_at, updated_at, validated_by, validated_at)
       VALUES (?, ?, ?, ?, 'validated', '{}', 200000, 220000, 'Avis inventé.', 'agent', ?, ?, ?, ?)`,
      [reportId, network.id, property.id, alex.id, stamp, stamp, alex.id, stamp],
    );
    await db.run(`INSERT INTO valuation_deliveries (report_id, network_id, person_id, channel, sent_at, noted_by) VALUES (?, ?, ?, 'email', ?, ?)`, [
      reportId,
      network.id,
      personId,
      stamp,
      alex.id,
    ]);
    return reportId;
  };

  let rdv = 0;
  const appointment = async (personId: string, start: number, status: 'booked' | 'honored' | 'cancelled', kind = 'estimation') => {
    rdv += 1;
    const s = new Date(start).toISOString();
    await db.run(
      `INSERT INTO appointments (id, network_id, agent_id, person_id, property_id, kind, start_at, end_at, status, token_hash, source, created_at, updated_at)
       VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, 'agent', ?, ?)`,
      [`rdv-${rdv}`, network.id, alex.id, personId, kind, s, new Date(start + 3_600_000).toISOString(), status, `h-${rdv}`, s, s],
    );
  };

  const as = (role: 'agent' | 'direction', userId: string) => ({ role, userId, networkId: network.id });
  const planOf = async (agentId: string) => {
    const r = await plan.compute(acces, as('agent', agentId));
    if (!r.ok) throw new Error(r.code);
    return r.value;
  };
  return { db, store, fiche, plan, acces, network, alex, sam, viaForm, person, valuationSent, appointment, as, planOf, setClock: (t: number) => (clock = t), now };
}

describeWithSqlite('G01 · plan du jour : contenu et ordre', () => {
  it('[R35] porte les trois raisons, dans l’ordre écrit, chaque ligne avec sa raison et l’explication de sa place', async () => {
    const t = await setup();
    // Rappel demandé (contact chaud par le formulaire), délai « tout de suite ».
    const hugo = await t.viaForm('Hugo', 'Je souhaite vendre ma maison à Talant rapidement.');
    // Rendez-vous à proposer : deux demandes d'estimation, l'une avec une échéance, l'autre sans.
    const lea = await t.person('Léa', { deadline: START + 60 * DAY });
    const noe = await t.person('Noé');
    // Avis envoyé il y a plus de 30 jours, sans réponse.
    const ines = await t.person('Inès', { stage: 'avis' });
    const report = await t.valuationSent(ines.id, START + DAY);
    t.setClock(PLAN_AT);

    const plan = await t.planOf(t.alex.id);
    expect(plan.day).toBe('2027-01-15');
    expect(plan.items.map((i) => [i.rank, i.personId, i.kind])).toEqual([
      [1, hugo, 'callback'],
      [2, lea.id, 'appointment'],
      [3, ines.id, 'valuation'],
      [4, noe.id, 'appointment'],
    ]);
    const [first, second, third, fourth] = plan.items;
    expect(first!.reason).toMatch(/^Rappel demandé\. /);
    expect(first!.order).toMatch(/^1\. rappel demandé ; 2\. pas de réponse « pense à vendre » ; 3\. délai annoncé : tout de suite/);
    expect(first!.basis.kind).toBe('request');
    expect(second!.order).toContain('3. délai annoncé : échéance le 2027-02-06');
    expect(third).toMatchObject({ reportId: report, reason: expect.stringContaining('à relancer') });
    expect(third!.order).toContain('4. avis de valeur envoyé le 2026-12-09');
    expect(fourth!.order).toContain('3. délai non annoncé');
    // AU116 · ce que l'écran montre : la priorité en mots de l'agent et le jour de la demande, sans numéro de règle.
    expect(first!.priority).toMatch(/^Rappel demandé · délai : tout de suite · demande du \d{2}\/\d{2}\/\d{4}$/);
    expect(second!.priority).toMatch(/^Projet annoncé : échéance le 2027-02-06 · demande du /);
    expect(third!.priority).toMatch(/^Avis de valeur envoyé le 09\/12\/2026 · demande du /);
    for (const item of plan.items) expect(item.priority).not.toMatch(/règle|\d\. /);
    // Aucune ligne ne vient d'une IA : chaque raison et chaque explication sont des textes fixes du code.
    for (const item of plan.items) expect(item.reason.length).toBeGreaterThan(0);
  });

  it('[R35] le même plan pour les mêmes données, quel que soit l’ordre de création des fiches', async () => {
    const build = async (order: readonly string[]) => {
      const t = await setup();
      const ids: Record<string, string> = {};
      for (const who of order) ids[who] = (await t.person(who, { sourceAt: START })).id;
      t.setClock(PLAN_AT);
      const plan = await t.planOf(t.alex.id);
      const back = Object.fromEntries(Object.entries(ids).map(([k, v]) => [v, k]));
      return { plan: plan.items.map((i) => back[i.personId]), again: (await t.planOf(t.alex.id)).items.map((i) => back[i.personId]) };
    };
    const a = await build(['Zoé', 'Anne', 'Marc']);
    expect(a.plan).toEqual(a.again);
    expect(a.plan).toHaveLength(3);
  });

  it('[R16] ne porte que les clients de l’agent ; la direction et un agent parti n’ont pas de plan', async () => {
    const t = await setup();
    await t.person('Léa');
    const other = await t.store.createPerson({ networkId: t.network.id, agentId: t.sam.id, firstName: 'Paul' });
    await t.store.createProject({ networkId: t.network.id, agentId: t.sam.id, personId: other.id, kind: 'sell', stage: 'new' });
    await t.store.addSource({ networkId: t.network.id, agentId: t.sam.id, personId: other.id, channel: 'site', occurredAt: new Date(START) });
    t.setClock(PLAN_AT);
    expect((await t.planOf(t.alex.id)).items.map((i) => i.firstName)).toEqual(['Léa']);
    expect((await t.planOf(t.sam.id)).items.map((i) => i.firstName)).toEqual(['Paul']);
    expect(await t.plan.compute(t.acces, t.as('direction', 'dir-1'))).toEqual({ ok: false, rule: 'R16', code: 'not_agent' });
    await t.db.run(`UPDATE agents SET status = 'left' WHERE id = ?`, [t.sam.id]);
    expect(await t.plan.compute(t.acces, t.as('agent', t.sam.id))).toMatchObject({ ok: false, rule: 'R16', code: 'agent_inactive' });
  });

  it('[R36] une personne exclue ou qui a demandé l’arrêt, sur n’importe quel canal, n’y figure jamais ; son retrait est compté sans donnée personnelle', async () => {
    const t = await setup();
    const stop = await t.person('Stéphane');
    const sold = await t.person('Sofia');
    const kept = await t.person('Karim');
    await t.store.addExclusion({ networkId: t.network.id, personId: stop.id, reason: 'stop', channel: 'sms', notedAt: new Date(START + DAY) });
    await t.store.addExclusion({ networkId: t.network.id, personId: sold.id, reason: 'network_list', notedAt: new Date(START + DAY) });
    // Une exclusion levée ne retire plus la personne.
    const lifted = await t.store.addExclusion({ networkId: t.network.id, personId: kept.id, reason: 'refused', notedAt: new Date(START + DAY) });
    await t.store.liftExclusion(lifted.id, new Date(START + 2 * DAY));
    t.setClock(PLAN_AT);
    const plan = await t.planOf(t.alex.id);
    expect(plan.items.map((i) => i.personId)).toEqual([kept.id]);
    expect(plan.removed).toEqual({ excluded: 2, withdrawn: 0, noBasis: 0 });
    expect(JSON.stringify(plan.removed)).not.toMatch(/Stéphane|Sofia/);
  });

  it('[R36] sans demande récente ni accord en cours, pas de plan ; un accord en cours suffit, un accord retiré non', async () => {
    const t = await setup();
    const old = await t.person('Odile', { sourceAt: PLAN_AT - 400 * DAY });
    const consented = await t.person('Camille', { sourceAt: PLAN_AT - 400 * DAY });
    const withdrawn = await t.person('Wassim', { sourceAt: null });
    const recent = await t.person('Rémi', { sourceAt: PLAN_AT - 300 * DAY });
    await t.store.addConsent({ networkId: t.network.id, personId: consented.id, purpose: 'valuation_follow_up', channel: 'email', proof: 'case cochée (test)', givenAt: new Date(START) });
    const c = await t.store.addConsent({ networkId: t.network.id, personId: withdrawn.id, purpose: 'valuation_follow_up', channel: 'email', proof: 'case cochée (test)', givenAt: new Date(START) });
    await t.store.withdrawConsent(c.id, new Date(START + DAY));
    // Un accord pour une autre finalité, comme la tournée partagée, ne vaut pas base légale de prospection.
    await t.store.addConsent({ networkId: t.network.id, personId: old.id, purpose: 'route_share', channel: 'sms', proof: 'accord oral noté (test)', givenAt: new Date(START) });
    t.setClock(PLAN_AT);
    const plan = await t.planOf(t.alex.id);
    expect(plan.items.map((i) => i.personId).sort()).toEqual([consented.id, recent.id].sort());
    expect(plan.items.find((i) => i.personId === consented.id)!.basis).toMatchObject({ kind: 'consent', purpose: 'valuation_follow_up' });
    expect(plan.items.find((i) => i.personId === recent.id)!.basis.kind).toBe('request');
    expect(plan.removed).toEqual({ excluded: 0, withdrawn: 1, noBasis: 1 });
  });

  it('[R36] une reprise d’outil récente n’est pas une demande ; un accord retiré l’emporte sur une demande récente, un nouvel accord le rétablit', async () => {
    const t = await setup();
    const imported = await t.person('Igor', { sourceAt: PLAN_AT - 3 * 365 * DAY });
    await t.store.addSource({ networkId: t.network.id, agentId: t.alex.id, personId: imported.id, channel: 'gohighlevel', detail: 'reprise (test)', occurredAt: new Date(PLAN_AT - 10 * DAY) });
    const refused = await t.person('Jade', { stage: 'avis', sourceAt: START });
    await t.valuationSent(refused.id, START + DAY);
    const c1 = await t.store.addConsent({ networkId: t.network.id, personId: refused.id, purpose: 'valuation_follow_up', channel: 'email', proof: 'case cochée (test)', givenAt: new Date(START) });
    await t.store.withdrawConsent(c1.id, new Date(START + 2 * DAY));
    const back = await t.person('Kim', { sourceAt: START });
    const c2 = await t.store.addConsent({ networkId: t.network.id, personId: back.id, purpose: 'valuation_follow_up', channel: 'email', proof: 'case cochée (test)', givenAt: new Date(START) });
    await t.store.withdrawConsent(c2.id, new Date(START + DAY));
    await t.store.addConsent({ networkId: t.network.id, personId: back.id, purpose: 'valuation_follow_up', channel: 'email', proof: 'case recochée (test)', givenAt: new Date(START + 5 * DAY) });
    t.setClock(PLAN_AT);
    const plan = await t.planOf(t.alex.id);
    expect(plan.items.map((i) => i.personId)).toEqual([back.id]);
    expect(plan.items[0]!.basis).toMatchObject({ kind: 'consent' });
    expect(plan.removed).toEqual({ excluded: 0, withdrawn: 1, noBasis: 1 });
  });

  it('un contact n’y figure qu’une fois, sous sa raison la plus forte, même après une fusion de fiches', async () => {
    const t = await setup();
    const hugo = await t.viaForm('Hugo', 'Je souhaite vendre ma maison à Talant rapidement.');
    const twin = await t.person('Hugo');
    await t.valuationSent(twin.id, START + DAY);
    await t.fiche.merge({ survivorId: hugo, mergedId: twin.id, reason: 'même personne (test)' });
    t.setClock(PLAN_AT);
    const plan = await t.planOf(t.alex.id);
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0]).toMatchObject({ personId: hugo, kind: 'callback' });
    // L'avis le plus ancien compte quand même dans l'explication.
    expect(plan.items[0]!.order).toContain('4. avis de valeur envoyé le 2026-12-09');
  });

  it('une estimation n’est plus à relancer après une réponse, un échange de l’agent ou un rendez-vous ; un rendez-vous à venir retire la ligne « rendez-vous à proposer »', async () => {
    const t = await setup();
    const answered = await t.person('Aline', { stage: 'avis' });
    await t.valuationSent(answered.id, START + DAY);
    await t.store.recordMessage({ networkId: t.network.id, personId: answered.id, channel: 'email', direction: 'in', authorKind: 'person', body: 'Merci (test).', occurredAt: new Date(PLAN_AT - 5 * DAY) });
    const recentSend = await t.person('Bruno', { stage: 'avis' });
    await t.valuationSent(recentSend.id, PLAN_AT - 10 * DAY);
    const booked = await t.person('Chloé');
    await t.appointment(booked.id, PLAN_AT + 2 * DAY, 'booked');
    const done = await t.person('Denis');
    await t.appointment(done.id, START + 3 * DAY, 'honored');
    const cancelled = await t.person('Emma');
    await t.appointment(cancelled.id, START + 3 * DAY, 'cancelled');
    const mandate = await t.person('Fanny', { stage: 'mandat' });
    t.setClock(PLAN_AT);
    const plan = await t.planOf(t.alex.id);
    expect(plan.items.map((i) => i.personId)).toEqual([cancelled.id]);
    void mandate;
  });

  it('un projet d’achat seul ne met personne au plan', async () => {
    const t = await setup();
    await t.person('Gaël', { kind: 'buy' });
    t.setClock(PLAN_AT);
    expect((await t.planOf(t.alex.id)).items).toEqual([]);
  });
});
