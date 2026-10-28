import { expect, it } from 'vitest';
import { FicheClient, SqlJournalStore, applyMigrations, fromSyncSqlite, type SqlDatabase, type Viewer } from '@aimmo/core';
import { OFFICIAL_PIECES } from '../../core/src/location/index.ts';
import { locationRoutes, type LocationServices } from '../src/location.ts';
import type { Viewer as V } from '@aimmo/core';
import { loadMigrations } from '../../core/test/migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from '../../core/test/sqlite.ts';

// Réseau, agents, propriétaires, candidats, logements, communes et adresses inventés. Le 12 juillet 2027 est un lundi.
let clock = Date.parse('2027-07-12T08:00:00.000Z'); // 10 h à Paris
let n = 0;
const uuid = (): string => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
const SHA = 'b'.repeat(64);
const DRAW = 'data:image/png;base64,AAAAexemple';
const BODY = [
  'Bail de {{bail.type}} entre {{bailleur.nom}}, domicilié {{bailleur.domicile}}, bailleur, et {{locataire.nom}}, locataire.',
  'Mandataire : {{reseau.nom}}, représenté par {{agent.nom}}, carte professionnelle {{mandataire.carte}}.',
  'Désignation : {{logement.habitat}}, {{logement.pieces}} pièces principales ; équipements : {{logement.equipements}}.',
  'Logement : {{logement.adresse}}, {{logement.commune}}, surface habitable {{logement.surface_habitable}}, classe énergie {{logement.classe_energie}}.',
  'Prise d’effet le {{bail.debut}}, pour {{bail.duree}}.',
  'Loyer : {{loyer.hors_charges}} ; charges : {{charges.montant}}, en {{charges.mode}} ; dépôt de garantie : {{depot.montant}}.',
  'Honoraires du locataire : {{honoraires.locataire}}, dont état des lieux {{honoraires.etat_des_lieux}} ; du bailleur : {{honoraires.bailleur}}.',
  'Annexes : {{annexes.liste}}.',
  'Fait le {{signature.date}} à {{signature.lieu}}.',
].join('\n\n');
const FACTS = {
  furnished: false,
  rentCents: 65_000,
  chargesCents: 5_000,
  livingAreaHundredths: 4_250,
  energyClass: 'D',
  finalEnergyKwh: 210,
  buildYear: 1985,
  electricityOver15: false,
  gas: 'aucune',
  leaseStart: '2027-09-01',
  chargesMode: 'provision',
};
/** Des noms inventés, sans chiffre : un prénom par candidat. */
const NAMES = ['Ambre', 'Basile', 'Céleste', 'Doriane', 'Elouan', 'Fanny', 'Gaspard', 'Hortense', 'Isaure', 'Jules', 'Katell', 'Léandre', 'Maëlys', 'Nolan', 'Ombeline', 'Prosper', 'Quitterie', 'Romane', 'Sacha', 'Tristan'];
/** Des sortes interdites par le décret : jamais demandées ni acceptées [R104]. */
const FORBIDDEN = ['releve_bancaire', 'carte_vitale', 'photo_identite', 'casier_judiciaire', 'attestation_bonne_tenue_compte', 'contrat_mariage', 'dossier_medical'];

async function setup() {
  clock = Date.parse('2027-07-12T08:00:00.000Z');
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  const now = (): Date => new Date((clock += 1000));
  const journal = new SqlJournalStore(db);
  const store = new FicheClient(db, { now });
  const refs = new Set<string>();
  const put = (prefix: string, ext = 'pdf') => {
    const r = `${prefix}/${uuid()}.${ext}`;
    refs.add(r);
    return r;
  };
  const s: LocationServices = { db, journal, now, files: { has: async (r) => refs.has(r) }, identity: { state: async () => ({ identityVerifiedOn: '2027-07-10' }) }, newId: uuid };
  const network = await store.createNetwork('Réseau Essai');
  const alex = await store.createAgent({ networkId: network.id, firstName: 'Alex', lastName: 'Essai' });
  const bea = await store.createAgent({ networkId: network.id, firstName: 'Béa', lastName: 'Essai' });
  const agent: Viewer = { role: 'agent', userId: alex.id, networkId: network.id };
  const other: Viewer = { role: 'agent', userId: bea.id, networkId: network.id };
  const dir: Viewer = { role: 'direction', userId: 'dir-1', networkId: network.id };
  const compliance: Viewer = { role: 'compliance', userId: 'conf-1', networkId: network.id };
  const routes = locationRoutes();
  const call = async (viewer: Viewer, method: 'GET' | 'POST', path: string, body?: unknown, raw?: string) => {
    const route = routes.find((r) => r.method === method && r.pattern.test(path));
    if (!route) throw new Error(`route inconnue ${method} ${path}`);
    const params = (route.pattern.exec(path) ?? []).slice(1);
    const init: RequestInit = { method };
    if (body !== undefined || raw !== undefined) {
      init.headers = { 'content-type': 'application/json' };
      init.body = raw ?? JSON.stringify(body);
    }
    const response = await route.handle(s, viewer, params, new Request(`https://api.exemple.test/v1${path}`, init));
    return { status: response.status, body: (await response.json()) as { ok: boolean; mode?: string; data?: any; code?: string; rule?: string | null } };
  };
  const ok = async (viewer: Viewer, method: 'GET' | 'POST', path: string, body?: unknown) => {
    const r = await call(viewer, method, path, body);
    expect(r.status, `${method} ${path} ${JSON.stringify(r.body)}`).toBe(200);
    expect(r.body.mode).toBe('essai');
    return r.body.data;
  };
  /** Les codes de signature du bail rangés dans la boîte d'essai, dans l'ordre. */
  const lastCode = async (): Promise<string> =>
    (await db.all<{ body: string }>(`SELECT m.body FROM messages m JOIN trial_outbox t ON t.message_id = m.id WHERE m.body LIKE '%code de signature du bail%' ORDER BY m.occurred_at, m.created_at`))
      .map((r) => /(\d{6})/.exec(r.body)![1]!)
      .at(-1)!;
  let names = 0;
  /** Un logement de l'agent et son propriétaire, ouverts à la location par les routes. */
  const open = async (city: string, facts: Record<string, unknown>) => {
    const owner = await store.createPerson({ networkId: network.id, agentId: alex.id, firstName: 'Bailleur', lastName: 'Inventé' });
    await store.addIdentifier({ networkId: network.id, personId: owner.id, kind: 'email', value: `bailleur.${uuid()}@example.test` });
    const home = await store.createProperty({ networkId: network.id, agentId: alex.id, reference: `L-${uuid()}`, kind: 'home', postalCode: '21000', city, rooms: 2 });
    const id = (await ok(agent, 'POST', '/location', { propertyId: home.id, ownerPersonId: owner.id })).listingId as string;
    await ok(agent, 'POST', `/location/${id}/faits`, facts);
    return { id, home, owner };
  };
  /** La fiche du bien de M07, pour les dépenses d'énergie de l'annonce. */
  const sheet = async (propertyId: string, energyClass: string) =>
    db.run("INSERT INTO property_sheets (id, property_id, network_id, version, data, created_by, created_at) VALUES (?, ?, ?, 1, ?, 'agent:x', ?)", [
      uuid(),
      propertyId,
      network.id,
      JSON.stringify({
        characteristics: { bedrooms: 1, floor: 2, floorsTotal: 4, buildYear: 1985, heating: 'collectif', outdoor: ['balcon'], landM2: null, parkingSpaces: null, elevator: true },
        energy: { energyClass, climateClass: 'C', annualCostMinEur: 640, annualCostMaxEur: 900, costReferenceYear: 2025, diagnosedOn: '2026-01-10' },
        coownership: null,
        risks: null,
        media: [],
      }),
      new Date(clock).toISOString(),
    ]);

  /**
   * Une mise en location de bout en bout, par les routes : contrôle, honoraires au plafond, annonce validée, candidatures,
   * présentation et choix, bail, signatures du bail, état des lieux signé des deux parties.
   */
  const rent = async (o: { city: string; insee: string; zone: 'tendue' | 'autre' | null; facts: Record<string, unknown>; candidates: number }) => {
    const facts = { ...FACTS, ...o.facts };
    const { id, home, owner } = await open(o.city, facts);
    const status = await ok(agent, 'GET', `/location/${id}`);
    for (const kind of status.required as string[]) await ok(agent, 'POST', `/location/${id}/annexes`, { kind, ref: put(`location/${id}`), diagnosedOn: '2027-07-01' });
    expect((await ok(agent, 'POST', `/location/${id}/controle`)).decision).toBe('louable');
    if (o.zone) await ok(dir, 'POST', '/location/zones', { inseeCode: o.insee, zone: o.zone, effectiveFrom: '2023-08-26', source: 'Liste officielle inventée pour le test' });
    await ok(agent, 'POST', `/location/${id}/commune`, { inseeCode: o.insee });
    const c = await ok(agent, 'GET', `/location/${id}/plafonds`);
    const deposit = c.depositCeilingCents as number;
    const fees = { tenantCents: c.tenantCeilingCents, tenantInventoryCents: c.inventoryCeilingCents, landlordCents: c.tenantCeilingCents, landlordInventoryCents: c.inventoryCeilingCents, depositCents: deposit };
    // Un sou au-dessus du plafond : refusé [R102].
    expect((await call(agent, 'POST', `/location/${id}/honoraires`, { ...fees, tenantCents: fees.tenantCents + 1, landlordCents: fees.tenantCents + 1 })).body.rule).toBe('R102');
    await ok(agent, 'POST', `/location/${id}/honoraires`, fees);
    await sheet(home.id, facts.energyClass as string);
    const ad = await ok(agent, 'POST', `/location/${id}/annonces/brouillon`);
    expect(ad.origin).toBe('secours');
    expect(ad.mentions).toContain(facts.furnished ? 'Location meublée.' : 'Location vide.');
    expect(ad.mentions).toContain('Honoraires à la charge du locataire');
    expect((await ok(agent, 'POST', `/location/annonces/${ad.adId}/validation`)).validatedAt).not.toBeNull();
    // Les candidatures, chacune complète par les seules pièces de la liste officielle ; chaque pièce interdite refusée.
    const apps: string[] = [];
    for (let i = 0; i < o.candidates; i++) {
      const p = await store.createPerson({ networkId: network.id, agentId: alex.id, firstName: NAMES[names++ % NAMES.length]!, lastName: 'Inventé' });
      await store.addIdentifier({ networkId: network.id, personId: p.id, kind: 'email', value: `candidat.${uuid()}@example.test` });
      const a = (await ok(agent, 'POST', `/location/${id}/candidatures`, { personId: p.id })).applicationId as string;
      const prefix = `location/${id}/candidatures/${a}`;
      for (const sort of ['quittances_loyer', 'contrat_travail', 'bulletins_salaire']) await ok(agent, 'POST', `/location/candidatures/${a}/pieces`, { holder: 'candidat', sort, ref: put(prefix), sha256: SHA });
      const bad = await call(agent, 'POST', `/location/candidatures/${a}/pieces`, { holder: 'candidat', sort: FORBIDDEN[i % FORBIDDEN.length], ref: put(prefix), sha256: SHA });
      expect(bad.status).toBeGreaterThanOrEqual(400);
      expect(bad.body.ok).toBe(false);
      apps.push(a);
    }
    // Le propriétaire voit les dossiers complets dans leur ordre d'arrivée, sans note ; son choix est rangé avec sa preuve.
    const presentation = await ok(agent, 'POST', `/location/${id}/presentation`);
    expect(JSON.stringify(presentation)).not.toMatch(/score|note|rang|rank/i);
    const chosen = apps[1]!;
    await ok(agent, 'POST', `/location/${id}/choix`, { presentationId: presentation.presentationId, applicationId: chosen, decidedAt: new Date(clock).toISOString(), channel: 'ecrit', proofRef: put(`location/${id}/choix`) });
    // Le bail, depuis le modèle du type en vigueur.
    const lease = await ok(agent, 'POST', `/location/${id}/bail`, {
      address: '12 allée des Essais',
      ownerAddress: '3 chemin des Exemples, Ailleurs-Essai',
      habitat: 'collectif',
      equipment: 'Cuisine équipée, cave',
      professionalCard: 'CPI 2101 2027 000 000 001',
      noticeRef: put(`location/${id}/bail`),
    });
    expect(lease).toMatchObject({ status: 'complet', mode: 'essai' });
    // La signature en ligne du bail par les deux parties (W12), en essai.
    for (const party of ['bailleur', 'locataire']) {
      const st = await ok(agent, 'POST', `/location/${id}/bail/signatures`, { party, consentProof: 'accord donné au rendez-vous (essai)' });
      const sg = await ok(agent, 'POST', `/location/signatures-bail/${st.sessionId}`, { code: await lastCode(), drawing: DRAW });
      expect(sg).toMatchObject({ party, contentSha256: lease.contentSha256, realSignature: false, bothSigned: party === 'locataire' });
    }
    // L'état des lieux d'entrée, pièce par pièce, signé des deux parties.
    const inventory = await ok(agent, 'POST', `/location/${id}/etat-des-lieux`, {
      address: '12 allée des Essais',
      ownerAddress: '3 chemin des Exemples, Ailleurs-Essai',
      rooms: [
        { name: 'Séjour', elements: [{ name: 'Murs', state: 'bon' }, { name: 'Sol', state: 'usage' }] },
        { name: 'Salle d’eau', elements: [{ name: 'Lavabo', state: 'neuf' }] },
      ],
      meters: [{ kind: 'electricite', index: '012345' }],
      keys: [{ kind: 'Clé de la porte d’entrée', count: 2 }],
      ...(facts.furnished ? { furniture: [{ item: 'Table', count: 1, state: 'bon' }, { item: 'Lit', count: 1, state: 'bon' }] } : {}),
    });
    expect(inventory.status).toBe('complet');
    expect(await ok(agent, 'POST', `/location/etats-des-lieux/${inventory.inventoryId}/signatures`, { party: 'bailleur', contentSha256: inventory.contentSha256, drawing: DRAW })).toMatchObject({ closed: false });
    expect(await ok(agent, 'POST', `/location/etats-des-lieux/${inventory.inventoryId}/signatures`, { party: 'locataire', contentSha256: inventory.contentSha256, drawing: DRAW })).toMatchObject({ closed: true });
    const copies = [await ok(agent, 'GET', `/location/etats-des-lieux/${inventory.inventoryId}/exemplaires/bailleur`), await ok(agent, 'GET', `/location/etats-des-lieux/${inventory.inventoryId}/exemplaires/locataire`)];
    expect(copies[0].contentSha256).toBe(copies[1].contentSha256);
    return { id, fees, ceilings: c, ad, lease, inventory, owner, apps };
  };
  return { db, journal, store, s, agent, other, dir, compliance, call, ok, open, rent, put, sheet };
}

describeWithSqlite('W09 · routes de M15 et parcours de 3 mises en location tests', () => {
  it('[R100] [R101] [R102] [R103] [R104] [R105] [R106] [R108] trois mises en location menées par les routes jusqu’à l’état des lieux signé', async () => {
    const t = await setup();
    await t.ok(t.dir, 'POST', '/location/modeles-bail', { kind: 'bail_vide', body: BODY });
    await t.ok(t.dir, 'POST', '/location/modeles-bail', { kind: 'bail_meuble', body: BODY });
    // 1. Un logement vide en zone tendue : 10 € par m² et 3 € pour l'état des lieux, sur 42,50 m².
    const vide = await t.rent({ city: 'Tendue-Essai', insee: '21901', zone: 'tendue', facts: {}, candidates: 7 });
    expect(vide.ceilings).toMatchObject({ zone: 'tendue', tenantCeilingCents: 42_500, inventoryCeilingCents: 12_750, depositCeilingCents: 65_000 });
    // 2. Un meublé hors zone : 8 € par m², dépôt de deux mois au plus.
    const meuble = await t.rent({ city: 'Calme-Essai', insee: '21902', zone: 'autre', facts: { furnished: true }, candidates: 7 });
    expect(meuble.ceilings).toMatchObject({ zone: 'autre', tenantCeilingCents: 34_000, depositCeilingCents: 130_000 });
    expect(meuble.lease.content).toContain('location meublée');
    // 3. Un logement classé F dont le bail commence avant 2028 : encore louable, mention de consommation excessive.
    const f = await t.rent({ city: 'Ancien-Essai', insee: '21903', zone: null, facts: { energyClass: 'F', finalEnergyKwh: 380, leaseStart: '2027-10-01' }, candidates: 6 });
    expect(f.ad.mentions).toContain('Logement à consommation énergétique excessive.');
    // Honoraires sous le plafond, jamais au-dessus de la part du bailleur [R102].
    for (const r of [vide, meuble, f]) {
      expect(r.fees.tenantCents).toBeLessThanOrEqual(r.ceilings.tenantCeilingCents);
      expect(r.fees.tenantCents).toBeLessThanOrEqual(r.fees.landlordCents);
    }
    // 20 candidatures inventées, aucune pièce interdite rangée [R104].
    const pieces = await t.db.all<{ sort: string }>('SELECT sort FROM rental_application_pieces');
    expect(new Set([...vide.apps, ...meuble.apps, ...f.apps]).size).toBe(20);
    expect(pieces).toHaveLength(60);
    for (const p of pieces) expect(Object.keys(OFFICIAL_PIECES)).toContain(p.sort);
    // La signature d'essai du bail ne rend jamais un bail signé réel : la remise des clés l'attend [R108, R107].
    expect(await t.call(t.agent, 'POST', `/location/${vide.id}/remise-des-cles`, { handedOn: '2027-07-12' })).toEqual({ status: 409, body: { ok: false, rule: 'R107', code: 'lease_not_signed' } });
    expect((await t.ok(t.agent, 'GET', `/location/${vide.id}/honoraires-dus`)).due).toBe(false);
    // Rien n'est parti réellement : tout envoi est dans la boîte d'essai.
    expect(await t.db.first<{ n: number }>("SELECT COUNT(*) AS n FROM messages m WHERE m.direction = 'out' AND m.id NOT IN (SELECT message_id FROM trial_outbox)")).toEqual({ n: 0 });
  });

  it('[R100] un logement classé G est bloqué avant toute annonce', async () => {
    const t = await setup();
    const { id, home } = await t.open('Froid-Essai', { ...FACTS, energyClass: 'G', finalEnergyKwh: 400 });
    const status = await t.ok(t.agent, 'GET', `/location/${id}`);
    for (const kind of status.required as string[]) await t.ok(t.agent, 'POST', `/location/${id}/annexes`, { kind, ref: t.put(`location/${id}`), diagnosedOn: '2027-07-01' });
    expect(await t.ok(t.agent, 'POST', `/location/${id}/controle`)).toMatchObject({ decision: 'bloque', reasons: [{ code: 'energy_class', energyClass: 'G' }] });
    await t.ok(t.agent, 'POST', `/location/${id}/commune`, { inseeCode: '21904' });
    await t.sheet(home.id, 'G');
    expect(await t.call(t.agent, 'POST', `/location/${id}/annonces/brouillon`)).toMatchObject({ status: 409, body: { ok: false, rule: 'R100' } });
    expect(await t.call(t.agent, 'POST', `/location/${id}/annonces`, { title: 'Deux pièces', body: 'Logement lumineux.' })).toMatchObject({ status: 409, body: { ok: false } });
    expect(await t.db.all('SELECT 1 FROM rental_ads')).toHaveLength(0);
    // Le propriétaire a son échéance, préparée en essai.
    expect((await t.ok(t.agent, 'GET', `/location/${id}/echeances`)).length).toBeGreaterThan(0);
  });

  it('[R16] chaque route contrôle le rôle avant le corps ; un refus est au journal ; un autre agent est refusé', async () => {
    const t = await setup();
    const { id } = await t.open('Garde-Essai', FACTS);
    // Un corps illisible n'est même pas lu : le rôle est refusé d'abord.
    const before = (await t.journal.all()).filter((e) => e.type === 'acces.refuse').length;
    for (const [viewer, method, path] of [
      [t.compliance, 'POST', `/location/${id}/faits`],
      [t.compliance, 'POST', `/location/${id}/bail`],
      [t.agent, 'POST', '/location/modeles-bail'],
      [t.agent, 'POST', '/location/zones'],
      [t.dir, 'POST', '/location/modeles-bail/abc/validation'],
      [t.compliance, 'GET', `/location/${id}/baux/abc/exemplaire`],
      [{ role: 'partner', userId: 'p-1', networkId: t.agent.networkId } as Viewer, 'GET', `/location/${id}`],
    ] as const) {
      const r = await t.call(viewer, method, path, undefined, method === 'POST' ? '{pas du json' : undefined);
      expect(r, `${viewer.role} ${path}`).toEqual({ status: 403, body: { ok: false, rule: 'R16', code: 'role' } });
    }
    const after = (await t.journal.all()).filter((e) => e.type === 'acces.refuse');
    expect(after.length - before).toBe(7);
    expect(JSON.stringify(after)).not.toContain(id);
    // Un autre agent : refusé par la couche métier, au journal.
    expect(await t.call(t.other, 'GET', `/location/${id}`)).toMatchObject({ status: 403, body: { rule: 'R16', code: 'not_assigned' } });
    expect(await t.call(t.other, 'POST', `/location/${id}/faits`, FACTS)).toMatchObject({ status: 403, body: { rule: 'R16' } });
    // La conformité lit l'état, n'écrit rien.
    expect((await t.call(t.compliance, 'GET', `/location/${id}`)).status).toBe(200);
    // Un corps qui n'est pas du JSON, pour un rôle admis : 400.
    expect(await t.call(t.agent, 'POST', `/location/${id}/faits`, undefined, '{pas du json')).toEqual({ status: 400, body: { ok: false, rule: null, code: 'invalid_body' } });
    // Une mise en location inconnue : 404.
    expect((await t.call(t.agent, 'GET', '/location/inconnue')).status).toBe(404);
  });

  it('[R16] chaque route refuse tout rôle non admis avant de lire le corps, au journal sans identifiant ; jamais un partenaire', async () => {
    const t = await setup();
    const routes = locationRoutes();
    const roles: V['role'][] = ['agent', 'direction', 'compliance', 'partner'];
    const roleOf = (name: string) => routes.find((r) => r.name === name)!.roles;
    expect(roleOf('location.zone')).toEqual(['direction']);
    expect(roleOf('location.modele_bail')).toEqual(['direction']);
    expect(roleOf('location.modele_bail.validation')).toEqual(['compliance']);
    expect(roleOf('location.annonce.validation')).toEqual(['agent']);
    let refused = 0;
    const before = (await t.journal.all()).filter((e) => e.type === 'acces.refuse').length;
    for (const route of routes) {
      expect(route.roles, route.name).not.toContain('partner');
      const path = route.pattern.source
        .replace(/^\^/, '')
        .replace(/\$$/, '')
        .replace(/\(\[A-Za-z0-9_-\]\{1,64\}\)/g, 'cle-piege')
        .replace('(bailleur|locataire)', 'bailleur')
        .replace(/\\\//g, '/');
      expect(path, route.name).toMatch(/^\/location[a-z0-9/_-]*$/);
      for (const role of roles) {
        if (route.roles.includes(role)) continue;
        const viewer = { role, userId: 'u-1', networkId: t.agent.networkId } as V;
        const init: RequestInit = { method: route.method };
        if (route.method === 'POST') {
          init.headers = { 'content-type': 'application/json' };
          init.body = JSON.stringify({ piege: true });
        }
        const request = new Request(`https://api.exemple.test/v1${path}`, init);
        const response = await route.handle(t.s, viewer, (route.pattern.exec(path) ?? []).slice(1), request);
        expect(response.status, `${role} ${route.name}`).toBe(403);
        expect(await response.json()).toEqual({ ok: false, rule: 'R16', code: 'role' });
        expect(request.bodyUsed, `${role} ${route.name}`).toBe(false);
        refused++;
      }
    }
    const after = (await t.journal.all()).filter((e) => e.type === 'acces.refuse').slice(before);
    expect(after).toHaveLength(refused);
    expect(refused).toBeGreaterThan(routes.length);
    expect(JSON.stringify(after)).not.toContain('cle-piege');
  });

  it('[R16] [R105] W11 : les lectures de l’écran « Louer » rendent la liste de l’agent, l’avancée et la présentation, sans nom ni note', async () => {
    const t = await setup();
    await t.ok(t.dir, 'POST', '/location/modeles-bail', { kind: 'bail_vide', body: BODY });
    const second = await t.open('Deux-Essai', FACTS);
    const r = await t.rent({ city: 'Tendue-Essai', insee: '21901', zone: 'tendue', facts: {}, candidates: 3 });
    // L'agent voit ses deux logements, dans leur ordre d'ouverture ; un autre agent n'en voit aucun.
    const mine = await t.ok(t.agent, 'GET', '/location');
    expect(mine.listings.map((l: { listingId: string }) => l.listingId)).toEqual([second.id, r.id]);
    expect(mine.listings[1]).toMatchObject({ city: 'Tendue-Essai', decision: 'louable' });
    expect(mine.listings[0].decision).toBeNull();
    expect(mine.more).toBe(false);
    expect((await t.ok(t.other, 'GET', '/location')).listings).toEqual([]);
    expect((await t.ok(t.dir, 'GET', '/location')).listings).toHaveLength(2);
    const list = locationRoutes().find((x) => x.name === 'location.liste')!;
    expect((await list.handle(t.s, t.agent, [], new Request('https://api.exemple.test/v1/location?page=x'))).status).toBe(400);
    expect(((await (await list.handle(t.s, t.agent, [], new Request('https://api.exemple.test/v1/location?page=1'))).json()) as { data: unknown }).data).toEqual({ listings: [], page: 1, more: false });
    // L'avancée : faits, honoraires, bail signé des deux parties (essai), état des lieux clos.
    const p = await t.ok(t.agent, 'GET', `/location/${r.id}/suivi`);
    expect(p.facts.rentCents).toBe(FACTS.rentCents);
    expect(p.fees).toEqual({ tenantCents: r.fees.tenantCents, tenantInventoryCents: r.fees.tenantInventoryCents, landlordCents: r.fees.landlordCents, landlordInventoryCents: r.fees.landlordInventoryCents, depositCents: r.fees.depositCents });
    expect(p.lease).toMatchObject({ leaseId: r.lease.leaseId, mode: 'essai', complete: true });
    expect(p.lease.bailleur).not.toBeNull();
    expect(p.lease.locataire).not.toBeNull();
    expect(p.inventoryClosed).toBe(true);
    expect((await t.ok(t.agent, 'GET', `/location/${second.id}/suivi`)).lease).toBeNull();
    // La présentation telle qu'elle a été faite : les dossiers dans l'ordre d'arrivée, le choix du propriétaire.
    const pres = await t.ok(t.agent, 'GET', `/location/${r.id}/presentation`);
    expect(pres.presentation.files.map((f: { applicationId: string }) => f.applicationId)).toEqual(r.apps);
    expect(pres.presentation.files.map((f: { arrival: number }) => f.arrival)).toEqual([1, 2, 3]);
    expect(pres.chosenApplicationId).toBe(r.apps[1]);
    expect((await t.ok(t.agent, 'GET', `/location/${second.id}/presentation`)).presentation).toBeNull();
    // Rien d'une personne ni d'une note : ni prénom, ni nom, ni identifiant de personne.
    const text = JSON.stringify([mine, p, pres]);
    expect(text).not.toMatch(/Ambre|Basile|Céleste|Inventé|Bailleur|personId|\b(?:score|note|rang|rank)\b/);
    // Un autre agent est refusé et le refus est au journal ; chaque lecture de l'agent l'est aussi [R16].
    for (const path of [`/location/${r.id}/suivi`, `/location/${r.id}/presentation`]) expect((await t.call(t.other, 'GET', path)).status).toBe(403);
    const reads = await t.db.all<{ data: string }>("SELECT data FROM journal WHERE type = 'location.lue'");
    for (const what of ['listings', 'progress', 'presentation']) expect(reads.some((e) => JSON.parse(e.data).what === what)).toBe(true);
  });
});
