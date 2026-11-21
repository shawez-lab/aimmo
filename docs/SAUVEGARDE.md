# La copie de la base et de ses fichiers

Trois filets : la restauration à un instant passé de D1 (Time Travel), rien à coder ; la copie chiffrée de chaque nuit, hors de D1 ; le test de restauration de chaque mois (SV03).

## Chaque nuit

Le travail GitHub « Copie de nuit » s'allume avec la variable `COPIES_ACTIF` (`chantier/HUMAIN.md`, H50). Il note l'instant, photographie la base (`wrangler d1 export`), la charge dans une base SQLite neuve, prend la copie chiffrée, la range dans `aimmo-copies`, la restaure depuis ce compartiment dans une base jetable pour prouver qu'elle est identique, et écrit son compte rendu dans `base_copy_runs`. La photo est détruite à la fin, même après un échec. La sortie de wrangler reste muette, car elle donne un lien de téléchargement de toute la base, et une photo coupée par une panne n'est jamais chargée.

D1 peut répondre moins vite pendant la photo : c'est pourquoi elle se prend à 2 h 23 ou 3 h 23, heure de Paris. Le travail consomme quelques minutes de quota GitHub par nuit : à surveiller, décision du 2026-10-29.

## Ce que voit la direction

Écran du réseau, bloc « La copie de la base » : la date de la dernière copie réussie, le dernier échec et sa raison, les nuits sans copie. De 6 h à 8 h, le Worker alerte si aucune copie réussie n'est arrivée depuis la veille à 6 h. Il n'a pas besoin du travail pour cela : si GitHub Actions est à l'arrêt, l'alerte arrive quand même.

## Chaque mois

Le 2 du mois, le travail « Test de restauration » restaure la dernière copie dans une base en mémoire, jamais en production, et range le reçu. Il prend le même allumage et les mêmes secrets que la copie. L'écran du réseau lit le reçu, bloc « La preuve de restauration, ce mois-ci » ; à partir du 4, un mois sans reçu se dit « manquant ». Ce test ne rejoue pas les effacements : sa base est jetée.

## Les fichiers (AU019)

Une copie de la seule base ne rend pas un dossier : les photos, les scans signés et les pièces du coffre vivent dans les stockages d'objets, pas dans la base. `copyObjects` copie tous les objets des quatre stockages (`MEDIA`, `PIECES`, `COMMERCES`, `COFFRE`) sous la date de la copie de la base, préfixe `copies/<copie>/objets/` : chaque objet chiffré et lié à sa place, et un sommaire chiffré, écrit en dernier, qui garde son stockage, son nom, sa taille et son empreinte. Le compartiment ne voit que des numéros. Si un stockage manque, rien n'est copié. Chaque nuit recopie tout : une copie ne dépend jamais d'une plus ancienne, que la garde de 30 jours effacerait.

`restoreExercise` restaure la base dans une base neuve, puis chaque objet dans des stockages neufs, relit chacun et compare son empreinte, et vérifie que chaque fichier cité par la base restaurée est là. Une copie sans ses objets, un objet abîmé, manquant ou différent, un fichier cité absent : l'exercice échoue, jamais « restauré ».

Chaque nuit (AU019b), le travail « Copie de nuit » prend la base puis tous les fichiers des quatre compartiments (`aimmo-medias`, `aimmo-pieces`, `aimmo-commerces`, `aimmo-coffre`), lus par l'API S3 de R2 en Europe, liste page après page, avec une clé en lecture seule à part (`OBJETS_R2_ACCESS_KEY_ID`, `OBJETS_R2_SECRET_ACCESS_KEY`, H74). Chaque fichier est ensuite relu depuis le compartiment des copies et comparé à son empreinte, sans tout tenir en mémoire. Chaque fichier cité par la photo de la base doit être dans la copie. Sans cette clé, si un compartiment ne se lit pas, ou si un fichier cité manque, la nuit est « non sauvegardée » : une base sans ses fichiers ne rend pas les dossiers.

Le test du mois passe par `restoreExercise` : base et fichiers, et `fileReferences` relève dans toutes les tables (sauf le journal, qui cite des fichiers effacés depuis) chaque valeur, entière ou dans un JSON, qui a la forme d'une clé de stockage (voir `REFERENCE_PREFIXES` : biens, dossiers, preuves, offres, mandats, location, commerces, coffre…), et chaque colonne `storage_ref`. Un fichier cité absent de la copie : « non identique ». Une fausse alerte vaut mieux qu'un faux « restauré ». L'empreinte du reçu couvre la base et les fichiers.

## La preuve de l'allumage (AU109)

Le bloc « La copie de la base » dit « Copie prouvée » seulement quand une copie réussie est arrivée depuis la veille à 6 h et qu'un test de restauration du mois attendu a réussi ; sinon « Copie non prouvée ». L'allumage (H50) n'est donc jamais supposé : tant que les deux reçus manquent, l'écran le dit. De 6 h à 8 h, le Worker lève aussi une alerte, une seule par mois, quand le reçu réussi du mois manque une fois le jour attendu passé (`base_restore_alerts`, `base.restauration_manquee`) : comme pour la copie de chaque nuit, il n'a pas besoin du travail GitHub pour cela.

## Garde

30 jours pour chaque copie (préfixe `copies/`), par la règle du compartiment (H50) : le logiciel ne supprime rien, et sa clé limitée aux objets ne peut pas lire cette règle. L'écran ne l'affirme donc pas ; à vérifier dans Cloudflare. Le registre des effacements (préfixe `effacements/`) n'expire pas.

## Restaurer

`restoreWithErasures` restaure dans une base neuve, prouve qu'elle est identique, puis refait chaque effacement fait depuis la copie, à partir du registre. Une restauration n'est finie qu'après ce rejeu. Une copie ne se restaure jamais par-dessus une base : rien n'est écrasé.

`restoreEverything` (AU021, `sauvegarde/restauration-complete.ts`) est la restauration complète : la base et les fichiers de la même copie dans une base neuve et quatre stockages neufs, chacun relu contre son empreinte, puis le registre rejoué par le véritable effaceur (`SqlPersonEraser`, AU020), branché sur les stockages restaurés. Une ligne effacée emporte ses fichiers que plus rien ne cite ; un fichier qu'une autre personne cite encore reste, le coffre aussi. Un stockage restauré qui ne sait pas retirer un fichier est refusé avant toute écriture ; une entrée illisible, une ligne ou un fichier qui reste : la restauration n'est pas dite finie. Le registre se lit dans `aimmo-copies` par la liste S3 du préfixe `effacements/` (`r2CopyStore`), page après page ; une liste refusée ou coupée ne passe jamais pour un registre vide.

Rien ne relit la base de production automatiquement ; passer une base restaurée en production reste un geste humain, à faire avec D1 et après relecture du résultat.
