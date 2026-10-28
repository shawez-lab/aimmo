import { expect, it } from 'vitest';
import { REVIEW_PURPOSE, SqlBiensVendus, SqlDossiersClos, type Viewer } from '@aimmo/core';
import { apresVenteBase, apresVenteJobs, apresVenteRoutes, handleApresVentePublic, type ApresVenteServices } from '../src/apres-vente.ts';
import { handleRequest } from '../src/app.ts';
import { dossierRoutes, type DossierServices } from '../src/dossiers.ts';
import { offreRoutes } from '../src/offres.ts';
import { PROOF, setupDossier } from '../../core/test/dossiers-jeu.ts';
import { describeWithSqlite } from '../../core/test/sqlite.ts';

// Tout est inventé : clients, biens, adresses de test.
const ACT_PROOF = 'preuves/0b6f1d2e-7777-4a2b-8c3d-000000000001.pdf';
const BASE = 'https://aimmo.example.test/apres-vente/';
const LINK = 'https://g.page/r/CexempleAgent42/review';
const at = (iso: string) => new Date(iso);
const at9 = (day: string) => new Date(`${day}T08:00:00.000Z`);

async function setup() {
  const t = await setupDossier('appartement');
  const s: DossierServices & ApresVenteServices = { db: t.db, journal: t.journal, acces: t.acces, now: t.now, pieces: t.storage };
  const routes = [...dossierRoutes(), ...offreRoutes(), ...apresVenteRoutes()];
  const call = async (viewer: Viewer, method: 'GET' | 'POST', path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const route = routes.find((r) => r.method === method && r.pattern.test(path));
    if (!route) throw new Error(`route inconnue ${method} ${path}`);
    const params = (route.pattern.exec(path) ?? []).slice(1);
    const request = new Request(`https://api.exemple.test/v1${path}`, body === undefined ? { method, headers } : { method, headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
    const response = await (route.handle as (s: DossierServices, v: Viewer, p: string[], r: Request) => Promise<Response>)(s, viewer, params, request);
    return { status: response.status, body: (await response.json()) as { ok: boolean; mode?: string; data?: any; code?: string; rule?: string } };
  };
  // Les deux clients joignables par mail, d'accord pour la demande d'avis, comme à la signature du mandat et de l'offre.
  for (const [personId, n] of [[t.personId, 1], [t.buyerId, 2]] as const) {
    await t.store.addIdentifier({ networkId: t.network.id, personId, kind: 'email', value: `client${n}@example.test` });
    await t.store.addConsent({ networkId: t.network.id, personId, purpose: REVIEW_PURPOSE, channel: 'email', proof: 'mandat', givenAt: new Date('2027-02-10T09:00:00.000Z') });
  }
  /** Le dossier mené par les routes de M10 jusqu'à l'acte signé le 10 juin 2027. */
  const close = async () => {
    await t.verifyBuyer();
    expect((await call(t.agent, 'POST', `/offres/dossiers/${t.fileId}/compromis`)).status).toBe(200);
    t.setClock(at9('2027-03-11'));
    for (const [k, day] of [['compromis_signe', '2027-03-10'], ['notification_acquereur', '2027-03-11'], ['dia_recue', '2027-03-11'], ['date_limite_pret', '2027-05-10'], ['etat_date_attendu', '2027-05-20'], ['acte_prevu', '2027-06-10']]) {
      expect((await call(t.agent, 'POST', `/dossiers/${t.fileId}/dates`, { kind: k, day, proofRef: PROOF })).status).toBe(200);
    }
    for (const piece of (await call(t.agent, 'GET', `/dossiers/${t.fileId}/pieces`)).body.data.missing as string[]) {
      expect((await call(t.agent, 'POST', `/dossiers/${t.fileId}/pieces`, { piece, ref: t.upload(), issuedOn: '2027-03-11' })).status).toBe(200);
    }
    t.setClock(at9('2027-06-11'));
    expect((await call(t.agent, 'POST', `/dossiers/${t.fileId}/acte`, { signedOn: '2027-06-10', proofRef: ACT_PROOF })).status).toBe(200);
  };
  const jobs = (geocoder = true) =>
    apresVenteJobs(t.db, t.journal, {
      base: BASE,
      sales: { coverage: async () => null, within: async () => [] },
      geocoder: geocoder ? { geocode: async () => ({ label: 'Dijon', lat: 47.32, lon: 5.04, postalCode: '21000', inseeCode: '21231', town: 'Dijon', banId: null, score: 0.9 }) } : null,
      now: t.now,
    });
  const runAll = async () => {
    for (const j of jobs()) await j.run({ job: j.name, slot: t.now().toISOString().slice(0, 13), at: t.now() });
  };
  const outbox = async (personId: string) =>
    (await t.db.all<{ body: string }>('SELECT m.body FROM trial_outbox o JOIN messages m ON m.id = o.message_id WHERE m.person_id = ? ORDER BY m.occurred_at, m.id', [personId])).map((r) => r.body);
  const page = async (method: string, path: string, body?: string) => {
    const r = await handleApresVentePublic(
      new Request(`https://aimmo.example.test${path}`, body === undefined ? { method } : { method, headers: { 'content-type': 'application/x-www-form-urlencoded' }, body }),
      { db: t.db, now: t.now },
    );
    return { status: r!.status, html: await r!.text(), csp: r!.headers.get('content-security-policy') };
  };
  return { ...t, call, close, jobs, runAll, outbox, page };
}

it('le début des liens publics : https, sans chiffre, terminé par /apres-vente/', () => {
  expect(apresVenteBase(BASE)).toBe(BASE);
  expect(apresVenteBase(undefined)).toBeNull();
  expect(apresVenteBase('http://aimmo.example.test/apres-vente/')).toBeNull();
  expect(apresVenteBase('https://aimmo2.example.test/apres-vente/')).toBeNull();
  expect(apresVenteBase('https://aimmo.example.test/autre/')).toBeNull();
  // Le routeur ne sert les pages qu'à la racine : un chemin avant /apres-vente/ donnerait des liens morts [R65].
  expect(apresVenteBase('https://aimmo.example.test/x/apres-vente/')).toBeNull();
});

describeWithSqlite('F07 · routes et branchement de M11', () => {
  it('parcours de test, de l’acte à la relance d’un an : demandes d’avis, remerciement, note, carnet, désinscription', async () => {
    const t = await setup();
    expect((await t.call(t.agent, 'POST', '/apres-vente/lien-avis', { url: LINK })).body).toMatchObject({ ok: true, mode: 'essai' });
    await t.close();
    // Les dossiers clos de M10, lus pour M11 : le vendeur du mandat, puis l'acquéreur, sans adresse [R19].
    const sale = await new SqlDossiersClos(t.db).byId(t.network.id, t.fileId);
    expect(sale).toEqual({ fileId: t.fileId, agentId: t.alexId, closedOn: '2027-06-10', city: 'Dijon', reference: 'REF-T-1', clients: [{ personId: t.personId, side: 'vendeur' }, { personId: t.buyerId, side: 'acquereur' }] });
    expect(await new SqlDossiersClos(t.db).closedBetween(t.network.id, '2027-06-11', '2027-06-30')).toEqual([]);
    expect(await new SqlDossiersClos(t.db).byId('autre-reseau', t.fileId)).toBeNull();
    // L'acquéreur accepte, à l'acte, les nouvelles après la vente.
    expect((await t.call(t.agent, 'POST', `/apres-vente/dossiers/${t.fileId}/clients/${t.buyerId}/relances`, { choice: 'oui', proof: 'dit à l’acte, devant le notaire' })).status).toBe(200);

    // Le lendemain de l'acte, à 10 h : une demande d'avis à chacun, et une tâche « remercier » par client.
    t.setClock(at('2027-06-11T08:05:00.000Z'));
    await t.runAll();
    const day = await t.call(t.agent, 'GET', '/apres-vente/journee');
    expect(day.body.data.remercier.map((r: { side: string; reference: string }) => [r.side, r.reference])).toEqual([['vendeur', 'REF-T-1'], ['acquereur', 'REF-T-1']]);
    const files = await t.call(t.agent, 'GET', '/apres-vente/dossiers');
    expect(files.body.data).toHaveLength(1);
    expect(files.body.data[0]).toMatchObject({ fileId: t.fileId, reference: 'REF-T-1', city: 'Dijon', closedOn: '2027-06-10' });
    expect(files.body.data[0].clients.map((c: { side: string; review: { status: string } }) => [c.side, c.review.status])).toEqual([['vendeur', 'sent'], ['acquereur', 'sent']]);
    const [request] = await t.outbox(t.personId);
    expect(request).toContain(LINK);
    // Rejoué, le passage n'ajoute rien [R18].
    await t.runAll();
    expect(await t.outbox(t.personId)).toHaveLength(1);

    // Le remerciement : l'agent appelle, puis valide le message, qui passe par le contrôle central en mode essai.
    expect((await t.call(t.agent, 'POST', `/apres-vente/dossiers/${t.fileId}/clients/${t.personId}/appele`)).status).toBe(200);
    expect((await t.call(t.agent, 'POST', `/apres-vente/dossiers/${t.fileId}/clients/${t.personId}/remerciement`, { decision: 'send' })).body).toMatchObject({ ok: true, status: 'sent' });
    expect((await t.call(t.agent, 'POST', `/apres-vente/dossiers/${t.fileId}/clients/${t.buyerId}/remerciement`, { decision: 'decline' })).status).toBe(200);
    expect((await t.call(t.agent, 'GET', '/apres-vente/journee')).body.data.remercier.map((r: { side: string }) => r.side)).toEqual(['acquereur']);

    // La note, par le lien de la demande d'avis : une seule fois, jamais au journal en clair [R13].
    const token = /\/apres-vente\/avis\/([a-z]{32})/.exec(request!)![1]!;
    const form = await t.page('GET', `/apres-vente/avis/${token}`);
    expect(form.status).toBe(200);
    expect(form.html).toContain('name="note"');
    expect(form.csp).toContain("form-action 'self'");
    expect((await t.page('POST', `/apres-vente/avis/${token}`, 'note=5&commentaire=Tr%C3%A8s+bien+suivi%20%3Cb%3Emerci%3C%2Fb%3E')).status).toBe(200);
    expect((await t.page('POST', `/apres-vente/avis/${token}`, 'note=1')).status).toBe(409);
    const seen = (await t.call(t.agent, 'GET', '/apres-vente/dossiers')).body.data[0].clients[0];
    expect(seen.satisfaction).toMatchObject({ score: 5, comment: 'Très bien suivi <b>merci</b>' });
    expect(JSON.stringify(await t.journal.all())).not.toContain('Très bien suivi');

    // Un an après l'acte : la relance de l'acquéreur, avec sa désinscription et le carnet de son bien ; rien au vendeur,
    // qui n'a rien accepté [R65].
    const sellerBefore = (await t.outbox(t.personId)).length;
    t.setClock(at('2028-06-10T08:05:00.000Z'));
    await t.runAll();
    const reminders = (await t.call(t.agent, 'GET', '/apres-vente/relances')).body.data;
    const byPerson = new Map(reminders.map((r: { personId: string; year: number; status: string }) => [r.personId, [r.year, r.status]]));
    expect(byPerson.get(t.buyerId)).toEqual([1, 'sent']);
    expect(byPerson.get(t.personId)).toEqual([1, 'refused']);
    expect(await t.outbox(t.personId)).toHaveLength(sellerBefore);
    const mail = (await t.outbox(t.buyerId)).at(-1)!;
    const carnet = /\/apres-vente\/carnet\/([a-z]{32})/.exec(mail)![1]!;
    const book = await t.page('GET', `/apres-vente/carnet/${carnet}`);
    expect(book.status).toBe(200);
    expect(book.html).toContain('REF-T-1');
    expect(book.html).toContain('classe D');
    expect(book.html).not.toMatch(/Exemple|Acheteur|Léa/);
    const unsubscribe = /\/apres-vente\/desinscription\/([a-z]{32})/.exec(mail)![1]!;
    expect((await t.page('GET', `/apres-vente/desinscription/${unsubscribe}`)).html).toContain('Me désinscrire');
    expect((await t.page('POST', `/apres-vente/desinscription/${unsubscribe}`)).status).toBe(200);
    // Deux ans après : plus rien, la personne s'est désinscrite [R65].
    t.setClock(at('2029-06-11T08:05:00.000Z'));
    await t.runAll();
    const later = (await t.call(t.agent, 'GET', '/apres-vente/relances')).body.data as { year: number; status: string }[];
    expect(later.filter((r) => r.year === 2).every((r) => r.status !== 'sent')).toBe(true);
    expect((await t.outbox(t.buyerId)).filter((m) => m.includes('/apres-vente/desinscription/'))).toHaveLength(1);
  });

  it('le bien vendu pour le carnet : type lu dans la fiche, centre de la commune, jamais d’adresse', async () => {
    const t = await setup();
    await t.close();
    const facts = await new SqlBiensVendus(t.db, { geocoder: { geocode: async (q) => (q === '21000 Dijon' ? { label: 'Dijon', lat: 47.32, lon: 5.04, postalCode: '21000', inseeCode: '21231', town: 'Dijon', banId: null, score: 0.9 } : null) } }).factsOf(t.network.id, t.fileId);
    expect(facts).toEqual({ kind: 'apartment', surface: 62, lat: 47.32, lon: 5.04, postalCode: '21000', energy: { energyClass: 'D', diagnosedOn: '2027-01-15' } });
    // Sans géocodeur, ou s'il tombe en panne, la position reste inconnue.
    expect(await new SqlBiensVendus(t.db).factsOf(t.network.id, t.fileId)).toMatchObject({ lat: null, lon: null });
    expect(await new SqlBiensVendus(t.db, { geocoder: { geocode: async () => { throw new Error('panne'); } } }).factsOf(t.network.id, t.fileId)).toMatchObject({ lat: null });
    // Un dossier non clos n'a pas de faits.
    expect(await new SqlBiensVendus(t.db).factsOf(t.network.id, 'inconnu')).toBeNull();
  });

  it('[R16] chaque route sous les droits : un autre agent ne voit rien, et chaque refus va au journal', async () => {
    const t = await setup();
    await t.close();
    t.setClock(at('2027-06-11T08:05:00.000Z'));
    await t.runAll();
    const refusals = async () => (await t.journal.all()).filter((e) => e.type === 'acces.refuse' && e.actor === t.sam.role + ':' + t.sam.userId).length;
    for (const [method, path, body] of [
      ['POST', `/apres-vente/dossiers/${t.fileId}/clients/${t.buyerId}/relances`, { choice: 'oui', proof: 'test' }],
      ['POST', `/apres-vente/dossiers/${t.fileId}/clients/${t.personId}/remerciement`, { decision: 'send' }],
      ['POST', `/apres-vente/dossiers/${t.fileId}/clients/${t.personId}/appele`, undefined],
      ['GET', `/apres-vente/fiches/${t.personId}/recommandations`, undefined],
    ] as const) {
      const before = await refusals();
      const r = await t.call(t.sam, method, path, body);
      expect([path, r.status, r.body.rule]).toEqual([path, r.status === 404 ? 404 : 403, 'R16']);
      expect([path, (await refusals()) - before]).toEqual([path, 1]);
    }
    // Les listes de l'autre agent sont vides : rien des dossiers d'Alex.
    const files = await t.call(t.sam, 'GET', '/apres-vente/dossiers');
    expect(files.body.data).toEqual([]);
    const day = await t.call(t.sam, 'GET', '/apres-vente/journee');
    expect(day.body.data).toEqual({ remercier: [], recommandations: [], taches: [] });
    // La direction et la conformité voient les dossiers clos du réseau, sans les remerciements préparés de l'agent.
    for (const v of [t.direction, { ...t.direction, role: 'compliance' as const, userId: 'conformite-1' }]) {
      const seen = await t.call(v, 'GET', '/apres-vente/dossiers');
      expect([v.role, seen.status]).toEqual([v.role, 200]);
      expect(seen.body.data[0].clients.map((c: { side: string; thankYou: unknown; review: { status: string } | null }) => [c.side, c.thankYou, !!c.review])).toEqual([['vendeur', null, true], ['acquereur', null, true]]);
    }
    // La journée est celle d'un agent : la direction est refusée, au journal.
    expect((await t.call(t.direction, 'GET', '/apres-vente/journee')).status).toBe(403);
    // Corps faux : refusé avant tout.
    expect((await t.call(t.agent, 'POST', `/apres-vente/dossiers/${t.fileId}/clients/${t.personId}/remerciement`, { decision: 'peut-etre' })).status).toBe(400);
    expect((await t.call(t.agent, 'POST', '/apres-vente/lien-avis', { url: 42 })).status).toBe(400);
  });

  it('la recommandation porte une clé d’idempotence : la même saisie envoyée deux fois, même en même temps, ne range qu’une recommandation', async () => {
    const t = await setup();
    const input = { firstName: 'Nina', email: 'nina@example.test', projectKind: 'buy', callable: true, proof: 'dit par Léa au téléphone' };
    const key = { 'idempotency-key': 'cle-test-0123456789abcdef' };
    const path = `/apres-vente/fiches/${t.personId}/recommandations`;
    expect((await t.call(t.agent, 'POST', path, input)).body).toMatchObject({ ok: false, code: 'idempotency_key' });
    const [a, b] = await Promise.all([t.call(t.agent, 'POST', path, input, key), t.call(t.agent, 'POST', path, input, key)]);
    const statuses = [a.status, b.status].sort();
    expect(statuses[0]).toBe(200);
    expect([200, 409]).toContain(statuses[1]);
    const again = await t.call(t.agent, 'POST', path, input, key);
    expect(again).toEqual(a.status === 200 ? a : b);
    expect(await t.db.all('SELECT id FROM referrals')).toHaveLength(1);
    // La même clé par un autre lecteur : refusée, sans rien ranger.
    expect((await t.call(t.direction, 'POST', path, input, key)).body).toMatchObject({ ok: false, code: 'idempotency_key_reused' });
    // Une panne pendant la saisie : la clé reçoit sa réponse finale, jamais « en cours » pour toujours.
    const broken = { 'idempotency-key': 'cle-test-panne-0123456789' };
    const db = t.db as { run: typeof t.db.run };
    const run = db.run.bind(t.db);
    let fail = true;
    db.run = (async (sql: string, params?: unknown[]) => {
      if (fail && /INSERT INTO referrals\b/.test(sql)) {
        fail = false;
        throw new Error('panne');
      }
      return run(sql, params as never);
    }) as typeof t.db.run;
    await expect(t.call(t.agent, 'POST', path, { ...input, firstName: 'Zoé', email: 'zoe@example.test' }, broken)).rejects.toThrow('panne');
    db.run = run;
    expect((await t.call(t.agent, 'POST', path, { ...input, firstName: 'Zoé', email: 'zoe@example.test' }, broken)).body).toMatchObject({ ok: false, code: 'retry_with_new_key' });
    // L'appel « recommandé » est dans la journée de l'agent, et se marque fait.
    const calls = (await t.call(t.agent, 'GET', '/apres-vente/journee')).body.data.recommandations;
    expect(calls).toHaveLength(1);
    expect(JSON.stringify(await t.db.all('SELECT * FROM referral_requests'))).not.toContain(key['idempotency-key']);
    expect((await t.call(t.agent, 'POST', `/apres-vente/appels/${calls[0].referralId}/fait`)).status).toBe(200);
    expect((await t.call(t.agent, 'GET', '/apres-vente/journee')).body.data.recommandations).toEqual([]);
  });

  it('les pages publiques : lien inconnu ou mal formé refusé ; fermées hors mode essai ; branchées dans l’API', async () => {
    const t = await setup();
    for (const path of ['/apres-vente/avis/abc', `/apres-vente/avis/${'a'.repeat(32)}`, `/apres-vente/carnet/${'b'.repeat(32)}`, `/apres-vente/autre/${'c'.repeat(32)}`, `/apres-vente/avis/${'a'.repeat(32)}/plus`]) {
      expect([path, (await t.page('GET', path)).status]).toEqual([path, 404]);
    }
    expect((await t.page('POST', `/apres-vente/desinscription/${'d'.repeat(32)}`)).status).toBe(404);
    const config = { db: t.db, apiKeys: undefined, now: t.now };
    expect((await handleRequest(new Request(`https://aimmo.example.test/apres-vente/avis/${'a'.repeat(32)}`), { ...config, mode: 'essai' })).status).toBe(404);
    expect((await handleRequest(new Request(`https://aimmo.example.test/apres-vente/avis/${'a'.repeat(32)}`), { ...config, mode: 'reel' })).status).toBe(503);
  });
});
