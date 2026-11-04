// R19 · Les mots du nom des vendeurs d'un bien, à interdire dans un message à un client : toutes les fiches réunies du
// vendeur comprises, car le nom peut être écrit sur la fiche survivante et le projet rester sur une autre.
import type { SqlDatabase } from '../db/sql.ts';
import { nameWords } from '../visites/compte-rendu.ts';
import type { FicheUnique } from './fusion.ts';

export async function sellerNameWords(db: SqlDatabase, unique: FicheUnique, propertyId: string, recipientMembers: readonly string[] = []): Promise<string[]> {
  const owners = await db.all<{ person_id: string }>("SELECT DISTINCT pr.person_id FROM project_properties pp JOIN projects pr ON pr.id = pp.project_id WHERE pp.property_id = ? AND pp.role = 'owned'", [propertyId]);
  const members = [...new Set((await Promise.all(owners.map((o) => unique.membersOf(o.person_id)))).flat())].filter((m) => !recipientMembers.includes(m));
  if (members.length === 0) return [];
  const rows = await db.all<{ first_name: string | null; last_name: string | null }>(`SELECT first_name, last_name FROM person_known_names WHERE id IN (${members.map(() => '?').join(', ')})`, members);
  return [...new Set(rows.flatMap((r) => [r.first_name, r.last_name]).filter((n): n is string => !!n).flatMap(nameWords))];
}
