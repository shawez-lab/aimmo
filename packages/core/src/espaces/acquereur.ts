/**
 * L'espace de l'acquéreur, de l'investisseur et du candidat locataire (EC04) [R161, R163, R165, R42, R49, R03, R06, R13].
 *
 * Décidé, lecture prudente :
 * - l'acquéreur voit les biens qui lui ont été proposés et qui sont encore diffusables (mandat en cours, R42), par les
 *   seuls champs publiés de l'annonce : rien du vendeur, ni nom, ni coordonnée, ni adresse exacte [R161] ;
 * - ses visites, ses offres et leur état, son dossier jusqu'à l'acte (pièces du financement, date d'acte au plus tôt) ;
 * - un favori est une marque du client, rangée ici : il ne déclenche aucun envoi ; les alertes ne partent que par M08,
 *   avec son accord, par le contrôle central : l'espace dit seulement si elles sont demandées, et la demande passe par
 *   le module [R49, R03] ;
 * - chaque geste (réserver une visite, écrire une offre, déposer une pièce du financement, demander les alertes) passe
 *   par le port `GestesAcquereur`, tenu par le module qui le fait (M05, M09, M10, M08), avec ses propres contrôles ;
 *   l'espace vérifie d'abord que le bien ou le dossier est bien celui du client, puis rend la réponse du module telle
 *   quelle [R165] ;
 * - l'investisseur voit le rendement que M17 a calculé, avec ses hypothèses et ses contraintes ; un texte qui promet
 *   (garanti, assuré, sans risque…) est retenu : un rendement n'est jamais une promesse [R163] ;
 * - le candidat locataire voit ses visites et l'état de sa candidature, jamais les autres candidats ni un rang ;
 * - même retenue des textes que pour le vendeur [R161, R06] ; chaque lecture et chaque geste au journal, en codes [R13].
 */
import type { SqlDatabase } from '../db/sql.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import type { ClientViewer } from './entree.ts';
import { retain } from './proprietaire.ts';
import { NON_COMMUNIQUE, absent, fait, wordOfCode, type Fait, type SourcePerson } from './vendeur.ts';

export interface ProposedProperty {
  propertyId: string;
  reference: string;
  city: string;
  kind: string;
  surfaceM2: number | null;
  rooms: number | null;
  priceEur: number | null;
  energyClass: string | null;
  publishedAt: string;
  proposedAt: string;
  /** Encore diffusable ce jour : mandat signé, numéroté, en cours [R42]. */
  diffusable: boolean;
  /** Ce qui identifie le vendeur : lu seulement pour être retenu [R161]. */
  sellers: readonly SourcePerson[];
}

export interface BuyerVisit {
  id: string;
  propertyId: string;
  at: string;
  state: string;
}

export interface BuyerOffer {
  id: string;
  propertyId: string;
  receivedAt: string;
  /** Le montant après les contre-propositions, lu dans le tableau des offres (O06) ; null : non communiqué [R163]. */
  amountEur: number | null;
  state: string | null;
  stateAt: string;
}

/** Où en est une pièce du dossier, dit à l'acquéreur en français, jamais le code des sources [R163]. */
export const PIECE_STATE_WORDS: Readonly<Record<BuyerFile['pieces'][number]['state'], string>> = Object.freeze({ manquante: 'manquante', deposee: 'déposée', validee: 'validée' });

export interface BuyerFile {
  fileId: string;
  propertyId: string;
  pieces: readonly { kind: string; state: 'manquante' | 'deposee' | 'validee'; at: string }[];
  loan: { state: string; at: string } | null;
  deed: { date: string | null; holds: readonly string[]; computedAt: string } | null;
}

export interface InvestorFigures {
  propertyId: string;
  grossYieldBp: number | null;
  netYieldBp: number | null;
  hypotheses: readonly string[];
  constraints: readonly string[];
  computedAt: string;
}

export interface TenantApplication {
  rentalId: string;
  propertyId: string;
  reference: string;
  city: string;
  receivedAt: string;
  complete: boolean;
  state: string;
  stateAt: string;
}

/** Les sources de l'espace de l'acquéreur. Fausses dans les tests ; lecteurs SQL : `SqlSourcesAcquereur` (EC11). */
export interface SourcesAcquereur {
  proposedOf(networkId: string, personId: string): Promise<readonly ProposedProperty[]>;
  visitsOf(networkId: string, personId: string): Promise<readonly BuyerVisit[]>;
  offersOf(networkId: string, personId: string): Promise<readonly BuyerOffer[]>;
  filesOf(networkId: string, personId: string): Promise<readonly BuyerFile[]>;
  investorOf(networkId: string, personId: string, propertyId: string): Promise<InvestorFigures | null>;
  tenantApplicationsOf(networkId: string, personId: string): Promise<readonly TenantApplication[]>;
  /**
   * Ce qui identifie les vendeurs et bailleurs de ces biens, diffusables ou non : lu seulement pour retenir tout texte
   * qui les cite [R161].
   */
  sellersOf(networkId: string, propertyIds: readonly string[]): Promise<readonly SourcePerson[]>;
  /** L'accord en cours pour les alertes de biens (M08) [R49]. */
  alertsRequested(networkId: string, personId: string): Promise<boolean>;
}

/** Une réponse d'un module à un geste : rendue telle quelle [R165]. */
export type GesteResult = { ok: true; value: Record<string, unknown> } | { ok: false; rule: string | null; code: string; field?: string };

/** Les gestes du client, chacun tenu par son module, avec ses contrôles [R165]. Branchés sur les modules par `GestesModules` (EC10). */
export interface GestesAcquereur {
  bookVisit(client: ClientViewer, propertyId: string, input: Record<string, unknown>): Promise<GesteResult>;
  writeOffer(client: ClientViewer, propertyId: string, input: Record<string, unknown>): Promise<GesteResult>;
  addFinancingPiece(client: ClientViewer, fileId: string, input: Record<string, unknown>): Promise<GesteResult>;
  requestAlerts(client: ClientViewer, input: Record<string, unknown>): Promise<GesteResult>;
}

/** La liste écrite des champs que l'acquéreur voit d'un bien proposé : ceux de l'annonce publiée [R161]. */
export const CHAMPS_BIEN_PROPOSE = ['propertyId', 'reference', 'city', 'kind', 'surface', 'rooms', 'price', 'energyClass', 'publishedAt', 'favorite', 'investor'] as const;

export interface VueBienPropose {
  propertyId: string;
  reference: string;
  city: string;
  kind: string;
  surface: Fait<number>;
  rooms: Fait<number>;
  price: Fait<number>;
  energyClass: Fait<string>;
  publishedAt: Fait<string>;
  favorite: boolean;
  investor: { grossYield: Fait<number>; netYield: Fait<number>; hypotheses: readonly string[]; constraints: readonly string[] } | null;
}

export interface VueAcquereur {
  alerts: { requested: boolean };
  properties: VueBienPropose[];
  visits: { propertyId: string; at: Fait<string>; state: Fait<string> }[];
  offers: { propertyId: string; receivedAt: Fait<string>; amount: Fait<number>; state: Fait<string> }[];
  files: { propertyId: string; pieces: { kind: string; state: Fait<string> }[]; loan: Fait<string>; deedDate: Fait<string>; deedHolds: Fait<readonly string[]> }[];
  rentals: { reference: string; city: string; receivedAt: Fait<string>; complete: Fait<boolean>; state: Fait<string> }[];
}

export type AcquereurResult<T> = { ok: true; value: T } | { ok: false; rule: 'R161' | 'R165'; code: string };

const BUYER_SIDES = ['acquereur', 'investisseur', 'candidat_locataire'] as const;

const SOURCES = {
  annonce: 'annonce publiée',
  agenda: 'agenda du bien',
  offres: 'registre des offres',
  dossier: 'dossier de vente',
  financement: 'financement déclaré',
  echeancier: 'échéancier du dossier',
  rendement: 'calcul de rendement',
  location: 'dossier de candidature',
} as const;

/** Les tournures qui feraient d'un rendement une promesse : retenues [R163]. */
const PROMESSE = /(?<![\p{L}\p{N}])(garanti(?:e|es|s)?|assur[ée](?:e|es|s)?|sans risques?|certaine?s?|à coup sûr|promis(?:e|es)?|infaillibles?)(?![\p{L}\p{N}])/iu;

/** Vrai si le texte promet un résultat [R163]. */
export function promises(text: string): boolean {
  return PROMESSE.test(text);
}

export class EspaceAcquereur {
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(
    private readonly db: SqlDatabase,
    private readonly sources: SourcesAcquereur,
    private readonly gestes: GestesAcquereur,
    private readonly journal: JournalStore,
    options: { now?: () => Date; newId?: () => string } = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => crypto.randomUUID());
  }

  async vue(viewer: ClientViewer): Promise<AcquereurResult<VueAcquereur>> {
    if (!this.isBuyer(viewer)) return this.refuse(viewer, 'vue', 'R161', 'side');
    const n = viewer.networkId;
    const [proposed, visits, offers, files, rentals, alerts, favorites] = await Promise.all([
      this.proposed(viewer),
      this.sources.visitsOf(n, viewer.personId),
      this.sources.offersOf(n, viewer.personId),
      this.sources.filesOf(n, viewer.personId),
      this.sources.tenantApplicationsOf(n, viewer.personId),
      this.sources.alertsRequested(n, viewer.personId),
      this.favorites(viewer),
    ]);
    // Les vendeurs et bailleurs de tous les biens que la vue touche, diffusables ou non : aucun texte ne doit les citer.
    const touched = [...new Set([...(await this.sources.proposedOf(n, viewer.personId)).map((p) => p.propertyId), ...visits.map((v) => v.propertyId), ...offers.map((o) => o.propertyId), ...files.map((f) => f.propertyId), ...rentals.map((r) => r.propertyId)])].sort();
    const sellers = [...proposed.flatMap((p) => p.sellers), ...(touched.length > 0 ? await this.sources.sellersOf(n, touched) : [])].filter((s) => s.personId !== viewer.personId);
    const investor = viewer.sides.includes('investisseur');
    const properties: VueBienPropose[] = [];
    for (const p of proposed) {
      const figures = investor ? await this.sources.investorOf(n, viewer.personId, p.propertyId) : null;
      properties.push({
        propertyId: p.propertyId,
        reference: p.reference,
        city: p.city,
        kind: p.kind,
        surface: fait(p.surfaceM2, SOURCES.annonce, p.publishedAt),
        rooms: fait(p.rooms, SOURCES.annonce, p.publishedAt),
        price: fait(p.priceEur, SOURCES.annonce, p.publishedAt),
        energyClass: fait(p.energyClass, SOURCES.annonce, p.publishedAt),
        publishedAt: fait(p.publishedAt, SOURCES.annonce, p.publishedAt),
        favorite: favorites.has(p.propertyId),
        investor:
          figures && figures.propertyId === p.propertyId
            ? {
                grossYield: fait(figures.grossYieldBp, SOURCES.rendement, figures.computedAt),
                netYield: fait(figures.netYieldBp, SOURCES.rendement, figures.computedAt),
                hypotheses: figures.hypotheses.map((h) => (PROMESSE.test(h) ? NON_COMMUNIQUE : h)),
                constraints: figures.constraints.map((c) => (PROMESSE.test(c) ? NON_COMMUNIQUE : c)),
              }
            : null,
      });
    }
    const byDate = <T>(items: readonly T[], date: (x: T) => string) => [...items].sort((a, b) => date(a).localeCompare(date(b)));
    const view: VueAcquereur = {
      alerts: { requested: alerts },
      properties: byDate(properties, (p) => p.publishedAt.value ?? ''),
      visits: byDate(visits, (v) => v.at).map((v) => ({ propertyId: v.propertyId, at: fait(v.at, SOURCES.agenda, v.at), state: fait(v.state, SOURCES.agenda, v.at) })),
      offers: byDate(offers, (o) => o.receivedAt).map((o) => ({ propertyId: o.propertyId, receivedAt: fait(o.receivedAt, SOURCES.offres, o.receivedAt), amount: fait(o.amountEur, SOURCES.offres, o.receivedAt), state: fait(o.state, SOURCES.offres, o.stateAt) })),
      files: files.map((f) => ({
        propertyId: f.propertyId,
        pieces: f.pieces.map((x) => ({ kind: x.kind, state: fait(wordOfCode(PIECE_STATE_WORDS, x.state), SOURCES.dossier, x.at) })),
        loan: f.loan ? fait(f.loan.state, SOURCES.financement, f.loan.at) : absent(),
        deedDate: f.deed ? fait(f.deed.date, SOURCES.echeancier, f.deed.computedAt) : absent(),
        deedHolds: f.deed ? fait([...f.deed.holds], SOURCES.echeancier, f.deed.computedAt) : absent(),
      })),
      // Sa seule candidature, son état : jamais un rang ni les autres candidats.
      rentals: viewer.sides.includes('candidat_locataire')
        ? byDate(rentals, (r) => r.receivedAt).map((r) => ({ reference: r.reference, city: r.city, receivedAt: fait(r.receivedAt, SOURCES.location, r.receivedAt), complete: fait(r.complete, SOURCES.location, r.receivedAt), state: fait(r.state, SOURCES.location, r.stateAt) }))
        : [],
    };
    const { view: clean, retained } = retain(view, sellers);
    await this.log(viewer, 'vue', { properties: clean.properties.length, retained });
    return { ok: true, value: clean };
  }

  /** Ajoute un bien proposé à ses favoris : rien ne part [R49]. Un bien non proposé est refusé. */
  async addFavorite(viewer: ClientViewer, propertyId: string): Promise<AcquereurResult<{ favorite: true }>> {
    if (!this.isBuyer(viewer)) return this.refuse(viewer, 'favori', 'R161', 'side');
    if (!(await this.proposed(viewer)).some((p) => p.propertyId === propertyId)) return this.refuse(viewer, 'favori', 'R161', 'not_proposed');
    if ((await this.favorites(viewer)).has(propertyId)) return { ok: true, value: { favorite: true } };
    await this.db.run('INSERT INTO client_space_favorites (id, network_id, person_id, property_id, added_at) VALUES (?, ?, ?, ?, ?)', [this.newId(), viewer.networkId, viewer.personId, propertyId, this.now().toISOString()]);
    await this.log(viewer, 'favori', { property: propertyId, status: 'ajoute' });
    return { ok: true, value: { favorite: true } };
  }

  async removeFavorite(viewer: ClientViewer, propertyId: string): Promise<AcquereurResult<{ favorite: false }>> {
    if (!this.isBuyer(viewer)) return this.refuse(viewer, 'favori', 'R161', 'side');
    const rows = await this.db.all<{ id: string }>(
      'SELECT f.id FROM client_space_favorites f WHERE f.network_id = ? AND f.person_id = ? AND f.property_id = ? AND f.id NOT IN (SELECT favorite_id FROM client_space_favorite_removals)',
      [viewer.networkId, viewer.personId, propertyId],
    );
    for (const r of rows) await this.db.run('INSERT INTO client_space_favorite_removals (favorite_id, ended_at) VALUES (?, ?) ON CONFLICT DO NOTHING', [r.id, this.now().toISOString()]);
    if (rows.length > 0) await this.log(viewer, 'favori', { property: propertyId, status: 'retire' });
    return { ok: true, value: { favorite: false } };
  }

  /** Réserver une visite d'un bien proposé : par M05, avec ses contrôles [R165]. */
  async bookVisit(viewer: ClientViewer, propertyId: string, input: Record<string, unknown>): Promise<AcquereurResult<Record<string, unknown>> | GesteResult> {
    if (!this.isBuyer(viewer)) return this.refuse(viewer, 'visite', 'R161', 'side');
    if (!(await this.proposed(viewer)).some((p) => p.propertyId === propertyId)) return this.refuse(viewer, 'visite', 'R165', 'not_proposed');
    return this.forward(viewer, 'visite', propertyId, () => this.gestes.bookVisit(viewer, propertyId, input));
  }

  /** Écrire une offre sur un bien proposé : par M09, avec ses contrôles [R165]. */
  async writeOffer(viewer: ClientViewer, propertyId: string, input: Record<string, unknown>): Promise<AcquereurResult<Record<string, unknown>> | GesteResult> {
    if (!viewer.sides.includes('acquereur') && !viewer.sides.includes('investisseur')) return this.refuse(viewer, 'offre', 'R161', 'side');
    if (!(await this.proposed(viewer)).some((p) => p.propertyId === propertyId)) return this.refuse(viewer, 'offre', 'R165', 'not_proposed');
    return this.forward(viewer, 'offre', propertyId, () => this.gestes.writeOffer(viewer, propertyId, input));
  }

  /** Déposer une pièce du financement de son propre dossier : par M10 [R165]. */
  async addFinancingPiece(viewer: ClientViewer, fileId: string, input: Record<string, unknown>): Promise<AcquereurResult<Record<string, unknown>> | GesteResult> {
    if (!viewer.sides.includes('acquereur') && !viewer.sides.includes('investisseur')) return this.refuse(viewer, 'piece', 'R161', 'side');
    const files = await this.sources.filesOf(viewer.networkId, viewer.personId);
    const file = files.find((f) => f.fileId === fileId);
    if (!file) return this.refuse(viewer, 'piece', 'R161', 'not_party');
    return this.forward(viewer, 'piece', file.propertyId, () => this.gestes.addFinancingPiece(viewer, fileId, input));
  }

  /** Demander les alertes de biens : par M08, qui range l'accord et envoie par le contrôle central [R49, R03, R165]. */
  async requestAlerts(viewer: ClientViewer, input: Record<string, unknown>): Promise<AcquereurResult<Record<string, unknown>> | GesteResult> {
    if (!this.isBuyer(viewer)) return this.refuse(viewer, 'alertes', 'R161', 'side');
    return this.forward(viewer, 'alertes', null, () => this.gestes.requestAlerts(viewer, input));
  }

  private async forward(viewer: ClientViewer, kind: string, propertyId: string | null, run: () => Promise<GesteResult>): Promise<GesteResult> {
    const result = await run();
    await this.log(viewer, kind, { ...(propertyId ? { property: propertyId } : {}), status: result.ok ? 'fait' : 'refuse', ...(result.ok ? {} : { moduleRule: result.rule, moduleCode: result.code }) });
    return result;
  }

  /** Les biens proposés au client et encore diffusables [R42]. */
  private async proposed(viewer: ClientViewer): Promise<ProposedProperty[]> {
    return (await this.sources.proposedOf(viewer.networkId, viewer.personId)).filter((p) => p.diffusable === true);
  }

  private async favorites(viewer: ClientViewer): Promise<Set<string>> {
    const rows = await this.db.all<{ property_id: string }>(
      'SELECT property_id FROM client_space_favorites WHERE network_id = ? AND person_id = ? AND id NOT IN (SELECT favorite_id FROM client_space_favorite_removals)',
      [viewer.networkId, viewer.personId],
    );
    return new Set(rows.map((r) => r.property_id));
  }

  private isBuyer(viewer: ClientViewer): boolean {
    return viewer.sides.some((s) => (BUYER_SIDES as readonly string[]).includes(s));
  }

  private async log(viewer: ClientViewer, kind: string, data: Record<string, unknown>): Promise<void> {
    await appendEvent(this.journal, { type: kind === 'vue' ? 'espaces.vue' : 'espaces.geste', actor: `client:${viewer.sessionId}`, subject: `person:${viewer.personId}`, data: { rule: kind === 'vue' ? 'R161' : 'R165', side: 'acquereur', kind, ...data } }, this.now);
  }

  private async refuse(viewer: ClientViewer, kind: string, rule: 'R161' | 'R165', code: string): Promise<{ ok: false; rule: 'R161' | 'R165'; code: string }> {
    await this.log(viewer, kind, { status: 'refuse', code });
    return { ok: false, rule, code };
  }
}
