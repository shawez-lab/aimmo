import { expect, it } from 'vitest';
import { ActeVente, Echeancier, SALE_FOLLOW_UP_PURPOSE } from '../src/dossiers/index.ts';
import { fundsInOutgoing } from '../src/dossiers/bouclier.ts';
import { paymentRequestIn } from '../src/envoi/texte.ts';
import {
  FacturesFournisseurs,
  Rapprochements,
  RelancesImpayes,
  checkSupplierInvoice,
  parseStatement,
  unpaidReminderText,
  type LecteurFactures,
  type SupplierInvoiceRead,
} from '../src/facturation/index.ts';
import { Commissions, Encaissements, Factures, PlateformeEssai } from '../src/pilotage/index.ts';
import { PROOF, setupDossier } from './dossiers-jeu.ts';
import { describeWithSqlite } from './sqlite.ts';

// Tout est inventé : fournisseurs, numéros, montants, clients, relevés.
const ACT_PROOF = 'preuves/0b6f1d2e-7777-4a2b-8c3d-000000000049.pdf';
const at9 = (day: string) => new Date(`${day}T07:00:00.000Z`);

/** Une facture fournisseur lue, juste : 1 000,00 € à 20 % et 50,00 € à 5,5 %. */
function goodRead(patch: Partial<SupplierInvoiceRead> = {}): SupplierInvoiceRead {
  return {
    supplier: { value: 'Imprimerie Exemple', page: 1 },
    number: { value: 'FA-0042', page: 1 },
    issuedOn: { value: '2027-06-01', page: 1 },
    vatLines: [
      { value: { baseCents: 100_000, rateBp: 2000, vatCents: 20_000 }, page: 1 },
      { value: { baseCents: 5_000, rateBp: 550, vatCents: 275 }, page: 2 },
    ],
    htCents: { value: 105_000, page: 2 },
    vatCents: { value: 20_275, page: 2 },
    ttcCents: { value: 125_275, page: 2 },
    ...patch,
  };
}

it('[R550] une facture lue juste se recompte : aucune remarque', () => {
  expect(checkSupplierInvoice(goodRead(), '2027-06-12')).toEqual([]);
  // Un centime d'arrondi sur une ligne est admis : 33,33 € à 20 % font 6,666 €, lus 6,67 €.
  const rounded = goodRead({ vatLines: [{ value: { baseCents: 3_333, rateBp: 2000, vatCents: 667 }, page: 1 }], htCents: { value: 3_333, page: 1 }, vatCents: { value: 667, page: 1 }, ttcCents: { value: 4_000, page: 1 } });
  expect(checkSupplierInvoice(rounded, '2027-06-12')).toEqual([]);
});

it('[R550] chaque montant lu est vérifié contre son total et sa TVA', () => {
  const codes = (r: SupplierInvoiceRead) => checkSupplierInvoice(r, '2027-06-12').map((p) => `${p.code}:${p.field}`);
  // Le total toutes taxes ne fait pas hors taxe plus TVA.
  expect(codes(goodRead({ ttcCents: { value: 125_375, page: 2 } }))).toEqual(['total_ttc:ttcCents']);
  // La TVA totale ne fait pas la somme des lignes (et donc le toutes taxes non plus).
  expect(codes(goodRead({ vatCents: { value: 20_200, page: 2 }, ttcCents: { value: 125_200, page: 2 } }))).toEqual(['total_tva:vatCents']);
  // Le hors taxe ne fait pas la somme des bases.
  expect(codes(goodRead({ htCents: { value: 104_000, page: 2 }, ttcCents: { value: 124_275, page: 2 } }))).toEqual(['total_ht:htCents']);
  // La taxe d'une ligne ne fait pas base × taux, à plus d'un centime.
  const badLine = goodRead();
  badLine.vatLines[0] = { value: { baseCents: 100_000, rateBp: 2000, vatCents: 19_000 }, page: 1 };
  expect(codes(badLine)).toContain('tva_ligne:vatLines.0');
  // Un taux qui n'existe pas en France.
  const badRate = goodRead();
  badRate.vatLines[1] = { value: { baseCents: 5_000, rateBp: 700, vatCents: 350 }, page: 2 };
  expect(codes(badRate)).toContain('taux:vatLines.1');
  // Un champ manquant, une date future, une page absente.
  expect(codes(goodRead({ number: { value: ' ', page: 1 } }))).toEqual(['champ:number']);
  expect(codes(goodRead({ issuedOn: { value: '2027-07-01', page: 1 } }))).toEqual(['champ:issuedOn']);
  expect(codes(goodRead({ supplier: { value: 'Imprimerie Exemple', page: 0 } }))).toEqual(['champ:supplier']);
  expect(codes(goodRead({ vatLines: [] }))).toContain('champ:vatLines');
});

it('[R551] le relevé est lu sans garder le libellé : jour, montant, numéros de facture cités', () => {
  const r = parseStatement('Date;Libellé;Montant\n15/07/2027;VIR SEPA ETUDE EXEMPLE REF F-2027-00001;10 000,00\n2027-07-16;PRLV FOURNISSEUR;-125,75\n');
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  expect(r.value.map((l) => [l.day, l.amountCents, l.refs])).toEqual([
    ['2027-07-15', 1_000_000, ['F-2027-00001']],
    ['2027-07-16', -12_575, []],
  ]);
  // Une ligne illisible arrête tout : rien n'est rangé d'un relevé à moitié lu.
  expect(parseStatement('2027-07-15;VIR;10 000,00\n31/02/2027;VIR;1,00')).toEqual({ ok: false, line: 2 });
  expect(parseStatement('2027-07-15;VIR;abc')).toEqual({ ok: false, line: 1 });
});

it('[R62] [R553] le texte d’une relance ne demande aucun paiement et ne porte aucune coordonnée bancaire', () => {
  const text = unpaidReminderText({ firstName: 'Léa', label: 'F-2027-00001', amountCents: 1_000_000, issuedOn: '2027-06-11', dueOn: '2027-07-11' });
  expect(text).toBe(
    'Bonjour Léa,\n\nla facture F-2027-00001 de 10 000,00 €, émise le 11 juin 2027, arrivait à échéance le 11 juillet 2027. Elle n\'apparaît pas encore dans nos encaissements.\n\nSi elle a déjà été réglée, par vous ou par l’étude du notaire, une simple réponse à ce message nous permet de mettre nos comptes à jour.',
  );
  expect(fundsInOutgoing(text)).toBe(false);
  expect(paymentRequestIn(text)).toBe(false);
  expect(text).not.toMatch(/mandataire|gratuit|\bIA\b|intelligence|[()]/);
});

describeWithSqlite('HX49 · factures fournisseurs, rapprochement bancaire et relances des impayés', () => {
  /** Une vente menée jusqu'à la facture d'honoraires validée : F-2027-00001, 10 000,00 €, émise le 11 juin 2027. */
  async function invoiced() {
    const t = await setupDossier('appartement');
    const echeancier = new Echeancier(t.db, t.acces, t.journal, { now: t.now });
    const c = new Commissions(t.db, t.acces, t.journal, { now: t.now });
    await c.setGrid(t.direction, { validFrom: '2027-03-01', defaultRateBp: 7000 });
    await t.startCompromis();
    t.setClock(at9('2027-03-11'));
    for (const [kind, day] of [['compromis_signe', '2027-03-10'], ['notification_acquereur', '2027-03-11'], ['dia_recue', '2027-03-11'], ['date_limite_pret', '2027-05-10'], ['etat_date_attendu', '2027-05-20'], ['acte_prevu', '2027-06-10']] as const) {
      const r = await echeancier.record(t.agent, t.fileId, { kind, day, proofRef: PROOF });
      if (!r.ok) throw new Error(r.code);
    }
    await c.sync(t.network.id);
    const status = await t.pieces.status(t.agent, t.fileId);
    if (!status.ok) throw new Error(status.code);
    for (const piece of status.value.missing) {
      const r = await t.pieces.add(t.agent, t.fileId, { piece, ref: t.upload(), issuedOn: '2027-03-11' });
      if (!r.ok) throw new Error(r.code);
    }
    t.setClock(at9('2027-06-11'));
    const acte = await new ActeVente(t.db, t.acces, t.journal, t.storage, { now: t.now }).record(t.agent, t.fileId, { signedOn: '2027-06-10', proofRef: ACT_PROOF });
    if (!acte.ok) throw new Error(acte.code);
    await c.sync(t.network.id);
    const f = new Factures(t.db, t.acces, t.journal, { now: t.now, plateforme: new PlateformeEssai() });
    await f.prepare(t.network.id);
    const drafts = await f.drafts(t.direction);
    if (!drafts.ok) throw new Error('drafts');
    const h = await f.validate(t.direction, drafts.value.find((d) => d.kind === 'honoraires')!.id);
    if (!h.ok) throw new Error('facture');
    const banque = new Rapprochements(t.db, t.acces, t.journal, { now: t.now });
    return { ...t, c, f, banque, invoice: h.value };
  }

  it('[R550] la facture lue n’est rangée que si elle se recompte ; une correction est nommée et recomptée ; la direction seule', async () => {
    const t = await invoiced();
    const reads: Record<string, SupplierInvoiceRead | null> = {
      'factures/juste.pdf': goodRead(),
      'factures/fausse.pdf': goodRead({ ttcCents: { value: 125_375, page: 2 } }),
      'factures/illisible.pdf': null,
    };
    const lecteur: LecteurFactures = { read: async (ref) => reads[ref] ?? null };
    const ff = new FacturesFournisseurs(t.db, t.journal, lecteur, { now: t.now });
    // Un agent ne lit ni ne range les factures du réseau [R16].
    expect(await ff.read(t.agent, 'factures/juste.pdf')).toMatchObject({ ok: false, rule: 'R16' });
    expect(await ff.read(t.direction, 'factures/illisible.pdf')).toMatchObject({ ok: false, code: 'unreadable' });
    const wrong = await ff.read(t.direction, 'factures/fausse.pdf');
    if (!wrong.ok) throw new Error('lecture');
    expect(wrong.value.problems).toEqual([{ code: 'total_ttc', field: 'ttcCents' }]);
    // Telle que lue, elle ne se range pas.
    expect(await ff.record(t.direction, wrong.value.id)).toMatchObject({ ok: false, rule: 'R550', code: 'ecart' });
    // Une correction qui ne recompte toujours pas : refusée.
    expect(await ff.record(t.direction, wrong.value.id, { ttcCents: 125_000 })).toMatchObject({ ok: false, rule: 'R550', code: 'ecart' });
    // Un champ inconnu : refusé.
    expect(await ff.record(t.direction, wrong.value.id, { total: 1 } as never)).toMatchObject({ ok: false, code: 'bad_corrections' });
    // Le toutes taxes corrigé par la direction : rangée, la correction nommée.
    const fixed = await ff.record(t.direction, wrong.value.id, { ttcCents: 125_275 });
    expect(fixed).toMatchObject({ ok: true, value: { ttcCents: 125_275, corrected: ['ttcCents'] } });
    // La même facture (même fournisseur, même numéro) ne se range pas deux fois.
    const again = await ff.read(t.direction, 'factures/juste.pdf');
    if (!again.ok) throw new Error('lecture');
    expect(again.value.problems).toEqual([]);
    expect(await ff.record(t.direction, again.value.id)).toMatchObject({ ok: false, code: 'already' });
    expect(await ff.record(t.agent, again.value.id)).toMatchObject({ ok: false, rule: 'R16' });
    const list = await ff.list(t.direction);
    expect(list.ok && list.value).toHaveLength(1);
    // La base recompte chaque ligne aussi : une taxe fausse, même avec des totaux qui se tiennent, est refusée.
    await expect(
      t.db.run(
        "INSERT INTO supplier_invoices (id, network_id, read_id, supplier, number, issued_on, ht_cents, vat_cents, ttc_cents, vat_lines, corrected, recorded_by, created_at) VALUES ('y', ?, ?, 'Autre', 'N2', '2027-06-01', 10000, 1, 10001, '[{\"baseCents\":10000,\"rateBp\":2000,\"vatCents\":1}]', '[]', 'direction:d', '2027-06-11')",
        [t.network.id, again.value.id],
      ),
    ).rejects.toThrow();
    // Une ligne sans taux, au taux nul en texte, ou à une base négative : refusée par la base aussi.
    for (const [i, line] of ['{\"baseCents\":10000,\"vatCents\":1}', '{\"baseCents\":10000,\"rateBp\":null,\"vatCents\":1}', '{\"baseCents\":10000,\"rateBp\":\"2000\",\"vatCents\":1}', '{\"baseCents\":10000,\"rateBp\":0,\"vatCents\":\"1\"}'].entries()) {
      await expect(
        t.db.run(
          `INSERT INTO supplier_invoices (id, network_id, read_id, supplier, number, issued_on, ht_cents, vat_cents, ttc_cents, vat_lines, corrected, recorded_by, created_at) VALUES (?, ?, ?, 'Autre', ?, '2027-06-01', 10000, 1, 10001, '[${line}]', '[]', 'direction:d', '2027-06-11')`,
          [`z${i}`, t.network.id, again.value.id, `N${i + 3}`],
        ),
      ).rejects.toThrow('ne se recompte pas');
    }
    // La base recompte aussi : une facture qui ne se recompte pas est refusée même écrite à la main.
    await expect(
      t.db.run(
        "INSERT INTO supplier_invoices (id, network_id, read_id, supplier, number, issued_on, ht_cents, vat_cents, ttc_cents, vat_lines, corrected, recorded_by, created_at) VALUES ('x', ?, ?, 'Autre', 'N1', '2027-06-01', 100, 20, 120, '[{\"baseCents\":100,\"rateBp\":2000,\"vatCents\":10}]', '[]', 'direction:d', '2027-06-11')",
        [t.network.id, again.value.id],
      ),
    ).rejects.toThrow();
    // Au journal : aucun montant, aucun nom de fournisseur [R13].
    const events = JSON.stringify(await t.journal.bySubject(`network:${t.network.id}`));
    expect(events).not.toContain('Imprimerie');
    expect(events).not.toContain('125275');
  });

  it('[R551] [R15] le même relevé déposé deux fois ne double rien ; aucun libellé ni coordonnée bancaire rangé', async () => {
    const t = await invoiced();
    t.setClock(at9('2027-07-01'));
    const csv = 'Date;Libellé;Montant\n2027-06-20;VIR M EXEMPLE FR7630006000011234567890189;55,00\n2027-06-20;VIR M EXEMPLE FR7630006000011234567890189;55,00\n2027-06-21;PRLV;-10,00\n';
    expect(await t.banque.importStatement(t.agent, csv)).toMatchObject({ ok: false, rule: 'R16' });
    expect(await t.banque.importStatement(t.direction, csv)).toEqual({ ok: true, added: 3, already: 0 });
    expect(await t.banque.importStatement(t.direction, csv)).toEqual({ ok: true, added: 0, already: 3 });
    const all = JSON.stringify(await t.db.all('SELECT * FROM bank_lines'));
    expect(all).not.toContain('FR76');
    expect(all).not.toContain('EXEMPLE');
    // Un relevé daté du futur est refusé.
    expect(await t.banque.importStatement(t.direction, '2030-01-01;VIR;1,00')).toMatchObject({ ok: false, code: 'bad_statement' });
  });

  it('[R551] un encaissement n’est rapproché qu’à une seule facture, et une facture qu’à une seule ligne', async () => {
    const t = await invoiced();
    t.setClock(at9('2027-07-15'));
    // Deux lignes citent la facture au même montant : aucun choix sûr, rien n'est rapproché seul.
    await t.banque.importStatement(t.direction, '2027-07-14;VIR F-2027-00001;10 000,00\n2027-07-15;VIR NOTAIRE F-2027-00001;10 000,00\n2027-07-15;VIR AUTRE;9 999,99\n');
    expect(await t.banque.run(t.network.id)).toBe(0);
    const proposals = await t.banque.proposals(t.direction);
    if (!proposals.ok) throw new Error('proposals');
    const cited = proposals.value.filter((p) => p.amountCents === 1_000_000).sort((a, b) => a.day.localeCompare(b.day));
    const [first, second] = cited;
    const other = proposals.value.find((p) => p.amountCents === 999_999);
    expect(first!.candidates).toEqual([{ invoiceId: t.invoice.id, label: 'F-2027-00001' }]);
    expect(other!.candidates).toEqual([]);
    // Un autre montant : refusé, par le code et par la base.
    expect(await t.banque.confirm(t.direction, other!.lineId, t.invoice.id)).toMatchObject({ ok: false, rule: 'R551', code: 'amount' });
    await expect(t.db.run("INSERT INTO bank_reconciliations (line_id, invoice_id, network_id, mode, by, created_at) VALUES (?, ?, ?, 'direction', 'x', 'y')", [other!.lineId, t.invoice.id, t.network.id])).rejects.toThrow();
    // Deux rapprochements de la même facture en même temps : un seul tient.
    const both = await Promise.all([t.banque.confirm(t.direction, first!.lineId, t.invoice.id), t.banque.confirm(t.direction, second!.lineId, t.invoice.id)]);
    expect(both.filter((r) => r.ok)).toHaveLength(1);
    expect(both.find((r) => !r.ok)).toMatchObject({ rule: 'R551', code: 'already' });
    expect((await t.db.first<{ n: number }>('SELECT COUNT(*) AS n FROM bank_reconciliations'))?.n).toBe(1);
    // La base tient aussi l'unicité de la facture, même écrite à la main.
    await expect(t.db.run("INSERT INTO bank_reconciliations (line_id, invoice_id, network_id, mode, by, created_at) VALUES (?, ?, ?, 'direction', 'x', 'y')", [second!.lineId, t.invoice.id, t.network.id])).rejects.toThrow();
    // Un agent ne rapproche rien [R16].
    expect(await t.banque.confirm(t.agent, second!.lineId, t.invoice.id)).toMatchObject({ ok: false, rule: 'R16' });
  });

  it('[R551] [R552] le passage rapproche seul ce qui ne laisse qu’un choix ; l’encaissement a pour preuve la ligne de banque', async () => {
    const t = await invoiced();
    t.setClock(at9('2027-07-15'));
    // Pas encore rapprochée : aucun encaissement par ce chemin.
    expect(await t.banque.recordReceipt(t.direction, t.invoice.id)).toMatchObject({ ok: false, rule: 'R552', code: 'not_reconciled' });
    // Une ligne antérieure au jour de la facture n'est pas rapprochée.
    await t.banque.importStatement(t.direction, '2027-06-01;VIR F-2027-00001;10 000,00\n2027-07-14;VIR SEPA ETUDE REF F-2027-00001;10 000,00\n');
    expect(await t.banque.run(t.network.id)).toBe(1);
    expect(await t.banque.run(t.network.id)).toBe(0);
    const list = await t.banque.list(t.direction);
    expect(list.ok && list.value).toEqual([expect.objectContaining({ invoiceId: t.invoice.id, label: 'F-2027-00001', day: '2027-07-14', amountCents: 1_000_000, mode: 'auto' })]);
    const lineId = list.ok ? list.value[0]!.lineId : '';
    const receipt = await t.banque.recordReceipt(t.direction, t.invoice.id);
    expect(receipt.ok).toBe(true);
    const row = await t.db.first<{ proof_ref: string; received_at: string }>('SELECT proof_ref, received_at FROM commission_receipts WHERE file_id = ?', [t.fileId]);
    expect(row).toEqual({ proof_ref: `banque:${lineId}`, received_at: '2027-07-13T22:00:00.000Z' });
    // L'encaissement se lit aussi par K03, une seule fois.
    expect(await t.banque.recordReceipt(t.direction, t.invoice.id)).toMatchObject({ ok: false, code: 'already' });
    const enc = await new Encaissements(t.db, t.acces, t.journal, { now: t.now }).tasks(t.direction);
    expect(enc.ok && enc.value.map((x) => x.fileId)).toEqual([t.fileId]);
    // Une facture corrigée par un avoir n'est plus proposée.
    const other = await invoiced();
    t.setClock(at9('2027-07-15'));
    await other.f.credit(other.direction, other.invoice.id, 'erreur_montant');
    other.setClock(at9('2027-07-15'));
    await other.banque.importStatement(other.direction, '2027-07-14;VIR F-2027-00001;10 000,00\n');
    expect(await other.banque.run(other.network.id)).toBe(0);
    const p = await other.banque.proposals(other.direction);
    expect(p.ok && p.value[0]!.candidates).toEqual([]);
    // La base aussi refuse une facture corrigée, une ligne d'avant la facture ou une ligne de débit [R551].
    const raw = (lineId: string, invoiceId: string, net: string) => other.db.run("INSERT INTO bank_reconciliations (line_id, invoice_id, network_id, mode, by, created_at) VALUES (?, ?, ?, 'direction', 'x', 'y')", [lineId, invoiceId, net]);
    await expect(raw(p.ok ? p.value[0]!.lineId : '', other.invoice.id, other.network.id)).rejects.toThrow();
    expect(await other.banque.confirm(other.direction, p.ok ? p.value[0]!.lineId : '', other.invoice.id)).toMatchObject({ ok: false, rule: 'R551', code: 'credited' });
    const early = await invoiced();
    early.setClock(at9('2027-07-15'));
    await early.banque.importStatement(early.direction, '2027-06-01;VIR F-2027-00001;10 000,00\n2027-07-14;PRLV;-10 000,00\n');
    const lines = await early.db.all<{ id: string; amount_cents: number }>('SELECT id, amount_cents FROM bank_lines');
    for (const l of lines) await expect(raw(l.id, early.invoice.id, early.network.id)).rejects.toThrow();
  });

  it('[R553] aucune relance sans validation ; validée, elle passe par le contrôle central en essai ; une facture rapprochée ferme sa relance', async () => {
    const t = await invoiced();
    await t.store.addIdentifier({ networkId: t.network.id, personId: t.buyerId, kind: 'email', value: 'acheteur@example.test' });
    await t.store.addConsent({ networkId: t.network.id, personId: t.buyerId, purpose: SALE_FOLLOW_UP_PURPOSE, channel: 'email', proof: 'mandat', givenAt: new Date('2027-02-10T09:00:00.000Z') });
    const relances = new RelancesImpayes(t.db, t.journal, { now: t.now });
    const outbox = () => t.db.all<{ body: string }>('SELECT m.body FROM messages m JOIN trial_outbox o ON o.message_id = m.id WHERE m.person_id = ?', [t.buyerId]);
    // Le jour de l'échéance : rien encore.
    t.setClock(at9('2027-07-11'));
    expect(await relances.prepare(t.network.id)).toBe(0);
    // Le lendemain, lundi 12 juillet : une relance préparée, à valider. Rien ne part sans validation.
    t.setClock(at9('2027-07-12'));
    expect(await relances.prepare(t.network.id)).toBe(1);
    expect(await relances.prepare(t.network.id)).toBe(0);
    expect(await relances.send(t.network.id)).toBe(0);
    expect(await outbox()).toEqual([]);
    const list = await relances.list(t.direction);
    if (!list.ok) throw new Error('list');
    expect(list.value).toEqual([expect.objectContaining({ label: 'F-2027-00001', rank: 1, status: 'a_valider', validatedBy: null })]);
    expect(list.value[0]!.text).toContain('la facture F-2027-00001 de 10 000,00 €, émise le 11 juin 2027, arrivait à échéance le 11 juillet 2027.');
    // La base refuse de la marquer envoyée sans validation, et une relance qui naîtrait déjà validée ou envoyée.
    await expect(t.db.run("UPDATE invoice_reminders SET status = 'envoyee' WHERE id = ?", [list.value[0]!.id])).rejects.toThrow();
    for (const status of ['validee', 'envoyee']) {
      await expect(
        t.db.run(
          "INSERT INTO invoice_reminders (id, network_id, invoice_id, rank, person_id, text, status, rule, message_id, prepared_at, validated_by, validated_at, updated_at) VALUES (?, ?, ?, 3, ?, 'x', ?, NULL, NULL, 'a', 'direction:x', 'a', 'a')",
          [`faux-${status}`, t.network.id, t.invoice.id, t.buyerId, status],
        ),
      ).rejects.toThrow();
    }
    // Un agent ne valide rien [R16] ; un texte validé ne change pas.
    expect(await relances.validate(t.agent, list.value[0]!.id)).toMatchObject({ ok: false, rule: 'R16' });
    expect(await relances.list(t.agent)).toMatchObject({ ok: false, rule: 'R16' });
    expect(await relances.validate(t.direction, list.value[0]!.id)).toEqual({ ok: true });
    expect(await relances.validate(t.direction, list.value[0]!.id)).toMatchObject({ ok: false, rule: 'R553', code: 'not_pending' });
    await expect(t.db.run("UPDATE invoice_reminders SET text = 'autre' WHERE id = ?", [list.value[0]!.id])).rejects.toThrow();
    // Validée : elle passe par le contrôle central, dans la boîte d'essai, avec le texte validé.
    // Deux passages d'envoi en même temps : un seul envoi, et la relance reste « envoyée ».
    const both = await Promise.all([relances.send(t.network.id), relances.send(t.network.id)]);
    expect(both.sort()).toEqual([0, 1]);
    const once = await relances.list(t.direction);
    expect(once.ok && once.value[0]!.status).toBe('envoyee');
    const sent = await outbox();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toContain(list.value[0]!.text.split('\n')[2]!);
    expect(fundsInOutgoing(sent[0]!.body)).toBe(false);
    // Pas de seconde relance avant 15 jours ; le 27 juillet, une seconde, à valider.
    t.setClock(at9('2027-07-26'));
    expect(await relances.prepare(t.network.id)).toBe(0);
    t.setClock(at9('2027-07-27'));
    expect(await relances.prepare(t.network.id)).toBe(1);
    // La seconde a son propre texte : validée, elle part aussi, sans être prise pour un doublon [R05].
    const second = await relances.list(t.direction);
    const r2 = second.ok ? second.value.find((r) => r.rank === 2)! : null;
    expect(r2!.text).toContain('C\'est notre deuxième message à ce sujet.');
    expect(fundsInOutgoing(r2!.text)).toBe(false);
    expect(await relances.validate(t.direction, r2!.id)).toEqual({ ok: true });
    expect(await relances.send(t.network.id)).toBe(1);
    expect(await outbox()).toHaveLength(2);
    // Une troisième le 11 août, avec son texte à elle, laissée à valider.
    t.setClock(at9('2027-08-11'));
    expect(await relances.prepare(t.network.id)).toBe(1);
    const third = await relances.list(t.direction);
    expect(third.ok && third.value.find((r) => r.rank === 3)!.text).toContain('C\'est notre troisième message à ce sujet.');
    // La banque prouve le paiement : la relance en attente se ferme, rien ne part, plus rien n'est préparé.
    await t.banque.importStatement(t.direction, '2027-08-10;VIR F-2027-00001;10 000,00\n');
    expect(await t.banque.run(t.network.id)).toBe(1);
    expect(await relances.send(t.network.id)).toBe(0);
    const after = await relances.list(t.direction);
    expect(after.ok && after.value.map((r) => [r.rank, r.status])).toEqual([[1, 'envoyee'], [2, 'envoyee'], [3, 'close']]);
    t.setClock(at9('2027-09-20'));
    expect(await relances.prepare(t.network.id)).toBe(0);
    expect(await outbox()).toHaveLength(2);
    // Au journal : aucun texte, aucun montant [R13].
    const events = JSON.stringify(await t.journal.bySubject(`sale_file:${t.fileId}`));
    expect(events).not.toContain('apparaît');
    expect(events).not.toContain('1000000');
  });

  it('[R553] une facture rapprochée pendant le passage d’envoi ne reçoit pas sa relance ; une facture encaissée n’en reçoit aucune', async () => {
    const t = await invoiced();
    await t.store.addIdentifier({ networkId: t.network.id, personId: t.buyerId, kind: 'email', value: 'acheteur@example.test' });
    await t.store.addConsent({ networkId: t.network.id, personId: t.buyerId, purpose: SALE_FOLLOW_UP_PURPOSE, channel: 'email', proof: 'mandat', givenAt: new Date('2027-02-10T09:00:00.000Z') });
    t.setClock(at9('2027-07-12'));
    const relances = new RelancesImpayes(t.db, t.journal, { now: t.now });
    expect(await relances.prepare(t.network.id)).toBe(1);
    const list = await relances.list(t.direction);
    await relances.validate(t.direction, list.ok ? list.value[0]!.id : '');
    await t.banque.importStatement(t.direction, '2027-07-12;VIR F-2027-00001;10 000,00\n');
    // Le rapprochement arrive entre la lecture des relances validées et l'enregistrement de l'envoi.
    const run = t.banque.run.bind(t.banque);
    const original = t.db.all.bind(t.db);
    let once = false;
    t.db.all = (async (sql: string, params?: readonly (string | number | null)[]) => {
      const rows = await original(sql, params);
      if (!once && sql.includes("r.status = 'validee'")) {
        once = true;
        await run(t.network.id);
      }
      return rows;
    }) as typeof t.db.all;
    expect(await relances.send(t.network.id)).toBe(0);
    t.db.all = original;
    const after = await relances.list(t.direction);
    expect(after.ok && after.value.map((r) => [r.status, r.rule])).toEqual([['close', 'rapprochee']]);
    expect((await t.db.first<{ n: number }>('SELECT COUNT(*) AS n FROM trial_outbox'))?.n).toBe(0);
    // Une autre vente encaissée par K03, sans ligne de banque : aucune relance.
    const other = await invoiced();
    other.setClock(at9('2027-06-12'));
    const r = await new Encaissements(other.db, other.acces, other.journal, { now: other.now }).recordReceipt(other.direction, other.fileId, { receivedAt: '2027-06-12T06:00:00.000Z', proofRef: 'preuves/releve-notaire.pdf' });
    expect(r.ok).toBe(true);
    other.setClock(at9('2027-07-20'));
    expect(await new RelancesImpayes(other.db, other.journal, { now: other.now }).prepare(other.network.id)).toBe(0);
  });

  /** Une seconde facture d'honoraires du réseau, inventée, de 4 000,00 €. */
  const second = async (t: Awaited<ReturnType<typeof invoiced>>) => {
    await t.db.run('PRAGMA foreign_keys = OFF');
    await t.db.run("INSERT INTO invoices (id, network_id, issuer, year, number, kind, file_id, draft_id, corrects_invoice_id, content, amount_cents, issued_on, validated_by, created_at) VALUES ('inv-2', ?, 'reseau', 2027, 2, 'honoraires', 'dossier-2', 'dr-2', NULL, '{}', 400000, '2027-06-12', 'direction:x', '2027-06-12T08:00:00.000Z')", [t.network.id]);
    await t.db.run('PRAGMA foreign_keys = ON');
    return 'inv-2';
  };
  const lineOf = async (t: Awaited<ReturnType<typeof invoiced>>, amountCents: number) => (await t.db.first<{ id: string }>('SELECT id FROM bank_lines WHERE amount_cents = ? ORDER BY day, id LIMIT 1', [amountCents]))!.id;

  it('[R551] AU094 · constat : un virement groupé solde deux factures, chacune pour sa part ; le reste de la ligne se dit au centime', async () => {
    const t = await invoiced();
    const inv2 = await second(t);
    t.setClock(at9('2027-07-15'));
    await t.banque.importStatement(t.direction, '2027-07-14;VIR ETUDE GROUPE;14 000,50\n');
    const line = await lineOf(t, 1_400_050);
    // Avant AU094 : un montant différent ne se rapprochait d'aucune facture.
    expect(await t.banque.confirm(t.direction, line, t.invoice.id)).toMatchObject({ ok: false, code: 'amount' });
    const r = await t.banque.allocate(t.direction, line, [{ invoiceId: t.invoice.id, amountCents: 1_000_000 }, { invoiceId: inv2, amountCents: 400_000 }]);
    if (!r.ok) throw new Error((r as { code: string }).code);
    expect(r.value.lines).toEqual([expect.objectContaining({ lineId: line, amountCents: 1_400_050, allocatedCents: 1_400_000, remainingCents: 50 })]);
    expect(r.value.invoices.map((i) => [i.invoiceId, i.paidCents, i.remainingCents, i.settled])).toEqual([[t.invoice.id, 1_000_000, 0, true], [inv2, 400_000, 0, true]]);
    // Soldée, la facture s'encaisse, la ligne en preuve ; plus de relance, plus de proposition un à un.
    expect((await t.banque.recordReceipt(t.direction, t.invoice.id)).ok).toBe(true);
    expect(await t.db.first('SELECT proof_ref FROM commission_receipts WHERE file_id = ?', [t.fileId])).toEqual({ proof_ref: `banque:${line}` });
    const p = await t.banque.proposals(t.direction);
    expect(p.ok && p.value.map((x) => x.lineId)).not.toContain(line);
    // Rien ne change ni ne s'efface [R17] ; la base refuse une part de trop.
    await expect(t.db.run('UPDATE bank_allocations SET amount_cents = 1')).rejects.toThrow();
    await expect(t.db.run("INSERT INTO bank_allocations (line_id, invoice_id, network_id, amount_cents, by, created_at) VALUES (?, 'inv-2', ?, 1, 'x', 'y')", [line, t.network.id])).rejects.toThrow();
  });

  it('[R551] [R552] AU094 · deux règlements partiels soldent une facture ; partielle, elle ne s’encaisse pas et sa relance dit le reste', async () => {
    const t = await invoiced();
    t.setClock(at9('2027-07-15'));
    await t.banque.importStatement(t.direction, '2027-07-10;VIR ACOMPTE;6 000,00\n2027-07-14;VIR SOLDE;4 000,00\n');
    const first = await lineOf(t, 600_000);
    const last = await lineOf(t, 400_000);
    expect((await t.banque.allocate(t.direction, first, [{ invoiceId: t.invoice.id, amountCents: 600_000 }])).ok).toBe(true);
    expect(await t.banque.recordReceipt(t.direction, t.invoice.id)).toMatchObject({ ok: false, rule: 'R552', code: 'partial' });
    await t.store.addIdentifier({ networkId: t.network.id, personId: t.buyerId, kind: 'email', value: 'acheteur@example.test' });
    await t.store.addConsent({ networkId: t.network.id, personId: t.buyerId, purpose: SALE_FOLLOW_UP_PURPOSE, channel: 'email', proof: 'mandat', givenAt: new Date('2027-02-10T09:00:00.000Z') });
    const relances = new RelancesImpayes(t.db, t.journal, { now: t.now });
    t.setClock(at9('2027-07-20'));
    await relances.prepare(t.network.id);
    const text = (await t.db.first<{ text: string }>('SELECT text FROM invoice_reminders ORDER BY prepared_at DESC LIMIT 1'))?.text ?? '';
    expect(text).toContain('Nous en avons reçu 6 000,00 € ; 4 000,00 € n\'apparaissent pas encore dans nos encaissements.');
    // Une part de trop est refusée, au centime ; le solde exact passe.
    expect(await t.banque.allocate(t.direction, last, [{ invoiceId: t.invoice.id, amountCents: 400_001 }])).toMatchObject({ ok: false, rule: 'R551' });
    const done = await t.banque.allocate(t.direction, last, [{ invoiceId: t.invoice.id, amountCents: 400_000 }]);
    expect(done.ok && done.value.invoices[0]).toMatchObject({ paidCents: 1_000_000, remainingCents: 0, settled: true, lines: [{ lineId: first, day: '2027-07-10', amountCents: 600_000 }, { lineId: last, day: '2027-07-14', amountCents: 400_000 }] });
    // Encaissée au jour de la dernière part, qui en fait la preuve.
    expect((await t.banque.recordReceipt(t.direction, t.invoice.id)).ok).toBe(true);
    expect(await t.db.first('SELECT proof_ref, received_at FROM commission_receipts WHERE file_id = ?', [t.fileId])).toEqual({ proof_ref: `banque:${last}`, received_at: '2027-07-13T22:00:00.000Z' });
    // La relance en attente se ferme.
    await relances.closeSettledReminders(t.network.id);
    expect(await t.db.all("SELECT status FROM invoice_reminders WHERE status IN ('a_valider', 'validee')")).toEqual([]);
  });

  it('[R16] [R551] AU094 · la direction seule partage ; une ligne déjà rapprochée un à un, un débit ou une facture corrigée n’en prennent pas', async () => {
    const t = await invoiced();
    t.setClock(at9('2027-07-15'));
    await t.banque.importStatement(t.direction, '2027-07-14;VIR F-2027-00001;10 000,00\n2027-07-14;PRLV;-50,00\n2027-07-14;VIR AUTRE;3 000,00\n');
    expect(await t.banque.run(t.network.id)).toBe(1);
    const whole = await lineOf(t, 1_000_000);
    const debit = await lineOf(t, -5_000);
    const other = await lineOf(t, 300_000);
    expect(await t.banque.allocate(t.agent, other, [{ invoiceId: t.invoice.id, amountCents: 1 }])).toMatchObject({ ok: false, rule: 'R16' });
    expect(await t.banque.allocate(t.direction, debit, [{ invoiceId: t.invoice.id, amountCents: 1 }])).toMatchObject({ ok: false, code: 'not_credit' });
    expect(await t.banque.allocate(t.direction, whole, [{ invoiceId: t.invoice.id, amountCents: 1 }])).toMatchObject({ ok: false, code: 'already' });
    expect(await t.banque.allocate(t.direction, other, [{ invoiceId: t.invoice.id, amountCents: 1 }])).toMatchObject({ ok: false, code: 'already' });
    for (const bad of [[], [{ invoiceId: t.invoice.id, amountCents: 0 }], [{ invoiceId: t.invoice.id, amountCents: 1.5 }], 'x']) {
      expect(await t.banque.allocate(t.direction, other, bad)).toMatchObject({ ok: false, code: 'bad_parts' });
    }
    expect(await t.db.first('SELECT COUNT(*) AS n FROM bank_allocations')).toEqual({ n: 0 });
  });
});

