# Plan du chantier

Statuts possibles : `à faire`, `en cours`, `chez Codex depuis le <date>`, `fait (<date>)`, `bloquée : <raison>`.
Relecture : `normale` = tests + relecture de Codex. `forte` = tests + relecture de Codex + relecture par un agent séparé.
Les tâches se font dans l'ordre, dès que leurs dépendances sont faites. Le découpage des modules suivants se fait au fil de l'eau (protocole, section 5).

## Priorité de Shawez (avant tout le reste, voie 1)

### Z02 · Accès de Shawez à l'application en un clic
- Statut : fait (2026-10-28)
- Décidé (2026-10-28) : le secret `API_KEYS` n'est ni lu ni réécrit (un secret ne se lit pas : le réécrire perdrait ses empreintes) ; les clés d'invitation sont rangées en base (empreinte seule, `access_keys`) et s'ajoutent au secret ; le Worker les tire au moment où le lien sert ; le mail part par l'envoi de mails de Cloudflare, depuis le travail ; exception au contrôle central écrite en R200 (Codex la classait P0, réfutée dans #148).
- Qui : Claude, relecture forte
- Dépendances : aucune
- Objectif : l'application https://aimmo-api.shawez.workers.dev/app/ répond « API fermée : aucune clé configurée ». Shawez doit pouvoir entrer sans rien taper de technique. Un workflow GitHub lancé à la main (« Créer l'accès de Shawez ») tire une clé au hasard, range seulement son empreinte dans le secret `API_KEYS` du Worker avec `wrangler secret put` (le jeton Cloudflare est déjà dans les secrets du dépôt), crée la fiche agent de Shawez avec le rôle direction et agent, et lui remet la clé par un lien d'invitation à usage unique, valable 24 heures, envoyé à shawez@gravelin-immo.com. La clé n'apparaît jamais dans les journaux, le dépôt ni le chat. Le lien ouvre l'application déjà connectée.
- Critères : clé jamais écrite en clair hors du navigateur de Shawez (test) ; lien à usage unique, expiré refusé (test) ; empreintes déjà présentes dans `API_KEYS` conservées (test) ; journal sans clé (test [R13]).
- Ce qu'elle attend d'un humain : rien. Une fois fusionnée, la séance lance elle-même le workflow ; Shawez n'a qu'à cliquer sur le lien reçu par mail.

### Z04 · Lien d'accès de Shawez sans mail Cloudflare
- Statut : fait (2026-10-28)
- Décidé (2026-10-28) : entrée `remise` (`mail` par défaut, `resume`) ; en `resume`, le lien n'est écrit que dans `GITHUB_STEP_SUMMARY` ; prénom, nom et adresses lus dans l'événement du lancement, jamais dans l'environnement affiché des étapes ; prénom et nom non masqués en `resume` (le masque de GitHub casserait le lien du résumé) ; relecture forte 2 P1, Codex 1 P0 corrigés (#161) ; travail lancé le 2026-10-28 à 21:53 en `resume`, réussi.
- Qui : Claude, relecture forte
- Dépendances : Z02
- Objectif : l'envoi par Cloudflare échoue toujours (HTTP 401, code 10000, H33 non réglé). Ajouter au travail « Créer l'accès de Shawez » un mode de remise sans mail : le lien à usage unique, valable 24 heures, est écrit seulement dans le résumé du travail GitHub (dépôt privé, visible du seul compte shawez-lab), jamais dans les journaux du travail ni dans le dépôt. Puis lancer le travail dans ce mode et noter dans « Besoin de toi » : « Ton lien t'attend dans GitHub : Actions > Créer l'accès de Shawez > dernier passage > Summary. »
- Critères : le lien n'apparaît pas dans la sortie du travail (test) ; le mode mail reste le défaut (test) ; lien à usage unique et expiré refusé (tests de Z02 repris).

### Z03 · Passe de design de l'application et des pages publiques
- Statut : fait (2026-10-28)
- Décidé (2026-10-28) : identité « toits vernissés de Bourgogne » (papier, encre, bordeaux, moutarde, losange des tuiles), polices du système, base unique `packages/core/src/design/systeme.ts`, contrôle dans `audit.ts`, règle R201 ; budgets 14 Ko (page) et 48 Ko (application) compressés ; captures dans `docs/design/captures/` ; axe-core sans violation sur 9 écrans, clair et sombre ; relecture forte 2 P1 et 2 défauts corrigés ; Codex en cours au bout de 15 min, fusion sans lui (#152). U11 peut reprendre.
- Qui : Claude, relecture forte
- Dépendances : Z02
- Objectif : un système de design propre à AIMMO (couleurs, typographie, espacements, composants, mouvements) appliqué à tous les écrans existants, téléphone d'abord. Rien de générique ni qui ressemble à un site fait par une IA ; niveau des meilleures applis du monde. Captures avant et après dans la proposition.
- Critères : chaque écran passe un contrôle d'accessibilité automatique et un budget de performance (tests) ; aucun écran en dehors du système de design (test) ; Codex relit aussi les captures.

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
- Statut : fait (2026-10-27)
- Décidé (2026-10-27) : clé de dépôt `site_booking` ; estimation, visite et appel seulement ; seul un créneau proposé se réserve ; personne retrouvée par tous les contacts donnés (fiche unique, téléphone et WhatsApp confondus), sinon fiche neuve suivie par l'agent ; plusieurs fiches distinctes : pas de confirmation par message ; accord retiré si la réservation échoue ; confirmation rendue toujours la même `{ booked: true }` [R16]. Le brief (V05) ne montre client, histoire et bien que si l'agent du rendez-vous a le droit de les voir.
- Reste : rien (les deux P2 de Codex faits en V09).
- Qui : Claude · Relecture : forte · Dépend de : V02
- Cahier : M05, « Réservation en ligne ».
- Objectif : des routes de l'API pour lister les créneaux libres d'un agent et réserver, appelées par le site, l'assistant et l'espace client, avec la clé de l'appelant ; en mode essai.
- Critères : aucune donnée de l'agenda au-delà des créneaux libres ; l'accord « rendez-vous » de la personne enregistré avec sa preuve au moment où elle réserve [R03] ; limites d'appels ; une réservation rend sa confirmation tout de suite ; rien ne part en mode essai.
- Attend : H14 pour le premier appelant réel.

### V09 · Confirmation à la coordonnée donnée, et journal en panne après une réservation en ligne
- Statut : fait (2026-10-27)
- Qui : Claude · Relecture : normale · Dépend de : V08
- Cahier : M05, « Réservation en ligne » ; remarques P2 de Codex sur #44.
- Objectif : la confirmation et les rappels d'un rendez-vous réservé en ligne visent la coordonnée donnée à la réservation, même si la fiche porte un autre mail plus ancien (le contrôle central reçoit une coordonnée précise, qui doit appartenir à la fiche) ; une panne du journal après une réservation en ligne réussie rend quand même le rendez-vous et son jeton, avec un avertissement.
- Critères : la boîte d'essai montre la confirmation adressée au mail donné, pas à l'ancien ; une coordonnée qui n'est pas à la fiche est refusée ; journal en panne après réservation : réponse 200 avec jeton et avertissement, panne notée [R13].

**M20 · Gagner des mandats, première version, janvier 2027.**

Découpé le 2026-10-27. Ids `G..` pour Gagner. Cahier : M20 Gagner des mandats ; Feuille de route, janvier 2027 : « premières versions de M20 et de l'application de l'agent », « application et plan du jour utilisés chaque matin pendant une semaine ».
Décidé, lecture prudente : la première version, pour la preuve à Dijon, couvre le plan du jour, le suivi de valeur et la source de chaque mandat, avec leurs trois critères d'acceptation. Les lettres de quartier, le dossier de présentation, les recommandations et la relance des anciens contacts viendront avec le module complet (octobre 2027), après M06, M11, M18 et M19 dont ils dépendent. Le plan du jour est calculé par le code, par des règles écrites et les mêmes pour tous, sans IA [R35] ; il ne porte que les clients de l'agent [R16], et seulement des personnes qui ont une base légale : une demande de leur part encore récente ou un accord en cours, jamais une personne exclue ou qui a demandé l'arrêt [R36]. Aucune donnée de ventes publiques ne sert à retrouver un propriétaire [R29, R37]. Rien n'est envoyé à un client par M20 tant que le plan n'a pas mis d'envoi en service : tout passe par le contrôle central, en mode essai. Les durées (demande « récente », estimation « à relancer ») sont des réglages : 13 mois pour une demande, 30 jours pour relancer une estimation sans réponse, jusqu'à ce que Shawez en décide autrement. L'application de l'agent est découpée à part, après M20.

### G01 · Plan du jour : contenu et ordre
- Statut : fait (2026-10-27)
- Qui : Claude · Relecture : forte · Dépend de : Q04, E06, V02
- Cahier : M20, point 1, « Règles ».
- Objectif : une fonction du socle qui, pour un agent et une date, rend son plan du jour : propriétaires qui ont demandé un rappel (tâches « rappeler » ouvertes), estimations à relancer (avis envoyé sans réponse ni rendez-vous depuis le délai réglé), rendez-vous à proposer (projet de vente ou d'estimation sans rendez-vous à venir) ; chaque ligne dit sa raison en une ligne et sa base légale. L'ordre suit des règles écrites : demande de rappel d'abord, puis délai annoncé par le propriétaire le plus proche, puis estimation la plus ancienne ; à égalité, la plus ancienne demande.
- Critères : le même plan pour les mêmes données, ordre expliqué ligne par ligne, aucune note de l'IA [R35] ; seulement les clients de l'agent [R16] ; une personne exclue, arrêtée, sans demande récente ni accord en cours n'y figure jamais, et son retrait est compté sans donnée personnelle [R36] ; un contact n'y figure qu'une fois, sous sa raison la plus forte.

### G02 · Plan du jour à 7 h 30, par le planificateur
- Statut : fait (2026-10-27)
- Qui : Claude · Relecture : normale · Dépend de : G01, B02
- Cahier : M20, « Critères d'acceptation » : « le plan du jour arrive chaque matin à 7 h 30 dans l'application ».
- Objectif : le planificateur du socle fige à 7 h 30, heure de Paris, le plan du jour de chaque agent actif, une fois par agent et par jour ; une route `GET /v1/plan-du-jour` le rend à l'agent seul ; le passage est écrit au journal sans donnée personnelle.
- Critères : 7 h 30 de Paris été comme hiver ; un plan par agent et par jour même si le déclencheur passe deux fois ; un autre agent ne lit pas ce plan [R16] ; un plan figé ne change plus ; aucun envoi.

### G03 · Chaque mandat a sa source
- Statut : fait (2026-10-27)
- Qui : Claude · Relecture : forte · Dépend de : S03
- Cahier : M20, point 7 « Mesure », « Règles », « Critères d'acceptation ».
- Objectif : un mandat signé se range seulement avec sa source (site, estimation en ligne, suivi de valeur, recommandation, réseaux, portail, connaissance de l'agent, autre avec un mot), reprise de la fiche quand elle est connue ; une source « liste achetée » ou « ventes publiques » est refusée ; un compte mensuel des mandats par source, sans donnée personnelle.
- Critères : aucun mandat sans source [R38] ; source interdite refusée avec sa règle [R37] ; compte du mois juste sur un jeu inventé ; rien ne s'efface [R17].

### G04 · Suivi de valeur, en mode essai
- Statut : fait (2026-10-27)
- Qui : Claude · Relecture : forte · Dépend de : G01, E06
- Cahier : M20, point 2 « Suivi de valeur ».
- Objectif : un propriétaire qui l'a demandé, avec son accord enregistré pour ce suivi, reçoit à intervalle réglé (6 mois) la fourchette de sa commune, par le planificateur et le contrôle central, en mode essai ; quand il répond qu'il pense à vendre, l'agent est alerté et le plan du jour le porte en tête des rendez-vous à proposer.
- Critères : jamais sans accord en cours pour ce suivi [R03, R36] ; un envoi par période au plus [R05], dans les heures d'envoi [R01] ; seule la fourchette de la commune, jamais le prix d'un bien précis [R31] ; rien ne part en mode essai [R26].

### G05 · Contrôle de la base légale sur 30 jours
- Statut : fait (2026-10-27)
- Qui : Claude · Relecture : normale · Dépend de : G02
- Cahier : M20, « Critères d'acceptation » : « aucun contact sans base légale dans le plan, sur 30 jours ».
- Objectif : un contrôle qui relit les plans figés des 30 derniers jours et vérifie, ligne par ligne, que chaque personne avait une base légale au jour du plan ; un rapport sans donnée personnelle, et une alerte à la direction s'il trouve un écart.
- Critères : un plan avec un contact sans base légale est trouvé, compté et signalé ; un plan sans écart rend zéro ; le rapport ne contient aucune donnée personnelle [R13].

**Application de l'agent, première version, janvier 2027.**

Découpé le 2026-10-27. Ids `A..` pour Application. Cahier : Le produit, « Application de l'agent » ; Architecture technique, application web installable ; Indicateurs, « écran affiché en moins d'une seconde dans 95 % des cas » ; Feuille de route, janvier 2027 : « application et plan du jour utilisés chaque matin pendant une semaine ».
Décidé, lecture prudente : la première version sert la journée de l'agent, rien de plus : plan du jour, contacts chauds, rendez-vous du jour avec leur brief, fiche du client, appel en un geste. Les documents à signer, la dictée, les messages prêts à envoyer et les chiffres viendront avec M06, M08 et M13. L'application est une page web installable servie par le Worker `aimmo-api` lui-même (pas de nouveau service à créer), sans dépendance de construction ; elle ne lit que par l'API sous les droits de l'agent [R16] et ne garde aucune donnée de client sur le téléphone : seul l'écran vide de l'application est mis en cache. L'agent s'y connecte avec sa clé d'API personnelle (H22), saisie une fois et gardée sur son appareil, jamais dans une adresse. Aucun envoi depuis l'application tant que le plan n'a pas mis d'envoi en service. Pas de note ni de classement des agents [R14].

### A01 · Coquille de l'application web installable
- Statut : fait (2026-10-27)
- Qui : Claude · Relecture : forte · Dépend de : S09
- Cahier : Le produit, « Application de l'agent » ; Architecture technique.
- Objectif : le Worker sert `/app/` : page, manifeste, icône et service worker, avec des en-têtes de sécurité stricts (politique de contenu, pas d'appel hors de l'API) ; écran de connexion par clé personnelle, vérifiée par une route `GET /v1/moi` qui ne rend que le rôle et le prénom de l'agent ; déconnexion qui efface la clé de l'appareil.
- Critères : la page et le service worker ne mettent en cache que la coquille, jamais une réponse de l'API ; la clé ne passe jamais dans une adresse ni au journal [R13] ; une clé refusée ne montre rien ; textes en français, sans « mandataire » ni « gratuit » [R07] ; tests sur les en-têtes et le contenu servi.
- Attend : H04 pour la mise en ligne, H22 pour l'usage réel.

### A02 · Ma journée
- Statut : fait (2026-10-27)
- Décidé (2026-10-27) : prénom et brief rendus seulement si l'agent voit encore la fiche et le bien ; brief caché si la fiche a été fusionnée ou défusionnée depuis ; chaque fiche rendue et chaque refus écrits au journal.
- Qui : Claude · Relecture : forte · Dépend de : A01, G02, Q04, V05
- Cahier : Le produit, « sa journée qui appeler, où aller, le brief de chaque rendez-vous » ; M20, plan du jour.
- Objectif : l'écran d'accueil montre le plan du jour (raison et place de chaque ligne), les contacts chauds et les rendez-vous du jour avec leur brief ; une route `GET /v1/rendez-vous/jour` rend les rendez-vous du jour de l'agent et leur brief rangé.
- Critères : seulement les données de l'agent [R16] ; un texte affiché est toujours échappé (aucun code injecté par un message de client) ; écran utilisable sur téléphone ; l'ordre du plan est celui du socle, jamais retrié par l'application [R35].

### A03 · Fiche du client et gestes de l'agent
- Statut : fait (2026-10-27)
- Décidé (2026-10-27) : toute exclusion active ferme l'appel, quel que soit le canal où elle a été notée ; une tâche inconnue est refusée comme celle d'un autre ; aucun code interne n'est affiché.
- Qui : Claude · Relecture : forte · Dépend de : A02
- Cahier : Le produit, « ses clients, biens et dossiers » ; Architecture technique, « appel en un geste depuis l'application ».
- Objectif : depuis une ligne du plan, la fiche du client (projets, sources, accords, derniers messages) ; appel en un geste par le lien téléphone de l'appareil ; « rappel fait » par une route `POST /v1/rappels/<id>/fait` ; aucun envoi de message.
- Critères : une fiche qui n'est pas à l'agent est refusée [R16] ; « rappel fait » garde la ligne [R17] ; une personne exclue ou arrêtée est signalée sur sa fiche et n'a pas de bouton d'appel [R02, R04].

### A04 · Mesure de l'usage du matin
- Statut : fait (2026-10-27)
- Décidé (2026-10-27) : un jour compte quand le plan déjà figé est ouvert avant midi, heure de Paris, lu dans le journal ; les 7 jours comprennent aujourd'hui ; la direction voit par jour un nombre d'agents, sans nom.
- Qui : Claude · Relecture : normale · Dépend de : A02, G02
- Cahier : Feuille de route, janvier 2027 : « application et plan du jour utilisés chaque matin pendant une semaine ».
- Objectif : chaque agent voit, pour lui seul, les jours où il a ouvert son plan avant midi sur les 7 derniers jours ; la direction voit le nombre de jours d'usage du réseau, sans classement des agents [R14].
- Critères : compte juste sur un jeu inventé, à l'heure de Paris ; aucun classement ni note d'agent [R14] ; aucune donnée de client.

**M06 · Mandats et documents, février 2027.**

Découpé le 2026-10-27. Ids `D..` pour Documents. Cahier : M06 Mandats et documents ; Feuille de route, février 2027 : « premier mandat de l'agence généré par AIMMO et numéroté dans le registre de l'agence ».
Décidé, lecture prudente : la première version sert les mandats de vente, leurs avenants et le registre ; les autres documents (location, recherche, délégation, bon de visite, offre, fonds de commerce, contrats d'agent) arriveront avec M08, M09, M14, M15 et M16, sur la même bibliothèque. Tant que Marion Gravelin et l'avocat n'ont pas validé les modèles (H08), la bibliothèque ne porte que des modèles d'essai inventés, marqués « essai », qu'aucun document réel ne peut utiliser. Pendant la preuve à Dijon, le numéro vient du registre de GRAVELIN IMMO (H23) et la signature se fait sur papier ou avec l'outil de l'agence : la signature en ligne AIMMO est construite en mode essai, et ne sert qu'une fois son dossier de preuve validé par l'avocat (H24). L'IA ne rédige aucune clause. Rien n'est envoyé à un client tant que le plan n'a pas mis d'envoi en service.

### D01 · Registre des mandats chaîné
- Statut : fait (2026-10-27)
- Décidé (2026-10-27) : chaque ligne est ancrée au journal (rang et empreinte écrite en lettres) ; un registre dont le contrôle échoue ne reçoit plus de ligne et l'écart est écrit au journal ; une ancre manquée après une panne du journal est reprise à la redemande ; R39 passe en service avec D04 (numéro sur l'exemplaire du mandant).
- Qui : Claude · Relecture : forte · Dépend de : G03
- Cahier : M06, « Registre des mandats » ; critère « une modification du registre après coup est détectée ».
- Objectif : un registre par réseau, en ajout seul : à l'inscription d'un mandat signé, un numéro dans l'ordre chronologique, au format et à partir du prochain numéro réglés pour le réseau ; chaque ligne porte l'empreinte de la précédente ; un contrôle d'intégrité relit toute la chaîne ; une ligne corrigée ne s'efface pas, une ligne d'annulation la suit.
- Critères : deux inscriptions simultanées n'ont jamais le même numéro, sans trou [R39] ; une modification directe d'une ligne en base est détectée par le contrôle [R39] ; aucune ligne effacée [R17] ; seuls l'agent du mandat, la direction et la conformité lisent une ligne [R16].
- Attend : H23 pour le numéro réel de l'agence ; les tests utilisent un registre inventé.

### D02 · Bibliothèque de modèles datés et versionnés
- Statut : fait (2026-10-27)
- Décidé (2026-10-27) : la validation d'un modèle est faite par le rôle conformité ; le modèle en vigueur est la dernière version validée, sinon la dernière d'essai ; un mandat exclusif exige un paragraphe mis en évidence ; le mandant est identifié par prénom et nom ; Codex resté en cours 30 min, fusion sans lui.
- Qui : Claude · Relecture : forte · Dépend de : D01
- Cahier : M06, « Bibliothèque de modèles », règle « le modèle en vigueur à la date de signature est conservé avec le document ».
- Objectif : des modèles par type de document (mandat de vente simple, exclusif, avenant), versionnés, datés, avec la liste de leurs champs et leur état « essai » ou « validé » (validé seulement par une personne désignée, jamais par le code) ; un document généré remplit les champs depuis la base, garde la version et l'empreinte du modèle utilisé ; rendu en HTML imprimable, clause d'exclusivité en évidence.
- Critères : un champ absent laisse le document « incomplet », jamais un texte inventé [R40] ; un modèle « essai » ne peut produire qu'un document d'essai, refusé à la signature réelle ; changer un modèle crée une version, le document garde la sienne ; 5 mandats tests générés identiques à leur modèle, au caractère près.
- Attend : H08 pour les modèles réels.

### D03 · Contrôles avant signature
- Statut : fait (2026-10-27)
- Décidé (2026-10-27) : identité valable un an ; le modèle ne nomme qu'un mandant, un bien à plusieurs propriétaires ne passe pas encore ; un bien sans propriétaire connu ne passe pas ; D04 devra exiger un contrôle réussi sur le document à signer.
- Qui : Claude · Relecture : forte · Dépend de : D02
- Cahier : M06, « Contrôles avant signature » ; règle anti-blanchiment.
- Objectif : avant toute signature, un contrôle écrit : champs obligatoires remplis, honoraires conformes au barème du réseau (réglage) et qui les paie, mandants égaux aux propriétaires du bien, identité de chaque mandant vérifiée (pièce vue, date, par qui, rangée hors de la fiche [R15]) ; le résultat, ligne par ligne, est rendu à l'agent.
- Critères : un document incomplet ou hors barème ne peut pas être signé ; aucun mandat signé sans identification de chaque vendeur [R41] ; le contrôle est écrit au journal sans donnée personnelle [R13].

### D04 · Mandat signé sur papier, numéroté au registre
- Statut : fait (2026-10-27)
- Décidé (2026-10-27) : le document est réservé d'abord, puis mandat (identifiant tiré du document), numéro et exemplaire remplis une fois chacun ; une reprise continue sans rien refaire et réécrit une ligne de journal manquée ; tout mandat de vente porte le champ de numéro.
- Qui : Claude · Relecture : forte · Dépend de : D01, D03
- Cahier : M06, « Papier toujours possible », règle « le numéro du registre figure sur l'exemplaire du mandant » ; critère « un mandat de l'agence généré par AIMMO, numéroté dans le registre de l'agence ».
- Objectif : l'agent enregistre un mandat généré et signé sur papier (date, lieu de signature, scan rangé par sa référence) ; s'il passe les contrôles de D03, il reçoit son numéro au registre et devient un mandat signé (G03, avec sa source [R38]) ; l'exemplaire du mandant est produit avec son numéro.
- Critères : le numéro figure sur l'exemplaire du mandant [R39] ; un mandat qui échoue aux contrôles n'est pas numéroté ; un même document ne reçoit jamais deux numéros.
- Attend : H23 pour l'usage réel.

### D05 · Rétractation et diffusion bloquée
- Statut : fait (2026-10-27)
- Décidé (2026-10-27) : délai compté à partir du lendemain de la signature en jours de Paris, prolongé au jour ouvrable suivant ; fin du mandat au même quantième N mois plus tard, ramenée au dernier jour du mois ; un mandat sans durée connue ne se diffuse pas ; rétractation et début anticipé par l'agent du mandat ou la direction ; le formulaire de rétractation fait partie du modèle validé (H08).
- Qui : Claude · Relecture : forte · Dépend de : D04
- Cahier : M06, « Rétractation », règle « aucune annonce ni diffusion sans mandat signé et numéroté » ; critère « la diffusion reste bloquée pendant le délai de rétractation ».
- Objectif : selon le lieu de signature (hors agence ou à distance), un délai de 14 jours calculé à l'heure de Paris, avec le formulaire de rétractation joint ; une seule fonction dit si un bien peut être diffusé, utilisée par tout ce qui publie : mandat signé, numéroté, en cours, et hors délai de rétractation sauf demande écrite du vendeur rangée avec sa preuve ; une rétractation reçue arrête le mandat.
- Critères : aucune diffusion sans mandat signé et numéroté [R42] ; diffusion refusée pendant le délai, permise le lendemain de sa fin, permise plus tôt avec la demande écrite ; une rétractation arrête la diffusion [R42].

### D06 · Échéances des mandats
- Statut : fait (2026-10-27)
- Décidé (2026-10-27) : tâches rangées à 6 h, 30 jours avant la fin du mandat et 15 jours avant la fin de la période exclusive ; pas de période exclusive pour un mandat plus court ; un mandat rétracté ou annulé ne montre plus ses tâches, gardées.
- Qui : Claude · Relecture : normale · Dépend de : D04
- Cahier : M06, « Échéances ».
- Objectif : chaque jour, une tâche pour l'agent avant la fin d'un mandat et avant la fin de la période de 3 mois d'un mandat exclusif, avec le renouvellement proposé à temps (délais en réglage) ; rien n'est envoyé au vendeur.
- Critères : une seule tâche par échéance [R18] ; calcul juste à l'heure de Paris sur un jeu inventé ; aucun envoi.

### D07 · Avenant au mandat
- Statut : fait (2026-10-27)
- Décidé (2026-10-27) : un avenant change le prix ou la durée, par ses seuls champs, écrits sur le document signé ; pas d'avenant sur un mandat échu ; il ne touche pas au prix affiché du bien (M07) ; la diffusion et les échéances suivent la durée en vigueur.
- Qui : Claude · Relecture : normale · Dépend de : D04
- Cahier : M06, « Avenant au mandat ».
- Objectif : un avenant généré depuis le modèle, lié au mandat par sa référence et son numéro, pour un changement de prix, de durée ou de conditions ; mêmes contrôles et même enregistrement que le mandat ; le mandat garde l'historique de ses avenants.
- Critères : l'avenant porte la référence et le numéro du mandat ; le prix du mandat change seulement quand l'avenant est signé ; rien n'est effacé [R17].

### D08 · Signature en ligne AIMMO, en mode essai
- Statut : fait (2026-10-27)
- Décidé (2026-10-27) : le code et l'exemplaire passent par le contrôle central, avec l'accord du signataire (finalité `signature_en_ligne`), rangés dans la boîte d'essai ; en essai le code y est lisible pour tester, et devra être scellé avant tout usage réel (H05, H24) ; essais faux comptés dans la base ; Codex n'a pas relu la dernière version en 50 min, fusion sans lui.
- Qui : Claude · Relecture : forte · Dépend de : D03
- Cahier : M06, « Signature électronique AIMMO ».
- Objectif : code à usage unique par mail (rangé dans la boîte d'essai, jamais envoyé), signature manuscrite à l'écran possible, empreinte du document, horodatage, dossier de preuve ; chaque signataire reçoit son exemplaire (dans la boîte d'essai).
- Critères : un code ne sert qu'une fois et expire ; un document modifié après signature est détecté par son empreinte ; tant que H24 n'est pas fait, une signature en ligne ne rend jamais un mandat signé réel.
- Attend : H24, H05.

### D09 · Mesure : mandat signé en moins de 10 minutes
- Statut : fait (2026-10-27)
- Décidé (2026-10-27) : la chronologie se lit dans la base (avis validé, document, contrôle, numéro), sans rien ajouter ; « moins de 10 minutes » strictement ; la mesure réelle attend H08 et H23.
- Qui : Claude · Relecture : normale · Dépend de : D04, E04
- Cahier : M06, critère « un mandat test signé en moins de 10 minutes à partir de l'estimation, et numéroté au registre ».
- Objectif : un parcours de test, de l'avis de valeur au mandat numéroté, sur une horloge simulée et des données inventées, avec le temps de chaque étape ; la marche à suivre pour le mesurer avec Shawez sur un vrai rendez-vous.
- Critères : le parcours de test passe ; le temps passé par le système est mesuré et sous la cible ; la marche à suivre est écrite dans `docs/MESURE.md`.

**M08 · Acquéreurs et visites, avril 2027.**

Découpé le 2026-10-27 par la voie 1. Ids `T..` pour Trouver l'acquéreur. Cahier : M08 Acquéreurs et visites ; Feuille de route, avril 2027 : « sur 10 biens tests, au moins 8 des 10 premiers acquéreurs proposés respectent tous les critères obligatoires ».
Décidé, lecture prudente : M08 se construit en mode essai, sans aucun envoi réel : alertes, comptes rendus et points de la semaine passent par le contrôle central et sont rangés dans la boîte d'essai ; le lien WhatsApp de l'agent est préparé, jamais ouvert pour lui. L'IA (alertes, compte rendu) est derrière une interface, fausse IA dans les tests, vraie IA avec H13 ; elle ne reçoit ni nom, ni coordonnée, ni adresse exacte [R15]. Le rapprochement lit la table `properties` du socle et un bien proposable est un bien que `canDiffuse` de D05 autorise [R42] ; la fiche complète de M07 (P01) l'enrichira quand elle sera fusionnée, sans que M08 touche aux fichiers de la voie 2 (`packages/core/src/annonces/`). Les vues par canal du point de la semaine viennent de P08 : tant qu'il n'est pas fusionné, elles sont « non communiquées » [R53]. Le partage des honoraires entre agents (fichier commun) et le rendement pour un investisseur (M17) viendront avec ces modules. Les migrations de M08 prennent les numéros à partir de `0101`, pour ne jamais croiser celles de la voie 2. Le code de M08 vit dans `packages/core/src/acquereurs/` et `packages/core/src/visites/`.

### T01 · Fiche acquéreur
- Statut : fait (2026-10-27)
- Décidé (2026-10-27) : un champ écrit ou vidé par l'agent n'est plus changé par un message ; un message plus ancien ne remplace pas ce qu'un plus récent a dit ; « studio » est rangé en appartement ; la conformité lit sans écrire ; R50 passe en service avec T02.
- Reste : relecture de Codex restée en cours 30 min, fusion sans elle (#66).
- Qui : Claude · Relecture : forte · Dépend de : Q01
- Cahier : M08, « Fiche acquéreur » ; règle « aucun critère discriminant dans la recherche ».
- Objectif : pour un projet d'achat, une fiche de recherche versionnée (rien ne s'efface) : types de bien, communes (liste fermée du réglage), surface et pièces minimales, budget maximal, contraintes dans une liste fermée (extérieur, stationnement, ascenseur, plain-pied, etc.), financement déclaré, urgence ; mise à jour depuis la qualification de Q01, seulement avec ce que le message dit, chaque champ avec sa source (message, agent).
- Critères : aucun champ hors liste fermée, aucun critère discriminant [R50] ; une mise à jour crée une version, l'ancienne reste lisible [R17] ; un champ que le message ne dit pas n'est jamais rempli [R10] ; lecture et écriture sous R16, refus au journal ; rien de personnel au journal [R13].
- Attend : rien.

### T02 · Rapprochement des acquéreurs, par le code
- Statut : fait (2026-10-27)
- Décidé (2026-10-27) : tolérances par défaut budget +5 %, surface −10 %, pièces 0 ; le type « logement » du socle répond à maison et appartement ; une valeur du bien inconnue ne remplit pas son critère ; une recherche sans critère sur le bien ne compte pas ; acquéreur actif : projet non clos et recherche modifiée depuis moins de 180 jours ; une ligne par personne, son meilleur projet ; R50 et R51 en service.
- Qui : Claude · Relecture : forte · Dépend de : T01, D05
- Cahier : M08, « Rapprochement », « Fichier commun » ; Feuille de route, avril 2027.
- Objectif : pour un bien diffusable [R42], la liste classée des acquéreurs du réseau entier (fichier commun) : critères obligatoires (type, commune, budget, surface, pièces) avec les tolérances écrites en réglage, puis classement par règles écrites (écart aux critères, urgence déclarée, fraîcheur du projet), jamais par le financement ni la solvabilité [R14], chaque ligne avec ses raisons ; jamais une personne exclue ou qui a demandé l'arrêt.
- Jamais vu : **carte de la demande**. Pour chaque bien, l'agent voit combien d'acquéreurs actifs du réseau le cherchent, et quel critère seul écarte le plus d'acquéreurs proches (« 12 acquéreurs écartés seulement par la surface, 7 seulement par la commune »), calculé par le code, sans aucun nom. Aucun réseau ni logiciel ne montre ainsi à l'agent la demande réelle autour d'un bien, critère par critère.
- Critères : sur 10 biens tests et un fichier inventé, au moins 8 des 10 premiers acquéreurs proposés respectent tous les critères obligatoires [R51] ; chaque proposition porte ses raisons ; aucun critère discriminant [R50] ; aucun classement par financement [R14] ; aucun acquéreur exclu ou arrêté [R02, R04] ; la carte de la demande est juste sur le jeu inventé et sans donnée personnelle ; lecture sous R16.
- Attend : rien.

### T03 · Alertes aux acquéreurs, en mode essai
- Statut : fait (2026-10-27)
- Décidé (2026-10-27) : seuls les acquéreurs qui remplissent tous les critères reçoivent une alerte ; canal pris dans l'ordre mail, Instagram, Facebook, SMS parmi ceux accordés, le suivant essayé après un refus de canal ; refus pour l'heure ou la diffusion repris, les autres définitifs ; l'accord des alertes est exigé et revérifié après la rédaction sur tout canal, et la diffusion juste avant l'envoi (deux options du contrôle central) ; page de désinscription publique hors de `/v1`, GET sans effet ; sans `ALERT_UNSUBSCRIBE_BASE`, aucune alerte ; R49 en service.
- Qui : Claude · Relecture : forte · Dépend de : T02
- Cahier : M08, « Alertes » et règles ; critère « aucun doublon d'alerte sur 30 jours ».
- Objectif : quand un bien devient diffusable, une alerte aux acquéreurs rapprochés qui l'ont demandée : message personnalisé rédigé par l'IA derrière une interface à partir des seules données du bien et des critères (fausse IA dans les tests, texte de secours du code si elle est en panne), mail ou message selon l'accord, passé par le contrôle central et rangé dans la boîte d'essai, avec un lien de désinscription. WhatsApp par le téléphone de l'agent : T09.
- Critères : aucune alerte sans accord en cours pour les alertes, et un lien de désinscription dans chacune [R49] ; jamais deux fois le même bien à la même personne, tous canaux confondus, WhatsApp de l'agent compris, même avec deux envois simultanés : aucun doublon sur 30 jours sur horloge simulée [R05] ; exclusions, arrêts et horaires respectés [R01, R02, R04] ; « agent immobilier » et « offert » [R07] ; l'IA ne reçoit ni nom, ni coordonnée, ni adresse exacte [R15] ; un texte avec un chiffre absent du bien est refusé ; rien ne part réellement.
- Attend : H05 et H06 pour l'envoi réel, plus tard.

### T09 · Alerte WhatsApp en un geste, par le téléphone de l'agent
- Statut : fait (2026-10-27)
- Décidé (2026-10-27) : option `byAgent` du contrôle central, réservée au port `AgentWhatsAppLink` qui fabrique le lien en mémoire ; message rangé, écrit par l'agent, dès la préparation, pour que le bien ne soit jamais proposé deux fois ; texte du code, sans IA ; la direction prépare au nom de l'agent qui suit la personne ; l'écran (T08) ouvre le lien aussitôt et ne le garde pas.
- Qui : Claude · Relecture : forte · Dépend de : T03
- Cahier : M08, « Alertes » : « un message WhatsApp à l'initiative de l'agent part de son téléphone, en un geste, seulement après le contrôle central : exclusions, accord, horaires. L'envoi est enregistré. »
- Objectif : pour un acquéreur rapproché, l'agent demande un lien WhatsApp pré-rempli ; le contrôle central décide (exclusions, arrêt, accord, horaires, jamais deux fois le même bien), sans la fenêtre de Meta qui ne vaut que pour les envois automatiques, puis prépare le lien sans jamais l'ouvrir ; l'envoi est enregistré, écrit par l'agent, quand il confirme.
- Critères : aucun lien sans accord en cours pour les alertes sur WhatsApp [R49] ; jamais un bien déjà proposé, ni deux liens du même bien [R05] ; exclusions, arrêt et horaires [R01, R02, R04] ; seuls l'agent du client et la direction [R16] ; le message est enregistré comme écrit par l'agent, une seule fois même confirmé deux fois [R18] ; rien ne part du serveur.
- Attend : rien.

### T04 · Visite et bon de visite
- Statut : fait (2026-10-27)
- Décidé (2026-10-27) : la bibliothèque de D02 n'admet que les types de mandat (contrainte de sa table) ; le bon de visite a ses modèles à part, aux mêmes règles (direction crée, conformité valide) ; signature papier seulement, la signature en ligne du bon avec H24 ; une visite décalée reprend sa visite si le bien est encore diffusable, avec un bon neuf ; un bon manquant après une panne est refait à la lecture.
- Reste : relecture de Codex de la dernière correction (un P2) restée en cours 20 min, fusion sans elle (#76).
- Qui : Claude · Relecture : normale · Dépend de : T01, V02, D02
- Cahier : M08, « Visites » ; M06, bibliothèque de modèles.
- Objectif : une visite est un rendez-vous de V02 relié à un bien et à un projet d'achat ; le bon de visite est généré depuis la bibliothèque de D02 (modèle d'essai tant que H08 n'est pas fait), signé sur papier ou en ligne en essai (D08) ; le rappel de la veille vient de V04.
- Critères : une visite sans bien diffusable est refusée [R42] ; le bon de visite porte le bien, la date et le visiteur, jamais l'adresse exacte dans la confirmation au visiteur [R19] ; un champ manquant le laisse incomplet [R40] ; une visite annulée garde son bon, rien n'est effacé [R17].
- Attend : H08 pour le modèle réel.

### T05 · Visite sécurisée
- Statut : fait (2026-10-27)
- Décidé (2026-10-27) : identité confirmée par le nom du visiteur, égal à celui de sa fiche (aucune pièce), téléphone par un code SMS de 30 minutes, 5 essais ; la réservation d'une visite dit « réservée », jamais « confirmée » ; la tournée partagée est celle de V07 ; l'alerte retient la visite en cours, sinon la prochaine dans l'heure ; la direction est prévenue par une interface, en essai une ligne au journal ; R54 en service.
- Reste : relecture de Codex de la dernière correction restée en cours plus de 25 min, fusion sans elle (#80).
- Qui : Claude · Relecture : forte · Dépend de : T04
- Cahier : M08, « Visite sécurisée ».
- Objectif : avant la visite, le visiteur confirme son identité et son téléphone (code à usage unique par le contrôle central, rangé dans la boîte d'essai) ; l'agent peut partager sa tournée du jour avec un proche par le message de V07, sans nom de client ni adresse exacte ; une alerte en un geste range l'heure et le lieu de la visite en cours et prévient la direction (boîte d'essai).
- Critères : aucune visite confirmée sans identité et téléphone confirmés [R54] ; un code ne sert qu'une fois et expire ; la tournée partagée est celle de V07, un message aux heures et communes seulement, sans nom de client ni adresse [R09, R15] (décidé le 2026-10-27 : pas de lien, rien à faire expirer) ; l'alerte est enregistrée même si l'envoi échoue, et réessayée sans doublon ; rien ne part réellement.
- Attend : H05 pour l'envoi réel.

### T06 · Compte rendu de visite dicté
- Statut : fait (2026-10-27)
- Décidé (2026-10-27) : la recherche de l'acquéreur ne change pas sur un avis, le compte rendu reste rattaché à son projet ; vendeur = mandant du dernier mandat du bien, accord `suivi_vente` exigé ; relance de l'acquéreur à 48 h ; l'IA reçoit la dictée sans mail, adresse, coordonnée connue, compte ni nom (accents ignorés, mot par mot, particules exceptées) ; une offre niée dans la dictée est refusée ; envoi repris par la tâche `visites.comptes_rendus` ; R52 en service.
- Qui : Claude · Relecture : forte · Dépend de : T04
- Cahier : M08, « Compte rendu de visite » ; critère « 5 comptes rendus de visite envoyés au vendeur sous 24 heures ».
- Objectif : l'agent dicte une phrase ou 30 secondes (le texte vient de la dictée du téléphone) ; l'IA, derrière une interface, en tire le compte rendu (avis, points forts, réserves, intérêt, prêt à faire une offre) ; l'agent le valide en un geste ; le vendeur le reçoit sans le nom de l'acquéreur (boîte d'essai) ; la fiche acquéreur est mise à jour, une relance est programmée, et une tâche « préparer l'offre » est créée si l'acheteur se dit prêt.
- Critères : rien ne part au vendeur sans validation de l'agent, et jamais avec le nom ou une coordonnée de l'acquéreur [R52] ; le compte rendu ne porte que ce que la dictée dit, un fait absent n'est pas inventé ; 5 comptes rendus de test validés sont dans la boîte d'essai en moins de 24 heures sur horloge simulée ; une seule relance par visite [R18] ; IA en panne : la dictée brute est gardée et l'agent peut écrire lui-même.
- Attend : H13 pour la vraie IA.

### T07 · Point de la semaine au vendeur
- Statut : fait (2026-10-27)
- Décidé (2026-10-27) : préparé le lundi à 8 h pour chaque mandat en cours (délai de rétractation compris), validé par l'agent avec ses prochaines actions ; une action ne porte ni chiffre, ni prix, ni nom ou coordonnée d'une personne venue pour le bien ; le texte entier est contrôlé avant d'être figé ; au plus huit avis ; vues « non communiquées » sans relevé ; R53 en service.
- Reste : relecture de Codex de la dernière correction (P2) restée en cours plus de 20 min, fusion sans elle (#87).
- Qui : Claude · Relecture : forte · Dépend de : T06, B02
- Cahier : M08, « Point de la semaine au vendeur » et règles ; critère « 5 vendeurs reçoivent leur point deux lundis de suite ».
- Objectif : chaque lundi, par le planificateur, un point par mandat en cours : vues (P08 quand il sera fusionné), contacts reçus pour le bien (C03), visites et avis des visiteurs (T06), prochaines actions de l'agent ; préparé pour l'agent, qui le valide ; passé par le contrôle central et rangé dans la boîte d'essai.
- Critères : chaque chiffre est lu dans la base, une donnée absente est écrite « non communiquée » [R53] ; aucune mention de baisse de prix, refusée par une liste fermée de tournures [R53] ; aucun nom d'acquéreur [R52] ; un seul point par mandat et par lundi [R18] ; sur horloge simulée, 5 vendeurs tests reçoivent leur point deux lundis de suite, à l'heure de Paris ; rien ne part réellement.
- Attend : rien.

### T08 · Routes et écrans « Acquéreurs » et « Visite » de l'application de l'agent
- Statut : fait (2026-10-27)
- Décidé (2026-10-27) : la dictée passe par le micro du clavier du téléphone, sans reconnaissance vocale dans le navigateur (elle enverrait la dictée à un service extérieur) ; le lien WhatsApp ne sert qu'une fois et expire au bout de deux minutes ; en mode essai l'écran dit que la direction n'est pas prévenue par message et donne le 112. Reste à faire, hors T08 : rattacher une visite réservée en ligne (V08) à la recherche d'un acquéreur, pour lui ouvrir un dossier de visite.
- Qui : Claude · Relecture : forte · Dépend de : T03, T05, T06, T07
- Cahier : M08 ; Organisation, exigence de design (protocole, section 9).
- Objectif : les routes `/v1/acquereurs` (fiche, rapprochement, carte de la demande, alertes), `/v1/visites` (visite, bon, confirmation, alerte, compte rendu) et `/v1/points` ; dans l'application de l'agent, l'écran d'un bien avec ses acquéreurs et sa carte de la demande, et l'écran de visite avec le bouton de dictée, la validation en un geste et l'alerte en un geste.
- Critères : chaque route sous R16, refus au journal ; un parcours de test complet, du bien diffusable à l'alerte, la visite, le compte rendu et le point du lundi ; écrans accessibles, beaux sur téléphone d'abord, sans texte générique.
- Attend : rien.

**M07 · Commercialiser, mars 2027.**

Voie : 2

Découpé le 2026-10-27 par la voie 2. Ids `P..` pour Publier. Cahier : M07 Commercialiser ; Conformité, « Publier les annonces » ; Feuille de route, mars 2027 : « 10 annonces passent la liste de contrôle des mentions ».
Décidé, lecture prudente : tout M07 se construit en mode essai, sans aucune publication réelle : les canaux (site, réseaux sociaux, fiche Google, portails) sont derrière une interface, avec un faux canal dans les tests, et ce qui « part » est rangé dans la boîte d'essai. Toute publication passe par la seule porte `canDiffuse` de D05 [R42], puis par la liste de contrôle des mentions [R43]. Le prix publié vient du mandat en vigueur, avenants compris, jamais d'une saisie [R44]. L'IA rédige l'annonce derrière une interface (fausse IA dans les tests, vraie IA avec H13), à partir des seules données du bien ; les mentions obligatoires sont calculées et placées par le code, jamais par l'IA ; l'agent valide. Les pages des biens de `shawez-immo` restent en place, intouchées, jusqu'à une tâche de bascule à part. Pendant la preuve à Dijon, les portails sont servis par le logiciel de l'agence ; l'export AIMMO est construit en essai et attend H10. Le numéro de carte professionnelle est un réglage du réseau (H09). Le montage de la vidéo vient avec M19 Studio ; M07 porte le plan de tournage et le contrôle « sans adresse visible ». Les biens d'exception (dossier en anglais, visites privées) viendront après la preuve. Les fichiers du socle ne sont pas touchés par la voie 2 : le code de M07 vit dans `packages/core/src/annonces/`, ses routes dans `packages/api/src/annonces.ts`, branchées par une seule ligne quand la voie 1 n'a pas `app.ts` en cours.

### P01 · Fiche du bien complète
- Statut : fait (2026-10-27)
- Décidé (2026-10-27) : aucun texte libre dans la fiche ; références de photos données par le stockage (`biens/<id du bien>/<identifiant>.<ext>`) ; une vidéo ne porte pas d'aménagement virtuel
- Qui : Claude · Relecture : forte · Dépend de : D05
- Cahier : M07, « Fiche du bien complète » ; Conformité, « Publier les annonces » (énergie, copropriété, risques).
- Objectif : la fiche de commercialisation d'un bien, versionnée (une modification crée une version, rien ne s'efface) : caractéristiques (surface, pièces, chambres, étage, année, chauffage, extérieurs), diagnostic énergétique (classes énergie et climat de A à G, dépenses annuelles minimale et maximale, année de référence des prix, date du diagnostic), copropriété (lot ou non, nombre de lots, charges annuelles moyennes, procédure en cours), risques (zone concernée ou non), photos et vidéo par leur référence de stockage, avec leur état « retouchée » ou « aménagement virtuel ». L'adresse exacte reste hors de la fiche publique [R19].
- Critères : chaque champ est contrôlé (classes dans A à G, montants positifs, dépense minimale au plus égale à la maximale, date de diagnostic non future) ; une modification crée une version, l'ancienne reste lisible [R17] ; seuls l'agent du bien et la direction écrivent, et chaque refus va au journal [R16] ; aucune donnée personnelle au journal [R13].
- Attend : rien.

### P02 · Mentions obligatoires et liste de contrôle
- Statut : fait (2026-10-27)
- Décidé (2026-10-27) : prix du mandat = prix hors honoraires à la charge de l'acquéreur ; pourcentage du prix hors honoraires, au centième, le demi vers le haut ; seul un mandat en vigueur (diffusable ou en délai de rétractation) donne un prix ; terrain sans DPE ; commerces et entreprises avec M16 ; carte professionnelle réglée par la direction
- Qui : Claude · Relecture : forte · Dépend de : P01
- Cahier : Conformité, « Publier les annonces » ; M07, règles ; critère « 10 annonces tests passent la liste de contrôle des mentions ».
- Objectif : une fonction du code calcule et place les mentions obligatoires d'une annonce à partir du bien et du mandat en vigueur : prix honoraires inclus en plus grand, prix hors honoraires et honoraires TTC en pourcentage quand l'acquéreur les paie ; classes énergie et climat, logement très énergivore (F ou G), dépenses annuelles avec l'année de référence ; copropriété (lots, charges, procédure) ; renvoi vers Géorisques si le bien est en zone concernée ; numéro de carte professionnelle (réglage du réseau). Une liste de contrôle rend chaque mention « présente » ou « manquante » avec sa raison.
- Critères : 10 annonces tests passent la liste de contrôle, au caractère près [R43] ; un champ manquant bloque, avec la mention manquante nommée [R43] ; sans diagnostic énergétique, rien ne passe [R45] ; le prix vient du mandat en vigueur, avenant de prix compris, jamais d'une saisie [R44] ; pourcentage d'honoraires calculé juste et arrondi par une règle écrite.
- Attend : H09 pour le vrai numéro de carte ; les tests utilisent un numéro inventé.

### P03 · Annonce rédigée par l'IA, sourcée, validée par l'agent
- Statut : fait (2026-10-27)
- Décidé (2026-10-27) : un nombre doit venir du champ que son unité désigne, sans unité seulement l'année, le code postal ou le total d'étages après « sur » ; le prix n'est jamais dans le texte ; toute voie nommée est refusée ; critères discriminants et équipements sans champ en listes fermées, lues sans accents, au pluriel et au féminin ; texte de l'IA refusé remplacé par le texte de secours du code ; Codex sans relecture au bout de 15 min, fusion sans lui
- Qui : Claude · Relecture : forte · Dépend de : P02
- Cahier : M07, « Annonce » et « L'IA et l'humain » ; Conformité, non-discrimination.
- Objectif : l'IA, derrière une interface (fausse IA dans les tests), propose un titre et un texte à partir des seules données de la fiche ; le code vérifie le texte, y ajoute les mentions de P02, et l'agent du bien le valide ou le corrige ; seule une version validée peut être publiée.
- Jamais vu : **annonce sourcée**. Chaque chiffre et chaque fait du texte est relié au champ de la fiche dont il vient, montré à l'agent phrase par phrase ; un nombre, une surface, une année ou un équipement sans source dans la fiche rend le texte refusé, avant même la validation. Aucun réseau ni outil d'IA grand public ne prouve ainsi qu'une annonce n'invente rien.
- Critères : un texte qui cite un nombre absent de la fiche est refusé, la phrase en cause nommée [R47] ; un texte avec une adresse exacte (numéro et voie) est refusé [R46] ; un texte avec un critère discriminant (origine, religion, situation de famille, handicap, nationalité, etc., liste fermée) est refusé [R46] ; « gratuit », « mandataire » ou une mention de l'IA sont refusés ; rien n'est publiable sans validation de l'agent du bien [R47] ; l'IA ne reçoit ni nom, ni coordonnée, ni adresse exacte [R15] ; une IA en panne laisse un texte de secours fait par le code depuis la fiche.
- Attend : H13 pour la vraie IA.

### P04 · Publication partout, au même prix, en mode essai
- Statut : fait (2026-10-27)
- Décidé (2026-10-27) : une version publiée unique pour tous les canaux ; un passage à la fois par bien, par un bail de 5 minutes qui protège aussi l'écriture d'une version ; contrat des canaux : jamais une version plus ancienne que la dernière appliquée ; un bien vendu reste montré « vendu » tant que son mandat le permet ; Codex : 2 P0 corrigés, sa relecture de la dernière correction restée en cours 15 min, fusion sans elle
- Qui : Claude · Relecture : forte · Dépend de : P03
- Cahier : M07, « Diffusion » ; critères « publié partout en moins d'une heure, au même prix » et « changement de prix répercuté partout en moins de 15 minutes ».
- Objectif : publier une annonce validée vers chaque canal (site, réseaux sociaux, fiche Google, portails) derrière une interface, en mode essai ; une version publiée unique, la même partout ; un changement de prix (avenant signé) ou d'état (sous offre, vendu, mandat arrêté) crée une nouvelle version poussée à chaque canal par le planificateur ; un retrait quand `canDiffuse` dit non.
- Critères : aucune publication sans `canDiffuse` [R42], sans liste de contrôle complète [R43] ni sans validation [R47] ; même prix sur tous les canaux [R44] ; sur horloge simulée, publié partout en moins d'une heure, prix répercuté en moins de 15 minutes ; un mandat rétracté ou échu retire l'annonce partout au passage suivant ; un canal en panne est réessayé sans doublon ; rien ne part réellement.
- Attend : rien pour l'essai ; les canaux réels plus tard (H06, H07, H10).

### P05 · Page du bien et fiche PDF à la marque de l'agent
- Statut : fait (2026-10-27)
- Décidé (2026-10-27) : fiche imprimable en HTML de deux pages A4 fixes (page 1 : prix, mentions, 4 photos ; page 2 : texte et agent), vérifiée sous Chromium ; coordonnées professionnelles de l'agent réglées par lui ou la direction, jamais pour un agent parti ; un agent parti n'est plus montré
- Qui : Claude · Relecture : normale · Dépend de : P04
- Cahier : M07, « Page du bien » et « fiche PDF » ; Organisation, exigence de design (protocole, section 9).
- Objectif : depuis la version publiée, une page HTML du bien et une fiche imprimable de deux pages au nom et aux coordonnées professionnelles de l'agent, avec prix, mentions et état (en vente, sous offre, vendu) mis à jour d'eux-mêmes ; rapide, accessible, belle sur téléphone d'abord, suivant le système de design d'AIMMO.
- Critères : aucune adresse exacte ni nom du vendeur dans la page ou la fiche [R46] ; mentions de P02 présentes et prix inclus en plus grand [R43] ; état et prix suivent la dernière version publiée ; tout texte échappé ; fiche de deux pages au plus à l'impression.
- Attend : rien.

### P06 · Photos et vidéo sans tromper ni montrer l'adresse
- Statut : fait (2026-10-27)
- Décidé (2026-10-27) : la version publiée porte ses médias, la mention « Aménagement virtuel » à poser sur l'image ; une vidéo ne part qu'après un dernier contrôle réussi de ses sous-titres et de sa légende, lus un par un, à la suite et entiers ; un point d'abréviation ne coupe plus une phrase ; voies abrégées reconnues
- Qui : Claude · Relecture : normale · Dépend de : P01
- Cahier : M07, « Vidéo du bien » et règle de l'aménagement virtuel ; Conformité, « Photos et vidéos ».
- Objectif : une photo marquée « aménagement virtuel » porte la mention sur l'image publiée ; un plan de tournage du bien tiré de sa fiche (pièces, extérieurs, atouts) ; un contrôle des sous-titres et du texte de la vidéo qui refuse une adresse exacte.
- Critères : aucune image d'aménagement virtuel publiée sans sa mention [R48] ; une photo retouchée au-delà de la lumière et du cadrage est refusée ; des sous-titres avec une adresse exacte sont refusés [R46] ; plan de tournage sans rien d'inventé.
- Attend : rien.

### P07 · Export au format des portails, en mode essai
- Statut : fait (2026-10-27)
- Décidé (2026-10-27) : format d'essai XML `aimmo-essai-1` ; seuls les biens en vente ou sous offre sont dans le flux ; Codex resté en cours plus de 25 min, fusion sans lui
- Qui : Claude · Relecture : normale · Dépend de : P04
- Cahier : M07, « Diffusion », « export au format de chaque portail ».
- Objectif : un flux d'export par portail derrière une interface, rempli depuis la version publiée, avec un format d'essai décrit dans `docs/PORTAILS.md` ; les formats réels s'ajoutent avec H10.
- Critères : le flux porte le prix publié et les mentions [R43, R44] ; jamais d'adresse exacte [R46] ; un bien retiré sort du flux au passage suivant ; flux identique pour une même version.
- Attend : H10 pour les vrais portails.

### P08 · Mesure par bien : vues, contacts, visites
- Statut : fait (2026-10-27)
- Décidé (2026-10-27) : un relevé de vues par bien, canal et jour ; un contact compte à l'heure de son message, une fois par personne, fusions comprises ; visites faites et prévues
- Qui : Claude · Relecture : normale · Dépend de : P04
- Cahier : M07, « Mesure ».
- Objectif : par bien et par semaine, les vues par canal, les contacts reçus pour ce bien (C03) et les visites (M05), lus pour le point hebdomadaire au vendeur que fera M08.
- Critères : compte juste sur un jeu inventé, à l'heure de Paris ; aucune donnée personnelle dans la mesure ; seuls l'agent du bien et la direction la lisent [R16].
- Attend : rien.

### P09 · Routes de M07 et passage de publication
- Statut : fait (2026-10-27)
- Décidé (2026-10-27) : routes et passage dans `packages/api/src/annonces.ts`, sans toucher au socle ; branchement, page publique et écran confiés à la voie 1 (P10)
- Qui : Claude, voie 2 · Relecture : forte · Dépend de : P04, P05
- Cahier : M07 ; Feuille de route, mars 2027 ; critère « mis en vente moins d'une heure après la fin du délai de rétractation ».
- Objectif : les routes `/v1/annonces` (fiche, liste de contrôle, brouillon, correction, validation, état et passage de publication, semaine, contrôle des vidéos, plan de tournage) dans `packages/api/src/annonces.ts`, de la même forme que celles de `app.ts`, et `syncAnnonces`, le passage de publication d'un réseau, sans toucher aux fichiers du socle.
- Critères : chaque route sous R16, chaque refus une ligne au journal ; un parcours de test complet par les routes, de la fin du délai de rétractation à la publication partout, en moins d'une heure sur horloge simulée.
- Attend : rien.

### P10 · Branchement de M07 dans le socle, page publique et écran « Mettre en vente »
- Statut : fait (2026-10-27)
- Décidé (2026-10-27) : M07 exporté en espace de noms `annonces` (noms déjà pris dans le socle) ; un seul cron toutes les 15 minutes, créneaux du passage en UTC ; vitrine `/biens/:id` sans index tant que le chantier est en essai ; photos depuis un stockage R2 `MEDIA` facultatif (H25).
- Qui : Claude, voie 1 (fichiers du socle : `packages/core/src/index.ts`, `packages/api/src/app.ts`, `packages/api/src/worker.ts`, application de l'agent) · Relecture : forte · Dépend de : P09
- Cahier : M07 ; Organisation, exigence de design (protocole, section 9).
- Objectif : exporter `annonces` depuis `@aimmo/core` et remplacer l'import relatif de `packages/api/src/annonces.ts` ; ajouter `annonceRoutes()` aux routes de `app.ts` ; lancer `syncAnnonces` toutes les 15 minutes depuis le déclencheur du Worker ; servir la page publique du bien et sa fiche imprimable (`PageBien`) et les médias ; dans l'application de l'agent, un écran « Mettre en vente » qui montre la liste de contrôle, l'annonce sourcée phrase par phrase (chaque nombre relié à son champ) et le bouton de validation.
- Critères : les routes répondent derrière la clé d'API [R16] ; le passage tourne toutes les 15 minutes, une seule fois par créneau ; la page publique ne montre qu'une version publiée, sans adresse [R46] ; écran accessible, sans texte générique, beau sur téléphone d'abord.
- Attend : rien.

### P11 · Passage de publication : une panne d'un réseau n'arrête pas les autres
- Statut : fait (2026-10-27)
- Qui : Claude, voie 1 (`packages/api/src/vitrine.ts`) · Relecture : normale · Dépend de : P10
- Cahier : M07.
- Objectif : dans `runListingSync`, chaque réseau passe dans son propre essai : une panne va au journal, sans donnée, le réseau suivant passe, et le créneau est marqué en erreur à la fin (comme `offres.quotidien`, O09).
- Critères : un test avec deux réseaux, le premier en panne : le second publie, une ligne `api.erreur` au journal, créneau en erreur.
- Attend : rien.

**M09 · Offres, mai 2027.**

Voie : 2

Découpé le 2026-10-27 par la voie 2. Ids `O..` pour Offre. Cahier : M09 Offres ; Feuille de route, mai 2027 : « une offre test suivie de bout en bout » ; règles R14 (aucune évaluation de solvabilité) et R15 (aucune pièce d'identité hors du coffre).
Décidé, lecture prudente : le système enregistre, contrôle, transmet et suit les délais ; il n'accepte, ne refuse, ne contre-propose ni ne négocie jamais : seule une réponse du vendeur, rapportée par l'agent avec sa preuve, change l'état d'une offre [R57]. La première version range l'offre comme un enregistrement structuré (montant, conditions suspensives, validité, financement déclaré) avec la référence de l'offre signée sur papier ; la signature en ligne de l'offre viendra avec un modèle « offre d'achat » dans la bibliothèque de M06, quand la voie qui tient M06 l'aura ajouté. Le financement déclaré ne sert qu'à vérifier la cohérence des montants, jamais à noter l'acquéreur [R14]. L'identité de l'acquéreur est un état (vérifiée ou non, par qui, quand), lu dans le contrôle d'identité de D03, jamais une copie [R15]. La transmission au vendeur passe par le contrôle central des envois, en mode essai, après validation de l'agent. M10 n'existe pas encore : l'offre acceptée ouvre un dossier de vente minimal, que M10 complétera, et ce dossier reste bloqué tant que l'identité de chaque acquéreur n'est pas vérifiée [R58]. Le code de M09 vit dans `packages/core/src/offres/` et ses migrations à partir de `0201`, sans toucher aux fichiers du socle.

### O01 · Offre écrite enregistrée, avec son registre chaîné
- Statut : fait (2026-10-27)
- Décidé (2026-10-27) : le registre est l'offre elle-même, une ligne par offre, chaînée et ancrée au journal, une ancre par rang ; ancre manquée reprise au prochain enregistrement ; conditions : prêt, vente d'un autre bien, permis, certificat d'urbanisme, autre sans texte ; validité de 1 à 60 jours ; bien vendu, loué ou retiré : plus d'offre ; acquéreur d'un autre agent : par la direction
- Qui : Claude · Relecture : forte · Dépend de : D04, T01
- Cahier : M09, « Offre écrite » ; règle « toute offre reçue est transmise au vendeur ».
- Objectif : l'agent enregistre une offre reçue pour un bien en vente : acquéreur (sa fiche), montant, conditions suspensives dans une liste fermée (prêt avec montant et durée, vente d'un autre bien, permis, autre), durée de validité, financement déclaré (apport, prêt), référence de l'offre signée ; chaque offre reçoit un numéro dans le registre des offres du bien, chaîné par empreintes, en ajout seul ; l'historique de l'offre est horodaté.
- Jamais vu : **registre des offres vérifiable par le vendeur**. Chaque offre reçue prend sa place dans un registre chaîné du bien ; le vendeur voit le nombre d'offres reçues et peut vérifier qu'aucune n'a été retenue ni modifiée après coup. Aucun réseau ne prouve ainsi au vendeur qu'il a vu toutes les offres.
- Critères : une offre sans montant, sans validité ou avec une condition hors liste est refusée, le champ nommé ; deux offres simultanées ont deux numéros sans trou ; une modification directe d'une ligne du registre est détectée par le contrôle [R56] ; rien ne s'efface [R17] ; seuls l'agent du bien et la direction enregistrent ou lisent une offre [R16] ; aucune donnée personnelle au journal [R13].
- Attend : rien.

### O02 · Contrôles de l'offre, sans évaluer personne
- Statut : fait (2026-10-27)
- Décidé (2026-10-27) : identité selon la règle de D03 (même réglage, fiches réunies), lue seulement avec le droit de voir la fiche de l'acquéreur ; cohérence sur le prix offert ; contrôle fait à l'enregistrement et à la demande
- Qui : Claude · Relecture : forte · Dépend de : O01
- Cahier : M09, « Contrôles ».
- Objectif : à l'enregistrement et à la demande, un contrôle écrit, ligne par ligne : identité de chaque acquéreur vérifiée ou non (état lu dans D03), cohérence entre le montant et le financement déclaré (apport plus prêt couvrent le prix offert ; l'offre ne porte pas de frais), offre dans sa durée de validité ; le résultat est un constat, jamais une note.
- Critères : aucun score, aucun classement, aucune évaluation de solvabilité [R14] ; le contrôle ne lit aucune pièce d'identité [R15] ; écart de financement chiffré et montré sans jugement ; résultat au journal en codes, sans montant ni nom [R13].
- Attend : rien.

### O03 · Transmission au vendeur et réponse horodatée
- Statut : fait (2026-10-27)
- Décidé (2026-10-27) : transmission par message (contrôle central, essai, texte du code sans nom de l'acquéreur), au téléphone ou en personne attestés par l'agent ; réponse avec preuve et heure à fuseau, jamais avant la transmission ; alerte d'offre non transmise après 24 h, une fois, reprise si le journal a manqué ; le branchement des passages quotidiens au planificateur suit avec celui de M09 (fichiers du socle) ; Codex sans réponse 18 min à sa seconde relecture, fusion sans lui
- Qui : Claude · Relecture : forte · Dépend de : O02
- Cahier : M09, « Transmission » ; règles « aucun programme n'accepte une offre ni ne négocie un prix », « toute offre reçue est transmise au vendeur ».
- Objectif : l'agent valide la transmission de chaque offre au vendeur (message par le contrôle central, en mode essai) ; la réponse du vendeur (acceptation, refus, contre-offre) est rapportée par l'agent avec sa preuve et son heure ; un contrôle quotidien signale toute offre enregistrée et pas transmise.
- Critères : une offre non transmise après le délai réglé est signalée à l'agent et à la direction [R56] ; aucune fonction ne change l'état d'une offre sans une réponse du vendeur rapportée avec preuve [R57] ; l'envoi passe par le contrôle central (horaires, exclusions) [R01, R02] ; historique complet et horodaté.
- Attend : rien pour l'essai.

### O04 · Contre-offres et historique de la négociation
- Statut : fait (2026-10-27)
- Décidé (2026-10-27) : propositions transmises de vive voix ou par écrit, attesté ; une proposition n'existe qu'après une réponse « contre-offre » ; montants donnés par les parties ; les contre-offres sans réponse ont leur tâche avant l'échéance (O05)
- Qui : Claude · Relecture : normale · Dépend de : O03
- Cahier : M09, « Transmission », « contre-offre ».
- Objectif : une contre-offre du vendeur crée une nouvelle proposition liée à l'offre, transmise à l'acquéreur après validation de l'agent ; la réponse de l'acquéreur est rapportée de la même façon ; la chaîne complète se lit dans l'ordre.
- Critères : une chaîne offre, contre-offre, nouvelle offre se lit dans l'ordre avec chaque heure ; une proposition remplacée ne peut plus être acceptée ; aucun montant proposé par le système [R57].
- Attend : rien.

### O05 · Délais de validité suivis
- Statut : fait (2026-10-27)
- Décidé (2026-10-27) : une tâche la veille du dernier jour (réglage), une par offre sans réponse ; liste sous R16 comme les échéances des mandats ; offre échue le lendemain, à Paris
- Qui : Claude · Relecture : normale · Dépend de : O01
- Cahier : M09, règle « les délais de validité sont suivis et rappelés à l'agent ».
- Objectif : chaque jour, une tâche pour l'agent avant l'échéance d'une offre sans réponse (délai en réglage), et l'offre passe « échue » le lendemain de sa fin, à l'heure de Paris.
- Critères : une seule tâche par échéance ; une offre échue ne peut plus être acceptée [R59] ; calcul juste à l'heure de Paris ; rien n'est envoyé au vendeur ni à l'acquéreur.
- Attend : rien.

### O06 · Tableau comparatif des offres pour le vendeur
- Statut : fait (2026-10-27)
- Décidé (2026-10-27) : ordre d'arrivée, sans tri ; net vendeur = montant moins les honoraires fixés au mandat ; état et validité de la dernière contre-offre ; état du registre montré ; date de signature souhaitée pas encore saisie
- Qui : Claude · Relecture : normale · Dépend de : O02
- Cahier : M09, « Plusieurs offres ».
- Objectif : pour un bien, toutes les offres en cours côte à côte : montant, net vendeur après honoraires du mandat, conditions suspensives, durée de validité restante, date de signature souhaitée ; dans l'ordre d'arrivée, sans aucun tri ni note.
- Critères : aucun classement ni recommandation [R14, R57] ; net vendeur calculé juste depuis le mandat en vigueur ; aucune coordonnée de l'acquéreur ; toutes les offres reçues y figurent [R56].
- Attend : rien.

### O07 · Offre acceptée : dossier de vente, bloqué sans identité vérifiée
- Statut : fait (2026-10-27)
- Décidé (2026-10-27) : dossier ouvert par l'agent du bien après une acceptation rapportée avec preuve ; une seule offre acceptée par bien, vérifié dans l'instruction d'insertion ; le bien passe « sous offre » ; compromis bloqué sans identité vérifiée, lue sous les droits de la fiche de l'acquéreur
- Qui : Claude · Relecture : forte · Dépend de : O03
- Cahier : M09, « Offre acceptée » ; critère « aucun compromis préparé sans identité vérifiée de l'acquéreur ».
- Objectif : une acceptation rapportée avec preuve ouvre un dossier de vente minimal (bien, offre, acquéreurs, vendeur), que M10 complétera ; le dossier ne peut passer à « compromis en préparation » tant que l'identité de chaque acquéreur n'est pas vérifiée ; le bien passe « sous offre » pour la publication (M07).
- Critères : aucun compromis préparé sans identité vérifiée [R58] ; une seule offre acceptée par bien à la fois ; le parcours de test d'une offre, de l'enregistrement au dossier, garde un historique complet et horodaté.
- Attend : rien.

### O08 · Routes de M09
- Statut : fait (2026-10-27)
- Décidé (2026-10-27) : routes et passage quotidien dans `packages/api/src/offres.ts`, sans toucher au socle ; clé d'envoi des offres (rejeu rendu tel qu'enregistré, clé reprise pour une autre offre refusée) ; branchement confié à la voie qui tient le socle (O09)
- Qui : Claude · Relecture : forte · Dépend de : O07
- Cahier : M09.
- Objectif : les routes `/v1/offres` dans `packages/api/src/offres.ts`, de la même forme que celles de `app.ts`, et les passages quotidiens (offres non transmises, échéances), sans toucher au socle ; leur branchement dans `app.ts` et au planificateur suit, comme P10, par la voie qui tient le socle.
- Critères : chaque route sous R16, chaque refus une ligne au journal ; une offre test suivie de bout en bout par les routes ; un double envoi de la même offre (clé d'idempotence) ne crée qu'une ligne au registre.
- Attend : rien.

### O09 · Branchement de M09 dans le socle
- Statut : fait (2026-10-27)
- Décidé (2026-10-27) : M09 exporté en espace de noms `offres` ; passage `offres.quotidien` à 6 h ; une panne d'un réseau ou d'un contrôle n'arrête pas les autres.
- Qui : Claude, voie 1 (fichiers du socle : `packages/core/src/index.ts`, `packages/api/src/app.ts`, `packages/api/src/planificateur.ts`, `packages/api/src/worker.ts`) · Relecture : forte · Dépend de : O08
- Cahier : M09 ; règles « les délais de validité sont suivis et rappelés à l'agent », « toute offre reçue est transmise au vendeur ».
- Objectif : exporter `offres` depuis `@aimmo/core` et remplacer l'import relatif de `packages/api/src/offres.ts` ; ajouter `offreRoutes()` aux routes de `app.ts` ; lancer `syncOffres` chaque jour depuis le planificateur, une fois par créneau.
- Critères : les routes répondent derrière la clé d'API [R16] ; le passage quotidien tourne une fois par jour [R56, R59] ; rien ne part réellement tant que le plan n'a pas mis d'envoi en service.
- Attend : rien.

**M10 · Compromis et acte, mai 2027.**

Voie : 2

Découpé le 2026-10-27 par la voie 2. Ids `N..` pour Notaire. Cahier : M10 Compromis et acte ; Feuille de route, mai 2027 : « 3 dossiers tests complets, sans pièce manquante » ; critères « chaque dossier en cours a ses échéances et ses alertes », « aucune relance envoyée hors des heures d'envoi ».
Décidé, lecture prudente : M10 complète le dossier de vente ouvert par O07 ; le compromis et l'acte sont rédigés par le notaire, AIMMO lui transmet un dossier complet et ne rédige aucun acte. Une pièce est une référence de stockage (R2, derrière une interface, faux stockage dans les tests), jamais son contenu ; une pièce d'identité ou anti-blanchiment n'est jamais une pièce du dossier : seul l'état « identité vérifiée » de D03 y figure [R15]. Les échéances légales sont calculées par le code depuis les dates saisies avec leur preuve (rétractation de 10 jours à compter du lendemain de la première présentation de la notification, reportée au premier jour ouvrable si elle tombe un samedi, un dimanche ou un jour férié ; réponse de la commune 2 mois après la réception de la déclaration d'intention d'aliéner) ; les autres dates (prêt, acte) sont lues dans le compromis, jamais inventées [R10]. Le financement est suivi tel que déclaré, jamais évalué [R14]. AIMMO ne reçoit jamais de fonds. Toute relance ou information aux clients et au notaire passe par le contrôle central, en mode essai, dans les heures d'envoi [R01, R26]. Le suivi des commerces (engagement de confidentialité) vient avec M16 ; les espaces propriétaire et acquéreur avec M11 et M13 (juin 2027) : M10 prépare leurs vues. Le code de M10 vit dans `packages/core/src/dossiers/`, ses migrations à partir de `0301`, ses routes dans `packages/api/src/dossiers.ts`, sans toucher aux fichiers du socle ni à ceux de M09 sauf par une tâche qui le dit.

### N01 · Pièces du dossier notaire
- Statut : fait (2026-10-27)
- Reste : relecture de Codex de la correction de son P0 restée sans réponse 26 min, fusion sans elle (#90).
- Décidé (2026-10-27) : chaque pièce porte la date du document, saisie par l'agent, pour juger sa validité à l'acte (N06) ; le gaz est demandé pour tout logement de 15 ans ou plus, quel que soit le chauffage (sans installation, la pièce est l'attestation d'absence) ; 15 ans pile comptent ; lot de copropriété : notice d'information, plan pluriannuel de travaux ou diagnostic technique global, et dossier technique amiante des parties communes avant juillet 1997 ; diagnostics dépendant d'un arrêté local (termites, mérule, assainissement) à ajouter par commune plus tard
- Qui : Claude · Relecture : forte · Dépend de : O07
- Cahier : M10, « Dossier notaire » ; Conformité, données minimales.
- Objectif : la liste des pièces attendues pour un dossier de vente, calculée par des règles écrites selon le bien (titre de propriété, diagnostics, documents de copropriété pour un lot, fiches de renseignements du vendeur et de l'acquéreur) ; l'agent range chaque pièce reçue par sa référence de stockage, datée et attribuée ; la liste des pièces manquantes ; le dossier est « complet » quand rien ne manque.
- Critères : la liste dépend seulement des données du bien, la même pour tous [R60] ; une pièce reçue ne s'efface ni ne change, une nouvelle version s'ajoute [R17] ; une pièce d'identité, un document anti-blanchiment ou un RIB sont refusés comme pièce, l'identité n'y figure que comme état vérifié [R15] ; seul l'agent du dossier range une pièce, l'agent, la direction et la conformité lisent [R16] ; 3 dossiers tests (maison, appartement en copropriété, terrain) arrivent à « complet ».
- Attend : rien.

### N02 · Échéancier du dossier et alertes à l'agent
- Statut : fait (2026-10-27)
- Décidé (2026-10-27) : la demande unique de pièces ou de visite de la commune suspend son délai, qui reprend pour ce qui restait, au moins un mois ; toute fin d'échéance légale un samedi, un dimanche ou un jour férié est reportée au jour ouvrable suivant ; une tâche par échéance, par date et par agent responsable du bien ; une échéance sans sa date donne une tâche « à saisir »
- Qui : Claude · Relecture : forte · Dépend de : N01
- Cahier : M10, « Échéancier ».
- Objectif : à la signature du compromis, l'agent saisit les dates avec leur preuve (signature, première présentation de la notification à l'acquéreur, date limite du prêt, dépôt de la déclaration d'intention d'aliéner, demande de l'état daté, date prévue de l'acte) ; le code calcule la fin de la rétractation et la date de réponse de la commune ; chaque jour, une tâche pour l'agent avant chaque échéance, une seule par échéance.
- Critères : fin de rétractation exacte, jours fériés et fins de semaine compris, sur un jeu de cas écrits [R61] ; aucune échéance sans date saisie ni preuve, rien d'inventé [R10, R61] ; chaque dossier en cours a ses échéances et ses alertes, sur horloge simulée à l'heure de Paris ; une seule tâche par échéance.
- Attend : rien.

### N03 · Relances des pièces manquantes, en mode essai
- Statut : fait (2026-10-27)
- Reste : relecture de Codex restée en cours plus de 30 min, fusion sans elle (#95).
- Décidé (2026-10-27) : seules les pièces que le client a lui-même sont relancées par mail (titre, fiches de renseignements, règlement de copropriété, procès-verbaux), les autres restent des tâches de l'agent ; finalité `suivi_vente`, accord exigé ; le message nomme le bien par sa commune et sa référence d'agence, un rappel porte sa date ; une relance en attente d'un jour passé, ou dont la pièce est arrivée, est close avec sa raison
- Qui : Claude · Relecture : forte · Dépend de : N01, B02
- Cahier : M10, « relances automatiques » et règles.
- Objectif : chaque jour, pour chaque pièce manquante attendue d'un client, une relance préparée et passée par le contrôle central, rangée dans la boîte d'essai ; texte écrit par le code, sans IA, nommant la pièce ; l'agent voit ce qui est parti et ce qui a été refusé.
- Critères : aucune relance hors des heures d'envoi, sur horloge simulée de la nuit au dimanche [R01] ; jamais à une personne exclue ou arrêtée [R02, R04] ; une relance par pièce et par période réglée [R05] ; rien ne part réellement [R26] ; une pièce reçue arrête ses relances.
- Attend : rien.

### N04 · Suivi du financement déclaré
- Statut : fait (2026-10-28)
- Reste : relecture de Codex de la correction de son P0 (lectures au journal) restée sans réponse 30 min, fusion sans elle (#98).
- Qui : Claude · Relecture : normale · Dépend de : N02
- Cahier : M10, « Suivi du financement ».
- Objectif : les étapes du prêt déclarées par l'acquéreur ou son courtier (demande déposée, accord de principe, offre de prêt émise, offre acceptée, refus), chacune avec sa date et qui l'a déclarée ; une alerte à l'agent quand la date limite du prêt approche sans offre de prêt déclarée.
- Critères : aucune note, aucun score, aucun tri sur le financement, ni dans les données ni dans les routes [R14] ; seules les étapes d'une liste fermée sont acceptées ; l'alerte part une fois, avant la date limite réglée.
- Attend : rien.

### N05 · Aucun fonds, bouclier contre le faux RIB (Jamais vu)
- Statut : fait (2026-10-28)
- Décidé (2026-10-28) : une alerte à l'agent par message suspect, le rappel au client une fois par personne et par dossier ; seules les sortes de signaux sont rangées ; le branchement à la réception et le masquage de l'IBAN dans le message rangé vont au socle (N09)
- Qui : Claude · Relecture : forte · Dépend de : N03
- Cahier : M10, règle « AIMMO ne reçoit jamais de fonds ».
- Objectif : aucun texte d'AIMMO à un client ou au notaire ne demande un paiement ni ne porte de coordonnée bancaire ; chaque message reçu dans la conversation d'un dossier en cours qui parle de virement, d'acompte, de séquestre ou de changement de RIB, ou qui porte un IBAN, déclenche aussitôt une alerte à l'agent, et le client reçoit, dans les heures d'envoi, le rappel écrit qu'AIMMO ne demande jamais de fonds ni de changement de coordonnées bancaires. Jamais vu : aucun réseau ni logiciel ne surveille ainsi la fraude au faux RIB pendant toute la vente.
- Critères : un texte sortant avec IBAN, RIB ou demande de paiement est refusé par le contrôle, la raison au journal sans la donnée [R62] ; un message reçu suspect donne une alerte à l'agent en moins d'une minute, une seule par message [R18, R62] ; l'IBAN reçu n'est ni rangé en clair ni envoyé à une IA [R15] ; le rappel au client respecte R01 à R05 ; aucune table ni route ne reçoit ou ne suit des fonds.
- Attend : rien.

### N06 · Acte signé : vente close, commission due
- Statut : fait (2026-10-28)
- Reste : un avenant de durée signé après le compromis est lu par `mandateTerms` (M06) sans filtre de date : refus prudent de la commission, à corriger dans M06 ; relecture de Codex de la dernière correction sans réponse 30 min, fusion sans elle (#102).
- Décidé (2026-10-28) : le mandat qui compte est celui en vigueur au compromis, signé au plus tard ce jour-là et hors délai de rétractation (sauf demande écrite) ; sinon pas de commission, la direction tranche ; DPE d'avant juillet 2021 périmé depuis 2025 ; plomb compté un an faute de résultat connu ; écritures reprenables après une coupure
- Qui : Claude · Relecture : forte · Dépend de : N02
- Cahier : M10, « Acte signé » ; M13 et M11 pour la suite.
- Objectif : l'agent rapporte l'acte signé avec sa preuve (référence de l'attestation du notaire) ; le dossier se clôt, le bien passe « vendu », la commission devient due au montant du mandat en vigueur, rangée pour M13, et l'après-vente est marqué à démarrer pour M11.
- Critères : pas d'acte sans compromis en préparation et sans dossier complet [R58, R60] ; une pièce périmée à la date de l'acte, d'après sa date de document rangée par N01 (état des risques 6 mois, électricité et gaz 3 ans, DPE 10 ans, durées en réglage), compte comme manquante [R60] ; la commission vient du mandat en vigueur, avenants compris, jamais d'une saisie [R10, R63] ; une seule clôture par dossier ; rien ne s'efface [R17] ; la publication montre le bien vendu au passage suivant.
- Attend : rien.

### N07 · Chemin critique de la vente (Jamais vu)
- Statut : fait (2026-10-28)
- Décidé (2026-10-28) : le jour déclaré d'une offre de prêt est celui de sa réception par l'acquéreur, d'où part le délai de réflexion de 10 jours ; une acceptation plus tôt ne compte pas ; un refus ne bloque que s'il est la dernière étape ; sans rétractation ni réponse de la commune datées, pas de jour au plus tôt ; la vue du vendeur se calcule sans le prêt
- Qui : Claude · Relecture : forte · Dépend de : N02, N04, N06
- Cahier : M10, « Suivi en direct » ; L'IA et l'humain, « suit les échéances, informe les clients ».
- Objectif : pour chaque dossier, le code calcule la date d'acte au plus tôt possible et nomme ce qui la tient (pièce manquante, rétractation, réponse de la commune, prêt, état daté), étape par étape, avec qui doit agir ; une vue vendeur et une vue acquéreur, chacune sans la donnée personnelle de l'autre partie, prêtes pour les espaces de M11. Jamais vu : aucun réseau ne dit au client, à tout moment, ce qui retarde son acte et qui le tient.
- Critères : même calcul pour les mêmes données, chaque ligne avec sa raison, sans IA [R61] ; aucune date inventée, ce qui manque est dit [R10] ; la vue vendeur ne porte ni nom ni coordonnée de l'acquéreur, et l'inverse [R19, R52] ; sur 3 dossiers tests, l'élément bloquant est le bon à chaque étape.
- Attend : rien.

### N08 · Routes de M10
- Statut : fait (2026-10-28)
- Qui : Claude · Relecture : forte · Dépend de : N01 à N07
- Cahier : M10 ; Feuille de route, mai 2027.
- Objectif : les routes `/v1/dossiers` (pièces, échéancier, financement, acte, chemin critique, alertes) dans `packages/api/src/dossiers.ts`, de la même forme que celles de `app.ts`, et `syncDossiers`, le passage quotidien (échéances, relances, financement), sans toucher au socle.
- Critères : chaque route sous R16, chaque refus une ligne au journal ; 3 dossiers tests complets, sans pièce manquante, suivis par les routes de l'offre acceptée à l'acte ; le passage quotidien rejoué n'ajoute rien.
- Attend : rien.

### N09 · Branchement de M10 dans le socle
- Statut : fait (2026-10-28)
- Décidé (2026-10-28) : routes de M10 fermées (503) sans le compartiment R2 `PIECES` (H25), passage `dossiers.passage` seulement avec lui ; `dossiersJob` fait déjà les relances des pièces, `pieceReminderJob` n'est pas branché à part ; IBAN et RIB masqués à la réception (corps, objet, contenu illisible texte par texte) par un parcours linéaire borné par la clé modulo 97 ; au contrôle central, R62 refuse pour tout texte à un client les coordonnées bancaires et les demandes de payer qui nomment ce qui se paie, la liste complète restant aux textes du code de M10.
- Reste : les messages reçus rangés avant N09 gardent leur IBAN en clair (mode essai) ; les échos des réponses de l'agent par Meta ne sont pas masqués ; relecture de Codex de la dernière correction restée en cours, fusion sans elle (#111).
- Décidé (2026-10-28) : `packages/api/src/dossiers.ts` expose `dossierRoutes()`, `syncDossiers`, `dossiersJob` (tous les jours de 9 h à 19 h, relances jamais le dimanche) et `R2PieceStore` ; il importe M10 par un chemin relatif, à remplacer par `dossiers` de `@aimmo/core` ; la tâche `pieceReminderJob` du cœur n'est plus à lancer, `dossiersJob` la contient ; le bucket R2 des pièces est à déclarer dans le Worker ; tant que `scan` n'est pas branché à la réception, le filet du bouclier ne relit que 48 h de messages
- Qui : Claude, voie 1 (fichiers du socle : `packages/core/src/index.ts`, `packages/api/src/app.ts`, `packages/api/src/planificateur.ts`, `packages/api/src/worker.ts`) · Relecture : forte · Dépend de : N08
- Cahier : M10.
- Objectif : exporter `dossiers` depuis `@aimmo/core` ; ajouter les routes de M10 à `app.ts` ; lancer `syncDossiers` chaque jour depuis le planificateur, une fois par créneau ; brancher `BouclierFonds.scan` (N05) à la réception des messages, dès qu'un message est rattaché à sa fiche, et masquer l'IBAN dans le message rangé [R15] ; appliquer `fundsInOutgoing` dans le contrôle central à tout texte destiné à un client [R62] ; lancer `dossiersJob` (N08), qui contient les relances (N03).
- Critères : les routes répondent derrière la clé d'API [R16] ; le passage tourne une fois par jour ; rien ne part réellement tant que le plan n'a pas mis d'envoi en service.
- Attend : rien.

**M11 · Après la vente, juin 2027.**

Voie : 1

Découpé le 2026-10-27 par la voie 1. Ids `F..` pour Fidéliser. Cahier : M11 Après la vente ; Feuille de route, juin 2027 ; critères « sur 5 dossiers tests arrivés à l'acte, la demande d'avis part le lendemain », « aucune relance à une personne opposée ».
Décidé, lecture prudente : M11 part de l'acte signé rapporté par M10 (N06), lu par une interface (« dossier clos le … »), avec un faux dossier clos dans les tests tant que N06 n'est pas fusionnée. Tout envoi passe par le contrôle central, en mode essai, dans les heures d'envoi [R01, R26]. La demande d'avis va à chaque client du dossier (vendeurs et acquéreurs), sans tri selon sa satisfaction et sans contrepartie [R64] ; AIMMO n'écrit jamais d'avis à la place d'un client. Le lien vers la fiche Google de l'agent est un réglage de l'agent ; l'API Google Business Profile (H07) viendra pour lire les avis, pas pour en publier. Les relances après la vente : à un an, seulement à qui ne s'y est pas opposé, au-delà seulement avec l'accord donné à l'acte, avec désinscription dans chaque message [R65]. Une recommandation arrive dans M02 avec sa source, et n'est jamais rémunérée à un particulier [R66] : aucun champ de récompense, aucun texte qui en promet. La note de satisfaction est rangée pour M13. Le code vit dans `packages/core/src/apres-vente/`, ses migrations à partir de `0401`, ses routes dans `packages/api/src/apres-vente.ts`.

### F01 · Recommandation d'un proche, rangée dans M02 avec sa source
- Statut : fait (2026-10-27)
- Décidé (2026-10-27) : la réponse ne dit jamais qui suit le proche ; la source ne nomme pas le client ; un proche sans agent passe à l'agent de la tâche ; une opposition après coup retire la tâche de la liste.
- Qui : Claude · Relecture : forte · Dépend de : C02
- Cahier : M11, « Recommandations » ; Conformité, consentement.
- Objectif : l'agent saisit qu'un client recommande un proche (prénom, une coordonnée, le projet, et ce que le proche a accepté : être appelé par l'agent, avec la preuve dite par le client) ; le proche arrive dans la fiche unique (rattachée si elle existe) avec la source « recommandation » qui nomme le client qui recommande ; une tâche « appeler » pour l'agent ; un lien « qui a recommandé qui » lisible sur les deux fiches.
- Critères : la source de la fiche du proche est « recommandation », avec le client qui recommande [R66] ; aucun champ ni texte de récompense : une saisie qui en parle (prime, cadeau, commission, bon d'achat, pourcentage) est refusée [R66] ; sans accord du proche, aucune tâche « appeler » et aucun envoi, la fiche est seulement rangée [R03] ; un proche exclu ou opposé n'est jamais rappelé [R02, R04] ; droits de la fiche [R16] ; rien d'une coordonnée au journal [R13].
- Attend : rien.

### Z01 · Jetons de lien qui ne déclenchent jamais le contrôle du texte
- Statut : fait (2026-10-28)
- Qui : Claude, voie 1 · Relecture : normale · Dépend de : rien
- Décidé (2026-10-28) : ouverte après une vérification rouge sur #101. Un jeton de rappel de V04 commençait par « gpt », et le contrôle du texte l'a lu comme une mention de l'IA [R06]. Le même défaut existe pour la désinscription des alertes de T03. F04 l'a déjà corrigé pour ses propres jetons (`newAfterSaleToken`).
- Cahier : M05, « Rappels » ; M08, « Alertes ».
- Objectif : les jetons de `newBookingToken` (rendezvous/reservation.ts) et de la désinscription des alertes (acquereurs/alertes.ts) ne commencent jamais par a, c, g, i ni r ; un rappel ou une alerte n'est plus jamais refusé pour R06 à cause du hasard.
- Critères : sur 2 000 tirages, le texte d'un rappel et celui d'une alerte passent le contrôle du texte [R06] ; le test de V04 ne peut plus échouer au hasard.
- Attend : rien.

### F02 · Demande d'avis le lendemain de l'acte, à tous, en mode essai
- Statut : fait (2026-10-28)
- Décidé (2026-10-27) : faite avant N06, comme le prévoit la lecture prudente de M11 : le dossier clos est lu par une interface, avec un faux dossier clos dans les tests ; N06 la branchera.
- Qui : Claude · Relecture : forte · Dépend de : N06
- Cahier : M11, « Demande d'avis » ; règle « l'avis est demandé à tous les clients, sans tri préalable, sans contrepartie ».
- Objectif : le lendemain d'un dossier clos, à 10 h, heure de Paris, une demande d'avis à chaque client du dossier, écrite par le code avec le lien de la fiche Google de l'agent (réglage de l'agent), passée par le contrôle central, rangée dans la boîte d'essai ; une seule par personne et par dossier.
- Critères : sur 5 dossiers tests clos, chaque client reçoit sa demande le lendemain, aucun deux fois [R64, R18] ; la demande ne dépend d'aucune note de satisfaction et ne promet rien [R64] ; sans lien réglé, rien ne part et l'agent est prévenu ; une personne exclue ou qui a demandé l'arrêt ne reçoit rien [R02, R04].
- Attend : rien (H07 seulement pour lire les avis plus tard).

### F03 · Remerciement : l'agent appelle, le message est préparé
- Statut : fait (2026-10-28)
- Décidé (2026-10-28) : faite avant N06, comme F02 : le dossier clos est lu par l'interface `DossiersClos` ; les appels « remercier » sont listés par F03 pour l'agent, et F07 les met dans « Ma journée ».
- Qui : Claude · Relecture : normale · Dépend de : N06
- Cahier : M11, « Remerciement ».
- Objectif : à la clôture, une tâche « appeler pour remercier » par client, au plan du jour de l'agent, et un message de remerciement préparé que l'agent valide ou non ; rien ne part sans sa validation.
- Critères : une tâche par client et par dossier [R18] ; le message validé passe par le contrôle central, en mode essai ; non validé, rien ne part.
- Attend : rien.

### F04 · Relance un an après la vente, sans jamais relancer une personne opposée
- Statut : fait (2026-10-28)
- Décidé (2026-10-28) : les dates clés sont les anniversaires de l'acte, de un à cinq ans ; sans choix rangé, aucune relance ; un accord ne se range qu'à l'acte, au plus 7 jours après ; un `non`, sur n'importe quel dossier de la personne et fiches réunies comprises, arrête tout et empêche tout nouvel accord.
- Qui : Claude · Relecture : forte · Dépend de : F02
- Cahier : M11, « Relances aux dates clés » ; règle « relances seulement aux clients qui ne s'y sont pas opposés, avec désinscription dans chaque message ».
- Objectif : à l'acte, l'agent range le choix du client (relances après la vente : oui, non, ou seulement à un an) avec sa preuve ; un an après la clôture, une relance écrite par le code, avec un lien de désinscription ; au-delà d'un an, seulement avec l'accord donné à l'acte ; une opposition dite plus tard arrête tout.
- Critères : aucune relance à une personne opposée, sur 30 dossiers tests à horloge simulée [R65] ; chaque message porte la désinscription, qui marche en un geste [R65] ; une seule relance par date clé [R18] ; hors heures d'envoi, rien ne part [R01].
- Attend : rien.

### F05 · Satisfaction : note et commentaire rangés pour M13
- Statut : fait (2026-10-28)
- Qui : Claude · Relecture : normale · Dépend de : F02
- Cahier : M11, « Satisfaction ».
- Objectif : le client donne une note de 1 à 5 et un commentaire par un lien à usage unique de sa demande d'avis ; la note est rangée avec le dossier pour M13 ; l'agent la voit ; elle ne change jamais qui reçoit la demande d'avis.
- Critères : un lien ne sert qu'une fois et expire ; la note ne trie ni ne bloque aucune demande d'avis [R64] ; le commentaire n'est jamais publié ni envoyé comme avis [R64] ; rien du commentaire au journal [R13].
- Attend : rien.

### F06 · Carnet du propriétaire, un an après (Jamais vu)
- Statut : fait (2026-10-28)
- Qui : Claude · Relecture : forte · Dépend de : F04, E01, E02
- Cahier : M11 ; M20 Gagner des mandats ; M04, fourchette par le code.
- Objectif : un an après l'achat, et seulement avec son accord donné à l'acte, l'acquéreur devenu propriétaire reçoit le carnet de son bien : la fourchette de valeur calculée par le code depuis les ventes DVF de sa commune (E01, E02), les ventes comparables de l'année, les échéances de ses diagnostics, et rien qu'il n'ait déjà donné ; c'est le premier contact de son futur mandat de vente, sans jamais le lui demander.
- Critères : chaque chiffre du carnet vient de la base ou des ventes publiques, sinon « non communiqué » [R10] ; sans accord, aucun carnet [R65] ; jamais de démarchage dans le texte : une liste fermée de tournures refuse « vendre maintenant », « estimation gratuite », « profitez » ; 5 carnets tests, chacun relu par le code contre ses sources.
- Attend : rien.

### F07 · Routes de M11, branchement et écran « Après la vente »
- Statut : fait (2026-10-28)
- Décidé (2026-10-28) : dossiers clos lus dans la base de M10 (`SqlDossiersClos`) : vendeur du mandat de la commission, puis acquéreur ; un logement est un appartement s'il est un lot de copropriété, une maison sinon, inconnu sans fiche (pas de carnet) ; position du carnet : centre de la commune par la Base adresse nationale, jamais une adresse ; une variable `APRES_VENTE_BASE` pour les trois liens publics, à la racine `/apres-vente/` ; les remerciements préparés restent à l'agent seul.
- Reste : relecture de Codex de la dernière correction (son P2) restée en cours plus de 10 min, fusion sans elle (#109) ; la mise en service attend `APRES_VENTE_BASE` et `DVF_BASE_URL`.
- Qui : Claude, voie 1 (fichiers du socle) · Relecture : forte · Dépend de : F01, F02, F03, F04, F05
- Cahier : M11 ; Organisation, exigence de design (protocole, section 9).
- Objectif : les routes `/v1/apres-vente` (recommandation, choix des relances, lien de la fiche Google, satisfaction, tâches) dans `packages/api/src/apres-vente.ts`, branchées dans `app.ts`, le passage quotidien au planificateur, et dans l'application de l'agent l'écran d'un dossier clos : demandes parties, tâches « remercier », recommandations, note.
- Critères : chaque route sous R16, refus au journal ; un parcours de test, de l'acte à la relance d'un an ; écran accessible, sans texte générique, beau sur téléphone d'abord.
- Reste de F06 : page publique du carnet (`CarnetsProprietaire.read`), réglage de son adresse, `BiensVendus` branché avec N06, `carnets` passé à `afterSaleReminderJob`.
- Reste de F03 : routes `decide`, `markCalled`, `list` ; appels « remercier » dans « Ma journée » ; `thankYouJob` au planificateur.
- Reste de F05 : page publique de la note et route de réponse (`Satisfaction.submit`), réglage `satisfactionBase` de `reviewRequestJob`, réponses dans l'écran de l'agent.
- Reste de F04 : brancher `afterSaleReminderJob` au planificateur, avec l'adresse de désinscription en réglage ; routes du choix (`recordChoice`), de la désinscription (`unsubscribe`, page publique) et de la liste.
- Reste de F02 : brancher `reviewRequestJob` au planificateur avec le `DossiersClos` de N06 ; routes du lien de la fiche Google (`setReviewLink`), des demandes (`list`) et des tâches (`openTasks`, `lien_avis` et `avis_non_parti`). Le plafond de R11, 2 demandes d'avis par jour pour tout le réseau, ne suffira pas quand le réseau clora plus de 2 ventes par jour : les demandes en trop sont closes et confiées à l'agent ; un plafond par agent serait un changement de R11, à décider avec Shawez.
- Reste de F01 : deux saisies simultanées du même proche peuvent laisser un projet et une source en trop (D1 sans transaction interactive) : la route de recommandation porte une clé d'idempotence.
- Attend : rien.

**M13 · Pilotage et finances, juin 2027.**

Voie : 1

Découpé le 2026-10-28 par la voie 1. Ids `K..` pour Kilomètres et chiffres. Cahier : M13 Pilotage et finances ; Feuille de route, juin 2027 : « chiffres identiques au contrôle manuel pendant 2 semaines » ; critères « 10 ventes passées recalculées sans écart », « le rapport du matin arrive chaque jour ouvré à 7 h 30 ».
Décidé, lecture prudente : tous les chiffres viennent de la base, par des requêtes écrites, jamais d'une saisie ni de l'IA ; l'IA n'évalue aucun agent et ne décide de rien les concernant ; aucun classement d'agents n'est montré à un agent [R14, R68, R69]. Une commission naît « prévue » au compromis, devient « due » seulement à l'acte rapporté par N06 (ou à la signature du bail, quand M15 existera), puis « facturée » et « payée », chaque passage dans l'ordre, avec sa preuve, jamais un montant saisi [R63, R67]. La part de l'agent et celle du réseau viennent d'une grille datée et versionnée réglée par la direction ; le partage entre agents (fichier commun, binôme d'une absence) et la prime de parrainage (M14, R83) sont lus par des interfaces, avec un faux dans les tests tant que M14 ne les fournit pas. Une facture a un numéro continu, chronologique, sans trou ; elle ne change ni ne s'efface, un avoir la corrige [R17, R71] ; aucune facture réelle tant que la plateforme agréée de facturation électronique et les modalités de l'expert-comptable ne sont pas en place (H26) : la plateforme est derrière une interface, en mode essai. Le reversement à l'agent est dû sous 24 h ouvrées après l'encaissement rapporté avec sa preuve, la direction est alertée avant l'échéance [R70]. Les numéros de règles R67 à R72 et de migrations à partir de `0501` sont réservés à M13. Le code vit dans `packages/core/src/pilotage/`, ses routes dans `packages/api/src/pilotage.ts`.

### K01 · Cycle de la commission : prévue, due, facturée, payée
- Statut : fait (2026-10-28)
- Décidé (2026-10-28) : parts arrondies au centime inférieur, le reste au réseau ; prime de parrainage prise sur la part du réseau ; aucune grille pour le passé ; la conformité n'a pas les chiffres (droits du socle) ; l'agent qui ne fait que partager voit sa part sans les honoraires ; écart d'honoraires, de mandat ou de jour de compromis à l'acte : la commission reste prévue, la direction tranche.
- Qui : Claude · Relecture : forte · Dépend de : N06
- Cahier : M13, « Commissions » et « Règles ».
- Objectif : une commission par dossier de vente, calculée par le code depuis le mandat en vigueur (honoraires, avenants compris) : « prévue » dès le compromis, « due » à l'acte (N06), puis « facturée » (K02) et « payée » (K03) ; la part de l'agent et la part du réseau par une grille datée (taux de l'agent, partage du fichier commun, binôme, prime de parrainage lue par une interface), la grille en vigueur au jour du compromis.
- Critères : 10 ventes passées tests recalculées sans écart, au centime, contre des montants écrits à la main [R69] ; aucun montant saisi, aucune route ne reçoit un montant [R63, R67] ; les statuts se suivent dans l'ordre, chacun avec sa preuve, une seule fois [R18, R67] ; une grille changée ne change pas une commission déjà prévue ; un agent ne voit que ses commissions [R16, R68] ; rien ne s'efface [R17].
- Attend : rien.

### K02 · Factures d'honoraires et de reversement, en mode essai
- Statut : fait (2026-10-28)
- Décidé (2026-10-28) : TVA 20 % sur les honoraires, aucune sur les reversements tant que l'expert-comptable n'a pas validé (H26) ; numéro calculé dans l'écriture même ; numéro des reversements et de leurs avoirs préfixé par l'identifiant entier de l'agent ; une vente annulée par un avoir n'émet plus aucune facture ; identifiants légaux de l'émetteur, adresse du client et conditions de paiement non inventés, attendus avec H09 et H26.
- Reste : relecture de Codex de la dernière correction impossible, limite d'usage de Codex atteinte ; fusion sans elle (#115).
- Qui : Claude · Relecture : forte · Dépend de : K01
- Cahier : M13, « Factures » et « Branchements ».
- Objectif : à la commission due, la facture d'honoraires du réseau au client qui paie (mentions obligatoires, numéro continu par réseau et par année) et la facture de reversement de l'agent au réseau, préparées par le code et validées par la direction ; émises par l'interface de la plateforme agréée (fausse plateforme d'essai) ; un avoir pour toute correction ; export comptable au format tableur (CSV).
- Critères : numéros continus, chronologiques, sans trou ni doublon, même en deux validations simultanées [R71] ; une facture émise ne change ni ne s'efface, un avoir la corrige [R17, R71] ; rien ne part à une vraie plateforme [R26] ; l'export recompte au centime les montants des factures ; aucune donnée bancaire [R15].
- Attend : H26 pour le réel seulement.

### K03 · Encaissement et reversement sous 24 h ouvrées
- Statut : fait (2026-10-28)
- Décidé (2026-10-28) : 24 h comptées heure par heure sur les seuls jours ouvrés à Paris ; alerte à 4 h de l'échéance (réglage), puis une fois passée ; la prime de parrainage due après l'encaissement (R83) sera facturée par M14.
- Reste : relecture de Codex impossible (limite d'usage, H03), fusion sur les vérifications du dépôt (#117) ; passage des alertes au planificateur avec K08.
- Qui : Claude · Relecture : normale · Dépend de : K02
- Cahier : M13, règle du versement sous 24 h ouvrées.
- Objectif : la direction rapporte l'encaissement des honoraires avec sa preuve ; le reversement de l'agent devient exigible sous 24 h ouvrées (jours ouvrés, fériés compris) ; une tâche pour la direction, une alerte avant l'échéance, puis le versement rapporté avec sa preuve passe la commission à « payée ».
- Critères : l'échéance exacte sur un jeu de cas écrits (vendredi soir, veille de férié) [R70] ; une alerte une seule fois, avant l'échéance, sur horloge simulée [R18] ; aucun fonds reçu ni suivi par AIMMO au-delà du statut et de sa preuve [R62].
- Attend : rien.

### K04 · Tableau de bord de l'agent, chaque chiffre prouvé (Jamais vu)
- Statut : fait (2026-10-28)
- Décidé (2026-10-28) : contacts = attributions à l'agent ; rendez-vous = tenus ; vente = acte signé dont la commission revient à l'agent (comme N06) ; honoraires à venir = ses parts (agent, partage) prévues, dues ou facturées, pas encore payées ; lignes sans nom, la fiche se lit sous ses droits.
- Reste : relecture de Codex impossible (limite d'usage, H03), fusion sur les vérifications (#118) ; si M14 réattribue les biens d'un agent parti, rattacher la vente à l'agent du compromis (K01).
- Qui : Claude · Relecture : forte · Dépend de : K01
- Cahier : M13, « Tableau de bord de l'agent » ; règle « un agent ne voit que ses propres chiffres ».
- Objectif : pour l'agent, sur une période : contacts reçus, rendez-vous tenus, mandats signés, ventes, honoraires à venir (prévus et dus), calculés par des requêtes écrites ; chaque chiffre s'ouvre sur la liste exacte des lignes qui le font. Jamais vu : aucun logiciel ne laisse l'agent recompter chacun de ses chiffres, ligne par ligne.
- Critères : chaque chiffre est égal au nombre ou à la somme des lignes qu'il montre, sur un jeu test complet [R69] ; un agent ne voit que ses chiffres, sans comparaison ni rang [R14, R68] ; aucune IA dans le calcul.
- Attend : rien.

### K05 · Tableau de bord du réseau : agents, zones, sources, coûts de l'IA
- Statut : fait (2026-10-28)
- Décidé (2026-10-28) : zone = zone de l'agent (« sans zone » sinon) ; contact sans agent compté sous la direction ; source d'un contact = canal du message d'origine, d'un mandat = sa source rangée ; coût de l'IA = coût rangé avec chaque message écrit par l'IA.
- Reste : relecture de Codex impossible (limite d'usage, H03), fusion sur les vérifications (#119).
- Qui : Claude · Relecture : normale · Dépend de : K04
- Cahier : M13, « Tableau de bord du réseau ».
- Objectif : pour la direction : les mêmes chiffres par agent, par commune et par source, et les coûts de l'IA par flux et par mandat signé, lus dans la base.
- Critères : la somme par agent égale le total du réseau, par zone et par source aussi [R69] ; seule la direction le lit [R16] ; aucune note ni score d'agent [R14].
- Attend : rien.

### K06 · Rapport du matin, chaque jour ouvré à 7 h 30
- Statut : fait (2026-10-28)
- Décidé (2026-10-28) : période = du jour ouvré précédent à la veille (le lundi couvre vendredi à dimanche) ; rapport rangé, lu dans l'application, jamais envoyé ; alertes : rappels en retard pour l'agent, reversements à faire pour la direction.
- Reste : relecture de Codex impossible (limite d'usage, H03), fusion sur les vérifications (#120) ; branchement au planificateur et écran avec K08.
- Qui : Claude · Relecture : normale · Dépend de : K05
- Cahier : M13, « Rapport du matin ».
- Objectif : chaque jour ouvré à 7 h 30, heure de Paris, un rapport rangé pour la direction et pour chaque agent : les chiffres de la veille, les contacts chauds, les alertes, en quelques lignes écrites par le code.
- Critères : un rapport par lecteur et par jour ouvré, aucun le week-end ni un jour férié, un seul même si le planificateur repasse [R18] ; chaque chiffre vient du tableau de bord [R69] ; un agent n'a que les siens [R68].
- Attend : rien.

### K07 · Alertes : budget de l'IA, chute d'un indicateur, échéance d'un document d'agent
- Statut : fait (2026-10-28)
- Décidé (2026-10-28) : budget de l'IA sans valeur par défaut (pas d'alerte tant que la direction ne l'a pas réglé) ; baisse comparée en moyenne par jour, 7 jours jusqu'à la veille contre les 28 précédents, une alerte par indicateur et par semaine ; échéances des documents d'agent par une interface, branchée sur le dossier d'agent de M14 par K08.
- Reste : relecture de Codex impossible (limite d'usage, H03), fusion sur les vérifications (#121).
- Qui : Claude · Relecture : normale · Dépend de : K06
- Cahier : M13, « Alertes ».
- Objectif : une alerte à la direction quand le coût de l'IA du mois atteint 70 % du budget réglé, quand un indicateur du réseau baisse de plus du seuil réglé sur 7 jours par rapport aux 28 précédents, et avant l'échéance d'un document d'agent (lue par une interface de M14).
- Critères : une alerte par seuil et par période [R18] ; seuils en réglage, les mêmes pour tous [R25] ; aucune alerte sur la personne d'un agent, seulement sur des chiffres [R14].
- Attend : rien.

### K08 · Routes de M13, écran « Mes chiffres » et mesure contre le comptage manuel
- Statut : fait (2026-10-28)
- Décidé (2026-10-28) : export du jour lu dans le tableau de bord du réseau, honoraires des ventes du jour en euros ; pièces d'agent lues en lecture seule (dernière version signée, agents actifs, échues comprises) ; l'application n'admet que les agents (A01) : l'écran de la direction passe en K09 ; numéro de reversement gardant les tirets de l'identifiant (échec aléatoire de K02 au journal, corrigé).
- Reste : relecture de Codex impossible (limite d'usage, H03), fusion sur les vérifications (#125).
- Qui : Claude, voie 1 (fichiers du socle) · Relecture : forte · Dépend de : K01 à K07
- Cahier : M13 ; Feuille de route, juin 2027.
- Objectif : les routes `/v1/pilotage`, les passages au planificateur (rapport du matin, alertes, reversements), l'écran « Mes chiffres » dans l'application de l'agent et le tableau de bord de la direction ; un export quotidien des chiffres pour les comparer au comptage manuel pendant 2 semaines, comme le décrit `docs/MESURE.md`.
- Critères : chaque route sous R16, refus au journal ; écran accessible, sans texte générique, beau sur téléphone d'abord ; l'export du jour égale le tableau de bord.
- Attend : H27 pour la mesure réelle seulement.

### K09 · Écran « Le réseau » pour la direction
- Statut : fait (2026-10-28)
- Décidé (2026-10-28) : la direction arrive sur « Le réseau » à la connexion, la conformité et les partenaires restent refusés ; chaque total refait la somme de ses lignes à l’écran et dit un écart ; une facture s’émet en deux gestes ; l’export se télécharge avec la clé dans l’en-tête ; relecture forte : 1 P1 corrigé (clé refusée pendant l’export). Codex : aucune remarque.
- Qui : Claude, voie 1 (fichiers du socle) · Relecture : forte · Dépend de : K08
- Cahier : M13, « Tableau de bord du réseau » et « Alertes ».
- Objectif : la direction se connecte à l'application avec sa clé et retrouve, sur téléphone d'abord, le tableau de bord du réseau (par agent, zone, source, coûts de l'IA), ses alertes, les reversements à faire, les brouillons de factures à valider et le téléchargement de l'export du jour, par les routes `/v1/pilotage` de K08.
- Critères : un agent qui se connecte garde son écran actuel, sans rien du réseau [R68] ; la direction voit chaque total égal à la somme de ses lignes [R69], les agents listés par identifiant, jamais classés [R14] ; écran accessible, sans texte générique.
- Attend : rien.

**M14 · Réseau et académie, juillet 2027.**

Voie : 2

Découpé le 2026-10-28 par la voie 2. Ids `J..` pour Joindre le réseau. Cahier : M14 Réseau et académie ; Offre aux agents, « Le parrainage, dans les règles » et « L'essai de 30 jours » ; Feuille de route, juillet 2027 : « 3 personnes extérieures font tout le parcours de candidature » ; critères « un agent pilote fait seul son premier parcours complet, du contact à l'avis de valeur », « aucun accès aux clients avant un dossier d'agent complet », « un import test de 500 contacts depuis un export Hektor ou Excel, sans doublon et sans aucun message envoyé hors règles ».
Décidé, lecture prudente : un candidat n'est pas un client : il vit dans ses propres tables, jamais dans la fiche client. L'IA informe et organise, un humain nommé décide de chaque entrée : aucune note, aucun score, aucun classement, aucun tri de candidats, ni par l'IA ni par le code ; les candidatures se lisent dans l'ordre d'arrivée [R14, R81]. Aucun texte de recrutement (page, réponse de l'assistant, message à un candidat) ne promet de revenus : une liste fermée de tournures et tout montant par mois ou par an sont refusés [R80]. Le dossier d'agent liste des pièces par des règles écrites, chacune avec sa date de fin de validité saisie avec sa preuve (contrat d'agent commercial signé, attestation d'habilitation du titulaire de la carte, immatriculation au registre des agents commerciaux, assurance de responsabilité civile professionnelle, attestation de vigilance de moins de 6 mois) ; une pièce est une référence de stockage, jamais son contenu ; sans dossier complet et valide ce jour-là, aucun accès aux clients [R82]. Les modèles du contrat et de l'attestation viennent de M06 et attendent H08 : en attendant, ils sont générés en mode essai, marqués « projet ». Le parrainage ne paie qu'après une commission encaissée par le filleul, jamais à l'arrivée, sans frais d'entrée, sur un nombre de niveaux réglé (1 tant que l'avocat ne l'a pas fixé) [R83]. L'import des contacts d'un agent les range sans doublon, chacun trié par sa base légale, et n'envoie rien : un contact sans accord prouvé ne reçoit jamais de premier message [R03, R84]. Les heures de formation obligatoire sont comptées par le code depuis les présences et modules faits (réglages : 14 h par an, 42 h sur 3 ans dont 2 h de déontologie et 2 h de non-discrimination), avec alertes avant l'échéance ; l'académie n'impose aucun horaire [R85]. Au départ d'un agent : accès coupé le jour même, clients repris par la direction, rien effacé [R86, R17]. Les numéros de règles R80 à R89 et de migrations à partir de `0601` sont réservés à M14, pour ne jamais croiser la voie 1. Le code vit dans `packages/core/src/reseau/`, ses routes dans `packages/api/src/reseau.ts` ; les fichiers du socle (droits d'accès, `index.ts`, `app.ts`, planificateur, Worker) ne changent que par J13, confiée à la voie 1.

### J01 · Candidature et textes de recrutement sans promesse de revenus
- Statut : fait (2026-10-28)
- Reste : relecture de Codex restée en cours 27 min, fusion sans elle (#110) ; « gagner » n'est permis que dans « gagner du temps, des mandats, en autonomie, en confiance ».
- Qui : Claude · Relecture : forte · Dépend de : rien
- Cahier : M14, « Candidature » et « Règles » ; Offre aux agents, parrainage.
- Objectif : un candidat dépose sa candidature (prénom, nom, une coordonnée, commune, statut actuel et expérience déclarés, question libre, source : vidéo, podcast, page, parrain), avec son accord pour être recontacté au sujet de sa candidature et sa preuve ; elle est rangée dans `candidates`, une seule fois par coordonnée ; le contrôle des textes de recrutement refuse toute promesse de revenus.
- Critères : la table n'a aucun champ de note, de score ni de rang ; la liste des candidatures se lit dans l'ordre d'arrivée, sans autre tri [R81] ; une même coordonnée déposée deux fois ne fait qu'une candidature [R18] ; « gagnez », « revenus garantis », « jusqu'à 10 000 € », « 5 000 €/mois », « devenez riche », « liberté financière » et tout montant par mois ou par an sont refusés dans un texte de recrutement, sur 30 cas tests [R80] ; rien d'une coordonnée au journal [R13] ; sans accord, aucun message au candidat [R03].
- Attend : rien.

### J02 · Réponses de l'assistant aux questions des candidats
- Statut : fait (2026-10-28)
- Reste : relecture de Codex restée en cours 26 min, fusion sans elle (#112) ; l'envoi réel aux candidats passera par le contrôle central au branchement (J13).
- Qui : Claude · Relecture : normale · Dépend de : J01
- Cahier : M14, « Candidature » ; Intelligence artificielle, mention de l'assistant.
- Objectif : l'assistant répond aux questions d'un candidat seulement à partir de réponses écrites et datées par la direction (questions fréquentes : statut d'agent commercial, frais, essai de 30 jours, formation, parrainage) ; sans réponse écrite, il le dit et passe la question à un humain ; chaque réponse passe par le contrôle central, en mode essai.
- Critères : aucune réponse ne contient ce qui n'est pas dans une réponse écrite [R10] ; chaque réponse passe le contrôle de R80 ; le premier message porte la mention de l'assistant [R06] ; une question sur la rémunération renvoie à la grille écrite, jamais à un chiffre de revenu [R80] ; une question sans réponse écrite crée une tâche pour la direction.
- Attend : rien (réponses réelles écrites par Shawez plus tard, dans l'application).

### J03 · Entretien préparé à partir du déclaré, décidé par un humain
- Statut : fait (2026-10-28)
- Décidé (2026-10-28) : un entretien se fixe à une date à venir, puis est marqué tenu une fois la date passée, avec la personne qui l'a mené ; un « oui » exige un entretien tenu ; J04 lit seulement `acceptedIn`, jamais le motif.
- Qui : Claude · Relecture : forte · Dépend de : J01
- Cahier : M14, « Entretien » ; « L'IA et l'humain ».
- Objectif : pour chaque candidature, une fiche d'entretien préparée par le code : ce que le candidat a déclaré, les mêmes questions pour tous, les pièces qu'il devra fournir ; l'entretien est fixé, mené et décidé par un humain nommé, qui range sa décision (oui, non, à revoir) avec son motif écrit ; un oui ouvre le parcours d'intégration (J04).
- Critères : la fiche ne contient que le déclaré et la liste commune de questions, la même pour tous [R81] ; aucune décision sans un humain nommé et un motif [R81, R14] ; une décision rangée ne change plus, une nouvelle s'ajoute [R17] ; l'IA ne lit ni ne résume le candidat pour décider [R81] ; seule la direction lit les candidatures et décide [R16].
- Attend : rien.

### J04 · Dossier d'agent et parcours d'intégration pas à pas
- Statut : fait (2026-10-28)
- Décidé (2026-10-28) : l'identifiant de l'agent est tiré de sa candidature (une seule entrée) ; fin de validité obligatoire pour l'habilitation et l'assurance, facultative pour l'immatriculation, aucune pour le contrat, calculée pour la vigilance (6 mois moins un jour) ; un projet ne compte jamais et ne remplace pas une pièce signée.
- Reste : tant que J13 n'a pas branché `DossierAgent.complete` dans les droits, un agent entré a les droits d'un agent actif.
- Qui : Claude · Relecture : forte · Dépend de : J03
- Cahier : M14, « Intégration » ; Conformité ; Offre aux agents, « Ce que l'agent s'engage à faire ».
- Objectif : à l'entrée décidée, un dossier d'agent : la liste des pièces attendues par des règles écrites (contrat d'agent commercial signé, attestation d'habilitation, immatriculation, assurance de responsabilité civile professionnelle, attestation de vigilance), chacune rangée par sa référence de stockage avec sa date de fin de validité ; le parcours guidé dit l'étape suivante en une phrase ; `DossierAgent.complete(agentId, at)` dit si le dossier est complet et valide à cette date, et pourquoi sinon.
- Critères : un dossier sans une pièce, ou avec une pièce échue (attestation de vigilance de plus de 6 mois comprise), n'est jamais complet [R82] ; une pièce rangée ne change plus, une nouvelle version s'ajoute [R17] ; une pièce d'identité ou un RIB sont refusés comme pièce [R15] ; l'agent est prévenu 30 jours avant l'échéance d'une pièce ; le contrat et l'attestation générés par M06 portent « projet » tant que H08 n'est pas fait.
- Attend : rien pour la tâche ; H08 pour un contrat réel.

### J05 · Import des contacts et des biens de l'agent, triés selon la loi
- Statut : fait (2026-10-28)
- Décidé (2026-10-28) : un accord importé exige une date passée, une preuve qui ne dit pas l'absence et une finalité de liste fermée (prospection, alertes, suivi) ; un accord retiré ne revient jamais par un import ; une personne suivie par un autre agent ou sans agent va à la direction, seule sa désinscription y est rangée ; biens en brouillon, adresse jamais lue.
- Reste : relecture de Codex absente (limite d'usage, H03), fusion sans elle (#122).
- Qui : Claude · Relecture : forte · Dépend de : J04
- Cahier : M14, « Import de ses contacts et de ses biens » ; Conformité, consentement ; `docs/REPRISE.md`.
- Objectif : l'agent dépose un export Hektor, Apimo, Excel ou Google (CSV) ; chaque contact devient ou complète sa fiche, à cet agent, avec la source « import » ; chacun est trié : client avec un mandat ou une vente dans l'export, contact avec accord prouvé (date et preuve dans l'export), ou contact sans base, qui ne reçoit jamais de premier message ; les biens sont rangés comme biens de l'agent, jamais publiés ; un compte rendu dit les nombres et les lignes illisibles.
- Critères : sur un export test de 500 contacts inventés (Hektor et Excel), aucun doublon, relancé deux fois sans rien doubler [R84, R18] ; aucun message ne part à l'import, et un contact sans base n'est jamais contacté le premier [R03, R84] ; une fiche existante suivie par un autre agent n'est jamais reprise, elle va à la direction [R16] ; rien d'une coordonnée au journal [R13] ; aucun accord inventé.
- Attend : rien (vrais exports plus tard, hors du dépôt).

### J06 · Académie : parcours, modules et compteur des heures obligatoires
- Statut : fait (2026-10-28)
- Décidé (2026-10-28) : périodes comptées depuis le jour d'entrée de l'agent (année et 3 ans) ; une séance compte seulement avec une présence saisie par la direction après sa date ; une alerte au palier le plus proche atteint, une seule fois ; module de 8 h au plus.
- Reste : relecture de Codex absente (limite d'usage, H03), fusion sans elle (#123).
- Qui : Claude · Relecture : normale · Dépend de : J04
- Cahier : M14, « Académie », « Formation en salle », « Communauté ».
- Objectif : des modules courts (vidéo YouTube en accès restreint par sa référence, script, durée), rangés en parcours (entrée, puis par spécialité) ; les séances en salle, en direct, mensuelles et régionales avec la présence saisie par un humain ; le compteur des heures de formation obligatoire de chaque agent, par période, avec déontologie et non-discrimination à part ; alertes à l'agent avant l'échéance.
- Critères : le compteur ne compte que des modules faits et des présences rangées [R85, R10] ; sur 10 agents tests à horloge simulée, chaque manque est signalé 90 et 30 jours avant l'échéance [R85] ; l'académie n'impose aucun horaire et ne note pas l'agent [R14] ; seule la direction et l'agent lui-même lisent son compteur [R16].
- Attend : rien.

### J07 · Bac à sable du premier parcours (Jamais vu)
- Statut : fait (2026-10-28)
- Décidé (2026-10-28) : le bac à sable est une autre base (interface `SandboxStorage`), jamais celle du réseau ; ses modules n'ont que la boîte d'essai ; une étape compte seulement si son geste est rangé dans cette base ; le parcours fini compte au module d'académie réglé, retenté tant qu'il manque.
- Reste : J13 fournit la vraie base à part en production (D1 dédiée ou stockage par agent) ; relecture de Codex absente (limite d'usage, H03), fusion sans elle (#124).
- Qui : Claude · Relecture : forte · Dépend de : J04, J06
- Cahier : M14, critère « un agent pilote fait seul son premier parcours complet, du contact à l'avis de valeur » ; M02 à M05.
- Objectif : avant même son dossier complet, le nouvel agent reçoit un réseau d'entraînement à lui : des contacts, des biens et des ventes inventés, où il fait tout son premier parcours avec les vrais modules (contact reçu, qualification, rendez-vous, avis de valeur) ; rien n'en sort jamais ; chaque étape franchie est cochée par le code ; le parcours fini compte comme module de l'académie. Aucun réseau, logiciel ou outil d'IA grand public n'offre une copie fidèle et sans risque de son propre outil pour apprendre le métier.
- Critères : le bac à sable vit dans son propre réseau, sans aucune donnée réelle, et aucun envoi n'en sort, même mis en service [R82, R01-R04 par le contrôle central] ; le parcours complet se fait de bout en bout dans un test ; les étapes sont cochées par les événements du journal du bac à sable, jamais saisies ; l'agent ne voit aucun client réel tant que son dossier n'est pas complet [R82].
- Attend : rien.

### J08 · Entraînement aux objections avec l'IA, sur des cas inventés
- Statut : fait (2026-10-28)
- Décidé (2026-10-28) : le retour est écrit par le code (règles et points de script abordés ou non), jamais une note ; la direction ne lit que le temps ; la séance ne compte pas en heures obligatoires tant que la direction ne le règle pas.
- Reste : vraie IA avec H13 ; relecture de Codex absente (limite d'usage, H03), fusion sans elle (#126).
- Qui : Claude · Relecture : normale · Dépend de : J06
- Cahier : M14, « Académie » ; Intelligence artificielle.
- Objectif : l'agent s'entraîne contre l'IA qui joue un vendeur ou un acquéreur d'un cas inventé de la bibliothèque (objection sur les honoraires, l'exclusivité, le prix) ; le retour cite les règles et les scripts de l'académie ; la séance compte en temps d'académie, non en heures obligatoires sauf réglage.
- Critères : un cas ne contient aucune donnée de client : il est refusé s'il cite une coordonnée ou une fiche [R15] ; sans IA (H13), un texte de secours le dit et rien ne casse [R12] ; aucune note de l'agent n'est rangée ni montrée à la direction [R14] ; aucun texte ne promet de revenus [R80].
- Attend : rien (H13 pour la vraie IA).

### J09 · Référent des 90 jours, binôme d'absence et assistance suivie
- Statut : fait (2026-10-28)
- Qui : Claude · Relecture : normale · Dépend de : J04
- Cahier : M14, « Référent », « Assistance », « Binôme ».
- Objectif : la direction attribue un référent à chaque nouvel agent pour 90 jours ; deux agents forment un binôme avec un partage des honoraires écrit d'avance ; pendant une absence déclarée, le binôme lit les dossiers en cours de l'absent ; une demande d'assistance est suivie avec son délai (2 h ouvrées pour un humain, 48 h ouvrées pour l'avocat) et alerte la direction avant l'échéance.
- Critères : le binôme ne lit les dossiers que pendant l'absence déclarée, et plus rien après [R16] ; le partage est écrit avant l'absence et ne change plus [R17] ; les délais d'assistance sont calculés en heures ouvrées par le code ; aucune donnée de client dans une demande d'assistance passée à l'avocat sans nécessité [R15].
- Attend : rien.

### J10 · Parrainage dans les règles
- Statut : fait (2026-10-28)
- Décidé (2026-10-28) : le parrain est celui déclaré à la création de l'agent, sinon celui rangé par la direction, jamais deux différents ; un seul niveau, imposé jusque dans la base ; sans taux réglé, aucune prime ; un parrain parti ne garde que les primes déjà reversées.
- Qui : Claude · Relecture : forte · Dépend de : J04
- Cahier : Offre aux agents, « Le parrainage, dans les règles » ; M14, « Règles ».
- Objectif : le parrain d'un agent est rangé à l'entrée ; une prime de parrainage est calculée sur chaque commission réellement encaissée par le filleul, au taux réglé, sur le nombre de niveaux réglé ; elle est montrée au parrain, jamais promise d'avance.
- Critères : aucune prime à l'arrivée d'un agent ni sans commission encaissée [R83] ; aucun frais d'entrée nulle part [R83] ; au-delà du nombre de niveaux réglé (1 par défaut), aucune prime [R83] ; un parrain parti ne touche rien de nouveau ; aucun texte de parrainage ne promet de revenus [R80] ; 10 cas tests de commissions encaissées, avoirs compris.
- Attend : rien (taux et niveaux réels avec l'avocat, H09).

### J11 · Départ d'un agent
- Statut : fait (2026-10-28)
- Décidé (2026-10-28) : préavis légal L134-11 compté depuis le premier contrat signé du dossier ou la date saisie par la direction (la plus ancienne), prolongé jusqu'à la fin du mois civil ; plus court seulement pour faute grave ou accord commun, signalé ; l'indemnité de fin de contrat n'est jamais chiffrée, seulement dite « à examiner par l'avocat » (démission comprise, L134-13 2°) ; le jour du départ, clients, biens et projets passent au successeur accepté, sinon à la file de la direction ; un successeur est un agent du réseau déjà en activité.
- Qui : Claude · Relecture : forte · Dépend de : J04
- Cahier : M14, « Départ d'un agent ».
- Objectif : la direction range un départ (date, préavis, motif) ; le jour venu, l'agent passe à « parti », son accès est coupé, ses clients et biens vont à la direction pour être réattribués, ses commissions en cours sont listées pour être soldées, ses contenus personnels sont listés pour lui être rendus ; un successeur présenté est rangé, avec l'accord du réseau.
- Critères : à la date du départ, plus aucune lecture ni écriture de l'agent n'est permise [R86, R16] ; aucun client ni dossier n'est effacé [R17] ; aucun client ne reste sans agent ni sans file de la direction [R86] ; les relances et envois préparés par l'agent parti ne partent plus [R86].
- Attend : rien.

### J12 · Routes de M14 et page de candidature
- Statut : fait (2026-10-28)
- Décidé (2026-10-28) : la branche part de J09, J10 et J11 réunis (#127, #128, #130, non fusionnés tant que H28 bloque) ; les écrans de l'application sortent en J14, parce qu'ils vivent dans `packages/api/app/fichiers.ts`, que modifie aussi #129 (voie 1) ; le rôle est contrôlé par la route avant tout corps, la couche métier refait son contrôle derrière ; la page `/rejoindre` se ferme d'elle-même si un de ses textes échoue au contrôle de R80 (Jamais vu).
- Qui : Claude · Relecture : forte · Dépend de : J01 à J11
- Cahier : M14 ; Organisation, exigence de design (protocole, section 9).
- Objectif : les routes `/v1/reseau` (candidatures, entretiens, dossier d'agent, import, académie, binôme, parrainage, départ) dans `packages/api/src/reseau.ts` ; la page publique de candidature ; dans l'application, les écrans « Mon intégration », « Académie » et, pour la direction, « Candidatures ».
- Critères : chaque route sous R16, refus au journal ; un parcours de test de la candidature à l'agent au dossier complet, fait de bout en bout par 3 candidats inventés ; écrans accessibles, beaux sur téléphone d'abord, sans texte générique ; la page de candidature passe le contrôle de R80.
- Attend : rien.

### J13 · Branchement de M14 dans le socle
- Statut : fait (2026-10-28)
- Décidé (2026-10-28) : l'état de l'agent (`parti`, `dossier_incomplet`, `actif`) est lu par `app.ts` avant toute route et par `Acces` ; un agent sans aucun dossier (ni entrée par M14, ni pièce rangée), créé hors de M14, garde ses droits pendant la preuve à Dijon, la règle vaut pour toujours dès l'entrée ou la première pièce ; hors dossier complet, seules les routes d'intégration (`OPEN_WITHOUT_AGENT_FILE`) ; le contrôle des envois refuse ce qu'un agent parti a préparé ou validé (`preparedBy` : compte rendu, point de la semaine, remerciement) et, après la reprise, fait partir un suivi du système au nom de qui suit la fiche ; `reseau.passage` est la première tâche de chaque passage ; relecture forte 2 P1, Codex 3 P0 corrigés.
- Reste : `DossierAgent.admit` range l'agent puis son entrée en deux requêtes ; si la seconde échouait, l'agent garderait ses droits jusqu'à une nouvelle entrée (à regrouper dans un même lot).
- Qui : Claude, voie 1 (fichiers du socle : `packages/core/src/index.ts`, `packages/core/src/acces/`, `packages/api/src/app.ts`, `packages/api/src/planificateur.ts`, `packages/api/src/worker.ts`) · Relecture : forte · Dépend de : J12
- Cahier : M14 ; critère « aucun accès aux clients avant un dossier d'agent complet ».
- Objectif : exporter `reseau` depuis `@aimmo/core` ; ajouter les routes de M14 à `app.ts` ; dans les droits d'accès, refuser toute fiche client et tout bien non partagé à un agent dont `DossierAgent.complete` est faux ce jour-là, et à un agent parti ; dans les droits d'accès, lire `Departs.isGone` (vrai dès minuit le jour du départ, avant le passage du planificateur) ; dans le contrôle central des envois, refuser tout envoi dont `Departs.sendAllowed` est faux (agent du message ou agent qui l'a préparé) ; lancer `Departs.runDue` au planificateur ; lancer au planificateur les alertes d'échéances des pièces, du compteur de formation, de l'assistance et les départs du jour ; ajouter `reseauRoutes({ pieces, coach, sandbox })` de `packages/api/src/reseau.ts` aux routes de `app.ts`, et servir `/rejoindre` par `handleCandidature` avec la variable `CANDIDATURE_NETWORK_ID`, comme les autres pages publiques (mode essai, erreur au journal).
- Critères : un agent au dossier incomplet ou échu ne lit aucune fiche client [R82, R16] ; un agent parti ne lit plus rien le jour de son départ [R86] ; les passages tournent une fois par créneau ; rien ne part réellement tant que le plan ne l'a pas mis en service.
- Attend : rien.

### J14 · Écrans de M14 dans l'application
- Statut : à faire
- Qui : Claude, voie 2 · Relecture : forte · Dépend de : J12 ; après la fusion de #129 (K09, voie 1), qui modifie le même fichier `packages/api/app/fichiers.ts`
- Cahier : M14 ; Organisation, exigence de design (protocole, section 9).
- Objectif : dans l'application, les écrans « Mon intégration » (dossier d'agent pièce par pièce, référent, premier parcours), « Académie » (parcours, modules faits, compteur des heures) et, pour la direction, « Candidatures » (ordre d'arrivée, fiche d'entretien, décision nommée), lus par les routes de J12.
- Critères : chaque écran lit seulement par les routes `/v1/reseau`, refus montré sans rien garder [R16] ; la liste des candidatures n'a ni tri, ni filtre, ni note [R81] ; écrans accessibles (libellés, focus, lecteurs d'écran), beaux sur téléphone d'abord, sans texte générique ; testés comme les autres écrans (`fake-dom`).
- Attend : rien.
**M12 · Conformité, avant juillet 2027.**

Voie : 1

Découpé le 2026-10-28 par la voie 1. La Feuille de route pose M12 comme préalable de juillet 2027 (M14, M18) : la voie 1 le prend avant M18. Ids `L..` pour la Loi. Cahier : M12 Conformité ; Conformité, « Données personnelles » et « Anti-blanchiment » ; critères « un agent dont l'attestation expire perd l'accès aux clients le jour même » (porté par J04 et J13) et « une demande d'accès d'une personne reçoit sa réponse complète en moins d'un mois, avec preuve ».
Décidé, lecture prudente : M12 ne refait pas ce qui existe déjà (contrôle central des envois, exclusions et arrêts, mentions des annonces et des documents, registre des mandats, mention de l'assistant, dossier d'agent de M14) : il le relie. Le système bloque, enregistre, alerte et prépare ; le responsable de la conformité (rôle `compliance`) décide, déclare un soupçon et répond aux personnes ; aucune décision n'est prise par l'IA, aucune pièce d'identité ni aucun document anti-blanchiment ne lui est jamais envoyé [R15]. Le coffre est une référence de stockage derrière une interface (faux stockage dans les tests), jamais le contenu d'une pièce, et seul le responsable le lit, chaque lecture au journal. La fiche de risque est préparée par des règles écrites (type d'opération, montant, pays déclaré, personne politiquement exposée déclarée, paiement), jamais par l'IA, et ne compte que si le responsable la valide ; elle ne sert jamais à trier un client ni à refuser un service sans décision humaine [R14]. Un signalement fige le dossier et ne donne aucune information au client : aucun texte, aucune relance, aucun refus visible ne le trahit, et seul le responsable le voit. L'effacement ne passe que par la procédure de M12 (demande de la personne ou 3 ans sans contact ni consentement), garde ce que la loi oblige à garder (registre des mandats, anti-blanchiment, factures) et s'écrit au journal [R17] ; tant que le responsable n'est pas nommé (H29), l'effacement reste en mode essai : il liste ce qu'il effacerait et n'efface rien. Les numéros de règles R90 à R99 et de migrations à partir de `0701` sont réservés à M12. Le code vit dans `packages/core/src/conformite/`, ses routes dans `packages/api/src/conformite.ts`.

### L01 · Coffre de la conformité, réservé au responsable
- Statut : fait (2026-10-28)
- Décidé (2026-10-28) : le coffre lit toutes les fiches réunies (S04) ; une pièce d'identité déposée range aussi l'identité vérifiée de D03 ; un test refuse que tout autre fichier du code lise la table du coffre ; relecture forte : 1 P1 corrigé (fiches fusionnées).
- Qui : Claude, voie 1 · Relecture : forte · Dépend de : S08
- Cahier : M12, « Anti-blanchiment » et « Règles » ; Conformité, « Conservation des documents ».
- Objectif : un coffre séparé, dans ses propres tables, où l'agent dépose la référence d'une pièce d'identité ou d'un document anti-blanchiment vérifiée (sorte, personne, dossier, date de vérification, qui l'a vérifiée, empreinte), jamais son contenu ; seul le responsable de la conformité lit le coffre ; la fiche client et les autres modules n'en voient qu'un état : « identité vérifiée le <date> ».
- Critères : un agent dépose mais ne relit jamais une pièce, même la sienne ; la direction et les partenaires sont refusés ; chaque lecture et chaque refus au journal, sans donnée personnelle en clair [R16, R13, R90] ; aucun champ du coffre ne passe dans un texte, une fiche ou un appel à l'IA [R15] ; rien ne s'efface, une pièce remplacée reste au coffre [R17] ; Jamais vu : l'agent voit à l'écran ce qu'il a déposé disparaître de son téléphone au moment du dépôt, et la preuve de dépôt (empreinte et heure) lui reste.
- Attend : rien.

### L02 · Fiche de risque de chaque client, validée par le responsable
- Statut : fait (2026-10-28)
- Décidé (2026-10-28) : grille d'essai `essai-2026-10-28` en code ; sources : 4 déclarations fermées oui/non, état d'identité du coffre, montant de l'offre au registre ; le niveau est le plus haut des critères ; Jamais vu : rejeu de la fiche à l'identique ; relecture forte : 1 P1 corrigé (validation vérifiée au journal) ; Codex : 1 P1 corrigé (événements repris si le journal a manqué), nouvelle relecture demandée.
- Qui : Claude, voie 1 · Relecture : forte · Dépend de : L01
- Cahier : Conformité, « Classement écrit des risques et analyse de chaque client avant l'entrée en relation ».
- Objectif : à l'entrée en relation (mandat pour un vendeur, offre pour un acquéreur), une fiche de risque préparée par des règles écrites et datées, chaque critère avec sa source (déclaré, document, base) ; le responsable la valide ou la corrige, avec son nom et sa date.
- Critères : le même client donne toujours la même fiche avec les mêmes règles ; aucun critère n'est tiré par l'IA ni d'une donnée sensible [R23] ; une fiche non validée ne vaut rien et le dit ; la fiche ne trie aucun client et ne refuse rien seule [R14, R91] ; chaque fiche et chaque validation au journal.
- Attend : H29 pour la grille réelle ; une grille d'essai en attendant.

### L03 · Identification et bénéficiaire effectif, étape bloquante
- Statut : fait (2026-10-28)
- Décidé (2026-10-28) : identité lue au coffre (pièce vérifiée depuis un an au plus, valide ce jour-là, non remplacée) ; la case « pièce vue » de D03 ne suffit plus ; société reconnue à sa déclaration ou à un Kbis ou registre au coffre, redéclarée « personne » par le responsable seul ; mandat papier jugé au jour de sa signature ; relecture forte : 2 P1 corrigés.
- Qui : Claude, voie 1 (touche aux contrôles de M06 et M09) · Relecture : forte · Dépend de : L01, L02
- Cahier : Conformité, « Identification du client et du bénéficiaire effectif, au seuil de 25 % ».
- Objectif : ni mandat signé sans l'identité vérifiée du vendeur au coffre, ni compromis sans celle de chaque acquéreur ; pour une société, les bénéficiaires effectifs à 25 % ou plus, chacun identifié ; les contrôles de D03 et d'O07 lisent l'état du coffre au lieu d'une case cochée.
- Critères : un mandat ou un compromis sans pièce vérifiée et valide ce jour-là est refusé avec la règle [R58, R92] ; une société sans bénéficiaire effectif déclaré est refusée ; une pièce échue bloque comme une pièce absente ; les tests de D03 et d'O07 passent toujours.
- Attend : rien.

### L04 · Vigilance renforcée et origine des fonds
- Statut : fait (2026-10-28)
- Décidé (2026-10-28) : réglage d'essai `essai-2026-10-28` (écart 20 % autour de la fourchette du dernier avis validé, montant 1 000 000 €), réglé ensuite par le responsable, versionné ; déclarations lues sur la fiche de risque de L02 ; la demande d'origine des fonds n'est préparée pour l'agent qu'après la décision « origine des fonds demandée » du responsable ; alertes et décisions au journal sous la référence de l'alerte, jamais sous la fiche du client ; relecture forte : 2 P1 corrigés. L'examen automatique à l'inscription d'une offre et à la signature d'un mandat est à brancher en L09.
- Qui : Claude, voie 1 · Relecture : forte · Dépend de : L02
- Cahier : Conformité, « Vigilance renforcée : montant inhabituel, prix sans lien avec la valeur, personne politiquement exposée ».
- Objectif : des alertes au responsable par des règles écrites et réglables : prix d'une offre ou d'un mandat écarté de la fourchette d'estimation de M04 au-delà d'un seuil, montant au-dessus d'un seuil, personne politiquement exposée déclarée, paiement comptant déclaré ; la demande d'origine des fonds est préparée pour l'agent, la décision reste au responsable.
- Critères : chaque alerte cite sa règle et ses chiffres lus dans la base [R10, R93] ; l'alerte ne bloque ni ne refuse rien seule [R14] ; aucune alerte n'est visible du client ni de l'autre partie ; mêmes données, mêmes alertes.
- Attend : rien.

### L05 · Signaler au responsable : dossier figé, rien au client (Jamais vu)
- Statut : fait (2026-10-28)
- Décidé (2026-10-28) : signalement d'un dossier `mandate:`, `offer:` ou `sale_file:` ; copie figée par empreinte du dossier et de la conformité de chaque partie (fiches réunies et bénéficiaires effectifs compris) ; aucun autre code ne lit ses tables ; le filtre du journal écarte les empreintes SHA-256 ; relecture forte : 1 P1 corrigé ; Codex : 1 P0 et 1 P1 corrigés. Routes et écran en L09.
- Qui : Claude, voie 1 (touche au contrôle central des envois) · Relecture : forte · Dépend de : L01
- Cahier : Conformité, « Déclaration de soupçon à Tracfin, sans délai, même pour une tentative ».
- Objectif : un bouton « signaler au responsable » sur un dossier ; le dossier est figé (aucun changement, aucune pièce effacée), le responsable est alerté sans délai et décide seul de la déclaration ; Jamais vu : le contrôle central des envois garde le cours normal des messages déjà prévus et n'ajoute ni ne retire rien qui pourrait trahir le signalement, et un test prouve que le client voit exactement les mêmes textes, avec ou sans signalement.
- Critères : seul le responsable voit qu'un signalement existe, l'agent qui l'a fait voit seulement « transmis » [R16, R94] ; aucun texte au client ne cite le signalement, ni par l'IA ni par le code ; rien ne s'efface [R17] ; le signalement et la décision du responsable au journal.
- Attend : H29.

### L06 · Registre des traitements vérifié contre la base (Jamais vu)
- Statut : fait (2026-10-28)
- Décidé (2026-10-28) : registre en code (`conformite/registre-traitements.ts`), 17 traitements ; toute colonne de la base classée, personnelle à son traitement ou sans donnée personnelle ; toute forme de migration non lue arrête la vérification ; relecture au 2026-10-28 par défaut, échéance à 3 mois ; relecture forte : 2 P1 corrigés ; Codex : 3 P0 et 2 P2 corrigés. Appel quotidien de `RelectureRegistre.run` et écran en L09.
- Qui : Claude, voie 1 · Relecture : forte · Dépend de : rien
- Cahier : Conformité, « Base légale notée pour chaque traitement, dans un registre des traitements relu chaque trimestre » ; « Sous-traitants ».
- Objectif : le registre des traitements écrit dans le dépôt (finalité, base légale, données, durée, destinataires, sous-traitants), relié aux tables de la base ; Jamais vu : une vérification automatique échoue dès qu'une migration ajoute une table ou une colonne de donnée personnelle qui n'est pas au registre ; la date de la dernière relecture trimestrielle est un réglage, l'alerte part au responsable avant son échéance.
- Critères : chaque table de donnée personnelle des migrations figure au registre, avec sa base légale et sa durée [R95] ; une table de test ajoutée sans registre fait échouer le test ; l'alerte de relecture part 15 jours avant l'échéance, une seule fois.
- Attend : rien.

### L07 · Demandes des personnes en moins d'un mois, avec preuve
- Statut : fait (2026-10-29)
- Reste : fusionnée (#159) ; au journal du dossier de vente, chaque sorte classée par `SALE_FILE_EVENTS` et relevée par test, ce qui est fait pour un client porte sa fiche (`client`) ; relecture forte 1 P0 et 3 P1 corrigés ; Codex resté en cours plus de 30 min, fusion sans lui. Hors tâche : la marque « vendeur » d'un dossier vient de tout mandat du bien, un ancien mandant voit l'avancée partagée du dossier comme ses étapes ; les événements écrits avant #159 sans `client` ne vont à personne (mode essai).
- Reprise (2026-10-29) : classement par test de chaque sorte d'événement du dossier de vente. Avant : bloquée : au journal du dossier de vente, un événement sans `side` va par défaut à l'acquéreur (satisfaction du vendeur, 4e tour de Codex de la séance du 28/10 soir) ; corrigés dans cette séance : plan figé revérifié, état des lieux et exemplaire du bail au locataire, signatures et exemplaires de l'état des lieux à chaque partie, alertes du vendeur au vendeur, documents à deux parties « à examiner ». Reprise (#159, branche `chantier/L07`) : relever par test chaque type d'événement écrit sous `sale_file:` et le classer (acquéreur, vendeur, auteur, partagé), au lieu d'un défaut ; ajouter aussi `rental_sends` (W10) à la carte
- Reprise (2026-10-28) : `JOURNAL_SUBJECTS` et relevé testé des sujets (littéraux, fonctions d'aide, sujets construits), journal des biens possédés, masque des autres personnes au journal (`foreignPersons`), localisateurs par champ JSON (`jsonPath`) pour la candidature et la session de signature ; relecture forte 1 P0 et 1 P1 corrigés.
- Décidé (2026-10-28) : demandes enregistrées par le responsable seul ; échéance d'un mois par `addCalendarMonths`, rappel 7 jours avant et alerte le jour même ; carte des demandes d'accès vérifiée contre le registre (Jamais vu) ; lutte contre le blanchiment écartée (accès par la CNIL, article L561-45) ; effacement en essai, qui garde obligation légale, arrêt (identifiants sous empreinte) et lignes partagées « à examiner » ; demandes des agents, candidats et partenaires traitées à la main pour l'instant.
- Qui : Claude, voie 1 · Relecture : forte · Dépend de : L06
- Cahier : M12, critère « une demande d'accès d'une personne reçoit sa réponse complète en moins d'un mois, avec preuve » ; Conformité, « Droits des personnes ».
- Objectif : une demande (accès, rectification, effacement, opposition) enregistrée avec sa date et son canal, l'échéance d'un mois calculée par le code, les alertes au responsable avant l'échéance ; la réponse d'accès assemblée par le code depuis chaque table du registre (L06), avec son empreinte ; l'opposition passe par l'arrêt sur tous les canaux [R04] ; l'effacement par la procédure de M12, qui garde ce que la loi oblige à garder.
- Critères : une demande d'accès test produit une réponse qui contient chaque donnée de la personne dans chaque table du registre, et rien d'une autre personne [R96] ; échéance et alertes vérifiées jour par jour ; un effacement garde registre des mandats, anti-blanchiment et factures, et s'écrit au journal [R17] ; tant que H29 n'est pas fait, l'effacement est en mode essai et n'efface rien ; aucun envoi réel de la réponse tant que le plan ne l'a pas mis en service.
- Attend : H29 pour l'effacement réel.

### L08 · Prospects à 3 ans et procédure de fuite
- Statut : fait (2026-10-29)
- Décidé (2026-10-29), lecture prudente : le dernier contact est celui qui vient de la personne (message reçu, accord, projet, rendez-vous pris même annulé ou tenu, visite ; à défaut la création de la fiche), jamais un message envoyé ; un accord ancien compte comme un contact de son jour ; fiches réunies comptées ensemble ; 3 ans en jours de Paris par le calendrier ; jamais listés : mandat, acquéreur d'un dossier de vente, parties d'un bail, personne identifiée en L03 et bénéficiaires effectifs ; demande de consentement préparée sans canal ni envoi (signalée R04/R02 si arrêt ou exclusion), réponse attendue 30 jours, puis plan d'effacement de L07 en essai ; un cycle clos à tort (fusion défaite) ne retient pas la personne. Fuite : échéance en heures exactes, alertes à la connaissance, 24 h, 6 h et à l'échéance tant que la CNIL n'est pas prévenue et que l'évaluation n'est pas « aucun » ; évaluation en listes fermées, sans texte libre ; accès coupés par la direction ou le responsable, jamais les clés du responsable ; raison exigée pour une notification tardive.
- Reste : fusionnée (#168) ; relecture forte 2 P1, Codex 2 P1 et 3 P0 corrigés, dernière version sans relecture au bout de 15 min. Branchement en L09 ; effacement réel et envoi de la demande : H29.
- Qui : Claude, voie 1 · Relecture : forte · Dépend de : L07
- Cahier : Conformité, « Durées » et « Fuite de données ».
- Objectif : chaque jour, la liste des prospects arrivés à 3 ans après leur dernier contact sans consentement : demande de consentement préparée en mode essai, puis effacement par la procédure de L07 sans réponse ; une procédure de fuite : accès coupés d'un geste, évaluation saisie par le responsable, échéance de 72 heures pour la CNIL calculée par le code, liste des personnes concernées.
- Critères : un prospect contacté il y a 3 ans moins un jour n'est pas listé, à 3 ans il l'est [R97] ; un client sous mandat ou une vente close n'est jamais listé ; l'échéance de 72 heures et ses alertes vérifiées heure par heure ; rien n'est envoyé ni effacé réellement tant que le plan ne l'a pas mis en service [R26, R17].
- Attend : H29.

### L09 · Routes de M12, écran « Conformité » et branchement dans le socle
- Statut : en cours
- Où : proposition #175 ouverte, sans P0 ni P1 à la relecture forte ; fusion en attente des vérifications GitHub (H35). L'écran passe en L10 (défini sur la branche de #175) : en cours, proposition #178 empilée sur #175, fusion en attente de H35
- Qui : Claude, voie 1 (fichiers du socle) · Relecture : forte · Dépend de : L01 à L08
- Cahier : M12 ; Organisation, exigence de design (protocole, section 9).
- Objectif : les routes `/v1/conformite` dans `packages/api/src/conformite.ts`, dont le dépôt d'une pièce au coffre (`CoffreConformite.deposit`) et la déclaration personne ou société avec ses bénéficiaires effectifs (`Identification.declare`), seules portes de l'identification depuis L03 ; AIMMO ne se met pas en service entre L03 et L09 ; dans l'application, l'écran « Conformité » du responsable (fiches à valider, alertes, signalements, demandes et échéances, relecture du registre) et le dépôt d'une pièce par l'agent ; les passages au planificateur ; l'export depuis `@aimmo/core`.
- Ajouté par L08 : lire `Fuites.accessCut(networkId, role, userId)` avant toute route (refus au journal, le responsable jamais coupé) ; passages `DureesProspects.run` une fois par jour et `Fuites.run` à chaque créneau ; routes de `DureesProspects.list` et de `Fuites` (déclarer, couper, rétablir, évaluer, personnes concernées, notifications, alertes).
- Critères : chaque route sous R16, refus au journal ; un agent ne voit jamais l'écran du responsable ; écran accessible, beau sur téléphone d'abord, sans texte générique ; les passages tournent une fois par créneau.
- Attend : rien.

**M18 · Partenaires, juillet 2027.**

Voie : 2

Découpé le 2026-10-28 par la voie 2 : M14 n'a plus de tâche faisable par la voie 2 (J13 revient à la voie 1, J14 attend la fusion de #129), et M18 est le module de juillet 2027 qu'aucune voie n'a commencé. Ids `U..` pour Unir les partenaires. Cahier : M18 Partenaires ; Feuille de route, juillet 2027 : « 5 demandes à des partenaires suivies jusqu'au bout » ; critères « pièces rangées sans erreur », « un partenaire ne voit que les dossiers qui lui sont confiés », « aucune mise en relation sans accord enregistré du client ».
Décidé, lecture prudente : un partenaire est une personne de rôle `partner`, dans ses propres tables (annuaire), jamais une fiche client. Chaque partenaire a un métier pris dans une liste fermée (notaire, diagnostiqueur, courtier, artisan, déménageur, photographe, géomètre, gestionnaire titulaire de la carte G, avocat, expert-comptable, promoteur, expert du viager) et ses justificatifs exigés par métier (certification par domaine pour un diagnostiqueur, immatriculation ORIAS pour un courtier, carte G pour un gestionnaire, assurance pour tous), chacun avec sa date de fin de validité et sa preuve ; un justificatif est une référence de stockage, jamais son contenu. Un partenaire sans justificatif valide ce jour-là n'est proposé à personne [R73]. La mise en relation n'existe qu'après l'accord du client enregistré avec sa date et sa preuve [R74] ; le client choisit parmi plusieurs professionnels quand la zone en compte plusieurs : ils lui sont montrés dans un ordre tiré au sort et noté, jamais trié par une note, un avis ou l'IA ; le choix est fait par le client avec l'agent, jamais par l'IA ni par le code [R75, R14]. Aucune rémunération d'un diagnostiqueur, sous aucune forme ; aucune rémunération d'un courtier ou d'une banque tant que le statut requis n'est pas validé par l'avocat (réglage faux par défaut) ; toute autre rémunération est déclarée dans la mise en relation et montrée au client avant son accord [R76]. Un partenaire ne lit que les mises en relation qui lui sont confiées, et seulement le dossier utile de son métier, champ par champ, listé par des règles écrites [R77]. Une pièce déposée par un partenaire est rangée par sa sorte (diagnostic dans la fiche du bien, pièce du notaire dans le dossier de M10, accord de prêt dans le financement du dossier, devis dans la mise en relation) ; une pièce de sorte inconnue va à une file humaine, jamais rangée au hasard [R78]. La prospection de nouveaux partenaires se fait par mail, entre professionnels, à une adresse professionnelle, avec un plafond par jour ouvré (5), le lien d'opposition et l'arrêt sur tous les canaux à la première demande ; tout passe par le contrôle central des envois, en mode essai tant que le plan ne l'a pas mis en service [R79, R01, R02, R04]. Les relances aux partenaires partent dans les heures d'envoi [R01]. Les avis des clients sur un partenaire sont lus par un humain, jamais transformés en note ni en classement. Les offres négociées pour les agents (responsabilité civile, protection juridique, prévoyance) sont une page d'information sans commission pour le réseau, hors de ce découpage tant qu'aucun accord n'existe. Les numéros de règles R73 à R79 et de migrations à partir de `0801` sont réservés à M18. Le code vit dans `packages/core/src/partenaires/`, ses routes dans `packages/api/src/partenaires.ts` ; les fichiers du socle (droits d'accès, `index.ts`, `app.ts`, planificateur, Worker, contrôle central des envois) ne changent que par U09, confiée à la voie 1.

### U01 · Annuaire des partenaires par zone, justificatifs datés
- Statut : fait (2026-10-28)
- Reste : fusionnée (#135) après réunion de main, vérifications vertes, Codex sans remarque restante.
- Décidé (2026-10-28) : le mesurage n'exige que l'assurance ; chaque autre domaine de diagnostic exige sa certification ; une version plus récente, déjà commencée, qui chevauche une période la corrige ; un renouvellement à l'avance ne retire pas la version en cours.
- Qui : Claude, voie 2 · Relecture : forte · Dépend de : S08
- Cahier : M18, « Annuaire par zone » ; Données.
- Objectif : l'annuaire (migration `0801`) : partenaire, métier (liste fermée), zones (codes postaux ou communes), domaines (pour un diagnostiqueur : amiante, plomb, DPE, électricité, gaz, termites, mesurage), justificatifs exigés par métier, chacun avec sorte, numéro déclaré, date de fin de validité, référence de la preuve, qui l'a vérifié ; la recherche des partenaires proposables pour un métier, une zone, un domaine et un jour.
- Critères : un partenaire dont un justificatif exigé manque ou est échu ce jour-là n'est jamais proposable, et la raison est dite à l'agent [R73] ; un diagnostiqueur n'est proposable que pour les domaines couverts par une certification valide [R73] ; la recherche ne rend jamais de note, de rang ni d'avis [R14] ; rien ne s'efface, un justificatif remplacé reste [R17] ; chaque ajout et chaque vérification au journal [R13].
- Attend : rien.

### U02 · Mise en relation avec l'accord du client, choix du client
- Statut : fait (2026-10-28)
- Reste : fusionnée (#136) après réunion de main, vérifications vertes, Codex sans remarque restante.
- Décidé (2026-10-28) : la mise en relation part d'un projet du client ; tirage mulberry32 rejouable par sa graine ; preuve d'accord rangée sous `relations/<id>/`.
- Qui : Claude, voie 2 · Relecture : forte · Dépend de : U01
- Cahier : M18, « Mise en relation » et « Règles ».
- Objectif : la mise en relation (migration `0802`) : dossier (bien, mandat, dossier de vente ou projet), métier, partenaires proposés (ordre tiré au sort, graine notée), partenaire choisi, accord du client (date, canal, preuve), rémunération déclarée, état (proposée, acceptée par le client, confiée, en cours, terminée, abandonnée).
- Critères : aucune mise en relation n'est confiée sans accord du client enregistré avec sa date et sa preuve [R74] ; quand la zone compte au moins 2 partenaires proposables, au moins 2 sont montrés (réglage : 3 au plus) ; l'ordre est tiré au sort, rejouable par sa graine, jamais par une note ni un avis [R75] ; le choix est toujours celui d'un humain nommé, aucune fonction de l'IA ni du code ne choisit [R75] ; chaque changement d'état au journal.
- Attend : rien.

### U03 · Rémunérations des partenaires, déclarées ou refusées
- Statut : fait (2026-10-28)
- Reste : fusionnée (#137) après réunion de main, vérifications vertes, Codex sans remarque restante.
- Décidé (2026-10-28) : l'accord du client est refusé tant que le dernier texte montré ne cite pas toutes les rémunérations déclarées.
- Qui : Claude, voie 2 · Relecture : forte · Dépend de : U02
- Cahier : M18, « Règles » ; Conformité.
- Objectif : la déclaration de toute rémunération venant d'un partenaire dans sa mise en relation (sorte, montant ou taux, qui paie, à qui) et le texte montré au client avant son accord.
- Critères : toute rémunération venant d'un diagnostiqueur est refusée, sous toute forme (commission, cadeau, remise, prestation) [R76] ; toute rémunération d'un courtier ou d'une banque est refusée tant que le réglage du statut validé par l'avocat est faux [R76] ; une rémunération non déclarée ne peut pas être ajoutée après l'accord du client : il faut un nouvel accord [R76] ; le texte montré au client cite chaque rémunération et passe le contrôle des textes (aucune mention de l'IA, R06) ; chaque déclaration au journal.
- Attend : H31 pour rémunérer un courtier ou une banque ; refusé en attendant.

### U04 · Espace partenaire : le dossier utile, rien d'autre
- Statut : fait (2026-10-28)
- Reste : fusionnée (#138) après réunion de main, vérifications vertes, Codex sans remarque restante.
- Décidé (2026-10-28) : le nom du client va seulement au notaire, au courtier, au gestionnaire, à l'avocat et à l'expert-comptable ; la certification du domaine est revérifiée à chaque accès.
- Qui : Claude, voie 2 · Relecture : forte · Dépend de : U02
- Cahier : M18, « Espace partenaire » ; critère « un partenaire ne voit que les dossiers qui lui sont confiés ».
- Objectif : la lecture par un partenaire de ses mises en relation confiées et de leur dossier utile, défini par métier, champ par champ (un diagnostiqueur : adresse du bien, surface, année, domaines demandés, créneaux ; un notaire : parties et pièces du dossier de vente ; un courtier : projet de l'acquéreur avec son accord, sans autre donnée de la fiche) ; le partenaire indique où il en est.
- Critères : un partenaire ne lit jamais une mise en relation qui ne lui est pas confiée, ni une fois terminée au-delà du réglage (30 jours) [R77, R16] ; il ne reçoit que les champs listés pour son métier, testés champ par champ, jamais la fiche client entière ni une donnée sensible [R77, R23] ; chaque lecture et chaque refus au journal avant de rendre la donnée [R13] ; un partenaire dont un justificatif est échu est refusé [R73].
- Attend : rien.

### U05 · Pièces déposées par les partenaires, rangées d'elles-mêmes
- Statut : fait (2026-10-28)
- Reste : fusionnée (#140) après réunion de main, vérifications vertes, Codex sans remarque restante.
- Décidé (2026-10-28) : la place de la pièce est rangée avec elle ; diagnostic et bornage à la fiche du bien (le dossier de vente le lira en U09) ; une pièce ne va dans un dossier que si le client du projet y est partie.
- Qui : Claude, voie 2 · Relecture : forte · Dépend de : U04
- Cahier : M18, « Pièces rangées d'elles-mêmes » ; M10 ; M06.
- Objectif : le dépôt d'une pièce par un partenaire dans sa mise en relation (sorte, référence de stockage, empreinte, date) et son rangement : diagnostic dans la fiche du bien, pièce du notaire dans les pièces du dossier de vente de M10, accord de prêt dans le financement du dossier, devis dans la mise en relation.
- Critères : chaque sorte connue est rangée au bon endroit, testé pour chacune, sans erreur sur 5 demandes complètes [R78] ; une pièce de sorte inconnue, ou dont la sorte ne va pas avec le métier du déposant, va à la file de l'agent et n'est rangée nulle part [R78] ; un partenaire ne dépose que dans ses mises en relation confiées [R77] ; une pièce n'est jamais son contenu, seulement sa référence ; rien ne s'efface, une pièce remplacée reste [R17].
- Attend : rien.

### U06 · Pièce contrôlée contre le justificatif du jour où elle a été faite (Jamais vu)
- Statut : fait (2026-10-28)
- Reste : fusionnée (#141) après réunion de main, vérifications vertes, Codex sans remarque restante.
- Qui : Claude, voie 2 · Relecture : forte · Dépend de : U05
- Cahier : M18, « Annuaire par zone » et « Pièces rangées d'elles-mêmes ».
- Objectif : au dépôt, chaque pièce est contrôlée contre les justificatifs de son auteur à la date où elle a été faite, et non au jour du dépôt : un diagnostic contre la certification du domaine concerné, un accord de prêt contre l'immatriculation du courtier, une pièce de gestion contre la carte G.
- Critères : Jamais vu : un diagnostic fait à une date où la certification de son domaine était échue, ou d'un domaine que le diagnostiqueur ne couvre pas, est refusé au rangement et signalé à l'agent avec la raison, avant qu'il n'entre dans un dossier de vente [R78, R73] ; un diagnostic fait pendant la validité puis déposé après son échéance est accepté ; la décision est rejouable à l'identique ; aucune pièce n'est jugée par l'IA.
- Attend : rien.

### U07 · Suivi des demandes, relances et avis lus par un humain
- Statut : fait (2026-10-28)
- Reste : fusionnée (#144) ; relecture forte 2 P1 corrigés (jours ouvrés en dates de Paris, alerte au journal) ; Codex 2 P0 (sorte de pièce inconnue rendue neutre avant l'IA, délai borné de l'IA) et 1 P2 corrigés ; test instable de J05 rendu stable ; tables inscrites au registre de L06 [R95]. Relances préparées seulement, passage par le contrôle central en U09.
- Décidé (2026-10-28, voie 2) : un partenaire n'est pas une personne de la fiche client, et le contrôle central des envois (`ControleEnvois.send`) n'écrit qu'à une personne de la fiche : U07 range seulement les relances préparées dans une boîte de M18 (texte du code, date due dans les heures d'envoi, jamais deux fois la même), sans rien envoyer ; leur passage par le contrôle central (partenaire relié à une fiche de rôle partenaire, type d'envoi `partner`, plafond de R11) revient à U09, voie 1.
- Qui : Claude, voie 2 · Relecture : forte · Dépend de : U05
- Cahier : M18, « Suivi » ; L'IA et l'humain.
- Objectif : pour chaque mise en relation confiée : délai de réponse mesuré, relance préparée au partenaire après le réglage (2 jours ouvrés sans réponse), puis alerte à l'agent ; résumé des réponses par l'IA derrière une interface, avec un secours sans IA ; avis du client sur le service rendu, rangé pour lecture humaine.
- Critères : une relance part seulement dans les heures d'envoi et par le contrôle central des envois, en mode essai [R01, R79] ; jamais deux fois la même relance [R05] ; un avis n'est jamais transformé en note, en rang ni en tri des partenaires [R14, R75] ; le résumé de l'IA ne reçoit aucune donnée sensible et le secours sans IA rend la même structure [R15, R23] ; chaque relance et chaque alerte au journal.
- Attend : rien.

### U08 · Prospection de nouveaux partenaires entre professionnels
- Statut : fait (2026-10-28)
- Reste : fusionnée (#146) ; aucun accord fabriqué : chaque brouillon porte le refus du contrôle central (R03 tant que H32 n'est pas tranché) ; plafond tenu par la base, même pour deux passages ensemble ; relecture forte 2 P1 corrigés, Codex 2 P2 corrigés. R79 entre en service avec U09.
- Décidé (2026-10-28, voie 2) : tel qu'écrit, R03 exige un accord préalable pour tout premier mail d'initiative, prospection entre professionnels comprise ; tant que H32 n'est pas tranché, U08 prépare la liste et les mails en mode essai, et le contrôle les refuse sous R03. Rien ne part.
- Qui : Claude, voie 2 · Relecture : forte · Dépend de : U01
- Cahier : M18, « Nouveaux partenaires » et « État ».
- Objectif : la liste des partenaires à contacter (adresse professionnelle, métier, source publique), le mail de présentation préparé, le plafond par jour ouvré, l'opposition.
- Critères : au plus 5 premiers mails par jour ouvré (réglage), jamais deux fois à la même adresse [R79, R05] ; seulement une adresse professionnelle, jamais une adresse personnelle déclarée comme telle [R79] ; chaque mail a son lien d'opposition, et une opposition arrête tout sur tous les canaux [R79, R04, R02] ; tout passe par le contrôle central des envois en mode essai, rien ne part réellement [R79] ; le texte ne promet rien et ne parle pas de l'IA [R06].
- Attend : rien.

### U09 · Branchement de M18 dans le socle
- Statut : en cours
- Où : branche chantier/U09, empilée sur #178 tant que H35 bloque les fusions
- Qui : Claude, voie 1 (fichiers du socle : `packages/core/src/index.ts`, `packages/core/src/acces/`, `packages/api/src/app.ts`, `packages/api/src/planificateur.ts`, `packages/api/src/worker.ts`, contrôle central des envois) · Relecture : forte · Dépend de : U10
- Cahier : M18 ; Branchements.
- Objectif : exporter `partenaires` depuis `@aimmo/core` ; dans les droits d'accès, le rôle `partner` lit seulement ses mises en relation confiées (U04) et rien d'autre ; ajouter les routes de M18 à `app.ts` ; lancer au planificateur les relances, les alertes d'échéance des justificatifs et la prospection du jour.
- Critères : chaque brouillon de prospection (U08) et chaque relance préparée (U07) passe par `envoi/controle.ts` en mode essai, qui redécide au moment de l'envoi, et le refus sous R03 tient tant que H32 n'a pas écrit son exception dans R03 et dans `decideSend` ; un partenaire ne lit aucune fiche client, aucun bien et aucun dossier hors de ses mises en relation confiées [R77, R16] ; les passages tournent une fois par créneau ; rien ne part réellement tant que le plan ne l'a pas mis en service.
- Attend : rien.

### U10 · Routes de M18 et espace partenaire en ligne
- Statut : fait (2026-10-28)
- Reste : fusionnée (#147) ; relecture forte 1 P1 corrigé (date impossible stockée sans trace) ; Codex 2 P0 et 2 P2 corrigés dans la page (réponses dépassées ou d'une autre session ignorées, formulaire de dépôt vidé à chaque demande). Branchement des routes, de la page `/partenaire/`, de l'opposition `/partenaires/opposition/` et du stockage R2 des fichiers des partenaires revient à U09 (voie 1).
- Décidé (2026-10-28, voie 2) : le partenaire dépose le fichier lui-même ; le serveur contrôle accès, sorte et date avant de le stocker, choisit sa référence et calcule son empreinte ; sans stockage lié, 503 et rien n'est rangé.
- Qui : Claude, voie 2 · Relecture : forte · Dépend de : U01 à U08
- Cahier : M18 ; Organisation, exigence de design (protocole, section 9).
- Objectif : les routes `/v1/partenaires` (annuaire, mises en relation, accord du client, rémunérations, espace partenaire, dépôt de pièces, suivi, prospection) dans `packages/api/src/partenaires.ts` ; la page de l'espace partenaire, belle sur téléphone d'abord.
- Critères : chaque route sous R16, rôle contrôlé avant le corps, refus au journal ; un parcours de test de 5 demandes inventées (diagnostic, notaire, courtier, artisan, géomètre) suivies jusqu'au bout, pièces rangées sans erreur ; page accessible, sans texte générique.
- Attend : rien.

### U11 · Écrans de M18 dans l'application
- Statut : fait (2026-10-28)
- Reste : fusionnée (#163). Branchement des routes `/v1/partenaires/projets` et `/preuve-accord` par U09 (voie 1), avec `files` et `uploads` sur le même stockage pour que l'accord retrouve la preuve rangée ; la preuve d'un accord écrit est une note recopiée, le dépôt d'une photo du document viendra plus tard.
- Décidé (2026-10-28, voie 2) : l'agent note ce que le client a dit ; le serveur range la note comme preuve et donne son heure, que l'accord reprend ; prénom rendu seulement sous `decideAccess` (fiches réunies), chaque prénom un `fiche.lue` ; biens filtrés par les droits ; projets par pages de 50 ; relecture forte 1 P0 et 1 P1, Codex 1 P0 et 3 P2 corrigés.
- Qui : Claude, voie 2 · Relecture : forte · Dépend de : U10, Z03 (même fichier `packages/api/app/fichiers.ts`)
- Cahier : M18 ; Organisation, exigence de design (protocole, section 9).
- Objectif : dans l'application de l'agent, l'écran « Partenaires » : proposer au client (ordre tiré au sort), enregistrer son accord, suivre les demandes et les pièces.
- Critères : l'écran lit seulement par les routes `/v1/partenaires` [R16] ; aucune liste n'est triée par une note [R75] ; écran accessible, beau sur téléphone d'abord, testé comme les autres (`fake-dom`).
- Attend : rien.

**M15 · Louer, août 2027.**

Voie : 2

Découpé le 2026-10-28 par la voie 2 : M18 n'a plus de tâche faisable par la voie 2 (U09 est à la voie 1, U11 attend Z03), et M15 est le module d'août 2027 qu'aucune voie n'a commencé ; ses dépendances (M05, M06, M18) sont faites. Ids `W..` (bail). Cahier : M15 Louer ; Conformité, « Location » ; Feuille de route, août 2027 : « 3 mises en location tests : annonce conforme, honoraires sous le plafond, bail et état des lieux signés en ligne » ; critères « aucune pièce interdite demandée sur 20 candidatures tests », « un logement classé G est bloqué avant toute annonce », « le propriétaire voit les dossiers complets dans leur ordre d'arrivée, sans note ».
Décidé, lecture prudente : AIMMO fait la mise en location d'un logement, jamais la gestion locative ; il ne reçoit jamais ni loyer, ni dépôt de garantie, ni aucun fonds du locataire ou du propriétaire, et aucun champ ne le permet [R107]. Un logement n'est proposé à la location qu'après un contrôle écrit dans le code : classe énergie et date du bail (interdits : consommation au-delà de 450 kWh/m²/an en énergie finale depuis 2023, classe G depuis le 1er janvier 2025, F à partir du 1er janvier 2028, E à partir du 1er janvier 2034, pour tout nouveau bail ou reconduction), surface habitable d'au moins 9 m², annexes obligatoires présentes et valides ; un logement refusé reste bloqué, et le propriétaire reçoit, préparée en mode essai, l'échéance qui le concerne [R100, R101]. Les honoraires à la charge du locataire sont calculés par le code depuis la surface habitable et la zone de la commune (12 € par m² en zone très tendue, 10 € en zone tendue, 8 € ailleurs, plus 3 € par m² pour l'état des lieux d'entrée), jamais au-dessus du plafond ni de la part du bailleur ; la zone de chaque commune est une donnée de la base, rangée avec sa source et sa date, jamais écrite dans le code ; une commune sans zone connue prend le plafond le plus bas [R102]. L'annonce est rédigée par l'IA derrière une interface, avec secours sans IA ; ses mentions (loyer charges comprises, charges, honoraires du locataire, dépôt de garantie, surface, commune, classe énergie, complément de loyer s'il y en a) sont calculées par le code ; aucun critère discriminant dans le texte, contrôlé par une liste écrite [R103]. Le dépôt de garantie d'un logement vide ne dépasse pas un mois de loyer hors charges, celui d'un meublé deux mois [R102]. Le candidat et sa caution ne fournissent que les pièces de la liste officielle (décret du 5 novembre 2015), chacune une référence de stockage, jamais son contenu ; un lien DossierFacile est accepté tel quel ; l'IA vérifie seulement qu'un dossier est complet, par une liste écrite, jamais sa solvabilité [R104, R14]. Le propriétaire voit les seuls dossiers complets, dans leur ordre d'arrivée, sans note, sans rang, sans tri ni filtre sur un revenu ; son choix est le sien, enregistré avec sa date et sa preuve [R105]. Le bail (vide ou meublé) et ses annexes sont faits depuis les modèles datés de M06 et signés par la signature en ligne de D08, en mode essai tant que H08 et H24 ne sont pas faits. L'état des lieux se fait dans l'application : pièce par pièce, photos (références), relevés des compteurs, clés remises, signature des deux parties, un exemplaire chacun ; l'IA ne fait que mettre en forme le texte dicté, sans rien ajouter [R106]. La gestion locative est proposée par un partenaire de M18 titulaire de la carte G, par la mise en relation de M18 avec l'accord du propriétaire. Les numéros de règles R100 à R109 et de migrations à partir de `0901` sont réservés à M15 ; les vérifications (`scripts/garde-fous.mjs`) lisent les règles à trois chiffres dès W01. Le code vit dans `packages/core/src/location/`, ses routes dans `packages/api/src/location.ts` ; les fichiers du socle (droits d'accès, `index.ts`, `app.ts`, planificateur, Worker, contrôle central des envois, application de l'agent) ne changent que par W10, confiée à la voie 1.

### W01 · Logement contrôlé avant toute annonce, échéance du propriétaire
- Statut : fait (2026-10-28)
- Reste : fusionnée (#149) ; R100 et R101 en service ; relecture forte 1 P0 (bail daté du passé) et 1 P1 (lectures au journal) corrigés, Codex 1 P2 corrigé. `advertisable` sert à W03 et W06 ; l'échéance préparée passe par le contrôle central en W10.
- Décidé (2026-10-28, voie 2) : la classe énergie est jugée au plus tard du début du bail et du jour ; un début de bail dans le passé est refusé ; constat plomb tenu valable 6 ans même négatif.
- Qui : Claude, voie 2 · Relecture : forte · Dépend de : D02, P01
- Cahier : M15, « Contrôle du logement » ; Conformité, « Logements énergivores ».
- Objectif : la mise en location (migration `0901`) : logement, propriétaire (fiche de M01), vide ou meublé, loyer hors charges, charges, surface habitable, classe énergie et consommation, date de bail envisagée ; le contrôle du logement par des règles écrites ; l'échéance du propriétaire préparée en mode essai. Les vérifications lisent les règles à trois chiffres (`R100`).
- Critères : un logement classé G, ou au-delà de 450 kWh/m²/an, est bloqué avant toute annonce pour un bail commençant après le 1er janvier 2025 ; F bloqué pour un bail commençant à partir du 1er janvier 2028 ; E à partir du 1er janvier 2034, testé à la veille et au jour de chaque date [R100] ; une surface habitable sous 9 m² ou une annexe obligatoire manquante ou échue bloque, avec la raison dite à l'agent [R101] ; le propriétaire reçoit, préparée et jamais envoyée hors du contrôle central, la date à partir de laquelle son logement ne pourra plus être loué selon sa classe ; rien ne s'efface, chaque contrôle au journal [R17, R13] ; `npm run garde-fous` refuse une règle à trois chiffres en service sans test.
- Attend : rien.

### W02 · Honoraires du locataire et dépôt de garantie sous le plafond
- Statut : fait (2026-10-28)
- Reste : fusionnée (#150) ; R102 en service ; relecture forte 1 P0 (commune libre au barème) et 1 P1 (parts du bailleur en total) corrigés, Codex 1 P0 (lecture des plafonds au journal) corrigé. La liste officielle des zones tendues et très tendues reste à ranger dans `rental_zones` (par W09 depuis une source publique, ou par la direction) ; d'ici là, chaque commune prend 8 € par m².
- Décidé (2026-10-28, voie 2) : la commune du logement est fixée une fois par mise en location, contrôlée contre le département du code postal du bien ; la part du locataire est comparée à celle du bailleur séparément pour visite-dossier-bail et pour l'état des lieux.
- Qui : Claude, voie 2 · Relecture : forte · Dépend de : W01
- Cahier : M15, « Mandat de location » ; Conformité, « Honoraires de location ».
- Objectif : les zones des communes (migration `0902`, donnée de la base avec source et date) ; le calcul des honoraires du locataire et du bailleur ; le dépôt de garantie.
- Critères : la part du locataire (visite, dossier, bail) ne dépasse jamais 12, 10 ou 8 € par m² habitable selon la zone, ni l'état des lieux 3 € par m², ni la part du bailleur, testé aux bornes [R102] ; une commune sans zone connue prend 8 € [R102] ; le dépôt de garantie ne dépasse pas un mois de loyer hors charges pour un logement vide, deux pour un meublé [R102] ; les montants sont calculés en centimes par le code, jamais par l'IA ; un barème au-delà du plafond est refusé à l'enregistrement.
- Attend : rien.

### W03 · Annonce de location conforme
- Statut : fait (2026-10-28)
- Reste : fusionnée (#151) ; R103 en service ; relecture forte 1 P0 et 4 P1 corrigés (tournures de santé, de famille et de garant, classe climat, formule de l'énergie, mode des charges), Codex 2 P0 corrigés (sigles à points, vide ou meublé contre les faits). `publishable` sert à la diffusion ; le complément de loyer (communes à loyer encadré) n'est pas proposé.
- Décidé (2026-10-28, voie 2) : aucune annonce sans dépenses d'énergie dans la fiche du bien, avec une classe de la fiche différente de celle de la mise en location, ni sans mode des charges ; un logement vide n'est jamais au forfait.
- Qui : Claude, voie 2 · Relecture : forte · Dépend de : W02, P03
- Cahier : M15, « Annonce » ; L'IA et l'humain.
- Objectif : l'annonce de location rédigée par l'IA derrière une interface, avec secours sans IA de même forme, validée par l'agent ; ses mentions calculées par le code.
- Critères : l'annonce n'existe que pour un logement passé au contrôle de W01 [R100] ; chaque mention obligatoire (loyer charges comprises, charges, honoraires du locataire, dépôt de garantie, surface habitable, commune, classe énergie) vient des données et figure dans le texte publié, testé mention par mention ; aucun critère discriminant (liste écrite : origine, nationalité, situation de famille, âge, sexe, handicap, état de santé, religion, garant obligatoirement en France, « CDI exigé », etc.) dans le texte de l'IA ni de l'agent [R103] ; aucune mention de l'IA [R06] ; rien n'est publié sans validation de l'agent.
- Attend : rien.

### W04 · Candidatures limitées aux pièces de la liste officielle
- Statut : fait (2026-10-28)
- Reste : fusionnée (#153) ; R104 en service ; relecture forte 1 P0 (annexe II de la caution) et 2 P1 corrigés ; la relecture de Codex tournait encore au bout de 20 minutes, fusion sur vérifications vertes. Migration `0904` (et non `0903`, prise par W03) ; l'état des lieux de W07 prendra `0905`.
- Décidé (2026-10-28, voie 2) : la pièce d'identité du candidat et de chaque garant ne vit qu'au coffre de la conformité (L01), la candidature lit l'état « identité vérifiée » ; la caution d'une personne morale n'est pas encore proposée ; aucune IA dans la complétude.
- Qui : Claude, voie 2 · Relecture : forte · Dépend de : W01
- Cahier : M15, « Candidatures » ; Conformité, « Pièces du candidat ».
- Objectif : la candidature (migration `0903`) : candidat (fiche de M01), cautions, pièces rangées par sorte (liste officielle, une pièce d'identité, un justificatif de domicile, d'activité, de ressources, pour le candidat et chaque caution), lien DossierFacile, date d'arrivée, complétude vérifiée par une liste écrite.
- Critères : aucune pièce hors de la liste officielle n'est demandée ni acceptée, sur 20 candidatures tests, testé sorte par sorte (relevé de compte, attestation de bonne tenue de compte, photo, carte vitale, dossier médical, extrait de casier, chèque de réservation, etc. refusés) [R104] ; un lien DossierFacile vaut dossier sans autre pièce [R104] ; la complétude est dite par la liste écrite ; l'IA éventuelle ne reçoit aucune pièce et ne rend que « complet » ou les sortes manquantes, jamais un avis sur la solvabilité [R14, R15] ; une pièce n'est jamais son contenu, seulement sa référence.
- Attend : rien.

### W05 · Dossiers montrés au propriétaire dans leur ordre d'arrivée, reçu d'équité (Jamais vu)
- Statut : fait (2026-10-28)
- Reste : fusionnée (#154) ; R105 en service ; relecture forte 3 P1 corrigés (pièces du garant dans le reçu, reçus rejouables, reçus des dossiers incomplets), Codex 1 P1 et 1 P2 corrigés (reçus sans dossier complet, référence de vérification sans chiffre). Les reçus préparés passent par le contrôle central en W10.
- Décidé (2026-10-28, voie 2) : le propriétaire voit chaque dossier par son rang d'arrivée, ses pièces et ses garants, sans le nom du candidat ; chaque candidat, présenté ou encore incomplet, reçoit son reçu d'équité ; un seul choix par mise en location.
- Qui : Claude, voie 2 · Relecture : forte · Dépend de : W04
- Cahier : M15, « Présentation au propriétaire » ; Conformité, « Non-discrimination ».
- Objectif : la présentation des dossiers complets au propriétaire et l'enregistrement de son choix ; le reçu d'équité.
- Critères : le propriétaire ne voit que les dossiers complets, dans leur ordre d'arrivée, sans note, rang, tri ni filtre sur un revenu ou une autre donnée [R105, R14] ; son choix est enregistré avec sa date et sa preuve, jamais fait par le code ni l'IA [R105] ; Jamais vu : chaque candidat reçoit, préparé en mode essai, un reçu d'équité qui liste les seules pièces qui lui ont été demandées, sa date d'arrivée et la règle de présentation, rejouable à l'identique depuis le journal ; le propriétaire reçoit la même preuve que l'ordre montré est celui des arrivées [R105, R104].
- Attend : rien.

### W06 · Bail et annexes depuis les modèles, signés en ligne
- Statut : fait (2026-10-28)
- Reste : fusionnée (#155) ; relecture forte faite, Codex 4 P0 et 2 P1 corrigés (annexes jointes par leur référence, total du locataire avec l'état des lieux, libellé « agent immobilier », bail caduc quand un diagnostic est remplacé, noms lus sous les droits des fiches [R16], prénom et nom exigés [R40]). Signature en mode essai tant que H08 et H24 ne sont pas faits ; l'état des lieux et l'inventaire du meublé sont établis par W07.
- Qui : Claude, voie 2 · Relecture : forte · Dépend de : W05, D08
- Cahier : M15, « Bail et annexes » ; Conformité, « Bail et état des lieux ».
- Objectif : le bail vide ou meublé et ses annexes faits depuis les modèles datés de M06 (D02) avec les données de la mise en location, signés par la signature en ligne de D08, en mode essai.
- Critères : le bail ne se fait que pour le candidat choisi par le propriétaire [R105] ; chaque annexe obligatoire est jointe ou le bail est refusé [R101] ; loyer, charges, dépôt et honoraires viennent des données contrôlées par W02 [R102] ; le modèle utilisé est celui en vigueur à la date du bail ; signature en mode essai tant que H08 et H24 ne sont pas faits.
- Attend : H08 et H24 pour un usage réel ; en mode essai d'ici là.

### W07 · État des lieux dans l'application, signé par les deux parties
- Statut : fait (2026-10-28)
- Reste : fusionnée (#157) ; R106 en service ; migration `0907` (0904 était pris). Relecture forte 1 P0 (contrôle par listes noires seulement) et 1 P1 (commune vide) corrigés ; Codex 2 P0 (fidélité hors listes, exemplaires non atomiques) et 2 P1 (photos hors empreinte, correction pendant la clôture) corrigés ; dernière relecture de Codex encore en cours après 20 minutes, fusion sans elle. `closedInventory` sert à W08 ; l'envoi des exemplaires par le contrôle central est dans W10.
- Décidé (2026-10-28, voie 2) : l'IA ne peut qu'ajouter ou ôter articles et liaisons ; tout autre changement (mot, ordre, accent, pluriel, nombre, négation, saut de ligne) fait prendre le secours. Les signatures sont tracées à l'écran devant l'agent, empreinte seule gardée ; un état des lieux ne se signe que complet (noms, domicile du bailleur, adresse et commune, chaque pièce, compteurs, clés, mobilier d'un meublé).
- Qui : Claude, voie 2 · Relecture : forte · Dépend de : W06
- Cahier : M15, « État des lieux » ; L'IA et l'humain.
- Objectif : l'état des lieux d'entrée (migration `0904`) : pièce par pièce, éléments et état, photos (références), relevés des compteurs, clés remises, texte dicté mis en forme par l'IA derrière une interface avec secours, signature des deux parties, un exemplaire chacun.
- Critères : l'état des lieux n'est clos qu'avec la signature des deux parties et chaque pièce renseignée [R106] ; l'IA ne fait que mettre en forme : le texte rendu ne contient aucun élément, état ni chiffre absent du dicté, sinon le secours est pris [R106] ; chaque partie reçoit le même exemplaire, de même empreinte [R106] ; rien ne s'efface, une correction est une nouvelle version avant signature [R17].
- Attend : rien.

### W12 · Signature en ligne du bail par D08, en mode essai
- Statut : fait (2026-10-28)
- Reste : fusionnée (#160) ; R108 en service ; migration `0909`. Relecture forte 2 P1 corrigés (remise impossible après un changement de faits, conformité qui lisait l'exemplaire) ; Codex 1 P0 corrigé (fiches des signataires), 1 P0 réfuté et corrigé dans le texte (le canal n'a pas de pièce jointe : l'avis porte la référence et l'empreinte, l'agent remet l'exemplaire) ; dernière version validée par Codex (« Didn't find any major issues », b99ac9d).
- Décidé (2026-10-28, voie 2) : `REAL_LEASE_SIGNATURE` reste faux dans le code jusqu'à une tâche du plan après H08 et H24 ; `signedAt` (W08) ne rend donc rien de réel ; le parcours d'essai (W09) lit `trialState()`, jamais branché sur la remise des clés réelle (W10) ; l'envoi du document lui-même attend H05 et W10.
- Qui : Claude, voie 2 · Relecture : forte · Dépend de : W06, D08
- Cahier : M15, « Bail et annexes » ; M06, « Signature électronique AIMMO ».
- Objectif : faire signer le bail en vigueur (W06) par le bailleur et le locataire choisi avec la signature en ligne de D08, en mode essai ; ajoutée le 2026-10-28 par la voie 2, car W06 l'avait renvoyée à une tâche qui n'existait pas au plan.
- Critères : fournit `LeaseSignatureState.signedAt` à W08 (remise des clés, honoraires dus) ; seul le bail en vigueur et complet se signe [R101, R105] ; chaque partie signe l'empreinte du bail ; un bail remplacé après une signature demande de nouvelles signatures ; tant que H08 et H24 ne sont pas faits, la signature ne rend jamais un bail signé réel ; chaque partie reçoit le même exemplaire par le contrôle central.
- Attend : H08 et H24 pour un usage réel ; en mode essai d'ici là.

### W08 · Remise des clés sans argent pour AIMMO, gestion par un partenaire carte G
- Statut : fait (2026-10-28)
- Reste : fusionnée (#158) ; R107 en service ; migration `0908`. Relecture forte 1 P1 (état des lieux clos sous un autre bail) corrigé ; Codex 1 P2 (date impossible) corrigé. La signature du bail est lue par l'interface `LeaseSignatureState`, à fournir par W12 ; d'ici là, aucune remise des clés ni aucun honoraire dû en vrai.
- Décidé (2026-10-28, voie 2) : les honoraires sont la rémunération de l'agence, pas des fonds tenus pour autrui (R107), facturés par K02 ; un état des lieux clos vaut pour son seul bail, un nouveau bail en vigueur demande le sien.
- Qui : Claude, voie 2 · Relecture : forte · Dépend de : W07, U02
- Cahier : M15, « Remise des clés » ; Conformité, « Argent du locataire ».
- Objectif : la remise des clés : dépôt de garantie et premier loyer déclarés versés directement au propriétaire ; honoraires dus à la signature du bail ; proposition de gestion locative par un partenaire de M18 titulaire de la carte G.
- Critères : aucune table, aucune route et aucun texte ne fait recevoir par AIMMO un loyer ou un dépôt de garantie ; un compte bancaire d'AIMMO n'est jamais proposé au locataire [R107] ; la gestion locative passe par la mise en relation de M18, avec l'accord du propriétaire, à un partenaire dont la carte G est valide ce jour [R74, R73] ; les honoraires ne sont dus qu'une fois le bail signé.
- Attend : rien.

### W09 · Routes de M15 et parcours de 3 mises en location tests
- Statut : fait (2026-10-28)
- Reste : fusionnée (#162). Routes dans `packages/api/src/location.ts`, à brancher dans `app.ts` par W10 (voie 1) avec ses services (`identity` = coffre de conformité, `files` = stockage, IA facultatives). Relecture forte 1 P1 corrigé (R16 essayé sur chaque route et chaque rôle) ; Codex resté en cours 20 min, fusion sans lui.
- Décidé (2026-10-28, voie 2) : la remise des clés des routes lit `signedAt` (signature réelle), jamais `trialState()` ; aucun partenaire n'est admis sur `/v1/location`.
- Qui : Claude, voie 2 · Relecture : forte · Dépend de : W01 à W08
- Cahier : M15 ; Feuille de route, août 2027.
- Objectif : les routes `/v1/location` dans `packages/api/src/location.ts` ; le parcours de 3 mises en location tests de bout en bout.
- Critères : chaque route sous R16, rôle contrôlé avant le corps, refus au journal ; 3 mises en location inventées (vide en zone tendue, meublé hors zone, logement classé F dont le bail commence avant 2028) menées jusqu'à l'état des lieux signé, annonce conforme, honoraires sous le plafond ; un logement classé G bloqué avant toute annonce ; 20 candidatures inventées sans aucune pièce interdite.
- Attend : rien.

### W10 · Branchement de M15 dans le socle
- Statut : fait (2026-10-29)
- Décidé (2026-10-29) : routes de M15 servies par le socle, fermées (503) sans le stockage `PIECES`, identité lue au coffre (son état seul) ; passage `location.envois` de 9 h à 19 h ; accord demandé : `suivi_location` par mail ; seuls exclusion, arrêt, doublon et départ de l'agent qui a préparé refusent pour de bon (R02, R04, R05, R86), tout autre refus attend (heure, accord, adresse) ; texte devenu faux (classe corrigée, présentation refaite) jamais envoyé tant qu'il reste faux ; prénom lu sur la fiche réunie ; parenthèses des libellés officiels mises en incise à l'envoi.
- Reste : rien ne range encore l'accord `suivi_location` (à prévoir dans W11 ou au mandat de location) ; `rental_sends` à ajouter à la carte des demandes d'accès à la reprise de L07 ; relecture forte 2 P1, Codex 1 P0 et 4 P2 corrigés (#164).
- Qui : Claude, voie 1 (fichiers du socle) · Relecture : forte · Dépend de : W09
- Cahier : M15 ; Branchements.
- Objectif : exporter `location` depuis `@aimmo/core` ; ajouter ses routes à `app.ts` ; lancer au planificateur les échéances des propriétaires ; passer les textes préparés par le contrôle central des envois, en mode essai.
- Critères : chaque texte préparé (échéance, reçu d'équité) passe par `envoi/controle.ts`, qui redécide au moment de l'envoi ; les passages tournent une fois par créneau ; rien ne part réellement tant que le plan ne l'a pas mis en service.
- Attend : rien.

### W11 · Écrans de M15 dans l'application
- Statut : fait (2026-10-29)
- Reste : fusionnée (#165). Ajouter une candidature depuis l'écran (elle part de la fiche de la personne) ; déposer depuis le téléphone une annexe, une preuve ou la notice au lieu de saisir sa référence rangée ; relire le texte du bail après réouverture (lecture du bail sous les droits des deux fiches).
- Décidé (2026-10-29, voie 2) : lectures `GET /location`, `/location/:id/suivi`, `/location/:id/presentation` ; l'état des lieux en cours (qui porte les noms des parties) n'est rendu qu'à qui voit les deux fiches en entier ; aucun état d'élément choisi d'avance ; textes du bail et séances de signature effacés à la sortie ; relecture forte 2 P1 et un trou de test corrigés, Codex 2 P0 et 2 P2 corrigés, dernière version validée par Codex (le script d’attente ne l’a pas vu).
- Qui : Claude, voie 2 · Relecture : forte · Dépend de : W09, Z03 (même fichier `packages/api/app/fichiers.ts`)
- Cahier : M15 ; exigence de design (protocole, section 9).
- Objectif : dans l'application de l'agent, l'écran « Louer » : contrôle du logement, annonce, candidatures dans leur ordre d'arrivée, bail, état des lieux pièce par pièce sur téléphone.
- Critères : l'écran lit seulement par les routes `/v1/location` [R16] ; aucune liste de candidats n'est triée ni notée [R105] ; écran accessible, beau sur téléphone d'abord, testé comme les autres (`fake-dom`).
- Attend : rien.

**M17 · Investir, septembre 2027.**

Voie : 2

Découpé le 2026-10-29 par la voie 2 : M15 est fini (W11 fusionnée) ; septembre 2027 compte M16 et M17, M16 est laissé à la voie 1 qui suit le plan dans l'ordre, M17 n'est commencé par aucune voie ; ses dépendances (M04, M06, M15) sont faites. Ids `Y..`. Cahier : M17 Investir ; Feuille de route, septembre 2027 : « Rendement de 10 biens identique au calcul manuel » ; critères « chaque note affiche ses sources et ses hypothèses », « un bien classé G porte l'alerte avant toute proposition à un investisseur qui veut louer ».
Décidé, lecture prudente : un investisseur est une personne de la fiche client avec un projet de type `invest` ; son profil (budget, apport déclaré, location visée vide, meublée ou colocation, secteurs, rendement attendu, délai) est rangé en listes fermées et en nombres, versionné, chaque champ avec sa source, jamais inventé ; aucune évaluation de sa solvabilité, aucun champ de revenus, de patrimoine ni de crédit [R123, R14]. Le rendement est calculé par le code seul, en centimes et en points de base, par des formules écrites (brut = loyer annuel de marché / coût total ; net avant impôt = loyer annuel moins charges non récupérables, taxe foncière déclarée, provision pour vacance réglée / coût total ; coût total = prix + frais d'acquisition + travaux estimés), jamais par l'IA ; chaque chiffre rendu porte sa source, sa date et l'hypothèse qui l'a fait [R120, R121]. Le loyer de marché est une estimation lue dans une table de la base : la Carte des loyers de l'ANIL (indicateur par commune, intervalle de prévision, nombre d'observations, millésime), importée par la direction avec sa source et sa date, ou, à défaut, les loyers des mises en location du réseau (M15) quand il y en a au moins 5 dans la commune sur 24 mois ; jamais écrit dans le code ni appelé en direct ; une commune à peu d'observations ou dont l'intervalle est large le dit dans la note ; la source est citée telle que l'ANIL la demande, « Estimations ANIL, à partir des données du Groupe SeLoger et de leboncoin » [R122]. Les contraintes (classe énergie et date d'interdiction de louer de M15, copropriété, règle de la commune rangée par la direction avec sa source) sont signalées sur chaque calcul ; un bien classé G (ou au-delà du seuil de consommation) porte l'alerte avant toute proposition à un investisseur qui veut louer, et aucune alerte ni note ne le propose sans elle [R124, R100]. Aucun texte n'est un conseil fiscal ni financier personnalisé ni une promesse de rendement : une liste fermée de tournures (« garanti », « sans risque », « assuré », « défiscalisation », « vous devriez », etc.) est refusée, et chaque note renvoie à un professionnel habilité pour la fiscalité et le financement [R125]. La note d'investissement est rédigée par l'IA derrière une interface, à partir du calcul seul, chaque nombre de la note relié à un champ du calcul, avec secours sans IA ; elle n'est montrée au client qu'après validation par l'agent [R126]. Les alertes de biens du fichier commun ne partent qu'aux investisseurs qui les ont demandées (accord rangé), par le contrôle central des envois, en mode essai [R03, R26]. Après l'achat : mise en location par M15 et partenaires de M18 par leur mise en relation, rien de neuf. Les numéros de règles R120 à R129 et de migrations à partir de `1101` sont réservés à M17 (R110 à R119 et `1001` restent pour M16). Le code vit dans `packages/core/src/investir/`, ses routes dans `packages/api/src/investir.ts` ; les fichiers du socle (droits d'accès, `index.ts`, `app.ts`, planificateur, Worker, contrôle central des envois) ne changent que par Y08, confiée à la voie 1.

### Y01 · Profil investisseur, sans solvabilité
- Statut : fait (2026-10-29)
- Qui : Claude, voie 2 · Relecture : forte · Dépend de : rien (M02, M03 faits)
- Cahier : M17, « Profil investisseur », « Règles ».
- Objectif : le profil d'un projet `invest` (migration `1101`) : budget en centimes, apport déclaré, location visée (vide, meublée, colocation), secteurs (codes INSEE), rendement brut attendu en points de base, délai (liste fermée) ; chaque version rangée avec sa source par champ (`agent`, `client_dit`, `qualification`) ; sous les droits de la fiche [R16].
- Critères : un champ inconnu ou hors liste est refusé, jamais ignoré ; aucun champ de revenus, d'emploi, de patrimoine, de crédit ni de solvabilité n'existe dans la table ni dans l'entrée (test qui énumère les colonnes) [R123] ; une version ne change plus, la suivante la remplace [R17] ; un autre agent est refusé, au journal [R16].
- Attend : rien.

### Y02 · Loyers de marché importés, avec source, date et fiabilité
- Statut : fait (2026-10-29)
- Reste : suite des remarques P2 de Codex (guillemets du CSV, reprises simultanées) en #176, en attente de GitHub Actions (H35)
- Qui : Claude, voie 2 · Relecture : forte · Dépend de : Y01
- Cahier : M17, « Rendement calculé par le code », « Règles », « Branchements ».
- Objectif : la table des loyers de marché (migration `1102`) : commune, type (appartement, maison, par nombre de pièces quand le millésime le donne), loyer au m² charges comprises, bornes de l'intervalle de prévision, nombre d'observations, millésime, source ; import par la direction d'un fichier CSV au format de la Carte des loyers de l'ANIL (jeu de test inventé), versionné, rien effacé ; repli sur les loyers des mises en location du réseau (au moins 5 dans la commune sur 24 mois, réglage) ; la réponse dit toujours sa source et sa fiabilité (« peu d'observations » sous 30 observations ou intervalle plus large que 40 % du loyer, réglages).
- Critères : un loyer n'est jamais écrit dans le code ni lu en direct sur Internet [R122] ; un fichier mal formé est refusé ligne à ligne sans rien ranger ; la mention de source ANIL est exactement celle demandée [R122] ; sans donnée, la réponse est « inconnu », jamais une valeur inventée [R10].
- Attend : H34 pour la mise en service (fichier réel de la Carte des loyers) ; les tests n’en ont pas besoin.

### Y03 · Rendement brut et net calculé par le code, chaque chiffre avec son hypothèse
- Statut : fait (2026-10-29)
- Qui : Claude, voie 2 · Relecture : forte · Dépend de : Y02
- Cahier : M17, « Rendement calculé par le code » ; Feuille de route, septembre 2027.
- Objectif : le calcul d'un bien pour un profil : prix (du bien ou saisi), frais d'acquisition (barème réglé, ancien ou neuf), travaux estimés (saisis avec leur source, ou issus de M04), loyer de marché (Y02) × surface, charges non récupérables et taxe foncière déclarées, vacance réglée (en mois par an) ; rendement brut et net avant impôt en points de base, arrondis par une règle écrite ; chaque ligne du résultat porte `value`, `source`, `asOf`, `hypothesis` ; le calcul est rangé, rejouable à l'identique depuis ses entrées [R120, R121].
- Critères : 10 biens tests inventés donnent au centime et au point de base près les rendements d'un calcul fait à la main, écrit dans le test ligne par ligne [R120] ; une entrée manquante rend « incomplet » avec la liste de ce qui manque, jamais un rendement [R10] ; aucun appel à l'IA dans le calcul [R121] ; aucun impôt ni régime fiscal n'est calculé [R125].
- Attend : rien.

### Y04 · Contraintes signalées : énergie, copropriété, règles de la commune
- Statut : fait (2026-10-29)
- Qui : Claude, voie 2 · Relecture : forte · Dépend de : Y03
- Cahier : M17, « Contraintes signalées » ; M15 (règles d'énergie).
- Objectif : sur chaque calcul, les contraintes : classe énergie et date d'interdiction de louer, par le code de M15 (`banDate`, seuil de 450 kWh/m²/an), copropriété (lue dans la fiche du bien de M07), règle de la commune (autorisation préalable de mise en location, permis de louer, encadrement des loyers, changement d'usage) rangée par la direction avec sa source et sa date (migration `1104`, `1103` prise par les calculs de Y03), jamais écrite dans le code.
- Critères : un bien classé G, ou au-delà du seuil, porte l'alerte « interdit à la location » avant toute proposition à un investisseur dont la location visée n'est pas « aucune » ; aucune note, aucune alerte, aucune proposition ne peut être faite sans cette alerte (test sur chaque chemin) [R124, R100] ; F et E portent leur date à venir ; une règle de commune sans source est refusée.
- Attend : rien.

### Y05 · Note d'investissement par l'IA, validée par l'agent (Jamais vu)
- Statut : fait (2026-10-29)
- Qui : Claude, voie 2 · Relecture : forte · Dépend de : Y04
- Cahier : M17, « Note d'investissement », « L'IA et l'humain », « Règles ».
- Objectif : la note rédigée par l'IA derrière une interface, avec secours sans IA, à partir du seul calcul et de ses contraintes ; **Jamais vu** : chaque nombre et chaque affirmation de la note est relié à une ligne du calcul (valeur, source, date, hypothèse), et la note rend, sous chaque paragraphe, la preuve de ses chiffres ; changer une hypothèse (vacance, travaux, loyer bas ou haut de l'intervalle) recalcule la note entière, et la fourchette basse/haute du rendement est toujours montrée à côté du chiffre central ; validation par l'agent seul avant tout envoi.
- Critères : un nombre absent du calcul, une tournure de la liste fermée (promesse, conseil fiscal ou financier personnalisé) ou une note sans sources ni hypothèses est refusée, et le secours prend le relais [R125, R126] ; la note cite la mention ANIL exacte quand le loyer vient de l'ANIL, et dit « peu d'observations » quand c'est le cas [R122] ; la note renvoie à un expert-comptable pour la fiscalité et à un courtier pour le financement [R125] ; la note d'un bien classé G porte l'alerte en tête [R124].
- Attend : rien (IA derrière une interface, faux dans les tests ; H13 pour l'IA réelle).

### Y06 · Alertes aux investisseurs qui les ont demandées
- Statut : fait (2026-10-29)
- Qui : Claude, voie 2 · Relecture : forte · Dépend de : Y05
- Cahier : M17, « Alertes » ; M08 (alertes aux acquéreurs).
- Objectif : quand un bien diffusable du fichier commun correspond au profil (secteur, budget, location visée, rendement brut attendu calculé par Y03), un texte d'alerte est préparé pour les seuls investisseurs dont l'accord aux alertes est rangé, avec le calcul et ses contraintes ; il passe par le contrôle central des envois, en mode essai.
- Critères : aucune alerte sans accord rangé [R03] ; un bien classé G n'est jamais proposé sans l'alerte, et jamais à un investisseur qui veut louer sans elle [R124] ; jamais deux fois le même bien à la même personne [R05] ; le texte passe le contrôle des tournures [R125] ; rien ne part réellement [R26].
- Attend : rien.

### Y07 · Routes de M17 et parcours de 10 biens tests
- Statut : en cours (voie 2)
- Avancement (2026-10-29) : proposition #173 prête (relecture forte sans P0 ni P1, 1 P0 de Codex corrigé), en attente de ses vérifications : GitHub Actions ne démarre plus (facturation, H35). À fusionner dès que « Vérifier » passe et que Codex ne relève plus rien.
- Qui : Claude, voie 2 · Relecture : forte · Dépend de : Y06
- Cahier : M17 ; Architecture technique, API.
- Objectif : `packages/api/src/investir.ts` : routes `/v1/investir` (profil, import des loyers par la direction, calcul, contraintes, note, validation, alertes), rôle contrôlé avant le corps, refus au journal ; parcours de bout en bout de 10 biens tests ; après l'achat, ouverture de la mise en location de M15 et proposition de partenaires de M18 par leurs routes existantes.
- Critères : chaque route refuse tout rôle non admis avant de lire le corps [R16] ; les 10 biens tests rendent les rendements du calcul manuel [R120] ; chaque note rendue affiche sources et hypothèses [R126].
- Attend : rien.

### Y08 · Branchement de M17 dans le socle
- Statut : à faire
- Qui : Claude, voie 1 (fichiers du socle) · Relecture : forte · Dépend de : Y07
- Cahier : M17 ; Branchements.
- Objectif : exporter `investir` depuis `@aimmo/core` ; ajouter ses routes à `app.ts` ; lancer au planificateur le passage des alertes aux investisseurs ; passer leurs textes par `envoi/controle.ts`, en mode essai.
- Critères : chaque alerte redécidée au moment de l'envoi par le contrôle central ; un passage par créneau ; rien ne part réellement tant que le plan ne l'a pas mis en service.
- Attend : rien.

### Y09 · Écran « Investir » dans l'application
- Statut : en cours (voie 2)
- Avancement (2026-10-29) : fait sur la branche `chantier/Y09` (bâtie sur Y07), suite complète verte en local, relecture forte : 1 P1 corrigé (biens relus un par un par la couche d'accès, R82). Reste : ouvrir la proposition après la fusion de Y07. Le budget de l'application (48 Ko compressés) est presque plein : l'écran a été allégé pour tenir.
- Qui : Claude, voie 2 · Relecture : forte · Dépend de : Y07
- Cahier : M17 ; exigence de design (protocole, section 9).
- Objectif : dans l'application de l'agent, l'écran « Investir » : profil, calcul d'un bien avec ses lignes et leurs sources, curseurs d'hypothèses (vacance, travaux, loyer bas ou haut), contraintes, note à relire et valider.
- Critères : l'écran lit seulement par les routes `/v1/investir` [R16] ; aucun chiffre n'est calculé sur le téléphone, tout vient du code du serveur [R121] ; l'alerte d'un bien classé G est en tête [R124] ; écran accessible, beau sur téléphone d'abord, testé comme les autres (`fake-dom`).
- Attend : rien.

**M19 · Studio, octobre 2027.**

Voie : 2

Découpé le 2026-10-29 par la voie 2 : M17 est fini côté voie 2 (Y08 attend la voie 1) ; octobre 2027 compte M19 et M20 complet, M16 reste à la voie 1, M19 n'est commencé par aucune voie ; ses dépendances (M07, M18) sont faites. Ids `X..`. Cahier : M19 Studio ; critères « 10 biens photographiés avec le guide, sans photographe, validés par Shawez », « une vidéo de bien montée seule sur un téléphone en moins de 10 minutes », « aucune adresse visible sur 20 visuels publiés ».
Décidé, lecture prudente : tout traitement d'image et tout montage se fait sur l'appareil de l'agent, jamais sur un serveur ; le serveur ne reçoit que des références de stockage, des empreintes et des descriptions contrôlées. Une photo ne reçoit que des corrections globales prises dans une liste fermée (exposition, balance des blancs, contraste, redressement des verticales, netteté, recadrage), décrites et rangées avec l'empreinte de l'original, qui reste gardé : aucune retouche locale, aucun effacement [R130]. L'aménagement virtuel garde sa mention sur l'image (R48, M07). Aucune adresse visible ni personne reconnaissable sans son accord rangé : chaque visuel passe une liste de contrôle validée par l'agent, et les textes (sous-titres, légendes, supports) passent le contrôle d'adresse de M07 [R132, R46]. Musiques et images seulement d'une bibliothèque dont la licence est rangée par la direction [R133]. Une publication est rédigée par l'IA derrière une interface avec secours, validée par l'agent, et part en mode essai par des canaux derrière une interface ; Meta, YouTube, Google et TikTok attendent leurs accès (H06, H07) [R134, R26]. Le plan du logement est indicatif : surfaces calculées par le code depuis les cotes saisies, mention « plan indicatif, non contractuel » [R135]. Les options payantes passent par la mise en relation de M18, rien de neuf. Les règles R130 à R139 et les migrations à partir de `1201` sont réservées à M19. Le code vit dans `packages/core/src/studio/`, ses routes dans `packages/api/src/studio.ts` ; les fichiers du socle ne changent que par X10, confiée à la voie 1.

### X01 · Guide de prise de vue pièce par pièce
- Statut : en cours (voie 2)
- Avancement (2026-10-29) : proposition #174 prête, suite complète verte en local, relecture forte 2 P1 corrigés ; en attente des vérifications GitHub (H35). Migration `1201` prise par X01 : X02 à X07 prennent `1202` et suivantes.
- Qui : Claude, voie 2 · Relecture : forte · Dépend de : rien (M07 fait)
- Cahier : M19, « Guide de prise de vue » ; critère « 10 biens photographiés avec le guide ».
- Objectif : à partir de la fiche du bien de M07 (type, pièces, extérieurs), la liste des vues à faire, pièce par pièce, chacune avec sa consigne (où se placer, hauteur, lumière) écrite dans le code en liste fermée, et les vues à ne pas oublier ; l'avancement du bien : vues rangées (références de stockage de M07), vues manquantes, bien « prêt » quand toutes les vues obligatoires sont là ; la validation par Shawez (direction) d'un bien photographié avec le guide est rangée.
- Critères : chaque pièce de la fiche a ses vues et sa consigne (test sur les types de biens) ; une vue obligatoire manquante empêche « prêt » ; rien n'est inventé sur le bien [R10] ; sous les droits du bien [R16] ; la validation par la direction est rangée, une fois [R17].
- Attend : rien.

### X02 · Photos corrigées honnêtement, avec leur certificat (Jamais vu)
- Statut : en cours (voie 2)
- Avancement (2026-10-29) : proposition #177 prête, empilée sur X01 (#174), migration `1202` ; suite complète verte en local (1746), relecture forte 2 P1 corrigés ; en attente des vérifications GitHub (H35). Branchement dans la publication par X05 et X10. X03 prend `1203`, X04 `1204`, X05 `1205`.
- Qui : Claude, voie 2 · Relecture : forte · Dépend de : X01
- Cahier : M19, « Photos corrigées sur le téléphone », « Règles ».
- Objectif : la description des corrections faites sur l'appareil, rangée avec l'empreinte de l'original et celle du résultat (migration `1201`) ; **Jamais vu** : chaque photo publiée porte un certificat d'honnêteté lisible par le client (original gardé, liste des corrections globales, aucune retouche locale), vérifiable par un lien sans donnée personnelle.
- Critères : une opération hors de la liste fermée, ou une retouche locale, est refusée et la photo ne peut pas être publiée [R130] ; une photo sans original rangé ne se publie pas [R130] ; un aménagement virtuel garde sa mention (R48) ; le certificat ne porte ni adresse ni nom [R46, R13].
- Attend : rien.

### X03 · Montage vidéo sur l'appareil à partir d'un modèle
- Statut : à faire
- Qui : Claude, voie 2 · Relecture : forte · Dépend de : X02
- Cahier : M19, « Vidéo du bien » ; M07 (plan de tournage, P06) ; critère « montée seule en moins de 10 minutes ».
- Objectif : le modèle de montage décrit par le code depuis le plan de tournage de P06 (ordre des plans, durées, sous-titres tirés de la fiche, musique de la bibliothèque, fin à la marque de l'agent) ; le montage se fait sur l'appareil ; le serveur range la description du montage fini et contrôle ses textes et sa musique (migration `1203`).
- Critères : une musique sans licence rangée est refusée [R133] ; un sous-titre qui porte une adresse est refusé [R46, R132] ; aucun fichier vidéo ne passe par le serveur, seule sa référence [R130] ; le modèle tient en 10 minutes de montage (test sur la durée prévue et le nombre de gestes).
- Attend : rien.

### X04 · Plan simple du logement depuis les mesures
- Statut : en cours (voie 2)
- Qui : Claude, voie 2 · Relecture : normale · Dépend de : X01
- Cahier : M19, « Plan simple du logement ».
- Objectif : des pièces rectangulaires saisies avec leurs cotes en centimètres et leur position, versionnées (migration `1204`) ; un plan SVG dessiné par le code, surfaces calculées par le code, mention « plan indicatif, non contractuel ».
- Critères : surfaces au cm² près d'un calcul fait à la main sur 5 plans tests [R135] ; une cote absente ou impossible est refusée [R10] ; le SVG ne porte ni adresse ni nom [R46] ; la mention est toujours là [R135].
- Attend : rien.

### X05 · Publications prêtes pour chaque bien, visite, offre, vente
- Statut : à faire
- Qui : Claude, voie 2 · Relecture : forte · Dépend de : X02
- Cahier : M19, « Réseaux sociaux », « L'IA et l'humain » ; M07.
- Objectif : à chaque événement (nouveau bien diffusable, visite, offre, vente), une publication préparée : texte par l'IA derrière une interface avec secours, visuels choisis parmi les photos certifiées, liste de contrôle des visuels (adresse visible, personne reconnaissable et son accord, aménagement virtuel) validée par l'agent ; publication en un geste vers les comptes de l'agent et du réseau, en mode essai, derrière une interface par réseau (migration `1205`).
- Critères : rien ne part sans la validation de l'agent [R134] ; un visuel sans liste de contrôle validée, ou avec une personne reconnaissable sans accord rangé, est refusé [R132] ; le texte passe le contrôle de M07 (adresse, mots interdits) [R46] ; un bien qui ne peut plus être diffusé ne part pas [R42] ; rien ne part réellement [R26].
- Attend : H06 et H07 pour les accès réels ; les tests n'en ont pas besoin.

### X06 · Supports imprimés à sa marque
- Statut : à faire
- Qui : Claude, voie 2 · Relecture : normale · Dépend de : X02
- Cahier : M19, « Supports imprimés ».
- Objectif : fiche du bien, panneau, flyer, carte de visite et lettre de quartier, rendus par le code en pages imprimables (A4, A5, carte) sur le système de design, depuis la version publiée du bien et la fiche de l'agent, avec les mentions obligatoires de M07.
- Critères : chaque support passe le contrôle du système de design et d'accessibilité [R201] ; aucun support ne porte d'adresse exacte [R46] ; prix et mentions viennent de la version publiée [R44, R43] ; impression vérifiée sous Chromium comme P05.
- Attend : rien.

### X07 · Bibliothèque de musiques et d'images sous licence
- Statut : à faire
- Qui : Claude, voie 2 · Relecture : normale · Dépend de : rien
- Cahier : M19, « Règles ».
- Objectif : la bibliothèque du réseau (migration `1205`) : chaque musique ou image avec sa source, sa licence, sa date et la preuve rangée par la direction ; X03 et X05 n'utilisent qu'elle.
- Critères : une entrée sans licence ni preuve est refusée [R133] ; une licence expirée ou retirée retire l'entrée des choix, sans rien effacer [R17] ; seule la direction range [R16].
- Attend : la liste réelle des musiques retenues par Shawez pour la mise en service ; les tests n'en ont pas besoin.

### X08 · Options payantes par les partenaires, et mesure des 20 visuels
- Statut : à faire
- Qui : Claude, voie 2 · Relecture : normale · Dépend de : X05
- Cahier : M19, « Options payantes » ; M18 ; critère « aucune adresse visible sur 20 visuels publiés ».
- Objectif : la demande d'une option (photographe, drone, visite virtuelle, aménagement virtuel) passe par la mise en relation de M18, rien de neuf ; la mesure des 20 derniers visuels publiés : chacun avec sa liste de contrôle validée, le compte rendu montré à la direction.
- Critères : aucune option hors de M18 (accord du client, rémunération déclarée) [R74] ; la mesure compte 20 visuels et dit chacun sans adresse visible, ou le nomme [R132].
- Attend : rien.

### X09 · Routes de M19
- Statut : à faire
- Qui : Claude, voie 2 · Relecture : forte · Dépend de : X08
- Cahier : M19 ; Architecture technique, API.
- Objectif : `packages/api/src/studio.ts` : routes `/v1/studio` (guide, corrections et certificat, montage, plan, publications et validation, supports, bibliothèque), rôle contrôlé avant le corps, refus au journal ; certificat public sans donnée personnelle.
- Critères : chaque route refuse tout rôle non admis avant de lire le corps [R16] ; parcours de 10 biens tests du guide à la publication en essai [R134].
- Attend : rien.

### X10 · Branchement de M19 dans le socle
- Statut : à faire
- Qui : Claude, voie 1 (fichiers du socle) · Relecture : forte · Dépend de : X09
- Cahier : M19 ; Branchements.
- Objectif : exporter `studio` depuis `@aimmo/core` ; ajouter ses routes à `app.ts` ; la page publique du certificat sur le Worker ; publications par le contrôle central, en mode essai.
- Critères : rien ne part réellement tant que le plan ne l'a pas mis en service ; la page du certificat passe le système de design [R201].
- Attend : rien.

### X11 · Écran « Studio » dans l'application
- Statut : à faire
- Qui : Claude, voie 2 · Relecture : forte · Dépend de : X09
- Cahier : M19 ; exigence de design (protocole, section 9).
- Objectif : dans l'application de l'agent, l'écran « Studio » : guide pièce par pièce avec l'appareil photo, corrections globales sur l'appareil, montage depuis le modèle, plan, publications à valider ; tout traitement sur l'appareil.
- Critères : l'écran lit seulement par les routes `/v1/studio` [R16] ; aucune image ni vidéo n'est envoyée à un serveur pour traitement [R130] ; écran accessible, beau sur téléphone d'abord, dans le budget de l'application (qui est presque plein : une passe d'allègement peut être nécessaire), testé comme les autres (`fake-dom`).
- Attend : rien.
