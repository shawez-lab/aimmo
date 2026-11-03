/**
 * « Test de restauration » (SV03), lancé chaque mois par le travail GitHub du même nom [R232]. Restaure la dernière copie
 * dans une base en mémoire, jamais en production, et range le reçu dans la base `aimmo`. La sortie ne porte qu'un
 * résultat, des nombres et un code. Le code de sortie n'est 0 que si le test a réussi et que son reçu est rangé.
 */
import { appendFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fromSyncSqlite, recordRestoreReceipt, runRestoreTest, type MonthlyRestoreInput, type RestoreReceipt, type SyncSqlite } from '@aimmo/core';
import { storeFromEnv } from './copie-nuit.ts';
import { d1Rest } from './d1-rest.ts';

const ID = /^[0-9a-f-]{36}$/;

export const receiptLine = (r: RestoreReceipt): string =>
  r.outcome === 'reussie' ? `Restauration réussie : ${r.tables} tables, ${r.rows} lignes, ${r.durationMs} ms.` : `Restauration ratée : ${r.reason}.`;

/** Le test et son reçu. Un reçu non rangé fait échouer le travail : l'écran dira « manquant ». */
export async function monthlyTest(input: MonthlyRestoreInput, record: (r: RestoreReceipt) => Promise<void>, out: (text: string) => void): Promise<number> {
  const receipt = await runRestoreTest(input);
  out(receiptLine(receipt));
  try {
    await record(receipt);
  } catch {
    out('Reçu non rangé : la direction lira « manquant ».');
    return 1;
  }
  return receipt.outcome === 'reussie' ? 0 : 1;
}

async function main(env: Record<string, string | undefined>, out: (text: string) => void): Promise<number> {
  const token = (env['CLOUDFLARE_API_TOKEN'] ?? '').trim();
  const accountId = (env['CLOUDFLARE_ACCOUNT_ID'] ?? '').trim();
  const databaseId = (env['COPIE_BASE_AIMMO'] ?? '').trim();
  if (!token || !accountId || !ID.test(databaseId)) {
    out('Test non fait : le travail est mal réglé, et aucun reçu ne peut être rangé.');
    return 1;
  }
  const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as { DatabaseSync: new (path: string) => SyncSqlite };
  const aimmo = d1Rest({ accountId, databaseId, token });
  return monthlyTest(
    { db: aimmo, secret: (env['COPY_KEY'] ?? '').trim(), store: storeFromEnv(env), fresh: () => fromSyncSqlite(new DatabaseSync(':memory:')) },
    (r) => recordRestoreReceipt(aimmo, r),
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
      console.error('Test non fait : erreur imprévue, non recopiée.');
      process.exit(1);
    },
  );
}
