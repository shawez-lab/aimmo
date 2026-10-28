/**
 * L'état d'un agent pour les droits d'accès et le contrôle des envois (J13) [R82, R86, R16].
 *
 * - `parti` : l'agent n'est plus en activité, ou le jour de son départ est venu à Paris, dès minuit, même avant le
 *   passage du planificateur (`agentGone`, lu aussi par `Departs.isGone`). Plus aucune lecture ni écriture, et rien de ce qu'il avait préparé ne
 *   part plus.
 * - `dossier_incomplet` : l'agent a un dossier d'agent (entré par M14, ou une pièce déjà rangée) qui n'est pas complet
 *   et valide ce jour-là (`agentFileStatus`) : aucune fiche client, aucun bien hors du fichier commun.
 * - `actif` : sinon.
 *
 * Décidé, lecture prudente pour la preuve à Dijon : un agent sans aucun dossier, créé hors de M14 (les agents de
 * l'agence, sous sa carte professionnelle), garde ses droits d'agent actif. Dès qu'un agent entre par M14 ou qu'une
 * pièce de son dossier est rangée, la règle s'applique à lui pour toujours : une pièce ne s'efface jamais [R17].
 */
import type { SqlDatabase } from '../db/sql.ts';
import { localTime } from '../envoi/horaires.ts';
import { agentGone } from '../reseau/depart.ts';
import { agentFileStatus } from '../reseau/etat-dossier.ts';

export type AgentState = 'parti' | 'dossier_incomplet' | 'actif';

/** L'agent a-t-il un dossier d'agent : entré par M14, ou une pièce rangée ? */
export async function hasAgentFile(db: SqlDatabase, agentId: string): Promise<boolean> {
  const row = await db.first<{ n: number }>(
    'SELECT (SELECT count(*) FROM agent_onboardings WHERE agent_id = ?) + (SELECT count(*) FROM agent_file_pieces WHERE agent_id = ?) AS n',
    [agentId, agentId],
  );
  return Number(row?.n ?? 0) > 0;
}

export async function agentState(db: SqlDatabase, networkId: string, agentId: string, at: Date): Promise<AgentState> {
  if (await agentGone(db, networkId, agentId, at)) return 'parti';
  if (!(await hasAgentFile(db, agentId))) return 'actif';
  const status = await agentFileStatus(db, agentId, localTime(at, 'Europe/Paris').date);
  return status.complete ? 'actif' : 'dossier_incomplet';
}
