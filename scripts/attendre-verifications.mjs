#!/usr/bin/env node
// Attend la fin des vérifications GitHub d'une proposition de modification, puis la relecture de Codex si demandé.
// Usage : node scripts/attendre-verifications.mjs <numéro> [--codex]
// Sortie : 0 tout est vert, 1 une vérification a échoué, 3 délai dépassé, 4 Codex signale un P0 ou un P1.
import { execFileSync } from 'node:child_process';

const REPO = process.env.AIMMO_REPO ?? 'shawez-lab/aimmo';
const [number, ...flags] = process.argv.slice(2);
if (!number) {
  console.error('Usage : node scripts/attendre-verifications.mjs <numéro> [--codex]');
  process.exit(2);
}
const waitForCodex = flags.includes('--codex');

const api = (path) => JSON.parse(execFileSync('gh', ['api', path], { encoding: 'utf8' }));
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const minutesFromNow = (minutes) => Date.now() + minutes * 60_000;

const pr = api(`repos/${REPO}/pulls/${number}`);
const sha = pr.head.sha;
console.log(`Proposition n° ${number}, « ${pr.title} », commit ${sha.slice(0, 7)}`);

// 1. Vérifications : 20 minutes au plus. Sans aucune vérification au bout de 3 minutes, on n'attend plus.
let checks = [];
const checksDeadline = minutesFromNow(20);
const noChecksDeadline = minutesFromNow(3);
for (;;) {
  checks = api(`repos/${REPO}/commits/${sha}/check-runs?per_page=100`).check_runs ?? [];
  const pending = checks.filter((check) => check.status !== 'completed');
  if (checks.length > 0 && pending.length === 0) break;
  if (checks.length === 0 && Date.now() > noChecksDeadline) break;
  if (Date.now() > checksDeadline) {
    console.log(`Délai dépassé : ${pending.length} vérification(s) encore en cours.`);
    process.exit(3);
  }
  await pause(30_000);
}

const OK = new Set(['success', 'neutral', 'skipped']);
const failed = checks.filter((check) => !OK.has(check.conclusion));
for (const check of checks) console.log(`- ${check.name} : ${check.conclusion}`);
if (checks.length === 0) console.log('- aucune vérification trouvée pour ce commit');
if (failed.length > 0) {
  console.log(`Échec : ${failed.map((check) => check.name).join(', ')}. Détails : ${failed[0].html_url}`);
  process.exit(1);
}

// 2. Relecture de Codex : 10 minutes au plus après les vérifications.
if (waitForCodex) {
  const isCodex = (item) => /codex/i.test(item.user?.login ?? '');
  const codexDeadline = minutesFromNow(10);
  let reviews = [];
  let comments = [];
  for (;;) {
    reviews = api(`repos/${REPO}/pulls/${number}/reviews?per_page=100`).filter(isCodex);
    comments = api(`repos/${REPO}/pulls/${number}/comments?per_page=100`).filter(isCodex);
    const issueComments = api(`repos/${REPO}/issues/${number}/comments?per_page=100`).filter(isCodex);
    comments = comments.concat(issueComments);
    const reviewedThisCommit = reviews.some((review) => review.commit_id === sha);
    if (reviewedThisCommit || comments.length > 0) break;
    if (Date.now() > codexDeadline) {
      console.log('Codex : aucune relecture au bout de 10 minutes. On continue sans elle (SECOURS.md).');
      break;
    }
    await pause(30_000);
  }
  const texts = [...reviews.map((review) => review.body ?? ''), ...comments.map((comment) => comment.body ?? '')];
  const serious = texts.filter((text) => /\bP[01]\b/.test(text));
  for (const text of texts.filter(Boolean)) console.log(`Codex : ${text.slice(0, 600)}`);
  if (serious.length > 0) {
    console.log(`Codex signale ${serious.length} problème(s) P0 ou P1 : à corriger, ou à réfuter dans la proposition.`);
    process.exit(4);
  }
}

console.log('Tout est vert.');
