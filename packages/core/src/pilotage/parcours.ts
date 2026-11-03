/**
 * Les indicateurs du parcours (IN03) [R214, R13, R14, R16].
 *
 * Pour la direction et une période, à l'échelle du réseau : contacts en rendez-vous, rendez-vous en mandats, mandats en
 * ventes ; jours du mandat à l'offre acceptée, puis de l'offre à l'acte ;
 * minutes de l'avis de valeur validé à la signature (la mesure de D09) ; part des mandats avec un client transmis par
 * le réseau. Tout vient de la base.
 *
 * Décidé, lecture prudente : une donnée absente se dit `null`, jamais zéro ; chaque délai dit combien de dossiers il
 * n'a pas pu mesurer, et rend ses durées sans identifiant. Le mandat d'un délai est le dernier inscrit et non retiré du
 * bien avant l'acceptation. Un client est « transmis » quand le réseau l'a attribué à un agent avant la
 * signature, hors client que l'agent suivait déjà. Un taux se lit sur la même période, pas sur une cohorte. Rendez-vous et
 * ventes sont les totaux du tableau de bord (K05) ; les contacts comptent sans les réattributions, et les mandats comme
 * le compteur de la preuve [R210], donc plus stricts que le tableau de bord, qui compte chaque ligne rangée.
 */
import type { Viewer } from '../acces/droits.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { localTime } from '../envoi/horaires.ts';
import type { JournalStore } from '../journal/types.ts';
import { MANDATE_TARGET_SECONDS } from '../documents/chronologie.ts';
import { parisDayStart } from './tableau-agent.ts';
import { TableauReseau } from './tableau-reseau.ts';

export interface Ratio {
  numerator: number;
  denominator: number;
  /** En dix-millièmes ; `null` quand le dénominateur est nul. */
  bp: number | null;
}

export interface Delay {
  /** Les durées mesurées, triées, sans identifiant. */
  values: number[];
  median: number | null;
  /** Les dossiers de la période que la base ne permet pas de mesurer. */
  unmeasured: number;
}

export interface JourneyIndicators {
  from: string;
  to: string;
  conversion: { appointmentsPerContact: Ratio; mandatesPerAppointment: Ratio; salesPerMandate: Ratio };
  mandateToOfferDays: Delay;
  offerToActDays: Delay;
  valuationToMandateMinutes: Delay & { underTarget: number; targetMinutes: number };
  networkReferredMandates: Ratio;
}

/** Les mandats qui comptent, comme le compteur de la preuve [R210] : inscrits, ni annulés pour erreur, ni rétractés. */
export const LIVE_REGISTERED_MANDATES = `SELECT m.id, m.network_id, m.agent_id, m.person_id, m.property_id, m.signed_at FROM mandates m
  JOIN mandate_register g ON g.mandate_id = m.id AND g.kind = 'inscription'
  WHERE NOT EXISTS (SELECT 1 FROM mandate_register c WHERE c.network_id = g.network_id AND c.kind = 'annulation' AND c.cancels_seq = g.seq AND c.reason IN ('error', 'withdrawal'))
    AND NOT EXISTS (SELECT 1 FROM mandate_withdrawals w WHERE w.mandate_id = m.id)`;

/** L'instant où chaque offre est acceptée : la réponse du vendeur, ou la dernière proposition de sa contre-offre. Un paramètre : le réseau. */
const ACCEPTED_OFFERS = `SELECT o.id, o.network_id, o.property_id,
    CASE r.outcome
      WHEN 'acceptee' THEN r.responded_at
      WHEN 'contre_offre' THEN (SELECT pr.responded_at FROM offer_proposals p JOIN proposal_responses pr ON pr.proposal_id = p.id
                                 WHERE p.offer_id = o.id AND pr.outcome = 'acceptee'
                                   AND p.seq = (SELECT MAX(q.seq) FROM offer_proposals q WHERE q.offer_id = o.id))
    END AS accepted_at
  FROM offer_register o LEFT JOIN offer_responses r ON r.offer_id = o.id WHERE o.network_id = ?`;

export const ratio = (numerator: number, denominator: number): Ratio => ({ numerator, denominator, bp: denominator > 0 ? Math.round((numerator * 10_000) / denominator) : null });

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

const parisDay = (iso: string): string => localTime(new Date(iso), 'Europe/Paris').date;
/** Jours de calendrier entre deux jours : une signature à 23 h et une réponse à 8 h le lendemain, c'est un jour. */
const daysBetween = (from: string, to: string): number => Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86_400_000);
const delay = (raw: (number | null)[]): Delay => {
  const values = raw.filter((v): v is number => v !== null).sort((a, b) => a - b);
  return { values, median: median(values), unmeasured: raw.length - values.length };
};
const nextDay = (day: string): string => new Date(Date.parse(`${day}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

export class IndicateursParcours {
  private readonly now: () => Date;
  private readonly tableau: TableauReseau;

  constructor(
    private readonly db: SqlDatabase,
    journal: JournalStore,
    options: { now?: () => Date } = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.tableau = new TableauReseau(db, journal, { now: this.now });
  }

  /** Les droits et la période sont ceux du tableau de bord, qui écrit chaque refus au journal [R16]. */
  async of(viewer: Viewer, input: { from: unknown; to: unknown }) {
    const board = await this.tableau.of(viewer, input);
    if (!board.ok) return board;
    const net = viewer.networkId;
    const { from, to, totals } = board.value;
    const start = parisDayStart(from).toISOString();
    const end = parisDayStart(nextDay(to)).toISOString();

    const acceptedDays = await this.db.all<{ accepted_at: string; signed_at: string | null }>(
      `WITH accepted AS (${ACCEPTED_OFFERS})
       SELECT a.accepted_at,
              (SELECT m.signed_at FROM (${LIVE_REGISTERED_MANDATES}) m
                WHERE m.network_id = a.network_id AND m.property_id = a.property_id AND m.signed_at <= a.accepted_at
                ORDER BY m.signed_at DESC LIMIT 1) AS signed_at
         FROM accepted a
        WHERE a.accepted_at IS NOT NULL AND a.accepted_at >= ? AND a.accepted_at < ?`,
      [net, start, end],
    );
    const closed = await this.db.all<{ signed_on: string; accepted_at: string | null }>(
      `WITH accepted AS (${ACCEPTED_OFFERS})
       SELECT c.signed_on, a.accepted_at
         FROM sale_file_closings c JOIN sale_files f ON f.id = c.file_id
         LEFT JOIN accepted a ON a.id = f.offer_id
        WHERE c.network_id = ? AND c.signed_on >= ? AND c.signed_on <= ?`,
      [net, net, from, to],
    );
    // L'avis validé le plus récent du bien avant la génération du document, comme la chronologie d'un mandat (D09).
    const signatures = await this.db.all<{ completed_at: string; validated_at: string | null }>(
      `SELECT s.completed_at,
              (SELECT v.validated_at FROM valuation_reports v WHERE v.property_id = d.property_id AND v.status = 'validated' AND v.validated_at <= d.created_at ORDER BY v.validated_at DESC LIMIT 1) AS validated_at
         FROM signed_documents s JOIN documents d ON d.id = s.document_id
        WHERE s.network_id = ? AND s.completed_at >= ? AND s.completed_at < ?
          AND s.mandate_id IN (SELECT id FROM (${LIVE_REGISTERED_MANDATES}))`,
      [net, start, end],
    );
    // Un contact n'est compté qu'une fois : une réattribution remplace une ligne, elle n'amène personne de plus.
    const contacts = Number((await this.db.first<{ n: number }>('SELECT COUNT(*) AS n FROM attributions WHERE network_id = ? AND replaces_id IS NULL AND created_at >= ? AND created_at < ?', [net, start, end]))?.n ?? 0);
    const mandates = await this.db.all<{ person_id: string; signed_at: string }>(`SELECT person_id, signed_at FROM (${LIVE_REGISTERED_MANDATES}) WHERE network_id = ? AND signed_at >= ? AND signed_at < ?`, [net, start, end]);
    const referred = await this.referredCount(net, mandates, end);

    const measured = signatures.map((s) => (s.validated_at ? Date.parse(s.completed_at) - Date.parse(s.validated_at) : null));
    const minutes = delay(measured.map((ms) => (ms === null ? null : Math.round(ms / 60_000))));
    const value: JourneyIndicators = {
      from,
      to,
      conversion: {
        appointmentsPerContact: ratio(totals.appointments, contacts),
        mandatesPerAppointment: ratio(mandates.length, totals.appointments),
        salesPerMandate: ratio(totals.sales, mandates.length),
      },
      mandateToOfferDays: delay(acceptedDays.map((a) => (a.signed_at ? daysBetween(parisDay(a.signed_at), parisDay(a.accepted_at)) : null))),
      offerToActDays: delay(closed.map((c) => (c.accepted_at ? daysBetween(parisDay(c.accepted_at), c.signed_on) : null))),
      // Sur la durée exacte, strictement, comme la chronologie d'un mandat : 10 minutes pile n'est pas sous la cible.
      valuationToMandateMinutes: { ...minutes, underTarget: measured.filter((ms) => ms !== null && ms < MANDATE_TARGET_SECONDS * 1000).length, targetMinutes: MANDATE_TARGET_SECONDS / 60 },
      networkReferredMandates: ratio(referred, mandates.length),
    };
    return { ok: true as const, value };
  }

  /**
   * Les mandats dont le client a été transmis par le réseau avant la signature, toutes fiches réunies comprises : une
   * attribution peut être posée sur une fiche réunie depuis. Un client que l'agent suivait déjà n'est pas transmis.
   */
  private async referredCount(networkId: string, mandates: readonly { person_id: string; signed_at: string }[], end: string): Promise<number> {
    if (mandates.length === 0) return 0;
    const merges = await this.db.all<{ survivor_id: string; merged_id: string }>('SELECT survivor_id, merged_id FROM person_merges WHERE network_id = ? AND undone_at IS NULL', [networkId]);
    const parent = new Map<string, string>();
    const root = (id: string): string => {
      let r = id;
      while (parent.has(r)) r = parent.get(r)!;
      return r;
    };
    for (const m of merges) {
      const [a, b] = [root(m.merged_id), root(m.survivor_id)];
      if (a !== b) parent.set(a, b);
    }
    const first = new Map<string, string>();
    const rows = await this.db.all<{ person_id: string; created_at: string }>(
      "SELECT person_id, created_at FROM attributions WHERE network_id = ? AND agent_id IS NOT NULL AND reason <> 'already_followed' AND created_at < ?",
      [networkId, end],
    );
    for (const a of rows) {
      const r = root(a.person_id);
      const known = first.get(r);
      if (known === undefined || a.created_at < known) first.set(r, a.created_at);
    }
    return mandates.filter((m) => {
      const at = first.get(root(m.person_id));
      return at !== undefined && at <= m.signed_at;
    }).length;
  }
}
