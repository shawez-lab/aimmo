import { expect, it } from 'vitest';
import { FicheClient, SqlJournalStore, applyMigrations, fromSyncSqlite, type SqlDatabase, type Viewer } from '@aimmo/core';
import { investirRoutes, type InvestirServices } from '../src/investir.ts';
import { locationRoutes, type LocationServices } from '../src/location.ts';
import { partenairesRoutes, type PartenairesServices } from '../src/partenaires.ts';
import { CASES } from '../../core/test/investir-jeu.ts';
import { loadMigrations } from '../../core/test/migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from '../../core/test/sqlite.ts';

// Réseau, agents, investisseurs, biens et communes inventés. Le 14 septembre 2027 est un mardi.
const START = Date.parse('2027-09-14T08:00:00.000Z');
const euros = (cents: number): string => {
  const whole = Math.floor(cents / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return cents % 100 === 0 ? whole : `${whole},${String(cents % 100).padStart(2, '0')}`;
};
const pct = (bp: number): string => `${Math.floor(bp / 100)},${String(bp % 100).padStart(2, '0')} %`;

async function setup() {
  let clock = START;
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  const now = (): Date => new Date((clock += 1000));
  const journal = new SqlJournalStore(db);
  const store = new FicheClient(db, { now });
  const network = await store.createNetwork('Réseau Essai');
  const alex = await store.createAgent({ networkId: network.id, firstName: 'Alex', lastName: 'Essai' });
  const bea = await store.createAgent({ networkId: network.id, firstName: 'Béa', lastName: 'Essai' });
  const agent: Viewer = { role: 'agent', userId: alex.id, networkId: network.id };
  const other: Viewer = { role: 'agent', userId: bea.id, networkId: network.id };
  const dir: Viewer = { role: 'direction', userId: 'dir-1', networkId: network.id };
  const compliance: Viewer = { role: 'compliance', userId: 'conf-1', networkId: network.id };
  const partner: Viewer = { role: 'partner', userId: 'part-1', networkId: network.id };
  const s: InvestirServices = { db, journal, now };
  const routes = investirRoutes();
  const call = async (viewer: Viewer, method: 'GET' | 'POST', path: string, body?: unknown, raw?: string) => {
    const route = routes.find((r) => r.method === method && r.pattern.test(path.split('?')[0]!));
    if (!route) throw new Error(`route inconnue ${method} ${path}`);
    const params = (route.pattern.exec(path.split('?')[0]!) ?? []).slice(1);
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
  return { db, journal, store, network, alex, agent, other, dir, compliance, partner, s, routes, call, ok, now };
}

const SAMPLE_PATHS: Record<string, string> = {
  'investir.projets': '/investir/projets',
  'investir.biens': '/investir/biens',
  'investir.profil.lu': '/investir/projets/p1/profil',
  'investir.profil': '/investir/projets/p1/profil',
  'investir.loyers.import': '/investir/loyers',
  'investir.loyers.lu': '/investir/loyers?insee=99001',
  'investir.regle': '/investir/regles',
  'investir.bien.commune': '/investir/biens/b1/commune',
  'investir.contraintes': '/investir/biens/b1/contraintes',
  'investir.calcul': '/investir/calculs',
  'investir.calcul.lu': '/investir/calculs/c1',
  'investir.note': '/investir/notes',
  'investir.note.lue': '/investir/notes/n1',
  'investir.note.validation': '/investir/notes/n1/validation',
  'investir.alertes': '/investir/biens/b1/alertes',
};

describeWithSqlite('Y07 · routes de M17', () => {
  it('[R16] chaque route refuse tout rôle non admis avant de lire le corps, et l’écrit au journal', async () => {
    const t = await setup();
    const viewers = [t.agent, t.dir, t.compliance, t.partner];
    expect(Object.keys(SAMPLE_PATHS).sort()).toEqual(t.routes.map((r) => r.name).sort());
    for (const route of t.routes) {
      for (const v of viewers.filter((x) => !route.roles.includes(x.role))) {
        // Un corps illisible : un refus de rôle passe avant, en 403, jamais en 400.
        const r = await t.call(v, route.method, SAMPLE_PATHS[route.name]!, undefined, route.method === 'POST' ? '{pas du json' : undefined);
        expect(r.status, `${route.name} ${v.role}`).toBe(403);
        expect(r.body).toEqual({ ok: false, rule: 'R16', code: 'role' });
      }
    }
    const refused = (await t.journal.all()).filter((e) => e.type === 'acces.refuse' && (e.data as { code: string }).code === 'role');
    expect(refused.length).toBeGreaterThanOrEqual(13);
    expect(t.routes.find((r) => r.name === 'investir.note.validation')!.roles).toEqual(['agent']);
    expect(t.routes.find((r) => r.name === 'investir.loyers.import')!.roles).toEqual(['direction']);
  });

  it('[R120] [R126] parcours de 10 biens tests : rendements du calcul manuel, note avec sources et hypothèses, validée par l’agent', async () => {
    const t = await setup();
    // Les loyers de marché des 10 communes inventées, importés par la direction au format de l'ANIL.
    const rows = CASES.map((c, i) => `${String(99001 + i)};${euros(c.inputs.rent[0])};${euros(c.inputs.rent[1])};${euros(c.inputs.rent[2])};120`);
    const imported = await t.ok(t.dir, 'POST', '/investir/loyers', { kind: 'apartment', vintage: 2026, csv: ['INSEE_C;loypredm2;lwr.IPm2;upr.IPm2;nbobs_com', ...rows].join('\n') });
    expect(imported).toMatchObject({ rows: 10, status: 'complet' });

    for (const [i, c] of CASES.entries()) {
      const insee = String(99001 + i);
      const person = await t.store.createPerson({ networkId: t.network.id, agentId: t.alex.id, firstName: `Investisseur${'abcdefghij'[i]}` });
      const project = await t.store.createProject({ networkId: t.network.id, agentId: t.alex.id, personId: person.id, kind: 'invest' });
      const property = await t.store.createProperty({
        networkId: t.network.id,
        agentId: t.alex.id,
        reference: `INV-${'abcdefghij'[i]}`,
        kind: 'home',
        city: 'Commune test',
        priceEur: c.inputs.price / 100,
        surfaceM2: c.inputs.area / 100,
        rooms: 2,
        status: 'available',
      });
      await t.ok(t.agent, 'POST', `/investir/projets/${project.id}/profil`, { changes: { rentalTarget: 'unfurnished', sectors: [insee], budgetCents: c.inputs.price * 2 }, from: 'client_dit' });
      await t.ok(t.agent, 'POST', `/investir/biens/${property.id}/commune`, { inseeCode: insee, rentKind: 'apartment' });
      const said = (value: number, hypothesis: string) => ({ value, source: 'agent', asOf: '2027-09-01', hypothesis });
      const calc = await t.ok(t.agent, 'POST', '/investir/calculs', {
        propertyId: property.id,
        projectId: project.id,
        marketRentQuery: { inseeCode: insee, kind: 'apartment' },
        inputs: {
          acquisitionFeesRateBp: said(c.inputs.rate, 'barème des frais d’acquisition'),
          works: said(c.inputs.works, 'devis estimé'),
          nonRecoverableCharges: said(c.inputs.charges, 'déclarées par le vendeur'),
          propertyTax: said(c.inputs.tax, 'avis de taxe foncière déclaré'),
          vacancyMonths: said(c.inputs.vacancy, 'vacance réglée'),
        },
      });
      expect(calc.result.status, `bien ${i + 1}`).toBe('complet');
      expect([calc.result.grossYieldBp.low, calc.result.grossYieldBp.central, calc.result.grossYieldBp.high], `bien ${i + 1}`).toEqual(c.expected.gross);
      expect([calc.result.netYieldBp.low, calc.result.netYieldBp.central, calc.result.netYieldBp.high], `bien ${i + 1}`).toEqual(c.expected.net);
      expect(calc.result.lines.find((l: { key: string }) => l.key === 'totalCost').value).toBe(c.expected.totalCost);
      // Relu par la route, le même calcul.
      expect((await t.ok(t.agent, 'GET', `/investir/calculs/${calc.id}`)).result).toEqual(calc.result);

      const note = await t.ok(t.agent, 'POST', '/investir/notes', { calculationId: calc.id, projectId: project.id, energy: { energyClass: 'C' } });
      const text: string = note.text;
      expect(text, `bien ${i + 1}`).toContain(`Rendement brut : ${pct(c.expected.gross[1])} (de ${pct(c.expected.gross[0])} à ${pct(c.expected.gross[2])}`);
      expect(text).toContain('Sources et hypothèses :');
      for (const key of ['Prix d’achat', 'Surface habitable', 'Loyer de marché au m²', 'Travaux estimés', 'Vacance', 'Taxe foncière par an']) {
        expect(text, `${key} bien ${i + 1}`).toMatch(new RegExp(`- ${key} : .+\\. Source : .+, au \\d{2}/\\d{2}/\\d{4}\\. Hypothèse : .+\\.`));
      }
      // Avant validation, rien pour le client ; l'agent valide le texte qu'il a lu.
      const sha = (await t.db.first<{ text_sha256: string }>('SELECT text_sha256 FROM investment_notes WHERE id = ?', [note.id]))!.text_sha256;
      expect((await t.call(t.other, 'POST', `/investir/notes/${note.id}/validation`, { textSha256: sha, energy: { energyClass: 'C' } })).status).toBe(403);
      const validated = await t.ok(t.agent, 'POST', `/investir/notes/${note.id}/validation`, { textSha256: sha, energy: { energyClass: 'C' } });
      expect(validated.status).toBe('validee');
    }
    expect(Number((await t.db.first<{ n: number }>("SELECT count(*) AS n FROM investment_notes WHERE status = 'validee'"))!.n)).toBe(10);
  });

  it('[R124] [R16] contraintes : alerte en tête pour un bien interdit, sous les droits du bien et de la fiche', async () => {
    const t = await setup();
    const person = await t.store.createPerson({ networkId: t.network.id, agentId: t.alex.id, firstName: 'Inès' });
    const project = await t.store.createProject({ networkId: t.network.id, agentId: t.alex.id, personId: person.id, kind: 'invest' });
    await t.ok(t.agent, 'POST', `/investir/projets/${project.id}/profil`, { changes: { rentalTarget: 'furnished' } });
    const property = await t.store.createProperty({ networkId: t.network.id, agentId: t.alex.id, reference: 'G-1', kind: 'home', city: 'X', priceEur: 90_000, surfaceM2: 30, rooms: 1, status: 'draft' });
    const set = await t.ok(t.agent, 'POST', `/investir/biens/${property.id}/contraintes`, { projectId: project.id, energyClass: 'G' });
    expect(set.rentalBan).toBe(true);
    expect(set.alertsFirst[0]).toMatch(/^Interdit à la location/);
    // Un autre agent ne voit ni le bien hors fichier commun, ni la fiche.
    expect((await t.call(t.other, 'POST', `/investir/biens/${property.id}/contraintes`, { projectId: project.id, energyClass: 'G' })).status).toBe(403);
    expect((await t.call(t.agent, 'POST', `/investir/biens/${property.id}/contraintes`, { finalEnergyKwh: -2 })).body).toMatchObject({ code: 'consommation' });
  });

  it('[R122] un loyer de marché saisi est refusé ; sans donnée, la lecture dit « inconnu »', async () => {
    const t = await setup();
    expect(await t.ok(t.agent, 'GET', '/investir/loyers?insee=99001&type=apartment')).toEqual({ status: 'inconnu', inseeCode: '99001', kind: 'apartment' });
    const r = await t.call(t.agent, 'POST', '/investir/calculs', {
      inputs: { marketRent: { value: { centralM2Cents: 2000, lowerM2Cents: 1500, upperM2Cents: 2500 }, source: 'ANIL', asOf: '2027-01-01', hypothesis: 'h' } },
    });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ ok: false, rule: 'R122', code: 'loyer_saisi' });
  });

  it('après l’achat : la mise en location de M15 et les partenaires de M18 par leurs routes existantes', async () => {
    const t = await setup();
    const person = await t.store.createPerson({ networkId: t.network.id, agentId: t.alex.id, firstName: 'Inès' });
    await t.store.createProject({ networkId: t.network.id, agentId: t.alex.id, personId: person.id, kind: 'invest' });
    const property = await t.store.createProperty({ networkId: t.network.id, agentId: t.alex.id, reference: 'A-1', kind: 'home', city: 'X', priceEur: 90_000, surfaceM2: 30, rooms: 1, status: 'sold' });
    const ls: LocationServices = { db: t.db, journal: t.journal, now: t.now, files: { has: async () => false }, identity: { state: async () => ({ identityVerifiedOn: null }) } };
    const create = locationRoutes().find((r) => r.name === 'location.creation')!;
    const res = await create.handle(ls, t.agent, [], new Request('https://api.exemple.test/v1/location', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ propertyId: property.id, ownerPersonId: person.id }) }));
    expect(res.status, await res.clone().text()).toBe(200);
    const ps: PartenairesServices = { db: t.db, journal: t.journal, now: t.now, files: { has: async () => false } as unknown as PartenairesServices['files'] };
    const search = partenairesRoutes().find((r) => r.name === 'partenaires.annuaire.recherche')!;
    const found = await search.handle(ps, t.agent, [], new Request('https://api.exemple.test/v1/partenaires/annuaire?metier=gestionnaire&cp=21000'));
    expect(found.status).toBe(200);
  });
});

it('les routes de M17 vivent sous /investir et ne rendent jamais un chiffre calculé ailleurs que dans le code du serveur', () => {
  for (const r of investirRoutes()) expect(r.pattern.source.startsWith('^\\/investir')).toBe(true);
});

describeWithSqlite('Y07 · relecture d’un calcul', () => {
  it('[R16] un calcul ne se relit plus quand son bien sort du fichier commun, même pour le projet de l’agent', async () => {
    const t = await setup();
    await t.ok(t.dir, 'POST', '/investir/loyers', { kind: 'apartment', vintage: 2026, csv: 'INSEE_C;loypredm2;lwr.IPm2;upr.IPm2;nbobs_com\n99001;12,35;10,10;15,01;120' });
    const person = await t.store.createPerson({ networkId: t.network.id, agentId: t.other.userId, firstName: 'Noé' });
    const project = await t.store.createProject({ networkId: t.network.id, agentId: t.other.userId, personId: person.id, kind: 'invest' });
    const property = await t.store.createProperty({ networkId: t.network.id, agentId: t.alex.id, reference: 'S-1', kind: 'home', city: 'X', priceEur: 150_000, surfaceM2: 45, rooms: 2, status: 'available' });
    const said = (value: number) => ({ value, source: 'agent', asOf: '2027-09-01', hypothesis: 'saisi' });
    const calc = await t.ok(t.other, 'POST', '/investir/calculs', {
      propertyId: property.id,
      projectId: project.id,
      marketRentQuery: { inseeCode: '99001', kind: 'apartment' },
      inputs: { acquisitionFeesRateBp: said(750), works: said(0), nonRecoverableCharges: said(60_000), propertyTax: said(90_000), vacancyMonths: said(1) },
    });
    expect((await t.call(t.other, 'GET', `/investir/calculs/${calc.id}`)).status).toBe(200);
    const note = await t.ok(t.other, 'POST', '/investir/notes', { calculationId: calc.id, projectId: project.id, energy: { energyClass: 'C' } });
    expect((await t.call(t.other, 'GET', `/investir/notes/${note.id}`)).status).toBe(200);
    await t.db.run("UPDATE properties SET status = 'sold' WHERE id = ?", [property.id]);
    expect((await t.call(t.other, 'GET', `/investir/calculs/${calc.id}`)).status).toBe(403);
    // La note du calcul non plus, ni sa validation.
    expect((await t.call(t.other, 'GET', `/investir/notes/${note.id}`)).status).toBe(403);
    expect((await t.call(t.other, 'POST', `/investir/notes/${note.id}/validation`, { textSha256: note.textSha256 })).status).toBe(403);
  });
});

describeWithSqlite('Y09 · listes de l’écran « Investir »', () => {
  it('[R16] les investisseurs suivis et les biens calculables, sous les droits de l’agent, lectures au journal', async () => {
    const t = await setup();
    const mine = await t.store.createPerson({ networkId: t.network.id, agentId: t.alex.id, firstName: 'Inès' });
    const theirs = await t.store.createPerson({ networkId: t.network.id, agentId: t.other.userId, firstName: 'Noé' });
    const p1 = await t.store.createProject({ networkId: t.network.id, agentId: t.alex.id, personId: mine.id, kind: 'invest' });
    await t.store.createProject({ networkId: t.network.id, agentId: t.other.userId, personId: theirs.id, kind: 'invest' });
    await t.store.createProject({ networkId: t.network.id, agentId: t.alex.id, personId: mine.id, kind: 'buy' });
    const list = await t.ok(t.agent, 'GET', '/investir/projets');
    expect(list.map((x: { projectId: string }) => x.projectId)).toEqual([p1.id]);
    expect(list[0]).toMatchObject({ firstName: 'Inès', profile: null });
    // Biens : le sien, celui du fichier commun ; pas le brouillon d'un autre ; jamais sans commune rangée.
    const own = await t.store.createProperty({ networkId: t.network.id, agentId: t.alex.id, reference: 'A', kind: 'home', city: 'X', priceEur: 100_000, surfaceM2: 40, rooms: 2, status: 'draft' });
    const shared = await t.store.createProperty({ networkId: t.network.id, agentId: t.other.userId, reference: 'B', kind: 'home', city: 'X', priceEur: 120_000, surfaceM2: 50, rooms: 2, status: 'available' });
    const hidden = await t.store.createProperty({ networkId: t.network.id, agentId: t.other.userId, reference: 'C', kind: 'home', city: 'X', priceEur: 130_000, surfaceM2: 60, rooms: 3, status: 'draft' });
    const bare = await t.store.createProperty({ networkId: t.network.id, agentId: t.alex.id, reference: 'D', kind: 'home', city: 'X', priceEur: 90_000, surfaceM2: 30, rooms: 1, status: 'draft' });
    await t.ok(t.agent, 'POST', `/investir/biens/${own.id}/commune`, { inseeCode: '99001', rentKind: 'apartment' });
    await t.ok(t.dir, 'POST', `/investir/biens/${shared.id}/commune`, { inseeCode: '99002', rentKind: 'house' });
    await t.ok(t.dir, 'POST', `/investir/biens/${hidden.id}/commune`, { inseeCode: '99003', rentKind: 'house' });
    const biens = await t.ok(t.agent, 'GET', '/investir/biens');
    expect(biens.map((b: { propertyId: string }) => b.propertyId).sort()).toEqual([own.id, shared.id].sort());
    expect(biens.find((b: { propertyId: string }) => b.propertyId === own.id)).toMatchObject({ priceCents: 10_000_000, surfaceHundredths: 4000, inseeCode: '99001', rentKind: 'apartment' });
    expect(biens.some((b: { propertyId: string }) => b.propertyId === bare.id)).toBe(false);
    expect((await t.journal.all()).filter((e) => e.type === 'bien.lu').length).toBeGreaterThanOrEqual(2);
    // Un agent au dossier incomplet ne voit que le fichier commun [R82].
    await t.db.exec('PRAGMA foreign_keys = OFF');
    await t.db.run("INSERT INTO agent_onboardings (agent_id, network_id, candidate_id, created_by, created_at) VALUES (?, ?, 'cand-1', 'direction:dir-1', '2027-09-01')", [t.alex.id, t.network.id]);
    await t.db.exec('PRAGMA foreign_keys = ON');
    const restricted = await t.ok(t.agent, 'GET', '/investir/biens');
    expect(restricted.map((b: { propertyId: string }) => b.propertyId)).toEqual([shared.id]);
  });
});

describeWithSqlite('Y09 · listes longues de l’écran « Investir »', () => {
  it('[R16] un agent qui suit plus de 100 fiches lit ses investisseurs, et ses biens restent dans la liste malgré un fichier commun plein', async () => {
    const t = await setup();
    let last = '';
    for (let i = 0; i < 120; i++) {
      const person = await t.store.createPerson({ networkId: t.network.id, agentId: t.alex.id, firstName: `Fiche${i}` });
      if (i === 119) last = (await t.store.createProject({ networkId: t.network.id, agentId: t.alex.id, personId: person.id, kind: 'invest' })).id;
    }
    const list = await t.ok(t.agent, 'GET', '/investir/projets');
    expect(list.map((x: { projectId: string }) => x.projectId)).toEqual([last]);
    const own = await t.store.createProperty({ networkId: t.network.id, agentId: t.alex.id, reference: 'MIEN', kind: 'home', city: 'X', priceEur: 100_000, surfaceM2: 40, rooms: 2, status: 'draft' });
    await t.ok(t.agent, 'POST', `/investir/biens/${own.id}/commune`, { inseeCode: '99001', rentKind: 'apartment' });
    for (let i = 0; i < 105; i++) {
      const p = await t.store.createProperty({ networkId: t.network.id, agentId: t.other.userId, reference: `C${i}`, kind: 'home', city: 'X', priceEur: 120_000, surfaceM2: 50, rooms: 2, status: 'available' });
      await t.ok(t.dir, 'POST', `/investir/biens/${p.id}/commune`, { inseeCode: '99002', rentKind: 'house' });
    }
    await t.db.run("UPDATE properties SET updated_at = '2000-01-01T00:00:00.000Z' WHERE id = ?", [own.id]);
    const biens = await t.ok(t.agent, 'GET', '/investir/biens');
    expect(biens.some((b: { propertyId: string }) => b.propertyId === own.id)).toBe(true);
    expect(biens.length).toBe(101);
  });
});
