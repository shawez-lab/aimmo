/**
 * AU089 · Le dispositif anti-blanchiment du réseau (M12) [R16, R17, R94].
 *
 * La direction nomme le responsable de la conformité (un utilisateur au rôle `compliance`) et range la procédure écrite
 * approuvée : sa version, la référence du document et son empreinte, qui l'a approuvée (l'avocat) et le jour. La
 * dernière nomination et la dernière version valent ; rien ne change ni ne s'efface.
 *
 * Tant qu'aucun responsable n'est nommé, personne ne lit les signalements ; tant qu'aucune procédure n'est approuvée,
 * le responsable lit mais ne décide pas de la déclaration à Tracfin. La nomination réelle et la validation par l'avocat
 * restent à faire (H29) : le code tient la porte, il ne fait pas la nomination.
 */
import type { Viewer } from '../acces/droits.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';

const USER_ID = /^[A-Za-z0-9_-]{1,64}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const HEX64 = /^[0-9a-f]{64}$/;

export interface LcbSetup {
  officer: { userId: string; designatedAt: string } | null;
  procedure: { version: number; documentRef: string; documentSha256: string; approvedBy: string; approvedOn: string } | null;
  /** Un responsable nommé et une procédure approuvée : le dispositif peut servir. */
  ready: boolean;
}

export type LcbRefusal = { ok: false; rule: 'R16' | 'R94' | null; code: string };

export class DispositifLcb {
  private readonly now: () => Date;

  constructor(
    private readonly db: SqlDatabase,
    private readonly journal: JournalStore,
    options: { now?: () => Date } = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  private actor(viewer: Viewer): string {
    return `${String(viewer.role)}:${viewer.userId}`;
  }

  private async refuse(viewer: Viewer, code: string): Promise<LcbRefusal> {
    await appendEvent(this.journal, { type: 'acces.refuse', actor: this.actor(viewer), subject: `network:${viewer.networkId}`, data: { rule: 'R16', role: String(viewer.role), kind: 'lcb_dispositif', code } }, this.now);
    return { ok: false, rule: 'R16', code };
  }

  /** La direction nomme le responsable : un utilisateur au rôle conformité, par son identifiant. */
  async designate(viewer: Viewer, officerUserId: unknown): Promise<{ ok: true; value: LcbSetup } | LcbRefusal> {
    if (viewer.role !== 'direction') return this.refuse(viewer, 'role');
    if (typeof officerUserId !== 'string' || !USER_ID.test(officerUserId)) return { ok: false, rule: null, code: 'bad_officer' };
    const last = await this.db.first<{ n: number | null }>('SELECT MAX(seq) AS n FROM lcb_officers WHERE network_id = ?', [viewer.networkId]);
    await this.db.run('INSERT INTO lcb_officers (network_id, seq, officer_user_id, designated_by, designated_at) VALUES (?, ?, ?, ?, ?)', [
      viewer.networkId,
      Number(last?.n ?? 0) + 1,
      officerUserId,
      this.actor(viewer),
      this.now().toISOString(),
    ]);
    await appendEvent(this.journal, { type: 'conformite.responsable_nomme', actor: this.actor(viewer), subject: `network:${viewer.networkId}`, data: { rule: 'R94', officer: `compliance:${officerUserId}` } }, this.now);
    return { ok: true, value: await this.setupOf(viewer.networkId) };
  }

  /** La direction range la procédure écrite approuvée : une nouvelle version s'ajoute. */
  async approveProcedure(
    viewer: Viewer,
    input: { documentRef: unknown; documentSha256: unknown; approvedBy: unknown; approvedOn: unknown },
  ): Promise<{ ok: true; value: LcbSetup } | LcbRefusal> {
    if (viewer.role !== 'direction') return this.refuse(viewer, 'role');
    const ref = typeof input.documentRef === 'string' ? input.documentRef.trim() : '';
    const by = typeof input.approvedBy === 'string' ? input.approvedBy.trim() : '';
    if (ref.length < 3 || ref.length > 200) return { ok: false, rule: null, code: 'bad_document' };
    if (typeof input.documentSha256 !== 'string' || !HEX64.test(input.documentSha256)) return { ok: false, rule: null, code: 'bad_document' };
    if (by.length < 2 || by.length > 120) return { ok: false, rule: null, code: 'bad_approver' };
    const day = input.approvedOn;
    const today = this.now().toISOString().slice(0, 10);
    if (typeof day !== 'string' || !DAY.test(day) || Number.isNaN(Date.parse(`${day}T12:00:00Z`)) || new Date(`${day}T12:00:00Z`).toISOString().slice(0, 10) !== day || day > today) {
      return { ok: false, rule: null, code: 'bad_day' };
    }
    const last = await this.db.first<{ n: number | null }>('SELECT MAX(version) AS n FROM lcb_procedures WHERE network_id = ?', [viewer.networkId]);
    const version = Number(last?.n ?? 0) + 1;
    await this.db.run(
      'INSERT INTO lcb_procedures (network_id, version, document_ref, document_sha256, approved_by, approved_on, recorded_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [viewer.networkId, version, ref, input.documentSha256, by, day, this.actor(viewer), this.now().toISOString()],
    );
    await appendEvent(this.journal, { type: 'conformite.procedure_approuvee', actor: this.actor(viewer), subject: `network:${viewer.networkId}`, data: { rule: 'R94', version } }, this.now);
    return { ok: true, value: await this.setupOf(viewer.networkId) };
  }

  /** L'état du dispositif : la direction et la conformité. */
  async status(viewer: Viewer): Promise<{ ok: true; value: LcbSetup } | LcbRefusal> {
    if (viewer.role !== 'direction' && viewer.role !== 'compliance') return this.refuse(viewer, 'role');
    return { ok: true, value: await this.setupOf(viewer.networkId) };
  }

  async setupOf(networkId: string): Promise<LcbSetup> {
    const o = await this.db.first<{ officer_user_id: string; designated_at: string }>('SELECT officer_user_id, designated_at FROM lcb_officers WHERE network_id = ? ORDER BY seq DESC LIMIT 1', [networkId]);
    const p = await this.db.first<{ version: number; document_ref: string; document_sha256: string; approved_by: string; approved_on: string }>(
      'SELECT version, document_ref, document_sha256, approved_by, approved_on FROM lcb_procedures WHERE network_id = ? ORDER BY version DESC LIMIT 1',
      [networkId],
    );
    const officer = o ? { userId: o.officer_user_id, designatedAt: o.designated_at } : null;
    const procedure = p ? { version: Number(p.version), documentRef: p.document_ref, documentSha256: p.document_sha256, approvedBy: p.approved_by, approvedOn: p.approved_on } : null;
    return { officer, procedure, ready: officer !== null && procedure !== null };
  }

  /**
   * La porte des signalements : le responsable nommé seul ; pour décider de la déclaration, une procédure approuvée
   * aussi. Rend le code du refus, ou `null`.
   */
  async officerGate(viewer: Viewer, needProcedure: boolean): Promise<string | null> {
    if (viewer.role !== 'compliance') return 'role';
    const setup = await this.setupOf(viewer.networkId);
    if (!setup.officer) return 'pas_de_responsable';
    if (setup.officer.userId !== viewer.userId) return 'pas_responsable';
    if (needProcedure && !setup.procedure) return 'procedure_non_approuvee';
    return null;
  }
}
