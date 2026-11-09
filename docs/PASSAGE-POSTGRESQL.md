# Carte du passage à PostgreSQL

Écrite par le test `packages/core/test/sql-standard.test.ts` (HX67, R633) : ne pas la modifier à la main. Pour la refaire après une baisse : `ECRIRE_CARTE_SQL=1 npx vitest run packages/core/test/sql-standard.test.ts`.

Ce que SQLite et Cloudflare D1 lisent et que PostgreSQL ne lit pas tel quel, compté dans `db/migrations/` et `packages/core/src/`, commentaires exclus. Chaque compte peut baisser, jamais monter : une forme ajoutée fait échouer le test avec son fichier et sa ligne.

| Sorte | Occurrences | Fichiers | À la place, sous PostgreSQL |
| --- | ---: | ---: | --- |
| Déclencheur écrit à la façon de SQLite (`CREATE TRIGGER … BEGIN … END`) | 1032 | 212 | une fonction `plpgsql` et `CREATE TRIGGER … EXECUTE FUNCTION` |
| `RAISE(ABORT, …)` dans un déclencheur | 1032 | 212 | `RAISE EXCEPTION` dans la fonction du déclencheur |
| `INSERT OR IGNORE` ou `INSERT OR REPLACE` | 32 | 16 | `INSERT … ON CONFLICT DO NOTHING` ou `DO UPDATE` |
| `GLOB` | 35 | 24 | `~` (expression régulière) ou `SIMILAR TO` |
| Fonctions de date de SQLite (`datetime`, `julianday`, `strftime`, `unixepoch`) | 2 | 2 | `now()`, `to_char`, `extract`, `interval` |
| `AUTOINCREMENT` | 3 | 3 | `GENERATED ALWAYS AS IDENTITY` |
| `PRAGMA` et fonctions `pragma_…` | 10 | 5 | le catalogue (`pg_catalog`, `information_schema`) ou un réglage de la base |
| `rowid` et `last_insert_rowid()` | 169 | 56 | une clé déclarée et `RETURNING` |
| `group_concat` | 0 | 0 | `string_agg` |
| Fonctions JSON de SQLite (`json_extract`, `json_each`, `json_group_array`…) | 141 | 56 | opérateurs `->`, `->>` et `jsonb_array_elements`, `jsonb_agg` |
| `IFNULL` | 0 | 0 | `COALESCE` |
| `IIF` | 0 | 0 | `CASE WHEN … END` |
| `instr` | 5 | 4 | `position(… in …)` ou `strpos` |
| `char(…)` pour un caractère par son code | 3 | 2 | `chr(…)` |
| `printf` en SQL | 0 | 0 | `format` ou `to_char` |

En tout : 2464 occurrences dans 286 fichiers sur 645 lus.

## Les fichiers les plus chargés

| Fichier | Occurrences |
| --- | ---: |
| `db/migrations/2800_factures_fournisseurs_banque.sql` | 57 |
| `db/migrations/1765_partage_agences.sql` | 46 |
| `db/migrations/3120_publicite.sql` | 40 |
| `db/migrations/3310_gel_avoirs.sql` | 40 |
| `db/migrations/0708_durees_fuites.sql` | 38 |
| `db/migrations/2200_diffusion_surveillee.sql` | 38 |
| `db/migrations/2610_neuf_viager.sql` | 33 |
| `db/migrations/3000_formation_quiz.sql` | 27 |
| `packages/core/src/pige/pige.ts` | 27 |
| `db/migrations/1809_pige.sql` | 26 |
| `db/migrations/3320_reclamations.sql` | 26 |
| `db/migrations/1007_cession_commerce.sql` | 25 |
| `db/migrations/1401_prix_regroupes.sql` | 24 |
| `db/migrations/1403_fiche_google.sql` | 24 |
| `db/migrations/1808_cles.sql` | 24 |
| `db/migrations/1816_adresse_pige.sql` | 24 |
| `db/migrations/3100_calendrier_publications.sql` | 23 |
| `db/migrations/0807_envois_professionnels.sql` | 21 |
| `db/migrations/0901_mises_en_location.sql` | 21 |
| `db/migrations/1004_confidentialite_commerce.sql` | 21 |
