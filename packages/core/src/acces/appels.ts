/**
 * L'agent note un appel de prospection et, s'il y a lieu, le refus de la personne (AC09) [R204, R13, R16, R17].
 *
 * Le bouton d'appel compte ces notes (`FicheAgent`). L'heure est celle du serveur, et ce qui ouvrait l'appel à ce moment-là
 * est fixé ici, jamais par l'écran. Deux notes identiques à moins d'une minute n'en font qu'une : un double geste ne doit
 * pas fermer l'appel plus tôt. Noter reste possible quand le bouton est fermé : un fait se note, il n'ouvre rien.
 * Un refus n'est pas un arrêt : l'arrêt demandé par la personne se note comme arrêt, et ferme tout [R04].
 */
import type { SqlDatabase } from '../db/sql.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import type { Acces } from './acces.ts';
import type { AccordsResult } from './accords.ts';
import type { Viewer } from './droits.ts';
import { isCallRequest, usableCallConsents, type CallNote } from './fiche-agent.ts';

const OUTCOMES: readonly string[] = Object.freeze(['called', 'refused']);
const SAME_NOTE_MS = 60_000;
const placeholders = (n: number): string => Array.from({ length: n }, () => '?').join(', ');

export class AppelsFiche {
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(
    private readonly db: SqlDatabase,
    private readonly acces: Acces,
    private readonly journal: JournalStore,
    options: { now?: () => Date; newId?: () => string } = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => crypto.randomUUID());
  }

  async note(viewer: Viewer, personId: string, input: { outcome?: unknown }): Promise<AccordsResult<{ noteId: string; notedAt: string; already: boolean }>> {
    if (viewer.role !== 'agent' && viewer.role !== 'direction') return { ok: false, rule: 'R16', code: 'role' };
    const { outcome } = input;
    if (typeof outcome !== 'string' || !OUTCOMES.includes(outcome)) return { ok: false, rule: 'R204', code: 'bad_outcome' };
    const read = await this.acces.readFiche(viewer, personId);
    if (!read.ok) return { ok: false, rule: 'R16', code: read.code };
    const fiche = read.value;
    const ids = fiche.members.map((m) => m.id);
    const at = this.now();
    const notes = await this.db.all<CallNote & { id: string }>(`SELECT id, outcome, basis, noted_at FROM call_notes WHERE person_id IN (${placeholders(ids.length)})`, ids);
    const same = notes.find((n) => n.outcome === outcome && Math.abs(at.getTime() - Date.parse(n.noted_at)) < SAME_NOTE_MS);
    if (same) return { ok: true, value: { noteId: same.id, notedAt: same.noted_at, already: true } };

    const basis = usableCallConsents(fiche, notes, at.getTime()).some(isCallRequest) ? 'request' : 'prospecting';
    const id = this.newId();
    const root = fiche.person.id;
    await this.db.run('INSERT INTO call_notes (id, network_id, person_id, outcome, basis, noted_by, noted_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [id, viewer.networkId, root, outcome, basis, `${viewer.role}:${viewer.userId}`, at.toISOString()]);
    await appendEvent(this.journal, { type: 'fiche.appel_note', actor: `${viewer.role}:${viewer.userId}`, subject: `person:${root}`, data: { rule: 'R204', outcome, basis, note: id } }, this.now);
    return { ok: true, value: { noteId: id, notedAt: at.toISOString(), already: false } };
  }
}
