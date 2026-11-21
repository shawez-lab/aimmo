import { expect, it } from 'vitest';
import { handleRequest, type ApiConfig } from '../src/app.ts';
import { sha256Hex } from '../src/index.ts';
import { FicheClient, SqlJournalStore, applyMigrations, fromSyncSqlite, type SqlDatabase, type Viewer } from '@aimmo/core';
import { PortesPhases, type PhaseConditionReading } from '../../core/src/conditions-phases/index.ts';
import type { Challenge } from '../../core/src/securite/index.ts';
import { FakeAuthenticator, ORIGIN, RP } from '../../core/test/appareil-simule.ts';
import { loadMigrations } from '../../core/test/migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from '../../core/test/sqlite.ts';

// BR113. Réseaux, agences, SIREN, cartes, utilisateurs, appareils simulés et clés inventés.
const START = '2028-01-10T09:00:00.000Z';
const KEYS = {
  direction: 'test-cle-br113-direction-aaaaaaaaaaaaaaaaaaaaaa',
  agent: 'test-cle-br113-agent-bbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  agence: 'test-cle-br113-agence-licence-dddddddddddddddddd',
  agenceAgent: 'test-cle-br113-agence-agent-eeeeeeeeeeeeeeeeeee',
  autre: 'test-cle-br113-agence-autre-fffffffffffffffffffff',
  conformite: 'test-cle-br113-agence-conformite-gggggggggggggg',
  conformiteReseau: 'test-cle-br113-reseau-conformite-hhhhhhhhhhhhh',
  conformiteAutre: 'test-cle-br113-autre-conformite-iiiiiiiiiiiiii',
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
    { sha256: await sha256Hex(KEYS.conformiteReseau), expiresOn: "2099-12-31", networkId: network.id, role: 'compliance', userId: 'conformite-reseau' },
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
    { sha256: await sha256Hex(KEYS.conformite), expiresOn: "2099-12-31", networkId: lac.licenseeNetworkId, role: 'compliance', userId: 'conformite-lac' },
    { sha256: await sha256Hex(KEYS.conformiteAutre), expiresOn: "2099-12-31", networkId: pres.licenseeNetworkId, role: 'compliance', userId: 'conformite-pres' },
  ]);
  // AU089 : dans chaque agence, la direction a nommé son responsable ; lui seul tire le dossier [R94].
  for (const [net, officer] of [[lac.licenseeNetworkId, 'conformite-lac'], [pres.licenseeNetworkId, 'conformite-pres']] as const) {
    await db.run('INSERT INTO lcb_officers (network_id, seq, officer_user_id, designated_by, designated_at) VALUES (?, 1, ?, ?, ?)', [net, officer, 'direction:essai', '2028-01-01T08:00:00.000Z']);
  }
  // Dans chaque réseau, une pièce au coffre et un signalement : rien d'un autre réseau ne doit sortir.
  const at = '2028-01-09T08:00:00.000Z';
  for (const [net, tag] of [[lac.licenseeNetworkId, 'lac'], [pres.licenseeNetworkId, 'pres'], [network.id, 'reseau']] as const) {
    await db.run('INSERT INTO persons (id, network_id, first_name, last_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', [`personne-${tag}`, net, 'Alix', `Essai ${tag}`, at, at]);
    await db.run(
      "INSERT INTO compliance_vault_pieces (id, network_id, person_id, kind, storage_ref, sha256, content_type, size_bytes, verified_on, deposited_by, deposited_at) VALUES (?, ?, ?, 'carte_identite', ?, ?, 'application/pdf', 1234, '2028-01-09', 'agent:essai', ?)",
      [`piece-${tag}`, net, `personne-${tag}`, `coffre-test/${tag}/1`, 'e'.repeat(64), at],
    );
    await db.run('INSERT INTO suspicion_reports (id, network_id, case_ref, person_id, note, snapshot, snapshot_sha256, reported_by, reported_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [
      `signalement-${tag}`,
      net,
      `dossier-${tag}`,
      `personne-${tag}`,
      `Paiement proposé en espèces (essai ${tag}).`,
      '{}',
      'c'.repeat(64),
      'agent:essai',
      at,
    ]);
  }
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
  return { db, journal, network, lac, pres, lacAgent, http, enroll, stepUp, events, count };
}

describeWithSqlite('BR113 · routes du dossier de la lutte contre le blanchiment de l’agence sous licence', () => {
  it('[R16] [R662] un autre rôle que le responsable de la conformité est refusé en 403 avant le corps, refus au journal, rien de rangé', async () => {
    const t = await setup();
    for (const who of ['agence', 'agenceAgent', 'direction', 'agent', 'autre'] as Who[]) {
      for (const path of ['/export/agence/lcb', '/export/agence/lcb/verification']) {
        const before = (await t.events('acces.refuse')).length;
        const r = await t.http(who, 'POST', path, undefined, 'pas un objet');
        expect(r.status, `${who} ${path}`).toBe(403);
        expect(r.body).toMatchObject({ ok: false, rule: 'R16', code: 'role' });
        expect((await t.events('acces.refuse')).length, `${who} ${path}`).toBe(before + 1);
      }
    }
    expect(await t.count('licence_lcb_exports')).toBe(0);
    expect(await t.events('conformite.dossier_lcb_remis')).toHaveLength(0);
  });

  it('[R662] le responsable de la conformité du réseau qui donne les licences n’a pas de dossier ici : 409, rien n’est lu', async () => {
    const t = await setup();
    expect(await t.http('conformiteReseau', 'POST', '/export/agence/lcb', {})).toMatchObject({ status: 409, body: { rule: 'R662', code: 'pas_de_licence' } });
    // Sa vérification ne dit jamais vrai : aucune empreinte de dossier n'est rangée pour ce réseau.
    const own = { format: 'aimmo-dossier-lcb-agence/1', licenceId: 'x', networkId: t.network.id, tables: {}, pieces: [] };
    expect((await t.http('conformiteReseau', 'POST', '/export/agence/lcb/verification', { document: own })).body.data).toMatchObject({ verified: false });
    expect(await t.count('licence_lcb_exports')).toBe(0);
  });

  it('[R601] sans preuve, avec la preuve d’une autre action, d’un autre objet, d’une autre agence, ou rejouée, rien n’est remis', async () => {
    const t = await setup();
    const device = await t.enroll('conformite', 1);
    expect(await t.http('conformite', 'POST', '/export/agence/lcb', {})).toMatchObject({ status: 409, body: { rule: 'R601', code: 'second_factor_required' } });
    const otherAction = await t.stepUp('conformite', device, 'effacement', `licence_lcb:${t.lac.id}`);
    expect(await t.http('conformite', 'POST', '/export/agence/lcb', { stepUpId: otherAction })).toMatchObject({ status: 409, body: { rule: 'R601', code: 'other_action' } });
    // La preuve de la reprise de la direction (`licence:<id>`) n'ouvre pas le dossier (`licence_lcb:<id>`).
    const reprise = await t.stepUp('conformite', device, 'export_complet', `licence:${t.lac.id}`);
    expect(await t.http('conformite', 'POST', '/export/agence/lcb', { stepUpId: reprise })).toMatchObject({ status: 409, body: { rule: 'R601' } });
    const otherLicence = await t.stepUp('conformite', device, 'export_complet', `licence_lcb:${t.pres.id}`);
    expect(await t.http('conformite', 'POST', '/export/agence/lcb', { stepUpId: otherLicence })).toMatchObject({ status: 409, body: { rule: 'R601' } });
    const presDevice = await t.enroll('conformiteAutre', 2);
    const presProof = await t.stepUp('conformiteAutre', presDevice, 'export_complet', `licence_lcb:${t.lac.id}`);
    expect(await t.http('conformite', 'POST', '/export/agence/lcb', { stepUpId: presProof })).toMatchObject({ status: 409, body: { rule: 'R601' } });
    expect(await t.http('conformite', 'POST', '/export/agence/lcb', { stepUpId: 'x', tout: true })).toMatchObject({ status: 400, body: { code: 'unknown_field' } });
    expect(await t.http('conformite', 'POST', '/export/agence/lcb', undefined, '[')).toMatchObject({ status: 400, body: { code: 'invalid_body' } });
    expect(await t.count('licence_lcb_exports')).toBe(0);
    expect(await t.events('conformite.dossier_lcb_remis')).toHaveLength(0);
  });

  it('[R662] [R663] [R664] le dossier ne porte que l’agence ; l’empreinte seule est rangée ; il se vérifie, un octet changé et non', async () => {
    const t = await setup();
    const device = await t.enroll('conformite', 3);
    const proof = await t.stepUp('conformite', device, 'export_complet', `licence_lcb:${t.lac.id}`);
    const made = await t.http('conformite', 'POST', '/export/agence/lcb', { stepUpId: proof });
    expect(made).toMatchObject({ status: 200, body: { ok: true, mode: 'essai' } });
    type Doc = { networkId: string; licenceId: string; tables: Record<string, Record<string, unknown>[]>; pieces: { id: string; sha256: string }[] };
    const { document, fingerprint } = made.body.data as { document: Doc; fingerprint: string };
    expect(document).toMatchObject({ networkId: t.lac.licenseeNetworkId, licenceId: t.lac.id });
    expect(document.tables.suspicion_reports!.map((r) => r.id)).toEqual(['signalement-lac']);
    expect(document.pieces.map((p) => p.id)).toEqual(['piece-lac']);
    const text = JSON.stringify(document);
    for (const foreign of [t.network.id, t.pres.licenseeNetworkId, 'signalement-pres', 'signalement-reseau', 'piece-pres', 'piece-reseau']) expect(text).not.toContain(foreign);
    // La preuve ne sert qu'une fois.
    expect(await t.http('conformite', 'POST', '/export/agence/lcb', { stepUpId: proof })).toMatchObject({ status: 409, body: { rule: 'R601' } });
    // AIMMO range l'empreinte, rien d'autre ; le journal ne porte que l'empreinte [R663].
    const kept = await t.db.all<Record<string, unknown>>('SELECT * FROM licence_lcb_exports');
    expect(kept).toEqual([expect.objectContaining({ licence_id: t.lac.id, network_id: t.lac.licenseeNetworkId, fingerprint })]);
    const remis = await t.events('conformite.dossier_lcb_remis');
    expect(remis).toHaveLength(1);
    expect(JSON.stringify(remis)).not.toMatch(/signalement|piece-|Essai|espèces/);
    // La vérification : vraie pour le dossier remis ; un octet changé et non ; un dossier d'un autre réseau, rien n'en est dit.
    const ok = await t.http('conformite', 'POST', '/export/agence/lcb/verification', { document });
    expect(ok).toMatchObject({ status: 200, body: { data: { verified: true, fingerprint, complete: true, missing: [], piecesComplete: true } } });
    const changed = { ...document, tables: { ...document.tables, suspicion_reports: [{ ...document.tables.suspicion_reports![0], note: 'Autre note (essai).' }] } };
    expect((await t.http('conformite', 'POST', '/export/agence/lcb/verification', { document: changed })).body.data).toMatchObject({ verified: false });
    const lessPieces = { ...document, pieces: [] };
    expect((await t.http('conformite', 'POST', '/export/agence/lcb/verification', { document: lessPieces })).body.data).toMatchObject({ verified: false, piecesComplete: false });
    expect((await t.http('conformiteAutre', 'POST', '/export/agence/lcb/verification', { document })).body.data).toEqual({ verified: false, fingerprint: null, complete: false, missing: [], piecesComplete: false });
    expect(await t.http('conformite', 'POST', '/export/agence/lcb/verification', { document, encore: 1 })).toMatchObject({ status: 400, body: { code: 'unknown_field' } });
    // La vérification ne range rien.
    expect(await t.count('licence_lcb_exports')).toBe(1);
  });

  it('[R600] sans site WebAuthn réglé, le dossier est fermé : 503', async () => {
    const t = await setup();
    const keys = JSON.stringify([{ sha256: await sha256Hex(KEYS.conformite), expiresOn: "2099-12-31", networkId: t.lac.licenseeNetworkId, role: 'compliance', userId: 'conformite-lac' }]);
    for (const path of ['/v1/export/agence/lcb', '/v1/export/agence/lcb/verification']) {
      const res = await handleRequest(
        new Request(`https://aimmo-api.example.test${path}`, { method: 'POST', headers: { authorization: `Bearer ${KEYS.conformite}`, 'content-type': 'application/json' }, body: '{}' }),
        { db: t.db, apiKeys: keys, mode: 'essai', now: () => new Date(START), cles: null },
      );
      expect(res.status, path).toBe(503);
    }
    expect(await t.count('licence_lcb_exports')).toBe(0);
  });

  it('[R16] [R662] BR114 · la licence que la preuve désigne : au responsable de la conformité de l’agence seul, rien d’autre', async () => {
    const t = await setup();
    const mine = await t.http('conformite', 'GET', '/export/agence/lcb');
    expect(mine).toEqual({ status: 200, body: expect.objectContaining({ ok: true, data: { licenceId: t.lac.id } }) });
    expect((await t.http('conformiteAutre', 'GET', '/export/agence/lcb')).body.data).toEqual({ licenceId: t.pres.id });
    expect(await t.http('conformiteReseau', 'GET', '/export/agence/lcb')).toMatchObject({ status: 409, body: { rule: 'R662', code: 'pas_de_licence' } });
    for (const who of ['agence', 'agenceAgent', 'direction', 'agent', 'autre'] as Who[]) {
      const before = (await t.events('acces.refuse')).length;
      const r = await t.http(who, 'GET', '/export/agence/lcb');
      expect(r.status, who).toBe(403);
      expect(r.body, who).toMatchObject({ ok: false, rule: 'R16', code: 'role' });
      expect(r.body.data, who).toBeUndefined();
      expect((await t.events('acces.refuse')).length, who).toBe(before + 1);
    }
    // Lire la licence ne tire rien et ne range rien.
    expect(await t.count('licence_lcb_exports')).toBe(0);
    expect(await t.events('conformite.dossier_lcb_remis')).toHaveLength(0);
    const keys = JSON.stringify([{ sha256: await sha256Hex(KEYS.conformite), expiresOn: "2099-12-31", networkId: t.lac.licenseeNetworkId, role: 'compliance', userId: 'conformite-lac' }]);
    const closed = await handleRequest(new Request('https://aimmo-api.example.test/v1/export/agence/lcb', { headers: { authorization: `Bearer ${KEYS.conformite}` } }), {
      db: t.db,
      apiKeys: keys,
      mode: 'essai',
      now: () => new Date(START),
      cles: null,
    });
    expect(closed.status).toBe(503);
  });
});
