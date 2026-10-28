# Système de design d'AIMMO

Un seul fichier fait foi : `packages/core/src/design/systeme.ts`. Le contrôle est dans `packages/core/src/design/audit.ts`, et chaque écran y passe dans `packages/api/test/design.test.ts` (règle R201).

## L'identité

Les toits vernissés de Bourgogne : un papier chaud, une encre presque noire, un bordeaux « lie de vin » pour agir, un jaune moutarde de Dijon pour souligner, un vert de tuile. Un seul motif, le losange des tuiles : devant la marque, devant les titres de carte, et en frise sous l'en-tête. Titres en romain de livre, texte en police du système, chiffres alignés. Aucune police à télécharger.

## Les jetons

- Couleurs : `--papier`, `--surface`, `--encre`, `--doux`, `--trait`, `--accent`, `--sur-accent`, `--accent-doux`, `--moutarde`, `--sur-moutarde`, `--tuile`, `--succes`, `--danger`, `--sur-danger`, `--danger-doux`, `--anneau`. Chacune a sa valeur claire et sombre ; seules les paires de `PAIRES_TEXTE` portent du texte.
- Typographie : `--police-titre`, `--police-texte`, tailles `--t-xs` à `--t-xxl`.
- Espacements : `--e-1` (4 px) à `--e-8` (72 px). Rayons : `--r-s`, `--r-m`, `--r-l`, `--r-rond`. Cible tactile : `--cible` (48 px). Colonne : `--colonne`.
- Mouvements : `--m-vite`, `--m-normal`, `--m-courbe`, seulement dans la base, coupés pour qui réduit les animations.

## Les composants

`.marque`, `.frise`, `.bloc`, `.carte`, `.liste`, `.doux`, `.etat`, `.pastille`, `.alerte`, `.notes`, boutons (plein, `.secondaire`, `.retour`, `.danger`), champs, `.case`. Une page publique courte se fait avec `renderPublicPage`.

## Ajouter un écran

1. Sa feuille commence par `DESIGN_CSS` (ou `PRINT_DESIGN_CSS` pour le papier), puis n'ajoute que de la mise en page en `var(--…)`.
2. L'ajouter à la liste de `design.test.ts` : accessibilité, budget et appartenance au système y sont vérifiés.
3. Captures avant et après dans la proposition : `docs/design/captures/`.
