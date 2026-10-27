/**
 * La mesure du critère de M06 (D09) : « un mandat test signé en moins de 10 minutes à partir de l'estimation, et
 * numéroté au registre ».
 *
 * La chronologie d'un mandat se lit dans ce que la base garde déjà : l'avis de valeur validé du bien (E04), le
 * document généré (D02), le premier contrôle réussi (D03), et la signature numérotée (D04). Elle rend le temps de
 * chaque étape et le total, comparé à la cible réglée (10 minutes). Rien n'est ajouté pour la mesurer.
 *
 * Seules la direction et la conformité la lisent ; elle ne porte que des instants et des durées, aucune donnée
 * personnelle [R13, R16].
 */
import type { Viewer } from '../acces/droits.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';

/** La cible du cahier : 10 minutes de l'estimation au mandat numéroté. */
export const MANDATE_TARGET_SECONDS = 10 * 60;

export interface MandateTimeline {
  mandateId: string;
  /** Les instants de chaque étape ; null quand l'étape n'a pas de trace. */
  valuationValidatedAt: string | null;
  documentGeneratedAt: string;
  checkPassedAt: string | null;
  /** L'enregistrement de la signature papier, puis le numéro et l'exemplaire. */
  registeredAt: string;
  numberedAt: string;
  /** Les durées, en secondes, entre étapes ; null quand une borne manque. */
  steps: { valuationToDocument: number | null; documentToCheck: number | null; checkToNumbered: number | null };
  totalSeconds: number | null;
  underTarget: boolean | null;
}

const seconds = (from: string | null, to: string | null): number | null => (from && to ? Math.round((Date.parse(to) - Date.parse(from)) / 1000) : null);

export class ChronologieMandat {
  private readonly now: () => Date;

  constructor(
    private readonly db: SqlDatabase,
    private readonly journal: JournalStore,
    options: { now?: () => Date } = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  async read(viewer: Viewer, mandateId: string): Promise<{ ok: true; value: MandateTimeline } | { ok: false; rule: 'R16'; code: string } | { ok: false; rule: null; code: 'unknown_mandate' }> {
    const actor = `${String(viewer.role)}:${viewer.userId}`;
    if (viewer.role !== 'direction' && viewer.role !== 'compliance') {
      await appendEvent(this.journal, { type: 'acces.refuse', actor, subject: `mandate:${mandateId}`, data: { rule: 'R16', role: String(viewer.role), kind: 'mandate_timeline', code: 'role' } }, this.now);
      return { ok: false, rule: 'R16', code: 'role' };
    }
    const row = await this.db.first<{ document_id: string; property_id: string | null; created_at: string; completed_at: string | null; doc_created: string; network_id: string }>(
      `SELECT s.document_id, d.property_id, s.created_at, s.completed_at, d.created_at AS doc_created, s.network_id FROM signed_documents s JOIN documents d ON d.id = s.document_id WHERE s.mandate_id = ?`,
      [mandateId],
    );
    if (!row || row.network_id !== viewer.networkId || row.completed_at === null) {
      await appendEvent(this.journal, { type: 'acces.refuse', actor, subject: `mandate:${mandateId}`, data: { rule: 'R16', role: String(viewer.role), kind: 'mandate_timeline', code: 'unknown' } }, this.now);
      return { ok: false, rule: null, code: 'unknown_mandate' };
    }
    // L'avis validé le plus récent du bien avant la génération du document.
    const valuation = row.property_id
      ? await this.db.first<{ validated_at: string }>(
          `SELECT validated_at FROM valuation_reports WHERE property_id = ? AND status = 'validated' AND validated_at <= ? ORDER BY validated_at DESC LIMIT 1`,
          [row.property_id, row.doc_created],
        )
      : null;
    // Le premier contrôle réussi du document, avant sa signature.
    const check = await this.db.first<{ checked_at: string }>(`SELECT checked_at FROM document_checks WHERE document_id = ? AND passed = 1 ORDER BY checked_at LIMIT 1`, [row.document_id]);
    const valuationAt = valuation?.validated_at ?? null;
    const checkAt = check?.checked_at ?? null;
    const total = seconds(valuationAt, row.completed_at);
    await appendEvent(this.journal, { type: 'mandat.chronologie_lue', actor, subject: `mandate:${mandateId}`, data: { rule: 'R16' } }, this.now);
    return {
      ok: true,
      value: {
        mandateId,
        valuationValidatedAt: valuationAt,
        documentGeneratedAt: row.doc_created,
        checkPassedAt: checkAt,
        registeredAt: row.created_at,
        numberedAt: row.completed_at,
        steps: { valuationToDocument: seconds(valuationAt, row.doc_created), documentToCheck: seconds(row.doc_created, checkAt), checkToNumbered: seconds(checkAt, row.completed_at) },
        totalSeconds: total,
        // « En moins de 10 minutes » : comparaison stricte, sur la durée exacte, pas arrondie.
        underTarget: valuationAt === null ? null : Date.parse(row.completed_at) - Date.parse(valuationAt) < MANDATE_TARGET_SECONDS * 1000,
      },
    };
  }
}
