#!/usr/bin/env node
// Attend la fin des vérifications GitHub d'une proposition de modification, puis la relecture de Codex si demandé.
// Usage : node scripts/attendre-verifications.mjs <numéro> [--codex]
// Sortie : 0 tout est vert, 1 une vérification a échoué, 3 délai dépassé, 4 Codex signale un P0 ou un P1,
// 5 Codex n'est pas prêt pour ce dépôt (environnement à créer) : continuer sans lui et le noter dans chantier/HUMAIN.md.
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

let pr = api(`repos/${REPO}/pulls/${number}`);

// Lancé depuis la branche de la proposition juste après un push : attendre que GitHub voie le dernier commit.
let expected = null;
try {
  const branch = execFileSync('git', ['branch', '--show-current'], { encoding: 'utf8' }).trim();
  if (branch === pr.head.ref) expected = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
} catch {
  // hors d'un dépôt git : on prend le dernier commit connu de GitHub
}
const headDeadline = minutesFromNow(2);
while (expected && pr.head.sha !== expected && Date.now() < headDeadline) {
  await pause(10_000);
  pr = api(`repos/${REPO}/pulls/${number}`);
}
if (expected && pr.head.sha !== expected) {
  console.log(`GitHub ne voit pas encore le commit ${expected.slice(0, 7)} : vérifier que le push est passé.`);
  process.exit(3);
}

const sha = pr.head.sha;
console.log(`Proposition n° ${number}, « ${pr.title} », commit ${sha.slice(0, 7)}`);

// 1. Vérifications : 50 minutes au plus, au-delà du délai de 45 minutes du travail. Sans aucune vérification au bout de 3 minutes, on n'attend plus.
let checks = [];
const checksDeadline = minutesFromNow(50);
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

// 2. Relecture de Codex sur la version actuelle : 15 minutes au plus après les vérifications.
// Codex tient un commentaire de synthèse qui porte son état : <!-- codex-review-state:v1 {...} -->.
if (waitForCodex) {
  const isCodex = (item) => /codex/i.test(item.user?.login ?? '');
  const headTime = new Date(api(`repos/${REPO}/commits/${sha}`).commit.committer.date).getTime();
  const isFresh = (date) => Boolean(date) && new Date(date).getTime() >= headTime - 60_000;
  const readState = (body) => {
    const match = /codex-review-state:v1 (\{.*?\}) -->/s.exec(body ?? '');
    if (!match) return null;
    try {
      return JSON.parse(match[1]);
    } catch {
      return null;
    }
  };
  const isSerious = (text) => /\bP[01]\b/.test(text);
  const WAITING = new Set(['queued', 'pending', 'running', 'in_progress', null, undefined]);
  const codexDeadline = minutesFromNow(15);
  let verdict = 'pas de relecture au bout de 15 minutes, on continue sans elle (SECOURS.md)';
  let texts = [];
  let findings = false;
  for (;;) {
    const comments = api(`repos/${REPO}/issues/${number}/comments?per_page=100`).filter(isCodex);
    const setupNeeded = comments.some(
      (comment) =>
        isFresh(comment.created_at) &&
        /create an environment|set up an environment|connect (?:a|this) repo/i.test(comment.body ?? ''),
    );
    if (setupNeeded) {
      console.log("Codex n'est pas prêt pour ce dépôt : il demande un environnement. On continue sans sa relecture (HUMAIN.md, H03).");
      process.exit(5);
    }
    const summaries = comments
      .map((comment) => ({ comment, state: readState(comment.body) }))
      .filter((item) => item.state?.code_review)
      .sort((a, b) => new Date(b.comment.updated_at).getTime() - new Date(a.comment.updated_at).getTime());
    const review = summaries[0]?.state.code_review;
    const reviewsOfHead = () =>
      api(`repos/${REPO}/pulls/${number}/reviews?per_page=100`).filter(
        (item) => isCodex(item) && item.commit_id === sha,
      );
    const lineCommentsOfHead = () =>
      api(`repos/${REPO}/pulls/${number}/comments?per_page=100`).filter(
        (item) => isCodex(item) && (item.commit_id === sha || item.original_commit_id === sha),
      );
    // Seuls P0 et P1 bloquent. Les remarques P2 ou moins sont affichées, à corriger si c'est simple.
    const judge = (label, hasAnyFinding) => {
      findings = texts.some(isSerious);
      if (findings) return `${label}, problèmes P0 ou P1 signalés`;
      return hasAnyFinding ? `${label}, remarques mineures seulement (P2 ou moins)` : `${label}, rien à signaler`;
    };
    if (review && review.commit_sha === sha && !WAITING.has(review.status)) {
      texts = [...reviewsOfHead(), ...lineCommentsOfHead()].map((item) => item.body ?? '').filter(Boolean);
      if (/fail|error|cancel/i.test(String(review.status))) {
        verdict = `relecture de Codex en échec (${review.status}), on continue sans elle (SECOURS.md)`;
      } else {
        verdict = judge(`relu (${review.status})`, review.has_unresolved_findings === true);
      }
      break;
    }
    if (summaries.length === 0) {
      // Sans commentaire d'état : une relecture du dernier commit, avec ses remarques en ligne, ou un pouce levé.
      const reviews = reviewsOfHead();
      if (reviews.length > 0) {
        const lineComments = lineCommentsOfHead();
        texts = [...reviews, ...lineComments].map((item) => item.body ?? '').filter(Boolean);
        verdict = judge('relu', lineComments.length > 0);
        break;
      }
      const reactions = api(`repos/${REPO}/issues/${number}/reactions?per_page=100`).filter(
        (item) => isCodex(item) && isFresh(item.created_at),
      );
      if (reactions.some((item) => item.content === '+1')) {
        verdict = 'relu, rien à signaler';
        break;
      }
    }
    if (Date.now() > codexDeadline) break;
    await pause(30_000);
  }
  console.log(`Codex : ${verdict}`);
  for (const text of texts) console.log(`Codex : ${text.slice(0, 800)}`);
  if (findings) {
    console.log('Codex signale des problèmes P0 ou P1 : à corriger, ou à réfuter dans la proposition.');
    process.exit(4);
  }
}

console.log('Tout est vert.');
