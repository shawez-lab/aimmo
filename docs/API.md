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

## Mise en ligne

`.github/workflows/deployer-api.yml`, à chaque arrivée sur main, une fois H04 fait : vérifications, création de la base `aimmo` en juridiction européenne si elle manque, migrations de `db/migrations`, puis déploiement. Aucune route sur shawez-immo.com : seulement l'adresse workers.dev du compte. Chaque proposition vérifie aussi que le Worker s'empaquette (`wrangler deploy --dry-run`).

## En local

```sh
cd packages/api
npx wrangler@4.149.0 d1 migrations apply aimmo --local
echo 'API_KEYS=[...]' > .dev.vars   # jamais commité
npx wrangler@4.149.0 dev --local
```
