# La copie de la base

Trois filets : la restauration à un instant passé de D1 (Time Travel), rien à coder ; la copie chiffrée de chaque nuit, hors de D1 ; le test de restauration de chaque mois (SV03).

## Chaque nuit

Le travail GitHub « Copie de nuit » s'allume avec la variable `COPIES_ACTIF` (`chantier/HUMAIN.md`, H50). Il note l'instant, photographie la base (`wrangler d1 export`), la charge dans une base SQLite neuve, prend la copie chiffrée, la range dans `aimmo-copies`, la restaure depuis ce compartiment dans une base jetable pour prouver qu'elle est identique, et écrit son compte rendu dans `base_copy_runs`. La photo est détruite à la fin, même après un échec. La sortie de wrangler reste muette, car elle donne un lien de téléchargement de toute la base, et une photo coupée par une panne n'est jamais chargée.

D1 peut répondre moins vite pendant la photo : c'est pourquoi elle se prend à 2 h 23 ou 3 h 23, heure de Paris. Le travail consomme quelques minutes de quota GitHub par nuit : à surveiller, décision du 2026-10-29.

## Ce que voit la direction

Écran du réseau, bloc « La copie de la base » : la date de la dernière copie réussie, le dernier échec et sa raison, les nuits sans copie. De 6 h à 8 h, le Worker alerte si aucune copie réussie n'est arrivée depuis la veille à 6 h. Il n'a pas besoin du travail pour cela : si GitHub Actions est à l'arrêt, l'alerte arrive quand même.

## Garde

30 jours pour chaque copie (préfixe `copies/`), par la règle du compartiment (H50) : le logiciel ne supprime rien, et sa clé limitée aux objets ne peut pas lire cette règle. L'écran ne l'affirme donc pas ; à vérifier dans Cloudflare. Le registre des effacements (préfixe `effacements/`) n'expire pas.

## Restaurer

`restoreWithErasures` restaure dans une base neuve, prouve qu'elle est identique, puis refait chaque effacement fait depuis la copie, à partir du registre. Une restauration n'est finie qu'après ce rejeu. Une copie ne se restaure jamais par-dessus une base : rien n'est écrasé.

Rien ne relit la base de production automatiquement ; passer une base restaurée en production reste un geste humain, à faire avec D1 et après relecture du résultat.
