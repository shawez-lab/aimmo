/**
 * L'agent qui lit ou agit dans M20 complet doit être en activité ce jour-là, et son dossier d'agent complet [R86, R82,
 * R16] : un agent parti, même le jour de son départ avant le passage du planificateur, ou au dossier incomplet, ne lit
 * aucune donnée de client. Les mêmes règles que l'accès aux fiches (`acces.ts`), lues par `agentState`.
 */
import type { Viewer } from '../../acces/droits.ts';
import { agentState } from '../../acces/etat-agent.ts';
import type { SqlDatabase } from '../../db/sql.ts';

/** Le code du refus, ou `null` si l'agent peut travailler ; un autre rôle n'est pas concerné. */
export async function agentBlocked(db: SqlDatabase, viewer: Viewer, at: Date): Promise<'agent_inactive' | 'agent_file_incomplete' | null> {
  if (viewer.role !== 'agent') return null;
  const agent = await db.first<{ status: string }>('SELECT status FROM agents WHERE id = ? AND network_id = ?', [viewer.userId, viewer.networkId]);
  if (!agent || agent.status !== 'active') return 'agent_inactive';
  const state = await agentState(db, viewer.networkId, viewer.userId, at);
  if (state === 'parti') return 'agent_inactive';
  if (state === 'dossier_incomplet') return 'agent_file_incomplete';
  return null;
}
