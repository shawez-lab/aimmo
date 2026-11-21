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

Les corrections faites par les agents depuis la fiche s'ajoutent aux cas de mesure : la direction télécharge le fichier depuis l'écran du réseau, bloc « Mesure du classement » (`GET /v1/qualifications/cas-corriges`). Il porte les 150 corrections les plus récentes, a le format ci-dessus et se passe tel quel à `AIMMO_CAS`. Coordonnées, voies citées et noms de la fiche en sont retirés, mais le repérage n'est pas parfait : un tiers cité en texte libre, une commune écrite comme un nom ou une adresse en minuscules peuvent rester. Le relire avant de s'en servir, et le garder hors du dépôt.

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

# Mandat signé en moins de 10 minutes (M06, D09)

Le critère de M06 : un mandat test signé en moins de 10 minutes à partir de l'estimation, et numéroté au registre.

Le parcours de test tourne à chaque vérification, sur une horloge simulée et des données inventées :

```
npx vitest run packages/core/test/parcours-mandat.test.ts
```

Il affiche le temps passé par le système à chaque étape (génération, contrôle, signature) et le total simulé.

Pour la mesure réelle avec Shawez, sur un vrai rendez-vous d'estimation, une fois le registre de l'agence réglé (H23) et les modèles validés (H08) :

1. Avant le rendez-vous : le modèle de mandat est validé, le barème et le registre sont réglés.
2. Au rendez-vous : l'agent valide l'avis de valeur, voit la pièce d'identité du vendeur et l'enregistre (`POST /v1/fiches/<id>/identite`, sans numéro ni copie), génère le mandat (`POST /v1/documents`), le contrôle (`POST /v1/documents/<id>/controle`), le fait signer sur papier, puis l'enregistre avec la référence du scan (`POST /v1/documents/<id>/signature-papier`).
3. Après : la direction lit la chronologie (`GET /v1/mandats/<id>/chronologie`). `totalSeconds` est le temps de la validation de l'avis au numéro ; `underTarget` dit s'il est sous 10 minutes. La chronologie ne porte que des instants et des durées, aucune donnée personnelle.

# Chiffres identiques au comptage manuel (M13, K08)

Le critère de la Feuille de route pour juin 2027 : pendant 2 semaines, les chiffres d'AIMMO sont identiques au comptage manuel (H27).

## Chaque jour ouvré

1. Shawez tient à la main, hors du dépôt, pour la veille : contacts reçus, rendez-vous tenus, mandats signés, ventes (actes signés) et honoraires de ces ventes, par agent.
2. La direction télécharge l'export du même jour :

```
curl -H "Authorization: Bearer <clé de la direction>" "https://<adresse du Worker>/v1/pilotage/export-quotidien?jour=AAAA-MM-JJ" -o chiffres-AAAA-MM-JJ.csv
```

3. Le fichier, séparé par des points-virgules, a une ligne par agent (`direction` pour les contacts qu'elle garde) et une ligne `total` :

```
jour;agent;contacts;rendez_vous_tenus;mandats_signes;ventes;honoraires_eur
```

Ses quatre premiers chiffres sont ceux du tableau de bord du réseau pour ce jour (`/v1/pilotage/reseau?du=AAAA-MM-JJ&au=AAAA-MM-JJ`), lus par lui : les tests vérifient que l'export du jour égale le tableau de bord. Les honoraires sont ceux, en euros, des ventes du jour, tels qu'au mandat signé.

4. Chaque écart se note avec sa cause (contact saisi hors d'AIMMO, rendez-vous non marqué « tenu », acte non rapporté…). Le critère est rempli après 10 jours ouvrés de suite sans écart. Le comptage manuel ne vient jamais dans le dépôt.

## Le parcours de l'agent sur téléphone (AU106)

Le poids compressé d'un écran ne dit pas combien de temps l'agent attend. Le test `packages/api/test/parcours-telephone.test.ts` rejoue, à chaque vérification, trois gestes sur un portefeuille chargé et inventé (1 000 clients, 4 messages et 1 rappel chacun, 400 biens en vente) :

| Étape | Geste | Seuil au 95e centile |
| --- | --- | --- |
| ouverture | `GET /v1/fiches/<id>/resume` | 1 000 ms |
| recherche | `POST /v1/recherche/phrase` | 1 500 ms |
| sauvegarde | `POST /v1/rappels/<id>/fait` | 1 000 ms |

Le temps d'une étape, par 30 échantillons : un aller-retour du réseau, le temps du serveur mesuré, 5 ms par requête à la base (le coût d'une requête D1), l'envoi au débit montant et la réponse compressée au débit descendant. Le réseau modélisé est une « 4G lente » : 150 ms d'aller-retour, 1 600 kbit/s descendant, 750 kbit/s montant (`packages/core/src/design/parcours.ts`). Aucune étape ne dépasse 40 requêtes : le nombre de requêtes ne dépend pas de la taille du portefeuille. Les mesures sont écrites dans le rapport de la vérification (ligne `AU106 · 4G lente : …`).

Ce que la mesure a trouvé : la recherche par phrase faisait environ 1 300 requêtes pour 400 biens (trois lectures par bien, plus la diffusion de chacun), soit plus de 7 secondes sur ce réseau. Elle lit désormais tous les biens en trois requêtes et ne demande la diffusion qu'aux biens qu'elle montre, dans l'ordre où ils sont montrés : une dizaine de requêtes [R42].

Ce que ce test ne prouve pas : la vitesse sur un vrai téléphone, un vrai réseau et la vraie base D1. C'est un modèle prudent ; une mesure sur l'appareil d'un agent pilote reste à faire.
