import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { FicheClient, SqlJournalStore, applyMigrations, fromSyncSqlite, type SqlDatabase, type Viewer } from '@aimmo/core';
import {
  MAX_UPLOAD_BYTES,
  PARTNER_SPACE_CSP,
  PARTNER_SPACE_FILES,
  handleEspacePartenaire,
  handlePartenairesPublic,
  partenairesRoutes,
  sortsFor,
  type PartenairesServices,
} from '../src/partenaires.ts';
import { loadMigrations } from '../../core/test/migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from '../../core/test/sqlite.ts';
import { fakeDocument, pageIds } from './fake-dom.ts';

// Réseau, agents, clients, bien, dossier de vente et partenaires inventés ; adresses sur des domaines d'exemple.
// Le 12 juillet 2027 est un lundi ; 8 h UTC, 10 h à Paris.
let clock = Date.parse('2027-07-12T08:00:00.000Z');
const DAY = 86_400_000;
let n = 0;
const uuid = (): string => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x0a, 0x25, 0x45, 0x4f, 0x46]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
const OPT_OUT = 'https://aimmo.example/partenaires/opposition/';

class FakeFiles {
  readonly refs = new Set<string>();
  readonly uploaded = new Map<string, { bytes: Uint8Array; type: string }>();
  put(prefix: string): string {
    const ref = `${prefix}/${uuid()}.pdf`;
    this.refs.add(ref);
    return ref;
  }
  async has(ref: string): Promise<boolean> {
    return this.refs.has(ref) || this.uploaded.has(ref);
  }
}

interface Call {
  json?: unknown;
  raw?: { bytes: Uint8Array; type: string };
  query?: string;
}

async function setup(options: { uploads?: boolean } = {}) {
  clock = Date.parse('2027-07-12T08:00:00.000Z');
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  const now = (): Date => new Date((clock += 1000));
  const journal = new SqlJournalStore(db);
  const store = new FicheClient(db, { now });
  const files = new FakeFiles();
  const uploads = {
    async put(ref: string, bytes: Uint8Array, type: string) {
      files.uploaded.set(ref, { bytes, type });
    },
  };
  const s: PartenairesServices = { db, journal, now, files, uploads: options.uploads === false ? null : uploads, newId: uuid, optOutBase: OPT_OUT };
  const network = await store.createNetwork('Réseau Essai');
  const alex = await store.createAgent({ networkId: network.id, firstName: 'Alex', lastName: 'Essai' });
  const bea = await store.createAgent({ networkId: network.id, firstName: 'Béa', lastName: 'Essai' });
  const seller = await store.createPerson({ networkId: network.id, agentId: alex.id, firstName: 'Vendeur', lastName: 'Inventé' });
  const project = await store.createProject({ networkId: network.id, agentId: alex.id, personId: seller.id, kind: 'sell' });
  const property = await store.createProperty({ networkId: network.id, agentId: alex.id, reference: 'T-1', kind: 'home', postalCode: '21000' });
  await store.linkProjectProperty({ networkId: network.id, agentId: alex.id, projectId: project.id, propertyId: property.id, role: 'owned' });
  const buyer = await store.createPerson({ networkId: network.id, agentId: alex.id, firstName: 'Acheteur', lastName: 'Inventé' });
  const buyProject = await store.createProject({ networkId: network.id, agentId: alex.id, personId: buyer.id, kind: 'buy' });
  await store.linkProjectProperty({ networkId: network.id, agentId: alex.id, projectId: buyProject.id, propertyId: property.id, role: 'interested' });
  const saleFileId = 'dossier-vente-test';
  // Un dossier de vente inventé, rangé sans passer par M09 : seule son existence compte ici.
  await db.exec('PRAGMA foreign_keys = OFF');
  await db.run("INSERT INTO sale_files (id, network_id, property_id, offer_id, buyer_person_id, amount_eur, opened_at, opened_by) VALUES (?, ?, ?, 'offre-test', ?, 200000, ?, 'agent:x')", [
    saleFileId,
    network.id,
    property.id,
    buyer.id,
    new Date(clock).toISOString(),
  ]);
  await db.exec('PRAGMA foreign_keys = ON');

  const dir: Viewer = { role: 'direction', userId: 'dir-1', networkId: network.id };
  const agent: Viewer = { role: 'agent', userId: alex.id, networkId: network.id };
  const other: Viewer = { role: 'agent', userId: bea.id, networkId: network.id };
  const compliance: Viewer = { role: 'compliance', userId: 'conf-1', networkId: network.id };
  const partnerViewer = (id: string): Viewer => ({ role: 'partner', userId: id, networkId: network.id });
  const day = (d = 0): string => new Date(clock + d * DAY).toISOString().slice(0, 10);

  const routes = partenairesRoutes();
  const call = async (viewer: Viewer, method: 'GET' | 'POST', path: string, c: Call = {}) => {
    const route = routes.find((r) => r.method === method && r.pattern.test(path));
    if (!route) throw new Error(`route inconnue ${method} ${path}`);
    const params = (route.pattern.exec(path) ?? []).slice(1);
    const init: RequestInit = { method };
    if (c.json !== undefined) init.headers = { 'content-type': 'application/json' };
    if (c.json !== undefined) init.body = JSON.stringify(c.json);
    if (c.raw) {
      init.headers = { 'content-type': c.raw.type, 'content-length': String(c.raw.bytes.byteLength) };
      init.body = c.raw.bytes;
    }
    const request = new Request(`https://api.exemple.test/v1${path}${c.query ?? ''}`, init);
    const response = await route.handle(s, viewer, params, request);
    return { status: response.status, body: (await response.json()) as { ok: boolean; mode?: string; data?: any; code?: string; rule?: string | null }, request };
  };

  const KINDS: Record<string, string[]> = { courtier: ['immatriculation_orias'], geometre: ['inscription_ordre'], gestionnaire: ['carte_g'] };
  /** Un partenaire ajouté par la direction, par les routes, avec ses justificatifs valides. */
  const partner = async (trade: string, domain?: string): Promise<string> => {
    const r = await call(dir, 'POST', '/partenaires/annuaire', { json: { trade, businessName: `Partenaire ${trade} ${++n}`, postcodes: ['21000'] } });
    expect(r.status, trade).toBe(200);
    const id = r.body.data.partnerId as string;
    for (const kind of ['assurance_rcp', ...(KINDS[trade] ?? [])]) {
      const c = await call(dir, 'POST', `/partenaires/annuaire/${id}/justificatifs`, { json: { kind, number: 'N-1', validFrom: day(-30), validUntil: day(300), proofRef: files.put(`partenaires/${id}`) } });
      expect(c.status, kind).toBe(200);
    }
    if (domain && domain !== 'mesurage') {
      const c = await call(dir, 'POST', `/partenaires/annuaire/${id}/justificatifs`, {
        json: { kind: 'certification_diagnostic', domain, number: 'C-1', validFrom: day(-30), validUntil: day(300), proofRef: files.put(`partenaires/${id}`) },
      });
      expect(c.status).toBe(200);
    }
    return id;
  };
  /** Une demande confiée par l'agent, par les routes, avec l'accord du client. */
  const request = async (trade: string, domain?: string, projectId = project.id): Promise<{ partnerId: string; referralId: string; partner: Viewer }> => {
    const partnerId = await partner(trade, domain);
    const p = await call(agent, 'POST', '/partenaires/relations', { json: { projectId, trade, domain, propertyId: property.id, postcode: '21000' } });
    expect(p.status, trade).toBe(200);
    const id = p.body.data.referralId as string;
    const c = await call(agent, 'POST', `/partenaires/relations/${id}/accord`, { json: { partnerId, consentAt: new Date(clock - 500).toISOString(), channel: 'ecrit', proofRef: files.put(`relations/${id}`) } });
    expect(c.status, trade).toBe(200);
    expect((await call(agent, 'POST', `/partenaires/relations/${id}/confier`)).status).toBe(200);
    return { partnerId, referralId: id, partner: partnerViewer(partnerId) };
  };
  const upload = (req: { referralId: string; partner: Viewer }, sort: string, bytes = PDF, type = 'application/pdf', issuedOn = day(-1)) =>
    call(req.partner, 'POST', `/partenaires/espace/${req.referralId}/pieces`, { raw: { bytes, type }, query: `?sorte=${sort}&faite_le=${issuedOn}` });
  const events = async (type: string) => db.all<{ actor: string; subject: string | null; data: string }>('SELECT actor, subject, data FROM journal WHERE type = ? ORDER BY seq', [type]);
  return { db, s, journal, files, network, dir, agent, other, compliance, partnerViewer, property, project, buyProject, saleFileId, call, partner, request, upload, events, day };
}

describe('U10 · routes de M18', () => {
  it('[R16] chaque route dit ses rôles, et le partenaire n’a que les routes de son espace', () => {
    const routes = partenairesRoutes();
    expect(routes.length).toBeGreaterThanOrEqual(20);
    for (const r of routes) {
      expect(r.roles.length, r.name).toBeGreaterThan(0);
      expect(r.name).toMatch(/^partenaires\./);
      expect(r.roles.includes('partner'), r.name).toBe(r.name.startsWith('partenaires.espace'));
    }
    expect(new Set(routes.map((r) => `${r.method} ${r.pattern.source}`)).size).toBe(routes.length);
    // La prospection est à la direction seule.
    for (const r of routes.filter((x) => x.name.startsWith('partenaires.prospection'))) expect(r.roles).toEqual(['direction']);
  });

  it('les sortes proposées au partenaire suivent son métier et, pour un diagnostic, le domaine demandé', () => {
    expect(sortsFor('diagnostiqueur', 'amiante').map((s) => s.sort)).toEqual(['amiante', 'devis']);
    expect(sortsFor('notaire', null).map((s) => s.sort)).toEqual(['titre_propriete', 'pre_etat_date', 'projet_compromis', 'projet_acte']);
    expect(sortsFor('courtier', null).map((s) => s.sort)).toEqual(['accord_principe', 'offre_pret']);
    for (const s of sortsFor('geometre', null)) expect(s.label).not.toBe(s.sort);
  });
});

describeWithSqlite('U10 · routes de M18', () => {
  it('[R16] un rôle non admis est refusé avant la lecture du corps, et le refus est au journal', async () => {
    const t = await setup();
    const routes = partenairesRoutes();
    const roles: Viewer[] = [t.agent, t.dir, t.compliance, t.partnerViewer('p-inconnu')];
    let refused = 0;
    for (const r of routes) {
      for (const v of roles.filter((x) => !r.roles.includes(x.role))) {
        const path = r.pattern.source.replace(/^\^\\?/, '').replace(/\$$/, '').replace(/\\\//g, '/').replace(/\(\[A-Za-z0-9_-\]\{1,64\}\)/g, 'x1');
        const request = new Request(`https://api.exemple.test/v1${path}`, r.method === 'POST' ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"piege":true}' } : {});
        const res = await r.handle(t.s, v, ['x1'], request);
        expect(res.status, `${r.name} ${v.role}`).toBe(403);
        expect(await res.json()).toEqual({ ok: false, rule: 'R16', code: 'role' });
        // Le corps n'a pas été lu.
        expect(request.bodyUsed, r.name).toBe(false);
        refused++;
      }
    }
    expect(refused).toBeGreaterThan(30);
    const logged = await t.events('acces.refuse');
    expect(logged.length).toBe(refused);
    for (const e of logged) expect(JSON.parse(e.data)).toMatchObject({ rule: 'R16', code: 'role' });
  });

  it('[R78] 5 demandes inventées suivies jusqu’au bout par les routes : pièces rangées sans erreur', async () => {
    const t = await setup();
    const diag = await t.request('diagnostiqueur', 'amiante');
    const notaire = await t.request('notaire');
    const courtier = await t.request('courtier', undefined, t.buyProject.id);
    const artisan = await t.request('artisan');
    const geometre = await t.request('geometre');
    const expected: [typeof diag, string, string, string][] = [
      [diag, 'amiante', 'property', t.property.id],
      [notaire, 'titre_propriete', 'sale_file', t.saleFileId],
      [notaire, 'projet_compromis', 'sale_file', t.saleFileId],
      [courtier, 'offre_pret', 'financing', t.saleFileId],
      [artisan, 'devis', 'referral', artisan.referralId],
      [geometre, 'bornage', 'property', t.property.id],
    ];
    for (const req of [diag, notaire, courtier, artisan, geometre]) {
      // Le partenaire voit sa demande, la commence.
      const list = await t.call(req.partner, 'GET', '/partenaires/espace');
      expect(list.body.data).toEqual([expect.objectContaining({ referralId: req.referralId, state: 'confiee' })]);
      expect((await t.call(req.partner, 'POST', `/partenaires/espace/${req.referralId}/etat`, { json: { state: 'en_cours' } })).body).toMatchObject({ ok: true, data: 'en_cours' });
    }
    for (const [req, sort, destination, targetId] of expected) {
      const r = await t.upload(req, sort);
      expect(r.status, sort).toBe(200);
      expect(r.body.data, sort).toMatchObject({ sort, destination, targetId, reason: 'rule' });
    }
    for (const req of [diag, notaire, courtier, artisan, geometre]) {
      expect((await t.call(req.partner, 'POST', `/partenaires/espace/${req.referralId}/etat`, { json: { state: 'terminee' } })).status).toBe(200);
      const pieces = await t.call(t.agent, 'GET', `/partenaires/relations/${req.referralId}/pieces`);
      expect(pieces.status).toBe(200);
      for (const p of pieces.body.data) expect(p.destination).not.toBe('agent_queue');
      const suivi = await t.call(t.agent, 'GET', `/partenaires/relations/${req.referralId}/suivi`);
      expect(suivi.status).toBe(200);
      expect(suivi.body.data.followUps).toEqual([]);
    }
    expect(await t.db.all("SELECT id FROM partner_documents WHERE destination = 'agent_queue'")).toHaveLength(0);
    // Chaque fichier est rangé sous la référence choisie par le serveur, avec son empreinte calculée.
    const docs = await t.db.all<{ ref: string; sha256: string; partner_id: string; referral_id: string }>('SELECT ref, sha256, partner_id, referral_id FROM partner_documents');
    expect(docs).toHaveLength(6);
    for (const d of docs) {
      expect(d.ref.startsWith(`partenaires/${d.partner_id}/relations/${d.referral_id}/`)).toBe(true);
      expect(t.files.uploaded.get(d.ref)?.type).toBe('application/pdf');
    }
    const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', PDF))].map((b) => b.toString(16).padStart(2, '0')).join('');
    for (const d of docs) expect(d.sha256).toBe(digest);
    // Le journal ne garde jamais le fichier ni sa référence.
    const all = await t.db.all<{ data: string }>('SELECT data FROM journal');
    for (const e of all) for (const d of docs) expect(e.data).not.toContain(d.ref);
  });

  it('[R77] un partenaire ne lit et ne dépose que dans ses demandes confiées, et reçoit le seul dossier de son métier', async () => {
    const t = await setup();
    const a = await t.request('artisan');
    const b = await t.request('artisan');
    expect(await t.call(b.partner, 'GET', `/partenaires/espace/${a.referralId}`)).toMatchObject({ status: 403, body: { ok: false, rule: 'R16', code: 'not_assigned' } });
    const before = t.files.uploaded.size;
    expect(await t.upload({ referralId: a.referralId, partner: b.partner }, 'devis')).toMatchObject({ status: 403, body: { code: 'not_assigned' } });
    expect(t.files.uploaded.size).toBe(before);
    const read = await t.call(a.partner, 'GET', `/partenaires/espace/${a.referralId}`);
    expect(read.status).toBe(200);
    expect(Object.keys(read.body.data.file).sort()).toEqual(['city', 'postcode', 'propertyKind', 'rooms', 'surfaceM2'].filter((k) => k in read.body.data.file).sort());
    expect(read.body.data.file).not.toHaveProperty('clientLastName');
    expect(read.body.data.sorts).toEqual([{ sort: 'devis', label: 'Devis' }]);
    expect(read.body.data.tradeLabel).toBe('Artisan');
    // Un agent n'entre pas dans l'espace partenaire ; un partenaire n'entre pas dans les routes de l'agent.
    expect((await t.call(t.agent, 'GET', '/partenaires/espace')).status).toBe(403);
    expect((await t.call(a.partner, 'GET', `/partenaires/relations/${a.referralId}`)).status).toBe(403);
    // Un autre agent ne lit pas la mise en relation d'Alex.
    expect(await t.call(t.other, 'GET', `/partenaires/relations/${a.referralId}`)).toMatchObject({ status: 403, body: { rule: 'R16' } });
  });

  it('[R78] [R15] le dépôt d’un fichier : contrôles avant tout rangement, rien n’est stocké en cas de refus', async () => {
    const t = await setup();
    const notaire = await t.request('notaire');
    const stored = () => t.files.uploaded.size;
    expect(await t.upload(notaire, 'piece_identite')).toMatchObject({ status: 409, body: { rule: 'R15', code: 'forbidden_piece' } });
    expect((await t.events('piece_partenaire.refusee')).length).toBe(1);
    expect(await t.upload(notaire, 'Titre!')).toMatchObject({ status: 400, body: { code: 'bad_sort' } });
    expect(await t.upload(notaire, 'titre_propriete', PDF, 'application/pdf', t.day(2))).toMatchObject({ status: 400, body: { code: 'bad_date' } });
    expect(await t.upload(notaire, 'titre_propriete', PDF, 'application/pdf', 'hier')).toMatchObject({ status: 400, body: { code: 'bad_date' } });
    expect(await t.upload(notaire, 'titre_propriete', PDF, 'application/pdf', '2027-02-30')).toMatchObject({ status: 400, body: { code: 'bad_date' } });
    expect(await t.upload(notaire, 'titre_propriete', PDF, 'text/html')).toMatchObject({ status: 415, body: { code: 'bad_type' } });
    // Un fichier qui se dit PDF sans en être un.
    expect(await t.upload(notaire, 'titre_propriete', PNG, 'application/pdf')).toMatchObject({ status: 415, body: { code: 'bad_type' } });
    const big = new Uint8Array(MAX_UPLOAD_BYTES + 1);
    big.set(PDF);
    expect(await t.upload(notaire, 'titre_propriete', big)).toMatchObject({ status: 413, body: { code: 'too_large' } });
    expect(stored()).toBe(0);
    expect(await t.db.all('SELECT id FROM partner_documents')).toHaveLength(0);
    // Un PNG est accepté pour ce qu'il est.
    expect(await t.upload(notaire, 'titre_propriete', PNG, 'image/png')).toMatchObject({ status: 200, body: { data: { destination: 'sale_file' } } });
    expect([...t.files.uploaded.keys()][0]).toMatch(/\.png$/);
    // Une sorte inconnue va à la file de l'agent, jamais rangée au hasard.
    expect(await t.upload(notaire, 'facture_mysterieuse')).toMatchObject({ status: 200, body: { data: { destination: 'agent_queue', reason: 'unknown_sort' } } });
    // En JSON, une référence déjà rangée suit les contrôles de la couche métier.
    expect(await t.call(notaire.partner, 'POST', `/partenaires/espace/${notaire.referralId}/pieces`, { json: { sort: 'projet_acte', ref: 'ailleurs/x.pdf', sha256: 'a'.repeat(64), issuedOn: t.day(-1) } })).toMatchObject({
      status: 400,
      body: { code: 'bad_ref' },
    });
    const ref = t.files.put(`partenaires/${notaire.partnerId}/relations/${notaire.referralId}`);
    expect(await t.call(notaire.partner, 'POST', `/partenaires/espace/${notaire.referralId}/pieces`, { json: { sort: 'projet_acte', ref, sha256: 'b'.repeat(64), issuedOn: t.day(-1) } })).toMatchObject({
      status: 200,
      body: { data: { destination: 'sale_file' } },
    });
  });

  it('[R13] un fichier stocké puis refusé au rangement laisse une trace au journal, sans sa référence', async () => {
    const t = await setup();
    const artisan = await t.request('artisan');
    // Un stockage qui perd le fichier : la couche métier ne le trouve pas et refuse de le ranger.
    t.s.uploads = { put: async () => undefined };
    expect(await t.upload(artisan, 'devis')).toMatchObject({ status: 400, body: { code: 'not_stored' } });
    const trace = await t.events('piece_partenaire.fichier_non_range');
    expect(trace).toHaveLength(1);
    expect(JSON.parse(trace[0]!.data)).toEqual({ rule: null, code: 'not_stored', sort: 'devis' });
    expect(trace[0]!.data).not.toContain('partenaires/');
  });

  it('sans stockage des fichiers, le dépôt est refusé et rien n’est rangé', async () => {
    const t = await setup({ uploads: false });
    const artisan = await t.request('artisan');
    expect(await t.upload(artisan, 'devis')).toMatchObject({ status: 503, body: { code: 'storage_unavailable' } });
    expect(await t.db.all('SELECT id FROM partner_documents')).toHaveLength(0);
  });

  it('[R73] [R14] la recherche de l’annuaire ne rend ni note, ni rang, ni avis ; un justificatif échu rend indisponible', async () => {
    const t = await setup();
    const ok = await t.partner('artisan');
    const r = await t.call(t.agent, 'GET', '/partenaires/annuaire', { query: '?metier=artisan&cp=21000' });
    expect(r.status).toBe(200);
    expect(JSON.stringify(r.body.data)).not.toMatch(/note|score|rank|rang|avis|review|rating/i);
    expect(JSON.stringify(r.body.data)).toContain(ok);
    // Le partenaire au justificatif échu ne lit plus son espace [R73].
    const late = await t.request('artisan');
    // Les justificatifs ne se modifient pas : une nouvelle version, échue, corrige la précédente [R17].
    const fix = await t.call(t.dir, 'POST', `/partenaires/annuaire/${late.partnerId}/justificatifs`, {
      json: { kind: 'assurance_rcp', number: 'N-2', validFrom: t.day(-30), validUntil: t.day(-1), proofRef: t.files.put(`partenaires/${late.partnerId}`) },
    });
    expect(fix.status).toBe(200);
    expect(await t.call(late.partner, 'GET', '/partenaires/espace')).toMatchObject({ status: 409, body: { rule: 'R73', code: 'credentials' } });
    expect((await t.call(t.compliance, 'GET', `/partenaires/annuaire/${ok}`)).status).toBe(200);
    expect((await t.call(t.compliance, 'POST', '/partenaires/annuaire', { json: { trade: 'artisan', businessName: 'X', postcodes: ['21000'] } })).status).toBe(403);
  });

  it('[R76] [R74] rémunération d’un diagnostiqueur refusée ; texte montré au client ; avis rangé en texte seul', async () => {
    const t = await setup();
    const partnerId = await t.partner('diagnostiqueur', 'dpe');
    const p = await t.call(t.agent, 'POST', '/partenaires/relations', { json: { projectId: t.project.id, trade: 'diagnostiqueur', domain: 'dpe', propertyId: t.property.id } });
    const id = p.body.data.referralId as string;
    expect(await t.call(t.agent, 'POST', `/partenaires/relations/${id}/remunerations`, { json: { partnerId, kind: 'cadeau', amountCents: 5000, payer: 'partenaire', payee: 'agent' } })).toMatchObject({
      status: 409,
      body: { rule: 'R76', code: 'diagnostician_fee' },
    });
    expect((await t.call(t.agent, 'GET', `/partenaires/relations/${id}/remunerations`)).status).toBe(200);
    // Confier sans accord du client est refusé [R74].
    expect(await t.call(t.agent, 'POST', `/partenaires/relations/${id}/confier`)).toMatchObject({ status: 409, body: { rule: 'R74' } });
    await t.call(t.agent, 'POST', `/partenaires/relations/${id}/accord`, { json: { partnerId, consentAt: new Date(clock - 500).toISOString(), channel: 'oral', proofRef: t.files.put(`relations/${id}`) } });
    expect((await t.call(t.agent, 'POST', `/partenaires/relations/${id}/confier`)).status).toBe(200);
    expect(await t.call(t.agent, 'POST', `/partenaires/relations/${id}/avis`, { json: { text: 'Très ponctuel.', channel: 'oral', note: 5 } })).toMatchObject({ status: 409, body: { rule: 'R14', code: 'only_text' } });
    expect((await t.call(t.agent, 'POST', `/partenaires/relations/${id}/avis`, { json: { text: 'Très ponctuel.', channel: 'oral' } })).status).toBe(200);
    expect((await t.call(t.agent, 'GET', `/partenaires/relations/${id}/avis`)).body.data).toHaveLength(1);
    expect(await t.call(t.agent, 'GET', `/partenaires/relations/${id}/resume`)).toMatchObject({ status: 200, body: { data: { source: 'secours' } } });
    expect(await t.call(t.agent, 'POST', `/partenaires/relations/${id}/cloture`, { json: { outcome: 'terminee' } })).toMatchObject({ status: 200 });
  });

  it('[R79] [R04] prospection par la direction ; la page d’opposition arrête tout, sans rien dire de l’adresse', async () => {
    const t = await setup();
    const add = await t.call(t.dir, 'POST', '/partenaires/prospection', {
      json: { email: 'contact@etude-essai.example', addressKind: 'professionnelle', trade: 'notaire', businessName: 'Étude Essai', source: 'Annuaire public inventé' },
    });
    expect(add.status).toBe(200);
    const { Prospection } = await import('../../core/src/partenaires/index.ts');
    expect(await new Prospection(t.db, t.journal, { now: t.s.now, optOutBase: OPT_OUT }).run(t.network.id)).toBe(1);
    const mails = await t.call(t.dir, 'GET', '/partenaires/prospection/mails', { query: `?jour=${t.day()}` });
    expect(mails.body.data).toHaveLength(1);
    expect(mails.body.data[0].decisionRule).toBe('R03');
    const token = /opposition\/([a-z]{32})$/.exec(mails.body.data[0].text)![1]!;
    const page = async (method: string, path: string) => {
      const r = await handlePartenairesPublic(new Request(`https://aimmo.example${path}`, { method }), { db: t.db, now: t.s.now });
      return { status: r!.status, html: await r!.text(), csp: r!.headers.get('content-security-policy') };
    };
    expect(await handlePartenairesPublic(new Request('https://aimmo.example/autre'), { db: t.db })).toBeNull();
    const form = await page('GET', `/partenaires/opposition/${token}`);
    expect(form.status).toBe(200);
    expect(form.html).not.toContain('etude-essai');
    expect(form.html).not.toMatch(/<script/);
    expect(form.csp).toContain("default-src 'none'");
    expect((await page('POST', `/partenaires/opposition/${'z'.repeat(32)}`)).status).toBe(404);
    expect((await page('GET', '/partenaires/opposition/abc/def')).status).toBe(404);
    expect((await page('POST', `/partenaires/opposition/${token}`)).status).toBe(200);
    expect((await t.call(t.dir, 'GET', '/partenaires/prospection')).body.data[0].opposed).toBe(true);
    // L'agent n'a pas accès à la prospection.
    expect((await t.call(t.agent, 'GET', '/partenaires/prospection')).status).toBe(403);
  });
});

describeWithSqlite('U13 · dépôt de la preuve d’un justificatif', () => {
  const added = async (t: Awaited<ReturnType<typeof setup>>) => {
    const r = await t.call(t.dir, 'POST', '/partenaires/annuaire', { json: { trade: 'notaire', businessName: 'Étude Essai', postcodes: ['21000'] } });
    return r.body.data.partnerId as string;
  };

  it('[R73] la référence vient du serveur, et le justificatif la reprend : le partenaire devient proposable', async () => {
    const t = await setup();
    const id = await added(t);
    const up = await t.call(t.dir, 'POST', `/partenaires/annuaire/${id}/preuves`, { raw: { bytes: PDF, type: 'application/pdf' } });
    expect(up.status).toBe(200);
    const proofRef = up.body.data.proofRef as string;
    expect(proofRef.startsWith(`partenaires/${id}/`)).toBe(true);
    expect(t.files.uploaded.get(proofRef)?.type).toBe('application/pdf');
    t.files.refs.add(proofRef);
    const c = await t.call(t.dir, 'POST', `/partenaires/annuaire/${id}/justificatifs`, { json: { kind: 'assurance_rcp', number: 'N-1', validFrom: t.day(-1), validUntil: t.day(100), proofRef } });
    expect(c.status).toBe(200);
    expect(c.body.data.proposable).toBe(true);
  });

  it('[R16] un partenaire, la conformité ou un autre réseau ne déposent rien, avant toute lecture du fichier', async () => {
    const t = await setup();
    const id = await added(t);
    for (const v of [t.partnerViewer(id), t.compliance]) {
      const r = await t.call(v, 'POST', `/partenaires/annuaire/${id}/preuves`, { raw: { bytes: PDF, type: 'application/pdf' } });
      expect(r.status).toBe(403);
      expect(r.request.bodyUsed).toBe(false);
    }
    const elsewhere = await t.call({ ...t.dir, networkId: 'autre-reseau' }, 'POST', `/partenaires/annuaire/${id}/preuves`, { raw: { bytes: PDF, type: 'application/pdf' } });
    expect(elsewhere.status).toBe(404);
    expect(elsewhere.request.bodyUsed).toBe(false);
    expect(t.files.uploaded.size).toBe(0);
  });

  it('[R16] un agent actif dépose ; un agent parti, non', async () => {
    const t = await setup();
    const id = await added(t);
    const path = `/partenaires/annuaire/${id}/preuves`;
    expect((await t.call(t.agent, 'POST', path, { raw: { bytes: PDF, type: 'application/pdf' } })).status).toBe(200);
    expect(t.files.uploaded.size).toBe(1);
    await t.db.run("UPDATE agents SET status = 'left' WHERE id = ?", [t.agent.userId]);
    const gone = await t.call(t.agent, 'POST', path, { raw: { bytes: PDF, type: 'application/pdf' } });
    expect([gone.status, gone.body.code]).toEqual([403, 'agent_inactive']);
    expect(gone.request.bodyUsed).toBe(false);
    expect(t.files.uploaded.size).toBe(1);
  });

  it('un autre format, un faux PDF, un fichier trop lourd ou l’absence de stockage ne rangent rien', async () => {
    const t = await setup();
    const id = await added(t);
    const path = `/partenaires/annuaire/${id}/preuves`;
    expect((await t.call(t.dir, 'POST', path, { raw: { bytes: PDF, type: 'image/gif' } })).body.code).toBe('bad_type');
    expect((await t.call(t.dir, 'POST', path, { raw: { bytes: new Uint8Array([1, 2, 3, 4, 5, 6]), type: 'application/pdf' } })).body.code).toBe('bad_type');
    expect((await t.call(t.dir, 'POST', path, { raw: { bytes: new Uint8Array(MAX_UPLOAD_BYTES + 1), type: 'application/pdf' } })).body.code).toBe('too_large');
    expect(t.files.uploaded.size).toBe(0);
    const closed = await setup({ uploads: false });
    const other = await added(closed);
    const r = await closed.call(closed.dir, 'POST', `/partenaires/annuaire/${other}/preuves`, { raw: { bytes: PDF, type: 'application/pdf' } });
    expect([r.status, r.body.code]).toEqual([503, 'storage_unavailable']);
  });

  it('[R13] le journal garde l’empreinte seule, ni la référence ni le nom', async () => {
    const t = await setup();
    const id = await added(t);
    const up = await t.call(t.dir, 'POST', `/partenaires/annuaire/${id}/preuves`, { raw: { bytes: PDF, type: 'application/pdf' } });
    const all = await t.journal.all();
    const event = all.find((e) => e.type === 'partenaire.preuve_deposee')!;
    expect(Object.keys(event.data).sort()).toEqual(['rule', 'sha256']);
    expect(JSON.stringify(all)).not.toContain(up.body.data.proofRef);
  });
});

describeWithSqlite('U11 · routes de l’écran « Partenaires »', () => {
  it('[R16] [R75] l’agent lit ses seuls projets, partenaires dans l’ordre du tirage ; la direction, les projets qui ont une demande', async () => {
    const t = await setup();
    const ids = [await t.partner('notaire'), await t.partner('notaire'), await t.partner('notaire'), await t.partner('notaire')];
    const p = await t.call(t.agent, 'POST', '/partenaires/relations', { json: { projectId: t.project.id, trade: 'notaire', propertyId: t.property.id } });
    expect(p.status).toBe(200);
    const mine = await t.call(t.agent, 'GET', '/partenaires/projets');
    expect(mine.status).toBe(200);
    expect(mine.body.data.projects.map((x: { projectId: string }) => x.projectId)).toEqual([t.project.id, t.buyProject.id]);
    expect(mine.body.data).toMatchObject({ page: 0, more: false });
    const first = mine.body.data.projects[0];
    expect(first).toMatchObject({ kind: 'sell', firstName: 'Vendeur', properties: [{ propertyId: t.property.id, reference: 'T-1', postcode: '21000' }] });
    // Du client, le prénom seul : ni nom, ni coordonnée.
    expect(JSON.stringify(mine.body.data)).not.toContain('Inventé');
    // Le bien suivi par Alex est rendu à l'acquéreur d'Alex ; une page impossible est refusée.
    expect(mine.body.data.projects[1].properties).toHaveLength(1);
    expect(await t.call(t.agent, 'GET', '/partenaires/projets', { query: '?page=-1' })).toMatchObject({ status: 400, body: { code: 'bad_page' } });
    expect(await t.call(t.agent, 'GET', '/partenaires/projets', { query: '?page=1' })).toMatchObject({ status: 200, body: { data: { projects: [], page: 1, more: false } } });
    // Les partenaires montrés gardent l'ordre du tirage rangé, sans note ni rang [R75, R14].
    expect(first.referrals).toHaveLength(1);
    const shown = first.referrals[0].shown.map((x: { partnerId: string }) => x.partnerId);
    expect(shown).toHaveLength(3);
    expect(shown).toEqual(p.body.data.shown.map((x: { partnerId: string }) => x.partnerId));
    for (const id of shown) expect(ids).toContain(id);
    expect(JSON.stringify(first.referrals)).not.toMatch(/"(?:note|score|rank|rating)"/);
    // Un autre agent ne voit rien des projets d'Alex.
    const other = await t.call(t.other, 'GET', '/partenaires/projets');
    expect(other).toMatchObject({ status: 200, body: { data: { projects: [] } } });
    // La direction voit le seul projet qui a une demande.
    const dir = await t.call(t.dir, 'GET', '/partenaires/projets');
    expect(dir.body.data.projects.map((x: { projectId: string }) => x.projectId)).toEqual([t.project.id]);
    // La conformité et un partenaire sont refusés, au journal.
    expect(await t.call(t.compliance, 'GET', '/partenaires/projets')).toMatchObject({ status: 403, body: { rule: 'R16', code: 'role' } });
    expect(await t.call(t.partnerViewer(ids[0]!), 'GET', '/partenaires/projets')).toMatchObject({ status: 403, body: { rule: 'R16' } });
  });

  it('[R16] [R13] chaque prénom rendu est une lecture au journal ; une fiche confiée à un autre agent reste sans prénom', async () => {
    const t = await setup();
    const seller = (await t.db.first<{ person_id: string }>('SELECT person_id FROM projects WHERE id = ?', [t.project.id]))!.person_id;
    const buyer = (await t.db.first<{ person_id: string }>('SELECT person_id FROM projects WHERE id = ?', [t.buyProject.id]))!.person_id;
    await t.db.run('UPDATE persons SET agent_id = ? WHERE id = ?', [t.other.userId, seller]);
    const mine = await t.call(t.agent, 'GET', '/partenaires/projets');
    expect(mine.body.data.projects.map((x: { firstName: string | null }) => x.firstName)).toEqual([null, 'Acheteur']);
    const reads = await t.events('fiche.lue');
    expect(reads.map((e) => e.subject)).toEqual([`person:${buyer}`]);
    expect(JSON.parse(reads[0]!.data)).toMatchObject({ rule: 'R16', via: 'partenaires.projets', project: `project:${t.buyProject.id}` });
    const refused = (await t.events('acces.refuse')).filter((e) => JSON.parse(e.data).via === 'partenaires.projets');
    expect(refused.map((e) => e.subject)).toEqual([`person:${seller}`]);
    const listed = await t.events('partenaires.projets.lu');
    expect(JSON.parse(listed[0]!.data)).toEqual({ rule: 'R16', page: 0, projects: 2, names: 1 });
    for (const e of [...reads, ...refused, ...listed]) expect(e.data).not.toMatch(/Vendeur|Acheteur|Inventé/);
  });

  it('[R16] un bien d’un autre agent, vendu, n’est plus rendu avec le projet de l’acquéreur', async () => {
    const t = await setup();
    await t.db.run("UPDATE properties SET agent_id = ?, status = 'sold' WHERE id = ?", [t.other.userId, t.property.id]);
    const mine = await t.call(t.agent, 'GET', '/partenaires/projets');
    for (const p of mine.body.data.projects) expect(p.properties).toEqual([]);
    expect(JSON.stringify(mine.body.data)).not.toContain('T-1');
  });

  it('par pages de 50 : un 51e projet passe à la page suivante, jamais perdu', async () => {
    const t = await setup();
    const store = new FicheClient(t.db, { now: () => new Date(clock) });
    for (let i = 0; i < 49; i++) {
      const person = await store.createPerson({ networkId: t.network.id, agentId: t.agent.userId, firstName: `Client${i}`, lastName: 'Inventé' });
      await store.createProject({ networkId: t.network.id, agentId: t.agent.userId, personId: person.id, kind: 'buy' });
    }
    const first = await t.call(t.agent, 'GET', '/partenaires/projets');
    expect(first.body.data.projects).toHaveLength(50);
    expect(first.body.data.more).toBe(true);
    const second = await t.call(t.agent, 'GET', '/partenaires/projets', { query: '?page=1' });
    expect(second.body.data.projects).toHaveLength(1);
    expect(second.body.data.more).toBe(false);
  });

  it('[R16] un agent inactif ne lit plus ses projets', async () => {
    const t = await setup();
    await t.db.run("UPDATE agents SET status = 'left' WHERE id = ?", [t.agent.userId]);
    expect(await t.call(t.agent, 'GET', '/partenaires/projets')).toMatchObject({ status: 403, body: { rule: 'R16', code: 'agent_inactive' } });
  });

  it('[R74] [R13] l’accord noté par l’agent devient une preuve rangée, que l’accord reprend ; le journal garde l’empreinte seule', async () => {
    const t = await setup();
    const partnerId = await t.partner('artisan');
    const p = await t.call(t.agent, 'POST', '/partenaires/relations', { json: { projectId: t.project.id, trade: 'artisan', propertyId: t.property.id } });
    const id = p.body.data.referralId as string;
    const NOTE = 'Le client a choisi cet artisan au téléphone, le 12 juillet.';
    // Note trop courte, canal inconnu : refusés, rien n'est rangé.
    expect(await t.call(t.agent, 'POST', `/partenaires/relations/${id}/preuve-accord`, { json: { channel: 'oral', note: 'oui' } })).toMatchObject({ status: 409, body: { rule: 'R74', code: 'bad_note' } });
    expect(await t.call(t.agent, 'POST', `/partenaires/relations/${id}/preuve-accord`, { json: { channel: 'pigeon', note: NOTE } })).toMatchObject({ status: 409, body: { rule: 'R74', code: 'bad_channel' } });
    expect(await t.call(t.agent, 'POST', `/partenaires/relations/${id}/preuve-accord`, { json: { channel: 'oral', note: 'Une note\u0000 cachée ici' } })).toMatchObject({ status: 409, body: { code: 'bad_note' } });
    // Un autre agent ne note rien sur la demande d'Alex [R16].
    expect(await t.call(t.other, 'POST', `/partenaires/relations/${id}/preuve-accord`, { json: { channel: 'oral', note: NOTE } })).toMatchObject({ status: 403, body: { rule: 'R16' } });
    expect(t.files.uploaded.size).toBe(0);
    const proof = await t.call(t.agent, 'POST', `/partenaires/relations/${id}/preuve-accord`, { json: { channel: 'oral', note: NOTE } });
    expect(proof.status).toBe(200);
    const { proofRef, sha256, at } = proof.body.data as { proofRef: string; sha256: string; at: string };
    expect(proofRef).toMatch(new RegExp(`^relations/${id}/[0-9a-f-]{36}\\.txt$`));
    const stored = t.files.uploaded.get(proofRef)!;
    expect(stored.type).toBe('text/plain; charset=utf-8');
    const text = new TextDecoder().decode(stored.bytes);
    expect(text).toContain(NOTE);
    expect(text).toContain('de vive voix');
    const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', stored.bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');
    expect(sha256).toBe(digest);
    // L'accord reprend la preuve et l'heure du serveur.
    const c = await t.call(t.agent, 'POST', `/partenaires/relations/${id}/accord`, { json: { partnerId, consentAt: at, channel: 'oral', proofRef } });
    expect(c).toMatchObject({ status: 200, body: { data: { state: 'accord_client', chosenPartnerId: partnerId } } });
    // Une fois l'accord rangé, plus de nouvelle note.
    expect(await t.call(t.agent, 'POST', `/partenaires/relations/${id}/preuve-accord`, { json: { channel: 'oral', note: NOTE } })).toMatchObject({ status: 400, body: { code: 'bad_state' } });
    // Le journal garde l'empreinte, jamais la note ni la référence.
    const logged = await t.events('mise_en_relation.preuve_accord');
    expect(logged).toHaveLength(1);
    expect(JSON.parse(logged[0]!.data)).toEqual({ rule: 'R74', channel: 'oral', sha256 });
    for (const e of await t.db.all<{ data: string }>('SELECT data FROM journal')) {
      expect(e.data).not.toContain('téléphone');
      expect(e.data).not.toContain(proofRef);
    }
  });

  it('sans stockage, la note d’accord est refusée et rien n’est rangé', async () => {
    const t = await setup({ uploads: false });
    await t.partner('artisan');
    const p = await t.call(t.agent, 'POST', '/partenaires/relations', { json: { projectId: t.project.id, trade: 'artisan', propertyId: t.property.id } });
    const r = await t.call(t.agent, 'POST', `/partenaires/relations/${p.body.data.referralId}/preuve-accord`, { json: { channel: 'oral', note: 'Accord donné de vive voix ce matin.' } });
    expect(r).toMatchObject({ status: 503, body: { code: 'storage_unavailable' } });
    expect(await t.events('mise_en_relation.preuve_accord')).toHaveLength(0);
  });
});

describe('U10 · page de l’espace partenaire', () => {
  it('[R07] textes en français, sans « mandataire » ni « gratuit », sans mention de l’IA', () => {
    for (const body of Object.values(PARTNER_SPACE_FILES)) {
      expect(body).not.toMatch(/mandataire|gratuit|\bIA\b|intelligence artificielle/i);
    }
    expect(PARTNER_SPACE_FILES['/partenaire/']).toContain('<html lang="fr">');
  });

  it('aucun script ni style en ligne, aucune ressource extérieure ; en-têtes stricts', async () => {
    const html = PARTNER_SPACE_FILES['/partenaire/']!;
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/);
    expect(html).not.toMatch(/\sstyle=|<style/);
    expect(html).not.toMatch(/https?:\/\//);
    expect(PARTNER_SPACE_CSP).toContain("default-src 'none'");
    expect(PARTNER_SPACE_CSP).toContain("connect-src 'self'");
    const r = handleEspacePartenaire(new Request('https://aimmo.example/partenaire/'))!;
    expect(r.status).toBe(200);
    expect(r.headers.get('content-security-policy')).toBe(PARTNER_SPACE_CSP);
    expect(r.headers.get('x-frame-options')).toBe('DENY');
    expect(handleEspacePartenaire(new Request('https://aimmo.example/partenaire'))!.status).toBe(308);
    expect(handleEspacePartenaire(new Request('https://aimmo.example/partenaire/x'))!.status).toBe(404);
    expect(handleEspacePartenaire(new Request('https://aimmo.example/partenaire/', { method: 'POST' }))!.status).toBe(405);
    expect(handleEspacePartenaire(new Request('https://aimmo.example/app/'))).toBeNull();
    // Accessible : chaque champ a son étiquette, la page a ses zones annoncées.
    for (const id of ['cle', 'sorte', 'faite', 'fichier']) expect(html).toContain(`<label for="${id}">`);
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('width=device-width');
  });

  it('[R13] le script pose les textes sans code, la clé ne passe que dans l’en-tête, les adresses sont fixes', () => {
    const js = PARTNER_SPACE_FILES['/partenaire/partenaire.js']!;
    expect(js).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/);
    expect(js).toContain("headers.authorization = 'Bearer ' + key");
    for (const call of js.match(/api\(([^,)]+)/g) ?? []) expect(call).toMatch(/^api\((?:path|'\/v1\/partenaires\/espace)/);
  });

  it('[R16] [R77] parcours dans la page : liste, dossier utile, commencer, déposer ; une clé refusée est effacée', async () => {
    const { els, listeners, document } = fakeDocument(pageIds(PARTNER_SPACE_FILES['/partenaire/']!));
    const storage = new Map<string, string>([['aimmo.partenaire.cle', 'k'.repeat(40)]]);
    const calls: { url: string; method: string; headers: Record<string, string>; body: unknown }[] = [];
    const answers: Record<string, () => { status: number; body: unknown }> = {
      'GET /v1/partenaires/espace': () => ({ status: 200, body: { ok: true, data: [{ referralId: 'r1', trade: 'diagnostiqueur', tradeLabel: 'Diagnostiqueur certifié', state: 'confiee' }, { referralId: 'r2', trade: 'notaire', tradeLabel: 'Notaire', state: 'confiee' }] } }),
      'GET /v1/partenaires/espace/r1': () => ({
        status: 200,
        body: { ok: true, data: { referralId: 'r1', trade: 'diagnostiqueur', tradeLabel: 'Diagnostiqueur certifié', state: 'confiee', file: { domain: 'amiante', postcode: '21000', surfaceM2: 64 }, sorts: [{ sort: 'amiante', label: 'Constat amiante' }] } },
      }),
      'GET /v1/partenaires/espace/r2': () => ({
        status: 200,
        body: { ok: true, data: { referralId: 'r2', trade: 'notaire', tradeLabel: 'Notaire', state: 'confiee', file: { postcode: '21000' }, sorts: [{ sort: 'titre_propriete', label: 'Titre de propriété' }] } },
      }),
      'POST /v1/partenaires/espace/r1/etat': () => ({ status: 200, body: { ok: true, data: 'en_cours' } }),
      'POST /v1/partenaires/espace/r1/pieces?sorte=amiante&faite_le=2027-07-11': () => ({ status: 200, body: { ok: true, data: { destination: 'property' } } }),
    };
    const flush = () => new Promise((r) => setTimeout(r, 0));
    let pending: Promise<void> | null = null;
    runInNewContext(PARTNER_SPACE_FILES['/partenaire/partenaire.js']!, {
      document,
      localStorage: { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, v), removeItem: (k: string) => storage.delete(k) },
      fetch: (url: string, init: { method: string; headers: Record<string, string>; body: unknown }) => {
        calls.push({ url, method: init.method, headers: init.headers, body: init.body });
        const a = answers[`${init.method} ${url}`];
        const res = a ? a() : { status: 401, body: { ok: false } };
        const answer = { status: res.status, json: () => Promise.resolve(res.body) };
        return pending ? pending.then(() => answer) : Promise.resolve(answer);
      },
      Date,
      String,
      JSON,
      Promise,
      encodeURIComponent,
    });
    listeners.DOMContentLoaded!();
    await flush();
    await flush();
    expect(els.liste!.hidden).toBe(false);
    expect(els.demandes!.textContent).toContain('Diagnostiqueur certifié');
    expect(els.demandes!.textContent).toContain('Confiée, à commencer');
    for (const c of calls) expect(c.headers.authorization).toBe(`Bearer ${'k'.repeat(40)}`);
    for (const c of calls) expect(c.url).not.toContain('k'.repeat(40));
    // Ouvrir la demande.
    const button = els.demandes!.all().find((e) => e.tagName === 'button')!;
    const second = els.demandes!.all().filter((e) => e.tagName === 'button')[1]!;
    const runOpen = (_id: string) => second.listeners.click!({});
    button.listeners.click!({});
    await flush();
    await flush();
    expect(els.detail!.hidden).toBe(false);
    expect(els.dossier!.textContent).toContain('Surface (m²)64');
    expect(els.dossier!.textContent).not.toContain('Nom du client');
    expect((els.commencer as unknown as { disabled: boolean }).disabled).toBe(false);
    // Commencer.
    els.commencer!.listeners.click!({});
    await flush();
    await flush();
    expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/etat') && c.body === JSON.stringify({ state: 'en_cours' }))).toBe(true);
    // Déposer.
    const file = { type: 'application/pdf', name: 'constat.pdf' };
    (els.fichier as unknown as { files: unknown[] }).files = [file];
    els.sorte!.value = 'amiante';
    els.faite!.value = '2027-07-11';
    els['form-piece']!.listeners.submit!({ preventDefault: () => undefined });
    await flush();
    await flush();
    const dep = calls.find((c) => c.url.includes('/pieces'))!;
    expect(dep.headers['content-type']).toBe('application/pdf');
    expect(dep.body).toBe(file);
    expect(els.depot!.textContent).toBe('Pièce reçue. Rangée dans la fiche du bien.');
    // La réponse d'un dépôt fait pour r1 n'écrit rien sur r2 ouverte entre-temps.
    let releaseUp: () => void = () => undefined;
    pending = new Promise<void>((r) => (releaseUp = r));
    els['form-piece']!.listeners.submit!({ preventDefault: () => undefined });
    pending = null;
    runOpen('r2');
    await flush();
    await flush();
    els.fichier!.value = 'C:\\fakepath\\b.pdf';
    releaseUp();
    await flush();
    await flush();
    expect(els.depot!.textContent).toBe('');
    expect(els.fichier!.value).toBe('C:\\fakepath\\b.pdf');
    button.listeners.click!({});
    await flush();
    await flush();
    // Un fichier choisi pour une demande ne suit jamais vers une autre : le formulaire est vidé à chaque ouverture.
    els.fichier!.value = 'C:\\fakepath\\autre.pdf';
    els.faite!.value = '2027-01-01';
    els.retour!.listeners.click!({});
    expect(els.fichier!.value).toBe('');
    expect(els.faite!.value).not.toBe('2027-01-01');
    els.fichier!.value = 'C:\\fakepath\\autre.pdf';
    button.listeners.click!({});
    expect(els.fichier!.value).toBe('');
    expect(els.depot!.textContent).toBe('');
    await flush();
    await flush();
    // Deux demandes ouvertes l'une après l'autre : la réponse dépassée de la première ne remplace jamais la seconde.
    let releaseA: () => void = () => undefined;
    pending = new Promise<void>((r) => (releaseA = r));
    button.listeners.click!({});
    pending = null;
    runOpen('r2');
    await flush();
    await flush();
    expect(els['titre-detail']!.textContent).toBe('Notaire');
    els.fichier!.value = 'C:\\fakepath\\b.pdf';
    releaseA();
    await flush();
    await flush();
    expect(els['titre-detail']!.textContent).toBe('Notaire');
    expect(els.fichier!.value).toBe('C:\\fakepath\\b.pdf');
    els.fichier!.value = '';
    // Une réponse arrivée après la déconnexion est ignorée : rien du dossier ne revient à l'écran.
    let release: () => void = () => undefined;
    const slowFetchGate = new Promise<void>((r) => (release = r));
    pending = slowFetchGate;
    button.listeners.click!({});
    els.sortir!.listeners.click!({});
    expect(els.dossier!.textContent).toBe('');
    release();
    await flush();
    await flush();
    await flush();
    expect(els.entree!.hidden).toBe(false);
    expect(els.detail!.hidden).toBe(true);
    expect(els.dossier!.textContent).toBe('');
    pending = null;
    storage.set('aimmo.partenaire.cle', 'k'.repeat(40));
    // Une clé refusée est effacée, l'entrée revient.
    answers['GET /v1/partenaires/espace'] = () => ({ status: 401, body: { ok: false } });
    els.retour!.listeners.click!({});
    await flush();
    await flush();
    expect(storage.has('aimmo.partenaire.cle')).toBe(false);
    expect(els.entree!.hidden).toBe(false);
    expect(els.etat!.textContent).toContain('Clé refusée');
  });
});
