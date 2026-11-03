import { describe, expect, it } from 'vitest';
import { Acces, FicheClient, FicheUnique, Mandats, REFERRAL_PURPOSE, Recommandations, RecommandationsGagner, SqlJournalStore, applyMigrations, fromSyncSqlite, verifyChain, type SqlDatabase } from '../src/index.ts';
import { Annuaire, MiseEnRelation, type ConsentProofStore } from '../src/partenaires/index.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

// Réseau, agents, clients, partenaires et personnes recommandées inventés.
let clock = Date.parse('2027-10-12T08:00:00.000Z');
const DAY = 86_400_000;
let n = 0;
const uuid = (): string => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;

class FakeStore implements ConsentProofStore {
  readonly refs = new Set<string>();
  put(prefix: string): string {
    const ref = `${prefix}/${uuid()}.pdf`;
    this.refs.add(ref);
    return ref;
  }
  async has(ref: string): Promise<boolean> {
    return this.refs.has(ref);
  }
}

async function setup() {
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  const now = (): Date => new Date((clock += 1000));
  const journal = new SqlJournalStore(db);
  const store = new FicheClient(db, { now });
  const fiche = new FicheUnique(db, store, { now });
  const acces = new Acces(db, store, fiche, journal, { now });
  const files = new FakeStore();
  const annuaire = new Annuaire(db, files, journal, { now, newId: uuid });
  const relations = new MiseEnRelation(db, annuaire, files, journal, { now, newId: uuid, newSeed: () => 1 });
  const gagner = new RecommandationsGagner(db, store, fiche, acces, annuaire, journal, { now, newId: uuid });
  const clients = new Recommandations(db, store, fiche, acces, journal, { now, newId: uuid });
  const mandats = new Mandats(db, fiche, journal, { now, newId: uuid });
  const network = await store.createNetwork('Réseau test');
  const other = await store.createNetwork('Autre réseau');
  const alex = await store.createAgent({ networkId: network.id, firstName: 'Alex', lastName: 'Essai' });
  const sam = await store.createAgent({ networkId: network.id, firstName: 'Sam', lastName: 'Essai' });
  const dir = { role: 'direction' as const, userId: 'dir-1', networkId: network.id };
  const agent = (id = alex.id) => ({ role: 'agent' as const, userId: id, networkId: network.id });
  const as = (partnerId: string, networkId = network.id) => ({ role: 'partner' as const, userId: partnerId, networkId });
  const day = (d = 0): string => new Date(clock + d * DAY).toISOString().slice(0, 10);
  const partner = async (name: string, until = 300): Promise<string> => {
    const r = await annuaire.addPartner(dir, { trade: 'notaire', businessName: name, postcodes: ['21000'] });
    if (!r.ok) throw new Error(r.code);
    await annuaire.addCredential(dir, r.value.partnerId, { kind: 'assurance_rcp', number: 'N-1', validFrom: day(-30), validUntil: day(until), proofRef: files.put(`partenaires/${r.value.partnerId}`) });
    return r.value.partnerId;
  };
  /** Une mise en relation d'un client d'Alex, acceptée et confiée à ce partenaire. */
  const entrust = async (partnerId: string, agentId = alex.id): Promise<void> => {
    const client = await store.createPerson({ networkId: network.id, agentId, firstName: 'Client', lastName: 'Essai' });
    const project = await store.createProject({ networkId: network.id, agentId, personId: client.id, kind: 'sell' });
    const r = await relations.propose(agent(agentId), { projectId: project.id, trade: 'notaire', postcode: '21000' });
    if (!r.ok) throw new Error(r.code);
    const c = await relations.recordConsent(agent(agentId), r.value.referralId, { partnerId, consentAt: new Date(clock - 500).toISOString(), channel: 'ecrit', proofRef: files.put(`relations/${r.value.referralId}`) });
    if (!c.ok) throw new Error(c.code);
    const e = await relations.entrust(agent(agentId), r.value.referralId);
    if (!e.ok) throw new Error(e.code);
  };
  const consent = (over: Record<string, unknown> = {}) => ({ kind: 'message_ecrit', channel: 'phone', givenAt: new Date(clock - 2 * DAY).toISOString(), reference: 'SMS de la personne du 10 octobre, gardé par l’étude', ...over });
  const input = (over: Record<string, unknown> = {}) => ({ firstName: 'Hugo', phone: '06 11 22 33 44', email: 'hugo@example.test', projectKind: 'sell', consent: consent(), ...over });
  const rows = () => db.all<{ id: string; referred_id: string | null; agent_id: string | null; call_due_at: string | null }>('SELECT id, referred_id, agent_id, call_due_at FROM partner_recommendations ORDER BY created_at, id');
  const persons = async () => (await db.first<{ n: number }>('SELECT COUNT(*) AS n FROM persons'))!.n;
  return { db, journal, store, fiche, acces, gagner, clients, mandats, network, other, alex, sam, dir, agent, as, partner, entrust, consent, input, rows, persons };
}

describeWithSqlite('G08 · recommandations des clients et des partenaires', () => {
  it('[R142] [R38] une recommandation de partenaire arrive avec sa source et la preuve de l’accord ; l’agent est alerté ; le mandat garde la source', async () => {
    const t = await setup();
    const p = await t.partner('Étude Essai');
    await t.entrust(p);
    expect(await t.gagner.recommend(t.as(p), t.input())).toEqual({ ok: true, value: { recorded: true } });
    const [row] = await t.rows();
    expect(row).toMatchObject({ agent_id: t.alex.id, call_due_at: expect.any(String) });
    const view = await t.fiche.view(row!.referred_id!);
    expect(view.person).toMatchObject({ first_name: 'Hugo', agent_id: t.alex.id });
    expect(view.sources).toEqual([expect.objectContaining({ channel: 'recommandation', detail: 'recommandé par un partenaire' })]);
    expect(view.consents).toEqual([expect.objectContaining({ purpose: REFERRAL_PURPOSE, channel: 'phone', proof: expect.stringMatching(/^message écrit de la personne : SMS .* \(transmis par un partenaire\)$/) })]);
    // L'agent est alerté : la tâche est dans sa file, avec le nom du partenaire.
    const list = await t.gagner.toCall(t.agent());
    expect(list).toEqual({ ok: true, value: [{ origin: 'partner', recommendationId: row!.id, personId: row!.referred_id, firstName: 'Hugo', sourceLabel: 'Recommandé par Étude Essai', channel: 'phone', dueAt: row!.call_due_at }] });
    const entries = await t.journal.all();
    expect(entries.filter((e) => e.type === 'recommandation.alerte')).toEqual([expect.objectContaining({ subject: `agent:${t.alex.id}` })]);
    // La source suit jusqu'au mandat, reprise de la fiche [R38].
    expect(await t.mandats.record(t.acces, t.agent(), { personId: row!.referred_id!, signedAt: new Date(clock) })).toMatchObject({ ok: true, source: 'referral', fromFiche: true });
    // Aucune coordonnée ni prénom au journal [R13].
    expect(JSON.stringify(await t.journal.all())).not.toMatch(/hugo@|example\.test|Hugo|06 11/);
    expect((await verifyChain(await t.journal.all())).ok).toBe(true);
  });

  it('[R142] sans preuve d’accord de la personne recommandée, rien n’est rangé et aucun contact n’est possible', async () => {
    const t = await setup();
    const p = await t.partner('Étude Essai');
    const before = await t.persons();
    const cases: [Record<string, unknown>, string][] = [
      [t.input({ consent: undefined }), 'no_consent'],
      [t.input({ consent: null }), 'no_consent'],
      [t.input({ consent: 'il est d’accord' }), 'bad_consent'],
      [t.input({ consent: t.consent({ kind: 'parole_du_partenaire' }) }), 'bad_consent_kind'],
      [t.input({ consent: t.consent({ channel: 'instagram' }) }), 'bad_consent_channel'],
      [t.input({ consent: t.consent({ givenAt: 'hier' }) }), 'bad_consent_date'],
      [t.input({ consent: t.consent({ givenAt: new Date(clock + DAY).toISOString() }) }), 'consent_in_future'],
      [t.input({ consent: t.consent({ givenAt: new Date(clock - 31 * DAY).toISOString() }) }), 'consent_too_old'],
      [t.input({ consent: t.consent({ reference: '  ' }) }), 'bad_consent_reference'],
      [t.input({ consent: t.consent({ channel: 'email' }), email: undefined }), 'consent_channel_without_contact'],
    ];
    for (const [body, code] of cases) expect(await t.gagner.recommend(t.as(p), body), code).toEqual({ ok: false, rule: 'R142', code });
    expect(await t.persons()).toBe(before);
    expect(await t.rows()).toEqual([]);
    expect((await t.journal.all()).filter((e) => e.type === 'recommandation.refusee').map((e) => e.data.code)).toEqual(cases.map(([, c]) => c));
  });

  it('[R142] une recommandation de client sans accord n’entre jamais dans la file ; un accord retiré l’en sort', async () => {
    const t = await setup();
    const lea = await t.store.createPerson({ networkId: t.network.id, agentId: t.alex.id, firstName: 'Léa', lastName: 'Cliente' });
    const without = await t.clients.recommend(t.agent(), lea.id, { firstName: 'Nina', phone: '06 99 88 77 66', projectKind: 'buy', callable: false });
    expect(without).toMatchObject({ ok: true });
    const withProof = await t.clients.recommend(t.agent(), lea.id, { firstName: 'Paul', email: 'paul@example.test', projectKind: 'sell', callable: true, proof: 'Paul a écrit à Léa qu’il accepte d’être appelé' });
    if (!withProof.ok) throw new Error(withProof.code);
    const list = await t.gagner.toCall(t.agent());
    expect(list.ok && list.value.map((r) => [r.origin, r.firstName, r.sourceLabel])).toEqual([['client', 'Paul', 'Recommandé par un client']]);
    const referred = (await t.db.first<{ referred_id: string }>('SELECT referred_id FROM referrals WHERE id = ?', [withProof.value.id]))!.referred_id;
    const c = (await t.fiche.view(referred)).consents[0]!;
    await t.store.withdrawConsent(c.id, new Date(clock));
    expect(await t.gagner.toCall(t.agent())).toEqual({ ok: true, value: [] });
  });

  it('[R66] aucun champ ni texte de récompense, même dans la preuve', async () => {
    const t = await setup();
    const p = await t.partner('Étude Essai');
    expect(await t.gagner.recommend(t.as(p), t.input({ reward: 100 }))).toEqual({ ok: false, rule: 'R66', code: 'unknown_field' });
    expect(await t.gagner.recommend(t.as(p), t.input({ consent: { ...t.consent(), prime: 50 } }))).toEqual({ ok: false, rule: 'R66', code: 'unknown_field' });
    for (const reference of ['accord contre un cadeau', 'commission de 2 %', 'bon d’achat promis']) {
      expect(await t.gagner.recommend(t.as(p), t.input({ consent: t.consent({ reference }) })), reference).toEqual({ ok: false, rule: 'R66', code: 'reward' });
    }
    expect(await t.rows()).toEqual([]);
    const cols = (await t.db.all<{ name: string }>('PRAGMA table_info(partner_recommendations)')).map((c) => c.name).join(' ');
    expect(cols).not.toMatch(/reward|prime|commission|bonus|amount|fee/);
  });

  it('[R77] le partenaire ne voit rien de la suite : même réponse que la personne soit nouvelle, suivie ailleurs ou exclue', async () => {
    const t = await setup();
    const p = await t.partner('Étude Essai');
    await t.entrust(p);
    // Une personne déjà suivie par Sam, une autre exclue.
    const known = await t.store.createPerson({ networkId: t.network.id, agentId: t.sam.id, firstName: 'Iris' });
    await t.store.addIdentifier({ networkId: t.network.id, agentId: t.sam.id, personId: known.id, kind: 'phone', value: '06 22 33 44 55' });
    const excluded = await t.store.createPerson({ networkId: t.network.id, agentId: t.sam.id, firstName: 'Omar' });
    await t.store.addIdentifier({ networkId: t.network.id, agentId: t.sam.id, personId: excluded.id, kind: 'phone', value: '06 33 44 55 66' });
    await t.store.addExclusion({ networkId: t.network.id, agentId: t.sam.id, personId: excluded.id, reason: 'stop', notedAt: new Date(clock - DAY) });
    const answers = [
      await t.gagner.recommend(t.as(p), t.input()),
      await t.gagner.recommend(t.as(p), t.input({ firstName: 'Iris', phone: '06 22 33 44 55', email: undefined })),
      await t.gagner.recommend(t.as(p), t.input({ firstName: 'Omar', phone: '06 33 44 55 66', email: undefined })),
    ];
    expect(answers).toEqual(Array(3).fill({ ok: true, value: { recorded: true } }));
    // Le partenaire relit la date de ses recommandations, rien d'autre.
    const mine = await t.gagner.mine(t.as(p));
    expect(mine.ok && mine.value.map((r) => Object.keys(r))).toEqual([['createdAt'], ['createdAt'], ['createdAt']]);
    // La personne suivie par Sam reste à Sam ; la personne exclue n'est jamais rappelée et sa fiche ne change pas [R02, R04].
    const rows = await t.rows();
    expect(rows.map((r) => [r.agent_id, r.call_due_at === null])).toEqual([[t.alex.id, false], [t.sam.id, false], [null, true]]);
    const omar = await t.fiche.view(excluded.id);
    expect([omar.projects.length, omar.sources.length, omar.consents.length, omar.identifiers.length]).toEqual([0, 0, 0, 1]);
    const samList = await t.gagner.toCall(t.agent(t.sam.id));
    expect(samList.ok && samList.value.map((r) => r.firstName)).toEqual(['Iris']);
    // Alex ne voit pas la recommandation suivie par Sam [R16].
    const alexList = await t.gagner.toCall(t.agent());
    expect(alexList.ok && alexList.value.map((r) => r.firstName)).toEqual(['Hugo']);
    // Une seconde fois la même personne par le même partenaire : même réponse, rien de plus.
    expect(await t.gagner.recommend(t.as(p), t.input())).toEqual({ ok: true, value: { recorded: true } });
    expect(await t.rows()).toHaveLength(3);
  });

  it('[R142] [R02] des coordonnées de deux personnes différentes : aucun accord, aucune tâche, sur aucune fiche', async () => {
    const t = await setup();
    const p = await t.partner('Étude Essai');
    await t.entrust(p);
    const x = await t.store.createPerson({ networkId: t.network.id, agentId: t.alex.id, firstName: 'Xavier' });
    await t.store.addIdentifier({ networkId: t.network.id, agentId: t.alex.id, personId: x.id, kind: 'email', value: 'x@example.test' });
    const y = await t.store.createPerson({ networkId: t.network.id, agentId: t.sam.id, firstName: 'Yann' });
    await t.store.addIdentifier({ networkId: t.network.id, agentId: t.sam.id, personId: y.id, kind: 'phone', value: '06 33 44 55 66' });
    await t.store.addExclusion({ networkId: t.network.id, agentId: t.sam.id, personId: y.id, reason: 'stop', notedAt: new Date(clock - DAY) });
    // Le mail de X, le numéro de Y, un accord par téléphone : la preuve ne se rattache à personne.
    expect(await t.gagner.recommend(t.as(p), t.input({ email: 'x@example.test', phone: '06 33 44 55 66' }))).toEqual({ ok: true, value: { recorded: true } });
    for (const who of [x.id, y.id]) {
      const v = await t.fiche.view(who);
      expect([v.projects.length, v.sources.length, v.consents.length], who).toEqual([0, 0, 0]);
    }
    expect((await t.rows()).map((r) => [r.referred_id, r.agent_id, r.call_due_at])).toEqual([[null, null, null]]);
    expect(await t.gagner.toCall(t.agent())).toEqual({ ok: true, value: [] });
    expect(await t.gagner.toCall(t.agent(t.sam.id))).toEqual({ ok: true, value: [] });
  });

  it('[R77] [R04] une coordonnée donnée avec une personne exclue tient à l’écart la recommandation suivante, avec la même réponse', async () => {
    const t = await setup();
    const p = await t.partner('Étude Essai');
    await t.entrust(p);
    const omar = await t.store.createPerson({ networkId: t.network.id, agentId: t.sam.id, firstName: 'Omar' });
    await t.store.addIdentifier({ networkId: t.network.id, agentId: t.sam.id, personId: omar.id, kind: 'phone', value: '06 33 44 55 66' });
    await t.store.addExclusion({ networkId: t.network.id, agentId: t.sam.id, personId: omar.id, reason: 'stop', notedAt: new Date(clock - DAY) });
    const before = await t.persons();
    const first = await t.gagner.recommend(t.as(p), t.input({ firstName: 'Omar', phone: '06 33 44 55 66', email: 'omar@example.test' }));
    // Le même mail avec un autre numéro : sans l'empreinte, une fiche neuve serait créée et appelée.
    const second = await t.gagner.recommend(t.as(p), t.input({ firstName: 'Omar', phone: '06 77 88 99 00', email: 'omar@example.test' }));
    // Les mêmes envois pour une personne libre : mêmes réponses, le partenaire n'apprend rien [R77].
    const free1 = await t.gagner.recommend(t.as(p), t.input({ firstName: 'Lina', phone: '06 12 12 12 12', email: 'lina@example.test' }));
    const free2 = await t.gagner.recommend(t.as(p), t.input({ firstName: 'Lina', phone: '06 34 34 34 34', email: 'lina@example.test' }));
    expect([first, second]).toEqual([free1, free2]);
    expect(await t.persons()).toBe(before + 1);
    const list = await t.gagner.toCall(t.agent());
    expect(list.ok && list.value.map((r) => r.firstName)).toEqual(['Lina']);
    const omarView = await t.fiche.view(omar.id);
    expect([omarView.identifiers.length, omarView.consents.length]).toEqual([1, 0]);
    // Aucune coordonnée en clair dans la table des empreintes ni au journal [R13].
    expect(JSON.stringify(await t.db.all('SELECT * FROM partner_recommendation_withheld'))).not.toMatch(/omar|06 /);
    expect(JSON.stringify(await t.journal.all())).not.toMatch(/omar@|lina@|06 /);
  });

  it('[R77] [R04] une coordonnée ajoutée à une personne exclue déjà recommandée est tenue à l’écart ; l’historique du partenaire ne dit rien', async () => {
    const t = await setup();
    const p = await t.partner('Étude Essai');
    await t.entrust(p);
    const omar = await t.store.createPerson({ networkId: t.network.id, agentId: t.sam.id, firstName: 'Omar' });
    await t.store.addIdentifier({ networkId: t.network.id, agentId: t.sam.id, personId: omar.id, kind: 'phone', value: '06 33 44 55 66' });
    await t.store.addExclusion({ networkId: t.network.id, agentId: t.sam.id, personId: omar.id, reason: 'stop', notedAt: new Date(clock - DAY) });
    const lina = await t.store.createPerson({ networkId: t.network.id, agentId: t.alex.id, firstName: 'Lina' });
    await t.store.addIdentifier({ networkId: t.network.id, agentId: t.alex.id, personId: lina.id, kind: 'phone', value: '06 12 12 12 12' });
    const before = await t.persons();
    const sequence = async (phone: string, email: string, other: string) => [
      await t.gagner.recommend(t.as(p), t.input({ phone, email: undefined })),
      await t.gagner.recommend(t.as(p), t.input({ phone, email })),
      await t.gagner.recommend(t.as(p), t.input({ phone: other, email })),
    ];
    const excluded = await sequence('06 33 44 55 66', 'omar@example.test', '06 77 88 99 00');
    const mineAfterExcluded = await t.gagner.mine(t.as(p));
    const free = await sequence('06 12 12 12 12', 'lina@example.test', '06 34 34 34 34');
    expect(excluded).toEqual(free);
    // Aucune fiche neuve pour Omar, rien dans aucune file d'appel.
    expect(await t.persons()).toBe(before);
    expect(await t.gagner.toCall(t.agent(t.sam.id))).toEqual({ ok: true, value: [] });
    const omarView = await t.fiche.view(omar.id);
    expect([omarView.identifiers.length, omarView.consents.length]).toEqual([1, 0]);
    // Le partenaire voit une date par envoi accepté, quoi qu'il en soit advenu.
    const mine = await t.gagner.mine(t.as(p));
    expect(mineAfterExcluded.ok && mineAfterExcluded.value).toHaveLength(3);
    expect(mine.ok && mine.value).toHaveLength(6);
  });

  it('[R77] X24 · la même recommandation renvoyée après une réponse perdue reste une seule : une date de plus aux envois, rien de plus', async () => {
    const t = await setup();
    const p = await t.partner('Étude Essai');
    await t.entrust(p);
    const first = await t.gagner.recommend(t.as(p), t.input());
    const again = await t.gagner.recommend(t.as(p), t.input());
    expect(again).toEqual(first);
    expect(await t.rows()).toHaveLength(1);
    const mine = await t.gagner.mine(t.as(p));
    expect(mine.ok && mine.value).toHaveLength(2);
  });

  describe('X25 · une panne au milieu, puis un renvoi', () => {
    const counts = async (t: Awaited<ReturnType<typeof setup>>) => ({
      persons: await t.persons(),
      projects: (await t.db.all('SELECT id FROM projects')).length,
      sources: (await t.db.all('SELECT id FROM sources')).length,
      consents: (await t.db.all('SELECT id FROM consents')).length,
      recommendations: (await t.rows()).length,
    });
    const panne = async (t: Awaited<ReturnType<typeof setup>>, table: string, act: () => Promise<unknown>) => {
      await t.db.run(`CREATE TRIGGER panne_x25 BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT, 'panne'); END`);
      await expect(act()).rejects.toThrow();
      await t.db.run('DROP TRIGGER panne_x25');
    };

    for (const table of ['persons', 'person_identifiers', 'projects', 'sources', 'consents', 'partner_recommendations']) {
      it(`[R142] [R17] une panne en écrivant dans ${table} : rien n’est gardé, et le renvoi fait une seule fiche, un seul projet, une seule source, un seul accord, une seule recommandation`, async () => {
        const t = await setup();
        const p = await t.partner('Étude Essai');
        await t.entrust(p);
        const before = await counts(t);
        await panne(t, table, () => t.gagner.recommend(t.as(p), t.input()));
        expect(await counts(t)).toEqual(before);
        expect(await t.gagner.recommend(t.as(p), t.input())).toEqual({ ok: true, value: { recorded: true } });
        expect(await counts(t)).toEqual({
          persons: before.persons + 1,
          projects: before.projects + 1,
          sources: before.sources + 1,
          consents: before.consents + 1,
          recommendations: 1,
        });
        expect((await t.journal.all()).filter((e) => e.type === 'recommandation.alerte')).toHaveLength(1);
        const mine = await t.gagner.mine(t.as(p));
        expect(mine.ok && mine.value).toHaveLength(1);
      });
    }

    it('[R142] une panne sur une fiche déjà connue : la coordonnée nouvelle reste, et le renvoi ne fait qu’un projet', async () => {
      const t = await setup();
      const p = await t.partner('Étude Essai');
      await t.entrust(p);
      const known = await t.store.createPerson({ networkId: t.network.id, agentId: t.alex.id, firstName: 'Hugo' });
      await t.fiche.addIdentifier({ networkId: t.network.id, agentId: t.alex.id, personId: known.id, kind: 'phone', value: '06 11 22 33 44' });
      const before = await counts(t);
      await panne(t, 'projects', () => t.gagner.recommend(t.as(p), t.input()));
      expect(await counts(t)).toEqual(before);
      expect(await t.gagner.recommend(t.as(p), t.input())).toEqual({ ok: true, value: { recorded: true } });
      expect(await counts(t)).toEqual({ ...before, projects: before.projects + 1, sources: before.sources + 1, consents: before.consents + 1, recommendations: 1 });
      expect((await t.fiche.view(known.id)).identifiers).toHaveLength(2);
    });

    it('[R77] une panne après le lot, sur la date du partenaire : le renvoi ne range rien de plus et ajoute la date', async () => {
      const t = await setup();
      const p = await t.partner('Étude Essai');
      await t.entrust(p);
      await panne(t, 'partner_recommendation_submissions', () => t.gagner.recommend(t.as(p), t.input()));
      const stored = await counts(t);
      expect(stored.recommendations).toBe(1);
      expect(await t.gagner.recommend(t.as(p), t.input())).toEqual({ ok: true, value: { recorded: true } });
      expect(await counts(t)).toEqual(stored);
      const mine = await t.gagner.mine(t.as(p));
      expect(mine.ok && mine.value).toHaveLength(1);
    });

    it('[R142] une panne du journal après le lot : l’appel reste à faire, et le renvoi ne range rien de plus', async () => {
      const t = await setup();
      const p = await t.partner('Étude Essai');
      await t.entrust(p);
      await panne(t, 'journal', () => t.gagner.recommend(t.as(p), t.input()));
      const stored = await counts(t);
      expect(stored.recommendations).toBe(1);
      expect(await t.gagner.recommend(t.as(p), t.input())).toEqual({ ok: true, value: { recorded: true } });
      expect(await counts(t)).toEqual(stored);
      const calls = await t.gagner.toCall(t.agent());
      expect(calls.ok && calls.value).toHaveLength(1);
    });

    it('le brouillon de la fiche n’écrit rien tant que le lot n’est pas passé, et refuse de lire', async () => {
      const t = await setup();
      const prepared = await t.store.prepare((draft) => draft.createPerson({ networkId: t.network.id, agentId: null, firstName: 'Lot' }));
      expect(prepared.statements).toHaveLength(1);
      expect(await t.db.all('SELECT id FROM persons WHERE id = ?', [prepared.value.id])).toEqual([]);
      await expect(t.store.prepare((draft) => draft.listProjects('x'))).rejects.toThrow('n’écrit qu’en insérant');
    });
  });

  it('[R03] [R142] un accord par mail ne permet jamais un appel : la file dit le seul canal accepté', async () => {
    const t = await setup();
    const p = await t.partner('Étude Essai');
    await t.entrust(p);
    expect(await t.gagner.recommend(t.as(p), t.input({ consent: t.consent({ channel: 'email' }) }))).toMatchObject({ ok: true });
    const list = await t.gagner.toCall(t.agent());
    expect(list.ok && list.value.map((r) => r.channel)).toEqual(['email']);
    const [row] = await t.rows();
    const view = await t.fiche.view(row!.referred_id!);
    expect(view.consents.map((c) => c.channel)).toEqual(['email']);
  });

  it('[R16] [G16] seule la direction lit les agents à qui attribuer, par nom, sans autre donnée ; seule sa file dit « à attribuer »', async () => {
    const t = await setup();
    const p = await t.partner('Étude Essai');
    await t.gagner.recommend(t.as(p), t.input());
    const agents = await t.gagner.assignableAgents(t.dir);
    expect(agents.ok && agents.value.map((a) => Object.keys(a).sort())[0]).toEqual(['agentId', 'firstName', 'lastName']);
    expect(agents.ok && agents.value.map((a) => a.agentId)).toEqual(expect.arrayContaining([t.alex.id, t.sam.id]));
    expect(await t.gagner.assignableAgents(t.agent())).toMatchObject({ ok: false, rule: 'R16', code: 'role' });
    // Un agent parti n'est plus proposé.
    await t.db.run("UPDATE agents SET status = 'left' WHERE id = ?", [t.sam.id]);
    const after = await t.gagner.assignableAgents(t.dir);
    expect(after.ok && after.value.map((a) => a.agentId)).not.toContain(t.sam.id);
    const dirList = await t.gagner.toCall(t.dir);
    expect(dirList.ok && dirList.value.map((r) => r.assignable)).toEqual([true]);
    const [row] = await t.rows();
    await t.gagner.assign(t.dir, row!.id, t.alex.id);
    const alexList = await t.gagner.toCall(t.agent());
    expect(alexList.ok && alexList.value.map((r) => r.assignable)).toEqual([undefined]);
  });

  it('[R16] [R86] [G16] un agent au dossier incomplet n’est ni proposé ni accepté : la recommandation reste à la direction', async () => {
    const t = await setup();
    const p = await t.partner('Étude Essai');
    await t.gagner.recommend(t.as(p), t.input());
    const [row] = await t.rows();
    // Une seule pièce rangée : le dossier existe, il n'est pas complet.
    await t.db.run(
      "INSERT INTO agent_file_pieces (id, network_id, agent_id, kind, version, ref, issued_on, valid_until, is_draft, recorded_by, recorded_at) VALUES ('piece-1', ?, ?, 'contrat_agent_commercial', 1, 'ref-1', '2027-01-01', NULL, 0, 'dir-1', '2027-01-01T08:00:00.000Z')",
      [t.dir.networkId, t.sam.id],
    );
    const agents = await t.gagner.assignableAgents(t.dir);
    expect(agents.ok && agents.value.map((a) => a.agentId)).toEqual([t.alex.id]);
    expect(await t.gagner.assign(t.dir, row!.id, t.sam.id)).toEqual({ ok: false, rule: null, code: 'bad_agent' });
    const dirList = await t.gagner.toCall(t.dir);
    expect(dirList.ok && dirList.value.map((r) => r.recommendationId)).toEqual([row!.id]);
    expect(await t.gagner.assign(t.dir, row!.id, t.alex.id)).toEqual({ ok: true, value: { assigned: true } });
  });

  it('[R16] deux recommandations de la même personne sans agent : la seconde va d’elle-même à l’agent qui a reçu la première', async () => {
    const t = await setup();
    const p = await t.partner('Étude Essai');
    const q = await t.partner('Étude Seconde');
    await t.gagner.recommend(t.as(p), t.input());
    await t.gagner.recommend(t.as(q), t.input());
    const [first, second] = await t.rows();
    expect([first!.agent_id, second!.agent_id]).toEqual([null, null]);
    expect(await t.gagner.assign(t.dir, first!.id, t.alex.id)).toEqual({ ok: true, value: { assigned: true } });
    // La seconde suit la personne : elle va d'elle-même à Alex, et ne peut plus être donnée à Sam.
    expect(await t.gagner.assign(t.dir, second!.id, t.sam.id)).toEqual({ ok: false, rule: null, code: 'already_assigned' });
    // Les projets des deux recommandations passent à Alex.
    const projects = await t.db.all<{ agent_id: string | null }>('SELECT p.agent_id FROM projects p JOIN partner_recommendations r ON r.project_id = p.id');
    expect(projects.map((p) => p.agent_id)).toEqual([t.alex.id, t.alex.id]);
    const list = await t.gagner.toCall(t.agent());
    expect(list.ok && list.value.map((r) => r.recommendationId).sort()).toEqual([first!.id, second!.id].sort());
  });

  it('[R86] après le départ de l’agent, la tâche suit la personne : la direction ou le successeur la voit, l’agent parti non', async () => {
    const t = await setup();
    const p = await t.partner('Étude Essai');
    await t.entrust(p);
    await t.gagner.recommend(t.as(p), t.input());
    const [row] = await t.rows();
    expect(row!.agent_id).toBe(t.alex.id);
    // Alex part ; la passation rend ses fiches à la direction (sans agent).
    await t.db.run("UPDATE agents SET status = 'left' WHERE id = ?", [t.alex.id]);
    await t.db.run('UPDATE persons SET agent_id = NULL WHERE agent_id = ?', [t.alex.id]);
    await t.db.run('UPDATE projects SET agent_id = NULL WHERE agent_id = ?', [t.alex.id]);
    const dirList = await t.gagner.toCall(t.dir);
    expect(dirList.ok && dirList.value.map((r) => r.recommendationId)).toEqual([row!.id]);
    expect(await t.gagner.assign(t.dir, row!.id, t.sam.id)).toEqual({ ok: true, value: { assigned: true } });
    const samList = await t.gagner.toCall(t.agent(t.sam.id));
    expect(samList.ok && samList.value.map((r) => r.recommendationId)).toEqual([row!.id]);
    expect(await t.gagner.callDone(t.agent(t.sam.id), row!.id)).toEqual({ ok: true, value: { done: true } });
  });

  it('[R16] quand une recommandation donne un agent à la personne, ses projets plus anciens passent avec elle', async () => {
    const t = await setup();
    const p = await t.partner('Étude Essai');
    const q = await t.partner('Étude Seconde');
    // Le premier partenaire n'a confié aucune mise en relation : pas d'agent. Le second, si.
    await t.gagner.recommend(t.as(p), t.input());
    await t.entrust(q);
    await t.gagner.recommend(t.as(q), t.input());
    const projects = await t.db.all<{ agent_id: string | null }>('SELECT p.agent_id FROM projects p JOIN partner_recommendations r ON r.project_id = p.id ORDER BY r.created_at');
    expect(projects.map((x) => x.agent_id)).toEqual([t.alex.id, t.alex.id]);
    const list = await t.gagner.toCall(t.agent());
    expect(list.ok && list.value).toHaveLength(2);
  });

  it('[R16] [R73] seul un partenaire du réseau, aux justificatifs valides, recommande ; la direction attribue ce qui n’a pas d’agent', async () => {
    const t = await setup();
    const p = await t.partner('Étude Essai');
    const lapsed = await t.partner('Étude Échue', -1);
    expect(await t.gagner.recommend(t.agent(), t.input())).toEqual({ ok: false, rule: 'R16', code: 'role' });
    expect(await t.gagner.recommend(t.dir, t.input())).toEqual({ ok: false, rule: 'R16', code: 'role' });
    expect(await t.gagner.recommend(t.as(p, t.other.id), t.input())).toEqual({ ok: false, rule: 'R16', code: 'unknown' });
    expect(await t.gagner.recommend(t.as(lapsed), t.input())).toEqual({ ok: false, rule: 'R73', code: 'credentials' });
    expect(await t.gagner.mine(t.agent())).toEqual({ ok: false, rule: 'R16', code: 'role' });
    expect(await t.gagner.toCall(t.as(p))).toEqual({ ok: false, rule: 'R16', code: 'role' });
    // Aucune mise en relation confiée : pas d'agent, la direction est alertée et attribue.
    expect(await t.gagner.recommend(t.as(p), t.input())).toMatchObject({ ok: true });
    const [row] = await t.rows();
    expect(row!.agent_id).toBeNull();
    expect((await t.journal.all()).filter((e) => e.type === 'recommandation.alerte').map((e) => [e.subject, e.data.to])).toEqual([[null, 'direction']]);
    expect(await t.gagner.toCall(t.agent())).toEqual({ ok: true, value: [] });
    const dirList = await t.gagner.toCall(t.dir);
    expect(dirList.ok && dirList.value.map((r) => r.recommendationId)).toEqual([row!.id]);
    expect(await t.gagner.assign(t.agent(), row!.id, t.alex.id)).toEqual({ ok: false, rule: 'R16', code: 'role' });
    expect(await t.gagner.assign(t.dir, row!.id, 'inconnu')).toEqual({ ok: false, rule: null, code: 'bad_agent' });
    expect(await t.gagner.assign(t.dir, row!.id, t.alex.id)).toEqual({ ok: true, value: { assigned: true } });
    // Le projet de la recommandation passe à l'agent avec la personne.
    expect((await t.db.all<{ agent_id: string | null }>('SELECT agent_id FROM projects WHERE person_id = ?', [row!.referred_id])).map((r) => r.agent_id)).toEqual([t.alex.id]);
    expect(await t.gagner.assign(t.dir, row!.id, t.sam.id)).toEqual({ ok: false, rule: null, code: 'already_assigned' });
    expect(await t.gagner.callDone(t.agent(t.sam.id), row!.id)).toEqual({ ok: false, rule: 'R16', code: 'not_assigned' });
    expect(await t.gagner.callDone(t.agent(), row!.id)).toEqual({ ok: true, value: { done: true } });
    expect(await t.gagner.toCall(t.agent())).toEqual({ ok: true, value: [] });
    // Un agent parti ne lit plus rien [R86].
    await t.db.run("UPDATE agents SET status = 'left' WHERE id = ?", [t.alex.id]);
    expect(await t.gagner.toCall(t.agent())).toEqual({ ok: false, rule: 'R16', code: 'agent_inactive' });
    expect(await t.gagner.callDone(t.agent(), row!.id)).toEqual({ ok: false, rule: 'R16', code: 'agent_inactive' });
    // La ligne reste, et ne change plus [R17].
    await expect(t.db.run('DELETE FROM partner_recommendations')).rejects.toThrow(/rien ne s'efface/);
    await expect(t.db.run('UPDATE partner_recommendations SET call_done_at = NULL')).rejects.toThrow(/ne change plus/);
  });
});
