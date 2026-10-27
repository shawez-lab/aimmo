# API du socle (S09)

Un Worker Cloudflare, `aimmo-api`, avec la base D1 `aimmo` en Europe. Code : `packages/api`. Il est en **mode essai** : il lit et décide, il n'envoie rien.

## Adresses

Toutes sous `/v1`. Sauf la santé, chaque appel porte `Authorization: Bearer <clé>`.

| Méthode | Adresse | Ce qu'elle rend | Qui |
| --- | --- | --- | --- |
| GET | `/v1/sante` | version et mode, sans rien lire | tout le monde |
| GET | `/v1/fiches` | les fiches qu'on a le droit de voir | agent (ses clients), direction, conformité |
| GET | `/v1/fiches/<id>` | la fiche complète, fiches réunies comprises | selon R16 |
| GET | `/v1/fiches/<id>/journal` | qui a lu ou changé la fiche | direction, conformité |
| GET | `/v1/biens/<id>` | un bien, complet ou en fiche commune | selon R16 |
| POST | `/v1/envois/decision` | la décision d'envoi et la règle qui a décidé, sans rien envoyer | selon R16 |
| POST | `/v1/qualifications/<id>/correction` | corrige la catégorie d'un contact, `{"category": "buyer", "route": null}` ; la correction est gardée et rejoint les cas de mesure | qui voit la fiche en entier (R16) |
| GET | `/v1/contacts-chauds` | les contacts chauds à rappeler, matin ou soir, avec la raison de leur note : un agent ne voit que les siens, jamais une personne exclue | agent, direction, conformité (R16, R25) |
| GET | `/v1/moi` | qui porte la clé : le rôle, et le prénom pour un agent en activité ; sert à la connexion de l'application de l'agent | toute clé ; un agent parti est refusé (R16) |
| GET | `/v1/plan-du-jour` | le plan du jour de l'agent, figé à 7 h 30 heure de Paris par le planificateur : rappels demandés, estimations à relancer, rendez-vous à proposer, dans l'ordre écrit, chaque ligne avec sa raison et sa base légale ; `null` avant 7 h 30 | l'agent lui-même seulement (R16, R35, R36) |
| GET | `/v1/fiches/<id>/resume` | la fiche pour l'application de l'agent : projets, origines, accords, 10 derniers messages, rappels ; `contact.allowed` faux et `call` nul pour une personne exclue ou qui a demandé l'arrêt ; lecture ou refus écrits au journal | l'agent de la fiche, la direction, la conformité, comme `/v1/fiches/<id>` (R02, R04, R16) |
| POST | `/v1/rappels/<id>/fait` | marque un rappel fait, sans corps ; la tâche garde sa ligne ; rien n'est envoyé ; une tâche inconnue ou d'un autre est refusée de la même façon | qui voit la fiche en entier : l'agent de la fiche, la direction, la conformité (R16, R17) |
| GET | `/v1/rendez-vous/jour` | les rendez-vous du jour de l'agent, heure de Paris, annulés exclus, dans l'ordre de leur heure, chacun avec son brief rangé ; prénom et brief seulement si l'agent voit encore la fiche, brief caché si la fiche a été fusionnée ou défusionnée depuis, ou si le bien n'est plus dans les droits de l'agent (`briefMissing` dit pourquoi) ; chaque fiche rendue et chaque refus sont écrits au journal | l'agent lui-même seulement (R16) |
| GET | `/v1/usage/matin` | l'usage du matin sur les 7 derniers jours, aujourd'hui compris, heure de Paris : un jour compte quand le plan figé a été ouvert avant midi ; pour l'agent, ses jours ; pour la direction, par jour le nombre d'agents, sans nom ni classement | l'agent lui-même, la direction (R14, R16) |
| POST | `/v1/registre/reglage` | `{ prefix, firstNumber, width }` : le format du registre des mandats du réseau, une seule fois, avant la première inscription (pendant la preuve, celui de l'agence, H23) | direction (R16, R39) |
| GET | `/v1/registre/controle` | le contrôle d'intégrité du registre : rangs sans trou, empreintes, liens, numéros, chaque ligne égale à son mandat et à son ancre au journal (rang et empreinte écrits à l'inscription), lignes effacées en fin de registre ; `brokenAt` et `problem` au premier écart | direction, conformité (R16, R39) |
| GET | `/v1/mandats/<id>/registre` | les lignes du registre d'un mandat : inscription avec son numéro, annulation s'il y en a une | l'agent du mandat, la direction, la conformité (R16) |
| GET | `/v1/modeles` | les modèles du réseau, toutes versions, avec texte, champs, empreinte et état « essai » ou « validé » | agent, direction, conformité (R40) |
| POST | `/v1/modeles` | `{ kind, body }` : une nouvelle version d'un modèle, à l'état « essai » ; champs `{{…}}` du catalogue seulement ; ligne `!! ` mise en évidence | direction (R16, R40) |
| POST | `/v1/modeles/<id>/validation` | le modèle passe « validé », avec qui l'a validé ; jamais par le code (H08) | conformité (R16, R40) |
| POST | `/v1/documents` | `{ kind, personId, propertyId, inputs?, mandateId? }` : un document généré depuis la dernière version du modèle ; `inputs` : `honoraires.montant` (euros entiers), `honoraires.charge` (`vendeur` ou `acquereur`), `mandat.duree_mois`, et pour un avenant (`kind` `avenant_mandat`, `mandateId` du mandat signé et numéroté) `avenant.prix` (euros entiers) et `avenant.duree_mois` ; un champ qui manque rend le document `incomplet` ; un modèle d'essai donne un document d'essai | qui voit la fiche et le bien en entier : agent, direction (R16, R40) |
| GET | `/v1/documents/<id>` | un document généré, figé, avec la version et l'empreinte de son modèle | qui voit la fiche en entier (R16) |
| POST | `/v1/honoraires/bareme` | `{ maxRatePercent, minEur }` : le barème des honoraires du réseau (taux maximal du prix, au centième, et minimum en euros) ; en ajout seul, le dernier est en vigueur | direction (R16, R41) |
| POST | `/v1/fiches/<id>/identite` | `{ piece, seenAt }` : l'identité vérifiée (`carte_identite`, `passeport` ou `permis_conduire`, et quand) ; jamais de numéro ni de copie | l'agent de la fiche, la conformité (R15, R16, R41) |
| POST | `/v1/documents/<id>/controle` | le contrôle avant signature, ligne par ligne : champs, modèle validé, honoraires au barème et payeur, mandant égal au propriétaire, identité vérifiée depuis moins d'un an ; `passed` faux au moindre échec ; gardé | qui voit la fiche et le bien en entier (R16, R41) |
| POST | `/v1/documents/<id>/signature-papier` | `{ signedAt, place, scanRef, source?, sourceDetail? }` : un mandat signé sur papier (`agence`, `hors_agence` ou `distance` ; référence du scan rangé hors de la base) ; contrôlé à l'instant, rangé avec sa source, numéroté au registre, exemplaire du mandant produit ; une reprise continue là où elle s'était arrêtée | l'agent de la fiche, la direction (R16, R38, R39, R41) |
| GET | `/v1/documents/<id>/exemplaire` | l'exemplaire signé du mandant, mandat ou avenant, avec le numéro du mandat au registre, sa date et son lieu de signature | qui voit la fiche en entier (R16, R39) |
| GET | `/v1/biens/<id>/diffusion` | le bien peut-il être diffusé : `allowed`, `reason` (`no_mandate`, `cancelled`, `withdrawn`, `expired`, `duration_unknown`, `withdrawal_period`, `allowed`, `allowed_early_start`) et dernier jour du délai de rétractation | qui voit le bien en entier (R16, R42) |
| POST | `/v1/mandats/<id>/debut-anticipe` | `{ proof, receivedAt }` : la demande écrite du vendeur de diffuser avant la fin du délai de rétractation | l'agent de la fiche, la direction (R16, R42) |
| POST | `/v1/mandats/<id>/retractation` | `{ proof, receivedAt }` : la rétractation reçue dans le délai ; le mandat s'arrête, son inscription au registre est annulée, la diffusion cesse | l'agent de la fiche, la direction (R16, R42) |
| GET | `/v1/mandats/echeances` | les tâches d'échéance de l'agent : fin de mandat (renouvellement à proposer, 30 jours avant) et fin de la période de 3 mois d'un mandat exclusif (15 jours avant), rangées chaque jour à 6 h ; rien n'est envoyé | l'agent lui-même (R16) |
| POST | `/v1/documents/<id>/signature-avenant` | `{ signedAt, place, scanRef }` : un avenant signé sur papier, contrôlé à l'instant (mêmes contrôles que le mandat, plus le mandat en vigueur) ; le prix ou la durée du mandat changent alors | l'agent de la fiche, la direction (R16, R41) |
| GET | `/v1/mandats/<id>/conditions` | les conditions en vigueur d'un mandat (prix, durée) et l'historique de ses avenants signés | qui voit la fiche en entier (R16) |
| GET | `/v1/mandats/<id>/chronologie` | la chronologie d'un mandat : avis de valeur validé, document généré, premier contrôle réussi, signature enregistrée et numérotée ; durée de chaque étape et total, comparé à la cible de 10 minutes | direction, conformité (R16) |
| POST | `/v1/documents/<id>/signature-en-ligne` | `{ consentProof }` : ouvre une session de signature en ligne pour un document contrôlé, avec l'accord du signataire à recevoir son code et son exemplaire par mail ; code à usage unique de 6 chiffres, valable 10 minutes, seule son empreinte est gardée dans la session ; le mail passe par le contrôle central (heures, exclusions, accord) et reste dans la boîte d'essai tant que H05 n'est pas fait | l'agent de la fiche, la direction (R16, R41) |
| POST | `/v1/signatures/<id>` | `{ code, drawing? }` : la signature par le code, et le tracé à l'écran ; 5 codes faux bloquent la session ; un document modifié ne se signe pas ; toujours une signature d'essai (`realSignature: false`) tant que l'avocat n'a pas validé le dossier de preuve (H24) | l'agent de la fiche, la direction (R16) |
| GET | `/v1/plan-du-jour/controle` | les écarts du contrôle quotidien de la base légale des plans du jour sur 30 jours, non encore vus : des nombres par raison et par jour, jamais une fiche | direction, conformité (R16, R36) |
| GET | `/v1/attribution/regles` | les règles d'attribution des contacts, les délais de rappel et les communes : les mêmes pour tous [R25] | toute clé |
| GET | `/v1/journal/verification` | la chaîne d'empreintes du journal est-elle intacte | direction, conformité |
| GET, POST | `/v1/meta/notifications` | vérification de l'abonnement, puis notifications signées d'Instagram, Facebook et WhatsApp ; réponse prête en mode essai, jamais envoyée | Meta, par signature (`META_APP_SECRET`) |
| POST | `/v1/captation/formulaire` | dépose un formulaire « Être rappelé » ; rend seulement des statuts, la réponse est prête en mode essai, jamais envoyée | clé de dépôt `site_form` (`INTAKE_KEYS`) |
| POST | `/v1/assistant/sessions` | ouvre une conversation de l'assistant du site, rend son jeton `sessionId` | clé de dépôt `site_chat` (`INTAKE_KEYS`) |
| POST | `/v1/assistant/sessions/<sessionId>/messages` | un message du visiteur ; rend un statut, la réponse est prête en mode essai, jamais rendue | clé de dépôt `site_chat` (`INTAKE_KEYS`) |
| POST | `/v1/automatisations/envoi` | une automatisation du site demande si son envoi peut partir ; rend la décision et sa règle, rien n'est envoyé | clé de dépôt `site_auto` (`INTAKE_KEYS`) |
| POST | `/v1/estimation/commune` | fourchette de prix au m² d'une commune, pour un type de logement, et proposition de rendez-vous ; jamais le prix d'un bien | clé de dépôt `site_estimate` (`INTAKE_KEYS`) |

Corps de `/v1/envois/decision` : `{"personId": "...", "channel": "email", "kind": "reply", "conversationId": "...", "purpose": "...", "at": "2026-10-19T08:00:00Z"}`. Chaque lecture, chaque refus et chaque décision sont écrits au journal [R13, R16].

## Fermé par défaut

- Sans le secret `API_KEYS`, ou s'il est mal formé, l'API répond 503 et ne lit rien.
- Si la variable `MODE` ne vaut pas `essai`, l'API répond 503.
- Une clé absente, inconnue ou de moins de 32 caractères : 401.

## Les clés

Le secret Cloudflare `API_KEYS` contient seulement l'empreinte SHA-256 de chaque clé et l'identité qu'elle porte, jamais la clé :

```json
[{ "sha256": "<empreinte>", "role": "agent", "userId": "<id de l'agent>", "networkId": "<id du réseau>" }]
```

Rôles : `agent`, `direction`, `compliance`, `partner`.

## Captation, en mode essai (C06)

- **Formulaire du site** : `POST /v1/captation/formulaire`, corps `{"submissionId", "firstName", "email", "phone", "message", "page", "propertyRef", "submittedAt"}`. Clé de dépôt dans le secret `INTAKE_KEYS`, qui ne lit rien : `[{ "sha256": "<empreinte>", "networkId": "<id du réseau>", "source": "site_form" }]`.
- **Mails** (portails compris) : le Worker reçoit les mails du routage mail de Cloudflare (`email`). Variables : `MAIL_NETWORK_ID` (réseau), `MAIL_FORWARD_TO` (boîte où chaque mail est d'abord remis tel quel, pour qu'aucun ne se perde), `MAIL_OWN_ADDRESSES` (nos adresses, séparées par des virgules). Aucun mail n'est jamais rejeté. Cette remise n'est pas un envoi au sens du contrôle central : rien n'est composé, l'adresse vient de la configuration (vérifiée chez Cloudflare), jamais du mail, et aucun client ne reçoit rien. `MAIL_FORWARD_TO` ne doit jamais être une adresse elle-même routée vers le Worker. Un mail non remis ou non traité laisse une ligne `mail.remise_impossible` ou `mail.non_traite` au journal, sans adresse.
- Le dépôt du formulaire ne rend que `{"ok": true, "received": true}` : son sort (personne exclue, déjà connue) ne regarde pas le déposant.
- L'heure de réception d'un mail ou d'un formulaire est celle où AIMMO le reçoit, jamais la date qu'il porte [R01].
- De bout en bout : rangé une fois [R18], rattaché à sa fiche, réponse composée, contrôle central, puis **boîte d'essai** (`trial_outbox`) et ligne `envoi.essai` au journal, sans texte ni adresse [R13]. Rien ne part.
- Aucune adresse n'est branchée tant que la mise en service (C09) ne le fait pas.

## Instagram, Facebook et WhatsApp, en mode essai (C07)

- Une seule adresse pour l'application Meta : `/v1/meta/notifications`. Le champ `object` choisit le canal : `instagram`, `page` (Facebook : Messenger et commentaires de la page), `whatsapp_business_account`.
- **Abonnement** : `GET` avec `hub.mode=subscribe`, `hub.verify_token`, `hub.challenge`. Le défi n'est rendu qu'avec le bon jeton (32 caractères ou plus) ; le secret `META_VERIFY_TOKEN_SHA256` ne garde que son empreinte.
- **Notifications** : `POST`, lues seulement si `X-Hub-Signature-256` est le HMAC-SHA256 du corps brut avec le secret `META_APP_SECRET` (plusieurs, séparés par des virgules, pendant un changement de secret). Signature absente ou fausse : 401, rien n'est lu ni rangé, ligne `meta.refuse` au journal. Corps de plus de 512 Ko : 413. Objet inconnu ou corps illisible : 200, ligne `meta.non_traite`.
- Variables : `META_NETWORK_ID` (réseau), `META_OWN_IDS` (nos page, compte Instagram et numéros WhatsApp, séparés par des virgules), `META_APP_IDS` (nos applications Meta). Sans secret ou sans réseau : 503.
- Les réponses écrites par un humain, reçues en écho, sont lues d'abord : l'assistant se tait dans cette conversation [R21]. Un écho d'une application qui n'est pas dans `META_APP_IDS` est réputé humain ; pendant l'essai, un écho de ManyChat fait donc taire l'assistant dans cette conversation.
- La réponse va à la conversation reçue : le compte propre au canal pour un message privé, le commentaire (réponse privée) pour un commentaire, seulement si un message de la personne y est rangé.
- Puis de bout en bout comme les mails : rangé une fois [R18], rattaché, réponse composée, contrôle central, boîte d'essai. Rien ne part, aucune adresse extérieure n'est appelée ; ManyChat reste seul à répondre aux clients.
- Rien n'est branché chez Meta tant que la mise en service (C09) ne le fait pas, après H06.

## Assistant du site, en mode essai (C08)

- Appelé par le serveur du site, jamais par le navigateur : la clé de dépôt `site_chat` (secret `INTAKE_KEYS`, `"source": "site_chat"`) n'ouvre que l'assistant, ne lit aucune fiche, et ne dépose pas de formulaire ; une clé `site_form` n'ouvre pas l'assistant.
- **Ouvrir** : `POST /v1/assistant/sessions`, corps `{"visitorId": "..."}` ; rend `201 {"ok": true, "sessionId": "<64 caractères>"}`.
- **Écrire** : `POST /v1/assistant/sessions/<sessionId>/messages`, corps `{"visitorId", "messageId", "text", "page", "propertyRef"}` ; `text` de 1 à 2 000 caractères, `messageId` unique dans la session (le même message reçu deux fois ne donne qu'une réponse [R18]). Rend `{"ok": true, "mode": "essai", "sent": false, "status": "ready" | "with_agent" | "none", "reply": null}`. Une session d'un autre visiteur ou d'un autre réseau : 404.
- `visitorId` : identifiant opaque tiré au hasard par le site (16 à 128 caractères, lettres, chiffres, `-`, `_`), **jamais** une adresse IP, un mail ou un numéro. AIMMO n'en garde que l'empreinte SHA-256, pour les limites. Aucune adresse IP, aucun navigateur, aucun en-tête du visiteur n'est lu ni rangé [R15] : la fiche du visiteur ne contient que ce qu'il a écrit et les réponses.
- **Limites**, par heure pleine : 5 conversations ouvertes par visiteur, 30 messages par visiteur, 15 par conversation. Au-delà : 429, rien n'est rangé.
- De bout en bout comme les autres canaux : rangé une fois, rattaché, réponse composée, **contrôle central** (arrêt, exclusions, relais à l'agent, mention de l'assistant au premier message, chiffres, discrétion du bien [R02, R04, R06, R10, R19, R21]), puis boîte d'essai. Sur la session de l'assistant, seule la réponse au visiteur part, dans sa session et dans l'heure de son message : jamais de message d'initiative [R03, R01].
- Le statut ne dit jamais si la personne est exclue ou déjà connue [R02, R16] : `ready` (réponse prête), `with_agent` (l'agent a la main ou doit répondre lui-même), `none` (rien de plus).
- Hors essai, la réponse sera rendue dans `reply` par le canal `SiteSessionChannel`, qui la remet à la seule session du visiteur et ne garde rien. L'intégration au site de `shawez-immo` est une tâche à part, par une proposition, jamais directement sur main.

## Automatisations du site, en mode essai (B01)

- Appelé par le serveur du site avant chaque envoi d'une de ses automatisations, jamais par le navigateur : la clé de dépôt `site_auto` (secret `INTAKE_KEYS`, `"source": "site_auto"`) ne sert qu'à cette demande ; elle ne lit aucune fiche et ne dépose rien d'autre.
- Corps : `{"automation": "rappel_visite" | "courrier_vendeur", "email": "...", "ref": "<id de la visite ou du courrier chez le site>", "text": "<le texte du site>", "figures": [14]}`. `ref` : 1 à 64 caractères, lettres, chiffres, `-`, `_` ; `text` : 4 000 caractères au plus ; `figures` : les chiffres du texte qui viennent des données du site [R10].
- Le socle retrouve la fiche par l'adresse, sans jamais en créer : adresse inconnue → `unknown_person`, adresse portée par plusieurs fiches non réunies → `ambiguous_person`. Puis la demande passe par le **contrôle central**, accord du suivi de l'estimation compris [R01 à R05, R06 à R10], avec les seuls canaux du mode essai : rien ne part [R26].
- Rend `{"ok": true, "mode": "essai", "sent": false, "data": {"status": "would_send" | "refused" | "failed", "rule": "R01" | … | null, "code": null | "unknown_person" | "ambiguous_person", "reason": "..."}}`. Contrairement à l'assistant du site, la règle est rendue : l'appelant est le site de l'agence lui-même, qui tient déjà la fiche et doit comparer sa décision à celle du socle (B03).
- Au journal : l'automatisation, la décision, sa règle ; ni l'adresse, ni le texte, ni la référence [R13].

## Estimation en ligne du site (E05)

- Appelé par le serveur du site, jamais par le navigateur, avec la clé de dépôt `site_estimate` (secret `INTAKE_KEYS`), qui ne lit aucune fiche.
- Corps : `{"visitorId": "...", "postalCode": "21000", "town": "Dijon", "kind": "appartement" | "maison"}` et rien d'autre : une surface, une adresse ou tout autre champ est refusé (400). Sans visite, pas de prix d'un bien précis [R31].
- Rend `{"ok": true, "mode": "essai", "data": {"town", "postalCode", "kind", "perM2": {"low", "median", "high"}, "sales", "period": {"from", "to"}, "data": {"lastSale", "source", "recentMissing"}, "next": "appointment"}}` : premier quartile, médiane et troisième quartile du prix au m² des ventes DVF de la commune [R28]. Sans fourchette possible : `"data": null`, `"reason"` (`commune_introuvable`, `hors_zone`, `dvf_non_couvert`, `donnees_absentes`, `peu_de_ventes`) et `"next": "appointment"`.
- Seuls le code postal et la commune partent à la Base adresse nationale. Les ventes viennent des fichiers DVF publics du site, lus en lecture seule à l'adresse de la variable `DVF_BASE_URL` (en https, terminée par `/`) ; sans elle, le service est fermé (503).
- Limites, par heure pleine : 10 demandes par visiteur, 600 par réseau ; au-delà, 429. Seule une empreinte de `visitorId` est gardée, pour les limites, et elle change à chaque heure pleine : elle ne relie pas les demandes d’un visiteur dans le temps [R15]. Rien n’est effacé.
- Des fichiers de ventes manquants ou illisibles pendant la demande : pas de fourchette (`donnees_absentes`), et leur nombre au journal.

## Réservation des rendez-vous, en mode essai (V08)

- `POST /v1/rendez-vous/creneaux` `{ visitorId, agentId, kind, from, days }` et `POST /v1/rendez-vous/reservation` `{ visitorId, agentId, kind, start, source, firstName?, email | phone, consentProof, propertyId? }`, avec la seule clé de dépôt `site_booking` (secret `INTAKE_KEYS`), pour le site, l'assistant et l'espace client.
- Les créneaux ne portent que leur début et leur fin ; un agent inconnu ou d'un autre réseau rend une liste vide. `kind` : `estimation`, `visite` ou `appel` ; la signature reste à l'agent. 14 jours au plus.
- Seul un créneau proposé se réserve. L'accord « rendez-vous » est enregistré au moment de réserver avec la preuve donnée (`consentProof`) [R03] ; il est retiré aussitôt si la réservation ne passe pas. La réponse rend la confirmation et le jeton du lien (`RDV_LINK_BASE`), jamais si la personne était connue ; rien ne part en mode essai [R26].
- Limites par visiteur et par heure (30 demandes de créneaux, 3 réservations) et par réseau (1 000).

## Planificateur (B02)

- Le Worker a un déclencheur horaire (`[triggers]` de `wrangler.toml`, à la 7e minute de chaque heure UTC) : il passe les tâches à heure fixe dues à l'heure de Paris, été comme hiver. Plus aucune tâche du système ne doit être planifiée ailleurs, ni dans GitHub Actions, ni dans une application (bascule de `taches.yml` en B04).
- Une tâche ne passe qu'une fois par créneau (date et heure de Paris), même si le déclencheur repasse ou si l'heure revient au changement d'heure ; la table `scheduled_runs` le garantit et ne s'efface jamais.
- Chaque passage est écrit au journal (`planificateur.passage` : tâche, créneau, issue, nom de l'erreur seulement) ; une tâche en erreur n'arrête pas les autres.
- En mode essai, les tâches du site (`site.rappels_visite` de 18 h à 21 h, `site.courriers_vendeur` de 8 h à 21 h) notent leur passage et n'appellent rien [R26]. Hors mode essai, rien ne passe.
- Les rappels des rendez-vous (`rdv.rappels`, V04) passent du lundi au samedi de 8 h à 19 h : la confirmation restée en attente, un rappel la veille et un le jour même, par le contrôle central et les seuls canaux du mode essai [R26]. Le lien pour décaler ou annuler commence par la variable `RDV_LINK_BASE` (en https, sans chiffre, terminée par `/`) ; sans elle, les rappels partent sans lien.
- Les briefs des rendez-vous (`rdv.briefs`, V05) passent à toute heure : chaque rendez-vous tenu reçoit son brief au moins une heure avant, rangé pour son seul agent, sans aucun envoi [R34].

## Mise en ligne

`.github/workflows/deployer-api.yml`, à chaque arrivée sur main, une fois H04 fait : vérifications, création de la base `aimmo` en juridiction européenne si elle manque, migrations de `db/migrations`, puis déploiement. Aucune route sur shawez-immo.com : seulement l'adresse workers.dev du compte. Chaque proposition vérifie aussi que le Worker s'empaquette (`wrangler deploy --dry-run`).

## En local

```sh
cd packages/api
npx wrangler@4.149.0 d1 migrations apply aimmo --local
echo 'API_KEYS=[...]' > .dev.vars   # jamais commité
npx wrangler@4.149.0 dev --local
```

## Application de l'agent (A01)

- Le Worker sert l'application web installable à l'adresse `/app/`, en mode essai seulement : page, style, script, manifeste, icône et service worker. Aucune donnée n'y est écrite : l'application lit tout par l'API, sous les droits de l'agent (R16).
- L'agent s'y connecte avec sa clé personnelle (H22), saisie une fois et gardée sur son appareil ; elle part seulement dans l'en-tête `Authorization`, jamais dans une adresse. « Se déconnecter » l'efface de l'appareil.
- Le service worker ne garde que la coquille de l'application ; aucune réponse de l'API n'est mise en cache. Politique de contenu stricte : aucun script en ligne, aucun appel hors de ce Worker.
- Les fichiers que reçoit le navigateur sont dans `packages/api/app/fichiers.ts`, hors du code du Worker.
