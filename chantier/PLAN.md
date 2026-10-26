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
- Statut : à faire
- Qui : Claude · Relecture : forte · Dépend de : S03
- Cahier : Feuille de route, novembre 2026 ; Architecture technique, fiche client unique.
- Objectif : normaliser les identifiants (téléphone au format international, mail en minuscules, comptes de réseaux), repérer les doublons, fusionner deux fiches en gardant tout l'historique, et pouvoir défaire une fusion.
- Critères : sur un jeu inventé de 50 fiches avec doublons connus, 50 sur 50 bien regroupées ; une fusion se défait ; rien n'est effacé [R17].

### S05 · Exclusions, arrêts, accords et horaires
- Statut : à faire
- Qui : Claude · Relecture : forte · Dépend de : S04
- Cahier : Conformité, prospection et accords ; Risques, décision « Réponses le soir et le dimanche ».
- Objectif : une décision unique « peut-on écrire à cette personne, sur ce canal, pour ce type de message, maintenant ? », avec la règle qui a décidé.
- Critères : un test par règle et par cas limite : samedi 19 h 59 et 20 h 00, dimanche, réponse à un message reçu il y a 59 et 61 minutes, personne exclue qui écrit, demande d'arrêt sur un canal puis envoi sur un autre ; R01 à R04 et R11 passent en service.

### S06 · Contrôle central des envois
- Statut : à faire
- Qui : Claude · Relecture : forte · Dépend de : S05
- Cahier : Architecture technique, contrôle central des envois ; Intelligence artificielle, garde-fous ; Conformité, mention de l'assistant.
- Objectif : le seul chemin de sortie de tout message. Il applique la décision de S05, l'anti-doublon, la mention du premier message, le contrôle du texte, le texte de secours, et écrit tout au journal. Les canaux sont des interfaces avec de faux canaux pour les tests : aucun envoi réel.
- Critères : un test vérifie qu'aucun autre code n'appelle un canal directement ; un test par règle ; R05 à R10, R12 et R13 passent en service.

### S07 · Journal à empreintes
- Statut : chez Codex depuis le 2026-10-26 : travail fait par Codex (commit `89fb138`), à pousser sur `codex/S07` (H12). Sans commit de Codex sur la branche le 2026-10-27 à 10 h, la tâche revient à Claude
- Qui : Codex, ou Claude tant que H11 est à finir · Relecture : normale · Dépend de : S01
- Où : la tâche est décrite dans `chantier/taches/S07.md` sur la branche `codex/S07`, proposition n° 4. La reprendre telle quelle.
- Cahier : Architecture technique, journal ; M06, registre des mandats.
- Objectif : un journal en ajout seul dans `packages/core/src/journal/`, chaque ligne liée à la précédente par son empreinte SHA-256, pour qu'aucune modification ne passe inaperçue. Stockage derrière une interface, avec une version SQLite (`db/migrations/0002_journal.sql`).
- Critères : une ligne modifiée, supprimée ou intervertie est détectée ; recherche par personne et par période ; aucune donnée personnelle en clair dans l'empreinte ni dans le texte de la ligne, seulement des identifiants internes [R13].

### S08 · Droits d'accès
- Statut : à faire
- Qui : Claude · Relecture : forte · Dépend de : S03, S07
- Cahier : Architecture technique, sécurité et droits.
- Objectif : rôles agent, direction, conformité et partenaire ; un agent ne voit que ses clients, ses biens et ses chiffres ; chaque lecture d'une fiche est écrite au journal.
- Critères : un test d'accès refusé par rôle et par type de donnée ; R16 passe en service.

### S09 · API du socle sur Cloudflare
- Statut : à faire
- Qui : Claude · Relecture : forte · Dépend de : S04, S05, S06, S07, S08
- Attend : H04 pour la mise en ligne seulement.
- Cahier : Architecture technique, les briques et l'hébergement.
- Objectif : un Worker Cloudflare avec D1 qui expose la fiche client, la décision d'envoi en mode essai et le journal, protégé par une clé. Configuration `wrangler` prête, déploiement par GitHub dès que H04 est fait.
- Critères : tests de bout en bout en local ; aucune clé dans le dépôt ; la mise en ligne ne change rien aux systèmes de `shawez-immo`.

### S10 · Reprise des contacts existants
- Statut : à faire
- Qui : Claude · Relecture : forte · Dépend de : S02, S09
- Cahier : Feuille de route, novembre 2026 : import et fusion des contacts existants, exclusions et accords repris.
- Objectif : à découper en tâches d'après `docs/EXISTANT.md`, au début de la tâche : sources, ordre de reprise, contrôle sur 50 fiches.

### S11 · Bascule des automatisations existantes sur l'API
- Statut : à faire
- Qui : Claude · Relecture : forte · Dépend de : S06, S09
- Attend : H05 pour les mails.
- Cahier : Feuille de route, novembre 2026 : alertes acquéreurs, tâches planifiées, mention de l'assistant dans les réponses automatiques par mail.
- Objectif : à découper au début de la tâche, d'après `docs/EXISTANT.md`. Chaque bascule passe d'abord en mode essai, sans envoi réel, puis à 10 % pendant 7 jours, puis partout si les chiffres tiennent, avec retour arrière automatique.

## Phase 2 : la preuve à Dijon

À découper au fil de l'eau, dans l'ordre de la Feuille de route : M02 et M03 en décembre 2026, puis M04, M20 et l'application de l'agent en janvier 2027, et la suite mois par mois.
