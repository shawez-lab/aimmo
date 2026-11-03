# Quand ça bloque

Chaque problème connu a sa réponse, prévue d'avance. Jamais deux fois le même essai raté, jamais d'attente sans fin.

| Problème | Réponse |
| --- | --- |
| La séance s'est coupée : limite d'usage, panne | Rien à faire. La séance suivante trouve un verrou de plus de 3 heures, le reprend et continue la tâche « en cours » sur sa branche, où tout a été poussé au fil de l'eau. |
| Un test ou une vérification échoue | Corriger. Deux essais au plus. Au troisième échec : garder la branche, écrire la cause dans la proposition, passer la tâche à « bloquée : <cause> », et prendre une autre tâche à la séance suivante. Une séance plus tard pourra la reprendre avec une autre approche. |
| main ne passe plus les vérifications | Priorité absolue, avant toute tâche : trouver le commit fautif et l'annuler par `git revert`, en proposition de modification. |
| Les vérifications GitHub ne démarrent pas ou durent plus de 30 minutes | Laisser la proposition ouverte, l'écrire au journal. La séance suivante vérifie à nouveau. |
| Codex ne répond pas sous 24 heures à une tâche confiée | La tâche revient à Claude : reprendre la branche `codex/<id>` telle quelle et finir. |
| Codex et Claude touchent la même chose | La tâche appartient à celui que nomme `PLAN.md`. L'autre ne pousse jamais sur sa branche. |
| Codex signale un P0 ou P1 qui n'en est pas un | Répondre dans la proposition, en une phrase, avec la règle ou le test qui le montre, puis continuer. |
| Un service extérieur n'est pas encore ouvert : Cloudflare, Gmail, Meta, Google, portails | Coder contre une interface et un faux service de test, marquer la ligne dans `HUMAIN.md`, continuer. Le branchement réel sera une petite tâche à part. |
| Une dépendance npm est cassée ou introuvable | Revenir à la version du `package-lock.json`. Ne jamais forcer une installation. |
| Le cahier est flou ou contradictoire | Choisir la lecture la plus prudente pour les clients et pour la loi, l'écrire dans la tâche de `PLAN.md`, continuer. |
| Une tâche est trop grosse pour une séance | La couper en deux tâches dans `PLAN.md`, finir la première. |
| Le verrou dit « occupé » depuis plus de 3 heures | Le reprendre : la séance d'avant s'est coupée. |
| Le Claude Docs du cahier ne répond pas | Travailler avec ce que disent `PLAN.md` et `docs/REGLES.md`. Si la tâche a vraiment besoin du cahier, prendre une autre tâche. |
