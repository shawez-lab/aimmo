import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DESIGN_CSS, PAIRES_TEXTE, PAIRES_TRAIT, PALETTE, PRINT_DESIGN_CSS, renderPublicPage, renderValuationPrint, type Teinte } from '@aimmo/core';
import { renderLegalNotice, renderPrivacyPage, withLegalLinks } from '../../core/src/attirer/mentions-site.ts';
import { renderEstimationPage } from '../../core/src/attirer/page-estimation.ts';
import { renderSiteHome } from '../../core/src/attirer/accueil-site.ts';
import { renderAgentsList, renderPricesList } from '../../core/src/attirer/annuaire-site.ts';
import { renderListingPage, renderListingPrint, type PageInput } from '../../core/src/annonces/page-bien.ts';
import { BUDGETS, budgetProblems, contrastRatio, htmlProblems, localCssProblems, screenCssProblems } from '../../core/src/design/audit.ts';
import { renderDocument } from '../../core/src/documents/modeles.ts';
import { letterFallback, renderLetters } from '../../core/src/mandats/gagner/lettres-quartier.ts';
import { DEFAULT_WELCOME, SALE_PLAN, renderDossier } from '../../core/src/mandats/gagner/dossier-presentation.ts';
import { AGENT_APP_FILES } from '../src/agent-app.ts';
import { handleUnsubscribe } from '../src/alertes.ts';
import { handleApresVentePublic } from '../src/apres-vente.ts';
import { handleCandidature } from '../src/candidature.ts';
import { renderCertificatePage } from '../src/certificat-photo.ts';
import { handleEspacePartenaire, handlePartenairesPublic, PARTNER_SPACE_FILES } from '../src/partenaires.ts';

// Tout est inventé : jeton, bien, agent.
const TOKEN = 'abcdefghijklmnopqrstuvwxyzabcdef';
const NO_DB = null as never;
const N = ' ';
const S = ' ';
const LISTING: PageInput = {
  payload: {
    reference: 'REF-D-1',
    version: 1,
    state: 'en_vente',
    title: 'Maison 5 pièces à Talant',
    body: 'Un jardin clos.\nTrois chambres.',
    mentions: `Prix : 320${S}000${N}€ honoraires inclus.\nClasse énergie D, classe climat B. Logement à consommation énergétique moyenne.\nCarte professionnelle n° CPI 0000.`,
    priceEur: 320000,
    media: [],
  },
  agent: { firstName: 'Alex', lastName: 'Exemple', phone: '03 00 00 00 00', email: 'alex@exemple.test' },
  photos: [{ ref: 'biens/b1/0b6f1d2e-1111-4a2b-8c3d-000000000001.jpg', kind: 'photo', overlay: 'Aménagement virtuel' }],
};

const text = async (r: Response | null): Promise<string> => {
  expect(r).not.toBeNull();
  return r!.text();
};

/**
 * Chaque écran d'AIMMO, tel que le navigateur le reçoit. Un fichier source qui pose une feuille de style doit être sur la
 * liste `STYLED` du contrôle des sources, et ses écrans ici. La page d'avis, qui demande une base, est contrôlée dans
 * `apres-vente-routes.test.ts` ; le carnet a le même cadre `renderPublicPage`.
 */
async function screens(): Promise<{ name: string; html: string; css?: string; js?: string; print?: boolean; budget: { gzipBytes: number } }[]> {
  const get = (path: string) => new Request(`https://aimmo.example.test${path}`);
  return [
    { name: 'application de l’agent', html: AGENT_APP_FILES['/app/']!, css: AGENT_APP_FILES['/app/app.css']!, js: AGENT_APP_FILES['/app/app.js']!, budget: BUDGETS.application },
    { name: 'espace partenaire', html: PARTNER_SPACE_FILES['/partenaire/']!, css: PARTNER_SPACE_FILES['/partenaire/partenaire.css']!, js: PARTNER_SPACE_FILES['/partenaire/partenaire.js']!, budget: BUDGETS.application },
    { name: 'candidature', html: await text(await handleCandidature(get('/rejoindre'), { db: NO_DB, networkId: 'n1' })), budget: BUDGETS.page },
    { name: 'candidature pas encore ouverte', html: await text(await handleCandidature(get('/rejoindre'), { db: NO_DB, networkId: null })), budget: BUDGETS.page },
    {
      name: 'liste des agents',
      // Une page pleine, chaque agent différent : des noms et des numéros qui se compressent mal, inventés.
      html: renderAgentsList(Array.from({ length: 500 }, (_, i) => ({ agentId: `a${i}`, name: `${(i * 7919).toString(36)} ${(i * 104729).toString(36)}`, zone: `Zone ${(i * 31).toString(36)}`, mentions: { rsacNumber: String(100000000 + i * 1299709), rsacRegistry: 'Dijon', cardNumber: 'CPI 0000', cardHolder: 'Société Exemple' } })))!,
      budget: BUDGETS.page,
    },
    { name: 'liste des communes', html: renderPricesList(Array.from({ length: 2000 }, (_, i) => { const n = (i * 7919 + 100000).toString(36); return { slug: `v${n}`, name: `Ville ${n}` }; }))!, budget: BUDGETS.page },
    { name: 'mentions légales', html: withLegalLinks(renderLegalNotice({ values: {}, cardNumber: null, cardHolder: null, missing: ['x'] })), budget: BUDGETS.page },
    { name: 'données personnelles', html: withLegalLinks(renderPrivacyPage({ values: {}, cardNumber: null, cardHolder: null, missing: ['x'] })), budget: BUDGETS.page },
    { name: 'estimation en ligne', html: renderEstimationPage({ visitorId: 'visite-0000000000000001', open: true, appointmentHref: '/agents' }), budget: BUDGETS.page },
    {
      name: 'estimation en ligne, sa fourchette',
      html: renderEstimationPage({ visitorId: 'visite-0000000000000001', open: true, appointmentHref: '/agents', values: { postalCode: '21990', town: 'Ville-Test', kind: 'maison' }, result: { ok: true, value: { town: 'Ville-Test', postalCode: '21990', kind: 'house', perM2: { low: 2000, median: 2500, high: 3000 }, sales: 24, period: { from: '2024-01', to: '2024-12' }, data: { lastSale: '2025-12-30', source: 'DVF test', recentMissing: true }, next: 'appointment' } } }),
      budget: BUDGETS.page,
    },
    { name: 'accueil du réseau', html: renderSiteHome({ kind: 'reseau', recruiting: true, agent: null, listings: [], checkedAt: new Date(0) }), budget: BUDGETS.page },
    { name: 'accueil du site d’un agent', html: renderSiteHome({ kind: 'agent', recruiting: false, agent: { agentId: 'a1', name: 'Alex Exemple', mentions: { rsacNumber: '123 456 789', rsacRegistry: 'Dijon', cardNumber: 'CPI 0000', cardHolder: 'Société Exemple' } }, listings: [], checkedAt: new Date(0) }), budget: BUDGETS.page },
    { name: 'page du bien', html: renderListingPage(LISTING), budget: BUDGETS.page },
    { name: 'page du bien retiré', html: renderListingPage({ ...LISTING, payload: { ...LISTING.payload, state: 'retiree' } }), budget: BUDGETS.page },
    { name: 'fiche imprimable', html: renderListingPrint(LISTING)!, print: true, budget: BUDGETS.page },
    {
      name: 'avis de valeur imprimable',
      html: renderValuationPrint({
        low: 180000,
        high: 200000,
        validatedOn: '2026-11-02',
        text: 'Pour votre appartement, nous estimons la valeur entre 180 000 € et 200 000 €.\n\nCet avis de valeur n’est pas une expertise.',
        facts: { medianPerM2: 2800, comparables: 12, radius: 500, cited: [{ month: '2025-06', surface: 62, pricePerM2: 2750, distance: 120, street: 'Rue de l’Essai', town: 'Dijon' }], adjustments: [{ label: 'Balcon', pct: 2 }] },
        agent: LISTING.agent!,
      }),
      print: true,
      budget: BUDGETS.page,
    },
    { name: 'document à signer', html: renderDocument('Mandat {{bien.reference}}', { 'bien.reference': null }, { title: 'Mandat', trial: true }), print: true, budget: BUDGETS.page },
    { name: 'désinscription des alertes', html: await text(await handleUnsubscribe(get(`/alertes/desinscription/${TOKEN}`), { db: NO_DB })), budget: BUDGETS.page },
    { name: 'opposition à la prospection', html: await text(await handlePartenairesPublic(get(`/partenaires/opposition/${TOKEN}`), { db: NO_DB })), budget: BUDGETS.page },
    { name: 'lien inconnu', html: await text(await handlePartenairesPublic(get('/partenaires/opposition/court'), { db: NO_DB })), budget: BUDGETS.page },
    {
      name: 'dossier de présentation',
      html: renderDossier(
        {
          generatedAt: '2027-10-12T08:00:00.000Z',
          period: { from: '2026-10-12', to: '2027-10-12' },
          welcome: DEFAULT_WELCOME,
          welcomeBy: 'code',
          sales: { source: 'DVF test', latestUsedSale: '2027-03', recentMissing: true, dvfNotCovered: false, validatedOn: '2027-10-07', items: [{ month: '2027-03', surfaceM2: 85, pricePerM2: 2900, distanceM: 200 }] },
          plan: SALE_PLAN,
          commitments: [{ code: 'cr', version: 1, label: 'Un compte rendu après chaque visite', rule: 'Règle de test.', delayHours: 24, kept: 3, total: 4, rate: 0.75, proof: [{ day: '2027-09-01', kept: true }] }],
          reviews: { link: 'https://g.page/r/exemple/review', source: 'Réponses de test', count: 1, average: 5, answers: [{ day: '2027-09-02', score: 5 }] },
          results: { source: 'Base de test', mandates: 2, sales: 1, estimationsHonored: 4 },
        },
        'Alex Exemple',
      ),
      budget: BUDGETS.page,
    },
    { name: 'lettres de quartier', html: renderLetters('au_proprietaire', letterFallback('mandat', 'Dijon'), 'Alex Exemple', [{ number: '10', street: 'rue des Essais', postcode: '21000', city: 'Dijon' }, { number: '12', street: 'rue des Essais', postcode: '21000', city: 'Dijon' }]), print: true, budget: BUDGETS.page },
    {
      name: 'certificat de photo',
      html: renderCertificatePage({ token: TOKEN, issuedOn: '2027-10-14', resultSha256: 'b'.repeat(64), originalSha256: 'a'.repeat(64), originalKept: true, localEdits: 'aucune', retouches: [], retouchMention: null, corrections: [{ op: 'exposition', label: 'Exposition', detail: 'Exposition : +0,5 IL' }], virtualStaging: false, mention: null, statement: 'Corrigée sur toute l’image : exposition.', path: `/certificat-photo/${TOKEN}` }),
      budget: BUDGETS.page,
    },
    { name: 'désinscription après la vente', html: await text(await handleApresVentePublic(get(`/apres-vente/desinscription/${TOKEN}`), { db: NO_DB })), budget: BUDGETS.page },
  ];
}

describe('Z03 · système de design d’AIMMO', () => {
  it('[R201] chaque paire texte et fond du système se lit (4,5 au moins), en clair comme en sombre', () => {
    for (const theme of ['clair', 'sombre'] as const) {
      const t: Readonly<Record<Teinte, string>> = PALETTE[theme];
      for (const [fg, bg] of PAIRES_TEXTE) expect(contrastRatio(t[fg], t[bg]), `${theme} : ${fg} sur ${bg}`).toBeGreaterThanOrEqual(4.5);
      for (const [fg, bg] of PAIRES_TRAIT) expect(contrastRatio(t[fg], t[bg]), `${theme} : ${fg} contre ${bg}`).toBeGreaterThanOrEqual(3);
    }
    // Le calcul lui-même, sur les cas connus.
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrastRatio('#777777', '#ffffff')).toBeCloseTo(4.48, 2);
  });

  it('[R201] chaque écran passe le contrôle d’accessibilité automatique', async () => {
    for (const s of await screens()) expect(htmlProblems(s.html, s.print ? { print: true } : {}), s.name).toEqual([]);
  });

  it('[R201] chaque écran tient son budget de performance, sans rien d’extérieur', async () => {
    for (const s of await screens()) expect(budgetProblems(s, s.budget), s.name).toEqual([]);
  });

  it('[R201] aucun écran en dehors du système de design : sa base d’abord, puis seulement des jetons', async () => {
    for (const s of await screens()) {
      const sheets = [...(s.css ? [s.css] : []), ...[...s.html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1]!)];
      expect(sheets.length, s.name).toBeGreaterThan(0);
      for (const css of sheets) {
        expect(screenCssProblems(css), s.name).toEqual([]);
        expect(css.startsWith(s.print ? PRINT_DESIGN_CSS : DESIGN_CSS), s.name).toBe(true);
      }
      // La marque et la frise des tuiles, sur tout écran qui n'est pas une feuille à imprimer.
      if (!s.print) expect(s.html, s.name).toMatch(/class="marque"/);
    }
  });

  it('[R201] aucune couleur, police ni feuille de style écrite hors du système, dans aucun fichier source', () => {
    const roots = ['packages/core/src', 'packages/api/src', 'packages/api/app'].map((r) => join(__dirname, '..', '..', '..', r));
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (path.endsWith('.ts')) files.push(path);
      }
    };
    roots.forEach(walk);
    expect(files.length).toBeGreaterThan(50);
    // Les seuls fichiers qui posent une feuille dans une page, et le nom de la feuille qu'ils posent.
    const STYLED: Record<string, RegExp> = {
      'core/src/design/systeme.ts': /^<style>\$\{DESIGN_CSS\}\$\{PUBLIC_PAGE_CSS\}<\/style>$/,
      'core/src/attirer/page-prix.ts': /^<style>\$\{CSS\}<\/style>$/,
      'core/src/attirer/quartier.ts': /^<style>\$\{CSS\}<\/style>$/,
      'core/src/annonces/page-bien.ts': /^<style>\$\{(?:CSS|PRINT_CSS)\}<\/style>$/,
      'core/src/attirer/page-agent.ts': /^<style>\$\{CSS\}<\/style>$/,
      'core/src/attirer/liste-biens.ts': /^<style>\$\{CSS\}<\/style>$/,
      'core/src/attirer/accueil-site.ts': /^<style>\$\{CSS\}<\/style>$/,
      'core/src/attirer/annuaire-site.ts': /^<style>\$\{CSS\}<\/style>$/,
      'core/src/attirer/page-estimation.ts': /^<style>\$\{CSS\}<\/style>$/,
      'core/src/attirer/mentions-site.ts': /^<style>\$\{CSS\}<\/style>$/,
      'core/src/documents/modeles.ts': /^<style>\$\{PRINT_CSS\}<\/style>$/,
      'api/src/candidature.ts': /^<style>\$\{STYLE\}<\/style>$/,
      'core/src/attirer/simulateur-pret.ts': /^<style>\$\{CSS\}<\/style>$/,
      'core/src/mandats/gagner/lettres-quartier.ts': /^<style>\$\{LETTER_CSS\}<\/style>$/,
      'core/src/mandats/gagner/dossier-presentation.ts': /^<style>\$\{DOSSIER_CSS\}<\/style>$/,
      'core/src/studio/supports.ts': /^<style>\$\{style\}<\/style>$/,
      'core/src/boutique/supports.ts': /^<style>\$\{style\}<\/style>$/,
      'core/src/estimation/avis-imprime.ts': /^<style>\$\{CSS\}<\/style>$/,
      'core/src/recherche/vitrine.ts': /^<style>\$\{CSS\}<\/style>$/,
      'core/src/recherche/page-publique.ts': /^<style>\$\{CSS\}<\/style>$/,
      'core/src/presentation/presentation.ts': /^<style>\$\{CSS\}<\/style>$/,
      'core/src/medias/visite-distance.ts': /^<style>\$\{CSS\}<\/style>$/,
      'core/src/marketing/lettre.ts': /^<style>\$\{MAGAZINE_CSS\}<\/style>$/,
    };
    const offenders: string[] = [];
    for (const f of files) {
      const rel = f.replace(/\\/g, '/').split('/packages/')[1]!;
      // Le contrôle lui-même cite ce qu'il cherche.
      if (rel === 'core/src/design/audit.ts') continue;
      const source = readFileSync(f, 'utf8');
      if (rel !== 'core/src/design/systeme.ts' && /#[0-9a-fA-F]{6}\b|\b(?:rgba?|hsla?)\(\s*\d/.test(source)) offenders.push(`${rel} : couleur`);
      if (/\sstyle\s*=\s*["'$]/.test(source)) offenders.push(`${rel} : style en ligne`);
      const sheets = [...source.matchAll(/<style\b[^>]*>[^<]*<\/style>/g)].map((m) => m[0]);
      for (const sheet of sheets) if (!STYLED[rel]?.test(sheet)) offenders.push(`${rel} : feuille ${sheet.slice(0, 40)}`);
      // Une balise ouverte sans sa fermeture sur place ne se contrôle pas : refusée.
      if ((source.match(/<style\b/g) ?? []).length !== sheets.length) offenders.push(`${rel} : feuille non contrôlable`);
    }
    // Les feuilles posées par ces fichiers commencent bien par la base : c'est le test « aucun écran en dehors ».
    expect(offenders).toEqual([]);
  });

  it('[R201] le contrôle attrape ce qu’il doit attraper', () => {
    // Une couleur, une police, un mouvement ou un chargement à soi : refusés.
    expect(localCssProblems('a{color:#ff0000}')).toHaveLength(1);
    expect(localCssProblems('a{color:white}')).toHaveLength(1);
    expect(localCssProblems('a{background:rgb(1,2,3)}')).toHaveLength(1);
    expect(localCssProblems('a{font-family:Arial}')).toHaveLength(1);
    expect(localCssProblems('a{font:600 1rem/1 Georgia,serif}')).toHaveLength(1);
    expect(localCssProblems('a{transition:all 1s}')).toHaveLength(1);
    expect(localCssProblems('a{color:crimson}')).toHaveLength(1);
    expect(localCssProblems('a{border:1px solid tomato}')).toHaveLength(1);
    expect(localCssProblems('a{background-color:ButtonText}')).toHaveLength(1);
    expect(localCssProblems('a{transition-duration:2s;transition-property:all}')).toHaveLength(2);
    expect(localCssProblems('a{animation-name:x}@keyframes x{from{opacity:0}}')).toHaveLength(2);
    expect(localCssProblems('a{font:1rem var(--police-titre),Comic Sans MS}')).toHaveLength(1);
    expect(localCssProblems('a{font-family:"Comic Sans MS"}')).toHaveLength(1);
    expect(localCssProblems('a{border-top:2px solid var(--encre);box-shadow:inset 4px 0 0 var(--danger);background:transparent}')).toEqual([]);
    expect(localCssProblems('@import "x.css";')).toHaveLength(1);
    expect(localCssProblems('a{color:var(--accent);font:600 var(--t-m)/1 var(--police-titre)}')).toEqual([]);
    expect(screenCssProblems('body{color:var(--encre)}')).toEqual(['la feuille ne commence pas par la base du système de design']);
    // Une page qui oublie une étiquette, un nom de bouton, un texte d'image, ou qui bloque le zoom.
    const page = (body: string, viewport = 'width=device-width, initial-scale=1') =>
      `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="${viewport}"><title>t</title><style>${DESIGN_CSS}</style></head><body><h1>t</h1>${body}</body></html>`;
    expect(htmlProblems(page('<label for="a">A</label><input id="a"><button>OK</button><img src="/x.png" alt="">'))).toEqual([]);
    expect(htmlProblems(page('<input id="a">'))).toEqual(['champ sans étiquette : <input id="a">']);
    expect(htmlProblems(page('<label>Note <input type="radio" name="n"></label>'))).toEqual([]);
    expect(htmlProblems(page('<button></button>'))).toHaveLength(1);
    expect(htmlProblems(page('<img src="/x.png">'))).toHaveLength(1);
    expect(htmlProblems(page('<h3>saut</h3>'))).toEqual(['titre qui saute un niveau : h1 puis h3']);
    expect(htmlProblems(page('<p style="color:red">x</p>'))).toEqual(['style en ligne, hors système de design']);
    expect(htmlProblems(page('', 'width=device-width, user-scalable=no'))).toEqual(['le zoom est bloqué']);
    expect(htmlProblems(page('<p id="x"></p><p id="x"></p>'))).toEqual(['identifiant en double : x']);
    // Une feuille glissée avec un attribut est contrôlée aussi.
    expect(htmlProblems(page('<style media="all">a{color:red}</style>'))).toEqual(['la feuille ne commence pas par la base du système de design']);
    // Le budget : trop lourd, ou une police d'ailleurs.
    expect(budgetProblems({ html: page('<link rel="stylesheet" href="https://polices.example.test/x.css">') }, BUDGETS.page)).toEqual(['ressource extérieure : https://polices.example.test/x.css']);
    const heavy = Array.from({ length: 6000 }, (_, i) => `<p>${(i * 7919).toString(36)}${Math.sin(i)}</p>`).join('');
    expect(budgetProblems({ html: page(heavy) }, BUDGETS.page)[0]).toMatch(/^trop lourd/);
  });

  it('[R201] les pages publiques courtes ont un seul cadre : marque, frise, carte, titre échappé', () => {
    const html = renderPublicPage({ title: 'Titre <b>', body: '<p>Corps</p>', kicker: 'Après la vente' });
    expect(html).toContain('<h1>Titre &lt;b&gt;</h1>');
    expect(html).toContain('<div class="frise" aria-hidden="true"></div>');
    expect(html).toContain('<meta name="robots" content="noindex">');
    expect(htmlProblems(html)).toEqual([]);
  });

  it('[R201] la marque de l’application et de l’espace partenaire suit le système : couleur du navigateur, icône', () => {
    expect(AGENT_APP_FILES['/app/']).toContain(`<meta name="theme-color" content="${PALETTE.clair.papier}">`);
    expect(JSON.parse(AGENT_APP_FILES['/app/manifest.webmanifest']!)).toMatchObject({ theme_color: PALETTE.clair.papier, background_color: PALETTE.clair.papier });
    expect(AGENT_APP_FILES['/app/icon.svg']).toContain(PALETTE.clair.accent);
    expect(PARTNER_SPACE_FILES['/partenaire/']).toContain(`<meta name="theme-color" content="${PALETTE.clair.papier}">`);
    // L'espace partenaire reste servi tel quel.
    expect(handleEspacePartenaire(new Request('https://aimmo.example.test/partenaire/partenaire.css'))!.status).toBe(200);
  });
});
