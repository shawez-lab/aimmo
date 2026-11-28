import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { Acces, FicheClient, FicheUnique, SqlJournalStore, applyMigrations, type Viewer } from '@aimmo/core';
import { identiteAuCoffre } from '../../core/test/identite-coffre.ts';
import { loadMigrations } from '../../core/test/migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from '../../core/test/sqlite.ts';
import { fromD1 } from '../src/d1.ts';
import { sha256Hex } from '../src/index.ts';
import worker, { type Env } from '../src/worker.ts';
import { fakeD1 } from './fake-d1.ts';
import { designerTout } from '../../core/test/designation-jeu.ts';
import { signRentalMandate } from '../../core/test/mandat-location-jeu.ts';

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
  const template = (await (await w.post('/modeles', KEYS.direction, { kind: 'mandat_vente_simple', body: 'Test : {{mandant.nom}}, {{honoraires.montant}} {{honoraires.charge}} {{registre.numero}} · {{bien.adresse}} · {{bien.cadastre}} · {{mandant.domicile}} {{signature.date}} {{mandat.duree_mois}}' })).json()) as { data: { id: string } };
  await w.post(`/modeles/${template.data.id}/validation`, KEYS.compliance);
  await w.post('/honoraires/bareme', KEYS.direction, { maxRatePercent: 5, minEur: 3000 });
  await w.post('/registre/reglage', KEYS.direction, { prefix: 'T-', firstNumber: 1, width: 3 });
  const acces = new Acces(w.db, w.store, new FicheUnique(w.db, w.store), w.journal);
  await identiteAuCoffre({ db: w.db, acces, journal: w.journal, now: () => new Date() }, { role: 'agent', userId: w.alex.id, networkId: w.network.id } as Viewer, w.lea.id, { piece: 'carte_identite', seenAt: new Date() });
  await designerTout(w.db);
  const made = await w.post('/documents', KEYS.alex, { kind: 'mandat_vente_simple', personId: w.lea.id, propertyId: w.bien.id, inputs: { 'honoraires.montant': 9000, 'honoraires.charge': 'vendeur', 'mandat.duree_mois': 3 } });
  const doc = (await made.json()) as { data: { id: string; status: string; missing: string[] } };
  return doc.data;
}

describeWithSqlite('D11 · lire et déposer depuis le téléphone', () => {
  let w: Awaited<ReturnType<typeof world>>;
  beforeEach(async () => {
    w = await world();
  });

  it('[R16] seuls l’agent du bien, la direction et la conformité lisent ; refus au journal ; un autre réseau est refusé', async () => {
    const path = `/biens/${w.bien.id}/mandat`;
    for (const key of [KEYS.alex, KEYS.direction, KEYS.compliance]) expect((await w.call(path, key)).status).toBe(200);
    expect((await w.call(path, KEYS.sam)).status).toBe(403);
    expect((await w.call(path, KEYS.partner)).status).toBe(403);
    expect((await w.call('/biens/inconnu/mandat', KEYS.direction)).status).toBe(404);
    // Une direction d'un autre réseau, en lecture comme en dépôt.
    const foreign = await w.store.createNetwork('Autre réseau');
    const key = 'test-cle-mandat-ailleurs-fffffffffffffffffffffffff';
    const all = JSON.parse(w.env.API_KEYS as string) as unknown[];
    w.env.API_KEYS = JSON.stringify([...all, { sha256: await sha256Hex(key), networkId: foreign.id, role: 'direction', userId: 'direction-2' }]);
    expect((await w.call(path, key)).status).toBe(403);
    expect((await w.scan(key)).status).toBe(403);
    expect(w.kept.size).toBe(0);
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

  it('[R10] un scan prouve une seule signature ; l’index ferme la course', async () => {
    const first = await ready(w);
    await designerTout(w.db);
    const second = ((await (await w.post('/documents', KEYS.alex, { kind: 'mandat_vente_simple', personId: w.lea.id, propertyId: w.bien.id, inputs: { 'honoraires.montant': 9000, 'honoraires.charge': 'vendeur', 'mandat.duree_mois': 3 } })).json()) as { data: { id: string } }).data;
    const { data } = (await (await w.scan(KEYS.alex)).json()) as { data: { ref: string } };
    const paper = { signedAt: new Date(Date.now() - 60_000).toISOString(), place: 'agence', scanRef: data.ref, source: 'referral' };
    expect((await w.post(`/documents/${first.id}/signature-papier`, KEYS.alex, paper)).status).toBe(200);
    const again = await w.post(`/documents/${second.id}/signature-papier`, KEYS.alex, paper);
    expect(again.status).toBe(400);
    expect(((await again.json()) as { code: string }).code).toBe('scan_deja_utilise');
    await expect(w.db.run(`INSERT INTO signed_documents (document_id, network_id, signed_at, place, scan_ref, registered_by, created_at) VALUES (?, ?, ?, 'agence', ?, 'x', ?)`, [second.id, w.network.id, paper.signedAt, data.ref, paper.signedAt])).rejects.toThrow();
  });

  it('[R38] une signature arrêtée en route n’est pas dite signée, et reprend avec son scan, même retiré du stockage ou sans stockage', async () => {
    const doc = await ready(w);
    const { data } = (await (await w.scan(KEYS.alex)).json()) as { data: { ref: string } };
    const paper = { signedAt: new Date(Date.now() - 60_000).toISOString(), place: 'agence', scanRef: data.ref };
    const sign = (env: Env, body: unknown) => worker.fetch(new Request(`${BASE}/v1/documents/${doc.id}/signature-papier`, { method: 'POST', headers: { authorization: `Bearer ${KEYS.alex}`, 'content-type': 'application/json' }, body: JSON.stringify(body) }), env);
    expect((await sign(w.env, paper)).status).toBe(400);
    const read = async () => ((await (await w.call(`/biens/${w.bien.id}/mandat`, KEYS.alex)).json()) as { data: { documents: { signature: Record<string, unknown> | null }[]; mandate: unknown } }).data;
    const stopped = await read();
    expect(stopped.documents[0]!.signature).toMatchObject({ complete: false, number: null });
    expect(stopped.mandate).toBeNull();
    // Le scan a disparu, plus de stockage : la reprise ne le redemande pas, elle garde celui de la première demande.
    w.kept.clear();
    const noStore: Env = { ...w.env };
    delete noStore.PIECES;
    expect((await sign(noStore, { ...paper, scanRef: `mandats/${w.bien.id}/autre.pdf`, source: 'referral' })).status).toBe(200);
    expect(await w.db.first('SELECT scan_ref FROM signed_documents WHERE document_id = ?', [doc.id])).toEqual({ scan_ref: data.ref });
    expect((await read()).documents[0]!.signature).toMatchObject({ complete: true, number: 'T-001' });
  });

  it('un avenant signé est dit signé, avec le numéro de son mandat', async () => {
    const doc = await ready(w);
    const { data } = (await (await w.scan(KEYS.alex)).json()) as { data: { ref: string } };
    const at = new Date(Date.now() - 60_000).toISOString();
    expect((await w.post(`/documents/${doc.id}/signature-papier`, KEYS.alex, { signedAt: at, place: 'agence', scanRef: data.ref, source: 'referral' })).status).toBe(200);
    const template = await w.db.first<{ id: string; version: number; hash: string }>('SELECT template_id AS id, template_version AS version, template_hash AS hash FROM documents WHERE id = ?', [doc.id]);
    await w.db.run(
      `INSERT INTO documents (id, network_id, template_id, template_version, template_hash, kind, mode, status, missing, agent_id, person_id, property_id, content, content_hash, created_by, created_at) VALUES ('avt-1', ?, ?, ?, ?, 'avenant_mandat', 'reel', 'complet', '[]', ?, ?, ?, 'x', 'h', 'test', ?)`,
      [w.network.id, template!.id, template!.version, template!.hash, w.alex.id, w.lea.id, w.bien.id, new Date().toISOString()],
    );
    await w.db.run(`INSERT INTO signed_amendments (document_id, network_id, mandate_id, signed_at, place, scan_ref, copy_content, copy_hash, registered_by, created_at) VALUES ('avt-1', ?, ?, ?, 'agence', 'mandats/a.pdf', 'x', 'h', 'test', ?)`, [w.network.id, `m-${doc.id}`, at, at]);
    const read = (await (await w.call(`/biens/${w.bien.id}/mandat`, KEYS.alex)).json()) as { data: { documents: { id: string; signature: unknown }[] } };
    expect(read.data.documents.find((d) => d.id === 'avt-1')!.signature).toEqual({ signedAt: at, place: 'agence', number: 'T-001', complete: true });
  });

  it('[R16] deux fiches réunies du même agent ne font qu’un mandant', async () => {
    const double = await w.store.createPerson({ networkId: w.network.id, agentId: w.alex.id, firstName: 'Léa', lastName: 'Double' });
    const project = await w.store.createProject({ networkId: w.network.id, agentId: w.alex.id, personId: double.id, kind: 'sell' });
    await w.store.linkProjectProperty({ networkId: w.network.id, agentId: w.alex.id, projectId: project.id, propertyId: w.bien.id, role: 'owned' });
    await new FicheUnique(w.db, w.store).merge({ survivorId: w.lea.id, mergedId: double.id, reason: 'test' });
    const read = (await (await w.call(`/biens/${w.bien.id}/mandat`, KEYS.alex)).json()) as { data: { owners: { personId: string }[] } };
    expect(read.data.owners).toEqual([{ personId: w.lea.id, firstName: 'Léa', lastName: 'Exemple', domicile: null }]);
  });

  describe('D16', () => {
    const day = (ago: number) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris' }).format(new Date(Date.now() - ago * 86_400_000));
    const sign = async (doc: { id: string }, ago: number, place: string) => {
      const { data } = (await (await w.scan(KEYS.alex)).json()) as { data: { ref: string } };
      const signedAt = new Date(Date.now() - ago * 86_400_000 - 60_000).toISOString();
      expect((await w.post(`/documents/${doc.id}/signature-papier`, KEYS.alex, { signedAt, place, scanRef: data.ref, source: 'referral' })).status).toBe(200);
    };
    const mandate = async () => ((await (await w.call(`/biens/${w.bien.id}/mandat`, KEYS.alex)).json()) as { data: { mandate: { id: string; reason: string; allowed: boolean; withdrawalLastDay: string | null; withdrawalUnfinished: boolean } } }).data.mandate;
    const code = async (r: Response) => [r.status, ((await r.json()) as { code: string }).code];

    it('[R16, R42] le délai est lu ; l’agent du mandat note, la diffusion suit, un nouveau mandat se signe ; autre agent et conformité refusés', async () => {
      await sign(await ready(w), 0, 'hors_agence');
      const before = await mandate();
      expect(before).toMatchObject({ reason: 'withdrawal_period', allowed: false, withdrawalUnfinished: false });
      expect(before.withdrawalLastDay).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      const early = (key: string) => w.post(`/mandats/${before.id}/debut-anticipe`, key, { proof: 'Mail reçu', receivedOn: day(0) });
      const stop = (key: string) => w.post(`/mandats/${before.id}/retractation`, key, { proof: 'Lettre reçue', sentOn: day(0) });
      for (const key of [KEYS.sam, KEYS.compliance]) {
        expect((await early(key)).status).toBe(403);
        expect((await stop(key)).status).toBe(403);
      }
      expect((await mandate()).reason).toBe('withdrawal_period');
      expect((await early(KEYS.alex)).status).toBe(200);
      expect(await mandate()).toMatchObject({ reason: 'allowed_early_start', allowed: true });
      expect((await early(KEYS.alex)).status).toBe(409);
      expect((await stop(KEYS.alex)).status).toBe(200);
      expect(await mandate()).toMatchObject({ reason: 'withdrawn', allowed: false, withdrawalUnfinished: false });
      expect((await stop(KEYS.alex)).status).toBe(409);
      // Le bien se rouvre jusqu'à la signature d'un second mandat, pas seulement jusqu'au contrôle.
      await designerTout(w.db);
      const made = ((await (await w.post('/documents', KEYS.alex, { kind: 'mandat_vente_simple', personId: w.lea.id, propertyId: w.bien.id, inputs: { 'honoraires.montant': 9000, 'honoraires.charge': 'vendeur', 'mandat.duree_mois': 12 } })).json()) as { data: { id: string } }).data;
      await sign(made, 0, 'agence');
      expect(await mandate()).toMatchObject({ allowed: true, reason: 'allowed' });
    });

    // Le jour d'envoi le dernier jour et après le délai est prouvé à horloge fixée dans `core/test/retractation.test.ts`.
    it('[R42] par la route, l’envoi est un jour : à venir, avant la signature ou impossible, refusé et rien de noté ; le jour même, gardé', async () => {
      await sign(await ready(w), 0, 'hors_agence');
      const m = await mandate();
      const stop = (sentOn: unknown) => w.post(`/mandats/${m.id}/retractation`, KEYS.alex, { proof: 'Lettre recommandée', sentOn });
      for (const bad of [day(-2), day(2), '2027-02-31', 'hier', 12]) expect(await code(await stop(bad))).toEqual([400, 'bad_date']);
      expect((await mandate()).reason).toBe('withdrawal_period');
      expect((await stop(day(0))).status).toBe(200);
      expect((await mandate()).reason).toBe('withdrawn');
      expect(await w.db.first('SELECT sent_on FROM mandate_withdrawals WHERE mandate_id = ?', [m.id])).toEqual({ sent_on: day(0) });
    });

    it('[R42] une rétractation arrêtée avant l’annulation se lit et se finit par `resume`, droits compris', async () => {
      await sign(await ready(w), 0, 'hors_agence');
      const m = await mandate();
      const resume = (key: string) => w.post(`/mandats/${m.id}/retractation`, key, { resume: true });
      expect(await code(await resume(KEYS.alex))).toEqual([400, 'not_withdrawn']);
      await w.db.run(`INSERT INTO mandate_withdrawals (mandate_id, network_id, proof, received_at, sent_on, recorded_by, created_at) VALUES (?, ?, 'Lettre', ?, ?, 'x', ?)`, [m.id, w.network.id, new Date().toISOString(), day(0), new Date().toISOString()]);
      expect(await mandate()).toMatchObject({ reason: 'withdrawn', withdrawalUnfinished: true });
      expect((await resume(KEYS.sam)).status).toBe(403);
      expect((await w.post(`/mandats/${m.id}/retractation`, KEYS.alex, { resume: true, proof: 'x' })).status).toBe(400);
      expect((await resume(KEYS.alex)).status).toBe(200);
      expect(await mandate()).toMatchObject({ reason: 'withdrawn', withdrawalUnfinished: false });
      expect(await code(await resume(KEYS.alex))).toEqual([409, 'already_recorded']);
    });
  });

  it('[R42] D16 : signé à l’agence, aucun délai n’est lu et rien ne se note', async () => {
    const doc = await ready(w);
    const { data } = (await (await w.scan(KEYS.alex)).json()) as { data: { ref: string } };
    expect((await w.post(`/documents/${doc.id}/signature-papier`, KEYS.alex, { signedAt: new Date(Date.now() - 60_000).toISOString(), place: 'agence', scanRef: data.ref, source: 'referral' })).status).toBe(200);
    const read = (await (await w.call(`/biens/${w.bien.id}/mandat`, KEYS.alex)).json()) as { data: { mandate: { id: string; withdrawalLastDay: string | null } } };
    expect(read.data.mandate.withdrawalLastDay).toBeNull();
    const r = await w.post(`/mandats/${read.data.mandate.id}/retractation`, KEYS.alex, { proof: 'Lettre', sentOn: new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris' }).format(new Date()) });
    expect(r.status).toBe(400);
    expect(((await r.json()) as { code: string }).code).toBe('no_withdrawal_period');
  });

  it('un bien sans document : listes vides, aucun mandat', async () => {
    const empty = (await (await w.call(`/biens/${w.bien.id}/mandat`, KEYS.alex)).json()) as { data: unknown };
    expect(empty.data).toMatchObject({ propertyId: w.bien.id, documents: [], mandate: null, rental: null });
  });

  it('AU120 · [R42] la lecture résume aussi le mandat de location, par sa propre porte : en cours, à côté d’un mandat de vente, puis rétracté', async () => {
    type Summary = { id: string; number: string | null; signedAt: string | null; allowed: boolean; reason: string; withdrawalLastDay: string | null; withdrawalUnfinished: boolean } | null;
    const read = async () => ((await (await w.call(`/biens/${w.bien.id}/mandat`, KEYS.alex)).json()) as { data: { mandate: Summary; rental: Summary; documents: { kind: string; signature: { complete: boolean } | null }[] } }).data;
    const days = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();
    const base = { networkId: w.network.id, agentId: w.alex.id, personId: w.lea.id, propertyId: w.bien.id };
    // Le constat : le seul mandat signé du bien est un mandat de location. Avant, la lecture ne disait rien de lui.
    const signedAt = days(10);
    const rent = await signRentalMandate(w.db, { ...base, signedAt });
    const alone = await read();
    expect(alone.mandate).toBeNull();
    expect(alone.rental).toMatchObject({ id: rent, signedAt, allowed: true, reason: 'allowed', withdrawalLastDay: null, withdrawalUnfinished: false });
    expect(alone.rental?.number).toMatch(/^L-\d+$/);
    expect(alone.documents).toMatchObject([{ kind: 'mandat_location', signature: { complete: true } }]);
    // Un mandat de vente à côté : chacun a son résumé, l'un ne dit rien de l'autre.
    const sale = await signRentalMandate(w.db, { ...base, signedAt: days(5), kind: 'mandat_vente_simple' });
    const both = await read();
    expect(both.mandate).toMatchObject({ id: sale, allowed: true, reason: 'allowed' });
    expect(both.rental).toMatchObject({ id: rent, reason: 'allowed' });
    // Le bailleur se rétracte (la ligne est posée ici comme le ferait la route, le registre du jeu d'essai n'étant pas chaîné) :
    // le document garde sa signature, la lecture dit que le mandat de location est fini.
    await w.db.run("INSERT INTO mandate_withdrawals (mandate_id, network_id, proof, received_at, recorded_by, created_at) VALUES (?, ?, 'courrier test', ?, 'test', ?)", [rent, w.network.id, days(1), days(1)]);
    const after = await read();
    expect(after.rental).toMatchObject({ id: rent, allowed: false, reason: 'withdrawn' });
    expect(after.mandate).toMatchObject({ id: sale, reason: 'allowed' });
    expect(after.documents.filter((d) => d.kind === 'mandat_location')).toMatchObject([{ signature: { complete: true } }]);
  });

  it('AU120 · [R42] un mandat de location arrivé à échéance se lit échu', async () => {
    const days = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();
    const rent = await signRentalMandate(w.db, { networkId: w.network.id, agentId: w.alex.id, personId: w.lea.id, propertyId: w.bien.id, signedAt: days(400), months: 12 });
    const read = ((await (await w.call(`/biens/${w.bien.id}/mandat`, KEYS.alex)).json()) as { data: { mandate: unknown; rental: { id: string; allowed: boolean; reason: string } | null } }).data;
    expect(read.mandate).toBeNull();
    expect(read.rental).toMatchObject({ id: rent, allowed: false, reason: 'expired' });
    // La conformité lit le même résumé ; un autre agent n'en lit rien [R16].
    expect(((await (await w.call(`/biens/${w.bien.id}/mandat`, KEYS.compliance)).json()) as { data: { rental: { reason: string } } }).data.rental.reason).toBe('expired');
    expect((await w.call(`/biens/${w.bien.id}/mandat`, KEYS.sam)).status).toBe(403);
  });
});

describeWithSqlite('D14 · le scan d’un avenant vérifié comme celui du mandat', () => {
  let w: Awaited<ReturnType<typeof world>>;
  beforeEach(async () => {
    w = await world();
  });

  /** Un mandat signé et un avenant généré, prêt à signer ; le dépôt du scan reste à faire. */
  async function avenant() {
    const doc = await ready(w);
    const mandateScan = ((await (await w.scan(KEYS.alex)).json()) as { data: { ref: string } }).data.ref;
    // L'heure présente : deux minutes plus tôt, le test échouait autour de minuit, l'identité étant vue le lendemain.
    const signedAt = new Date().toISOString();
    expect((await w.post(`/documents/${doc.id}/signature-papier`, KEYS.alex, { signedAt, place: 'agence', scanRef: mandateScan, source: 'referral' })).status).toBe(200);
    const template = (await (await w.post('/modeles', KEYS.direction, { kind: 'avenant_mandat', body: 'Avenant au mandat n° {{mandat.numero}} : {{avenant.objet}}. Mandant : {{mandant.nom}}. {{signature.date}}, {{signature.lieu}}.' })).json()) as { data: { id: string } };
    await w.post(`/modeles/${template.data.id}/validation`, KEYS.compliance);
    const generate = async () => ((await (await w.post('/documents', KEYS.alex, { kind: 'avenant_mandat', personId: w.lea.id, propertyId: w.bien.id, mandateId: `m-${doc.id}`, inputs: { 'avenant.prix': 190000 } })).json()) as { data: { id: string; status: string } }).data;
    const made = await generate();
    expect(made.status).toBe('complet');
    const paper = (scanRef: string) => ({ signedAt: new Date().toISOString(), place: 'agence', scanRef });
    return { id: made.id, generate, mandateScan, paper };
  }
  const code = async (r: Response) => [r.status, ((await r.json()) as { code?: string }).code];
  const deposit = async () => ((await (await w.scan(KEYS.alex, new TextEncoder().encode(`%PDF-1.7 avenant ${Math.random()}`))).json()) as { data: { ref: string } }).data.ref;

  it('[R41] D17 : ce que l’écran envoie fait changer les conditions du mandat, en prix et en durée', async () => {
    const a = await avenant();
    const id = (await w.db.first<{ mandate_id: string }>('SELECT mandate_id FROM documents WHERE id = ?', [a.id]))!.mandate_id;
    const terms = async () => ((await (await w.call(`/mandats/${id}/conditions`, KEYS.alex)).json()) as { data: { priceEur: number; durationMonths: number; amendments: unknown[] } }).data;
    expect((await terms()).amendments).toEqual([]);
    const both = ((await (await w.post('/documents', KEYS.alex, { kind: 'avenant_mandat', personId: w.lea.id, propertyId: w.bien.id, mandateId: id, inputs: { 'avenant.prix': 185000, 'avenant.duree_mois': 18 } })).json()) as { data: { id: string; status: string } }).data;
    expect(both.status).toBe('complet');
    expect((await w.post(`/documents/${both.id}/controle`, KEYS.alex)).status).toBe(200);
    expect((await w.post(`/documents/${both.id}/signature-avenant`, KEYS.alex, a.paper(await deposit()))).status).toBe(200);
    expect(await terms()).toMatchObject({ priceEur: 185000, durationMonths: 18 });
    const again = await w.post(`/documents/${both.id}/signature-avenant`, KEYS.alex, a.paper(await deposit()));
    expect(await code(again)).toEqual([409, 'already_signed']);
    const other = await w.post('/documents', KEYS.sam, { kind: 'avenant_mandat', personId: w.lea.id, propertyId: w.bien.id, mandateId: id, inputs: { 'avenant.prix': 1 } });
    expect(other.status).toBe(403);
  });

  it('[R41] un scan déposé pour le bien du mandat fait signer l’avenant', async () => {
    const a = await avenant();
    const ref = await deposit();
    expect((await w.post(`/documents/${a.id}/signature-avenant`, KEYS.alex, a.paper(ref))).status).toBe(200);
    expect(await w.db.first('SELECT scan_ref FROM signed_amendments WHERE document_id = ?', [a.id])).toEqual({ scan_ref: ref });
  });

  it('[R16] la référence d’un autre bien, ou saisie à la main, est refusée, sans rien changer', async () => {
    const a = await avenant();
    const other = await w.store.createProperty({ networkId: w.network.id, agentId: w.alex.id, reference: 'REF-M-2', kind: 'home', postalCode: '21000', city: 'Dijon', surfaceM2: 50, priceEur: 100000, status: 'draft' });
    w.kept.set(`mandats/${other.id}/autre.pdf`, PDF);
    for (const ref of [`mandats/${other.id}/autre.pdf`, 'scans/a-la-main.pdf']) expect(await code(await w.post(`/documents/${a.id}/signature-avenant`, KEYS.alex, a.paper(ref)))).toEqual([400, 'bad_scan']);
    expect(await w.db.first('SELECT count(*) AS n FROM signed_amendments')).toEqual({ n: 0 });
  });

  it('[R10] un scan absent du stockage est refusé', async () => {
    const a = await avenant();
    expect(await code(await w.post(`/documents/${a.id}/signature-avenant`, KEYS.alex, a.paper(`mandats/${w.bien.id}/absent.pdf`)))).toEqual([400, 'scan_absent']);
    expect(await w.db.first('SELECT count(*) AS n FROM signed_amendments')).toEqual({ n: 0 });
  });

  it('[R10] un scan déjà utilisé, par le mandat ou par un autre avenant, est refusé', async () => {
    const a = await avenant();
    expect(await code(await w.post(`/documents/${a.id}/signature-avenant`, KEYS.alex, a.paper(a.mandateScan)))).toEqual([400, 'scan_deja_utilise']);
    const ref = await deposit();
    expect((await w.post(`/documents/${a.id}/signature-avenant`, KEYS.alex, a.paper(ref))).status).toBe(200);
    const second = await a.generate();
    expect(await code(await w.post(`/documents/${second.id}/signature-avenant`, KEYS.alex, a.paper(ref)))).toEqual([400, 'scan_deja_utilise']);
    expect(await w.db.first('SELECT count(*) AS n FROM signed_amendments')).toEqual({ n: 1 });
  });

  it('[R10] la base ferme la course : un scan ne passe ni deux fois en avenant, ni du mandat à l’avenant, ni de l’avenant au mandat', async () => {
    const a = await avenant();
    const ref = await deposit();
    expect((await w.post(`/documents/${a.id}/signature-avenant`, KEYS.alex, a.paper(ref))).status).toBe(200);
    const at = new Date().toISOString();
    const insertAmendment = (document: string, scan: string) =>
      w.db.run(`INSERT INTO signed_amendments (document_id, network_id, mandate_id, signed_at, place, scan_ref, copy_content, copy_hash, registered_by, created_at) SELECT ?, network_id, mandate_id, signed_at, place, ?, 'x', 'h', 'test', ? FROM signed_amendments WHERE document_id = ?`, [document, scan, at, a.id]);
    const second = await a.generate();
    await expect(insertAmendment(second.id, ref)).rejects.toThrow();
    await expect(insertAmendment(second.id, a.mandateScan)).rejects.toThrow();
    await expect(w.db.run(`INSERT INTO signed_documents (document_id, network_id, signed_at, place, scan_ref, registered_by, created_at) VALUES (?, ?, ?, 'agence', ?, 'x', ?)`, [second.id, w.network.id, at, ref, at])).rejects.toThrow();
  });

  it('[R10] sans stockage, rien ne se signe', async () => {
    const a = await avenant();
    const noStore: Env = { ...w.env };
    delete noStore.PIECES;
    const r = await worker.fetch(new Request(`${BASE}/v1/documents/${a.id}/signature-avenant`, { method: 'POST', headers: { authorization: `Bearer ${KEYS.alex}`, 'content-type': 'application/json' }, body: JSON.stringify(a.paper(`mandats/${w.bien.id}/x.pdf`)) }), noStore);
    expect(await code(r)).toEqual([503, 'depot_ferme']);
    expect(await w.db.first('SELECT count(*) AS n FROM signed_amendments')).toEqual({ n: 0 });
  });

  it('[R17] une reprise garde son scan, même retiré du stockage ou sans stockage', async () => {
    const a = await avenant();
    const ref = await deposit();
    expect((await w.post(`/documents/${a.id}/signature-avenant`, KEYS.alex, a.paper(ref))).status).toBe(200);
    w.kept.clear();
    expect(await code(await w.post(`/documents/${a.id}/signature-avenant`, KEYS.alex, a.paper(`mandats/${w.bien.id}/autre.pdf`)))).toEqual([409, 'already_signed']);
    const noStore: Env = { ...w.env };
    delete noStore.PIECES;
    const again = await worker.fetch(new Request(`${BASE}/v1/documents/${a.id}/signature-avenant`, { method: 'POST', headers: { authorization: `Bearer ${KEYS.alex}`, 'content-type': 'application/json' }, body: JSON.stringify(a.paper(`mandats/${w.bien.id}/autre.pdf`)) }), noStore);
    expect(await code(again)).toEqual([409, 'already_signed']);
    expect(await w.db.first('SELECT scan_ref FROM signed_amendments WHERE document_id = ?', [a.id])).toEqual({ scan_ref: ref });
  });
});

describeWithSqlite('D15 · annuler un mandat au registre', () => {
  it('[R16] [R39] la direction seule annule, avec un motif de la liste ; le bien se rouvre et rien n’est effacé', async () => {
    const w = await world();
    const doc = await ready(w);
    const { data } = (await (await w.scan(KEYS.alex)).json()) as { data: { ref: string } };
    const at = new Date(Date.now() - 60_000).toISOString();
    expect((await w.post(`/documents/${doc.id}/signature-papier`, KEYS.alex, { signedAt: at, place: 'agence', scanRef: data.ref, source: 'referral' })).status).toBe(200);
    await designerTout(w.db);
    const second = ((await (await w.post('/documents', KEYS.alex, { kind: 'mandat_vente_simple', personId: w.lea.id, propertyId: w.bien.id, inputs: { 'honoraires.montant': 9000, 'honoraires.charge': 'vendeur', 'mandat.duree_mois': 3 } })).json()) as { data: { id: string } }).data;
    const scan2 = ((await (await w.scan(KEYS.alex, new TextEncoder().encode('%PDF-1.7 second'))).json()) as { data: { ref: string } }).data.ref;
    const signSecond = () => w.post(`/documents/${second.id}/signature-papier`, KEYS.alex, { signedAt: at, place: 'agence', scanRef: scan2, source: 'referral' });
    const refused = await signSecond();
    expect([refused.status, ((await refused.json()) as { code: string }).code]).toEqual([400, 'mandate_in_force']);
    const path = `/mandats/m-${doc.id}/annulation`;
    expect((await w.post(path, KEYS.alex, { reason: 'error' })).status).toBe(403);
    for (const reason of ['withdrawal', 'autre', undefined]) expect((await w.post(path, KEYS.direction, { reason })).status).toBe(400);
    const done = await w.post(path, KEYS.direction, { reason: 'termination' });
    expect(done.status).toBe(200);
    expect((await w.post(path, KEYS.direction, { reason: 'termination' })).status).toBe(409);
    expect(await w.db.first(`SELECT count(*) AS n FROM mandate_register WHERE mandate_id = ?`, [`m-${doc.id}`])).toEqual({ n: 2 });
    expect((await signSecond()).status).toBe(200);
  });
});
