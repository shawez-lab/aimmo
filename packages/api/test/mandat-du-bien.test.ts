import { createHash } from 'node:crypto';
import { beforeEach, expect, it } from 'vitest';
import { Acces, FicheClient, FicheUnique, SqlJournalStore, applyMigrations, type Viewer } from '@aimmo/core';
import { identiteAuCoffre } from '../../core/test/identite-coffre.ts';
import { loadMigrations } from '../../core/test/migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from '../../core/test/sqlite.ts';
import { fromD1 } from '../src/d1.ts';
import { sha256Hex } from '../src/index.ts';
import worker, { type Env } from '../src/worker.ts';
import { fakeD1 } from './fake-d1.ts';

// Clés, personnes et biens inventés.
const BASE = 'https://aimmo-api.example.workers.dev';
const KEYS = { alex: 'test-cle-mandat-alex-aaaaaaaaaaaaaaaaaaaaaaaaaaaa', sam: 'test-cle-mandat-sam-bbbbbbbbbbbbbbbbbbbbbbbbbbbbb', direction: 'test-cle-mandat-direction-ccccccccccccccccccccc', compliance: 'test-cle-mandat-conformite-dddddddddddddddddddd', partner: 'test-cle-mandat-partenaire-eeeeeeeeeeeeeeeeeeee' };
const PDF = new TextEncoder().encode('%PDF-1.7 mandat inventé');
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

async function world(withStore = true, writable = true) {
  const d1 = fakeD1(openMemoryDatabase());
  const db = fromD1(d1);
  await applyMigrations(db, loadMigrations());
  const store = new FicheClient(db);
  const network = await store.createNetwork('Réseau test');
  const alex = await store.createAgent({ networkId: network.id, firstName: 'Alex', lastName: 'Agent' });
  const sam = await store.createAgent({ networkId: network.id, firstName: 'Sam', lastName: 'Autre' });
  const lea = await store.createPerson({ networkId: network.id, agentId: alex.id, firstName: 'Léa', lastName: 'Exemple' });
  const bien = await store.createProperty({ networkId: network.id, agentId: alex.id, reference: 'REF-M-1', kind: 'home', postalCode: '21000', city: 'Dijon', surfaceM2: 80, priceEur: 200000, status: 'draft' });
  const project = await store.createProject({ networkId: network.id, agentId: alex.id, personId: lea.id, kind: 'sell' });
  await store.linkProjectProperty({ networkId: network.id, agentId: alex.id, projectId: project.id, propertyId: bien.id, role: 'owned' });
  const keys = await Promise.all(
    [
      { key: KEYS.alex, role: 'agent', userId: alex.id },
      { key: KEYS.sam, role: 'agent', userId: sam.id },
      { key: KEYS.direction, role: 'direction', userId: 'direction-1' },
      { key: KEYS.compliance, role: 'compliance', userId: 'conformite-1' },
      { key: KEYS.partner, role: 'partner', userId: 'partenaire-1' },
    ].map(async ({ key, ...rest }) => ({ sha256: await sha256Hex(key), networkId: network.id, ...rest })),
  );
  const kept = new Map<string, Uint8Array>();
  const bucket = { head: async (k: string) => (kept.has(k) ? {} : null), ...(writable ? { put: async (k: string, v: Uint8Array) => void kept.set(k, v) } : {}) };
  const env: Env = { DB: d1, MODE: 'essai', API_KEYS: JSON.stringify(keys), ...(withStore ? { PIECES: bucket as never } : {}) };
  const call = (path: string, key: string, init: RequestInit = {}) => worker.fetch(new Request(`${BASE}/v1${path}`, { ...init, headers: { authorization: `Bearer ${key}`, ...(init.headers as Record<string, string>) } }), env);
  const post = (path: string, key: string, body: unknown = {}) => call(path, key, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const scan = (key: string, body: Uint8Array = PDF, type = 'application/pdf', hash = sha(body)) => call(`/biens/${bien.id}/scans-mandat`, key, { method: 'POST', headers: { 'content-type': type, 'x-aimmo-sha256': hash }, body });
  const journal = new SqlJournalStore(db);
  return { db, store, network, alex, sam, lea, bien, project, kept, env, call, post, scan, journal };
}

/** Un mandat généré, avec identité vérifiée et registre réglé : prêt à signer. */
async function ready(w: Awaited<ReturnType<typeof world>>) {
  const template = (await (await w.post('/modeles', KEYS.direction, { kind: 'mandat_vente_simple', body: 'Test : {{mandant.nom}}, {{honoraires.montant}} {{honoraires.charge}} {{registre.numero}} {{signature.date}} {{mandat.duree_mois}}' })).json()) as { data: { id: string } };
  await w.post(`/modeles/${template.data.id}/validation`, KEYS.compliance);
  await w.post('/honoraires/bareme', KEYS.direction, { maxRatePercent: 5, minEur: 3000 });
  await w.post('/registre/reglage', KEYS.direction, { prefix: 'T-', firstNumber: 1, width: 3 });
  const acces = new Acces(w.db, w.store, new FicheUnique(w.db, w.store), w.journal);
  await identiteAuCoffre({ db: w.db, acces, journal: w.journal, now: () => new Date() }, { role: 'agent', userId: w.alex.id, networkId: w.network.id } as Viewer, w.lea.id, { piece: 'carte_identite', seenAt: new Date() });
  const made = await w.post('/documents', KEYS.alex, { kind: 'mandat_vente_simple', personId: w.lea.id, propertyId: w.bien.id, inputs: { 'honoraires.montant': 9000, 'honoraires.charge': 'vendeur', 'mandat.duree_mois': 3 } });
  const doc = (await made.json()) as { data: { id: string; status: string; missing: string[] } };
  return doc.data;
}

describeWithSqlite('D11 · lire et déposer depuis le téléphone', () => {
  let w: Awaited<ReturnType<typeof world>>;
  beforeEach(async () => {
    w = await world();
  });

  it('[R16] seuls l’agent du bien, la direction et la conformité lisent ; refus au journal ; un autre réseau n’existe pas', async () => {
    const path = `/biens/${w.bien.id}/mandat`;
    for (const key of [KEYS.alex, KEYS.direction, KEYS.compliance]) expect((await w.call(path, key)).status).toBe(200);
    expect((await w.call(path, KEYS.sam)).status).toBe(403);
    expect((await w.call(path, KEYS.partner)).status).toBe(403);
    expect((await w.call('/biens/inconnu/mandat', KEYS.direction)).status).toBeGreaterThanOrEqual(403);
    const refused = (await w.journal.all()).filter((e) => e.type === 'acces.refuse' && String(e.subject).startsWith('property:'));
    expect(refused.length).toBeGreaterThanOrEqual(2);
  });

  it('[R16] le mandant possible : la fiche liée au bien comme propriétaire, jamais un acquéreur intéressé, jamais la fiche d’un autre agent', async () => {
    const buyer = await w.store.createPerson({ networkId: w.network.id, agentId: w.alex.id, firstName: 'Basile', lastName: 'Acquéreur' });
    const wants = await w.store.createProject({ networkId: w.network.id, agentId: w.alex.id, personId: buyer.id, kind: 'buy' });
    await w.store.linkProjectProperty({ networkId: w.network.id, agentId: w.alex.id, projectId: wants.id, propertyId: w.bien.id, role: 'interested' });
    const shared = await w.store.createPerson({ networkId: w.network.id, agentId: w.sam.id, firstName: 'Sacha', lastName: 'Autre' });
    const theirs = await w.store.createProject({ networkId: w.network.id, agentId: w.sam.id, personId: shared.id, kind: 'sell' });
    await w.db.run(`INSERT INTO project_properties (project_id, property_id, network_id, agent_id, role, created_at) VALUES (?, ?, ?, ?, 'owned', ?)`, [theirs.id, w.bien.id, w.network.id, w.sam.id, new Date().toISOString()]);
    const owners = async (key: string) => ((await (await w.call(`/biens/${w.bien.id}/mandat`, key)).json()) as { data: { owners: { personId: string; firstName: string }[] } }).data.owners.map((o) => o.firstName).sort();
    expect(await owners(KEYS.alex)).toEqual(['Léa']);
    expect(await owners(KEYS.direction)).toEqual(['Léa', 'Sacha']);
  });

  it('[R16] le dépôt : l’agent du bien ou la direction, droits vérifiés avant de lire un octet ; la conformité et un autre agent sont refusés', async () => {
    let read = false;
    const stream = new ReadableStream<Uint8Array>({ pull(c) { read = true; c.enqueue(PDF); c.close(); } }, { highWaterMark: 0 });
    const refused = await w.call(`/biens/${w.bien.id}/scans-mandat`, KEYS.sam, { method: 'POST', headers: { 'content-type': 'application/pdf', 'x-aimmo-sha256': sha(PDF) }, body: stream, duplex: 'half' } as RequestInit);
    expect(refused.status).toBe(403);
    expect(read).toBe(false);
    expect((await w.scan(KEYS.compliance)).status).toBe(403);
    expect((await w.scan(KEYS.partner)).status).toBe(403);
    expect(w.kept.size).toBe(0);
    const ok = await w.scan(KEYS.direction);
    expect(ok.status).toBe(200);
    const { data } = (await ok.json()) as { data: { ref: string; sha256: string; size: number } };
    expect(data.ref).toMatch(new RegExp(`^mandats/${w.bien.id}/[0-9a-f-]{36}\\.pdf$`));
    expect(data).toMatchObject({ sha256: sha(PDF), size: PDF.length });
    expect(w.kept.get(data.ref)).toEqual(PDF);
  });

  it('[R13] type confirmé par les premiers octets, empreinte recalculée, fichier vide, stockage en panne ; ni contenu ni nom au journal', async () => {
    const code = async (r: Response) => [r.status, ((await r.json()) as { code: string }).code];
    const notPdf = new TextEncoder().encode('<html>faux</html>');
    expect(await code(await w.scan(KEYS.alex, notPdf))).toEqual([415, 'type_refuse']);
    expect(await code(await w.scan(KEYS.alex, PDF, 'text/html'))).toEqual([415, 'type_refuse']);
    expect(await code(await w.scan(KEYS.alex, PDF, 'application/pdf', 'a'.repeat(64)))).toEqual([400, 'empreinte_differente']);
    expect(await code(await w.scan(KEYS.alex, PDF, 'application/pdf', 'x'))).toEqual([400, 'empreinte_absente']);
    expect(w.kept.size).toBe(0);
    expect((await w.scan(KEYS.alex)).status).toBe(200);
    const lines = JSON.stringify((await w.journal.all()).filter((e) => e.type.startsWith('mandat.depot')));
    expect(lines).toContain('empreinte_differente');
    expect(lines).not.toMatch(/mandat inventé|Léa|Exemple/);
    const closed = await world(false);
    expect(await code(await closed.scan(KEYS.alex))).toEqual([503, 'depot_ferme']);
    const readOnly = await world(true, false);
    expect(await code(await readOnly.scan(KEYS.alex))).toEqual([503, 'stockage_indisponible']);
    expect((await closed.call(`/biens/${closed.bien.id}/mandat`, KEYS.alex)).status).toBe(200);
  });

  it('[R10] un scan absent du stockage ou d’un autre bien est refusé ; le scan déposé signe, et la lecture rend le numéro, sans contenu', async () => {
    const doc = await ready(w);
    const other = await w.store.createProperty({ networkId: w.network.id, agentId: w.alex.id, reference: 'REF-M-2', kind: 'home', postalCode: '21000', city: 'Dijon', surfaceM2: 50, priceEur: 100000, status: 'draft' });
    const paper = (scanRef: string) => ({ signedAt: new Date(Date.now() - 60_000).toISOString(), place: 'agence', scanRef, source: 'referral' });
    const sign = (scanRef: string) => w.post(`/documents/${doc.id}/signature-papier`, KEYS.alex, paper(scanRef));
    const code = async (r: Response) => [r.status, ((await r.json()) as { code: string }).code];
    expect(await code(await sign(`mandats/${w.bien.id}/absent.pdf`))).toEqual([400, 'scan_absent']);
    w.kept.set(`mandats/${other.id}/autre.pdf`, PDF);
    expect(await code(await sign(`mandats/${other.id}/autre.pdf`))).toEqual([400, 'bad_scan']);
    expect(await w.db.first('SELECT count(*) AS n FROM signed_documents')).toEqual({ n: 0 });

    const { data } = (await (await w.scan(KEYS.alex)).json()) as { data: { ref: string } };
    const signed = await sign(data.ref);
    expect(signed.status).toBe(200);
    const read = (await (await w.call(`/biens/${w.bien.id}/mandat`, KEYS.alex)).json()) as { data: { documents: Record<string, any>[]; mandate: Record<string, unknown> } };
    expect(read.data.documents).toHaveLength(1);
    expect(read.data.documents[0]).toMatchObject({ id: doc.id, kind: 'mandat_vente_simple', mode: 'reel', signature: { place: 'agence', number: 'T-001' } });
    expect(read.data.documents[0]).not.toHaveProperty('content');
    expect(read.data.documents[0]).not.toHaveProperty('person_id');
    expect(read.data.mandate).toMatchObject({ id: `m-${doc.id}`, number: 'T-001' });
    expect(JSON.stringify(read.data.documents)).not.toContain('Test :');
  });

  it('[R10] sans stockage, un document réel ne se signe pas : il faut un scan', async () => {
    const closed = await world(false);
    const doc = await ready(closed);
    const r = await closed.post(`/documents/${doc.id}/signature-papier`, KEYS.alex, { signedAt: new Date(Date.now() - 60_000).toISOString(), place: 'agence', scanRef: `mandats/${closed.bien.id}/x.pdf`, source: 'referral' });
    expect(r.status).toBe(503);
    expect(await closed.db.first('SELECT count(*) AS n FROM signed_documents')).toEqual({ n: 0 });
  });

  it('un bien sans document : listes vides, aucun mandat', async () => {
    const empty = (await (await w.call(`/biens/${w.bien.id}/mandat`, KEYS.alex)).json()) as { data: unknown };
    expect(empty.data).toMatchObject({ propertyId: w.bien.id, documents: [], mandate: null });
  });
});
