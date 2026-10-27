# Mesure du classement des contacts (M03, Q05)

Le critère de la Feuille de route est le suivant : 90 % de 50 cas réels classés comme Shawez l'aurait fait. Les cas réels ne viennent **jamais** dans le dépôt, ni dans un test, ni dans le journal.

## Préparer les cas (H18)

Un fichier CSV, séparé par des points-virgules, en UTF-8, avec une ligne d'en-tête :

```
texte;catégorie;suite
"Bonjour, je souhaite vendre ma maison à Talant.";vendeur;
"Je cherche une location à Dijon.";acquéreur;M15
```

- **texte** : le message reçu, **anonymisé**. Retirer le nom, le numéro, le mail, l'adresse et tout ce qui désigne la personne. La commune et la description du bien peuvent rester.
- **catégorie** : `vendeur`, `acquéreur`, `estimation`, `mise en location`, `professionnel`, `partenaire`, `curiosité` ou `indésirable`.
- **suite** : vide, `M15` (location), `M16` (commerce, entreprise) ou `M17` (investissement). Si la colonne est absente, la suite n'est pas mesurée.

Il faut au moins 50 lignes, en dehors de l'en-tête. Le fichier se range hors du dépôt, sur la machine qui lance la mesure.

## Lancer la mesure

```
AIMMO_CAS=/chemin/hors/du/depot/cas.csv npx vitest run packages/core/test/qualification-chaine.test.ts
```

La mesure affiche le nombre de cas classés comme Shawez, le taux, et les écarts par **numéro de cas**, sans jamais recopier leur texte. Elle échoue sous 90 %.

Sans le fichier, ce test est sauté.

Aujourd'hui, ce sont les règles fixes qui sont mesurées. La mesure de la vraie IA viendra avec H13.

Les corrections faites par les agents (`POST /v1/qualifications/<id>/correction`) s'ajoutent aux cas de mesure : elles se lisent avec `Qualification.correctedCases`.

# Vérification de la collecte sur 10 biens tests (M04, E03)

Le critère de M04 : pour 10 biens tests, toutes les données publiques sont retrouvées automatiquement (adresse, parcelle, diagnostic énergétique, risques). Les adresses ne viennent **jamais** dans le dépôt.

1. Écrire un fichier texte hors du dépôt, une adresse complète par ligne (numéro, voie, code postal, commune), 10 lignes, de biens que l'agence connaît et qui ont un diagnostic énergétique.
2. Sur une machine reliée à Internet :

```
AIMMO_BIENS=/chemin/hors/du/depot/biens.txt npx vitest run packages/core/test/collecte.test.ts
```

Il faut 10 adresses au moins, sinon la vérification échoue. Elle affiche le nombre de biens complets et, par **numéro de ligne**, les données qui manquent, sans recopier l'adresse. Elle échoue s'il en manque une. Sans le fichier, ce test est sauté.

# Mesure de l'estimation sur 20 biens (M04, E07)

Le critère de M04 : sur 20 biens, écart médian de moins de 10 % entre la fourchette AIMMO et l'estimation de l'agent, chaque écart expliqué. Les biens réels ne viennent **jamais** dans le dépôt.

## Préparer les biens (H19)

Un fichier CSV, séparé par des points-virgules, en UTF-8, avec une ligne d'en-tête. Les colonnes peuvent venir dans n'importe quel ordre :

```
type;surface;lat;lon;code_postal;estimation_agent;etage;ascenseur;balcon;terrasse;dpe
appartement;65;47.323;5.041;21000;170000;2;oui;oui;non;D
maison;120;47.301;5.012;21160;310000;;;;oui;E
```

- Obligatoires : **type** (`appartement` ou `maison`), **surface** (m²), **lat** et **lon** arrondies à **trois décimales au plus** (une centaine de mètres : la coordonnée désigne le quartier, pas le bien ; plus précises, la ligne est refusée), **code_postal**, **estimation_agent** (en euros, la valeur que l'agent a donnée).
- Facultatives : `etage`, `terrain` (m²), `ascenseur`, `balcon`, `terrasse`, `parking`, `cave`, `piscine`, `garage`, `plain_pied` (`oui` ou `non`), `etat` (`travaux`, `à rafraîchir`, `bon`, `neuf`), `epoque` (`avant1948`, `1948-1974`, `1975-2000`, `2001-2012`, `apres2012`), `dpe` (lettre de A à G).
- Jamais d'adresse, de nom ni de numéro.

Il faut au moins 20 biens qui reçoivent une fourchette. Le fichier se range hors du dépôt.

## Lancer la mesure

```
AIMMO_ESTIMATIONS=/chemin/hors/du/depot/biens.csv AIMMO_DVF=https://<adresse des fichiers DVF du site>/ npx vitest run packages/core/test/mesure-estimation.test.ts
```

`AIMMO_DVF` est l'adresse https des fichiers DVF publics du site (la même que `DVF_BASE_URL`), ou un dossier local qui contient `index.json`, `t/` et `d/`.

La mesure affiche le nombre de biens mesurés, l'écart médian, le nombre d'estimations tombées dans la fourchette, puis, par **numéro de ligne**, l'écart et son explication (ventes retenues, rayon, ajustements, marge, position de l'estimation de l'agent), sans recopier les coordonnées. Elle échoue sous 20 biens mesurés ou à 10 % d'écart médian et plus. Sans le fichier, ce test est sauté.
