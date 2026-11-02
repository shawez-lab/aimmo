/**
 * Contre-offres et historique de la négociation (M09, O04) [R57].
 *
 * Quand le vendeur répond à une offre par une contre-offre, l'agent range la proposition du vendeur (montant, validité,
 * preuve), la transmet à l'acquéreur et rapporte sa réponse ; l'acquéreur peut à son tour contre-proposer, et ainsi de
 * suite. Chaque proposition n'existe que si la précédente a reçu une réponse « contre-offre » ; les montants sont ceux
 * que les parties ont donnés, jamais calculés ni suggérés par le système. Une proposition remplacée a déjà sa réponse :
 * elle ne peut plus être acceptée. La suite se lit dans l'ordre, chaque étape avec son heure.
 *
 * Décidé, lecture prudente : les propositions sont transmises de vive voix ou par écrit, attesté par l'agent (le message
 * par le contrôle central viendra avec l'espace acquéreur) ; une réponse ne précède jamais la transmission ; une
 * proposition échue ne peut plus être acceptée [R59].
 */
import type { Acces } from '../acces/acces.ts';
import type { Viewer } from '../acces/droits.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { localTime } from '../envoi/horaires.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import { ISO_INSTANT, PROOF_REF, TransmissionOffres } from './transmission.ts';

const TIME_ZONE = 'Europe/Paris';
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const MAX_VALIDITY_DAYS = 60;

export interface Proposal {
  id: string;
  offerId: string;
  seq: number;
  side: 'vendeur' | 'acquereur';
  amountEur: number;
  validUntil: string;
  at: string;
  transmittedAt: string | null;
  response: { outcome: 'acceptee' | 'refusee' | 'contre_offre'; respondedAt: string } | null;
}

type Refusal = { ok: false; rule: 'R16'; code: string };
type Problem =
  | { ok: false; rule: null; code: 'unknown_offer' | 'unknown_property' | 'unknown_proposal' | 'no_counter_asked' | 'bad_amount' | 'bad_date' | 'bad_proof' | 'bad_via' | 'bad_outcome' | 'already_transmitted' | 'already_answered' | 'not_transmitted' | 'busy' | 'no_owner' | 'already_recorded' | 'other_accepted' }
  | { ok: false; rule: 'R59'; code: 'expired' }
  | { ok: false; rule: string; code: 'message_refused'; reason: string };

interface Row {
  id: string;
  offer_id: string;
  seq: number;
  side: 'vendeur' | 'acquereur';
  amount_eur: number;
  valid_until: string;
  at: string;
  transmitted_at: string | null;
  outcome: 'acceptee' | 'refusee' | 'contre_offre' | null;
  responded_at: string | null;
}

const SELECT = `SELECT p.id, p.offer_id, p.seq, p.side, p.amount_eur, p.valid_until, p.at, t.at AS transmitted_at, r.outcome, r.responded_at
  FROM offer_proposals p LEFT JOIN proposal_transmissions t ON t.proposal_id = p.id LEFT JOIN proposal_responses r ON r.proposal_id = p.id`;

const toProposal = (r: Row): Proposal => ({
  id: r.id,
  offerId: r.offer_id,
  seq: Number(r.seq),
  side: r.side,
  amountEur: Number(r.amount_eur),
  validUntil: r.valid_until,
  at: r.at,
  transmittedAt: r.transmitted_at,
  response: r.outcome && r.responded_at ? { outcome: r.outcome, respondedAt: r.responded_at } : null,
});

const addDays = (day: string, n: number): string => new Date(Date.parse(`${day}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const validDay = (d: unknown): d is string => typeof d === 'string' && DAY.test(d) && Number.isFinite(Date.parse(`${d}T12:00:00Z`)) && new Date(`${d}T12:00:00Z`).toISOString().slice(0, 10) === d;

export class ContreOffres {
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly offers: TransmissionOffres;

  constructor(
    private readonly db: SqlDatabase,
    acces: Acces,
    private readonly journal: JournalStore,
    options: { now?: () => Date; newId?: () => string } = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => crypto.randomUUID());
    this.offers = new TransmissionOffres(db, acces, journal, { now: this.now, newId: this.newId });
  }

  private actor(viewer: Viewer): string {
    return `${String(viewer.role)}:${viewer.userId}`;
  }

  /** Les propositions de l'offre, dans l'ordre. Sans droits : l'appelant a déjà passé ceux de l'offre [R16]. */
  async chain(offerId: string): Promise<Proposal[]> {
    return (await this.db.all<Row>(`${SELECT} WHERE p.offer_id = ? ORDER BY p.seq`, [offerId])).map(toProposal);
  }

  /** La proposition suivante, rapportée par l'agent du bien : seulement si la précédente a reçu une contre-offre. */
  async propose(viewer: Viewer, offerId: string, input: { amountEur: unknown; validUntil: unknown; proofRef: unknown }): Promise<{ ok: true; value: Proposal } | Refusal | Problem> {
    const found = await this.offers.offerFor(viewer, offerId, true);
    if (!found.ok) return found as Refusal | Problem;
    if (typeof input.amountEur !== 'number' || !Number.isInteger(input.amountEur) || input.amountEur <= 0 || input.amountEur > 100_000_000) return { ok: false, rule: null, code: 'bad_amount' };
    if (typeof input.proofRef !== 'string' || !PROOF_REF.test(input.proofRef)) return { ok: false, rule: null, code: 'bad_proof' };
    const today = localTime(this.now(), TIME_ZONE).date;
    if (!validDay(input.validUntil) || input.validUntil < today || input.validUntil > addDays(today, MAX_VALIDITY_DAYS)) return { ok: false, rule: null, code: 'bad_date' };
    const chain = await this.chain(offerId);
    const last = chain[chain.length - 1];
    if (last) {
      if (last.response?.outcome !== 'contre_offre') return { ok: false, rule: null, code: 'no_counter_asked' };
    } else {
      const answer = await this.db.first<{ outcome: string }>('SELECT outcome FROM offer_responses WHERE offer_id = ?', [offerId]);
      if (answer?.outcome !== 'contre_offre') return { ok: false, rule: null, code: 'no_counter_asked' };
    }
    const seq = (last?.seq ?? 0) + 1;
    const side = seq % 2 === 1 ? 'vendeur' : 'acquereur';
    const id = this.newId();
    try {
      await this.db.run(
        'INSERT INTO offer_proposals (id, offer_id, network_id, seq, side, amount_eur, valid_until, proof_ref, created_by, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [id, offerId, found.networkId, seq, side, input.amountEur, input.validUntil, input.proofRef, this.actor(viewer), this.now().toISOString()],
      );
    } catch (error) {
      if (/UNIQUE/i.test(String(error))) return { ok: false, rule: null, code: 'already_recorded' };
      throw error;
    }
    await appendEvent(this.journal, { type: 'offre.proposition', actor: this.actor(viewer), subject: `offer:${offerId}`, data: { rule: 'R57', seq, side } }, this.now);
    const row = await this.db.first<Row>(`${SELECT} WHERE p.id = ?`, [id]);
    return { ok: true, value: toProposal(row!) };
  }

  private async proposalFor(viewer: Viewer, proposalId: string): Promise<{ ok: true; proposal: Proposal; chain: Proposal[] } | Refusal | Problem> {
    const row = await this.db.first<{ offer_id: string; network_id: string }>('SELECT offer_id, network_id FROM offer_proposals WHERE id = ?', [proposalId]);
    if (!row || row.network_id !== viewer.networkId) {
      await appendEvent(this.journal, { type: 'acces.refuse', actor: this.actor(viewer), subject: `proposal:${proposalId}`, data: { rule: 'R16', role: String(viewer.role), kind: 'offer', code: 'unknown' } }, this.now);
      return { ok: false, rule: null, code: 'unknown_proposal' };
    }
    const found = await this.offers.offerFor(viewer, row.offer_id, true);
    if (!found.ok) return found as Refusal | Problem;
    const chain = await this.chain(row.offer_id);
    return { ok: true, proposal: chain.find((p) => p.id === proposalId)!, chain };
  }

  /** La transmission de la proposition à l'autre partie, attestée par l'agent du bien. */
  async transmit(viewer: Viewer, proposalId: string, input: { via: unknown; at?: unknown }): Promise<{ ok: true } | Refusal | Problem> {
    if (input.via !== 'telephone' && input.via !== 'en_personne' && input.via !== 'ecrit') return { ok: false, rule: null, code: 'bad_via' };
    const found = await this.proposalFor(viewer, proposalId);
    if (!found.ok) return found;
    // L'heure vraie, attestée par l'agent : ni à venir, ni avant la réponse à laquelle cette proposition fait suite.
    let at = this.now().toISOString();
    if (input.at !== undefined) {
      const before = found.chain.filter((p) => p.seq < found.proposal.seq).pop()?.response?.respondedAt
        ?? (await this.db.first<{ responded_at: string }>('SELECT responded_at FROM offer_responses WHERE offer_id = ?', [found.proposal.offerId]))?.responded_at;
      if (typeof input.at !== 'string' || !ISO_INSTANT.test(input.at) || !Number.isFinite(Date.parse(input.at)) || Date.parse(input.at) > this.now().getTime() || (before !== undefined && Date.parse(input.at) < Date.parse(before))) return { ok: false, rule: null, code: 'bad_date' };
      at = new Date(input.at).toISOString();
    }
    const { changes } = await this.db.run('INSERT INTO proposal_transmissions (proposal_id, via, at, by) VALUES (?, ?, ?, ?) ON CONFLICT (proposal_id) DO NOTHING', [proposalId, input.via, at, this.actor(viewer)]);
    if (changes !== 1) return { ok: false, rule: null, code: 'already_transmitted' };
    await appendEvent(this.journal, { type: 'offre.proposition_transmise', actor: this.actor(viewer), subject: `offer:${found.proposal.offerId}`, data: { seq: found.proposal.seq, via: input.via } }, this.now);
    return { ok: true };
  }

  /** La réponse de l'autre partie, rapportée avec preuve et heure ; jamais avant la transmission, jamais une acceptation échue [R57, R59]. */
  async respond(viewer: Viewer, proposalId: string, input: { outcome: unknown; proofRef: unknown; respondedAt: unknown }): Promise<{ ok: true } | Refusal | Problem> {
    if (input.outcome !== 'acceptee' && input.outcome !== 'refusee' && input.outcome !== 'contre_offre') return { ok: false, rule: null, code: 'bad_outcome' };
    if (typeof input.proofRef !== 'string' || !PROOF_REF.test(input.proofRef)) return { ok: false, rule: null, code: 'bad_proof' };
    if (typeof input.respondedAt !== 'string' || !ISO_INSTANT.test(input.respondedAt) || !Number.isFinite(Date.parse(input.respondedAt)) || Date.parse(input.respondedAt) > this.now().getTime()) return { ok: false, rule: null, code: 'bad_date' };
    const found = await this.proposalFor(viewer, proposalId);
    if (!found.ok) return found;
    const p = found.proposal;
    if (!p.transmittedAt) return { ok: false, rule: null, code: 'not_transmitted' };
    const at = new Date(input.respondedAt);
    if (at.getTime() < Date.parse(p.transmittedAt)) return { ok: false, rule: null, code: 'bad_date' };
    if (input.outcome === 'acceptee' && localTime(at, TIME_ZONE).date > p.validUntil) return { ok: false, rule: 'R59', code: 'expired' };
    if (input.outcome === 'acceptee') {
      const offer = await this.offers.offerFor(viewer, p.offerId, true);
      if (offer.ok && (await this.offers.otherAccepted(offer.offer.propertyId, p.offerId))) return { ok: false, rule: null, code: 'other_accepted' };
    }
    // Comme pour l'offre : l'acceptation n'est rangée que si aucune autre offre du bien n'est acceptée, dans la même instruction.
    const owner = await this.db.first<{ property_id: string }>('SELECT property_id FROM offer_register WHERE id = ?', [p.offerId]);
    const pid = owner?.property_id ?? '';
    const { changes } = await this.db.run(
      `INSERT INTO proposal_responses (proposal_id, outcome, proof_ref, responded_at, recorded_by, at)
       SELECT ?, ?, ?, ?, ?, ? WHERE (? <> 'acceptee' OR (
          NOT EXISTS (SELECT 1 FROM offer_responses r JOIN offer_register o ON o.id = r.offer_id WHERE o.property_id = ? AND o.id <> ? AND r.outcome = 'acceptee')
          AND NOT EXISTS (SELECT 1 FROM proposal_responses r JOIN offer_proposals p ON p.id = r.proposal_id JOIN offer_register o ON o.id = p.offer_id WHERE o.property_id = ? AND o.id <> ? AND r.outcome = 'acceptee')
          AND NOT EXISTS (SELECT 1 FROM sale_files f WHERE f.property_id = ? AND f.offer_id <> ?))) ON CONFLICT (proposal_id) DO NOTHING`,
      [proposalId, input.outcome, input.proofRef, at.toISOString(), this.actor(viewer), this.now().toISOString(), input.outcome, pid, p.offerId, pid, p.offerId, pid, p.offerId],
    );
    if (changes !== 1) {
      if (await this.db.first('SELECT proposal_id FROM proposal_responses WHERE proposal_id = ?', [proposalId])) return { ok: false, rule: null, code: 'already_answered' };
      return { ok: false, rule: null, code: 'other_accepted' };
    }
    await appendEvent(this.journal, { type: 'offre.proposition_reponse', actor: this.actor(viewer), subject: `offer:${p.offerId}`, data: { rule: 'R57', seq: p.seq, outcome: input.outcome } }, this.now);
    return { ok: true };
  }

  /** La suite complète de l'offre, dans l'ordre, chaque étape avec son heure. Lue par l'agent du bien ou la direction. */
  async history(viewer: Viewer, offerId: string): Promise<{ ok: true; value: { at: string; event: string; amountEur?: number }[] } | Refusal | Problem> {
    const base = await this.offers.history(viewer, offerId);
    if (!base.ok) return base as Refusal | Problem;
    const found = await this.offers.offerFor(viewer, offerId, false);
    if (!found.ok) return found as Refusal | Problem;
    const events: { at: string; event: string; amountEur?: number }[] = base.value.events.map((e) => (e.event === 'recue' ? { ...e, amountEur: found.offer.amountEur } : e));
    for (const p of await this.chain(offerId)) {
      events.push({ at: p.at, event: `proposition:${p.seq}:${p.side}`, amountEur: p.amountEur });
      if (p.transmittedAt) events.push({ at: p.transmittedAt, event: `proposition:${p.seq}:transmise` });
      if (p.response) events.push({ at: p.response.respondedAt, event: `proposition:${p.seq}:${p.response.outcome}` });
    }
    events.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
    return { ok: true, value: events };
  }

  /** La dernière proposition acceptée de l'offre, s'il y en a une : le montant convenu, pour O07. */
  async accepted(offerId: string): Promise<Proposal | null> {
    const chain = await this.chain(offerId);
    const last = chain[chain.length - 1];
    return last?.response?.outcome === 'acceptee' ? last : null;
  }
}
