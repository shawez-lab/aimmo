// X28 : ce que le fichier des vérifications doit garder. Lu par les garde-fous à chaque vérification,
// pour que personne ne retire un contrôle ni ne rapproche le délai de la durée réelle sans que cela se voie.

// Plus longue vérification réussie, mesurée sur les 40 dernières le 2026-11-22 : 31,9 minutes, et des vérifications
// arrêtées par le délai de 35 minutes encore en cours ce jour-là (AU039, AU038, AU091b, main) : 32 minutes retenues.
// Avant : 25 minutes le 2026-11-19.
// Relevé le 2026-11-24 : sur les 14 dernières vérifications réussies, la plus longue a pris 44 minutes (puis 43, 38),
// et deux vérifications (#799, #800, sans code changé) ont été arrêtées par le délai de 45 minutes : 44 minutes retenues.
// À relever quand la suite grandit ; le délai doit garder 30 % de marge au-dessus.
export const DUREE_MESUREE_MINUTES = 44;
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

// Les contrôles restent inconditionnels dans verifier ; seul deployer peut être conditionnel.
const jobBody = (yaml, id) => {
  const jobs = yaml.split(/^jobs:\s*$/m)[1] ?? '';
  const sections = jobs.split(/^(?= {2}[a-zA-Z][\w-]*:\s*$)/m);
  return sections.find((section) => section.startsWith(`  ${id}:`)) ?? '';
};
const AUTO_CONDITION = "github.event_name == 'push' && github.ref == 'refs/heads/main' && needs.verifier.result == 'success'";
const CURRENT_MAIN_COMMAND = 'node "$GITHUB_WORKSPACE/scripts/require-current-main.mjs"';

function deploymentGuards(job, label) {
  const errors = [];
  const steps = job.split(/^(?= {6}- )/m).slice(1);
  const firstGuard = steps.findIndex((step) => lignesRun(step).includes('node scripts/require-current-main.mjs'));
  const install = steps.findIndex((step) => lignesRun(step).includes('npm ci'));
  const checkout = steps.find((step) => step.includes('uses: actions/checkout@v4')) ?? '';
  if (!checkout.includes('ref: ${{ github.sha }}') || !checkout.includes('persist-credentials: false')) {
    errors.push(`${label} : checkout sur le SHA exact requis, sans identifiant Git persistant.`);
  }
  if (firstGuard < 0 || install < 0 || firstGuard > install) {
    errors.push(`${label} : le commit actuel de main doit être contrôlé avant l’installation.`);
  }
  if (firstGuard >= 0) {
    const conditions = [...steps[firstGuard].matchAll(/^\s*-?\s*if:\s*(.+?)\s*$/gm)].map((match) => match[1]);
    if (conditions.length !== 1 || conditions[0] !== "steps.h04.outputs.pret == 'oui'") {
      errors.push(`${label} : la garde du commit actuel ne peut dépendre que de H04.`);
    }
  }
  if (!/^ {6}GITHUB_TOKEN: \$\{\{ github.token \}\}\s*$/m.test(job)) {
    errors.push(`${label} : jeton de lecture de main absent.`);
  }
  const lines = job.split('\n');
  let mutations = 0;
  lines.forEach((line, index) => {
    if (!/npx .*\b(?:d1 create|d1 migrations apply|deploy\s*$)/.test(line)) return;
    mutations++;
    if (lines[index - 1]?.trim() !== CURRENT_MAIN_COMMAND) {
      errors.push(`${label} : une mutation distante n’est pas précédée de la garde du commit actuel.`);
    }
  });
  // Base du réseau et base des bacs à sable (AU025) : création et migrations de chacune, puis la mise en ligne.
  if (mutations !== 5) errors.push(`${label} : les cinq mutations protégées doivent rester explicites.`);
  if (/continue-on-error|\|\|\s*(true|:|exit 0)/.test(job)) {
    errors.push(`${label} : un échec de la garde ou du déploiement ne peut être ignoré.`);
  }
  return errors;
}

export function controleVerifications({ verifications, deploiement, attente }) {
  const errors = [];
  const ici = '.github/workflows/verifications.yml';

  const verifier = jobBody(verifications, 'verifier');
  const automatique = jobBody(verifications, 'deployer');
  const lignes = lignesRun(verifier);
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
    if (motif.test(verifier)) errors.push(`${ici} : ${nom} affaiblit les vérifications.`);
  }
  if (!/^ {2}pull_request:\s*\n {2}push:/m.test(verifications)) {
    errors.push(`${ici} : les vérifications doivent tourner sur toute proposition, sans filtre.`);
  }
  const push = verifications.match(/^ {2}push:\n((?: {4,}.*\n)*)/m)?.[1] ?? '';
  if (push.trim() !== 'branches: [main]') {
    errors.push(`${ici} : chaque push main doit être vérifié, sans filtre de chemins, même chantier.`);
  }
  if (delai(verifications) < DELAI_MINIMUM) {
    errors.push(`${ici} : délai de ${delai(verifications)} minutes, il en faut au moins ${DELAI_MINIMUM} (durée mesurée ${DUREE_MESUREE_MINUTES} + 30 %).`);
  }

  if (/^concurrency:/m.test(verifications) || !/group: verifications-\$\{\{ github.ref \}\}\n\s+cancel-in-progress: true/.test(verifier)) {
    errors.push(`${ici} : seule la vérification peut être annulée, dans son groupe par ref.`);
  }
  if (!/^ {4}needs: verifier\s*$/m.test(automatique) || !automatique.includes(`    if: ${AUTO_CONDITION}\n`)) {
    errors.push(`${ici} : le déploiement exige le succès de verifier et un push sur main.`);
  }
  if (!/group: deployer-api\n\s+cancel-in-progress: false/.test(automatique)) {
    errors.push(`${ici} : le déploiement doit garder son groupe non annulable.`);
  }
  if (/^ {2}(workflow_run|pull_request_target|workflow_call):/m.test(verifications + deploiement)) {
    errors.push(`${ici} : aucun événement privilégié ni appel extérieur pour ce déploiement.`);
  }
  if (/^ {2}push:/m.test(deploiement) || !/^ {2}workflow_dispatch:/m.test(deploiement)) {
    errors.push('deployer-api.yml : le workflow séparé doit rester manuel, sans doublon automatique.');
  }
  errors.push(...deploymentGuards(automatique, `${ici} / deployer`));
  errors.push(...deploymentGuards(jobBody(deploiement, 'deployer'), 'deployer-api.yml'));

  const ligneDeploiement = '.github/workflows/deployer-api.yml';
  if (delai(deploiement) < DELAI_MINIMUM) {
    errors.push(`${ligneDeploiement} : délai de ${delai(deploiement)} minutes, il en faut au moins ${DELAI_MINIMUM}, il relance toute la suite.`);
  }
  // Toutes les étapes de ce fichier portent la condition « H04 fait » : c'est la seule admise sur les contrôles.
  const etapes = deploiement.split(/^(?= {6}- )/m).slice(1);
  const controle = etapes.findIndex((etape) => lignesRun(etape).includes('npm run garde-fous && npm run check && npm test'));
  const miseEnLigne = etapes.findIndex((etape) => /^\s+(?:run: )?npx .*\bdeploy\s*$/m.test(etape));
  const premierChangement = etapes.findIndex((etape) => /^\s+(?:run: )?npx .*\b(?:d1 |deploy\b)/m.test(etape) && !etape.includes('Vérifications'));
  if (controle < 0) {
    errors.push(`${ligneDeploiement} : garde-fous, types et tests doivent tous passer avant la mise en ligne, garde-fous d’abord.`);
  } else {
    const conditions = [...etapes[controle].matchAll(/^\s*-?\s*if:\s*(.+?)\s*$/gm)].map((match) => match[1]);
    if (conditions.length !== 1 || conditions[0] !== "steps.h04.outputs.pret == 'oui'") {
      errors.push(`${ligneDeploiement} : les contrôles ne peuvent dépendre que de la présence des secrets (H04).`);
    }
    if (miseEnLigne < 0 || controle > miseEnLigne || (premierChangement >= 0 && controle > premierChangement)) {
      errors.push(`${ligneDeploiement} : les contrôles doivent passer avant la base et la mise en ligne.`);
    }
  }
  if (/continue-on-error/.test(deploiement)) {
    errors.push(`${ligneDeploiement} : continue-on-error laisserait partir une version en échec.`);
  }

  const attenteMinutes = Number(attente.match(/const checksDeadline = minutesFromNow\((\d+)\)/)?.[1] ?? 0);
  if (attenteMinutes <= delai(verifications)) {
    errors.push(`scripts/attendre-verifications.mjs : l’attente de ${attenteMinutes} minutes doit dépasser le délai des vérifications (${delai(verifications)}).`);
  }
  return errors;
}
