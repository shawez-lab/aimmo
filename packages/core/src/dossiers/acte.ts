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
 * 10 ans, audit énergétique 5 ans, des réglages) ; sans mandat en vigueur au jour du compromis : la commission ne se saisit jamais [R63].
 *
 * Décidé, lecture prudente : le mandat qui compte est celui en vigueur le jour du compromis, quand la vente est
 * conclue ; les honoraires sont ceux du document signé, qu'un avenant ne change pas ; le constat plomb compte un an,
 * comme s'il avait trouvé du plomb, faute de connaître son résultat ; l'acte ne se rapporte pas avant le compromis ni
 * dans le futur ; un DPE fait avant le 1er juillet 2021 n'est plus valable depuis 2025 ; un mandat signé après le
 * compromis, ou encore dans son délai de rétractation, ne donne pas de commission : la direction tranche.
 */
import type { Acces } from '../acces/acces.ts';
import type { Viewer } from '../acces/droits.ts';
import { runBatch, type SqlDatabase } from '../db/sql.ts';
import { Diffusion } from '../documents/retractation.ts';
import type { DocumentFacts } from '../documents/modeles.ts';
import { mandateTerms } from '../documents/conditions.ts';
import { localTime } from '../envoi/horaires.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import { ControlesOffre } from '../offres/controles-offre.ts';
import { PROOF_REF } from '../offres/transmission.ts';
import { actorOf, gateSaleFile, type FileRefusal, type FileUnknown } from './acces-dossier.ts';
import { Echeancier } from './echeancier.ts';
import { PiecesDossier, type Piece, type PieceStore } from './pieces.ts';

const TIME_ZONE = 'Europe/Paris';

/** Durée de validité des pièces datées, en mois, au jour de l'acte : des réglages. */
export const DEFAULT_VALIDITY_MONTHS: Partial<Record<Piece, number>> = { etat_risques: 6, electricite: 36, gaz: 36, plomb: 12, dpe: 120, audit_energetique: 60, etat_termites: 6, controle_assainissement: 36 };

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

/** Un DPE fait avant le 1er juillet 2021, ancienne méthode, n'est plus valable depuis le 1er janvier 2025. */
export const DPE_NEW_METHOD_FROM = '2021-07-01';
export const DPE_OLD_METHOD_UNTIL = '2024-12-31';

/** Les pièces reçues périmées au jour de l'acte. Fonction pure. */
export function expiredPieces(lines: { piece: Piece; received: { issuedOn: string } | null }[], actOn: string, validity: Partial<Record<Piece, number>> = DEFAULT_VALIDITY_MONTHS): Piece[] {
  return lines
    .filter((l) => {
      if (!l.received) return false;
      // Un document daté après l'acte n'existait pas encore ce jour-là : il manque.
      if (l.received.issuedOn > actOn) return true;
      if (validity[l.piece] === undefined) return false;
      if (validUntil(l.received.issuedOn, validity[l.piece]!) < actOn) return true;
      return l.piece === 'dpe' && l.received.issuedOn < DPE_NEW_METHOD_FROM && actOn > DPE_OLD_METHOD_UNTIL;
    })
    .map((l) => l.piece);
}

/** Les honoraires d'un document de mandat signé, en euros entiers, ou null : jamais deviné [R63]. */
export function feeFrom(facts: Pick<DocumentFacts, 'feeEur'> | null): number | null {
  return facts && typeof facts.feeEur === 'number' && Number.isInteger(facts.feeEur) && facts.feeEur >= 0 ? facts.feeEur : null;
}

/**
 * L'agent de la vente : celui qui tenait le bien le jour du compromis (RC37). Un agent parti après ce jour garde sa
 * vente, même si le bien est passé depuis à la file de la direction ou à un autre agent (J11) : le premier passage du
 * bien rangé par un départ dont le jour vient après le compromis dit qui le tenait ; sans passage après ce jour, c'est
 * l'agent d'aujourd'hui. Lu par l'acte (N06) et par la commission prévue (K01), pour qu'ils disent le même agent.
 */
export async function saleAgentAt(db: SqlDatabase, networkId: string, propertyId: string, compromisOn: string): Promise<string | null> {
  const handed = await db.first<{ from_agent_id: string }>(
    `SELECT h.from_agent_id FROM agent_departure_handovers h JOIN agent_departures d ON d.id = h.departure_id
     WHERE h.network_id = ? AND h.kind = 'property' AND h.subject_id = ? AND d.leaves_on > ?
     ORDER BY d.leaves_on, h.at LIMIT 1`,
    [networkId, propertyId, compromisOn],
  );
  if (handed) return handed.from_agent_id;
  return (await db.first<{ agent_id: string | null }>('SELECT agent_id FROM properties WHERE id = ? AND network_id = ?', [propertyId, networkId]))?.agent_id ?? null;
}

/**
 * Les honoraires du mandat en vigueur le jour du compromis, tels qu'au document signé [R63], partagés par l'acte (N06)
 * et la commission prévue (K01). Un mandat encore dans son délai de rétractation sans demande écrite du vendeur n'est
 * pas en vigueur ; un mandat signé après le compromis non plus (loi Hoguet : le mandat écrit précède la négociation).
 */
export async function mandateFeeAt(
  db: SqlDatabase,
  diffusion: Diffusion,
  networkId: string,
  propertyId: string,
  compromis: string,
): Promise<{ ok: true; mandateId: string; feeEur: number; feeCharge: 'vendeur' | 'acquereur' | null } | { ok: false; code: 'no_mandate_in_force' | 'fee_unknown' }> {
  const decision = await diffusion.canDiffuse(networkId, propertyId, new Date(`${compromis}T11:00:00.000Z`));
  if (!decision.mandateId || !['allowed', 'allowed_early_start'].includes(decision.reason)) return { ok: false, code: 'no_mandate_in_force' };
  const mandate = await db.first<{ signed_at: string }>('SELECT signed_at FROM mandates WHERE id = ?', [decision.mandateId]);
  if (!mandate || localTime(new Date(mandate.signed_at), TIME_ZONE).date > compromis) return { ok: false, code: 'no_mandate_in_force' };
  // Un début avant la fin de la rétractation ne compte que si la demande écrite du vendeur était reçue au compromis.
  if (decision.reason === 'allowed_early_start') {
    const early = await db.first<{ received_at: string }>('SELECT received_at FROM mandate_early_starts WHERE mandate_id = ?', [decision.mandateId]);
    if (!early || localTime(new Date(early.received_at), TIME_ZONE).date > compromis) return { ok: false, code: 'no_mandate_in_force' };
  }
  const doc = await db.first<{ facts: string | null }>('SELECT d.facts FROM signed_documents s JOIN documents d ON d.id = s.document_id WHERE s.mandate_id = ? AND s.copy_content IS NOT NULL', [decision.mandateId]);
  let facts: DocumentFacts | null = null;
  try {
    facts = doc?.facts ? (JSON.parse(doc.facts) as DocumentFacts) : null;
  } catch {
    facts = null;
  }
  // Les honoraires en vigueur le jour du compromis : un avenant signé et en effet ce jour-là les a changés (AU057).
  const terms = await mandateTerms(db, decision.mandateId, new Date(`${compromis}T11:00:00.000Z`));
  const inForce = terms ? { feeEur: terms.feeEur, feeCharge: terms.feeCharge } : facts;
  const fee = feeFrom(inForce);
  if (fee === null) return { ok: false, code: 'fee_unknown' };
  return { ok: true, mandateId: decision.mandateId, feeEur: fee, feeCharge: inForce?.feeCharge ?? null };
}

export interface Closing {
  fileId: string;
  signedOn: string;
  aftersale: 'a_demarrer';
  commission: { mandateId: string; feeEur: number; feeCharge: 'vendeur' | 'acquereur' | null; dueOn: string };
}

export type ActProblem =
  | { ok: false; rule: null; code: 'bad_day' | 'bad_proof' | 'not_stored' | 'future_day' | 'compromis_missing' | 'before_compromis' | 'already_closed' | 'not_under_offer' | 'no_agent' }
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
  private readonly controles: ControlesOffre;
  private readonly proofs: { has(ref: string): Promise<boolean> } | null;

  constructor(
    private readonly db: SqlDatabase,
    private readonly acces: Acces,
    private readonly journal: JournalStore,
    store: PieceStore,
    options: { now?: () => Date; validityMonths?: Partial<Record<Piece, number>>; /** Donné par les routes (N13) : une attestation qui n'est pas rangée est refusée [R10]. */ proofs?: { has(ref: string): Promise<boolean> } } = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.validity = { ...DEFAULT_VALIDITY_MONTHS, ...(options.validityMonths ?? {}) };
    this.proofs = options.proofs ?? null;
    this.pieces = new PiecesDossier(db, acces, journal, store, { now: this.now });
    this.echeancier = new Echeancier(db, acces, journal, { now: this.now });
    this.diffusion = new Diffusion(db, acces, journal, { now: this.now });
    this.controles = new ControlesOffre(db, acces, journal, { now: this.now });
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
    // Une clôture déjà complète : rien de plus, sauf le bien encore à passer « vendu » après une coupure.
    if (await this.db.first('SELECT 1 FROM sale_commissions WHERE file_id = ?', [fileId])) {
      await this.db.run("UPDATE properties SET status = 'sold', updated_at = ? WHERE id = ? AND status = 'under_offer'", [this.now().toISOString(), g.file.property_id]);
      return { ok: false, rule: null, code: 'already_closed' };
    }
    if (this.proofs && !(await this.proofs.has(input.proofRef))) return { ok: false, rule: null, code: 'not_stored' };
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
    // L'identité de l'acquéreur vérifiée au jour de l'acte, pas seulement aujourd'hui : un contrôle fait après l'acte ne
    // compte pas. Fin du jour de Paris prise au plus tôt (heure d'été), par prudence. Qui ne voit pas la fiche de
    // l'acquéreur ne peut pas rapporter l'acte [R16].
    let identity = status.value.identity;
    if (identity !== 'non_visible') {
      const seen = await this.controles.identitySeenAt(g.file.network_id, g.file.buyer_person_id, new Date(`${signedOn}T21:59:59.999Z`));
      identity = seen !== null && localTime(new Date(seen), TIME_ZONE).date <= signedOn ? 'verifiee' : 'non_verifiee';
      // Chaque coacquéreur aussi, au jour de l'acte (AU009) [R58, R60].
      const co = await this.db.first<{ co_buyers: string | null }>('SELECT co_buyers FROM offer_register WHERE id = ?', [g.file.offer_id]);
      for (const personId of JSON.parse(co?.co_buyers ?? '[]') as string[]) {
        if (identity !== 'verifiee') break;
        const its = await this.controles.identitySeenAt(g.file.network_id, personId, new Date(`${signedOn}T21:59:59.999Z`));
        if (its === null || localTime(new Date(its), TIME_ZONE).date > signedOn) identity = 'non_verifiee';
      }
    }
    if (status.value.missing.length > 0 || status.value.unknown.length > 0 || identity !== 'verifiee' || expired.length > 0) {
      return blocked({ ok: false, rule: 'R60', code: 'incomplete', missing: status.value.missing, expired, unknown: status.value.unknown, identity });
    }
    // La commission : les honoraires du mandat en vigueur le jour du compromis, tels qu'au document signé [R63]. Un
    // mandat encore dans son délai de rétractation sans demande écrite du vendeur n'est pas en vigueur ; un mandat
    // signé après le compromis non plus (loi Hoguet : le mandat écrit précède la négociation).
    const fee = await mandateFeeAt(this.db, this.diffusion, g.file.network_id, g.file.property_id, compromis);
    if (!fee.ok) return blocked({ ok: false, rule: 'R63', code: fee.code });
    const decision = { mandateId: fee.mandateId };
    // L'agent de la vente : celui de la commission prévue au compromis (K01) s'il y en a une, sinon celui qui tenait le
    // bien le jour du compromis ; jamais le successeur d'un agent parti après ce jour (RC37).
    const planned = await this.db.first<{ agent_id: string }>('SELECT agent_id FROM commissions WHERE file_id = ?', [fileId]);
    const saleAgent = planned?.agent_id ?? (await saleAgentAt(this.db, g.file.network_id, g.file.property_id, compromis));
    // Un bien encore dans la file de la direction, sans agent au compromis : l'acte attend sa réattribution.
    if (!saleAgent) return blocked({ ok: false, rule: null, code: 'no_agent' });
    const facts = { feeCharge: fee.feeCharge };
    const iso = this.now().toISOString();
    // Tout ou rien (N13) : clôture, commission et bien vendu ensemble, car l'écran ne sait reprendre qu'un dossier
    // entier. Une clôture déjà coupée par le passé garde son jour ; la commission en dépend, et un nouvel essai la complète.
    const earlier = await this.db.first<{ signed_on: string }>('SELECT signed_on FROM sale_file_closings WHERE file_id = ?', [fileId]);
    const [, commission] = await runBatch(this.db, [
      { sql: "INSERT INTO sale_file_closings (file_id, network_id, signed_on, proof_ref, aftersale, at, by) VALUES (?, ?, ?, ?, 'a_demarrer', ?, ?) ON CONFLICT (file_id) DO NOTHING", params: [fileId, g.file.network_id, signedOn, input.proofRef, iso, actorOf(viewer)] },
      {
        sql: "INSERT INTO sale_commissions (file_id, network_id, mandate_id, agent_id, fee_eur, fee_charge, due_on, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'due', ?) ON CONFLICT (file_id) DO NOTHING",
        params: [fileId, g.file.network_id, decision.mandateId, saleAgent, fee.feeEur, facts.feeCharge, earlier?.signed_on ?? signedOn, iso],
      },
      // Le bien est vendu : la publication le montre ainsi au passage suivant (M07).
      { sql: "UPDATE properties SET status = 'sold', updated_at = ? WHERE id = ? AND status = 'under_offer'", params: [iso, g.file.property_id] },
    ]);
    const changes = commission!.changes;
    if (changes !== 1) return { ok: false, rule: null, code: 'already_closed' };
    await appendEvent(this.journal, { type: 'dossier.acte_signe', actor: actorOf(viewer), subject: `sale_file:${fileId}`, data: { rule: 'R63', mandate: `mandate:${decision.mandateId}` } }, this.now);
    const value = await this.read(fileId);
    if (!value) throw new Error('Clôture incomplète du dossier de vente.');
    return { ok: true, value };
  }
}
