/**
 * AU044 · Les reprises des notes vocales que le transcripteur n'a pas pu lire [R696, R241].
 *
 * Une note impossible ne devient jamais un texte : elle est rangée illisible, et une tâche de reprise est ouverte pour
 * l'agent. Il en voit la file (canal, raison, date, message illisible lié), écoute l'audio d'origine par la route
 * d'écoute, puis dit la reprise faite ; une reprise faite ne se rouvre pas.
 *
 * Seuls un agent en activité du réseau ou la direction du réseau y accèdent ; un refus est écrit au journal [R16]. La
 * file ne montre jamais la référence de l'audio chez le canal : seule l'écoute la lit, pour aller chercher le fichier.
 * Au journal : l'identifiant de la reprise, le canal et la raison ; jamais la référence, ni un texte [R13].
 */
import type { Viewer } from '../acces/droits.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import type { ImpossibleReason, VoiceAudio, VoiceChannel } from './notes-vocales.ts';

export interface VoiceRecovery {
  id: string;
  channel: VoiceChannel;
  failure: ImpossibleReason;
  /** Le message illisible où le contenu brut de la note est gardé. */
  inboundId: string;
  createdAt: string;
  doneAt: string | null;
}

interface RecoveryRow {
  id: string;
  network_id: string;
  voice_note_id: string;
  inbound_id: string;
  channel: VoiceChannel;
  failure: ImpossibleReason;
  media_ref: string;
  mime: string | null;
  created_at: string;
  done_at: string | null;
  done_by: string | null;
}

export type RecoveryResult<T> = { ok: true; value: T } | { ok: false; status: 403 | 404 | 409; code: 'role' | 'introuvable' | 'deja_faite' };

/** Au plus, par lecture de la file. */
export const RECOVERY_LIST_LIMIT = 100;

const view = (r: RecoveryRow): VoiceRecovery => ({ id: r.id, channel: r.channel, failure: r.failure, inboundId: r.inbound_id, createdAt: r.created_at, doneAt: r.done_at });

export class ReprisesVocales {
  private readonly now: () => Date;
  constructor(
    private readonly db: SqlDatabase,
    private readonly journal: JournalStore,
    options: { now?: () => Date } = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  /** La file : les reprises à faire d'abord, les plus anciennes en tête ; puis les dernières faites. */
  async list(viewer: Viewer): Promise<RecoveryResult<{ open: VoiceRecovery[]; done: VoiceRecovery[] }>> {
    if (!(await this.allowed(viewer, 'liste'))) return { ok: false, status: 403, code: 'role' };
    const open = await this.db.all<RecoveryRow>(
      `SELECT * FROM voice_note_recoveries WHERE network_id = ? AND done_at IS NULL ORDER BY created_at, id LIMIT ${RECOVERY_LIST_LIMIT}`,
      [viewer.networkId],
    );
    const done = await this.db.all<RecoveryRow>(
      `SELECT * FROM voice_note_recoveries WHERE network_id = ? AND done_at IS NOT NULL ORDER BY done_at DESC, id LIMIT 20`,
      [viewer.networkId],
    );
    return { ok: true, value: { open: open.map(view), done: done.map(view) } };
  }

  /** De quoi aller chercher l'audio d'une reprise, pour l'écoute ; l'écoute est écrite au journal, sans la référence [R13]. */
  async audioOf(viewer: Viewer, id: string): Promise<RecoveryResult<VoiceAudio>> {
    if (!(await this.allowed(viewer, 'ecoute'))) return { ok: false, status: 403, code: 'role' };
    const row = await this.find(viewer.networkId, id);
    if (!row) return { ok: false, status: 404, code: 'introuvable' };
    await appendEvent(this.journal, { type: 'voix.reprise_ecoutee', actor: `${viewer.role}:${viewer.userId}`, subject: `voice_recovery:${row.id}`, data: { rule: 'R696', channel: row.channel } }, this.now);
    return { ok: true, value: { channel: row.channel, mediaRef: row.media_ref, mime: row.mime } };
  }

  /** La reprise faite, une fois : elle sort de la file et ne se rouvre pas. */
  async done(viewer: Viewer, id: string): Promise<RecoveryResult<VoiceRecovery>> {
    if (!(await this.allowed(viewer, 'faite'))) return { ok: false, status: 403, code: 'role' };
    const row = await this.find(viewer.networkId, id);
    if (!row) return { ok: false, status: 404, code: 'introuvable' };
    if (row.done_at !== null) return { ok: false, status: 409, code: 'deja_faite' };
    const at = this.now().toISOString();
    const { changes } = await this.db.run('UPDATE voice_note_recoveries SET done_at = ?, done_by = ? WHERE id = ? AND network_id = ? AND done_at IS NULL', [
      at,
      `${viewer.role}:${viewer.userId}`,
      row.id,
      viewer.networkId,
    ]);
    if (changes === 0) return { ok: false, status: 409, code: 'deja_faite' };
    await appendEvent(this.journal, { type: 'voix.reprise_faite', actor: `${viewer.role}:${viewer.userId}`, subject: `voice_recovery:${row.id}`, data: { rule: 'R696', channel: row.channel, failure: row.failure } }, this.now);
    return { ok: true, value: view({ ...row, done_at: at }) };
  }

  private find(networkId: string, id: string): Promise<RecoveryRow | null> {
    return this.db.first<RecoveryRow>('SELECT * FROM voice_note_recoveries WHERE id = ? AND network_id = ?', [id, networkId]);
  }

  /** Un agent en activité du réseau, ou la direction ; tout autre rôle est refusé, au journal [R16]. */
  private async allowed(viewer: Viewer, action: string): Promise<boolean> {
    let ok = false;
    if (viewer.role === 'direction') ok = true;
    else if (viewer.role === 'agent') ok = (await this.db.first("SELECT 1 FROM agents WHERE id = ? AND network_id = ? AND status = 'active'", [viewer.userId, viewer.networkId])) !== null;
    if (!ok) {
      await appendEvent(this.journal, { type: 'acces.refuse', actor: `${String(viewer.role)}:${viewer.userId}`, subject: null, data: { rule: 'R16', role: String(viewer.role), kind: 'voice_recovery', action } }, this.now);
    }
    return ok;
  }
}
