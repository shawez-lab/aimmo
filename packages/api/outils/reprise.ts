/**
 * « Reprise des contacts » (I05), lancé par le travail GitHub du même nom, jamais depuis un poste ni par le Worker.
 *
 * Lit les trois fichiers déposés par la direction dans la base `aimmo`, la base `espace-estimation` du site en lecture
 * seule, et fait la reprise par morceaux, l'avancement rangé après chacun. Le temps du travail étant limité, il
 * s'arrête proprement avant la fin de son temps : relancé, il reprend au morceau suivant.
 *
 * La sortie et le résumé du travail ne portent que des nombres [R13]. Une erreur imprévue n'est pas recopiée : son
 * message pourrait citer une donnée ; seuls ses nom et les messages de la reprise et de D1, écrits sans donnée, sortent.
 */
import { appendFileSync } from 'node:fs';
import { LancementReprise, readOnly, type LancementReport } from '@aimmo/core';
import { checkBatch, d1Rest } from './d1-rest.ts';

const ID = /^[0-9a-f-]{36}$/;

export interface RepriseEnv {
  token: string;
  accountId: string;
  aimmoId: string;
  siteId: string;
  minutes: number;
}

export function readEnv(env: Record<string, string | undefined>): RepriseEnv {
  const get = (name: string): string => (env[name] ?? '').trim();
  const out = {
    token: get('CLOUDFLARE_API_TOKEN'),
    accountId: get('CLOUDFLARE_ACCOUNT_ID'),
    aimmoId: get('REPRISE_BASE_AIMMO'),
    siteId: get('REPRISE_BASE_SITE'),
    minutes: Number(get('REPRISE_MINUTES') || '300'),
  };
  if (!out.token || !out.accountId) throw new Error('Reprise : secrets Cloudflare absents (H04).');
  if (!ID.test(out.aimmoId)) throw new Error('Reprise : base aimmo introuvable.');
  if (!ID.test(out.siteId)) throw new Error('Reprise : base espace-estimation introuvable.');
  if (out.aimmoId === out.siteId) throw new Error('Reprise : la base du site et la base aimmo sont la même.');
  if (!Number.isFinite(out.minutes) || out.minutes < 1 || out.minutes > 340) throw new Error('Reprise : durée invalide.');
  return out;
}

/** Le résumé du travail, en nombres seulement. */
export function summary(report: LancementReport): string {
  if (report.state === 'stopped') {
    const why: Record<typeof report.code, string> = {
      no_files: 'aucun fichier déposé',
      missing_files: 'il manque un des trois fichiers',
      several_networks: 'des fichiers déposés pour plusieurs réseaux',
      several_agents: 'les trois fichiers ne confient pas les fiches au même agent',
    };
    return `## Reprise des contacts : rien n'a tourné\n\nRaison : ${why[report.code]}. Aucune fiche n'a été écrite.\n`;
  }
  const lines = ['| Source | Lus | Créées | Retrouvées | Réunies | À part | Exclusions | Lignes illisibles | Lignes à compléter |', '| --- | --- | --- | --- | --- | --- | --- | --- | --- |'];
  for (const [source, t] of Object.entries(report.totals)) {
    if (!t) continue;
    lines.push(`| ${source} | ${t.read} | ${t.created} | ${t.matched} | ${t.merged} | ${t.apart} | ${t.exclusions} | ${t.unreadableLines.join(' ') || '0'} | ${t.partialLines.join(' ') || '0'} |`);
  }
  if (report.state === 'to_continue') {
    return `## Reprise des contacts : à suivre\n\nArrêtée proprement à ${report.source}, position ${report.position}. Relancer le travail : il reprend là.\n\n${lines.join('\n')}\n`;
  }
  const c = report.control;
  return [
    `## Reprise des contacts : ${report.already ? 'déjà faite' : 'faite'}, contrôle ${c.ok ? 'vert' : 'ROUGE'}`,
    '',
    lines.join('\n'),
    '',
    `Contrôle sur ${c.drawn} personnes tirées parmi ${c.population} : ${c.duplicates} doublon(s), ${c.missingExclusions} exclusion(s) manquante(s), ${c.missing} contact(s) introuvable(s), ${c.toAssign} à attribuer par la direction.`,
    '',
  ].join('\n');
}

/** Le message qui peut sortir d'une erreur : ceux de la reprise et de D1, écrits sans donnée ; sinon le nom seul. */
export function safeMessage(error: unknown): string {
  if (error instanceof Error && /^(?:Reprise|D1) : /.test(error.message) && !/@|\d{6,}/.test(error.message)) return error.message;
  return `Erreur ${error instanceof Error ? error.name : 'inconnue'} (détail masqué).`;
}

export async function main(env: Record<string, string | undefined>, out: (text: string) => void): Promise<number> {
  const config = readEnv(env);
  const aimmo = d1Rest({ accountId: config.accountId, databaseId: config.aimmoId, token: config.token });
  const site = readOnly(d1Rest({ accountId: config.accountId, databaseId: config.siteId, token: config.token }));
  await checkBatch(aimmo);
  const deadline = Date.now() + config.minutes * 60_000;
  const report = await new LancementReprise(aimmo, site, { timeLeft: () => Date.now() < deadline }).run();
  out(summary(report));
  if (report.state === 'stopped') return 2;
  if (report.state === 'done' && !report.control.ok) return 1;
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const write = (text: string): void => {
    console.log(text);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, text);
  };
  main(process.env, write).then(
    (code) => process.exit(code),
    (error: unknown) => {
      console.error(safeMessage(error));
      process.exit(1);
    },
  );
}
