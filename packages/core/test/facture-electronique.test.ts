import { readFileSync, readdirSync } from 'node:fs';
import { expect, it } from 'vitest';
import { validateXML } from 'xmllint-wasm';
import { ActeVente, Echeancier } from '../src/dossiers/index.ts';
import { Commissions, Factures, PlateformeEssai, factureElectronique, manquesFacturX, pilotageHourlyJob, totauxFacturX, type IdentitesFacturation, type InvoiceContent } from '../src/pilotage/index.ts';
import { PROOF, setupDossier } from './dossiers-jeu.ts';
import { describeWithSqlite } from './sqlite.ts';

// Tout est inventé : sociétés, SIREN, numéros de TVA, adresses, clients, montants.
const XSD_DIR = new URL('./facturx-xsd/', import.meta.url);
const MAIN_XSD = 'Factur-X_EN16931.xsd';

/** Valide un XML contre le schéma officiel Factur-X 1.09, profil EN 16931 (FNFE-MPE), sans service extérieur. */
async function xsdErrors(xml: string): Promise<string[]> {
  const files = readdirSync(XSD_DIR).filter((f) => f.endsWith('.xsd'));
  const read = (f: string) => readFileSync(new URL(f, XSD_DIR), 'utf8');
  const r = await validateXML({
    xml: [{ fileName: 'facture.xml', contents: xml }],
    schema: [{ fileName: MAIN_XSD, contents: read(MAIN_XSD) }],
    preload: files.filter((f) => f !== MAIN_XSD).map((f) => ({ fileName: f, contents: read(f) })),
  });
  return r.valid ? [] : r.errors.map((e) => e.message);
}

const RESEAU = {
  name: 'Réseau Fictif SAS',
  siren: '900000001',
  vatId: 'FR00900000001',
  address: { line1: '1 rue Inventée', postcode: '21000', city: 'Dijon', country: 'FR' },
  regime: { category: 'S' as const },
  paymentTerms: 'Payable à réception. Pénalités de retard : trois fois le taux d’intérêt légal. Indemnité forfaitaire pour frais de recouvrement : 40 €.',
};
const AGENT = {
  name: 'Alex Agent EI',
  siren: '900000002',
  vatId: 'FR00900000002',
  address: { line1: '3 allée Fictive', postcode: '21800', city: 'Quetigny', country: 'FR' },
  regime: { category: 'E' as const, exemptionReason: 'TVA non applicable, art. 293 B du CGI' },
  paymentTerms: 'Payable à 30 jours.',
};
const CLIENT = { name: 'Acheteur Exemple', address: { line1: '2 place Imaginaire', postcode: '21000', city: 'Dijon', country: 'FR' } };

const HONORAIRES: InvoiceContent = {
  label: 'F-2027-00001',
  kind: 'honoraires',
  issuedOn: '2027-06-11',
  issuer: 'Réseau Fictif SAS',
  recipient: 'Acheteur Exemple',
  designation: 'Honoraires de transaction, bien REF-T-1',
  htCents: 833_333,
  vatBp: 2000,
  vatCents: 166_667,
  ttcCents: 1_000_000,
  mentions: ['Facture d’essai, sans valeur comptable.'],
  corrects: null,
  saleDay: '2027-06-10',
  reason: null,
};

it('[R254] Factur-X EN 16931 valide au schéma officiel : facture, avoir et reversement exonéré ; les totaux retombent sur la facture', async () => {
  const cases: { content: InvoiceContent; seller: typeof RESEAU | typeof AGENT; buyer: { name: string; siren?: string; address: typeof CLIENT.address }; typeCode: string }[] = [
    { content: HONORAIRES, seller: RESEAU, buyer: CLIENT, typeCode: '380' },
    { content: { ...HONORAIRES, label: 'AV-2027-00002', kind: 'avoir', htCents: -833_333, vatCents: -166_667, ttcCents: -1_000_000, corrects: 'F-2027-00001', reason: 'erreur_montant' }, seller: RESEAU, buyer: CLIENT, typeCode: '381' },
    {
      content: { ...HONORAIRES, label: 'RV-A1-2027-00001', kind: 'reversement', designation: 'Reversement de commission, vente du bien REF-T-1', htCents: 700_000, vatBp: 0, vatCents: 0, ttcCents: 700_000 },
      seller: AGENT,
      buyer: { name: RESEAU.name, siren: RESEAU.siren, address: RESEAU.address },
      typeCode: '380',
    },
  ];
  for (const c of cases) {
    const r = factureElectronique({ content: c.content, seller: c.seller, buyer: c.buyer });
    if (!r.ok) throw new Error(r.missing.join(', '));
    expect(await xsdErrors(r.xml)).toEqual([]);
    expect(r.xml).toContain('<ram:ID>urn:cen.eu:en16931:2017</ram:ID>');
    const totals = totauxFacturX(r.xml)!;
    // Un avoir porte ses montants en positif, avec le code 381 et la facture corrigée.
    expect(totals).toEqual({ htCents: Math.abs(c.content.htCents), vatCents: Math.abs(c.content.vatCents), ttcCents: Math.abs(c.content.ttcCents), dueCents: Math.abs(c.content.ttcCents), typeCode: c.typeCode, id: c.content.label });
    // Le même contenu donne toujours le même texte : l'empreinte prouve ce qui est parti.
    expect(factureElectronique({ content: c.content, seller: c.seller, buyer: c.buyer })).toEqual(r);
  }
  const avoir = factureElectronique({ content: cases[1]!.content, seller: RESEAU, buyer: CLIENT });
  expect(avoir.ok && avoir.xml).toContain('<ram:InvoiceReferencedDocument><ram:IssuerAssignedID>F-2027-00001</ram:IssuerAssignedID></ram:InvoiceReferencedDocument>');
  // Un texte qui ressemble à du XML reste du texte, et le XML reste valide.
  const tricky = factureElectronique({ content: { ...HONORAIRES, designation: 'Honoraires <b>&</b> "frais"' }, seller: { ...RESEAU, name: 'A & B <SAS>' }, buyer: CLIENT });
  if (!tricky.ok) throw new Error('tricky');
  expect(tricky.xml).toContain('Honoraires &lt;b&gt;&amp;&lt;/b&gt; &quot;frais&quot;');
  expect(await xsdErrors(tricky.xml)).toEqual([]);
});

it('[R254] rien d’inventé : sans identité, sans adresse, sans TVA dite ou avec des totaux faux, aucun XML, et ce qui manque dit sa règle', () => {
  expect(factureElectronique({ content: HONORAIRES, seller: null, buyer: null })).toEqual({ ok: false, missing: ['emetteur (BR-06)', 'client (BR-07)'] });
  const { vatId: _vatId, ...sansTva } = RESEAU;
  expect(manquesFacturX({ content: HONORAIRES, seller: { ...sansTva, siren: '12', paymentTerms: ' ' }, buyer: { ...CLIENT, address: { ...CLIENT.address, country: 'France' } } })).toEqual([
    'emetteur.siren (BT-30)',
    'conditions_paiement (BR-CO-25)',
    'emetteur.tva_intracommunautaire (BR-S-02)',
    'client.adresse.pays (BR-10)',
  ]);
  // Un taux à 0 % ne passe jamais en TVA normale, ni un taux en exonération ; l'exonération dit son motif.
  expect(manquesFacturX({ content: { ...HONORAIRES, vatBp: 0, vatCents: 0, htCents: 1_000_000 }, seller: RESEAU, buyer: CLIENT })).toEqual(['taux_tva (BR-S-05)']);
  expect(manquesFacturX({ content: HONORAIRES, seller: { ...AGENT, regime: { category: 'E', exemptionReason: '' } }, buyer: CLIENT })).toEqual(['taux_tva (BR-E-05)', 'motif_exoneration (BR-E-10)']);
  // Les totaux se recomptent au centime ; un avoir sans facture corrigée ni signe négatif n'existe pas.
  expect(manquesFacturX({ content: { ...HONORAIRES, ttcCents: 1_000_001 }, seller: RESEAU, buyer: CLIENT })).toEqual(['total_ttc (BR-CO-15)']);
  expect(manquesFacturX({ content: { ...HONORAIRES, vatCents: 166_666, ttcCents: 999_999 }, seller: RESEAU, buyer: CLIENT })).toEqual(['total_tva (BR-CO-17)']);
  expect(manquesFacturX({ content: { ...HONORAIRES, kind: 'avoir' }, seller: RESEAU, buyer: CLIENT })).toEqual(['facture_corrigee (BT-25)', 'signe_des_montants (BR-CO-15)']);
});

const ACT_PROOF = 'preuves/0b6f1d2e-7777-4a2b-8c3d-000000000001.pdf';
const at9 = (day: string) => new Date(`${day}T08:00:00.000Z`);

/** Une vente menée jusqu'à l'acte signé : la commission est due, les brouillons sont prêts au passage. */
async function deed(identites?: IdentitesFacturation) {
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
  t.setClock(at9('2027-06-10'));
  const act = await new ActeVente(t.db, t.acces, t.journal, t.storage, { now: t.now }).record(t.agent, t.fileId, { signedOn: '2027-06-10', proofRef: ACT_PROOF });
  if (!act.ok) throw new Error(act.code);
  await c.sync(t.network.id);
  const plateforme = new PlateformeEssai();
  const f = new Factures(t.db, t.acces, t.journal, { now: t.now, plateforme, ...(identites ? { identites } : {}) });
  return { ...t, c, f, plateforme };
}

const IDENTITES: IdentitesFacturation = {
  emetteur: async (_n, issuer) => (issuer === 'reseau' ? RESEAU : AGENT),
  client: async () => CLIENT,
};

describeWithSqlite('HX04 · facture électronique, partie seule le jour de l’acte', () => {
  it('[R255] [R254] le jour de l’acte, honoraires et reversement partent seuls, en Factur-X valide, aux montants du dossier, une seule fois', async () => {
    const t = await deed(IDENTITES);
    expect(await t.f.prepare(t.network.id)).toBe(2);
    // Deux passages en même temps : deux factures, jamais quatre.
    const runs = await Promise.all([t.f.issueOnDeed(t.network.id), t.f.issueOnDeed(t.network.id)]);
    expect(runs[0]! + runs[1]!).toBe(2);
    expect(await t.f.issueOnDeed(t.network.id)).toBe(0);
    const list = await t.f.list(t.direction);
    if (!list.ok) throw new Error('list');
    expect(list.value.map((v) => [v.content.label, v.content.kind, v.content.issuedOn, v.content.ttcCents])).toEqual([
      ['F-2027-00001', 'honoraires', '2027-06-10', 1_000_000],
      [expect.stringMatching(/^RV-.*-2027-00001$/), 'reversement', '2027-06-10', 700_000],
    ]);
    // Montants égaux à ceux du dossier : les honoraires de la commission, la part de l'agent.
    const commission = await t.c.list(t.direction);
    if (!commission.ok) throw new Error('commission');
    expect(list.value[0]!.content.ttcCents).toBe(commission.value[0]!.feeCents);
    expect(list.value[1]!.content.ttcCents).toBe(commission.value[0]!.shares.find((s) => s.kind === 'agent')!.amountCents);
    expect(commission.value[0]!.status).toBe('facturee');
    for (const v of list.value) {
      expect(v.facturX).toEqual({ profile: 'urn:cen.eu:en16931:2017', sha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
      const xml = t.plateforme.xml.get(v.content.label)!;
      expect(await xsdErrors(xml)).toEqual([]);
      expect(totauxFacturX(xml)).toMatchObject({ ttcCents: v.content.ttcCents, htCents: v.content.htCents, vatCents: v.content.vatCents, id: v.content.label });
      expect(xml).toContain('<udt:DateTimeString format="102">20270610</udt:DateTimeString>');
    }
    // Rien n'est parti deux fois, ni ailleurs qu'à la plateforme d'essai ; les factures sont émises par le système.
    expect(t.plateforme.received).toHaveLength(2);
    const emitted = (await t.journal.all()).filter((e) => e.type === 'facture.emise');
    expect(emitted.map((e) => e.actor)).toEqual(['system:facturation', 'system:facturation']);
    // Le XML rangé ne change ni ne s'efface [R17, R71].
    await expect(t.db.run("UPDATE invoice_facturx SET xml = 'x'")).rejects.toThrow(/rien ne change/);
    await expect(t.db.run('DELETE FROM invoice_facturx')).rejects.toThrow(/rien ne s'efface/);
    // Au journal : jamais un montant, un nom ou une adresse [R13].
    expect(JSON.stringify(await t.journal.all())).not.toMatch(/1000000|700000|Acheteur|Imaginaire|900000001/);
  });

  it('[R254] sans identité réelle : la facture part en essai sans XML, ce qui manque va une fois au journal, sans donnée', async () => {
    const t = await deed();
    await t.f.prepare(t.network.id);
    expect(await t.f.issueOnDeed(t.network.id)).toBe(2);
    await t.f.reconcile(t.network.id);
    const list = await t.f.list(t.direction);
    expect(list.ok && list.value.map((v) => v.facturX)).toEqual([null, null]);
    expect(t.plateforme.xml.size).toBe(0);
    const waiting = (await t.journal.all()).filter((e) => e.type === 'facture.facturx_attente');
    expect(waiting.map((e) => e.data.missing)).toEqual([
      ['emetteur', 'client'],
      ['emetteur', 'client'],
    ]);
    expect(JSON.stringify(waiting)).not.toMatch(/Acheteur|Alex/);
  });

  it('[R255] un brouillon qui ne retombe plus sur le dossier ne part pas seul : l’écart va au journal, une fois', async () => {
    const t = await deed(IDENTITES);
    await t.f.prepare(t.network.id);
    // Un brouillon de reversement pour quelqu'un qui n'a aucune part dans le dossier.
    await t.db.run(
      "INSERT INTO invoice_drafts (id, network_id, file_id, kind, issuer, recipient_person_id, amount_cents, vat_bp, round, created_at) VALUES ('d-ecart', ?, ?, 'reversement', 'agent:personne', NULL, 5, 0, 1, '2027-06-10T08:00:00.000Z')",
      [t.network.id, t.fileId],
    );
    expect(await t.f.issueOnDeed(t.network.id)).toBe(2);
    expect(await t.f.issueOnDeed(t.network.id)).toBe(0);
    expect((await t.journal.all()).filter((e) => e.type === 'facture.attente').map((e) => e.data.code)).toEqual(['ecart_dossier:reversement']);
    expect(await t.db.first("SELECT 1 FROM invoices WHERE draft_id = 'd-ecart'")).toBeNull();
  });

  it('[R255] une plateforme en panne : la facture reste rangée, l’envoi est repris au passage suivant, jamais deux fois', async () => {
    const t = await deed(IDENTITES);
    let down = true;
    const sent: string[] = [];
    const plateforme = {
      mode: 'essai' as const,
      async transmit(i: { id: string; content: InvoiceContent; facturX: string | null }) {
        if (down) throw new Error('panne');
        sent.push(i.content.label);
        return { ref: `essai:${i.id}` };
      },
    };
    const f = new Factures(t.db, t.acces, t.journal, { now: t.now, plateforme, identites: IDENTITES });
    await f.prepare(t.network.id);
    expect(await f.issueOnDeed(t.network.id)).toBe(2);
    expect((await t.journal.all()).filter((e) => e.type === 'facture.envoi_en_panne').map((e) => e.data.attempt)).toEqual([1, 1]);
    down = false;
    await Promise.all([f.reconcile(t.network.id), f.reconcile(t.network.id)]);
    await f.reconcile(t.network.id);
    expect(sent).toHaveLength(2);
    expect(new Set(sent).size).toBe(2);
    const list = await f.list(t.direction);
    expect(list.ok && list.value.every((v) => v.transmitted !== null && v.facturX !== null)).toBe(true);
    expect((await t.journal.all()).filter((e) => e.type === 'facture.emise')).toHaveLength(2);
  });

  it('[R255] le passage de chaque heure émet seul les factures de l’acte du jour', async () => {
    const t = await deed();
    await pilotageHourlyJob(t.db, t.journal, { now: t.now }).run({ job: 'pilotage.passage', slot: 's', at: t.now() } as never);
    expect((await t.db.all<{ kind: string }>('SELECT kind FROM invoices ORDER BY kind')).map((r) => r.kind)).toEqual(['honoraires', 'reversement']);
    await pilotageHourlyJob(t.db, t.journal, { now: t.now }).run({ job: 'pilotage.passage', slot: 's', at: t.now() } as never);
    expect(await t.db.first<{ n: number }>('SELECT COUNT(*) AS n FROM invoices')).toEqual({ n: 2 });
  });
});
