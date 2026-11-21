import { expect, it } from 'vitest';
import { ActeVente, Echeancier } from '../src/dossiers/index.ts';
import { COMMISSION_STATUSES, Commissions, computeShares, type CommissionShare } from '../src/pilotage/index.ts';
import { PROOF, setupDossier } from './dossiers-jeu.ts';
import { describeWithSqlite } from './sqlite.ts';

// Tout est inventé : ventes, agents, montants.
const ACT_PROOF = 'preuves/0b6f1d2e-7777-4a2b-8c3d-000000000001.pdf';
const at9 = (day: string) => new Date(`${day}T08:00:00.000Z`);

/** 10 ventes passées, chaque part comptée à la main, au centime. */
const SALES: { fee: number; rate: number; splits?: { agentId: string; ratioBp: number; reason: 'fichier_commun' | 'binome' }[]; prime?: number; expected: [CommissionShare['kind'], number][] }[] = [
  { fee: 1_000_000, rate: 7000, expected: [['reseau', 300_000], ['agent', 700_000]] },
  { fee: 1_234_567, rate: 7000, expected: [['reseau', 370_371], ['agent', 864_196]] },
  { fee: 850_000, rate: 5000, splits: [{ agentId: 'b', ratioBp: 5000, reason: 'fichier_commun' }], expected: [['reseau', 425_000], ['agent', 212_500], ['partage', 212_500]] },
  { fee: 999_999, rate: 6666, expected: [['reseau', 333_400], ['agent', 666_599]] },
  { fee: 1_500_000, rate: 8000, prime: 50_000, expected: [['reseau', 250_000], ['agent', 1_200_000], ['parrainage', 50_000]] },
  { fee: 0, rate: 7000, expected: [['reseau', 0], ['agent', 0]] },
  { fee: 1_000_001, rate: 7000, splits: [{ agentId: 'b', ratioBp: 3333, reason: 'binome' }], expected: [['reseau', 300_001], ['agent', 466_690], ['partage', 233_310]] },
  { fee: 2_000_000, rate: 10_000, prime: 10_000, expected: [['reseau', 0], ['agent', 2_000_000]] },
  { fee: 1_200_000, rate: 0, expected: [['reseau', 1_200_000], ['agent', 0]] },
  {
    fee: 777_777,
    rate: 7500,
    splits: [{ agentId: 'b', ratioBp: 2500, reason: 'fichier_commun' }, { agentId: 'c', ratioBp: 2500, reason: 'binome' }],
    prime: 100_000,
    expected: [['reseau', 94_445], ['agent', 291_666], ['partage', 145_833], ['partage', 145_833], ['parrainage', 100_000]],
  },
];

it('[R69] 10 ventes passées recalculées sans écart, au centime ; la somme des parts est toujours les honoraires', () => {
  for (const [i, s] of SALES.entries()) {
    const shares = computeShares(s.fee, 'a', s.rate, s.splits ?? [], s.prime ? { parrainId: 'p', amountCents: s.prime } : null);
    expect([i, shares.map((x) => [x.kind, x.amountCents])]).toEqual([i, s.expected]);
    expect([i, shares.reduce((a, x) => a + x.amountCents, 0)]).toEqual([i, s.fee]);
  }
  expect(() => computeShares(-1, 'a', 7000)).toThrow();
  expect(() => computeShares(100, 'a', 10_001)).toThrow();
  expect(() => computeShares(100, 'a', 7000, [{ agentId: 'b', ratioBp: 6000, reason: 'binome' }, { agentId: 'c', ratioBp: 6000, reason: 'binome' }])).toThrow();
});

async function setup() {
  const t = await setupDossier('appartement');
  const echeancier = new Echeancier(t.db, t.acces, t.journal, { now: t.now });
  const commissions = (options: ConstructorParameters<typeof Commissions>[3] = {}) => new Commissions(t.db, t.acces, t.journal, { now: t.now, ...options });
  const compromis = async () => {
    await t.startCompromis();
    t.setClock(at9('2027-03-11'));
    for (const [kind, day] of [['compromis_signe', '2027-03-10'], ['notification_acquereur', '2027-03-11'], ['dia_recue', '2027-03-11'], ['date_limite_pret', '2027-05-10'], ['etat_date_attendu', '2027-05-20'], ['acte_prevu', '2027-06-10']] as const) {
      const r = await echeancier.record(t.agent, t.fileId, { kind, day, proofRef: PROOF });
      if (!r.ok) throw new Error(r.code);
    }
  };
  const acte = async () => {
    const status = await t.pieces.status(t.agent, t.fileId);
    if (!status.ok) throw new Error(status.code);
    for (const piece of status.value.missing) {
      const r = await t.pieces.add(t.agent, t.fileId, { piece, ref: t.upload(), issuedOn: '2027-03-11' });
      if (!r.ok) throw new Error(r.code);
    }
    t.setClock(at9('2027-06-11'));
    const r = await new ActeVente(t.db, t.acces, t.journal, t.storage, { now: t.now }).record(t.agent, t.fileId, { signedOn: '2027-06-10', proofRef: ACT_PROOF });
    if (!r.ok) throw new Error(r.code);
  };
  return { ...t, commissions, compromis, acte };
}

describeWithSqlite('K01 · cycle de la commission', () => {
  it('[R67] prévue au compromis, due à l’acte, facturée, payée : dans l’ordre, une fois chacune, avec sa preuve', async () => {
    const t = await setup();
    const c = t.commissions();
    expect(await c.setGrid(t.direction, { validFrom: '2027-01-01', defaultRateBp: 7000 })).toMatchObject({ ok: false, code: 'past_day' });
    expect(await c.setGrid(t.direction, { validFrom: '2027-03-01', defaultRateBp: 7000 })).toEqual({ ok: true, version: 1 });
    expect(await c.sync(t.network.id)).toEqual({ planned: 0, due: 0 });
    await t.compromis();
    expect(await c.sync(t.network.id)).toEqual({ planned: 1, due: 0 });
    // Le jeu signe un mandat à 10 000 € d'honoraires, à la charge de l'acquéreur.
    let list = await c.list(t.direction);
    expect(list.ok && list.value).toEqual([
      {
        fileId: t.fileId,
        agentId: t.alexId,
        compromisOn: '2027-03-10',
        feeCents: 1_000_000,
        feeCharge: 'acquereur',
        status: 'prevue',
        steps: [{ status: 'prevue', at: at9('2027-03-11').toISOString() }],
        shares: [
          { kind: 'reseau', beneficiaryId: null, reason: null, amountCents: 300_000 },
          { kind: 'agent', beneficiaryId: t.alexId, reason: null, amountCents: 700_000 },
        ],
        payment: null,
        signedOn: null,
        cancelled: false,
        tier: null,
      },
    ]);
    // Rien ne se facture ni ne se paie avant l'acte [R67].
    expect(await c.recordStep(t.network.id, t.fileId, 'facturee', 'factures/essai-1', 'direction:direction-1')).toEqual({ ok: false, rule: 'R67', code: 'out_of_order' });
    // Une grille changée après le compromis ne change pas la commission prévue.
    expect(await c.setGrid(t.direction, { validFrom: '2027-03-11', defaultRateBp: 9000 })).toMatchObject({ ok: true });
    await t.acte();
    expect(await c.sync(t.network.id)).toEqual({ planned: 0, due: 1 });
    expect(await c.sync(t.network.id)).toEqual({ planned: 0, due: 0 });
    expect(await c.recordStep(t.network.id, t.fileId, 'payee', 'virements/essai-1', 'direction:direction-1')).toEqual({ ok: false, rule: 'R67', code: 'out_of_order' });
    expect(await c.recordStep(t.network.id, t.fileId, 'facturee', 'mauvaise preuve !', 'direction:direction-1')).toEqual({ ok: false, rule: null, code: 'bad_proof' });
    expect(await c.recordStep('autre-reseau', t.fileId, 'facturee', 'factures/essai-1', 'direction:direction-1')).toEqual({ ok: false, rule: null, code: 'unknown' });
    expect(await c.recordStep(t.network.id, t.fileId, 'facturee', 'factures/essai-1', 'direction:direction-1')).toEqual({ ok: true });
    expect(await c.recordStep(t.network.id, t.fileId, 'facturee', 'factures/essai-2', 'direction:direction-1')).toEqual({ ok: false, rule: null, code: 'already' });
    expect(await c.recordStep(t.network.id, t.fileId, 'payee', 'virements/essai-1', 'direction:direction-1')).toEqual({ ok: true });
    list = await c.list(t.direction);
    expect(list.ok && list.value[0]!.steps.map((s) => s.status)).toEqual([...COMMISSION_STATUSES]);
    expect(list.ok && list.value[0]!.shares.map((s) => s.amountCents)).toEqual([300_000, 700_000]);
    // Au journal : les statuts, jamais un montant [R13].
    const entries = (await t.journal.all()).filter((e) => e.type === 'commission.etape');
    expect(entries.map((e) => e.data.status)).toEqual(['prevue', 'due', 'facturee', 'payee']);
    expect(JSON.stringify(entries)).not.toMatch(/700000|300000|10000/);
    // Rien ne change ni ne s'efface [R17].
    await expect(t.db.run('UPDATE commissions SET fee_cents = 1 WHERE file_id = ?', [t.fileId])).rejects.toThrow();
    await expect(t.db.run('DELETE FROM commission_steps WHERE file_id = ?', [t.fileId])).rejects.toThrow();
    await expect(t.db.run("INSERT INTO commission_steps (file_id, status, proof_ref, at, by) VALUES ('x', 'payee', 'p', 'a', 'b')")).rejects.toThrow();
  });

  it('[R68] un agent ne voit que ses commissions et ses parts ; partage et parrainage viennent de M14 par des interfaces', async () => {
    const t = await setup();
    const c = t.commissions({
      partages: { of: async () => [{ agentId: t.sam.userId, ratioBp: 5000, reason: 'fichier_commun' }] },
      primes: { of: async () => ({ parrainId: 'parrain-1', amountCents: 20_000 }) },
    });
    await c.setGrid(t.direction, { validFrom: '2027-03-01', defaultRateBp: 7000, agents: [{ agentId: t.alexId, rateBp: 8000 }] });
    await t.compromis();
    await c.sync(t.network.id);
    const all = await c.list(t.direction);
    expect(all.ok && all.value[0]!.shares.map((s) => [s.kind, s.beneficiaryId, s.amountCents])).toEqual([
      ['reseau', null, 180_000],
      ['agent', t.alexId, 400_000],
      ['partage', t.sam.userId, 400_000],
      ['parrainage', 'parrain-1', 20_000],
    ]);
    const alex = await c.list(t.agent);
    expect(alex.ok && alex.value[0]!.shares).toEqual([{ kind: 'agent', beneficiaryId: t.alexId, reason: null, amountCents: 400_000 }]);
    expect(alex.ok && alex.value[0]).toMatchObject({ agentId: t.alexId, feeCents: 1_000_000 });
    const sam = await c.list(t.sam);
    // L'agent qui partage voit sa part, jamais les honoraires ni l'agent de la vente [R68].
    expect(sam.ok && sam.value[0]).toMatchObject({ agentId: null, feeCents: null, feeCharge: null, shares: [{ kind: 'partage', beneficiaryId: t.sam.userId, reason: 'fichier_commun', amountCents: 400_000 }] });
    // Sans part, rien : un autre agent ne voit pas la vente.
    const other = await t.store.createAgent({ networkId: t.network.id, firstName: 'Noé', lastName: 'Agent' });
    const none = await c.list({ role: 'agent', networkId: t.network.id, userId: other.id });
    expect(none.ok && none.value).toEqual([]);
  });

  it('[R16] seule la direction règle la grille ; chaque refus au journal ; une grille fausse est refusée', async () => {
    const t = await setup();
    const c = t.commissions();
    const refused = async () => (await t.journal.all()).filter((e) => e.type === 'acces.refuse' && e.data.kind === 'commission_grid').length;
    expect(await c.setGrid(t.agent, { validFrom: '2027-01-01', defaultRateBp: 9000 })).toEqual({ ok: false, rule: 'R16', code: 'role' });
    expect(await refused()).toBe(1);
    for (const day of ['2027-02-30', '2027-13-01', '2027-00-10', '2027-01-32']) expect(await c.setGrid(t.direction, { validFrom: day, defaultRateBp: 7000 })).toMatchObject({ code: 'bad_day' });
    expect(await c.setGrid(t.direction, { validFrom: '2027-03-01', defaultRateBp: 10_001 })).toMatchObject({ code: 'bad_rate' });
    expect(await c.setGrid(t.direction, { validFrom: '2027-03-01', defaultRateBp: 7000, agents: [{ agentId: 'inconnu', rateBp: 5000 }] })).toMatchObject({ code: 'unknown_agent' });
    // Sans grille au jour du compromis, aucune commission n'est inventée.
    await c.setGrid(t.direction, { validFrom: '2027-04-01', defaultRateBp: 7000 });
    await t.compromis();
    expect(await c.sync(t.network.id)).toEqual({ planned: 0, due: 0 });
    await c.sync(t.network.id);
    // Dit une fois au journal, sans montant.
    expect((await t.journal.bySubject(`sale_file:${t.fileId}`)).filter((e) => e.type === 'commission.attente').map((e) => e.data.code)).toEqual(['no_grid']);
    // La conformité n'a pas les chiffres, comme le veut le socle [R16].
    expect(await c.list({ role: 'compliance', networkId: t.network.id, userId: 'c-1' })).toMatchObject({ ok: false, rule: 'R16', code: 'role' });
    // Un rôle partenaire ne lit rien.
    expect(await c.list({ role: 'partner', networkId: t.network.id, userId: 'p-1' })).toMatchObject({ ok: false, rule: 'R16' });
  });

  it('un partage faux de M14 ne bloque rien d’autre : dit au journal, sans parts écrites ; les parts s’écrivent en une fois', async () => {
    const t = await setup();
    let broken = true;
    const c = t.commissions({ partages: { of: async () => (broken ? [{ agentId: t.sam.userId, ratioBp: 12_000, reason: 'binome' as const }] : []) } });
    await c.setGrid(t.direction, { validFrom: '2027-03-01', defaultRateBp: 7000 });
    await t.compromis();
    expect(await c.sync(t.network.id)).toEqual({ planned: 0, due: 0 });
    expect(await t.db.all('SELECT seq FROM commission_shares')).toEqual([]);
    expect((await t.journal.bySubject(`sale_file:${t.fileId}`)).filter((e) => e.type === 'commission.attente').map((e) => e.data.code)).toEqual(['partage_invalide']);
    broken = false;
    expect(await c.sync(t.network.id)).toEqual({ planned: 1, due: 0 });
    // Des parts qui ne font pas les honoraires (écrites à la main hors du code) : jamais d'étape « prévue » [R69].
    const sum = await t.db.first<{ n: number }>('SELECT SUM(amount_cents) AS n FROM commission_shares WHERE file_id = ?', [t.fileId]);
    expect(sum!.n).toBe(1_000_000);
  });

  it('[R16] [R63] ce que le passage laisse de côté se lit par la direction seule, avec sa dernière raison, et sort une fois réglé', async () => {
    const t = await setup();
    const c = t.commissions();
    expect(await c.blocked(t.agent)).toMatchObject({ ok: false, rule: 'R16' });
    expect(await c.blocked({ role: 'compliance', networkId: t.network.id, userId: 'c-1' })).toMatchObject({ ok: false, rule: 'R16' });
    await t.compromis();
    // Le passage n'y est pas encore allé : rien à trancher.
    expect(await c.blocked(t.direction)).toEqual({ ok: true, value: [] });
    await c.sync(t.network.id);
    expect(await c.blocked(t.direction)).toEqual({ ok: true, value: [{ fileId: t.fileId, code: 'no_grid' }] });
  });

  it('[R16] la dernière grille se lit par la direction seule, avec les agents actifs et les taux propres', async () => {
    const t = await setup();
    t.setClock(at9('2027-02-15'));
    const c = t.commissions();
    expect(await c.currentGrid(t.agent)).toMatchObject({ ok: false, rule: 'R16' });
    const none = await c.currentGrid(t.direction);
    expect(none.ok && [none.value.version, none.value.inForce, none.value.upcoming]).toEqual([null, null, []]);
    expect(none.ok && none.value.agents.every((a) => a.rateBp === null)).toBe(true);
    await c.setGrid(t.direction, { validFrom: '2027-03-01', defaultRateBp: 7000, agents: [{ agentId: t.alexId, rateBp: 7500 }] });
    const read = await c.currentGrid(t.direction);
    expect(read.ok && [read.value.version, read.value.inForce, read.value.upcoming]).toEqual([1, null, [{ version: 1, validFrom: '2027-03-01', defaultRateBp: 7000, tiers: [] }]]);
    // Le jour venu, elle est en vigueur, et ses taux propres préremplissent la suivante.
    t.setClock(at9('2027-03-05'));
    const live = await c.currentGrid(t.direction);
    expect(live.ok && live.value.inForce).toEqual({ version: 1, validFrom: '2027-03-01', defaultRateBp: 7000, tiers: [] });
    // Des versions dans le désordre : c'est le jour qui décide, et le plus proche à venir vient d'abord.
    await c.setGrid(t.direction, { validFrom: '2027-06-01', defaultRateBp: 6000 });
    await c.setGrid(t.direction, { validFrom: '2027-04-01', defaultRateBp: 6500 });
    const out = await c.currentGrid(t.direction);
    expect(out.ok && out.value.version).toBe(3);
    expect(out.ok && out.value.inForce?.version).toBe(1);
    expect(out.ok && out.value.upcoming.map((x) => x.version)).toEqual([3, 2]);
    // Un écran resté sur une version d'avant est refusé : aucun taux ne se perd.
    expect(await c.setGrid(t.direction, { validFrom: '2027-07-01', defaultRateBp: 6000, expectedVersion: 2 })).toMatchObject({ code: 'stale_grid' });
    expect(await c.setGrid(t.direction, { validFrom: '2027-07-01', defaultRateBp: 6000, expectedVersion: 3 })).toMatchObject({ ok: true, version: 4 });
    expect(live.ok && live.value.agents.find((a) => a.agentId === t.alexId)).toEqual({ agentId: t.alexId, rateBp: 7500 });
  });

  it('[R63] un écart à l’acte reste à trancher', async () => {
    const t = await setup();
    const c = t.commissions();
    await c.setGrid(t.direction, { validFrom: '2027-03-01', defaultRateBp: 7000 });
    await t.compromis();
    await c.sync(t.network.id);
    expect(await c.blocked(t.direction)).toEqual({ ok: true, value: [] });
    await t.db.run("INSERT INTO sale_file_dates (file_id, network_id, kind, version, day, proof_ref, at, by) VALUES (?, ?, 'compromis_signe', 2, '2027-03-09', ?, ?, 'agent:x')", [t.fileId, t.network.id, PROOF, t.now().toISOString()]);
    await t.acte();
    await c.sync(t.network.id);
    expect(await c.blocked(t.direction)).toEqual({ ok: true, value: [{ fileId: t.fileId, code: 'compromis' }] });
  });

  it('un compromis corrigé après la commission prévue : l’acte ne la rend pas due, l’écart va au journal', async () => {
    const t = await setup();
    const c = t.commissions();
    await c.setGrid(t.direction, { validFrom: '2027-03-01', defaultRateBp: 7000 });
    await t.compromis();
    await c.sync(t.network.id);
    await t.db.run("INSERT INTO sale_file_dates (file_id, network_id, kind, version, day, proof_ref, at, by) VALUES (?, ?, 'compromis_signe', 2, '2027-03-09', ?, ?, 'agent:x')", [t.fileId, t.network.id, PROOF, new Date().toISOString()]);
    await t.acte();
    expect(await c.sync(t.network.id)).toEqual({ planned: 0, due: 0 });
    expect((await t.journal.bySubject(`sale_file:${t.fileId}`)).filter((e) => e.type === 'commission.ecart').map((e) => e.data.code)).toEqual(['compromis']);
  });
});

describeWithSqlite('AU092 · une grille à paliers selon le chiffre d’affaires cumulé de l’année', () => {
  const TIERS = [{ fromCents: 0, rateBp: 5000 }, { fromCents: 1_500_000, rateBp: 6000 }, { fromCents: 3_000_000, rateBp: 7000 }];
  /** Des ventes de l'agent déjà comptées : honoraires et parts rangés, inventés. */
  const past = async (t: Awaited<ReturnType<typeof setup>>, rows: [string, string, number][]) => {
    await t.db.run('PRAGMA foreign_keys = OFF');
    const grid = await t.db.first<{ id: string }>('SELECT id FROM commission_grids ORDER BY version LIMIT 1');
    for (const [id, day, fee] of rows) {
      await t.db.run("INSERT INTO commissions (file_id, network_id, agent_id, mandate_id, compromis_on, fee_cents, fee_charge, grid_id, created_at) VALUES (?, ?, ?, 'm', ?, ?, 'vendeur', ?, ?)", [id, t.network.id, t.alexId, day, fee, grid!.id, day]);
      await t.db.run("INSERT INTO commission_shares (file_id, seq, kind, beneficiary_id, reason, amount_cents) VALUES (?, 1, 'agent', ?, NULL, ?)", [id, t.alexId, fee]);
    }
    await t.db.run('PRAGMA foreign_keys = ON');
  };

  it('[R69] constat : la grille n’avait qu’un taux ; le taux de la vente suit le palier que le cumul de l’année atteint, montré avec elle', async () => {
    const t = await setup();
    const c = t.commissions();
    expect(await c.setGrid(t.direction, { validFrom: '2027-03-01', defaultRateBp: 7000, tiers: TIERS })).toEqual({ ok: true, version: 1 });
    // 2 000 000 cette année avant le compromis du 10 mars ; une vente de l'an passé ne compte pas.
    await past(t, [['v-1', '2027-01-15', 1_200_000], ['v-2', '2027-02-20', 800_000], ['v-0', '2026-11-02', 5_000_000]]);
    await t.compromis();
    await c.sync(t.network.id);
    const list = await c.list(t.direction);
    const sale = list.ok ? list.value.find((v) => v.fileId === t.fileId)! : null;
    expect(sale!.shares.map((x) => [x.kind, x.amountCents])).toEqual([['reseau', 400_000], ['agent', 600_000]]);
    expect(sale!.tier).toEqual({ year: 2027, cumulCents: 2_000_000, tierSeq: 2, fromCents: 1_500_000, rateBp: 6000 });
    // L'agent voit le palier de sa vente.
    const mine = await c.list(t.agent);
    expect(mine.ok && mine.value.find((v) => v.fileId === t.fileId)!.tier).toMatchObject({ tierSeq: 2, rateBp: 6000 });
    // La grille en vigueur dit ses paliers.
    const g = await c.currentGrid(t.direction);
    expect(g.ok && g.value.inForce!.tiers).toEqual(TIERS);
    // Rangé une seule fois, jamais changé [R17].
    await expect(t.db.run('UPDATE commission_tier_picks SET rate_bp = 7000')).rejects.toThrow();
  });

  it('[R69] sous le premier seuil, le premier palier ; un agent qui a son taux propre le garde, sans palier', async () => {
    const t = await setup();
    const c = t.commissions();
    await c.setGrid(t.direction, { validFrom: '2027-03-01', defaultRateBp: 7000, tiers: TIERS, agents: [{ agentId: t.alexId, rateBp: 8000 }] });
    await t.compromis();
    await c.sync(t.network.id);
    const list = await c.list(t.direction);
    const sale = list.ok ? list.value.find((v) => v.fileId === t.fileId)! : null;
    expect(sale!.shares.map((x) => x.amountCents)).toEqual([200_000, 800_000]);
    expect(sale!.tier).toBeNull();
  });

  it('les paliers se disent bien : le premier à 0, chacun au-dessus du précédent, deux à dix', async () => {
    const t = await setup();
    const c = t.commissions();
    for (const tiers of [[{ fromCents: 0, rateBp: 5000 }], [{ fromCents: 100, rateBp: 5000 }, { fromCents: 200, rateBp: 6000 }], [{ fromCents: 0, rateBp: 5000 }, { fromCents: 0, rateBp: 6000 }], [{ fromCents: 0, rateBp: 5000 }, { fromCents: 10, rateBp: 10_001 }]]) {
      expect(await c.setGrid(t.direction, { validFrom: '2027-03-01', defaultRateBp: 7000, tiers })).toEqual({ ok: false, rule: null, code: 'bad_tiers' });
    }
    expect(await t.db.first('SELECT COUNT(*) AS n FROM commission_grids')).toEqual({ n: 0 });
  });
});

