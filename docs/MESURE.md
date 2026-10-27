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

La vérification affiche le nombre de biens complets et, par **numéro de ligne**, les données qui manquent, sans recopier l'adresse. Elle échoue s'il en manque une. Sans le fichier, ce test est sauté.
