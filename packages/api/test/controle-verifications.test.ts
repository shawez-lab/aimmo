import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
// @ts-expect-error script du depot, sans déclaration de types
import { DUREE_MESUREE_MINUTES, controleVerifications } from '../../../scripts/controle-verifications.mjs';

const racine = fileURLToPath(new URL('../../../', import.meta.url));
const lire = (chemin: string) => readFileSync(join(racine, chemin), 'utf8');
const reels = () => ({
  verifications: lire('.github/workflows/verifications.yml'),
  deploiement: lire('.github/workflows/deployer-api.yml'),
  attente: lire('scripts/attendre-verifications.mjs'),
});
const avec = (verifications: (texte: string) => string) => {
  const fichiers = reels();
  return controleVerifications({ ...fichiers, verifications: verifications(fichiers.verifications) }).join('\n');
};

describe('X28 · les vérifications tiennent dans leur délai', () => {
  it('les fichiers du dépôt passent le contrôle', () => {
    expect(controleVerifications(reels())).toEqual([]);
  });

  it('le délai laisse au moins 30 % de marge sur la durée mesurée', () => {
    const minutes = Number(reels().verifications.match(/timeout-minutes: (\d+)/)?.[1]);
    expect(minutes).toBeGreaterThanOrEqual(DUREE_MESUREE_MINUTES * 1.3);
    expect(avec((t) => t.replace(/timeout-minutes: \d+/, 'timeout-minutes: 15'))).toMatch(/délai de 15 minutes/);
  });

  it.each([
    ['les tests', 'run: npm test\n', 'run: echo rien\n'],
    ['les tests', 'run: npm test\n', 'run: npm test -- --exclude "packages/**"\n'],
    ['les types', 'run: npm run check\n', ''],
    ['les garde-fous', 'run: npm run garde-fous\n', ''],
    ['le paquet du Worker', 'deploy --dry-run', 'versions list'],
    ['l’installation', 'run: npm ci\n', ''],
  ])('une vérification retirée ou changée est refusée : %s', (nom, avant, apres) => {
    expect(avec((t) => t.replace(avant, apres))).toContain(nom);
  });

  it('garde-fous et paquet passent avant les tests, un retour en arrière est refusé', () => {
    const tests = '      - name: Tests\n        run: npm test\n';
    const remonte = (t: string) => t.replace(tests, '').replace('      - name: Garde-fous', `${tests}      - name: Garde-fous`);
    const erreurs = avec(remonte);
    expect(erreurs).toContain('les garde-fous doivent passer avant les tests');
    expect(erreurs).toContain('le paquet du Worker doivent passer avant les tests');
  });

  it.each([
    ['continue-on-error', (t: string) => t.replace('run: npm test', 'continue-on-error: true\n        run: npm test')],
    ['conditionnelle', (t: string) => t.replace('run: npm test', "if: github.ref == 'x'\n        run: npm test")],
    ['ignoré', (t: string) => t.replace('run: npm run check', 'run: npm run check || true\n      - run: npm run check')],
    ['sans filtre', (t: string) => t.replace('  pull_request:\n', "  pull_request:\n    paths: ['x']\n")],
  ])('un contrôle affaibli est refusé : %s', (mot, change) => {
    expect(avec(change)).toContain(mot);
  });

  it('le déploiement garde les trois contrôles, et sa marge', () => {
    const fichiers = reels();
    expect(controleVerifications({ ...fichiers, deploiement: fichiers.deploiement.replace('&& npm test', '') }).join()).toContain('deployer-api.yml');
    expect(controleVerifications({ ...fichiers, deploiement: fichiers.deploiement.replace(/timeout-minutes: \d+/, 'timeout-minutes: 15') }).join()).toContain('délai de 15 minutes');
  });

  it('l’attente de la séance dure plus que le délai du travail, pour ne pas lire une coupure comme une panne', () => {
    const fichiers = reels();
    expect(controleVerifications({ ...fichiers, attente: fichiers.attente.replace(/minutesFromNow\(30\)/, 'minutesFromNow(20)') }).join()).toContain('attendre-verifications.mjs');
  });

  describe('les garde-fous lancés dans un dépôt', () => {
    const depot = (changer: (t: string) => string) => {
      const dossier = mkdtempSync(join(tmpdir(), 'aimmo-x28-'));
      mkdirSync(join(dossier, '.github/workflows'), { recursive: true });
      mkdirSync(join(dossier, 'docs'));
      mkdirSync(join(dossier, 'scripts'));
      writeFileSync(join(dossier, 'docs/REGLES.md'), '# Règles\n');
      writeFileSync(join(dossier, '.github/workflows/verifications.yml'), changer(lire('.github/workflows/verifications.yml')));
      cpSync(join(racine, '.github/workflows/deployer-api.yml'), join(dossier, '.github/workflows/deployer-api.yml'));
      cpSync(join(racine, 'scripts/attendre-verifications.mjs'), join(dossier, 'scripts/attendre-verifications.mjs'));
      execFileSync('git', ['init', '-q'], { cwd: dossier });
      return spawnSync('node', [join(racine, 'scripts/garde-fous.mjs')], { cwd: dossier, encoding: 'utf8' });
    };

    it('passent sur le fichier du dépôt, et échouent quand les tests en sont retirés', () => {
      expect(depot((t) => t).status).toBe(0);
      const refus = depot((t) => t.replace('run: npm test\n', 'run: echo rien\n'));
      expect(refus.status).toBe(1);
      expect(refus.stderr).toContain('les tests manquent');
    });
  });
});
