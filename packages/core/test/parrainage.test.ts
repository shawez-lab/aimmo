import { expect, it } from 'vitest';
import { FicheClient, SqlJournalStore, applyMigrations, fromSyncSqlite, type SqlDatabase } from '../src/index.ts';
import { ActeVente, Echeancier } from '../src/dossiers/index.ts';
import { Commissions, Encaissements, Factures, PlateformeEssai, computeShares } from '../src/pilotage/index.ts';
import { PROOF, setupDossier } from './dossiers-jeu.ts';
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
  const sale = async (o: { agentId?: string; networkShare: number; received?: boolean; paid?: boolean; invoice?: 'aucune' | 'emise' | 'annulee' | 'annulee_puis_refaite' }) => {
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
    if (o.paid) await db.run("INSERT INTO commission_payouts (file_id, network_id, paid_at, proof_ref, recorded_by, created_at) VALUES (?, ?, ?, 'virement', 'dir', ?)", [fileId, network.id, stamp, stamp]);
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

  it('[R83] un parrain parti ne touche rien de nouveau ; ce qui lui était déjà reversé reste', async () => {
    const w = await setup();
    await w.p.setRules(w.dir, { rateBp: 1000 });
    await w.p.recordSponsor(w.dir, w.filleul, w.parrain);
    await w.sale({ networkShare: 500_000, paid: true });
    await w.db.run("UPDATE agents SET status = 'left' WHERE id = ?", [w.parrain]);
    const after = await w.sale({ networkShare: 300_000 });
    expect(after.prime).toBeNull();
    const r = await w.p.primesOf(w.dir, w.parrain);
    expect(r.ok && r.value.primes.map((x) => x.amountCents)).toEqual([50_000]);
  });

  it('[R83] un parrain parti entre le compromis et le reversement ne touche pas la prime figée ; le déjà reversé reste', async () => {
    const w = await setup();
    await w.p.setRules(w.dir, { rateBp: 1000 });
    await w.p.recordSponsor(w.dir, w.filleul, w.parrain);
    const paid = await w.sale({ networkShare: 500_000, paid: true });
    const pending = await w.sale({ networkShare: 300_000, received: false });
    expect(pending.prime).toEqual({ parrainId: w.parrain, amountCents: 30_000 });
    await w.db.run("UPDATE agents SET status = 'left' WHERE id = ?", [w.parrain]);
    // L'encaissement arrive après son départ.
    w.raw.exec('PRAGMA foreign_keys = OFF');
    await w.db.run("INSERT INTO commission_receipts (file_id, network_id, received_at, proof_ref, payout_due_at, recorded_by, created_at) VALUES (?, ?, '2027-08-01T08:00:00.000Z', 'preuve', '2027-08-02T08:00:00.000Z', 'dir', '2027-08-01T08:00:00.000Z')", [pending.fileId, w.network.id]);
    w.raw.exec('PRAGMA foreign_keys = ON');
    const r = await w.p.primesOf(w.dir, w.parrain);
    expect(r.ok && r.value.primes.map((x) => x.fileId)).toEqual([paid.fileId]);
    // M13 sait que cette part figée n'est pas à reverser.
    expect(await w.p.withheld(w.network.id)).toEqual([{ fileId: pending.fileId, sponsorId: w.parrain, amountCents: 30_000 }]);
  });

  it('[R83] le parrain déclaré à la création de l\'agent compte ; un autre ne peut pas être rangé', async () => {
    const w = await setup();
    await w.p.setRules(w.dir, { rateBp: 1000 });
    const declared = (await w.store.createAgent({ networkId: w.network.id, firstName: 'Dé', lastName: 'Claré', sponsorAgentId: w.parrain })).id;
    expect(await w.p.sponsorOf(w.network.id, declared)).toBe(w.parrain);
    expect(await w.p.of(w.network.id, declared, 100_000)).toEqual({ parrainId: w.parrain, amountCents: 10_000 });
    expect(await w.p.recordSponsor(w.dir, declared, w.autre)).toEqual({ ok: false, rule: 'R83', code: 'other_sponsor_declared' });
    expect(await w.p.recordSponsor(w.dir, declared, w.parrain)).toEqual({ ok: true });
  });

  it('[R83] cycle complet par M13 : la prime entre dans les parts au compromis et n\'est montrée qu\'après l\'encaissement', async () => {
    const t = await setupDossier('appartement');
    const p = new Parrainage(t.db, t.journal, { now: t.now });
    const sponsorId = '00000000-0000-4000-8000-00000000abcd';
    const stamp = t.now().toISOString();
    await t.db.run("INSERT INTO agents (id, network_id, first_name, last_name, zone, status, sponsor_agent_id, created_at, updated_at) VALUES (?, ?, 'Par', 'Rain', NULL, 'active', NULL, ?, ?)", [sponsorId, t.network.id, stamp, stamp]);
    expect(await p.recordSponsor(t.direction, t.agent.userId, sponsorId)).toEqual({ ok: true });
    expect(await p.setRules(t.direction, { rateBp: 1000 })).toEqual({ ok: true });
    const at9 = (day: string) => new Date(`${day}T08:00:00.000Z`);
    const c = new Commissions(t.db, t.acces, t.journal, { now: t.now, primes: p });
    await c.setGrid(t.direction, { validFrom: '2027-03-01', defaultRateBp: 7000 });
    await t.startCompromis();
    t.setClock(at9('2027-03-11'));
    const echeancier = new Echeancier(t.db, t.acces, t.journal, { now: t.now });
    for (const [kind, day] of [['compromis_signe', '2027-03-10'], ['notification_acquereur', '2027-03-11'], ['dia_recue', '2027-03-11'], ['date_limite_pret', '2027-05-10'], ['etat_date_attendu', '2027-05-20'], ['acte_prevu', '2027-06-10']] as const) {
      const r = await echeancier.record(t.agent, t.fileId, { kind, day, proofRef: PROOF });
      if (!r.ok) throw new Error(r.code);
    }
    await c.sync(t.network.id);
    const share = await t.db.first<{ amount_cents: number }>("SELECT amount_cents FROM commission_shares WHERE file_id = ? AND kind = 'parrainage'", [t.fileId]);
    expect(share!.amount_cents).toBeGreaterThan(0);
    const before = await p.primesOf(t.direction, sponsorId);
    expect(before.ok && before.value.primes).toEqual([]);
    const status = await t.pieces.status(t.agent, t.fileId);
    if (!status.ok) throw new Error(status.code);
    for (const piece of status.value.missing) {
      const r = await t.pieces.add(t.agent, t.fileId, { piece, ref: t.upload(), issuedOn: '2027-03-11' });
      if (!r.ok) throw new Error(r.code);
    }
    t.setClock(at9('2027-06-11'));
    const acte = await new ActeVente(t.db, t.acces, t.journal, t.storage, { now: t.now }).record(t.agent, t.fileId, { signedOn: '2027-06-10', proofRef: 'preuves/0b6f1d2e-7777-4a2b-8c3d-000000000001.pdf' });
    if (!acte.ok) throw new Error(acte.code);
    await c.sync(t.network.id);
    const f = new Factures(t.db, t.acces, t.journal, { now: t.now, plateforme: new PlateformeEssai() });
    await f.prepare(t.network.id);
    const drafts = await f.drafts(t.direction);
    if (!drafts.ok) throw new Error('drafts');
    for (const d of drafts.value.filter((x) => x.kind === 'honoraires')) await f.validate(t.direction, d.id);
    const afterInvoice = await p.primesOf(t.direction, sponsorId);
    expect(afterInvoice.ok && afterInvoice.value.primes).toEqual([]);
    t.setClock(new Date('2027-06-18T16:30:00.000Z'));
    const e = new Encaissements(t.db, t.acces, t.journal, { now: t.now });
    expect((await e.recordReceipt(t.direction, t.fileId, { receivedAt: '2027-06-18T16:00:00.000Z', proofRef: 'releves/essai-1' })).ok).toBe(true);
    const after = await p.primesOf({ role: 'agent', userId: sponsorId, networkId: t.network.id }, sponsorId);
    expect(after.ok && after.value.primes.map((x) => [x.fileId, x.amountCents])).toEqual([[t.fileId, share!.amount_cents]]);
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
