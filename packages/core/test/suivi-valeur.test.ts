import { afterEach, expect, it, vi } from 'vitest';
import {
  Acces,
  FicheClient,
  FicheUnique,
  PlanDuJour,
  Planificateur,
  SqlJournalStore,
  SuiviDeValeur,
  VALUE_TRACKING_PURPOSE,
  applyMigrations,
  fromSyncSqlite,
  valueTrackingJob,
  valueTrackingText,
  saysSellingIntent,
  type CommuneRanges,
  type CommuneResult,
  type SqlDatabase,
} from '../src/index.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

// Inscription un mardi de janvier ; envois dus six mois plus tard, en juillet (Paris à UTC+2). Tout est inventé.
const ENROL = Date.parse('2027-01-12T09:00:00.000Z');
const JULY_TUE_10H = Date.parse('2027-07-20T08:00:00.000Z');
const JULY_SUN_10H = Date.parse('2027-07-25T08:00:00.000Z');
const JULY_TUE_21H30 = Date.parse('2027-07-20T19:30:00.000Z');
const DAY = 86_400_000;

const RANGE: Extract<CommuneResult, { ok: true }>['value'] = {
  town: 'Talant',
  postalCode: '21240',
  kind: 'house',
  perM2: { low: 2450, median: 2800, high: 3100 },
  sales: 24,
  period: { from: '2026-01', to: '2027-04' },
  data: { lastSale: '2027-04-28', source: 'DVF test', recentMissing: true },
  next: 'appointment',
};

afterEach(() => vi.restoreAllMocks());

async function setup(initial: CommuneResult = { ok: true, value: RANGE }) {
  let rangeResult = initial;
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  let clock = ENROL;
  const now = (): Date => new Date(clock);
  const journal = new SqlJournalStore(db);
  const store = new FicheClient(db, { now });
  const fiche = new FicheUnique(db, store, { now });
  const acces = new Acces(db, store, fiche, journal, { now });
  const calls: string[] = [];
  const ranges: CommuneRanges = {
    forTown: async (postalCode, town, kind) => {
      calls.push(`${postalCode} ${town} ${kind}`);
      return rangeResult;
    },
  };
  const suivi = new SuiviDeValeur(db, journal, { now, ranges });
  const network = await store.createNetwork('Réseau test');
  const alex = await store.createAgent({ networkId: network.id, firstName: 'Alex', lastName: 'Agent' });
  const sam = await store.createAgent({ networkId: network.id, firstName: 'Sam', lastName: 'Agent' });
  const owner = async (who: string, consent: boolean | 'sms' = true) => {
    const p = await store.createPerson({ networkId: network.id, agentId: alex.id, firstName: who });
    await store.addIdentifier({ networkId: network.id, personId: p.id, kind: 'email', value: `${who.toLowerCase()}@example.test` });
    await store.addSource({ networkId: network.id, agentId: alex.id, personId: p.id, channel: 'site', detail: 'estimation (test)', occurredAt: new Date(ENROL - DAY) });
    const c = consent
      ? await store.addConsent({ networkId: network.id, personId: p.id, purpose: VALUE_TRACKING_PURPOSE, channel: consent === 'sms' ? 'sms' : 'email', proof: 'case cochée (test)', givenAt: new Date(ENROL - DAY) })
      : null;
    return { id: p.id, consentId: c?.id ?? null };
  };
  const me = { role: 'agent' as const, userId: alex.id, networkId: network.id };
  const enrol = (personId: string, extra: Partial<{ channel: 'email' | 'sms' }> = {}) =>
    suivi.enrol(acces, me, { personId, postalCode: '21240', town: 'Talant', kind: 'house', channel: extra.channel ?? 'email' });
  const outbox = () => db.all<{ body: string }>('SELECT m.body FROM trial_outbox o JOIN messages m ON m.id = o.message_id');
  const sends = () => db.all<{ period: number; status: string; rule: string | null }>('SELECT period, status, rule FROM value_tracking_sends ORDER BY period');
  return { setRange: (r: CommuneResult) => (rangeResult = r), db, journal, store, fiche, acces, suivi, network, alex, sam, owner, me, enrol, outbox, sends, calls, now, setClock: (t: number) => (clock = t) };
}

describeWithSqlite('G04 · suivi de valeur, en mode essai', () => {
  it('[R03, R36] l’inscription demande un accord en cours pour ce suivi, sur ce canal ; une seule par fiche ; l’agent de la fiche ou la direction seulement', async () => {
    const t = await setup();
    const lea = await t.owner('Léa');
    const noe = await t.owner('Noé', false);
    const ugo = await t.owner('Ugo', 'sms');
    const first = await t.enrol(lea.id);
    expect(first).toMatchObject({ ok: true, already: false });
    expect(await t.enrol(lea.id)).toEqual({ ok: true, id: (first as { id: string }).id, already: true });
    expect(await t.enrol(noe.id)).toEqual({ ok: false, rule: 'R03', code: 'no_consent' });
    expect(await t.enrol(ugo.id)).toEqual({ ok: false, rule: 'R03', code: 'no_consent' });
    expect(await t.enrol(ugo.id, { channel: 'sms' })).toMatchObject({ ok: true });
    expect(await t.suivi.enrol(t.acces, { role: 'agent', userId: t.sam.id, networkId: t.network.id }, { personId: noe.id, postalCode: '21240', town: 'Talant', kind: 'house', channel: 'email' })).toMatchObject({ ok: false, rule: 'R16' });
    expect(await t.suivi.enrol(t.acces, { role: 'compliance', userId: 'c-1', networkId: t.network.id }, { personId: noe.id, postalCode: '21240', town: 'Talant', kind: 'house', channel: 'email' })).toEqual({ ok: false, rule: 'R16', code: 'role' });
  });

  it('[R26, R31] six mois après, la fourchette de la commune est rangée dans la boîte d’essai, jamais un prix du bien ; rien ne part', async () => {
    const t = await setup();
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const lea = await t.owner('Léa');
    await t.enrol(lea.id);
    t.setClock(ENROL + 100 * DAY);
    expect((await t.suivi.run()).outcomes).toEqual([]);
    t.setClock(JULY_TUE_10H);
    const { outcomes } = await t.suivi.run();
    expect(outcomes).toEqual([{ trackingId: expect.any(String), period: 1, status: 'sent', rule: null, delivered: false }]);
    expect(t.calls).toEqual(['21240 Talant house']);
    const [message] = await t.outbox();
    expect(message!.body).toContain(
      'Bonjour Léa, comme convenu, voici la valeur des maisons à Talant : de 2 450 € à 3 100 € le m², 2 800 € au milieu, d’après les ventes publiées jusqu’en avril 2027. Les ventes les plus récentes ne sont pas encore publiées. Pour le prix de votre bien, je peux passer le voir quand vous le souhaitez.',
    );
    // Le texte ne cite que les chiffres de la fourchette de la commune [R10, R31].
    const { figures } = valueTrackingText('Léa', 'Talant', 'house', RANGE);
    expect(figures).toEqual(['2 450 €', '3 100 €', '2 800 €', 'avril 2027']);
    expect(fetchSpy).not.toHaveBeenCalled();
    const entries = await t.journal.all();
    expect(entries.filter((e) => e.type === 'suivi_valeur.essai').map((e) => e.data)).toEqual([{ mode: 'essai', sent: false, tracking: expect.any(String), period: 1, status: 'sent', rule: null }]);
    expect(JSON.stringify(entries)).not.toMatch(/Léa|example\.test|2 450/);
  });

  it('[R05] un envoi par période au plus, même si le passage revient ; le suivant à la période d’après ; jamais deux fois le même texte', async () => {
    const t = await setup();
    const lea = await t.owner('Léa');
    await t.enrol(lea.id);
    t.setClock(JULY_TUE_10H);
    await t.suivi.run();
    t.setClock(JULY_TUE_10H + 3_600_000);
    expect((await t.suivi.run()).outcomes).toEqual([]);
    expect(await t.outbox()).toHaveLength(1);
    // Six mois plus tard, les ventes ont changé : un nouveau message part.
    t.setRange({ ok: true, value: { ...RANGE, perM2: { low: 2500, median: 2850, high: 3150 }, data: { ...RANGE.data, lastSale: '2027-10-30' } } });
    t.setClock(ENROL + 2 * 182 * DAY + DAY);
    expect((await t.suivi.run()).outcomes.map((o) => [o.period, o.status, o.rule])).toEqual([[2, 'sent', null]]);
    // Les mêmes chiffres une troisième fois : le même texte ne repart jamais [R05].
    t.setRange({ ok: true, value: { ...RANGE, perM2: { low: 2500, median: 2850, high: 3150 }, data: { ...RANGE.data, lastSale: '2027-10-30' } } });
    t.setClock(ENROL + 3 * 182 * DAY + DAY);
    await t.suivi.run();
    expect(await t.sends()).toEqual([
      { period: 1, status: 'sent', rule: null },
      { period: 2, status: 'sent', rule: null },
      { period: 3, status: 'refused', rule: 'R05' },
    ]);
  });

  it('[R01] la nuit ou le dimanche, l’envoi attend le créneau suivant ; le planificateur ne passe qu’aux heures d’envoi', async () => {
    const t = await setup();
    const lea = await t.owner('Léa');
    await t.enrol(lea.id);
    t.setClock(JULY_TUE_21H30);
    expect((await t.suivi.run()).outcomes.map((o) => [o.status, o.rule])).toEqual([['waiting', 'R01']]);
    t.setClock(JULY_SUN_10H);
    expect((await t.suivi.run()).outcomes.map((o) => [o.status, o.rule])).toEqual([['waiting', 'R01']]);
    t.setClock(JULY_SUN_10H + DAY);
    expect((await t.suivi.run()).outcomes.map((o) => o.status)).toEqual(['sent']);
    const job = valueTrackingJob(t.db, t.journal, { now: t.now });
    expect(job.hours.every((h) => h >= 9 && h <= 18)).toBe(true);
    expect(job.weekdays).toEqual([1, 2, 3, 4, 5, 6]);
    const p = new Planificateur(t.db, t.journal, [job], { now: t.now });
    t.setClock(JULY_SUN_10H);
    expect((await p.tick()).ran).toEqual([]);
  });

  it('[R02, R03, R04, R36] jamais à une personne exclue, arrêtée ou dont l’accord est retiré', async () => {
    const t = await setup();
    const stop = await t.owner('Stéphane');
    const out = await t.owner('Sofia');
    const gone = await t.owner('Wassim');
    for (const p of [stop, out, gone]) await t.enrol(p.id);
    await t.store.addExclusion({ networkId: t.network.id, personId: stop.id, reason: 'stop', channel: 'sms', notedAt: new Date(ENROL + DAY) });
    await t.store.addExclusion({ networkId: t.network.id, personId: out.id, reason: 'network_list', notedAt: new Date(ENROL + DAY) });
    await t.store.withdrawConsent(gone.consentId!, new Date(ENROL + DAY));
    t.setClock(JULY_TUE_10H);
    const { outcomes } = await t.suivi.run();
    expect(outcomes.map((o) => o.status)).toEqual(['refused', 'refused', 'refused']);
    expect(outcomes.every((o) => o.rule !== null)).toBe(true);
    expect(outcomes.find((o) => o.rule === 'R03')).toBeDefined();
    expect(await t.outbox()).toEqual([]);
  });

  it('sans fourchette de commune ce jour-là, rien n’est envoyé, et c’est noté', async () => {
    const t = await setup({ ok: false, reason: 'peu_de_ventes', next: 'appointment' });
    const lea = await t.owner('Léa');
    await t.enrol(lea.id);
    t.setClock(JULY_TUE_10H);
    expect((await t.suivi.run()).outcomes.map((o) => o.status)).toEqual(['no_data']);
    expect(await t.outbox()).toEqual([]);
  });

  it('une source indisponible pour l’heure ne fait pas perdre la période : l’envoi est repris au passage suivant', async () => {
    const t = await setup({ ok: false, reason: 'donnees_absentes', next: 'appointment' });
    const lea = await t.owner('Léa');
    await t.enrol(lea.id);
    t.setClock(JULY_TUE_10H);
    expect((await t.suivi.run()).outcomes.map((o) => o.status)).toEqual(['waiting']);
    t.setRange({ ok: true, value: RANGE });
    t.setClock(JULY_TUE_10H + 3_600_000);
    expect((await t.suivi.run()).outcomes.map((o) => [o.period, o.status])).toEqual([[1, 'sent']]);
    expect(await t.outbox()).toHaveLength(1);
  });

  it('seule une intention positive de vendre, sans négation, compte', () => {
    for (const yes of ['Je pense à vendre ma maison l’an prochain.', 'Nous envisageons de vendre.', 'On songe à vendre.', 'Je suis prête à vendre.', 'J’aimerais mettre ma maison en vente.']) expect(saysSellingIntent(yes)).toBe(true);
    for (const no of ['Je ne veux pas vendre.', 'Pas question de vendre ma maison.', 'Je ne pense pas vendre avant 10 ans.', 'Je ne vends jamais.', 'Merci pour les chiffres.', 'Mon voisin pense à vendre.', 'Mon voisin est prêt à vendre.', 'Je veux acheter.']) expect(saysSellingIntent(no)).toBe(false);
  });

  it('une réponse « je pense à vendre » alerte l’agent une fois, et le plan du jour le porte en tête des rendez-vous à proposer', async () => {
    const t = await setup();
    const lea = await t.owner('Léa');
    const noe = await t.owner('Noé');
    await t.store.createProject({ networkId: t.network.id, agentId: t.alex.id, personId: noe.id, kind: 'valuation', stage: 'recue' });
    await t.enrol(lea.id);
    t.setClock(JULY_TUE_10H);
    await t.suivi.run();
    // Une réponse sans intention de vendre ne déclenche rien.
    for (const [i, body] of [
      'Merci pour ces chiffres.',
      'Merci, mais je ne veux pas vendre ma maison.',
      'Pas question de vendre ma maison pour le moment.',
      'Je ne pense pas vendre ma maison avant 10 ans.',
      'Je pense à vendre, mais pas maintenant.',
    ].entries()) {
      await t.store.recordMessage({ networkId: t.network.id, personId: lea.id, channel: 'email', direction: 'in', authorKind: 'person', body, occurredAt: new Date(JULY_TUE_10H + 3_600_000 + i * 1000) });
    }
    t.setClock(JULY_TUE_10H + 2 * 3_600_000);
    expect(await t.suivi.readAnswers()).toBe(0);
    await t.store.recordMessage({ networkId: t.network.id, personId: lea.id, channel: 'email', direction: 'in', authorKind: 'person', body: 'Merci, je pense à vendre ma maison l’an prochain.', occurredAt: new Date(JULY_TUE_10H + 3 * 3_600_000) });
    t.setClock(JULY_TUE_10H + 4 * 3_600_000);
    expect(await t.suivi.readAnswers()).toBe(1);
    expect(await t.suivi.readAnswers()).toBe(0);
    const entries = await t.journal.all();
    expect(entries.filter((e) => e.type === 'suivi_valeur.alerte')).toHaveLength(1);
    expect(JSON.stringify(entries)).not.toContain('pense à vendre');

    const plan = await new PlanDuJour(t.db, t.fiche, { now: t.now }).compute(t.acces, t.me);
    expect(plan.ok && plan.value.items.map((i) => [i.personId, i.kind])).toEqual([
      [lea.id, 'appointment'],
      [noe.id, 'appointment'],
    ]);
    expect(plan.ok && plan.value.items[0]!.reason).toBe('A répondu au suivi de valeur qu’il pense à vendre : rendez-vous à proposer.');
    expect(plan.ok && plan.value.items[0]!.order).toContain('2. pense à vendre, réponse au suivi de valeur');
  });
});
