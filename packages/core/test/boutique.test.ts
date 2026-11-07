import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ReconnaissanceBien } from '../src/biens/reconnaissance.ts';
import { Boutique, type Imprimeur, type PrintOrder } from '../src/boutique/boutique.ts';
import { encodeQr, qrSvg } from '../src/boutique/qr.ts';
import { figuresIn, keywordFor, renderSupport, unsourcedFigures, visibleText, type SupportInput } from '../src/boutique/supports.ts';
import { euros, PageBien, type ListingPayload } from '../src/annonces/index.ts';
import { Referencement } from '../src/attirer/referencement.ts';
import { htmlProblems, screenCssProblems } from '../src/design/audit.ts';
import { modulesFromSvg, readQr } from './qr-lecture.ts';
import { setupAnnonce } from './annonces-jeu.ts';
import { describeWithSqlite } from './sqlite.ts';

// Annonces, agents, sites et imprimeurs inventés.
const N = ' ';
const S = ' ';
const PAYLOAD: ListingPayload = {
  reference: 'REF-T-1',
  version: 3,
  state: 'en_vente',
  title: 'Appartement 3 pièces à Dijon',
  body: 'Au 3e étage avec ascenseur.',
  mentions: `Prix : 210${S}000${N}€ honoraires inclus, soit 200${S}000${N}€ hors honoraires et 5${N}% TTC du prix hors honoraires, à la charge de l'acquéreur.\nClasse énergie D, classe climat C.\nCarte professionnelle n° CPI 0000.`,
  priceEur: 210000,
  media: [{ ref: 'biens/b1/0b6f1d2e-2222-4a2b-8c3d-000000000002.jpg', kind: 'photo', overlay: 'Aménagement virtuel' }],
};
const AGENT = { firstName: 'Alex', lastName: 'Agent', phone: '03 00 00 00 01', email: 'alex@exemple.test' };
const URL_BIEN = 'https://reseau.exemple.test/biens/b1';
const qrIn = (html: string): string => readQr(modulesFromSvg(/<svg[\s\S]*?<\/svg>/.exec(html)![0]));
const matrixHash = (m: boolean[][]): string => createHash('sha256').update(m.map((r) => r.map((b) => (b ? '1' : '0')).join('')).join('\n')).digest('hex');

describe('HX07 · code QR', () => {
  it('chaque matrice est celle de la bibliothèque python-qrcode 8.2 au même masque, module pour module', () => {
    // Empreintes calculées une fois avec python-qrcode 8.2 (mode octets, niveau M, version et masque imposés).
    const cases: [string, number, number, string][] = [
      ['A', 1, 4, '177b3a1897a152aee17ab1ee4b667913c6bb873e6ba357debfc5ba243dabff0e'],
      ['https://reseau.exemple.test/biens/b1', 3, 5, 'fdb4a96ab9608de5b52a224163b0c0ae9a02c4a0d5bf948e514a8c7e3327ae49'],
      ['https://camille.exemple.test/biens/0b6f1d2e-1111-4a2b-8c3d-000000000001', 5, 2, '90f8674ce92de4efb964ec857a419e089e7363de3cf405df165219b0ddfebb5c'],
      [`Écrivez « RÉF REF-T-1 » ${'x'.repeat(120)}`, 8, 2, 'df51eebc4ea11a748e8089491298e06221cc599f75e8075c3819fd52ebbcca77'],
      ['y'.repeat(213), 10, 1, '3bb4dc258df63cd72866923bcf69b2a163f017bd6dd5d9d77a92f7f81ad9c892'],
    ];
    for (const [text, version, mask, hash] of cases) {
      const r = encodeQr(text);
      expect(r.ok, text).toBe(true);
      if (!r.ok) continue;
      expect([r.qr.version, r.qr.mask], text).toEqual([version, mask]);
      expect(matrixHash(r.qr.modules), text).toBe(hash);
    }
  });

  it('un lecteur écrit à part relit le texte exact, de 1 à 213 octets, accents compris, depuis le SVG', () => {
    for (let len = 1; len <= 213; len += 7) {
      const text = `https://reseau.exemple.test/biens/${'é'.repeat(Math.floor(len / 6))}`.slice(0, len);
      const bytes = new TextEncoder().encode(text).length;
      const r = encodeQr(text);
      if (bytes > 213) {
        expect(r).toEqual({ ok: false, code: 'trop_long' });
        continue;
      }
      expect(r.ok, text).toBe(true);
      if (r.ok) expect(readQr(modulesFromSvg(qrSvg(r.qr, 'code')))).toBe(text);
    }
  });

  it('un texte vide ou trop long n’a pas de code, jamais un code tronqué', () => {
    expect(encodeQr('')).toEqual({ ok: false, code: 'vide' });
    expect(encodeQr('z'.repeat(214))).toEqual({ ok: false, code: 'trop_long' });
  });
});

describe('HX07 · supports tirés du bien', () => {
  const flyer = (over: Partial<ListingPayload> = {}, extra: Partial<SupportInput> = {}) =>
    renderSupport({ support: 'flyer', payload: { ...PAYLOAD, ...over }, agent: AGENT, url: URL_BIEN, ...extra } as SupportInput);

  it('[R263] flyer et vitrine portent le titre, le prix publié et toutes les mentions de l’annonce, au caractère près', () => {
    for (const support of ['flyer', 'vitrine'] as const) {
      const r = renderSupport({ support, payload: PAYLOAD, agent: AGENT, url: URL_BIEN });
      expect(r.ok).toBe(true);
      if (!r.ok) continue;
      const text = visibleText(r.html);
      expect(text).toContain(euros(210000));
      expect(text).toContain(PAYLOAD.mentions);
      expect(text).toContain(PAYLOAD.title);
      expect(text).toContain('agent immobilier');
      // Le prix vient avant les mentions, qui le suivent en entier.
      expect(r.html.indexOf('class="prix"')).toBeLessThan(r.html.indexOf('class="mentions"'));
      expect(unsourcedFigures(text, [PAYLOAD.title!, PAYLOAD.mentions!, euros(210000), PAYLOAD.reference, AGENT.phone, AGENT.email, 'Alex Agent'])).toEqual([]);
    }
  });

  it('[R263] le panneau ne porte aucun prix, donc aucune mention de prix : « À vendre », le téléphone, le code et le mot-clé', () => {
    const r = renderSupport({ support: 'panneau', payload: PAYLOAD, agent: AGENT, url: URL_BIEN });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const text = visibleText(r.html);
    expect(text).toContain('À vendre');
    expect(text).toContain(AGENT.phone);
    expect(text).not.toContain('€');
    expect(figuresIn(text).every((n) => ['0300000001', '1'].includes(n))).toBe(true);
  });

  it('[R263] aucun chiffre hors de l’annonce publiée et de la carte de l’agent : le contrôle le voit et le dit', () => {
    expect(unsourcedFigures(`Prix 215${S}000${N}€`, [euros(210000)])).toEqual(['215000']);
    expect(unsourcedFigures(`T3  210${S}000${N}€`, ['T3', euros(210000)])).toEqual([]);
    expect(figuresIn(`Appartement T3   210${S}000${N}€`)).toEqual(['3', '210000']);
    // Le prix de la fiche du bien n'apparaît jamais : seul celui de l'annonce publiée.
    const r = flyer();
    expect(r.ok).toBe(true);
    if (r.ok) expect(unsourcedFigures(visibleText(r.html), [PAYLOAD.title!, euros(210000), PAYLOAD.reference, AGENT.phone])).toEqual(['200000', '5', '0000']);
  });

  it('[R263] une photo d’aménagement virtuel garde sa mention sur l’image [R48]', () => {
    const r = flyer();
    expect(r.ok && r.html).toContain('<span class="virtuel">Aménagement virtuel</span>');
    expect(r.ok && r.html).toContain('alt="Photo du bien, aménagement virtuel"');
  });

  it('[R263] le code QR mène à la page du bien, et le mot-clé porte sa référence', () => {
    const r = flyer();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(qrIn(r.html)).toBe(URL_BIEN);
    expect(r.keyword).toBe('RÉF REF-T-1');
    expect(visibleText(r.html)).toContain('« RÉF REF-T-1 »');
    expect(keywordFor('REF-T-1')).toBe('RÉF REF-T-1');
  });

  it('[R263] aucun support pour une annonce sous offre, vendue, retirée ou incomplète, ni sans téléphone de l’agent', () => {
    for (const state of ['sous_offre', 'vendu', 'retiree'] as const) expect(flyer({ state })).toEqual({ ok: false, code: 'annonce_pas_en_vente' });
    expect(flyer({ mentions: null })).toEqual({ ok: false, code: 'annonce_incomplete' });
    expect(flyer({ priceEur: null })).toEqual({ ok: false, code: 'annonce_incomplete' });
    expect(flyer({ title: '' })).toEqual({ ok: false, code: 'annonce_incomplete' });
    expect(flyer({}, { agent: { ...AGENT, phone: null } })).toEqual({ ok: false, code: 'pas_de_telephone' });
    expect(flyer({ reference: 'REF T 1' })).toEqual({ ok: false, code: 'reference_illisible' });
    expect(flyer({ reference: 'REF-T-1.' })).toEqual({ ok: false, code: 'reference_illisible' });
    expect(flyer({}, { url: 'http://reseau.exemple.test/biens/b1' })).toEqual({ ok: false, code: 'adresse_invalide' });
    expect(flyer({}, { url: `https://reseau.exemple.test/${'a'.repeat(200)}` })).toEqual({ ok: false, code: 'qr_trop_long' });
  });

  it('la carte de visite : nom, « agent immobilier », coordonnées professionnelles et code vers son site', () => {
    const r = renderSupport({ support: 'carte', agent: AGENT, url: 'https://alex.exemple.test' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const text = visibleText(r.html);
    expect(text).toContain('Alex Agent');
    expect(text).toContain('Agent immobilier');
    expect(text).not.toMatch(/mandataire/i);
    expect(qrIn(r.html)).toBe('https://alex.exemple.test');
    expect(r.keyword).toBeNull();
  });

  it('chaque support suit le système de design et passe le contrôle d’accessibilité', () => {
    for (const support of ['panneau', 'flyer', 'vitrine'] as const) {
      const r = renderSupport({ support, payload: PAYLOAD, agent: AGENT, url: URL_BIEN });
      expect(r.ok).toBe(true);
      if (!r.ok) continue;
      expect(htmlProblems(r.html, { print: true }), support).toEqual([]);
      expect(screenCssProblems(/<style>([\s\S]*?)<\/style>/.exec(r.html)![1]!), support).toEqual([]);
      expect(r.html).not.toMatch(/<script|https?:\/\/(?!reseau\.exemple\.test)[^"]*\.(?:css|js|woff)/);
    }
  });
});

/** Un imprimeur de test : il garde ce qu'il reçoit, et peut tomber en panne. */
class FakePrinter implements Imprimeur {
  readonly name = 'imprimeur-test';
  received: PrintOrder[] = [];
  fail = false;
  async order(o: PrintOrder): Promise<{ ref: string }> {
    if (this.fail) throw new Error('imprimeur_indisponible');
    this.received.push(o);
    return { ref: `IMP-${this.received.length}` };
  }
}

async function setupBoutique() {
  const t = await setupAnnonce();
  t.setClock(new Date('2027-02-12T10:00:00.000Z'));
  await t.annonces.validate(t.agent, t.draftId);
  t.setClock(new Date('2027-03-01T08:00:00.000Z'));
  await t.publication.sync(t.network.id, t.propertyId);
  const pages = new PageBien(t.db, t.acces, t.journal, { now: t.now });
  expect(await pages.setAgentCard(t.agent, t.alexId, { phone: '03 00 00 00 01', email: 'alex@exemple.test' })).toEqual({ ok: true });
  const referencement = new Referencement(t.db, t.journal, { now: t.now });
  const site = await referencement.setSite(t.direction, { kind: 'reseau', baseUrl: 'https://reseau.exemple.test', active: true });
  expect(site.ok).toBe(true);
  const printer = new FakePrinter();
  const boutique = new Boutique(t.db, t.acces, t.journal, { now: t.now, printer, referencement });
  const tariff = async (support: string, quantity: number, priceCents: number, validUntil = '2027-12-31') =>
    boutique.setTariff(t.direction, { support, quantity, priceCents, printer: 'Imprimerie exemple', source: 'Devis n° D-1 du 2027-02-01', validUntil });
  return { ...t, boutique, printer, referencement, tariff, url: `https://reseau.exemple.test/biens/${encodeURIComponent(t.propertyId)}` };
}

describeWithSqlite('HX07 · la boutique de l’agent', () => {
  it('[R263] le flyer sort de la version publiée : prix de l’annonce, jamais celui de la fiche, et suit chaque nouvelle version', async () => {
    const t = await setupBoutique();
    let r = await t.boutique.preview(t.agent, { support: 'flyer', propertyId: t.propertyId });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const page = (await new PageBien(t.db, t.acces, t.journal).inputFor(t.network.id, t.propertyId))!;
    expect(visibleText(r.html)).toContain(page.payload.mentions!);
    expect(visibleText(r.html)).toContain(euros(page.payload.priceEur!));
    // La fiche du bien dit 200 000 € : ce prix-là, hors honoraires, n'est jamais le prix affiché.
    expect(r.html).not.toContain(`<p class="prix">${euros(200000)}</p>`);
    expect(r.html.includes('Léa') || r.html.includes('Exemple')).toBe(false);
    await t.amend(190000);
    await t.publication.sync(t.network.id, t.propertyId);
    r = await t.boutique.preview(t.agent, { support: 'flyer', propertyId: t.propertyId });
    const after = (await new PageBien(t.db, t.acces, t.journal).inputFor(t.network.id, t.propertyId))!;
    expect(r.ok && r.html).toContain(`<p class="prix">${euros(after.payload.priceEur!)}</p>`);
    expect(after.payload.priceEur).not.toBe(page.payload.priceEur);
  });

  it('[R263] le code QR mène à la page de référence du bien, et le mot-clé du support fait reconnaître ce bien par la captation', async () => {
    const t = await setupBoutique();
    const r = await t.boutique.preview(t.agent, { support: 'panneau', propertyId: t.propertyId });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(qrIn(r.html)).toBe(t.url);
    expect(qrIn(r.html)).toBe(await t.referencement.canonicalFor(t.network.id, t.propertyId));
    const seen = await new ReconnaissanceBien(t.db).recognize(t.network.id, { text: `Bonjour, ${r.keyword} svp` });
    expect(seen.status === 'recognized' && seen.property.id).toBe(t.propertyId);
  });

  it('[R263] pas de page publiée, pas de support : sans site en service, ou pour un bien vendu', async () => {
    const t = await setupBoutique();
    await t.referencement.setSite(t.direction, { kind: 'reseau', baseUrl: 'https://reseau.exemple.test', active: false });
    expect(await t.boutique.preview(t.agent, { support: 'flyer', propertyId: t.propertyId })).toMatchObject({ ok: false, code: 'pas_de_page' });
    await t.referencement.setSite(t.direction, { kind: 'reseau', baseUrl: 'https://reseau.exemple.test', active: true });
    await t.db.run("UPDATE properties SET status = 'sold' WHERE id = ?", [t.propertyId]);
    await t.publication.sync(t.network.id, t.propertyId);
    expect(await t.boutique.preview(t.agent, { support: 'flyer', propertyId: t.propertyId })).toMatchObject({ ok: false });
  });

  it('[R265] seul l’agent du bien prépare ses supports ; un autre agent ou la direction sont refusés et le refus va au journal', async () => {
    const t = await setupBoutique();
    expect(await t.boutique.preview(t.sam, { support: 'flyer', propertyId: t.propertyId })).toMatchObject({ ok: false, rule: 'R16' });
    expect(await t.boutique.preview(t.direction, { support: 'flyer', propertyId: t.propertyId })).toMatchObject({ ok: false, rule: 'R16' });
    const refusals = (await t.journal.all()).filter((e) => e.type === 'acces.refuse' && e.data.kind === 'boutique');
    expect(refusals.length).toBe(2);
  });

  it('[R264] le prix d’une commande vient du tarif réglé par la direction, en vigueur ; sans tarif, aucune commande', async () => {
    const t = await setupBoutique();
    const prep = (requestId: string, quantity = 100) => t.boutique.prepare(t.agent, { requestId, support: 'flyer', propertyId: t.propertyId, quantity });
    expect(await prep('commande-0001')).toEqual({ ok: false, rule: null, code: 'pas_de_tarif' });
    expect(await t.boutique.setTariff(t.agent, { support: 'flyer', quantity: 100, priceCents: 4900, printer: 'x', source: 'y', validUntil: '2027-12-31' })).toMatchObject({ ok: false, rule: 'R16' });
    expect(await t.tariff('flyer', 100, 0)).toEqual({ ok: false, rule: null, code: 'bad_price' });
    expect(await t.tariff('flyer', 100, 4900, '2027-02-31')).toEqual({ ok: false, rule: null, code: 'bad_date' });
    expect(await t.tariff('flyer', 100, 4900, '2027-02-28')).toEqual({ ok: false, rule: null, code: 'deja_echu' });
    expect((await t.tariff('flyer', 100, 4900)).ok).toBe(true);
    expect(await prep('commande-0002', 250)).toEqual({ ok: false, rule: null, code: 'pas_de_tarif' });
    const ok = await prep('commande-0003');
    expect(ok).toMatchObject({ ok: true, orderId: 'commande-0003', priceCents: 4900 });
    // Un tarif échu ne laisse jamais revenir l'ancien : plus de tarif du tout.
    expect((await t.tariff('flyer', 100, 5200, '2027-03-02')).ok).toBe(true);
    t.setClock(new Date('2027-03-03T08:00:00.000Z'));
    expect(await prep('commande-0004')).toEqual({ ok: false, rule: null, code: 'pas_de_tarif' });
  });

  it('[R265] préparer ne commande rien ; le geste de l’agent envoie exactement le support vu, une seule fois', async () => {
    const t = await setupBoutique();
    await t.tariff('flyer', 100, 4900);
    const ok = await t.boutique.prepare(t.agent, { requestId: 'commande-0010', support: 'flyer', propertyId: t.propertyId, quantity: 100 });
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;
    expect(t.printer.received).toEqual([]);
    expect((await t.boutique.orders(t.agent))[0]).toMatchObject({ id: 'commande-0010', status: 'preparee', priceCents: 4900 });
    // Rejouée, la même demande rend la même commande, sans en créer une autre.
    expect(await t.boutique.prepare(t.agent, { requestId: 'commande-0010', support: 'flyer', propertyId: t.propertyId, quantity: 100 })).toMatchObject({ ok: true, orderId: 'commande-0010' });
    expect((await t.boutique.orders(t.agent)).length).toBe(1);
    expect(await t.boutique.prepare(t.agent, { requestId: 'commande-0010', support: 'flyer', propertyId: t.propertyId, quantity: 250 })).toEqual({ ok: false, rule: null, code: 'demande_differente' });
    expect(await t.boutique.prepare(t.agent, { requestId: 'commande-0010', support: 'panneau', propertyId: t.propertyId, quantity: 100 })).toEqual({ ok: false, rule: null, code: 'demande_differente' });
    // Un autre agent, la direction : ni validation, ni envoi.
    expect(await t.boutique.validate(t.sam, 'commande-0010')).toMatchObject({ ok: false, rule: 'R16' });
    expect(await t.boutique.validate(t.direction, 'commande-0010')).toMatchObject({ ok: false, rule: 'R16' });
    expect(t.printer.received).toEqual([]);
    expect(await t.boutique.validate(t.agent, 'commande-0010')).toEqual({ ok: true, printerRef: 'IMP-1' });
    expect(t.printer.received).toHaveLength(1);
    expect(t.printer.received[0]).toMatchObject({ orderId: 'commande-0010', support: 'flyer', quantity: 100, priceCents: 4900, html: ok.html });
    expect(Object.keys(t.printer.received[0]!).sort()).toEqual(['html', 'orderId', 'priceCents', 'quantity', 'support']);
    expect(await t.boutique.validate(t.agent, 'commande-0010')).toEqual({ ok: false, rule: null, code: 'deja_validee' });
    expect(await Promise.all([t.boutique.validate(t.agent, 'commande-0010'), t.boutique.validate(t.agent, 'commande-0010')])).toEqual([
      { ok: false, rule: null, code: 'deja_validee' },
      { ok: false, rule: null, code: 'deja_validee' },
    ]);
    expect(t.printer.received).toHaveLength(1);
    expect((await t.boutique.orders(t.agent))[0]).toMatchObject({ status: 'envoyee' });
  });

  it('[R265] une validation rangée sans envoi réservé (coupure) se reprend au geste suivant, une seule fois', async () => {
    const t = await setupBoutique();
    await t.tariff('flyer', 100, 4900);
    await t.boutique.prepare(t.agent, { requestId: 'commande-0015', support: 'flyer', propertyId: t.propertyId, quantity: 100 });
    await t.db.run("INSERT INTO shop_order_validations (order_id, validated_by, validated_at) VALUES ('commande-0015', ?, 'x')", [`agent:${t.alexId}`]);
    expect(t.printer.received).toEqual([]);
    expect(await t.boutique.validate(t.agent, 'commande-0015')).toEqual({ ok: true, printerRef: 'IMP-1' });
    expect(await t.boutique.validate(t.agent, 'commande-0015')).toEqual({ ok: false, rule: null, code: 'deja_validee' });
    expect(t.printer.received).toHaveLength(1);
  });

  it('[R265] deux gestes au même instant : un seul envoi', async () => {
    const t = await setupBoutique();
    await t.tariff('panneau', 1, 3500);
    await t.boutique.prepare(t.agent, { requestId: 'commande-0020', support: 'panneau', propertyId: t.propertyId, quantity: 1 });
    const both = await Promise.all([t.boutique.validate(t.agent, 'commande-0020'), t.boutique.validate(t.agent, 'commande-0020')]);
    expect(both.filter((r) => r.ok)).toHaveLength(1);
    expect(t.printer.received).toHaveLength(1);
  });

  it('[R264] une commande dont le support ou le tarif a changé depuis sa préparation est périmée : rien ne part', async () => {
    const t = await setupBoutique();
    await t.tariff('flyer', 100, 4900);
    await t.boutique.prepare(t.agent, { requestId: 'commande-0030', support: 'flyer', propertyId: t.propertyId, quantity: 100 });
    await t.amend(190000);
    await t.publication.sync(t.network.id, t.propertyId);
    expect(await t.boutique.validate(t.agent, 'commande-0030')).toEqual({ ok: false, rule: null, code: 'support_perime' });
    await t.boutique.prepare(t.agent, { requestId: 'commande-0031', support: 'flyer', propertyId: t.propertyId, quantity: 100 });
    await t.tariff('flyer', 100, 5100);
    expect(await t.boutique.validate(t.agent, 'commande-0031')).toEqual({ ok: false, rule: null, code: 'tarif_change' });
    await t.boutique.prepare(t.agent, { requestId: 'commande-0032', support: 'flyer', propertyId: t.propertyId, quantity: 100 });
    await t.db.run("UPDATE properties SET status = 'sold' WHERE id = ?", [t.propertyId]);
    await t.publication.sync(t.network.id, t.propertyId);
    expect(await t.boutique.validate(t.agent, 'commande-0032')).toEqual({ ok: false, rule: null, code: 'support_perime' });
    expect(t.printer.received).toEqual([]);
  });

  it('[R265] l’imprimeur en panne : la commande reste en échec, jamais renvoyée seule, et le journal ne porte aucune donnée personnelle', async () => {
    const t = await setupBoutique();
    await t.tariff('vitrine', 2, 1800);
    await t.boutique.prepare(t.agent, { requestId: 'commande-0040', support: 'vitrine', propertyId: t.propertyId, quantity: 2 });
    t.printer.fail = true;
    expect(await t.boutique.validate(t.agent, 'commande-0040')).toEqual({ ok: false, rule: null, code: 'imprimeur_en_panne' });
    t.printer.fail = false;
    expect(await t.boutique.validate(t.agent, 'commande-0040')).toEqual({ ok: false, rule: null, code: 'deja_validee' });
    expect(t.printer.received).toEqual([]);
    expect((await t.boutique.orders(t.agent))[0]).toMatchObject({ status: 'echec' });
    const lines = JSON.stringify((await t.journal.all()).filter((e) => e.type.startsWith('boutique.')));
    expect(lines).toContain('boutique.envoi_echoue');
    expect(lines).not.toMatch(/03 00|alex@|Alex|Léa|€/);
  });

  it('[R265] la carte de visite : l’agent pour lui-même, code vers le site de son réseau', async () => {
    const t = await setupBoutique();
    await t.tariff('carte', 250, 2900);
    const r = await t.boutique.preview(t.agent, { support: 'carte' });
    expect(r.ok && qrIn(r.html)).toBe('https://reseau.exemple.test');
    const prep = await t.boutique.prepare(t.agent, { requestId: 'commande-0050', support: 'carte', quantity: 250 });
    expect(prep).toMatchObject({ ok: true, priceCents: 2900 });
    expect(await t.boutique.validate(t.agent, 'commande-0050')).toMatchObject({ ok: true });
    expect(await t.boutique.preview(t.direction, { support: 'carte' })).toMatchObject({ ok: false, rule: 'R16' });
  });

  it('[R17] tarifs, commandes, validations et envois ne changent ni ne s’effacent', async () => {
    const t = await setupBoutique();
    await t.tariff('flyer', 100, 4900);
    await t.boutique.prepare(t.agent, { requestId: 'commande-0060', support: 'flyer', propertyId: t.propertyId, quantity: 100 });
    await t.boutique.validate(t.agent, 'commande-0060');
    for (const table of ['shop_tariffs', 'shop_orders', 'shop_order_validations', 'shop_order_sends', 'shop_order_results']) {
      await expect(t.db.run(`DELETE FROM ${table}`), table).rejects.toThrow(/efface/);
      await expect(t.db.run(`UPDATE ${table} SET ${table === 'shop_tariffs' || table === 'shop_orders' ? 'network_id' : 'order_id'} = 'x'`), table).rejects.toThrow(/change/);
    }
  });
});
