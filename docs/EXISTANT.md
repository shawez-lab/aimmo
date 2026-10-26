# Ce qui tourne déjà, et ce qu'AIMMO en fait

Relevé en lecture seule du dépôt `shawez-lab/shawez-immo` le 26 octobre 2026 (tâche S02). Rien n'y a été modifié.
Principe : ce qui marche est repris ou branché sur le socle, jamais refait de zéro. Les bascules se font en mode essai d'abord (S11).

## Code serveur du site (Cloudflare Pages Functions, base D1 liée en `DB`)

| Brique | Ce qu'elle fait | Données | AIMMO | Tâche |
| --- | --- | --- | --- | --- |
| `functions/api/espace/[[route]].js` | API de l'espace estimation : comptes vendeurs, demandes, visites, offres, fichiers, tâches à heure fixe (`/api/espace/taches`) | D1 : comptes, sessions, demandes, visites, offres, courriers, évènements | Repris : le modèle « demande d'estimation » et le suivi du vendeur deviennent la fiche client unique et l'espace propriétaire | S03, S10 |
| `functions/_lib/base.js` | Outils communs de l'API : réponses, sessions, limites | — | Repris comme modèle de code | S09 |
| `functions/_lib/estimation.js` | Fourchette de prix à partir des ventes DVF | `donnees-dvf/` | Repris tel quel dans M04 | M04 |
| `functions/_lib/agenda.js` | Créneaux libres de l'agent, sans double réservation | Agenda | Repris dans M05 | M05 |
| `functions/_lib/suivi.js` | Heure de Paris, prochaine action, prochaine étape dite au vendeur | demandes | Heure de Paris reprise dans la règle R01 ; le reste dans M08 | S05, M08 |
| `functions/_lib/promesses.js` | Mesure des 7 promesses faites au vendeur : tenue ou ratée | évènements | Repris pour les engagements de service et la clause « libre si on ne tient pas parole » | M06, M13 |
| `functions/_lib/mail.js` | Envoi de mails depuis l'API | Cloudflare Email | Passera derrière le contrôle central des envois | S06, S11 |
| `functions/_lib/fichiers.js` | Photos et documents déposés, avis de valeur en PDF | D1 `fichiers`, `fichiers_blocs` | Repris, stockage à passer sur R2 | M10 |
| `functions/_lib/interne.js`, `pages-privees.js`, `*/_middleware.js`, `functions/[[path]].js`, `de-claude/`, `outils/[[path]].js`, `*.md.js` | Ne jamais servir au public les fichiers internes ; en-têtes de sécurité des pages privées | — | Même règle dans AIMMO : rien d'interne n'est servi | S09 |
| `functions/api/lead.js` | Formulaire « Être rappelé » du site | mail à Shawez | Branché sur la fiche client unique | S10, M02 |
| `functions/api/lead-tri.js` | Tri et première réponse des leads, mails de portails et formulaires | — | Repris dans M02, envois par le contrôle central | S11, M02 |
| `functions/api/manychat-dm.js` | Réponses personnalisées aux DM Instagram, mention de l'assistant, réponse à toute heure | ManyChat | Reste en place, intouché. Remplacé par M02 seulement quand Meta valide l'application (H06) | M02 |
| `functions/schema.sql`, `functions/migrations/2026-10-18-admin.sql` | Schéma de la base : comptes, sessions, demandes, jetons, limites, fichiers, réglages, journal de l'agence | D1 | Point de départ du modèle de S03. Les comptes clients gardent leur mot de passe haché côté site, jamais dans la fiche client | S03 |

## Tâches automatiques (GitHub Actions)

| Workflow | Quand | Ce qu'il fait | AIMMO | Tâche |
| --- | --- | --- | --- | --- |
| `sync-annonces.yml` | toutes les 15 min, 5 h à 22 h | Reprend les annonces de l'agence et reconstruit les pages des biens | Reste en place pendant la preuve, puis lu par M07 | M07 |
| `build.yml` | à chaque modification de page | Flux RSS, balises, publication du site | Reste en place | — |
| `dvf.yml` | le 5 de chaque mois | Met à jour les ventes DVF | Repris pour M04 et les pages de prix | M04 |
| `indexnow.yml` | chaque jour, 7 h 23 | Signale les pages modifiées aux moteurs | Repris dans M01 | M01 |
| `taches.yml` | chaque heure, 7 h à 21 h | Appelle `/api/espace/taches` : rappels de visite, mails du matin | Basculera sur le socle, en mode essai | S11 |
| `lead-worker.yml` | à la demande | Déploie le Worker `shawez-lead` (route `/api/lead*`) | Même méthode de déploiement pour le socle, avec ses propres secrets (H04) | S09 |
| `tests-espace.yml` | à la demande | Tests en ligne de l'espace estimation | Modèle pour les tests de bout en bout | S09 |

## Outils (`outils/`)

`sync_annonces.py`, `biens/`, `build.py`, `dvf.py`, `indexnow.py`, `avis.py`, `posts_images.py`, `passages_agence.py`, `espace.py`, `seo/`, `mailer/` (Worker `shawez-mailer`) : restent dans le dépôt du site. AIMMO les lit, il ne les modifie pas.

## Ce qu'il faut retenir pour la suite

1. La base D1 du site contient déjà de vrais clients : S10 la reprend sans rien effacer, avec les exclusions et accords.
2. Les envois réels existent déjà (DM Instagram, mails, rappels) : le socle ne les remplace qu'après le mode essai, un par un.
3. Aucun secret n'est dans le dépôt du site : ils sont dans GitHub et Cloudflare. AIMMO aura les siens (H04).
