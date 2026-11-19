# Carte du passage à PostgreSQL

Écrite par le test `packages/core/test/sql-standard.test.ts` (HX67, R633) : ne pas la modifier à la main. Pour la refaire après une baisse : `ECRIRE_CARTE_SQL=1 npx vitest run packages/core/test/sql-standard.test.ts`.

Ce que SQLite et Cloudflare D1 lisent et que PostgreSQL ne lit pas tel quel, compté dans `db/migrations/`, `packages/core/src/` et les routes de l’API (`packages/api/src/`), commentaires exclus. Chaque compte peut baisser, jamais monter : une forme ajoutée fait échouer le test avec son fichier et sa ligne.

| Sorte | Occurrences | Fichiers | À la place, sous PostgreSQL |
| --- | ---: | ---: | --- |
| Déclencheur écrit à la façon de SQLite (`CREATE TRIGGER … BEGIN … END`) | tolérée, sans plafond | | une fonction `plpgsql` et `CREATE TRIGGER … EXECUTE FUNCTION` |
| `RAISE(ABORT, …)` dans un déclencheur | tolérée, sans plafond | | `RAISE EXCEPTION` dans la fonction du déclencheur |
| `INSERT OR IGNORE` ou `INSERT OR REPLACE` | 32 | 16 | `INSERT … ON CONFLICT DO NOTHING` ou `DO UPDATE` |
| `GLOB` | 35 | 24 | `~` (expression régulière) ou `SIMILAR TO` |
| Fonctions de date de SQLite (`datetime`, `julianday`, `strftime`, `unixepoch`, et `date` ou `time` avec `'now'` ou un modificateur) | 12 | 5 | `now()`, `to_char`, `extract`, `interval` |
| `AUTOINCREMENT` | 2 | 2 | `GENERATED ALWAYS AS IDENTITY` |
| `PRAGMA` et fonctions `pragma_…` | 9 | 4 | le catalogue (`pg_catalog`, `information_schema`) ou un réglage de la base |
| `rowid` et `last_insert_rowid()` | 153 | 55 | une clé déclarée et `RETURNING` |
| `group_concat` | 0 | 0 | `string_agg` |
| Fonctions JSON de SQLite (`json_extract`, `json_each`, `json_group_array`…) | 141 | 56 | opérateurs `->`, `->>` et `jsonb_array_elements`, `jsonb_agg` |
| `IFNULL` | 0 | 0 | `COALESCE` |
| `IIF` | 0 | 0 | `CASE WHEN … END` |
| `instr` | 5 | 4 | `position(… in …)` ou `strpos` |
| `char(…)` pour un caractère par son code | 3 | 2 | `chr(…)` |
| `printf` en SQL | 0 | 0 | `format` ou `to_char` |

En tout, hors sortes tolérées : 392 occurrences dans 144 fichiers.

Les déclencheurs et leur `RAISE` sont la garde des tables (R17) : chaque migration nouvelle en porte, ils sont tolérés sans plafond et seront réécrits en fonctions `plpgsql` au passage.

## Les fichiers les plus chargés

| Fichier | Occurrences |
| --- | ---: |
| `db/migrations/2800_factures_fournisseurs_banque.sql` | 27 |
| `packages/core/src/pige/pige.ts` | 27 |
| `packages/core/src/diffusion/surveillance.ts` | 21 |
| `packages/core/src/attirer/fiche-google.ts` | 13 |
| `db/migrations/3000_formation_quiz.sql` | 11 |
| `db/migrations/3310_gel_avoirs.sql` | 10 |
| `packages/core/src/sauvegarde/copie.ts` | 10 |
| `db/migrations/1807_actualites.sql` | 8 |
| `packages/core/src/attirer/page-agent.ts` | 8 |
| `packages/core/src/attirer/quartier.ts` | 6 |
| `packages/core/src/qualification/qualification.ts` | 6 |
| `db/migrations/0907_etat_des_lieux.sql` | 5 |
| `db/migrations/3100_calendrier_publications.sql` | 5 |
| `packages/core/src/automatismes/boite-mail.ts` | 5 |
| `packages/core/src/commerces/dossier.ts` | 5 |
| `db/migrations/1006_repreneurs_commerce.sql` | 4 |
| `db/migrations/1816_adresse_pige.sql` | 4 |
| `db/migrations/3120_publicite.sql` | 4 |
| `db/migrations/3320_reclamations.sql` | 4 |
| `packages/core/src/conformite/vigilance.ts` | 4 |
