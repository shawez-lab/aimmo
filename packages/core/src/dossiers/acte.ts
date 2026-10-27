/**
 * Acte signé : vente close, commission due (M10, N06) [R10, R16, R17, R58, R60, R63].
 *
 * L'agent du dossier rapporte l'acte signé avec sa preuve (la référence de l'attestation du notaire) et son jour. Le
 * dossier se clôt une seule fois ; le bien passe « vendu », ce que la publication montre au passage suivant ; la
 * commission devient due, au montant des honoraires du mandat signé, rangée pour M13 ; l'après-vente est marqué à
 * démarrer pour M11.
 *
 * Refusé : sans compromis en préparation, donc sans identité vérifiée [R58] ; sans compromis signé saisi (N02) ; sans
 * dossier complet au jour de l'acte [R60] : chaque pièce reçue, l'identité vérifiée, et aucune pièce périmée ce
 * jour-là d'après la date du document (état des risques 6 mois, électricité et gaz 3 ans, constat plomb 1 an, DPE
 * 10 ans, des réglages) ; sans mandat en vigueur au jour du compromis : la commission ne se saisit jamais [R63].
 *
 * Décidé, lecture prudente : le mandat qui compte est celui en vigueur le jour du compromis, quand la vente est
 * conclue ; les honoraires sont ceux du document signé, qu'un avenant ne change pas ; le constat plomb compte un an,
 * comme s'il avait trouvé du plomb, faute de connaître son résultat ; l'acte ne se rapporte pas avant le compromis ni
 * dans le futur.
 */
import type { Acces } from '../acces/acces.ts';
import type { Viewer } from '../acces/droits.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { Diffusion } from '../documents/retractation.ts';
import type { DocumentFacts } from '../documents/modeles.ts';
import { localTime } from '../envoi/horaires.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import { PROOF_REF } from '../offres/transmission.ts';
import { actorOf, gateSaleFile, type FileRefusal, type FileUnknown } from './acces-dossier.ts';
import { Echeancier } from './echeancier.ts';
import { PiecesDossier, type Piece, type PieceStore } from './pieces.ts';

const TIME_ZONE = 'Europe/Paris';

/** Durée de validité des pièces datées, en mois, au jour de l'acte : des réglages. */
export const DEFAULT_VALIDITY_MONTHS: Partial<Record<Piece, number>> = { etat_risques: 6, electricite: 36, gaz: 36, plomb: 12, dpe: 120 };

/** Le dernier jour de validité d'une pièce datée du `issuedOn` (même jour, `months` mois plus tard, la veille). */
export function validUntil(issuedOn: string, months: number): string {
  const [y, m, d] = issuedOn.split('-').map(Number) as [number, number, number];
  const total = m - 1 + months;
  const year = y + Math.floor(total / 12);
  const month = total % 12;
  const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const same = new Date(Date.UTC(year, month, Math.min(d, last)));
  return new Date(same.getTime() - 86_400_000).toISOString().slice(0, 10);
}

/** Les pièces reçues périmées au jour de l'acte. Fonction pure. */
export function expiredPieces(lines: { piece: Piece; received: { issuedOn: string } | null }[], actOn: string, validity: Partial<Record<Piece, number>> = DEFAULT_VALIDITY_MONTHS): Piece[] {
  return lines.filter((l) => l.received && validity[l.piece] !== undefined && validUntil(l.received.issuedOn, validity[l.piece]!) < actOn).map((l) => l.piece);
}

export interface Closing {
  fileId: string;
  signedOn: string;
  aftersale: 'a_demarrer';
  commission: { mandateId: string; feeEur: number; feeCharge: 'vendeur' | 'acquereur' | null; dueOn: string };
}

export type ActProblem =
  | { ok: false; rule: null; code: 'bad_day' | 'bad_proof' | 'future_day' | 'compromis_missing' | 'before_compromis' | 'already_closed' | 'not_under_offer' }
  | { ok: false; rule: 'R58'; code: 'compromis_not_started' }
  | { ok: false; rule: 'R60'; code: 'incomplete'; missing: Piece[]; expired: Piece[]; unknown: string[]; identity: string }
  | { ok: false; rule: 'R63'; code: 'no_mandate_in_force' | 'fee_unknown' };

const DAY = /^\d{4}-\d{2}-\d{2}$/;
function validDay(v: unknown): v is string {
  if (typeof v !== 'string' || !DAY.test(v)) return false;
  const d = new Date(`${v}T12:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

export class ActeVente {
  private readonly now: () => Date;
  private readonly pieces: PiecesDossier;
  private readonly echeancier: Echeancier;
  private readonly diffusion: Diffusion;
  private readonly validity: Partial<Record<Piece, number>>;

  constructor(
    private readonly db: SqlDatabase,
    private readonly acces: Acces,
    private readonly journal: JournalStore,
    store: PieceStore,
    options: { now?: () => Date; validityMonths?: Partial<Record<Piece, number>> } = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.validity = { ...DEFAULT_VALIDITY_MONTHS, ...(options.validityMonths ?? {}) };
    this.pieces = new PiecesDossier(db, acces, journal, store, { now: this.now });
    this.echeancier = new Echeancier(db, acces, journal, { now: this.now });
    this.diffusion = new Diffusion(db, acces, journal, { now: this.now });
  }

  private async read(fileId: string): Promise<Closing | null> {
    const c = await this.db.first<{ signed_on: string; aftersale: 'a_demarrer' }>('SELECT signed_on, aftersale FROM sale_file_closings WHERE file_id = ?', [fileId]);
    const k = await this.db.first<{ mandate_id: string; fee_eur: number; fee_charge: 'vendeur' | 'acquereur' | null; due_on: string }>('SELECT mandate_id, fee_eur, fee_charge, due_on FROM sale_commissions WHERE file_id = ?', [fileId]);
    if (!c || !k) return null;
    return { fileId, signedOn: c.signed_on, aftersale: c.aftersale, commission: { mandateId: k.mandate_id, feeEur: Number(k.fee_eur), feeCharge: k.fee_charge, dueOn: k.due_on } };
  }

  /** La clôture d'un dossier : agent du bien, direction, conformité [R16]. */
  async closing(viewer: Viewer, fileId: string): Promise<{ ok: true; value: Closing | null } | FileRefusal | FileUnknown> {
    const g = await gateSaleFile({ db: this.db, acces: this.acces, journal: this.journal, now: this.now }, viewer, fileId, false, 'sale_file_closing');
    if (!g.ok) return g;
    return { ok: true, value: await this.read(fileId) };
  }

  /** L'agent du dossier rapporte l'acte signé, avec la référence de l'attestation du notaire. */
  async record(viewer: Viewer, fileId: string, input: { signedOn: unknown; proofRef: unknown }): Promise<{ ok: true; value: Closing } | FileRefusal | FileUnknown | ActProblem> {
    const g = await gateSaleFile({ db: this.db, acces: this.acces, journal: this.journal, now: this.now }, viewer, fileId, true, 'sale_file_closing');
    if (!g.ok) return g;
    if (!validDay(input.signedOn)) return { ok: false, rule: null, code: 'bad_day' };
    const signedOn = input.signedOn;
    if (typeof input.proofRef !== 'string' || !PROOF_REF.test(input.proofRef)) return { ok: false, rule: null, code: 'bad_proof' };
    if (signedOn > localTime(this.now(), TIME_ZONE).date) return { ok: false, rule: null, code: 'future_day' };
    if (await this.db.first('SELECT 1 FROM sale_file_closings WHERE file_id = ?', [fileId])) return { ok: false, rule: null, code: 'already_closed' };
    const property = await this.db.first<{ status: string; agent_id: string }>('SELECT status, agent_id FROM properties WHERE id = ?', [g.file.property_id]);
    if (property?.status !== 'under_offer') return { ok: false, rule: null, code: 'not_under_offer' };
    const blocked = async <T extends ActProblem>(p: T): Promise<T> => {
      await appendEvent(this.journal, { type: 'dossier.acte_refuse', actor: actorOf(viewer), subject: `sale_file:${fileId}`, data: { rule: p.rule, code: p.code } }, this.now);
      return p;
    };
    if (!(await this.db.first("SELECT 1 FROM sale_file_steps WHERE file_id = ? AND step = 'compromis_en_preparation'", [fileId]))) return blocked({ ok: false, rule: 'R58', code: 'compromis_not_started' });
    const schedule = await this.echeancier.scheduleOf(g.file);
    const compromis = schedule.dates.compromis_signe?.day;
    if (!compromis) return blocked({ ok: false, rule: null, code: 'compromis_missing' });
    if (signedOn < compromis) return blocked({ ok: false, rule: null, code: 'before_compromis' });
    // Le dossier complet au jour de l'acte : rien ne manque, identité vérifiée, aucune pièce périmée [R60].
    const status = await this.pieces.status(viewer, fileId);
    if (!status.ok) return status as FileRefusal | FileUnknown;
    const expired = expiredPieces(status.value.lines, signedOn, this.validity);
    if (!status.value.complete || expired.length > 0) {
      return blocked({ ok: false, rule: 'R60', code: 'incomplete', missing: status.value.missing, expired, unknown: status.value.unknown, identity: status.value.identity });
    }
    // La commission : les honoraires du mandat en vigueur le jour du compromis, tels qu'au document signé [R63].
    const decision = await this.diffusion.canDiffuse(g.file.network_id, g.file.property_id, new Date(`${compromis}T11:00:00.000Z`));
    if (!decision.mandateId || !['allowed', 'allowed_early_start', 'withdrawal_period'].includes(decision.reason)) return blocked({ ok: false, rule: 'R63', code: 'no_mandate_in_force' });
    const doc = await this.db.first<{ facts: string | null }>('SELECT d.facts FROM signed_documents s JOIN documents d ON d.id = s.document_id WHERE s.mandate_id = ? AND s.copy_content IS NOT NULL', [decision.mandateId]);
    let facts: DocumentFacts | null = null;
    try {
      facts = doc?.facts ? (JSON.parse(doc.facts) as DocumentFacts) : null;
    } catch {
      facts = null;
    }
    if (!facts || typeof facts.feeEur !== 'number' || !Number.isInteger(facts.feeEur) || facts.feeEur < 0) return blocked({ ok: false, rule: 'R63', code: 'fee_unknown' });
    const iso = this.now().toISOString();
    try {
      await this.db.run("INSERT INTO sale_file_closings (file_id, network_id, signed_on, proof_ref, aftersale, at, by) VALUES (?, ?, ?, ?, 'a_demarrer', ?, ?)", [fileId, g.file.network_id, signedOn, input.proofRef, iso, actorOf(viewer)]);
    } catch (error) {
      if (/UNIQUE|PRIMARY/i.test(String(error))) return { ok: false, rule: null, code: 'already_closed' };
      throw error;
    }
    await this.db.run(
      "INSERT INTO sale_commissions (file_id, network_id, mandate_id, agent_id, fee_eur, fee_charge, due_on, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'due', ?)",
      [fileId, g.file.network_id, decision.mandateId, property.agent_id, facts.feeEur, facts.feeCharge ?? null, signedOn, iso],
    );
    // Le bien est vendu : la publication le montre ainsi au passage suivant (M07).
    await this.db.run("UPDATE properties SET status = 'sold', updated_at = ? WHERE id = ? AND status = 'under_offer'", [iso, g.file.property_id]);
    await appendEvent(this.journal, { type: 'dossier.acte_signe', actor: actorOf(viewer), subject: `sale_file:${fileId}`, data: { rule: 'R63', mandate: `mandate:${decision.mandateId}` } }, this.now);
    return { ok: true, value: (await this.read(fileId))! };
  }
}
