import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { handleRequest, type ApiConfig } from '../src/app.ts';
import { sha256Hex } from '../src/index.ts';
import { setupAnnonce } from '../../core/test/annonces-jeu.ts';
import { describeWithSqlite } from '../../core/test/sqlite.ts';

// Réseau, agents et clés inventés.
const NOW = new Date('2027-03-09T09:00:00.000Z');
const KEYS = {
  alex: 'test-cle-au039-alex-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  direction: 'test-cle-au039-direction-cccccccccccccccccccccc',
};
type Who = keyof typeof KEYS;

async function setup() {
  const t = await setupAnnonce();
  t.setClock(NOW);
  const ids: Record<Who, { role: string; userId: string }> = {
    alex: { role: 'agent', userId: t.alexId },
    direction: { role: 'direction', userId: t.direction.userId },
  };
  const apiKeys = JSON.stringify(await Promise.all((Object.keys(KEYS) as Who[]).map(async (w) => ({ sha256: await sha256Hex(KEYS[w]), networkId: t.network.id, ...ids[w] }))));
  const config: ApiConfig = { db: t.db, apiKeys, mode: 'essai', now: t.now };
  const http = async (who: Who, method: string, path: string, body?: unknown) => {
    const headers: Record<string, string> = { authorization: `Bearer ${KEYS[who]}` };
    if (body !== undefined) headers['content-type'] = 'application/json';
    const r = await handleRequest(new Request(`https://aimmo-api.example.test/v1${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), config);
    return { status: r.status, body: (await r.json()) as { ok: boolean; data?: any; rule?: string; code?: string } };
  };
  return { ...t, http };
}

describeWithSqlite('AU039 · routes du paramétrage géographique du réseau', () => {
  it('[R679] la direction inscrit Lyon par la route ; la liste et les règles d’attribution la rendent', async () => {
    const t = await setup();
    expect((await t.http('alex', 'GET', '/geographie/communes')).body.data.source).toBe('defaut');
    const r = await t.http('direction', 'POST', '/geographie/communes', { inseeCode: '69123', name: 'Lyon', listed: true, reason: 'Ouverture du secteur' });
    expect(r).toMatchObject({ status: 200, body: { ok: true, data: { inseeCode: '69123', name: 'Lyon', version: 1, listed: true } } });
    expect((await t.http('alex', 'GET', '/geographie/communes')).body.data).toEqual({ source: 'reseau', communes: [{ name: 'Lyon', inseeCode: '69123' }] });
    expect((await t.http('alex', 'GET', '/attribution/regles')).body.data.communes).toEqual(['Lyon']);
  });

  it('[R16] un agent ne peut pas inscrire : 403, refus au journal ; [R679] une décision répétée : 409', async () => {
    const t = await setup();
    expect(await t.http('alex', 'POST', '/geographie/communes', { inseeCode: '69123', name: 'Lyon', listed: true, reason: 'Ouverture' })).toMatchObject({ status: 403, body: { rule: 'R16' } });
    expect((await t.journal.all()).filter((e) => e.type === 'acces.refuse')).toHaveLength(1);
    expect(await t.db.all('SELECT * FROM network_communes')).toEqual([]);
    await t.http('direction', 'POST', '/geographie/communes', { inseeCode: '69123', name: 'Lyon', listed: true, reason: 'Ouverture' });
    expect(await t.http('direction', 'POST', '/geographie/communes', { inseeCode: '69123', name: 'Lyon', listed: true, reason: 'Ouverture' })).toMatchObject({ status: 409, body: { rule: 'R679', code: 'deja_inscrite' } });
    expect((await t.http('direction', 'POST', '/geographie/communes', 'pas un objet')).status).toBe(400);
  });

  it('docs/API.md décrit les routes du paramétrage géographique', () => {
    const doc = readFileSync(new URL('../../../docs/API.md', import.meta.url), 'utf8');
    expect(doc).toMatch(/\| GET \| `\/v1\/geographie\/communes`/);
    expect(doc).toMatch(/\| POST \| `\/v1\/geographie\/communes`/);
    expect(doc).toMatch(/R679/);
  });
});
