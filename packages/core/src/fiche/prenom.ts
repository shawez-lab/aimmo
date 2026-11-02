import type { SqlDatabase } from '../db/sql.ts';

const marks = (n: number): string => Array.from({ length: n }, () => '?').join(', ');

/**
 * Le prénom d'une fiche réunie, dans l'ordre de `FicheUnique.membersOf` : celui de la fiche gardée, sinon celui du premier
 * doublon qui en a un, toujours le même. C'est l'ordre que suit le contrôle central pour vérifier le texte : un autre
 * prénom ferait refuser le message pour de bon [R08].
 */
export async function ficheFirstName(db: SqlDatabase, members: readonly string[]): Promise<string | null> {
  if (members.length === 0) return null;
  const rows = await db.all<{ id: string; first_name: string | null }>(`SELECT id, first_name FROM persons WHERE id IN (${marks(members.length)})`, [...members]);
  const byId = new Map(rows.map((r) => [r.id, r.first_name]));
  return members.map((id) => byId.get(id)).find((n) => n) ?? null;
}
