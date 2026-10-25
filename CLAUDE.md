# AIMMO : consignes pour Claude

Tu construis le logiciel d'AIMMO, le futur réseau d'agents immobiliers de Shawez Ali, agent immobilier à Dijon. Shawez ne copie rien, ne valide rien module par module, et son ordinateur reste éteint : ce sont les tests qui décident.

## Où est quoi

- Le besoin : le cahier des charges, document Claude Docs, container `{"kind":"project","id":"077446ee-e1f6-45ea-af92-9d52ce4f06e3"}`. En cas de doute, le cahier a raison.
- Le déroulé d'une séance automatique : `chantier/PROTOCOLE.md`, à suivre à la lettre.
- Les tâches : `chantier/PLAN.md`. Le journal : `chantier/JOURNAL.md`. Ce qui attend un humain : `chantier/HUMAIN.md`. Quand ça bloque : `chantier/SECOURS.md`.
- Les règles métier, chacune avec son test : `docs/REGLES.md`.
- Les règles de code et de relecture, communes à Claude et à Codex : `AGENTS.md`.

## Lire le cahier sans gaspiller

Lis seulement la partie dont la tâche a besoin, avec l'outil `read` de Claude Docs : `ref` = `{"object":"node","id":"<id>"}`, `container` ci-dessus, `engine` = `"prose"`. Pour viser une partie : `payload` = `{"kind":"search","text":"<mots>"}`, puis `{"kind":"view","parentId":"<id du bloc>"}`.

| Onglet | id |
| --- | --- |
| Synthèse | d501d089-af16 |
| Le produit | c11526d3-9e7a |
| Besoins et solutions | 6a4967c0-2bbc |
| Architecture technique | 1ce89912-262d |
| Intelligence artificielle | d87e12c4-a013 |
| Conformité | 2498c769-8354 |
| Offre aux agents | d1ea69af-4117 |
| Organisation et méthode | 07e4f4a1-6630 |
| Feuille de route | c51e370d-2c75 |
| Indicateurs et tests | 6826b84a-84e0 |
| Risques | 36afdc1b-55a8 |
| Glossaire et sources | c3aefced-6601 |
| M01 Attirer | d406b021-3a9d |
| M02 Capter | ee164f54-985a |
| M03 Qualifier et attribuer | 4ef87b09-cef3 |
| M04 Estimer | a7863b2e-317a |
| M05 Rendez-vous | 76b2a86a-0872 |
| M06 Mandats et documents | 7453f6af-266d |
| M07 Commercialiser | 05b028a2-8522 |
| M08 Acquéreurs et visites | 9c8bd319-1671 |
| M09 Offre | 15f84e74-8ba1 |
| M10 Compromis et acte | e7f98a92-f538 |
| M11 Après-vente | dcb5d860-bb59 |
| M12 Conformité | d1f7a942-6a5c |
| M13 Pilotage et finances | d8f2ed34-dedd |
| M14 Réseau et académie | 51ec2fb9-6148 |
| M15 Louer | f81278a7-59cd |
| M16 Commerces et entreprises | 63827d1a-ac36 |
| M17 Investir | 25030d58-b485 |
| M18 Partenaires | 58155380-2fc3 |
| M19 Studio | f0f8de0a-b5f1 |
| M20 Gagner des mandats | b8b80b06-c7bf |

## GitHub depuis une séance

L'API GraphQL est fermée : `gh pr ...` ne marche pas. Utilise l'API REST avec `gh api` :

- ouvrir une proposition : `gh api repos/shawez-lab/aimmo/pulls -f title="<id> · <titre>" -f head="<branche>" -f base=main -f body="<résumé>"`
- attendre les vérifications et la relecture de Codex : `node scripts/attendre-verifications.mjs <numéro>` (ajoute `--codex` quand H03 est fait dans `chantier/HUMAIN.md`)
- commenter : `gh api repos/shawez-lab/aimmo/issues/<numéro>/comments -f body="<texte>"`
- fusionner : `gh api -X PUT repos/shawez-lab/aimmo/pulls/<numéro>/merge -f merge_method=squash`

## Toujours

- Une règle sans test n'existe pas. Un critère d'acceptation sans test n'est pas rempli.
- Messages de commit en français, courts : `S04 : fusion de deux fiches`.
- Jamais de secret, de mot de passe ni de donnée personnelle réelle dans le dépôt, les tests ou le journal. Les jeux de test sont inventés.
