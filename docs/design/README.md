# Système de design d'AIMMO

Un seul fichier fait foi : `packages/core/src/design/systeme.ts`. Le contrôle est dans `packages/core/src/design/audit.ts`, et chaque écran y passe dans `packages/api/test/design.test.ts` (règle R201).

## L'identité

Une maison de vente : la direction « Maison » de `docs/design/DIRECTIONS.md`. Une pierre blanche, une encre presque noire qui est aussi la couleur d'action, un trait de laiton qui ne porte jamais de texte. Les titres, les prix et les grands chiffres dans le caractère à empattements de l'appareil, en graisse normale ; le texte dans sa police courante, chiffres alignés. Pas de carte : des filets fins, des angles presque droits. Une seule action pleine par écran. Aucune police à télécharger.

Les noms des jetons n'ont pas changé, pour que chaque écran suive sans être récrit : `--accent` est l'encre, `--moutarde` est le laiton, `--frise` est un filet.

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
