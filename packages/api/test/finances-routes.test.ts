import { expect, it, vi } from 'vitest';
import { handleRequest, type ApiConfig } from '../src/app.ts';
import { runScheduler, sha256Hex } from '../src/index.ts';
import { ActeVente, Echeancier } from '../../core/src/dossiers/index.ts';
import { RelancesImpayes, type LecteurFactures, type SupplierInvoiceRead } from '../../core/src/facturation/index.ts';
import { Commissions, Encaissements, Factures, PlateformeEssai } from '../../core/src/pilotage/index.ts';
import { PROOF, setupDossier } from '../../core/test/dossiers-jeu.ts';
import { describeWithSqlite } from '../../core/test/sqlite.ts';

// Tout est inventé : réseau, agents, fournisseurs, numéros, montants, relevés et clés.
const ACT_PROOF = 'preuves/0b6f1d2e-7777-4a2b-8c3d-000000000b04.pdf';
const at9 = (day: string) => new Date(`${day}T07:00:00.000Z`);
const KEYS = {
  agent: 'test-cle-br04-agent-aaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  direction: 'test-cle-br04-direction-cccccccccccccccccccccc',
  conformite: 'test-cle-br04-conformite-ddddddddddddddddddddd',
};
type Who = keyof typeof KEYS;

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
const READS: Record<string, SupplierInvoiceRead | null> = {
  'factures/juste.pdf': goodRead(),
  'factures/fausse.pdf': goodRead({ number: { value: 'FA-0043', page: 1 }, ttcCents: { value: 125_375, page: 2 } }),
};
const lecteur: LecteurFactures = { read: async (ref) => READS[ref] ?? null };

/** Une vente menée jusqu'à la facture d'honoraires validée : F-2027-00001, 10 000,00 €, émise le 11 juin 2027. */
async function setup(withReader = true) {
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

  const ids: Record<Who, { role: string; userId: string }> = {
    agent: { role: 'agent', userId: t.agent.userId },
    direction: { role: 'direction', userId: t.direction.userId },
    conformite: { role: 'compliance', userId: 'conformite-1' },
  };
  const apiKeys = JSON.stringify(await Promise.all((Object.keys(KEYS) as Who[]).map(async (w) => ({ sha256: await sha256Hex(KEYS[w]), networkId: t.network.id, ...ids[w] }))));
  const config: ApiConfig = { db: t.db, apiKeys, mode: 'essai', now: t.now, ...(withReader ? { lecteurFactures: lecteur } : {}) };
  const raw = (who: Who, method: string, path: string, body?: string, type = 'application/json') =>
    handleRequest(new Request(`https://aimmo-api.example.test/v1${path}`, { method, headers: { authorization: `Bearer ${KEYS[who]}`, ...(body === undefined ? {} : { 'content-type': type }) }, ...(body === undefined ? {} : { body }) }), config);
  const http = async (who: Who, method: string, path: string, body?: unknown) => {
    const r = await raw(who, method, path, body === undefined ? undefined : JSON.stringify(body));
    return { status: r.status, body: (await r.json()) as { ok: boolean; data?: any; rule?: string; code?: string; problems?: unknown; added?: number; already?: number } };
  };
  const statement = async (csv: string) => {
    const r = await raw('direction', 'POST', '/finances/banque/releve', csv, 'text/csv');
    return { status: r.status, body: (await r.json()) as { ok: boolean; added?: number; already?: number; code?: string } };
  };
  const refusals = async () => (await t.journal.all()).filter((e) => e.type === 'acces.refuse');
  const count = async (table: string) => Number((await t.db.first<{ n: number }>(`SELECT count(*) AS n FROM ${table}`))?.n);
  return { ...t, invoice: h.value, raw, http, statement, refusals, count };
}

describeWithSqlite('BR04 · routes des finances : factures fournisseurs, banque, relances, rapports', () => {
  it('[R16] chaque route refuse le mauvais rôle, avant le corps : 403 et refus au journal, rien rangé', async () => {
    const t = await setup();
    const DEF = { measures: ['contacts'], grouping: 'total' };
    const routes: [Who[], string, string, unknown?][] = [
      [['agent', 'conformite'], 'POST', '/finances/fournisseurs/lectures', { documentRef: 'factures/juste.pdf' }],
      [['agent', 'conformite'], 'POST', '/finances/fournisseurs/lectures/l-1/rangement', { ttcCents: 1 }],
      [['agent', 'conformite'], 'GET', '/finances/fournisseurs'],
      [['agent', 'conformite'], 'POST', '/finances/banque/releve', 'pas un objet'],
      [['agent', 'conformite'], 'GET', '/finances/banque/propositions'],
      [['agent', 'conformite'], 'POST', '/finances/banque/lignes/l-1/rapprochement', { invoiceId: 'f-1' }],
      [['agent', 'conformite'], 'GET', '/finances/banque/rapprochements'],
      [['agent', 'conformite'], 'GET', '/finances/banque/fraicheur'],
      [['agent', 'conformite'], 'POST', '/finances/banque/factures/f-1/encaissement'],
      [['agent', 'conformite'], 'GET', '/finances/relances'],
      [['agent', 'conformite'], 'POST', '/finances/relances/r-1/validation'],
      [['conformite'], 'GET', '/finances/rapports'],
      [['conformite'], 'POST', '/finances/rapports', { name: 'Mes contacts', definition: DEF }],
      [['conformite'], 'POST', '/finances/rapports/lecture', { definition: DEF, from: '2027-01-01', to: '2027-06-30' }],
      [['conformite'], 'POST', '/finances/rapports/r-1/lecture', { from: '2027-01-01', to: '2027-06-30' }],
    ];
    for (const [whos, method, path, body] of routes) {
      for (const who of whos) {
        const before = (await t.refusals()).length;
        const r = await t.http(who, method, path, body);
        expect(r.status, `${who} ${method} ${path}`).toBe(403);
        expect(r.body).toMatchObject({ ok: false, rule: 'R16', code: 'role' });
        expect((await t.refusals()).length, `${who} ${method} ${path}`).toBe(before + 1);
      }
    }
    for (const table of ['supplier_invoice_reads', 'supplier_invoices', 'bank_lines', 'bank_reconciliations', 'custom_reports']) expect(await t.count(table), table).toBe(0);
  });

  it('[R550] la facture lue n’est rangée que si elle se recompte ; seule une correction nommée porte un montant ; sans lecteur, fermé', async () => {
    const t = await setup();
    expect(await t.http('direction', 'POST', '/finances/fournisseurs/lectures', { documentRef: 'factures/illisible.pdf' })).toMatchObject({ status: 400, body: { code: 'unreadable' } });
    const wrong = await t.http('direction', 'POST', '/finances/fournisseurs/lectures', { documentRef: 'factures/fausse.pdf' });
    expect(wrong).toMatchObject({ status: 200, body: { ok: true, data: { problems: [{ code: 'total_ttc', field: 'ttcCents' }], recorded: false } } });
    const id = wrong.body.data.id as string;
    // Telle que lue, elle ne se range pas ; une correction qui ne recompte toujours pas non plus.
    expect(await t.http('direction', 'POST', `/finances/fournisseurs/lectures/${id}/rangement`, {})).toMatchObject({ status: 409, body: { rule: 'R550', code: 'ecart' } });
    expect(await t.http('direction', 'POST', `/finances/fournisseurs/lectures/${id}/rangement`, { ttcCents: 125_000 })).toMatchObject({ status: 409, body: { rule: 'R550', code: 'ecart' } });
    // Un champ qui n'est pas une correction nommée, même un montant : refusé sans rien ranger.
    expect(await t.http('direction', 'POST', `/finances/fournisseurs/lectures/${id}/rangement`, { totalCents: 125_275 })).toMatchObject({ status: 400, body: { code: 'unknown_field' } });
    expect(await t.count('supplier_invoices')).toBe(0);
    const fixed = await t.http('direction', 'POST', `/finances/fournisseurs/lectures/${id}/rangement`, { ttcCents: 125_275 });
    expect(fixed).toMatchObject({ status: 200, body: { data: { ttcCents: 125_275, corrected: ['ttcCents'] } } });
    expect(await t.http('direction', 'POST', `/finances/fournisseurs/lectures/${id}/rangement`, { ttcCents: 125_275 })).toMatchObject({ status: 400, body: { code: 'already' } });
    expect(await t.http('direction', 'POST', '/finances/fournisseurs/lectures/inconnue/rangement', {})).toMatchObject({ status: 404 });
    expect((await t.http('direction', 'GET', '/finances/fournisseurs')).body.data).toHaveLength(1);
    // Au journal : aucun montant, aucun nom de fournisseur [R13].
    expect(JSON.stringify(await t.journal.all())).not.toMatch(/Imprimerie|125275/);
    // Sans lecteur configuré, la lecture est fermée ; ranger et lister restent possibles.
    const closed = await setup(false);
    expect(await closed.http('direction', 'POST', '/finances/fournisseurs/lectures', { documentRef: 'factures/juste.pdf' })).toMatchObject({ status: 503, body: { code: 'lecteur_absent' } });
    expect(await closed.count('supplier_invoice_reads')).toBe(0);
    expect((await closed.http('direction', 'GET', '/finances/fournisseurs')).status).toBe(200);
  });

  it('[R551] [R15] le relevé déposé tel quel : rien de doublé, ni libellé ni IBAN ; une ligne, une facture, au même montant', async () => {
    const t = await setup();
    t.setClock(at9('2027-07-15'));
    expect(await t.raw('direction', 'POST', '/finances/banque/releve', JSON.stringify({ csv: 'x' }))).toMatchObject({ status: 400 });
    const csv = '2027-07-14;VIR F-2027-00001;10 000,00\n2027-07-15;VIR NOTAIRE F-2027-00001 FR7630006000011234567890189;10 000,00\n2027-07-15;VIR AUTRE;9 999,99\n';
    expect(await t.statement(csv)).toMatchObject({ status: 200, body: { ok: true, added: 3, already: 0 } });
    expect(await t.statement(csv)).toMatchObject({ status: 200, body: { ok: true, added: 0, already: 3 } });
    expect(JSON.stringify(await t.db.all('SELECT * FROM bank_lines'))).not.toMatch(/FR76|NOTAIRE/);
    expect(await t.statement('2030-01-01;VIR;1,00')).toMatchObject({ status: 400, body: { code: 'bad_statement' } });
    const proposals = (await t.http('direction', 'GET', '/finances/banque/propositions')).body.data as { lineId: string; amountCents: number; day: string }[];
    const [first, second] = proposals.filter((p) => p.amountCents === 1_000_000).sort((a, b) => a.day.localeCompare(b.day));
    const other = proposals.find((p) => p.amountCents === 999_999)!;
    // Un autre montant : refusé ; aucun montant n'entre par la route.
    expect(await t.http('direction', 'POST', `/finances/banque/lignes/${other.lineId}/rapprochement`, { invoiceId: t.invoice.id })).toMatchObject({ status: 409, body: { rule: 'R551', code: 'amount' } });
    expect(await t.http('direction', 'POST', `/finances/banque/lignes/${other.lineId}/rapprochement`, { invoiceId: t.invoice.id, amountCents: 999_999 })).toMatchObject({ status: 400, body: { code: 'unknown_field' } });
    expect(await t.http('direction', 'POST', `/finances/banque/lignes/${first!.lineId}/rapprochement`, { invoiceId: t.invoice.id })).toMatchObject({ status: 200, body: { data: { invoiceId: t.invoice.id, mode: 'direction' } } });
    expect(await t.http('direction', 'POST', `/finances/banque/lignes/${second!.lineId}/rapprochement`, { invoiceId: t.invoice.id })).toMatchObject({ status: 409, body: { rule: 'R551', code: 'already' } });
    expect(await t.http('direction', 'POST', '/finances/banque/lignes/inconnue/rapprochement', { invoiceId: t.invoice.id })).toMatchObject({ status: 404 });
    expect(await t.count('bank_reconciliations')).toBe(1);
  });

  it('[R551] BR93 · le relevé envoyé en JSON sous la seule clé csv : la même lecture que le CSV direct, rien d’autre admis', async () => {
    const t = await setup();
    t.setClock(at9('2027-07-15'));
    const csv = 'Date;Libellé;Montant\n2027-07-14;VIR F-2027-00001;10 000,00\n2027-07-15;VIR AUTRE;9 999,99\n';
    const asJson = (body: unknown) => t.raw('direction', 'POST', '/finances/banque/releve', JSON.stringify(body));
    const first = await asJson({ csv });
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ ok: true, added: 2, already: 0 });
    // Le même fichier, par le CSV direct : déjà connu, rien de doublé.
    expect(await t.statement(csv)).toMatchObject({ status: 200, body: { ok: true, added: 0, already: 2 } });
    expect(await t.count('bank_lines')).toBe(2);
    // Une autre clé, même un montant, est refusée sans rien ranger.
    const extra = await asJson({ csv: '2027-07-15;VIR NEUF;1,00\n', amountCents: 100 });
    expect(extra.status).toBe(400);
    expect(await extra.json()).toMatchObject({ ok: false, code: 'unknown_field' });
    for (const bad of [{}, { csv: 12 }, ['csv'], { csv: null }]) {
      const r = await asJson(bad);
      expect(r.status, JSON.stringify(bad)).toBe(400);
      expect(await r.json()).toMatchObject({ ok: false, code: 'invalid_body' });
    }
    const broken = await t.raw('direction', 'POST', '/finances/banque/releve', '{"csv":', 'application/json');
    expect(broken.status).toBe(400);
    // Une ligne illisible arrête tout, avec son numéro, comme le CSV direct.
    const unreadable = await asJson({ csv: '2027-07-15;VIR NEUF;1,00\n2027-07-15;sans montant\n' });
    expect(unreadable.status).toBe(400);
    expect(await unreadable.json()).toMatchObject({ code: 'bad_statement', line: 2 });
    // Plus gros que la limite du relevé : refusé, rien de rangé.
    const big = await asJson({ csv: `2027-07-15;VIR;1,00\n${'x'.repeat(1_000_001)}` });
    expect(big.status).toBe(400);
    expect(await t.count('bank_lines')).toBe(2);
  });

  it('[R552] l’encaissement par la route a pour preuve la ligne de banque ; une facture non rapprochée ne s’encaisse pas', async () => {
    const t = await setup();
    t.setClock(at9('2027-07-15'));
    expect(await t.http('direction', 'POST', `/finances/banque/factures/${t.invoice.id}/encaissement`)).toMatchObject({ status: 409, body: { rule: 'R552', code: 'not_reconciled' } });
    await t.statement('2027-07-14;VIR SEPA ETUDE REF F-2027-00001;10 000,00\n');
    const lineId = ((await t.http('direction', 'GET', '/finances/banque/propositions')).body.data as { lineId: string }[])[0]!.lineId;
    expect((await t.http('direction', 'POST', `/finances/banque/lignes/${lineId}/rapprochement`, { invoiceId: t.invoice.id })).status).toBe(200);
    expect((await t.http('direction', 'GET', '/finances/banque/rapprochements')).body.data).toEqual([expect.objectContaining({ invoiceId: t.invoice.id, lineId, amountCents: 1_000_000, receipt: null })]);
    expect((await t.http('direction', 'POST', `/finances/banque/factures/${t.invoice.id}/encaissement`)).status).toBe(200);
    expect(await t.db.first('SELECT proof_ref FROM commission_receipts WHERE file_id = ?', [t.fileId])).toEqual({ proof_ref: `banque:${lineId}` });
    expect(await t.http('direction', 'POST', `/finances/banque/factures/${t.invoice.id}/encaissement`)).toMatchObject({ status: 400, body: { code: 'already' } });
    // BR93 : l'encaissement rangé se lit au rapprochement, avec sa preuve dite « cette ligne », jamais la référence brute.
    const [rec] = (await t.http('direction', 'GET', '/finances/banque/rapprochements')).body.data as { receipt: Record<string, unknown> }[];
    expect(rec!.receipt).toEqual({ receivedAt: '2027-07-13T22:00:00.000Z', payoutDueAt: expect.any(String), proof: 'ligne' });
    expect(JSON.stringify(rec)).not.toContain('banque:');
  });

  it('[R552] BR93 · un encaissement rangé avec une autre preuve (commissions) se dit « autre » au rapprochement', async () => {
    const t = await setup();
    t.setClock(at9('2027-07-15'));
    await t.statement('2027-07-14;VIR SEPA ETUDE REF F-2027-00001;10 000,00\n');
    const lineId = ((await t.http('direction', 'GET', '/finances/banque/propositions')).body.data as { lineId: string }[])[0]!.lineId;
    expect((await t.http('direction', 'POST', `/finances/banque/lignes/${lineId}/rapprochement`, { invoiceId: t.invoice.id })).status).toBe(200);
    const other = await new Encaissements(t.db, t.acces, t.journal, { now: t.now }).recordReceipt(t.direction, t.fileId, { receivedAt: '2027-07-14T08:00:00.000Z', proofRef: 'virements/releve-juillet.pdf' });
    expect(other.ok).toBe(true);
    const [rec] = (await t.http('direction', 'GET', '/finances/banque/rapprochements')).body.data as { receipt: Record<string, unknown> }[];
    expect(rec!.receipt).toEqual({ receivedAt: '2027-07-14T08:00:00.000Z', payoutDueAt: expect.any(String), proof: 'autre' });
    expect(JSON.stringify(rec)).not.toContain('releve-juillet');
  });

  it('[R553] aucune relance sans validation : la route valide une fois, n’envoie rien, et ne change pas le texte', async () => {
    const t = await setup();
    t.setClock(at9('2027-07-12'));
    expect(await new RelancesImpayes(t.db, t.journal, { now: t.now }).prepare(t.network.id)).toBe(1);
    const list = await t.http('direction', 'GET', '/finances/relances');
    expect(list.body.data).toEqual([expect.objectContaining({ label: 'F-2027-00001', rank: 1, status: 'a_valider', validatedBy: null })]);
    const id = list.body.data[0].id as string;
    const read = { preparedAt: list.body.data[0].preparedAt as string };
    // AU094b : la validation dit quel texte a été lu ; sans lui, ou avec un autre, rien n'est validé.
    expect(await t.http('direction', 'POST', `/finances/relances/${id}/validation`, {})).toMatchObject({ status: 400, body: { code: 'bad_revision' } });
    expect(await t.http('direction', 'POST', `/finances/relances/${id}/validation`, { preparedAt: '2027-01-01T00:00:00.000Z' })).toMatchObject({ status: 409, body: { rule: 'R553', code: 'texte_change' } });
    expect(await t.http('direction', 'POST', `/finances/relances/${id}/validation`, read)).toMatchObject({ status: 200, body: { ok: true, mode: 'essai' } });
    expect(await t.http('direction', 'POST', `/finances/relances/${id}/validation`, read)).toMatchObject({ status: 409, body: { rule: 'R553', code: 'not_pending' } });
    expect(await t.http('direction', 'POST', '/finances/relances/inconnue/validation', read)).toMatchObject({ status: 404 });
    // Validée, elle attend le passage d'envoi : aucune route n'envoie.
    expect((await t.http('direction', 'GET', '/finances/relances')).body.data[0]).toMatchObject({ status: 'validee', text: list.body.data[0].text });
    expect(await t.count('trial_outbox')).toBe(0);
    expect((await t.http('direction', 'POST', '/finances/relances/envoi', {})).status).toBe(404);
  });

  it('[R560] [R14] les rapports par la route : catalogue fermé, ses propres chiffres, jamais deux agents côte à côte', async () => {
    const t = await setup();
    const DEF = { measures: ['mandats', 'contacts'], grouping: 'total' };
    const period = { from: '2027-01-01', to: '2027-06-30' };
    const mine = await t.http('agent', 'POST', '/finances/rapports/lecture', { definition: DEF, ...period });
    expect(mine).toMatchObject({ status: 200, body: { data: { scope: 'agent', agentId: t.agent.userId, definition: { measures: ['contacts', 'mandats'], grouping: 'total' } } } });
    // Chaque chiffre est le nombre de ses lignes.
    const cells = mine.body.data.cells as { value: number; lines: unknown[] }[];
    expect(cells.some((c) => c.value > 0)).toBe(true);
    for (const cell of cells) expect(cell.value).toBe(cell.lines.length);
    expect(await t.http('agent', 'POST', '/finances/rapports/lecture', { definition: { measures: ['honoraires'], grouping: 'total' }, ...period })).toMatchObject({ status: 409, body: { rule: 'R560', code: 'bad_measures' } });
    expect(await t.http('agent', 'POST', '/finances/rapports/lecture', { definition: { measures: ['contacts'], grouping: 'agent' }, ...period })).toMatchObject({ status: 409, body: { rule: 'R14' } });
    expect(await t.http('direction', 'POST', '/finances/rapports/lecture', { definition: DEF, ...period, network: true, agentId: t.agent.userId })).toMatchObject({ status: 409, body: { rule: 'R14', code: 'compares_agents' } });
    expect(await t.http('agent', 'POST', '/finances/rapports/lecture', { definition: DEF, ...period, network: true })).toMatchObject({ status: 403, body: { rule: 'R16' } });
    expect(await t.http('direction', 'POST', '/finances/rapports/lecture', { definition: DEF, ...period, network: true })).toMatchObject({ status: 200, body: { data: { scope: 'reseau' } } });
    expect(await t.http('direction', 'POST', '/finances/rapports/lecture', { definition: DEF, ...period, network: 'oui' })).toMatchObject({ status: 400 });
    // Enregistré, il ne se relit que par son auteur.
    const saved = await t.http('agent', 'POST', '/finances/rapports', { name: 'Mes mandats', definition: DEF });
    expect(saved.status).toBe(200);
    const id = saved.body.data.id as string;
    expect((await t.http('agent', 'GET', '/finances/rapports')).body.data).toEqual([expect.objectContaining({ id, name: 'Mes mandats' })]);
    expect(await t.http('agent', 'POST', `/finances/rapports/${id}/lecture`, period)).toMatchObject({ status: 200, body: { data: { scope: 'agent' } } });
    expect(await t.http('direction', 'POST', `/finances/rapports/${id}/lecture`, period)).toMatchObject({ status: 404, body: { code: 'unknown_report' } });
  });

  it('[R553] [R13] BR92 · la fraîcheur du dernier relevé, lue par la direction : jour et âge, jamais un montant (Jamais vu)', async () => {
    const t = await setup();
    t.setClock(at9('2027-07-15'));
    expect(await t.http('direction', 'GET', '/finances/banque/fraicheur')).toMatchObject({ status: 200, body: { ok: true, data: { lastImportDay: null, ageDays: null, fresh: false, reason: 'aucun_releve', maxAgeDays: 7 } } });
    expect(await t.statement('2027-07-14;VIR F-2027-00001;10 000,00\n')).toMatchObject({ status: 200, body: { added: 1 } });
    const today = await t.http('direction', 'GET', '/finances/banque/fraicheur');
    expect(today).toMatchObject({ status: 200, body: { data: { lastImportDay: '2027-07-15', ageDays: 0, fresh: true, reason: 'frais' } } });
    // Ni montant, ni libellé, ni ligne : seulement le jour du dépôt et son âge.
    expect(Object.keys(today.body.data).sort()).toEqual(['ageDays', 'fresh', 'lastImportDay', 'maxAgeDays', 'reason']);
    expect(JSON.stringify(today.body)).not.toMatch(/1000000|10 000|VIR/);
    t.setClock(at9('2027-07-22'));
    expect((await t.http('direction', 'GET', '/finances/banque/fraicheur')).body.data).toMatchObject({ ageDays: 7, fresh: true, reason: 'frais' });
    t.setClock(at9('2027-07-23'));
    expect((await t.http('direction', 'GET', '/finances/banque/fraicheur')).body.data).toMatchObject({ lastImportDay: '2027-07-15', ageDays: 8, fresh: false, reason: 'releve_ancien' });
  });

  it('[R551] [R553] [R26] BR92 · le passage du Worker rapproche seul et prépare les relances ; rien ne part hors du mode essai', async () => {
    const t = await setup();
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    try {
      // Le paiement prouvé par le relevé : personne ne rapproche, le passage horaire le fait seul.
      t.setClock(at9('2027-06-20'));
      expect(await t.statement('2027-06-20;VIR ETUDE F-2027-00001;10 000,00\n')).toMatchObject({ status: 200, body: { added: 1 } });
      expect(await t.count('bank_reconciliations')).toBe(0);
      expect((await runScheduler({ db: t.db, mode: 'essai', now: t.now }))?.ran).toContain('facturation.rapprochement');
      expect(await t.count('bank_reconciliations')).toBe(1);
      // Hors mode essai, rien ne passe.
      expect(await runScheduler({ db: t.db, mode: 'reel', now: t.now })).toBeNull();

      // Une autre vente, impayée, sur un relevé du jour : à 6 h, la relance est préparée, à valider ; rien ne part.
      const u = await setup();
      u.setClock(at9('2027-07-10'));
      expect(await u.statement('2027-07-10;PRLV FOURNISSEUR;-125,75\n')).toMatchObject({ status: 200 });
      u.setClock(new Date('2027-07-12T04:05:00.000Z'));
      expect((await runScheduler({ db: u.db, mode: 'essai', now: u.now }))?.ran).toEqual(expect.arrayContaining(['facturation.rapprochement', 'facturation.relances_preparation']));
      expect(await u.count('invoice_reminders')).toBe(1);
      expect((await new RelancesImpayes(u.db, u.journal, { now: u.now }).list(u.direction)).ok).toBe(true);
      expect(await u.count('trial_outbox')).toBe(0);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
