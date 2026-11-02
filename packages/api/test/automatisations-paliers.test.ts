import { expect, it } from 'vitest';
import { FicheClient, PaliersBascule, ROLLOUT_MIN_REQUESTS, SqlJournalStore, applyMigrations, rolloutBucket, verifyChain, type SqlDatabase } from '@aimmo/core';
import { handleRequest, sha256Hex } from '../src/index.ts';
import { fromD1 } from '../src/d1.ts';
import { loadMigrations } from '../../core/test/migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from '../../core/test/sqlite.ts';
import { fakeD1 } from './fake-d1.ts';

// Clés inventées pour les tests, jamais utilisées ailleurs.
const KEY_AUTO = 'test-cle-paliers-site-iiiiiiiiiiiiiiiiiiiiiiiiiiiiii';
const KEY_DIRECTION = 'test-cle-paliers-direction-jjjjjjjjjjjjjjjjjjjjjjjj';
const KEY_AGENT = 'test-cle-paliers-agent-kkkkkkkkkkkkkkkkkkkkkkkkkkkkk';
const KEY_COMPLIANCE = 'test-cle-paliers-conformite-llllllllllllllllllllll';
const BASE = 'https://aimmo-api.example.workers.dev/v1/automatisations';
const DAY = 86_400_000;
// Novembre 2026, Paris à UTC+1 : un mardi à 10 h.
const START = Date.parse('2026-11-03T09:00:00.000Z');
const LONG_AGO = new Date('2026-01-01T00:00:00.000Z');
const EMAIL = 'lea.exemple@example.test';
const TEXT = 'Bonjour Léa, je vous rappelle notre rendez-vous de demain à 14 h pour l’estimation de votre bien.';

interface Answer {
  ok: boolean;
  code?: string;
  rule?: string;
  sent?: boolean;
  data?: { status?: string; rule?: string | null; stage?: string; decides?: boolean } & Record<string, unknown>;
}

async function world() {
  const db: SqlDatabase = fromD1(fakeD1(openMemoryDatabase()));
  await applyMigrations(db, loadMigrations());
  const fiches = new FicheClient(db);
  const network = await fiches.createNetwork('Réseau test');
  const agent = await fiches.createAgent({ networkId: network.id, firstName: 'Paul', lastName: 'Essai' });
  const person = await fiches.createPerson({ networkId: network.id, agentId: agent.id, firstName: 'Léa', lastName: 'Exemple' });
  await fiches.addIdentifier({ networkId: network.id, personId: person.id, kind: 'email', value: EMAIL });
  await fiches.addConsent({ networkId: network.id, personId: person.id, purpose: 'valuation_follow_up', channel: 'email', proof: 'formulaire test', givenAt: LONG_AGO });
  let clock = START;
  const now = (): Date => new Date(clock);
  const config = {
    db,
    mode: 'essai',
    now,
    intakeKeys: JSON.stringify([{ sha256: await sha256Hex(KEY_AUTO), networkId: network.id, source: 'site_auto' }]),
    apiKeys: JSON.stringify([
      { sha256: await sha256Hex(KEY_DIRECTION), role: 'direction', userId: 'direction-test', networkId: network.id },
      { sha256: await sha256Hex(KEY_COMPLIANCE), role: 'compliance', userId: 'conformite-test', networkId: network.id },
      { sha256: await sha256Hex(KEY_AGENT), role: 'agent', userId: agent.id, networkId: network.id },
    ]),
  };
  const http = async (path: string, key: string, body?: unknown) => {
    const res = await handleRequest(
      new Request(`${BASE}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
      config,
    );
    return { status: res.status, body: (await res.json()) as Answer };
  };
  /** Une demande permise : chaque référence est un nouvel envoi. */
  let seq = 0;
  const send = (ref = `visite-${++seq}`, over: Record<string, unknown> = {}) => http('/envoi', KEY_AUTO, { automation: 'rappel_visite', email: EMAIL, ref, text: TEXT, figures: [14], ...over });
  const advance = (key = KEY_DIRECTION, automation = 'rappel_visite') => http(`/paliers/${automation}/avancer`, key, {});
  const incident = (body: Record<string, unknown>, key = KEY_AUTO) => http('/incident', key, body);
  const paliers = new PaliersBascule(db, new SqlJournalStore(db), { now });
  /** Compte n demandes sans passer par le contrôle : la pression commerciale n'est pas le sujet ici. */
  const count = async (n: number) => {
    const { stageSince } = await paliers.decide(network.id, 'rappel_visite', 'compte');
    for (let i = 0; i < n; i++) await paliers.countRequest(network.id, 'rappel_visite', stageSince);
  };
  const toTenPercent = async () => {
    await count(ROLLOUT_MIN_REQUESTS);
    clock += 7 * DAY;
    const r = await advance();
    expect(r.body).toMatchObject({ ok: true, data: { stage: 'ten_percent' } });
  };
  return {
    db,
    network,
    config,
    paliers,
    send,
    advance,
    incident,
    http,
    count,
    toTenPercent,
    journal: new SqlJournalStore(db),
    outbox: async () => (await db.all<{ message_id: string }>('SELECT message_id FROM trial_outbox')).length,
    forward: (days: number) => {
      clock += days * DAY;
    },
  };
}

/** Une référence dont le rang tombe dans les 10 % tirés, ou hors d'eux. */
async function refIn(drawn: boolean, automation = 'rappel_visite'): Promise<string> {
  for (let i = 0; ; i++) {
    const ref = `tirage-${i}`;
    if ((await rolloutBucket(automation, ref)) < 10 === drawn) return ref;
  }
}

it('[R26] le tirage est fixe par envoi, et tombe sur environ un envoi sur dix', async () => {
  expect(await rolloutBucket('rappel_visite', 'visite-12')).toBe(await rolloutBucket('rappel_visite', 'visite-12'));
  let drawn = 0;
  for (let i = 0; i < 2000; i++) {
    const bucket = await rolloutBucket('rappel_visite', `visite-${i}`);
    expect(bucket).toBeGreaterThanOrEqual(0);
    expect(bucket).toBeLessThan(100);
    if (bucket < 10) drawn++;
  }
  expect(drawn).toBeGreaterThan(150);
  expect(drawn).toBeLessThan(250);
});

describeWithSqlite('B04a · paliers de la bascule des automatisations', () => {
  it('[R26] en ombre, la décision du socle ne vaut jamais et rien ne part', async () => {
    const w = await world();
    const r = await w.send(await refIn(true));
    expect(r.body).toMatchObject({ ok: true, sent: false, data: { status: 'would_send', stage: 'shadow', decides: false } });
  });

  it('[R26] l’ombre ne se quitte pas d’elle-même, même après 7 jours et assez de demandes', async () => {
    const w = await world();
    await w.count(ROLLOUT_MIN_REQUESTS);
    w.forward(30);
    expect((await w.send(await refIn(true))).body.data).toMatchObject({ stage: 'shadow', decides: false });
  });

  it('[R26] passer à 10 % est refusé avant 7 jours, ou faute de demandes', async () => {
    const w = await world();
    await w.count(ROLLOUT_MIN_REQUESTS);
    w.forward(6);
    expect((await w.advance()).body).toMatchObject({ ok: false, rule: 'R26', code: 'too_early' });

    const v = await world();
    await v.count(ROLLOUT_MIN_REQUESTS - 1);
    v.forward(8);
    const r = await v.advance();
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ ok: false, rule: 'R26', code: 'not_enough_requests' });
  });

  it('[R16] seule la direction fait avancer ; le site n’a pas cette route', async () => {
    const w = await world();
    await w.count(ROLLOUT_MIN_REQUESTS);
    w.forward(8);
    expect((await w.advance(KEY_AGENT)).status).toBe(403);
    expect((await w.advance(KEY_COMPLIANCE)).status).toBe(403);
    expect((await w.advance(KEY_AUTO)).status).toBe(401);
    expect((await w.advance(KEY_DIRECTION, 'inconnue')).status).toBe(404);
    const refused = (await w.journal.all()).filter((e) => e.type === 'acces.refuse');
    expect(refused.length).toBeGreaterThanOrEqual(2);
  });

  it('[R26] à 10 %, la décision ne vaut que pour les envois tirés, et toujours pour le même envoi', async () => {
    const w = await world();
    await w.toTenPercent();
    const drawn = await w.send(await refIn(true));
    expect(drawn.body.data).toMatchObject({ stage: 'ten_percent', decides: true });
    expect(drawn.body.sent).toBe(false);
    const other = await refIn(false);
    expect((await w.send(other)).body.data).toMatchObject({ stage: 'ten_percent', decides: false });
    // Le même envoi redemandé garde son tirage ; il est refusé comme doublon [R05].
    expect((await w.send(other)).body.data).toMatchObject({ rule: 'R05', decides: false });
  });

  it('[R26] 10 % passe partout après 7 jours avec assez de demandes, pas avant, et sans geste', async () => {
    const w = await world();
    await w.toTenPercent();
    w.forward(6);
    await w.count(ROLLOUT_MIN_REQUESTS);
    expect((await w.send(await refIn(false))).body.data).toMatchObject({ stage: 'ten_percent', decides: false });
    w.forward(1);
    const r = await w.send(await refIn(false));
    expect(r.body.data).toMatchObject({ stage: 'everywhere', decides: true });
    expect(r.body.sent).toBe(false);
    const moves = (await w.journal.all()).filter((e) => e.type === 'bascule.palier');
    expect(moves.map((e) => e.data)).toEqual([
      { automation: 'rappel_visite', from: 'shadow', to: 'ten_percent' },
      { automation: 'rappel_visite', from: 'ten_percent', to: 'everywhere' },
    ]);
  });

  it('[R26] 10 % reste à 10 % faute de demandes, même après 7 jours', async () => {
    const w = await world();
    await w.toTenPercent();
    w.forward(20);
    expect((await w.send(await refIn(false))).body.data).toMatchObject({ stage: 'ten_percent' });
  });

  it('[R05] une demande refaite pour le même envoi ne compte pas deux fois', async () => {
    const w = await world();
    const ref = await refIn(false);
    await w.send(ref);
    await w.send(ref);
    const list = await w.http('/paliers', KEY_DIRECTION);
    expect((list.body.data as unknown as { requests: number; automation: string }[]).find((p) => p.automation === 'rappel_visite')!.requests).toBe(1);
  });

  it('[R26] un écart non expliqué ramène en ombre, et les 7 jours repartent', async () => {
    const w = await world();
    await w.toTenPercent();
    const r = await w.incident({ automation: 'rappel_visite', kind: 'unexplained_gap', rule: 'R03' });
    expect(r.body).toMatchObject({ ok: true, data: { stage: 'shadow' } });
    expect((await w.send(await refIn(true))).body.data).toMatchObject({ stage: 'shadow', decides: false });
    // Il faut de nouveau tenir 7 jours.
    await w.count(ROLLOUT_MIN_REQUESTS);
    expect((await w.advance()).body).toMatchObject({ ok: false, code: 'too_early' });
    w.forward(7);
    expect((await w.advance()).body).toMatchObject({ ok: true });
  });

  it('[R26] le retour arrière vaut depuis partout, et une panne signalée par le site aussi', async () => {
    const w = await world();
    await w.toTenPercent();
    await w.count(ROLLOUT_MIN_REQUESTS);
    w.forward(7);
    expect((await w.send(await refIn(false))).body.data).toMatchObject({ stage: 'everywhere' });
    expect((await w.incident({ automation: 'rappel_visite', kind: 'failure' })).body.data).toMatchObject({ stage: 'shadow' });
    expect((await w.journal.all()).filter((e) => e.type === 'bascule.retour_arriere').map((e) => e.data)).toEqual([
      { automation: 'rappel_visite', from: 'everywhere', to: 'shadow', kind: 'failure', rule: null },
    ]);
  });

  it('[R26] un incident ne touche que son automatisation', async () => {
    const w = await world();
    await w.toTenPercent();
    await w.incident({ automation: 'courrier_vendeur', kind: 'failure' });
    expect((await w.send(await refIn(true))).body.data).toMatchObject({ stage: 'ten_percent' });
  });

  it('[R26] une panne du socle pendant une demande ramène en ombre', async () => {
    const w = await world();
    await w.toTenPercent();
    // La table du mode essai manque : le contrôle tombe en panne au moment de ranger le message.
    await w.db.exec('ALTER TABLE trial_outbox RENAME TO trial_outbox_hors_service');
    const ref = await refIn(true);
    const r = await w.send(ref);
    expect(r.status === 500 || r.body.data?.status === 'failed').toBe(true);
    if (r.status === 200) expect(r.body.data).toMatchObject({ stage: 'shadow', decides: false });
    await w.db.exec('ALTER TABLE trial_outbox_hors_service RENAME TO trial_outbox');
    expect((await w.send(`${ref}-apres`)).body.data?.stage).toBe('shadow');
    expect((await w.journal.all()).filter((e) => e.type === 'bascule.retour_arriere')).toHaveLength(1);
  });

  it('[R26] un retour en ombre simultané l’emporte sur un passage à partout', async () => {
    const w = await world();
    await w.toTenPercent();
    await w.count(ROLLOUT_MIN_REQUESTS);
    w.forward(7);
    await w.paliers.incident(w.network.id, 'rappel_visite', 'failure', null, 'system:bascule');
    expect((await w.paliers.decide(w.network.id, 'rappel_visite', 'a')).stage).toBe('shadow');
  });

  it('[R26] sans fiche unique, le socle ne décide pas à la place du site', async () => {
    const w = await world();
    await w.toTenPercent();
    const r = await w.send(await refIn(true), { email: 'inconnue@example.test' });
    expect(r.body.data).toMatchObject({ code: 'unknown_person', stage: 'ten_percent', decides: false });
  });

  it('[R13] un incident n’admet ni champ de plus ni règle mal formée, et rien de personnel au journal', async () => {
    const w = await world();
    expect((await w.incident({ automation: 'rappel_visite', kind: 'failure', email: EMAIL })).body).toMatchObject({ ok: false, code: 'unexpected_field' });
    expect((await w.incident({ automation: 'rappel_visite', kind: 'failure', rule: EMAIL })).body).toMatchObject({ ok: false, code: 'invalid_rule' });
    expect((await w.incident({ automation: 'rappel_visite', kind: 'autre' })).body).toMatchObject({ ok: false, code: 'invalid_kind' });
    expect((await w.incident({ automation: 'inconnue', kind: 'failure' })).body).toMatchObject({ ok: false, code: 'invalid_automation' });
    expect((await w.incident({ automation: 'rappel_visite', kind: 'failure' }, 'mauvaise-cle')).status).toBe(401);
    const ref = await refIn(true);
    await w.send(ref);
    const text = JSON.stringify((await w.journal.all()).map((e) => e.data));
    expect(text).not.toContain(EMAIL);
    expect(text).not.toContain(ref);
    expect(text).not.toContain('Léa');
    expect((await verifyChain(await w.journal.all())).ok).toBe(true);
  });

  it('[R16] le tableau des paliers : direction et conformité, des nombres et des dates', async () => {
    const w = await world();
    await w.send();
    const list = await w.http('/paliers', KEY_COMPLIANCE);
    expect(list.status).toBe(200);
    expect(list.body.data).toEqual([
      { automation: 'rappel_visite', stage: 'shadow', since: expect.any(String), requests: 1, daysLeft: 7, lastIncidentAt: null, lastIncidentKind: null },
      { automation: 'courrier_vendeur', stage: 'shadow', since: null, requests: 0, daysLeft: 7, lastIncidentAt: null, lastIncidentKind: null },
    ]);
    expect((await w.http('/paliers', KEY_AGENT)).status).toBe(403);
    expect((await w.http('/paliers', KEY_AUTO)).status).toBe(401);
  });

  it('[R26] à aucun palier le socle ne fait partir un message : tout reste dans la boîte du mode essai', async () => {
    const w = await world();
    await w.toTenPercent();
    await w.count(ROLLOUT_MIN_REQUESTS);
    w.forward(7);
    const r = await w.send(await refIn(true));
    expect(r.body).toMatchObject({ sent: false, data: { stage: 'everywhere', decides: true, status: 'would_send' } });
    expect(await w.outbox()).toBe(1);
    expect((await w.journal.all()).filter((e) => e.type === 'envoi.essai').at(-1)!.data).toMatchObject({ mode: 'essai', sent: false });
  });
});
