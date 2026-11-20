import { describe, expect, it } from 'vitest';
import {
  Acces,
  FicheClient,
  FicheUnique,
  Planificateur,
  PointSemaine,
  SELLER_UPDATE_PURPOSE,
  SqlJournalStore,
  applyMigrations,
  fromSyncSqlite,
  verifyChain,
  weeklyPointJob,
  weeklyPointText,
  checkText,
  type MandateGate,
  type SqlDatabase,
} from '../src/index.ts';
import { MesureBiens } from '../src/annonces/mesure.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

// Lundis 14 et 21 décembre 2026, 8 h et 9 h à Paris.
const MON1_8H = Date.parse('2026-12-14T07:00:00.000Z');
const MON2_8H = Date.parse('2026-12-21T07:00:00.000Z');
const HOUR = 3_600_000;

async function setup() {
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  let clock = MON1_8H;
  const now = (): Date => new Date(clock);
  const journal = new SqlJournalStore(db);
  const store = new FicheClient(db, { now });
  const fiche = new FicheUnique(db, store, { now });
  const acces = new Acces(db, store, fiche, journal, { now });
  const mandateOf = new Map<string, string>();
  const gate: MandateGate = {
    canDiffuse: async (_n, propertyId) => {
      const m = mandateOf.get(propertyId);
      return m ? { allowed: true, reason: 'allowed', mandateId: m, withdrawalLastDay: null } : { allowed: false, reason: 'no_mandate', mandateId: null, withdrawalLastDay: null };
    },
  };
  const point = new PointSemaine(db, journal, acces, { now, diffusion: gate });
  const network = await store.createNetwork('Réseau test');
  const alex = await store.createAgent({ networkId: network.id, firstName: 'Alex', lastName: 'Agent' });
  const sam = await store.createAgent({ networkId: network.id, firstName: 'Sam', lastName: 'Agent' });
  const as = (role: 'agent' | 'direction' | 'compliance', userId: string) => ({ role, userId, networkId: network.id });
  /** Un vendeur inventé d'Alex, son bien, son mandat en cours et son accord pour le suivi de la vente. */
  const seller = async (i: number) => {
    const person = await store.createPerson({ networkId: network.id, agentId: alex.id, firstName: `Vendeur${'ABCDEFGH'[i]}`, lastName: 'Test' });
    await store.addIdentifier({ networkId: network.id, personId: person.id, kind: 'email', value: `vendeur${i}@example.test` });
    await store.addConsent({ networkId: network.id, personId: person.id, purpose: SELLER_UPDATE_PURPOSE, channel: 'email', proof: 'mandat', givenAt: new Date(MON1_8H - 30 * 24 * HOUR) });
    const property = await store.createProperty({ networkId: network.id, agentId: alex.id, reference: `B${i}`, kind: 'home', city: 'Talant', priceEur: 250_000, surfaceM2: 90, rooms: 4, status: 'available' });
    const mandateId = `mandat-${i}`;
    await db.run(
      "INSERT INTO mandates (id, network_id, agent_id, person_id, property_id, signed_at, source_kind, recorded_by, created_at) VALUES (?, ?, ?, ?, ?, ?, 'site', 'test', ?)",
      [mandateId, network.id, alex.id, person.id, property.id, new Date(MON1_8H - 20 * 24 * HOUR).toISOString(), new Date(MON1_8H).toISOString()],
    );
    mandateOf.set(property.id, mandateId);
    return { person, property, mandateId };
  };
  const inbox = (personId: string) => db.all<{ body: string }>('SELECT m.body FROM messages m JOIN trial_outbox t ON t.message_id = m.id WHERE m.person_id = ? ORDER BY m.occurred_at', [personId]);
  return { db, journal, acces, point, network, alex, sam, as, seller, inbox, setClock: (t: number) => (clock = t), clock: () => clock, now };
}

describeWithSqlite('T07 · point de la semaine au vendeur', () => {
  it('5 vendeurs reçoivent leur point deux lundis de suite, un seul par mandat et par lundi [R18], à l’heure de Paris', async () => {
    const t = await setup();
    const sellers: Awaited<ReturnType<typeof t.seller>>[] = [];
    for (let i = 0; i < 5; i += 1) sellers.push(await t.seller(i));
    const planificateur = new Planificateur(t.db, t.journal, [weeklyPointJob(t.db, t.journal, () => t.acces, { now: t.now, diffusion: { canDiffuse: async (_n, p) => ({ allowed: true, reason: 'allowed', mandateId: sellers.find((s) => s.property.id === p)!.mandateId, withdrawalLastDay: null }) } })], { now: t.now });
    for (const [monday, week] of [[MON1_8H, '2026-12-07'], [MON2_8H, '2026-12-14']] as const) {
      t.setClock(monday);
      await planificateur.tick();
      await t.point.prepare(t.network.id);
      expect(Number((await t.db.first<{ n: number }>('SELECT count(*) AS n FROM weekly_points WHERE week = ?', [week]))!.n)).toBe(5);
      t.setClock(monday + HOUR);
      for (const s of sellers) expect(await t.point.validate(t.as('agent', t.alex.id), s.mandateId, week, ['relancer les acquéreurs du fichier commun'])).toMatchObject({ ok: true, delivery: 'sent' });
    }
    for (const s of sellers) {
      const got = await t.inbox(s.person.id);
      expect(got).toHaveLength(2);
      expect(got[0]!.body).toContain('point de la semaine du 07/12 au 13/12');
      expect(got[1]!.body).toContain('point de la semaine du 14/12 au 20/12');
    }
  });

  it('SV13 · un prénom corrigé après la préparation : l’écran et le message disent le nouveau', async () => {
    const t = await setup();
    const s = await t.seller(0);
    await t.point.prepare(t.network.id);
    await t.db.run("UPDATE persons SET first_name = 'Corrigé' WHERE id = ?", [s.person.id]);
    t.setClock(MON1_8H + HOUR);
    const read = await t.point.read(t.as('agent', t.alex.id), s.mandateId, '2026-12-07');
    if (!read.ok) throw new Error(read.code);
    expect(read.text).toContain('Bonjour Corrigé,');
    expect(read.text).not.toContain('VendeurA');
    expect(await t.point.validate(t.as('agent', t.alex.id), s.mandateId, '2026-12-07', ['relancer les acquéreurs du fichier commun'])).toMatchObject({ ok: true });
    const [sent] = await t.inbox(s.person.id);
    expect(sent!.body).toContain('Bonjour Corrigé,');
    expect(sent!.body).not.toContain('VendeurA');
  });

  it('chaque chiffre est lu dans la base ; une donnée absente est « non communiquée » [R53] ; avis des visiteurs sans nom', async () => {
    const t = await setup();
    const s = await t.seller(1);
    const other = await t.seller(2);
    await new MesureBiens(t.db, t.acces, t.journal, { now: t.now }).recordViews(t.network.id, s.property.id, 'portails', '2026-12-09', 42);
    await t.point.prepare(t.network.id);
    const a = await t.point.read(t.as('agent', t.alex.id), s.mandateId, '2026-12-07');
    expect(a).toMatchObject({ ok: true, figures: { views: 42, contacts: 0, visitsDone: 0, visitsPlanned: 0, opinions: [] } });
    if (a.ok) {
      expect(a.text).toContain('Vues de l’annonce : 42.');
      expect(a.text).toContain('Avis des visiteurs : non communiqués.');
    }
    const b = await t.point.read(t.as('agent', t.alex.id), other.mandateId, '2026-12-07');
    expect(b).toMatchObject({ ok: true, figures: { views: null } });
    if (b.ok) expect(b.text).toContain('Vues de l’annonce : non communiquées.');
  });

  it('jamais de baisse de prix : une prochaine action qui en parle est refusée [R53]', async () => {
    const t = await setup();
    const s = await t.seller(1);
    await t.point.prepare(t.network.id);
    t.setClock(MON1_8H + HOUR);
    for (const action of ['Proposer une baisse de prix de 5 %', 'revoir le prix avec vous', 'Repositionner le bien', 'diminuer le prix']) {
      expect(await t.point.validate(t.as('agent', t.alex.id), s.mandateId, '2026-12-07', [action])).toEqual({ ok: false, rule: 'R53', code: 'price_drop' });
    }
    expect(await t.inbox(s.person.id)).toEqual([]);
    expect(await t.point.validate(t.as('agent', t.alex.id), s.mandateId, '2026-12-07', ['organiser deux visites samedi'])).toMatchObject({ ok: true, delivery: 'sent' });
    // Validé, il ne change plus, et ne repart pas [R17, R18].
    expect(await t.point.validate(t.as('agent', t.alex.id), s.mandateId, '2026-12-07', ['autre'])).toMatchObject({ ok: true, delivery: 'sent' });
    expect(await t.inbox(s.person.id)).toHaveLength(1);
    await expect(t.db.run("UPDATE weekly_points SET figures = '{}'")).rejects.toThrow();
    await expect(t.db.run('DELETE FROM weekly_points')).rejects.toThrow();
  });

  it('une action ne porte ni chiffre, ni prix, ni nom ou coordonnée d’un visiteur [R10, R52, R53]', async () => {
    const t = await setup();
    const s = await t.seller(1);
    const store = new FicheClient(t.db, { now: t.now });
    const buyer = await store.createPerson({ networkId: t.network.id, agentId: t.alex.id, firstName: 'Inès', lastName: 'Durand-Test' });
    await store.addIdentifier({ networkId: t.network.id, personId: buyer.id, kind: 'email', value: 'ines.durand@example.test' });
    await t.db.run(
      "INSERT INTO appointments (id, network_id, agent_id, person_id, property_id, kind, start_at, end_at, status, token_hash, source, created_at, updated_at) VALUES ('a1', ?, ?, ?, ?, 'visite', ?, ?, 'honored', 'h1', 'agent', ?, ?)",
      [t.network.id, t.alex.id, buyer.id, s.property.id, '2026-12-09T09:00:00.000Z', '2026-12-09T09:45:00.000Z', new Date(MON1_8H).toISOString(), new Date(MON1_8H).toISOString()],
    );
    await t.point.prepare(t.network.id);
    t.setClock(MON1_8H + HOUR);
    const v = (a: string) => t.point.validate(t.as('agent', t.alex.id), s.mandateId, '2026-12-07', [a]);
    expect(await v('présenter le bien à 229 000 € aux acquéreurs')).toMatchObject({ ok: false, rule: 'R53' });
    expect(await v('abaisser le prix demandé')).toMatchObject({ ok: false, rule: 'R53' });
    expect(await v('12 visites prévues')).toMatchObject({ ok: false, rule: 'R10' });
    expect(await v('rappeler M. Durand pour sa contre-visite')).toMatchObject({ ok: false, rule: 'R52' });
    expect(await v('écrire à ines.durand@example.test')).toMatchObject({ ok: false, rule: 'R52' });
    // Un visiteur qui porte le nom du vendeur reste protégé.
    expect(await v('rappeler Monsieur Test pour sa contre-visite')).toMatchObject({ ok: false, rule: 'R52' });
    expect(await v('rappeler Monsieur Te(st) pour sa contre-visite')).toMatchObject({ ok: false, rule: 'R52' });
    // Une action refusée par le contrôle du texte ne fige pas le point : elle se corrige.
    expect(await v('organiser une visite gratuite')).toMatchObject({ ok: false, rule: 'R07', code: 'text_refused' });
    expect(await t.inbox(s.person.id)).toEqual([]);
    expect(await v('organiser une contre-visite')).toMatchObject({ ok: true, delivery: 'sent' });
    expect((await t.inbox(s.person.id))[0]!.body).toContain('Visites faites : 1');
  });

  it('au plus huit avis : un point chargé reste sous la longueur d’un mail', () => {
    const opinions = Array.from({ length: 8 }, () => 'a'.repeat(298));
    const text = weeklyPointText('Victor', { week: '2026-12-07', views: 3, contacts: 2, visitsDone: 14, visitsPlanned: 0, opinions, moreOpinions: true }, ['organiser une contre-visite']);
    expect(text).toContain('et d’autres avis');
    expect(checkText(text, { audience: 'client', channel: 'email', firstOfConversation: false, firstName: 'Victor', figures: [3, 2, 14, 0, 7, 12, 13] }).filter((p) => p.rule === 'length')).toEqual([]);
  });

  it('seuls l’agent du mandat et la direction [R16] ; validé un dimanche, il attend l’heure [R01] ; rien de personnel au journal [R13]', async () => {
    const t = await setup();
    const s = await t.seller(1);
    await t.point.prepare(t.network.id);
    expect(await t.point.read(t.as('agent', t.sam.id), s.mandateId, '2026-12-07')).toMatchObject({ ok: false, rule: 'R16' });
    expect(await t.point.read(t.as('compliance', 'c1'), s.mandateId, '2026-12-07')).toMatchObject({ ok: false, rule: 'R16' });
    expect(await t.point.read(t.as('direction', 'd1'), s.mandateId, '2026-12-07')).toMatchObject({ ok: true });
    t.setClock(Date.parse('2026-12-13T20:00:00.000Z'));
    expect(await t.point.validate(t.as('agent', t.alex.id), s.mandateId, '2026-12-07')).toEqual({ ok: true, delivery: 'waiting', rule: 'R01' });
    t.setClock(MON1_8H + HOUR);
    expect(await t.point.retry()).toBe(1);
    expect(await t.inbox(s.person.id)).toHaveLength(1);
    const entries = await t.journal.all();
    expect(JSON.stringify(entries)).not.toMatch(/VendeurB|vendeur1@|Talant/);
    expect((await verifyChain(entries)).ok).toBe(true);
  });

  it('[R86] un point validé par un agent parti ne part plus, même après la reprise de ses clients par un autre (J13)', async () => {
    const t = await setup();
    const s = await t.seller(1);
    await t.point.prepare(t.network.id);
    t.setClock(Date.parse('2026-12-13T20:00:00.000Z'));
    expect(await t.point.validate(t.as('agent', t.alex.id), s.mandateId, '2026-12-07')).toEqual({ ok: true, delivery: 'waiting', rule: 'R01' });
    // Alex part ; son vendeur est repris par Sam avant le passage suivant.
    await t.db.run("UPDATE agents SET status = 'left' WHERE id = ?", [t.alex.id]);
    await t.db.run('UPDATE persons SET agent_id = ? WHERE id = ?', [t.sam.id, s.person.id]);
    t.setClock(MON1_8H + HOUR);
    await t.point.retry();
    expect(await t.inbox(s.person.id)).toHaveLength(0);
    expect(await t.db.first('SELECT delivery_status, delivery_rule FROM weekly_points WHERE mandate_id = ?', [s.mandateId])).toEqual({ delivery_status: 'refused', delivery_rule: 'R86' });
  });

  describe('AU078 · une décision de prix déjà convenue, consignée dans le point [R53]', () => {
    const meeting = async (t: Awaited<ReturnType<typeof setup>>, id: string, personId: string, propertyId: string | null, o: { kind?: string; status?: string; start?: string; agentId?: string } = {}) => {
      const start = o.start ?? '2026-12-10T10:00:00.000Z';
      await t.db.run(
        "INSERT INTO appointments (id, network_id, agent_id, person_id, property_id, kind, start_at, end_at, status, token_hash, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'agent', ?, ?)",
        [id, t.network.id, o.agentId ?? t.alex.id, personId, propertyId, o.kind ?? 'estimation', start, new Date(Date.parse(start) + HOUR).toISOString(), o.status ?? 'honored', `h-${id}`, start, start],
      );
    };
    const ready = async () => {
      const t = await setup();
      const s = await t.seller(3);
      await meeting(t, 'rdv-vendeur', s.person.id, s.property.id);
      await t.point.prepare(t.network.id);
      t.setClock(MON1_8H + HOUR);
      return { t, s, v: (d: Parameters<PointSemaine['validate']>[4], actions = ['organiser deux visites samedi']) => t.point.validate(t.as('agent', t.alex.id), s.mandateId, '2026-12-07', actions, d) };
    };

    it('constat : la décision convenue au rendez-vous du vendeur entre dans le point, sa phrase faite par le code', async () => {
      const { t, s, v } = await ready();
      expect(await v({ appointmentId: 'rdv-vendeur', priceEur: 240_000, confirmed: true })).toMatchObject({ ok: true, delivery: 'sent' });
      const [sent] = await t.inbox(s.person.id);
      expect(sent!.body).toContain('Décision prise ensemble lors de notre rendez-vous du 10/12 : le prix demandé pour votre bien passe à 240 000 €.');
      expect(sent!.body).toContain('Prochaines actions : organiser deux visites samedi.');
      const read = await t.point.read(t.as('agent', t.alex.id), s.mandateId, '2026-12-07');
      expect(read).toMatchObject({ ok: true, priceDecision: { appointmentId: 'rdv-vendeur', kind: 'estimation', day: '2026-12-10', priceEur: 240_000 } });
      // Figée avec le point validé [R17].
      await expect(t.db.run('UPDATE weekly_points SET price_decision = NULL')).rejects.toThrow();
      // Au journal : le rendez-vous, jamais le prix ni le nom [R13].
      const entries = await t.journal.all();
      const events = entries.filter((e) => e.type === 'point_semaine.decision_prix');
      expect(events).toHaveLength(1);
      expect(events[0]!.data).toEqual({ week: '2026-12-07', appointment: 'rdv-vendeur' });
      expect(JSON.stringify(entries)).not.toMatch(/240|VendeurD|vendeur3@/);
      expect((await verifyChain(entries)).ok).toBe(true);
    });

    it('aucune négociation automatique : ni l’annonce, ni la fiche, ni le mandat, ni un autre message ne changent', async () => {
      const { t, s, v } = await ready();
      const before = {
        property: await t.db.first('SELECT price_eur, status FROM properties WHERE id = ?', [s.property.id]),
        mandate: await t.db.first('SELECT * FROM mandates WHERE id = ?', [s.mandateId]),
        listings: await t.db.all('SELECT * FROM listing_versions'),
        messages: Number((await t.db.first<{ n: number }>('SELECT count(*) AS n FROM messages'))!.n),
        offers: await t.db.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'offers'"),
      };
      expect(await v({ appointmentId: 'rdv-vendeur', priceEur: 230_000, confirmed: true })).toMatchObject({ ok: true, delivery: 'sent' });
      expect(await t.db.first('SELECT price_eur, status FROM properties WHERE id = ?', [s.property.id])).toEqual(before.property);
      expect(await t.db.first('SELECT * FROM mandates WHERE id = ?', [s.mandateId])).toEqual(before.mandate);
      expect(await t.db.all('SELECT * FROM listing_versions')).toEqual(before.listings);
      // Un seul message de plus : le point au vendeur.
      expect(Number((await t.db.first<{ n: number }>('SELECT count(*) AS n FROM messages'))!.n)).toBe(before.messages + 1);
      const types = (await t.journal.all()).map((e) => e.type);
      expect(types.filter((x) => /offre|offer|annonce|listing|negoc|alerte/.test(x))).toEqual([]);
    });

    it('sans confirmation explicite, ou sans rendez-vous tenu avec ce vendeur, rien n’est consigné', async () => {
      const { t, s, v } = await ready();
      const other = await t.seller(4);
      await meeting(t, 'rdv-autre', other.person.id, other.property.id);
      await meeting(t, 'rdv-annule', s.person.id, s.property.id, { status: 'cancelled' });
      await meeting(t, 'rdv-manque', s.person.id, s.property.id, { status: 'absent' });
      await meeting(t, 'rdv-futur', s.person.id, s.property.id, { status: 'booked', start: '2026-12-16T10:00:00.000Z' });
      await meeting(t, 'rdv-avant', s.person.id, s.property.id, { start: '2026-11-10T10:00:00.000Z' });
      await meeting(t, 'rdv-sam', s.person.id, s.property.id, { agentId: t.sam.id });
      await meeting(t, 'rdv-visite', s.person.id, s.property.id, { kind: 'visite' });
      expect(await v({ appointmentId: 'rdv-vendeur', priceEur: 240_000, confirmed: false })).toEqual({ ok: false, rule: 'R53', code: 'price_decision_not_confirmed' });
      for (const [id, code] of [['inconnu', 'exchange_unknown'], ['rdv-autre', 'exchange_unknown'], ['rdv-sam', 'exchange_unknown'], ['rdv-visite', 'exchange_unknown'], ['rdv-annule', 'exchange_not_held'], ['rdv-manque', 'exchange_not_held'], ['rdv-futur', 'exchange_not_held'], ['rdv-avant', 'exchange_before_mandate']] as const) {
        expect(await v({ appointmentId: id, priceEur: 240_000, confirmed: true })).toEqual({ ok: false, rule: 'R53', code });
      }
      for (const priceEur of [0, 240_000.5, Number.NaN, 250_000]) expect(await v({ appointmentId: 'rdv-vendeur', priceEur, confirmed: true })).toMatchObject({ ok: false, rule: 'R53' });
      expect(await t.inbox(s.person.id)).toEqual([]);
      // Un rendez-vous passé, jamais marqué, mais pas annulé, suffit.
      await meeting(t, 'rdv-passe', s.person.id, null, { status: 'booked', start: '2026-12-11T15:00:00.000Z', kind: 'appel' });
      expect(await v({ appointmentId: 'rdv-passe', priceEur: 240_000, confirmed: true })).toMatchObject({ ok: true, delivery: 'sent' });
      expect((await t.inbox(s.person.id))[0]!.body).toContain('lors de notre échange téléphonique du 11/12');
    });

    it('le prix reste interdit partout ailleurs : actions et avis des visiteurs [R53]', async () => {
      const { t, s, v } = await ready();
      expect(await v({ appointmentId: 'rdv-vendeur', priceEur: 240_000, confirmed: true }, ['baisser encore le prix'])).toEqual({ ok: false, rule: 'R53', code: 'price_drop' });
      expect(await v({ appointmentId: 'rdv-vendeur', priceEur: 240_000, confirmed: true }, ['présenter le bien à 235 000 €'])).toMatchObject({ ok: false, rule: 'R53' });
      expect(await t.inbox(s.person.id)).toEqual([]);
      // Sans décision, le point n'en parle toujours pas.
      expect(await v(null)).toMatchObject({ ok: true, delivery: 'sent' });
      expect(plainBody((await t.inbox(s.person.id))[0]!.body)).not.toMatch(/prix|€/);
    });
  });
});

const plainBody = (b: string): string => b.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
