/**
 * Les engagements de service tenus dans un mois fini (IN07) [R216, R14, R16, R17].
 *
 * Pour la direction seule, à l'échelle du réseau : la liste des engagements du cahier, onglet « Besoins et solutions »,
 * chacun recalculé depuis sa table, jamais déclaré. Aucun agent, aucun rang [R14] : les lignes rendues ne portent que des
 * comptes et les jours des cas manqués, ni identifiant ni nom [R13].
 *
 * Décidé, lecture prudente :
 * - un cas appartient au mois de ce qui le déclenche ; il ne compte qu'une fois tenu ou son délai écoulé : avant, il est
 *   « en attente », ni tenu ni manqué ;
 * - « tout contact » : le premier message lisible d'une conversation ; une réponse refusée par le contrôle central, sans
 *   aucune autre réponse, est à part (personne exclue ou arrêt : se taire est la loi), et se voit ;
 * - « le jour même » : le jour de Paris, sans excuse pour le soir ; un chiffre sévère ne ment jamais au client ;
 * - « client transmis tout de suite » : attribué à un agent dans la minute du message reçu, comme le critère de M03 ; un
 *   client que l'agent suivait déjà ou sans agent dans sa zone n'a pas été transmis et se voit à part ; la fiche complète
 *   passe dans la même écriture que l'attribution (Q03) ;
 * - compte rendu de visite : la même mesure que le dossier de présentation (G07), à 24 h ;
 * - l'alerte aux acquéreurs n'est pas mesurable : la base ne date pas la mise en vente. La ligne le dit (IN11).
 */
import type { Viewer } from '../acces/droits.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { localTime } from '../envoi/horaires.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import { monthBounds } from './indicateurs-reseau.ts';
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
  /** Cas écartés du calcul, dits à part : voir la tête du fichier. */
  setAside: number;
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
}

const parisDay = (iso: string): string => localTime(new Date(iso), 'Europe/Paris').date;
const tally = (cases: readonly Case[], now: number) => {
  const missedDays: string[] = [];
  let kept = 0;
  let pending = 0;
  for (const c of cases) {
    if (c.doneAt !== null && Date.parse(c.doneAt) <= c.deadline) kept += 1;
    else if (c.deadline > now) pending += 1;
    else missedDays.push(parisDay(c.at));
  }
  missedDays.sort();
  return { kept: ratio(kept, kept + missedDays.length), pending, missedDays };
};
/** Tenu si le geste a lieu le même jour de Paris que le cas : le geste est rendu seulement dans ce cas. */
const sameDay = (at: string, doneAt: string | null): Case => {
  const inDay = doneAt !== null && parisDay(doneAt) === parisDay(at);
  return { at, doneAt: inDay ? doneAt : null, deadline: inDay ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY };
};
const earliest = (a: string | null, b: string | null): string | null => (a === null ? b : b === null ? a : Date.parse(a) <= Date.parse(b) ? a : b);

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
    const [start, end] = monthBounds(month);
    const now = at.getTime();
    const inMonth = [net, start, end];
    const replies = await this.firstReplies(inMonth);
    const handovers = await this.handovers(inMonth);

    const judged: Partial<Record<ServicePromiseCode, { cases: Case[]; setAside: number }>> = {
      reponse_minute: replies,
      client_transmis: handovers,
      rappel_chaud: {
        setAside: 0,
        cases: (await this.db.all<{ created_at: string; done_at: string | null }>('SELECT created_at, done_at FROM callback_tasks WHERE network_id = ? AND created_at >= ? AND created_at < ?', inMonth)).map((r) => sameDay(r.created_at, r.done_at)),
      },
      avis_48h: await this.valuations(inMonth),
      compte_rendu_24h: {
        setAside: 0,
        // Toute visite terminée et non annulée, marquée tenue ou non, comme le dossier de présentation (G07).
        cases: (
          await this.db.all<{ end_at: string; validated_at: string | null; status: string | null }>(
            `SELECT a.end_at, r.validated_at, r.status FROM appointments a LEFT JOIN visit_reports r ON r.appointment_id = a.id
              WHERE a.network_id = ? AND a.kind = 'visite' AND a.status IN ('booked', 'honored') AND a.end_at >= ? AND a.end_at < ?`,
            inMonth,
          )
        ).map((r) => ({ at: r.end_at, doneAt: r.status === 'valide' ? r.validated_at : null, deadline: Date.parse(r.end_at) + 24 * HOUR })),
      },
      point_lundi: {
        setAside: 0,
        cases: (await this.db.all<{ created_at: string; validated_at: string | null; status: string }>('SELECT created_at, validated_at, status FROM weekly_points WHERE network_id = ? AND created_at >= ? AND created_at < ?', inMonth)).map((r) => sameDay(r.created_at, r.status === 'valide' ? r.validated_at : null)),
      },
      offre_jour_meme: {
        setAside: 0,
        cases: (await this.db.all<{ received_at: string; at: string | null }>('SELECT o.received_at, t.at FROM offer_register o LEFT JOIN offer_transmissions t ON t.offer_id = o.id WHERE o.network_id = ? AND o.received_at >= ? AND o.received_at < ?', inMonth)).map((r) => sameDay(r.received_at, r.at)),
      },
      commission_24h: {
        setAside: 0,
        cases: (await this.db.all<{ received_at: string; payout_due_at: string; paid_at: string | null }>('SELECT r.received_at, r.payout_due_at, p.paid_at FROM commission_receipts r LEFT JOIN commission_payouts p ON p.file_id = r.file_id WHERE r.network_id = ? AND r.received_at >= ? AND r.received_at < ?', inMonth)).map((r) => ({ at: r.received_at, doneAt: r.paid_at, deadline: Date.parse(r.payout_due_at) })),
      },
    };

    const lines: ServicePromiseLine[] = SERVICE_PROMISES.map((p) => {
      const one = judged[p.code];
      if (!one) return { ...p, measurable: false, kept: ratio(0, 0), pending: 0, setAside: 0, missedDays: [] };
      return { ...p, measurable: true, ...tally(one.cases, now), setAside: one.setAside };
    });
    const numerator = lines.reduce((sum, l) => sum + l.kept.numerator, 0);
    const denominator = lines.reduce((sum, l) => sum + l.kept.denominator, 0);
    await appendEvent(this.journal, { type: 'pilotage.lecture', actor: `${String(viewer.role)}:${viewer.userId}`, subject: `network:${net}`, data: { kind: 'service_promises', month } }, this.now);
    return { ok: true, value: { month, lines, overall: ratio(numerator, denominator) } };
  }

  /** Le premier message lisible de chaque conversation, et sa première réponse : la réponse automatique partie (C04), ou un message de l'agent. */
  private async firstReplies(inMonth: string[]): Promise<{ cases: Case[]; setAside: number }> {
    const rows = await this.db.all<{ received_at: string; sent_at: string | null; out_at: string | null; refused: number }>(
      `SELECT i.received_at,
              (SELECT MIN(c.created_at) FROM first_reply_claims c WHERE c.inbound_id = i.id AND c.outcome = 'sent') AS sent_at,
              (SELECT COUNT(*) FROM first_reply_claims c WHERE c.inbound_id = i.id AND c.outcome = 'refused') AS refused,
              (SELECT MIN(m.occurred_at) FROM messages m WHERE m.network_id = i.network_id AND m.person_id = i.person_id AND m.direction = 'out' AND m.author_kind = 'agent' AND m.occurred_at >= i.received_at) AS out_at
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
      const doneAt = earliest(r.sent_at, r.out_at);
      if (doneAt === null && Number(r.refused) > 0) setAside += 1;
      else cases.push({ at: r.received_at, doneAt, deadline: Date.parse(r.received_at) + MINUTE });
    }
    return { cases, setAside };
  }

  /** La première attribution de chaque contact, comptée du message reçu ; sans agent ou déjà suivi : à part. */
  private async handovers(inMonth: string[]): Promise<{ cases: Case[]; setAside: number }> {
    const rows = await this.db.all<{ agent_id: string | null; reason: string; created_at: string; received_at: string | null }>(
      `SELECT a.agent_id, a.reason, a.created_at, i.received_at FROM attributions a
         LEFT JOIN qualifications q ON q.id = a.qualification_id LEFT JOIN inbound_messages i ON i.id = q.inbound_id
        WHERE a.network_id = ? AND a.created_at >= ? AND a.created_at < ? AND a.replaces_id IS NULL`,
      inMonth,
    );
    const cases: Case[] = [];
    let setAside = 0;
    for (const r of rows) {
      if (r.agent_id === null || r.reason === 'already_followed' || r.received_at === null) setAside += 1;
      else cases.push({ at: r.created_at, doneAt: r.created_at, deadline: Date.parse(r.received_at) + MINUTE });
    }
    return { cases, setAside };
  }

  /** Une visite d'estimation et l'avis noté envoyé pour ce bien, depuis son début ; sans bien : à part. */
  private async valuations(inMonth: string[]): Promise<{ cases: Case[]; setAside: number }> {
    const rows = await this.db.all<{ end_at: string; property_id: string | null; sent_at: string | null }>(
      `SELECT a.end_at, a.property_id,
              (SELECT MIN(d.sent_at) FROM valuation_deliveries d JOIN valuation_reports r ON r.id = d.report_id
                WHERE r.network_id = a.network_id AND r.property_id = a.property_id AND d.sent_at >= a.start_at) AS sent_at
         FROM appointments a
        WHERE a.network_id = ? AND a.kind = 'estimation' AND a.status IN ('booked', 'honored') AND a.end_at >= ? AND a.end_at < ?`,
      inMonth,
    );
    const measured = rows.filter((r) => r.property_id !== null);
    return { setAside: rows.length - measured.length, cases: measured.map((r) => ({ at: r.end_at, doneAt: r.sent_at, deadline: Date.parse(r.end_at) + 48 * HOUR })) };
  }
}
