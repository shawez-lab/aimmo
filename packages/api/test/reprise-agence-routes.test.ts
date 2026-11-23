import { expect, it } from 'vitest';
import { handleRequest, type ApiConfig } from '../src/app.ts';
import { sha256Hex } from '../src/index.ts';
import { FicheClient, SqlJournalStore, applyMigrations, fromSyncSqlite, type SqlDatabase, type Viewer } from '@aimmo/core';
import { PortesPhases, type PhaseConditionReading } from '../../core/src/conditions-phases/index.ts';
import type { Challenge } from '../../core/src/securite/index.ts';
import { FakeAuthenticator, ORIGIN, RP } from '../../core/test/appareil-simule.ts';
import { loadMigrations } from '../../core/test/migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from '../../core/test/sqlite.ts';

// Réseaux, agences, SIREN, cartes, utilisateurs, appareils simulés et clés inventés.
const START = '2028-01-10T09:00:00.000Z';
const KEYS = {
  direction: 'test-cle-br17-direction-aaaaaaaaaaaaaaaaaaaaaa',
  agent: 'test-cle-br17-agent-bbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  agence: 'test-cle-br17-agence-licence-dddddddddddddddddd',
  agenceAgent: 'test-cle-br17-agence-agent-eeeeeeeeeeeeeeeeeee',
  autre: 'test-cle-br17-agence-autre-fffffffffffffffffffff',
};
type Who = keyof typeof KEYS;
type Body = { ok: boolean; data?: any; rule?: string | null; code?: string };
const AGENCE = { agencyName: 'Agence du Lac (essai)', siren: '123456782', cardNumber: 'CPI 7501 2027 000 000 001', cardExpiresOn: '2030-06-30', department: '75' };
const AUTRE = { agencyName: 'Cabinet des Prés (essai)', siren: '732829320', cardNumber: 'CPI 6901 2027 000 000 002', cardExpiresOn: '2030-06-30', department: '69' };
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
  const direction = { role: 'direction', userId: 'direction-1', networkId: network.id } as Viewer;
  const portes = new PortesPhases(db, journal, { now, sources: { 1: async () => met(), 2: async () => met(), 3: async () => met(), 4: async () => met() } });
  for (const phase of [2, 3, 4, 5]) {
    const r = await portes.open(direction, { phase });
    if (!r.ok) throw new Error(r.code);
  }
  const base = [
    { sha256: await sha256Hex(KEYS.direction), expiresOn: "2099-12-31", networkId: network.id, role: 'direction', userId: 'direction-1' },
    { sha256: await sha256Hex(KEYS.agent), expiresOn: "2099-12-31", networkId: network.id, role: 'agent', userId: agentId },
  ];
  const config: ApiConfig = { db, apiKeys: JSON.stringify(base), mode: 'essai', now, cles: { rpId: RP, origins: [ORIGIN] } };
  const http = async (who: Who, method: string, path: string, body?: unknown, rawBody?: string): Promise<{ status: number; body: Body }> => {
    const headers: Record<string, string> = { authorization: `Bearer ${KEYS[who]}` };
    if (body !== undefined || rawBody !== undefined) headers['content-type'] = 'application/json';
    const payload = rawBody ?? (body === undefined ? undefined : JSON.stringify(body));
    const r = await handleRequest(new Request(`https://aimmo-api.example.test/v1${path}`, { method, headers, ...(payload === undefined ? {} : { body: payload }) }), config);
    return { status: r.status, body: (await r.json()) as Body };
  };
  expect((await http('direction', 'POST', '/licences/tarif', { monthlyCents: 29_900, reason: 'Tarif d’essai' })).status).toBe(200);
  const lac = (await http('direction', 'POST', '/licences/licence', AGENCE)).body.data as { id: string; licenseeNetworkId: string };
  const pres = (await http('direction', 'POST', '/licences/licence', AUTRE)).body.data as { id: string; licenseeNetworkId: string };
  // Dans chaque agence, une fiche à elle ; rien d'une autre ne doit sortir.
  const lacAgent = (await store.createAgent({ networkId: lac.licenseeNetworkId, firstName: 'Lou', lastName: 'Lac' })).id;
  await store.createAgent({ networkId: pres.licenseeNetworkId, firstName: 'Pia', lastName: 'Prés' });
  config.apiKeys = JSON.stringify([
    ...base,
    { sha256: await sha256Hex(KEYS.agence), expiresOn: "2099-12-31", networkId: lac.licenseeNetworkId, role: 'direction', userId: 'direction-lac' },
    { sha256: await sha256Hex(KEYS.agenceAgent), expiresOn: "2099-12-31", networkId: lac.licenseeNetworkId, role: 'agent', userId: lacAgent },
    { sha256: await sha256Hex(KEYS.autre), expiresOn: "2099-12-31", networkId: pres.licenseeNetworkId, role: 'direction', userId: 'direction-pres' },
  ]);
  const enroll = async (who: Who, seed: number) => {
    const device = await FakeAuthenticator.create(seed);
    const c = await http(who, 'POST', '/cles/enregistrement/debut');
    if (c.status !== 200) throw new Error(`début ${c.body.code}`);
    const done = await http(who, 'POST', '/cles/enregistrement/fin', await device.register(c.body.data as Challenge));
    if (done.status !== 200) throw new Error(`fin ${done.body.code}`);
    return device;
  };
  const stepUp = async (who: Who, device: FakeAuthenticator, action: string, subject: string) => {
    const c = await http(who, 'POST', '/cles/preuve/debut', { action, subject });
    if (c.status !== 200) throw new Error(`preuve ${c.body.code}`);
    const p = await http(who, 'POST', '/cles/preuve/fin', await device.sign(c.body.data as Challenge));
    if (p.status !== 200) throw new Error(`preuve ${p.body.code}`);
    return p.body.data.stepUpId as string;
  };
  const events = async (type: string) => (await journal.all()).filter((e) => e.type === type);
  const count = async (table: string) => Number((await db.first<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`))?.n ?? 0);
  return { db, network, lac, pres, lacAgent, http, enroll, stepUp, events, count };
}

describeWithSqlite('BR17 · route de la reprise des données de l’agence sous licence', () => {
  it('[R16] un autre rôle est refusé en 403 avant le corps, refus au journal, rien de rangé', async () => {
    const t = await setup();
    for (const [who, path] of [
      ['agent', '/export/agence'],
      ['agenceAgent', '/export/agence'],
      ['agenceAgent', '/export/agence/verification'],
    ] as [Who, string][]) {
      const before = (await t.events('acces.refuse')).length;
      const r = await t.http(who, 'POST', path, undefined, 'pas un objet');
      expect(r.status, `${who} ${path}`).toBe(403);
      expect(r.body).toMatchObject({ ok: false, rule: 'R16', code: 'role' });
      expect((await t.events('acces.refuse')).length).toBe(before + 1);
    }
    expect(await t.count('licence_data_exports')).toBe(0);
  });

  it('[R657] la direction du réseau qui donne les licences n’a pas de fichier de reprise : 409, rien n’est lu', async () => {
    const t = await setup();
    expect(await t.http('direction', 'POST', '/export/agence', {})).toMatchObject({ status: 409, body: { rule: 'R657', code: 'pas_de_licence' } });
    expect(await t.count('licence_data_exports')).toBe(0);
  });

  it('[R601] sans preuve, ou avec la preuve d’une autre action, d’un autre objet ou d’une autre agence, rien n’est lu', async () => {
    const t = await setup();
    const device = await t.enroll('agence', 1);
    expect(await t.http('agence', 'POST', '/export/agence', {})).toMatchObject({ status: 409, body: { rule: 'R601', code: 'second_factor_required' } });
    const otherAction = await t.stepUp('agence', device, 'effacement', `licence:${t.lac.id}`);
    expect(await t.http('agence', 'POST', '/export/agence', { stepUpId: otherAction })).toMatchObject({ status: 409, body: { rule: 'R601', code: 'other_action' } });
    const otherSubject = await t.stepUp('agence', device, 'export_complet', `licence:${t.pres.id}`);
    expect(await t.http('agence', 'POST', '/export/agence', { stepUpId: otherSubject })).toMatchObject({ status: 409, body: { rule: 'R601' } });
    const presDevice = await t.enroll('autre', 2);
    const presProof = await t.stepUp('autre', presDevice, 'export_complet', `licence:${t.lac.id}`);
    expect(await t.http('agence', 'POST', '/export/agence', { stepUpId: presProof })).toMatchObject({ status: 409, body: { rule: 'R601' } });
    expect(await t.http('agence', 'POST', '/export/agence', { stepUpId: 'x', tout: true })).toMatchObject({ status: 400, body: { code: 'unknown_field' } });
    expect(await t.http('agence', 'POST', '/export/agence', undefined, '[')).toMatchObject({ status: 400, body: { code: 'invalid_body' } });
    expect(await t.count('licence_data_exports')).toBe(0);
    expect(await t.events('licences.reprise')).toHaveLength(0);
  });

  it('[R658] [R659] le fichier porte les lignes de l’agence seule ; son empreinte est rangée et se vérifie, un octet changé et non', async () => {
    const t = await setup();
    const device = await t.enroll('agence', 3);
    const proof = await t.stepUp('agence', device, 'export_complet', `licence:${t.lac.id}`);
    const made = await t.http('agence', 'POST', '/export/agence', { stepUpId: proof });
    expect(made).toMatchObject({ status: 200, body: { ok: true, mode: 'essai' } });
    const { document, fingerprint, rows } = made.body.data as { document: { networkId: string; licenceId: string; tables: Record<string, Record<string, unknown>[]>; horsFichier: string[] }; fingerprint: string; rows: number };
    expect(document).toMatchObject({ networkId: t.lac.licenseeNetworkId, licenceId: t.lac.id });
    expect(rows).toBeGreaterThan(0);
    expect(document.tables.agents!.map((a) => a.id)).toEqual([t.lacAgent]);
    const text = JSON.stringify(document);
    for (const foreign of [t.network.id, t.pres.licenseeNetworkId, 'Pia', 'Alex', AUTRE.siren]) expect(text).not.toContain(foreign);
    expect(document.horsFichier.length).toBeGreaterThan(0);
    // La preuve ne sert qu'une fois.
    expect(await t.http('agence', 'POST', '/export/agence', { stepUpId: proof })).toMatchObject({ status: 409, body: { rule: 'R601' } });
    // AIMMO range l'empreinte et les comptes, jamais le contenu.
    const kept = await t.db.all<Record<string, unknown>>('SELECT * FROM licence_data_exports');
    expect(kept).toEqual([expect.objectContaining({ licence_id: t.lac.id, network_id: t.lac.licenseeNetworkId, fingerprint, rows_count: rows })]);
    const journal = await t.events('licences.reprise');
    expect(journal).toHaveLength(1);
    expect(JSON.stringify(journal)).not.toContain('Lou');
    // La vérification : vrai pour le fichier remis, faux un octet changé ; un fichier d'un autre réseau n'est pas lu.
    const ok = await t.http('agence', 'POST', '/export/agence/verification', { document });
    expect(ok).toMatchObject({ status: 200, body: { data: { verified: true, fingerprint, complete: true, missing: [] } } });
    const changed = { ...document, tables: { ...document.tables, agents: [{ ...document.tables.agents![0], first_name: 'Lov' }] } };
    expect((await t.http('agence', 'POST', '/export/agence/verification', { document: changed })).body.data).toMatchObject({ verified: false });
    expect((await t.http('autre', 'POST', '/export/agence/verification', { document })).body.data).toEqual({ verified: false, fingerprint: null, complete: false, missing: [] });
    expect(await t.http('agence', 'POST', '/export/agence/verification', { document, encore: 1 })).toMatchObject({ status: 400, body: { code: 'unknown_field' } });
  });

  it('[R600] sans site WebAuthn réglé, la reprise est fermée : 503 ; le rôle est contrôlé d’abord', async () => {
    const t = await setup();
    const res = await handleRequest(
      new Request('https://aimmo-api.example.test/v1/export/agence', { method: 'POST', headers: { authorization: `Bearer ${KEYS.agence}`, 'content-type': 'application/json' }, body: '{}' }),
      { db: t.db, apiKeys: JSON.stringify([{ sha256: await sha256Hex(KEYS.agence), expiresOn: "2099-12-31", networkId: t.lac.licenseeNetworkId, role: 'direction', userId: 'direction-lac' }]), mode: 'essai', now: () => new Date(START), cles: null },
    );
    expect(res.status).toBe(503);
  });
});
