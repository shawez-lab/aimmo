/**
 * Le suivi des offres d'un bien, pour l'écran de l'agent (O10) [R14, R16, R56, R57].
 *
 * « Jamais vu » : chaque offre dit son seul prochain pas, tiré de ses faits rangés (`nextStep`), et l'écran montre si le
 * registre du bien est intact. Le pas ne conseille rien : il dit ce que la règle attend, jamais quoi répondre ni quelle
 * offre préférer. Les offres restent dans l'ordre d'arrivée, sans tri ni note [R14, R57].
 */
import type { Acces } from '../acces/acces.ts';
import type { Viewer } from '../acces/droits.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { LIVE_MANDATES } from '../espaces/lecture.ts';
import type { JournalStore } from '../journal/types.ts';
import { ComparatifOffres, type ComparisonRow } from './comparatif.ts';
import { ContreOffres, type Proposal } from './contre-offres.ts';
import { RegistreOffres, type Offer, type OfferCondition } from './registre-offres.ts';
import { TransmissionOffres, type OfferState } from './transmission.ts';

export const MAX_BUYER_CONTACTS = 500;

export type OfferNextStep =
  | 'transmettre'
  | 'reponse_vendeur'
  | 'ranger_proposition'
  | 'transmettre_proposition'
  | 'reponse_proposition'
  | 'ouvrir_dossier'
  | 'preparer_compromis'
  | 'aucun';

export interface OfferStepFacts {
  state: OfferState;
  transmitted: boolean;
  /** La dernière proposition de la chaîne, ou null. */
  last: Pick<Proposal, 'transmittedAt' | 'response'> | null;
  file: { compromisStarted: boolean } | null;
  /** Une autre offre du bien est déjà acceptée, ou a son dossier. */
  otherTaken: boolean;
}

/** Le seul prochain pas d'une offre, tiré de ses faits : une fonction pure, sans conseil ni préférence [R57]. */
export function nextStep(f: OfferStepFacts): OfferNextStep {
  if (f.file) return f.file.compromisStarted ? 'aucun' : 'preparer_compromis';
  // Toute offre reçue est transmise au vendeur, même échue [R56].
  if (!f.transmitted) return 'transmettre';
  if (f.state === 'acceptee') return f.otherTaken ? 'aucun' : 'ouvrir_dossier';
  if (f.state === 'refusee' || f.state === 'echue') return 'aucun';
  if (f.state === 'transmise') return 'reponse_vendeur';
  // Une réponse « contre-offre » : la chaîne dit où l'on en est.
  if (f.state === 'contre_offre') {
    if (!f.last || f.last.response?.outcome === 'contre_offre') return 'ranger_proposition';
    if (!f.last.transmittedAt) return 'transmettre_proposition';
    if (!f.last.response) return 'reponse_proposition';
  }
  return 'aucun';
}

export interface OfferBoardLine extends ComparisonRow {
  id: string;
  buyer: { firstName: string | null; lastName: string | null } | null;
  offeredEur: number;
  conditionDetails: OfferCondition[];
  validUntil: string;
  downPaymentEur: number;
  loanEur: number;
  next: OfferNextStep;
  /** La proposition que le prochain pas concerne, s'il y en a une. */
  proposalId: string | null;
  file: { id: string; compromisStarted: boolean } | null;
  history: { at: string; event: string; amountEur?: number }[];
}

type Failure = { ok: false; rule: string | null; code: string };

export class SuiviOffres {
  private readonly registre: RegistreOffres;
  private readonly comparatif: ComparatifOffres;
  private readonly contre: ContreOffres;
  private readonly transmission: TransmissionOffres;

  constructor(
    private readonly db: SqlDatabase,
    private readonly acces: Acces,
    journal: JournalStore,
    options: { now?: () => Date } = {},
  ) {
    this.registre = new RegistreOffres(db, acces, journal, options);
    this.comparatif = new ComparatifOffres(db, acces, journal, options);
    this.contre = new ContreOffres(db, acces, journal, options);
    this.transmission = new TransmissionOffres(db, acces, journal, options);
  }

  /** L'acquéreur, seulement si celui qui lit voit sa fiche en entier ; sinon l'offre reste lisible, sans nom [R16]. */
  private async buyer(viewer: Viewer, offer: Offer): Promise<OfferBoardLine['buyer']> {
    const read = await this.acces.readFiche(viewer, offer.buyerPersonId);
    if (!read.ok || read.view !== 'full') return null;
    return { firstName: read.value.person.first_name, lastName: read.value.person.last_name };
  }

  /** Les offres du bien dans l'ordre d'arrivée, chacune avec son prochain pas, pour l'agent du bien ou la direction [R16]. */
  async board(viewer: Viewer, propertyId: string): Promise<{ ok: true; value: { count: number; registerIntact: boolean; offers: OfferBoardLine[] } } | Failure> {
    const table = await this.comparatif.table(viewer, propertyId);
    if (!table.ok) return table;
    const list = await this.registre.list(viewer, propertyId);
    if (!list.ok) return list;
    const offers: OfferBoardLine[] = [];
    for (const offer of list.value) {
      const row = table.value.rows.find((r) => r.seq === offer.seq);
      // Une ligne arrivée entre les deux lectures : relue au prochain chargement, jamais montrée à moitié.
      if (!row) continue;
      const chain = await this.contre.chain(offer.id);
      const last = chain[chain.length - 1] ?? null;
      const transmitted = await this.db.first('SELECT offer_id FROM offer_transmissions WHERE offer_id = ?', [offer.id]);
      const fileRow = await this.db.first<{ id: string }>('SELECT id FROM sale_files WHERE offer_id = ?', [offer.id]);
      const file = fileRow
        ? { id: fileRow.id, compromisStarted: !!(await this.db.first("SELECT file_id FROM sale_file_steps WHERE file_id = ? AND step = 'compromis_en_preparation'", [fileRow.id])) }
        : null;
      const history = await this.contre.history(viewer, offer.id);
      const next = nextStep({ state: row.state, transmitted: !!transmitted, last, file, otherTaken: await this.transmission.otherAccepted(propertyId, offer.id) });
      offers.push({
        ...row,
        id: offer.id,
        buyer: await this.buyer(viewer, offer),
        offeredEur: offer.amountEur,
        conditionDetails: offer.conditions,
        validUntil: last?.validUntil ?? offer.validUntil,
        downPaymentEur: offer.downPaymentEur,
        loanEur: offer.loanEur,
        next,
        proposalId: next === 'transmettre_proposition' || next === 'reponse_proposition' ? (last?.id ?? null) : null,
        file,
        history: history.ok ? history.value : [],
      });
    }
    return { ok: true, value: { count: table.value.count, registerIntact: table.value.registerIntact, offers } };
  }

  /** Les contacts qui peuvent être l'acquéreur : ceux que le lecteur voit en entier, jamais le mandant du bien [R16]. */
  async buyers(viewer: Viewer, propertyId: string): Promise<{ ok: true; value: { contacts: { personId: string; firstName: string | null; lastName: string | null }[]; more: boolean } } | Failure> {
    const gate = await this.registre.gate(viewer, propertyId);
    if (!gate.ok) return gate;
    const agent = viewer.role === 'agent' ? viewer.userId : null;
    const rows = await this.db.all<{ id: string; first_name: string | null; last_name: string | null }>(
      `SELECT p.id, p.first_name, p.last_name FROM persons p
       WHERE p.network_id = ? AND (? IS NULL OR p.agent_id = ?)
         AND NOT EXISTS (SELECT 1 FROM person_merges m WHERE m.merged_id = p.id AND m.undone_at IS NULL)
         AND (? IS NULL OR NOT EXISTS (
           SELECT 1 FROM person_merges m JOIN persons c ON c.id = m.merged_id
           WHERE m.survivor_id = p.id AND m.undone_at IS NULL AND c.agent_id IS NOT ?))
         AND p.id NOT IN (SELECT person_id FROM (${LIVE_MANDATES}) WHERE property_id = ?)
       ORDER BY p.last_name, p.first_name, p.id LIMIT ?`,
      [gate.networkId, agent, agent, agent, agent, gate.networkId, propertyId, MAX_BUYER_CONTACTS + 1],
    );
    return {
      ok: true,
      value: {
        contacts: rows.slice(0, MAX_BUYER_CONTACTS).map((r) => ({ personId: r.id, firstName: r.first_name, lastName: r.last_name })),
        more: rows.length > MAX_BUYER_CONTACTS,
      },
    };
  }
}
