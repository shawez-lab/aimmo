/**
 * Le statut d'un agent, rangé par la direction comme en vrai (AT03), pour que ses annonces portent leurs mentions
 * d'intervenant (AU007) [R43, R152]. Immatriculation, greffe et titulaire inventés.
 */
import type { Viewer } from '../src/acces/droits.ts';
import { PageAgent } from '../src/attirer/page-agent.ts';
import type { SqlDatabase } from '../src/db/sql.ts';
import type { JournalStore } from '../src/journal/types.ts';

export const TITULAIRE_TEST = 'Réseau Test SAS';

export async function rangerStatut(db: SqlDatabase, journal: JournalStore, now: () => Date, direction: Viewer, agentIds: string[], rsac = '900000001'): Promise<void> {
  const page = new PageAgent(db, journal, { now });
  const holder = await page.setCardHolder(direction, TITULAIRE_TEST);
  if (!holder.ok) throw new Error(`titulaire ${holder.code}`);
  for (const id of agentIds) {
    const r = await page.setLegalMentions(direction, id, { rsacNumber: rsac, rsacRegistry: 'Dijon' });
    if (!r.ok) throw new Error(`statut ${r.code}`);
  }
}
