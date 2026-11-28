import { createRequire } from 'node:module';
import { afterAll, describe, expect, it } from 'vitest';
import { AGENT_APP_FILES } from '../src/agent-app.ts';

const CSS = AGENT_APP_FILES['/app/app.css']!;

/** Dans Chromium, là où Playwright et son navigateur sont installés : sinon l'essai se signale sauté. */
type Navigateur = { newPage(o?: object): Promise<any>; close(): Promise<void> };
async function lancer(): Promise<Navigateur | null> {
  try {
    const { chromium } = createRequire(import.meta.url)('playwright') as { chromium: { launch(): Promise<Navigateur> } };
    return await chromium.launch();
  } catch {
    return null;
  }
}
const navigateur = await lancer();
afterAll(async () => {
  await navigateur?.close();
});

describe('DS038 · un volet se reconnaît partout à son « + »', () => {
  it('une seule règle pour toute l’application, plus une par écran ; les lignes de chiffres n’ont pas de marque', () => {
    expect(CSS).toContain('summary::before { content: "+"; width: 1em; font-weight: 400; }');
    expect(CSS).toContain('details[open] > summary::before { content: "–"; }');
    // Aussi forte que la règle du volet ouvert, et écrite après elle : une ligne de chiffres dépliée n'a pas de « – » non plus.
    expect(CSS).toContain('details.chiffre > summary::before { content: none; }');
    expect(CSS.indexOf('details.chiffre > summary::before')).toBeGreaterThan(CSS.indexOf('details[open] > summary::before'));
    // Avant, la marque n'existait que sur la fiche, le mandat et la conformité : ailleurs, un volet fermé ressemblait à un intertitre.
    expect(CSS).not.toMatch(/#[a-z-]+ summary::before/);
  });

  it.skipIf(navigateur === null)('dans Chromium : « + » fermé, « – » ouvert, sur n’importe quel écran ; rien devant une ligne de chiffres', async () => {
    const page = await navigateur!.newPage({ viewport: { width: 390, height: 844 } });
    try {
      await page.setContent(
        `<style>${CSS}</style><main><section id="attirer"><details id="volet"><summary>Changer l’adresse du site du réseau</summary><p>Le formulaire.</p></details></section>` +
          `<section id="chiffres"><details class="chiffre" id="ligne"><summary><span>Ventes</span><span class="valeur">3</span></summary><ul><li>Une ligne</li></ul></details></section></main>`,
      );
      const mark = (id: string) => page.evaluate((i: string) => (globalThis as any).getComputedStyle((globalThis as any).document.querySelector(`#${i} > summary`), '::before').content, id);
      expect(await mark('volet')).toBe('"+"');
      await page.click('#volet > summary');
      expect(await page.evaluate(() => (globalThis as any).document.getElementById('volet').open)).toBe(true);
      expect(await mark('volet')).toBe('"–"');
      expect(await mark('ligne')).toBe('none');
      await page.click('#ligne > summary');
      expect(await mark('ligne')).toBe('none');
      // Le titre d'un volet se touche à la taille du doigt.
      expect(await page.evaluate(() => Math.round((globalThis as any).document.querySelector('#volet > summary').getBoundingClientRect().height))).toBeGreaterThanOrEqual(44);
    } finally {
      await page.close();
    }
  });
});
