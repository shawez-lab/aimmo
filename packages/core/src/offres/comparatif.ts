/**
 * Tableau comparatif des offres pour le vendeur (M09, O06) [R14, R56, R57].
 *
 * Pour un bien, toutes les offres reçues, côte à côte, dans l'ordre d'arrivée du registre : montant (celui de la dernière
 * proposition quand il y a eu des contre-offres), net vendeur après les honoraires du mandat en vigueur, conditions
 * suspensives, jours de validité restants, état. Aucun tri, aucune note, aucune recommandation : c'est au vendeur, avec
 * son agent, de choisir. Aucune donnée sur l'acquéreur : ni nom, ni coordonnée, ni financement.
 *
 * Décidé, lecture prudente : le net vendeur est le montant moins les honoraires fixés au mandat (en euros), quel que soit
 * celui qui les paie ; la date de signature souhaitée n'est pas encore saisie dans l'offre, elle n'est pas montrée.
 */
import type { Acces } from '../acces/acces.ts';
import type { Viewer } from '../acces/droits.ts';
import type { SqlDatabase } from '../db/sql.ts';
import type { DocumentFacts } from '../documents/modeles.ts';
import { Diffusion } from '../documents/retractation.ts';
import { localTime } from '../envoi/horaires.ts';
import type { JournalStore } from '../journal/types.ts';
import { ContreOffres } from './contre-offres.ts';
import { RegistreOffres, type ConditionKind } from './registre-offres.ts';
import { TransmissionOffres, type OfferState } from './transmission.ts';

const TIME_ZONE = 'Europe/Paris';

export interface ComparisonRow {
  /** Rang d'arrivée au registre. */
  seq: number;
  amountEur: number;
  /** Montant moins les honoraires du mandat ; null sans mandat lisible. */
  netSellerEur: number | null;
  conditions: ConditionKind[];
  /** Jours de validité restants, à Paris : 0 le dernier jour ; null une fois échue ou répondue. */
  daysLeft: number | null;
  state: OfferState;
  /** Nombre de propositions échangées après l'offre. */
  counterProposals: number;
}

type Refusal = { ok: false; rule: 'R16'; code: string };

const dayNumber = (d: string): number => Math.round(Date.parse(`${d}T12:00:00Z`) / 86_400_000);

export class ComparatifOffres {
  private readonly now: () => Date;
  private readonly registre: RegistreOffres;
  private readonly transmission: TransmissionOffres;
  private readonly contre: ContreOffres;
  private readonly diffusion: Diffusion;

  constructor(
    private readonly db: SqlDatabase,
    acces: Acces,
    journal: JournalStore,
    options: { now?: () => Date } = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.registre = new RegistreOffres(db, acces, journal, { now: this.now });
    this.transmission = new TransmissionOffres(db, acces, journal, { now: this.now });
    this.contre = new ContreOffres(db, acces, journal, { now: this.now });
    this.diffusion = new Diffusion(db, acces, journal, { now: this.now });
  }

  /** Les honoraires du mandat en vigueur du bien, en euros, ou null. */
  private async fee(networkId: string, propertyId: string): Promise<number | null> {
    const d = await this.diffusion.canDiffuse(networkId, propertyId, this.now());
    if (!d.mandateId) return null;
    const row = await this.db.first<{ facts: string | null }>('SELECT d.facts FROM signed_documents s JOIN documents d ON d.id = s.document_id WHERE s.mandate_id = ? AND s.copy_content IS NOT NULL', [d.mandateId]);
    try {
      const facts = row?.facts ? (JSON.parse(row.facts) as DocumentFacts) : null;
      return typeof facts?.feeEur === 'number' ? facts.feeEur : null;
    } catch {
      return null;
    }
  }

  /** Le tableau du bien, pour l'agent du bien ou la direction [R16], dans l'ordre d'arrivée, sans tri. */
  async table(viewer: Viewer, propertyId: string): Promise<{ ok: true; value: { count: number; registerIntact: boolean; rows: ComparisonRow[] } } | Refusal | { ok: false; rule: null; code: string }> {
    const list = await this.registre.list(viewer, propertyId);
    if (!list.ok) return list as Refusal | { ok: false; rule: null; code: string };
    const fee = await this.fee(viewer.networkId, propertyId);
    const today = localTime(this.now(), TIME_ZONE).date;
    const rows: ComparisonRow[] = [];
    for (const offer of list.value) {
      const chain = (await this.contre.history(viewer, offer.id));
      const proposals = chain.ok ? chain.value.filter((e) => e.event.startsWith('proposition:') && e.amountEur !== undefined) : [];
      const last = proposals[proposals.length - 1];
      const amount = last?.amountEur ?? offer.amountEur;
      let state = await this.transmission.stateOf(offer);
      let lastDay = offer.validUntil;
      // Une proposition déjà remplacée par une contre-offre n'a plus de délai à compter.
      let replaced = false;
      // Après des contre-offres, l'état et la validité sont ceux de la dernière proposition.
      if (last && chain.ok) {
        const answered = chain.value.filter((e) => /^proposition:\d+:(acceptee|refusee|contre_offre)$/.test(e.event)).pop();
        const lastSeq = Number(last.event.split(':')[1]);
        const outcome = answered && Number(answered.event.split(':')[1]) === lastSeq ? answered.event.split(':')[2] : null;
        if (outcome === 'acceptee' || outcome === 'refusee') state = outcome;
        const proposal = await this.db.first<{ valid_until: string }>('SELECT valid_until FROM offer_proposals WHERE offer_id = ? AND seq = ?', [offer.id, lastSeq]);
        if (proposal) lastDay = proposal.valid_until;
        if (outcome === null) state = today > lastDay ? 'echue' : 'contre_offre';
        replaced = outcome === 'contre_offre';
      }
      const open = !replaced && (state === 'recue' || state === 'transmise' || (last !== undefined && state === 'contre_offre'));
      rows.push({
        seq: offer.seq,
        amountEur: amount,
        netSellerEur: fee === null ? null : amount - fee,
        conditions: offer.conditions.map((c) => c.kind),
        daysLeft: open ? dayNumber(lastDay) - dayNumber(today) : null,
        state,
        counterProposals: proposals.length,
      });
    }
    // Toutes les offres reçues y figurent, et le vendeur voit que le registre est intact [R56].
    const check = await this.registre.check(propertyId);
    return { ok: true, value: { count: rows.length, registerIntact: check.ok, rows } };
  }
}
