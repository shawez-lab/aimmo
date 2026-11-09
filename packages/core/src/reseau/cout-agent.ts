/**
 * Le coût complet de l'agent moyen, couvert par la part du réseau (HX65 ; Feuille de route, phase 4, « La part du
 * réseau couvre le coût complet de chaque agent » ; Offre aux agents, « La règle de calcul » ; M13) [R623, R624, R625].
 *
 * La direction dit le poste de chaque facture fournisseur rangée (HX49) dans une liste fermée : IA, clients apportés,
 * diffusion, accompagnement, conformité, ou hors coût des agents. Un classement ne change plus : une nouvelle version
 * le remplace [R623, R17]. Elle règle aussi, par versions datées et jamais pour un mois passé, la provision pour
 * l'indemnité de fin de contrat (en points de base des parts encaissées des agents) et la marge (en points de base
 * du coût complet) [R624].
 *
 * Pour un mois fini de Paris, le code seul calcule depuis la base : la part du réseau des commissions encaissées dans
 * le mois, le coût complet par poste (hors taxe), la provision, le coût avec sa marge, les agents présents, la part et
 * le coût de l'agent moyen, et si la part couvre le coût. Une facture du mois non classée ou un réglage absent rend le
 * mois incomplet : il n'est jamais dit couvert [R623, R624].
 *
 * Jamais vu : la part du réseau, en points de base des honoraires encaissés (hors part d'une agence partenaire), en
 * dessous de laquelle l'agent moyen ne couvre plus son coût complet avec sa marge, calculée chaque mois sur les coûts
 * réels ; chaque chiffre porte ses factures et ses dossiers. C'est une information pour la fin du pilote : rien ici ne
 * change la grille des commissions [R625].
 *
 * La moyenne seule : aucun chiffre ni aucune liste par agent, aucun classement [R625, R14]. La direction seule classe,
 * règle et lit ; la lecture est écrite au journal avant d'être rendue [R16]. Rien n'est envoyé, rien ne s'efface [R17].
 */
import type { Viewer } from '../acces/droits.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import { monthBounds } from '../pilotage/indicateurs-reseau.ts';
import { parisMonth } from '../pilotage/preuve.ts';

/** Les postes du coût complet de l'agent, dans l'ordre de l'Offre aux agents, et la sortie « hors coût des agents ». */
export const AGENT_COST_CATEGORIES = ['ia', 'clients_apportes', 'diffusion', 'accompagnement', 'conformite'] as const;
export type AgentCostCategory = (typeof AGENT_COST_CATEGORIES)[number];
export const COST_ASSIGNMENT_CATEGORIES = [...AGENT_COST_CATEGORIES, 'hors_agents'] as const;
export type CostAssignmentCategory = (typeof COST_ASSIGNMENT_CATEGORIES)[number];

export const AGENT_COST_SETTINGS_FIELDS = ['validFrom', 'provisionBp', 'marginBp', 'reason'] as const;

export type CoutAgentRefusal =
  | { ok: false; rule: 'R16'; code: 'role' }
  | { ok: false; rule: 'R623' | 'R624' | null; code: string };

export interface AgentCostSettings {
  version: number;
  validFrom: string;
  provisionBp: number;
  marginBp: number;
}

export interface AgentCostMonth {
  month: string;
  /** Faux quand une facture du mois n'est pas classée ou qu'aucun réglage ne vaut pour le mois. */
  complete: boolean;
  missing: ('reglage' | 'factures_non_classees')[];
  settings: AgentCostSettings | null;
  /** Agents entrés avant la fin du mois et pas partis avant son début. */
  agentsPresent: number;
  /** Honoraires des commissions encaissées dans le mois, hors part d'une agence partenaire. */
  feesCents: number;
  networkShareCents: number;
  /** Parts de l'agent et des agents qui partagent : la base de la provision. */
  agentSharesCents: number;
  costs: Record<AgentCostCategory, number>;
  provisionCents: number;
  /** Les postes et la provision. */
  fullCostCents: number;
  marginCents: number;
  /** Le coût complet et sa marge : ce que la part du réseau doit couvrir. */
  requiredCents: number;
  /** L'agent moyen ; nul sans agent présent. */
  averageAgent: { networkShareCents: number; requiredCents: number } | null;
  /** Vrai seulement pour un mois complet dont la part du réseau couvre le coût avec sa marge. */
  covered: boolean;
  /** La part du réseau du mois, en points de base des honoraires, au point inférieur ; nulle sans honoraires. */
  networkBp: number | null;
  /** Jamais vu : la part du réseau qui couvre tout juste le coût avec sa marge, au point supérieur ; nulle sans honoraires. */
  breakEvenNetworkBp: number | null;
  /** Le coût de l'IA mesuré message par message, pour comparer aux factures ; il n'entre pas dans le calcul. */
  aiMeasuredCents: number;
  /** Les lignes de chaque chiffre. */
  lines: {
    files: { fileId: string; feesCents: number; networkShareCents: number; agentSharesCents: number }[];
    invoices: { invoiceId: string; category: CostAssignmentCategory; htCents: number }[];
    unclassified: string[];
  };
}

interface Options {
  now?: () => Date;
}

const isMonth = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(v);
const isBp = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 10_000;
const nextMonth = (month: string): string => {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
};

/** Au centime inférieur : `amount × bp / 10 000`, en entiers. */
export const bpOf = (amountCents: number, bp: number): number => Math.floor((amountCents * bp) / 10_000);

/** La part du réseau, au point de base supérieur, qui couvre `requiredCents` sur `feesCents` d'honoraires [R625]. */
export const breakEvenBp = (requiredCents: number, feesCents: number): number | null => (feesCents > 0 ? Math.ceil((requiredCents * 10_000) / feesCents) : null);

export class CoutAgent {
  private readonly now: () => Date;

  constructor(
    private readonly db: SqlDatabase,
    private readonly journal: JournalStore,
    options: Options = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  private actor(viewer: Viewer): string {
    return `${String(viewer.role)}:${viewer.userId}`;
  }

  /** La direction seule ; tout autre rôle est refusé et le refus écrit au journal [R16]. */
  private async direction(viewer: Viewer, kind: string): Promise<CoutAgentRefusal | null> {
    if (viewer.role === 'direction') return null;
    await appendEvent(
      this.journal,
      { type: 'acces.refuse', actor: this.actor(viewer), subject: `network:${viewer.networkId}`, data: { rule: 'R16', role: String(viewer.role), kind, code: 'role' } },
      this.now,
    );
    return { ok: false, rule: 'R16', code: 'role' };
  }

  private async refuse(viewer: Viewer, refusal: CoutAgentRefusal): Promise<CoutAgentRefusal> {
    await appendEvent(this.journal, { type: 'cout_agent.refuse', actor: this.actor(viewer), subject: `network:${viewer.networkId}`, data: { rule: refusal.rule, code: refusal.code } }, this.now);
    return refusal;
  }

  /** Dit le poste d'une facture fournisseur rangée ; une nouvelle version remplace l'ancienne, qui reste [R623]. */
  async assign(viewer: Viewer, invoiceId: unknown, category: unknown): Promise<{ ok: true; value: { invoiceId: string; version: number; category: CostAssignmentCategory } } | CoutAgentRefusal> {
    const denied = await this.direction(viewer, 'agent_cost_assignment');
    if (denied) return denied;
    if (typeof category !== 'string' || !(COST_ASSIGNMENT_CATEGORIES as readonly string[]).includes(category)) return this.refuse(viewer, { ok: false, rule: 'R623', code: 'bad_category' });
    if (typeof invoiceId !== 'string' || invoiceId.length === 0 || invoiceId.length > 64) return this.refuse(viewer, { ok: false, rule: null, code: 'not_found' });
    const invoice = await this.db.first<{ id: string; current: string | null; version: number | null }>(
      `SELECT i.id, (SELECT a.category FROM agent_cost_assignments a WHERE a.invoice_id = i.id ORDER BY a.version DESC LIMIT 1) AS current,
              (SELECT MAX(a.version) FROM agent_cost_assignments a WHERE a.invoice_id = i.id) AS version
         FROM supplier_invoices i WHERE i.id = ? AND i.network_id = ?`,
      [invoiceId, viewer.networkId],
    );
    if (!invoice) return this.refuse(viewer, { ok: false, rule: null, code: 'not_found' });
    if (invoice.current === category) return this.refuse(viewer, { ok: false, rule: 'R623', code: 'deja_classee' });
    const version = Number(invoice.version ?? 0) + 1;
    try {
      await this.db.run('INSERT INTO agent_cost_assignments (invoice_id, network_id, version, category, assigned_by, assigned_at) VALUES (?, ?, ?, ?, ?, ?)', [
        invoiceId,
        viewer.networkId,
        version,
        category,
        this.actor(viewer),
        this.now().toISOString(),
      ]);
    } catch {
      // Un autre classement de la même facture est passé entre la lecture et l'écriture : rien n'est rangé.
      return this.refuse(viewer, { ok: false, rule: 'R623', code: 'conflit' });
    }
    await appendEvent(this.journal, { type: 'cout_agent.facture_classee', actor: this.actor(viewer), subject: `network:${viewer.networkId}`, data: { invoiceId, version, category } }, this.now);
    return { ok: true, value: { invoiceId, version, category: category as CostAssignmentCategory } };
  }

  /** Range une nouvelle version des réglages, à partir du mois en cours de Paris au plus tôt : jamais pour un mois passé [R624]. */
  async setSettings(viewer: Viewer, input: unknown): Promise<{ ok: true; value: AgentCostSettings } | CoutAgentRefusal> {
    const denied = await this.direction(viewer, 'agent_cost_settings');
    if (denied) return denied;
    if (input === null || typeof input !== 'object' || Array.isArray(input)) return this.refuse(viewer, { ok: false, rule: null, code: 'bad_shape' });
    const raw = input as Record<string, unknown>;
    if (Object.keys(raw).some((k) => !(AGENT_COST_SETTINGS_FIELDS as readonly string[]).includes(k))) return this.refuse(viewer, { ok: false, rule: null, code: 'unknown_field' });
    if (!isMonth(raw.validFrom)) return this.refuse(viewer, { ok: false, rule: null, code: 'bad_month' });
    if (raw.validFrom < parisMonth(this.now())) return this.refuse(viewer, { ok: false, rule: 'R624', code: 'mois_passe' });
    if (!isBp(raw.provisionBp) || !isBp(raw.marginBp)) return this.refuse(viewer, { ok: false, rule: 'R624', code: 'bad_bp' });
    const reason = typeof raw.reason === 'string' ? raw.reason.trim().replace(/\s+/g, ' ') : '';
    if (reason.length < 3 || reason.length > 200) return this.refuse(viewer, { ok: false, rule: null, code: 'bad_reason' });
    const last = await this.db.first<{ version: number | null }>('SELECT MAX(version) AS version FROM agent_cost_settings WHERE network_id = ?', [viewer.networkId]);
    const version = Number(last?.version ?? 0) + 1;
    try {
      await this.db.run('INSERT INTO agent_cost_settings (network_id, version, valid_from, provision_bp, margin_bp, reason, set_by, set_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [
        viewer.networkId,
        version,
        raw.validFrom,
        raw.provisionBp,
        raw.marginBp,
        reason,
        this.actor(viewer),
        this.now().toISOString(),
      ]);
    } catch {
      return this.refuse(viewer, { ok: false, rule: 'R624', code: 'conflit' });
    }
    await appendEvent(this.journal, { type: 'cout_agent.reglage_range', actor: this.actor(viewer), subject: `network:${viewer.networkId}`, data: { version, validFrom: raw.validFrom, provisionBp: raw.provisionBp, marginBp: raw.marginBp } }, this.now);
    return { ok: true, value: { version, validFrom: raw.validFrom, provisionBp: raw.provisionBp, marginBp: raw.marginBp } };
  }

  /** Le coût complet de l'agent moyen d'un mois fini de Paris, et s'il est couvert, pour la direction seule [R623 à R625]. */
  async month(viewer: Viewer, month: unknown): Promise<{ ok: true; value: AgentCostMonth } | CoutAgentRefusal> {
    const denied = await this.direction(viewer, 'agent_cost_month');
    if (denied) return denied;
    if (!isMonth(month)) return this.refuse(viewer, { ok: false, rule: null, code: 'bad_month' });
    if (month >= parisMonth(this.now())) return this.refuse(viewer, { ok: false, rule: 'R624', code: 'month_not_finished' });
    const net = viewer.networkId;
    const [start, end] = monthBounds(month);

    // Le réglage qui vaut pour le mois : la version la plus haute dont le premier mois est atteint.
    const s = await this.db.first<{ version: number; valid_from: string; provision_bp: number; margin_bp: number }>(
      'SELECT version, valid_from, provision_bp, margin_bp FROM agent_cost_settings WHERE network_id = ? AND valid_from <= ? ORDER BY version DESC LIMIT 1',
      [net, month],
    );
    const settings: AgentCostSettings | null = s ? { version: Number(s.version), validFrom: s.valid_from, provisionBp: Number(s.provision_bp), marginBp: Number(s.margin_bp) } : null;

    // Les commissions encaissées dans le mois, chacune avec ses parts ; la part d'une agence partenaire sort des honoraires.
    const files = await this.db.all<{ file_id: string; fee_cents: number; agency: number | null; reseau: number | null; agents: number | null }>(
      `SELECT c.file_id, c.fee_cents,
              (SELECT g.amount_cents FROM commission_agency_shares g WHERE g.file_id = c.file_id) AS agency,
              (SELECT SUM(x.amount_cents) FROM commission_shares x WHERE x.file_id = c.file_id AND x.kind = 'reseau') AS reseau,
              (SELECT SUM(x.amount_cents) FROM commission_shares x WHERE x.file_id = c.file_id AND x.kind IN ('agent', 'partage')) AS agents
         FROM commission_receipts r JOIN commissions c ON c.file_id = r.file_id AND c.network_id = r.network_id
        WHERE r.network_id = ? AND r.received_at >= ? AND r.received_at < ?
        ORDER BY r.received_at, c.file_id`,
      [net, start, end],
    );
    const fileLines = files.map((f) => ({
      fileId: f.file_id,
      feesCents: Number(f.fee_cents) - Number(f.agency ?? 0),
      networkShareCents: Number(f.reseau ?? 0),
      agentSharesCents: Number(f.agents ?? 0),
    }));

    // Les factures fournisseurs du mois (jour d'émission), chacune avec son dernier classement.
    const invoices = await this.db.all<{ id: string; ht_cents: number; category: CostAssignmentCategory | null }>(
      `SELECT i.id, i.ht_cents,
              (SELECT a.category FROM agent_cost_assignments a WHERE a.invoice_id = i.id ORDER BY a.version DESC LIMIT 1) AS category
         FROM supplier_invoices i
        WHERE i.network_id = ? AND i.issued_on >= ? AND i.issued_on < ?
        ORDER BY i.issued_on, i.id`,
      [net, `${month}-01`, `${nextMonth(month)}-01`],
    );
    const unclassified = invoices.filter((i) => i.category === null).map((i) => i.id);
    const invoiceLines = invoices.filter((i) => i.category !== null).map((i) => ({ invoiceId: i.id, category: i.category as CostAssignmentCategory, htCents: Number(i.ht_cents) }));

    // Les agents présents : entrés avant la fin du mois, sans départ maintenu avant son premier jour.
    const present = await this.db.first<{ n: number }>(
      `SELECT COUNT(*) AS n FROM agents a
        WHERE a.network_id = ? AND a.created_at < ?
          AND NOT EXISTS (SELECT 1 FROM agent_departures d WHERE d.agent_id = a.id AND d.network_id = a.network_id AND d.cancelled_at IS NULL AND d.leaves_on < ?)`,
      [net, end, `${month}-01`],
    );
    const ai = await this.db.first<{ c: number | null }>('SELECT SUM(cost_cents) AS c FROM messages WHERE network_id = ? AND occurred_at >= ? AND occurred_at < ?', [net, start, end]);

    const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);
    const costs = Object.fromEntries(AGENT_COST_CATEGORIES.map((c) => [c, sum(invoiceLines.filter((l) => l.category === c).map((l) => l.htCents))])) as Record<AgentCostCategory, number>;
    const feesCents = sum(fileLines.map((f) => f.feesCents));
    const networkShareCents = sum(fileLines.map((f) => f.networkShareCents));
    const agentSharesCents = sum(fileLines.map((f) => f.agentSharesCents));
    const provisionCents = settings ? bpOf(agentSharesCents, settings.provisionBp) : 0;
    const fullCostCents = sum(Object.values(costs)) + provisionCents;
    const marginCents = settings ? bpOf(fullCostCents, settings.marginBp) : 0;
    const requiredCents = fullCostCents + marginCents;
    const agentsPresent = Number(present?.n ?? 0);
    const missing: AgentCostMonth['missing'] = [];
    if (!settings) missing.push('reglage');
    if (unclassified.length > 0) missing.push('factures_non_classees');
    const complete = missing.length === 0;

    const value: AgentCostMonth = {
      month,
      complete,
      missing,
      settings,
      agentsPresent,
      feesCents,
      networkShareCents,
      agentSharesCents,
      costs,
      provisionCents,
      fullCostCents,
      marginCents,
      requiredCents,
      averageAgent: agentsPresent > 0 ? { networkShareCents: Math.floor(networkShareCents / agentsPresent), requiredCents: Math.floor(requiredCents / agentsPresent) } : null,
      covered: complete && networkShareCents >= requiredCents,
      networkBp: feesCents > 0 ? Math.floor((networkShareCents * 10_000) / feesCents) : null,
      breakEvenNetworkBp: complete ? breakEvenBp(requiredCents, feesCents) : null,
      aiMeasuredCents: Number(ai?.c ?? 0),
      lines: { files: fileLines, invoices: invoiceLines, unclassified },
    };
    // La lecture est écrite au journal avant d'être rendue [R16].
    await appendEvent(this.journal, { type: 'cout_agent.mois_lu', actor: this.actor(viewer), subject: `network:${net}`, data: { rule: 'R16', month, complete, covered: value.covered } }, this.now);
    return { ok: true, value };
  }
}
