// RC25 : une offre d'un acquéreur qui a visité le bien à distance sans signer son bon est refusée en mots [R505].
// Biens, acquéreurs, visites et offres inventés.
import { expect, it } from 'vitest';
import type { SqlDatabase } from '../src/db/sql.ts';
import { RegistreOffres, remoteSlipMissing } from '../src/offres/index.ts';
import { setupOffre } from './offres-jeu.ts';
import { describeWithSqlite } from './sqlite.ts';

type Jeu = Awaited<ReturnType<typeof setupOffre>>;

let n = 0;
/** Une visite faite à distance du bien par cette fiche, finie, sans bon signé. */
async function remoteVisit(t: Jeu, personId: string, propertyId = t.propertyId): Promise<string> {
  n += 1;
  const id = `rdv-distance-${n}`;
  const start = '2027-02-26T09:00:00.000Z';
  const end = '2027-02-26T09:45:00.000Z';
  const project = await t.store.createProject({ networkId: t.network.id, agentId: t.alexId, personId, kind: 'buy', note: '' });
  await t.db.run(
    "INSERT INTO appointments (id, network_id, agent_id, person_id, property_id, kind, start_at, end_at, status, token_hash, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'visite', ?, ?, 'honored', ?, 'agent', ?, ?)",
    [id, t.network.id, t.alexId, personId, propertyId, start, end, `jeton-${id}`, start, start],
  );
  await t.db.run('INSERT INTO visits (appointment_id, network_id, property_id, project_id, person_id, agent_id, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [
    id, t.network.id, propertyId, project.id, personId, t.alexId, 'test', start,
  ]);
  await t.db.run('INSERT INTO remote_visits (appointment_id, network_id, property_id, person_id, started_by, started_at, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [
    id, t.network.id, propertyId, personId, `agent:${t.alexId}`, start, end,
  ]);
  return id;
}

async function merge(t: Jeu, survivorId: string, mergedId: string): Promise<void> {
  n += 1;
  const at = '2027-02-27T10:00:00.000Z';
  await t.db.run('INSERT INTO person_merges (id, network_id, agent_id, survivor_id, merged_id, reason, merged_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [
    `fusion-${n}`, t.network.id, t.alexId, survivorId, mergedId, 'doublon', at, at,
  ]);
}

const count = async (t: Jeu): Promise<number> => (await t.db.first<{ n: number }>('SELECT COUNT(*) AS n FROM offer_register WHERE property_id = ?', [t.propertyId]))!.n;

describeWithSqlite('RC25 · une offre sans le bon de la visite à distance', () => {
  it('[R505] bon non signé : refus en mots qui nomme le rendez-vous, aucune ligne au registre, aucun rang pris', async () => {
    const t = await setupOffre();
    const rdv = await remoteVisit(t, t.buyerId);
    expect(await t.offres.record(t.agent, t.propertyId, t.input())).toEqual({ ok: false, rule: 'R505', code: 'remote_slip_unsigned', appointmentId: rdv });
    expect(await count(t)).toBe(0);
    // Un autre acquéreur, qui n'a pas visité à distance, prend le premier rang.
    const other = await t.store.createPerson({ networkId: t.network.id, agentId: t.alexId, firstName: 'Paul', lastName: 'Autre' });
    expect(await t.record({ buyerPersonId: other.id })).toMatchObject({ seq: 1, buyerPersonId: other.id });
  });

  it('[R505] une visite à distance d\'un autre bien ne gêne pas l\'offre sur celui-ci', async () => {
    const t = await setupOffre();
    const ailleurs = await t.store.createProperty({ networkId: t.network.id, agentId: t.alexId, reference: 'B-AILLEURS', kind: 'home', city: 'Talant', priceEur: 180_000, surfaceM2: 70, rooms: 3, status: 'available' });
    await remoteVisit(t, t.buyerId, ailleurs.id);
    expect(await t.record()).toMatchObject({ seq: 1, buyerPersonId: t.buyerId });
  });

  it('[R505] bon signé : l\'offre entre', async () => {
    const t = await setupOffre();
    const rdv = await remoteVisit(t, t.buyerId);
    expect(await remoteSlipMissing(t.db, t.network.id, t.propertyId, t.buyerId)).toBe(rdv);
    // Le bon signé, posé comme le ferait la signature en ligne de HX44, gardes de la base levées le temps du jeu.
    const triggers = await t.db.all<{ name: string; sql: string }>("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'remote_slip_signatures'");
    for (const tr of triggers) await t.db.run(`DROP TRIGGER ${tr.name}`);
    await t.db.run('PRAGMA foreign_keys = OFF');
    await t.db.run(
      "INSERT INTO remote_slip_signatures (id, network_id, appointment_id, slip_id, slip_hash, token_hash, code_hash, code_expires_at, link_expires_at, status, signed_at, proof, created_by, created_at) VALUES ('sig-1', ?, ?, 'bon-1', ?, ?, ?, ?, ?, 'signee', ?, '{}', 'test', ?)",
      [t.network.id, rdv, 'a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64), '2027-02-26T10:00:00.000Z', '2027-02-27T10:00:00.000Z', '2027-02-26T09:50:00.000Z', '2027-02-26T09:46:00.000Z'],
    );
    await t.db.run('PRAGMA foreign_keys = ON');
    expect(await remoteSlipMissing(t.db, t.network.id, t.propertyId, t.buyerId)).toBeNull();
    expect(await t.record()).toMatchObject({ seq: 1, buyerPersonId: t.buyerId });
  });

  it('[R505] une fiche réunie, de tête ou du milieu de la suite, reçoit le même refus', async () => {
    const t = await setupOffre();
    const rdv = await remoteVisit(t, t.buyerId);
    // Une suite de quatre réunions au-dessus de la fiche du visiteur.
    let head = t.buyerId;
    const chain = [head];
    for (let i = 0; i < 4; i++) {
      const next = await t.store.createPerson({ networkId: t.network.id, agentId: t.alexId, firstName: 'Acheteur', lastName: 'Exemple' });
      await merge(t, next.id, head);
      head = next.id;
      chain.push(head);
    }
    for (const id of [head, chain[2]!]) {
      const r = await t.offres.record(t.agent, t.propertyId, t.input({ buyerPersonId: id }));
      expect(r).toEqual({ ok: false, rule: 'R505', code: 'remote_slip_unsigned', appointmentId: rdv });
    }
    expect(await count(t)).toBe(0);
  });

  it('[R505] bon manquant apparu entre la lecture et l\'écriture : même refus, jamais une erreur interne', async () => {
    const t = await setupOffre();
    let rdv: string | null = null;
    // La base vue par le registre : la visite à distance se finit juste avant l'écriture de l'offre.
    const db: SqlDatabase = Object.create(t.db, {
      run: {
        value: async (sql: string, params?: unknown[]) => {
          if (rdv === null && /INSERT INTO offer_register/.test(sql)) rdv = await remoteVisit(t, t.buyerId);
          return t.db.run(sql, params as never);
        },
      },
    });
    const offres = new RegistreOffres(db, t.acces, t.journal, { now: t.now });
    const r = await offres.record(t.agent, t.propertyId, t.input());
    expect(rdv).not.toBeNull();
    expect(r).toEqual({ ok: false, rule: 'R505', code: 'remote_slip_unsigned', appointmentId: rdv });
    expect(await count(t)).toBe(0);
    // Une autre erreur de la base n'est jamais prise pour un bon manquant.
    const broken: SqlDatabase = Object.create(t.db, {
      run: { value: async (sql: string, params?: unknown[]) => (/INSERT INTO offer_register/.test(sql) ? Promise.reject(new Error('disque plein')) : t.db.run(sql, params as never)) },
    });
    const other = await t.store.createPerson({ networkId: t.network.id, agentId: t.alexId, firstName: 'Paul', lastName: 'Autre' });
    await expect(new RegistreOffres(broken, t.acces, t.journal, { now: t.now }).record(t.agent, t.propertyId, t.input({ buyerPersonId: other.id }))).rejects.toThrow(/disque plein/);
  });

  it('[R13] au journal, sous la visite, des identifiants seulement ; jamais sous le bien, que lit le vendeur', async () => {
    const t = await setupOffre();
    const rdv = await remoteVisit(t, t.buyerId);
    await t.offres.record(t.agent, t.propertyId, t.input());
    const events = (await t.journal.all()).filter((e) => e.type === 'offre.bon_distance_manquant');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ subject: `visit:${rdv}`, data: { rule: 'R505', property: t.propertyId } });
    expect(Object.keys(events[0]!.data as object).sort()).toEqual(['property', 'rule']);
    expect(JSON.stringify(events[0])).not.toMatch(/Acheteur|Exemple|205000|offres\//);
  });

  it('[R56] un rejeu d\'une offre déjà rangée avec sa clé est rendu tel quel, même si une visite à distance a suivi', async () => {
    const t = await setupOffre();
    const key = 'cle-offre-rc25-0001';
    const first = await t.record({ requestKey: key });
    await remoteVisit(t, t.buyerId);
    expect(await t.offres.record(t.agent, t.propertyId, t.input({ requestKey: key }))).toEqual({ ok: true, value: first });
    // Une nouvelle offre de cet acquéreur, elle, attend le bon.
    expect(await t.offres.record(t.agent, t.propertyId, t.input({ amountEur: 210000 }))).toMatchObject({ ok: false, rule: 'R505', code: 'remote_slip_unsigned' });
    expect(await count(t)).toBe(1);
  });
});

describeWithSqlite('RC25 · une base d\'avant les visites à distance', () => {
  it('[R505] sans les tables de la migration 2304, aucune visite à distance n\'existe : rien n\'est refusé, toute autre erreur remonte', async () => {
    const t = await setupOffre();
    const missing = (table: string): SqlDatabase => Object.create(t.db, { first: { value: async () => Promise.reject(new Error(`no such table: ${table}`)) } });
    expect(await remoteSlipMissing(missing('remote_visits'), t.network.id, t.propertyId, t.buyerId)).toBeNull();
    expect(await remoteSlipMissing(missing('remote_slip_signatures'), t.network.id, t.propertyId, t.buyerId)).toBeNull();
    await expect(remoteSlipMissing(missing('person_merges'), t.network.id, t.propertyId, t.buyerId)).rejects.toThrow(/person_merges/);
    await expect(remoteSlipMissing(missing('remote_visits_bis'), t.network.id, t.propertyId, t.buyerId)).rejects.toThrow(/remote_visits_bis/);
  });
});
