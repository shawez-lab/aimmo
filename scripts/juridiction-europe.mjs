#!/usr/bin/env node
// Données en Europe (HX56) [R602].
//
// Le test de configuration qui échoue dès qu'une base ou un stockage sort de la juridiction européenne :
// - dans `wrangler.toml` : seules les liaisons de stockage admises (base D1, compartiment R2) ; chaque compartiment
//   R2 déclaré en juridiction `eu` ; aucune autre liaison qui range des données (KV, Durable Objects, files, index,
//   Hyperdrive, mesures), dont Cloudflare ne garantit pas la juridiction européenne pour ce compte ;
// - au déploiement, en plus : chaque base D1 liée existe dans la liste du compte, sous son identifiant, avec la
//   juridiction `eu`, et jamais deux liaisons sur la même base (AU025 : le bac à sable a sa base à part). Un champ
//   absent ou illisible échoue aussi : rien ne passe dans le doute.
//
// Lancé par les tests sur le fichier du dépôt, et par le travail de déploiement sur sa copie remplie, avant la mise en
// ligne : une erreur arrête la mise en ligne.
import { appendFileSync, readFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** Les tables admises dans la configuration du Worker, chacune avec ses clés admises (`null` : toute clé, des valeurs). */
export const ALLOWED_TABLES = Object.freeze({
  '': ['name', 'main', 'compatibility_date', 'compatibility_flags', 'workers_dev', 'preview_urls'],
  vars: null,
  triggers: ['crons'],
  observability: ['enabled', 'head_sampling_rate'],
  '[d1_databases]': ['binding', 'database_name', 'database_id', 'migrations_dir', 'migrations_table'],
  '[r2_buckets]': ['binding', 'bucket_name', 'jurisdiction'],
});
export const D1_PLACEHOLDER = '00000000-0000-0000-0000-000000000000';
/** AU025 : le gabarit de la base à part des bacs à sable ; chaque gabarit commence par huit zéros, jamais un vrai identifiant. */
export const SANDBOX_D1_PLACEHOLDER = '00000000-0000-0000-0000-0000000000b5';
const UNFILLED = /^00000000-0000-0000-0000-/;

function unquote(value) {
  const m = /^"([^"]*)"\s*(#.*)?$/.exec(value.trim());
  return m ? m[1] : null;
}

/** Un tableau ouvert sur la ligne et pas refermé : `[` sans `]` de fin, hors texte entre guillemets. */
function opensArray(value) {
  const v = value.replace(/"[^"]*"/g, '""').replace(/#.*$/, '').trim();
  return v.startsWith('[') && (v.match(/\[/g) ?? []).length > (v.match(/\]/g) ?? []).length;
}

/** Les tables de la configuration, chacune avec ses clés, dans l'ordre. Une ligne illisible est rendue en erreur. */
export function parseTables(toml) {
  const tables = [];
  const errors = [];
  let current = { name: '', keys: {}, line: 0 };
  tables.push(current);
  let inArray = false;
  toml.split('\n').forEach((raw, i) => {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) return;
    if (inArray) {
      // Seulement des valeurs entre guillemets, jusqu'au crochet qui ferme.
      if (!/^("[^"]*"\s*,?\s*)*\]?\s*(#.*)?$/.test(line)) errors.push(`ligne ${i + 1} illisible [R602]`);
      if (/\]\s*(#.*)?$/.test(line)) inArray = false;
      return;
    }
    const header = /^\[(\[?[A-Za-z0-9_.-]+\]?)\]\s*(#.*)?$/.exec(line);
    if (header) {
      current = { name: header[1], keys: {}, line: i + 1 };
      tables.push(current);
      return;
    }
    // Une clé nue seulement : une clé entre guillemets ou à points pourrait cacher une liaison.
    const kv = /^([A-Za-z0-9_-]+)\s*=\s*(.+)$/.exec(line);
    if (!kv) {
      errors.push(`ligne ${i + 1} illisible [R602]`);
      return;
    }
    current.keys[kv[1]] = kv[2];
    if (opensArray(kv[2])) inArray = true;
  });
  if (inArray) errors.push('tableau non refermé [R602]');
  return { tables, errors };
}

/** Les erreurs de juridiction de la configuration seule. Une liste vide : rien ne sort d'Europe. */
export function checkConfig(toml) {
  const { tables, errors } = parseTables(toml);
  for (const t of tables) {
    if (!Object.hasOwn(ALLOWED_TABLES, t.name)) {
      errors.push(`table [${t.name}] non admise (ligne ${t.line}) : sa juridiction n'est pas garantie en Europe [R602]`);
      continue;
    }
    const allowed = ALLOWED_TABLES[t.name];
    if (allowed !== null) {
      for (const key of Object.keys(t.keys)) {
        if (!allowed.includes(key)) errors.push(`clé « ${key} »${t.name ? ` dans [${t.name}]` : ''} non admise : elle peut lier un stockage hors d'Europe [R602]`);
      }
    }
    if (t.name === '[r2_buckets]') {
      const bucket = unquote(t.keys.bucket_name ?? '') ?? '?';
      if (unquote(t.keys.jurisdiction ?? '') !== 'eu') errors.push(`compartiment R2 ${bucket} sans juridiction "eu" (ligne ${t.line}) [R602]`);
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
  const seen = new Set();
  for (const { name, id } of d1Bindings(toml)) {
    if (!name || !id || UNFILLED.test(id)) {
      errors.push(`base D1 ${name ?? '?'} sans identifiant rempli [R602]`);
      continue;
    }
    // Deux liaisons sur une même base : le bac à sable serait la base du réseau [R82].
    if (seen.has(id)) {
      errors.push(`base D1 ${name} liée deux fois (${id}) [R602]`);
      continue;
    }
    seen.add(id);
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
