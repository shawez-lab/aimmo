import { expect, it } from 'vitest';
import {
  ADVICE_NOTICE,
  Acces,
  AvisDeValeur,
  AvisImprime,
  FicheClient,
  FicheUnique,
  Fourchette,
  SqlJournalStore,
  applyMigrations,
  euros,
  fromSyncSqlite,
  renderValuationPrint,
  type RangeResult,
  type Sale,
  type Viewer,
} from '../src/index.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

// Tout est inventé.
const NOW = () => new Date('2026-10-31T23:30:00.000Z');
const SALES: Sale[] = Array.from({ length: 14 }, (_, i) => ({
  id: `t:${i}`,
  kind: 'apartment' as const,
  lat: 47.3225 + i * 0.0002,
  lon: 5.0412,
  surface: 60 + i,
  pricePerM2: 2500 + i * 20,
  month: `2025-0${(i % 9) + 1}`,
}));

async function range(): Promise<Extract<RangeResult, { ok: true }>> {
  const r = await new Fourchette(
    { coverage: async () => ({ department: '21', lastSale: '2025-12-30', years: [2023, 2024, 2025], source: 'DVF test' }), within: async () => SALES },
    undefined,
    NOW,
  ).estimate({ kind: 'apartment', surface: 65, lat: 47.3225, lon: 5.0412, postalCode: '21000', floor: 2, balcony: true });
  if (!r.ok) throw new Error(r.reason);
  return r;
}

async function world() {
  const db = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  const store = new FicheClient(db);
  const net = await store.createNetwork('Réseau test');
  const other = await store.createNetwork('Autre réseau');
  const paul = await store.createAgent({ networkId: net.id, firstName: 'Paul', lastName: 'Essai' });
  const lise = await store.createAgent({ networkId: net.id, firstName: 'Lise', lastName: 'Essai' });
  const property = await store.createProperty({ networkId: net.id, agentId: paul.id, reference: 'B-1', kind: 'home', postalCode: '21000', city: 'Dijon', surfaceM2: 65 });
  const journal = new SqlJournalStore(db);
  const avis = new AvisDeValeur(db, journal, { now: NOW });
  const acces = new Acces(db, store, new FicheUnique(db, store, { now: NOW }), journal, { now: NOW });
  const imprime = new AvisImprime(db, acces, journal, { now: NOW });
  const as = (role: string, id: string, networkId: string = net.id) => ({ role, userId: id, networkId }) as Viewer;
  const details = new Map(SALES.map((s, i) => [s.id, { street: i === 0 ? '12 Rue du Faux Numéro' : `Rue <b>Essai</b> ${i}`, town: 'Dijon' }]));
  const draft = async () => avis.draft({ networkId: net.id, propertyId: property.id, kind: 'apartment', surface: 65, range: await range(), details });
  const validated = async () => {
    const r = await draft();
    const ok = await avis.validate(as('agent', paul.id), r.id);
    if (!ok.ok) throw new Error(ok.code);
    return ok.value;
  };
  return { db, net, other, paul, lise, property, journal, avis, imprime, as, draft, validated };
}

describeWithSqlite('E08 · avis de valeur imprimable à la marque de l’agent', () => {
  it('[R30] un brouillon ne s’imprime jamais', async () => {
    const w = await world();
    const r = await w.draft();
    expect(await w.imprime.print(w.as('agent', w.paul.id), r.id)).toEqual({ ok: false, rule: 'R30', code: 'not_validated' });
  });

  it('[R30] l’avis d’un agent qui ne suit plus le bien, ou parti, ne s’imprime ni ne part', async () => {
    const w = await world();
    const r = await w.validated();
    await w.db.run('UPDATE properties SET agent_id = ? WHERE id = ?', [w.lise.id, w.property.id]);
    expect(await w.imprime.print(w.as('agent', w.lise.id), r.id)).toEqual({ ok: false, rule: 'R30', code: 'not_following_agent' });
    expect(await w.avis.releasable(r.id)).toEqual({ ok: false, rule: 'R30', code: 'not_following_agent' });

    await w.db.run('UPDATE properties SET agent_id = ? WHERE id = ?', [w.paul.id, w.property.id]);
    expect((await w.avis.releasable(r.id)).ok).toBe(true);
    await w.db.run("UPDATE agents SET status = 'left' WHERE id = ?", [w.paul.id]);
    expect(await w.avis.releasable(r.id)).toEqual({ ok: false, rule: 'R30', code: 'not_following_agent' });
  });

  it('[R16] seul celui qui voit le bien en entier imprime, dans son réseau', async () => {
    const w = await world();
    const r = await w.validated();
    expect((await w.imprime.print(w.as('agent', w.paul.id), r.id)).ok).toBe(true);
    expect((await w.imprime.print(w.as('direction', 'd1'), r.id)).ok).toBe(true);
    expect(await w.imprime.print(w.as('agent', w.lise.id), r.id)).toMatchObject({ ok: false, rule: 'R16' });
    expect(await w.imprime.print(w.as('direction', 'd2', w.other.id), r.id)).toEqual({ ok: false, rule: null, code: 'unknown' });
    expect(await w.imprime.print(w.as('agent', w.paul.id), 'inconnu')).toEqual({ ok: false, rule: null, code: 'unknown' });
    const refused = (await w.journal.all()).filter((e) => e.type === 'acces.refuse');
    expect(refused.some((e) => e.subject === `property:${w.property.id}` && e.actor === `agent:${w.lise.id}`)).toBe(true);
    expect(refused.filter((e) => e.data.code === 'unknown').map((e) => e.subject)).toEqual([`valuation:${r.id}`, 'valuation:inconnu']);
  });

  it('la page porte la fourchette validée, la méthode, les ventes, la mention et l’agent', async () => {
    const w = await world();
    await w.db.run("INSERT INTO agent_public_cards (id, agent_id, network_id, phone, email, set_by, set_at) VALUES ('c1', ?, ?, '03 00 00 00 00', 'paul@exemple.test', 'x', '2026-01-01')", [w.paul.id, w.net.id]);
    const d = await w.draft();
    const low = d.computed_low - 5000;
    const high = d.computed_high + 5000;
    expect((await w.avis.adjust(w.as('agent', w.paul.id), d.id, { low, high })).ok).toBe(true);
    expect((await w.avis.validate(w.as('agent', w.paul.id), d.id)).ok).toBe(true);
    const r = await w.imprime.print(w.as('agent', w.paul.id), d.id);
    if (!r.ok) throw new Error(r.code);
    expect(r.html).toContain(`<p class="prix">${euros(low)} <span>à</span> ${euros(high)}</p>`);
    expect(r.html).not.toContain(euros(d.computed_low));
    expect(r.html).toContain('Validé le 1 novembre 2026');
    expect(r.html).toContain('Paul Essai');
    expect(r.html).toContain('agent immobilier');
    expect(r.html).toContain('03 00 00 00 00');
    expect(r.html).toContain('paul@exemple.test');
    expect(r.html).toContain('Ventes réelles comparables');
    expect(r.html).toContain('Ventes utilisées jusqu’à');
    expect(r.html).toContain(ADVICE_NOTICE);
  });

  it('[R30] un texte ne dit jamais la fourchette du calcul quand l’agent l’a changée', async () => {
    const w = await world();
    const paul = w.as('agent', w.paul.id);
    const d = await w.draft();
    const low = d.computed_low - 5000;
    const high = d.computed_high + 5000;
    const both = `Le calcul donne ${euros(d.computed_low)} à ${euros(d.computed_high)}. Nous retenons ${euros(low)} à ${euros(high)}.`;
    // Écrit avec le changement : refusé par le contrôle du texte.
    expect(await w.avis.adjust(paul, d.id, { low, high, text: both })).toMatchObject({ ok: false, code: 'text_refused' });
    // Un texte qui garde une borne écartée, écrit avant le changement d'une seule borne : refusé à la validation.
    const before = `Entre ${euros(d.computed_low)} et ${euros(d.computed_high)}, soit au plus ${euros(d.computed_high)}.`;
    expect((await w.avis.adjust(paul, d.id, { text: before })).ok).toBe(true);
    await w.db.run('UPDATE valuation_reports SET agent_low = ? WHERE id = ?', [low, d.id]);
    await w.db.run('UPDATE valuation_reports SET text = ? WHERE id = ?', [`Entre ${euros(low)} et ${euros(d.computed_high)}, le calcul disait ${euros(d.computed_low)}.`, d.id]);
    expect(await w.avis.validate(paul, d.id)).toEqual({ ok: false, rule: 'R30', code: 'other_range_in_text' });
  });

  it('[R28] la date des ventes utilisées reste sur la page', async () => {
    const w = await world();
    const r = await w.validated();
    const p = await w.imprime.print(w.as('agent', w.paul.id), r.id);
    if (!p.ok) throw new Error(p.code);
    expect(p.html).toMatch(/Ventes utilisées jusqu’à [a-zéû]+ 2025/);
  });

  it('[R29] une vente citée n’a ni nom ni numéro de voie, et tout est échappé', async () => {
    const w = await world();
    const r = await w.validated();
    const p = await w.imprime.print(w.as('agent', w.paul.id), r.id);
    if (!p.ok) throw new Error(p.code);
    expect(p.html).not.toContain('Faux Numéro');
    expect(p.html).not.toContain('<b>');
    expect(p.html).toContain('Rue &lt;b&gt;Essai&lt;/b&gt;');
  });

  it('[R13] le journal porte l’impression, ni texte ni chiffre de l’avis', async () => {
    const w = await world();
    const r = await w.validated();
    await w.imprime.print(w.as('agent', w.paul.id), r.id);
    const entries = await w.journal.all();
    const printed = entries.find((e) => e.type === 'avis.imprime');
    expect(printed?.data).toEqual({ report: r.id });
    expect(JSON.stringify(entries)).not.toContain(String(r.computed_low));
  });

  it('DS084 · une couverture : la marque, le titre, la date, la fourchette en grand, et l’agent à son pied ; le texte commence après', () => {
    const html = renderValuationPrint({ low: 285000, high: 305000, validatedOn: '2026-11-02', text: 'A\n\nB', facts: { medianPerM2: 3720, comparables: 14, radius: 600, cited: [{ month: '2026-01', surface: 62, pricePerM2: 3540, distance: 80, street: 'Rue de l’Essai', town: 'Dijon' }], adjustments: [{ label: 'Balcon', pct: 2 }] }, agent: { firstName: 'Alex', lastName: 'Exemple', phone: '03 00 00 00 00', email: 'alex@exemple.test' } });
    const cover = /<header class="couverture">(.*?)<\/header>/s.exec(html)![1]!;
    expect(cover).toMatch(/^<p class="marque">AIMMO<\/p><div class="ouverture"><h1>Avis de valeur<\/h1><p class="date">Validé le 2 novembre 2026<\/p><p class="prix">[^<]+<span>à<\/span>[^<]+<\/p><\/div><section class="agent" aria-label="Votre agent">/);
    expect(cover).toContain('<strong>Alex Exemple</strong>, agent immobilier');
    expect(cover).toContain('03 00 00 00 00');
    // L'agent n'est écrit qu'une fois, et la couverture vient avant le texte, qui vient avant les ventes.
    expect(html.match(/class="agent"/g)).toHaveLength(1);
    expect(html.indexOf('</header>')).toBeLessThan(html.indexOf('<section class="texte">'));
    expect(html.indexOf('<section class="texte">')).toBeLessThan(html.indexOf('<h2>Ventes réelles comparables</h2>'));
    // La fourchette est le plus grand texte de la page ; la couverture tient dans une feuille A4 et ferme sa page.
    const size = (selector: string): number => Number(new RegExp(`(?:^|[}\\n])${selector}\\{font:400 ([\\d.]+)pt`).exec(html)![1]);
    expect(size('\\.prix')).toBeGreaterThanOrEqual(2 * size('h1'));
    expect(size('h1')).toBeGreaterThan(size('h2'));
    const print = /@media print\{(.*)\}`?/s.exec(html)![1]!;
    expect(print).toContain('break-after:page');
    const height = Number(/\.couverture\{[^}]*min-height:(\d+)mm/.exec(print)![1]);
    const margin = Number(/@page\{size:A4;margin:(\d+)mm\}/.exec(html)![1]);
    expect(height).toBeLessThan(297 - 2 * margin);
    expect(height).toBeGreaterThan(240);
    // Un tableau ne laisse pas son titre ni son en-tête seuls en bas d'une page.
    expect(html).toContain('h2{font:400 15pt/1.2 var(--police-titre);margin:10mm 0 3mm;break-after:avoid;page-break-after:avoid}');
    expect(html).toContain('caption,thead{break-inside:avoid;page-break-inside:avoid;break-after:avoid;page-break-after:avoid}');
    // Rien de collé ni de répété par le navigateur, et la marque n'est plus une étiquette en capitales de texte.
    expect(html).not.toContain('position:fixed');
    expect(html).toContain('.marque{margin:0;font:400 13pt/1 var(--police-titre)');
  });

  it('une page sans vente citée ni ajustement reste juste', () => {
    const html = renderValuationPrint({ low: 100, high: 200, validatedOn: '2026-11-02', text: 'A\n\nB', facts: { medianPerM2: 1, comparables: 0, radius: 1, cited: [], adjustments: [] }, agent: { firstName: 'A', lastName: 'B', phone: null, email: null } });
    expect(html).not.toContain('<table');
    expect(html).not.toContain('Caractéristiques prises');
    expect(html).toContain('<p>A</p><p>B</p>');
  });
});
