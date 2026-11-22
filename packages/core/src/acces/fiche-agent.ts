/**
 * La fiche du client telle que l'application de l'agent la montre (A03) : projets, origines, accords, derniers
 * messages, rappels, et le numéro à appeler en un geste.
 *
 * Tout passe par la lecture de fiche sous droits d'accès [R16] : la lecture, ou le refus, est écrite au journal avant
 * qu'une donnée soit rendue. Seul celui qui voit la fiche en entier la reçoit ; la fiche d'un autre agent est refusée.
 *
 * Une personne exclue ou qui a demandé l'arrêt est signalée, avec la raison, et n'a pas de numéro à appeler : l'écran
 * n'a donc pas de bouton d'appel pour elle [R02, R04]. Décidé, lecture prudente : comme pour les envois, toute
 * exclusion active ferme l'appel, quel que soit le canal où elle a été notée. Rien n'est envoyé d'ici.
 *
 * Sans accord pour un appel, pas de numéro non plus (AC04) [R03] : depuis le 11 août 2026, aucun appel de prospection
 * sans accord préalable prouvé, et un appel reste possible vers qui l'a demandé. Décidé, lecture prudente :
 * - seules ouvrent l'appel, par téléphone, la prospection acceptée (`prospecting`), le formulaire « Être rappelé »
 *   (`reply`) et la demande de rappel notée par l'agent (`rappel_demande`). Un accord pour un autre sujet n'autorise pas
 *   un appel, et la parole d'un tiers (`recommandation`) n'est pas la demande de la personne ;
 * - une demande vaut 13 mois, comme au plan du jour (`CALL_REQUEST_DAYS`) ; passé ce délai, c'est de la prospection ;
 * - tout retrait d'un accord par téléphone ferme les accords par téléphone donnés avant lui, sur les fiches réunies
 *   comprises : la personne a dit de ne plus l'appeler ; un accord plus ancien qu'une levée d'exclusion ne vaut plus ;
 * - un rappel à faire n'est pas une demande : la tâche vient du classement du contact, pas de la personne ;
 * - le numéro composé est le dernier donné : c'est celui de la demande la plus récente, pas une plus ancienne.
 *
 * Horaires (AC06) [R203] : le cahier demande ceux du décret n° 2022-1313 : du lundi au vendredi, de 10 h à 13 h et de 14 h
 * à 20 h, hors jours fériés. Décidé, lecture prudente : ils ferment l'appel qui ne repose que sur la prospection acceptée,
 * même si une source de 2022 dit que le décret ne s'applique pas à un consentement préalable : la règle de 2026 n'a pas pu
 * être lue à sa source, et l'avocat tranchera (H41). Une personne qui a demandé à être rappelée n'est pas démarchée :
 * sa demande reste ouverte à toute heure. L'application peut rester ouverte longtemps : `callClosesAt` donne la fin du
 * créneau, et l'écran refuse l'appel passé cette heure.
 *
 * Fréquence (AC09) [R204] : les appels notés par l'agent comptent. Lecture prudente, chiffres en réglage : 4 appels de
 * prospection en 30 jours ferment le bouton, un refus le ferme 60 jours. Source officielle non lue, question à l'avocat
 * (H41). Un appel sur demande de la personne ne compte pas ; une demande donnée après le refus rouvre l'appel, une demande
 * plus ancienne que le refus ne vaut plus : l'écran le dit (`refused_request`, AC12), sans date, seule une nouvelle demande rouvre.
 */
import type { SqlDatabase } from '../db/sql.ts';
import { isWorkingDay, localTime } from '../envoi/horaires.ts';
import type { Consent, ExclusionReason } from '../db/types.ts';
import type { FicheComplete } from '../fiche/fusion.ts';
import { callbackTaskDue } from '../qualification/delai-rappel.ts';
import type { Category, Route } from '../qualification/regles.ts';
import type { Acces } from './acces.ts';
import type { Viewer } from './droits.ts';

export interface AgentFiche {
  personId: string;
  firstName: string | null;
  lastName: string | null;
  /** Présent pour la direction seule : elle peut corriger un nom déjà écrit (SV10) ; le serveur décide de toute façon [R16]. */
  nameCorrectable?: true;
  /** Exclusions actives : la personne ne doit plus être contactée [R02, R04]. */
  contact: { allowed: boolean; reasons: ExclusionReason[] };
  /** Numéro à appeler, en `tel:` ; null si la personne est exclue, a demandé l'arrêt, n'a pas d'accord ou pas de numéro. */
  call: string | null;
  /** Fin du créneau d'appel, quand l'appel ne repose que sur la prospection acceptée [R203] ; sinon null. */
  callClosesAt: string | null;
  /** Pourquoi il n'y a pas de numéro à appeler, pour que l'écran le dise ; null si l'appel est ouvert. */
  callRefusal: 'excluded' | 'no_phone' | 'no_consent' | 'refused_request' | 'refused_recently' | 'too_many_calls' | 'outside_hours' | null;
  /** Quand l'appel rouvre, après un refus ou trop d'appels [R204] ; sinon rien. */
  callReopensAt: string | null;
  projects: { id: string; kind: string; stage: string; deadline: string | null; budgetMinEur: number | null; budgetMaxEur: number | null }[];
  sources: { channel: string; detail: string | null; occurredAt: string }[];
  consents: { id: string; purpose: string; channel: string; givenAt: string; withdrawnAt: string | null }[];
  /** Les derniers messages, du plus récent au plus ancien. */
  messages: { channel: string; direction: string; author: string; body: string; occurredAt: string }[];
  /** Les rappels de la fiche, ouverts d'abord ; un rappel fait garde sa ligne [R17]. */
  callbacks: { taskId: string; reason: string; dueAt: string; doneAt: string | null }[];
  /**
   * Le dernier classement du contact, et sa dernière correction (Q08). La demande, jamais une note : ni score, ni
   * température, ni origine du classement, ni auteur de la correction. Null si aucun message n'a été classé.
   */
  qualification: {
    id: string;
    category: Category;
    route: Route | null;
    classifiedAt: string;
    correction: { category: Category; route: Route | null; correctedAt: string } | null;
  } | null;
}

export type AgentFicheRead = { ok: true; value: AgentFiche } | { ok: false; rule: 'R16'; code: string };

export const AGENT_FICHE_MESSAGES = 10;
const EXCERPT = 500;
const placeholders = (n: number): string => Array.from({ length: n }, () => '?').join(', ');

/** Les finalités d'un accord par téléphone qui ouvrent l'appel [R03]. */
export const CALL_PURPOSES: readonly string[] = Object.freeze(['prospecting', 'reply', 'rappel_demande']);
/** Celles qui viennent d'une demande de la personne, valables un temps. */
const CALL_REQUEST_PURPOSES: readonly string[] = Object.freeze(['reply', 'rappel_demande']);
/** Le même réglage de départ que `requestDays` du plan du jour : 13 mois. */
export const CALL_REQUEST_DAYS = 395;

/** Les heures du démarchage téléphonique, à l'heure de Paris : jour ouvré, 10 h à 13 h, 14 h à 20 h [R203]. */
export function inProspectingHours(at: Date): boolean {
  const local = localTime(at, 'Europe/Paris');
  if (!isWorkingDay(local)) return false;
  return (local.minutes >= 600 && local.minutes < 780) || (local.minutes >= 840 && local.minutes < 1200);
}

/** La fin du créneau en cours : 13 h le matin, 20 h l'après-midi [R203]. */
function prospectingSlotEnd(at: Date): Date {
  const { minutes } = localTime(at, 'Europe/Paris');
  const end = minutes < 780 ? 780 : 1200;
  return new Date(at.getTime() - (at.getTime() % 60_000) + (end - minutes) * 60_000);
}

type PhoneFacts = Pick<FicheComplete, 'consents' | 'exclusions'>;

/** Depuis quand l'appel est fermé : le dernier retrait d'un accord par téléphone ou la dernière levée d'exclusion. */
export function callClosedAt(fiche: PhoneFacts): number {
  return Math.max(
    -Infinity,
    ...fiche.exclusions.filter((e) => e.lifted_at !== null).map((e) => Date.parse(e.lifted_at!)),
    ...fiche.consents.filter((c) => c.channel === 'phone' && c.withdrawn_at !== null).map((c) => Date.parse(c.withdrawn_at!)),
  );
}

/** Cet accord ouvre-t-il l'appel à cet instant ? Le même calcul pour le bouton et pour noter un accord [R03]. */
export function consentOpensCall(c: Pick<Consent, 'purpose' | 'channel' | 'given_at' | 'withdrawn_at'>, fiche: PhoneFacts, at: number): boolean {
  if (c.channel !== 'phone' || !CALL_PURPOSES.includes(c.purpose) || c.withdrawn_at !== null) return false;
  const given = Date.parse(c.given_at);
  if (given > at || given <= callClosedAt(fiche)) return false;
  return !CALL_REQUEST_PURPOSES.includes(c.purpose) || at - given <= CALL_REQUEST_DAYS * 86_400_000;
}

/** Les chiffres de la fréquence : un réglage, tant que l'avocat n'a pas confirmé (H41) [R204]. */
export const CALL_FREQUENCY = Object.freeze({ maxCalls: 4, windowDays: 30, refusalDays: 60 });
const DAY_MS = 86_400_000;

export interface CallNote {
  outcome: 'called' | 'refused';
  basis: 'prospecting' | 'request';
  noted_at: string;
}

/** Le dernier refus noté, ou rien. */
export function lastCallRefusal(notes: readonly CallNote[], at: number): number {
  return Math.max(-Infinity, ...notes.filter((n) => n.outcome === 'refused' && Date.parse(n.noted_at) <= at).map((n) => Date.parse(n.noted_at)));
}

/** Une demande de la personne : elle ne vaut que donnée après son dernier refus [R204]. */
export function isCallRequest(c: Pick<Consent, 'purpose'>): boolean {
  return CALL_REQUEST_PURPOSES.includes(c.purpose);
}

/** Ce qui ouvre l'appel à cet instant, le même calcul pour le bouton et pour noter un appel [R03, R204]. */
export function usableCallConsents(fiche: PhoneFacts, notes: readonly CallNote[], at: number): Consent[] {
  const refused = lastCallRefusal(notes, at);
  return fiche.consents.filter((c) => consentOpensCall(c, fiche, at) && !(isCallRequest(c) && Date.parse(c.given_at) <= refused));
}

/** La fréquence de la prospection : fermée par un refus récent ou par trop d'appels, jusqu'à quand [R204]. */
export function callFrequencyClosure(notes: readonly CallNote[], at: number, limits: typeof CALL_FREQUENCY = CALL_FREQUENCY): { reason: 'refused_recently' | 'too_many_calls'; until: number } | null {
  const refused = lastCallRefusal(notes, at);
  const refusedUntil = refused + limits.refusalDays * DAY_MS;
  // Une note et sa copie d'une fusion défaite, de nouveau réunies, gardent la même heure : c'est un seul appel [R204].
  const calls = [...new Set(notes.filter((n) => n.basis === 'prospecting' && Date.parse(n.noted_at) <= at && at - Date.parse(n.noted_at) < limits.windowDays * DAY_MS).map((n) => Date.parse(n.noted_at)))].sort((a, b) => b - a);
  // Quand le nombre repasse sous le plafond : le plus ancien des appels qui le remplissent sort de la période.
  const callsUntil = calls.length >= limits.maxCalls ? (calls[limits.maxCalls - 1] as number) + limits.windowDays * DAY_MS : -Infinity;
  if (refusedUntil > at && refusedUntil >= callsUntil) return { reason: 'refused_recently', until: refusedUntil };
  if (callsUntil > at) return { reason: 'too_many_calls', until: callsUntil };
  return null;
}

const active = (notedAt: string, liftedAt: string | null, at: number): boolean => Date.parse(notedAt) <= at && (liftedAt === null || Date.parse(liftedAt) > at);

export class FicheAgent {
  private readonly now: () => Date;

  constructor(
    private readonly db: SqlDatabase,
    private readonly acces: Acces,
    options: { now?: () => Date } = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  async read(viewer: Viewer, personId: string): Promise<AgentFicheRead> {
    const read = await this.acces.readFiche(viewer, personId);
    if (!read.ok) return { ok: false, rule: read.rule, code: read.code };
    // Une vue partielle n'existe pas pour une fiche client ; dans le doute, rien n'est rendu.
    if (read.view !== 'full') return { ok: false, rule: 'R16', code: 'not_assigned' };
    const fiche = read.value;
    const at = this.now().getTime();

    const reasons = [...new Set(fiche.exclusions.filter((e) => active(e.noted_at, e.lifted_at, at)).map((e) => e.reason))];
    const allowed = reasons.length === 0;
    const phone = fiche.identifiers.filter((i) => i.kind === 'phone').sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id))[0];
    // Le numéro rangé est normalisé ; on ne garde que + et chiffres, par prudence.
    const digits = phone ? phone.value.replace(/[^+\d]/g, '') : '';
    const hasPhone = /^\+?\d{6,15}$/.test(digits);
    const ids = fiche.members.map((m) => m.id);
    const notes = await this.db.all<CallNote>(`SELECT outcome, basis, noted_at FROM call_notes WHERE person_id IN (${placeholders(ids.length)})`, ids);
    const usable = usableCallConsents(fiche, notes, at);
    const asked = usable.some(isCallRequest);
    const closure = asked ? null : callFrequencyClosure(notes, at);
    const callRefusal = !allowed
      ? 'excluded'
      : !hasPhone
        ? 'no_phone'
        : usable.length === 0
          ? // Une demande encore valable qui n'ouvre plus rien : la personne a refusé depuis. Seule une nouvelle demande rouvre [R204].
            fiche.consents.some((c) => isCallRequest(c) && consentOpensCall(c, fiche, at))
            ? 'refused_request'
            : 'no_consent'
          : closure
            ? closure.reason
            : !asked && !inProspectingHours(new Date(at))
              ? 'outside_hours'
              : null;
    const callReopensAt = (callRefusal === 'refused_recently' || callRefusal === 'too_many_calls') && closure ? new Date(closure.until).toISOString() : null;
    const call = callRefusal === null ? `tel:${digits}` : null;
    const callClosesAt = callRefusal === null && !asked ? prospectingSlotEnd(new Date(at)).toISOString() : null;

    const rawTasks = await this.db.all<{ id: string; reason: string; due_at: string; done_at: string | null; a_created_at: string | null; a_callback_hours: number | null }>(
      `SELECT t.id, t.reason, t.due_at, t.done_at, a.created_at AS a_created_at, a.callback_hours AS a_callback_hours FROM callback_tasks t
       LEFT JOIN attributions a ON a.qualification_id = t.qualification_id
       WHERE t.network_id = ? AND t.person_id IN (${placeholders(ids.length)})`,
      [viewer.networkId, ...ids],
    );
    // La limite se lit par le service de rappel, comme la réattribution, même pour une tâche rangée avant [R682].
    const tasks = rawTasks
      .map((t) => ({ id: t.id, reason: t.reason, done_at: t.done_at, due_at: callbackTaskDue(t.due_at, { created_at: t.a_created_at, callback_hours: t.a_callback_hours }) }))
      .sort((x, y) => (x.done_at === null ? 0 : 1) - (y.done_at === null ? 0 : 1) || x.due_at.localeCompare(y.due_at) || x.id.localeCompare(y.id));

    // Le dernier classement de la fiche, fiches réunies comprises ; l'origine reste telle quelle, à côté de sa correction [R17].
    const latest = await this.db.first<{ id: string; category: Category; route: Route | null; created_at: string }>(
      `SELECT id, category, route, created_at FROM qualifications WHERE network_id = ? AND person_id IN (${placeholders(ids.length)})
       ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      [viewer.networkId, ...ids],
    );
    const correction = latest
      ? await this.db.first<{ category: Category; route: Route | null; created_at: string }>(
          'SELECT category, route, created_at FROM qualification_corrections WHERE network_id = ? AND qualification_id = ? ORDER BY rowid DESC LIMIT 1',
          [viewer.networkId, latest.id],
        )
      : null;

    const messages = [...fiche.messages]
      .sort((a, b) => b.occurred_at.localeCompare(a.occurred_at) || b.id.localeCompare(a.id))
      .slice(0, AGENT_FICHE_MESSAGES)
      .map((m) => ({
        channel: m.channel,
        direction: m.direction,
        author: m.author_kind,
        body: m.body.length > EXCERPT ? `${m.body.slice(0, EXCERPT)}…` : m.body,
        occurredAt: m.occurred_at,
      }));

    return {
      ok: true,
      value: {
        personId: fiche.person.id,
        // La fiche réunie : le nom d'une fiche d'origine compte, tant que la fiche survivante n'en a pas.
        firstName: fiche.person.first_name ?? fiche.members.find((m) => m.first_name)?.first_name ?? null,
        lastName: fiche.person.last_name ?? fiche.members.find((m) => m.last_name)?.last_name ?? null,
        ...(viewer.role === 'direction' ? { nameCorrectable: true as const } : {}),
        contact: { allowed, reasons },
        call,
        callRefusal,
        callClosesAt,
        callReopensAt,
        projects: fiche.projects.map((p) => ({ id: p.id, kind: p.kind, stage: p.stage, deadline: p.deadline, budgetMinEur: p.budget_min_eur, budgetMaxEur: p.budget_max_eur })),
        sources: [...fiche.sources].sort((a, b) => a.occurred_at.localeCompare(b.occurred_at)).map((s) => ({ channel: s.channel, detail: s.detail, occurredAt: s.occurred_at })),
        consents: fiche.consents.map((c) => ({ id: c.id, purpose: c.purpose, channel: c.channel, givenAt: c.given_at, withdrawnAt: c.withdrawn_at })),
        messages,
        callbacks: tasks.map((t) => ({ taskId: t.id, reason: t.reason, dueAt: t.due_at, doneAt: t.done_at })),
        qualification: latest
          ? {
              id: latest.id,
              category: latest.category,
              route: latest.route,
              classifiedAt: latest.created_at,
              correction: correction ? { category: correction.category, route: correction.route, correctedAt: correction.created_at } : null,
            }
          : null,
      },
    };
  }
}
