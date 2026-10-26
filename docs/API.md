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
| GET | `/v1/journal/verification` | la chaîne d'empreintes du journal est-elle intacte | direction, conformité |
| GET, POST | `/v1/meta/notifications` | vérification de l'abonnement, puis notifications signées d'Instagram, Facebook et WhatsApp ; réponse prête en mode essai, jamais envoyée | Meta, par signature (`META_APP_SECRET`) |
| POST | `/v1/captation/formulaire` | dépose un formulaire « Être rappelé » ; rend seulement des statuts, la réponse est prête en mode essai, jamais envoyée | clé de dépôt (`INTAKE_KEYS`) |

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

## Mise en ligne

`.github/workflows/deployer-api.yml`, à chaque arrivée sur main, une fois H04 fait : vérifications, création de la base `aimmo` en juridiction européenne si elle manque, migrations de `db/migrations`, puis déploiement. Aucune route sur shawez-immo.com : seulement l'adresse workers.dev du compte. Chaque proposition vérifie aussi que le Worker s'empaquette (`wrangler deploy --dry-run`).

## En local

```sh
cd packages/api
npx wrangler@4.149.0 d1 migrations apply aimmo --local
echo 'API_KEYS=[...]' > .dev.vars   # jamais commité
npx wrangler@4.149.0 dev --local
```
