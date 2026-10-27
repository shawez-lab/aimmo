import { expect, it } from 'vitest';
import { DecisionEnvoi, FicheClient, FicheUnique, SqlJournalStore, applyMigrations, verifyChain, type SqlDatabase } from '@aimmo/core';
import { handleRequest, sha256Hex } from '../src/index.ts';
import { fromD1 } from '../src/d1.ts';
import { loadMigrations } from '../../core/test/migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from '../../core/test/sqlite.ts';
import { fakeD1 } from './fake-d1.ts';

// Clés inventées pour les tests, jamais utilisées ailleurs.
const KEY_AUTO = 'test-cle-automatisations-ffffffffffffffffffffff';
const KEY_FORM = 'test-cle-formulaire-gggggggggggggggggggggggggggg';
const KEY_AGENT = 'test-cle-agent-hhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhh';
const BASE = 'https://aimmo-api.example.workers.dev';
const URL_AUTO = `${BASE}/v1/automatisations/envoi`;
// Novembre 2026, Paris à UTC+1 : un mardi à 10 h, un dimanche à 23 h.
const TUESDAY_10H = Date.parse('2026-11-10T09:00:00.000Z');
const SUNDAY_23H = Date.parse('2026-11-08T22:00:00.000Z');
const LONG_AGO = new Date('2026-01-01T00:00:00.000Z');

const EMAIL = 'lea.exemple@example.test';
const TEXT = 'Bonjour Léa, je vous rappelle notre rendez-vous de demain à 14 h pour l’estimation de votre bien.';

async function world() {
  const db: SqlDatabase = fromD1(fakeD1(openMemoryDatabase()));
  await applyMigrations(db, loadMigrations());
  const fiches = new FicheClient(db);
  const network = await fiches.createNetwork('Réseau test');
  const agent = await fiches.createAgent({ networkId: network.id, firstName: 'Paul', lastName: 'Essai' });
  const person = await fiches.createPerson({ networkId: network.id, agentId: agent.id, firstName: 'Léa', lastName: 'Exemple' });
  await fiches.addIdentifier({ networkId: network.id, personId: person.id, kind: 'email', value: EMAIL });
  await fiches.addConsent({ networkId: network.id, personId: person.id, purpose: 'valuation_follow_up', channel: 'email', proof: 'formulaire test', givenAt: LONG_AGO });
  let clock = TUESDAY_10H;
  const now = (): Date => new Date(clock);
  const intakeKeys = JSON.stringify([
    { sha256: await sha256Hex(KEY_AUTO), networkId: network.id, source: 'site_auto' },
    { sha256: await sha256Hex(KEY_FORM), networkId: network.id, source: 'site_form' },
  ]);
  const apiKeys = JSON.stringify([{ sha256: await sha256Hex(KEY_AGENT), role: 'agent', userId: agent.id, networkId: network.id }]);
  const config = { db, mode: 'essai', apiKeys, intakeKeys, now };
  const call = async (body: unknown, opts: { key?: string; method?: string; config?: typeof config } = {}) => {
    const res = await handleRequest(
      new Request(URL_AUTO, {
        method: opts.method ?? 'POST',
        headers: { authorization: `Bearer ${opts.key ?? KEY_AUTO}`, 'content-type': 'application/json' },
        ...((opts.method ?? 'POST') === 'POST' ? { body: JSON.stringify(body) } : {}),
      }),
      opts.config ?? config,
    );
    return { status: res.status, body: (await res.json()) as { ok: boolean; sent?: boolean; code?: string; data?: { status: string; rule: string | null; code: string | null } } };
  };
  const order = (over: Record<string, unknown> = {}) => ({ automation: 'rappel_visite', email: EMAIL, ref: 'visite-12', text: TEXT, figures: [14], ...over });
  const outbox = async () => (await db.all<{ message_id: string }>('SELECT message_id FROM trial_outbox')).length;
  return {
    db,
    fiches,
    network,
    agent,
    person,
    config,
    call,
    order,
    outbox,
    journal: new SqlJournalStore(db),
    setClock: (t: number) => {
      clock = t;
    },
  };
}

describeWithSqlite('B01 · demande d’envoi d’une automatisation du site, en mode essai', () => {
  it('[R26] un envoi permis est décidé, rangé dans la boîte du mode essai, et rien ne part', async () => {
    const w = await world();
    const r = await w.call(w.order());
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, sent: false, data: { status: 'would_send', rule: null, code: null } });
    expect(await w.outbox()).toBe(1);
    const entries = await w.journal.all();
    const essai = entries.filter((e) => e.type === 'envoi.essai');
    expect(essai).toHaveLength(1);
    expect(essai[0]!.data).toMatchObject({ mode: 'essai', sent: false, channel: 'email' });
    // La décision est rendue pour le courrier au vendeur aussi.
    const r2 = await w.call(w.order({ automation: 'courrier_vendeur', ref: 'courrier-7', text: 'Bonjour Léa, votre avis de valeur est prêt dans votre espace.', figures: [] }));
    expect(r2.body.data).toMatchObject({ status: 'would_send' });
    expect(await w.outbox()).toBe(2);
  });

  it('[R05] la même automatisation pour la même référence ne part qu’une fois', async () => {
    const w = await world();
    expect((await w.call(w.order())).body.data).toMatchObject({ status: 'would_send' });
    expect((await w.call(w.order())).body.data).toMatchObject({ status: 'refused', rule: 'R05' });
    expect(await w.outbox()).toBe(1);
  });

  it('[R01] la nuit et le dimanche, refusé avec sa règle', async () => {
    const w = await world();
    w.setClock(SUNDAY_23H);
    expect((await w.call(w.order())).body.data).toMatchObject({ status: 'refused', rule: 'R01' });
    expect(await w.outbox()).toBe(0);
  });

  it('[R02] [R04] une personne exclue ou qui a demandé l’arrêt est refusée', async () => {
    const w = await world();
    await w.fiches.addExclusion({ networkId: w.network.id, personId: w.person.id, reason: 'network_list', notedAt: LONG_AGO });
    expect((await w.call(w.order())).body.data).toMatchObject({ status: 'refused', rule: 'R02' });

    const v = await world();
    const unique = new FicheUnique(v.db, v.fiches);
    await new DecisionEnvoi(v.db, v.fiches, unique).recordStopRequest({ networkId: v.network.id, personId: v.person.id, at: LONG_AGO });
    expect((await v.call(v.order())).body.data).toMatchObject({ status: 'refused', rule: 'R04' });
    expect(await w.outbox()).toBe(0);
    expect(await v.outbox()).toBe(0);
  });

  it('[R03] sans accord pour le suivi de l’estimation, refusé', async () => {
    const w = await world();
    const other = await w.fiches.createPerson({ networkId: w.network.id, agentId: w.agent.id, firstName: 'Jules', lastName: 'Essai' });
    await w.fiches.addIdentifier({ networkId: w.network.id, personId: other.id, kind: 'email', value: 'jules.essai@example.test' });
    const r = await w.call(w.order({ email: 'jules.essai@example.test', text: 'Bonjour Jules, je vous rappelle notre rendez-vous de demain à 14 h.' }));
    expect(r.body.data).toMatchObject({ status: 'refused', rule: 'R03' });
  });

  it('[R09] [R10] le texte du site passe le contrôle du texte', async () => {
    const w = await world();
    const address = await w.call(w.order({ text: 'Bonjour Léa, rendez-vous demain à 14 h au 12 rue des Tilleuls.' }));
    expect(address.body.data).toMatchObject({ status: 'refused', rule: 'R09' });
    const figure = await w.call(w.order({ ref: 'visite-13', figures: [] }));
    expect(figure.body.data).toMatchObject({ status: 'refused', rule: 'R10' });
    expect(await w.outbox()).toBe(0);
  });

  it('une adresse inconnue ou portée par deux fiches : refusée, sans rien créer', async () => {
    const w = await world();
    const before = (await w.db.all('SELECT id FROM persons')).length;
    expect((await w.call(w.order({ email: 'inconnu@example.test' }))).body.data).toMatchObject({ status: 'refused', rule: null, code: 'unknown_person' });
    expect((await w.db.all('SELECT id FROM persons')).length).toBe(before);

    const twin = await w.fiches.createPerson({ networkId: w.network.id, agentId: w.agent.id, firstName: 'Léa', lastName: 'Double' });
    await w.fiches.addIdentifier({ networkId: w.network.id, personId: twin.id, kind: 'email', value: EMAIL });
    expect((await w.call(w.order())).body.data).toMatchObject({ status: 'refused', code: 'ambiguous_person' });
    expect(await w.outbox()).toBe(0);
  });

  it('[R13] le journal ne porte ni adresse, ni texte, ni référence, et sa chaîne tient', async () => {
    const w = await world();
    await w.call(w.order());
    await w.call(w.order({ email: 'inconnu@example.test', ref: 'visite-99' }));
    w.setClock(SUNDAY_23H);
    await w.call(w.order({ ref: 'visite-14' }));
    const entries = await w.journal.all();
    const asked = entries.filter((e) => e.type === 'bascule.demande.essai');
    expect(asked.map((e) => [e.data.status, e.data.rule, e.data.code])).toEqual([
      ['would_send', null, null],
      ['refused', null, 'unknown_person'],
      ['refused', 'R01', null],
    ]);
    const dump = JSON.stringify(entries);
    for (const secret of [EMAIL, 'inconnu@example.test', 'visite-12', 'visite-99', 'visite-14', 'Tilleuls', 'rendez-vous']) expect(dump).not.toContain(secret);
    expect((await verifyChain(entries)).ok).toBe(true);
  });

  it('seule une clé `site_auto` est admise, en POST, et sans clé configurée tout est fermé', async () => {
    const w = await world();
    expect((await w.call(w.order(), { key: KEY_FORM })).status).toBe(401);
    expect((await w.call(w.order(), { key: KEY_AGENT })).status).toBe(401);
    expect((await w.call(w.order(), { key: 'courte' })).status).toBe(401);
    expect((await w.call(undefined, { method: 'GET' })).status).toBe(405);
    expect((await w.call(w.order(), { config: { ...w.config, intakeKeys: undefined as unknown as string } })).status).toBe(503);
    expect((await w.call(w.order(), { config: { ...w.config, mode: 'reel' } })).status).toBe(503);
    expect(await w.outbox()).toBe(0);
  });

  it('une demande mal formée est refusée avant toute lecture', async () => {
    const w = await world();
    const bad = [
      { automation: 'alerte_inconnue' },
      { email: 'pas-une-adresse' },
      { ref: 'visite 12' },
      { ref: 'x'.repeat(65) },
      { text: '' },
      { text: 'a'.repeat(4001) },
      { figures: 'quatorze' },
      { figures: [{}] },
    ];
    for (const over of bad) expect((await w.call(w.order(over))).status, JSON.stringify(over).slice(0, 40)).toBe(400);
    expect(await w.outbox()).toBe(0);
    expect((await w.journal.all()).filter((e) => e.type === 'bascule.demande.essai')).toHaveLength(0);
  });
});
