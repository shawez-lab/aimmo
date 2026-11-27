import { expect, it } from 'vitest';
import { Acces, FicheClient, FicheUnique, SqlJournalStore, applyMigrations, fromSyncSqlite, type SqlDatabase, type Viewer } from '@aimmo/core';
import { BUDGETS, budgetProblems, filledButtons, htmlProblems } from '../../core/src/design/audit.ts';
import type { ClientSide, GestesAcquereur, SourcesAcquereur, SourcesProprietaire, SourcesVendeur } from '../../core/src/espaces/index.ts';
import type { SellerKeyEntry } from '../../core/src/cles/cles.ts';
import { ESPACE_PATH, MAX_KEY_ENTRIES, SESSION_COOKIE, espacesRoutes, frenchDate, handleEspacePublic, type EspacesServices } from '../src/espaces.ts';
import { loadMigrations } from '../../core/test/migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from '../../core/test/sqlite.ts';
import { enClair } from '../../core/test/boite-essai.ts';

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
    sellerPropertiesOf: async (_n, personId) => (sides.get(personId)?.includes('vendeur') ? [{ propertyId: `bien-${refs.get(personId)}`, reference: refs.get(personId)!, city: 'Dijon', status: 'en vente', statusAt: '2027-05-02T09:00:00.000Z', askingPriceEur: 245_000, mandateSignedAt: '2027-05-01T10:00:00.000Z' }] : []),
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
    const rows = await enClair(db.all<{ id: string; body: string }>(`SELECT m.id, m.body FROM messages m JOIN trial_outbox t ON t.message_id = m.id WHERE m.person_id = ? ORDER BY m.occurred_at DESC, m.rowid DESC`, [personId]));
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

  it('[R160] [EC13] au-delà de 3 liens en 24 heures, la route refuse sans lien ni jeton, et rien n’est rangé', async () => {
    const t = await setup();
    const p = await t.store.createPerson({ networkId: t.network.id, agentId: t.agent.userId, firstName: 'Client', lastName: 'Inventé' });
    await t.store.addIdentifier({ networkId: t.network.id, personId: p.id, kind: 'email', value: 'client.plafond@example.test' });
    t.sides.set(p.id, ['vendeur']);
    for (let i = 0; i < 3; i++) expect((await t.callAgent(t.agent, `/espaces/personnes/${p.id}/ouvrir`, CONSENT)).status).toBe(200);
    const refused = await t.callAgent(t.agent, `/espaces/personnes/${p.id}/ouvrir`, CONSENT);
    expect(refused.status).toBe(409);
    expect(refused.body).toEqual({ ok: false, rule: 'R160', code: 'plafond' });
    expect(await t.db.all('SELECT id FROM client_space_links WHERE person_id = ?', [p.id])).toHaveLength(3);
  });

  it('[R160] [R16] [R13] BR98 : au plafond, la route dit les comptes et l’heure du prochain lien, à l’agent de la personne et à la direction seuls', async () => {
    const t = await setup();
    const routes = espacesRoutes();
    const read = async (viewer: Viewer, personId: string) => {
      const path = `/espaces/personnes/${personId}/liens`;
      const route = routes.find((r) => r.method === 'GET' && r.pattern.test(path))!;
      const response = await route.handle(t.s, viewer, (route.pattern.exec(path) ?? []).slice(1), new Request(`https://api.example/v1${path}`));
      return { status: response.status, body: (await response.json()) as { ok: boolean; rule?: string; code?: string; data?: Record<string, unknown> } };
    };
    const p = await t.store.createPerson({ networkId: t.network.id, agentId: t.agent.userId, firstName: 'Client', lastName: 'Inventé' });
    await t.store.addIdentifier({ networkId: t.network.id, personId: p.id, kind: 'email', value: 'client.liens@example.test' });
    t.sides.set(p.id, ['vendeur']);
    expect(await read(t.agent, p.id)).toMatchObject({ status: 200, body: { ok: true, data: { counted: 0, nextAt: null } } });
    for (let i = 0; i < 3; i++) expect((await t.callAgent(t.agent, `/espaces/personnes/${p.id}/ouvrir`, CONSENT)).status).toBe(200);
    const full = await read(t.agent, p.id);
    expect(full.status).toBe(200);
    expect(full.body.data).toMatchObject({ limit: 3, counted: 3, prepared: 3, requested: 0, opened: 0, requestsUnopened: false });
    expect(typeof full.body.data!.nextAt).toBe('string');
    expect(JSON.stringify(full.body)).not.toMatch(/@|example\.test|espace\/[a-z]{40}|[a-z]{40}/);
    // La direction lit aussi ; un autre rôle est refusé et c'est écrit ; un autre agent est refusé.
    expect((await read({ role: 'direction', userId: 'dir-1', networkId: t.network.id }, p.id)).status).toBe(200);
    expect(await read({ role: 'compliance', userId: 'conf-1', networkId: t.network.id }, p.id)).toEqual({ status: 403, body: { ok: false, rule: 'R16', code: 'role' } });
    const refused = (await t.journal.all()).filter((e) => e.type === 'acces.refuse');
    expect(refused.map((e) => (e.data as { kind: string }).kind)).toContain('espaces.liens');
    const bea = await t.store.createAgent({ networkId: t.network.id, firstName: 'Bea', lastName: 'Essai' });
    const other = await read({ role: 'agent', userId: bea.id, networkId: t.network.id }, p.id);
    expect(other.body).toMatchObject({ ok: false, rule: 'R16' });
    expect([403, 404]).toContain(other.status);
  });

  it('[R163] la page du vendeur écrit les états en français, jamais un code de la base (DS078)', async () => {
    const t = await setup();
    const c = await t.client('vendeur');
    const cookie = await t.enter(c.token);
    const home = await t.pub('GET', ESPACE_PATH, { cookie });
    expect(home.status).toBe(200);
    // Le constat de l'audit, « Statut : available » et « Mandat de vente · signe », ne se reproduit plus.
    expect(home.text).toContain('<dt>Statut</dt><dd>en vente</dd>');
    expect(home.text).toContain('<li>Mandat de vente · signé</li>');
    expect(home.text).toContain('<li>5 juin 2027 à 16 h 00 · faite<br>');
    const words = home.text.replace(/<[^>]+>/g, ' ');
    for (const code of ['available', 'under_offer', 'prevue', 'annulee', 'a_signer', 'signe', 'deposee', 'validee']) expect(words, code).not.toMatch(new RegExp(`(^|[^\\p{L}_])${code}([^\\p{L}_]|$)`, 'u'));
  });

  it('[R163] DS079 · une valeur se lit seule ; sa source et sa date sont dessous, à qui les demande, et aucune ne manque', async () => {
    const t = await setup();
    const c = await t.client('vendeur');
    const cookie = await t.enter(c.token);
    const home = await t.pub('GET', ESPACE_PATH, { cookie });
    // Le constat de l'audit, « 245 000 € mandat en vigueur, 1 mai 2027 à 12 h 00 », ne se reproduit plus.
    expect(home.text).not.toContain('<small');
    expect(home.text).toContain('<dt>Prix du mandat</dt><dd>245\u202f000 €</dd>');
    // Hors des preuves, la page ne dit plus une seule source : elle dit les valeurs.
    const visible = home.text.replace(/<details class="preuve">[\s\S]*?<\/details>/g, '');
    for (const source of ['fiche du bien', 'mandat en vigueur', 'agenda du bien', 'compte rendu validé', 'dossier de vente']) expect(visible, source).not.toContain(source);
    // Chaque bloc a sa preuve, regroupée par source, avec la date de chacune.
    const proofs = [...home.text.matchAll(/<details class="preuve"><summary>D’où viennent ces informations \?<\/summary>([\s\S]*?)<\/details>/g)].map((m) => m[1]);
    expect(proofs).toEqual([
      // Les faits du bien : une preuve par champ.
      '<ul><li>Statut : fiche du bien, 2 mai 2027 à 11 h 00</li><li>Prix du mandat : mandat en vigueur, 1 mai 2027 à 12 h 00</li></ul>',
      // Une liste : une preuve par ligne, sous le numéro de la ligne, chaque champ nommé.
      '<ol><li>Date, état : agenda du bien, 5 juin 2027 à 16 h 00 ; compte rendu : compte rendu validé par l’agent, 5 juin 2027 à 20 h 00</li></ol>',
      '<ol><li>Signature : dossier de vente, 1 mai 2027 à 12 h 30</li></ol>',
    ]);
    // Les lignes d'une liste sont numérotées comme leurs preuves.
    expect(home.text).toContain('<h3>Visites</h3><ol><li>5 juin 2027 à 16 h 00 · faite<br>');
    // Une donnée absente reste dite, sans preuve à montrer.
    expect(home.text).toContain('<dt>Acte au plus tôt</dt><dd><span class="doux">non communiquée</span></dd>');
    // Le relevé prouvé reste entier : il part des mêmes données, sources et dates comprises [R164].
    expect(home.text).toContain('Télécharger le relevé prouvé de mon espace');
  });

  it('[R163] DS079 · chaque valeur garde sa propre preuve : deux offres du même montant, un état changé après la réception', async () => {
    const t = await setup();
    const c = await t.client('vendeur');
    t.s.vendeur.offersOf = async () => [
      { id: 'o1', receivedAt: '2027-06-06T08:00:00.000Z', amountEur: 200_000, netSellerEur: 190_000, conditions: ['prêt'], validUntil: '2027-06-20', state: 'refusée', stateAt: '2027-06-08T09:30:00.000Z', buyer: null },
      { id: 'o2', receivedAt: '2027-06-07T08:00:00.000Z', amountEur: 200_000, netSellerEur: 190_000, conditions: [], validUntil: '2027-06-21', state: 'reçue', stateAt: '2027-06-07T08:00:00.000Z', buyer: null },
    ];
    const home = await t.pub('GET', ESPACE_PATH, { cookie: await t.enter(c.token) });
    const offers = /<h3>Offres<\/h3><ol>([\s\S]*?)<\/ol><details class="preuve"><summary>[^<]*<\/summary><ol>([\s\S]*?)<\/ol><\/details>/.exec(home.text)!;
    const lines = offers[1]!.split('</li>').filter(Boolean);
    const proofs = offers[2]!.split('</li>').filter(Boolean).map((p) => p.replace('<li>', ''));
    // Deux lignes, deux preuves, dans le même ordre : la preuve n° 1 est celle de la ligne n° 1.
    expect(lines).toHaveLength(2);
    expect(proofs).toHaveLength(2);
    expect(lines[0]).toContain('refusée');
    expect(lines[1]).toContain('reçue');
    // L'état de la première offre a changé deux jours après sa réception : sa preuve le dit à part, sous son nom.
    expect(proofs[0]).toMatch(/état : registre des offres, 8 juin 2027 à 11 h 30/);
    expect(proofs[0]).toMatch(/[Mm]ontant[^:;]* : registre des offres, 6 juin 2027 à 10 h 00/);
    expect(proofs[0]).not.toMatch(/état[^;]*6 juin 2027/);
    // Le net vendeur ne vient pas du registre des offres : il a sa source à lui.
    const net = /net vendeur[^:;]* : ([^;<]+)/.exec(proofs[0]!)![1]!;
    expect(net).not.toContain('8 juin 2027');
    // La seconde offre, de même montant, a ses preuves à elle : datées de sa réception.
    expect(proofs[1]).toMatch(/registre des offres, 7 juin 2027 à 10 h 00/);
    expect(proofs[1]).not.toContain('6 juin 2027');
    // Chaque champ montré est nommé dans la preuve de sa ligne.
    for (const p of proofs) for (const field of ['ontant', 'net vendeur', 'état', 'réception', 'validité']) expect(p, field).toContain(field);
  });

  it('DS080, DS081, DS082 · le client lit son bien, les listes vides tiennent en une phrase, et aucun bouton plein ne va à la déconnexion', async () => {
    const t = await setup();
    const c = await t.client('vendeur');
    const cookie = await t.enter(c.token);
    const home = await t.pub('GET', ESPACE_PATH, { cookie });
    expect(home.text).toContain('<section><h2>Votre bien à Dijon</h2><p class="doux">Réf. REF-V1</p>');
    expect(home.text).not.toContain('REF-V1 · Dijon');
    // Trois listes vides : une phrase, plus trois titres.
    expect(home.text).toContain('<p class="doux">Aucune offre pour l’instant. Aucun rendez-vous. Aucun point pour l’instant.</p>');
    for (const title of ['Offres', 'Rendez-vous', 'Points de la semaine']) expect(home.text, title).not.toContain(`<h3>${title}</h3>`);
    expect(home.text).toContain('<h3>Visites</h3>');
    // « Me déconnecter » est un bouton de texte, en bas ; la page du vendeur n'a aucun bouton plein.
    expect(home.text).toContain('<button type="submit" class="discret">Me déconnecter</button></form>');
    expect(filledButtons(home.text)).toEqual([]);
    // L'acquéreur : « Mettre en favori » est au trait, et le bien se lit avant sa référence.
    const buyer = await t.client('acquereur');
    const view = await t.pub('GET', ESPACE_PATH, { cookie: await t.enter(buyer.token) });
    expect(filledButtons(view.text)).toEqual([]);
    expect(view.text).not.toContain('<small');
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
    expect((await t.pub('POST', `${ESPACE_PATH}favori`, { cookie, form: { bien: `bien-${c.ref}` }, headers: { origin: 'null' } })).status).toBe(403);
    // Sans Origin, aucune écriture.
    const bare = await handleEspacePublic(new Request(`${ORIGIN}${ESPACE_PATH}sortie`, { method: 'POST', headers: { cookie: `${SESSION_COOKIE}=${cookie}` } }), t.s);
    expect(bare!.status).toBe(403);
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

  it('[R272] [R665] [R16] [R201] BR53 · les clés du bien : lues au lien, partenaire par son métier, refus en mots, texte échappé, budget tenu', async () => {
    const t = await setup();
    const seller = await t.client('vendeur');
    const cookie = await t.enter(seller.token);
    const bien = `bien-${seller.ref}`;
    // Sans suivi des clés branché : aucun lien, et la page le dit en mots.
    expect((await t.pub('GET', ESPACE_PATH, { cookie })).text).not.toContain('cles?bien=');
    const off = await t.pub('GET', `${ESPACE_PATH}cles?bien=${bien}`, { cookie });
    expect(off.status).toBe(503);
    expect(off.text).toContain('Le suivi des clés n’est pas encore disponible');
    const entries: SellerKeyEntry[] = [
      { number: 2, label: 'Garage <b>', agent: 'Alex E.', purpose: 'Diagnostic', takenAt: '2027-06-07T08:00:00.000Z', appointment: null, returnedAt: null, lost: false, partner: { trade: 'Diagnostiqueur', businessName: 'Diag & Co <script>' } },
      { number: 1, label: 'Porte d’entrée', agent: 'Alex E.', purpose: 'Visite', takenAt: '2027-06-05T13:30:00.000Z', appointment: { start: '2027-06-05T14:00:00.000Z', end: '2027-06-05T15:00:00.000Z', state: 'fait' }, returnedAt: '2027-06-05T15:20:00.000Z', lost: false },
      { number: 3, label: 'Cave', agent: 'Alex E.', purpose: 'Photos du bien', takenAt: '2027-06-01T08:00:00.000Z', appointment: null, returnedAt: null, lost: true },
    ];
    const asked: string[] = [];
    t.s.cles = {
      forSeller: async (viewer, propertyId) => {
        asked.push(`${viewer.personId}:${propertyId}`);
        return propertyId === bien && viewer.personId === seller.id ? { ok: true, value: entries } : { ok: false, rule: 'R161', code: 'unknown' };
      },
    };
    // Rien n'est lu avant le geste : l'accueil donne seulement le lien [R201].
    const home = await t.pub('GET', ESPACE_PATH, { cookie });
    expect(home.text).toContain(`href="${ESPACE_PATH}cles?bien=${bien}"`);
    expect(asked).toEqual([]);
    const page = await t.pub('GET', `${ESPACE_PATH}cles?bien=${bien}`, { cookie });
    expect(page.status).toBe(200);
    expect(asked).toEqual([`${seller.id}:${bien}`]);
    // Le partenaire : son métier et sa raison sociale, sous la responsabilité de l'agent ; jamais une balise reçue [R665].
    expect(page.text).toContain('Remis à Diag &amp; Co &lt;script&gt; (diagnostiqueur), sous la responsabilité de Alex E.');
    expect(page.text).toContain('Garage &lt;b&gt;');
    expect(page.text).toContain('Rendez-vous du 5 juin 2027 à 16 h 00 au 5 juin 2027 à 17 h 00 · fait');
    expect(page.text).toContain('Rendu le 5 juin 2027 à 17 h 20');
    expect(page.text).toContain('Déclaré perdu');
    expect(page.text).toContain('Pas encore rendu');
    // Dans l'ordre reçu, le plus récent d'abord.
    expect(page.text.indexOf('n° 2')).toBeLessThan(page.text.indexOf('n° 1'));
    expect(page.text.indexOf('n° 1')).toBeLessThan(page.text.indexOf('n° 3'));
    expect(page.text).not.toMatch(/<script|<b>/i);
    // Un autre bien, un identifiant mal formé : refusés en mots, la même page [R161, R16].
    for (const other of ['bien-autre', 'x%27%3E', '']) {
      const r = await t.pub('GET', `${ESPACE_PATH}cles?bien=${other}`, { cookie });
      expect(r.status).toBe(403);
      expect(r.text).toContain('Vous voyez seulement les clés d’un bien dont vous êtes aujourd’hui le vendeur');
    }
    // Aucune sortie : dit en mots.
    entries.length = 0;
    expect((await t.pub('GET', `${ESPACE_PATH}cles?bien=${bien}`, { cookie })).text).toContain('Aucune clé de ce bien n’est sortie');
    // Beaucoup de sorties : les plus récentes seulement, le reste compté ; la page tient son budget [R201].
    for (let i = 0; i < MAX_KEY_ENTRIES + 7; i += 1)
      entries.push({ number: i + 1, label: `Trousseau d’essai ${i}`, agent: 'Alex E.', purpose: 'Visite', takenAt: new Date(Date.parse('2027-06-07T08:00:00.000Z') - i * 3_600_000).toISOString(), appointment: { start: '2027-06-05T14:00:00.000Z', end: '2027-06-05T15:00:00.000Z', state: 'prevu' }, returnedAt: '2027-06-05T15:20:00.000Z', lost: false, partner: { trade: 'Diagnostiqueur', businessName: 'Diagnostics de Bourgogne' } });
    const big = await t.pub('GET', `${ESPACE_PATH}cles?bien=${bien}`, { cookie });
    expect(big.text).toContain(`Trousseau d’essai ${MAX_KEY_ENTRIES - 1}<`);
    expect(big.text).not.toContain(`Trousseau d’essai ${MAX_KEY_ENTRIES}<`);
    expect(big.text).toContain('Et 7 sorties plus anciennes');
    for (const p of [big, page, off]) {
      expect(htmlProblems(p.text)).toEqual([]);
      expect(budgetProblems({ html: p.text }, BUDGETS.page)).toEqual([]);
      expect(p.headers.get('content-security-policy')).toContain("default-src 'none'");
    }
    // Sans séance : renvoyé à la demande de lien.
    const none = await t.pub('GET', `${ESPACE_PATH}cles?bien=${bien}`);
    expect(none.status).toBe(303);
    // Un identifiant mal formé passe par la lecture sous « ? », pour que son refus soit écrit au journal [R16].
    expect(asked.length).toBe(6);
    expect(asked.filter((a) => a.endsWith(':?'))).toHaveLength(2);
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
