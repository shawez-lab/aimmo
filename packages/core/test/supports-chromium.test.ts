import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { renderListingPrint, type PageInput } from '../src/annonces/index.ts';
import { printHeightMm } from '../src/annonces/page-bien.ts';
import { SUPPORT_SIZES, renderBusinessCard, renderFlyer, renderNeighbourhoodLetter, renderPanel } from '../src/studio/index.ts';

/**
 * L'impression des supports vérifiée dans Chromium (X06) : nombre de pages, rien hors de la feuille, rien sous la carte
 * de l'agent. Chromium n'est pas une dépendance du dépôt : ce test tourne là où Playwright et son navigateur sont
 * installés (séances de Claude), et se signale sauté ailleurs.
 */
type Browser = { newPage(): Promise<any>; close(): Promise<void> };
async function launch(): Promise<Browser | null> {
  try {
    const require = createRequire(import.meta.url);
    const { chromium } = require('playwright') as { chromium: { launch(): Promise<Browser> } };
    return await chromium.launch();
  } catch {
    return null;
  }
}
const browser = await launch();

// Le cas le plus long : titre long, mentions complètes et longues, coordonnées longues (tout inventé).
const N = ' ';
const S = ' ';
const LONG: PageInput = {
  payload: {
    reference: 'REF-T-LONG-2027',
    version: 1,
    state: 'en_vente',
    title: 'Appartement 4 pièces de 96 m² avec balcon, cave, ascenseur et stationnement, à Villebrune-sur-Essai',
    body: 'Balcon. '.repeat(300),
    mentions:
      `Prix : 210${S}000${N}€ honoraires inclus, soit 200${S}000${N}€ hors honoraires et 5${N}% TTC du prix hors honoraires, à la charge de l'acquéreur.\n` +
      `Classe énergie G, classe climat G. Logement à consommation énergétique excessive. Montant estimé des dépenses annuelles d'énergie pour un usage standard : entre 1${S}200${N}€ et 1${S}700${N}€ par an. Prix moyens des énergies indexés au 1er janvier 2025 (abonnements compris).\n` +
      `Bien en copropriété de 48 lots, charges annuelles moyennes de 2${S}400${N}€, aucune procédure en cours.\n` +
      `Les informations sur les risques auxquels ce bien est exposé sont disponibles sur le site Géorisques.\n` +
      `Carte professionnelle n° CPI 2101 2027 000 000 000, délivrée par la CCI de Côte-d'Or.`,
    priceEur: 210000,
    media: [],
  },
  agent: { firstName: 'Alexandrine-Marie', lastName: 'Fictive-Longuenom', phone: '+33 3 00 00 00 00', email: 'alexandrine-marie.fictive-longuenom@exemple.test' },
  photos: [
    { ref: 'biens/b1/0b6f1d2e-1111-4a2b-8c3d-000000000001.jpg', kind: 'photo', overlay: null },
    { ref: 'biens/b1/0b6f1d2e-2222-4a2b-8c3d-000000000002.jpg', kind: 'photo', overlay: 'Aménagement virtuel' },
    { ref: 'biens/b1/0b6f1d2e-3333-4a2b-8c3d-000000000003.jpg', kind: 'photo', overlay: null },
    { ref: 'biens/b1/0b6f1d2e-4444-4a2b-8c3d-000000000004.jpg', kind: 'photo', overlay: null },
  ],
};

const SHORT: PageInput = { ...LONG, payload: { ...LONG.payload, title: 'Maison 5 pièces avec jardin à Talant', body: 'Sur les hauteurs, une maison de 1962 rénovée en 2021. Séjour traversant sur jardin clos, plein sud. Trois chambres, garage, cave.' } };
// Le plus long texte que la fiche garde sur une feuille, écrit tout en capitales.
const tight = (n: number): PageInput => ({ ...SHORT, payload: { ...SHORT.payload, body: 'MAISON DE FAMILLE AVEC JARDIN CLOS ET GARAGE. '.repeat(80).slice(0, n).trim() } });
let fits = 100;
while (printHeightMm(tight(fits + 20)) <= 297) fits += 20;
const TIGHT = tight(fits);

describe.skipIf(browser === null)('X06 · impression sous Chromium', () => {
  const cases: [string, string, number][] = [
    ['panneau', renderPanel(LONG)!, 1],
    ['flyer', renderFlyer(LONG)!, 1],
    ['lettre_quartier', renderNeighbourhoodLetter(LONG)!, 1],
    ['carte_visite', renderBusinessCard(LONG.agent!), 1],
    ['fiche', renderListingPrint(LONG)!, 2],
    // DS083 · un texte court : une seule feuille. Et le cas le plus serré d'une feuille : tout en capitales, plus larges que prévu.
    ['fiche', renderListingPrint(SHORT)!, 1],
    ['fiche', renderListingPrint(TIGHT)!, 1],
  ];
  for (const [kind, html, pages] of cases) {
    it(`${kind} : ${pages} page(s), rien hors de la feuille, rien sous la carte de l’agent`, async () => {
      const page = await browser!.newPage();
      try {
        await page.setContent(html, { waitUntil: 'load' });
        const pdf: Buffer = await page.pdf({ preferCSSPageSize: true, printBackground: true });
        expect((pdf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) ?? []).length, kind).toBe(pages);
        const problems: string[] = await page.evaluate(() => {
          // Exécuté dans la page : le document y existe.
          const doc = (globalThis as any).document;
          const out: string[] = [];
          for (const sheet of Array.from(doc.querySelectorAll('.page')) as any[]) {
            const box = sheet.getBoundingClientRect();
            const all = Array.from(sheet.querySelectorAll('*')) as any[];
            for (const el of all) {
              const r = el.getBoundingClientRect();
              if (r.width === 0 && r.height === 0) continue;
              if (r.bottom > box.bottom + 0.5 || r.right > box.right + 0.5 || el.scrollHeight > el.clientHeight + 1) out.push(`hors de la feuille : ${el.className || el.tagName}`);
            }
            const agent = sheet.querySelector('.agent');
            if (!agent) continue;
            const a = agent.getBoundingClientRect();
            for (const el of all) {
              if (el === agent || agent.contains(el) || el.contains(agent)) continue;
              const r = el.getBoundingClientRect();
              if (r.width === 0 || r.height === 0) continue;
              if (r.bottom > a.top + 0.5 && r.top < a.bottom - 0.5 && r.right > a.left && r.left < a.right) out.push(`sous la carte de l'agent : ${el.className || el.tagName}`);
            }
          }
          return out;
        });
        expect(problems, kind).toEqual([]);
        // La taille de la feuille rendue est celle annoncée.
        const size = SUPPORT_SIZES[kind as keyof typeof SUPPORT_SIZES];
        const mm = await page.evaluate(() => {
          const r = (globalThis as any).document.querySelector('.page').getBoundingClientRect();
          return [Math.round((r.width * 25.4) / 96), Math.round((r.height * 25.4) / 96)];
        });
        expect(mm, kind).toEqual([size.widthMm, size.heightMm]);
      } finally {
        await page.close();
      }
    });
  }
  it('DS083 · sur une seule feuille, même la plus serrée : la photo garde 40 mm au moins, et l’agent est au pied', async () => {
    expect(TIGHT.payload.body!.length).toBeGreaterThan(300);
    expect(printHeightMm(tight(fits + 20))).toBeGreaterThan(297);
    for (const [name, input] of [['courte', SHORT], ['serrée', TIGHT]] as const) {
      const page = await browser!.newPage();
      try {
        await page.setContent(renderListingPrint(input)!, { waitUntil: 'load' });
        const seen = await page.evaluate(() => {
          const d = (globalThis as any).document;
          const mm = (px: number) => (px * 25.4) / 96;
          const sheet = d.querySelector('.page').getBoundingClientRect();
          const photo = d.querySelector('.photos li:first-child img').getBoundingClientRect();
          const agent = d.querySelector('.agent').getBoundingClientRect();
          return { sheets: d.querySelectorAll('.page').length, photoMm: mm(photo.height), agentFromBottomMm: mm(sheet.bottom - agent.bottom) };
        });
        expect(seen.sheets, name).toBe(1);
        expect(seen.photoMm, name).toBeGreaterThanOrEqual(40);
        expect(seen.agentFromBottomMm, name).toBeGreaterThanOrEqual(13);
        expect(seen.agentFromBottomMm, name).toBeLessThanOrEqual(16);
      } finally {
        await page.close();
      }
    }
  });

  it('ferme le navigateur', async () => {
    await browser!.close();
  });
});
