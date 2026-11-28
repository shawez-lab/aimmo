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

## La navigation de l'application

L'agent a trois onglets, toujours là : Journée, Outils, Chiffres (`<nav id="onglets">`, avant le contenu ; en bas sur téléphone, en colonne à gauche à partir de 64 rem). L'onglet en cours porte `aria-current` et se lit sans la couleur : un trait d'encre. Un écran ouvert depuis un onglet y revient par son « Retour ». Au clavier, le premier arrêt est « Aller au contenu ». Ni la direction, ni la conformité, ni l'écran sans réseau n'ont ces onglets.

- La journée ne garde que ce qui se fait aujourd'hui, dans cet ordre : à reprendre, rendez-vous, plan, contacts chauds, ventes à tenir, biens, après-vente. Un nouvel outil de l'agent se pose dans l'écran « Outils », jamais sur la journée.
- Un bloc de la journée dont la liste est vide tient sur une ligne, son titre et son état côte à côte (`:has(> .liste:empty)`) : rien n'est caché, « Indisponible » se lit toujours. Une liste longue montre cinq lignes, puis « Voir la suite » en déroule vingt de plus (`fold`) ; les rendez-vous du jour et le plan ne sont jamais repliés.
- L'écran « Outils » est un index : une rangée par outil (`<button class="secondaire rangee">`), à son nom, dans l'un de ses trois groupes (« Mes dossiers », « Au quotidien », « Mon compte »). Pas de phrase toujours affichée : ce qu'un outil promet se dit sur son écran. Un outil qui se lit sur place pose son état et son contenu juste sous sa rangée.
- L'en-tête ne porte que la marque. « Se déconnecter » se tient au pied de l'écran de départ de chaque rôle : « Outils » pour l'agent, le réseau pour la direction, la conformité, et l'écran des visites sans réseau.
- Une lecture en panne ne s'écrit pas comme une aide : `down(zone d'état)` y pose un bandeau d'une ligne avec « Réessayer », qui relit l'écran (`reopen`, la journée par `home`). Le bandeau part avec le prochain message écrit dans la zone. Un rendu qui ne peut pas lire sa réponse rend une phrase commençant par « Indisponible » : elle passe par le même bandeau.
- Le titre de la page suit l'écran : « Outils · AIMMO », « Mandat · REF-1 · AIMMO » (`retitle`). Jamais une personne : la fiche d'un client s'appelle « Fiche client », la journée « Ma journée ». Seuls les écrans d'un bien (liste `LIVE`) sont suivis quand leur titre se précise ; tout autre écran garde le titre écrit dans la page servie, même s'il y écrit ensuite un prénom. Un nouvel écran de bien s'ajoute à `LIVE` ; un écran de personne, jamais.
- Un bien a son écran (`#un-bien`, `openPlace`) : la journée n'en montre qu'une ligne, entière à toucher (`<button class="secondaire rangee">` à deux lignes : ce qu'il est, puis sa référence et son état). Un nouvel outil d'un bien est une rangée de cet écran, jamais un bouton de plus sur la journée ; son « Retour » y ramène (`back`). Un bien se dit par ce qu'il est (`placeName`), sa référence en petit.
- L'onglet « Clients » (`packages/api/app/clients.ts`, servi à part) liste les clients de l'agent, le dernier échange d'abord, avec un champ pour chercher par nom, exactement ou « à l'oreille » (`packages/api/app/oreille.ts` : `sound`, `heardIn`), pour un nom entendu ou dicté. Une ligne est une rangée entière à toucher. La liste s'efface quand on quitte l'onglet et avec la session ; rien n'est gardé sur l'appareil.
- La fiche d'un client (`packages/api/app/fiche.ts`, servie à part) ouvre sur l'essentiel : une phrase (projets, dernier message), l'appel ou la raison qui le ferme, les gestes d'appel, les rappels à faire. Le reste tient en quatre parties, une seule montrée (`.periodes`, `aria-pressed`) : Fil, Projets, Biens, Accords. Un nouveau bloc de la fiche se pose dans l'une d'elles, jamais en tête. Un formulaire ne s'ouvre qu'au geste (`<details>`, son titre en `<summary>`). Sur la fiche, « Appeler » est le seul bouton plein : tout autre geste est filaire (`quiet`, `accordButton`). Aucun lien `sms:` ni `mailto:` : un message ne part que par le contrôle central des envois.
- Un seul bouton plein par écran : le pas qui fait avancer le dossier (rédiger, valider, contrôler, signer, télécharger la page à remettre). Lire, rouvrir, refaire, annuler, ajouter une ligne ou ouvrir un formulaire sont filaires (`quiet(button(…))` dans l'application, `quiet` ou `wire` dans un script servi à part). Quand rien n'est à faire, l'écran n'a aucun bouton plein. Un essai le vérifie état par état avec `filledButtons` (`packages/api/test/fake-dom.ts`). Des gestes posés côte à côte prennent la classe `gestes`.
- Un écran qui empile plus de huit blocs se range en rubriques : une rangée d'onglets soulignés (`.rubriques`, des boutons avec `aria-pressed`), une seule rubrique visible à la fois, chaque bloc dans une rubrique et une seule. Les pastilles (`.periodes`) restent pour un filtre : une période, une partie d'une fiche. Ce qui attend un geste se dit en une phrase au-dessus des rubriques, et la phrase ne dit jamais « rien » quand une lecture a manqué (« Le réseau », DS008 ; essais dans `packages/api/test/reseau-rubriques.test.ts`). « Conformité » suit la même règle (DS009, `conformite-rubriques.test.ts`) : sa phrase dit l'échéance légale qui tombe la première.
- Un écran servi à part passe par `withTool` : le script n'est demandé qu'une fois, et pendant qu'il arrive le dernier geste gagne. Dans les essais, le faux document charge de lui-même la fiche (`FakeElement.served`).
- L'onglet « Biens » (`packages/api/app/mes-biens.ts`, servi à part) liste les biens de l'agent, avec un champ où chercher comme on parle (« t3 dijon sous offre » : `understand`, `fits`, et ce qui a été compris écrit dessous), et un filtre par état de l'annonce. Une ligne est une rangée entière à toucher, et ouvre l'écran du bien. La liste s'efface quand on quitte l'onglet et avec la session ; la recherche et le filtre reviennent avec l'onglet. Un nouvel onglet de l'agent suit ce modèle : une section dans la page, un script servi à part par `withTool`, une entrée dans `ROOTS`, et son retour dans `home`.

## Ajouter un écran

1. Sa feuille commence par `DESIGN_CSS` (ou `PRINT_DESIGN_CSS` pour le papier), puis n'ajoute que de la mise en page en `var(--…)`.
2. L'ajouter à la liste de `packages/api/test/ecrans.ts`, que lisent `design.test.ts` (accessibilité, budget et appartenance au système) et les captures rejouables.
3. Captures avant et après dans la proposition : `docs/design/captures/`. Pour mesurer tout le produit d'un coup : `node scripts/captures.mjs <dossier>` avant le changement, puis après, et `node scripts/captures.mjs --comparer <avant> <après>` (là où Playwright et Chromium sont installés ; tout y est inventé). Un nouvel écran de l'application s'ajoute au plan `APP_SHOTS` de `packages/api/test/captures.test.ts`, une nouvelle page à `packages/api/test/ecrans.ts`.
