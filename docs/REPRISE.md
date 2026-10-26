# Reprise des contacts existants (S10)

La reprise range dans la fiche client unique les contacts qui existent déjà ailleurs, sans jamais rien écrire dans les sources ni rien effacer. Relancée, elle ne double rien.

## Sources, dans l'ordre

1. **La base `espace-estimation` du site** (I01, I02) : comptes et demandes d'estimation, lus en lecture seule.
2. **La liste d'exclusion de Shawez** (I03) : chaque personne devient ou rejoint sa fiche, exclue sur tous les canaux [R02].
3. **GoHighLevel** et **ManyChat** (I03) : contacts, avec leurs désinscriptions, qui deviennent des arrêts sur tous les canaux [R04].

Aucun accord n'est repris de GoHighLevel ni de ManyChat : faute de preuve, ces contacts ne peuvent pas être démarchés [R03]. Du site, seul l'accord de suivre l'estimation demandée est repris.

## Les fichiers à exporter (H15)

Des fichiers CSV, séparés par des virgules, des points-virgules ou des tabulations, avec une ligne d'en-tête. Les noms de colonnes sont reconnus sans tenir compte des accents ni des majuscules. Il faut au moins une colonne de mail, de téléphone ou d'Instagram.

| Colonne | Noms reconnus |
| --- | --- |
| Identifiant de l'outil | `Id`, `Contact Id`, `User ID`, `Subscriber ID` |
| Mail | `Email`, `E-mail`, `Mail`, `Courriel` |
| Téléphone | `Phone`, `Téléphone`, `Mobile`, `Portable`, `WhatsApp` |
| Instagram | `Instagram`, `Instagram Username`, `IG Username` |
| Prénom, nom | `First Name`, `Prénom`, `Last Name`, `Nom` |
| Ne pas déranger | `DND`, `Do Not Disturb`, `Ne pas déranger`, `Unsubscribed`, `Désabonné`, `Opt Out`, `DND Email`, `DND SMS`… : toute valeur autre que vide, `false`, `non` ou `0` vaut arrêt |
| Abonné | `Subscribed`, `Opt In`, `Abonné`, `Status` : `no`, `false`, `non`, `0`, `unsubscribed` valent arrêt |

Trois fichiers :

- `liste-exclusion.csv` : la liste d'exclusion de Shawez, une personne par ligne ;
- `gohighlevel.csv` : l'export de tous les contacts de GoHighLevel, avec la colonne « DND » ;
- `manychat.csv` : l'export des abonnés de ManyChat, avec leur statut d'abonnement.

Ces fichiers contiennent des données personnelles : **jamais dans le dépôt**. Ils seront déposés là où la tâche I04 l'indiquera, hors du dépôt.

## Ce qui est signalé

- Une ligne sans aucune coordonnée valable est rapportée par son numéro de ligne, pour être regardée à la main.
- Une fiche retrouvée mais suivie par un autre agent n'est pas réunie : la direction attribue la personne ; les exclusions valent pour toutes ses fiches.
- Le rapport et le journal ne contiennent que des nombres et des identifiants internes [R13].
