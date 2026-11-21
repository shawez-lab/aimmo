/**
 * Chemin critique de la vente (M10, N07) [R10, R16, R19, R52, R61]. Jamais vu.
 *
 * Pour chaque dossier, le code calcule le jour d'acte au plus tôt possible et nomme ce qui le tient, étape par étape,
 * avec qui doit agir : la rétractation de l'acquéreur, la réponse de la commune, le prêt, l'état daté, chaque pièce
 * manquante ou périmée, l'identité de l'acquéreur. Des règles écrites, les mêmes pour tous, sans IA ; chaque ligne
 * porte sa raison ; une date qui manque est dite, jamais inventée. Deux vues sont prêtes pour les espaces de M11 :
 * celle du vendeur et celle de l'acquéreur, chacune sans la donnée personnelle de l'autre partie.
 *
 * Aucun réseau ne dit au client, à tout moment, ce qui retarde son acte et qui le tient.
 *
 * Règles écrites :
 * - l'acte ne se signe pas avant le lendemain de la fin de la rétractation, ni avant le lendemain de la date de réponse
 *   de la commune (son silence ne vaut renonciation qu'à la fin du délai), ni avant l'état daté attendu ;
 * - avec une condition de prêt : une offre de prêt s'accepte au plus tôt le onzième jour après sa réception par
 *   l'acquéreur (délai de réflexion de 10 jours, le jour déclaré de l'offre est celui de sa réception) ; sans offre
 *   déclarée, ce jour se compte depuis aujourd'hui, au mieux ; une offre acceptée ce onzième jour ou après lève la
 *   contrainte, une acceptation déclarée plus tôt ne compte pas ; un refus bloque, sans date, tant qu'il est la
 *   dernière étape déclarée ;
 * - sans la rétractation ou la réponse de la commune datées, le jour au plus tôt ne se calcule pas ;
 * - une pièce manquante, une pièce périmée au jour visé, une identité non vérifiée, une donnée du bien inconnue ou une
 *   date à saisir bloquent sans date : le jour au plus tôt est alors « au plus tôt si » et ces lignes sont nommées ;
 * - l'élément qui tient le dossier est, s'il y en a, le premier blocage sans date ; sinon la contrainte datée la plus
 *   tardive ; à égalité, l'ordre fixe des lignes.
 *
 * Décidé, lecture prudente : le jour visé pour juger une pièce périmée est l'acte prévu s'il est saisi, sinon le jour
 * au plus tôt ; la vue du vendeur ne dit du prêt que « en cours » ou « obtenu », jamais une étape ni un refus de
 * l'acquéreur ; la vue de l'acquéreur ne nomme pas les pièces du vendeur une à une, seulement leur nombre.
 */
import type { Acces } from '../acces/acces.ts';
import type { Viewer } from '../acces/droits.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { localTime } from '../envoi/horaires.ts';
import type { JournalStore } from '../journal/types.ts';
import { gateSaleFile, type FileRefusal, type FileUnknown } from './acces-dossier.ts';
import { expiredPieces } from './acte.ts';
import { Echeancier, addDays, type ScheduleLine } from './echeancier.ts';
import { FinancementDossier, byRequest, type DeclaredStep } from './financement.ts';
import { PiecesDossier, type FileStatus, type PieceStore } from './pieces.ts';

const TIME_ZONE = 'Europe/Paris';
export const LOAN_REFLECTION_DAYS = 10;

export type Actor = 'acquereur' | 'vendeur' | 'commune' | 'banque' | 'syndic' | 'agent';

export type PathReason =
  | 'fin_retractation'
  | 'reponse_commune'
  | 'delai_commune_suspendu'
  | 'etat_date_attendu'
  | 'reflexion_offre_pret'
  | 'offre_pret_attendue'
  | 'acceptation_offre_attendue'
  | 'refus_de_pret'
  | 'piece_manquante'
  | 'piece_perimee'
  | 'identite_a_verifier'
  | 'donnee_du_bien_inconnue'
  | 'date_a_saisir';

export interface PathLine {
  reason: PathReason;
  /** Ce qu'elle vise : une échéance, une pièce, ou rien. */
  item: string | null;
  who: Actor;
  /** Le jour au plus tôt que cette ligne permet pour l'acte, ou null : bloque sans date. */
  notBefore: string | null;
}

export interface CriticalPath {
  fileId: string;
  /** Le jour où le chemin est calculé, à Paris. */
  today: string;
  /** Le jour d'acte au plus tôt, si toutes les lignes sans date sont levées ; null s'il ne peut pas se calculer. */
  earliestActDay: string | null;
  /** true : des lignes bloquent sans date, le jour au plus tôt suppose qu'elles soient levées. */
  conditional: boolean;
  plannedActDay: string | null;
  /** L'acte prévu est avant le jour au plus tôt. */
  late: boolean;
  /** La ligne qui tient le dossier, ou null s'il n'y en a aucune. */
  holder: PathLine | null;
  lines: PathLine[];
}

export interface PathInput {
  today: string;
  schedule: ScheduleLine[];
  plannedActDay: string | null;
  pieces: Pick<FileStatus, 'lines' | 'missing' | 'unknown' | 'identity'>;
  hasLoanCondition: boolean;
  financing: Pick<DeclaredStep, 'step' | 'day' | 'demande'>[];
}

interface LoanState {
  kind: 'acceptee' | 'acceptation_attendue' | 'reflexion' | 'refus' | 'attendue';
  notBefore: string | null;
}

/** L'état d'une seule demande de financement, d'après ses étapes dans l'ordre où elles ont été déclarées. */
function loanState(steps: readonly Pick<DeclaredStep, 'step' | 'day'>[], today: string): LoanState {
  // Le jour d'une offre de prêt est celui où l'acquéreur l'a reçue. Seules comptent les étapes après le dernier refus
  // de cette demande : une demande qui repart repart de zéro.
  if (steps.at(-1)?.step === 'refus') return { kind: 'refus', notBefore: null };
  const tail = steps.slice(steps.map((x) => x.step).lastIndexOf('refus') + 1);
  const offerAt = tail.map((x) => x.step).lastIndexOf('offre_pret_emise');
  if (offerAt < 0) return { kind: 'attendue', notBefore: null };
  const acceptable = addDays(tail[offerAt]!.day, LOAN_REFLECTION_DAYS + 1);
  // Une acceptation ne compte qu'après cette offre, au onzième jour après sa réception au plus tôt.
  if (tail.slice(offerAt + 1).some((x) => x.step === 'offre_pret_acceptee' && x.day >= acceptable)) return { kind: 'acceptee', notBefore: null };
  if (acceptable > today) return { kind: 'reflexion', notBefore: acceptable };
  // La réflexion est finie et l'acceptation n'est pas déclarée : elle reste à faire, sans date.
  return { kind: 'acceptation_attendue', notBefore: null };
}

const max = (a: string, b: string) => (a > b ? a : b);

/** Le chemin critique, par des règles écrites. Fonction pure : mêmes données, même chemin [R61]. */
export function criticalPath(fileId: string, input: PathInput): CriticalPath {
  const lines: PathLine[] = [];
  const at = (deadline: string) => input.schedule.find((l) => l.deadline === deadline);
  const r = at('fin_retractation');
  if (r?.status === 'datee') lines.push({ reason: 'fin_retractation', item: 'fin_retractation', who: 'acquereur', notBefore: addDays(r.day!, 1) });
  else if (r?.status === 'a_saisir') lines.push({ reason: 'date_a_saisir', item: 'fin_retractation', who: 'agent', notBefore: null });
  const c = at('reponse_preemption');
  if (c?.status === 'datee') lines.push({ reason: 'reponse_commune', item: 'reponse_preemption', who: 'commune', notBefore: addDays(c.day!, 1) });
  else if (c?.status === 'suspendue') lines.push({ reason: 'delai_commune_suspendu', item: 'reponse_preemption', who: 'commune', notBefore: null });
  else if (c?.status === 'a_saisir') lines.push({ reason: 'date_a_saisir', item: 'reponse_preemption', who: 'agent', notBefore: null });
  if (input.hasLoanCondition) {
    // Chaque demande de financement (banque ou courtier) a sa propre suite d'étapes (AU083) : un refus ne clôt que sa
    // demande. Le prêt tient le dossier par la demande la plus avancée ; il n'est refusé que si toutes le sont.
    const states = byRequest(input.financing).map((steps) => loanState(steps, input.today));
    const best = (k: LoanState['kind']) => states.filter((x) => x.kind === k);
    const reflecting = best('reflexion').sort((x, y) => (x.notBefore! < y.notBefore! ? -1 : 1))[0];
    if (best('acceptee').length) {
      // Rien : la condition de prêt est levée.
    } else if (best('acceptation_attendue').length) lines.push({ reason: 'acceptation_offre_attendue', item: 'pret', who: 'acquereur', notBefore: null });
    else if (reflecting) lines.push({ reason: 'reflexion_offre_pret', item: 'pret', who: 'acquereur', notBefore: reflecting.notBefore });
    else if (states.length && states.every((x) => x.kind === 'refus')) lines.push({ reason: 'refus_de_pret', item: 'pret', who: 'acquereur', notBefore: null });
    else lines.push({ reason: 'offre_pret_attendue', item: 'pret', who: 'banque', notBefore: addDays(input.today, LOAN_REFLECTION_DAYS + 1) });
  }
  const e = at('etat_date');
  if (e?.status === 'datee') lines.push({ reason: 'etat_date_attendu', item: 'etat_date', who: 'syndic', notBefore: e.day! });
  else if (e?.status === 'a_saisir') lines.push({ reason: 'date_a_saisir', item: 'etat_date', who: 'agent', notBefore: null });
  const a = at('acte');
  if (a?.status === 'a_saisir') lines.push({ reason: 'date_a_saisir', item: 'acte', who: 'agent', notBefore: null });
  // Le jour au plus tôt des seules contraintes datées : pour juger les pièces périmées.
  const dated = lines.filter((l) => l.notBefore !== null).reduce((d, l) => max(d, l.notBefore!), input.today);
  // Le jour visé : l'acte prévu, mais jamais avant le jour au plus tôt où il peut avoir lieu.
  const target = max(input.plannedActDay ?? dated, dated);
  for (const l of input.pieces.lines) {
    if (!l.received) lines.push({ reason: 'piece_manquante', item: l.piece, who: l.side, notBefore: null });
  }
  for (const p of expiredPieces(input.pieces.lines, target)) {
    const side = input.pieces.lines.find((l) => l.piece === p)!.side;
    lines.push({ reason: 'piece_perimee', item: p, who: side, notBefore: null });
  }
  for (const u of input.pieces.unknown) lines.push({ reason: 'donnee_du_bien_inconnue', item: u, who: 'agent', notBefore: null });
  if (input.pieces.identity !== 'verifiee') lines.push({ reason: 'identite_a_verifier', item: null, who: 'acquereur', notBefore: null });
  const undated = lines.filter((l) => l.notBefore === null);
  let holder: PathLine | null = undated[0] ?? null;
  if (!holder) {
    for (const l of lines) if (l.notBefore !== null && l.notBefore > input.today && (!holder || l.notBefore > holder.notBefore!)) holder = l;
  }
  // Sans la rétractation ou la réponse de la commune datées, le jour au plus tôt ne se calcule pas [R10].
  const legalUnknown = lines.some((l) => (l.item === 'fin_retractation' || l.item === 'reponse_preemption') && l.notBefore === null);
  const earliest = legalUnknown ? null : dated;
  return {
    fileId,
    today: input.today,
    earliestActDay: earliest,
    conditional: undated.length > 0,
    plannedActDay: input.plannedActDay,
    late: input.plannedActDay !== null && earliest !== null && input.plannedActDay < earliest,
    holder,
    lines,
  };
}

/** La vue d'une partie : rien qui nomme l'autre ; pour le vendeur, le prêt seulement en cours ou obtenu. */
export interface PartyView {
  fileId: string;
  earliestActDay: string | null;
  conditional: boolean;
  plannedActDay: string | null;
  /** Ce qui reste, en lignes simples : la raison, ce qu'elle vise, qui agit, le jour au plus tôt. */
  remaining: { reason: PathReason | 'pret_en_cours' | 'pieces_de_l_autre_partie'; item: string | null; who: Actor | 'autre_partie'; notBefore: string | null; count?: number }[];
  /** Ce que cette partie doit faire. */
  yourActions: { reason: PathReason; item: string | null }[];
}

const ACTIONS: readonly PathReason[] = ['piece_manquante', 'piece_perimee', 'identite_a_verifier', 'refus_de_pret', 'acceptation_offre_attendue'];

/**
 * La vue d'une partie. Pour le vendeur, `path` est le chemin calculé sans le prêt (`criticalPath` avec
 * `hasLoanCondition: false`) et `loanOpen` dit seulement si la condition de prêt est encore à lever.
 */
export function partyView(path: CriticalPath, side: 'vendeur' | 'acquereur', loanOpen = false): PartyView {
  const other = side === 'vendeur' ? 'acquereur' : 'vendeur';
  const remaining: PartyView['remaining'] = [];
  let otherPieces = 0;
  for (const l of path.lines) {
    if (side === 'vendeur' && ['reflexion_offre_pret', 'offre_pret_attendue', 'refus_de_pret', 'acceptation_offre_attendue'].includes(l.reason)) {
      // Le vendeur sait que la condition de prêt n'est pas levée, rien de plus sur le financement de l'acquéreur.
      if (!remaining.some((x) => x.reason === 'pret_en_cours')) remaining.push({ reason: 'pret_en_cours', item: 'pret', who: 'autre_partie', notBefore: null });
      continue;
    }
    if (side === 'acquereur' && l.who === 'vendeur' && (l.reason === 'piece_manquante' || l.reason === 'piece_perimee')) {
      otherPieces += 1;
      continue;
    }
    remaining.push({ reason: l.reason, item: l.item, who: l.who === other ? 'autre_partie' : l.who, notBefore: l.notBefore });
  }
  if (otherPieces > 0) remaining.push({ reason: 'pieces_de_l_autre_partie', item: null, who: 'autre_partie', notBefore: null, count: otherPieces });
  if (side === 'vendeur') {
    // Le jour au plus tôt du vendeur se calcule sans le prêt : rien ne laisse deviner l'étape du financement de
    // l'acquéreur ; tant que le prêt n'est pas obtenu, ce jour suppose qu'il le soit.
    const visible = path.lines.filter((l) => l.item !== 'pret');
    if (loanOpen && !remaining.some((x) => x.reason === 'pret_en_cours')) remaining.push({ reason: 'pret_en_cours', item: 'pret', who: 'autre_partie', notBefore: null });
    const legalUnknown = visible.some((l) => (l.item === 'fin_retractation' || l.item === 'reponse_preemption') && l.notBefore === null);
    const earliest = legalUnknown || path.earliestActDay === null ? null : visible.filter((l) => l.notBefore !== null).reduce((d, l) => max(d, l.notBefore!), path.today);
    return {
      fileId: path.fileId,
      earliestActDay: earliest,
      conditional: loanOpen || visible.some((l) => l.notBefore === null),
      plannedActDay: path.plannedActDay,
      remaining,
      yourActions: path.lines.filter((l) => l.who === side && ACTIONS.includes(l.reason)).map((l) => ({ reason: l.reason, item: l.item })),
    };
  }
  // Ce que la partie a à faire, pas les délais qui courent pour elle (rétractation, réflexion sur l'offre de prêt).
  const yourActions = path.lines.filter((l) => l.who === side && ACTIONS.includes(l.reason)).map((l) => ({ reason: l.reason, item: l.item }));
  return { fileId: path.fileId, earliestActDay: path.earliestActDay, conditional: path.conditional, plannedActDay: path.plannedActDay, remaining, yourActions };
}

/** Le chemin complet et les vues des deux parties ; celle du vendeur calculée sans le prêt, pièces comprises. */
export function viewsOf(fileId: string, input: PathInput): { path: CriticalPath; seller: PartyView; buyer: PartyView } {
  const path = criticalPath(fileId, input);
  const withoutLoan = criticalPath(fileId, { ...input, hasLoanCondition: false });
  return { path, seller: partyView(withoutLoan, 'vendeur', path.lines.some((l) => l.item === 'pret')), buyer: partyView(path, 'acquereur') };
}

export class CheminCritique {
  private readonly now: () => Date;
  private readonly pieces: PiecesDossier;
  private readonly echeancier: Echeancier;
  private readonly financement: FinancementDossier;

  constructor(
    private readonly db: SqlDatabase,
    private readonly acces: Acces,
    private readonly journal: JournalStore,
    store: PieceStore,
    options: { now?: () => Date } = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.pieces = new PiecesDossier(db, acces, journal, store, { now: this.now });
    this.echeancier = new Echeancier(db, acces, journal, { now: this.now });
    this.financement = new FinancementDossier(db, acces, journal, { now: this.now });
  }

  /** Le chemin critique du dossier, et les vues des parties : agent du bien, direction, conformité [R16]. */
  async of(viewer: Viewer, fileId: string): Promise<{ ok: true; value: { path: CriticalPath; seller: PartyView; buyer: PartyView } } | FileRefusal | FileUnknown> {
    const g = await gateSaleFile({ db: this.db, acces: this.acces, journal: this.journal, now: this.now }, viewer, fileId, false, 'sale_file_path');
    if (!g.ok) return g;
    const status = await this.pieces.status(viewer, fileId);
    if (!status.ok) return status as FileRefusal | FileUnknown;
    const fin = await this.financement.financing(viewer, fileId);
    if (!fin.ok) return fin;
    const schedule = await this.echeancier.scheduleOf(g.file);
    return {
      ok: true,
      value: viewsOf(fileId, {
        today: localTime(this.now(), TIME_ZONE).date,
        schedule: schedule.lines,
        plannedActDay: schedule.dates.acte_prevu?.day ?? null,
        pieces: status.value,
        hasLoanCondition: fin.value.hasLoanCondition,
        financing: fin.value.steps,
      }),
    };
  }
}

