#!/usr/bin/env node
// DS086 · Les captures rejouables d'AIMMO : chaque écran, sur un téléphone et sur un ordinateur, avec ses mesures.
//
//   node scripts/captures.mjs <dossier>                  capture tous les écrans dans <dossier>
//   node scripts/captures.mjs --comparer <avant> <après> dit ce qui a changé entre deux dossiers de captures
//
// Tout est inventé : les pages rendues par le code, et l'application servie sur le parcours complet, dans une base en
// mémoire. Aucune donnée réelle, aucune clé du réseau, aucun appel au dehors. Les captures tournent là où Playwright et
// son navigateur sont installés ; le plan et les mesures sont décrits dans `packages/api/test/captures.test.ts`.
import { spawnSync } from 'node:child_process';
import { readFileSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const fr = (n) => String(n).replace('.', ',');
const screens = (n) => `${fr(n)} ${n >= 2 ? 'écrans' : 'écran'}`;
const filled = (n) => `${n} ${n >= 2 ? 'boutons pleins' : 'bouton plein'}`;

/**
 * Ce qui a changé entre deux jeux de mesures (`captures.json`) : une ligne par écran et par vue, dans l'ordre des noms.
 * Un écran dont rien n'a bougé ne dit rien.
 */
export function compareCaptures(before, after) {
  const key = (m) => `${m.nom} (${m.vue})`;
  const was = new Map(before.map((m) => [key(m), m]));
  const is = new Map(after.map((m) => [key(m), m]));
  const lines = [];
  for (const k of [...new Set([...was.keys(), ...is.keys()])].sort((a, b) => a.localeCompare(b, 'fr'))) {
    const a = was.get(k), b = is.get(k);
    if (!a) { lines.push(`${k} : nouvel écran, ${screens(b.ecrans)}, ${filled(b.boutonsPleins)}`); continue; }
    if (!b) { lines.push(`${k} : n’est plus capturé`); continue; }
    const said = [];
    if (a.ecrans !== b.ecrans) said.push(`${fr(a.ecrans)} → ${screens(b.ecrans)}`);
    if (a.boutonsPleins !== b.boutonsPleins) said.push(`${a.boutonsPleins} → ${filled(b.boutonsPleins)}`);
    if (a.deborde !== b.deborde) said.push(b.deborde ? 'déborde maintenant' : 'ne déborde plus');
    if (said.length) lines.push(`${k} : ${said.join(' ; ')}`);
  }
  return lines;
}

const read = (dir) => JSON.parse(readFileSync(join(resolve(dir), 'captures.json'), 'utf8'));

/**
 * Ce qu'un dossier de captures contient après une demande faite à `since` (en millisecondes) : un succès seulement si
 * ses mesures sont là, écrites depuis, et non vides. Sans Chromium, les essais se sautent ou échouent : ce contrôle
 * empêche de prendre un dossier vide, ou resté d'une autre fois, pour un jeu de captures.
 */
export function captureOutcome(dir, since) {
  const file = join(dir, 'captures.json');
  let written;
  try {
    written = statSync(file).mtimeMs;
  } catch {
    return { ok: false, message: `Aucune capture n’a été faite : ${file} est absent. Playwright et Chromium sont-ils installés ?` };
  }
  if (written < since - 2000) return { ok: false, message: `Aucune capture n’a été faite : ${file} date d’avant cette demande.` };
  let list;
  try {
    list = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return { ok: false, message: `Les mesures ne se lisent pas : ${file} n’est pas un fichier de mesures.` };
  }
  if (!Array.isArray(list) || list.length === 0) return { ok: false, message: `Aucune capture n’a été faite : ${file} est vide.` };
  return { ok: true, message: `${list.length} ${list.length > 1 ? 'captures et leurs mesures' : 'capture et ses mesures'} dans ${dir} (captures.json).` };
}

function main(args) {
  if (args[0] === '--comparer') {
    if (args.length !== 3) { console.error('Usage : node scripts/captures.mjs --comparer <avant> <après>'); return 2; }
    const lines = compareCaptures(read(args[1]), read(args[2]));
    console.log(lines.length ? lines.join('\n') : 'Aucune mesure n’a changé.');
    return 0;
  }
  if (args.length !== 1 || args[0].startsWith('-')) { console.error('Usage : node scripts/captures.mjs <dossier>\n        node scripts/captures.mjs --comparer <avant> <après>'); return 2; }
  const out = resolve(args[0]);
  const root = resolve(fileURLToPath(import.meta.url), '..', '..');
  // Les mesures d'une fois précédente s'en vont : elles ne peuvent pas passer pour celles de cette fois-ci.
  rmSync(join(out, 'captures.json'), { force: true });
  const since = Date.now();
  const run = spawnSync('npx', ['vitest', 'run', 'packages/api/test/captures.test.ts'], { cwd: root, stdio: 'inherit', env: { ...process.env, AIMMO_CAPTURES: out } });
  const outcome = captureOutcome(out, since);
  if (run.status !== 0) { console.error(`Les captures ont échoué.${outcome.ok ? ' Des images ont été faites, mais le jeu n’est pas complet.' : ` ${outcome.message}`}`); return run.status ?? 1; }
  if (!outcome.ok) { console.error(outcome.message); return 1; }
  console.log(outcome.message);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)));
