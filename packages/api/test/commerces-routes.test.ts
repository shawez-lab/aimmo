import { expect, it } from 'vitest';
import { FicheClient, FicheUnique, SqlJournalStore, applyMigrations, fromSyncSqlite, type SqlDatabase, type Viewer } from '@aimmo/core';
import { commercesRoutes, dossierReaderRoutes, type CommercesServices } from '../src/commerces.ts';
import { loadMigrations } from '../../core/test/migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from '../../core/test/sqlite.ts';

// Réseau, agents, commerces, repreneurs, enseignes et chiffres inventés. Le 7 septembre 2027 est un mardi.
let n = 0;
const uuid = (): string => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
const proof = (): string => `preuves/${uuid()}.pdf`;
const NDA =
  'Engagement de confidentialité (modèle inventé pour les tests). Le signataire garde secrets les chiffres et documents du commerce qui lui sont communiqués, et ne les utilise que pour étudier sa reprise.';
const SHEET = {
  activity: 'restaurant',
  signName: 'La Table Inventée',
  fiscalYears: [
    { year: 2026, revenueCents: 61_234_500, resultCents: 2_345_600, ebitdaCents: 5_432_100 },
    { year: 2025, revenueCents: 58_765_400, resultCents: 1_987_600, ebitdaCents: 4_987_600 },
  ],
  leaseStart: '2020-01-01',
  leaseYears: 9,
  leaseAnnualRentCents: 2_400_000,
  employees: 6,
  equipment: ['piano de cuisson', 'chambre froide'],
  licenses: ['licence_4'],
};
/** Ce qui ne doit jamais sortir d'une route publique : enseigne, chiffres d'exercice, loyer, matériel [R110]. */
const SECRETS = ['Table Inventée', '61234500', '612 345', '612345', '2400000', '24 000', 'piano', 'chambre froide', 'licence_4', 'signName', 'fiscalYears', 'leaseAnnualRentCents'];
const CONSENT = { consentProof: 'accord donné au rendez-vous du 7 septembre' };

async function setup(writer?: CommercesServices['presentationWriter']) {
  n = 0;
  let clock = Date.parse('2027-09-07T08:00:00.000Z'); // 10 h à Paris
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  const now = (): Date => new Date((clock += 1000));
  const journal = new SqlJournalStore(db);
  const store = new FicheClient(db, { now });
  const verified = new Set<string>();
  const deposited = new Set<string>();
  let code = 100_000;
  let lastCode = '';
  const closed = new Set<string>();
  const files = new Map<string, string>([['r2://essai/bilan.txt', 'Bilan inventé. Total du bilan : 812 300 €.']]);
  const s: CommercesServices = {
    db,
    journal,
    now,
    identity: { state: async (_n, p) => ({ identityVerifiedOn: verified.has(p) ? '2027-09-01' : null }) },
    storage: { read: async (ref) => files.get(ref) ?? null },
    vault: { everDeposited: async (_n, p, kinds) => kinds.some((k) => deposited.has(`${p}:${k}`)) },
    diffusion: { canDiffuse: async (_n, p) => ({ allowed: !closed.has(p), reason: 'essai' }) },
    ...(writer ? { presentationWriter: writer } : {}),
    newId: uuid,
    newCode: () => (lastCode = String((code += 1))),
  };
  const network = await store.createNetwork('Réseau Essai');
  const alexA = await store.createAgent({ networkId: network.id, firstName: 'Alex', lastName: 'Essai' });
  const beaA = await store.createAgent({ networkId: network.id, firstName: 'Béa', lastName: 'Essai' });
  const alex: Viewer = { role: 'agent', userId: alexA.id, networkId: network.id };
  const bea: Viewer = { role: 'agent', userId: beaA.id, networkId: network.id };
  const dir: Viewer = { role: 'direction', userId: 'dir-1', networkId: network.id };
  const compliance: Viewer = { role: 'compliance', userId: 'conf-1', networkId: network.id };
  const partner: Viewer = { role: 'partner', userId: 'part-1', networkId: network.id };
  const routes = commercesRoutes();
  const reader = dossierReaderRoutes();
  const call = async (viewer: Viewer, method: 'GET' | 'POST', path: string, body?: unknown) => {
    const route = routes.find((r) => r.method === method && r.pattern.test(path));
    if (!route) throw new Error(`route inconnue ${method} ${path}`);
    const params = (route.pattern.exec(path) ?? []).slice(1);
    const init: RequestInit = { method };
    if (body !== undefined) {
      init.headers = { 'content-type': 'application/json' };
      init.body = JSON.stringify(body);
    }
    const response = await route.handle(s, viewer, params, new Request(`https://api.exemple.test/v1${path}`, init));
    return { status: response.status, body: (await response.json()) as { ok: boolean; data?: any; code?: string; rule?: string | null; codes?: string[]; missing?: string[] } };
  };
  const ok = async (viewer: Viewer, method: 'GET' | 'POST', path: string, body?: unknown) => {
    const r = await call(viewer, method, path, body);
    expect(r.status, `${method} ${path} ${JSON.stringify(r.body)}`).toBe(200);
    return r.body.data;
  };
  const read = async (path: string, body: unknown) => {
    const route = reader.find((r) => r.pattern.test(path))!;
    const params = (route.pattern.exec(path) ?? []).slice(1);
    const response = await route.handle(s, params, new Request(`https://api.exemple.test/v1${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));
    return { status: response.status, body: (await response.json()) as { ok: boolean; data?: any; code?: string } };
  };
  /** Un restaurant d'Alex, estimé, présenté, validé. */
  const shop = async () => {
    const p = await store.createProperty({ networkId: network.id, agentId: alexA.id, reference: `CE-${uuid().slice(-4)}`, kind: 'business', status: 'available', city: 'Dijon', postalCode: '21000', surfaceM2: 120 });
    await ok(alex, 'POST', `/commerces/${p.id}/fiche`, SHEET);
    const e = await ok(alex, 'POST', `/commerces/${p.id}/estimations`, { method: 'revenue_pct' });
    await ok(alex, 'POST', `/commerces/estimations/${e.id}/validation`);
    const pr = await ok(alex, 'POST', `/commerces/${p.id}/presentations`);
    await ok(alex, 'POST', `/commerces/presentations/${pr.id}/validation`);
    await ok(alex, 'POST', `/commerces/${p.id}/documents`, { kind: 'bilan', title: 'Bilan 2026', storageRef: 'r2://essai/bilan.txt' });
    return p.id;
  };
  const buyer = async (letter: string) => {
    const p = await store.createPerson({ networkId: network.id, agentId: alexA.id, firstName: `Repreneur${letter}`, lastName: 'Essai' });
    await store.addIdentifier({ networkId: network.id, personId: p.id, kind: 'email', value: `repreneur.${letter.toLowerCase()}@exemple.test` });
    return { id: p.id, email: `repreneur.${letter.toLowerCase()}@exemple.test` };
  };
  const tokenFor = async (personId: string): Promise<string | null> => {
    const row = await db.first<{ body: string }>(
      `SELECT m.body FROM messages m JOIN trial_outbox t ON t.message_id = m.id WHERE m.person_id = ? AND m.body LIKE '%dossier confidentiel du commerce%' ORDER BY m.rowid DESC LIMIT 1`,
      [personId],
    );
    return /dossier\/([a-z]{40})/.exec(row?.body ?? '')?.[1] ?? null;
  };
  return { closed, store, alexId: alexA.id, networkId: network.id, db, journal, call, ok, read, shop, buyer, tokenFor, alex, bea, dir, compliance, partner, verified, deposited, lastCode: () => lastCode, setDay: (d: string) => (clock = Date.parse(`${d}T08:00:00.000Z`)) };
}

describeWithSqlite('CE09 · routes de M16 et parcours de 10 demandes tests', () => {
  it('[R110] [R12] les phrases de l’IA refusées suivent la présentation de secours dans la réponse', async () => {
    const t = await setup({ write: async () => ({ title: 'Restaurant à Dijon', body: 'Loyer de 2 000 € par mois. Belle salle.' }) });
    await t.ok(t.dir, 'POST', '/commerces/baremes', { activity: 'restaurant', method: 'revenue_pct', low: 5_000, high: 8_000, source: 'Barème inventé', sourceDate: '2027-01-15' });
    const id = await t.shop();
    const again = await t.call(t.alex, 'POST', `/commerces/${id}/presentations`);
    expect(again.status).toBe(200);
    const body = again.body as unknown as { data: { origin: string }; aiRefused: { problems: { code: string }[] }[] | null };
    expect(body.data.origin).toBe('secours');
    expect(body.aiRefused?.flatMap((x) => x.problems.map((p) => p.code))).toContain('chiffre_confidentiel');
  });

  it('[R16] [R110] les lectures de l’écran : la liste, l’état des demandes, la cession du bien, sans chiffre confidentiel', async () => {
    const t = await setup();
    await t.ok(t.dir, 'POST', '/commerces/baremes', { activity: 'restaurant', method: 'revenue_pct', low: 5_000, high: 8_000, source: 'Barème inventé', sourceDate: '2027-01-15' });
    await t.ok(t.dir, 'POST', '/commerces/engagements/modeles', { body: NDA });
    const id = await t.shop();
    const list = await t.ok(t.alex, 'GET', '/commerces');
    expect(list).toEqual([expect.objectContaining({ propertyId: id, kind: 'business', city: 'Dijon' })]);
    expect(await t.ok(t.bea, 'GET', '/commerces')).toEqual([]);
    expect(await t.ok(t.dir, 'GET', '/commerces')).toHaveLength(1);
    const r = await t.buyer('A');
    await t.ok(t.alex, 'POST', `/commerces/${id}/demandes`, { personId: r.id });
    const before = (await t.journal.all()).filter((e) => e.type === 'commerces.confidentiel.refuse').length;
    const requests = await t.ok(t.alex, 'GET', `/commerces/${id}/demandes`);
    expect(requests).toEqual([expect.objectContaining({ personId: r.id, firstName: 'RepreneurA', open: false, codes: ['engagement_non_signe', 'identite_non_verifiee'] })]);
    for (const secret of SECRETS) expect(JSON.stringify(requests), secret).not.toContain(secret);
    // Lire l'état n'est pas tenter un envoi : rien de plus au journal des refus.
    expect((await t.journal.all()).filter((e) => e.type === 'commerces.confidentiel.refuse')).toHaveLength(before);
    expect((await t.call(t.bea, 'GET', `/commerces/${id}/demandes`)).status).toBe(403);
    expect((await t.call(t.compliance, 'GET', `/commerces/${id}/demandes`)).status).toBe(403);
    expect(await t.ok(t.alex, 'GET', `/commerces/${id}/cession`)).toBeNull();
    expect((await t.call(t.bea, 'GET', `/commerces/${id}/cession`)).status).toBe(403);
    await t.ok(t.alex, 'POST', `/commerces/${id}/cession`);
    expect((await t.ok(t.compliance, 'GET', `/commerces/${id}/cession`)).lines.length).toBeGreaterThan(5);
  });

  it('[R113] [R114] [R110] sur 10 demandes tests, aucun dossier confidentiel n’est envoyé sans engagement signé ; chaque ouverture est journalisée avec son lecteur', async () => {
    const t = await setup();
    await t.ok(t.dir, 'POST', '/commerces/baremes', { activity: 'restaurant', method: 'revenue_pct', low: 5_000, high: 8_000, source: 'Barème inventé pour les tests', sourceDate: '2027-01-15' });
    await t.ok(t.dir, 'POST', '/commerces/engagements/modeles', { body: NDA });
    const a = await t.shop();
    const b = await t.shop();
    // Chaque demande : signer ou non, pièce vérifiée ou non, engagement d'un autre bien, révoqué.
    const plans: { sign: boolean; verified: boolean; otherShop?: boolean; revoke?: boolean; expect: boolean }[] = [
      { sign: false, verified: false, expect: false },
      { sign: false, verified: true, expect: false },
      { sign: true, verified: false, expect: false },
      { sign: true, verified: true, expect: true },
      { sign: true, verified: true, otherShop: true, expect: false },
      { sign: true, verified: true, revoke: true, expect: false },
      { sign: true, verified: true, expect: true },
      { sign: false, verified: true, otherShop: true, expect: false },
      { sign: true, verified: true, expect: true },
      { sign: true, verified: false, revoke: true, expect: false },
    ];
    let sent = 0;
    for (const [i, plan] of plans.entries()) {
      const letter = 'ABCDEFGHIJ'[i]!;
      const r = await t.buyer(letter);
      if (plan.verified) t.verified.add(r.id);
      const where = plan.otherShop ? b : a;
      const answer = await t.ok(t.alex, 'POST', `/commerces/${where}/demandes`, { personId: r.id });
      // La réponse immédiate : la vue publique et la présentation, rien de confidentiel [R110].
      expect(answer.publicView).toMatchObject({ kind: 'business', activity: 'restaurant', city: 'Dijon' });
      for (const secret of SECRETS) expect(JSON.stringify(answer), secret).not.toContain(secret);
      if (plan.sign) {
        const open = await t.ok(t.alex, 'POST', `/commerces/engagements/${answer.ndaId}/signature`, CONSENT);
        await t.ok(t.alex, 'POST', `/commerces/signatures/${open.sessionId}`, { code: t.lastCode() });
      }
      if (plan.revoke) await t.ok(t.alex, 'POST', `/commerces/engagements/${answer.ndaId}/revocation`, { reason: 'demande_repreneur' });
      const send = await t.call(t.alex, 'POST', `/commerces/${a}/dossiers`, { personId: r.id, ...CONSENT });
      expect(send.status === 200, `demande ${i + 1}`).toBe(plan.expect);
      if (!plan.expect) {
        expect(send.body).toMatchObject({ ok: false, rule: 'R113' });
        expect(await t.tokenFor(r.id), `demande ${i + 1}`).toBeNull();
        continue;
      }
      sent += 1;
      // Le lecteur ouvre deux fois : chaque ouverture journalisée avec son lecteur, une fois.
      const token = (await t.tokenFor(r.id))!;
      for (let k = 0; k < 2; k += 1) {
        expect((await t.read(`/dossier/${token}/code`, { email: r.email })).status).toBe(200);
        const opened = await t.read(`/dossier/${token}`, { email: r.email, code: t.lastCode() });
        expect(opened.status).toBe(200);
        expect(opened.body.data.pages[0].text).toContain('La Table Inventée');
      }
      // Un autre lecteur, avec la bonne adresse mais sans le code : refusé, journalisé.
      expect((await t.read(`/dossier/${token}`, { email: r.email, code: '000000' })).body).toMatchObject({ ok: false, code: 'autre_lecteur' });
    }
    expect(sent).toBe(3);
    const log = await t.ok(t.alex, 'GET', `/commerces/${a}/ouvertures`);
    const opened = log.filter((x: { outcome: string }) => x.outcome === 'ouvert');
    expect(opened).toHaveLength(6);
    expect(new Set(opened.map((x: { personId: string }) => x.personId)).size).toBe(3);
    expect(log.filter((x: { outcome: string }) => x.outcome === 'autre_lecteur')).toHaveLength(3);
    const events = (await t.journal.all()).filter((e) => e.type === 'commerces.dossier.ouvert');
    expect(events).toHaveLength(6);
  });

  it('[R16] [R111] les barèmes en vigueur : la direction seule, à leur dernière version', async () => {
    const t = await setup();
    const scale = { activity: 'restaurant', method: 'revenue_pct', source: 'Barème inventé', sourceDate: '2027-01-15' };
    await t.ok(t.dir, 'POST', '/commerces/baremes', { ...scale, low: 5_000, high: 8_000 });
    await t.ok(t.dir, 'POST', '/commerces/baremes', { ...scale, low: 6_000, high: 9_000 });
    const seen = await t.ok(t.dir, 'GET', '/commerces/baremes');
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ activity: 'restaurant', low: 6_000, high: 9_000, version: 2 });
    for (const who of [t.alex, t.compliance]) expect((await t.call(who, 'GET', '/commerces/baremes')).status).toBe(403);
  });

  it('[R16] [R118] la lecture de l’acquéreur : l’agent du bien, jamais un autre agent ni la conformité, et le refus au journal', async () => {
    const t = await setup();
    await t.ok(t.dir, 'POST', '/commerces/baremes', { activity: 'restaurant', method: 'revenue_pct', low: 5_000, high: 8_000, source: 'Barème inventé', sourceDate: '2027-01-15' });
    const id = await t.shop();
    const file = await t.ok(t.alex, 'POST', `/commerces/${id}/cession`);
    expect(await t.ok(t.alex, 'GET', `/commerces/cessions/${file.fileId}/acquereur`)).toBeNull();
    expect((await t.call(t.bea, 'GET', `/commerces/cessions/${file.fileId}/acquereur`)).status).toBe(403);
    const refused = await t.call(t.compliance, 'GET', `/commerces/cessions/${file.fileId}/acquereur`);
    expect(refused.status).toBe(403);
    expect(refused.body).toMatchObject({ ok: false, rule: 'R16', code: 'role' });
    const logged = (await t.journal.all()).filter((e) => e.type === 'acces.refuse');
    expect(logged.some((e) => (e.data as { kind?: string }).kind === 'commerces.cession.acquereur_lu')).toBe(true);
  });

  it('[R116] [R117] les délais sont justes sur 3 dossiers de cession, par les routes', async () => {
    const t = await setup();
    await t.ok(t.dir, 'POST', '/commerces/perimetres', { postalCode: '21000', city: 'Dijon', inPerimeter: false, source: 'Liste inventée des périmètres', sourceDate: '2026-06-30' });
    await t.ok(t.dir, 'POST', '/commerces/baremes', { activity: 'restaurant', method: 'revenue_pct', low: 5_000, high: 8_000, source: 'Barème inventé', sourceDate: '2027-01-15' });
    const cases = [
      // 4 salariés : 27 octobre − 2 mois = vendredi 27 août.
      { employees: 4, prevue: '2027-10-27', due: '2027-08-27' },
      // 12 salariés : 17 décembre − 2 mois = dimanche 17 octobre, avancé au vendredi 15 octobre.
      { employees: 12, prevue: '2027-12-17', due: '2027-10-15' },
      // Sans salarié : sans objet.
      { employees: 0, prevue: '2027-11-30', due: null },
    ];
    for (const c of cases) {
      const id = await t.shop();
      await t.ok(t.alex, 'POST', `/commerces/${id}/fiche`, { employees: c.employees });
      const file = await t.ok(t.alex, 'POST', `/commerces/${id}/cession`);
      await t.ok(t.alex, 'POST', `/commerces/cessions/${file.fileId}/dates`, { kind: 'cession_prevue', day: c.prevue, proofRef: proof() });
      const refused = await t.call(t.alex, 'POST', `/commerces/cessions/${file.fileId}/sequestre`, { kind: 'banque', name: 'Compte du Réseau Essai' });
      expect(refused.body).toMatchObject({ ok: false, rule: 'R117' });
      const v = await t.ok(t.alex, 'GET', `/commerces/cessions/${file.fileId}`);
      const line = v.lines.find((l: { step: string }) => l.step === 'information_salaries');
      expect(line.due, `${c.employees} salariés`).toBe(c.due);
      const ready = await t.call(t.alex, 'POST', `/commerces/cessions/${file.fileId}/prete`);
      expect(ready.body).toMatchObject({ ok: false, rule: 'R116' });
      expect(ready.body.missing).toContain('sequestre');
    }
    // Après la cession : 27 octobre + 15 jours = 11 novembre, férié, avancé au 10 ; oppositions : 4 novembre + 10 = dimanche 14, reporté au 15.
    const id = await t.shop();
    const file = await t.ok(t.alex, 'POST', `/commerces/${id}/cession`);
    await t.ok(t.alex, 'POST', `/commerces/${id}/fiche`, { employees: 0 });
    await t.ok(t.alex, 'POST', `/commerces/cessions/${file.fileId}/dates`, { kind: 'cession_prevue', day: '2027-10-27', proofRef: proof() });
    await t.ok(t.alex, 'POST', `/commerces/cessions/${file.fileId}/sequestre`, { kind: 'notaire', name: 'Office notarial inventé' });
    const blocked = await t.call(t.alex, 'POST', `/commerces/cessions/${file.fileId}/dates`, { kind: 'cession_signee', day: '2027-01-15', proofRef: proof() });
    expect(blocked.body).toMatchObject({ ok: false, rule: 'R116', code: 'etapes_bloquantes', missing: ['autorisations'] });
    await t.ok(t.alex, 'POST', `/commerces/cessions/${file.fileId}/dates`, { kind: 'autorisations_verifiees', day: '2027-01-15', proofRef: proof() });
    const undeclared = await t.call(t.alex, 'POST', `/commerces/cessions/${file.fileId}/dates`, { kind: 'cession_signee', day: '2027-01-15', proofRef: proof() });
    expect(undeclared.body).toMatchObject({ ok: false, rule: 'R116', code: 'cession_non_declaree' });
    await t.ok(t.alex, 'POST', `/commerces/cessions/${file.fileId}/prete`);
    t.setDay('2027-11-16');
    for (const [kind, day] of [['cession_signee', '2027-10-27'], ['publication_jal', '2027-11-02'], ['publication_bodacc', '2027-11-04']]) {
      await t.ok(t.alex, 'POST', `/commerces/cessions/${file.fileId}/dates`, { kind, day, proofRef: proof() });
    }
    const v = await t.ok(t.alex, 'GET', `/commerces/cessions/${file.fileId}`);
    expect(v.lines.filter((l: { step: string }) => ['publication_jal', 'fin_oppositions'].includes(l.step)).map((l: { due: string }) => l.due)).toEqual(['2027-11-10', '2027-11-15']);
  });

  it('[R16] [R110] un rôle non admis est refusé avant le corps ; aucune route publique ne rend un champ confidentiel', async () => {
    const t = await setup();
    await t.ok(t.dir, 'POST', '/commerces/baremes', { activity: 'restaurant', method: 'revenue_pct', low: 5_000, high: 8_000, source: 'Barème inventé', sourceDate: '2027-01-15' });
    const id = await t.shop();
    // Le partenaire est refusé avant tout, même avec un corps illisible, et le refus est au journal.
    const refused = await t.call(t.partner, 'POST', `/commerces/${id}/fiche`, undefined);
    expect(refused).toMatchObject({ status: 403, body: { ok: false, rule: 'R16', code: 'role' } });
    expect((await t.call(t.alex, 'POST', '/commerces/baremes', { activity: 'restaurant' })).status).toBe(403);
    expect((await t.call(t.alex, 'GET', '/commerces/vigilance')).status).toBe(403);
    expect((await t.call(t.bea, 'GET', `/commerces/${id}/fiche`)).status).toBe(403);
    const kinds = (await t.journal.all()).filter((e) => e.type === 'acces.refuse').map((e) => (e.data as { kind: string }).kind);
    expect(kinds).toEqual(expect.arrayContaining(['commerces.fiche.modifiee', 'commerces.bareme', 'commerces.vigilance']));
    // La vue publique et la présentation : rien de confidentiel.
    const pub = await t.ok(t.alex, 'GET', `/commerces/${id}/public`);
    expect(pub.publicView).toMatchObject({ kind: 'business', activity: 'restaurant' });
    expect(pub.presentation).not.toBeNull();
    for (const secret of SECRETS) expect(JSON.stringify(pub), secret).not.toContain(secret);
    // Un corps illisible, pour un rôle admis : refusé sans rien écrire.
    expect((await t.call(t.alex, 'POST', `/commerces/${id}/fiche`, undefined)).body).toMatchObject({ ok: false, code: 'invalid_body' });
  });
});

it('chaque route admet des rôles et porte un nom de journal sans identifiant', () => {
  for (const r of commercesRoutes()) {
    expect(r.roles.length, r.name).toBeGreaterThan(0);
    expect(r.name).toMatch(/^commerces\.[a-z_.]+$/);
  }
  const names = commercesRoutes().map((r) => r.name);
  expect(new Set(names).size).toBe(names.length);
});

describeWithSqlite('CE14 · les lectures de l’écran des engagements', () => {
  const CONSENT = { consentProof: 'Accord donné de vive voix à l’agence, le 7 septembre (invention de test)' };
  it('[R16] le modèle en vigueur : la direction seule, à sa dernière version', async () => {
    const t = await setup();
    expect(await t.ok(t.dir, 'GET', '/commerces/engagements/modeles')).toBeNull();
    await t.ok(t.dir, 'POST', '/commerces/engagements/modeles', { body: NDA });
    await t.ok(t.dir, 'POST', '/commerces/engagements/modeles', { body: `${NDA} Deuxième version.` });
    expect(await t.ok(t.dir, 'GET', '/commerces/engagements/modeles')).toMatchObject({ version: 2, body: `${NDA} Deuxième version.` });
    for (const who of [t.alex, t.bea, t.compliance]) expect((await t.call(who, 'GET', '/commerces/engagements/modeles')).status).toBe(403);
  });
  it('[R113] [R16] [R110] le texte à faire lire et l’état de chaque demande, sans aucun chiffre', async () => {
    const t = await setup();
    await t.ok(t.dir, 'POST', '/commerces/baremes', { activity: 'restaurant', method: 'revenue_pct', low: 5_000, high: 8_000, source: 'Barème inventé', sourceDate: '2027-01-15' });
    const id = await t.shop();
    const r = await t.buyer('A');
    // Sans modèle : la demande est rangée, aucun engagement à signer.
    expect((await t.ok(t.alex, 'POST', `/commerces/${id}/demandes`, { personId: r.id })).ndaId).toBeNull();
    expect(await t.ok(t.alex, 'GET', `/commerces/${id}/demandes`)).toEqual([expect.objectContaining({ ndaId: null, signed: false, codes: ['engagement_absent', 'identite_non_verifiee'] })]);
    await t.ok(t.dir, 'POST', '/commerces/engagements/modeles', { body: NDA });
    const { ndaId } = await t.ok(t.alex, 'POST', `/commerces/${id}/demandes`, { personId: r.id });
    const text = await t.ok(t.alex, 'GET', `/commerces/engagements/${ndaId}`);
    expect(text).toMatchObject({ ndaId, signed: false, revoked: false });
    expect(text.content).toContain('RepreneurA Essai');
    for (const secret of SECRETS) expect(JSON.stringify(text), secret).not.toContain(secret);
    for (const who of [t.bea, t.compliance]) expect((await t.call(who, 'GET', `/commerces/engagements/${ndaId}`)).status).toBe(403);
    expect((await t.call(t.alex, 'GET', '/commerces/engagements/inconnu')).status).toBe(404);
    // Signé : la ligne le dit, la pièce manque encore.
    const open = await t.ok(t.alex, 'POST', `/commerces/engagements/${ndaId}/signature`, CONSENT);
    await t.ok(t.alex, 'POST', `/commerces/signatures/${open.sessionId}`, { code: t.lastCode(), drawing: '1,1 2,2 3,3 4,4' });
    expect(await t.ok(t.alex, 'GET', `/commerces/${id}/demandes`)).toEqual([expect.objectContaining({ ndaId, signed: true, open: false, codes: ['identite_non_verifiee'] })]);
    expect((await t.ok(t.alex, 'GET', `/commerces/engagements/${ndaId}`)).signed).toBe(true);
    t.verified.add(r.id);
    expect(await t.ok(t.alex, 'GET', `/commerces/${id}/demandes`)).toEqual([expect.objectContaining({ open: true, codes: [] })]);
  });
  it('[R113] un engagement modifié ou révoqué ferme la porte ; révoqué, une nouvelle demande en fait un autre, à signer', async () => {
    const t = await setup();
    await t.ok(t.dir, 'POST', '/commerces/baremes', { activity: 'restaurant', method: 'revenue_pct', low: 5_000, high: 8_000, source: 'Barème inventé', sourceDate: '2027-01-15' });
    await t.ok(t.dir, 'POST', '/commerces/engagements/modeles', { body: NDA });
    const id = await t.shop();
    const r = await t.buyer('A');
    t.verified.add(r.id);
    const { ndaId } = await t.ok(t.alex, 'POST', `/commerces/${id}/demandes`, { personId: r.id });
    const open = await t.ok(t.alex, 'POST', `/commerces/engagements/${ndaId}/signature`, CONSENT);
    await t.ok(t.alex, 'POST', `/commerces/signatures/${open.sessionId}`, { code: t.lastCode() });
    expect(await t.ok(t.alex, 'GET', `/commerces/${id}/demandes`)).toEqual([expect.objectContaining({ open: true })]);
    // Le texte rangé change : la porte se ferme, le dossier ne part pas.
    // Une écriture directe dans la base, hors du code : la garde est levée le temps de l'essai.
    await t.db.run('DROP TRIGGER business_ndas_fige');
    await t.db.run('UPDATE business_ndas SET content = content || ? WHERE id = ?', [' Ajout.', ndaId]);
    expect(await t.ok(t.alex, 'GET', `/commerces/${id}/demandes`)).toEqual([expect.objectContaining({ open: false, ndaId, signed: true, codes: ['engagement_modifie'] })]);
    expect((await t.call(t.alex, 'POST', `/commerces/${id}/dossiers`, { personId: r.id, ...CONSENT })).body).toMatchObject({ ok: false, rule: 'R113', codes: ['engagement_modifie'] });
    // Révoqué : plus d'engagement en vigueur ; une nouvelle demande en fait un nouveau.
    await t.ok(t.alex, 'POST', `/commerces/engagements/${ndaId}/revocation`, { reason: 'manquement' });
    expect(await t.ok(t.alex, 'GET', `/commerces/${id}/demandes`)).toEqual([expect.objectContaining({ open: false, ndaId: null, signed: false, codes: ['engagement_revoque'] })]);
    const again = await t.ok(t.alex, 'POST', `/commerces/${id}/demandes`, { personId: r.id });
    expect(again.ndaId).not.toBe(ndaId);
    expect(await t.ok(t.alex, 'GET', `/commerces/${id}/demandes`)).toEqual([expect.objectContaining({ open: false, ndaId: again.ndaId, signed: false })]);
  });
  it('[R26] [R13] le code passe par le contrôle central, en mode essai : rangé dans la boîte d’essai, absent du journal', async () => {
    const t = await setup();
    await t.ok(t.dir, 'POST', '/commerces/baremes', { activity: 'restaurant', method: 'revenue_pct', low: 5_000, high: 8_000, source: 'Barème inventé', sourceDate: '2027-01-15' });
    await t.ok(t.dir, 'POST', '/commerces/engagements/modeles', { body: NDA });
    const id = await t.shop();
    const r = await t.buyer('A');
    const { ndaId } = await t.ok(t.alex, 'POST', `/commerces/${id}/demandes`, { personId: r.id });
    const open = await t.ok(t.alex, 'POST', `/commerces/engagements/${ndaId}/signature`, CONSENT);
    expect(open.mode).toBe('essai');
    const code = t.lastCode();
    const boxed = await t.db.all<{ body: string }>('SELECT m.body FROM messages m JOIN trial_outbox o ON o.message_id = m.id WHERE m.person_id = ?', [r.id]);
    expect(boxed.filter((m) => m.body.includes(code))).toHaveLength(1);
    expect(JSON.stringify(open)).not.toContain(code);
    expect(JSON.stringify(await t.journal.all())).not.toContain(code);
  });
});

describeWithSqlite('CE15 · les repreneurs à l’écran, par les routes', () => {
  const ready = async () => {
    const t = await setup();
    await t.ok(t.dir, 'POST', '/commerces/baremes', { activity: 'restaurant', method: 'revenue_pct', low: 5_000, high: 8_000, source: 'Barème inventé', sourceDate: '2027-01-15' });
    const buyer = await t.buyer('A');
    const project = await t.store.createProject({ networkId: t.networkId, agentId: t.alexId, personId: buyer.id, kind: 'buy_business' });
    return { t, buyer, project };
  };
  it('[R14] [R16] les projets dans l’ordre d’arrivée, sans rien du profil ; ni un autre agent, ni la conformité', async () => {
    const { t, project } = await ready();
    // RepreneurA arrive le premier, sans budget ; ensuite Z, puis B au gros budget : ni l'alphabet ni l'argent ne donnent cet ordre.
    const z = await t.buyer('Z');
    const second = await t.store.createProject({ networkId: t.networkId, agentId: t.alexId, personId: z.id, kind: 'buy_business' });
    const b = await t.buyer('B');
    const third = await t.store.createProject({ networkId: t.networkId, agentId: t.alexId, personId: b.id, kind: 'buy_business' });
    await t.store.createProject({ networkId: t.networkId, agentId: t.alexId, personId: b.id, kind: 'buy' });
    await t.ok(t.alex, 'POST', `/commerces/repreneurs/${third.id}`, { budgetMaxEur: 500_000, declaredContributionEur: 90_000 });
    await t.ok(t.alex, 'POST', `/commerces/repreneurs/${second.id}`, { budgetMaxEur: 10_000 });
    const seen = await t.ok(t.alex, 'GET', '/commerces/repreneurs');
    expect(seen.map((x: { projectId: string }) => x.projectId)).toEqual([project.id, second.id, third.id]);
    expect(seen[0]).toEqual({ projectId: project.id, firstName: 'RepreneurA', createdAt: expect.any(String), writable: true });
    // Rien pour classer : ni montant, ni score, ni coordonnée.
    expect(JSON.stringify(seen)).not.toMatch(/500000|90000|score|note|rang|@/);
    expect(await t.ok(t.bea, 'GET', '/commerces/repreneurs')).toEqual([]);
    expect((await t.ok(t.dir, 'GET', '/commerces/repreneurs')).map((x: { projectId: string; writable: boolean }) => [x.projectId, x.writable])).toEqual([[project.id, true], [second.id, true], [third.id, true]]);
    for (const who of [t.compliance, t.partner]) expect((await t.call(who, 'GET', '/commerces/repreneurs')).status).toBe(403);
  });
  it('[R110] [R115] le rapprochement : seulement les commerces diffusables, sans aucun chiffre confidentiel', async () => {
    const { t, project } = await ready();
    const shown = await t.shop();
    const closed = await t.shop();
    t.closed.add(closed);
    await t.ok(t.alex, 'POST', `/commerces/repreneurs/${project.id}`, { activities: ['restaurant'], postalCodes: ['21000'] });
    const found = await t.ok(t.alex, 'GET', `/commerces/repreneurs/${project.id}/biens`);
    expect(found.map((m: { propertyId: string }) => m.propertyId)).toEqual([shown]);
    for (const secret of SECRETS) expect(JSON.stringify(found), secret).not.toContain(secret);
    t.closed.add(shown);
    expect(await t.ok(t.alex, 'GET', `/commerces/repreneurs/${project.id}/biens`)).toEqual([]);
  });
});

describeWithSqlite('CE16 · la réponse immédiate au repreneur', () => {
  const ready = async () => {
    const t = await setup();
    await t.ok(t.dir, 'POST', '/commerces/baremes', { activity: 'restaurant', method: 'revenue_pct', low: 5_000, high: 8_000, source: 'Barème inventé', sourceDate: '2027-01-15' });
    const id = await t.shop();
    const r = await t.buyer('A');
    return { t, id, r };
  };
  const boxed = (t: Awaited<ReturnType<typeof setup>>, personId: string) =>
    t.db.all<{ body: string }>(`SELECT m.body FROM messages m JOIN trial_outbox o ON o.message_id = m.id WHERE m.person_id = ? AND m.body LIKE '%informations publiques%'`, [personId]);
  it('[R110] [R26] [R13] seule la présentation validée part, dans la boîte d’essai ; ni chiffre confidentiel, ni trace au journal', async () => {
    const { t, id, r } = await ready();
    await t.ok(t.alex, 'POST', `/commerces/${id}/demandes`, { personId: r.id });
    expect(await t.ok(t.alex, 'POST', `/commerces/${id}/informations`, { personId: r.id, ...CONSENT })).toEqual({ mode: 'essai' });
    const [mail] = await boxed(t, r.id);
    const shown = (await t.ok(t.alex, 'GET', `/commerces/${id}/presentation`)) as { title: string; body: string };
    expect(mail!.body).toContain(shown.title.replace(/\s*\(([^()]*)\)/g, ', $1'));
    expect(mail!.body).not.toMatch(/[()]/);
    expect(mail!.body).toContain('Votre agent immobilier');
    for (const secret of SECRETS) expect(mail!.body, secret).not.toContain(secret);
    expect(JSON.stringify(await t.journal.all())).not.toContain(shown.title);
    // [R05] une seule fois par commerce : le second envoi est refusé, rien de plus dans la boîte.
    const again = await t.call(t.alex, 'POST', `/commerces/${id}/informations`, { personId: r.id, ...CONSENT });
    expect(again.body).toMatchObject({ ok: false, rule: 'R05', code: 'send_refused' });
    expect(await boxed(t, r.id)).toHaveLength(1);
  });
  it('[R42] [R110] sans demande, sans diffusion ou sans présentation validée, rien ne part', async () => {
    const { t, id, r } = await ready();
    expect((await t.call(t.alex, 'POST', `/commerces/${id}/informations`, { personId: r.id, ...CONSENT })).body).toMatchObject({ ok: false, code: 'pas_de_demande' });
    await t.ok(t.alex, 'POST', `/commerces/${id}/demandes`, { personId: r.id });
    t.closed.add(id);
    expect((await t.call(t.alex, 'POST', `/commerces/${id}/informations`, { personId: r.id, ...CONSENT })).body).toMatchObject({ ok: false, rule: 'R42', code: 'non_diffusable' });
    t.closed.delete(id);
    // La fiche change : la présentation d'avant n'est plus publiable.
    await t.ok(t.alex, 'POST', `/commerces/${id}/fiche`, { employees: 9 });
    expect((await t.call(t.alex, 'POST', `/commerces/${id}/informations`, { personId: r.id, ...CONSENT })).body).toMatchObject({ ok: false, rule: 'R110', code: 'presentation_absente' });
    expect(await boxed(t, r.id)).toEqual([]);
  });
  it('[R03] sans accord noté, ou l’accord retiré, rien ne part, et la parole de l’agent ne le redonne pas', async () => {
    const { t, id, r } = await ready();
    await t.ok(t.alex, 'POST', `/commerces/${id}/demandes`, { personId: r.id });
    expect((await t.call(t.alex, 'POST', `/commerces/${id}/informations`, { personId: r.id, consentProof: '  ' })).body).toMatchObject({ code: 'bad_consent' });
    const c = await t.store.addConsent({ networkId: t.networkId, personId: r.id, purpose: 'information_commerce', channel: 'email', proof: 'Accord inventé', givenAt: new Date('2027-09-01T08:00:00.000Z') });
    await t.store.withdrawConsent(c.id, new Date('2027-09-02T08:00:00.000Z'));
    expect((await t.call(t.alex, 'POST', `/commerces/${id}/informations`, { personId: r.id, ...CONSENT })).body).toMatchObject({ ok: false, rule: 'R03', code: 'consent_withdrawn' });
    expect(await boxed(t, r.id)).toEqual([]);
  });
  const refusals = async (t: Awaited<ReturnType<typeof setup>>) => (await t.journal.all()).filter((e) => e.type === 'commerces.acces.informations_refusees').map((e) => e.data);
  it('[R13] chaque refus laisse sa trace au journal, ses seuls codes', async () => {
    const { t, id, r } = await ready();
    await t.ok(t.alex, 'POST', `/commerces/${id}/demandes`, { personId: r.id });
    t.closed.add(id);
    await t.call(t.alex, 'POST', `/commerces/${id}/informations`, { personId: r.id, ...CONSENT });
    t.closed.delete(id);
    await t.ok(t.alex, 'POST', `/commerces/${id}/fiche`, { employees: 9 });
    await t.call(t.alex, 'POST', `/commerces/${id}/informations`, { personId: r.id, ...CONSENT });
    expect(await refusals(t)).toEqual([{ rule: 'R42', code: 'non_diffusable' }, { rule: 'R110', code: 'presentation_absente' }]);
  });
  it('[R19] le nom du vendeur ne part jamais au repreneur, même écrit à la main dans la présentation', async () => {
    const { t, id, r } = await ready();
    const seller = await t.store.createPerson({ networkId: t.networkId, agentId: t.alexId, firstName: 'Vendeurinvente', lastName: 'Essai' });
    const project = await t.store.createProject({ networkId: t.networkId, agentId: t.alexId, personId: seller.id, kind: 'sell_business' });
    await t.db.run("INSERT INTO project_properties (project_id, property_id, network_id, role, created_at) VALUES (?, ?, ?, 'owned', ?)", [project.id, id, t.networkId, '2027-09-01T08:00:00.000Z']);
    const shown = await t.ok(t.alex, 'GET', `/commerces/${id}/presentation`);
    // Une présentation corrigée par l'agent, puis validée.
    const fixed = await t.ok(t.alex, 'POST', `/commerces/${id}/presentations/texte`, { title: shown.title, body: `Monsieur Vendeurinvente cède son restaurant. ${shown.body}` });
    await t.ok(t.alex, 'POST', `/commerces/presentations/${fixed.id}/validation`);
    await t.ok(t.alex, 'POST', `/commerces/${id}/demandes`, { personId: r.id });
    expect((await t.call(t.alex, 'POST', `/commerces/${id}/informations`, { personId: r.id, ...CONSENT })).body).toMatchObject({ ok: false, code: 'send_refused' });
    expect(await boxed(t, r.id)).toEqual([]);
  });
  it('[R03] [R05] sur des fiches réunies : l’accord retiré tient, et le doublon aussi', async () => {
    const { t, id, r } = await ready();
    const fiche = new FicheUnique(t.db, t.store, { now: () => new Date('2027-09-07T08:00:00.000Z') });
    const withdrawnOn = await t.buyer('B');
    const c = await t.store.addConsent({ networkId: t.networkId, personId: withdrawnOn.id, purpose: 'information_commerce', channel: 'email', proof: 'Accord inventé', givenAt: new Date('2027-09-01T08:00:00.000Z') });
    await t.store.withdrawConsent(c.id, new Date('2027-09-02T08:00:00.000Z'));
    await fiche.merge({ survivorId: r.id, mergedId: withdrawnOn.id, reason: 'test' });
    await t.ok(t.alex, 'POST', `/commerces/${id}/demandes`, { personId: r.id });
    expect((await t.call(t.alex, 'POST', `/commerces/${id}/informations`, { personId: r.id, ...CONSENT })).body).toMatchObject({ ok: false, rule: 'R03', code: 'consent_withdrawn' });
    // Le doublon : envoyé à une fiche, refusé à la fiche réunie à elle.
    const first = await t.buyer('C');
    const second = await t.buyer('D');
    await t.ok(t.alex, 'POST', `/commerces/${id}/demandes`, { personId: first.id });
    await t.ok(t.alex, 'POST', `/commerces/${id}/informations`, { personId: first.id, ...CONSENT });
    await fiche.merge({ survivorId: second.id, mergedId: first.id, reason: 'test' });
    expect((await t.call(t.alex, 'POST', `/commerces/${id}/informations`, { personId: second.id, ...CONSENT })).body).toMatchObject({ ok: false, rule: 'R05', code: 'send_refused' });
  });
  it('[R16] ni un autre agent, ni la conformité', async () => {
    const { t, id, r } = await ready();
    await t.ok(t.alex, 'POST', `/commerces/${id}/demandes`, { personId: r.id });
    for (const who of [t.bea, t.compliance]) expect((await t.call(who, 'POST', `/commerces/${id}/informations`, { personId: r.id, ...CONSENT })).status).toBe(403);
    expect(await boxed(t, r.id)).toEqual([]);
  });
});

describeWithSqlite('CE17 · retrouver la source d’une fuite, par la route de l’écran', () => {
  const ready = async () => {
    const t = await setup();
    await t.ok(t.dir, 'POST', '/commerces/baremes', { activity: 'restaurant', method: 'revenue_pct', low: 5_000, high: 8_000, source: 'Barème inventé', sourceDate: '2027-01-15' });
    return { t, a: await t.shop() };
  };
  /** Un repreneur signé et vérifié, qui ouvre le dossier : le texte qu'il pourrait faire circuler. */
  const leaked = async (t: Awaited<ReturnType<typeof setup>>, a: string) => {
    await t.ok(t.dir, 'POST', '/commerces/engagements/modeles', { body: NDA });
    const r = await t.buyer('A');
    t.verified.add(r.id);
    const { ndaId } = await t.ok(t.alex, 'POST', `/commerces/${a}/demandes`, { personId: r.id });
    const open = await t.ok(t.alex, 'POST', `/commerces/engagements/${ndaId}/signature`, CONSENT);
    await t.ok(t.alex, 'POST', `/commerces/signatures/${open.sessionId}`, { code: t.lastCode() });
    await t.ok(t.alex, 'POST', `/commerces/${a}/dossiers`, { personId: r.id, ...CONSENT });
    const token = (await t.tokenFor(r.id))!;
    await t.read(`/dossier/${token}/code`, { email: r.email });
    const seen = await t.read(`/dossier/${token}`, { email: r.email, code: t.lastCode() });
    return { r, text: String(seen.body.data.pages[0].text) };
  };

  it('[R16] seuls l’agent du bien et la direction cherchent : tout autre est refusé', async () => {
    const { t, a } = await ready();
    const body = { text: 'Un texte inventé.' };
    for (const who of [t.alex, t.dir]) expect((await t.call(who, 'POST', `/commerces/${a}/tracage`, body)).status).toBe(200);
    for (const who of [t.bea, t.compliance, t.partner]) expect((await t.call(who, 'POST', `/commerces/${a}/tracage`, body)).status).toBe(403);
    expect((await t.call(t.alex, 'POST', `/commerces/${a}/tracage`, { text: '' })).body.code).toBe('bad_text');
  });

  it('[R13] ni nom ni contenu du texte collé au journal, sans marque', async () => {
    const { t, a } = await ready();
    const pasted = 'Madame Inventée Dupont a transmis le bilan de 812 300 €.';
    expect(await t.ok(t.alex, 'POST', `/commerces/${a}/tracage`, { text: pasted })).toBeNull();
    const events = (await t.journal.all()).filter((e) => e.type === 'commerces.dossier.trace');
    expect(events).toHaveLength(1);
    expect(events[0]!.data).toEqual({ found: false });
    const all = JSON.stringify(await t.journal.all());
    for (const part of ['Inventée Dupont', '812 300', pasted]) expect(all).not.toContain(part);
  });

  it('[R13] [R114] le texte réel d’une ouverture remonte à son lecteur, le journal ne garde que l’ouverture', async () => {
    const { t, a } = await ready();
    const { r, text } = await leaked(t, a);
    const before = JSON.stringify(await t.journal.all());
    const pasted = `Copié par Madame Inventée Dupont : ${text}`;
    const found = await t.ok(t.alex, 'POST', `/commerces/${a}/tracage`, { text: pasted });
    expect(found).toMatchObject({ personId: r.id, via: 'marque' });
    const events = (await t.journal.all()).filter((e) => e.type === 'commerces.dossier.trace');
    expect(events).toHaveLength(1);
    expect(events[0]!.data).toEqual({ found: true, access: found.accessId, via: 'marque' });
    const all = JSON.stringify(await t.journal.all());
    expect(all.length - before.length).toBeLessThan(600);
    for (const part of ['Inventée Dupont', 'Repreneur', 'Table Inventée']) expect(JSON.stringify(events), part).not.toContain(part);
    expect(all).not.toContain('Copié par');
  });
});
