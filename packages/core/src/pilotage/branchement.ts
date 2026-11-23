/**
 * Branchement de M13 dans le socle (K08) [R13, R14, R16, R18, R68, R69].
 *
 * - `pilotageHourlyJob` : le passage horaire des commissions (K01 : prévues au compromis, dues à l'acte), des factures
 *   (K02 : brouillons préparés, transmissions reprises après une panne) et des reversements (K03 : alertes avant et
 *   après l'échéance). Chaque étape, rejouée, n'ajoute rien [R18].
 * - `SqlEcheancesDocumentsAgent` : les fins de validité des pièces du dossier d'agent de M14 (J04), lues pour les
 *   alertes de pilotage (K07). Lecture seule : les alertes de l'agent lui-même restent à M14.
 * - `ExportQuotidien` : l'export d'un jour, en CSV, pour le comparer au comptage manuel pendant 2 semaines
 *   (`docs/MESURE.md`, H27). Ses chiffres sont ceux du tableau de bord du réseau (K05), lus par lui, jamais recalculés
 *   à part : l'export du jour égale le tableau de bord, ce que les tests vérifient [R69].
 *
 * Décidé, lecture prudente : un document d'agent est signalé s'il finit dans le délai réglé, ou s'il est déjà échu,
 * pour un agent actif seulement, la dernière version signée de chaque pièce ; les honoraires de l'export sont ceux,
 * en euros, des ventes du jour (actes rapportés), les mêmes lignes que la colonne des ventes.
 */
import { Acces } from '../acces/acces.ts';
import type { Viewer } from '../acces/droits.ts';
import type { ScheduledJob } from '../bascule/planificateur.ts';
import { FicheClient } from '../db/fiche-client.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { FicheUnique } from '../fiche/fusion.ts';
import type { JournalStore } from '../journal/types.ts';
import type { EcheancesDocumentsAgent } from './alertes.ts';
import { Commissions } from './commissions.ts';
import { Encaissements } from './encaissements.ts';
import { EngagementsManques } from './engagements-manques.ts';
import { Factures, type IdentitesFacturation, type PlateformeFacturation } from './factures.ts';
import { TableauReseau } from './tableau-reseau.ts';

export const PILOTAGE_HOURLY_JOB = 'pilotage.passage';

/** Les pièces du dossier d'agent (M14) qui finissent au plus tard `untilDay`, dernière version signée, agents actifs. */
export class SqlEcheancesDocumentsAgent implements EcheancesDocumentsAgent {
  constructor(private readonly db: SqlDatabase) {}

  async dueBy(networkId: string, untilDay: string): Promise<readonly { agentId: string; document: string; validUntil: string }[]> {
    const rows = await this.db.all<{ agent_id: string; kind: string; valid_until: string }>(
      `SELECT p.agent_id, p.kind, p.valid_until FROM agent_file_pieces p JOIN agents a ON a.id = p.agent_id
       WHERE p.network_id = ? AND a.status = 'active' AND p.is_draft = 0 AND p.valid_until IS NOT NULL AND p.valid_until <= ?
       AND p.version = (SELECT MAX(q.version) FROM agent_file_pieces q WHERE q.agent_id = p.agent_id AND q.kind = p.kind AND q.is_draft = 0)
       ORDER BY p.valid_until, p.agent_id, p.kind`,
      [networkId, untilDay],
    );
    return rows.map((r) => ({ agentId: r.agent_id, document: r.kind, validUntil: r.valid_until }));
  }
}

/** Le passage de chaque heure : commissions, puis factures (émises seules le jour de l'acte, HX04), puis reversements, pour chaque réseau, dans cet ordre. */
export function pilotageHourlyJob(
  db: SqlDatabase,
  journal: JournalStore,
  options: { now?: () => Date; facturation?: { plateforme?: PlateformeFacturation; identites?: IdentitesFacturation } } = {},
): ScheduledJob {
  const now = options.now ?? (() => new Date());
  return {
    name: PILOTAGE_HOURLY_JOB,
    hours: Array.from({ length: 24 }, (_, h) => h),
    run: async () => {
      const store = new FicheClient(db, { now });
      const acces = new Acces(db, store, new FicheUnique(db, store, { now }), journal, { now });
      const commissions = new Commissions(db, acces, journal, { now });
      // La même plateforme et les mêmes identités que l'API : une facture d'acte n'est jamais émise en essai derrière
      // une plateforme réelle (AU013).
      const factures = new Factures(db, acces, journal, { now, ...(options.facturation ?? {}) });
      const encaissements = new Encaissements(db, acces, journal, { now });
      const manques = new EngagementsManques(db, journal, { now });
      for (const n of await db.all<{ id: string }>('SELECT id FROM networks ORDER BY id')) {
        await commissions.sync(n.id);
        await factures.prepare(n.id);
        await factures.issueOnDeed(n.id);
        await factures.track(n.id);
        await factures.reconcile(n.id);
        await encaissements.run(n.id);
        await manques.syncIfDue(n.id);
      }
    },
  };
}

export const DAILY_EXPORT_HEADER = ['jour', 'agent', 'contacts', 'rendez_vous_tenus', 'mandats_signes', 'ventes', 'honoraires_eur'] as const;

const cell = (v: string | number): string => {
  const t = String(v);
  // Jamais de formule ouverte par le tableur : une cellule qui commence par = + - @ est préfixée d'une apostrophe.
  const safe = /^[=+\-@\t\r]/.test(t) ? `'${t}` : t;
  return /[;"\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

/** L'export d'un jour : une ligne par agent (« direction » pour ce qu'elle garde), puis la ligne « total ». */
export class ExportQuotidien {
  private readonly tableau: TableauReseau;

  constructor(
    private readonly db: SqlDatabase,
    journal: JournalStore,
    options: { now?: () => Date } = {},
  ) {
    this.tableau = new TableauReseau(db, journal, options);
  }

  async csv(viewer: Viewer, day: unknown): Promise<{ ok: true; value: string } | { ok: false; rule: 'R16' | null; code: string }> {
    const board = await this.tableau.of(viewer, { from: day, to: day });
    if (!board.ok) return board;
    const d = board.value;
    // AU091 · les honoraires de la commission, régularisés s'il le faut ; à défaut de commission calculée, ceux de l'acte.
    const fees = await this.db.all<{ agent_id: string; eur: number }>(
      'SELECT k.agent_id, SUM(COALESCE(c.fee_cents / 100.0, k.fee_eur)) AS eur FROM sale_commissions k LEFT JOIN commissions c ON c.file_id = k.file_id WHERE k.network_id = ? AND k.due_on = ? GROUP BY k.agent_id',
      [viewer.networkId, d.from],
    );
    const feeOf = new Map(fees.map((f) => [f.agent_id, Number(f.eur)]));
    const lines = [DAILY_EXPORT_HEADER.join(';')];
    let total = 0;
    for (const r of d.byAgent) {
      const eur = r.agentId === null ? 0 : (feeOf.get(r.agentId) ?? 0);
      total += eur;
      lines.push([d.from, r.agentId ?? 'direction', r.contacts, r.appointments, r.mandates, r.sales, eur].map(cell).join(';'));
    }
    lines.push([d.from, 'total', d.totals.contacts, d.totals.appointments, d.totals.mandates, d.totals.sales, total].map(cell).join(';'));
    return { ok: true, value: `${lines.join('\r\n')}\r\n` };
  }
}
