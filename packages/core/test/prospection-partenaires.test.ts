import { describe, expect, it } from 'vitest';
import { FicheClient, SqlJournalStore, applyMigrations, fromSyncSqlite, type SqlDatabase } from '../src/index.ts';
import { PROMISE_WORDS, PROSPECT_MAILS_PER_WORKING_DAY, Prospection, prospectText } from '../src/partenaires/index.ts';
import { checkText } from '../src/envoi/texte.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

// Réseau, direction et futurs partenaires inventés, sur des domaines réservés aux exemples.
// Le 12 juillet 2027 est un lundi, le 14 juillet férié, le 18 un dimanche ; Paris est à UTC+2.
let clock = Date.parse('2027-07-12T08:00:00.000Z');
const set = (iso: string): void => {
  clock = Date.parse(iso);
};
let n = 0;
const uuid = (): string => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
const BASE = 'https://aimmo.example/opposition/';

async function setup(options: { optOutBase?: string | null } = {}) {
  set('2027-07-12T08:00:00.000Z');
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  const now = (): Date => new Date((clock += 1000));
  const journal = new SqlJournalStore(db);
  const store = new FicheClient(db, { now });
  const prospection = new Prospection(db, journal, { now, newId: uuid, optOutBase: 'optOutBase' in options ? options.optOutBase : BASE });
  const network = await store.createNetwork('Réseau Essai');
  const alex = await store.createAgent({ networkId: network.id, firstName: 'Alex', lastName: 'Essai' });
  const dir = { role: 'direction' as const, userId: 'dir-1', networkId: network.id };
  const agent = { role: 'agent' as const, userId: alex.id, networkId: network.id };
  const add = (i: number, extra: Record<string, unknown> = {}) =>
    prospection.add(dir, { email: `contact${String.fromCharCode(96 + i)}@cabinet-${String.fromCharCode(96 + i)}.example`, addressKind: 'professionnelle', trade: 'notaire', businessName: `Étude Essai ${i}`, source: 'Annuaire public des études, page inventée', ...extra });
  return { db, journal, prospection, network, dir, agent, add };
}

describe('U08 · texte du premier mail', () => {
  it('[R06] [R07] [R79] le texte ne promet rien, ne parle pas de l’IA et passe le contrôle des textes', () => {
    for (const trade of ['notaire', 'diagnostiqueur', 'courtier', 'artisan', 'gestionnaire'] as const) {
      const text = prospectText('Réseau Essai', trade);
      expect(checkText(text, { audience: 'client', channel: 'email', figures: [] }).filter((p) => p.rule !== 'R08'), trade).toEqual([]);
      expect(text).not.toMatch(PROMISE_WORDS);
      expect(text).not.toMatch(/\bIA\b|intelligence artificielle|mandataire|gratuit/i);
      expect(text).toContain("réseau d'agents immobiliers");
    }
  });
});

describeWithSqlite('U08 · prospection de nouveaux partenaires', () => {
  it('[R79] seulement une adresse déclarée professionnelle, un métier connu, une source', async () => {
    const t = await setup();
    expect(await t.add(1, { addressKind: 'personnelle' })).toMatchObject({ ok: false, rule: 'R79', code: 'not_professional' });
    expect(await t.add(1, { addressKind: undefined })).toMatchObject({ ok: false, rule: 'R79' });
    expect(await t.add(1, { email: 'pas-une-adresse' })).toMatchObject({ ok: false, code: 'bad_email' });
    expect(await t.add(1, { trade: 'voyant' })).toMatchObject({ ok: false, code: 'unknown_trade' });
    expect(await t.add(1, { source: '' })).toMatchObject({ ok: false, code: 'bad_source' });
    expect(await t.add(1)).toMatchObject({ ok: true });
    // La base refuse aussi une adresse qui ne serait pas professionnelle.
    await expect(
      t.db.run("INSERT INTO partner_prospects (id, network_id, email, address_kind, trade, business_name, source, added_by, added_at) VALUES ('x', ?, 'perso@essai.example', 'personnelle', 'notaire', 'Essai', 'Source', 'd', 'a')", [t.network.id]),
    ).rejects.toThrow();
  });

  it('[R05] une même adresse n’est rangée qu’une fois, casse comprise', async () => {
    const t = await setup();
    expect((await t.add(1)).ok).toBe(true);
    expect(await t.add(1, { email: 'ContactA@Cabinet-A.example' })).toMatchObject({ ok: false, rule: 'R05', code: 'already_listed' });
  });

  it('[R03] [R79] tant que H32 n’est pas tranché, le contrôle central refuse sous R03 : brouillons seulement, rien ne part', async () => {
    const t = await setup();
    for (let i = 1; i <= 3; i++) await t.add(i);
    expect(await t.prospection.run(t.network.id)).toBe(3);
    const mails = await t.prospection.mailsOf(t.dir, '2027-07-12');
    if (!mails.ok) throw new Error(mails.code);
    expect(mails.value.map((m) => m.decisionRule)).toEqual(['R03', 'R03', 'R03']);
    const reasons = await t.db.all<{ decision_reason: string }>('SELECT decision_reason FROM partner_prospect_mails');
    expect(reasons.every((r) => /accord préalable/i.test(r.decision_reason))).toBe(true);
    // Aucun accord n'est fabriqué pour ces adresses.
    expect(await t.db.all('SELECT 1 FROM consents')).toHaveLength(0);
    for (const table of ['trial_outbox', 'send_log', 'messages']) expect(await t.db.all(`SELECT 1 FROM ${table}`), table).toHaveLength(0);
  });

  it('[R79] deux passages en même temps ne dépassent pas le plafond du jour : la base le tient', async () => {
    const t = await setup();
    for (let i = 1; i <= 12; i++) await t.add(i);
    const [a, b] = await Promise.all([t.prospection.run(t.network.id), t.prospection.run(t.network.id)]);
    expect(a + b).toBe(5);
    expect(await t.db.all("SELECT 1 FROM partner_prospect_mails WHERE day = '2027-07-12'")).toHaveLength(5);
    await expect(
      t.db.run("INSERT INTO partner_prospect_mails (id, network_id, prospect_id, day, text, optout_token_sha256, decision_rule, decision_reason, prepared_at) VALUES ('w', ?, (SELECT id FROM partner_prospects WHERE id NOT IN (SELECT prospect_id FROM partner_prospect_mails) LIMIT 1), '2027-07-12', ?, ?, 'R03', 'r', 'p')", [t.network.id, 'x'.repeat(60), 'e'.repeat(64)]),
    ).rejects.toThrow(/plafond du jour/);
  });

  it('[R79] [R05] au plus 5 premiers mails par jour ouvré, jamais deux fois à la même adresse, rien ne part', async () => {
    const t = await setup();
    expect(PROSPECT_MAILS_PER_WORKING_DAY).toBe(5);
    for (let i = 1; i <= 12; i++) await t.add(i);
    expect(await t.prospection.run(t.network.id)).toBe(5);
    set('2027-07-12T15:00:00.000Z');
    expect(await t.prospection.run(t.network.id)).toBe(0);
    // Le 14 juillet est férié, le dimanche 18 aussi ne compte pas.
    set('2027-07-14T09:00:00.000Z');
    expect(await t.prospection.run(t.network.id)).toBe(0);
    set('2027-07-13T09:00:00.000Z');
    expect(await t.prospection.run(t.network.id)).toBe(5);
    set('2027-07-18T09:00:00.000Z');
    expect(await t.prospection.run(t.network.id)).toBe(0);
    set('2027-07-15T09:00:00.000Z');
    expect(await t.prospection.run(t.network.id)).toBe(2);
    set('2027-07-16T09:00:00.000Z');
    expect(await t.prospection.run(t.network.id)).toBe(0);
    const perAddress = await t.db.all<{ n: number }>('SELECT COUNT(*) AS n FROM partner_prospect_mails GROUP BY prospect_id');
    expect(perAddress).toHaveLength(12);
    expect(perAddress.every((r) => Number(r.n) === 1)).toBe(true);
    const perDay = await t.db.all<{ day: string; n: number }>('SELECT day, COUNT(*) AS n FROM partner_prospect_mails GROUP BY day ORDER BY day');
    expect(perDay.map((r) => [r.day, Number(r.n)])).toEqual([
      ['2027-07-12', 5],
      ['2027-07-13', 5],
      ['2027-07-15', 2],
    ]);
    for (const table of ['trial_outbox', 'send_log', 'messages']) expect(await t.db.all(`SELECT 1 FROM ${table}`), table).toHaveLength(0);
    // La base refuse un deuxième mail à la même adresse.
    const [first] = await t.db.all<{ prospect_id: string }>('SELECT prospect_id FROM partner_prospect_mails LIMIT 1');
    await expect(
      t.db.run("INSERT INTO partner_prospect_mails (id, network_id, prospect_id, day, text, optout_token_sha256, decision_rule, decision_reason, prepared_at) VALUES ('y', ?, ?, '2027-07-16', ?, ?, 'R03', 'r', 'p')", [t.network.id, first!.prospect_id, 'x'.repeat(60), 'c'.repeat(64)]),
    ).rejects.toThrow();
  });

  it('[R01] hors des heures d’envoi, rien n’est préparé ; le passage suivant reprend', async () => {
    const t = await setup();
    await t.add(1);
    set('2027-07-12T19:30:00.000Z');
    expect(await t.prospection.run(t.network.id)).toBe(0);
    const ev = await t.db.all<{ data: string }>("SELECT data FROM journal WHERE type = 'prospection.refusee'");
    expect(JSON.parse(ev[0]!.data)).toMatchObject({ rule: 'R01' });
    set('2027-07-13T06:30:00.000Z');
    expect(await t.prospection.run(t.network.id)).toBe(1);
  });

  it('[R79] [R04] [R02] chaque mail a son lien d’opposition ; une opposition arrête tout, pour toujours', async () => {
    const t = await setup();
    const a = await t.add(1);
    const b = await t.add(2);
    if (!a.ok || !b.ok) throw new Error('ajout');
    expect(await t.prospection.run(t.network.id)).toBe(2);
    const mails = await t.prospection.mailsOf(t.dir, '2027-07-12');
    if (!mails.ok) throw new Error(mails.code);
    expect(mails.value).toHaveLength(2);
    const tokens = mails.value.map((m) => {
      const match = m.text.match(/\nNe plus recevoir de message de notre part : https:\/\/aimmo\.example\/opposition\/([a-z]{32})$/);
      expect(match, m.text).not.toBeNull();
      return match![1]!;
    });
    // Le jeton n'est rangé que par son empreinte.
    expect(JSON.stringify(await t.db.all('SELECT optout_token_sha256 FROM partner_prospect_mails'))).not.toContain(tokens[0]);
    expect(await t.prospection.optOut('inconnuinconnuinconnuinconnuinco')).toBe(false);
    expect(await t.prospection.optOut('12')).toBe(false);
    expect(await t.prospection.optOut(tokens[0])).toBe(true);
    expect(await t.prospection.optOut(tokens[0])).toBe(true);
    const list = await t.prospection.list(t.dir);
    if (!list.ok) throw new Error(list.code);
    expect(list.value.find((p) => p.prospectId === a.value.prospectId)).toMatchObject({ opposed: true, mailedOn: '2027-07-12' });
    expect(list.value.find((p) => p.prospectId === b.value.prospectId)).toMatchObject({ opposed: false });
    // L'adresse opposée ne peut plus être rangée, même écrite autrement.
    expect(await t.add(1, { email: 'CONTACTA@cabinet-a.example' })).toMatchObject({ ok: false, rule: 'R04', code: 'opposed' });
    // Une opposition rangée par la direction avant tout mail : l'adresse n'est jamais écrite.
    const c = await t.add(3);
    if (!c.ok) throw new Error('ajout');
    expect(await t.prospection.oppose(t.dir, c.value.prospectId)).toEqual({ ok: true, value: true });
    set('2027-07-13T09:00:00.000Z');
    expect(await t.prospection.run(t.network.id)).toBe(0);
    // La base refuse elle-même un mail à une adresse opposée, même écrit sans passer par le code.
    await expect(
      t.db.run("INSERT INTO partner_prospect_mails (id, network_id, prospect_id, day, text, optout_token_sha256, decision_rule, decision_reason, prepared_at) VALUES ('z', ?, ?, '2027-07-13', ?, ?, 'R03', 'r', 'p')", [t.network.id, c.value.prospectId, 'x'.repeat(60), 'd'.repeat(64)]),
    ).rejects.toThrow(/adresse opposée/);
    await expect(t.db.run('DELETE FROM partner_prospect_optouts')).rejects.toThrow(/rien ne s'efface/);
  });

  it('[R79] sans lien d’opposition réglé, aucun mail n’est préparé', async () => {
    const t = await setup({ optOutBase: null });
    await t.add(1);
    expect(await t.prospection.run(t.network.id)).toBe(0);
    expect(await t.db.all("SELECT 1 FROM journal WHERE type = 'prospection.sans_opposition'")).toHaveLength(1);
    expect(() => new Prospection(t.db, t.journal, { optOutBase: 'http://aimmo.example/' })).toThrow();
    expect(() => new Prospection(t.db, t.journal, { perWorkingDay: 6 })).toThrow();
  });

  it('[R16] seule la direction prospecte ; chaque refus au journal', async () => {
    const t = await setup();
    const a = await t.add(1);
    if (!a.ok) throw new Error('ajout');
    expect(await t.prospection.add(t.agent, { email: 'x@essai.example', addressKind: 'professionnelle', trade: 'notaire', businessName: 'Essai', source: 'Source' })).toMatchObject({ ok: false, rule: 'R16' });
    expect(await t.prospection.list(t.agent)).toMatchObject({ ok: false, rule: 'R16' });
    expect(await t.prospection.oppose(t.agent, a.value.prospectId)).toMatchObject({ ok: false, rule: 'R16' });
    expect(await t.prospection.mailsOf(t.agent, '2027-07-12')).toMatchObject({ ok: false, rule: 'R16' });
    expect(await t.db.all("SELECT 1 FROM journal WHERE type = 'acces.refuse'")).toHaveLength(4);
  });

  it('[R13] aucune adresse ni aucun nom d’entreprise au journal', async () => {
    const t = await setup();
    await t.add(1);
    await t.prospection.run(t.network.id);
    const [m] = await t.db.all<{ text: string }>('SELECT text FROM partner_prospect_mails');
    await t.prospection.optOut(m!.text.slice(-32));
    const text = JSON.stringify(await t.db.all('SELECT * FROM journal'));
    expect(text).not.toMatch(/cabinet-a|contacta|Étude Essai/i);
    expect(text).toContain('prospection.opposition');
  });
});
