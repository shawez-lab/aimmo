#!/usr/bin/env node
// Garde-fous lancés à chaque vérification : aucun secret, aucune règle en service sans test, aucun fichier énorme.
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';

const errors = [];

const tracked = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
  .split('\0')
  .filter(Boolean);

// 1. Aucun secret dans le dépôt.
const SECRET_PATTERNS = [
  ['clé Anthropic', /sk-ant-[A-Za-z0-9_-]{20,}/],
  ['clé OpenAI', /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}/],
  ['jeton GitHub', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})/],
  ['clé AWS', /\bAKIA[0-9A-Z]{16}\b/],
  ['clé privée', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['jeton Slack', /\bxox[baprs]-[A-Za-z0-9-]{10,}/],
  ['jeton Meta', /\bEAA[A-Za-z0-9]{60,}/],
  ['jeton Google', /\bya29\.[A-Za-z0-9_-]{20,}/],
  ['clé Google', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['jeton Stripe', /\b(?:sk|rk)_live_[A-Za-z0-9]{20,}/],
];
const SKIP_SECRET_SCAN = new Set(['scripts/garde-fous.mjs', 'package-lock.json']);

for (const file of tracked) {
  if (SKIP_SECRET_SCAN.has(file)) continue;
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    continue;
  }
  for (const [label, pattern] of SECRET_PATTERNS) {
    if (pattern.test(text)) errors.push(`${file} : ressemble à un secret (${label}). Les secrets vont dans Cloudflare ou GitHub, jamais dans le dépôt.`);
  }
}

// 2. Chaque règle en service a au moins un test qui porte son numéro.
const rules = readFileSync('docs/REGLES.md', 'utf8')
  .split('\n')
  .filter((line) => /^\| R\d{2,3} \|/.test(line))
  .map((line) => line.split('|').map((cell) => cell.trim()))
  .map((cells) => ({ id: cells[1], inService: cells[3] === 'oui' }));

const testText = tracked
  .filter((file) => /^packages\/[^/]+\/test\/.+\.test\.ts$/.test(file))
  .map((file) => readFileSync(file, 'utf8'))
  .join('\n');

for (const rule of rules) {
  if (rule.inService && !testText.includes(`[${rule.id}]`)) {
    errors.push(`docs/REGLES.md : ${rule.id} est en service mais aucun test ne porte « [${rule.id}] ».`);
  }
}

// 3. Aucun fichier énorme.
const MAX_BYTES = 1_500_000;
for (const file of tracked) {
  if (file === 'package-lock.json') continue;
  try {
    if (statSync(file).size > MAX_BYTES) errors.push(`${file} : plus de 1,5 Mo. Les gros fichiers vont dans R2, pas dans le dépôt.`);
  } catch {
    // fichier supprimé dans l'arbre de travail : ignoré
  }
}

if (errors.length > 0) {
  console.error(`Garde-fous : ${errors.length} problème(s)\n- ${errors.join('\n- ')}`);
  process.exit(1);
}
console.log(`Garde-fous : tout va bien (${tracked.length} fichiers, ${rules.filter((r) => r.inService).length} règle(s) en service).`);
