import { expect, it } from 'vitest';
import { Acces, ControlesSignature, FicheClient, FicheUnique, Modeles, RegistreMandats, SignaturePapier, SqlJournalStore, applyMigrations, fromSyncSqlite, studio, type SqlDatabase, type Viewer } from '@aimmo/core';
import { handleRequest, type ApiConfig } from '../src/app.ts';
import { renderCertificatePage } from '../src/certificat-photo.ts';
import { MentionsAnnonce } from '../../core/src/annonces/mentions.ts';
import { sha256Hex } from '../src/index.ts';
import { mediaFiles } from '../src/worker.ts';
import { BUDGETS, budgetProblems, htmlProblems } from '../../core/src/design/audit.ts';
import { loadMigrations } from '../../core/test/migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from '../../core/test/sqlite.ts';
import { identiteAuCoffre } from '../../core/test/identite-coffre.ts';
import { designerTout } from '../../core/test/designation-jeu.ts';

// Réseau, agents, biens, photos, empreintes et clés inventés.
const BASE = 'https://aimmo-api.example.test';
const START = Date.parse('2027-10-14T08:00:00.000Z');
const DAY = 24 * 3_600_000;
const VIEWS = ['entree', 'sejour', 'cuisine', 'chambre_1', 'salle_d_eau'] as const;
const KEYS = { alex: 'test-cle-x10-alex-aaaaaaaaaaaaaaaaaaaaaaaaaaaa', direction: 'test-cle-x10-dir-bbbbbbbbbbbbbbbbbbbbbbbbbbbbb', partenaire: 'test-cle-x10-part-cccccccccccccccccccccccccccc' };
type Who = keyof typeof KEYS;
const uuid = (n: number, tail = '000000000000') => `${String(n).padStart(8, '0')}-0000-4000-8000-${tail}`;

async function setup(opts: { files?: boolean; extra?: Record<string, unknown> } = {}) {
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  let clock = START;
  const now = (): Date => new Date((clock += 1000));
  const journal = new SqlJournalStore(db);
  const store = new FicheClient(db, { now });
  const acces = new Acces(db, store, new FicheUnique(db, store, { now }), journal, { now });
  const network = (await store.createNetwork('Réseau test')).id;
  const alex = (await store.createAgent({ networkId: network, firstName: 'Alexandrine', lastName: 'Fictive' })).id;
  const direction = { role: 'direction' as const, userId: 'd1', networkId: network };
  const agent = { role: 'agent' as const, userId: alex, networkId: network };
  const stored = new Set<string>();
  // Le mandat signé en agence, sans délai de rétractation : le bien est diffusable par la porte de D05 [R42].
  const modeles = new Modeles(db, acces, journal, { now });
  const template = await modeles.createVersion(direction, 'mandat_vente_simple', 'Mandat de test : {{mandant.nom}}, {{honoraires.montant}} {{honoraires.charge}}, {{mandat.duree_mois}}.\n\nNuméro : {{registre.numero}} · {{bien.adresse}} · {{bien.cadastre}} · {{mandant.domicile}}.');
  await modeles.validate({ role: 'compliance', userId: 'c-1', networkId: network } as Viewer, template.ok ? template.template.id : '');
  await new ControlesSignature(db, acces, journal, { now }).setFeeSchedule(direction, { maxRatePercent: 5, minEur: 0 });
  await new RegistreMandats(db, journal, { now }).configure(direction, { prefix: 'T-', firstNumber: 1, width: 3 });
  // La carte professionnelle du réseau, inventée : les mentions obligatoires sont complètes [R43].
  await new MentionsAnnonce(db, acces, journal, { now }).setCardNumber(direction, 'CPI 0000 2027 000 000 001');
  const property = async (i: number, withMandate = true) => {
    const p = (await store.createProperty({ networkId: network, agentId: alex, reference: `STU-${i}`, kind: 'home', city: 'Villebrune', priceEur: 150_000 + i * 1000, surfaceM2: 45, rooms: 2, status: 'available' })).id;
    const photos = VIEWS.map((_, k) => `biens/${p}/${uuid(i * 10 + k)}.jpg`);
    for (const [k, ref] of photos.entries()) stored.add(ref).add(`biens/${p}/originaux/${uuid(i * 10 + k, '00000000000a')}.jpg`);
    const sheet = { characteristics: { bedrooms: 1, floor: null, floorsTotal: null, buildYear: null, heating: null, outdoor: [], landM2: null, parkingSpaces: 0, elevator: null }, energy: { energyClass: 'C', climateClass: 'C', annualCostMinEur: 800, annualCostMaxEur: 1100, costReferenceYear: 2025, diagnosedOn: '2027-01-15' }, coownership: { isCoownership: false }, risks: { inRiskZone: false }, media: photos.map((ref) => ({ ref, kind: 'photo', edit: 'lumiere_cadrage' })) };
    await db.run("INSERT INTO property_sheets (id, property_id, network_id, version, data, created_by, created_at) VALUES (?, ?, ?, 1, ?, 'agent:a', '2027-10-01')", [`s-${i}`, p, network, JSON.stringify(sheet)]);
    if (withMandate) {
      const seller = (await store.createPerson({ networkId: network, agentId: alex, firstName: 'Léa', lastName: `Vendeuse${i}` })).id;
      const project = (await store.createProject({ networkId: network, agentId: alex, personId: seller, kind: 'sell' })).id;
      await store.linkProjectProperty({ networkId: network, agentId: alex, projectId: project, propertyId: p, role: 'owned' });
      const signedAt = new Date(START - 30 * DAY);
      await identiteAuCoffre({ db, acces, journal, now }, agent, seller, { piece: 'carte_identite', seenAt: signedAt });
      await designerTout(db);
      const d = await modeles.generate(agent, { kind: 'mandat_vente_simple', personId: seller, propertyId: p, inputs: { 'honoraires.montant': 7500, 'honoraires.charge': 'vendeur', 'mandat.duree_mois': 12 } as never });
      if (!d.ok) throw new Error(d.code);
      const r = await new SignaturePapier(db, acces, journal, { now }).register(agent, d.document.id, { signedAt, place: 'agence', scanRef: `scans/test-${i}.pdf`, source: 'referral' });
      if (!r.ok) throw new Error(r.code);
    }
    return { id: p, photos, original: (k: number) => `biens/${p}/originaux/${uuid(i * 10 + k, '00000000000a')}.jpg` };
  };
  const ids: Record<Who, { role: string; userId: string }> = { alex: { role: 'agent', userId: alex }, direction: { role: 'direction', userId: 'd1' }, partenaire: { role: 'partner', userId: 'p-1' } };
  const apiKeys = JSON.stringify(await Promise.all((Object.keys(KEYS) as Who[]).map(async (w) => ({ sha256: await sha256Hex(KEYS[w]), networkId: network, ...ids[w] }))));
  const config = (files = opts.files !== false): ApiConfig => ({ db, apiKeys, mode: 'essai', now, ...(!files ? {} : { studio: { files: { has: async (r: string) => stored.has(r) }, ...(opts.extra ?? {}) } as never }) });
  const call = async (who: Who, method: string, path: string, body?: unknown) => {
    const init: RequestInit = { method, headers: { authorization: `Bearer ${KEYS[who]}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) };
    const r = await handleRequest(new Request(`${BASE}/v1${path}`, init), config());
    const type = r.headers.get('content-type') ?? '';
    return { status: r.status, body: type.startsWith('application/json') ? ((await r.json()) as any) : null, text: type.startsWith('text/html') ? await r.text() : null };
  };
  const page = async (method: string, path: string, files = true) => {
    const r = await handleRequest(new Request(`${BASE}${path}`, { method }), config(files && opts.files !== false));
    return { status: r.status, html: await r.text(), csp: r.headers.get('content-security-policy') ?? '' };
  };
  return { db, journal, network, alex, call, page, property };
}

describeWithSqlite('X10 · branchement de M19 dans le socle', () => {
  it('[R134] [R26] du guide à la publication par /v1/studio, la porte de D05 tenue, rien ne part hors du mode essai', async () => {
    // Même si un réseau réel était glissé dans la configuration, il ne passe pas : le socle ne transmet aucun canal.
    const real = { channel: 'instagram', mode: 'reel', post: async () => { throw new Error('envoi réel interdit'); } };
    const t = await setup({ extra: { channels: [real] } });
    const b = await t.property(1);
    for (const [k, view] of VIEWS.entries()) expect((await t.call('alex', 'POST', `/studio/biens/${b.id}/guide/vues`, { viewKey: view, mediaRef: b.photos[k] })).status).toBe(200);
    expect((await t.call('direction', 'POST', `/studio/biens/${b.id}/guide/validation`)).body).toMatchObject({ ok: true, data: { ready: true } });
    const cert = await t.call('alex', 'POST', `/studio/biens/${b.id}/photos`, {
      resultRef: b.photos[0],
      resultSha256: 'b'.repeat(64),
      originalRef: b.original(0),
      originalSha256: 'a'.repeat(64),
      operations: [{ op: 'exposition', ev: 0.5 }],
      processedOn: 'appareil',
    });
    expect(cert.status).toBe(200);
    const prep = await t.call('alex', 'POST', `/studio/biens/${b.id}/publications`, { event: 'nouveau_bien', visuals: [b.photos[0]] });
    expect(prep.body).toMatchObject({ ok: true, mode: 'essai' });
    // [R43] Les mentions obligatoires, calculées par M07, sont sous le texte.
    expect(prep.body.data.text).toMatch(/Prix : 151\s000\s€, honoraires à la charge du vendeur\./u);
    expect(prep.body.data.text).toContain('Carte professionnelle n° CPI 0000 2027 000 000 001.');
    const postId = prep.body.data.id as string;
    expect((await t.call('alex', 'POST', `/studio/publications/${postId}/visuels`, { ref: b.photos[0], addressVisible: false, personVisible: false })).status).toBe(200);
    expect((await t.call('alex', 'POST', `/studio/publications/${postId}/validation`)).status).toBe(200);
    const sent = await t.call('alex', 'POST', `/studio/publications/${postId}/envoi`, { targets: [{ channel: 'instagram', account: 'agent' }] });
    expect(sent.body).toMatchObject({ ok: true, mode: 'essai', data: { sends: [{ outcome: 'envoye' }] } });
    expect(await t.db.all("SELECT COUNT(*) AS n FROM social_post_attempts WHERE mode <> 'essai'")).toEqual([{ n: 0 }]);
    expect(await t.db.all("SELECT COUNT(*) AS n FROM social_post_attempts WHERE mode = 'essai'")).toEqual([{ n: 1 }]);

    // [R42] Un bien sans mandat : la vraie porte de D05 refuse, par le socle.
    const nm = await t.property(2, false);
    await t.call('alex', 'POST', `/studio/biens/${nm.id}/photos`, { resultRef: nm.photos[0], resultSha256: 'c'.repeat(64), originalRef: nm.original(0), originalSha256: 'd'.repeat(64), operations: [{ op: 'contraste', amount: 10 }], processedOn: 'appareil' });
    expect((await t.call('alex', 'POST', `/studio/biens/${nm.id}/publications`, { event: 'nouveau_bien', visuals: [nm.photos[0]] })).body).toMatchObject({ rule: 'R42', code: 'bien_non_diffusable' });
  });

  it('[R46] [R13] [R201] le certificat public, sans clé : ni bien, ni adresse, ni agent, et dans le système de design', async () => {
    const t = await setup();
    const b = await t.property(1);
    const cert = await t.call('alex', 'POST', `/studio/biens/${b.id}/photos`, {
      resultRef: b.photos[0],
      resultSha256: 'e'.repeat(64),
      originalRef: b.original(0),
      originalSha256: 'f'.repeat(64),
      operations: [{ op: 'exposition', ev: 0.5 }, { op: 'verticales', degrees: -1 }],
      processedOn: 'appareil',
    });
    const path = cert.body.data.path as string;
    expect(path).toMatch(/^\/certificat-photo\/[0-9a-f]{32}$/);
    const p = await t.page('GET', path);
    expect(p.status).toBe(200);
    expect(p.html).toContain('e'.repeat(64));
    expect(p.html).toContain('f'.repeat(64));
    expect(p.html).toContain('Verticales');
    expect(p.html).not.toContain(b.id);
    expect(p.html).not.toMatch(/Villebrune|STU-|Alexandrine|Fictive|biens\//);
    expect(htmlProblems(p.html)).toEqual([]);
    expect(budgetProblems({ html: p.html }, BUDGETS.page)).toEqual([]);
    expect(p.csp).toContain("default-src 'none'");
    expect(p.csp).toContain("form-action 'none'");
    // Un jeton inconnu ou mal formé : la même page, 404 ; une écriture : refusée.
    expect((await t.page('GET', `/certificat-photo/${'0'.repeat(32)}`)).status).toBe(404);
    expect((await t.page('GET', `/certificat-photo/${'A'.repeat(32)}`)).status).toBe(404);
    expect((await t.page('POST', path)).status).toBe(405);
    // La page sert sans le stockage des fichiers : elle ne lit que le certificat.
    expect((await t.page('GET', path, false)).status).toBe(200);
  });

  it('[R16] le rôle est refusé par le socle et écrit au journal ; sans stockage des fichiers, le Studio est fermé', async () => {
    const t = await setup();
    const b = await t.property(1);
    const before = (await t.journal.all()).filter((e) => e.type === 'acces.refuse').length;
    const r = await t.call('partenaire', 'GET', `/studio/biens/${b.id}/guide`);
    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({ rule: 'R16', code: 'role' });
    expect((await t.journal.all()).filter((e) => e.type === 'acces.refuse').length - before).toBe(1);
    expect((await t.call('alex', 'GET', `/studio/biens/${b.id}/guide`)).status).toBe(200);
    const closed = await setup({ files: false });
    const c = await closed.property(1);
    expect((await closed.call('alex', 'GET', `/studio/biens/${c.id}/guide`)).body).toMatchObject({ ok: false, code: 'studio_files_not_configured' });
  });
});

it('X10 · `studio` exporté par @aimmo/core, et `MEDIA` lu par sa seule existence', async () => {
  expect(typeof studio.CertificatsPhotos).toBe('function');
  expect(studio.CERTIFICATE_PATH).toBe('/certificat-photo/');
  const asked: string[] = [];
  const withHead = mediaFiles({ head: async (k: string) => (asked.push(`head:${k}`), k === 'a' ? {} : null), get: async (k: string) => (asked.push(`get:${k}`), null) });
  expect([await withHead.has('a'), await withHead.has('b')]).toEqual([true, false]);
  expect(asked).toEqual(['head:a', 'head:b']);
  const withoutHead = mediaFiles({ get: async (k: string) => (k === 'a' ? { body: '' } : null) });
  expect([await withoutHead.has('a'), await withoutHead.has('b')]).toEqual([true, false]);
  // Une panne du stockage remonte : la couche métier la dit au journal et ferme tout [R130].
  await expect(mediaFiles({ head: async () => { throw new Error('panne'); }, get: async () => null }).has('a')).rejects.toThrow('panne');
});

it('[R48] [R201] le certificat d’une photo aménagée le dit, dans le système de design', () => {
  const html = renderCertificatePage({
    token: '0'.repeat(32),
    issuedOn: '2027-10-01',
    resultSha256: '1'.repeat(64),
    originalSha256: '2'.repeat(64),
    originalKept: true,
    localEdits: 'amenagement_virtuel',
    retouches: [],
    retouchMention: null,
    corrections: [],
    virtualStaging: true,
    mention: 'Aménagement virtuel',
    statement: 'Aménagement virtuel ajouté.',
    path: `/certificat-photo/${'0'.repeat(32)}`,
  });
  expect(html).toContain('« Aménagement virtuel »');
  expect(html).toContain('1er octobre 2027');
  expect(htmlProblems(html)).toEqual([]);
  expect(budgetProblems({ html }, BUDGETS.page)).toEqual([]);
});
