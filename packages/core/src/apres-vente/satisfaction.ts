/**
 * Satisfaction : note et commentaire rangés pour M13 (M11, F05) [R13, R16, R64].
 *
 * La demande d'avis (F02) porte, quand l'adresse en est réglée, un lien à usage unique : le client y donne une note de
 * 1 à 5 et, s'il le veut, un commentaire. La réponse est rangée avec le dossier, pour M13 ; l'agent la voit. Elle ne
 * change jamais qui reçoit une demande d'avis : rien dans F02 ne la lit [R64]. Le commentaire n'est jamais publié ni
 * envoyé comme avis : aucun code n'en fait un message ; il ne va jamais au journal [R13].
 *
 * Décidé, lecture prudente : le lien expire 30 jours après la demande ; une seule réponse par client et par dossier,
 * même si plusieurs liens ont été tirés ; une réponse ne se corrige pas, elle reste telle que donnée.
 */
import type { Viewer } from '../acces/droits.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import { viewerRefusal } from './lecteur.ts';
import { checkAfterSaleUnsubscribeBase, newAfterSaleToken } from './relances-apres-vente.ts';

export const SATISFACTION_LINK_DAYS = 30;
export const SATISFACTION_COMMENT_MAX = 1000;

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Le début du lien de satisfaction : https, sans chiffre [R10], terminé par « / ». */
export const checkSatisfactionBase = checkAfterSaleUnsubscribeBase;

/** Un lien de satisfaction neuf pour ce client et ce dossier, rangé par l'empreinte de son jeton seulement. */
export async function newSatisfactionLink(db: SqlDatabase, base: string, input: { networkId: string; fileId: string; personId: string; agentId: string }, at: Date): Promise<string> {
  const token = newAfterSaleToken();
  await db.run('INSERT INTO satisfaction_tokens (token_hash, network_id, file_id, person_id, agent_id, created_at, expires_at, used_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)', [
    await sha256(token),
    input.networkId,
    input.fileId,
    input.personId,
    input.agentId,
    at.toISOString(),
    new Date(at.getTime() + SATISFACTION_LINK_DAYS * 86_400_000).toISOString(),
  ]);
  return `${base}${token}`;
}

export interface SatisfactionAnswer {
  fileId: string;
  personId: string;
  score: number;
  comment: string | null;
  answeredAt: string;
}

export type SatisfactionOutcome = { ok: true } | { ok: false; code: 'unknown' | 'used' | 'expired' | 'invalid_score' | 'invalid_comment' };

export class Satisfaction {
  private readonly now: () => Date;

  constructor(
    private readonly db: SqlDatabase,
    private readonly journal: JournalStore,
    options: { now?: () => Date } = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  /** La réponse du client, par son lien : une seule fois, avant l'expiration. */
  async submit(token: string, input: { score: number; comment?: string | null }): Promise<SatisfactionOutcome> {
    if (typeof token !== 'string' || !/^[a-z]{32}$/.test(token)) return { ok: false, code: 'unknown' };
    const row = await this.db.first<{ token_hash: string; network_id: string; file_id: string; person_id: string; agent_id: string; expires_at: string; used_at: string | null }>(
      'SELECT token_hash, network_id, file_id, person_id, agent_id, expires_at, used_at FROM satisfaction_tokens WHERE token_hash = ?',
      [await sha256(token)],
    );
    if (!row) return { ok: false, code: 'unknown' };
    if (row.used_at) return { ok: false, code: 'used' };
    const at = this.now();
    if (at.getTime() >= Date.parse(row.expires_at)) return { ok: false, code: 'expired' };
    if (!Number.isInteger(input.score) || input.score < 1 || input.score > 5) return { ok: false, code: 'invalid_score' };
    const raw = input.comment ?? null;
    if (raw !== null && typeof raw !== 'string') return { ok: false, code: 'invalid_comment' };
    const comment = raw === null || raw.trim() === '' ? null : raw.trim();
    // Ni caractère de contrôle, hors retour à la ligne et tabulation, ni plus de 1 000 caractères.
    if (comment !== null && (comment.length > SATISFACTION_COMMENT_MAX || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(comment))) return { ok: false, code: 'invalid_comment' };
    // La réponse d'abord : si elle ne peut pas être rangée, le lien n'est pas consommé et le client peut réessayer.
    // Une seule réponse par client et par dossier : deux envois simultanés n'en rangent qu'une.
    const inserted = await this.db.run(
      'INSERT INTO satisfaction_answers (file_id, person_id, network_id, agent_id, score, comment, answered_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING',
      [row.file_id, row.person_id, row.network_id, row.agent_id, input.score, comment, at.toISOString()],
    );
    await this.db.run('UPDATE satisfaction_tokens SET used_at = ? WHERE token_hash = ? AND used_at IS NULL', [at.toISOString(), row.token_hash]);
    if (inserted.changes !== 1) return { ok: false, code: 'used' };
    // Au journal : le dossier et la note, jamais le commentaire [R13].
    await appendEvent(this.journal, { type: 'apres_vente.satisfaction', actor: 'client:lien', subject: `sale_file:${row.file_id}`, data: { score: input.score, comment: comment !== null } }, this.now);
    return { ok: true };
  }

  /** Les réponses : un agent voit celles de ses dossiers, la direction et la conformité celles du réseau [R16]. */
  async list(viewer: Viewer): Promise<{ ok: true; value: SatisfactionAnswer[] } | { ok: false; rule: 'R16'; code: string }> {
    const refusal = (await viewerRefusal(this.db, viewer)) ?? (viewer.role !== 'agent' && viewer.role !== 'direction' && viewer.role !== 'compliance' ? 'role' : null);
    if (refusal) {
      await appendEvent(this.journal, { type: 'acces.refuse', actor: `${String(viewer.role)}:${viewer.userId}`, subject: `network:${viewer.networkId}`, data: { rule: 'R16', role: String(viewer.role), kind: 'satisfaction', code: refusal } }, this.now);
      return { ok: false, rule: 'R16', code: refusal };
    }
    const own = viewer.role === 'agent';
    const rows = await this.db.all<{ file_id: string; person_id: string; score: number; comment: string | null; answered_at: string }>(
      `SELECT file_id, person_id, score, comment, answered_at FROM satisfaction_answers WHERE network_id = ?${own ? ' AND agent_id = ?' : ''} ORDER BY answered_at, file_id, person_id`,
      own ? [viewer.networkId, viewer.userId] : [viewer.networkId],
    );
    await appendEvent(this.journal, { type: 'apres_vente.lecture', actor: `${String(viewer.role)}:${viewer.userId}`, subject: `network:${viewer.networkId}`, data: { kind: 'satisfaction', count: rows.length } }, this.now);
    return { ok: true, value: rows.map((r) => ({ fileId: r.file_id, personId: r.person_id, score: r.score, comment: r.comment, answeredAt: r.answered_at })) };
  }
}
