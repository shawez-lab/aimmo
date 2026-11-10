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
| GET | `/v1/biens/<id>/mandat` | les documents du bien, sans contenu, le mandat en cours avec le dernier jour de son délai de rétractation (`withdrawalLastDay`, nul sans délai ; `withdrawalUnfinished` : rétractation notée, annulation au registre à finir) et les mandants possibles (fiches liées au bien comme propriétaire, vues en entier) | l'agent du bien, direction, conformité (R16) |
| POST | `/v1/biens/<id>/scans-mandat` | dépose le scan signé (PDF, JPEG ou PNG, 20 Mo au plus, empreinte en `x-aimmo-sha256`), rend la référence qui sert à `signature-papier` ou `signature-avenant` ; `503 depot_ferme` sans stockage `PIECES` | l'agent du bien, direction (R16) |
| GET | `/v1/qualifications/cas-corriges` | les classements corrigés au format du banc de mesure (`texte;categorie;suite`), sans coordonnées ni nom connu, téléchargés en CSV ; le journal garde le nombre, jamais un texte | direction (R15, R16) |
| POST | `/v1/qualifications/<id>/correction` | corrige la catégorie d'un contact, `{"category": "buyer", "route": null}` ; la correction est gardée et rejoint les cas de mesure | qui voit la fiche en entier (R16) |
| GET | `/v1/contacts-chauds` | les contacts chauds à rappeler, matin ou soir, avec la raison de leur note : un agent ne voit que les siens, jamais une personne exclue | agent, direction, conformité (R16, R25) |
| GET | `/v1/alertes-agent` | les conversations à reprendre et les réponses qui n'ont pas pu partir, sur les fiches que l'agent voit maintenant, les plus anciennes d'abord (30 au plus, `more` dit s'il y en a d'autres) | agent (R12, R16) |
| GET | `/v1/alertes-agent/sans-agent` | le nombre d'alertes qu'aucun agent ne voit, par raison, sans donnée de client ; `more` : il reste des fiches réunies non examinées, le nombre est un minimum | direction (R12, R13, R16) |
| POST | `/v1/alertes-agent/<id>/vue` | `{ createdAt }`, la date lue : l'agent a vu l'alerte, la ligne reste ; `changed` si elle a été rouverte depuis (à relire) ; elle se rouvre si le client réécrit sans réponse humaine ou si une nouvelle réponse tombe | agent (R16, R17) |
| GET | `/v1/moi` | qui porte la clé : le rôle, et le prénom pour un agent en activité ; sert à la connexion de l'application : un agent arrive sur sa journée, la direction sur l'écran « Le réseau » (K09), tout autre rôle est refusé | toute clé ; un agent parti est refusé (R16) |
| GET | `/v1/plan-du-jour` | le plan du jour de l'agent, figé à 7 h 30 heure de Paris par le planificateur : rappels demandés, estimations à relancer, rendez-vous à proposer, dans l'ordre écrit, chaque ligne avec sa raison et sa base légale ; `null` avant 7 h 30 | l'agent lui-même seulement (R16, R35, R36) |
| GET | `/v1/fiches/<id>/resume` | la fiche pour l'application de l'agent : projets, origines, accords, 10 derniers messages, rappels ; `contact.allowed` faux et `call` nul pour une personne exclue ou qui a demandé l'arrêt ; `call` nul aussi sans prospection acceptée par téléphone ni demande de rappel de moins de 13 mois, `callRefusal` dit pourquoi (`excluded`, `no_phone`, `no_consent`, `refused_request` : la personne a refusé depuis sa demande, seule une nouvelle demande rouvre, `refused_recently` et `too_many_calls` avec `callReopensAt`, `outside_hours`), `callClosesAt` donne la fin du créneau d'une prospection acceptée ; `qualification` donne le dernier classement du contact et sa dernière correction, jamais une note ; lecture ou refus écrits au journal | l'agent de la fiche, la direction, la conformité, comme `/v1/fiches/<id>` (R02, R04, R16) |
| GET | `/v1/fiches/<id>/nom/corrections` | les corrections de nom de la fiche, fiches réunies comprises, avec les valeurs d'avant ; lecture ou refus écrits au journal, aucun nom au journal | direction (R13, R16, R17) |
| POST | `/v1/fiches/<id>/nom/corrections` | `{ firstName, lastName, reason }` : corrige sur la fiche survivante ; un champ absent ne change pas, un champ vide ou nul se vide (jamais les deux) ; `reason` : `faute_de_frappe`, `nom_dans_prenom`, `demande_de_la_personne`, `etat_civil` ; réponse `{ firstName, lastName, changed }` ; 409 `name_changed` si le nom vient de changer ; les documents déjà générés gardent leur texte | direction (R13, R16, R17) |
| POST | `/v1/fiches/<id>/accords` | `{ purpose, channel, proof, givenOn }` : note l'accord qu'une personne a donné, avec sa preuve écrite (10 à 1 000 caractères) et le jour où elle l'a donné (`AAAA-MM-JJ`, à Paris), jamais dans le futur ; aujourd'hui vaut l'heure du serveur, un jour passé son premier instant ; réponse `{ consentId, givenAt, already }`, rien n'est envoyé ; 409 si la personne est exclue, a demandé l'arrêt, ou si la date précède un retrait ou une levée | l'agent de la fiche, la direction (R03, R16, R202) |
| POST | `/v1/fiches/<id>/accords/<id>/retrait` | retire l'accord et le même accord sur les fiches réunies ; la ligne reste | l'agent de la fiche, la direction (R03, R16, R17) |
| POST | `/v1/fiches/<id>/appels` | `{ outcome: 'called' \| 'refused' }` : note que l'agent a appelé, ou que la personne a refusé ; heure et base fixées par le serveur ; deux notes identiques à moins d'une minute n'en font qu'une (`already`) ; ni numéro ni texte ; rien n'est envoyé ; la fiche ferme l'appel et donne `callReopensAt` (`too_many_calls`, `refused_recently`) | l'agent de la fiche, la direction (R16, R17, R204) |
| POST | `/v1/rappels/<id>/fait` | marque un rappel fait, sans corps ; la tâche garde sa ligne ; rien n'est envoyé ; une tâche inconnue ou d'un autre est refusée de la même façon | qui voit la fiche en entier : l'agent de la fiche, la direction, la conformité (R16, R17) |
| GET | `/v1/rendez-vous/jour` | les rendez-vous du jour de l'agent, heure de Paris, annulés exclus, dans l'ordre de leur heure, chacun avec son brief rangé ; prénom et brief seulement si l'agent voit encore la fiche, brief caché si la fiche a été fusionnée ou défusionnée depuis, ou si le bien n'est plus dans les droits de l'agent (`briefMissing` dit pourquoi) ; chaque fiche rendue et chaque refus sont écrits au journal | l'agent lui-même seulement (R16) |
| GET | `/v1/usage/matin` | l'usage du matin sur les 7 derniers jours, aujourd'hui compris, heure de Paris : un jour compte quand le plan figé a été ouvert avant midi ; pour l'agent, ses jours ; pour la direction, par jour le nombre d'agents, sans nom ni classement | l'agent lui-même, la direction (R14, R16) |
| POST | `/v1/registre/reglage` | `{ prefix, firstNumber, width }` : le format du registre des mandats du réseau, une seule fois, avant la première inscription (pendant la preuve, celui de l'agence, H23) | direction (R16, R39) |
| GET | `/v1/registre/reglage` | le format en vigueur (`prefix`, `firstNumber`, `width`, `setAt`) et le prochain numéro (`next`), ou `null` s'il n'est pas réglé | direction (R16, R39) |
| GET | `/v1/registre/lignes?avant=<rang>` | les mandats inscrits, 30 à la fois, les plus récents d'abord : numéro, date de signature, agent, commune, annulation s'il y en a une ; `next` donne le rang de la suite | direction (R16) |
| GET | `/v1/registre/controle` | le contrôle d'intégrité du registre : rangs sans trou, empreintes, liens, numéros, chaque ligne égale à son mandat et à son ancre au journal (rang et empreinte écrits à l'inscription), lignes effacées en fin de registre ; `brokenAt` et `problem` au premier écart | direction, conformité (R16, R39) |
| GET | `/v1/mandats/<id>/registre` | les lignes du registre d'un mandat : inscription avec son numéro, annulation s'il y en a une | l'agent du mandat, la direction, la conformité (R16) |
| GET | `/v1/modeles` | les modèles du réseau, toutes versions, avec texte, champs, empreinte et état « essai » ou « validé » | agent, direction, conformité (R40) |
| POST | `/v1/modeles` | `{ kind, body }` : une nouvelle version d'un modèle, à l'état « essai » ; champs `{{…}}` du catalogue seulement ; ligne `!! ` mise en évidence | direction (R16, R40) |
| POST | `/v1/modeles/<id>/validation` | le modèle passe « validé », avec qui l'a validé ; jamais par le code (H08) | conformité (R16, R40) |
| POST | `/v1/documents` | `{ kind, personId, propertyId, inputs?, mandateId? }` : un document généré depuis la dernière version du modèle ; `inputs` : `honoraires.montant` (euros entiers), `honoraires.charge` (`vendeur` ou `acquereur`), `mandat.duree_mois`, et pour un avenant (`kind` `avenant_mandat`, `mandateId` du mandat signé et numéroté) `avenant.prix` (euros entiers) et `avenant.duree_mois` ; un champ qui manque rend le document `incomplet` ; un modèle d'essai donne un document d'essai | qui voit la fiche et le bien en entier : agent, direction (R16, R40) |
| GET | `/v1/documents/<id>` | un document généré, figé, avec la version et l'empreinte de son modèle | qui voit la fiche en entier (R16) |
| POST | `/v1/partenaires/annuaire/<id>/preuves` | le fichier de la preuve d'un justificatif, en PDF, JPEG ou PNG, 10 Mo au plus, pour un partenaire du réseau : le serveur choisit la référence et la rend (`proofRef`), que `/justificatifs` reprend ; le journal garde l'empreinte seule ; sans stockage : 503 | direction, agent (R16, R73) |
| GET | `/v1/studio/guides-a-valider` | les guides photo prêts et pas encore validés du réseau, le plus ancien d'abord (`items`), et `next`, à repasser en `?apres=`, tant qu'il reste des biens à regarder | la direction (R16) |
| POST | `/v1/studio/bibliotheque/preuves` | le fichier de la preuve d'une licence, en PDF, JPEG ou PNG, 10 Mo au plus : le serveur choisit la référence et la rend (`proofRef`), que `POST /v1/studio/bibliotheque` reprend ; le journal garde l'empreinte seule ; sans stockage : 503 | direction (R16, R133) |
| GET | `/v1/gagner/engagements` | la dernière version de chaque engagement de service, actif ou non : code, texte, mesure, règle, délai, date | direction (R16, R141) |
| GET | `/v1/gagner/fiches/<id>/fin-de-bail` | les fins de bail notées sur la fiche, la dernière d'abord : c'est elle qui fait foi | l'agent de la fiche (R16, R17) |
| POST | `/v1/gagner/mesure/preuves` | le fichier de la preuve d'un coût, en PDF, JPEG ou PNG, 10 Mo au plus : le serveur choisit la référence et la rend (`proofRef`), que `POST /v1/gagner/mesure/couts` reprend ; le journal garde l'empreinte seule ; sans stockage `PIECES` : 503 | direction (R16, R144) |
| GET | `/v1/honoraires/bareme` | le barème en vigueur (`maxRatePercent`, `minEur`, `setAt`), ou `null` s'il n'est pas réglé | direction (R16, R41) |
| POST | `/v1/honoraires/bareme` | `{ maxRatePercent, minEur }` : le barème des honoraires du réseau (taux maximal du prix, au centième, et minimum en euros) ; en ajout seul, le dernier est en vigueur | direction (R16, R41) |
| POST | `/v1/fiches/<id>/identite` | `{ piece, seenAt }` : l'identité vérifiée (`carte_identite`, `passeport` ou `permis_conduire`, et quand) ; jamais de numéro ni de copie | l'agent de la fiche, la conformité (R15, R16, R41) |
| POST | `/v1/documents/<id>/controle` | le contrôle avant signature, ligne par ligne : champs, modèle validé, honoraires au barème et payeur, mandant égal au propriétaire, identité vérifiée depuis moins d'un an ; `passed` faux au moindre échec ; gardé | qui voit la fiche et le bien en entier (R16, R41) |
| POST | `/v1/documents/<id>/signature-papier` | `{ signedAt, place, scanRef, source?, sourceDetail? }` : un mandat signé sur papier (`agence`, `hors_agence` ou `distance` ; référence du scan rangé hors de la base) ; contrôlé à l'instant, rangé avec sa source, numéroté au registre, exemplaire du mandant produit ; une reprise continue là où elle s'était arrêtée | l'agent de la fiche, la direction (R16, R38, R39, R41) |
| GET | `/v1/documents/<id>/exemplaire` | l'exemplaire signé du mandant, mandat ou avenant, avec le numéro du mandat au registre, sa date et son lieu de signature | qui voit la fiche en entier (R16, R39) |
| GET | `/v1/biens/<id>/diffusion` | le bien peut-il être diffusé : `allowed`, `reason` (`no_mandate`, `cancelled`, `withdrawn`, `expired`, `duration_unknown`, `withdrawal_period`, `allowed`, `allowed_early_start`) et dernier jour du délai de rétractation | qui voit le bien en entier (R16, R42) |
| POST | `/v1/mandats/<id>/debut-anticipe` | `{ proof, receivedOn }` (le jour) ou `{ proof, receivedAt }` (l'instant) : la demande écrite du vendeur de diffuser avant la fin du délai de rétractation | l'agent de la fiche, la direction (R16, R42) |
| POST | `/v1/mandats/<id>/retractation` | `{ proof, sentOn }` : la rétractation envoyée dans le délai, `sentOn` étant le jour de l'envoi (`{ proof, receivedAt }` vaut pour une réception sans date d'envoi) ; le mandat s'arrête, son inscription au registre est annulée, la diffusion cesse. `{ resume: true }` finit une rétractation déjà notée dont l'annulation n'a pas abouti | l'agent de la fiche, la direction (R16, R42) |
| GET | `/v1/mandats/echeances` | les tâches d'échéance de l'agent : fin de mandat (renouvellement à proposer, 30 jours avant) et fin de la période de 3 mois d'un mandat exclusif (15 jours avant), rangées chaque jour à 6 h ; rien n'est envoyé | l'agent lui-même (R16) |
| POST | `/v1/mandats/<id>/annulation` | `{ reason }`, `error` ou `termination` : une ligne d'annulation au registre, rien n'est effacé ; le bien se rouvre à un nouveau mandat. Une rétractation passe par sa propre route, avec sa preuve | direction (R16, R39) |
| POST | `/v1/documents/<id>/signature-avenant` | `{ signedAt, place, scanRef }` : un avenant signé sur papier, contrôlé à l'instant (mêmes contrôles que le mandat, plus le mandat en vigueur), avec la référence rendue par `/v1/biens/<id>/scans-mandat` : scan du bien du mandat, présent au stockage, jamais déjà utilisé, sinon `bad_scan`, `scan_absent` ou `scan_deja_utilise` ; sans stockage, `depot_ferme` (503) ; le prix ou la durée du mandat changent alors | l'agent de la fiche, la direction (R16, R41) |
| GET | `/v1/mandats/<id>/conditions` | les conditions en vigueur d'un mandat (prix, durée) et l'historique de ses avenants signés | qui voit la fiche en entier (R16) |
| GET | `/v1/mandats/<id>/chronologie` | la chronologie d'un mandat : avis de valeur validé, document généré, premier contrôle réussi, signature enregistrée et numérotée ; durée de chaque étape et total, comparé à la cible de 10 minutes | direction, conformité (R16) |
| POST | `/v1/documents/<id>/signature-en-ligne` | `{ consentProof }` : ouvre une session de signature en ligne pour un document contrôlé, avec l'accord du signataire à recevoir son code et son exemplaire par mail ; code à usage unique de 6 chiffres, valable 10 minutes, seule son empreinte est gardée dans la session ; le mail passe par le contrôle central (heures, exclusions, accord) et reste dans la boîte d'essai tant que H05 n'est pas fait | l'agent de la fiche, la direction (R16, R41) |
| POST | `/v1/signatures/<id>` | `{ code, drawing? }` : la signature par le code, et le tracé à l'écran ; 5 codes faux bloquent la session ; un document modifié ne se signe pas ; toujours une signature d'essai (`realSignature: false`) tant que l'avocat n'a pas validé le dossier de preuve (H24) | l'agent de la fiche, la direction (R16) |
| GET | `/v1/signatures/<id>/exemplaire` | l'exemplaire d'une signature en ligne d'essai (document et preuve) et s'il est parti au signataire | qui voit la fiche en entier (R16) |
| POST | `/v1/signatures/<id>/exemplaire` | reprend l'envoi de l'exemplaire refusé plus tôt, par le contrôle central | qui voit la fiche en entier (R16) |
| GET | `/v1/apres-vente/journee` | « Ma journée » après la vente : clients à appeler pour remercier, proches recommandés à appeler, tâches ouvertes (lien de la fiche Google, demande d'avis non partie) | l'agent lui-même (R16) |
| GET | `/v1/apres-vente/dossiers` | l'écran « Après la vente » : chaque dossier clos, et pour chaque client le remerciement préparé (pour l'agent seul), la demande d'avis, les nouvelles aux dates clés et la note | l'agent de ses dossiers, la direction et la conformité du réseau (R16) |
| POST | `/v1/apres-vente/fiches/<id>/recommandations` | `{ firstName, email?, phone?, projectKind, callable, proof }` avec l'en-tête `Idempotency-Key` (16 à 64 caractères) : un client recommande un proche, rangé avec sa source ; la même clé ne range qu'une recommandation | l'agent du client, la direction (R16, R66) |
| GET | `/v1/apres-vente/fiches/<id>/recommandations` | qui a recommandé qui, pour cette fiche | qui voit la fiche en entier (R16) |
| GET, POST | `/v1/apres-vente/appels`, `/v1/apres-vente/appels/<id>/fait` | les proches recommandés à appeler ; « appel fait » | l'agent qui a la tâche (R16) |
| POST | `/v1/apres-vente/dossiers/<dossier>/clients/<id>/relances` | `{ choice: oui \| un_an \| non, proof }` : le choix du client sur les nouvelles après la vente | l'agent du dossier (R16, R65) |
| GET | `/v1/apres-vente/relances` | les nouvelles après la vente et leur issue | l'agent de ses dossiers, direction, conformité (R16) |
| POST | `/v1/apres-vente/lien-avis` | `{ url, agentId? }` : le lien de la fiche Google de l'agent, que portent les demandes d'avis | l'agent lui-même, la direction pour un agent du réseau (R16) |
| GET | `/v1/apres-vente/demandes-avis`, `/v1/apres-vente/taches`, `/v1/apres-vente/satisfaction` | les demandes d'avis, les tâches ouvertes, les notes reçues | l'agent de ses dossiers, la direction (et la conformité pour les demandes et les notes) (R16) |
| GET | `/v1/apres-vente/remerciements?ouverts=1` | les remerciements préparés | l'agent de ses dossiers (R16) |
| POST | `/v1/apres-vente/dossiers/<dossier>/clients/<id>/remerciement`, `…/appele` | `{ decision: send \| decline }` : rien ne part sans la validation de l'agent, puis par le contrôle central en mode essai ; « appelé » | l'agent du dossier (R16) |
| GET | `/v1/plan-du-jour/controle` | les écarts du contrôle quotidien de la base légale des plans du jour sur 30 jours, non encore vus : des nombres par raison et par jour, jamais une fiche | direction, conformité (R16, R36) |
| GET | `/v1/attribution/regles` | les règles d'attribution des contacts, les délais de rappel et les communes : les mêmes pour tous [R25] | toute clé |
| GET | `/v1/journal/verification` | la chaîne d'empreintes du journal est-elle intacte | direction, conformité |
| GET, POST | `/v1/meta/notifications` | vérification de l'abonnement, puis notifications signées d'Instagram, Facebook et WhatsApp ; réponse prête en mode essai, jamais envoyée | Meta, par signature (`META_APP_SECRET`) |
| POST | `/v1/captation/formulaire` | dépose un formulaire « Être rappelé » ; rend seulement des statuts, la réponse est prête en mode essai, jamais envoyée | clé de dépôt `site_form` (`INTAKE_KEYS`) |
| POST | `/v1/assistant/sessions` | ouvre une conversation de l'assistant du site, rend son jeton `sessionId` | clé de dépôt `site_chat` (`INTAKE_KEYS`) |
| POST | `/v1/assistant/sessions/<sessionId>/messages` | un message du visiteur ; rend un statut, la réponse est prête en mode essai, jamais rendue | clé de dépôt `site_chat` (`INTAKE_KEYS`) |
| POST | `/v1/automatisations/envoi` | une automatisation du site demande si son envoi peut partir ; rend la décision, sa règle, le palier, si la décision vaut pour cet envoi et si la mention de l'assistant manque au texte (`mentionMissing`) ; le texte est rangé tel quel ; rien n'est envoyé | clé de dépôt `site_auto` (`INTAKE_KEYS`) |
| POST | `/v1/automatisations/incident` | le site signale un écart non expliqué ou une panne : l'automatisation revient en ombre | clé de dépôt `site_auto` (`INTAKE_KEYS`) |
| GET | `/v1/automatisations/paliers` | le palier de chaque automatisation : des nombres et des dates | direction, conformité (R16, R26) |
| POST | `/v1/automatisations/paliers/{automation}/avancer` | de l'ombre à 10 %, refusé si l'ombre n'a pas tenu | direction (R16, R26) |
| GET | `/v1/captation/paliers` | le palier de chaque canal de captation et s'il est vraiment branché : des nombres et des dates | direction, conformité (R16, R26) |
| POST | `/v1/captation/paliers/{canal}/avancer` | de l'essai à 10 %, refusé si le passage est fermé, si le canal n'est pas branché ou si l'essai n'a pas tenu | direction (R16, R26) |
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

Une clé d'agent peut porter `"scope": "mcp"` (agent seulement ; une autre portée, ou sur un autre rôle, ferme l'API) : c'est la clé que l'agent confie à son assistant. Elle n'ouvre que `POST /v1/mcp`, et `POST /v1/mcp` n'accepte qu'elle ; sur toute autre route, 403 `cle_mcp_hors_mcp`, au journal (BR08).

## Captation, en mode essai (C06)

- **Formulaire du site** : `POST /v1/captation/formulaire`, corps `{"submissionId", "firstName", "email", "phone", "message", "page", "propertyRef", "submittedAt", "link", "landingPage"}`. `link` (l'adresse https d'arrivée, avec son code porteur `?o=`) et `landingPage` (l'adresse https de la page où le formulaire a été rempli), facultatifs, servent seulement à lire l'origine du contact (M01) : ils ne sont jamais rangés [R156]. Clé de dépôt dans le secret `INTAKE_KEYS`, qui ne lit rien : `[{ "sha256": "<empreinte>", "networkId": "<id du réseau>", "source": "site_form" }]`.
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
- **Écrire** : `POST /v1/assistant/sessions/<sessionId>/messages`, corps `{"visitorId", "messageId", "text", "page", "propertyRef", "link", "landingPage"}` (`link` et `landingPage` comme pour le formulaire, lus pour l'origine du contact et jamais rangés [R156]) ; `text` de 1 à 2 000 caractères, `messageId` unique dans la session (le même message reçu deux fois ne donne qu'une réponse [R18]). Rend `{"ok": true, "mode": "essai", "sent": false, "status": "ready" | "with_agent" | "none", "reply": null}`. Une session d'un autre visiteur ou d'un autre réseau : 404.
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
- **Paliers (B04a) [R26].** La réponse porte aussi `stage` (`shadow`, `ten_percent`, `everywhere`) et `decides`. Quand `decides` est faux, le site décide seul, comme avant ; quand il est vrai, il suit la décision du socle. Sans réponse du socle, le site décide seul. `decides` est toujours faux en ombre, pour une adresse inconnue du socle, et après une panne ; pour une adresse portée par plusieurs fiches, il suit le palier, et le refus vaut alors. Le tirage des 10 % est fixe : il ne dépend que de l'automatisation et de `ref`.
- Passage de l'ombre à 10 % : geste de la direction (`POST /v1/automatisations/paliers/{automation}/avancer`), refusé tant que le passage est fermé (`not_open`, le cas tant que B04 ne l'a pas ouvert), avant 7 jours (`too_early`) ou sous 20 demandes comptées (`not_enough_requests`). De 10 % à partout : de lui-même, après 7 jours et 5 décisions prises par le socle. Ne comptent ni une demande refaite pour le même envoi (R05), ni une adresse sans fiche unique, ni à 10 % un envoi où le socle ne décide pas.
- Retour en ombre, de lui-même : à une panne du socle, ou quand le site appelle `POST /v1/automatisations/incident` avec `{"automation": "...", "kind": "unexplained_gap" | "failure", "rule": "R05"}` (`rule` facultatif, aucun autre champ admis). Le compte des 7 jours repart. Cette route ne peut que faire descendre.
- **Paliers des canaux de captation (C09e) [R26].** Mêmes durées et mêmes seuils que ci-dessus, `shadow` voulant dire « essai ». Refus de `POST /v1/captation/paliers/{canal}/avancer` : `not_open` (passage fermé, le cas tant que C09 ne l'ouvre pas), `no_real_channel` (passage ouvert, canal sans vrai branchement), `too_early`, `not_enough_requests`, `not_in_shadow`. Sans vrai canal, rien ne part, à aucun palier. Le Worker ne remplit pas encore `captationRollout` : C09 devra y dire les mêmes canaux que `realChannels`.
- Le socle n'envoie jamais rien, à aucun palier : les canaux restent ceux du mode essai. Tant que le site n'est pas passé à la version qui lit `decides` (B04), les paliers ne changent rien à ses envois.

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

## Dossiers de vente, en mode essai (N09)

- `GET /v1/offres/a-tenir` (W26) : l'accueil de l'agent, pour lui seul, sur les biens qu'il suit encore : messages sur l'argent d'un dossier en cours, regroupés sans leur texte, alertes de financement, échéances des offres et des dossiers (R16, R59, R61, R62). Ouverte sans le stockage des pièces.
- Les routes `/v1/dossiers/…` de M10 (pièces, échéancier, financement, acte, chemin critique, relances, tâches, alertes) sont servies derrière la clé d'API, sous les droits de la couche métier [R16]. Elles ont besoin du stockage des pièces, le compartiment R2 lié sous le nom `PIECES` ; sans lui, chacune répond 503 `pieces_not_configured`, et le passage des dossiers ne tourne pas.
- `POST /v1/dossiers/<id>/preuves` (N13) : l'agent du bien dépose la preuve d'une date ou de l'acte, comme une pièce par `…/fichiers` (PDF, JPEG, PNG, 20 Mo, empreinte `x-aimmo-sha256`) ; la référence rendue se passe à `…/dates` ou `…/acte`, qui refusent une référence absente du stockage (`not_stored`). Un dossier clos refuse dépôt, date et étape du prêt (`closed`).
- Au planificateur, `dossiers.passage`, de 9 h à 19 h chaque jour : échéances, alertes de financement, filet du bouclier contre le faux RIB, relances des pièces par le contrôle central (pas le dimanche).
- Chaque message reçu est rangé sans IBAN en clair, remplacé par `[IBAN masqué]` [R15] ; dès qu'il est rattaché à sa fiche, le bouclier le lit et alerte l'agent d'un dossier en cours [R62]. Le contrôle central refuse tout texte à un client qui porte un IBAN, un RIB ou demande de payer [R62].


- Les pages publiques, sans clé, n'ont qu'un jeton tiré au hasard dans l'adresse : `/apres-vente/desinscription/<jeton>` (désinscription des nouvelles après la vente en un geste, R65), `/apres-vente/avis/<jeton>` (note de 1 à 5 et commentaire, une seule fois, jamais publiés, R64), `/apres-vente/carnet/<jeton>` (le carnet du propriétaire, F06). Elles sont fermées hors mode essai.
- Leur adresse vient de la variable `APRES_VENTE_BASE`, en https, sans chiffre, terminée par `/apres-vente/` (par exemple `https://aimmo-api.<compte>.workers.dev/apres-vente/` si le nom du compte n'a pas de chiffre). Sans elle, aucune nouvelle après la vente ne part [R65], les demandes d'avis partent sans lien de satisfaction, et aucun carnet ne se fait.
- Au planificateur, du lundi au samedi de 10 h à 18 h : demandes d'avis le lendemain de l'acte (`apres_vente.demandes_avis`), tâches « remercier » et messages validés (`apres_vente.remerciements`), nouvelles aux anniversaires de l'acte avec le carnet (`apres_vente.relances`). Les dossiers clos sont ceux de M10 (acte signé). La valeur du carnet est calculée autour du centre de la commune (Base adresse nationale), jamais d'une adresse ; sans `DVF_BASE_URL`, aucun carnet.

## Commerces, en mode essai (CE14)

- `GET /v1/commerces/engagements/modeles` : la direction lit le modèle d'engagement en vigueur (`null` si aucun) ; `POST` sur la même adresse ajoute une version, celles d'avant restent [R17].
- `GET /v1/commerces/engagements/<id>` : l'agent du bien ou la direction lit le texte à faire lire avant le code (modèle, bien, signataire ; aucun chiffre), s'il est signé et s'il est révoqué [R110, R16].
- `POST /v1/commerces/<id>/documents/texte` (CE20) : `{ kind, title, content }`, l'agent du bien ou la direction dépose le texte d'un document du dossier protégé ; le serveur choisit la référence ; le même texte déjà rangé rend sa ligne avec `already: true`, et son contenu perdu est réécrit (`repaired: true`) ; `400 stockage_absent` tant que le compartiment R2 `COMMERCES`, à part de tout autre, n'est pas lié au Worker (H38, CE22). `GET /v1/commerces/<id>/documents` les liste, sans contenu ni référence, avec `available` : le lecteur le recevrait-il.
- `GET /v1/commerces/<id>/demandes` rend aussi, pour chaque repreneur, `ndaId` (l'engagement en vigueur, `null` si le dernier est révoqué ou si aucun modèle n'était rangé) et `signed`.

- `POST /v1/commerces/<id>/informations` (CE16) : `{ personId, consentProof }`, l'agent du bien ou la direction fait partir la présentation validée à qui a une demande rangée, par le contrôle central, une seule fois [R05, R26]. Refus : `pas_de_demande`, `non_diffusable` [R42], `presentation_absente` [R110], `consent_withdrawn` [R03], `send_refused`.
- `POST /v1/location/candidatures/<id>/fichiers/piece` (W18) : l'agent du bien ou la direction dépose une pièce d'une candidature (PDF, JPEG ou PNG, 20 Mo au plus, avec `x-aimmo-sha256`) ; le serveur rend la référence que `POST /v1/location/candidatures/<id>/pieces` attend, et ce geste contrôle sa sorte [R104, R16]. Le titulaire est obligatoire, `?holder=candidat` ou `?holder=<id du garant>` (W19) : chaque fichier a sa ligne `rental_piece_deposits`, écrite avant lui, sur la carte de la personne pour qui il est déposé, joint ou non [R95, R97] ; le geste refuse de le ranger au nom d'un autre titulaire (`holder_mismatch`).
- `GET /v1/location/modeles-bail` (W17) : la direction et la conformité lisent, pour chaque sorte de bail, le modèle que le prochain bail prendrait (`current` : le dernier validé, sinon la dernière version, d'essai) et la dernière version rangée (`latest`) [R16].
- `GET /v1/location/<id>/remise-des-cles` (W16) : l'agent du bien, la direction ou la conformité en lecture lit la signature réelle du bail (jamais celle d'essai) [R108], l'état des lieux, le récapitulatif rangé, les gestions confiées, et pour qui peut agir les mises en relation qui peuvent porter la gestion, avec `available` si le gestionnaire est proposable ce jour [R73]. La lecture va au journal [R16].
- `GET /v1/commerces/repreneurs` (CE15) : l'agent ou la direction lit les projets de reprise qu'il a le droit de voir, dans l'ordre d'arrivée, sans note ni tri [R14] : le prénom, le jour, et `writable` s'il peut compléter le profil.

## Pilotage, en mode essai (K08)

Sous `/v1/pilotage`, chaque route passe par les droits de la couche métier [R16] et écrit chaque refus au journal. Un agent ne lit que ses chiffres, ses commissions et ses reversements [R68] ; la direction lit le réseau ; la conformité n'a pas les chiffres. Aucune route ne reçoit un montant : un corps qui en porte un est refusé (`amount_refused`, R67).

- `GET /mes-chiffres?du=AAAA-MM-JJ&au=AAAA-MM-JJ` (`&agent=<id>` pour la direction) : contacts, rendez-vous tenus, mandats, ventes, honoraires à venir, chacun avec ses lignes.
- `GET /reseau?du=&au=` : le tableau de bord du réseau (direction). `GET /rapport-matin?jour=` : le rapport du matin du lecteur. `GET /alertes`, `POST /reglages` : alertes et seuils de la direction.
- `GET /commissions`, `POST /grille` : commissions et grille datée des parts. `GET /factures`, `GET /factures/brouillons`, `POST /factures/brouillons/<id>/valider`, `POST /factures/<id>/avoir`, `GET /factures/export?du=&au=` (CSV) : factures d'essai, jamais réelles tant que H26 n'est pas fait.
- `POST /dossiers/<id>/encaissement`, `POST /dossiers/<id>/reversement`, `GET /reversements` : encaissement et reversement sous 24 h ouvrées, avec leur preuve.
- `GET /export-quotidien?jour=` (CSV) : l'export du jour pour la mesure contre le comptage manuel (`docs/MESURE.md`).
- `GET /engagements-tenus?mois=AAAA-MM` : pour un mois fini et la direction seule, chaque engagement de service : cas tenus, manqués (leurs jours), en attente, en essai, écartés, s'il est mesurable, et le total ; aucun agent, aucun identifiant ; mois en cours : 409 [R216, R14].
- `GET|POST /temps-gagne` (`?semaine=<lundi>`, ou `{week, minutes}`) : l'agent lit et déclare les minutes gagnées d'une semaine finie, et lit ses gestes au journal. `GET /temps-gagne/reseau?semaine=` : la direction lit des comptes, sans nom [R217, R14, R68].
- `GET /engagements-manques`, `POST /engagements-manques/<id>/fait` (`{outcome: rappele | injoignable | sans_appel}`) : la direction seule lit les engagements manqués à rappeler (la fiche du client, ou le nom de l'agent pour un engagement envers lui) et dit ce qui a été fait ; la machine n'envoie rien au client ; une personne exclue se dit « ne pas appeler » et ne se note jamais « rappelée » [R228, R02].
- `GET /disponibilite?mois=AAAA-MM` : pour un mois fini et la direction seule, la part du temps où le site, l'API et l'application ont répondu, la cible de 99,9 %, et si le mois a été observé en entier ; sans supervision branchée (H48), chaque service dit « non mesuré », jamais 100 % ; mois en cours : 409 [R223].
- `GET /copies` : pour la direction seule, l'état de la copie de nuit de la base : `a_jour`, `en_retard` ou `jamais`, la date de la dernière copie réussie, le dernier échec et sa raison, les dernières nuits sans copie ; ni lignes ni tables ; jamais « à jour » sans une copie réussie (SV02).
- `GET /copies/restauration` : pour la direction seule, le test de restauration de chaque mois : `reussi`, `echec` ou `manquant`, le mois attendu et le dernier reçu (date de la copie, durée, tables, lignes, empreinte de toute la base, ou raison de l'échec) ; jamais vert sans reçu du mois (SV03).

Au planificateur : chaque heure, `pilotage.passage` (commissions, brouillons de factures, reprise des transmissions, alertes de reversement ; à 7 h de Paris, les engagements manqués du mois en cours et du mois passé) ; à 6 h, `pilotage.alertes`, avec les fins de validité des pièces du dossier d'agent (M14) ; du lundi au vendredi à 7 h 30, `pilotage.rapport_matin`, rangé et lu dans l'application, jamais envoyé.

## Réseau et académie, en mode essai (J12)

Sous `/v1/reseau`, chaque route passe par les droits de la couche métier [R16] et écrit chaque refus au journal. Un corps porte seulement les clés de sa route : une clé de plus est refusée (`invalid_body`), sans rien ranger. Rien n'est envoyé : les réponses aux candidats restent dans la boîte d'essai.

Branchement dans le socle (J13) :

- Avant toute route, la clé d'un agent est contrôlée : un agent parti (dès minuit, heure de Paris, le jour de son départ, même avant le planificateur), ou qui n'est pas un agent en activité de son réseau, reçoit 403 `agent_inactive` (R16) sur toutes les routes, `/v1/moi` compris [R86]. Un agent dont le dossier d'agent n'est pas complet et valide ce jour-là reçoit 403 `agent_file_incomplete` (R82) sur toute route hors de son intégration : `/moi`, son dossier et ses pièces, l'académie et sa formation, le bac à sable, l'entraînement, l'assistance, ses primes [R82]. Chaque refus est écrit au journal. Décidé : un agent sans aucun dossier, créé hors de M14 (les agents de l'agence, sous sa carte), garde ses droits ; dès qu'un agent entre par M14 ou qu'une pièce de son dossier est rangée, la règle vaut pour lui.
- Le contrôle central des envois refuse (R86) tout envoi dont l'agent, ou celui qui l'a préparé (`preparedBy`), est parti.
- Le planificateur passe chaque heure les départs du jour et les alertes de l'assistance, et à 6 h les échéances des pièces du dossier d'agent et du compteur de formation ; les alertes sont rangées pour les écrans, jamais envoyées.
- Les pièces des dossiers d'agent sont rangées dans le compartiment R2 `PIECES`, sous `agents/<agent>/` ; sans lui, leurs routes répondent 503. L'entraînement rend les répliques écrites tant qu'aucune IA n'est branchée (H13) ; le bac à sable reste fermé (503).

- Candidatures (direction) : `GET /candidatures`, dans l'ordre d'arrivée, sans note ni tri [R81] ; `GET|POST /candidatures/<id>/entretien` (fiche, puis `at`, `interviewer`) ; `POST /entretiens/<id>/tenu` (`heldByName`) ; `POST /candidatures/<id>/decision` (`decision`, `reason`, `deciderName`) ; `POST /candidatures/<id>/admettre` (`zone`) ; `GET /candidatures/<id>/reponses` ; `GET|POST /reponses` (`topic`, `body`, contrôlé par R80) ; `GET /questions`, `POST /questions/<id>/faite`.
- Dossier d'agent [R82] : `GET /mon-dossier` ; `GET /agents/<id>/dossier` ; `POST /agents/<id>/pieces` (`kind`, `ref`, `issuedOn`, `validUntil`) ; `POST /agents/<id>/projets` (`kind`). Sans stockage des pièces passé aux routes, réponse 503.
- Import [R84] : `POST /import` (`format`, `contacts`, `properties` en texte, 2 Mo au plus), pour l'agent qui appelle, jamais un autre ; `GET /import/a-reprendre` (direction).
- Académie [R85] : `GET /academie` ; `POST /academie/modules`, `POST /academie/seances`, `POST /academie/seances/<id>/presence` (direction) ; `POST /academie/modules/<id>/fait` ; `GET /ma-formation`, `GET /agents/<id>/formation` ; `GET /agents/<id>/bac-a-sable` (503 sans son stockage à part).
- Entraînement : `GET /entrainement/cas`, `POST /entrainement` (`caseKey`), `POST /entrainement/<id>/tour` (`text`), `POST /entrainement/<id>/fin`.
- Accompagnement : `POST /agents/<id>/referent`, `POST /binomes`, `POST /agents/<id>/absence`, `GET /agents/<id>/dossiers-couverts`, `POST /assistance`, `POST /assistance/<id>/repondue`.
- Parrainage [R83] : `POST /parrainage/regles` (`rateBp`, `levels`), `POST /agents/<id>/parrain`, `GET /mes-primes`, `GET /agents/<id>/primes`.
- Départ [R86] : `GET|POST /agents/<id>/depart`, `POST /agents/<id>/depart/annuler`, `POST /agents/<id>/successeur`, `POST /agents/<id>/successeur/decision`, `GET /agents/<id>/solde`, `GET /agents/<id>/contenus`, `GET|POST /reprises`.

La page publique de candidature est servie à `/rejoindre`, sans clé ni script (`packages/api/src/candidature.ts`). Elle reçoit le réseau par la variable du Worker `CANDIDATURE_NETWORK_ID` ; elle n'est servie qu'en mode essai ; sans lui, elle dit que les candidatures ne sont pas ouvertes. Chacun de ses textes passe le contrôle des promesses de revenus à chaque service : un texte qui échoue ferme la page (503, `candidature.page_fermee` au journal) [R80]. Le lien d'un parrain est `/rejoindre?parrain=<identifiant de l'agent>`.

## Reprise des contacts (I05)

- `POST /v1/reprise/fichiers` : la direction seule [R16] dépose un des trois exports de H15, en JSON `{ "tool": "exclusion_list" | "gohighlevel" | "manychat", "csv": "<texte>" }` (20 Mo au plus ; `agentId` facultatif, par défaut la fiche d'agent de la personne qui dépose). Un fichier que la reprise ne saurait pas lire est refusé (`unreadable_file`), rien n'est rangé. Le texte est rangé dans la base `aimmo` (`reprise_depots`, `reprise_depot_morceaux`), en ajout seul ; la réponse et le journal ne portent que des nombres [R13].
- `GET /v1/reprise/etat` : la direction seule ; le dernier dépôt de chaque sorte (lignes, date) et l'avancement du lancement.
- Le lancement n'est pas une route : c'est le travail GitHub « Reprise des contacts » (`.github/workflows/reprise.yml`), lancé à la main depuis main, qui passe par l'API REST de D1 (voir `docs/REPRISE.md`).

## Espaces des clients, en mode essai (EC07)

- `POST /v1/espaces/personnes/<id>/ouvrir` : l'agent du client ou la direction [R16] ouvre l'espace d'une personne partie à un dossier, avec `{ "consentProof": "<preuve de son accord>" }` ; le lien personnel part par le contrôle central, en mode essai seulement [R160, R26]. L'agent le fait depuis la fiche (EC12), sans jamais voir le lien. Au-delà de 3 liens par 24 heures pour la personne, demandes du client comprises : `409`, `{ "rule": "R160", "code": "plafond" }`, rien n'est préparé (EC13).
- Pages du client sous `/espace/`, sans clé d'API : la séance est un cookie `__Host-` donné à l'ouverture du lien, à côté des clés ; la vérification d'un relevé (`/espace/verifier`) est ouverte à tous et ne dit que « intact, fait le … » ou « modifié » [R164].
- Variables du Worker : `ESPACE_NETWORK_ID` (le réseau des espaces) et `ESPACE_BASE` (l'adresse publique du Worker suivie de `/espace/`, en https, sans chiffre). Sans elles, l'espace et la route de l'agent répondent 503 `espace_not_configured`.
- Secret `ESPACE_RELEVE_KEYS` : `nom:secret`, séparés par des virgules ; le nom en minuscules et tirets, le secret de 32 caractères ou plus, tiré au hasard et gardé dans un coffre, jamais dans le dépôt. La première clé signe, les suivantes vérifient seulement (rotation). Absent ou mal formé : le relevé répond « indisponible », l'espace reste lisible.

## Réclamations et gel des avoirs, en mode essai (BR01)

Sous `/v1/securite`, chaque route passe par les droits de la couche métier [R16] et écrit chaque refus au journal. Rien n'est envoyé : la proposition du médiateur passe par le contrôle central et les seuls canaux du mode essai, elle reste « à remettre » par l'agent [R26, R607].

- `GET /reclamations` : la direction lit celles du réseau, l'agent celles des fiches qu'il suit, l'échéance la plus proche d'abord, avec leurs alertes et le médiateur.
- `POST /reclamations/reglage` (`{responseDays, mediatorName, mediatorSite}`) : la direction règle le délai de réponse (1 à 60 jours) et le médiateur, par une nouvelle version [R607].
- `POST /fiches/<id>/reclamations` (`{receivedOn: AAAA-MM-JJ, receivedBy: mail | courrier | message | oral, summary, reply?: {channel, conversationId}}`) : l'agent qui suit la fiche, ou la direction, range une réclamation ; l'échéance est écrite par la base et ne change plus [R606].
- `POST /reclamations/<id>/reponse` (`{outcome: reglee | non_reglee, note}`) : la réponse, une fois. `POST /reclamations/<id>/mediateur-remis` : la proposition du médiateur remise au client.
- `POST /gel/registre` (`{publishedAt, entries: [{entryId, nature, names}]}`, 4 Mo au plus) : le responsable de la conformité importe une version du registre, scellée, et chaque dossier ouvert est revérifié [R603, R604].
- `POST /gel/controle` (`{caseRef: mandate:<id> | offer:<id> | sale_file:<id>}`) : l'agent du client ou le responsable demande le contrôle d'un dossier ; la réponse est toujours `controle_fait`, jamais le résultat [R605].
- `GET /gel/controles?dossier=<caseRef>`, `GET /gel/sans-nom`, `GET /gel/correspondances`, `GET /gel/correspondances/<id>/fige`, `POST /gel/correspondances/<id>/decision` (`{decision: fausse_correspondance | correspondance_confirmee, reason, validatorName}`) : le responsable seul lit les résultats et juge chaque correspondance, une fois [R605].

Au planificateur, inchangé : `securite.reclamations` de 9 h à 19 h, `securite.gel_avoirs` chaque heure.

## Recrutement des 100 premiers agents, en mode essai (BR02)

Sous `/v1/recrutement`, la direction seule : chaque route passe par les droits de la couche métier [R16] et écrit chaque refus au journal. Rien n'est envoyé.

- `GET /contenus` : chaque vidéo et chaque épisode du podcast, avec son lien marqué (`/rejoindre?c=<code>`) et son chemin en nombres seulement : candidatures, entretiens tenus, « oui », entrées, restés à 90 jours, mandats dans les 90 jours [R622].
- `POST /contenus` (`{kind: video | podcast, title, url, description?, publishedOn}`) : range un contenu ; titre et description passent le contrôle des promesses de revenus, une vidéo est sur YouTube seulement [R80, R620]. `POST /contenus/<id>/retrait` : retiré, jamais effacé.
- La page de candidature reprend le code du lien marqué dans son formulaire ; la candidature est rattachée au contenu, un code inconnu ou retiré est ignoré et la réponse au candidat reste la même [R621].
- `POST /cout-agent/factures/<id>/poste` (`{category: ia | clients_apportes | diffusion | accompagnement | conformite | hors_agents}`) : le poste d'une facture fournisseur, par une nouvelle version [R623]. `POST /cout-agent/reglages` (`{validFrom: AAAA-MM, provisionBp, marginBp, reason}`) : provision et marge, par versions datées.
- `GET /cout-agent?mois=AAAA-MM` : pour un mois fini de Paris, la part du réseau, le coût complet par poste, la provision, la marge, l'agent moyen, si la part couvre le coût et le seuil qui le couvre tout juste ; un mois incomplet n'est jamais dit couvert ; mois en cours : 409 [R623, R624, R625]. Aucun montant n'entre par ces routes (`amount_refused`).

## Marketing, en mode essai (BR03)

Sous `/v1/marketing` : chaque route dit les rôles qu'elle admet, contrôlés avant le corps ; un refus est écrit au journal [R16]. Rien ne part ni ne se paie : la porte de publication donnée au calendrier refuse tout, la lettre n'a pas de lien de désinscription donc ne part pas, et les plateformes publicitaires sont celles du mode essai [R26, R582, R584, R587]. Un champ non prévu : 400 `unknown_field`.

- L'agent, pour son propre calendrier (HX52) : `GET /calendrier/reglages` ; `POST /calendrier/reglages` (`{perDay: {instagram, facebook, linkedin, google, tiktok, youtube}, hours: ["HH:MM", …]}`), une version nouvelle valable le lendemain [R581] ; `POST /calendrier/semaine` (`{from: AAAA-MM-JJ}`) réserve les créneaux en rotation stricte, seulement avec une publication prête et son lien marqué [R580, R582] ; `GET /calendrier/creneaux?du=AAAA-MM-JJ&au=AAAA-MM-JJ`.
- La direction (HX53) : `POST /lettre/editions` (`{title}`, lettres seules) [R586]. L'agent ou la direction : `GET /magazine`, la page imprimable des biens diffusables et des prix publiés, chaque prix lu dans la base [R585].
- La publicité payante (HX54) : `POST /publicite/campagnes` (`{platform: google_ads | meta, name, targeting: {communes: [INSEE], rayonKm?}}`), l'agent ou la direction ; un critère interdit est nommé dans `detail` [R589]. La direction seule : `POST /publicite/campagnes/<id>/validation` (`{dailyBudgetCents, totalBudgetCents, maxCostPerContactCents}`), `POST …/lancement`, `POST …/arret`, `GET /publicite/campagnes` (dépense, contacts, mandats, ventes et leurs coûts) [R587, R588].

Restent hors des routes, à des travaux planifiés : le passage des créneaux dus (`runDue`), l'envoi d'une édition avec sa page de désinscription, la lecture de la dépense et des contacts chez les plateformes et le contrôle du seuil (`recordSpend`, `recordContact`, `runChecks`).

## Finances du réseau, en mode essai (BR04)

Sous `/v1/finances` : chaque route dit les rôles qu'elle admet, contrôlés avant le corps ; un refus est écrit au journal [R16]. Aucun montant n'entre par une route, sauf la correction nommée d'une facture fournisseur, recomptée par le code et la base [R550] ; un champ non prévu : 400 `unknown_field`. Rien ne part.

- La direction, factures fournisseurs (HX49) : `POST /fournisseurs/lectures` (`{documentRef}`) fait lire la facture par le lecteur (l'IA, H13 ; sans lecteur configuré, 503 `lecteur_absent`), la recompte et rend ses écarts ; `POST /fournisseurs/lectures/<id>/rangement` (corps : les corrections nommées, `supplier`, `number`, `issuedOn`, `vatLines`, `htCents`, `vatCents`, `ttcCents`, ou `{}`) la range si elle se recompte ; `GET /fournisseurs` [R550].
- La direction, banque : `POST /banque/releve` (corps `text/csv`, 1 Mo au plus), sans libellé ni coordonnée bancaire gardés, le même relevé deux fois ne double rien ; `GET /banque/propositions` ; `POST /banque/lignes/<id>/rapprochement` (`{invoiceId}`), une ligne pour une facture au même montant ; `GET /banque/rapprochements` ; `POST /banque/factures/<id>/encaissement`, la ligne de banque pour preuve [R551, R552].
- La direction, relances : `GET /relances`, `POST /relances/<id>/validation`, une fois, texte inchangé [R553].
- L'agent ou la direction, rapports sur mesure (HX62) : `POST /rapports/lecture` (`{definition: {measures, grouping}, from, to, agentId?, network?}`), `POST /rapports` (`{name, definition}`), `GET /rapports`, `POST /rapports/<id>/lecture` (`{from, to, agentId?, network?}`) ; un agent ses chiffres, la direction un agent ou le total, jamais deux agents côte à côte, chaque chiffre avec ses lignes [R560, R14].

Restent aux passages du planificateur : le rapprochement seul (`Rapprochements.run`), la préparation et l'envoi des relances (`RelancesImpayes.prepare`, `send`). L'export complet de l'agent exige une clé d'appareil [R601] : il vient avec les routes des clés (BR05).

## Clés d'appareil, second facteur et export de l'agent (BR05)

Sous `/v1/cles` et `/v1/export` : chaque route dit les rôles qu'elle admet (agent, direction, conformité ; la direction seule pour la liste et l'accord ; l'agent seul pour son export), contrôlés avant le corps ; un refus est écrit au journal [R16]. Sans site WebAuthn réglé, les routes répondent 503 `cles_non_configurees` : variables du Worker `CLES_RP_ID` (le domaine de l'application, sans schéma) et `CLES_ORIGINS` (les origines en https, séparées par des virgules), lues sans rien deviner (H64). Un champ non prévu : 400 `unknown_field`.

- `POST /cles/enregistrement/debut`, puis `POST /cles/enregistrement/fin` (`{challengeId, credentialId, publicKey, clientDataJSON, authenticatorData, label, stepUpId?}`, en base64url) : la première clé est active, les suivantes attendent la direction ou une preuve « ajouter_appareil » [R600].
- `GET /cles/appareils` (direction) : les clés du réseau, sans clé publique ni identifiant de clé. `POST /cles/appareils/<id>/accord` (`{stepUpId}`) : la direction accepte une clé sur la preuve « approuver_appareil » de sa propre clé pour `device:<id>`. `POST /cles/appareils/<id>/retrait` : d'un geste, chacun les siennes, la direction toute clé du réseau [R600, R601].
- `POST /cles/preuve/debut` (`{action, subject}`), puis `POST /cles/preuve/fin` (`{challengeId, credentialId, clientDataJSON, authenticatorData, signature}`) : une preuve pour cette action et cet objet seuls, cinq minutes, une fois [R601].
- `POST /export/agent` (`{stepUpId}`, preuve « export_complet » pour `agent:<lui>`) : l'agent actif tire l'export complet de ses données, avec son empreinte ; AIMMO ne range que l'empreinte. `POST /export/agent/verification` (`{document}`, 4 Mo au plus) : vrai si le fichier est celui qu'AIMMO a remis, au caractère près ; un fichier d'un autre réseau n'est pas lu [R561].

### Connexion par une clé d'appareil (BR06)

Deux routes publiques, sans clé d'API, fermées (503 `cles_non_configurees`) sans site WebAuthn réglé :

- `POST /v1/cles/connexion/debut` (`{networkId, role, userId}`, rôle `agent`, `direction` ou `compliance`) : un défi de cinq minutes, avec les seules clés actives de cet utilisateur [R600].
- `POST /v1/cles/connexion/fin` (`{challengeId, credentialId, clientDataJSON, authenticatorData, signature}`, en base64url) : `{token, expiresAt, viewer, deviceId}`, une séance de 12 heures. Le défi est usé dès la première tentative, même ratée ; seule l'empreinte du jeton est rangée. Le réseau de la séance est celui du défi, lu dans la base ; aucun réseau n'est accepté de l'appelant.

Tout refus (réseau, utilisateur, rôle, clé, défi, signature) a la même réponse, 403 `connexion_refusee`. La raison est au journal (`securite.refus`) dès qu'elle concerne quelqu'un d'un réseau existant ; un réseau ou un défi inconnus ne concernent personne et n'écrivent rien, pour qu'aucune boucle ne remplisse le journal. Limites par heure, l'adresse d'abord : 30 demandes par adresse (`cf-connecting-ip`, rangée en empreinte d'une heure seulement), puis 2000 défis émis par réseau (utilisateur actif avec une clé active : un utilisateur inventé ne compte pas ; plein, aucun défi n'est plus émis ni rangé) ; au-delà 429 `too_many_requests`. Pas de limite par utilisateur : n'importe qui pourrait la remplir au nom d'un agent et l'empêcher d'entrer, alors qu'un défi ne sert qu'une fois et ne se signe qu'avec la clé.

Le jeton s'envoie comme une clé : `Authorization: Bearer <jeton>`. L'API essaie d'abord les clés d'API, qui restent acceptées comme avant, puis la séance, relue dans la base à chaque demande : une clé retirée, une séance finie ou un agent parti la coupent à la demande suivante (401) [R600, R82]. Sans clé d'API configurée, l'API reste fermée (503), sauf si le site WebAuthn est réglé : seules les séances ouvrent alors.

## Quiz et attestations de formation (BR07)

Sous `/v1/formation`, chaque route dit les rôles qu'elle admet, contrôlés avant le corps ; un refus est écrit au journal [R16]. Un champ non prévu : 400 `unknown_field`. Rien n'est envoyé.

- `POST /formation/questions` (direction ; `{moduleId, ruleId?, prompt, choices, correctIndex}`) : une question liée à un module de l'académie du réseau et, si elle en cite une, à une règle en service ; sinon 409 `module_required` ou `rule_not_in_service` [R570]. `POST /formation/questions/<id>/retrait` (direction) : retirée, jamais effacée [R17].
- `POST /formation/quiz` (agent ; `{track}` ou `{moduleId}`, un seul) : `{attemptId, questions}`, sans la bonne réponse ; moins de trois questions en service : 409 `not_enough_questions` [R570].
- `POST /formation/quiz/<id>/reponses` (l'agent du quiz ; `{answers}`, un indice par question) : une fois ; chaque réponse est juste ou à revoir, avec son module, sa vidéo et sa règle ; `allRight`, les modules encore à faire, et l'attestation quand le quiz est sans faute sur des modules tous faits. Aucune note, aucun nombre de bonnes réponses [R570, R571, R14].
- `GET /formation/agents/<id>/attestations` (l'agent lui-même, ou la direction de son réseau) : ses attestations, document et empreinte [R571].

Le quiz, les réponses et les attestations restent ouverts à l'agent au dossier incomplet : c'est sa formation [R82].

Sans clé, la vérification publique d'une attestation : `POST /v1/formation/verification` (`{document, fingerprint}`, 32 ko au plus) et la page `/attestation` (formulaire : document et empreinte). Elles ne disent que « valide », avec le jour de délivrance, ou « non reconnue », sans raison ni nom ; un seul caractère changé, ou une empreinte recalculée par un faussaire, échoue. Rien de ce qui est collé n'est rangé [R571, R13].

## Serveur MCP (BR08)

Le serveur MCP de HX55, en JSON-RPC 2.0 (protocole `2025-06-18`), sur HTTP. Rien n'est envoyé, publié ni validé par lui.

- `POST /v1/mcp`, avec la clé de portée « mcp » de l'agent, et elle seule (une autre clé ou une séance : 403 `cle_mcp_requise`) : `initialize`, `ping`, `tools/list`, `tools/call`. L'agent seul : la direction, la conformité et les partenaires sont refusés avant le corps, 403 et refus au journal [R16, R590]. Le socle revérifie à chaque appel l'accès coupé, le départ et le dossier de l'agent (aucune route MCP n'est ouverte au dossier incomplet) [R82] ; la couche métier revérifie ses droits sur chaque bien et chaque fiche et écrit chaque appel et chaque refus au journal avant de rendre la moindre donnée. Aucune donnée de client ne sort : une fiche ne se désigne que par son identifiant [R590]. Une notification (sans `id`) : 202, corps vide ; un corps illisible : 400, erreur `-32700`. 16 ko au plus.
- `GET /v1/mcp/brouillons` (agent) : ses brouillons. `POST /v1/mcp/brouillons/<id>/decision` (`{decision: "valide" | "refuse"}`) : l'agent du brouillon seul ; une décision ne change plus. Aucun outil MCP ne décide [R591]. Ces deux routes n'admettent que la séance d'une clé d'appareil (BR06) : une clé d'API, que l'agent a pu confier à son assistant, y reçoit 403 `application_requise`, au journal, pour qu'un assistant ne valide jamais ce qu'il a écrit ni ne relise le texte d'une note [R590, R591].
- La clé « mcp » n'enregistre aucune clé d'appareil et n'ouvre aucune séance : l'assistant ne peut pas se donner l'accès de l'application. Elle se range dans `API_KEYS` par Shawez (H65), ou l'agent la crée lui-même (BR09) :
- `POST /v1/cles/assistant` (agent, `{stepUpId, label}`) : seulement par la séance d'une clé d'appareil (une clé d'API : 403 `application_requise`, au journal), sur une preuve `creer_cle_api` faite pour l'objet `cle_assistant:<agent>` [R601]. Rend `{id, label, createdAt, revokedAt, cle}` : la clé n'est rendue qu'ici, une fois ; seule son empreinte SHA-256 est rangée (`assistant_keys`), ni l'une ni l'autre au journal [R13]. Trois clés actives au plus par agent (409 `limite_atteinte`, lu avant d'user la preuve). La clé créée porte la portée « mcp » : elle n'ouvre que `POST /v1/mcp` [R590] ; relue à chaque demande, elle n'est plus reconnue (401) une fois retirée ou son agent parti [R82].
- `GET /v1/cles/assistant` (agent) : ses clés, sans empreinte. `POST /v1/cles/assistant/<id>/retrait` (agent pour les siennes, direction pour tout agent de son réseau) : d'un geste, sans preuve [R600] ; la clé d'un autre agent : 404. Une clé retirée ne revient jamais et ne s'efface pas [R17].
- `POST /v1/mcp/public/<réseau>`, sans clé : le seul outil `biens_diffusables`, les biens que la diffusion autorise à l'instant même, tels que leur annonce publiée les décrit, sans adresse, agent ni donnée personnelle [R592]. Réseau inconnu : 404. Limites par heure : 120 demandes par adresse (`cf-connecting-ip`, en empreinte d'une heure), 5000 par réseau ; au-delà 429.

## Conditions et porte des phases (BR10, BR11)

Sous `/v1/phases`, la direction seule ; tout autre rôle est refusé (403) et le refus écrit au journal [R16]. Les rapports sont recalculés à chaque lecture ; rien n'est envoyé. Corps JSON de 8 ko au plus ; un corps illisible répond 400 sans rien ranger, un refus de règle 409 avec sa règle, un agent inconnu 404.

- `GET /` (soit `GET /v1/phases`) : l'état des cinq phases, lu à l'instant : la phase 1 ouverte d'office, chaque ouverture avec l'empreinte de la condition lue, la condition de chaque phase, une condition retombée depuis l'ouverture de la suivante, et si la suivante peut s'ouvrir [R646, R648] (BR11).
- `POST /ouvrir` (`{phase: 2 | 3 | 4 | 5}`) : ouvre la phase, une seule fois, seulement si la précédente est ouverte et sa condition remplie à cet instant ; sinon 409 avec la règle R647 et les raisons (BR11).
- `GET /pilotes` : la comparaison de chaque agent pilote, avant et après son arrivée, et la condition de la phase 3 [R641, R642].
- `POST /pilotes` (`{agentId}`) : désigne un agent actif du réseau comme pilote, une fois, avant le début de sa mesure [R640].
- `POST /pilotes/avant` (`{agentId, months: [n1, n2, n3], proofRef}`) : les mandats signés dans chacun des 3 mois d'avant, avec la référence de la preuve ; une version s'ajoute, rien ne change [R640].
- `GET /phase1` : la série de jours sans envoi hors règles, jour de Paris par jour, et la condition de la phase 1 [R643, R645].
- `POST /phase1/envois-hors-aimmo` (`{day: AAAA-MM-JJ, application: gohighlevel | manychat | site | github_actions | autre, proofRef}`) : un envoi hors règles constaté hors d'AIMMO, jamais retiré [R644].
- `POST /phase1/inventaire` (`{tasks: {gohighlevel, manychat, site, github_actions, autre}, proofRef}`) : l'inventaire des tâches encore planifiées dans les applications, chaque application dite même à zéro, par versions [R644].

Au planificateur : `phases.releve_phase1`, de minuit à 3 h de Paris, fige le relevé de la veille pour chaque réseau, une seule fois ; un jour manqué n'est jamais rattrapé et reste « sans donnée » [R643, R17].

## Ouverture région par région (BR12)

Sous `/v1/regions`, la direction seule ; tout autre rôle est refusé (403) et le refus écrit au journal [R16]. L'état est relu à chaque demande ; rien n'est envoyé, et aucune région ne s'ouvre seule. Corps JSON de 8 ko au plus ; un corps illisible répond 400 sans rien ranger, un refus de règle 409 avec sa règle.

- `GET /` (soit `GET /v1/regions`) : les 18 régions de l'INSEE, chacune ouverte ou non, depuis quand et par quelle version ; la Bourgogne-Franche-Comté ouverte d'office ; si une nouvelle région peut s'ouvrir maintenant, avec ses raisons et la date de fin d'attente [R650, R652].
- `POST /decision` (`{region: <code INSEE>, open: true | false, reason}`, raison de 3 à 200 caractères) : ouvre ou ferme une région ; une version s'ajoute à la chaîne, rien ne change. Une ouverture est refusée en 409 tant que la phase 5 n'est pas ouverte (R651, `phase5_fermee`) ou qu'une autre région est ouverte depuis moins de 90 jours (R652, `region_recente`, avec `until`) ; la région d'origine ou un code inconnu sont refusés (R650) [R651, R652].
- `GET /verification` : la chaîne des décisions recomptée depuis la première et recoupée avec le journal ; `{intact, versions}` ou, si une ligne a été changée ou retirée, `brokenAt`, la première version cassée [R653].

## Licence du logiciel aux agences hors réseau (BR15)

Sous `/v1/licences`, la direction seule ; tout autre rôle est refusé (403) et le refus écrit au journal [R16]. La direction d'une agence sous licence ne lit que sa licence : elle ne fixe aucun tarif, ne donne aucune licence et ne lit pas les autres (409, R657, `agence_licenciee`) [R657]. Aucun prélèvement, aucun envoi. Corps JSON de 8 ko au plus ; un corps illisible ou un champ non prévu répond 400 sans rien ranger, un refus de règle 409 avec sa règle, une licence inconnue 404.

- `GET /` (soit `GET /v1/licences`) : le tarif en vigueur et les licences données par le réseau, chacune avec son état, son tarif (`oldTariff` quand ce n'est plus celui en vigueur) et sa carte échue ou non ; la lecture va au journal [R16, R656].
- `GET /ma-licence` : pour la direction d'une agence sous licence, sa seule licence, sans SIREN ni région ; ailleurs 409 (R657, `pas_de_licence`) [R657].
- `POST /tarif` (`{monthlyCents, reason}`, de 100 à 10 000 000 centimes hors taxes, raison de 3 à 200 caractères) : un nouveau tarif mensuel, un seul pour toutes les agences ; une version s'ajoute. Hors bornes ou inchangé : 409 (R655) [R655].
- `POST /licence` (`{agencyName, siren, cardNumber, cardExpiresOn, department}`) : donne une licence au tarif en vigueur ; la demande n'a aucun champ de prix (un prix est refusé en 409, R655, `unknown_field`). Refusée en 409 tant que la phase 5 n'est pas ouverte (R654, `phase5_fermee`), sans tarif (R655, `tarif_absent`), pour un SIREN, une carte ou un département invalides, ou un SIREN déjà sous licence (R654) [R654, R655].
- `POST /etat` (`{licenceId, state: "active" | "suspendue" | "terminee", reason}`) : suspend, reprend ou termine une licence ; terminée, elle ne bouge plus (409, R656, `terminee`) [R656].
- `GET /tarif/<réseau>`, **sans clé** : le tarif public, `{current: {monthlyCents, since}, history: [{monthlyCents, from}]}`, sans aucune agence ni aucun nombre ; 404 tant qu'aucune licence ne peut se donner (phase 5 fermée, aucun tarif, réseau inconnu), sans dire laquelle [R655, R657].

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

## Accès en un clic (Z02)

Le travail GitHub « Créer l'accès de Shawez », lancé à la main depuis main, range une invitation (empreinte du jeton seule, valable 24 heures, rôles agent et direction), crée la fiche d'agent si elle manque, puis envoie le lien par l'envoi de mails de Cloudflare à l'adresse saisie au lancement [R200]. Il faut un jeton Cloudflare avec le droit « Email Sending: Edit », et une adresse d'expédition sur un domaine du compte ; l'adresse qui reçoit doit être une adresse de destination vérifiée du routage mail, tant qu'aucun domaine d'envoi n'est enrôlé.

Sans mail (Z04) : lancer le travail avec la remise `resume`. Le lien n'est alors écrit que dans le résumé du passage (Actions > Créer l'accès de Shawez > dernier passage > Summary), visible des seuls comptes qui lisent ce dépôt privé, jamais dans la sortie du travail ni dans le dépôt. Les adresses ne sont ni demandées ni gardées. Le mail reste la remise par défaut.

Le lien `…/app/#invitation=<jeton>` ouvre l'application, qui échange le jeton une seule fois par `POST /v1/acces/invitation` (`{ "jeton": "…" }`, sans clé) contre deux clés tirées par le Worker. La base ne garde que leur empreinte (table `access_keys`), qui s'ajoute aux empreintes du secret `API_KEYS` : le secret n'est jamais lu ni réécrit. Une clé se retire en datant `revoked_at`. Refus : 400 jeton mal formé, 404 inconnu, 410 déjà servi ou expiré.

- `GET` et `POST /v1/attirer/mentions-site` (RS05) : la direction lit et règle les mentions légales du site. Le corps du `POST` associe chaque champ à son texte (300 caractères au plus) ; un texte vide retire la mention. Rien n'est effacé [R17, R221].
