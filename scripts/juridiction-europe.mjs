#!/usr/bin/env node
// Données en Europe (HX56) [R602].
//
// Le test de configuration qui échoue dès qu'une base ou un stockage sort de la juridiction européenne :
// - dans `wrangler.toml` : seules les liaisons de stockage admises (base D1, compartiment R2) ; chaque compartiment
//   R2 déclaré en juridiction `eu` ; aucune autre liaison qui range des données (KV, Durable Objects, files, index,
//   Hyperdrive, mesures), dont Cloudflare ne garantit pas la juridiction européenne pour ce compte ;
// - au déploiement, en plus : chaque base D1 liée existe dans la liste du compte, sous son identifiant, avec la
//   juridiction `eu`. Un champ absent ou illisible échoue aussi : rien ne passe dans le doute.
//
// Lancé par les tests sur le fichier du dépôt, et par le travail de déploiement sur sa copie remplie, avant la mise en
// ligne : une erreur arrête la mise en ligne.
import { appendFileSync, readFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** Les tables admises dans la configuration du Worker. Toute autre table échoue, jusqu'à décision écrite. */
export const ALLOWED_TABLES = Object.freeze(['vars', 'triggers', 'observability', '[d1_databases]', '[r2_buckets]']);
/** Les liaisons qui rangent des données, à refuser sous toute forme (table ou clé en ligne). */
export const STORAGE_KEYS = Object.freeze(['kv_namespaces', 'durable_objects', 'queues', 'vectorize', 'hyperdrive', 'analytics_engine_datasets', 'd1_databases', 'r2_buckets', 'migrations']);
export const D1_PLACEHOLDER = '00000000-0000-0000-0000-000000000000';

function unquote(value) {
  const m = /^"([^"]*)"\s*(#.*)?$/.exec(value.trim());
  return m ? m[1] : null;
}

/** Les tables de la configuration, chacune avec ses clés, dans l'ordre. Une ligne illisible est rendue en erreur. */
export function parseTables(toml) {
  const tables = [];
  const errors = [];
  let current = { name: '', keys: {}, line: 0 };
  tables.push(current);
  toml.split('\n').forEach((raw, i) => {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) return;
    const header = /^\[(\[?[A-Za-z0-9_.-]+\]?)\]\s*(#.*)?$/.exec(line);
    if (header) {
      current = { name: header[1], keys: {}, line: i + 1 };
      tables.push(current);
      return;
    }
    const kv = /^([A-Za-z0-9_-]+)\s*=\s*(.+)$/.exec(line);
    if (!kv) {
      // Une valeur sur plusieurs lignes (tableau des déclencheurs) : seule la première ligne compte ici.
      if (/^["\]\d]/.test(line)) return;
      errors.push(`ligne ${i + 1} illisible`);
      return;
    }
    current.keys[kv[1]] = kv[2];
  });
  return { tables, errors };
}

/** Les erreurs de juridiction de la configuration seule. Une liste vide : rien ne sort d'Europe. */
export function checkConfig(toml) {
  const { tables, errors } = parseTables(toml);
  for (const t of tables) {
    if (t.name !== '' && !ALLOWED_TABLES.includes(t.name)) errors.push(`table [${t.name}] non admise (ligne ${t.line}) : sa juridiction n'est pas garantie en Europe [R602]`);
    for (const key of Object.keys(t.keys)) {
      if (STORAGE_KEYS.includes(key)) errors.push(`liaison « ${key} » écrite en ligne${t.name ? ` dans [${t.name}]` : ''} : non admise [R602]`);
    }
    if (t.name === '[r2_buckets]') {
      const bucket = unquote(t.keys.bucket_name ?? '') ?? '?';
      if (unquote(t.keys.jurisdiction ?? '') !== 'eu') errors.push(`compartiment R2 ${bucket} sans juridiction "eu" (ligne ${t.line}) [R602]`);
      if (t.keys.preview_bucket_name !== undefined) errors.push(`compartiment R2 ${bucket} : un compartiment d'aperçu n'est pas admis [R602]`);
    }
    if (t.name === '[d1_databases]') {
      if (t.keys.preview_database_id !== undefined) errors.push(`base D1 ${unquote(t.keys.database_name ?? '') ?? '?'} : une base d'aperçu n'est pas admise [R602]`);
    }
  }
  return errors;
}

/** Les bases D1 liées par la configuration : nom et identifiant. */
export function d1Bindings(toml) {
  return parseTables(toml).tables.filter((t) => t.name === '[d1_databases]').map((t) => ({ name: unquote(t.keys.database_name ?? ''), id: unquote(t.keys.database_id ?? '') }));
}

/**
 * Les erreurs de juridiction des bases D1 du compte, d'après `wrangler d1 list --json` (la liste de l'API Cloudflare,
 * qui porte `jurisdiction`). Chaque base liée doit y être, sous son identifiant, en `eu`.
 */
export function checkD1(toml, listJson) {
  let list;
  try {
    list = JSON.parse(listJson);
  } catch {
    return ['liste des bases D1 illisible [R602]'];
  }
  if (!Array.isArray(list)) return ['liste des bases D1 illisible [R602]'];
  const errors = [];
  for (const { name, id } of d1Bindings(toml)) {
    if (!name || !id || id === D1_PLACEHOLDER) {
      errors.push(`base D1 ${name ?? '?'} sans identifiant rempli [R602]`);
      continue;
    }
    const found = list.find((d) => d && typeof d === 'object' && d.uuid === id);
    if (!found) errors.push(`base D1 ${name} (${id}) absente de la liste du compte [R602]`);
    else if (found.name !== name) errors.push(`base D1 ${id} nommée ${found.name}, pas ${name} [R602]`);
    else if (found.jurisdiction !== 'eu') errors.push(`base D1 ${name} hors de la juridiction Europe (juridiction : ${found.jurisdiction ?? 'aucune'}) [R602]`);
  }
  return errors;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const [path, flag, listPath] = process.argv.slice(2);
  const toml = readFileSync(path, 'utf8');
  const errors = checkConfig(toml);
  if (flag === '--d1') errors.push(...checkD1(toml, readFileSync(listPath, 'utf8')));
  const summary = errors.length === 0 ? 'Données en Europe : base et stockages en juridiction européenne (R602).' : `Données hors d'Europe, mise en ligne arrêtée (R602) :\n- ${errors.join('\n- ')}`;
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
  process.exit(errors.length === 0 ? 0 : 1);
}
