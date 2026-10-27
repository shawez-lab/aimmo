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
- Statut : en cours
- Qui : Claude · Relecture : forte · Dépend de : S06, S09
- Attend : H05 pour les mails.
- Cahier : Feuille de route, novembre 2026 : alertes acquéreurs, tâches planifiées, mention de l'assistant dans les réponses automatiques par mail.
- Objectif : à découper au début de la tâche, d'après `docs/EXISTANT.md`. Chaque bascule passe d'abord en mode essai, sans envoi réel, puis à 10 % pendant 7 jours, puis partout si les chiffres tiennent, avec retour arrière automatique.
- Statut du découpage : découpée le 2026-10-27 en B01 à B04 ci-dessous ; S11 est faite quand B04 l'est.
- Décidé (2026-10-27), lecture prudente : les automatisations qui envoient aujourd'hui sont les deux tâches à heure fixe du site (`taches.yml` → `/api/espace/taches` : rappel de visite la veille de 18 h à 21 h, mails au vendeur gardés la nuit et partis à 8 h) et la première réponse aux leads (`lead-tri.js`), déjà reprise par M02 (C06, C09). Il n'existe pas d'alertes acquéreurs sur le site : elles naîtront directement sur le socle avec M08, il n'y a rien à basculer. La bascule ne refait pas le site : le site garde ses données et ses textes, et demande au socle, avant chaque envoi, s'il peut partir ; le socle passe la demande par le contrôle central (S06). D'abord en ombre (le site envoie comme avant, le socle décide sans rien envoyer, les deux décisions sont comparées), puis le socle décide pour 10 % des envois pendant 7 jours, puis pour tous, avec retour arrière automatique. Les tâches planifiées quittent GitHub Actions pour le planificateur du Worker AIMMO. Rien n'est modifié dans `shawez-immo` sur main : ses changements passent par une branche et une proposition sur ce dépôt-là, fusionnée seulement par Shawez.

### B01 · Demande d'envoi d'une automatisation, en mode essai
- Statut : fait (2026-10-27)
- Qui : Claude · Relecture : forte · Dépend de : S06, S09
- Cahier : Feuille de route, novembre 2026 ; Architecture technique, « Le contrôle central des envois ».
- Objectif : une route `POST /v1/automatisations/envoi`, ouverte seulement à une clé de dépôt `site_auto` qui ne lit aucune fiche : le site y dit quelle automatisation (rappel de visite, courrier au vendeur), à quelle adresse, sur quel sujet et avec quel texte ; le socle retrouve la fiche par l'adresse, passe la demande par le contrôle central avec les canaux du mode essai, et rend la décision et sa règle, sans rien envoyer.
- Critères : rien ne part jamais (canaux d'essai seulement) [R26] ; une personne inconnue, exclue ou arrêtée, la nuit ou le dimanche, un doublon de sujet : refusés avec leur règle [R01, R02, R05] ; le texte du site passe le contrôle du texte ; le journal ne porte ni adresse ni texte [R13] ; une autre clé que `site_auto` est refusée.

### B02 · Planificateur du socle
- Statut : fait (2026-10-27)
- Qui : Claude · Relecture : normale · Dépend de : B01
- Cahier : Feuille de route, novembre 2026 : « plus aucune tâche du système planifiée dans les applications ».
- Objectif : le Worker `aimmo-api` a un déclencheur horaire et un registre des tâches à heure fixe, à l'heure de Paris ; chaque tâche ne passe qu'une fois par créneau, son passage est écrit au journal ; les tâches du site y sont inscrites en mode essai (le passage est noté, rien n'est appelé).
- Critères : heures de Paris été comme hiver ; une tâche, un passage par créneau même si le déclencheur passe deux fois ; une erreur est écrite au journal ; aucun appel sortant en mode essai.

### B03 · Le site demande au socle, en ombre
- Statut : à faire
- Qui : Claude · Relecture : forte · Dépend de : B01, B02
- Cahier : Feuille de route, novembre 2026.
- Objectif : sur une branche de `shawez-immo` et une proposition à fusionner par Shawez, le site appelle `POST /v1/automatisations/envoi` avant chaque rappel de visite et chaque courrier gardé, garde son propre envoi inchangé, et note les deux décisions ; un rapport compte les écarts, sans donnée personnelle.
- Critères : le site envoie exactement comme avant, même si le socle ne répond pas ; écarts comptés par règle ; aucune donnée personnelle dans le rapport.
- Attend : H04, H14, et la fusion par Shawez de la proposition sur `shawez-immo`.
- À régler ici : en essai, le contrôle range le message du site comme sortant sur la fiche, avec la mention de l'assistant [R06] ; en ombre, il faut qu'un message que le site envoie lui-même compte une seule fois dans la pression commerciale [R11] et que la mention soit celle que le site met vraiment.

### B04 · 10 % puis partout, avec retour arrière automatique
- Statut : à faire
- Qui : Claude · Relecture : forte · Dépend de : B03
- Cahier : Feuille de route, novembre 2026 ; mention de l'assistant dans les réponses automatiques par mail.
- Objectif : le socle décide pour 10 % des envois tirés au hasard pendant 7 jours, puis pour tous si les écarts tiennent ; tout écart non expliqué ou toute panne ramène automatiquement au mode ombre ; `taches.yml` est retiré du site.
- Critères : le tirage est fixe par envoi ; le retour arrière est testé ; après bascule, plus aucune tâche planifiée dans GitHub Actions du site pour ces envois.
- Attend : H05, B03 en ombre depuis 7 jours sans écart non expliqué.

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
- Statut : fait (2026-10-26)
- Qui : Claude · Relecture : normale · Dépend de : S03
- Cahier : M02, « Première réponse » et règles ; critère « 3 commentaires sur 3 vidéos ».
- Objectif : trouver le bien dont parle le message : publication ou vidéo commentée, lien d'annonce, référence de portail, référence citée dans le texte. Table de correspondance publication → bien dans la base. Sans correspondance sûre : aucun bien, jamais une supposition.
- Critères : 3 commentaires inventés sur 3 vidéos différentes donnent 3 biens différents et justes ; un lien ou une référence inconnus donnent « bien non reconnu » [R20] ; deux biens possibles donnent « bien non reconnu ».
- Attend : rien.

### C04 · Composer la première réponse
- Statut : fait (2026-10-26)
- Qui : Claude · Relecture : forte · Dépend de : C02, C03
- Cahier : M02, « Première réponse », « Conversation naturelle », règles ; Intelligence artificielle, garde-fous.
- Objectif : la première réponse avec les vraies données du bien (prix affiché, surface, quartier, atout principal) et une seule question pour avancer : visite, rappel ou estimation. Tutoiement sur Instagram, vouvoiement avec le prénom ailleurs, langue du client, clôture courte quand la personne remercie ou dit non. L'IA est une interface ; la réponse passe par le contrôle central (mention, texte, secours).
- Critères : chaque chiffre de la réponse vient de la fiche du bien [R10] ; jamais l'adresse exacte ni le nom du vendeur [R19] ; bien non reconnu : message simple et honnête sans aucune donnée de bien [R20] ; une seule question ; IA muette ou trop chère : texte de secours [R12] ; mention au premier message [R06] ; un test par canal pour le ton [R08].
- Attend : rien pour la construire ; H13 pour brancher la vraie IA.
- Décidé (2026-10-26), lecture prudente : sans bien reconnu, ou quand le vendeur porte le prénom de la personne, l'IA ne rédige pas, seuls les textes de secours partent ; l'IA reçoit le message sans mails, téléphones ni adresses ; un bien déjà envoyé à la personne n'est plus cité ; un merci reçoit une clôture sans le bien ; une seule réponse par message reçu (`first_reply_claims`), rendue après un refus ou une panne ; quartier et atout dans `property_details`.
- Reste : la vraie IA (H13) ; seuls le français et l'anglais sont gérés, une autre langue reçoit du français.

### C05 · Conversation et relais à l'agent
- Statut : fait (2026-10-26)
- Qui : Claude · Relecture : forte · Dépend de : C04
- Cahier : M02, « Relais humain », « L'IA et l'humain », règles.
- Objectif : l'état de chaque conversation : l'assistant converse jusqu'au rendez-vous ou au plus 5 échanges, puis passe la main ; l'IA se tait pour de bon dès qu'un humain répond ; l'agent voit la conversation et la reprend à tout moment.
- Critères : après la réponse d'un agent, plus aucun message automatique dans cette conversation [R21] ; au 6e message du client, l'agent est prévenu et l'assistant se tait [R21] ; sur Instagram, Facebook et WhatsApp, rien ne part hors de la fenêtre de 24 heures depuis le dernier message du client [R22] ; une relance à l'initiative du réseau ne part ni le soir ni le dimanche [R01].
- Attend : rien.
- Décidé (2026-10-26), lecture prudente : R21 et R22 sont dans la décision d'envoi, donc tenues pour tout message automatique ; sur un canal de Meta, un envoi sans conversation citée est tenu par toutes les conversations de la personne sur ce canal ; « 5 échanges » = 5 messages reçus du client ; un écho sans application connue est humain, sauf identifiant rendu par le canal à notre envoi ou, sur Meta seulement, même texte qu'un envoi encore sans identifiant ; un écho WhatsApp Business est toujours humain ; sans aucun message du client sur un canal de Meta, rien ne part ; la conversation passée à l'agent ne se rouvre jamais.
- Reste : réponse de l'agent depuis sa boîte mail non vue (avec C06) ; les réponses suivantes reprennent la première réponse de C04, une vraie conversation suivie viendra avec l'IA (H13) ; relecture de Codex de la dernière version restée en cours 30 minutes, fusion sans elle (#19).

### C06 · Mail et formulaire du site, en mode essai
- Statut : fait (2026-10-26)
- Qui : Claude · Relecture : forte · Dépend de : C05, S09
- Cahier : M02, « Branchements » ; `docs/EXISTANT.md`, `lead.js` et `lead-tri.js`.
- Objectif : brancher sur l'API du socle la réception des mails (routage mail de Cloudflare, mails de portails compris) et du formulaire « Être rappelé », de bout en bout jusqu'à la réponse, en mode essai : la réponse est écrite au journal, jamais envoyée.
- Critères : 20 messages tests par canal, de jour comme de nuit sur une horloge simulée, donnent chacun une réponse prête en moins d'une minute ; le même mail reçu deux fois ne donne qu'une réponse [R18] ; `shawez-immo` n'est pas modifié.
- Attend : H04 pour la mise en ligne seulement.
- Décidé (2026-10-26), lecture prudente : chaîne `createCaptation` de bout en bout, boîte d'essai `trial_outbox` à la place des canaux ; MIME lu sans dépendance ; chaque mail est d'abord remis tel quel à la boîte de l'agent (`MAIL_FORWARD_TO`), jamais rejeté, ce n'est pas un envoi ; clé de dépôt à part (`INTAKE_KEYS`) qui ne lit rien et ne rend que `received` ; l'heure de réception d'un mail ou d'un formulaire est celle d'AIMMO [R01] ; formulaire sans mail : l'agent est prévenu de rappeler [R12] ; un nouvel envoi reprend un rattachement abandonné ou une réponse interrompue, sans doublon.
- Reste : branchement réel avec H16 (C09), où les messages de la boîte d'essai ne devront pas compter comme partis ; intégration au site de `shawez-immo` dans une tâche à part ; relecture de Codex de la dernière version restée en cours 25 minutes, fusion sans elle (#20).

### C07 · Instagram, Facebook et WhatsApp, en mode essai
- Statut : fait (2026-10-27)
- Qui : Claude · Relecture : forte · Dépend de : C06
- Cahier : M02, « Branchements » : API Meta avec notifications en temps réel, API WhatsApp Business.
- Objectif : les points d'arrivée des notifications de Meta et de WhatsApp, avec vérification de la signature, en mode essai, testés sur des notifications inventées. ManyChat reste seul à répondre.
- Critères : une notification à la signature fausse est refusée ; 20 messages tests par canal donnent une réponse prête en moins d'une minute ; un commentaire reçoit une réponse qui cite le bon bien ; aucun envoi réel ; ManyChat intouché.
- Attend : H06 pour recevoir les vraies notifications de Meta.
- Décidé (2026-10-27), lecture prudente : une seule adresse `/v1/meta/notifications` pour les trois canaux, signature HMAC du corps brut, jeton d'abonnement gardé en empreinte ; un écho d'une application qui n'est pas la nôtre est humain (pendant l'essai, ManyChat fait donc taire l'assistant dans sa conversation) ; un écho dont la conversation n'existe pas encore est gardé (`pending_human_replies`) et appliqué avant toute réponse, reprise comprise ; sur Instagram et Facebook, la réponse va à la conversation reçue (compte propre au canal ou commentaire), seulement si un message de la personne y est rangé.
- Reste : avant tout envoi réel (C09), sérialiser par conversation l'écho humain et le premier message traités en même temps (fenêtre étroite signalée par Codex, sans effet en essai) ; branchement chez Meta avec H06 et H17 ; relecture forte (1 P1 corrigé), Codex : 4 P0 corrigés en 4 tours, le dernier réduit et reporté à C09 (#21).

### C08 · API de l'assistant du site, en mode essai
- Statut : fait (2026-10-27)
- Qui : Claude · Relecture : forte · Dépend de : C05, S09
- Cahier : M02, « Canaux » : assistant du site.
- Objectif : l'API que l'assistant du site appellera : ouvrir une conversation, envoyer un message, recevoir la réponse, avec les mêmes règles que les autres canaux. Son intégration au site sera une proposition sur `shawez-immo`, faite dans une tâche à part, jamais directement sur main.
- Critères : 20 messages tests donnent une réponse en moins d'une minute ; mention au premier message [R06] ; une conversation sans accord ne laisse aucune donnée personnelle au-delà de ce que la personne a écrit [R15] ; appels limités par visiteur.
- Attend : H04 pour la mise en ligne seulement.
- À savoir au départ (2026-10-27) : `site` n'est pas un canal de sortie (`CHANNELS`, `consents`, `exclusions` ne l'admettent pas) et `replyChannel` de C04 ne rend rien pour l'assistant ; la réponse de l'assistant doit pourtant passer par le contrôle central (R02, R04, R06, R10, R19, R21). Choisir d'abord comment, par la lecture la plus prudente.
- Décidé (2026-10-27), lecture prudente : `site` devient un canal de sortie (`OUTBOUND_CHANNELS`) sans toucher `CHANNELS`, ni les accords, ni les exclusions, qui restent par personne ; sur ce canal, seulement la réponse dans la session du visiteur et dans l'heure de son message, jamais d'initiative [R03, R01] ; la réponse va à la session d'où la personne a écrit, vérifiée comme les conversations de Meta ; même clé de dépôt `INTAKE_KEYS`, avec une source `site_chat` qui n'ouvre que l'assistant ; visiteur connu par l'empreinte d'un identifiant opaque donné par le site, jamais d'adresse IP ni de navigateur [R15] ; limites par heure prises en une seule instruction ; en essai, `reply` vaut `null`. Un visiteur garde une seule fiche d'une conversation à l'autre (empreinte de son identifiant comme référence du canal), pour qu'un arrêt vaille pour toutes [R02, R04].
- Reste : intégration au site de `shawez-immo` dans une tâche à part ; texte rendu au visiteur avec le branchement réel (C09) ; relecture forte (aucun P0 ni P1), Codex : 1 P0 corrigé, dernière version validée (#22).

### C09 · Mise en service de la captation
- Statut : à faire
- Qui : Claude · Relecture : forte · Dépend de : C06, C07, C08, S11
- Cahier : M02, « État » ; Feuille de route, décembre 2026.
- Objectif : à découper au début de la tâche : canal par canal, mode essai puis 10 % pendant 7 jours puis partout si les chiffres tiennent, avec retour arrière automatique, comme S11 ; retrait de ManyChat seulement après validation de Meta.
- Attend : H04, H05, H06, H13.

**M03 · Qualifier et attribuer, décembre 2026.**

Découpé le 2026-10-27. Ids `Q..` pour Qualifier. Cahier : M03 Qualifier ; Feuille de route, décembre 2026 : « 90 % de 50 cas réels classés comme Shawez l'aurait fait ».
Décidé, lecture prudente : l'IA classe et extrait derrière une interface, avec une fausse IA dans les tests et un classement par règles fixes quand elle manque ; la note et l'attribution suivent des règles fixes écrites dans le code, sans IA, pour que chaque note soit explicable et chaque attribution la même pour tous [R14] ; rien n'est envoyé à qui que ce soit par M03 ; le délai de rappel de la charte de service n'est pas chiffré dans le cahier : c'est un réglage, le jour même pour un contact chaud et 24 heures sinon, jusqu'à ce que Shawez en décide autrement.

### Q01 · Classer et extraire un contact
- Statut : fait (2026-10-27)
- Qui : Claude · Relecture : forte · Dépend de : C05
- Cahier : M03, « Ce que fait le module » points 1 et 2, « Règles ».
- Objectif : pour chaque message rattaché, une qualification : catégorie (vendeur, acquéreur, estimation, mise en location, professionnel, partenaire, curiosité, indésirable) et champs extraits (bien, commune, budget ou prix, délai, financement déclaré, critères), rangés dans le projet de la fiche, créé ou complété. L'IA passe par une interface ; sans elle, des règles fixes sur les mots du message. Une location est marquée pour M15, un commerce pour M16, un investisseur pour M17.
- Critères : un jeu de 50 cas inventés couvre les 8 catégories, classés juste par les règles fixes à 90 % au moins ; une sortie de l'IA hors des champs prévus ou portant une donnée sensible est refusée et remplacée par les règles fixes [R23] ; le financement n'est rangé que s'il est déclaré dans le message, jamais évalué [R24] ; rien ne part chez l'IA au-delà du texte reçu, sans coordonnée [R15] ; une correction de l'agent est gardée et rejoint les cas de test.
- Attend : H13 pour la vraie IA seulement.
- Décidé (2026-10-27), lecture prudente : commune prise dans une liste fermée (réglage) et critères dans une liste fermée de mots sur le bien ; un financement n'est rangé que dit comme acquis ou en cours, jamais nié, espéré, au futur ni contradictoire [R24] ; l'IA ne lit ni coordonnée, ni nom, ni signature [R15] ; ses montants doivent être des montants du message ; le délai déclaré reste dans la qualification, la colonne `projects.deadline` étant une date qu'il faudrait inventer [R10].
- Reste : branchement dans la chaîne et correction depuis l'API (Q05) ; remarques mineures de Codex laissées (#23) : critères niés (« sans jardin »), budget « frais inclus », contexte des montants dans le contrôle de l'IA, délai dans le projet ; relecture forte (1 P0 corrigé), Codex : 5 P0 et 2 P1 corrigés en 5 tours, dernière version sans P0 ni P1.

### Q02 · Note et température
- Statut : fait (2026-10-27)
- Qui : Claude · Relecture : forte · Dépend de : Q01
- Cahier : M03, point 3 et « Règles » : chaque note explicable par sa raison écrite.
- Objectif : une note de 0 à 100 et une température (froid, tiède, chaud) par barème fixe écrit dans le code, d'après la catégorie, le bien reconnu, le délai et la précision de la demande, avec la raison en une ligne.
- Critères : chaque note a sa raison en une ligne, sans donnée personnelle [R24] ; la note ne dépend jamais du financement ni de la solvabilité, ni d'aucun critère discriminant : changer seulement ces champs ne la change pas [R14, R24] ; même contact, même note.
- Attend : rien.
- Décidé (2026-10-27), lecture prudente : le barème ne lit aucun montant (un montant peut dire le financement) [R24] ; un candidat à une location (suite M15, hors propriétaire) ne reçoit aucune note [R14] ; un partenaire ou un indésirable valent 0.
- Reste : relecture forte (1 P0 corrigé), Codex : 1 P0 corrigé, sa relecture de la correction restée en cours 25 min, fusion sans elle (#24).

### Q03 · Zones et attribution à l'agent
- Statut : fait (2026-10-27)
- Qui : Claude · Relecture : forte · Dépend de : Q01
- Cahier : M03, points 4 et 6 ; « Branchements » : zones des agents par commune.
- Objectif : les zones des agents par commune, puis l'attribution de chaque contact qualifié à l'agent de sa commune par règles fixes, sans IA, et la réattribution par la même règle si le contact n'est pas rappelé dans le délai de la charte ; les règles, lisibles, rendues par l'API pour l'application.
- Critères : aucun contact exclu ou qui a dit stop n'est attribué [R25] ; même contact, même agent, quel que soit l'ordre d'arrivée ; commune sans agent : à la direction, jamais au hasard ; réattribution dans le délai simulé, une seule fois par délai, écrite au journal [R13] ; un agent parti ne reçoit plus rien.
- Attend : la liste des communes de chaque agent, plus tard, au recrutement ; les tests utilisent des zones inventées.
- Décidé (2026-10-27), lecture prudente : tirage fixe (FNV-1a) sur l'identifiant de la fiche parmi les agents en activité de la commune ; un client suivi sur l'une de ses fiches réunies reste à cet agent ; partenaire à la direction, indésirable à personne ; délais de rappel en réglage, 8 heures si chaud, 24 sinon ; rappelé = un message sortant écrit par un humain du réseau depuis l'attribution.
- Reste : remarques mineures de Codex (#25) : agent parti sur une fiche réunie lors d'une attribution, reprise des effets d'une attribution interrompue, délai qui repart à chaque nouveau message ; relecture forte (1 P1 corrigé), Codex sans P0 ni P1.

### Q04 · Tâche « rappeler » et liste des contacts chauds
- Statut : fait (2026-10-27)
- Qui : Claude · Relecture : forte · Dépend de : Q02, Q03
- Cahier : M03, point 5 ; Feuille de route, décembre 2026 : rapport du matin.
- Objectif : une tâche « rappeler » pour chaque contact chaud, chez son agent, et la liste des contacts chauds du matin et du soir, rendue par l'API sous droits d'accès [R16].
- Critères : chaque contact chaud a sa tâche en moins d'une minute, sur une horloge simulée ; une seule tâche par contact et par projet [R18] ; la liste ne montre à un agent que ses contacts [R16] ; aucun contact exclu n'y figure [R25] ; aucune notification n'est envoyée (l'application viendra en janvier).
- Attend : rien.
- Décidé (2026-10-27) : la clé d'une tâche est son projet (une seule tâche par projet, fusion comprise) ; « matin » avant 14 h, heure de Paris, « soir » ensuite ; la liste passe par `Acces.listPersons` [R16].
- Reste : remarque mineure de Codex (#26) : tâches portées par une fiche réunie à une fiche visible ; relecture forte (1 P1 corrigé), Codex sans P0 ni P1.

### Q05 · Qualification dans la chaîne de captation, et mesure sur cas réels
- Statut : fait (2026-10-27)
- Reste : la mesure réelle, qui attend H13 et H18.
- Qui : Claude · Relecture : forte · Dépend de : Q04, C08
- Cahier : M03, « Critères d'acceptation » ; Feuille de route, décembre 2026.
- Objectif : brancher Q01 à Q04 derrière chaque message reçu, en mode essai, et un banc de mesure qui compare le classement à celui de Shawez sur des cas anonymisés, sans aucune donnée personnelle dans le dépôt.
- Critères : chaque nouveau contact a fiche, qualification, note, agent et, s'il est chaud, sa tâche en moins d'une minute ; le banc rend le taux d'accord et la liste des écarts, sans texte de message au journal [R13] ; 90 % de 50 cas réels quand H18 et H13 sont faits.
- Attend : H13 et H18 pour la mesure réelle ; le reste se fait avant.
- Décidé (2026-10-27) : la suite de M03 passe après toutes les réponses du lot et ne lève jamais d'erreur ; banc de mesure par `AIMMO_CAS` hors du dépôt (`docs/MESURE.md`), sauté sans fichier.
- Reste : mesure réelle (H13, H18) ; au branchement réel (C09), qualifier par `ctx.waitUntil` du Worker pour que la réponse HTTP n'attende pas une vraie IA ; relecture forte (2 P1 corrigés), relecture de Codex restée en cours plus de 30 min, fusion sans elle (#27).

**M04 · Estimer, janvier 2027.**

Découpé le 2026-10-27. Ids `E..` pour Estimer. Cahier : M04 Estimer ; Feuille de route, janvier 2027 : « sur 20 biens, écart médian de moins de 10 % entre la fourchette AIMMO et l'estimation de l'agent ».
Décidé, lecture prudente : on reprend la méthode qui tourne sur le site (`functions/_lib/estimation.js` de `shawez-immo`, lu sans être modifié) au lieu de la refaire : comparables DVF de même type et de surface proche, rayon élargi jusqu'à 12 ventes, médiane du prix au m², marge par l'écart interquartile, ajustements bornés ; le diagnostic énergétique s'y ajoute comme le demande le cahier. Les calculs sont faits par le code ; l'IA ne rédige que le texte, derrière une interface, avec une fausse IA dans les tests. Les données publiques (DVF, ADEME, Géorisques, Base adresse nationale, cadastre) passent par des interfaces, avec de faux jeux inventés dans les tests. Aucun avis ne part sans validation de l'agent, et aucun ne part réellement tant que le plan n'a pas mis d'envoi en service.

### E01 · Fourchette de prix par le code
- Statut : fait (2026-10-27)
- Qui : Claude · Relecture : forte · Dépend de : rien
- Cahier : M04, « Ce que fait le module » (calcul par le code) et « Règles ».
- Objectif : à partir d'une liste de ventes réelles (source abstraite) et des caractéristiques du bien, choisir les comparables, calculer le prix au m² médian, la fourchette basse et haute, les ajustements écrits (étage, extérieur, état, époque, diagnostic énergétique), et rendre la date des dernières ventes utilisées.
- Critères : chaque comparable rendu est une vente de la source, avec sa date [R27] ; moins de 5 comparables, type non résidentiel ou bien hors zone couverte : pas de fourchette, avec sa raison [R27] ; la date des dernières ventes et l'avertissement quand les plus récentes manquent sont toujours rendus [R28] ; Bas-Rhin, Haut-Rhin, Moselle et Mayotte : aucune vente DVF, et le résultat le dit [R28] ; mêmes résultats que la méthode du site sur des cas inventés.
- Décidé (2026-10-27) : le cahier ne chiffre pas l'ajustement du diagnostic énergétique ; réglage de départ A +3 %, B +2 %, C et D 0, E -2 %, F -5 %, G -8 %, dans les bornes de -25 % à +18 %, à confirmer par Shawez sur la mesure de E07.

### E02 · Ventes DVF du site comme source
- Statut : fait (2026-10-27)
- Qui : Claude · Relecture : normale · Dépend de : E01
- Cahier : M04, « Données » et « Branchements » (fichiers DVF de data.gouv.fr).
- Objectif : lire les ventes DVF déjà préparées par le site (`donnees-dvf/` : index, tuiles, détails), en lecture seule, comme source de E01 ; le détail d'une vente donne la voie sans numéro et la commune.
- Critères : aucune écriture ni appel autre qu'une lecture ; jamais de numéro de voie ni de nom rendu [R29] ; une tuile absente ou illisible ne casse rien et est comptée ; jeux de test inventés au format du site.

### E03 · Collecte des données publiques du bien
- Statut : fait (2026-10-27)
- Qui : Claude · Relecture : normale · Dépend de : E01
- Cahier : M04, « Collecte automatique » et « Branchements ».
- Objectif : à partir d'une adresse, retrouver ses coordonnées (Base adresse nationale), la parcelle (cadastre), le diagnostic énergétique (ADEME) et les risques (Géorisques), chacun derrière une interface, avec ce qui manque dit clairement.
- Critères : chaque donnée porte sa source et sa date ; une source en panne ne bloque pas les autres ; aucune donnée personnelle envoyée aux services publics au-delà de l'adresse du bien ; la vérification réelle sur 10 biens tests se lance à la main, hors des tests automatiques.
- Attend : H20 pour la vérification réelle sur 10 biens ; le reste se fait avant.

### E04 · Brouillon d'avis de valeur et validation par l'agent
- Statut : fait (2026-10-27)
- Reste : la mise en page PDF à la marque de l'agent, quand l'application de l'agent l'affichera.
- Qui : Claude · Relecture : forte · Dépend de : E01, E02, E03
- Cahier : M04, « Rédaction par l'IA » et « Validation ».
- Objectif : un brouillon d'avis (méthode, comparables sans nom, fourchette, arguments, plan de commercialisation, date des données) rangé sur le bien ; l'IA rédige derrière une interface, un texte de secours sans IA sinon ; l'agent ajuste la fourchette et le texte, puis valide ; la mise en page à la marque de l'agent se fait sur le brouillon validé.
- Critères : aucun avis ne peut partir sans validation de l'agent qui suit le bien [R30] ; chaque chiffre du texte vient du calcul [R10] ; l'avis dit que c'est un avis et que le prix appartient au vendeur ; les ajustements de l'agent sont gardés à côté du calcul.

### E05 · Estimation en ligne du site
- Statut : fait (2026-10-27)
- Reste : brancher le site sur la route (proposition sur `shawez-immo`, avec la clé `site_estimate`, H14) et ranger `DVF_BASE_URL` au déploiement.
- Qui : Claude · Relecture : forte · Dépend de : E01, E02
- Cahier : M04, « Estimation en ligne ».
- Objectif : une route de l'API pour le site qui rend la fourchette de la commune seulement, jamais le prix d'un bien précis sans visite, puis propose un rendez-vous.
- Critères : aucun prix précis d'un bien rendu [R31] ; limites d'appels ; aucune donnée du visiteur gardée au-delà de sa demande ; mode essai.

### E06 · Suivi du vendeur
- Statut : fait (2026-10-27)
- Décidé (2026-10-27) : relance après 3 jours sans réponse du vendeur ni message de son agent (réglage `delayDays`, le cahier ne le chiffre pas) ; refus pour l'heure repris au créneau suivant, tout autre refus définitif.
- Reste : le vrai envoi de l'avis et de la relance, quand le plan mettra un canal en service.
- Qui : Claude · Relecture : normale · Dépend de : E04, B02
- Cahier : M04, « Suivi ».
- Objectif : après l'envoi d'un avis, une relance du vendeur s'il ne répond pas, par le planificateur et le contrôle central, en mode essai.
- Critères : une relance par avis au plus, dans les heures d'envoi [R01], jamais à une personne exclue ou qui a demandé l'arrêt [R02, R04] ; rien ne part en mode essai.

### E07 · Mesure sur 20 biens
- Statut : fait (2026-10-27)
- Reste : la mesure réelle sur 20 biens (H19), qui dira aussi si le réglage du diagnostic énergétique de E01 tient ; relecture de Codex restée en cours plus de 30 min, fusion sans elle (#36).
- Qui : Claude · Relecture : normale · Dépend de : E01, E02
- Cahier : M04, « Critères d'acceptation » ; Feuille de route, janvier 2027.
- Objectif : un banc qui compare la fourchette AIMMO à l'estimation de l'agent sur des biens anonymisés gardés hors du dépôt, et rend l'écart médian et chaque écart avec son explication.
- Critères : écart médian de moins de 10 % sur 20 biens réels ; aucun bien réel dans le dépôt ; le banc se saute sans fichier.
- Attend : H19.

**M05 · Rendez-vous, février 2027.**

Découpé le 2026-10-27. Ids `V..` pour rendez-Vous. Cahier : M05 Rendez-vous ; Feuille de route, février 2027.
Décidé, lecture prudente : l'agenda Google passe par une interface, avec un faux agenda dans les tests ; le vrai branchement attend H21. Tout message (confirmation, rappel, tournée partagée) passe par le contrôle central, avec les seuls canaux du mode essai tant que le plan n'a pas mis d'envoi en service. Les durées et le temps de trajet sont des réglages.

### V01 · Disponibilités et créneaux libres
- Statut : fait (2026-10-27)
- Décidé (2026-10-27) : réglages de départ estimation 60 min, visite 45, signature 60, appel 20, trajet 30 min (aussi autour des événements occupés de l'agenda), pas de 15 min, délai minimal 2 h.
- Qui : Claude · Relecture : forte · Dépend de : rien
- Cahier : M05, « Créneaux libres » et « Règles ».
- Objectif : à partir des disponibilités que l'agent fixe (jours, heures, exceptions) et des événements occupés de son agenda (interface), rendre les créneaux libres par type de rendez-vous (estimation, visite, signature, appel), chacun avec sa durée, en gardant le temps de trajet entre deux rendez-vous.
- Critères : aucun créneau hors des disponibilités de l'agent ni sur un événement occupé [R33] ; aucun créneau qui chevauche un rendez-vous ou ne laisse pas le temps de trajet [R32] ; heure de Paris, changement d'heure compris ; un appel ne demande pas de trajet.

### V02 · Réservation, confirmation et annulation
- Statut : fait (2026-10-27)
- Décidé (2026-10-27) : la confirmation est un envoi d'initiative (heures d'envoi R01, accord « rendez-vous » R03) ; refusée pour l'heure, elle attend V04. Plages et trajet en multiples de 5 minutes.
- Reste : relecture de Codex de la dernière version restée en cours près de 30 min, fusion sans elle (#38), toutes ses remarques précédentes corrigées.
- Qui : Claude · Relecture : forte · Dépend de : V01
- Cahier : M05, « Réservation en ligne » et « Critères d'acceptation ».
- Objectif : la table des rendez-vous ; réserver un créneau libre de façon atomique, confirmer tout de suite par le contrôle central (mode essai), décaler ou annuler par un lien à jeton ; le créneau annulé redevient libre aussitôt.
- Critères : deux réservations du même créneau en même temps, une seule passe [R32] ; une annulation libère le créneau en moins d'une minute ; 10 rendez-vous tests sans doublon ni oubli ; le lien ne porte ni nom ni coordonnée, et ne sert qu'à son rendez-vous.

### V03 · Agenda Google derrière une interface
- Statut : fait (2026-10-27)
- Décidé (2026-10-27) : un déplacement fait dans l'agenda suit les règles d'un décalage ; refusé, ou fin seule changée, l'événement est remis et le conflit noté ; agenda en panne, aucune réservation nouvelle.
- Reste : le fournisseur Google réel (H21) ; relecture de Codex de la dernière version restée en cours près de 30 min, fusion sans elle (#39), ses deux P0 et son P2 précédents corrigés.
- Qui : Claude · Relecture : normale · Dépend de : V02
- Cahier : M05, « Branchements » (API Google Agenda, dans les deux sens).
- Objectif : lire les événements occupés de l'agent et écrire ses rendez-vous dans son agenda, derrière une interface ; un faux agenda dans les tests ; une modification faite dans l'agenda revient sur le rendez-vous.
- Critères : un rendez-vous n'est écrit qu'une fois dans l'agenda ; une panne de l'agenda ne perd aucune réservation et est notée ; l'agenda ne reçoit que l'heure, le type et un intitulé sans coordonnée.
- Attend : H21 pour le vrai branchement ; le reste se fait avant.

### V04 · Rappels la veille et le jour même
- Statut : fait (2026-10-27)
- Décidé (2026-10-27) : veille et jour même en dates de Paris ; un rappel manqué ce jour-là (dimanche, férié, hors heures) n'est pas reporté ; pas de rappel le jour où un autre message du même rendez-vous est déjà parti ; chaque rappel porte un lien neuf ; sans canal choisi à la réservation, aucun message. Tâche `rdv.rappels` du lundi au samedi, 8 h à 19 h ; lien par `RDV_LINK_BASE`.
- Reste : relecture de Codex impossible (« Repository could not be found », deux fois), fusion sans elle (#40) ; ranger `RDV_LINK_BASE` au déploiement.
- Qui : Claude · Relecture : normale · Dépend de : V02, B02
- Cahier : M05, « Rappels » et « Règles ».
- Objectif : par le planificateur, un rappel la veille et un le jour même, avec le lien pour décaler ou annuler, par le contrôle central, en mode essai.
- Critères : aucun rappel le dimanche ni hors des heures d'envoi [R01] ; un rappel de chaque sorte au plus par rendez-vous [R05] ; rien pour un rendez-vous annulé ; jamais à une personne exclue ou qui a demandé l'arrêt [R02, R04] ; les confirmations en attente (`confirmation_status = 'waiting'`, refusées pour l'heure en V02) partent au premier créneau des heures d'envoi.

### V05 · Brief du rendez-vous
- Statut : fait (2026-10-27)
- Décidé (2026-10-27) : brief fait par le code, sans IA ; ventes du quartier prises dans le dernier avis de valeur du bien ; itinéraire vers la commune, l'adresse exacte n'étant pas en base (le brief le dit) ; questions et documents en listes de réglage par type ; tâche `rdv.briefs` à toute heure, brief figé.
- Reste : relecture de Codex impossible (H03), fusion sans elle (#41) ; relecture forte : aucun P0 ni P1.
- Qui : Claude · Relecture : forte · Dépend de : V02, E01
- Cahier : M05, « Brief du rendez-vous ».
- Objectif : une heure avant chaque rendez-vous, un brief rangé pour l'agent : le client et son histoire, le bien, les ventes du quartier, les questions à prévoir, les documents à apporter, le lien d'itinéraire vers l'application de navigation.
- Critères : chaque élément du brief vient de la base ou d'une source citée, rien d'inventé [R34] ; ce qui manque est dit ; 10 briefs tests prêts une heure avant ; le brief n'est lu que par l'agent du rendez-vous.

### V06 · Statut et compte rendu
- Statut : fait (2026-10-27)
- Décidé (2026-10-27) : honoré ou absent se marque une fois le rendez-vous commencé ; annulé passe par l'annulation de V02 ; un compte rendu est figé, d'autres peuvent s'ajouter ; une tâche `follow_absent` par absent.
- Reste : relecture de Codex impossible (H03), fusion sans elle (#42).
- Qui : Claude · Relecture : normale · Dépend de : V02
- Cahier : M05, « Statut ».
- Objectif : l'agent marque le rendez-vous honoré, absent ou annulé, puis range son compte rendu (texte dicté, la transcription viendra avec l'application de l'agent) ; une tâche suit un absent.
- Critères : seul l'agent du rendez-vous change son statut ; un statut final ne change plus ; le journal ne porte pas le texte du compte rendu [R13].

### V07 · Visites enchaînées et tournée partagée
- Statut : fait (2026-10-27)
- Décidé (2026-10-27) : le secteur est la commune (pas de coordonnées des biens en base) ; 8 visites au plus ; proposition seule, rien réservé ; le proche est une fiche du réseau avec son accord `route_share` [R03] ; les appels ne sont pas dans la tournée ; une tournée changée peut repartir.
- Reste : relecture de Codex impossible (H03), fusion sans elle (#43).
- Qui : Claude · Relecture : normale · Dépend de : V01
- Cahier : M05, « Visites enchaînées » et « Règles » (tournée partagée).
- Objectif : proposer un ordre de visites dans un même secteur qui tient dans les disponibilités et les temps de trajet ; l'agent peut envoyer sa tournée du jour à un proche ou à son accompagnateur, par le contrôle central, en mode essai.
- Critères : l'ordre proposé respecte R32 et R33 ; la tournée envoyée ne porte que les heures et les communes, jamais d'adresse exacte ni de nom de client [R09] ; rien ne part sans que l'agent le demande.

### V08 · Réservation depuis le site et les messages, en mode essai
- Statut : en cours
- Qui : Claude · Relecture : forte · Dépend de : V02
- Cahier : M05, « Réservation en ligne ».
- Objectif : des routes de l'API pour lister les créneaux libres d'un agent et réserver, appelées par le site, l'assistant et l'espace client, avec la clé de l'appelant ; en mode essai.
- Critères : aucune donnée de l'agenda au-delà des créneaux libres ; l'accord « rendez-vous » de la personne enregistré avec sa preuve au moment où elle réserve [R03] ; limites d'appels ; une réservation rend sa confirmation tout de suite ; rien ne part en mode essai.
- Attend : H14 pour le premier appelant réel.
