# Protocole d'une séance du chef de chantier

Le chantier tourne sans arrêt, sans horaire. Une séance enchaîne les tâches, chacune finie proprement (tests, relecture, fusion, journal), et repart à l'étape 3 après chaque fusion. Elle ne s'arrête que si plus rien n'est faisable ou si elle approche de sa limite. Juste avant de s'arrêter, si du travail reste : libérer le verrou, puis relancer tout de suite la séance suivante avec l'outil fire_trigger sur la tâche planifiée `trig_01WHDD3Cn9ywcnwa3R9omsQK`. Personne ne répond pendant la séance : décider, agir, noter.

## 1. Démarrer

1. Lire ce fichier, `chantier/PLAN.md`, `chantier/HUMAIN.md` et les 10 dernières lignes de `chantier/JOURNAL.md`. Rien d'autre à ce stade.
2. **Verrou.** Lire `chantier/VERROU.md`.
   - La voie 2 lit `chantier/VERROU-2.md` au lieu de `chantier/VERROU.md` (section 8).
   - S'il dit « occupé » depuis moins de 3 heures : arrêter la séance, sans rien écrire. Dernier message : « Fait : rien, une autre séance travaille. »
   - Sinon : y écrire `occupé depuis <AAAA-MM-JJ HH:MM> (heure de Paris)`, commit `chantier : verrou`, push sur main. Si le push est refusé parce que main a bougé : `git pull --rebase`, relire le verrou, recommencer cette étape une fois.
3. **Propositions ouvertes d'abord.** Lister les propositions de modification ouvertes (`gh api repos/shawez-lab/aimmo/pulls --jq '.[] | [.number, .head.ref, .title] | @tsv'`). Pour chacune :
   - vérifications vertes, relue, et Codex sans P0 ni P1 restant : la fusionner, passer sa tâche à « fait » ;
   - branche `codex/<id>` sans nouveau commit de Codex depuis plus de 2 heures : la tâche revient à Claude, qui la fait dans cette séance (voir `SECOURS.md`) ;
   - sinon : la laisser.
4. **Déléguer à Codex.** Si H11 est « fait » dans `HUMAIN.md` et qu'une tâche marquée « Qui : Codex » est prête : la confier selon la section 6. Cela ne compte pas comme la tâche de la séance. Tant que H11 est « à finir », Claude fait lui-même les tâches marquées « Qui : Codex », sauf à la première séance du lundi : elle essaie d'en confier une, et si Codex refuse encore, la fait elle-même.
5. **Choisir la tâche de Claude :**
   - une tâche « en cours » de Claude : la reprendre, sur sa branche ;
   - sinon la première tâche « à faire » de Claude dont toutes les dépendances sont « fait » et qui n'attend rien de `HUMAIN.md` ;
   - sinon, si le prochain module de la Feuille de route n'est pas encore découpé : le découper (section 5) ;
   - sinon, une tâche marquée « Qui : Codex » ou bloquée chez Codex : Claude la fait lui-même ;
   - sinon, une tâche plus loin dans le plan ou le module suivant, même si une tâche d'avant attend un humain : le chantier ne s'arrête jamais. Ce qui attend un humain va dans « Besoin de toi » avec un prompt prêt pour ChatGPT ;
   - s'arrêter seulement si vraiment plus rien n'est faisable : l'écrire au journal, libérer le verrou.
6. Passer la tâche à « en cours » dans `PLAN.md`, dans le commit du verrou ou juste après.

## 2. Faire

1. Créer ou reprendre la branche `chantier/<id>`, à jour avec main.
2. Lire dans le cahier seulement la partie citée par la tâche (voir `CLAUDE.md`).
3. Écrire d'abord les tests qui traduisent chaque critère d'acceptation. Un test qui vérifie une règle porte son numéro, `[R01]`.
4. Écrire le code par petits commits poussés au fil de l'eau, pour qu'une coupure ne perde rien. `npm run check` et `npm test` après chaque étape.
5. **Relecture forte** quand la tâche est marquée ainsi : avant d'ouvrir la proposition, faire relire le diff par un agent séparé qui n'a pas écrit le code, avec `AGENTS.md`, `docs/REGLES.md` et la partie du cahier. Lui demander seulement les problèmes P0 et P1. Corriger chacun ou écrire dans la proposition pourquoi ce n'en est pas un.

## 3. Proposer et fusionner

1. `npm run check`, `npm test`, `npm run garde-fous` en local, tous verts.
2. Pousser la branche, ouvrir la proposition par l'API REST (voir `CLAUDE.md`). Titre : `<id> · <titre>`. Corps : ce qui est fait, les critères et leurs tests, ce qui reste.
3. `node scripts/attendre-verifications.mjs <numéro>`, avec `--codex` si H03 est fait. Sortie 5 : Codex n'est pas prêt pour le dépôt. Continuer sans sa relecture et repasser H03 à « à finir » dans `HUMAIN.md`, avec la raison.
4. Une vérification rouge ou un P0 ou P1 de Codex : corriger et repousser. Après une correction demandée par Codex, commenter `@codex review` pour qu'il relise la nouvelle version. Deux essais au plus, puis `SECOURS.md`.
5. Tout est vert : fusionner en squash par l'API, puis `git checkout main && git pull`.

## 4. Finir, toujours, même après un échec

1. `PLAN.md` : la tâche passe à « fait (AAAA-MM-JJ) » ou « bloquée : <raison> ». Les règles mises en service passent à « oui » dans `docs/REGLES.md`.
2. `JOURNAL.md` : une ligne, `- AAAA-MM-JJ HH:MM · <id> · <résultat en quelques mots> · prochaine : <id>`.
3. `HUMAIN.md` : si une tâche à moins de trois places de la tête du plan attend un humain et n'a jamais été signalée, la marquer « signalé le <date> ». Elle sera dite une seule fois dans « Besoin de toi ».
4. `VERROU.md` : `libre`. Commit `chantier : fin de séance <id>`, push sur main.
5. Dernier message, deux lignes en français simple : « Fait : … » et « En cours : … ». Ajouter « Besoin de toi : … » seulement pour une action humaine signalée pour la première fois à l'étape 3, ou qui bloque désormais tout le chantier.

## 5. Découper un module

Quand plus aucune tâche n'est prête : lire dans la Feuille de route le module suivant, puis sa fiche dans le cahier, et ajouter à `PLAN.md` ses tâches, chacune d'une journée de travail au plus, avec : id, titre, qui, relecture normale ou forte, dépendances, partie du cahier, objectif, critères d'acceptation testables, et ce qu'elle attend d'un humain. Ajouter à `docs/REGLES.md` les règles du module, « en service : non ». Puis enchaîner sur la première tâche du module.

## 6. Confier une tâche à Codex

1. Créer la branche `codex/<id>` depuis main.
2. Y écrire `chantier/taches/<id>.md` : objectif, fichiers concernés, critères d'acceptation, tests attendus, ce qu'il ne faut pas toucher. Commit, push.
3. Ouvrir la proposition `<id> · <titre> (Codex)`, puis la commenter : `@codex Fais la tâche décrite dans chantier/taches/<id>.md sur cette branche, en suivant AGENTS.md, jusqu'à ce que npm run check, npm test et npm run garde-fous passent.`
4. `node scripts/attendre-verifications.mjs <numéro> --codex`. Sortie 5 : Codex refuse la tâche. H11 reste « à finir », et la tâche revient tout de suite à Claude, qui la fait sur la branche `codex/<id>` et sa proposition. Si Codex répond qu'il travaille ou pousse un commit : H11 passe à « fait ».
5. Dans `PLAN.md` : « chez Codex depuis le <date> ».

## 7. Économie

- Jamais d'audit, jamais de relecture en série, jamais relire un fichier déjà lu dans la séance.
- Lire le cahier par recherche ciblée, jamais un onglet entier quand une partie suffit.
- La séance s'arrête dès que sa tâche est finie, même s'il reste du temps.

## 8. Deux voies en parallèle

Deux séances travaillent en même temps, chacune sur son module, pour aller deux fois plus vite.

- **Voie 1**, la tâche planifiée `trig_01WHDD3Cn9ywcnwa3R9omsQK`, verrou `chantier/VERROU.md` : suit le plan dans l'ordre, et saute tout ce qui est réservé à la voie 2.
- **Voie 2**, la tâche planifiée « Chef de chantier AIMMO voie 2 », verrou `chantier/VERROU-2.md` : prend le module de la Feuille de route qui suit celui de la voie 1 et qu'aucune voie n'a commencé. Elle le réserve en écrivant sous son titre dans `PLAN.md` : `Voie : 2`, puis le découpe et le fait. Ses tâches en cours portent « en cours (voie 2) ». Elle relance la voie 2, jamais la voie 1.
- Les deux voies ne touchent jamais au même fichier de code en même temps. Si un fichier du socle doit changer, la voie 2 laisse la tâche à la voie 1 et passe à la suivante.
- `PLAN.md` et `JOURNAL.md` : toujours `git pull --rebase` juste avant de les modifier ; en cas de conflit, garder les deux lignes.

## 9. Exigence : mille fois mieux

AIMMO doit faire ce que personne d'autre ne fait. Chaque module découpé contient au moins une tâche « Jamais vu » : une fonction qu'aucun réseau, logiciel ou outil d'IA grand public n'offre, écrite comme critère d'acceptation testable, et nommée dans la proposition. Chaque écran suit le système de design d'AIMMO : rien de générique, rien qui ressemble à un site fait par une IA, rapide, accessible, beau sur téléphone d'abord.

## 10. Exploiter Codex au maximum

Codex relit chaque proposition. En plus, quand il laisse des remarques P2, commenter `@codex corrige tes remarques sur cette branche`. S'il pousse un commit, noter dans `HUMAIN.md` que H12 est réglé : les tâches marquées « Qui : Codex » peuvent alors lui être confiées de nouveau, en parallèle des deux voies.

## 11. Quand GitHub Actions ne démarre plus (facturation)

Décision de Shawez (2026-10-29) : aucune dépense GitHub en plus. Si les vérifications GitHub ne démarrent pas parce que le quota ou le paiement est bloqué :

1. Lancer soi-même, dans la séance, sur le dernier commit de la branche et sous Node 22 : `npm ci`, `npm run check`, `npm test`, `npm run garde-fous`, et `wrangler deploy --dry-run` quand le Worker change. Avec `GITHUB_ACTIONS=true` pour que les tests SQLite soient obligatoires.
2. Tout vert : commenter la proposition avec « Vérification locale : vert », le commit et le nombre de tests passés. Un seul échec : corriger, ne jamais fusionner.
3. Fusionner ensuite comme d'habitude, avec la relecture de Codex sans P0 ni P1 restant.
4. Ne pas relancer les vérifications GitHub en boucle : elles reprennent seules au renouvellement du quota.
