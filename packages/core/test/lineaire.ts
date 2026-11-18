import { expect } from 'vitest';

// Vérifie qu'une lecture reste linéaire sans dépendre de la vitesse de la machine.
// On mesure le texte entier et son quart, au meilleur de trois essais :
// une lecture linéaire coûte environ 4 fois plus, une lecture quadratique environ 16 fois.
// Un plafond large en millisecondes attrape en plus tout emballement (retour arrière explosif).
export function expectLinear(build: (size: number) => string, read: (text: string) => void, size = 40_000): void {
  const best = (text: string): number => {
    let min = Infinity;
    for (let i = 0; i < 3; i++) {
      const t0 = performance.now();
      read(text);
      min = Math.min(min, performance.now() - t0);
    }
    return min;
  };
  const full = build(size);
  const quarter = build(size / 4);
  expect(full.length).toBeGreaterThanOrEqual(size);
  read(quarter); // chauffe
  const tQuarter = best(quarter);
  const tFull = best(full);
  expect(tFull).toBeLessThan(5_000);
  // Sous 50 ms, la mesure est trop fine pour un rapport fiable : c'est rapide, donc linéaire en pratique.
  if (tFull > 50) expect(tFull / Math.max(tQuarter, 1)).toBeLessThan(10);
}
