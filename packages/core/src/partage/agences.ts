/**
 * Partage de biens entre agences et partage d'honoraires (HX01) [R234, R235, R13, R16, R17].
 *
 * L'agent du bien le partage avec une agence partenaire rangée par la direction. L'agence voit la fiche commune du bien
 * (type, commune, surface, pièces, prix), jamais une personne : ni le vendeur, ni ses coordonnées, ni l'adresse.
 * L'agent propose un bon de délégation qui fixe la part de l'agence sur les honoraires ; l'agence l'accepte ; l'agent
 * range le bon signé des deux. Aucune co-visite ne se demande avant ce bon signé, la base le garantit aussi [R234].
 *
 * Jamais vu : le partage est tenu par le code jusqu'à l'acte. Il ne change plus une fois proposé ; à l'acte, le relevé
 * se calcule une seule fois sur les honoraires dus (N06), jamais saisis ; la facture de rétrocession de l'agence n'est
 * rangée qu'à ce montant exact [R235]. Et chaque agence lit en direct où en est le dossier, étape par étape, datée,
 * sans un nom ni un montant d'un client, sans avoir à appeler.
 *
 * Décidé, lecture prudente : les coordonnées du vendeur ne sont jamais données à l'agence, ni avant ni après la
 * signature : la co-visite passe par l'agent du bien. La part de l'agence est arrondie au centime inférieur, le reste
 * revient au réseau. L'agent atteste au moment de ranger le bon que le mandat autorise la délégation (loi Hoguet) ;
 * sans cette attestation, rien n'est signé. Le relevé ne porte que sur un dossier rattaché à la délégation par l'agent.
 */
import type { Acces } from '../acces/acces.ts';
import type { Viewer } from '../acces/droits.ts';
import type { SqlDatabase } from '../db/sql.ts';
import type { PieceStore } from '../dossiers/pieces.ts';
import { localTime } from '../envoi/horaires.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import { PROOF_REF } from '../offres/transmission.ts';

const TIME_ZONE = 'Europe/Paris';

export type ShareRefusal = { ok: false; rule: 'R16'; code: string };
export type ShareProblem = { ok: false; rule: 'R234' | 'R235' | null; code: string };
type Result<T> = { ok: true; value: T } | ShareRefusal | ShareProblem;

/** Ce qu'une agence partenaire lit d'un bien : la fiche commune, sans personne ni adresse [R234]. */
export interface SharedPropertyView {
  shareId: string;
  reference: string;
  kind: string;
  postalCode: string | null;
  city: string | null;
  surfaceM2: number | null;
  rooms: number | null;
  priceEur: number | null;
  stage: DelegationStage;
}

export const DELEGATION_STAGES = [
  'partage',
  'delegation_proposee',
  'delegation_acceptee',
  'delegation_signee',
  'visite_demandee',
  'visite_faite',
  'dossier_ouvert',
  'compromis_signe',
  'acte_signe',
  'arrete',
  'bien_indisponible',
] as const;
export type DelegationStage = (typeof DELEGATION_STAGES)[number];

export interface DelegationProgress {
  stage: DelegationStage;
  /** Les étapes passées, dans l'ordre, chacune avec son jour à Paris : ni nom, ni montant d'un client. `null` : un jour
   * que rien ne date (le bien devenu indisponible par ailleurs), jamais le jour de la lecture. */
  steps: { stage: DelegationStage; on: string | null }[];
}

export interface FeeStatement {
  feeCents: number;
  partnerShareBp: number;
  partnerCents: number;
  ownCents: number;
  /** La facture de rétrocession de l'agence, rangée au montant du relevé ; `null` tant qu'elle n'est pas reçue. */
  partnerInvoiceReceivedOn: string | null;
}

/**
 * Le partage des honoraires, en centimes. Fonction pure : la part de l'agence est arrondie au centime inférieur, le
 * reste au réseau, et la somme fait toujours les honoraires [R235].
 */
export function splitAgencyFee(feeCents: number, partnerShareBp: number): { partnerCents: number; ownCents: number } {
  if (!Number.isInteger(feeCents) || feeCents < 0) throw new Error('Honoraires en centimes entiers attendus.');
  if (!validBp(partnerShareBp)) throw new Error('Part de l’agence hors bornes.');
  const partnerCents = Math.floor((feeCents * partnerShareBp) / 10_000);
  return { partnerCents, ownCents: feeCents - partnerCents };
}

const validBp = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 9_999;
const NAME = /^[\p{L}\p{N}][\p{L}\p{N} '’&.,-]{1,119}$/u;
const CARD = /^[A-Z0-9 ]{6,40}$/;

interface ShareRow {
  id: string;
  network_id: string;
  property_id: string;
  agency_id: string;
  shared_at: string;
}

export class PartageAgences {
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(
    private readonly db: SqlDatabase,
    private readonly acces: Acces,
    private readonly journal: JournalStore,
    private readonly proofs: PieceStore,
    options: { now?: () => Date; newId?: () => string } = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => crypto.randomUUID());
  }

  private actor(viewer: Viewer): string {
    return `${String(viewer.role)}:${viewer.userId}`;
  }

  private async refuse(viewer: Viewer, subject: string, kind: string, code: string): Promise<ShareRefusal> {
    await appendEvent(this.journal, { type: 'acces.refuse', actor: this.actor(viewer), subject, data: { rule: 'R16', role: String(viewer.role), kind, code } }, this.now);
    return { ok: false, rule: 'R16', code };
  }

  private async event(viewer: Viewer, type: string, subject: string, data: Record<string, string | number | boolean>): Promise<void> {
    // Au journal : les identifiants et l'étape, jamais un nom ni un montant [R13].
    await appendEvent(this.journal, { type, actor: this.actor(viewer), subject, data }, this.now);
  }

  private day(iso: string): string {
    return localTime(new Date(iso), TIME_ZONE).date;
  }

  /** Une agence partenaire connue de ce réseau, lue par elle-même. */
  private async partnerAgency(viewer: Viewer): Promise<string | null> {
    if (viewer.role !== 'partner') return null;
    const row = await this.db.first<{ id: string }>('SELECT id FROM partner_agencies WHERE id = ? AND network_id = ?', [viewer.userId, viewer.networkId]);
    return row?.id ?? null;
  }

  /** L'agent du bien, et lui seul, qui voit son bien en entier. */
  private async ownerRefusal(viewer: Viewer, propertyId: string, kind: string): Promise<ShareRefusal | { ok: true; status: string }> {
    const subject = `property:${propertyId}`;
    if (viewer.role !== 'agent') return this.refuse(viewer, subject, kind, 'role');
    const p = await this.acces.readProperty(viewer, propertyId);
    if (!p.ok) return this.refuse(viewer, subject, kind, p.code);
    if (p.view !== 'full' || p.value.agent_id !== viewer.userId) return this.refuse(viewer, subject, kind, 'not_assigned');
    return { ok: true, status: p.value.status };
  }

  private async share(id: string): Promise<ShareRow | null> {
    return this.db.first<ShareRow>('SELECT id, network_id, property_id, agency_id, shared_at FROM agency_shares WHERE id = ?', [id]);
  }

  /**
   * Qui lit un partage : l'agence du partage, l'agent du bien, la direction. `write` : l'agent du bien seulement ;
   * `partner` : l'agence du partage seulement.
   */
  private async gate(viewer: Viewer, shareId: string, kind: string, who: 'read' | 'owner' | 'partner'): Promise<{ ok: true; share: ShareRow } | ShareRefusal> {
    const subject = `agency_share:${shareId}`;
    const share = await this.share(shareId);
    if (!share || share.network_id !== viewer.networkId) return this.refuse(viewer, subject, kind, 'unknown');
    if (viewer.role === 'partner') {
      if (who === 'owner') return this.refuse(viewer, subject, kind, 'role');
      const agency = await this.partnerAgency(viewer);
      return agency === share.agency_id ? { ok: true, share } : this.refuse(viewer, subject, kind, 'not_assigned');
    }
    if (who === 'partner') return this.refuse(viewer, subject, kind, 'role');
    if (viewer.role === 'direction' && who === 'read') return { ok: true, share };
    const owner = await this.ownerRefusal(viewer, share.property_id, kind);
    return owner.ok ? { ok: true, share } : owner;
  }

  private async delegationOf(shareId: string): Promise<{ id: string; partner_share_bp: number; proposed_at: string } | null> {
    return this.db.first('SELECT id, partner_share_bp, proposed_at FROM agency_delegations WHERE share_id = ?', [shareId]);
  }

  private async stepAt(delegationId: string, step: 'acceptee' | 'signee'): Promise<string | null> {
    return (await this.db.first<{ at: string }>('SELECT at FROM agency_delegation_steps WHERE delegation_id = ? AND step = ?', [delegationId, step]))?.at ?? null;
  }

  /** La direction range une agence partenaire : sa raison sociale et sa carte professionnelle, jamais une personne. */
  async registerAgency(viewer: Viewer, input: { businessName: unknown; cardNumber: unknown }): Promise<Result<{ id: string }>> {
    if (viewer.role !== 'direction') return this.refuse(viewer, `network:${viewer.networkId}`, 'partner_agency', 'role');
    const name = typeof input.businessName === 'string' ? input.businessName.trim() : '';
    if (!NAME.test(name)) return { ok: false, rule: null, code: 'bad_name' };
    const card = typeof input.cardNumber === 'string' ? input.cardNumber.trim().toUpperCase() : '';
    if (!CARD.test(card)) return { ok: false, rule: null, code: 'bad_card' };
    if (await this.db.first('SELECT 1 FROM partner_agencies WHERE network_id = ? AND card_number = ?', [viewer.networkId, card])) {
      return { ok: false, rule: null, code: 'already_known' };
    }
    const id = this.newId();
    await this.db.run('INSERT INTO partner_agencies (id, network_id, business_name, card_number, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)', [
      id,
      viewer.networkId,
      name,
      card,
      this.actor(viewer),
      this.now().toISOString(),
    ]);
    await this.event(viewer, 'partage.agence', `partner_agency:${id}`, { step: 'rangee' });
    return { ok: true, value: { id } };
  }

  /** L'agent du bien le partage avec une agence partenaire ; seulement un bien en vente. Une seule fois par agence. */
  async shareProperty(viewer: Viewer, propertyId: string, agencyId: unknown): Promise<Result<{ shareId: string }>> {
    const owner = await this.ownerRefusal(viewer, propertyId, 'agency_share');
    if (!owner.ok) return owner;
    if (owner.status !== 'available') return { ok: false, rule: null, code: 'not_for_sale' };
    if (typeof agencyId !== 'string' || !(await this.db.first('SELECT 1 FROM partner_agencies WHERE id = ? AND network_id = ?', [agencyId, viewer.networkId]))) {
      return { ok: false, rule: null, code: 'unknown_agency' };
    }
    const existing = await this.db.first<{ id: string }>('SELECT id FROM agency_shares WHERE property_id = ? AND agency_id = ?', [propertyId, agencyId]);
    if (existing) return { ok: true, value: { shareId: existing.id } };
    const id = this.newId();
    const { changes } = await this.db.run(
      'INSERT INTO agency_shares (id, network_id, property_id, agency_id, shared_by, shared_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (property_id, agency_id) DO NOTHING',
      [id, viewer.networkId, propertyId, agencyId, this.actor(viewer), this.now().toISOString()],
    );
    if (changes !== 1) {
      const again = (await this.db.first<{ id: string }>('SELECT id FROM agency_shares WHERE property_id = ? AND agency_id = ?', [propertyId, agencyId]))!;
      return { ok: true, value: { shareId: again.id } };
    }
    await this.event(viewer, 'partage.bien', `agency_share:${id}`, { step: 'partage' });
    return { ok: true, value: { shareId: id } };
  }

  /** Les biens partagés avec l'agence qui lit : la fiche commune et l'étape, rien d'autre [R234]. */
  async sharedWithMe(viewer: Viewer): Promise<Result<SharedPropertyView[]>> {
    const agency = await this.partnerAgency(viewer);
    if (!agency) return this.refuse(viewer, `network:${viewer.networkId}`, 'agency_shares', viewer.role === 'partner' ? 'unknown' : 'role');
    const rows = await this.db.all<{ id: string; reference: string; kind: string; postal_code: string | null; city: string | null; surface_m2: number | null; rooms: number | null; price_eur: number | null }>(
      `SELECT s.id, p.reference, p.kind, p.postal_code, p.city, p.surface_m2, p.rooms, p.price_eur
       FROM agency_shares s JOIN properties p ON p.id = s.property_id
       WHERE s.network_id = ? AND s.agency_id = ? ORDER BY s.shared_at, s.id`,
      [viewer.networkId, agency],
    );
    const out: SharedPropertyView[] = [];
    for (const r of rows) {
      const progress = await this.progressOf(r.id);
      out.push({ shareId: r.id, reference: r.reference, kind: r.kind, postalCode: r.postal_code, city: r.city, surfaceM2: r.surface_m2, rooms: r.rooms, priceEur: r.price_eur, stage: progress.stage });
    }
    await this.event(viewer, 'partage.lu', `partner_agency:${agency}`, { count: out.length });
    return { ok: true, value: out };
  }

  /** L'agent du bien propose le bon de délégation et sa part d'honoraires, qui ne change plus ensuite [R235]. */
  async proposeDelegation(viewer: Viewer, shareId: string, input: { partnerShareBp: unknown }): Promise<Result<{ delegationId: string }>> {
    const g = await this.gate(viewer, shareId, 'agency_delegation', 'owner');
    if (!g.ok) return g;
    if (!validBp(input.partnerShareBp)) return { ok: false, rule: null, code: 'bad_share' };
    if (await this.delegationOf(shareId)) return { ok: false, rule: 'R235', code: 'already_proposed' };
    const id = this.newId();
    const { changes } = await this.db.run(
      'INSERT INTO agency_delegations (id, share_id, network_id, partner_share_bp, proposed_by, proposed_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (share_id) DO NOTHING',
      [id, shareId, g.share.network_id, input.partnerShareBp, this.actor(viewer), this.now().toISOString()],
    );
    if (changes !== 1) return { ok: false, rule: 'R235', code: 'already_proposed' };
    await this.event(viewer, 'partage.delegation', `agency_share:${shareId}`, { step: 'proposee' });
    return { ok: true, value: { delegationId: id } };
  }

  /** L'agence du partage accepte le bon proposé, et sa part. */
  async acceptDelegation(viewer: Viewer, shareId: string): Promise<Result<{ acceptedOn: string }>> {
    const g = await this.gate(viewer, shareId, 'agency_delegation', 'partner');
    if (!g.ok) return g;
    const d = await this.delegationOf(shareId);
    if (!d) return { ok: false, rule: null, code: 'no_delegation' };
    const at = this.now().toISOString();
    await this.db.run("INSERT INTO agency_delegation_steps (delegation_id, step, proof_ref, mandate_clause, at, by) VALUES (?, 'acceptee', NULL, NULL, ?, ?) ON CONFLICT DO NOTHING", [d.id, at, this.actor(viewer)]);
    const kept = (await this.stepAt(d.id, 'acceptee'))!;
    if (kept === at) await this.event(viewer, 'partage.delegation', `agency_share:${shareId}`, { step: 'acceptee' });
    return { ok: true, value: { acceptedOn: this.day(kept) } };
  }

  /**
   * L'agent du bien range le bon signé des deux, avec sa preuve, et atteste que le mandat autorise la délégation.
   * Jamais sans l'accord de l'agence.
   */
  async recordSigned(viewer: Viewer, shareId: string, input: { proofRef: unknown; mandateAllowsDelegation: unknown }): Promise<Result<{ signedOn: string }>> {
    const g = await this.gate(viewer, shareId, 'agency_delegation', 'owner');
    if (!g.ok) return g;
    const d = await this.delegationOf(shareId);
    if (!d) return { ok: false, rule: null, code: 'no_delegation' };
    if (input.mandateAllowsDelegation !== true) return { ok: false, rule: 'R234', code: 'mandate_clause' };
    if (typeof input.proofRef !== 'string' || !PROOF_REF.test(input.proofRef)) return { ok: false, rule: null, code: 'bad_proof' };
    if (!(await this.proofs.has(input.proofRef))) return { ok: false, rule: null, code: 'not_stored' };
    if (!(await this.stepAt(d.id, 'acceptee'))) return { ok: false, rule: 'R234', code: 'not_accepted' };
    const at = this.now().toISOString();
    await this.db.run("INSERT INTO agency_delegation_steps (delegation_id, step, proof_ref, mandate_clause, at, by) VALUES (?, 'signee', ?, 1, ?, ?) ON CONFLICT DO NOTHING", [d.id, input.proofRef, at, this.actor(viewer)]);
    const kept = (await this.stepAt(d.id, 'signee'))!;
    if (kept === at) await this.event(viewer, 'partage.delegation', `agency_share:${shareId}`, { step: 'signee', mandateClause: true });
    return { ok: true, value: { signedOn: this.day(kept) } };
  }

  /** L'agence demande une co-visite : jamais avant le bon de délégation signé [R234]. */
  async requestVisit(viewer: Viewer, shareId: string, input: { wishedAt: unknown }): Promise<Result<{ visitId: string }>> {
    const g = await this.gate(viewer, shareId, 'agency_visit', 'partner');
    if (!g.ok) return g;
    const d = await this.delegationOf(shareId);
    if (!d || !(await this.stepAt(d.id, 'signee'))) {
      await this.event(viewer, 'partage.visite_refusee', `agency_share:${shareId}`, { rule: 'R234', code: 'delegation_non_signee' });
      return { ok: false, rule: 'R234', code: 'delegation_non_signee' };
    }
    const wished = typeof input.wishedAt === 'string' ? new Date(input.wishedAt) : null;
    if (!wished || Number.isNaN(wished.getTime()) || wished.toISOString() !== input.wishedAt) return { ok: false, rule: null, code: 'bad_time' };
    if (wished.getTime() <= this.now().getTime()) return { ok: false, rule: null, code: 'past_time' };
    const id = this.newId();
    await this.db.run('INSERT INTO agency_visits (id, delegation_id, network_id, wished_at, requested_by, requested_at) VALUES (?, ?, ?, ?, ?, ?)', [
      id,
      d.id,
      g.share.network_id,
      wished.toISOString(),
      this.actor(viewer),
      this.now().toISOString(),
    ]);
    await this.event(viewer, 'partage.visite', `agency_share:${shareId}`, { step: 'demandee' });
    return { ok: true, value: { visitId: id } };
  }

  /** L'agent du bien note la co-visite faite. */
  async visitDone(viewer: Viewer, shareId: string, visitId: string): Promise<Result<{ doneOn: string }>> {
    const g = await this.gate(viewer, shareId, 'agency_visit', 'owner');
    if (!g.ok) return g;
    const visit = await this.db.first<{ wished_at: string }>(
      'SELECT v.wished_at FROM agency_visits v JOIN agency_delegations d ON d.id = v.delegation_id WHERE v.id = ? AND d.share_id = ?',
      [visitId, shareId],
    );
    if (!visit) return { ok: false, rule: null, code: 'unknown_visit' };
    const at = this.now().toISOString();
    if (at < visit.wished_at) return { ok: false, rule: null, code: 'not_yet' };
    await this.db.run('INSERT INTO agency_visits_done (visit_id, at, by) VALUES (?, ?, ?) ON CONFLICT DO NOTHING', [visitId, at, this.actor(viewer)]);
    const kept = (await this.db.first<{ at: string }>('SELECT at FROM agency_visits_done WHERE visit_id = ?', [visitId]))!.at;
    if (kept === at) await this.event(viewer, 'partage.visite', `agency_share:${shareId}`, { step: 'faite' });
    return { ok: true, value: { doneOn: this.day(kept) } };
  }

  /** L'agent du bien rattache à la délégation le dossier de vente de l'acquéreur amené par l'agence. */
  async attachFile(viewer: Viewer, shareId: string, fileId: string): Promise<Result<{ attachedOn: string }>> {
    const g = await this.gate(viewer, shareId, 'agency_delegation_file', 'owner');
    if (!g.ok) return g;
    const d = await this.delegationOf(shareId);
    if (!d || !(await this.stepAt(d.id, 'signee'))) return { ok: false, rule: 'R234', code: 'delegation_non_signee' };
    const file = await this.db.first<{ property_id: string }>('SELECT property_id FROM sale_files WHERE id = ? AND network_id = ?', [fileId, viewer.networkId]);
    if (!file || file.property_id !== g.share.property_id) return { ok: false, rule: null, code: 'unknown_file' };
    if (await this.db.first('SELECT 1 FROM sale_file_stops WHERE file_id = ?', [fileId])) return { ok: false, rule: null, code: 'file_stopped' };
    const current = await this.db.first<{ file_id: string; at: string }>('SELECT file_id, at FROM agency_delegation_files WHERE delegation_id = ?', [d.id]);
    if (current) return current.file_id === fileId ? { ok: true, value: { attachedOn: this.day(current.at) } } : { ok: false, rule: 'R235', code: 'already_attached' };
    if (await this.db.first('SELECT 1 FROM agency_delegation_files WHERE file_id = ?', [fileId])) return { ok: false, rule: 'R235', code: 'file_taken' };
    // Une commission déjà prévue ne change plus (HX59) : l'écart va au journal, la direction tranche.
    if (await this.db.first('SELECT 1 FROM commissions WHERE file_id = ?', [fileId])) {
      await this.event(viewer, 'partage.ecart', `agency_share:${shareId}`, { rule: 'R235', code: 'commission_prevue' });
      return { ok: false, rule: 'R235', code: 'commission_prevue' };
    }
    const at = this.now().toISOString();
    const { changes } = await this.db.run('INSERT INTO agency_delegation_files (delegation_id, file_id, at, by) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING', [d.id, fileId, at, this.actor(viewer)]);
    if (changes !== 1) return { ok: false, rule: 'R235', code: 'already_attached' };
    await this.event(viewer, 'partage.dossier', `agency_share:${shareId}`, { step: 'rattache' });
    return { ok: true, value: { attachedOn: this.day(at) } };
  }

  /** Où en est le partage, en direct, pour l'agence, l'agent du bien et la direction. */
  async progress(viewer: Viewer, shareId: string): Promise<Result<DelegationProgress>> {
    const g = await this.gate(viewer, shareId, 'agency_progress', 'read');
    if (!g.ok) return g;
    const value = await this.progressOf(shareId);
    // Chaque lecture réussie est écrite au journal de qui lit, avant de rendre la réponse [R16].
    await this.event(viewer, 'partage.lu', `agency_share:${shareId}`, { kind: 'progress' });
    return { ok: true, value };
  }

  private async progressOf(shareId: string): Promise<DelegationProgress> {
    const share = (await this.share(shareId))!;
    const steps: ({ stage: DelegationStage; at: string } | { stage: DelegationStage; day: string | null })[] = [{ stage: 'partage', at: share.shared_at }];
    const d = await this.delegationOf(shareId);
    let fileId: string | null = null;
    if (d) {
      steps.push({ stage: 'delegation_proposee', at: d.proposed_at });
      const accepted = await this.stepAt(d.id, 'acceptee');
      if (accepted) steps.push({ stage: 'delegation_acceptee', at: accepted });
      const signed = await this.stepAt(d.id, 'signee');
      if (signed) steps.push({ stage: 'delegation_signee', at: signed });
      const asked = await this.db.first<{ at: string | null }>('SELECT MIN(requested_at) AS at FROM agency_visits WHERE delegation_id = ?', [d.id]);
      if (asked?.at) steps.push({ stage: 'visite_demandee', at: asked.at });
      const done = await this.db.first<{ at: string | null }>(
        'SELECT MIN(x.at) AS at FROM agency_visits_done x JOIN agency_visits v ON v.id = x.visit_id WHERE v.delegation_id = ?',
        [d.id],
      );
      if (done?.at) steps.push({ stage: 'visite_faite', at: done.at });
      const file = await this.db.first<{ file_id: string; at: string }>('SELECT file_id, at FROM agency_delegation_files WHERE delegation_id = ?', [d.id]);
      if (file) {
        fileId = file.file_id;
        steps.push({ stage: 'dossier_ouvert', at: file.at });
        // Le jour du compromis et celui de l'acte, tels que rapportés au dossier : la dernière version vaut.
        const compromis = await this.db.first<{ day: string }>("SELECT day FROM sale_file_dates WHERE file_id = ? AND kind = 'compromis_signe' ORDER BY version DESC LIMIT 1", [fileId]);
        if (compromis) steps.push({ stage: 'compromis_signe', day: compromis.day });
        const closing = await this.db.first<{ signed_on: string }>('SELECT signed_on FROM sale_file_closings WHERE file_id = ?', [fileId]);
        if (closing) steps.push({ stage: 'acte_signe', day: closing.signed_on });
        const stop = await this.db.first<{ at: string }>('SELECT at FROM sale_file_stops WHERE file_id = ?', [fileId]);
        if (stop) steps.push({ stage: 'arrete', at: stop.at });
      }
    }
    if (!fileId) {
      // Sans dossier de l'agence, le bien vendu ou retiré par ailleurs se dit, sans dire pourquoi ni à qui.
      const status = (await this.db.first<{ status: string }>('SELECT status FROM properties WHERE id = ?', [share.property_id]))!.status;
      if (status !== 'available') steps.push({ stage: 'bien_indisponible', day: null });
    }
    const last = steps[steps.length - 1]!;
    return { stage: last.stage, steps: steps.map((s) => ({ stage: s.stage, on: 'day' in s ? s.day : this.day(s.at) })) };
  }

  /**
   * Le relevé du partage : calculé une seule fois, à l'acte signé, sur les honoraires dus de N06, au partage du bon,
   * jamais saisi. `null` avant l'acte [R235].
   */
  async statement(viewer: Viewer, shareId: string): Promise<Result<FeeStatement | null>> {
    const g = await this.gate(viewer, shareId, 'agency_statement', 'read');
    if (!g.ok) return g;
    const value = await this.ensureStatement(g.share);
    await this.event(viewer, 'partage.lu', `agency_share:${shareId}`, { kind: 'statement' });
    return { ok: true, value };
  }

  /** Le relevé rangé, ou calculé et rangé s'il est dû ; `null` sans délégation, sans dossier rattaché ou avant l'acte. */
  private async ensureStatement(share: ShareRow): Promise<FeeStatement | null> {
    const d = await this.delegationOf(share.id);
    if (!d) return null;
    const row = await this.statementRow(d.id);
    if (row) return row;
    const due = await this.db.first<{ file_id: string; fee_eur: number }>(
      `SELECT f.file_id, c.fee_eur FROM agency_delegation_files f
       JOIN sale_file_closings k ON k.file_id = f.file_id
       JOIN sale_commissions c ON c.file_id = f.file_id
       WHERE f.delegation_id = ?`,
      [d.id],
    );
    if (!due) return null;
    // AU091b · une vente suivie par les commissions attend qu'elle soit due : un avenant d'honoraires se régularise
    // d'abord, et le relevé se calcule une fois, sur les honoraires régularisés [R678, R235].
    const c = await this.db.first<{ fee_cents: number; due: number; revised: number }>(
      `SELECT c.fee_cents,
              EXISTS (SELECT 1 FROM commission_steps s WHERE s.file_id = c.file_id AND s.status = 'due') AS due,
              EXISTS (SELECT 1 FROM commission_revisions r WHERE r.file_id = c.file_id) AS revised
         FROM commissions c WHERE c.file_id = ?`,
      [due.file_id],
    );
    if (c && !Number(c.due)) return null;
    const feeCents = c && Number(c.revised) ? Number(c.fee_cents) : due.fee_eur * 100;
    const split = splitAgencyFee(feeCents, d.partner_share_bp);
    const { changes } = await this.db.run(
      `INSERT INTO agency_fee_statements (delegation_id, network_id, file_id, fee_cents, partner_share_bp, partner_cents, own_cents, computed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
      [d.id, share.network_id, due.file_id, feeCents, d.partner_share_bp, split.partnerCents, split.ownCents, this.now().toISOString()],
    );
    if (changes === 1) await appendEvent(this.journal, { type: 'partage.releve', actor: 'system:partage', subject: `agency_share:${share.id}`, data: { rule: 'R235' } }, this.now);
    return this.statementRow(d.id);
  }

  private async statementRow(delegationId: string): Promise<FeeStatement | null> {
    const r = await this.db.first<{ fee_cents: number; partner_share_bp: number; partner_cents: number; own_cents: number; received_at: string | null }>(
      `SELECT s.fee_cents, s.partner_share_bp, s.partner_cents, s.own_cents, i.received_at
       FROM agency_fee_statements s LEFT JOIN agency_partner_invoices i ON i.delegation_id = s.delegation_id
       WHERE s.delegation_id = ?`,
      [delegationId],
    );
    if (!r) return null;
    return {
      feeCents: r.fee_cents,
      partnerShareBp: r.partner_share_bp,
      partnerCents: r.partner_cents,
      ownCents: r.own_cents,
      partnerInvoiceReceivedOn: r.received_at ? this.day(r.received_at) : null,
    };
  }

  /**
   * La direction range la facture de rétrocession reçue de l'agence : seulement au montant exact du relevé, une seule
   * fois [R235].
   */
  async recordPartnerInvoice(viewer: Viewer, shareId: string, input: { ttcCents: unknown; proofRef: unknown }): Promise<Result<{ receivedOn: string }>> {
    if (viewer.role !== 'direction') return this.refuse(viewer, `agency_share:${shareId}`, 'agency_invoice', 'role');
    const g = await this.gate(viewer, shareId, 'agency_invoice', 'read');
    if (!g.ok) return g;
    const d = await this.delegationOf(shareId);
    // Le relevé dû est calculé ici s'il ne l'a pas encore été : la facture ne dépend d'aucune lecture d'avant.
    const st = await this.ensureStatement(g.share);
    if (!d || !st) return { ok: false, rule: 'R235', code: 'no_statement' };
    if (typeof input.ttcCents !== 'number' || !Number.isInteger(input.ttcCents) || input.ttcCents !== st.partnerCents) {
      await this.event(viewer, 'partage.facture_refusee', `agency_share:${shareId}`, { rule: 'R235', code: 'montant_different' });
      return { ok: false, rule: 'R235', code: 'montant_different' };
    }
    if (typeof input.proofRef !== 'string' || !PROOF_REF.test(input.proofRef)) return { ok: false, rule: null, code: 'bad_proof' };
    if (!(await this.proofs.has(input.proofRef))) return { ok: false, rule: null, code: 'not_stored' };
    const at = this.now().toISOString();
    const { changes } = await this.db.run(
      'INSERT INTO agency_partner_invoices (delegation_id, network_id, proof_ref, ttc_cents, received_at, by) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING',
      [d.id, g.share.network_id, input.proofRef, input.ttcCents, at, this.actor(viewer)],
    );
    if (changes !== 1) return { ok: false, rule: 'R235', code: 'already_received' };
    await this.event(viewer, 'partage.facture', `agency_share:${shareId}`, { rule: 'R235', step: 'recue' });
    return { ok: true, value: { receivedOn: this.day(at) } };
  }
}
