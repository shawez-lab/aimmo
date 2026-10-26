# Plan du chantier

Statuts possibles : `à faire`, `en cours`, `chez Codex depuis le <date>`, `fait (<date>)`, `bloquée : <raison>`.
Relecture : `normale` = tests + relecture de Codex. `forte` = tests + relecture de Codex + relecture par un agent séparé.
Les tâches se font dans l'ordre, dès que leurs dépendances sont faites. Le découpage des modules suivants se fait au fil de l'eau (protocole, section 5).

## Phase 1 : le socle

D'après la Feuille de route, novembre et décembre 2026. Condition pour passer à la suite : 30 jours sans aucun envoi hors règles, et plus aucune tâche du système planifiée dans les applications.

### S01 · Base du dépôt
- Statut : fait (2026-10-25)
- Qui : Claude · Relecture : normale · Dépend de : rien
- Fait : règles pour Claude et Codex, protocole, plan, vérifications automatiques, garde-fous, squelette TypeScript testé.

### S02 · Reprendre l'existant
- Statut : fait (2026-10-26)
- Qui : Claude · Relecture : normale · Dépend de : S01
- Cahier : Synthèse, « Ce qui fonctionne déjà » ; Architecture technique, tableau « Outil actuel, Remplacé par, Quand ».
- Objectif : savoir, en lecture seule, ce qui tourne déjà dans `shawez-lab/shawez-immo` (`functions/`, `functions/_lib/`, `functions/migrations/`, `outils/`, `.github/workflows/`) pour le reprendre au lieu de le refaire. Lire les noms et l'en-tête de chaque fichier, puis le détail seulement de ce que le socle reprend.
- Livrable : `docs/EXISTANT.md` : chaque brique en une ligne, ce qu'elle fait, ses données, ce qu'AIMMO en reprend ou remplace, et dans quelle tâche.
- Critères : chaque fichier de `functions/` et chaque workflow est cité ; aucun secret ni aucune donnée personnelle recopiés ; aucune modification de `shawez-immo`.

### S03 · Modèle de données de la fiche client unique
- Statut : fait (2026-10-26)
- Qui : Claude · Relecture : forte · Dépend de : S02
- Cahier : Architecture technique, le modèle de données ; Conformité, données personnelles.
- Objectif : le schéma SQL, compatible D1 et SQLite, des personnes et de leurs identifiants (mail, téléphone, Instagram, Facebook, WhatsApp), accords, exclusions, projets, biens réduits au nécessaire, messages, agents et sources, avec un accès typé dans `packages/core`.
- Livrables : `db/migrations/0001_fiche_client.sql`, `packages/core/src/db/`, tests sur `node:sqlite`.
- Critères : les migrations s'appliquent sur une base vide et se rejouent sans erreur ; une personne peut avoir plusieurs identifiants ; aucune colonne pour une pièce d'identité ou des coordonnées bancaires [R15] ; chaque table a sa clé et les index utiles aux recherches du socle.

### S04 · Une seule fiche par personne
- Statut : fait (2026-10-26)
- Qui : Claude · Relecture : forte · Dépend de : S03
- Cahier : Feuille de route, novembre 2026 ; Architecture technique, fiche client unique.
- Objectif : normaliser les identifiants (téléphone au format international, mail en minuscules, comptes de réseaux), repérer les doublons, fusionner deux fiches en gardant tout l'historique, et pouvoir défaire une fusion.
- Critères : sur un jeu inventé de 50 fiches avec doublons connus, 50 sur 50 bien regroupées ; une fusion se défait ; rien n'est effacé [R17].
- Décidé (2026-10-26), lecture prudente : les noms ne rapprochent jamais deux fiches, seuls les identifiants normalisés le font ; deux fiches suivies par deux agents différents ne se fusionnent pas tant que la direction n'a pas attribué la personne ; une fusion relie les fiches sans déplacer aucune ligne, ce qui la rend exactement réversible.

### S05 · Exclusions, arrêts, accords et horaires
- Statut : fait (2026-10-26)
- Qui : Claude · Relecture : forte · Dépend de : S04
- Cahier : Conformité, prospection et accords ; Risques, décision « Réponses le soir et le dimanche ».
- Objectif : une décision unique « peut-on écrire à cette personne, sur ce canal, pour ce type de message, maintenant ? », avec la règle qui a décidé.
- Critères : un test par règle et par cas limite : samedi 19 h 59 et 20 h 00, dimanche, réponse à un message reçu il y a 59 et 61 minutes, personne exclue qui écrit, demande d'arrêt sur un canal puis envoi sur un autre ; R01 à R04 et R11 passent en service.
- Décidé (2026-10-26), lecture prudente : toute exclusion active ferme tous les canaux ; tout message d'initiative par téléphone, SMS, WhatsApp ou mail demande un accord enregistré pour sa finalité, la demande du client s'enregistrant comme accord, sauf réponse à un message resté sans réponse ; le plafond des demandes d'avis vaut pour tout le réseau ; un message reçu qui dit stop, non ou vendu exclut aussitôt, dans le doute on se tait. Reste : horaires et fréquence des appels du décret de 2022, avec le bouton « appeler ».

### S06 · Contrôle central des envois
- Statut : fait (2026-10-26)
- Qui : Claude · Relecture : forte · Dépend de : S05
- Cahier : Architecture technique, contrôle central des envois ; Intelligence artificielle, garde-fous ; Conformité, mention de l'assistant.
- Objectif : le seul chemin de sortie de tout message. Il applique la décision de S05, l'anti-doublon, la mention du premier message, le contrôle du texte, le texte de secours, et écrit tout au journal. Les canaux sont des interfaces avec de faux canaux pour les tests : aucun envoi réel.
- Critères : un test vérifie qu'aucun autre code n'appelle un canal directement ; un test par règle ; R05 à R10, R12 et R13 passent en service.
- Décidé (2026-10-26), lecture prudente : l'heure d'un envoi est toujours celle du contrôle ; un même texte, sujet ou bien ne part qu'une fois à vie, sur tous les canaux ; sujets, texte, mention et places du plafond du jour sont réservés par une instruction atomique avant l'envoi ; une réponse qui ne peut pas partir est refusée et signalée à l'agent (`needsHuman`) plutôt que répétée ; sans prénom d'agent, la mention dit « votre agent immobilier ».
- Reste : un envoi en panne compte encore dans le plafond du jour de S05 (`DecisionEnvoi.sentToday`), côté prudent, à corriger avec S07 ou S11 ; mise en attente jusqu'au prochain créneau quand R01 refuse ; plafond de 5 échanges de l'assistant (M02).

### S07 · Journal à empreintes
- Statut : fait (2026-10-26)
- Repris (2026-10-26) : Shawez a poussé le travail de Codex sur `codex/S07` (commit `18fa3cc`), Claude l'a fini et fusionné (#4) : ajout seul imposé en base (modification, effacement et remplacement refusés), aucune donnée personnelle dans toute la ligne ni dans les noms de champs, copie figée de la ligne, ajouts simultanés gardés
- Qui : Claude (Codex ne peut pas pousser, H12) · Relecture : normale · Dépend de : S01
- Où : la tâche est décrite dans `chantier/taches/S07.md` sur la branche `codex/S07`, proposition n° 4. La reprendre telle quelle.
- Cahier : Architecture technique, journal ; M06, registre des mandats.
- Objectif : un journal en ajout seul dans `packages/core/src/journal/`, chaque ligne liée à la précédente par son empreinte SHA-256, pour qu'aucune modification ne passe inaperçue. Stockage derrière une interface, avec une version SQLite (`db/migrations/0002_journal.sql`).
- Critères : une ligne modifiée, supprimée ou intervertie est détectée ; recherche par personne et par période ; aucune donnée personnelle en clair dans l'empreinte ni dans le texte de la ligne, seulement des identifiants internes [R13].

### S08 · Droits d'accès
- Statut : fait (2026-10-26)
- Décidé (2026-10-26), lecture prudente : les biens en vente des autres agents forment le fichier commun du réseau, visible de tous ses agents, sans donnée de client (le cahier l'emporte sur l'ancien texte de R16, précisé) ; une fiche sans agent, ou réunie à celle d'un autre agent, n'est pas visible d'un agent ; direction : fiches, biens, chiffres, journal, jamais le coffre anti-blanchiment ; conformité : fiches, biens, journal, coffre, pas les chiffres ; partenaire : rien jusqu'à M18 ; agent parti ou inconnu coupé ; chaque lecture et chaque refus écrits au journal avant de rendre la donnée, rien n'est lu si le journal ne répond pas.
- Reste : rôles responsable d'équipe, assistant et comptabilité ; identité des rôles hors agent par la connexion (S09) ; colonne réseau dans le journal ; relecture de Codex de la dernière version restée en cours 25 minutes, fusion sans elle (#12).
- Qui : Claude · Relecture : forte · Dépend de : S03, S07
- Cahier : Architecture technique, sécurité et droits.
- Objectif : rôles agent, direction, conformité et partenaire ; un agent ne voit que ses clients, ses biens et ses chiffres ; chaque lecture d'une fiche est écrite au journal.
- Critères : un test d'accès refusé par rôle et par type de donnée ; R16 passe en service.

### S09 · API du socle sur Cloudflare
- Statut : fait (2026-10-26)
- Qui : Claude · Relecture : forte · Dépend de : S04, S05, S06, S07, S08
- Attend : H04 pour la mise en ligne seulement.
- Cahier : Architecture technique, les briques et l'hébergement.
- Objectif : un Worker Cloudflare avec D1 qui expose la fiche client, la décision d'envoi en mode essai et le journal, protégé par une clé. Configuration `wrangler` prête, déploiement par GitHub dès que H04 est fait.
- Critères : tests de bout en bout en local ; aucune clé dans le dépôt ; la mise en ligne ne change rien aux systèmes de `shawez-immo`.
- Décidé (2026-10-26), lecture prudente : API fermée par défaut (sans clés ou hors `MODE = "essai"` : 503) ; le secret `API_KEYS` ne porte que l'empreinte de chaque clé et l'identité qu'elle donne ; base `aimmo` créée en juridiction européenne par le déploiement ; aucune route, seulement workers.dev. Notice : `docs/API.md`.
- Reste : la première clé d'API (H14) quand un appelant viendra ; écriture du message et du journal en un seul lot D1 (C01, C02) ; une base `aimmo` déjà existante n'est pas contrôlée sur sa juridiction.

### S10 · Reprise des contacts existants
- Statut : en cours
- Qui : Claude · Relecture : forte · Dépend de : S02, S09
- Cahier : Feuille de route, novembre 2026 : import et fusion des contacts existants, exclusions et accords repris.
- Objectif : à découper en tâches d'après `docs/EXISTANT.md`, au début de la tâche : sources, ordre de reprise, contrôle sur 50 fiches.
- Statut du découpage : découpée le 2026-10-26 en I01 à I04 ci-dessous ; S10 est faite quand I04 l'est.
- Décidé (2026-10-26), lecture prudente : sources dans l'ordre : 1. la base D1 `espace-estimation` du site (comptes, demandes d'estimation), lue en lecture seule ; 2. la liste d'exclusion de Shawez et les contacts de GoHighLevel et ManyChat, par exports CSV que seul Shawez peut sortir (H15). Rien n'est jamais écrit dans les sources. Une demande « Perdu » vaut refus [R02] ; « Pas maintenant » ne donne aucun accord de prospection ; l'accord du site (`consentement_le`) ne vaut que pour le suivi de l'estimation demandée, sur mail et téléphone ; les demandes de robots (`suspect`) et les adresses de test (`*.test.invalid`) ne sont pas reprises, seulement comptées. Les fiches reprises sont confiées à l'agent Shawez.

### I01 · Lire la base du site
- Statut : fait (2026-10-26)
- Qui : Claude · Relecture : normale · Dépend de : S09
- Cahier : Feuille de route, novembre 2026 ; `docs/EXISTANT.md`, `functions/schema.sql` et `functions/_lib/base.js` de `shawez-immo`.
- Objectif : un lecteur qui, sur une base au schéma du site, rend la liste des contacts à reprendre dans un format commun : clé d'origine, mail, téléphone, prénom, nom, date du compte et de l'accord, demandes (référence, type, code postal, commune, statut, raison, dates). Il ne fait que des `SELECT`, supporte les tables et colonnes ajoutées plus tard absentes, et compte ce qu'il écarte.
- Critères : sur une base inventée au schéma du site, chaque compte et chaque demande sans compte donne un contact, sans perte ; une demande de robot et une adresse de test sont écartées et comptées ; le lecteur échoue s'il tente autre chose qu'une lecture ; contact illisible gardé et signalé, jamais jeté.
- Attend : rien.

### I02 · Reprendre les contacts du site dans la fiche client
- Statut : fait (2026-10-26)
- Qui : Claude · Relecture : forte · Dépend de : I01
- Cahier : Feuille de route, novembre 2026 : « Une seule fiche par personne, contrôlée sur 50 fiches. Toutes les exclusions connues marquées ».
- Objectif : chaque contact lu devient ou complète une fiche (S04) : identifiants normalisés, source, projet vendeur par demande, accord du site avec sa preuve, exclusion pour « Perdu ». Reprise relançable : la relancer ne crée ni ne double rien. Un rapport sans donnée personnelle : fiches créées, complétées, réunies, écartées.
- Critères : 50 contacts inventés dont des doublons connus donnent exactement les fiches attendues [R17] ; relancer la reprise ne change rien ; chaque « Perdu » est exclu [R02] ; aucun accord de prospection n'est créé [R03] ; rien n'est effacé [R17] ; journal sans donnée personnelle [R13].
- Attend : rien.

### I03 · Liste d'exclusion et contacts des outils
- Statut : fait (2026-10-26)
- Qui : Claude · Relecture : forte · Dépend de : I02
- Cahier : Feuille de route, novembre 2026 ; R02.
- Objectif : reprendre par fichiers CSV la liste d'exclusion de Shawez et les contacts de GoHighLevel et ManyChat, avec leurs désinscriptions (« ne pas déranger », désabonné) qui deviennent des exclusions sur tous les canaux. Format des colonnes documenté pour que Shawez sache quoi exporter.
- Critères : une personne de la liste d'exclusion, retrouvée par mail ou téléphone, est exclue sur toutes ses fiches [R02] ; un désabonné de GoHighLevel ou ManyChat est exclu [R04] ; une ligne illisible est signalée, jamais jetée ; relancer ne double rien.
- Attend : rien pour la construire ; H15 pour les vrais fichiers.

### I04 · Reprise réelle et contrôle sur 50 fiches
- Statut : à faire
- Qui : Claude · Relecture : forte · Dépend de : I02, I03
- Cahier : Feuille de route, novembre 2026.
- Objectif : un workflow GitHub lancé à la main qui exporte en lecture seule la base `espace-estimation`, y ajoute les fichiers de H15, et reprend le tout dans la base `aimmo` ; puis un contrôle tiré au hasard sur 50 fiches, rapporté sans donnée personnelle.
- Critères : `shawez-immo` et sa base ne sont pas modifiés ; le rapport ne contient aucune donnée personnelle ; contrôle sur 50 fiches sans doublon ni exclusion manquante.
- Attend : H04, H15.

### S11 · Bascule des automatisations existantes sur l'API
- Statut : à faire
- Qui : Claude · Relecture : forte · Dépend de : S06, S09
- Attend : H05 pour les mails.
- Cahier : Feuille de route, novembre 2026 : alertes acquéreurs, tâches planifiées, mention de l'assistant dans les réponses automatiques par mail.
- Objectif : à découper au début de la tâche, d'après `docs/EXISTANT.md`. Chaque bascule passe d'abord en mode essai, sans envoi réel, puis à 10 % pendant 7 jours, puis partout si les chiffres tiennent, avec retour arrière automatique.

## Phase 2 : la preuve à Dijon

À découper au fil de l'eau, dans l'ordre de la Feuille de route : M02 et M03 en décembre 2026, puis M04, M20 et l'application de l'agent en janvier 2027, et la suite mois par mois.

**M02 · Capter, décembre 2026.**

Découpé le 2026-10-26. Ids `C..` pour Capter. Cahier : M02 Capter ; Feuille de route, décembre 2026 : « chaque nouveau contact crée ou complète sa fiche en moins d'une minute ».
Décidé, lecture prudente : tout M02 se construit en mode essai, sans aucun envoi réel ; ManyChat et `functions/api/manychat-dm.js` de `shawez-immo` restent en place, intouchés, jusqu'à C09 ; l'IA est derrière une interface, avec une fausse IA dans les tests, et la vraie ne se branche qu'avec H13 ; chaque réponse sort par le contrôle central de S06, jamais autrement.

### C01 · Réception unifiée des messages
- Statut : fait (2026-10-26)
- Qui : Claude · Relecture : forte · Dépend de : S04, S06
- Cahier : M02, « Canaux » et critère « Un même message reçu deux fois ne produit qu'une réponse ».
- Objectif : un format commun « message entrant » (canal, identifiant du message chez le canal, conversation, expéditeur, texte, date, publication commentée, pièce jointe signalée) et un adaptateur de normalisation par canal : message et commentaire Instagram, Messenger et commentaire Facebook, WhatsApp, mail dont mails de portails, formulaire du site, assistant du site. Chaque message reçu est rangé une seule fois.
- Critères : un exemple inventé par canal et par type se normalise sans perte ; un même message reçu deux fois, ou deux fois en même temps, n'est rangé et traité qu'une fois [R18] ; un message illisible est rangé et signalé à l'agent, jamais jeté ; aucune donnée personnelle dans le journal [R13].
- Attend : rien.
- Décidé (2026-10-26), lecture prudente : seuls les événements connus pour ne pas être des messages sont écartés (accusés, statuts, réactions, échos et publications de nos comptes) ; tout le reste non compris est rangé comme illisible et signalé à l'agent ; un message rangé mais jamais pris est repris, `claim` garantissant un seul traitement ; les messages Meta en `standby` (ManyChat a la main) sont lus.
- Reste : les échos de nos propres messages sont écartés ici, C05 devra s'en servir pour savoir qu'un agent a répondu [R21] ; écriture du message et du journal en une seule transaction D1 avec S09.

### C02 · Rattacher chaque contact à sa fiche
- Statut : fait (2026-10-26)
- Qui : Claude · Relecture : forte · Dépend de : C01
- Cahier : M02, « Fiche » ; Feuille de route, décembre 2026.
- Objectif : à chaque message entrant, retrouver la personne par mail, téléphone ou compte normalisés (S04), sinon créer sa fiche ; rattacher le message, la source et, quand la personne écrit d'elle-même, l'accord pour lui répondre (S05) ; repérer la demande d'arrêt et l'exclusion dès la réception.
- Critères : sur 50 contacts inventés dont des doublons connus, chaque message rejoint la bonne fiche et aucune fiche en double n'est créée ; une personne exclue qui écrit est reconnue et rien ne lui répond [R02] ; « stop » reçu sur un canal ferme tous les canaux [R04] ; fiche créée ou complétée en moins d'une minute, mesuré dans le test.
- Attend : rien.
- Décidé (2026-10-26), lecture prudente : on retrouve par identifiant normalisé ou par identifiant propre au canal (message privé Instagram ou Messenger, session du site), jamais par le nom ; plusieurs fiches trouvées sont réunies (fusion S04) sauf si deux agents les suivent : alors rattaché à la plus ancienne, exclusions partagées entre toutes, direction prévenue ; l'accord de réponse (finalité `reply`) naît du message reçu, jamais d'un message d'arrêt ; formulaire « Être rappelé » : accord sur téléphone et mail donnés ; message abandonné repris après 10 minutes, chaque étape se reprenant sans se répéter.
- Reste : relecture de Codex restée « en cours » plus de 45 minutes, fusion sans elle (#11) ; une coupure exactement entre le rangement du message et sa note pourrait le doubler, à fermer avec les lots D1 de S09 ; un commentaire Instagram (compte) et un message privé (numéro du canal) d'une même personne restent deux fiches.

### C03 · Reconnaître le bien concerné
- Statut : en cours
- Qui : Claude · Relecture : normale · Dépend de : S03
- Cahier : M02, « Première réponse » et règles ; critère « 3 commentaires sur 3 vidéos ».
- Objectif : trouver le bien dont parle le message : publication ou vidéo commentée, lien d'annonce, référence de portail, référence citée dans le texte. Table de correspondance publication → bien dans la base. Sans correspondance sûre : aucun bien, jamais une supposition.
- Critères : 3 commentaires inventés sur 3 vidéos différentes donnent 3 biens différents et justes ; un lien ou une référence inconnus donnent « bien non reconnu » [R20] ; deux biens possibles donnent « bien non reconnu ».
- Attend : rien.

### C04 · Composer la première réponse
- Statut : à faire
- Qui : Claude · Relecture : forte · Dépend de : C02, C03
- Cahier : M02, « Première réponse », « Conversation naturelle », règles ; Intelligence artificielle, garde-fous.
- Objectif : la première réponse avec les vraies données du bien (prix affiché, surface, quartier, atout principal) et une seule question pour avancer : visite, rappel ou estimation. Tutoiement sur Instagram, vouvoiement avec le prénom ailleurs, langue du client, clôture courte quand la personne remercie ou dit non. L'IA est une interface ; la réponse passe par le contrôle central (mention, texte, secours).
- Critères : chaque chiffre de la réponse vient de la fiche du bien [R10] ; jamais l'adresse exacte ni le nom du vendeur [R19] ; bien non reconnu : message simple et honnête sans aucune donnée de bien [R20] ; une seule question ; IA muette ou trop chère : texte de secours [R12] ; mention au premier message [R06] ; un test par canal pour le ton [R08].
- Attend : rien pour la construire ; H13 pour brancher la vraie IA.

### C05 · Conversation et relais à l'agent
- Statut : à faire
- Qui : Claude · Relecture : forte · Dépend de : C04
- Cahier : M02, « Relais humain », « L'IA et l'humain », règles.
- Objectif : l'état de chaque conversation : l'assistant converse jusqu'au rendez-vous ou au plus 5 échanges, puis passe la main ; l'IA se tait pour de bon dès qu'un humain répond ; l'agent voit la conversation et la reprend à tout moment.
- Critères : après la réponse d'un agent, plus aucun message automatique dans cette conversation [R21] ; au 6e message du client, l'agent est prévenu et l'assistant se tait [R21] ; sur Instagram, Facebook et WhatsApp, rien ne part hors de la fenêtre de 24 heures depuis le dernier message du client [R22] ; une relance à l'initiative du réseau ne part ni le soir ni le dimanche [R01].
- Attend : rien.

### C06 · Mail et formulaire du site, en mode essai
- Statut : à faire
- Qui : Claude · Relecture : forte · Dépend de : C05, S09
- Cahier : M02, « Branchements » ; `docs/EXISTANT.md`, `lead.js` et `lead-tri.js`.
- Objectif : brancher sur l'API du socle la réception des mails (routage mail de Cloudflare, mails de portails compris) et du formulaire « Être rappelé », de bout en bout jusqu'à la réponse, en mode essai : la réponse est écrite au journal, jamais envoyée.
- Critères : 20 messages tests par canal, de jour comme de nuit sur une horloge simulée, donnent chacun une réponse prête en moins d'une minute ; le même mail reçu deux fois ne donne qu'une réponse [R18] ; `shawez-immo` n'est pas modifié.
- Attend : H04 pour la mise en ligne seulement.

### C07 · Instagram, Facebook et WhatsApp, en mode essai
- Statut : à faire
- Qui : Claude · Relecture : forte · Dépend de : C06
- Cahier : M02, « Branchements » : API Meta avec notifications en temps réel, API WhatsApp Business.
- Objectif : les points d'arrivée des notifications de Meta et de WhatsApp, avec vérification de la signature, en mode essai, testés sur des notifications inventées. ManyChat reste seul à répondre.
- Critères : une notification à la signature fausse est refusée ; 20 messages tests par canal donnent une réponse prête en moins d'une minute ; un commentaire reçoit une réponse qui cite le bon bien ; aucun envoi réel ; ManyChat intouché.
- Attend : H06 pour recevoir les vraies notifications de Meta.

### C08 · API de l'assistant du site, en mode essai
- Statut : à faire
- Qui : Claude · Relecture : forte · Dépend de : C05, S09
- Cahier : M02, « Canaux » : assistant du site.
- Objectif : l'API que l'assistant du site appellera : ouvrir une conversation, envoyer un message, recevoir la réponse, avec les mêmes règles que les autres canaux. Son intégration au site sera une proposition sur `shawez-immo`, faite dans une tâche à part, jamais directement sur main.
- Critères : 20 messages tests donnent une réponse en moins d'une minute ; mention au premier message [R06] ; une conversation sans accord ne laisse aucune donnée personnelle au-delà de ce que la personne a écrit [R15] ; appels limités par visiteur.
- Attend : H04 pour la mise en ligne seulement.

### C09 · Mise en service de la captation
- Statut : à faire
- Qui : Claude · Relecture : forte · Dépend de : C06, C07, C08, S11
- Cahier : M02, « État » ; Feuille de route, décembre 2026.
- Objectif : à découper au début de la tâche : canal par canal, mode essai puis 10 % pendant 7 jours puis partout si les chiffres tiennent, avec retour arrière automatique, comme S11 ; retrait de ManyChat seulement après validation de Meta.
- Attend : H04, H05, H06, H13.
