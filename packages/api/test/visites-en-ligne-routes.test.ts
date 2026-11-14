import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { RendezVous, verifyChain } from '@aimmo/core';
import { handleRequest } from '../src/app.ts';
import { m08Routes } from '../src/acquereurs.ts';
import { sha256Hex } from '../src/index.ts';
import { setupAnnonce } from '../../core/test/annonces-jeu.ts';
import { describeWithSqlite } from '../../core/test/sqlite.ts';

// BR64 · Tout est inventé : réseau, bien, acquéreur et clés de test.
const BASE = 'https://aimmo-api.example.test';
const KEYS = { alex: 'test-cle-br64-alex-aaaaaaaaaaaaaaaaaaaaaaaaaaaa', sam: 'test-cle-br64-sam-bbbbbbbbbbbbbbbbbbbbbbbbbbbbb', direction: 'test-cle-br64-direction-cccccccccccccccccccccc', compliance: 'test-cle-br64-conformite-dddddddddddddddddddd' };
type Who = keyof typeof KEYS;
const TUESDAY_10H = new Date('2027-03-02T09:00:00.000Z');
const WEDNESDAY_14H = new Date('2027-03-03T13:00:00.000Z');
const WEEK = { weekly: [1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, from: '09:00', to: '19:00' })) };
const TEMPLATE = 'Bon de visite : {{visiteur.nom}} visite {{bien.reference}} le {{visite.date}}.';

async function setup() {
  const t = await setupAnnonce();
  const ids: Record<Who, { role: string; userId: string; networkId: string }> = {
    alex: { role: 'agent', userId: t.alexId, networkId: t.network.id },
    sam: { role: 'agent', userId: t.sam.userId, networkId: t.network.id },
    direction: { role: 'direction', userId: 'direction-1', networkId: t.network.id },
    compliance: { role: 'compliance', userId: 'c-1', networkId: t.network.id },
  };
  const apiKeys = JSON.stringify(await Promise.all((Object.keys(KEYS) as Who[]).map(async (w) => ({ sha256: await sha256Hex(KEYS[w]), ...ids[w] }))));
  const call = async (who: Who, method: 'GET' | 'POST', path: string, body?: unknown) => {
    const init: RequestInit = { method, headers: { authorization: `Bearer ${KEYS[who]}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) } };
    if (body !== undefined) init.body = JSON.stringify(body);
    const r = await handleRequest(new Request(`${BASE}/v1${path}`, init), { db: t.db, apiKeys, mode: 'essai', now: t.now });
    return { status: r.status, body: (await r.json()) as { ok: boolean; data?: any; code?: string; rule?: string | null; message?: string } };
  };
  const buyer = await t.store.createPerson({ networkId: t.network.id, agentId: t.alexId, firstName: 'Inès', lastName: 'Durand' });
  const project = await t.store.createProject({ networkId: t.network.id, agentId: t.alexId, personId: buyer.id, kind: 'buy' });
  const rdv = new RendezVous(t.db, t.journal, { now: t.now });
  await rdv.setAvailability(ids.alex as never, WEEK);
  t.setClock(TUESDAY_10H);
  // Une visite prise depuis le site (V08) : un rendez-vous seul, sans visite ni bon.
  const online = async (start: Date = WEDNESDAY_14H) => {
    const r = await rdv.book({ networkId: t.network.id, agentId: t.alexId, personId: buyer.id, propertyId: t.propertyId, kind: 'visite', start, source: 'site', channel: null });
    if (!r.ok) throw new Error(r.code);
    return r.appointment;
  };
  return { ...t, call, buyer, project, online };
}

describeWithSqlite('BR64 · visites réservées en ligne : lecture et rattachement par les routes', () => {
  it('la fiche dit la visite en ligne qui attend ; rattachée, elle a son bon et n’attend plus ; une seconde fois : refusée [R40]', async () => {
    const t = await setup();
    const appt = await t.online();
    const list = await t.call('alex', 'GET', `/fiches/${t.buyer.id}/visites-en-ligne`);
    expect(list).toEqual({ status: 200, body: { ok: true, mode: 'essai', sent: false, data: [{ appointmentId: appt.id, start: appt.start_at, end: appt.end_at, source: 'site', property: { reference: 'REF-T-1', city: 'Dijon' } }] } });
    expect(JSON.stringify(list.body)).not.toMatch(/token|Durand/);
    // Sans modèle de bon : refusé, rien n'est rangé [R40].
    expect((await t.call('alex', 'POST', `/visites/${appt.id}/rattachement`, { projectId: t.project.id })).body).toMatchObject({ ok: false, rule: 'R40', code: 'no_template' });
    expect((await t.call('direction', 'POST', '/visites/modeles', { body: TEMPLATE })).status).toBe(200);
    const done = await t.call('alex', 'POST', `/visites/${appt.id}/rattachement`, { projectId: t.project.id });
    expect(done).toMatchObject({ status: 200, body: { ok: true, data: { appointmentId: appt.id, slip: { appointmentId: appt.id, mode: 'essai' } } } });
    expect(JSON.stringify(done.body)).not.toMatch(/token_hash/);
    expect((await t.call('alex', 'GET', `/visites/${appt.id}/bon`)).body).toMatchObject({ ok: true, data: { slip: { appointmentId: appt.id } } });
    expect((await t.call('alex', 'GET', `/fiches/${t.buyer.id}/visites-en-ligne`)).body.data).toEqual([]);
    expect(await t.call('alex', 'POST', `/visites/${appt.id}/rattachement`, { projectId: t.project.id })).toMatchObject({ status: 409, body: { ok: false, rule: null, code: 'already_attached' } });
    expect(await t.db.all('SELECT appointment_id FROM visits')).toEqual([{ appointment_id: appt.id }]);
    // Rien n'est envoyé par le rattachement.
    expect(await t.db.all("SELECT id FROM messages WHERE direction = 'out' AND person_id = ?", [t.buyer.id])).toEqual([]);
    expect((await verifyChain(await t.journal.all())).ok).toBe(true);
  });

  it('un agent qui ne suit pas la fiche, ou la conformité, est refusé, et le refus va au journal [R16] ; un inconnu : 404', async () => {
    const t = await setup();
    const appt = await t.online();
    await t.call('direction', 'POST', '/visites/modeles', { body: TEMPLATE });
    expect(await t.call('sam', 'GET', `/fiches/${t.buyer.id}/visites-en-ligne`)).toMatchObject({ status: 403, body: { ok: false, rule: 'R16' } });
    expect(await t.call('compliance', 'GET', `/fiches/${t.buyer.id}/visites-en-ligne`)).toMatchObject({ status: 403, body: { ok: false, rule: 'R16', code: 'role' } });
    expect(await t.call('sam', 'POST', `/visites/${appt.id}/rattachement`, { projectId: t.project.id })).toMatchObject({ status: 403, body: { ok: false, rule: 'R16' } });
    expect((await t.call('alex', 'GET', '/fiches/inconnue/visites-en-ligne')).status).toBe(404);
    const refusals = (await t.journal.all()).filter((e) => e.actor === `agent:${t.sam.userId}` || e.actor === 'compliance:c-1');
    expect(refusals.length).toBeGreaterThanOrEqual(3);
    expect(await t.db.all('SELECT * FROM visits')).toEqual([]);
    // La direction rattache.
    expect((await t.call('direction', 'POST', `/visites/${appt.id}/rattachement`, { projectId: t.project.id })).status).toBe(200);
  });

  it('un bien que la diffusion refuse : refusé [R42] ; une saisie mal formée : 400, rien d’écrit', async () => {
    const t = await setup();
    // Pendant le délai de rétractation du mandat signé hors de l'agence, le bien ne se diffuse pas.
    t.setClock(new Date('2027-02-11T09:00:00.000Z'));
    const appt = await t.online(new Date('2027-02-12T13:00:00.000Z'));
    await t.call('direction', 'POST', '/visites/modeles', { body: TEMPLATE });
    expect(await t.call('alex', 'POST', `/visites/${appt.id}/rattachement`, { projectId: t.project.id })).toMatchObject({ status: 409, body: { ok: false, rule: 'R42' } });
    expect((await t.call('alex', 'POST', `/visites/${appt.id}/rattachement`, { projectId: 'x y' })).body).toMatchObject({ ok: false, code: 'invalid_project' });
    expect((await t.call('alex', 'POST', `/visites/${appt.id}/rattachement`, { projectId: t.project.id, start: 'demain' })).status).toBe(400);
    expect((await t.call('alex', 'GET', `/fiches/${t.buyer.id}/visites-en-ligne?tout=1`)).body).toMatchObject({ ok: false, code: 'unexpected_field' });
    expect(await t.db.all('SELECT * FROM visits')).toEqual([]);
  });

  it('docs/API.md décrit les deux routes', () => {
    const doc = readFileSync(new URL('../../../docs/API.md', import.meta.url), 'utf8');
    expect(doc).toContain('`/v1/fiches/<id>/visites-en-ligne`');
    expect(doc).toContain('`/v1/visites/<rendez-vous>/rattachement`');
    const names = m08Routes().map((r) => r.name);
    expect(names).toContain('visites.en_ligne');
    expect(names).toContain('visites.rattachement');
  });
});
