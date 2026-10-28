import { expect, it } from 'vitest';
import { FicheClient, SqlJournalStore, applyMigrations, fromSyncSqlite, type SqlDatabase } from '../src/index.ts';
import { computeShares } from '../src/pilotage/index.ts';
import { Parrainage, REFERRAL_TEXT, checkRecruitingText } from '../src/reseau/index.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

// Agents, ventes et montants inventés, en centimes.
let clock = Date.parse('2027-07-13T08:00:00.000Z');

async function setup() {
  clock = Date.parse('2027-07-13T08:00:00.000Z');
  const raw = openMemoryDatabase();
  const db: SqlDatabase = fromSyncSqlite(raw);
  await applyMigrations(db, loadMigrations());
  const now = (): Date => new Date(clock);
  const journal = new SqlJournalStore(db);
  const store = new FicheClient(db, { now });
  const p = new Parrainage(db, journal, { now });
  const network = await store.createNetwork('Réseau test');
  const agent = async (n: string) => (await store.createAgent({ networkId: network.id, firstName: n, lastName: 'Test' })).id;
  const [grand, parrain, filleul, autre] = [await agent('Gaby'), await agent('Paul'), await agent('Fanny'), await agent('Ali')];
  const dir = { role: 'direction' as const, userId: 'dir', networkId: network.id };
  const as = (id: string) => ({ role: 'agent' as const, userId: id, networkId: network.id });
  let n = 0;
  let invoiceNo = 0;
  /**
   * Une commission du filleul, rangée telle que M13 la range (les tables de K01 à K03 sont remplies directement : le
   * cycle complet est éprouvé par leurs propres tests). Rend son dossier.
   */
  const sale = async (o: { agentId?: string; networkShare: number; received?: boolean; invoice?: 'aucune' | 'emise' | 'annulee' | 'annulee_puis_refaite' }) => {
    raw.exec('PRAGMA foreign_keys = OFF');
    const fileId = `dossier-${++n}`;
    const agentId = o.agentId ?? filleul;
    const prime = await p.of(network.id, agentId, o.networkShare);
    const shares = computeShares(o.networkShare * 2, agentId, 5000, [], prime);
    const stamp = new Date(clock).toISOString();
    await db.run("INSERT INTO commissions (file_id, network_id, agent_id, mandate_id, compromis_on, fee_cents, fee_charge, grid_id, created_at) VALUES (?, ?, ?, 'm', '2027-07-01', ?, 'vendeur', 'g', ?)", [fileId, network.id, agentId, o.networkShare * 2, stamp]);
    for (const [i, s] of shares.entries()) {
      await db.run('INSERT INTO commission_shares (file_id, seq, kind, beneficiary_id, reason, amount_cents) VALUES (?, ?, ?, ?, ?, ?)', [fileId, i + 1, s.kind, s.beneficiaryId, s.reason, s.amountCents]);
    }
    const invoice = o.invoice ?? 'emise';
    let k = 0;
    const issue = async (kind: 'honoraires' | 'avoir', corrects: string | null) => {
      const id = `${fileId}-f${++k}`;
      await db.run(
        `INSERT INTO invoices (id, network_id, issuer, year, number, kind, file_id, draft_id, corrects_invoice_id, content, amount_cents, issued_on, validated_by, created_at)
         VALUES (?, ?, 'reseau', 2027, ?, ?, ?, ?, ?, '{}', 0, '2027-07-02', 'dir', ?)`,
        [id, network.id, ++invoiceNo, kind, fileId, kind === 'avoir' ? null : `d-${id}`, corrects, new Date(clock + k * 1000).toISOString()],
      );
      return id;
    };
    if (invoice !== 'aucune') {
      const first = await issue('honoraires', null);
      if (invoice === 'annulee' || invoice === 'annulee_puis_refaite') await issue('avoir', first);
      if (invoice === 'annulee_puis_refaite') await issue('honoraires', null);
    }
    if (o.received ?? true) {
      await db.run("INSERT INTO commission_receipts (file_id, network_id, received_at, proof_ref, payout_due_at, recorded_by, created_at) VALUES (?, ?, ?, 'preuve', ?, 'dir', ?)", [fileId, network.id, stamp, stamp, stamp]);
    }
    raw.exec('PRAGMA foreign_keys = ON');
    return { fileId, prime };
  };
  return { raw, db, journal, store, p, network, grand, parrain, filleul, autre, dir, as, sale };
}

it('[R80] le texte du parrainage ne promet aucun revenu', () => {
  expect(checkRecruitingText(REFERRAL_TEXT).ok).toBe(true);
  expect(REFERRAL_TEXT).toMatch(/sans frais d’entrée/);
});

describeWithSqlite('parrainage dans les règles', () => {
  it('[R83] 10 cas de commissions, avoirs compris : une prime seulement sur une commission encaissée et non annulée', async () => {
    const w = await setup();
    await w.p.setRules(w.dir, { rateBp: 1000 });
    expect(await w.p.recordSponsor(w.dir, w.filleul, w.parrain)).toEqual({ ok: true });
    const cases = [
      { name: 'encaissée', o: { networkShare: 500_000 }, shown: 50_000 },
      { name: 'encaissée, centimes arrondis au-dessous', o: { networkShare: 123_459 }, shown: 12_345 },
      { name: 'prévue, pas encore encaissée', o: { networkShare: 400_000, received: false }, shown: 0 },
      { name: 'encaissée, facture annulée par un avoir', o: { networkShare: 300_000, invoice: 'annulee' as const }, shown: 0 },
      { name: 'encaissée, avoir puis nouvelle facture', o: { networkShare: 200_000, invoice: 'annulee_puis_refaite' as const }, shown: 20_000 },
      { name: 'sans facture d’honoraires', o: { networkShare: 100_000, invoice: 'aucune' as const }, shown: 0 },
      { name: 'part du réseau nulle', o: { networkShare: 0 }, shown: 0 },
      { name: 'vente d’un agent sans parrain', o: { networkShare: 500_000, agentId: w.autre }, shown: 0 },
      { name: 'vente du parrain lui-même', o: { networkShare: 500_000, agentId: w.parrain }, shown: 0 },
      { name: 'encaissée, petite part', o: { networkShare: 9 }, shown: 0 },
    ];
    const before = (await w.p.primesOf(w.as(w.parrain), w.parrain));
    expect(before.ok && before.value.primes).toEqual([]);
    const files: Record<string, string> = {};
    for (const c of cases) files[c.name] = (await w.sale(c.o)).fileId;
    const r = await w.p.primesOf(w.as(w.parrain), w.parrain);
    if (!r.ok) throw new Error(r.code);
    const shown = Object.fromEntries(r.value.primes.map((x) => [x.fileId, x.amountCents]));
    for (const c of cases) expect([c.name, shown[files[c.name]!] ?? 0]).toEqual([c.name, c.shown]);
    expect(r.value.totalCents).toBe(82_345);
  });

  it('[R83] aucune prime à l\'arrivée d\'un agent, ni sans taux réglé', async () => {
    const w = await setup();
    await w.p.recordSponsor(w.dir, w.filleul, w.parrain);
    // L'arrivée seule ne crée rien.
    expect(await w.db.first("SELECT 1 FROM commission_shares WHERE kind = 'parrainage'")).toBeNull();
    const r = await w.p.primesOf(w.as(w.parrain), w.parrain);
    expect(r.ok && r.value.totalCents).toBe(0);
    // Sans taux écrit par la direction, aucune prime, même sur une vente encaissée.
    expect(await w.p.of(w.network.id, w.filleul, 500_000)).toBeNull();
    await w.p.setRules(w.dir, { rateBp: 0 });
    expect(await w.p.of(w.network.id, w.filleul, 500_000)).toBeNull();
    await w.p.setRules(w.dir, { rateBp: 800 });
    expect(await w.p.of(w.network.id, w.filleul, 500_000)).toEqual({ parrainId: w.parrain, amountCents: 40_000 });
  });

  it('[R83] au-delà du nombre de niveaux réglé (1), aucune prime ; plus d\'un niveau est refusé', async () => {
    const w = await setup();
    await w.p.setRules(w.dir, { rateBp: 1000 });
    await w.p.recordSponsor(w.dir, w.parrain, w.grand);
    await w.p.recordSponsor(w.dir, w.filleul, w.parrain);
    await w.sale({ networkShare: 500_000 });
    const grand = await w.p.primesOf(w.as(w.grand), w.grand);
    expect(grand.ok && grand.value.primes).toEqual([]);
    const parrain = await w.p.primesOf(w.as(w.parrain), w.parrain);
    expect(parrain.ok && parrain.value.totalCents).toBe(50_000);
    expect(await w.p.setRules(w.dir, { rateBp: 1000, levels: 2 })).toEqual({ ok: false, rule: 'R83', code: 'levels_not_allowed' });
    await expect(w.db.run("INSERT INTO referral_settings (id, network_id, rate_bp, levels, written_by, written_at) VALUES ('x', ?, 100, 2, 'dir', '2027-01-01')", [w.network.id])).rejects.toThrow();
  });

  it('[R83] un parrain parti ne touche rien de nouveau ; ce qui était encaissé avant reste', async () => {
    const w = await setup();
    await w.p.setRules(w.dir, { rateBp: 1000 });
    await w.p.recordSponsor(w.dir, w.filleul, w.parrain);
    await w.sale({ networkShare: 500_000 });
    await w.db.run("UPDATE agents SET status = 'left' WHERE id = ?", [w.parrain]);
    const after = await w.sale({ networkShare: 300_000 });
    expect(after.prime).toBeNull();
    const r = await w.p.primesOf(w.dir, w.parrain);
    expect(r.ok && r.value.primes.map((x) => x.amountCents)).toEqual([50_000]);
  });

  it('[R83] aucun frais d\'entrée nulle part : aucune colonne, aucun montant à l\'arrivée', async () => {
    const w = await setup();
    const tables = await w.db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'");
    for (const { name } of tables) {
      const cols = (await w.db.all<{ name: string }>(`SELECT name FROM pragma_table_info('${name}')`)).map((c) => c.name);
      expect([name, cols.filter((c) => /entry_fee|joining_fee|frais_entree|droit_entree|fee_entry|signup_fee/.test(c))]).toEqual([name, []]);
    }
    for (const t of ['sponsorships', 'referral_settings']) {
      const cols = (await w.db.all<{ name: string }>(`SELECT name FROM pragma_table_info('${t}')`)).map((c) => c.name);
      expect(cols.some((c) => /amount|cents|eur|fee/.test(c))).toBe(false);
    }
  });

  it('[R16] le parrain se range une fois, à l\'entrée, par la direction ; ses primes ne sont lues que par lui et la direction', async () => {
    const w = await setup();
    await w.p.setRules(w.dir, { rateBp: 1000 });
    expect(await w.p.recordSponsor(w.as(w.parrain), w.filleul, w.parrain)).toEqual({ ok: false, rule: 'R16', code: 'role' });
    expect(await w.p.recordSponsor(w.dir, w.filleul, w.filleul)).toEqual({ ok: false, rule: null, code: 'invalid_sponsor' });
    expect(await w.p.recordSponsor(w.dir, w.filleul, w.parrain)).toEqual({ ok: true });
    expect(await w.p.recordSponsor(w.dir, w.filleul, w.autre)).toEqual({ ok: false, rule: null, code: 'already_recorded' });
    expect(await w.p.recordSponsor(w.dir, w.parrain, w.filleul)).toEqual({ ok: false, rule: null, code: 'loop' });
    // Après une première commission, plus de parrain : rien de rétroactif.
    await w.sale({ networkShare: 100_000, agentId: w.autre });
    expect(await w.p.recordSponsor(w.dir, w.autre, w.parrain)).toEqual({ ok: false, rule: 'R83', code: 'after_first_commission' });
    expect(await w.p.primesOf(w.as(w.filleul), w.parrain)).toEqual({ ok: false, rule: 'R16', code: 'not_assigned' });
    expect(await w.p.primesOf({ role: 'compliance', userId: 'c', networkId: w.network.id }, w.parrain)).toEqual({ ok: false, rule: 'R16', code: 'role' });
    expect(await w.p.setRules(w.as(w.parrain), { rateBp: 5000 })).toEqual({ ok: false, rule: 'R16', code: 'role' });
    expect(await w.p.setRules(w.dir, { rateBp: 6000 })).toEqual({ ok: false, rule: null, code: 'invalid_rate' });
    expect((await w.journal.all()).filter((e) => e.type === 'acces.refuse')).toHaveLength(4);
  });
});
