# Plan du chantier

Statuts possibles : `à faire`, `en cours`, `chez Codex depuis le <date>`, `fait (<date>)`, `bloquée : <raison>`.
Relecture : `normale` = tests + relecture de Codex. `forte` = tests + relecture de Codex + relecture par un agent séparé.
Les tâches se font dans l'ordre, dès que leurs dépendances sont faites. Le découpage des modules suivants se fait au fil de l'eau (protocole, section 5).

## Priorité de Shawez (avant tout le reste, voie 1)

### Z02 · Accès de Shawez à l'application en un clic
- Statut : fait (2026-10-28)
- Décidé (2026-10-28) : le secret `API_KEYS` n'est ni lu ni réécrit (un secret ne se lit pas : le réécrire perdrait ses empreintes) ; les clés d'invitation sont rangées en base (empreinte seule, `access_keys`) et s'ajoutent au secret ; le Worker les tire au moment où le lien sert ; le mail part par l'envoi de mails de Cloudflare, depuis le travail ; exception au contrôle central écrite en R200 (Codex la classait P0, réfutée dans #148).
- Qui : Claude, relecture forte
- Dépendances : aucune
- Objectif : l'application https://aimmo-api.shawez.workers.dev/app/ répond « API fermée : aucune clé configurée ». Shawez doit pouvoir entrer sans rien taper de technique. Un workflow GitHub lancé à la main (« Créer l'accès de Shawez ») tire une clé au hasard, range seulement son empreinte dans le secret `API_KEYS` du Worker avec `wrangler secret put` (le jeton Cloudflare est déjà dans les secrets du dépôt), crée la fiche agent de Shawez avec le rôle direction et agent, et lui remet la clé par un lien d'invitation à usage unique, valable 24 heures, envoyé à shawez@gravelin-immo.com. La clé n'apparaît jamais dans les journaux, le dépôt ni le chat. Le lien ouvre l'application déjà connectée.
- Critères : clé jamais écrite en clair hors du navigateur de Shawez (test) ; lien à usage unique, expiré refusé (test) ; empreintes déjà présentes dans `API_KEYS` conservées (test) ; journal sans clé (test [R13]).
- Ce qu'elle attend d'un humain : rien. Une fois fusionnée, la séance lance elle-même le workflow ; Shawez n'a qu'à cliquer sur le lien reçu par mail.

### Z04 · Lien d'accès de Shawez sans mail Cloudflare
- Statut : fait (2026-10-28)
- Décidé (2026-10-28) : entrée `remise` (`mail` par défaut, `resume`) ; en `resume`, le lien n'est écrit que dans `GITHUB_STEP_SUMMARY` ; prénom, nom et adresses lus dans l'événement du lancement, jamais dans l'environnement affiché des étapes ; prénom et nom non masqués en `resume` (le masque de GitHub casserait le lien du résumé) ; relecture forte 2 P1, Codex 1 P0 corrigés (#161) ; travail lancé le 2026-10-28 à 21:53 en `resume`, réussi.
- Qui : Claude, relecture forte
- Dépendances : Z02
- Objectif : l'envoi par Cloudflare échoue toujours (HTTP 401, code 10000, H33 non réglé). Ajouter au travail « Créer l'accès de Shawez » un mode de remise sans mail : le lien à usage unique, valable 24 heures, est écrit seulement dans le résumé du travail GitHub (dépôt privé, visible du seul compte shawez-lab), jamais dans les journaux du travail ni dans le dépôt. Puis lancer le travail dans ce mode et noter dans « Besoin de toi » : « Ton lien t'attend dans GitHub : Actions > Créer l'accès de Shawez > dernier passage > Summary. »
- Critères : le lien n'apparaît pas dans la sortie du travail (test) ; le mode mail reste le défaut (test) ; lien à usage unique et expiré refusé (tests de Z02 repris).

### Z05 · Le lien d'accès ne doit jamais être brûlé par une simple ouverture
- Statut : fait (2026-11-06)
- Reste : fusionnée (#378). Relecture forte sans P0 ni P1 ; Codex sans remarque ; vérification GitHub verte. Un lien déjà brûlé ne revit pas : relancer « Créer l'accès de Shawez » en mode `resume` pour un nouveau lien.
- Qui : Claude, relecture forte
- Dépendances : aucune
- Objectif : le 2026-11-06, le premier lien de Shawez était « déjà servi » quand il l'a ouvert : un aperçu de lien, un navigateur intégré ou une double ouverture l'a consommé. Ouvrir le lien (GET) ne doit rien consommer : la page affiche un seul bouton « Entrer sur ce téléphone », et seul ce clic (POST) consomme l'invitation et range la clé.
- Critères : un GET répété ne consomme rien (test) ; seul le POST consomme, une seule fois (test) ; lien expiré refusé (test).

### Z03 · Passe de design de l'application et des pages publiques
- Statut : fait (2026-10-28)
- Décidé (2026-10-28) : identité « toits vernissés de Bourgogne » (papier, encre, bordeaux, moutarde, losange des tuiles), polices du système, base unique `packages/core/src/design/systeme.ts`, contrôle dans `audit.ts`, règle R201 ; budgets 14 Ko (page) et 48 Ko (application) compressés ; captures dans `docs/design/captures/` ; axe-core sans violation sur 9 écrans, clair et sombre ; relecture forte 2 P1 et 2 défauts corrigés ; Codex en cours au bout de 15 min, fusion sans lui (#152). U11 peut reprendre.
- Qui : Claude, relecture forte
- Dépendances : Z02
- Objectif : un système de design propre à AIMMO (couleurs, typographie, espacements, composants, mouvements) appliqué à tous les écrans existants, téléphone d'abord. Rien de générique ni qui ressemble à un site fait par une IA ; niveau des meilleures applis du monde. Captures avant et après dans la proposition.
- Critères : chaque écran passe un contrôle d'accessibilité automatique et un budget de performance (tests) ; aucun écran en dehors du système de design (test) ; Codex relit aussi les captures.

## Audit exigeant du 2026-11-18 (demande de Shawez, avant le reste de la phase 3)

Audit de ChatGPT, joué en agent immobilier très exigeant, sur le commit `b51e138` : 117 points (21 bloquants, 90 majeurs, 6 mineurs). Ids `AU` = numéro de l'audit ; dans « endroit », C/ = `packages/core/src/`, A/ = `packages/api/src/`, UI/ = `packages/api/app/`. Règle pour chaque tâche : **vérifier d'abord le constat sur le code actuel**. S'il est faux ou déjà réglé, passer à « fait (non confirmé : <preuve>) » sans rien coder. Sinon, corriger avec un test par critère. Le code et les tests se font même quand la mise en service réelle attend un humain : ce qui reste à brancher va dans « Reste » et dans `HUMAIN.md`. Les points juridiques (statut, mentions, plafonds) suivent le texte officiel cité, daté dans la règle. Ordre conseillé par l'audit : mandat (AU001-003, 059, 060), pièces de la vente (AU009-011), diffusion conforme (AU004-007, 012, 067, 068), visite hors connexion (AU018, 103-105), canaux réels (AU008, 032-045), rapprochement (AU039-042, 070-074), agenda (AU053-056), sécurité des dossiers (AU019-021, 107-111), finances (AU013, 091-095), location (AU014-017, 096-099).

### AU001 · Je ne peux pas signer le mandat d’un couple ou d’une indivision
- Statut : fait (2026-11-18)
- Reste : fusionnée (#659). Constat confirmé. Relecture forte : 3 P1, dont 2 corrigés et 1 passé à AU001b. Codex : 9 P0, tous corrigés, puis plus aucune remarque ; vérification GitHub verte. Nouvelle option `sharedIf` dans la carte d'accès : le texte d'un mandat n'est masqué que s'il a plusieurs mandants. Espace client du second mandant : AU001b. La signature en ligne reste d'essai (H24).
- Qui : Claude, voie 1 · Relecture : forte · Dépend de : rien
- Cahier : M06 Mandats et documents ; audit A001 (bloquant), endroit : C/documents/controles.ts, `mandants`, R41.
- Constat de l'audit : Je ne peux pas signer le mandat d’un couple ou d’une indivision : le contrôle exige un seul propriétaire.
- Objectif : Un mandat avec deux propriétaires distincts se signe seulement après identification et signature des deux, sans fusionner leurs fiches.
- Critères : le constat est d'abord reproduit par un test qui échoue, puis passe ; le critère de l'audit est vérifié par un test (test) ; les règles touchées dans `docs/REGLES.md` sont mises à jour.
- Source : [Modelo ajoute chaque indivisaire](https://support.modelo.fr/aide/enregistrer-une-indivision).
- Attend : rien.

### AU001b · Le second mandant voit son mandat dans son espace
- Statut : fait (2026-11-18)
- Reste : fusionnée (#661, `92eb1fa7`). Constat confirmé (le second mandant n'avait aucun côté). Chaque mandant d'un mandat vivant compte pour l'espace vendeur (`LIVE_MANDATE_MANDANTS`) ; documents du mandant ou d'un mandant en plus seulement ; numéro du registre montré [R39] ; R161 complétée. Relecture forte : aucun P0 ni P1 ; Codex rien à signaler ; vérification GitHub verte (en local, un test Y05 dépasse 5 s, machine lente, sans lien). Restent : l'espace propriétaire (`ownerWindows`) ne compte que le premier mandant ; un test de l'avenant dans l'espace du second mandant.
- Qui : Claude, voie 1 · Relecture : forte · Dépend de : AU001
- Cahier : M06 Mandats et documents ; M11 Après-vente (espaces des clients).
- Trouvé par la relecture forte de AU001 : l'espace vendeur et l'espace propriétaire s'ouvrent par `mandates.person_id`, donc par le seul premier mandant. Un autre mandant d'un mandat signé n'a pas d'espace, et ne voit ni son mandat ni son numéro [R39].
- Objectif : chaque mandant d'un mandat signé (`document_co_mandants`) a son espace vendeur, avec le mandat, son numéro et ses avenants, sans rien voir de la fiche de l'autre mandant.
- Critères : le second mandant voit le mandat et son numéro (test) ; rien de l'autre mandant dans son espace [R16] (test) ; le premier mandant voit toujours le sien (test).
- Attend : rien.

### AU002 · Mon mandat généré ne peut pas reprendre par champs l’adresse du bien, sa désignation cadastrale et le…
- Statut : fait (2026-11-18)
- Reste : fusionnée (#663, `ba4fb304`). Constat confirmé. Adresse et parcelles du bien (`property_designations`), domicile de chaque mandant (`person_domiciles`), saisis à l'écran « Mandat » et repris par le mandat ; modèle sans leur place refusé, document sans valeur incomplet, et le contrôle arrête aussi un mandat d'avant AU002 (P0 de Codex corrigé). Relecture forte : 1 P1 corrigé (domicile à l'étranger). R40 complétée. À faire hors code : donner ces trois places aux modèles réels (H08). Piste : préremplir depuis l'état des risques.
- Qui : Claude, voie 1 · Relecture : forte · Dépend de : rien
- Cahier : M06 Mandats et documents ; audit A002 (bloquant), endroit : C/documents/modeles.ts, `TEMPLATE_FIELDS`.
- Constat de l'audit : Mon mandat généré ne peut pas reprendre par champs l’adresse du bien, sa désignation cadastrale et le domicile du mandant.
- Objectif : Ces champs structurés figurent dans chaque exemplaire signé et toute désignation obligatoire manquante empêche son état « complet ».
- Critères : le constat est d'abord reproduit par un test qui échoue, puis passe ; le critère de l'audit est vérifié par un test (test) ; les règles touchées dans `docs/REGLES.md` sont mises à jour.
- Attend : rien.

### AU003 · La signature électronique proposée reste une signature d’essai, inutilisable pour conclure mon mandat réel
- Statut : fait (2026-11-18)
- Reste : fusionnée (#669, `3c8e80da`), migration `3980`, R41 complétée. Constat reproduit (aucune voie vers une signature réelle). Décidé, lecture prudente : une session n'est réelle que si la direction a enregistré la validation de l'avocat pour le format `aimmo-preuve-1` (H24) et que le mail réel est donné (H05) ; sinon essai, dit au résultat, au code, à l'exemplaire et à l'écran « Mandat ». Mode fixé à l'ouverture (la base le garde). Seul un mandat de vente se signe en réel. Signé réellement par tous : mandat inscrit (lieu « distance », source R38 donnée à `fin` si la fiche ne l'a pas), dossier de preuve figé sans nom, exemplaire et dossier joints au mail de remise de chaque mandant (`attachments`, canal réel seulement) ; remise notée seulement sur accusé du canal, essai abandonné remplacé après une heure. Relecture forte 4 P1 corrigés ; Codex 5 P0 corrigés en 3 tours, puis rien à signaler. Restent : l'API ne donne encore aucun canal réel (H05) ; l'adaptateur du mail réel devra joindre `attachments` ; avenant signé en ligne réel (inscription à `signed_amendments`) ; dossier de preuve dans l'espace vendeur ; routes de l'exemplaire par session disent encore `mode: essai`.
- Qui : Claude, voie 1 · Relecture : forte · Dépend de : rien
- Cahier : M06 Mandats et documents ; audit A003 (bloquant), endroit : A/app.ts, routes de signature ; H24.
- Constat de l'audit : La signature électronique proposée reste une signature d’essai, inutilisable pour conclure mon mandat réel.
- Objectif : Un parcours réel remet à chaque partie l’exemplaire signé et son dossier de preuve validé juridiquement ; l’interface distingue explicitement essai et réel.
- Critères : le constat est d'abord reproduit par un test qui échoue, puis passe ; le critère de l'audit est vérifié par un test (test) ; les règles touchées dans `docs/REGLES.md` sont mises à jour.
- Source : [Modelo documente la cérémonie réelle](https://support.modelo.fr/aide/signer-un-document-%C3%A9lectroniquement).
- Attend : rien (mise en service réelle : H24).

### AU004 · Je dois garder mon ancien logiciel pour publier sur les portails
- Statut : fait (2026-11-19)
- Reste : fusionnée (#675, `1d14b873`), migration `4010`, R668 en service. Constat confirmé (seul le flux XML d'essai). Décidé, lecture prudente : les portails sont ceux de HX38 (réglés actifs par la direction, choisis pour le bien, sans retrait temporaire, champs exigés remplis) ; chaque passage envoie à chacun `publier`, `modifier` ou `retirer` depuis la version publiée ; « publiée » seulement sur l'accusé du portail ; chaque geste rangé (« envoi », clé, ordre, version) avant d'être envoyé, renvoyé avec la même clé tant qu'il reste incertain ; connecteur idempotent sur la clé et qui ignore un geste d'ordre plus petit ; sans connecteur : « essai », ou échec `connecteur_absent` pour une annonce déjà en ligne. Routes `GET/POST /v1/annonces-portails`, `POST/GET /v1/annonces/<id>/portails`. Relecture forte 2 P1, Codex 5 P0 en quatre tours, tous corrigés avec tests, puis rien. Restent : connecteurs réels de chaque portail (H10) ; écran de la direction et vue par portail dans « Mettre en vente » (`app.ts`).
- Qui : Claude, voie 1 · Relecture : forte · Dépend de : rien
- Cahier : M07 Commercialiser ; audit A004 (bloquant), endroit : docs/PORTAILS.md, P07, H10.
- Constat de l'audit : Je dois garder mon ancien logiciel pour publier sur les portails : AIMMO ne fournit que ses formats XML d’essai.
- Objectif : Publier, modifier puis retirer un bien sur chaque portail souscrit produit un accusé réel et un statut consultable par portail.
- Critères : le constat est d'abord reproduit par un test qui échoue, puis passe ; le critère de l'audit est vérifié par un test (test) ; les règles touchées dans `docs/REGLES.md` sont mises à jour.
- Attend : rien (mise en service réelle : H10).

### AU005 · Un DPE de 2019 passe encore la checklist de publication en novembre 2026
- Statut : fait (2026-11-19)
- Reste : fusionnée (#683, `6ca82082`). Constat confirmé (aucune date jugée). Décidé : `MentionsInput.today` obligatoire, posé par `inputFor` au jour de Paris ; DPE d'avant 2018 jusqu'au 31/12/2022 au plus tard, 2018 à juin 2021 jusqu'au 31/12/2024, depuis juillet 2021 dix ans jusqu'à la veille (`dpeValidUntil`) ; raison `diagnostic_perime` ; chaque passage de publication la relit, l'annonce en ligne est retirée au premier passage du jour d'expiration. R45 complétée. Relecture forte 1 P1 (test du retrait) corrigé ; Codex rien à signaler. Place de l'application à 1 octet du plafond du test BR103 (libellés « absent », « périmé ») : la prochaine tâche qui touche `app.js` devra faire de la place.
- Qui : Claude, voie 1 · Relecture : forte · Dépend de : rien
- Cahier : M07 Commercialiser ; audit A005 (bloquant), endroit : C/annonces/fiche-bien.ts, `parseSheet` ; C/annonces/mentions.ts.
- Constat de l'audit : Un DPE de 2019 passe encore la checklist de publication en novembre 2026, alors que sa validité transitoire est terminée.
- Objectif : La publication refuse ce DPE et contrôle de nouveau sa validité à chaque diffusion.
- Critères : le constat est d'abord reproduit par un test qui échoue, puis passe ; le critère de l'audit est vérifié par un test (test) ; les règles touchées dans `docs/REGLES.md` sont mises à jour.
- Source : [Validité officielle du DPE](https://www.service-public.gouv.fr/particuliers/vosdroits/F16096).
- Attend : rien.

### AU006 · Ma page et ma fiche imprimable remplacent les échelles DPE/GES par du texte
- Statut : fait (2026-11-19)
- Reste : fusionnée (#695, `afa6ff4e`). Constat confirmé. Décidé, lecture prudente : les deux échelles A à G en couleur du modèle officiel, la classe du bien en avant et dite en mots, lues dans les mentions de la version publiée (`energyClassesOf`) ; couleurs dans le système (`ETIQUETTES_CSS`), écrites dans les seules barres. Relecture forte 2 P1 corrigés : couleurs sorties des jetons ; aucun seuil chiffré (petites surfaces depuis juillet 2024, double seuil). Codex rien à signaler ; vérification GitHub verte au second passage (premier : 7 délais de 5 s dépassés dans des tests sans lien).
- Qui : Claude, voie 1 · Relecture : forte · Dépend de : rien
- Cahier : M07 Commercialiser ; audit A006 (bloquant), endroit : C/annonces/page-bien.ts, `renderListingPage`, `renderListingPrint`.
- Constat de l'audit : Ma page et ma fiche imprimable remplacent les échelles DPE/GES par du texte, sans les deux graphiques réglementaires en couleur.
- Objectif : Les deux supports affichent les deux échelles lisibles correspondant aux classes du bien.
- Critères : le constat est d'abord reproduit par un test qui échoue, puis passe ; le critère de l'audit est vérifié par un test (test) ; les règles touchées dans `docs/REGLES.md` sont mises à jour.
- Source : [Présentation exigée](https://www.service-public.gouv.fr/particuliers/vosdroits/F32061).
- Attend : rien.

### AU007 · Mon annonce de bien affiche mon nom et une carte T
- Statut : fait (2026-11-19)
- Reste : fusionnée (#705, `d4638f59`). Constat confirmé. Décidé, lecture prudente : nouvelle mention `intervenant` dans `computeMentions`, depuis l'agent du bien, son dernier statut rangé (AT03, `latestLegalMention`) et le titulaire (`latestCardHolder`), lus comme sur la page de l'agent ; phrase courte et sans parenthèse (« Votre agent : …, agent commercial, RSAC de <greffe> n° <numéro>, habilité par <titulaire>, titulaire de la carte. ») pour tenir dans la première réponse ; absente, la validation est refusée et le passage retire l'annonce. Relecture forte 1 P1 (jeux de test) corrigé ; Codex 1 P0 (égalité de dates, ordre d'écriture) corrigé, puis rien.
- Qui : Claude, voie 1 · Relecture : forte · Dépend de : rien
- Cahier : M07 Commercialiser ; audit A007 (bloquant), endroit : C/annonces/page-bien.ts, `AgentCard`, `agentBlock` ; C/annonces/mentions.ts.
- Constat de l'audit : Mon annonce de bien affiche mon nom et une carte T, mais aucun statut d’agent commercial ni numéro et lieu RSAC propres à moi.
- Objectif : Les mentions du professionnel suivent le statut réel de l’intervenant sur la page, la fiche et les exports ; leur absence bloque la publication concernée.
- Critères : le constat est d'abord reproduit par un test qui échoue, puis passe ; le critère de l'audit est vérifié par un test (test) ; les règles touchées dans `docs/REGLES.md` sont mises à jour.
- Source : [Mentions des agents commerciaux](https://www.economie.gouv.fr/dgccrf/les-fiches-pratiques/professionnels-de-limmobilier-les-regles-connaitre).
- Attend : rien.

### AU008 · Mon bouton d’alerte de sécurité écrit une ligne d’essai au journal au lieu de prévenir réellement quelqu’un
- Statut : fait (2026-11-18)
- Qui : Claude, voie 2 · Relecture : forte · Dépend de : rien
- Cahier : M08 Acquéreurs et visites ; audit A008 (bloquant), endroit : C/visites/securite.ts, `TrialDirectionNotifier`.
- Constat de l'audit : Mon bouton d’alerte de sécurité écrit une ligne d’essai au journal au lieu de prévenir réellement quelqu’un.
- Objectif : Une alerte déclenche une notification réelle avec accusé et escalade si personne n’acquitte ; aucun libellé ne laisse croire à une assistance active en essai.
- Critères : le constat est d'abord reproduit par un test qui échoue, puis passe ; le critère de l'audit est vérifié par un test (test) ; les règles touchées dans `docs/REGLES.md` sont mises à jour.
- Attend : rien.
- Reste : fusionnée (#658), migration `3960`, R54 complétée. Décidé, lecture prudente : « prévenue » seulement sur l'accusé réel du prévenant (`{ mode: 'reel', receipt }`), jamais en essai ; acquittement par la direction du réseau, définitif ; sans acquittement, palier dû compté depuis le geste (+1 toutes les 5 minutes, jusqu'au palier 3 : direction de permanence, toute la direction, contact d'urgence), pendant l'heure qui suit ; la lecture de l'agent fait monter le palier dû ; anciennes alertes « prévenues » par l'essai reclassées « essai » ; bouton renommé « Alerte sécurité ». Relecture forte 1 P0 et 1 P1 corrigés, Codex 1 P0 corrigé puis rien à signaler. Restent : appeler `VisiteSecurisee.tick()` à chaque minute du Worker (voie 1, planificateur) ; écran de la direction pour acquitter et relecture de l'état sur le téléphone de l'agent (voie 1, `app.ts`) ; prévenant réel par SMS ou appel avec accusé (H71).

### AU009 · Une offre et son échéancier ne portent qu’un acquéreur et une date de notification
- Statut : fait (2026-11-18)
- Décidé (2026-11-18) : constat confirmé. Coacquéreurs (jusqu'à 3) sur l'offre, chacun sa fiche, couverts par l'empreinte seulement s'il y en a ; identité de chacun avant compromis et au jour de l'acte ; notification, preuve, versions et délai par acquéreur, rétractation du dossier au plus tardif, à saisir tant qu'un seul manque ; gel, vigilance, dossier figé, prospects, bon de visite à distance et droit d'accès couvrent les coacquéreurs. Relecture forte 2 P1, Codex 7 P0 successifs, tous corrigés avec tests (#660).
- Reste : écran de saisie de l'offre (choix des coacquéreurs) et du dossier (notification par acquéreur) ; bouclier anti-fraude (`dossiers/bouclier.ts`, socle, voie 1) encore par l'acquéreur en tête seul
- Qui : Claude, voie 2 · Relecture : forte · Dépend de : rien
- Cahier : M09 Offre ; audit A009 (bloquant), endroit : C/offres/registre-offres.ts, `buyerPersonId` ; C/dossiers/echeancier.ts, `notification_acquereur`.
- Constat de l'audit : Une offre et son échéancier ne portent qu’un acquéreur et une date de notification : je ne peux pas suivre séparément les droits des coacquéreurs.
- Objectif : Deux coacquéreurs conservent leurs identités, notifications et échéances propres ; le dossier retient le dernier délai applicable avant de poursuivre.
- Critères : le constat est d'abord reproduit par un test qui échoue, puis passe ; le critère de l'audit est vérifié par un test (test) ; les règles touchées dans `docs/REGLES.md` sont mises à jour.
- Attend : rien.

### AU010 · Le dossier peut être déclaré complet sans audit énergétique pour une maison E, F ou G qui y est soumise
- Statut : fait (2026-11-18)
- Qui : Claude, voie 2 · Relecture : forte · Dépend de : rien
- Cahier : M10 Compromis et acte ; audit A010 (bloquant), endroit : C/dossiers/pieces.ts, `PIECES`, `expectedPieces`.
- Constat de l'audit : Le dossier peut être déclaré complet sans audit énergétique pour une maison E, F ou G qui y est soumise.
- Objectif : L’audit devient une pièce conditionnelle obligatoire, avec contrôle de validité et remise avant la visite selon le cas applicable.
- Critères : le constat est d'abord reproduit par un test qui échoue, puis passe ; le critère de l'audit est vérifié par un test (test) ; les règles touchées dans `docs/REGLES.md` sont mises à jour.
- Source : [Champ de l’audit obligatoire](https://www.ecologie.gouv.fr/politiques-publiques/audit-energetique-reglementaire).
- Attend : rien.

### AU010b · L'audit énergétique remis à l'acquéreur dès la première visite
- Statut : fait (2026-11-18)
- Reste : fusionnée (#665), migration `3985`, R60 et R73 complétées. Décidé, lecture prudente : avis à l'agent dès la prise de visite et relu avant (`RemiseAudit.notice`) : remettre, faire faire (absent ou périmé le jour de la visite), préciser la classe, déjà remis, rien ; remise rangée avec la date et le moyen déclarés (papier, mail, espace), ni future ni plus de 30 jours avant la visite, une par visite, liée au document remis ; dépôt du diagnostiqueur seulement si sa certification DPE du jour porte la mention « audit énergétique » cochée par la direction (`auditMention`). Relecture forte sans P0 ni P1 ; Codex 2 P0 et 2 P2 corrigés, puis rien. Restent : écran et route de l'agent (voie 1, `app.ts`) ; report des diagnostics de la fiche du bien au dossier de vente (U09).
- Qui : Claude, voie 2 · Relecture : forte · Dépend de : AU010
- Cahier : M08 Acquéreurs et visites ; suite d'AU010 (art. L126-28-1 du CCH : audit communiqué à l'acquéreur potentiel dès la première visite).
- Objectif : quand `energyAuditCase` dit « requis » pour le bien, la visite (`visites.ts`) rappelle à l'agent de remettre l'audit et range la preuve de sa remise (date, moyen) ; une classe inconnue le dit à l'agent ; le diagnostiqueur partenaire peut déposer l'audit au dossier (`PIECE_RULES`, `PIECE_CREDENTIALS`, après lecture du justificatif requis).
- Critères : visite d'une maison classée F sans audit au bien : l'agent est prévenu avant la visite (test) ; remise rangée avec sa date, jamais inventée [R10] (test) ; lot de copropriété : rien demandé (test) ; dépôt par un diagnostiqueur certifié rangé au dossier (test).
- Attend : rien.

### AU011 · Mon dossier « complet » laisse explicitement au notaire les termites, la mérule et l’assainissement
- Statut : fait (2026-11-18)
- Reste : fusionnée (#670, `92994844`), migration `3990`, R60 complétée. Constat confirmé. Décidé, lecture prudente : la direction range, par commune (code postal et nom sans accents ni traits d'union), la lecture datée de l'arrêté termites ou mérule (intitulé, lien https, date de l'arrêté, jour de lecture) ; une lecture de plus d'un an ne vaut plus ; la commune est celle de la désignation du bien (AU002), sinon de sa fiche courte ; termites et mérule pour tout bâtiment, contrôle de l'assainissement non collectif pour un logement déclaré non raccordé ; état termites valable 6 mois, contrôle 3 ans ; commune inconnue, zone sans lecture à jour ou raccordement non déclaré : jamais « complet ». Routes `POST /v1/dossiers/obligations-locales` (direction) et `POST /v1/dossiers/<id>/assainissement`. Relecture forte 1 P1 corrigé ; Codex 1 P1 (routes) et 1 P2 (libellés) corrigés, puis rien ; vérification GitHub verte. Restent : écran de la direction pour ranger les arrêtés et bouton du raccordement dans l'écran du dossier (voie 1, `app.ts`) ; à la mise en service, la direction range les arrêtés de Côte-d'Or (termites, mérule) pour chaque commune des biens.
- Qui : Claude, voie 2 · Relecture : forte · Dépend de : rien
- Cahier : M10 Compromis et acte ; audit A011 (bloquant), endroit : C/dossiers/pieces.ts, commentaire et liste des pièces.
- Constat de l'audit : Mon dossier « complet » laisse explicitement au notaire les termites, la mérule et l’assainissement, sans déterminer les obligations locales applicables.
- Objectif : Une adresse et le type d’installation déclenchent les pièces ou informations requises, avec source locale datée ; une situation inconnue interdit le verdict « complet ».
- Critères : le constat est d'abord reproduit par un test qui échoue, puis passe ; le critère de l'audit est vérifié par un test (test) ; les règles touchées dans `docs/REGLES.md` sont mises à jour.
- Attend : rien.

### AU012 · Le logiciel m’impose le titre « agent immobilier » même si je suis agent commercial sans carte…
- Statut : fait (2026-11-19)
- Reste : fusionnée (#672, `9e156f5d`), migration `3995`, R07 complétée. Constat confirmé (titre en dur). Décidé, lecture prudente : titre écrit à côté du nom de l'agent réglé par la direction dans une liste fermée (`agent immobilier`, `agent commercial en immobilier`, `conseiller immobilier`), jamais « mandataire » ni titulaire de carte, rangé sans réécriture ; sans réglage « agent immobilier » : texte affiché inchangé (H24). Branché : page du bien, page de l'agent, accueil du site de l'agent, panneau, flyer, vitrine, carte de visite ; routes `GET/POST /v1/attirer/titre-agent`. Relecture forte 1 P1 (carte de visite) corrigé ; Codex 1 P0 (accueil du site) corrigé, puis rien ; vérification GitHub verte. Restent : écran de réglage de la direction (voie 1, `app.ts`) ; les autres textes qui écrivent « agent immobilier » (mails, lettres, signatures) passeront au réglage quand l'avocat aura tranché (H24).
- Qui : Claude, voie 2 · Relecture : forte · Dépend de : rien
- Cahier : M12 Conformité ; audit A012 (bloquant), endroit : docs/REGLES.md, R07 ; C/annonces/page-bien.ts, `agentBlock`.
- Constat de l'audit : Le logiciel m’impose le titre « agent immobilier » même si je suis agent commercial sans carte professionnelle personnelle.
- Objectif : Les textes utilisent une qualité conforme au statut vérifié et ne qualifient pas automatiquement le collaborateur de titulaire de carte.
- Critères : le constat est d'abord reproduit par un test qui échoue, puis passe ; le critère de l'audit est vérifié par un test (test) ; les règles touchées dans `docs/REGLES.md` sont mises à jour.
- Source : [Interdiction rappelée par la DGCCRF](https://www.economie.gouv.fr/dgccrf/les-fiches-pratiques/professionnels-de-limmobilier-les-regles-connaitre).
- Attend : H24 (l'avocat dit quel titre afficher pour un agent commercial sans carte personnelle ; la règle R07 de Shawez impose « agent immobilier »). En attendant, préparer le réglage du titre par statut, sans changer le texte affiché.

### AU013 · Je ne peux émettre que des factures d’essai
- Statut : fait (2026-11-19)
- Reste : fusionnée (#678, b1421bfc) après une vérification GitHub passée en 20 minutes. Restent : plateforme et identités réelles branchées dans l'API (`packages/api/src/pilotage.ts`) à H26 ; anciennes factures d'essai à sortir des relances et du rapprochement derrière la plateforme réelle.
- Qui : Claude, voie 2 · Relecture : forte · Dépend de : rien
- Cahier : M13 Pilotage et finances ; audit A013 (bloquant), endroit : C/pilotage/factures.ts, `PlateformeFacturation`, `PlateformeEssai`, H26.
- Constat de l'audit : Je ne peux émettre que des factures d’essai, sans valeur comptable, puis je dois refaire ma facturation ailleurs.
- Objectif : Une facture réelle validée possède son numéro, les mentions fiscales adaptées et son suivi de transmission réel, sans recréation manuelle.
- Critères : le constat est d'abord reproduit par un test qui échoue, puis passe ; le critère de l'audit est vérifié par un test (test) ; les règles touchées dans `docs/REGLES.md` sont mises à jour.
- Attend : rien (mise en service réelle : H26).

### AU014 · Le parcours de location ne rattache pas son état publiable à un mandat de location signé et inscrit au…
- Statut : bloquée : H73 (refaire la table des modèles, exception à R17)
- Qui : Claude, voie 3 · Relecture : forte · Dépend de : rien
- Cahier : M15 Louer ; M16 Commerces ; M17 Investir ; audit A014 (bloquant), endroit : C/location/logement.ts, `create` ; C/location/annonce-location.ts, `publishable`.
- Constat de l'audit : Le parcours de location ne rattache pas son état publiable à un mandat de location signé et inscrit au registre.
- Objectif : Sans mandat de location en cours, aucune annonce locative n’est déclarée publiable et aucune prestation donnant droit à honoraires n’avance.
- Critères : le constat est d'abord reproduit par un test qui échoue, puis passe ; le critère de l'audit est vérifié par un test (test) ; les règles touchées dans `docs/REGLES.md` sont mises à jour.
- Source : [Nécessité d’un mandat écrit](https://www.economie.gouv.fr/dgccrf/les-fiches-pratiques/professionnels-de-limmobilier-les-regles-connaitre).
- Attend : rien.
- Découpé (2026-11-18, voie 3) : constat confirmé, et plus large que prévu : AIMMO n'a aucun mandat de location. `DOCUMENT_KINDS` ne connaît que les mandats de vente et l'avenant (CHECK de `document_templates`, migration 0033), `mandates` n'a pas d'objet, et `Diffusion.canDiffuse` (R42) ne regarde pas l'objet du mandat. À faire dans l'ordre : AU014a, un modèle « mandat de location » (sorte de document, champs, contrôles, écran Mandats, table des modèles reconstruite) et l'objet du mandat (`vente` ou `location`) rangé à la signature ; AU014b, `canDiffuse` par objet, puis l'annonce de location publiable et le barème d'honoraires seulement sous un mandat de location en cours (tests : sans mandat, annonce non publiable et barème refusé ; un mandat de vente n'ouvre pas la location).

### AU015 · Je peux préparer une location sans loyer de référence majoré ni contrôle du plafond applicable à l’adresse
- Statut : fait (2026-11-19)
- Qui : Claude, voie 3 · Relecture : forte · Dépend de : rien
- Cahier : M15 Louer ; M16 Commerces ; M17 Investir ; audit A015 (bloquant), endroit : C/location/logement.ts, `RentalFacts` ; C/location/annonce-location.ts.
- Constat de l'audit : Je peux préparer une location sans loyer de référence majoré ni contrôle du plafond applicable à l’adresse.
- Objectif : Dans une zone concernée, le contrôle utilise l’arrêté en vigueur et les caractéristiques du logement, refuse un dépassement injustifié et génère les mentions adaptées.
- Critères : le constat est d'abord reproduit par un test qui échoue, puis passe ; le critère de l'audit est vérifié par un test (test) ; les règles touchées dans `docs/REGLES.md` sont mises à jour.
- Source : [Encadrement applicable](https://www.service-public.fr/particuliers/actualites/A17566).
- Attend : rien.

### AU016 · Je peux saisir un nouveau loyer F sans historique du précédent loyer ni contrôle du gel à la relocation
- Statut : fait (2026-11-19)
- Qui : Claude, voie 3 · Relecture : forte · Dépend de : rien
- Cahier : M15 Louer ; M16 Commerces ; M17 Investir ; audit A016 (bloquant), endroit : C/location/logement.ts, `RentalFacts`, `checkDwelling`.
- Constat de l'audit : Je peux saisir un nouveau loyer F sans historique du précédent loyer ni contrôle du gel à la relocation.
- Objectif : Le dernier loyer et les exceptions justifiées sont contrôlés ; une hausse interdite bloque le bail.
- Critères : le constat est d'abord reproduit par un test qui échoue, puis passe ; le critère de l'audit est vérifié par un test (test) ; les règles touchées dans `docs/REGLES.md` sont mises à jour.
- Source : [Gel des loyers F/G](https://www.ecologie.gouv.fr/sites/default/files/documents/22014-1_Guide_RenoEnergetique_2024-10.pdf).
- Attend : rien.

### AU017 · Le contrôle accepte 9 m² sans connaître la hauteur sous plafond ni le volume
- Statut : fait (2026-11-19)
- Qui : Claude, voie 3 · Relecture : forte · Dépend de : rien
- Cahier : M15 Louer ; M16 Commerces ; M17 Investir ; audit A017 (bloquant), endroit : C/location/logement.ts, `checkDwelling`.
- Constat de l'audit : Le contrôle accepte 9 m² sans connaître la hauteur sous plafond ni le volume : « louable » est trop affirmatif.
- Objectif : Le verdict exige les dimensions de la pièce principale et applique les alternatives légales ainsi que les règles locales plus restrictives.
- Critères : le constat est d'abord reproduit par un test qui échoue, puis passe ; le critère de l'audit est vérifié par un test (test) ; les règles touchées dans `docs/REGLES.md` sont mises à jour.
- Source : [Critères de décence](https://www.service-public.gouv.fr/particuliers/vosdroits/F2042).
- Attend : rien.

### AU018 · Dans un logement sans réseau, la boîte de saisie prévue n’est pas branchée
- Statut : fait (2026-11-19)
- Reste : fusionnée (#684, 0ce44fa0). Restent : envoi de l'image entière, prise des expositions par la caméra elle-même, dictée sans réseau. Marge libre du budget de l'application (test BR103) ramenée de 900 à 700 octets.
- Qui : Claude, voie 2 · Relecture : forte · Dépend de : rien
- Cahier : Le produit (téléphone, hors connexion) ; audit A018 (bloquant), endroit : chantier/PLAN.md, HX12 ; A/agent-app.ts ; UI/fichiers.ts, `swJs`.
- Constat de l'audit : Dans un logement sans réseau, la boîte de saisie prévue n’est pas branchée : je ne dispose pas du parcours de visite hors connexion promis.
- Objectif : En mode avion après préparation, je consulte la visite, saisis notes et photos, ferme puis rouvre l’application et synchronise sans perte ni doublon.
- Critères : le constat est d'abord reproduit par un test qui échoue, puis passe ; le critère de l'audit est vérifié par un test (test) ; les règles touchées dans `docs/REGLES.md` sont mises à jour.
- Attend : rien.

### AU019 · La sauvegarde décrite copie la base SQL, pas les octets des photos, scans signés et pièces du coffre
- Statut : fait (2026-11-19)
- Reste : fusionnée (#698) (copie et restauration des objets des quatre stockages, exercice complet, lecteur des références obligatoire) ; Codex rien. Suite : AU019b.
- Qui : Claude, voie 2 · Relecture : forte · Dépend de : rien
- Cahier : Architecture technique ; Conformité ; audit A019 (bloquant), endroit : C/sauvegarde/copie.ts ; docs/SAUVEGARDE.md.
- Constat de l'audit : La sauvegarde décrite copie la base SQL, pas les octets des photos, scans signés et pièces du coffre : restaurer les références ne restaure pas mes dossiers.
- Objectif : Un exercice restaure la base et tous les objets de chaque stockage depuis des copies indépendantes, avec contrôle des empreintes.
- Critères : le constat est d'abord reproduit par un test qui échoue, puis passe ; le critère de l'audit est vérifié par un test (test) ; les règles touchées dans `docs/REGLES.md` sont mises à jour.
- Attend : rien.


### AU019b · Brancher la copie des fichiers au travail de nuit et au test du mois
- Statut : fait (2026-11-19)
- Reste : fusionnée (#700, 72e89c4a), relecture forte 1 P0 corrigé, Codex 2 P0 1 P1 corrigés puis rien de majeur ; plafond R633 corrigé. Attend H74 pour tourner en vrai
- Qui : Claude, voie 2 · Relecture : forte · Dépend de : AU019
- Cahier : Architecture technique ; Conformité ; audit A019, endroit : packages/api/outils/copie-nuit.ts, test-restauration.ts, r2-copies.ts.
- Objectif : chaque nuit, la copie prend la base ET les objets des quatre stockages (lecture S3 de R2, liste paginée) ; une nuit sans les objets se dit « non sauvegardé » ; le test du mois passe par `restoreExercise` avec un lecteur des références de fichiers lu dans les vraies tables.
- Critères : un stockage illisible donne « non sauvegardé » avec sa raison (migration de `base_copy_runs`) ; le lecteur des références couvre chaque table qui cite un fichier, avec un test par table ; R224, R230 et R232 mis à jour.
- Attend : une clé R2 en lecture seule sur les quatre compartiments des objets (à noter dans HUMAIN.md au moment de la tâche).
### AU020 · L’effacement réel et sa procédure validée restent à mettre en service
- Statut : fait (2026-11-20)
- Reste : fusionnée (#712, da703f02). Relecture forte : 2 P1 corrigés. Codex : 4 P0 et 2 P1 corrigés en quatre passes, puis rien. Route fermée tant que le mode n'est pas `reel` : le branchement au Worker attend H29. Suite : AU020b, AU020c (voie 1), AU021.
- Qui : Claude, voie 2 · Relecture : forte · Dépend de : rien
- Cahier : Architecture technique ; Conformité ; audit A020 (bloquant), endroit : chantier/PLAN.md, SV05 ; H29, `ERASURE_MODE`.
- Constat de l'audit : L’effacement réel et sa procédure validée restent à mettre en service : je n’ai pas de parcours de suppression de production démontré.
- Objectif : Une demande recevable efface réellement les données concernées et leurs objets, préserve les archives obligatoires et fournit une preuve ; état réel actuel non vérifié.
- Critères : le constat est d'abord reproduit par un test qui échoue, puis passe ; le critère de l'audit est vérifié par un test (test) ; les règles touchées dans `docs/REGLES.md` sont mises à jour.
- Attend : rien (mise en service réelle : H29).

### AU020b · Les tables en ajout seul du bien d'un vendeur effacé
- Statut : bloquée : garder d'office les textes du bien ne prouve pas qu'ils sont sans nom (3 P0 de Codex sur #715)
- Décidé (2026-11-20, voie 2) : branche `chantier/AU020b` gardée, #715 ouverte sans fusion. Essai fait : une liste blanche `PROPERTY_DESCRIPTION` classait « garder » les tables en ajout seul qui décrivent le bien, et le lien de la personne au bien partait. Relecture forte, 1 P1 : texte libre de `property_details` et `diffusion_portal_feedback`. Codex, 3 P0 : liens et références importées, puis traductions corrigées, puis brouillons et textes des portails. Tous laissent passer un nom de vendeur. Prochaine approche : une migration prévoit une voie qui vide le texte libre de ces tables (table d'effacement des textes, lue par les lecteurs des annonces : lecteurs du socle, donc à voir avec la voie 1) ; seules les tables à valeurs fermées sont gardées d'office (`property_sheets`, sujets des photos, choix des portails, validations). Les tables qui portent l'adresse exacte (`sign_placements`, `pige_properties`) suivent la même voie.
- Qui : Claude, voie 2 · Relecture : forte · Dépend de : AU020
- Cahier : Conformité ; audit A020, endroit : packages/core/src/conformite/effacement-reel.ts ; `listing_drafts`, `property_sheets`.
- Objectif : l'effacement réel d'un vendeur ne laisse plus « restantes » les lignes de `listing_drafts` et `property_sheets` qui ne sont qu'à lui : elles sont vidées de ses données par une voie prévue par la migration, ou rangées dans le plan comme pièces gardées avec leur raison.
- Critères : le test AU020 qui attend `BLOCKED` passe à `remaining: []` et `complete: true` pour la vendeuse du jeu ; le rejeu `SqlPersonEraser` de la vendeuse réussit ; R17 et R231 mises à jour.
- Attend : rien.

### AU020c · Les identifiants gardés après un effacement passent sous empreinte
- Statut : fait (2026-11-20)
- Reste : fusionnée (#717, 2d0f65cc), puis #718 pour les 2 P0 de Codex arrivés après la fusion (adresse commençant par `#sha256:` prise pour une empreinte ; reprise du site qui ajoutait source, demande et accord à une fiche effacée) et 1 P0 sur #718 (GLOB, R633), corrigés ; Codex rien à signaler, vérification verte. Identifiants et clés de contact sous empreinte SHA-256 (réseau + valeur normalisée, préfixe `#sha256:`), arrêt `stop` posé s'il manquait, fiche effacée reconnue sans rien reprendre en clair (ni nom, source, accord) ; message privé Instagram reconnu par sa clé. Relecture forte 2 P1 corrigés ; Codex sans relecture après 15 min ; vérification GitHub verte. Reste : empreinte sans clé secrète (un numéro peut se retrouver par essai) ; `applyPendingHumanReplies` (relais) ne lit la clé qu'en clair, sans effet sur l'arrêt.
- Qui : Claude, voie 1 (socle) · Relecture : forte · Dépend de : AU020
- Cahier : Conformité ; endroit : packages/core/src/fiche/fusion.ts, reception/rattachement.ts, conformite/effacement-reel.ts (`IDENTIFIERS_KEPT`).
- Objectif : après un effacement réel, les adresses et numéros de la personne ne restent que sous leur empreinte, et un message qui arrive de l'un d'eux est quand même reconnu et arrêté [R04].
- Critères : après l'effacement, `person_identifiers.value` ne contient plus aucune valeur en clair de la personne (test) ; un message reçu de son adresse est rattaché à la fiche arrêtée et ne reçoit aucune réponse (test) ; le reçu repasse l'action à « empreinte ».
- Attend : rien.

### AU021 · Le raccordement du véritable effaceur au registre de sauvegarde reste « à faire »
- Statut : fait (2026-11-20)
- Reste : fusionnée (#716, a744788b). Constat confirmé : `restoreWithErasures` ne restaurait que la base, `restoreExercise` rendait base et fichiers sans rejeu, et le compartiment des copies ne listait pas le registre. `sauvegarde/restauration-complete.ts`, `restoreEverything` : base et fichiers, puis rejeu par `SqlPersonEraser` sur les stockages restaurés ; un fichier est retiré de chaque stockage restauré hors du coffre ; `r2CopyStore.list(prefix)`, une page incomplète refusée (`completeListPage`). R231 en service. Relecture forte 1 P1 corrigé (fichier rangé hors du stockage de son préfixe) ; Codex 1 P0 corrigé (XML coupé lu comme registre vide), puis rien ; vérification GitHub verte. Restent : un outil de restauration réelle vers des compartiments R2 neufs qui savent retirer un fichier, appelant `restoreEverything` ; l'écriture du registre par le Worker (H29, H50) ; pour la voie 1 (`conformite/effacement-reel.ts`, socle) : `eraseForReal` retire un fichier du seul stockage de son préfixe, un dossier de commerce à référence libre rangé dans COMMERCES reste en production ; `restoreEverything` n'est pas exporté par `sauvegarde/index.ts`.
- Qui : Claude, voie 2 · Relecture : forte · Dépend de : rien
- Cahier : Architecture technique ; Conformité ; audit A021 (bloquant), endroit : chantier/PLAN.md, SV05 ; C/sauvegarde/effacements.ts.
- Constat de l'audit : Le raccordement du véritable effaceur au registre de sauvegarde reste « à faire » : une restauration peut réintroduire les données supprimées si ce raccordement manque.
- Objectif : Effacer une personne, restaurer une copie antérieure puis rejouer le registre ne laisse aucune donnée qui devait disparaître.
- Critères : le constat est d'abord reproduit par un test qui échoue, puis passe ; le critère de l'audit est vérifié par un test (test) ; les règles touchées dans `docs/REGLES.md` sont mises à jour.
- Attend : rien.

### AU022 · Le candidat arrive sur « Bientôt » sans formulaire ni moyen de laisser une demande
- Statut : fait (2026-11-20)
- Décidé (2026-11-20) : constat confirmé (CANDIDATURE_NETWORK_ID non réglée, page « Bientôt »). Sans variable, le seul réseau de la base reçoit (1 en production) ; aucun ou plusieurs : page fermée ; base illisible : page fermée ; la variable l'emporte. Fusionnée (#711), Codex 1 P1 (tests à jour) corrigé
- Qui : Claude, voie 1 · Relecture : normale · Dépend de : rien
- Cahier : M14 Réseau et académie ; audit A022 (majeur), endroit : `/rejoindre` en production ; A/worker.ts, `CANDIDATURE_NETWORK_ID`.
- Constat de l'audit : Le candidat arrive sur « Bientôt » sans formulaire ni moyen de laisser une demande.
- Objectif : La page accepte une candidature ou propose une liste d’attente avec information et accord adaptés ; la demande apparaît dans la file.
- Critères : le constat est d'abord reproduit par un test qui échoue, puis passe ; le critère de l'audit est vérifié par un test (test) ; les règles touchées dans `docs/REGLES.md` sont mises à jour.
- Attend : rien.

### AU023 · Pour démarrer sur un nouvel appareil, je dois encore manipuler une clé personnelle longue et dépendre de…
- Statut : fait (2026-11-20)
- Décidé (2026-11-20) : constat confirmé (connexion par clé tapée seule, aucun lien d'agent hors du travail GitHub de Z02). Fusionnée (#713, f91839de). `POST /v1/cles/invitations` et `GET /v1/cles/invitations/agents` (direction, preuve `modifier_droits` pour `agent:<id>`), `GET /v1/cles/identite` ; écran de connexion « Entrer avec la clé de cet appareil », clé tapée repliée ; recours « téléphone perdu » : liens inutilisés datés d'abord, puis clés d'application et clés d'appareil retirées ; la clé neuve attend l'accord de la direction. Parcours et recours dans `docs/API.md`, R600 complétée. Codex : 1 P1 et 1 P2, puis 1 P0 (course entre recours et échange d'un ancien lien, test qui la rejoue), tous corrigés, puis rien à signaler ; vérification GitHub verte. Reste : H64 et H22 pour l'usage réel ; 180 octets libres sous la marge de 700 du budget de l'application (test BR103).
- Qui : Claude, voie 1 · Relecture : normale · Dépend de : rien
- Cahier : M14 Réseau et académie ; audit A023 (majeur), endroit : UI/fichiers.ts, connexion ; H22.
- Constat de l'audit : Pour démarrer sur un nouvel appareil, je dois encore manipuler une clé personnelle longue et dépendre de sa configuration par la direction.
- Objectif : Une invitation nominative mène à une connexion par clé d’appareil, avec récupération documentée sans manipulation d’un secret technique par l’agent.
- Critères : le constat est d'abord reproduit par un test qui échoue, puis passe ; le critère de l'audit est vérifié par un test (test) ; les règles touchées dans `docs/REGLES.md` sont mises à jour.
- Attend : rien (mise en service réelle : H22).

### AU024 · Mon écran d’intégration liste les pièces manquantes
- Statut : fait (2026-11-20)
- Décidé (2026-11-20) : constat confirmé (une pièce ne se rangeait que par une référence déjà stockée). Fusionnée (#714, 0bc1359e). `POST /v1/reseau/agents/<id>/pieces/fichier` : corps brut PDF, JPEG ou PNG, 10 Mo au plus, tout vérifié avant de ranger (droits, pièce, dates, type, premiers octets), réponse avec `receipt` (pièce, version, heure, poids, jamais la référence) ; `checkPiece` commun à `addPiece` et `addPieceFile`. Écran : bloc « Déposer… » sous chaque pièce manquante, en projet ou échue, aperçu avant l'envoi, confirmation, accusé de réception. R82 et `docs/API.md` complétées. Codex 1 P2 (type lu hors de la liste) corrigé, puis rien à signaler ; vérification GitHub verte. Reste : compartiment `aimmo-pieces` (H25, H45) pour l'usage réel.
- Qui : Claude, voie 1 · Relecture : normale · Dépend de : rien
- Cahier : M14 Réseau et académie ; audit A024 (majeur), endroit : UI/integration.ts, `renderFile`.
- Constat de l'audit : Mon écran d’intégration liste les pièces manquantes, mais ne me permet pas de déposer les justificatifs à cet endroit.
- Objectif : Chaque pièce manquante propose directement dépôt, aperçu et confirmation de réception sur téléphone.
- Critères : le constat est d'abord reproduit par un test qui échoue, puis passe ; le critère de l'audit est vérifié par un test (test) ; les règles touchées dans `docs/REGLES.md` sont mises à jour.
- Attend : rien.

### AU025 · Le premier parcours pédagogique annonce un outil d’exercice
- Statut : fait (2026-11-20)
- Qui : Claude, voie 1 · Relecture : normale · Dépend de : rien
- Cahier : M14 Réseau et académie ; audit A025 (majeur), endroit : A/worker.ts, configuration `reseau` ; C/reseau/bac-a-sable.ts.
- Constat de l'audit : Le premier parcours pédagogique annonce un outil d’exercice, mais le Worker ne lui fournit pas son stockage isolé.
- Objectif : Un nouvel agent ouvre depuis son écran un exercice isolé et réalise les cinq étapes, progression persistante comprise.
- Critères : le constat est d'abord reproduit par un test qui échoue, puis passe ; le critère de l'audit est vérifié par un test (test) ; les règles touchées dans `docs/REGLES.md` sont mises à jour.
- Attend : rien.
- Reste : fusionnée (#720, `e93c90a3`). Décidé : pas d'objet durable (R602 ne les admet pas) ; seconde base D1 `aimmo-bac-a-sable` en `eu`, mêmes migrations, créée, vérifiée et migrée par la mise en ligne, gabarit d'identifiant à part ; un réseau d'entraînement par agent dans cette base ; routes d'ouverture et d'étape, écran « Mon intégration ». Vérifié sous workerd. Codex : rien de majeur ; une remarque P2 restante (une tâche « rappeler » qui manquerait après une panne à la réception bloque l'étape du rappel), à reprendre si elle se voit.

### AU026 · Les quiz et attestations existent côté métier
- Statut : fait (2026-11-20)
- Qui : Claude, voie 1 · Relecture : normale · Dépend de : rien
- Cahier : M14 Réseau et académie ; audit A026 (majeur), endroit : UI/integration.ts ; C/formation/quiz.ts.
- Constat de l'audit : Les quiz et attestations existent côté métier, mais l’académie affichée ne donne pas d’accès pour les passer et les télécharger.
- Objectif : Chaque module ou parcours offre son quiz, ses corrections et l’attestation obtenue sans appel manuel à l’API.
- Critères : le constat est d'abord reproduit par un test qui échoue, puis passe ; le critère de l'audit est vérifié par un test (test) ; les règles touchées dans `docs/REGLES.md` sont mises à jour.
- Attend : rien.

### AU027 · Un clic « J’ai fini » suffit à créditer toute la durée d’une vidéo
- Statut : fait (2026-11-20)
- Qui : Claude, voie 1 · Relecture : normale · Dépend de : rien
- Cahier : M14 Réseau et académie ; audit A027 (majeur), endroit : C/reseau/academie.ts, `complete`, `compute`.
- Constat de l'audit : Un clic « J’ai fini » suffit à créditer toute la durée d’une vidéo, sans preuve de suivi associée.
- Objectif : Les heures déclarées sont distinguées des heures justifiées ; le compteur utilisable pour les obligations ne retient que des justificatifs vérifiables.
- Critères : le constat est d'abord reproduit par un test qui échoue, puis passe ; le critère de l'audit est vérifié par un test (test) ; les règles touchées dans `docs/REGLES.md` sont mises à jour.
- Attend : rien.
- Reste : fusionnée (#724, `2b9b491d`). Décidé : justifié = présence rangée par la direction, ou module fait couvert par une attestation de quiz réussi (compté au jour de la première attestation) ; un « J'ai fini » seul est déclaré (`declaredMinutes`), montré à part, jamais compté ni dans les alertes ; R85 précisée. Codex rien à signaler. Le module crédité par le bac à sable (AU025) reste déclaré tant que son quiz n'est pas réussi.

### AU028 · Les périodes de formation repartent de mon arrivée au réseau
- Statut : fait (2026-11-20)
- Qui : Claude, voie 1 · Relecture : normale · Dépend de : rien
- Cahier : M14 Réseau et académie ; audit A028 (majeur), endroit : C/reseau/academie.ts, `periodOf`, `startedOn`.
- Constat de l'audit : Les périodes de formation repartent de mon arrivée au réseau, sans reprendre explicitement mon cycle antérieur.
- Objectif : L’intégration importe les attestations antérieures et la période de référence applicable, sans remise à zéro artificielle.
- Critères : le constat est d'abord reproduit par un test qui échoue, puis passe ; le critère de l'audit est vérifié par un test (test) ; les règles touchées dans `docs/REGLES.md` sont mises à jour.
- Attend : rien.
- Reste : fusionnée (#725, `888895fb`), migration `4040` (`academy_prior_entries`, ajout seul). Décidé : la direction range la période de référence du cycle d'avant (la dernière l'emporte) et chaque attestation d'avant (une fois par pièce), pièce et nom à l'appui, jamais après l'arrivée ; elles comptent comme justifiées ; routes `/v1/reseau/agents/<id>/formation/periode-anterieure` et `/anterieures`. Codex 1 P0 (attestation rangée deux fois) corrigé, puis rien. Écran de saisie côté direction à faire avec l'écran du réseau si besoin.

### AU029 · Ma reprise de contacts ne transfère pas mes échanges, notes de suivi et prochains rappels de l’ancien logiciel
- Statut : fait (2026-11-20)
- Qui : Claude, voie 1 · Relecture : normale · Dépend de : rien
- Cahier : M14 Réseau et académie ; audit A029 (majeur), endroit : docs/REPRISE.md, J05 ; C/reseau/import-agent.ts.
- Constat de l'audit : Ma reprise de contacts ne transfère pas mes échanges, notes de suivi et prochains rappels de l’ancien logiciel.
- Objectif : Un import pilote rapproche les historiques et actions futures de chaque contact, avec bilan des éléments non repris.
- Critères : le constat est d'abord reproduit par un test qui échoue, puis passe ; le critère de l'audit est vérifié par un test (test) ; les règles touchées dans `docs/REGLES.md` sont mises à jour.
- Attend : rien.
- Reste : fusionnée (#729, `c6f2e0b7`), migration `4041` (ajout seul). Décidé : `POST /reseau/import` accepte `history` ; chaque ligne rejoint la seule fiche de l'agent qui importe (identifiant du contact de l'export, sinon mail ou téléphone), jamais une fiche effacée ni celle d'un autre agent ; échanges passés et notes rangés à leur date, tâches pas faites, échéances et actions à venir en rappels (tâches, rien n'est envoyé), faits une fois ; bilan `followUp` des lignes non reprises par raison ; identité d'un élément tirée de l'export (contact, type, date et heure écrites, texte entier) : relancé, après l'échéance ou une réunion de fiches, rien ne double. Lecture du suivi au journal (`fiche.lue`). Codex : P0 (lecture non journalisée, fiche effacée) et 5 P2 corrigés ; reste un P2 : une fiche de l'agent réunie dans une fiche gardée sans agent cache son suivi à l'agent (à reprendre avec les droits de lecture de la fiche, `decideAccess`). Pas d'écran d'import pour l'instant.