import { expect, it } from 'vitest';
import { FicheClient, SqlJournalStore, applyMigrations, fromSyncSqlite, type SqlDatabase, type Viewer } from '@aimmo/core';
import { AGENT_PIECE_MAX_BYTES } from '../../core/src/reseau/index.ts';
import { R2AgentPieceStore, reseauRoutes, type R2AgentBucket } from '../src/reseau.ts';
import { loadMigrations } from '../../core/test/migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from '../../core/test/sqlite.ts';

// AU024 · Tout est inventé : réseau, agents, fichiers (quelques octets d'en-tête, aucun vrai document).
const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x0a]);
const JPG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]);

class FakeBucket implements R2AgentBucket {
  readonly objects = new Map<string, { value: string | Uint8Array; type?: string }>();
  async head(key: string) {
    return this.objects.has(key) ? {} : null;
  }
  async put(key: string, value: string | Uint8Array, options?: { httpMetadata?: { contentType?: string } }) {
    this.objects.set(key, { value, ...(options?.httpMetadata?.contentType ? { type: options.httpMetadata.contentType } : {}) });
    return {};
  }
}

async function setup(options: { pieces?: boolean } = {}) {
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  const at = Date.parse('2027-07-12T08:00:00.000Z');
  const now = (): Date => new Date(at);
  const journal = new SqlJournalStore(db);
  const store = new FicheClient(db, { now });
  const network = await store.createNetwork('Réseau test');
  const alex = await store.createAgent({ networkId: network.id, firstName: 'Alex', lastName: 'Agent' });
  const sam = await store.createAgent({ networkId: network.id, firstName: 'Sam', lastName: 'Agent' });
  const bucket = new FakeBucket();
  let n = 0;
  const routes = reseauRoutes(options.pieces === false ? {} : { pieces: new R2AgentPieceStore(bucket, () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`) });
  const agent = (id: string): Viewer => ({ role: 'agent', userId: id, networkId: network.id });
  const direction: Viewer = { role: 'direction', userId: 'dir-1', networkId: network.id };
  const call = async (viewer: Viewer, method: 'GET' | 'POST', path: string, body?: { bytes: Uint8Array; type: string }) => {
    const bare = path.split('?')[0]!;
    const route = routes.find((r) => r.method === method && r.pattern.test(bare));
    if (!route) throw new Error(`route inconnue ${method} ${path}`);
    const params = (route.pattern.exec(bare) ?? []).slice(1);
    const request = new Request(`https://api.exemple.test/v1${path}`, body === undefined ? { method } : { method, headers: { 'content-type': body.type }, body: body.bytes });
    const response = await route.handle({ db, journal, now }, viewer, params, request);
    return { status: response.status, body: (await response.json()) as { ok: boolean; data?: any; code?: string; rule?: string | null } };
  };
  const deposit = (viewer: Viewer, agentId: string, query: string, bytes: Uint8Array, type: string) => call(viewer, 'POST', `/reseau/agents/${agentId}/pieces/fichier?${query}`, { bytes, type });
  const pieces = async () => db.all<{ kind: string; ref: string; version: number }>('SELECT kind, ref, version FROM agent_file_pieces ORDER BY recorded_at, version');
  return { db, journal, network, alex, sam, bucket, agent, direction, call, deposit, pieces };
}

describeWithSqlite('AU024 · chaque pièce manquante se dépose depuis l’écran d’intégration', () => {
  it('[R82] constat : sans fichier déjà rangé ailleurs, l’agent n’avait aucun moyen de déposer sa pièce ; il dépose maintenant le fichier même', async () => {
    const t = await setup();
    const before = await t.call(t.agent(t.alex.id), 'GET', '/reseau/mon-dossier');
    expect(before.body.data.lines.find((l: { kind: string }) => l.kind === 'assurance_rcp').state).toBe('manquante');
    const r = await t.deposit(t.agent(t.alex.id), t.alex.id, 'kind=assurance_rcp&issuedOn=2027-01-05&validUntil=2027-12-31', PDF, 'application/pdf');
    expect(r.status).toBe(200);
    // L'accusé de réception : la pièce, sa version, l'heure et le poids ; jamais la référence.
    expect(r.body.data.receipt).toEqual({ kind: 'assurance_rcp', label: 'Assurance de responsabilité civile professionnelle', version: 1, receivedAt: '2027-07-12T08:00:00.000Z', bytes: PDF.length });
    expect(JSON.stringify(r.body)).not.toContain('agents/');
    expect(r.body.data.lines.find((l: { kind: string }) => l.kind === 'assurance_rcp')).toMatchObject({ state: 'valide', validUntil: '2027-12-31' });
    // Le fichier est rangé tel quel, sous un nom tiré au hasard, avec son type.
    const [ref, stored] = [...t.bucket.objects.entries()][0]!;
    expect(ref).toBe(`agents/${t.alex.id}/00000000-0000-4000-8000-000000000001.pdf`);
    expect(stored).toEqual({ value: PDF, type: 'application/pdf' });
    expect(await t.pieces()).toEqual([{ kind: 'assurance_rcp', ref, version: 1 }]);
    // Le journal dit la pièce rangée, sans référence ni nom [R13].
    const events = await t.journal.all();
    expect(events.find((e) => e.type === 'dossier_agent.piece_rangee')).toMatchObject({ actor: `agent:${t.alex.id}`, data: { kind: 'assurance_rcp', version: 1 } });
    expect(JSON.stringify(events)).not.toContain(ref);
  });

  it('[R82] une photo JPEG ou PNG prise au téléphone passe ; une nouvelle version s’ajoute, la dernière compte ; la vigilance garde sa date calculée', async () => {
    const t = await setup();
    expect((await t.deposit(t.agent(t.alex.id), t.alex.id, 'kind=immatriculation_rsac&issuedOn=2027-02-01', JPG, 'image/jpeg')).status).toBe(200);
    const again = await t.deposit(t.agent(t.alex.id), t.alex.id, 'kind=immatriculation_rsac&issuedOn=2027-03-01', PNG, 'image/png');
    expect(again.body.data.receipt).toMatchObject({ kind: 'immatriculation_rsac', version: 2 });
    const vig = await t.deposit(t.agent(t.alex.id), t.alex.id, 'kind=attestation_vigilance&issuedOn=2027-07-01', PDF, 'application/pdf');
    expect(vig.body.data.lines.find((l: { kind: string }) => l.kind === 'attestation_vigilance')).toMatchObject({ state: 'valide', validUntil: '2027-12-31' });
    expect([...t.bucket.objects.keys()].map((k) => k.split('.').pop())).toEqual(['jpg', 'png', 'pdf']);
  });

  it('[R82] [R15] tout est vérifié avant que rien ne soit rangé : type, premiers octets, poids, pièce, dates', async () => {
    const t = await setup();
    const me = t.agent(t.alex.id);
    const cases: [string, Uint8Array, string, number, string][] = [
      ['kind=assurance_rcp&issuedOn=2027-01-05&validUntil=2027-12-31', PDF, 'text/html', 400, 'bad_file_type'],
      ['kind=assurance_rcp&issuedOn=2027-01-05&validUntil=2027-12-31', JPG, 'application/pdf', 400, 'bad_file'],
      ['kind=assurance_rcp&issuedOn=2027-01-05&validUntil=2027-12-31', new Uint8Array(0), 'application/pdf', 400, 'empty_file'],
      ['kind=assurance_rcp&issuedOn=2027-01-05', PDF, 'application/pdf', 409, 'valid_until_required'],
      ['kind=assurance_rcp&issuedOn=2027-09-01&validUntil=2027-12-31', PDF, 'application/pdf', 400, 'bad_date'],
      ['kind=contrat_agent_commercial&issuedOn=2027-01-05&validUntil=2027-12-31', PDF, 'application/pdf', 400, 'bad_valid_until'],
      ['kind=piece_identite&issuedOn=2027-01-05', PDF, 'application/pdf', 409, 'forbidden_piece'],
      ['kind=tout&issuedOn=2027-01-05', PDF, 'application/pdf', 404, 'unknown_piece'],
    ];
    for (const [q, bytes, type, status, code] of cases) expect(await t.deposit(me, t.alex.id, q, bytes, type)).toMatchObject({ status, body: { code } });
    const big = new Uint8Array(AGENT_PIECE_MAX_BYTES + 1);
    big.set(PDF);
    expect(await t.deposit(me, t.alex.id, 'kind=assurance_rcp&issuedOn=2027-01-05&validUntil=2027-12-31', big, 'application/pdf')).toMatchObject({ status: 413, body: { code: 'file_too_large' } });
    expect(t.bucket.objects.size).toBe(0);
    expect(await t.pieces()).toEqual([]);
  });

  it('[R16] un agent ne dépose que dans son propre dossier ; la direction le fait pour lui ; sans stockage, le dépôt est dit fermé', async () => {
    const t = await setup();
    expect(await t.deposit(t.agent(t.sam.id), t.alex.id, 'kind=immatriculation_rsac&issuedOn=2027-02-01', PDF, 'application/pdf')).toMatchObject({ status: 403, body: { rule: 'R16' } });
    expect((await t.deposit(t.direction, t.alex.id, 'kind=immatriculation_rsac&issuedOn=2027-02-01', PDF, 'application/pdf')).status).toBe(200);
    await t.db.run("UPDATE agents SET status = 'left' WHERE id = ?", [t.sam.id]);
    expect((await t.deposit(t.agent(t.sam.id), t.sam.id, 'kind=immatriculation_rsac&issuedOn=2027-02-01', PDF, 'application/pdf')).status).toBe(403);
    expect(t.bucket.objects.size).toBe(1);
    const u = await setup({ pieces: false });
    expect(await u.deposit(u.agent(u.alex.id), u.alex.id, 'kind=immatriculation_rsac&issuedOn=2027-02-01', PDF, 'application/pdf')).toMatchObject({ status: 503, body: { code: 'unavailable' } });
  });
});
