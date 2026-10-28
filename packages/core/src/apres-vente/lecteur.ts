/**
 * Le lecteur des écrans après la vente (M11) [R16] : un rôle connu ; pour un agent, un agent de ce réseau, encore actif.
 * Un agent parti n'ouvre plus rien, comme le veut le contrôle d'accès du socle.
 */
import { ROLES, type Viewer } from '../acces/droits.ts';
import type { SqlDatabase } from '../db/sql.ts';

export async function viewerRefusal(db: SqlDatabase, viewer: Viewer): Promise<'role' | 'agent_inactive' | null> {
  if (!(ROLES as readonly string[]).includes(viewer.role)) return 'role';
  if (viewer.role !== 'agent') return null;
  const agent = await db.first<{ network_id: string; status: string }>('SELECT network_id, status FROM agents WHERE id = ?', [viewer.userId]);
  if (!agent || agent.network_id !== viewer.networkId || agent.status !== 'active') return 'agent_inactive';
  return null;
}
