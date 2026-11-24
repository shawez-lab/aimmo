/**
 * Les lecteurs SQL de l'espace de l'acquéreur, de l'investisseur et du candidat locataire (EC11) [R161, R162, R163, R42,
 * R49, R13].
 *
 * Décidé, lecture prudente :
 * - l'espace ne refait aucun module : un bien proposé est un bien dont l'alerte de M08 (T03) ou de M17 (Y06) est
 *   partie à la personne ; il n'est dit diffusable que si sa dernière version d'annonce est en vente ou sous offre et
 *   que la porte de diffusion de D05 l'accepte ce jour [R42] ; ses champs sont ceux que l'alerte et l'annonce ont déjà
 *   montrés : type, commune, surface, pièces, prix publié, classe énergie du diagnostic, date de publication ; jamais
 *   l'adresse, le texte du vendeur ni une photo [R161] ;
 * - les offres : le montant après contre-propositions et l'état sont ceux du tableau des offres (O06) ; sans tableau,
 *   aucun chiffre n'est recomposé, l'échec va au journal [R163, R13] ;
 * - le dossier : les seules pièces du côté de l'acquéreur (N01), déposées ou manquantes ; le dernier jalon du financement
 *   tel qu'il a été déclaré (N04), jamais évalué ; la date d'acte au plus tôt et ce qui la tient, par la vue de
 *   l'acquéreur du chemin critique (N09) ; l'acte rangé (N10) donne sa date, sans rien qui la tienne ;
 * - le rendement de l'investisseur n'est lu que dans une note validée par son agent, remise par la porte de M17
 *   (`NotesInvestissement.forClient`, contraintes relues à chaque remise) [R124, R126] : rendements centraux, chaque
 *   source et hypothèse du calcul, alertes et mentions ; sans cette porte, rien n'est montré ;
 * - la candidature : sa complétude est celle de W03 ; son état ne dit jamais un rang : « incomplète », « complète, en
 *   attente du choix du propriétaire », « retenue » ou « non retenue » [R162] ;
 * - les vendeurs, bailleurs et anciens acquéreurs de tout bien touché sont rattachés, avec ce qui les identifie dans
 *   toutes leurs fiches réunies, pour la retenue [R161] ;
 * - une fiche fusionnée compte pour la fiche gardée ; les modules qui demandent un lecteur reçoivent `system:espace`,
 *   appelé seulement après le contrôle de l'espace [R161, R16].
 */
import type { Acces } from '../acces/acces.ts';
import { ALERT_PURPOSE } from '../acquereurs/alertes.ts';
import type { DiffusionGate } from '../acquereurs/rapprochement.ts';
import { FicheClient } from '../db/fiche-client.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { CheminCritique, type PartyView } from '../dossiers/chemin-critique.ts';
import { PiecesDossier, type Piece } from '../dossiers/pieces.ts';
import { PIECE_LABELS } from '../dossiers/relances.ts';
import { Diffusion } from '../documents/retractation.ts';
import { FicheUnique } from '../fiche/fusion.ts';
import type { InvestmentNote } from '../investir/note.ts';
import type { YieldResult } from '../investir/calcul.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import { Candidatures, type ApplicationRow, type IdentityState } from '../location/candidatures.ts';
import { ComparatifOffres } from '../offres/comparatif.ts';
import type { BuyerFile, BuyerOffer, BuyerVisit, InvestorFigures, ProposedProperty, SourcesAcquereur, TenantApplication } from './acquereur.ts';
import type { ClientSide } from './entree.ts';
import { placeholders, sourcePerson } from './lecture.ts';
import { ESPACE_READER, espaceViewer, pieceTitle } from './sources-vendeur.ts';
import { OFFER_STOPPED_AT, OFFER_STOPPED_STATE, type SourcePerson } from './vendeur.ts';

/** La porte de M17 qui remet une note validée au client, contraintes relues [R124, R126]. */
export interface InvestorNoteGate {
  forClient(networkId: string, noteId: string): Promise<{ text: string; validatedAt: string } | null>;
}

export interface SqlSourcesAcquereurOptions {
  now?: () => Date;
  /** La porte de diffusion ; absente : celle de D05. */
  diffusion?: DiffusionGate;
  /** La porte des notes d'investissement (Y05) ; absente : aucun rendement n'est montré. */
  notes?: InvestorNoteGate | null;
}

/** Les côtés d'acheteur d'une personne : acquéreur, investisseur, candidat locataire [R161]. */
export async function buyerSides(db: SqlDatabase, fiche: FicheUnique, networkId: string, personId: string): Promise<ClientSide[]> {
  const members = await fiche.membersOf(personId);
  const q = placeholders(members.length);
  const has = async (sql: string): Promise<boolean> => (await db.first(`${sql} LIMIT 1`, [networkId, ...members])) !== null;
  const sides: ClientSide[] = [];
  const buyer =
    (await has(`SELECT 1 FROM buyer_searches WHERE network_id = ? AND person_id IN (${q})`)) ||
    (await has(`SELECT 1 FROM visits WHERE network_id = ? AND person_id IN (${q})`)) ||
    (await has(`SELECT 1 FROM offer_register WHERE network_id = ? AND buyer_person_id IN (${q})`)) ||
    (await has(`SELECT 1 FROM sale_files WHERE network_id = ? AND buyer_person_id IN (${q})`)) ||
    (await has(`SELECT 1 FROM property_alerts WHERE network_id = ? AND status = 'sent' AND person_id IN (${q})`));
  if (buyer) sides.push('acquereur');
  const investor =
    (await has(`SELECT 1 FROM investor_profiles WHERE network_id = ? AND person_id IN (${q})`)) ||
    (await has(`SELECT 1 FROM investor_alerts WHERE network_id = ? AND status = 'sent' AND person_id IN (${q})`));
  if (investor) sides.push('investisseur');
  if (await has(`SELECT 1 FROM rental_applications WHERE network_id = ? AND person_id IN (${q})`)) sides.push('candidat_locataire');
  return sides;
}

/** Ce qui tient la date d'acte, dit à l'acquéreur, sans rien sur le vendeur [R161]. */
const BUYER_HOLD_LABELS: Record<PartyView['remaining'][number]['reason'], string> = {
  fin_retractation: 'Votre délai de rétractation',
  reponse_commune: 'La réponse de la commune sur son droit de préemption',
  delai_commune_suspendu: 'Le délai de la commune, suspendu par sa demande',
  etat_date_attendu: 'L’état daté du syndic',
  reflexion_offre_pret: 'Votre délai de réflexion sur l’offre de prêt',
  offre_pret_attendue: 'Votre offre de prêt',
  acceptation_offre_attendue: 'L’acceptation de votre offre de prêt',
  refus_de_pret: 'Votre financement, après un refus déclaré',
  pret_en_cours: 'Votre financement',
  piece_manquante: 'Une pièce du dossier',
  piece_perimee: 'Une pièce du dossier à renouveler',
  identite_a_verifier: 'Une vérification d’identité',
  donnee_du_bien_inconnue: 'Une donnée du bien à compléter',
  date_a_saisir: 'Une date à fixer avec le notaire',
  pieces_de_l_autre_partie: 'Des pièces de l’autre partie',
};

const buyerHoldLabel = (line: PartyView['remaining'][number]): string => {
  if ((line.reason === 'piece_manquante' || line.reason === 'piece_perimee') && line.item && line.item in PIECE_LABELS && line.who !== 'autre_partie') {
    const title = pieceTitle(line.item as Piece);
    return line.reason === 'piece_manquante' ? `${title} à fournir` : `${title} à renouveler`;
  }
  return BUYER_HOLD_LABELS[line.reason];
};

/** L'état d'une offre, dit à celui qui l'a faite. */
const OFFER_STATES: Record<string, string> = {
  recue: 'reçue',
  transmise: 'transmise au vendeur',
  acceptee: 'acceptée',
  refusee: 'refusée',
  contre_offre: 'contre-proposition en cours',
  echue: 'échue',
};

/** Le dernier jalon du financement, tel qu'il a été déclaré : jamais évalué [R14]. */
const LOAN_STEPS: Record<string, string> = {
  demande_deposee: 'demande de prêt déposée',
  accord_principe: 'accord de principe',
  offre_pret_emise: 'offre de prêt émise',
  offre_pret_acceptee: 'offre de prêt acceptée',
  refus: 'refus de prêt déclaré',
};

const VISIT_STATES: Record<string, string> = { booked: 'prévue', honored: 'faite', cancelled: 'annulée', absent: 'manquée' };

/** La sorte du bien, dite à l'acquéreur en français, jamais le code de la base [R163]. */
const PROPERTY_KIND_WORDS: Readonly<Record<string, string>> = { home: 'Maison ou appartement', land: 'Terrain', building: 'Immeuble', commercial: 'Local commercial', business_walls: 'Murs commerciaux', business: 'Fonds de commerce' };

/** Le mot français de la sorte d'un bien ; une sorte inconnue de la liste devient « Bien », jamais le code. */
export const propertyKindWord = (code: string): string => (Object.hasOwn(PROPERTY_KIND_WORDS, code) ? PROPERTY_KIND_WORDS[code]! : 'Bien');

const TENANT_STATES = {
  incomplete: 'incomplète : pièces à compléter',
  waiting: 'complète, en attente du choix du propriétaire',
  chosen: 'retenue',
  other: 'non retenue',
} as const;

const PUBLISHED = new Set(['en_vente', 'sous_offre']);

export class SqlSourcesAcquereur implements SourcesAcquereur {
  private readonly now: () => Date;
  private readonly fiche: FicheUnique;
  private readonly comparatif: ComparatifOffres;
  private readonly chemin: CheminCritique;
  private readonly pieces: PiecesDossier;
  private readonly candidatures: Candidatures;
  private readonly diffusion: DiffusionGate;
  private readonly notes: InvestorNoteGate | null;

  constructor(
    private readonly db: SqlDatabase,
    acces: Acces,
    identity: IdentityState,
    private readonly journal: JournalStore,
    options: SqlSourcesAcquereurOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.fiche = new FicheUnique(db, new FicheClient(db, { now: this.now }), { now: this.now });
    this.comparatif = new ComparatifOffres(db, acces, journal, { now: this.now });
    // Ni le chemin critique ni la liste des pièces ne lisent le stockage : ils comptent ce que le dossier a rangé.
    const noStore = { has: async () => false };
    this.chemin = new CheminCritique(db, acces, journal, noStore, { now: this.now });
    this.pieces = new PiecesDossier(db, acces, journal, noStore, { now: this.now });
    // Seule la complétude est lue : elle n'écrit rien et ne touche ni aux mises en location ni au stockage.
    const unused = new Proxy({}, { get: () => () => Promise.reject(new Error('espace : lecture seule')) });
    this.candidatures = new Candidatures(db, unused as never, identity, unused as never, journal, { now: this.now });
    this.diffusion = options.diffusion ?? new Diffusion(db, acces, journal, { now: this.now });
    this.notes = options.notes ?? null;
  }

  private members(personId: string): Promise<string[]> {
    return this.fiche.membersOf(personId);
  }

  async proposedOf(networkId: string, personId: string): Promise<readonly ProposedProperty[]> {
    const members = await this.members(personId);
    const q = placeholders(members.length);
    const sent = await this.db.all<{ property_id: string; at: string }>(
      `SELECT property_id, MIN(at) AS at FROM (
         SELECT property_id, updated_at AS at FROM property_alerts WHERE network_id = ? AND status = 'sent' AND person_id IN (${q})
         UNION ALL
         SELECT property_id, updated_at AS at FROM investor_alerts WHERE network_id = ? AND status = 'sent' AND person_id IN (${q})
       ) GROUP BY property_id ORDER BY at, property_id`,
      [networkId, ...members, networkId, ...members],
    );
    const out: ProposedProperty[] = [];
    for (const s of sent) {
      const p = await this.db.first<{ id: string; reference: string; kind: string; city: string | null; surface_m2: number | null; rooms: number | null }>(
        'SELECT id, reference, kind, city, surface_m2, rooms FROM properties WHERE id = ? AND network_id = ?',
        [s.property_id, networkId],
      );
      if (!p) continue;
      const version = await this.db.first<{ state: string; price_eur: number | null; created_at: string }>('SELECT state, price_eur, created_at FROM listing_versions WHERE property_id = ? AND network_id = ? ORDER BY seq DESC LIMIT 1', [p.id, networkId]);
      // Sans annonce publiée, rien n'est un « bien proposé » montrable : aucun champ ne serait celui de l'annonce [R161].
      if (!version || !PUBLISHED.has(version.state)) continue;
      const gate = await this.diffusion.canDiffuse(networkId, p.id, this.now());
      out.push({
        propertyId: p.id,
        reference: p.reference,
        city: p.city ?? 'non communiquée',
        kind: propertyKindWord(p.kind),
        surfaceM2: p.surface_m2,
        rooms: p.rooms,
        priceEur: version.price_eur,
        energyClass: await this.energyClass(p.id),
        publishedAt: version.created_at,
        proposedAt: s.at,
        diffusable: gate.allowed === true,
        sellers: await this.sellersOf(networkId, [p.id]),
      });
    }
    return out;
  }

  /** La classe énergie du diagnostic rangé dans la fiche du bien (P01) : une mention obligatoire de toute annonce. */
  private async energyClass(propertyId: string): Promise<string | null> {
    const sheet = await this.db.first<{ data: string }>('SELECT data FROM property_sheets WHERE property_id = ? ORDER BY version DESC LIMIT 1', [propertyId]);
    if (!sheet) return null;
    try {
      const cls = (JSON.parse(sheet.data) as { energy?: { energyClass?: unknown } | null }).energy?.energyClass;
      return typeof cls === 'string' && /^[A-G]$/.test(cls) ? cls : null;
    } catch {
      return null;
    }
  }

  async visitsOf(networkId: string, personId: string): Promise<readonly BuyerVisit[]> {
    const members = await this.members(personId);
    const rows = await this.db.all<{ id: string; property_id: string; start_at: string; status: string }>(
      `SELECT a.id, v.property_id, a.start_at, a.status FROM visits v JOIN appointments a ON a.id = v.appointment_id
       WHERE v.network_id = ? AND v.person_id IN (${placeholders(members.length)}) ORDER BY a.start_at, a.id`,
      [networkId, ...members],
    );
    return rows.map((r) => ({ id: r.id, propertyId: r.property_id, at: r.start_at, state: VISIT_STATES[r.status] ?? 'non communiqué' }));
  }

  async offersOf(networkId: string, personId: string): Promise<readonly BuyerOffer[]> {
    const members = await this.members(personId);
    const rows = await this.db.all<{ id: string; property_id: string; seq: number; received_at: string; responded_at: string | null; stopped_at: string | null }>(
      `SELECT o.id, o.property_id, o.seq, o.received_at, s.responded_at, (${OFFER_STOPPED_AT}) AS stopped_at FROM offer_register o LEFT JOIN offer_responses s ON s.offer_id = o.id
       WHERE o.network_id = ? AND o.buyer_person_id IN (${placeholders(members.length)}) ORDER BY o.received_at, o.id`,
      [networkId, ...members],
    );
    const tables = new Map<string, Map<number, { amountEur: number; state: string }> | null>();
    const out: BuyerOffer[] = [];
    for (const o of rows) {
      if (!tables.has(o.property_id)) {
        const table = await this.comparatif.table(espaceViewer(networkId), o.property_id);
        if (!table.ok) await appendEvent(this.journal, { type: 'espaces.source_indisponible', actor: ESPACE_READER, subject: `property:${o.property_id}`, data: { source: 'offres', code: table.code } }, this.now);
        tables.set(o.property_id, table.ok ? new Map(table.value.rows.map((r) => [Number(r.seq), { amountEur: r.amountEur, state: r.state }])) : null);
      }
      const row = tables.get(o.property_id)?.get(Number(o.seq));
      out.push({ id: o.id, propertyId: o.property_id, receivedAt: o.received_at, amountEur: row?.amountEur ?? null, state: row ? (o.stopped_at ? OFFER_STOPPED_STATE : (OFFER_STATES[row.state] ?? null)) : null, stateAt: o.stopped_at ?? o.responded_at ?? o.received_at });
    }
    return out;
  }

  async filesOf(networkId: string, personId: string): Promise<readonly BuyerFile[]> {
    const members = await this.members(personId);
    const files = await this.db.all<{ id: string; property_id: string; opened_at: string }>(
      `SELECT id, property_id, opened_at FROM sale_files f WHERE network_id = ? AND NOT EXISTS (SELECT 1 FROM sale_file_stops stop_ WHERE stop_.file_id = f.id) AND buyer_person_id IN (${placeholders(members.length)}) ORDER BY opened_at, id`,
      [networkId, ...members],
    );
    const out: BuyerFile[] = [];
    for (const f of files) {
      const status = await this.pieces.status(espaceViewer(networkId), f.id);
      const pieces = status.ok
        ? status.value.lines.filter((l) => l.side === 'acquereur').map((l) => ({ kind: pieceTitle(l.piece), state: l.received ? ('deposee' as const) : ('manquante' as const), at: l.received?.receivedAt ?? f.opened_at }))
        : [];
      const step = await this.db.first<{ step: string; day: string }>('SELECT step, day FROM sale_file_financing WHERE file_id = ? AND network_id = ? ORDER BY seq DESC LIMIT 1', [f.id, networkId]);
      const loan = step ? { state: LOAN_STEPS[step.step] ?? 'non communiqué', at: step.day } : null;
      const closing = await this.db.first<{ signed_on: string; at: string }>('SELECT signed_on, at FROM sale_file_closings WHERE file_id = ? AND network_id = ?', [f.id, networkId]);
      let deed: BuyerFile['deed'] = null;
      if (closing) deed = { date: closing.signed_on, holds: [], computedAt: closing.at };
      else {
        const r = await this.chemin.of(espaceViewer(networkId), f.id);
        if (r.ok) deed = { date: r.value.buyer.earliestActDay, holds: [...new Set(r.value.buyer.remaining.map(buyerHoldLabel))], computedAt: this.now().toISOString() };
      }
      out.push({ fileId: f.id, propertyId: f.property_id, pieces, loan, deed });
    }
    return out;
  }

  async investorOf(networkId: string, personId: string, propertyId: string): Promise<InvestorFigures | null> {
    if (!this.notes) return null;
    const members = await this.members(personId);
    const row = await this.db.first<{ id: string; note: string; result: string }>(
      `SELECT n.id, n.note, c.result FROM investment_notes n JOIN investment_calculations c ON c.id = n.calculation_id JOIN projects p ON p.id = n.project_id
       WHERE n.network_id = ? AND n.status = 'validee' AND c.property_id = ? AND p.person_id IN (${placeholders(members.length)})
       ORDER BY n.validated_at DESC, n.id DESC LIMIT 1`,
      [networkId, propertyId, ...members],
    );
    if (!row) return null;
    // La porte de M17 relit les contraintes : une interdiction de louer apparue depuis retient la note [R124].
    const given = await this.notes.forClient(networkId, row.id);
    if (!given) return null;
    try {
      const note = JSON.parse(row.note) as InvestmentNote;
      const result = JSON.parse(row.result) as YieldResult;
      if (result.status !== 'complet') return null;
      return {
        propertyId,
        grossYieldBp: result.grossYieldBp.central,
        netYieldBp: result.netYieldBp.central,
        hypotheses: note.sources.map((s) => s.text),
        constraints: [...note.alerts, ...note.mentions],
        computedAt: given.validatedAt,
      };
    } catch {
      return null;
    }
  }

  async tenantApplicationsOf(networkId: string, personId: string): Promise<readonly TenantApplication[]> {
    const members = await this.members(personId);
    const apps = await this.db.all<ApplicationRow & { property_id: string; reference: string; city: string | null }>(
      `SELECT a.id, a.listing_id, a.network_id, a.person_id, a.arrival, a.dossierfacile_url, a.arrived_at, l.property_id, p.reference, p.city
       FROM rental_applications a JOIN rental_listings l ON l.id = a.listing_id JOIN properties p ON p.id = l.property_id
       WHERE a.network_id = ? AND a.person_id IN (${placeholders(members.length)}) ORDER BY a.arrived_at, a.id`,
      [networkId, ...members],
    );
    const out: TenantApplication[] = [];
    for (const a of apps) {
      const complete = (await this.candidatures.completeness(a)).complete;
      const choice = await this.db.first<{ application_id: string; decided_at: string }>('SELECT application_id, decided_at FROM rental_choices WHERE listing_id = ?', [a.listing_id]);
      // Jamais un rang ni les autres candidats : l'état de sa seule candidature [R162].
      const state = choice ? (choice.application_id === a.id ? TENANT_STATES.chosen : TENANT_STATES.other) : complete ? TENANT_STATES.waiting : TENANT_STATES.incomplete;
      out.push({ rentalId: a.listing_id, propertyId: a.property_id, reference: a.reference, city: a.city ?? 'non communiquée', receivedAt: a.arrived_at, complete, state, stateAt: choice?.decided_at ?? a.arrived_at });
    }
    return out;
  }

  async sellersOf(networkId: string, propertyIds: readonly string[]): Promise<readonly SourcePerson[]> {
    if (propertyIds.length === 0) return [];
    const q = placeholders(propertyIds.length);
    // Tout mandant, bailleur ou ancien acquéreur du bien, quel que soit l'état de son dossier : retenus de tout texte.
    const rows = await this.db.all<{ person_id: string }>(
      `SELECT DISTINCT person_id FROM (
         SELECT person_id FROM mandates WHERE network_id = ? AND property_id IN (${q})
         UNION SELECT owner_person_id AS person_id FROM rental_listings WHERE network_id = ? AND property_id IN (${q})
         UNION SELECT buyer_person_id AS person_id FROM sale_files WHERE network_id = ? AND property_id IN (${q})
       ) WHERE person_id IS NOT NULL ORDER BY person_id`,
      [networkId, ...propertyIds, networkId, ...propertyIds, networkId, ...propertyIds],
    );
    // Chaque personne par sa fiche gardée : une fiche absorbée ne fait pas retenir le lecteur de sa propre vue.
    const roots = [...new Set(await Promise.all(rows.map((r) => this.fiche.rootOf(r.person_id))))].sort();
    const out: SourcePerson[] = [];
    for (const root of roots) out.push(await sourcePerson(this.db, this.fiche, root));
    return out;
  }

  /** Comme le contrôle central : une ligne ouverte mais périmée ne fait pas dire « demandées » au client (AC07) [R03]. */
  async alertsRequested(networkId: string, personId: string): Promise<boolean> {
    const mine = await this.db.first('SELECT 1 FROM persons WHERE id = ? AND network_id = ?', [personId, networkId]);
    return mine !== null && (await this.fiche.channelsInForce(personId, ALERT_PURPOSE)).length > 0;
  }
}
