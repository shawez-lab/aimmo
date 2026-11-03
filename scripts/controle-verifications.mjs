// X28 : ce que le fichier des vérifications doit garder. Lu par les garde-fous à chaque vérification,
// pour que personne ne retire un contrôle ni ne rapproche le délai de la durée réelle sans que cela se voie.

// Plus longue vérification réussie, mesurée sur les 100 dernières le 2026-11-03 : 15,5 minutes.
// À relever quand la suite grandit ; le délai doit garder 30 % de marge au-dessus.
export const DUREE_MESUREE_MINUTES = 15.5;
const DELAI_MINIMUM = Math.ceil(DUREE_MESUREE_MINUTES * 1.3);

const COMMANDES = [
  ['l’installation', (run) => run === 'npm ci'],
  ['les garde-fous', (run) => run === 'npm run garde-fous'],
  ['le paquet du Worker', (run) => /^npx -y wrangler@[\d.]+ deploy --dry-run\b/.test(run)],
  ['les types', (run) => run === 'npm run check'],
  ['les tests', (run) => run === 'npm test'],
];
const AVANT_LES_TESTS = ['les garde-fous', 'le paquet du Worker'];
const AFFAIBLISSEMENTS = [
  ['continue-on-error', /continue-on-error/],
  ['une étape conditionnelle', /^\s*-?\s*if:/m],
  ['une commande dont l’échec est ignoré', /\|\|\s*(true|:|exit 0)/],
];

const delai = (yaml) => Number(yaml.match(/^\s*timeout-minutes:\s*(\d+)\s*$/m)?.[1] ?? 0);
const lignesRun = (yaml) => [...yaml.matchAll(/^\s*(?:-\s*)?run:\s*(.+?)\s*$/gm)].map((match) => match[1]);

export function controleVerifications({ verifications, deploiement, attente }) {
  const errors = [];
  const ici = '.github/workflows/verifications.yml';

  const lignes = lignesRun(verifications);
  const positions = new Map();
  for (const [nom, correspond] of COMMANDES) {
    const position = lignes.findIndex(correspond);
    if (position < 0) errors.push(`${ici} : ${nom} manquent ou ne sont plus lancés tels quels.`);
    positions.set(nom, position);
  }
  for (const nom of AVANT_LES_TESTS) {
    if (positions.get(nom) >= 0 && positions.get('les tests') >= 0 && positions.get(nom) > positions.get('les tests')) {
      errors.push(`${ici} : ${nom} doivent passer avant les tests, pour qu’une coupure ne les saute pas.`);
    }
  }
  for (const [nom, motif] of AFFAIBLISSEMENTS) {
    if (motif.test(verifications)) errors.push(`${ici} : ${nom} affaiblit les vérifications.`);
  }
  if (!/^ {2}pull_request:\s*\n {2}push:/m.test(verifications)) {
    errors.push(`${ici} : les vérifications doivent tourner sur toute proposition, sans filtre.`);
  }
  if (delai(verifications) < DELAI_MINIMUM) {
    errors.push(`${ici} : délai de ${delai(verifications)} minutes, il en faut au moins ${DELAI_MINIMUM} (durée mesurée ${DUREE_MESUREE_MINUTES} + 30 %).`);
  }

  const ligneDeploiement = '.github/workflows/deployer-api.yml';
  if (delai(deploiement) < DELAI_MINIMUM) {
    errors.push(`${ligneDeploiement} : délai de ${delai(deploiement)} minutes, il en faut au moins ${DELAI_MINIMUM}, il relance toute la suite.`);
  }
  if (!lignesRun(deploiement).includes('npm run garde-fous && npm run check && npm test')) {
    errors.push(`${ligneDeploiement} : garde-fous, types et tests doivent tous passer avant la mise en ligne, garde-fous d’abord.`);
  }

  const attenteMinutes = Number(attente.match(/const checksDeadline = minutesFromNow\((\d+)\)/)?.[1] ?? 0);
  if (attenteMinutes <= delai(verifications)) {
    errors.push(`scripts/attendre-verifications.mjs : l’attente de ${attenteMinutes} minutes doit dépasser le délai des vérifications (${delai(verifications)}).`);
  }
  return errors;
}
