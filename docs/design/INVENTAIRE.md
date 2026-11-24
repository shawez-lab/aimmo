# Inventaire des surfaces d’AIMMO

Relevé du 24 novembre 2026, sur le commit `4c0a0dbc`. Il accompagne `AUDIT.md`.

## Les écrans de l’application

L’application est une seule page (`packages/api/app/fichiers.ts`) : chaque écran est une section, affichée seule.

| Écran | Qui le voit | À quoi il sert |
| --- | --- | --- |
| connexion | tout le monde | Entrer avec son lien d’accès ou sa clé |
| accueil | agent | « Ma journée » : rappels, rendez-vous, biens, et l’entrée de tous les outils |
| fiche | agent | La fiche d’un client : rappels, projets, classement, biens, accords |
| visite | agent | Une visite : le brief, le compte rendu, le bon de visite |
| bien | agent | Créer ou compléter un bien |
| vente | agent | « Mettre en vente » : mentions, annonce phrase par phrase, publication |
| mandat | agent | Le mandat du bien : préparer, contrôler, signer, avenant |
| offres | agent | Les offres reçues et leur registre |
| dossier | agent | Le dossier de vente, du compromis à l’acte |
| avis | agent | L’avis de valeur |
| studio | agent | Photos, vidéo, plan et publications du bien |
| apres | agent | « Mes ventes conclues » : avis, relances |
| partenaires | agent | Les mises en relation avec les partenaires |
| louer | agent | Les mises en location |
| investir | agent | Les investisseurs : rendement, note |
| commerces | agent | Les cessions de commerces |
| gagner | agent | « Gagner des mandats » : estimations à venir, pige, tournée, veille, site, calendrier |
| fiche-google | agent | Avis et publications de la fiche Google |
| integration | agent | « Mon intégration » et l’académie |
| chiffres | agent | « Mes chiffres » : parcours, commissions, rapports |
| hors-ligne | agent | Les visites sans réseau |
| reseau | direction | La console du réseau : 35 blocs |
| conformite | conformité | Décisions, coffre, modèles |
| attirer | direction | Le site, la publicité, la lettre |

## Les modules chargés à la demande

Chaque module est un script servi sous `/app/`, chargé au premier geste.

| Module | Qui le voit | À quoi il sert | Fichier |
| --- | --- | --- | --- |
| hors-ligne | agent | La visite sans réseau, gardée par l'appareil avec la coquille | `packages/api/app/hors-ligne.ts` |
| alertes | agent | Les alertes de l'agent | `packages/api/app/alertes.ts` |
| sequences-jour | agent | Les étapes du jour des séquences | `packages/api/app/sequences-jour.ts` |
| a-tenir | agent | Ce qu'il y a à tenir sur les ventes | `packages/api/app/a-tenir.ts` |
| actualites | agent | « Mes actualités » sur l'accueil | `packages/api/app/actualites.ts` |
| cles-a-rendre | agent | « Mes clés à rendre » sur l'accueil | `packages/api/app/cles-a-rendre.ts` |
| armoire | agent | L'armoire des clés d'un bien | `packages/api/app/armoire.ts` |
| panneaux | agent | Les panneaux, sur l'accueil de l'agent et dans « Mettre en vente », par le chargeur commun | `packages/api/app/panneaux.ts` |
| appels | agent | Les gestes d'appel de la fiche | `packages/api/app/appels.ts` |
| classement | agent | Le classement de la fiche et sa correction | `packages/api/app/classement.ts` |
| biens-fiche | agent | Les biens du client et leur création depuis la fiche | `packages/api/app/biens-fiche.ts` |
| sequence-fiche | agent | La préparation d'une séquence de prospection | `packages/api/app/sequence-fiche.ts` |
| recherche | agent | La recherche en langage courant d'un acquéreur | `packages/api/app/recherche.ts` |
| secteur-carte | agent | la carte où l'agent dessine le secteur d'une recherche | `packages/api/app/secteur-carte.ts` |
| reprise | direction | Le dépôt des fichiers de la reprise | `packages/api/app/reprise.ts` |
| conformite | conformité | L'écran du responsable de la conformité | `packages/api/app/conformite.ts` |
| investir | agent | L'écran « Investir » | `packages/api/app/investir.ts` |
| commerces | agent | L'écran « Commerces » | `packages/api/app/commerces.ts` |
| commerces-engagements | agent | Les demandes et l'engagement de confidentialité | `packages/api/app/commerces-engagements.ts` |
| commerces-repreneurs | agent | Les repreneurs et le rapprochement, de même | `packages/api/app/commerces-repreneurs.ts` |
| commerces-textes | agent | Corriger la présentation anonyme, de même | `packages/api/app/commerces-textes.ts` |
| espace-agent | agent | Ouvrir l'espace d'un client depuis sa fiche | `packages/api/app/espace-agent.ts` |
| louer | agent | L'écran « Louer » de l'application de l'agent, en morceaux posés dans `fichiers.ts` : sa section de page, son entrée sur l'accueil, sa mise en page et | `packages/api/app/louer.ts` |
| louer-modeles | agent | Le formulaire de l'état des lieux, la remise des clés et la gestion | `packages/api/app/louer-modeles.ts` |
| mandat-modeles | agent | Les modèles de mandat et d'avenant à l'écran, servis à part (`/app/mandat-modeles.js`) | `packages/api/app/mandat-modeles.ts` |
| louer-dossier | agent | Compléter un dossier de candidature à l'écran, servi à part (`/app/louer-dossier.js`) | `packages/api/app/louer-dossier.ts` |
| louer-edl | agent | Le formulaire de l'état des lieux d'entrée, servi à part (`/app/louer-edl.js`) et chargé au premier geste, pour que l'écran « Louer » tienne son budge | `packages/api/app/louer-edl.ts` |
| louer-faits | agent | Les faits du logement à louer, servis à part (`/app/louer-faits.js`) et chargés au geste « Saisir » ou « Corriger les faits », pour que l'écran « Loue | `packages/api/app/louer-faits.ts` |
| louer-remise | agent | La remise des clés et la gestion par un partenaire à l'écran, servies à part (`/app/louer-remise.js`) | `packages/api/app/louer-remise.ts` |
| avis | agent | L'écran « Studio » | `packages/api/app/avis.ts` |
| offres | agent | L'écran « Offres » | `packages/api/app/offres.ts` |
| dossier | agent | L'écran « Dossier de vente » | `packages/api/app/dossier.ts` |
| mandat | agent | L'écran « Mandat », de même | `packages/api/app/mandat.ts` |
| studio | agent | L'écran « Studio » de l'application de l'agent, en morceaux posés dans `fichiers.ts` : sa section de page, son chargeur et son script, servi à part (` | `packages/api/app/studio.ts` |
| gagner | agent | L'écran « Gagner des mandats » | `packages/api/app/gagner.ts` |
| pige | agent | La pige des annonces de particuliers | `packages/api/app/pige.ts` |
| tournee | agent | La tournée de prospection et la carte des opportunités | `packages/api/app/tournee.ts` |
| site | agent | L'écran « Gérer mon site » de l'agent, servi à part (`/app/site.js`) et chargé seulement quand l'agent ouvre la partie « Mon site » de l'écran « Gagne | `packages/api/app/site.ts` |
| neuf | agent | La grille de mes programmes neufs | `packages/api/app/neuf.ts` |
| viager | agent | Le calcul de viager de l'agent | `packages/api/app/viager.ts` |
| neuf-direction | direction | Les programmes neufs de la direction | `packages/api/app/neuf-direction.ts` |
| banque | direction | La banque et les relances d'impayés de la direction, sous les engagements | `packages/api/app/banque.ts` |
| rapports | direction | Les rapports sur mesure de la direction, sous les engagements | `packages/api/app/rapports.ts` |
| rapports-agent | agent | Les rapports sur mesure de l'agent, au bas de « Mes chiffres », par le chargeur commun | `packages/api/app/rapports.ts` |
| veille-dpe | agent | L'écran de la veille des nouveaux diagnostics énergétiques, servi à part (`/app/veille-dpe.js`) et chargé seulement quand l'agent ouvre la partie « Ve | `packages/api/app/veille-dpe.ts` |
| attirer | direction | L'écran « Attirer » de la direction | `packages/api/app/attirer.ts` |
| bascule | agent | La bascule sur l'écran du réseau | `packages/api/app/bascule.ts` |
| reglages-mandat | direction | Les réglages du mandat pour la direction | `packages/api/app/reglages-mandat.ts` |
| loyers | direction | Les loyers de marché pour la direction | `packages/api/app/loyers.ts` |
| mesure-sources | direction | La mesure des sources pour la direction | `packages/api/app/mesure-sources.ts` |
| annuaire | direction | L'annuaire des partenaires pour la direction | `packages/api/app/annuaire.ts` |
| prospection | direction | La prospection des partenaires pour la direction | `packages/api/app/prospection.ts` |
| bibliotheque | direction | La bibliothèque sous licence pour la direction | `packages/api/app/bibliotheque.ts` |
| engagements | direction | Les engagements de service pour la direction | `packages/api/app/engagements.ts` |
| scenarios | direction | Les scénarios automatiques de la direction | `packages/api/app/scenarios.ts` |
| reclamations-reglage | agent | Le délai de réponse aux réclamations et le médiateur | `packages/api/app/reclamations-reglage.ts` |
| gel-registre | conformité | BR85 · Le registre national des gels importé en un appui par le responsable de la conformité | `packages/api/app/gel-registre.ts` |
| dossier-lcb | conformité | Le dossier anti-blanchiment de l'agence sous licence | `packages/api/app/dossier-lcb.ts` |
| mandat-questionnaire | agent | Le mandat par questionnaire | `packages/api/app/mandat-questionnaire.ts` |
| copropriete | agent | La copropriété et l'urbanisme résumés | `packages/api/app/copropriete.ts` |
| avant-contrat | agent | L'avant-contrat | `packages/api/app/avant-contrat.ts` |
| remises | agent | Les remises négociées | `packages/api/app/remises.ts` |
| phases | direction | Les phases et les régions sur l'écran du réseau : la direction lit l'état des cinq phases et ouvre la suivante, lit les 18 régions, en ouvre ou en fer | `packages/api/app/phases.ts` |
| communes | direction | Les communes à pourvoir pour la direction | `packages/api/app/communes.ts` |
| cout-agent | direction | Le coût complet de l'agent moyen à l'écran de la direction : pour un mois fini de Paris, la part du réseau, le coût complet par poste, la provision et | `packages/api/app/cout-agent.ts` |
| publicite | direction | La publicité payante pour la direction | `packages/api/app/publicite.ts` |
| lettre | direction | La lettre et le magazine pour la direction | `packages/api/app/lettre.ts` |
| calendrier | agent | Le calendrier de publication de l'agent | `packages/api/app/calendrier.ts` |
| licences | direction | Les licences du logiciel sur l'écran du réseau : la direction du réseau qui donne les licences lit le tarif en vigueur et les licences données, fixe u | `packages/api/app/licences.ts` |
| reprise-contenus | agent | Le contenu des fichiers de la reprise | `packages/api/app/reprise-contenus.ts` |
| cles | agent | La clé de cet appareil et la preuve d'une action | `packages/api/app/cles.ts` |
| guides-photo | direction | Les guides photo à valider pour la direction | `packages/api/app/guides-photo.ts` |
| fin-de-bail | agent | La fin de bail notée depuis la fiche | `packages/api/app/fin-de-bail.ts` |
| appels-recus | agent | BR61 · Les appels reçus, relus dans la fiche | `packages/api/app/appels-recus.ts` |
| notes-vocales | agent | Les notes vocales transcrites de la fiche | `packages/api/app/notes-vocales.ts` |
| dictee | agent | La création à la voix | `packages/api/app/dictee.ts` |
| reclamations | agent | BR69 · Les réclamations dans la fiche (HX58, routes de BR01) | `packages/api/app/reclamations.ts` |
| coffre | agent | Le dépôt d'une pièce au coffre depuis la fiche | `packages/api/app/conformite.ts` |
| visites-en-ligne | agent | Les visites réservées en ligne à rattacher | `packages/api/app/visites-en-ligne.ts` |
| bon-visite | agent | Le bon de visite signé sans papier | `packages/api/app/bon-visite.ts` |
| recommandation | agent | Recommander un proche depuis la fiche | `packages/api/app/recommandation.ts` |
| finances | agent | Les finances | `packages/api/app/finances.ts` |
| fiche-bien | agent | La fiche du bien | `packages/api/app/fiche-bien.ts` |
| fiche-google | agent | L'écran « Fiche Google » | `packages/api/app/fiche-google.ts` |
| integration | agent | Les écrans de M14, « Mon intégration », « Académie » et « Candidatures » | `packages/api/app/integration.ts` |
| notifications | agent | Les notifications de l'agent | `packages/api/app/notifications.ts` |
| sw | agent |  | `packages/api/app/?.ts` |

## Les pages publiques et les espaces

| Page | Qui la voit | Fichier (sous `packages/`) |
| --- | --- | --- |
| Accueil du réseau ou d’un agent | tout le monde | `core/src/attirer/accueil-site.ts` |
| Liste des biens | tout le monde | `core/src/attirer/liste-biens.ts` |
| Page d’un bien et sa fiche imprimable | tout le monde | `core/src/annonces/page-bien.ts` |
| Page d’un agent | tout le monde | `core/src/attirer/page-agent.ts` |
| Listes des agents et des communes | tout le monde | `core/src/attirer/annuaire-site.ts` |
| Prix par commune | tout le monde | `core/src/attirer/page-prix.ts` |
| Quartier | tout le monde | `core/src/attirer/quartier.ts` |
| Estimation en ligne | vendeurs | `core/src/attirer/page-estimation.ts` |
| Simulateur de prêt | acquéreurs | `core/src/attirer/simulateur-pret.ts` |
| Recherche en langage courant | acquéreurs | `core/src/recherche/page-publique.ts` |
| Vitrine | tout le monde | `core/src/recherche/vitrine.ts` |
| Mentions légales et données personnelles | tout le monde | `core/src/attirer/mentions-site.ts` |
| Rejoindre AIMMO | candidats | `api/src/candidature.ts` |
| Espace du client (vendeur, propriétaire, acquéreur) | clients | `api/src/espaces.ts` |
| Espace partenaire | partenaires | `api/app/partenaire.ts` |
| Bon de visite à signer, puis son exemplaire | visiteurs | `api/src/bon-visite-public.ts`, `core/src/visites/signature-bon.ts` |
| Visite à distance | acquéreurs | `core/src/medias/visite-distance.ts` |
| Présentation en rendez-vous | vendeurs | `core/src/presentation/presentation.ts` |
| Certificat d’une photo | tout le monde | `api/src/certificat-photo.ts` |
| Désinscriptions, opposition, lien inconnu, avis après la vente | clients | `core/src/design/systeme.ts` (`renderPublicPage`) |

## Les documents imprimés

| Document | Qui le lit | Fichier (sous `packages/`) |
| --- | --- | --- |
| Fiche imprimable du bien | acquéreurs | `core/src/annonces/page-bien.ts` |
| Avis de valeur imprimé | vendeurs | `core/src/estimation/avis-imprime.ts` |
| Documents à signer (mandat, avenant, bail, bon de visite) | clients | `core/src/documents/modeles.ts` |
| Dossier de présentation | vendeurs | `core/src/mandats/gagner/dossier-presentation.ts` |
| Lettres de quartier | habitants | `core/src/mandats/gagner/lettres-quartier.ts` |
| Supports du Studio : carte de visite, affichette, panneau, lettre | tout le monde | `core/src/studio/supports.ts`, `core/src/boutique/supports.ts` |
| Lettre et magazine | clients | `core/src/marketing/lettre.ts` |

## Les messages envoyés aux clients

Les mails, SMS et messages WhatsApp sont du texte, sans gabarit. Ils passent tous par le contrôle central des envois (`packages/core/src/envoi/`), qui ajoute la mention de l’assistant. Les textes sont écrits dans chaque module : première réponse, rendez-vous, point de la semaine, relance de pièces, compte rendu de visite, demande d’avis, dates clés, codes de signature.
