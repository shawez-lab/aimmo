import { expect, it, vi } from 'vitest';
import * as core from '@aimmo/core';
import { FicheClient, SqlJournalStore, applyMigrations, fromSyncSqlite, type JournalEntry, type JournalStore, type SqlDatabase } from '@aimmo/core';
import { handleRequest, type ApiConfig } from '../src/app.ts';
import { sha256Hex } from '../src/index.ts';
import { PARTENAIRES_CREDENTIALS_JOB, PARTENAIRES_FOLLOW_UP_JOB, PARTENAIRES_PROSPECTING_JOB, partenairesJobs, partnerOptOutBase } from '../src/partenaires.ts';
import { runScheduler } from '../src/planificateur.ts';
import { loadMigrations } from '../../core/test/migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from '../../core/test/sqlite.ts';

// Réseau, agents, clients, partenaires et clés inventés ; adresses sur des domaines d'exemple.
// Le 12 juillet 2027 est un lundi ; été : Paris = UTC + 2.
const BASE = 'https://aimmo-api.example.test';
const OPT_OUT = 'https://aimmo-api.example.test/partenaires/opposition/';
const KEY = (who: string): string => `test-cle-u09-${who}-${'x'.repeat(32)}`;
const at = (iso: string): number => Date.parse(iso);

async function setup() {
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  let clock = at('2027-07-12T08:00:00.000Z');
  const now = (): Date => new Date((clock += 1_000));
  const setClock = (iso: string) => (clock = at(iso));
  const journal = new SqlJournalStore(db);
  const store = new FicheClient(db, { now });
  const network = (await store.createNetwork('Réseau test')).id;
  const alex = (await store.createAgent({ networkId: network, firstName: 'Alex', lastName: 'Agent' })).id;
  const seller = (await store.createPerson({ networkId: network, agentId: alex, firstName: 'Léa', lastName: 'Exemple' })).id;
  const project = (await store.createProject({ networkId: network, agentId: alex, personId: seller, kind: 'sell' })).id;
  const property = (await store.createProperty({ networkId: network, agentId: alex, reference: 'T-1', kind: 'home', postalCode: '21000' })).id;
  await store.linkProjectProperty({ networkId: network, agentId: alex, projectId: project, propertyId: property, role: 'owned' });
  const refs = new Set<string>();
  const uploaded = new Map<string, Uint8Array>();
  const files = { has: async (r: string) => refs.has(r) || uploaded.has(r), put: async (r: string, b: Uint8Array) => void uploaded.set(r, b) };
  const proof = (prefix: string): string => {
    const r = `${prefix}/00000000-0000-4000-8000-${String(refs.size + 1).padStart(12, '0')}.pdf`;
    refs.add(r);
    return r;
  };
  const ids = new Map<string, { role: string; userId: string }>([
    ['dir', { role: 'direction', userId: 'dir-1' }],
    ['alex', { role: 'agent', userId: alex }],
    ['conf', { role: 'compliance', userId: 'conf-1' }],
  ]);
  const apiKeys = async () => JSON.stringify(await Promise.all([...ids].map(async ([w, v]) => ({ sha256: await sha256Hex(KEY(w)), networkId: network, ...v }))));
  const config = async (over: Partial<ApiConfig> = {}): Promise<ApiConfig> => ({ db, apiKeys: await apiKeys(), mode: 'essai', now, pieces: { has: files.has }, partenaires: { files, optOutBase: OPT_OUT }, ...over });
  const call = async (who: string, method: string, path: string, body?: unknown, over: Partial<ApiConfig> = {}) => {
    const headers: Record<string, string> = { authorization: `Bearer ${KEY(who)}` };
    if (body !== undefined) headers['content-type'] = 'application/json';
    const r = await handleRequest(new Request(`${BASE}/v1${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), await config(over));
    return { status: r.status, body: (await r.json()) as { ok: boolean; data?: any; rule?: string; code?: string } };
  };
  const day = (d = 0): string => new Date(clock + d * 86_400_000).toISOString().slice(0, 10);
  /** Un notaire rangé par la direction, avec son assurance, puis sa clé de partenaire. */
  const partner = async (name: string): Promise<string> => {
    const r = await call('dir', 'POST', '/partenaires/annuaire', { trade: 'notaire', businessName: `Notaires ${name}`, postcodes: ['21000'] });
    expect(r.status).toBe(200);
    const id = r.body.data.partnerId as string;
    const c = await call('dir', 'POST', `/partenaires/annuaire/${id}/justificatifs`, { kind: 'assurance_rcp', number: 'N-1', validFrom: day(-30), validUntil: day(20), proofRef: proof(`partenaires/${id}`) });
    expect([c.status, c.body.code]).toEqual([200, undefined]);
    ids.set(name, { role: 'partner', userId: id });
    return id;
  };
  const events = (type: string) => db.all<{ subject: string | null; data: string }>('SELECT subject, data FROM journal WHERE type = ? ORDER BY seq', [type]);
  return { db, journal, network, alex, seller, project, property, call, config, partner, proof, setClock, now, events };
}

it('U09 · @aimmo/core exporte M18 sous son propre nom', () => {
  expect(typeof core.partenaires.Annuaire).toBe('function');
  expect(typeof core.partenaires.Prospection).toBe('function');
  expect(typeof core.partenaires.SuiviPartenaires).toBe('function');
});

describeWithSqlite('U09 · M18 branché dans le socle', () => {
  it('[R16] [R77] les routes de M18 sont servies par le socle : rôle contrôlé, un partenaire ne lit que ce qui lui est confié', async () => {
    const t = await setup();
    const zoe = await t.partner('zoe');
    await t.partner('yves');
    const proposed = await t.call('alex', 'POST', '/partenaires/relations', { projectId: t.project, trade: 'notaire', propertyId: t.property, postcode: '21000' });
    expect(proposed.status).toBe(200);
    const referral = proposed.body.data.referralId as string;
    expect((await t.call('alex', 'POST', `/partenaires/relations/${referral}/accord`, { partnerId: zoe, consentAt: new Date(t.now().getTime() - 500).toISOString(), channel: 'ecrit', proofRef: t.proof(`relations/${referral}`) })).status).toBe(200);
    expect((await t.call('alex', 'POST', `/partenaires/relations/${referral}/confier`)).status).toBe(200);

    // Le partenaire confié lit sa demande ; l'autre ne voit rien.
    const mine = await t.call('zoe', 'GET', '/partenaires/espace');
    expect(mine.status).toBe(200);
    expect(mine.body.data.map((r: { referralId: string }) => r.referralId)).toEqual([referral]);
    expect((await t.call('yves', 'GET', '/partenaires/espace')).body.data).toEqual([]);
    expect((await t.call('yves', 'GET', `/partenaires/espace/${referral}`)).status).toBe(403);

    // Aucune fiche client, aucun bien, aucun dossier, aucune route d'agent pour un partenaire [R16, R77].
    const statuses: Record<string, number> = {};
    const paths = ['/fiches', `/fiches/${t.seller}`, `/fiches/${t.seller}/resume`, `/biens/${t.property}`, `/mandats/${t.property}/conditions`, '/dossiers/dossier-test/pieces', '/partenaires/projets', `/partenaires/relations/${referral}`, '/conformite/risque'];
    for (const path of paths) {
      const r = await t.call('zoe', 'GET', path);
      statuses[path] = r.status;
      expect(JSON.stringify(r.body), path).not.toContain('Exemple');
    }
    // Fiche, bien, mandat, dossier de vente, routes de l'agent et de la conformité : tout est refusé au partenaire.
    // (un mandat ou un dossier inconnu répond 404 : rien n'en est rendu non plus).
    for (const path of paths) expect([path, statuses[path]! >= 403 && statuses[path]! <= 404]).toEqual([path, true]);
    for (const path of paths.filter((p) => !/^\/(mandats|dossiers)\//.test(p))) expect([path, statuses[path]]).toEqual([path, 403]);
    // Un rôle non admis est refusé avant la lecture du corps, au journal.
    expect(await t.call('alex', 'POST', '/partenaires/prospection', 'pas du json')).toMatchObject({ status: 403, body: { rule: 'R16', code: 'role' } });
    expect((await t.events('acces.refuse')).filter((e) => String(JSON.parse(e.data).kind).startsWith('partenaires.prospection')).length).toBe(1);
    // Sans stockage des fichiers, M18 est fermé ; hors mode essai, rien n'est lu.
    expect(await t.call('alex', 'GET', '/partenaires/projets', undefined, { partenaires: { files: null } })).toMatchObject({ status: 503, body: { code: 'partner_files_not_configured' } });
  });

  it('[R04] [R79] la page d’opposition et l’espace partenaire sont servis par le socle, en mode essai seulement', async () => {
    const t = await setup();
    const get = async (path: string, mode = 'essai') => handleRequest(new Request(`${BASE}${path}`), await t.config({ mode }));
    const space = await get('/partenaire/');
    expect(space.status).toBe(200);
    expect(space.headers.get('content-security-policy')).toContain("connect-src 'self'");
    expect((await get('/partenaire/partenaire.js')).status).toBe(200);
    expect((await get('/partenaire/', 'reel')).status).toBe(503);
    const page = await get(`/partenaires/opposition/${'a'.repeat(32)}`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('Ne plus recevoir de message');
    expect((await get(`/partenaires/opposition/${'a'.repeat(32)}`, 'reel')).status).toBe(503);
    expect((await get('/partenaires/opposition/court')).status).toBe(404);
  });

  it('[R05] [R18] [R79] les passages de M18 tournent une fois par créneau, préparent sans rien envoyer', async () => {
    const t = await setup();
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const zoe = await t.partner('zoe');
    const proposed = await t.call('alex', 'POST', '/partenaires/relations', { projectId: t.project, trade: 'notaire', propertyId: t.property, postcode: '21000' });
    const referral = proposed.body.data.referralId as string;
    await t.call('alex', 'POST', `/partenaires/relations/${referral}/accord`, { partnerId: zoe, consentAt: new Date(t.now().getTime() - 500).toISOString(), channel: 'ecrit', proofRef: t.proof(`relations/${referral}`) });
    expect((await t.call('alex', 'POST', `/partenaires/relations/${referral}/confier`)).status).toBe(200);
    for (const i of [1, 2]) {
      expect((await t.call('dir', 'POST', '/partenaires/prospection', { email: `contact${i}@cabinet-exemple.test`, addressKind: 'professionnelle', trade: 'diagnostiqueur', businessName: `Cabinet ${i}`, source: 'annuaire public de test' })).status).toBe(200);
    }

    // Jeudi 15 juillet, 10 h à Paris (le 14 est férié) : la relance est due (2 jours ouvrés), la prospection du jour
    // passe ; deux fois le même créneau ne prépare rien de plus.
    t.setClock('2027-07-15T08:00:00.000Z');
    const first = await runScheduler({ db: t.db, mode: 'essai', now: t.now, partnerOptOutBase: OPT_OUT });
    expect(first?.ran).toEqual(expect.arrayContaining([PARTENAIRES_FOLLOW_UP_JOB, PARTENAIRES_PROSPECTING_JOB]));
    expect(first?.ran).not.toContain(PARTENAIRES_CREDENTIALS_JOB);
    const second = await runScheduler({ db: t.db, mode: 'essai', now: t.now, partnerOptOutBase: OPT_OUT });
    expect(second?.ran ?? []).not.toEqual(expect.arrayContaining([PARTENAIRES_FOLLOW_UP_JOB]));
    expect(await t.db.all('SELECT referral_id, kind FROM partner_followups')).toEqual([{ referral_id: referral, kind: 'relance' }]);
    expect(await t.db.all('SELECT count(*) AS n FROM partner_prospect_mails')).toEqual([{ n: 2 }]);
    // Rien n'est parti : aucun message, aucune boîte d'essai, aucun appel sortant.
    expect(await t.db.all('SELECT count(*) AS n FROM messages')).toEqual([{ n: 0 }]);
    expect(fetchSpy).not.toHaveBeenCalled();

    // Le lendemain et le surlendemain à 6 h à Paris (4 h UTC en été), l'assurance qui finit dans moins de 30 jours
    // donne une alerte, une seule.
    t.setClock('2027-07-16T04:00:00.000Z');
    await runScheduler({ db: t.db, mode: 'essai', now: t.now, partnerOptOutBase: OPT_OUT });
    t.setClock('2027-07-17T04:00:00.000Z');
    await runScheduler({ db: t.db, mode: 'essai', now: t.now, partnerOptOutBase: OPT_OUT });
    const alerts = await t.events('partenaire.justificatif_echeance');
    expect(alerts.map((a) => [a.subject, JSON.parse(a.data).kind])).toEqual([[`partner:${zoe}`, 'assurance_rcp']]);
    // Sans lien d'opposition, la prospection ne prépare rien (lundi 19, 10 h).
    t.setClock('2027-07-19T08:00:00.000Z');
    await runScheduler({ db: t.db, mode: 'essai', now: t.now });
    expect(await t.db.all('SELECT count(*) AS n FROM partner_prospect_mails')).toEqual([{ n: 2 }]);
    expect((await t.events('prospection.sans_opposition')).length).toBe(1);
    fetchSpy.mockRestore();
  });

  it('[R73] une alerte de justificatif dont l’écriture au journal échoue n’est pas perdue : elle revient au passage suivant', async () => {
    const t = await setup();
    await t.partner('zoe');
    await t.partner('yves');
    let failOn = 2;
    let seen = 0;
    const flaky: JournalStore = {
      append: async (e: JournalEntry) => {
        if (e.type === 'partenaire.justificatif_echeance' && ++seen === failOn) throw new Error('journal indisponible');
        return t.journal.append(e);
      },
      last: () => t.journal.last(),
      all: () => t.journal.all(),
      bySubject: (s: string) => t.journal.bySubject(s),
      byPeriod: (a: string, b: string) => t.journal.byPeriod(a, b),
    };
    const job = partenairesJobs(t.db, flaky, { now: t.now }).find((j) => j.name === PARTENAIRES_CREDENTIALS_JOB)!;
    await expect(job.run({ job: PARTENAIRES_CREDENTIALS_JOB, slot: 'test', at: new Date() })).rejects.toThrow('journal indisponible');
    expect((await t.events('partenaire.justificatif_echeance')).length).toBe(1);
    failOn = 0;
    await job.run({ job: PARTENAIRES_CREDENTIALS_JOB, slot: 'test', at: new Date() });
    await job.run({ job: PARTENAIRES_CREDENTIALS_JOB, slot: 'test', at: new Date() });
    expect((await t.events('partenaire.justificatif_echeance')).length).toBe(2);
  });
});

it('[R79] [R04] le lien d’opposition n’est accepté que vers la page d’opposition, en https et sans chiffre', () => {
  expect(partnerOptOutBase(OPT_OUT)).toBe(OPT_OUT);
  for (const bad of ['https://aimmo-api.example.test/alertes/desinscription/', 'http://aimmo-api.example.test/partenaires/opposition/', 'https://aimmo2.example.test/partenaires/opposition/', 'https://aimmo-api.example.test/partenaires/opposition', '', null, undefined]) {
    expect(partnerOptOutBase(bad)).toBeNull();
  }
});

describeWithSqlite('U12 · adresse des partenaires et envois de M18 au planificateur', () => {
  it('[R16] [R03] seule la direction range l’adresse et l’accord d’un partenaire, ou son opposition', async () => {
    const t = await setup();
    const zoe = await t.partner('zoe');
    const body = { email: 'etude@notaires-zoe.example', consentProof: 'Accord écrit dans la convention de partenariat.' };
    expect((await t.call('alex', 'POST', `/partenaires/annuaire/${zoe}/adresse`, body)).status).toBe(403);
    expect((await t.call('zoe', 'POST', `/partenaires/annuaire/${zoe}/adresse`, body)).status).toBe(403);
    const ok = await t.call('dir', 'POST', `/partenaires/annuaire/${zoe}/adresse`, body);
    expect([ok.status, ok.body.data.version]).toEqual([200, 1]);
    expect((await t.call('alex', 'POST', `/partenaires/annuaire/${zoe}/opposition`)).status).toBe(403);
    expect((await t.call('dir', 'POST', `/partenaires/annuaire/${zoe}/opposition`)).status).toBe(200);
    // L'adresse n'est jamais écrite au journal [R13].
    expect(JSON.stringify(await t.db.all('SELECT * FROM journal'))).not.toContain('notaires-zoe.example');
  });

  it('le passage des envois tourne de 8 h à 19 h, une fois par créneau, sans rien envoyer réellement', async () => {
    const t = await setup();
    const job = partenairesJobs(t.db, t.journal, { now: t.now }).find((j) => j.name === 'partenaires.envois');
    expect(job?.hours).toEqual([8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
    await job!.run({ job: 'partenaires.envois', slot: '2027-07-12T10', at: t.now() });
    expect(Number((await t.db.first<{ n: number }>('SELECT COUNT(*) AS n FROM pro_trial_outbox'))?.n)).toBe(0);
  });
});
