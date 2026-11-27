import { renderSlipSignPage } from '../src/bon-visite-public.ts';
import { renderSlipCopy } from '../../core/src/visites/signature-bon.ts';
import { renderValuationPrint } from '@aimmo/core';
import { renderLegalNotice, renderPrivacyPage, withLegalLinks } from '../../core/src/attirer/mentions-site.ts';
import { renderEstimationPage } from '../../core/src/attirer/page-estimation.ts';
import { renderSiteHome } from '../../core/src/attirer/accueil-site.ts';
import { renderAgentsList, renderPricesList } from '../../core/src/attirer/annuaire-site.ts';
import { renderListingPage, renderListingPrint, type PageInput } from '../../core/src/annonces/page-bien.ts';
import { BUDGETS } from '../../core/src/design/audit.ts';
import { renderDocument } from '../../core/src/documents/modeles.ts';
import { letterFallback, renderLetters } from '../../core/src/mandats/gagner/lettres-quartier.ts';
import { DEFAULT_WELCOME, SALE_PLAN, renderDossier } from '../../core/src/mandats/gagner/dossier-presentation.ts';
import { AGENT_APP_FILES } from '../src/agent-app.ts';
import { handleUnsubscribe } from '../src/alertes.ts';
import { handleApresVentePublic } from '../src/apres-vente.ts';
import { handleCandidature } from '../src/candidature.ts';
import { renderCertificatePage } from '../src/certificat-photo.ts';
import { handlePartenairesPublic, PARTNER_SPACE_FILES } from '../src/partenaires.ts';

/**
 * Les écrans d'AIMMO, rendus avec des jeux inventés : la liste que lisent les contrôles du système de design
 * (`design.test.ts`) et les captures rejouables (`captures.test.ts`, DS086). Un écran ajouté ici est contrôlé et
 * capturé du même coup.
 */
export interface Ecran {
  name: string;
  html: string;
  css?: string;
  js?: string;
  print?: boolean;
  budget: { gzipBytes: number };
}

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
  if (!r) throw new Error('écran absent : la route n’a rien rendu');
  return r.text();
};

/**
 * Chaque écran d'AIMMO, tel que le navigateur le reçoit. Un fichier source qui pose une feuille de style doit être sur la
 * liste `STYLED` du contrôle des sources, et ses écrans ici. La page d'avis, qui demande une base, est contrôlée dans
 * `apres-vente-routes.test.ts` ; le carnet a le même cadre `renderPublicPage`.
 */
export async function screens(): Promise<Ecran[]> {
  const get = (path: string) => new Request(`https://aimmo.example.test${path}`);
  return [
    { name: 'application de l’agent', html: AGENT_APP_FILES['/app/']!, css: AGENT_APP_FILES['/app/app.css']!, js: AGENT_APP_FILES['/app/app.js']!, budget: BUDGETS.application },
    // DS069 · la page de la direction, avec l'écran du réseau : elle passe les mêmes contrôles.
    { name: 'application, page de la direction', html: AGENT_APP_FILES['/app/reseau']!, css: AGENT_APP_FILES['/app/app.css']!, js: AGENT_APP_FILES['/app/app.js']!, budget: Object.freeze({ gzipBytes: BUDGETS.application.gzipBytes + BUDGETS.page.gzipBytes }) },
    { name: 'espace partenaire', html: PARTNER_SPACE_FILES['/partenaire/']!, css: PARTNER_SPACE_FILES['/partenaire/partenaire.css']!, js: PARTNER_SPACE_FILES['/partenaire/partenaire.js']!, budget: BUDGETS.application },
    { name: 'candidature', html: await text(await handleCandidature(get('/rejoindre'), { db: NO_DB, networkId: 'n1' })), budget: BUDGETS.page },
    { name: 'candidature pas encore ouverte', html: await text(await handleCandidature(get('/rejoindre'), { db: NO_DB, networkId: null })), budget: BUDGETS.page },
    {
      name: 'liste des agents',
      // Une page pleine, chaque agent différent : des noms et des numéros qui se compressent mal, inventés, rangés par lettre comme la liste les reçoit.
      html: renderAgentsList(Array.from({ length: 500 }, (_, i) => { const last = `${String.fromCharCode(97 + Math.floor(i / 20))}${(i * 104729).toString(36)}`; return { agentId: `a${i}`, name: `${(i * 7919).toString(36)} ${last}`, lastName: last, zone: `Zone ${(i * 31).toString(36)}`, mentions: { rsacNumber: String(100000000 + i * 1299709), rsacRegistry: 'Dijon', cardNumber: 'CPI 0000', cardHolder: 'Société Exemple' } }; }))!,
      budget: BUDGETS.page,
    },
    { name: 'liste des communes', html: renderPricesList(Array.from({ length: 2000 }, (_, i) => { const n = (i * 7919 + 100000).toString(36); return { slug: `v${n}`, name: `Ville ${n}` }; }))!, budget: BUDGETS.page },
    { name: 'mentions légales', html: withLegalLinks(renderLegalNotice({ values: {}, cardNumber: null, cardHolder: null, missing: ['x'], launchClosedBy: [] })), budget: BUDGETS.page },
    { name: 'données personnelles', html: withLegalLinks(renderPrivacyPage({ values: {}, cardNumber: null, cardHolder: null, missing: ['x'], launchClosedBy: [] })), budget: BUDGETS.page },
    { name: 'estimation en ligne', html: renderEstimationPage({ visitorId: 'visite-0000000000000001', open: true, appointmentHref: '/agents' }), budget: BUDGETS.page },
    {
      name: 'estimation en ligne, sa fourchette',
      html: renderEstimationPage({ visitorId: 'visite-0000000000000001', open: true, appointmentHref: '/agents', values: { postalCode: '21990', town: 'Ville-Test', kind: 'maison' }, result: { ok: true, value: { town: 'Ville-Test', postalCode: '21990', kind: 'house', perM2: { low: 2000, median: 2500, high: 3000 }, sales: 24, period: { from: '2024-01', to: '2024-12' }, data: { lastSale: '2025-12-30', source: 'DVF test', recentMissing: true }, next: 'appointment' } } }),
      budget: BUDGETS.page,
    },
    { name: 'accueil du réseau', html: renderSiteHome({ kind: 'reseau', recruiting: true, agent: null, listings: [], checkedAt: new Date(0) }), budget: BUDGETS.page },
    { name: 'accueil du site d’un agent', html: renderSiteHome({ kind: 'agent', recruiting: false, agent: { agentId: 'a1', name: 'Alex Exemple', mentions: { rsacNumber: '123 456 789', rsacRegistry: 'Dijon', cardNumber: 'CPI 0000', cardHolder: 'Société Exemple' } }, listings: [], checkedAt: new Date(0) }), budget: BUDGETS.page },
    { name: 'page du bien', html: renderListingPage(LISTING), budget: BUDGETS.page },
    // AU075b · le bon de visite à signer à distance, puis l'exemplaire signé : sans script, dans le système de design.
    { name: 'bon de visite à signer', html: renderSlipSignPage({ action: '/visite/signer/' + 'a'.repeat(64), paragraphs: ['DOCUMENT D’ESSAI.', 'Bon de visite : Inès Exemple visite REF-T-1.'], slipHash: 'f'.repeat(64), error: 'Code faux.' }), budget: BUDGETS.page },
    {
      name: 'exemplaire du bon de visite',
      html: renderSlipCopy('<!doctype html><html><body><p>Bon de visite : Inès Exemple visite REF-T-1.</p></body></html>', { appointmentId: 'v1', slipId: 's1', slipHash: 'f'.repeat(64), signedAt: '2027-03-03T15:00:00.000Z', place: 'distance', method: 'code', channel: 'sms', drawingHash: null, mode: 'essai', realSignature: false }),
      budget: BUDGETS.page,
    },
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
