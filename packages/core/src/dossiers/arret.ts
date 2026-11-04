/**
 * L'arrêt d'un dossier de vente, et le bien qui revient à la vente (SV09) [R233].
 *
 * L'agent du bien rapporte qu'un dossier s'arrête, avec une raison d'une liste fermée et la preuve reçue. Rien ne
 * s'arrête tout seul : ni une date passée, ni un prêt non obtenu [R57]. Un dossier arrêté reste lisible, ne reçoit plus
 * rien et ne relance plus personne ; son offre ne bloque plus les autres, et le bien peut ouvrir un autre dossier.
 *
 * Décidé, lecture prudente : le bien quitte « sous offre » pour « en préparation », jamais directement pour
 * « disponible ». Le passage de publication suivant le rend disponible si la porte de diffusion reste ouverte et que son
 * annonce est valable [R42], et remet l'annonce en vente ; un mandat échu n'y revient donc pas. L'arrêt est définitif :
 * une erreur demande un nouveau dossier, sur une nouvelle offre.
 */
import type { Acces } from '../acces/acces.ts';
import type { Viewer } from '../acces/droits.ts';
import { runBatch, type SqlDatabase } from '../db/sql.ts';
import { localTime } from '../envoi/horaires.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import { PROOF_REF } from '../offres/transmission.ts';
import { actorOf, gateSaleFile, type FileRefusal, type FileUnknown } from './acces-dossier.ts';
import type { PieceStore } from './pieces.ts';

const TIME_ZONE = 'Europe/Paris';

export const STOP_REASONS = ['retractation_acquereur', 'pret_refuse', 'preemption', 'accord_des_parties', 'autre'] as const;
export type StopReason = (typeof STOP_REASONS)[number];

export interface SaleFileStop {
  reason: StopReason;
  /** Le jour de l'arrêt, à Paris. */
  on: string;
}

type Problem = { ok: false; rule: null; code: 'bad_reason' | 'bad_proof' | 'not_stored' | 'already_closed' | 'file_stopped' };

export class ArretDossier {
  private readonly now: () => Date;

  constructor(
    private readonly db: SqlDatabase,
    private readonly acces: Acces,
    private readonly journal: JournalStore,
    private readonly proofs: PieceStore,
    options: { now?: () => Date } = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  private deps() {
    return { db: this.db, acces: this.acces, journal: this.journal, now: this.now };
  }

  /** L'arrêt du dossier, ou null s'il est ouvert, pour qui voit le dossier en entier [R16]. */
  async of(viewer: Viewer, fileId: string): Promise<{ ok: true; value: SaleFileStop | null } | FileRefusal | FileUnknown> {
    const g = await gateSaleFile(this.deps(), viewer, fileId, false, 'sale_file_stop');
    if (!g.ok) return g;
    const row = await this.db.first<{ reason: StopReason; at: string }>('SELECT reason, at FROM sale_file_stops WHERE file_id = ?', [fileId]);
    return { ok: true, value: row ? { reason: row.reason, on: localTime(new Date(row.at), TIME_ZONE).date } : null };
  }

  /** L'agent du bien rapporte l'arrêt : l'arrêt et le statut du bien s'écrivent ensemble. */
  async stop(viewer: Viewer, fileId: string, input: { reason: unknown; proofRef: unknown }): Promise<{ ok: true; value: SaleFileStop } | FileRefusal | FileUnknown | Problem> {
    const g = await gateSaleFile(this.deps(), viewer, fileId, true, 'sale_file_stop');
    if (!g.ok) return g;
    if (!(STOP_REASONS as readonly unknown[]).includes(input.reason)) return { ok: false, rule: null, code: 'bad_reason' };
    const reason = input.reason as StopReason;
    if (typeof input.proofRef !== 'string' || !PROOF_REF.test(input.proofRef)) return { ok: false, rule: null, code: 'bad_proof' };
    if (!(await this.proofs.has(input.proofRef))) return { ok: false, rule: null, code: 'not_stored' };
    if (await this.db.first('SELECT 1 FROM sale_file_closings WHERE file_id = ?', [fileId])) return { ok: false, rule: null, code: 'already_closed' };
    const at = this.now().toISOString();
    let moved = false;
    try {
      const results = await runBatch(this.db, [
        { sql: 'INSERT INTO sale_file_stops (file_id, network_id, reason, proof_ref, at, by) VALUES (?, ?, ?, ?, ?, ?)', params: [fileId, g.file.network_id, reason, input.proofRef, at, actorOf(viewer)] },
        {
          // Ce dossier était le seul ouvert du bien, la base le garantit : rien d'autre ne tient le bien sous offre.
          sql: "UPDATE properties SET status = 'draft', updated_at = ? WHERE id = ? AND status = 'under_offer'",
          params: [at, g.file.property_id],
        },
      ]);
      moved = results[1]?.changes === 1;
    } catch (error) {
      if (/acte déjà signé/.test(String(error))) return { ok: false, rule: null, code: 'already_closed' };
      if (/UNIQUE|PRIMARY/i.test(String(error))) return { ok: false, rule: null, code: 'file_stopped' };
      throw error;
    }
    // La raison seulement, dans sa liste fermée : ni nom, ni preuve, ni montant [R13].
    await appendEvent(this.journal, { type: 'dossier.arrete', actor: actorOf(viewer), subject: `sale_file:${fileId}`, data: { rule: 'R233', reason } }, this.now);
    if (moved) await appendEvent(this.journal, { type: 'bien.offre_tombee', actor: actorOf(viewer), subject: `property:${g.file.property_id}`, data: { rule: 'R233' } }, this.now);
    return { ok: true, value: { reason, on: localTime(new Date(at), TIME_ZONE).date } };
  }
}
