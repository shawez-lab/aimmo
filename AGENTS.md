# AIMMO : règles pour les agents de code, Codex et Claude

## Le projet

AIMMO est le logiciel d'un réseau d'agents immobiliers en France : fiche client unique, messages, mandats, documents, site, application de l'agent. Le besoin complet est dans le cahier des charges cité par `CLAUDE.md`. Les tâches sont dans `chantier/PLAN.md`. Les règles métier sont dans `docs/REGLES.md`.

## Comment travailler

- Une tâche du plan, une branche, une proposition de modification. Branches : `chantier/<id>` pour Claude, `codex/<id>` pour Codex.
- Une tâche confiée à Codex est décrite dans `chantier/taches/<id>.md` : faire exactement cela, rien d'autre.
- Lire seulement les fichiers utiles à la tâche.
- Écrire d'abord les tests qui traduisent les critères d'acceptation, puis le code.
- Avant de pousser : `npm run check`, `npm test` et `npm run garde-fous` doivent passer.
- TypeScript strict. Aucune dépendance nouvelle sans vraie nécessité, jamais une dépendance abandonnée.
- Code et noms en anglais. Textes visibles par les utilisateurs en français.
- Aucun secret dans le code : les clés passent par les secrets de Cloudflare et de GitHub.
- Un test qui vérifie une règle de `docs/REGLES.md` porte son numéro entre crochets dans son nom, par exemple `[R01]`.
- Ne jamais changer une règle sans changer son test, ni l'inverse.
- Les jeux de test sont inventés : aucune vraie personne, aucun vrai numéro, aucune vraie adresse.

## Code Review Rules

Signaler en P0 :

- un envoi de message, de mail, de SMS ou de notification qui ne passe pas par le contrôle central des envois ;
- un secret, un mot de passe, un jeton ou une clé écrits dans le code, les tests ou les journaux ;
- une suppression de données qui n'est pas prévue par une règle écrite ;
- une donnée personnelle, nom, téléphone, mail ou adresse, écrite dans un journal ou une page publique, ou envoyée à une IA sans nécessité ;
- une note, un classement ou un tri automatique de candidats à un poste ou à une location, de la solvabilité d'un acquéreur ou d'un locataire, ou de la performance d'un agent ;
- un envoi possible la nuit, le dimanche ou à une personne exclue, hors réponse immédiate à un client qui vient d'écrire ;
- une règle de `docs/REGLES.md` contournée ou affaiblie.

Signaler en P1 :

- un prix, une surface ou une date inventés ou écrits en dur au lieu de venir des données ;
- dans un texte destiné à un client ou au public : « mandataire » au lieu d'« agent immobilier », « gratuit » au lieu d'« offert », ou une mention de l'IA en dehors de la mention légale du premier message automatique ;
- un critère d'acceptation de la tâche sans test ;
- une modification hors du périmètre de la tâche ;
- une erreur avalée sans trace dans le journal ni texte de secours.
