/**
 * Les indicateurs du parcours (IN03) [R214, R13, R14, R16].
 *
 * Pour la direction et une période, à l'échelle du réseau : contacts en rendez-vous, rendez-vous en mandats, mandats en
 * ventes (les totaux mêmes du tableau de bord, K05) ; jours du mandat à l'offre acceptée, puis de l'offre à l'acte ;
 * minutes de l'avis de valeur validé à la signature (la mesure de D09) ; part des mandats avec un client transmis par
 * le réseau. Tout vient de la base.
 *
 * Décidé, lecture prudente : une donnée absente se dit `null`, jamais zéro ; chaque délai dit combien de dossiers il
 * n'a pas pu mesurer, et rend ses durées sans identifiant. Le mandat d'un délai est le dernier inscrit et non retiré du
 * bien avant la réponse du vendeur. Un client est « transmis » quand le réseau l'a attribué à un agent avant la
 * signature. Un taux se lit sur la même période, pas sur une cohorte : il le dit par son nom, `ratio`.
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

const ratio = (numerator: number, denominator: number): Ratio => ({ numerator, denominator, bp: denominator > 0 ? Math.round((numerator * 10_000) / denominator) : null });

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

    const accepted = await this.db.all<{ responded_at: string; signed_at: string | null }>(
      `SELECT r.responded_at,
              (SELECT m.signed_at FROM mandates m
                 JOIN mandate_register g ON g.mandate_id = m.id AND g.kind = 'inscription'
                WHERE m.network_id = f.network_id AND m.property_id = f.property_id AND m.signed_at <= r.responded_at
                  AND NOT EXISTS (SELECT 1 FROM mandate_register c WHERE c.network_id = g.network_id AND c.kind = 'annulation' AND c.cancels_seq = g.seq AND c.reason IN ('error', 'withdrawal'))
                  AND NOT EXISTS (SELECT 1 FROM mandate_withdrawals w WHERE w.mandate_id = m.id)
                ORDER BY m.signed_at DESC LIMIT 1) AS signed_at
         FROM sale_files f JOIN offer_responses r ON r.offer_id = f.offer_id AND r.outcome = 'acceptee'
        WHERE f.network_id = ? AND r.responded_at >= ? AND r.responded_at < ?`,
      [net, start, end],
    );
    const closed = await this.db.all<{ signed_on: string; responded_at: string | null }>(
      `SELECT c.signed_on, r.responded_at
         FROM sale_file_closings c JOIN sale_files f ON f.id = c.file_id
         LEFT JOIN offer_responses r ON r.offer_id = f.offer_id AND r.outcome = 'acceptee'
        WHERE c.network_id = ? AND c.signed_on >= ? AND c.signed_on <= ?`,
      [net, from, to],
    );
    // L'avis validé le plus récent du bien avant la génération du document, comme la chronologie d'un mandat (D09).
    const signatures = await this.db.all<{ completed_at: string; validated_at: string | null }>(
      `SELECT s.completed_at,
              (SELECT v.validated_at FROM valuation_reports v WHERE v.property_id = d.property_id AND v.status = 'validated' AND v.validated_at <= d.created_at ORDER BY v.validated_at DESC LIMIT 1) AS validated_at
         FROM signed_documents s JOIN documents d ON d.id = s.document_id
        WHERE s.network_id = ? AND s.mandate_id IS NOT NULL AND s.completed_at >= ? AND s.completed_at < ?`,
      [net, start, end],
    );
    const referred = await this.db.first<{ n: number }>(
      `SELECT COUNT(*) AS n FROM mandates m
        WHERE m.network_id = ? AND m.signed_at >= ? AND m.signed_at < ?
          AND EXISTS (SELECT 1 FROM attributions a WHERE a.network_id = m.network_id AND a.person_id = m.person_id AND a.agent_id IS NOT NULL AND a.created_at <= m.signed_at)`,
      [net, start, end],
    );

    const minutes = delay(signatures.map((s) => (s.validated_at ? Math.round((Date.parse(s.completed_at) - Date.parse(s.validated_at)) / 60_000) : null)));
    const targetMinutes = MANDATE_TARGET_SECONDS / 60;
    const value: JourneyIndicators = {
      from,
      to,
      conversion: {
        appointmentsPerContact: ratio(totals.appointments, totals.contacts),
        mandatesPerAppointment: ratio(totals.mandates, totals.appointments),
        salesPerMandate: ratio(totals.sales, totals.mandates),
      },
      mandateToOfferDays: delay(accepted.map((a) => (a.signed_at ? daysBetween(parisDay(a.signed_at), parisDay(a.responded_at)) : null))),
      offerToActDays: delay(closed.map((c) => (c.responded_at ? daysBetween(parisDay(c.responded_at), c.signed_on) : null))),
      valuationToMandateMinutes: { ...minutes, underTarget: minutes.values.filter((m) => m <= targetMinutes).length, targetMinutes },
      networkReferredMandates: ratio(Number(referred?.n ?? 0), totals.mandates),
    };
    return { ok: true as const, value };
  }
}
