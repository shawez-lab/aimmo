import { expect, it } from 'vitest';
import { FicheClient, SqlJournalStore, applyMigrations, reseau, type SqlDatabase } from '@aimmo/core';
import { OPEN_WITHOUT_AGENT_FILE, handleRequest, type ApiConfig } from '../src/app.ts';
import { sha256Hex } from '../src/index.ts';
import { R2AgentPieceStore, reseauRoutes } from '../src/reseau.ts';
import { formationRoutes } from '../src/formation.ts';
import { clesRoutes } from '../src/cles.ts';
import { fromD1 } from '../src/d1.ts';
import worker, { type Env } from '../src/worker.ts';
import { loadMigrations } from '../../core/test/migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from '../../core/test/sqlite.ts';
import { fakeD1 } from './fake-d1.ts';

// Réseau, agents, clients, pièces et clés inventés. Hiver : Paris = UTC + 1.
const BASE = 'https://aimmo-api.example.test';
const KEYS = { alex: 'test-cle-j13-alex-aaaaaaaaaaaaaaaaaaaaaaaaaaaa', sam: 'test-cle-j13-sam-bbbbbbbbbbbbbbbbbbbbbbbbbbbbb', direction: 'test-cle-j13-direction-cccccccccccccccccccccc' };
type Who = keyof typeof KEYS;
let n = 0;
const uuid = (): string => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;

/** Un faux compartiment R2 : des clés, et le texte rangé. */
class FakeBucket {
  readonly objects = new Map<string, string | Uint8Array>();
  async head(key: string): Promise<unknown | null> {
    return this.objects.has(key) ? { key } : null;
  }
  async put(key: string, value: string | Uint8Array): Promise<unknown> {
    this.objects.set(key, value);
    return { key };
  }
}

async function setup() {
  const d1 = fakeD1(openMemoryDatabase());
  const db: SqlDatabase = fromD1(d1);
  await applyMigrations(db, loadMigrations());
  let clock = Date.parse('2027-01-11T09:00:00.000Z');
  const now = (): Date => new Date(clock);
  const journal = new SqlJournalStore(db);
  const store = new FicheClient(db, { now });
  const network = (await store.createNetwork('Réseau test')).id;
  const alex = (await store.createAgent({ networkId: network, firstName: 'Alex', lastName: 'Agent' })).id;
  const sam = (await store.createAgent({ networkId: network, firstName: 'Sam', lastName: 'Agent' })).id;
  const client = (await store.createPerson({ networkId: network, agentId: alex, firstName: 'Léa', lastName: 'Exemple' })).id;
  const samClient = (await store.createPerson({ networkId: network, agentId: sam, firstName: 'Noé', lastName: 'Exemple' })).id;
  const bucket = new FakeBucket();
  const pieces = new R2AgentPieceStore(bucket, uuid);
  const ids: Record<Who, { role: string; userId: string }> = { alex: { role: 'agent', userId: alex }, sam: { role: 'agent', userId: sam }, direction: { role: 'direction', userId: 'dir-1' } };
  const apiKeys = JSON.stringify(await Promise.all((Object.keys(KEYS) as Who[]).map(async (w) => ({ sha256: await sha256Hex(KEYS[w]), networkId: network, ...ids[w] }))));
  const config = (extra: Partial<ApiConfig> = {}): ApiConfig => ({ db, apiKeys, mode: 'essai', now, reseau: { pieces }, ...extra });
  const call = async (who: Who, method: string, path: string, body?: unknown) => {
    const headers: Record<string, string> = { authorization: `Bearer ${KEYS[who]}` };
    if (body !== undefined) headers['content-type'] = 'application/json';
    const r = await handleRequest(new Request(`${BASE}/v1${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), config());
    return { status: r.status, body: (await r.json()) as { ok: boolean; data?: any; rule?: string; code?: string } };
  };
  /** Range une pièce par la route de l'agent, comme l'application le fera. */
  const deposit = async (who: Who, agentId: string, kind: string, issuedOn: string, validUntil?: string) => {
    const ref = `agents/${agentId}/${uuid()}.pdf`;
    await bucket.put(ref, 'pièce inventée');
    return call(who, 'POST', `/reseau/agents/${agentId}/pieces`, { kind, ref, issuedOn, ...(validUntil ? { validUntil } : {}) });
  };
  const refusals = async (code: string) => (await journal.all()).filter((e) => e.type === 'acces.refuse' && e.data['code'] === code).length;
  return {
    d1,
    db,
    journal,
    network,
    alex,
    sam,
    client,
    samClient,
    bucket,
    pieces,
    config,
    call,
    deposit,
    refusals,
    setClock: (iso: string) => {
      clock = Date.parse(iso);
    },
  };
}

describeWithSqlite('J13 · branchement de M14 dans le socle (API et Worker)', () => {
  it('[R82] [R16] un agent au dossier incomplet n’a que les routes de son intégration ; complet, il lit ses clients', async () => {
    const t = await setup();
    expect((await t.deposit('alex', t.alex, 'contrat_agent_commercial', '2026-12-01')).status).toBe(200);
    // Aucune fiche client, aucun bien, aucun import : refusés avant toute lecture, au journal.
    const before = await t.refusals('agent_file_incomplete');
    for (const [method, path] of [
      ['GET', '/fiches'],
      ['GET', `/fiches/${t.client}`],
      ['GET', `/fiches/${t.client}/resume`],
      ['GET', '/contacts-chauds'],
      ['GET', '/plan-du-jour'],
      ['GET', `/reseau/agents/${t.alex}/dossiers-couverts`],
    ] as const) {
      expect([path, await t.call('alex', method, path)]).toEqual([path, { status: 403, body: { ok: false, rule: 'R82', code: 'agent_file_incomplete' } }]);
    }
    const imported = await t.call('alex', 'POST', '/reseau/import', { format: 'aimmo', contacts: 'prenom\nZoé' });
    expect(imported).toEqual({ status: 403, body: { ok: false, rule: 'R82', code: 'agent_file_incomplete' } });
    expect((await t.refusals('agent_file_incomplete')) - before).toBe(7);
    // Sa session, son dossier, sa formation, l'entraînement restent ouverts.
    expect((await t.call('alex', 'GET', '/moi')).body).toMatchObject({ ok: true, data: { role: 'agent', firstName: 'Alex' } });
    const file = await t.call('alex', 'GET', '/reseau/mon-dossier');
    expect(file.body).toMatchObject({ ok: true, data: { complete: false } });
    expect((await t.call('alex', 'GET', '/reseau/ma-formation')).status).toBe(200);
    expect((await t.call('alex', 'GET', '/reseau/entrainement/cas')).status).toBe(200);
    // Les écrans « Mon intégration » et « Académie » (J14) restent lisibles : référent, modules, premier parcours.
    expect((await t.call('alex', 'GET', '/reseau/mon-referent')).body).toMatchObject({ ok: true, data: null });
    expect((await t.call('alex', 'GET', '/reseau/academie')).status).toBe(200);
    expect((await t.call('alex', 'GET', '/reseau/mon-bac-a-sable')).body).not.toMatchObject({ code: 'agent_file_incomplete' });

    // Les autres pièces rangées : le dossier est complet, les fiches s'ouvrent.
    expect((await t.deposit('alex', t.alex, 'attestation_habilitation', '2026-12-01', '2028-12-31')).status).toBe(200);
    expect((await t.deposit('alex', t.alex, 'immatriculation_rsac', '2026-12-01')).status).toBe(200);
    expect((await t.deposit('alex', t.alex, 'assurance_rcp', '2026-12-01', '2027-12-31')).status).toBe(200);
    expect((await t.deposit('alex', t.alex, 'attestation_vigilance', '2026-12-01')).body).toMatchObject({ ok: true, data: { complete: true } });
    const list = await t.call('alex', 'GET', '/fiches');
    expect(list.status).toBe(200);
    expect(list.body.data.map((p: { id: string }) => p.id)).toEqual([t.client]);
    expect((await t.call('alex', 'GET', `/fiches/${t.client}`)).status).toBe(200);
    // Un agent de l'agence, sans dossier : ses droits d'agent actif (décision écrite au plan).
    expect((await t.call('sam', 'GET', `/fiches/${t.samClient}`)).status).toBe(200);
  });

  it('[R82] chaque route ouverte sans dossier complet existe, et aucune ne touche un client ou un bien', () => {
    const names = new Set(['moi', ...reseauRoutes().map((r) => r.name), ...clesRoutes().map((r) => r.name), ...formationRoutes().map((r) => r.name)]);
    for (const name of OPEN_WITHOUT_AGENT_FILE) expect([name, names.has(name)]).toEqual([name, true]);
    for (const name of ['reseau.import', 'reseau.dossiers_couverts', 'reseau.absence', 'reseau.reprises', 'reseau.candidatures']) expect(OPEN_WITHOUT_AGENT_FILE.has(name)).toBe(false);
  });

  it('[R86] [R16] dès minuit le jour de son départ, un agent parti ne lit ni n’écrit plus rien, avant le planificateur', async () => {
    const t = await setup();
    const departs = new reseau.Departs(t.db, t.journal, { now: () => new Date('2027-01-11T09:00:00.000Z') });
    const r = await departs.schedule({ role: 'direction', userId: 'dir-1', networkId: t.network }, t.sam, { noticeGivenOn: '2027-01-11', leavesOn: '2027-01-13', reason: 'accord_mutuel', contractStartedOn: '2026-12-01' });
    expect(r.ok).toBe(true);
    t.setClock('2027-01-12T22:59:00.000Z');
    expect((await t.call('sam', 'GET', '/moi')).status).toBe(200);
    t.setClock('2027-01-12T23:00:00.000Z');
    const before = await t.refusals('agent_inactive');
    for (const [method, path] of [
      ['GET', '/moi'],
      ['GET', '/fiches'],
      ['GET', `/fiches/${t.samClient}`],
      ['GET', '/reseau/mon-dossier'],
      ['GET', '/reseau/ma-formation'],
    ] as const) {
      expect([path, await t.call('sam', method, path)]).toEqual([path, { status: 403, body: { ok: false, rule: 'R16', code: 'agent_inactive' } }]);
    }
    expect(await t.deposit('sam', t.sam, 'contrat_agent_commercial', '2026-12-01')).toEqual({ status: 403, body: { ok: false, rule: 'R16', code: 'agent_inactive' } });
    expect((await t.refusals('agent_inactive')) - before).toBe(6);
    expect(await t.db.first('SELECT count(*) AS n FROM agent_file_pieces WHERE agent_id = ?', [t.sam])).toEqual({ n: 0 });
    // La direction, elle, lit toujours.
    expect((await t.call('direction', 'GET', `/fiches/${t.samClient}`)).status).toBe(200);
  });

  it('[R80] la page de candidature est servie par le socle, en mode essai seulement, et s’ouvre sur le seul réseau sans variable (AU022)', async () => {
    const t = await setup();
    const page = async (extra: Partial<ApiConfig>) => {
      const r = await handleRequest(new Request(`${BASE}/rejoindre`), t.config(extra));
      return { status: r.status, html: await r.text() };
    };
    const open = await page({ candidatureNetworkId: t.network });
    expect(open.status).toBe(200);
    expect(open.html).toContain('<form');
    // Sans variable, le seul réseau de la base reçoit (AU022).
    expect(await page({})).toMatchObject({ status: 200 });
    expect((await page({})).html).toContain('<form');
    expect((await page({ candidatureNetworkId: t.network, mode: 'reel' })).status).toBe(503);
    // Une candidature déposée sur la page passe par le socle et se range, dans l'ordre d'arrivée.
    const posted = await handleRequest(
      new Request(`${BASE}/rejoindre`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ firstName: 'Zoé', email: 'zoe.candidate@example.test', currentStatus: 'autre_metier', experience: 'aucune', source: 'page', consent: 'oui' }).toString(),
      }),
      t.config({ candidatureNetworkId: t.network }),
    );
    expect(posted.status).toBe(200);
    expect(await t.db.first('SELECT count(*) AS n FROM candidates WHERE network_id = ?', [t.network])).toEqual({ n: 1 });
  });

  it('le Worker sert la page de candidature et range les projets de pièces dans R2, sous agents/<agent>/', async () => {
    const t = await setup();
    const bucket = new FakeBucket();
    const env: Env = { DB: t.d1, MODE: 'essai', CANDIDATURE_NETWORK_ID: t.network, PIECES: bucket };
    const res = await worker.fetch(new Request(`${BASE}/rejoindre`), env);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('<form');
    const store = new R2AgentPieceStore(bucket, () => '00000000-0000-4000-8000-0000000000aa');
    const ref = await store.putDraft(t.alex, 'PROJET — modèle en attente de validation juridique. Ne pas signer.');
    expect(ref).toBe(`agents/${t.alex}/00000000-0000-4000-8000-0000000000aa.txt`);
    expect(await store.has(ref)).toBe(true);
    expect(await store.has(`agents/${t.alex}/inconnu.pdf`)).toBe(false);
  });
});
