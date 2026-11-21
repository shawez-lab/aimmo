/**
 * Échéancier du dossier de vente et alertes à l'agent (M10, N02) [R10, R16, R17, R61].
 *
 * À la signature du compromis, l'agent du dossier saisit les dates, chacune avec sa preuve : signature, première
 * présentation de la notification à l'acquéreur, date limite du prêt, réception de la déclaration d'intention
 * d'aliéner par la commune, état daté attendu du syndic, acte prévu. Une date corrigée s'ajoute en nouvelle version,
 * l'ancienne reste [R17]. Le code calcule les échéances légales ; les autres sont lues telles que saisies ; aucune
 * n'est inventée : une échéance sans sa date est dite « à saisir » [R10, R61].
 *
 * - Fin de la rétractation de l'acquéreur : 10 jours à compter du lendemain de la première présentation de la
 *   notification ; un délai qui finit un samedi, un dimanche ou un jour férié est prolongé jusqu'au premier jour
 *   ouvrable suivant.
 * - Réponse de la commune sur son droit de préemption : 2 mois après la réception de la déclaration ; un mois plus court
 *   finit à son dernier jour. Une demande unique de pièces ou de visite suspend le délai, qui reprend pour ce qui en
 *   restait, au moins un mois. Son silence vaut renonciation.
 *
 * Chaque jour, une tâche pour l'agent avant chaque échéance (nombre de jours d'avance en réglage), une seule par
 * échéance et par date ; une tâche aussi pour chaque échéance encore à saisir, une seule. Rien n'est envoyé aux clients.
 *
 * Décidé, lecture prudente : rien ne se saisit avant que le compromis soit en préparation, donc l'identité de
 * l'acquéreur vérifiée [R58] ; la signature du compromis se saisit d'abord, les autres dates ne la précèdent pas ;
 * la date limite du prêt n'a pas d'objet si l'offre n'a pas de condition de prêt, l'état daté si le bien n'est pas un
 * lot de copropriété ; une fin du délai de la commune un samedi, un dimanche ou un jour férié est reportée au jour
 * ouvrable suivant, pour ne jamais annoncer trop tôt un silence acquis.
 *
 * Calendrier territorial (AU085) : en Moselle, dans le Bas-Rhin et le Haut-Rhin, le Vendredi saint et la Saint-Étienne
 * sont fériés en plus ; chaque délai dit le calendrier qu'il suit et pourquoi (voir `calendrier.ts`).
 *
 * Coacquéreurs (AU009) : chacun a sa propre notification, avec sa date, sa preuve et ses versions, donc son propre délai
 * de rétractation. Le dossier retient le dernier délai : la rétractation est « à saisir » tant qu'un seul des
 * coacquéreurs n'a pas de date, et finit au dernier jour du délai le plus tardif.
 */
import type { Acces } from '../acces/acces.ts';
import type { Viewer } from '../acces/droits.ts';
import type { PropertySheet } from '../annonces/fiche-bien.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { localTime } from '../envoi/horaires.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import { PROOF_REF } from '../offres/transmission.ts';
import { buyersInAlsaceMoselle, calendarFor, isWorkingDayIn, propertyPlaceOf, type Calendar, type CalendarReason } from './calendrier.ts';
import { actorOf, gateSaleFile, openFile, type FileRefusal, type FileUnknown } from './acces-dossier.ts';

const TIME_ZONE = 'Europe/Paris';
export const BUYER_WITHDRAWAL_DAYS = 10;
export const PREEMPTION_MONTHS = 2;

export const DATE_KINDS = ['compromis_signe', 'notification_acquereur', 'date_limite_pret', 'dia_recue', 'dia_suspension', 'dia_reprise', 'etat_date_attendu', 'acte_prevu'] as const;
export type DateKind = (typeof DATE_KINDS)[number];

/** Les dates qui ont eu lieu : jamais dans le futur. Les autres sont des dates à venir lues dans le compromis. */
const PAST_KINDS: readonly DateKind[] = ['compromis_signe', 'notification_acquereur', 'dia_recue', 'dia_suspension', 'dia_reprise'];
/** Une date qui en suppose une autre, et ne la précède pas. */
const AFTER: Partial<Record<DateKind, DateKind>> = { dia_suspension: 'dia_recue', dia_reprise: 'dia_suspension' };

export const DEADLINES = ['fin_retractation', 'reponse_preemption', 'date_limite_pret', 'etat_date', 'acte'] as const;
export type Deadline = (typeof DEADLINES)[number];

/** Jours d'avance de la tâche de l'agent, par échéance : des réglages. */
export const DEFAULT_NOTICE_DAYS: Record<Deadline, number> = { fin_retractation: 1, reponse_preemption: 7, date_limite_pret: 10, etat_date: 7, acte: 7 };

const DAY = /^\d{4}-\d{2}-\d{2}$/;

function validDay(v: unknown): v is string {
  if (typeof v !== 'string' || !DAY.test(v)) return false;
  const d = new Date(`${v}T12:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

export const addDays = (day: string, n: number): string => new Date(Date.parse(`${day}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/**
 * Dernier jour de la rétractation de l'acquéreur (inclus), depuis la première présentation de la notification, dans le
 * calendrier du délai (AU085).
 */
export function buyerWithdrawalLastDay(notifiedOn: string, calendar: Calendar = 'national'): string {
  return nextWorkingDay(addDays(notifiedOn, BUYER_WITHDRAWAL_DAYS), calendar);
}

/** Le même jour, `n` mois plus tard ; au dernier jour du mois s'il est plus court. */
function addMonths(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const months = m - 1 + n;
  const year = y + Math.floor(months / 12);
  const month = months % 12;
  const lastOfMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return `${year}-${String(month + 1).padStart(2, '0')}-${String(Math.min(d, lastOfMonth)).padStart(2, '0')}`;
}

const daysBetween = (from: string, to: string): number => Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86_400_000);

function nextWorkingDay(day: string, calendar: Calendar): string {
  let d = day;
  while (!isWorkingDayIn(d, calendar)) d = addDays(d, 1);
  return d;
}

/** La fin du délai de la commune sans suspension, reportée au jour ouvrable suivant. */
export const preemptionBaseEnd = (receivedOn: string, calendar: Calendar = 'national'): string => nextWorkingDay(addMonths(receivedOn, PREEMPTION_MONTHS), calendar);

/**
 * Le jour où la commune doit avoir répondu sur son droit de préemption, ou null tant que le délai est suspendu.
 * 2 mois après la réception de la déclaration, au dernier jour du mois s'il est plus court. Une demande unique de pièces
 * ou de visite suspend le délai ; il reprend à la réception des pièces ou à la visite, pour ce qui en restait, et au
 * moins un mois. Lecture prudente : une fin un samedi, un dimanche ou un jour férié est reportée au jour ouvrable
 * suivant, pour ne jamais dire acquis un silence qui ne l'est pas encore.
 */
export function preemptionLastDay(receivedOn: string, suspendedOn?: string, resumedOn?: string, calendar: Calendar = 'national'): string | null {
  // La fin sans suspension, reportée au jour ouvrable : une demande faite jusqu'à ce jour suspend encore le délai.
  let end = preemptionBaseEnd(receivedOn, calendar);
  if (suspendedOn && suspendedOn <= end) {
    if (!resumedOn) return null;
    const rest = addDays(resumedOn, daysBetween(suspendedOn, end));
    const month = addMonths(resumedOn, 1);
    end = rest > month ? rest : month;
  }
  return nextWorkingDay(end, calendar);
}

export interface ScheduleLine {
  deadline: Deadline;
  /** `calcul` : par le code depuis une date saisie ; `saisie` : telle que saisie depuis le compromis. */
  source: 'calcul' | 'saisie';
  /** Le jour de l'échéance, `AAAA-MM-JJ` ; null quand la date dont elle dépend n'est pas saisie. */
  day: string | null;
  /** `a_saisir` : la date manque ; `sans_objet` : pas de condition de prêt, pas de copropriété ; `suspendue` : le délai de la commune attend ses pièces ou sa visite. */
  status: 'datee' | 'a_saisir' | 'sans_objet' | 'suspendue';
  /** La date saisie dont l'échéance vient. */
  from: DateKind;
  /** Le calendrier des jours fériés d'un délai calculé (AU085) ; null pour une date lue telle que saisie. */
  calendar: Calendar | null;
}

/** Les calendriers des délais calculés d'un dossier (AU085). Par défaut, le calendrier national. */
export interface ScheduleCalendars {
  preemption?: Calendar;
  /** La rétractation de l'acquéreur en tête. */
  lead?: Calendar;
  /** Celle de chaque coacquéreur, dans l'ordre de `coBuyersNotifiedOn`. */
  coBuyers?: readonly Calendar[];
}

/** La notification d'un acquéreur du dossier et son propre délai de rétractation (AU009). */
export interface BuyerNotice {
  /** null quand celui qui lit ne voit pas cette fiche en entier [R16]. */
  personId: string | null;
  /** L'acquéreur en tête de l'offre ; les autres sont ses coacquéreurs. */
  lead: boolean;
  /** La première présentation de sa notification, ou null tant qu'elle n'est pas saisie. */
  notifiedOn: string | null;
  version: number | null;
  /** Le dernier jour de sa rétractation, ou null. */
  lastDay: string | null;
  /** Le calendrier de son délai et pourquoi (AU085) ; null quand celui qui lit ne voit pas cette fiche en entier. */
  calendar: Calendar | null;
  calendarReason: CalendarReason;
}

export interface Schedule {
  fileId: string;
  dates: Partial<Record<DateKind, { day: string; version: number }>>;
  /** Un acquéreur par ligne, l'acquéreur en tête d'abord, chacun avec son délai. */
  buyers: BuyerNotice[];
  lines: ScheduleLine[];
  /** Le calendrier du délai de la commune et pourquoi (AU085). */
  preemptionCalendar: { calendar: Calendar; reason: CalendarReason };
}

/**
 * L'échéancier, depuis les dates saisies. Fonction pure, dans un ordre fixe : mêmes dates, mêmes échéances [R61].
 * `coBuyersNotifiedOn` : la notification de chaque coacquéreur, null tant qu'elle manque (AU009). La fin de la
 * rétractation est la plus tardive de tous ; à saisir tant qu'une seule manque.
 */
export function scheduleLines(dates: Partial<Record<DateKind, string>>, facts: { hasLoanCondition: boolean; isCoownershipLot: boolean | null }, coBuyersNotifiedOn: readonly (string | null)[] = [], calendars: ScheduleCalendars = {}): ScheduleLine[] {
  const line = (deadline: Deadline, source: 'calcul' | 'saisie', from: DateKind, day: string | null, calendar: Calendar | null = null): ScheduleLine => ({ deadline, source, from, day, status: day === null ? 'a_saisir' : 'datee', calendar });
  const pre = calendars.preemption ?? 'national';
  const notices: { day: string | null; calendar: Calendar }[] = [
    { day: dates.notification_acquereur ?? null, calendar: calendars.lead ?? 'national' },
    ...coBuyersNotifiedOn.map((day, i) => ({ day, calendar: calendars.coBuyers?.[i] ?? 'national' })),
  ];
  const withdrawal = notices.some((n) => n.day === null) ? null : notices.map((n) => buyerWithdrawalLastDay(n.day!, n.calendar)).reduce((a, b) => (a > b ? a : b));
  // Le calendrier du délai retenu : celui d'Alsace-Moselle dès qu'un acquéreur le suit.
  const withdrawalCalendar: Calendar = notices.some((n) => n.calendar === 'alsace_moselle') ? 'alsace_moselle' : 'national';
  const dia = dates.dia_recue;
  const lines: ScheduleLine[] = [
    line('fin_retractation', 'calcul', 'notification_acquereur', withdrawal, withdrawalCalendar),
    !dia ? line('reponse_preemption', 'calcul', 'dia_recue', null, pre)
      : dates.dia_suspension && !dates.dia_reprise && dates.dia_suspension <= preemptionBaseEnd(dia, pre) ? { deadline: 'reponse_preemption', source: 'calcul', from: 'dia_suspension', day: null, status: 'suspendue', calendar: pre }
      : line('reponse_preemption', 'calcul', dates.dia_reprise ? 'dia_reprise' : 'dia_recue', preemptionLastDay(dia, dates.dia_suspension, dates.dia_reprise, pre), pre),
    facts.hasLoanCondition ? line('date_limite_pret', 'saisie', 'date_limite_pret', dates.date_limite_pret ?? null) : { deadline: 'date_limite_pret', source: 'saisie', from: 'date_limite_pret', day: null, status: 'sans_objet', calendar: null },
    // La copropriété inconnue : l'état daté est demandé, par prudence.
    facts.isCoownershipLot === false ? { deadline: 'etat_date', source: 'saisie', from: 'etat_date_attendu', day: null, status: 'sans_objet', calendar: null } : line('etat_date', 'saisie', 'etat_date_attendu', dates.etat_date_attendu ?? null),
    line('acte', 'saisie', 'acte_prevu', dates.acte_prevu ?? null),
  ];
  return lines;
}

/** Ce qui cloche dans l'ordre d'un ensemble de dates, ou null. */
export function orderProblem(d: Partial<Record<DateKind, string>>): 'compromis_first' | 'before_compromis' | 'out_of_order' | null {
  const signed = d.compromis_signe;
  const others = DATE_KINDS.filter((k) => k !== 'compromis_signe' && d[k] !== undefined);
  if (!signed) return others.length ? 'compromis_first' : null;
  if (others.some((k) => d[k]! < signed)) return 'before_compromis';
  for (const [k, before] of Object.entries(AFTER) as [DateKind, DateKind][]) {
    if (d[k] !== undefined && (d[before] === undefined || d[k]! < d[before]!)) return 'out_of_order';
  }
  return null;
}

export interface FileTask {
  fileId: string;
  propertyId: string;
  deadline: Deadline;
  /** `avant_echeance` : l'échéance approche ; `a_saisir` : sa date manque. */
  kind: 'avant_echeance' | 'a_saisir';
  /** Le jour de l'échéance, ou null pour une date à saisir. */
  day: string | null;
  createdAt: string;
}

export type ScheduleProblem = { ok: false; rule: null; code: 'unknown_buyer' | 'buyer_required' | 'unknown_date' | 'bad_day' | 'bad_proof' | 'not_stored' | 'future_day' | 'before_compromis' | 'compromis_first' | 'out_of_order' | 'busy' | 'closed' } | { ok: false; rule: 'R460'; code: 'set_by_registered_letter' } | { ok: false; rule: 'R58'; code: 'compromis_not_started' };

export class Echeancier {
  private readonly now: () => Date;
  private readonly notice: Record<Deadline, number>;
  private readonly proofs: { has(ref: string): Promise<boolean> } | null;

  constructor(
    private readonly db: SqlDatabase,
    private readonly acces: Acces,
    private readonly journal: JournalStore,
    options: { now?: () => Date; noticeDays?: Partial<Record<Deadline, number>>; /** Donné par les routes (N13) : une preuve qui n'est pas rangée est refusée [R10]. */ proofs?: { has(ref: string): Promise<boolean> } } = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.notice = { ...DEFAULT_NOTICE_DAYS, ...(options.noticeDays ?? {}) };
    this.proofs = options.proofs ?? null;
    for (const d of DEADLINES) if (!Number.isInteger(this.notice[d]) || this.notice[d] < 0 || this.notice[d] > 60) throw new Error(`Délai de rappel de l'échéance ${d} : de 0 à 60 jours.`);
  }

  private gate(viewer: Viewer, fileId: string, write: boolean) {
    return gateSaleFile({ db: this.db, acces: this.acces, journal: this.journal, now: this.now }, viewer, fileId, write, 'sale_file_schedule');
  }

  private today(): string {
    return localTime(this.now(), TIME_ZONE).date;
  }

  private async datesOf(fileId: string): Promise<Partial<Record<DateKind, { day: string; version: number }>>> {
    const rows = await this.db.all<{ kind: DateKind; day: string; version: number }>(
      `SELECT kind, day, version FROM sale_file_dates d WHERE file_id = ?
       AND version = (SELECT MAX(version) FROM sale_file_dates e WHERE e.file_id = d.file_id AND e.kind = d.kind)`,
      [fileId],
    );
    return Object.fromEntries(rows.map((r) => [r.kind, { day: r.day, version: Number(r.version) }]));
  }

  private async facts(file: { offer_id: string; property_id: string }): Promise<{ hasLoanCondition: boolean; isCoownershipLot: boolean | null }> {
    const offer = await this.db.first<{ conditions: string }>('SELECT conditions FROM offer_register WHERE id = ?', [file.offer_id]);
    const conditions = offer ? (JSON.parse(offer.conditions) as { kind: string }[]) : [];
    const sheet = await this.db.first<{ data: string }>('SELECT data FROM property_sheets WHERE property_id = ? ORDER BY version DESC LIMIT 1', [file.property_id]);
    const coownership = sheet ? (JSON.parse(sheet.data) as PropertySheet).coownership : null;
    return { hasLoanCondition: conditions.some((c) => c.kind === 'pret'), isCoownershipLot: coownership === null ? null : coownership.isCoownership };
  }

  /** L'acquéreur en tête et les coacquéreurs de l'offre du dossier, dans l'ordre de l'offre (AU009). */
  private async buyersOf(file: { id: string; offer_id: string }): Promise<{ lead: string; co: string[] }> {
    const row = await this.db.first<{ buyer_person_id: string; co_buyers: string | null }>(
      'SELECT f.buyer_person_id, o.co_buyers FROM sale_files f JOIN offer_register o ON o.id = f.offer_id WHERE f.id = ?',
      [file.id],
    );
    return { lead: row?.buyer_person_id ?? '', co: JSON.parse(row?.co_buyers ?? '[]') as string[] };
  }

  /** La dernière version de la notification de chaque coacquéreur. */
  private async coNoticesOf(fileId: string): Promise<Map<string, { day: string; version: number }>> {
    const rows = await this.db.all<{ person_id: string; day: string; version: number }>(
      `SELECT person_id, day, version FROM sale_file_buyer_notices n WHERE file_id = ?
       AND version = (SELECT MAX(version) FROM sale_file_buyer_notices m WHERE m.file_id = n.file_id AND m.person_id = n.person_id)`,
      [fileId],
    );
    return new Map(rows.map((r) => [r.person_id, { day: r.day, version: Number(r.version) }]));
  }

  /**
   * L'échéancier tel que le lit une personne : chaque acquéreur dont elle ne voit pas la fiche en entier y reste, sans son
   * identifiant ni ses dates ; le délai collectif du dossier ne change pas [R16] (AU009).
   */
  private async visibleTo(viewer: Viewer, schedule: Schedule): Promise<Schedule> {
    const buyers: BuyerNotice[] = [];
    for (const b of schedule.buyers) {
      const read = b.personId ? await this.acces.readFiche(viewer, b.personId) : null;
      buyers.push(read?.ok && read.view === 'full' ? b : { personId: null, lead: b.lead, notifiedOn: null, version: null, lastDay: null, calendar: null, calendarReason: null });
    }
    return { ...schedule, buyers };
  }

  /** L'échéancier d'un dossier, pour les passages du système, qui ne montrent rien à personne : sans contrôle d'accès. */
  async scheduleOf(file: { id: string; offer_id: string; property_id: string }): Promise<Schedule> {
    const dates = await this.datesOf(file.id);
    const days = Object.fromEntries(Object.entries(dates).map(([k, v]) => [k, v.day])) as Partial<Record<DateKind, string>>;
    const { lead, co } = await this.buyersOf(file);
    const notices = await this.coNoticesOf(file.id);
    // Le calendrier de chaque délai (AU085) : le lieu du bien, et pour la rétractation le domicile de chaque acquéreur.
    const place = await propertyPlaceOf(this.db, file.property_id);
    const local = await buyersInAlsaceMoselle(this.db, [lead, ...co]);
    const calOf = (personId: string) => calendarFor(place, local.has(personId));
    const notice = (personId: string, isLead: boolean, n: { day: string; version: number } | undefined): BuyerNotice => {
      const c = calOf(personId);
      return { personId, lead: isLead, notifiedOn: n?.day ?? null, version: n?.version ?? null, lastDay: n ? buyerWithdrawalLastDay(n.day, c.calendar) : null, calendar: c.calendar, calendarReason: c.reason };
    };
    const buyers = [notice(lead, true, dates.notification_acquereur), ...co.map((p) => notice(p, false, notices.get(p)))];
    const preemptionCalendar = calendarFor(place);
    const calendars: ScheduleCalendars = { preemption: preemptionCalendar.calendar, lead: calOf(lead).calendar, coBuyers: co.map((p) => calOf(p).calendar) };
    return { fileId: file.id, dates, buyers, preemptionCalendar, lines: scheduleLines(days, await this.facts(file), co.map((p) => notices.get(p)?.day ?? null), calendars) };
  }

  /** L'échéancier du dossier : agent du bien, direction, conformité [R16]. */
  async schedule(viewer: Viewer, fileId: string): Promise<{ ok: true; value: Schedule } | FileRefusal | FileUnknown> {
    const g = await this.gate(viewer, fileId, false);
    if (!g.ok) return g;
    return { ok: true, value: await this.visibleTo(viewer, await this.scheduleOf(g.file)) };
  }

  /** L'agent du dossier saisit une date du compromis, avec sa preuve. Une correction s'ajoute en nouvelle version [R17]. */
  async record(viewer: Viewer, fileId: string, input: { kind: unknown; day: unknown; proofRef: unknown; /** L'acquéreur notifié, quand l'offre a des coacquéreurs (AU009). */ personId?: unknown }): Promise<{ ok: true; value: Schedule } | FileRefusal | FileUnknown | ScheduleProblem> {
    const g = await this.gate(viewer, fileId, true);
    if (!g.ok) return g;
    // Un dossier clos par l'acte ne reçoit plus de date (N13) : aucune tâche ni aucun chemin ne la lirait.
    if (await this.db.first('SELECT 1 FROM sale_file_closings WHERE file_id = ?', [fileId])) return { ok: false, rule: null, code: 'closed' };
    if (typeof input.kind !== 'string' || !(DATE_KINDS as readonly string[]).includes(input.kind)) return { ok: false, rule: null, code: 'unknown_date' };
    const kind = input.kind as DateKind;
    if (!validDay(input.day)) return { ok: false, rule: null, code: 'bad_day' };
    const day = input.day;
    if (typeof input.proofRef !== 'string' || !PROOF_REF.test(input.proofRef)) return { ok: false, rule: null, code: 'bad_proof' };
    const started = await this.db.first("SELECT 1 FROM sale_file_steps WHERE file_id = ? AND step = 'compromis_en_preparation'", [fileId]);
    if (!started) {
      await appendEvent(this.journal, { type: 'dossier.bloque', actor: actorOf(viewer), subject: `sale_file:${fileId}`, data: { rule: 'R58', code: 'compromis_not_started' } }, this.now);
      return { ok: false, rule: 'R58', code: 'compromis_not_started' };
    }
    if (PAST_KINDS.includes(kind) && day > this.today()) return { ok: false, rule: null, code: 'future_day' };
    // Avec des coacquéreurs, chaque notification nomme son acquéreur ; une autre date n'en nomme aucun (AU009).
    const { lead, co } = await this.buyersOf(g.file);
    const personId = input.personId ?? null;
    if (personId !== null && (kind !== 'notification_acquereur' || typeof personId !== 'string' || (personId !== lead && !co.includes(personId)))) return { ok: false, rule: null, code: 'unknown_buyer' };
    if (kind === 'notification_acquereur' && personId === null && co.length > 0) return { ok: false, rule: null, code: 'buyer_required' };
    const coNotices = await this.coNoticesOf(fileId);
    if (personId !== null && personId !== lead) return this.recordCoBuyer(viewer, g.file, personId, day, input.proofRef, coNotices);
    // La première présentation prouvée par le prestataire de la lettre recommandée (HX36) fait foi : elle ne se
    // ressaisit pas à la main [R460].
    if (kind === 'notification_acquereur' && (await this.db.first("SELECT 1 FROM registered_letter_events WHERE file_id = ? AND kind = 'premiere_presentation'", [fileId]))) {
      return { ok: false, rule: 'R460', code: 'set_by_registered_letter' };
    }
    const dates = await this.datesOf(fileId);
    // Les dates telles qu'elles seraient après cette saisie : toutes doivent rester dans l'ordre, y compris celles déjà
    // saisies qui suivent la date corrigée.
    const proposed = Object.fromEntries(Object.entries(dates).map(([k, v]) => [k, v.day])) as Partial<Record<DateKind, string>>;
    proposed[kind] = day;
    const problem = orderProblem(proposed);
    if (problem) return { ok: false, rule: null, code: problem };
    // Une signature corrigée ne passe pas après la notification déjà saisie d'un coacquéreur.
    if (proposed.compromis_signe && [...coNotices.values()].some((n) => n.day < proposed.compromis_signe!)) return { ok: false, rule: null, code: 'before_compromis' };
    if (this.proofs && !(await this.proofs.has(input.proofRef))) return { ok: false, rule: null, code: 'not_stored' };
    const version = (dates[kind]?.version ?? 0) + 1;
    try {
      await this.db.run(
        'INSERT INTO sale_file_dates (file_id, network_id, kind, version, day, proof_ref, at, by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [fileId, g.file.network_id, kind, version, day, input.proofRef, this.now().toISOString(), actorOf(viewer)],
      );
    } catch (error) {
      if (/UNIQUE/i.test(String(error))) return { ok: false, rule: null, code: 'busy' };
      throw error;
    }
    await appendEvent(this.journal, { type: 'dossier.date', actor: actorOf(viewer), subject: `sale_file:${fileId}`, data: { rule: 'R61', kind, version } }, this.now);
    return { ok: true, value: await this.visibleTo(viewer, await this.scheduleOf(g.file)) };
  }

  /** La notification d'un coacquéreur : sa date, sa preuve, en nouvelle version si elle est corrigée [R17] (AU009). */
  private async recordCoBuyer(
    viewer: Viewer,
    file: { id: string; network_id: string; offer_id: string; property_id: string },
    personId: string,
    day: string,
    proofRef: string,
    notices: Map<string, { day: string; version: number }>,
  ): Promise<{ ok: true; value: Schedule } | ScheduleProblem> {
    const dates = await this.datesOf(file.id);
    if (!dates.compromis_signe) return { ok: false, rule: null, code: 'compromis_first' };
    if (day < dates.compromis_signe.day) return { ok: false, rule: null, code: 'before_compromis' };
    if (this.proofs && !(await this.proofs.has(proofRef))) return { ok: false, rule: null, code: 'not_stored' };
    const version = (notices.get(personId)?.version ?? 0) + 1;
    try {
      await this.db.run(
        'INSERT INTO sale_file_buyer_notices (file_id, network_id, person_id, version, day, proof_ref, at, by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [file.id, file.network_id, personId, version, day, proofRef, this.now().toISOString(), actorOf(viewer)],
      );
    } catch (error) {
      if (/UNIQUE|PRIMARY/i.test(String(error))) return { ok: false, rule: null, code: 'busy' };
      throw error;
    }
    // Au journal : la fiche du coacquéreur par son identifiant, jamais son nom [R13].
    await appendEvent(this.journal, { type: 'dossier.date', actor: actorOf(viewer), subject: `sale_file:${file.id}`, data: { rule: 'R61', kind: 'notification_acquereur', version, person: `person:${personId}` } }, this.now);
    return { ok: true, value: await this.visibleTo(viewer, await this.scheduleOf(file)) };
  }

  /**
   * Le passage du jour : pour chaque dossier dont le compromis est signé, une tâche avant chaque échéance datée, et une
   * pour chaque échéance encore à saisir. Une seule par échéance et par date. Rend le nombre de tâches créées.
   */
  async run(networkId: string): Promise<number> {
    const today = this.today();
    const files = await this.db.all<{ id: string; offer_id: string; property_id: string; agent_id: string | null }>(
      `SELECT f.id, f.offer_id, f.property_id, p.agent_id FROM sale_files f JOIN properties p ON p.id = f.property_id
       WHERE f.network_id = ? AND EXISTS (SELECT 1 FROM sale_file_dates d WHERE d.file_id = f.id AND d.kind = 'compromis_signe')
       AND NOT EXISTS (SELECT 1 FROM sale_file_closings c WHERE c.file_id = f.id) AND ${openFile('f')}
       ORDER BY f.opened_at, f.id`,
      [networkId],
    );
    let created = 0;
    for (const f of files) {
      if (!f.agent_id) continue;
      const s = await this.scheduleOf(f);
      for (const l of s.lines) {
        let due: string | null = null;
        if (l.status === 'a_saisir') due = '';
        else if (l.status === 'datee' && l.day! >= today && addDays(l.day!, -this.notice[l.deadline]) <= today) due = l.day!;
        if (due === null) continue;
        const { changes } = await this.db.run(
          'INSERT INTO sale_file_tasks (file_id, network_id, agent_id, deadline, due_day, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (file_id, deadline, due_day, agent_id) DO NOTHING',
          [f.id, networkId, f.agent_id, l.deadline, due, this.now().toISOString()],
        );
        if (changes !== 1) continue;
        created += 1;
        await appendEvent(this.journal, { type: due === '' ? 'dossier.date_a_saisir' : 'dossier.echeance', actor: 'system:dossiers', subject: `sale_file:${f.id}`, data: { rule: 'R61', deadline: l.deadline, ...(due === '' ? {} : { day: due }) } }, this.now);
      }
    }
    return created;
  }

  /**
   * Les tâches de l'agent, pour lui seul, encore utiles : une échéance pas encore passée dont la date n'a pas changé, ou
   * une date toujours à saisir [R16].
   */
  async tasksOf(viewer: Viewer): Promise<{ ok: true; tasks: FileTask[] } | FileRefusal> {
    const refuse = async (code: 'not_agent' | 'agent_inactive') => {
      await appendEvent(this.journal, { type: 'acces.refuse', actor: actorOf(viewer), subject: null, data: { rule: 'R16', role: String(viewer.role), kind: 'sale_file_tasks', code } }, this.now);
      return { ok: false as const, rule: 'R16' as const, code };
    };
    if (viewer.role !== 'agent') return refuse('not_agent');
    const agent = await this.db.first<{ network_id: string; status: string }>('SELECT network_id, status FROM agents WHERE id = ?', [viewer.userId]);
    if (!agent || agent.network_id !== viewer.networkId || agent.status !== 'active') return refuse('agent_inactive');
    const rows = await this.db.all<{ file_id: string; property_id: string; offer_id: string; deadline: Deadline; due_day: string; created_at: string }>(
      `SELECT k.file_id, f.property_id, f.offer_id, k.deadline, k.due_day, k.created_at FROM sale_file_tasks k JOIN sale_files f ON f.id = k.file_id
       JOIN properties p ON p.id = f.property_id
       WHERE k.network_id = ? AND k.agent_id = ? AND p.agent_id = k.agent_id AND NOT EXISTS (SELECT 1 FROM sale_file_closings c WHERE c.file_id = k.file_id) AND ${openFile('f')} ORDER BY k.created_at, k.deadline`,
      [viewer.networkId, viewer.userId],
    );
    const today = this.today();
    const schedules = new Map<string, Schedule>();
    const tasks: FileTask[] = [];
    for (const r of rows) {
      if (!schedules.has(r.file_id)) schedules.set(r.file_id, await this.scheduleOf({ id: r.file_id, offer_id: r.offer_id, property_id: r.property_id }));
      const line = schedules.get(r.file_id)!.lines.find((l) => l.deadline === r.deadline)!;
      if (r.due_day === '') {
        if (line.status === 'a_saisir') tasks.push({ fileId: r.file_id, propertyId: r.property_id, deadline: r.deadline, kind: 'a_saisir', day: null, createdAt: r.created_at });
      } else if (line.day === r.due_day && r.due_day >= today) {
        tasks.push({ fileId: r.file_id, propertyId: r.property_id, deadline: r.deadline, kind: 'avant_echeance', day: r.due_day, createdAt: r.created_at });
      }
    }
    // Chaque lecture est écrite au journal, sans donnée personnelle : qui, quand, quels dossiers [R16].
    await appendEvent(this.journal, { type: 'dossier.taches_lues', actor: actorOf(viewer), subject: `agent:${viewer.userId}`, data: { rule: 'R16', files: [...new Set(tasks.map((x) => `sale_file:${x.fileId}`))] } }, this.now);
    tasks.sort((a, b) => ((a.day ?? '') < (b.day ?? '') ? -1 : (a.day ?? '') > (b.day ?? '') ? 1 : DEADLINES.indexOf(a.deadline) - DEADLINES.indexOf(b.deadline)));
    return { ok: true, tasks };
  }
}

