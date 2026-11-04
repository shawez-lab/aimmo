// SV07 · L'agent complète le nom ou le prénom d'une fiche : un contact venu d'un formulaire n'a que son prénom, et son
// mandat reste incomplet sans son nom. Seul un champ vide se remplit : ce qui est écrit ne s'écrase pas [R17], sauf un nom rangé par erreur dans le prénom, qui en sort. Aucun nom au
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

export function cleanName(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') return null;
  const text = value.trim().replace(/\s+/g, ' ');
  if (text === '') return undefined;
  return text.length <= MAX_NAME && NAME.test(text) ? text : null;
}

/**
 * Le prénom sans le nom donné, s'il le contient à la fin ; `undefined` s'il ne le contient pas ; `null` si le prénom n'est
 * que ce nom : rien ne resterait.
 */
function withoutLastName(firstName: string | null, lastName: string): string | null | undefined {
  if (firstName === null) return undefined;
  const a = firstName.trim().toLocaleLowerCase('fr');
  const b = lastName.toLocaleLowerCase('fr');
  if (a === b) return null;
  return a.endsWith(` ${b}`) ? firstName.trim().slice(0, -b.length).trim() : undefined;
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
    const first = cleanName(input.firstName);
    const last = cleanName(input.lastName);
    if (first === null || last === null) return { ok: false, rule: null, code: 'bad_name' };
    if (first === undefined && last === undefined) return { ok: false, rule: null, code: 'no_name' };

    const person = fiche.value.person;
    // Le nom en vigueur : celui de la fiche survivante, sinon celui d'une fiche réunie, que le résumé montre aussi.
    const namedFirst = person.first_name ?? fiche.value.members.find((m) => m.first_name)?.first_name ?? null;
    const namedLast = person.last_name ?? fiche.value.members.find((m) => m.last_name)?.last_name ?? null;
    // Un mail signé « Jean Dupont » range tout en prénom : le nom donné se retire du prénom, plutôt que de doubler.
    const split = last !== undefined && first === undefined && namedLast === null ? withoutLastName(namedFirst, last) : undefined;
    if (split === null) return { ok: false, rule: null, code: 'name_in_first_name' };
    // Ce qui est déjà écrit reste : la même valeur redonnée, après une réponse perdue, n'est pas un refus.
    if ((first !== undefined && namedFirst !== null && namedFirst !== first) || (last !== undefined && namedLast !== null && namedLast !== last)) {
      return { ok: false, rule: null, code: 'already_named' };
    }
    const nextFirst = split ?? first ?? null;
    const nextLast = last ?? null;
    // Une seule écriture : deux gestes croisés ne mêlent jamais deux identités, et une panne n'en laisse pas la moitié.
    const { changes } = split
      ? await this.db.run('UPDATE persons SET first_name = ?, last_name = ?, updated_at = ? WHERE id = ? AND first_name = ? AND last_name IS NULL', [split, nextLast, this.now().toISOString(), person.id, namedFirst])
      : await this.db.run(
          `UPDATE persons SET first_name = COALESCE(first_name, ?), last_name = COALESCE(last_name, ?), updated_at = ?
            WHERE id = ? AND (? IS NULL OR first_name IS NULL OR first_name = ?) AND (? IS NULL OR last_name IS NULL OR last_name = ?)`,
          [nextFirst, nextLast, this.now().toISOString(), person.id, nextFirst, nextFirst, nextLast, nextLast],
        );
    const row = await this.db.first<{ first_name: string | null; last_name: string | null }>('SELECT first_name, last_name FROM persons WHERE id = ?', [person.id]);
    // Un autre geste a écrit autre chose entre-temps : il garde sa valeur, et celui-ci ne se dit pas fait.
    if (changes !== 1 || (nextFirst !== null && row?.first_name !== nextFirst) || (nextLast !== null && row?.last_name !== nextLast)) return { ok: false, rule: null, code: 'already_named' };
    // La ligne du journal, écrite une fois : un nouvel essai écrit celle qu'une panne aurait fait manquer [R13].
    const given = [...(first !== undefined || split ? ['firstName'] : []), ...(last !== undefined ? ['lastName'] : [])];
    // Après une correction de la direction (SV10), un champ vidé puis rempli de nouveau compte comme un nouveau geste.
    const events = await this.journal.bySubject(`person:${person.id}`);
    const since = events.slice(events.map((e) => e.type).lastIndexOf('fiche.nom_corrige') + 1);
    const noted = new Set(since.filter((e) => e.type === 'fiche.nom_complete').flatMap((e) => e.data.fields as string[]));
    const fields = given.filter((f) => !noted.has(f));
    if (fields.length > 0) await appendEvent(this.journal, { type: 'fiche.nom_complete', actor, subject: `person:${person.id}`, data: { rule: 'R16', fields } }, this.now);
    return { ok: true, value: { firstName: row?.first_name ?? null, lastName: row?.last_name ?? null } };
  }
}
