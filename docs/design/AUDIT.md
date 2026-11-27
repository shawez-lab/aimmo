# Audit de design d'AIMMO

Audit du 24 novembre 2026, sur le commit `4c0a0dbc` de `main`. Consigne : `chantier/taches/DS00.md`.

## En dix lignes

Ce qui coûte le plus à l'agent et au client aujourd'hui, et ce que la refonte change pour eux.

1. **L'accueil est une pile de 23 cartes égales** : 5,4 écrans de haut même sans aucun dossier. Avec un portefeuille chargé, il fait 288 écrans. La refonte montre d'abord ce qui presse, borne chaque liste et range le reste derrière une barre d'onglets (DS001, DS002, DS005).
2. **L'agent ne peut ni chercher ni parcourir ses clients et ses biens.** Une fiche ne s'ouvre que si le client est « chaud » ou a rendez-vous aujourd'hui. La refonte ajoute la recherche et les deux listes, que le cahier promet (DS003, DS004).
3. **Un bien n'a ni nom, ni photo, ni écran à lui** : il s'appelle « B-E6B8BB51 » sur six écrans séparés. La refonte lui donne une fiche unique, avec sa photo, son adresse, son prix et ses étapes en onglets (DS013, DS019, DS023).
4. **Aucune action ne domine** : jusqu'à neuf boutons pleins par écran, tous bordeaux. La refonte garde un seul bouton plein par écran, dans la zone du pouce (DS022, DS070).
5. **La fiche d'un client fait cinq écrans**, avec treize champs toujours ouverts et aucune synthèse en tête. La refonte ouvre sur qui est la personne, ce qu'elle veut et le prochain geste (DS010, DS038).
6. **L'espace du vendeur montre des valeurs internes** (« signe », « prevue ») et colle la source de chaque chiffre dans la phrase. Son seul bouton plein est « Me déconnecter ». La refonte en fait un suivi de vente lisible, avec la prochaine étape et le contact de l'agent (DS078 à DS082).
7. **Le site public est une liste de liens**, et la page d'un bien n'a ni galerie, ni faits clés, ni bouton pour visiter. La refonte en fait une vitrine à la hauteur d'un bien de prestige, en français et en anglais (DS071, DS072, DS073).
8. **Sur ordinateur, tout tient dans une colonne de 608 px** au milieu d'un écran de 1 440. La refonte donne une vraie mise en page large : liste à gauche, détail à droite (DS033).
9. **La marque change de visage** : titres dans la police de repli de chaque appareil, bordeaux qui vire au rose en sombre, aucune image nulle part. La refonte fixe une voix typographique, une palette tenue dans les deux modes et la place de la photo (DS015, DS017, DS019).
10. **Les budgets de poids sont pleins** : la coquille pèse 48 446 octets pour 49 152 permis. La refonte doit donc alléger avant d'ajouter, en commençant par l'écran de la direction que chaque agent télécharge sans le voir (DS068, DS069).

## Méthode et limites

- **Rendu.** Chaque surface a été rendue dans Chrome sans tête, avec la vraie API sur une base en mémoire et des données inventées : le parcours fictif `packages/core/test/parcours-complet.ts`, arrêté à cinq étapes différentes, et un portefeuille chargé de 1 000 clients et 400 biens. Formats : 390 × 844 et 1 440 × 900, en clair et en sombre.
- **Parcours.** Un robot a cliqué chaque bouton de l'accueil, puis ceux des écrans ouverts, pour l'agent, la direction et la conformité : 260 états capturés, chacun avec son plan en texte.
- **Mesures.** Sur 21 écrans : hauteur, boutons pleins, blocs vides, cibles tactiles, focus, reflow à 320 px, texte à 200 %, axe-core (WCAG 2.2 AA).
- **Pages publiques et documents.** Les 24 pages de `packages/api/test/design.test.ts` et les quatre pages de l'espace client, avec axe-core.
- **Messages.** Les mails que le parcours prépare, lus dans la boîte d'essai.
- **Ce qui n'a pas pu être rendu.** Le Studio, les partenaires, le dossier d'agent et les clés d'appareil répondent « Indisponible » sur le poste d'audit, faute de stockage branché : seul leur état d'erreur a été vu. Les pages de prix, de quartier, la page d'un agent, la liste des biens, la vitrine et les supports imprimés du Studio n'ont pas été rendus : ils sont jugés sur leur code, qui suit le même gabarit.
- **Concurrents.** Le poste d'audit ne peut pas ouvrir leurs sites dans un navigateur. Ils sont lus en texte, sources citées en fin de document. Aucune capture de concurrent. Les pages de Sotheby's, Engel & Völkers, Compass, Stripe, Airbnb et Apple n'ont pas pu être relues : la comparaison avec elles repose sur ce qui est connu d'elles, sans citation.

## Ce qui est déjà bien, et qu'il faut garder

- **L'honnêteté des textes.** « Ce n'est pas le prix de votre logement : sans visite, personne ne peut le dire. » Chaque chiffre dit sa source. Aucun concurrent étudié n'écrit comme ça.
- **L'accessibilité de base.** axe-core ne trouve aucune violation sur les 21 écrans mesurés ni sur les pages publiques d'écran. Le contraste tient en clair et en sombre, le focus se voit toujours, rien ne déborde à 320 px, 72 zones annoncent leurs changements aux lecteurs d'écran.
- **La saisie.** Chaque champ a son étiquette. Les champs chiffrés ouvrent le bon clavier (`inputmode`). Les brouillons sont gardés.
- **La discipline du système.** Une seule base de styles, contrôlée par les tests : aucune couleur ni police hors système. C'est ce qui permet de transformer 90 écrans en changeant un seul fichier.
- **Le poids.** Une page publique arrive en un aller-retour. Rien d'extérieur n'est chargé.

## Les problèmes

Chaque problème a son identifiant, sa gravité, sa catégorie et son effort (S : moins d'une journée, M : quelques jours, L : une semaine ou plus). « Où » donne la surface et le fichier. Les captures sont dans `docs/design/captures/audit/`.

### A. Navigation et architecture de l'information

#### DS001 · L'accueil est une pile de 23 cartes égales
- Gravité : bloquant · Catégorie : architecture de l'information · Effort : L
- Où : « Ma journée » — `packages/api/app/fichiers.ts` (`#accueil`)
- Preuve : `appli-accueil.jpg`. Sans aucun dossier, l'accueil fait 5,4 écrans et compte 23 blocs, dont 6 vides. Avec un bien, 5,7 écrans.
- Principe : ce qui presse d'abord. « Contacts chauds » et « Rendez-vous du jour » ont le même poids que « Mes panneaux » et « Clés de mes appareils ».
- Solution : l'accueil ne garde que la journée : à faire maintenant, rendez-vous, biens en cours. Tout le reste passe dans les onglets (DS005). Un bloc vide ne s'affiche pas.
- Suite : corrigé le 2026-11-27 : la journée ne garde que la journée (les outils sont dans leur onglet), les rendez-vous remontent en deuxième, la date du jour se lit sous le bonjour, et un bloc vide tient sur une ligne avec son état. Sur le parcours de démonstration : 1,6 écran au lieu de 5,3 ; journée vide : 1,2 écran au lieu de 5,4. Avant et après : `captures/avant-apres/DS001-journee.jpg`.

#### DS002 · L'accueil n'a pas de limite
- Gravité : bloquant · Catégorie : architecture de l'information · Effort : M
- Où : « Contacts chauds à rappeler », « Mes biens à mettre en vente » — `packages/api/app/fichiers.ts`
- Preuve : `appli-accueil-portefeuille-charge.jpg`. Avec 1 000 rappels en attente et 400 biens, l'accueil fait 243 424 px, soit 288 écrans, et porte 2 019 boutons. Les 1 000 contacts sont listés d'un bloc, 4,5 par écran. Tout ce qui suit est hors d'atteinte.
- Principe : une liste montre ce qu'on peut traiter, puis propose la suite.
- Solution : cinq lignes par liste, triées par urgence, puis « Tout voir » vers la liste complète (DS003). Les retards sont regroupés : « 37 en retard ».
- Suite : corrigé le 2026-11-27 : « Contacts chauds à rappeler » et « Mes biens à mettre en vente » montrent cinq lignes, puis « Voir la suite : 995 autres » en déroule vingt de plus. Avec 1 000 rappels et 400 biens : 4 écrans et 35 boutons, au lieu de 288 écrans et 2 019 boutons ; la hauteur est mesurée dans Chromium par un test. Restent pour DS003 et DS004 : la liste complète avec sa recherche, et les retards regroupés.

#### DS003 · Aucune liste ni recherche de clients
- Gravité : bloquant · Catégorie : navigation · Effort : L
- Où : toute l'application — `packages/api/app/fichiers.ts`
- Preuve : la coquille n'appelle que `/v1/contacts-chauds`, `/v1/rendez-vous/jour`, `/v1/plan-du-jour` et `/v1/fiches/<id>`. Au stade « rendez-vous pris » du parcours, la vendeuse qui vient d'écrire n'est joignable depuis aucun écran : elle n'est plus « chaude » et son rendez-vous n'est pas aujourd'hui.
- Principe : le cahier promet à l'agent « ses clients, biens et dossiers » (onglet Le produit).
- Solution : un onglet « Clients » avec recherche par nom, téléphone ou bien, et filtres (vendeurs, acquéreurs, à rappeler). Une recherche générale dans l'en-tête.

#### DS004 · Aucune liste de biens
- Gravité : bloquant · Catégorie : navigation · Effort : L
- Où : toute l'application
- Preuve : un bien n'apparaît que dans « Mes biens à mettre en vente », plafonné à 200 lignes sans recherche. Une fois vendu, il n'est plus que dans « Mes ventes conclues ».
- Solution : un onglet « Biens » : cartes avec photo, adresse, prix et état, recherche et filtres par état.

#### DS005 · Aucune navigation permanente
- Gravité : majeur · Catégorie : navigation · Effort : L
- Où : toute l'application
- Preuve : aucun élément `nav`. Le seul lien entre écrans est « Retour à ma journée ». Passer du mandat aux offres du même bien demande : retour, défilement jusqu'au bien, « Offres ».
- Principe : on sait toujours où l'on est et comment aller ailleurs.
- Solution : une barre de cinq onglets en bas sur téléphone (Journée, Clients, Biens, Outils, Chiffres), une colonne à gauche sur ordinateur.
- Suite : corrigé le 2026-11-27 : une barre d'onglets pour l'agent, Journée, Outils et Chiffres, en bas sur téléphone et en colonne à gauche sur ordinateur ; un écran ouvert depuis un onglet y revient. Clients et Biens auront leur onglet avec leur liste (DS003, DS004). Avant et après : `captures/avant-apres/DS005-onglets.jpg`, `DS005-onglets-ordinateur.jpg`.

#### DS006 · « Se déconnecter » occupe la meilleure place
- Gravité : majeur · Catégorie : navigation · Effort : S
- Où : en-tête de chaque écran — `packages/api/app/fichiers.ts` l. 68
- Preuve : toutes les captures. L'en-tête ne porte que la marque et ce bouton.
- Solution : l'en-tête porte le titre de l'écran, la recherche et les notifications. La déconnexion passe dans « Mon compte ».
- Suite : corrigé le 2026-11-27 : l'en-tête ne porte plus que la marque ; « Se déconnecter » est au pied de l'écran « Outils » (du réseau pour la direction, de la conformité, des visites sans réseau). Le titre, la recherche et les notifications dans l'en-tête viendront avec les listes (DS003, DS004).

#### DS007 · Aucun écran n'a d'adresse
- Gravité : majeur · Catégorie : navigation · Effort : M
- Où : toute l'application — fonction `show`
- Preuve : ouvrir « Mandat », recharger : l'accueil revient, l'adresse est restée `/app/`.
- Principe : sur ordinateur, on recharge, on ouvre deux onglets, on met en favori.
- Solution : une adresse par écran (`/app/#bien=<id>/mandat`), relue à l'ouverture. Aucune donnée de client dans l'adresse, seulement des identifiants internes.

#### DS008 · « Le réseau » empile 35 blocs
- Gravité : majeur · Catégorie : architecture de l'information · Effort : L
- Où : console de la direction — `packages/api/app/fichiers.ts` (`#reseau`)
- Preuve : `appli-reseau-chiffres-connexion.jpg`. 12 écrans, 35 blocs dont 11 vides, 33 boutons. Alertes, factures, réglages du mandat, loyers, sauvegardes et preuve à Dijon se suivent sans ordre.
- Solution : cinq rubriques : Aujourd'hui (alertes, à valider), Chiffres, Agents, Réglages, Technique.

#### DS009 · « Conformité » empile 13 blocs
- Gravité : majeur · Catégorie : architecture de l'information · Effort : M
- Où : écran du responsable de la conformité — `packages/api/app/conformite.ts`
- Preuve : 6,3 écrans, 13 blocs, 7 boutons pleins.
- Solution : trois onglets : À décider, Coffre, Modèles.

#### DS010 · La fiche d'un client fait cinq écrans, sans synthèse
- Gravité : majeur · Catégorie : architecture de l'information · Effort : L
- Où : fiche client — `packages/api/app/fichiers.ts` (`#fiche`) et modules chargés
- Preuve : `appli-fiche-client.jpg`. 5,2 écrans, 14 blocs dont 6 réduits à un bouton, 9 boutons pleins. La fiche ouvre sur un prénom et un nom, sans rôle, sans coordonnées, sans dernier échange.
- Solution : un en-tête de fiche : nom, rôle, bien lié, dernier échange, prochain geste et moyens de contact permis. Dessous, des onglets : Fil, Projets, Biens, Accords.

#### DS011 · Les outils secondaires pèsent autant que le cœur du métier
- Gravité : majeur · Catégorie : hiérarchie · Effort : M
- Où : accueil
- Preuve : remises, panneaux, clés, notifications, actualités, intégration, Fiche Google, locations, investisseurs, commerces : dix blocs sur 23, chacun avec une phrase d'explication permanente.
- Solution : un onglet « Outils », en grille, sans phrase permanente.
- Suite : corrigé le 2026-11-27 : les outils ont quitté la journée (de 5,3 à 2,2 écrans sur le parcours de démonstration) pour l'onglet « Outils », un index d'une rangée par outil, en trois groupes, sans phrase permanente : 1,6 écran. La phrase des locations qui portait un engagement est sur l'écran des locations. Avant et après : `captures/avant-apres/DS011-outils.jpg`.

#### DS012 · Des cartes vides, réduites à un bouton
- Gravité : mineur · Catégorie : composants · Effort : S
- Où : accueil (3), fiche client (6), « Mettre en vente » (2)
- Preuve : `appli-accueil.jpg` : « Mes remises négociées », « Mes panneaux ».
- Solution : une ligne de liste avec chevron, ou une entrée de l'onglet « Outils ».

#### DS013 · Un bien n'a pas d'écran à lui
- Gravité : majeur · Catégorie : navigation · Effort : L
- Où : « Mettre en vente », « Mandat », « Offres », « Avis de valeur », « Studio », « Dossier de vente »
- Preuve : six écrans séparés, ouverts par cinq boutons pleins de même poids sur l'accueil, chacun avec son « Retour à ma journée ».
- Solution : une fiche du bien, avec ses étapes en onglets et un fil d'avancement : estimé, sous mandat, en vente, offre, compromis, vendu.

#### DS014 · « Gagner des mandats » déplie sept outils l'un sous l'autre
- Gravité : majeur · Catégorie : architecture de l'information · Effort : M
- Où : `packages/api/app/gagner.ts` et ses modules (pige, tournée, veille, site, calendrier, neuf, viager)
- Preuve : 11 blocs, 8 boutons pleins, 3,1 écrans avant toute ouverture, 3,5 après.
- Solution : une page d'entrée qui liste les sept outils, chacun ouvert sur son propre écran.

### B. Identité et marque

#### DS015 · La marque n'a pas de voix typographique tenue
- Gravité : majeur · Catégorie : identité · Effort : M
- Où : `packages/core/src/design/systeme.ts` (`POLICES`)
- Preuve : la pile des titres est Iowan Old Style, Charter, Palatino Linotype, Book Antiqua, Georgia. Un iPhone rend Iowan, un PC Palatino, un téléphone Android aucune des cinq : il tombe sur son serif par défaut, comme le poste d'audit (toutes les captures).
- Principe : une marque se reconnaît à sa lettre.
- Solution : une police de titres propre à AIMMO, servie par le Worker lui-même, en sous-ensemble latin de moins de 25 Ko. Demande un changement de R201 : c'est la question posée à Shawez. Sans accord : une pile resserrée, corps et graisses réglés pour que le repli se tienne.
- Suite : corrigé le 2026-11-27 avec la base du système (direction Maison, sans changer de règle) : la pile commence par le caractère à empattements de l'appareil (`ui-serif`), en graisse normale, corps réglés. Une police servie reste possible si Shawez la demande. Avant et après : `captures/avant-apres/systeme-maison.jpg`, `systeme-maison-sombre.jpg`.

#### DS016 · Pas de logotype
- Gravité : majeur · Catégorie : identité · Effort : M
- Où : en-tête, icône de l'application — `systeme.ts` (`.marque`, `ICON_SVG`)
- Preuve : la marque est le mot AIMMO en capitales espacées, précédé d'un losange de 12 px. L'icône est une maison générique.
- Solution : un logotype dessiné, en SVG, avec son monogramme pour l'icône.

#### DS017 · En sombre, le bordeaux devient rose
- Gravité : majeur · Catégorie : identité, mode sombre · Effort : S
- Où : `systeme.ts` (`PALETTE.sombre.accent` : `#f0a6b0`)
- Preuve : `appli-ordinateur-et-sombre.jpg` : le bouton « Noter une rétractation » est rose saumon.
- Solution : en sombre, le bouton plein garde un bordeaux profond avec un texte clair ; le rose ne sert qu'aux liens et aux contours.
- Suite : corrigé le 2026-11-27 : l'action n'est plus le bordeaux mais l'encre ; en sombre, le bouton plein est ivoire, texte sombre. Avant et après : `captures/avant-apres/systeme-maison.jpg`, `systeme-maison-sombre.jpg`.

#### DS018 · La frise rayée se lit comme un ruban de chantier
- Gravité : majeur · Catégorie : identité · Effort : S
- Où : sous chaque en-tête — `systeme.ts` (`--frise`)
- Preuve : toutes les captures. Quatre couleurs en biais sur 6 px : le motif n'évoque pas les losanges des toits vernissés.
- Solution : selon la direction retenue : un vrai motif de losanges, discret, ou plus de frise du tout.
- Suite : corrigé le 2026-11-27 : plus de frise, un filet. Avant et après : `captures/avant-apres/systeme-maison.jpg`, `systeme-maison-sombre.jpg`.

#### DS019 · Aucune image dans toute l'application
- Gravité : majeur · Catégorie : images · Effort : L
- Où : toute l'application
- Preuve : aucun `<img>` dans les 90 scripts. Ni photo de bien, ni visage.
- Principe : l'immobilier se vend par l'image, et l'agent reconnaît un bien à sa photo avant sa référence.
- Solution : la photo du bien sur sa carte et sa fiche, en vignette légère servie par `/medias/`. Les initiales du client dans un rond.

#### DS020 · Le losange est partout, donc nulle part
- Gravité : mineur · Catégorie : identité · Effort : S
- Où : devant chaque titre de carte — `systeme.ts` (`.bloc>h3::before`)
- Preuve : 23 losanges sur l'accueil.
- Solution : le losange reste le signe de la marque et des moments forts, pas une puce.
- Suite : corrigé le 2026-11-27 : plus aucun losange devant les titres ni dans la marque. Avant et après : `captures/avant-apres/systeme-maison.jpg`, `systeme-maison-sombre.jpg`.

#### DS021 · Rien ne dit le haut de gamme
- Gravité : majeur · Catégorie : confiance et prestige · Effort : L
- Où : toutes les surfaces vues par un client
- Preuve : `site-accueil-et-bien-telephone.jpg`, `espace-client.jpg`. Cartes très arrondies, ombres douces, texte seul : le vocabulaire d'une application grand public. Barnes sert six langues et une quinzaine de devises et met la photo au premier plan.
- Solution : de l'air, la photo en grand, une typographie de livre, des filets fins à la place des cartes, et l'anglais (DS073).

### C. Hiérarchie visuelle

#### DS022 · Trop de boutons pleins : aucune action ne domine
- Gravité : majeur · Catégorie : hiérarchie · Effort : M
- Où : fiche client (9 boutons pleins), « Gagner des mandats » (8), conformité (7), « Mettre en vente » (5), carte d'un bien sur l'accueil (5), mandat (4), offres (4)
- Preuve : `appli-accueil.jpg`, `appli-mettre-en-vente.jpg` : « Rédiger de nouveau » et « Corriger le texte » sont pleins tous les deux.
- Principe : un écran, une action principale.
- Solution : un seul bouton plein par écran. Les autres sont filaires, ou de simples liens. À inscrire dans le contrôle du système.

#### DS023 · Le bien s'appelle « B-E6B8BB51 »
- Gravité : majeur · Catégorie : hiérarchie, microcopie · Effort : M
- Où : titres de six écrans, carte de l'accueil
- Preuve : `appli-mandat-offres-avis.jpg`. 105 occurrences dans les plans des écrans. Le point médian passe seul en début de ligne : « Avis de valeur / · B-E6B8BB51 ».
- Solution : le bien se nomme par son type, sa rue et sa commune (« Appartement, rue Monge, Dijon »), la référence en petit. Le titre de l'écran est le bien, l'étape est l'onglet.

#### DS024 · Toutes les cartes ont le même poids
- Gravité : majeur · Catégorie : hiérarchie · Effort : M
- Où : `systeme.ts` (`.bloc`)
- Preuve : même rayon, même ombre, même titre pour une alerte, une liste et un réglage.
- Solution : trois niveaux : ce qui presse (plein cadre, accent), le contenu (liste sans carte), le réglage (ligne).

#### DS025 · Les états s'écrivent en phrases
- Gravité : mineur · Catégorie : hiérarchie · Effort : S
- Où : mandat, offres, accueil, publication
- Preuve : « État : acceptée », « Annonce en vente. », « site : publiée ». La classe `.pastille` existe et sert peu.
- Solution : une étiquette d'état, avec un petit jeu de teintes : en cours, fait, en retard, bloqué.

#### DS026 · Les chiffres qui comptent sont en petit gris
- Gravité : mineur · Catégorie : hiérarchie · Effort : S
- Où : mandat
- Preuve : `appli-mandat-offres-avis.jpg` : « En vigueur : prix 200 000 €, durée 12 mois. » est en gris, sous un bouton.
- Solution : prix, durée et échéance en tête de carte, en chiffres alignés.

### D. Typographie

#### DS027 · Trop de texte secondaire en gris
- Gravité : mineur · Catégorie : typographie · Effort : S
- Où : accueil, « Mettre en vente », espace client
- Preuve : sur l'accueil, chaque bloc porte une phrase grise permanente. Dans « Mettre en vente », trois à quatre lignes grises suivent chaque phrase de l'annonce.
- Solution : le gris pour la précision, pas pour l'explication permanente. L'explication passe derrière un « En savoir plus ».

#### DS028 · Une graisse de 650 qui n'existe pas partout
- Gravité : finition · Catégorie : typographie · Effort : S
- Où : `systeme.ts` (`strong`, `.pastille`, `.fait`)
- Preuve : une police de système sans axe variable rend 650 en 600 ou en 700 selon l'appareil.
- Solution : 600 et 700 seulement.
- Suite : corrigé le 2026-11-27 : 400, 500, 600 et 700 seulement, avec son test.

#### DS029 · Une seule échelle pour le téléphone et l'ordinateur
- Gravité : mineur · Catégorie : typographie · Effort : S
- Où : `systeme.ts` (`--t-*`)
- Preuve : sur 1 440 px, le titre d'écran et le texte ont les tailles du téléphone ; les lignes font 72 à 83 caractères, à la limite du confort.
- Solution : une échelle fluide, et des lignes de 60 à 70 caractères.

### E. Couleur

#### DS030 · L'action et le danger sont deux rouges voisins
- Gravité : majeur · Catégorie : couleur · Effort : S
- Où : `systeme.ts` (`accent` `#7c1f32`, `danger` `#a3231b`)
- Preuve : « Noter une rétractation » (action) et un bouton `.danger` ne se distinguent que par leur largeur.
- Principe : la couleur du danger ne sert qu'au danger.
- Solution : le bouton d'action change de teinte selon la direction retenue (encre, ou vert de tuile), et le rouge reste au danger. Ou le danger devient filaire avec une confirmation.
- Suite : corrigé le 2026-11-27 : l'action est l'encre, le rouge reste au danger, avec son test. Avant et après : `captures/avant-apres/systeme-maison.jpg`, `systeme-maison-sombre.jpg`.

#### DS031 · Le moutarde a quatre sens
- Gravité : mineur · Catégorie : couleur · Effort : S
- Où : losanges, soulignement du titre, bord gauche des formulaires ouverts, numéros de listes
- Preuve : `appli-fiche-client.jpg` : le bord moutarde entoure les formulaires, le losange précède les titres.
- Solution : un seul sens : la marque.

#### DS032 · Pas de teinte pour « information » ni « attention »
- Gravité : mineur · Catégorie : couleur · Effort : S
- Où : `systeme.ts` (`.alerte`)
- Preuve : `appli-fiche-client.jpg` : « Appel fermé… » est une règle à connaître, montrée comme une alerte rouge.
- Solution : trois bandeaux : information, attention, erreur.

### F. Espacement et grille

#### DS033 · Sur ordinateur, une colonne de 608 px
- Gravité : majeur · Catégorie : ordinateur · Effort : L
- Où : toute l'application et toutes les pages publiques — `systeme.ts` (`--colonne:38rem`)
- Preuve : `appli-ordinateur-et-sombre.jpg`, `site-accueil-et-bien-ordinateur.jpg` : 58 % de la largeur est vide. La photo du bien fait 155 px de large.
- Solution : sur grand écran, navigation à gauche, liste au centre, détail à droite. Pages publiques sur une grille de 12 colonnes.

#### DS034 · Les boutons en ligne se décalent en passant à la ligne
- Gravité : mineur · Catégorie : espacement · Effort : S
- Où : carte d'un bien sur l'accueil — `fichiers.ts` (`.liste button + button`)
- Preuve : `appli-accueil.jpg` : la deuxième rangée de boutons est décalée de 8 px vers la droite.
- Solution : un groupe de boutons en `flex` avec `gap`.

#### DS035 · Un bouton collé à la phrase
- Gravité : mineur · Catégorie : espacement · Effort : S
- Où : offres — `packages/api/app/offres.ts`
- Preuve : `appli-mandat-offres-avis.jpg` : « Prochain pas : ouvrir le dossier de vente.[Ouvrir le dossier de vente] ».
- Solution : le bouton sur sa ligne. Et la phrase qui répète le bouton s'en va.

#### DS036 · Un seul rythme vertical
- Gravité : mineur · Catégorie : espacement · Effort : S
- Où : partout
- Preuve : 16 px entre tout : entre deux cartes sans lien comme entre un titre et son contenu.
- Solution : trois écarts : dans un groupe, entre groupes, entre sections.

### G. Composants

#### DS037 · « Retour » a trois formes
- Gravité : majeur · Catégorie : composants · Effort : S
- Où : tous les écrans
- Preuve : lien fléché « Retour à ma journée » (mandat), bouton plein « Retour à ma journée » (fiche client), « Ma journée d'agent » (réseau), « Retour » (Fiche Google).
- Solution : un seul retour, dans l'en-tête, avec le nom de l'écran d'où l'on vient.

#### DS038 · Les formulaires sont toujours ouverts
- Gravité : majeur · Catégorie : composants · Effort : M
- Où : mandat (« Préparer un avenant » : 6 champs), fiche client (« Biens du client » : 7 champs, « Accords » : 4 champs)
- Preuve : `appli-mandat-offres-avis.jpg`, `appli-fiche-client.jpg`.
- Solution : le geste s'annonce par un bouton, le formulaire s'ouvre dans une feuille. Une feuille par geste.

#### DS039 · La fiche du bien : 42 champs d'un seul tenant
- Gravité : majeur · Catégorie : formulaires · Effort : M
- Où : « Remplir la fiche du bien » — `packages/api/app/fiche-bien.ts`
- Preuve : 42 champs, 7 214 px, soit 8,5 écrans, un seul bouton « Enregistrer la fiche » tout en bas.
- Solution : des étapes (Surfaces, Énergie, Copropriété, Photos), chacune enregistrée, avec sa progression.

#### DS040 · La preuve de chaque phrase est toujours dépliée
- Gravité : majeur · Catégorie : composants · Effort : S
- Où : « L'annonce, phrase par phrase » — `packages/api/app/fichiers.ts` (`#vente`)
- Preuve : `appli-mettre-en-vente.jpg` : « 3 : pièces, lu dans la fiche du bien » sous chaque phrase. L'écran fait 3,6 écrans.
- Solution : l'annonce se lit d'un trait. Un appui sur une phrase montre ses preuves. Une phrase sans preuve est signalée.

#### DS041 · Une liste ne se touche que par son bouton
- Gravité : mineur · Catégorie : composants · Effort : S
- Où : contacts chauds, rendez-vous, biens
- Preuve : `appli-accueil-portefeuille-charge.jpg` : chaque ligne fait 185 px, dont un bouton « Voir la fiche » plein.
- Solution : la ligne entière est la cible, avec un chevron. 72 px par ligne.

#### DS042 · Pas de composant de niveau produit
- Gravité : majeur · Catégorie : système de design · Effort : L
- Où : `systeme.ts`
- Preuve : la base offre une quinzaine de classes. Il manque : barre d'onglets, en-tête de fiche, carte de bien, ligne de personne, étiquette d'état, feuille d'action, squelette de chargement, bandeau d'information, fil d'étapes commun.
- Solution : ces neuf composants dans la base, chacun avec son contrôle.

#### DS043 · Le même composant pour naviguer et pour filtrer
- Gravité : mineur · Catégorie : composants · Effort : S
- Où : `.periodes` : « Mon dossier / Académie » (navigation), « Ce mois-ci / Mois dernier » (filtre), Studio (onglets en boutons filaires)
- Solution : des onglets pour naviguer, des segments pour filtrer.

#### DS044 · Des listes déroulantes pour deux ou trois choix
- Gravité : mineur · Catégorie : formulaires · Effort : S
- Où : fiche client, mandat, avenant
- Preuve : `appli-fiche-client.jpg` : « Maison ou appartement » dans un `select`.
- Solution : des segments ou des boutons radio jusqu'à quatre choix : un appui au lieu de deux.

### H. Icônes et images

#### DS045 · Aucune icône
- Gravité : majeur · Catégorie : iconographie · Effort : M
- Où : toute l'application
- Preuve : la seule est la flèche « ← », en texte.
- Solution : un jeu d'une vingtaine d'icônes au trait, en SVG dans la base : appeler, écrire, agenda, bien, client, document, signer, photo, chercher.

### I. Mouvement

#### DS046 · Le chargement est un mot
- Gravité : mineur · Catégorie : mouvement, performance ressentie · Effort : M
- Où : tous les écrans chargés à la demande
- Preuve : « Chargement… » apparaît 143 fois dans les scripts. Aucun squelette.
- Solution : un squelette qui a la forme de ce qui arrive.

#### DS047 · Rien ne relie une liste à son détail
- Gravité : finition · Catégorie : mouvement · Effort : M
- Où : ouverture d'une fiche, d'un bien
- Preuve : un seul mouvement : un fondu de 220 ms à l'entrée d'un écran.
- Solution : le détail glisse depuis la ligne touchée, avec les transitions de vue du navigateur, coupées pour qui réduit les animations.

#### DS048 · Un geste réussi ne se voit qu'en petit texte
- Gravité : mineur · Catégorie : mouvement, états · Effort : S
- Où : `.etat` sous les boutons
- Preuve : « Page téléchargée : ouvrez-la… » en gris, à un endroit variable.
- Solution : une confirmation au même endroit pour tous les gestes, en bas, avec « Annuler » quand le geste s'annule.

### J. Parcours

#### DS049 · La signature du mandat n'a pas de fil
- Gravité : majeur · Catégorie : parcours · Effort : M
- Où : mandat — `packages/api/app/mandat.ts`
- Preuve : questionnaire, document, contrôle, signature papier ou en ligne, rétractation et avenant sont des cartes de même rang. Le fil d'étapes `.parcours` existe, pour la location seulement.
- Solution : le même fil d'étapes sur tous les parcours : préparer, contrôler, signer, inscrit. L'étape en cours porte le bouton plein.

#### DS050 · La fiche n'ouvre pas sur le geste du jour
- Gravité : majeur · Catégorie : parcours · Effort : M
- Où : fiche client
- Preuve : `appli-fiche-client.jpg` : aucune coordonnée en tête, aucun lien `tel:`, `sms:` ni `mailto:`. Les gestes sont « J'ai appelé » et « La personne a refusé ».
- Principe : le cahier décrit la journée : « qui appeler, où aller ».
- Solution : en tête, les moyens de contact que les règles d'appel et d'accord permettent, et la raison quand un moyen est fermé. À faire dans le respect de R202 à R204.

#### DS051 · Dix requêtes pour ouvrir l'accueil
- Gravité : mineur · Catégorie : performance ressentie · Effort : M
- Où : accueil
- Preuve : 10 appels à l'API et 2 scripts au chargement.
- Solution : l'accueil resserré (DS001) n'en demande que trois ou quatre.

### K. Microcopie et ton

#### DS052 · La mention de l'assistant dit « de Alex » et « réponse immédiate » hors de propos
- Gravité : majeur · Catégorie : mails et SMS · Effort : S
- Où : `packages/core/src/envoi/controle.ts` l. 168
- Preuve : la demande d'avis, envoyée quatre mois après la vente, commence par « Réponse immédiate de l'assistant IA de Alex, qui vous recontacte personnellement. »
- Solution : « d'Alex ». Et une mention qui dit vrai pour un message qui n'est pas une réponse. C'est un texte réglé par une règle : à changer avec son test.

#### DS053 · Une référence interne dans un mot de remerciement
- Gravité : mineur · Catégorie : mails et SMS · Effort : S
- Où : demande d'avis — `packages/core/src/apres-vente/demandes-avis.ts`
- Preuve : « …la vente de votre bien à Dijon, référence B-CCD5185A. »
- Solution : « votre appartement de la rue … ». La référence n'apprend rien au client.

#### DS054 · Des libellés de bouton qui ne disent rien seuls
- Gravité : mineur · Catégorie : microcopie, accessibilité · Effort : S
- Où : accueil
- Preuve : deux boutons « Ouvrir » (Gagner des mandats, Fiche Google), « Voir et régler », « Voir mes clés », « Voir mes clés à rendre ».
- Solution : le bouton nomme ce qu'il ouvre. Avec les onglets, la plupart disparaissent.

#### DS055 · Une écriture de tableur
- Gravité : mineur · Catégorie : microcopie · Effort : S
- Où : « Ma semaine »
- Preuve : « Plan ouvert avant midi : 0 jour(s) sur 7. », « 05/06 non · 06/06 non · 07/06 non… ».
- Solution : sept pastilles, une par jour, et « Aucun jour cette semaine ».
- Suite : corrigé le 2026-11-27 : « Plan ouvert avant midi : 5 jours sur 7. », puis les jours par leur nom, les moins nombreux des deux : « Pas ouvert vendredi 6 ni mardi 10. »

#### DS056 · Des dates au format des machines dans un document remis au vendeur
- Gravité : majeur · Catégorie : microcopie, impression · Effort : S
- Où : dossier de présentation — `packages/core/src/mandats/gagner/dossier-presentation.ts` l. 364
- Preuve : `site-candidature-estimation-dossier.jpg` : « vente la plus récente : 2027-03, avis validé le 2027-10-07 », et « 2027-03 » dans le tableau.
- Solution : « mars 2027 », « 7 octobre 2027 ».
- Suite : corrigé le 2026-11-24 (#802) : toutes les dates du document, et l'accord « 1 mandat signé ». Avant et après : `captures/avant-apres/DS056-dossier-de-presentation.jpg`.

#### DS057 · L'identifiant d'un agent dans un libellé
- Gravité : majeur · Catégorie : microcopie · Effort : S
- Où : grille des commissions — `packages/api/app/finances.ts` l. 964
- Preuve : « Taux propre à l'agent acf2c1b2-2d19-49c6-b889-ea38885db2be, en % ».
- Solution : le prénom et le nom de l'agent.
- Suite : corrigé le 2026-11-24 (#802) : le prénom et le nom, dans l'ordre des noms. Avant et après : `captures/avant-apres/DS057-grille-des-commissions.jpg`.

### L. Formulaires

#### DS058 · L'erreur s'écrit loin du champ
- Gravité : mineur · Catégorie : formulaires · Effort : M
- Où : tous les formulaires
- Preuve : le refus s'écrit dans la zone d'état, sous le bouton. Aucun champ ne porte `aria-invalid`.
- Solution : le message sous le champ fautif, le champ marqué, le focus posé dessus.

#### DS059 · Le bouton d'envoi est au bout du formulaire
- Gravité : mineur · Catégorie : formulaires, une main · Effort : S
- Où : fiche du bien (42 champs), offre reçue (16 champs)
- Solution : un bouton d'envoi collé en bas de l'écran pendant la saisie.

### M. États

#### DS060 · Un état vide prend la place d'un état plein
- Gravité : majeur · Catégorie : états · Effort : S
- Où : accueil, réseau, « Gagner des mandats »
- Preuve : cinq cartes de suite ne disent que « Rien à… » ou « Aucun… ». 11 des 35 blocs du réseau sont vides.
- Solution : un bloc vide se réduit à une ligne, ou disparaît. Quand tout est vide, un seul message, avec le premier geste à faire.

#### DS061 · Une panne ressemble à une information
- Gravité : majeur · Catégorie : états · Effort : S
- Où : fiche client, Studio, partenaires
- Preuve : `appli-fiche-client.jpg` : « La liste des biens n'a pas pu être lue. » est en gris, sous un bouton, comme une aide.
- Solution : un bandeau d'erreur, avec « Réessayer ».

#### DS062 · L'écran de connexion est nu
- Gravité : mineur · Catégorie : états, identité · Effort : S
- Où : connexion — `fichiers.ts` (`#connexion`)
- Preuve : `appli-reseau-chiffres-connexion.jpg` : un titre, une phrase, un lien.
- Solution : le premier écran porte la marque, et dit quoi faire en une phrase.

### N. Accessibilité

#### DS063 · Le titre de la page ne change jamais
- Gravité : mineur · Catégorie : accessibilité · Effort : S
- Où : toute l'application
- Preuve : `document.title` vaut « AIMMO » sur chaque écran. Le seul `h1` est la marque.
- Solution : « Mandat · rue Monge · AIMMO ». Le `h1` est le titre de l'écran.

#### DS064 · Le focus se perd à chaque changement d'écran
- Gravité : mineur · Catégorie : accessibilité · Effort : S
- Où : fonction `show`
- Preuve : après l'ouverture de « Mandat », l'élément actif est `body`.
- Solution : le focus va au titre du nouvel écran.

#### DS065 · Une cible de 40 px dans l'en-tête
- Gravité : mineur · Catégorie : accessibilité · Effort : S
- Où : « Se déconnecter » — `fichiers.ts` l. 248
- Preuve : 40 px de haut, pour 48 px promis par le système. WCAG 2.2 demande 24 px au moins : la règle est tenue, la promesse du système ne l'est pas.
- Solution : 48 px, ou un bouton d'icône de 48 px.
- Suite : corrigé le 2026-11-27 : le bouton a quitté l'en-tête et fait 48 px, comme les autres ; chaque onglet aussi, mesuré dans Chromium.

#### DS066 · Pas de lien d'évitement ni de repère de navigation
- Gravité : mineur · Catégorie : accessibilité · Effort : S
- Où : toute l'application
- Solution : « Aller au contenu », et un `nav` pour les onglets.
- Suite : corrigé le 2026-11-27 : les onglets sont un repère `nav`, placé avant le contenu ; « Aller au contenu » est le premier arrêt au clavier et mène au titre de l'écran.

#### DS067 · Les documents imprimés n'ont ni repère principal ni titre de niveau 1
- Gravité : finition · Catégorie : accessibilité, impression · Effort : S
- Où : fiche imprimable, lettres de quartier, document à signer
- Preuve : axe-core : `landmark-one-main`, `page-has-heading-one`, `region`.
- Solution : un `main` et un `h1` dans chaque gabarit.

### O. Performance et budgets

#### DS068 · Les budgets de poids sont pleins
- Gravité : majeur · Catégorie : performance, système de design · Effort : L
- Où : `packages/core/src/design/audit.ts` (`BUDGETS`)
- Preuve : la coquille pèse 48 446 octets compressés pour 49 152 permis. `mandat.js` 13 036, `louer.js` 13 431, `finances.js` 14 074, `commerces.js` 14 162, pour 14 336 permis.
- Solution : alléger d'abord. Des composants communs à la place des styles et du code propres à chaque écran. Puis sortir de la coquille ce que l'agent ne voit pas (DS069).

#### DS069 · Chaque agent télécharge l'écran de la direction
- Gravité : majeur · Catégorie : performance · Effort : M
- Où : `fichiers.ts` (`#reseau`)
- Preuve : la section `#reseau` fait 16 457 des 33 722 caractères de la page d'accueil de l'application.
- Solution : la console de la direction dans son propre fichier, chargé pour la direction seule.

### P. Téléphone à une main

#### DS070 · Les gestes sont hors de portée du pouce
- Gravité : majeur · Catégorie : une main · Effort : M
- Où : tous les écrans
- Preuve : « Retour » est en haut à gauche, les boutons sont au fil du texte, rien n'est ancré en bas.
- Solution : onglets en bas, action principale ancrée en bas, retour par balayage du navigateur et par l'en-tête.

### Q. Site public

#### DS071 · L'accueil du site est une liste de liens
- Gravité : bloquant · Catégorie : site public · Effort : L
- Où : `packages/core/src/attirer/accueil-site.ts`
- Preuve : `site-accueil-et-bien-telephone.jpg`. Un titre, un champ de recherche, sept liens soulignés avec leur explication. Ni image, ni promesse, ni preuve, ni visage. iad ouvre son estimation sur « 4,9/5 » et 271 107 avis, avec les dernières ventes en photo.
- Solution : une promesse, la recherche en grand, les derniers biens en photo, la preuve (le compte public de Dijon, les avis), l'agent, puis les outils.
- Suite : corrigé le 2026-11-27 avec ce que la page reçoit : une ouverture (le titre, une phrase qui dit ce que le site prouve et dont chaque mot a sa page, la recherche en grand, « Estimer mon logement »), les derniers biens en photo (cartes refaites, communes à la liste des biens), la garantie des mandats, puis les pages du site en rangées entières à toucher. Restent, faute de donnée sur la page : la note et le nombre d'avis, le visage de l'agent, les chiffres du compte public. Avant et après : `captures/avant-apres/DS071-accueil-du-site.jpg`.

#### DS072 · La page d'un bien ne vend pas le bien
- Gravité : bloquant · Catégorie : site public · Effort : L
- Où : `packages/core/src/annonces/page-bien.ts`
- Preuve : `site-accueil-et-bien-telephone.jpg`, `site-accueil-et-bien-ordinateur.jpg`. Une seule photo, en vignette sur ordinateur. Pas de galerie, pas de faits clés (surface, pièces, étage), pas de bouton « Visiter ». Le contact de l'agent est un numéro et une adresse en liens nus.
- Solution : photo plein cadre et galerie, faits clés en une ligne, prix et honoraires lisibles, un bouton « Demander une visite » ancré, l'agent avec son visage, la carte du quartier sans l'adresse exacte.
- Suite : corrigé le 2026-11-27 pour ce que la version publiée porte : la galerie ouvre la page (la première photo en grand, les suivantes au doigt sur téléphone, en mosaïque de hauteur bornée sur ordinateur), l'état, le titre, le prix, les faits en une ligne (surfaces du site et classes du diagnostic), puis l'agent avec deux vrais boutons, « Demander une visite » et « Appeler », qui restent au pied de l'écran sur téléphone. Sans script, rien de caché [R43]. Restent, faute de donnée dans la version publiée : le nombre de pièces et l'étage dans les faits, le visage de l'agent, la carte du quartier. Avant et après : `captures/avant-apres/DS072-page-du-bien.jpg`.

#### DS073 · Aucune page en anglais
- Gravité : majeur · Catégorie : international · Effort : L
- Où : tout le site public
- Preuve : ni `lang="en"` ni `hreflang` dans le code. Barnes sert six langues, Apimo traduit ses annonces.
- Solution : l'anglais sur les pages de biens, l'accueil et la page de l'agent, avec les prix dans la devise choisie à titre indicatif. Les textes traduits sont relus par l'agent avant publication : c'est une tâche de fond, à découper à part.

#### DS074 · « Rejoindre AIMMO » demande d'agir par un lien souligné
- Gravité : majeur · Catégorie : site public · Effort : M
- Où : `packages/api/src/candidature.ts`
- Preuve : `site-candidature-estimation-dossier.jpg`. Le texte est bon. L'appel à l'action est « Déposer ma candidature » en lien. Aucun chiffre prouvé, aucun visage. 6 621 px sur téléphone.
- Solution : un bouton, répété en bas. Les preuves chiffrées du compte public. Le témoignage d'un agent quand il y en aura un vrai.
- Suite : corrigé le 2026-11-27 : « Déposer ma candidature » est un bouton, en haut, qui mène au formulaire ; l'envoi, en bas, reste le seul bouton plein. La page passe en direction Maison : plus de petites capitales au-dessus des titres, plus de losange penché sous les numéros des étapes. Restent, faute de donnée : les chiffres du compte public et le témoignage d'un agent. Avant et après : `captures/avant-apres/DS074-candidature.jpg`.

#### DS075 · Les listes d'agents et de communes n'ont ni recherche ni index
- Gravité : mineur · Catégorie : site public · Effort : S
- Où : `packages/core/src/attirer/annuaire-site.ts`
- Preuve : 500 agents : 17 299 px. 2 000 communes : 21 582 px.
- Solution : un champ de filtre et un index par lettre, sans script lourd.

#### DS076 · Le jargon de la preuve passe avant le contenu
- Gravité : mineur · Catégorie : site public, microcopie · Effort : S
- Où : accueil du site, « Les derniers biens »
- Preuve : la section commence par « Mandats vérifiés le … Un bien sans mandat en vigueur à cette heure n'apparaît pas ici. »
- Solution : les biens d'abord. La garantie en une ligne, dessous.

#### DS077 · Des liens trop petits pour le doigt
- Gravité : mineur · Catégorie : accessibilité · Effort : S
- Où : mentions légales, estimation, page du bien, listes
- Preuve : sur téléphone, 2 à 12 liens par page font moins de 44 px de haut.
- Solution : 44 px au moins pour tout lien isolé.

### R. Espaces des clients

#### DS078 · L'espace du vendeur montre des valeurs internes
- Gravité : majeur · Catégorie : espace client · Effort : S
- Où : `packages/api/src/espaces.ts` l. 253 à 256
- Preuve : `espace-client.jpg` : « Mandat de vente · signe ». Le code écrit `shown(d.signature)` : la valeur de la base, telle quelle. Même chose pour l'état d'une visite (`prevue`, `annulee`), l'état d'une pièce de l'acquéreur (`deposee`) et la sorte d'un bien proposé (`home`).
- Correction du constat (2026-11-24) : « Statut : available », lisible sur la capture, venait du jeu de test des routes, pas du produit : la vraie source disait déjà « en vente ». La gravité passe de bloquant à majeur.
- Solution : chaque valeur a son mot français : « signé », « à signer », « prévue ». Un test par valeur.
- Suite : corrigé le 2026-11-24 (#801), dans la vue, donc aussi dans le relevé prouvé. Avant et après : `captures/avant-apres/DS078-espace-du-vendeur.jpg`.

#### DS079 · La source de chaque chiffre coupe la phrase
- Gravité : bloquant · Catégorie : espace client · Effort : M
- Où : `packages/api/src/espaces.ts`
- Preuve : `espace-client.jpg` : « 210 000 € annonce publiée, 20 mai 2027 à 10 h 00 · 64 annonce publiée, 20 mai 2027 à 10 h 00 m² ».
- Principe : la preuve se donne à qui la demande.
- Solution : la valeur seule, et « D'où vient ce chiffre ? » qui ouvre la source et la date. Le relevé prouvé reste téléchargeable.
- Suite : corrigé le 2026-11-27 : une valeur se lit seule ; sa source et sa date sont juste dessous, derrière « D'où viennent ces informations ? », pour chaque bloc [R163] : chaque champ y est nommé avec sa source et sa date, et dans une liste les preuves sont numérotées comme les lignes. Aucune ne manque, et le relevé prouvé reste entier. Avant et après : `captures/avant-apres/DS079-espace-du-vendeur.jpg`.

#### DS080 · Le vendeur voit « REF-V1 · Dijon », pas sa maison
- Gravité : majeur · Catégorie : espace client · Effort : M
- Où : `packages/api/src/espaces.ts`
- Solution : la photo et l'adresse du bien, que le vendeur connaît déjà.
- Suite : en partie le 2026-11-27 : le titre dit « Votre bien à Dijon », la référence est dessous ; l'acquéreur lit « Maison ou appartement à Dijon » avant la référence. Restent, faute de donnée dans la vue de l'espace : la photo et l'adresse du bien.

#### DS081 · Le seul bouton plein est « Me déconnecter »
- Gravité : majeur · Catégorie : espace client · Effort : S
- Où : `packages/api/src/espaces.ts`
- Preuve : `espace-client.jpg`.
- Solution : la déconnexion en lien, en bas. Le bouton plein va au geste utile : signer, répondre à une offre, déposer une pièce.
- Suite : corrigé le 2026-11-27 : « Me déconnecter » est un bouton de texte, en bas ; « Mettre en favori » est au trait. Aucun bouton plein ne reste sans geste utile.

#### DS082 · Ni avancement, ni prochaine étape, ni agent
- Gravité : majeur · Catégorie : espace client, parcours · Effort : M
- Où : espace vendeur, espace acquéreur
- Preuve : `espace-client.jpg` : des listes (« Visites », « Offres », « Documents », « Rendez-vous », « Points de la semaine »), la plupart vides.
- Solution : en tête, où en est la vente, ce qui se passe ensuite et quand, et l'agent avec son moyen de contact.
- Suite : en partie le 2026-11-27 : les listes vides ne prennent plus un titre chacune, leurs phrases tiennent en une ligne. Restent : où en est la vente, la prochaine étape, et l'agent avec son moyen de contact, qui demandent des données à la vue de l'espace.

### S. Documents imprimés

#### DS083 · La fiche imprimable rejette la description sur une page presque vide
- Gravité : majeur · Catégorie : impression · Effort : M
- Où : `packages/core/src/annonces/page-bien.ts` (`renderListingPrint`)
- Preuve : `documents-imprimes.jpg` : la deuxième page porte un en-tête et une ligne.
- Solution : une page : photo, titre, prix, faits clés, description, étiquettes, agent.
- Suite : corrigé le 2026-11-27 : la fiche tient sur une feuille quand le texte le permet (jusqu'à 1 100 signes environ avec les mentions habituelles) : la photo d'abord et en grand, trois vignettes, le titre, le prix et l'état, les faits clés, la description, les mentions à côté des étiquettes du DPE, l'agent au pied. Un texte plus long passe sur une seconde feuille avec les photos suivantes : deux feuilles au plus, la première garde le prix, les mentions et les étiquettes. Si le texte demandait plus de place que prévu, ce sont les photos qui rétrécissent, jamais un mot qui disparaît. La mention d'aménagement virtuel ne recouvre plus la légende. Avant et après : `captures/avant-apres/DS083-fiche-imprimable.jpg`.

#### DS084 · L'avis de valeur ne porte pas la marque
- Gravité : majeur · Catégorie : impression · Effort : M
- Où : `packages/core/src/estimation/avis-imprime.ts`
- Preuve : `documents-imprimes.jpg`. Le document qui fait signer le mandat est une page de texte avec un tableau.
- Solution : une couverture, la fourchette en grand, les ventes comparables en tableau lisible, la méthode en clair, l'agent en pied de page.
- Suite : corrigé le 2026-11-27 : l'avis s'ouvre sur une couverture (la marque, le titre, la date, la fourchette en grand sur une ligne, l'agent au pied de la page), puis le texte de l'avis et ce qui fonde la fourchette, en tableaux plus aérés dont le titre ne reste jamais seul en bas d'une page. Aucun mot de l'avis n'a changé. Un avis court fait deux pages, quarante ventes en font trois. À l'écran d'un téléphone, des marges et un montant par ligne. Restent, faute de donnée dans l'avis : l'adresse et la photo du bien sur la couverture. Avant et après : `captures/avant-apres/DS084-avis-de-valeur.jpg`.

### T. Mails et SMS

#### DS085 · Les mails sont du texte brut, sans signature
- Gravité : majeur · Catégorie : mails et SMS · Effort : L
- Où : `packages/core/src/envoi/`
- Preuve : les quatre mails du parcours : un paragraphe, un lien écrit en entier, aucune signature.
- Solution : un gabarit de mail sobre : la marque, le texte, un bouton, la signature de l'agent avec son téléphone. En texte et en HTML. Rien ne change au contrôle central des envois.

### U. Système de design

#### DS086 · Les captures de référence datent d'un mois et couvrent cinq écrans
- Gravité : mineur · Catégorie : système de design · Effort : M
- Où : `docs/design/captures/`
- Preuve : 20 images du 28 octobre, pour 26 écrans et une vingtaine de pages.
- Solution : un script de captures rejouable, pour comparer avant et après à chaque proposition.

#### DS087 · Le contrôle ne compte pas les boutons pleins ni la hauteur des écrans
- Gravité : mineur · Catégorie : système de design · Effort : S
- Où : `packages/core/src/design/audit.ts`
- Solution : deux contrôles de plus : un bouton plein par écran, et une hauteur d'écran bornée sur le portefeuille chargé.

## Seconde passe

Une seconde lecture, écran par écran, des 260 états capturés a ajouté DS014, DS039, DS043, DS055, DS057 et DS059. Elle n'a rien trouvé de plus sur les écrans rendus. Elle reste à faire sur les surfaces non rendues, citées dans « Méthode et limites », au moment où la refonte les atteint.

## Sources

- iad : [page d'estimation](https://www.iadfrance.fr/en/estimate/housevilla), [avis clients](https://www.iadfrance.fr/en/avis), [communiqué du 4 février 2026](https://www.indy.fr/wp-content/uploads/2026-02-03-iad-et-Indy-scellent-un-partenariat-exclusif-pour-faire-gagner-du-temps-et-de-lefficacite-aux-15-000-conseillers-immobiliers-du-reseau.pdf.docx.pdf).
- SAFTI : [application mobile](https://www.observatoiredelafranchise.fr/indiscretions-actualite/SAFTI-safti-lance-sa-nouvelle-application-mobile-51577.htm), [SAFTI Connect](https://apps.apple.com/fr/app/id1508577335).
- Logiciels d'agence : [comparatif 2026 de Hackceleration](https://www.hackceleration.com/fr/labs/meilleur/logiciel-agence-immobiliere), [La Boîte Immo, avis 2026](https://www.lafabriquedunet.fr/logiciel/la-boite-immo), [Hektor Voice](https://www.mysweetimmo.com/2024/05/28/pros-de-limmo-la-boite-immo-integre-lia-a-ses-outils-pour-accroitre-votre-efficacite/).
- Prestige : [Barnes, questions fréquentes](https://www.barnes-international.com/en/about-barnes/frequently-asked-questions.html).
- Produit : [les dix règles de Karri Saarinen, Linear](https://www.figma.com/blog/karri-saarinens-10-rules-for-crafting-products-that-stand-out/).
- Normes : [nouveautés de WCAG 2.2](https://www.w3.org/WAI/standards-guidelines/wcag/new-in-22/), [seuils des Core Web Vitals](https://web.dev/articles/defining-core-web-vitals-thresholds).
