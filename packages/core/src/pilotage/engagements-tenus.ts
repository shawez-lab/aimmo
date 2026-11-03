/**
 * Les engagements de service tenus dans un mois fini (IN07) [R216, R14, R16, R17].
 *
 * Pour la direction seule, à l'échelle du réseau : la liste des engagements du cahier, onglet « Besoins et solutions »,
 * chacun recalculé depuis sa table, jamais déclaré. Aucun agent, aucun rang [R14] : les lignes rendues ne portent que des
 * comptes et les jours des cas manqués, ni identifiant ni nom [R13].
 *
 * Décidé, lecture prudente (relecture forte de IN07) :
 * - un cas appartient au mois de ce qui le déclenche ; il ne compte qu'une fois tenu ou son délai écoulé : avant, il est
 *   « en attente », ni tenu ni manqué ;
 * - tenu veut dire reçu : un message resté en boîte d'essai ou en panne ne vaut pas. Parti à temps en essai, le cas n'est
 *   ni tenu ni manqué, il se compte à part (`inTrial`) : en mode essai, la ligne ne dit jamais 100 % ;
 * - « tout contact » : le premier message lisible d'une conversation. Écartés et visibles (`setAside`) : une personne
 *   exclue ou en arrêt, où se taire est la loi [R02, R04], et un contact à qui l'agent avait déjà écrit, où l'assistant se
 *   tait [R21]. Tout autre refus, ou un formulaire sans moyen de répondre, reste manqué : le contact n'a rien reçu ;
 * - « le jour même » : le jour de Paris, sans excuse pour le soir ; un chiffre sévère ne ment jamais au client. Deux tâches
 *   de rappel de fiches réunies, du même jour et du même projet, sont un seul cas ; une personne exclue ce jour-là est à
 *   part ;
 * - « client transmis tout de suite » : attribué à un agent dans la minute du message reçu, comme le critère de M03 ; un
 *   client que l'agent suivait déjà ou sans agent dans sa zone n'a pas été transmis et se voit à part ; la fiche complète
 *   passe dans la même écriture que l'attribution (Q03) ;
 * - compte rendu : envoyé au vendeur sous 24 h. Point : envoyé le lundi qui suit sa semaine, et ce lundi fait le mois ; un
 *   point préparé pour un mandat signé après ce lundi est à part. Un point jamais préparé ne se voit pas : la ligne le dit ;
 * - une commission d'une vente annulée, jamais versée, est à part : le versement est refusé [R71] ;
 * - alerte aux acquéreurs (IN11) : chaque alerte d'un bien appartient au mois de sa mise en vente datée [R222], et a une
 *   heure de temps d'envoi [R01] : une nuit ou un dimanche ne comptent pas. Écartés : un refus de la loi ou de l'accord
 *   [R02, R03, R04], un bien déjà envoyé [R05] ou qui n'est plus diffusable [R42], et, si l'alerte n'est pas partie à temps,
 *   une personne qui n'a demandé ces alertes ou changé sa recherche qu'après la mise en vente. Un bien sans date reste non
 *   mesuré : seul, il rend la ligne non mesurable, jamais un zéro. Une baisse de prix reste jugée depuis la première mise
 *   en vente : le chiffre est sévère plutôt que flatteur.
 */
import type { Viewer } from '../acces/droits.ts';
import { ALERT_CHANNELS, ALERT_PURPOSE } from '../acquereurs/alertes.ts';
import type { OutboundChannelName } from '../db/types.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { DEFAULT_SEND_SETTINGS, consentInForce } from '../envoi/decision.ts';
import { afterSendingTime, localTime } from '../envoi/horaires.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import { monthBounds } from './indicateurs-reseau.ts';
import { parisDayStart } from './tableau-agent.ts';
import { ratio, type Ratio } from './parcours.ts';
import { parisMonth } from './preuve.ts';

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

export const SERVICE_PROMISES = [
  { code: 'reponse_minute', forWhom: 'Tout contact', label: 'Une réponse en moins d’une minute, à toute heure', source: 'Journal des messages' },
  { code: 'rappel_chaud', forWhom: 'Contact chaud', label: 'Rappelé par l’agent le jour même', source: 'Tâches de rappel' },
  { code: 'avis_48h', forWhom: 'Vendeur', label: 'Avis de valeur remis sous 48 h après la visite', source: 'Rendez-vous et envois des avis' },
  { code: 'compte_rendu_24h', forWhom: 'Vendeur', label: 'Compte rendu de chaque visite sous 24 h', source: 'Comptes rendus de visite' },
  { code: 'point_lundi', forWhom: 'Vendeur', label: 'Point chaque lundi', source: 'Points de la semaine' },
  { code: 'offre_jour_meme', forWhom: 'Vendeur', label: 'Chaque offre transmise le jour même', source: 'Registre des offres' },
  { code: 'alerte_heure', forWhom: 'Acquéreur', label: 'Alerte dans l’heure qui suit la mise en vente d’un bien qui correspond, aux heures d’envoi', source: 'Alertes aux acquéreurs' },
  { code: 'client_transmis', forWhom: 'Agent', label: 'Client transmis tout de suite, avec sa fiche complète', source: 'Attributions' },
  { code: 'commission_24h', forWhom: 'Agent', label: 'Commission versée sous 24 h ouvrées après l’encaissement', source: 'Encaissements et reversements' },
] as const;
export type ServicePromiseCode = (typeof SERVICE_PROMISES)[number]['code'];

export interface ServicePromiseLine {
  code: ServicePromiseCode;
  forWhom: string;
  label: string;
  source: string;
  /** Faux : la base ne permet pas de juger cet engagement ; rien n'est compté, jamais un zéro. */
  measurable: boolean;
  /** `bp` nul sans aucun cas jugé. */
  kept: Ratio;
  /** Le délai court encore. */
  pending: number;
  /** Faits à temps, mais restés en boîte d'essai : rien n'est parti. */
  inTrial: number;
  /** Cas écartés du calcul, dits à part : voir la tête du fichier. */
  setAside: number;
  /** Ce que la ligne ne peut pas voir ; `null` sans réserve. */
  blindSpot: string | null;
  /** Les jours de Paris des cas manqués, sans identifiant. */
  missedDays: string[];
}

export interface ServicePromises {
  month: string;
  lines: ServicePromiseLine[];
  /** Tous les cas jugés, lignes mesurables seulement ; `bp` nul sans aucun cas. */
  overall: Ratio;
}

type Refusal = { ok: false; rule: 'R16'; code: string };
type Problem = { ok: false; rule: null; code: 'bad_month' } | { ok: false; rule: 'R216'; code: 'month_not_finished' };

/** Un cas : quand il naît, quand le geste a eu lieu, et sa date limite. */
interface Case {
  at: string;
  doneAt: string | null;
  deadline: number;
  /** Le geste est un message resté en boîte d'essai. */
  trial?: boolean;
  /** Ce qui désigne ce cas, stable d'un calcul à l'autre, et qui rappeler s'il est manqué (IN12) : jamais rendu par `ofMonth`. */
  key: string;
  personId?: string | null;
  agentId?: string | null;
}

/** Un cas manqué, pour la tâche de rappel du responsable (IN12). */
export interface MissedCase {
  code: ServicePromiseCode;
  key: string;
  day: string;
  personId: string | null;
  agentId: string | null;
}

const BLIND_SPOTS: Partial<Record<ServicePromiseCode, string>> = {
  point_lundi: 'Un point que le système n’a jamais préparé ne se voit pas ici.',
  alerte_heure: 'Un acquéreur pour qui aucune alerte n’a été préparée ne se voit pas ici.',
};
/** Les refus où se taire est la règle, et non un engagement manqué. */
const SILENCE_RULES: readonly (string | null)[] = ['R02', 'R03', 'R04', 'R05', 'R42'];

const parisDay = (iso: string): string => localTime(new Date(iso), 'Europe/Paris').date;
const isKeptInTime = (c: Case): boolean => c.doneAt !== null && Date.parse(c.doneAt) <= c.deadline;
const tally = (cases: readonly Case[], now: number) => {
  const missedDays: string[] = [];
  let kept = 0;
  let pending = 0;
  let inTrial = 0;
  for (const c of cases) {
    if (isKeptInTime(c)) {
      if (c.trial) inTrial += 1;
      else kept += 1;
    }
    else if (c.deadline > now) pending += 1;
    else missedDays.push(parisDay(c.at));
  }
  missedDays.sort();
  return { kept: ratio(kept, kept + missedDays.length), pending, inTrial, missedDays };
};
/** Tenu si le geste a lieu le même jour de Paris que le cas : le geste est rendu seulement dans ce cas. */
const sameDay = (at: string, doneAt: string | null, trial = false): Omit<Case, 'key'> => {
  const inDay = doneAt !== null && parisDay(doneAt) === parisDay(at);
  // Sans geste ce jour-là : manqué au minuit de Paris qui suit, pas avant. Dans un mois fini, ce minuit est toujours passé.
  const nextDay = new Date(Date.parse(`${parisDay(at)}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  return { at, doneAt: inDay ? doneAt : null, deadline: inDay ? Number.POSITIVE_INFINITY : parisDayStart(nextDay).getTime(), trial };
};
/** Un message a réellement quitté AIMMO : ni en panne, ni resté en boîte d'essai. Le paramètre : la colonne du message. */
const NOT_FAILED = (m: string) => `NOT EXISTS (SELECT 1 FROM send_log l WHERE l.message_id = ${m} AND l.outcome = 'failed')`;
const IN_TRIAL = (m: string) => `EXISTS (SELECT 1 FROM trial_outbox b WHERE b.message_id = ${m})`;
/** La vente de ce reversement est annulée, comme le refuse `Encaissements` [R71]. */
const CANCELLED_SALE = "EXISTS (SELECT 1 FROM invoices f WHERE f.file_id = r.file_id AND f.kind = 'avoir' AND json_extract(f.content, '$.reason') = 'vente_annulee')";
/** L'envoi d'un compte rendu ou d'un point : son message, s'il est parti. */
const delivered = (r: { status: string; delivery_status: string | null; sent_at: string | null }): string | null => (r.status === 'valide' && r.delivery_status === 'sent' ? r.sent_at : null);

export class EngagementsTenus {
  private readonly now: () => Date;

  constructor(
    private readonly db: SqlDatabase,
    private readonly journal: JournalStore,
    options: { now?: () => Date } = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  /** La direction seule [R16]. */
  async ofMonth(viewer: Viewer, month: unknown): Promise<{ ok: true; value: ServicePromises } | Refusal | Problem> {
    if (viewer.role !== 'direction') {
      await appendEvent(this.journal, { type: 'acces.refuse', actor: `${String(viewer.role)}:${viewer.userId}`, subject: `network:${viewer.networkId}`, data: { rule: 'R16', role: String(viewer.role), kind: 'service_promises', code: 'role' } }, this.now);
      return { ok: false, rule: 'R16', code: 'role' };
    }
    if (typeof month !== 'string' || !MONTH.test(month)) return { ok: false, rule: null, code: 'bad_month' };
    const at = this.now();
    if (month >= parisMonth(at)) return { ok: false, rule: 'R216', code: 'month_not_finished' };

    const net = viewer.networkId;
    const now = at.getTime();
    const judged = await this.judged(net, month);

    const lines: ServicePromiseLine[] = SERVICE_PROMISES.map((p) => {
      const one = judged[p.code];
      const blindSpot = BLIND_SPOTS[p.code] ?? null;
      if (!one || one.unmeasurable) return { ...p, measurable: false, kept: ratio(0, 0), pending: 0, inTrial: 0, setAside: one?.setAside ?? 0, blindSpot, missedDays: [] };
      return { ...p, measurable: true, ...tally(one.cases, now), setAside: one.setAside, blindSpot };
    });
    const numerator = lines.reduce((sum, l) => sum + l.kept.numerator, 0);
    const denominator = lines.reduce((sum, l) => sum + l.kept.denominator, 0);
    await appendEvent(this.journal, { type: 'pilotage.lecture', actor: `${String(viewer.role)}:${viewer.userId}`, subject: `network:${net}`, data: { kind: 'service_promises', month } }, this.now);
    return { ok: true, value: { month, lines, overall: ratio(numerator, denominator) } };
  }

  /**
   * Les cas manqués d'un mois, fini ou en cours, pour le passage de la machine (IN12) : les mêmes qu'à l'écran, ni un de
   * plus ni un de moins. La personne est la fiche gardée. Rien n'est écrit, aucun droit à vérifier : aucun lecteur ici.
   */
  async missedCases(net: string, month: string): Promise<MissedCase[]> {
    const judged = await this.judged(net, month);
    const now = this.now().getTime();
    const rootOf = await this.mergedRoots(net);
    const out: MissedCase[] = [];
    for (const p of SERVICE_PROMISES) {
      const one = judged[p.code];
      if (!one || one.unmeasurable) continue;
      for (const c of one.cases) {
        if (isKeptInTime(c) || c.deadline > now) continue;
        out.push({ code: p.code, key: c.key, day: parisDay(c.at), personId: c.personId ? rootOf(c.personId) : null, agentId: c.agentId ?? null });
      }
    }
    return out;
  }

  private async judged(net: string, month: string): Promise<Partial<Record<ServicePromiseCode, { cases: Case[]; setAside: number; unmeasurable?: boolean }>>> {
    const [start, end] = monthBounds(month);
    const inMonth = [net, start, end];
    const replies = await this.firstReplies(inMonth);
    const handovers = await this.handovers(inMonth);

    return {
      reponse_minute: replies,
      client_transmis: handovers,
      rappel_chaud: await this.callbacks(inMonth),
      avis_48h: await this.valuations(inMonth),
      compte_rendu_24h: {
        setAside: 0,
        // Toute visite terminée et non annulée, marquée tenue ou non, comme le dossier de présentation (G07).
        cases: (
          await this.db.all<{ id: string; person_id: string; end_at: string; status: string; delivery_status: string | null; sent_at: string | null; trial: number }>(
            `SELECT a.id, a.person_id, a.end_at, r.status, r.delivery_status, m.occurred_at AS sent_at, ${IN_TRIAL('r.message_id')} AS trial
               FROM appointments a LEFT JOIN visit_reports r ON r.appointment_id = a.id LEFT JOIN messages m ON m.id = r.message_id
              WHERE a.network_id = ? AND a.kind = 'visite' AND a.status IN ('booked', 'honored') AND a.end_at >= ? AND a.end_at < ?`,
            inMonth,
          )
        ).map((r) => ({ at: r.end_at, doneAt: delivered(r), deadline: Date.parse(r.end_at) + 24 * HOUR, trial: Number(r.trial) === 1, key: r.id, personId: r.person_id })),
      },
      point_lundi: await this.weeklyPoints(net, month),
      offre_jour_meme: {
        setAside: 0,
        cases: (
          await this.db.all<{ id: string; seller: string | null; received_at: string; at: string | null; trial: number }>(
            `SELECT o.id, (SELECT d.person_id FROM mandates d WHERE d.network_id = o.network_id AND d.property_id = o.property_id ORDER BY d.signed_at DESC LIMIT 1) AS seller, o.received_at, t.at, ${IN_TRIAL('t.message_id')} AS trial FROM offer_register o LEFT JOIN offer_transmissions t ON t.offer_id = o.id
              WHERE o.network_id = ? AND o.received_at >= ? AND o.received_at < ?`,
            inMonth,
          )
        ).map((r) => ({ ...sameDay(r.received_at, r.at, Number(r.trial) === 1), key: r.id, personId: r.seller })),
      },
      alerte_heure: await this.alerts(inMonth),
      commission_24h: await this.payouts(inMonth),
    };
  }

  /** Le premier message lisible de chaque conversation, et sa première réponse : la réponse automatique (C04) ou l'agent. */
  private async firstReplies(inMonth: string[]): Promise<{ cases: Case[]; setAside: number }> {
    // Un message de la machine ne vaut réponse que si ce message reçu a sa réponse partie : une alerte n'en est pas une.
    const replyOf = (trial: string) => `(SELECT MIN(m.occurred_at) FROM messages m WHERE m.network_id = i.network_id AND m.person_id = i.person_id AND m.direction = 'out' AND m.occurred_at >= i.received_at
                 AND ${NOT_FAILED('m.id')} AND ${trial}
                 AND (m.author_kind = 'agent' OR EXISTS (SELECT 1 FROM first_reply_claims c WHERE c.inbound_id = i.id AND c.outcome = 'sent')))`;
    const rows = await this.db.all<{ id: string; person_id: string | null; received_at: string; real_at: string | null; trial_at: string | null; silent: number }>(
      `SELECT i.id, i.person_id, i.received_at, ${replyOf(`NOT ${IN_TRIAL('m.id')}`)} AS real_at, ${replyOf(IN_TRIAL('m.id'))} AS trial_at,
              (EXISTS (SELECT 1 FROM attach_log g WHERE g.inbound_id = i.id AND g.silenced = 1)
               OR EXISTS (SELECT 1 FROM exclusions x WHERE x.network_id = i.network_id AND x.person_id = i.person_id AND x.noted_at <= i.received_at AND (x.lifted_at IS NULL OR x.lifted_at > i.received_at))
               OR EXISTS (SELECT 1 FROM messages h WHERE h.network_id = i.network_id AND h.person_id = i.person_id AND h.direction = 'out' AND h.author_kind = 'agent' AND h.occurred_at < i.received_at)) AS silent
         FROM inbound_messages i
        WHERE i.network_id = ? AND i.received_at >= ? AND i.received_at < ? AND i.kind <> 'unreadable' AND i.status <> 'unreadable'
          AND (i.conversation_ref IS NULL OR NOT EXISTS (
                SELECT 1 FROM inbound_messages e WHERE e.network_id = i.network_id AND e.channel = i.channel AND e.conversation_ref = i.conversation_ref
                   AND e.kind <> 'unreadable' AND e.status <> 'unreadable' AND (e.received_at < i.received_at OR (e.received_at = i.received_at AND e.id < i.id))))`,
      inMonth,
    );
    const cases: Case[] = [];
    let setAside = 0;
    for (const r of rows) {
      const trial = r.real_at === null || (r.trial_at !== null && Date.parse(r.trial_at) < Date.parse(r.real_at));
      const doneAt = trial ? r.trial_at : r.real_at;
      if (doneAt === null && Number(r.silent) === 1) setAside += 1;
      else cases.push({ at: r.received_at, doneAt, deadline: Date.parse(r.received_at) + MINUTE, trial: trial && doneAt !== null, key: r.id, personId: r.person_id });
    }
    return { cases, setAside };
  }

  /**
   * Les tâches de rappel, par fiche gardée, projet et jour de Paris : réunir deux fiches ne fait pas deux cas, et le
   * rappel fait sur l'une vaut pour l'autre. Une personne exclue ce jour-là ne se rappelle pas [R25].
   */
  private async callbacks(inMonth: string[]): Promise<{ cases: Case[]; setAside: number }> {
    const net = inMonth[0]!;
    const tasks = await this.db.all<{ id: string; person_id: string; project_id: string | null; created_at: string; done_at: string | null }>('SELECT id, person_id, project_id, created_at, done_at FROM callback_tasks WHERE network_id = ? AND created_at >= ? AND created_at < ?', inMonth);
    if (tasks.length === 0) return { cases: [], setAside: 0 };
    const rootOf = await this.mergedRoots(net);
    const exclusions = await this.db.all<{ person_id: string; noted_at: string; lifted_at: string | null }>('SELECT person_id, noted_at, lifted_at FROM exclusions WHERE network_id = ?', [net]);
    const excludedOn = (root: string, day: string): boolean => exclusions.some((x) => rootOf(x.person_id) === root && parisDay(x.noted_at) <= day && (x.lifted_at === null || parisDay(x.lifted_at) > day));
    const groups = new Map<string, { at: string; root: string; day: string; done: string[]; first: string }>();
    for (const t of tasks) {
      const root = rootOf(t.person_id);
      const day = parisDay(t.created_at);
      const key = JSON.stringify([root, t.project_id, day]);
      const group = groups.get(key) ?? { at: t.created_at, root, day, done: [], first: t.id };
      // La plus petite tâche du groupe désigne le cas : réunir deux fiches ne fait pas naître un nouveau cas.
      if (t.id < group.first) group.first = t.id;
      if (t.done_at !== null) group.done.push(t.done_at);
      groups.set(key, group);
    }
    const cases: Case[] = [];
    let setAside = 0;
    for (const g of groups.values()) {
      const doneAt = g.done.find((d) => parisDay(d) === g.day) ?? null;
      if (doneAt === null && excludedOn(g.root, g.day)) setAside += 1;
      else cases.push({ ...sameDay(g.at, doneAt), key: g.first, personId: g.root });
    }
    return { cases, setAside };
  }

  /** La fiche gardée de chaque fiche réunie. */
  private async mergedRoots(net: string): Promise<(id: string) => string> {
    const merges = await this.db.all<{ survivor_id: string; merged_id: string }>('SELECT survivor_id, merged_id FROM person_merges WHERE network_id = ? AND undone_at IS NULL', [net]);
    const parent = new Map(merges.map((m) => [m.merged_id, m.survivor_id]));
    return (id: string): string => {
      const seen = new Set<string>();
      let at = id;
      while (parent.has(at) && !seen.has(at)) {
        seen.add(at);
        at = parent.get(at)!;
      }
      return at;
    };
  }

  /** Les alertes des biens mis en vente ce mois-là, une heure de temps d'envoi [R01] ; voir la tête du fichier. */
  private async alerts(inMonth: string[]): Promise<{ cases: Case[]; setAside: number; unmeasurable: boolean }> {
    const net = inMonth[0]!;
    const rows = await this.db.all<{ property_id: string; on_sale_at: string; person_id: string; status: string; rule: string | null; sent_at: string | null; trial: number; search_later: number }>(
      `SELECT a.property_id, s.on_sale_at, a.person_id, a.status, a.rule, m.occurred_at AS sent_at, ${IN_TRIAL('a.message_id')} AS trial,
              EXISTS (SELECT 1 FROM buyer_searches b WHERE b.project_id = a.project_id AND b.created_at > s.on_sale_at) AS search_later
         FROM property_on_sale s JOIN property_alerts a ON a.property_id = s.property_id AND a.network_id = s.network_id
         LEFT JOIN messages m ON m.id = a.message_id AND a.status = 'sent' AND ${NOT_FAILED('a.message_id')}
        WHERE s.network_id = ? AND s.on_sale_at >= ? AND s.on_sale_at < ?`,
      inMonth,
    );
    const undated = await this.db.first<{ n: number }>(
      'SELECT COUNT(*) AS n FROM property_alerts a WHERE a.network_id = ? AND a.created_at >= ? AND a.created_at < ? AND NOT EXISTS (SELECT 1 FROM property_on_sale s WHERE s.property_id = a.property_id)',
      inMonth,
    );
    const consents = await this.db.all<{ person_id: string; purpose: string; channel: OutboundChannelName; given_at: string; withdrawn_at: string | null }>('SELECT person_id, purpose, channel, given_at, withdrawn_at FROM consents WHERE network_id = ? AND purpose = ?', [net, ALERT_PURPOSE]);
    const exclusions = await this.db.all<{ person_id: string; channel: string | null; noted_at: string; lifted_at: string | null }>('SELECT person_id, channel, noted_at, lifted_at FROM exclusions WHERE network_id = ?', [net]);
    const rootOf = await this.mergedRoots(net);
    /** La personne pouvait-elle recevoir l'alerte à cet instant, sur un canal ? Comme l'envoi : un accord périmé ne vaut pas [R03, R02]. */
    const askedBy = (root: string, at: string): boolean => {
      const t = Date.parse(at);
      const own = { consents: consents.filter((c) => rootOf(c.person_id) === root), exclusions: exclusions.filter((x) => rootOf(x.person_id) === root) };
      const shut = own.exclusions.filter((x) => Date.parse(x.noted_at) <= t && (x.lifted_at === null || Date.parse(x.lifted_at) > t));
      if (shut.some((x) => x.channel === null)) return false;
      return own.consents.some((c) => ALERT_CHANNELS.includes(c.channel) && !shut.some((x) => x.channel === c.channel) && consentInForce(c as never, own as never, t));
    };
    const cases: Case[] = [];
    let setAside = Number(undated?.n ?? 0);
    for (const r of rows) {
      const deadline = afterSendingTime(new Date(r.on_sale_at), HOUR, DEFAULT_SEND_SETTINGS).getTime();
      const inTime = r.sent_at !== null && Date.parse(r.sent_at) <= deadline;
      if (!inTime && SILENCE_RULES.includes(r.rule)) setAside += 1;
      else if (!inTime && (Number(r.search_later) === 1 || !askedBy(rootOf(r.person_id), r.on_sale_at))) setAside += 1;
      else cases.push({ at: r.on_sale_at, doneAt: r.sent_at, deadline, trial: Number(r.trial) === 1, key: `${r.property_id}:${r.person_id}`, personId: r.person_id });
    }
    return { cases, setAside, unmeasurable: rows.length === 0 && Number(undated?.n ?? 0) > 0 };
  }

  /** Le point d'une semaine est dû le lundi qui la suit : ce lundi fait le mois, et seul un envoi de ce jour le tient. */
  private async weeklyPoints(net: string, month: string): Promise<{ cases: Case[]; setAside: number }> {
    const rows = await this.db.all<{ mandate_id: string; week: string; person_id: string; monday: string; signed_at: string | null; status: string; delivery_status: string | null; sent_at: string | null; trial: number }>(
      `SELECT p.mandate_id, p.week, p.person_id, date(p.week, '+7 days') AS monday, d.signed_at, p.status, p.delivery_status, m.occurred_at AS sent_at, ${IN_TRIAL('p.message_id')} AS trial
         FROM weekly_points p LEFT JOIN mandates d ON d.id = p.mandate_id LEFT JOIN messages m ON m.id = p.message_id
        WHERE p.network_id = ? AND substr(date(p.week, '+7 days'), 1, 7) = ?`,
      [net, month],
    );
    const cases: Case[] = [];
    let setAside = 0;
    for (const r of rows) {
      // Midi en temps universel tombe toujours le même jour à Paris.
      const at = `${r.monday}T12:00:00.000Z`;
      if (r.signed_at !== null && parisDay(r.signed_at) > r.monday) setAside += 1;
      else cases.push({ ...sameDay(at, delivered(r), Number(r.trial) === 1), key: `${r.mandate_id}:${r.week}`, personId: r.person_id });
    }
    return { cases, setAside };
  }

  /** Le reversement dû [R70] ; une vente annulée, jamais versée, ne peut plus l'être [R71]. */
  private async payouts(inMonth: string[]): Promise<{ cases: Case[]; setAside: number }> {
    const rows = await this.db.all<{ file_id: string; agent_id: string | null; received_at: string; payout_due_at: string; paid_at: string | null; cancelled: number }>(
      `SELECT r.file_id, (SELECT c.agent_id FROM sale_commissions c WHERE c.file_id = r.file_id) AS agent_id, r.received_at, r.payout_due_at, p.paid_at, ${CANCELLED_SALE} AS cancelled FROM commission_receipts r LEFT JOIN commission_payouts p ON p.file_id = r.file_id
        WHERE r.network_id = ? AND r.received_at >= ? AND r.received_at < ?`,
      inMonth,
    );
    const live = rows.filter((r) => r.paid_at !== null || Number(r.cancelled) !== 1);
    return { setAside: rows.length - live.length, cases: live.map((r) => ({ at: r.received_at, doneAt: r.paid_at, deadline: Date.parse(r.payout_due_at), key: r.file_id, agentId: r.agent_id })) };
  }

  /** La première attribution de chaque contact, comptée du message reçu ; sans agent ou déjà suivi : à part. */
  private async handovers(inMonth: string[]): Promise<{ cases: Case[]; setAside: number }> {
    const rows = await this.db.all<{ id: string; agent_id: string | null; reason: string; created_at: string; received_at: string | null }>(
      `SELECT a.id, a.agent_id, a.reason, a.created_at, i.received_at FROM attributions a
         LEFT JOIN qualifications q ON q.id = a.qualification_id LEFT JOIN inbound_messages i ON i.id = q.inbound_id
        WHERE a.network_id = ? AND a.created_at >= ? AND a.created_at < ? AND a.replaces_id IS NULL`,
      inMonth,
    );
    const cases: Case[] = [];
    let setAside = 0;
    for (const r of rows) {
      if (r.agent_id === null || r.reason === 'already_followed' || r.received_at === null) setAside += 1;
      else cases.push({ at: r.created_at, doneAt: r.created_at, deadline: Date.parse(r.received_at) + MINUTE, key: r.id, agentId: r.agent_id });
    }
    return { cases, setAside };
  }

  /** Une visite d'estimation et l'avis noté envoyé pour ce bien, depuis son début ; sans bien : à part. */
  private async valuations(inMonth: string[]): Promise<{ cases: Case[]; setAside: number }> {
    const rows = await this.db.all<{ id: string; person_id: string; end_at: string; property_id: string | null; sent_at: string | null }>(
      `SELECT a.id, a.person_id, a.end_at, a.property_id,
              (SELECT MIN(d.sent_at) FROM valuation_deliveries d JOIN valuation_reports r ON r.id = d.report_id
                WHERE r.network_id = a.network_id AND r.property_id = a.property_id AND d.sent_at >= a.start_at) AS sent_at
         FROM appointments a
        WHERE a.network_id = ? AND a.kind = 'estimation' AND a.status IN ('booked', 'honored') AND a.end_at >= ? AND a.end_at < ?`,
      inMonth,
    );
    const measured = rows.filter((r) => r.property_id !== null);
    return { setAside: rows.length - measured.length, cases: measured.map((r) => ({ at: r.end_at, doneAt: r.sent_at, deadline: Date.parse(r.end_at) + 48 * HOUR, key: r.id, personId: r.person_id })) };
  }
}
