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
import { FicheClient } from '../db/fiche-client.ts';
import { LIVE_MANDATES } from '../espaces/lecture.ts';
import { FicheUnique } from '../fiche/fusion.ts';
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
  if (f.state === 'refusee') return 'aucun';
  // Échue sans réponse rangée : un refus, ou une acceptation donnée à temps et rapportée après, se range encore [R59].
  if (f.state === 'echue') {
    if (!f.last) return 'reponse_vendeur';
    return f.last.transmittedAt ? 'reponse_proposition' : 'transmettre_proposition';
  }
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
  /** Le financement et le détail des conditions : null ou réduits à leur sorte sans le droit de voir l'acquéreur [R16]. */
  conditionDetails: (OfferCondition | { kind: string })[];
  validUntil: string;
  downPaymentEur: number | null;
  loanEur: number | null;
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
  private readonly unique: FicheUnique;

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
    this.unique = new FicheUnique(db, new FicheClient(db), options);
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
      const buyer = await this.buyer(viewer, offer);
      const next = nextStep({ state: row.state, transmitted: !!transmitted, last, file, otherTaken: await this.transmission.otherAccepted(propertyId, offer.id) });
      offers.push({
        ...row,
        id: offer.id,
        buyer,
        offeredEur: offer.amountEur,
        conditionDetails: buyer ? offer.conditions : offer.conditions.map((c) => ({ kind: c.kind })),
        validUntil: last?.validUntil ?? offer.validUntil,
        downPaymentEur: buyer ? offer.downPaymentEur : null,
        loanEur: buyer ? offer.loanEur : null,
        next,
        proposalId: next === 'transmettre_proposition' || next === 'reponse_proposition' ? (last?.id ?? null) : null,
        file,
        history: history.ok ? history.value : [],
      });
    }
    return { ok: true, value: { count: table.value.count, registerIntact: table.value.registerIntact, offers } };
  }

  /**
   * Le registre du bien, tel qu'il se lit par la route : une offre dont le lecteur ne voit pas l'acquéreur garde son rang,
   * son montant et ses dates, sans l'acquéreur, son financement, ni le détail de ses conditions [R16].
   */
  async listFor(viewer: Viewer, propertyId: string): Promise<{ ok: true; value: unknown[] } | Failure> {
    const list = await this.registre.list(viewer, propertyId);
    if (!list.ok) return list;
    const out: unknown[] = [];
    for (const offer of list.value) {
      out.push((await this.buyer(viewer, offer)) ? offer : { ...offer, buyerPersonId: null, downPaymentEur: null, loanEur: null, signedRef: null, conditions: offer.conditions.map((c) => ({ kind: c.kind })) });
    }
    return { ok: true, value: out };
  }

  /** Les contacts qui peuvent être l'acquéreur : ceux que le lecteur voit en entier, jamais le mandant du bien [R16]. */
  async buyers(viewer: Viewer, propertyId: string): Promise<{ ok: true; value: { contacts: { personId: string; firstName: string | null; lastName: string | null }[]; more: boolean } } | Failure> {
    const gate = await this.registre.gate(viewer, propertyId);
    if (!gate.ok) return gate;
    // La liste passe par les droits et s'écrit au journal, fiches réunies comprises [R16].
    const listed = await this.acces.listPersons(viewer);
    if (!listed.ok) return listed as Failure;
    const merged = new Set((await this.db.all<{ merged_id: string }>('SELECT merged_id FROM person_merges WHERE network_id = ? AND undone_at IS NULL', [gate.networkId])).map((r) => r.merged_id));
    // Le mandant du bien, sous toutes ses fiches : il ne s'achète pas son bien.
    const sellers = new Set<string>();
    for (const m of await this.db.all<{ person_id: string }>(`SELECT person_id FROM (${LIVE_MANDATES}) WHERE property_id = ?`, [gate.networkId, propertyId])) {
      for (const id of await this.unique.membersOf(m.person_id)) sellers.add(id);
    }
    const rows = listed.value
      .filter((p) => !merged.has(p.id) && !sellers.has(p.id))
      .sort((a, b) => `${a.last_name ?? ''} ${a.first_name ?? ''} ${a.id}`.localeCompare(`${b.last_name ?? ''} ${b.first_name ?? ''} ${b.id}`, 'fr'));
    return {
      ok: true,
      value: {
        contacts: rows.slice(0, MAX_BUYER_CONTACTS).map((r) => ({ personId: r.id, firstName: r.first_name, lastName: r.last_name })),
        more: rows.length > MAX_BUYER_CONTACTS,
      },
    };
  }
}
