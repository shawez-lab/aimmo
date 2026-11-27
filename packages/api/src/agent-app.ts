/**
 * L'application de l'agent, première version (A01) : une page web installable servie par le Worker lui-même, sans
 * construction ni dépendance. Elle ne lit que par l'API, sous les droits de l'agent [R16]. Le téléphone ne garde que
 * la coquille de l'application ; aucune réponse de l'API n'est mise en cache, aucune donnée de client n'y reste.
 * La clé personnelle de l'agent est saisie une fois, gardée sur son appareil, envoyée seulement dans l'en-tête
 * `Authorization`, jamais dans une adresse ni au journal [R13].
 */

import { ACTUALITES_SCRIPT } from '../app/actualites.ts';
import { CLES_A_RENDRE_SCRIPT } from '../app/cles-a-rendre.ts';
import { ARMOIRE_SCRIPT } from '../app/armoire.ts';
import { PANNEAUX_SCRIPT } from '../app/panneaux.ts';
import { A_TENIR_SCRIPT } from '../app/a-tenir.ts';
import { ALERTES_SCRIPT } from '../app/alertes.ts';
import { SEQUENCES_JOUR_SCRIPT } from '../app/sequences-jour.ts';
import { APPELS_SCRIPT } from '../app/appels.ts';
import { CLASSEMENT_SCRIPT } from '../app/classement.ts';
import { BIENS_FICHE_SCRIPT } from '../app/biens-fiche.ts';
import { SEQUENCE_FICHE_SCRIPT } from '../app/sequence-fiche.ts';
import { RECHERCHE_SCRIPT } from '../app/recherche.ts';
import { SECTEUR_CARTE_SCRIPT } from '../app/secteur-carte.ts';
import { AVIS_SCRIPT } from '../app/avis.ts';
import { OFFRES_SCRIPT } from '../app/offres.ts';
import { DOSSIER_SCRIPT } from '../app/dossier.ts';
import { MANDAT_SCRIPT } from '../app/mandat.ts';
import { COMMERCES_SCRIPT } from '../app/commerces.ts';
import { COMMERCES_ENGAGEMENTS_SCRIPT } from '../app/commerces-engagements.ts';
import { COMMERCES_REPRENEURS_SCRIPT } from '../app/commerces-repreneurs.ts';
import { COMMERCES_TEXTES_SCRIPT } from '../app/commerces-textes.ts';
import { ESPACE_AGENT_SCRIPT } from '../app/espace-agent.ts';
import { LOUER_SCRIPT } from '../app/louer.ts';
import { LOUER_DOSSIER_SCRIPT } from '../app/louer-dossier.ts';
import { LOUER_EDL_SCRIPT } from '../app/louer-edl.ts';
import { LOUER_FAITS_SCRIPT } from '../app/louer-faits.ts';
import { LOUER_MODELES_SCRIPT } from '../app/louer-modeles.ts';
import { MANDAT_MODELES_SCRIPT } from '../app/mandat-modeles.ts';
import { LOUER_REMISE_SCRIPT } from '../app/louer-remise.ts';
import { REPRISE_SCRIPT } from '../app/reprise.ts';
import { COFFRE_SCRIPT, CONFORMITE_SCRIPT } from '../app/conformite.ts';
import { INVESTIR_SCRIPT } from '../app/investir.ts';
import { STUDIO_SCRIPT } from '../app/studio.ts';
import { GAGNER_SCRIPT } from '../app/gagner.ts';
import { PIGE_SCRIPT } from '../app/pige.ts';
import { SITE_SCRIPT } from '../app/site.ts';
import { TOURNEE_SCRIPT } from '../app/tournee.ts';
import { VEILLE_DPE_SCRIPT } from '../app/veille-dpe.ts';
import { COMMUNES_SCRIPT } from '../app/communes.ts';
import { COUT_AGENT_SCRIPT } from '../app/cout-agent.ts';
import { PUBLICITE_SCRIPT } from '../app/publicite.ts';
import { LETTRE_SCRIPT } from '../app/lettre.ts';
import { CALENDRIER_SCRIPT } from '../app/calendrier.ts';
import { ATTIRER_SCRIPT } from '../app/attirer.ts';
import { BASCULE_SCRIPT } from '../app/bascule.ts';
import { REGLAGES_MANDAT_SCRIPT } from '../app/reglages-mandat.ts';
import { LOYERS_SCRIPT } from '../app/loyers.ts';
import { MESURE_SOURCES_SCRIPT } from '../app/mesure-sources.ts';
import { ANNUAIRE_SCRIPT } from '../app/annuaire.ts';
import { PROSPECTION_SCRIPT } from '../app/prospection.ts';
import { BIBLIOTHEQUE_SCRIPT } from '../app/bibliotheque.ts';
import { ENGAGEMENTS_SCRIPT } from '../app/engagements.ts';
import { LICENCES_SCRIPT } from '../app/licences.ts';
import { REPRISE_CONTENUS_SCRIPT } from '../app/reprise-contenus.ts';
import { CLES_SCRIPT } from '../app/cles.ts';
import { DOSSIER_LCB_SCRIPT } from '../app/dossier-lcb.ts';
import { MANDAT_QUESTIONNAIRE_SCRIPT } from '../app/mandat-questionnaire.ts';
import { PHASES_SCRIPT } from '../app/phases.ts';
import { GUIDES_PHOTO_SCRIPT } from '../app/guides-photo.ts';
import { SCENARIOS_SCRIPT } from '../app/scenarios.ts';
import { FIN_DE_BAIL_SCRIPT } from '../app/fin-de-bail.ts';
import { APPELS_RECUS_SCRIPT } from '../app/appels-recus.ts';
import { NOTES_VOCALES_SCRIPT } from '../app/notes-vocales.ts';
import { DICTEE_SCRIPT } from '../app/dictee.ts';
import { RECLAMATIONS_SCRIPT } from '../app/reclamations.ts';
import { RECLAMATIONS_REGLAGE_SCRIPT } from '../app/reclamations-reglage.ts';
import { GEL_REGISTRE_SCRIPT } from '../app/gel-registre.ts';
import { COPROPRIETE_SCRIPT } from '../app/copropriete.ts';
import { AVANT_CONTRAT_SCRIPT } from '../app/avant-contrat.ts';
import { REMISES_SCRIPT } from '../app/remises.ts';
import { NEUF_SCRIPT } from '../app/neuf.ts';
import { NEUF_DIRECTION_SCRIPT } from '../app/neuf-direction.ts';
import { BANQUE_SCRIPT } from '../app/banque.ts';
import { RAPPORTS_AGENT_SCRIPT, RAPPORTS_SCRIPT } from '../app/rapports.ts';
import { VIAGER_SCRIPT } from '../app/viager.ts';
import { VISITES_EN_LIGNE_SCRIPT } from '../app/visites-en-ligne.ts';
import { BON_VISITE_SCRIPT } from '../app/bon-visite.ts';
import { RECOMMANDATION_SCRIPT } from '../app/recommandation.ts';
import { FINANCES_SCRIPT } from '../app/finances.ts';
import { FICHE_GOOGLE_SCRIPT } from '../app/fiche-google.ts';
import { FICHE_BIEN_SCRIPT } from '../app/fiche-bien.ts';
import { INTEGRATION_SCRIPT } from '../app/integration.ts';
import { NOTIFICATIONS_SCRIPT } from '../app/notifications.ts';
import { HORS_LIGNE_PATH, HORS_LIGNE_SCRIPT } from '../app/hors-ligne.ts';
import { APP_CSS, APP_JS, ICON_SVG, INDEX_HTML, MANIFEST, RESEAU_HTML, swJs } from '../app/fichiers.ts';

export const AGENT_APP_PATH = '/app';
/** Version de la coquille : changer ce nom remplace le cache de l'appareil. */
export const AGENT_APP_CACHE = 'aimmo-app-v2';
/**
 * Les seuls fichiers que l'appareil garde : la coquille, rien d'autre. La visite sans réseau (AU018) en fait partie : elle
 * doit s'ouvrir en mode avion. Ses données (le paquet du jour, sans client, et la boîte d'envoi) sont dans IndexedDB,
 * jamais dans le cache [R276, R278].
 */
export const AGENT_APP_SHELL: readonly string[] = Object.freeze(['/app/', '/app/app.css', '/app/app.js', HORS_LIGNE_PATH, '/app/manifest.webmanifest', '/app/icon.svg']);

/** Politique de contenu : rien d'extérieur, aucun script en ligne, aucun appel hors de ce Worker. */
export const AGENT_APP_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; manifest-src 'self'; worker-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

const SW_JS = swJs(AGENT_APP_CACHE, AGENT_APP_SHELL);

/**
 * Le script servi sans ses lignes de commentaire (J14) : une ligne qui n'est qu'un commentaire, de ligne ou de bloc,
 * ne change rien à ce que le script fait ; la retirer garde l'application dans son budget [R201]. Un commentaire de bloc
 * sur plusieurs lignes, ouvert en tête de ligne et fermé en bout de ligne, part aussi (BR74) ; un bloc jamais fermé reste.
 * Rien d'autre n'est touché : ni chaîne, ni code, ni commentaire en bout de ligne.
 */
export function stripCommentLines(js: string): string {
  const lines = js.split('\n');
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^\s*\/\/.*$/.test(line) || /^\s*\/\*.*\*\/\s*$/.test(line)) continue;
    // BR74 : un commentaire de bloc sur plusieurs lignes, ouvert seul en tête de ligne et fermé seul en bout de ligne.
    if (/^\s*\/\*/.test(line) && !line.includes('*/')) {
      let end = i + 1;
      while (end < lines.length && !lines[end]!.includes('*/')) end++;
      if (end < lines.length && /\*\/\s*$/.test(lines[end]!) && lines[end]!.indexOf('*/') === lines[end]!.lastIndexOf('*/')) {
        i = end;
        continue;
      }
    }
    kept.push(line);
  }
  return kept.join('\n');
}

/**
 * Le script servi sans l'indentation de ses lignes (BR50) : le script de l'application n'a ni gabarit à accents graves
 * ni chaîne coupée en fin de ligne, l'espace en tête de ligne n'y change donc rien ; le retirer garde l'application dans
 * son budget [R201]. Si l'une de ces deux formes y apparaît un jour, le script reste tel quel.
 */
export function trimIndent(js: string): string {
  if (js.includes('`') || /\\\n/.test(js)) return js;
  return js.replace(/^[ \t]+/gm, '');
}

const FILES: Readonly<Record<string, { body: string; type: string }>> = Object.freeze({
  '/app/': { body: INDEX_HTML, type: 'text/html; charset=utf-8' },
  // DS069 · l'écran de la direction, à part : la coquille ne le demande que pour elle. Hors de la coquille gardée hors ligne.
  '/app/reseau.html': { body: RESEAU_HTML, type: 'text/html; charset=utf-8' },
  '/app/app.css': { body: APP_CSS, type: 'text/css; charset=utf-8' },
  '/app/app.js': { body: trimIndent(stripCommentLines(APP_JS)), type: 'text/javascript; charset=utf-8' },
  // La visite sans réseau (AU018), gardée par l'appareil avec la coquille [R276, R277, R278].
  [HORS_LIGNE_PATH]: { body: trimIndent(stripCommentLines(HORS_LIGNE_SCRIPT)), type: 'text/javascript; charset=utf-8' },
  // Les alertes de l'agent (C09c), chargées seulement s'il en a, jamais gardées sur l'appareil [R201].
  '/app/alertes.js': { body: ALERTES_SCRIPT, type: 'text/javascript; charset=utf-8' },
  // Les étapes du jour des séquences (BR32), chargées seulement s'il y en a au plan, jamais gardées sur l'appareil [R201].
  '/app/sequences-jour.js': { body: SEQUENCES_JOUR_SCRIPT, type: 'text/javascript; charset=utf-8' },
  // Ce qu'il y a à tenir sur les ventes (W26), chargé seulement s'il y en a, jamais gardé sur l'appareil [R201].
  '/app/a-tenir.js': { body: A_TENIR_SCRIPT, type: 'text/javascript; charset=utf-8' },
  // « Mes actualités » sur l'accueil (BR49), chargées au premier geste, jamais gardées sur l'appareil [R201].
  '/app/actualites.js': { body: ACTUALITES_SCRIPT, type: 'text/javascript; charset=utf-8' },
  // « Mes clés à rendre » sur l'accueil (BR50), chargées au premier geste, jamais gardées sur l'appareil [R201].
  '/app/cles-a-rendre.js': { body: CLES_A_RENDRE_SCRIPT, type: 'text/javascript; charset=utf-8' },
  // L'armoire des clés d'un bien (BR51), chargée au geste depuis « Mettre en vente », jamais gardée [R201].
  '/app/armoire.js': { body: ARMOIRE_SCRIPT, type: 'text/javascript; charset=utf-8' },
  // Les panneaux (BR104), sur l'accueil de l'agent et dans « Mettre en vente », par le chargeur commun [R201, R284].
  '/app/panneaux.js': { body: PANNEAUX_SCRIPT, type: 'text/javascript; charset=utf-8' },
  // Les gestes d'appel de la fiche (AC12), chargés à l'ouverture d'une fiche où ils servent [R201].
  '/app/appels.js': { body: APPELS_SCRIPT, type: 'text/javascript; charset=utf-8' },
  // Le classement de la fiche et sa correction (Q08), chargés à l'ouverture d'une fiche classée [R201].
  '/app/classement.js': { body: CLASSEMENT_SCRIPT, type: 'text/javascript; charset=utf-8' },
  // Les biens du client et leur création depuis la fiche (SV06), chargés à l'ouverture d'une fiche [R201].
  '/app/biens-fiche.js': { body: BIENS_FICHE_SCRIPT, type: 'text/javascript; charset=utf-8' },
  // La préparation d'une séquence de prospection (BR34), chargée au geste depuis la fiche, jamais gardée [R201].
  '/app/sequence-fiche.js': { body: SEQUENCE_FICHE_SCRIPT, type: 'text/javascript; charset=utf-8' },
  // La recherche en langage courant d'un acquéreur (BR40), chargée au geste depuis la fiche, jamais gardée [R201].
  '/app/recherche.js': { body: RECHERCHE_SCRIPT, type: 'text/javascript; charset=utf-8' },
  // AU073b · la carte où l'agent dessine le secteur d'une recherche, chargée au geste.
  '/app/secteur-carte.js': { body: SECTEUR_CARTE_SCRIPT, type: 'text/javascript; charset=utf-8' },
  // Le dépôt des fichiers de la reprise (I05), chargé au premier geste de la direction [R201].
  '/app/reprise.js': { body: REPRISE_SCRIPT, type: 'text/javascript; charset=utf-8' },
  // L'écran du responsable de la conformité (L10), chargé à la demande pour sa seule clé, jamais gardé sur l'appareil.
  '/app/conformite.js': { body: CONFORMITE_SCRIPT, type: 'text/javascript; charset=utf-8' },
  // L'écran « Investir » (Y09), chargé à sa première ouverture pour garder le budget de l'application.
  '/app/investir.js': { body: INVESTIR_SCRIPT, type: 'text/javascript; charset=utf-8' },
  // L'écran « Commerces » (CE11), chargé à la demande quand l'agent l'ouvre, jamais gardé sur l'appareil [R201].
  '/app/commerces.js': { body: COMMERCES_SCRIPT, type: 'text/javascript; charset=utf-8' },
  // Les demandes et l'engagement de confidentialité (CE14), chargés au premier geste [R201].
  '/app/commerces-engagements.js': { body: COMMERCES_ENGAGEMENTS_SCRIPT, type: 'text/javascript; charset=utf-8' },
  // Les repreneurs et le rapprochement (CE15), de même.
  '/app/commerces-repreneurs.js': { body: COMMERCES_REPRENEURS_SCRIPT, type: 'text/javascript; charset=utf-8' },
  // Corriger la présentation anonyme (CE19), de même.
  '/app/commerces-textes.js': { body: COMMERCES_TEXTES_SCRIPT, type: 'text/javascript; charset=utf-8' },
  // Ouvrir l'espace d'un client depuis sa fiche (EC12), chargé au premier geste [R201].
  '/app/espace-agent.js': { body: ESPACE_AGENT_SCRIPT, type: 'text/javascript; charset=utf-8' },
  '/app/louer.js': { body: LOUER_SCRIPT, type: 'text/javascript; charset=utf-8' },
  // Le formulaire de l'état des lieux, la remise des clés et la gestion (W16), chargés au premier geste [R201].
  '/app/louer-modeles.js': { body: LOUER_MODELES_SCRIPT, type: 'text/javascript; charset=utf-8' },
  '/app/mandat-modeles.js': { body: MANDAT_MODELES_SCRIPT, type: 'text/javascript; charset=utf-8' },
  '/app/louer-dossier.js': { body: LOUER_DOSSIER_SCRIPT, type: 'text/javascript; charset=utf-8' },
  '/app/louer-edl.js': { body: LOUER_EDL_SCRIPT, type: 'text/javascript; charset=utf-8' },
  '/app/louer-faits.js': { body: LOUER_FAITS_SCRIPT, type: 'text/javascript; charset=utf-8' },
  '/app/louer-remise.js': { body: LOUER_REMISE_SCRIPT, type: 'text/javascript; charset=utf-8' },
  // L'écran « Studio » (X11), chargé à sa première ouverture, jamais gardé sur l'appareil [R201].
  // L'écran « Avis de valeur » (E10), chargé à sa première ouverture, jamais gardé sur l'appareil [R201].
  '/app/avis.js': { body: AVIS_SCRIPT, type: 'text/javascript; charset=utf-8' },
  // L'écran « Offres » (O10), chargé à sa première ouverture, jamais gardé sur l'appareil [R201].
  '/app/offres.js': { body: OFFRES_SCRIPT, type: 'text/javascript; charset=utf-8' },
  // L'écran « Dossier de vente » (N12), chargé à sa première ouverture, jamais gardé sur l'appareil [R201].
  '/app/dossier.js': { body: DOSSIER_SCRIPT, type: 'text/javascript; charset=utf-8' },
  // L'écran « Mandat » (D12), de même.
  '/app/mandat.js': { body: MANDAT_SCRIPT, type: 'text/javascript; charset=utf-8' },
  '/app/studio.js': { body: STUDIO_SCRIPT, type: 'text/javascript; charset=utf-8' },
  // L'écran « Gagner des mandats » (G13), chargé à sa première ouverture, jamais gardé sur l'appareil [R201].
  '/app/gagner.js': { body: GAGNER_SCRIPT, type: 'text/javascript; charset=utf-8' },
  // La pige des annonces de particuliers (BR33), chargée depuis l'écran « Gagner des mandats », jamais gardée [R201].
  '/app/pige.js': { body: PIGE_SCRIPT, type: 'text/javascript; charset=utf-8' },
  // La tournée de prospection et la carte des opportunités (BR35), chargées depuis « Gagner des mandats », jamais gardées [R201].
  '/app/tournee.js': { body: TOURNEE_SCRIPT, type: 'text/javascript; charset=utf-8' },
  '/app/site.js': { body: SITE_SCRIPT, type: 'text/javascript; charset=utf-8' },
  // La grille de mes programmes neufs (BR78), chargée depuis « Gagner des mandats », jamais gardée [R201].
  '/app/neuf.js': { body: NEUF_SCRIPT, type: 'text/javascript; charset=utf-8' },
  // Le calcul de viager de l'agent (BR81), chargé depuis « Gagner des mandats », jamais gardé [R201].
  '/app/viager.js': { body: VIAGER_SCRIPT, type: 'text/javascript; charset=utf-8' },
  // Les programmes neufs de la direction (BR79), chargés sous « Engagements de service », jamais gardés [R201].
  '/app/neuf-direction.js': { body: NEUF_DIRECTION_SCRIPT, type: 'text/javascript; charset=utf-8' },
  // La banque et les relances d'impayés de la direction (BR93), sous les engagements, chargées au premier geste [R201].
  '/app/banque.js': { body: BANQUE_SCRIPT, type: 'text/javascript; charset=utf-8' },
  // Les rapports sur mesure de la direction (BR94), sous les engagements, chargés au premier geste [R201].
  '/app/rapports.js': { body: RAPPORTS_SCRIPT, type: 'text/javascript; charset=utf-8' },
  // Les rapports sur mesure de l'agent (BR95), au bas de « Mes chiffres », par le chargeur commun [R201, R68].
  '/app/rapports-agent.js': { body: RAPPORTS_AGENT_SCRIPT, type: 'text/javascript; charset=utf-8' },
  '/app/veille-dpe.js': { body: VEILLE_DPE_SCRIPT, type: 'text/javascript; charset=utf-8' },
  // L'écran « Attirer » de la direction (AT12), chargé à sa première ouverture, jamais gardé sur l'appareil [R201].
  '/app/attirer.js': { body: ATTIRER_SCRIPT, type: 'text/javascript; charset=utf-8' },
  // La bascule sur l'écran du réseau (B05), chargée au premier geste, jamais gardée sur l'appareil [R201].
  '/app/bascule.js': { body: BASCULE_SCRIPT, type: 'text/javascript; charset=utf-8' },
  // Les réglages du mandat pour la direction (D13), chargés au premier geste, jamais gardés sur l'appareil [R201].
  '/app/reglages-mandat.js': { body: REGLAGES_MANDAT_SCRIPT, type: 'text/javascript; charset=utf-8' },
  // Les loyers de marché pour la direction (Y10), chargés au premier geste, jamais gardés sur l'appareil [R201].
  '/app/loyers.js': { body: LOYERS_SCRIPT, type: 'text/javascript; charset=utf-8' },
  // La mesure des sources pour la direction (G14), chargée au premier geste, jamais gardée sur l'appareil [R201].
  '/app/mesure-sources.js': { body: MESURE_SOURCES_SCRIPT, type: 'text/javascript; charset=utf-8' },
  // L'annuaire des partenaires pour la direction (U13), chargé au premier geste, jamais gardé sur l'appareil [R201].
  '/app/annuaire.js': { body: ANNUAIRE_SCRIPT, type: 'text/javascript; charset=utf-8' },
  // La prospection des partenaires pour la direction (U14), chargée au premier geste, jamais gardée sur l'appareil [R201].
  '/app/prospection.js': { body: PROSPECTION_SCRIPT, type: 'text/javascript; charset=utf-8' },
  // La bibliothèque sous licence pour la direction (X13), chargée au premier geste, jamais gardée sur l'appareil [R201].
  '/app/bibliotheque.js': { body: BIBLIOTHEQUE_SCRIPT, type: 'text/javascript; charset=utf-8' },
  // Les engagements de service pour la direction (G15), chargés au premier geste, jamais gardés sur l'appareil [R201].
  '/app/engagements.js': { body: ENGAGEMENTS_SCRIPT, type: 'text/javascript; charset=utf-8' },
  // Les scénarios automatiques de la direction (BR57), chargés depuis « Engagements de service », jamais gardés [R201].
  '/app/scenarios.js': { body: SCENARIOS_SCRIPT, type: 'text/javascript; charset=utf-8' },
  // Le délai de réponse aux réclamations et le médiateur (BR70), chargés depuis « Engagements de service », jamais gardés [R201].
  '/app/reclamations-reglage.js': { body: RECLAMATIONS_REGLAGE_SCRIPT, type: 'text/javascript; charset=utf-8' },
  '/app/gel-registre.js': { body: GEL_REGISTRE_SCRIPT, type: 'text/javascript; charset=utf-8' },
  // Le dossier anti-blanchiment de l'agence sous licence (BR114), chargé au geste de son responsable de la conformité [R662].
  '/app/dossier-lcb.js': { body: DOSSIER_LCB_SCRIPT, type: 'text/javascript; charset=utf-8' },
  // Le mandat par questionnaire (BR116), chargé au geste depuis l'écran « Mandat », jamais gardé [R201, R440].
  '/app/mandat-questionnaire.js': { body: MANDAT_QUESTIONNAIRE_SCRIPT, type: 'text/javascript; charset=utf-8' },
  // La copropriété et l'urbanisme résumés (BR88), chargés depuis « Dossier de vente », jamais gardés [R201].
  '/app/copropriete.js': { body: COPROPRIETE_SCRIPT, type: 'text/javascript; charset=utf-8' },
  // L'avant-contrat (BR91), chargé depuis « Dossier de vente », jamais gardé [R201].
  '/app/avant-contrat.js': { body: AVANT_CONTRAT_SCRIPT, type: 'text/javascript; charset=utf-8' },
  // Les remises négociées (BR73), chargées depuis « Engagements de service » ou « Mettre en vente », jamais gardées [R201].
  '/app/remises.js': { body: REMISES_SCRIPT, type: 'text/javascript; charset=utf-8' },
  '/app/phases.js': { body: PHASES_SCRIPT, type: 'text/javascript; charset=utf-8' },
  // Les communes à pourvoir pour la direction (BR38), chargées depuis « Phases et régions », jamais gardées [R201].
  '/app/communes.js': { body: COMMUNES_SCRIPT, type: 'text/javascript; charset=utf-8' },
  '/app/cout-agent.js': { body: COUT_AGENT_SCRIPT, type: 'text/javascript; charset=utf-8' },
  // La publicité payante pour la direction (BR110), chargée depuis « Attirer », jamais gardée [R201].
  '/app/publicite.js': { body: PUBLICITE_SCRIPT, type: 'text/javascript; charset=utf-8' },
  // La lettre et le magazine pour la direction (BR111), chargés depuis « Attirer », jamais gardés [R201].
  '/app/lettre.js': { body: LETTRE_SCRIPT, type: 'text/javascript; charset=utf-8' },
  // Le calendrier de publication de l'agent (BR111), chargé depuis « Gagner des mandats », jamais gardé [R201].
  '/app/calendrier.js': { body: CALENDRIER_SCRIPT, type: 'text/javascript; charset=utf-8' },
  '/app/licences.js': { body: LICENCES_SCRIPT, type: 'text/javascript; charset=utf-8' },
  // Le contenu des fichiers de la reprise (BR83), chargé depuis « Reprendre mes données », jamais gardé [R201].
  '/app/reprise-contenus.js': { body: REPRISE_CONTENUS_SCRIPT, type: 'text/javascript; charset=utf-8' },
  // La clé de cet appareil et la preuve d'une action (BR18), chargées au premier geste, jamais gardées [R201].
  '/app/cles.js': { body: CLES_SCRIPT, type: 'text/javascript; charset=utf-8' },
  // Les guides photo à valider pour la direction (X23), chargés au premier geste, jamais gardés sur l'appareil [R201].
  '/app/guides-photo.js': { body: GUIDES_PHOTO_SCRIPT, type: 'text/javascript; charset=utf-8' },
  // La fin de bail notée depuis la fiche (G15), chargée au premier geste, jamais gardée sur l'appareil [R201].
  '/app/fin-de-bail.js': { body: FIN_DE_BAIL_SCRIPT, type: 'text/javascript; charset=utf-8' },
  '/app/appels-recus.js': { body: APPELS_RECUS_SCRIPT, type: 'text/javascript; charset=utf-8' },
  // Les notes vocales transcrites de la fiche (BR62), chargées au premier geste, jamais gardées sur l'appareil [R201].
  '/app/notes-vocales.js': { body: NOTES_VOCALES_SCRIPT, type: 'text/javascript; charset=utf-8' },
  // La création à la voix (BR101), chargée au premier geste depuis « Ma journée », jamais gardée sur l'appareil [R201].
  '/app/dictee.js': { body: DICTEE_SCRIPT, type: 'text/javascript; charset=utf-8' },
  '/app/reclamations.js': { body: RECLAMATIONS_SCRIPT, type: 'text/javascript; charset=utf-8' },
  // Le dépôt d'une pièce au coffre depuis la fiche (BR102), chargé au geste, jamais gardé sur l'appareil [R201].
  '/app/coffre.js': { body: COFFRE_SCRIPT, type: 'text/javascript; charset=utf-8' },
  // Les visites réservées en ligne à rattacher (BR64), chargées au premier geste, jamais gardées sur l'appareil [R201].
  '/app/visites-en-ligne.js': { body: VISITES_EN_LIGNE_SCRIPT, type: 'text/javascript; charset=utf-8' },
  // Le bon de visite signé sans papier (AU075), chargé au premier geste depuis la visite, jamais gardé [R201].
  '/app/bon-visite.js': { body: BON_VISITE_SCRIPT, type: 'text/javascript; charset=utf-8' },
  // Recommander un proche depuis la fiche (X22), chargé au premier geste, jamais gardé sur l'appareil [R201].
  '/app/recommandation.js': { body: RECOMMANDATION_SCRIPT, type: 'text/javascript; charset=utf-8' },
  // Les finances (K10), chargées au premier geste, jamais gardées sur l'appareil [R201].
  '/app/finances.js': { body: FINANCES_SCRIPT, type: 'text/javascript; charset=utf-8' },
  // La fiche du bien (X19), chargée au premier geste, jamais gardée sur l'appareil [R201].
  '/app/fiche-bien.js': { body: FICHE_BIEN_SCRIPT, type: 'text/javascript; charset=utf-8' },
  // L'écran « Fiche Google » (AT14), chargé à sa première ouverture, jamais gardé sur l'appareil [R201].
  '/app/fiche-google.js': { body: FICHE_GOOGLE_SCRIPT, type: 'text/javascript; charset=utf-8' },
  // Les écrans de M14, « Mon intégration », « Académie » et « Candidatures » (J14), chargés à leur première ouverture [R201].
  '/app/integration.js': { body: INTEGRATION_SCRIPT, type: 'text/javascript; charset=utf-8' },
  // Les notifications de l'agent (BR67), chargées au geste ou par le lien d'une notification [R201].
  '/app/notifications.js': { body: NOTIFICATIONS_SCRIPT, type: 'text/javascript; charset=utf-8' },
  '/app/sw.js': { body: SW_JS, type: 'text/javascript; charset=utf-8' },
  '/app/manifest.webmanifest': { body: MANIFEST, type: 'application/manifest+json; charset=utf-8' },
  '/app/icon.svg': { body: ICON_SVG, type: 'image/svg+xml' },
});

/** Les fichiers de l'application, pour les tests. */
export const AGENT_APP_FILES: Readonly<Record<string, string>> = Object.freeze(Object.fromEntries(Object.entries(FILES).map(([k, v]) => [k, v.body])));

/**
 * Le lien d'une notification (BR67, R415) : `/notifications/<envoi>` renvoie vers l'application, qui ouvre le détail de
 * l'envoi une fois l'agent entré. Rien n'est lu ici : ni clé, ni base ; un identifiant mal formé n'est pas à elle.
 */
export const NOTIFICATION_LINK = /^\/notifications\/([A-Za-z0-9_-]{1,64})$/;

/** Sert un fichier de l'application, ou null si l'adresse n'est pas à elle. */
export function handleAgentApp(request: Request): Response | null {
  const url = new URL(request.url);
  const link = NOTIFICATION_LINK.exec(url.pathname);
  if (link && (request.method === 'GET' || request.method === 'HEAD')) {
    return new Response(null, {
      status: 302,
      headers: { location: `${AGENT_APP_PATH}/#envoi=${link[1]}`, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff' },
    });
  }
  if (url.pathname !== AGENT_APP_PATH && !url.pathname.startsWith(`${AGENT_APP_PATH}/`)) return null;
  const headers: Record<string, string> = {
    'content-security-policy': AGENT_APP_CSP,
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'x-frame-options': 'DENY',
    'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=()',
    'cross-origin-opener-policy': 'same-origin',
  };
  if (url.pathname === AGENT_APP_PATH) return new Response(null, { status: 308, headers: { ...headers, location: '/app/' } });
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Méthode non admise.', { status: 405, headers: { ...headers, 'content-type': 'text/plain; charset=utf-8', allow: 'GET, HEAD' } });
  }
  const file = FILES[url.pathname];
  if (!file) return new Response('Page inconnue.', { status: 404, headers: { ...headers, 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });
  return new Response(request.method === 'HEAD' ? null : file.body, {
    status: 200,
    headers: {
      ...headers,
      'content-type': file.type,
      // La coquille se revalide à chaque ouverture ; le service worker se cherche toujours à nouveau.
      'cache-control': 'no-cache',
      ...(url.pathname === '/app/sw.js' ? { 'service-worker-allowed': '/app/' } : {}),
    },
  });
}
