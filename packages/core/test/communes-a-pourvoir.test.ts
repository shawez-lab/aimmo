import { expect, it } from 'vitest';
import {
  Attribution,
  Qualification,
  ReconnaissanceBien,
  SqlJournalStore,
  applyMigrations,
  createCaptation,
  fromSyncSqlite,
  type SqlDatabase,
  type Viewer,
} from '../src/index.ts';
import { CommunesAPourvoir, WAITING_CLIENT_CATEGORIES } from '../src/reseau/index.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

// Réseau, agents, contacts et biens inventés. Février 2027 est le mois lu ; mars 2027 est le mois en cours.

async function setup() {
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  let clock = Date.parse('2027-03-10T09:00:00.000Z');
  const now = (): Date => new Date((clock += 1000));
  const goTo = (iso: string) => {
    clock = Date.parse(iso);
  };
  const journal = new SqlJournalStore(db);
  const { chaine, store, fiche, reception } = createCaptation(db, journal, { now, withQualification: false });
  const qualification = new Qualification(db, store, fiche, reception, new ReconnaissanceBien(db), journal, { now });
  const attribution = new Attribution(db, fiche, journal, { now });
  const communes = new CommunesAPourvoir(db, journal, { now });
  const network = await store.createNetwork('Réseau test');
  const other = await store.createNetwork('Autre réseau');
  const alex = (await store.createAgent({ networkId: network.id, firstName: 'Alex', lastName: 'Agent' })).id;
  const sam = (await store.createAgent({ networkId: network.id, firstName: 'Sam', lastName: 'Agent' })).id;
  const parti = (await store.createAgent({ networkId: network.id, firstName: 'Parti', lastName: 'Agent' })).id;
  const ailleurs = (await store.createAgent({ networkId: other.id, firstName: 'Ailleurs', lastName: 'Agent' })).id;
  await db.run("UPDATE agents SET status = 'left' WHERE id = ?", [parti]);
  const as = (role: string, userId = 'dir-1', networkId = network.id): Viewer => ({ role, userId, networkId }) as Viewer;
  const dir = as('direction');

  let n = 0;
  /** Une zone d'agent écrite à la main, avec ses dates. */
  const zone = async (agentId: string, commune: string, createdAt: string, endedAt: string | null = null, networkId = network.id) => {
    await db.run('INSERT INTO agent_zones (id, network_id, agent_id, commune, created_at, ended_at) VALUES (?, ?, ?, ?, ?, ?)', [`z-${++n}`, networkId, agentId, commune, createdAt, endedAt]);
  };
  /** Une qualification et son attribution, écrites à la main ; la chaîne réelle est testée plus bas. */
  const contact = async (c: {
    person: string;
    at: string;
    city?: string | null;
    propertyCity?: string | null;
    category?: string;
    reason?: string;
    agentId?: string | null;
    replaces?: string | null;
    networkId?: string;
  }) => {
    const id = `q-${++n}`;
    const net = c.networkId ?? network.id;
    await db.exec('PRAGMA foreign_keys = OFF');
    let propertyId: string | null = null;
    if (c.propertyCity !== undefined) {
      propertyId = `p-${n}`;
      await db.run("INSERT INTO properties (id, network_id, reference, kind, city, created_at, updated_at) VALUES (?, ?, ?, 'home', ?, 'x', 'x')", [propertyId, net, `REF-${n}`, c.propertyCity]);
    }
    await db.run("INSERT INTO qualifications (id, network_id, inbound_id, person_id, category, city, property_id, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'rules', ?)", [
      id,
      net,
      `in-${n}`,
      c.person,
      c.category ?? 'seller',
      c.city ?? null,
      propertyId,
      c.at,
    ]);
    await db.run('INSERT INTO attributions (id, network_id, person_id, qualification_id, agent_id, reason, callback_hours, replaces_id, created_at) VALUES (?, ?, ?, ?, ?, ?, 24, ?, ?)', [
      `a-${id}`,
      net,
      c.person,
      id,
      c.agentId ?? null,
      c.reason ?? 'no_zone',
      c.replaces ?? null,
      c.at,
    ]);
    await db.exec('PRAGMA foreign_keys = ON');
    return `a-${id}`;
  };
  const events = async (type: string) => (await db.all<{ data: string }>('SELECT data FROM journal WHERE type = ? ORDER BY rowid', [type])).map((r) => JSON.parse(r.data) as Record<string, unknown>);
  return { db, chaine, qualification, attribution, communes, journal, network, other, alex, sam, parti, ailleurs, as, dir, zone, contact, events, goTo, now };
}

const FEB = '2027-02-10T10:00:00.000Z';

describeWithSqlite('HX68 · communes où des clients attendent un agent', () => {
  it('compte à la main un mois inventé, commune par commune, sans personne ni agent nommé [R626]', async () => {
    const t = await setup();
    // Talant : deux personnes ; la première a écrit deux fois, elle compte une fois.
    await t.contact({ person: 'per-1', at: FEB, city: 'Talant' });
    await t.contact({ person: 'per-1', at: '2027-02-11T10:00:00.000Z', city: 'Talant' });
    await t.contact({ person: 'per-2', at: '2027-02-12T10:00:00.000Z', city: 'Talant', category: 'buyer' });
    // Quetigny : par la commune du bien cité, la personne n'en ayant pas donné.
    await t.contact({ person: 'per-3', at: FEB, propertyCity: 'Quetigny' });
    // Chenôve : une zone ouverte à l'instant de l'attribution, le contact n'attendait pas faute d'agent.
    await t.zone(t.alex, 'Chenôve', '2027-01-01T00:00:00.000Z');
    await t.contact({ person: 'per-4', at: FEB, city: 'Chenôve' });
    // Longvic : une zone fermée avant, puis une zone ouverte après ; le contact entre les deux attendait.
    await t.zone(t.sam, 'Longvic', '2027-01-01T00:00:00.000Z', '2027-02-01T00:00:00.000Z');
    await t.zone(t.sam, 'Longvic', '2027-02-20T00:00:00.000Z');
    await t.contact({ person: 'per-5', at: FEB, city: 'Longvic' });
    // Ni partenaire, ni curieux, ni indésirable : ce ne sont pas des clients qui attendent.
    await t.contact({ person: 'per-6', at: FEB, city: 'Talant', category: 'partner' });
    await t.contact({ person: 'per-7', at: FEB, city: 'Talant', category: 'curious' });
    await t.contact({ person: 'per-8', at: FEB, city: 'Talant', category: 'spam' });
    // Une réattribution à la direction : le contact avait eu un agent, il n'est pas compté.
    const first = await t.contact({ person: 'per-9', at: '2027-02-01T10:00:00.000Z', city: 'Dijon', reason: 'zone', agentId: t.alex });
    await t.contact({ person: 'per-9', at: '2027-02-02T10:00:00.000Z', city: 'Dijon', reason: 'reassigned', replaces: first });
    // Les bords du mois de Paris : 23 h 59 le 31 janvier et minuit le 1er mars ne comptent pas.
    await t.contact({ person: 'per-10', at: '2027-01-31T22:59:59.000Z', city: 'Talant' });
    await t.contact({ person: 'per-11', at: '2027-02-28T23:00:00.000Z', city: 'Talant' });
    // 23 h 30 le 28 février à Paris : dans le mois.
    await t.contact({ person: 'per-12', at: '2027-02-28T22:30:00.000Z', city: 'Saint-Apollinaire' });
    // Un autre réseau ne compte jamais.
    await t.contact({ person: 'per-13', at: FEB, city: 'Talant', networkId: t.other.id });
    // Sans commune connue, ou un bien hors de la liste : à part, jamais rangés dans une commune.
    await t.contact({ person: 'per-14', at: FEB });
    await t.contact({ person: 'per-15', at: FEB, propertyCity: 'Lyon' });
    // Un agent parti et un agent d'un autre réseau ne couvrent rien aujourd'hui.
    await t.zone(t.parti, 'Talant', '2027-03-01T00:00:00.000Z');
    await t.zone(t.ailleurs, 'Talant', '2027-01-01T00:00:00.000Z', null, t.other.id);

    const r = await t.communes.month(t.dir, '2027-02');
    if (!r.ok) throw new Error(r.code);
    const by = Object.fromEntries(r.value.communes.map((c) => [c.commune, c]));
    expect(by['Talant']).toMatchObject({ clientsWaiting: 2, agentsNow: 0, open: false, toOpen: true, toClose: false });
    expect(by['Quetigny']).toMatchObject({ clientsWaiting: 1, agentsNow: 0, toOpen: true });
    expect(by['Chenôve']).toMatchObject({ clientsWaiting: 0, agentsNow: 1, toOpen: false });
    expect(by['Longvic']).toMatchObject({ clientsWaiting: 1, agentsNow: 1, toOpen: false });
    expect(by['Saint-Apollinaire']).toMatchObject({ clientsWaiting: 1 });
    expect(by['Dijon']).toMatchObject({ clientsWaiting: 0 });
    expect(r.value.withoutCommune).toBe(2);
    // Toutes les communes de la liste, rangées par clients en attente puis par nom.
    expect(r.value.communes.map((c) => c.commune).slice(0, 4)).toEqual(['Talant', 'Longvic', 'Quetigny', 'Saint-Apollinaire']);
    expect(r.value.communes.length).toBe(t.communes.communes.length);
    // Aucune personne ni aucun agent dans la réponse [R14].
    const text = JSON.stringify(r.value);
    expect(text).not.toMatch(/per-|Alex|Sam|Agent/);
    for (const id of [t.alex, t.sam, t.parti]) expect(text).not.toContain(id);
    // La lecture est au journal, sans nom.
    const read = await t.events('communes_recrutement.mois_lu');
    expect(read).toEqual([{ rule: 'R16', month: '2027-02', waiting: 5, withoutCommune: 2 }]);
  });

  it('un agent parti avant ne couvre plus sa commune, même si sa zone est restée ouverte ; parti après, si [R626]', async () => {
    const t = await setup();
    const depart = async (agentId: string, processedAt: string) => {
      await t.db.run("UPDATE agents SET status = 'left' WHERE id = ?", [agentId]);
      await t.db.run(
        "INSERT INTO agent_departures (id, network_id, agent_id, notice_given_on, leaves_on, reason, notice_months, created_by, created_at, processed_at) VALUES (?, ?, ?, '2026-12-01', ?, 'demission_agent', 1, 'direction:dir-1', 'x', ?)",
        [`dep-${agentId}`, t.network.id, agentId, processedAt.slice(0, 10), processedAt],
      );
    };
    // Talant : le seul agent est parti le 15 janvier ; sa zone n'a jamais été fermée (J11 ne ferme pas les zones).
    await t.zone(t.alex, 'Talant', '2026-12-01T00:00:00.000Z');
    await depart(t.alex, '2027-01-15T06:00:00.000Z');
    await t.contact({ person: 'per-1', at: FEB, city: 'Talant' });
    // Dijon : l'agent couvrait encore la commune le 10 février, il est parti le 20 : le contact n'attendait pas faute d'agent.
    await t.zone(t.sam, 'Dijon', '2026-12-01T00:00:00.000Z');
    await depart(t.sam, '2027-02-20T06:00:00.000Z');
    await t.contact({ person: 'per-2', at: FEB, city: 'Dijon' });
    // Chenôve : un agent devenu « parti » sans départ rangé ne couvre rien.
    await t.zone(t.parti, 'Chenôve', '2026-12-01T00:00:00.000Z');
    await t.contact({ person: 'per-3', at: FEB, city: 'Chenôve' });
    const r = await t.communes.month(t.dir, '2027-02');
    if (!r.ok) throw new Error(r.code);
    const by = Object.fromEntries(r.value.communes.map((c) => [c.commune, c]));
    expect(by['Talant']).toMatchObject({ clientsWaiting: 1, agentsNow: 0, toOpen: true });
    expect(by['Dijon']).toMatchObject({ clientsWaiting: 0, agentsNow: 0 });
    expect(by['Chenôve']).toMatchObject({ clientsWaiting: 1, agentsNow: 0 });
  });

  it('deux fiches réunies comptent une personne, et une personne comptée dans une commune ne l’est pas « sans commune » [R626]', async () => {
    const t = await setup();
    await t.contact({ person: 'per-a', at: FEB, city: 'Talant' });
    await t.contact({ person: 'per-b', at: '2027-02-11T10:00:00.000Z', city: 'Talant' });
    await t.contact({ person: 'per-c', at: '2027-02-12T10:00:00.000Z' });
    await t.contact({ person: 'per-d', at: FEB, city: 'Talant' });
    await t.db.exec('PRAGMA foreign_keys = OFF');
    // per-b réunie à per-a, puis per-a à per-c : une seule personne.
    await t.db.run("INSERT INTO person_merges (id, network_id, agent_id, survivor_id, merged_id, reason, merged_at, undone_at, created_at) VALUES ('m-1', ?, NULL, 'per-a', 'per-b', 'Même personne', 'x', NULL, 'x')", [t.network.id]);
    await t.db.run("INSERT INTO person_merges (id, network_id, agent_id, survivor_id, merged_id, reason, merged_at, undone_at, created_at) VALUES ('m-2', ?, NULL, 'per-c', 'per-a', 'Même personne', 'x', NULL, 'x')", [t.network.id]);
    // Une réunion défaite ne compte pas.
    await t.db.run("INSERT INTO person_merges (id, network_id, agent_id, survivor_id, merged_id, reason, merged_at, undone_at, created_at) VALUES ('m-3', ?, NULL, 'per-c', 'per-d', 'Erreur', 'x', 'y', 'x')", [t.network.id]);
    await t.db.exec('PRAGMA foreign_keys = ON');
    const r = await t.communes.month(t.dir, '2027-02');
    if (!r.ok) throw new Error(r.code);
    expect(r.value.communes.find((c) => c.commune === 'Talant')).toMatchObject({ clientsWaiting: 2 });
    expect(r.value.withoutCommune).toBe(0);
  });

  it('seuls les clients comptent : vendeur, acquéreur, estimation, location et professionnel [R626]', () => {
    expect([...WAITING_CLIENT_CATEGORIES].sort()).toEqual(['buyer', 'professional', 'rent_out', 'seller', 'valuation']);
  });

  it('refuse un mois en cours, futur ou mal écrit [R626]', async () => {
    const t = await setup();
    expect(await t.communes.month(t.dir, '2027-03')).toEqual({ ok: false, rule: 'R626', code: 'month_not_finished' });
    expect(await t.communes.month(t.dir, '2027-04')).toEqual({ ok: false, rule: 'R626', code: 'month_not_finished' });
    for (const bad of ['2027-2', '2027-13', 202702, null, '2027-02-01']) expect(await t.communes.month(t.dir, bad)).toMatchObject({ ok: false, code: 'bad_month' });
    expect((await t.events('communes_recrutement.refuse')).length).toBe(7);
  });

  it('la direction seule lit et décide ; chaque refus est au journal [R16]', async () => {
    const t = await setup();
    for (const role of ['agent', 'conformite', 'comptable', 'client']) {
      const v = t.as(role, 'u-1');
      expect(await t.communes.month(v, '2027-02')).toEqual({ ok: false, rule: 'R16', code: 'role' });
      expect(await t.communes.decide(v, { commune: 'Talant', open: true, reason: 'Des clients attendent' })).toEqual({ ok: false, rule: 'R16', code: 'role' });
    }
    expect((await t.events('acces.refuse')).length).toBe(8);
    expect(await t.db.first('SELECT 1 FROM recruiting_commune_decisions')).toBeNull();
    expect(await t.events('communes_recrutement.mois_lu')).toEqual([]);
  });

  it('ouvre, ferme et rouvre une commune, par versions qui ne changent plus [R627]', async () => {
    const t = await setup();
    expect(await t.communes.decide(t.dir, { commune: 'Talant', open: false, reason: 'Fermer avant d’ouvrir' })).toEqual({ ok: false, rule: 'R627', code: 'deja_fermee' });
    expect(await t.communes.decide(t.dir, { commune: 'Talant', open: true, reason: 'Des clients attendent' })).toEqual({ ok: true, value: { commune: 'Talant', version: 1, open: true } });
    expect(await t.communes.decide(t.dir, { commune: 'Talant', open: true, reason: 'Encore' })).toEqual({ ok: false, rule: 'R627', code: 'deja_ouverte' });
    expect(await t.communes.decide(t.dir, { commune: 'Talant', open: false, reason: 'Un agent est entré' })).toMatchObject({ ok: true, value: { version: 2, open: false } });
    expect(await t.communes.decide(t.dir, { commune: 'Talant', open: true, reason: '  De   nouveau  ' })).toMatchObject({ ok: true, value: { version: 3, open: true } });
    const rows = await t.db.all<{ version: number; is_open: number; reason: string; decided_by: string }>('SELECT version, is_open, reason, decided_by FROM recruiting_commune_decisions ORDER BY version');
    expect(rows).toEqual([
      { version: 1, is_open: 1, reason: 'Des clients attendent', decided_by: 'direction:dir-1' },
      { version: 2, is_open: 0, reason: 'Un agent est entré', decided_by: 'direction:dir-1' },
      { version: 3, is_open: 1, reason: 'De nouveau', decided_by: 'direction:dir-1' },
    ]);
    expect((await t.events('communes_recrutement.decision')).map((e) => e.version)).toEqual([1, 2, 3]);
    // Chaque réseau a ses décisions.
    expect(await t.communes.decide(t.as('direction', 'dir-2', t.other.id), { commune: 'Talant', open: true, reason: 'Autre réseau' })).toMatchObject({ ok: true, value: { version: 1 } });
  });

  it('refuse une commune hors de la liste, un champ en trop, un état ou un motif mal écrits [R627]', async () => {
    const t = await setup();
    expect(await t.communes.decide(t.dir, { commune: 'Lyon', open: true, reason: 'Hors liste' })).toEqual({ ok: false, rule: 'R627', code: 'commune_inconnue' });
    expect(await t.communes.decide(t.dir, { commune: 'talant', open: true, reason: 'Casse' })).toEqual({ ok: false, rule: 'R627', code: 'commune_inconnue' });
    expect(await t.communes.decide(t.dir, { commune: 'Talant', open: true, reason: 'Ok', clients: 3 })).toEqual({ ok: false, rule: null, code: 'unknown_field' });
    expect(await t.communes.decide(t.dir, { commune: 'Talant', open: 'oui', reason: 'Motif' })).toEqual({ ok: false, rule: null, code: 'bad_open' });
    expect(await t.communes.decide(t.dir, { commune: 'Talant', open: true, reason: ' a ' })).toEqual({ ok: false, rule: null, code: 'bad_reason' });
    expect(await t.communes.decide(t.dir, { commune: 'Talant', open: true, reason: 'x'.repeat(201) })).toEqual({ ok: false, rule: null, code: 'bad_reason' });
    for (const bad of [null, [], 'Talant']) expect(await t.communes.decide(t.dir, bad)).toEqual({ ok: false, rule: null, code: 'bad_shape' });
    expect(await t.db.first('SELECT 1 FROM recruiting_commune_decisions')).toBeNull();
    expect((await t.events('communes_recrutement.refuse')).length).toBe(9);
  });

  it('la base refuse une décision qui change, s’efface, saute une version ou ne change pas l’état [R627, R17]', async () => {
    const t = await setup();
    await t.communes.decide(t.dir, { commune: 'Talant', open: true, reason: 'Des clients attendent' });
    const net = t.network.id;
    await expect(t.db.run('UPDATE recruiting_commune_decisions SET is_open = 0')).rejects.toThrow(/ne change plus/);
    await expect(t.db.run('DELETE FROM recruiting_commune_decisions')).rejects.toThrow(/rien ne s'efface/);
    const insert = (version: number, open: number, by = 'direction:dir-1', commune = 'Talant') =>
      t.db.run("INSERT INTO recruiting_commune_decisions (network_id, commune, version, is_open, reason, decided_by, decided_at) VALUES (?, ?, ?, ?, 'Motif', ?, 'x')", [net, commune, version, open, by]);
    await expect(insert(3, 0)).rejects.toThrow(/hors suite/);
    await expect(insert(2, 1)).rejects.toThrow(/état inchangé/);
    await expect(insert(1, 0, 'direction:dir-1', 'Dijon')).rejects.toThrow(/état inchangé/);
    await expect(insert(2, 0, 'agent:u-1')).rejects.toThrow();
    await insert(2, 0);
    expect((await t.db.all('SELECT version FROM recruiting_commune_decisions')).length).toBe(2);
  });

  it('la page de candidature lit les noms des communes ouvertes, par ordre alphabétique, sans aucun chiffre [R628]', async () => {
    const t = await setup();
    expect(await t.communes.openCommunes(t.network.id)).toEqual([]);
    for (const c of ['Talant', 'Chenôve', 'Quetigny', 'Dijon']) await t.communes.decide(t.dir, { commune: c, open: true, reason: 'Des clients attendent' });
    await t.communes.decide(t.dir, { commune: 'Dijon', open: false, reason: 'Couverte' });
    // Une commune ouverte dans un autre réseau ne se voit pas ici.
    await t.communes.decide(t.as('direction', 'dir-2', t.other.id), { commune: 'Longvic', open: true, reason: 'Autre réseau' });
    const names = await t.communes.openCommunes(t.network.id);
    expect(names).toEqual(['Chenôve', 'Quetigny', 'Talant']);
    expect(names.every((n) => typeof n === 'string' && !/\d/.test(n))).toBe(true);
    // Une commune retirée de la liste réglée ne se montre plus, même ouverte.
    const reduite = new CommunesAPourvoir(t.db, t.journal, { communes: ['Talant', 'Quetigny'] });
    expect(await reduite.openCommunes(t.network.id)).toEqual(['Quetigny', 'Talant']);
    // Lire la page n'écrit rien et ne demande aucun rôle.
    expect(await t.events('communes_recrutement.mois_lu')).toEqual([]);
  });

  it('signale une commune ouverte qu’un agent couvre désormais, sans la fermer d’elle-même [R626, R627]', async () => {
    const t = await setup();
    t.goTo('2027-02-05T09:00:00.000Z');
    await t.communes.decide(t.dir, { commune: 'Talant', open: true, reason: 'Des clients attendent' });
    await t.contact({ person: 'per-1', at: FEB, city: 'Talant' });
    t.goTo('2027-03-10T09:00:00.000Z');
    await t.zone(t.alex, 'Talant', '2027-03-01T00:00:00.000Z');
    const r = await t.communes.month(t.dir, '2027-02');
    if (!r.ok) throw new Error(r.code);
    expect(r.value.communes.find((c) => c.commune === 'Talant')).toMatchObject({ clientsWaiting: 1, agentsNow: 1, open: true, toOpen: false, toClose: true });
    expect(r.value.communes.find((c) => c.commune === 'Talant')!.openSince).toMatch(/^2027-02-05T/);
    expect(await t.communes.openCommunes(t.network.id)).toEqual(['Talant']);
  });

  it('suit la chaîne réelle : un contact sans agent sur sa commune compte, plus après l’entrée d’un agent [R626]', async () => {
    const t = await setup();
    t.goTo('2027-02-09T09:00:00.000Z');
    let seq = 0;
    const real = async (who: string, message: string) => {
      seq += 1;
      await t.chaine.receive(t.network.id, 'site_form', { submissionId: `f-${seq}`, email: `${who}@example.test`, message });
      const row = await t.db.first<{ id: string }>('SELECT id FROM inbound_messages ORDER BY rowid DESC LIMIT 1');
      const q = await t.qualification.qualify(row!.id);
      return t.attribution.attribute(q!.id);
    };
    expect(await real('zoe', 'Je souhaite vendre ma maison à Talant.')).toMatchObject({ agent_id: null, reason: 'no_zone' });
    await t.attribution.addZone(t.network.id, t.alex, 'Talant');
    expect(await real('lea', 'Je souhaite vendre ma maison à Talant.')).toMatchObject({ agent_id: t.alex, reason: 'zone' });
    t.goTo('2027-03-10T09:00:00.000Z');
    const r = await t.communes.month(t.dir, '2027-02');
    if (!r.ok) throw new Error(r.code);
    expect(r.value.communes.find((c) => c.commune === 'Talant')).toMatchObject({ clientsWaiting: 1, agentsNow: 1 });
    expect(JSON.stringify(r.value)).not.toMatch(/zoe|lea|example/);
  });
});
