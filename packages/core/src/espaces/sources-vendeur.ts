/**
 * Les lecteurs SQL de l'espace du vendeur (EC08) [R161, R163, R16, R13].
 *
 * Décidé, lecture prudente :
 * - l'espace ne refait aucun module : les lecteurs prennent ce que les modules ont rangé et calculé — le prix du mandat
 *   et de ses avenants (`mandateTerms`, D07), le tableau des offres (`ComparatifOffres`, O06 : montant après contre-offres,
 *   net vendeur, état), les comptes rendus validés et leur texte (`sellerReportText`, T06), les points de la semaine
 *   validés et leur texte (`weeklyPointText`, T07), la vue du vendeur du chemin critique (`CheminCritique`, N09) ;
 * - le mandant est la personne d'un mandat inscrit au registre, ni annulé ni rétracté ; une fiche fusionnée compte pour
 *   la fiche gardée [R161] ;
 * - un bien n'est au vendeur que si le dernier mandat vivant du bien est le sien ; tout ce qu'il montre date du premier
 *   mandat de sa dernière suite : un ancien propriétaire ne voit rien de la vente suivante, et le nouveau rien de
 *   l'ancienne [R161] ;
 * - les modules qui demandent un lecteur reçoivent la direction du réseau, sous le nom `system:espace` ; ils ne sont
 *   appelés qu'après le contrôle de l'espace, qui a vérifié que le bien est un bien du vendeur [R161, R16] ;
 * - chaque visiteur et chaque acquéreur est toujours rattaché, avec ce qui l'identifie dans toutes ses fiches réunies,
 *   pour que l'espace le retienne de tout texte [R161] ;
 * - seules les pièces du côté du vendeur sortent du dossier de vente ; celles de l'acquéreur jamais [R161].
 */
import type { Acces } from '../acces/acces.ts';
import type { Viewer } from '../acces/droits.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { mandateTerms } from '../documents/conditions.ts';
import { CheminCritique, type PartyView } from '../dossiers/chemin-critique.ts';
import { PIECE_LABELS } from '../dossiers/relances.ts';
import { expectedPieces, type Piece } from '../dossiers/pieces.ts';
import { FicheClient } from '../db/fiche-client.ts';
import { FicheUnique } from '../fiche/fusion.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import { ComparatifOffres } from '../offres/comparatif.ts';
import { sellerReportText, type VisitReport } from '../visites/compte-rendu.ts';
import { weeklyPointText, type WeeklyFigures } from '../visites/point-semaine.ts';
import type { ClientParties, ClientSide } from './entree.ts';
import { DOCUMENT_TITLES, LIVE_MANDATES, placeholders, sourcePerson } from './lecture.ts';
import { buyerSides } from './sources-acquereur.ts';
import { ownerWindows } from './sources-proprietaire.ts';
import type { SellerAppointment, SellerDeedDate, SellerDocument, SellerOffer, SellerProperty, SellerVisit, SellerWeeklyPoint, SourcePerson, SourcesVendeur } from './vendeur.ts';

/** Le lecteur que reçoivent les modules appelés par l'espace : jamais une personne. */
export const ESPACE_READER = 'system:espace';

/** La direction du réseau, sous le nom `system:espace` : jamais appelée avant le contrôle de l'espace [R161, R16]. */
export const espaceViewer = (networkId: string): Viewer => ({ role: 'direction', networkId, userId: ESPACE_READER });
const systemViewer = espaceViewer;

/** La période d'un vendeur sur un bien : depuis le début de sa suite de mandats, avec ses mandats. */
export interface SellerWindow {
  propertyId: string;
  since: string;
  mandateIds: string[];
  latest: { id: string; signed_at: string };
}

/**
 * Les biens dont la personne est le mandant aujourd'hui : le dernier mandat vivant du bien est le sien. La période
 * commence au premier mandat de sa dernière suite : un mandat d'une autre personne, signé plus tard sur le même bien,
 * lui retire le bien en entier, et rien de ce qui précède sa suite ne lui est montré [R161].
 */
export async function sellerWindows(db: SqlDatabase, fiche: FicheUnique, networkId: string, personId: string): Promise<SellerWindow[]> {
  const members = new Set(await fiche.membersOf(personId));
  const own = await db.all<{ property_id: string }>(`SELECT DISTINCT property_id FROM (${LIVE_MANDATES}) WHERE person_id IN (${placeholders(members.size)})`, [networkId, ...members]);
  const out: SellerWindow[] = [];
  for (const { property_id } of own) {
    const all = await db.all<{ id: string; person_id: string; signed_at: string }>(`SELECT id, person_id, signed_at FROM (${LIVE_MANDATES}) WHERE property_id = ? ORDER BY signed_at, id`, [networkId, property_id]);
    const run: { id: string; signed_at: string }[] = [];
    for (let i = all.length - 1; i >= 0 && members.has(all[i]!.person_id); i--) run.unshift(all[i]!);
    if (run.length === 0) continue;
    out.push({ propertyId: property_id, since: run[0]!.signed_at, mandateIds: run.map((m) => m.id), latest: run.at(-1)! });
  }
  return out.sort((a, b) => a.since.localeCompare(b.since) || a.propertyId.localeCompare(b.propertyId));
}

/** Le titre court d'un document du dossier, sans article : « Titre de propriété ». */
export const pieceTitle = (piece: Piece): string => {
  const label = PIECE_LABELS[piece].replace(/^(?:le |la |les |l')/u, '');
  return label.charAt(0).toUpperCase() + label.slice(1);
};

/** Ce qui tient la date d'acte, dit au vendeur, sans rien sur le financement de l'acquéreur [R161]. */
const HOLD_LABELS: Record<PartyView['remaining'][number]['reason'], string> = {
  fin_retractation: 'Le délai de rétractation de l’acquéreur',
  reponse_commune: 'La réponse de la commune sur son droit de préemption',
  delai_commune_suspendu: 'Le délai de la commune, suspendu par sa demande',
  etat_date_attendu: 'L’état daté du syndic',
  reflexion_offre_pret: 'Le financement de l’acquéreur',
  offre_pret_attendue: 'Le financement de l’acquéreur',
  acceptation_offre_attendue: 'Le financement de l’acquéreur',
  refus_de_pret: 'Le financement de l’acquéreur',
  pret_en_cours: 'Le financement de l’acquéreur',
  piece_manquante: 'Une pièce du dossier',
  piece_perimee: 'Une pièce du dossier à renouveler',
  identite_a_verifier: 'Une vérification d’identité',
  donnee_du_bien_inconnue: 'Une donnée du bien à compléter',
  date_a_saisir: 'Une date à fixer avec le notaire',
  pieces_de_l_autre_partie: 'Des pièces de l’autre partie',
};

const holdLabel = (line: PartyView['remaining'][number]): string => {
  if ((line.reason === 'piece_manquante' || line.reason === 'piece_perimee') && line.item && line.item in PIECE_LABELS && line.who !== 'autre_partie') {
    const title = pieceTitle(line.item as Piece);
    return line.reason === 'piece_manquante' ? `${title} à fournir` : `${title} à renouveler`;
  }
  return HOLD_LABELS[line.reason];
};

/** Une pièce est du côté du vendeur si les règles écrites la lui demandent (N01) ; l'inconnu reste caché [R161]. */
const SELLER_PIECES: ReadonlySet<Piece> = (() => {
  const all = new Set<Piece>();
  // Toutes les pièces que les règles écrites peuvent demander au vendeur : un lot de copropriété d'année inconnue (toutes
  // les pièces d'un bien bâti) et un terrain (le bornage). Une pièce ajoutée plus tard pour l'acquéreur reste cachée.
  const sheets = [
    { kind: 'home' as const, sheet: { characteristics: { buildYear: null, heating: 'individuel_gaz' }, coownership: { isCoownership: true } } },
    { kind: 'land' as const, sheet: { characteristics: {}, coownership: { isCoownership: false } } },
  ];
  for (const s of sheets) {
    const list = expectedPieces(s.kind, s.sheet as never, 2027);
    for (const p of list?.pieces ?? []) if (p.side === 'vendeur') all.add(p.piece);
  }
  return all;
})();

/**
 * Les côtés d'une personne dans ses dossiers. EC08 : le vendeur ; EC09 : le propriétaire (dernier à avoir pris le bien,
 * par mandat, mise en location ou acte, quand il n'est ni vendeur ni bailleur) et le bailleur (une mise en location à
 * lui dans sa période) ; EC11 : l'acquéreur (recherche, visite, offre, dossier de vente ou alerte partie),
 * l'investisseur (profil ou alerte partie) et le candidat locataire (une candidature).
 */
export class SqlClientParties implements ClientParties {
  private readonly fiche: FicheUnique;

  constructor(private readonly db: SqlDatabase) {
    this.fiche = new FicheUnique(db, new FicheClient(db));
  }

  async sidesOf(networkId: string, personId: string): Promise<readonly ClientSide[]> {
    const sides: ClientSide[] = [];
    if ((await sellerWindows(this.db, this.fiche, networkId, personId)).length > 0) sides.push('vendeur');
    const owned = await ownerWindows(this.db, this.fiche, networkId, personId);
    if (owned.some((w) => w.listingIds.length > 0)) sides.push('bailleur');
    // Un vendeur ou un bailleur est déjà propriétaire pour l'espace ; le côté seul sert à l'acquéreur devenu propriétaire.
    if (owned.length > 0 && sides.length === 0) sides.push('proprietaire');
    // EC11 : les côtés d'acheteur, chacun par ce que son module a rangé.
    sides.push(...(await buyerSides(this.db, this.fiche, networkId, personId)));
    return sides;
  }
}

interface PropertyRow {
  id: string;
  reference: string;
  city: string | null;
  status: string;
  updated_at: string;
}

export class SqlSourcesVendeur implements SourcesVendeur {
  private readonly now: () => Date;
  private readonly fiche: FicheUnique;
  private readonly comparatif: ComparatifOffres;
  private readonly chemin: CheminCritique;

  constructor(
    private readonly db: SqlDatabase,
    acces: Acces,
    private readonly journal: JournalStore,
    options: { now?: () => Date } = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.fiche = new FicheUnique(db, new FicheClient(db, { now: this.now }), { now: this.now });
    this.comparatif = new ComparatifOffres(db, acces, journal, { now: this.now });
    // Le chemin critique ne lit aucune pièce dans le stockage : il ne fait que compter celles du dossier.
    this.chemin = new CheminCritique(db, acces, journal, { has: async () => false }, { now: this.now });
  }

  /** La période de la personne sur ce bien, ou null : ce n'est pas son bien aujourd'hui [R161]. */
  private async window(networkId: string, propertyId: string, personId: string): Promise<SellerWindow | null> {
    return (await sellerWindows(this.db, this.fiche, networkId, personId)).find((w) => w.propertyId === propertyId) ?? null;
  }

  private async since(networkId: string, propertyId: string, personId: string): Promise<string | null> {
    return (await this.window(networkId, propertyId, personId))?.since ?? null;
  }

  private person(personId: string): Promise<SourcePerson> {
    return sourcePerson(this.db, this.fiche, personId);
  }

  async sellerPropertiesOf(networkId: string, personId: string): Promise<readonly SellerProperty[]> {
    const out: SellerProperty[] = [];
    for (const w of await sellerWindows(this.db, this.fiche, networkId, personId)) {
      const p = await this.db.first<PropertyRow>('SELECT id, reference, city, status, updated_at FROM properties WHERE id = ? AND network_id = ?', [w.propertyId, networkId]);
      if (!p) continue;
      // Le prix du dernier mandat signé sur le bien, après ses avenants signés (D07) ; sa date : celle du dernier écrit.
      const latest = w.latest;
      const terms = await mandateTerms(this.db, latest.id);
      const lastAmendment = terms?.amendments.filter((a) => a.priceEur !== null).at(-1);
      out.push({
        propertyId: p.id,
        reference: p.reference,
        city: p.city ?? 'non communiquée',
        status: p.status,
        statusAt: p.updated_at,
        askingPriceEur: terms?.priceEur ?? null,
        mandateSignedAt: terms?.priceEur === null || terms?.priceEur === undefined ? null : (lastAmendment?.signedAt ?? latest.signed_at),
      });
    }
    return out;
  }

  async visitsOf(networkId: string, propertyId: string, personId: string): Promise<readonly SellerVisit[]> {
    const since = await this.since(networkId, propertyId, personId);
    if (!since) return [];
    const rows = await this.db.all<{ id: string; start_at: string; status: string; person_id: string; report: string | null; r_status: string | null; validated_at: string | null }>(
      `SELECT a.id, a.start_at, a.status, v.person_id, r.report, r.status AS r_status, r.validated_at
       FROM visits v JOIN appointments a ON a.id = v.appointment_id LEFT JOIN visit_reports r ON r.appointment_id = v.appointment_id
       WHERE v.network_id = ? AND v.property_id = ? AND a.start_at >= ? ORDER BY a.start_at, a.id`,
      [networkId, propertyId, since],
    );
    const out: SellerVisit[] = [];
    for (const r of rows) {
      let report: SellerVisit['report'] = null;
      if (r.r_status === 'valide' && r.report && r.validated_at) {
        try {
          const parsed = JSON.parse(r.report) as VisitReport;
          report = { text: sellerReportText(null, new Date(r.start_at), parsed).text, interest: parsed.interest, validatedAt: r.validated_at };
        } catch {
          report = null;
        }
      }
      const state: SellerVisit['state'] = r.status === 'honored' ? 'faite' : r.status === 'booked' ? 'prevue' : 'annulee';
      out.push({ id: r.id, at: r.start_at, state, report, visitor: await this.person(r.person_id) });
    }
    return out;
  }

  async offersOf(networkId: string, propertyId: string, personId: string): Promise<readonly SellerOffer[]> {
    const since = await this.since(networkId, propertyId, personId);
    if (!since) return [];
    const rows = await this.db.all<{ id: string; seq: number; buyer_person_id: string; valid_until: string; received_at: string; responded_at: string | null }>(
      `SELECT o.id, o.seq, o.buyer_person_id, o.valid_until, o.received_at, s.responded_at
       FROM offer_register o LEFT JOIN offer_responses s ON s.offer_id = o.id
       WHERE o.network_id = ? AND o.property_id = ? ORDER BY o.seq`,
      [networkId, propertyId],
    );
    const table = await this.comparatif.table(systemViewer(networkId), propertyId);
    if (!table.ok) {
      // Sans le tableau des offres, aucun chiffre n'est recomposé : montant, net, validité et état sont « non
      // communiqués », et l'échec va au journal, avec des identifiants seulement [R163, R13].
      await appendEvent(this.journal, { type: 'espaces.source_indisponible', actor: ESPACE_READER, subject: `property:${propertyId}`, data: { source: 'offres', code: table.code } }, this.now);
    }
    const bySeq = new Map(table.ok ? table.value.rows.map((r) => [r.seq, r]) : []);
    const out: SellerOffer[] = [];
    for (const o of rows) {
      if (o.received_at < since) continue;
      const row = bySeq.get(Number(o.seq));
      const lastProposal = row ? await this.db.first<{ valid_until: string }>('SELECT valid_until FROM offer_proposals WHERE offer_id = ? ORDER BY seq DESC LIMIT 1', [o.id]) : null;
      out.push({
        id: o.id,
        receivedAt: o.received_at,
        amountEur: row?.amountEur ?? null,
        netSellerEur: row?.netSellerEur ?? null,
        conditions: row?.conditions ?? [],
        validUntil: row ? (lastProposal?.valid_until ?? o.valid_until) : null,
        state: row?.state ?? null,
        stateAt: o.responded_at ?? o.received_at,
        buyer: await this.person(o.buyer_person_id),
      });
    }
    return out;
  }

  async documentsOf(networkId: string, propertyId: string, personId: string): Promise<readonly SellerDocument[]> {
    const since = await this.since(networkId, propertyId, personId);
    if (!since) return [];
    const members = await this.fiche.membersOf(personId);
    const docs = await this.db.all<{ id: string; kind: string; created_at: string; mandate_signed: string | null; amendment_signed: string | null }>(
      `SELECT d.id, d.kind, d.created_at, s.signed_at AS mandate_signed, a.signed_at AS amendment_signed
       FROM documents d LEFT JOIN signed_documents s ON s.document_id = d.id LEFT JOIN signed_amendments a ON a.document_id = d.id
       WHERE d.network_id = ? AND d.property_id = ? AND d.mode = 'reel' AND d.status = 'complet' AND d.person_id IN (${placeholders(members.length)})
       ORDER BY d.created_at, d.id`,
      [networkId, propertyId, ...members],
    );
    const out: SellerDocument[] = docs.map((d) => {
      const signedAt = d.mandate_signed ?? d.amendment_signed;
      return { id: d.id, title: DOCUMENT_TITLES[d.kind] ?? 'Document', kind: d.kind, addedAt: d.created_at, signature: signedAt ? 'signe' : 'a_signer', signedAt };
    });
    const file = await this.db.first<{ id: string }>('SELECT id FROM sale_files WHERE network_id = ? AND property_id = ? AND opened_at >= ?', [networkId, propertyId, since]);
    if (file) {
      const pieces = await this.db.all<{ id: string; piece: Piece; received_at: string }>(
        `SELECT id, piece, received_at FROM sale_file_pieces p WHERE file_id = ?
         AND version = (SELECT MAX(version) FROM sale_file_pieces q WHERE q.file_id = p.file_id AND q.piece = p.piece) ORDER BY received_at, id`,
        [file.id],
      );
      for (const p of pieces) {
        if (!SELLER_PIECES.has(p.piece)) continue;
        out.push({ id: p.id, title: pieceTitle(p.piece), kind: 'piece_dossier', addedAt: p.received_at, signature: 'sans', signedAt: null });
      }
    }
    return out;
  }

  async appointmentsOf(networkId: string, propertyId: string, personId: string): Promise<readonly SellerAppointment[]> {
    const since = await this.since(networkId, propertyId, personId);
    if (!since) return [];
    const members = await this.fiche.membersOf(personId);
    const rows = await this.db.all<{ id: string; start_at: string; kind: string; status: string }>(
      `SELECT id, start_at, kind, status FROM appointments WHERE network_id = ? AND property_id = ? AND kind <> 'visite' AND person_id IN (${placeholders(members.length)}) ORDER BY start_at, id`,
      [networkId, propertyId, ...members],
    );
    const STATES: Record<string, string> = { booked: 'prévu', honored: 'fait', cancelled: 'annulé', absent: 'annulé' };
    const KINDS: Record<string, string> = { estimation: 'Estimation', signature: 'Signature', appel: 'Appel' };
    return rows.map((r) => ({ id: r.id, at: r.start_at, kind: KINDS[r.kind] ?? 'Rendez-vous', state: STATES[r.status] ?? 'non communiqué' }));
  }

  async weeklyPointsOf(networkId: string, propertyId: string, personId: string): Promise<readonly SellerWeeklyPoint[]> {
    const own = (await this.window(networkId, propertyId, personId))?.mandateIds ?? [];
    if (own.length === 0) return [];
    const rows = await this.db.all<{ week: string; figures: string; next_actions: string | null; validated_at: string | null }>(
      `SELECT week, figures, next_actions, validated_at FROM weekly_points WHERE network_id = ? AND property_id = ? AND status = 'valide' AND mandate_id IN (${placeholders(own.length)}) ORDER BY week`,
      [networkId, propertyId, ...own],
    );
    const out: SellerWeeklyPoint[] = [];
    for (const r of rows) {
      try {
        const figures = { ...(JSON.parse(r.figures) as WeeklyFigures), week: r.week };
        const actions = r.next_actions ? (JSON.parse(r.next_actions) as string[]) : [];
        out.push({ weekOf: r.week, text: weeklyPointText(null, figures, actions), validatedAt: r.validated_at });
      } catch {
        // Un point illisible n'est pas montré : sa semaine reste, son texte est « non communiqué » [R163].
        out.push({ weekOf: r.week, text: '', validatedAt: null });
      }
    }
    return out;
  }

  async earliestDeedOf(networkId: string, propertyId: string, personId: string): Promise<SellerDeedDate | null> {
    const since = await this.since(networkId, propertyId, personId);
    if (!since) return null;
    const file = await this.db.first<{ id: string }>('SELECT id FROM sale_files WHERE network_id = ? AND property_id = ? AND opened_at >= ?', [networkId, propertyId, since]);
    if (!file) return null;
    const r = await this.chemin.of(systemViewer(networkId), file.id);
    if (!r.ok) return null;
    const seller = r.value.seller;
    const holds = [...new Set(seller.remaining.map(holdLabel))].map((label) => ({ label }));
    return { date: seller.earliestActDay, holds, computedAt: this.now().toISOString() };
  }
}
