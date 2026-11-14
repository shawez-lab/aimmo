/**
 * « Parcours du mois », second travail (BR72) : range dans la base `aimmo` le reçu du parcours complet fictif joué par
 * le premier travail, sans secret ni base (SV04). Il ne lit que deux mots du premier travail : son résultat et l'étape
 * qu'il a dite. La sortie ne porte que le résultat et l'étape. Le code de sortie n'est 0 que si le reçu est rangé.
 */
import { appendFileSync } from 'node:fs';
import { journeyReceipt, recordJourneyReceipt, type JourneyReceipt } from '@aimmo/core';
import { d1Rest } from './d1-rest.ts';

const ID = /^[0-9a-f-]{36}$/;

export const journeyLine = (r: JourneyReceipt): string =>
  r.outcome === 'reussi' ? 'Parcours du mois réussi : toutes les étapes ont passé.' : `Parcours du mois raté${r.step ? ` à l'étape ${r.step}` : ', étape inconnue'}.`;

/** Le reçu et son rangement. Un reçu non rangé fait échouer le travail : l'écran dira « manquant ». */
export async function recordJourney(input: { jobResult: string; said: string; now: Date; id: string }, record: (r: JourneyReceipt) => Promise<void>, out: (text: string) => void): Promise<number> {
  const receipt = journeyReceipt({ id: input.id, ranAt: input.now, jobResult: input.jobResult, said: input.said });
  out(journeyLine(receipt));
  try {
    await record(receipt);
  } catch {
    out('Reçu non rangé : la direction lira « manquant ».');
    return 1;
  }
  return 0;
}

async function main(env: Record<string, string | undefined>, out: (text: string) => void): Promise<number> {
  const token = (env['CLOUDFLARE_API_TOKEN'] ?? '').trim();
  const accountId = (env['CLOUDFLARE_ACCOUNT_ID'] ?? '').trim();
  const databaseId = (env['PARCOURS_BASE_AIMMO'] ?? '').trim();
  if (!token || !accountId || !ID.test(databaseId)) {
    out('Reçu non rangé : le travail est mal réglé.');
    return 1;
  }
  const aimmo = d1Rest({ accountId, databaseId, token });
  return recordJourney(
    { jobResult: env['PARCOURS_RESULTAT'] ?? '', said: env['PARCOURS_ETAPE'] ?? '', now: new Date(), id: crypto.randomUUID() },
    (r) => recordJourneyReceipt(aimmo, r),
    out,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const write = (text: string): void => {
    console.log(text);
    if (process.env['GITHUB_STEP_SUMMARY']) appendFileSync(process.env['GITHUB_STEP_SUMMARY'], `${text}\n`);
  };
  main(process.env, write).then(
    (code) => process.exit(code),
    () => {
      console.error('Reçu non rangé : erreur imprévue, non recopiée.');
      process.exit(1);
    },
  );
}
