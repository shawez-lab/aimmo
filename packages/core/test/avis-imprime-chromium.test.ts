import { createRequire } from 'node:module';
import { afterAll, describe, expect, it } from 'vitest';
import { renderValuationPrint, type ValuationPrintInput } from '../src/estimation/avis-imprime.ts';

/**
 * L'impression de l'avis de valeur vérifiée dans Chromium (DS084) : le nombre de pages et la couverture. Chromium n'est
 * pas une dépendance du dépôt : ce test tourne là où Playwright et son navigateur sont installés, et se signale sauté
 * ailleurs.
 */
type Browser = { newPage(): Promise<any>; close(): Promise<void> };
async function launch(): Promise<Browser | null> {
  try {
    const { chromium } = createRequire(import.meta.url)('playwright') as { chromium: { launch(): Promise<Browser> } };
    return await chromium.launch();
  } catch {
    return null;
  }
}
const browser = await launch();
afterAll(async () => {
  await browser?.close();
});
const N = '\u202f';

// DS084 · l'avis de valeur : une couverture, puis le texte et les ventes. Tout est inventé.
const SALE = { month: '2026-01', surface: 62, pricePerM2: 3540, distance: 80, street: 'Rue de l’Essai', town: 'Dijon' };
const NOTICE: ValuationPrintInput = {
  low: 1285000,
  high: 1305000,
  validatedOn: '2026-11-02',
  text: `Pour votre appartement, nous estimons la valeur entre 1${N}285${N}000 € et 1${N}305${N}000 €.\n\nCet avis de valeur n’est pas une expertise.`,
  facts: { medianPerM2: 3720, comparables: 14, radius: 600, cited: [], adjustments: [] },
  agent: { firstName: 'Alexandrine-Marie', lastName: 'Exemple de la Fontaine-Inventée', phone: '03 00 00 00 00', email: 'alexandrine-marie.exemple@agence-inventee.exemple.test' },
};
const sales = (count: number) => ({ ...NOTICE, facts: { ...NOTICE.facts, comparables: count, cited: Array.from({ length: count }, (_, i) => ({ ...SALE, distance: 60 + i * 20 })), adjustments: [{ label: 'Balcon', pct: 2 }] } });

describe.skipIf(browser === null)('DS084 · l’avis de valeur sous Chromium', () => {
  const pagesOf = async (html: string): Promise<number> => {
    const page = await browser!.newPage();
    try {
      await page.setContent(html, { waitUntil: 'load' });
      const pdf: Buffer = await page.pdf({ preferCSSPageSize: true, printBackground: true });
      return (pdf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) ?? []).length;
    } finally {
      await page.close();
    }
  };

  it('la couverture prend une page, jamais deux : deux pages pour un avis court, deux avec huit ventes, trois avec quarante', async () => {
    expect(await pagesOf(renderValuationPrint(NOTICE))).toBe(2);
    expect(await pagesOf(renderValuationPrint(sales(8)))).toBe(2);
    expect(await pagesOf(renderValuationPrint(sales(40)))).toBe(3);
  });

  it('à l’impression, l’agent est au pied de la couverture et la fourchette, même à sept chiffres, reste dans la feuille', async () => {
    const page = await browser!.newPage();
    try {
      // La zone imprimable d'une feuille A4 avec des marges de 16 mm : 178 mm de large.
      await page.setViewportSize({ width: Math.round((178 * 96) / 25.4), height: 1000 });
      await page.emulateMedia({ media: 'print' });
      await page.setContent(renderValuationPrint(sales(8)), { waitUntil: 'load' });
      const seen = await page.evaluate(() => {
        const d = (globalThis as any).document;
        const box = (s: string) => d.querySelector(s).getBoundingClientRect();
        const px = (s: string) => parseFloat((globalThis as any).getComputedStyle(d.querySelector(s)).fontSize);
        return { cover: box('.couverture'), agent: box('.agent'), price: box('.prix'), priceWidth: d.querySelector('.prix').scrollWidth, text: box('.texte'), priceSize: px('.prix'), titleSize: px('h1'), wide: d.documentElement.scrollWidth > (globalThis as any).innerWidth };
      });
      const mm = (pxValue: number): number => (pxValue * 25.4) / 96;
      expect(mm(seen.cover.height)).toBeGreaterThan(240);
      expect(mm(seen.cover.height)).toBeLessThan(265);
      expect(Math.abs(seen.agent.bottom - seen.cover.bottom)).toBeLessThan(1);
      expect(seen.agent.top).toBeGreaterThan(seen.price.bottom);
      expect(seen.text.top).toBeGreaterThanOrEqual(seen.cover.bottom);
      expect(seen.priceSize).toBeGreaterThanOrEqual(2 * seen.titleSize);
      // Sur une seule ligne, sans dépasser la feuille : aucun montant n'est coupé.
      expect(seen.price.height).toBeLessThan(1.5 * seen.priceSize);
      expect(seen.priceWidth).toBeLessThanOrEqual(seen.cover.width);
      expect(seen.wide).toBe(false);
    } finally {
      await page.close();
    }
  });

  it('à l’écran d’un téléphone, avant d’imprimer : un montant par ligne, jamais coupé, et rien ne déborde', async () => {
    const page = await browser!.newPage();
    try {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.setContent(renderValuationPrint(sales(8)), { waitUntil: 'load' });
      const seen = await page.evaluate(() => {
        const d = (globalThis as any).document;
        const price = d.querySelector('.prix');
        const size = parseFloat((globalThis as any).getComputedStyle(price).fontSize);
        return { lines: Math.round(price.getBoundingClientRect().height / (size * 1.1)), priceWide: price.scrollWidth > price.clientWidth, left: d.querySelector('.texte').getBoundingClientRect().left };
      });
      // Trois lignes : un montant, « à », l'autre montant.
      expect(seen.lines).toBeLessThanOrEqual(3);
      expect(seen.priceWide).toBe(false);
      // Le texte ne touche plus le bord de l'écran.
      expect(seen.left).toBeGreaterThanOrEqual(12);
    } finally {
      await page.close();
    }
  });
});
