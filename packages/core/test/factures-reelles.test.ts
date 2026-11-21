import { expect, it } from 'vitest';
import { ActeVente, Echeancier } from '../src/dossiers/index.ts';
import { parseStatement } from '../src/facturation/banque.ts';
import { LABEL_SQL } from '../src/facturation/commun.ts';
import {
  Commissions,
  Factures,
  PlateformeEssai,
  TRIAL_NOTICE,
  pilotageHourlyJob,
  realMentions,
  reversementAmount,
  splitVat,
  totauxFacturX,
  type IdentitesFacturation,
  type InvoiceContent,
  type PlateformeFacturation,
} from '../src/pilotage/index.ts';
import { PROOF, setupDossier } from './dossiers-jeu.ts';
import { describeWithSqlite } from './sqlite.ts';

// Tout est inventé : sociétés, SIREN, numéros de TVA, adresses, clients, montants, références de la plateforme.
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
const IDENTITES: IdentitesFacturation = { emetteur: async (_n, issuer) => (issuer === 'reseau' ? RESEAU : AGENT), client: async () => CLIENT };

/** Une plateforme agréée réelle, inventée pour le test : elle garde chaque dépôt et rend le cycle qu'on lui donne. */
class PlateformeReelle implements PlateformeFacturation {
  readonly mode = 'reel' as const;
  readonly received: string[] = [];
  readonly xml = new Map<string, string | null>();
  readonly cycle = new Map<string, { code: number; at: string }[]>();
  failStatuses = false;
  async transmit(invoice: { id: string; content: InvoiceContent; facturX: string | null }): Promise<{ ref: string }> {
    this.received.push(invoice.content.label);
    this.xml.set(invoice.content.label, invoice.facturX);
    return { ref: `pdp-fictive:${invoice.id}` };
  }
  async statuses(ref: string): Promise<{ code: number; at: string }[]> {
    if (this.failStatuses) throw new Error('panne');
    return this.cycle.get(ref) ?? [];
  }
}

const ACT_PROOF = 'preuves/0b6f1d2e-7777-4a2b-8c3d-000000000001.pdf';
const at9 = (day: string) => new Date(`${day}T08:00:00.000Z`);
const code = (agentId: string) => agentId.toUpperCase().replace(/[^A-Z0-9-]/g, '');

/** Une vente menée jusqu'à l'acte signé : la commission est due. */
async function deed() {
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
  const essai = new PlateformeEssai();
  const reelle = new PlateformeReelle();
  const enEssai = new Factures(t.db, t.acces, t.journal, { now: t.now, plateforme: essai, identites: IDENTITES });
  const enReel = (identites: IdentitesFacturation = IDENTITES) => new Factures(t.db, t.acces, t.journal, { now: t.now, plateforme: reelle, identites });
  return { ...t, c, essai, reelle, enEssai, enReel };
}

/** Le brouillon d'honoraires puis celui du reversement, dans l'ordre de la liste de la direction. */
async function drafts(t: Awaited<ReturnType<typeof deed>>, f: Factures) {
  const d = await f.drafts(t.direction);
  if (!d.ok) throw new Error('drafts');
  return d.value;
}

it('[R71] les mentions d’une facture réelle viennent toutes des identités réelles, jamais de l’essai', () => {
  const honoraires = realMentions('honoraires', RESEAU, { ...CLIENT, siren: '900000003' });
  expect(honoraires).toEqual([
    'Catégorie de l’opération : prestation de services.',
    'SIREN de l’émetteur : 900000001.',
    'TVA intracommunautaire de l’émetteur : FR00900000001.',
    'SIREN du client : 900000003.',
    RESEAU.paymentTerms,
  ]);
  const reversement = realMentions('reversement', { ...AGENT, vatOnDebits: true }, { name: RESEAU.name, siren: RESEAU.siren, address: RESEAU.address });
  expect(reversement).toContain('TVA non applicable, art. 293 B du CGI.');
  expect(reversement).toContain('Option pour le paiement de la taxe d’après les débits.');
  // Sans option déclarée, rien n'est dit ; un particulier n'a pas de SIREN.
  expect(realMentions('honoraires', RESEAU, CLIENT).join(' ')).not.toMatch(/débits|SIREN du client/);
  for (const m of [...honoraires, ...reversement]) expect(m).not.toMatch(/essai|H09|H26|expert-comptable/i);
});

it('[R71] une référence de banque reconnaît le numéro d’une facture réelle comme celui d’une facture d’essai', () => {
  const r = parseStatement('2027-06-20;VIR FAC-2027-00001 ET F-2027-00004;10000,00');
  expect(r.ok && r.value[0]!.refs).toEqual(['FAC-2027-00001', 'F-2027-00004']);
});

describeWithSqlite('AU013 · factures réelles, à côté des factures d’essai', () => {
  it('[R71] le constat : derrière une plateforme réelle, la facture validée est réelle, numérotée dans sa propre suite, sans numéro d’essai', async () => {
    const t = await deed();
    // Avant : la séance d'essai a déjà émis une facture et son avoir cette année, sur le même émetteur.
    await t.enEssai.prepare(t.network.id);
    const [h0] = await drafts(t, t.enEssai);
    const f0 = await t.enEssai.validate(t.direction, h0!.id);
    if (!f0.ok) throw new Error('f0');
    expect(f0.value.content.label).toBe('F-2027-00001');
    const av0 = await t.enEssai.credit(t.direction, f0.value.id, 'erreur_montant');
    expect(av0.ok && av0.value.content.label).toBe('AV-2027-00002');
    // La plateforme réelle est acceptée : autrefois, construire `Factures` avec elle levait une erreur.
    const f = t.enReel();
    expect(await f.prepare(t.network.id)).toBe(1);
    const h = (await drafts(t, f)).find((x) => x.kind === 'honoraires');
    const real = await f.validate(t.direction, h!.id);
    if (!real.ok) throw new Error(`real ${(real as { code: string }).code}`);
    expect(real.value.content).toMatchObject({ label: 'FAC-2027-00001', mode: 'reel', kind: 'honoraires', ttcCents: 1_000_000, issuedOn: '2027-06-10' });
    expect(real.value.content.mentions).not.toContain(TRIAL_NOTICE);
    expect(real.value.content.mentions.join(' ')).not.toMatch(/essai|H09|H26/);
    expect(real.value.content.mentions).toContain('SIREN de l’émetteur : 900000001.');
    // Déposée à la plateforme réelle, avec son XML, une seule fois ; rien de réel n'est parti en essai.
    expect(real.value.transmitted).toEqual({ mode: 'reel', platformRef: `pdp-fictive:${real.value.id}` });
    expect(t.reelle.received).toEqual(['FAC-2027-00001']);
    expect(totauxFacturX(t.reelle.xml.get('FAC-2027-00001')!)).toMatchObject({ id: 'FAC-2027-00001', ttcCents: 1_000_000 });
    expect(t.essai.received).toEqual(['F-2027-00001', 'AV-2027-00002']);
    // Le reversement de l'agent, réel aussi, dans la suite de l'agent.
    const [, rv] = await drafts(t, f).then((d) => [undefined, d.find((x) => x.kind === 'reversement')]);
    const r = await f.validate(t.direction, rv!.id);
    expect(r.ok && r.value.content.label).toBe(`REV-${code(t.alexId)}-2027-00001`);
    expect(r.ok && r.value.content.mentions).toContain('TVA non applicable, art. 293 B du CGI.');
    // Les numéros d'essai d'avant ne changent pas ; la commission est facturée par la première facture.
    const list = await f.list(t.direction);
    expect(list.ok && list.value.map((v) => v.content.label)).toEqual(['F-2027-00001', 'AV-2027-00002', 'FAC-2027-00001', `REV-${code(t.alexId)}-2027-00001`]);
    // Au journal : le mode et le numéro, jamais un montant ni un nom [R13].
    const emitted = (await t.journal.all()).filter((e) => e.type === 'facture.emise');
    expect(emitted.map((e) => [e.data.label, e.data.mode])).toEqual([
      ['F-2027-00001', 'essai'],
      ['FAC-2027-00001', 'reel'],
      [`REV-${code(t.alexId)}-2027-00001`, 'reel'],
    ]);
    expect(JSON.stringify(await t.journal.all())).not.toMatch(/1000000|700000|Acheteur|Imaginaire|900000001/);
  });

  it('[R71] [R254] une identité manque : aucun numéro réel n’est pris, le manque va une fois au journal ; l’identité donnée, la suite part de 1, sans trou', async () => {
    const t = await deed();
    const sansClient: IdentitesFacturation = { emetteur: IDENTITES.emetteur, client: async () => null };
    const f = t.enReel(sansClient);
    await f.prepare(t.network.id);
    const [h] = await drafts(t, f);
    expect(await f.validate(t.direction, h!.id)).toMatchObject({ ok: false, rule: 'R254', code: 'identity_missing' });
    expect(await f.validate(t.direction, h!.id)).toMatchObject({ code: 'identity_missing' });
    // Le passage de l'acte attend lui aussi : rien d'émis pour les honoraires.
    await f.issueOnDeed(t.network.id);
    expect((await t.db.first<{ n: number }>("SELECT COUNT(*) AS n FROM invoices WHERE kind = 'honoraires'"))!.n).toBe(0);
    expect((await t.db.first<{ n: number }>('SELECT COUNT(*) AS n FROM invoice_real_numbers WHERE issuer = ?', ['reseau']))!.n).toBe(0);
    const waiting = (await t.journal.all()).filter((e) => e.type === 'facture.reelle_attente');
    expect(waiting.map((e) => e.data.missing)).toEqual([['client (BR-07)']]);
    expect(JSON.stringify(waiting)).not.toMatch(/Acheteur|Réseau Fictif/);
    // Le client donné : la facture réelle part, numéro 1.
    const ok = await t.enReel().validate(t.direction, h!.id);
    expect(ok.ok && ok.value.content.label).toBe('FAC-2027-00001');
  });

  it('[R71] une facture d’essai ne part jamais à la plateforme réelle, ni une facture réelle à celle d’essai', async () => {
    const t = await deed();
    // Une facture d'essai que la plateforme d'essai n'a pas reçue (panne), reprise ensuite derrière la plateforme réelle.
    const enPanne = new Factures(t.db, t.acces, t.journal, { now: t.now, plateforme: { mode: 'essai', transmit: async () => { throw new Error('panne'); } }, identites: IDENTITES });
    await enPanne.prepare(t.network.id);
    const [h] = await drafts(t, enPanne);
    const f0 = await enPanne.validate(t.direction, h!.id);
    expect(f0.ok && f0.value.transmitted).toBeNull();
    const f = t.enReel();
    t.setClock(new Date(t.now().getTime() + 2 * 3_600_000));
    await f.reconcile(t.network.id);
    expect(t.reelle.received).toEqual([]);
    // Une facture réelle reprise derrière la plateforme d'essai : rien ne part.
    const [, rv] = await drafts(t, f).then((d) => [undefined, d.find((x) => x.kind === 'reversement')]);
    const r = await f.validate(t.direction, rv!.id);
    expect(r.ok && r.value.content.mode).toBe('reel');
    await t.enEssai.reconcile(t.network.id);
    expect(t.essai.received).toEqual(['F-2027-00001']);
    // La base le tient aussi : une facture réelle n'entre pas dans les envois d'essai.
    await expect(t.db.run("INSERT INTO invoice_transmissions (invoice_id, mode, platform_ref, at) VALUES (?, 'essai', 'x', 'a')", [r.ok ? r.value.id : ''])).rejects.toThrow(/ne part pas en essai/);
    // Un avoir d'une facture réelle ne se fait pas derrière la plateforme d'essai.
    expect(await t.enEssai.credit(t.direction, r.ok ? r.value.id : '', 'erreur_montant')).toMatchObject({ ok: false, rule: 'R71', code: 'platform_essai' });
  });

  it('[R71] l’avoir d’une facture réelle est réel, dans la suite réelle, déposé avec son XML ; celui d’une facture d’essai reste d’essai', async () => {
    const t = await deed();
    await t.enEssai.prepare(t.network.id);
    const [h0] = await drafts(t, t.enEssai);
    const f0 = await t.enEssai.validate(t.direction, h0!.id);
    const f = t.enReel();
    const av0 = await f.credit(t.direction, f0.ok ? f0.value.id : '', 'erreur_montant');
    expect(av0.ok && [av0.value.content.label, av0.value.content.mode, av0.value.transmitted]).toEqual(['AV-2027-00002', undefined, null]);
    await f.prepare(t.network.id);
    const h = (await drafts(t, f)).find((x) => x.kind === 'honoraires');
    const real = await f.validate(t.direction, h!.id);
    if (!real.ok) throw new Error('real');
    const av = await f.credit(t.direction, real.value.id, 'erreur_destinataire');
    if (!av.ok) throw new Error('av');
    expect(av.value.content).toMatchObject({ label: 'AVO-2027-00002', mode: 'reel', corrects: 'FAC-2027-00001', ttcCents: -1_000_000 });
    expect(av.value.content.mentions).toContain('Annule la facture FAC-2027-00001.');
    expect(av.value.content.mentions).not.toContain(TRIAL_NOTICE);
    expect(av.value.transmitted).toEqual({ mode: 'reel', platformRef: `pdp-fictive:${av.value.id}` });
    expect(totauxFacturX(t.reelle.xml.get('AVO-2027-00002')!)).toMatchObject({ typeCode: '381', id: 'AVO-2027-00002' });
    expect(t.reelle.received).toEqual(['FAC-2027-00001', 'AVO-2027-00002']);
  });

  it('[R71] le cycle de vie rendu par la plateforme est rangé statut après statut, une seule fois ; rejetée, elle est dite à la direction', async () => {
    const t = await deed();
    const f = t.enReel();
    await f.prepare(t.network.id);
    const [h, rv] = await drafts(t, f);
    const real = await f.validate(t.direction, h!.id);
    const rev = await f.validate(t.direction, rv!.id);
    if (!real.ok || !rev.ok) throw new Error('real');
    expect(real.value.status).toBeNull();
    t.reelle.cycle.set(real.value.transmitted!.platformRef, [
      { code: 200, at: '2027-06-10T08:00:05Z' },
      { code: 213, at: '2027-06-10T08:01:00Z' },
    ]);
    t.reelle.cycle.set(rev.value.transmitted!.platformRef, [
      { code: 200, at: '2027-06-10T08:00:06Z' },
      { code: 999, at: '2027-06-10T08:02:00Z' },
    ]);
    expect(await f.track(t.network.id)).toBe(3);
    expect(await f.track(t.network.id)).toBe(0);
    const list = await f.list(t.direction);
    if (!list.ok) throw new Error('list');
    expect(list.value.map((v) => v.status)).toEqual([
      { code: 213, name: 'Rejetée', at: '2027-06-10T08:01:00Z' },
      { code: 200, name: 'Déposée', at: '2027-06-10T08:00:06Z' },
    ]);
    const journal = await t.journal.all();
    expect(journal.filter((e) => e.type === 'facture.statut').map((e) => [e.data.label, e.data.code])).toEqual([
      ['FAC-2027-00001', 200],
      ['FAC-2027-00001', 213],
      [`REV-${code(t.alexId)}-2027-00001`, 200],
    ]);
    // Rejetée : dite une fois ; un code inconnu n'est jamais rangé, dit une fois.
    const codes = journal.filter((e) => e.type === 'facture.attente').map((e) => e.data.code);
    expect(codes).toContain('rejetee:FAC-2027-00001');
    expect(codes.filter((c) => c === `statut_inconnu:REV-${code(t.alexId)}-2027-00001`)).toHaveLength(1);
    // Une panne de la plateforme va au journal et ne range rien.
    t.reelle.failStatuses = true;
    expect(await f.track(t.network.id)).toBe(0);
    expect((await t.journal.all()).some((e) => e.type === 'facture.suivi_en_panne')).toBe(true);
    // Derrière la plateforme d'essai, aucun suivi.
    expect(await t.enEssai.track(t.network.id)).toBe(0);
    // Les statuts ne changent ni ne s'effacent, et suivent leur ordre [R17].
    await expect(t.db.run('UPDATE invoice_real_statuses SET code = 212')).rejects.toThrow(/rien ne change/);
    await expect(t.db.run('DELETE FROM invoice_real_statuses')).rejects.toThrow(/rien ne s'efface/);
    await expect(t.db.run("INSERT INTO invoice_real_statuses (invoice_id, seq, code, at, recorded_at) VALUES (?, 9, 212, 'a', 'b')", [real.value.id])).rejects.toThrow(/hors suite/);
  });

  it('[R71] la base refuse un numéro réel hors suite, pour une facture d’essai, ou un dépôt réel d’une facture d’essai', async () => {
    const t = await deed();
    await t.enEssai.prepare(t.network.id);
    const [h0] = await drafts(t, t.enEssai);
    const f0 = await t.enEssai.validate(t.direction, h0!.id);
    if (!f0.ok) throw new Error('f0');
    await expect(t.db.run("INSERT INTO invoice_real_numbers (invoice_id, network_id, issuer, year, number, issued_on) VALUES (?, ?, 'reseau', 2027, 1, '2027-06-10')", [f0.value.id, t.network.id])).rejects.toThrow(/hors suite/);
    await expect(t.db.run("INSERT INTO invoice_real_deposits (invoice_id, platform_ref, at) VALUES (?, 'x', 'a')", [f0.value.id])).rejects.toThrow();
    const f = t.enReel();
    const [, rv] = await drafts(t, f).then((d) => [undefined, d.find((x) => x.kind === 'reversement')]);
    const r = await f.validate(t.direction, rv!.id);
    if (!r.ok) throw new Error('r');
    await expect(t.db.run('UPDATE invoice_real_numbers SET number = 2')).rejects.toThrow(/rien ne change/);
    await expect(t.db.run('DELETE FROM invoice_real_numbers')).rejects.toThrow(/rien ne s'efface/);
    await expect(t.db.run('DELETE FROM invoice_real_deposits')).rejects.toThrow(/rien ne s'efface/);
  });

  it('[R71] derrière la plateforme réelle, l’export comptable ne compte que les factures réelles, et la banque lit leur numéro', async () => {
    const t = await deed();
    await t.enEssai.prepare(t.network.id);
    const [h0] = await drafts(t, t.enEssai);
    const f0 = await t.enEssai.validate(t.direction, h0!.id);
    await t.enEssai.credit(t.direction, f0.ok ? f0.value.id : '', 'erreur_montant');
    const f = t.enReel();
    await f.prepare(t.network.id);
    for (const d of await drafts(t, f)) await f.validate(t.direction, d.id);
    const csv = await f.exportCsv(t.direction, '2027-06-01', '2027-06-30');
    if (!csv.ok) throw new Error('csv');
    const lines = csv.value.trim().split('\r\n');
    expect(lines[0]).toBe('numero;date;sorte;emetteur;destinataire;designation;ht;tva;ttc;facture_corrigee;mode');
    expect(lines.slice(1, -1).map((l) => [l.split(';')[0], l.split(';').at(-1)])).toEqual([
      ['FAC-2027-00001', 'reel'],
      [`REV-${code(t.alexId)}-2027-00001`, 'reel'],
    ]);
    expect(lines.at(-1)).toBe('total;;;;;;15333,33;1666,67;17000,00;;');
    // L'essai, lui, ne voit que l'essai.
    const essai = await t.enEssai.exportCsv(t.direction, '2027-06-01', '2027-06-30');
    expect(essai.ok && essai.value.split('\r\n').slice(1, -2).map((l) => l.split(';')[0])).toEqual(['F-2027-00001', 'AV-2027-00002']);
    // Le numéro lu par la banque et les relances est celui que la facture porte.
    const labels = await t.db.all<{ label: string }>(`SELECT ${LABEL_SQL('i')} AS label FROM invoices i WHERE i.kind = 'honoraires' ORDER BY i.number`);
    expect(labels.map((l) => l.label)).toEqual(['F-2027-00001', 'FAC-2027-00001']);
    const bare = await t.db.first<{ label: string }>(`SELECT ${LABEL_SQL()} AS label FROM invoices WHERE number = 3`);
    expect(bare?.label).toBe('FAC-2027-00001');
  });

  it('[R71] [R254] une facture réelle numérotée dont le XML ne s’écrit plus ne part pas, est dite une fois, et part au passage qui le retrouve', async () => {
    const t = await deed();
    // Les identités répondent au moment du numéro, puis tombent en panne quand le XML s'écrit.
    let calls = 0;
    const fragile: IdentitesFacturation = {
      emetteur: IDENTITES.emetteur,
      client: async (n, p) => {
        calls += 1;
        if (calls > 1) throw new Error('panne');
        return IDENTITES.client(n, p);
      },
    };
    const f = t.enReel(fragile);
    await f.prepare(t.network.id);
    const [h] = await drafts(t, f);
    const real = await f.validate(t.direction, h!.id);
    if (!real.ok) throw new Error('real');
    expect(real.value.content.label).toBe('FAC-2027-00001');
    expect(real.value.transmitted).toBeNull();
    await f.reconcile(t.network.id);
    // Rien de déposé, ni au réel ni en essai, aucun envoi réservé ; dit une seule fois.
    expect(t.reelle.received).toEqual([]);
    expect(t.essai.received).toEqual([]);
    expect((await t.db.first<{ n: number }>('SELECT COUNT(*) AS n FROM invoice_transmission_claims WHERE invoice_id = ?', [real.value.id]))!.n).toBe(0);
    const codes = (await t.journal.all()).filter((e) => e.type === 'facture.attente').map((e) => e.data.code);
    expect(codes.filter((c) => c === 'reelle_sans_xml:FAC-2027-00001')).toHaveLength(1);
    // Les identités revenues : déposée avec son XML, une fois.
    await t.enReel().reconcile(t.network.id);
    await t.enReel().reconcile(t.network.id);
    expect(t.reelle.received).toEqual(['FAC-2027-00001']);
    expect(totauxFacturX(t.reelle.xml.get('FAC-2027-00001')!)).toMatchObject({ id: 'FAC-2027-00001' });
  });

  it('[R71] huit validations réelles simultanées d’un même émetteur : huit numéros réels qui se suivent, sans trou ni doublon', async () => {
    const t = await deed();
    const f = t.enReel();
    const ids: string[] = [];
    for (let round = 1; round <= 8; round += 1) {
      const id = `brouillon-${round}`;
      ids.push(id);
      await t.db.run("INSERT INTO invoice_drafts (id, network_id, file_id, kind, issuer, recipient_person_id, amount_cents, vat_bp, round, created_at) VALUES (?, ?, ?, 'reversement', ?, NULL, 1000, 0, ?, ?)", [id, t.network.id, t.fileId, `agent:${t.alexId}`, round, t.now().toISOString()]);
    }
    const results = await Promise.all(ids.map((id) => f.validate(t.direction, id)));
    expect(results.every((r) => r.ok)).toBe(true);
    const numbers = await t.db.all<{ number: number }>('SELECT number FROM invoice_real_numbers WHERE issuer = ? ORDER BY number', [`agent:${t.alexId}`]);
    expect(numbers.map((n) => n.number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(new Set(t.reelle.received).size).toBe(8);
  });

  it('[R71] le passage horaire, derrière la plateforme réelle, émet à l’acte une facture réelle puis range son cycle', async () => {
    const t = await deed();
    const job = pilotageHourlyJob(t.db, t.journal, { now: t.now, facturation: { plateforme: t.reelle, identites: IDENTITES } });
    await job.run({ job: 'pilotage.passage', slot: 's', at: t.now() } as never);
    expect(t.reelle.received).toEqual(['FAC-2027-00001', `REV-${code(t.alexId)}-2027-00001`]);
    expect(t.essai.received).toEqual([]);
    const id = (await t.db.first<{ invoice_id: string }>("SELECT invoice_id FROM invoice_real_numbers WHERE issuer = 'reseau'"))!.invoice_id;
    t.reelle.cycle.set(`pdp-fictive:${id}`, [{ code: 200, at: '2027-06-10T08:00:05Z' }]);
    await job.run({ job: 'pilotage.passage', slot: 's2', at: t.now() } as never);
    expect((await t.db.all<{ code: number }>('SELECT code FROM invoice_real_statuses WHERE invoice_id = ?', [id])).map((r) => r.code)).toEqual([200]);
  });

  it('[R71] une panne du journal après un statut rangé : la ligne et l’alerte de la facture rejetée sont reprises au suivi suivant', async () => {
    const t = await deed();
    let broken = true;
    const journal = {
      ...t.journal,
      all: () => t.journal.all(),
      last: () => t.journal.last(),
      bySubject: (s: string) => t.journal.bySubject(s),
      byPeriod: (a: string, b: string) => t.journal.byPeriod(a, b),
      append: async (e: Parameters<typeof t.journal.append>[0]) => {
        if (broken && e.type === 'facture.statut') throw new Error('journal en panne');
        return t.journal.append(e);
      },
    };
    const f = new Factures(t.db, t.acces, journal, { now: t.now, plateforme: t.reelle, identites: IDENTITES });
    await f.prepare(t.network.id);
    const [h] = await drafts(t, f);
    const real = await f.validate(t.direction, h!.id);
    if (!real.ok) throw new Error('real');
    t.reelle.cycle.set(real.value.transmitted!.platformRef, [{ code: 213, at: '2027-06-10T08:01:00Z' }]);
    await expect(f.track(t.network.id)).rejects.toThrow(/journal en panne/);
    broken = false;
    await f.track(t.network.id);
    await f.track(t.network.id);
    const all = await t.journal.all();
    expect(all.filter((e) => e.type === 'facture.statut').map((e) => [e.data.label, e.data.code])).toEqual([['FAC-2027-00001', 213]]);
    expect(all.filter((e) => e.type === 'facture.attente' && e.data.code === 'rejetee:FAC-2027-00001')).toHaveLength(1);
  });
});

it('[R254] AU093 · la part hors taxe se reverse au centime, quel que soit l’arrondi de la TVA', () => {
  for (let ht = 1; ht <= 20_000; ht += 7) {
    const r = reversementAmount(ht, { category: 'S' }, 0);
    expect(splitVat(r.ttcCents, r.vatBp).htCents, String(ht)).toBe(ht);
  }
  expect(reversementAmount(700_000, { category: 'E', exemptionReason: 'TVA non applicable, art. 293 B du CGI' }, 0)).toEqual({ ttcCents: 700_000, vatBp: 0 });
  expect(reversementAmount(700_000, null, 0)).toEqual({ ttcCents: 700_000, vatBp: 0 });
});

describeWithSqlite('AU093 · le reversement suit le régime de TVA de l’agent qui le facture', () => {
  const ASSUJETTI = { ...AGENT, name: 'Sam Agent EURL', regime: { category: 'S' as const } };
  const avec = (agent: typeof AGENT | typeof ASSUJETTI): IdentitesFacturation => ({ emetteur: async (_n, issuer) => (issuer === 'reseau' ? RESEAU : agent), client: async () => CLIENT });

  it('[R254] constat : un agent soumis à la TVA recevait un reversement à 0 %, refusé en Factur-X ; il facture désormais sa part et 20 % de TVA', async () => {
    const t = await deed();
    const f = t.enReel(avec(ASSUJETTI));
    await f.prepare(t.network.id);
    const rv = (await drafts(t, f)).find((x) => x.kind === 'reversement')!;
    expect(rv).toMatchObject({ amountCents: 840_000, vatBp: 2000 });
    const r = await f.validate(t.direction, rv.id);
    if (!r.ok) throw new Error(`reversement ${(r as { code: string }).code}`);
    expect(r.value.content).toMatchObject({ htCents: 700_000, vatBp: 2000, vatCents: 140_000, ttcCents: 840_000, mode: 'reel' });
    expect(r.value.content.mentions.join(' ')).not.toMatch(/293 B|non applicable/);
    expect(r.value.content.mentions).toContain('TVA intracommunautaire de l’émetteur : FR00900000002.');
    expect(totauxFacturX(t.reelle.xml.get(r.value.content.label)!)).toMatchObject({ ttcCents: 840_000 });
  });

  it('[R254] un agent en franchise en base reverse sa part seule, avec la mention de son exonération, en essai comme en réel', async () => {
    const t = await deed();
    await t.enEssai.prepare(t.network.id);
    const rv = (await drafts(t, t.enEssai)).find((x) => x.kind === 'reversement')!;
    expect(rv).toMatchObject({ amountCents: 700_000, vatBp: 0 });
    const r = await t.enEssai.validate(t.direction, rv.id);
    if (!r.ok) throw new Error('reversement');
    expect(r.value.content).toMatchObject({ htCents: 700_000, vatCents: 0, ttcCents: 700_000 });
    expect(r.value.content.mentions).toContain('TVA non applicable, art. 293 B du CGI.');
    expect(r.value.content.mentions.join(' ')).not.toContain('en attente de la validation');
  });

  it('[R254] sans identité de l’agent, rien n’est deviné : aucune TVA, et la facture d’essai dit qu’elle attend', async () => {
    const t = await deed();
    const f = new Factures(t.db, t.acces, t.journal, { now: t.now, plateforme: t.essai });
    await f.prepare(t.network.id);
    const rv = (await drafts(t, f)).find((x) => x.kind === 'reversement')!;
    expect(rv).toMatchObject({ amountCents: 700_000, vatBp: 0 });
    const r = await f.validate(t.direction, rv.id);
    expect(r.ok && r.value.content.mentions).toContain('TVA non appliquée en mode essai, en attente de la validation de l’expert-comptable.');
  });
});

