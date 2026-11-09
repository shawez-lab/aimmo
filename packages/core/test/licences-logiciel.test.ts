import { expect, it } from 'vitest';
import { FicheClient, SqlJournalStore, applyMigrations, fromSyncSqlite, type SqlDatabase, type Viewer } from '../src/index.ts';
import { PortesPhases, type PhaseConditionReading } from '../src/conditions-phases/index.ts';
import { LicencesLogiciel, sirenValid } from '../src/licences/index.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

// Tout est inventé : réseaux d'essai, agences, SIREN (clé juste, aucune entreprise réelle visée), cartes, raisons.
const met = (): PhaseConditionReading => ({ met: true, reasons: [], evidence: { essai: 1 } });
const AGENCE = { agencyName: 'Agence du Lac (essai)', siren: '123456782', cardNumber: 'CPI 7501 2027 000 000 001', cardExpiresOn: '2030-06-30', department: '75' };

async function setup() {
  const raw = openMemoryDatabase();
  const db: SqlDatabase = fromSyncSqlite(raw);
  await applyMigrations(db, loadMigrations());
  let clock = Date.parse('2028-01-10T09:00:00.000Z');
  const now = (): Date => new Date(clock);
  const setClock = (iso: string) => {
    clock = Date.parse(iso);
  };
  const journal = new SqlJournalStore(db);
  const store = new FicheClient(db, { now });
  const network = await store.createNetwork('Réseau test');
  const other = await store.createNetwork('Autre réseau');
  const as = (role: string, userId: string, networkId = network.id): Viewer => ({ role, userId, networkId }) as Viewer;
  const direction = as('direction', 'direction-1');
  const licences = new LicencesLogiciel(db, journal, { now });
  const portes = new PortesPhases(db, journal, { now, sources: { 1: async () => met(), 2: async () => met(), 3: async () => met(), 4: async () => met() } });
  const openPhase5 = async (v: Viewer = direction) => {
    for (const phase of [2, 3, 4, 5]) {
      const r = await portes.open(v, { phase });
      if (!r.ok) throw new Error(r.code);
    }
  };
  const events = async (type: string) => (await db.all<{ data: string }>('SELECT data FROM journal WHERE type = ?', [type])).map((e) => JSON.parse(e.data) as Record<string, unknown>);
  const tariff = async (monthlyCents: number, v: Viewer = direction) => licences.setTariff(v, { monthlyCents, reason: 'Tarif d’essai' });
  const grant = async (extra: Record<string, unknown> = {}, v: Viewer = direction) => licences.grant(v, { ...AGENCE, ...extra });
  const granted = async (extra: Record<string, unknown> = {}) => {
    const r = await grant(extra);
    if (!r.ok) throw new Error(r.code);
    return r.value;
  };
  return { raw, db, network, other, as, direction, licences, openPhase5, events, tariff, grant, granted, setClock };
}

describeWithSqlite('HX73 · La licence du logiciel aux agences hors réseau', () => {
  it('[R654] une licence ne se donne qu’une fois la phase 5 ouverte, et range son empreinte', async () => {
    const t = await setup();
    expect(await t.tariff(29900)).toMatchObject({ ok: true, value: { version: 1, monthlyCents: 29900 } });
    expect(await t.grant()).toEqual({ ok: false, rule: 'R654', code: 'phase5_fermee' });
    expect(await t.licences.publicTariff(t.network.id)).toBeNull();
    await t.openPhase5();
    const v = await t.granted();
    expect(v).toMatchObject({ tariffVersion: 1, monthlyCents: 29900 });
    const row = await t.db.first<{ phase5_hash: string; licensee_network_id: string }>('SELECT phase5_hash, licensee_network_id FROM software_licences WHERE id = ?', [v.id]);
    const opening = await t.db.first<{ evidence_hash: string }>('SELECT evidence_hash FROM phase_openings WHERE network_id = ? AND phase = 5', [t.network.id]);
    expect(row!.phase5_hash).toBe(opening!.evidence_hash);
    // L'agence naît comme son propre réseau.
    expect(row!.licensee_network_id).toBe(v.licenseeNetworkId);
    expect(await t.db.first<{ name: string }>('SELECT name FROM networks WHERE id = ?', [v.licenseeNetworkId])).toEqual({ name: AGENCE.agencyName });
    expect(await t.events('licences.licence')).toHaveLength(1);
  });

  it('[R654] la base refuse une licence sans la phase 5 ouverte, même écrite à la main', async () => {
    const t = await setup();
    await t.tariff(29900);
    t.raw.prepare("INSERT INTO networks (id, name, created_at) VALUES ('agence-x', 'Agence X', '2028-01-10')").run();
    expect(() =>
      t.raw
        .prepare(
          "INSERT INTO software_licences (id, network_id, licensee_network_id, agency_name, siren, card_number, card_expires_on, department, tariff_version, monthly_cents, phase5_hash, granted_by, granted_at) VALUES ('l1', ?, 'agence-x', 'Agence X', '123456782', 'CPI 7501 2027 000 000 001', '2030-01-01', '75', 1, 29900, ?, 'direction:x', '2028-01-10')",
        )
        .run(t.network.id, 'a'.repeat(64)),
    ).toThrow(/phase 5/);
  });

  it('[R654] l’agence : SIREN à clé juste, carte professionnelle valable, département connu, une seule licence', async () => {
    const t = await setup();
    await t.openPhase5();
    await t.tariff(29900);
    expect(sirenValid('123 456 782')).toBe('123456782');
    for (const siren of ['123456789', '12345678', 'abcdefghi', 123456782, '']) expect(await t.grant({ siren })).toEqual({ ok: false, rule: 'R654', code: 'siren_invalide' });
    for (const cardNumber of ['7501 2027 000 000 001', 'CPI', 'CPI 12', '']) expect(await t.grant({ cardNumber })).toEqual({ ok: false, rule: 'R654', code: 'carte_invalide' });
    for (const cardExpiresOn of ['2030-02-30', '30/06/2030', '', null]) expect(await t.grant({ cardExpiresOn })).toEqual({ ok: false, rule: 'R654', code: 'carte_invalide' });
    // La carte vaut jusqu'à la fin de son dernier jour, heure de Paris : le 10 janvier à 9 h UTC, le 9 est passé.
    expect(await t.grant({ cardExpiresOn: '2028-01-09' })).toEqual({ ok: false, rule: 'R654', code: 'carte_echue' });
    for (const department of ['20', '96', 'Dijon', '', 21]) expect(await t.grant({ department })).toEqual({ ok: false, rule: 'R654', code: 'departement_inconnu' });
    expect(await t.grant({ agencyName: ' ' })).toEqual({ ok: false, rule: null, code: 'bad_name' });
    expect(await t.grant({ agencyName: 'a'.repeat(121) })).toEqual({ ok: false, rule: null, code: 'bad_name' });
    expect(await t.grant({ cardExpiresOn: '2028-01-10', department: '2a' })).toMatchObject({ ok: true });
    expect(await t.grant({ agencyName: 'Autre nom, même SIREN' })).toEqual({ ok: false, rule: 'R654', code: 'deja_licenciee' });
    expect(await t.grant({ siren: '111111118' })).toMatchObject({ ok: true });
    const departments = await t.db.all<{ department: string }>('SELECT department FROM software_licences ORDER BY granted_at, id');
    expect(departments.map((d) => d.department).sort()).toEqual(['2A', '75']);
    expect((await t.events('licences.refuse')).length).toBeGreaterThan(10);
  });

  it('[R655] un seul tarif : aucun prix dans la demande, la licence prend le tarif en vigueur, la base refuse tout autre prix (Jamais vu)', async () => {
    const t = await setup();
    await t.openPhase5();
    expect(await t.grant()).toEqual({ ok: false, rule: 'R655', code: 'tarif_absent' });
    for (const monthlyCents of [0, 99, 10_000_001, 299.5, '29900', null]) expect(await t.tariff(monthlyCents as number)).toEqual({ ok: false, rule: 'R655', code: 'bad_price' });
    expect(await t.tariff(100)).toMatchObject({ ok: true, value: { version: 1 } });
    expect(await t.tariff(10_000_000)).toMatchObject({ ok: true, value: { version: 2 } });
    expect(await t.licences.setTariff(t.direction, { monthlyCents: 500, reason: 'ab' })).toEqual({ ok: false, rule: null, code: 'bad_reason' });
    expect(await t.licences.setTariff(t.direction, { monthlyCents: 500, reason: 'a'.repeat(201) })).toEqual({ ok: false, rule: null, code: 'bad_reason' });
    await t.tariff(29900);
    expect(await t.tariff(29900)).toEqual({ ok: false, rule: 'R655', code: 'tarif_inchange' });
    // Une remise ne peut pas se demander : un champ de prix est inconnu.
    for (const extra of [{ monthlyCents: 100 }, { remise: 50 }, { price: 1 }]) expect(await t.grant(extra)).toEqual({ ok: false, rule: 'R655', code: 'unknown_field' });
    const first = await t.granted();
    expect(first.monthlyCents).toBe(29900);
    // La base refuse un autre prix que celui du tarif, et un tarif qui n'est plus en vigueur, même écrits à la main.
    const phase5 = (await t.db.first<{ evidence_hash: string }>('SELECT evidence_hash FROM phase_openings WHERE network_id = ? AND phase = 5', [t.network.id]))!.evidence_hash;
    t.raw.prepare("INSERT INTO networks (id, name, created_at) VALUES ('agence-y', 'Agence Y', '2028-01-10')").run();
    const insert = (version: number, cents: number) =>
      t.raw
        .prepare(
          "INSERT INTO software_licences (id, network_id, licensee_network_id, agency_name, siren, card_number, card_expires_on, department, tariff_version, monthly_cents, phase5_hash, granted_by, granted_at) VALUES (?, ?, 'agence-y', 'Agence Y', '222222226', 'CPI 7501 2027 000 000 002', '2030-01-01', '75', ?, ?, ?, 'direction:x', '2028-01-10')",
        )
        .run(`l-${version}-${cents}`, t.network.id, version, cents, phase5);
    expect(() => insert(3, 19900)).toThrow(/tarif publié/);
    await t.tariff(34900);
    expect(() => insert(3, 29900)).toThrow(/tarif publié/);
    // Un nouveau tarif ne change pas la licence déjà donnée : elle est dite à l'ancien tarif.
    const second = await t.granted({ siren: '987654324' });
    expect(second).toMatchObject({ tariffVersion: 4, monthlyCents: 34900 });
    const list = await t.licences.list(t.direction);
    if (!list.ok) throw new Error(list.code);
    expect(list.value.tariff).toMatchObject({ version: 4, monthlyCents: 34900 });
    expect(list.value.licences.map((l) => [l.monthlyCents, l.oldTariff])).toEqual([
      [29900, true],
      [34900, false],
    ]);
    // Le tarif public : le prix en vigueur et chaque changement daté, sans agence ni nombre.
    t.setClock('2028-01-11T09:00:00.000Z');
    const pub = await t.licences.publicTariff(t.network.id);
    expect(pub).toEqual({
      current: { monthlyCents: 34900, since: '2028-01-10T09:00:00.000Z' },
      history: [
        { monthlyCents: 100, from: '2028-01-10T09:00:00.000Z' },
        { monthlyCents: 10_000_000, from: '2028-01-10T09:00:00.000Z' },
        { monthlyCents: 29900, from: '2028-01-10T09:00:00.000Z' },
        { monthlyCents: 34900, from: '2028-01-10T09:00:00.000Z' },
      ],
    });
    expect(JSON.stringify(pub)).not.toMatch(/Agence|123456782|licence/i);
  });

  it('[R656, R17] une licence se suspend, reprend ou se termine avec une raison ; terminée, elle ne bouge plus ; rien ne change ni ne s’efface', async () => {
    const t = await setup();
    await t.openPhase5();
    await t.tariff(29900);
    const { id } = await t.granted();
    const decide = (state: unknown, licenceId: unknown = id, reason = 'Raison d’essai') => t.licences.decide(t.direction, { licenceId, state, reason });
    expect(await decide('active')).toEqual({ ok: false, rule: 'R656', code: 'etat_inchange' });
    expect(await decide('effacee')).toEqual({ ok: false, rule: 'R656', code: 'bad_state' });
    expect(await decide('suspendue', id, ' ')).toEqual({ ok: false, rule: null, code: 'bad_reason' });
    expect(await decide('suspendue', id, 'ab')).toEqual({ ok: false, rule: null, code: 'bad_reason' });
    expect(await decide('suspendue', id, 'a'.repeat(201))).toEqual({ ok: false, rule: null, code: 'bad_reason' });
    expect(await decide('suspendue', 'inconnue')).toEqual({ ok: false, rule: null, code: 'not_found' });
    expect(await decide('suspendue')).toMatchObject({ ok: true, value: { version: 1, state: 'suspendue' } });
    expect(await decide('active')).toMatchObject({ ok: true, value: { version: 2, state: 'active' } });
    expect(await decide('terminee')).toMatchObject({ ok: true, value: { version: 3, state: 'terminee' } });
    expect(await decide('active')).toEqual({ ok: false, rule: 'R656', code: 'terminee' });
    // La base refuse une reprise après la fin, un trou de version, un changement et un effacement.
    const insert = (version: number, state: string) =>
      t.raw.prepare("INSERT INTO licence_states (licence_id, version, state, reason, decided_by, decided_at) VALUES (?, ?, ?, 'essai', 'direction:x', '2028-01-10')").run(id, version, state);
    expect(() => insert(4, 'active')).toThrow(/terminée/);
    expect(() => insert(6, 'active')).toThrow(/hors suite/);
    expect(() => t.raw.prepare("UPDATE licence_states SET state = 'active' WHERE licence_id = ?").run(id)).toThrow(/ne change plus/);
    expect(() => t.raw.prepare('DELETE FROM licence_states WHERE licence_id = ?').run(id)).toThrow(/efface/);
    expect(() => t.raw.prepare("UPDATE software_licences SET monthly_cents = 1 WHERE id = ?").run(id)).toThrow(/ne change plus/);
    expect(() => t.raw.prepare('DELETE FROM software_licences WHERE id = ?').run(id)).toThrow(/efface/);
    expect(() => t.raw.prepare('UPDATE licence_tariffs SET monthly_cents = 1').run()).toThrow(/ne change plus/);
    expect(() => t.raw.prepare('DELETE FROM licence_tariffs').run()).toThrow(/efface/);
    expect((await t.events('licences.etat')).map((e) => e.state)).toEqual(['suspendue', 'active', 'terminee']);
  });

  it('[R656] une carte professionnelle échue se dit à chaque lecture, rien ne se coupe seul', async () => {
    const t = await setup();
    await t.openPhase5();
    await t.tariff(29900);
    const { licenseeNetworkId } = await t.granted({ cardExpiresOn: '2028-03-31' });
    const read = async () => {
      const r = await t.licences.list(t.direction);
      if (!r.ok) throw new Error(r.code);
      return r.value.licences[0]!;
    };
    expect(await read()).toMatchObject({ cardExpired: false, state: 'active' });
    // Le 31 mars à 23 h 30 à Paris, la carte vaut encore ; le 1er avril à 0 h 30, elle est échue.
    t.setClock('2028-03-31T21:30:00.000Z');
    expect(await read()).toMatchObject({ cardExpired: false });
    t.setClock('2028-03-31T22:30:00.000Z');
    expect(await read()).toMatchObject({ cardExpired: true, state: 'active' });
    const mine = await t.licences.mine(t.as('direction', 'agence-dir', licenseeNetworkId));
    expect(mine).toMatchObject({ ok: true, value: { cardExpired: true, state: 'active' } });
  });

  it('[R657] [R16] l’agence ne lit que sa licence, ne donne aucune licence et ne voit rien du réseau ni des autres agences', async () => {
    const t = await setup();
    await t.openPhase5();
    await t.tariff(29900);
    const a = await t.granted();
    await t.granted({ siren: '111111118', agencyName: 'Agence des Prés (essai)' });
    const agence = t.as('direction', 'agence-dir', a.licenseeNetworkId);
    const mine = await t.licences.mine(agence);
    if (!mine.ok) throw new Error(mine.code);
    expect(mine.value).toMatchObject({ id: a.id, agencyName: AGENCE.agencyName, monthlyCents: 29900, state: 'active' });
    expect(JSON.stringify(mine.value)).not.toMatch(/Prés|111111118|123456782/);
    // Une agence sous licence ne donne, ne règle et ne lit rien de ce que donne un réseau.
    expect(await t.licences.list(agence)).toEqual({ ok: false, rule: 'R657', code: 'agence_licenciee' });
    expect(await t.licences.setTariff(agence, { monthlyCents: 100, reason: 'Essai' })).toEqual({ ok: false, rule: 'R657', code: 'agence_licenciee' });
    expect(await t.licences.grant(agence, { ...AGENCE, siren: '222222226' })).toEqual({ ok: false, rule: 'R657', code: 'agence_licenciee' });
    expect(await t.licences.decide(agence, { licenceId: a.id, state: 'suspendue', reason: 'Essai' })).toEqual({ ok: false, rule: 'R657', code: 'agence_licenciee' });
    // Le réseau qui donne n'a pas de licence à lire ; un autre réseau ne voit pas les licences d'un autre.
    expect(await t.licences.mine(t.direction)).toEqual({ ok: false, rule: 'R657', code: 'pas_de_licence' });
    // Chaque lecture est écrite au journal, celle de l'agence sur sa seule licence.
    expect((await t.db.all<{ subject: string }>("SELECT subject FROM journal WHERE type = 'licences.lecture'")).map((e) => e.subject)).toEqual([`licence:${a.id}`]);
    const otherDir = t.as('direction', 'direction-2', t.other.id);
    const otherList = await t.licences.list(otherDir);
    expect(otherList).toMatchObject({ ok: true, value: { tariff: null, licences: [] } });
    expect(await t.licences.decide(otherDir, { licenceId: a.id, state: 'suspendue', reason: 'Essai' })).toEqual({ ok: false, rule: null, code: 'not_found' });
    // La base refuse qu'un réseau qui donne des licences en reçoive une, et qu'une agence sous licence en donne une,
    // même écrites à la main avec une phase 5 ouverte et le bon tarif.
    await t.openPhase5(otherDir);
    await t.licences.setTariff(otherDir, { monthlyCents: 100, reason: 'Essai' });
    const phase5 = (await t.db.first<{ evidence_hash: string }>('SELECT evidence_hash FROM phase_openings WHERE network_id = ? AND phase = 5', [t.other.id]))!.evidence_hash;
    const insert = (id: string, licensee: string, network = t.other.id, hash = phase5) =>
      t.raw
        .prepare(
          "INSERT INTO software_licences (id, network_id, licensee_network_id, agency_name, siren, card_number, card_expires_on, department, tariff_version, monthly_cents, phase5_hash, granted_by, granted_at) VALUES (?, ?, ?, 'Agence Z', '222222226', 'CPI 7501 2027 000 000 003', '2030-01-01', '75', 1, 100, ?, 'direction:x', '2028-01-10')",
        )
        .run(id, network, licensee, hash);
    expect(() => insert('l8', t.network.id)).toThrow(/ne donne pas de licence/);
    t.raw.prepare("INSERT INTO networks (id, name, created_at) VALUES ('agence-w', 'Agence W', '2028-01-10')").run();
    // Le même geste vers une agence neuve passe : seul le sens était refusé.
    expect(() => insert('l9', 'agence-w')).not.toThrow();
    // Une agence sous licence (agence-w, licenciée par l'autre réseau) ne donne pas de licence.
    t.raw.prepare("INSERT INTO networks (id, name, created_at) VALUES ('agence-v', 'Agence V', '2028-01-10')").run();
    // Phase 5 ouverte et tarif réglé pour agence-w, pour que seul le sens soit en cause.
    const agenceW = t.as('direction', 'w', 'agence-w');
    await t.openPhase5(agenceW);
    t.raw.prepare("INSERT INTO licence_tariffs (network_id, version, monthly_cents, reason, decided_by, decided_at) VALUES ('agence-w', 1, 100, 'essai', 'direction:w', '2028-01-10')").run();
    const phase5W = (await t.db.first<{ evidence_hash: string }>("SELECT evidence_hash FROM phase_openings WHERE network_id = 'agence-w' AND phase = 5"))!.evidence_hash;
    expect(() => insert('l10', 'agence-v', 'agence-w', phase5W)).toThrow(/ne donne pas de licence/);
    expect(await t.licences.list(t.as('direction', 'w', 'agence-w'))).toEqual({ ok: false, rule: 'R657', code: 'agence_licenciee' });
  });

  it('[R16] la direction seule : tout autre rôle est refusé, et le refus écrit au journal', async () => {
    const t = await setup();
    await t.openPhase5();
    await t.tariff(29900);
    const { id } = await t.granted();
    for (const role of ['agent', 'conformite', 'partenaire', 'client']) {
      const v = t.as(role, `${role}-1`);
      expect(await t.licences.setTariff(v, { monthlyCents: 100, reason: 'Essai' })).toEqual({ ok: false, rule: 'R16', code: 'role' });
      expect(await t.licences.grant(v, { ...AGENCE, siren: '222222226' })).toEqual({ ok: false, rule: 'R16', code: 'role' });
      expect(await t.licences.decide(v, { licenceId: id, state: 'suspendue', reason: 'Essai' })).toEqual({ ok: false, rule: 'R16', code: 'role' });
      expect(await t.licences.list(v)).toEqual({ ok: false, rule: 'R16', code: 'role' });
      expect(await t.licences.mine(v)).toEqual({ ok: false, rule: 'R16', code: 'role' });
    }
    expect((await t.events('acces.refuse')).filter((e) => String(e.kind).startsWith('licence_'))).toHaveLength(20);
    expect(await t.db.first<{ n: number }>('SELECT COUNT(*) AS n FROM software_licences')).toEqual({ n: 1 });
    expect(await t.licences.grant(t.direction, ['x'])).toEqual({ ok: false, rule: null, code: 'bad_shape' });
  });
});
