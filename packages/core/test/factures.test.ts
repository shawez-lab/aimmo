import { expect, it } from 'vitest';
import { ActeVente, Echeancier } from '../src/dossiers/index.ts';
import { Commissions, Factures, PlateformeEssai, splitVat } from '../src/pilotage/index.ts';
import { PROOF, setupDossier } from './dossiers-jeu.ts';
import { appendEvent } from '../src/journal/journal.ts';
import { MemoryJournalStore } from '../src/journal/memory-store.ts';
import { describeWithSqlite } from './sqlite.ts';

// Tout est inventé : vente, clients, agents, montants.
const ACT_PROOF = 'preuves/0b6f1d2e-7777-4a2b-8c3d-000000000001.pdf';
const at9 = (day: string) => new Date(`${day}T08:00:00.000Z`);
const code = (agentId: string) => agentId.toUpperCase().replace(/[^A-Z0-9-]/g, '');

it('[R13] le numéro d’un reversement ne forme jamais un faux numéro de téléphone que le journal refuserait', async () => {
  // Un identifiant d'agent dont les chiffres, collés sans tirets, ressembleraient à un numéro de portable.
  const agentId = 'aaaaaaaa-aa06-1234-5678-aaaaaaaaaaaa';
  const label = (Factures.prototype as unknown as { label: (k: string, i: string, y: number, n: number) => string }).label.call(
    { issuerCode: (Factures.prototype as unknown as { issuerCode: (i: string) => string }).issuerCode },
    'reversement',
    `agent:${agentId}`,
    2027,
    1,
  );
  expect(label).toBe('RV-AAAAAAAA-AA06-1234-5678-AAAAAAAAAAAA-2027-00001');
  await expect(appendEvent(new MemoryJournalStore(), { type: 'facture.emise', actor: 'direction:d1', subject: 'sale_file:f1', data: { label } }, () => new Date())).resolves.toBeDefined();
});

it('hors taxe et TVA au centime : la TVA est le reste, tout se recompte', () => {
  expect(splitVat(1_000_000, 2000)).toEqual({ htCents: 833_333, vatCents: 166_667 });
  expect(splitVat(700_000, 0)).toEqual({ htCents: 700_000, vatCents: 0 });
  for (const ttc of [0, 1, 99, 123_457, 999_999]) {
    const s = splitVat(ttc, 2000);
    expect(s.htCents + s.vatCents).toBe(ttc);
  }
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


/** Une vente menée jusqu'à la commission due. */
async function due() {
  const t = await setup();
  const c = t.commissions();
  await c.setGrid(t.direction, { validFrom: '2027-03-01', defaultRateBp: 7000 });
  await t.compromis();
  await c.sync(t.network.id);
  await t.acte();
  await c.sync(t.network.id);
  const plateforme = new PlateformeEssai();
  const f = new Factures(t.db, t.acces, t.journal, { now: t.now, plateforme });
  return { ...t, c, f, plateforme };
}

describeWithSqlite('K02 · factures d’honoraires et de reversement, en mode essai', () => {
  it('[R71] brouillons préparés une fois, validés par la direction : numéros continus, contenu figé, avoir, nouveau brouillon', async () => {
    const t = await due();
    expect(await t.f.prepare(t.network.id)).toBe(2);
    expect(await t.f.prepare(t.network.id)).toBe(0);
    const drafts = await t.f.drafts(t.direction);
    if (!drafts.ok) throw new Error('drafts');
    expect(drafts.value.map((d) => [d.kind, d.issuer, d.amountCents, d.vatBp])).toEqual([
      ['honoraires', 'reseau', 1_000_000, 2000],
      ['reversement', `agent:${t.alexId}`, 700_000, 0],
    ]);
    const [h, r] = drafts.value;
    // Deux validations simultanées du même brouillon : une seule facture.
    const both = await Promise.all([t.f.validate(t.direction, h!.id), t.f.validate(t.direction, h!.id)]);
    expect(both.filter((x) => x.ok)).toHaveLength(1);
    const f1 = both.find((x) => x.ok)!;
    if (!f1.ok) throw new Error('f1');
    expect(f1.value.content).toMatchObject({ label: 'F-2027-00001', kind: 'honoraires', issuedOn: '2027-06-11', recipient: 'Acheteur Exemple', designation: 'Honoraires de transaction, bien REF-T-1', htCents: 833_333, vatCents: 166_667, ttcCents: 1_000_000 });
    expect(f1.value.content.mentions).toContain('Facture d’essai, sans valeur comptable.');
    expect(f1.value.transmitted).toEqual({ mode: 'essai', platformRef: `essai:${f1.value.id}` });
    expect(f1.value.content.saleDay).toBe('2027-06-10');
    // La facture d'honoraires passe la commission à « facturée » [R67].
    const list = await t.c.list(t.direction);
    expect(list.ok && list.value[0]!.status).toBe('facturee');
    const rv = await t.f.validate(t.direction, r!.id);
    expect(rv.ok && rv.value.content).toMatchObject({ label: `RV-${code(t.alexId)}-2027-00001`, issuer: 'Alex Agent', recipient: expect.any(String), ttcCents: 700_000, vatCents: 0 });
    expect(rv.ok && rv.value.content.mentions.join(' ')).toMatch(/expert-comptable/);
    // Un avoir, dans la même suite que la facture qu'il corrige, une seule fois ; jamais un avoir d'avoir.
    expect(await t.f.credit(t.direction, f1.value.id, 'pas_une_raison')).toMatchObject({ code: 'bad_reason' });
    const credits = await Promise.all([t.f.credit(t.direction, f1.value.id, 'erreur_destinataire'), t.f.credit(t.direction, f1.value.id, 'erreur_destinataire')]);
    expect(credits.filter((x) => x.ok)).toHaveLength(1);
    const av = credits.find((x) => x.ok)!;
    if (!av.ok) throw new Error('av');
    expect(av.value.content).toMatchObject({ label: 'AV-2027-00002', ttcCents: -1_000_000, htCents: -833_333, vatCents: -166_667, corrects: 'F-2027-00001' });
    expect(await t.f.credit(t.direction, av.value.id, 'autre')).toMatchObject({ code: 'not_creditable' });
    // Après l'avoir, un nouveau brouillon d'honoraires, et le numéro suivant.
    expect(await t.f.prepare(t.network.id)).toBe(1);
    const again = await t.f.drafts(t.direction);
    const f3 = await t.f.validate(t.direction, again.ok ? again.value[0]!.id : '');
    expect(f3.ok && f3.value.content.label).toBe('F-2027-00003');
    // La commission reste facturée par sa première preuve ; la facture qui remplace la première est dite au journal.
    expect((await t.journal.bySubject(`sale_file:${t.fileId}`)).filter((e) => e.type === 'facture.attente').map((e) => e.data.code)).toEqual(['remplace:F-2027-00003']);
    // Une facture ne change ni ne s'efface ; aucun numéro hors suite [R17, R71].
    await expect(t.db.run('UPDATE invoices SET amount_cents = 1 WHERE id = ?', [f1.value.id])).rejects.toThrow();
    await expect(t.db.run('DELETE FROM invoices WHERE id = ?', [f1.value.id])).rejects.toThrow();
    await expect(
      t.db.run("INSERT INTO invoices (id, network_id, issuer, year, number, kind, file_id, draft_id, corrects_invoice_id, content, amount_cents, issued_on, validated_by, created_at) VALUES ('x', ?, 'reseau', 2027, 9, 'avoir', ?, NULL, ?, '{}', 0, '2027-06-11', 'd', 'a')", [t.network.id, t.fileId, rv.ok ? rv.value.id : '']),
    ).rejects.toThrow();
    // Rien n'est parti ailleurs qu'à la plateforme d'essai [R26].
    expect(t.plateforme.received).toEqual(['F-2027-00001', `RV-${code(t.alexId)}-2027-00001`, 'AV-2027-00002', 'F-2027-00003']);
    // Une plateforme qui n'est ni d'essai ni réelle est refusée ; la réelle est acceptée depuis AU013.
    expect(() => new Factures(t.db, t.acces, t.journal, { plateforme: { mode: 'autre' } as never })).toThrow();
    // Au journal : numéros et sortes, jamais un montant ni un nom [R13].
    const logged = JSON.stringify((await t.journal.all()).filter((e) => e.type.startsWith('facture.')));
    expect(logged).not.toMatch(/1000000|700000|Acheteur|833333/);
  });

  it('l’export comptable recompte au centime toutes les factures et avoirs de la période', async () => {
    const t = await due();
    await t.f.prepare(t.network.id);
    const drafts = await t.f.drafts(t.direction);
    if (!drafts.ok) throw new Error('drafts');
    const f1 = await t.f.validate(t.direction, drafts.value[0]!.id);
    await t.f.validate(t.direction, drafts.value[1]!.id);
    if (!f1.ok) throw new Error('f1');
    await t.f.credit(t.direction, f1.value.id, 'erreur_montant');
    const csv = await t.f.exportCsv(t.direction, '2027-06-01', '2027-06-30');
    if (!csv.ok) throw new Error('csv');
    const lines = csv.value.trim().split('\r\n');
    expect(lines[0]).toBe('numero;date;sorte;emetteur;destinataire;designation;ht;tva;ttc;facture_corrigee;mode');
    expect(lines.slice(1, -1).map((l) => l.split(';')[0])).toEqual(['F-2027-00001', 'AV-2027-00002', `RV-${code(t.alexId)}-2027-00001`]);
    expect(lines.at(-1)).toBe('total;;;;;;7000,00;0,00;7000,00;;');
    const sum = lines.slice(1, -1).reduce((a, l) => a + Math.round(Number(l.split(';')[8]!.replace(',', '.')) * 100), 0);
    expect(sum).toBe(700_000);
    expect(await t.f.exportCsv(t.direction, '2027-07-01', '2027-06-01')).toMatchObject({ code: 'bad_day' });
  });

  it('[R16, R68] la direction seule valide, corrige et exporte ; un agent ne voit que ses reversements ; la conformité n’a pas les chiffres', async () => {
    const t = await due();
    await t.f.prepare(t.network.id);
    const drafts = await t.f.drafts(t.direction);
    if (!drafts.ok) throw new Error('drafts');
    const refusals = async () => (await t.journal.all()).filter((e) => e.type === 'acces.refuse').length;
    const before = await refusals();
    expect(await t.f.validate(t.agent, drafts.value[0]!.id)).toMatchObject({ ok: false, rule: 'R16' });
    expect(await t.f.drafts({ role: 'compliance', networkId: t.network.id, userId: 'c-1' })).toMatchObject({ ok: false, rule: 'R16' });
    expect(await t.f.exportCsv(t.agent, '2027-06-01', '2027-06-30')).toMatchObject({ ok: false, rule: 'R16' });
    expect((await refusals()) - before).toBe(3);
    expect(await t.f.validate({ ...t.direction, networkId: 'autre' }, drafts.value[0]!.id)).toMatchObject({ code: 'unknown' });
    for (const d of drafts.value) await t.f.validate(t.direction, d.id);
    const alex = await t.f.list(t.agent);
    expect(alex.ok && alex.value.map((i) => i.content.label)).toEqual([`RV-${code(t.alexId)}-2027-00001`]);
    const sam = await t.f.list(t.sam);
    expect(sam.ok && sam.value).toEqual([]);
    expect(await t.f.list({ role: 'compliance', networkId: t.network.id, userId: 'c-1' })).toMatchObject({ ok: false, rule: 'R16' });
    const all = await t.f.list(t.direction);
    expect(all.ok && all.value).toHaveLength(2);
  });

  it('un dossier sans payeur connu n’a pas de facture d’honoraires : dit une fois au journal', async () => {
    const t = await due();
    // Le jeu signe un mandat aux honoraires à la charge de l'acquéreur : on simule un mandat sans cette mention.
    await t.db.run('DROP TRIGGER commissions_fige');
    await t.db.run('UPDATE commissions SET fee_charge = NULL WHERE file_id = ?', [t.fileId]);
    expect(await t.f.prepare(t.network.id)).toBe(1);
    await t.f.prepare(t.network.id);
    expect((await t.journal.bySubject(`sale_file:${t.fileId}`)).filter((e) => e.type === 'facture.attente').map((e) => e.data.code)).toEqual(['payeur_inconnu']);
  });

  it('une panne de la plateforme ou une coupure ne perd rien : la facture rangée est reprise, la commission devient « facturée »', async () => {
    const t = await setup();
    const c = t.commissions();
    await c.setGrid(t.direction, { validFrom: '2027-03-01', defaultRateBp: 7000 });
    await t.compromis();
    await c.sync(t.network.id);
    await t.acte();
    await c.sync(t.network.id);
    let down = true;
    const plateforme = { mode: 'essai' as const, transmit: async (i: { id: string }) => { if (down) throw new Error('panne'); return { ref: `essai:${i.id}` }; } };
    const f = new Factures(t.db, t.acces, t.journal, { now: t.now, plateforme });
    await f.prepare(t.network.id);
    const drafts = await f.drafts(t.direction);
    if (!drafts.ok) throw new Error('drafts');
    const first = await f.validate(t.direction, drafts.value[0]!.id);
    expect(first.ok && first.value.transmitted).toBeNull();
    expect((await t.journal.all()).filter((e) => e.type === 'facture.envoi_en_panne')).toHaveLength(1);
    // La commission est facturée malgré la panne : la facture existe.
    expect((await c.list(t.direction)).ok && ((await c.list(t.direction)) as { value: { status: string }[] }).value[0]!.status).toBe('facturee');
    down = false;
    await f.reconcile(t.network.id);
    const all = await f.list(t.direction);
    expect(all.ok && all.value[0]!.transmitted?.mode).toBe('essai');
    // Rejoué, rien ne double au journal.
    await f.reconcile(t.network.id);
    expect((await t.journal.all()).filter((e) => e.type === 'facture.emise')).toHaveLength(1);
  });

  it('une vente annulée par un avoir ne se refacture jamais d’elle-même ; une erreur se refacture, et la nouvelle preuve est dite', async () => {
    const t = await due();
    await t.f.prepare(t.network.id);
    const drafts = await t.f.drafts(t.direction);
    if (!drafts.ok) throw new Error('drafts');
    const f1 = await t.f.validate(t.direction, drafts.value[0]!.id);
    if (!f1.ok) throw new Error('f1');
    await t.f.credit(t.direction, f1.value.id, 'vente_annulee');
    expect(await t.f.prepare(t.network.id)).toBe(0);
    const left = await t.f.drafts(t.direction);
    expect(left.ok && left.value.map((d) => d.kind)).toEqual(['reversement']);
    // Le brouillon préparé avant l'annulation ne s'émet plus.
    expect(await t.f.validate(t.direction, left.ok ? left.value[0]!.id : '')).toMatchObject({ ok: false, rule: 'R71', code: 'sale_cancelled' });
    expect((await t.journal.bySubject(`sale_file:${t.fileId}`)).filter((e) => e.type === 'facture.attente').map((e) => e.data.code)).toContain('vente_annulee');
  });

  it('[R71] huit validations simultanées d’un même émetteur : huit numéros qui se suivent, sans trou ni doublon ni erreur', async () => {
    const t = await due();
    const ids: string[] = [];
    for (let round = 1; round <= 8; round += 1) {
      const id = `brouillon-${round}`;
      ids.push(id);
      await t.db.run("INSERT INTO invoice_drafts (id, network_id, file_id, kind, issuer, recipient_person_id, amount_cents, vat_bp, round, created_at) VALUES (?, ?, ?, 'reversement', ?, NULL, 1000, 0, ?, ?)", [id, t.network.id, t.fileId, `agent:${t.alexId}`, round, t.now().toISOString()]);
    }
    const results = await Promise.all(ids.map((id) => t.f.validate(t.direction, id)));
    expect(results.every((r) => r.ok)).toBe(true);
    const numbers = await t.db.all<{ number: number }>('SELECT number FROM invoices WHERE issuer = ? ORDER BY number', [`agent:${t.alexId}`]);
    expect(numbers.map((n) => n.number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('l’export neutralise un texte qui commencerait comme une formule de tableur', async () => {
    const t = await due();
    await t.db.run("UPDATE persons SET first_name = '=HYPERLINK(\"http://x\")', last_name = NULL WHERE id = ?", [t.buyerId]);
    await t.f.prepare(t.network.id);
    const drafts = await t.f.drafts(t.direction);
    if (!drafts.ok) throw new Error('drafts');
    await t.f.validate(t.direction, drafts.value[0]!.id);
    const csv = await t.f.exportCsv(t.direction, '2027-06-01', '2027-06-30');
    if (!csv.ok) throw new Error('csv');
    expect(csv.value).toContain(`"'=HYPERLINK(""http://x"")"`);
    expect(csv.value).not.toMatch(/;=HYPERLINK/);
  });

  it('une panne inattendue de l’écriture d’une facture va au journal et remonte, sans se faire passer pour un conflit', async () => {
    const t = await due();
    await t.f.prepare(t.network.id);
    const drafts = await t.f.drafts(t.direction);
    if (!drafts.ok) throw new Error('drafts');
    const db = t.db as { run: typeof t.db.run };
    const run = db.run.bind(t.db);
    db.run = (async (sql: string, params?: unknown[]) => {
      if (/INSERT INTO invoices\b/.test(sql)) throw new TypeError('disque plein');
      return run(sql, params as never);
    }) as typeof t.db.run;
    await expect(t.f.validate(t.direction, drafts.value[0]!.id)).rejects.toThrow('disque plein');
    db.run = run;
    expect((await t.journal.bySubject(`sale_file:${t.fileId}`)).filter((e) => e.type === 'facture.erreur').map((e) => e.data.error)).toEqual(['TypeError']);
  });
});
