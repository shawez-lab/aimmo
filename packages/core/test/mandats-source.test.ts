import { expect, it } from 'vitest';
import { Acces, FicheClient, FicheUnique, Mandats, SqlJournalStore, applyMigrations, fromSyncSqlite, type SqlDatabase } from '../src/index.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

const NOW = Date.parse('2027-02-10T10:00:00.000Z');
const DAY = 86_400_000;

async function setup() {
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  const now = (): Date => new Date(NOW);
  const journal = new SqlJournalStore(db);
  const store = new FicheClient(db, { now });
  const fiche = new FicheUnique(db, store, { now });
  const acces = new Acces(db, store, fiche, journal, { now });
  const mandats = new Mandats(db, fiche, journal, { now });
  const network = await store.createNetwork('Réseau test');
  const alex = await store.createAgent({ networkId: network.id, firstName: 'Alex', lastName: 'Agent' });
  const sam = await store.createAgent({ networkId: network.id, firstName: 'Sam', lastName: 'Agent' });
  const person = async (agentId: string, who: string, channel: string | null = null) => {
    const p = await store.createPerson({ networkId: network.id, agentId, firstName: who });
    if (channel) await store.addSource({ networkId: network.id, agentId, personId: p.id, channel, detail: 'test', occurredAt: new Date(NOW - 30 * DAY) });
    return p.id;
  };
  const as = (role: 'agent' | 'direction' | 'partner', userId: string) => ({ role, userId, networkId: network.id });
  return { db, journal, store, acces, mandats, network, alex, sam, person, as };
}

describeWithSqlite('G03 · chaque mandat a sa source', () => {
  it('[R38] un mandat se range avec la source donnée, ou reprise de la fiche ; sans l’une ni l’autre, refusé', async () => {
    const t = await setup();
    const a = await t.person(t.alex.id, 'Léa');
    const b = await t.person(t.alex.id, 'Noé', 'instagram');
    const c = await t.person(t.alex.id, 'Ugo', 'gohighlevel');
    const me = t.as('agent', t.alex.id);
    expect(await t.mandats.record(t.acces, me, { personId: a, signedAt: new Date(NOW), source: 'referral' })).toMatchObject({ ok: true, source: 'referral', fromFiche: false });
    expect(await t.mandats.record(t.acces, me, { personId: b, signedAt: new Date(NOW) })).toMatchObject({ ok: true, source: 'social', fromFiche: true });
    // Une reprise d'outil ne dit pas d'où vient la personne : l'agent doit donner la source.
    expect(await t.mandats.record(t.acces, me, { personId: c, signedAt: new Date(NOW) })).toEqual({ ok: false, rule: 'R38', code: 'missing_source' });
    expect(await t.mandats.record(t.acces, me, { personId: a, signedAt: new Date(NOW), source: 'other' })).toEqual({ ok: false, rule: 'R38', code: 'missing_detail' });
    expect(await t.mandats.record(t.acces, me, { personId: a, signedAt: new Date(NOW), source: 'pigeon' })).toEqual({ ok: false, rule: 'R38', code: 'unknown_source' });
    expect(await t.mandats.record(t.acces, me, { personId: a, signedAt: new Date(NOW), source: 'other', sourceDetail: 'salon de l’habitat' })).toMatchObject({ ok: true, source: 'other' });
    // La base elle-même refuse un mandat sans source, ou « autre » sans détail.
    await expect(
      t.db.run(`INSERT INTO mandates (id, network_id, agent_id, person_id, signed_at, source_kind, recorded_by, created_at) VALUES ('x', ?, ?, ?, ?, NULL, 'test', ?)`, [t.network.id, t.alex.id, a, new Date(NOW).toISOString(), new Date(NOW).toISOString()]),
    ).rejects.toThrow();
    await expect(
      t.db.run(`INSERT INTO mandates (id, network_id, agent_id, person_id, signed_at, source_kind, recorded_by, created_at) VALUES ('y', ?, ?, ?, ?, 'other', 'test', ?)`, [t.network.id, t.alex.id, a, new Date(NOW).toISOString(), new Date(NOW).toISOString()]),
    ).rejects.toThrow();
    expect(await t.db.all('SELECT source_kind FROM mandates WHERE source_kind IS NULL')).toEqual([]);
  });

  it('[R37] une liste achetée ou les ventes publiques sont refusées, par leur nom comme écrites dans le détail', async () => {
    const t = await setup();
    const a = await t.person(t.alex.id, 'Léa');
    const me = t.as('agent', t.alex.id);
    for (const source of ['purchased_list', 'public_sales', 'DVF']) {
      expect(await t.mandats.record(t.acces, me, { personId: a, signedAt: new Date(NOW), source })).toEqual({ ok: false, rule: 'R37', code: 'forbidden_source' });
    }
    for (const sourceDetail of ['liste achetée chez un courtier', 'fichier de propriétaires acheté', 'ventes publiques DVF', 'données de ventes du quartier']) {
      expect(await t.mandats.record(t.acces, me, { personId: a, signedAt: new Date(NOW), source: 'other', sourceDetail })).toEqual({ ok: false, rule: 'R37', code: 'forbidden_source' });
    }
    await expect(
      t.db.run(`INSERT INTO mandates (id, network_id, agent_id, person_id, signed_at, source_kind, recorded_by, created_at) VALUES ('x', ?, ?, ?, ?, 'purchased_list', 'test', ?)`, [t.network.id, t.alex.id, a, new Date(NOW).toISOString(), new Date(NOW).toISOString()]),
    ).rejects.toThrow();
    expect(await t.db.all('SELECT id FROM mandates')).toEqual([]);
  });

  it('[R16] seul l’agent qui suit la fiche, ou la direction, range un mandat', async () => {
    const t = await setup();
    const a = await t.person(t.alex.id, 'Léa');
    expect(await t.mandats.record(t.acces, t.as('agent', t.sam.id), { personId: a, signedAt: new Date(NOW), source: 'site' })).toMatchObject({ ok: false, rule: 'R16' });
    expect(await t.mandats.record(t.acces, t.as('partner', 'p-1'), { personId: a, signedAt: new Date(NOW), source: 'site' })).toMatchObject({ ok: false, rule: 'R16' });
    const byDirection = await t.mandats.record(t.acces, t.as('direction', 'dir-1'), { personId: a, signedAt: new Date(NOW), source: 'site' });
    expect(byDirection.ok).toBe(true);
    expect(await t.db.all('SELECT agent_id, recorded_by FROM mandates')).toEqual([{ agent_id: t.alex.id, recorded_by: 'direction:dir-1' }]);
  });

  it('le compte du mois par source est juste, à l’heure de Paris, sans donnée personnelle ; chacun ne voit que ses chiffres', async () => {
    const t = await setup();
    const me = t.as('agent', t.alex.id);
    const sam = t.as('agent', t.sam.id);
    const sign = async (agent: typeof me, who: string, at: string, source: string, sourceDetail?: string) => {
      const id = await t.person(agent.userId, who);
      const r = await t.mandats.record(t.acces, agent, { personId: id, signedAt: new Date(at), source, ...(sourceDetail ? { sourceDetail } : {}) });
      expect(r.ok).toBe(true);
    };
    await sign(me, 'Léa', '2027-01-31T23:30:00.000Z', 'site'); // 1er février à 0 h 30 à Paris
    await sign(me, 'Noé', '2027-02-10T09:00:00.000Z', 'referral');
    await sign(me, 'Ugo', '2027-02-27T10:00:00.000Z', 'referral');
    await sign(me, 'Zoé', '2027-01-31T22:30:00.000Z', 'portal'); // 31 janvier à 23 h 30 à Paris
    await sign(sam, 'Paul', '2027-02-05T10:00:00.000Z', 'other', 'M. Inventé, voisin');
    const mine = await t.mandats.monthly(t.acces, me, '2027-02');
    expect(mine).toMatchObject({ ok: true, value: { month: '2027-02', agentId: t.alex.id, total: 3, bySource: { site: 1, referral: 2, portal: 0, other: 0 } } });
    const network = await t.mandats.monthly(t.acces, t.as('direction', 'dir-1'), '2027-02');
    expect(network).toMatchObject({ ok: true, value: { agentId: null, total: 4, bySource: { site: 1, referral: 2, other: 1 } } });
    const january = await t.mandats.monthly(t.acces, t.as('direction', 'dir-1'), '2027-01');
    expect(january.ok && january.value.bySource.portal).toBe(1);
    expect(await t.mandats.monthly(t.acces, me, '2027-02', t.sam.id)).toMatchObject({ ok: true, value: { agentId: t.alex.id } });
    expect(await t.mandats.monthly(t.acces, t.as('partner', 'p-1'), '2027-02')).toMatchObject({ ok: false, rule: 'R16' });
    expect(await t.mandats.monthly(t.acces, me, '2027-13')).toEqual({ ok: false, rule: null, code: 'bad_month' });
    expect(JSON.stringify(network)).not.toMatch(/Inventé|Léa|Paul/);
    // Le journal ne porte ni le détail de la source ni un nom.
    expect(JSON.stringify(await t.journal.all())).not.toMatch(/Inventé|voisin/);
  });

  it('[R17] un mandat rangé ne change plus et ne s’efface pas', async () => {
    const t = await setup();
    const a = await t.person(t.alex.id, 'Léa');
    await t.mandats.record(t.acces, t.as('agent', t.alex.id), { personId: a, signedAt: new Date(NOW), source: 'site' });
    await expect(t.db.run(`UPDATE mandates SET source_kind = 'portal'`)).rejects.toThrow();
    await expect(t.db.run('DELETE FROM mandates')).rejects.toThrow();
  });
});
