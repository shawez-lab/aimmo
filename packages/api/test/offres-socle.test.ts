import { expect, it } from 'vitest';
import { verifyChain } from '@aimmo/core';
import { handleRequest } from '../src/app.ts';
import { sha256Hex } from '../src/index.ts';
import { runScheduler } from '../src/planificateur.ts';
import { setupOffre } from '../../core/test/offres-jeu.ts';
import { describeWithSqlite } from '../../core/test/sqlite.ts';

// Réseau, bien, acquéreur, offre et clés inventés.
const BASE = 'https://aimmo-api.example.test';
const KEYS = { alex: 'test-cle-o09-alex-aaaaaaaaaaaaaaaaaaaaaaaaaaaaa', compliance: 'test-cle-o09-conformite-cccccccccccccccccccccc' };
type Who = keyof typeof KEYS;

async function setup() {
  const t = await setupOffre();
  const ids: Record<Who, { role: string; userId: string }> = { alex: { role: 'agent', userId: t.alexId }, compliance: { role: 'compliance', userId: 'c-1' } };
  const apiKeys = JSON.stringify(await Promise.all((Object.keys(KEYS) as Who[]).map(async (w) => ({ sha256: await sha256Hex(KEYS[w]), networkId: t.network.id, ...ids[w] }))));
  const call = async (who: Who | null, method: string, path: string, body?: unknown) => {
    const headers: Record<string, string> = who ? { authorization: `Bearer ${KEYS[who]}` } : {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    const r = await handleRequest(new Request(`${BASE}${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), { db: t.db, apiKeys, mode: 'essai', now: t.now });
    return { status: r.status, body: (await r.json()) as { ok: boolean; data?: any; rule?: string } };
  };
  return { ...t, call };
}

describeWithSqlite('O09 · branchement de M09 dans le socle', () => {
  it('[R16] les routes des offres répondent derrière la clé d’API ; un refus de droits va au journal', async () => {
    const t = await setup();
    const offer = await t.record();
    expect((await t.call(null, 'GET', `/v1/offres/biens/${t.propertyId}`)).status).toBe(401);
    const list = await t.call('alex', 'GET', `/v1/offres/biens/${t.propertyId}`);
    expect(list.status).toBe(200);
    expect(JSON.stringify(list.body.data)).toContain(offer.id);
    expect((await t.call('alex', 'GET', '/v1/offres/taches')).status).toBe(200);
    const before = (await t.journal.all()).filter((e) => e.type === 'acces.refuse').length;
    const refused = await t.call('compliance', 'POST', `/v1/offres/${offer.id}/transmission`, { via: 'telephone' });
    expect(refused.status).toBe(403);
    expect(refused.body).toMatchObject({ ok: false, rule: 'R16' });
    expect((await t.journal.all()).filter((e) => e.type === 'acces.refuse').length - before).toBe(1);
  });

  it('[R56, R59] le passage des offres tourne une fois par jour, à 6 h : offre non transmise signalée, tâche la veille de l’échéance ; rien ne part', async () => {
    const t = await setup();
    const offer = await t.record();
    const sent = async () => (await t.db.all('SELECT * FROM trial_outbox')).length;
    const outbox = await sent();
    // Le 9 mars, veille du dernier jour de l'offre : 6 h 00, 6 h 30 et 7 h 00 à Paris.
    for (const at of ['2027-03-09T05:00:00.000Z', '2027-03-09T05:30:00.000Z', '2027-03-09T06:00:00.000Z']) {
      t.setClock(new Date(at));
      await runScheduler({ db: t.db, mode: 'essai', now: t.now });
    }
    const runs = await t.db.all<{ slot: string; outcome: string }>("SELECT slot, outcome FROM scheduled_runs WHERE job = 'offres.quotidien'");
    expect(runs).toEqual([{ slot: '2027-03-09T06', outcome: 'ok' }]);
    const entries = await t.journal.all();
    expect(entries.filter((e) => e.type === 'offre.non_transmise' && e.subject === `offer:${offer.id}`)).toHaveLength(1);
    expect(entries.filter((e) => e.type === 'offre.echeance' && e.subject === `offer:${offer.id}`)).toHaveLength(1);
    expect(await sent()).toBe(outbox);
    // Le lendemain, un nouveau créneau ; hors mode essai, rien ne passe.
    t.setClock(new Date('2027-03-10T05:00:00.000Z'));
    expect(await runScheduler({ db: t.db, mode: 'reel', now: t.now })).toBeNull();
    await runScheduler({ db: t.db, mode: 'essai', now: t.now });
    expect((await t.db.all("SELECT slot FROM scheduled_runs WHERE job = 'offres.quotidien'")).length).toBe(2);
    expect((await verifyChain(await t.journal.all())).ok).toBe(true);
  });
});
