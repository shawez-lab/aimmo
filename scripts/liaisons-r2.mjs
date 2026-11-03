#!/usr/bin/env node
// Déclare au déploiement la liaison de chaque compartiment R2 qui existe (X27).
//
// `wrangler deploy` republie le Worker d'après `wrangler.toml` : une liaison posée à la main dans Cloudflare disparaîtrait.
// Une liaison vers un compartiment absent ferait échouer la mise en ligne : seuls ceux qui existent sont donc déclarés.
// Le fichier du dépôt ne change pas : le travail de déploiement modifie sa copie, comme pour l'identifiant de la base.
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { stripVTControlCharacters } from 'node:util';

/** Chaque liaison du Worker et son compartiment, toujours à part : le coffre n'en partage aucun [L09]. */
export const R2_BINDINGS = Object.freeze({
  PIECES: 'aimmo-pieces',
  MEDIA: 'aimmo-medias',
  COFFRE: 'aimmo-coffre',
  COMMERCES: 'aimmo-commerces',
});

/** Les noms dans la sortie de `wrangler r2 bucket list`, qui écrit `name:   <nom>` pour chacun. */
export function parseBucketNames(output) {
  return [...stripVTControlCharacters(output).matchAll(/^name:\s*(\S+)\s*$/gm)].map((m) => m[1]);
}

/**
 * La configuration avec les liaisons des compartiments trouvés. `found` associe un nom à sa juridiction (`null` : aucune).
 * Une liaison déjà déclarée n'est jamais doublée.
 */
export function withBindings(toml, found) {
  let out = toml;
  const linked = [];
  for (const [binding, bucket] of Object.entries(R2_BINDINGS)) {
    if (!found.has(bucket) || new RegExp(`^binding\\s*=\\s*"${binding}"`, 'm').test(toml)) continue;
    const jurisdiction = found.get(bucket);
    out = `${out.trimEnd()}\n\n[[r2_buckets]]\nbinding = "${binding}"\nbucket_name = "${bucket}"\n${jurisdiction ? `jurisdiction = "${jurisdiction}"\n` : ''}`;
    linked.push(binding);
  }
  return { toml: out, linked };
}

/** Les compartiments du compte, partout où ils peuvent être. Une liste illisible rend `null`, jamais une liste vide trompeuse. */
export function readBuckets(list) {
  const found = new Map();
  try {
    // La juridiction d'abord : un même nom peut exister dans les deux, et les données restent en Europe.
    for (const jurisdiction of ['eu', null]) {
      for (const name of parseBucketNames(list(jurisdiction))) if (!found.has(name)) found.set(name, jurisdiction);
    }
  } catch {
    return null;
  }
  return found;
}

/** Tout le passage : rend le texte du résumé du travail ; aucune erreur n'arrête la mise en ligne. */
export function declare(path, list, read = readFileSync, write = writeFileSync) {
  const found = readBuckets(list);
  if (found === null) return "Compartiments R2 : liste illisible (R2 non activé, droit du jeton ou panne, voir H45). Mise en ligne sans liaison R2 : les documents déjà rangés restent dans leurs compartiments, mais leurs routes répondent « indisponible » jusqu'au prochain passage réussi.";
  const { toml, linked } = withBindings(read(path, 'utf8'), found);
  if (linked.length > 0) write(path, toml);
  // Une liaison posée à la main sous un autre nom ne se voit pas d'ici : le résumé dit ce qui reste sans compartiment.
  const missing = Object.entries(R2_BINDINGS).filter(([, bucket]) => !found.has(bucket)).map(([binding, bucket]) => `${binding} (${bucket})`);
  return `Compartiments R2 liés : ${linked.length > 0 ? linked.join(', ') : 'aucun'}. Sans compartiment de ce nom : ${missing.length > 0 ? missing.join(', ') : 'aucun'}.`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const wrangler = process.env.WRANGLER ?? 'wrangler';
  const list = (jurisdiction) => execFileSync('npx', ['-y', wrangler, 'r2', 'bucket', 'list', ...(jurisdiction ? ['--jurisdiction', jurisdiction] : [])], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const summary = declare(process.argv[2], list);
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
}
