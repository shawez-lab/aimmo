import { expect, it } from 'vitest';
import { FicheClient, SqlJournalStore, applyMigrations, fromSyncSqlite, type SqlDatabase } from '@aimmo/core';
import { handleRequest, type ApiConfig } from '../src/app.ts';
import { sha256Hex } from '../src/index.ts';
import { neufViagerRoutes } from '../src/neuf-viager.ts';
import { loadMigrations } from '../../core/test/migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from '../../core/test/sqlite.ts';

// Réseau, agents, clients, promoteur, expert, table d'espérance et clés inventés.
const BASE = 'https://aimmo-api.example.test';
const KEY = (who: string): string => `test-cle-br75-${who}-${'x'.repeat(32)}`;
type Who = 'dir' | 'alex' | 'sam' | 'conf';

async function setup() {
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  let clock = Date.parse('2027-03-01T10:00:00.000Z');
  const now = (): Date => new Date((clock += 1_000));
  const setDay = (iso: string) => (clock = Date.parse(iso));
  const journal = new SqlJournalStore(db);
  const store = new FicheClient(db, { now });
  const network = (await store.createNetwork('Réseau test')).id;
  const alex = (await store.createAgent({ networkId: network, firstName: 'Alex', lastName: 'Agent' })).id;
  const sam = (await store.createAgent({ networkId: network, firstName: 'Sam', lastName: 'Agent' })).id;
  const seller = (await store.createPerson({ networkId: network, agentId: alex, firstName: 'Léa', lastName: 'Exemple' })).id;
  const project = (await store.createProject({ networkId: network, agentId: alex, personId: seller, kind: 'sell' })).id;
  const property = (await store.createProperty({ networkId: network, agentId: alex, reference: 'V-1', kind: 'home', postalCode: '21000' })).id;
  await store.linkProjectProperty({ networkId: network, agentId: alex, projectId: project, propertyId: property, role: 'owned' });
  const refs = new Set<string>();
  const files = { has: async (r: string) => refs.has(r), put: async (r: string) => void refs.add(r) };
  const ids: Record<Who, { role: string; userId: string }> = {
    dir: { role: 'direction', userId: 'dir-1' },
    alex: { role: 'agent', userId: alex },
    sam: { role: 'agent', userId: sam },
    conf: { role: 'compliance', userId: 'conf-1' },
  };
  const apiKeys = JSON.stringify(await Promise.all((Object.keys(ids) as Who[]).map(async (w) => ({ sha256: await sha256Hex(KEY(w)), networkId: network, ...ids[w] }))));
  const config = (over: Partial<ApiConfig> = {}): ApiConfig => ({ db, apiKeys, mode: 'essai', now, partenaires: { files }, ...over });
  const call = async (who: Who, method: string, path: string, body?: unknown, over: Partial<ApiConfig> = {}, rawBody?: string) => {
    const headers: Record<string, string> = { authorization: `Bearer ${KEY(who)}` };
    if (body !== undefined || rawBody !== undefined) headers['content-type'] = 'application/json';
    const payload = rawBody ?? (body === undefined ? undefined : JSON.stringify(body));
    const r = await handleRequest(new Request(`${BASE}/v1${path}`, { method, headers, ...(payload === undefined ? {} : { body: payload }) }), config(over));
    return { status: r.status, body: (await r.json()) as { ok: boolean; data?: any; rule?: string | null; code?: string; field?: string } };
  };
  const partner = async (trade: string, name: string) => {
    const id = crypto.randomUUID();
    await db.run('INSERT INTO partners (id, network_id, trade, business_name, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)', [id, network, trade, name, 'direction:dir-1', new Date(clock).toISOString()]);
    return id;
  };
  const count = async (table: string) => Number((await db.first<{ n: number }>(`SELECT count(*) AS n FROM ${table}`))?.n ?? 0);
  const events = async (type: string) => (await journal.all()).filter((e) => e.type === type);
  return { db, network, alex, sam, project, property, call, partner, count, events, setDay, refs };
}

const TABLE = { vintage: '2024', source: 'Table inventée pour les tests, ensemble des deux sexes', rows: [{ age: 68, expectancyTenths: 175 }, { age: 75, expectancyTenths: 128 }] };
const TYPED = {
  marketValue: { value: 20_000_000, hypothesis: 'valeur libre de l’avis de valeur' },
  occupied: { value: true, hypothesis: 'le vendeur garde l’usage' },
  headAges: { value: [75], hypothesis: 'âge déclaré' },
  bouquet: { value: 3_000_000, hypothesis: 'convenu avec le vendeur' },
  annualRateBp: { value: 300, hypothesis: 'taux technique retenu' },
};
const LOT = { lotRef: 'A01', typology: 't3', livingAreaHundredths: 6500, floor: 2, priceCents: 25_000_000, status: 'disponible', confirmedOn: '2027-03-01' };

it('BR75 · chaque route nomme ses rôles, sous /neuf et /viager', () => {
  const routes = neufViagerRoutes();
  expect(routes.length).toBe(11);
  for (const r of routes) {
    expect(r.name).toMatch(/^(neuf|viager)\./);
    expect(r.roles.length).toBeGreaterThan(0);
    expect(r.roles).not.toContain('compliance');
  }
});

describeWithSqlite('BR75 · routes du neuf et du viager', () => {
  it('[R16] un autre rôle est refusé en 403 avant le corps, refus au journal, sans rien ranger', async () => {
    const t = await setup();
    const cases: [Who, string, string, unknown?][] = [
      ['alex', 'POST', '/neuf/baremes', { kind: 'neuf', rateBp: 250, source: 'Barème inventé', validFrom: '2027-01-01' }],
      ['alex', 'POST', '/neuf/programmes', {}],
      ['alex', 'POST', '/viager/tables', TABLE],
      ['conf', 'GET', '/neuf/programmes'],
      ['conf', 'GET', '/neuf/programmes/p-1'],
      ['conf', 'POST', '/neuf/programmes/p-1/lots', LOT],
      ['conf', 'POST', '/viager/calculs', { inputs: TYPED }],
      ['conf', 'GET', '/viager/calculs/c-1'],
      ['conf', 'GET', '/viager/calculs/c-1/rejeu'],
      ['conf', 'POST', '/viager/calculs/c-1/expert', {}],
    ];
    for (const [who, method, path, body] of cases) {
      const before = (await t.events('acces.refuse')).length;
      const r = await t.call(who, method, path, body);
      expect([r.status, r.body.rule, r.body.code], `${who} ${method} ${path}`).toEqual([403, 'R16', 'role']);
      expect((await t.events('acces.refuse')).length, `${who} ${method} ${path}`).toBe(before + 1);
      // Même un corps illisible ne passe pas avant les droits.
      if (method === 'POST') expect((await t.call(who, method, path, undefined, {}, '{pas du json')).status).toBe(403);
    }
    for (const table of ['acquisition_fee_scales', 'new_programs', 'new_program_lot_versions', 'life_tables', 'viager_calculations']) expect(await t.count(table), table).toBe(0);
  });

  it('[R543] [R544] la direction range les barèmes et ouvre un programme ; l’agent du programme tient ses lots, un lot vendu ne revient jamais', async () => {
    const t = await setup();
    const promoter = await t.partner('promoteur', 'Promoteur Exemple');
    const open = { promoterPartnerId: promoter, agentId: t.alex, name: 'Les Jardins inventés', city: 'Dijon', postalCode: '21000' };
    const p = await t.call('dir', 'POST', '/neuf/programmes', open);
    expect(p.status).toBe(200);
    const programId = p.body.data.programId as string;
    // Un partenaire qui n'est pas promoteur est refusé.
    const notary = await t.partner('notaire', 'Notaire Exemple');
    expect((await t.call('dir', 'POST', '/neuf/programmes', { ...open, promoterPartnerId: notary })).body).toMatchObject({ ok: false, code: 'not_promoter' });

    // Sans barème : aucun chiffre de frais [R544].
    expect((await t.call('alex', 'POST', `/neuf/programmes/${programId}/lots`, LOT)).status).toBe(200);
    let grid = await t.call('alex', 'GET', `/neuf/programmes/${programId}`);
    expect(grid.status).toBe(200);
    expect(grid.body.data.lots).toHaveLength(1);
    expect(grid.body.data.lots[0].fees).toBeNull();

    // Un barème mal sourcé est refusé, puis les deux barèmes rangés : les frais portent leur source.
    expect((await t.call('dir', 'POST', '/neuf/baremes', { kind: 'neuf', rateBp: 250, source: 'x', validFrom: '2027-01-01' })).body).toMatchObject({ rule: 'R544', code: 'source' });
    expect((await t.call('dir', 'POST', '/neuf/baremes', { kind: 'neuf', rateBp: 250, source: 'Barème du neuf inventé', validFrom: '2027-01-01' })).status).toBe(200);
    expect((await t.call('dir', 'POST', '/neuf/baremes', { kind: 'ancien', rateBp: 750, source: 'Barème de l’ancien inventé', validFrom: '2027-01-01' })).status).toBe(200);
    grid = await t.call('dir', 'GET', `/neuf/programmes/${programId}`);
    const fees = grid.body.data.lots[0].fees;
    expect(fees.newFees.value).toBe(625_000);
    expect(fees.oldFees.value).toBe(1_875_000);
    expect(fees.saving.value).toBe(1_250_000);
    expect(fees.newFees.source).toContain('Barème du neuf inventé');
    // La grille ne porte ni l'agent, ni l'auteur des versions.
    expect(JSON.stringify(grid.body.data.lots)).not.toContain(t.alex);

    // Un autre agent ne voit ni ne touche le programme [R16].
    const other = await t.call('sam', 'GET', `/neuf/programmes/${programId}`);
    expect([other.status, other.body.code]).toEqual([403, 'not_assigned']);
    expect((await t.call('sam', 'POST', `/neuf/programmes/${programId}/lots`, LOT)).status).toBe(403);
    expect((await t.call('alex', 'GET', '/neuf/programmes/inconnu')).status).toBe(404);

    // Les programmes : la direction les voit tous avec l'agent ; l'agent les siens, sans l'agent ; un autre aucun.
    const dirList = await t.call('dir', 'GET', '/neuf/programmes');
    expect(dirList.body.data).toMatchObject([{ programId, name: 'Les Jardins inventés', promoter: 'Promoteur Exemple', agentId: t.alex }]);
    const own = await t.call('alex', 'GET', '/neuf/programmes');
    expect(own.body.data).toHaveLength(1);
    expect(own.body.data[0].agentId).toBeUndefined();
    expect((await t.call('sam', 'GET', '/neuf/programmes')).body.data).toEqual([]);

    // Vendu, puis jamais de retour [R543].
    expect((await t.call('alex', 'POST', `/neuf/programmes/${programId}/lots`, { ...LOT, status: 'vendu' })).status).toBe(200);
    const back = await t.call('alex', 'POST', `/neuf/programmes/${programId}/lots`, { ...LOT, status: 'disponible' });
    expect([back.status, back.body.rule, back.body.code]).toEqual([409, 'R543', 'vendu']);
    expect((await t.call('dir', 'GET', `/neuf/programmes/${programId}`)).body.data.lots).toEqual([]);

    // Un champ invalide : 400, rien de rangé.
    const before = await t.count('new_program_lot_versions');
    expect((await t.call('alex', 'POST', `/neuf/programmes/${programId}/lots`, { ...LOT, lotRef: 'B02', typology: 'chateau' })).status).toBe(400);
    expect((await t.call('alex', 'POST', `/neuf/programmes/${programId}/lots`, undefined, {}, '{pas du json')).body.code).toBe('invalid_body');
    expect(await t.count('new_program_lot_versions')).toBe(before);
  });

  it('[R16] un agent sorti ne voit plus ses programmes, refusé par l’application entière', async () => {
    const t = await setup();
    const promoter = await t.partner('promoteur', 'Promoteur Exemple');
    const p = await t.call('dir', 'POST', '/neuf/programmes', { promoterPartnerId: promoter, agentId: t.alex, name: 'Programme inventé', city: 'Dijon', postalCode: '21000' });
    await t.db.run("UPDATE agents SET status = 'left' WHERE id = ?", [t.alex]);
    const list = await t.call('alex', 'GET', '/neuf/programmes');
    expect([list.status, list.body.code]).toEqual([403, 'agent_inactive']);
    expect((await t.call('alex', 'GET', `/neuf/programmes/${p.body.data.programId}`)).status).toBe(403);
  });

  it('[R541] [R542] [R540] la table sans colonne de sexe, le bouquet plafonné, le calcul relu et rejoué par son auteur seul', async () => {
    const t = await setup();
    // Une colonne de sexe : refusée [R541].
    const sexed = await t.call('dir', 'POST', '/viager/tables', { ...TABLE, rows: [{ age: 75, expectancyTenths: 128, sex: 'f' }] });
    expect([sexed.status, sexed.body.rule, sexed.body.code]).toEqual([409, 'R541', 'colonnes']);
    expect((await t.call('dir', 'POST', '/viager/tables', TABLE)).status).toBe(200);
    expect((await t.call('dir', 'POST', '/viager/tables', TABLE)).body).toMatchObject({ rule: 'R541', code: 'deja_importee' });

    // Une espérance saisie à la main est refusée : elle vient de la table [R541].
    const typedExp = await t.call('alex', 'POST', '/viager/calculs', { inputs: { ...TYPED, expectancies: { value: [200], hypothesis: 'à la main' } } });
    expect([typedExp.status, typedExp.body.rule]).toEqual([409, 'R541']);
    // Un bouquet plus haut que la valeur occupée [R542].
    const high = await t.call('alex', 'POST', '/viager/calculs', { inputs: { ...TYPED, bouquet: { value: 17_000_000, hypothesis: 'trop haut' } } });
    expect([high.status, high.body.rule, high.body.code, high.body.field]).toEqual([409, 'R542', 'bouquet_trop_haut', 'bouquet']);
    expect(await t.count('viager_calculations')).toBe(0);

    // Un calcul sur le bien et le projet de la fiche d'Alex.
    const calc = await t.call('alex', 'POST', '/viager/calculs', { propertyId: t.property, projectId: t.project, inputs: TYPED });
    expect(calc.status).toBe(200);
    const id = calc.body.data.id as string;
    expect(calc.body.data.result.status).toBe('complet');
    expect(calc.body.data.inputs.expectancies.source).toContain('Table inventée');
    expect(calc.body.data.inputs.marketValue.source).toBe(`saisi:agent:${t.alex}`);

    // Relu et rejoué à l'identique par l'auteur et la direction [R540].
    expect((await t.call('alex', 'GET', `/viager/calculs/${id}`)).body.data.id).toBe(id);
    for (const who of ['alex', 'dir'] as Who[]) {
      const r = await t.call(who, 'GET', `/viager/calculs/${id}/rejeu`);
      expect([r.status, r.body.data.same], who).toEqual([200, true]);
      expect(r.body.data.result).toEqual(calc.body.data.result);
    }
    // Un autre agent : ni relu ni rejoué [R16].
    for (const path of [`/viager/calculs/${id}`, `/viager/calculs/${id}/rejeu`]) expect((await t.call('sam', 'GET', path)).status, path).toBe(403);
    expect((await t.call('alex', 'GET', '/viager/calculs/inconnu/rejeu')).status).toBe(404);
    // Un calcul sur la fiche d'un autre : refusé.
    expect((await t.call('sam', 'POST', '/viager/calculs', { projectId: t.project, inputs: TYPED })).status).toBe(403);
    expect((await t.call('alex', 'POST', '/viager/calculs', undefined, {}, '[]')).body.code).toBe('invalid_body');
  });

  it('[R542] l’expert du viager passe par la mise en relation de M18, fermé sans le stockage des fichiers', async () => {
    const t = await setup();
    await t.call('dir', 'POST', '/viager/tables', TABLE);
    const withProject = (await t.call('alex', 'POST', '/viager/calculs', { propertyId: t.property, projectId: t.project, inputs: TYPED })).body.data.id as string;
    const alone = (await t.call('alex', 'POST', '/viager/calculs', { inputs: TYPED })).body.data.id as string;

    // Sans stockage des fichiers des partenaires : aucun expert proposé.
    const closed = await t.call('alex', 'POST', `/viager/calculs/${withProject}/expert`, {}, { partenaires: { files: null } });
    expect([closed.status, closed.body.rule, closed.body.code]).toEqual([409, 'R542', 'relation_absente']);
    // Sans projet : rien à proposer.
    expect((await t.call('alex', 'POST', `/viager/calculs/${alone}/expert`, {})).body).toMatchObject({ rule: 'R542', code: 'sans_projet' });
    // Aucun expert dans l'annuaire : la mise en relation le dit.
    expect((await t.call('alex', 'POST', `/viager/calculs/${withProject}/expert`, {})).body).toMatchObject({ ok: false, rule: 'R542', code: 'no_partner' });

    // Un expert du viager rangé par la direction, avec son assurance : il est proposé, et rien n'est envoyé.
    const e = await t.call('dir', 'POST', '/partenaires/annuaire', { trade: 'expert_viager', businessName: 'Expert viager inventé', postcodes: ['21000'] });
    expect(e.status).toBe(200);
    const expert = e.body.data.partnerId as string;
    const proofRef = `partenaires/${expert}/00000000-0000-4000-8000-000000000001.pdf`;
    t.refs.add(proofRef);
    const cred = await t.call('dir', 'POST', `/partenaires/annuaire/${expert}/justificatifs`, { kind: 'assurance_rcp', number: 'N-1', validFrom: '2027-01-01', validUntil: '2027-12-31', proofRef });
    expect([cred.status, cred.body.code]).toEqual([200, undefined]);
    const ok = await t.call('alex', 'POST', `/viager/calculs/${withProject}/expert`, {});
    expect(ok.status).toBe(200);
    const referral = await t.db.first<{ trade: string; project_id: string }>('SELECT trade, project_id FROM partner_referrals WHERE id = ?', [ok.body.data.referralId]);
    expect(referral).toEqual({ trade: 'expert_viager', project_id: t.project });
    expect(await t.count('messages')).toBe(0);
    // Un autre agent ne propose rien sur le calcul d'Alex.
    expect((await t.call('sam', 'POST', `/viager/calculs/${withProject}/expert`, {})).status).toBe(403);
  });
});
