import { describe, expect, it } from 'vitest';
import { contentOfPath } from '../src/attirer/origine-contacts.ts';
import { Referencement } from '../src/attirer/referencement.ts';
import { euros, PageBien } from '../src/annonces/index.ts';
import { visibleText } from '../src/boutique/supports.ts';
import { BUDGETS, budgetProblems, htmlProblems } from '../src/design/audit.ts';
import { renderSlide, renderVitrinePage, screenCodeOf, Vitrine, vitrineLink, VITRINE_MAX_SLIDES, VITRINE_PARAM, VITRINE_REFRESH_SECONDS } from '../src/recherche/vitrine.ts';
import { setupAnnonce } from './annonces-jeu.ts';
import { modulesFromSvg, readQr } from './qr-lecture.ts';
import { describeWithSqlite } from './sqlite.ts';

// Réseau, agents, biens, écrans et messages inventés.
const qrsIn = (html: string): string[] => [...html.matchAll(/<svg[\s\S]*?<\/svg>/g)].map((m) => readQr(modulesFromSvg(m[0])));
const SCREEN = 'abcdefghijk2';
const OTHER = 'abcdefghijk3';

describe('HX31 · lien de vitrine', () => {
  it('[R433] le lien porte la page de référence, le code du bien et le code de l’écran, rien d’autre', () => {
    const link = vitrineLink('https://reseau.exemple.test/biens/b1', 'aaaabbbbcccc', SCREEN)!;
    const u = new URL(link);
    expect(u.origin + u.pathname).toBe('https://reseau.exemple.test/biens/b1');
    expect([...u.searchParams.keys()].sort()).toEqual(['o', VITRINE_PARAM]);
    expect(u.searchParams.get('o')).toBe('aaaabbbbcccc');
    expect(screenCodeOf(u)).toBe(SCREEN);
    expect(vitrineLink('https://reseau.exemple.test/biens/b1', 'aaaabbbbcccc', 'pas-un-code')).toBeNull();
    expect(vitrineLink('http://reseau.exemple.test/biens/b1', 'aaaabbbbcccc', SCREEN)).toBeNull();
    expect(screenCodeOf(new URL(`https://x.test/?vitrine=${SCREEN}&vitrine=${OTHER}`))).toBeNull();
  });
});

describe('HX31 · poids de la page', () => {
  it('[R201] un écran plein, au nombre de biens permis, tient dans le budget d’une page publique, codes QR compris', () => {
    const N = '\u00a0';
    const S = '\u202f';
    const slides: string[] = [];
    for (let i = 0; i < VITRINE_MAX_SLIDES; i++) {
      const id = crypto.randomUUID();
      const one = renderSlide(
        {
          listing: {
            title: `Maison de 5 pièces avec jardin et garage à Fontaine-lès-Dijon, proche des écoles ${i}`,
            priceEur: 345000 + i,
            mentions: `Prix : 345${S}00${i}${N}€ honoraires inclus, soit 330${S}000${N}€ hors honoraires et 4,55${N}% TTC du prix hors honoraires, à la charge de l'acquéreur.\nClasse énergie D, classe climat C. Montant estimé des dépenses annuelles d'énergie entre 1${S}100${N}€ et 1${S}550${N}€.\nCarte professionnelle n° CPI 2101 2027 000 000 001.`,
            photo: { ref: `biens/${id}/${crypto.randomUUID()}.jpg`, overlay: i % 2 ? 'Aménagement virtuel' : null },
          },
          reference: `REF-2027-${1000 + i}`,
          link: `https://www.reseau-immobilier-exemple.test/biens/${id}?o=abcdefghijkl&vitrine=${SCREEN}`,
        },
        i + 1,
      );
      expect(one).not.toBe('qr_trop_long');
      slides.push(one);
    }
    const html = renderVitrinePage(slides, new Date('2027-03-01T08:00:00.000Z'), 10);
    expect(htmlProblems(html)).toEqual([]);
    expect(budgetProblems({ html }, BUDGETS.page)).toEqual([]);
  });
});

async function setupVitrine() {
  const t = await setupAnnonce();
  t.setClock(new Date('2027-02-12T10:00:00.000Z'));
  await t.annonces.validate(t.agent, t.draftId);
  t.setClock(new Date('2027-03-01T08:00:00.000Z'));
  await t.publication.sync(t.network.id, t.propertyId);
  const referencement = new Referencement(t.db, t.journal, { now: t.now });
  expect((await referencement.setSite(t.direction, { kind: 'reseau', baseUrl: 'https://reseau.exemple.test', active: true })).ok).toBe(true);
  const codes = [SCREEN, OTHER, 'abcdefghijk4', 'abcdefghijk5'];
  const vitrine = new Vitrine(t.db, t.acces, t.journal, { now: t.now, referencement, newCode: () => codes.shift()! });
  let m = 0;
  const inbound = async (o: { network?: string; at?: string; conv?: string } = {}) => {
    const id = `in-${++m}`;
    await t.db.run(
      `INSERT INTO inbound_messages (id, network_id, dedup_key, channel, kind, external_id, conversation_ref, sender_name, body, status, received_at, created_at)
       VALUES (?, ?, ?, 'site', 'form', ?, ?, 'Personne Inventée', 'Bonjour', 'received', ?, 'x')`,
      [id, o.network ?? t.network.id, `k-${id}`, `ext-${id}`, o.conv ?? null, o.at ?? '2027-03-01T09:00:00.000Z'],
    );
    return id;
  };
  const url = `https://reseau.exemple.test/biens/${encodeURIComponent(t.propertyId)}`;
  return { ...t, referencement, vitrine, inbound, url };
}

describeWithSqlite('HX31 · écran de vitrine en agence', () => {
  it('[R432] l’écran montre le prix publié du moment et toutes les mentions, jamais le prix de la fiche, et suit chaque nouvelle version', async () => {
    const t = await setupVitrine();
    const s = await t.vitrine.createScreen(t.direction, { label: 'Vitrine de l’agence' });
    expect(s.ok).toBe(true);
    let r = await t.vitrine.page(SCREEN);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const before = (await new PageBien(t.db, t.acces, t.journal).inputFor(t.network.id, t.propertyId))!;
    expect(r.slides.map((x) => x.propertyId)).toEqual([t.propertyId]);
    expect(visibleText(r.html)).toContain(before.payload.mentions!);
    expect(r.html).toContain(`<p class="prix">${euros(before.payload.priceEur!)}</p>`);
    expect(r.html).not.toContain(`<p class="prix">${euros(200000)}</p>`);
    expect(r.html.indexOf('class="prix"')).toBeLessThan(r.html.indexOf('class="mentions"'));
    // Ni la personne vendeuse, ni l'adresse, ni le nom de l'écran.
    expect(r.html).not.toMatch(/Léa|Exemple|21000|Vitrine de l’agence/);
    // La page se recharge seule : c'est la « mise à jour suivante ».
    expect(r.html).toContain(`<noscript><meta http-equiv="refresh" content="${VITRINE_REFRESH_SECONDS}"></noscript>`);
    expect(r.html).toContain(`location.reload()},${VITRINE_REFRESH_SECONDS * 1000})`);
    await t.amend(190000);
    await t.publication.sync(t.network.id, t.propertyId);
    const after = (await new PageBien(t.db, t.acces, t.journal).inputFor(t.network.id, t.propertyId))!;
    expect(after.payload.priceEur).not.toBe(before.payload.priceEur);
    r = await t.vitrine.page(SCREEN);
    expect(r.ok && r.html).toContain(`<p class="prix">${euros(after.payload.priceEur!)}</p>`);
    expect(r.ok && r.html).not.toContain(`<p class="prix">${euros(before.payload.priceEur!)}</p>`);
  });

  it('[R432] un bien vendu, sous offre ou retiré disparaît de l’écran à la mise à jour suivante, même avant le passage de la publication', async () => {
    const t = await setupVitrine();
    await t.vitrine.createScreen(t.direction, { label: 'Vitrine' });
    for (const status of ['sold', 'under_offer', 'withdrawn'] as const) {
      await t.db.run("UPDATE properties SET status = 'available' WHERE id = ?", [t.propertyId]);
      let r = await t.vitrine.page(SCREEN);
      expect(r.ok && r.slides.length, status).toBe(1);
      await t.db.run('UPDATE properties SET status = ? WHERE id = ?', [status, t.propertyId]);
      // Sans aucun passage de la publication : l'écran lit l'état du bien à chaque rendu.
      r = await t.vitrine.page(SCREEN);
      expect(r.ok && r.slides, status).toEqual([]);
      expect(r.ok && r.html, status).not.toContain('class="prix"');
      expect(r.ok && r.html, status).toContain('Nos biens arrivent bientôt.');
      const p = await t.vitrine.preview(t.direction, SCREEN);
      expect(p.ok && p.render.leftOut, status).toEqual([{ propertyId: t.propertyId, reference: 'REF-T-1', reason: 'pas_en_vente' }]);
    }
    // Vendu puis publié : la dernière version dit « vendu », il ne revient pas.
    await t.db.run("UPDATE properties SET status = 'sold' WHERE id = ?", [t.propertyId]);
    await t.publication.sync(t.network.id, t.propertyId);
    const r = await t.vitrine.page(SCREEN);
    expect(r.ok && r.slides).toEqual([]);
  });

  it('[R432] [R42] sans page de référence en ligne, ou quand la diffusion ne le permet plus, pas de place à l’écran', async () => {
    const t = await setupVitrine();
    await t.vitrine.createScreen(t.direction, { label: 'Vitrine' });
    await t.referencement.setSite(t.direction, { kind: 'reseau', baseUrl: 'https://reseau.exemple.test', active: false });
    let p = await t.vitrine.preview(t.direction, SCREEN);
    expect(p.ok && p.render.leftOut.map((l) => l.reason)).toEqual(['pas_de_page']);
    await t.referencement.setSite(t.direction, { kind: 'reseau', baseUrl: 'https://reseau.exemple.test', active: true });
    // À une date où la porte de diffusion est fermée (avant le mandat), l'écran la consulte à chaque rendu.
    const vitrine = new Vitrine(t.db, t.acces, t.journal, { now: () => new Date('2020-01-01T00:00:00.000Z'), referencement: t.referencement });
    p = await vitrine.preview(t.direction, SCREEN);
    expect(p.ok && p.render.leftOut.map((l) => l.reason)).toEqual(['diffusion']);
    expect(p.ok && p.render.slides).toEqual([]);
  });

  it('[R433] le code QR mène à la page de référence du bien, marquée « vitrine » et du code du bien', async () => {
    const t = await setupVitrine();
    await t.vitrine.createScreen(t.direction, { label: 'Vitrine' });
    const r = await t.vitrine.page(SCREEN);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const [read] = qrsIn(r.html);
    expect(read).toBe(r.slides[0]!.link);
    const u = new URL(read!);
    expect(`${u.origin}${u.pathname}`).toBe(t.url);
    expect(`${u.origin}${u.pathname}`).toBe(await t.referencement.canonicalFor(t.network.id, t.propertyId));
    expect(contentOfPath(u.pathname)).toEqual({ kind: 'bien', ref: t.propertyId });
    expect(u.searchParams.get(VITRINE_PARAM)).toBe(SCREEN);
    const code = await t.db.first<{ kind: string; ref: string }>('SELECT kind, ref FROM public_contents WHERE id = ?', [u.searchParams.get('o')]);
    expect(code).toEqual({ kind: 'bien', ref: t.propertyId });
  });

  it('[R434] le contact venu d’un code QR de vitrine est compté pour cet écran et ce bien, une fois ; un doute ne range rien', async () => {
    const t = await setupVitrine();
    await t.vitrine.createScreen(t.direction, { label: 'Vitrine' });
    await t.vitrine.createScreen(t.direction, { label: 'Autre vitrine' });
    const r = await t.vitrine.page(SCREEN);
    const link = r.ok ? r.slides[0]!.link : '';
    const a = await t.inbound();
    expect(await t.vitrine.record(t.network.id, a, { link })).toEqual({ ok: true, screenId: SCREEN, already: false });
    expect(await t.vitrine.record(t.network.id, a, { link: link.replace(SCREEN, OTHER) })).toEqual({ ok: true, screenId: SCREEN, already: true });
    const kept = await t.db.all('SELECT * FROM contact_vitrines');
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatchObject({ screen_id: SCREEN, property_id: t.propertyId });
    // Rien d'autre n'est gardé : ni adresse, ni paramètre, ni personne.
    expect(Object.keys(kept[0]!).sort()).toEqual(['id', 'inbound_id', 'network_id', 'property_id', 'recorded_at', 'screen_id']);
    // Deux écrans différents, deux codes dans un lien, un code inconnu, un autre réseau, aucun code : rien.
    const doubt = await t.inbound();
    expect(await t.vitrine.record(t.network.id, doubt, { link, landingPage: link.replace(SCREEN, OTHER) })).toEqual({ ok: true, screenId: null, already: false });
    const twice = await t.inbound();
    expect(await t.vitrine.record(t.network.id, twice, { link: `${link}&${VITRINE_PARAM}=${SCREEN}` })).toEqual({ ok: true, screenId: null, already: false });
    const unknown = await t.inbound();
    expect(await t.vitrine.record(t.network.id, unknown, { link: link.replace(SCREEN, 'zzzzzzzzzzzz') })).toEqual({ ok: true, screenId: null, already: false });
    const none = await t.inbound();
    expect(await t.vitrine.record(t.network.id, none, { link: t.url })).toEqual({ ok: true, screenId: null, already: false });
    await t.db.run("INSERT INTO networks (id, name, created_at) VALUES ('net-autre', 'Autre réseau', '2026-01-01T00:00:00.000Z')");
    const elsewhere = await t.inbound({ network: 'net-autre' });
    expect(await t.vitrine.record('net-autre', elsewhere, { link })).toEqual({ ok: true, screenId: null, already: false });
    expect(await t.vitrine.record(t.network.id, 'inconnu', { link })).toEqual({ ok: false, code: 'unknown_inbound' });
    expect(await t.db.all('SELECT * FROM contact_vitrines')).toHaveLength(1);
    // Une page de départ seule suffit ; un lien vers une autre page que celle d'un bien garde l'écran, sans bien.
    const landing = await t.inbound();
    expect(await t.vitrine.record(t.network.id, landing, { landingPage: `https://reseau.exemple.test/simulateur?${VITRINE_PARAM}=${OTHER}` })).toEqual({ ok: true, screenId: OTHER, already: false });
    expect(await t.db.first('SELECT property_id FROM contact_vitrines WHERE inbound_id = ?', [landing])).toEqual({ property_id: null });
  });

  it('[R434] [R16] la mesure du mois compte les contacts de chaque vitrine, par bien ; la direction voit tout, un agent ses écrans', async () => {
    const t = await setupVitrine();
    await t.vitrine.createScreen(t.direction, { label: 'Vitrine du réseau' });
    expect(await t.vitrine.createScreen(t.agent, { agentId: t.alexId, label: 'Vitrine d’Alex' })).toEqual({ ok: true, screenId: OTHER });
    const r = await t.vitrine.page(SCREEN);
    const link = r.ok ? r.slides[0]!.link : '';
    for (const conv of ['c1', 'c2']) await t.vitrine.record(t.network.id, await t.inbound({ conv }), { link });
    // Un second message de la même conversation ne fait pas un second contact.
    await t.vitrine.record(t.network.id, await t.inbound({ conv: 'c1', at: '2027-03-02T09:00:00.000Z' }), { link });
    await t.vitrine.record(t.network.id, await t.inbound({ conv: 'c3' }), { link: link.replace(SCREEN, OTHER) });
    // Un contact d'un autre mois ne compte pas pour mars.
    await t.vitrine.record(t.network.id, await t.inbound({ conv: 'c4', at: '2027-04-01T09:00:00.000Z' }), { link });
    const d = await t.vitrine.measure(t.direction, '2027-03');
    expect(d).toEqual({
      ok: true,
      measure: {
        month: '2027-03',
        contacts: 3,
        byScreen: [
          { screenId: SCREEN, label: 'Vitrine du réseau', contacts: 2, byProperty: [{ reference: 'REF-T-1', contacts: 2 }] },
          { screenId: OTHER, label: 'Vitrine d’Alex', contacts: 1, byProperty: [{ reference: 'REF-T-1', contacts: 1 }] },
        ],
      },
    });
    const a = await t.vitrine.measure(t.agent, '2027-03');
    expect(a.ok && a.measure.byScreen.map((s) => s.screenId)).toEqual([OTHER]);
    expect(a.ok && a.measure.contacts).toBe(1);
    expect(await t.vitrine.measure(t.sam, '2027-03')).toEqual({ ok: true, measure: { month: '2027-03', contacts: 0, byScreen: [] } });
    expect(await t.vitrine.measure({ role: 'compliance', userId: 'c-1', networkId: t.network.id } as never, '2027-03')).toMatchObject({ ok: false, rule: 'R16' });
    expect(await t.vitrine.measure(t.direction, '2027-13')).toEqual({ ok: false, rule: null, code: 'bad_month' });
  });

  it('[R16] un agent ne règle que son écran, qui ne montre que ses biens ; un écran éteint ne montre rien', async () => {
    const t = await setupVitrine();
    expect(await t.vitrine.createScreen(t.agent, { label: 'Vitrine' })).toMatchObject({ ok: false, rule: 'R16' });
    expect(await t.vitrine.createScreen(t.sam, { agentId: t.alexId, label: 'Vitrine' })).toMatchObject({ ok: false, rule: 'R16' });
    expect(await t.vitrine.createScreen(t.direction, { label: 'Vitrine 12' })).toEqual({ ok: false, rule: null, code: 'bad_label' });
    expect(await t.vitrine.createScreen(t.direction, { label: 'Vitrine', secondsPerSlide: 2 })).toEqual({ ok: false, rule: null, code: 'bad_seconds' });
    expect(await t.vitrine.createScreen(t.agent, { agentId: t.alexId, label: 'Vitrine d’Alex' })).toEqual({ ok: true, screenId: SCREEN });
    const samId = t.sam.userId;
    expect(await t.vitrine.createScreen(t.sam, { agentId: samId, label: 'Vitrine de Sam' })).toEqual({ ok: true, screenId: OTHER });
    // L'écran de Sam ne montre pas le bien d'Alex.
    const sam = await t.vitrine.page(OTHER);
    expect(sam.ok && sam.slides).toEqual([]);
    const alex = await t.vitrine.page(SCREEN);
    expect(alex.ok && alex.slides.map((s) => s.propertyId)).toEqual([t.propertyId]);
    expect(await t.vitrine.preview(t.sam, SCREEN)).toMatchObject({ ok: false, rule: 'R16' });
    expect(await t.vitrine.setActive(t.sam, SCREEN, false)).toMatchObject({ ok: false, rule: 'R16' });
    expect(await t.vitrine.setActive(t.agent, SCREEN, false)).toEqual({ ok: true, screenId: SCREEN });
    expect(await t.vitrine.page(SCREEN)).toEqual({ ok: false, code: 'screen_off' });
    expect(await t.vitrine.setActive(t.direction, SCREEN, true)).toEqual({ ok: true, screenId: SCREEN });
    expect((await t.vitrine.page(SCREEN)).ok).toBe(true);
    expect(await t.vitrine.page('inconnu')).toEqual({ ok: false, code: 'unknown_screen' });
    // Rien ne s'efface ni ne se réécrit [R17].
    await expect(t.db.run('DELETE FROM vitrine_screens')).rejects.toThrow();
    await expect(t.db.run("UPDATE vitrine_screens SET label = 'x'")).rejects.toThrow();
  });

  it('[R201] la page suit le système de design, passe le contrôle d’accessibilité et ne charge rien d’extérieur hors les photos du site', async () => {
    const t = await setupVitrine();
    await t.vitrine.createScreen(t.direction, { label: 'Vitrine' });
    const r = await t.vitrine.page(SCREEN);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(htmlProblems(r.html)).toEqual([]);
    expect(budgetProblems({ html: r.html }, BUDGETS.page)).toEqual([]);
    expect(r.html).not.toMatch(/<link|<script src|@import/);
    for (const m of r.html.matchAll(/src="([^"]+)"/g)) expect(m[1]!.startsWith('/medias/')).toBe(true);
    // La photo d'aménagement virtuel garde sa mention sur l'image [R48].
    if (r.html.includes('aménagement virtuel')) expect(r.html).toContain('<span class="virtuel">Aménagement virtuel</span>');
  });
});
