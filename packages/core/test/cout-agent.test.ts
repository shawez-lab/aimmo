import { expect, it } from 'vitest';
import { FicheClient, SqlJournalStore, applyMigrations, fromSyncSqlite, type SqlDatabase, type Viewer } from '../src/index.ts';
import { AGENT_COST_CATEGORIES, CoutAgent, bpOf, breakEvenBp, requiredFor } from '../src/reseau/index.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

// Réseau, agents, ventes et factures inventés. Février 2027 est le mois lu ; mars 2027 est le mois en cours.

async function setup() {
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  let clock = Date.parse('2027-01-10T09:00:00.000Z');
  const now = (): Date => new Date((clock += 1000));
  const goTo = (iso: string) => {
    clock = Date.parse(iso);
  };
  const journal = new SqlJournalStore(db);
  const store = new FicheClient(db, { now });
  const cout = new CoutAgent(db, journal, { now });
  const network = await store.createNetwork('Réseau test');
  const other = await store.createNetwork('Autre réseau');
  const agents: string[] = [];
  for (const name of ['Alex', 'Camille', 'Dominique', 'Eden']) agents.push((await store.createAgent({ networkId: network.id, firstName: name, lastName: 'Agent' })).id);
  await store.createAgent({ networkId: other.id, firstName: 'Ailleurs', lastName: 'Agent' });
  const as = (role: string, userId = 'dir-1', networkId = network.id): Viewer => ({ role, userId, networkId }) as Viewer;
  const dir = as('direction');
  goTo('2027-03-10T09:00:00.000Z');

  let n = 0;
  /** Une facture fournisseur rangée, qui se recompte au centime (TVA à 20 %). */
  const invoice = async (issuedOn: string, htCents: number, networkId = network.id) => {
    const id = `inv-${++n}`;
    const vat = htCents / 5;
    await db.run("INSERT INTO supplier_invoice_reads (id, network_id, document_ref, read, problems, read_by, created_at) VALUES (?, ?, 'doc', '{}', '[]', 'direction:dir-1', 'x')", [`r-${id}`, networkId]);
    await db.run(
      "INSERT INTO supplier_invoices (id, network_id, read_id, supplier, number, issued_on, ht_cents, vat_cents, ttc_cents, vat_lines, corrected, recorded_by, created_at) VALUES (?, ?, ?, 'Fournisseur test', ?, ?, ?, ?, ?, ?, '[]', 'direction:dir-1', 'x')",
      [id, networkId, `r-${id}`, `F-${n}`, issuedOn, htCents, vat, htCents + vat, JSON.stringify([{ baseCents: htCents, rateBp: 2000, vatCents: vat }])],
    );
    return id;
  };
  /** Une vente dont la commission est rangée et encaissée, ses parts écrites à la main, toutes taxes comme dans K01. */
  const sale = async (receivedAt: string, parts: { reseau: number; agent: number; partage?: number; parrainage?: number; agency?: number }, networkId = network.id) => {
    const file = `f-${++n}`;
    const fee = parts.reseau + parts.agent + (parts.partage ?? 0) + (parts.parrainage ?? 0) + (parts.agency ?? 0);
    await db.exec('PRAGMA foreign_keys = OFF');
    await db.run("INSERT INTO commissions (file_id, network_id, agent_id, mandate_id, compromis_on, fee_cents, fee_charge, grid_id, created_at) VALUES (?, ?, ?, 'm', '2027-01-05', ?, NULL, 'g', 'x')", [file, networkId, agents[0]!, fee]);
    let seq = 0;
    await db.run("INSERT INTO commission_shares (file_id, seq, kind, beneficiary_id, reason, amount_cents) VALUES (?, ?, 'reseau', NULL, NULL, ?)", [file, ++seq, parts.reseau]);
    await db.run("INSERT INTO commission_shares (file_id, seq, kind, beneficiary_id, reason, amount_cents) VALUES (?, ?, 'agent', ?, NULL, ?)", [file, ++seq, agents[0]!, parts.agent]);
    if (parts.partage) await db.run("INSERT INTO commission_shares (file_id, seq, kind, beneficiary_id, reason, amount_cents) VALUES (?, ?, 'partage', ?, 'binome', ?)", [file, ++seq, agents[1]!, parts.partage]);
    if (parts.parrainage) await db.run("INSERT INTO commission_shares (file_id, seq, kind, beneficiary_id, reason, amount_cents) VALUES (?, ?, 'parrainage', ?, NULL, ?)", [file, ++seq, agents[2]!, parts.parrainage]);
    if (parts.agency) {
      // La délégation signée et son rattachement sont ceux de HX01 et HX59, déjà testés : ici, la part seule est rangée.
      await db.exec('DROP TRIGGER IF EXISTS commission_agency_shares_calcul');
      await db.run("INSERT INTO commission_agency_shares (file_id, delegation_id, partner_share_bp, amount_cents, created_at) VALUES (?, ?, 4000, ?, 'x')", [file, `del-${file}`, parts.agency]);
    }
    await db.run("INSERT INTO commission_receipts (file_id, network_id, received_at, proof_ref, payout_due_at, recorded_by, created_at) VALUES (?, ?, ?, 'preuve', ?, 'direction:dir-1', 'x')", [file, networkId, receivedAt, receivedAt]);
    await db.exec('PRAGMA foreign_keys = ON');
    return file;
  };
  /** Un réglage rangé en janvier, valable depuis janvier : il vaut pour février. */
  const settings = async (provisionBp = 1000, marginBp = 1000) => {
    goTo('2027-01-20T09:00:00.000Z');
    const r = await cout.setSettings(dir, { validFrom: '2027-01', provisionBp, marginBp, reason: 'Réglage du pilote' });
    goTo('2027-03-10T09:00:00.000Z');
    if (!r.ok) throw new Error(r.code);
    return r.value;
  };
  const events = async (type: string) => (await db.all<{ data: string }>('SELECT data FROM journal WHERE type = ?', [type])).map((r) => JSON.parse(r.data) as Record<string, unknown>);
  return { db, cout, network, other, agents, as, dir, invoice, sale, settings, events, goTo };
}

describeWithSqlite('HX65 · coût complet de l’agent moyen, couvert par la part du réseau', () => {
  it('calcule à la main un mois inventé : part, postes, provision, marge, agent moyen, seuil [R624]', async () => {
    const t = await setup();
    await t.settings(1000, 1500);
    // Deux ventes encaissées en février (heure de Paris), une en janvier et une en mars : seules celles de février comptent.
    const f1 = await t.sale('2027-02-03T10:00:00.000Z', { reseau: 500_000, agent: 700_000 });
    const f2 = await t.sale('2027-02-28T22:30:00.000Z', { reseau: 250_000, agent: 300_000, partage: 50_000 }); // 23 h 30 à Paris
    await t.sale('2027-01-31T22:59:59.000Z', { reseau: 999_999, agent: 1 }); // 23 h 59 le 31 janvier à Paris
    await t.sale('2027-02-28T23:00:00.000Z', { reseau: 999_999, agent: 1 }); // minuit le 1er mars à Paris
    const ia = await t.invoice('2027-02-05', 40_000);
    const leads = await t.invoice('2027-02-10', 120_000);
    const diff = await t.invoice('2027-02-11', 60_000);
    const acc = await t.invoice('2027-02-12', 30_000);
    const conf = await t.invoice('2027-02-28', 15_000);
    const hors = await t.invoice('2027-02-20', 500_000);
    await t.invoice('2027-03-01', 777_775); // mars : hors du mois
    for (const [id, c] of [[ia, 'ia'], [leads, 'clients_apportes'], [diff, 'diffusion'], [acc, 'accompagnement'], [conf, 'conformite'], [hors, 'hors_agents']] as const) {
      expect((await t.cout.assign(t.dir, id, c)).ok).toBe(true);
    }
    const r = await t.cout.month(t.dir, '2027-02');
    if (!r.ok) throw new Error(r.code);
    const m = r.value;
    // Calcul écrit à la main :
    // honoraires 1 200 000 et 600 000 toutes taxes, soit 1 000 000 + 500 000 = 1 500 000 hors taxe (TVA de 20 %) ;
    // parts des agents, sans TVA : 700 000 + 300 000 + 50 000 = 1 050 000 ; reste au réseau 1 500 000 − 1 050 000 = 450 000 ; postes 40 000 + 120 000 + 60 000 + 30 000 + 15 000 = 265 000 ;
    // provision 10 % de 1 050 000 = 105 000 ; coût complet 370 000 ; marge 15 % = 55 500 ; à couvrir 425 500.
    expect(m).toMatchObject({
      month: '2027-02',
      complete: true,
      missing: [],
      agentsPresent: 4,
      feesCents: 1_500_000,
      networkShareCents: 450_000,
      agentSharesCents: 1_050_000,
      costs: { ia: 40_000, clients_apportes: 120_000, diffusion: 60_000, accompagnement: 30_000, conformite: 15_000 },
      provisionCents: 105_000,
      fullCostCents: 370_000,
      marginCents: 55_500,
      requiredCents: 425_500,
      averageAgent: { networkShareCents: 112_500, requiredCents: 106_375 },
      covered: true,
      networkBp: 3000,
      // Au seuil, les agents ont moins et la provision baisse : à 2 854 points, 428 100 au réseau, 1 071 900 aux agents,
      // provision 107 190, coût complet 372 190, marge 55 828, à couvrir 428 018 : couvert. À 2 853 points, 427 950
      // au réseau, à couvrir 428 035 : pas couvert.
      breakEvenNetworkBp: 2854,
      breakEvenUnreachable: false,
    });
    expect(m.lines.files.map((f) => f.fileId)).toEqual([f1, f2]);
    expect(m.lines.invoices.map((i) => i.invoiceId).sort()).toEqual([ia, leads, diff, acc, conf, hors].sort());
    expect(m.lines.invoices.find((i) => i.invoiceId === hors)).toMatchObject({ category: 'hors_agents', htCents: 500_000 });
    // Les postes refont le coût complet, et chaque poste refait la somme de ses factures (chaque chiffre a ses lignes).
    for (const c of AGENT_COST_CATEGORIES) expect(m.costs[c]).toBe(m.lines.invoices.filter((i) => i.category === c).reduce((a, i) => a + i.htCents, 0));
    expect(m.networkShareCents).toBe(m.lines.files.reduce((a, f) => a + f.networkShareCents, 0));
  });

  it('arrondit la provision et la marge au centime inférieur ; le seuil est la plus petite part qui couvre [R624] [R625]', () => {
    expect(bpOf(999, 1000)).toBe(99);
    expect(bpOf(1, 9999)).toBe(0);
    expect(requiredFor(265_000, 1_071_900, 1000, 1500)).toEqual({ provisionCents: 107_190, fullCostCents: 372_190, marginCents: 55_828, requiredCents: 428_018 });
    const input = { feesCents: 1_500_000, sponsorSharesCents: 0, costsCents: 265_000, provisionBp: 1000, marginBp: 1500 };
    expect(breakEvenBp(input).bp).toBe(2854);
    // Couvert au seuil, plus couvert un point en dessous, provision et marge refaites à chaque part.
    const covers = (b: number) => {
      const net = bpOf(input.feesCents, b);
      return net >= requiredFor(input.costsCents, input.feesCents - net, input.provisionBp, input.marginBp).requiredCents;
    };
    expect(covers(2854)).toBe(true);
    expect(covers(2853)).toBe(false);
    // Le parrainage ne bouge pas avec la part du réseau : 879 points couvrent, 878 non.
    expect(breakEvenBp({ feesCents: 600_000, sponsorSharesCents: 20_000, costsCents: 0, provisionBp: 1000, marginBp: 0 })).toEqual({ bp: 879, unreachable: false });
    expect(breakEvenBp({ feesCents: 0, sponsorSharesCents: 0, costsCents: 5, provisionBp: 0, marginBp: 0 })).toEqual({ bp: null, unreachable: false });
    // Même tout au réseau ne couvre pas : le seuil est nul et le dit.
    expect(breakEvenBp({ feesCents: 1000, sponsorSharesCents: 0, costsCents: 1001, provisionBp: 0, marginBp: 0 })).toEqual({ bp: null, unreachable: true });
    // Le parrainage est réservé : sur 1 000, il reste 800 au plus pour le réseau, qui ne couvre pas 900.
    expect(breakEvenBp({ feesCents: 1000, sponsorSharesCents: 200, costsCents: 900, provisionBp: 1000, marginBp: 0 })).toEqual({ bp: null, unreachable: true });
    expect(breakEvenBp({ feesCents: 1000, sponsorSharesCents: 200, costsCents: 800, provisionBp: 1000, marginBp: 0 })).toEqual({ bp: 8000, unreachable: false });
    expect(breakEvenBp({ feesCents: 1000, sponsorSharesCents: 1200, costsCents: 0, provisionBp: 0, marginBp: 0 })).toEqual({ bp: null, unreachable: true });
    // L'arrondi admet 9 900 points sur 100 001 (99 000 au réseau) alors que le rapport arrondi dirait 9 899.
    expect(breakEvenBp({ feesCents: 100_001, sponsorSharesCents: 1001, costsCents: 99_000, provisionBp: 1000, marginBp: 0 })).toEqual({ bp: 9900, unreachable: false });
  });

  it('compare hors taxe : la TVA des honoraires n’est pas une recette du réseau [R624] [R625]', async () => {
    const t = await setup();
    await t.settings(0, 0);
    // 1 200 000 toutes taxes, dont 300 000 au réseau : comparé toutes taxes, le coût de 150 000 serait couvert. Hors
    // taxe, il reste au réseau 1 000 000 − 900 000 = 100 000 : pas couvert.
    await t.sale('2027-02-10T10:00:00.000Z', { reseau: 300_000, agent: 900_000 });
    await t.cout.assign(t.dir, await t.invoice('2027-02-10', 150_000), 'clients_apportes');
    const r = await t.cout.month(t.dir, '2027-02');
    if (!r.ok) throw new Error(r.code);
    expect(r.value).toMatchObject({ complete: true, covered: false, networkBp: 1000, breakEvenNetworkBp: 1500, requiredCents: 150_000 });
  });

  it('ramène chaque dossier hors taxe avec le taux de son brouillon de facture rangé, sinon le taux réglé [R624]', async () => {
    const t = await setup();
    await t.settings(0, 0);
    // Deux ventes de 1 200 000 : l'une facturée sans TVA (taux rangé 0), l'autre sans brouillon (20 % réglés).
    const a = await t.sale('2027-02-10T10:00:00.000Z', { reseau: 500_000, agent: 700_000 });
    await t.sale('2027-02-11T10:00:00.000Z', { reseau: 500_000, agent: 700_000 });
    await t.db.exec('PRAGMA foreign_keys = OFF');
    await t.db.run("INSERT INTO invoice_drafts (id, network_id, file_id, kind, issuer, recipient_person_id, amount_cents, vat_bp, round, created_at) VALUES ('dr1', ?, ?, 'honoraires', 'reseau', 'p', 1200000, 0, 1, 'x')", [t.network.id, a]);
    // Un reversement facturé avec TVA à 20 % : l'agent la facture, le réseau la récupère ; 700 000 font 583 333 hors taxe.
    await t.db.run("INSERT INTO invoice_drafts (id, network_id, file_id, kind, issuer, recipient_person_id, amount_cents, vat_bp, round, created_at) VALUES ('dr2', ?, ?, 'reversement', ?, NULL, 700000, 2000, 1, 'x')", [t.network.id, a, `agent:${t.agents[0]!}`]);
    await t.db.exec('PRAGMA foreign_keys = ON');
    const r = await t.cout.month(t.dir, '2027-02');
    if (!r.ok) throw new Error(r.code);
    expect(r.value.lines.files).toEqual([
      { fileId: a, feesCents: 1_200_000, networkShareCents: 616_667, agentSharesCents: 583_333, sponsorSharesCents: 0 },
      { fileId: expect.any(String), feesCents: 1_000_000, networkShareCents: 300_000, agentSharesCents: 700_000, sponsorSharesCents: 0 },
    ]);
  });

  it('ne compte que la part du réseau, jamais la part d’une agence partenaire ni le parrainage [R624]', async () => {
    const t = await setup();
    await t.settings(1000, 0);
    await t.sale('2027-02-10T10:00:00.000Z', { reseau: 200_000, agent: 500_000, parrainage: 20_000, agency: 280_000 });
    const r = await t.cout.month(t.dir, '2027-02');
    if (!r.ok) throw new Error(r.code);
    // Honoraires 1 000 000 toutes taxes, soit 833 333 hors taxe ; la part de l'agence, 280 000 toutes taxes, soit
    // 233 333 hors taxe, en sort : 600 000. Au réseau : 600 000 − 500 000 − 20 000 = 80 000 ; provision sur l'agent seul.
    expect(r.value).toMatchObject({ feesCents: 600_000, networkShareCents: 80_000, agentSharesCents: 500_000, sponsorSharesCents: 20_000, provisionCents: 50_000, requiredCents: 50_000, covered: true, networkBp: 1333, breakEvenNetworkBp: 879 });
  });

  it('une facture du mois non classée, ou aucun réglage : mois incomplet, jamais dit couvert [R623] [R624]', async () => {
    const t = await setup();
    await t.sale('2027-02-10T10:00:00.000Z', { reseau: 900_000, agent: 100_000 });
    const loose = await t.invoice('2027-02-14', 10_000);
    let r = await t.cout.month(t.dir, '2027-02');
    if (!r.ok) throw new Error(r.code);
    expect(r.value).toMatchObject({ complete: false, missing: ['reglage', 'factures_non_classees'], covered: false, breakEvenNetworkBp: null, settings: null });
    expect(r.value.lines.unclassified).toEqual([loose]);
    await t.settings();
    r = await t.cout.month(t.dir, '2027-02');
    if (!r.ok) throw new Error(r.code);
    expect(r.value).toMatchObject({ complete: false, missing: ['factures_non_classees'], covered: false });
    await t.cout.assign(t.dir, loose, 'diffusion');
    r = await t.cout.month(t.dir, '2027-02');
    if (!r.ok) throw new Error(r.code);
    expect(r.value).toMatchObject({ complete: true, missing: [], covered: true, costs: { diffusion: 10_000 } });
  });

  it('un classement ne change plus : une nouvelle version le remplace, la base refuse le reste [R623]', async () => {
    const t = await setup();
    await t.settings(0, 0);
    const id = await t.invoice('2027-02-14', 10_000);
    expect(await t.cout.assign(t.dir, id, 'ia')).toMatchObject({ ok: true, value: { version: 1, category: 'ia' } });
    expect(await t.cout.assign(t.dir, id, 'ia')).toMatchObject({ ok: false, rule: 'R623', code: 'deja_classee' });
    expect(await t.cout.assign(t.dir, id, 'hors_agents')).toMatchObject({ ok: true, value: { version: 2, category: 'hors_agents' } });
    expect(await t.cout.assign(t.dir, id, 'loyer')).toMatchObject({ ok: false, rule: 'R623', code: 'bad_category' });
    const r = await t.cout.month(t.dir, '2027-02');
    if (!r.ok) throw new Error(r.code);
    expect(r.value.costs.ia).toBe(0);
    expect(r.value.lines.invoices).toEqual([{ invoiceId: id, category: 'hors_agents', htCents: 10_000 }]);
    // La base : ni changement, ni effacement, ni version hors suite, ni auteur autre que la direction, ni autre réseau.
    await expect(t.db.run("UPDATE agent_cost_assignments SET category = 'ia'")).rejects.toThrow();
    await expect(t.db.run('DELETE FROM agent_cost_assignments')).rejects.toThrow();
    await expect(t.db.run("INSERT INTO agent_cost_assignments (invoice_id, network_id, version, category, assigned_by, assigned_at) VALUES (?, ?, 5, 'ia', 'direction:d', 'x')", [id, t.network.id])).rejects.toThrow();
    await expect(t.db.run("INSERT INTO agent_cost_assignments (invoice_id, network_id, version, category, assigned_by, assigned_at) VALUES (?, ?, 3, 'ia', 'agent:a', 'x')", [id, t.network.id])).rejects.toThrow();
    await expect(t.db.run("INSERT INTO agent_cost_assignments (invoice_id, network_id, version, category, assigned_by, assigned_at) VALUES (?, ?, 3, 'ia', 'direction:d', 'x')", [id, t.other.id])).rejects.toThrow();
    // Une facture d'un autre réseau n'existe pas pour cette direction.
    const foreign = await t.invoice('2027-02-14', 10_000, t.other.id);
    expect(await t.cout.assign(t.dir, foreign, 'ia')).toMatchObject({ ok: false, code: 'not_found' });
  });

  it('les réglages se versionnent, jamais pour un mois passé ; un mois lit la version qui valait [R624]', async () => {
    const t = await setup();
    expect(await t.cout.setSettings(t.dir, { validFrom: '2027-02', provisionBp: 1000, marginBp: 0, reason: 'trop tard' })).toMatchObject({ ok: false, rule: 'R624', code: 'mois_passe' });
    expect(await t.cout.setSettings(t.dir, { validFrom: '2027-03', provisionBp: 10_001, marginBp: 0, reason: 'trop' })).toMatchObject({ ok: false, rule: 'R624', code: 'bad_bp' });
    expect(await t.cout.setSettings(t.dir, { validFrom: '2027-03', provisionBp: 1.5, marginBp: 0, reason: 'décimal' })).toMatchObject({ ok: false, rule: 'R624', code: 'bad_bp' });
    expect(await t.cout.setSettings(t.dir, { validFrom: '2027-03', provisionBp: 10, marginBp: 0, reason: 'x', extra: 1 })).toMatchObject({ ok: false, code: 'unknown_field' });
    const v1 = await t.settings(500, 0);
    expect(v1.version).toBe(1);
    expect(await t.cout.setSettings(t.dir, { validFrom: '2027-03', provisionBp: 2000, marginBp: 2000, reason: 'Nouveau réglage' })).toMatchObject({ ok: true, value: { version: 2 } });
    await t.sale('2027-02-10T10:00:00.000Z', { reseau: 500_000, agent: 500_000 });
    const r = await t.cout.month(t.dir, '2027-02');
    if (!r.ok) throw new Error(r.code);
    // Février lit la version 1 (valable depuis janvier), pas la version 2 (valable depuis mars).
    expect(r.value).toMatchObject({ settings: { version: 1, provisionBp: 500 }, provisionCents: 25_000 });
    await expect(t.db.run('UPDATE agent_cost_settings SET margin_bp = 0')).rejects.toThrow();
    await expect(t.db.run('DELETE FROM agent_cost_settings')).rejects.toThrow();
    await expect(t.db.run("INSERT INTO agent_cost_settings (network_id, version, valid_from, provision_bp, margin_bp, reason, set_by, set_at) VALUES (?, 7, '2027-04', 0, 0, 'hors suite', 'direction:d', 'x')", [t.network.id])).rejects.toThrow();
  });

  it('refuse le mois en cours et un mois mal écrit [R624]', async () => {
    const t = await setup();
    expect(await t.cout.month(t.dir, '2027-03')).toMatchObject({ ok: false, rule: 'R624', code: 'month_not_finished' });
    expect(await t.cout.month(t.dir, '2027-04')).toMatchObject({ ok: false, rule: 'R624', code: 'month_not_finished' });
    expect(await t.cout.month(t.dir, '2027-13')).toMatchObject({ ok: false, code: 'bad_month' });
  });

  it('compte les agents présents du mois : entrés avant sa fin, pas partis avant son début [R624]', async () => {
    const t = await setup();
    await t.settings();
    // Eden part le 31 janvier : absent de février ; Dominique part le 15 février : présent.
    await t.db.run("INSERT INTO agent_departures (id, network_id, agent_id, notice_given_on, leaves_on, reason, notice_months, created_by, created_at) VALUES ('d1', ?, ?, '2027-01-01', '2027-01-31', 'demission_agent', 1, 'direction:d', 'x')", [t.network.id, t.agents[3]!]);
    await t.db.run("INSERT INTO agent_departures (id, network_id, agent_id, notice_given_on, leaves_on, reason, notice_months, created_by, created_at) VALUES ('d2', ?, ?, '2027-01-15', '2027-02-15', 'demission_agent', 1, 'direction:d', 'x')", [t.network.id, t.agents[2]!]);
    const r = await t.cout.month(t.dir, '2027-02');
    if (!r.ok) throw new Error(r.code);
    expect(r.value.agentsPresent).toBe(3);
    // Avant l'entrée des agents (décembre 2026), personne : aucun agent moyen.
    const d = await t.cout.month(t.dir, '2026-12');
    if (!d.ok) throw new Error(d.code);
    expect(d.value).toMatchObject({ agentsPresent: 0, averageAgent: null });
  });

  it('aucun chiffre ni aucun identifiant d’agent, la moyenne seule [R625] [R14]', async () => {
    const t = await setup();
    await t.settings();
    await t.sale('2027-02-10T10:00:00.000Z', { reseau: 300_000, agent: 600_000, partage: 50_000, parrainage: 50_000 });
    const r = await t.cout.month(t.dir, '2027-02');
    if (!r.ok) throw new Error(r.code);
    const text = JSON.stringify(r.value);
    for (const id of t.agents) expect(text).not.toContain(id);
    expect(text).not.toMatch(/agentId|beneficiary/);
  });

  it('montre le coût de l’IA mesuré sur les seuls messages de l’IA, sans le compter [R624]', async () => {
    const t = await setup();
    await t.settings(0, 0);
    await t.db.exec('PRAGMA foreign_keys = OFF');
    await t.db.run("INSERT INTO messages (id, network_id, person_id, channel, direction, author_kind, body, cost_cents, occurred_at, created_at) VALUES ('m1', ?, 'p', 'email', 'out', 'ai', 'texte', 123, '2027-02-02T10:00:00.000Z', 'x')", [t.network.id]);
    await t.db.run("INSERT INTO messages (id, network_id, person_id, channel, direction, author_kind, body, cost_cents, occurred_at, created_at) VALUES ('m2', ?, 'p', 'email', 'out', 'ai', 'texte', 999, '2027-03-02T10:00:00.000Z', 'x')", [t.network.id]);
    await t.db.run("INSERT INTO messages (id, network_id, person_id, channel, direction, author_kind, body, cost_cents, occurred_at, created_at) VALUES ('m3', ?, 'p', 'sms', 'out', 'agent', 'texte', 999, '2027-02-03T10:00:00.000Z', 'x')", [t.network.id]);
    await t.db.exec('PRAGMA foreign_keys = ON');
    const r = await t.cout.month(t.dir, '2027-02');
    if (!r.ok) throw new Error(r.code);
    expect(r.value).toMatchObject({ aiMeasuredCents: 123, costs: { ia: 0 }, fullCostCents: 0 });
  });

  it('la direction seule ; un refus et chaque lecture sont écrits au journal avant la réponse [R16]', async () => {
    const t = await setup();
    for (const role of ['agent', 'conformite', 'partner']) {
      const v = t.as(role, 'u-1');
      expect(await t.cout.month(v, '2027-02')).toMatchObject({ ok: false, rule: 'R16', code: 'role' });
      expect(await t.cout.assign(v, 'x', 'ia')).toMatchObject({ ok: false, rule: 'R16' });
      expect(await t.cout.setSettings(v, { validFrom: '2027-03', provisionBp: 0, marginBp: 0, reason: 'essai' })).toMatchObject({ ok: false, rule: 'R16' });
    }
    expect((await t.events('acces.refuse')).filter((e) => String(e.kind).startsWith('agent_cost'))).toHaveLength(9);
    const r = await t.cout.month(t.dir, '2027-02');
    expect(r.ok).toBe(true);
    expect(await t.events('cout_agent.mois_lu')).toEqual([{ rule: 'R16', month: '2027-02', complete: false, covered: false }]);
    // Une direction d'un autre réseau ne lit rien de ce réseau.
    await t.sale('2027-02-10T10:00:00.000Z', { reseau: 300_000, agent: 700_000 });
    const o = await t.cout.month(t.as('direction', 'dir-2', t.other.id), '2027-02');
    if (!o.ok) throw new Error(o.code);
    expect(o.value).toMatchObject({ networkShareCents: 0, agentsPresent: 1 });
  });
});

