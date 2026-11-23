import { expect, it } from 'vitest';
import { FicheClient, SqlJournalStore, applyMigrations, fromSyncSqlite, type SqlDatabase } from '@aimmo/core';
import { handleRequest, parseApiKeys, type ApiConfig } from '../src/index.ts';
import { sha256Hex } from '../src/index.ts';
import { loadMigrations } from '../../core/test/migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from '../../core/test/sqlite.ts';

// AU107 · Réseau, agent, biens et clés inventés.
const BASE = 'https://aimmo-api.example.test';
const KEY = (who: string): string => `test-cle-au107-${who}-${'x'.repeat(32)}`;
type Who = 'dir' | 'alex' | 'assistante' | 'comptable';

async function setup() {
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  let clock = Date.parse('2027-03-01T10:00:00.000Z');
  const now = (): Date => new Date((clock += 1_000));
  const journal = new SqlJournalStore(db);
  const store = new FicheClient(db, { now });
  const network = (await store.createNetwork('Réseau test')).id;
  const alex = (await store.createAgent({ networkId: network, firstName: 'Alex', lastName: 'Agent' })).id;
  const person = (await store.createPerson({ networkId: network, agentId: alex, firstName: 'Léa', lastName: 'Exemple' })).id;
  const dwelling = { postalCode: '21000', city: 'Dijon', surfaceM2: 62, rooms: 3, priceEur: 200000 };
  const shared = (await store.createProperty({ networkId: network, agentId: alex, reference: 'REF-AU107-1', kind: 'home', status: 'available', ...dwelling })).id;
  const draft = (await store.createProperty({ networkId: network, agentId: alex, reference: 'REF-AU107-2', kind: 'home', ...dwelling })).id;
  const ids: Record<Who, { role: string; userId: string }> = {
    dir: { role: 'direction', userId: 'dir-1' },
    alex: { role: 'agent', userId: alex },
    assistante: { role: 'assistant', userId: 'assistante-1' },
    comptable: { role: 'accountant', userId: 'comptable-1' },
  };
  const keys = await Promise.all((Object.keys(ids) as Who[]).map(async (w) => ({ sha256: await sha256Hex(KEY(w)), networkId: network, ...ids[w] })));
  const config: ApiConfig = { db, apiKeys: JSON.stringify(keys), mode: 'essai', now };
  const call = async (who: Who, method: 'GET' | 'POST', path: string, body?: unknown) => {
    const headers: Record<string, string> = { authorization: `Bearer ${KEY(who)}` };
    if (body !== undefined) headers['content-type'] = 'application/json';
    const r = await handleRequest(new Request(`${BASE}/v1${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), config);
    return { status: r.status, body: (await r.json()) as { ok: boolean; code?: string; rule?: string | null; view?: string; data?: unknown } };
  };
  return { db, journal, network, alex, person, shared, draft, keys, call };
}

describeWithSqlite('AU107 · une assistante et un comptable, chacun avec sa clé et un accès limité', () => {
  it('[R16] constat : une clé d’assistante ou de comptable se range dans le secret, sans partager celle d’un agent ou de la direction', async () => {
    const t = await setup();
    // Avant AU107, ces rôles n'existaient pas : leur clé fermait toute l'API (lecture prudente).
    expect(parseApiKeys(JSON.stringify(t.keys))).not.toBeNull();
    expect(new Set(t.keys.map((k) => k.sha256)).size).toBe(t.keys.length);
  });

  it('[R16] le comptable lit les factures fournisseurs, les rapprochements et la fraîcheur du relevé, rien d’autre', async () => {
    const t = await setup();
    expect(await t.call('comptable', 'GET', '/finances/fournisseurs')).toMatchObject({ status: 200, body: { ok: true } });
    expect(await t.call('comptable', 'GET', '/finances/banque/rapprochements')).toMatchObject({ status: 200, body: { ok: true } });
    expect((await t.call('comptable', 'GET', '/finances/banque/fraicheur')).status).toBe(200);
    // Aucun geste, aucune fiche, aucun bien, aucun rapport.
    for (const [method, path, body] of [
      ['POST', '/finances/banque/releve', undefined],
      ['GET', '/finances/banque/propositions', undefined],
      ['GET', '/finances/relances', undefined],
      ['GET', `/fiches/${t.person}`, undefined],
      ['GET', `/biens/${t.shared}`, undefined],
      ['GET', '/moi', undefined],
      ['GET', '/finances/rapports', undefined],
    ] as const) {
      expect(await t.call('comptable', method, path, body), `${method} ${path}`).toMatchObject({ status: 403, body: { rule: 'R16' } });
    }
  });

  it('[R16] l’assistante lit un bien du fichier commun, sans fiche de client ni chiffres ; un bien hors du fichier commun lui est refusé', async () => {
    const t = await setup();
    expect(await t.call('assistante', 'GET', `/biens/${t.shared}`)).toMatchObject({ status: 200, body: { ok: true } });
    expect((await t.call('assistante', 'GET', `/biens/${t.draft}`)).status).toBe(403);
    for (const path of [`/fiches/${t.person}`, `/fiches/${t.person}/journal`, '/finances/fournisseurs', '/finances/banque/rapprochements', '/moi']) {
      expect((await t.call('assistante', 'GET', path)).status, path).toBe(403);
    }
    // L'agent et la direction gardent leurs accès.
    expect((await t.call('alex', 'GET', `/fiches/${t.person}`)).status).toBe(200);
    expect((await t.call('dir', 'GET', '/finances/fournisseurs')).status).toBe(200);
  });

  it('[R16] [R13] chaque refus d’un rôle limité est écrit au journal, avec la route, sans donnée', async () => {
    const t = await setup();
    await t.call('comptable', 'GET', `/fiches/${t.person}`);
    await t.call('assistante', 'GET', '/finances/fournisseurs');
    const refusals = (await t.journal.all()).filter((e) => e.type === 'acces.refuse' && e.data.code === 'limited_role');
    expect(refusals.map((e) => [e.actor, e.data.kind])).toEqual([
      ['accountant:comptable-1', 'route.fiche'],
      ['assistant:assistante-1', 'route.finances.fournisseurs'],
    ]);
    expect(JSON.stringify(refusals)).not.toContain(t.person);
  });
});
