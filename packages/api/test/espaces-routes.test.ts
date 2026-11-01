import { expect, it } from 'vitest';
import { Acces, FicheClient, FicheUnique, SqlJournalStore, applyMigrations, fromSyncSqlite, type SqlDatabase, type Viewer } from '@aimmo/core';
import { BUDGETS, budgetProblems, htmlProblems } from '../../core/src/design/audit.ts';
import type { ClientSide, GestesAcquereur, SourcesAcquereur, SourcesProprietaire, SourcesVendeur } from '../../core/src/espaces/index.ts';
import { ESPACE_PATH, SESSION_COOKIE, espacesRoutes, frenchDate, handleEspacePublic, type EspacesServices } from '../src/espaces.ts';
import { loadMigrations } from '../../core/test/migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from '../../core/test/sqlite.ts';

// Tout est inventé : réseau, agents, clients, biens, visiteurs. Le 8 juin 2027 est un mardi.
const START = Date.parse('2027-06-08T08:00:00.000Z');
const ORIGIN = 'https://espace.aimmo.example';
const KEY = { id: 'essai-a', secret: 'cle-de-test-inventee-pour-le-releve-0001' };
const CONSENT = { consentProof: 'accord donné au rendez-vous, pour recevoir le lien de son espace' };

async function setup(options: { keys?: boolean } = {}) {
  let clock = START;
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  const now = (): Date => new Date((clock += 1000));
  const journal = new SqlJournalStore(db);
  const store = new FicheClient(db, { now });
  const acces = new Acces(db, store, new FicheUnique(db, store, { now }), journal, { now });
  const network = await store.createNetwork('Réseau Essai');
  const alexAgent = await store.createAgent({ networkId: network.id, firstName: 'Alex', lastName: 'Essai' });
  const agent: Viewer = { role: 'agent', userId: alexAgent.id, networkId: network.id };
  const sides = new Map<string, ClientSide[]>();
  const refs = new Map<string, string>();
  const visitor = (n: number) => ({ personId: `visiteur-${n}`, firstName: `Visiteurnom${n}`, lastName: 'Inventé', emails: [`visiteur${n}@example.test`], phones: [] });
  const vendeur: SourcesVendeur = {
    sellerPropertiesOf: async (_n, personId) => (sides.get(personId)?.includes('vendeur') ? [{ propertyId: `bien-${refs.get(personId)}`, reference: refs.get(personId)!, city: 'Dijon', status: 'available', statusAt: '2027-05-02T09:00:00.000Z', askingPriceEur: 245_000, mandateSignedAt: '2027-05-01T10:00:00.000Z' }] : []),
    visitsOf: async (_n, propertyId) => [{ id: `v-${propertyId}`, at: '2027-06-05T14:00:00.000Z', state: 'faite', report: { text: 'Lumineux, réserve sur la cuisine.', interest: 'intéressé', validatedAt: '2027-06-05T18:00:00.000Z' }, visitor: visitor(Number(propertyId.slice(-1))) }],
    offersOf: async () => [],
    documentsOf: async () => [{ id: 'd1', title: 'Mandat de vente', kind: 'mandat', addedAt: '2027-05-01T10:00:00.000Z', signature: 'signe', signedAt: '2027-05-01T10:30:00.000Z' }],
    appointmentsOf: async () => [],
    weeklyPointsOf: async () => [],
    earliestDeedOf: async () => null,
  };
  const proprietaire: SourcesProprietaire = { ownerPropertiesOf: async () => [], rentalsOf: async () => [], applicationsOf: async () => [], leaseOf: async () => null, inspectionsOf: async () => [], valueOf: async () => null, documentsOf: async () => [] };
  const acquereur: SourcesAcquereur = {
    proposedOf: async (_n, personId) =>
      sides.get(personId)?.includes('acquereur')
        ? [{ propertyId: `bien-${refs.get(personId)}`, reference: refs.get(personId)!, city: 'Dijon', kind: 'appartement', surfaceM2: 64, rooms: 3, priceEur: 210_000, energyClass: 'C', publishedAt: '2027-05-20T08:00:00.000Z', proposedAt: '2027-06-01T08:00:00.000Z', diffusable: true, sellers: [{ personId: 'vendeur-x', firstName: 'Vendeurnom', lastName: 'Inventé' }] }]
        : [],
    visitsOf: async () => [],
    offersOf: async () => [],
    filesOf: async () => [],
    investorOf: async () => null,
    tenantApplicationsOf: async () => [],
    sellersOf: async () => [],
    alertsRequested: async () => false,
  };
  const gestes: GestesAcquereur & { calls: string[] } = {
    calls: [],
    bookVisit: async (c, p) => (gestes.calls.push(`visite:${c.personId}:${p}`), { ok: true, value: { booked: true } }),
    writeOffer: async () => ({ ok: false, rule: 'R55', code: 'sans_financement' }),
    addFinancingPiece: async () => ({ ok: true, value: {} }),
    requestAlerts: async () => ({ ok: true, value: {} }),
  };
  const s: EspacesServices = {
    db,
    journal,
    now,
    acces,
    networkId: network.id,
    parties: { sidesOf: async (_n, personId) => sides.get(personId) ?? [] },
    vendeur,
    proprietaire,
    acquereur,
    gestes,
    releveKeys: options.keys === false ? [] : [KEY],
    baseUrl: `${ORIGIN}${ESPACE_PATH}`,
  };
  const routes = espacesRoutes();
  const callAgent = async (viewer: Viewer, path: string, body: unknown) => {
    const route = routes.find((r) => r.pattern.test(path))!;
    const response = await route.handle(s, viewer, (route.pattern.exec(path) ?? []).slice(1), new Request(`https://api.example/v1${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));
    return { status: response.status, body: (await response.json()) as { ok: boolean; code?: string; rule?: string } };
  };
  const pub = async (method: string, path: string, init: { cookie?: string; form?: Record<string, string>; json?: unknown; headers?: Record<string, string> } = {}) => {
    const headers: Record<string, string> = { ...(init.cookie ? { cookie: `${SESSION_COOKIE}=${init.cookie}` } : {}), ...(method === 'POST' ? { origin: ORIGIN } : {}), ...init.headers };
    let body: string | undefined;
    if (init.form) {
      headers['content-type'] = 'application/x-www-form-urlencoded';
      body = new URLSearchParams(init.form).toString();
    } else if (init.json !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(init.json);
    }
    const response = await handleEspacePublic(new Request(`${ORIGIN}${path}`, { method, headers, ...(body !== undefined ? { body } : {}) }), s);
    if (!response) throw new Error(`pas une page de l’espace : ${path}`);
    return { status: response.status, headers: response.headers, text: await response.text() };
  };
  let n = 0;
  /** Un client inventé d'Alex, partie à un dossier, son espace ouvert par l'agent ; rend son jeton de lien. */
  const client = async (side: ClientSide) => {
    n += 1;
    const p = await store.createPerson({ networkId: network.id, agentId: alexAgent.id, firstName: `Client${'ABCDEFGHIJKLMN'[n]}`, lastName: 'Inventé' });
    const email = `client${n}.invente@example.test`;
    await store.addIdentifier({ networkId: network.id, personId: p.id, kind: 'email', value: email });
    sides.set(p.id, [side]);
    refs.set(p.id, `REF-${side === 'vendeur' ? 'V' : 'A'}${n}`);
    expect((await callAgent(agent, `/espaces/personnes/${p.id}/ouvrir`, CONSENT)).body).toMatchObject({ ok: true });
    return { id: p.id, email, ref: refs.get(p.id)!, token: await lastToken(p.id) };
  };
  const lastToken = async (personId: string): Promise<string> => {
    const rows = await db.all<{ body: string }>(`SELECT m.body FROM messages m JOIN trial_outbox t ON t.message_id = m.id WHERE m.person_id = ? ORDER BY m.occurred_at DESC, m.rowid DESC`, [personId]);
    const m = /espace\/([a-z]{40})/.exec(rows[0]?.body ?? '');
    if (!m) throw new Error('jeton');
    return m[1]!;
  };
  /** Ouvre le lien par le bouton, et rend le cookie de séance. */
  const enter = async (token: string): Promise<string> => {
    const r = await pub('POST', `${ESPACE_PATH}${token}`);
    expect(r.status).toBe(303);
    const set = r.headers.get('set-cookie') ?? '';
    expect(set).toMatch(/HttpOnly; Secure; SameSite=Strict/);
    return /=([a-z]{40});/.exec(set)![1]!;
  };
  return { db, journal, s, agent, store, network, sides, refs, callAgent, pub, client, enter, gestes, advance: (ms: number) => (clock += ms) };
}

describeWithSqlite('EC06 · routes et page de l’espace', () => {
  it('[R161] [R160] parcours de 5 vendeurs et 5 acquéreurs tests, de l’invitation à l’espace, sans fuite de l’un à l’autre', async () => {
    const t = await setup();
    const clients = [];
    for (let i = 0; i < 5; i += 1) clients.push(await t.client('vendeur'), await t.client('acquereur'));
    for (const c of clients) {
      const cookie = await t.enter(c.token);
      const home = await t.pub('GET', ESPACE_PATH, { cookie });
      expect(home.status).toBe(200);
      expect(home.text).toContain(c.ref);
      for (const other of clients.filter((o) => o.id !== c.id)) expect(home.text, `${c.ref} voit ${other.ref}`).not.toContain(other.ref);
      expect(home.text).not.toMatch(/Visiteurnom|Vendeurnom|visiteur\d@|example\.test/);
    }
    // Rien n'est parti hors de la boîte d'essai [R26].
    expect(await t.db.all("SELECT 1 FROM messages m WHERE m.body LIKE '%lien de votre espace%' AND m.id NOT IN (SELECT message_id FROM trial_outbox)")).toHaveLength(0);
  });

  it('[R160] afficher le lien ne le brûle pas ; seul le bouton l’ouvre, une fois', async () => {
    const t = await setup();
    const c = await t.client('vendeur');
    for (let i = 0; i < 3; i += 1) {
      const shown = await t.pub('GET', `${ESPACE_PATH}${c.token}`);
      expect(shown.status).toBe(200);
      expect(shown.text).toContain('Entrer dans mon espace');
    }
    await t.enter(c.token);
    const again = await t.pub('POST', `${ESPACE_PATH}${c.token}`);
    expect(again.status).toBe(410);
    expect(again.headers.get('set-cookie')).toBeNull();
  });

  it('[R160] la demande de lien répond pareil, adresse connue ou non', async () => {
    const t = await setup();
    const c = await t.client('vendeur');
    const known = await t.pub('POST', `${ESPACE_PATH}demande`, { form: { adresse: c.email } });
    const unknown = await t.pub('POST', `${ESPACE_PATH}demande`, { form: { adresse: 'inconnu.invente@example.test' } });
    expect(known.status).toBe(unknown.status);
    expect(known.text).toBe(unknown.text);
  });

  it('[R16] seul l’agent du client ou la direction ouvre son espace ; un autre rôle est refusé au journal', async () => {
    const t = await setup();
    const p = await t.store.createPerson({ networkId: t.network.id, agentId: t.agent.userId, firstName: 'Client', lastName: 'Inventé' });
    const compliance: Viewer = { role: 'compliance', userId: 'conf-1', networkId: t.network.id };
    expect((await t.callAgent(compliance, `/espaces/personnes/${p.id}/ouvrir`, CONSENT)).body).toEqual({ ok: false, rule: 'R16', code: 'role' });
    expect((await t.callAgent(t.agent, `/espaces/personnes/${p.id}/ouvrir`, {})).status).toBe(409);
    const refused = (await t.journal.all()).filter((e) => e.type === 'acces.refuse');
    expect(refused.map((e) => (e.data as { kind: string }).kind)).toEqual(['espaces.ouvrir']);
    // Un agent du même réseau qui n'est pas celui du client : refusé, aucun lien rangé ni envoyé.
    const bea = await t.store.createAgent({ networkId: t.network.id, firstName: 'Bea', lastName: 'Essai' });
    const other = await t.callAgent({ role: 'agent', userId: bea.id, networkId: t.network.id }, `/espaces/personnes/${p.id}/ouvrir`, CONSENT);
    expect(other.body).toMatchObject({ ok: false, rule: 'R16' });
    expect([403, 404]).toContain(other.status);
    expect(await t.db.all('SELECT id FROM client_space_links WHERE person_id = ?', [p.id])).toHaveLength(0);
    // La direction l'ouvre, pour une personne partie à un dossier.
    t.sides.set(p.id, ['vendeur']);
    await t.store.addIdentifier({ networkId: t.network.id, personId: p.id, kind: 'email', value: 'client.direction@example.test' });
    expect((await t.callAgent({ role: 'direction', userId: 'dir-1', networkId: t.network.id }, `/espaces/personnes/${p.id}/ouvrir`, CONSENT)).body).toMatchObject({ ok: true });
  });

  it('[R161] une donnée des sources est toujours échappée dans la page', async () => {
    const t = await setup();
    const c = await t.client('vendeur');
    t.refs.set(c.id, '<script>alert(1)</script>"x');
    const cookie = await t.enter(c.token);
    const home = await t.pub('GET', ESPACE_PATH, { cookie });
    expect(home.text).not.toContain('<script>');
    expect(home.text).toContain('&lt;script&gt;alert(1)&lt;/script&gt;&quot;x');
  });

  it('une écriture d’un autre site est refusée ; les gestes en JSON exigent leur en-tête et une séance [R165]', async () => {
    const t = await setup();
    const c = await t.client('acquereur');
    const cookie = await t.enter(c.token);
    expect((await t.pub('POST', `${ESPACE_PATH}sortie`, { cookie, headers: { origin: 'https://autre.example' } })).status).toBe(403);
    expect((await t.pub('POST', `${ESPACE_PATH}favori`, { cookie, form: { bien: `bien-${c.ref}` }, headers: { 'sec-fetch-site': 'cross-site' } })).status).toBe(403);
    const json = (h: Record<string, string>, ck?: string) => t.pub('POST', `${ESPACE_PATH}api/visite`, { ...(ck ? { cookie: ck } : {}), json: { propertyId: `bien-${c.ref}`, input: { slot: 'x' } }, headers: h });
    expect((await json({}, cookie)).status).toBe(403);
    expect((await json({ 'x-aimmo-espace': '1' })).status).toBe(401);
    const ok = await json({ 'x-aimmo-espace': '1' }, cookie);
    expect(ok.status).toBe(200);
    expect(t.gestes.calls).toEqual([`visite:${c.id}:bien-${c.ref}`]);
    // Un bien qui ne lui est pas proposé : refusé sans appeler le module.
    const other = await t.pub('POST', `${ESPACE_PATH}api/visite`, { cookie, json: { propertyId: 'bien-REF-V9' }, headers: { 'x-aimmo-espace': '1' } });
    expect(other.status).toBe(403);
    expect(t.gestes.calls).toHaveLength(1);
    // Une offre refusée par son module : sa règle est rendue telle quelle.
    const offer = await t.pub('POST', `${ESPACE_PATH}api/offre`, { cookie, json: { propertyId: `bien-${c.ref}`, input: {} }, headers: { 'x-aimmo-espace': '1' } });
    expect(JSON.parse(offer.text)).toEqual({ ok: false, rule: 'R55', code: 'sans_financement' });
  });

  it('[R49] le favori par la page, sans script ; la sortie ferme la séance', async () => {
    const t = await setup();
    const c = await t.client('acquereur');
    const cookie = await t.enter(c.token);
    expect((await t.pub('POST', `${ESPACE_PATH}favori`, { cookie, form: { bien: `bien-${c.ref}`, favori: 'oui' } })).status).toBe(303);
    expect((await t.pub('GET', ESPACE_PATH, { cookie })).text).toContain('Retirer des favoris');
    const out = await t.pub('POST', `${ESPACE_PATH}sortie`, { cookie });
    expect(out.status).toBe(303);
    expect(out.headers.get('set-cookie')).toContain('Max-Age=0');
    expect((await t.pub('GET', ESPACE_PATH, { cookie })).text).toContain('Recevoir mon lien');
  });

  it('[R164] le relevé se télécharge et se vérifie par la page publique ; modifié, il est dit modifié', async () => {
    const t = await setup();
    const c = await t.client('vendeur');
    const cookie = await t.enter(c.token);
    const releve = await t.pub('GET', `${ESPACE_PATH}releve`, { cookie });
    expect(releve.status).toBe(200);
    expect(releve.headers.get('content-type')).toContain('text/plain');
    expect(releve.text).toContain(c.ref);
    expect(releve.text).not.toMatch(/Visiteurnom|example\.test/);
    const ok = await t.pub('POST', `${ESPACE_PATH}verifier`, { form: { releve: releve.text } });
    expect(ok.text).toContain('Ce relevé est intact');
    const ko = await t.pub('POST', `${ESPACE_PATH}verifier`, { form: { releve: releve.text.replace('245000', '265000') } });
    expect(ko.text).toContain('a été modifié');
    expect((await t.pub('GET', `${ESPACE_PATH}releve`)).status).toBe(303);
    const without = await setup({ keys: false });
    const c2 = await without.client('vendeur');
    const ck = await without.enter(c2.token);
    expect((await without.pub('GET', `${ESPACE_PATH}releve`, { cookie: ck })).status).toBe(503);
  });

  it('[R201] chaque page passe le contrôle d’accessibilité et le budget de 14 Ko, sans ressource extérieure', async () => {
    const t = await setup();
    const seller = await t.client('vendeur');
    const buyer = await t.client('acquereur');
    const pages = [
      await t.pub('GET', ESPACE_PATH),
      await t.pub('GET', `${ESPACE_PATH}${seller.token}`),
      await t.pub('GET', ESPACE_PATH, { cookie: await t.enter(seller.token) }),
      await t.pub('GET', ESPACE_PATH, { cookie: await t.enter(buyer.token) }),
      await t.pub('GET', `${ESPACE_PATH}verifier`),
      await t.pub('POST', `${ESPACE_PATH}demande`, { form: { adresse: 'x@example.test' } }),
      await t.pub('GET', `${ESPACE_PATH}inconnu`),
    ];
    for (const p of pages) {
      expect(htmlProblems(p.text)).toEqual([]);
      expect(budgetProblems({ html: p.text }, BUDGETS.page)).toEqual([]);
      expect(p.headers.get('content-security-policy')).toContain("default-src 'none'");
      expect(p.text).not.toMatch(/<script/i);
    }
  });

  it('les dates sont dites à l’heure de Paris, en français', () => {
    expect(frenchDate('2027-06-05T14:00:00.000Z')).toBe('5 juin 2027 à 16 h 00');
    expect(frenchDate('2027-12-01')).toBe('1 décembre 2027');
  });

  it('une adresse hors de l’espace n’est pas à lui', async () => {
    const t = await setup();
    expect(await handleEspacePublic(new Request(`${ORIGIN}/autre/`), t.s)).toBeNull();
    expect(await handleEspacePublic(new Request(`${ORIGIN}/espaces/`), t.s)).toBeNull();
  });
});
