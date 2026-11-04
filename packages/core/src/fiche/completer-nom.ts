// SV07 · L'agent complète le nom ou le prénom d'une fiche : un contact venu d'un formulaire n'a que son prénom, et son
// mandat reste incomplet sans son nom. Seul un champ vide se remplit : ce qui est écrit ne s'écrase pas [R17]. Aucun nom au
// journal [R13]. Aucun envoi.
import type { Acces } from '../acces/acces.ts';
import type { Viewer } from '../acces/droits.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';

export type NameRefusal = { ok: false; rule: 'R16' | null; code: string };

const MAX_NAME = 80;
/** Un nom : des lettres, espaces, apostrophes, tirets et points ; ni chiffre ni adresse. */
const NAME = /^\p{L}[\p{L}\p{M} .'’-]*$/u;

function clean(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') return null;
  const text = value.trim().replace(/\s+/g, ' ');
  if (text === '') return undefined;
  return text.length <= MAX_NAME && NAME.test(text) ? text : null;
}

export class CompleterNom {
  private readonly now: () => Date;

  constructor(
    private readonly db: SqlDatabase,
    private readonly acces: Acces,
    private readonly journal: JournalStore,
    options: { now?: () => Date } = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  /** Remplit ce qui est vide sur la fiche, réunie comprise : c'est la fiche survivante que lisent les documents. */
  async complete(viewer: Viewer, personId: string, input: Record<string, unknown>): Promise<{ ok: true; value: { firstName: string | null; lastName: string | null } } | NameRefusal> {
    const actor = `${String(viewer.role)}:${viewer.userId}`;
    if (viewer.role !== 'agent' && viewer.role !== 'direction') {
      await appendEvent(this.journal, { type: 'acces.refuse', actor, subject: `person:${personId}`, data: { rule: 'R16', role: String(viewer.role), kind: 'name', code: 'role' } }, this.now);
      return { ok: false, rule: 'R16', code: 'role' };
    }
    const fiche = await this.acces.readFiche(viewer, personId);
    if (!fiche.ok) return { ok: false, rule: fiche.code === 'unknown' ? null : 'R16', code: fiche.code };
    const first = clean(input.firstName);
    const last = clean(input.lastName);
    if (first === null || last === null) return { ok: false, rule: null, code: 'bad_name' };
    if (first === undefined && last === undefined) return { ok: false, rule: null, code: 'no_name' };

    const person = fiche.value.person;
    // Ce qui est déjà écrit reste : la même valeur redonnée, après une réponse perdue, n'est pas un refus.
    if ((first !== undefined && person.first_name !== null && person.first_name !== first) || (last !== undefined && person.last_name !== null && person.last_name !== last)) {
      return { ok: false, rule: null, code: 'already_named' };
    }
    const at = this.now().toISOString();
    const filled: string[] = [];
    for (const [column, field, value] of [['first_name', 'firstName', first], ['last_name', 'lastName', last]] as const) {
      if (value === undefined) continue;
      const { changes } = await this.db.run(`UPDATE persons SET ${column} = ?, updated_at = ? WHERE id = ? AND ${column} IS NULL`, [value, at, person.id]);
      if (changes === 1) filled.push(field);
    }
    if (filled.length > 0) await appendEvent(this.journal, { type: 'fiche.nom_complete', actor, subject: `person:${person.id}`, data: { rule: 'R16', fields: filled } }, this.now);
    const row = await this.db.first<{ first_name: string | null; last_name: string | null }>('SELECT first_name, last_name FROM persons WHERE id = ?', [person.id]);
    // Deux gestes en même temps : le second voit ce que le premier a écrit, et ne le dit pas fait.
    if ((first !== undefined && row?.first_name !== first) || (last !== undefined && row?.last_name !== last)) return { ok: false, rule: null, code: 'already_named' };
    return { ok: true, value: { firstName: row?.first_name ?? null, lastName: row?.last_name ?? null } };
  }
}
