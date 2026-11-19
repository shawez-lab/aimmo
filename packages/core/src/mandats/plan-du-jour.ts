/**
 * Le plan du jour de l'agent (M20, G01) : ses meilleures occasions de rentrer un mandat, par des moyens autorisés.
 *
 * Trois raisons de figurer au plan : un propriétaire a demandé à être rappelé (tâche « rappeler » ouverte, Q04), un
 * avis de valeur envoyé reste sans suite (E06), un projet de vente ou d'estimation n'a pas encore de rendez-vous.
 * L'ordre suit des règles écrites ici, les mêmes pour tous, chaque ligne avec sa raison ; aucune IA, aucune note sur
 * les personnes [R35]. Le plan ne porte que les clients de l'agent [R16], et seulement des personnes qui ont une base
 * légale, une demande récente ou un accord en cours ; jamais une personne exclue ou qui a demandé l'arrêt [R36].
 * Les personnes écartées sont comptées, sans donnée personnelle. Rien n'est envoyé ici.
 *
 * M20 complet (G12) y ajoute deux raisons, chacune sous sa propre base légale : une recommandation à rappeler (G08),
 * seulement avec l'accord « recommandation » en cours de la personne, sur le canal qu'elle a accepté [R142, R03] ; une
 * relance d'ancien contact préparée par le passage du mois et encore à valider (G09), seulement avec l'accord de
 * relance en cours et sans opposition aux relances après la vente [R143, R65]. Et, à part des lignes de personnes,
 * les lettres de quartier encore à déposer (G06), qui ne portent aucun nom [R140].
 */
import type { Acces } from '../acces/acces.ts';
import type { RefusalCode, Viewer } from '../acces/droits.ts';
import type { SqlDatabase } from '../db/sql.ts';
import type { FicheUnique } from '../fiche/fusion.ts';
import { DEADLINES, type Deadline } from '../qualification/regles.ts';
import { INBOUND_CHANNELS } from '../reception/entrant.ts';
import { SqlJournalStore } from '../journal/sql-store.ts';
import { AnciensContacts } from './gagner/anciens-contacts.ts';

/** Finalité de l'accord d'une personne recommandée (M11, F01 ; G08), écrite ici pour ne pas lier le socle à M11. */
export const PLAN_REFERRAL_PURPOSE = 'recommandation';
/** Finalité de l'accord de relance d'un ancien contact (G09), la même que `OLD_CONTACT_PURPOSE`. */
export const PLAN_OLD_CONTACT_PURPOSE = 'relance_ancien_contact';

export interface PlanSettings {
  /** Jours pendant lesquels une demande de la personne vaut base légale. Réglage de départ : 13 mois. */
  requestDays: number;
  /** Jours sans échange après l'envoi d'un avis de valeur avant de le relancer au plan. Réglage de départ : 30 jours. */
  valuationFollowUpDays: number;
}

export const DEFAULT_PLAN_SETTINGS: PlanSettings = Object.freeze({ requestDays: 395, valuationFollowUpDays: 30 });

/** Finalités d'accord qui permettent à l'agent de recontacter un propriétaire. */
export const PLAN_CONSENT_PURPOSES: readonly string[] = Object.freeze(['valuation_follow_up', 'value_tracking', 'prospecting']);

/** Étapes d'un projet avant tout mandat, où un rendez-vous reste à proposer. */
/**
 * Sources qui sont une demande de la personne : elle a écrit ou rempli un formulaire. Une reprise d'outil
 * (GoHighLevel, ManyChat) ou une saisie de l'agent n'en est pas une [R36].
 */
export const REQUEST_SOURCE_CHANNELS: readonly string[] = Object.freeze([...INBOUND_CHANNELS]);

export const OPEN_STAGES: readonly string[] = Object.freeze(['new', 'recue', 'appele']);

export type PlanItemKind = 'callback' | 'recommendation' | 'appointment' | 'valuation' | 'old_contact';

/** La base légale d'une ligne : une demande de la personne, ou un accord en cours. */
export interface LegalBasis {
  kind: 'request' | 'consent';
  /** Date de la demande la plus récente, ou de l'accord. */
  since: string;
  /** Finalité de l'accord, pour une base `consent`. */
  purpose: string | null;
}

export interface PlanItem {
  rank: number;
  personId: string;
  firstName: string | null;
  kind: PlanItemKind;
  /** La raison de la ligne, en une ligne, sans IA. */
  reason: string;
  /** Pourquoi cette place : les règles écrites appliquées, dans l'ordre. */
  order: string;
  /** Ce qui fait la place de la ligne, en mots de l'agent, et le jour de la demande (AU116) : ce que l'écran montre. */
  priority?: string;
  basis: LegalBasis;
  projectId: string | null;
  taskId: string | null;
  reportId: string | null;
  /** Une ligne « recommandation » : la recommandation (de client ou de partenaire) et le seul canal accepté. */
  recommendation?: { origin: 'client' | 'partner'; id: string; channel: string };
  /** Une ligne « ancien contact » : la relance préparée, à valider. */
  followupId?: string;
}

/** Une campagne de lettres de quartier de l'agent, avec des lettres encore à déposer : aucun nom, aucune adresse. */
export interface PlanLetters {
  campaignId: string;
  recipient: 'au_proprietaire' | 'aux_habitants';
  toDeposit: number;
  total: number;
  /** Jour de la campagne, `AAAA-MM-JJ`. */
  since: string;
}

export interface DailyPlan {
  agentId: string;
  /** Jour du plan, `AAAA-MM-JJ`, heure de Paris. */
  day: string;
  computedAt: string;
  items: PlanItem[];
  /** Personnes qui avaient une raison d'y être mais n'y sont pas, comptées sans donnée personnelle [R36]. */
  removed: { excluded: number; withdrawn: number; noBasis: number };
  /** Les lettres de quartier à déposer, à part des lignes de personnes, dans l'ordre des campagnes [R35, R140]. */
  letters?: PlanLetters[];
  /** Les étapes du jour des séquences de prospection (HX20), chacune revérifiée à la lecture [R301, R302]. */
  sequenceSteps?: PlanSequenceStep[];
}

/** Une étape du jour d'une séquence de prospection (HX20), telle que le module des séquences la rend. */
export interface PlanSequenceStep {
  sequenceId: string;
  stepId: string;
  position: number;
  channel: string;
  personId: string;
  firstName: string | null;
  action: string;
  proposed: boolean;
  reason: string | null;
  call: string | null;
  callClosesAt: string | null;
}

/** La source des étapes du jour (HX20) : branchée par le Worker, absente des plans qui n'en ont pas. */
export interface PlanSequenceSource {
  today(viewer: Viewer): Promise<{ ok: true; value: { steps: PlanSequenceStep[] } } | { ok: false }>;
}

/** Ce qu'une ligne dit d'elle-même pour que sa base légale soit relue : sa raison et ce qu'elle désigne. */
export type PlanBasisTarget = Pick<PlanItem, 'kind'> & Partial<Pick<PlanItem, 'recommendation' | 'followupId'>>;

export type PlanResult = { ok: true; value: DailyPlan } | { ok: false; rule: 'R16'; code: RefusalCode | 'not_agent' };

export interface PlanOptions {
  now?: () => Date;
  settings?: PlanSettings;
  timeZone?: string;
  /** Les séquences de prospection de l'agent (HX20). */
  sequences?: PlanSequenceSource;
}

const DAY = 86_400_000;
const placeholders = (n: number): string => Array.from({ length: n }, () => '?').join(', ');

/** Le délai annoncé, en jours à partir de la qualification ; « plus tard » vient après tous les délais chiffrés. */
const DEADLINE_DAYS: Readonly<Record<Deadline, number>> = Object.freeze({
  now: 0,
  within_3_months: 90,
  within_6_months: 180,
  within_1_year: 365,
  later: 730,
});
const DEADLINE_LABEL: Readonly<Record<Deadline, string>> = Object.freeze({
  now: 'tout de suite',
  within_3_months: 'sous 3 mois',
  within_6_months: 'sous 6 mois',
  within_1_year: 'sous un an',
  later: 'plus tard',
});
const KIND_STRENGTH: Readonly<Record<PlanItemKind, number>> = Object.freeze({ callback: 0, recommendation: 1, appointment: 2, valuation: 3, old_contact: 4 });
/** Une demande d'être appelé : rappel demandé, ou recommandation que la personne a acceptée [R35]. */
const asksCall = (kind: PlanItemKind): boolean => kind === 'callback' || kind === 'recommendation';

const day = (iso: string): string => iso.slice(0, 10);
const CHANNEL_LABEL: Readonly<Record<string, string>> = Object.freeze({ phone: 'téléphone', email: 'mail', sms: 'SMS', whatsapp: 'WhatsApp' });
const OLD_CONTACT_LABEL: Readonly<Record<string, string>> = Object.freeze({ fin_de_bail: 'Fin de bail prochaine', estimation_ancienne: 'Avis de valeur de plus d’un an' });

interface Candidate {
  personId: string;
  firstName: string | null;
  kind: PlanItemKind;
  reason: string;
  basis: LegalBasis;
  projectId: string | null;
  taskId: string | null;
  reportId: string | null;
  recommendation?: { origin: 'client' | 'partner'; id: string; channel: string };
  followupId?: string;
  /** Échéance annoncée par le propriétaire, ISO ; null si inconnue. */
  horizon: string | null;
  horizonLabel: string | null;
  /** Envoi de l'avis de valeur le plus ancien encore sans suite. */
  valuationSentAt: string | null;
  /** Demande la plus ancienne qui justifie la ligne. */
  requestedAt: string;
  /** A répondu au suivi de valeur qu'il pense à vendre (G04). */
  sellingIntent: boolean;
}

/**
 * L'ordre écrit du plan [R35] : 1. demande de rappel, ou recommandation à rappeler, d'abord ; 2. puis le propriétaire qui a répondu au suivi de valeur
 * qu'il pense à vendre ; 3. délai annoncé par le propriétaire le plus proche ; 4. avis de valeur le plus ancien ;
 * 5. demande la plus ancienne ; enfin l'identifiant de la fiche, pour que le même jeu de données donne toujours le
 * même plan.
 */
function comparePlanCandidates(a: Candidate, b: Candidate): number {
  const callback = Number(asksCall(b.kind)) - Number(asksCall(a.kind));
  if (callback !== 0) return callback;
  const selling = Number(b.sellingIntent) - Number(a.sellingIntent);
  if (selling !== 0) return selling;
  const byDate = (x: string | null, y: string | null): number => (x === y ? 0 : x === null ? 1 : y === null ? -1 : x < y ? -1 : 1);
  return (
    byDate(a.horizon, b.horizon) ||
    byDate(a.valuationSentAt, b.valuationSentAt) ||
    byDate(a.requestedAt, b.requestedAt) ||
    (a.personId < b.personId ? -1 : a.personId > b.personId ? 1 : 0)
  );
}

/** La priorité de la ligne, en mots de l'agent, et le jour de la demande, au format français (AU116). */
function priorityOf(c: Candidate): string {
  const head =
    c.kind === 'callback'
      ? 'Rappel demandé'
      : c.kind === 'recommendation'
        ? 'Recommandation à rappeler'
        : c.sellingIntent
          ? 'Pense à vendre'
          : c.horizonLabel
            ? `Projet annoncé : ${c.horizonLabel}`
            : c.valuationSentAt
              ? `Avis de valeur envoyé le ${frDay(c.valuationSentAt)}`
              : 'À relancer';
  return `${head} · demande du ${frDay(c.requestedAt)}`;
}
const frDay = (iso: string): string => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;

function explain(c: Candidate): string {
  const parts = [c.kind === 'callback' ? '1. rappel demandé' : c.kind === 'recommendation' ? '1. recommandation à rappeler' : '1. pas de rappel demandé'];
  parts.push(c.sellingIntent ? '2. pense à vendre, réponse au suivi de valeur' : '2. pas de réponse « pense à vendre »');
  parts.push(c.horizonLabel ? `3. délai annoncé : ${c.horizonLabel}` : '3. délai non annoncé');
  parts.push(c.valuationSentAt ? `4. avis de valeur envoyé le ${day(c.valuationSentAt)}` : '4. pas d’avis de valeur envoyé');
  parts.push(`5. demande du ${day(c.requestedAt)}`);
  return parts.join(' ; ');
}

export class PlanDuJour {
  private readonly now: () => Date;
  private readonly settings: PlanSettings;
  private readonly timeZone: string;
  private readonly sequences: PlanSequenceSource | null;

  constructor(
    private readonly db: SqlDatabase,
    private readonly fiche: FicheUnique,
    options: PlanOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.settings = options.settings ?? DEFAULT_PLAN_SETTINGS;
    this.timeZone = options.timeZone ?? 'Europe/Paris';
    this.sequences = options.sequences ?? null;
  }

  /** Le plan du jour d'un agent, calculé maintenant, sur ses seuls clients [R16]. */
  async compute(acces: Acces, viewer: Viewer, via?: string): Promise<PlanResult> {
    if (viewer.role !== 'agent') return { ok: false, rule: 'R16', code: 'not_agent' };
    const visible = await acces.listPersons(viewer, via);
    if (!visible.ok) return visible;
    const at = this.now();
    const stamp = at.toISOString();
    const removed = { excluded: 0, withdrawn: 0, noBasis: 0 };
    const items: Candidate[] = [];
    const seen = new Set<string>();
    for (const listed of visible.value) {
      const view = await this.fiche.view(listed.id);
      const root = view.person.id;
      if (seen.has(root)) continue;
      seen.add(root);
      const ids = view.members.map((m) => m.id);
      const candidates = await this.candidatesOf(root, ids, at, viewer);
      if (candidates.length === 0) continue;
      const gate = await this.gate(ids, at);
      if (gate !== null) {
        removed[gate] += 1;
        continue;
      }
      // Chaque raison sous sa propre base légale : sans elle, la raison tombe [R36, R142, R143].
      const based: Candidate[] = [];
      for (const c of candidates) {
        const basis = await this.basisFor(ids, at, c);
        if (basis !== null) based.push({ ...c, basis });
      }
      if (based.length === 0) {
        removed.noBasis += 1;
        continue;
      }
      // Une ligne par personne, sous sa raison la plus forte.
      based.sort((a, b) => KIND_STRENGTH[a.kind] - KIND_STRENGTH[b.kind] || comparePlanCandidates(a, b));
      const best = based[0] as Candidate;
      const firstName = view.members.map((m) => m.first_name).find((n) => n) ?? null;
      items.push({ ...best, firstName });
    }
    items.sort(comparePlanCandidates);
    const sequenceRead = this.sequences ? await this.sequences.today(viewer) : null;
    return {
      ok: true,
      value: {
        agentId: viewer.userId,
        day: localDay(at, this.timeZone),
        computedAt: stamp,
        removed,
        letters: await this.lettersOf(viewer),
        ...(sequenceRead?.ok ? { sequenceSteps: sequenceRead.value.steps } : {}),
        items: items.map((c, i) => ({
          rank: i + 1,
          personId: c.personId,
          firstName: c.firstName,
          kind: c.kind,
          reason: c.reason,
          order: explain(c),
          priority: priorityOf(c),
          basis: c.basis,
          projectId: c.projectId,
          taskId: c.taskId,
          reportId: c.reportId,
          ...(c.recommendation ? { recommendation: c.recommendation } : {}),
          ...(c.followupId ? { followupId: c.followupId } : {}),
        })),
      },
    };
  }

  /**
   * Peut-elle figurer au plan maintenant ? Une personne exclue ou qui a demandé l'arrêt, sur n'importe quel canal,
   * jamais [R36] ; un accord de recontact retiré l'emporte sur toute demande, la personne a dit non [R03, R36] ;
   * sinon il faut une base légale. Sert au calcul et à chaque lecture d'un plan figé.
   */
  async eligibility(
    ids: readonly string[],
    at: Date,
    item?: PlanBasisTarget,
    options: { asOfPlan?: boolean } = {},
  ): Promise<{ ok: true; basis: LegalBasis } | { ok: false; reason: 'excluded' | 'withdrawn' | 'noBasis' }> {
    const gate = await this.gate(ids, at);
    if (gate !== null) return { ok: false, reason: gate };
    const basis = await this.basisFor(ids, at, item ?? { kind: 'appointment' }, options.asOfPlan !== true);
    return basis === null ? { ok: false, reason: 'noBasis' } : { ok: true, basis };
  }

  /** Exclue, ou accord de recontact retiré : jamais au plan, quelle que soit la raison [R36]. */
  private async gate(ids: readonly string[], at: Date): Promise<'excluded' | 'withdrawn' | null> {
    const stamp = at.toISOString();
    if (await this.excluded(ids, stamp)) return 'excluded';
    if (await this.withdrawn(ids, stamp)) return 'withdrawn';
    return null;
  }

  /**
   * La base légale d'une raison [R36] : une recommandation, l'accord « recommandation » en cours sur son canal, jamais
   * retiré, et la recommandation pas encore rappelée [R142, R03] ; une relance d'ancien contact, l'accord de relance en
   * cours, aucune opposition aux relances après la vente, et la relance encore à valider [R143, R65] ; les autres
   * raisons, la base commune du plan. Sert au calcul, à la lecture d'un plan figé et au contrôle (G05) ; le contrôle,
   * qui relit la base à l'heure du plan (`live` faux), ne demande pas que la recommandation ou la relance soit encore
   * ouverte aujourd'hui : l'avoir faite depuis n'est pas un écart.
   */
  private async basisFor(ids: readonly string[], at: Date, item: PlanBasisTarget, live = true): Promise<LegalBasis | null> {
    const inIds = placeholders(ids.length);
    const stamp = at.toISOString();
    if (item.kind === 'recommendation') {
      const r = item.recommendation;
      if (!r) return null;
      const open =
        r.origin === 'client'
          ? await this.db.first(`SELECT 1 FROM referrals WHERE id = ? AND referred_id IN (${inIds}) AND call_due_at IS NOT NULL AND call_done_at IS NULL`, [r.id, ...ids])
          : await this.db.first(`SELECT 1 FROM partner_recommendations WHERE id = ? AND referred_id IN (${inIds}) AND call_due_at IS NOT NULL AND call_done_at IS NULL`, [r.id, ...ids]);
      if (live && !open) return null;
      const refused = await this.db.first(`SELECT 1 FROM consents WHERE person_id IN (${inIds}) AND purpose = ? AND withdrawn_at IS NOT NULL AND withdrawn_at <= ? LIMIT 1`, [...ids, PLAN_REFERRAL_PURPOSE, stamp]);
      if (refused) return null;
      const consent = await this.db.first<{ given_at: string }>(
        `SELECT given_at FROM consents WHERE person_id IN (${inIds}) AND purpose = ? AND channel = ? AND given_at <= ? AND (withdrawn_at IS NULL OR withdrawn_at > ?) ORDER BY given_at DESC, id LIMIT 1`,
        [...ids, PLAN_REFERRAL_PURPOSE, r.channel, stamp, stamp],
      );
      return consent ? { kind: 'consent', since: consent.given_at, purpose: PLAN_REFERRAL_PURPOSE } : null;
    }
    if (item.kind === 'old_contact') {
      if (!item.followupId) return null;
      const open = await this.db.first(`SELECT 1 FROM old_contact_followups WHERE id = ? AND person_id IN (${inIds}) AND status = 'a_valider'`, [item.followupId, ...ids]);
      if (live && !open) return null;
      const opposed = await this.db.first(`SELECT 1 FROM after_sale_choices WHERE person_id IN (${inIds}) AND choice = 'non' AND recorded_at <= ? LIMIT 1`, [...ids, stamp]);
      if (opposed) return null;
      // La base entière de G09, relue maintenant : client d'une vente de l'agence, prospect au-delà de 3 ans, accord sur
      // un canal de relance [R143, R65, R97, R03]. Le contrôle à l'heure du plan s'en tient aux accords datés : une vente
      // signée depuis n'est pas un écart du plan d'alors.
      if (live) {
        const row = await this.db.first<{ network_id: string; person_id: string }>(`SELECT network_id, person_id FROM old_contact_followups WHERE id = ? AND person_id IN (${inIds})`, [item.followupId, ...ids]);
        if (!row || (await this.oldContactBasisLost(row.network_id, row.person_id, at)) !== null) return null;
      }
      const consent = await this.db.first<{ given_at: string }>(
        `SELECT given_at FROM consents WHERE person_id IN (${inIds}) AND purpose = ? AND given_at <= ? AND (withdrawn_at IS NULL OR withdrawn_at > ?) ORDER BY given_at DESC, id LIMIT 1`,
        [...ids, PLAN_OLD_CONTACT_PURPOSE, stamp, stamp],
      );
      return consent ? { kind: 'consent', since: consent.given_at, purpose: PLAN_OLD_CONTACT_PURPOSE } : null;
    }
    return this.basisOf(ids, at);
  }

  private oldContacts: { key: string; anciens: AnciensContacts; states: Promise<Map<string, { lastContactAt: string; client: boolean }>> } | null = null;

  /** La règle de G09 qui manque à la personne, les états de L08 lus une fois par réseau et par instant. */
  private async oldContactBasisLost(networkId: string, personId: string, at: Date): Promise<string | null> {
    const key = `${networkId}|${at.toISOString()}`;
    if (this.oldContacts?.key !== key) {
      const anciens = this.oldContacts?.anciens ?? new AnciensContacts(this.db, new SqlJournalStore(this.db), { now: this.now });
      this.oldContacts = { key, anciens, states: anciens.contactStates(networkId) };
    }
    return this.oldContacts.anciens.basisLost(networkId, personId, at, await this.oldContacts.states);
  }

  /** Les campagnes de lettres de l'agent qui ont encore des lettres à déposer, de la plus ancienne à la plus récente. */
  async lettersOf(viewer: Viewer): Promise<PlanLetters[]> {
    if (viewer.role !== 'agent') return [];
    const rows = await this.db.all<{ id: string; recipient: PlanLetters['recipient']; created_at: string; total: number; open: number }>(
      `SELECT c.id, c.recipient, c.created_at, count(l.id) AS total, sum(CASE WHEN l.deposited_at IS NULL THEN 1 ELSE 0 END) AS open
         FROM neighbourhood_campaigns c JOIN neighbourhood_letters l ON l.campaign_id = c.id
        WHERE c.network_id = ? AND c.agent_id = ? GROUP BY c.id, c.recipient, c.created_at ORDER BY c.created_at, c.id`,
      [viewer.networkId, viewer.userId],
    );
    return rows
      .filter((r) => Number(r.open) > 0)
      .map((r) => ({ campaignId: r.id, recipient: r.recipient, toDeposit: Number(r.open), total: Number(r.total), since: localDay(new Date(r.created_at), this.timeZone) }));
  }

  /** Les raisons d'une personne de figurer au plan, avant la base légale et les exclusions. */
  private async candidatesOf(root: string, ids: readonly string[], at: Date, viewer: Viewer): Promise<Candidate[]> {
    const inIds = placeholders(ids.length);
    const stamp = at.toISOString();
    const deadline = await this.deadlineOf(ids);
    const base = { personId: root, firstName: null, basis: { kind: 'request' as const, since: stamp, purpose: null }, sellingIntent: false, ...deadline };
    const out: Candidate[] = [];

    // 1. Rappel demandé : la tâche « rappeler » encore ouverte.
    const tasks = await this.db.all<{ id: string; project_id: string | null; reason: string; created_at: string }>(
      `SELECT id, project_id, reason, created_at FROM callback_tasks WHERE person_id IN (${inIds}) AND done_at IS NULL ORDER BY created_at, id`,
      [...ids],
    );
    for (const t of tasks) {
      out.push({ ...base, kind: 'callback', reason: `Rappel demandé. ${t.reason}`, projectId: t.project_id, taskId: t.id, reportId: null, valuationSentAt: null, requestedAt: t.created_at });
    }

    // 2. Avis de valeur envoyé, sans échange ni rendez-vous depuis le délai réglé.
    const cutoff = new Date(at.getTime() - this.settings.valuationFollowUpDays * DAY).toISOString();
    const deliveries = await this.db.all<{ report_id: string; sent_at: string }>(
      `SELECT report_id, sent_at FROM valuation_deliveries WHERE person_id IN (${inIds}) AND sent_at <= ? ORDER BY sent_at, report_id`,
      [...ids, cutoff],
    );
    for (const d of deliveries) {
      // Un échange dans le délai, ou un rendez-vous pris depuis l'avis : l'avis a eu sa suite.
      const touched = await this.db.first<{ n: number }>(
        `SELECT (SELECT count(*) FROM messages WHERE person_id IN (${inIds}) AND occurred_at > ? AND (direction = 'in' OR author_kind = 'agent'))
              + (SELECT count(*) FROM appointments WHERE person_id IN (${inIds}) AND (created_at > ? OR (status = 'booked' AND start_at >= ?))) AS n`,
        [...ids, cutoff, ...ids, d.sent_at, stamp],
      );
      if (Number(touched?.n ?? 0) > 0) continue;
      out.push({
        ...base,
        kind: 'valuation',
        reason: `Avis de valeur envoyé le ${day(d.sent_at)}, sans réponse depuis ${this.settings.valuationFollowUpDays} jours : à relancer.`,
        projectId: null,
        taskId: null,
        reportId: d.report_id,
        valuationSentAt: d.sent_at,
        requestedAt: d.sent_at,
      });
    }

    // 3. Projet de vente ou d'estimation avant mandat, sans rendez-vous à venir ni estimation déjà faite.
    const projects = await this.db.all<{ id: string; kind: string; created_at: string }>(
      `SELECT id, kind, created_at FROM projects WHERE person_id IN (${inIds}) AND kind IN ('sell', 'valuation')
       AND stage IN (${placeholders(OPEN_STAGES.length)}) ORDER BY created_at, id`,
      [...ids, ...OPEN_STAGES],
    );
    if (projects.length > 0) {
      const booked = await this.db.first<{ n: number }>(
        `SELECT count(*) AS n FROM appointments WHERE person_id IN (${inIds})
         AND ((status = 'booked' AND start_at >= ?) OR (kind = 'estimation' AND status = 'honored'))`,
        [...ids, stamp],
      );
      if (Number(booked?.n ?? 0) === 0) {
        const p = projects[0] as { id: string; kind: string; created_at: string };
        out.push({
          ...base,
          kind: 'appointment',
          reason: p.kind === 'sell' ? 'Projet de vente sans rendez-vous : rendez-vous à proposer.' : 'Demande d’estimation sans rendez-vous : rendez-vous à proposer.',
          projectId: p.id,
          taskId: null,
          reportId: null,
          valuationSentAt: null,
          requestedAt: p.created_at,
        });
      }
    }
    // 4. A répondu au suivi de valeur qu'il pense à vendre (G04) : rendez-vous à proposer, en tête des rendez-vous.
    const alerts = await this.db.all<{ id: string; created_at: string }>(
      `SELECT a.id, a.created_at FROM value_tracking_alerts a WHERE a.person_id IN (${inIds}) AND a.created_at >= ? AND a.created_at <= ?
       AND NOT EXISTS (SELECT 1 FROM appointments r WHERE r.person_id IN (${inIds}) AND (r.created_at > a.created_at OR (r.status = 'booked' AND r.start_at >= ?)))
       ORDER BY a.created_at, a.id`,
      [...ids, cutoff, stamp, ...ids, stamp],
    );
    const alert = alerts[0];
    if (alert) {
      out.push({
        ...base,
        kind: 'appointment',
        reason: 'A répondu au suivi de valeur qu’il pense à vendre : rendez-vous à proposer.',
        projectId: null,
        taskId: null,
        reportId: null,
        valuationSentAt: null,
        requestedAt: alert.created_at,
        sellingIntent: true,
      });
    }
    // 5. Recommandation à rappeler (G08) : d'un client de l'agent, ou d'un partenaire dont la tâche revient à l'agent
    // (la sienne, ou sans agent en activité, la personne étant la sienne) ; par le seul canal accepté.
    const referrals = await this.db.all<{ id: string; created_at: string }>(
      `SELECT id, created_at FROM referrals WHERE referred_id IN (${inIds}) AND network_id = ? AND agent_id = ? AND call_due_at IS NOT NULL AND call_done_at IS NULL ORDER BY created_at, id`,
      [...ids, viewer.networkId, viewer.userId],
    );
    for (const r of referrals) {
      out.push({ ...base, kind: 'recommendation', reason: 'Recommandé par un client, accord donné : à appeler.', projectId: null, taskId: null, reportId: null, valuationSentAt: null, requestedAt: r.created_at, recommendation: { origin: 'client', id: r.id, channel: 'phone' } });
    }
    const partners = await this.db.all<{ id: string; agent_id: string | null; consent_channel: string; created_at: string }>(
      `SELECT r.id, r.agent_id, r.consent_channel, r.created_at FROM partner_recommendations r WHERE r.referred_id IN (${inIds}) AND r.network_id = ? AND r.call_due_at IS NOT NULL AND r.call_done_at IS NULL
         AND (r.agent_id = ? OR r.agent_id IS NULL OR NOT EXISTS (SELECT 1 FROM agents a WHERE a.id = r.agent_id AND a.status = 'active')) ORDER BY r.created_at, r.id`,
      [...ids, viewer.networkId, viewer.userId],
    );
    for (const r of partners) {
      out.push({ ...base, kind: 'recommendation', reason: `Recommandé par un partenaire, accord donné : à contacter par ${CHANNEL_LABEL[r.consent_channel] ?? r.consent_channel}.`, projectId: null, taskId: null, reportId: null, valuationSentAt: null, requestedAt: r.created_at, recommendation: { origin: 'partner', id: r.id, channel: r.consent_channel } });
    }
    // 6. Relance d'ancien contact préparée par le passage du mois, encore à valider par l'agent (G09).
    const followups = await this.db.all<{ id: string; reason: string; created_at: string }>(
      `SELECT id, reason, created_at FROM old_contact_followups WHERE person_id IN (${inIds}) AND network_id = ? AND agent_id = ? AND status = 'a_valider' ORDER BY created_at, id`,
      [...ids, viewer.networkId, viewer.userId],
    );
    for (const f of followups) {
      out.push({ ...base, kind: 'old_contact', reason: `${OLD_CONTACT_LABEL[f.reason] ?? 'Ancien contact'} : relance préparée, à valider.`, projectId: null, taskId: null, reportId: null, valuationSentAt: null, requestedAt: f.created_at, followupId: f.id });
    }
    // L'avis le plus ancien et la réponse « pense à vendre » servent à l'ordre de toutes les lignes de la personne.
    const oldest = out.find((c) => c.kind === 'valuation')?.valuationSentAt ?? null;
    const selling = alert !== undefined;
    return out.map((c) => ({ ...c, valuationSentAt: c.valuationSentAt ?? oldest, sellingIntent: selling }));
  }

  /** Le délai annoncé le plus proche : échéance du projet, ou délai de la qualification compté depuis sa date. */
  private async deadlineOf(ids: readonly string[]): Promise<{ horizon: string | null; horizonLabel: string | null }> {
    const inIds = placeholders(ids.length);
    let horizon: string | null = null;
    let horizonLabel: string | null = null;
    const consider = (iso: string, label: string): void => {
      if (horizon === null || iso < horizon) {
        horizon = iso;
        horizonLabel = label;
      }
    };
    const projects = await this.db.all<{ deadline: string }>(
      `SELECT deadline FROM projects WHERE person_id IN (${inIds}) AND deadline IS NOT NULL AND kind IN ('sell', 'valuation')`,
      [...ids],
    );
    for (const p of projects) {
      const t = Date.parse(p.deadline);
      if (Number.isFinite(t)) consider(new Date(t).toISOString(), `échéance le ${day(new Date(t).toISOString())}`);
    }
    const quals = await this.db.all<{ deadline: string; created_at: string }>(
      `SELECT deadline, created_at FROM qualifications WHERE person_id IN (${inIds}) AND deadline IS NOT NULL`,
      [...ids],
    );
    for (const q of quals) {
      if (!(DEADLINES as readonly string[]).includes(q.deadline)) continue;
      const d = q.deadline as Deadline;
      consider(new Date(Date.parse(q.created_at) + DEADLINE_DAYS[d] * DAY).toISOString(), DEADLINE_LABEL[d]);
    }
    return { horizon, horizonLabel };
  }

  /**
   * La base légale [R36] : un accord en cours pour recontacter le propriétaire, sinon une demande de la personne
   * (message reçu, source, tâche de rappel) dans le délai réglé. Sans l'une ni l'autre : pas de plan.
   */
  private async basisOf(ids: readonly string[], at: Date): Promise<LegalBasis | null> {
    const inIds = placeholders(ids.length);
    const stamp = at.toISOString();
    const consent = await this.db.first<{ purpose: string; given_at: string }>(
      `SELECT purpose, given_at FROM consents WHERE person_id IN (${inIds}) AND purpose IN (${placeholders(PLAN_CONSENT_PURPOSES.length)})
       AND given_at <= ? AND (withdrawn_at IS NULL OR withdrawn_at > ?) ORDER BY given_at DESC, id LIMIT 1`,
      [...ids, ...PLAN_CONSENT_PURPOSES, stamp, stamp],
    );
    if (consent) return { kind: 'consent', since: consent.given_at, purpose: consent.purpose };
    const from = new Date(at.getTime() - this.settings.requestDays * DAY).toISOString();
    const request = await this.db.first<{ at: string | null }>(
      `SELECT max(at) AS at FROM (
         SELECT occurred_at AS at FROM messages WHERE person_id IN (${inIds}) AND direction = 'in'
         UNION ALL SELECT occurred_at AS at FROM sources WHERE person_id IN (${inIds}) AND channel IN (${placeholders(REQUEST_SOURCE_CHANNELS.length)})
         UNION ALL SELECT created_at AS at FROM callback_tasks WHERE person_id IN (${inIds})
       ) WHERE at <= ?`,
      [...ids, ...ids, ...REQUEST_SOURCE_CHANNELS, ...ids, stamp],
    );
    if (request?.at && request.at >= from) return { kind: 'request', since: request.at, purpose: null };
    return null;
  }

  /** Un accord pour une finalité du plan, retiré, sans nouvel accord donné depuis pour la même finalité. */
  private async withdrawn(ids: readonly string[], at: string): Promise<boolean> {
    const inIds = placeholders(ids.length);
    const row = await this.db.first<{ n: number }>(
      `SELECT count(*) AS n FROM consents w WHERE w.person_id IN (${inIds}) AND w.purpose IN (${placeholders(PLAN_CONSENT_PURPOSES.length)})
       AND w.withdrawn_at IS NOT NULL AND w.withdrawn_at <= ?
       AND NOT EXISTS (SELECT 1 FROM consents c WHERE c.person_id IN (${inIds}) AND c.purpose = w.purpose
         AND c.given_at >= w.withdrawn_at AND c.given_at <= ? AND (c.withdrawn_at IS NULL OR c.withdrawn_at > ?))`,
      [...ids, ...PLAN_CONSENT_PURPOSES, at, ...ids, at, at],
    );
    return Number(row?.n ?? 0) > 0;
  }

  private async excluded(ids: readonly string[], at: string): Promise<boolean> {
    const row = await this.db.first<{ n: number }>(
      `SELECT count(*) AS n FROM exclusions WHERE person_id IN (${placeholders(ids.length)}) AND noted_at <= ? AND (lifted_at IS NULL OR lifted_at > ?)`,
      [...ids, at, at],
    );
    return Number(row?.n ?? 0) > 0;
  }
}

/** Le jour `AAAA-MM-JJ` d'un instant, dans le fuseau donné. */
export function localDay(at: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(at);
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}
