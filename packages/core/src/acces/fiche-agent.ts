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
 */
import type { SqlDatabase } from '../db/sql.ts';
import { isWorkingDay, localTime } from '../envoi/horaires.ts';
import type { Consent, ExclusionReason } from '../db/types.ts';
import type { FicheComplete } from '../fiche/fusion.ts';
import type { Acces } from './acces.ts';
import type { Viewer } from './droits.ts';

export interface AgentFiche {
  personId: string;
  firstName: string | null;
  lastName: string | null;
  /** Exclusions actives : la personne ne doit plus être contactée [R02, R04]. */
  contact: { allowed: boolean; reasons: ExclusionReason[] };
  /** Numéro à appeler, en `tel:` ; null si la personne est exclue, a demandé l'arrêt, n'a pas d'accord ou pas de numéro. */
  call: string | null;
  /** Fin du créneau d'appel, quand l'appel ne repose que sur la prospection acceptée [R203] ; sinon null. */
  callClosesAt: string | null;
  /** Pourquoi il n'y a pas de numéro à appeler, pour que l'écran le dise ; null si l'appel est ouvert. */
  callRefusal: 'excluded' | 'no_phone' | 'no_consent' | 'outside_hours' | null;
  projects: { kind: string; stage: string; deadline: string | null; budgetMinEur: number | null; budgetMaxEur: number | null }[];
  sources: { channel: string; detail: string | null; occurredAt: string }[];
  consents: { id: string; purpose: string; channel: string; givenAt: string; withdrawnAt: string | null }[];
  /** Les derniers messages, du plus récent au plus ancien. */
  messages: { channel: string; direction: string; author: string; body: string; occurredAt: string }[];
  /** Les rappels de la fiche, ouverts d'abord ; un rappel fait garde sa ligne [R17]. */
  callbacks: { taskId: string; reason: string; dueAt: string; doneAt: string | null }[];
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
    const usable = fiche.consents.filter((c) => consentOpensCall(c, fiche, at));
    const asked = usable.some((c) => CALL_REQUEST_PURPOSES.includes(c.purpose));
    const callRefusal = !allowed
      ? 'excluded'
      : !hasPhone
        ? 'no_phone'
        : usable.length === 0
          ? 'no_consent'
          : !asked && !inProspectingHours(new Date(at))
            ? 'outside_hours'
            : null;
    const call = callRefusal === null ? `tel:${digits}` : null;
    const callClosesAt = callRefusal === null && !asked ? prospectingSlotEnd(new Date(at)).toISOString() : null;

    const ids = fiche.members.map((m) => m.id);
    const tasks = await this.db.all<{ id: string; reason: string; due_at: string; done_at: string | null }>(
      `SELECT id, reason, due_at, done_at FROM callback_tasks WHERE network_id = ? AND person_id IN (${placeholders(ids.length)})
       ORDER BY CASE WHEN done_at IS NULL THEN 0 ELSE 1 END, due_at, id`,
      [viewer.networkId, ...ids],
    );

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
        firstName: fiche.person.first_name,
        lastName: fiche.person.last_name,
        contact: { allowed, reasons },
        call,
        callRefusal,
        callClosesAt,
        projects: fiche.projects.map((p) => ({ kind: p.kind, stage: p.stage, deadline: p.deadline, budgetMinEur: p.budget_min_eur, budgetMaxEur: p.budget_max_eur })),
        sources: [...fiche.sources].sort((a, b) => a.occurred_at.localeCompare(b.occurred_at)).map((s) => ({ channel: s.channel, detail: s.detail, occurredAt: s.occurred_at })),
        consents: fiche.consents.map((c) => ({ id: c.id, purpose: c.purpose, channel: c.channel, givenAt: c.given_at, withdrawnAt: c.withdrawn_at })),
        messages,
        callbacks: tasks.map((t) => ({ taskId: t.id, reason: t.reason, dueAt: t.due_at, doneAt: t.done_at })),
      },
    };
  }
}
