#!/usr/bin/env node
// Aucune autorisation mémorisée : relire main avant chaque mutation distante.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function requireCurrentMain({ environment, event, checkoutSha, request = fetch }) {
  const repo = environment.GITHUB_REPOSITORY;
  const sha = environment.GITHUB_SHA;
  const eventName = environment.GITHUB_EVENT_NAME;
  if (!['push', 'workflow_dispatch'].includes(eventName)) {
    throw new Error('Déploiement refusé : événement non autorisé.');
  }
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo ?? '') || repo.includes('..')) {
    throw new Error('Déploiement refusé : dépôt invalide.');
  }
  if (!/^[a-f0-9]{40}$/.test(sha ?? '') || environment.GITHUB_REF !== 'refs/heads/main') {
    throw new Error('Déploiement refusé : SHA ou branche invalide.');
  }
  if (event?.repository?.full_name !== repo) {
    throw new Error('Déploiement refusé : dépôt de l’événement différent.');
  }
  if (eventName === 'push' && (event.ref !== 'refs/heads/main' || event.after !== sha)) {
    throw new Error('Déploiement refusé : le push ne porte pas le SHA attendu de main.');
  }
  if (eventName === 'workflow_dispatch' && !['main', 'refs/heads/main'].includes(event.ref)) {
    throw new Error('Déploiement refusé : lancement manuel hors main.');
  }
  if (checkoutSha !== sha) {
    throw new Error('Déploiement refusé : checkout différent du commit vérifié.');
  }
  const token = environment.GITHUB_TOKEN;
  if (!token) throw new Error('Déploiement refusé : jeton de lecture GitHub absent.');

  let response;
  try {
    response = await request(`https://api.github.com/repos/${repo}/git/ref/heads/main`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new Error('Déploiement refusé : lecture GitHub impossible.');
  }
  // Ne jamais afficher le corps serveur, des en-têtes ou le jeton dans les journaux.
  if (!response.ok) throw new Error(`Déploiement refusé : lecture GitHub HTTP ${response.status}.`);
  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error('Déploiement refusé : réponse GitHub illisible.');
  }
  if (!/^[a-f0-9]{40}$/.test(data?.object?.sha ?? '')) {
    throw new Error('Déploiement refusé : réponse GitHub incomplète.');
  }
  if (data.object.sha !== sha) {
    throw new Error('Déploiement refusé : main a avancé, ce commit est dépassé.');
  }
  return sha;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const sha = await requireCurrentMain({
      environment: process.env,
      event: JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')),
      checkoutSha: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    });
    console.log(`Commit actuel de main confirmé : ${sha}.`);
  } catch (error) {
    // Les erreurs d’entrées locales peuvent contenir un chemin mais jamais le contenu du payload.
    console.error(error instanceof Error && error.message.startsWith('Déploiement refusé :')
      ? error.message
      : 'Déploiement refusé : contexte local invalide.');
    process.exitCode = 1;
  }
}
