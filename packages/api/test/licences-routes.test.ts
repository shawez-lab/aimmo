import { expect, it } from 'vitest';
import { handleRequest, type ApiConfig } from '../src/app.ts';
import { sha256Hex } from '../src/index.ts';
import { FicheClient, SqlJournalStore, applyMigrations, fromSyncSqlite, type SqlDatabase, type Viewer } from '@aimmo/core';
import { PortesPhases, type PhaseConditionReading } from '../../core/src/conditions-phases/index.ts';
import { loadMigrations } from '../../core/test/migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from '../../core/test/sqlite.ts';

// Réseaux, agences, SIREN, cartes, utilisateurs, clés et raisons inventés.
const START = '2028-01-10T09:00:00.000Z';
const KEYS = {
  direction: 'test-cle-br15-direction-aaaaaaaaaaaaaaaaaaaaaa',
  agent: 'test-cle-br15-agent-bbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  conformite: 'test-cle-br15-conformite-ccccccccccccccccccccc',
  agence: 'test-cle-br15-agence-licence-dddddddddddddddddd',
};
type Who = keyof typeof KEYS;
const AGENCE = { agencyName: 'Agence du Lac (essai)', siren: '123456782', cardNumber: 'CPI 7501 2027 000 000 001', cardExpiresOn: '2030-06-30', department: '75' };
const TARIF = { monthlyCents: 29_900, reason: 'Tarif d’essai' };
const met = (): PhaseConditionReading => ({ met: true, reasons: [], evidence: { essai: 1 } });

async function setup() {
  const raw = openMemoryDatabase();
  const db: SqlDatabase = fromSyncSqlite(raw);
  await applyMigrations(db, loadMigrations());
  const now = (): Date => new Date(START);
  const journal = new SqlJournalStore(db);
  const store = new FicheClient(db, { now });
  const network = await store.createNetwork('Réseau test');
  const agentId = (await store.createAgent({ networkId: network.id, firstName: 'Alex', lastName: 'Essai' })).id;
  const ids: Record<Exclude<Who, 'agence'>, { role: string; userId: string }> = {
    direction: { role: 'direction', userId: 'direction-1' },
    agent: { role: 'agent', userId: agentId },
    conformite: { role: 'compliance', userId: 'conformite-1' },
  };
  const keys = await Promise.all((['direction', 'agent', 'conformite'] as const).map(async (w) => ({ sha256: await sha256Hex(KEYS[w]), networkId: network.id, ...ids[w] })));
  const config: ApiConfig = { db, apiKeys: JSON.stringify(keys), mode: 'essai', now };
  /** La clé de la direction de l'agence sous licence, dans son propre réseau, né avec la licence. */
  const addAgencyKey = async (licenseeNetworkId: string) => {
    config.apiKeys = JSON.stringify([...keys, { sha256: await sha256Hex(KEYS.agence), networkId: licenseeNetworkId, role: 'direction', userId: 'direction-agence' }]);
  };
  const http = async (who: Who | null, method: string, path: string, body?: unknown, rawBody?: string) => {
    const headers: Record<string, string> = who ? { authorization: `Bearer ${KEYS[who]}` } : {};
    if (body !== undefined || rawBody !== undefined) headers['content-type'] = 'application/json';
    const payload = rawBody ?? (body === undefined ? undefined : JSON.stringify(body));
    const r = await handleRequest(new Request(`https://aimmo-api.example.test/v1${path}`, { method, headers, ...(payload === undefined ? {} : { body: payload }) }), config);
    return { status: r.status, body: (await r.json()) as { ok: boolean; data?: any; rule?: string | null; code?: string } };
  };
  const openPhase5 = async () => {
    const direction = { role: 'direction', userId: 'direction-1', networkId: network.id } as Viewer;
    const portes = new PortesPhases(db, journal, { now, sources: { 1: async () => met(), 2: async () => met(), 3: async () => met(), 4: async () => met() } });
    for (const phase of [2, 3, 4, 5]) {
      const r = await portes.open(direction, { phase });
      if (!r.ok) throw new Error(r.code);
    }
  };
  const events = async (type: string) => (await journal.all()).filter((e) => e.type === type);
  const count = async (table: string) => Number((await db.first<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`))?.n ?? 0);
  return { network, http, openPhase5, addAgencyKey, events, count };
}

describeWithSqlite('BR15 · routes des licences du logiciel', () => {
  it('[R16] chaque route refuse tout autre rôle que la direction, en 403, avec le refus au journal, sans rien ranger', async () => {
    const t = await setup();
    await t.openPhase5();
    const cases: [string, string, unknown?][] = [
      ['GET', '/licences'],
      ['GET', '/licences/ma-licence'],
      ['POST', '/licences/tarif', TARIF],
      ['POST', '/licences/licence', AGENCE],
      ['POST', '/licences/etat', { licenceId: 'x', state: 'suspendue', reason: 'Essai' }],
    ];
    for (const who of ['agent', 'conformite'] as Who[]) {
      for (const [method, path, body] of cases) {
        const before = (await t.events('acces.refuse')).length;
        const r = await t.http(who, method, path, body);
        expect(r.status, `${who} ${method} ${path}`).toBe(403);
        expect(r.body).toMatchObject({ ok: false, rule: 'R16', code: 'role' });
        expect((await t.events('acces.refuse')).length, `${who} ${method} ${path}`).toBe(before + 1);
      }
      // Même sans corps lisible, le refus de droits passe d'abord et s'écrit au journal.
      const before = (await t.events('acces.refuse')).length;
      expect((await t.http(who, 'POST', '/licences/tarif', undefined, '{pas du json')).status).toBe(403);
      expect((await t.events('acces.refuse')).length).toBe(before + 1);
    }
    expect(await t.count('licence_tariffs')).toBe(0);
    expect(await t.count('software_licences')).toBe(0);
  });

  it('un corps illisible est refusé en 400 sans rien ranger ; un champ inconnu aussi, et un prix dans la demande de licence en 409 avec R655', async () => {
    const t = await setup();
    await t.openPhase5();
    for (const path of ['/licences/tarif', '/licences/licence', '/licences/etat']) {
      for (const rawBody of ['{pas du json', '[1, 2]', 'null']) expect((await t.http('direction', 'POST', path, undefined, rawBody)).status, `${path} ${rawBody}`).toBe(400);
    }
    const unknown = await t.http('direction', 'POST', '/licences/tarif', { ...TARIF, extra: 1 });
    expect(unknown.status).toBe(400);
    expect(unknown.body).toMatchObject({ ok: false, rule: null, code: 'unknown_field' });
    expect((await t.http('direction', 'POST', '/licences/tarif', TARIF)).status).toBe(200);
    // Aucune remise : la demande de licence n'a pas de champ de prix [R655].
    const priced = await t.http('direction', 'POST', '/licences/licence', { ...AGENCE, monthlyCents: 100 });
    expect(priced.status).toBe(409);
    expect(priced.body).toMatchObject({ ok: false, rule: 'R655', code: 'unknown_field' });
    expect(await t.count('software_licences')).toBe(0);
  });

  it('[R654] [R655] licence refusée sans phase 5 ouverte ; tarif hors bornes refusé ; licence donnée au tarif en vigueur, puis dite à l’ancien tarif', async () => {
    const t = await setup();
    expect((await t.http('direction', 'POST', '/licences/tarif', TARIF)).status).toBe(200);
    const closed = await t.http('direction', 'POST', '/licences/licence', AGENCE);
    expect(closed.status).toBe(409);
    expect(closed.body).toMatchObject({ ok: false, rule: 'R654', code: 'phase5_fermee' });
    await t.openPhase5();
    for (const monthlyCents of [99, 10_000_001, 12.5, '29900']) {
      const r = await t.http('direction', 'POST', '/licences/tarif', { monthlyCents, reason: 'Essai' });
      expect(r.status, String(monthlyCents)).toBe(409);
      expect(r.body).toMatchObject({ ok: false, rule: 'R655', code: 'bad_price' });
    }
    const ok = await t.http('direction', 'POST', '/licences/licence', AGENCE);
    expect(ok.status).toBe(200);
    expect(ok.body.data).toMatchObject({ tariffVersion: 1, monthlyCents: 29_900 });
    expect((await t.http('direction', 'POST', '/licences/licence', AGENCE)).body).toMatchObject({ rule: 'R654', code: 'deja_licenciee' });
    expect((await t.http('direction', 'POST', '/licences/tarif', { monthlyCents: 34_900, reason: 'Nouveau tarif d’essai' })).status).toBe(200);
    const list = await t.http('direction', 'GET', '/licences');
    expect(list.status).toBe(200);
    expect(list.body.data.tariff).toMatchObject({ version: 2, monthlyCents: 34_900 });
    expect(list.body.data.licences).toHaveLength(1);
    expect(list.body.data.licences[0]).toMatchObject({ agencyName: AGENCE.agencyName, state: 'active', monthlyCents: 29_900, oldTariff: true, cardExpired: false });
  });

  it('[R656] suspendue, reprise, puis terminée et figée ; une licence inconnue répond 404', async () => {
    const t = await setup();
    await t.openPhase5();
    await t.http('direction', 'POST', '/licences/tarif', TARIF);
    const id = (await t.http('direction', 'POST', '/licences/licence', AGENCE)).body.data.id as string;
    const state = (s: string) => t.http('direction', 'POST', '/licences/etat', { licenceId: id, state: s, reason: 'Décision d’essai' });
    expect((await state('suspendue')).body.data).toMatchObject({ licenceId: id, version: 1, state: 'suspendue' });
    expect((await state('suspendue')).body).toMatchObject({ rule: 'R656', code: 'etat_inchange' });
    expect((await state('active')).status).toBe(200);
    expect((await state('terminee')).status).toBe(200);
    const frozen = await state('active');
    expect(frozen.status).toBe(409);
    expect(frozen.body).toMatchObject({ ok: false, rule: 'R656', code: 'terminee' });
    const unknown = await t.http('direction', 'POST', '/licences/etat', { licenceId: 'inconnue', state: 'suspendue', reason: 'Essai' });
    expect(unknown.status).toBe(404);
    expect(unknown.body).toMatchObject({ ok: false, code: 'not_found' });
    expect((await t.http('direction', 'GET', '/licences')).body.data.licences[0].state).toBe('terminee');
  });

  it('[R657] la direction de l’agence ne lit que sa licence, sans SIREN ni région, et ne donne rien ni ne lit les autres', async () => {
    const t = await setup();
    await t.openPhase5();
    await t.http('direction', 'POST', '/licences/tarif', TARIF);
    const granted = (await t.http('direction', 'POST', '/licences/licence', AGENCE)).body.data;
    await t.http('direction', 'POST', '/licences/licence', { ...AGENCE, agencyName: 'Agence du Port (essai)', siren: '732829320' });
    expect((await t.http('direction', 'GET', '/licences/ma-licence')).body).toMatchObject({ ok: false, rule: 'R657', code: 'pas_de_licence' });
    await t.addAgencyKey(granted.licenseeNetworkId);
    const mine = await t.http('agence', 'GET', '/licences/ma-licence');
    expect(mine.status).toBe(200);
    expect(mine.body.data).toMatchObject({ id: granted.id, agencyName: AGENCE.agencyName, state: 'active' });
    expect(mine.body.data).not.toHaveProperty('siren');
    expect(mine.body.data).not.toHaveProperty('region');
    for (const [method, path, body] of [
      ['GET', '/licences'],
      ['POST', '/licences/tarif', TARIF],
      ['POST', '/licences/licence', { ...AGENCE, siren: '552100554' }],
    ] as [string, string, unknown?][]) {
      const r = await t.http('agence', method, path, body);
      expect(r.status, `${method} ${path}`).toBe(409);
      expect(r.body).toMatchObject({ ok: false, rule: 'R657', code: 'agence_licenciee' });
    }
    expect(await t.count('software_licences')).toBe(2);
  });

  it('[R655] le tarif public se lit sans clé : prix et changements datés, sans agence ni nombre ; 404 tant qu’aucune licence ne peut se donner', async () => {
    const t = await setup();
    const path = `/licences/tarif/${t.network.id}`;
    const none = await t.http(null, 'GET', path);
    expect(none.status).toBe(404);
    await t.http('direction', 'POST', '/licences/tarif', TARIF);
    expect((await t.http(null, 'GET', path)).status).toBe(404);
    await t.openPhase5();
    await t.http('direction', 'POST', '/licences/licence', AGENCE);
    await t.http('direction', 'POST', '/licences/tarif', { monthlyCents: 34_900, reason: 'Nouveau tarif d’essai' });
    const pub = await t.http(null, 'GET', path);
    expect(pub.status).toBe(200);
    expect(pub.body.data).toEqual({
      current: { monthlyCents: 34_900, since: START },
      history: [
        { monthlyCents: 29_900, from: START },
        { monthlyCents: 34_900, from: START },
      ],
    });
    const text = JSON.stringify(pub.body);
    for (const leak of [AGENCE.agencyName, AGENCE.siren, 'licences', 'Tarif d’essai']) expect(text).not.toContain(leak);
    expect((await t.http(null, 'GET', '/licences/tarif/inconnu')).status).toBe(404);
    expect((await t.http(null, 'GET', '/licences/tarif/%3Cscript%3E')).status).toBe(404);
    expect((await t.http(null, 'POST', path, {})).status).toBe(405);
  });
});
