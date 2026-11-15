import { expect, it } from 'vitest';
import { FicheClient, SqlJournalStore, applyMigrations, fromSyncSqlite, type SqlDatabase } from '@aimmo/core';
import { handleRequest, type ApiConfig } from '../src/app.ts';
import { sha256Hex } from '../src/index.ts';
import { loadMigrations } from '../../core/test/migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from '../../core/test/sqlite.ts';

// Réseau, agent, barèmes et clés inventés.
const BASE = 'https://aimmo-api.example.test';
const KEY = (who: string): string => `test-cle-br79-${who}-${'x'.repeat(32)}`;
type Who = 'dir' | 'alex' | 'conf';

async function setup() {
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  // Le 1er mars 2027 à Paris.
  let clock = Date.parse('2027-03-01T10:00:00.000Z');
  const now = (): Date => new Date((clock += 1_000));
  const journal = new SqlJournalStore(db);
  const store = new FicheClient(db, { now });
  const network = (await store.createNetwork('Réseau test')).id;
  const other = (await store.createNetwork('Autre réseau')).id;
  const alex = (await store.createAgent({ networkId: network, firstName: 'Alex', lastName: 'Agent' })).id;
  const ids: Record<Who, { role: string; userId: string; networkId?: string }> = {
    dir: { role: 'direction', userId: 'dir-1' },
    alex: { role: 'agent', userId: alex },
    conf: { role: 'compliance', userId: 'conf-1' },
  };
  const keys = await Promise.all((Object.keys(ids) as Who[]).map(async (w) => ({ sha256: await sha256Hex(KEY(w)), networkId: network, ...ids[w] })));
  keys.push({ sha256: await sha256Hex(KEY('autre')), networkId: other, role: 'direction', userId: 'dir-2' });
  const config: ApiConfig = { db, apiKeys: JSON.stringify(keys), mode: 'essai', now };
  const call = async (who: Who | 'autre', method: string, path: string, body?: unknown) => {
    const headers: Record<string, string> = { authorization: `Bearer ${KEY(who)}` };
    if (body !== undefined) headers['content-type'] = 'application/json';
    const r = await handleRequest(new Request(`${BASE}/v1${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), config);
    return { status: r.status, body: (await r.json()) as { ok: boolean; data?: any; rule?: string | null; code?: string } };
  };
  const scale = (kind: string, rateBp: number, source: string, validFrom: string, who: Who | 'autre' = 'dir') => call(who, 'POST', '/neuf/baremes', { kind, rateBp, source, validFrom });
  const events = async (type: string) => (await journal.all()).filter((e) => e.type === type);
  return { db, network, call, scale, events };
}

describeWithSqlite('BR79 · les barèmes rangés, lus par la direction', () => {
  it('[R16] la direction seule lit les barèmes ; un agent ou la conformité est refusé, au journal', async () => {
    const t = await setup();
    for (const who of ['alex', 'conf'] as const) {
      const before = (await t.events('acces.refuse')).length;
      const r = await t.call(who, 'GET', '/neuf/baremes');
      expect([r.status, r.body.rule, r.body.code], who).toEqual([403, 'R16', 'role']);
      expect((await t.events('acces.refuse')).length, who).toBe(before + 1);
    }
    expect((await t.call('dir', 'GET', '/neuf/baremes')).status).toBe(200);
  });

  it('[R544] aucun barème : rien en vigueur, rien à venir, rien de remplacé', async () => {
    const t = await setup();
    const r = await t.call('dir', 'GET', '/neuf/baremes');
    expect(r.body.data).toEqual({ day: '2027-03-01', neuf: { current: null, upcoming: [], replaced: [] }, ancien: { current: null, upcoming: [], replaced: [] } });
  });

  it('[R544] pour chaque sorte : celui qui fait foi ce jour, ceux à venir du plus proche, ceux remplacés du plus récent ; un même premier jour départagé par le dernier rangé, comme les frais', async () => {
    const t = await setup();
    expect((await t.scale('neuf', 200, 'Barème du neuf de 2026 inventé', '2026-01-01')).status).toBe(200);
    expect((await t.scale('neuf', 250, 'Barème du neuf inventé, première saisie', '2027-01-01')).status).toBe(200);
    expect((await t.scale('neuf', 260, 'Barème du neuf inventé, corrigé', '2027-01-01')).status).toBe(200);
    expect((await t.scale('neuf', 300, 'Barème du neuf de juillet inventé', '2027-07-01')).status).toBe(200);
    expect((await t.scale('neuf', 280, 'Barème du neuf d’avril inventé', '2027-04-01')).status).toBe(200);
    expect((await t.scale('ancien', 750, 'Barème de l’ancien inventé', '2027-03-01')).status).toBe(200);
    // Un autre réseau n'apparaît jamais.
    expect((await t.scale('ancien', 900, 'Barème d’un autre réseau inventé', '2027-01-01', 'autre')).status).toBe(200);

    const r = await t.call('dir', 'GET', '/neuf/baremes');
    expect(r.status).toBe(200);
    const d = r.body.data;
    expect(d.day).toBe('2027-03-01');
    expect(d.neuf.current).toMatchObject({ rateBp: 260, source: 'Barème du neuf inventé, corrigé', validFrom: '2027-01-01' });
    expect(d.neuf.upcoming.map((s: { rateBp: number }) => s.rateBp)).toEqual([280, 300]);
    expect(d.neuf.replaced.map((s: { rateBp: number }) => s.rateBp)).toEqual([250, 200]);
    // Le barème qui fait foi ce jour même est en vigueur, pas à venir.
    expect(d.ancien.current).toMatchObject({ rateBp: 750, validFrom: '2027-03-01' });
    expect(d.ancien.upcoming).toEqual([]);
    expect(d.ancien.replaced).toEqual([]);
    for (const s of [d.neuf.current, ...d.neuf.upcoming, ...d.neuf.replaced]) {
      expect(Object.keys(s).sort()).toEqual(['rateBp', 'scaleId', 'setAt', 'source', 'validFrom']);
    }
    expect(JSON.stringify(d)).not.toContain('autre réseau');
  });
  it('[R544] un long historique d’une sorte ne cache jamais le barème en vigueur, ni celui de l’autre sorte', async () => {
    const t = await setup();
    expect((await t.scale('ancien', 750, 'Barème de l’ancien inventé', '2027-01-01')).status).toBe(200);
    expect((await t.scale('neuf', 250, 'Barème du neuf inventé', '2027-01-01')).status).toBe(200);
    // 450 barèmes du neuf à venir, rangés après : plus que toute borne de lecture.
    for (let i = 0; i < 450; i++) {
      const from = new Date(Date.parse('2027-04-01T12:00:00Z') + i * 86_400_000).toISOString().slice(0, 10);
      await t.db.run('INSERT INTO acquisition_fee_scales (id, network_id, kind, rate_bp, source, valid_from, set_by, set_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [
        `futur-${i}`,
        t.network,
        'neuf',
        300,
        'Barème à venir inventé',
        from,
        'direction:dir-1',
        '2027-03-01T11:00:00.000Z',
      ]);
    }
    const d = (await t.call('dir', 'GET', '/neuf/baremes')).body.data;
    expect(d.neuf.current).toMatchObject({ rateBp: 250, validFrom: '2027-01-01' });
    expect(d.ancien.current).toMatchObject({ rateBp: 750, validFrom: '2027-01-01' });
    expect(d.neuf.upcoming[0].validFrom).toBe('2027-04-01');
  });
});
