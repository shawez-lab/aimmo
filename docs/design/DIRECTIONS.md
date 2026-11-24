# Trois directions de design pour AIMMO

Tâche DS000 du plan, étape 4 de la consigne `chantier/taches/DS00.md`. L'audit (`docs/design/AUDIT.md`) dit ce qui ne va pas. Ce document montre trois façons d'y répondre, vraiment différentes, appliquées aux six mêmes surfaces. Shawez en choisit une. La transformation de tout le produit part de là.

## Comment ces maquettes sont faites

- **Du vrai HTML, rendu.** Chaque direction est une feuille de style posée sur les six mêmes pages : la journée de l'agent, la fiche d'un bien, la fiche d'un client, la signature d'un mandat, la page publique d'un bien, l'espace du vendeur. Les captures sortent de Chrome sans tête, en 390 × 844 et en 1 440 × 900, en clair et en sombre : 72 rendus pour les trois directions, 120 avec les variantes de police.
- **Mêmes données, inventées.** Léa Moreau, Noé Lambert, l'appartement de la rue Monge : le jeu fictif du parcours de test. Aucune donnée réelle.
- **Les photos sont des dessins d'attente.** Le poste de travail n'a pas de photo haut de gamme sous la main, et une photo médiocre est interdite. Les vraies photos viendront du Studio. La direction A est celle qui gagnera le plus à leur arrivée.
- **Les textes sont ceux d'une maquette.** Ils respectent les règles (R42 : pas de diffusion pendant la rétractation ; R203 : une personne qui a demandé à être rappelée reste appelable à toute heure), mais aucun texte du produit ne change sans son test.
- **La police du texte courant** est celle de l'appareil. Sur le poste de capture, Inter en tient lieu.
- **Mesures.** axe-core (WCAG 2.2 AA) sur les 120 rendus : aucun défaut de contraste, de nom, d'étiquette ni de structure. Une alerte reste, sur la journée de la direction A au téléphone : une ligne de l'agenda passe sous la barre d'action au moment de la mesure. Aucun débordement horizontal. Au téléphone, chaque bouton et chaque onglet fait 44 px au moins. Non mesuré ici : le reflow à 320 px, le texte à 200 %, l'ordre du clavier. Ce sera fait sur les vrais écrans, à l'étape 5.
- **Poids.** La feuille commune et celle d'une direction pèsent ensemble 5,5 à 5,8 Ko compressés pour les six surfaces. La page publique entière, feuille et dessins compris, pèse 7,6 à 7,9 Ko, pour un budget de 14 Ko. Dans l'application, le budget de 48 Ko est plein aujourd'hui (48 446 octets sur 49 152) : sortir l'écran de la direction de la coquille (DS069) libère environ 3 Ko, plus que ce que la nouvelle feuille ajoute.

Les captures sont dans `docs/design/captures/directions/`. La planche à regarder en premier : `comparaison-telephone.jpg`, les trois directions sur les mêmes écrans.

## Ce que les trois directions ont en commun

La structure du produit ne se choisit pas, elle se corrige. Les trois directions partagent donc les mêmes réponses à l'audit.

- **Une barre en bas, cinq entrées** : Journée, Clients, Biens, Outils, Chiffres. À l'ordinateur, la même liste à gauche. On sait toujours où l'on est (DS005).
- **Chercher, partout** : une loupe dans chaque écran, un champ à l'ordinateur (DS003, DS004).
- **La journée ouvre sur trois gestes**, pas sur 23 cartes : ce qui est en retard, ce qui attend l'agent, ce qui est prêt. Puis les rendez-vous du jour, puis les biens en cours (DS001, DS002, DS011).
- **Un bien, un écran** : la photo, le prix, quatre faits, la frise des étapes, puis des onglets (Aperçu, Mandat, Annonce, Offres, Dossier, Studio). Le bien porte un nom lisible, « Appartement 3 pièces, rue Monge », plus une référence interne (DS013, DS023, DS039).
- **Une seule action pleine par écran**, ancrée en bas, sous le pouce. Les autres sont au trait (DS022, DS070).
- **La fiche du client ouvre sur le prochain geste**, avec les derniers mots de la personne. Appeler, écrire un SMS, écrire un mail : en bas, sous le pouce. La règle d'appel est écrite en clair (DS010, DS050).
- **Signer un mandat suit quatre étapes visibles** : préparer, contrôler, signer, inscrit (DS049).
- **La page publique vend le bien** : la photo d'abord, le prix, les faits, la demande de visite toujours visible, l'agent, le français et l'anglais (DS072, DS073).
- **L'espace du vendeur dit où en est la vente** : la même frise d'étapes que celle de l'agent, ce qui se passe maintenant, les chiffres de la semaine, les documents, l'agent. « Me déconnecter » n'est plus le bouton le plus visible (DS081, DS082).
- **Des états courts** : « En retard », « Aujourd'hui », « Prêt », « À signer », au lieu de phrases (DS025).
- **Des icônes qui ont un sens** : chacune accompagne un mot, aucune ne décore (DS045).

Rien de ce qui est interdit par la consigne : ni dégradé, ni verre dépoli, ni émoji, ni rangée de cartes identiques.

## Par surface, ce que les concurrents lus ne décrivent pas

Limite à garder en tête : les écrans des concurrents n'ont pas pu être ouverts depuis le poste de travail. Ce tableau s'appuie sur ce qui a été lu d'eux (iad, SAFTI, Hektor de La Boîte Immo, Apimo, Modelo, Barnes : sources en fin d'audit). Aucune de ces sources ne décrit ce qui suit. La comparaison côte à côte, avec leurs écrans, reste à faire à l'étape 6.

Deux choses par surface sont communes aux trois directions. La troisième est propre à chaque direction : elle est donnée plus bas.

| Surface | Première chose | Deuxième chose |
| --- | --- | --- |
| Journée de l'agent | Trois gestes triés par l'urgence réelle, chacun avec sa raison écrite, au lieu d'un tableau de compteurs. | Chaque rendez-vous arrive avec son dossier : ventes comparables, bon de visite, clés. |
| Fiche d'un bien | Toute la vie du bien sur un seul écran, de l'estimation à l'acte, avec la frise que voit aussi le vendeur. | La prochaine étape écrite en une phrase, chiffres compris, et son bouton sous le pouce. |
| Fiche d'un client | La règle d'appel dite en clair avant le bouton : l'agent sait s'il a le droit d'appeler, et jusqu'à quand. | Le prochain geste avant l'historique, avec les mots exacts de la personne. |
| Signature d'un mandat | Le contrôle est montré avant la signature : honoraires au barème, mentions complètes. | Le délai de rétractation et sa conséquence sur la diffusion sont écrits sur l'écran où l'on signe. |
| Page publique d'un bien | La demande de visite reste sous le pouce pendant toute la lecture, avec le prix à côté. | La page entière pèse moins de 8 Ko hors photos et ne charge rien d'un autre domaine : elle s'ouvre même sur un mauvais réseau. |
| Espace du vendeur | Le vendeur voit la même frise que son agent : les deux parlent de la même étape. | Chaque chiffre dit d'où il vient, et le relevé prouvé se télécharge. |

## A · Maison

**En une phrase.** Une maison de vente : pierre blanche, encre, un trait de laiton. La photo et un grand caractère font le prestige, tout le reste se tait.

**Pour qui.** La clientèle aisée et internationale que Shawez veut attirer, et l'agent qui montre son téléphone à un vendeur pendant un rendez-vous.

| Jeton | Clair | Sombre |
| --- | --- | --- |
| Fond | `#fbfaf8` | `#131210` |
| Surface | `#ffffff` | `#1b1a17` |
| Encre, qui est aussi la couleur d'action | `#16130f` | `#f4f0e8` |
| Texte doux | `#615a50` | `#b3aa9c` |
| Trait | `#e7e2d9` | `#2e2b26` |
| Laiton, jamais en texte | `#b08a3c` | `#d2b06a` |
| Retard | `#8a2331` | `#f0a3ab` |

- **Typographie.** Les titres, les prix et les grands chiffres dans un caractère de titre à fort contraste, de 34 px au téléphone à 58 px sur la page publique. Le texte courant dans la police de l'appareil, 16 px. Deux graisses seulement.
- **Formes.** Pas de carte : des filets fins. Des angles presque droits (2 px). Le bouton plein est noir.
- **La signature : le fil de laiton.** Une seule ligne fine porte l'avancement d'une vente. Elle est la même, au même endroit, sur la fiche du bien, sur la signature du mandat et dans l'espace du vendeur. C'est le seul endroit où la couleur parle.

La troisième chose, par surface :

| Surface | Ce que Maison ajoute |
| --- | --- |
| Journée de l'agent | Les biens en cours se montrent par leur photo en grand, pas par une ligne de tableau : l'agent voit son portefeuille comme le verra l'acheteur. |
| Fiche d'un bien | Le fil de laiton : l'étape en cours se lit d'un regard, sans couleur d'alerte. |
| Fiche d'un client | Le prochain geste est composé comme un titre, derrière un filet de laiton. L'historique reste en petit. |
| Signature d'un mandat | Les montants du mandat sont posés comme sur un acte : le libellé à gauche, le chiffre à droite dans le caractère des titres. |
| Page publique d'un bien | La photo prend tout l'écran d'ouverture, le titre du bien est composé en grand caractère, et la seule couleur d'appel est l'encre. |
| Espace du vendeur | Le retour d'un visiteur est cité en grand, comme une citation de presse. |

**Ses risques.** Elle dépend des photos : avec de mauvaises photos, elle n'a plus rien. Le caractère de titre est fin : il ne descend pas sous 20 px.

Captures : `a-maison-telephone.jpg`, `a-maison-telephone-sombre.jpg`, `a-maison-ordinateur.jpg`, `a-maison-ordinateur-sombre.jpg`, `maison-police-des-titres.jpg`.

## B · Atelier

**En une phrase.** L'outil d'un professionnel : dense, net, tout en lignes, le temps sur un rail.

**Pour qui.** L'agent qui traite quarante fiches par jour à l'ordinateur.

| Jeton | Clair | Sombre |
| --- | --- | --- |
| Fond | `#f3f5f2` | `#0f1211` |
| Surface | `#ffffff` | `#161a18` |
| Encre | `#161a18` | `#e8ece9` |
| Texte doux | `#56605a` | `#a0aaa4` |
| Trait | `#dde2dd` | `#262c29` |
| Action, le vert de tuile | `#1c6646` | `#56c795` |
| Retard | `#b3261e` | `#ff8a80` |

- **Typographie.** La police de l'appareil partout, 15 px, titres en 23 px gras. Chiffres alignés.
- **Formes.** Des listes dans des blocs blancs aux coins arrondis (12 px), des états en pastilles de couleur, des onglets en boutons.
- **La signature : le rail du temps.** Les rendez-vous sont accrochés à une ligne d'heures. À l'ordinateur, la journée tient sur un écran, sans défiler.

| Surface | Ce qu'Atelier ajoute |
| --- | --- |
| Journée de l'agent | Le rail du temps, et toute la journée sur un seul écran d'ordinateur. |
| Fiche d'un bien | Le prix, les faits et les étapes tiennent en trois lignes au-dessus des onglets. |
| Fiche d'un client | Les états en pastilles de couleur : la liste des rappels se lit sans lire. |
| Signature d'un mandat | Les montants, le contrôle et les signatures tiennent sur un écran de téléphone. |
| Page publique d'un bien | Les faits sur une ligne, la description tout de suite. |
| Espace du vendeur | Les trois chiffres de la semaine dans trois tuiles égales. |

**Ses risques.** Elle ressemble à un bon logiciel, pas à une maison : rien ne dit le haut de gamme à un vendeur ou à un acheteur. Les blocs blancs arrondis sont ce que font déjà les logiciels d'agence.

Captures : `b-atelier-telephone.jpg`, `b-atelier-telephone-sombre.jpg`, `b-atelier-ordinateur.jpg`, `b-atelier-ordinateur-sombre.jpg`.

## C · Toits vernissés

**En une phrase.** La Bourgogne assumée : l'identité d'aujourd'hui (`docs/design/README.md`), poussée jusqu'au bout. Des aplats, des filets d'encre, et une tuile vernissée par étape.

**Pour qui.** Le réseau qui veut être reconnu de loin, sur une vitrine comme sur un téléphone.

| Jeton | Clair | Sombre |
| --- | --- | --- |
| Fond, le papier | `#f6f1e7` | `#191411` |
| Surface | `#fffcf5` | `#221b17` |
| Encre | `#1d1915` | `#f6efe2` |
| Action | bordeaux `#7c1f32` | moutarde `#e4b53d` |
| Moutarde | `#d6a019` | `#e4b53d` |
| Vert de tuile | `#2f5d47` | `#7fbf9c` |
| Retard | `#a3231b` | `#f19a8f` |

- **Typographie.** La police de l'appareil, en très gras et serré pour les titres : une affiche.
- **Formes.** Des filets d'encre de 2 px, des angles droits, des aplats. Aucune ombre.
- **La signature : la tuile.** La frise de losanges passe une fois par écran, sous le titre. Chaque étape d'une vente est une tuile : elle se vernit quand l'étape est faite. La toiture se couvre à mesure que la vente avance.

| Surface | Ce que Toits vernissés ajoute |
| --- | --- |
| Journée de l'agent | La frise de tuiles sous le titre : on sait qu'on est chez AIMMO sans lire le nom. |
| Fiche d'un bien | Une tuile par étape, vernie quand l'étape est faite. |
| Fiche d'un client | Le prochain geste dans un aplat moutarde : impossible à manquer. |
| Signature d'un mandat | Les mêmes tuiles pour les quatre étapes de la signature. |
| Page publique d'un bien | Les quatre couleurs des toits de Bourgogne, et elles seules. |
| Espace du vendeur | La frise de tuiles du vendeur est celle de l'agent, à la même étape. |

**Ses risques.** Elle parle fort : ses couleurs disputent l'attention aux photos. Le bordeaux d'action et le rouge du retard restent voisins (DS030). En sombre, le bordeaux ne tient pas le contraste : l'action passe à la moutarde. À l'étranger, les tuiles ne disent rien.

Captures : `c-toits-vernisses-telephone.jpg`, `c-toits-vernisses-telephone-sombre.jpg`, `c-toits-vernisses-ordinateur.jpg`, `c-toits-vernisses-ordinateur-sombre.jpg`.

## La recommandation : A · Maison

- Elle sert d'abord ce que le client voit : la page publique et l'espace du vendeur sont les deux surfaces qui font gagner un mandat ou une visite. Maison est la seule des trois qui y ressemble à une maison de vente.
- Elle laisse l'agent tranquille : presque pas de couleur, donc un retard ou une offre se voient tout de suite.
- Elle vieillit bien : du blanc, de l'encre, un caractère. Rien qui date dans deux ans.
- Elle garde ce qu'Atelier a de mieux, parce que c'est dans la structure commune : la liste à gauche et la fiche à droite à l'ordinateur, une action par écran.
- Elle ne garde pas la tuile. Le losange peut rester le signe de l'application sur l'écran d'accueil du téléphone.

## La règle à discuter : une police servie par AIMMO

Aujourd'hui, R201 interdit toute police téléchargée (`packages/core/src/design/audit.ts` refuse `@font-face`). Les titres sortent donc dans la police à empattements de l'appareil : New York ou Iowan sur un iPhone, Noto Serif sur Android, Georgia ou Palatino sur Windows. Trois visages différents pour la même marque. La planche `maison-police-des-titres.jpg` montre l'écart.

**Ce que coûte une police servie.** Un fichier, Libre Caslon Display, sous-ensemble latin, format woff2 : 24 236 octets. Licence SIL Open Font 1.1, libre pour un usage commercial. Chargé une fois, puis gardé un an par le navigateur. Sur la « 4G lente » de `docs/MESURE.md` (150 ms d'aller-retour, 1 600 kbit/s), cela fait 0,27 seconde, une seule fois. Le texte s'affiche tout de suite dans la police de l'appareil, puis le titre prend son caractère. Les budgets de 14 Ko et de 48 Ko ne bougent pas.

**Ce qu'elle rapporte.** La même signature sur tous les appareils, y compris ceux des acheteurs étrangers. Un caractère plus fin et plus étroit que ceux des appareils : un titre de bien tient sur deux lignes au lieu de trois.

**La règle proposée.** « Une seule police est servie par le Worker, pour les titres seulement : un fichier woff2 de 32 Ko au plus, sous-ensemble latin, sous licence libre consignée dans `docs/design/README.md`, servi depuis le même domaine avec un cache d'un an, déclaré une seule fois dans la base du système de design avec `font-display: swap`. Aucune autre police n'est téléchargée. Le texte courant reste dans la police de l'appareil. »

**Son test**, dans `packages/api/test/design.test.ts` :

1. la base du système porte une seule `@font-face`, qui vise `/polices/titre.woff2` ; toute autre `@font-face`, dans la base ou dans une feuille locale, reste refusée ;
2. le fichier pèse 32 768 octets au plus et commence par la signature `wOF2` ;
3. la route le sert en `font/woff2`, avec `cache-control: public, max-age=31536000, immutable` ;
4. `budgetProblems` refuse toujours toute ressource d'un autre domaine ;
5. à l'étape 6, le décalage de mise en page mesuré sur la page publique reste sous 0,1 (seuil des Core Web Vitals).

Sans accord, Maison se fait avec la police de l'appareil : elle reste belle, elle est seulement moins tenue d'un appareil à l'autre.

## La question posée à Shawez

Une seule question, à choix multiple :

1. **Maison, avec sa police** (recommandé) : la direction A, et l'accord pour la règle ci-dessus.
2. **Maison, sans changer de règle** : la direction A, titres dans la police de l'appareil.
3. **Atelier** : la direction B.
4. **Toits vernissés** : la direction C.

Sans réponse dans les 24 heures : le choix 2, Maison sans changer de règle. La transformation continue.
