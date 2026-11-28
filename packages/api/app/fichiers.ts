import { DESIGN_CSS, DESIGN_ICON_SVG, PALETTE, THEME_COLOR } from '@aimmo/core';
import { COFFRE_JS, CONFORMITE_CSS, CONFORMITE_HTML } from './conformite.ts';
import { LOUER_CSS, LOUER_HOME_HTML, LOUER_HTML, LOUER_JS, LOUER_MODELES_ENTRY_HTML } from './louer.ts';
import { INVESTIR_CSS, INVESTIR_HOME_HTML, INVESTIR_HTML, INVESTIR_JS } from './investir.ts';
import { COMMERCES_HOME_HTML, COMMERCES_HTML, COMMERCES_JS } from './commerces.ts';
import { AVIS_HTML, AVIS_JS } from './avis.ts';
import { ACTUALITES_HOME_HTML, ACTUALITES_JS } from './actualites.ts';
import { CLES_A_RENDRE_HOME_HTML, CLES_A_RENDRE_JS } from './cles-a-rendre.ts';
import { NOTIFICATIONS_HOME_HTML, NOTIFICATIONS_JS } from './notifications.ts';
import { A_TENIR_HOME_HTML, A_TENIR_JS } from './a-tenir.ts';
import { OFFRES_HTML, OFFRES_JS } from './offres.ts';
import { DOSSIER_HTML, DOSSIER_JS } from './dossier.ts';
import { MANDAT_HTML, MANDAT_JS } from './mandat.ts';
import { CLIENTS_HTML, CLIENTS_JS, CLIENTS_TAB_HTML } from './clients.ts';
import { FICHE_JS } from './fiche.ts';
import { MES_BIENS_HTML, MES_BIENS_JS, MES_BIENS_TAB_HTML } from './mes-biens.ts';
import { PARTENAIRES_JS } from './partenaires.ts';
import { STUDIO_HTML, STUDIO_JS } from './studio.ts';
import { ATTIRER_ENTRY_HTML, ATTIRER_HTML, ATTIRER_JS } from './attirer.ts';
import { BASCULE_ENTRY_HTML, BASCULE_JS } from './bascule.ts';
import { MANDAT_MODELES_ENTRY_HTML, MANDAT_MODELES_JS } from './mandat-modeles.ts';
import { REGLAGES_MANDAT_ENTRY_HTML, REGLAGES_MANDAT_JS } from './reglages-mandat.ts';
import { LOYERS_ENTRY_HTML, LOYERS_JS } from './loyers.ts';
import { MESURE_SOURCES_ENTRY_HTML, MESURE_SOURCES_JS } from './mesure-sources.ts';
import { ANNUAIRE_ENTRY_HTML, ANNUAIRE_JS } from './annuaire.ts';
import { PROSPECTION_ENTRY_HTML, PROSPECTION_JS } from './prospection.ts';
import { BIBLIOTHEQUE_ENTRY_HTML, BIBLIOTHEQUE_JS } from './bibliotheque.ts';
import { ENGAGEMENTS_ENTRY_HTML, ENGAGEMENTS_JS } from './engagements.ts';
import { LICENCES_ENTRY_HTML, LICENCES_JS } from './licences.ts';
import { CLES_JS, clesEntryHtml } from './cles.ts';
import { PHASES_ENTRY_HTML, PHASES_JS } from './phases.ts';
import { GUIDES_PHOTO_ENTRY_HTML, GUIDES_PHOTO_JS } from './guides-photo.ts';
import { CHARGEUR_JS } from './chargeur.ts';
import { RESEAU_JS, RESEAU_RUBRIQUES } from './reseau.ts';
import { COMMISSIONS_ENTRY_HTML, EUROS_ENTRY_HTML, FINANCES_JS, FACTURES_ENTRY_HTML, GRILLE_ENTRY_HTML, RAPPORT_AGENT_HTML, RAPPORT_CHIFFRES_HTML, RAPPORT_DIRECTION_HTML, RAPPORT_TECHNIQUE_HTML } from './finances.ts';
import { FICHE_GOOGLE_HOME_HTML, FICHE_GOOGLE_HTML, FICHE_GOOGLE_JS } from './fiche-google.ts';
import { GAGNER_CSS, GAGNER_HOME_HTML, GAGNER_HTML, GAGNER_JS } from './gagner.ts';
import { REPRISE_ENTRY_HTML, REPRISE_JS } from './reprise.ts';
import { CANDIDATURES_ENTRY_HTML, INTEGRATION_CSS, INTEGRATION_HOME_HTML, INTEGRATION_HTML, INTEGRATION_JS } from './integration.ts';

/**
 * Les fichiers de l'application de l'agent (A01), tels que le navigateur de l'agent les reçoit. Ce code tourne sur le
 * téléphone de l'agent, pas dans le Worker : il n'appelle que l'API de la même adresse (politique de contenu
 * `connect-src 'self'`), jamais une adresse extérieure. Le Worker les sert tels quels (`src/agent-app.ts`).
 */
/**
 * DS069 · l'écran de la direction. Il n'est plus dans la page de l'agent (`/app/`), qui ne le télécharge donc plus :
 * il est dans la page de la direction (`/app/reseau`, `RESEAU_PAGE_HTML`), la même page avec cet écran en plus.
 */
/**
 * DS008 · l'écran de la direction en cinq rubriques, une seule à la fois : ce qui attend aujourd'hui, les chiffres,
 * les agents, les réglages, la technique. Chaque bloc vit dans une rubrique et une seule.
 *
 * Sous le titre, une phrase dit ce qui attend la direction, quelle que soit la rubrique ouverte (`sayDue`) : chaque
 * compte vient de sa lecture, dans un ordre fixe ; une lecture manquée se dit, et la phrase ne dit jamais « rien » à
 * sa place. Une facture validée la fait baisser.
 *
 * Les blocs qui se relisent avec le rapport du matin le sont à l'ouverture de leur rubrique (`showRubrique`), chacun
 * jugé pour lui-même : pas encore lu, ou lu en panne (son état dit « Réessayez… »), la rubrique relit ; un bloc lu, même
 * sans rien à montrer, ne redemande rien, et rien ne part pendant qu'une lecture est en route. Personne ne retourne
 * chercher « Lire le rapport » dans une autre rubrique.
 */
const RESEAU_JOUR_HTML = `<section class="bloc" aria-labelledby="titre-reseau-alertes">
<h3 id="titre-reseau-alertes">Alertes</h3>
<p id="reseau-alertes-etat" class="etat" role="status"></p>
<ul id="reseau-alertes" class="liste"></ul>
<p id="reseau-sans-agent" class="etat"></p>
</section>
<section class="bloc" aria-labelledby="titre-reseau-reversements">
<h3 id="titre-reseau-reversements">Reversements à faire</h3>
<p id="reseau-reversements-etat" class="etat" role="status"></p>
<ul id="reseau-reversements" class="liste"></ul>
</section>
<section class="bloc" aria-labelledby="titre-reseau-brouillons">
<h3 id="titre-reseau-brouillons">Factures à valider</h3>
<p class="doux">Mode essai : une facture validée part à la plateforme d’essai, jamais à une vraie plateforme. Elle ne change plus ensuite : un avoir la corrige.</p>
<p id="reseau-brouillons-etat" class="etat" role="status"></p>
<ul id="reseau-brouillons" class="liste"></ul>
</section>
${GUIDES_PHOTO_ENTRY_HTML}${RAPPORT_DIRECTION_HTML}`;
const RESEAU_CHIFFRES_HTML = `<div class="periodes" role="group" aria-label="Période">
<button id="reseau-mois" type="button" class="secondaire" aria-pressed="true">Ce mois-ci</button>
<button id="reseau-precedent" type="button" class="secondaire" aria-pressed="false">Mois dernier</button>
<button id="reseau-annee" type="button" class="secondaire" aria-pressed="false">12 derniers mois</button>
</div>
<p id="reseau-etat" class="etat" role="status"></p>
<div id="reseau-corps"></div>
${COMMISSIONS_ENTRY_HTML}${FACTURES_ENTRY_HTML}<section class="bloc" aria-labelledby="titre-reseau-export">
<h3 id="titre-reseau-export">Export du jour</h3>
<p class="doux">Les chiffres d’un jour, au format tableur, pour les comparer au comptage manuel.</p>
<label for="reseau-export-jour">Jour</label>
<input id="reseau-export-jour" type="date" required>
<button id="reseau-export" type="button" class="secondaire">Télécharger l’export</button>
<p id="reseau-export-etat" class="etat" role="status"></p>
</section>
${MESURE_SOURCES_ENTRY_HTML}${RAPPORT_CHIFFRES_HTML}`;
const RESEAU_AGENTS_HTML = `${CANDIDATURES_ENTRY_HTML}${ENGAGEMENTS_ENTRY_HTML}${PHASES_ENTRY_HTML}${LICENCES_ENTRY_HTML}${ANNUAIRE_ENTRY_HTML}${PROSPECTION_ENTRY_HTML}`;
const RESEAU_REGLAGES_HTML = `${REGLAGES_MANDAT_ENTRY_HTML}${MANDAT_MODELES_ENTRY_HTML}${LOUER_MODELES_ENTRY_HTML}${GRILLE_ENTRY_HTML}${LOYERS_ENTRY_HTML}${ATTIRER_ENTRY_HTML}${BIBLIOTHEQUE_ENTRY_HTML}`;
const RESEAU_TECHNIQUE_HTML = `${BASCULE_ENTRY_HTML}${REPRISE_ENTRY_HTML}${RAPPORT_TECHNIQUE_HTML}<section class="bloc" aria-labelledby="titre-reseau-cas">
<h3 id="titre-reseau-cas">Mesure du classement</h3>
<p class="doux">Les 150 derniers classements corrigés par les agents, sans coordonnées, pour relancer la mesure. Un nom peut rester : à relire, et à garder hors du dépôt.</p>
<button id="reseau-cas" type="button" class="secondaire">Télécharger les cas corrigés</button>
<p id="reseau-cas-etat" class="etat" role="status"></p>
</section>
${clesEntryHtml('reseau')}`;
const RESEAU_PARTS: Record<string, string> = { jour: RESEAU_JOUR_HTML, chiffres: RESEAU_CHIFFRES_HTML, agents: RESEAU_AGENTS_HTML, reglages: RESEAU_REGLAGES_HTML, technique: RESEAU_TECHNIQUE_HTML };
export const RESEAU_HTML = `<button id="vers-journee" type="button" class="retour" hidden>Ma journée d’agent</button>
<h2 id="reseau-titre">Le réseau</h2>
<p id="reseau-attend" class="etat" role="status"></p>
<div class="rubriques" role="group" aria-label="Rubrique">
${RESEAU_RUBRIQUES.map(([id, name], i) => `<button id="reseau-r-${id}" type="button" class="secondaire" aria-pressed="${i === 0}">${name}</button>`).join('\n')}
</div>
${RESEAU_RUBRIQUES.map(([id], i) => `<div id="reseau-p-${id}"${i === 0 ? '' : ' hidden'}>\n${RESEAU_PARTS[id]}</div>`).join('\n')}
`;

export const INDEX_HTML = `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="${THEME_COLOR}">
<meta name="referrer" content="no-referrer">
<title>AIMMO</title>
<link rel="manifest" href="/app/manifest.webmanifest">
<link rel="icon" href="/app/icon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/app/app.css">
<script src="/app/app.js" defer></script>
</head>
<body>
<button id="vers-contenu" type="button" class="evitement" hidden>Aller au contenu</button>
<header class="tete"><h1 class="marque">AIMMO</h1></header>
<div class="frise" aria-hidden="true"></div>
<nav id="onglets" class="onglets" aria-label="Sections" hidden>
<button id="journee-ouvrir" type="button" class="discret"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9 7 7M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1"/></svg>Journée</button>
${CLIENTS_TAB_HTML}${MES_BIENS_TAB_HTML}<button id="outils-ouvrir" type="button" class="discret"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 3.5h7v7h-7zM13.5 3.5h7v7h-7zM3.5 13.5h7v7h-7zM13.5 13.5h7v7h-7z"/></svg>Outils</button>
<button id="chiffres-ouvrir" type="button" class="discret"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/></svg>Chiffres</button>
</nav>
<main>
<section id="connexion" hidden>
<h2 id="connexion-titre">Connexion</h2>
<button id="entrer-appareil" type="button" hidden>Entrer avec la clé de cet appareil</button>
<p>Nouveau téléphone, ou téléphone perdu : demandez à la direction votre lien d’accès. Il ouvre AIMMO d’un appui, rien à taper.</p>
<details><summary>J’ai une clé personnelle</summary>
<form id="form-connexion" autocomplete="off">
<label for="cle">Clé personnelle</label>
<input id="cle" name="cle" type="password" minlength="32" required autocomplete="off" spellcheck="false">
<button type="submit" class="secondaire">Entrer</button>
</form></details>
<p id="erreur" role="alert" hidden></p>
</section>
<section id="invitation" hidden>
<h2 id="invitation-titre">Votre accès à AIMMO</h2>
<p>Ce lien ne sert qu’une fois. Ouvrez-le sur le téléphone que vous garderez pour AIMMO.</p>
<button id="entrer-invitation" type="button">Entrer sur ce téléphone</button>
</section>
<section id="accueil" hidden>
<h2 id="bonjour"></h2>
<p id="jour" class="doux"></p>
<button id="vers-reseau" type="button" class="secondaire" hidden>Voir le réseau</button>
<div id="dictee-accueil"></div>
<section class="bloc" aria-labelledby="titre-reprendre">
<h3 id="titre-reprendre">À reprendre</h3>
<p id="reprendre-etat" class="etat"></p>
<ul id="reprendre" class="liste"></ul>
</section>
<section class="bloc" aria-labelledby="titre-rdv">
<h3 id="titre-rdv">Rendez-vous du jour</h3>
<p id="rdv-etat" class="etat"></p>
<ul id="rdv" class="liste"></ul>
</section>
<section class="bloc" aria-labelledby="titre-plan">
<h3 id="titre-plan">Mon plan du jour</h3>
<p id="plan-etat" class="etat"></p>
<ol id="plan" class="liste"></ol>
</section>
<section class="bloc" aria-labelledby="titre-chauds">
<h3 id="titre-chauds">Contacts chauds à rappeler</h3>
<p id="chauds-etat" class="etat"></p>
<ul id="chauds" class="liste"></ul>
</section>
${A_TENIR_HOME_HTML}<section class="bloc" aria-labelledby="titre-biens">
<h3 id="titre-biens">Mes biens à mettre en vente</h3>
<p id="biens-etat" class="etat"></p>
<ul id="biens" class="liste"></ul>
</section>
<section class="bloc" aria-labelledby="titre-apres-jour">
<h3 id="titre-apres-jour">Après mes ventes</h3>
<p id="apres-jour-etat" class="etat"></p>
<ul id="apres-jour" class="liste"></ul>
</section>
<section class="bloc" aria-labelledby="titre-semaine">
<h3 id="titre-semaine">Ma semaine</h3>
<p id="semaine-etat" class="etat"></p>
<ul id="semaine" class="liste"></ul>
</section>
</section>
<section id="outils" hidden>
<h2 id="outils-titre">Outils</h2>
<h3>Mes dossiers</h3>
${GAGNER_HOME_HTML}${LOUER_HOME_HTML}${COMMERCES_HOME_HTML}${INVESTIR_HOME_HTML}<button id="apres-ouvrir" type="button" class="secondaire rangee">Mes ventes conclues</button>
<button id="partenaires-ouvrir" type="button" class="secondaire rangee">Mes partenaires</button>
<h3>Au quotidien</h3>
${CLES_A_RENDRE_HOME_HTML}<div id="remises-accueil"></div>
${FICHE_GOOGLE_HOME_HTML}${ACTUALITES_HOME_HTML}<h3>Mon compte</h3>
${INTEGRATION_HOME_HTML}${NOTIFICATIONS_HOME_HTML}${clesEntryHtml('accueil')}</section>
${CLIENTS_HTML}${MES_BIENS_HTML}<section id="fiche" hidden>
<button id="retour" type="button" class="retour">Retour</button>
<h2 id="fiche-nom"></h2>
<p id="fiche-etat" class="etat" role="status"></p>
<div id="fiche-corps"></div>
</section>
<section id="hors-ligne" hidden></section>
<section id="visite" hidden>
<button id="visite-retour" type="button" class="retour">Retour</button>
<button id="alerte" type="button" class="danger">Alerte sécurité</button>
<p id="alerte-etat" role="alert" hidden></p>
<h2 id="visite-titre"></h2>
<p id="visite-bien" class="doux"></p>
<p id="visite-etat" class="etat" role="status"></p>
<div id="visite-corps"></div>
</section>
<section id="bien" hidden>
<button id="bien-retour" type="button" class="retour">Retour à la visite</button>
<h2 id="bien-titre"></h2>
<p id="bien-bien" class="doux"></p>
<p id="bien-etat" class="etat" role="status"></p>
<div id="bien-corps"></div>
</section>
<section id="un-bien" hidden>
<button id="un-bien-retour" type="button" class="retour">Retour</button>
<h2 id="un-bien-titre"></h2>
<p id="un-bien-etat" class="doux"></p>
<button id="un-bien-vente" type="button" class="secondaire rangee">Annonce</button>
<button id="un-bien-mandat" type="button" class="secondaire rangee">Mandat</button>
<button id="un-bien-offres" type="button" class="secondaire rangee">Offres</button>
<button id="un-bien-avis" type="button" class="secondaire rangee">Avis de valeur</button>
<button id="un-bien-studio" type="button" class="secondaire rangee">Studio</button>
</section>
<section id="vente" hidden>
<button id="vente-retour" type="button" class="retour">Retour</button>
<h2 id="vente-titre"></h2>
<p id="vente-bien" class="doux"></p>
<p id="vente-etat" class="etat" role="status"></p>
<div id="vente-corps"></div>
</section>
<section id="apres" hidden>
<button id="apres-retour" type="button" class="retour">Retour</button>
<h2 id="apres-titre">Mes ventes conclues</h2>
<p id="apres-etat" class="etat" role="status"></p>
<div id="apres-corps"></div>
</section>
<section id="partenaires" hidden>
<button id="partenaires-retour" type="button" class="retour">Retour</button>
<h2 id="partenaires-titre">Mes partenaires</h2>
<p class="doux">Personne ne paie pour être proposé ni pour passer devant : l’ordre est tiré au sort, et le client choisit.</p>
<p id="partenaires-etat" class="etat" role="status"></p>
<div id="partenaires-corps"></div>
</section>
${LOUER_HTML}${INVESTIR_HTML}${CONFORMITE_HTML}${COMMERCES_HTML}${AVIS_HTML}${OFFRES_HTML}${DOSSIER_HTML}${MANDAT_HTML}${STUDIO_HTML}${GAGNER_HTML}${ATTIRER_HTML}${FICHE_GOOGLE_HTML}${INTEGRATION_HTML}<section id="chiffres" hidden>
<h2 id="chiffres-titre">Mes chiffres</h2>
<p class="doux">Chaque chiffre s’ouvre sur les lignes qui le font : vous pouvez tout recompter.</p>
<div class="periodes" role="group" aria-label="Période">
<button id="chiffres-mois" type="button" class="secondaire" aria-pressed="true">Ce mois-ci</button>
<button id="chiffres-precedent" type="button" class="secondaire" aria-pressed="false">Mois dernier</button>
<button id="chiffres-annee" type="button" class="secondaire" aria-pressed="false">12 derniers mois</button>
</div>
<p id="chiffres-etat" class="etat" role="status"></p>
<div id="chiffres-corps"></div>
${EUROS_ENTRY_HTML}${RAPPORT_AGENT_HTML}</section>
<section id="reseau" hidden></section>
<button id="sortir" type="button" class="secondaire" hidden>Se déconnecter</button>
<p id="attente">Chargement…</p>
<p id="note" role="status" hidden></p>
</main>
</body>
</html>
`;

/**
 * La feuille de l'application : la base du système de design d'AIMMO (Z03), puis la mise en page de ses écrans, en
 * jetons seulement [R201].
 */
/** DS069 · la page de la direction : celle de l'agent, avec l'écran du réseau posé à sa place. */
export const RESEAU_PAGE_HTML = INDEX_HTML.replace('<section id="reseau" hidden></section>', () => `<section id="reseau" hidden>\n${RESEAU_HTML}</section>`);

export const APP_CSS = DESIGN_CSS + `
body { min-height: 100dvh; }
.tete { position: sticky; top: 0; z-index: 2; display: flex; align-items: center; justify-content: space-between; gap: var(--e-4); padding: max(var(--e-3), env(safe-area-inset-top)) var(--e-4) var(--e-3); background: var(--papier); }
.tete h1 { font-size: var(--t-s); }
.evitement { position: absolute; z-index: 4; top: var(--e-2); left: var(--e-4); margin: 0; }
.evitement:not(:focus) { width: 1px; height: 1px; min-height: 0; padding: 0; overflow: hidden; clip-path: inset(50%); }
.onglets { position: fixed; z-index: 3; left: 0; right: 0; bottom: 0; display: flex; padding-bottom: env(safe-area-inset-bottom); background: var(--surface); border-top: 1px solid var(--trait); }
.onglets button { flex: 1 1 0; flex-direction: column; gap: var(--e-1); min-height: calc(var(--cible) + var(--e-2)); margin: 0; padding: var(--e-1) 0; border-radius: 0; color: var(--doux); font-size: var(--t-xs); text-decoration: none; }
.onglets button[aria-current] { color: var(--encre); box-shadow: inset 0 2px 0 var(--encre); }
.onglets button:focus-visible { outline-offset: -3px; }
.onglets svg { width: 22px; height: 22px; fill: none; stroke: currentColor; stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; }
.onglets:not([hidden]) ~ main { padding-bottom: calc(var(--e-8) + var(--cible) + var(--e-2) + env(safe-area-inset-bottom)); }
.onglets:not([hidden]) ~ main #note { bottom: calc(var(--cible) + var(--e-5) + env(safe-area-inset-bottom)); }
#sortir { margin-top: var(--e-7); }
#jour:not(:empty) { margin: calc(var(--e-2) * -1) 0 var(--e-4); }
:is(#accueil, #reseau-p-jour, #conformite-corps) > .bloc:has(> .liste:empty) { display: flex; flex-wrap: wrap; align-items: baseline; gap: 0 var(--e-2); margin: 0; padding: var(--e-3) 0; }
:is(#accueil, #reseau-p-jour, #conformite-corps) > .bloc:has(> .liste:empty) > h3 { margin: 0; font: 500 var(--t-s)/1.5 var(--police-texte); letter-spacing: 0; }
:is(#accueil, #reseau-p-jour, #conformite-corps) > .bloc:has(> .liste:empty) > .etat { margin: 0; }
:is(#reseau-p-jour, #conformite-corps) > .bloc:has(> .liste:empty) > .doux { display: none; }
:is(#accueil, #reseau-p-jour, #conformite-corps) > .bloc:has(> .liste:empty) > .decision { flex: 1 0 100%; }
:is(#accueil, #reseau-p-jour, #conformite-corps) > .bloc:has(> .liste:empty) + .bloc { margin-top: 0; }
#outils > h3 { margin: var(--e-6) 0 var(--e-2); font: 500 var(--t-s)/1.3 var(--police-texte); letter-spacing: 0; color: var(--doux); }
button.rangee, #remises-accueil > .bloc > button { width: 100%; justify-content: space-between; min-height: calc(var(--cible) + var(--e-2)); margin: 0; padding: var(--e-3) 0; border-top: 1px solid var(--trait); border-radius: 0; box-shadow: none; color: var(--encre); text-align: left; }
button.rangee::after, #remises-accueil > .bloc > button::after { content: "›"; color: var(--doux); font-size: 1.4em; line-height: .8; font-weight: 400; }
button.rangee > span { display: grid; gap: var(--e-1); font-weight: 400; }
#biens > li, #clients-liste > li, #mes-biens-liste > li { margin: 0; padding: 0; border: 0; }
#biens button.rangee, #clients-liste button.rangee, #mes-biens-liste button.rangee { margin: 0; padding: var(--e-2) 0; }
#un-bien > .doux { margin-bottom: var(--e-4); }
#clients-corps > .doux, #mes-biens-corps > .doux { margin: var(--e-3) 0; }
#remises-accueil > .bloc { margin: 0; padding: 0; border: 0; }
#outils > .etat { margin: 0 0 var(--e-3); }
#actualites-vues { padding-left: var(--e-5); }
#cles-accueil-corps:empty + .doux { display: none; }
@media (min-width: 64rem) {
.onglets { z-index: 1; top: 0; right: auto; width: 12rem; flex-direction: column; gap: var(--e-1); padding: var(--e-8) var(--e-4) 0; background: var(--papier); border-top: 0; border-right: 1px solid var(--trait); }
.onglets button { flex: none; flex-direction: row; justify-content: flex-start; gap: var(--e-3); min-height: var(--cible); padding: 0 var(--e-3); font-size: var(--t-m); }
.onglets button[aria-current] { box-shadow: inset 2px 0 0 var(--encre); }
.onglets:not([hidden]) ~ main { padding-bottom: var(--e-8); }
.onglets:not([hidden]) ~ main #note { bottom: var(--e-4); }
}
main { max-width: var(--colonne); margin: 0 auto; padding: var(--e-5) var(--e-4) var(--e-8); }
main > section > h2 { font-size: var(--t-xxl); margin: var(--e-2) 0 var(--e-4); }
#bonjour::after { content: ""; display: block; width: 48px; height: 4px; margin-top: var(--e-3); background: var(--moutarde); border-radius: var(--r-rond); }
#connexion { padding-top: var(--e-6); }
#connexion form button { width: 100%; margin-top: var(--e-5); }
#erreur { margin-top: var(--e-4); }
#erreur:not(:empty) { padding: var(--e-3) var(--e-4); border-radius: var(--r-m); background: var(--danger-doux); color: var(--encre); box-shadow: inset 4px 0 0 var(--danger); }
#attente { color: var(--doux); padding: var(--e-7) 0; text-align: center; }
#note:not([hidden]) { position: fixed; left: var(--e-4); right: var(--e-4); bottom: max(var(--e-4), env(safe-area-inset-bottom)); max-width: var(--colonne); margin: 0 auto; padding: var(--e-3) var(--e-4); border-radius: var(--r-m); background: var(--encre); color: var(--papier); box-shadow: var(--ombre); z-index: 3; }
.bloc > h3 { margin-bottom: var(--e-2); }
.bloc > .etat { margin: 0; }
.etat > .alerte { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 0 var(--e-4); padding: var(--e-1) var(--e-4); font-size: var(--t-m); }
.alerte > button { margin: 0; }
#accueil > .bloc:has(.alerte) { display: block; }
#regmandat-corps h4 { margin: var(--e-4) 0 var(--e-2); }
.bloc > button.secondaire { width: 100%; }
.liste > li > strong:first-child { font-size: var(--t-l); font-family: var(--police-titre); font-weight: 600; }
.liste button, #fiche-corps button { margin-top: var(--e-3); }
.liste button + button { margin-inline-start: var(--e-2); }
.appel { margin-top: var(--e-3); }
.gestes { display: flex; flex-wrap: wrap; gap: 0 var(--e-2); }
.gestes > button { padding-inline: var(--e-4); }
.gestes > :not(button) { flex: 1 0 100%; }
#fiche-corps .periodes button { margin-top: 0; }
summary::before { content: "+"; width: 1em; font-weight: 400; }
summary > .doux { margin-left: var(--e-1); font-weight: 400; font-size: inherit; }
[aria-invalid="true"] { border-color: var(--danger); box-shadow: inset 0 0 0 1px var(--danger); }
[aria-invalid="true"] + .retard { margin: var(--e-3) 0 0; font-size: var(--t-s); }
html { scroll-padding-block: 3rem 9rem; }
.envoi { position: sticky; z-index: 1; bottom: calc(var(--cible) + var(--e-2) + 1px + env(safe-area-inset-bottom)); margin-top: var(--e-4); padding: var(--e-3) 0; background: var(--papier); border-top: 1px solid var(--trait); }
.envoi > button { margin: 0; }
.envoi > p { margin: var(--e-2) 0 0; }
.envoi > p:empty { display: none; }
@media (min-width: 64rem) { .envoi { bottom: 0; } }
details[open] > summary::before { content: "–"; }
#fiche-corps li > button { display: flex; width: fit-content; }
details { margin-top: var(--e-2); }
summary { min-height: var(--cible); display: flex; align-items: center; cursor: pointer; color: var(--accent); font-weight: 600; list-style-position: inside; }
h4 { margin: var(--e-4) 0 var(--e-1); }
.brief ul { margin: 0; padding-left: var(--e-5); }
.brief li { padding: var(--e-1) 0; }
#fiche, #visite, #bien, #avis, #offres, #dossier, #mandat, #vente, #apres, #chiffres, #reseau, #partenaires { padding-top: var(--e-2); }
.tirage { margin: var(--e-2) 0; padding-left: var(--e-6); }
.tirage li { padding: var(--e-2) 0; font-family: var(--police-titre); font-size: var(--t-l); }
.tirage li::marker { color: var(--moutarde); font-weight: 600; }
.tirage .fait { font-family: inherit; font-size: var(--t-s); }
fieldset { margin: var(--e-3) 0; padding: 0; border: 0; }
legend { font-weight: 600; margin-bottom: var(--e-2); }
.proposer { margin-top: var(--e-4); padding-top: var(--e-4); border-top: 2px dashed var(--trait); }
.suivi { margin-top: var(--e-3); }
#visite .danger { margin: var(--e-2) 0 var(--e-4); }
.acquereur { padding: var(--e-3) 0; }
.acquereur ul { margin: var(--e-1) 0 0; padding-left: var(--e-5); }
.vente { margin-top: var(--e-5); padding: var(--e-5) var(--e-4); background: var(--surface); border: 1px solid var(--trait); border-radius: var(--r-l); }
.vente h3 { margin-bottom: 0; }
.client { padding: var(--e-4) 0; border-top: 1px solid var(--trait); }
.client h4 { margin-top: 0; }
.brouillon { margin: var(--e-2) 0; padding: var(--e-3) var(--e-4); background: var(--papier); border-radius: var(--r-m); box-shadow: inset 4px 0 0 var(--accent); white-space: pre-wrap; }
.note { font: 600 var(--t-xl)/1 var(--police-titre); color: var(--accent); }
.periodes { display: flex; gap: var(--e-1); padding: var(--e-1); margin: var(--e-2) 0 var(--e-4); background: var(--surface); border: 1px solid var(--trait); border-radius: var(--r-rond); }
.periodes button { flex: 1 1 0; margin: 0; min-height: 44px; padding: var(--e-2) var(--e-3); border-radius: var(--r-rond); font-size: var(--t-s); }
.periodes button.secondaire { box-shadow: none; }
.periodes button[aria-pressed="true"] { background: var(--accent); color: var(--sur-accent); }
.rubriques { display: flex; flex-wrap: wrap; gap: 0 clamp(var(--e-1), 2vw, var(--e-6)); margin: var(--e-2) 0 0; border-bottom: 1px solid var(--trait); }
.rubriques ~ div > .bloc:first-child { margin-top: 0; border-top: 0; }
.rubriques ~ div > .periodes { margin-top: var(--e-5); }
.rubriques button { margin: 0; padding: 0; border-radius: 0; box-shadow: none; color: var(--doux); font-size: var(--t-xs); }
.rubriques button[aria-pressed="true"] { color: var(--encre); box-shadow: inset 0 -2px 0 var(--encre); }
.chiffre { border-top: 1px solid var(--trait); }
.chiffre:first-child { border-top: 0; }
.chiffre summary { justify-content: space-between; gap: var(--e-3); color: var(--encre); font-weight: 400; }
.chiffre summary::before { content: none; }
.chiffre .valeur { font: 600 var(--t-xl)/1 var(--police-titre); color: var(--accent); }
.chiffre ul { margin: 0 0 var(--e-3); padding-left: var(--e-5); }
.chiffre li { padding: var(--e-1) 0; }
#reseau-export-jour { margin-bottom: var(--e-2); }
#studio .periodes { flex-wrap: wrap; }
#studio canvas { max-width: 100%; height: auto; }
` + LOUER_CSS + INVESTIR_CSS + CONFORMITE_CSS + GAGNER_CSS + INTEGRATION_CSS;

/**
 * Le script de la page. Tout texte venu de l'API est posé avec `textContent`, jamais comme du code. La clé ne passe
 * que dans l'en-tête `Authorization`.
 */
export const APP_JS = `'use strict';
(function () {
  var KEY = 'aimmo.cle';
  // La seconde clé d'une personne qui est à la fois agent et direction (Z02) : celle de la direction.
  var KEY_DIRECTION = 'aimmo.cle.direction';
  // Le lien d'invitation (Z02) : le jeton suit « # », que le navigateur n'envoie jamais au serveur.
  var INVITATION = /^#invitation=([A-Za-z0-9_-]{43})$/;
  // DS069 · l'écran de la direction n'est que dans sa page (/app/reseau). Dans celle de l'agent, un de ses éléments
  // est un fantôme hors de la page : les branchements du démarrage et les remises à zéro ne cassent rien.
  var KEY_RESEAU = 'aimmo.reseau';
  var RESEAU_PATH = '/app/reseau';
  var ghosts = {};
  function reseauHere() { return !!document.getElementById('reseau-corps'); }
  var $ = function (id) { return document.getElementById(id) || (reseauHere() ? null : ghosts[id] || (ghosts[id] = document.createElement('div'))); };
  function readKey() { try { return localStorage.getItem(KEY); } catch (e) { return null; } }
  function writeKey(v) { try { localStorage.setItem(KEY, v); return true; } catch (e) { return false; } }
  function readDirectionKey() { try { return localStorage.getItem(KEY_DIRECTION); } catch (e) { return null; } }
  function writeDirectionKey(v) { try { localStorage.setItem(KEY_DIRECTION, v); return true; } catch (e) { return false; } }
  // Sans argument : la sortie efface les deux clés. Avec une clé refusée : seule celle-ci est effacée, l'autre reste.
  function forgetKey(refused) {
    // AU104 : le mode privé de la clé oubliée s'efface [R676].
    var k = refused || readKey();
    if (k) offline(function (H) { H.oublier(k); });
    if (!refused) try { localStorage.removeItem(KEY_RESEAU); } catch (e) { /* sans mémoire */ }
    [KEY, KEY_DIRECTION].forEach(function (slot) {
      try { if (refused === undefined || localStorage.getItem(slot) === refused) localStorage.removeItem(slot); } catch (e) { /* rien à effacer */ }
    });
  }
  function el(tag, text, cls) {
    var n = document.createElement(tag);
    if (text !== undefined && text !== null) n.textContent = String(text);
    if (cls) n.className = cls;
    return n;
  }
  function clear(n) { while (n.firstChild) n.removeChild(n.firstChild); }
  function hour(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    try { return d.toLocaleTimeString('fr-FR', { timeZone: 'Europe/Paris', hour: '2-digit', minute: '2-digit' }); } catch (e) { return ''; }
  }
  var KINDS = { estimation: 'Estimation', visite: 'Visite', signature: 'Signature', appel: 'Appel' };
  var STATUS = { honored: 'honoré', absent: 'client absent' };
  var SECTIONS = { client: 'Le client', histoire: 'Son histoire', bien: 'Le bien', ventes: 'Ventes du quartier', questions: 'Questions à prévoir', documents: 'Documents à apporter', itineraire: 'Itinéraire' };
  var MISSING = { not_ready: 'Le brief sera prêt une heure avant le rendez-vous.', no_access: 'Fiche suivie par un autre agent : ni brief ni détail.', changed: 'La fiche a changé depuis le brief : il n’est pas montré.', property: 'Le bien n’est plus dans vos droits : le brief n’est pas montré.' };
  // Le seul lien extérieur admis : l'itinéraire du brief, vers l'application de navigation.
  var ROUTE = /^https:\\/\\/www\\.google\\.com\\/maps\\/dir\\/\\?api=1&destination=[A-Za-z0-9%._~!*'()-]+$/;
  // Le plan est rendu dans l'ordre reçu du socle, jamais retrié ici [R35].
  function renderPlan(list, data) {
    if (!data) return 'Le plan du jour sera prêt à 7 h 30.';
    var items = Array.isArray(data.items) ? data.items : [];
    items.forEach(function (item) {
      var li = el('li');
      li.appendChild(el('strong', String(item.rank) + '. ' + (item.firstName || 'Prénom inconnu')));
      li.appendChild(el('p', item.reason));
      if (item.priority) li.appendChild(el('p', item.priority, 'doux'));
      li.appendChild(ficheButton(item.personId));
      list.appendChild(li);
    });
    if (data.hiddenSinceFrozen > 0) list.appendChild(el('li', String(data.hiddenSinceFrozen) + ' ligne(s) retirée(s) depuis 7 h 30.', 'doux'));
    var steps = Array.isArray(data.sequenceSteps) ? data.sequenceSteps : [];
    drawSteps(list, steps, session);
    return items.length === 0 && steps.length === 0 && !(data.hiddenSinceFrozen > 0) ? 'Rien au plan aujourd’hui.' : null;
  }
  // Les étapes du jour des séquences (BR32), dessinées par un script à part, chargé seulement s'il y en a [R201].
  var sequencesDraw = null;
  function drawSteps(list, steps, mine) {
    if (!steps.length) return;
    if (sequencesDraw) { sequencesDraw(list, steps); return; }
    var s = el('script');
    s.setAttribute('src', '/app/sequences-jour.js');
    s.addEventListener('load', function () {
      sequencesDraw = globalThis.AIMMO_SEQUENCES({ el: el, button: button, send: send, ficheButton: ficheButton, hour: hour, reload: function () {
        var again = session;
        if (currentKey) loadPlan(currentKey, again).then(function (done) {
          if (done === false && again === session) { wipe(); forgetKey(currentKey); refuse('Clé refusée. Vérifiez-la ou demandez-en une nouvelle.'); }
        });
      } });
      if (mine === session) sequencesDraw(list, steps);
    });
    s.addEventListener('error', function () { if (mine === session) $('plan-etat').textContent = 'Étapes des séquences non chargées : pas de réseau. Réessayez dans un moment.'; });
    $('accueil').appendChild(s);
  }
  function renderHot(list, data) {
    var contacts = data && Array.isArray(data.contacts) ? data.contacts : [];
    contacts.forEach(function (c) {
      var li = el('li');
      li.appendChild(el('strong', c.firstName || 'Prénom inconnu'));
      li.appendChild(el('p', c.reason));
      li.appendChild(el('p', (c.overdue ? 'En retard : à rappeler depuis ' : 'À rappeler avant ') + hour(c.dueAt), c.overdue ? 'retard' : 'doux'));
      li.appendChild(ficheButton(c.personId));
      list.appendChild(li);
    });
    return contacts.length === 0 ? 'Aucun contact chaud à rappeler.' : null;
  }
  function renderBrief(brief) {
    var box = el('details', null, 'brief');
    box.appendChild(el('summary', 'Brief du rendez-vous'));
    var items = Array.isArray(brief.items) ? brief.items : [];
    var current = null;
    var ul = null;
    items.forEach(function (item) {
      if (item.section !== current) {
        current = item.section;
        box.appendChild(el('h4', SECTIONS[current] || 'Autre'));
        ul = el('ul');
        box.appendChild(ul);
      }
      var li = el('li');
      if (item.value === null || item.value === undefined) {
        li.appendChild(el('span', item.label + ' : manque, ' + item.missing, 'doux'));
      } else if (item.section === 'itineraire' && typeof item.value === 'string' && ROUTE.test(item.value)) {
        var a = el('a', 'Ouvrir l’itinéraire');
        a.setAttribute('href', item.value);
        a.setAttribute('target', '_blank');
        a.setAttribute('rel', 'noopener noreferrer');
        li.appendChild(a);
      } else {
        li.appendChild(el('span', item.label + ' : ' + item.value));
        if (item.source) li.appendChild(el('span', ' (' + item.source + ')', 'doux'));
      }
      ul.appendChild(li);
    });
    return box;
  }
  function renderAppointments(list, data) {
    var appointments = data && Array.isArray(data.appointments) ? data.appointments : [];
    appointments.forEach(function (a) {
      var li = el('li');
      var head = hour(a.start) + ' à ' + hour(a.end) + ' · ' + (KINDS[a.kind] || 'Rendez-vous') + (a.firstName ? ' · ' + a.firstName : '');
      li.appendChild(el('strong', head));
      if (STATUS[a.status]) li.appendChild(el('p', 'Rendez-vous ' + STATUS[a.status] + '.', 'doux'));
      if (a.brief) li.appendChild(renderBrief(a.brief));
      else li.appendChild(el('p', MISSING[a.briefMissing] || MISSING.not_ready, 'doux'));
      // Une visite dont l'agent voit le visiteur s'ouvre sur son écran : sécurité, bon, compte rendu, acquéreurs.
      // Le prénom n'est pas un droit : la route de la visite contrôle l'accès ; seule une fiche d'un autre agent est écartée ici.
      if (a.kind === 'visite' && a.briefMissing !== 'no_access' && ID.test(a.id)) li.appendChild(button('Ouvrir la visite', function () { openVisit(a.id); }));
      list.appendChild(li);
    });
    return appointments.length === 0 ? 'Aucun rendez-vous aujourd’hui.' : null;
  }
  var currentKey = null;
  var ID = /^[A-Za-z0-9_-]{1,64}$/;
  var PROJECTS = { sell: 'Vendre', buy: 'Acheter', rent_out: 'Mettre en location', rent: 'Louer', invest: 'Investir', sell_business: 'Céder une entreprise', buy_business: 'Reprendre une entreprise', valuation: 'Faire estimer' };
  var STAGES = { new: 'nouveau', recue: 'demande reçue', appele: 'appelé' };
  var CHANNELS = { email: 'mail', phone: 'téléphone', sms: 'SMS', instagram: 'Instagram', facebook: 'Facebook', whatsapp: 'WhatsApp', site: 'site', gohighlevel: 'reprise de GoHighLevel', manychat: 'reprise de ManyChat', exclusion_list: 'liste d’exclusion' };
  // Les codes internes ne s'affichent jamais : un code inconnu prend un libellé général.
  function stage(code) { return STAGES[code] || 'en cours'; }
  function channel(code) { return CHANNELS[code] || 'autre canal'; }
  function date(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    try { return d.toLocaleDateString('fr-FR', { timeZone: 'Europe/Paris' }); } catch (e) { return ''; }
  }
  function ficheButton(personId) {
    var b = el('button', 'Voir la fiche');
    b.setAttribute('type', 'button');
    b.addEventListener('click', function () { openFiche(personId); });
    return b;
  }
  function block(title, rows) {
    var box = el('section', null, 'bloc');
    box.appendChild(el('h3', title));
    var ul = el('ul', null, 'liste');
    rows.forEach(function (r) { ul.appendChild(r); });
    if (rows.length === 0) box.appendChild(el('p', 'Rien pour le moment.', 'etat'));
    box.appendChild(ul);
    return box;
  }
  function line(text, note) {
    var li = el('li', text);
    if (note) li.appendChild(el('p', note, 'doux'));
    return li;
  }
  // Chaque entrée, sortie ou refus ouvre une nouvelle session : une réponse d'une session finie n'est jamais montrée.
  var session = 0;
  // L'usage du matin : pour l'agent seul, ses propres jours ; aucune comparaison avec les autres [R14].
  function renderWeek(list, data) {
    if (!data || data.scope !== 'agent' || !Array.isArray(data.days)) return 'Mesure indisponible.';
    list.appendChild(el('li', 'Plan ouvert avant midi : ' + data.openedDays + (data.openedDays > 1 ? ' jours' : ' jour') + ' sur ' + data.days.length + '.'));
    // DS055 · les jours se disent en mots, par leur nom : ceux où le plan a été ouvert, ou ceux qui manquent s'ils sont moins nombreux.
    var opened = data.days.filter(function (d) { return d.opened; }), missed = data.days.filter(function (d) { return !d.opened; });
    var less = opened.length <= missed.length, names = (less ? opened : missed).map(function (d) { return dayLabel(d.day + 'T12:00:00Z').split(' ').slice(0, 2).join(' '); }).filter(function (n) { return n; });
    if (opened.length && missed.length && names.length) list.appendChild(el('li', (less ? 'Ouvert ' : 'Pas ouvert ') + (names.length > 1 ? names.slice(0, -1).join(', ') + (less ? ' et ' : ' ni ') : '') + names[names.length - 1] + '.', 'doux'));
    return null;
  }
  // DS002 · une liste montre ce qu'on peut traiter, puis propose la suite : cinq lignes, puis vingt de plus par geste.
  function fold(list) {
    var rest = Array.prototype.slice.call(list.children, 5);
    if (rest.length < 2) return;
    rest.forEach(function (k) { list.removeChild(k); });
    var li = el('li'), b = button('', function () {
      rest.splice(0, 20).forEach(function (k) { list.insertBefore(k, li); });
      if (rest.length) name(); else list.removeChild(li);
    });
    function name() { b.textContent = 'Voir la suite : ' + rest.length + (rest.length > 1 ? ' autres' : ' autre'); }
    b.className = 'secondaire';
    name();
    li.appendChild(b);
    list.appendChild(li);
  }
  function part(id, request, render, mine) {
    var list = $(id);
    var state = $(id + '-etat');
    clear(list);
    state.textContent = 'Chargement…';
    return request.then(function (r) {
      // Un dossier d'agent incomplet n'est pas une clé refusée (J14) : la clé reste, « Mon dossier » reste ouvert [R82].
      if (r.status === 403) return r.json().then(function (b) { return b && b.code === 'agent_file_incomplete' ? { incomplete: true } : { refused: true }; }, function () { return { refused: true }; });
      if (r.status === 401) return { refused: true };
      if (!r.ok) return { failed: true };
      return r.json().then(function (body) { return { body: body }; });
    }).then(function (res) {
      if (mine !== session) return true;
      if (res.refused) return false;
      if (res.incomplete) { state.textContent = 'Fermé tant que votre dossier d’agent est incomplet : ouvrez « Mon dossier », dans les outils.'; return true; }
      if (res.failed || !res.body || res.body.ok !== true) { down(state); return true; }
      var empty = render(list, res.body.data);
      // Une réponse illisible est une panne aussi, pas « rien » [R10] : le rendu la dit par sa phrase.
      if (empty && !empty.indexOf('Indisponible')) down(state); else state.textContent = empty || '';
      if (id === 'chauds' || id === 'biens') fold(list);
      return true;
    }, function () {
      if (mine !== session) return true;
      clear(list);
      down(state);
      return true;
    });
  }
  var reprendreDraw = null;
  function loadReprendre(key, mine) { return part('reprendre', api('/v1/alertes-agent', key), renderReprendre, mine); }
  function renderReprendre(list, data) {
    if (!data || !Array.isArray(data.alerts) || !data.alerts.length) return 'Rien à reprendre.';
    var mine = session;
    if (reprendreDraw) return reprendreDraw(list, data);
    var s = el('script');
    s.setAttribute('src', '/app/alertes.js');
    s.addEventListener('load', function () {
      reprendreDraw = globalThis.AIMMO_ALERTES({ $: $, el: el, clear: clear, send: send, button: button, date: date, ficheButton: ficheButton, reload: function () { return loadReprendre(currentKey, session); } });
      if (mine === session) $('reprendre-etat').textContent = reprendreDraw(list, data);
    });
    s.addEventListener('error', function () { if (mine === session) $('reprendre-etat').textContent = 'Pas de réseau. Réessayez dans un moment.'; });
    $('accueil').appendChild(s);
    return 'Chargement…';
  }
  function loadPlan(key, mine) { return part('plan', api('/v1/plan-du-jour', key), renderPlan, mine); }
  function day(key, mine) {
    var da = $('dictee-accueil'), ra = $('remises-accueil');
    clear(da);
    da.appendChild(lazyBlock('Dicter un contact, un bien ou un rendez-vous', '/app/dictee.js', 'AIMMO_DICTEE', ''));
    clear(ra);
    ra.appendChild(lazyBlock('Mes remises négociées', '/app/remises.js', 'AIMMO_REMISES', ''));
    ra.appendChild(lazyBlock('Mes panneaux', '/app/panneaux.js', 'AIMMO_PANNEAUX', ''));
    return Promise.all([
      // La semaine est lue après le plan : l'ouverture de ce matin y compte déjà.
      loadPlan(key, mine).then(function (done) {
        if (!done || mine !== session) return done;
        return part('semaine', api('/v1/usage/matin', key), renderWeek, mine);
      }),
      loadReprendre(key, mine),
      part('a-tenir', api('/v1/offres/a-tenir', key), renderTenir, mine),
      part('chauds', api('/v1/contacts-chauds', key), renderHot, mine),
      part('biens', api('/v1/annonces', key), renderBiens, mine),
      part('rdv', api('/v1/rendez-vous/jour', key), renderAppointments, mine),
      part('apres-jour', api('/v1/apres-vente/journee', key), renderAfterSaleDay, mine),
    ]).then(function (done) {
      if (mine !== session) return;
      // Une clé refusée en cours de route : rien n'est gardé à l'écran ni sur l'appareil.
      if (done.indexOf(false) !== -1) { wipe(); forgetKey(currentKey); refuse('Clé refusée. Vérifiez-la ou demandez-en une nouvelle.'); }
    });
  }
  function wipe() {
    // AU018 : la session finie, la visite sans réseau oublie la clé et l'agent.
    if (OFF) OFF.stop();
    ['reprendre', 'a-tenir', 'plan', 'chauds', 'rdv', 'semaine', 'biens', 'apres-jour'].forEach(function (id) { clear($(id)); $(id + '-etat').textContent = ''; });
    clear($('dictee-accueil'));
    clear($('remises-accueil'));
    place = null;
    places = {};
    names = {};
    wipeFiche();
    wipeClients(true);
    wipeMesBiens(true);
    wipeM08();
    wipeApres();
    wipeChiffres();
    wipeReseau();
    wipeCles();
    wipePartenaires();
    wipeLouer();
    wipeInvestir();
    forgetLouer();
    wipeMandatModeles();
    wipeConformite();
    wipeCommerces();
    wipeAvis();
    wipeOffres();
    wipeDossier();
    wipeMandat();
    wipeStudio();
    wipeGagner();
    wipeAttirer();
    wipeGoogle();
    wipeIntegration();
    wipeActualites();
    wipeClesARendre();
    wipeNotifications();
  }
  /* ---------- M08 : l'écran de la visite et l'écran des acquéreurs d'un bien (T08). ---------- */
  function button(text, onClick) {
    var b = el('button', text);
    b.setAttribute('type', 'button');
    b.addEventListener('click', onClick);
    return b;
  }
  // DS022 · un geste qui n'est pas le pas à faire sur l'écran est filaire.
  function quiet(b) { b.className = 'secondaire'; return b; }
  // DS061 · une panne ne ressemble pas à une aide : elle se voit, et « Réessayer » relit l'écran. Écrite dans la zone
  // d'état, elle part avec le prochain message qui s'y écrit.
  function down(state, offline) {
    state.textContent = '';
    state.appendChild(el('span', offline ? 'Pas de réseau.' : 'Indisponible pour le moment.', 'alerte')).appendChild(button('Réessayer', retry)).className = 'discret';
  }
  function retry() {
    if (!currentKey || !shownId) return;
    if (shownId === 'accueil') goHome(); else reopen(shownId, JSON.parse(shownArgs), true);
  }
  function section(title) {
    var box = el('section', null, 'bloc');
    box.appendChild(el('h3', title));
    return box;
  }
  // Un champ toujours relié à son libellé, pour les lecteurs d'écran.
  function field(box, id, label, tag) {
    var l = el('label', label);
    l.setAttribute('for', id);
    var f = el(tag || 'input');
    f.setAttribute('id', id);
    box.appendChild(l);
    box.appendChild(f);
    return f;
  }
  function checkbox(box, id, label) {
    var wrap = el('div', null, 'case');
    var c = el('input');
    c.setAttribute('type', 'checkbox');
    c.setAttribute('id', id);
    var l = el('label', label);
    l.setAttribute('for', id);
    wrap.appendChild(c);
    wrap.appendChild(l);
    box.appendChild(wrap);
    return c;
  }
  function dayLabel(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    try { return d.toLocaleDateString('fr-FR', { timeZone: 'Europe/Paris', weekday: 'long', day: 'numeric', month: 'long' }); } catch (e) { return ''; }
  }
  // Ce que l'agent lit quand une demande est refusée : la raison, jamais un code interne.
  var REFUSALS = {
    bad_code: 'Code faux : vérifiez-le avec le visiteur.',
    expired: 'Code expiré : envoyez-en un nouveau.',
    blocked: 'Trop d’essais avec ce code : envoyez-en un nouveau.',
    superseded: 'Un nouveau code a été envoyé : saisissez le dernier reçu.',
    bad_identity: 'Ce nom n’est pas celui de la fiche du visiteur.',
    no_identity: 'La fiche du visiteur n’a pas de nom de famille : complétez-la avant la visite.',
    no_code: 'Aucun code envoyé pour cette visite.',
    not_booked: 'Cette visite n’est plus prévue.',
    already_confirmed: 'Cette visite est déjà confirmée.',
    consent_withdrawn: 'Le visiteur a retiré son accord pour les SMS : confirmez son identité de vive voix.',
    send_refused: 'Le SMS n’est pas parti : le contrôle des envois l’a bloqué.',
    buyer_named: 'Le compte rendu nomme le visiteur : retirez son nom avant l’envoi au vendeur.',
    contact: 'Le compte rendu contient une coordonnée : retirez-la avant l’envoi au vendeur.',
    shape: 'Compte rendu incomplet : avis de 300 caractères au plus, intérêt, listes courtes.',
    invented_figure: 'Un chiffre n’est pas dans la dictée : retirez-le.',
    invented_offer: 'La dictée ne dit pas que le visiteur veut faire une offre.',
    no_report: 'Écrivez d’abord le compte rendu.',
    no_dictation: 'Dictez d’abord ce que le visiteur a dit.',
    already_validated: 'Ce compte rendu est déjà validé.',
    not_matching: 'Ce bien ne remplit plus la recherche de cet acquéreur.',
    inactive: 'Cette recherche n’est plus active : mettez-la à jour avec l’acquéreur.',
    no_unsubscribe_link: 'Les alertes ne sont pas encore ouvertes pour le réseau.',
    waiting: 'Hors des heures d’envoi : l’alerte attend le prochain créneau permis.',
    no_template: 'Aucun modèle de bon de visite validé dans le réseau.',
  };
  function refusalText(body, fallback) {
    if (body && REFUSALS[body.code]) return REFUSALS[body.code];
    if (body && typeof body.reason === 'string' && body.reason.length < 300) return body.reason;
    return fallback;
  }
  // Une demande à l'API, sous la session en cours : une clé refusée efface tout ; une réponse d'une session finie est ignorée.
  function send(path, method, body, extra) {
    if (!currentKey) return Promise.resolve({ gone: true });
    var mine = session;
    return api(path, currentKey, method, body, extra).then(function (r) {
      return r.json().then(function (b) { return b; }, function () { return null; }).then(function (b) {
        if (mine !== session) return { gone: true };
        if (r.status === 401 || (r.status === 403 && b && b.code === 'agent_inactive')) { forgetKey(currentKey); refuse('Clé refusée. Vérifiez-la ou demandez-en une nouvelle.'); return { gone: true }; }
        return { status: r.status, ok: r.ok && !!b && b.ok === true, body: b };
      });
    }, function () { return mine !== session ? { gone: true } : { offline: true }; });
  }
  var visitId = null;
  function openVisit(id) {
    if (!ID.test(id)) return Promise.resolve(false);
    visitId = id;
    clear($('visite-corps'));
    $('visite-titre').textContent = 'Visite';
    $('visite-bien').textContent = '';
    $('visite-etat').textContent = 'Chargement…';
    show('visite', [id]);
    return send('/v1/visites/' + encodeURIComponent(id), 'GET').then(function (res) {
      if (res.gone) return false;
      if (res.offline) { $('visite-etat').textContent = 'Pas de réseau. Réessayez dans un moment.'; return false; }
      if (res.status === 403) { $('visite-etat').textContent = 'Cette visite n’est pas dans vos droits.'; return false; }
      // Une visite réservée en ligne n'a pas encore de dossier de visite : elle n'est rattachée à aucune recherche d'achat.
      if (res.status === 404) { $('visite-etat').textContent = 'Pas de dossier de visite pour ce rendez-vous : s’il a été réservé en ligne, il n’est pas encore rattaché à la recherche d’un acquéreur.'; return false; }
      if (!res.ok) { down($('visite-etat')); return false; }
      $('visite-etat').textContent = '';
      renderVisit(res.body.data);
      return true;
    });
  }
  // Un geste sur la visite : la réponse est dite, puis l'écran relu pour montrer l'état rangé.
  function act(path, body, fallback) {
    var id = visitId;
    $('visite-etat').textContent = 'Envoi…';
    return send(path, 'POST', body).then(function (res) {
      if (res.gone) return false;
      if (res.offline) { $('visite-etat').textContent = 'Pas de réseau : rien n’est parti. Réessayez dans un moment.'; return false; }
      if (!res.ok) { $('visite-etat').textContent = refusalText(res.body, fallback); return false; }
      return openVisit(id).then(function () { return true; });
    });
  }
  function renderVisit(v) {
    var body = $('visite-corps');
    clear(body);
    var p = v.property || {};
    $('visite-bien').textContent = v.property && p.reference ? (names[p.id] ? placeLine(p.id, p.reference) : 'Réf. ' + p.reference + (p.city ? ' · ' + p.city : '')) : '';
    if (!v.property) body.appendChild(el('p', 'Le bien n’est plus dans vos droits : ni sa référence ni ses acquéreurs ne sont montrés.', 'doux'));
    body.appendChild(el('p', dayLabel(v.start) + ', ' + hour(v.start) + ' à ' + hour(v.end) + (v.visitor && v.visitor.firstName ? ' · avec ' + v.visitor.firstName : ''), 'doux'));
    if (v.status !== 'booked' && v.status !== 'honored') body.appendChild(el('p', 'Cette visite n’est plus prévue.', 'alerte'));
    body.appendChild(safetyBlock(v));
    body.appendChild(reportBlock(v));
    // BR103 : dicter en sortant de la visite, le compte rendu et la suite validés d'un geste [R260, R261].
    if ((v.status === 'booked' || v.status === 'honored') && !(v.report && v.report.status === 'valide')) body.appendChild(lazyBlock('Dicter en sortant de la visite', '/app/dictee.js', 'AIMMO_DICTEE', v.appointmentId));
    body.appendChild(slipBlock(v.slip));
    if (typeof p.id === 'string' && ID.test(p.id)) {
      // DS022 · aller voir les acquéreurs du bien n'est pas un pas de la visite : le geste est filaire.
      body.appendChild(quiet(button('Acquéreurs pour ce bien', function () { openBien(p.id, p.reference || 'ce bien'); })));
    }
  }
  function safetyBlock(v) {
    var box = section('Visite sécurisée');
    var base = '/v1/visites/' + encodeURIComponent(v.appointmentId);
    if (v.safety === 'confirmee') { box.appendChild(el('p', 'Téléphone et identité du visiteur confirmés.', 'fait')); return box; }
    if (v.safety === 'code_envoye') {
      box.appendChild(el('p', 'Le visiteur a reçu un code par SMS. Saisissez-le avec son nom de famille, en face de lui.', 'doux'));
      var code = field(box, 'v-code', 'Code reçu par le visiteur');
      code.setAttribute('inputmode', 'numeric');
      code.setAttribute('autocomplete', 'one-time-code');
      code.setAttribute('maxlength', '6');
      var name = field(box, 'v-nom', 'Nom de famille du visiteur');
      name.setAttribute('autocomplete', 'off');
      box.appendChild(button('Confirmer la visite', function () {
        act(base + '/confirmation', { code: String(code.value).trim(), lastName: String(name.value).trim() }, 'La visite n’est pas confirmée.');
      }));
      box.appendChild(button('Envoyer un nouveau code', function () { act(base + '/code', { consentProof: CONSENT }, 'Le code n’est pas parti.'); }));
      return box;
    }
    box.appendChild(el('p', 'Avant d’ouvrir la porte, le visiteur confirme son téléphone et son identité.', 'doux'));
    var agreed = checkbox(box, 'v-accord', 'Le visiteur accepte de recevoir un code par SMS pour cette visite');
    box.appendChild(button('Envoyer le code au visiteur', function () {
      if (!agreed.checked) { $('visite-etat').textContent = 'Cochez d’abord l’accord du visiteur.'; return; }
      act(base + '/code', { consentProof: CONSENT }, 'Le code n’est pas parti.');
    }));
    return box;
  }
  var CONSENT = 'Accord du visiteur pour recevoir un code par SMS, recueilli par son agent dans l’application avant la visite.';
  var INTEREST = { aucun: 'aucun intérêt', faible: 'intérêt faible', moyen: 'intérêt moyen', fort: 'intérêt fort' };
  var DELIVERY = {
    sent: 'Envoyé au vendeur, sans le nom du visiteur.',
    waiting: 'Validé : il part au vendeur au prochain créneau d’envoi permis.',
    refused: 'Validé. Vendeur non prévenu (accord retiré ou exclusion) : dites-le-lui.',
    failed: 'Validé ; l’envoi a échoué, il sera repris.',
  };
  function reportLines(box, r) {
    box.appendChild(el('p', r.opinion));
    if (r.strengths && r.strengths.length) box.appendChild(el('p', 'Points forts : ' + r.strengths.join(', ')));
    if (r.reservations && r.reservations.length) box.appendChild(el('p', 'Réserves : ' + r.reservations.join(', ')));
    box.appendChild(el('p', (INTEREST[r.interest] || 'intérêt non dit') + (r.readyToOffer ? ' · prêt à faire une offre' : ''), 'doux'));
  }
  function list(text) { return String(text).split(',').map(function (x) { return x.trim(); }).filter(function (x) { return x; }); }
  function reportForm(box, base, draft) {
    var opinion = field(box, 'v-avis', 'Avis du visiteur, en une ou deux phrases', 'textarea');
    opinion.setAttribute('maxlength', '300');
    var strengths = field(box, 'v-forts', 'Points forts, séparés par des virgules');
    var reservations = field(box, 'v-reserves', 'Réserves, séparées par des virgules');
    var interest = field(box, 'v-interet', 'Intérêt du visiteur', 'select');
    ['fort', 'moyen', 'faible', 'aucun'].forEach(function (k) {
      var o = el('option', INTEREST[k]);
      o.setAttribute('value', k);
      interest.appendChild(o);
    });
    var ready = checkbox(box, 'v-offre', 'Le visiteur a dit vouloir faire une offre');
    if (draft) {
      opinion.value = draft.opinion || '';
      strengths.value = (draft.strengths || []).join(', ');
      reservations.value = (draft.reservations || []).join(', ');
      interest.value = INTEREST[draft.interest] ? draft.interest : 'moyen';
      ready.checked = draft.readyToOffer === true;
    } else interest.value = 'moyen';
    box.appendChild(button('Valider et envoyer au vendeur', function () {
      var report = { opinion: String(opinion.value).trim(), strengths: list(strengths.value), reservations: list(reservations.value), interest: interest.value, readyToOffer: ready.checked === true };
      act(base + '/compte-rendu/validation', { report: report }, 'Le compte rendu n’est pas validé.');
    }));
  }
  function reportBlock(v) {
    var box = section('Compte rendu au vendeur');
    var base = '/v1/visites/' + encodeURIComponent(v.appointmentId);
    var r = v.report;
    if (r && r.status === 'valide') {
      if (r.report) reportLines(box, r.report);
      box.appendChild(el('p', DELIVERY[r.delivery] || 'Validé.', r.delivery === 'sent' ? 'fait' : 'doux'));
      return box;
    }
    if (r && r.report) {
      // Le compte rendu rédigé d'après la dictée : un seul geste pour l'envoyer ; corriger reste possible.
      box.appendChild(el('p', 'Rédigé d’après votre dictée. Relisez, puis validez.', 'doux'));
      reportLines(box, r.report);
      box.appendChild(button('Valider et envoyer au vendeur', function () { act(base + '/compte-rendu/validation', {}, 'Le compte rendu n’est pas validé.'); }));
      var fix = el('details');
      fix.appendChild(el('summary', 'Corriger avant d’envoyer'));
      reportForm(fix, base, r.report);
      box.appendChild(fix);
      return box;
    }
    if (r) {
      box.appendChild(el('p', 'Dictée gardée, compte rendu non rédigé : écrivez-le ici, sans le nom du visiteur.', 'doux'));
      reportForm(box, base, null);
    }
    var dictation = field(box, 'v-dictee', r ? 'Dicter de nouveau' : 'Ce que le visiteur a dit', 'textarea');
    dictation.setAttribute('maxlength', '5000');
    box.appendChild(el('p', 'Touchez le micro du clavier et parlez : une phrase ou 30 secondes suffisent.', 'doux'));
    box.appendChild(button('Envoyer la dictée', function () {
      var text = String(dictation.value).trim();
      if (!text) { $('visite-etat').textContent = 'Dictez d’abord ce que le visiteur a dit.'; return; }
      act(base + '/compte-rendu/dictee', { dictation: text }, 'La dictée n’est pas enregistrée.');
    }));
    return box;
  }
  function slipBlock(slip) {
    var box = section('Bon de visite');
    if (!slip) { box.appendChild(el('p', 'Le bon de visite n’est pas prêt.', 'alerte')); return box; }
    var state = slip.signed ? 'signé et rangé' : slip.status === 'complet' ? 'prêt à signer' : 'incomplet : complétez la fiche avant la visite';
    box.appendChild(el('p', 'Bon de visite ' + state + (slip.mode === 'essai' ? ' (modèle d’essai, en attente de validation juridique).' : '.'), slip.signed ? 'fait' : 'doux'));
    if (!slip.signed && slip.status === 'complet') box.appendChild(lazyBlock('Faire signer, sans papier', '/app/bon-visite.js', 'AIMMO_BON_VISITE', visitId));
    else if (slip.online && slip.online.status === 'signee') box.appendChild(lazyBlock('Montrer l’exemplaire signé', '/app/bon-visite.js', 'AIMMO_BON_VISITE', visitId));
    return box;
  }
  // L'alerte en un geste : un seul appui, sans confirmation. Le même identifiant sert jusqu'à ce qu'elle soit rangée.
  var alertId = null;
  function newAlertId() {
    var out = 'al-';
    try {
      var buf = new Uint8Array(16);
      crypto.getRandomValues(buf);
      for (var i = 0; i < buf.length; i++) out += (buf[i] < 16 ? '0' : '') + buf[i].toString(16);
      return out;
    } catch (e) {
      return out + Date.now().toString(36) + Math.floor(Math.random() * 1e9).toString(36);
    }
  }
  function raiseAlert(retried) {
    if (!alertId) alertId = newAlertId();
    var box = $('alerte-etat');
    box.hidden = false;
    box.textContent = 'Alerte en cours d’envoi…';
    return send('/v1/visites/alertes/' + alertId, 'POST').then(function (res) {
      if (res.gone) return false;
      // Un identifiant déjà rangé au nom d'un autre (même téléphone, autre agent) : un nouvel identifiant, une fois.
      if (res.status === 403 && retried !== true) { alertId = null; return raiseAlert(true); }
      if (res.offline || !res.ok) {
        box.textContent = res.offline ? 'Pas de réseau : l’alerte n’est pas partie. Appuyez de nouveau, ou appelez le 112 si vous êtes en danger.' : 'L’alerte n’est pas partie. Appelez le 112 si vous êtes en danger.';
        return false;
      }
      alertId = null;
      var data = res.body.data || {};
      // En mode essai, rien ne part à la direction : l'agent le lit, avec le numéro d'urgence.
      box.textContent = data.trial !== false
        ? 'Mode essai : l’alerte est enregistrée, mais la direction n’est pas encore prévenue par message. Appelez le 112 si vous êtes en danger.'
        : data.notified ? 'Alerte reçue : la direction est prévenue. Appelez le 112 si vous êtes en danger.' : 'Alerte enregistrée : la direction sera prévenue dès que possible. Appelez le 112 si vous êtes en danger.';
      return true;
    });
  }
  var CRITERIA = { kind: 'type de bien', commune: 'commune', budget: 'budget', surface: 'surface', rooms: 'pièces', bedrooms: 'chambres' };
  var MATCH = { match: 'remplit tous les critères', tolerated: 'dans les tolérances écrites' };
  var WA = /^https:\\/\\/wa\\.me\\/[0-9]{6,15}\\?text=[A-Za-z0-9%._~!*'()-]*$/;
  var currentBien = null;
  var LINK_TTL_MS = 120000;
  function openBien(propertyId, reference) {
    if (!ID.test(propertyId)) return Promise.resolve(false);
    currentBien = { id: propertyId, reference: reference };
    clear($('bien-corps'));
    $('bien-titre').textContent = 'Acquéreurs pour ce bien';
    $('bien-etat').textContent = 'Chargement…';
    show('bien', [propertyId, reference]);
    var path = '/v1/acquereurs/biens/' + encodeURIComponent(propertyId);
    return Promise.all([send(path, 'GET'), send(path + '/carte', 'GET')]).then(function (both) {
      var buyers = both[0];
      var map = both[1];
      if (buyers.gone || map.gone) return false;
      if (buyers.offline) { $('bien-etat').textContent = 'Pas de réseau. Réessayez dans un moment.'; return false; }
      if (buyers.status === 403 || buyers.status === 404) { $('bien-etat').textContent = 'Ce bien n’est pas dans vos droits.'; return false; }
      if (buyers.body && buyers.body.rule === 'R42') { $('bien-etat').textContent = 'Bien pas encore proposable : mandat pas en vigueur ou rétractation en cours.'; return false; }
      if (!buyers.ok) { down($('bien-etat')); return false; }
      $('bien-etat').textContent = '';
      renderBien(propertyId, buyers.body.data, map.ok ? map.body.data : null);
      return true;
    });
  }
  function renderBien(propertyId, buyers, map) {
    var body = $('bien-corps');
    clear(body);
    var demand = section('La demande pour ce bien');
    if (map) {
      demand.appendChild(el('p', map.matching + ' acquéreur(s) sur ' + map.activeBuyers + ' recherche(s) active(s) du réseau.'));
      (map.nearMisses || []).forEach(function (n) { demand.appendChild(el('p', n.count + ' écarté(s) par un seul critère : ' + (CRITERIA[n.criterion] || 'autre critère') + '.', 'doux')); });
    } else demand.appendChild(el('p', 'Carte de la demande indisponible pour le moment.', 'doux'));
    body.appendChild(demand);
    var box = section('Vos acquéreurs proposés, dans l’ordre du rapprochement');
    var ul = el('ol', null, 'liste');
    // L'ordre est celui du socle, jamais retrié ici [R51].
    (Array.isArray(buyers) ? buyers : []).forEach(function (b) {
      var li = el('li', null, 'acquereur');
      li.appendChild(el('strong', b.rank + '. ' + (b.firstName || 'Prénom inconnu') + ' · ' + (MATCH[b.status] || 'proposé')));
      var why = el('ul');
      (b.reasons || []).forEach(function (r) { why.appendChild(el('li', r)); });
      li.appendChild(why);
      var state = el('p', null, 'doux');
      state.setAttribute('role', 'status');
      li.appendChild(state);
      if (ID.test(b.projectId)) li.appendChild(button('Alerte WhatsApp', function () { prepareWhatsApp(propertyId, b.projectId, li, state); }));
      // DS022 · prévenir l'acquéreur est le pas à faire ; lire sa fiche est filaire.
      if (ID.test(b.personId)) li.appendChild(quiet(ficheButton(b.personId)));
      ul.appendChild(li);
    });
    if (ul.children.length === 0) box.appendChild(el('p', 'Aucun de vos acquéreurs ne cherche ce bien pour le moment.', 'etat'));
    box.appendChild(ul);
    body.appendChild(box);
  }
  // Le lien est préparé après le contrôle central ; le message part du téléphone de l'agent, puis l'agent dit qu'il est parti.
  function prepareWhatsApp(propertyId, projectId, li, state) {
    state.textContent = 'Contrôle de l’envoi…';
    return send('/v1/acquereurs/biens/' + encodeURIComponent(propertyId) + '/whatsapp/' + encodeURIComponent(projectId), 'POST').then(function (res) {
      if (res.gone) return false;
      if (res.offline) { state.textContent = 'Pas de réseau : rien n’est préparé.'; return false; }
      if (!res.ok) { state.textContent = refusalText(res.body, 'L’alerte n’est pas permise pour cet acquéreur.'); return false; }
      var d = res.body.data || {};
      if (typeof d.link !== 'string' || !WA.test(d.link) || !ID.test(d.messageId)) { state.textContent = 'Le lien reçu n’est pas un lien WhatsApp : rien n’est ouvert.'; return false; }
      state.textContent = 'Message prêt : ouvrez WhatsApp maintenant, envoyez-le, puis revenez le confirmer.';
      // Le lien ne sert qu'une fois, tout de suite : le contrôle central a été fait pour cet instant [R01, R49].
      var a = el('a', 'Ouvrir WhatsApp', 'appel');
      a.setAttribute('href', d.link);
      a.setAttribute('target', '_blank');
      a.setAttribute('rel', 'noopener noreferrer');
      var live = true;
      function drop() { if (live) { live = false; li.removeChild(a); } }
      a.addEventListener('click', function () { setTimeout(drop, 0); });
      if (typeof setTimeout === 'function') setTimeout(function () { if (live) { drop(); state.textContent = 'Lien expiré sans être ouvert : préparez de nouveau l’alerte si besoin.'; } }, LINK_TTL_MS);
      li.appendChild(a);
      var done = button('Message envoyé', function () {
        drop();
        send('/v1/acquereurs/whatsapp/' + encodeURIComponent(d.messageId) + '/envoye', 'POST').then(function (r) {
          if (r.gone) return;
          if (r.ok) li.removeChild(done);
          state.textContent = r.ok ? 'Envoi noté : ce bien ne lui sera plus proposé.' : r.offline ? 'Pas de réseau : l’envoi n’est pas noté.' : 'L’envoi n’a pas pu être noté.';
        });
      });
      li.appendChild(done);
      return true;
    });
  }
  /* ---------- M07 : l'écran « Mettre en vente » (P10). ---------- */
  var LISTING_STATES = { en_vente: 'en vente', sous_offre: 'sous offre', vendu: 'vendu', retiree: 'retirée de la vente' };
  // DS023 · un bien se dit par ce qu'il est, sa référence en petit : « Maison 5 pièces · Talant ».
  var PLACES = { land: 'Terrain', building: 'Immeuble', commercial: 'Local commercial', business_walls: 'Murs commerciaux', business: 'Fonds de commerce' };
  function placeName(b) {
    var what = PLACES[b.kind] || (b.dwelling === 'house' ? 'Maison' : b.dwelling === 'apartment' ? 'Appartement' : b.kind === 'home' ? 'Logement' : 'Bien');
    if (b.kind === 'home' && b.rooms > 0) what += ' ' + b.rooms + (b.rooms > 1 ? ' pièces' : ' pièce');
    return what + (b.city ? ' · ' + b.city : '');
  }
  function placeState(reference, state) { return 'Réf. ' + reference + (state ? ', annonce ' + (LISTING_STATES[state] || 'publiée') + '.' : ', pas encore publiée.'); }
  // DS013 · un bien a son écran : son nom, où il en est, et ses outils en rangées. La journée n'en garde qu'une ligne,
  // entière à toucher (DS041), au lieu de cinq boutons pleins.
  var place = null, places = {}, names = {};
  // DS023 · sous le titre d'un outil, le bien se dit par ce qu'il est, sa référence en petit à la fin. Son nom vient des
  // listes déjà lues ; sans lui, la référence seule, jamais un nom deviné.
  var PLACE_TOOLS = ['vente', 'mandat', 'offres', 'avis', 'studio', 'dossier', 'bien', 'visite'];
  function placeLine(id, reference) { return (names[id] ? names[id] + ' · ' : '') + 'Réf. ' + reference; }
  function paintPlace(p, unread) {
    $('un-bien-titre').textContent = p[2];
    $('un-bien-etat').textContent = placeState(p[1], p[3]) + (unread ? ' Non relu : réessayez dans un moment.' : '');
    $('un-bien-vente').textContent = p[3] ? 'Voir l’annonce' : 'Mettre en vente';
  }
  // « fresh » : le bien vient d'être lu avec la journée. Sinon l'écran s'ouvre sur ce qui était connu, puis relit le
  // bien : sa fiche a pu changer dans un outil, ou depuis que l'historique a gardé cet écran.
  function openPlace(id, reference, name, state, fresh) {
    if (!ID.test(id)) return;
    // Chaque bien ouvert est retenu par son identifiant : le « Retour » d'un outil retrouve le bien de cet outil-là.
    place = places[id] = [id, reference, names[id] = name, state];
    paintPlace(place);
    show('un-bien', place);
    if (fresh === true) return;
    send('/v1/annonces', 'GET').then(function (res) {
      if (res.gone || !place || place[0] !== id) return;
      if (!res.ok) { paintPlace(place, true); return; }
      (res.body.data || []).forEach(function (b) {
        if (b.id !== id) return;
        paintPlace(place = places[id] = [id, b.reference, names[id] = placeName(b), b.state || '']);
        if (shownId === 'un-bien') retitle('un-bien');
      });
    });
  }
  function renderBiens(list, data) {
    var items = Array.isArray(data) ? data : [];
    items.forEach(function (b) {
      if (!ID.test(b.id)) return;
      names[b.id] = placeName(b);
      var row = list.appendChild(el('li')).appendChild(button('', function () { openPlace(b.id, b.reference, placeName(b), b.state || '', true); }));
      row.className = 'secondaire rangee';
      var text = row.appendChild(el('span'));
      text.appendChild(el('strong', placeName(b)));
      text.appendChild(el('span', placeState(b.reference, b.state), 'doux'));
    });
    return items.length === 0 ? 'Aucun bien à mettre en vente.' : null;
  }
  var MENTIONS = { prix: 'Prix et honoraires', energie: 'Performance énergétique', copropriete: 'Copropriété', risques: 'Risques du terrain', intervenant: 'Statut de l’agent', carte: 'Carte professionnelle' };
  var MISSING_MENTION = {
    pas_de_mandat: 'aucun mandat signé', prix_inconnu: 'prix du mandat inconnu', honoraires_inconnus: 'honoraires inconnus', pas_de_diagnostic: 'absent', diagnostic_perime: 'périmé',
    copropriete_inconnue: 'copropriété non renseignée', risques_inconnus: 'état des risques absent', statut_intervenant_inconnu: 'statut et RSAC de l’agent non rangés', titulaire_inconnu: 'titulaire de la carte non réglé', carte_inconnue: 'numéro de carte du réseau non réglé', type_de_bien_non_pris_en_charge: 'type de bien pas encore pris en charge',
  };
  var FIELDS = {
    kind: 'type de bien', city: 'commune', postalCode: 'code postal', surfaceM2: 'surface', rooms: 'pièces', bedrooms: 'chambres', floor: 'étage', floorsTotal: 'étages de l’immeuble', buildYear: 'année de construction',
    heating: 'chauffage', outdoor: 'extérieur', landM2: 'terrain', parkingSpaces: 'stationnement', elevator: 'ascenseur', energyClass: 'classe énergie', climateClass: 'classe climat',
  };
  var SENTENCE_PROBLEMS = { nombre_sans_source: 'nombre absent de la fiche', fait_sans_source: 'fait absent de la fiche', adresse: 'situe le bien trop précisément', critere_discriminant: 'critère discriminant', mot_interdit: 'mot interdit' };
  var CHANNEL_NAMES = { site: 'site', reseaux: 'réseaux sociaux', google: 'fiche Google', portails: 'portails' };
  var PUSH = { publiee: 'publiée', en_attente: 'en attente', echec: 'en échec, reprise au passage suivant' };
  var LISTING_REFUSALS = {
    not_latest_draft: 'Une version plus récente existe : validez la dernière.',
    stale_sheet: 'La fiche du bien a changé depuis ce brouillon : rédigez de nouveau.',
    already_validated: 'Cette annonce est déjà validée.',
    mentions_incomplete: 'Il manque des mentions obligatoires : complétez la fiche du bien.',
    refused_text: 'Une phrase n’est pas reliée à la fiche : corrigez-la.',
    busy: 'Une rédaction est déjà en cours : patientez un instant.',
    bad_text: 'Le titre tient en 120 signes, le texte en 3 000.',
  };
  var currentVente = null;
  var venteSending = false;
  var VENTE_WAIT = 'Un envoi part : patientez un instant.';
  function price(n) { try { return Number(n).toLocaleString('fr-FR') + ' €'; } catch (e) { return String(n) + ' €'; } }
  function openVente(propertyId, reference) {
    if (!ID.test(propertyId)) return Promise.resolve(false);
    // Pendant l'envoi d'une correction, l'écran garde le formulaire : ni texte perdu, ni second envoi, ni validation croisée.
    if (venteSending) { show('vente'); $('vente-etat').textContent = VENTE_WAIT; return Promise.resolve(false); }
    currentVente = { id: propertyId, reference: reference };
    clear($('vente-corps'));
    $('vente-titre').textContent = 'Mettre en vente';
    $('vente-etat').textContent = 'Chargement…';
    show('vente', [propertyId, reference]);
    var base = '/v1/annonces/' + encodeURIComponent(propertyId);
    return Promise.all([send(base + '/controle', 'GET'), send(base + '/brouillon', 'GET'), send(base + '/publication', 'GET')]).then(function (all) {
      if (all[0].gone || all[1].gone || all[2].gone) return false;
      if (all[0].offline) { $('vente-etat').textContent = 'Pas de réseau. Réessayez dans un moment.'; return false; }
      if (all[0].status === 403 || all[0].status === 404) { $('vente-etat').textContent = 'Ce bien n’est pas dans vos droits.'; return false; }
      if (!all[0].ok) { down($('vente-etat')); return false; }
      $('vente-etat').textContent = '';
      // Seul « aucune annonce » est un état vide ; une lecture en échec est dite comme telle, sans geste proposé.
      var draft = all[1].ok ? all[1].body.data : all[1].status === 404 && all[1].body && all[1].body.code === 'no_draft' ? null : undefined;
      var status = all[2].ok ? all[2].body.data : undefined;
      if (!draft || !draft.validated) { renderVente(propertyId, all[0].body.data, draft, status); return true; }
      // Validée sur une version de fiche qui n'est plus la dernière, l'annonce ne peut plus partir [R47] : l'écran le dit.
      return send(base + '/fiche', 'GET').then(function (sheet) {
        if (sheet.gone) return false;
        var version = sheet.ok ? sheet.body.data.version : sheet.status === 404 && sheet.body && sheet.body.code === 'no_sheet' ? null : undefined;
        var at = draft.sheetVersion === undefined ? null : draft.sheetVersion;
        draft.stale = version !== undefined && version !== at;
        renderVente(propertyId, all[0].body.data, draft, status);
        return true;
      });
    });
  }
  function venteAct(path, fallback) {
    if (venteSending) { $('vente-etat').textContent = VENTE_WAIT; return Promise.resolve(false); }
    var v = currentVente;
    $('vente-etat').textContent = 'Envoi…';
    return send(path, 'POST').then(function (res) {
      if (res.gone) return false;
      if (res.offline) { $('vente-etat').textContent = 'Pas de réseau : rien n’est fait.'; return false; }
      if (!res.ok) { $('vente-etat').textContent = (res.body && LISTING_REFUSALS[res.body.code]) || fallback; return false; }
      return openVente(v.id, v.reference).then(function () { return true; });
    });
  }
  /* X19 · La fiche du bien, chargée au premier geste [R201]. */
  var ficheBien = null;
  function venteFiche(box, base, validated) {
    var zone = el('div');
    var loading = false;
    function start(o) {
      loading = true;
      return ficheBien.open(zone, o).then(function (shown) { loading = false; open.hidden = !!shown; return shown; });
    }
    var open = quiet(button('Remplir la fiche du bien', function () {
      if (loading) return;
      var o = { base: base, validated: validated };
      if (ficheBien) return start(o);
      loading = true;
      clear(zone);
      zone.appendChild(el('p', 'Chargement…', 'doux'));
      var mine = currentVente;
      var s = document.createElement('script');
      s.setAttribute('src', '/app/fiche-bien.js');
      s.addEventListener('load', function () {
        var make = globalThis.AIMMO_FICHE_BIEN;
        try { delete globalThis.AIMMO_FICHE_BIEN; } catch (e) { /* rien */ }
        loading = false;
        if (typeof make !== 'function') { clear(zone); zone.appendChild(el('p', 'La fiche n’a pas pu se charger. Réessayez dans un moment.', 'alerte')); return; }
        ficheBien = make({
          el: el, clear: clear, send: send, button: button, field: field, checkbox: checkbox,
          current: function () { return currentVente; },
          sending: function (v) { if (v !== undefined) venteSending = v; return venteSending; },
          saved: function (v, version) {
            if ($('vente').hidden) return true;
            return openVente(v.id, v.reference).then(function () { $('vente-etat').textContent = 'Fiche rangée, version ' + version + '. S’il y a une annonce, rédigez-la de nouveau ou corrigez-la, puis validez-la.'; return true; });
          },
        });
        if (mine === currentVente) start(o);
      });
      s.addEventListener('error', function () { loading = false; clear(zone); zone.appendChild(el('p', 'Pas de réseau. Réessayez dans un moment.', 'alerte')); });
      zone.appendChild(s);
    }));
    box.appendChild(open);
    box.appendChild(zone);
  }
  /* BR51 · L'armoire des clés du bien, chargée au premier geste [R201, R271]. */
  var armoire = null;
  function venteArmoire(body, propertyId) {
    var box = section('Armoire des clés');
    var zone = el('div');
    var mine = currentVente, loading = false;
    var open = quiet(button('Ouvrir l’armoire', function () {
      if (armoire) { open.hidden = true; return armoire.open(zone, propertyId); }
      if (loading) return;
      loading = true;
      clear(zone);
      zone.appendChild(el('p', 'Chargement…', 'doux'));
      var s = document.createElement('script');
      s.setAttribute('src', '/app/armoire.js');
      s.addEventListener('load', function () {
        loading = false;
        var make = globalThis.AIMMO_ARMOIRE;
        try { delete globalThis.AIMMO_ARMOIRE; } catch (e) { /* rien */ }
        if (typeof make === 'function') armoire = make({ el: el, clear: clear, send: send, button: button, field: field, date: date, hour: hour });
        if (mine !== currentVente) return;
        if (!armoire) { clear(zone); zone.appendChild(el('p', 'L’armoire n’a pas pu se charger. Réessayez dans un moment.', 'alerte')); return; }
        open.hidden = true;
        armoire.open(zone, propertyId);
      });
      s.addEventListener('error', function () { loading = false; clear(zone); zone.appendChild(el('p', 'Pas de réseau. Réessayez dans un moment.', 'alerte')); });
      zone.appendChild(s);
    }));
    box.appendChild(open);
    box.appendChild(zone);
    body.appendChild(box);
  }
  /* X18 · Le texte de l'agent passe le même contrôle que celui de l'IA [R47] : refusé, il reste à l'écran avec ses phrases en cause. */
  function venteCorrection(box, base, draft) {
    var zone = el('div');
    var open = quiet(button('Corriger le texte', function () {
      clear(zone);
      open.hidden = true;
      var title = field(zone, 'vente-correction-titre', 'Titre');
      title.setAttribute('maxlength', '120');
      title.value = draft.title || '';
      var text = field(zone, 'vente-correction-texte', 'Texte de l’annonce', 'textarea');
      text.setAttribute('maxlength', '3000');
      text.value = draft.body || (draft.sentences || []).map(function (s) { return s.text; }).join(' ');
      if (draft.validated && !draft.stale) zone.appendChild(el('p', 'Annonce validée. Une correction reste en préparation : l’annonce en ligne y reste jusqu’à ce que l’agent du bien valide la nouvelle.', 'retard'));
      var said = el('ul', null, 'liste');
      var state = el('p', null, 'doux');
      state.setAttribute('role', 'status');
      var go = quiet(button('Enregistrer la correction', function () {
        if (venteSending) return;
        clear(said);
        if (!title.value.trim() || !text.value.trim()) { state.textContent = 'Le titre et le texte sont à remplir.'; return; }
        var mine = currentVente;
        venteSending = true;
        go.disabled = true;
        state.textContent = 'Envoi…';
        return send(base + '/correction', 'POST', { title: title.value, body: text.value }).then(function (res) {
          venteSending = false;
          if (res.gone) return false;
          go.disabled = false;
          // Coupée ou en panne, la réponse ne dit pas si le texte a été rangé : seul un refus du code le dit.
          if (res.offline || res.status >= 500 || !res.body) { state.textContent = 'Réponse perdue : la correction a peut-être été rangée. Rouvrez l’annonce pour le voir, votre texte reste ici.'; return false; }
          if (res.status === 403) { state.textContent = 'Ce bien n’est pas dans vos droits.'; return false; }
          if (!res.ok) {
            state.textContent = (res.body && LISTING_REFUSALS[res.body.code]) || 'La correction n’a pas pu être rangée.';
            ((res.body && res.body.sentences) || []).forEach(function (bad) {
              var li = el('li', bad.text);
              (bad.problems || []).forEach(function (pb) { li.appendChild(el('p', 'À corriger : ' + (SENTENCE_PROBLEMS[pb.code] || 'phrase refusée') + ' (« ' + pb.value + ' »)', 'retard')); });
              said.appendChild(li);
            });
            return false;
          }
          if ($('vente').hidden) return true;
          return openVente(mine.id, mine.reference).then(function () { $('vente-etat').textContent = 'Correction rangée : l’agent du bien la relit, puis la valide.'; return true; });
        });
      }));
      zone.appendChild(go);
      zone.appendChild(state);
      zone.appendChild(said);
    }));
    box.appendChild(open);
    box.appendChild(zone);
  }
  function renderVente(propertyId, checklist, draft, status) {
    var body = $('vente-corps');
    clear(body);
    var check = section('Mentions obligatoires');
    check.appendChild(el('p', checklist.complete ? 'Toutes les mentions sont là.' + (checklist.publishedPriceEur ? ' Prix publié partout : ' + price(checklist.publishedPriceEur) + '.' : '') : 'Il manque des mentions : l’annonce ne peut pas partir.', checklist.complete ? 'fait' : 'alerte'));
    var ul = el('ul', null, 'liste');
    (checklist.items || []).forEach(function (m) {
      var name = MENTIONS[m.id] || 'Autre mention';
      ul.appendChild(el('li', m.status === 'presente' ? name + ' : présente' : m.status === 'sans_objet' ? name + ' : sans objet' : name + ' : manque, ' + (MISSING_MENTION[m.reason] || 'à compléter'), m.status === 'manquante' ? 'retard' : null));
    });
    check.appendChild(ul);
    var base = '/v1/annonces/' + encodeURIComponent(propertyId);
    venteFiche(check, base, !!(draft && draft.validated && !draft.stale));
    body.appendChild(check);
    var text = section('L’annonce, phrase par phrase');
    if (draft === undefined) {
      text.appendChild(el('p', 'L’annonce n’a pas pu être lue. Réessayez dans un moment.', 'alerte'));
      body.appendChild(text);
    } else if (!draft) {
      text.appendChild(el('p', 'Aucune annonce rédigée pour ce bien.', 'doux'));
      text.appendChild(button('Rédiger l’annonce', function () { venteAct(base + '/brouillon', 'L’annonce n’a pas pu être rédigée.'); }));
      body.appendChild(text);
    } else {
      text.appendChild(el('h4', draft.title));
      var ol = el('ol', null, 'liste');
      // DS040 · l'annonce se lit d'un trait : chaque phrase, et sous elle seulement ce qui est à corriger. Les champs de la
      // fiche d'où viennent ses nombres et ses faits se lisent au geste, dans un volet, dans l'ordre des phrases.
      var proofs = el('ul');
      (draft.sentences || []).forEach(function (sentence) {
        var li = el('li', sentence.text);
        (sentence.sources || []).forEach(function (src) { proofs.appendChild(el('li', src.value + ' : ' + (FIELDS[src.field] || 'champ de la fiche') + ', lu dans la fiche du bien')); });
        (sentence.problems || []).forEach(function (pb) { li.appendChild(el('p', 'À corriger : ' + (SENTENCE_PROBLEMS[pb.code] || 'phrase refusée') + ' (« ' + pb.value + ' »)', 'retard')); });
        ol.appendChild(li);
      });
      text.appendChild(ol);
      if (proofs.firstChild) {
        var from = text.appendChild(el('details'));
        from.appendChild(el('summary', 'D’où vient chaque nombre'));
        from.appendChild(proofs);
      }
      if (draft.stale) text.appendChild(el('p', 'La fiche du bien a changé depuis la validation de ce texte : l’annonce ne peut plus partir. Rédigez-la de nouveau ou corrigez-la, puis validez-la.', 'alerte'));
      else if (draft.validated) text.appendChild(el('p', 'Annonce validée le ' + date(draft.validated.at) + '.', 'fait'));
      else if (ID.test(draft.id)) text.appendChild(button('Valider l’annonce', function () { venteAct('/v1/annonces/brouillons/' + encodeURIComponent(draft.id) + '/validation', 'L’annonce n’est pas validée.'); }));
      // Le pas à faire reste plein : rédiger sans brouillon, valider un brouillon, rédiger de nouveau quand la fiche a changé.
      var again = text.appendChild(button('Rédiger de nouveau', function () { venteAct(base + '/brouillon', 'L’annonce n’a pas pu être rédigée.'); }));
      if (!draft.stale) quiet(again);
      venteCorrection(text, base, draft);
      body.appendChild(text);
    }
    var pub = section('Publication');
    if (status === undefined) pub.appendChild(el('p', 'L’état de la publication n’a pas pu être lu. Réessayez dans un moment.', 'alerte'));
    else if (!status) pub.appendChild(el('p', 'Pas encore publiée : elle part d’elle-même au passage suivant, une fois l’annonce validée et le délai de rétractation fini.', 'doux'));
    else {
      pub.appendChild(el('p', 'Version ' + status.version + ', ' + (LISTING_STATES[status.state] || 'publiée') + (status.priceEur ? ', au prix de ' + price(status.priceEur) : '') + '.'));
      var ch = el('ul', null, 'liste');
      Object.keys(CHANNEL_NAMES).forEach(function (c) { if (status.channels && status.channels[c]) ch.appendChild(el('li', CHANNEL_NAMES[c] + ' : ' + (PUSH[status.channels[c]] || 'inconnu'))); });
      pub.appendChild(ch);
    }
    body.appendChild(pub);
    venteArmoire(body, propertyId);
    body.appendChild(lazyBlock('Remises du moment', '/app/remises.js', 'AIMMO_REMISES', propertyId));
    body.appendChild(lazyBlock('Panneaux du bien', '/app/panneaux.js', 'AIMMO_PANNEAUX', propertyId));
  }
  /* ---------- M11 : après la vente (F07). ---------- */
  var SIDES = { vendeur: 'Vendeur', acquereur: 'Acquéreur' };
  var AFTER_TASKS = { lien_avis: 'Réglez le lien de votre fiche Google : sans lui, aucune demande d’avis ne part.', avis_non_parti: 'La demande d’avis n’a pas pu partir à temps : demandez l’avis vous-même.' };
  var REVIEW = { sent: 'partie (mode essai)', waiting: 'attend le prochain créneau permis', refused: 'bloquée par le contrôle des envois', failed: 'en échec, sera retentée', closed: 'non partie dans le délai' };
  var THANKS = { sent: 'message parti (mode essai)', waiting: 'message validé, attend le prochain créneau permis', sending: 'message en cours d’envoi', refused: 'message bloqué par le contrôle des envois', failed: 'message en échec, sera retenté', closed: 'message non parti dans le délai' };
  var REMINDER = { sent: 'partie (mode essai)', waiting: 'attend le prochain créneau permis', refused: 'bloquée par le contrôle des envois', failed: 'en échec, sera retentée', closed: 'non partie' };
  function sideName(side, firstName) { return (SIDES[side] || 'Client') + (firstName ? ' · ' + firstName : ''); }
  // « Ma journée » : les appels pour remercier, les proches recommandés, les tâches ouvertes ; rien n'y est retrié.
  function renderAfterSaleDay(list, data) {
    if (!data) return 'Indisponible pour le moment. Réessayez plus tard.';
    (data.remercier || []).forEach(function (t) {
      var li = el('li', 'Appeler pour remercier : ' + sideName(t.side, t.firstName));
      if (t.reference) li.appendChild(el('p', 'Bien ' + t.reference, 'doux'));
      list.appendChild(li);
    });
    (data.recommandations || []).forEach(function (c) {
      var li = el('li', 'Appeler ' + (c.firstName || 'le proche recommandé') + ', recommandé par un client');
      li.appendChild(el('p', 'À appeler avant ' + hour(c.dueAt) + ', ' + dayLabel(c.dueAt), 'doux'));
      if (ID.test(c.referralId)) {
        var b = button('Appel fait', function () { referralDone(c.referralId, li, b); });
        li.appendChild(b);
      }
      list.appendChild(li);
    });
    (data.taches || []).forEach(function (t) {
      var li = el('li', AFTER_TASKS[t.kind] || 'Tâche après la vente');
      if (t.reference) li.appendChild(el('p', 'Bien ' + t.reference, 'doux'));
      list.appendChild(li);
    });
    return list.firstChild ? null : 'Rien à faire après vos ventes aujourd’hui.';
  }
  function referralDone(id, li, b) {
    b.disabled = true;
    return send('/v1/apres-vente/appels/' + encodeURIComponent(id) + '/fait', 'POST').then(function (res) {
      if (res.gone) return;
      if (!res.ok) { b.disabled = false; $('apres-jour-etat').textContent = res.offline ? 'Pas de réseau : l’appel n’est pas marqué.' : 'L’appel n’est pas marqué.'; return; }
      li.removeChild(b);
      li.appendChild(el('p', 'Appel fait', 'fait'));
    });
  }
  function wipeApres() {
    clear($('apres-corps'));
    $('apres-etat').textContent = '';
  }
  function openApres() {
    if (!currentKey) return Promise.resolve(false);
    session += 1;
    wipeApres();
    show('apres');
    $('apres-etat').textContent = 'Chargement…';
    return send('/v1/apres-vente/dossiers', 'GET').then(function (res) {
      if (res.gone) return false;
      if (!res.ok) { down($('apres-etat'), res.offline); return false; }
      renderApres(Array.isArray(res.body.data) ? res.body.data : []);
      return true;
    });
  }
  function apresAct(path, body, fallback) {
    $('apres-etat').textContent = 'Envoi…';
    return send(path, 'POST', body).then(function (res) {
      if (res.gone) return false;
      if (!res.ok) { $('apres-etat').textContent = res.offline ? 'La réponse n’est pas arrivée : rien n’est sûr. Relisez avant de recommencer.' : refusalText(res.body, fallback); return false; }
      return openApres().then(function () { $('apres-etat').textContent = 'Enregistré.'; return true; });
    });
  }
  function reviewLinkBlock(body) {
    var box = section('Le lien de ma fiche Google');
    box.appendChild(el('p', 'Les demandes d’avis portent ce lien. AIMMO ne publie jamais d’avis à la place d’un client.', 'doux'));
    var f = field(box, 'lien-avis', 'Adresse de votre fiche Google (https://…)');
    f.setAttribute('type', 'url');
    f.setAttribute('inputmode', 'url');
    f.setAttribute('autocomplete', 'off');
    box.appendChild(button('Enregistrer le lien', function () {
      var url = String(f.value || '').trim();
      if (!url) { $('apres-etat').textContent = 'Saisissez d’abord l’adresse.'; return; }
      apresAct('/v1/apres-vente/lien-avis', { url: url }, 'Ce lien n’est pas celui d’une fiche Google.');
    }));
    body.appendChild(box);
  }
  function clientBlock(file, c) {
    var box = el('div', null, 'client');
    box.appendChild(el('h4', sideName(c.side, c.firstName)));
    var base = '/v1/apres-vente/dossiers/' + encodeURIComponent(file.fileId) + '/clients/' + encodeURIComponent(c.personId);
    var ids = ID.test(file.fileId) && ID.test(c.personId);
    var t = c.thankYou;
    if (t) {
      box.appendChild(el('p', t.calledAt ? 'Appelé pour le remercier le ' + date(t.calledAt) + '.' : 'À appeler pour le remercier.', t.calledAt ? 'fait' : null));
      if (!t.calledAt && ids) box.appendChild(button('Appel fait', function () { apresAct(base + '/appele', undefined, 'L’appel n’est pas marqué.'); }));
      box.appendChild(el('p', 'Message préparé, à valider ou non :', 'doux'));
      box.appendChild(el('p', t.draft, 'brouillon'));
      if (t.decision === null && ids) {
        box.appendChild(button('Envoyer ce message', function () { apresAct(base + '/remerciement', { decision: 'send' }, 'Le message n’est pas validé.'); }));
        box.appendChild(button('Ne pas l’envoyer', function () { apresAct(base + '/remerciement', { decision: 'decline' }, 'Le choix n’est pas enregistré.'); }));
      } else if (t.decision === 'decline') {
        box.appendChild(el('p', 'Vous avez choisi de ne pas l’envoyer.', 'doux'));
      } else if (t.decision === 'send') {
        box.appendChild(el('p', THANKS[t.sendStatus] || 'message validé', 'doux'));
      }
    }
    box.appendChild(el('p', 'Demande d’avis : ' + (c.review ? (REVIEW[c.review.status] || 'état inconnu') : 'pas encore préparée')));
    (c.reminders || []).forEach(function (r) { box.appendChild(el('p', 'Nouvelles à ' + r.year + ' an' + (r.year > 1 ? 's' : '') + ' : ' + (REMINDER[r.status] || 'état inconnu'), 'doux')); });
    if (c.satisfaction) {
      var n = el('p', null);
      n.appendChild(el('span', c.satisfaction.score + ' sur 5', 'note'));
      box.appendChild(el('p', 'Sa note, reçue le ' + date(c.satisfaction.answeredAt) + ' :', 'doux'));
      box.appendChild(n);
      if (c.satisfaction.comment) box.appendChild(el('p', c.satisfaction.comment, 'brouillon'));
    }
    return box;
  }
  function renderApres(files) {
    var body = $('apres-corps');
    clear(body);
    $('apres-etat').textContent = files.length ? '' : 'Aucune vente conclue pour le moment.';
    files.forEach(function (f) {
      var box = el('section', null, 'vente');
      box.appendChild(el('h3', 'Bien ' + (f.reference || 'sans référence') + (f.city ? ', ' + f.city : '')));
      if (f.closedOn) box.appendChild(el('p', 'Acte signé le ' + dayLabel(f.closedOn + 'T12:00:00Z'), 'doux'));
      (f.clients || []).forEach(function (c) { box.appendChild(clientBlock(f, c)); });
      body.appendChild(box);
    });
    reviewLinkBlock(body);
  }
  // Un numéro par formulaire dessiné par l'application, pour que chaque champ ait un identifiant à lui (conformité).
  var formSeq = 0;
${PARTENAIRES_JS}  /* ---------- M13 : mes chiffres (K08). Chaque chiffre s'ouvre sur ses lignes ; rien n'est comparé à un autre agent. ---------- */
  var APPOINTMENT_KINDS = { estimation: 'Rendez-vous d’estimation', visite: 'Visite', signature: 'Signature', appel: 'Appel' };
  var FEE_STATUS = { prevue: 'prévue, compromis signé', due: 'due, acte signé', facturee: 'facturée, en attente du versement' };
  var chiffresRange = 'mois';
  function parisToday() {
    try { return new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Paris' }); } catch (e) { return new Date().toISOString().slice(0, 10); }
  }
  function shiftDay(day, n) { return new Date(Date.parse(day + 'T12:00:00Z') + n * 86400000).toISOString().slice(0, 10); }
  function periodOf(range) {
    var today = parisToday();
    var first = today.slice(0, 8) + '01';
    if (range === 'precedent') { var last = shiftDay(first, -1); return { from: last.slice(0, 8) + '01', to: last }; }
    if (range === 'annee') return { from: shiftDay(today, -364), to: today };
    return { from: first, to: today };
  }
  function euros(cents) {
    var n = Number(cents) / 100;
    try { return n.toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).replace(/[\u202f\u00a0]/g, ' ') + ' €'; } catch (e) { return n.toFixed(2) + ' €'; }
  }
  function figure(body, label, value, lines, line) {
    var d = el('details', null, 'chiffre');
    var s = el('summary');
    s.appendChild(el('span', label));
    s.appendChild(el('span', value, 'valeur'));
    d.appendChild(s);
    var list = el('ul');
    (lines || []).forEach(function (l) { list.appendChild(line(l)); });
    if (!list.firstChild) d.appendChild(el('p', 'Aucune ligne sur la période.', 'doux'));
    else d.appendChild(list);
    body.appendChild(d);
  }
  function plural(n, one, many) { return n > 1 ? many : one; }
  function renderChiffres(data) {
    var body = $('chiffres-corps');
    clear(body);
    var c = data.contacts || { value: 0, lines: [] };
    figure(body, plural(c.value, 'Contact reçu', 'Contacts reçus'), c.value, c.lines, function (l) {
      var li = el('li', 'Reçu le ' + date(l.at));
      if (ID.test(l.personId)) li.appendChild(ficheButton(l.personId));
      return li;
    });
    var a = data.appointments || { value: 0, lines: [] };
    figure(body, plural(a.value, 'Rendez-vous tenu', 'Rendez-vous tenus'), a.value, a.lines, function (l) { return el('li', (APPOINTMENT_KINDS[l.kind] || 'Rendez-vous') + ', le ' + date(l.at)); });
    var m = data.mandates || { value: 0, lines: [] };
    figure(body, plural(m.value, 'Mandat signé', 'Mandats signés'), m.value, m.lines, function (l) { return el('li', 'Signé le ' + date(l.at)); });
    var v = data.sales || { value: 0, lines: [] };
    figure(body, plural(v.value, 'Vente', 'Ventes'), v.value, v.lines, function (l) { return el('li', 'Acte signé le ' + date(l.signedOn + 'T12:00:00Z')); });
    var f = data.upcomingFees || { value: 0, lines: [] };
    figure(body, 'Honoraires à venir', euros(f.value), f.lines, function (l) { return el('li', euros(l.amountCents) + ' · ' + (FEE_STATUS[l.status] || 'en cours')); });
    body.appendChild(el('p', 'Les honoraires à venir sont vos parts pas encore versées, quelle que soit la période. Ces chiffres sont calculés depuis vos dossiers, jamais saisis ni estimés.', 'doux'));
    body.appendChild(lazyBlock('Mes rapports sur mesure', '/app/rapports-agent.js', 'AIMMO_RAPPORTS_AGENT', ''));
  }
  function wipeChiffres() {
    clear($('chiffres-corps'));
    $('chiffres-etat').textContent = '';
    wipeFinances();
  }
  function openChiffres(range) {
    if (!currentKey) return Promise.resolve(false);
    chiffresRange = range || chiffresRange;
    session += 1;
    wipeChiffres();
    show('chiffres');
    ['mois', 'precedent', 'annee'].forEach(function (r) { $('chiffres-' + r).setAttribute('aria-pressed', r === chiffresRange ? 'true' : 'false'); });
    var p = periodOf(chiffresRange);
    $('chiffres-etat').textContent = 'Chargement…';
    return send('/v1/pilotage/mes-chiffres?du=' + p.from + '&au=' + p.to, 'GET').then(function (res) {
      if (res.gone) return false;
      if (!res.ok) { down($('chiffres-etat'), res.offline); return false; }
      $('chiffres-etat').textContent = 'Du ' + date(p.from + 'T12:00:00Z') + ' au ' + date(p.to + 'T12:00:00Z') + '.';
      renderChiffres(res.body.data || {});
      return true;
    });
  }
${RESEAU_JS}  function saveCsv(path, name, state, failed, done) {
    if (!currentKey) return Promise.resolve(false);
    var mine = session;
    state.textContent = 'Préparation…';
    return api(path, currentKey).then(function (r) {
      if (mine !== session) return false;
      // Une clé refusée efface tout, comme partout ailleurs dans l'application.
      if (r.status === 401 || r.status === 403) {
        return r.json().then(function (b) { return b; }, function () { return null; }).then(function (b) {
          if (mine !== session) return false;
          if (r.status === 401 || (b && b.code === 'agent_inactive')) { forgetKey(currentKey); refuse('Clé refusée. Vérifiez-la ou demandez-en une nouvelle.'); return false; }
          state.textContent = failed;
          return false;
        });
      }
      if (!r.ok) { state.textContent = failed; return false; }
      return r.blob().then(function (blob) {
        if (mine !== session) return false;
        var url = URL.createObjectURL(blob);
        var a = el('a', 'Enregistrer le fichier');
        a.href = url;
        a.download = name;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
        state.textContent = done;
        return true;
      });
    }, function () {
      if (mine === session) state.textContent = 'Pas de réseau. Réessayez dans un moment.';
      return false;
    });
  }
  // Les écrans chargés au premier geste : un seul chargeur, une seule fois chacun, jamais pour une session finie [R201].
  // Pendant que le script arrive, le dernier geste gagne : une demande plus ancienne ne s'affiche pas, la dernière oui.
  var toolCache = {}, toolWait = {};
  function withTool(src, name, state, host, act, tools) {
    if (!currentKey) return Promise.resolve(false);
    if (toolCache[src]) return act(toolCache[src]);
    var mine = session, before = toolWait[src];
    $(state).textContent = 'Chargement…';
    return new Promise(function (resolve) {
      toolWait[src] = function (tool, said) {
        if (mine !== session) { resolve(false); return; }
        if (!tool) { if (said) $(state).textContent = said; resolve(false); return; }
        resolve(act(tool));
      };
      if (before) { before(); return; }
      function done(tool, said) {
        var wait = toolWait[src];
        toolWait[src] = null;
        wait(tool, said);
      }
      var s = document.createElement('script');
      s.setAttribute('src', '/app/' + src + '.js');
      s.addEventListener('load', function () {
        var make = globalThis[name];
        try { delete globalThis[name]; } catch (e) { /* rien */ }
        if (typeof make !== 'function') { done(null, 'Indisponible pour le moment. Réessayez dans un moment.'); return; }
        done(currentKey ? (toolCache[src] = make(tools())) : null);
      });
      s.addEventListener('error', function () { done(null, 'Pas de réseau. Réessayez dans un moment.'); });
      $(host).appendChild(s);
    });
  }
${CLIENTS_JS}${MES_BIENS_JS}${FICHE_JS}${COFFRE_JS}${INVESTIR_JS}${COMMERCES_JS}${AVIS_JS}${A_TENIR_JS}${ACTUALITES_JS}${CLES_A_RENDRE_JS}${NOTIFICATIONS_JS}${OFFRES_JS}${DOSSIER_JS}${MANDAT_JS}${STUDIO_JS}${GAGNER_JS}${ATTIRER_JS}${FICHE_GOOGLE_JS}${INTEGRATION_JS}${REPRISE_JS}${BASCULE_JS}${REGLAGES_MANDAT_JS}${MANDAT_MODELES_JS}${LOYERS_JS}${MESURE_SOURCES_JS}${ANNUAIRE_JS}${PROSPECTION_JS}${BIBLIOTHEQUE_JS}${ENGAGEMENTS_JS}${PHASES_JS}${LICENCES_JS}${CLES_JS}${GUIDES_PHOTO_JS}${CHARGEUR_JS}${FINANCES_JS}
${LOUER_JS}
  function wipeM08() {
    ['visite-corps', 'bien-corps', 'vente-corps'].forEach(function (id) { clear($(id)); });
    ['visite-titre', 'visite-etat', 'bien-titre', 'bien-etat', 'alerte-etat', 'vente-titre', 'vente-etat'].forEach(function (id) { $(id).textContent = ''; });
    $('alerte-etat').hidden = true;
    visitId = null;
    currentBien = null;
    currentVente = null;
    alertId = null;
  }
  function wipeFiche() {
    clear($('fiche-corps'));
    $('fiche-nom').textContent = '';
    $('fiche-etat').textContent = '';
  }
  // AU117 · chaque écran ouvert entre dans l'historique du navigateur : Retour et Avancer le rouvrent tel qu'il était.
  var shownId = null, shownArgs = 'null', fromHistory = false, seenId = null;
  // DS005 · les onglets de l'agent : sa journée, ses outils, ses chiffres. Un écran ouvert depuis un onglet y revient.
  var ROOTS = { accueil: 'journee', clients: 'clients', 'mes-biens': 'mes-biens', outils: 'outils', chiffres: 'chiffres' };
  var tab = 'accueil', agentIn = false;
  function titleOf(id) { return $(id === 'accueil' ? 'bonjour' : id === 'fiche' ? 'fiche-nom' : id + '-titre'); }
  // DS063 · le titre de la page dit l'écran, jamais une personne : la fiche d'un client reste « Fiche client », la
  // journée ne dit pas le prénom. Les écrans d'un bien précisent leur titre par sa référence (« Mandat · REF-1 ») : la
  // page les suit. Les autres gardent le titre écrit dans la page servie, lu au départ : un écran qui y écrit ensuite
  // un prénom (un investisseur, un candidat, un agent) ne le met ni dans l'onglet ni dans l'historique du navigateur.
  var LIVE = /^(visite|bien|un-bien|vente|mandat|offres|avis|studio|dossier|hors-ligne)$/;
  var titled = null, watch = null, fixed = {};
  function retitle(id) {
    if (id) titled = id;
    var h = LIVE.test(titled) ? titleOf(titled) : null;
    var name = titled === 'accueil' ? 'Ma journée' : titled === 'fiche' ? 'Fiche client' : h ? h.textContent : fixed[titled];
    document.title = (name ? name + ' · ' : '') + 'AIMMO';
    if (!id || typeof MutationObserver !== 'function') return;
    if (watch) watch.disconnect();
    if (h) (watch = new MutationObserver(function () { retitle(); })).observe(h, { childList: true, characterData: true, subtree: true });
  }
  var SCREENS = ['connexion', 'invitation', 'accueil', 'clients', 'mes-biens', 'outils', 'attente', 'fiche', 'hors-ligne', 'visite', 'bien', 'un-bien', 'vente', 'apres', 'chiffres', 'reseau', 'partenaires', 'louer', 'investir', 'conformite', 'commerces', 'avis', 'offres', 'dossier', 'mandat', 'studio', 'gagner', 'attirer', 'fiche-google', 'integration'];
  function show(id, args) {
    SCREENS.forEach(function (s) { $(s).hidden = s !== id; });
    var out = id === 'connexion' || id === 'attente' || id === 'invitation';
    if (id === 'connexion') try { $('entrer-appareil').hidden = !localStorage.getItem('aimmo.appareil'); } catch (e) { /* sans mémoire */ }
    // DS006 · « Se déconnecter » se tient au pied de l'écran de départ de chaque rôle, plus dans l'en-tête.
    $('sortir').hidden = !(id === 'outils' || id === 'reseau' || id === 'conformite' || id === 'hors-ligne');
    // Les onglets : pour l'agent entré seulement ; ni à l'entrée, ni sans réseau, ni pour la direction ou la conformité.
    if (ROOTS[id]) tab = id;
    $('onglets').hidden = $('vers-contenu').hidden = !agentIn || out || id === 'hors-ligne';
    Object.keys(ROOTS).forEach(function (r) {
      var b = $(ROOTS[r] + '-ouvrir');
      if (r === tab) b.setAttribute('aria-current', r === id ? 'page' : 'true'); else b.removeAttribute('aria-current');
    });
    PLACE_TOOLS.forEach(function (s) {
      if (s !== id) $(s + '-bien').textContent = '';
      else if (args && args[1]) $(s + '-bien').textContent = placeLine(args[0], args[1]);
    });
    var a = JSON.stringify(args || null);
    if (!out && !fromHistory && (id !== shownId || a !== shownArgs)) try { history[shownId ? 'pushState' : 'replaceState']({ s: id, a: args || null, t: tab }, ''); } catch (e) { /* sans historique */ }
    shownId = out ? null : id;
    shownArgs = a;
    retitle(id);
    // DS064 · le focus suit l'écran : à chaque changement, il va au titre du nouvel écran, que le lecteur d'écran
    // annonce. Pas au premier écran ouvert (la page vient de se charger), ni à l'écran d'attente, qui n'a pas de titre.
    if (id === 'attente') return;
    var t = seenId && seenId !== id && titleOf(id);
    seenId = id;
    if (t && t.focus) { t.tabIndex = -1; t.focus(); }
  }
  function api(path, key, method, body, extra) {
    var headers = { authorization: 'Bearer ' + key };
    if (extra) Object.keys(extra).forEach(function (k) { headers[k] = extra[k]; });
    var init = { method: method || 'GET', headers: headers, cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer' };
    // Un corps qui dit son type (BR102 : une pièce au coffre) part tel quel ; sinon en JSON.
    if (body !== undefined) init.body = headers['content-type'] ? body : (headers['content-type'] = 'application/json', JSON.stringify(body));
    return fetch(path, init);
  }
  function refuse(message) {
    session += 1;
    currentKey = null;
    wipe();
    $('bonjour').textContent = '';
    $('erreur').textContent = message;
    $('erreur').hidden = false;
    show('connexion');
    return false;
  }
  /**
   * Échange le jeton d'invitation contre des clés neuves (Z02), une seule fois. La clé d'agent devient la clé de
   * l'appareil ; celle de la direction, quand il y a les deux, est gardée à côté pour passer d'un écran à l'autre.
   */
  function accept(token) {
    session += 1;
    var mine = session;
    show('attente');
    var init = { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jeton: token }), cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer' };
    return fetch('/v1/acces/invitation', init).then(function (r) {
      return r.json().then(function (b) { return { status: r.status, body: b }; }, function () { return { status: r.status, body: null }; });
    }).then(function (res) {
      if (mine !== session) return false;
      var cles = res.status === 200 && res.body && res.body.data && res.body.data.cles;
      if (!cles || !cles.length) {
        var code = res.body && res.body.error && res.body.error.code;
        if (code === 'invitation_used') return refuse('Ce lien a déjà servi. Demandez un nouveau lien.');
        if (code === 'invitation_expired') return refuse('Ce lien a expiré : il ne vaut que 24 heures. Demandez un nouveau lien.');
        if (res.status >= 500) return refuse('Le service ne répond pas. Rouvrez le lien dans un moment.');
        return refuse('Ce lien d’invitation n’est pas reconnu.');
      }
      var agent = null;
      var direction = null;
      cles.forEach(function (c) {
        if (c && typeof c.cle === 'string' && c.cle.length >= 32) {
          if (c.role === 'agent') agent = c.cle;
          if (c.role === 'direction') direction = c.cle;
        }
      });
      var main = agent || direction;
      if (!main) return refuse('Ce lien d’invitation n’ouvre aucun accès à cette application.');
      forgetKey();
      if (!writeKey(main)) return refuse('Cet appareil ne peut pas garder la clé.');
      if (agent && direction) writeDirectionKey(direction);
      return enter(main);
    }, function () {
      if (mine !== session) return false;
      return refuse('Pas de réseau. Rouvrez votre lien d’accès quand le réseau revient ; s’il a déjà servi, demandez-en un nouveau.');
    });
  }
  /* AU018 : la visite sans réseau, chargée seulement quand elle sert (après la journée, ou sans réseau au démarrage) ; gardée par l'appareil avec la coquille [R201]. */
  var OFF = null;
  function offline(f) {
    if (OFF) return Promise.resolve(f(OFF));
    return new Promise(function (ok) {
      var s = document.createElement('script');
      s.setAttribute('src', '/app/hors-ligne.js');
      s.addEventListener('load', function () { OFF = globalThis.AimmoHorsLigne || null; ok(OFF && f(OFF)); });
      s.addEventListener('error', function () { ok(false); });
      $('hors-ligne').appendChild(s);
    });
  }
  function enter(key) {
    session += 1;
    var mine = session;
    agentIn = false;
    wipe();
    show('attente');
    return api('/v1/moi', key).then(function (r) {
      // Clé refusée : elle est effacée de l'appareil. Une panne ou une erreur du serveur ne l'efface pas.
      if (r.status === 401 || r.status === 403) return { refused: true };
      if (!r.ok) return { refused: false };
      return r.json().then(function (body) { return { body: body }; });
    }).then(function (res) {
      // Une réponse d'une session finie (sortie, autre clé) ne touche plus à rien.
      if (mine !== session) return false;
      var me = res.body && res.body.data;
      // L'agent a sa journée ; la direction a l'écran du réseau (K09) ; le responsable de la conformité a le sien (L10) ;
      // tout autre rôle est refusé ici.
      if (res.refused || (res.body && (!me || (me.role !== 'agent' && me.role !== 'direction' && me.role !== 'compliance')))) {
        forgetKey(key);
        // L'autre clé de l'appareil, si elle reste, garde son accès.
        // Celle de la direction, seule restante, devient la clé de l'appareil.
        if (!readKey() && readDirectionKey()) { var kept = readDirectionKey(); forgetKey(); writeKey(kept); }
        var other = readKey();
        if (other && other !== key) return enter(other);
        return refuse('Clé refusée. Vérifiez-la ou demandez-en une nouvelle.');
      }
      if (!res.body) return refuse('Le service ne répond pas. Réessayez dans un moment.');
      if (me.role === 'compliance') {
        $('erreur').hidden = true;
        currentKey = key;
        return openConformite(true);
      }
      if (me.role === 'direction') {
        if (!reseauHere()) {
          // La direction entre depuis la page de l'agent : l'appareil le note et ouvre sa page, qui porte son écran.
          // Si ce n'est pas la clé d'entrée de l'appareil (« Voir le réseau »), le geste est gardé : sa page y mène.
          try { localStorage.setItem(KEY_RESEAU, key === readKey() ? '1' : 'ouvrir'); } catch (e) { /* sans mémoire */ }
          location.replace(RESEAU_PATH);
          return false;
        }
        $('erreur').hidden = true;
        currentKey = key;
        var agentKey = readKey();
        $('vers-journee').hidden = !agentKey || agentKey === key;
        return openReseau('mois', 'jour');
      }
      var directionKey = readDirectionKey();
      $('vers-reseau').hidden = !directionKey || directionKey === key;
      $('bonjour').textContent = me.firstName ? 'Bonjour ' + me.firstName : 'Bonjour';
      var today = dayLabel(new Date().toISOString());
      $('jour').textContent = today.charAt(0).toUpperCase() + today.slice(1);
      $('erreur').hidden = true;
      currentKey = key;
      agentIn = true;
      show('accueil');
      return day(key, mine).then(function () { if (mine === session) { notifLink(); offline(function (H) { if (mine === session) H.preparer(key, show, enter); }); } return true; });
    }, function () {
      if (mine !== session) return false;
      // AU018 : sans réseau, la visite préparée s'ouvre ; sans paquet du jour, le message d'avant.
      var no = function () { return mine === session && refuse('Pas de réseau. Réessayez dans un moment.'); };
      return offline(function (H) { return H.start(key, show, enter, function () { return mine === session; }, no); }).then(function (r) { return r === false ? no() : !!r; });
    });
  }
  // Un écran se rouvre, relu : par le bouton Retour du navigateur, ou par « Réessayer » après une panne (DS061).
  var goHome = null;
  function reopen(s, a, force) {
    // Une fiche, un bien, une visite ou une mise en vente se rouvrent, relus ; les autres écrans gardent ce qu'ils montraient.
    var again = { fiche: openFiche, bien: openBien, 'un-bien': openPlace, visite: openVisit, vente: openVente, mandat: openMandat, dossier: openDossier, offres: openOffres, avis: openAvis, studio: openStudio }[s];
    // Une lecture encore en route pour l'écran quitté ne s'affiche plus.
    session += 1;
    fromHistory = true;
    // Un écran que le changement d'onglet a vidé est relu, pas rouvert vide ; s'il montre encore quelque chose (un dossier
    // ouvert, un formulaire commencé), il le garde, comme avant.
    var reread = { clients: function () { openClients(); }, 'mes-biens': function () { openMesBiens(); }, chiffres: function () { openChiffres(); }, partenaires: function () { openPartenaires('', 0); }, apres: function () { openApres(); }, louer: function () { openLouer('', 0); }, investir: function () { openInvestir(''); }, commerces: function () { openCommerces(''); }, gagner: function () { openGagner(); } }[s];
    if (again && Array.isArray(a)) again.apply(null, a); else if (reread && (force || !$(s + '-corps').firstChild)) reread(); else show(s);
    fromHistory = false;
  }
  try {
    addEventListener('popstate', function (e) {
      var s = e.state && e.state.s, t = e.state && e.state.t;
      if (!currentKey || !s || !document.getElementById(s)) return;
      // DS005 · l'écran rouvert retrouve l'onglet d'où il avait été ouvert : son « Retour » y ramène.
      if (ROOTS[t]) tab = t;
      reopen(s, e.state.a);
    });
  } catch (e) { /* sans historique */ }
  function boot() {
    SCREENS.forEach(function (i) { var h = document.getElementById(i + '-titre'); if (h) fixed[i] = h.textContent; });
    // AU023 · la clé de l'appareil connecte, sans clé à taper ; le script des clés la porte.
    $('entrer-appareil').addEventListener('click', function () {
      withCles(0, function (c) { return c.login(); }).then(function (r) {
        if (r && r.token && writeKey(r.token)) enter(r.token); else { $('erreur').textContent = (r && r.text) || 'Pas de réseau. Réessayez dans un moment.'; $('erreur').hidden = false; }
      });
    });
    $('form-connexion').addEventListener('submit', function (event) {
      event.preventDefault();
      var key = $('cle').value.trim();
      $('cle').value = '';
      if (key.length < 32) { $('erreur').textContent = 'Une clé compte au moins 32 caractères.'; $('erreur').hidden = false; return; }
      $('erreur').hidden = true;
      if (writeKey(key)) enter(key); else { $('erreur').textContent = 'Cet appareil ne peut pas garder la clé.'; $('erreur').hidden = false; }
    });
    // La fiche revient d'où elle a été ouverte : la journée, ou la liste des clients (DS003).
    $('retour').addEventListener('click', function () { home(); });
    function leave() {
      session += 1;
      place = null;
      wipeFiche();
      wipeClients();
      wipeMesBiens();
      wipeM08();
      wipeApres();
      wipeChiffres();
      wipePartenaires();
      wipeLouer();
      wipeInvestir();
      wipeCommerces();
      wipeGagner();
      wipeAttirer();
      wipeGoogle();
      wipeIntegration();
    }
    function home() {
      if (!currentKey) return;
      leave();
      if (tab === 'outils') { show('outils'); return; }
      if (tab === 'clients') { openClients(); return; }
      if (tab === 'mes-biens') { openMesBiens(); return; }
      show('accueil');
      day(currentKey, session);
    }
    goHome = home;
    $('journee-ouvrir').addEventListener('click', function () { tab = 'accueil'; home(); });
    // Depuis la journée, rien n'est à effacer : ses lectures en route continuent.
    $('outils-ouvrir').addEventListener('click', function () { if (!currentKey) return; if (shownId !== 'accueil' && shownId !== 'outils') leave(); show('outils'); });
    $('clients-ouvrir').addEventListener('click', function () { if (!currentKey) return; leave(); tab = 'clients'; openClients(); });
    $('mes-biens-ouvrir').addEventListener('click', function () { if (!currentKey) return; leave(); tab = 'mes-biens'; openMesBiens(); });
    $('vers-contenu').addEventListener('click', function () { var t = titleOf(shownId); if (t && t.focus) { t.tabIndex = -1; t.focus(); } });
    $('visite-retour').addEventListener('click', home);
    $('apres-retour').addEventListener('click', home);
    $('apres-ouvrir').addEventListener('click', function () { openApres(); });
    $('partenaires-retour').addEventListener('click', home);
    $('partenaires-ouvrir').addEventListener('click', function () { openPartenaires('', 0); });
    $('actualites-ouvrir').addEventListener('click', function () { openActualites('fil'); });
    $('actualites-vues').addEventListener('click', function () { openActualites('vues'); });
    $('cles-rendre-ouvrir').addEventListener('click', openClesARendre);
    $('notifications-ouvrir').addEventListener('click', openNotifications);
    $('louer-retour').addEventListener('click', function () { if (louerId) openLouer(''); else home(); });
    $('louer-ouvrir').addEventListener('click', function () { openLouer('', 0); });
    $('louer-modeles-ouvrir').addEventListener('click', function () { openModeles('louer-modeles'); });
    $('louer-modeles-c-ouvrir').addEventListener('click', function () { openModeles('louer-modeles-c'); });
    $('investir-retour').addEventListener('click', function () { if (investirScreen && investirScreen.inside()) openInvestir(''); else home(); });
    $('investir-ouvrir').addEventListener('click', function () { openInvestir(''); });
    $('commerces-retour').addEventListener('click', function () { if (commercesInside()) openCommerces(''); else home(); });
    $('commerces-ouvrir').addEventListener('click', function () { openCommerces(''); });
    // DS013 · un outil ouvert depuis l'écran d'un bien y revient ; ouvert d'ailleurs, il revient à la journée.
    function back() {
      // Le bien de l'outil montré, pas le dernier bien ouvert : un outil rouvert par l'historique revient au sien.
      var a = JSON.parse(shownArgs), p = a && places[a[0]];
      if (!p) { home(); return; }
      leave();
      openPlace.apply(null, p);
    }
    $('avis-retour').addEventListener('click', function () { wipeAvis(); back(); });
    $('offres-retour').addEventListener('click', function () { wipeOffres(); back(); });
    $('dossier-retour').addEventListener('click', function () { wipeDossier(); home(); });
    $('mandat-retour').addEventListener('click', function () { wipeMandat(); back(); });
    $('studio-retour').addEventListener('click', function () { wipeStudio(); back(); });
    $('un-bien-retour').addEventListener('click', home);
    $('un-bien-vente').addEventListener('click', function () { openVente(place[0], place[1]); });
    $('un-bien-mandat').addEventListener('click', function () { openMandat(place[0], place[1]); });
    $('un-bien-offres').addEventListener('click', function () { openOffres(place[0], place[1]); });
    $('un-bien-avis').addEventListener('click', function () { openAvis(place[0], place[1]); });
    $('un-bien-studio').addEventListener('click', function () { openStudio(place[0], place[1]); });
    $('gagner-retour').addEventListener('click', function () { if (gagnerScreen && gagnerScreen.inside()) openGagner(); else { wipeGagner(); home(); } });
    $('gagner-ouvrir').addEventListener('click', function () { openGagner(); });
    $('attirer-retour').addEventListener('click', function () { if (attirerScreen && attirerScreen.inside()) { openAttirer(); return; } wipeAttirer(); openReseau(reseauRange); });
    $('attirer-ouvrir').addEventListener('click', function () { openAttirer(); });
    $('fiche-google-ouvrir').addEventListener('click', function () { openGoogle(null); });
    $('fiche-google-retour').addEventListener('click', function () { var from = googleAgent; wipeGoogle(); googleAgent = null; if (from) { openAttirer(); return; } home(); });
    $('integration-ouvrir').addEventListener('click', function () { openIntegration('integration'); });
    $('academie-ouvrir').addEventListener('click', function () { openIntegration('academie'); });
    $('candidatures-ouvrir').addEventListener('click', function () { openIntegration('candidatures'); });
    $('reprise-deposer').addEventListener('click', function () { withReprise(function (r) { return r.deposit(); }); });
    $('reprise-voir').addEventListener('click', function () { withReprise(function (r) { return r.show(); }); });
    $('mandat-modeles-ouvrir').addEventListener('click', function () { openMandatModeles('mandat-modeles'); });
    $('mandat-modeles-c-ouvrir').addEventListener('click', function () { openMandatModeles('mandat-modeles-c'); });
    $('regmandat-voir').addEventListener('click', function () { withReglagesMandat(function (r) { return r.show(''); }); });
    $('regmandat-controle').addEventListener('click', function () { withReglagesMandat(function (r) { return r.control(); }); });
    $('loyers-importer').addEventListener('click', function () { withLoyers(function (l) { return l.deposit(); }); });
    $('loyers-lire').addEventListener('click', function () { withLoyers(function (l) { return l.read(); }); });
    $('mesure-voir').addEventListener('click', function () { withMesureSources(function (m) { return m.show(''); }); });
    $('annuaire-ouvrir').addEventListener('click', function () { withAnnuaire(function (a) { return a.show(''); }); });
    $('prospection-ouvrir').addEventListener('click', function () { withProspection(function (p) { return p.show(''); }); });
    $('bibliotheque-ouvrir').addEventListener('click', function () { withBibliotheque(function (b) { return b.show(''); }); });
    $('engagements-voir').addEventListener('click', function () { withEngagements(function (e) { return e.show(''); }); });
    $('phases-voir').addEventListener('click', function () { withPhases(function (p) { return p.show(''); }); });
    $('licences-voir').addEventListener('click', function () { withLicences(function (l) { return l.show(''); }); });
    ['accueil', 'reseau', 'conformite'].forEach(function (p) { $('cles-' + p + '-voir').addEventListener('click', function () { withCles(p, function (c) { return c.show(p, ''); }); }); });
    $('guides-photo-voir').addEventListener('click', function () { withGuidesPhoto(function (g) { return g.show(''); }); });
    $('bascule-voir').addEventListener('click', function () { withBascule(function (b) { return b.show(''); }); });
    $('bascule-canaux').addEventListener('click', function () { withBascule(function (b) { return b.showChannels(''); }); });
    $('bascule-journal').addEventListener('click', function () { withBascule(function (b) { return b.journal(); }); });
    // Dans une fiche d'entretien : retour à la liste ; sinon, la direction revient au réseau, l'agent à sa journée.
    $('integration-retour').addEventListener('click', function () {
      if (integrationScreen && integrationScreen.inside()) { openIntegration(integrationMode); return; }
      var back = integrationMode;
      wipeIntegration();
      if (back === 'candidatures') openReseau(reseauRange); else home();
    });
    $('chiffres-ouvrir').addEventListener('click', function () { if (currentKey && shownId !== 'accueil' && shownId !== 'outils') leave(); openChiffres('mois'); });
    ['mois', 'precedent', 'annee'].forEach(function (r) { $('chiffres-' + r).addEventListener('click', function () { openChiffres(r); }); });
    $('vente-retour').addEventListener('click', back);
    ['mois', 'precedent', 'annee'].forEach(function (r) { $('reseau-' + r).addEventListener('click', function () { openReseau(r); }); });
    $('rapport-agent-lire').addEventListener('click', function () { readReport('agent', 'chiffres'); });
    $('rapport-direction-lire').addEventListener('click', function () { readReport('direction', 'reseau'); });
    $('commissions-voir').addEventListener('click', function () { readCommissions(); });
    $('euros-voir').addEventListener('click', function () { readEuros(); });
    $('grille-voir').addEventListener('click', function () { readGrille(); });
    $('factures-voir').addEventListener('click', function () { readFactures(); });
    $('factures-export').addEventListener('click', function () { exportFactures(); });
    $('reseau-cas').addEventListener('click', function () { saveCsv('/v1/qualifications/cas-corriges', 'cas-corriges.csv', $('reseau-cas-etat'), 'Cas corrigés indisponibles. Réessayez plus tard.', 'Cas corrigés téléchargés. À garder hors du dépôt.'); });
    $('bien-retour').addEventListener('click', function () { if (visitId) openVisit(visitId); else home(); });
    $('alerte').addEventListener('click', function () { raiseAlert(false); });
    $('sortir').addEventListener('click', function () {
      session += 1;
      currentKey = null;
      forgetKey();
      try { localStorage.removeItem('aimmo.brouillons'); } catch (e) { /* rien */ }
      $('bonjour').textContent = $('jour').textContent = '';
      agentIn = false;
      tab = 'accueil';
      wipe();
      show('connexion');
    });
    $('vers-reseau').addEventListener('click', function () { var k = readDirectionKey(); if (k) enter(k); });
    $('vers-journee').addEventListener('click', function () { var k = readKey(); if (k) enter(k); });
    $('conformite-actualiser').addEventListener('click', function () { if (currentKey) { session += 1; wipeModeles(); wipeMandatModeles(); openConformite(); } });
    var hash = typeof location !== 'undefined' ? String(location.hash || '') : '';
    var invited = INVITATION.exec(hash);
    if (hash.indexOf('#invitation=') === 0) {
      // Le jeton quitte aussitôt la barre d'adresse et l'historique, qu'il ait servi ou non.
      try { if (typeof history !== 'undefined') history.replaceState(null, '', '/app/'); } catch (e) { /* rien à remplacer */ }
    }
    if (invited) {
      // Z05 : ouvrir le lien ne consomme rien. Un aperçu de lien, un navigateur intégré ou une double ouverture
      // n'échangent jamais le jeton : seul le clic sur « Entrer sur ce téléphone » le fait, une seule fois.
      var pending = invited[1];
      show('invitation');
      $('entrer-invitation').addEventListener('click', function () {
        var token = pending;
        pending = null;
        if (token) accept(token);
      });
    } else if (hash.indexOf('#invitation=') === 0) {
      refuse('Lien d’invitation incomplet. Ouvrez votre lien d’accès en entier.');
    } else {
      var key = readKey();
      // DS069 · la direction avait demandé son écran depuis la page de l'agent : elle y arrive, sans second geste.
      try { if (localStorage.getItem(KEY_RESEAU) === 'ouvrir') { localStorage.setItem(KEY_RESEAU, '1'); key = readDirectionKey() || key; } } catch (e) { /* sans mémoire */ }
      if (key) enter(key); else show('connexion');
    }
    var offline = 'Cet appareil ne garde pas l’application : elle ne s’ouvrira qu’avec du réseau.';
    function warn() { $('note').textContent = offline; $('note').hidden = false; }
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('/app/sw.js', { scope: '/app/' }).catch(warn); else warn();
  }
  document.addEventListener('DOMContentLoaded', function () {
    var want = false;
    try { want = !!(localStorage.getItem(KEY_RESEAU) || localStorage.getItem(KEY_DIRECTION)); } catch (e) { /* sans mémoire */ }
    if (!want || reseauHere()) return boot();
    // L'appareil de la direction ouvre sa page. Sans réseau, il garde celle-ci : la journée et le mode sans réseau tiennent.
    return fetch('/app/reseau', { method: 'HEAD', credentials: 'omit', referrerPolicy: 'no-referrer' }).then(function (r) {
      if (r.ok) location.replace(RESEAU_PATH + (location.hash || '')); else boot();
    }, function () { boot(); });
  });
})();
`;

/**
 * Le service worker : il garde la coquille pour un démarrage rapide, et laisse tout le reste au réseau, sans jamais
 * le mettre en cache. Une réponse de l'API n'est jamais gardée sur l'appareil.
 */
export const swJs = (cache: string, shell: readonly string[]): string => `'use strict';
var CACHE = ${JSON.stringify(cache)};
var SHELL = ${JSON.stringify(shell)};
self.addEventListener('install', function (event) {
  event.waitUntil(caches.open(CACHE).then(function (cache) { return cache.addAll(SHELL); }));
});
self.addEventListener('activate', function (event) {
  event.waitUntil(caches.keys().then(function (names) {
    return Promise.all(names.filter(function (n) { return n !== CACHE; }).map(function (n) { return caches.delete(n); }));
  }));
});
self.addEventListener('fetch', function (event) {
  var url = new URL(event.request.url);
  // DS069 · la page de la direction n'est pas gardée, pour qu'aucun agent ne la télécharge. Sans réseau, elle se replie
  // sur la coquille : la journée et les visites préparées s'ouvrent aussi depuis son adresse [R278].
  var kept = url.pathname === '/app/reseau' ? '/app/' : url.pathname;
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || SHELL.indexOf(kept) === -1) return;
  event.respondWith(fetch(event.request).catch(function () { return caches.match(kept); }));
});
`;

export const MANIFEST = JSON.stringify({
  name: 'AIMMO',
  short_name: 'AIMMO',
  lang: 'fr',
  start_url: '/app/',
  scope: '/app/',
  display: 'standalone',
  background_color: PALETTE.clair.papier,
  theme_color: PALETTE.clair.papier,
  icons: [{ src: '/app/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }],
});

export const ICON_SVG = DESIGN_ICON_SVG;

