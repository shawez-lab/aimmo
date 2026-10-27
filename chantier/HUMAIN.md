# Ce que seul un humain peut faire

Le chef de chantier n'attend jamais : il passe à une autre tâche et prévient une seule fois, à l'avance, dans le compte rendu du matin.
Il n'a pas le droit de taper un mot de passe, un code ou une clé, de créer un compte, de payer, d'accepter des conditions ni de donner une autorisation à la place de Shawez.

| Id | Quoi | Qui | Pour | Statut |
| --- | --- | --- | --- | --- |
| H01 | Créer le dépôt privé `shawez-lab/aimmo` sur github.com/new | Shawez | tout | fait (2026-10-25) |
| H02 | Ouvrir ce dépôt à l'application Claude sur GitHub, si elle n'a pas accès à tous les dépôts | Shawez | tout | fait (2026-10-25) : l'application a déjà accès à tous les dépôts |
| H03 | Dans Codex : connecter le dépôt, activer Code review et Automatic review | Shawez | relecture et tâches de Codex | fait (2026-10-25) : Codex du compte ChatGPT de Marion Gravelin, accès limité à `shawez-lab/aimmo`, environnement `aimmo` créé (installation `npm ci`, Internet coupé pendant le travail), relecture automatique à l'ouverture de chaque proposition. Node 22 n'est pas sélectionnable chez Codex : les vérifications GitHub, sous Node 22, font foi |
| H04 | Ajouter au dépôt les secrets `CLOUDFLARE_API_TOKEN` et `CLOUDFLARE_ACCOUNT_ID`, comme pour `shawez-immo` | Shawez | S09, mise en ligne | signalé le 2026-10-26 |
| H05 | Accorder l'accès à Gmail par API sur l'écran d'accord de Google | Shawez | S11 | signalé le 2026-10-26 |
| H06 | Vérification de l'entreprise et validation de l'application AIMMO chez Meta | Shawez | M02 | signalé le 2026-10-26 |
| H07 | Accès à l'API Google Business Profile | Shawez | M01 | plus tard |
| H08 | Modèles juridiques validés par Marion Gravelin et l'avocat | Marion, avocat | M06 | plus tard |
| H09 | Création de la société AIMMO, carte professionnelle, assurance, médiateur | Shawez, Marion | pilote | plus tard |
| H10 | Comptes et accords de flux avec les portails | Shawez | diffusion sur les portails | plus tard |
| H11 | Codex accepte les tâches confiées par un commentaire `@codex` | Shawez | tâches de Codex | fait (2026-10-26) : Codex a pris S07 et l'a faite, mais n'a pas pu pousser son commit (voir H12) |
| H12 | Ouvrir la tâche Codex de S07 (https://chatgpt.com/s/cd_6adf1954e13c81919c60e12945ec840e) et pousser son commit `89fb138` sur la branche `codex/S07` (bouton de mise à jour de la branche ou de création de la proposition). Pour la suite : dans l'environnement `aimmo` de Codex, vérifier qu'il peut pousser lui-même sur ses branches | Shawez | S07, puis toutes les tâches de Codex | fait (2026-10-26) pour S07 : Shawez a poussé le travail (`18fa3cc`). Pour la suite, l'environnement de Codex n'a pas de remote Git, il ne peut pas pousser : Codex reste relecteur, ses tâches reviennent à Claude |
| H13 | Ouvrir un compte chez le fournisseur d'IA retenu et ranger sa clé dans les secrets du Worker AIMMO | Shawez | C04 réel, C09 | signalé le 2026-10-26 |
| H14 | Créer une clé d'API AIMMO (32 caractères ou plus, gardée dans un coffre), et ranger son empreinte SHA-256 dans le secret `API_KEYS` du Worker `aimmo-api`, comme le décrit `docs/API.md` | Shawez | S11, premier appelant de l'API | signalé le 2026-10-26 |
| H15 | Exporter en CSV la liste d'exclusion de Shawez, et les contacts de GoHighLevel et de ManyChat avec leurs désinscriptions, au format décrit dans `docs/REPRISE.md`, puis les déposer où I04 l'indiquera (jamais dans le dépôt) | Shawez | I03, I04 | signalé le 2026-10-26 |
| H16 | À la mise en service de la captation par mail et formulaire (C09) : créer la règle de routage mail de Cloudflare vers le Worker `aimmo-api`, et ranger les variables `MAIL_NETWORK_ID`, `MAIL_FORWARD_TO`, `MAIL_OWN_ADDRESSES` et le secret `INTAKE_KEYS`, comme le décrit `docs/API.md` ; `MAIL_FORWARD_TO` ne doit jamais être une adresse routée vers le Worker | Shawez | C09 | plus tard |
| H17 | À la mise en service de la captation Meta (C09), après H06 : dans l'application Meta, abonner Instagram, la page Facebook et WhatsApp Business à `https://<adresse du Worker>/v1/meta/notifications` avec un jeton de vérification de 32 caractères ou plus ; ranger le secret `META_APP_SECRET`, l'empreinte du jeton dans `META_VERIFY_TOKEN_SHA256`, et les variables `META_NETWORK_ID`, `META_OWN_IDS`, `META_APP_IDS`, comme le décrit `docs/API.md` | Shawez | C09 | plus tard |
| H18 | Préparer 50 contacts réels anonymisés (sans nom, numéro, mail ni adresse), chacun avec le classement que Shawez lui aurait donné, au format décrit dans `docs/MESURE.md`, et lancer la mesure comme il l'explique, sur une machine hors du dépôt (jamais dans le dépôt) | Shawez | Q05, mesure de M03 | signalé le 2026-10-27 |

Quand une tâche à moins de trois places de la tête du plan attend une ligne « plus tard », la séance la marque « signalé le <date> » et la dit une fois dans « Besoin de toi ».
