// SV10 · La direction corrige le prénom ou le nom d'une fiche, avec un motif en liste fermée. La valeur d'avant reste lisible par
// elle dans `person_name_corrections` [R17], jamais au journal [R13]. Les documents déjà générés gardent leur texte. Aucun envoi.
import type { Acces } from '../acces/acces.ts';
import type { Viewer } from '../acces/droits.ts';
import { runBatch, type SqlDatabase } from '../db/sql.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import { cleanName, type NameRefusal } from './completer-nom.ts';

export const NAME_CORRECTION_REASONS = ['faute_de_frappe', 'nom_dans_prenom', 'demande_de_la_personne', 'etat_civil'] as const;
export type NameCorrectionReason = (typeof NAME_CORRECTION_REASONS)[number];

export interface NameCorrection {
  id: string;
  oldFirstName: string | null;
  oldLastName: string | null;
  newFirstName: string | null;
  newLastName: string | null;
  reason: NameCorrectionReason;
  actor: string;
  at: string;
}

interface Row {
  id: string;
  old_first_name: string | null;
  old_last_name: string | null;
  new_first_name: string | null;
  new_last_name: string | null;
  reason: NameCorrectionReason;
  actor: string;
  created_at: string;
}

const FIELDS: readonly string[] = ['firstName', 'lastName', 'reason'];
const SELECT = 'SELECT id, old_first_name, old_last_name, new_first_name, new_last_name, reason, actor, created_at FROM person_name_corrections';

/** Le champ demandé : `undefined` s'il n'est pas donné, `null` s'il est vidé, `false` s'il n'est pas un nom. */
function given(input: Record<string, unknown>, key: string): string | null | undefined | false {
  if (!(key in input)) return undefined;
  const value = input[key];
  if (value !== null && typeof value !== 'string') return false;
  const text = cleanName(value);
  return text === null ? false : (text ?? null);
}

export class CorrigerNom {
  private readonly now: () => Date;

  constructor(
    private readonly db: SqlDatabase,
    private readonly acces: Acces,
    private readonly journal: JournalStore,
    options: { now?: () => Date } = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  private async guard(viewer: Viewer, personId: string) {
    if (viewer.role !== 'direction') {
      await appendEvent(this.journal, { type: 'acces.refuse', actor: `${String(viewer.role)}:${viewer.userId}`, subject: `person:${personId}`, data: { rule: 'R16', role: String(viewer.role), kind: 'name_correction', code: 'role' } }, this.now);
      return { ok: false as const, rule: 'R16' as const, code: 'role' };
    }
    const fiche = await this.acces.readFiche(viewer, personId);
    if (!fiche.ok) return { ok: false as const, rule: fiche.code === 'unknown' ? null : ('R16' as const), code: fiche.code };
    return fiche;
  }

  /** Les corrections de la fiche, fiches réunies comprises, de la plus récente à la plus ancienne. */
  async list(viewer: Viewer, personId: string): Promise<{ ok: true; value: NameCorrection[] } | NameRefusal> {
    const fiche = await this.guard(viewer, personId);
    if (!fiche.ok) return fiche;
    const ids = fiche.value.members.map((m) => m.id);
    const rows = await this.db.all<Row>(`${SELECT} WHERE network_id = ? AND person_id IN (${ids.map(() => '?').join(', ')}) ORDER BY created_at DESC, rowid DESC`, [viewer.networkId, ...ids]);
    return {
      ok: true,
      value: rows.map((r) => ({ id: r.id, oldFirstName: r.old_first_name, oldLastName: r.old_last_name, newFirstName: r.new_first_name, newLastName: r.new_last_name, reason: r.reason, actor: r.actor, at: r.created_at })),
    };
  }

  /**
   * Corrige sur la fiche survivante, celle que lisent les documents. Un champ absent ne change pas, un champ vide ou nul se vide.
   * `input` nul : un corps illisible, dit seulement après le contrôle des droits.
   */
  async correct(viewer: Viewer, personId: string, input: Record<string, unknown> | null): Promise<{ ok: true; value: { firstName: string | null; lastName: string | null; changed: boolean } } | NameRefusal> {
    const fiche = await this.guard(viewer, personId);
    if (!fiche.ok) return fiche;
    if (!input) return { ok: false, rule: null, code: 'invalid_body' };
    if (Object.keys(input).some((k) => !FIELDS.includes(k))) return { ok: false, rule: null, code: 'unexpected_field' };
    const reason = input.reason as NameCorrectionReason;
    if (!NAME_CORRECTION_REASONS.includes(reason)) return { ok: false, rule: null, code: 'bad_reason' };
    const first = given(input, 'firstName');
    const last = given(input, 'lastName');
    if (first === false || last === false) return { ok: false, rule: null, code: 'bad_name' };
    if (first === undefined && last === undefined) return { ok: false, rule: null, code: 'no_name' };

    const { person, members } = fiche.value;
    const others = members.filter((m) => m.id !== person.id);
    const oldFirst = person.first_name ?? others.find((m) => m.first_name)?.first_name ?? null;
    const oldLast = person.last_name ?? others.find((m) => m.last_name)?.last_name ?? null;
    const newFirst = first === undefined ? oldFirst : first;
    const newLast = last === undefined ? oldLast : last;
    if (newFirst === null && newLast === null) return { ok: false, rule: null, code: 'name_required' };
    // Vidé ici, le nom d'une fiche réunie reviendrait à l'écran : le geste ne ferait pas ce qu'il dit.
    if ((newFirst === null && others.some((m) => m.first_name)) || (newLast === null && others.some((m) => m.last_name))) return { ok: false, rule: null, code: 'name_on_merged_fiche' };

    if (newFirst === oldFirst && newLast === oldLast) {
      // Rien à changer, ou la réponse d'avant s'est perdue : la ligne du journal qu'une panne aurait fait manquer s'écrit ici.
      await this.note(person.id, viewer.networkId);
      return { ok: true, value: { firstName: newFirst, lastName: newLast, changed: false } };
    }
    const nextFirst = first === undefined ? person.first_name : first;
    const nextLast = last === undefined ? person.last_name : last;
    const at = this.now().toISOString();
    const same = 'id = ? AND first_name IS ? AND last_name IS ?';
    const where = [person.id, person.first_name, person.last_name];
    // Tout ou rien : un nom n'est jamais changé sans sa valeur d'avant, et deux corrections croisées ne se mêlent pas.
    const [saved, updated] = await runBatch(this.db, [
      {
        sql: `INSERT INTO person_name_corrections (id, network_id, person_id, old_first_name, old_last_name, new_first_name, new_last_name, reason, actor, created_at)
              SELECT ?, network_id, id, ?, ?, ?, ?, ?, ?, ? FROM persons WHERE ${same}`,
        params: [crypto.randomUUID(), oldFirst, oldLast, newFirst, newLast, reason, `direction:${viewer.userId}`, at, ...where],
      },
      { sql: `UPDATE persons SET first_name = ?, last_name = ?, updated_at = ? WHERE ${same}`, params: [nextFirst, nextLast, at, ...where] },
    ]);
    if (saved?.changes !== 1 || updated?.changes !== 1) return { ok: false, rule: null, code: 'name_changed' };
    await this.note(person.id, viewer.networkId);
    return { ok: true, value: { firstName: newFirst, lastName: newLast, changed: true } };
  }

  /** Une ligne au journal par correction, sans aucun nom [R13] : ni avant, ni après. */
  private async note(personId: string, networkId: string): Promise<void> {
    const rows = await this.db.all<Row>(`${SELECT} WHERE network_id = ? AND person_id = ? ORDER BY created_at, rowid`, [networkId, personId]);
    if (rows.length === 0) return;
    const noted = new Set((await this.journal.bySubject(`person:${personId}`)).filter((e) => e.type === 'fiche.nom_corrige').map((e) => e.data.correctionId));
    for (const r of rows) {
      if (noted.has(r.id)) continue;
      const fields = [...(r.old_first_name !== r.new_first_name ? ['firstName'] : []), ...(r.old_last_name !== r.new_last_name ? ['lastName'] : [])];
      await appendEvent(this.journal, { type: 'fiche.nom_corrige', actor: r.actor, subject: `person:${personId}`, data: { rule: 'R16', correctionId: r.id, reason: r.reason, fields } }, this.now);
    }
  }
}
