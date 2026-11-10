import { expect, it } from 'vitest';
import { handleRequest, type ApiConfig } from '../src/app.ts';
import { sha256Hex } from '../src/index.ts';
import { setupAnnonce } from '../../core/test/annonces-jeu.ts';
import { describeWithSqlite } from '../../core/test/sqlite.ts';

// Réseau, agents, biens, trousseaux et clés d'API inventés. Le 12 février 2027, à 11 h à Paris.
const NOW = new Date('2027-02-12T10:00:00.000Z');
const IN_2H = new Date(NOW.getTime() + 2 * 3_600_000).toISOString();
const KEYS = {
  alex: 'test-cle-br21-alex-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  sam: 'test-cle-br21-sam-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  direction: 'test-cle-br21-direction-cccccccccccccccccccccc',
  conformite: 'test-cle-br21-conformite-ddddddddddddddddddddd',
};
type Who = keyof typeof KEYS;

async function setup() {
  const t = await setupAnnonce();
  t.setClock(NOW);
  const ids: Record<Who, { role: string; userId: string }> = {
    alex: { role: 'agent', userId: t.alexId },
    sam: { role: 'agent', userId: t.sam.userId },
    direction: { role: 'direction', userId: t.direction.userId },
    conformite: { role: 'compliance', userId: 'conformite-1' },
  };
  const apiKeys = JSON.stringify(await Promise.all((Object.keys(KEYS) as Who[]).map(async (w) => ({ sha256: await sha256Hex(KEYS[w]), networkId: t.network.id, ...ids[w] }))));
  const config: ApiConfig = { db: t.db, apiKeys, mode: 'essai', now: t.now };
  const http = async (who: Who, method: string, path: string, body?: unknown, raw?: string) => {
    const headers: Record<string, string> = { authorization: `Bearer ${KEYS[who]}` };
    if (body !== undefined || raw !== undefined) headers['content-type'] = 'application/json';
    const payload = raw ?? (body === undefined ? undefined : JSON.stringify(body));
    const r = await handleRequest(new Request(`https://aimmo-api.example.test/v1${path}`, { method, headers, ...(payload === undefined ? {} : { body: payload }) }), config);
    return { status: r.status, body: (await r.json()) as { ok: boolean; data?: any; rule?: string; code?: string; mode?: string; keyId?: string; number?: number; dueAt?: string } };
  };
  const refusals = async () => (await t.journal.all()).filter((e) => e.type === 'acces.refuse');
  const register = async (who: Who = 'alex', label = 'Porte d’entrée et cave') => {
    const r = await http(who, 'POST', `/trousseaux/biens/${t.propertyId}`, { label });
    expect(r.status, r.body.code).toBe(200);
    return { keyId: r.body.keyId!, number: r.body.number! };
  };
  return { ...t, http, refusals, register };
}

describeWithSqlite('BR21 · routes de l’armoire des clés', () => {
  it('[R16] chaque route refuse le mauvais rôle ou l’agent d’un autre bien, en 403, au journal, corps mal formé compris', async () => {
    const t = await setup();
    const { keyId } = await t.register();
    const out = { holderAgentId: t.sam.userId, purpose: 'photos', dueAt: IN_2H };
    const cases: [Who, string, string, unknown?, string?][] = [
      ['direction', 'GET', '/trousseaux/a-rendre'],
      ['conformite', 'GET', '/trousseaux/a-rendre'],
      ['conformite', 'GET', `/trousseaux/biens/${t.propertyId}`],
      ['conformite', 'POST', `/trousseaux/biens/${t.propertyId}`, { label: 'Garage' }],
      ['conformite', 'GET', `/trousseaux/${keyId}/mouvements`],
      ['conformite', 'POST', `/trousseaux/${keyId}/sortie`, out],
      ['conformite', 'POST', `/trousseaux/${keyId}/rendu`],
      ['conformite', 'POST', `/trousseaux/${keyId}/perdu`],
      ['conformite', 'POST', `/trousseaux/${keyId}/rendu-au-proprietaire`],
      // Un trousseau inconnu ne dit rien de plus à qui n'a aucun droit sur l'armoire.
      ['conformite', 'POST', '/trousseaux/inconnu-1/rendu'],
      ['conformite', 'GET', '/trousseaux/inconnu-1/mouvements'],
      // Sam n'est pas l'agent du bien : il ne lit ni ne touche l'armoire d'Alex, même avec un corps mal formé.
      ['sam', 'GET', `/trousseaux/biens/${t.propertyId}`],
      ['sam', 'POST', `/trousseaux/biens/${t.propertyId}`, { label: 'Garage' }],
      ['sam', 'POST', `/trousseaux/biens/${t.propertyId}`, undefined, 'pas du json'],
      ['sam', 'GET', `/trousseaux/${keyId}/mouvements`],
      ['sam', 'POST', `/trousseaux/${keyId}/sortie`, out],
      ['sam', 'POST', `/trousseaux/${keyId}/sortie`, undefined, 'x'.repeat(5_000)],
      ['sam', 'POST', `/trousseaux/${keyId}/rendu-au-proprietaire`],
    ];
    for (const [who, method, path, body, raw] of cases) {
      const before = (await t.refusals()).length;
      const r = await t.http(who, method, path, body, raw);
      expect(r.status, `${who} ${method} ${path}`).toBe(403);
      expect(r.body).toMatchObject({ ok: false, rule: 'R16' });
      expect((await t.refusals()).length, `${who} ${method} ${path}`).toBeGreaterThan(before);
    }
    // Rien n'est sorti ni retiré.
    expect((await t.http('alex', 'GET', `/trousseaux/biens/${t.propertyId}`)).body.data).toMatchObject([{ id: keyId, state: 'armoire' }]);
  });

  it('[R270] le numéro est donné par le code, le suivant dans le réseau ; un libellé qui porte une adresse ou un code est refusé', async () => {
    const t = await setup();
    const a = await t.register();
    const b = await t.register('alex', 'Garage');
    const c = await t.register('direction', 'Boîte aux lettres');
    expect([a.number, b.number, c.number]).toEqual([1, 2, 3]);
    // Un numéro envoyé par l'appelant est ignoré.
    const forced = await t.http('alex', 'POST', `/trousseaux/biens/${t.propertyId}`, { label: 'Portail', number: 99 });
    expect(forced.body.number).toBe(4);
    for (const label of ['12 rue des Tilleuls', 'Digicode', 'Code 4521B']) {
      const r = await t.http('alex', 'POST', `/trousseaux/biens/${t.propertyId}`, { label });
      expect(r.status, label).toBe(409);
      expect(r.body).toMatchObject({ ok: false, rule: 'R270', code: 'bad_label' });
    }
    const cabinet = await t.http('direction', 'GET', `/trousseaux/biens/${t.propertyId}`);
    expect(cabinet).toMatchObject({ status: 200, body: { ok: true, mode: 'essai' } });
    expect(cabinet.body.data.map((k: { number: number }) => k.number)).toEqual([1, 2, 3, 4]);
  });

  it('[R271] [R272] un trousseau sorti ne ressort pas ; son détenteur le voit à rendre, peut le dire perdu, et il ne sort plus', async () => {
    const t = await setup();
    const { keyId, number } = await t.register();
    const out = { holderAgentId: t.sam.userId, purpose: 'photos', dueAt: IN_2H };
    const first = await t.http('alex', 'POST', `/trousseaux/${keyId}/sortie`, out);
    expect(first.status).toBe(200);
    expect(first.body.dueAt).toBe(IN_2H);
    const again = await t.http('direction', 'POST', `/trousseaux/${keyId}/sortie`, { ...out, holderAgentId: t.alexId });
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({ ok: false, rule: 'R271', code: 'deja_sorti' });
    expect((await t.http('alex', 'POST', `/trousseaux/${keyId}/rendu-au-proprietaire`)).body).toMatchObject({ rule: 'R271', code: 'encore_sorti' });
    // Plus de 12 heures, ou pour une visite sans rendez-vous : refusé.
    const { keyId: k2 } = await t.register('alex', 'Garage');
    expect((await t.http('alex', 'POST', `/trousseaux/${k2}/sortie`, { ...out, dueAt: new Date(NOW.getTime() + 13 * 3_600_000).toISOString() })).body).toMatchObject({ rule: 'R271', code: 'bad_due' });
    expect((await t.http('alex', 'POST', `/trousseaux/${k2}/sortie`, { holderAgentId: t.sam.userId, purpose: 'visite' })).body).toMatchObject({ rule: 'R271', code: 'sans_rendez_vous' });
    // Sam voit ce qu'il a à rendre ; Alex n'a rien.
    const due = await t.http('sam', 'GET', '/trousseaux/a-rendre');
    expect(due.status).toBe(200);
    expect(due.body.data).toMatchObject([{ keyId, number, propertyId: t.propertyId, dueAt: IN_2H, overdue: false }]);
    expect((await t.http('alex', 'GET', '/trousseaux/a-rendre')).body.data).toEqual([]);
    // Sam n'est pas l'agent du bien, mais c'est lui qui l'a : il peut le dire perdu, pas le dire rendu.
    expect((await t.http('sam', 'POST', `/trousseaux/${keyId}/rendu`)).status).toBe(403);
    expect((await t.http('sam', 'POST', `/trousseaux/${keyId}/perdu`)).status).toBe(200);
    expect((await t.http('sam', 'GET', '/trousseaux/a-rendre')).body.data).toEqual([]);
    const cabinet = await t.http('alex', 'GET', `/trousseaux/biens/${t.propertyId}`);
    expect(cabinet.body.data.find((k: { id: string }) => k.id === keyId)).toMatchObject({ state: 'retire', retirement: { reason: 'perdu' } });
    expect((await t.http('alex', 'POST', `/trousseaux/${keyId}/sortie`, out)).body).toMatchObject({ rule: 'R271', code: 'retire' });
    const moves = await t.http('alex', 'GET', `/trousseaux/${keyId}/mouvements`);
    expect(moves.body.data).toMatchObject([{ holder: { agentId: t.sam.userId }, purpose: 'photos', returned: { outcome: 'perdu' } }]);
  });

  it('[R271] rendu à l’armoire par l’agent du bien, puis rendu au propriétaire : il ne sort plus', async () => {
    const t = await setup();
    const { keyId } = await t.register();
    expect((await t.http('alex', 'POST', `/trousseaux/${keyId}/rendu`)).body).toMatchObject({ rule: 'R271', code: 'pas_sorti' });
    expect((await t.http('alex', 'POST', `/trousseaux/${keyId}/sortie`, { holderAgentId: t.alexId, purpose: 'diagnostic', dueAt: IN_2H })).status).toBe(200);
    expect((await t.http('alex', 'POST', `/trousseaux/${keyId}/rendu`)).status).toBe(200);
    expect((await t.http('alex', 'POST', `/trousseaux/${keyId}/rendu-au-proprietaire`)).status).toBe(200);
    expect((await t.http('alex', 'POST', `/trousseaux/${keyId}/rendu-au-proprietaire`)).body).toMatchObject({ rule: 'R271', code: 'deja_retire' });
    expect((await t.http('alex', 'GET', `/trousseaux/biens/${t.propertyId}`)).body.data).toMatchObject([{ id: keyId, state: 'retire', retirement: { reason: 'rendu_au_proprietaire' } }]);
  });

  it('un corps absent, pas en JSON ou trop gros est refusé en 400 à qui tient l’armoire ; un inconnu en 404', async () => {
    const t = await setup();
    const { keyId } = await t.register();
    const bad = [
      await t.http('alex', 'POST', `/trousseaux/biens/${t.propertyId}`, undefined, 'pas du json'),
      await t.http('alex', 'POST', `/trousseaux/biens/${t.propertyId}`, undefined, '[1]'),
      await t.http('alex', 'POST', `/trousseaux/${keyId}/sortie`, undefined, 'x'.repeat(5_000)),
      await t.http('direction', 'POST', `/trousseaux/${keyId}/sortie`),
    ];
    for (const r of bad) expect(r).toMatchObject({ status: 400, body: { ok: false, code: 'invalid_body' } });
    expect((await t.http('alex', 'GET', `/trousseaux/biens/${t.propertyId}`)).body.data).toMatchObject([{ id: keyId, state: 'armoire' }]);
    expect((await t.http('alex', 'POST', '/trousseaux/inconnu-1/sortie', undefined, 'pas du json')).status).toBe(404);
    expect((await t.http('alex', 'POST', '/trousseaux/inconnu-1/rendu')).status).toBe(404);
    expect((await t.http('alex', 'GET', '/trousseaux/biens/inconnu-1')).status).toBe(404);
  });
});
