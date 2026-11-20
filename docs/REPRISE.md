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
| Ne pas déranger | tout en-tête qui contient `DND`, `Unsub`, `Opt Out`, `Désabonn`, `Désinscri`, `Stop`, `Blocked`, `Ne pas déranger`, `Do Not Disturb` (`DND Status`, `Email DND`…) : toute valeur autre que vide, `false`, `non`, `0`, `off` vaut arrêt |
| Abonné | `Subscribed`, `Opt In`, `Abonné`, `Subscription Status`, et `Status` pour ManyChat seulement : seules `yes`, `true`, `oui`, `1`, `active`, `actif`, `subscribed`, `abonné` ou une date d'abonnement disent « abonné » ; toute autre valeur, vide comprise, vaut arrêt |
| Étiquettes | `Tags`, `Étiquettes`, `Labels` : une étiquette qui contient un des mots de « Ne pas déranger » vaut arrêt |

Un export de GoHighLevel ou de ManyChat sans aucune de ces trois dernières colonnes est refusé : les arrêts seraient perdus.

Trois fichiers :

- `liste-exclusion.csv` : la liste d'exclusion de Shawez, une personne par ligne ;
- `gohighlevel.csv` : l'export de tous les contacts de GoHighLevel, avec la colonne « DND » ;
- `manychat.csv` : l'export des abonnés de ManyChat, avec leur statut d'abonnement.

Ces fichiers contiennent des données personnelles : **jamais dans le dépôt**. La direction les dépose dans l'application, écran du réseau, bloc « Reprise des contacts existants » (I05) : ils sont rangés dans la base `aimmo`, nulle part ailleurs.

## Ce qui est signalé

- Une ligne sans aucune coordonnée valable est rapportée par son numéro de ligne, pour être regardée à la main.
- Une ligne avec une coordonnée illisible à côté d'une lisible est reprise, et rapportée par son numéro pour être complétée.
- Une fiche retrouvée mais suivie par un autre agent n'est pas réunie : la direction attribue la personne ; les exclusions valent pour toutes ses fiches.
- Le rapport et le journal ne contiennent que des nombres et des identifiants internes [R13].

## Reprise réelle et contrôle sur 50 fiches (I04)

`RepriseReelle.run(base du site, fichiers)` enchaîne la base du site, lue en lecture seule, puis `liste-exclusion.csv`, `gohighlevel.csv` et `manychat.csv`. Les trois fichiers sont exigés et tous lus avant la première écriture : un fichier manquant, vide ou illisible arrête tout, rien n'est écrit, car des exclusions seraient perdues.

Puis 50 contacts repris sont tirés au hasard (tous s'il y en a moins). Pour chacun, le contrôle cherche ses fiches par son origine et par chacun de ses identifiants :

- **doublon** : plusieurs fiches du même agent, que la reprise aurait dû réunir ;
- **à attribuer** : des fiches suivies par des agents différents, laissées à part pour la direction (ce n'est pas un échec) ;
- **exclusion manquante** : la personne est exclue à la source (liste d'exclusion, désabonnement, demande « Perdu ») mais une de ses fiches n'a aucune exclusion en cours ;
- **introuvable** : aucune fiche après la reprise.

Le contrôle est vert sans doublon, sans exclusion manquante et sans contact introuvable. Son résultat, seulement des nombres, est écrit au journal (`reprise.controle`).

## Lancement sur les vraies bases (I05)

1. **Dépôt.** La direction choisit les trois fichiers dans l'application (écran du réseau) et les dépose. Chacun est vérifié au dépôt : un fichier illisible est refusé, rien n'est rangé. Un nouveau dépôt s'ajoute au précédent, le dernier compte. « Où en est la reprise » montre ce qui est déposé et l'avancement.
2. **Lancement.** Le travail GitHub « Reprise des contacts » est lancé à la main, depuis main (la séance de Claude le lance par l'API REST de GitHub quand les trois fichiers sont là). Il trouve les bases `aimmo` et `espace-estimation` par leur nom dans le compte Cloudflare, applique les migrations de `aimmo`, puis lance `packages/api/outils/reprise.ts`.
3. **Déroulé.** Rien ne tourne sans les trois fichiers, déposés pour un seul réseau et un seul agent. Tout est lu avant la première écriture ; la base du site est lue par des `SELECT` seulement. Puis la reprise passe source par source, par morceaux de 100 contacts ; après chaque morceau, l'avancement est rangé (`reprise_avancement`). Avant la fin de son temps (300 minutes par défaut), le travail s'arrête proprement : relancé, il reprend au morceau suivant. Un morceau coupé net est refait, ce qui ne double rien ; de nouveaux fichiers font repartir du début, sans rien doubler non plus ; de nouveaux contacts sur le site entre deux lancements ne font pas repartir les fichiers : la source « site » est refaite en entier à la fin (`site_again` dans le résumé), ce qui ne double rien. Une fois fini, relancé sur les mêmes données, il n'écrit plus rien.
4. **Compte rendu.** Le résumé du travail donne, par source, les nombres lus, créés, retrouvés, réunis, mis à part, les exclusions, les numéros des lignes illisibles ou à compléter, et le contrôle sur 50 personnes. Aucune donnée personnelle [R13]. Code de sortie : 0 fait (ou à suivre), 1 contrôle rouge ou erreur, 2 rien n'a tourné.

Une requête refusée par la limite de l'API (429, jamais exécutée) est refaite après l'attente demandée. Après une panne (5xx, réseau), seule une lecture est refaite ; une écriture ne l'est jamais (elle pourrait doubler) : le travail échoue et se relance.

Les textes déposés ne sont rattachés à aucune fiche ; ils restent pour relancer la reprise, puis seront purgés par la procédure d'effacement de la conformité (leurs morceaux seuls peuvent s'effacer ; un dépôt purgé est refusé par la reprise). Une coupure entre la création d'une fiche et sa clé de reprise peut laisser une fiche vide, sans identifiant ni clé : elle ne double aucune personne.

## Import d'un agent (J05)

Un agent qui rejoint le réseau dépose un export CSV de Hektor, Apimo, Excel ou Google Contacts (`ImportAgent.run`). Les vrais exports ne vont jamais dans le dépôt.

**Contacts.** Il faut au moins une colonne de mail ou de téléphone. Colonnes reconnues (sans accents, casse, espaces ni ponctuation) : identifiant ou référence ; mail (`Email`, `Mail`, `E-mail 1 - Value`…) ; téléphone (`Téléphone portable`, `Tel`, `Phone 1 - Value`…) ; prénom, nom ; `N° mandat` ou `Mandat` ; `Vente` ou `Date de vente` ; `Date accord`, `Preuve accord`, `Finalité`, `Canal accord` ; `Désinscrit`, `Opposition`, `Ne pas contacter`.

Chaque contact est trié par ce que l'export prouve, et rien d'autre [R84] :

- **client** : un mandat ou une vente est rempli pour lui ;
- **accord prouvé** : une date passée (`AAAA-MM-JJ` ou `JJ/MM/AAAA`), une preuve et une finalité de la liste fermée (prospection, alertes, suivi) ; l'accord est rangé tel quel, pour cette finalité, sur le canal dit ou, à défaut, sur le mail et le téléphone de la ligne ;
- **sans base** : rien de cela. Aucun accord n'est créé : le contrôle central refuse tout premier message [R03].

Un accord incomplet, daté dans le futur ou sur un canal inconnu ne vaut rien et sa ligne est signalée. Une désinscription vaut arrêt sur tous les canaux [R04]. Une personne déjà suivie par un autre agent, ou sans agent, n'est pas touchée : elle va à la direction (`ImportAgent.referrals`) [R16]. L'import se relance sans rien doubler [R18] et n'envoie rien.

**Biens.** Colonnes `Référence` et `Type` obligatoires ; `Code postal`, `Ville`, `Surface`, `Pièces`, `Prix` lus s'ils sont là. L'adresse n'est jamais lue. Chaque bien est rangé à l'agent, en brouillon : l'import ne publie rien. Un type inconnu ou une référence manquante : ligne signalée, jamais devinée.

**Échanges, notes de suivi et prochains rappels (AU029).** Le même dépôt peut porter l'historique de l'ancien logiciel (`history`) : actions, échanges, commentaires, tâches. Colonnes reconnues : le contact (`Id contact`, `Réf contact`… : l'identifiant de l'export des contacts, du même logiciel ; à défaut son mail ou son téléphone) ; `Date` ; `Échéance`, `Date rappel`, `Prochaine action` ; `Type`, `Action`, `Canal` ; `Commentaire`, `Note`, `Compte rendu`, `Objet` ; `Statut`, `État`, `Fait`. Il faut une colonne de date et une colonne de contact.

- Un échange passé (appel, mail, SMS, WhatsApp, rendez-vous, visite) ou une note est rangé sur la fiche, à sa date d'origine, avec son texte (2000 signes gardés au plus ; au-delà, coupé et signalé).
- Une ligne avec une échéance pas faite, une tâche pas faite ou une action datée dans le futur devient un rappel de l'agent, en retard si l'échéance est passée. Un rappel est une tâche : rien ne part tout seul. L'agent le marque fait, une fois, jamais défait.
- Une ligne n'est rattachée qu'à une fiche de l'agent qui importe. Elle n'est pas reprise, et le bilan la dit par son numéro de ligne et sa raison, quand elle n'a aucun contact (`no_contact`), un contact introuvable (`unknown_contact`), un contact suivi par un autre agent (`other_agent`, sa fiche n'est pas touchée), un contact que deux fiches portent (`ambiguous_contact`), aucune date lisible ou une date qui ne dit pas vrai (`no_date`), un type inconnu (`unknown_type`), ou une note sans texte (`empty`). Rien n'est deviné.
- Relancé, l'import ne double rien. Au journal, des nombres seulement : jamais un texte d'échange [R13].

