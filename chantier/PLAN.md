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

## Phase 3 : faire mieux que Hektor et Modelo (demande de Shawez du 2026-11-06)

Relevé fait dans Hektor (compte de Shawez, lecture seule, aucune donnée de client copiée) et dans les présentations publiques de Hektor, Hektor Voice et Modelo. Ce qu'AIMMO a déjà est écarté ; voici ce qui manque. Chaque tâche fait la même chose qu'eux ET un pas de plus, écrit dans « Jamais vu ». Relecture forte pour toutes. Section 9 du protocole.

### HX01 · Partage de biens entre agences et partage d'honoraires
- Statut : fait (2026-11-06)
- Décidé (2026-11-06), lecture prudente : module `packages/core/src/partage/`, migration `1765`, règles R234 et R235. Les coordonnées du vendeur ne vont jamais à l'agence, même après signature : la co-visite passe par l'agent du bien. Le bon signé exige l'attestation que le mandat autorise la délégation. Part de l'agence au centime inférieur. La base refuse une visite ou un dossier rattaché avant signature, un relevé non calculé, une facture à un autre montant. Relecture forte : 2 P0 corrigés, 1 P1 laissé à HX59. Codex : 1 P0, 1 P1, 1 P2 corrigés, puis rien à signaler (#380).
- Reste : écrans et branchement au Worker ; clé d'accès au rôle `partner` pour une agence.

### HX59 · La part de l'agence partenaire déduite de la commission
- Statut : fait (2026-11-06)
- Décidé (2026-11-06) : table à part `commission_agency_shares` (migration `1770`), la table des parts ne se refait pas [R17] ; partage et parrainage calculés sur le reste ; rattachement refusé après la commission prévue, par le code et par la base. Relecture forte : 1 P1 (test) corrigé ; Codex rien à signaler (#382).
- Qui : Claude, relecture forte
- Dépendances : HX01
- Objectif : K01 répartit encore 100 % des honoraires entre l'agent, le parrain et le réseau, sans déduire la part d'une agence partenaire (relevée par la relecture forte de HX01). Au compromis, quand le dossier est rattaché à une délégation signée, la part de l'agence est sortie des honoraires avant la grille ; la somme agent, parrain, réseau et agence fait toujours les honoraires [R69], et le relevé de HX01 à l'acte retrouve la même part.
- Critères : avec un bon à 40 % et 10 000 € d'honoraires, les parts de l'agent, du réseau et de l'agence font 10 000 € (test) ; aucune facture de reversement ne porte la part de l'agence (test) ; une délégation signée après le compromis ne change pas une commission prévue, l'écart va au journal (test).
- Objectif : comme Interkab (Hektor) : publier un bien aux autres agences du réseau et aux agences partenaires, demander une co-visite, envoyer la fiche, signer un bon de délégation qui fixe le partage des honoraires. Jamais vu : le partage est calculé et garanti par le code jusqu'à l'acte, et chaque agence voit en direct où en est le dossier, sans appeler.
- Critères : délégation signée avant toute visite (test) ; partage appliqué à la facture (test) ; aucune coordonnée du vendeur donnée à l'autre agence avant la signature de la délégation (test).

### HX02 · Agenda relié à Google, Outlook et Apple
- Statut : fait (2026-11-06)
- Décidé (2026-11-06) : trois adaptateurs de `AgendaProvider` dans `packages/core/src/rendezvous/fournisseurs.ts` (Google Calendar v3, Graph, CalDAV iCloud), testés contre de faux serveurs ; meilleur créneau dans `trajets.ts` (estimation à vol d'oiseau majorée, sans service extérieur) ; règles R236 et R237 ; aucune migration. Un rendez-vous annulé reste dans l'agenda, libre et marqué « Annulé » (Google : jamais `status: cancelled`, qui supprime). Après une relecture complète, un événement manquant est remis, jamais pris pour une annulation. Rappels aux acheteurs : déjà sous le contrôle central par V04. Relecture forte : 2 P0, 4 P1 corrigés ; Codex : 3 P0, 3 P1 corrigés en quatre tours (DURATION, retraits Outlook relus, UID Apple, VALARM, TZID), puis rien à signaler (#383).
- Reste : connexion OAuth de chaque agent (Google H21, Outlook et Apple H53), branchement au Worker et à l'écran, position des biens (géocodage) pour le meilleur créneau.
- Objectif : synchronisation dans les deux sens avec Google Agenda, Outlook et Apple, et rappels de rendez-vous par SMS ou mail aux acheteurs. Jamais vu : l'appli propose elle-même le meilleur créneau en tenant compte des trajets entre visites.
- Critères : un rendez-vous ajouté d'un côté apparaît de l'autre (tests avec faux serveurs) ; aucun doublon ; rappels sous le contrôle central (R01 à R05).

### HX03 · Assistant juridique de l'agent
- Statut : fait (2026-11-06)
- Décidé (2026-11-06) : module `packages/core/src/juridique/`, aucune migration, règles R250 à R253. Le code choisit les textes d'une bibliothèque fermée (six textes de départ : Hoguet art. 6, CCH L271-1 et L271-4, loi de 1965 art. 46, consommation L221-18, civil 1589), par groupes de termes et termes d'exclusion ; l'IA ne fait que reformuler, et reçoit la question réduite à une liste fermée de mots, sans date. Un paragraphe sans texte, avec un texte non reçu, un nombre absent du résumé (unité comprise, mots de quantité compris) ou une promesse est refusé : les résumés répondent. Chaque citation donne le texte d'origine et celui qui fixe la teneur citée, avec sa date, et dit « jamais vérifiée » et « pas relue par l'avocat » tant que H54 n'est pas fait. Litige (formes fléchies) et question trop longue : jamais de réponse. Relecture forte : 5 P0, 3 P1 corrigés en quatre tours ; Codex : 6 P0 corrigés en cinq tours, puis rien à signaler (#385).
- Reste : écran de l'agent et branchement au Worker ; fournisseur d'IA réel (H13) ; relecture de la bibliothèque par l'avocat et vérification de chaque version sur Légifrance (H54) ; d'autres textes (bail, mandat exclusif, DPE et location) à ajouter seulement relus.
- Objectif : comme Hektor Voice : l'agent pose une question juridique ou réglementaire et reçoit une réponse. Jamais vu : chaque réponse cite son texte de loi et sa date, et dit « je ne sais pas, voyez votre avocat » plutôt que d'inventer.
- Critères : aucune réponse sans source citée (test) ; refus explicite quand aucune source ne couvre la question (test).

### HX04 · Facture électronique
- Statut : fait (2026-11-06)
- Décidé (2026-11-06), lecture prudente : XML Factur-X profil EN 16931 (`packages/core/src/pilotage/facturx.ts`), validé dans les tests contre le schéma officiel 1.09 (`xmllint-wasm`, en dépendance de développement seulement) et vérifié en local avec le schematron officiel ; migration `1803`, règles R254 et R255. Aucune identité inventée : sans SIREN, adresse, régime et numéro de TVA, conditions de paiement, aucun XML, et ce qui manque va au journal. Le jour de l'acte, le passage horaire émet seul les factures qui retombent au centime sur le dossier (part de l'agence déjà déduite). Chaque envoi est réservé en base, donc jamais deux envois. Relecture forte : 4 P1 corrigés (arrondi de TVA, second envoi après une écriture ratée, XML après coup, panne des identités).
- Reste : conteneur PDF/A-3 (HX60), identités réelles (H09, H26), adresse des clients, branchement d'une vraie plateforme.
- Objectif : la facturation électronique obligatoire en France : factures au format Factur-X, réception et émission par une plateforme agréée, comme le pousse Ma Boîte Immo. Jamais vu : la facture d'honoraires part toute seule le jour de l'acte, partage d'honoraires déjà déduit.
- Critères : Factur-X valide (test) ; montants égaux à ceux du dossier (test) ; aucune facture émise deux fois (test).

### HX60 · Factur-X complet : le PDF/A-3 qui porte le XML
- Statut : fait (2026-11-06)
- Décidé (2026-11-06) : `pdfFacturX(xml)` écrit à la main, sans dépendance, un PDF/A-3b tiré du seul XML rangé (tout ce qui est imprimé est relu dedans) ; police Poppins (OFL) réduite à WinAnsi par `scripts/police-facture.py` ; profil sRGB écrit par le code ; un caractère hors police n'est jamais remplacé (pas de PDF, manque dit), un espacement s'imprime en espace ; PDF identique octet pour octet pour la même facture ; R256. veraPDF (image `verapdf/cli`, flavour 3b) passe les trois exemples dans le travail « Vérifier le PDF/A », lancé seulement quand ces fichiers changent. Relecture forte 1 P1 corrigé ; Codex 3 P2 corrigés (coupure des colonnes, montant sur sa page, pagination des identités).
- Reste : fusionnée (#388). Brancher le PDF sur l'envoi à la plateforme et l'écran des factures (voie 1, `app.ts`).
- Qui : Claude, relecture forte
- Dépendances : HX04
- Objectif : HX04 écrit le XML EN 16931. Il reste à le joindre à un PDF/A-3 lisible (police intégrée, profil de couleurs, métadonnées XMP Factur-X, pièce jointe `factur-x.xml` en relation `Data`), sans dépendance lourde dans le Worker.
- Critères : le PDF passe veraPDF en PDF/A-3b (test ou vérification écrite) ; le XML joint est octet pour octet celui rangé (test) ; montants du PDF égaux à ceux du XML (test).

### HX05 · Annonces dans plusieurs langues et portails internationaux
- Statut : fait (2026-11-06)
- Décidé (2026-11-06), lecture prudente : module `packages/core/src/annonces/traductions.ts`, migration `1804`, règles R257 à R259. L'IA ne voit ni chiffre ni classe énergie (repères rendus dans l'ordre, valeurs remises par le code) ; mêmes nombres, même ordre, même unité, mêmes classes ; voies, critères discriminants et mots interdits refusés par langue, et hors anglais aucun mot latin absent du français ; prix et mentions jamais traduits. Anglais toujours ouvert, autres langues seulement déclarées par l'agent ; seul l'agent du bien valide. Flux `aimmo-essai-international-1` et réponse à l'acheteur depuis la version publiée. Relecture forte : 2 P0, 1 P1 corrigés ; Codex : 1 P0, 1 P1 corrigés, puis rien à signaler (#390).
- Reste : écran de l'agent et branchement au Worker ; IA réelle (H13) ; envoi de la réponse par le contrôle central ; portails étrangers réels (H10).
- Objectif : comme Hektor : diffusion vers les portails étrangers. Jamais vu : chaque annonce existe en anglais et dans les langues que parle l'agent (Shawez : anglais, ourdou, hindi, pendjabi, persan, arabe, grec), et l'appli répond à l'acheteur étranger dans sa langue.
- Critères : chaque traduction garde les chiffres et mentions légales à l'identique (test) ; rien ne part sans validation de l'agent.

### HX06 · Création d'un bien et d'un contact à la voix
- Statut : fait (2026-11-07)
- Décidé (2026-11-06), lecture prudente : module `packages/core/src/dictee/`, aucune migration, règles R260 à R262. Le code lit la dictée (aucune IA ne propose de champ) : contact (noms après « s'appelle », « Madame », « Monsieur », téléphone, mail, vendre ou acheter), bien (sorte, code postal, commune de la zone, surface, pièces, prix demandé), rendez-vous (sorte, jour et heure dans une même phrase ; un jour de la semaine est le prochain, jamais aujourd'hui). La validation relit la dictée et refuse tout champ absent ; l'agent retire, n'ajoute ni ne change rien. La fiche nouvelle prend l'identifiant de la demande, le bien aussi : rejouée, rien ne double. Après une visite, le compte rendu de T06 est montré sans être rangé (`ComptesRendus.preview`), puis validé avec le reste et envoyé au vendeur : c'est la « relance du vendeur ». Aucun message au contact dicté, aucune confirmation de rendez-vous.
- Reste : fusionnée (#392). Relecture forte : 1 P0, 4 P1 corrigés ; Codex : 5 P0, 1 P1 corrigés en trois tours (surface groupée, contre-visite par `Visites.schedule`, heure lue en partie, rendez-vous d'un autre bien, noms dictés retirés avant l'IA du compte rendu, particule en minuscule), puis rien à signaler. Restent : écran de dictée et branchement au Worker (`app.ts`) ; nombres dits en lettres ; dictée sans réseau (HX12) ; une course entre la vérification du créneau et la réservation laisse la fiche et le bien, la même demande rejouée reprend sans doubler.
- Qui : Claude, relecture forte
- Objectif : comme Hektor Voice : créer un bien, un contact ou un rendez-vous en parlant. Jamais vu : en sortant d'une visite, l'agent dicte une minute et l'appli remplit la fiche, l'avis de visite et la relance du vendeur, à valider d'un geste.
- Critères : aucun champ inventé, chaque champ rempli renvoie à la phrase dictée (test) ; rien n'est enregistré sans validation.

### HX07 · La boutique de l'agent
- Statut : fait (2026-11-07)
- Décidé (2026-11-07), lecture prudente : module `packages/core/src/boutique/`, migration `1805`, règles R263 à R265. Panneau (sans prix), flyer et vitrine tirés de la dernière version publiée en vente, carte de visite tirée de la carte professionnelle ; le rendu se relit et refuse tout chiffre hors de l'annonce, de la carte et de la référence. Code QR écrit à la main (octets, niveau M, versions 1 à 10), vérifié module pour module contre python-qrcode 8.2 et par un lecteur de test séparé, vers `canonicalFor`. Mot-clé « RÉF <référence> » reconnu par `ReconnaissanceBien`. Prix du dernier tarif de la direction en vigueur, commande seulement à l'imprimeur de ce tarif ; préparer ne commande rien, seul l'agent valide, envoi réservé une fois, panne jamais renvoyée seule. Relecture forte : aucun P0 ni P1, 2 P2 corrigés ; Codex : 1 P0 (imprimeur du tarif) et 1 P2 (photo en adresse entière) corrigés, puis rien à signaler (#394).
- Reste : écran de la boutique et branchement au Worker (`app.ts`) ; imprimeur réel (H56) ; le mot-clé envoyé au téléphone de l'agent ne déclenche la réponse que quand ce canal passe par la captation (C09).
- Objectif : comme « La Boutik » : commander panneaux « À vendre », cartes de visite, flyers, vitrines. Jamais vu : les supports sont générés depuis le bien lui-même (photos, prix, QR vers la fiche avec le mot-clé qui déclenche la réponse automatique) et commandés en un geste.
- Critères : aucun prix ni mention inventés sur un support (test) ; QR qui mène à la bonne fiche (test) ; rien n'est commandé ni payé sans validation de l'agent.

### HX08 · Remises négociées pour les agents du réseau
- Statut : fait (2026-11-07)
- Décidé (2026-11-07), lecture prudente : module `packages/core/src/remises/`, migration `1806`, règles R266 et R267. Remise rangée par la direction seule, avec fournisseur, source et date de fin ; échue, elle disparaît seule le lendemain (jour de Paris), sans passage ; retrait ajouté, rien ne change. Moment lu dans la base : estimation, mandat inscrit, annonce en vente, compromis en préparation (étape `compromis_en_preparation` du dossier vivant), acte de moins de 90 jours ; sans moment sûr (offre acceptée sans compromis commencé, annonce sous offre, vendue ou retirée), rien n'est proposé. Diagnostiqueur, déménageur, artisan : remise pour le client seulement (R76, art. R271-3 CCH), diagnostiqueur pris dans l'annuaire, certifié ce jour-là et dans la zone ; ni courtier, ni banque, ni notaire. Remises pour le client dans un ordre tiré au sort (R75). Relecture forte : 2 P1 corrigés ; Codex : 1 P0 corrigé, puis rien à signaler (#395).
- Reste : écran des remises et branchement au Worker (`app.ts`). Test instable vu en CI, sans lien : `dossier-commerce.test.ts` CE23 « le même code rouvre ensuite le dossier » (« jeton »), vert à la relance.
- Objectif : comme « Mes remises » : les offres négociées pour les agents (diagnostiqueurs, photographes, assurances, outils). Jamais vu : l'appli propose la bonne remise au bon moment du dossier, par exemple le diagnostiqueur au moment du mandat.
- Critères : chaque remise a sa source et sa date de fin, retirée seule à expiration (test).

### HX09 · Actualités utiles, pas du bruit
- Statut : fait (2026-11-07)
- Décidé (2026-11-07), lecture prudente : module `packages/core/src/actualites/`, migration `1807`, règles R268 et R269. La direction seule range une actualité avec éditeur, adresse https publique et date de la source (jamais à venir), et la ligne unique de ce qu'elle change pour l'agent ; aucune IA. Adresse ramenée à une forme unique (suivi, ancre, barre finale retirés) : une source n'est rangée qu'une fois. Cible fermée (sortes de biens, codes postaux, moments du dossier lus par `Remises.momentOf`, classes énergie et copropriété lues dans la fiche du bien) ; dossiers concernés lus au moment de montrer, parmi les seuls dossiers vivants de l'agent, chacun lu par `Acces.readProperty` (au journal) avec sa raison. Une actualité ciblée qui ne touche aucun de ses dossiers ne lui est pas montrée ; sans cible, tout le réseau. Montrée une fois par agent (réservation en base, qui relit le retrait), plus après un retrait ni 60 jours après sa publication ; agent parti dès minuit le jour de son départ. Rien n'est envoyé. Relecture forte : 2 P1 corrigés ; Codex : 3 P0 corrigés (départ du jour, retrait pendant le fil, lecture des biens au journal), puis rien à signaler (#397).
- Reste : écran du fil et de la saisie par la direction, branchement au Worker (`app.ts`). Une actualité réservée puis perdue par une coupure avant d'être rendue n'est pas remontrée.
- Objectif : comme « Mes actualités » : la veille juridique et marché. Jamais vu : chaque actualité dit en une ligne ce qu'elle change pour l'agent et quels de ses dossiers sont concernés.
- Critères : chaque actualité cite sa source (test) ; aucune n'est montrée deux fois.

### HX10 · Les clés des biens
- Statut : fait (2026-11-07)
- Décidé (2026-11-07), lecture prudente : module `packages/core/src/cles/`, migration `1808`, règles R270 à R272. Numéro donné par le code, unique dans le réseau ; libellé sans chiffre, adresse ni code. Sortie par l'agent du bien ou la direction seuls, vers un agent actif : visite ou estimation pour un rendez-vous prévu du bien tenu par lui (retour à sa fin), sinon photos, diagnostic ou travaux, retour dans les 12 h. Une seule sortie ouverte, relue à l'écriture et gardée par déclencheur, rendez-vous aussi. Le détenteur peut dire la clé perdue, pas rendue. Rappels de l'agent (fin de visite, tout de suite si annulée) ; vue du vendeur depuis son mandat, agent en prénom et initiale, aucun visiteur. Relecture forte : 2 P1 corrigés ; Codex : 1 P0 corrigé (rendez-vous annulé entre lecture et écriture), puis rien à signaler (#399).
- Reste : écrans de l'armoire et du vendeur, branchement au Worker (`app.ts`) ; rappel dans l'agenda externe (HX02) ; clé remise à un partenaire sans agent.
- Objectif : comme Hektor (gestion des clés, armoire à clés) : chaque trousseau a son numéro, on sait qui l'a, depuis quand, pour quelle visite. Jamais vu : l'agenda rappelle de rendre la clé après la visite, et le vendeur voit dans son espace qui est entré chez lui et quand.
- Critères : une clé ne peut être chez deux personnes à la fois (test) ; tout mouvement est au journal (test).

### HX11 · Pige des annonces de particuliers
- Statut : fait (2026-11-07)
- Décidé (2026-11-07), lecture prudente : module `packages/core/src/pige/`, migration `1809`, règles R273 à R275. Source de pige en port (aucun fournisseur branché) ; seules entrent les communes des zones du réseau ; texte de l'annonce lu pour « pas d'agence » (liste fermée) puis oublié, aucune coordonnée du particulier. Bien reconnu par sorte, code postal, commune et surface (à 1 m² près), ni prix ni pièces ; « pas d'agence », non du particulier et message suivis de proche en proche sur tout ce qui est relié (annonces, corrections, clé de chaque annonce), annonce incomplète comprise ; bien trop relié fermé. Écart au m² face à la case publiée des prix regroupés (AT01), sinon « marché non chiffré ». Premier message écrit par le code, une fois par bien, validé par l'agent de la zone : remis à coller dans la messagerie de l'annonce, dans les heures (samedi compris) ; téléphone, SMS, WhatsApp, mail refusés par la décision unique faute d'accord (R03) ; AIMMO n'envoie rien. Codex : 13 P0, 1 P1 et 7 P2 corrigés en douze tours, puis rien à signaler (#401).
- Reste : écran de la file et branchement au Worker (`app.ts`) ; vraie source de pige ; H58 (avocat : messagerie de l'annonce hors de R03 ?).
- Objectif : comme Ma Pige (Pigimmo, Directannonces) : repérer les biens vendus par des particuliers dans le secteur. Jamais vu : pour chacun, l'écart avec le prix du marché et un premier message utile prêt à valider, jamais envoyé seul ; et la mention « pas d'agence » est toujours respectée.
- Critères : une annonce marquée « pas d'agence » n'entre jamais dans la file (test) ; contrôle central et accords (R01 à R05) ; aucun envoi automatique.

### HX12 · Appli utilisable sans réseau, et photo HDR
- Statut : fait (2026-11-07)
- Décidé (2026-11-07), lecture prudente : module `packages/core/src/hors-ligne/`, migration `1810`, règles R276 à R278. Boîte d'envoi du téléphone (rangement en interface), chaque saisie (note, photo, photo sans objet) avec l'identifiant tiré par le téléphone ; elle ne sort de la boîte que sur une réponse qui la nomme, la refusée restant visible. Le serveur reçoit chaque saisie une fois, la rejouée rend la même réponse, un autre contenu sous le même identifiant est refusé ; l'écriture n'a lieu que pour l'envoi qui gagne la saisie ; une panne de la base ne répond rien, la saisie reste au téléphone. Photo HDR : au moins deux prises de lumières différentes fondues, jugée (sombre, brûlée, floue) sur le téléphone puis de nouveau par le serveur sur les prises réduites. Jamais vu : liste de cadrage pièce par pièce tirée de la fiche du bien, départ refusé tant qu'une photo n'est ni acceptée ni dite sans objet. Paquet du jour sans client (référence, sorte, commune, surface, pièces), aujourd'hui ou demain, valable jusqu'à la fin du jour de Paris. Codex : 3 P0 corrigés (boîte sérialisée, écriture gagnée par la saisie, panne de la base), puis rien à signaler (#405).
- Reste : écran de la visite hors ligne, service worker et rangement IndexedDB, prise des expositions par la caméra et envoi de l'image entière, branchement au Worker (`app.ts`).
- Objectif : comme l'appli Hektor (mode hors connexion, Pix HDR) : en cave ou à la campagne, l'agent consulte et remplit la visite sans réseau, tout part au retour du réseau ; les photos prises dans l'appli sont en HDR. Jamais vu : l'appli guide le cadrage pièce par pièce et refuse une photo floue ou trop sombre avant qu'on reparte.
- Critères : saisie hors ligne puis envoi sans perte ni doublon (test) ; photo trop sombre ou floue signalée (test).

### HX13 · Mode présentation pendant la visite
- Statut : fait (2026-11-07)
- Décidé (2026-11-07), lecture prudente : module `packages/core/src/presentation/`, migration `1811`, règles R279 à R281. La page ne prend que la dernière version publiée des annonces (titre, prix, mentions publiées, photo, référence) ; les mentions publiées restent, la loi les veut sur toute présentation [R43]. Bien visité en vente ou sous offre et diffusable ; au plus 4 autres biens en vente, disponibles, diffusables, qui répondent à la recherche et pas déjà visités, raisons sans chiffre de la recherche. Relecture avant rendu sur le texte affiché et les attributs, contre chaque dossier montré et la visite : noms (coupés sur la ponctuation), coordonnées (numéro national comme international), numéros de mandat, notes de visite, dictée, notes des projets. Notes par pièce (aimée, moyenne, pas aimée) de la liste de cadrage, une fois, figées avec leur liste de pièces et la réponse du premier envoi. Compte rendu par le code seul, jamais « prêt à faire une offre », pièces regroupées au-delà de 5, envoyé par T06 seulement après validation de l'agent et jamais à la place d'une dictée ; prochaine proposition : contre-visite si intérêt fort, sinon premier bien qui répond. Relecture forte : 1 P0 corrigé ; Codex : 6 P0 corrigés en trois tours, puis rien à signaler (#407).
- Reste : écran du téléphone et branchement au Worker (`app.ts`).
- Objectif : comme Live Visit et le mode présentation : montrer à l'acquéreur, sur le téléphone, le bien et les biens qui lui correspondent, sans montrer les données de l'agence. Jamais vu : à la fin, l'acquéreur note chaque pièce d'un geste, et l'appli en tire le compte rendu au vendeur et la prochaine proposition.
- Critères : aucune donnée confidentielle (vendeur, honoraires, notes) visible en mode présentation (test).

### HX14 · Stock de panneaux
- Statut : fait (2026-11-07)
- Décidé (2026-11-07), lecture prudente : module `packages/core/src/panneaux/`, migration `1812`, règles R282 à R284. Panneau du stock rangé par la direction seule, numéro donné par le code, format grand, moyen ou petit. Pose par l'agent du bien en activité ou la direction, seulement quand la porte de diffusion de D05 le permet (un panneau est une publicité, R42) et que le bien n'est pas vendu, à une adresse au code postal et à la commune du bien ; la pose garde le mandat qui la permettait et l'agent du bien. Un seul endroit à la fois, relu dans l'instruction d'écriture et gardé par déclencheur ; perdu, plus jamais posé. Passage à 6 h, 13 h et 19 h : bien vendu (fiche, dernière annonce, acte signé d'un dossier non arrêté) ou porte fermée (échu, rétracté, annulé…) range « récupérer le panneau », une fois par pose ; rendu comme arrêt de tournée (`PickupStop`, sans client) pour HX19. Comptes du stock pour la direction et les agents actifs, poses avec adresse : toutes pour la direction, les siennes pour l'agent. Journal sans adresse. Rien n'est envoyé.
- Reste : fusionnée (#409). Codex : rien à signaler ; vérification GitHub d'abord rouge (tables absentes du registre des traitements et de la carte des accès, sujet `sign:` du journal), corrigée. Restent : écran du stock et de la tournée, branchement au Worker (`app.ts`) et inscription de `signPickupsJob` au planificateur ; la tournée elle-même (HX19).
- Objectif : comme Hektor (gestion des panneaux) : combien de panneaux, où ils sont posés, lesquels récupérer. Jamais vu : à la vente ou à la fin du mandat, la tâche « récupérer le panneau » est créée toute seule, avec l'adresse dans la tournée.
- Critères : un panneau posé est rattaché à un bien (test) ; tâche créée à la fin du mandat (test).

### HX15 · Statistiques et contenus du site
- Statut : fait (2026-11-07)
- Décidé (2026-11-07), lecture prudente : module `packages/core/src/statistiques-site/`, migration `1813`, règles R285 à R287. Vues comptées par le seul code porteur de AT05, en compteur par contenu et par jour de Paris (rien du visiteur). Demandes lues comme la mesure de AT05 (conversation, première origine connue), vendeurs par projet `sell`, `valuation` ou `sell_business`, mandats signés après le premier message ; chaque chiffre porte les identifiants des messages. Prochaine page : la sorte rédactionnelle (prix, quartier) qui amène le plus de vendeurs par vue, dans la commune des zones qui ne l'a pas encore et où les vendeurs arrivent déjà le plus ; texte et chiffres tirés par le code. Pages rédactionnelles : celles de prix et de quartier, déjà faites (AT01, quartier) ; formulaires et partenaires du site restent à leurs modules. Le critère « R15 » du plan vise en fait R156 et la nouvelle R285 : c'est elles que le test porte.
- Reste : fusionnée (#410). Codex : 4 P0 corrigés en deux tours (premier message de la conversation, première personne rattachée, mandat compté sans projet, pages existantes lues dans leurs sources), puis rien à signaler. Restent : écran « Gérer mon site », branchement au Worker (`app.ts`, `countView` appelé par les pages publiques), filtre des robots ; formulaires et partenaires du site à leurs modules.
- Objectif : comme « Gérer mon site » : statistiques de visite, pages rédactionnelles, formulaires, partenaires. Jamais vu : chaque chiffre dit quelle page amène des vendeurs, et l'appli propose la prochaine page à écrire pour en attirer plus.
- Critères : aucune donnée personnelle de visiteur conservée (R15, test) ; chaque statistique relie la page à des demandes réelles.

### HX16 · Veille des nouveaux diagnostics énergétiques par secteur
- Statut : fait (2026-11-07)
- Décidé (2026-11-07), lecture prudente : module `packages/core/src/veille-dpe/`, migration `1814`, règles R288 à R290. Source en port, avec le vrai branchement à la base ouverte de l'ADEME (`dpe03existant`) : seuls le code postal et le jour partent, seuls les champs d'une liste fermée sont demandés et lus ; aucun propriétaire n'est jamais cherché, une adresse portant une civilité ou un nom est écartée. Rangé une fois par réseau sous le numéro ADEME ; relu sur 7 jours, rien ne remonte deux fois. Secteur = une commune des zones en cours de l'agent avec son code postal ; l'alerte du jour se lit dans l'application, rien n'est envoyé. Carte sur 90 jours avec la date d'interdiction de louer de M15 (`banDate`). Lettre « Au propriétaire » (liste fermée de G06), à l'adresse du diagnostic, une par diagnostic, texte du code (classe, date de M15, ce qu'elle change, trois voies), contrôle de G06 avec la seule date permise comme chiffre, imprimée avec la feuille de G06. Ce n'est pas une lettre de quartier (R140) : sa règle est R290 ; un diagnostic publié n'est pas une donnée de ventes (R37). Texte à faire relire (H60).
- Reste : fusionnée (#412). Codex : 1 P2 corrigé (diagnostic et alerte rangés en un seul lot), puis rien à signaler ; vérification GitHub verte. Restent : écran de la veille (carte et alerte), branchement au Worker (`app.ts`) et inscription de `dpeWatchJob` au planificateur avec `AdemeDiagnosisFeed` ; H60.
- Objectif : comme Hektor : suivre chaque jour les nouveaux diagnostics énergétiques publiés par l'ADEME dans un secteur, les voir sur une carte et recevoir une alerte quotidienne par secteur de veille. Jamais vu : chaque logement classé F ou G est croisé avec sa date d'interdiction de louer, déjà calculée par M15, et l'appli prépare une lettre « Au propriétaire » de G06 qui explique ce que cette date change pour lui, sans jamais chercher son nom.
- Critères : aucun nom ni coordonnée de propriétaire rangé (test) ; un diagnostic déjà vu ne remonte jamais deux fois (test) ; l'alerte ne contient que les communes de la zone de l'agent (test).

### HX17 · Score de vente par adresse
- Statut : fait (2026-11-07)
- Décidé (2026-11-07), lecture prudente : module `packages/core/src/score-adresse/`, migration `1815`, règles R291 à R293. Score = somme de points d'une liste fermée de signaux publics, chacun avec sa donnée, sa source et sa date : diagnostic énergétique récent (ADEME, 35 points à 6 mois, 20 à un an), interdiction de louer passée ou à moins de 3 ans (loi Climat et résilience, date de M15, 20), ventes DVF à moins de 200 m (un compte seulement, filtré à la distance ; 15 dès 8 par an, 8 dès 3), parcelle de 1 500 m² et plus (cadastre, 10). Tranches : faible, moyen (15), fort (35), très fort (55). Une source absente, en panne, hors département, illisible ou sans contenance ne donne aucun point et se dit avec sa raison. Mêmes données le même jour, même score et même empreinte. La durée de détention par adresse n'est pas calculée : elle demanderait la vente d'une adresse dans les ventes publiques pour viser son propriétaire (R29, R37, R140). Agent en activité, adresse avec numéro d'une commune de ses zones, civilité ou nom refusé (le titre d'une voie, « rue du Docteur … », n'en est pas un). Jamais vu : taux de mandats signés par tranche, lu dans `mandates` (G03, G10), mandat relié par son agent à l'adresse, même commune exigée, signé dans l'année qui suit le premier score (jour de Paris) ; taux dit sur les seules années closes. Relecture forte : 3 P0 et 4 P1 corrigés ; Codex : 1 P0 et 1 P2 corrigés, puis rien à signaler (#414).
- Reste : écran du score et de la mesure, branchement au Worker (`app.ts`) avec `BanGeocoder`, `IgnCadastre`, `AdemeEnergy` et `DvfSiteSales` ; `carriesPerson` de HX16 refuse encore les voies à titre (« rue du Docteur … ») dans la veille, à aligner sur `addressCarriesPerson`.
- Objectif : comme Maline, Keyzia et Modelo : croiser ventes DVF, diagnostics, cadastre et durée de détention pour donner à chaque adresse une probabilité de vente et mettre en avant les signaux forts. Jamais vu : chaque point du score cite sa donnée publique, sa source et sa date, et l'écran montre en face le taux de mandats réellement signés par tranche de score, lu dans G10, pour qu'on sache si le score marche.
- Critères : chaque point du score renvoie à sa source et à sa date (test) ; le même jeu de données donne le même score (test) ; aucune donnée personnelle dans le calcul ni dans le résultat (test).

### HX18 · Adresse probable d'une annonce de particulier, et bien créé sans ressaisie
- Statut : fait (2026-11-08)
- Décidé (2026-11-08), lecture prudente : module `packages/core/src/adresse-pige/`, migration `1816`, règles R294 à R296. La pige range la classe énergie et la date du diagnostic dites par l'annonce (`pige_ad_energy`, une correction fait une nouvelle relève). Adresses tirées des seuls diagnostics publiés (veille HX16 puis base ADEME, pages suivies) : même sorte, code postal, commune, surface à 1 m² près, moins de dix ans, classe et date quand l'annonce les dit ; parcelle du cadastre ; confiance de 0 à 100, chaque point sourcé et daté, partagée entre adresses, une adresse comptée une fois. Propositions rangées sans rue ni numéro, relues aux sources à la conversion. Fiche créée d'un geste depuis la dernière relève de l'annonce, source « pige » ; « pas d'agence » et non refusés par le code et par la base (empreinte de l'annonce, ses relèves et toutes les clés reliées dans `pige_property_keys`). Jamais vu : biens et mandats par niveau de confiance (R296). Relecture forte : 1 P0 et 3 P1 corrigés ; Codex : 8 P0 corrigés en quatre tours, puis rien à signaler (#416). Vérification GitHub d'abord rouge sur deux tests d'autres modules instables (HX27 : un identifiant tiré au hasard contenant « 345 » ; HX31 : budget de la page), verte au second passage.
- Reste : écran (adresses et création du bien depuis la file) et branchement au Worker (`app.ts`) avec `AdemeDiagnosisSearch` et `IgnCadastre` ; rendre déterministes les deux tests instables de HX27 et HX31.
- Objectif : comme Hektor : retrouver l'adresse d'une annonce de pige et la transformer en fiche bien sans ressaisie. Jamais vu : l'adresse est proposée avec son niveau de confiance, tiré du croisement surface, classe énergie et date du diagnostic avec le cadastre, et la fiche du bien créée garde la source « pige » jusqu'au mandat, pour mesurer ce que la pige rapporte. Les coordonnées du propriétaire ne sont jamais cherchées. Dépend de HX11.
- Critères : chaque adresse proposée montre sa confiance et ses sources (test) ; la fiche du bien reprend tous les champs de l'annonce, source « pige » (test) ; une annonce « pas d'agence » n'est jamais convertie (test).

### HX19 · Carte des opportunités et tournée de prospection
- Statut : fait (2026-11-08)
- Reste : écran (carte et tournée) et branchement au Worker (`app.ts`) avec le géocodage BAN et la position des biens. Relecture forte sans P0 ni P1 ; Codex : 6 P0 et 1 P2 corrigés en cinq tours, puis rien à signaler (#418). GitHub Actions bloqué par la facturation : vérification locale verte.
- Qui : Claude, relecture forte
- Décidé (2026-11-08), lecture prudente : module `packages/core/src/tournee-prospection/`, sans migration (rien n'est rangé : la tournée est une proposition), règles R297 à R299. Opportunités : panneaux dont la tâche de HX14 est due et pas récupérés (adresse géocodée par la Base adresse nationale, sinon lieu inconnu), lettres de G06 pas déposées (un lot par campagne, au centre de la campagne, 2 min par lettre), diagnostics de HX16 remontés depuis 14 jours dans les secteurs suivis. Hors zone : compté, jamais montré ni géocodé. Tournée gloutonne au plus tôt fini, sur des tranches de 5 min, route estimée à vol d'oiseau majoré (HX02). Lien de la vue des rues : la seule position arrondie. Réservé à l'agent lui-même, la direction n'a pas de tournée.
- Objectif : comme Hektor, Modelo, Keyzia et Maline : une carte des opportunités du secteur, la vue des rues, et un itinéraire optimisé de porte-à-porte. Jamais vu : une seule tournée mêle les visites du jour, les panneaux à récupérer de HX14, les lettres de G06 et les nouveaux diagnostics de HX16, calée dans les créneaux libres de V01 avec les temps de trajet.
- Critères : la tournée tient dans les créneaux libres de l'agent (test) ; aucune adresse hors de la zone de l'agent (test) ; le lien vers la vue des rues ne porte aucune clé ni donnée de client (test).

### HX20 · Séquence de prospection sur plusieurs canaux
- Statut : fait (2026-11-08)
- Décidé (2026-11-08), lecture prudente : module `packages/core/src/sequence-prospection/`, migration `1817`, règles R300 à R302. Une séquence a au plus 8 étapes, sur mail, SMS, appel, courrier ou porte-à-porte, de J0 à J90 ; elle est préparée par l'agent de la fiche, une seule en cours par personne ; le texte d'un mail ou d'un SMS est écrit par l'agent. Les mails et les SMS partent seulement par le contrôle central, avec la finalité « prospecting » et le sujet `sequence:<id>:<n>`. Les heures (R01) et le plafond (R11) font attendre ; un doublon de texte (R05) saute l'étape ; un sujet déjà en route attend, puis compte comme parti. Appel, courrier et porte-à-porte : proposés à l'agent dans le plan du jour (option `sequences` de `PlanDuJour`). L'appel fait se note dans `call_notes` et compte dans la fréquence ; un refus arrête la séquence. Bloctel est vérifié pour tous les canaux, sur tous les numéros de la fiche, avant le contrôle et jamais pendant. Un appel de prospection seule n'est proposé que si Bloctel répond « absent » (H61). Arrêt pour de bon sur tous les canaux dans chacun de ces cas : une réponse, une exclusion (même levée depuis), un accord retiré, un refus d'appel, Bloctel, un changement d'agent, le départ de l'agent, deux fiches réunies (seule la plus ancienne séquence continue). Une opposition antérieure empêche le départ. Jamais vu : chaque étape est revérifiée juste avant de partir, et la séquence s'arrête d'elle-même partout.
- Reste : fusionnée (#422). Relecture forte : 2 P1 corrigés. Codex : 11 P0 corrigés en sept tours, puis rien à signaler. GitHub Actions bloqué par la facturation ; vérification locale verte (4 845 tests). Restent : écran et routes, branchement au Worker (`app.ts`) et inscription de `run()` au planificateur ; Bloctel réel (H61).
- Objectif : comme Maline et SIANA : une séquence par prospect sur mail, SMS, appel, courrier et porte-à-porte, et un plan de prospection chaque matin. Jamais vu : chaque étape est vérifiée avant de partir contre les accords, la liste d'opposition au démarchage et les horaires des appels de AC06, et la séquence s'arrête d'elle-même sur tous les canaux à la première réponse ou opposition ; les étapes du jour entrent dans le plan du jour de G01.
- Critères : aucun envoi hors du contrôle central (test) ; une opposition arrête la séquence sur tous les canaux (test) ; un appel n'est proposé que dans les horaires permis (test).

## Captation et voix

Voie : 2

Réservé et découpé le 2026-11-06 par la voie 2 (la voie 1 tient Z05 puis HX01 à HX20). Le cahier ne parle pas encore des notes vocales ni des appels : la source est la demande de Shawez du 2026-11-06 ci-dessus. Règles R240 à R249 et migrations à partir de `1800` réservées à ce groupe. Le code vit dans `packages/core/src/voix/` ; `app.ts`, `packages/core/src/index.ts` et les adaptateurs de réception ne changent pas : le branchement au Worker sera une tâche de la voie 1. Ordre : HX23 d'abord (rien d'extérieur), puis HX21, puis HX22. Le vrai service de transcription attend un humain (fournisseur, clé, accord de sous-traitance) : d'ici là, une interface et un faux transcripteur dans les tests.

### HX21 · Appels entrants résumés et rangés dans la fiche
- Statut : fait (2026-11-06)
- Reste : fusionnée (#381), migration `1801`, R242 à R245. Décidé, lecture prudente : enregistrement et transcription seulement si l'annonce puis l'accord sont rangés pendant l'appel ; seuls les mots de l'appelant sont qualifiés (Q01) et chaque champ garde le passage qui le porte seul, sinon il n'est pas rangé ; numéro masqué : aucune fiche, rien de dit n'est gardé ; provenance seulement par un code de contenu de AT05 porté par l'appel, sinon « inconnue ». Relecture forte 3 P1 corrigés ; Codex 4 P0 corrigés en 3 tours, dernière version approuvée. Restent : branchement au Worker, routes avec R16 et écran de la fiche (voie 1, `app.ts`) ; appels dans la mesure mensuelle de AT05 ; demande d'arrêt dite au téléphone (R04) ; vrai service téléphonique et transcripteur (H52).
- Objectif : comme Leedflow d'Apimo et le suivi des appels de Hektor : résumé automatique de chaque appel, enregistrement dans la fiche, provenance des appels venus du site. Jamais vu : chaque information tirée de l'appel renvoie à la phrase dite, la qualification de Q01 s'applique comme pour un message, et la provenance se mesure par les liens d'appel marqués de AT05, sans jamais prendre un second numéro. L'enregistrement n'a lieu qu'après annonce et accord de l'appelant.
- Critères : aucun enregistrement sans accord rangé (test) ; chaque champ rempli renvoie à un passage de la transcription (test) ; l'appel est rattaché à la bonne fiche, sans doublon (test).

### HX22 · Assistant vocal quand l'agent ne peut pas répondre
- Statut : fait (2026-11-06)
- Reste : fusionnée (#384), migration `1802`, R246 à R248. Décidé, lecture prudente : l'assistant ne prend qu'un appel renvoyé depuis le numéro déclaré de l'agent (unique dans toute la base), ligne allumée ; il ne dit que des phrases fixes, jamais reformulées par une IA, contrôlées avant d'être dites (aucun nombre hors fiche ou créneau, aucun nombre en lettres) ; le prix dit est celui de l'annonce publiée, sinon aucun ; le créneau désigné est répété et réservé seulement après un oui franc, une question ou une négation ne vaut pas choix ; l'accord à l'enregistrement n'est qu'un oui sans réserve ; numéro masqué ou sans accord : aucun sujet gardé. Codex 7 P0 corrigés en 5 tours, dernière version sans remarque. Restent : branchement au Worker, routes du service téléphonique, garde de l'état entre deux tours et écran du passage de main (voie 1, `app.ts`) ; vrai service téléphonique et reconnaissance de la parole (H52) ; demande d'arrêt dite au téléphone (R04).
- Objectif : comme Talqor, PriceHubble et Kleio : un secrétariat vocal qui répond pendant les visites, qualifie l'appelant et propose des créneaux. Jamais vu : l'agent garde son seul numéro, l'appel arrive par un simple renvoi sur non-réponse ; l'assistant se présente comme assistant dès la première phrase, ne donne que les chiffres de la fiche du bien, réserve sur un créneau libre de V01, puis passe la main à l'agent avec le résumé de HX21.
- Critères : la mention de l'assistant est dite au début de chaque appel (test) ; aucun chiffre donné qui ne vienne de la fiche du bien (test) ; un rendez-vous n'est pris que sur un créneau libre (test).

### HX23 · Messages vocaux transcrits et traités
- Statut : fait (2026-11-06)
- Reste : fusionnée (#379). Relecture forte : 1 P0 (IBAN dicté en clair) et 3 P1 corrigés (double transcription simultanée, notes `standby`, nos propres notes) ; Codex sans remarque. Restent : la réponse dans la langue de la personne (HX05), le vrai transcripteur (H52), le branchement au Worker et à l'écran de la fiche (voie 1, `app.ts`).
- Qui : Claude, voie 2 · Relecture : forte · Dépend de : C01, C06, Q01
- Cahier : M02 Capter ; Conformité (R13, R15) ; demande de Shawez du 2026-11-06.
- Attend : un fournisseur de transcription, sa clé et son accord de sous-traitance (H52) pour de vraies notes ; rien pour le code.
- Objectif : comme Septeo : retranscrire les messages audio. Jamais vu : les notes vocales reçues sur WhatsApp, Instagram et Messenger entrent dans la chaîne de C01 comme un texte : transcrites, qualifiées par Q01, et la réponse part dans la langue de la personne ; l'audio d'origine reste lisible depuis la fiche.
- Critères : une note vocale donne la même qualification que le même texte écrit (test) ; la transcription est marquée comme telle et liée à son audio (test) ; une transcription impossible passe la main à l'agent, sans réponse inventée (test).

## Contacts et automatismes

Voie : 2

Réservé le 2026-11-06 par la voie 2. Règles R400 à R419 et migrations à partir de `1900` réservées à ce groupe. Le code vit dans `packages/core/src/automatismes/` ; `app.ts`, `packages/core/src/index.ts` et les fichiers du socle ne changent pas : le branchement au Worker sera une tâche de la voie 1.

### HX24 · Scénarios automatiques réglables, essayés avant d'être allumés
- Statut : fait (2026-11-06)
- Reste : fusionnée (#386), migration `1900`, R400 à R403. Décidé, lecture prudente : le « journal du mois passé » est lu dans les faits datés de la base (fiches et projets nouveaux), jamais une fiche reprise ni réunie ; texte fixe de la direction, jamais de l'IA, prénom une fois, aucun chiffre ; accord « automatismes » exigé par le contrôle central ; un message de scénario parti par personne et par jour ; dans l'essai, les messages prévus des scénarios allumés tiennent leur journée même s'ils avaient pu être refusés. Codex : 12 P0 et 1 P1 corrigés en 8 tours, dernière version sans remarque. Restent : branchement au planificateur et au Worker, routes et écran de la direction (voie 1, `app.ts`) ; d'autres déclencheurs (visite faite, mandat signé) ; balayage des faits depuis le dernier passage quand le volume grandira.
- Objectif : comme Automator d'Apimo et Mission Builder de Modelo : la direction compose ses propres scénarios, un déclencheur, une attente, un message, une tâche. Jamais vu : avant d'être allumé, chaque scénario est rejoué sur le journal du mois passé et dit combien de messages il aurait envoyés et à combien de personnes ; il ne peut envoyer que par le contrôle central.
- Critères : un scénario allumé passe toujours par le contrôle central (test) ; la simulation sur le passé n'envoie rien (test) ; un scénario qui enverrait deux fois à la même personne le même jour est refusé (test).

### HX25 · Prochaine action, filtres et dates des clients
- Statut : fait (2026-11-06)
- Reste : fusionnée (#389), migration `1901`, R404 à R407. Décidé : la prochaine action vient de règles fixes, sans IA (ne pas relancer, répondre, tâche, relancer après 14 jours, attendre, qualifier) ; une réponse dont l'envoi a échoué ne compte pas. Les filtres passent par `Acces.listPersons`, et chaque critère doit tenir sur le même projet. Pour les dates, l'accord est lu par la décision du contrôle central avant de prendre la place ; un dimanche est souhaité le lundi, pour l'année de la date ; de 1 à 5 textes de la direction, et chaque année prend le premier jamais parti. Codex : 3 P0 corrigés en 2 tours. Restent : choisir le canal seulement s'il a une coordonnée (P2 de Codex) ; un message de date ne prend pas la place du jour des scénarios [R402] ; un passage arrêté net en `en_cours` ne reprend pas seul ; branchement au Worker et à l'écran (voie 1).
- Objectif : comme Modelo et Hektor : la prochaine action suggérée sur chaque fiche, des filtres avancés par budget, secteur et catégorie, et les messages d'anniversaire et de fête. Jamais vu : la prochaine action dit en une ligne pourquoi elle est proposée, d'après le journal, et un message de date n'est préparé que si la personne a donné cette date et son accord, jamais la nuit ni le dimanche.
- Critères : chaque action proposée cite sa raison (test) ; aucun message de date sans date donnée et accord rangé (test) ; un filtre ne montre jamais une fiche hors des droits de l'agent (test).

### HX26 · Tri de la boîte mail de l'agent
- Statut : fait (2026-11-07)
- Reste : fusionnée (#391), migration `1902`, R408 à R411. Décidé, lecture prudente : une adresse inconnue ne crée jamais de fiche et n'en garde rien ; zéro ou plusieurs projets ouverts : aucune pièce rangée ; noms de fichier d'identité, de banque, d'impôts ou de revenus jamais rangés, au singulier comme au pluriel ; 20 pièces au plus par mail, à leur place ; la réponse validée part comme réponse de la conversation du mail (R21 peut la refuser si l'agent a déjà répondu dans ce fil) ; un tri coupé se reprend sans doublon et le curseur ne dépasse jamais un mail pas fini. Codex : 7 P0 corrigés en 5 tours, dernière version avec un seul P2, corrigé. Restent : vrais accès Gmail, Outlook et Drive (H05, H55) ; choix du dossier par l'agent pour les pièces en attente ; mails envoyés par l'agent lui-même ; branchement au Worker, routes et écran (voie 1, `app.ts`).
- Objectif : comme Talqor : trier les mails, préparer les réponses, relier Gmail, Outlook et Drive. Jamais vu : chaque mail est rattaché à sa fiche et à son dossier, les pièces jointes utiles sont rangées dans le bon dossier, et la réponse préparée cite ce qu'elle reprend du dossier ; rien ne part sans validation.
- Critères : un mail d'un client connu est rattaché à sa fiche (test) ; aucune réponse envoyée sans validation (test) ; une pièce jointe est rangée une seule fois, par son empreinte (test).

### HX27 · Notifications sur le téléphone, réglables
- Statut : fait (2026-11-07)
- Reste : fusionnée (#393), migration `1903`, R412 à R415. Décidé, lecture prudente : heures calmes par défaut 21 h à 8 h, et tout le dimanche ; le contact chaud ne se coupe pas, part seul, mais attend lui aussi les heures calmes sauf si la personne vient d'écrire (30 minutes) ; chaque notification gardée est relue avant de partir (droits, exclusion), sinon annulée ; texte écran verrouillé fait de mots fixes et de nombres seulement. Aucune notification ne part hors de la porte `AgentPushGate` : d'ici SV15, la seule porte est la boîte d'essai. Codex : 9 P0 corrigés en 7 tours, dernière version sans remarque. Restent : SV15 (porte dans le contrôle central), vrai service Web Push (H57), branchement au planificateur de chaque minute, à Q04 (`hotContact`), à la réception (`inbound`), aux routes et à l'écran des réglages (voie 1, `app.ts`).
- Objectif : comme Hektor et iad : des notifications sur le téléphone, réglables par l'agent. Jamais vu : un contact chaud arrive en moins d'une minute, le reste est groupé par urgence, et les heures calmes de l'agent sont tenues sauf pour un client qui vient d'écrire.
- Critères : un contact chaud est notifié tout de suite (test) ; rien de non urgent pendant les heures calmes (test) ; aucune donnée personnelle dans le texte visible écran verrouillé (test).

## Recherche de biens et site

Voie : 2

Réservé le 2026-11-07 par la voie 2. Règles R420 à R439 et migrations à partir de `2000` réservées à ce groupe. Le code vit dans `packages/core/src/recherche/` ; `app.ts`, `packages/core/src/index.ts` et les fichiers du socle ne changent pas : le branchement au Worker sera une tâche de la voie 1.

### HX28 · Recherche de biens en langage courant
- Statut : fait (2026-11-07)
- Reste : fusionnée (#396), migration `2000`, R420 à R424. Décidé, lecture prudente : lecture de la phrase par le code seul, sans IA ; un critère est indispensable sauf si sa partie de phrase dit une préférence, reprise par « et » ; négations et mots de R50 écartés et dits ; surfaces et sommes lues en entier (milliers, décimales), surface arrondie au mètre au-dessus ; communes voisines en réglage de la direction (défaut prudent, à vérifier) ; un refus ne vaut que pour un bien montrable ou déjà mis en vente (IN11) ; un refus qui vide les communes ou les types ne range rien (`a_preciser`) ; accord `buyer_search` exigé pour ranger, la phrase jamais gardée. Relecture forte 1 P0 et 1 P1 ; Codex 7 P0 corrigés en 7 tours, dernière version sans remarque. Restent : routes, écran public et écran de l'agent, prise de l'accord `buyer_search` à l'écran (voie 1, `app.ts`).
- Qui : Claude · Relecture : forte · Dépend de : T01
- Objectif : comme Hektor, Zefir et Kleio : l'acquéreur décrit ce qu'il cherche avec ses mots. Jamais vu : la phrase devient une fiche acquéreur de T01, avec ses critères indispensables et ses préférences, les communes voisines proposées et marquées comme telles, et les critères ajustés après chaque refus ; chaque résultat dit pourquoi il correspond.
- Critères : chaque critère renvoie aux mots de la phrase (test) ; seuls des biens diffusables sont montrés (test) ; une fiche acquéreur n'est créée qu'avec l'accord de la personne (test).

### HX29 · Points d'intérêt et trajets autour du bien
- Statut : fait (2026-11-07)
- Reste : fusionnée (#398), R425 à R428, rien en base. Décidé, lecture prudente : données de plus de deux ans écartées ; estimation à vol d'oiseau (détour compté) à pied et en voiture seulement, marquée ; transport jamais estimé, dit « non calculé » ; temps arrondis à 5 min au-dessus, aucune distance en mètres, zone publiée = centre d'une case de 0,005° ; adresse de source publiée sans paramètres ni ancre, chemin portant une position refusé ; nom de lieu qui reprend la rue du bien remplacé par sa sorte. Codex 4 P0 et 1 P2 corrigés. Restent : routes, page publique du bien et écran de l'agent (voie 1, `app.ts`) ; choix d'une vraie source de lieux et des horaires du réseau de transport.
- Qui : Claude · Relecture : normale · Dépend de : HX28
- Objectif : comme Apimo : écoles, commerces, transports autour du bien. Jamais vu : les temps de trajet à pied, en transport et en voiture vers ce qui compte pour cet acquéreur, avec la source et la date de chaque donnée, sans jamais révéler l'adresse exacte du bien.
- Critères : chaque point d'intérêt cite sa source et sa date (test) ; l'adresse exacte n'apparaît nulle part dans la page publique (test).

### HX30 · Visibilité dans les moteurs d'IA
- Statut : fait (2026-11-07)
- Reste : fusionnée (#400), migration `2001`, R429 à R431. Décidé, lecture prudente : quatre questions de liste fermée (prix au mètre carré, délai de vente, biens en vente, honoraires), une phrase fixe par fait sourcé et daté, relue par le code (tout nombre vient de la valeur ou de la date de la source) ; deux faits du même jour qui se contredisent ne publient rien ; `/llms.txt` sans chiffre hors référence d'un bien, sans mail ni numéro ; moteurs d'IA lus sur l'adresse exacte de la page d'où vient la personne ou un seul `utm_source` connu, jamais Google ni Bing ; mesure du mois par moteur comptée comme AT05. Codex 2 P0 corrigés, dernière version sans remarque. Restent : routes `/reponses/<commune>` et `/llms.txt`, transmission de la page d'où vient la personne par la captation, `/reponses/` dans `contentOfPath` de AT05, vraie source des chiffres (voie 1, `app.ts`).
- Objectif : comme Hektor, Kappn et Artur'in : être cité par ChatGPT, Perplexity et Google. Jamais vu : des pages de réponses factuelles, chaque chiffre sourcé, un fichier de présentation pour les robots d'IA, et la mesure des contacts venus d'une IA dans l'origine des contacts de AT05.
- Critères : chaque chiffre publié renvoie à sa source (test) ; un contact venu d'un moteur d'IA est classé comme tel (test).

### HX31 · Écran de vitrine en agence
- Statut : fait (2026-11-07)
- Reste : fusionnée (#402), migration `2002`, R432 à R434. Décidé, lecture prudente : seuls les biens « en vente » et disponibles, porte de diffusion relue à chaque rendu, page de référence en ligne exigée ; titre, prix, mentions et photo de la dernière version publiée, la page se relit et refuse tout chiffre sans source ; dix biens au plus pour tenir le budget d'une page publique, photos servies par le site même (`/medias/…`) ; rechargement toutes les 5 minutes qui reprend au bien en cours ; code QR vers la page de référence avec le code du bien (AT05) et `vitrine=<code de l'écran>` ; contact compté sur un seul code d'écran du réseau, l'écran et le bien seulement ; mesure du mois pour la direction, l'agent pour ses écrans. Codex 1 P0 et 2 P2 corrigés en 3 tours, dernière version sans remarque. Restent : route publique `/vitrine/<code>` servie par le site du réseau, transmission du lien d'arrivée à la captation pour `Vitrine.record`, écran de réglage et de mesure (voie 1, `app.ts`).
- Objectif : comme Clap.show d'Apimo : un écran en vitrine qui fait défiler les biens. Jamais vu : l'écran ne montre que les biens diffusables au prix publié du moment, avec un code QR qui mène à la fiche et compte les contacts venus de la vitrine.
- Critères : un bien vendu ou retiré disparaît de l'écran à la mise à jour suivante (test) ; le QR mène à la bonne fiche, marquée « vitrine » (test).

## Estimation

### HX32 · Avis de valeur enrichi : concurrence, loyer possible et quartier
- Statut : en cours
- Objectif : comme Hektor, Modelo et Immofacile : les biens concurrents en ligne, l'estimation locative et les données du quartier dans l'avis de valeur. Jamais vu : pour chaque concurrent, le nombre de jours en ligne et ses baisses de prix, lus dans la pige de HX11, et le loyer possible tiré de Y02 avec sa fiabilité, pour que le vendeur voie le marché réel.
- Critères : chaque concurrent cite sa source et sa date de relevé (test) ; le loyer affiché dit sa source et sa fiabilité (test) ; aucun nom ni adresse exacte de concurrent dans l'avis imprimé (test).

## Mandat et documents

Voie : 2

Réservé le 2026-11-07 par la voie 2. Règles R440 à R459 et migrations à partir de `2100` réservées à ce groupe. Le code vit dans `packages/core/src/mandat-questionnaire/` (HX33) et dans des fichiers neufs de `packages/core/src/documents/` ; `app.ts`, `packages/core/src/index.ts` et les fichiers du socle ne changent pas : le branchement au Worker sera une tâche de la voie 1.

### HX33 · Mandat par questionnaire
- Statut : fait (2026-11-07)
- Reste : fusionnée (#403), migration `2100`, R440 à R443. Décidé, lecture prudente : six questions et six clauses de liste fermée (exclusivité, rétractation hors agence ou à distance, accord de tous les vendeurs, bien loué, copropriété, honoraires à l'acquéreur), chaque référence de loi fixée dans le code, le texte de chaque clause écrit par la direction et validé par la conformité, jamais par son auteur sous un autre rôle ; clauses, réponses, version, empreinte et relevé du prix entrent dans le document même de D02 (annexe passée à `Modeles.generate`), qui passe les contrôles et se signe ; nouvelle ligne `questionnaire` des contrôles avant signature (D03) : un écart au-delà de 5 % (réglage de la direction), un avis validé ou un prix absents bloquent tant que l'agent du bien n'a pas dit les avoir montrés ; fourchette lue = celle que l'agent a validée, du dernier avis validé. Relecture forte 1 P0 et 1 P1, Codex 2 P0 corrigés, dernière version sans remarque. Test de HX28 rendu sûr (identifiant au hasard). Restent : vrais textes des clauses à faire écrire et valider (H08) ; routes, écran du questionnaire, branchement au Worker (voie 1, `app.ts`).
- Objectif : comme Modelo et ImmoSign : des clauses choisies par questionnaire, des modèles qui s'adaptent au cas, un mandat prérempli depuis l'estimation. Jamais vu : chaque clause retenue dit quelle réponse l'a déclenchée et sur quel texte elle repose, et le prix du mandat est comparé à la fourchette validée de E09 avec l'écart affiché avant signature.
- Critères : chaque clause renvoie à sa réponse et à son texte (test) ; un écart de prix au-delà du réglage est signalé avant signature (test) ; seul un modèle validé par une personne désignée sert à un vrai mandat (test).

### HX34 · État des risques et déclaration d'intention d'aliéner préparés
- Statut : fait (2026-11-07)
- Reste : fusionnée (#404), migration `2101`, R444 à R447. Décidé, lecture prudente : état rempli depuis la collecte de E03 (adresse, parcelle, risques de Géorisques), chaque rubrique avec sa source et son jour à Paris, date de l'état = donnée la plus ancienne ; sinistres indemnisés laissés au vendeur ; le dernier état complet se range comme pièce `etat_risques` et entre ainsi dans le chemin critique de N07 ; déclaration d'intention d'aliéner recalculée, chaque champ avec son origine, noms des parties et honoraires laissés au notaire. Codex 1 P1 et 1 P2 corrigés. Restent : routes, écran, rendu PDF et branchement à la collecte dans le Worker (voie 1, `app.ts`).
- Objectif : comme Modelo et Hektor : commander ou produire l'état des risques depuis le dossier, préparer la déclaration d'intention d'aliéner. Jamais vu : l'état des risques est rempli depuis les données de Géorisques déjà collectées par E03, daté, et sa fin de validité à 6 mois entre dans le chemin critique de N07 ; la déclaration est préparée pour le notaire, champs repris du dossier.
- Critères : chaque rubrique de l'état cite sa source et sa date (test) ; un état de plus de 6 mois à la date de l'acte est signalé (test) ; aucun champ de la déclaration n'est rempli sans donnée du dossier (test).

### HX35 · Copropriété et urbanisme résumés
- Statut : fait (2026-11-07)
- Reste : fusionnée (#406), migration `2102`, R448 à R452. Décidé, lecture prudente : le résumé est fait de phrases proposées (IA ou agent) et vérifiées par le code, chacune avec son document, sa page et son extrait, qui doit se lire sur cette page ; chaque nombre et au moins un mot porteur de la phrase se lisent dans l'extrait ; des travaux votés exigent une décision acquise lue juste avant le mot du vote (ni niée, ni à venir), un montant suivi de « € » ou « euros » et une échéance lue comme date entière ; l'acquéreur lit l'extrait même du procès-verbal ; registre des copropriétés (ANAH) et Géoportail de l'urbanisme seulement, avec jour de collecte et date de la donnée ; nom d'un syndic non professionnel jamais repris ; texte des pages non gardé. Codex 6 P0 corrigés, dernière version sans remarque. Restent : extraction du texte des PDF, collecte du registre et du Géoportail, routes, écran et branchement au Worker (voie 1, `app.ts`).
- Objectif : comme Talqor et Hektor : résumé des procès-verbaux de copropriété et du plan local d'urbanisme, données de copropriété et de syndic préremplies. Jamais vu : chaque phrase du résumé renvoie à la page du document d'où elle vient, les données publiques du registre des copropriétés et la zone du plan d'urbanisme sont lues avec leur date, et les travaux votés à venir sont signalés à l'acquéreur.
- Critères : aucune phrase du résumé sans renvoi à sa page (test) ; les données publiques citent leur source et leur date (test) ; le résumé dit « non trouvé » plutôt que d'inventer (test).

## Signature et recommandé

Voie : 2

Réservé le 2026-11-07 par la voie 2. Règles R460 à R469 et migrations à partir de `2110` réservées à ce groupe. Code dans des fichiers neufs de `packages/core/src/documents/` ; `app.ts`, `packages/core/src/index.ts` et les fichiers du socle ne changent pas.

### HX36 · Lettre recommandée électronique et notification de l'avant-contrat
- Statut : fait (2026-11-07)
- Reste : fusionnée (#408), migration `2110`, R460 à R463. Décidé, lecture prudente : texte écrit par le code, refait et comparé à l'envoi ; la lettre ne part que par le contrôle central (accord de l'acquéreur, finalité `notification_recommandee`, heures), sujet = le dossier, réservé avant la remise, une seule lettre partie par dossier ; port propre à la lettre, qui remet au prestataire le compromis joint et exige sa référence ; preuves rangées dans l'ordre (dépôt, première présentation, puis acceptation, refus ou non réclamée), une fois chacune, citant la référence du prestataire ; la première présentation (jour à Paris) entre à l'échéancier avec sa preuve, reprise si la même preuve revient, et ne se ressaisit plus à la main (`set_by_registered_letter`, petit ajout à `echeancier.ts`) ; refus et non réclamée ne changent pas la date ; un envoi remis sans être rangé est retrouvé, sans repartir ; essai par le palier du contrôle central, sans effet. Codex 7 P0 et 1 P1 corrigés, dernière version sans remarque. Restent : prestataire réel et texte validé (H59, H08) ; route de réception des preuves, écran et branchement au Worker (voie 1, `app.ts`).
- Objectif : comme Modelo, ImmoSign, Immofacile et la FNAIM : envoyer une lettre recommandée électronique et la notification qui ouvre le délai de rétractation de l'acquéreur. Jamais vu : la date de première présentation revient seule dans l'échéancier de N02 et lance le calcul de la rétractation, sans ressaisie.
- Critères : la date de première présentation remplit N02 (test) ; un envoi recommandé passe par le contrôle central (test) ; la preuve de dépôt est rangée au dossier (test).

### HX37 · Ordre des signataires, annexes groupées et rappels
- Statut : fait (2026-11-07)
- Reste : fusionnée (#411), migration `2111`, R464 à R467. Décidé, lecture prudente : circuit = un document du dossier et ses annexes (liste fermée : diagnostics, état des risques, copropriété, mesurage, mobilier), chaque pièce rangée avec l'empreinte de son contenu, une seule empreinte du tout signée par chacun ; signataires = vendeurs d'un mandat du bien et acquéreur, groupes depuis 1 sans trou, ordre libre dans un groupe ; ce que chaque annexe change pour le vendeur ou l'acquéreur, en mots simples écrits par le code, lu et rangé avec l'empreinte du texte avant toute signature ; rappels toutes les 48 h au plus, trois au plus, au seul signataire dont c'est le tour, par le contrôle central (accord `signature_en_ligne`, mention de l'assistant), rien hors du lundi au samedi de 8 h à 20 h ; un circuit ne change plus. Codex 1 P0 et 1 P2 corrigés ; reste un P2 : un rappel réservé par le contrôle central mais jamais remis, après une coupure, est compté comme parti. Restent : textes validés (H08), signature réelle (H24) ; routes, écran, passage des rappels au planificateur et branchement au Worker (voie 1, `app.ts`).
- Objectif : comme Modelo et Hektor : ordre et groupes de signataires, signature d'un document avec toutes ses annexes, suivi et rappel. Jamais vu : avant de signer, chaque signataire lit en mots simples ce que chaque annexe change pour lui ; les rappels partent par le contrôle central, jamais la nuit ni le dimanche.
- Critères : l'ordre des signataires est tenu (test) ; un document et ses annexes ont une seule empreinte de dossier (test) ; aucun rappel hors des heures d'envoi (test).

## Diffusion

Voie : 2

Réservé le 2026-11-07 par la voie 2. Règles R470 à R489 et migrations à partir de `2200` réservées à ce groupe. Le code vit dans `packages/core/src/diffusion/` (fichiers neufs) ; `app.ts`, `packages/core/src/index.ts`, `packages/core/src/annonces/` et les fichiers du socle ne changent pas : le branchement au Worker sera une tâche de la voie 1.

### HX38 · Diffusion surveillée portail par portail
- Statut : fait (2026-11-08)
- Qui : Claude, relecture forte
- Reste : fusionnée (#413), migration `2200`, R470 à R475. Décidé, lecture prudente : portails = ceux que la réception reconnaît (`PORTAL_DOMAINS`), réglés par la direction avec leur domaine, les champs exigés (liste fermée) et un nombre de photos ; choix bien par bien ; `portalListings` filtre le flux d'essai de P07 sans toucher à `annonces/` ; une seule tâche de correction ouverte par bien, portail et sorte (rejet ou écart), gardée par la base, ouverture et fermeture décidées dans l'instruction même qui écrit ; retrait temporaire unique, gardé par la base ; relecture de l'adresse acceptée de la version la plus récente (prix, classes, chaque ligne des mentions), une relecture périmée ne décide rien ; lien au vendeur seulement après une relecture conforme de la version du moment (`sellerLinks`, rien d'envoyé) ; classement sur les contacts (mails de portail) et mandats « portail » réels. Relecture forte 2 P1, Codex 6 P0 corrigés (les deux derniers dans #415 : relecture périmée par un changement de diffusion, détails de l'écart gardés), puis rien à signaler. Restent : lecteurs réels et retours des flux (H10) ; routes, écran, relectures au planificateur et branchement à l'espace du vendeur (voie 1, `app.ts`).
- Objectif : comme Modelo et Neo : choix des portails bien par bien, contrôle des champs exigés, tâche de correction quand un portail rejette, retrait temporaire, vérification de la mise en ligne, classement des portails. Jamais vu : l'appli relit chaque annonce en ligne et signale tout écart avec la version publiée, prix, diagnostic ou mentions, et le vendeur reçoit le lien de chaque annonce une fois vérifiée.
- Critères : un rejet crée une seule tâche de correction (test) ; un écart de prix entre portail et version publiée est signalé (test) ; le classement des portails se fait sur les contacts et mandats réels (test).

### HX39 · Texte par portail et légendes des photos
- Statut : fait (2026-11-08)
- Qui : Claude, relecture normale
- Reste : fusionnée (#417), migration `2201`, R476 à R478. Décidé, lecture prudente : texte d'un portail écrit par l'agent du bien ou proposé par l'IA (repères à la place des chiffres et des classes, minuscules comprises), validé par l'agent seul pour la version publiée du moment, caduc à la version suivante ; contrôle : chaque nombre avec son signe, ses lettres collées, ce qu'il compte et ce que mesure sa phrase, chaque lettre de classe avec son champ, aucun nombre en lettres ni lien, chaque phrase sourcée par la fiche du moment et par celle de la version publiée (aucun prix, aucune adresse) ; refait à chaque rendu ; prix, mentions et photos de la version publiée intacts ; légende de chaque photo écrite par le code (place, sujet d'une liste fermée dit par l'agent et porté par la fiche, étage, retouche ou aménagement virtuel de la fiche publiée). Codex 9 P0 corrigés, dernière version sans remarque. Restent : IA réelle ; routes, écran et branchement du flux au Worker (voie 1, `app.ts`).
- Objectif : comme Apimo et Hektor : un texte différent par portail et des titres de photos générés. Jamais vu : seul le texte change, prix et mentions restent identiques partout, et chaque photo reçoit une légende utile aussi aux personnes malvoyantes, sans rien affirmer que la photo ne montre pas.
- Critères : prix et mentions identiques dans tous les textes (test) ; aucune légende ne cite un élément absent de la fiche (test).

## Photo, vidéo et visite

Voie : 2

Réservé le 2026-11-08 par la voie 2. Règles R490 à R509 et migrations à partir de `2300` réservées à ce groupe. Le code vit dans `packages/core/src/medias/` (fichiers neufs) ; `app.ts`, `packages/core/src/index.ts` et les fichiers du socle ne changent pas : le branchement au Worker sera une tâche de la voie 1.

### HX40 · Retouches déclarées et filigrane
- Statut : fait (2026-11-08)
- Reste : fusionnée (#419), migration `2300`, R490 et R491. Décidé, lecture prudente : trois retouches locales en liste fermée (ciel remplacé, reflets atténués, objet mobile retiré, lui-même d'une liste fermée : jamais un défaut ni ce qui tient au bien ou à sa vue), déclarées à part des corrections d'ensemble et inscrites au certificat de X02 une par une ; mention « Photo retouchée » posée sur l'appareil et déclarée, sinon refusé ; le certificat et sa page publique les disent, la légende de HX39 aussi ; filigrane = calque SVG dessiné par le code, deux lignes (nom de l'agent du bien en activité ; « AIMMO · <code de contenu du bien> » de AT05), tenu entier dans l'image, sinon export refusé ; chaque export rangé (`photo_exports`) ; lien marqué de la page du bien pour les métadonnées quand elle est en ligne. Codex 1 P0 et 2 P2 corrigés, dernière version sans remarque. Restent : routes, écran d'export et assemblage du calque sur l'appareil (voie 1, `app.ts`).
- Qui : Claude, relecture normale
- Décidé (2026-11-06) par Shawez : retouches locales autorisées (ciel, reflets, objets retirés), chaque photo retouchée porte la mention « photo retouchée » ; X02 est assoupli en conséquence, avec test
- Objectif : comme Hektor, HOQI et Apimo : remplacer le ciel, enlever les reflets, effacer un objet, poser un filigrane. Jamais vu : chaque retouche locale est inscrite au certificat de X02 et l'image porte la mention « aménagement virtuel » de R48 ; chaque photo exportée porte le filigrane de l'agent et l'identifiant de contenu de AT05, pour qu'une photo reprise par d'autres ramène à lui.
- Critères : une retouche locale sans mention est refusée (test) ; le certificat liste chaque retouche (test) ; chaque photo exportée porte le filigrane (test).

### HX41 · Aménagement virtuel des pièces
- Statut : fait (2026-11-08)
- Reste : fusionnée (#420), migration `2301`, R492 et R493. Décidé, lecture prudente : ce qui a changé déclaré par l'agent du bien en liste fermée (pièce meublée, décoration, sols, murs, désencombrée, objet transformé, chacun avec son option), rangé une fois, lu ligne par ligne sur le certificat public ; jumelle réelle prouvée par le code (photo de la fiche certifiée sans aménagement, même empreinte d'original) ; dans le Studio (photos publiables, publications sur les réseaux relues à l'envoi, exports), une image aménagée suit sa jumelle, jamais en premier ni seule, et s'exporte avec elle. Codex 3 P0 : deux corrigés, le troisième (annonces) confié à HX50 avec R494 « en service : non ». GitHub Actions bloqué par la facturation : vérification locale verte (4800 tests). Restent : écran de déclaration ; annonces (HX50, voie 1).
- Qui : Claude, relecture normale
- Objectif : comme Hektor, Apimo, HOQI et Talqor : meubler une pièce vide, redécorer en plusieurs styles, rénover sols et murs, désencombrer, transformer un objet. Jamais vu : chaque image transformée est toujours publiée à côté de la photo réelle, jamais en couverture seule, et le certificat dit exactement ce qui a changé.
- Critères : mention « aménagement virtuel » sur l'image (test) ; l'original est toujours publié à côté (test) ; une image transformée ne peut pas être la seule photo d'une pièce (test).

### HX50 · Les annonces publient l'image aménagée avec sa jumelle
- Statut : à faire
- Qui : Claude, voie 1 (touche `annonces/medias.ts` et le jeu de test commun `annonces-jeu.ts`), relecture normale
- Dépendances : HX41
- Partie du cahier : M19, M07 (photos et vidéos).
- Objectif : R494. `MediasBien.publishable()` (P06) ordonne les photos par `orderGallery` de `medias/amenagement.ts` avec les jumelles déclarées (`AmenagementsVirtuels.twins`) : une image aménagée suit sa photo réelle, jamais en couverture, retirée sans jumelle. Le jeu `annonces-jeu.ts` déclare la jumelle de sa photo aménagée. Remarque P0 de Codex sur #420.
- Critères : aucune annonce publiée n'a une image aménagée en couverture (test) ; une image aménagée sans jumelle déclarée n'est dans aucune annonce (test) ; `galleryProblems` est vide sur chaque annonce publiée (test).
- Ce qu'elle attend d'un humain : rien.

### HX51 · La publication relit chaque vidéo générée
- Statut : à faire
- Qui : Claude, voie 1 (touche `annonces/medias.ts`), relecture normale
- Dépendances : HX42
- Partie du cahier : M19, M07 (photos et vidéos).
- Objectif : R498. `MediasBien.publishable()` (P06) et tout envoi d'une vidéo (portails, vitrine, réseaux) passent chaque vidéo rangée dans `generated_videos` par `VideosGenerees.diffusable` au moment d'envoyer : accord de voix ou d'avatar retiré, agent du bien changé ou parti, ou photos du plan changées, et elle ne part pas, même si un montage ou un contrôle de texte existe sous la même référence. Remarque P0 de Codex sur #421.
- Critères : après retrait de l'accord, la vidéo n'est dans aucune annonce publiée (test) ; une même référence portant un montage et une vidéo générée suit la règle la plus stricte (test) ; photos changées, la vidéo ne part plus (test).
- Ce qu'elle attend d'un humain : rien.

### HX42 · Vidéo depuis les photos, voix off et avatar
- Statut : fait (2026-11-08)
- Reste : fusionnée (#421, cd86f21a), migration `2302`, R495 à R497) : Codex sans remarque sur `68223447` (2 P0 et 1 P2 corrigés, 1 P0 confié à HX51), vérification locale verte (4820 tests) ; GitHub Actions bloqué par la facturation ; la fusion a été refusée par la permission de la séance du 2026-11-08 vers 07:00 : la séance suivante la fusionne (section 3, étape 3, et section 11). Décidé, lecture prudente : plan tiré par le code des photos publiables du Studio (zoom ou panoramique en liste fermée, mobilier qui apparaît en fondu depuis la jumelle réelle, fin à la marque, 12 plans au plus), vidéo faite sur l'appareil ; voix et avatar de l'agent du bien lui-même seulement, accord écrit (texte nommé et versionné recopié à l'identique, jamais par la direction) pour l'empreinte de son propre enregistrement, retirable ; « Vidéo générée » et mention de la voix ou de l'avatar de synthèse sur chaque plan, exigées par la base ; sous-titres en français et dans les langues ouvertes du bien (HX05), contrôlés ligne par ligne et à la suite ; adresse refusée comme en P06. Restent : routes, écran et assemblage sur l'appareil (voie 1, `app.ts`) ; diffusion relue (HX51).
- Objectif : comme Hektor, Talqor et Kappn : vidéo animée à partir des photos, mobilier qui apparaît, voix off, sous-titres, avatar de l'agent. Jamais vu : la voix et l'avatar ne viennent que de l'agent lui-même, avec son accord écrit, et la vidéo porte la mention « vidéo générée » ; les sous-titres sortent dans les langues de HX05 ; l'adresse exacte est refusée comme en P06.
- Critères : aucune voix ni avatar sans accord écrit de l'agent (test) ; la mention est présente sur chaque vidéo générée (test) ; une adresse exacte dans le texte est refusée (test).

### HX43 · Visite à 360 degrés avec contact
- Statut : en cours (voie 2)
- Objectif : comme Hektor, Immofacile, Apimo et Optimhome : une visite 360 ou 3D faite au téléphone, avec un formulaire de contact dedans. Jamais vu : chaque vue est reliée à sa pièce du plan de X04, aucune vue ne montre la rue ni le numéro, et le contact pris dans la visite arrive dans C01 avec son origine.
- Critères : un contact de la visite est rattaché au bien et à son origine (test) ; une vue sans pièce rattachée n'est pas publiée (test).

### HX44 · Avant et après la visite : dossier envoyé, visite à distance et son bon
- Statut : à faire
- Objectif : comme Talqor et Live Visit de Hektor : envoyer le dossier du bien avant la visite, faire visiter à distance, éditer le bon de visite ensuite. Jamais vu : le dossier envoyé est celui de la version publiée du jour, sans donnée confidentielle, et le bon de visite d'une visite à distance se signe en ligne par D08 juste après.
- Critères : aucun nom de vendeur, honoraire ni note interne dans le dossier envoyé (test) ; un bon de visite à distance est signé avant toute offre (test) ; l'envoi passe par le contrôle central (test).

## Offre, avant-contrat et notaire

### HX45 · Avant-contrat préparé, et projet du notaire comparé à l'offre
- Statut : à faire
- Objectif : comme Hektor et Modelo : avant-contrat généré depuis l'offre, suivi du dépôt de garantie, récupération du projet notarial. Jamais vu : quand le projet du notaire arrive, l'appli le compare à l'offre acceptée, prix, conditions suspensives, dates, et signale chaque différence ; le dépôt de garantie est suivi comme versé au notaire, jamais à AIMMO.
- Critères : chaque différence entre projet et offre est signalée (test) ; aucun texte ne demande un versement à AIMMO, règle de N05 (test) ; les dates de l'avant-contrat remplissent N02 (test).

## Après-vente et avis

### HX46 · Avis clients vérifiables, publiés partout
- Statut : à faire
- Objectif : comme Opinion System, Immodvisor et Hektor : avis vérifiés, étoiles sur les annonces, diffusion sur Google, le site, les portails et les réseaux. Jamais vu : chaque avis porte une preuve qu'il vient d'un dossier réellement clos, vérifiable par n'importe qui sans donnée personnelle, et tous les avis sont montrés, jamais triés par la note.
- Critères : un avis sans dossier clos est refusé (test) ; aucun avis masqué selon sa note (test) ; la vérification publique ne révèle aucune donnée personnelle (test).

## Mise en location

### HX47 · Dossiers de location contrôlés contre la fraude
- Statut : à faire
- Objectif : comme MonsieurHugo : repérer les faux bulletins de salaire et faux avis d'imposition. Jamais vu : le code vérifie ce qui est vérifiable, code 2D-Doc de l'avis d'imposition, existence de l'employeur dans la base Sirene, calculs du bulletin, et rend un constat ligne par ligne à l'agent, jamais une note de la personne.
- Critères : un avis d'imposition au code 2D-Doc faux est signalé (test) ; le résultat est un constat, sans note ni classement (test) ; aucune pièce hors de la liste officielle n'est demandée (test).

## Commerces, neuf et viager

### HX48 · Programmes neufs et viager
- Statut : à faire
- Objectif : comme Hektor et Apimo : vendre des lots de programmes neufs et des biens en viager. Jamais vu : pour le viager, bouquet et rente calculés par le code, chaque chiffre avec sa source et son hypothèse comme Y03, rejouable, avec mise en relation de l'expert viager de M18 ; pour le neuf, la grille des lots tenue à jour et les frais réduits calculés.
- Critères : un calcul de viager se rejoue à l'identique (test) ; chaque chiffre cite sa source et son hypothèse (test) ; un lot vendu disparaît de la grille publiée (test).

## Facturation

### HX49 · Factures fournisseurs et rapprochement bancaire
- Statut : à faire
- Objectif : comme Ma Boîte Immo : factures fournisseurs lues par l'IA, rapprochement bancaire automatique, relance des impayés. Jamais vu : chaque encaissement est relié à sa facture et à la ligne de banque qui le prouve, et une facture d'honoraires non payée à son échéance prépare une relance validée par la direction.
- Critères : un encaissement n'est rapproché qu'à une seule facture (test) ; un montant lu sur une facture fournisseur est vérifié contre son total et sa TVA (test) ; aucune relance sans validation (test).

## Pilotage

### HX50 · Rapports sur mesure et export complet
- Statut : à faire
- Objectif : comme Immofacile et Modelo : rapports personnalisables et export intégral des données. Jamais vu : chaque agent emporte à tout moment l'export complet de ses propres données, avec son empreinte, et chaque chiffre d'un rapport s'ouvre sur ses lignes comme en K04.
- Critères : l'export d'un agent ne contient que ses données (test) ; aucun rapport ne compare deux agents entre eux, règle R14 (test) ; chaque chiffre renvoie à ses lignes (test).

## Formation

### HX51 · Quiz et attestations de formation
- Statut : à faire
- Objectif : comme Immofacile et l'Akadémie de Hektor : quiz d'auto-formation et attestations conservées. Jamais vu : les questions sont tirées des vraies règles du réseau et des modules de l'académie, chaque erreur renvoie au module à revoir, et l'attestation se vérifie par son empreinte.
- Critères : chaque question renvoie à sa règle ou à son module (test) ; une attestation modifiée échoue à la vérification (test).

## Marketing et réseaux sociaux

### HX52 · Calendrier de publication sur tous les réseaux
- Statut : à faire
- Objectif : comme Hektor : publications automatiques avec calendrier, connexion à Facebook, Instagram, LinkedIn, TikTok, YouTube et la fiche Google, contenus prêts chaque semaine. Jamais vu : le calendrier suit les règles réglées par l'agent, par exemple un bien nouveau chaque jour, jamais un bien repris tant qu'un autre n'est pas sorti, le nombre de publications par réseau, et chaque publication porte son lien marqué de AT20.
- Critères : aucun bien repris tant qu'un bien n'est jamais sorti (test) ; le nombre réglé par réseau et par jour est tenu (test) ; tout passe par le contrôle central (test).

### HX53 · Lettre d'information et magazine des biens
- Statut : à faire
- Objectif : comme Artur'in et Netty : newsletters et magazine immobilier. Jamais vu : chaque lettre est faite pour sa personne, biens qui lui correspondent, valeur suivie de son bien si elle l'a demandée, prix de son quartier de AT01, et le magazine imprimable sort de la même base.
- Critères : aucune lettre sans accord rangé (test) ; lien de désinscription dans chaque lettre (test) ; aucun prix qui ne vienne de la base (test).

### HX54 · Publicité payante mesurée au mandat
- Statut : à faire
- Objectif : comme Hektor : campagnes Google Ads gérées, et de même sur Meta. Jamais vu : chaque campagne est jugée sur les mandats et ventes qu'elle rapporte, lus dans G10, et s'arrête seule quand le coût par contact dépasse le seuil réglé.
- Critères : aucune dépense sans validation de la direction (test) ; arrêt automatique au seuil (test) ; aucun ciblage par un critère interdit pour le logement (test).

## Intégrations

### HX55 · Serveur MCP et API ouverte
- Statut : à faire
- Objectif : comme Neo, Apimo et Maline : piloter le logiciel depuis ChatGPT ou Claude et ouvrir une API aux partenaires. Jamais vu : chaque outil agit sous les droits de l'agent de S08, n'écrit que des brouillons à valider et passe au journal ; une lecture publique des biens diffusables répond aussi aux assistants d'achat comme AQQI.
- Critères : aucun appel hors des droits de l'agent (test) ; aucune écriture définitive sans validation (test) ; la lecture publique ne rend que des biens diffusables, sans donnée personnelle (test).

## Sécurité et conformité

### HX56 · Clé d'accès, double authentification et données en Europe
- Statut : à faire
- Objectif : comme iad : connexion par empreinte ou visage et double authentification, et comme Hektor, Modelo et Talqor : hébergement en Europe. Jamais vu : une clé d'accès par appareil, retirée d'un geste par la direction, et un test de configuration qui échoue si une base ou un stockage sort de la juridiction européenne.
- Critères : un appareil retiré ne se connecte plus (test) ; une action sensible exige un second facteur (test) ; une base hors Europe fait échouer la vérification (test).

### HX57 · Contrôle du gel des avoirs
- Statut : à faire
- Objectif : comme Modelo : vérifier chaque client contre le registre national des gels. Jamais vu : les dossiers ouverts sont revérifiés à chaque mise à jour du registre, et une correspondance va au seul responsable, sans rien changer à ce que voit le client, comme L05.
- Critères : une correspondance alerte le responsable et fige le dossier (test) ; le client ne voit aucune différence (test) ; chaque contrôle est daté avec la version du registre (test).

### HX58 · Réclamations des clients et médiateur
- Statut : à faire
- Objectif : comme Hektor : médiateur de la consommation pris en charge. Jamais vu : chaque réclamation est suivie avec son délai de réponse, et le médiateur est proposé de lui-même au client si la réclamation n'est pas réglée à l'échéance.
- Critères : chaque réclamation a son échéance et ses alertes (test) ; le médiateur est proposé à l'échéance (test).

---

## Phase 1 : le socle

D'après la Feuille de route, novembre et décembre 2026. Condition pour passer à la suite : 30 jours sans aucun envoi hors règles, et plus aucune tâche du système planifiée dans les applications.

### S01 · Base du dépôt
- Statut : fait (2026-10-25)
- Qui : Claude · Relecture : normale · Dépend de : rien
- Fait : règles pour Claude et Codex, protocole, plan, vérifications automatiques, garde-fous, squelette TypeScript testé.

### S02 · Reprendre l'existant
- Statut : fait (2026-10-26)
- Qui : Claude · Relecture : normale · Dépend de : S01
- Cahier : Synthèse, « Ce qui fonctionne déjà » ; Architecture technique, tableau « Outil actuel, Remplacé par, Quand ».
- Objectif : savoir, en lecture seule, ce qui tourne déjà dans `shawez-lab/shawez-immo` (`functions/`, `functions/_lib/`, `functions/migrations/`, `outils/`, `.github/workflows/`) pour le reprendre au lieu de le refaire. Lire les noms et l'en-tête de chaque fichier, puis le détail seulement de ce que le socle reprend.
- Livrable : `docs/EXISTANT.md` : chaque brique en une ligne, ce qu'elle fait, ses données, ce qu'AIMMO en reprend ou remplace, et dans quelle tâche.
- Critères : chaque fichier de `functions/` et chaque workflow est cité ; aucun secret ni aucune donnée personnelle recopiés ; aucune modification de `shawez-immo`.

### S03 · Modèle de données de la fiche client unique
- Statut : fait (2026-10-26)
- Qui : Claude · Relecture : forte · Dépend de : S02
- Cahier : Architecture technique, le modèle de données ; Conformité, données personnelles.
- Objectif : le schéma SQL, compatible D1 et SQLite, des personnes et de leurs identifiants (mail, téléphone, Instagram, Facebook, WhatsApp), accords, exclusions, projets, biens réduits au nécessaire, messages, agents et sources, avec un accès typé dans `packages/core`.
- Livrables : `db/migrations/0001_fiche_client.sql`, `packages/core/src/db/`, tests sur `node:sqlite`.
- Critères : les migrations s'appliquent sur une base vide et se rejouent sans erreur ; une personne peut avoir plusieurs identifiants ; aucune colonne pour une pièce d'identité ou des coordonnées bancaires [R15] ; chaque table a sa clé et les index utiles aux recherches du socle.

### S04 · Une seule fiche par personne
- Statut : fait (2026-10-26)
- Qui : Claude · Relecture : forte · Dépend de : S03
- Cahier : Feuille de route, novembre 2026 ; Architecture technique, fiche client unique.
- Objectif : normaliser les identifiants (téléphone au format international, mail en minuscules, comptes de réseaux), repérer les doublons, fusionner deux fiches en gardant tout l'historique, et pouvoir défaire une fusion.
- Critères : sur un jeu inventé de 50 fiches avec doublons connus, 50 sur 50 bien regroupées ; une fusion se défait ; rien n'est effacé [R17].
- Décidé (2026-10-26), lecture prudente : les noms ne rapprochent jamais deux fiches, seuls les identifiants normalisés le font ; deux fiches suivies par deux agents différents ne se fusionnent pas tant que la direction n'a pas attribué la personne ; une fusion relie les fiches sans déplacer aucune ligne, ce qui la rend exactement réversible.

### S05 · Exclusions, arrêts, accords et horaires
- Statut : fait (2026-10-26)
- Qui : Claude · Relecture : forte · Dépend de : S04
- Cahier : Conformité, prospection et accords ; Risques, décision « Réponses le soir et le dimanche ».
- Objectif : une décision unique « peut-on écrire à cette personne, sur ce canal, pour ce type de message, maintenant ? », avec la règle qui a décidé.
- Critères : un test par règle et par cas limite : samedi 19 h 59 et 20 h 00, dimanche, réponse à un message reçu il y a 59 et 61 minutes, personne exclue qui écrit, demande d'arrêt sur un canal puis envoi sur un autre ; R01 à R04 et R11 passent en service.
- Décidé (2026-10-26), lecture prudente : toute exclusion active ferme tous les canaux ; tout message d'initiative par téléphone, SMS, WhatsApp ou mail demande un accord enregistré pour sa finalité, la demande du client s'enregistrant comme accord, sauf réponse à un message resté sans réponse ; le plafond des demandes d'avis vaut pour tout le réseau ; un message reçu qui dit stop, non ou vendu exclut aussitôt, dans le doute on se tait. Reste : horaires et fréquence des appels du décret de 2022, avec le bouton « appeler ».

### S06 · Contrôle central des envois
- Statut : fait (2026-10-26)
- Qui : Claude · Relecture : forte · Dépend de : S05
- Cahier : Architecture technique, contrôle central des envois ; Intelligence artificielle, garde-fous ; Conformité, mention de l'assistant.
- Objectif : le seul chemin de sortie de tout message. Il applique la décision de S05, l'anti-doublon, la mention du premier message, le contrôle du texte, le texte de secours, et écrit tout au journal. Les canaux sont des interfaces avec de faux canaux pour les tests : aucun envoi réel.
- Critères : un test vérifie qu'aucun autre code n'appelle un canal directement ; un test par règle ; R05 à R10, R12 et R13 passent en service.
- Décidé (2026-10-26), lecture prudente : l'heure d'un envoi est toujours celle du contrôle ; un même texte, sujet ou bien ne part qu'une fois à vie, sur tous les canaux ; sujets, texte, mention et places du plafond du jour sont réservés par une instruction atomique avant l'envoi ; une réponse qui ne peut pas partir est refusée et signalée à l'agent (`needsHuman`) plutôt que répétée ; sans prénom d'agent, la mention dit « votre agent immobilier ».
- Reste : un envoi en panne compte encore dans le plafond du jour de S05 (`DecisionEnvoi.sentToday`), côté prudent, à corriger avec S07 ou S11 ; mise en attente jusqu'au prochain créneau quand R01 refuse ; plafond de 5 échanges de l'assistant (M02).

### S07 · Journal à empreintes
- Statut : fait (2026-10-26)
- Repris (2026-10-26) : Shawez a poussé le travail de Codex sur `codex/S07` (commit `18fa3cc`), Claude l'a fini et fusionné (#4) : ajout seul imposé en base (modification, effacement et remplacement refusés), aucune donnée personnelle dans toute la ligne ni dans les noms de champs, copie figée de la ligne, ajouts simultanés gardés
- Qui : Claude (Codex ne peut pas pousser, H12) · Relecture : normale · Dépend de : S01
- Où : la tâche est décrite dans `chantier/taches/S07.md` sur la branche `codex/S07`, proposition n° 4. La reprendre telle quelle.
- Cahier : Architecture technique, journal ; M06, registre des mandats.
- Objectif : un journal en ajout seul dans `packages/core/src/journal/`, chaque ligne liée à la précédente par son empreinte SHA-256, pour qu'aucune modification ne passe inaperçue. Stockage derrière une interface, avec une version SQLite (`db/migrations/0002_journal.sql`).
- Critères : une ligne modifiée, supprimée ou intervertie est détectée ; recherche par personne et par période ; aucune donnée personnelle en clair dans l'empreinte ni dans le texte de la ligne, seulement des identifiants internes [R13].

### S08 · Droits d'accès
- Statut : fait (2026-10-26)
- Décidé (2026-10-26), lecture prudente : les biens en vente des autres agents forment le fichier commun du réseau, visible de tous ses agents, sans donnée de client (le cahier l'emporte sur l'ancien texte de R16, précisé) ; une fiche sans agent, ou réunie à celle d'un autre agent, n'est pas visible d'un agent ; direction : fiches, biens, chiffres, journal, jamais le coffre anti-blanchiment ; conformité : fiches, biens, journal, coffre, pas les chiffres ; partenaire : rien jusqu'à M18 ; agent parti ou inconnu coupé ; chaque lecture et chaque refus écrits au journal avant de rendre la donnée, rien n'est lu si le journal ne répond pas.
- Reste : rôles responsable d'équipe, assistant et comptabilité ; identité des rôles hors agent par la connexion (S09) ; colonne réseau dans le journal ; relecture de Codex de la dernière version restée en cours 25 minutes, fusion sans elle (#12).
- Qui : Claude · Relecture : forte · Dépend de : S03, S07
- Cahier : Architecture technique, sécurité et droits.
- Objectif : rôles agent, direction, conformité et partenaire ; un agent ne voit que ses clients, ses biens et ses chiffres ; chaque lecture d'une fiche est écrite au journal.
- Critères : un test d'accès refusé par rôle et par type de donnée ; R16 passe en service.

### S09 · API du socle sur Cloudflare
- Statut : fait (2026-10-26)
- Qui : Claude · Relecture : forte · Dépend de : S04, S05, S06, S07, S08
- Attend : H04 pour la mise en ligne seulement.
- Cahier : Architecture technique, les briques et l'hébergement.
- Objectif : un Worker Cloudflare avec D1 qui expose la fiche client, la décision d'envoi en mode essai et le journal, protégé par une clé. Configuration `wrangler` prête, déploiement par GitHub dès que H04 est fait.
- Critères : tests de bout en bout en local ; aucune clé dans le dépôt ; la mise en ligne ne change rien aux systèmes de `shawez-immo`.
- Décidé (2026-10-26), lecture prudente : API fermée par défaut (sans clés ou hors `MODE = "essai"` : 503) ; le secret `API_KEYS` ne porte que l'empreinte de chaque clé et l'identité qu'elle donne ; base `aimmo` créée en juridiction européenne par le déploiement ; aucune route, seulement workers.dev. Notice : `docs/API.md`.
- Reste : la première clé d'API (H14) quand un appelant viendra ; écriture du message et du journal en un seul lot D1 (C01, C02) ; une base `aimmo` déjà existante n'est pas contrôlée sur sa juridiction.

### S10 · Reprise des contacts existants
- Statut : fait (2026-11-01)
- Reste : I04 et I05 faits, le vrai passage attend H15.
- Qui : Claude · Relecture : forte · Dépend de : S02, S09
- Cahier : Feuille de route, novembre 2026 : import et fusion des contacts existants, exclusions et accords repris.
- Objectif : à découper en tâches d'après `docs/EXISTANT.md`, au début de la tâche : sources, ordre de reprise, contrôle sur 50 fiches.
- Statut du découpage : découpée le 2026-10-26 en I01 à I04 ci-dessous ; S10 est faite quand I04 l'est.
- Décidé (2026-10-26), lecture prudente : sources dans l'ordre : 1. la base D1 `espace-estimation` du site (comptes, demandes d'estimation), lue en lecture seule ; 2. la liste d'exclusion de Shawez et les contacts de GoHighLevel et ManyChat, par exports CSV que seul Shawez peut sortir (H15). Rien n'est jamais écrit dans les sources. Une demande « Perdu » vaut refus [R02] ; « Pas maintenant » ne donne aucun accord de prospection ; l'accord du site (`consentement_le`) ne vaut que pour le suivi de l'estimation demandée, sur mail et téléphone ; les demandes de robots (`suspect`) et les adresses de test (`*.test.invalid`) ne sont pas reprises, seulement comptées. Les fiches reprises sont confiées à l'agent Shawez.

### I01 · Lire la base du site
- Statut : fait (2026-10-26)
- Qui : Claude · Relecture : normale · Dépend de : S09
- Cahier : Feuille de route, novembre 2026 ; `docs/EXISTANT.md`, `functions/schema.sql` et `functions/_lib/base.js` de `shawez-immo`.
- Objectif : un lecteur qui, sur une base au schéma du site, rend la liste des contacts à reprendre dans un format commun : clé d'origine, mail, téléphone, prénom, nom, date du compte et de l'accord, demandes (référence, type, code postal, commune, statut, raison, dates). Il ne fait que des `SELECT`, supporte les tables et colonnes ajoutées plus tard absentes, et compte ce qu'il écarte.
- Critères : sur une base inventée au schéma du site, chaque compte et chaque demande sans compte donne un contact, sans perte ; une demande de robot et une adresse de test sont écartées et comptées ; le lecteur échoue s'il tente autre chose qu'une lecture ; contact illisible gardé et signalé, jamais jeté.
- Attend : rien.

### I02 · Reprendre les contacts du site dans la fiche client
- Statut : fait (2026-10-26)
- Qui : Claude · Relecture : forte · Dépend de : I01
- Cahier : Feuille de route, novembre 2026 : « Une seule fiche par personne, contrôlée sur 50 fiches. Toutes les exclusions connues marquées ».
- Objectif : chaque contact lu devient ou complète une fiche (S04) : identifiants normalisés, source, projet vendeur par demande, accord du site avec sa preuve, exclusion pour « Perdu ». Reprise relançable : la relancer ne crée ni ne double rien. Un rapport sans donnée personnelle : fiches créées, complétées, réunies, écartées.
- Critères : 50 contacts inventés dont des doublons connus donnent exactement les fiches attendues [R17] ; relancer la reprise ne change rien ; chaque « Perdu » est exclu [R02] ; aucun accord de prospection n'est créé [R03] ; rien n'est effacé [R17] ; journal sans donnée personnelle [R13].
- Attend : rien.

### I03 · Liste d'exclusion et contacts des outils
- Statut : fait (2026-10-26)
- Qui : Claude · Relecture : forte · Dépend de : I02
- Cahier : Feuille de route, novembre 2026 ; R02.
- Objectif : reprendre par fichiers CSV la liste d'exclusion de Shawez et les contacts de GoHighLevel et ManyChat, avec leurs désinscriptions (« ne pas déranger », désabonné) qui deviennent des exclusions sur tous les canaux. Format des colonnes documenté pour que Shawez sache quoi exporter.
- Critères : une personne de la liste d'exclusion, retrouvée par mail ou téléphone, est exclue sur toutes ses fiches [R02] ; un désabonné de GoHighLevel ou ManyChat est exclu [R04] ; une ligne illisible est signalée, jamais jetée ; relancer ne double rien.
- Attend : rien pour la construire ; H15 pour les vrais fichiers.

### I04 · Reprise réelle et contrôle sur 50 fiches
- Statut : fait (2026-11-01)
- Décidé (2026-11-01) : I04 livre le moteur (`RepriseReelle`, #225) : les trois fichiers de H15 exigés et tous lus avant la première écriture ; contrôle sur 50 personnes (lignes regroupées par fiche) tirées au hasard, vert sans doublon, sans exclusion manquante ni contact introuvable ; des fiches de deux agents sont « à attribuer », pas un échec. Le lancement sur les vraies bases passe en I05 : une requête du Worker ne peut pas faire des milliers de requêtes D1. Relecture forte : 1 P1 corrigé ; Codex à sa limite (H03), fusion sans lui.
- Qui : Claude · Relecture : forte · Dépend de : I02, I03
- Cahier : Feuille de route, novembre 2026.
- Critères : `shawez-immo` et sa base ne sont pas modifiés ; le rapport ne contient aucune donnée personnelle ; contrôle sur 50 fiches sans doublon ni exclusion manquante.

### I05 · Lancer la reprise sur les vraies bases
- Statut : fait (2026-11-01)
- Décidé (2026-11-01), lecture prudente : dépôt des trois fichiers par la direction dans l'application (écran du réseau), rangés dans la base `aimmo` en ajout seul, vérifiés au dépôt ; lancement par le travail GitHub « Reprise des contacts » (lancé à la main, API REST de D1), par morceaux de 100 avec l'avancement rangé ; un nouveau contact du site ne refait que la source « site ». Relecture forte : 4 P1 corrigés ; Codex à sa limite (H03), fusion sans lui (#229).
- Reste : vrai passage dès que H15 est déposé (la séance lance le travail par l'API REST de GitHub) ; purge des textes déposés à brancher sur la procédure d'effacement (L07) ; base `espace-estimation` supposée dans le même compte Cloudflare.
- Qui : Claude · Relecture : forte · Dépend de : I04
- Cahier : Feuille de route, novembre 2026.
- Objectif : faire tourner `RepriseReelle` sur la base `espace-estimation` (lecture seule) et la base `aimmo` en production, avec les trois fichiers de H15, puis rapporter le contrôle sans donnée personnelle. À choisir d'abord, par la lecture la plus prudente : où Shawez dépose ses fichiers sans geste technique (écran de la direction dans l'application, rangés dans la base `aimmo`, jamais dans le dépôt) ; comment la reprise atteint la base en production (workflow GitHub lancé à la main avec l'API REST de D1, par morceaux relançables si le travail est coupé) ; pas une requête du Worker (limite de requêtes D1 par appel).
- Critères : `shawez-immo` et sa base ne sont pas modifiés (lecture seule testée) ; rien ne tourne sans les trois fichiers ; une coupure en cours se relance sans rien doubler ; rapport et journaux du travail sans donnée personnelle [R13].
- Attend : H15 pour le vrai passage seulement.

### S11 · Bascule des automatisations existantes sur l'API
- Statut : en cours
- Qui : Claude · Relecture : forte · Dépend de : S06, S09
- Attend : H05 pour les mails.
- Cahier : Feuille de route, novembre 2026 : alertes acquéreurs, tâches planifiées, mention de l'assistant dans les réponses automatiques par mail.
- Objectif : à découper au début de la tâche, d'après `docs/EXISTANT.md`. Chaque bascule passe d'abord en mode essai, sans envoi réel, puis à 10 % pendant 7 jours, puis partout si les chiffres tiennent, avec retour arrière automatique.
- Statut du découpage : découpée le 2026-10-27 en B01 à B04 ci-dessous ; S11 est faite quand B04 l'est.
- Décidé (2026-10-27), lecture prudente : les automatisations qui envoient aujourd'hui sont les deux tâches à heure fixe du site (`taches.yml` → `/api/espace/taches` : rappel de visite la veille de 18 h à 21 h, mails au vendeur gardés la nuit et partis à 8 h) et la première réponse aux leads (`lead-tri.js`), déjà reprise par M02 (C06, C09). Il n'existe pas d'alertes acquéreurs sur le site : elles naîtront directement sur le socle avec M08, il n'y a rien à basculer. La bascule ne refait pas le site : le site garde ses données et ses textes, et demande au socle, avant chaque envoi, s'il peut partir ; le socle passe la demande par le contrôle central (S06). D'abord en ombre (le site envoie comme avant, le socle décide sans rien envoyer, les deux décisions sont comparées), puis le socle décide pour 10 % des envois pendant 7 jours, puis pour tous, avec retour arrière automatique. Les tâches planifiées quittent GitHub Actions pour le planificateur du Worker AIMMO. Rien n'est modifié dans `shawez-immo` sur main : ses changements passent par une branche et une proposition sur ce dépôt-là, fusionnée seulement par Shawez.

### B01 · Demande d'envoi d'une automatisation, en mode essai
- Statut : fait (2026-10-27)
- Qui : Claude · Relecture : forte · Dépend de : S06, S09
- Cahier : Feuille de route, novembre 2026 ; Architecture technique, « Le contrôle central des envois ».
- Objectif : une route `POST /v1/automatisations/envoi`, ouverte seulement à une clé de dépôt `site_auto` qui ne lit aucune fiche : le site y dit quelle automatisation (rappel de visite, courrier au vendeur), à quelle adresse, sur quel sujet et avec quel texte ; le socle retrouve la fiche par l'adresse, passe la demande par le contrôle central avec les canaux du mode essai, et rend la décision et sa règle, sans rien envoyer.
- Critères : rien ne part jamais (canaux d'essai seulement) [R26] ; une personne inconnue, exclue ou arrêtée, la nuit ou le dimanche, un doublon de sujet : refusés avec leur règle [R01, R02, R05] ; le texte du site passe le contrôle du texte ; le journal ne porte ni adresse ni texte [R13] ; une autre clé que `site_auto` est refusée.

### B02 · Planificateur du socle
- Statut : fait (2026-10-27)
- Qui : Claude · Relecture : normale · Dépend de : B01
- Cahier : Feuille de route, novembre 2026 : « plus aucune tâche du système planifiée dans les applications ».
- Objectif : le Worker `aimmo-api` a un déclencheur horaire et un registre des tâches à heure fixe, à l'heure de Paris ; chaque tâche ne passe qu'une fois par créneau, son passage est écrit au journal ; les tâches du site y sont inscrites en mode essai (le passage est noté, rien n'est appelé).
- Critères : heures de Paris été comme hiver ; une tâche, un passage par créneau même si le déclencheur passe deux fois ; une erreur est écrite au journal ; aucun appel sortant en mode essai.

### B03 · Le site demande au socle, en ombre
- Statut : bloquée : #16 fusionnée sur shawez-immo le 2026-11-06 ; l'ombre démarrera quand H14 et H37 (clé `site_auto`, variables du projet Pages) seront faits
- Décidé (2026-10-29) : seul un envoi réel du site est soumis au socle (en essai, un « would_send » y est rangé comme un envoi : sujet gardé, pression commerciale) ; ce que le site n'envoie pas est compté à part (`site_seul`), hors écarts. Ainsi un message du site compte une seule fois [R11]. La mention de l'assistant [R06] du message rangé chez le socle reste celle du socle : à aligner sur le texte réel du site dans B04, avant que le socle décide. Référence d'une visite datée (`visite-<id>-<minute>`), pour qu'une visite déplacée ne soit pas prise pour un doublon [R05]. Relecture forte : 2 P1 corrigés.
- Qui : Claude · Relecture : forte · Dépend de : B01, B02
- Cahier : Feuille de route, novembre 2026.
- Objectif : sur une branche de `shawez-immo` et une proposition à fusionner par Shawez, le site appelle `POST /v1/automatisations/envoi` avant chaque rappel de visite et chaque courrier gardé, garde son propre envoi inchangé, et note les deux décisions ; un rapport compte les écarts, sans donnée personnelle.
- Critères : le site envoie exactement comme avant, même si le socle ne répond pas ; écarts comptés par règle ; aucune donnée personnelle dans le rapport.
- Attend : H04, H14, et la fusion par Shawez de la proposition sur `shawez-immo`.
- À régler ici : en essai, le contrôle range le message du site comme sortant sur la fiche, avec la mention de l'assistant [R06] ; en ombre, il faut qu'un message que le site envoie lui-même compte une seule fois dans la pression commerciale [R11] et que la mention soit celle que le site met vraiment.

### B04a · Paliers de la bascule côté socle, fermés
- Statut : fait (2026-11-02)
- Qui : Claude · Relecture : forte · Dépend de : B01, B02
- Cahier : Feuille de route, novembre 2026.
- Objectif : détaché de B04 le 2026-11-02 pour ne pas arrêter le chantier : la partie du socle, qui n'attend personne. Chaque automatisation a son palier (ombre, 10 %, partout), son tirage fixe par envoi et son retour arrière automatique, sans rien changer aux envois.
- Critères : tirage fixe par envoi ; ombre vers 10 % par geste de la direction seule, après 7 jours sans incident et 20 demandes ; 10 % vers partout de lui-même, après 7 jours sans incident et 5 décisions réellement prises par le socle ; retour en ombre au premier écart non expliqué ou à la première panne ; le socle n'envoie rien à aucun palier [R26] ; rien de personnel au journal [R13].
- Décidé (2026-11-02), lecture prudente : le passage à 10 % reste fermé tant que la variable `AUTOMATION_ROLLOUT_OPEN` n'est pas branchée (B04) : la mention R06 n'est pas alignée et le site ne lit pas encore `decides`. Une adresse inconnue du socle : le site décide seul, le socle ne sachant rien d'elle ; adresse portée par plusieurs fiches : le refus du socle vaut, selon le tirage. Les seuils de 20 demandes et de 5 décisions sont des réglages, jusqu'à ce que Shawez en décide autrement.

### B04b · Mention de l'assistant alignée sur le texte du site
- Statut : fait (2026-11-02)
- Qui : Claude · Relecture : forte · Dépend de : B04a
- Cahier : Feuille de route, novembre 2026 ; mention de l'assistant dans les réponses automatiques par mail.
- Objectif : détaché de B04 le 2026-11-02. En ombre et aux paliers, le message rangé chez le socle est exactement celui que le site envoie : le contrôle ne doit ni ajouter sa propre mention, ni la compter comme donnée alors que le site ne l'a pas mise. Lire dans `shawez-immo` (lecture seule) ce que disent vraiment ses rappels et courriers, puis décider dans cette tâche.
- Critères : un message du site compte une seule fois [R11] ; la mention est tenue pour donnée seulement si le texte du site la porte, et sinon la demande est refusée avec R06 quand le socle décide [R06] ; aucun autre appelant du contrôle central ne change de comportement ; rien ne part [R26].
- Décidé (2026-11-02), lecture prudente : lu dans `shawez-immo` : ni les rappels ni les courriers ne portent de mention aujourd'hui. Le contrôle reçoit le texte du site « tel quel » (`asWritten`) : rangé sans rien ajouter, dans un fil à lui (`automatisations-site`), pour que ses messages ne dispensent aucun autre appelant de la mention et qu'aucune mention d'un autre ne vaille pour le site ; ce fil n'entre pas dans la décision, qui reste celle d'un mail sans conversation citée. La mention vaut seulement écrite à la lettre, en un paragraphe, à n'importe quelle place puisque le site commence par son sujet. Sans mention due : le socle qui décide refuse avec R06, sinon le message est rangé et `mentionMissing` le signale. Un refus pour mention manquante ne fait pas monter le palier : il ne prouve rien tant que le site n'est pas aligné. Un message que le socle refuse en ombre n'est pas rangé, alors que le site l'envoie : l'écart est compté, pas le message.
- Reste, pour B04 sur le site : porter la mention au premier message ; le texte transmis commence au sujet, sans « Bonjour <prénom> », et le rappel cite l'adresse du bien : écarts R08 et R09 à attendre en ombre et à trancher avant d'ouvrir le passage. Relecture forte : 1 P0 et 2 P1 corrigés.

### B04 · 10 % puis partout, avec retour arrière automatique
- Statut : à faire
- Qui : Claude · Relecture : forte · Dépend de : B03
- Cahier : Feuille de route, novembre 2026 ; mention de l'assistant dans les réponses automatiques par mail.
- Objectif : le socle décide pour 10 % des envois tirés au hasard pendant 7 jours, puis pour tous si les écarts tiennent ; tout écart non expliqué ou toute panne ramène automatiquement au mode ombre ; `taches.yml` est retiré du site.
- Critères : le tirage est fixe par envoi ; le retour arrière est testé ; après bascule, plus aucune tâche planifiée dans GitHub Actions du site pour ces envois.
- Attend : H05, B03 en ombre depuis 7 jours sans écart non expliqué.
- Reste après B04a et B04b : ouvrir le passage (`AUTOMATION_ROLLOUT_OPEN`) ; sur le site : lire `decides`, signaler écarts et pannes par `POST /v1/automatisations/incident` et rejouer ce signalement si le socle ne répond pas (une panne de sa base ne peut pas le ramener en ombre seule) ; retirer `taches.yml`.

### B05 · Écran de la bascule pour la direction
- Statut : fait (2026-11-02)
- Voie : 2
- Reste : fusionnée (#278) ; relecture forte 3 P1 corrigés ; Codex à sa limite (H03) ; le passage reste fermé tant que B04 n'ouvre pas `AUTOMATION_ROLLOUT_OPEN`, l'écran le dit ; `fiche-google.ts` et `attirer.ts` gardent un chargeur muet si leur script arrive abîmé et un verrou qui survit à la session : à reprendre à leur prochain passage.
- Trouvé le 2026-11-02 (après AT14) : aucun écran n'appelle `/v1/automatisations/paliers`, son geste `avancer`, ni `/v1/journal/verification` : la direction ne pourrait voir ni un retour en ombre, ni faire avancer une automatisation, ni vérifier le journal sans passer par l'API.
- Qui : Claude, voie 2 · Relecture : forte · Dépend de : B04a, B04b
- Cahier : Feuille de route, novembre 2026 ; R26, R16, R201.
- Objectif : sur l'écran du réseau, la direction voit le palier de chaque automatisation du site, son dernier retour en ombre, fait passer de l'ombre à 10 %, et vérifie la chaîne du journal.
- Critères : l'écran n'appelle que ces trois routes [R16] ; l'écran ne décide rien : un refus `not_open`, `too_early`, `not_enough_requests` est dit en français [R26] ; passer à 10 % se confirme en deux appuis espacés ; un retour en ombre est montré avec sa date et sa raison ; un journal abîmé est dit sans en montrer le contenu [R13] ; script chargé à part, budget tenu [R201].
- Attend : H37 pour de vrais envois comptés.

**Accords notés par l'agent : trou trouvé le 2026-11-02.**
Voie : 2

Trouvé en cherchant ce que laissait W10 (« rien ne range encore l'accord `suivi_location` »). Le trou est plus large : aucune route ne permet de noter un accord sur une fiche. Les finalités `suivi_vente`, `suivi_mandat`, `suivi_location`, `value_tracking`, `route_share` n'ont aucune source d'accord en production, et `alertes_biens` et `valuation_follow_up` seulement l'espace du client ou la reprise. Le contrôle central refuserait donc ces envois pour toujours (R03). Le refus est du bon côté de la loi, mais ces modules ne marcheraient jamais. Et le bouton « appeler » ne regarde pas l'accord, alors que le cahier le demande (Conformité : « bloqué sans accord enregistré ou demande du client »).

### AC01 · L'agent note et retire un accord, avec sa preuve
- Statut : fait (2026-11-02)
- Qui : Claude, voie 2 · Relecture : forte · Dépend de : S05, S06
- Cahier : Conformité, démarchage téléphonique et accord préalable ; R03, R02, R04, R13, R16, R17.
- Objectif : un service `AccordsFiche` (`packages/core/src/acces/accords.ts`) et ses routes (`packages/api/src/accords.ts`), prêtes pour le socle : l'agent de la fiche ou la direction note l'accord qu'une personne lui a donné (finalité, canal, date, preuve) et le retire quand elle le demande.
- Décidé (2026-11-02), lecture prudente : liste fermée de finalités, sans celles que leur module range lui-même ni la prospection des partenaires (H32) ; canaux où R03 demande un accord ; preuve écrite de 10 à 1 000 caractères, gardée sur la fiche, jamais au journal ; date donnée par l'agent, jamais dans le futur ; retirer ferme tous les accords de même finalité et de même canal sur les fiches réunies. Antidater ne peut pas effacer un retrait ou une exclusion levée : un accord daté d'avant est refusé.
- Critères : une personne exclue ou arrêtée ne peut pas recevoir d'accord [R02, R04] ; un autre agent est refusé et le refus va au journal [R16] ; l'accord noté ouvre l'envoi au contrôle central, le retrait le referme [R03] ; un accord déjà en cours n'est pas doublé ; un retrait ou une exclusion levée ne s'efface pas par une date ancienne [R03] ; ni preuve ni adresse au journal [R13] ; aucune ligne effacée [R17].

### AC05 · Un accord retiré ne se rouvre jamais par une fusion ou une levée
- Statut : fait (2026-11-02)
- Décidé (2026-11-02), lecture prudente : à date égale, le refus l'emporte ; une ligne fermée à sa propre date n'a jamais valu : c'est une réservation en ligne ratée, pas un refus de la personne ; `undoMerge` ferme aussi les accords des autres fiches de l'arbre créés pendant la fusion, et cette fermeture vaut retrait : mieux vaut refaire noter un accord que d'écrire à la mauvaise personne. Relecture forte : aucun P0, 3 P1 : 1 corrigé, 2 reportés en AC07 et AC08 ; Codex à sa limite (H03), fusion sans lui (#244).
- Voie : 1
- Qui : Claude, voie 1 · Relecture : forte · Dépend de : AC01
- Cahier : Conformité, accord préalable ; R03, R02, R04, R202.
- Objectif : trouvé par la relecture forte de AC01, et déjà possible avant elle. `decideSend` (`envoi/decision.ts`) accepte n'importe quel accord ouvert. Cas reproduits : un retrait sur la fiche A, un accord ouvert ou daté d'avant sur le doublon B, puis une fusion, y compris sans geste humain (`reception/rattachement.ts`, `reprise/reprise.ts`) : l'envoi redevient permis. De même, une exclusion levée rouvre un accord plus ancien qu'elle. Laissée à la voie 1 : c'est le contrôle des envois, donc le socle. Faire avant AC02 : les routes d'accords restent fermées tant que ce n'est pas réglé. Passer R202 à « oui » ici.
- Critères : un accord ne compte que s'il est postérieur au dernier retrait de même finalité et de même canal sur les fiches réunies (test [R03]) ; et au dernier `lifted_at` d'une exclusion (test [R02] [R04]) ; `undoMerge` ferme, sans effacer et avec une ligne au journal, les accords créés pendant la fusion, car on ne sait plus à qui ils sont (test [R03] [R17]) ; les tests de S05 et S06 restent verts.

### AC07 · Un accord redonné est rangé, même si une ligne ancienne reste ouverte
- Statut : fait (2026-11-02)
- Reste : relecture forte aucun P0, 3 P1 corrigés ; Codex à sa limite (H03), fusion sans lui (#247).
- Décidé (2026-11-02), lecture prudente : `FicheUnique.hasConsentInForce` et `channelsInForce`, la même règle que le contrôle central, servent aux sept gestes, au pré-contrôle des alertes (sinon le refus fermait le bien pour toujours) et aux écrans du client (« alertes demandées », suivi de valeur). Les signatures et le dossier d'un commerce lisent maintenant les fiches réunies. Reste à trancher par Shawez (H42) : la parole de l'agent peut-elle redonner un accord retiré ? La sécurité des visites dit non, ces gestes disent oui, comme le demande cette tâche.
- Voie : 1
- Qui : Claude, voie 1 · Relecture : forte · Dépend de : AC05
- Cahier : Conformité, accord préalable ; R03.
- Objectif : trouvé par la relecture forte de AC05. Plusieurs modules n'ajoutent l'accord que si aucune ligne n'est ouverte (`espaces/gestes.ts`, `espaces/entree.ts`, `apres-vente/relances-apres-vente.ts`, `documents/signature-en-ligne.ts`, `commerces/dossier.ts`, `commerces/confidentialite.ts`, `location/signature-bail.ts`). Or une ligne ouverte peut ne plus compter (AC05) : le client qui redemande les alertes se croit inscrit, et tout est refusé en R03. Aucun envoi indu, mais une demande perdue en silence. Ces modules passent par `consentInForce` sur la fiche réunie.
- Critères : après un retrait sur une fiche et une fusion avec un doublon ouvert, redonner l'accord le range et rouvre l'envoi, pour chacun de ces modules (test [R03]) ; un accord qui compte n'est pas doublé ; les tests des modules restent verts.

### AC08 · Une exclusion notée pendant une fusion suit les deux fiches quand on la défait
- Statut : fait (2026-11-02)
- Décidé (2026-11-02), lecture prudente : la copie va de fiche à fiche seulement si les deux étaient réunies quand l'exclusion a été notée (date de création, lue par couple) ; elle garde la date et la levée de l'original, pour qu'un accord plus ancien ne compte pas de nouveau ; `exclusions.undone_merge_id` (migration `1520`) la relie à sa fusion. Relecture forte : aucun P0, 2 P1 corrigés ; Codex à sa limite (H03), fusion sans lui (#250).
- Voie : 1
- Qui : Claude, voie 1 · Relecture : forte · Dépend de : AC05
- Cahier : Conformité ; R02, R04, R17.
- Objectif : trouvé par la relecture forte de AC05. Un arrêt reçu pendant une fusion est rangé sur une seule fiche : après `undoMerge`, l'autre fiche n'a plus d'exclusion et ses accords comptent de nouveau. Aucun appelant de `undoMerge` en production aujourd'hui : à faire avant toute route ou tout geste qui l'appelle. Dans le même lot, les exclusions actives notées pendant la fusion sont recopiées sur chaque fiche séparée, on ne sait plus à qui elles sont.
- Critères : stop noté pendant la fusion, puis fusion défaite : plus aucun envoi sur aucune des deux fiches (test [R04]) ; de même pour une exclusion (test [R02]) ; aucune ligne effacée [R17] ; une exclusion notée avant la fusion ne bouge pas.

### AC02 · Branchement des routes d'accords dans le socle
- Statut : fait (2026-11-02)
- Reste : Codex à sa limite (H03), fusion sans lui (#246).
- Voie : 1
- Qui : Claude, voie 1 · Relecture : normale · Dépend de : AC01, AC05
- Cahier : Architecture technique.
- Objectif : ajouter `accordsRoutes()` au routeur de `app.ts`, et décrire les deux routes dans `docs/API.md`.
- Critères : chaque route répond sous son rôle [R16] ; la suite complète reste verte.

### AC03 · Écran : noter et retirer un accord depuis la fiche
- Statut : fait (2026-11-02)
- Décidé (2026-11-02), lecture prudente : l'écran envoie le jour seul (`givenOn`) ; aujourd'hui vaut l'heure du serveur, un jour passé son premier instant à Paris, donc un retrait du même jour ferme la porte ; sujet, canal et jour à choisir à chaque fois ; « déjà en cours » suit le calcul du bouton d'appel. Téléphone et axe-core vérifiés une fois à la main (Chromium 390 × 844, clair et sombre, aucune violation) : axe-core n'est pas une dépendance du dépôt. L'application touche son budget de poids (48 Ko) : le prochain ajout devra se charger à part. Relecture forte : 6 P1 corrigés ; Codex à sa limite, fusion sans lui (#248).
- Voie : 2
- Qui : Claude, voie 2 · Relecture : forte · Dépend de : AC02
- Cahier : Conformité ; système de design [R201].
- Objectif : dans la fiche de l'application, le bloc « Accords » propose de noter un accord (finalité, canal, date, preuve) et de le retirer ; le refus dit sa raison en français.
- Critères : parcours au téléphone ; axe-core sans violation ; rien de personnel au journal [R13].

### AC04 · Bouton « appeler » fermé sans accord ni demande du client
- Statut : fait (2026-11-02)
- Décidé (2026-11-02), lecture prudente : ouvrent l'appel par téléphone `prospecting`, `reply` et `rappel_demande` (nouvelle finalité d'AC01) ; une demande vaut 13 mois ; un retrait par téléphone ferme tous les accords par téléphone plus anciens ; `recommandation` n'ouvre pas : la parole d'un tiers n'est pas la demande de la personne ; un accord importé sans canal ne vaut plus pour le téléphone ; le numéro composé est le dernier donné. Relecture forte : aucun P0 net, 7 P1, corrigés sauf le décret (AC06) ; Codex à sa limite, fusion sans lui (#243). `GET /v1/fiches/<id>` et les messages laissent le numéro lisible : le bouton empêche l'appel en un geste, il ne cache pas le numéro.
- Voie : 2
- Qui : Claude, voie 2 · Relecture : forte · Dépend de : AC01
- Cahier : Conformité, démarchage téléphonique.
- Objectif : `FicheAgent` ne rend le numéro à appeler que si la personne a un accord en cours par téléphone, ou a elle-même demandé à être rappelée.
- Critères : sans accord ni demande, pas de numéro, et l'écran dit pourquoi [R03] ; un accord retiré referme le bouton [R03].

### AC06 · Horaires et fréquence des appels de prospection
- Statut : fait (2026-11-02)
- Décidé (2026-11-02), lecture prudente : les heures (lundi au vendredi, 10 h à 13 h, 14 h à 20 h, hors jours fériés) ferment l'appel qui repose seulement sur la prospection acceptée ; une demande de rappel reste ouverte à toute heure. Le texte officiel n'a pas pu être lu (fiche de la DGCCRF fermée à la séance) : heures tirées de deux articles de 2022, dont l'un dit que le décret ne vise pas un consentement préalable ; question à l'avocat en H41. La fréquence va en AC07. Relecture forte : aucun P0, 1 P1 de code corrigé (`callClosesAt`) ; Codex à sa limite, fusion sans lui (#245).
- Voie : 2
- Qui : Claude, voie 2 · Relecture : forte · Dépend de : AC04
- Cahier : Conformité, démarchage téléphonique : « Horaires et fréquence fixés par le décret de 2022 respectés ».
- Objectif : le bouton « appeler » suit les horaires et la fréquence du décret, à vérifier d'abord dans sa source officielle.
- Critères : hors des horaires, le bouton est fermé et l'écran dit quand il rouvre [R03] ; une demande de la personne ne se ferme pas de la même façon si le décret ne la vise pas, décision écrite ici ; fréquence : à découper si aucune trace d'appel n'existe encore.

### AC09 · Fréquence des appels de prospection
- Statut : fait (2026-11-02)
- Décidé (2026-11-02, voie 2), lecture prudente : chiffres en réglage `CALL_FREQUENCY`, 4 appels de prospection en 30 jours et 60 jours après un refus, sans avoir pu lire le texte officiel (FAQ de la DGCCRF en erreur pour la séance) ; H41 reste ouverte. Une demande de la personne ne compte pas ; donnée après le refus elle rouvre l'appel, plus ancienne elle ne vaut plus. Un refus n'est pas un arrêt [R04]. Règle R204. Service, table et route non branchée. Relecture forte : 3 P1, 2 corrigés, le troisième (fusion défaite) reporté en AC12 ; Codex à sa limite, fusion sans lui (#253).
- Voie : 2
- Qui : Claude, voie 2 · Relecture : forte · Dépend de : AC06
- Cahier : Conformité, démarchage téléphonique.
- Objectif : l'agent note qu'il a appelé et, s'il y a lieu, que la personne a refusé ; le bouton compte ces appels. Aucune trace d'appel n'existe aujourd'hui.
- Critères : à vérifier d'abord dans le texte officiel (H41) : plus de 4 appels de prospection en 30 jours ferment le bouton ; un refus le ferme 60 jours [R203] ; une demande de la personne ne compte pas ; rien de personnel au journal [R13].
- Attend : H41 pour les chiffres ; deux articles de 2022 disent 4 appels en 30 jours et un refus de 60 jours ou de deux mois.

### AC10 · Le prénom de la fiche gardée partout où un texte part
- Statut : fait (2026-11-02)
- Décidé (2026-11-02, voie 2) : `ficheFirstName` suit l'ordre de `membersOf`, celui du contrôle central ; le tri par identifiant de #249 est remplacé. Codex à sa limite, fusion sans lui (#251).
- Voie : 2
- Qui : Claude, voie 2 · Relecture : normale · Dépend de : AC03
- Cahier : R08.
- Objectif : trouvé en réparant main (#249) : sur une fiche réunie, le prénom est lu sans ordre, et celui d'un doublon fait refuser le texte en R08. Corrigé pour les alertes de M08 ; reste `investir/alertes.ts`, `mandats/gagner/anciens-contacts.ts` (3 fois), `mandats/suivi-valeur.ts`, `estimation/suivi.ts`. Une seule fonction, partagée.
- Critères : sur une fiche réunie à deux prénoms, chaque texte part avec le prénom de la fiche gardée, à chaque passage (test [R08]) ; si elle n'en a pas, celui d'un doublon, toujours le même.

## Phase 2 : la preuve à Dijon

À découper au fil de l'eau, dans l'ordre de la Feuille de route : M02 et M03 en décembre 2026, puis M04, M20 et l'application de l'agent en janvier 2027, et la suite mois par mois.

**M02 · Capter, décembre 2026.**

Découpé le 2026-10-26. Ids `C..` pour Capter. Cahier : M02 Capter ; Feuille de route, décembre 2026 : « chaque nouveau contact crée ou complète sa fiche en moins d'une minute ».
Décidé, lecture prudente : tout M02 se construit en mode essai, sans aucun envoi réel ; ManyChat et `functions/api/manychat-dm.js` de `shawez-immo` restent en place, intouchés, jusqu'à C09 ; l'IA est derrière une interface, avec une fausse IA dans les tests, et la vraie ne se branche qu'avec H13 ; chaque réponse sort par le contrôle central de S06, jamais autrement.

### C01 · Réception unifiée des messages
- Statut : fait (2026-10-26)
- Qui : Claude · Relecture : forte · Dépend de : S04, S06
- Cahier : M02, « Canaux » et critère « Un même message reçu deux fois ne produit qu'une réponse ».
- Objectif : un format commun « message entrant » (canal, identifiant du message chez le canal, conversation, expéditeur, texte, date, publication commentée, pièce jointe signalée) et un adaptateur de normalisation par canal : message et commentaire Instagram, Messenger et commentaire Facebook, WhatsApp, mail dont mails de portails, formulaire du site, assistant du site. Chaque message reçu est rangé une seule fois.
- Critères : un exemple inventé par canal et par type se normalise sans perte ; un même message reçu deux fois, ou deux fois en même temps, n'est rangé et traité qu'une fois [R18] ; un message illisible est rangé et signalé à l'agent, jamais jeté ; aucune donnée personnelle dans le journal [R13].
- Attend : rien.
- Décidé (2026-10-26), lecture prudente : seuls les événements connus pour ne pas être des messages sont écartés (accusés, statuts, réactions, échos et publications de nos comptes) ; tout le reste non compris est rangé comme illisible et signalé à l'agent ; un message rangé mais jamais pris est repris, `claim` garantissant un seul traitement ; les messages Meta en `standby` (ManyChat a la main) sont lus.
- Reste : les échos de nos propres messages sont écartés ici, C05 devra s'en servir pour savoir qu'un agent a répondu [R21] ; écriture du message et du journal en une seule transaction D1 avec S09.

### C02 · Rattacher chaque contact à sa fiche
- Statut : fait (2026-10-26)
- Qui : Claude · Relecture : forte · Dépend de : C01
- Cahier : M02, « Fiche » ; Feuille de route, décembre 2026.
- Objectif : à chaque message entrant, retrouver la personne par mail, téléphone ou compte normalisés (S04), sinon créer sa fiche ; rattacher le message, la source et, quand la personne écrit d'elle-même, l'accord pour lui répondre (S05) ; repérer la demande d'arrêt et l'exclusion dès la réception.
- Critères : sur 50 contacts inventés dont des doublons connus, chaque message rejoint la bonne fiche et aucune fiche en double n'est créée ; une personne exclue qui écrit est reconnue et rien ne lui répond [R02] ; « stop » reçu sur un canal ferme tous les canaux [R04] ; fiche créée ou complétée en moins d'une minute, mesuré dans le test.
- Attend : rien.
- Décidé (2026-10-26), lecture prudente : on retrouve par identifiant normalisé ou par identifiant propre au canal (message privé Instagram ou Messenger, session du site), jamais par le nom ; plusieurs fiches trouvées sont réunies (fusion S04) sauf si deux agents les suivent : alors rattaché à la plus ancienne, exclusions partagées entre toutes, direction prévenue ; l'accord de réponse (finalité `reply`) naît du message reçu, jamais d'un message d'arrêt ; formulaire « Être rappelé » : accord sur téléphone et mail donnés ; message abandonné repris après 10 minutes, chaque étape se reprenant sans se répéter.
- Reste : relecture de Codex restée « en cours » plus de 45 minutes, fusion sans elle (#11) ; une coupure exactement entre le rangement du message et sa note pourrait le doubler, à fermer avec les lots D1 de S09 ; un commentaire Instagram (compte) et un message privé (numéro du canal) d'une même personne restent deux fiches.

### C03 · Reconnaître le bien concerné
- Statut : fait (2026-10-26)
- Qui : Claude · Relecture : normale · Dépend de : S03
- Cahier : M02, « Première réponse » et règles ; critère « 3 commentaires sur 3 vidéos ».
- Objectif : trouver le bien dont parle le message : publication ou vidéo commentée, lien d'annonce, référence de portail, référence citée dans le texte. Table de correspondance publication → bien dans la base. Sans correspondance sûre : aucun bien, jamais une supposition.
- Critères : 3 commentaires inventés sur 3 vidéos différentes donnent 3 biens différents et justes ; un lien ou une référence inconnus donnent « bien non reconnu » [R20] ; deux biens possibles donnent « bien non reconnu ».
- Attend : rien.

### C04 · Composer la première réponse
- Statut : fait (2026-10-26)
- Qui : Claude · Relecture : forte · Dépend de : C02, C03
- Cahier : M02, « Première réponse », « Conversation naturelle », règles ; Intelligence artificielle, garde-fous.
- Objectif : la première réponse avec les vraies données du bien (prix affiché, surface, quartier, atout principal) et une seule question pour avancer : visite, rappel ou estimation. Tutoiement sur Instagram, vouvoiement avec le prénom ailleurs, langue du client, clôture courte quand la personne remercie ou dit non. L'IA est une interface ; la réponse passe par le contrôle central (mention, texte, secours).
- Critères : chaque chiffre de la réponse vient de la fiche du bien [R10] ; jamais l'adresse exacte ni le nom du vendeur [R19] ; bien non reconnu : message simple et honnête sans aucune donnée de bien [R20] ; une seule question ; IA muette ou trop chère : texte de secours [R12] ; mention au premier message [R06] ; un test par canal pour le ton [R08].
- Attend : rien pour la construire ; H13 pour brancher la vraie IA.
- Décidé (2026-10-26), lecture prudente : sans bien reconnu, ou quand le vendeur porte le prénom de la personne, l'IA ne rédige pas, seuls les textes de secours partent ; l'IA reçoit le message sans mails, téléphones ni adresses ; un bien déjà envoyé à la personne n'est plus cité ; un merci reçoit une clôture sans le bien ; une seule réponse par message reçu (`first_reply_claims`), rendue après un refus ou une panne ; quartier et atout dans `property_details`.
- Reste : la vraie IA (H13) ; seuls le français et l'anglais sont gérés, une autre langue reçoit du français.

### C05 · Conversation et relais à l'agent
- Statut : fait (2026-10-26)
- Qui : Claude · Relecture : forte · Dépend de : C04
- Cahier : M02, « Relais humain », « L'IA et l'humain », règles.
- Objectif : l'état de chaque conversation : l'assistant converse jusqu'au rendez-vous ou au plus 5 échanges, puis passe la main ; l'IA se tait pour de bon dès qu'un humain répond ; l'agent voit la conversation et la reprend à tout moment.
- Critères : après la réponse d'un agent, plus aucun message automatique dans cette conversation [R21] ; au 6e message du client, l'agent est prévenu et l'assistant se tait [R21] ; sur Instagram, Facebook et WhatsApp, rien ne part hors de la fenêtre de 24 heures depuis le dernier message du client [R22] ; une relance à l'initiative du réseau ne part ni le soir ni le dimanche [R01].
- Attend : rien.
- Décidé (2026-10-26), lecture prudente : R21 et R22 sont dans la décision d'envoi, donc tenues pour tout message automatique ; sur un canal de Meta, un envoi sans conversation citée est tenu par toutes les conversations de la personne sur ce canal ; « 5 échanges » = 5 messages reçus du client ; un écho sans application connue est humain, sauf identifiant rendu par le canal à notre envoi ou, sur Meta seulement, même texte qu'un envoi encore sans identifiant ; un écho WhatsApp Business est toujours humain ; sans aucun message du client sur un canal de Meta, rien ne part ; la conversation passée à l'agent ne se rouvre jamais.
- Reste : réponse de l'agent depuis sa boîte mail non vue (avec C06) ; les réponses suivantes reprennent la première réponse de C04, une vraie conversation suivie viendra avec l'IA (H13) ; relecture de Codex de la dernière version restée en cours 30 minutes, fusion sans elle (#19).

### C06 · Mail et formulaire du site, en mode essai
- Statut : fait (2026-10-26)
- Qui : Claude · Relecture : forte · Dépend de : C05, S09
- Cahier : M02, « Branchements » ; `docs/EXISTANT.md`, `lead.js` et `lead-tri.js`.
- Objectif : brancher sur l'API du socle la réception des mails (routage mail de Cloudflare, mails de portails compris) et du formulaire « Être rappelé », de bout en bout jusqu'à la réponse, en mode essai : la réponse est écrite au journal, jamais envoyée.
- Critères : 20 messages tests par canal, de jour comme de nuit sur une horloge simulée, donnent chacun une réponse prête en moins d'une minute ; le même mail reçu deux fois ne donne qu'une réponse [R18] ; `shawez-immo` n'est pas modifié.
- Attend : H04 pour la mise en ligne seulement.
- Décidé (2026-10-26), lecture prudente : chaîne `createCaptation` de bout en bout, boîte d'essai `trial_outbox` à la place des canaux ; MIME lu sans dépendance ; chaque mail est d'abord remis tel quel à la boîte de l'agent (`MAIL_FORWARD_TO`), jamais rejeté, ce n'est pas un envoi ; clé de dépôt à part (`INTAKE_KEYS`) qui ne lit rien et ne rend que `received` ; l'heure de réception d'un mail ou d'un formulaire est celle d'AIMMO [R01] ; formulaire sans mail : l'agent est prévenu de rappeler [R12] ; un nouvel envoi reprend un rattachement abandonné ou une réponse interrompue, sans doublon.
- Reste : branchement réel avec H16 (C09), où les messages de la boîte d'essai ne devront pas compter comme partis ; intégration au site de `shawez-immo` dans une tâche à part ; relecture de Codex de la dernière version restée en cours 25 minutes, fusion sans elle (#20).

### C07 · Instagram, Facebook et WhatsApp, en mode essai
- Statut : fait (2026-10-27)
- Qui : Claude · Relecture : forte · Dépend de : C06
- Cahier : M02, « Branchements » : API Meta avec notifications en temps réel, API WhatsApp Business.
- Objectif : les points d'arrivée des notifications de Meta et de WhatsApp, avec vérification de la signature, en mode essai, testés sur des notifications inventées. ManyChat reste seul à répondre.
- Critères : une notification à la signature fausse est refusée ; 20 messages tests par canal donnent une réponse prête en moins d'une minute ; un commentaire reçoit une réponse qui cite le bon bien ; aucun envoi réel ; ManyChat intouché.
- Attend : H06 pour recevoir les vraies notifications de Meta.
- Décidé (2026-10-27), lecture prudente : une seule adresse `/v1/meta/notifications` pour les trois canaux, signature HMAC du corps brut, jeton d'abonnement gardé en empreinte ; un écho d'une application qui n'est pas la nôtre est humain (pendant l'essai, ManyChat fait donc taire l'assistant dans sa conversation) ; un écho dont la conversation n'existe pas encore est gardé (`pending_human_replies`) et appliqué avant toute réponse, reprise comprise ; sur Instagram et Facebook, la réponse va à la conversation reçue (compte propre au canal ou commentaire), seulement si un message de la personne y est rangé.
- Reste : avant tout envoi réel (C09), sérialiser par conversation l'écho humain et le premier message traités en même temps (fenêtre étroite signalée par Codex, sans effet en essai) ; branchement chez Meta avec H06 et H17 ; relecture forte (1 P1 corrigé), Codex : 4 P0 corrigés en 4 tours, le dernier réduit et reporté à C09 (#21).

### C08 · API de l'assistant du site, en mode essai
- Statut : fait (2026-10-27)
- Qui : Claude · Relecture : forte · Dépend de : C05, S09
- Cahier : M02, « Canaux » : assistant du site.
- Objectif : l'API que l'assistant du site appellera : ouvrir une conversation, envoyer un message, recevoir la réponse, avec les mêmes règles que les autres canaux. Son intégration au site sera une proposition sur `shawez-immo`, faite dans une tâche à part, jamais directement sur main.
- Critères : 20 messages tests donnent une réponse en moins d'une minute ; mention au premier message [R06] ; une conversation sans accord ne laisse aucune donnée personnelle au-delà de ce que la personne a écrit [R15] ; appels limités par visiteur.
- Attend : H04 pour la mise en ligne seulement.
- À savoir au départ (2026-10-27) : `site` n'est pas un canal de sortie (`CHANNELS`, `consents`, `exclusions` ne l'admettent pas) et `replyChannel` de C04 ne rend rien pour l'assistant ; la réponse de l'assistant doit pourtant passer par le contrôle central (R02, R04, R06, R10, R19, R21). Choisir d'abord comment, par la lecture la plus prudente.
- Décidé (2026-10-27), lecture prudente : `site` devient un canal de sortie (`OUTBOUND_CHANNELS`) sans toucher `CHANNELS`, ni les accords, ni les exclusions, qui restent par personne ; sur ce canal, seulement la réponse dans la session du visiteur et dans l'heure de son message, jamais d'initiative [R03, R01] ; la réponse va à la session d'où la personne a écrit, vérifiée comme les conversations de Meta ; même clé de dépôt `INTAKE_KEYS`, avec une source `site_chat` qui n'ouvre que l'assistant ; visiteur connu par l'empreinte d'un identifiant opaque donné par le site, jamais d'adresse IP ni de navigateur [R15] ; limites par heure prises en une seule instruction ; en essai, `reply` vaut `null`. Un visiteur garde une seule fiche d'une conversation à l'autre (empreinte de son identifiant comme référence du canal), pour qu'un arrêt vaille pour toutes [R02, R04].
- Reste : intégration au site de `shawez-immo` dans une tâche à part ; texte rendu au visiteur avec le branchement réel (C09) ; relecture forte (aucun P0 ni P1), Codex : 1 P0 corrigé, dernière version validée (#22).

### C09a · Écho humain et premier message traités en même temps
- Statut : fait (2026-11-02)
- Voie : 2
- Qui : Claude · Relecture : forte · Dépend de : C07
- Cahier : M02, « Branchements » ; R21. Partie de C09 détachée parce qu'elle n'attend personne (SECOURS : un service pas encore ouvert n'arrête pas le code).
- Objectif : fermer la fenêtre signalée par Codex sur #21. Un écho humain et le premier message du client, reçus par deux notifications en même temps, ne doivent jamais laisser partir la réponse automatique quand l'écho est arrivé avant le dernier contrôle, ni laisser un écho sans effet.
- Décidé (2026-11-02), lecture prudente : pas de verrou (D1 n'en a pas, et un Worker ne doit pas attendre). L'écho d'un humain est écrit dans `pending_human_replies` avant de chercher sa conversation, et le dernier contrôle de la réponse relit les échos non appliqués de la conversation, puis le passage à l'agent : un écho écrit avant ce contrôle arrête la réponse. Reste physiquement possible : un écho écrit après le dernier contrôle, le message part déjà. Rien n'est effacé de la table [R17] : le texte y reste en double de la fiche, pour la durée du registre, sous la procédure d'effacement de la Conformité. L'écho de notre propre message reconnu à son identifiant n'y entre pas. Une coupure entre la réservation et le rangement : le texte est repris du renvoi ou de la table, après 2 minutes et sous un bail. La grille des tests prend un point sur cinq au début du message, où l'écho écrit précède toujours la dernière lecture, et tous les points juste avant celle-ci.
- Critères : écho figé à chaque accès après son écriture pendant que le message s'arrête aux points de la grille : aucune réponse (test [R21]) ; dans tous les ordres, la conversation finit chez l'agent et aucun écho ne reste en attente (test [R21]) ; écho reçu pendant la rédaction : rien ne part (test [R21]) ; l'écho de notre propre message ne fait pas taire l'assistant (test [R21]) ; coupure à chaque accès de l'écho, puis renvoi : la conversation est à l'agent et le message est une seule fois sur la fiche (test [R21]) ; rien n'est effacé de la table (test [R17]).
- Reste, à trancher dans C09 : une réponse privée à un commentaire peut partir alors qu'un humain a répondu en message privé (conversations distinctes, déjà le cas avant C09a) ; un écho `unfinished` renvoyé avant 2 minutes attend le prochain message du réseau pour être rangé (rien de perdu, l'assistant reste muet).

### C09b · Palier de la captation par canal, derrière le contrôle central
- Statut : fait (2026-11-02)
- Voie : 1
- Qui : Claude · Relecture : forte · Dépend de : C09a, B04a
- Cahier : M02, « État » ; Feuille de route, décembre 2026. Partie de C09 qui n'attend personne : les vrais canaux restent de faux canaux dans les tests.
- Objectif : chaque canal de captation a son palier (`PaliersBascule`, une automatisation par canal) : essai, 10 % des messages tirés une fois pour toutes, partout, retour en essai à la première panne du canal. Sans vrai canal fourni, tout reste dans la boîte d'essai. Laissée à la voie 1 : il faut toucher au contrôle central (`envoi/controle.ts`, seul à appeler `deliver`, et son garde-fou).
- Critères : tirage fixe par message [R26] ; sans vrai canal, rien ne part, à aucun palier [R26] ; une panne du canal ramène ce canal en essai sans toucher aux autres, et l'agent est prévenu [R26, R12] ; un message de la boîte d'essai ne compte pas comme parti : ni pour l'anti-doublon [R05], ni pour la mention de l'assistant [R06], ni pour les plafonds [R11], ni pour le silence de 24 heures [R22] ; journal sans donnée personnelle [R13].
- Décidé (2026-11-02), lecture prudente : le palier passe par `staging` dans le contrôle central, seul à appeler `deliver` ; seule la chaîne de captation s'en sert par défaut, les autres modules et `createCaptation` avec `channels` ne changent pas. Le tirage se fait sur le message reçu ; sans référence, la boîte d'essai. Le palier « ombre » de la bascule veut dire « essai » pour un canal. Une réponse qui reste dans la boîte ne prend ni sujet, ni texte, ni mention, ni place au plafond, et n'est pas prise pour notre écho [R21] : chaque réponse d'essai porte donc la mention et peut répéter le même texte, le premier message réel restant à venir. Tests C08 de la mention et du secours : ils passent par une vraie session, puisque l'essai ne compte plus. Une alerte sur une fiche encore sans agent suit l'agent qui reçoit la fiche.
- Reste, pour C09 : aucun vrai canal n'est branché, et aucune route ne permet encore à la direction d'avancer le palier d'un canal (`/automatisations/paliers` ne connaît que les automatisations du site). Relecture forte : 1 P0 et 2 P1 corrigés.

### AC11 · Le prénom de la fiche réunie, dans les modules qui lisaient une seule ligne
- Statut : fait (2026-11-02)
- Décidé (2026-11-02, voie 2) : trouvé en faisant AC10, 12 modules ; un test interdit désormais cette lecture, sauf 3 fichiers expliqués. Les documents de confidentialité gardent le nom de leur ligne. Codex à sa limite, fusion sans lui (#252).
- Voie : 2
- Qui : Claude, voie 2 · Relecture : normale · Dépend de : AC10
- Cahier : R08.
- Objectif : même faille que AC10 dans les lectures `WHERE id = ?`.
- Critères : confirmation, rappel et remerciement sur une fiche réunie portent le prénom de la fiche gardée (test [R08]).

### AC12 · Appels notés : branchement, écran, fusion défaite
- Statut : fait (2026-11-02)
- Décidé (2026-11-02), lecture prudente : les gestes sont servis à part (`/app/appels.js`), il restait 370 octets au budget de l'application ; ils restent ouverts bouton fermé, un fait se note ; pas de confirmation, une erreur de geste ferme l'appel, jamais ne l'ouvre, et une nouvelle demande rouvre ; une note et sa copie gardent la même heure et comptent pour un seul appel si les fiches sont réunies de nouveau ; `refused_request` dit le refus sur une fiche qui n'a qu'une demande, sans date. Téléphone et axe-core vérifiés une fois à la main (Chromium 390 × 844, clair et sombre, aucune violation). Relecture forte : 1 P1 corrigé ; Codex à sa limite, fusion sans lui (#258).
- Reste : une note écrite juste après le lot d'`undoMerge` n'est pas recopiée, même fenêtre que les exclusions (AC08).
- Voie : 1
- Qui : Claude, voie 1 · Relecture : forte · Dépend de : AC09
- Cahier : Conformité, démarchage téléphonique ; R204.
- Objectif : ajouter `appelsRoutes()` au routeur de `app.ts` et décrire la route dans `docs/API.md` ; passer `db` à `AccordsServices` dans `accordsFicheRoutes`, sans quoi une demande plus ancienne qu'un refus paraît encore en cours ; sur la fiche, les gestes « j'ai appelé » et « la personne a refusé », et les textes de `too_many_calls`, `refused_recently` (avec `callReopensAt`) et `given_before_refusal`, dans le budget de poids de l'application [R201]. Dans `undoMerge`, recopier de l'autre côté les notes rangées depuis la fusion, avec leur heure, leur résultat et leur base, sans rien effacer : à faire avant tout appelant de `undoMerge`.
- Critères : chaque route répond sous son rôle [R16] ; refus noté, fusion défaite : le bouton reste fermé sur les deux fiches, et le plafond compte des deux côtés (test [R204]) ; aucune ligne effacée [R17] ; une demande datée d'avant un refus est refusée par la route branchée (test [R204]) ; parcours au téléphone, axe-core sans violation [R201].

### C09c · Alertes de l'agent visibles dans l'application
- Statut : fait (2026-11-02)
- Voie : 1
- Qui : Claude · Relecture : forte · Dépend de : C09b
- Cahier : M02, relais à l'agent ; R12, R21.
- Objectif : trouvé par la relecture de C09b : `agent_alerts` est écrite, mais `alertsFor` n'a aucun lecteur en production. Une réponse tombée ou une conversation à reprendre ne se voit donc nulle part. Une route et un bloc de l'application montrent à l'agent ses alertes, et il les marque vues.
- Critères : l'agent voit ses alertes et celles de ses fiches, jamais celles d'un autre [R16] ; marquer vue ne supprime rien [R17] ; parcours au téléphone, axe-core sans violation [R201] ; rien de personnel au journal [R13].
- Décidé (2026-11-02), lecture prudente : une alerte suit la fiche que l'agent voit maintenant (fiche passée à un autre : il ne la voit plus ; prénom par `ficheFirstName`) ; `person_id` d'une nouvelle alerte est la fiche du message, pour survivre à une fusion défaite, les lignes déjà rangées ne sont pas reprises. Une alerte vue se rouvre seulement pour un message reçu après (le même message rejoué ne la rouvre pas), aussi quand le client réécrit sans réponse humaine, l'assistant restant muet. L'écran envoie la date lue : un écran ancien ne referme pas une alerte rouverte. Téléphone et axe-core vérifiés à la main (Chromium 390 × 844, clair et sombre, avant et après le geste, aucune violation) : axe-core n'est pas une dépendance du dépôt. Budget : l'application était à sa limite ; `/app/alertes.js` chargé seulement s'il y a des alertes, et le dépôt de la reprise sorti dans `/app/reprise.js`, chargé au premier geste. Relecture forte : 7 P1 corrigés ; Codex à sa limite, fusion sans lui (#254).
- Reste : C09d.

### C09d · Alertes vues de personne : la direction les compte
- Statut : fait (2026-11-02)
- Voie : 1
- Qui : Claude · Relecture : forte · Dépend de : C09c
- Cahier : M02, relais à l'agent ; R12, R16.
- Objectif : trouvé par la relecture de C09c : une alerte sur une fiche sans agent (après un départ, avant une attribution) ou réunie à celle d'un autre agent n'est vue de personne, car la direction n'a pas la route. La direction voit le nombre de ces alertes, par raison, sans donnée de client, pour attribuer les fiches.
- Critères : une alerte sans agent qui la voit est comptée pour la direction, et sort du compte dès qu'un agent la voit (test [R12]) ; aucun prénom, aucune référence de conversation dans la réponse ni au journal (test [R13]) ; un agent n'a pas ce compte (test [R16]).
- Décidé (2026-11-02), lecture prudente : comptées aussi les fiches d'un agent parti ou au dossier incomplet, qui ne les voit pas. Une ligne par fiche et par raison, sans borne avant le filtre ; seules les fiches réunies coûtent une lecture de plus, 100 au plus, au-delà le nombre s'affiche « au moins ». Relecture forte : 2 P1 corrigés ; Codex à sa limite, fusion sans lui (#255).

### C09e · Le palier de chaque canal, lu et avancé par la direction
- Statut : fait (2026-11-03)
- Reste : fusionnée (#310). Relecture forte sans P0 ni P1, un manque de preuve corrigé (rôle partenaire) ; Codex à sa limite (H03) ; vérification GitHub verte. Le Worker ne remplit pas `captationRollout` : à C09 d'y dire les mêmes canaux que `realChannels`.
- Voie : 1
- Trouvé par C09b (son « Reste ») : aucune route ne permet à la direction de lire ou d'avancer le palier d'un canal de captation ; `/automatisations/paliers` ne connaît que les automatisations du site.
- Qui : Claude · Relecture : forte · Dépend de : C09b, B05
- Cahier : M02, « État » ; Feuille de route, décembre 2026 ; R16, R26, R201. Partie de C09 qui n'attend personne : aucun vrai canal n'est branché.
- Objectif : `GET /v1/captation/paliers` et `POST /v1/captation/paliers/{canal}/avancer`, et le bloc de la bascule qui les montre sur l'écran du réseau.
- Critères : lecture par direction et conformité, avancer par la direction seule, autres rôles refusés au journal [R16] (test) ; fermé tant que le passage n'est pas ouvert (test), refusé pour un canal sans vrai branchement même ouvert (test) ; canal inconnu : 404 (test) ; l'écran dit qu'aucun message ne part sans vrai canal, ne propose le passage qu'à un canal branché, en deux appuis espacés [R26] (test) ; budget tenu [R201] (test).
- Attend : rien.

### C09 · Mise en service de la captation
- Statut : à faire
- Qui : Claude · Relecture : forte · Dépend de : C06, C07, C08, S11
- Cahier : M02, « État » ; Feuille de route, décembre 2026.
- Objectif : à découper au début de la tâche : canal par canal, mode essai puis 10 % pendant 7 jours puis partout si les chiffres tiennent, avec retour arrière automatique, comme S11 ; retrait de ManyChat seulement après validation de Meta.
- Attend : H04, H05, H06, H13.

**M03 · Qualifier et attribuer, décembre 2026.**

Découpé le 2026-10-27. Ids `Q..` pour Qualifier. Cahier : M03 Qualifier ; Feuille de route, décembre 2026 : « 90 % de 50 cas réels classés comme Shawez l'aurait fait ».
Décidé, lecture prudente : l'IA classe et extrait derrière une interface, avec une fausse IA dans les tests et un classement par règles fixes quand elle manque ; la note et l'attribution suivent des règles fixes écrites dans le code, sans IA, pour que chaque note soit explicable et chaque attribution la même pour tous [R14] ; rien n'est envoyé à qui que ce soit par M03 ; le délai de rappel de la charte de service n'est pas chiffré dans le cahier : c'est un réglage, le jour même pour un contact chaud et 24 heures sinon, jusqu'à ce que Shawez en décide autrement.

### Q01 · Classer et extraire un contact
- Statut : fait (2026-10-27)
- Qui : Claude · Relecture : forte · Dépend de : C05
- Cahier : M03, « Ce que fait le module » points 1 et 2, « Règles ».
- Objectif : pour chaque message rattaché, une qualification : catégorie (vendeur, acquéreur, estimation, mise en location, professionnel, partenaire, curiosité, indésirable) et champs extraits (bien, commune, budget ou prix, délai, financement déclaré, critères), rangés dans le projet de la fiche, créé ou complété. L'IA passe par une interface ; sans elle, des règles fixes sur les mots du message. Une location est marquée pour M15, un commerce pour M16, un investisseur pour M17.
- Critères : un jeu de 50 cas inventés couvre les 8 catégories, classés juste par les règles fixes à 90 % au moins ; une sortie de l'IA hors des champs prévus ou portant une donnée sensible est refusée et remplacée par les règles fixes [R23] ; le financement n'est rangé que s'il est déclaré dans le message, jamais évalué [R24] ; rien ne part chez l'IA au-delà du texte reçu, sans coordonnée [R15] ; une correction de l'agent est gardée et rejoint les cas de test.
- Attend : H13 pour la vraie IA seulement.
- Décidé (2026-10-27), lecture prudente : commune prise dans une liste fermée (réglage) et critères dans une liste fermée de mots sur le bien ; un financement n'est rangé que dit comme acquis ou en cours, jamais nié, espéré, au futur ni contradictoire [R24] ; l'IA ne lit ni coordonnée, ni nom, ni signature [R15] ; ses montants doivent être des montants du message ; le délai déclaré reste dans la qualification, la colonne `projects.deadline` étant une date qu'il faudrait inventer [R10].
- Reste : branchement dans la chaîne et correction depuis l'API (Q05) ; remarques mineures de Codex (#23), réglées par Q07 (#261) ; relecture forte (1 P0 corrigé), Codex : 5 P0 et 2 P1 corrigés en 5 tours, dernière version sans P0 ni P1.

### Q02 · Note et température
- Statut : fait (2026-10-27)
- Qui : Claude · Relecture : forte · Dépend de : Q01
- Cahier : M03, point 3 et « Règles » : chaque note explicable par sa raison écrite.
- Objectif : une note de 0 à 100 et une température (froid, tiède, chaud) par barème fixe écrit dans le code, d'après la catégorie, le bien reconnu, le délai et la précision de la demande, avec la raison en une ligne.
- Critères : chaque note a sa raison en une ligne, sans donnée personnelle [R24] ; la note ne dépend jamais du financement ni de la solvabilité, ni d'aucun critère discriminant : changer seulement ces champs ne la change pas [R14, R24] ; même contact, même note.
- Attend : rien.
- Décidé (2026-10-27), lecture prudente : le barème ne lit aucun montant (un montant peut dire le financement) [R24] ; un candidat à une location (suite M15, hors propriétaire) ne reçoit aucune note [R14] ; un partenaire ou un indésirable valent 0.
- Reste : relecture forte (1 P0 corrigé), Codex : 1 P0 corrigé, sa relecture de la correction restée en cours 25 min, fusion sans elle (#24).

### Q03 · Zones et attribution à l'agent
- Statut : fait (2026-10-27)
- Qui : Claude · Relecture : forte · Dépend de : Q01
- Cahier : M03, points 4 et 6 ; « Branchements » : zones des agents par commune.
- Objectif : les zones des agents par commune, puis l'attribution de chaque contact qualifié à l'agent de sa commune par règles fixes, sans IA, et la réattribution par la même règle si le contact n'est pas rappelé dans le délai de la charte ; les règles, lisibles, rendues par l'API pour l'application.
- Critères : aucun contact exclu ou qui a dit stop n'est attribué [R25] ; même contact, même agent, quel que soit l'ordre d'arrivée ; commune sans agent : à la direction, jamais au hasard ; réattribution dans le délai simulé, une seule fois par délai, écrite au journal [R13] ; un agent parti ne reçoit plus rien.
- Attend : la liste des communes de chaque agent, plus tard, au recrutement ; les tests utilisent des zones inventées.
- Décidé (2026-10-27), lecture prudente : tirage fixe (FNV-1a) sur l'identifiant de la fiche parmi les agents en activité de la commune ; un client suivi sur l'une de ses fiches réunies reste à cet agent ; partenaire à la direction, indésirable à personne ; délais de rappel en réglage, 8 heures si chaud, 24 sinon ; rappelé = un message sortant écrit par un humain du réseau depuis l'attribution.
- Reste : remarques mineures de Codex (#25), réglées par Q06 (#259) ; relecture forte (1 P1 corrigé), Codex sans P0 ni P1.

### Q04 · Tâche « rappeler » et liste des contacts chauds
- Statut : fait (2026-10-27)
- Qui : Claude · Relecture : forte · Dépend de : Q02, Q03
- Cahier : M03, point 5 ; Feuille de route, décembre 2026 : rapport du matin.
- Objectif : une tâche « rappeler » pour chaque contact chaud, chez son agent, et la liste des contacts chauds du matin et du soir, rendue par l'API sous droits d'accès [R16].
- Critères : chaque contact chaud a sa tâche en moins d'une minute, sur une horloge simulée ; une seule tâche par contact et par projet [R18] ; la liste ne montre à un agent que ses contacts [R16] ; aucun contact exclu n'y figure [R25] ; aucune notification n'est envoyée (l'application viendra en janvier).
- Attend : rien.
- Décidé (2026-10-27) : la clé d'une tâche est son projet (une seule tâche par projet, fusion comprise) ; « matin » avant 14 h, heure de Paris, « soir » ensuite ; la liste passe par `Acces.listPersons` [R16].
- Reste : remarque mineure de Codex (#26), réglée par Q06 (#259) ; relecture forte (1 P1 corrigé), Codex sans P0 ni P1.

### Q05 · Qualification dans la chaîne de captation, et mesure sur cas réels
- Statut : fait (2026-10-27)
- Reste : la mesure réelle, qui attend H13 et H18.
- Qui : Claude · Relecture : forte · Dépend de : Q04, C08
- Cahier : M03, « Critères d'acceptation » ; Feuille de route, décembre 2026.
- Objectif : brancher Q01 à Q04 derrière chaque message reçu, en mode essai, et un banc de mesure qui compare le classement à celui de Shawez sur des cas anonymisés, sans aucune donnée personnelle dans le dépôt.
- Critères : chaque nouveau contact a fiche, qualification, note, agent et, s'il est chaud, sa tâche en moins d'une minute ; le banc rend le taux d'accord et la liste des écarts, sans texte de message au journal [R13] ; 90 % de 50 cas réels quand H18 et H13 sont faits.
- Attend : H13 et H18 pour la mesure réelle ; le reste se fait avant.
- Décidé (2026-10-27) : la suite de M03 passe après toutes les réponses du lot et ne lève jamais d'erreur ; banc de mesure par `AIMMO_CAS` hors du dépôt (`docs/MESURE.md`), sauté sans fichier.
- Reste : mesure réelle (H13, H18) ; au branchement réel (C09), qualifier par `ctx.waitUntil` du Worker pour que la réponse HTTP n'attende pas une vraie IA ; relecture forte (2 P1 corrigés), relecture de Codex restée en cours plus de 30 min, fusion sans elle (#27).

### Q06 · Attribution : délai tenu, reprise sans trou, fiches réunies
- Statut : fait (2026-11-02)
- Décidé (2026-11-02), lecture prudente : le plus court des délais ouverts chez l'agent depuis le dernier rappel humain fait foi, et passe à l'agent suivant ; un agent qui a déjà eu le contact ne le reçoit plus, même à un nouveau message après la direction ; une coupure entre le lot et le journal perd la ligne du journal, pas la fiche. Relecture forte : 1 P0 et 3 P1 corrigés ; Codex à sa limite, fusion sans lui (#259).
- Voie : 1
- Qui : Claude · Relecture : forte · Dépend de : Q03, Q04
- Cahier : M03, points 4 et 6 ; R16, R25.
- Objectif : solder les remarques laissées de Codex (#25, #26). Une personne qui réécrit sans avoir été rappelée repoussait sa réattribution à chaque message, sans fin : plus elle insistait, moins elle était servie. Une coupure entre l'attribution et le passage de la fiche laissait l'agent sans accès, pour toujours. Un ancien agent parti sur une fiche réunie bloquait l'accès du nouvel agent. Une tâche chaude rangée sur une fiche gardée sans agent n'apparaissait pas dans la liste de l'agent qui suit la fiche réunie.
- Critères : un message de plus ne repousse jamais le délai en cours, et un contact chaud le raccourcit (test [R25]) ; un rappel humain clôt le délai, le message suivant en ouvre un nouveau (test [R25]) ; jamais un agent déjà essayé, même après un nouveau message ; un message sans commune garde celle d'un message d'avant (test [R25]) ; attribution et passage de la fiche tout ou rien, relançable après une coupure (test) ; le nouvel agent ouvre une fiche réunie qui portait un agent parti (test [R16]) ; la liste chaude montre la tâche de la fiche gardée à l'agent de la fiche réunie, et jamais à un autre agent (test [R16]).
- Attend : rien.

### Q08 · Corriger le classement d'un contact depuis la fiche
- Statut : fait (2026-11-02)
- Décidé (2026-11-02) : la fiche dit la demande, jamais la personne (`buyer` se dit « Chercher un bien », car un candidat à la location y est classé avec la suite M15) ; changer la catégorie recale la suite comme les règles (`routeOf`), `buyer` et `curious` restent au choix ; la correction ne change ni le projet ni les rappels, et l'écran le dit. Relecture forte : 2 P1 corrigés ; Codex à sa limite, fusion sans lui (#279).
- Trouvé le 2026-11-02 par la voie 2 : `POST /v1/qualifications/<id>/correction` n'a aucun écran, et `FicheAgent` ne rend ni le classement ni son identifiant : les corrections qui doivent rejoindre la mesure [Q05] ne peuvent pas être faites. Laissée à la voie 1 : `FicheAgent` et la fiche sont du socle.
- Qui : Claude, voie 1 · Relecture : forte · Dépend de : Q05
- Cahier : M03 ; R16, R201.
- Objectif : la fiche montre le dernier classement du contact et sa dernière correction ; l'agent le corrige dans une liste fermée, sans identifiant à saisir.
- Critères : seul celui qui voit la fiche entière corrige [R16] ; la qualification d'origine reste [R17] ; la correction rejoint les cas de mesure (test) ; aucune note de l'IA ni score montré comme un jugement sur la personne ; script chargé à part, budget tenu [R201].
- Attend : rien.

### Q09 · Les corrections des agents dans le banc de mesure
- Statut : fait (2026-11-02)
- Décidé (2026-11-02) : les 150 corrections les plus récentes (limite de D1) ; repérage des noms mot par mot, sans égard aux accents, aussi pour le texte confié à l'IA ; un tiers cité en texte libre ne se repère pas sans modèle de langue, le fichier est donc à relire, l'écran et `docs/MESURE.md` le disent. Relecture forte : 3 P1 corrigés ; Codex à sa limite, fusion sans lui (#280).
- Trouvé le 2026-11-02 par la relecture forte de Q08 : `correctedCases` n'est appelé que par des tests, et le banc de `docs/MESURE.md` lit `AIMMO_CAS` hors du dépôt. Les corrections sont gardées, mais rien ne les fait entrer dans une mesure.
- Qui : Claude, voie 1 · Relecture : forte · Dépend de : Q08
- Cahier : M03 ; Feuille de route, décembre 2026 ; R15, R16.
- Objectif : la direction obtient les cas corrigés au format du banc, le texte reçu sans ses coordonnées et la dernière correction, pour relancer la mesure.
- Critères : réservé à la direction [R16] ; aucun nom, numéro, mail ni adresse dans la sortie [R15] (test) ; la sortie passe telle quelle dans le lecteur de cas du banc (test).
- Attend : rien.

### Q07 · Critères niés et montants qui n'en sont pas
- Statut : fait (2026-11-02)
- Décidé (2026-11-02), lecture prudente : portée stricte de la négation (seuls déterminants, « besoin de », adjectif de taille et critères reliés séparent la négation du mot) ; « sans cave et garage » nie les deux ; seul le nom d'un budget ou d'un prix change de sujet après un apport ou des frais. Reste : un critère rangé d'un message d'avant n'est pas retiré si la personne le nie ensuite ; le délai déclaré reste dans la qualification (décidé en Q01). Relecture forte : 3 P1 corrigés et un faux budget de main (T3 collé au montant) ; Codex à sa limite, fusion sans lui (#261).
- Voie : 1
- Qui : Claude · Relecture : forte · Dépend de : Q01
- Cahier : M03, « Règles » ; R10, R23.
- Objectif : solder les remarques laissées de Codex (#23). « Maison sans jardin » rangeait le critère jardin, et le contact recevait des biens à l'opposé de sa demande. « Budget frais inclus de 300 000 € » perdait le budget. L'IA pouvait donner l'apport comme budget, puisqu'il figure dans le message.
- Critères : un critère nié n'est pas rangé, un critère affirmé à côté l'est, y compris pièces et chambres (test [R23]) ; l'IA qui range un critère que le message nie est refusée (test [R23]) ; « frais inclus » n'écarte pas le budget, un montant de frais reste écarté (test [R10]) ; l'IA qui donne l'apport comme budget est refusée, sauf si ce montant est aussi cité comme budget (test [R10]) ; les 50 cas restent justes.
- Attend : rien.

**M04 · Estimer, janvier 2027.**

Découpé le 2026-10-27. Ids `E..` pour Estimer. Cahier : M04 Estimer ; Feuille de route, janvier 2027 : « sur 20 biens, écart médian de moins de 10 % entre la fourchette AIMMO et l'estimation de l'agent ».
Décidé, lecture prudente : on reprend la méthode qui tourne sur le site (`functions/_lib/estimation.js` de `shawez-immo`, lu sans être modifié) au lieu de la refaire : comparables DVF de même type et de surface proche, rayon élargi jusqu'à 12 ventes, médiane du prix au m², marge par l'écart interquartile, ajustements bornés ; le diagnostic énergétique s'y ajoute comme le demande le cahier. Les calculs sont faits par le code ; l'IA ne rédige que le texte, derrière une interface, avec une fausse IA dans les tests. Les données publiques (DVF, ADEME, Géorisques, Base adresse nationale, cadastre) passent par des interfaces, avec de faux jeux inventés dans les tests. Aucun avis ne part sans validation de l'agent, et aucun ne part réellement tant que le plan n'a pas mis d'envoi en service.

### E01 · Fourchette de prix par le code
- Statut : fait (2026-10-27)
- Qui : Claude · Relecture : forte · Dépend de : rien
- Cahier : M04, « Ce que fait le module » (calcul par le code) et « Règles ».
- Objectif : à partir d'une liste de ventes réelles (source abstraite) et des caractéristiques du bien, choisir les comparables, calculer le prix au m² médian, la fourchette basse et haute, les ajustements écrits (étage, extérieur, état, époque, diagnostic énergétique), et rendre la date des dernières ventes utilisées.
- Critères : chaque comparable rendu est une vente de la source, avec sa date [R27] ; moins de 5 comparables, type non résidentiel ou bien hors zone couverte : pas de fourchette, avec sa raison [R27] ; la date des dernières ventes et l'avertissement quand les plus récentes manquent sont toujours rendus [R28] ; Bas-Rhin, Haut-Rhin, Moselle et Mayotte : aucune vente DVF, et le résultat le dit [R28] ; mêmes résultats que la méthode du site sur des cas inventés.
- Décidé (2026-10-27) : le cahier ne chiffre pas l'ajustement du diagnostic énergétique ; réglage de départ A +3 %, B +2 %, C et D 0, E -2 %, F -5 %, G -8 %, dans les bornes de -25 % à +18 %, à confirmer par Shawez sur la mesure de E07.

### E02 · Ventes DVF du site comme source
- Statut : fait (2026-10-27)
- Qui : Claude · Relecture : normale · Dépend de : E01
- Cahier : M04, « Données » et « Branchements » (fichiers DVF de data.gouv.fr).
- Objectif : lire les ventes DVF déjà préparées par le site (`donnees-dvf/` : index, tuiles, détails), en lecture seule, comme source de E01 ; le détail d'une vente donne la voie sans numéro et la commune.
- Critères : aucune écriture ni appel autre qu'une lecture ; jamais de numéro de voie ni de nom rendu [R29] ; une tuile absente ou illisible ne casse rien et est comptée ; jeux de test inventés au format du site.

### E03 · Collecte des données publiques du bien
- Statut : fait (2026-10-27)
- Qui : Claude · Relecture : normale · Dépend de : E01
- Cahier : M04, « Collecte automatique » et « Branchements ».
- Objectif : à partir d'une adresse, retrouver ses coordonnées (Base adresse nationale), la parcelle (cadastre), le diagnostic énergétique (ADEME) et les risques (Géorisques), chacun derrière une interface, avec ce qui manque dit clairement.
- Critères : chaque donnée porte sa source et sa date ; une source en panne ne bloque pas les autres ; aucune donnée personnelle envoyée aux services publics au-delà de l'adresse du bien ; la vérification réelle sur 10 biens tests se lance à la main, hors des tests automatiques.
- Attend : H20 pour la vérification réelle sur 10 biens ; le reste se fait avant.

### E04 · Brouillon d'avis de valeur et validation par l'agent
- Statut : fait (2026-10-27)
- Reste : la mise en page à la marque de l'agent, faite par E08.
- Qui : Claude · Relecture : forte · Dépend de : E01, E02, E03
- Cahier : M04, « Rédaction par l'IA » et « Validation ».
- Objectif : un brouillon d'avis (méthode, comparables sans nom, fourchette, arguments, plan de commercialisation, date des données) rangé sur le bien ; l'IA rédige derrière une interface, un texte de secours sans IA sinon ; l'agent ajuste la fourchette et le texte, puis valide ; la mise en page à la marque de l'agent se fait sur le brouillon validé.
- Critères : aucun avis ne peut partir sans validation de l'agent qui suit le bien [R30] ; chaque chiffre du texte vient du calcul [R10] ; l'avis dit que c'est un avis et que le prix appartient au vendeur ; les ajustements de l'agent sont gardés à côté du calcul.

### E05 · Estimation en ligne du site
- Statut : fait (2026-10-27)
- Reste : brancher le site sur la route (proposition sur `shawez-immo`, avec la clé `site_estimate`, H14) et ranger `DVF_BASE_URL` au déploiement.
- Qui : Claude · Relecture : forte · Dépend de : E01, E02
- Cahier : M04, « Estimation en ligne ».
- Objectif : une route de l'API pour le site qui rend la fourchette de la commune seulement, jamais le prix d'un bien précis sans visite, puis propose un rendez-vous.
- Critères : aucun prix précis d'un bien rendu [R31] ; limites d'appels ; aucune donnée du visiteur gardée au-delà de sa demande ; mode essai.

### E06 · Suivi du vendeur
- Statut : fait (2026-10-27)
- Décidé (2026-10-27) : relance après 3 jours sans réponse du vendeur ni message de son agent (réglage `delayDays`, le cahier ne le chiffre pas) ; refus pour l'heure repris au créneau suivant, tout autre refus définitif.
- Reste : le vrai envoi de l'avis et de la relance, quand le plan mettra un canal en service.
- Qui : Claude · Relecture : normale · Dépend de : E04, B02
- Cahier : M04, « Suivi ».
- Objectif : après l'envoi d'un avis, une relance du vendeur s'il ne répond pas, par le planificateur et le contrôle central, en mode essai.
- Critères : une relance par avis au plus, dans les heures d'envoi [R01], jamais à une personne exclue ou qui a demandé l'arrêt [R02, R04] ; rien ne part en mode essai.

### E07 · Mesure sur 20 biens
- Statut : fait (2026-10-27)
- Reste : la mesure réelle sur 20 biens (H19), qui dira aussi si le réglage du diagnostic énergétique de E01 tient ; relecture de Codex restée en cours plus de 30 min, fusion sans elle (#36).
- Qui : Claude · Relecture : normale · Dépend de : E01, E02
- Cahier : M04, « Critères d'acceptation » ; Feuille de route, janvier 2027.
- Objectif : un banc qui compare la fourchette AIMMO à l'estimation de l'agent sur des biens anonymisés gardés hors du dépôt, et rend l'écart médian et chaque écart avec son explication.
- Critères : écart médian de moins de 10 % sur 20 biens réels ; aucun bien réel dans le dépôt ; le banc se saute sans fichier.
- Attend : H19.

### E08 · Avis de valeur imprimable à la marque de l'agent
- Statut : fait (2026-11-02)
- Décidé (2026-11-02), lecture prudente : page HTML A4 servie par `GET /v1/avis/:id/imprimable`, enregistrée en PDF par le navigateur, comme la fiche de P05 (un vrai PDF côté Worker demanderait un service de rendu payant) ; imprimée par le seul passage `releasable`, qui refuse désormais aussi un avis dont le validateur ne suit plus le bien ou est parti [R30] ; l'agent sur la page est celui qui a validé ; une voie qui commence par un chiffre n'est pas citée [R29].
- Qui : Claude · Relecture : forte · Dépend de : E04
- Cahier : M04, « Rédaction par l'IA ».
- Objectif : l'avis validé en page à imprimer au nom et aux coordonnées professionnelles de l'agent : fourchette validée, texte, méthode, ventes citées sans nom, caractéristiques prises en compte.
- Critères : un brouillon n'est jamais imprimé [R30] ; qui ne voit pas le bien en entier est refusé, et le refus est au journal [R16] ; la seule fourchette de la page est celle validée [R30] ; date des données et mention d'avis présentes [R28] ; ni nom ni numéro de voie [R29] ; journal sans chiffre [R13] ; système de design [R201].
- Attend : rien.

### E09 · L'agent prépare, ajuste et valide son avis
- Statut : fait (2026-11-02)
- Décidé (2026-11-02), lecture prudente : l'adresse sert à la collecte et n'est gardée nulle part ; un étage ou un ascenseur inconnus ne produisent plus d'ajustement dans `adjustmentsFor` [R10] ; la classe énergie publique ne sert que pour une maison, dans un immeuble elle peut être celle d'un autre lot ; ventes muettes après 15 s : c'est dit. Relecture forte 1 P0 et 3 P1 corrigés ; Codex à sa limite, fusion sans lui (#267).
- Qui : Claude · Relecture : forte · Dépend de : E08
- Cahier : M04, « Rédaction par l'IA » et « Validation ».
- Objectif : aujourd'hui `AvisDeValeur` n'a aucune route : personne ne peut créer ni valider un avis en production. Routes de brouillon (fourchette calculée sur le bien par les ventes DVF de E05), d'ajustement et de validation, et écran dans l'application de l'agent, avec téléchargement de la page de E08.
- Critères : seul l'agent qui suit le bien prépare, ajuste et valide [R30, R16] ; sans ventes configurées ou sans fourchette possible, la raison est dite et rien n'est rangé [R27] ; la fourchette vient du calcul [R10] ; rien ne part [R26] ; écran dans le budget de l'application [R201].
- Attend : `DVF_BASE_URL` au déploiement pour le vrai calcul (déjà noté en E05).

### E10 · Écran de l'avis de valeur dans l'application
- Statut : fait (2026-11-02)
- Décidé (2026-11-02) : la validation demande la version lue (`updatedAt`) ; rien ne se tape pendant un envoi ; un brouillon faux se remplace par « Refaire le calcul » et reste rangé. Relecture forte 6 P1 corrigés ; Codex à sa limite, fusion sans lui (#268).
- Décidé (2026-11-02) : la validation demande la version lue (`updatedAt`) ; rien ne se tape pendant un envoi ; un brouillon faux se remplace par « Refaire le calcul » et reste rangé. Relecture forte 6 P1 corrigés ; Codex à sa limite, fusion sans lui (#268).
- Qui : Claude · Relecture : forte · Dépend de : E09
- Cahier : M04, « Validation » ; Le produit, « Application de l'agent ».
- Objectif : depuis « Mes biens », préparer, ajuster et valider un avis, puis télécharger la page à imprimer, dans un écran chargé à part.
- Critères : la validation porte la version lue à l'écran [R30] ; une modification non enregistrée ne se valide jamais [R30] ; adresse ni gardée ni remontrée [R46] ; refus en français ; budget de l'application tenu [R201] ; rien ne part [R26].
- Attend : rien.

**M05 · Rendez-vous, février 2027.**

Découpé le 2026-10-27. Ids `V..` pour rendez-Vous. Cahier : M05 Rendez-vous ; Feuille de route, février 2027.
Décidé, lecture prudente : l'agenda Google passe par une interface, avec un faux agenda dans les tests ; le vrai branchement attend H21. Tout message (confirmation, rappel, tournée partagée) passe par le contrôle central, avec les seuls canaux du mode essai tant que le plan n'a pas mis d'envoi en service. Les durées et le temps de trajet sont des réglages.

### V01 · Disponibilités et créneaux libres
- Statut : fait (2026-10-27)
- Décidé (2026-10-27) : réglages de départ estimation 60 min, visite 45, signature 60, appel 20, trajet 30 min (aussi autour des événements occupés de l'agenda), pas de 15 min, délai minimal 2 h.
- Qui : Claude · Relecture : forte · Dépend de : rien
- Cahier : M05, « Créneaux libres » et « Règles ».
- Objectif : à partir des disponibilités que l'agent fixe (jours, heures, exceptions) et des événements occupés de son agenda (interface), rendre les créneaux libres par type de rendez-vous (estimation, visite, signature, appel), chacun avec sa durée, en gardant le temps de trajet entre deux rendez-vous.
- Critères : aucun créneau hors des disponibilités de l'agent ni sur un événement occupé [R33] ; aucun créneau qui chevauche un rendez-vous ou ne laisse pas le temps de trajet [R32] ; heure de Paris, changement d'heure compris ; un appel ne demande pas de trajet.

### V02 · Réservation, confirmation et annulation
- Statut : fait (2026-10-27)
- Décidé (2026-10-27) : la confirmation est un envoi d'initiative (heures d'envoi R01, accord « rendez-vous » R03) ; refusée pour l'heure, elle attend V04. Plages et trajet en multiples de 5 minutes.
- Reste : relecture de Codex de la dernière version restée en cours près de 30 min, fusion sans elle (#38), toutes ses remarques précédentes corrigées.
- Qui : Claude · Relecture : forte · Dépend de : V01
- Cahier : M05, « Réservation en ligne » et « Critères d'acceptation ».
- Objectif : la table des rendez-vous ; réserver un créneau libre de façon atomique, confirmer tout de suite par le contrôle central (mode essai), décaler ou annuler par un lien à jeton ; le créneau annulé redevient libre aussitôt.
- Critères : deux réservations du même créneau en même temps, une seule passe [R32] ; une annulation libère le créneau en moins d'une minute ; 10 rendez-vous tests sans doublon ni oubli ; le lien ne porte ni nom ni coordonnée, et ne sert qu'à son rendez-vous.

### V03 · Agenda Google derrière une interface
- Statut : fait (2026-10-27)
- Décidé (2026-10-27) : un déplacement fait dans l'agenda suit les règles d'un décalage ; refusé, ou fin seule changée, l'événement est remis et le conflit noté ; agenda en panne, aucune réservation nouvelle.
- Reste : le fournisseur Google réel (H21) ; relecture de Codex de la dernière version restée en cours près de 30 min, fusion sans elle (#39), ses deux P0 et son P2 précédents corrigés.
- Qui : Claude · Relecture : normale · Dépend de : V02
- Cahier : M05, « Branchements » (API Google Agenda, dans les deux sens).
- Objectif : lire les événements occupés de l'agent et écrire ses rendez-vous dans son agenda, derrière une interface ; un faux agenda dans les tests ; une modification faite dans l'agenda revient sur le rendez-vous.
- Critères : un rendez-vous n'est écrit qu'une fois dans l'agenda ; une panne de l'agenda ne perd aucune réservation et est notée ; l'agenda ne reçoit que l'heure, le type et un intitulé sans coordonnée.
- Attend : H21 pour le vrai branchement ; le reste se fait avant.

### V04 · Rappels la veille et le jour même
- Statut : fait (2026-10-27)
- Décidé (2026-10-27) : veille et jour même en dates de Paris ; un rappel manqué ce jour-là (dimanche, férié, hors heures) n'est pas reporté ; pas de rappel le jour où un autre message du même rendez-vous est déjà parti ; chaque rappel porte un lien neuf ; sans canal choisi à la réservation, aucun message. Tâche `rdv.rappels` du lundi au samedi, 8 h à 19 h ; lien par `RDV_LINK_BASE`.
- Reste : relecture de Codex impossible (« Repository could not be found », deux fois), fusion sans elle (#40) ; ranger `RDV_LINK_BASE` au déploiement.
- Qui : Claude · Relecture : normale · Dépend de : V02, B02
- Cahier : M05, « Rappels » et « Règles ».
- Objectif : par le planificateur, un rappel la veille et un le jour même, avec le lien pour décaler ou annuler, par le contrôle central, en mode essai.
- Critères : aucun rappel le dimanche ni hors des heures d'envoi [R01] ; un rappel de chaque sorte au plus par rendez-vous [R05] ; rien pour un rendez-vous annulé ; jamais à une personne exclue ou qui a demandé l'arrêt [R02, R04] ; les confirmations en attente (`confirmation_status = 'waiting'`, refusées pour l'heure en V02) partent au premier créneau des heures d'envoi.

### V05 · Brief du rendez-vous
- Statut : fait (2026-10-27)
- Décidé (2026-10-27) : brief fait par le code, sans IA ; ventes du quartier prises dans le dernier avis de valeur du bien ; itinéraire vers la commune, l'adresse exacte n'étant pas en base (le brief le dit) ; questions et documents en listes de réglage par type ; tâche `rdv.briefs` à toute heure, brief figé.
- Reste : relecture de Codex impossible (H03), fusion sans elle (#41) ; relecture forte : aucun P0 ni P1.
- Qui : Claude · Relecture : forte · Dépend de : V02, E01
- Cahier : M05, « Brief du rendez-vous ».
- Objectif : une heure avant chaque rendez-vous, un brief rangé pour l'agent : le client et son histoire, le bien, les ventes du quartier, les questions à prévoir, les documents à apporter, le lien d'itinéraire vers l'application de navigation.
- Critères : chaque élément du brief vient de la base ou d'une source citée, rien d'inventé [R34] ; ce qui manque est dit ; 10 briefs tests prêts une heure avant ; le brief n'est lu que par l'agent du rendez-vous.

### V06 · Statut et compte rendu
- Statut : fait (2026-10-27)
- Décidé (2026-10-27) : honoré ou absent se marque une fois le rendez-vous commencé ; annulé passe par l'annulation de V02 ; un compte rendu est figé, d'autres peuvent s'ajouter ; une tâche `follow_absent` par absent.
- Reste : relecture de Codex impossible (H03), fusion sans elle (#42).
- Qui : Claude · Relecture : normale · Dépend de : V02
- Cahier : M05, « Statut ».
- Objectif : l'agent marque le rendez-vous honoré, absent ou annulé, puis range son compte rendu (texte dicté, la transcription viendra avec l'application de l'agent) ; une tâche suit un absent.
- Critères : seul l'agent du rendez-vous change son statut ; un statut final ne change plus ; le journal ne porte pas le texte du compte rendu [R13].

### V07 · Visites enchaînées et tournée partagée
- Statut : fait (2026-10-27)
- Décidé (2026-10-27) : le secteur est la commune (pas de coordonnées des biens en base) ; 8 visites au plus ; proposition seule, rien réservé ; le proche est une fiche du réseau avec son accord `route_share` [R03] ; les appels ne sont pas dans la tournée ; une tournée changée peut repartir.
- Reste : relecture de Codex impossible (H03), fusion sans elle (#43).
- Qui : Claude · Relecture : normale · Dépend de : V01
- Cahier : M05, « Visites enchaînées » et « Règles » (tournée partagée).
- Objectif : proposer un ordre de visites dans un même secteur qui tient dans les disponibilités et les temps de trajet ; l'agent peut envoyer sa tournée du jour à un proche ou à son accompagnateur, par le contrôle central, en mode essai.
- Critères : l'ordre proposé respecte R32 et R33 ; la tournée envoyée ne porte que les heures et les communes, jamais d'adresse exacte ni de nom de client [R09] ; rien ne part sans que l'agent le demande.

### V08 · Réservation depuis le site et les messages, en mode essai
- Statut : fait (2026-10-27)
- Décidé (2026-10-27) : clé de dépôt `site_booking` ; estimation, visite et appel seulement ; seul un créneau proposé se réserve ; personne retrouvée par tous les contacts donnés (fiche unique, téléphone et WhatsApp confondus), sinon fiche neuve suivie par l'agent ; plusieurs fiches distinctes : pas de confirmation par message ; accord retiré si la réservation échoue ; confirmation rendue toujours la même `{ booked: true }` [R16]. Le brief (V05) ne montre client, histoire et bien que si l'agent du rendez-vous a le droit de les voir.
- Reste : rien (les deux P2 de Codex faits en V09).
- Qui : Claude · Relecture : forte · Dépend de : V02
- Cahier : M05, « Réservation en ligne ».
- Objectif : des routes de l'API pour lister les créneaux libres d'un agent et réserver, appelées par le site, l'assistant et l'espace client, avec la clé de l'appelant ; en mode essai.
- Critères : aucune donnée de l'agenda au-delà des créneaux libres ; l'accord « rendez-vous » de la personne enregistré avec sa preuve au moment où elle réserve [R03] ; limites d'appels ; une réservation rend sa confirmation tout de suite ; rien ne part en mode essai.
- Attend : H14 pour le premier appelant réel.

### V09 · Confirmation à la coordonnée donnée, et journal en panne après une réservation en ligne
- Statut : fait (2026-10-27)
- Qui : Claude · Relecture : normale · Dépend de : V08
- Cahier : M05, « Réservation en ligne » ; remarques P2 de Codex sur #44.
- Objectif : la confirmation et les rappels d'un rendez-vous réservé en ligne visent la coordonnée donnée à la réservation, même si la fiche porte un autre mail plus ancien (le contrôle central reçoit une coordonnée précise, qui doit appartenir à la fiche) ; une panne du journal après une réservation en ligne réussie rend quand même le rendez-vous et son jeton, avec un avertissement.
- Critères : la boîte d'essai montre la confirmation adressée au mail donné, pas à l'ancien ; une coordonnée qui n'est pas à la fiche est refusée ; journal en panne après réservation : réponse 200 avec jeton et avertissement, panne notée [R13].

**M20 · Gagner des mandats, première version, janvier 2027.**

Découpé le 2026-10-27. Ids `G..` pour Gagner. Cahier : M20 Gagner des mandats ; Feuille de route, janvier 2027 : « premières versions de M20 et de l'application de l'agent », « application et plan du jour utilisés chaque matin pendant une semaine ».
Décidé, lecture prudente : la première version, pour la preuve à Dijon, couvre le plan du jour, le suivi de valeur et la source de chaque mandat, avec leurs trois critères d'acceptation. Les lettres de quartier, le dossier de présentation, les recommandations et la relance des anciens contacts viendront avec le module complet (octobre 2027), après M06, M11, M18 et M19 dont ils dépendent. Le plan du jour est calculé par le code, par des règles écrites et les mêmes pour tous, sans IA [R35] ; il ne porte que les clients de l'agent [R16], et seulement des personnes qui ont une base légale : une demande de leur part encore récente ou un accord en cours, jamais une personne exclue ou qui a demandé l'arrêt [R36]. Aucune donnée de ventes publiques ne sert à retrouver un propriétaire [R29, R37]. Rien n'est envoyé à un client par M20 tant que le plan n'a pas mis d'envoi en service : tout passe par le contrôle central, en mode essai. Les durées (demande « récente », estimation « à relancer ») sont des réglages : 13 mois pour une demande, 30 jours pour relancer une estimation sans réponse, jusqu'à ce que Shawez en décide autrement. L'application de l'agent est découpée à part, après M20.

### G01 · Plan du jour : contenu et ordre
- Statut : fait (2026-10-27)
- Qui : Claude · Relecture : forte · Dépend de : Q04, E06, V02
- Cahier : M20, point 1, « Règles ».
- Objectif : une fonction du socle qui, pour un agent et une date, rend son plan du jour : propriétaires qui ont demandé un rappel (tâches « rappeler » ouvertes), estimations à relancer (avis envoyé sans réponse ni rendez-vous depuis le délai réglé), rendez-vous à proposer (projet de vente ou d'estimation sans rendez-vous à venir) ; chaque ligne dit sa raison en une ligne et sa base légale. L'ordre suit des règles écrites : demande de rappel d'abord, puis délai annoncé par le propriétaire le plus proche, puis estimation la plus ancienne ; à égalité, la plus ancienne demande.
- Critères : le même plan pour les mêmes données, ordre expliqué ligne par ligne, aucune note de l'IA [R35] ; seulement les clients de l'agent [R16] ; une personne exclue, arrêtée, sans demande récente ni accord en cours n'y figure jamais, et son retrait est compté sans donnée personnelle [R36] ; un contact n'y figure qu'une fois, sous sa raison la plus forte.

### G02 · Plan du jour à 7 h 30, par le planificateur
- Statut : fait (2026-10-27)
- Qui : Claude · Relecture : normale · Dépend de : G01, B02
- Cahier : M20, « Critères d'acceptation » : « le plan du jour arrive chaque matin à 7 h 30 dans l'application ».
- Objectif : le planificateur du socle fige à 7 h 30, heure de Paris, le plan du jour de chaque agent actif, une fois par agent et par jour ; une route `GET /v1/plan-du-jour` le rend à l'agent seul ; le passage est écrit au journal sans donnée personnelle.
- Critères : 7 h 30 de Paris été comme hiver ; un plan par agent et par jour même si le déclencheur passe deux fois ; un autre agent ne lit pas ce plan [R16] ; un plan figé ne change plus ; aucun envoi.

### G03 · Chaque mandat a sa source
- Statut : fait (2026-10-27)
- Qui : Claude · Relecture : forte · Dépend de : S03
- Cahier : M20, point 7 « Mesure », « Règles », « Critères d'acceptation ».
- Objectif : un mandat signé se range seulement avec sa source (site, estimation en ligne, suivi de valeur, recommandation, réseaux, portail, connaissance de l'agent, autre avec un mot), reprise de la fiche quand elle est connue ; une source « liste achetée » ou « ventes publiques » est refusée ; un compte mensuel des mandats par source, sans donnée personnelle.
- Critères : aucun mandat sans source [R38] ; source interdite refusée avec sa règle [R37] ; compte du mois juste sur un jeu inventé ; rien ne s'efface [R17].

### G04 · Suivi de valeur, en mode essai
- Statut : fait (2026-10-27)
- Qui : Claude · Relecture : forte · Dépend de : G01, E06
- Cahier : M20, point 2 « Suivi de valeur ».
- Objectif : un propriétaire qui l'a demandé, avec son accord enregistré pour ce suivi, reçoit à intervalle réglé (6 mois) la fourchette de sa commune, par le planificateur et le contrôle central, en mode essai ; quand il répond qu'il pense à vendre, l'agent est alerté et le plan du jour le porte en tête des rendez-vous à proposer.
- Critères : jamais sans accord en cours pour ce suivi [R03, R36] ; un envoi par période au plus [R05], dans les heures d'envoi [R01] ; seule la fourchette de la commune, jamais le prix d'un bien précis [R31] ; rien ne part en mode essai [R26].

### G05 · Contrôle de la base légale sur 30 jours
- Statut : fait (2026-10-27)
- Qui : Claude · Relecture : normale · Dépend de : G02
- Cahier : M20, « Critères d'acceptation » : « aucun contact sans base légale dans le plan, sur 30 jours ».
- Objectif : un contrôle qui relit les plans figés des 30 derniers jours et vérifie, ligne par ligne, que chaque personne avait une base légale au jour du plan ; un rapport sans donnée personnelle, et une alerte à la direction s'il trouve un écart.
- Critères : un plan avec un contact sans base légale est trouvé, compté et signalé ; un plan sans écart rend zéro ; le rapport ne contient aucune donnée personnelle [R13].

**Application de l'agent, première version, janvier 2027.**

Découpé le 2026-10-27. Ids `A..` pour Application. Cahier : Le produit, « Application de l'agent » ; Architecture technique, application web installable ; Indicateurs, « écran affiché en moins d'une seconde dans 95 % des cas » ; Feuille de route, janvier 2027 : « application et plan du jour utilisés chaque matin pendant une semaine ».
Décidé, lecture prudente : la première version sert la journée de l'agent, rien de plus : plan du jour, contacts chauds, rendez-vous du jour avec leur brief, fiche du client, appel en un geste. Les documents à signer, la dictée, les messages prêts à envoyer et les chiffres viendront avec M06, M08 et M13. L'application est une page web installable servie par le Worker `aimmo-api` lui-même (pas de nouveau service à créer), sans dépendance de construction ; elle ne lit que par l'API sous les droits de l'agent [R16] et ne garde aucune donnée de client sur le téléphone : seul l'écran vide de l'application est mis en cache. L'agent s'y connecte avec sa clé d'API personnelle (H22), saisie une fois et gardée sur son appareil, jamais dans une adresse. Aucun envoi depuis l'application tant que le plan n'a pas mis d'envoi en service. Pas de note ni de classement des agents [R14].

### A01 · Coquille de l'application web installable
- Statut : fait (2026-10-27)
- Qui : Claude · Relecture : forte · Dépend de : S09
- Cahier : Le produit, « Application de l'agent » ; Architecture technique.
- Objectif : le Worker sert `/app/` : page, manifeste, icône et service worker, avec des en-têtes de sécurité stricts (politique de contenu, pas d'appel hors de l'API) ; écran de connexion par clé personnelle, vérifiée par une route `GET /v1/moi` qui ne rend que le rôle et le prénom de l'agent ; déconnexion qui efface la clé de l'appareil.
- Critères : la page et le service worker ne mettent en cache que la coquille, jamais une réponse de l'API ; la clé ne passe jamais dans une adresse ni au journal [R13] ; une clé refusée ne montre rien ; textes en français, sans « mandataire » ni « gratuit » [R07] ; tests sur les en-têtes et le contenu servi.
- Attend : H04 pour la mise en ligne, H22 pour l'usage réel.

### A02 · Ma journée
- Statut : fait (2026-10-27)
- Décidé (2026-10-27) : prénom et brief rendus seulement si l'agent voit encore la fiche et le bien ; brief caché si la fiche a été fusionnée ou défusionnée depuis ; chaque fiche rendue et chaque refus écrits au journal.
- Qui : Claude · Relecture : forte · Dépend de : A01, G02, Q04, V05
- Cahier : Le produit, « sa journée qui appeler, où aller, le brief de chaque rendez-vous » ; M20, plan du jour.
- Objectif : l'écran d'accueil montre le plan du jour (raison et place de chaque ligne), les contacts chauds et les rendez-vous du jour avec leur brief ; une route `GET /v1/rendez-vous/jour` rend les rendez-vous du jour de l'agent et leur brief rangé.
- Critères : seulement les données de l'agent [R16] ; un texte affiché est toujours échappé (aucun code injecté par un message de client) ; écran utilisable sur téléphone ; l'ordre du plan est celui du socle, jamais retrié par l'application [R35].

### A03 · Fiche du client et gestes de l'agent
- Statut : fait (2026-10-27)
- Décidé (2026-10-27) : toute exclusion active ferme l'appel, quel que soit le canal où elle a été notée ; une tâche inconnue est refusée comme celle d'un autre ; aucun code interne n'est affiché.
- Qui : Claude · Relecture : forte · Dépend de : A02
- Cahier : Le produit, « ses clients, biens et dossiers » ; Architecture technique, « appel en un geste depuis l'application ».
- Objectif : depuis une ligne du plan, la fiche du client (projets, sources, accords, derniers messages) ; appel en un geste par le lien téléphone de l'appareil ; « rappel fait » par une route `POST /v1/rappels/<id>/fait` ; aucun envoi de message.
- Critères : une fiche qui n'est pas à l'agent est refusée [R16] ; « rappel fait » garde la ligne [R17] ; une personne exclue ou arrêtée est signalée sur sa fiche et n'a pas de bouton d'appel [R02, R04].

### A04 · Mesure de l'usage du matin
- Statut : fait (2026-10-27)
- Décidé (2026-10-27) : un jour compte quand le plan déjà figé est ouvert avant midi, heure de Paris, lu dans le journal ; les 7 jours comprennent aujourd'hui ; la direction voit par jour un nombre d'agents, sans nom.
- Qui : Claude · Relecture : normale · Dépend de : A02, G02
- Cahier : Feuille de route, janvier 2027 : « application et plan du jour utilisés chaque matin pendant une semaine ».
- Objectif : chaque agent voit, pour lui seul, les jours où il a ouvert son plan avant midi sur les 7 derniers jours ; la direction voit le nombre de jours d'usage du réseau, sans classement des agents [R14].
- Critères : compte juste sur un jeu inventé, à l'heure de Paris ; aucun classement ni note d'agent [R14] ; aucune donnée de client.

**M06 · Mandats et documents, février 2027.**

Découpé le 2026-10-27. Ids `D..` pour Documents. Cahier : M06 Mandats et documents ; Feuille de route, février 2027 : « premier mandat de l'agence généré par AIMMO et numéroté dans le registre de l'agence ».
Décidé, lecture prudente : la première version sert les mandats de vente, leurs avenants et le registre ; les autres documents (location, recherche, délégation, bon de visite, offre, fonds de commerce, contrats d'agent) arriveront avec M08, M09, M14, M15 et M16, sur la même bibliothèque. Tant que Marion Gravelin et l'avocat n'ont pas validé les modèles (H08), la bibliothèque ne porte que des modèles d'essai inventés, marqués « essai », qu'aucun document réel ne peut utiliser. Pendant la preuve à Dijon, le numéro vient du registre de GRAVELIN IMMO (H23) et la signature se fait sur papier ou avec l'outil de l'agence : la signature en ligne AIMMO est construite en mode essai, et ne sert qu'une fois son dossier de preuve validé par l'avocat (H24). L'IA ne rédige aucune clause. Rien n'est envoyé à un client tant que le plan n'a pas mis d'envoi en service.

### D01 · Registre des mandats chaîné
- Statut : fait (2026-10-27)
- Décidé (2026-10-27) : chaque ligne est ancrée au journal (rang et empreinte écrite en lettres) ; un registre dont le contrôle échoue ne reçoit plus de ligne et l'écart est écrit au journal ; une ancre manquée après une panne du journal est reprise à la redemande ; R39 passe en service avec D04 (numéro sur l'exemplaire du mandant).
- Qui : Claude · Relecture : forte · Dépend de : G03
- Cahier : M06, « Registre des mandats » ; critère « une modification du registre après coup est détectée ».
- Objectif : un registre par réseau, en ajout seul : à l'inscription d'un mandat signé, un numéro dans l'ordre chronologique, au format et à partir du prochain numéro réglés pour le réseau ; chaque ligne porte l'empreinte de la précédente ; un contrôle d'intégrité relit toute la chaîne ; une ligne corrigée ne s'efface pas, une ligne d'annulation la suit.
- Critères : deux inscriptions simultanées n'ont jamais le même numéro, sans trou [R39] ; une modification directe d'une ligne en base est détectée par le contrôle [R39] ; aucune ligne effacée [R17] ; seuls l'agent du mandat, la direction et la conformité lisent une ligne [R16].
- Attend : H23 pour le numéro réel de l'agence ; les tests utilisent un registre inventé.

### D02 · Bibliothèque de modèles datés et versionnés
- Statut : fait (2026-10-27)
- Décidé (2026-10-27) : la validation d'un modèle est faite par le rôle conformité ; le modèle en vigueur est la dernière version validée, sinon la dernière d'essai ; un mandat exclusif exige un paragraphe mis en évidence ; le mandant est identifié par prénom et nom ; Codex resté en cours 30 min, fusion sans lui.
- Qui : Claude · Relecture : forte · Dépend de : D01
- Cahier : M06, « Bibliothèque de modèles », règle « le modèle en vigueur à la date de signature est conservé avec le document ».
- Objectif : des modèles par type de document (mandat de vente simple, exclusif, avenant), versionnés, datés, avec la liste de leurs champs et leur état « essai » ou « validé » (validé seulement par une personne désignée, jamais par le code) ; un document généré remplit les champs depuis la base, garde la version et l'empreinte du modèle utilisé ; rendu en HTML imprimable, clause d'exclusivité en évidence.
- Critères : un champ absent laisse le document « incomplet », jamais un texte inventé [R40] ; un modèle « essai » ne peut produire qu'un document d'essai, refusé à la signature réelle ; changer un modèle crée une version, le document garde la sienne ; 5 mandats tests générés identiques à leur modèle, au caractère près.
- Attend : H08 pour les modèles réels.

### D03 · Contrôles avant signature
- Statut : fait (2026-10-27)
- Décidé (2026-10-27) : identité valable un an ; le modèle ne nomme qu'un mandant, un bien à plusieurs propriétaires ne passe pas encore ; un bien sans propriétaire connu ne passe pas ; D04 devra exiger un contrôle réussi sur le document à signer.
- Qui : Claude · Relecture : forte · Dépend de : D02
- Cahier : M06, « Contrôles avant signature » ; règle anti-blanchiment.
- Objectif : avant toute signature, un contrôle écrit : champs obligatoires remplis, honoraires conformes au barème du réseau (réglage) et qui les paie, mandants égaux aux propriétaires du bien, identité de chaque mandant vérifiée (pièce vue, date, par qui, rangée hors de la fiche [R15]) ; le résultat, ligne par ligne, est rendu à l'agent.
- Critères : un document incomplet ou hors barème ne peut pas être signé ; aucun mandat signé sans identification de chaque vendeur [R41] ; le contrôle est écrit au journal sans donnée personnelle [R13].

### D04 · Mandat signé sur papier, numéroté au registre
- Statut : fait (2026-10-27)
- Décidé (2026-10-27) : le document est réservé d'abord, puis mandat (identifiant tiré du document), numéro et exemplaire remplis une fois chacun ; une reprise continue sans rien refaire et réécrit une ligne de journal manquée ; tout mandat de vente porte le champ de numéro.
- Qui : Claude · Relecture : forte · Dépend de : D01, D03
- Cahier : M06, « Papier toujours possible », règle « le numéro du registre figure sur l'exemplaire du mandant » ; critère « un mandat de l'agence généré par AIMMO, numéroté dans le registre de l'agence ».
- Objectif : l'agent enregistre un mandat généré et signé sur papier (date, lieu de signature, scan rangé par sa référence) ; s'il passe les contrôles de D03, il reçoit son numéro au registre et devient un mandat signé (G03, avec sa source [R38]) ; l'exemplaire du mandant est produit avec son numéro.
- Critères : le numéro figure sur l'exemplaire du mandant [R39] ; un mandat qui échoue aux contrôles n'est pas numéroté ; un même document ne reçoit jamais deux numéros.
- Attend : H23 pour l'usage réel.

### D05 · Rétractation et diffusion bloquée
- Statut : fait (2026-10-27)
- Décidé (2026-10-27) : délai compté à partir du lendemain de la signature en jours de Paris, prolongé au jour ouvrable suivant ; fin du mandat au même quantième N mois plus tard, ramenée au dernier jour du mois ; un mandat sans durée connue ne se diffuse pas ; rétractation et début anticipé par l'agent du mandat ou la direction ; le formulaire de rétractation fait partie du modèle validé (H08).
- Qui : Claude · Relecture : forte · Dépend de : D04
- Cahier : M06, « Rétractation », règle « aucune annonce ni diffusion sans mandat signé et numéroté » ; critère « la diffusion reste bloquée pendant le délai de rétractation ».
- Objectif : selon le lieu de signature (hors agence ou à distance), un délai de 14 jours calculé à l'heure de Paris, avec le formulaire de rétractation joint ; une seule fonction dit si un bien peut être diffusé, utilisée par tout ce qui publie : mandat signé, numéroté, en cours, et hors délai de rétractation sauf demande écrite du vendeur rangée avec sa preuve ; une rétractation reçue arrête le mandat.
- Critères : aucune diffusion sans mandat signé et numéroté [R42] ; diffusion refusée pendant le délai, permise le lendemain de sa fin, permise plus tôt avec la demande écrite ; une rétractation arrête la diffusion [R42].

### D06 · Échéances des mandats
- Statut : fait (2026-10-27)
- Décidé (2026-10-27) : tâches rangées à 6 h, 30 jours avant la fin du mandat et 15 jours avant la fin de la période exclusive ; pas de période exclusive pour un mandat plus court ; un mandat rétracté ou annulé ne montre plus ses tâches, gardées.
- Qui : Claude · Relecture : normale · Dépend de : D04
- Cahier : M06, « Échéances ».
- Objectif : chaque jour, une tâche pour l'agent avant la fin d'un mandat et avant la fin de la période de 3 mois d'un mandat exclusif, avec le renouvellement proposé à temps (délais en réglage) ; rien n'est envoyé au vendeur.
- Critères : une seule tâche par échéance [R18] ; calcul juste à l'heure de Paris sur un jeu inventé ; aucun envoi.

### D07 · Avenant au mandat
- Statut : fait (2026-10-27)
- Décidé (2026-10-27) : un avenant change le prix ou la durée, par ses seuls champs, écrits sur le document signé ; pas d'avenant sur un mandat échu ; il ne touche pas au prix affiché du bien (M07) ; la diffusion et les échéances suivent la durée en vigueur.
- Qui : Claude · Relecture : normale · Dépend de : D04
- Cahier : M06, « Avenant au mandat ».
- Objectif : un avenant généré depuis le modèle, lié au mandat par sa référence et son numéro, pour un changement de prix, de durée ou de conditions ; mêmes contrôles et même enregistrement que le mandat ; le mandat garde l'historique de ses avenants.
- Critères : l'avenant porte la référence et le numéro du mandat ; le prix du mandat change seulement quand l'avenant est signé ; rien n'est effacé [R17].

### D08 · Signature en ligne AIMMO, en mode essai
- Statut : fait (2026-10-27)
- Décidé (2026-10-27) : le code et l'exemplaire passent par le contrôle central, avec l'accord du signataire (finalité `signature_en_ligne`), rangés dans la boîte d'essai ; en essai le code y est lisible pour tester, et devra être scellé avant tout usage réel (H05, H24) ; essais faux comptés dans la base ; Codex n'a pas relu la dernière version en 50 min, fusion sans lui.
- Qui : Claude · Relecture : forte · Dépend de : D03
- Cahier : M06, « Signature électronique AIMMO ».
- Objectif : code à usage unique par mail (rangé dans la boîte d'essai, jamais envoyé), signature manuscrite à l'écran possible, empreinte du document, horodatage, dossier de preuve ; chaque signataire reçoit son exemplaire (dans la boîte d'essai).
- Critères : un code ne sert qu'une fois et expire ; un document modifié après signature est détecté par son empreinte ; tant que H24 n'est pas fait, une signature en ligne ne rend jamais un mandat signé réel.
- Attend : H24, H05.

### D09 · Mesure : mandat signé en moins de 10 minutes
- Statut : fait (2026-10-27)
- Décidé (2026-10-27) : la chronologie se lit dans la base (avis validé, document, contrôle, numéro), sans rien ajouter ; « moins de 10 minutes » strictement ; la mesure réelle attend H08 et H23.
- Qui : Claude · Relecture : normale · Dépend de : D04, E04
- Cahier : M06, critère « un mandat test signé en moins de 10 minutes à partir de l'estimation, et numéroté au registre ».
- Objectif : un parcours de test, de l'avis de valeur au mandat numéroté, sur une horloge simulée et des données inventées, avec le temps de chaque étape ; la marche à suivre pour le mesurer avec Shawez sur un vrai rendez-vous.
- Critères : le parcours de test passe ; le temps passé par le système est mesuré et sous la cible ; la marche à suivre est écrite dans `docs/MESURE.md`.

### D10 · Conditions d'un mandat à une date passée
- Statut : fait (2026-11-02)
- Décidé (2026-11-02, voie 2), lecture prudente : le jour compte à Paris, un avenant du jour du compromis compte ; un retrait ou une annulation au registre, même notés après le compromis, refusent encore la commission, la direction tranche (N06) ; les signatures futures étant refusées, rien ne change à la date d'aujourd'hui. Relecture forte : 2 P1 corrigés (demande écrite non datée, rallongement sans test de bout en bout) ; Codex à sa limite, fusion sans lui (#256).
- Voie : 2
- Qui : Claude, voie 2 · Relecture : forte · Dépend de : D05, D07, N06
- Cahier : M06, « Rétractation » ; M10, commission à l'acte ; reste écrit de N06.
- Objectif : la commission est calculée sur le mandat en vigueur le jour du compromis, mais `canDiffuse` à une date passée lit les avenants et les mandats d'aujourd'hui. Un avenant de durée signé après le compromis peut refuser à tort la commission, ou la donner sur un mandat échu ce jour-là ; un nouveau mandat signé après le compromis masque celui qui était en vigueur.
- Critères : un avenant signé après le compromis ne change ni dans un sens ni dans l'autre le mandat en vigueur ce jour-là (tests [R63]) ; un avenant signé le jour même compte ; un mandat signé après le compromis ne masque pas le précédent (test [R63]) ; à la date d'aujourd'hui, la diffusion ne change pas (test [R42]).
- Attend : rien.

### D11 · Lire et déposer depuis le téléphone : documents du bien et scan du mandat
- Statut : fait (2026-11-02)
- Décidé (2026-11-02), lecture prudente : sans stockage `PIECES`, rien ne se signe, `signature-papier` répond `depot_ferme` ; une reprise garde son scan d'origine ; un scan ne prouve qu'une signature (migration `1560`) ; le mandant possible est la fiche liée au bien comme propriétaire, rendue seulement à qui la voit en entier. Relecture forte : 4 P1 corrigés, le 5e devient D14 ; Codex à sa limite, fusion sans lui (#282).
- Trouvé le 2026-11-02 (après N13) : aucun écran n'appelle `/v1/documents`, `/v1/mandats` ni `/v1/signatures` ; aucune route ne liste les documents d'un bien, un document généré se perd donc une fois l'écran quitté ; `signature-papier` attend un `scanRef` que personne ne saurait saisir.
- Qui : Claude, voie 1 · Relecture : forte · Dépend de : D04, N12
- Cahier : M06 ; R16, R39, R40, R41.
- Objectif : une lecture des documents et du mandat en cours d'un bien, et le mandant possible (le propriétaire de la fiche liée au bien), pour l'agent du bien ; le dépôt du scan signé, sur le modèle de `dossiers/depot.ts`, dont la référence rendue sert à `signature-papier`.
- Critères : seul l'agent du bien, la direction et la conformité lisent [R16] ; seul l'agent du bien ou la direction dépose, droits vérifiés avant de lire un octet [R16] ; type confirmé par les premiers octets et empreinte recalculée ; un scan absent du stockage est refusé [R10] ; ni contenu ni donnée personnelle au journal [R13].
- Attend : H25 pour le dépôt réel.

### D14 · Le scan d'un avenant vérifié comme celui du mandat
- Statut : fait (2026-11-02)
- Décidé (2026-11-02) : le scan est celui du bien du mandat ; la migration `1570` ferme aussi la course entre mandat et avenant. Relecture forte : aucun P0 ni P1 ; Codex à sa limite, fusion sans lui (#286).
- Trouvé le 2026-11-02 par la relecture forte de D11 : `SignatureAvenant` accepte encore n'importe quelle référence de scan, alors qu'un avenant change les conditions du mandat et sa diffusion.
- Qui : Claude, voie 1 · Relecture : forte · Dépend de : D11
- Cahier : M06 ; R10, R16, R41.
- Objectif : même contrôle qu'à la signature papier : référence du bien, présente dans le stockage, jamais déjà utilisée ; sans stockage, rien ne se signe ; une reprise garde son scan.
- Critères : un test pour chacun de ces refus et pour la reprise.
- Attend : H25 pour le dépôt réel.

### D12 · Écran « Mandat » dans l'application
- Statut : fait (2026-11-02)
- Décidé (2026-11-02), lecture prudente : un mandat vivant sur le bien retire le contrôle et la signature des autres documents (D15 le refusera aussi côté code) ; une reprise ne redemande pas le scan ; le document se lit en texte, aucune balise reçue n'est interprétée. Téléphone et axe-core vérifiés une fois à la main (Chromium 390 × 844, clair et sombre, aucune violation). Relecture forte : 2 P1 corrigés ; Codex à sa limite, fusion sans lui (#288).
- Qui : Claude, voie 1 · Relecture : forte · Dépend de : D11
- Cahier : M06 ; Feuille de route, février 2027 : « premier mandat de l'agence généré par AIMMO et numéroté dans le registre de l'agence » ; R39, R40, R41, R201.
- Objectif : depuis « Mes biens », l'agent génère le mandat, lit les contrôles ligne par ligne, enregistre la signature sur papier avec le scan déposé, voit le numéro au registre et l'exemplaire ; écran chargé à part, sur le système de design.
- Critères : un seul échec de contrôle et rien ne se signe, la ligne dite en français [R41] ; un document d'essai est dit tel à l'écran [R40] ; aucun identifiant ni référence à saisir [R16] ; l'écran ne calcule ni numéro ni honoraires [R39] ; signature en ligne absente tant que H24 n'est pas fait ; budget et accessibilité tenus [R201].
- Attend : H08 pour un mandat réel, H23 pour le numéro réel, H25 pour le dépôt réel.

### D15 · Un seul mandat vivant par bien, refusé aussi par le code
- Statut : fait (2026-11-03)
- Reste : relecture forte, 3 P1 corrigés ; Codex à sa limite, fusion sans lui (#290). Les tests de D14 dépendaient de l'heure autour de minuit : corrigé ; ceux de D11 gardent une fenêtre d'une minute.
- Trouvé le 2026-11-02 par la relecture forte de D12 : l'écran ne propose plus de second mandat, mais `SignaturePapier.register` numérote un second mandat sur un bien dont le mandat est vivant, et le registre est sans trou. Le cahier (M06) n'en dit rien : lecture prudente, refus.
- Qui : Claude, voie 1 · Relecture : forte · Dépend de : D12
- Cahier : M06 ; R39, R41, R42.
- Objectif : refuser, à la première demande, de signer un mandat sur un bien dont un mandat est vivant ; annulé, rétracté ou échu, le bien se rouvre. Le passage d'un mandat simple à un exclusif reste à trancher par écrit dans la tâche.
- Décidé (2026-11-02), lecture prudente : passer d'un mandat simple à un exclusif demande d'abord que la direction annule le simple au registre (nouvelle route `/v1/mandats/<id>/annulation`, son geste à l'écran vient avec D13), ou d'attendre sa fin ; le vivant se juge sur toutes les inscriptions du registre, pas sur `canDiffuse` ; un enregistrement arrêté avant son numéro est refusé si un autre mandat est devenu vivant, un document déjà numéroté finit toujours. Deux demandes vraiment simultanées sur deux documents ne sont pas fermées : la base n'a pas de transaction sur plusieurs requêtes, et aucun index ne dit « vivant ».
- Critères : un second mandat sur un bien au mandat vivant est refusé, sans numéro (test [R39]) ; une reprise n'est pas refusée (test) ; un mandat annulé, rétracté ou échu laisse signer (tests) ; le refus est dit en français à l'écran.
- Attend : rien.

### D13 · Réglages du mandat pour la direction : barème, registre, contrôle
- Statut : fait (2026-11-03)
- Décidé (2026-11-03), lecture prudente : trois lectures ajoutées, réservées à la direction (`GET /v1/honoraires/bareme`, `/v1/registre/reglage`, `/v1/registre/lignes`, 30 mandats à la fois) ; un format non lu ne propose aucun formulaire ; la confirmation du format montre le premier numéro ; la diffusion s'arrête au prochain passage des annonces, et l'écran le dit ; une écriture sans réponse ou en panne serveur n'est dite ni faite ni pas faite. Relecture forte : 1 P1 corrigé ; Codex à sa limite, fusion sans lui (#294). Téléphone vérifié une fois (Chromium 390 × 844, clair et sombre), axe-core non passé.
- Trouvé le 2026-11-02 par la voie 2 : aucun écran n'appelle `/v1/honoraires/bareme`, `/v1/registre/reglage` ni `/v1/registre/controle`, et sans barème aucun mandat ne passe ses contrôles [R41]. Laissée à la voie 1, qui tient M06.
- Qui : Claude, voie 1 · Relecture : forte · Dépend de : D12
- Cahier : M06 ; R39, R41, R16, R201.
- Objectif : la direction règle le barème et le format du registre, lit le contrôle d'intégrité du registre et annule un mandat au registre, avec son motif (D15), depuis l'écran du réseau.
- Critères : réservé à la direction [R16] ; le format du registre n'est réglable qu'une fois, et l'écran le dit [R39] ; un registre abîmé est dit en français ; une annulation demande une confirmation et dit qu'elle rouvre le bien ; budget tenu [R201].
- Attend : H23 pour le format réel.

### D16 · Rétractation et début anticipé à l'écran du mandat
- Statut : fait (2026-11-03)
- Voie : 1
- Décidé (2026-11-03), lecture prudente : trouvé en comparant les routes aux écrans : `/v1/mandats/<id>/retractation` et `/debut-anticipe` existent et sont testées depuis D05, sans aucun geste à l'écran ; un vendeur qui se rétracte ne pouvait donc pas être noté depuis le téléphone, et le bien restait diffusable à la fin du délai. Relecture forte : une rétractation se juge sur le jour de son envoi, non de sa réception (L221-21 ; H44) : `sent_on`, migration 1600. L'écran envoie un jour, jamais un instant du téléphone : le serveur le traduit (un jour passé vaut 21 h UTC, encore ce jour-là à Paris). La rétractation reste proposée après le délai, car une lettre postée à temps arrive plus tard ; le code refuse un envoi après le dernier jour. Elle ne se défait pas : deux appuis, conséquence dite. Une rétractation notée dont l'annulation au registre n'a pas abouti se finit depuis l'écran (`withdrawalUnfinished`, `resume`).
- Qui : Claude, voie 1 · Relecture : forte · Dépend de : D05, D12
- Cahier : M06, « Rétractation : lieu de signature enregistré, délai de 14 jours calculé, diffusion bloquée pendant ce délai sauf demande écrite du vendeur » ; R42, R16, R201.
- Objectif : sur l'écran « Mandat », l'agent lit le dernier jour du délai, note la rétractation reçue et la demande écrite de commencer tout de suite, chacune avec sa preuve.
- Critères : la lecture du mandat rend le dernier jour du délai, nul à l'agence (test) ; aucun geste à l'agence, ni sur un mandat annulé, rétracté ou échu [R42] (test) ; une rétractation demande deux appuis, dit ce qu'elle arrête, et aucun identifiant n'est saisi [R16] (test) ; envoi le dernier jour accepté même reçu après, envoi après le délai, à venir ou avant la signature refusés (test) ; horloge du téléphone sans effet (test) ; une rétractation arrêtée en route se finit à l'écran (test) ; preuve vide dite en français (test) ; une réponse perdue n'est pas dite « rien n'est rangé », et le second essai dit « déjà notée » (test) ; de bout en bout par les routes : l'agent du mandat note, la diffusion s'arrête, le bien peut recevoir un nouveau mandat, un autre agent et la conformité sont refusés [R16, R42] (test) ; budget tenu [R201] (test).
- Reste : fusionnée (#314). Relecture forte 1 P0 (envoi, non réception) et 4 P1 corrigés ; Codex à sa limite (H03). L'envoi après le délai n'est prouvé qu'au cœur, à horloge fixée : une signature ancienne ne passe pas par la route.
- Attend : rien.

### D17 · Avenant au mandat à l'écran
- Statut : fait (2026-11-03)
- Voie : 1
- Décidé (2026-11-03), lecture prudente : une baisse de prix est le geste le plus courant d'un mandat, et `/v1/documents` (avenant) et `/signature-avenant` n'ont aucun geste à l'écran. Un avenant ne change que le prix et la durée [R39, R41]. L'écran n'en calcule rien : il envoie la saisie et lit les conditions rendues par `/v1/mandats/<id>/conditions`. Plusieurs propriétaires : le mandant se choisit, le code refuse un autre que celui du mandat.
- Qui : Claude, voie 1 · Relecture : forte · Dépend de : D12, D14, D16
- Cahier : M06 ; R16, R39, R41, R42, R201.
- Objectif : sur un mandat en cours, l'agent lit le prix et la durée en vigueur, prépare l'avenant, le contrôle, enregistre sa signature avec le scan, et lit l'exemplaire.
- Critères : aucun geste sur un mandat rétracté, annulé, échu ou hors registre [R42] (test) ; prix ou durée exigé, entiers, aucun identifiant saisi [R16] (test) ; un seul échec de contrôle et rien ne se signe [R41] (test) ; chaque refus dit en français (test) ; une réponse perdue n'est pas dite « rien n'est rangé » (test) ; de bout en bout par les routes : les conditions changent (test) ; budget tenu [R201] (test).
- Reste : fusionnée (#316). Relecture forte 3 P1 corrigés ; Codex à sa limite (H03). Un téléphone très en avance reçoit `bad_date` sur une signature datée d'aujourd'hui, mandat comme avenant : à régler comme en D16, par un jour envoyé au serveur.
- Attend : H08 pour un avenant réel, H25 pour le dépôt réel.

### D18 · Modèles de mandat et d'avenant à l'écran
- Statut : fait (2026-11-03)
- Voie : 1
- Trouvé le 2026-11-03 en faisant D17 : `/v1/modeles` n'a aucun geste à l'écran, alors que le mandat et l'avenant répondent « aucun modèle » tant que la direction n'en a pas rangé. W17 l'a fait pour les modèles de bail : suivre `packages/api/app/louer-modeles.ts`.
- Qui : Claude, voie 1 · Relecture : forte · Dépend de : D13, D17
- Cahier : M06 ; R40, R16, R201.
- Objectif : la direction lit et range les modèles de mandat et d'avenant depuis l'écran du réseau, la conformité les valide en deux appuis ; l'ancienne version reste.
- Critères : un modèle sans sa place pour le numéro est refusé et dit en français [R40] (test) ; rôles tenus [R16] (test) ; réponse perdue dite telle (test) ; budget tenu [R201] (test).
- Attend : H08 pour un modèle réel.

**M08 · Acquéreurs et visites, avril 2027.**

Découpé le 2026-10-27 par la voie 1. Ids `T..` pour Trouver l'acquéreur. Cahier : M08 Acquéreurs et visites ; Feuille de route, avril 2027 : « sur 10 biens tests, au moins 8 des 10 premiers acquéreurs proposés respectent tous les critères obligatoires ».
Décidé, lecture prudente : M08 se construit en mode essai, sans aucun envoi réel : alertes, comptes rendus et points de la semaine passent par le contrôle central et sont rangés dans la boîte d'essai ; le lien WhatsApp de l'agent est préparé, jamais ouvert pour lui. L'IA (alertes, compte rendu) est derrière une interface, fausse IA dans les tests, vraie IA avec H13 ; elle ne reçoit ni nom, ni coordonnée, ni adresse exacte [R15]. Le rapprochement lit la table `properties` du socle et un bien proposable est un bien que `canDiffuse` de D05 autorise [R42] ; la fiche complète de M07 (P01) l'enrichira quand elle sera fusionnée, sans que M08 touche aux fichiers de la voie 2 (`packages/core/src/annonces/`). Les vues par canal du point de la semaine viennent de P08 : tant qu'il n'est pas fusionné, elles sont « non communiquées » [R53]. Le partage des honoraires entre agents (fichier commun) et le rendement pour un investisseur (M17) viendront avec ces modules. Les migrations de M08 prennent les numéros à partir de `0101`, pour ne jamais croiser celles de la voie 2. Le code de M08 vit dans `packages/core/src/acquereurs/` et `packages/core/src/visites/`.

### T01 · Fiche acquéreur
- Statut : fait (2026-10-27)
- Décidé (2026-10-27) : un champ écrit ou vidé par l'agent n'est plus changé par un message ; un message plus ancien ne remplace pas ce qu'un plus récent a dit ; « studio » est rangé en appartement ; la conformité lit sans écrire ; R50 passe en service avec T02.
- Reste : relecture de Codex restée en cours 30 min, fusion sans elle (#66).
- Qui : Claude · Relecture : forte · Dépend de : Q01
- Cahier : M08, « Fiche acquéreur » ; règle « aucun critère discriminant dans la recherche ».
- Objectif : pour un projet d'achat, une fiche de recherche versionnée (rien ne s'efface) : types de bien, communes (liste fermée du réglage), surface et pièces minimales, budget maximal, contraintes dans une liste fermée (extérieur, stationnement, ascenseur, plain-pied, etc.), financement déclaré, urgence ; mise à jour depuis la qualification de Q01, seulement avec ce que le message dit, chaque champ avec sa source (message, agent).
- Critères : aucun champ hors liste fermée, aucun critère discriminant [R50] ; une mise à jour crée une version, l'ancienne reste lisible [R17] ; un champ que le message ne dit pas n'est jamais rempli [R10] ; lecture et écriture sous R16, refus au journal ; rien de personnel au journal [R13].
- Attend : rien.

### T02 · Rapprochement des acquéreurs, par le code
- Statut : fait (2026-10-27)
- Décidé (2026-10-27) : tolérances par défaut budget +5 %, surface −10 %, pièces 0 ; le type « logement » du socle répond à maison et appartement ; une valeur du bien inconnue ne remplit pas son critère ; une recherche sans critère sur le bien ne compte pas ; acquéreur actif : projet non clos et recherche modifiée depuis moins de 180 jours ; une ligne par personne, son meilleur projet ; R50 et R51 en service.
- Qui : Claude · Relecture : forte · Dépend de : T01, D05
- Cahier : M08, « Rapprochement », « Fichier commun » ; Feuille de route, avril 2027.
- Objectif : pour un bien diffusable [R42], la liste classée des acquéreurs du réseau entier (fichier commun) : critères obligatoires (type, commune, budget, surface, pièces) avec les tolérances écrites en réglage, puis classement par règles écrites (écart aux critères, urgence déclarée, fraîcheur du projet), jamais par le financement ni la solvabilité [R14], chaque ligne avec ses raisons ; jamais une personne exclue ou qui a demandé l'arrêt.
- Jamais vu : **carte de la demande**. Pour chaque bien, l'agent voit combien d'acquéreurs actifs du réseau le cherchent, et quel critère seul écarte le plus d'acquéreurs proches (« 12 acquéreurs écartés seulement par la surface, 7 seulement par la commune »), calculé par le code, sans aucun nom. Aucun réseau ni logiciel ne montre ainsi à l'agent la demande réelle autour d'un bien, critère par critère.
- Critères : sur 10 biens tests et un fichier inventé, au moins 8 des 10 premiers acquéreurs proposés respectent tous les critères obligatoires [R51] ; chaque proposition porte ses raisons ; aucun critère discriminant [R50] ; aucun classement par financement [R14] ; aucun acquéreur exclu ou arrêté [R02, R04] ; la carte de la demande est juste sur le jeu inventé et sans donnée personnelle ; lecture sous R16.
- Attend : rien.

### T03 · Alertes aux acquéreurs, en mode essai
- Statut : fait (2026-10-27)
- Décidé (2026-10-27) : seuls les acquéreurs qui remplissent tous les critères reçoivent une alerte ; canal pris dans l'ordre mail, Instagram, Facebook, SMS parmi ceux accordés, le suivant essayé après un refus de canal ; refus pour l'heure ou la diffusion repris, les autres définitifs ; l'accord des alertes est exigé et revérifié après la rédaction sur tout canal, et la diffusion juste avant l'envoi (deux options du contrôle central) ; page de désinscription publique hors de `/v1`, GET sans effet ; sans `ALERT_UNSUBSCRIBE_BASE`, aucune alerte ; R49 en service.
- Qui : Claude · Relecture : forte · Dépend de : T02
- Cahier : M08, « Alertes » et règles ; critère « aucun doublon d'alerte sur 30 jours ».
- Objectif : quand un bien devient diffusable, une alerte aux acquéreurs rapprochés qui l'ont demandée : message personnalisé rédigé par l'IA derrière une interface à partir des seules données du bien et des critères (fausse IA dans les tests, texte de secours du code si elle est en panne), mail ou message selon l'accord, passé par le contrôle central et rangé dans la boîte d'essai, avec un lien de désinscription. WhatsApp par le téléphone de l'agent : T09.
- Critères : aucune alerte sans accord en cours pour les alertes, et un lien de désinscription dans chacune [R49] ; jamais deux fois le même bien à la même personne, tous canaux confondus, WhatsApp de l'agent compris, même avec deux envois simultanés : aucun doublon sur 30 jours sur horloge simulée [R05] ; exclusions, arrêts et horaires respectés [R01, R02, R04] ; « agent immobilier » et « offert » [R07] ; l'IA ne reçoit ni nom, ni coordonnée, ni adresse exacte [R15] ; un texte avec un chiffre absent du bien est refusé ; rien ne part réellement.
- Attend : H05 et H06 pour l'envoi réel, plus tard.

### T09 · Alerte WhatsApp en un geste, par le téléphone de l'agent
- Statut : fait (2026-10-27)
- Décidé (2026-10-27) : option `byAgent` du contrôle central, réservée au port `AgentWhatsAppLink` qui fabrique le lien en mémoire ; message rangé, écrit par l'agent, dès la préparation, pour que le bien ne soit jamais proposé deux fois ; texte du code, sans IA ; la direction prépare au nom de l'agent qui suit la personne ; l'écran (T08) ouvre le lien aussitôt et ne le garde pas.
- Qui : Claude · Relecture : forte · Dépend de : T03
- Cahier : M08, « Alertes » : « un message WhatsApp à l'initiative de l'agent part de son téléphone, en un geste, seulement après le contrôle central : exclusions, accord, horaires. L'envoi est enregistré. »
- Objectif : pour un acquéreur rapproché, l'agent demande un lien WhatsApp pré-rempli ; le contrôle central décide (exclusions, arrêt, accord, horaires, jamais deux fois le même bien), sans la fenêtre de Meta qui ne vaut que pour les envois automatiques, puis prépare le lien sans jamais l'ouvrir ; l'envoi est enregistré, écrit par l'agent, quand il confirme.
- Critères : aucun lien sans accord en cours pour les alertes sur WhatsApp [R49] ; jamais un bien déjà proposé, ni deux liens du même bien [R05] ; exclusions, arrêt et horaires [R01, R02, R04] ; seuls l'agent du client et la direction [R16] ; le message est enregistré comme écrit par l'agent, une seule fois même confirmé deux fois [R18] ; rien ne part du serveur.
- Attend : rien.

### T04 · Visite et bon de visite
- Statut : fait (2026-10-27)
- Décidé (2026-10-27) : la bibliothèque de D02 n'admet que les types de mandat (contrainte de sa table) ; le bon de visite a ses modèles à part, aux mêmes règles (direction crée, conformité valide) ; signature papier seulement, la signature en ligne du bon avec H24 ; une visite décalée reprend sa visite si le bien est encore diffusable, avec un bon neuf ; un bon manquant après une panne est refait à la lecture.
- Reste : relecture de Codex de la dernière correction (un P2) restée en cours 20 min, fusion sans elle (#76).
- Qui : Claude · Relecture : normale · Dépend de : T01, V02, D02
- Cahier : M08, « Visites » ; M06, bibliothèque de modèles.
- Objectif : une visite est un rendez-vous de V02 relié à un bien et à un projet d'achat ; le bon de visite est généré depuis la bibliothèque de D02 (modèle d'essai tant que H08 n'est pas fait), signé sur papier ou en ligne en essai (D08) ; le rappel de la veille vient de V04.
- Critères : une visite sans bien diffusable est refusée [R42] ; le bon de visite porte le bien, la date et le visiteur, jamais l'adresse exacte dans la confirmation au visiteur [R19] ; un champ manquant le laisse incomplet [R40] ; une visite annulée garde son bon, rien n'est effacé [R17].
- Attend : H08 pour le modèle réel.

### T05 · Visite sécurisée
- Statut : fait (2026-10-27)
- Décidé (2026-10-27) : identité confirmée par le nom du visiteur, égal à celui de sa fiche (aucune pièce), téléphone par un code SMS de 30 minutes, 5 essais ; la réservation d'une visite dit « réservée », jamais « confirmée » ; la tournée partagée est celle de V07 ; l'alerte retient la visite en cours, sinon la prochaine dans l'heure ; la direction est prévenue par une interface, en essai une ligne au journal ; R54 en service.
- Reste : relecture de Codex de la dernière correction restée en cours plus de 25 min, fusion sans elle (#80).
- Qui : Claude · Relecture : forte · Dépend de : T04
- Cahier : M08, « Visite sécurisée ».
- Objectif : avant la visite, le visiteur confirme son identité et son téléphone (code à usage unique par le contrôle central, rangé dans la boîte d'essai) ; l'agent peut partager sa tournée du jour avec un proche par le message de V07, sans nom de client ni adresse exacte ; une alerte en un geste range l'heure et le lieu de la visite en cours et prévient la direction (boîte d'essai).
- Critères : aucune visite confirmée sans identité et téléphone confirmés [R54] ; un code ne sert qu'une fois et expire ; la tournée partagée est celle de V07, un message aux heures et communes seulement, sans nom de client ni adresse [R09, R15] (décidé le 2026-10-27 : pas de lien, rien à faire expirer) ; l'alerte est enregistrée même si l'envoi échoue, et réessayée sans doublon ; rien ne part réellement.
- Attend : H05 pour l'envoi réel.

### T06 · Compte rendu de visite dicté
- Statut : fait (2026-10-27)
- Décidé (2026-10-27) : la recherche de l'acquéreur ne change pas sur un avis, le compte rendu reste rattaché à son projet ; vendeur = mandant du dernier mandat du bien, accord `suivi_vente` exigé ; relance de l'acquéreur à 48 h ; l'IA reçoit la dictée sans mail, adresse, coordonnée connue, compte ni nom (accents ignorés, mot par mot, particules exceptées) ; une offre niée dans la dictée est refusée ; envoi repris par la tâche `visites.comptes_rendus` ; R52 en service.
- Qui : Claude · Relecture : forte · Dépend de : T04
- Cahier : M08, « Compte rendu de visite » ; critère « 5 comptes rendus de visite envoyés au vendeur sous 24 heures ».
- Objectif : l'agent dicte une phrase ou 30 secondes (le texte vient de la dictée du téléphone) ; l'IA, derrière une interface, en tire le compte rendu (avis, points forts, réserves, intérêt, prêt à faire une offre) ; l'agent le valide en un geste ; le vendeur le reçoit sans le nom de l'acquéreur (boîte d'essai) ; la fiche acquéreur est mise à jour, une relance est programmée, et une tâche « préparer l'offre » est créée si l'acheteur se dit prêt.
- Critères : rien ne part au vendeur sans validation de l'agent, et jamais avec le nom ou une coordonnée de l'acquéreur [R52] ; le compte rendu ne porte que ce que la dictée dit, un fait absent n'est pas inventé ; 5 comptes rendus de test validés sont dans la boîte d'essai en moins de 24 heures sur horloge simulée ; une seule relance par visite [R18] ; IA en panne : la dictée brute est gardée et l'agent peut écrire lui-même.
- Attend : H13 pour la vraie IA.

### T07 · Point de la semaine au vendeur
- Statut : fait (2026-10-27)
- Décidé (2026-10-27) : préparé le lundi à 8 h pour chaque mandat en cours (délai de rétractation compris), validé par l'agent avec ses prochaines actions ; une action ne porte ni chiffre, ni prix, ni nom ou coordonnée d'une personne venue pour le bien ; le texte entier est contrôlé avant d'être figé ; au plus huit avis ; vues « non communiquées » sans relevé ; R53 en service.
- Reste : relecture de Codex de la dernière correction (P2) restée en cours plus de 20 min, fusion sans elle (#87).
- Qui : Claude · Relecture : forte · Dépend de : T06, B02
- Cahier : M08, « Point de la semaine au vendeur » et règles ; critère « 5 vendeurs reçoivent leur point deux lundis de suite ».
- Objectif : chaque lundi, par le planificateur, un point par mandat en cours : vues (P08 quand il sera fusionné), contacts reçus pour le bien (C03), visites et avis des visiteurs (T06), prochaines actions de l'agent ; préparé pour l'agent, qui le valide ; passé par le contrôle central et rangé dans la boîte d'essai.
- Critères : chaque chiffre est lu dans la base, une donnée absente est écrite « non communiquée » [R53] ; aucune mention de baisse de prix, refusée par une liste fermée de tournures [R53] ; aucun nom d'acquéreur [R52] ; un seul point par mandat et par lundi [R18] ; sur horloge simulée, 5 vendeurs tests reçoivent leur point deux lundis de suite, à l'heure de Paris ; rien ne part réellement.
- Attend : rien.

### T08 · Routes et écrans « Acquéreurs » et « Visite » de l'application de l'agent
- Statut : fait (2026-10-27)
- Décidé (2026-10-27) : la dictée passe par le micro du clavier du téléphone, sans reconnaissance vocale dans le navigateur (elle enverrait la dictée à un service extérieur) ; le lien WhatsApp ne sert qu'une fois et expire au bout de deux minutes ; en mode essai l'écran dit que la direction n'est pas prévenue par message et donne le 112. Reste à faire, hors T08 : rattacher une visite réservée en ligne (V08) à la recherche d'un acquéreur, pour lui ouvrir un dossier de visite.
- Qui : Claude · Relecture : forte · Dépend de : T03, T05, T06, T07
- Cahier : M08 ; Organisation, exigence de design (protocole, section 9).
- Objectif : les routes `/v1/acquereurs` (fiche, rapprochement, carte de la demande, alertes), `/v1/visites` (visite, bon, confirmation, alerte, compte rendu) et `/v1/points` ; dans l'application de l'agent, l'écran d'un bien avec ses acquéreurs et sa carte de la demande, et l'écran de visite avec le bouton de dictée, la validation en un geste et l'alerte en un geste.
- Critères : chaque route sous R16, refus au journal ; un parcours de test complet, du bien diffusable à l'alerte, la visite, le compte rendu et le point du lundi ; écrans accessibles, beaux sur téléphone d'abord, sans texte générique.
- Attend : rien.

**M07 · Commercialiser, mars 2027.**

Voie : 2

Découpé le 2026-10-27 par la voie 2. Ids `P..` pour Publier. Cahier : M07 Commercialiser ; Conformité, « Publier les annonces » ; Feuille de route, mars 2027 : « 10 annonces passent la liste de contrôle des mentions ».
Décidé, lecture prudente : tout M07 se construit en mode essai, sans aucune publication réelle : les canaux (site, réseaux sociaux, fiche Google, portails) sont derrière une interface, avec un faux canal dans les tests, et ce qui « part » est rangé dans la boîte d'essai. Toute publication passe par la seule porte `canDiffuse` de D05 [R42], puis par la liste de contrôle des mentions [R43]. Le prix publié vient du mandat en vigueur, avenants compris, jamais d'une saisie [R44]. L'IA rédige l'annonce derrière une interface (fausse IA dans les tests, vraie IA avec H13), à partir des seules données du bien ; les mentions obligatoires sont calculées et placées par le code, jamais par l'IA ; l'agent valide. Les pages des biens de `shawez-immo` restent en place, intouchées, jusqu'à une tâche de bascule à part. Pendant la preuve à Dijon, les portails sont servis par le logiciel de l'agence ; l'export AIMMO est construit en essai et attend H10. Le numéro de carte professionnelle est un réglage du réseau (H09). Le montage de la vidéo vient avec M19 Studio ; M07 porte le plan de tournage et le contrôle « sans adresse visible ». Les biens d'exception (dossier en anglais, visites privées) viendront après la preuve. Les fichiers du socle ne sont pas touchés par la voie 2 : le code de M07 vit dans `packages/core/src/annonces/`, ses routes dans `packages/api/src/annonces.ts`, branchées par une seule ligne quand la voie 1 n'a pas `app.ts` en cours.

### P01 · Fiche du bien complète
- Statut : fait (2026-10-27)
- Décidé (2026-10-27) : aucun texte libre dans la fiche ; références de photos données par le stockage (`biens/<id du bien>/<identifiant>.<ext>`) ; une vidéo ne porte pas d'aménagement virtuel
- Qui : Claude · Relecture : forte · Dépend de : D05
- Cahier : M07, « Fiche du bien complète » ; Conformité, « Publier les annonces » (énergie, copropriété, risques).
- Objectif : la fiche de commercialisation d'un bien, versionnée (une modification crée une version, rien ne s'efface) : caractéristiques (surface, pièces, chambres, étage, année, chauffage, extérieurs), diagnostic énergétique (classes énergie et climat de A à G, dépenses annuelles minimale et maximale, année de référence des prix, date du diagnostic), copropriété (lot ou non, nombre de lots, charges annuelles moyennes, procédure en cours), risques (zone concernée ou non), photos et vidéo par leur référence de stockage, avec leur état « retouchée » ou « aménagement virtuel ». L'adresse exacte reste hors de la fiche publique [R19].
- Critères : chaque champ est contrôlé (classes dans A à G, montants positifs, dépense minimale au plus égale à la maximale, date de diagnostic non future) ; une modification crée une version, l'ancienne reste lisible [R17] ; seuls l'agent du bien et la direction écrivent, et chaque refus va au journal [R16] ; aucune donnée personnelle au journal [R13].
- Attend : rien.

### P02 · Mentions obligatoires et liste de contrôle
- Statut : fait (2026-10-27)
- Décidé (2026-10-27) : prix du mandat = prix hors honoraires à la charge de l'acquéreur ; pourcentage du prix hors honoraires, au centième, le demi vers le haut ; seul un mandat en vigueur (diffusable ou en délai de rétractation) donne un prix ; terrain sans DPE ; commerces et entreprises avec M16 ; carte professionnelle réglée par la direction
- Qui : Claude · Relecture : forte · Dépend de : P01
- Cahier : Conformité, « Publier les annonces » ; M07, règles ; critère « 10 annonces tests passent la liste de contrôle des mentions ».
- Objectif : une fonction du code calcule et place les mentions obligatoires d'une annonce à partir du bien et du mandat en vigueur : prix honoraires inclus en plus grand, prix hors honoraires et honoraires TTC en pourcentage quand l'acquéreur les paie ; classes énergie et climat, logement très énergivore (F ou G), dépenses annuelles avec l'année de référence ; copropriété (lots, charges, procédure) ; renvoi vers Géorisques si le bien est en zone concernée ; numéro de carte professionnelle (réglage du réseau). Une liste de contrôle rend chaque mention « présente » ou « manquante » avec sa raison.
- Critères : 10 annonces tests passent la liste de contrôle, au caractère près [R43] ; un champ manquant bloque, avec la mention manquante nommée [R43] ; sans diagnostic énergétique, rien ne passe [R45] ; le prix vient du mandat en vigueur, avenant de prix compris, jamais d'une saisie [R44] ; pourcentage d'honoraires calculé juste et arrondi par une règle écrite.
- Attend : H09 pour le vrai numéro de carte ; les tests utilisent un numéro inventé.

### P03 · Annonce rédigée par l'IA, sourcée, validée par l'agent
- Statut : fait (2026-10-27)
- Décidé (2026-10-27) : un nombre doit venir du champ que son unité désigne, sans unité seulement l'année, le code postal ou le total d'étages après « sur » ; le prix n'est jamais dans le texte ; toute voie nommée est refusée ; critères discriminants et équipements sans champ en listes fermées, lues sans accents, au pluriel et au féminin ; texte de l'IA refusé remplacé par le texte de secours du code ; Codex sans relecture au bout de 15 min, fusion sans lui
- Qui : Claude · Relecture : forte · Dépend de : P02
- Cahier : M07, « Annonce » et « L'IA et l'humain » ; Conformité, non-discrimination.
- Objectif : l'IA, derrière une interface (fausse IA dans les tests), propose un titre et un texte à partir des seules données de la fiche ; le code vérifie le texte, y ajoute les mentions de P02, et l'agent du bien le valide ou le corrige ; seule une version validée peut être publiée.
- Jamais vu : **annonce sourcée**. Chaque chiffre et chaque fait du texte est relié au champ de la fiche dont il vient, montré à l'agent phrase par phrase ; un nombre, une surface, une année ou un équipement sans source dans la fiche rend le texte refusé, avant même la validation. Aucun réseau ni outil d'IA grand public ne prouve ainsi qu'une annonce n'invente rien.
- Critères : un texte qui cite un nombre absent de la fiche est refusé, la phrase en cause nommée [R47] ; un texte avec une adresse exacte (numéro et voie) est refusé [R46] ; un texte avec un critère discriminant (origine, religion, situation de famille, handicap, nationalité, etc., liste fermée) est refusé [R46] ; « gratuit », « mandataire » ou une mention de l'IA sont refusés ; rien n'est publiable sans validation de l'agent du bien [R47] ; l'IA ne reçoit ni nom, ni coordonnée, ni adresse exacte [R15] ; une IA en panne laisse un texte de secours fait par le code depuis la fiche.
- Attend : H13 pour la vraie IA.

### P04 · Publication partout, au même prix, en mode essai
- Statut : fait (2026-10-27)
- Décidé (2026-10-27) : une version publiée unique pour tous les canaux ; un passage à la fois par bien, par un bail de 5 minutes qui protège aussi l'écriture d'une version ; contrat des canaux : jamais une version plus ancienne que la dernière appliquée ; un bien vendu reste montré « vendu » tant que son mandat le permet ; Codex : 2 P0 corrigés, sa relecture de la dernière correction restée en cours 15 min, fusion sans elle
- Qui : Claude · Relecture : forte · Dépend de : P03
- Cahier : M07, « Diffusion » ; critères « publié partout en moins d'une heure, au même prix » et « changement de prix répercuté partout en moins de 15 minutes ».
- Objectif : publier une annonce validée vers chaque canal (site, réseaux sociaux, fiche Google, portails) derrière une interface, en mode essai ; une version publiée unique, la même partout ; un changement de prix (avenant signé) ou d'état (sous offre, vendu, mandat arrêté) crée une nouvelle version poussée à chaque canal par le planificateur ; un retrait quand `canDiffuse` dit non.
- Critères : aucune publication sans `canDiffuse` [R42], sans liste de contrôle complète [R43] ni sans validation [R47] ; même prix sur tous les canaux [R44] ; sur horloge simulée, publié partout en moins d'une heure, prix répercuté en moins de 15 minutes ; un mandat rétracté ou échu retire l'annonce partout au passage suivant ; un canal en panne est réessayé sans doublon ; rien ne part réellement.
- Attend : rien pour l'essai ; les canaux réels plus tard (H06, H07, H10).

### P05 · Page du bien et fiche PDF à la marque de l'agent
- Statut : fait (2026-10-27)
- Décidé (2026-10-27) : fiche imprimable en HTML de deux pages A4 fixes (page 1 : prix, mentions, 4 photos ; page 2 : texte et agent), vérifiée sous Chromium ; coordonnées professionnelles de l'agent réglées par lui ou la direction, jamais pour un agent parti ; un agent parti n'est plus montré
- Qui : Claude · Relecture : normale · Dépend de : P04
- Cahier : M07, « Page du bien » et « fiche PDF » ; Organisation, exigence de design (protocole, section 9).
- Objectif : depuis la version publiée, une page HTML du bien et une fiche imprimable de deux pages au nom et aux coordonnées professionnelles de l'agent, avec prix, mentions et état (en vente, sous offre, vendu) mis à jour d'eux-mêmes ; rapide, accessible, belle sur téléphone d'abord, suivant le système de design d'AIMMO.
- Critères : aucune adresse exacte ni nom du vendeur dans la page ou la fiche [R46] ; mentions de P02 présentes et prix inclus en plus grand [R43] ; état et prix suivent la dernière version publiée ; tout texte échappé ; fiche de deux pages au plus à l'impression.
- Attend : rien.

### P06 · Photos et vidéo sans tromper ni montrer l'adresse
- Statut : fait (2026-10-27)
- Décidé (2026-10-27) : la version publiée porte ses médias, la mention « Aménagement virtuel » à poser sur l'image ; une vidéo ne part qu'après un dernier contrôle réussi de ses sous-titres et de sa légende, lus un par un, à la suite et entiers ; un point d'abréviation ne coupe plus une phrase ; voies abrégées reconnues
- Qui : Claude · Relecture : normale · Dépend de : P01
- Cahier : M07, « Vidéo du bien » et règle de l'aménagement virtuel ; Conformité, « Photos et vidéos ».
- Objectif : une photo marquée « aménagement virtuel » porte la mention sur l'image publiée ; un plan de tournage du bien tiré de sa fiche (pièces, extérieurs, atouts) ; un contrôle des sous-titres et du texte de la vidéo qui refuse une adresse exacte.
- Critères : aucune image d'aménagement virtuel publiée sans sa mention [R48] ; une photo retouchée au-delà de la lumière et du cadrage est refusée ; des sous-titres avec une adresse exacte sont refusés [R46] ; plan de tournage sans rien d'inventé.
- Attend : rien.

### P07 · Export au format des portails, en mode essai
- Statut : fait (2026-10-27)
- Décidé (2026-10-27) : format d'essai XML `aimmo-essai-1` ; seuls les biens en vente ou sous offre sont dans le flux ; Codex resté en cours plus de 25 min, fusion sans lui
- Qui : Claude · Relecture : normale · Dépend de : P04
- Cahier : M07, « Diffusion », « export au format de chaque portail ».
- Objectif : un flux d'export par portail derrière une interface, rempli depuis la version publiée, avec un format d'essai décrit dans `docs/PORTAILS.md` ; les formats réels s'ajoutent avec H10.
- Critères : le flux porte le prix publié et les mentions [R43, R44] ; jamais d'adresse exacte [R46] ; un bien retiré sort du flux au passage suivant ; flux identique pour une même version.
- Attend : H10 pour les vrais portails.

### P08 · Mesure par bien : vues, contacts, visites
- Statut : fait (2026-10-27)
- Décidé (2026-10-27) : un relevé de vues par bien, canal et jour ; un contact compte à l'heure de son message, une fois par personne, fusions comprises ; visites faites et prévues
- Qui : Claude · Relecture : normale · Dépend de : P04
- Cahier : M07, « Mesure ».
- Objectif : par bien et par semaine, les vues par canal, les contacts reçus pour ce bien (C03) et les visites (M05), lus pour le point hebdomadaire au vendeur que fera M08.
- Critères : compte juste sur un jeu inventé, à l'heure de Paris ; aucune donnée personnelle dans la mesure ; seuls l'agent du bien et la direction la lisent [R16].
- Attend : rien.

### P09 · Routes de M07 et passage de publication
- Statut : fait (2026-10-27)
- Décidé (2026-10-27) : routes et passage dans `packages/api/src/annonces.ts`, sans toucher au socle ; branchement, page publique et écran confiés à la voie 1 (P10)
- Qui : Claude, voie 2 · Relecture : forte · Dépend de : P04, P05
- Cahier : M07 ; Feuille de route, mars 2027 ; critère « mis en vente moins d'une heure après la fin du délai de rétractation ».
- Objectif : les routes `/v1/annonces` (fiche, liste de contrôle, brouillon, correction, validation, état et passage de publication, semaine, contrôle des vidéos, plan de tournage) dans `packages/api/src/annonces.ts`, de la même forme que celles de `app.ts`, et `syncAnnonces`, le passage de publication d'un réseau, sans toucher aux fichiers du socle.
- Critères : chaque route sous R16, chaque refus une ligne au journal ; un parcours de test complet par les routes, de la fin du délai de rétractation à la publication partout, en moins d'une heure sur horloge simulée.
- Attend : rien.

### P10 · Branchement de M07 dans le socle, page publique et écran « Mettre en vente »
- Statut : fait (2026-10-27)
- Décidé (2026-10-27) : M07 exporté en espace de noms `annonces` (noms déjà pris dans le socle) ; un seul cron toutes les 15 minutes, créneaux du passage en UTC ; vitrine `/biens/:id` sans index tant que le chantier est en essai ; photos depuis un stockage R2 `MEDIA` facultatif (H25).
- Qui : Claude, voie 1 (fichiers du socle : `packages/core/src/index.ts`, `packages/api/src/app.ts`, `packages/api/src/worker.ts`, application de l'agent) · Relecture : forte · Dépend de : P09
- Cahier : M07 ; Organisation, exigence de design (protocole, section 9).
- Objectif : exporter `annonces` depuis `@aimmo/core` et remplacer l'import relatif de `packages/api/src/annonces.ts` ; ajouter `annonceRoutes()` aux routes de `app.ts` ; lancer `syncAnnonces` toutes les 15 minutes depuis le déclencheur du Worker ; servir la page publique du bien et sa fiche imprimable (`PageBien`) et les médias ; dans l'application de l'agent, un écran « Mettre en vente » qui montre la liste de contrôle, l'annonce sourcée phrase par phrase (chaque nombre relié à son champ) et le bouton de validation.
- Critères : les routes répondent derrière la clé d'API [R16] ; le passage tourne toutes les 15 minutes, une seule fois par créneau ; la page publique ne montre qu'une version publiée, sans adresse [R46] ; écran accessible, sans texte générique, beau sur téléphone d'abord.
- Attend : rien.

### P11 · Passage de publication : une panne d'un réseau n'arrête pas les autres
- Statut : fait (2026-10-27)
- Qui : Claude, voie 1 (`packages/api/src/vitrine.ts`) · Relecture : normale · Dépend de : P10
- Cahier : M07.
- Objectif : dans `runListingSync`, chaque réseau passe dans son propre essai : une panne va au journal, sans donnée, le réseau suivant passe, et le créneau est marqué en erreur à la fin (comme `offres.quotidien`, O09).
- Critères : un test avec deux réseaux, le premier en panne : le second publie, une ligne `api.erreur` au journal, créneau en erreur.
- Attend : rien.

**M09 · Offres, mai 2027.**

Voie : 2

Découpé le 2026-10-27 par la voie 2. Ids `O..` pour Offre. Cahier : M09 Offres ; Feuille de route, mai 2027 : « une offre test suivie de bout en bout » ; règles R14 (aucune évaluation de solvabilité) et R15 (aucune pièce d'identité hors du coffre).
Décidé, lecture prudente : le système enregistre, contrôle, transmet et suit les délais ; il n'accepte, ne refuse, ne contre-propose ni ne négocie jamais : seule une réponse du vendeur, rapportée par l'agent avec sa preuve, change l'état d'une offre [R57]. La première version range l'offre comme un enregistrement structuré (montant, conditions suspensives, validité, financement déclaré) avec la référence de l'offre signée sur papier ; la signature en ligne de l'offre viendra avec un modèle « offre d'achat » dans la bibliothèque de M06, quand la voie qui tient M06 l'aura ajouté. Le financement déclaré ne sert qu'à vérifier la cohérence des montants, jamais à noter l'acquéreur [R14]. L'identité de l'acquéreur est un état (vérifiée ou non, par qui, quand), lu dans le contrôle d'identité de D03, jamais une copie [R15]. La transmission au vendeur passe par le contrôle central des envois, en mode essai, après validation de l'agent. M10 n'existe pas encore : l'offre acceptée ouvre un dossier de vente minimal, que M10 complétera, et ce dossier reste bloqué tant que l'identité de chaque acquéreur n'est pas vérifiée [R58]. Le code de M09 vit dans `packages/core/src/offres/` et ses migrations à partir de `0201`, sans toucher aux fichiers du socle.

### O01 · Offre écrite enregistrée, avec son registre chaîné
- Statut : fait (2026-10-27)
- Décidé (2026-10-27) : le registre est l'offre elle-même, une ligne par offre, chaînée et ancrée au journal, une ancre par rang ; ancre manquée reprise au prochain enregistrement ; conditions : prêt, vente d'un autre bien, permis, certificat d'urbanisme, autre sans texte ; validité de 1 à 60 jours ; bien vendu, loué ou retiré : plus d'offre ; acquéreur d'un autre agent : par la direction
- Qui : Claude · Relecture : forte · Dépend de : D04, T01
- Cahier : M09, « Offre écrite » ; règle « toute offre reçue est transmise au vendeur ».
- Objectif : l'agent enregistre une offre reçue pour un bien en vente : acquéreur (sa fiche), montant, conditions suspensives dans une liste fermée (prêt avec montant et durée, vente d'un autre bien, permis, autre), durée de validité, financement déclaré (apport, prêt), référence de l'offre signée ; chaque offre reçoit un numéro dans le registre des offres du bien, chaîné par empreintes, en ajout seul ; l'historique de l'offre est horodaté.
- Jamais vu : **registre des offres vérifiable par le vendeur**. Chaque offre reçue prend sa place dans un registre chaîné du bien ; le vendeur voit le nombre d'offres reçues et peut vérifier qu'aucune n'a été retenue ni modifiée après coup. Aucun réseau ne prouve ainsi au vendeur qu'il a vu toutes les offres.
- Critères : une offre sans montant, sans validité ou avec une condition hors liste est refusée, le champ nommé ; deux offres simultanées ont deux numéros sans trou ; une modification directe d'une ligne du registre est détectée par le contrôle [R56] ; rien ne s'efface [R17] ; seuls l'agent du bien et la direction enregistrent ou lisent une offre [R16] ; aucune donnée personnelle au journal [R13].
- Attend : rien.

### O02 · Contrôles de l'offre, sans évaluer personne
- Statut : fait (2026-10-27)
- Décidé (2026-10-27) : identité selon la règle de D03 (même réglage, fiches réunies), lue seulement avec le droit de voir la fiche de l'acquéreur ; cohérence sur le prix offert ; contrôle fait à l'enregistrement et à la demande
- Qui : Claude · Relecture : forte · Dépend de : O01
- Cahier : M09, « Contrôles ».
- Objectif : à l'enregistrement et à la demande, un contrôle écrit, ligne par ligne : identité de chaque acquéreur vérifiée ou non (état lu dans D03), cohérence entre le montant et le financement déclaré (apport plus prêt couvrent le prix offert ; l'offre ne porte pas de frais), offre dans sa durée de validité ; le résultat est un constat, jamais une note.
- Critères : aucun score, aucun classement, aucune évaluation de solvabilité [R14] ; le contrôle ne lit aucune pièce d'identité [R15] ; écart de financement chiffré et montré sans jugement ; résultat au journal en codes, sans montant ni nom [R13].
- Attend : rien.

### O03 · Transmission au vendeur et réponse horodatée
- Statut : fait (2026-10-27)
- Décidé (2026-10-27) : transmission par message (contrôle central, essai, texte du code sans nom de l'acquéreur), au téléphone ou en personne attestés par l'agent ; réponse avec preuve et heure à fuseau, jamais avant la transmission ; alerte d'offre non transmise après 24 h, une fois, reprise si le journal a manqué ; le branchement des passages quotidiens au planificateur suit avec celui de M09 (fichiers du socle) ; Codex sans réponse 18 min à sa seconde relecture, fusion sans lui
- Qui : Claude · Relecture : forte · Dépend de : O02
- Cahier : M09, « Transmission » ; règles « aucun programme n'accepte une offre ni ne négocie un prix », « toute offre reçue est transmise au vendeur ».
- Objectif : l'agent valide la transmission de chaque offre au vendeur (message par le contrôle central, en mode essai) ; la réponse du vendeur (acceptation, refus, contre-offre) est rapportée par l'agent avec sa preuve et son heure ; un contrôle quotidien signale toute offre enregistrée et pas transmise.
- Critères : une offre non transmise après le délai réglé est signalée à l'agent et à la direction [R56] ; aucune fonction ne change l'état d'une offre sans une réponse du vendeur rapportée avec preuve [R57] ; l'envoi passe par le contrôle central (horaires, exclusions) [R01, R02] ; historique complet et horodaté.
- Attend : rien pour l'essai.

### O04 · Contre-offres et historique de la négociation
- Statut : fait (2026-10-27)
- Décidé (2026-10-27) : propositions transmises de vive voix ou par écrit, attesté ; une proposition n'existe qu'après une réponse « contre-offre » ; montants donnés par les parties ; les contre-offres sans réponse ont leur tâche avant l'échéance (O05)
- Qui : Claude · Relecture : normale · Dépend de : O03
- Cahier : M09, « Transmission », « contre-offre ».
- Objectif : une contre-offre du vendeur crée une nouvelle proposition liée à l'offre, transmise à l'acquéreur après validation de l'agent ; la réponse de l'acquéreur est rapportée de la même façon ; la chaîne complète se lit dans l'ordre.
- Critères : une chaîne offre, contre-offre, nouvelle offre se lit dans l'ordre avec chaque heure ; une proposition remplacée ne peut plus être acceptée ; aucun montant proposé par le système [R57].
- Attend : rien.

### O05 · Délais de validité suivis
- Statut : fait (2026-10-27)
- Décidé (2026-10-27) : une tâche la veille du dernier jour (réglage), une par offre sans réponse ; liste sous R16 comme les échéances des mandats ; offre échue le lendemain, à Paris
- Qui : Claude · Relecture : normale · Dépend de : O01
- Cahier : M09, règle « les délais de validité sont suivis et rappelés à l'agent ».
- Objectif : chaque jour, une tâche pour l'agent avant l'échéance d'une offre sans réponse (délai en réglage), et l'offre passe « échue » le lendemain de sa fin, à l'heure de Paris.
- Critères : une seule tâche par échéance ; une offre échue ne peut plus être acceptée [R59] ; calcul juste à l'heure de Paris ; rien n'est envoyé au vendeur ni à l'acquéreur.
- Attend : rien.

### O06 · Tableau comparatif des offres pour le vendeur
- Statut : fait (2026-10-27)
- Décidé (2026-10-27) : ordre d'arrivée, sans tri ; net vendeur = montant moins les honoraires fixés au mandat ; état et validité de la dernière contre-offre ; état du registre montré ; date de signature souhaitée pas encore saisie
- Qui : Claude · Relecture : normale · Dépend de : O02
- Cahier : M09, « Plusieurs offres ».
- Objectif : pour un bien, toutes les offres en cours côte à côte : montant, net vendeur après honoraires du mandat, conditions suspensives, durée de validité restante, date de signature souhaitée ; dans l'ordre d'arrivée, sans aucun tri ni note.
- Critères : aucun classement ni recommandation [R14, R57] ; net vendeur calculé juste depuis le mandat en vigueur ; aucune coordonnée de l'acquéreur ; toutes les offres reçues y figurent [R56].
- Attend : rien.

### O07 · Offre acceptée : dossier de vente, bloqué sans identité vérifiée
- Statut : fait (2026-10-27)
- Décidé (2026-10-27) : dossier ouvert par l'agent du bien après une acceptation rapportée avec preuve ; une seule offre acceptée par bien, vérifié dans l'instruction d'insertion ; le bien passe « sous offre » ; compromis bloqué sans identité vérifiée, lue sous les droits de la fiche de l'acquéreur
- Qui : Claude · Relecture : forte · Dépend de : O03
- Cahier : M09, « Offre acceptée » ; critère « aucun compromis préparé sans identité vérifiée de l'acquéreur ».
- Objectif : une acceptation rapportée avec preuve ouvre un dossier de vente minimal (bien, offre, acquéreurs, vendeur), que M10 complétera ; le dossier ne peut passer à « compromis en préparation » tant que l'identité de chaque acquéreur n'est pas vérifiée ; le bien passe « sous offre » pour la publication (M07).
- Critères : aucun compromis préparé sans identité vérifiée [R58] ; une seule offre acceptée par bien à la fois ; le parcours de test d'une offre, de l'enregistrement au dossier, garde un historique complet et horodaté.
- Attend : rien.

### O08 · Routes de M09
- Statut : fait (2026-10-27)
- Décidé (2026-10-27) : routes et passage quotidien dans `packages/api/src/offres.ts`, sans toucher au socle ; clé d'envoi des offres (rejeu rendu tel qu'enregistré, clé reprise pour une autre offre refusée) ; branchement confié à la voie qui tient le socle (O09)
- Qui : Claude · Relecture : forte · Dépend de : O07
- Cahier : M09.
- Objectif : les routes `/v1/offres` dans `packages/api/src/offres.ts`, de la même forme que celles de `app.ts`, et les passages quotidiens (offres non transmises, échéances), sans toucher au socle ; leur branchement dans `app.ts` et au planificateur suit, comme P10, par la voie qui tient le socle.
- Critères : chaque route sous R16, chaque refus une ligne au journal ; une offre test suivie de bout en bout par les routes ; un double envoi de la même offre (clé d'idempotence) ne crée qu'une ligne au registre.
- Attend : rien.

### O09 · Branchement de M09 dans le socle
- Statut : fait (2026-10-27)
- Décidé (2026-10-27) : M09 exporté en espace de noms `offres` ; passage `offres.quotidien` à 6 h ; une panne d'un réseau ou d'un contrôle n'arrête pas les autres.
- Qui : Claude, voie 1 (fichiers du socle : `packages/core/src/index.ts`, `packages/api/src/app.ts`, `packages/api/src/planificateur.ts`, `packages/api/src/worker.ts`) · Relecture : forte · Dépend de : O08
- Cahier : M09 ; règles « les délais de validité sont suivis et rappelés à l'agent », « toute offre reçue est transmise au vendeur ».
- Objectif : exporter `offres` depuis `@aimmo/core` et remplacer l'import relatif de `packages/api/src/offres.ts` ; ajouter `offreRoutes()` aux routes de `app.ts` ; lancer `syncOffres` chaque jour depuis le planificateur, une fois par créneau.
- Critères : les routes répondent derrière la clé d'API [R16] ; le passage quotidien tourne une fois par jour [R56, R59] ; rien ne part réellement tant que le plan n'a pas mis d'envoi en service.
- Attend : rien.

### O10 · Écran des offres dans l'application
- Statut : fait (2026-11-02)
- Reste : fusionnée (#272) ; relecture forte 3 P0 et 6 P1 corrigés ; Codex à sa limite (H03) ; vérification GitHub verte ; suite complète non finie en local (coupée à 10 min). Dépôt réel avec H25 ; suite en O11.
- Trouvé le 2026-11-02 : M09 a ses routes (O08, O09), aucun écran de l'application ne les appelle ; l'agent ne peut donc ni enregistrer ni transmettre une offre sans outil technique.
- Qui : Claude, voie 1 · Relecture : forte · Dépend de : O09
- Cahier : M09 ; R14, R16, R56, R57, R58, R59, R201.
- Objectif : depuis « Mes biens », l'agent ouvre « Offres » : registre du bien et tableau comparatif dans l'ordre d'arrivée ; il enregistre une offre, lit son contrôle, atteste la transmission, rapporte la réponse du vendeur avec sa preuve, suit la chaîne des contre-offres, ouvre le dossier ; écran chargé à part (`/app/offres.js`), sur le système de design.
- Jamais vu : **le pas à faire de chaque offre, dit par le registre** : chaque offre porte une seule prochaine action tirée de son état réel (à transmettre, réponse attendue, échue, dossier à ouvrir), et l'écran montre aux yeux de l'agent la preuve que le registre du bien est intact.
- Critères : aucun tri, note ni recommandation, ordre d'arrivée seul [R14, R57] ; aucun bouton n'accepte ni ne refuse sans réponse rapportée avec preuve [R57] ; l'acquéreur se choisit parmi les contacts, aucun identifiant à saisir [R16] ; refus dits en français ; budget et accessibilité tenus [R201].
- Attend : rien.

### O11 · Transmission par message qui ne dit pas faux, mandant refusé comme acquéreur
- Statut : fait (2026-11-02)
- Reste : fusionnée (#273) ; relecture forte 1 P1 corrigé ; Codex à sa limite (H03) ; vérification GitHub verte ; avec les envois réels, un message parti devra compter comme transmission.
- Trouvé le 2026-11-02 (relecture de O10) : `POST /offres/:id/transmission` avec `via: message` marque l'offre transmise alors qu'en essai rien ne part, ce qui coupe l'alerte R56 ; `record` accepte le mandant du bien comme acquéreur par la route.
- Qui : Claude, voie 1 · Relecture : forte · Dépend de : O10
- Cahier : M09 ; R26, R56.
- Objectif : tant que les envois réels ne sont pas en service, un message d'essai ne compte pas comme une transmission au vendeur ; l'enregistrement d'une offre refuse le mandant, sous toutes ses fiches.
- Critères : en essai, l'offre reste à transmettre et l'alerte R56 part toujours [R56, R26] ; mandant et fiches réunies refusés, avec le champ nommé ; suite verte, dont les tests de O03 à adapter sans affaiblir la règle.
- Attend : rien.

**M10 · Compromis et acte, mai 2027.**

Voie : 2

Découpé le 2026-10-27 par la voie 2. Ids `N..` pour Notaire. Cahier : M10 Compromis et acte ; Feuille de route, mai 2027 : « 3 dossiers tests complets, sans pièce manquante » ; critères « chaque dossier en cours a ses échéances et ses alertes », « aucune relance envoyée hors des heures d'envoi ».
Décidé, lecture prudente : M10 complète le dossier de vente ouvert par O07 ; le compromis et l'acte sont rédigés par le notaire, AIMMO lui transmet un dossier complet et ne rédige aucun acte. Une pièce est une référence de stockage (R2, derrière une interface, faux stockage dans les tests), jamais son contenu ; une pièce d'identité ou anti-blanchiment n'est jamais une pièce du dossier : seul l'état « identité vérifiée » de D03 y figure [R15]. Les échéances légales sont calculées par le code depuis les dates saisies avec leur preuve (rétractation de 10 jours à compter du lendemain de la première présentation de la notification, reportée au premier jour ouvrable si elle tombe un samedi, un dimanche ou un jour férié ; réponse de la commune 2 mois après la réception de la déclaration d'intention d'aliéner) ; les autres dates (prêt, acte) sont lues dans le compromis, jamais inventées [R10]. Le financement est suivi tel que déclaré, jamais évalué [R14]. AIMMO ne reçoit jamais de fonds. Toute relance ou information aux clients et au notaire passe par le contrôle central, en mode essai, dans les heures d'envoi [R01, R26]. Le suivi des commerces (engagement de confidentialité) vient avec M16 ; les espaces propriétaire et acquéreur avec M11 et M13 (juin 2027) : M10 prépare leurs vues. Le code de M10 vit dans `packages/core/src/dossiers/`, ses migrations à partir de `0301`, ses routes dans `packages/api/src/dossiers.ts`, sans toucher aux fichiers du socle ni à ceux de M09 sauf par une tâche qui le dit.

### N01 · Pièces du dossier notaire
- Statut : fait (2026-10-27)
- Reste : relecture de Codex de la correction de son P0 restée sans réponse 26 min, fusion sans elle (#90).
- Décidé (2026-10-27) : chaque pièce porte la date du document, saisie par l'agent, pour juger sa validité à l'acte (N06) ; le gaz est demandé pour tout logement de 15 ans ou plus, quel que soit le chauffage (sans installation, la pièce est l'attestation d'absence) ; 15 ans pile comptent ; lot de copropriété : notice d'information, plan pluriannuel de travaux ou diagnostic technique global, et dossier technique amiante des parties communes avant juillet 1997 ; diagnostics dépendant d'un arrêté local (termites, mérule, assainissement) à ajouter par commune plus tard
- Qui : Claude · Relecture : forte · Dépend de : O07
- Cahier : M10, « Dossier notaire » ; Conformité, données minimales.
- Objectif : la liste des pièces attendues pour un dossier de vente, calculée par des règles écrites selon le bien (titre de propriété, diagnostics, documents de copropriété pour un lot, fiches de renseignements du vendeur et de l'acquéreur) ; l'agent range chaque pièce reçue par sa référence de stockage, datée et attribuée ; la liste des pièces manquantes ; le dossier est « complet » quand rien ne manque.
- Critères : la liste dépend seulement des données du bien, la même pour tous [R60] ; une pièce reçue ne s'efface ni ne change, une nouvelle version s'ajoute [R17] ; une pièce d'identité, un document anti-blanchiment ou un RIB sont refusés comme pièce, l'identité n'y figure que comme état vérifié [R15] ; seul l'agent du dossier range une pièce, l'agent, la direction et la conformité lisent [R16] ; 3 dossiers tests (maison, appartement en copropriété, terrain) arrivent à « complet ».
- Attend : rien.

### N02 · Échéancier du dossier et alertes à l'agent
- Statut : fait (2026-10-27)
- Décidé (2026-10-27) : la demande unique de pièces ou de visite de la commune suspend son délai, qui reprend pour ce qui restait, au moins un mois ; toute fin d'échéance légale un samedi, un dimanche ou un jour férié est reportée au jour ouvrable suivant ; une tâche par échéance, par date et par agent responsable du bien ; une échéance sans sa date donne une tâche « à saisir »
- Qui : Claude · Relecture : forte · Dépend de : N01
- Cahier : M10, « Échéancier ».
- Objectif : à la signature du compromis, l'agent saisit les dates avec leur preuve (signature, première présentation de la notification à l'acquéreur, date limite du prêt, dépôt de la déclaration d'intention d'aliéner, demande de l'état daté, date prévue de l'acte) ; le code calcule la fin de la rétractation et la date de réponse de la commune ; chaque jour, une tâche pour l'agent avant chaque échéance, une seule par échéance.
- Critères : fin de rétractation exacte, jours fériés et fins de semaine compris, sur un jeu de cas écrits [R61] ; aucune échéance sans date saisie ni preuve, rien d'inventé [R10, R61] ; chaque dossier en cours a ses échéances et ses alertes, sur horloge simulée à l'heure de Paris ; une seule tâche par échéance.
- Attend : rien.

### N03 · Relances des pièces manquantes, en mode essai
- Statut : fait (2026-10-27)
- Reste : relecture de Codex restée en cours plus de 30 min, fusion sans elle (#95).
- Décidé (2026-10-27) : seules les pièces que le client a lui-même sont relancées par mail (titre, fiches de renseignements, règlement de copropriété, procès-verbaux), les autres restent des tâches de l'agent ; finalité `suivi_vente`, accord exigé ; le message nomme le bien par sa commune et sa référence d'agence, un rappel porte sa date ; une relance en attente d'un jour passé, ou dont la pièce est arrivée, est close avec sa raison
- Qui : Claude · Relecture : forte · Dépend de : N01, B02
- Cahier : M10, « relances automatiques » et règles.
- Objectif : chaque jour, pour chaque pièce manquante attendue d'un client, une relance préparée et passée par le contrôle central, rangée dans la boîte d'essai ; texte écrit par le code, sans IA, nommant la pièce ; l'agent voit ce qui est parti et ce qui a été refusé.
- Critères : aucune relance hors des heures d'envoi, sur horloge simulée de la nuit au dimanche [R01] ; jamais à une personne exclue ou arrêtée [R02, R04] ; une relance par pièce et par période réglée [R05] ; rien ne part réellement [R26] ; une pièce reçue arrête ses relances.
- Attend : rien.

### N04 · Suivi du financement déclaré
- Statut : fait (2026-10-28)
- Reste : relecture de Codex de la correction de son P0 (lectures au journal) restée sans réponse 30 min, fusion sans elle (#98).
- Qui : Claude · Relecture : normale · Dépend de : N02
- Cahier : M10, « Suivi du financement ».
- Objectif : les étapes du prêt déclarées par l'acquéreur ou son courtier (demande déposée, accord de principe, offre de prêt émise, offre acceptée, refus), chacune avec sa date et qui l'a déclarée ; une alerte à l'agent quand la date limite du prêt approche sans offre de prêt déclarée.
- Critères : aucune note, aucun score, aucun tri sur le financement, ni dans les données ni dans les routes [R14] ; seules les étapes d'une liste fermée sont acceptées ; l'alerte part une fois, avant la date limite réglée.
- Attend : rien.

### N05 · Aucun fonds, bouclier contre le faux RIB (Jamais vu)
- Statut : fait (2026-10-28)
- Décidé (2026-10-28) : une alerte à l'agent par message suspect, le rappel au client une fois par personne et par dossier ; seules les sortes de signaux sont rangées ; le branchement à la réception et le masquage de l'IBAN dans le message rangé vont au socle (N09)
- Qui : Claude · Relecture : forte · Dépend de : N03
- Cahier : M10, règle « AIMMO ne reçoit jamais de fonds ».
- Objectif : aucun texte d'AIMMO à un client ou au notaire ne demande un paiement ni ne porte de coordonnée bancaire ; chaque message reçu dans la conversation d'un dossier en cours qui parle de virement, d'acompte, de séquestre ou de changement de RIB, ou qui porte un IBAN, déclenche aussitôt une alerte à l'agent, et le client reçoit, dans les heures d'envoi, le rappel écrit qu'AIMMO ne demande jamais de fonds ni de changement de coordonnées bancaires. Jamais vu : aucun réseau ni logiciel ne surveille ainsi la fraude au faux RIB pendant toute la vente.
- Critères : un texte sortant avec IBAN, RIB ou demande de paiement est refusé par le contrôle, la raison au journal sans la donnée [R62] ; un message reçu suspect donne une alerte à l'agent en moins d'une minute, une seule par message [R18, R62] ; l'IBAN reçu n'est ni rangé en clair ni envoyé à une IA [R15] ; le rappel au client respecte R01 à R05 ; aucune table ni route ne reçoit ou ne suit des fonds.
- Attend : rien.

### N06 · Acte signé : vente close, commission due
- Statut : fait (2026-10-28)
- Reste : l'avenant de durée signé après le compromis, réglé par D10 (#256) ; relecture de Codex de la dernière correction sans réponse 30 min, fusion sans elle (#102).
- Décidé (2026-10-28) : le mandat qui compte est celui en vigueur au compromis, signé au plus tard ce jour-là et hors délai de rétractation (sauf demande écrite) ; sinon pas de commission, la direction tranche ; DPE d'avant juillet 2021 périmé depuis 2025 ; plomb compté un an faute de résultat connu ; écritures reprenables après une coupure
- Qui : Claude · Relecture : forte · Dépend de : N02
- Cahier : M10, « Acte signé » ; M13 et M11 pour la suite.
- Objectif : l'agent rapporte l'acte signé avec sa preuve (référence de l'attestation du notaire) ; le dossier se clôt, le bien passe « vendu », la commission devient due au montant du mandat en vigueur, rangée pour M13, et l'après-vente est marqué à démarrer pour M11.
- Critères : pas d'acte sans compromis en préparation et sans dossier complet [R58, R60] ; une pièce périmée à la date de l'acte, d'après sa date de document rangée par N01 (état des risques 6 mois, électricité et gaz 3 ans, DPE 10 ans, durées en réglage), compte comme manquante [R60] ; la commission vient du mandat en vigueur, avenants compris, jamais d'une saisie [R10, R63] ; une seule clôture par dossier ; rien ne s'efface [R17] ; la publication montre le bien vendu au passage suivant.
- Attend : rien.

### N07 · Chemin critique de la vente (Jamais vu)
- Statut : fait (2026-10-28)
- Décidé (2026-10-28) : le jour déclaré d'une offre de prêt est celui de sa réception par l'acquéreur, d'où part le délai de réflexion de 10 jours ; une acceptation plus tôt ne compte pas ; un refus ne bloque que s'il est la dernière étape ; sans rétractation ni réponse de la commune datées, pas de jour au plus tôt ; la vue du vendeur se calcule sans le prêt
- Qui : Claude · Relecture : forte · Dépend de : N02, N04, N06
- Cahier : M10, « Suivi en direct » ; L'IA et l'humain, « suit les échéances, informe les clients ».
- Objectif : pour chaque dossier, le code calcule la date d'acte au plus tôt possible et nomme ce qui la tient (pièce manquante, rétractation, réponse de la commune, prêt, état daté), étape par étape, avec qui doit agir ; une vue vendeur et une vue acquéreur, chacune sans la donnée personnelle de l'autre partie, prêtes pour les espaces de M11. Jamais vu : aucun réseau ne dit au client, à tout moment, ce qui retarde son acte et qui le tient.
- Critères : même calcul pour les mêmes données, chaque ligne avec sa raison, sans IA [R61] ; aucune date inventée, ce qui manque est dit [R10] ; la vue vendeur ne porte ni nom ni coordonnée de l'acquéreur, et l'inverse [R19, R52] ; sur 3 dossiers tests, l'élément bloquant est le bon à chaque étape.
- Attend : rien.

### N08 · Routes de M10
- Statut : fait (2026-10-28)
- Qui : Claude · Relecture : forte · Dépend de : N01 à N07
- Cahier : M10 ; Feuille de route, mai 2027.
- Objectif : les routes `/v1/dossiers` (pièces, échéancier, financement, acte, chemin critique, alertes) dans `packages/api/src/dossiers.ts`, de la même forme que celles de `app.ts`, et `syncDossiers`, le passage quotidien (échéances, relances, financement), sans toucher au socle.
- Critères : chaque route sous R16, chaque refus une ligne au journal ; 3 dossiers tests complets, sans pièce manquante, suivis par les routes de l'offre acceptée à l'acte ; le passage quotidien rejoué n'ajoute rien.
- Attend : rien.

### N09 · Branchement de M10 dans le socle
- Statut : fait (2026-10-28)
- Décidé (2026-10-28) : routes de M10 fermées (503) sans le compartiment R2 `PIECES` (H25), passage `dossiers.passage` seulement avec lui ; `dossiersJob` fait déjà les relances des pièces, `pieceReminderJob` n'est pas branché à part ; IBAN et RIB masqués à la réception (corps, objet, contenu illisible texte par texte) par un parcours linéaire borné par la clé modulo 97 ; au contrôle central, R62 refuse pour tout texte à un client les coordonnées bancaires et les demandes de payer qui nomment ce qui se paie, la liste complète restant aux textes du code de M10.
- Reste : les messages reçus rangés avant N09 gardent leur IBAN en clair (mode essai) ; les échos des réponses de l'agent par Meta, réglés par N10 ; relecture de Codex de la dernière correction restée en cours, fusion sans elle (#111).
- Décidé (2026-10-28) : `packages/api/src/dossiers.ts` expose `dossierRoutes()`, `syncDossiers`, `dossiersJob` (tous les jours de 9 h à 19 h, relances jamais le dimanche) et `R2PieceStore` ; il importe M10 par un chemin relatif, à remplacer par `dossiers` de `@aimmo/core` ; la tâche `pieceReminderJob` du cœur n'est plus à lancer, `dossiersJob` la contient ; le bucket R2 des pièces est à déclarer dans le Worker ; tant que `scan` n'est pas branché à la réception, le filet du bouclier ne relit que 48 h de messages
- Qui : Claude, voie 1 (fichiers du socle : `packages/core/src/index.ts`, `packages/api/src/app.ts`, `packages/api/src/planificateur.ts`, `packages/api/src/worker.ts`) · Relecture : forte · Dépend de : N08
- Cahier : M10.
- Objectif : exporter `dossiers` depuis `@aimmo/core` ; ajouter les routes de M10 à `app.ts` ; lancer `syncDossiers` chaque jour depuis le planificateur, une fois par créneau ; brancher `BouclierFonds.scan` (N05) à la réception des messages, dès qu'un message est rattaché à sa fiche, et masquer l'IBAN dans le message rangé [R15] ; appliquer `fundsInOutgoing` dans le contrôle central à tout texte destiné à un client [R62] ; lancer `dossiersJob` (N08), qui contient les relances (N03).
- Critères : les routes répondent derrière la clé d'API [R16] ; le passage tourne une fois par jour ; rien ne part réellement tant que le plan n'a pas mis d'envoi en service.
- Attend : rien.

### N10 · Réponses de l'agent par Meta : IBAN masqué
- Statut : fait (2026-11-02)
- Décidé (2026-11-02, voie 2) : masqué au rangement, comme à la réception ; les lignes déjà rangées ne sont pas réécrites ; un IBAN écrit par l'agent ne déclenche pas d'alerte. Codex à sa limite, fusion sans lui (#257).
- Voie : 2
- Qui : Claude, voie 2 · Relecture : normale · Dépend de : N09
- Cahier : M10, règle « AIMMO ne reçoit jamais de fonds » ; R15.
- Objectif : reste écrit de N09. La réponse qu'un agent écrit dans l'application du canal revient en écho et se range telle quelle : un IBAN ou un RIB y reste en clair, dans la fiche et dans l'écho gardé pour la reprise.
- Critères : l'IBAN d'un écho n'est rangé en clair ni dans `messages`, ni dans `pending_human_replies`, écho appliqué tout de suite ou gardé pour la reprise (tests [R15]) ; le reste du texte ne change pas ; un écho de notre propre message reste reconnu [R21].
- Attend : rien.

### N13 · Dates, financement et acte depuis l'écran du dossier
- Statut : fait (2026-11-02)
- Reste : fusionnée (#276) ; relecture forte 1 P1 corrigé (l'acte s'écrit tout ou rien, une clôture coupée reste reprenable) ; Codex à sa limite (H03) ; vérification GitHub verte ; suite complète non finie en local ; pas vu dans un vrai navigateur ; dépôt réel avec H25.
- Décidé : `POST /dossiers/<id>/preuves` range la preuve sous `preuves/` ; les routes refusent une preuve absente du stockage ; un dossier clos refuse date et étape du prêt de l'agent ; l'acte se confirme en deux gestes.
- Trouvé le 2026-11-02 (relecture de N12) : l'écran dit « Date à saisir · à vous » et aucun écran n'appelle `/dossiers/:id/dates`, `/financement` ni `/acte` en écriture : l'agent ne peut pas faire avancer le dossier.
- Qui : Claude, voie 1 · Relecture : forte · Dépend de : N12
- Cahier : M10 ; R10, R16, R61.
- Objectif : l'agent saisit chaque date avec sa preuve déposée, déclare les étapes du financement et range l'acte signé, sans référence à saisir.
- Critères : aucune date inventée, preuve exigée [R10] ; refus dits en français ; « Dossier complet » ne coexiste plus avec une pièce périmée en tête ; budget tenu [R201].
- Attend : H25 pour le dépôt réel.

### N12 · Écran du dossier de vente dans l'application
- Statut : fait (2026-11-02)
- Reste : fusionnée (#275) ; relecture forte 3 P1 corrigés ; Codex à sa limite (H03) ; vérification GitHub verte ; pas vu dans un vrai navigateur ; dépôt réel avec H25 ; suite en N13.
- Trouvé le 2026-11-02 : M10 a ses routes (`/v1/dossiers`) et aucun écran ne les appelle ; O10 ouvre le dossier, puis l'agent ne peut plus le suivre.
- Qui : Claude, voie 1 · Relecture : forte · Dépend de : O10
- Cahier : M10 ; R15, R16, R19, R52, R201.
- Objectif : depuis l'offre acceptée, l'agent lit les pièces attendues et reçues, les échéances et le chemin critique du dossier, et dépose une pièce ; écran chargé à part, sur le système de design.
- Critères : aucune pièce d'identité dans le dossier [R15] ; élément bloquant dit, rien d'inventé [R10] ; aucun identifiant à saisir [R16] ; budget et accessibilité tenus [R201].
- Attend : H25 pour le dépôt réel.

**M11 · Après la vente, juin 2027.**

Voie : 1

Découpé le 2026-10-27 par la voie 1. Ids `F..` pour Fidéliser. Cahier : M11 Après la vente ; Feuille de route, juin 2027 ; critères « sur 5 dossiers tests arrivés à l'acte, la demande d'avis part le lendemain », « aucune relance à une personne opposée ».
Décidé, lecture prudente : M11 part de l'acte signé rapporté par M10 (N06), lu par une interface (« dossier clos le … »), avec un faux dossier clos dans les tests tant que N06 n'est pas fusionnée. Tout envoi passe par le contrôle central, en mode essai, dans les heures d'envoi [R01, R26]. La demande d'avis va à chaque client du dossier (vendeurs et acquéreurs), sans tri selon sa satisfaction et sans contrepartie [R64] ; AIMMO n'écrit jamais d'avis à la place d'un client. Le lien vers la fiche Google de l'agent est un réglage de l'agent ; l'API Google Business Profile (H07) viendra pour lire les avis, pas pour en publier. Les relances après la vente : à un an, seulement à qui ne s'y est pas opposé, au-delà seulement avec l'accord donné à l'acte, avec désinscription dans chaque message [R65]. Une recommandation arrive dans M02 avec sa source, et n'est jamais rémunérée à un particulier [R66] : aucun champ de récompense, aucun texte qui en promet. La note de satisfaction est rangée pour M13. Le code vit dans `packages/core/src/apres-vente/`, ses migrations à partir de `0401`, ses routes dans `packages/api/src/apres-vente.ts`.

### N11 · Le vendeur d'un dossier : le mandant du jour de l'ouverture, pas tout ancien mandant
- Statut : fait (2026-11-02)
- Décidé (2026-11-02, voie 2) : le vendeur est figé à l'ouverture, un mandat signé ensuite n'en change pas ; un dossier ouvert sans mandat vivant reste sans vendeur, écrit au journal (`noSeller`) ; offres et ouverture sous `property:` ne sont plus au journal de qui possède ou a possédé le bien. Reste : la fiche `properties` d'un ancien mandant montre l'état et le prix d'aujourd'hui (fiche du bien, sans donnée d'une autre personne).
- Voie : 2
- Qui : Claude, voie 2 · Relecture : forte · Dépend de : N09, L07
- Cahier : M10, relances des pièces et bouclier ; M12, droit d'accès ; R96.
- Objectif : reste écrit de L07 (#159). Le vendeur d'un dossier se déduisait de « tout mandat du bien » ou du « dernier mandat du bien », même annulé, rétracté ou signé après l'ouverture : un ancien mandant recevait l'avancée et le prix de la vente suivante dans sa réponse d'accès, et une relance de pièces pouvait partir à la mauvaise personne. Ranger une fois, à l'ouverture, le mandant du dernier mandat vivant du bien (`sale_file_sellers`) ; la carte d'accès, les relances et le bouclier lisent ce seul fait ; le compte rendu de visite lit le dernier mandat vivant.
- Critères : un ancien mandant, un mandant annulé ou rétracté, un mandant signé après l'ouverture ne voient rien du dossier dans la réponse d'accès (tests [R96]) ; le vrai vendeur le voit, sans l'acquéreur ; la relance d'une pièce du vendeur va au vendeur du dossier ; le compte rendu de visite ne part pas au mandant d'un mandat annulé ou rétracté ; dossier et vendeur rangés en un seul lot, un dossier déjà ouvert reçoit son vendeur par la migration.
- Attend : rien.

### F01 · Recommandation d'un proche, rangée dans M02 avec sa source
- Statut : fait (2026-10-27)
- Décidé (2026-10-27) : la réponse ne dit jamais qui suit le proche ; la source ne nomme pas le client ; un proche sans agent passe à l'agent de la tâche ; une opposition après coup retire la tâche de la liste.
- Qui : Claude · Relecture : forte · Dépend de : C02
- Cahier : M11, « Recommandations » ; Conformité, consentement.
- Objectif : l'agent saisit qu'un client recommande un proche (prénom, une coordonnée, le projet, et ce que le proche a accepté : être appelé par l'agent, avec la preuve dite par le client) ; le proche arrive dans la fiche unique (rattachée si elle existe) avec la source « recommandation » qui nomme le client qui recommande ; une tâche « appeler » pour l'agent ; un lien « qui a recommandé qui » lisible sur les deux fiches.
- Critères : la source de la fiche du proche est « recommandation », avec le client qui recommande [R66] ; aucun champ ni texte de récompense : une saisie qui en parle (prime, cadeau, commission, bon d'achat, pourcentage) est refusée [R66] ; sans accord du proche, aucune tâche « appeler » et aucun envoi, la fiche est seulement rangée [R03] ; un proche exclu ou opposé n'est jamais rappelé [R02, R04] ; droits de la fiche [R16] ; rien d'une coordonnée au journal [R13].
- Attend : rien.

### Z01 · Jetons de lien qui ne déclenchent jamais le contrôle du texte
- Statut : fait (2026-10-28)
- Qui : Claude, voie 1 · Relecture : normale · Dépend de : rien
- Décidé (2026-10-28) : ouverte après une vérification rouge sur #101. Un jeton de rappel de V04 commençait par « gpt », et le contrôle du texte l'a lu comme une mention de l'IA [R06]. Le même défaut existe pour la désinscription des alertes de T03. F04 l'a déjà corrigé pour ses propres jetons (`newAfterSaleToken`).
- Cahier : M05, « Rappels » ; M08, « Alertes ».
- Objectif : les jetons de `newBookingToken` (rendezvous/reservation.ts) et de la désinscription des alertes (acquereurs/alertes.ts) ne commencent jamais par a, c, g, i ni r ; un rappel ou une alerte n'est plus jamais refusé pour R06 à cause du hasard.
- Critères : sur 2 000 tirages, le texte d'un rappel et celui d'une alerte passent le contrôle du texte [R06] ; le test de V04 ne peut plus échouer au hasard.
- Attend : rien.

### F02 · Demande d'avis le lendemain de l'acte, à tous, en mode essai
- Statut : fait (2026-10-28)
- Décidé (2026-10-27) : faite avant N06, comme le prévoit la lecture prudente de M11 : le dossier clos est lu par une interface, avec un faux dossier clos dans les tests ; N06 la branchera.
- Qui : Claude · Relecture : forte · Dépend de : N06
- Cahier : M11, « Demande d'avis » ; règle « l'avis est demandé à tous les clients, sans tri préalable, sans contrepartie ».
- Objectif : le lendemain d'un dossier clos, à 10 h, heure de Paris, une demande d'avis à chaque client du dossier, écrite par le code avec le lien de la fiche Google de l'agent (réglage de l'agent), passée par le contrôle central, rangée dans la boîte d'essai ; une seule par personne et par dossier.
- Critères : sur 5 dossiers tests clos, chaque client reçoit sa demande le lendemain, aucun deux fois [R64, R18] ; la demande ne dépend d'aucune note de satisfaction et ne promet rien [R64] ; sans lien réglé, rien ne part et l'agent est prévenu ; une personne exclue ou qui a demandé l'arrêt ne reçoit rien [R02, R04].
- Attend : rien (H07 seulement pour lire les avis plus tard).

### F03 · Remerciement : l'agent appelle, le message est préparé
- Statut : fait (2026-10-28)
- Décidé (2026-10-28) : faite avant N06, comme F02 : le dossier clos est lu par l'interface `DossiersClos` ; les appels « remercier » sont listés par F03 pour l'agent, et F07 les met dans « Ma journée ».
- Qui : Claude · Relecture : normale · Dépend de : N06
- Cahier : M11, « Remerciement ».
- Objectif : à la clôture, une tâche « appeler pour remercier » par client, au plan du jour de l'agent, et un message de remerciement préparé que l'agent valide ou non ; rien ne part sans sa validation.
- Critères : une tâche par client et par dossier [R18] ; le message validé passe par le contrôle central, en mode essai ; non validé, rien ne part.
- Attend : rien.

### F04 · Relance un an après la vente, sans jamais relancer une personne opposée
- Statut : fait (2026-10-28)
- Décidé (2026-10-28) : les dates clés sont les anniversaires de l'acte, de un à cinq ans ; sans choix rangé, aucune relance ; un accord ne se range qu'à l'acte, au plus 7 jours après ; un `non`, sur n'importe quel dossier de la personne et fiches réunies comprises, arrête tout et empêche tout nouvel accord.
- Qui : Claude · Relecture : forte · Dépend de : F02
- Cahier : M11, « Relances aux dates clés » ; règle « relances seulement aux clients qui ne s'y sont pas opposés, avec désinscription dans chaque message ».
- Objectif : à l'acte, l'agent range le choix du client (relances après la vente : oui, non, ou seulement à un an) avec sa preuve ; un an après la clôture, une relance écrite par le code, avec un lien de désinscription ; au-delà d'un an, seulement avec l'accord donné à l'acte ; une opposition dite plus tard arrête tout.
- Critères : aucune relance à une personne opposée, sur 30 dossiers tests à horloge simulée [R65] ; chaque message porte la désinscription, qui marche en un geste [R65] ; une seule relance par date clé [R18] ; hors heures d'envoi, rien ne part [R01].
- Attend : rien.

### F05 · Satisfaction : note et commentaire rangés pour M13
- Statut : fait (2026-10-28)
- Qui : Claude · Relecture : normale · Dépend de : F02
- Cahier : M11, « Satisfaction ».
- Objectif : le client donne une note de 1 à 5 et un commentaire par un lien à usage unique de sa demande d'avis ; la note est rangée avec le dossier pour M13 ; l'agent la voit ; elle ne change jamais qui reçoit la demande d'avis.
- Critères : un lien ne sert qu'une fois et expire ; la note ne trie ni ne bloque aucune demande d'avis [R64] ; le commentaire n'est jamais publié ni envoyé comme avis [R64] ; rien du commentaire au journal [R13].
- Attend : rien.

### F06 · Carnet du propriétaire, un an après (Jamais vu)
- Statut : fait (2026-10-28)
- Qui : Claude · Relecture : forte · Dépend de : F04, E01, E02
- Cahier : M11 ; M20 Gagner des mandats ; M04, fourchette par le code.
- Objectif : un an après l'achat, et seulement avec son accord donné à l'acte, l'acquéreur devenu propriétaire reçoit le carnet de son bien : la fourchette de valeur calculée par le code depuis les ventes DVF de sa commune (E01, E02), les ventes comparables de l'année, les échéances de ses diagnostics, et rien qu'il n'ait déjà donné ; c'est le premier contact de son futur mandat de vente, sans jamais le lui demander.
- Critères : chaque chiffre du carnet vient de la base ou des ventes publiques, sinon « non communiqué » [R10] ; sans accord, aucun carnet [R65] ; jamais de démarchage dans le texte : une liste fermée de tournures refuse « vendre maintenant », « estimation gratuite », « profitez » ; 5 carnets tests, chacun relu par le code contre ses sources.
- Attend : rien.

### F07 · Routes de M11, branchement et écran « Après la vente »
- Statut : fait (2026-10-28)
- Décidé (2026-10-28) : dossiers clos lus dans la base de M10 (`SqlDossiersClos`) : vendeur du mandat de la commission, puis acquéreur ; un logement est un appartement s'il est un lot de copropriété, une maison sinon, inconnu sans fiche (pas de carnet) ; position du carnet : centre de la commune par la Base adresse nationale, jamais une adresse ; une variable `APRES_VENTE_BASE` pour les trois liens publics, à la racine `/apres-vente/` ; les remerciements préparés restent à l'agent seul.
- Reste : relecture de Codex de la dernière correction (son P2) restée en cours plus de 10 min, fusion sans elle (#109) ; la mise en service attend `APRES_VENTE_BASE` et `DVF_BASE_URL`.
- Qui : Claude, voie 1 (fichiers du socle) · Relecture : forte · Dépend de : F01, F02, F03, F04, F05
- Cahier : M11 ; Organisation, exigence de design (protocole, section 9).
- Objectif : les routes `/v1/apres-vente` (recommandation, choix des relances, lien de la fiche Google, satisfaction, tâches) dans `packages/api/src/apres-vente.ts`, branchées dans `app.ts`, le passage quotidien au planificateur, et dans l'application de l'agent l'écran d'un dossier clos : demandes parties, tâches « remercier », recommandations, note.
- Critères : chaque route sous R16, refus au journal ; un parcours de test, de l'acte à la relance d'un an ; écran accessible, sans texte générique, beau sur téléphone d'abord.
- Reste de F06 : page publique du carnet (`CarnetsProprietaire.read`), réglage de son adresse, `BiensVendus` branché avec N06, `carnets` passé à `afterSaleReminderJob`.
- Reste de F03 : routes `decide`, `markCalled`, `list` ; appels « remercier » dans « Ma journée » ; `thankYouJob` au planificateur.
- Reste de F05 : page publique de la note et route de réponse (`Satisfaction.submit`), réglage `satisfactionBase` de `reviewRequestJob`, réponses dans l'écran de l'agent.
- Reste de F04 : brancher `afterSaleReminderJob` au planificateur, avec l'adresse de désinscription en réglage ; routes du choix (`recordChoice`), de la désinscription (`unsubscribe`, page publique) et de la liste.
- Reste de F02 : brancher `reviewRequestJob` au planificateur avec le `DossiersClos` de N06 ; routes du lien de la fiche Google (`setReviewLink`), des demandes (`list`) et des tâches (`openTasks`, `lien_avis` et `avis_non_parti`). Le plafond de R11, 2 demandes d'avis par jour pour tout le réseau, ne suffira pas quand le réseau clora plus de 2 ventes par jour : les demandes en trop sont closes et confiées à l'agent ; un plafond par agent serait un changement de R11, à décider avec Shawez.
- Reste de F01 : deux saisies simultanées du même proche peuvent laisser un projet et une source en trop (D1 sans transaction interactive) : la route de recommandation porte une clé d'idempotence.
- Attend : rien.

**M13 · Pilotage et finances, juin 2027.**

Voie : 1

Découpé le 2026-10-28 par la voie 1. Ids `K..` pour Kilomètres et chiffres. Cahier : M13 Pilotage et finances ; Feuille de route, juin 2027 : « chiffres identiques au contrôle manuel pendant 2 semaines » ; critères « 10 ventes passées recalculées sans écart », « le rapport du matin arrive chaque jour ouvré à 7 h 30 ».
Décidé, lecture prudente : tous les chiffres viennent de la base, par des requêtes écrites, jamais d'une saisie ni de l'IA ; l'IA n'évalue aucun agent et ne décide de rien les concernant ; aucun classement d'agents n'est montré à un agent [R14, R68, R69]. Une commission naît « prévue » au compromis, devient « due » seulement à l'acte rapporté par N06 (ou à la signature du bail, quand M15 existera), puis « facturée » et « payée », chaque passage dans l'ordre, avec sa preuve, jamais un montant saisi [R63, R67]. La part de l'agent et celle du réseau viennent d'une grille datée et versionnée réglée par la direction ; le partage entre agents (fichier commun, binôme d'une absence) et la prime de parrainage (M14, R83) sont lus par des interfaces, avec un faux dans les tests tant que M14 ne les fournit pas. Une facture a un numéro continu, chronologique, sans trou ; elle ne change ni ne s'efface, un avoir la corrige [R17, R71] ; aucune facture réelle tant que la plateforme agréée de facturation électronique et les modalités de l'expert-comptable ne sont pas en place (H26) : la plateforme est derrière une interface, en mode essai. Le reversement à l'agent est dû sous 24 h ouvrées après l'encaissement rapporté avec sa preuve, la direction est alertée avant l'échéance [R70]. Les numéros de règles R67 à R72 et de migrations à partir de `0501` sont réservés à M13. Le code vit dans `packages/core/src/pilotage/`, ses routes dans `packages/api/src/pilotage.ts`.

### K01 · Cycle de la commission : prévue, due, facturée, payée
- Statut : fait (2026-10-28)
- Décidé (2026-10-28) : parts arrondies au centime inférieur, le reste au réseau ; prime de parrainage prise sur la part du réseau ; aucune grille pour le passé ; la conformité n'a pas les chiffres (droits du socle) ; l'agent qui ne fait que partager voit sa part sans les honoraires ; écart d'honoraires, de mandat ou de jour de compromis à l'acte : la commission reste prévue, la direction tranche.
- Qui : Claude · Relecture : forte · Dépend de : N06
- Cahier : M13, « Commissions » et « Règles ».
- Objectif : une commission par dossier de vente, calculée par le code depuis le mandat en vigueur (honoraires, avenants compris) : « prévue » dès le compromis, « due » à l'acte (N06), puis « facturée » (K02) et « payée » (K03) ; la part de l'agent et la part du réseau par une grille datée (taux de l'agent, partage du fichier commun, binôme, prime de parrainage lue par une interface), la grille en vigueur au jour du compromis.
- Critères : 10 ventes passées tests recalculées sans écart, au centime, contre des montants écrits à la main [R69] ; aucun montant saisi, aucune route ne reçoit un montant [R63, R67] ; les statuts se suivent dans l'ordre, chacun avec sa preuve, une seule fois [R18, R67] ; une grille changée ne change pas une commission déjà prévue ; un agent ne voit que ses commissions [R16, R68] ; rien ne s'efface [R17].
- Attend : rien.

### K02 · Factures d'honoraires et de reversement, en mode essai
- Statut : fait (2026-10-28)
- Décidé (2026-10-28) : TVA 20 % sur les honoraires, aucune sur les reversements tant que l'expert-comptable n'a pas validé (H26) ; numéro calculé dans l'écriture même ; numéro des reversements et de leurs avoirs préfixé par l'identifiant entier de l'agent ; une vente annulée par un avoir n'émet plus aucune facture ; identifiants légaux de l'émetteur, adresse du client et conditions de paiement non inventés, attendus avec H09 et H26.
- Reste : relecture de Codex de la dernière correction impossible, limite d'usage de Codex atteinte ; fusion sans elle (#115).
- Qui : Claude · Relecture : forte · Dépend de : K01
- Cahier : M13, « Factures » et « Branchements ».
- Objectif : à la commission due, la facture d'honoraires du réseau au client qui paie (mentions obligatoires, numéro continu par réseau et par année) et la facture de reversement de l'agent au réseau, préparées par le code et validées par la direction ; émises par l'interface de la plateforme agréée (fausse plateforme d'essai) ; un avoir pour toute correction ; export comptable au format tableur (CSV).
- Critères : numéros continus, chronologiques, sans trou ni doublon, même en deux validations simultanées [R71] ; une facture émise ne change ni ne s'efface, un avoir la corrige [R17, R71] ; rien ne part à une vraie plateforme [R26] ; l'export recompte au centime les montants des factures ; aucune donnée bancaire [R15].
- Attend : H26 pour le réel seulement.

### K03 · Encaissement et reversement sous 24 h ouvrées
- Statut : fait (2026-10-28)
- Décidé (2026-10-28) : 24 h comptées heure par heure sur les seuls jours ouvrés à Paris ; alerte à 4 h de l'échéance (réglage), puis une fois passée ; la prime de parrainage due après l'encaissement (R83) sera facturée par M14.
- Reste : relecture de Codex impossible (limite d'usage, H03), fusion sur les vérifications du dépôt (#117) ; passage des alertes au planificateur avec K08.
- Qui : Claude · Relecture : normale · Dépend de : K02
- Cahier : M13, règle du versement sous 24 h ouvrées.
- Objectif : la direction rapporte l'encaissement des honoraires avec sa preuve ; le reversement de l'agent devient exigible sous 24 h ouvrées (jours ouvrés, fériés compris) ; une tâche pour la direction, une alerte avant l'échéance, puis le versement rapporté avec sa preuve passe la commission à « payée ».
- Critères : l'échéance exacte sur un jeu de cas écrits (vendredi soir, veille de férié) [R70] ; une alerte une seule fois, avant l'échéance, sur horloge simulée [R18] ; aucun fonds reçu ni suivi par AIMMO au-delà du statut et de sa preuve [R62].
- Attend : rien.

### K04 · Tableau de bord de l'agent, chaque chiffre prouvé (Jamais vu)
- Statut : fait (2026-10-28)
- Décidé (2026-10-28) : contacts = attributions à l'agent ; rendez-vous = tenus ; vente = acte signé dont la commission revient à l'agent (comme N06) ; honoraires à venir = ses parts (agent, partage) prévues, dues ou facturées, pas encore payées ; lignes sans nom, la fiche se lit sous ses droits.
- Reste : relecture de Codex impossible (limite d'usage, H03), fusion sur les vérifications (#118) ; si M14 réattribue les biens d'un agent parti, rattacher la vente à l'agent du compromis (K01).
- Qui : Claude · Relecture : forte · Dépend de : K01
- Cahier : M13, « Tableau de bord de l'agent » ; règle « un agent ne voit que ses propres chiffres ».
- Objectif : pour l'agent, sur une période : contacts reçus, rendez-vous tenus, mandats signés, ventes, honoraires à venir (prévus et dus), calculés par des requêtes écrites ; chaque chiffre s'ouvre sur la liste exacte des lignes qui le font. Jamais vu : aucun logiciel ne laisse l'agent recompter chacun de ses chiffres, ligne par ligne.
- Critères : chaque chiffre est égal au nombre ou à la somme des lignes qu'il montre, sur un jeu test complet [R69] ; un agent ne voit que ses chiffres, sans comparaison ni rang [R14, R68] ; aucune IA dans le calcul.
- Attend : rien.

### K05 · Tableau de bord du réseau : agents, zones, sources, coûts de l'IA
- Statut : fait (2026-10-28)
- Décidé (2026-10-28) : zone = zone de l'agent (« sans zone » sinon) ; contact sans agent compté sous la direction ; source d'un contact = canal du message d'origine, d'un mandat = sa source rangée ; coût de l'IA = coût rangé avec chaque message écrit par l'IA.
- Reste : relecture de Codex impossible (limite d'usage, H03), fusion sur les vérifications (#119).
- Qui : Claude · Relecture : normale · Dépend de : K04
- Cahier : M13, « Tableau de bord du réseau ».
- Objectif : pour la direction : les mêmes chiffres par agent, par commune et par source, et les coûts de l'IA par flux et par mandat signé, lus dans la base.
- Critères : la somme par agent égale le total du réseau, par zone et par source aussi [R69] ; seule la direction le lit [R16] ; aucune note ni score d'agent [R14].
- Attend : rien.

### K06 · Rapport du matin, chaque jour ouvré à 7 h 30
- Statut : fait (2026-10-28)
- Décidé (2026-10-28) : période = du jour ouvré précédent à la veille (le lundi couvre vendredi à dimanche) ; rapport rangé, lu dans l'application, jamais envoyé ; alertes : rappels en retard pour l'agent, reversements à faire pour la direction.
- Reste : relecture de Codex impossible (limite d'usage, H03), fusion sur les vérifications (#120) ; branchement au planificateur et écran avec K08.
- Qui : Claude · Relecture : normale · Dépend de : K05
- Cahier : M13, « Rapport du matin ».
- Objectif : chaque jour ouvré à 7 h 30, heure de Paris, un rapport rangé pour la direction et pour chaque agent : les chiffres de la veille, les contacts chauds, les alertes, en quelques lignes écrites par le code.
- Critères : un rapport par lecteur et par jour ouvré, aucun le week-end ni un jour férié, un seul même si le planificateur repasse [R18] ; chaque chiffre vient du tableau de bord [R69] ; un agent n'a que les siens [R68].
- Attend : rien.

### K07 · Alertes : budget de l'IA, chute d'un indicateur, échéance d'un document d'agent
- Statut : fait (2026-10-28)
- Décidé (2026-10-28) : budget de l'IA sans valeur par défaut (pas d'alerte tant que la direction ne l'a pas réglé) ; baisse comparée en moyenne par jour, 7 jours jusqu'à la veille contre les 28 précédents, une alerte par indicateur et par semaine ; échéances des documents d'agent par une interface, branchée sur le dossier d'agent de M14 par K08.
- Reste : relecture de Codex impossible (limite d'usage, H03), fusion sur les vérifications (#121).
- Qui : Claude · Relecture : normale · Dépend de : K06
- Cahier : M13, « Alertes ».
- Objectif : une alerte à la direction quand le coût de l'IA du mois atteint 70 % du budget réglé, quand un indicateur du réseau baisse de plus du seuil réglé sur 7 jours par rapport aux 28 précédents, et avant l'échéance d'un document d'agent (lue par une interface de M14).
- Critères : une alerte par seuil et par période [R18] ; seuils en réglage, les mêmes pour tous [R25] ; aucune alerte sur la personne d'un agent, seulement sur des chiffres [R14].
- Attend : rien.

### K08 · Routes de M13, écran « Mes chiffres » et mesure contre le comptage manuel
- Statut : fait (2026-10-28)
- Décidé (2026-10-28) : export du jour lu dans le tableau de bord du réseau, honoraires des ventes du jour en euros ; pièces d'agent lues en lecture seule (dernière version signée, agents actifs, échues comprises) ; l'application n'admet que les agents (A01) : l'écran de la direction passe en K09 ; numéro de reversement gardant les tirets de l'identifiant (échec aléatoire de K02 au journal, corrigé).
- Reste : relecture de Codex impossible (limite d'usage, H03), fusion sur les vérifications (#125).
- Qui : Claude, voie 1 (fichiers du socle) · Relecture : forte · Dépend de : K01 à K07
- Cahier : M13 ; Feuille de route, juin 2027.
- Objectif : les routes `/v1/pilotage`, les passages au planificateur (rapport du matin, alertes, reversements), l'écran « Mes chiffres » dans l'application de l'agent et le tableau de bord de la direction ; un export quotidien des chiffres pour les comparer au comptage manuel pendant 2 semaines, comme le décrit `docs/MESURE.md`.
- Critères : chaque route sous R16, refus au journal ; écran accessible, sans texte générique, beau sur téléphone d'abord ; l'export du jour égale le tableau de bord.
- Attend : H27 pour la mesure réelle seulement.

### K09 · Écran « Le réseau » pour la direction
- Statut : fait (2026-10-28)
- Décidé (2026-10-28) : la direction arrive sur « Le réseau » à la connexion, la conformité et les partenaires restent refusés ; chaque total refait la somme de ses lignes à l’écran et dit un écart ; une facture s’émet en deux gestes ; l’export se télécharge avec la clé dans l’en-tête ; relecture forte : 1 P1 corrigé (clé refusée pendant l’export). Codex : aucune remarque.
- Qui : Claude, voie 1 (fichiers du socle) · Relecture : forte · Dépend de : K08
- Cahier : M13, « Tableau de bord du réseau » et « Alertes ».
- Objectif : la direction se connecte à l'application avec sa clé et retrouve, sur téléphone d'abord, le tableau de bord du réseau (par agent, zone, source, coûts de l'IA), ses alertes, les reversements à faire, les brouillons de factures à valider et le téléchargement de l'export du jour, par les routes `/v1/pilotage` de K08.
- Critères : un agent qui se connecte garde son écran actuel, sans rien du réseau [R68] ; la direction voit chaque total égal à la somme de ses lignes [R69], les agents listés par identifiant, jamais classés [R14] ; écran accessible, sans texte générique.
- Attend : rien.

**M13 · Les finances à l'écran.**

Voie : 2

Trouvé le 2026-11-02 par la voie 2, en comparant les routes de l'API aux appels des écrans : M13 calcule tout, mais personne ne peut lire le rapport du matin ni les commissions, régler la grille, rapporter un encaissement ou un reversement, ni faire un avoir. Sans ces gestes, aucune commission ne devient payée. Fichiers à part (`packages/api/app/finances.ts`, `/app/finances.js`), une seule entrée posée dans l'application. Ids `K..` à la suite.
Restes trouvés de la même façon, à découper ensuite par la voie 2, un écran à la fois : M16 cessions, repreneurs, engagements et barèmes ; M15 remise des clés, gestion, garants et modèles de bail ; M11 tâches, satisfaction et remerciements ; M18 prospection et opposition des partenaires ; M20 mesure et engagements ; M19 bibliothèque et options ; M09 comparatif et historique des offres ; M17 loyers. M06 reste à la voie 1 (D11 à D13).

### K10 · Le rapport du matin à l'écran
- Statut : fait (2026-11-02)
- Décidé (2026-11-02) : lu sur un appui, script à part ; sans rapport, un message neutre, sans prétendre à une raison. Relecture forte : 2 P1 corrigés ; Codex à sa limite, fusion sans lui (#281).
- Qui : Claude, voie 2 · Relecture : forte · Dépend de : K06, K08
- Cahier : M13, « Rapport du matin » ; R68, R13, R201.
- Objectif : l'agent lit son rapport du jour sur « Mes chiffres », la direction le sien sur « Le réseau », ligne par ligne, avec la période couverte ; le rapport d'un jour passé se relit.
- Critères : chacun ne lit que le sien, par la seule route du rapport [R68] (test) ; pas encore de rapport (avant 7 h 30, jour férié, week-end) dit en français, sans erreur (test) ; hors réseau et refus dits, session changée sans mélange (tests) ; script à part et budget tenus [R201] (test).
- Attend : rien.

### K11 · Commissions, encaissement et reversement pour la direction
- Statut : fait (2026-11-02)
- Décidé (2026-11-02), lecture prudente : la lecture dit `payment` et `cancelled`, une route `a-trancher` dit à la direction ce que le passage laisse de côté (raison lue au journal) ; le passage reprend l'étape « payée » après une coupure ; plus aucun encaissement ni nouveau versement sur une vente annulée par un avoir ; ce qui a déjà été versé se règle hors de l'écran avec le comptable.
- Qui : Claude, voie 2 · Relecture : forte · Dépend de : K10
- Cahier : M13, « Commissions », « Factures » ; R67, R69, R70, R16.
- Objectif : la direction voit chaque commission (statut, parts, dates) et ce qu'elle attend d'elle ; elle rapporte l'encaissement puis le versement avec la référence de sa preuve, en deux appuis, et lit l'échéance des 24 h ouvrées.
- Critères : aucun montant ne se saisit [R67] (test) ; les parts refont le total des honoraires à l'écran, un écart est dit [R69] (test) ; encaissement proposé seulement sur une commission facturée et versement seulement après encaissement [R67, R70] (tests) ; date future, preuve invalide, double geste dits en français (tests) ; un agent n'a pas cet écran [R16] (test).
- Attend : rien (H26 pour une vraie facture).

### K12 · Grille des commissions, budget de l'IA, factures émises et avoirs
- Statut : fait (2026-11-02)
- Décidé (2026-11-02), lecture prudente : deux lectures ajoutées, la grille (en vigueur, programmées, agents) et les réglages ; le formulaire part de la grille en vigueur et dit la dernière version vue, un écran périmé est refusé (`stale_grid`), pour ne perdre aucun taux en silence.
- Qui : Claude, voie 2 · Relecture : forte · Dépend de : K11
- Cahier : M13, « Commissions », « Factures », « Alertes » ; R16, R71, R69.
- Objectif : la direction règle une nouvelle version de la grille et ses seuils d'alerte, lit les factures émises, corrige une facture par un avoir avec sa raison, et télécharge l'export comptable d'une période.
- Critères : réservé à la direction [R16] (test) ; un avoir se confirme en deux appuis et ne change pas la facture [R71] (test) ; taux hors bornes et date passée dits en français (tests) ; l'export part avec la clé dans l'en-tête, jamais dans l'adresse [R13] (test) ; budget tenu [R201] (test).
- Attend : H26 pour une vraie facture.

### K13 · Le chemin de chaque euro (Jamais vu)
- Statut : fait (2026-11-02)
- Décidé (2026-11-02) : fait avant K12, qui en dépend moins ; les jours affichés sont ceux qui ont été signés (`compromisOn`, `signedOn`), jamais l'heure du passage.
- Qui : Claude, voie 2 · Relecture : forte · Dépend de : K11
- Cahier : M13, « Commissions », « La commission de l'agent est versée sous 24 h ouvrées » ; R68, R69, R70.
- Objectif : aucun réseau ne le montre : l'agent suit en direct où est son argent, dossier par dossier : ses parts, l'étape atteinte, le jour de l'encaissement, l'heure limite des 24 h ouvrées promises, et si la promesse a été tenue, avec son propre total recompté à l'écran. La réponse de `/pilotage/commissions` reçoit l'encaissement, l'échéance et le versement.
- Critères : un agent n'a que ses parts, jamais celles d'un autre ni les honoraires d'un dossier où il n'a qu'un partage [R68] (test) ; l'heure limite vient du serveur, jamais recalculée à l'écran [R70] (test) ; versement en retard et à l'heure dits (tests) ; le total refait la somme de ses lignes [R69] (test) ; aucun classement ni comparaison avec un autre agent [R14] (test).
- Attend : rien.

**M16 · La cession à l'écran.**

Voie : 2

Trouvé le 2026-11-02 par la voie 2 : l'écran « Commerces » lit les étapes de la cession, mais personne ne peut les faire avancer, ni suivre un repreneur, ni signer un engagement de confidentialité depuis le téléphone. Script à part, comme `/app/finances.js`. Les autres restes sont écrits sous « M13 · Les finances à l'écran ».

### CE12 · Cession à l'écran : dates, séquestre, acquéreur, étapes prêtes et demande de fonds
- Statut : fait (2026-11-02)
- Reste : fusionnée (#287) ; relecture forte 4 P1 corrigés ; Codex à sa limite (H03) ; vérification GitHub verte. `record` contrôle la forme de la preuve, pas sa présence au stockage ; `ceAct` (gestes de CE11) dit encore « rien n'est enregistré » hors réseau, à reprendre dans CE13.
- Décidé (2026-11-02), lecture prudente : le critère cite R110, mais la règle des étapes bloquantes est R116 : tests marqués [R116]. Le serveur refuse la signature tant que la cession n'est pas déclarée prête et sans étape manquante, sinon « empêche l'étape suivante » ne tiendrait que sur l'écran ; une signature déjà rangée reste corrigible. Preuve déposée par la route des offres (`/v1/offres/biens/<id>/fichiers/preuve`, `preuves/`, droits contrôlés), acquéreur choisi dans les contacts de l'agent, sans rien de présélectionné : aucun identifiant à saisir et aucun fichier du socle touché. Sans quoi la cession resterait bloquée : l'écran range aussi le nombre de salariés inconnu et, pour la direction, le périmètre de la commune.
- Qui : Claude, voie 2 · Relecture : forte · Dépend de : CE07, CE11
- Cahier : M16 Commerces et entreprises ; R16, R110, R201.
- Objectif : depuis la fiche d'un commerce, l'agent ouvre la cession et la fait avancer par les routes `/commerces/cessions/...` et `/commerces/taches-cession`, sans rien saisir de technique ; à lire au début : `packages/core/src/commerces/` et CE07.
- Critères : une étape bloquante empêche l'étape suivante, dite en français [R110] (test) ; seul l'agent du bien ou la direction agit [R16] (test) ; réponse perdue dite telle, succès gardé si la relecture échoue (tests) ; script à part, budget tenu [R201] (test).
- Attend : rien pour l'écran ; H38 pour les pièces réelles.

### CE13 · La fiche du commerce à l'écran et le barème de la direction
- Statut : fait (2026-11-02)
- Reste : fusionnée (#289) ; relecture forte sans P0/P1, 5 remarques corrigées ; Codex à sa limite (H03) ; vérification GitHub verte. `ceSame` compare les listes dans l'ordre ; le message de succès ne lit pas `created:false` ; le script approche du budget d'une page : CE14 et CE15 se chargeront à part.
- Décidé (2026-11-02) : barème saisi en % ou en multiple, rangé en centièmes ; ajout d'une lecture des barèmes en vigueur, sans laquelle la direction saisirait à l'aveugle.
- Trouvé le 2026-11-02 par la voie 2 : sans écran pour la fiche et le barème, aucune estimation ne se calcule et l'activité reste « à saisir » : tout M16 attend ces deux saisies.
- Qui : Claude, voie 2 · Relecture : forte · Dépend de : CE11
- Cahier : M16, « Fiche du commerce » ; R16, R110, R111, R17, R201.
- Objectif : l'agent du bien ou la direction complète la fiche (activité, enseigne, exercices, bail, salariés, matériel, autorisations) par une lecture faite à la demande ; la direction range le barème par activité et lit celui en vigueur. Un geste CE11 dont la réponse se perd ne dit plus que rien n'est enregistré.
- Critères : seuls les champs changés partent, une nouvelle version s'ajoute [R17] (test) ; la conformité n'a pas le formulaire, aucun chiffre n'est lu avant le geste [R110, R16] (tests) ; montants saisis en euros, jamais en centimes, valeur illisible dite sans rien envoyer (tests) ; barème réservé à la direction, source et date exigées [R111, R16] (tests) ; réponse perdue dite telle [R10] (test) ; budget tenu [R201] (test).
- Attend : rien.

### CE14 · Demandes et engagement de confidentialité à l'écran
- Statut : fait (2026-11-03)
- Décidé (2026-11-02), lecture prudente : le repreneur doit lire ce qu'il signe : ajout d'une lecture du texte de l'engagement, et le code n'est retenu que si son empreinte est celle du texte lu. L'état de chaque demande rend l'engagement en vigueur. Révoqué, une nouvelle demande fait un nouvel engagement. Script à part, chargé au premier geste.
- Reste : fusionnée (#291) ; relecture forte 2 P1 corrigés ; Codex à sa limite (H03) ; vérification GitHub verte. Ranger une demande n'envoie rien au repreneur et l'écran le dit, alors que le cahier veut une réponse immédiate avec les informations publiques : CE16. En mode essai, le code reste dans la boîte d'essai, qu'aucun écran ne lit (comme pour le bail) : la signature à l'écran ne s'essaie de bout en bout qu'après H05. Le mail du code dit « pas même à votre agent » alors que l'agent saisit le code sur son écran : à trancher avec H24, avant tout envoi réel.
- Qui : Claude, voie 2 · Relecture : forte · Dépend de : CE13
- Cahier : M16, « Engagement de confidentialité » ; R110, R113, R16, R26, R201.
- Objectif : l'agent range la demande d'un contact, ouvre la signature avec l'accord noté, recueille le code et le tracé, révoque un engagement ; la direction range le modèle.
- Critères : un engagement modifié ou révoqué ferme la porte, dit en français [R113] (test) ; le code part par le contrôle central, en mode essai [R26] (test) ; budget tenu [R201] (test).
- Attend : rien pour l'écran.

### CE15 · Repreneurs et rapprochement à l'écran
- Statut : fait (2026-11-03)
- Reste : fusionnée (#292) ; relecture forte 1 P1 corrigé (test d'ordre) ; Codex à sa limite (H03) ; vérification GitHub verte.
- Décidé (2026-11-02), lecture prudente : ajout d'une liste des projets de reprise, sans laquelle l'agent n'atteint aucun profil : dans l'ordre d'arrivée, prénom et jour seuls [R14] ; pris dans les fiches que le lecteur voit, donc sans refus au journal. Rien n'est lu avant le geste, le rapprochement écrit au journal à chaque lecture. Script à part, comme CE14.
- Qui : Claude, voie 2 · Relecture : forte · Dépend de : CE14
- Cahier : M16, repreneurs ; R115, R14, R16, R201.
- Objectif : l'agent complète le profil de repreneur d'un projet d'achat et lit les commerces rapprochés, sans score ni classement.
- Critères : seuls les commerces diffusables, sans chiffre confidentiel [R110, R115] (test) ; aucun classement [R14] (test) ; budget tenu [R201] (test).
- Attend : rien.

### CE16 · Réponse immédiate au repreneur : les informations publiques
- Statut : fait (2026-11-03)
- Reste : fusionnée (#293) ; relecture forte 3 P1 corrigés ; Codex à sa limite (H03) ; vérification GitHub verte.
- Décidé (2026-11-02), lecture prudente : seule la présentation validée et publiable part, rien sans elle ; il faut une demande rangée, un bien diffusable [R42] et un accord ; un accord retiré ne se redonne pas par la parole de l'agent, tant que H42 n'est pas tranché ; une seule fois par commerce [R05].
- Trouvé le 2026-11-02 par la relecture de CE14 : `requestAccess` rend la vue publique à l'agent, rien ne part au repreneur.
- Qui : Claude, voie 2 · Relecture : forte · Dépend de : CE14
- Cahier : M16, « Accès aux chiffres » ; R110, R03, R26, R201.
- Objectif : à la demande, l'agent lit la vue publique et la présentation publiable, et les fait partir au repreneur par le contrôle central.
- Critères : seule la vue publique et la présentation validée, jamais un chiffre [R110] (test) ; aucun envoi sans accord en cours, en mode essai [R03, R26] (tests) ; réponse perdue dite telle [R10] (test) ; budget tenu [R201] (test).
- Attend : rien pour l'écran.

**M15 · La fin de la location à l'écran.**

Voie : 2

Trouvé le 2026-11-03 par la voie 2, en comparant les routes de `packages/api/src/location.ts` aux appels de `packages/api/app/louer.ts`. Vérifier d'abord chaque route, le comparatif étant rapide. Script à part, comme `/app/commerces-repreneurs.js`, chargé au premier geste.

### W16 · Remise des clés et gestion par un partenaire à l'écran
- Statut : fait (2026-11-03)
- Qui : Claude, voie 2 · Relecture : forte · Dépend de : W08, W11
- Cahier : M15 Louer ; R107, R108, R73, R74, R16, R201.
- Objectif : depuis la location, l'agent range la remise des clés, lit les honoraires dus, et confie la gestion à un partenaire carte G, par les routes `/location/<id>/remise-des-cles` et `/location/<id>/gestion`.
- Critères : la remise lit la signature réelle du bail, jamais celle d'essai, dit en français [R108] (test) ; seul l'agent du bien ou la direction agit [R16] (test) ; réponse perdue dite telle [R10] (test) ; script à part, budget tenu [R201] (test).
- Attend : rien pour l'écran ; H24 pour une signature réelle.
- Décidé (2026-11-03) : route de lecture `GET /location/<id>/remise-des-cles` ajoutée, l'agent choisit un gestionnaire nommé, jamais une référence ; le formulaire de l'état des lieux servi à part (`/app/louer-edl.js`) pour tenir le budget ; le rail dit « Bail · signé en essai ». La remise réelle reste fermée tant que H08 et H24 ne sont pas faits. Le critère cite R10 pour la réponse perdue, alors que R10 parle des chiffres. Relecture forte : 3 P1 corrigés ; relecture de Codex en échec, fusion sans elle (#296).

### W17 · Modèles de bail de la direction à l'écran
- Statut : fait (2026-11-03)
- Qui : Claude, voie 2 · Relecture : forte · Dépend de : W11
- Cahier : M15 Louer ; R16, R17, R201.
- Objectif : la direction lit le modèle en vigueur, range une nouvelle version et la valide, par les routes `/location/modeles-bail`.
- Critères : réservé à la direction [R16] (test) ; une nouvelle version s'ajoute, l'ancienne reste [R17] (test) ; un modèle non validé est dit d'essai (test) ; budget tenu [R201] (test).
- Attend : rien pour l'écran ; H08 pour un modèle réel.
- Décidé (2026-11-03) : l'objectif disait « la direction la valide », le code réserve déjà la validation à la conformité (H08, test existant) : la direction lit et range depuis l'écran du réseau, la conformité lit et valide depuis le sien, en deux appuis. Route de lecture `GET /location/modeles-bail` ajoutée. Relecture forte : 3 P1 corrigés ; Codex à sa limite, fusion sans lui (#298).

**M20 · La mesure à l'écran.**

Voie : 1

Trouvé le 2026-11-03 par la voie 1, en comparant les routes de `packages/api/src/gagner.ts` aux appels de `packages/api/app/gagner.ts` : la mesure mensuelle (G10) et les engagements (G07) n'ont aucun geste à l'écran, et aucun coût ne peut être saisi faute de route pour déposer sa preuve. Ce qui reste à la voie 1 attend un humain (B03, B04, C09) : pris ici pour que le chantier continue. Script à part, comme `/app/reglages-mandat.js`.

### G14 · Mesure des sources à l'écran, preuve du coût déposée
- Statut : fait (2026-11-03)
- Reste : fusionnée (#297). Relecture forte sans P0 ni P1 ; Codex à sa limite (H03). Non bloquant, noté par la relecture : `enterCost` (G10) accepte toute référence existante du stockage.
- Qui : Claude, voie 1 · Relecture : forte · Dépend de : G10, G11
- Cahier : M20, point 7 « Mesure » ; R144, R13, R16, R201.
- Objectif : sur l'écran du réseau, la direction choisit un mois, lit par source mandats, rendez-vous, coût et coût par mandat, dépose la preuve et saisit le coût, décide de garder ou d'arrêter une source. Route ajoutée : `POST /v1/gagner/mesure/preuves` (PDF, JPEG ou PNG), la référence est choisie par le serveur.
- Critères : un fichier d'un autre format, trop lourd, ou sans stockage est refusé sans rien ranger (test) ; seule la direction dépose, lit et décide [R16] (test) ; le journal ne garde ni le nom du fichier ni sa référence [R13] (test) ; l'écran garde l'ordre reçu, ne recommande rien et n'a aucune décision sans appui [R144] (test) ; montant lu sans erreur d'arrondi (test) ; réponse perdue dite telle (test) ; budget tenu [R201] (test).
- Attend : rien pour l'écran ; H25 (`PIECES`) pour déposer une preuve réelle.

### G15 · Engagements de service et fin de bail à l'écran
- Statut : fait (2026-11-03)
- Décidé (2026-11-03) : la dernière fin de bail notée fait foi, au lieu de la plus proche : une erreur de saisie se corrige sans rien effacer [R17]. Deux lectures ajoutées. Reste : fusionnée (#300). Relecture forte 3 P1 corrigés ; Codex à sa limite (H03).
- Qui : Claude, voie 1 · Relecture : forte · Dépend de : G07, G09
- Cahier : M20, dossier de présentation et anciens contacts ; R16, R143, R201.
- Objectif : la direction règle ses engagements de service (`POST /v1/gagner/engagements`), sans quoi le dossier de présentation les dit absents ; l'agent note une fin de bail connue sur la fiche (`POST /v1/gagner/fiches/<id>/fin-de-bail`), sans quoi cette raison de relance reste vide.
- Critères : réservé au rôle de chaque route [R16] (test) ; refus dits en français (test) ; réponse perdue dite telle [R10] (test) ; budget tenu [R201] (test).
- Attend : rien.

**M18 · L'annuaire et la prospection à l'écran.**

Voie : 1

Trouvé le 2026-11-03 par la voie 1, en comparant les routes de `packages/api/src/partenaires.ts` aux appels de l'application : aucun partenaire ne peut être rangé depuis l'écran, et aucune route ne dépose la preuve d'un justificatif, si bien qu'aucun partenaire ne peut devenir proposable en réel.

### U13 · Annuaire des partenaires à l'écran, preuve du justificatif déposée
- Statut : fait (2026-11-03)
- Reste : fusionnée (#299). Relecture forte sans P0 ni P1 ; Codex à sa limite (H03).
- Qui : Claude, voie 1 · Relecture : forte · Dépend de : U01, U10, U12
- Cahier : M18 Partenaires ; R73, R13, R14, R16, R03, R201.
- Objectif : sur l'écran du réseau, la direction cherche par métier et code postal, ajoute un partenaire, ses zones et ses justificatifs (fichier de preuve déposé, référence choisie par le serveur), lit pourquoi il n'est pas proposable, range son adresse professionnelle et son accord, note son opposition.
- Critères : le dépôt refuse un autre format, un fichier trop lourd, un partenaire d'un autre réseau, sans rien ranger (test) ; un agent ne range pas d'adresse [R16, R03] (test) ; le journal ne garde ni nom, ni numéro, ni référence [R13] (test) ; l'écran ne montre ni note ni rang et garde l'ordre reçu [R14, R73] (test) ; réponse perdue dite telle [R10] (test) ; budget tenu [R201] (test).
- Attend : rien pour l'écran ; `PIECES` (H25) pour une preuve réelle.

### U14 · Prospection des partenaires à l'écran
- Statut : fait (2026-11-03)
- Reste : fusionnée (#303). Relecture forte sans P0 ni P1 ; Codex à sa limite (H03).
- Qui : Claude, voie 1 · Relecture : forte · Dépend de : U13
- Cahier : M18 ; R03, R79, R16, R201.
- Objectif : la direction ajoute un contact professionnel, lit la liste, note une opposition et lit les brouillons du jour, tous refusés tant que H32 n'est pas tranché, ce que l'écran dit.
- Critères : réservé à la direction [R16] (test) ; aucun envoi, et le refus sous R03 est dit [R03, R79] (test) ; réponse perdue dite telle [R10] (test) ; budget tenu [R201] (test).
- Attend : rien pour l'écran ; H32 pour un envoi réel.

**M19 · La bibliothèque à l'écran.**

Voie : 1

### X13 · Bibliothèque, options payantes et mesure des visuels à l'écran
- Statut : fait (2026-11-03)
- Décidé (2026-11-03) : `/v1/studio/options` n'a aucun réglage, c'est une mise en relation d'un projet aux rôles agent et direction : son geste est sur le formulaire des partenaires. Route ajoutée `POST /v1/studio/bibliotheque/preuves`, aucune preuve ne pouvait être déposée. Fusionnée (#304). Relecture forte 2 P1 corrigés ; Codex à sa limite (H03).
- Qui : Claude, voie 1 · Relecture : forte · Dépend de : X07, X08, X09
- Cahier : M19 Studio ; R16, R201.
- Objectif : la direction range musiques et images sous licence, règle les options et lit la mesure des 20 visuels ; aujourd'hui `/v1/studio/bibliotheque`, `/options` et `/mesure-visuels` n'ont aucun geste à l'écran. Lire d'abord chaque route.
- Critères : réservé à la direction [R16] (test) ; une licence manquante est refusée et dite (test) ; réponse perdue dite telle [R10] (test) ; budget tenu [R201] (test).
- Attend : rien pour l'écran.

### X14 · Les gestes des partenaires : réponse perdue dite telle, un seul tirage
- Statut : fait (2026-11-03)
- Reste : fusionnée (#306). Relecture forte 2 P1 corrigés ; Codex à sa limite (H03). Le texte « Pas de réseau : rien n'est enregistré. » existe sur d'autres écrans, non audités.
- Trouvé le 2026-11-03 par la relecture forte de X13 : `partAct` dit « rien n'est enregistré » quand la réponse se perd, alors que l'écriture a pu passer, et ne se verrouille pas ; refaire un tirage crée une seconde mise en relation, avec un nouvel ordre.
- Qui : Claude, voie 1 · Relecture : forte · Dépend de : X13
- Cahier : M18 ; R10, R74, R201.
- Objectif : tous les gestes de l'écran des partenaires passent par un même envoi : une réponse perdue ou une panne dit « rien n'est sûr » et ne relit rien, un second appui pendant l'envoi ne part pas.
- Critères : coupure, panne et réponse illisible dites telles, sur le tirage et les autres gestes [R10] (test) ; double appui, un seul envoi [R74] (test) ; le verrou vaut pour une session (test) ; budget tenu [R201] (test).
- Attend : rien.

**Gestes sans écran, pour la voie 1.**

Trouvé le 2026-11-03 par la voie 2, même comparaison, à vérifier route par route avant de coder : `POST` du socle (`app.ts`) sans appel de l'application.

### CE17 · Retrouver la source d'une fuite d'un dossier protégé, à l'écran
- Statut : fait (2026-11-03)
- Reste : fusionnée (#318). Geste placé dans le script déjà servi `commerces-engagements`, sans toucher au socle. Relecture forte 4 P1 corrigés ; Codex à sa limite (H03).
- Qui : Claude, voie 2 · Relecture : forte · Dépend de : CE11
- Cahier : M16 ; R16, R13, R201.
- Objectif : trouvé le 2026-11-03, même comparaison : `POST /v1/commerces/<id>/tracage` n'a aucun appel de l'application. Lire `dossier.trace` et son écran ; vérifier que le geste n'existe pas ailleurs, puis le donner dans `app/commerces*.ts`, sans toucher au socle.
- Critères : seuls les rôles de la route agissent [R16] (test) ; ni nom ni contenu du texte collé au journal [R13] (test) ; résultat incertain dit tel [R10] (test) ; réponse perdue dite telle (test) ; budget tenu [R201] (test).
- Attend : rien.

### CE18 · Retirer un lien de dossier protégé, à l'écran
- Statut : fait (2026-11-03)
- Décidé (2026-11-03) : route ajoutée `GET /v1/commerces/<id>/liens`, aucune route ne listait les liens et un lien jamais ouvert ne pouvait pas se retrouver ; état `porte_fermee` calculé par la porte de l'ouverture, sans écrire de refus au journal. Fusionnée (#319). Relecture forte 4 P1 corrigés ; Codex à sa limite (H03).
- Qui : Claude, voie 2 · Relecture : forte · Dépend de : CE11
- Cahier : M16 ; R16, R201.
- Objectif : trouvé le 2026-11-03 par la voie 1, même comparaison : `POST /v1/commerces/liens/<id>/revocation` n'a aucun appel de l'application. Vérifier que le geste n'existe pas ailleurs, puis le donner dans `app/commerces*.ts`, sans toucher au socle.
- Critères : seuls les rôles de la route agissent [R16] (test) ; un lien retiré est dit tel, deux appuis avant de retirer (test) ; réponse perdue dite telle (test) ; budget tenu [R201] (test).
- Attend : rien.

### X16 · Rétractation et début anticipé d'un mandat à l'écran
- Statut : fait (2026-11-03)
- Reste : faite par D16 : vérifié route par route, les deux gestes et leurs tests sont dans `app/mandat.ts` et `mandat-app.test.ts`.
- Qui : Claude, voie 1 · Relecture : forte · Dépend de : D03
- Cahier : M06 ; R16, R201.
- Objectif : `mandat.retractation` et `mandat.debut_anticipe` n'ont aucun geste à l'écran. Lire d'abord les routes et le fichier `app/mandat.ts`.
- Critères : seul l'agent du mandat ou la direction agit [R16] (test) ; preuve exigée quand la route l'exige (test) ; réponse perdue dite telle (test) ; budget tenu [R201] (test).
- Attend : rien.

### X17 · Signature en ligne, avenant et identité à l'écran
- Statut : bloquée : la signature en ligne attend H24 ; D12 a pour critère, testé, qu'elle reste absente de l'écran tant que l'avocat ne l'a pas validée, et X17 contredit ce critère
- Décidé (2026-11-03), lecture prudente (`SECOURS.md`) : rien n'est livré, le test de D12 (`la signature en ligne n’existe pas sur cet écran tant que l’avocat ne l’a pas validée`) reste tel quel. Le geste écrit puis retiré aurait aussi été une impasse : seul un document au modèle validé passe le contrôle, il aurait noté un accord sur une vraie fiche, et le code resté dans la boîte d'essai n'arrive à personne. La signature d'un avenant est déjà à l'écran (D17). `fiche.identite` ne reçoit aucun geste : le contrôle lit le coffre, jamais cette note [R92], et un bouton « identité vérifiée » laisserait croire que le contrôle passera. À reprendre à H24 et H05, en retirant alors le test de D12.
- Qui : Claude, voie 1 · Relecture : forte · Dépend de : D08
- Cahier : M06 ; R16, R201.
- Objectif : `document.signature_en_ligne`, `document.signature_avenant` et `fiche.identite` n'ont aucun appel de l'application. Vérifier si le geste existe sous une autre forme ; sinon le donner, en essai.
- Critères : aucun envoi réel en essai [R26] (test) ; droits refusés dits [R16] (test) ; réponse perdue dite telle (test) ; budget tenu [R201] (test).
- Attend : H24 pour un usage réel.

**Gestes sans écran, trouvés par la voie 1 le 2026-11-03 (même comparaison, route par route).**

### X18 · Corriger le texte d'une annonce à l'écran
- Statut : fait (2026-11-03)
- Reste : fusionnée (#320) ; relecture forte 3 P1 corrigés (retrait d'une annonce validée dit avant d'enregistrer, réponse perdue dite aussi sur panne et corps coupé, un seul geste pendant l'envoi) ; Codex à sa limite (H03) ; quitter l'écran pendant l'envoi puis revenir après un refus repart de l'annonce rangée, le texte tapé est perdu sans faux état.
- Qui : Claude, voie 1 · Relecture : forte · Dépend de : P10
- Cahier : M07 ; R47, R16, R201.
- Objectif : `POST /v1/annonces/<id>/correction` n'a aucun appel de l'application : l'écran « Mettre en vente » dit « corrigez-la » sans donner de quoi corriger. Le donner dans `app/fichiers.ts`, sans toucher au socle.
- Critères : le texte en cours pré-rempli, envoyé tel quel (test) ; une correction refusée montre chaque phrase en cause et son problème, et garde ce qui est tapé (test) ; un texte vide n'est pas envoyé (test) ; droits refusés dits [R16] (test) ; réponse perdue dite telle, le texte reste (test) ; un seul envoi à la fois (test) ; budget tenu [R201] (test).
- Attend : rien.

### X19 · Remplir la fiche du bien à l'écran
- Statut : fait (2026-11-03)
- Qui : Claude, voie 1 · Relecture : forte · Dépend de : P10
- Cahier : M07 ; R10, R17, R43, R47, R16, R201.
- Objectif : `GET` et `POST /v1/annonces/<id>/fiche` n'avaient aucun appel de l'application, alors que l'écran dit « complétez la fiche du bien ».
- Critères : dernière version pré-remplie, 0 reste 0, photos renvoyées telles quelles (test) ; champ vide = « je ne sais pas », nombre mal écrit nommé et non envoyé [R10] (test) ; sans changement, aucune version (test) ; fiche changée entre-temps : rien n'est écrasé, par `?siVersion=` (test) ; retrait dit avant d'enregistrer, annonce validée sur une ancienne fiche plus dite validée [R47] (test) ; droits refusés dits [R16] (test) ; réponse perdue dite telle (test) ; budget tenu [R201] (test).
- Reste : fusionnée (#321) ; relecture forte 2 P1 corrigés ; Codex à sa limite (H03).

### X20 · La commune d'un bien pour le calcul investisseur, à l'écran
- Statut : fait (2026-11-03)
- Reste : fusionnée (#322) ; le socle change, contre le texte d'origine : `GET /v1/investir/biens/sans-commune`, commune refusée hors du département du bien ou sur un bien qui n'est pas un logement ; relecture forte 5 P1 corrigés ; Codex à sa limite (H03) ; un code du bon département mais de la mauvaise commune reste possible (pas de table des communes dans le dépôt), l'écran prévient seulement.
- Qui : Claude, voie 1 · Relecture : forte · Dépend de : Y04
- Cahier : M17 ; R122, R16, R201.
- Objectif : `POST /v1/investir/biens/<id>/commune` n'a aucun appel de l'application, et `/v1/investir/biens` ne rend que les biens dont la commune est rangée : à l'écran, aucun bien n'est jamais calculable. Le donner dans `app/investir.ts`, sans toucher au socle.
- Critères : seuls les biens de la personne et sans commune sont proposés (test) ; rien n'est choisi d'avance (test) ; rangée une fois, sans retour : c'est dit, en deux appuis (test) ; code mal écrit non envoyé (test) ; chaque refus du socle dit en français [R16] (test) ; réponse perdue dite telle (test) ; une liste non lue n'est jamais dite vide (test) ; budget tenu [R201] (test).
- Attend : rien.

### X21 · La zone de loyer d'une commune, à l'écran du réseau
- Statut : fait (2026-11-03)
- Reste : fusionnée (#323) ; route de lecture ajoutée, `GET /v1/location/zones?insee=`, direction seule ; relecture forte 5 P1 corrigés ; Codex à sa limite (H03) ; une zone fausse datée du jour décide jusqu'au lendemain, la table ne se réécrit pas.
- Qui : Claude, voie 1 · Relecture : forte · Dépend de : W03
- Cahier : M15 ; R16, R10, R201.
- Objectif : `POST /v1/location/zones` n'a aucun appel de l'application : sans lui, chaque commune reste « zone inconnue » et le plafond le plus bas s'applique. Vérifier que le geste n'existe pas ailleurs, puis le donner à la direction sur l'écran du réseau.
- Critères : direction seule [R16] (test) ; source et date exigées [R10] (test) ; réponse perdue dite telle (test) ; budget tenu [R201] (test).
- Attend : rien.

### X22 · Recommander un proche depuis la fiche, à l'écran
- Statut : fait (2026-11-03)
- Qui : Claude, voie 1 · Relecture : forte · Dépend de : A07
- Cahier : M11 ; R16, R201.
- Objectif : `POST /v1/apres-vente/fiches/<id>/recommandations` n'a aucun appel de l'application. Vérifier d'abord à quoi sert cette route et si le geste existe sous une autre forme ; sinon le donner, avec sa clé d'idempotence.
- Critères : droits refusés dits [R16] (test) ; réponse perdue dite telle, renvoi avec la même clé, sans doublon (test) ; preuve exigée quand la case est cochée [R03, R142] (test) ; budget tenu [R201] (test).
- Décidé (2026-11-03), lecture prudente : le texte ne dépend que de la saisie, jamais du proche [R16] ; une clé sans réponse depuis 2 minutes est remplacée, le socle refusant de ranger deux fois le même proche pour un client. Relecture forte : 4 P1 corrigés ; Codex non attendu (H03) ; #325.
- À savoir (lu le 2026-11-03) : la route exige l'en-tête `Idempotency-Key`, que `send` de l'application ne sait pas poser : `api` et `send` sont à étendre ; elle crée une fiche et un accord par téléphone à partir d'une preuve [R03, R142] : relecture forte attentive ; bloc à poser sur la fiche, chargé au premier geste, sur le modèle de `app/fin-de-bail.ts`.
- Attend : rien.


### X23 · La direction valide le guide photo d'un bien, à l'écran
- Statut : fait (2026-11-03)
- Qui : Claude, voie 1 · Relecture : forte · Dépend de : X11
- Cahier : M19 ; R10, R16, R17, R201.
- Objectif : trouvé le 2026-11-03 par la voie 1, même comparaison : `POST /v1/studio/biens/<id>/guide/validation` n'a aucun appel de l'application, alors que l'écran du Studio dit « prêt pour la validation de la direction », et la direction n'ouvre jamais le Studio. Donner une liste des guides prêts à valider, nouvelle lecture réservée à la direction, et le geste, sur l'écran du réseau, chargé au premier geste.
- Critères : seule la direction lit et valide [R16] (test) ; un guide déjà validé ou pas prêt n'est pas dans la liste (test) ; photos changées après validation : le guide revient à valider (test) ; réponse perdue dite telle, sans doublon (test) ; budget tenu [R201] (test).
- Décidé (2026-11-03), lecture prudente : le prêt ne se lit qu'en recalculant, et un guide validé garde sa place : lecture bornée, reprise par `next`, aucun bien hors d'atteinte. Relecture forte : 2 P1 corrigés ; Codex non attendu (H03) ; #328.
- Reste : la direction lit la liste des vues, pas les photos : `/medias/` ne sert que les versions publiées, montrer les photos demande une lecture protégée.
- Attend : rien.

### X24 · Le partenaire recommande un proche depuis son espace
- Statut : fait (2026-11-03)
- Qui : Claude, voie 1 · Relecture : forte · Dépend de : G08
- Cahier : M20, M18 ; R03, R16, R142, R201.
- Objectif : trouvé le 2026-11-03 par la voie 1, même comparaison : la route de recommandation réservée au partenaire et `GET /v1/gagner/recommandations/mes-envois` n'ont aucun appel de `app/partenaire.ts`. Vérifier la route, puis donner le formulaire et la liste de ses envois dans l'espace du partenaire.
- Critères : preuve de l'accord exigée [R142] (test) ; réponse perdue dite telle, la liste relue, un renvoi ne fait qu'une recommandation (test) ; rien sur le suivi de la personne [R16, R77] (test) ; toute sortie vide la page [R13] (test) ; budget tenu [R201] (test).
- Décidé (2026-11-03), lecture prudente : les envois ne disent qu'une date ; l'accord du jour vaut le début de la journée de l'appareil, qui peut avancer sur le serveur ; toute sortie passe par une seule fonction qui vide la page. Relecture forte : 4 P1 corrigés, X25 trouvée ; Codex non attendu (H03) ; #330.
- Attend : rien.

### X25 · Une recommandation de partenaire sûre au renvoi
- Statut : fait (2026-11-03)
- Qui : Claude, voie 1 · Relecture : forte · Dépend de : X24
- Cahier : M20 ; R142, R17.
- Objectif : trouvé par la relecture forte de X24 : `RecommandationsGagner.recommend` n'est pas en transaction. Une panne entre le projet et la ligne de recommandation laisse la fiche sans recommandation, et un renvoi crée un second projet, une seconde source et un second accord. Fermer ce trou sans changer la réponse donnée au partenaire [R77].
- Critères : une panne à chaque écriture, puis un renvoi : une seule recommandation, un seul projet, un seul accord (test) ; le renvoi ordinaire reste muet et ajoute sa date aux envois (test).
- Décidé (2026-11-03), lecture prudente : une fiche neuve passe dans le lot avec ses coordonnées ; une panne du journal après le lot laisse la recommandation rangée et l'appel à faire, sans réécrire ses événements au renvoi (test), car la file d'appels lit la table. Reste ouvert : deux envois simultanés de la même personne gardent un projet et un accord de trop, comme avant X25 : X26.
- Reste : relecture forte 3 P1 corrigés ; Codex non attendu (H03) ; #331.
- Attend : rien.

### X26 · Deux envois simultanés d'une même recommandation de partenaire
- Statut : fait (2026-11-03)
- Décidé (2026-11-03), lecture prudente : le lot perdant est annulé en entier (plus d'`ON CONFLICT` hors « tenue à l'écart ») ; sur une fiche neuve, une garde en tête de lot, table toujours vide, l'annule si une coordonnée vient d'arriver sur une fiche ; le perdant est rejoué une fois comme un renvoi, une vraie panne jamais. Reste : trois envois simultanés peuvent faire perdre deux fois (erreur, rien de gardé, un renvoi passe) ; garde essayée sur SQLite, pas sur une vraie base D1. Relecture forte 2 P1 corrigés ; Codex non attendu (H03) ; #333.
- Qui : Claude, voie 1 · Relecture : forte · Dépend de : X25
- Cahier : M20 ; R142, R17.
- Objectif : trouvé par la relecture forte de X25 : dans `recommend`, deux envois simultanés passent le contrôle préalable ; le perdant du `ON CONFLICT` garde quand même son projet, sa source et son accord dans le même lot. Les rendre conditionnels à la ligne de recommandation, ou la poser d'abord.
- Critères : deux envois au même instant : un seul projet, une seule source, un seul accord (test, course provoquée) ; réponse identique aux deux [R77] (test).
- Attend : rien.
### CE19 · Corriger la présentation d'un commerce, à l'écran
- Statut : fait (2026-11-03)
- Reste : fusionnée (#324) ; relecture forte 1 P1 corrigé ; Codex non attendu (H03).
- Qui : Claude, voie 2 · Relecture : forte · Dépend de : CE11
- Cahier : M16 ; R16, R110, R201.
- Objectif : trouvé le 2026-11-03 par la voie 1, même comparaison : `POST /v1/commerces/<id>/presentations/texte` n'a aucun appel de l'application. Le donner dans `app/commerces*.ts`, sans toucher au socle.
- Décidé (2026-11-03) : tâche coupée en deux (`SECOURS.md`) : le document du dossier passe en CE20, car sa route attend une référence de stockage que personne ne peut produire aujourd'hui, un champ à taper aurait été une impasse. Script servi à part (`app/commerces-textes.ts`) : le script de l'écran passait au-dessus de son budget [R201].
- Critères : seuls ceux qui écrivent ont le geste [R16] (test) ; texte en cours pré-rempli, sans changement rien ne part (test) ; un texte refusé reste à l'écran, chaque phrase en cause dite [R110] (test) ; présentation validée : l'annulation de la validation dite avant de ranger (test) ; chaque refus du socle dit en français (test) ; réponse perdue dite telle (test) ; un seul envoi à la fois (test) ; budget tenu [R201] (test).
- Attend : rien.

### CE21 · Les alertes de cession, lues et décidées par le responsable de la conformité
- Statut : fait (2026-11-03)
- Reste : fusionnée (#327) ; relecture forte 1 P1 corrigé ; ce qui manque est dit à la levée de l'alerte, l'état actuel du coffre n'est pas relu ; Codex non attendu (H03).
- Qui : Claude, voie 2 · Relecture : forte · Dépend de : CE08, L10
- Cahier : M16, M12 ; R14, R15, R16, R17, R118, R201.
- Objectif : trouvé le 2026-11-03 par la voie 2, en comparant les routes aux appels de l'écran : `GET /v1/commerces/vigilance` et sa décision n'ont aucun appel de l'application, et CE08 renvoyait au branchement une liste que CE10 n'a pas faite. R118 est dite en service, mais le responsable n'a aucun moyen de voir ces alertes. Les donner sur son écran, sans changer le code de CE08.
- Critères : l'alerte dit ce qui manque et la fin de la référence, jamais une pièce ni un montant [R15] (test) ; le résumé la compte, une lecture manquée n'est jamais zéro [R10] (test) ; décision avec raison et nom [R14] (test) ; déjà décidée : relue, pas refusée [R17] (test) ; réponse perdue dite telle (test) ; un seul envoi (test) ; budget tenu [R201] (test).
- Attend : H29 pour un usage réel (responsable nommé).

### W25 · Lire l'exemplaire signé de l'état des lieux
- Statut : fait (2026-11-03)
- Reste : fusionnée (#329) ; relecture forte 3 P1 corrigés, corrections non relues une seconde fois ; Codex non attendu (H03).
- Qui : Claude, voie 2 · Relecture : forte · Dépend de : W07, W11
- Cahier : M15 ; R16, R106, R201.
- Objectif : trouvé le 2026-11-03 par la voie 2, même comparaison : l'écran dit « un exemplaire pour chacun », mais `GET /v1/location/etats-des-lieux/<id>/exemplaires/<partie>` n'a aucun appel de l'application et le suivi ne rend pas l'identifiant. Le donner, lu seulement au geste.
- Décidé (2026-11-03), lecture prudente : la route rendait l'identité des deux parties sous le seul droit sur le logement ; comme le bail et l'état des lieux en cours, le lecteur doit voir les deux fiches en entier, et la lecture va au journal [R16].
- Critères : rien n'est lu avant le geste (test) ; exemplaire hors des droits dit, sans texte [R16] (test) ; lecture au journal (test) ; pas de réseau dit, le geste reste (test) ; budget tenu [R201] (test).
- Attend : rien.

### CE22 · Brancher le dépôt des documents du dossier sur le stockage réel
- Statut : fait (2026-11-03)
- Reste : fusionnée (#335) ; relecture forte 2 P1 : test du lecteur ajouté, liaison perdue au déploiement confiée à X27 ; marque d'ordre gardée à la relecture ; un caractère isolé invalide ne se relit pas à l'identique, non traité ; jamais essayé sur un vrai compartiment ; Codex non attendu (H03).
- Qui : Claude, voie 1 · Relecture : forte · Dépend de : CE20
- Cahier : M16 ; R16, R114.
- Objectif : `worker.ts` ne passe aucun `storage` à M16 : le dossier ne sert que la fiche, et CE20 répond `stockage_absent`. Avec le compartiment de H38, passer un `DossierStorage` qui lit et écrit du texte ; absent, rien ne change.
- Critères : avec le compartiment, un texte déposé se relit à l'identique (test) ; sans lui, `stockage_absent` reste dit (test).
- Attend : H38 pour un usage réel, rien pour le code.

### X27 · Les compartiments R2 restent liés après un déploiement
- Statut : fait (2026-11-03)
- Décidé (2026-11-03), lecture prudente : noms de compartiments fixes (`aimmo-pieces`, `aimmo-medias`, `aimmo-coffre`, `aimmo-commerces`) ; liste illisible : la mise en ligne continue sans liaison et le résumé le dit, plutôt que de bloquer tout le socle, à revoir une fois des documents rangés. Reste : une liaison à la main sous un autre nom est perdue ; jamais joué sur un vrai runner ni un vrai compartiment. Relecture forte 2 P1 corrigés ; Codex non attendu (H03) ; #337.
- Qui : Claude, voie 1 · Relecture : forte · Dépend de : CE22
- Cahier : Architecture technique ; R17.
- Objectif : trouvé par la relecture forte de CE22 : `wrangler.toml` ne déclare aucun `[[r2_buckets]]`, et d'après le code de wrangler, `wrangler deploy` retire une liaison posée à la main dans Cloudflare : `PIECES`, `MEDIA`, `COFFRE` et `COMMERCES` disparaîtraient au déploiement suivant, et leurs documents deviendraient indisponibles. Déclarer au déploiement la liaison de chaque compartiment qui existe, et seulement de ceux-là, car une liaison vers un compartiment absent ferait échouer la mise en ligne.
- Critères : compartiment existant lié, absent non lié (test) ; le fichier de configuration garde le reste (test) ; liste illisible : la mise en ligne continue, sans liaison, et le dit dans le résumé du travail (test) ; le coffre reste sur son propre compartiment [L09] (test).
- Attend : un jeton Cloudflare qui lit la liste des compartiments, pour un usage réel (H45).

### X28 · Les vérifications tiennent dans leur délai
- Statut : fait (2026-11-03)
- Décidé (2026-11-03) : délai de 25 minutes pour les vérifications et le déploiement, durée la plus longue 15,5 min sur 100 exécutions, écrite dans `scripts/controle-verifications.mjs`, à relever quand la suite grandit ; attente de séance 30 minutes. Mesuré : 3 679 tests, 536 s cumulées, 14 tests de plus d'une seconde pour 29 s, aucun gros poste ; `--pool=threads` essayé, pas plus rapide (749 s contre 769 s), non retenu.
- Reste : fusionnée (#341) ; relecture forte 1 P1 corrigé ; Codex non attendu (H03) ; vérification GitHub verte.
- Qui : Claude, voie 1 · Relecture : forte · Dépend de : rien
- Cahier : Organisation et méthode.
- Objectif : trouvé par la voie 2 sur #339 : `verifications.yml` coupe le travail à 15 minutes, et la suite en prend près de 13 à elle seule. Le 2026-11-03, tous les tests de #339 étaient verts (3 657), mais le travail a été coupé juste après, avant les garde-fous et le paquet du Worker : il est lu comme un échec. Chaque test ajouté rapproche toutes les fusions de ce mur. Fichier du socle : laissé à la voie 1. Relever le délai sans rien affaiblir, faire passer les contrôles courts avant les tests pour qu'une coupure ne les saute plus, et regarder ce qui prend le plus de temps ; aucune dépense GitHub en plus (décision du 2026-10-29), donc pas de machine plus grosse.
- Critères : aucune vérification retirée ni sautée (test ou lecture du fichier par `garde-fous`) ; le délai laisse une marge d'au moins 30 % sur la durée mesurée ; garde-fous et paquet passent avant les tests.
- Attend : rien.

### CE23 · Une panne de stockage à l'ouverture d'un dossier ne consomme pas le code
- Statut : fait (2026-11-03)
- Décidé (2026-11-03), lecture prudente : tout est lu avant la première écriture ; une panne répond 503 `stockage_indisponible`, journalisée seulement, sans ligne d'accès, faute de refus à ranger ; une porte fermée consomme toujours le code, comme avant.
- Reste : fusionnée (#342) ; relecture forte 1 P1 de test corrigé ; Codex non attendu (H03) ; vérification GitHub verte. Une panne du journal après le rangement laisse le code consommé et l'ouverture comptée ; le code de panne n'a pas de texte, faute d'écran du lecteur.
- Qui : Claude, voie 1 · Relecture : forte · Dépend de : CE22
- Cahier : M16 ; R17, R114.
- Objectif : trouvé par la relecture forte de CE22 : `dossier.ts`, si le stockage tombe en panne à l'ouverture, le code du lecteur est consommé et l'ouverture comptée comme faite, sans rien servir (réponse 500). Lire les documents avant de consommer le code, ou rendre ce code utilisable.
- Critères : panne à l'ouverture : le même code rouvre ensuite le dossier (test) ; l'ouverture n'est comptée qu'une fois servie (test) ; panne écrite au journal, sans donnée [R13] (test).
- Attend : rien.

### W26 · Lectures sans écran à vérifier, une par une
- Statut : fait (2026-11-03)
- Reste : fusionnée (#332) ; relecture forte 3 P1 corrigés, corrections non relues une seconde fois ; Codex non attendu (H03). Une alerte sur l'argent n'a pas de bouton « vue » : elle reste jusqu'à la fin du dossier.
- Qui : Claude, voie 2 · Relecture : forte · Dépend de : W25
- Cahier : selon la route ; R16, R201.
- Objectif : trouvé le 2026-11-03 par une comparaison de textes entre routes et écran, qui se trompe dans les deux sens (elle avait manqué `commerces/vigilance` par son dernier segment) : rien n'est vérifié. Pour chacune, dire si l'information est déjà à l'écran sous une autre forme, sinon la donner : `offres.comparatif`, `offres.historique`, `offres.taches`, `dossiers.taches`, `dossiers.alertes`, `investir.calcul.lu`, `partenaires.annuaire.fiche`. Laisser à la voie 1 celles de ses fichiers (`mandats.echeances`, `mandat.chronologie`, `bien.diffusion`, `attribution.regles`, `annonces.semaine`, `annonces.plan_tournage`, `studio.support`). Couper en tâches si plusieurs manquent vraiment.
- Critères : chaque route vérifiée écrite ici, avec sa réponse (relecture) ; chaque geste donné : droits refusés dits [R16] (test), réponse perdue dite telle (test), budget tenu [R201] (test).
- Vérifié (2026-11-03) : `offres.comparatif` et `offres.historique` : déjà à l'écran, le suivi (`offres.suivi`) les porte. `partenaires.annuaire.fiche` : déjà à l'écran (`annuaire.ts`, fiche). `offres.taches`, `dossiers.taches`, `dossiers.alertes` : manquaient vraiment, R59, R61 et R62 disaient « l'agent est prévenu » sans aucun écran ; donnés par le bloc « À tenir sur mes ventes » de l'accueil, une seule lecture `GET /v1/offres/a-tenir`. `investir.calcul.lu` : le calcul revient en réponse au geste, rien ne manque tant qu'aucune liste des calculs n'existe ; retrouver un calcul ou une note d'un projet est écrit à part (Y14).
- Décidé (2026-11-03), lecture prudente : route chez M09, ouverte sans le stockage des pièces ; les tâches d'offres se lisent par l'agent actuel du bien, sinon une échéance n'était plus vue de personne après un changement de main ; le rappel du bouclier ne part qu'en mode essai : l'écran le dit et demande toujours à l'agent de prévenir le client, à revoir à la mise en service réelle.
- Attend : rien.

### Y14 · Retrouver le calcul et la note d'un projet d'investisseur
- Statut : fait (2026-11-03)
- Reste : fusionnée (#334) ; relecture forte 1 P0 et 1 P1 corrigés, corrections non relues une seconde fois ; Codex non attendu (H03).
- Voie : 2
- Qui : Claude, voie 2 · Relecture : forte · Dépend de : Y10
- Cahier : M17 ; R16, R122, R201.
- Objectif : trouvé le 2026-11-03 par W26. L'écran dit « Calcul rangé », mais une fois quitté, ni le calcul ni la note ne se retrouvent : `investir.calcul.lu` et `investir.note.lue` n'ont aucun appel de l'application, et aucune route ne liste ceux d'un projet. Donner la liste du projet et la relecture, sans rien recalculer.
- Décidé (2026-11-03), lecture prudente, après la relecture forte : la liste ne porte aucun rendement ; chiffres et texte n'arrivent que par `…/relecture`, avec les alertes du jour d'abord [R124] ; une note validée qui ne tient plus est dite retenue, sans son texte ; si les contraintes ne se lisent pas, rien ne se relit. La classe énergie dite à l'écran le jour du calcul n'est pas rangée : sans fiche, l'alerte de classe inconnue ressort.
- Décidé (2026-11-03), lecture prudente : relecture seule : une note non validée retrouvée ne se valide pas depuis la liste, il faut refaire le calcul, pour que les contraintes du bien soient relues et que l'agent valide ce qu'il vient de lire [R124, R126]. La conformité n'y entre pas, comme pour la note.
- Critères : la liste ne rend que les calculs et notes du projet, à qui en a le droit, refus dit [R16] (test) ; relus tels qu'ils ont été rangés, avec leur date et leurs hypothèses (test) ; réponse perdue dite telle (test) ; budget tenu [R201] (test).
- Attend : rien.

### CE20 · Ranger un document du dossier protégé, à l'écran
- Statut : fait (2026-11-03)
- Reste : fusionnée (#326) ; ne range rien en production avant H38 et le branchement du Worker ; relecture forte 2 P1 corrigés, corrections non relues une seconde fois ; Codex non attendu (H03).
- Qui : Claude, voie 2 · Relecture : forte · Dépend de : CE05
- Cahier : M16 ; R16, R113, R114, R201.
- Décidé (2026-11-03) : le dossier ne sert que du texte, pour y porter le filigrane [R114] : l'agent colle le contenu, le dépôt d'un PDF n'existe pas. La référence vient de l'empreinte du texte ; le même texte rend sa ligne et répare un contenu perdu ; un seul titre par texte. `DossierStorage.write` reste absent en production : l'écran dit `stockage_absent` jusqu'à H38 et au branchement du Worker, tâche de la voie 1.
- Objectif : `POST /v1/commerces/<id>/documents` n'a aucun appel de l'application, et attend une `storageRef` : `DossierStorage` ne sait que lire, le Worker n'a aucun stockage réel (H38), et rien n'empêche une référence de pointer vers le document d'un autre bien. Personne ne saisit de référence : donner un dépôt côté serveur, dans les fichiers de M16 (`core/commerces/dossier.ts`, `api/src/commerces.ts`), qui choisit lui-même la référence, derrière la même porte d'écriture ; sans stockage, le dire à l'écran, ne rien laisser croire rangé. Le branchement du Worker sur R2 reste une petite tâche à part de la voie 1, après H38. Lire d'abord CE05 dans le cahier pour savoir ce que le dossier sert (aujourd'hui du texte filigrané).
- Critères : seuls l'agent du bien et la direction déposent et lisent la liste, sans contenu ni référence [R16] (test) ; une référence vers un autre bien refusée [R16] (test) ; sans stockage, c'est dit, rien n'est dit rangé (test) ; même texte sans doublon, dépôt interrompu sans copie de plus, contenu perdu dit et réparé [R10] (tests) ; réponse perdue dite telle (test) ; budget tenu [R201] (test).
- Attend : H38 pour un usage réel, rien pour le code.

**Espaces des clients et location : les gestes manquants à l'écran.**

Voie : 2

Trouvé le 2026-11-03 par la voie 2, en comparant les routes des modules de la voie 2 aux appels de l'application : aucun espace client ne peut s'ouvrir depuis l'écran, et aucun garant ne peut s'ajouter à une candidature.

### EC12 · Ouvrir l'espace d'un client depuis sa fiche
- Statut : fait (2026-11-03)
- Qui : Claude, voie 2 · Relecture : forte · Dépend de : EC06, EC07
- Cahier : Le produit, espaces des clients ; R160, R03, R16, R161, R26, R201.
- Objectif : depuis la fiche, l'agent note comment la personne a donné son accord et lui ouvre son espace, par `POST /v1/espaces/personnes/<id>/ouvrir`. Il ne voit jamais le lien.
- Critères : sans preuve de l'accord, rien ne part [R03] (test) ; ce qui part est dit en essai, jamais présenté comme un envoi réel [R26] (test) ; aucun lien ni jeton à l'écran [R160] (test) ; une personne sans dossier est dite telle [R161] (test) ; refus de droits dit en français [R16] (test) ; réponse perdue dite telle, sans renvoyer de lien (test) ; script à part, budget tenu [R201] (test).
- Attend : rien pour l'écran ; H40 pour de vrais espaces.
- Reste : fusionnée (#301). Relecture forte : 4 P1 corrigés ; Codex à sa limite (H03). À trancher : `invite` n'a pas de plafond, l'agent peut préparer autant de liens qu'il veut ; R160 parle de 3 liens par 24 heures pour la demande du client.

### W18 · Pièces et garants d'une candidature à l'écran
- Statut : fait (2026-11-03)
- Qui : Claude, voie 2 · Relecture : forte · Dépend de : W11, W13
- Cahier : M15 Louer ; R104, R105, R16, R201.
- Objectif : l'agent ajoute un garant à une candidature, par `POST /v1/location/candidatures/<id>/garants`. Vérifier d'abord la route et les pièces du garant.
- Critères : seules les pièces permises sont demandées [R104] (test) ; l'ordre d'arrivée ne change pas [R105] (test) ; seul l'agent du bien ou la direction agit [R16] (test) ; réponse perdue dite telle (test) ; budget tenu [R201] (test).
- Attend : rien.
- Décidé (2026-11-03) : aucune route ne déposait une pièce de candidature, donc aucun dossier ne pouvait devenir complet depuis l'application : la tâche couvre aussi les pièces, avec `POST /location/candidatures/<id>/fichiers/piece`. Un dossier DossierFacile n'a pas le geste [R104]. Un seul garant Visale par dossier, jusque dans la base (migration `1580`). Relecture forte : 3 P1 corrigés ; Codex à sa limite, fusion sans lui (#302).
- Reste : `addPiece` accepte encore des pièces sur un dossier DossierFacile par appel direct ; le geste de vérification de l'identité du candidat n'a pas été regardé (W21).

### G16 · La direction attribue une recommandation sans agent
- Statut : fait (2026-11-03)
- Qui : Claude, voie 2 · Relecture : forte · Dépend de : G08, G13
- Cahier : M20 ; R142, R16, R35, R201.
- Objectif : trouvé le 2026-11-03 en comparant les routes aux appels de l'écran : une recommandation de partenaire sans agent arrive à la direction, qui voit « Appel fait » (refusé) et ne peut pas l'attribuer ; personne ne l'appelle. Donner le geste, avec une lecture des agents en activité.
- Critères : seule la direction lit les agents et attribue [R16] (test) ; ni « Appel fait » ni liste lue d'avance pour elle, l'agent ne voit pas le geste (test) ; ordre reçu gardé, noms en texte [R35] (test) ; refus dits en français, réponse perdue dite telle, double appui un seul envoi (tests) ; budget tenu [R201] (test).
- Attend : rien.
- Décidé (2026-11-03, voie 2) : lecture `GET /v1/gagner/recommandations/agents`, noms seuls ; un agent au dossier incomplet ou parti n'est ni proposé ni accepté, la recommandation reste à la direction. Relecture forte : 2 P1 corrigés ; Codex à sa limite (H03), fusion sans lui (#313).

### EC13 · Un plafond aux liens d'espace préparés par l'agent
- Statut : fait (2026-11-03)
- Qui : Claude, voie 2 · Relecture : forte · Dépend de : EC12
- Cahier : Le produit, espaces des clients ; R160, R03, R16.
- Objectif : trouvé par EC12 : `invite` n'a pas de plafond, l'agent peut préparer autant de liens qu'il veut, alors que R160 limite à 3 liens par 24 heures la demande du client. Lire R160, puis appliquer le même plafond à `invite`, lecture la plus prudente.
- Critères : au-delà du plafond, rien n'est préparé et le refus est dit en français et écrit au journal [R160] (test) ; le compte est par personne, fiches réunies comprises (test) ; aucun lien ni jeton à l'écran [R160] (test).
- Attend : rien.
- Décidé (2026-11-03, voie 2) : le compte est partagé entre les liens demandés et préparés, sans passe-droit pour la direction ; un lien refusé par le contrôle central n'a jamais été remis et ne compte pas, pour les deux origines. Relecture forte : 2 P1 corrigés ; Codex à sa limite (H03), fusion sans lui (#312).
- Reste : un tiers qui connaît l'adresse peut consommer le plafond par des demandes ; l'agent attend alors la fin des 24 heures.

### W19 · Les pièces déposées mais jamais rangées, dans le droit d'accès et l'effacement
- Statut : fait (2026-11-03)
- Qui : Claude, voie 2 · Relecture : forte · Dépend de : W18, L07
- Cahier : Conformité ; M12 ; R95, R97, R13, R17.
- Objectif : un fichier de `location/<logement>/candidatures/<id>/` déposé puis refusé, ou après une réponse perdue, reste stocké sans ligne `rental_application_pieces` : la carte des accès ne le trouve pas. Ranger chaque dépôt pour que l'accès et l'effacement le voient. À faire avant tout usage réel de ces pièces.
- Critères : un dépôt refusé ensuite par le geste apparaît sur la carte de la personne [R95] (test) ; le plan d'effacement le compte [R97] (test) ; ni contenu ni nom au journal [R13] (test) ; rien n'est effacé par le dépôt lui-même [R17] (test).
- Attend : rien pour le construire ; H29 pour l'effacement réel.
- Décidé (2026-11-03, voie 2) : table `rental_piece_deposits` (migration `1590`), ligne écrite avant le fichier, à la personne pour qui il est déposé ; le titulaire est dit au dépôt (`?holder=`), un visa Visale va au candidat ; un fichier ne se range pas au nom d'un autre titulaire ; au journal, le dépôt d'une pièce passe sous la candidature, plus sous le logement du propriétaire.
- Reste : une pièce au titulaire Visale, dans `rental_application_pieces`, n'est sur aucune carte par cette table, seulement par sa ligne de dépôt. Fichiers déposés avant W19 sans ligne : aucun usage réel (`PIECES` pas encore relié, H25).

### W20 · Le garant passe par les mêmes droits que le candidat
- Statut : fait (2026-11-03)
- Qui : Claude, voie 2 · Relecture : forte · Dépend de : W04, W18
- Cahier : M15 Louer ; R16.
- Objectif : `addGuarantor` ne vérifie que le réseau : un appel direct peut désigner le contact d'un autre agent ou une fiche réunie du candidat, et lire par `missing` si son identité est vérifiée. Appliquer les règles de `addableContacts`.
- Critères : le contact d'un autre agent est refusé et le refus au journal [R16] (test) ; une fiche réunie du candidat est refusée (test) ; un dossier DossierFacile ne reçoit ni pièce ni garant par appel direct [R104] (test).
- Attend : rien.
- Décidé (2026-11-03, voie 2) : les droits d'abord, puis le reste ; une pièce interdite sur un dossier DossierFacile reste nommée au journal ; `addableContacts` suit toute la chaîne des fusions, comme le geste. Relecture forte : 2 P0 et 1 P1 corrigés. La route de la candidature elle-même a le même trou : W22.

### W21 · L'identité du candidat vérifiée, depuis l'écran
- Statut : fait (2026-11-03)
- Qui : Claude, voie 2 · Relecture : forte · Dépend de : W18, L09
- Cahier : M15 Louer ; M12 ; R15, R104, R16.
- Objectif : un dossier reste « incomplet : manque pièce d'identité vérifiée » tant que la vérification n'est pas rangée. Vérifier d'abord si un geste existe à l'écran pour un candidat ; sinon l'ajouter, sans que la pièce quitte le coffre.
- Critères : la pièce va au coffre, jamais au dossier [R15] (test) ; l'écran ne montre que le fait vérifié et sa date [R13] (test) ; réservé à l'agent du bien ou à la direction [R16] (test) ; budget tenu [R201] (test).
- Attend : H36 pour le coffre réel.
- Décidé (2026-11-03, voie 2) : aucun geste à l'écran pour un candidat, sauf le bloc de la fiche ; ajouté dans le dossier, par la route du coffre. Le critère disait « l'agent du bien ou la direction », mais le coffre écarte la direction, qui ne dépose jamais [R90] : lecture prudente, la direction lit le fait et la date, et son dépôt est refusé avec le texte dit.

### W22 · Le candidat passe par les mêmes droits que ses contacts
- Statut : fait (2026-11-03)
- Décidé (2026-11-03, voie 2) : fait dans la proposition de W21, qui sans cela donnait la date de vérification du client d'un autre agent.
- Qui : Claude, voie 2 · Relecture : forte · Dépend de : W20
- Cahier : M15 Louer ; R16, R105.
- Objectif : trouvé par W20 : `apply` ne vérifie que le réseau, un appel direct range comme candidat le contact d'un autre agent, puis lit son identité vérifiée par `missing`. Appliquer les règles de `addableContacts`, comme pour le garant.
- Critères : le contact d'un autre agent est refusé et le refus au journal [R16] (test) ; le bailleur est refusé (test) ; une fiche réunie reste rangée sur la fiche gardée [R105] (test).
- Attend : rien.

### X15 · Une réponse perdue n'est plus dite « rien n'est enregistré »
- Statut : fait (2026-11-03)
- Reste : fusionnée (#311). Vérification GitHub verte ; en séance, tests ciblés verts, suite complète coupée à 359 fichiers par la limite de temps de l'outil, sans échec vu ; Codex à sa limite (H03). Le verrou contre le double appui n'a pas été regardé écran par écran ; attirer, avis, gagner, integration, investir, louer, studio et l'après-vente n'ont que le test général, sans test de coupure à eux.
- Voie : 1
- Trouvé par X14 (son « Reste ») : dix écrans disent « Pas de réseau : rien n'est enregistré. » quand une réponse se perd, alors que l'écriture a pu passer sur le serveur. L'agent croit le geste perdu et le refait.
- Qui : Claude · Relecture : normale · Dépend de : X14
- Cahier : M18 ; R201. Aucune règle écrite ne vise ce texte ; le test le garde sans numéro.
- Objectif : chaque écran dit que rien n'est sûr et demande de relire avant de recommencer. Le texte seul change ; le verrou contre le double appui de chaque écran reste à regarder écran par écran.
- Critères : plus aucun écran ne porte l'ancienne phrase (test sur tous les scripts servis) ; le nouveau texte est dit sur une coupure, sur les écrans déjà éprouvés (tests) ; budgets tenus [R201] (test).
- Attend : rien.

### W23 · Le titre de séjour d'un candidat au coffre
- Statut : bloquée : le texte officiel de l'annexe I n'est pas lisible depuis une séance, et le seul résumé lu change la question (H43)
- Décidé (2026-11-03, voie 2) : rien de codé. Légifrance et service-public sont fermés à la séance. Un article de cabinet (Seban, 2015), résumé et non le texte, range en identité la carte d'identité, le passeport et le permis, français ou étrangers, et cite le titre de séjour à part, pour justifier du droit au séjour. Si c'est exact, une personne étrangère entre déjà par son passeport, et un titre de séjour ne doit pas valoir identité vérifiée. Ajouter la sorte demanderait aussi de refaire deux tables de la conformité, `compliance_vault_pieces` et `identity_checks`, ce que la voie 2 ne fait pas seule.
- Qui : Claude, voie 2 · Relecture : forte · Dépend de : W21, L09
- Cahier : M15 Louer ; M12 ; R15, R104.
- Objectif : trouvé par la relecture de W21 : `addPiece` renvoie un titre de séjour au coffre, mais le coffre ne connaît pas cette sorte. Une personne qui n'a que ce justificatif ne peut pas être déclarée telle quelle. Vérifier d'abord à la source la liste officielle de l'annexe I, puis ajouter la sorte au coffre (migration, `VAULT_PIECES`, `IDENTITY_PIECES`) et regarder ce que cela change pour D03, O07 et L03.
- Critères : le titre de séjour entre au coffre et vaut identité vérifiée pour un candidat [R15, R104] (test) ; le statut migratoire n'est dit nulle part, l'écran ne montre que le fait et la date [R13] (test) ; les contrôles avant signature gardent leur résultat pour les pièces existantes (test).
- Attend : rien.

### W24 · Le garant Visale et son visa sur la carte du candidat
- Statut : fait (2026-11-03)
- Qui : Claude, voie 2 · Relecture : forte · Dépend de : W19
- Cahier : Conformité ; M12 ; R95, R96, R97.
- Objectif : trouvé par W19 : un garant Visale n'a pas de personne, donc sa ligne et son visa rangé ne sont sur aucune carte d'accès, et le plan d'effacement ne les compte pas. Les rattacher au candidat, le seul à qui ils parlent.
- Critères : le garant Visale et son visa sont sur la carte du candidat [R96] (test) ; le plan d'effacement les compte [R97] (test) ; le garant personne et ses pièces restent sur sa seule carte [R96] (test).
- Attend : rien.

**M14 · Réseau et académie, juillet 2027.**

Voie : 2

Découpé le 2026-10-28 par la voie 2. Ids `J..` pour Joindre le réseau. Cahier : M14 Réseau et académie ; Offre aux agents, « Le parrainage, dans les règles » et « L'essai de 30 jours » ; Feuille de route, juillet 2027 : « 3 personnes extérieures font tout le parcours de candidature » ; critères « un agent pilote fait seul son premier parcours complet, du contact à l'avis de valeur », « aucun accès aux clients avant un dossier d'agent complet », « un import test de 500 contacts depuis un export Hektor ou Excel, sans doublon et sans aucun message envoyé hors règles ».
Décidé, lecture prudente : un candidat n'est pas un client : il vit dans ses propres tables, jamais dans la fiche client. L'IA informe et organise, un humain nommé décide de chaque entrée : aucune note, aucun score, aucun classement, aucun tri de candidats, ni par l'IA ni par le code ; les candidatures se lisent dans l'ordre d'arrivée [R14, R81]. Aucun texte de recrutement (page, réponse de l'assistant, message à un candidat) ne promet de revenus : une liste fermée de tournures et tout montant par mois ou par an sont refusés [R80]. Le dossier d'agent liste des pièces par des règles écrites, chacune avec sa date de fin de validité saisie avec sa preuve (contrat d'agent commercial signé, attestation d'habilitation du titulaire de la carte, immatriculation au registre des agents commerciaux, assurance de responsabilité civile professionnelle, attestation de vigilance de moins de 6 mois) ; une pièce est une référence de stockage, jamais son contenu ; sans dossier complet et valide ce jour-là, aucun accès aux clients [R82]. Les modèles du contrat et de l'attestation viennent de M06 et attendent H08 : en attendant, ils sont générés en mode essai, marqués « projet ». Le parrainage ne paie qu'après une commission encaissée par le filleul, jamais à l'arrivée, sans frais d'entrée, sur un nombre de niveaux réglé (1 tant que l'avocat ne l'a pas fixé) [R83]. L'import des contacts d'un agent les range sans doublon, chacun trié par sa base légale, et n'envoie rien : un contact sans accord prouvé ne reçoit jamais de premier message [R03, R84]. Les heures de formation obligatoire sont comptées par le code depuis les présences et modules faits (réglages : 14 h par an, 42 h sur 3 ans dont 2 h de déontologie et 2 h de non-discrimination), avec alertes avant l'échéance ; l'académie n'impose aucun horaire [R85]. Au départ d'un agent : accès coupé le jour même, clients repris par la direction, rien effacé [R86, R17]. Les numéros de règles R80 à R89 et de migrations à partir de `0601` sont réservés à M14, pour ne jamais croiser la voie 1. Le code vit dans `packages/core/src/reseau/`, ses routes dans `packages/api/src/reseau.ts` ; les fichiers du socle (droits d'accès, `index.ts`, `app.ts`, planificateur, Worker) ne changent que par J13, confiée à la voie 1.

### J01 · Candidature et textes de recrutement sans promesse de revenus
- Statut : fait (2026-10-28)
- Reste : relecture de Codex restée en cours 27 min, fusion sans elle (#110) ; « gagner » n'est permis que dans « gagner du temps, des mandats, en autonomie, en confiance ».
- Qui : Claude · Relecture : forte · Dépend de : rien
- Cahier : M14, « Candidature » et « Règles » ; Offre aux agents, parrainage.
- Objectif : un candidat dépose sa candidature (prénom, nom, une coordonnée, commune, statut actuel et expérience déclarés, question libre, source : vidéo, podcast, page, parrain), avec son accord pour être recontacté au sujet de sa candidature et sa preuve ; elle est rangée dans `candidates`, une seule fois par coordonnée ; le contrôle des textes de recrutement refuse toute promesse de revenus.
- Critères : la table n'a aucun champ de note, de score ni de rang ; la liste des candidatures se lit dans l'ordre d'arrivée, sans autre tri [R81] ; une même coordonnée déposée deux fois ne fait qu'une candidature [R18] ; « gagnez », « revenus garantis », « jusqu'à 10 000 € », « 5 000 €/mois », « devenez riche », « liberté financière » et tout montant par mois ou par an sont refusés dans un texte de recrutement, sur 30 cas tests [R80] ; rien d'une coordonnée au journal [R13] ; sans accord, aucun message au candidat [R03].
- Attend : rien.

### J02 · Réponses de l'assistant aux questions des candidats
- Statut : fait (2026-10-28)
- Reste : relecture de Codex restée en cours 26 min, fusion sans elle (#112) ; l'envoi réel aux candidats passera par le contrôle central au branchement (J13).
- Qui : Claude · Relecture : normale · Dépend de : J01
- Cahier : M14, « Candidature » ; Intelligence artificielle, mention de l'assistant.
- Objectif : l'assistant répond aux questions d'un candidat seulement à partir de réponses écrites et datées par la direction (questions fréquentes : statut d'agent commercial, frais, essai de 30 jours, formation, parrainage) ; sans réponse écrite, il le dit et passe la question à un humain ; chaque réponse passe par le contrôle central, en mode essai.
- Critères : aucune réponse ne contient ce qui n'est pas dans une réponse écrite [R10] ; chaque réponse passe le contrôle de R80 ; le premier message porte la mention de l'assistant [R06] ; une question sur la rémunération renvoie à la grille écrite, jamais à un chiffre de revenu [R80] ; une question sans réponse écrite crée une tâche pour la direction.
- Attend : rien (réponses réelles écrites par Shawez plus tard, dans l'application).

### J03 · Entretien préparé à partir du déclaré, décidé par un humain
- Statut : fait (2026-10-28)
- Décidé (2026-10-28) : un entretien se fixe à une date à venir, puis est marqué tenu une fois la date passée, avec la personne qui l'a mené ; un « oui » exige un entretien tenu ; J04 lit seulement `acceptedIn`, jamais le motif.
- Qui : Claude · Relecture : forte · Dépend de : J01
- Cahier : M14, « Entretien » ; « L'IA et l'humain ».
- Objectif : pour chaque candidature, une fiche d'entretien préparée par le code : ce que le candidat a déclaré, les mêmes questions pour tous, les pièces qu'il devra fournir ; l'entretien est fixé, mené et décidé par un humain nommé, qui range sa décision (oui, non, à revoir) avec son motif écrit ; un oui ouvre le parcours d'intégration (J04).
- Critères : la fiche ne contient que le déclaré et la liste commune de questions, la même pour tous [R81] ; aucune décision sans un humain nommé et un motif [R81, R14] ; une décision rangée ne change plus, une nouvelle s'ajoute [R17] ; l'IA ne lit ni ne résume le candidat pour décider [R81] ; seule la direction lit les candidatures et décide [R16].
- Attend : rien.

### J04 · Dossier d'agent et parcours d'intégration pas à pas
- Statut : fait (2026-10-28)
- Décidé (2026-10-28) : l'identifiant de l'agent est tiré de sa candidature (une seule entrée) ; fin de validité obligatoire pour l'habilitation et l'assurance, facultative pour l'immatriculation, aucune pour le contrat, calculée pour la vigilance (6 mois moins un jour) ; un projet ne compte jamais et ne remplace pas une pièce signée.
- Reste : tant que J13 n'a pas branché `DossierAgent.complete` dans les droits, un agent entré a les droits d'un agent actif.
- Qui : Claude · Relecture : forte · Dépend de : J03
- Cahier : M14, « Intégration » ; Conformité ; Offre aux agents, « Ce que l'agent s'engage à faire ».
- Objectif : à l'entrée décidée, un dossier d'agent : la liste des pièces attendues par des règles écrites (contrat d'agent commercial signé, attestation d'habilitation, immatriculation, assurance de responsabilité civile professionnelle, attestation de vigilance), chacune rangée par sa référence de stockage avec sa date de fin de validité ; le parcours guidé dit l'étape suivante en une phrase ; `DossierAgent.complete(agentId, at)` dit si le dossier est complet et valide à cette date, et pourquoi sinon.
- Critères : un dossier sans une pièce, ou avec une pièce échue (attestation de vigilance de plus de 6 mois comprise), n'est jamais complet [R82] ; une pièce rangée ne change plus, une nouvelle version s'ajoute [R17] ; une pièce d'identité ou un RIB sont refusés comme pièce [R15] ; l'agent est prévenu 30 jours avant l'échéance d'une pièce ; le contrat et l'attestation générés par M06 portent « projet » tant que H08 n'est pas fait.
- Attend : rien pour la tâche ; H08 pour un contrat réel.

### J05 · Import des contacts et des biens de l'agent, triés selon la loi
- Statut : fait (2026-10-28)
- Décidé (2026-10-28) : un accord importé exige une date passée, une preuve qui ne dit pas l'absence et une finalité de liste fermée (prospection, alertes, suivi) ; un accord retiré ne revient jamais par un import ; une personne suivie par un autre agent ou sans agent va à la direction, seule sa désinscription y est rangée ; biens en brouillon, adresse jamais lue.
- Reste : relecture de Codex absente (limite d'usage, H03), fusion sans elle (#122).
- Qui : Claude · Relecture : forte · Dépend de : J04
- Cahier : M14, « Import de ses contacts et de ses biens » ; Conformité, consentement ; `docs/REPRISE.md`.
- Objectif : l'agent dépose un export Hektor, Apimo, Excel ou Google (CSV) ; chaque contact devient ou complète sa fiche, à cet agent, avec la source « import » ; chacun est trié : client avec un mandat ou une vente dans l'export, contact avec accord prouvé (date et preuve dans l'export), ou contact sans base, qui ne reçoit jamais de premier message ; les biens sont rangés comme biens de l'agent, jamais publiés ; un compte rendu dit les nombres et les lignes illisibles.
- Critères : sur un export test de 500 contacts inventés (Hektor et Excel), aucun doublon, relancé deux fois sans rien doubler [R84, R18] ; aucun message ne part à l'import, et un contact sans base n'est jamais contacté le premier [R03, R84] ; une fiche existante suivie par un autre agent n'est jamais reprise, elle va à la direction [R16] ; rien d'une coordonnée au journal [R13] ; aucun accord inventé.
- Attend : rien (vrais exports plus tard, hors du dépôt).

### J06 · Académie : parcours, modules et compteur des heures obligatoires
- Statut : fait (2026-10-28)
- Décidé (2026-10-28) : périodes comptées depuis le jour d'entrée de l'agent (année et 3 ans) ; une séance compte seulement avec une présence saisie par la direction après sa date ; une alerte au palier le plus proche atteint, une seule fois ; module de 8 h au plus.
- Reste : relecture de Codex absente (limite d'usage, H03), fusion sans elle (#123).
- Qui : Claude · Relecture : normale · Dépend de : J04
- Cahier : M14, « Académie », « Formation en salle », « Communauté ».
- Objectif : des modules courts (vidéo YouTube en accès restreint par sa référence, script, durée), rangés en parcours (entrée, puis par spécialité) ; les séances en salle, en direct, mensuelles et régionales avec la présence saisie par un humain ; le compteur des heures de formation obligatoire de chaque agent, par période, avec déontologie et non-discrimination à part ; alertes à l'agent avant l'échéance.
- Critères : le compteur ne compte que des modules faits et des présences rangées [R85, R10] ; sur 10 agents tests à horloge simulée, chaque manque est signalé 90 et 30 jours avant l'échéance [R85] ; l'académie n'impose aucun horaire et ne note pas l'agent [R14] ; seule la direction et l'agent lui-même lisent son compteur [R16].
- Attend : rien.

### J07 · Bac à sable du premier parcours (Jamais vu)
- Statut : fait (2026-10-28)
- Décidé (2026-10-28) : le bac à sable est une autre base (interface `SandboxStorage`), jamais celle du réseau ; ses modules n'ont que la boîte d'essai ; une étape compte seulement si son geste est rangé dans cette base ; le parcours fini compte au module d'académie réglé, retenté tant qu'il manque.
- Reste : J13 fournit la vraie base à part en production (D1 dédiée ou stockage par agent) ; relecture de Codex absente (limite d'usage, H03), fusion sans elle (#124).
- Qui : Claude · Relecture : forte · Dépend de : J04, J06
- Cahier : M14, critère « un agent pilote fait seul son premier parcours complet, du contact à l'avis de valeur » ; M02 à M05.
- Objectif : avant même son dossier complet, le nouvel agent reçoit un réseau d'entraînement à lui : des contacts, des biens et des ventes inventés, où il fait tout son premier parcours avec les vrais modules (contact reçu, qualification, rendez-vous, avis de valeur) ; rien n'en sort jamais ; chaque étape franchie est cochée par le code ; le parcours fini compte comme module de l'académie. Aucun réseau, logiciel ou outil d'IA grand public n'offre une copie fidèle et sans risque de son propre outil pour apprendre le métier.
- Critères : le bac à sable vit dans son propre réseau, sans aucune donnée réelle, et aucun envoi n'en sort, même mis en service [R82, R01-R04 par le contrôle central] ; le parcours complet se fait de bout en bout dans un test ; les étapes sont cochées par les événements du journal du bac à sable, jamais saisies ; l'agent ne voit aucun client réel tant que son dossier n'est pas complet [R82].
- Attend : rien.

### J08 · Entraînement aux objections avec l'IA, sur des cas inventés
- Statut : fait (2026-10-28)
- Décidé (2026-10-28) : le retour est écrit par le code (règles et points de script abordés ou non), jamais une note ; la direction ne lit que le temps ; la séance ne compte pas en heures obligatoires tant que la direction ne le règle pas.
- Reste : vraie IA avec H13 ; relecture de Codex absente (limite d'usage, H03), fusion sans elle (#126).
- Qui : Claude · Relecture : normale · Dépend de : J06
- Cahier : M14, « Académie » ; Intelligence artificielle.
- Objectif : l'agent s'entraîne contre l'IA qui joue un vendeur ou un acquéreur d'un cas inventé de la bibliothèque (objection sur les honoraires, l'exclusivité, le prix) ; le retour cite les règles et les scripts de l'académie ; la séance compte en temps d'académie, non en heures obligatoires sauf réglage.
- Critères : un cas ne contient aucune donnée de client : il est refusé s'il cite une coordonnée ou une fiche [R15] ; sans IA (H13), un texte de secours le dit et rien ne casse [R12] ; aucune note de l'agent n'est rangée ni montrée à la direction [R14] ; aucun texte ne promet de revenus [R80].
- Attend : rien (H13 pour la vraie IA).

### J09 · Référent des 90 jours, binôme d'absence et assistance suivie
- Statut : fait (2026-10-28)
- Qui : Claude · Relecture : normale · Dépend de : J04
- Cahier : M14, « Référent », « Assistance », « Binôme ».
- Objectif : la direction attribue un référent à chaque nouvel agent pour 90 jours ; deux agents forment un binôme avec un partage des honoraires écrit d'avance ; pendant une absence déclarée, le binôme lit les dossiers en cours de l'absent ; une demande d'assistance est suivie avec son délai (2 h ouvrées pour un humain, 48 h ouvrées pour l'avocat) et alerte la direction avant l'échéance.
- Critères : le binôme ne lit les dossiers que pendant l'absence déclarée, et plus rien après [R16] ; le partage est écrit avant l'absence et ne change plus [R17] ; les délais d'assistance sont calculés en heures ouvrées par le code ; aucune donnée de client dans une demande d'assistance passée à l'avocat sans nécessité [R15].
- Attend : rien.

### J10 · Parrainage dans les règles
- Statut : fait (2026-10-28)
- Décidé (2026-10-28) : le parrain est celui déclaré à la création de l'agent, sinon celui rangé par la direction, jamais deux différents ; un seul niveau, imposé jusque dans la base ; sans taux réglé, aucune prime ; un parrain parti ne garde que les primes déjà reversées.
- Qui : Claude · Relecture : forte · Dépend de : J04
- Cahier : Offre aux agents, « Le parrainage, dans les règles » ; M14, « Règles ».
- Objectif : le parrain d'un agent est rangé à l'entrée ; une prime de parrainage est calculée sur chaque commission réellement encaissée par le filleul, au taux réglé, sur le nombre de niveaux réglé ; elle est montrée au parrain, jamais promise d'avance.
- Critères : aucune prime à l'arrivée d'un agent ni sans commission encaissée [R83] ; aucun frais d'entrée nulle part [R83] ; au-delà du nombre de niveaux réglé (1 par défaut), aucune prime [R83] ; un parrain parti ne touche rien de nouveau ; aucun texte de parrainage ne promet de revenus [R80] ; 10 cas tests de commissions encaissées, avoirs compris.
- Attend : rien (taux et niveaux réels avec l'avocat, H09).

### J11 · Départ d'un agent
- Statut : fait (2026-10-28)
- Décidé (2026-10-28) : préavis légal L134-11 compté depuis le premier contrat signé du dossier ou la date saisie par la direction (la plus ancienne), prolongé jusqu'à la fin du mois civil ; plus court seulement pour faute grave ou accord commun, signalé ; l'indemnité de fin de contrat n'est jamais chiffrée, seulement dite « à examiner par l'avocat » (démission comprise, L134-13 2°) ; le jour du départ, clients, biens et projets passent au successeur accepté, sinon à la file de la direction ; un successeur est un agent du réseau déjà en activité.
- Qui : Claude · Relecture : forte · Dépend de : J04
- Cahier : M14, « Départ d'un agent ».
- Objectif : la direction range un départ (date, préavis, motif) ; le jour venu, l'agent passe à « parti », son accès est coupé, ses clients et biens vont à la direction pour être réattribués, ses commissions en cours sont listées pour être soldées, ses contenus personnels sont listés pour lui être rendus ; un successeur présenté est rangé, avec l'accord du réseau.
- Critères : à la date du départ, plus aucune lecture ni écriture de l'agent n'est permise [R86, R16] ; aucun client ni dossier n'est effacé [R17] ; aucun client ne reste sans agent ni sans file de la direction [R86] ; les relances et envois préparés par l'agent parti ne partent plus [R86].
- Attend : rien.

### J12 · Routes de M14 et page de candidature
- Statut : fait (2026-10-28)
- Décidé (2026-10-28) : la branche part de J09, J10 et J11 réunis (#127, #128, #130, non fusionnés tant que H28 bloque) ; les écrans de l'application sortent en J14, parce qu'ils vivent dans `packages/api/app/fichiers.ts`, que modifie aussi #129 (voie 1) ; le rôle est contrôlé par la route avant tout corps, la couche métier refait son contrôle derrière ; la page `/rejoindre` se ferme d'elle-même si un de ses textes échoue au contrôle de R80 (Jamais vu).
- Qui : Claude · Relecture : forte · Dépend de : J01 à J11
- Cahier : M14 ; Organisation, exigence de design (protocole, section 9).
- Objectif : les routes `/v1/reseau` (candidatures, entretiens, dossier d'agent, import, académie, binôme, parrainage, départ) dans `packages/api/src/reseau.ts` ; la page publique de candidature ; dans l'application, les écrans « Mon intégration », « Académie » et, pour la direction, « Candidatures ».
- Critères : chaque route sous R16, refus au journal ; un parcours de test de la candidature à l'agent au dossier complet, fait de bout en bout par 3 candidats inventés ; écrans accessibles, beaux sur téléphone d'abord, sans texte générique ; la page de candidature passe le contrôle de R80.
- Attend : rien.

### J13 · Branchement de M14 dans le socle
- Statut : fait (2026-10-28)
- Décidé (2026-10-28) : l'état de l'agent (`parti`, `dossier_incomplet`, `actif`) est lu par `app.ts` avant toute route et par `Acces` ; un agent sans aucun dossier (ni entrée par M14, ni pièce rangée), créé hors de M14, garde ses droits pendant la preuve à Dijon, la règle vaut pour toujours dès l'entrée ou la première pièce ; hors dossier complet, seules les routes d'intégration (`OPEN_WITHOUT_AGENT_FILE`) ; le contrôle des envois refuse ce qu'un agent parti a préparé ou validé (`preparedBy` : compte rendu, point de la semaine, remerciement) et, après la reprise, fait partir un suivi du système au nom de qui suit la fiche ; `reseau.passage` est la première tâche de chaque passage ; relecture forte 2 P1, Codex 3 P0 corrigés.
- Reste : réglé par J15 (#221) : l'agent et son entrée sont rangés dans un même lot.
- Qui : Claude, voie 1 (fichiers du socle : `packages/core/src/index.ts`, `packages/core/src/acces/`, `packages/api/src/app.ts`, `packages/api/src/planificateur.ts`, `packages/api/src/worker.ts`) · Relecture : forte · Dépend de : J12
- Cahier : M14 ; critère « aucun accès aux clients avant un dossier d'agent complet ».
- Objectif : exporter `reseau` depuis `@aimmo/core` ; ajouter les routes de M14 à `app.ts` ; dans les droits d'accès, refuser toute fiche client et tout bien non partagé à un agent dont `DossierAgent.complete` est faux ce jour-là, et à un agent parti ; dans les droits d'accès, lire `Departs.isGone` (vrai dès minuit le jour du départ, avant le passage du planificateur) ; dans le contrôle central des envois, refuser tout envoi dont `Departs.sendAllowed` est faux (agent du message ou agent qui l'a préparé) ; lancer `Departs.runDue` au planificateur ; lancer au planificateur les alertes d'échéances des pièces, du compteur de formation, de l'assistance et les départs du jour ; ajouter `reseauRoutes({ pieces, coach, sandbox })` de `packages/api/src/reseau.ts` aux routes de `app.ts`, et servir `/rejoindre` par `handleCandidature` avec la variable `CANDIDATURE_NETWORK_ID`, comme les autres pages publiques (mode essai, erreur au journal).
- Critères : un agent au dossier incomplet ou échu ne lit aucune fiche client [R82, R16] ; un agent parti ne lit plus rien le jour de son départ [R86] ; les passages tournent une fois par créneau ; rien ne part réellement tant que le plan ne l'a pas mis en service.
- Attend : rien.

### J14 · Écrans de M14 dans l'application
- Statut : fait (2026-10-30)
- Reste : fusionnée (#218), prise par la voie 1 (voie 2 sur M01). Décidé : routes `mon-referent` et `mon-bac-a-sable` pour l'agent lui-même, ouvertes avec un dossier incomplet ; `academie` dit les modules faits de l'agent ; un 403 R82 sur la journée n'efface plus la clé (P1 de la relecture forte) ; `app.js` servi sans ses lignes de commentaire pour tenir les 48 Ko. Pour ajouter une pièce depuis l'écran, il faudra un dépôt de fichier comme X12 (non fait).
- Qui : Claude, voie 2 · Relecture : forte · Dépend de : J12 ; après la fusion de #129 (K09, voie 1), qui modifie le même fichier `packages/api/app/fichiers.ts`
- Cahier : M14 ; Organisation, exigence de design (protocole, section 9).
- Objectif : dans l'application, les écrans « Mon intégration » (dossier d'agent pièce par pièce, référent, premier parcours), « Académie » (parcours, modules faits, compteur des heures) et, pour la direction, « Candidatures » (ordre d'arrivée, fiche d'entretien, décision nommée), lus par les routes de J12.
- Critères : chaque écran lit seulement par les routes `/v1/reseau`, refus montré sans rien garder [R16] ; la liste des candidatures n'a ni tri, ni filtre, ni note [R81] ; écrans accessibles (libellés, focus, lecteurs d'écran), beaux sur téléphone d'abord, sans texte générique ; testés comme les autres écrans (`fake-dom`).
- Attend : rien.
### J15 · Entrée d'un agent en un seul lot
- Statut : fait (2026-10-30)
- Reste : fusionnée (#221). Le lot (`runBatch`) sert désormais à toute écriture en plusieurs requêtes qui doit être tout ou rien ; relecture forte : 1 P1 (test sous la fausse D1) et 1 P2 corrigés ; Codex à sa limite (H03), fusion sans lui ; vérification locale verte (2173 tests).
- Décidé (2026-10-30) : la voie 1 n'a plus aucune tâche prête (AT10 attend AT09 de la voie 2) ; elle prend le « Reste » de J13. Le socle reçoit une écriture en lot, tout ou rien (`SqlDatabase.batch`, facultative pour les bases de test faites à la main) : transaction sous node:sqlite, `batch` de D1 sous Cloudflare.
- Qui : Claude, voie 1 · Relecture : forte · Dépend de : J13
- Cahier : M14 ; Architecture technique.
- Objectif : `DossierAgent.admit` range l'agent et son entrée dans le même lot : si l'une des deux écritures échoue, aucune n'est gardée, et l'agent n'a aucun droit sans son entrée.
- Critères : une entrée qui échoue ne laisse pas d'agent (test sous node:sqlite et sous la fausse D1) ; une écriture en lot qui échoue en route ne garde rien (test) ; deux entrées simultanées ne créent qu'un agent [R18] ; la suite complète reste verte.
- Attend : rien.

**M12 · Conformité, avant juillet 2027.**

Voie : 1

Découpé le 2026-10-28 par la voie 1. La Feuille de route pose M12 comme préalable de juillet 2027 (M14, M18) : la voie 1 le prend avant M18. Ids `L..` pour la Loi. Cahier : M12 Conformité ; Conformité, « Données personnelles » et « Anti-blanchiment » ; critères « un agent dont l'attestation expire perd l'accès aux clients le jour même » (porté par J04 et J13) et « une demande d'accès d'une personne reçoit sa réponse complète en moins d'un mois, avec preuve ».
Décidé, lecture prudente : M12 ne refait pas ce qui existe déjà (contrôle central des envois, exclusions et arrêts, mentions des annonces et des documents, registre des mandats, mention de l'assistant, dossier d'agent de M14) : il le relie. Le système bloque, enregistre, alerte et prépare ; le responsable de la conformité (rôle `compliance`) décide, déclare un soupçon et répond aux personnes ; aucune décision n'est prise par l'IA, aucune pièce d'identité ni aucun document anti-blanchiment ne lui est jamais envoyé [R15]. Le coffre est une référence de stockage derrière une interface (faux stockage dans les tests), jamais le contenu d'une pièce, et seul le responsable le lit, chaque lecture au journal. La fiche de risque est préparée par des règles écrites (type d'opération, montant, pays déclaré, personne politiquement exposée déclarée, paiement), jamais par l'IA, et ne compte que si le responsable la valide ; elle ne sert jamais à trier un client ni à refuser un service sans décision humaine [R14]. Un signalement fige le dossier et ne donne aucune information au client : aucun texte, aucune relance, aucun refus visible ne le trahit, et seul le responsable le voit. L'effacement ne passe que par la procédure de M12 (demande de la personne ou 3 ans sans contact ni consentement), garde ce que la loi oblige à garder (registre des mandats, anti-blanchiment, factures) et s'écrit au journal [R17] ; tant que le responsable n'est pas nommé (H29), l'effacement reste en mode essai : il liste ce qu'il effacerait et n'efface rien. Les numéros de règles R90 à R99 et de migrations à partir de `0701` sont réservés à M12. Le code vit dans `packages/core/src/conformite/`, ses routes dans `packages/api/src/conformite.ts`.

### L01 · Coffre de la conformité, réservé au responsable
- Statut : fait (2026-10-28)
- Décidé (2026-10-28) : le coffre lit toutes les fiches réunies (S04) ; une pièce d'identité déposée range aussi l'identité vérifiée de D03 ; un test refuse que tout autre fichier du code lise la table du coffre ; relecture forte : 1 P1 corrigé (fiches fusionnées).
- Qui : Claude, voie 1 · Relecture : forte · Dépend de : S08
- Cahier : M12, « Anti-blanchiment » et « Règles » ; Conformité, « Conservation des documents ».
- Objectif : un coffre séparé, dans ses propres tables, où l'agent dépose la référence d'une pièce d'identité ou d'un document anti-blanchiment vérifiée (sorte, personne, dossier, date de vérification, qui l'a vérifiée, empreinte), jamais son contenu ; seul le responsable de la conformité lit le coffre ; la fiche client et les autres modules n'en voient qu'un état : « identité vérifiée le <date> ».
- Critères : un agent dépose mais ne relit jamais une pièce, même la sienne ; la direction et les partenaires sont refusés ; chaque lecture et chaque refus au journal, sans donnée personnelle en clair [R16, R13, R90] ; aucun champ du coffre ne passe dans un texte, une fiche ou un appel à l'IA [R15] ; rien ne s'efface, une pièce remplacée reste au coffre [R17] ; Jamais vu : l'agent voit à l'écran ce qu'il a déposé disparaître de son téléphone au moment du dépôt, et la preuve de dépôt (empreinte et heure) lui reste.
- Attend : rien.

### L02 · Fiche de risque de chaque client, validée par le responsable
- Statut : fait (2026-10-28)
- Décidé (2026-10-28) : grille d'essai `essai-2026-10-28` en code ; sources : 4 déclarations fermées oui/non, état d'identité du coffre, montant de l'offre au registre ; le niveau est le plus haut des critères ; Jamais vu : rejeu de la fiche à l'identique ; relecture forte : 1 P1 corrigé (validation vérifiée au journal) ; Codex : 1 P1 corrigé (événements repris si le journal a manqué), nouvelle relecture demandée.
- Qui : Claude, voie 1 · Relecture : forte · Dépend de : L01
- Cahier : Conformité, « Classement écrit des risques et analyse de chaque client avant l'entrée en relation ».
- Objectif : à l'entrée en relation (mandat pour un vendeur, offre pour un acquéreur), une fiche de risque préparée par des règles écrites et datées, chaque critère avec sa source (déclaré, document, base) ; le responsable la valide ou la corrige, avec son nom et sa date.
- Critères : le même client donne toujours la même fiche avec les mêmes règles ; aucun critère n'est tiré par l'IA ni d'une donnée sensible [R23] ; une fiche non validée ne vaut rien et le dit ; la fiche ne trie aucun client et ne refuse rien seule [R14, R91] ; chaque fiche et chaque validation au journal.
- Attend : H29 pour la grille réelle ; une grille d'essai en attendant.

### L03 · Identification et bénéficiaire effectif, étape bloquante
- Statut : fait (2026-10-28)
- Décidé (2026-10-28) : identité lue au coffre (pièce vérifiée depuis un an au plus, valide ce jour-là, non remplacée) ; la case « pièce vue » de D03 ne suffit plus ; société reconnue à sa déclaration ou à un Kbis ou registre au coffre, redéclarée « personne » par le responsable seul ; mandat papier jugé au jour de sa signature ; relecture forte : 2 P1 corrigés.
- Qui : Claude, voie 1 (touche aux contrôles de M06 et M09) · Relecture : forte · Dépend de : L01, L02
- Cahier : Conformité, « Identification du client et du bénéficiaire effectif, au seuil de 25 % ».
- Objectif : ni mandat signé sans l'identité vérifiée du vendeur au coffre, ni compromis sans celle de chaque acquéreur ; pour une société, les bénéficiaires effectifs à 25 % ou plus, chacun identifié ; les contrôles de D03 et d'O07 lisent l'état du coffre au lieu d'une case cochée.
- Critères : un mandat ou un compromis sans pièce vérifiée et valide ce jour-là est refusé avec la règle [R58, R92] ; une société sans bénéficiaire effectif déclaré est refusée ; une pièce échue bloque comme une pièce absente ; les tests de D03 et d'O07 passent toujours.
- Attend : rien.

### L04 · Vigilance renforcée et origine des fonds
- Statut : fait (2026-10-28)
- Décidé (2026-10-28) : réglage d'essai `essai-2026-10-28` (écart 20 % autour de la fourchette du dernier avis validé, montant 1 000 000 €), réglé ensuite par le responsable, versionné ; déclarations lues sur la fiche de risque de L02 ; la demande d'origine des fonds n'est préparée pour l'agent qu'après la décision « origine des fonds demandée » du responsable ; alertes et décisions au journal sous la référence de l'alerte, jamais sous la fiche du client ; relecture forte : 2 P1 corrigés. L'examen automatique à l'inscription d'une offre et à la signature d'un mandat est à brancher en L09.
- Qui : Claude, voie 1 · Relecture : forte · Dépend de : L02
- Cahier : Conformité, « Vigilance renforcée : montant inhabituel, prix sans lien avec la valeur, personne politiquement exposée ».
- Objectif : des alertes au responsable par des règles écrites et réglables : prix d'une offre ou d'un mandat écarté de la fourchette d'estimation de M04 au-delà d'un seuil, montant au-dessus d'un seuil, personne politiquement exposée déclarée, paiement comptant déclaré ; la demande d'origine des fonds est préparée pour l'agent, la décision reste au responsable.
- Critères : chaque alerte cite sa règle et ses chiffres lus dans la base [R10, R93] ; l'alerte ne bloque ni ne refuse rien seule [R14] ; aucune alerte n'est visible du client ni de l'autre partie ; mêmes données, mêmes alertes.
- Attend : rien.

### L05 · Signaler au responsable : dossier figé, rien au client (Jamais vu)
- Statut : fait (2026-10-28)
- Décidé (2026-10-28) : signalement d'un dossier `mandate:`, `offer:` ou `sale_file:` ; copie figée par empreinte du dossier et de la conformité de chaque partie (fiches réunies et bénéficiaires effectifs compris) ; aucun autre code ne lit ses tables ; le filtre du journal écarte les empreintes SHA-256 ; relecture forte : 1 P1 corrigé ; Codex : 1 P0 et 1 P1 corrigés. Routes et écran en L09.
- Qui : Claude, voie 1 (touche au contrôle central des envois) · Relecture : forte · Dépend de : L01
- Cahier : Conformité, « Déclaration de soupçon à Tracfin, sans délai, même pour une tentative ».
- Objectif : un bouton « signaler au responsable » sur un dossier ; le dossier est figé (aucun changement, aucune pièce effacée), le responsable est alerté sans délai et décide seul de la déclaration ; Jamais vu : le contrôle central des envois garde le cours normal des messages déjà prévus et n'ajoute ni ne retire rien qui pourrait trahir le signalement, et un test prouve que le client voit exactement les mêmes textes, avec ou sans signalement.
- Critères : seul le responsable voit qu'un signalement existe, l'agent qui l'a fait voit seulement « transmis » [R16, R94] ; aucun texte au client ne cite le signalement, ni par l'IA ni par le code ; rien ne s'efface [R17] ; le signalement et la décision du responsable au journal.
- Attend : H29.

### L06 · Registre des traitements vérifié contre la base (Jamais vu)
- Statut : fait (2026-10-28)
- Décidé (2026-10-28) : registre en code (`conformite/registre-traitements.ts`), 17 traitements ; toute colonne de la base classée, personnelle à son traitement ou sans donnée personnelle ; toute forme de migration non lue arrête la vérification ; relecture au 2026-10-28 par défaut, échéance à 3 mois ; relecture forte : 2 P1 corrigés ; Codex : 3 P0 et 2 P2 corrigés. Appel quotidien de `RelectureRegistre.run` et écran en L09.
- Qui : Claude, voie 1 · Relecture : forte · Dépend de : rien
- Cahier : Conformité, « Base légale notée pour chaque traitement, dans un registre des traitements relu chaque trimestre » ; « Sous-traitants ».
- Objectif : le registre des traitements écrit dans le dépôt (finalité, base légale, données, durée, destinataires, sous-traitants), relié aux tables de la base ; Jamais vu : une vérification automatique échoue dès qu'une migration ajoute une table ou une colonne de donnée personnelle qui n'est pas au registre ; la date de la dernière relecture trimestrielle est un réglage, l'alerte part au responsable avant son échéance.
- Critères : chaque table de donnée personnelle des migrations figure au registre, avec sa base légale et sa durée [R95] ; une table de test ajoutée sans registre fait échouer le test ; l'alerte de relecture part 15 jours avant l'échéance, une seule fois.
- Attend : rien.

### L07 · Demandes des personnes en moins d'un mois, avec preuve
- Statut : fait (2026-10-29)
- Reste : fusionnée (#159) ; au journal du dossier de vente, chaque sorte classée par `SALE_FILE_EVENTS` et relevée par test, ce qui est fait pour un client porte sa fiche (`client`) ; relecture forte 1 P0 et 3 P1 corrigés ; Codex resté en cours plus de 30 min, fusion sans lui. Hors tâche : la marque « vendeur » d'un dossier vient de tout mandat du bien, un ancien mandant voit l'avancée partagée du dossier comme ses étapes ; les événements écrits avant #159 sans `client` ne vont à personne (mode essai).
- Reprise (2026-10-29) : classement par test de chaque sorte d'événement du dossier de vente. Avant : bloquée : au journal du dossier de vente, un événement sans `side` va par défaut à l'acquéreur (satisfaction du vendeur, 4e tour de Codex de la séance du 28/10 soir) ; corrigés dans cette séance : plan figé revérifié, état des lieux et exemplaire du bail au locataire, signatures et exemplaires de l'état des lieux à chaque partie, alertes du vendeur au vendeur, documents à deux parties « à examiner ». Reprise (#159, branche `chantier/L07`) : relever par test chaque type d'événement écrit sous `sale_file:` et le classer (acquéreur, vendeur, auteur, partagé), au lieu d'un défaut ; ajouter aussi `rental_sends` (W10) à la carte
- Reprise (2026-10-28) : `JOURNAL_SUBJECTS` et relevé testé des sujets (littéraux, fonctions d'aide, sujets construits), journal des biens possédés, masque des autres personnes au journal (`foreignPersons`), localisateurs par champ JSON (`jsonPath`) pour la candidature et la session de signature ; relecture forte 1 P0 et 1 P1 corrigés.
- Décidé (2026-10-28) : demandes enregistrées par le responsable seul ; échéance d'un mois par `addCalendarMonths`, rappel 7 jours avant et alerte le jour même ; carte des demandes d'accès vérifiée contre le registre (Jamais vu) ; lutte contre le blanchiment écartée (accès par la CNIL, article L561-45) ; effacement en essai, qui garde obligation légale, arrêt (identifiants sous empreinte) et lignes partagées « à examiner » ; demandes des agents, candidats et partenaires traitées à la main pour l'instant.
- Qui : Claude, voie 1 · Relecture : forte · Dépend de : L06
- Cahier : M12, critère « une demande d'accès d'une personne reçoit sa réponse complète en moins d'un mois, avec preuve » ; Conformité, « Droits des personnes ».
- Objectif : une demande (accès, rectification, effacement, opposition) enregistrée avec sa date et son canal, l'échéance d'un mois calculée par le code, les alertes au responsable avant l'échéance ; la réponse d'accès assemblée par le code depuis chaque table du registre (L06), avec son empreinte ; l'opposition passe par l'arrêt sur tous les canaux [R04] ; l'effacement par la procédure de M12, qui garde ce que la loi oblige à garder.
- Critères : une demande d'accès test produit une réponse qui contient chaque donnée de la personne dans chaque table du registre, et rien d'une autre personne [R96] ; échéance et alertes vérifiées jour par jour ; un effacement garde registre des mandats, anti-blanchiment et factures, et s'écrit au journal [R17] ; tant que H29 n'est pas fait, l'effacement est en mode essai et n'efface rien ; aucun envoi réel de la réponse tant que le plan ne l'a pas mis en service.
- Attend : H29 pour l'effacement réel.

### L08 · Prospects à 3 ans et procédure de fuite
- Statut : fait (2026-10-29)
- Décidé (2026-10-29), lecture prudente : le dernier contact est celui qui vient de la personne (message reçu, accord, projet, rendez-vous pris même annulé ou tenu, visite ; à défaut la création de la fiche), jamais un message envoyé ; un accord ancien compte comme un contact de son jour ; fiches réunies comptées ensemble ; 3 ans en jours de Paris par le calendrier ; jamais listés : mandat, acquéreur d'un dossier de vente, parties d'un bail, personne identifiée en L03 et bénéficiaires effectifs ; demande de consentement préparée sans canal ni envoi (signalée R04/R02 si arrêt ou exclusion), réponse attendue 30 jours, puis plan d'effacement de L07 en essai ; un cycle clos à tort (fusion défaite) ne retient pas la personne. Fuite : échéance en heures exactes, alertes à la connaissance, 24 h, 6 h et à l'échéance tant que la CNIL n'est pas prévenue et que l'évaluation n'est pas « aucun » ; évaluation en listes fermées, sans texte libre ; accès coupés par la direction ou le responsable, jamais les clés du responsable ; raison exigée pour une notification tardive.
- Reste : fusionnée (#168) ; relecture forte 2 P1, Codex 2 P1 et 3 P0 corrigés, dernière version sans relecture au bout de 15 min. Branchement en L09 ; effacement réel et envoi de la demande : H29.
- Qui : Claude, voie 1 · Relecture : forte · Dépend de : L07
- Cahier : Conformité, « Durées » et « Fuite de données ».
- Objectif : chaque jour, la liste des prospects arrivés à 3 ans après leur dernier contact sans consentement : demande de consentement préparée en mode essai, puis effacement par la procédure de L07 sans réponse ; une procédure de fuite : accès coupés d'un geste, évaluation saisie par le responsable, échéance de 72 heures pour la CNIL calculée par le code, liste des personnes concernées.
- Critères : un prospect contacté il y a 3 ans moins un jour n'est pas listé, à 3 ans il l'est [R97] ; un client sous mandat ou une vente close n'est jamais listé ; l'échéance de 72 heures et ses alertes vérifiées heure par heure ; rien n'est envoyé ni effacé réellement tant que le plan ne l'a pas mis en service [R26, R17].
- Attend : H29.

### L09 · Routes de M12 et branchement dans le socle
- Statut : fait (2026-10-30)
- Où : proposition #175 ouverte, sans P0 ni P1 à la relecture forte ; fusion en attente des vérifications GitHub (H35). L'écran passe en L10 (défini sur la branche de #175) : en cours, proposition #178 empilée sur #175, fusion en attente de H35
- Qui : Claude, voie 1 (fichiers du socle) · Relecture : forte · Dépend de : L01 à L08
- Cahier : M12 ; Organisation, exigence de design (protocole, section 9).
- Objectif : les routes `/v1/conformite` dans `packages/api/src/conformite.ts`, dont le dépôt d'une pièce au coffre (`CoffreConformite.deposit`) et la déclaration personne ou société avec ses bénéficiaires effectifs (`Identification.declare`), seules portes de l'identification depuis L03 ; les passages au planificateur ; l'export depuis `@aimmo/core`.
- Ajouté par L08 : lire `Fuites.accessCut(networkId, role, userId)` avant toute route (refus au journal, le responsable jamais coupé) ; passages `DureesProspects.run` une fois par jour et `Fuites.run` à chaque créneau ; routes de `DureesProspects.list` et de `Fuites` (déclarer, couper, rétablir, évaluer, personnes concernées, notifications, alertes).
- Critères : chaque route sous R16, refus au journal ; les passages tournent une fois par créneau.
- Décidé (2026-10-29), découpage : la tâche était trop grosse pour une séance, l'écran « Conformité » passe en L10. Une pièce entre au coffre par le corps brut de la requête (PDF, JPEG, PNG, 10 Mo au plus), ses données par l'adresse (`sorte`, `verifie`, `valide`, `dossier`, `remplace`) ; le coffre a son propre stockage R2, `COFFRE`, distinct de `PIECES` ; sans lui, dépôt et ouverture répondent 503. Passages : `conformite.fuites` chaque heure, `conformite.echeances` à 6 h (durées des prospects, demandes des personnes, relecture du registre). La coupure est lue avant toute route de `/v1`, après la clé, refus au journal (`access_cut`).
- Attend : rien. Le compartiment R2 `COFFRE` (H36) ne bloque pas la tâche.

### L10 · Écran « Conformité » dans l'application
- Statut : fait (2026-10-30)
- Où : proposition ouverte, empilée sur #175 (L09) ; fusion en attente des vérifications GitHub (H35)
- Décidé (2026-10-29) : l'écran du responsable est un script à part, `/app/conformite.js`, chargé à la demande pour la seule clé `compliance` : un agent ne reçoit jamais son code, et l'application garde son budget de 48 Ko (46,9 Ko) ; le script tient celui d'une page (7 Ko). Nouvelle lecture `GET /v1/conformite/risque` (`FicheRisque.pending`) : fiches en attente dans l'ordre de leur préparation, jamais par niveau [R91]. Un client est nommé par la fin de l'identifiant de sa fiche, sans nom. Sur la fiche, le dépôt part en corps brut avec son type ; l'agent lit ses preuves (sorte, jour, empreinte), jamais la pièce. axe-core sans violation, clair et sombre (captures `app-conformite-*`, `app-coffre-*`). Relecture forte : 2 P1 corrigés (dépôt refusé pour agent inactif, tests d'accessibilité, de clé refusée et de session).
- Qui : Claude, voie 1 · Relecture : forte · Dépend de : L09
- Cahier : M12 ; Organisation, exigence de design (protocole, section 9).
- Objectif : dans l'application, l'écran « Conformité » du responsable (fiches à valider, alertes de vigilance, signalements, demandes des personnes et échéances, prospects à 3 ans, fuites et coupures, relecture du registre), sur les routes de L09 ; le dépôt d'une pièce au coffre par l'agent depuis la fiche de son client, avec la preuve de dépôt.
- Critères : un agent ne voit jamais l'écran du responsable (test) ; l'agent dépose une pièce et lit sa preuve, jamais la pièce (test) ; écran accessible (axe-core sans violation), beau sur téléphone d'abord, dans le système de design (test du système), sans texte générique ; aucune donnée personnelle dans les journaux du navigateur.
- Attend : rien.

**M18 · Partenaires, juillet 2027.**

Voie : 2

Découpé le 2026-10-28 par la voie 2 : M14 n'a plus de tâche faisable par la voie 2 (J13 revient à la voie 1, J14 attend la fusion de #129), et M18 est le module de juillet 2027 qu'aucune voie n'a commencé. Ids `U..` pour Unir les partenaires. Cahier : M18 Partenaires ; Feuille de route, juillet 2027 : « 5 demandes à des partenaires suivies jusqu'au bout » ; critères « pièces rangées sans erreur », « un partenaire ne voit que les dossiers qui lui sont confiés », « aucune mise en relation sans accord enregistré du client ».
Décidé, lecture prudente : un partenaire est une personne de rôle `partner`, dans ses propres tables (annuaire), jamais une fiche client. Chaque partenaire a un métier pris dans une liste fermée (notaire, diagnostiqueur, courtier, artisan, déménageur, photographe, géomètre, gestionnaire titulaire de la carte G, avocat, expert-comptable, promoteur, expert du viager) et ses justificatifs exigés par métier (certification par domaine pour un diagnostiqueur, immatriculation ORIAS pour un courtier, carte G pour un gestionnaire, assurance pour tous), chacun avec sa date de fin de validité et sa preuve ; un justificatif est une référence de stockage, jamais son contenu. Un partenaire sans justificatif valide ce jour-là n'est proposé à personne [R73]. La mise en relation n'existe qu'après l'accord du client enregistré avec sa date et sa preuve [R74] ; le client choisit parmi plusieurs professionnels quand la zone en compte plusieurs : ils lui sont montrés dans un ordre tiré au sort et noté, jamais trié par une note, un avis ou l'IA ; le choix est fait par le client avec l'agent, jamais par l'IA ni par le code [R75, R14]. Aucune rémunération d'un diagnostiqueur, sous aucune forme ; aucune rémunération d'un courtier ou d'une banque tant que le statut requis n'est pas validé par l'avocat (réglage faux par défaut) ; toute autre rémunération est déclarée dans la mise en relation et montrée au client avant son accord [R76]. Un partenaire ne lit que les mises en relation qui lui sont confiées, et seulement le dossier utile de son métier, champ par champ, listé par des règles écrites [R77]. Une pièce déposée par un partenaire est rangée par sa sorte (diagnostic dans la fiche du bien, pièce du notaire dans le dossier de M10, accord de prêt dans le financement du dossier, devis dans la mise en relation) ; une pièce de sorte inconnue va à une file humaine, jamais rangée au hasard [R78]. La prospection de nouveaux partenaires se fait par mail, entre professionnels, à une adresse professionnelle, avec un plafond par jour ouvré (5), le lien d'opposition et l'arrêt sur tous les canaux à la première demande ; tout passe par le contrôle central des envois, en mode essai tant que le plan ne l'a pas mis en service [R79, R01, R02, R04]. Les relances aux partenaires partent dans les heures d'envoi [R01]. Les avis des clients sur un partenaire sont lus par un humain, jamais transformés en note ni en classement. Les offres négociées pour les agents (responsabilité civile, protection juridique, prévoyance) sont une page d'information sans commission pour le réseau, hors de ce découpage tant qu'aucun accord n'existe. Les numéros de règles R73 à R79 et de migrations à partir de `0801` sont réservés à M18. Le code vit dans `packages/core/src/partenaires/`, ses routes dans `packages/api/src/partenaires.ts` ; les fichiers du socle (droits d'accès, `index.ts`, `app.ts`, planificateur, Worker, contrôle central des envois) ne changent que par U09, confiée à la voie 1.

### U01 · Annuaire des partenaires par zone, justificatifs datés
- Statut : fait (2026-10-28)
- Reste : fusionnée (#135) après réunion de main, vérifications vertes, Codex sans remarque restante.
- Décidé (2026-10-28) : le mesurage n'exige que l'assurance ; chaque autre domaine de diagnostic exige sa certification ; une version plus récente, déjà commencée, qui chevauche une période la corrige ; un renouvellement à l'avance ne retire pas la version en cours.
- Qui : Claude, voie 2 · Relecture : forte · Dépend de : S08
- Cahier : M18, « Annuaire par zone » ; Données.
- Objectif : l'annuaire (migration `0801`) : partenaire, métier (liste fermée), zones (codes postaux ou communes), domaines (pour un diagnostiqueur : amiante, plomb, DPE, électricité, gaz, termites, mesurage), justificatifs exigés par métier, chacun avec sorte, numéro déclaré, date de fin de validité, référence de la preuve, qui l'a vérifié ; la recherche des partenaires proposables pour un métier, une zone, un domaine et un jour.
- Critères : un partenaire dont un justificatif exigé manque ou est échu ce jour-là n'est jamais proposable, et la raison est dite à l'agent [R73] ; un diagnostiqueur n'est proposable que pour les domaines couverts par une certification valide [R73] ; la recherche ne rend jamais de note, de rang ni d'avis [R14] ; rien ne s'efface, un justificatif remplacé reste [R17] ; chaque ajout et chaque vérification au journal [R13].
- Attend : rien.

### U02 · Mise en relation avec l'accord du client, choix du client
- Statut : fait (2026-10-28)
- Reste : fusionnée (#136) après réunion de main, vérifications vertes, Codex sans remarque restante.
- Décidé (2026-10-28) : la mise en relation part d'un projet du client ; tirage mulberry32 rejouable par sa graine ; preuve d'accord rangée sous `relations/<id>/`.
- Qui : Claude, voie 2 · Relecture : forte · Dépend de : U01
- Cahier : M18, « Mise en relation » et « Règles ».
- Objectif : la mise en relation (migration `0802`) : dossier (bien, mandat, dossier de vente ou projet), métier, partenaires proposés (ordre tiré au sort, graine notée), partenaire choisi, accord du client (date, canal, preuve), rémunération déclarée, état (proposée, acceptée par le client, confiée, en cours, terminée, abandonnée).
- Critères : aucune mise en relation n'est confiée sans accord du client enregistré avec sa date et sa preuve [R74] ; quand la zone compte au moins 2 partenaires proposables, au moins 2 sont montrés (réglage : 3 au plus) ; l'ordre est tiré au sort, rejouable par sa graine, jamais par une note ni un avis [R75] ; le choix est toujours celui d'un humain nommé, aucune fonction de l'IA ni du code ne choisit [R75] ; chaque changement d'état au journal.
- Attend : rien.

### U03 · Rémunérations des partenaires, déclarées ou refusées
- Statut : fait (2026-10-28)
- Reste : fusionnée (#137) après réunion de main, vérifications vertes, Codex sans remarque restante.
- Décidé (2026-10-28) : l'accord du client est refusé tant que le dernier texte montré ne cite pas toutes les rémunérations déclarées.
- Qui : Claude, voie 2 · Relecture : forte · Dépend de : U02
- Cahier : M18, « Règles » ; Conformité.
- Objectif : la déclaration de toute rémunération venant d'un partenaire dans sa mise en relation (sorte, montant ou taux, qui paie, à qui) et le texte montré au client avant son accord.
- Critères : toute rémunération venant d'un diagnostiqueur est refusée, sous toute forme (commission, cadeau, remise, prestation) [R76] ; toute rémunération d'un courtier ou d'une banque est refusée tant que le réglage du statut validé par l'avocat est faux [R76] ; une rémunération non déclarée ne peut pas être ajoutée après l'accord du client : il faut un nouvel accord [R76] ; le texte montré au client cite chaque rémunération et passe le contrôle des textes (aucune mention de l'IA, R06) ; chaque déclaration au journal.
- Attend : H31 pour rémunérer un courtier ou une banque ; refusé en attendant.

### U04 · Espace partenaire : le dossier utile, rien d'autre
- Statut : fait (2026-10-28)
- Reste : fusionnée (#138) après réunion de main, vérifications vertes, Codex sans remarque restante.
- Décidé (2026-10-28) : le nom du client va seulement au notaire, au courtier, au gestionnaire, à l'avocat et à l'expert-comptable ; la certification du domaine est revérifiée à chaque accès.
- Qui : Claude, voie 2 · Relecture : forte · Dépend de : U02
- Cahier : M18, « Espace partenaire » ; critère « un partenaire ne voit que les dossiers qui lui sont confiés ».
- Objectif : la lecture par un partenaire de ses mises en relation confiées et de leur dossier utile, défini par métier, champ par champ (un diagnostiqueur : adresse du bien, surface, année, domaines demandés, créneaux ; un notaire : parties et pièces du dossier de vente ; un courtier : projet de l'acquéreur avec son accord, sans autre donnée de la fiche) ; le partenaire indique où il en est.
- Critères : un partenaire ne lit jamais une mise en relation qui ne lui est pas confiée, ni une fois terminée au-delà du réglage (30 jours) [R77, R16] ; il ne reçoit que les champs listés pour son métier, testés champ par champ, jamais la fiche client entière ni une donnée sensible [R77, R23] ; chaque lecture et chaque refus au journal avant de rendre la donnée [R13] ; un partenaire dont un justificatif est échu est refusé [R73].
- Attend : rien.

### U05 · Pièces déposées par les partenaires, rangées d'elles-mêmes
- Statut : fait (2026-10-28)
- Reste : fusionnée (#140) après réunion de main, vérifications vertes, Codex sans remarque restante.
- Décidé (2026-10-28) : la place de la pièce est rangée avec elle ; diagnostic et bornage à la fiche du bien (le dossier de vente le lira en U09) ; une pièce ne va dans un dossier que si le client du projet y est partie.
- Qui : Claude, voie 2 · Relecture : forte · Dépend de : U04
- Cahier : M18, « Pièces rangées d'elles-mêmes » ; M10 ; M06.
- Objectif : le dépôt d'une pièce par un partenaire dans sa mise en relation (sorte, référence de stockage, empreinte, date) et son rangement : diagnostic dans la fiche du bien, pièce du notaire dans les pièces du dossier de vente de M10, accord de prêt dans le financement du dossier, devis dans la mise en relation.
- Critères : chaque sorte connue est rangée au bon endroit, testé pour chacune, sans erreur sur 5 demandes complètes [R78] ; une pièce de sorte inconnue, ou dont la sorte ne va pas avec le métier du déposant, va à la file de l'agent et n'est rangée nulle part [R78] ; un partenaire ne dépose que dans ses mises en relation confiées [R77] ; une pièce n'est jamais son contenu, seulement sa référence ; rien ne s'efface, une pièce remplacée reste [R17].
- Attend : rien.

### U06 · Pièce contrôlée contre le justificatif du jour où elle a été faite (Jamais vu)
- Statut : fait (2026-10-28)
- Reste : fusionnée (#141) après réunion de main, vérifications vertes, Codex sans remarque restante.
- Qui : Claude, voie 2 · Relecture : forte · Dépend de : U05
- Cahier : M18, « Annuaire par zone » et « Pièces rangées d'elles-mêmes ».
- Objectif : au dépôt, chaque pièce est contrôlée contre les justificatifs de son auteur à la date où elle a été faite, et non au jour du dépôt : un diagnostic contre la certification du domaine concerné, un accord de prêt contre l'immatriculation du courtier, une pièce de gestion contre la carte G.
- Critères : Jamais vu : un diagnostic fait à une date où la certification de son domaine était échue, ou d'un domaine que le diagnostiqueur ne couvre pas, est refusé au rangement et signalé à l'agent avec la raison, avant qu'il n'entre dans un dossier de vente [R78, R73] ; un diagnostic fait pendant la validité puis déposé après son échéance est accepté ; la décision est rejouable à l'identique ; aucune pièce n'est jugée par l'IA.
- Attend : rien.

### U07 · Suivi des demandes, relances et avis lus par un humain
- Statut : fait (2026-10-28)
- Reste : fusionnée (#144) ; relecture forte 2 P1 corrigés (jours ouvrés en dates de Paris, alerte au journal) ; Codex 2 P0 (sorte de pièce inconnue rendue neutre avant l'IA, délai borné de l'IA) et 1 P2 corrigés ; test instable de J05 rendu stable ; tables inscrites au registre de L06 [R95]. Relances préparées seulement, passage par le contrôle central en U09.
- Décidé (2026-10-28, voie 2) : un partenaire n'est pas une personne de la fiche client, et le contrôle central des envois (`ControleEnvois.send`) n'écrit qu'à une personne de la fiche : U07 range seulement les relances préparées dans une boîte de M18 (texte du code, date due dans les heures d'envoi, jamais deux fois la même), sans rien envoyer ; leur passage par le contrôle central (partenaire relié à une fiche de rôle partenaire, type d'envoi `partner`, plafond de R11) revient à U09, voie 1.
- Qui : Claude, voie 2 · Relecture : forte · Dépend de : U05
- Cahier : M18, « Suivi » ; L'IA et l'humain.
- Objectif : pour chaque mise en relation confiée : délai de réponse mesuré, relance préparée au partenaire après le réglage (2 jours ouvrés sans réponse), puis alerte à l'agent ; résumé des réponses par l'IA derrière une interface, avec un secours sans IA ; avis du client sur le service rendu, rangé pour lecture humaine.
- Critères : une relance part seulement dans les heures d'envoi et par le contrôle central des envois, en mode essai [R01, R79] ; jamais deux fois la même relance [R05] ; un avis n'est jamais transformé en note, en rang ni en tri des partenaires [R14, R75] ; le résumé de l'IA ne reçoit aucune donnée sensible et le secours sans IA rend la même structure [R15, R23] ; chaque relance et chaque alerte au journal.
- Attend : rien.

### U08 · Prospection de nouveaux partenaires entre professionnels
- Statut : fait (2026-10-28)
- Reste : fusionnée (#146) ; aucun accord fabriqué : chaque brouillon porte le refus du contrôle central (R03 tant que H32 n'est pas tranché) ; plafond tenu par la base, même pour deux passages ensemble ; relecture forte 2 P1 corrigés, Codex 2 P2 corrigés. R79 entre en service avec U09.
- Décidé (2026-10-28, voie 2) : tel qu'écrit, R03 exige un accord préalable pour tout premier mail d'initiative, prospection entre professionnels comprise ; tant que H32 n'est pas tranché, U08 prépare la liste et les mails en mode essai, et le contrôle les refuse sous R03. Rien ne part.
- Qui : Claude, voie 2 · Relecture : forte · Dépend de : U01
- Cahier : M18, « Nouveaux partenaires » et « État ».
- Objectif : la liste des partenaires à contacter (adresse professionnelle, métier, source publique), le mail de présentation préparé, le plafond par jour ouvré, l'opposition.
- Critères : au plus 5 premiers mails par jour ouvré (réglage), jamais deux fois à la même adresse [R79, R05] ; seulement une adresse professionnelle, jamais une adresse personnelle déclarée comme telle [R79] ; chaque mail a son lien d'opposition, et une opposition arrête tout sur tous les canaux [R79, R04, R02] ; tout passe par le contrôle central des envois en mode essai, rien ne part réellement [R79] ; le texte ne promet rien et ne parle pas de l'IA [R06].
- Attend : rien.

### U09 · Branchement de M18 dans le socle
- Statut : fait (2026-10-30)
- Où : branche chantier/U09, empilée sur #178 tant que H35 bloque les fusions
- Décidé (2026-10-29) : la tâche est coupée en deux ; U09 branche les routes, les pages publiques et les passages, sans rien envoyer ; le passage des relances et des brouillons de prospection par le contrôle central (qui n'écrit qu'à une personne de la fiche) devient U12. Fichiers des partenaires dans `PIECES`, sous `partenaires/` (R2PartnerFiles) ; sans eux, les routes de M18 répondent 503 ; variable `PARTENAIRES_OPPOSITION_BASE` pour le lien d'opposition. Passages : relances et alertes de 9 h à 19 h, prospection à 10 h les jours ouvrés, échéances des justificatifs à 6 h, rangées au journal pour la direction (`partenaire.justificatif_echeance`). Le rôle `partner` n'a toujours accès à aucune fiche ni aucun bien dans `Acces` ; il ne lit que par l'espace partenaire [R77].
- Où : proposition #180, empilée sur #178 ; fusion en attente des vérifications GitHub (H35)
- Qui : Claude, voie 1 (fichiers du socle : `packages/core/src/index.ts`, `packages/core/src/acces/`, `packages/api/src/app.ts`, `packages/api/src/planificateur.ts`, `packages/api/src/worker.ts`, contrôle central des envois) · Relecture : forte · Dépend de : U10
- Cahier : M18 ; Branchements.
- Objectif : exporter `partenaires` depuis `@aimmo/core` ; dans les droits d'accès, le rôle `partner` lit seulement ses mises en relation confiées (U04) et rien d'autre ; ajouter les routes de M18 à `app.ts` ; lancer au planificateur les relances, les alertes d'échéance des justificatifs et la prospection du jour.
- Critères : un partenaire ne lit aucune fiche client, aucun bien et aucun dossier hors de ses mises en relation confiées [R77, R16] (test) ; les passages tournent une fois par créneau (test) ; rien ne part réellement tant que le plan ne l'a pas mis en service (test). Le passage de chaque brouillon de prospection (U08) et de chaque relance (U07) par `envoi/controle.ts`, qui redécide au moment de l'envoi, revient à U12.
- Attend : rien.

### U12 · Relances et prospection de M18 par le contrôle central des envois
- Statut : fait (2026-10-30)
- Où : proposition #183, empilée sur #180 (U09) ; relecture forte 1 P1 corrigé (opposition d'un partenaire tenue pour toutes ses adresses) ; Codex 1 P0 corrigé (opposition gardée sur le partenaire même sans adresse, `partner_optouts`), dernière version validée (ef84d00) ; fusion en attente des vérifications GitHub (H35)
- Décidé (2026-10-29) : `ControleEnvois.sendToProfessional`, seul port la boîte d'essai `ProTrialMailbox` ; accord du partenaire [R03] rangé avec son adresse professionnelle par la direction (`partner_addresses`, migration `0807`, preuve en note) ; opposition par adresse dans `partner_prospect_optouts`, valable pour partenaires et futurs partenaires ; plafond R11 partagé par `send_quota_slots` ; passage `partenaires.envois` de 8 h à 19 h ; les alertes à l'agent restent dans l'application.
- Reste : à H32, une tâche reprendra les brouillons refusés sous R03.
- Qui : Claude, voie 1 (contrôle central des envois) · Relecture : forte · Dépend de : U09
- Cahier : M18 ; Branchements ; Conformité (prospection entre professionnels).
- Découpée de U09 le 2026-10-29 : le contrôle central (`envoi/controle.ts`) n'écrit qu'à une personne de la fiche client ; un partenaire et un futur partenaire n'en sont pas. Il faut lui ouvrir un destinataire professionnel (partenaire de l'annuaire, adresse de prospection), avec ses propres règles (heures [R01], opposition [R04, R02], plafond du jour [R11], une seule fois [R05], texte sans mention de l'IA [R06]), sans jamais créer de fiche client.
- Objectif : chaque relance préparée (U07) et chaque brouillon de prospection (U08) passe par le contrôle central en mode essai, qui redécide au moment de l'envoi ; boîte d'essai seulement.
- Critères : un brouillon de prospection refusé sous R03 reste refusé tant que H32 n'a pas écrit son exception dans R03 et dans `decideSend` (test) ; une opposition posée entre la préparation et l'envoi arrête l'envoi (test) ; une relance hors des heures attend le créneau permis (test) ; rien ne part réellement tant que le plan ne l'a pas mis en service.
- Attend : H32 pour la prospection réelle.

### U10 · Routes de M18 et espace partenaire en ligne
- Statut : fait (2026-10-28)
- Reste : fusionnée (#147) ; relecture forte 1 P1 corrigé (date impossible stockée sans trace) ; Codex 2 P0 et 2 P2 corrigés dans la page (réponses dépassées ou d'une autre session ignorées, formulaire de dépôt vidé à chaque demande). Branchement des routes, de la page `/partenaire/`, de l'opposition `/partenaires/opposition/` et du stockage R2 des fichiers des partenaires revient à U09 (voie 1).
- Décidé (2026-10-28, voie 2) : le partenaire dépose le fichier lui-même ; le serveur contrôle accès, sorte et date avant de le stocker, choisit sa référence et calcule son empreinte ; sans stockage lié, 503 et rien n'est rangé.
- Qui : Claude, voie 2 · Relecture : forte · Dépend de : U01 à U08
- Cahier : M18 ; Organisation, exigence de design (protocole, section 9).
- Objectif : les routes `/v1/partenaires` (annuaire, mises en relation, accord du client, rémunérations, espace partenaire, dépôt de pièces, suivi, prospection) dans `packages/api/src/partenaires.ts` ; la page de l'espace partenaire, belle sur téléphone d'abord.
- Critères : chaque route sous R16, rôle contrôlé avant le corps, refus au journal ; un parcours de test de 5 demandes inventées (diagnostic, notaire, courtier, artisan, géomètre) suivies jusqu'au bout, pièces rangées sans erreur ; page accessible, sans texte générique.
- Attend : rien.

### U11 · Écrans de M18 dans l'application
- Statut : fait (2026-10-28)
- Reste : fusionnée (#163). Branchement des routes `/v1/partenaires/projets` et `/preuve-accord` par U09 (voie 1), avec `files` et `uploads` sur le même stockage pour que l'accord retrouve la preuve rangée ; la preuve d'un accord écrit est une note recopiée, le dépôt d'une photo du document viendra plus tard.
- Décidé (2026-10-28, voie 2) : l'agent note ce que le client a dit ; le serveur range la note comme preuve et donne son heure, que l'accord reprend ; prénom rendu seulement sous `decideAccess` (fiches réunies), chaque prénom un `fiche.lue` ; biens filtrés par les droits ; projets par pages de 50 ; relecture forte 1 P0 et 1 P1, Codex 1 P0 et 3 P2 corrigés.
- Qui : Claude, voie 2 · Relecture : forte · Dépend de : U10, Z03 (même fichier `packages/api/app/fichiers.ts`)
- Cahier : M18 ; Organisation, exigence de design (protocole, section 9).
- Objectif : dans l'application de l'agent, l'écran « Partenaires » : proposer au client (ordre tiré au sort), enregistrer son accord, suivre les demandes et les pièces.
- Critères : l'écran lit seulement par les routes `/v1/partenaires` [R16] ; aucune liste n'est triée par une note [R75] ; écran accessible, beau sur téléphone d'abord, testé comme les autres (`fake-dom`).
- Attend : rien.

**M15 · Louer, août 2027.**

Voie : 2

Découpé le 2026-10-28 par la voie 2 : M18 n'a plus de tâche faisable par la voie 2 (U09 est à la voie 1, U11 attend Z03), et M15 est le module d'août 2027 qu'aucune voie n'a commencé ; ses dépendances (M05, M06, M18) sont faites. Ids `W..` (bail). Cahier : M15 Louer ; Conformité, « Location » ; Feuille de route, août 2027 : « 3 mises en location tests : annonce conforme, honoraires sous le plafond, bail et état des lieux signés en ligne » ; critères « aucune pièce interdite demandée sur 20 candidatures tests », « un logement classé G est bloqué avant toute annonce », « le propriétaire voit les dossiers complets dans leur ordre d'arrivée, sans note ».
Décidé, lecture prudente : AIMMO fait la mise en location d'un logement, jamais la gestion locative ; il ne reçoit jamais ni loyer, ni dépôt de garantie, ni aucun fonds du locataire ou du propriétaire, et aucun champ ne le permet [R107]. Un logement n'est proposé à la location qu'après un contrôle écrit dans le code : classe énergie et date du bail (interdits : consommation au-delà de 450 kWh/m²/an en énergie finale depuis 2023, classe G depuis le 1er janvier 2025, F à partir du 1er janvier 2028, E à partir du 1er janvier 2034, pour tout nouveau bail ou reconduction), surface habitable d'au moins 9 m², annexes obligatoires présentes et valides ; un logement refusé reste bloqué, et le propriétaire reçoit, préparée en mode essai, l'échéance qui le concerne [R100, R101]. Les honoraires à la charge du locataire sont calculés par le code depuis la surface habitable et la zone de la commune (12 € par m² en zone très tendue, 10 € en zone tendue, 8 € ailleurs, plus 3 € par m² pour l'état des lieux d'entrée), jamais au-dessus du plafond ni de la part du bailleur ; la zone de chaque commune est une donnée de la base, rangée avec sa source et sa date, jamais écrite dans le code ; une commune sans zone connue prend le plafond le plus bas [R102]. L'annonce est rédigée par l'IA derrière une interface, avec secours sans IA ; ses mentions (loyer charges comprises, charges, honoraires du locataire, dépôt de garantie, surface, commune, classe énergie, complément de loyer s'il y en a) sont calculées par le code ; aucun critère discriminant dans le texte, contrôlé par une liste écrite [R103]. Le dépôt de garantie d'un logement vide ne dépasse pas un mois de loyer hors charges, celui d'un meublé deux mois [R102]. Le candidat et sa caution ne fournissent que les pièces de la liste officielle (décret du 5 novembre 2015), chacune une référence de stockage, jamais son contenu ; un lien DossierFacile est accepté tel quel ; l'IA vérifie seulement qu'un dossier est complet, par une liste écrite, jamais sa solvabilité [R104, R14]. Le propriétaire voit les seuls dossiers complets, dans leur ordre d'arrivée, sans note, sans rang, sans tri ni filtre sur un revenu ; son choix est le sien, enregistré avec sa date et sa preuve [R105]. Le bail (vide ou meublé) et ses annexes sont faits depuis les modèles datés de M06 et signés par la signature en ligne de D08, en mode essai tant que H08 et H24 ne sont pas faits. L'état des lieux se fait dans l'application : pièce par pièce, photos (références), relevés des compteurs, clés remises, signature des deux parties, un exemplaire chacun ; l'IA ne fait que mettre en forme le texte dicté, sans rien ajouter [R106]. La gestion locative est proposée par un partenaire de M18 titulaire de la carte G, par la mise en relation de M18 avec l'accord du propriétaire. Les numéros de règles R100 à R109 et de migrations à partir de `0901` sont réservés à M15 ; les vérifications (`scripts/garde-fous.mjs`) lisent les règles à trois chiffres dès W01. Le code vit dans `packages/core/src/location/`, ses routes dans `packages/api/src/location.ts` ; les fichiers du socle (droits d'accès, `index.ts`, `app.ts`, planificateur, Worker, contrôle central des envois, application de l'agent) ne changent que par W10, confiée à la voie 1.

### W01 · Logement contrôlé avant toute annonce, échéance du propriétaire
- Statut : fait (2026-10-28)
- Reste : fusionnée (#149) ; R100 et R101 en service ; relecture forte 1 P0 (bail daté du passé) et 1 P1 (lectures au journal) corrigés, Codex 1 P2 corrigé. `advertisable` sert à W03 et W06 ; l'échéance préparée passe par le contrôle central en W10.
- Décidé (2026-10-28, voie 2) : la classe énergie est jugée au plus tard du début du bail et du jour ; un début de bail dans le passé est refusé ; constat plomb tenu valable 6 ans même négatif.
- Qui : Claude, voie 2 · Relecture : forte · Dépend de : D02, P01
- Cahier : M15, « Contrôle du logement » ; Conformité, « Logements énergivores ».
- Objectif : la mise en location (migration `0901`) : logement, propriétaire (fiche de M01), vide ou meublé, loyer hors charges, charges, surface habitable, classe énergie et consommation, date de bail envisagée ; le contrôle du logement par des règles écrites ; l'échéance du propriétaire préparée en mode essai. Les vérifications lisent les règles à trois chiffres (`R100`).
- Critères : un logement classé G, ou au-delà de 450 kWh/m²/an, est bloqué avant toute annonce pour un bail commençant après le 1er janvier 2025 ; F bloqué pour un bail commençant à partir du 1er janvier 2028 ; E à partir du 1er janvier 2034, testé à la veille et au jour de chaque date [R100] ; une surface habitable sous 9 m² ou une annexe obligatoire manquante ou échue bloque, avec la raison dite à l'agent [R101] ; le propriétaire reçoit, préparée et jamais envoyée hors du contrôle central, la date à partir de laquelle son logement ne pourra plus être loué selon sa classe ; rien ne s'efface, chaque contrôle au journal [R17, R13] ; `npm run garde-fous` refuse une règle à trois chiffres en service sans test.
- Attend : rien.

### W02 · Honoraires du locataire et dépôt de garantie sous le plafond
- Statut : fait (2026-10-28)
- Reste : fusionnée (#150) ; R102 en service ; relecture forte 1 P0 (commune libre au barème) et 1 P1 (parts du bailleur en total) corrigés, Codex 1 P0 (lecture des plafonds au journal) corrigé. La liste officielle des zones tendues et très tendues reste à ranger dans `rental_zones` (par W09 depuis une source publique, ou par la direction) ; d'ici là, chaque commune prend 8 € par m².
- Décidé (2026-10-28, voie 2) : la commune du logement est fixée une fois par mise en location, contrôlée contre le département du code postal du bien ; la part du locataire est comparée à celle du bailleur séparément pour visite-dossier-bail et pour l'état des lieux.
- Qui : Claude, voie 2 · Relecture : forte · Dépend de : W01
- Cahier : M15, « Mandat de location » ; Conformité, « Honoraires de location ».
- Objectif : les zones des communes (migration `0902`, donnée de la base avec source et date) ; le calcul des honoraires du locataire et du bailleur ; le dépôt de garantie.
- Critères : la part du locataire (visite, dossier, bail) ne dépasse jamais 12, 10 ou 8 € par m² habitable selon la zone, ni l'état des lieux 3 € par m², ni la part du bailleur, testé aux bornes [R102] ; une commune sans zone connue prend 8 € [R102] ; le dépôt de garantie ne dépasse pas un mois de loyer hors charges pour un logement vide, deux pour un meublé [R102] ; les montants sont calculés en centimes par le code, jamais par l'IA ; un barème au-delà du plafond est refusé à l'enregistrement.
- Attend : rien.

### W03 · Annonce de location conforme
- Statut : fait (2026-10-28)
- Reste : fusionnée (#151) ; R103 en service ; relecture forte 1 P0 et 4 P1 corrigés (tournures de santé, de famille et de garant, classe climat, formule de l'énergie, mode des charges), Codex 2 P0 corrigés (sigles à points, vide ou meublé contre les faits). `publishable` sert à la diffusion ; le complément de loyer (communes à loyer encadré) n'est pas proposé.
- Décidé (2026-10-28, voie 2) : aucune annonce sans dépenses d'énergie dans la fiche du bien, avec une classe de la fiche différente de celle de la mise en location, ni sans mode des charges ; un logement vide n'est jamais au forfait.
- Qui : Claude, voie 2 · Relecture : forte · Dépend de : W02, P03
- Cahier : M15, « Annonce » ; L'IA et l'humain.
- Objectif : l'annonce de location rédigée par l'IA derrière une interface, avec secours sans IA de même forme, validée par l'agent ; ses mentions calculées par le code.
- Critères : l'annonce n'existe que pour un logement passé au contrôle de W01 [R100] ; chaque mention obligatoire (loyer charges comprises, charges, honoraires du locataire, dépôt de garantie, surface habitable, commune, classe énergie) vient des données et figure dans le texte publié, testé mention par mention ; aucun critère discriminant (liste écrite : origine, nationalité, situation de famille, âge, sexe, handicap, état de santé, religion, garant obligatoirement en France, « CDI exigé », etc.) dans le texte de l'IA ni de l'agent [R103] ; aucune mention de l'IA [R06] ; rien n'est publié sans validation de l'agent.
- Attend : rien.

### W04 · Candidatures limitées aux pièces de la liste officielle
- Statut : fait (2026-10-28)
- Reste : fusionnée (#153) ; R104 en service ; relecture forte 1 P0 (annexe II de la caution) et 2 P1 corrigés ; la relecture de Codex tournait encore au bout de 20 minutes, fusion sur vérifications vertes. Migration `0904` (et non `0903`, prise par W03) ; l'état des lieux de W07 prendra `0905`.
- Décidé (2026-10-28, voie 2) : la pièce d'identité du candidat et de chaque garant ne vit qu'au coffre de la conformité (L01), la candidature lit l'état « identité vérifiée » ; la caution d'une personne morale n'est pas encore proposée ; aucune IA dans la complétude.
- Qui : Claude, voie 2 · Relecture : forte · Dépend de : W01
- Cahier : M15, « Candidatures » ; Conformité, « Pièces du candidat ».
- Objectif : la candidature (migration `0903`) : candidat (fiche de M01), cautions, pièces rangées par sorte (liste officielle, une pièce d'identité, un justificatif de domicile, d'activité, de ressources, pour le candidat et chaque caution), lien DossierFacile, date d'arrivée, complétude vérifiée par une liste écrite.
- Critères : aucune pièce hors de la liste officielle n'est demandée ni acceptée, sur 20 candidatures tests, testé sorte par sorte (relevé de compte, attestation de bonne tenue de compte, photo, carte vitale, dossier médical, extrait de casier, chèque de réservation, etc. refusés) [R104] ; un lien DossierFacile vaut dossier sans autre pièce [R104] ; la complétude est dite par la liste écrite ; l'IA éventuelle ne reçoit aucune pièce et ne rend que « complet » ou les sortes manquantes, jamais un avis sur la solvabilité [R14, R15] ; une pièce n'est jamais son contenu, seulement sa référence.
- Attend : rien.

### W05 · Dossiers montrés au propriétaire dans leur ordre d'arrivée, reçu d'équité (Jamais vu)
- Statut : fait (2026-10-28)
- Reste : fusionnée (#154) ; R105 en service ; relecture forte 3 P1 corrigés (pièces du garant dans le reçu, reçus rejouables, reçus des dossiers incomplets), Codex 1 P1 et 1 P2 corrigés (reçus sans dossier complet, référence de vérification sans chiffre). Les reçus préparés passent par le contrôle central en W10.
- Décidé (2026-10-28, voie 2) : le propriétaire voit chaque dossier par son rang d'arrivée, ses pièces et ses garants, sans le nom du candidat ; chaque candidat, présenté ou encore incomplet, reçoit son reçu d'équité ; un seul choix par mise en location.
- Qui : Claude, voie 2 · Relecture : forte · Dépend de : W04
- Cahier : M15, « Présentation au propriétaire » ; Conformité, « Non-discrimination ».
- Objectif : la présentation des dossiers complets au propriétaire et l'enregistrement de son choix ; le reçu d'équité.
- Critères : le propriétaire ne voit que les dossiers complets, dans leur ordre d'arrivée, sans note, rang, tri ni filtre sur un revenu ou une autre donnée [R105, R14] ; son choix est enregistré avec sa date et sa preuve, jamais fait par le code ni l'IA [R105] ; Jamais vu : chaque candidat reçoit, préparé en mode essai, un reçu d'équité qui liste les seules pièces qui lui ont été demandées, sa date d'arrivée et la règle de présentation, rejouable à l'identique depuis le journal ; le propriétaire reçoit la même preuve que l'ordre montré est celui des arrivées [R105, R104].
- Attend : rien.

### W06 · Bail et annexes depuis les modèles, signés en ligne
- Statut : fait (2026-10-28)
- Reste : fusionnée (#155) ; relecture forte faite, Codex 4 P0 et 2 P1 corrigés (annexes jointes par leur référence, total du locataire avec l'état des lieux, libellé « agent immobilier », bail caduc quand un diagnostic est remplacé, noms lus sous les droits des fiches [R16], prénom et nom exigés [R40]). Signature en mode essai tant que H08 et H24 ne sont pas faits ; l'état des lieux et l'inventaire du meublé sont établis par W07.
- Qui : Claude, voie 2 · Relecture : forte · Dépend de : W05, D08
- Cahier : M15, « Bail et annexes » ; Conformité, « Bail et état des lieux ».
- Objectif : le bail vide ou meublé et ses annexes faits depuis les modèles datés de M06 (D02) avec les données de la mise en location, signés par la signature en ligne de D08, en mode essai.
- Critères : le bail ne se fait que pour le candidat choisi par le propriétaire [R105] ; chaque annexe obligatoire est jointe ou le bail est refusé [R101] ; loyer, charges, dépôt et honoraires viennent des données contrôlées par W02 [R102] ; le modèle utilisé est celui en vigueur à la date du bail ; signature en mode essai tant que H08 et H24 ne sont pas faits.
- Attend : H08 et H24 pour un usage réel ; en mode essai d'ici là.

### W07 · État des lieux dans l'application, signé par les deux parties
- Statut : fait (2026-10-28)
- Reste : fusionnée (#157) ; R106 en service ; migration `0907` (0904 était pris). Relecture forte 1 P0 (contrôle par listes noires seulement) et 1 P1 (commune vide) corrigés ; Codex 2 P0 (fidélité hors listes, exemplaires non atomiques) et 2 P1 (photos hors empreinte, correction pendant la clôture) corrigés ; dernière relecture de Codex encore en cours après 20 minutes, fusion sans elle. `closedInventory` sert à W08 ; l'envoi des exemplaires par le contrôle central est dans W10.
- Décidé (2026-10-28, voie 2) : l'IA ne peut qu'ajouter ou ôter articles et liaisons ; tout autre changement (mot, ordre, accent, pluriel, nombre, négation, saut de ligne) fait prendre le secours. Les signatures sont tracées à l'écran devant l'agent, empreinte seule gardée ; un état des lieux ne se signe que complet (noms, domicile du bailleur, adresse et commune, chaque pièce, compteurs, clés, mobilier d'un meublé).
- Qui : Claude, voie 2 · Relecture : forte · Dépend de : W06
- Cahier : M15, « État des lieux » ; L'IA et l'humain.
- Objectif : l'état des lieux d'entrée (migration `0904`) : pièce par pièce, éléments et état, photos (références), relevés des compteurs, clés remises, texte dicté mis en forme par l'IA derrière une interface avec secours, signature des deux parties, un exemplaire chacun.
- Critères : l'état des lieux n'est clos qu'avec la signature des deux parties et chaque pièce renseignée [R106] ; l'IA ne fait que mettre en forme : le texte rendu ne contient aucun élément, état ni chiffre absent du dicté, sinon le secours est pris [R106] ; chaque partie reçoit le même exemplaire, de même empreinte [R106] ; rien ne s'efface, une correction est une nouvelle version avant signature [R17].
- Attend : rien.

### W12 · Signature en ligne du bail par D08, en mode essai
- Statut : fait (2026-10-28)
- Reste : fusionnée (#160) ; R108 en service ; migration `0909`. Relecture forte 2 P1 corrigés (remise impossible après un changement de faits, conformité qui lisait l'exemplaire) ; Codex 1 P0 corrigé (fiches des signataires), 1 P0 réfuté et corrigé dans le texte (le canal n'a pas de pièce jointe : l'avis porte la référence et l'empreinte, l'agent remet l'exemplaire) ; dernière version validée par Codex (« Didn't find any major issues », b99ac9d).
- Décidé (2026-10-28, voie 2) : `REAL_LEASE_SIGNATURE` reste faux dans le code jusqu'à une tâche du plan après H08 et H24 ; `signedAt` (W08) ne rend donc rien de réel ; le parcours d'essai (W09) lit `trialState()`, jamais branché sur la remise des clés réelle (W10) ; l'envoi du document lui-même attend H05 et W10.
- Qui : Claude, voie 2 · Relecture : forte · Dépend de : W06, D08
- Cahier : M15, « Bail et annexes » ; M06, « Signature électronique AIMMO ».
- Objectif : faire signer le bail en vigueur (W06) par le bailleur et le locataire choisi avec la signature en ligne de D08, en mode essai ; ajoutée le 2026-10-28 par la voie 2, car W06 l'avait renvoyée à une tâche qui n'existait pas au plan.
- Critères : fournit `LeaseSignatureState.signedAt` à W08 (remise des clés, honoraires dus) ; seul le bail en vigueur et complet se signe [R101, R105] ; chaque partie signe l'empreinte du bail ; un bail remplacé après une signature demande de nouvelles signatures ; tant que H08 et H24 ne sont pas faits, la signature ne rend jamais un bail signé réel ; chaque partie reçoit le même exemplaire par le contrôle central.
- Attend : H08 et H24 pour un usage réel ; en mode essai d'ici là.

### W08 · Remise des clés sans argent pour AIMMO, gestion par un partenaire carte G
- Statut : fait (2026-10-28)
- Reste : fusionnée (#158) ; R107 en service ; migration `0908`. Relecture forte 1 P1 (état des lieux clos sous un autre bail) corrigé ; Codex 1 P2 (date impossible) corrigé. La signature du bail est lue par l'interface `LeaseSignatureState`, à fournir par W12 ; d'ici là, aucune remise des clés ni aucun honoraire dû en vrai.
- Décidé (2026-10-28, voie 2) : les honoraires sont la rémunération de l'agence, pas des fonds tenus pour autrui (R107), facturés par K02 ; un état des lieux clos vaut pour son seul bail, un nouveau bail en vigueur demande le sien.
- Qui : Claude, voie 2 · Relecture : forte · Dépend de : W07, U02
- Cahier : M15, « Remise des clés » ; Conformité, « Argent du locataire ».
- Objectif : la remise des clés : dépôt de garantie et premier loyer déclarés versés directement au propriétaire ; honoraires dus à la signature du bail ; proposition de gestion locative par un partenaire de M18 titulaire de la carte G.
- Critères : aucune table, aucune route et aucun texte ne fait recevoir par AIMMO un loyer ou un dépôt de garantie ; un compte bancaire d'AIMMO n'est jamais proposé au locataire [R107] ; la gestion locative passe par la mise en relation de M18, avec l'accord du propriétaire, à un partenaire dont la carte G est valide ce jour [R74, R73] ; les honoraires ne sont dus qu'une fois le bail signé.
- Attend : rien.

### W09 · Routes de M15 et parcours de 3 mises en location tests
- Statut : fait (2026-10-28)
- Reste : fusionnée (#162). Routes dans `packages/api/src/location.ts`, à brancher dans `app.ts` par W10 (voie 1) avec ses services (`identity` = coffre de conformité, `files` = stockage, IA facultatives). Relecture forte 1 P1 corrigé (R16 essayé sur chaque route et chaque rôle) ; Codex resté en cours 20 min, fusion sans lui.
- Décidé (2026-10-28, voie 2) : la remise des clés des routes lit `signedAt` (signature réelle), jamais `trialState()` ; aucun partenaire n'est admis sur `/v1/location`.
- Qui : Claude, voie 2 · Relecture : forte · Dépend de : W01 à W08
- Cahier : M15 ; Feuille de route, août 2027.
- Objectif : les routes `/v1/location` dans `packages/api/src/location.ts` ; le parcours de 3 mises en location tests de bout en bout.
- Critères : chaque route sous R16, rôle contrôlé avant le corps, refus au journal ; 3 mises en location inventées (vide en zone tendue, meublé hors zone, logement classé F dont le bail commence avant 2028) menées jusqu'à l'état des lieux signé, annonce conforme, honoraires sous le plafond ; un logement classé G bloqué avant toute annonce ; 20 candidatures inventées sans aucune pièce interdite.
- Attend : rien.

### W10 · Branchement de M15 dans le socle
- Statut : fait (2026-10-29)
- Décidé (2026-10-29) : routes de M15 servies par le socle, fermées (503) sans le stockage `PIECES`, identité lue au coffre (son état seul) ; passage `location.envois` de 9 h à 19 h ; accord demandé : `suivi_location` par mail ; seuls exclusion, arrêt, doublon et départ de l'agent qui a préparé refusent pour de bon (R02, R04, R05, R86), tout autre refus attend (heure, accord, adresse) ; texte devenu faux (classe corrigée, présentation refaite) jamais envoyé tant qu'il reste faux ; prénom lu sur la fiche réunie ; parenthèses des libellés officiels mises en incise à l'envoi.
- Reste : soldé, vérifié le 2026-11-02 : l'accord `suivi_location` se range depuis la fiche (AC03) ; `rental_sends` est dans la carte des demandes d'accès ; relecture forte 2 P1, Codex 1 P0 et 4 P2 corrigés (#164).
- Qui : Claude, voie 1 (fichiers du socle) · Relecture : forte · Dépend de : W09
- Cahier : M15 ; Branchements.
- Objectif : exporter `location` depuis `@aimmo/core` ; ajouter ses routes à `app.ts` ; lancer au planificateur les échéances des propriétaires ; passer les textes préparés par le contrôle central des envois, en mode essai.
- Critères : chaque texte préparé (échéance, reçu d'équité) passe par `envoi/controle.ts`, qui redécide au moment de l'envoi ; les passages tournent une fois par créneau ; rien ne part réellement tant que le plan ne l'a pas mis en service.
- Attend : rien.

### W11 · Écrans de M15 dans l'application
- Statut : fait (2026-10-29)
- Reste : fusionnée (#165). Ajouter une candidature depuis l'écran : réglé par W13 (#263) ; déposer depuis le téléphone une annexe, une preuve ou la notice : réglé par W14 (#265) ; relire le texte du bail après réouverture : réglé par W15 (#266).
- Décidé (2026-10-29, voie 2) : lectures `GET /location`, `/location/:id/suivi`, `/location/:id/presentation` ; l'état des lieux en cours (qui porte les noms des parties) n'est rendu qu'à qui voit les deux fiches en entier ; aucun état d'élément choisi d'avance ; textes du bail et séances de signature effacés à la sortie ; relecture forte 2 P1 et un trou de test corrigés, Codex 2 P0 et 2 P2 corrigés, dernière version validée par Codex (le script d’attente ne l’a pas vu).
- Qui : Claude, voie 2 · Relecture : forte · Dépend de : W09, Z03 (même fichier `packages/api/app/fichiers.ts`)
- Cahier : M15 ; exigence de design (protocole, section 9).
- Objectif : dans l'application de l'agent, l'écran « Louer » : contrôle du logement, annonce, candidatures dans leur ordre d'arrivée, bail, état des lieux pièce par pièce sur téléphone.
- Critères : l'écran lit seulement par les routes `/v1/location` [R16] ; aucune liste de candidats n'est triée ni notée [R105] ; écran accessible, beau sur téléphone d'abord, testé comme les autres (`fake-dom`).
- Attend : rien.

### W13 · Ajouter une candidature depuis l'écran « Louer »
- Statut : fait (2026-11-02)
- Voie : 2
- Décidé (2026-11-02, voie 2) : l'application n'avait plus que 55 octets de marge : tout l'écran « Louer » est sorti en `/app/louer.js`, chargé à la première ouverture ; seule une ligne change dans `agent-app.ts`, `fichiers.ts` n'est pas touché ; 500 contacts proposés au plus, d'une seule requête, pour ne pas dépasser les lectures d'une invocation.
- Qui : Claude, voie 2 · Relecture : forte · Dépend de : W11
- Cahier : M15 ; R104, R105, R16.
- Objectif : reste écrit de W11. L'agent ne peut pas ranger une candidature depuis l'écran : la route existe, l'écran ne la propose pas. Il choisit la fiche de la personne parmi ses contacts, sans saisir d'identifiant ; la candidature arrive en dernière place de l'ordre d'arrivée, sans note ni tri.
- Critères : l'écran ne lit et n'écrit que par `/v1/location`, et ne lit les contacts de l'agent qu'au geste d'ajouter (`GET /v1/location/:id/contacts`, ses fiches gardées) [R16] ; une personne réunie à une autre fiche n'a jamais deux candidatures sur un logement [R105] ; la liste reste dans l'ordre d'arrivée, sans note ni tri [R105] ; un refus de la route est dit en français, sans identifiant ni donnée [R104] ; un double appui ne range pas deux candidatures ; testé au clavier et sur téléphone comme les autres écrans (`fake-dom`) ; le budget de poids de l'application est tenu [R201].
- Attend : rien.

### W14 · Déposer depuis le téléphone une annexe, une preuve ou la notice du bail
- Statut : fait (2026-11-02)
- Voie : 2
- Décidé (2026-11-02, voie 2) : `R2PieceStore` reçoit `upload`, sans toucher au socle ; 20 Mo au plus ; PDF, JPEG, PNG, et texte pour une preuve dite à l'oral ; `louer.js` servi sans ses lignes de commentaire.
- Reste : fusionnée (#265) ; relecture forte sans P0 ni P1 ; Codex à sa limite (H03) ; dépôt réel avec H25 ; `louer.js` au bord de son budget [R201] : le prochain ajout à l'écran devra le découper.
- Qui : Claude, voie 2 · Relecture : forte · Dépend de : W11, W13
- Cahier : M15 ; R104, R16.
- Objectif : reste écrit de W11. L'écran « Louer » demande aujourd'hui de saisir la référence d'un fichier déjà rangé. L'agent doit pouvoir prendre la pièce sur son téléphone et la déposer, sans saisir de référence.
- Critères : droits contrôlés avant de lire le fichier [R16] ; type, premiers octets, taille et empreinte contrôlés ; journal sans contenu ni donnée personnelle [R13] ; un double appui ne dépose qu'un fichier ; refus dits en français [R104] ; budget tenu [R201].
- Attend : H25 pour le dépôt réel.

### W15 · Relire le texte du bail après réouverture de l'écran
- Statut : fait (2026-11-02)
- Voie : 2
- Décidé (2026-11-02, voie 2) : le texte n'est lu qu'au geste, pour un bail en vigueur et complet, sous les droits des deux fiches ; il reste en mémoire le temps de la session.
- Reste : fusionnée (#266) ; relecture forte 1 P1 corrigé (trou de test sur la fiche du locataire) ; Codex à sa limite (H03) ; un texte déjà lu reste affiché pendant la session sans repasser par le serveur ; un fichier déposé disparu du stockage donne le message général ; `louer.js` au bord de son budget [R201].
- Qui : Claude, voie 2 · Relecture : forte · Dépend de : W11, W14
- Cahier : M15 ; R16, R101.
- Objectif : reste écrit de W11. Le texte du bail ne se relit que sur l'appareil qui l'a préparé, tant que l'écran n'est pas fermé. L'agent doit pouvoir le relire avec les parties après une réouverture, sous les droits des deux fiches.
- Attend : rien.

**M16 · Commerces et entreprises, septembre 2027.**

Voie : 1

Découpé le 2026-10-29 par la voie 1 : toutes les tâches prêtes de la voie 1 attendent la fusion de leurs propositions (GitHub Actions arrêté, H35) ou un humain ; M16 est le seul module de la Feuille de route encore non découpé, laissé à la voie 1 par la voie 2 ; ses dépendances (M04, M06, M15) sont faites. Ids `CE..` pour Commerces et entreprises. Cahier : M16 Commerces et entreprises ; Conformité, « cession de fonds » ; Feuille de route, septembre 2027 : « Aucun dossier confidentiel envoyé sans engagement signé » ; critères « aucun dossier confidentiel envoyé sans engagement signé, sur 10 demandes tests », « chaque ouverture d'un document est journalisée avec son lecteur », « les délais de la cession sont justes sur 3 dossiers tests ».
Décidé, lecture prudente : un commerce est un bien de sorte `business` (fonds de commerce ou droit au bail), `business_walls` (murs) ou `commercial` (local professionnel), déjà prévues par la fiche client. Sa fiche est versionnée, chaque champ classé par le code dans une liste fermée « public » (activité en liste fermée, commune, fourchette de prix, surface, sorte) ou « confidentiel » (nom de l'enseigne, adresse, chiffres d'affaires et résultats, loyer et clauses du bail, salariés, matériel, autorisations) ; tout champ non listé est confidentiel par défaut [R110]. Rien de confidentiel ne sort en public ni ne part à une IA ; les bilans et les comptes ne sont jamais envoyés à l'IA, même résumés [R112, R15]. L'estimation est une fourchette calculée par le code seul, depuis les comptes saisis par l'agent et des barèmes par activité rangés par la direction avec leur source citée, jamais écrits dans le code ; l'agent la valide [R111, R10]. Aucun chiffre ni document confidentiel ne part sans engagement de confidentialité signé en ligne (signature de D08, en essai tant que H24 n'est pas fait) et pièce d'identité vérifiée par l'agent (état `identityVerifiedOn` du coffre de M12, jamais la pièce elle-même) : une seule porte `canSendConfidential`, utilisée par tout envoi [R113]. Un dossier envoyé l'est par un lien qui expire, chaque document porte un filigrane au nom du lecteur, et chaque ouverture, et chaque refus, est écrite au journal avec son lecteur [R114]. Le profil d'un repreneur (projet, expérience, apport et financement déclarés) ne porte aucune évaluation de solvabilité [R115, R14]. Les étapes de la cession (information des salariés au plus tard 2 mois avant sous 250 salariés, préemption de la commune en 2 mois dans un périmètre de sauvegarde, avis au journal d'annonces légales et au BODACC dans les 15 jours, 10 jours d'opposition, séquestre) sont calculées par le code, une étape bloquante non faite empêche de déclarer la cession prête [R116]. AIMMO ne reçoit jamais le prix : le séquestre est un tiers nommé, avocat, notaire ou banque, jamais le réseau [R117]. Une cession de fonds demande, avant le compromis, les bénéficiaires effectifs et l'origine des fonds déclarés ; leur absence lève une alerte au responsable de la conformité, sans rien décider à sa place [R118, R14]. Les documents protégés vivent derrière une interface de stockage (faux dans les tests, R2 réel plus tard, H38) ; rien n'est envoyé réellement, tout passe par le contrôle central des envois en mode essai [R26]. Règles R110 à R118, migrations à partir de `1001`. Le code vit dans `packages/core/src/commerces/`, ses routes dans `packages/api/src/commerces.ts` ; les fichiers du socle ne changent que par CE10.

### CE01 · Fiche du commerce, chaque champ public ou confidentiel
- Statut : fait (2026-10-30)
- Reste : prête (#197), à fusionner dès que GitHub Actions repart (H35) ; relecture forte sans P0 ni P1 ; Codex : 1 P1 (JSON illisible lu comme vide) et 1 P2 (date impossible) corrigés, relecture redemandée.
- Décidé (2026-10-29) : l'excédent brut d'exploitation est un champ facultatif de chaque exercice (`ebitdaCents`), ajouté par CE02 ; une colonne JSON illisible fait échouer la lecture plutôt que d'être lue vide [R17].
- Qui : Claude · Relecture : forte · Dépend de : rien (M02, M07 faits)
- Cahier : M16, « Fiche du commerce », « Règles », « Données ».
- Objectif : la fiche d'un bien `business`, `business_walls` ou `commercial` (migration `1001`) : activité (liste fermée), enseigne, chiffre d'affaires et résultat des 3 derniers exercices en centimes avec leur année, bail commercial (début, durée, loyer annuel, destination, clause de cession), nombre de salariés, matériel, autorisations propres à l'activité ; chaque version rangée, rien effacé ; chaque champ classé public ou confidentiel par une seule table du code ; une vue publique qui ne rend que les champs publics.
- Critères : un champ non classé est confidentiel (test qui énumère les colonnes et la table de classement) [R110] ; la vue publique ne contient aucun chiffre d'exercice, loyer, nom ni adresse, même si la fiche les porte [R110, R09] ; un champ hors liste ou une valeur hors liste est refusé, jamais ignoré ; une version ne change plus [R17] ; un autre agent est refusé, au journal [R16] ; un bien d'une autre sorte est refusé.
- Attend : rien.

### CE02 · Estimation en fourchette par le code, références citées
- Statut : fait (2026-10-30)
- Reste : prête (#198, empilée sur #197), à fusionner après CE01 dès H35 ; relecture forte 2 P1 corrigés.
- Décidé (2026-10-29) : méthodes `revenue_pct`, `ebitda_multiple` (excédent brut, jamais le résultat net) et `rent_yield` ; seule la plus récente estimation se valide, et seulement si la fiche et le barème n'ont pas changé depuis ; la fourchette publiable (`validatedRange`) suit la même règle.
- Qui : Claude · Relecture : forte · Dépend de : CE01
- Cahier : M16, « Estimation ».
- Objectif : des barèmes par activité (migration) rangés par la direction : méthode (pourcentage du chiffre d'affaires ou multiple de l'excédent brut), bornes basse et haute, source et date ; la fourchette d'un fonds calculée par le code depuis la moyenne des exercices saisis ; pour des murs ou un local, depuis le loyer et un taux de rendement réglé ; chaque nombre rendu avec sa source et son hypothèse ; validée par l'agent, versionnée.
- Critères : sur 5 commerces inventés, la fourchette est égale au centime à un calcul fait à la main écrit dans le test [R111] ; un barème sans source est refusé ; sans barème ou sans exercice, la réponse est « incomplet » avec ce qui manque, jamais un chiffre [R10] ; aucun appel à l'IA [R112] ; une estimation non validée n'est montrée à personne d'autre que l'agent.
- Attend : rien.

### CE03 · Présentation anonyme, rédigée par l'IA depuis les seuls champs publics
- Statut : fait (2026-10-30)
- Reste : prête (#200, empilée sur #198), à fusionner après CE02 dès H35 ; relecture forte 2 P1 corrigés (communes au nom chiffré, chiffres d'autres écritures) ; Codex, six tours : 6 P0, 2 P1 et 2 P2 corrigés (exposants, matériel court, nombre lié à son unité, enseigne courante, enseigne courte distinctive, nombre négatif, pluriel et singulier, mots porteurs du matériel, fourchette à tiret), relecture redemandée.
- Décidé (2026-10-29) : sans fourchette validée en vigueur, pas de présentation (« incomplet ») ; le nom de la commune est retiré avant le contrôle des nombres ; `publishable` est la porte, branchée à la publication de M07 par CE10.
- Qui : Claude · Relecture : forte · Dépend de : CE01, CE02
- Cahier : M16, « Présentation anonyme », « L'IA et l'humain ».
- Objectif : l'IA, derrière une interface (fausse dans les tests), rédige la présentation à partir de la seule vue publique (activité, secteur, fourchette validée) ; texte de secours sans IA ; contrôle du texte avant validation : aucun nombre absent de la vue publique, aucun mot de l'enseigne, de l'adresse ni d'un champ confidentiel ; l'agent valide, la présentation validée est publiable par la porte de M07.
- Critères : l'entrée de l'IA ne contient que des champs publics (test qui inspecte l'appel) [R112, R110] ; un texte qui cite un chiffre d'exercice, le loyer, l'enseigne ou la rue est refusé [R110, R09] ; « agent immobilier », jamais « mandataire » [R07] ; sans IA, le secours est rendu [R12] ; rien n'est publié sans validation de l'agent.
- Attend : rien (H13 pour la vraie IA).

### CE04 · Engagement de confidentialité signé et pièce vérifiée avant tout chiffre
- Statut : fait (2026-10-30)
- Reste : prête (#201, empilée sur #200), à fusionner après CE03 dès H35 ; relecture forte sans P0 ni P1 ; Codex rien à signaler.
- Décidé (2026-10-29) : modèle d'engagement versionné rangé par la direction (`business_nda_templates`), engagement au nom de la personne pour un bien ; signature par code comme D08 et W12, d'essai tant que H24 n'est pas fait ; la porte lit l'identité par l'interface `IdentityState` (état du coffre) ; `confidentialSheet` est le seul accès à la fiche complète pour un envoi (CE05).
- Qui : Claude · Relecture : forte · Dépend de : CE01
- Cahier : M16, « Accès aux chiffres » ; Conformité, « Confidentialité ».
- Objectif : une demande d'accès d'un repreneur reçoit tout de suite la vue publique ; l'engagement de confidentialité (modèle de M06) lui est ouvert à la signature en ligne de D08 ; une seule porte `canSendConfidential(bien, personne)` : engagement signé pour ce bien, empreinte intacte, et pièce d'identité vérifiée par l'agent (état du coffre, jamais la pièce).
- Critères : sur 10 demandes tests (signé ou non, pièce vérifiée ou non, engagement d'un autre bien, document modifié après signature, engagement révoqué), aucun dossier confidentiel n'est ouvert sans engagement signé et pièce vérifiée [R113] ; la réponse immédiate ne contient que la vue publique [R110] ; aucune pièce d'identité ni numéro de pièce n'est lu ni rangé hors du coffre [R15] ; chaque refus est au journal sans donnée personnelle [R13].
- Attend : rien (H24 pour une signature réelle).

### CE05 · Dossier protégé : lien qui expire, filigrane au lecteur, chaque ouverture journalisée (Jamais vu)
- Statut : fait (2026-10-30)
- Reste : prête (#203, empilée sur #201), à fusionner après CE04 dès H35 ; relecture forte 3 P1 corrigés ; Codex 1 P2 corrigé (code envoyé à l'adresse donnée), dernière version validée par Codex.
- Décidé (2026-10-29) : documents du dossier en texte, par référence de stockage et empreinte (PDF et images avec le stockage réel, H38) ; ouverture = adresse du lecteur et code à usage unique reçu à cette adresse ; marque de 48 bits en caractères sans largeur après chaque phrase et chaque ligne, doublée d'une référence de copie visible dans le filigrane.
- Qui : Claude · Relecture : forte · Dépend de : CE04
- Cahier : M16, « Accès aux chiffres » ; Conformité, « Confidentialité » ; Architecture technique, stockage des documents.
- Objectif : dès que la porte de CE04 s'ouvre, le dossier part (boîte d'essai) : un lien à usage limité qui expire (réglage), chaque page servie avec un filigrane au nom du lecteur et la date ; chaque ouverture et chaque refus (lien expiré, révoqué, autre lecteur) écrit au journal avec son lecteur. **Jamais vu** : chaque copie servie porte en plus une marque propre au lecteur et à l'ouverture, invisible à la lecture et retrouvable dans le texte : sur une copie qui a fuité, l'agent retrouve quel lecteur et quelle ouverture l'ont laissée sortir.
- Critères : chaque ouverture d'un document est journalisée avec son lecteur, une fois par ouverture [R114] ; un lien expiré, révoqué ou ouvert par un autre lecteur est refusé et journalisé [R114, R113] ; deux lecteurs reçoivent deux copies aux marques différentes, et le traçage retrouve le bon lecteur sur 20 copies tests, même recopiées sans mise en forme ; aucun document ne part sans la porte de CE04 [R113] ; rien ne part réellement [R26].
- Attend : rien (H38 pour le stockage réel).

### CE06 · Repreneurs, sans évaluation de solvabilité
- Statut : fait (2026-10-30)
- Reste : prête (#205, empilée sur #203), à fusionner après CE05 dès H35 ; relecture forte 1 P1 corrigé (biens vendus, retirés ou sans mandat écartés) ; Codex rien à signaler.
- Décidé (2026-10-29) : profil sur un projet `buy_business` ; secteurs en codes postaux ; le rapprochement passe par la porte de diffusion de D05 (injectée, branchée par CE10) et les biens en vente ou sous offre.
- Qui : Claude · Relecture : forte · Dépend de : rien
- Cahier : M16, « Repreneurs ».
- Objectif : le profil d'un repreneur (projet `buy` sur un commerce) : activités recherchées, secteurs, budget, expérience déclarée (liste fermée), apport et financement déclarés tels que dits ; versionné, chaque champ avec sa source ; rapprochement par le code avec les présentations publiées, sans note de la personne.
- Critères : aucun champ de revenus, de patrimoine, de crédit ni de solvabilité dans la table ni dans l'entrée (test qui énumère les colonnes) [R115, R14] ; le rapprochement ne trie ni ne note les repreneurs, seulement les biens, par des règles écrites [R14] ; un autre agent est refusé [R16] ; rien n'est inventé [R10].
- Attend : rien.

### CE07 · Étapes de la cession, délais calculés, étapes bloquantes
- Statut : fait (2026-10-30)
- Reste : prête (#207, empilée sur #205), à fusionner après CE06 dès H35 ; relecture forte 1 P0 et 3 P1 corrigés.
- Décidé (2026-10-29) : périmètre de sauvegarde rangé par commune (lecture prudente : toute la commune), commune non rangée = préemption à saisir, bloquante ; préemption exercée = cession jamais prête ; dernier jour avancé au jour ouvrable précédent pour les obligations (salariés, publications), reporté au suivant pour les délais subis (commune, oppositions) ; table du séquestre nommée `business_transfer_third_parties` (R107 interdit toute table de fonds) ; 250 salariés et plus : hors du régime, sans objet.
- Qui : Claude · Relecture : forte · Dépend de : CE01
- Cahier : M16, « Étapes de la cession » ; Conformité, « cession de fonds ».
- Objectif : le dossier de cession d'un fonds : information des salariés (moins de 250 salariés : au plus tard 2 mois avant la cession, lettre préparée, date de réception suivie, étape bloquante) ; préemption de la commune (périmètre de sauvegarde rangé par la direction avec sa source : déclaration, 2 mois pour répondre) ; avis au journal d'annonces légales et au BODACC dans les 15 jours après la cession, puis 10 jours d'opposition des créanciers ; séquestre nommé ; liste de contrôle des activités réglementées ; une tâche à l'agent avant chaque échéance, une seule.
- Critères : sur 3 dossiers tests (avec et sans salariés, dans et hors périmètre, fin de délai un dimanche), chaque date est égale à un calcul fait à la main écrit dans le test [R116] ; la cession ne peut être déclarée prête tant qu'une étape bloquante manque [R116] ; le séquestre ne peut être le réseau ni un agent, seulement un avocat, un notaire ou une banque nommés [R117] ; aucune date inventée : sans sa preuve, l'étape est « à saisir » [R10] ; rien n'est envoyé aux clients.
- Attend : rien.

### CE08 · Vigilance renforcée de la cession : bénéficiaires effectifs, origine des fonds
- Statut : fait (2026-10-30)
- Reste : prête (#208, empilée sur #207), à fusionner après CE07 dès H35 ; relecture forte 2 P1 corrigés ; Codex 1 P0 et 1 P2 corrigés (déclaration « société » sur les fiches réunies, demande liée à l'acquéreur en vigueur), relecture redemandée.
- Décidé (2026-10-29) : alertes dans leurs tables (`business_transfer_watch*`, hors du registre de L04 que seul L04 lit), une par dossier et par acquéreur, décisions de L04 ; personne morale rangée telle ou au moindre signe de société ; la liste du responsable de L04 les montrera au branchement (CE10).
- Qui : Claude · Relecture : forte · Dépend de : CE07
- Cahier : M16, « Règles » ; M12 Conformité.
- Objectif : sur un dossier de cession, les bénéficiaires effectifs de l'acquéreur personne morale et l'origine des fonds déclarés, rangés au coffre de M12 (jamais dans la fiche) ; leur absence avant le compromis lève une alerte au responsable de la conformité, par le registre de vigilance de L04.
- Critères : une cession sans bénéficiaires ou sans origine des fonds déclarés lève une alerte, une seule [R118] ; l'alerte ne bloque ni ne décide rien, la décision reste au responsable [R14] ; aucune pièce ni donnée de fonds dans la fiche client ni à l'IA [R15] ; l'agent ne voit pas l'alerte, seulement la demande neutre si le responsable la fait.
- Attend : rien (H29 pour le responsable réel).

### CE09 · Routes de M16 et parcours de 10 demandes tests
- Statut : fait (2026-10-30)
- Reste : prête (#209, empilée sur #208), à fusionner après CE08 dès H35 ; relecture forte 1 P1 corrigé (phrases refusées de l'IA rendues) ; Codex 1 P1 corrigé (test gardé par SQLite), relecture redemandée.
- Décidé (2026-10-29) : `commercesRoutes()` pour les rôles du réseau et `dossierReaderRoutes()` pour le lecteur sans compte (jeton, adresse, code) ; le lecteur ne lit jamais pourquoi la porte est fermée.
- Qui : Claude · Relecture : forte · Dépend de : CE01 à CE08
- Cahier : M16, « Critères d'acceptation ».
- Objectif : les routes `/v1/commerces` (fiche, estimation, présentation, demande d'accès, engagement, dossier, ouverture, repreneurs, cession) dans `packages/api/src/commerces.ts`, rôle refusé avant le corps ; un parcours de bout en bout sur 10 demandes tests et 3 dossiers de cession.
- Critères : aucun dossier confidentiel envoyé sans engagement signé sur les 10 demandes [R113] ; chaque ouverture journalisée avec son lecteur [R114] ; les délais justes sur les 3 dossiers [R116] ; aucune route publique ne rend un champ confidentiel [R110].
- Attend : rien.

### CE10 · Branchement de M16 dans le socle
- Statut : fait (2026-10-30)
- Reste : prête (#210, empilée sur #209), à fusionner après CE09 dès H35 ; relecture forte 2 P1 de tests corrigés ; pour un usage réel : H38 (stockage des documents) et H39 (`DOSSIER_LINK_BASE`).
- Décidé (2026-10-29) : sans `DOSSIER_LINK_BASE`, l'envoi du dossier répond 503 ; sans stockage, le dossier ne sert que la fiche ; les routes du lecteur passent avant le contrôle des clés, POST seulement ; tâche quotidienne `commerces.cession_quotidienne` à 6 h.
- Qui : Claude · Relecture : forte · Dépend de : CE09
- Cahier : M16, « Branchements ».
- Objectif : droits d'accès, `index.ts`, `app.ts`, migrations, planificateur (tâches de la cession), contrôle central des envois pour l'envoi du dossier.
- Critères : routes servies par le Worker ; la tâche quotidienne de la cession passe une fois par créneau ; tout envoi passe par le contrôle central en essai [R26].
- Attend : rien.

### CE11 · Écran « Commerces » dans l'application
- Statut : fait (2026-10-30)
- Reste : prête (#211, empilée sur #210), à fusionner après CE10 dès H35 ; relecture forte sans P0 ni P1 ; M16 complet côté voie 1 (CE01 à CE11 en onze propositions empilées).
- Décidé (2026-10-30) : trois lectures ajoutées pour l'écran (`GET /commerces`, `/commerces/:id/demandes`, `/commerces/:id/cession`) ; la lecture de l'état des demandes n'écrit pas de refus au journal ; script posé avant celui de « Louer ».
- Qui : Claude · Relecture : forte · Dépend de : CE10
- Cahier : M16 ; système de design de Z03.
- Objectif : sur téléphone d'abord, la fiche, l'estimation, la présentation à valider, les demandes d'accès et leur état, les ouvertures du dossier, les étapes de la cession.
- Critères : axe-core sans violation, clair et sombre ; dans le budget et le système de design [R201] ; aucun chiffre confidentiel affiché à qui n'a pas le droit [R110, R16].
- Attend : rien.

**M17 · Investir, septembre 2027.**

Voie : 2

Découpé le 2026-10-29 par la voie 2 : M15 est fini (W11 fusionnée) ; septembre 2027 compte M16 et M17, M16 est laissé à la voie 1 qui suit le plan dans l'ordre, M17 n'est commencé par aucune voie ; ses dépendances (M04, M06, M15) sont faites. Ids `Y..`. Cahier : M17 Investir ; Feuille de route, septembre 2027 : « Rendement de 10 biens identique au calcul manuel » ; critères « chaque note affiche ses sources et ses hypothèses », « un bien classé G porte l'alerte avant toute proposition à un investisseur qui veut louer ».
Décidé, lecture prudente : un investisseur est une personne de la fiche client avec un projet de type `invest` ; son profil (budget, apport déclaré, location visée vide, meublée ou colocation, secteurs, rendement attendu, délai) est rangé en listes fermées et en nombres, versionné, chaque champ avec sa source, jamais inventé ; aucune évaluation de sa solvabilité, aucun champ de revenus, de patrimoine ni de crédit [R123, R14]. Le rendement est calculé par le code seul, en centimes et en points de base, par des formules écrites (brut = loyer annuel de marché / coût total ; net avant impôt = loyer annuel moins charges non récupérables, taxe foncière déclarée, provision pour vacance réglée / coût total ; coût total = prix + frais d'acquisition + travaux estimés), jamais par l'IA ; chaque chiffre rendu porte sa source, sa date et l'hypothèse qui l'a fait [R120, R121]. Le loyer de marché est une estimation lue dans une table de la base : la Carte des loyers de l'ANIL (indicateur par commune, intervalle de prévision, nombre d'observations, millésime), importée par la direction avec sa source et sa date, ou, à défaut, les loyers des mises en location du réseau (M15) quand il y en a au moins 5 dans la commune sur 24 mois ; jamais écrit dans le code ni appelé en direct ; une commune à peu d'observations ou dont l'intervalle est large le dit dans la note ; la source est citée telle que l'ANIL la demande, « Estimations ANIL, à partir des données du Groupe SeLoger et de leboncoin » [R122]. Les contraintes (classe énergie et date d'interdiction de louer de M15, copropriété, règle de la commune rangée par la direction avec sa source) sont signalées sur chaque calcul ; un bien classé G (ou au-delà du seuil de consommation) porte l'alerte avant toute proposition à un investisseur qui veut louer, et aucune alerte ni note ne le propose sans elle [R124, R100]. Aucun texte n'est un conseil fiscal ni financier personnalisé ni une promesse de rendement : une liste fermée de tournures (« garanti », « sans risque », « assuré », « défiscalisation », « vous devriez », etc.) est refusée, et chaque note renvoie à un professionnel habilité pour la fiscalité et le financement [R125]. La note d'investissement est rédigée par l'IA derrière une interface, à partir du calcul seul, chaque nombre de la note relié à un champ du calcul, avec secours sans IA ; elle n'est montrée au client qu'après validation par l'agent [R126]. Les alertes de biens du fichier commun ne partent qu'aux investisseurs qui les ont demandées (accord rangé), par le contrôle central des envois, en mode essai [R03, R26]. Après l'achat : mise en location par M15 et partenaires de M18 par leur mise en relation, rien de neuf. Les numéros de règles R120 à R129 et de migrations à partir de `1101` sont réservés à M17 (R110 à R119 et `1001` restent pour M16). Le code vit dans `packages/core/src/investir/`, ses routes dans `packages/api/src/investir.ts` ; les fichiers du socle (droits d'accès, `index.ts`, `app.ts`, planificateur, Worker, contrôle central des envois) ne changent que par Y08, confiée à la voie 1.

### Y01 · Profil investisseur, sans solvabilité
- Statut : fait (2026-10-29)
- Qui : Claude, voie 2 · Relecture : forte · Dépend de : rien (M02, M03 faits)
- Cahier : M17, « Profil investisseur », « Règles ».
- Objectif : le profil d'un projet `invest` (migration `1101`) : budget en centimes, apport déclaré, location visée (vide, meublée, colocation), secteurs (codes INSEE), rendement brut attendu en points de base, délai (liste fermée) ; chaque version rangée avec sa source par champ (`agent`, `client_dit`, `qualification`) ; sous les droits de la fiche [R16].
- Critères : un champ inconnu ou hors liste est refusé, jamais ignoré ; aucun champ de revenus, d'emploi, de patrimoine, de crédit ni de solvabilité n'existe dans la table ni dans l'entrée (test qui énumère les colonnes) [R123] ; une version ne change plus, la suivante la remplace [R17] ; un autre agent est refusé, au journal [R16].
- Attend : rien.

### Y02 · Loyers de marché importés, avec source, date et fiabilité
- Statut : fait (2026-10-29)
- Reste : suite des remarques P2 de Codex (guillemets du CSV, reprises simultanées) en #176, en attente de GitHub Actions (H35)
- Qui : Claude, voie 2 · Relecture : forte · Dépend de : Y01
- Cahier : M17, « Rendement calculé par le code », « Règles », « Branchements ».
- Objectif : la table des loyers de marché (migration `1102`) : commune, type (appartement, maison, par nombre de pièces quand le millésime le donne), loyer au m² charges comprises, bornes de l'intervalle de prévision, nombre d'observations, millésime, source ; import par la direction d'un fichier CSV au format de la Carte des loyers de l'ANIL (jeu de test inventé), versionné, rien effacé ; repli sur les loyers des mises en location du réseau (au moins 5 dans la commune sur 24 mois, réglage) ; la réponse dit toujours sa source et sa fiabilité (« peu d'observations » sous 30 observations ou intervalle plus large que 40 % du loyer, réglages).
- Critères : un loyer n'est jamais écrit dans le code ni lu en direct sur Internet [R122] ; un fichier mal formé est refusé ligne à ligne sans rien ranger ; la mention de source ANIL est exactement celle demandée [R122] ; sans donnée, la réponse est « inconnu », jamais une valeur inventée [R10].
- Attend : H34 pour la mise en service (fichier réel de la Carte des loyers) ; les tests n’en ont pas besoin.

### Y03 · Rendement brut et net calculé par le code, chaque chiffre avec son hypothèse
- Statut : fait (2026-10-29)
- Qui : Claude, voie 2 · Relecture : forte · Dépend de : Y02
- Cahier : M17, « Rendement calculé par le code » ; Feuille de route, septembre 2027.
- Objectif : le calcul d'un bien pour un profil : prix (du bien ou saisi), frais d'acquisition (barème réglé, ancien ou neuf), travaux estimés (saisis avec leur source, ou issus de M04), loyer de marché (Y02) × surface, charges non récupérables et taxe foncière déclarées, vacance réglée (en mois par an) ; rendement brut et net avant impôt en points de base, arrondis par une règle écrite ; chaque ligne du résultat porte `value`, `source`, `asOf`, `hypothesis` ; le calcul est rangé, rejouable à l'identique depuis ses entrées [R120, R121].
- Critères : 10 biens tests inventés donnent au centime et au point de base près les rendements d'un calcul fait à la main, écrit dans le test ligne par ligne [R120] ; une entrée manquante rend « incomplet » avec la liste de ce qui manque, jamais un rendement [R10] ; aucun appel à l'IA dans le calcul [R121] ; aucun impôt ni régime fiscal n'est calculé [R125].
- Attend : rien.

### Y04 · Contraintes signalées : énergie, copropriété, règles de la commune
- Statut : fait (2026-10-29)
- Qui : Claude, voie 2 · Relecture : forte · Dépend de : Y03
- Cahier : M17, « Contraintes signalées » ; M15 (règles d'énergie).
- Objectif : sur chaque calcul, les contraintes : classe énergie et date d'interdiction de louer, par le code de M15 (`banDate`, seuil de 450 kWh/m²/an), copropriété (lue dans la fiche du bien de M07), règle de la commune (autorisation préalable de mise en location, permis de louer, encadrement des loyers, changement d'usage) rangée par la direction avec sa source et sa date (migration `1104`, `1103` prise par les calculs de Y03), jamais écrite dans le code.
- Critères : un bien classé G, ou au-delà du seuil, porte l'alerte « interdit à la location » avant toute proposition à un investisseur dont la location visée n'est pas « aucune » ; aucune note, aucune alerte, aucune proposition ne peut être faite sans cette alerte (test sur chaque chemin) [R124, R100] ; F et E portent leur date à venir ; une règle de commune sans source est refusée.
- Attend : rien.

### Y05 · Note d'investissement par l'IA, validée par l'agent (Jamais vu)
- Statut : fait (2026-10-29)
- Qui : Claude, voie 2 · Relecture : forte · Dépend de : Y04
- Cahier : M17, « Note d'investissement », « L'IA et l'humain », « Règles ».
- Objectif : la note rédigée par l'IA derrière une interface, avec secours sans IA, à partir du seul calcul et de ses contraintes ; **Jamais vu** : chaque nombre et chaque affirmation de la note est relié à une ligne du calcul (valeur, source, date, hypothèse), et la note rend, sous chaque paragraphe, la preuve de ses chiffres ; changer une hypothèse (vacance, travaux, loyer bas ou haut de l'intervalle) recalcule la note entière, et la fourchette basse/haute du rendement est toujours montrée à côté du chiffre central ; validation par l'agent seul avant tout envoi.
- Critères : un nombre absent du calcul, une tournure de la liste fermée (promesse, conseil fiscal ou financier personnalisé) ou une note sans sources ni hypothèses est refusée, et le secours prend le relais [R125, R126] ; la note cite la mention ANIL exacte quand le loyer vient de l'ANIL, et dit « peu d'observations » quand c'est le cas [R122] ; la note renvoie à un expert-comptable pour la fiscalité et à un courtier pour le financement [R125] ; la note d'un bien classé G porte l'alerte en tête [R124].
- Attend : rien (IA derrière une interface, faux dans les tests ; H13 pour l'IA réelle).

### Y06 · Alertes aux investisseurs qui les ont demandées
- Statut : fait (2026-10-29)
- Qui : Claude, voie 2 · Relecture : forte · Dépend de : Y05
- Cahier : M17, « Alertes » ; M08 (alertes aux acquéreurs).
- Objectif : quand un bien diffusable du fichier commun correspond au profil (secteur, budget, location visée, rendement brut attendu calculé par Y03), un texte d'alerte est préparé pour les seuls investisseurs dont l'accord aux alertes est rangé, avec le calcul et ses contraintes ; il passe par le contrôle central des envois, en mode essai.
- Critères : aucune alerte sans accord rangé [R03] ; un bien classé G n'est jamais proposé sans l'alerte, et jamais à un investisseur qui veut louer sans elle [R124] ; jamais deux fois le même bien à la même personne [R05] ; le texte passe le contrôle des tournures [R125] ; rien ne part réellement [R26].
- Attend : rien.

### Y07 · Routes de M17 et parcours de 10 biens tests
- Statut : fait (2026-10-30)
- Avancement (2026-10-29) : proposition #173 prête (relecture forte sans P0 ni P1, 1 P0 de Codex corrigé), en attente de ses vérifications : GitHub Actions ne démarre plus (facturation, H35). À fusionner dès que « Vérifier » passe et que Codex ne relève plus rien.
- Qui : Claude, voie 2 · Relecture : forte · Dépend de : Y06
- Cahier : M17 ; Architecture technique, API.
- Objectif : `packages/api/src/investir.ts` : routes `/v1/investir` (profil, import des loyers par la direction, calcul, contraintes, note, validation, alertes), rôle contrôlé avant le corps, refus au journal ; parcours de bout en bout de 10 biens tests ; après l'achat, ouverture de la mise en location de M15 et proposition de partenaires de M18 par leurs routes existantes.
- Critères : chaque route refuse tout rôle non admis avant de lire le corps [R16] ; les 10 biens tests rendent les rendements du calcul manuel [R120] ; chaque note rendue affiche sources et hypothèses [R126].
- Attend : rien.

### Y08 · Branchement de M17 dans le socle
- Statut : fait (2026-10-30)
- Avancement (2026-10-29) : proposition #185 prête, empilée sur #183 avec Y07 reprise ; tests verts en local ; relecture forte 1 P1 corrigé (barème des frais lu de la variable `INVESTIR_FRAIS_BAREME`, `750@AAAA-MM-JJ`) ; Codex sans remarque. À fusionner après #173 et #183, dès que GitHub Actions repart (H35).
- Qui : Claude, voie 1 (fichiers du socle) · Relecture : forte · Dépend de : Y07
- Cahier : M17 ; Branchements.
- Objectif : exporter `investir` depuis `@aimmo/core` ; ajouter ses routes à `app.ts` ; lancer au planificateur le passage des alertes aux investisseurs ; passer leurs textes par `envoi/controle.ts`, en mode essai.
- Critères : chaque alerte redécidée au moment de l'envoi par le contrôle central ; un passage par créneau ; rien ne part réellement tant que le plan ne l'a pas mis en service.
- Attend : rien.

### Y09 · Écran « Investir » dans l'application
- Statut : fait (2026-10-30)
- Avancement (2026-10-29) : fait sur la branche `chantier/Y09` (bâtie sur Y07), suite complète verte en local, relecture forte : 1 P1 corrigé (biens relus un par un par la couche d'accès, R82). Fusionnée le 2026-10-30 (#212), reprise sur main (branche `chantier/Y09-v2`). Décidé : le budget de 48 Ko était dépassé (51,5 Ko) ; le code de l'écran est un script à part, `/app/investir.js`, chargé à sa première ouverture comme `/app/conformite.js` et `/app/commerces.js` ; la même voie servira à X11 et aux écrans suivants. Relecture forte de cette version : 2 P1 corrigés (pas de liste d'identifiants liée à la requête, biens de l'agent lus à part).
- Qui : Claude, voie 2 · Relecture : forte · Dépend de : Y07
- Cahier : M17 ; exigence de design (protocole, section 9).
- Objectif : dans l'application de l'agent, l'écran « Investir » : profil, calcul d'un bien avec ses lignes et leurs sources, curseurs d'hypothèses (vacance, travaux, loyer bas ou haut), contraintes, note à relire et valider.
- Critères : l'écran lit seulement par les routes `/v1/investir` [R16] ; aucun chiffre n'est calculé sur le téléphone, tout vient du code du serveur [R121] ; l'alerte d'un bien classé G est en tête [R124] ; écran accessible, beau sur téléphone d'abord, testé comme les autres (`fake-dom`).
- Attend : rien.

### Y11 · Les règles de location d'une commune, à l'écran du réseau
- Statut : fait (2026-11-03)
- Qui : Claude, voie 2 · Relecture : forte · Dépend de : Y04, Y10
- Cahier : M17 ; R16, R10, R201.
- Objectif : trouvé le 2026-11-03 en comparant les routes aux appels de l'écran : `POST /v1/investir/regles` n'a aucun geste, donc aucun permis de louer ni encadrement ne peut être rangé, et les contraintes d'un bien n'en disent jamais rien. La vérification d'une commune, sur l'écran du réseau, dit ses règles ; la direction en range, avec leur source. Écrit dans `app/loyers.ts`, sans toucher au socle.
- Critères : la lecture et le formulaire vivent là où la direction arrive, et le formulaire suit `canRecord` [R16] (tests) ; chaque règle dit sa source et sa date [R10] (test) ; « aucune règle » n'est jamais dit comme une absence prouvée [R10] (test) ; une commune retapée sans relecture ne reçoit rien (test) ; une règle déjà finie est dite telle (test) ; refus dits en français, réponse perdue dite telle, double appui un seul envoi (tests) ; budget tenu [R201] (test).
- Attend : rien.

- Décidé (2026-11-03, voie 2) : lecture `GET /v1/investir/regles?insee=` ; d'abord écrit sur l'écran Investir, que la direction n'atteint pas, puis déplacé dans `app/loyers.ts`. Relecture forte : 5 P1 corrigés ; Codex à sa limite (H03), fusion sans lui (#315). Écran non ouvert dans un navigateur.
- Reste : pas de lecture à part pour les agents, les contraintes d'un bien leur disent déjà les règles.

### Y10 · Importer les loyers de marché depuis l'écran du réseau
- Statut : fait (2026-11-03)
- Décidé (2026-11-03), lecture prudente : trois appels de suite sans ligne de plus arrêtent l'import, et l'écran dit de redéposer le même fichier ; le même fichier sous un autre millésime est refusé (`millesime_different`), car le serveur répondait « complet » en gardant l'ancien ; un repli sur un autre type de logement est dit. Relecture forte : 2 P1 corrigés ; Codex à sa limite, fusion sans lui (#295). Écran non ouvert dans un navigateur.
- Trouvé le 2026-11-03 par la voie 1 : rien n'appelle `/v1/investir/loyers` à l'écran, et H34 demande à Shawez d'importer ce fichier. Vérifié au passage, à retirer des restes de la voie 2 : M09 comparatif et historique sont déjà à l'écran par `/suivi`, et M11 remerciements et satisfaction par `/apres-vente/dossiers`.
- Qui : Claude, voie 1 · Relecture : forte · Dépend de : Y02
- Cahier : M17, « Rendement calculé par le code » ; R122, R16, R10, R201.
- Objectif : la direction choisit le type et le millésime, dépose le fichier de la Carte des loyers depuis l'écran du réseau, voit l'avancée jusqu'au bout, et vérifie le loyer d'une commune.
- Critères : réservé à la direction [R16] (test) ; un fichier mal formé est dit ligne à ligne, en français, sans rien ranger [R122] (test) ; un gros fichier se range en plusieurs appels, sans fin s'il n'avance plus (test) ; réponse perdue dite telle [R10] (test) ; le loyer lu dit sa source exacte, sa date et sa fiabilité, « inconnu » sans donnée [R10, R122] (test) ; script à part, budget tenu [R201] (test).
- Attend : H34 pour le fichier réel.

**M19 · Studio, octobre 2027.**

Voie : 2

Découpé le 2026-10-29 par la voie 2 : M17 est fini côté voie 2 (Y08 attend la voie 1) ; octobre 2027 compte M19 et M20 complet, M16 reste à la voie 1, M19 n'est commencé par aucune voie ; ses dépendances (M07, M18) sont faites. Ids `X..`. Cahier : M19 Studio ; critères « 10 biens photographiés avec le guide, sans photographe, validés par Shawez », « une vidéo de bien montée seule sur un téléphone en moins de 10 minutes », « aucune adresse visible sur 20 visuels publiés ».
Décidé, lecture prudente : tout traitement d'image et tout montage se fait sur l'appareil de l'agent, jamais sur un serveur ; le serveur ne reçoit que des références de stockage, des empreintes et des descriptions contrôlées. Une photo ne reçoit que des corrections globales prises dans une liste fermée (exposition, balance des blancs, contraste, redressement des verticales, netteté, recadrage), décrites et rangées avec l'empreinte de l'original, qui reste gardé : aucune retouche locale, aucun effacement [R130]. L'aménagement virtuel garde sa mention sur l'image (R48, M07). Aucune adresse visible ni personne reconnaissable sans son accord rangé : chaque visuel passe une liste de contrôle validée par l'agent, et les textes (sous-titres, légendes, supports) passent le contrôle d'adresse de M07 [R132, R46]. Musiques et images seulement d'une bibliothèque dont la licence est rangée par la direction [R133]. Une publication est rédigée par l'IA derrière une interface avec secours, validée par l'agent, et part en mode essai par des canaux derrière une interface ; Meta, YouTube, Google et TikTok attendent leurs accès (H06, H07) [R134, R26]. Le plan du logement est indicatif : surfaces calculées par le code depuis les cotes saisies, mention « plan indicatif, non contractuel » [R135]. Les options payantes passent par la mise en relation de M18, rien de neuf. Les règles R130 à R139 et les migrations à partir de `1201` sont réservées à M19. Le code vit dans `packages/core/src/studio/`, ses routes dans `packages/api/src/studio.ts` ; les fichiers du socle ne changent que par X10, confiée à la voie 1.

### X01 · Guide de prise de vue pièce par pièce
- Statut : fait (2026-10-30)
- Avancement (2026-10-29) : proposition #174 prête, suite complète verte en local, relecture forte 2 P1 corrigés ; en attente des vérifications GitHub (H35). Migration `1201` prise par X01 : X02 à X07 prennent `1202` et suivantes.
- Qui : Claude, voie 2 · Relecture : forte · Dépend de : rien (M07 fait)
- Cahier : M19, « Guide de prise de vue » ; critère « 10 biens photographiés avec le guide ».
- Objectif : à partir de la fiche du bien de M07 (type, pièces, extérieurs), la liste des vues à faire, pièce par pièce, chacune avec sa consigne (où se placer, hauteur, lumière) écrite dans le code en liste fermée, et les vues à ne pas oublier ; l'avancement du bien : vues rangées (références de stockage de M07), vues manquantes, bien « prêt » quand toutes les vues obligatoires sont là ; la validation par Shawez (direction) d'un bien photographié avec le guide est rangée.
- Critères : chaque pièce de la fiche a ses vues et sa consigne (test sur les types de biens) ; une vue obligatoire manquante empêche « prêt » ; rien n'est inventé sur le bien [R10] ; sous les droits du bien [R16] ; la validation par la direction est rangée, une fois [R17].
- Attend : rien.

### X02 · Photos corrigées honnêtement, avec leur certificat (Jamais vu)
- Statut : fait (2026-10-30)
- Avancement (2026-10-29) : proposition #177 prête, empilée sur X01 (#174), migration `1202` ; suite complète verte en local (1746), relecture forte 2 P1 corrigés ; en attente des vérifications GitHub (H35). Branchement dans la publication par X05 et X10. X03 prend `1203`, X04 `1204`, X05 `1206`, X07 `1205`. Codex : 1 P0 (original vérifié dans le stockage par une interface, seule l'existence lue) et 1 P1 (fiche illisible au journal) corrigés, nouvelle relecture demandée.
- Qui : Claude, voie 2 · Relecture : forte · Dépend de : X01
- Cahier : M19, « Photos corrigées sur le téléphone », « Règles ».
- Objectif : la description des corrections faites sur l'appareil, rangée avec l'empreinte de l'original et celle du résultat (migration `1201`) ; **Jamais vu** : chaque photo publiée porte un certificat d'honnêteté lisible par le client (original gardé, liste des corrections globales, aucune retouche locale), vérifiable par un lien sans donnée personnelle.
- Critères : une opération hors de la liste fermée, ou une retouche locale, est refusée et la photo ne peut pas être publiée [R130] ; une photo sans original rangé ne se publie pas [R130] ; un aménagement virtuel garde sa mention (R48) ; le certificat ne porte ni adresse ni nom [R46, R13].
- Attend : rien.

### X03 · Montage vidéo sur l'appareil à partir d'un modèle
- Statut : fait (2026-10-30)
- Avancement (2026-10-29) : proposition #181 prête, empilée sur X04 (#179), migration `1203` ; une vidéo ne part plus qu'avec son montage rangé (musique contrôlée, `annonces/medias.ts`) ; suite complète verte en local (1761), relecture forte 1 P1 corrigé ; en attente des vérifications GitHub (H35). La bibliothèque est l'interface `MusicLibrary`, fournie par X07.
- Qui : Claude, voie 2 · Relecture : forte · Dépend de : X02
- Cahier : M19, « Vidéo du bien » ; M07 (plan de tournage, P06) ; critère « montée seule en moins de 10 minutes ».
- Objectif : le modèle de montage décrit par le code depuis le plan de tournage de P06 (ordre des plans, durées, sous-titres tirés de la fiche, musique de la bibliothèque, fin à la marque de l'agent) ; le montage se fait sur l'appareil ; le serveur range la description du montage fini et contrôle ses textes et sa musique (migration `1203`).
- Critères : une musique sans licence rangée est refusée [R133] ; un sous-titre qui porte une adresse est refusé [R46, R132] ; aucun fichier vidéo ne passe par le serveur, seule sa référence [R130] ; le modèle tient en 10 minutes de montage (test sur la durée prévue et le nombre de gestes).
- Attend : rien.

### X04 · Plan simple du logement depuis les mesures
- Statut : fait (2026-10-30)
- Avancement (2026-10-29) : proposition #179 prête, empilée sur X02 (#177), migration `1204` ; suite complète verte en local, plan rendu vérifié à 390 px ; en attente des vérifications GitHub (H35).
- Qui : Claude, voie 2 · Relecture : normale · Dépend de : X01
- Cahier : M19, « Plan simple du logement ».
- Objectif : des pièces rectangulaires saisies avec leurs cotes en centimètres et leur position, versionnées (migration `1204`) ; un plan SVG dessiné par le code, surfaces calculées par le code, mention « plan indicatif, non contractuel ».
- Critères : surfaces au cm² près d'un calcul fait à la main sur 5 plans tests [R135] ; une cote absente ou impossible est refusée [R10] ; le SVG ne porte ni adresse ni nom [R46] ; la mention est toujours là [R135].
- Attend : rien.

### X05 · Publications prêtes pour chaque bien, visite, offre, vente
- Statut : fait (2026-10-30)
- Avancement (2026-10-29) : proposition #184 prête, empilée sur X07 (#182), migration `1206` ; événement vérifié contre l'état du bien à la préparation et à l'envoi ; suite complète verte en local (1775), relecture forte 1 P1 corrigé ; en attente des vérifications GitHub (H35).
- Qui : Claude, voie 2 · Relecture : forte · Dépend de : X02
- Cahier : M19, « Réseaux sociaux », « L'IA et l'humain » ; M07.
- Objectif : à chaque événement (nouveau bien diffusable, visite, offre, vente), une publication préparée : texte par l'IA derrière une interface avec secours, visuels choisis parmi les photos certifiées, liste de contrôle des visuels (adresse visible, personne reconnaissable et son accord, aménagement virtuel) validée par l'agent ; publication en un geste vers les comptes de l'agent et du réseau, en mode essai, derrière une interface par réseau (migration `1206`).
- Critères : rien ne part sans la validation de l'agent [R134] ; un visuel sans liste de contrôle validée, ou avec une personne reconnaissable sans accord rangé, est refusé [R132] ; le texte passe le contrôle de M07 (adresse, mots interdits) [R46] ; un bien qui ne peut plus être diffusé ne part pas [R42] ; rien ne part réellement [R26].
- Attend : H06 et H07 pour les accès réels ; les tests n'en ont pas besoin.

### X06 · Supports imprimés à sa marque
- Statut : fait (2026-10-30)
- Avancement (2026-10-29) : proposition #186 prête, empilée sur X05 (#184) ; impression vérifiée sous Chromium (une page par support, deux pour la fiche, rien hors de la feuille) ; suite complète verte en local (1780) ; en attente des vérifications GitHub (H35). Codex : 1 P0 (mentions sur le panneau) et 1 P1 (impression testée sous Chromium, `supports-chromium.test.ts`, sauté là où Playwright manque, donc sur GitHub) corrigés.
- Qui : Claude, voie 2 · Relecture : normale · Dépend de : X02
- Cahier : M19, « Supports imprimés ».
- Objectif : fiche du bien, panneau, flyer, carte de visite et lettre de quartier, rendus par le code en pages imprimables (A4, A5, carte) sur le système de design, depuis la version publiée du bien et la fiche de l'agent, avec les mentions obligatoires de M07.
- Critères : chaque support passe le contrôle du système de design et d'accessibilité [R201] ; aucun support ne porte d'adresse exacte [R46] ; prix et mentions viennent de la version publiée [R44, R43] ; impression vérifiée sous Chromium comme P05.
- Attend : rien.

### X07 · Bibliothèque de musiques et d'images sous licence
- Statut : fait (2026-10-30)
- Avancement (2026-10-29) : proposition #182 prête, empilée sur X03 (#181), migration `1205` ; suite complète verte en local (1765) ; en attente des vérifications GitHub (H35). `MusicLibrary.licensedMusic` reçoit désormais le réseau. Codex : 1 P0 (retrait refusé au journal) corrigé, nouvelle relecture demandée.
- Qui : Claude, voie 2 · Relecture : normale · Dépend de : rien
- Cahier : M19, « Règles ».
- Objectif : la bibliothèque du réseau (migration `1205`) : chaque musique ou image avec sa source, sa licence, sa date et la preuve rangée par la direction ; X03 et X05 n'utilisent qu'elle.
- Critères : une entrée sans licence ni preuve est refusée [R133] ; une licence expirée ou retirée retire l'entrée des choix, sans rien effacer [R17] ; seule la direction range [R16].
- Attend : la liste réelle des musiques retenues par Shawez pour la mise en service ; les tests n'en ont pas besoin.

### X08 · Options payantes par les partenaires, et mesure des 20 visuels
- Statut : fait (2026-10-30)
- Avancement (2026-10-29) : proposition #187 prête, empilée sur X06 (#186), migration `1207` ; suite complète verte en local (1784) ; en attente des vérifications GitHub (H35).
- Qui : Claude, voie 2 · Relecture : normale · Dépend de : X05
- Cahier : M19, « Options payantes » ; M18 ; critère « aucune adresse visible sur 20 visuels publiés ».
- Objectif : la demande d'une option (photographe, drone, visite virtuelle, aménagement virtuel) passe par la mise en relation de M18, rien de neuf ; la mesure des 20 derniers visuels publiés : chacun avec sa liste de contrôle validée, le compte rendu montré à la direction.
- Critères : aucune option hors de M18 (accord du client, rémunération déclarée) [R74] ; la mesure compte 20 visuels et dit chacun sans adresse visible, ou le nomme [R132].
- Attend : rien.

### X09 · Routes de M19
- Statut : fait (2026-10-30)
- Avancement (2026-10-29) : proposition #188 prête, empilée sur X08 (#187) ; 21 routes, rôle contrôlé avant le corps, parcours de 10 biens du guide à la publication en essai ; relecture forte sans P0 ni P1 ; suite complète verte en local ; en attente des vérifications GitHub (H35).
- Qui : Claude, voie 2 · Relecture : forte · Dépend de : X08
- Cahier : M19 ; Architecture technique, API.
- Objectif : `packages/api/src/studio.ts` : routes `/v1/studio` (guide, corrections et certificat, montage, plan, publications et validation, supports, bibliothèque), rôle contrôlé avant le corps, refus au journal ; certificat public sans donnée personnelle.
- Critères : chaque route refuse tout rôle non admis avant de lire le corps [R16] ; parcours de 10 biens tests du guide à la publication en essai [R134].
- Attend : rien.

### X10 · Branchement de M19 dans le socle
- Statut : fait (2026-10-30)
- Où : proposition #190, empilée sur #185 et #188 ; relecture forte sans P0 ni P1 ; Codex : 8 P0 corrigés, 1 réfuté, dernière version (84738f3) sans remarque ; fusion en attente des vérifications GitHub (H35)
- Décidé (2026-10-29) : stockage du Studio = `MEDIA`, lu par l'existence seule (`head`) ; le socle ne transmet aucun canal de réseau, seuls ceux du mode essai existent ; page `/certificat-photo/<jeton>` dans `packages/api/src/certificat-photo.ts`, sans droits ni stockage ; une publication sur un réseau n'a pas de destinataire : elle ne passe pas par `ControleEnvois` (S06, qui décide d'un message à une personne) mais par ses propres contrôles revérifiés juste avant l'envoi (mode essai, validation, D05, mentions R43, textes R46 et R47, certificats R130, accords R132, auteurs partis R86), réponse à Codex dans #190
- Qui : Claude, voie 1 (fichiers du socle) · Relecture : forte · Dépend de : X09
- Cahier : M19 ; Branchements.
- Objectif : exporter `studio` depuis `@aimmo/core` ; ajouter ses routes à `app.ts` ; la page publique du certificat sur le Worker ; publications par le contrôle central, en mode essai.
- Critères : rien ne part réellement tant que le plan ne l'a pas mis en service ; la page du certificat passe le système de design [R201].
- Attend : rien.

### X11 · Écran « Studio » dans l'application
- Statut : fait (2026-10-30)
- Reste : fusionnée (#214) ; écran chargé à part (`/app/studio.js`), ouvert par le bouton « Studio » de chaque bien ; nouvelle route `GET /v1/studio/biens/:id` (atelier) ; relecture forte 3 P1 corrigés (original toujours proposé, empreinte du fichier réellement enregistré, réponse tardive testée) ; Codex à sa limite d'usage, fusion sans lui ; vérification locale verte (2095 tests). Décidé : sans route de dépôt de fichiers, l'écran ne range ni certificat ni vidéo ; la photo corrigée et l'original s'enregistrent sur le téléphone ; dépôt laissé à X12.
- Qui : Claude, voie 2 · Relecture : forte · Dépend de : X09, Y09 (même fichier `packages/api/app/fichiers.ts` et même budget de 48 Ko de l'application, presque plein après Y09 ; décidé le 2026-10-29 par la voie 2 pour ne pas croiser deux écrans non fusionnés)
- Cahier : M19 ; exigence de design (protocole, section 9).
- Objectif : dans l'application de l'agent, l'écran « Studio » : guide pièce par pièce avec l'appareil photo, corrections globales sur l'appareil, montage depuis le modèle, plan, publications à valider ; tout traitement sur l'appareil.
- Critères : l'écran lit seulement par les routes `/v1/studio` [R16] ; aucune image ni vidéo n'est envoyée à un serveur pour traitement [R130] ; écran accessible, beau sur téléphone d'abord, dans le budget de l'application (qui est presque plein : une passe d'allègement peut être nécessaire), testé comme les autres (`fake-dom`).
- Attend : rien.

### X12 · Dépôt de la photo corrigée et de son original, certificat rangé depuis l'écran
- Statut : fait (2026-10-30)
- Décidé (2026-10-30) : route `POST /v1/studio/biens/:id/fichiers/(photo|original|video)`, corps brut, empreinte dans `x-aimmo-sha256` ; type contrôlé par liste fermée et premiers octets ; bornes 20, 60 et 95 Mo ; ajout à la fiche protégé par `ifVersion` (aucune photo perdue entre deux dépôts) ; un fichier rangé mais refusé par la fiche reste dans le stockage, au journal ; relecture forte sans P0 ni P1 ; Codex à sa limite (H03), fusion sans lui (#215).
- Qui : Claude, voie 1 (route de dépôt et stockage `MEDIA` du socle) · Relecture : forte · Dépend de : X11 ; H25 pour le stockage réel
- Cahier : M19 ; Architecture technique.
- Objectif : une route de dépôt qui range sans le traiter le fichier fini (photo corrigée, original sous `biens/<bien>/originaux/`, vidéo montée) dans `MEDIA` et l'ajoute à la fiche ; puis, dans l'écran « Studio », ranger le certificat (`POST /v1/studio/biens/:id/photos`) et le montage après dépôt.
- Critères : le serveur ne transforme jamais le fichier reçu, son empreinte est recalculée et doit égaler celle dite par l'appareil [R130] ; un original n'est jamais publié ; rôle et portée vérifiés [R16] ; taille et type bornés.
- Attend : H25 pour le stockage réel.

**M20 · Gagner des mandats, module complet, octobre 2027.**

Voie : 2

Découpé le 2026-10-29 par la voie 2 : M19 est fini côté voie 2 jusqu'à X09 (X10 attend la voie 1, X11 attend la fusion de Y09) ; octobre 2027 compte M19 et M20 complet ; M16 reste à la voie 1 ; la première version de M20 (G01 à G05) est faite. Ids `G06` et suivants. Cahier : M20 Gagner des mandats, points 3 à 7, « Règles », « Branchements » ; dépendances faites ou prêtes : M04, M11, M18, M19 (X06 pour les supports imprimés).
Décidé, lecture prudente : une lettre de quartier n'est adressée qu'« Au propriétaire » ou « Aux habitants » d'une adresse saisie par l'agent dans le rayon réglé autour d'un bien dont le mandat est signé ou la vente rapportée ; jamais à un nom, jamais à partir des ventes publiques (DVF) ni d'une liste achetée [R140, R37]. Le dossier de présentation ne montre que des chiffres de la base, chacun avec sa source (ventes du quartier de M04, résultats de l'agent de M13, avis réels de M11 avec leur lien, jamais choisis ni réécrits), aucune promesse de prix ni de délai ; l'IA met en forme derrière une interface, avec secours sans IA [R141]. Une recommandation arrive avec sa source et la preuve de l'accord de la personne recommandée avant tout contact, jamais rémunérée à un particulier [R142, R66]. Un ancien contact n'est relancé qu'avec une base légale au jour de l'envoi (prospect à 3 ans de R97, client après la vente selon R65, accord en cours), au plus une fois par période réglée, par le contrôle central, en mode essai [R143, R03, R26]. La mesure mensuelle par source vient de la base ; les coûts sont saisis par la direction avec leur preuve ; garder ou arrêter une source reste une décision de la direction, jamais automatique [R144]. Aucun texte d'AIMMO ne promet des mandats à un agent [R145]. Les règles R140 à R149 et les migrations à partir de `1301` sont réservées à M20 complet. Le code vit dans `packages/core/src/mandats/gagner/`, ses routes dans `packages/api/src/gagner.ts` ; le plan du jour (`mandats/plan-du-jour.ts`, fonction du socle) et les fichiers du socle ne changent que par G12, confiée à la voie 1.

### G06 · Lettres de quartier, adressées sans nom
- Statut : fait (2026-10-30)
- Qui : Claude, voie 2 · Relecture : forte · Dépend de : rien (décidé le 2026-10-29 par la voie 2 : la lettre imprimable est faite avec le système de design de Z03, `design/systeme.ts` et `design/audit.ts`, déjà sur main, sans attendre la fusion de X06 ; ses routes rejoignent `gagner.ts` et le parcours de G11 part de la lettre)
- Cahier : M20, point 3 « Lettres de quartier », « Règles ».
- Objectif : après un mandat signé ou une vente rapportée, une campagne de lettres (migration `1301`) : adresses saisies par l'agent (numéro, voie, commune), contrôlées dans le rayon réglé autour du bien, sans aucun nom ; destinataire « Au propriétaire » ou « Aux habitants » ; texte par l'IA derrière une interface avec secours, contrôlé (adresse du bien vendu jamais citée, mots interdits) ; lettre imprimable par le système de design (X06), une par adresse ; dépôt noté par l'agent.
- Critères : un nom de personne dans une adresse ou un destinataire est refusé [R140] ; une source « ventes publiques » ou « liste achetée » est refusée [R37] ; sans mandat signé ou vente rapportée, aucune campagne [R140] ; l'adresse du bien n'apparaît jamais dans la lettre [R46] ; chaque lettre passe le contrôle du système de design [R201].
- Attend : rien.

### G07 · Dossier de présentation pour chaque rendez-vous de mandat (Jamais vu)
- Statut : fait (2026-10-30)
- Qui : Claude, voie 2 · Relecture : forte · Dépend de : G06
- Cahier : M20, point 4 « Dossier de présentation ».
- Objectif : pour un rendez-vous de mandat (M05), un dossier imprimable et lisible sur téléphone : ventes du quartier (M04, avec source et date), plan de vente (canaux de M07, Studio de M19), engagements de service rangés par la direction (versionnés), avis réels de M11 (lien et date, tous ceux de la période, jamais choisis), résultats de l'agent (M13, calculés) ; **Jamais vu** : chaque engagement de service affiché avec le taux réellement tenu par l'agent sur les 12 derniers mois, recalculé depuis le journal, et le détail qui le prouve.
- Critères : chaque nombre du dossier vient de la base avec sa source [R141] ; aucun avis choisi, réécrit ni inventé [R141] ; aucune promesse de prix ni de délai (liste fermée de tournures) [R141] ; le taux tenu de chaque engagement égale un calcul fait à la main sur un journal inventé ; rien qui situe un autre client [R46, R13].
- Attend : rien.

### G08 · Recommandations des clients et des partenaires, avec leur source
- Statut : fait (2026-10-30)
- Qui : Claude, voie 2 · Relecture : forte · Dépend de : rien (M11, M18 faits)
- Cahier : M20, point 5 « Recommandations » ; M11 ; M18.
- Objectif : une recommandation venue d'un client (M11) ou d'un partenaire (espace partenaire de M18) arrive dans la fiche (M02) avec sa source et la preuve de l'accord de la personne recommandée (migration `1302`) ; l'agent est alerté ; le mandat qui en naît garde la source « recommandation » (G03).
- Critères : sans preuve d'accord de la personne recommandée, aucun contact possible [R142, R03] ; aucun champ de récompense pour un particulier [R66] ; la source suit jusqu'au mandat [R38] ; un partenaire ne voit rien de la suite [R77].
- Attend : rien.

### G09 · Anciens contacts relancés quand la loi le permet
- Statut : fait (2026-10-30)
- Qui : Claude, voie 2 · Relecture : forte · Dépend de : rien
- Cahier : M20, point 6 « Anciens contacts », « Règles ».
- Objectif : chaque mois, la liste des anciens contacts relançables (prospects encore dans les 3 ans de R97, anciens clients selon R65, accords en cours), au bon moment par des règles écrites (anniversaire d'achat réglé, estimation de plus d'un an, fin de bail connue) ; décidé le 2026-10-29 sur la relecture de Codex : un client d'une vente faite avec l'agence n'est relancé que par les relances après la vente de M11 (accord à l'acte et désinscription, R65), l'anniversaire d'achat y reste et sort de G09 ; la relance préparée par l'IA derrière une interface avec secours, validée par l'agent, puis par le contrôle central en mode essai (migration `1303`).
- Critères : jamais sans base légale au jour de l'envoi [R143, R03, R36] ; une relance par période réglée au plus [R143, R05] ; exclus et arrêts jamais relancés [R02, R04] ; ordre par règles écrites, jamais une note de l'IA [R35] ; rien ne part réellement [R26].
- Attend : rien.

### G10 · Mesure mensuelle : garder ce qui rapporte des mandats
- Statut : fait (2026-10-30)
- Qui : Claude, voie 2 · Relecture : normale · Dépend de : G08
- Cahier : M20, point 7 « Mesure ».
- Objectif : chaque mois, par source : mandats signés (G03), rendez-vous, coût saisi par la direction avec sa preuve (migration `1304`), coût par mandat ; le compte rendu à la direction, qui décide de garder ou d'arrêter chaque source, sa décision rangée.
- Critères : chaque nombre recalculable depuis la base sur un jeu inventé [R144] ; aucune décision automatique [R144] ; aucune donnée personnelle dans le compte rendu [R13] ; seule la direction lit et décide [R16].
- Attend : rien.

### G11 · Routes de M20 complet
- Statut : fait (2026-10-30)
- Qui : Claude, voie 2 · Relecture : forte · Dépend de : G10
- Cahier : M20 ; Architecture technique, API.
- Objectif : `packages/api/src/gagner.ts` : routes `/v1/gagner` (lettres, dossier de présentation, recommandations, relances, mesure), rôle contrôlé avant le corps, refus au journal.
- Critères : chaque route refuse tout rôle non admis avant de lire le corps [R16] ; parcours d'un mandat test, de la lettre de quartier au mandat signé avec sa source [R38, R140].
- Attend : rien.

### G12 · Branchement de M20 complet dans le socle
- Statut : fait (2026-10-30)
- Décidé (2026-10-30) : le plan montre les relances « à valider » (une relance validée est déjà dans la boîte d'essai) ; la recommandation à rappeler est classée à la règle 1 avec les rappels demandés ; les lettres à déposer sont à part des personnes (`letters`), un compte par campagne, relu en direct ; la liste des relances passe chaque jour à 6 h (une par personne et par mois au plus) ; le 1er du mois à 8 h, l'avis de la mesure au journal, sans nombre ; une relance après la vente est refusée (R143) dans les 182 jours d'une relance d'ancien contact passée.
- Reste : fusionnée (#213) ; relecture forte 2 P1 corrigés (base entière de G09 relue au plan, cas sans base testés) ; Codex à sa limite d'usage, fusion sans lui ; vérification locale verte (2072 tests), GitHub Actions arrêté (H35).
- Qui : Claude, voie 1 (fichiers du socle) · Relecture : forte · Dépend de : G11
- Cahier : M20 ; Branchements.
- Objectif : ajouter au plan du jour les lettres à déposer, les recommandations à rappeler et les relances validées, sous leurs raisons écrites ; routes dans `app.ts` ; passage mensuel des relances et de la mesure au planificateur ; relances par le contrôle central, en mode essai.
- Critères : le plan reste le même pour les mêmes données [R35] ; aucune ligne sans base légale [R36] ; rien ne part réellement tant que le plan ne l'a pas mis en service [R26]. Les relances après la vente (F04, `apres-vente/relances-apres-vente.ts`) ne partent pas dans la période réglée de G09 après une relance d'ancien contact passée (`old_contact_followups` en `essai`), testé [R143].
- Attend : rien.

### G13 · Écran « Gagner des mandats » dans l'application
- Statut : fait (2026-10-30)
- Reste : fusionnée (#216). Décidé : deux lectures ajoutées pour l'écran, `GET /v1/gagner/lettres` (campagnes avec leurs comptes, biens qui peuvent en ouvrir une) et `GET /v1/gagner/rendez-vous` (estimations prévues de 3 h avant à 15 jours après, sans donnée du client) ; contrôle `promisesMandates` (R145) passé sur tous les textes de l'application ; lettres et dossier téléchargés avec la clé dans l'en-tête. Relecture forte sans P0 ni P1 ; Codex à sa limite d'usage, fusion sans lui ; vérification locale verte (2108 tests).
- Qui : Claude, voie 2 · Relecture : forte · Dépend de : G11, X11
- Cahier : M20 ; exigence de design (protocole, section 9).
- Objectif : lettres à préparer et à noter déposées, dossier de présentation à ouvrir avant un rendez-vous, recommandations, relances à valider, depuis l'application de l'agent.
- Critères : l'écran lit seulement par les routes `/v1/gagner` [R16] ; aucun texte ne promet de mandats [R145] ; écran accessible, beau sur téléphone d'abord, dans le budget de l'application, testé comme les autres (`fake-dom`).
- Attend : rien.


**M01 · Attirer, en continu à chaque module.**

Voie : 2

Découpé le 2026-10-29 par la voie 2 : M19 et M20 complet sont prêts côté voie 2 (propositions en attente de H35) ; la Feuille de route dit « M01 et M12 avancent en continu, à chaque module » ; M12 est découpé par la voie 1, M01 n'est commencé par aucune voie ; M16 reste à la voie 1. Ids `AT..` pour Attirer (`A..` est pris par l'application). Cahier : M01 Attirer ; critères « les pages de prix sont recalculées à chaque nouvelle publication des ventes DVF », « au moins 95 % des contacts entrants ont leur contenu d'origine renseigné », « un bien test apparaît sur le site de son agent et sur celui du réseau, avec une seule page de référence pour Google ».
Décidé, lecture prudente : M01 ne refait pas ce qui existe (page du bien et publication de M07, Studio et publications de M19, suivi de valeur de G04, estimation en ligne de E05) : il ajoute les pages de prix, la page de l'agent, le référencement, l'origine des contacts, la fiche Google, les pages de quartier et le simulateur. Les ventes publiques ne sont publiées qu'en chiffres regroupés, chaque case avec au moins 5 ventes (réglage), et jamais une case qui, par différence avec une autre page ou la version précédente, laisserait retrouver une vente [R150, R29]. Un prix de marché porte sa source et sa date, un prix d'annonce vient du mandat en vigueur [R151, R44]. À côté du nom de chaque agent : statut d'agent commercial, numéro d'immatriculation, carte du titulaire (réglages du réseau, H09) [R152]. Une seule page de référence par bien : celle du site de son agent s'il en a un, sinon celle du réseau [R153]. Fiche Google, signalement aux moteurs (IndexNow) et réseaux sont derrière une interface, en mode essai, avec un faux service dans les tests ; Google attend H07 [R26]. Tout texte rédigé par l'IA (réponse à un avis, publication Google, page de quartier) est relu et validé par un humain avant publication, ne porte que des faits de la base, aucun nom de client ni adresse exacte [R154, R155, R46, R07]. shawez-immo.com n'est pas touché : M01 construit le moteur commun, la bascule du site de Shawez est une tâche à part. Les règles R150 à R159 et les migrations à partir de `1401` sont réservées à M01. Le code vit dans `packages/core/src/attirer/`, ses routes dans `packages/api/src/attirer.ts` ; les fichiers du socle (et la chaîne de captation pour l'origine des contacts) ne changent que par AT10, confiée à la voie 1.

### AT01 · Prix par commune et par quartier, regroupés, sans vente retrouvable (Jamais vu)
- Statut : fait (2026-10-30)
- Avancement (2026-10-29) : proposition prête (#196) ; relecture forte : 1 P0 (deux zones différentes qui se soustraient, corrigé par un contrôle sur tout le réseau et des zones sans recouvrement) et 4 P1 corrigés, seconde relecture sans P0 ni P1 ; attend GitHub Actions (H35) pour fusionner. Décidé : une vente est reconnue d'une publication à l'autre par son empreinte (type, position, surface, prix au m², mois), avec une règle prudente pour une position corrigée ; une zone se corrige en la retirant, sans rien effacer ; une lecture DVF incomplète n'écrit aucune version.
- Qui : Claude, voie 2 · Relecture : forte · Dépend de : rien
- Cahier : M01, point 1 « Site public » (pages de prix), « Règles », « Données ».
- Objectif : à partir des ventes DVF (source de E02), des cases de prix par commune et par quartier, appartement et maison : médiane du prix au mètre carré, premier et troisième quartiles, nombre de ventes, période, source et date de publication DVF ; une version par publication DVF (avril, octobre), recalculée d'elle-même. **Jamais vu** : contrôle anti-différence, aucune vente ne peut être retrouvée en soustrayant deux cases publiées (commune moins ses quartiers, version moins version précédente) : une case qui le permettrait est fusionnée ou retenue, et la raison est dite.
- Critères : une case de moins de 5 ventes (réglage) n'est jamais publiée [R150] ; aucune case ne porte d'adresse, de numéro de voie, de date ni de prix d'une vente isolée [R29, R150] ; sur un jeu de ventes inventé, aucune paire de cases publiées (même version ou deux versions qui se suivent) ne laisse un reste de 1 à 4 ventes [R150] ; chaque case porte sa source et sa date de publication [R151] ; une nouvelle publication DVF donne une nouvelle version, la précédente reste lisible ; médiane et quartiles égaux à un calcul fait à la main.
- Attend : rien.

### AT02 · Pages de prix publiques
- Statut : fait (2026-10-30)
- Avancement (2026-10-29) : proposition prête (#206, empilée sur #196) ; attend AT01 et GitHub Actions (H35). Décidé : la page de référence (canonique) vient avec AT04 pour les deux sites ; une case retenue ne montre que sa raison, jamais un chiffre ; la page revérifie elle-même chaque case.
- Qui : Claude, voie 2 · Relecture : normale · Dépend de : AT01
- Cahier : M01, point 1 ; exigence de design (protocole, section 9).
- Objectif : la page de prix d'une commune et de chacun de ses quartiers, rendue depuis la dernière version de AT01, par le système de design : chiffres regroupés, source et date, explication de la méthode, lien vers l'estimation en ligne (E05), données structurées.
- Critères : seules des cases publiables de AT01 sont montrées [R150] ; chaque chiffre est suivi de sa source et de sa date [R151] ; « agent immobilier », « offert » [R07] ; la page passe le contrôle du système de design et tient dans 14 Ko compressés [R201].
- Attend : rien.

### AT03 · Page de chaque agent, avec ses mentions
- Statut : fait (2026-10-30)
- Avancement (2026-10-29) : proposition prête (#199) ; relecture forte : 1 P1 corrigé. Décidé : les avis sont montrés par le lien vers ceux que les clients publient eux-mêmes (celui de la demande d'avis de M11, envoyée à tous) ; les réponses de satisfaction de F05 ne sont jamais publiées, ni une à une ni en moyenne, car une moyenne qui bouge à chaque réponse laisserait lire la note d'un client ; le contact passe par les coordonnées publiques de l'agent, la captation viendra avec AT09. Attend GitHub Actions (H35).
- Qui : Claude, voie 2 · Relecture : forte · Dépend de : rien
- Cahier : M01, point 1 et « Règles » (vocabulaire, mentions de l'agent).
- Objectif : la page publique d'un agent : nom, zone, biens en vente (fichier diffusable seulement), avis réels de M11 tous montrés avec leur date, contact par la captation ; à côté du nom, statut d'agent commercial, numéro d'immatriculation, carte du titulaire.
- Critères : sans statut, numéro et carte du titulaire, la page n'est pas publiée et la raison est dite [R152] ; aucun avis choisi, trié ni réécrit [R64] ; aucune donnée de client [R16, R46] ; « agent immobilier », jamais « mandataire » [R07] ; contrôle du système de design et 14 Ko [R201].
- Attend : rien (le numéro de carte du réseau est un réglage, H09).

### AT04 · Référencement : plan du site, données structurées, page de référence unique
- Statut : fait (2026-10-30)
- Reste : fusionnée (#217). Décidé : sites réglés par la direction (`public_sites`, une adresse pour un seul site en service) ; le plan de chaque site liste chaque bien par sa page de référence, donc le plan du réseau porte des adresses du site de l'agent : AT09/AT10 devront servir un `robots.txt` du site de l'agent qui déclare ce plan (`Sitemap:`) ; données structurées sans voie ni code postal ; signalement IndexNow en essai, une fois par état, les pages de l'essai repartent une fois au passage en réel. Relecture forte sans P0 ni P1 ; Codex à sa limite, fusion sans lui ; vérification locale verte (2133 tests).
- Qui : Claude, voie 2 · Relecture : forte · Dépend de : AT02, AT03
- Cahier : M01, point 2 « Référencement » et « Deux sites, un seul moteur ».
- Objectif : plan du site de chaque site (biens publiés, agents, prix), données structurées des biens, des agents et des pages de prix ; page de référence (canonique) d'un bien : site de son agent s'il en a un, sinon site du réseau ; signalement aux moteurs (IndexNow) de chaque page modifiée, derrière une interface, en mode essai.
- Critères : un bien test publié apparaît dans le plan des deux sites avec la même page de référence [R153] ; un bien retiré sort du plan et est signalé [R153] ; aucune page de référence vers une page non publiée ; rien n'est réellement signalé en mode essai [R26] ; aucune adresse exacte dans les données structurées [R46].
- Attend : rien.

### AT05 · Origine des contacts : le contenu précis qui a amené chaque contact
- Statut : fait (2026-10-30)
- Reste : fusionnée (#219), migration `1405`. Décidé : un code porteur de 12 caractères tiré au hasard (`?o=`) par contenu ; une page de départ ne compte que si elle est publiée aujourd'hui sur un site en service du réseau, et ne crée jamais de contenu (un chemin venu de l'extérieur n'est jamais gardé) ; un contact est une conversation, comptée le mois de son premier message, heure de Paris. Pour AT10 : appeler `OrigineContacts.record(networkId, inboundId, { link, landingPage })` après la réception, enregistrer chaque contenu à sa publication par `contentFor` (vidéos et publications du Studio avec `linkPost`), mettre `taggedLink` sur leurs liens ; pages de quartier attendues sous `/quartiers/<commune>/<quartier>`. Relecture forte 1 P0 et 1 P1 corrigés ; Codex à sa limite ; vérification locale verte (2177 tests).
- Qui : Claude, voie 2 · Relecture : forte · Dépend de : AT04
- Cahier : M01, point 6 « Origine des contacts » ; critère « 95 % ».
- Objectif : chaque contenu public (page de bien, page de prix, page d'agent, vidéo, publication) a un identifiant ; une fonction lit l'origine d'un contact (lien porteur, page de départ, canal) et la range en liste fermée, sans cookie de suivi ni donnée personnelle ; la mesure mensuelle donne la part des contacts avec origine renseignée. Le branchement dans la chaîne de captation est fait par AT10.
- Critères : une origine inconnue est rangée « inconnue », jamais devinée [R156] ; aucune origine ne porte de donnée personnelle ni d'identifiant de navigateur [R156] ; sur 100 contacts inventés venus de contenus marqués, la mesure donne la bonne part, au moins 95 % ; le compte vient de la base.
- Attend : rien.

### AT06 · Fiche Google : publications et réponses aux avis préparées, validées
- Statut : fait (2026-10-30)
- Avancement (2026-10-29) : proposition prête (#204) ; relecture forte : 5 P1 corrigés, troisième relecture sans P0 ni P1 ; Codex : 3 P0 et 1 P2 corrigés (prénoms en toute casse, adresses numérotées, mandat revérifié avant publication [R42], texte périmé remplacé), relecture redemandée ; attend GitHub Actions (H35). Décidé : le nom de l'auteur d'un avis n'est jamais gardé (empreintes de ses mots seulement) ; une publication de bien ne porte jamais le prix, seulement le lien vers sa page ; une réservation sous index unique précède tout appel à Google.
- Qui : Claude, voie 2 · Relecture : forte · Dépend de : rien
- Cahier : M01, point 4 « Fiche Google » ; « L'IA et l'humain ».
- Objectif : derrière une interface Google Business Profile (faux service dans les tests) : informations de la fiche à jour depuis les réglages, publications régulières tirées des biens publiés, réponses aux avis préparées par l'IA (secours sans IA) et validées par l'agent ; en mode essai, rien ne part.
- Critères : aucune réponse ne cite le nom d'un client, une adresse, un prix de vente ni un détail du dossier [R154, R46] ; aucune réponse ni publication sans validation nommée [R154] ; aucune contrepartie proposée, aucun avis écrit à la place d'un client [R64] ; rien ne part en mode essai [R26].
- Attend : H07 pour le service réel.

### AT07 · Pages de quartier et articles, rédigés par l'IA depuis les données, relus
- Statut : fait (2026-10-30)
- Reste : fusionnée (#220). Décidé : textes de quartier en liste fermée de mots (titre et corps), chaque phrase porte une donnée de la base ; un prix exige le type de logement et le lieu de sa case, une année sa source nommée ; les biens publiés sont comptés à la commune (le bien n'a pas de position) ; validation par la direction seule, sur le texte exact et les données du moment ; page retirée dès qu'elle ne repasse plus le contrôle sur les données du jour ; aucun texte quand un sujet n'a aucune donnée (`sans_donnees`). AT09 servira `/quartiers/<commune>/<quartier>` et ses articles `/prix`, `/equipements`. Relecture forte : 3 P1 puis 1 P1 corrigés ; Codex à sa limite (H03), fusion sans lui ; vérification locale verte (2167 tests).
- Décidé (2026-10-30) : la voie 1 n'a plus aucune tâche prête (AT10 attend AT09, le reste attend un humain) ; elle prend AT07, qui ne dépend que de AT01, dans ses propres fichiers (`packages/core/src/attirer/quartier.ts`, migration `1470`), sans toucher ceux de AT05 (voie 2).
- Qui : Claude, voie 2 · Relecture : forte · Dépend de : AT01
- Cahier : M01, point 5 « Pages de quartier et articles ».
- Objectif : une page de quartier rédigée par l'IA derrière une interface (secours sans IA) à partir des seules données de la base : cases de prix de AT01, biens publiés, données publiques du quartier rangées avec leur source ; chaque nombre et chaque fait relié à sa source, comme l'annonce de P03 ; relue et validée avant publication.
- Critères : un nombre ou un fait absent des données refuse le texte [R155] ; aucune adresse exacte ni nom de client [R46] ; vocabulaire [R07] ; aucune publication sans validation nommée [R155] ; contrôle du système de design [R201].
- Attend : rien.

### AT08 · Simulateur de prêt, sans rien garder
- Statut : fait (2026-10-30)
- Avancement (2026-10-29) : proposition prête (#202) ; Codex : 1 P2 (taux presque nul) corrigé, relecture redemandée ; attend GitHub Actions (H35). Décidé : le calcul tourne dans le navigateur, la page ne prend aucune saisie, ses champs n'ont pas de nom, et ses en-têtes interdisent toute connexion et tout envoi de formulaire.
- Qui : Claude, voie 2 · Relecture : normale · Dépend de : rien
- Cahier : M01, point 1 « simulateur de prêt ».
- Objectif : un simulateur de mensualité (montant, durée, taux, assurance) calculé par le code, rendu sur la page publique ; mention « simulation indicative, ce n'est pas une offre de prêt » ; aucune donnée saisie gardée ni envoyée.
- Critères : mensualités égales au calcul de référence à l'euro près sur 10 cas inventés ; mention toujours visible [R157] ; aucune saisie rangée, envoyée ni écrite au journal [R157] ; aucun avis de solvabilité [R14] ; contrôle du système de design [R201].
- Attend : rien.

### AT09 · Routes de M01 et pages publiques
- Statut : fait (2026-10-30)
- Reste : fusionnée (#222). `attirerRoutes()` (24 routes sous `/attirer`, rôles avant le corps, refus au journal), `handleAttirerPublic()` (prix et quartiers sur le site du réseau seulement, agent sur le réseau et son site, simulateur, `sitemap.xml`, `robots.txt` qui déclare le plan du site lui-même ; noindex en essai ; 404 sans détail) et `listingReference()` (page de référence unique d'un bien, en-tête `Link` et données structurées). Relecture forte 1 P1 corrigé (page de référence absente de la page du bien) ; Codex à sa limite ; vérification locale verte (2199 tests).
- Qui : Claude, voie 2 · Relecture : forte · Dépend de : AT02 à AT08
- Cahier : M01 ; Architecture technique.
- Objectif : routes `/v1/attirer` (versions de prix, page de l'agent, validations des textes, plan du site, mesure de l'origine) et pages publiques (prix, agent, quartier, simulateur), dans `packages/api/src/attirer.ts`, prêtes à brancher.
- Critères : chaque route vérifie le rôle et la portée [R16] ; parcours d'un bien test sur les deux sites, une seule page de référence [R153] ; aucune page publique ne sert une case non publiable [R150].
- Attend : rien.

### AT10 · Branchement de M01 dans le socle
- Statut : fait (2026-10-30)
- Reste : fusionnée (#223). Origine rangée après les réponses pour chaque message lisible, une seule fois ; `link` et `landingPage` du formulaire et de l'assistant lus, jamais rangés ; tâche `attirer.prix` à 5 h ; relecture forte 1 P1 corrigé ; Codex à sa limite (H03) ; vérification locale verte (2193 tests). Les routes de AT09 viennent avec AT11.
- Décidé (2026-10-30, voie 1) : la voie 1 n'a aucune autre tâche prête et AT09 (voie 2) n'est pas commencée ; AT10 est scindée : AT10 branche maintenant ce qui ne dépend pas des routes de AT09 (origine du contact dans la chaîne de captation, recalcul des prix au planificateur à chaque publication DVF) ; le branchement des routes de AT09 dans `app.ts` passe en AT11.
- Qui : Claude, voie 1 · Relecture : forte · Dépend de : AT09
- Cahier : M01 ; Architecture technique.
- Objectif : brancher les routes de AT09 dans `app.ts`, le recalcul des prix au planificateur à chaque publication DVF, et l'origine du contact (AT05) dans la chaîne de captation.
- Critères : un contact entrant venu d'un contenu marqué garde son origine [R156] ; les pages de prix sont recalculées à la nouvelle publication DVF, sur horloge simulée [R150] ; la suite complète reste verte.
- Attend : rien.

### AT11 · Branchement des routes de M01 dans le socle
- Statut : fait (2026-11-01)
- Qui : Claude, voie 1 · Relecture : forte · Dépend de : AT09, AT10
- Cahier : M01 ; Architecture technique.
- Objectif : brancher les routes et pages publiques de AT09 dans `app.ts`, avec le `robots.txt` du site de l'agent qui déclare son plan (AT04).
- Critères : chaque route branchée répond sous son rôle et sa portée [R16] ; parcours d'un bien test sur les deux sites, une seule page de référence [R153] ; la suite complète reste verte.
- Ajouté (2026-10-30, voie 2, relecture forte de AT09) : poser `listingReference(s, request.url, bien)` sur la page du bien de `vitrine.ts` (en-tête `Link` canonique et données structurées), avec un test qui charge `/biens/b1` sur les deux sites et y trouve la même page de référence [R153].
- Attend : rien.

### AT12 · Écran « Attirer » de la direction : prix, sites et origine des contacts
- Statut : fait (2026-11-02)
- Voie : 2
- Décidé (2026-11-02, voie 2) : entrée sur l'écran du réseau, seul écran de la direction ; un geste qui coupe un site se confirme par deux appuis espacés, la demande retombe après 15 secondes ; le site d'un agent est en lecture seule jusqu'à AT15.
- Reste : fusionnée (#269) ; relecture forte 4 P1 corrigés ; Codex à sa limite (H03) ; en séance, `reprise-lancement` dépasse les 5 secondes de son test sur la machine à 2 cœurs (sans lien avec l'écran, vert sur GitHub) ; suite en AT15.
- Qui : Claude, voie 2 · Relecture : forte · Dépend de : AT09, AT11
- Cahier : M01 ; critère « au moins 95 % des contacts entrants ont leur contenu d'origine renseigné » ; R16, R150, R153, R201.
- Objectif : M01 a 24 routes sous `/v1/attirer` et aucun écran : sans clé d'API et sans outil, personne ne peut s'en servir. Depuis l'écran du réseau, la direction ouvre « Attirer » : dernières versions des prix et leur recalcul, sites en service et leur plan, part des contacts dont l'origine est connue, mois par mois, contre la cible. Chargé à part (`/app/attirer.js`).
- Critères : l'écran ne lit et n'écrit que par `/v1/attirer` [R16] ; il n'est proposé qu'à la direction ; il montre les chiffres du serveur, sans calcul ni tri à lui ; un refus est dit en français, sans code ni donnée ; tout texte reçu passe par `textContent` ; un double appui ne relance pas deux recalculs ; budget tenu [R201].
- Attend : rien.

### AT15 · Écran « Attirer » : communes et quartiers
- Statut : fait (2026-11-02)
- Voie : 2
- Décidé (2026-11-02, voie 2) : une zone retirée quitte aussitôt le site et son plan, une version demandée par son numéro se relit telle quelle ; contour hors des emprises de la France refusé (`hors_france`), quartier hors de l'emprise de sa commune à un dixième près refusé (`hors_commune`) ; plusieurs morceaux ou une enclave : à la direction de trancher, en le disant dans la source ; route de définition limitée à 64 Ko, six décimales.
- Reste : fusionnée (#271) ; relecture forte 5 P1 et 2 tests sans preuve corrigés ; Codex à sa limite (H03) ; temps de `ringsOverlap` à 2 000 points contre 2 000 non mesuré, à surveiller à la mise en service ; contour qui se croise lui-même accepté, non contrôlé.
- Qui : Claude, voie 2 · Relecture : forte · Dépend de : AT12, AT13
- Cahier : M01 ; R16, R150.
- Objectif : reste de AT13. Sans zone, ni prix ni page de quartier : la direction définit et retire une commune ou un quartier depuis l'écran, en collant son contour avec sa source.
- Critères : lecture des communes en service dans `attirer.ts`, sous R16 ; aucun identifiant à saisir ; slug tiré du nom ; contour illisible refusé à l'écran sans envoi ; retrait confirmé ; refus dits en français.
- Attend : rien.

### AT16 · Écran « Attirer » : mentions des agents et leurs sites
- Statut : fait (2026-11-02)
- Voie : 2
- Décidé (2026-11-02, voie 2) : `setSite` répond `agent_parti` au lieu de `agent_inactive`, que l'application lit comme une clé refusée ; « Mentions complètes » et non « Page publiée », une page exigeant aussi un site en service.
- Reste : fusionnée (#274) ; relecture forte 2 P1 de tests corrigés ; Codex à sa limite (H03) ; le titre d'une vidéo ou d'une publication reste sa référence du Studio, à revoir au branchement du Studio ; l'adresse d'un agent parti dont le dernier réglage est « en service » reste prise pour un autre agent (`url_taken`), sans geste à l'écran pour la libérer.
- Qui : Claude, voie 2 · Relecture : forte · Dépend de : AT12
- Cahier : M01 ; R16, R152, R153.
- Objectif : reste de AT12. Lectures ajoutées dans `attirer.ts` : les agents du réseau avec l'état de leur page et de leur site, y compris hors service, et le titre lisible d'un contenu (l'origine montre aujourd'hui l'identifiant d'un bien ou d'un agent). La direction y saisit les mentions, le titulaire de la carte, le site de chaque agent.
- Critères : aucun identifiant à saisir ni à lire [R16] ; un site d'agent mis hors service se rétablit depuis l'écran ; un refus `agent_inactive` de la route ne déconnecte pas la direction (`send` le lit comme une clé refusée : renommer ce code côté serveur) ; refus dits en français.
- Attend : H09 pour les vraies mentions.

### AT17 · L'adresse d'un agent parti se libère depuis l'écran
- Statut : fait (2026-11-03)
- Voie : 2
- Reste : fusionnée (#336) ; relecture forte 1 P1 de test corrigé ; Codex non attendu (H03) ; suite complète non terminée en local (coupée à 9 minutes), passée sur GitHub.
- Qui : Claude, voie 2 · Relecture : forte · Dépend de : AT16
- Cahier : M01 ; R16, R153.
- Objectif : reste de AT16. Le site d'un agent parti n'est plus servi, mais son dernier réglage « en service » garde l'adresse : aucun autre site ne peut la prendre (`url_taken`), et l'écran ne montre que les agents en activité, donc aucun geste ne la libère. L'écran « Attirer » liste les adresses gardées par un agent parti et les libère en deux appuis ; le refus dit la cause quand l'agent parti est du même réseau, sans rien dire d'un autre réseau.
- Critères : la lecture liste les agents partis dont l'adresse est gardée, et eux seuls, du seul réseau du lecteur [R16] (test) ; libérer se confirme, puis un autre site prend l'adresse [R153] (test) ; adresse gardée par un agent parti du réseau : refus propre, dit en français (test) ; adresse gardée dans un autre réseau : le refus reste `url_taken`, sans nom (test).
- Attend : rien.

### AT18 · Les vidéos et publications du Studio entrent dans la mesure de l'origine
- Statut : fait (2026-11-03)
- Voie : 2
- Reste : fusionnée (#338) ; relecture forte 1 P1 corrigé (la liaison passait entre l'envoi et sa trace) ; Codex non attendu (H03) ; la vidéo n'a son lien qu'avec AT20.
- Qui : Claude, voie 2 · Relecture : forte · Dépend de : AT16, X05
- Cahier : M01, M19 ; R16, R156.
- Objectif : reste de AT05 et AT16, trouvé en le lisant : rien dans le code ne range une vidéo ni une publication du Studio comme contenu (`contentFor`, `linkPost`, `taggedLink` ne servent que dans les tests), donc aucun contact n'en vient jamais, et leur titre serait leur référence interne. À l'envoi, la publication porte son lien marqué vers la page de référence du bien, et sa référence chez le réseau social est reliée quand le réseau la rend ; une vidéo a le même lien ; la direction lit un titre lisible.
- Critères : un contact arrivé par le lien d'une publication ou d'une vidéo est compté dessus [R156] (test) ; la référence rendue par un réseau relie la publication (test) ; bien sans page publiée : pas de lien, l'envoi part quand même (test) ; panne de l'origine : l'envoi part, la panne est au journal sans donnée (test) ; titre lisible, sans identifiant, et libellé général pour un contenu non retrouvé ou d'un autre réseau [R16] (test).
- Attend : rien.

### AT20 · L'agent reçoit le lien marqué de sa vidéo et de sa publication
- Statut : fait (2026-11-03)
- Voie : 2
- Reste : fusionnée (#340) ; relecture forte 3 P1 corrigés ; corrections non relues une seconde fois ; Codex non attendu (H03) ; copie réelle dans le presse-papiers non essayée (seul le repli « à la main » l'est) ; suite complète vérifiée sur GitHub seulement.
- Qui : Claude, voie 2 · Relecture : forte · Dépend de : AT18, X11
- Cahier : M01, M19 ; R16, R156.
- Objectif : l'agent poste lui-même ses vidéos : sans le lien marqué, le contact arrive sans origine. La route lit le lien de chaque publication validée et de chaque vidéo rangée, et l'écran Studio le montre, prêt à copier, avec la phrase qui dit où le coller.
- Critères : lien du seul bien de l'agent [R16] (test) ; bien non publié : le dire, sans lien (test) ; aucun identifiant de personne dans le lien [R156] (test) ; budget de l'écran tenu [R201] (test).
- Attend : rien.

### AT19 · Un contour de quartier qui se croise lui-même est refusé
- Statut : fait (2026-11-03)
- Voie : 2
- Reste : fusionnée (#339) ; relecture forte sans P0 ni P1 ; Codex non attendu (H03) ; première vérification coupée par le délai (X28), verte à la relance ; 2 000 contre 2 000 points : environ 800 ms sur la machine de la séance ; les zones déjà rangées ne sont pas recontrôlées ; des points presque alignés sans surface peuvent passer à cause des arrondis.
- Qui : Claude, voie 2 · Relecture : forte · Dépend de : AT15
- Cahier : M01 ; R150.
- Objectif : reste de AT15. Un contour qui se croise est accepté aujourd'hui : l'appartenance d'une vente à ce quartier devient incertaine, donc le prix publié aussi. Le refuser à la saisie, avec un message en français, et mesurer le contrôle de chevauchement à 2 000 points contre 2 000.
- Critères : contour croisé refusé, contour simple accepté, y compris concave (test) ; refus dit en français (test) ; 2 000 contre 2 000 points sous un temps borné (test).
- Attend : rien.

### AT13 · Écran « Attirer » : pages de quartier, du fait validé à la page publiée
- Statut : fait (2026-11-02)
- Voie : 2
- Décidé (2026-11-02, voie 2) : `drafts` dit si un texte est encore validable (`current`) et donne ses paragraphes tels que servis (`bodyParagraphs`) ; un retrait ne repasse aucun contrôle de contenu ; la clé d'un fait vient de son libellé, deux libellés qui se confondent sont refusés à l'écran.
- Reste : fusionnée (#270) ; relecture forte 5 P1 corrigés ; Codex à sa limite (H03).
- Qui : Claude, voie 2 · Relecture : forte · Dépend de : AT12
- Cahier : M01 ; R154, R155, R46.
- Objectif : la direction range un fait avec sa source, fait préparer le texte, le relit, le valide ; aucune page n'a d'adresse à saisir.
- Critères : lecture ajoutée de la liste des quartiers dans `attirer.ts`, sous R16 ; validation sur le texte exact affiché ; refus dits en français ; rien n'est publié sans validation humaine [R154].
- Attend : rien.

### AT14 · Écran « Attirer » : avis et publications Google, préparés et validés
- Statut : fait (2026-11-02)
- Voie : 2
- Décidé (2026-11-02, voie 2) : écran à part, « Fiche Google », ouvert par l'agent depuis l'accueil et par la direction depuis « Attirer » ; l'agent ne connaît pas son identifiant (`google/moi`) ; l'état de chaque texte vient du serveur ; une publication ne se corrige pas à la main, elle vient de l'annonce (`texte_a_revoir`).
- Reste : fusionnée (#277) ; relecture forte 1 P1 corrigé ; Codex en échec (H03) ; le planificateur ne lit pas les avis ni ne prépare de publication seul, seuls les gestes de l'écran le font ; le vrai client Google attend H07.
- Qui : Claude, voie 2 · Relecture : forte · Dépend de : AT12
- Cahier : M01 ; R154, R26.
- Objectif : chaque agent voit ses avis Google, fait préparer une réponse, la corrige, la valide ; rien ne part sans lui, et en essai rien ne part du tout.
- Critères : un agent ne voit que sa fiche [R16] ; validation sur le texte exact [R154] ; sans H07, l'écran dit que Google n'est pas branché, sans erreur ; refus dits en français.
- Attend : H07 pour le réel.

**Espaces propriétaire et acquéreur, juin 2027.**

Voie : 2

Découpé le 2026-11-01 par la voie 2 : M01 à M20 sont découpés et faits ; la Feuille de route livre en juin 2027 les « espaces propriétaire et acquéreur », qu'aucune tâche ne couvre encore (M10 prépare seulement leurs vues). Ids `EC..` pour Espaces des clients. Cahier : Le produit, tableau des espaces (« Espace propriétaire », « Espace acquéreur ») ; Feuille de route, juin 2027.
Décidé, lecture prudente : l'espace d'un client ne refait aucun module : il lit, par des interfaces, ce que les modules ont déjà rangé (visites et avis de M05 et M08, offres de M09, dossier de M10, point de la semaine de M08, candidatures, bail et état des lieux de M15, suivi de valeur de G04, rendement de M17), avec des faux dans les tests ; chaque geste du client (réserver une visite, écrire une offre, déposer une pièce) passe par la route du module qui le tient, avec ses contrôles [R165]. Le client entre sans mot de passe, par un lien personnel à usage unique que son agent lui ouvre une première fois avec son accord, puis qu'il redemande par son adresse mail ; le lien part par le contrôle central, en mode essai [R160, R26]. Un client ne voit que les dossiers où il est partie, champ par champ selon son côté [R161, R16]. Rien n'est inventé : chaque chiffre a sa source et sa date [R163, R10]. L'espace ne parle jamais de l'IA [R06]. Les règles R160 à R169 et les migrations à partir de `1501` sont réservées aux espaces. Le code vit dans `packages/core/src/espaces/`, ses routes dans `packages/api/src/espaces.ts` ; les fichiers du socle ne changent que par EC07, confiée à la voie 1.

### EC01 · Entrée du client dans son espace, sans mot de passe
- Statut : fait (2026-11-01)
- Décidé (2026-11-01) : le lien part en `alert` par le contrôle central, donc dans les heures d'envoi [R01] ; la nuit, il est révoqué et le client redemande. Accord et plafond suivent les fiches réunies ; le plafond est pris dans la même écriture que le lien. Relecture forte : 2 P1 corrigés ; Codex en échec, fusion sans lui (#226).
- Qui : Claude, voie 2 · Relecture : forte · Dépend de : rien
- Cahier : Le produit, tableau des espaces ; Conformité (accord, journal).
- Objectif : l'agent du client (ou la direction) ouvre l'espace d'une personne partie à au moins un dossier, avec la preuve de son accord pour recevoir son lien par mail ; un lien personnel, valable 30 minutes (réglage) et une seule fois, part par le contrôle central en essai ; ouvert, il donne une séance de 12 heures (réglage) ; le client redemande un lien par son adresse mail, avec une réponse identique que l'adresse soit connue ou non, et au plus 3 liens par 24 heures (réglage).
- Critères : seule l'empreinte du lien et de la séance est rangée [R160] ; un lien expiré, déjà ouvert ou inconnu est refusé, deux ouvertures en même temps n'en font qu'une [R160, R18] ; la demande par mail répond pareil pour une adresse inconnue, sans espace ou au plafond [R160] ; sans accord ou après son retrait, aucun lien ne part et la séance ne vaut plus [R03, R160] ; un client exclu ou arrêté ne reçoit rien [R02, R04] ; le journal ne porte ni adresse ni jeton [R13].
- Attend : rien.

### EC02 · Espace du vendeur : le suivi de la vente en direct
- Statut : fait (2026-11-01)
- Décidé (2026-11-01) : vue construite depuis la liste `CHAMPS_VENDEUR`, chaque texte restant retenu s'il cite une personne rattachée à une visite ou une offre, ou parle de l'IA ; 4 derniers points validés ; contrat écrit : les sources rattachent toujours le visiteur connu. Relecture forte : 1 P0 et 3 P1 corrigés ; Codex en échec, fusion sans lui (#227).
- Qui : Claude, voie 2 · Relecture : forte · Dépend de : EC01
- Cahier : Le produit, « Espace propriétaire » : visites, avis des visiteurs, offres, documents, signature en ligne, rendez-vous, point de la semaine.
- Objectif : la vue du vendeur, par bien : visites passées et à venir, avis des visiteurs, offres reçues et leur état, documents du dossier et ceux à signer, rendez-vous, derniers points de la semaine, date d'acte au plus tôt et ce qui la tient, lus par des interfaces.
- Critères : le vendeur ne voit que ses biens [R161, R16] ; ni nom ni coordonnée d'un visiteur ou d'un acquéreur, champ par champ selon une liste écrite [R161] ; chaque chiffre et chaque date avec sa source et sa date, une donnée absente dite « non communiquée » [R163, R10] ; aucun mot sur l'IA [R06].
- Attend : rien.

### EC03 · Espace du propriétaire : location, valeur suivie et documents rangés
- Statut : fait (2026-11-01)
- Décidé (2026-11-01) : comme W05, seuls les dossiers complets sont présentés, rangés par arrivée, avec les seules pièces du candidat ; les incomplets ne sont qu'un nombre ; la valeur n'est montrée que pour la commune du bien, avec au moins une source. Relecture forte : 4 P1 corrigés ; Codex en échec, fusion sans lui (#228).
- Qui : Claude, voie 2 · Relecture : forte · Dépend de : EC01
- Cahier : Le produit, « Espace propriétaire » : candidatures complètes sans classement, bail, état des lieux ; pour tous : la valeur estimée mise à jour s'il l'a demandé, ses documents au même endroit.
- Objectif : la vue du bailleur (candidatures complètes, bail, état des lieux) et, pour tout propriétaire, la valeur suivie s'il l'a demandée (G04) et ses documents rangés.
- Critères : candidatures dans leur ordre d'arrivée, sans note, tri ni avis de l'IA, sans pièce que la loi interdit de demander [R162, R14] ; valeur montrée seulement si le suivi est demandé et actif, en fourchette avec sa date et ses sources [R163] ; le propriétaire ne voit que ses biens [R161].
- Attend : rien.

### EC04 · Espace de l'acquéreur, de l'investisseur et du candidat locataire
- Statut : fait (2026-11-01)
- Décidé (2026-11-01) : les gestes passent par le port `GestesAcquereur` (un par module), branché en EC06 ; la retenue lit les vendeurs de tous les biens touchés (`sellersOf`), diffusables ou non ; favoris rangés ici (migration `1502`), sans aucun envoi. Relecture forte : 1 P0 et 1 P1 corrigés ; Codex en échec, fusion sans lui (#230).
- Qui : Claude, voie 2 · Relecture : forte · Dépend de : EC01
- Cahier : Le produit, « Espace acquéreur ».
- Objectif : alertes et biens proposés, favoris, réservation de visite, offre écrite, pièces du financement, suivi jusqu'à l'acte ; pour l'investisseur, rendement et contraintes (M17) ; pour le candidat locataire, ses visites et l'état de sa candidature.
- Critères : l'acquéreur ne voit du vendeur rien d'autre que le bien publié [R161] ; un favori ou une alerte ne part que s'il l'a demandé, par le contrôle central [R49, R03] ; une réservation, une offre ou une pièce passent par la route du module qui la tient, avec ses refus [R165] ; rendement avec ses hypothèses, jamais une promesse [R163].
- Attend : rien.

### EC05 · Relevé prouvé de l'espace (Jamais vu)
- Statut : fait (2026-11-01)
- Décidé (2026-11-01) : relevé texte rendu de façon déterministe depuis la vue, signé HMAC-SHA-256, vérifiable sans base ; rotation de clés ; caractères de contrôle et sauts cachés neutralisés, refusés à la vérification. Relecture forte : 1 P1 corrigé ; Codex en échec, fusion sans lui (#231).
- Qui : Claude, voie 2 · Relecture : forte · Dépend de : EC02
- Cahier : Le produit, « Espace propriétaire » ; Conformité (preuve).
- Objectif : **Jamais vu** : le client télécharge à tout moment un relevé daté de ce que son espace lui montre (chaque visite, avis, offre, document, chiffre avec sa source), signé par le réseau ; n'importe qui, avec le relevé seul, vérifie sur une page publique qu'il est intact et quand il a été fait, sans rien apprendre d'autre. Aucun réseau ni logiciel ne remet au vendeur une preuve vérifiable de ce qui lui a été dit et quand.
- Critères : un relevé modifié d'un seul caractère est refusé à la vérification [R164] ; la vérification ne rend que « intact, fait le … » ou « modifié » [R164, R16] ; le relevé ne porte rien d'un autre client [R161] ; la clé de signature n'est jamais dans le dépôt ni le journal ; deux relevés identiques à la même date ont la même empreinte.
- Attend : rien pour le construire ; la clé réelle de signature à ranger dans les secrets du Worker (signalée à EC07).

### EC06 · Routes et page de l'espace, parcours de 5 vendeurs et 5 acquéreurs tests
- Statut : fait (2026-11-01)
- Avancement (2026-11-01) : fusionnée (#232) ; pages sans script, lien ouvert par un bouton (un affichage ne le brûle pas), cookie `__Host-` SameSite=Strict, `Origin` exigé sur toute écriture. Relecture forte : 1 P1 corrigé ; Codex en échec, fusion sans lui.
- Qui : Claude, voie 2 · Relecture : forte · Dépend de : EC01 à EC05
- Cahier : Le produit, tableau des espaces ; Architecture technique.
- Objectif : `packages/api/src/espaces.ts` (routes de l'agent pour ouvrir un espace, routes du client par sa séance, page publique de vérification du relevé) et la page de l'espace, téléphone d'abord, dans le système de design.
- Décidé (2026-11-01, voie 2) : les lecteurs SQL des sources et le branchement des gestes sur les modules passent en EC08, pour garder une tâche d'une journée ; EC06 se teste avec des sources fausses et une vraie base pour l'entrée.
- Critères : chaque route sous son rôle ou sa séance [R16, R161] ; parcours de 5 vendeurs et 5 acquéreurs tests de bout en bout sans fuite d'un client à l'autre ; contrôle du système de design et budget de 14 Ko [R201] ; aucun envoi réel [R26].
- Attend : rien.

### EC08 · Lecteurs SQL de l'espace du vendeur
- Statut : fait (2026-11-01)
- Décidé (2026-11-01, voie 2) : tâche coupée en trois, pour tenir une journée : EC08 le côté vendeur, EC09 le propriétaire et l'acquéreur, EC10 les gestes. Les lecteurs reprennent les calculs des modules (`mandateTerms`, `ComparatifOffres`, `CheminCritique`, `sellerReportText`, `weeklyPointText`) sous le lecteur interne `system:espace` (direction), appelé seulement après le contrôle de l'espace. Un bien n'est au vendeur que si le dernier mandat vivant du bien (inscrit, ni annulé ni rétracté) est le sien ; tout part du premier mandat de sa dernière suite. Sans tableau des offres, aucun chiffre recomposé, l'échec au journal. Relecture forte : 1 P0 (vente suivante visible de l'ancien propriétaire) et 1 P1 (chiffres recomposés) corrigés ; Codex à sa limite d'usage, fusion sans lui (#233).
- Qui : Claude, voie 2 · Relecture : forte · Dépend de : EC06
- Cahier : Le produit, tableau des espaces ; Architecture technique.
- Objectif : `SqlClientParties` (côté vendeur) et `SqlSourcesVendeur`, dans `packages/core/src/espaces/sources-vendeur.ts`.
- Critères : sur le jeu de test de M10, le vendeur voit son vrai dossier et rien d'autre [R161] ; un visiteur ou acquéreur connu est toujours rattaché pour la retenue [R161] ; parcours de 5 vendeurs sur une vraie base sans fuite [R161] ; chaque chiffre avec sa source, absent « non communiqué » [R163].
- Attend : rien.

### EC09 · Lecteurs SQL de l'espace du propriétaire et de l'acquéreur
- Statut : fait (2026-11-01)
- Décidé (2026-11-01, voie 2) : tâche coupée, pour tenir une journée : EC09 le propriétaire et le bailleur, EC11 l'acquéreur, l'investisseur et le candidat locataire. Un bien est au dernier qui l'a pris (mandat vivant, mise en location à son nom, acte) ; l'acte le fait passer du vendeur à l'acquéreur ; un seul propriétaire par bien (deux fiches d'un couple ne le partagent pas : aucune fuite, l'agent réunit les fiches). Le côté `proprietaire` seul sert à l'acquéreur devenu propriétaire. Bail montré seulement réel, complet, et signé par une signature réelle (`REAL_LEASE_SIGNATURE`) ; valeur suivie seulement pour le seul logement du propriétaire dans la commune suivie, accord en cours. `rentalsOf` prend la personne. Relecture forte : 1 P1 corrigé (valeur non rattachée au bien), 1 P1 tranché par écrit ; Codex en échec, fusion sans lui (#234).
- Qui : Claude, voie 2 · Relecture : forte · Dépend de : EC08
- Cahier : Le produit, tableau des espaces ; Architecture technique.
- Objectif : les côtés bailleur, propriétaire, acquéreur, investisseur et candidat locataire de `SqlClientParties`, et les lecteurs SQL de `SourcesProprietaire` et `SourcesAcquereur` sur les tables de M08, M09, M10, M15, M17 et G04, dans `packages/core/src/espaces/`.
- Critères : un bailleur et un acquéreur voient leurs vrais dossiers et rien d'autre [R161] ; candidatures complètes seulement, dans l'ordre d'arrivée, sans pièce interdite [R162] ; un vendeur de bien touché toujours rattaché pour la retenue [R161] ; parcours de 5 acquéreurs sur une vraie base [R161].
- Attend : rien.

### EC11 · Lecteurs SQL de l'espace de l'acquéreur, de l'investisseur et du candidat locataire
- Statut : fait (2026-11-01)
- Décidé (2026-11-01, voie 2) : un bien proposé est un bien dont l'alerte de M08 ou M17 est partie (`sent`) ; montré seulement si sa dernière annonce est en vente ou sous offre et que la porte de D05 l'accepte ; champs : type, commune, surface, pièces, prix publié, classe énergie, date de publication. Offres par le tableau O06 ; pièces du seul côté acquéreur ; financement tel que déclaré ; date d'acte par la vue acquéreur du chemin critique. Rendement seulement d'une note validée remise par `forClient` de M17 (porte `InvestorNoteGate`, à brancher en EC07). Candidature : incomplète, complète en attente, retenue, non retenue. Personnes retenues par leur fiche gardée. Relecture forte : aucun P0 ni P1, 2 points limites corrigés ; Codex à sa limite, fusion sans lui (#235).
- Qui : Claude, voie 2 · Relecture : forte · Dépend de : EC09
- Cahier : Le produit, « Espace acquéreur » ; Architecture technique.
- Objectif : les côtés acquéreur, investisseur et candidat locataire de `SqlClientParties`, et `SqlSourcesAcquereur` sur les tables de M08 (biens proposés, alertes), M05 (visites), M09 (offres), M10 (dossier, pièces du financement, date d'acte), M17 (rendement) et M15 (candidature), dans `packages/core/src/espaces/sources-acquereur.ts`.
- Critères : un acquéreur voit ses vrais dossiers et rien d'autre [R161] ; un bien proposé n'est montré que diffusable, par les seuls champs de l'annonce [R161, R42] ; un vendeur ou bailleur de bien touché toujours rattaché pour la retenue (`sellersOf`) [R161] ; le candidat locataire ne voit que sa candidature, jamais un rang [R162] ; rendement avec ses hypothèses, jamais une promesse [R163] ; parcours de 5 acquéreurs sur une vraie base sans fuite [R161].
- Attend : rien.

### EC10 · Gestes du client branchés sur les modules
- Statut : fait (2026-11-01)
- Décidé (2026-11-01, voie 2) : `GestesModules` appelle chaque module sous `system:espace`, jamais au nom d'un agent ; la visite passe par `Visites.schedule` avec la source `espace` et l'auteur `client:<séance>`, sans canal de confirmation ; l'offre passe par le registre de M09 avec l'acquéreur et l'heure fixés par le serveur, sur un document signé présent dans le stockage, et un renvoi avec la même clé rend l'offre déjà enregistrée ; le financement passe par la nouvelle `FinancementDossier.declareByBuyer` (déclarant « acquéreur », dossier clos refusé) ; demander les alertes range l'accord `alertes_biens` par mail, case cochée, et M08 envoie seul par le contrôle central. Relecture forte : 3 P1 corrigés ; Codex en échec, fusion sans lui (#236).
- Qui : Claude, voie 2 · Relecture : forte · Dépend de : EC11
- Cahier : Le produit, « Espace acquéreur » ; Architecture technique.
- Objectif : le port `GestesAcquereur` branché sur les routes métier de M05 (visite), M09 (offre), M10 (pièce du financement) et M08 (alertes), dans `packages/core/src/espaces/`.
- Critères : chaque geste rend le refus du module, sans le contourner [R165] ; une alerte ne part que demandée, par le contrôle central [R49, R03] ; aucun envoi réel [R26].
- Attend : rien.

### EC07 · Branchement des espaces dans le socle
- Statut : fait (2026-11-01)
- Décidé (2026-11-01, voie 1) : pages `/espace/` servies par le socle avant `/v1`, sans clé, mode essai seul ; route de l'agent dans le routeur commun ; variables `ESPACE_NETWORK_ID` et `ESPACE_BASE` (sans elles : 503 `espace_not_configured`), secret `ESPACE_RELEVE_KEYS` (`nom:secret`, rotation, mal formé : relevé indisponible) ; offres signées lues dans `PIECES`, absent : refusées ; rendement par `forClient` de M17. Relecture forte : aucun P0, 1 P1 (routes à séance sans séance) corrigé par un test ; Codex non sollicité (H03), fusion (#237). Secret et variables : H40.
- Qui : Claude, voie 1 · Relecture : forte · Dépend de : EC06, EC08, EC09, EC10, EC11
- Cahier : Architecture technique.
- Objectif : brancher les routes et la page de EC06 dans `app.ts`, la séance du client à côté des clés d'API, et le secret de signature du relevé.
- Critères : chaque route branchée répond sous son rôle ou sa séance [R16, R161] ; sans secret de signature, le relevé répond « indisponible » ; la suite complète reste verte.
- Attend : une ligne de `HUMAIN.md` pour le secret de signature du relevé, à écrire par EC07.

**Preuve à Dijon et indicateurs, juillet 2027.**

Voie : 2

Découpé le 2026-11-03 par la voie 2 : M01 à M20 et les espaces sont faits ; la Feuille de route livre en juillet 2027 la « mesure de la preuve », et la condition de la phase 2 (« 10 mandats de vente signés par mois, six mois de suite, comptés à partir de janvier 2027, chiffres publiés ») n'a aucune tâche. Plusieurs indicateurs de l'onglet « Indicateurs et tests » n'ont pas non plus de calcul. Ids `IN..`. Cahier : Feuille de route ; Indicateurs et tests.
Décidé, lecture prudente : chaque chiffre vient de la base, jamais d'une saisie ni de l'IA ; aucun classement d'agent [R14] ; le compteur part du registre des mandats (R39), pas de la table des mandats : un mandat signé et pas inscrit ne compte pas, il est dit à part. Une annulation pour erreur ou une rétractation retire le mandat ; une résiliation le laisse compter, car il a bien été signé, et elle est dite à part. Un mois en cours ne compte jamais dans la série, même s'il a déjà 10 mandats. Règles R210 à R219 et migrations à partir de `1700` réservées à ce module. Le code vit dans `packages/core/src/pilotage/`, ses routes dans `packages/api/src/pilotage.ts` ; `app.ts` et `packages/core/src/index.ts` ne changent pas.

### IN01 · Le compteur de la preuve à Dijon
- Statut : fait (2026-11-03)
- Reste : fusionnée (#343). Relecture forte 1 P1 de test corrigé, vérifié par mutation ; Codex non attendu (H03).
- Qui : Claude, voie 2 · Relecture : forte · Dépend de : D01, K05
- Cahier : Feuille de route, phase 2 ; Indicateurs et tests, « Mandats signés » et « Part des mandats exclusifs ».
- Objectif : pour la direction, mois par mois de Paris depuis janvier 2027 : les mandats de vente signés et inscrits au registre (simples, exclusifs, sans type connu), ceux retirés (erreur, rétractation), ceux résiliés, ceux signés et pas inscrits ; la série en cours, la meilleure série, et si la condition (6 mois de suite à 10 ou plus) est remplie. `GET /v1/pilotage/preuve`.
- Critères : seuls les mandats inscrits comptent, sur le mois de Paris de leur signature [R210] (test) ; erreur et rétractation retirent, résiliation compte et se voit [R210] (test) ; 6 mois complets de suite à 10 remplissent la condition, 5 non, un mois à 9 casse la série, le mois en cours ne compte pas [R211] (tests) ; une annulation tardive défait la condition [R211] (test) ; registre abîmé : condition jamais dite remplie [R211] (test) ; rien avant janvier 2027 (test) ; aucun chiffre par agent [R14] (test) ; la direction seule, refus au journal [R16] (test).
- Attend : rien.

### IN02 · Le mois scellé, puis publié, vérifiable par n'importe qui (Jamais vu)
- Statut : fait (2026-11-03)
- Reste : fusionnée (#344). Relecture forte 3 P1 corrigés (course qui cassait la chaîne, panne maquillée, coût non borné d'une route sans clé) ; R95 et R96 trouvés par les vérifications, corrigés ; Codex non attendu (H03).
- Décidé (2026-11-03), lecture prudente : le sceau tient lieu de comparaison au comptage manuel, mois par mois, plus strict que les 2 semaines du cahier ; les numéros du registre sont publiés pour qu'un mandant retrouve le sien (H46) ; la page reste non indexée en essai.
- Qui : Claude, voie 2 · Relecture : forte · Dépend de : IN01
- Cahier : Feuille de route, « chiffres publiés » ; Indicateurs et tests, « comparés à un comptage manuel avant d'être publiés ».
- Objectif : aucun réseau ne publie un compte de mandats que chacun peut vérifier. La direction scelle un mois fini : elle donne son comptage manuel, le code le compare et refuse un écart ; le sceau enchaîne une empreinte du mois sur celle du mois d'avant, à partir des lignes du registre, sans nom ni adresse. Une annulation après le sceau ne réécrit rien : le mois porte un nouveau sceau, l'ancien reste lisible, la correction se voit. La page publique rend les mois scellés, leurs empreintes et de quoi les recalculer.
- Critères : comptage différent refusé, avec l'écart [R212] (test) ; mois en cours ou registre abîmé refusés [R212] (test) ; recalcul indépendant de l'empreinte depuis ce que la page publie (test) ; correction par nouveau sceau, ancien gardé [R17, R212] (test) ; aucune donnée personnelle dans la page [R13] (test) ; budget et système de design [R201] (test).
- Attend : H27 pour la mesure réelle seulement.

### IN03 · Les indicateurs du parcours : transformation, délais, du rendez-vous au mandat
- Statut : fait (2026-11-03)
- Reste : fusionnée (#346). Relecture forte 1 P0 et 5 P1 corrigés ; Codex non attendu (H03).
- Qui : Claude, voie 2 · Relecture : forte · Dépend de : IN01
- Cahier : Indicateurs et tests.
- Objectif : pour une période, chacun avec ses lignes : contacts en rendez-vous, rendez-vous en mandats, mandats en ventes ; jours du mandat à l'offre acceptée puis de l'offre à l'acte ; minutes de l'ouverture de l'estimation à la signature ; part des mandats avec un client transmis par le réseau. Le réseau, jamais d'un agent contre un autre [R14].
- Critères : chaque chiffre recalculé à la main sur un jeu de test (tests) ; donnée absente dite telle, jamais un zéro inventé (test) ; droits [R16] (test).
- Attend : rien.

### IN04 · Les indicateurs du réseau : agents actifs, restés, contacts par zone
- Statut : fait (2026-11-03)
- Reste : fusionnée (#347). Relecture forte 4 P0 et 2 P1 corrigés ; Codex non attendu (H03).
- Décidé (2026-11-03), lecture prudente : R68 l'emporte sur la publication par zone : en petit réseau peu de zones se montrent ; tout se juge sur les agents qui ont reçu des contacts ce mois-là. Où : #347.
- Qui : Claude, voie 2 · Relecture : forte · Dépend de : IN01
- Cahier : Indicateurs et tests, « Agents actifs », « Agents restés au bout d'un an », « Contacts transmis par zone ».
- Objectif : agents ayant signé au moins un mandat dans le mois ; part des agents entrés il y a 12 mois et toujours actifs ; contacts transmis par zone, lisibles par chaque agent chaque mois, sans chiffre d'un autre agent.
- Critères : un agent lit les zones, jamais un autre agent [R14, R16] (test) ; un agent parti ne compte plus comme resté (test) ; une zone d'un seul agent n'expose rien de plus que ses propres chiffres (test).
- Attend : rien.

### IN05 · Écran « Preuve » de la direction
- Statut : fait (2026-11-03)
- Reste : fusionnée (#348). Relecture forte 4 P1 corrigés ; Codex non attendu (H03).
- Décidé (2026-11-03) : bloc relu avec le rapport du matin, dans `finances.js`, pour ne pas toucher au socle. Où : #348.
- Qui : Claude, voie 2 · Relecture : forte · Dépend de : IN01, IN02, IN03
- Cahier : Feuille de route ; R201.
- Objectif : la direction voit où en est la preuve, ce qui est à inscrire, et scelle un mois depuis l'application.
- Critères : droits [R16] (test) ; chaque refus dit en français (test) ; réponse perdue dite telle (test) ; un seul envoi à la fois (test) ; budget tenu [R201] (test).
- Attend : rien.

**Site du réseau, juillet 2027.**

Voie : 1

Découpé le 2026-11-03 par la voie 1 : la Feuille de route livre en juillet 2027 le « site du réseau », et M01 dit qu'il porte « tous les biens du réseau, la page de chaque agent, les prix de chaque commune, l'estimation et le recrutement ». Le site n'a aujourd'hui ni accueil, ni liste des biens, ni liste des agents, ni liste des prix, et `/estimation`, où mènent les pages de prix, n'existe pas : ces pages ne se trouvent que par un lien direct. Ids `RS..`. Cahier : M01, « Deux sites, un seul moteur » ; Feuille de route, juillet 2027.
Décidé, lecture prudente : les pages lisent ce que les modules ont rangé, rien n'est saisi deux fois ; aucun classement d'agent, biens du plus récent au plus ancien, agents par ordre alphabétique [R14] ; le site d'un agent ne montre que ses biens [R153] ; chaque page reste sans script, dans le budget et le système de design [R201]. L'ouverture réelle attend la société (H09) et le nom de domaine : tout reste non indexé en mode essai. Règles R220 et R221 ; R210 à R212 restent à la voie 2.

### RS01 · Tous les biens, et aucune annonce fantôme (Jamais vu)
- Statut : fait (2026-11-03)
- Décidé (2026-11-03), lecture prudente : un bien vendu, loué ou retiré dans le socle sort comme un mandat refusé ; la page, la fiche et les photos suivent la liste ; une annonce disponible reste une minute au plus en cache ; chaque lecture ne contrôle que les 24 biens de sa page, une page peut donc en montrer moins, et le dit si elle n'en a aucun.
- Reste : fusionnée (#345) ; relecture forte 5 P1 corrigés ; Codex non attendu (H03) ; vérification GitHub verte. Plan du site, origine des contacts et comptes de quartier gardent jusqu'à 15 minutes de décalage ; une commune sans bien acceptable reste proposée, et sa page le dit.
- Qui : Claude, voie 1 · Relecture : forte · Dépend de : AT11, D05
- Cahier : M01, « Deux sites, un seul moteur » ; R42, R43, R48, R153.
- Objectif : `GET /biens`, liste des biens publiés, du plus récent au plus ancien, filtrable par commune, par pages. **Jamais vu** : aucune annonce fantôme. Portails et réseaux affichent des biens vendus ou sans mandat jusqu'au prochain passage ; ici, chaque bien repasse la porte de diffusion à l'instant de la lecture, et la page dit l'heure de cette vérification. Un mandat échu ou rétracté retire le bien aussitôt, de la liste comme de sa page, sans attendre le passage de publication.
- Critères : un bien dont la porte refuse n'est ni listé ni servi, avant tout passage de publication [R220] (test) ; l'heure de la vérification est écrite (test) ; sur le site d'un agent, seulement ses biens ; sur le réseau, tous ; rien d'un autre réseau [R153, R16] (tests) ; prix et mentions de la version publiée, sans adresse [R44, R46] (test) ; une photo d'aménagement virtuel porte sa mention [R48] (test) ; même ordre pour tous, aucun agent mis en avant [R14] (test) ; page ou commune inconnue : 404 (test) ; le nombre de contrôles reste borné par la page demandée (test) ; budget et système de design [R201] (test).
- Attend : rien.

### RS02 · Accueil du site, et les chemins vers chaque page
- Statut : fait (2026-11-03)
- Décidé (2026-11-03), lecture prudente : l'accueil et le plan lisent la seule liste `sitePaths`, et aucune page n'y entre avant d'exister ; RS03 et RS04 y ajoutent `/agents`, `/prix` et `/estimation` ; `/rejoindre` n'y est que si les candidatures vont à ce réseau, car il répond 503 sinon ; le site d'un agent ne dit son nom qu'avec ses mentions [R152].
- Reste : fusionnée (#350) ; relecture forte 1 P1 de test corrigé ; Codex non attendu (H03) ; vérification GitHub verte. L'accueil et les pages fixes entrent au plan, mais ne sont pas signalés à IndexNow.
- Qui : Claude, voie 1 · Relecture : forte · Dépend de : RS01
- Cahier : M01, « Deux sites, un seul moteur ».
- Objectif : `GET /` sur le site du réseau et celui d'un agent : les derniers biens, et les chemins vers les biens, les agents, les prix, l'estimation et, sur le réseau, le recrutement. Ajouter ces pages au plan du site.
- Critères : aucun lien vers une page absente (test qui suit chaque lien de l'accueil) ; même porte que RS01 [R220] (test), y compris pour les biens de la page d'un agent, qui ne la passent pas encore (test) ; `/` hors d'un site en service reste 404 (test) ; plan du site complété [R153] (test) ; « agent immobilier », jamais « mandataire » [R07] (test) ; budget [R201] (test).
- Attend : rien.

### RS03 · Liste des agents et des communes
- Statut : fait (2026-11-03)
- Décidé (2026-11-03), lecture prudente : chaque liste va par pages (100 agents, 500 communes) pour tenir le budget à toute taille ; une commune dont seuls les quartiers ont une case publiée n'est pas listée.
- Reste : fusionnée (#351) ; relecture forte 1 P1 corrigé ; Codex non attendu (H03) ; vérification GitHub verte.
- Qui : Claude, voie 1 · Relecture : forte · Dépend de : RS02
- Cahier : M01 ; R14, R150, R152.
- Objectif : `GET /agents`, seulement ceux dont la page est publiable, par ordre alphabétique, sans aucun chiffre ; `GET /prix`, les communes dont la page de prix a au moins une case publiable. Réservées au site du réseau.
- Critères : l'accueil et le plan du site y mènent, ajoutés à `sitePaths` (test qui suit les liens) ; un agent sans ses mentions ou parti n'y est pas [R152] (test) ; aucun chiffre, note ni classement [R14] (test) ; une commune sans case publiable n'y est pas [R150] (test) ; 404 sur le site d'un agent [R153] (test) ; budget [R201] (test).
- Attend : rien.

### RS04 · L'estimation en ligne sur le site
- Statut : fait (2026-11-03)
- Décidé (2026-11-03), lecture prudente : un formulaire serveur sans clé, l'identifiant de visite vient d'un champ caché neuf à chaque page et ne suit personne, la limite du réseau tient dans tous les cas ; aucune coordonnée demandée, le rendez-vous passe par un lien ; sans données branchées, la page répond 200 et dit qu'elle n'est pas ouverte.
- Reste : fusionnée (#352) ; relecture forte 2 P1 corrigés ; Codex non attendu (H03) ; vérification GitHub verte. Le test CE22 du lecteur dépendait de l'heure réelle (rouge après 20 h à Paris) : il tourne sur une heure fixe. La fourchette réelle attend `DVF_BASE_URL` au déploiement.
- Qui : Claude, voie 1 · Relecture : forte · Dépend de : RS02
- Cahier : M01 ; M04, estimation en ligne (E05).
- Objectif : `GET /estimation`, où mènent déjà les pages de prix et qui répond 404 : la page qui appelle l'estimation en ligne de E05, ou, si elle ne peut pas être servie sans script ni clé, un formulaire serveur.
- Critères : le lien des pages de prix aboutit, et l'accueil et le plan du site y mènent, ajoutés à `sitePaths` (test) ; la fourchette est celle de E05, jamais une autre [R10] (test) ; accord et mentions de E05 repris [R03] (test) ; limites de E05 tenues (test) ; budget [R201] (test).
- Attend : rien.

### RS05 · Mentions légales et données personnelles du site
- Statut : fait (2026-11-03)
- Décidé (2026-11-03), lecture prudente : les mentions vivent dans `site_legal_mentions`, en ajout seul ; ce qui est gardé sur une personne vient du registre des traitements, mot pour mot ; tant qu'une mention manque, pages et signalement restent en essai (R221).
- Reste : fusionnée (#355) ; relecture forte 3 P1 corrigés ; Codex non attendu (H03) ; vérification GitHub verte. `/rejoindre` n'a pas encore le lien vers les pages légales. Contenu réel : H47, après H09.
- Qui : Claude, voie 1 · Relecture : forte · Dépend de : RS02
- Cahier : Conformité ; M01.
- Objectif : `GET /mentions-legales` et `GET /donnees-personnelles`, rendues depuis les réglages du réseau, liées depuis chaque page du site. Tant qu'une mention manque, la page dit qu'elle manque et le site ne peut pas passer en réel.
- Critères : aucune mention inventée [R10] (test) ; une mention manquante se voit (test) ; liée depuis l'accueil et la liste (test) ; budget [R201] (test).
- Attend : H09 pour le contenu réel ; textes à faire relire par l'avocat, à écrire dans `HUMAIN.md`.

### IN06 · Les indicateurs du parcours et du réseau à l'écran
- Statut : fait (2026-11-03)
- Reste : fusionnée (#349). Relecture forte 2 P1 de test corrigés ; Codex non attendu (H03).
- Qui : Claude, voie 2 · Relecture : forte · Dépend de : IN03, IN04, IN05
- Cahier : Indicateurs et tests ; R201.
- Objectif : la direction lit les taux, les délais et les agents actifs d'un mois sur « Le réseau » ; chaque agent lit les contacts par zone du mois passé sur « Mes chiffres ». Toujours dans `finances.js`, sans toucher au socle.
- Critères : donnée absente dite absente, jamais zéro [R214] (test) ; ce qui est retenu par R215 est dit sans chiffre (test) ; droits [R16] (test) ; réponse perdue dite telle (test) ; déconnexion et réponse en vol (test) ; budget tenu [R201] (test).
- Attend : rien.

### IN07 · Engagements de service tenus
- Statut : fait (2026-11-03)
- Reste : fusionnée (#353). Relecture forte 4 P0 et 3 P1 corrigés, sauf le formulaire sans moyen de répondre, qui reste manqué ; Codex non attendu (H03). G07 reste à l'ancienne mesure jusqu'à IN13.
- Coupée le 2026-11-03 : le temps gagné et la disponibilité n'avaient aucun calcul, et les engagements n'en avaient que pour deux (G07, par agent) ; IN08, IN09, IN10, IN11 et IN12 prennent le reste.
- Décidé (2026-11-03), lecture prudente : voir la tête de `packages/core/src/pilotage/engagements-tenus.ts`. Réponse : le premier message lisible d'une conversation, dans la minute ; « le jour même » : le jour de Paris, sans excuse pour le soir, le chiffre reste sévère ; client transmis : dans la minute (critère de M03) ; délais fixés par le cahier, pas par les réglages de G15 (qui disent au client ce que l'agent a tenu). Mesuré sur 8 des 9 lignes : la base ne date pas la mise en vente, l'alerte se dit non mesurable (IN11). Relecture forte : tenu veut dire reçu, un message en essai ou en panne ne vaut pas ; cela s'écarte de G07 (voir IN13). Un formulaire sans moyen de répondre reste manqué : le contact n'a rien reçu.
- Qui : Claude, voie 2 · Relecture : forte · Dépend de : IN03
- Cahier : Indicateurs et tests, « Engagements de service tenus » ; Besoins et solutions, « Nos engagements de service ».
- Objectif : pour la direction et un mois fini, la part des engagements tenus, chaque ligne avec sa source, ses cas tenus et manqués.
- Critères : chaque ligne recalculée à la main, à la seconde et au minuit de Paris près (tests) ; donnée absente dite absente, jamais zéro [R216] (test) ; un délai qui court n'est ni tenu ni manqué (test) ; aucun agent ni rang [R14] (test) ; droits [R16] (test).
- Attend : rien.

### IN08 · Le temps gagné, déclaré par l'agent et contrôlé sur le journal
- Statut : fait (2026-11-03)
- Reste : fusionnée (#356). Relecture forte 1 P0 et 1 P1 corrigés ; Codex non attendu (H03). Le filtre tient au nom des types du journal : une lecture mal nommée compterait comme geste.
- Décidé (2026-11-03), lecture prudente : l'agent déclare en minutes, de 0 à 80 h, une semaine finie et pas d'avant son entrée. Le contrôle juge le type du journal sur son nom : lectures, passages en son nom et refus écartés. Il rend à la direction un compte de déclarations sans geste, sans nom. Avec un seul déclarant, les comptes valent sa ligne : la direction voit déjà les chiffres de chaque agent (K05), R14 interdit le rang, pas ce compte.
- Qui : Claude, voie 2 · Relecture : forte · Dépend de : IN03
- Cahier : Indicateurs et tests, « Temps gagné ».
- Objectif : chaque agent déclare ses heures gagnées d'une semaine finie ; à côté, les gestes du journal de cette semaine, pour contrôler. La direction lit les totaux du réseau, jamais un agent contre un autre.
- Critères : une déclaration par agent et par semaine, une nouvelle version garde l'ancienne [R17] (test) ; heures bornées (test) ; le contrôle dit un écart sans jamais noter l'agent [R14] (test) ; sans déclaration, « non déclaré », jamais zéro (test) ; droits [R16, R68] (test).
- Attend : rien.

### IN09 · La disponibilité du service, derrière une interface
- Statut : fait (2026-11-03)
- Reste : fusionnée (#358). Relecture forte 1 P1 corrigé ; Codex non attendu (H03). Le branchement réel (H48) passera une supervision à la route depuis `app.ts`.
- Décidé (2026-11-03), lecture prudente : le temps dont la supervision ne dit rien n'est ni répondu ni coupé ; la part porte sur le temps connu (l'observé, plus toute coupure rapportée, même hors de l'observé) ; un mois connu en partie le dit et la cible n'y est jamais atteinte, mais elle y est manquée dès que les coupures dépassent le millième du mois entier. Une donnée incohérente rend le service « non mesuré ». Arrondi vers le bas. La supervision vaut pour tout le logiciel, sans table : les chiffres ne sont pas gardés chez AIMMO tant que la supervision réelle n'est pas choisie (H48).
- Qui : Claude, voie 2 · Relecture : forte · Dépend de : IN03
- Cahier : Indicateurs et tests, « Disponibilité du service », cible 99,9 % par mois.
- Objectif : une interface de supervision avec un faux service de test, qui rend pour un mois le temps où le site, l'API et l'application ont répondu ; la direction lit la part par service.
- Critères : calcul à la main sur des coupures inventées (test) ; sans supervision branchée, « non mesuré », jamais 100 % (test) ; droits [R16] (test).
- Attend : une supervision réelle, à écrire dans `HUMAIN.md` au moment du branchement.

### IN10 · Les engagements, le temps gagné et la disponibilité à l'écran
- Statut : fait (2026-11-03)
- Reste : fusionnée (#360). Relecture forte 5 P1 corrigés ; une vérification rouge (identifiants en double avec M20), corrigée ; Codex non attendu (H03).
- Qui : Claude, voie 2 · Relecture : forte · Dépend de : IN07, IN08, IN09
- Cahier : Indicateurs et tests ; R201.
- Objectif : dans `finances.js`, sans toucher au socle : la direction lit les trois sur « Le réseau », l'agent déclare son temps sur « Mes chiffres ».
- Critères : non mesuré et absent dits tels, jamais zéro (test) ; droits [R16] (test) ; réponse perdue dite telle (test) ; déconnexion et réponse en vol (test) ; budget tenu [R201] (test).
- Attend : rien.

### IN11 · Dater la mise en vente, pour mesurer l'alerte dans l'heure
- Statut : fait (2026-11-03)
- Reste : fusionnée (#357). Relecture forte 3 P1 corrigés ; Codex non attendu (H03). Le passage des alertes ne tient pas encore l'heure : IN14.
- Décidé (2026-11-03), lecture prudente : voir la tête de `packages/core/src/acquereurs/mises-en-vente.ts` et de `engagements-tenus.ts`. La date vient des faits du mandat, jamais du passage qui la voit ; l'heure se compte dans les seules heures d'envoi, 19 h 30 laisse une demi-heure le soir et une demi-heure à la réouverture.
- Qui : Claude, voie 1 · Relecture : forte · Dépend de : IN07
- Cahier : Besoins et solutions, « Nos engagements de service » ; M08.
- Objectif : la base ne date pas le moment où un bien devient diffusable [R42]. Le ranger une fois, et faire passer `alerte_heure` en mesurable : alerte partie dans l'heure, l'heure comptant depuis l'ouverture des heures d'envoi [R01] si le bien sort la nuit.
- Critères : à la seconde près, de nuit, un dimanche (tests) ; un bien sans date reste non mesuré (test) ; aucun envoi changé (test).
- Attend : rien.

### IN14 · Les alertes passent dès l'ouverture des heures d'envoi
- Statut : fait (2026-11-03)
- Reste : fusionnée (#359). Relecture forte : aucun P0 ni P1 ; Codex non attendu (H03).
- Qui : Claude, voie 1 · Relecture : forte · Dépend de : IN11
- Cahier : Besoins et solutions, « Nos engagements de service » ; R01.
- Objectif : trouvé par IN11 : `alertsJob` ne passe que de 9 h à 19 h. Un bien sorti la nuit, un dimanche, à minuit de la fin d'un délai de rétractation ou après le passage de 19 h a sa limite avant ou à 9 h 00 min 00 s, et sera manqué par construction. Le faire passer dès 8 h.
- Critères : un bien sorti la nuit a son alerte au passage de 8 h (test) ; R01 reste tenue, rien ne part avant 8 h ni à 20 h (test) ; un bien sorti à 19 h 30 a son alerte le lendemain à 8 h, dans sa limite (test) ; toujours par les canaux du mode essai (test).
- Attend : rien.

### IN12 · Un engagement manqué : noté, et le client rappelé par un responsable
- Statut : fait (2026-11-03)
- Reste : fusionnée (#362). Relecture forte 2 P0 et 1 P1 corrigés ; Codex non attendu (H03). L'écran : IN15.
- Décidé (2026-11-03), lecture prudente : le responsable est la direction du réseau. Le passage tourne à 7 h de Paris dans `pilotage.passage`, sans toucher au planificateur, sur le mois en cours et le mois passé. Un engagement envers l'agent (client transmis, commission) se rappelle à l'agent ; une offre, au vendeur du dernier mandat du bien. Une personne exclue : « ne pas appeler », jamais notée rappelée. L'écran passe à IN15.
- Qui : Claude, voie 2 · Relecture : forte · Dépend de : IN07
- Cahier : Besoins et solutions, « Le bouche-à-oreille » et « Nos engagements de service » (publiés, et reprise de liberté du vendeur sous réserve de l'avocat).
- Objectif : vérifier d'abord ce qui existe. Chaque cas manqué vu par IN07 donne une tâche « rappeler » au responsable, une seule, sans donnée dans le journal ; rien n'est envoyé au client par la machine.
- Critères : une seule tâche par cas (test) ; aucun envoi (test) ; droits [R16] (test).
- Attend : la réponse de l'avocat sur la reprise de liberté, à écrire dans `HUMAIN.md`.

### IN13 · Le dossier de présentation dit « reçu », pas « validé »
- Statut : fait (2026-11-04)
- Reste : fusionnée (#363). Relecture forte 2 P1 corrigés ; Codex non attendu (H03).
- Décidé (2026-11-03), lecture prudente : mêmes critères que IN07 [R216], avec le délai que la direction a réglé (G15) : compte rendu parti au vendeur dans le délai après la visite ; point dû le lundi qui suit sa semaine, le délai court depuis le début de ce lundi à Paris ; un mandat signé après ce lundi n'en fait pas un cas. En mode essai, le taux affiché au client reste donc sans cas tenu : il ne dit jamais plus que ce que le client a reçu.
- Qui : Claude, voie 2 · Relecture : forte · Dépend de : IN07
- Cahier : M20 ; Besoins et solutions, « Nos engagements de service ».
- Objectif : le taux tenu montré au client (G07) compte un compte rendu ou un point validé, même refusé à l'envoi ou resté en essai, et un point préparé un autre jour que le lundi. Le mettre à la même mesure que IN07 [R216], dans les délais de G15.
- Critères : validé mais refusé à l'envoi : pas tenu (test) ; resté en essai : pas tenu (test) ; un point est jugé sur son lundi (test) ; le dossier reste sans donnée d'un client [R16] (test).
- Attend : rien.

**Sauvegardes et parcours du mois, Architecture et tests pour tout le système.**

Voie : 1

Découpé le 2026-11-03 par la voie 1 : le cahier demande « copie chiffrée chaque nuit, restauration à un instant passé, test de restauration chaque mois », et, pour tout le système, « une restauration complète de la base de test réussit en moins d'une heure » et « chaque mois : un parcours complet fictif ». Aucun code ni tâche n'y répondait. Ids `SV..`.

Décidé, lecture prudente : la restauration à un instant passé est celle de D1 (Time Travel), rien à coder ; la copie chiffrée est le second filet, hors de D1. Une copie ne se restaure que dans une base neuve : rien n'est jamais écrasé. La durée de garde des copies et le rejeu des effacements après une restauration sont tranchés par SV02.

### SV01 · La copie chiffrée de la base, et sa restauration vérifiée
- Statut : fait (2026-11-03)
- Reste : fusionnée (#361). Relecture forte 4 P1 traités ; Codex non attendu (H03). Rien n'est branché : SV02.
- Qui : Claude, voie 1 · Relecture : forte · Dépend de : aucune
- Cahier : Architecture technique, « Sauvegardes » ; Indicateurs et tests, « Une restauration complète de la base de test ».
- Objectif : copier toute la base, schéma et lignes, en morceaux chiffrés derrière une interface de stockage ; la restaurer dans une base neuve et prouver qu'elle est identique.
- Critères : base restaurée identique, table par table, et chaîne du journal valide [R224] (test) ; rien de lisible dans le stockage (test) ; mauvaise clé, morceau changé, déplacé ou manquant : refus sans rien dire de restauré (tests) ; base non vide : refus (test) ; garde-fous de la base de nouveau actifs après restauration (test) ; durée mesurée, moins d'une heure (test).
- Attend : rien.

### SV02 · La copie de chaque nuit, et ce qui se passe quand elle manque
- Statut : fait (2026-11-04)
- Reste : fusionnée (#364). Relecture forte 1 P0 et 4 P1 traités ; Codex non attendu (H03). Le travail reste éteint et jamais essayé sur un vrai compartiment : H50. Une vraie photo locale de wrangler s'est chargée, copiée et restaurée. L'écran n'affirme pas la garde de 30 jours, que la clé ne peut pas lire. Rejeu des effacements écrit, à brancher : SV05.
- Qui : Claude, voie 1 · Relecture : forte · Dépend de : SV01
- Cahier : Architecture technique, « Sauvegardes » ; Conformité, durées de conservation.
- Décidé (2026-11-03) par la relecture de SV01 : la copie ne se prend pas dans le Worker (limite de requêtes de D1, base qui vit). Un travail GitHub de nuit fait `wrangler d1 export`, charge la photo dans une base SQLite neuve et y lance `CopieBase`. À vérifier au branchement : la durée du travail reste dans le quota, décision du 2026-10-29.
- Objectif : un travail de nuit range la copie dans un stockage à part, derrière la même interface, avec une clé en secret ; la direction voit la date de la dernière copie réussie, et une nuit sans copie donne une alerte. Durée de garde écrite au registre des traitements, avec le rejeu des effacements après une restauration.
- Critères : sans clé ou sans stockage, « non sauvegardé » dit, jamais un faux succès (test) ; une panne n'arrête pas les autres tâches [R13] (test) ; une nuit manquée alerte la direction (test) ; un effacement fait après la copie est refait après la restauration (test) ; droits [R16] (test).
- Attend : une ligne de `HUMAIN.md` pour le compartiment, sa règle de garde et la clé, à écrire par SV02.

### SV09 · Une offre qui tombe rend le bien disponible
- Statut : fait (2026-11-04)
- Reste : fusionnée (#372). Relecture forte 3 P0 et 3 P1 corrigés, sur la version avec table refaite ; la version finale, qui la retire, n'a pas eu de seconde relecture forte. Codex à sa limite (H03). Second dossier et lecture de l'arrêt par le client : SV12.
- Décidé (2026-11-04), lecture prudente : rien n'existait pour arrêter un dossier, le geste est créé (agent du bien, raison en liste fermée, preuve, définitif). Le bien passe par `draft`, puis la publication le rend `available` si la diffusion reste ouverte. Refaire `sale_files` pour lever l'unicité du bien demandait un `DROP TABLE`, que la garde [R17] interdit : pas d'exception sans Shawez, un second dossier est refusé et le dit (H51, SV12).
- Qui : Claude, voie 1 · Relecture : forte · Dépend de : SV08
- Cahier : M09 Offre ; M10 Compromis et acte.
- Trouvé par la relecture de SV08 : seuls `under_offer` et `sold` s'écrivent, rien ne ramène un bien à `available` quand son dossier s'arrête. Le bien resterait « a déjà une offre » et hors des alertes.
- Objectif : lire d'abord comment un dossier de vente s'arrête ; à l'arrêt d'un dossier sans autre offre acceptée, le bien revient à `available` et son annonce à `en_vente`, si la diffusion reste ouverte [R42].
- Critères : dossier arrêté, bien disponible et annonce remise (test) ; autre dossier ouvert : rien ne change (test) ; mandat échu : pas de retour (test) ; journal [R13] (test).
- Attend : rien.

### SV12 · Un second dossier sur un bien, et ce que le client lit après un arrêt
- Statut : fait (2026-11-06)
- Reste : fusionnée (#375), sans le second dossier, passé à SV14. Relecture forte 2 P0 et 3 P1 corrigés ; Codex sans remarque. La sortie à 10 ans des dossiers et des clients n'existe pour personne ; un signalement sur une offre ou un mandat ne fige pas le dossier lié.
- Qui : Claude, voie 1 · Relecture : forte · Dépend de : SV09
- Cahier : M09 Offre ; M10 Compromis et acte ; Conformité.
- Trouvé par la relecture de SV09 : l'unicité de `sale_files.property_id` empêche un second dossier ; les espaces du vendeur et de l'acquéreur montrent encore l'offre « acceptée » après l'arrêt ; le gel d'un signalement ne contient pas `sale_file_stops` ; la durée de conservation compte encore l'acquéreur d'un dossier arrêté comme client.
- Objectif : sans attendre H51, les espaces disent que la vente ne se fait plus, le gel contient l'arrêt, la durée de conservation est tranchée au plus prudent. Avec H51 oui : table refaite, un seul dossier ouvert par bien, l'exception écrite dans le test [R17].
- Critères : l'espace ne dit plus « acceptée » après l'arrêt [R233] (test) ; l'arrêt est dans le gel (test) ; avec H51 oui, un second dossier s'ouvre et tous les passages lisent le bon (test).
- Attend : H51 pour la seule partie du second dossier.

### SV10 · La direction corrige un nom sur une fiche
- Statut : fait (2026-11-04)
- Reste : fusionnée (#373). Relecture forte 1 P0 et 1 P1 corrigés ; une vérification rouge corrigée ; Codex à sa limite (H03). Inventaire des autres brouillons : SV13. Le motif `demande_de_la_personne` ne clôt pas une demande de rectification de la conformité.
- Décidé (2026-11-04), lecture prudente : motif en liste fermée, sans texte libre. Un champ peut se vider, jamais les deux, ni un nom qu'une fiche réunie ferait revenir. Un nom corrigé reste retenu des textes : les gardes lisent la vue `person_known_names`. La ligne de correction n'a pas de garde contre l'effacement, car elle porte un nom et le plan d'effacement doit pouvoir la traiter.
- Qui : Claude, voie 1 · Relecture : forte · Dépend de : SV07
- Cahier : M02 Capter ; Conformité, droit de rectification.
- Trouvé par SV07 : un nom déjà écrit ne se corrige pas, et un prénom qui n'est que le nom bloque l'agent, renvoyé à une direction qui n'a aucun écran pour cela.
- Objectif : la direction corrige prénom et nom d'une fiche, avec le motif et la valeur d'avant gardés hors du journal ; les documents déjà générés ne changent pas.
- Critères : droits [R16] (test) ; aucun nom au journal [R13] (test) ; l'ancienne valeur reste lisible par la direction [R17] (test) ; document déjà généré inchangé (test) ; budget tenu [R201] (test).
- Attend : rien.

### SV14 · Un second dossier sur un bien
- Statut : fait (2026-11-06)
- Reste : fusionnée (#377). Relecture forte sans P0 ni P1 ; Codex 1 P1 (R233 à réécrire) corrigé, puis sans remarque ; vérification GitHub verte. Une table de preuve `sale_files_recopie` gardée.
- Qui : Claude, voie 1 · Relecture : forte · Dépend de : SV12
- Cahier : M09 Offre ; M10 Compromis et acte.
- Trouvé par SV09 : l'unicité de `sale_files.property_id` empêche un second dossier après un arrêt. Le travail prêt est dans le commit `bba3231e` de la branche `chantier/SV09`.
- Objectif : si H51 répond oui, table refaite, un seul dossier ouvert par bien, l'exception écrite dans le test [R17].
- Critères : un second dossier s'ouvre après un arrêt, et tous les passages lisent le bon (test) ; deux dossiers ouverts sur un bien refusés (test) ; aucune donnée perdue à la recopie (test).
- Attend : H51.

### SV15 · Les notifications aux agents passent par le contrôle central
- Statut : à faire
- Qui : Claude, voie 1 · Relecture : forte · Dépend de : HX27
- Cahier : Architecture technique (contrôle central des envois) ; demande de HX27.
- Trouvé par HX27 (voie 2, qui ne touche pas au socle) : `Notifications` n'envoie que par `AgentPushGate.sendToAgent`.
- Objectif : ajouter `sendToAgent` à `ControleEnvois` (une seule fois par `pushId` [R05], agent actif, journal des envois sans donnée [R13]) et en faire la seule porte branchée ; le vrai service Web Push n'est branché qu'avec H57.
- Critères : seul le contrôle central appelle le service de notification (test, comme S06) ; un même `pushId` ne part jamais deux fois (test) ; en mode essai, rien ne part vers un téléphone (test).
- Attend : H57 pour le vrai service ; rien pour le code.

### SV13 · Les textes déjà préparés quand un nom est corrigé
- Statut : fait (2026-11-06)
- Reste : fusionnée (#376). Relecture forte 1 P1 corrigé ; Codex 1 P0 corrigé, puis sans remarque ; vérification GitHub verte.
- Décidé (2026-11-06), lecture prudente : la ligne rangée ne change jamais [R17]. Le remerciement remplace sa seule salutation ; la relance d'un ancien contact prend le texte du code après une correction ou si la salutation n'est plus celle de la fiche ; le nom du brief n'est remplacé que sur l'écran de la journée, après son contrôle d'accès [R16]. `BriefsRendezVous.read` rend le brief tel qu'il est rangé. `referrals.first_name` et `partner_recommendations.first_name` gardent le prénom donné à la recommandation : affichage seul, aucun texte envoyé.
- Qui : Claude, voie 1 · Relecture : forte · Dépend de : SV10
- Cahier : M02 Capter ; Conformité, droit de rectification.
- Trouvé par la relecture de SV10 : la relance d'un ancien contact repart du texte du code après une correction, mais l'écran de validation montre encore le brouillon rangé, et les autres brouillons à valider n'ont pas été inventoriés (comptes rendus, points de la semaine, réponses préparées).
- Objectif : inventorier les textes rangés avant envoi qui portent un prénom ou un nom ; après une correction, aucun ne part avec l'ancien, et l'écran montre le texte qui partira.
- Critères : chaque brouillon concerné a son test (test) ; l'écran montre le texte qui partira (test) ; le texte écrit par l'agent part tel quel (test).
- Attend : rien.

### SV11 · Un commerce publié devient disponible
- Statut : fait (2026-11-04)
- Reste : fusionnée (#374). Relecture forte 2 P1 corrigés ; Codex à sa limite (H03). P2 non traité : le studio peut préparer `nouveau_bien` pour un commerce, avec le prix dans les mentions, après préparation et validation de l'agent.
- Décidé (2026-11-04), lecture prudente : le passage des 15 minutes rend disponible un commerce à présentation validée, si la porte de diffusion est ouverte ; un bien avec version d'annonce suit `Publication` ; un commerce repris d'un ancien outil garde son statut ; un commerce sans annonce n'entre pas dans les alertes aux acquéreurs, et le premier message relit la porte pour lui.
- Qui : Claude, voie 1 · Relecture : forte · Dépend de : SV08
- Cahier : M16 Commerces et entreprises.
- Trouvé par la relecture de SV08 : un commerce finit en mentions incomplètes dans `Publication`, n'a jamais de version et reste `draft` ; `commerces/repreneurs.ts` ne lit que `available` et `under_offer`, donc ne le voit pas avant une offre.
- Objectif : vérifier ce trou par un test, puis faire passer un commerce diffusable à `available` par son propre chemin de présentation, sans le publier sur les portails.
- Critères : un commerce diffusable est vu des repreneurs (test) ; rien pendant la rétractation [R42] (test) ; aucune adresse ni nom [R19] (test).
- Attend : rien.

### SV05 · L'effacement réel écrit au registre des effacements
- Statut : à faire
- Qui : Claude, voie 1 · Relecture : forte · Dépend de : SV02
- Cahier : Conformité ; Architecture technique, « Sauvegardes ».
- Objectif : quand l'effacement réel sera mis en service (H29, `ERASURE_MODE`), il note chaque effacement au registre `recordErasure`, dans le compartiment des copies, et la procédure réelle passe derrière `PersonEraser` ; le stockage S3 de `packages/api/outils/r2-copies.ts` gagne la liste. Rien à faire tant que tout est en essai.
- Critères : un effacement non noté n'est pas dit fait [R231] (test) ; le vrai effaceur, passé deux fois, ne change rien de plus (test) ; un effacement refait après une vraie restauration, de bout en bout (test).
- Attend : H29, H50.

### SV03 · Le test de restauration de chaque mois, avec son reçu (Jamais vu)
- Statut : fait (2026-11-04)
- Reste : fusionnée (#365). Relecture forte 4 P1 corrigés ; Codex non attendu (H03). Le travail reste éteint et jamais essayé sur un vrai compartiment : H50. Décidé : une copie de plus de 48 heures est un échec, même restaurable.
- Qui : Claude, voie 1 · Relecture : forte · Dépend de : SV02
- Cahier : Architecture technique, « Sauvegardes » ; Indicateurs et tests.
- Objectif : chaque mois, un travail restaure la dernière copie dans une base neuve, hors de la production, et range un reçu sans donnée : date de la copie, durée, tables, lignes, empreinte. La direction lit ce reçu à l'écran. **Jamais vu** : aucun réseau ne peut montrer la preuve datée que ses données se restaurent vraiment.
- Critères : un mois sans reçu ou un reçu en échec se dit, jamais un vert par défaut (test) ; le reçu ne porte aucune donnée d'un client (test) ; durée de plus d'une heure : échec (test) ; droits [R16] (test).
- Attend : H50.

### SV04 · Le parcours complet fictif de chaque mois
- Statut : fait (2026-11-04)
- Reste : fusionnée (#367). Relecture forte 3 P1 corrigés ; Codex non attendu (H03). Un échec du travail mensuel n'alerte que par GitHub, rien à l'écran de la direction.
- Qui : Claude, voie 1 · Relecture : forte · Dépend de : aucune
- Cahier : Indicateurs et tests, « Chaque mois : un parcours complet fictif, du premier message à l'après-vente ».
- Objectif : un seul scénario inventé traverse les vrais modules, du premier message à l'après-vente, et il tourne aussi chaque mois.
- Critères : chaque étape vérifiée par ses données et son journal (test) ; aucun envoi réel (test) ; une étape cassée nomme l'étape (test).
- Attend : rien.
- Décidé (2026-11-04), lecture prudente : le parcours tourne sur les modules, en mémoire, sans passer par les routes ; ce qu'il a trouvé ne se corrige pas dans SV04 mais dans SV06, SV07 et SV08, chacun avec son raccourci écrit à un seul endroit de `packages/core/test/parcours-complet.ts`.

### SV08 · Un bien publié devient disponible
- Statut : fait (2026-11-04)
- Reste : fusionnée (#368). Relecture forte 2 P1 corrigés ; Codex non attendu (H03). Décidé, lecture prudente : retirée, l'annonce rend le bien à `draft`, même repris d'un ancien outil ; un bien sans annonce garde son statut. Les messages lisent le prix de l'annonce [R44]. Trous anciens non fermés : un commerce ne devient jamais disponible (mentions incomplètes), une offre annulée ne rend pas le bien disponible.
- Qui : Claude, voie 1 · Relecture : forte · Dépend de : SV04
- Cahier : M07 Commercialiser ; M02 Capter.
- Trouvé par SV04 : seuls `under_offer` et `sold` s'écrivent en production ; un bien publié reste `draft`. Le premier message répond alors à l'acquéreur que le bien n'est plus en vente, et les alertes qui lisent `available` ne le voient pas.
- Objectif : la première publication d'une annonce passe le bien à `available`, sans jamais faire reculer `under_offer` ni `sold` ; retirée sans offre (mandat retiré, rétractation), l'annonce rend le bien à son statut d'avant.
- Critères : publié, le premier message dit « disponible » (test) ; l'alerte acquéreur part de ce bien, en essai (test) ; une offre ou une vente n'est jamais écrasée (test) ; le raccourci et le test du trou retirés du parcours (test) ; journal [R13] (test).
- Attend : rien.

### SV06 · L'agent crée un bien et le lie à son vendeur
- Statut : fait (2026-11-04)
- Reste : fusionnée (#369). Relecture forte 6 P1 corrigés ; une vérification rouge corrigée ; Codex non attendu (H03). Décidé, lecture prudente : une clé tirée par le formulaire devient l'identifiant du bien ; une demande d'estimation seule reçoit un projet de vente en plus quand l'agent crée le bien.
- Qui : Claude, voie 1 · Relecture : forte · Dépend de : SV04
- Cahier : M04 Estimer ; M06 Mandats et documents.
- Trouvé par SV04 : hors import CSV sans écran, aucun geste ne crée un bien, `linkProjectProperty` n'a aucun appelant en production, et sans ce lien le mandat est refusé [R41]. Un nouveau vendeur ne peut donc pas signer.
- Objectif : depuis la fiche d'un vendeur, l'agent crée le bien (type, commune, surface, pièces, prix voulu) et il est lié au projet de vente ; route et écran.
- Critères : droits [R16] (test) ; référence unique dans le réseau (test) ; réponse perdue dite telle (test) ; téléphone d'abord et budget tenus [R201] (test) ; le parcours passe par ce geste (test).
- Attend : rien.

### SV07 · L'agent complète le nom d'une fiche
- Statut : fait (2026-11-04)
- Reste : fusionnée (#370). Relecture forte 1 P0 et 3 P1 corrigés ; Codex non attendu (H03). Le parcours complet n'a plus de raccourci. Décidé, lecture prudente : un nom déjà écrit ne se corrige pas ici ; si le prénom n'est que le nom donné, le geste renvoie à la direction, qui n'a pas encore d'écran pour le corriger. Un prénom composé d'un mail signé en sort seul.
- Qui : Claude, voie 1 · Relecture : forte · Dépend de : SV04
- Cahier : M02 Capter ; M06 Mandats et documents.
- Trouvé par SV04 : un contact venu d'un formulaire n'a que son prénom ; seul un import CSV sans écran complète son nom. Son mandat et son bon de visite restent incomplets.
- Objectif : sur la fiche, l'agent remplit un nom ou un prénom vide ; ce qui est déjà écrit ne s'écrase pas, et la fiche fusionnée suit sa racine.
- Critères : droits [R16] (test) ; aucun nom au journal [R13] (test) ; un nom déjà écrit n'est pas écrasé (test) ; mandat complet ensuite (test) ; budget tenu [R201] (test) ; le raccourci et le test du trou retirés du parcours (test).
- Attend : rien.

### IN15 · Les engagements manqués à rappeler, à l'écran
- Statut : fait (2026-11-04)
- Reste : fusionnée (#366). Relecture forte 3 P1 corrigés ; Codex non attendu (H03). Depuis le réseau, la fiche porte « Retour au réseau » : « Retour à ma journée » faisait effacer la clé de la direction. Le script des finances ne sert plus ses retraits ni ses commentaires, pour tenir son budget. Les boutons d'une ligne se touchent sur téléphone : l'écart est dans la feuille de style du socle, voie 1.
- Qui : Claude, voie 2 · Relecture : forte · Dépend de : IN12
- Cahier : Besoins et solutions, « Le bouche-à-oreille » ; R201.
- Objectif : dans `finances.js`, sur « Le réseau » : la direction lit les rappels à faire, ouvre la fiche, et dit rappelé, injoignable ou sans appel, en un geste.
- Critères : « ne pas appeler » dit, sans bouton « rappelé » (test) ; droits [R16] (test) ; réponse perdue dite telle (test) ; déconnexion et réponse en vol (test) ; budget tenu [R201] (test).
- Attend : rien.

### IN16 · Un écart entre les boutons d'une ligne de liste
- Statut : fait (2026-11-04)
- Reste : fusionnée (#371). Codex non attendu (H03).
- Qui : Claude, voie 1 (feuille de style de l'application, fichier du socle) · Relecture : normale · Dépend de : IN15
- Cahier : Le produit, système de design ; R201.
- Objectif : trouvé par IN15 : dans `.liste`, deux boutons sur un même rang se touchent à la largeur d'un téléphone (« Voir la fiche » et « Rappelé », par exemple). Leur donner un écart, sans changer leur taille.
- Critères : la règle d'écart est dans la feuille servie (test) ; budget tenu [R201] (test).
- Attend : rien.
