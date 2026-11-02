/**
 * Cycle de la commission (M13, K01) [R16, R17, R18, R63, R67, R68, R69].
 *
 * Une commission par dossier de vente, calculée par le code, jamais saisie :
 * - « prévue » dès que le compromis signé est saisi (N02) : les honoraires du mandat en vigueur ce jour-là, avenants
 *   compris, tels qu'au document signé (`mandateFeeAt`, partagé avec l'acte de N06), et la grille du réseau en vigueur
 *   au jour du compromis ;
 * - « due » à l'acte signé rapporté par N06, avec la preuve du notaire, si les honoraires sont restés les mêmes ;
 * - « facturée » (K02), puis « payée » (K03), chacune avec sa preuve, dans cet ordre, une seule fois.
 *
 * Les parts, en centimes, dont la somme est toujours les honoraires : la part de l'agent selon la grille (son taux, ou
 * celui du réseau), dont il cède une partie à un agent qui partage (fichier commun, binôme d'une absence) ; la prime
 * de parrainage, prise sur la part du réseau ; le reste au réseau. Décidé, lecture prudente : chaque part est arrondie
 * au centime inférieur, le reste va au réseau, pour qu'un agent ne reçoive jamais un centime qui n'est pas calculé ;
 * le partage et le parrainage viennent de M14 par des interfaces, sans rien tant qu'elles ne sont pas branchées ; une
 * commission prévue ne change plus, même si la grille change ; une grille ne vaut jamais pour le passé (son premier
 * jour est au plus tôt celui où elle est réglée), pour qu'une vente ait le même calcul quel que soit le moment du
 * passage ; une différence d'honoraires, de mandat ou de jour du compromis à l'acte n'est jamais corrigée par le
 * code : la commission reste prévue, l'écart va au journal, la direction tranche. Un dossier qui ne peut pas être
 * calculé (sans agent, sans mandat en vigueur, sans grille, partage faux) est dit une fois au journal, sans montant.
 */
import type { Acces } from '../acces/acces.ts';
import { ROLES, decideAccess, type Viewer } from '../acces/droits.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { Diffusion } from '../documents/retractation.ts';
import { mandateFeeAt } from '../dossiers/acte.ts';
import { localTime } from '../envoi/horaires.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';

export const COMMISSION_STATUSES = ['prevue', 'due', 'facturee', 'payee'] as const;
export type CommissionStatus = (typeof COMMISSION_STATUSES)[number];

export interface ShareSplit {
  agentId: string;
  /** La part cédée de la part de l'agent, en points de base (5 000 = la moitié). */
  ratioBp: number;
  reason: 'fichier_commun' | 'binome';
}

/** Les partages d'une vente entre agents (M14) : fichier commun, binôme pendant une absence. */
export interface PartagesCommission {
  of(networkId: string, fileId: string, agentId: string): Promise<readonly ShareSplit[]>;
}

/** La prime de parrainage due sur une vente de l'agent, selon la grille de M14 [R83] ; `null` sans parrain. */
export interface PrimesParrainage {
  of(networkId: string, agentId: string, networkShareCents: number): Promise<{ parrainId: string; amountCents: number } | null>;
}

export interface CommissionShare {
  kind: 'reseau' | 'agent' | 'partage' | 'parrainage';
  beneficiaryId: string | null;
  reason: 'fichier_commun' | 'binome' | null;
  amountCents: number;
}

/**
 * Les parts d'honoraires, en centimes. Fonction pure : la même pour les mêmes données [R69]. La somme des parts est
 * toujours `feeCents`.
 */
export function computeShares(
  feeCents: number,
  agentId: string,
  agentRateBp: number,
  splits: readonly ShareSplit[] = [],
  prime: { parrainId: string; amountCents: number } | null = null,
): CommissionShare[] {
  if (!Number.isInteger(feeCents) || feeCents < 0) throw new Error('Honoraires en centimes entiers attendus.');
  if (!Number.isInteger(agentRateBp) || agentRateBp < 0 || agentRateBp > 10_000) throw new Error('Taux de la grille hors bornes.');
  const agentTotal = Math.floor((feeCents * agentRateBp) / 10_000);
  const given = splits.map((s) => {
    if (!Number.isInteger(s.ratioBp) || s.ratioBp < 0 || s.ratioBp > 10_000) throw new Error('Partage hors bornes.');
    return { ...s, amount: Math.floor((agentTotal * s.ratioBp) / 10_000) };
  });
  const givenTotal = given.reduce((a, g) => a + g.amount, 0);
  if (givenTotal > agentTotal) throw new Error('Les partages dépassent la part de l’agent.');
  const networkBefore = feeCents - agentTotal;
  const primeCents = prime ? Math.max(0, Math.min(Math.floor(prime.amountCents), networkBefore)) : 0;
  const shares: CommissionShare[] = [
    { kind: 'reseau', beneficiaryId: null, reason: null, amountCents: networkBefore - primeCents },
    { kind: 'agent', beneficiaryId: agentId, reason: null, amountCents: agentTotal - givenTotal },
    ...given.map((g) => ({ kind: 'partage' as const, beneficiaryId: g.agentId, reason: g.reason, amountCents: g.amount })),
  ];
  if (prime && primeCents > 0) shares.push({ kind: 'parrainage', beneficiaryId: prime.parrainId, reason: null, amountCents: primeCents });
  return shares;
}

export interface GridInput {
  validFrom: string;
  defaultRateBp: number;
  agents?: { agentId: string; rateBp: number }[];
}

export interface CommissionView {
  fileId: string;
  /** L'agent de la vente, les honoraires et qui les paie : pour la direction et l'agent de la vente ;
   * `null` pour un agent qui n'a qu'une part de partage ou de parrainage [R68]. */
  agentId: string | null;
  compromisOn: string;
  feeCents: number | null;
  feeCharge: 'vendeur' | 'acquereur' | null;
  status: CommissionStatus;
  steps: { status: CommissionStatus; at: string }[];
  /** Pour un agent : ses seules parts [R68] ; pour la direction : toutes. */
  shares: CommissionShare[];
  /** L'encaissement rapporté, l'échéance des 24 h ouvrées et le versement, sans preuve ni montant [R70]. */
  payment: { receivedAt: string; payoutDueAt: string; paidAt: string | null; late: boolean | null } | null;
  /** Vente annulée par un avoir : plus rien ne s'encaisse ni ne se verse [R71]. */
  cancelled: boolean;
}

/** Une vente que le passage n'arrive pas à faire avancer : la direction tranche [R63, R67]. Sans montant ni nom [R13]. */
export interface CommissionBlocked {
  fileId: string;
  code: string;
}

export type CommissionRefusal = { ok: false; rule: 'R16'; code: string };
type GridProblem = { ok: false; rule: null; code: 'bad_day' | 'past_day' | 'bad_rate' | 'unknown_agent' | 'duplicate_agent' };

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const validDay = (v: unknown): v is string => {
  if (typeof v !== 'string' || !DAY.test(v)) return false;
  const d = new Date(`${v}T12:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
};
const validRate = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 10_000;
const PROOF = /^[A-Za-z0-9_:./-]{1,200}$/;

export class Commissions {
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly diffusion: Diffusion;
  private readonly partages: PartagesCommission | null;
  private readonly primes: PrimesParrainage | null;

  constructor(
    private readonly db: SqlDatabase,
    acces: Acces,
    private readonly journal: JournalStore,
    options: { now?: () => Date; newId?: () => string; partages?: PartagesCommission | null; primes?: PrimesParrainage | null } = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => crypto.randomUUID());
    this.diffusion = new Diffusion(db, acces, journal, { now: this.now });
    this.partages = options.partages ?? null;
    this.primes = options.primes ?? null;
  }

  private actor(viewer: Viewer): string {
    return `${String(viewer.role)}:${viewer.userId}`;
  }

  private async refuse(viewer: Viewer, kind: string, code: string): Promise<CommissionRefusal> {
    await appendEvent(this.journal, { type: 'acces.refuse', actor: this.actor(viewer), subject: `network:${viewer.networkId}`, data: { rule: 'R16', role: String(viewer.role), kind, code } }, this.now);
    return { ok: false, rule: 'R16', code };
  }

  /** Un rôle connu ; pour un agent, un agent actif de ce réseau. */
  private async readerRefusal(viewer: Viewer): Promise<string | null> {
    if (!(ROLES as readonly string[]).includes(viewer.role)) return 'role';
    // Les chiffres, selon les droits du socle : la direction ; ni la conformité ni un partenaire [R16].
    if (viewer.role !== 'agent') {
      const d = decideAccess(viewer, { kind: 'figures', networkId: viewer.networkId, agentId: viewer.userId });
      return d.allowed ? null : d.code;
    }
    const agent = await this.db.first<{ network_id: string; status: string }>('SELECT network_id, status FROM agents WHERE id = ?', [viewer.userId]);
    return !agent || agent.network_id !== viewer.networkId || agent.status !== 'active' ? 'agent_inactive' : null;
  }

  /** La grille du réseau : la direction seule la règle ; une nouvelle version s'ajoute, rien ne change [R16, R17]. */
  async setGrid(viewer: Viewer, input: GridInput): Promise<{ ok: true; version: number } | CommissionRefusal | GridProblem> {
    if (viewer.role !== 'direction') return this.refuse(viewer, 'commission_grid', 'role');
    if (!validDay(input.validFrom)) return { ok: false, rule: null, code: 'bad_day' };
    if (input.validFrom < localTime(this.now(), 'Europe/Paris').date) return { ok: false, rule: null, code: 'past_day' };
    if (!validRate(input.defaultRateBp)) return { ok: false, rule: null, code: 'bad_rate' };
    const agents = input.agents ?? [];
    if (!Array.isArray(agents)) return { ok: false, rule: null, code: 'bad_rate' };
    const seen = new Set<string>();
    for (const a of agents) {
      if (!a || typeof a.agentId !== 'string' || !validRate(a.rateBp)) return { ok: false, rule: null, code: 'bad_rate' };
      if (seen.has(a.agentId)) return { ok: false, rule: null, code: 'duplicate_agent' };
      seen.add(a.agentId);
      const row = await this.db.first<{ network_id: string }>('SELECT network_id FROM agents WHERE id = ?', [a.agentId]);
      if (!row || row.network_id !== viewer.networkId) return { ok: false, rule: null, code: 'unknown_agent' };
    }
    const last = await this.db.first<{ v: number | null }>('SELECT MAX(version) AS v FROM commission_grids WHERE network_id = ?', [viewer.networkId]);
    const version = (last?.v ?? 0) + 1;
    const id = this.newId();
    // Une seule écriture : une grille n'existe jamais sans ses taux d'agents.
    await this.db.run('INSERT INTO commission_grids (id, network_id, version, valid_from, default_rate_bp, agent_rates, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [
      id,
      viewer.networkId,
      version,
      input.validFrom,
      input.defaultRateBp,
      JSON.stringify(Object.fromEntries(agents.map((a) => [a.agentId, a.rateBp]))),
      this.actor(viewer),
      this.now().toISOString(),
    ]);
    await appendEvent(this.journal, { type: 'commission.grille', actor: this.actor(viewer), subject: `network:${viewer.networkId}`, data: { version, validFrom: input.validFrom } }, this.now);
    return { ok: true, version };
  }

  /** La grille en vigueur pour un compromis de ce jour : la dernière version applicable à ce jour. */
  private async gridAt(networkId: string, day: string): Promise<{ id: string; default_rate_bp: number; agent_rates: string } | null> {
    return this.db.first<{ id: string; default_rate_bp: number; agent_rates: string }>('SELECT id, default_rate_bp, agent_rates FROM commission_grids WHERE network_id = ? AND valid_from <= ? ORDER BY valid_from DESC, version DESC LIMIT 1', [
      networkId,
      day,
    ]);
  }

  private rateOf(grid: { default_rate_bp: number; agent_rates: string }, agentId: string): number {
    const rates = JSON.parse(grid.agent_rates) as Record<string, number>;
    return Object.hasOwn(rates, agentId) ? rates[agentId]! : grid.default_rate_bp;
  }

  /** Un dossier qui attend : dit une fois au journal par dossier et par raison, sans montant ni nom [R13]. */
  private async waiting(fileId: string, type: 'commission.attente' | 'commission.ecart', code: string): Promise<void> {
    const seen = (await this.journal.bySubject(`sale_file:${fileId}`)).some((e) => e.type === type && e.data.code === code);
    if (!seen) await appendEvent(this.journal, { type, actor: 'system:pilotage', subject: `sale_file:${fileId}`, data: { rule: 'R67', code } }, this.now);
  }

  /**
   * Le passage d'un réseau : une commission prévue pour chaque dossier au compromis signé, puis « due » pour chaque
   * acte rapporté. Rejoué, il n'ajoute rien [R18]. Rend le nombre de commissions prévues et dues ce passage.
   */
  async sync(networkId: string): Promise<{ planned: number; due: number }> {
    const at = this.now().toISOString();
    let planned = 0;
    const files = await this.db.all<{ id: string; property_id: string; agent_id: string | null; day: string; proof_ref: string }>(
      `SELECT f.id, f.property_id, p.agent_id, d.day, d.proof_ref FROM sale_files f
         JOIN properties p ON p.id = f.property_id
         JOIN sale_file_dates d ON d.file_id = f.id AND d.kind = 'compromis_signe'
           AND d.version = (SELECT MAX(version) FROM sale_file_dates WHERE file_id = f.id AND kind = 'compromis_signe')
       WHERE f.network_id = ? AND NOT EXISTS (SELECT 1 FROM commission_steps s WHERE s.file_id = f.id AND s.status = 'prevue')
       ORDER BY f.opened_at, f.id`,
      [networkId],
    );
    for (const f of files) {
      let row = await this.db.first<{ agent_id: string; fee_cents: number; grid_id: string }>('SELECT agent_id, fee_cents, grid_id FROM commissions WHERE file_id = ?', [f.id]);
      if (!row) {
        if (!f.agent_id) {
          await this.waiting(f.id, 'commission.attente', 'no_agent');
          continue;
        }
        const fee = await mandateFeeAt(this.db, this.diffusion, networkId, f.property_id, f.day);
        if (!fee.ok) {
          await this.waiting(f.id, 'commission.attente', fee.code);
          continue;
        }
        const grid = await this.gridAt(networkId, f.day);
        if (!grid) {
          await this.waiting(f.id, 'commission.attente', 'no_grid');
          continue;
        }
        await this.db.run(
          'INSERT INTO commissions (file_id, network_id, agent_id, mandate_id, compromis_on, fee_cents, fee_charge, grid_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (file_id) DO NOTHING',
          [f.id, networkId, f.agent_id, fee.mandateId, f.day, fee.feeEur * 100, fee.feeCharge, grid.id, at],
        );
        row = (await this.db.first<{ agent_id: string; fee_cents: number; grid_id: string }>('SELECT agent_id, fee_cents, grid_id FROM commissions WHERE file_id = ?', [f.id]))!;
      }
      // Les parts, en une seule écriture, seulement s'il n'y en a aucune : deux passages ou une reprise ne mêlent
      // jamais deux calculs.
      if (!(await this.db.first('SELECT 1 FROM commission_shares WHERE file_id = ?', [f.id]))) {
        const grid = (await this.db.first<{ default_rate_bp: number; agent_rates: string }>('SELECT default_rate_bp, agent_rates FROM commission_grids WHERE id = ?', [row.grid_id]))!;
        const rate = this.rateOf(grid, row.agent_id);
        let shares: CommissionShare[];
        try {
          const splits = this.partages ? await this.partages.of(networkId, f.id, row.agent_id) : [];
          const networkBefore = row.fee_cents - Math.floor((row.fee_cents * rate) / 10_000);
          const prime = this.primes ? await this.primes.of(networkId, row.agent_id, networkBefore) : null;
          shares = computeShares(row.fee_cents, row.agent_id, rate, splits, prime);
        } catch {
          await this.waiting(f.id, 'commission.attente', 'partage_invalide');
          continue;
        }
        const values = shares.map(() => '(?, ?, ?, ?, ?, ?)').join(', ');
        await this.db.run(
          `INSERT INTO commission_shares (file_id, seq, kind, beneficiary_id, reason, amount_cents)
           SELECT column1, column2, column3, column4, column5, column6 FROM (VALUES ${values})
           WHERE NOT EXISTS (SELECT 1 FROM commission_shares WHERE file_id = ?)`,
          [...shares.flatMap((sh, i) => [f.id, i + 1, sh.kind, sh.beneficiaryId, sh.reason, sh.amountCents]), f.id],
        );
      }
      // L'étape « prévue » seulement sur des parts qui font les honoraires, au centime [R69].
      const sum = (await this.db.first<{ n: number | null }>('SELECT SUM(amount_cents) AS n FROM commission_shares WHERE file_id = ?', [f.id]))?.n ?? 0;
      if (sum !== row.fee_cents) {
        await this.waiting(f.id, 'commission.ecart', 'parts');
        continue;
      }
      const { changes } = await this.db.run("INSERT INTO commission_steps (file_id, status, proof_ref, at, by) VALUES (?, 'prevue', ?, ?, 'system:pilotage') ON CONFLICT DO NOTHING", [f.id, f.proof_ref, at]);
      if (changes === 1) {
        planned += 1;
        // Au journal : le dossier et le statut, jamais un montant ni un nom [R13].
        await appendEvent(this.journal, { type: 'commission.etape', actor: 'system:pilotage', subject: `sale_file:${f.id}`, data: { rule: 'R67', status: 'prevue' } }, this.now);
      }
    }
    // Une commission rangée sans ses parts ou sans son étape (coupure) n'est pas encore prévue : la boucle la reprend.
    let due = 0;
    const closed = await this.db.all<{ file_id: string; fee_eur: number; mandate_id: string; proof_ref: string }>(
      `SELECT k.file_id, k.fee_eur, k.mandate_id, c.proof_ref FROM sale_commissions k JOIN sale_file_closings c ON c.file_id = k.file_id
       WHERE k.network_id = ? AND NOT EXISTS (SELECT 1 FROM commission_steps s WHERE s.file_id = k.file_id AND s.status = 'due')
         AND EXISTS (SELECT 1 FROM commission_steps s WHERE s.file_id = k.file_id AND s.status = 'prevue')
       ORDER BY k.due_on, k.file_id`,
      [networkId],
    );
    for (const k of closed) {
      const c = (await this.db.first<{ fee_cents: number; mandate_id: string; compromis_on: string }>('SELECT fee_cents, mandate_id, compromis_on FROM commissions WHERE file_id = ?', [k.file_id]))!;
      const latest = await this.db.first<{ day: string }>("SELECT day FROM sale_file_dates WHERE file_id = ? AND kind = 'compromis_signe' ORDER BY version DESC LIMIT 1", [k.file_id]);
      // Jamais corrigé par le code : la direction tranche [R63]. Dit une fois par raison.
      if (c.fee_cents !== k.fee_eur * 100) {
        await this.waiting(k.file_id, 'commission.ecart', 'honoraires');
        continue;
      }
      if (c.mandate_id !== k.mandate_id) {
        await this.waiting(k.file_id, 'commission.ecart', 'mandat');
        continue;
      }
      if (latest?.day !== c.compromis_on) {
        await this.waiting(k.file_id, 'commission.ecart', 'compromis');
        continue;
      }
      const { changes } = await this.db.run("INSERT INTO commission_steps (file_id, status, proof_ref, at, by) VALUES (?, 'due', ?, ?, 'system:pilotage') ON CONFLICT DO NOTHING", [k.file_id, k.proof_ref, at]);
      if (changes === 1) {
        due += 1;
        await appendEvent(this.journal, { type: 'commission.etape', actor: 'system:pilotage', subject: `sale_file:${k.file_id}`, data: { rule: 'R67', status: 'due' } }, this.now);
      }
    }
    return { planned, due };
  }

  /**
   * « Facturée » (K02) ou « payée » (K03), avec sa preuve : seulement après l'étape précédente, une seule fois [R67].
   * Appelé par le code de K02 et K03, qui portent les droits de leurs routes.
   */
  async recordStep(networkId: string, fileId: string, status: 'facturee' | 'payee', proofRef: string, actor: string): Promise<{ ok: true } | { ok: false; rule: 'R67' | null; code: 'unknown' | 'bad_proof' | 'out_of_order' | 'already' }> {
    const c = await this.db.first<{ network_id: string }>('SELECT network_id FROM commissions WHERE file_id = ?', [fileId]);
    if (!c || c.network_id !== networkId) return { ok: false, rule: null, code: 'unknown' };
    if (typeof proofRef !== 'string' || !PROOF.test(proofRef)) return { ok: false, rule: null, code: 'bad_proof' };
    const before = status === 'facturee' ? 'due' : 'facturee';
    if (await this.db.first('SELECT 1 FROM commission_steps WHERE file_id = ? AND status = ?', [fileId, status])) return { ok: false, rule: null, code: 'already' };
    if (!(await this.db.first('SELECT 1 FROM commission_steps WHERE file_id = ? AND status = ?', [fileId, before]))) return { ok: false, rule: 'R67', code: 'out_of_order' };
    const { changes } = await this.db.run('INSERT INTO commission_steps (file_id, status, proof_ref, at, by) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING', [fileId, status, proofRef, this.now().toISOString(), actor]);
    if (changes !== 1) return { ok: false, rule: null, code: 'already' };
    await appendEvent(this.journal, { type: 'commission.etape', actor, subject: `sale_file:${fileId}`, data: { rule: 'R67', status } }, this.now);
    return { ok: true };
  }

  /**
   * Les ventes que le passage laisse de côté : compromis signé sans commission prévue, acte signé sans commission due.
   * La direction seule ; la raison est la dernière que le passage a dite au journal. Sans raison dite, le passage n'y est
   * pas encore allé : rien à trancher.
   */
  async blocked(viewer: Viewer): Promise<{ ok: true; value: CommissionBlocked[] } | CommissionRefusal> {
    if (viewer.role === 'agent') return this.refuse(viewer, 'commissions_blocked', 'role');
    const refusal = await this.readerRefusal(viewer);
    if (refusal) return this.refuse(viewer, 'commissions_blocked', refusal);
    const rows = await this.db.all<{ id: string }>(
      `SELECT f.id FROM sale_files f WHERE f.network_id = ?
         AND EXISTS (SELECT 1 FROM sale_file_dates d WHERE d.file_id = f.id AND d.kind = 'compromis_signe')
         AND NOT EXISTS (SELECT 1 FROM commission_steps s WHERE s.file_id = f.id AND s.status = 'prevue')
       UNION
       SELECT k.file_id FROM sale_commissions k WHERE k.network_id = ?
         AND EXISTS (SELECT 1 FROM sale_file_closings c WHERE c.file_id = k.file_id)
         AND EXISTS (SELECT 1 FROM commission_steps s WHERE s.file_id = k.file_id AND s.status = 'prevue')
         AND NOT EXISTS (SELECT 1 FROM commission_steps s WHERE s.file_id = k.file_id AND s.status = 'due')
       ORDER BY 1`,
      [viewer.networkId, viewer.networkId],
    );
    const value: CommissionBlocked[] = [];
    for (const r of rows) {
      const said = (await this.journal.bySubject(`sale_file:${r.id}`)).filter((e) => e.type === 'commission.attente' || e.type === 'commission.ecart').at(-1);
      if (said && typeof said.data.code === 'string') value.push({ fileId: r.id, code: said.data.code });
    }
    return { ok: true, value };
  }

  /**
   * Les commissions : un agent voit celles où il a une part, et seulement ses parts [R68] ; la direction voit tout le
   * réseau ; la conformité n'a pas les chiffres [R16].
   */
  async list(viewer: Viewer): Promise<{ ok: true; value: CommissionView[] } | CommissionRefusal> {
    const refusal = await this.readerRefusal(viewer);
    if (refusal) return this.refuse(viewer, 'commissions', refusal);
    const own = viewer.role === 'agent';
    const rows = await this.db.all<{ file_id: string; agent_id: string; compromis_on: string; fee_cents: number; fee_charge: 'vendeur' | 'acquereur' | null }>(
      `SELECT c.file_id, c.agent_id, c.compromis_on, c.fee_cents, c.fee_charge FROM commissions c
       WHERE c.network_id = ?${own ? ' AND EXISTS (SELECT 1 FROM commission_shares s WHERE s.file_id = c.file_id AND s.beneficiary_id = ?)' : ''}
         AND EXISTS (SELECT 1 FROM commission_steps s WHERE s.file_id = c.file_id)
       ORDER BY c.compromis_on, c.file_id`,
      own ? [viewer.networkId, viewer.userId] : [viewer.networkId],
    );
    const value: CommissionView[] = [];
    for (const r of rows) {
      const steps = await this.db.all<{ status: CommissionStatus; at: string }>('SELECT status, at FROM commission_steps WHERE file_id = ?', [r.file_id]);
      steps.sort((a, b) => COMMISSION_STATUSES.indexOf(a.status) - COMMISSION_STATUSES.indexOf(b.status));
      const shares = (
        await this.db.all<{ kind: CommissionShare['kind']; beneficiary_id: string | null; reason: CommissionShare['reason']; amount_cents: number }>(
          'SELECT kind, beneficiary_id, reason, amount_cents FROM commission_shares WHERE file_id = ? ORDER BY seq',
          [r.file_id],
        )
      )
        .filter((s) => !own || s.beneficiary_id === viewer.userId)
        .map((s) => ({ kind: s.kind, beneficiaryId: s.beneficiary_id, reason: s.reason, amountCents: s.amount_cents }));
      const whole = !own || r.agent_id === viewer.userId;
      const receipt = await this.db.first<{ received_at: string; payout_due_at: string }>('SELECT received_at, payout_due_at FROM commission_receipts WHERE file_id = ?', [r.file_id]);
      const payout = await this.db.first<{ paid_at: string }>('SELECT paid_at FROM commission_payouts WHERE file_id = ?', [r.file_id]);
      const cancelled = await this.db.first("SELECT 1 FROM invoices WHERE file_id = ? AND kind = 'avoir' AND json_extract(content, '$.reason') = 'vente_annulee'", [r.file_id]);
      value.push({
        fileId: r.file_id,
        agentId: whole ? r.agent_id : null,
        compromisOn: r.compromis_on,
        feeCents: whole ? r.fee_cents : null,
        feeCharge: whole ? r.fee_charge : null,
        status: steps.at(-1)!.status,
        steps,
        shares,
        payment: receipt
          ? {
              receivedAt: receipt.received_at,
              payoutDueAt: receipt.payout_due_at,
              paidAt: payout?.paid_at ?? null,
              late: payout ? Date.parse(payout.paid_at) > Date.parse(receipt.payout_due_at) : null,
            }
          : null,
        cancelled: !!cancelled,
      });
    }
    await appendEvent(this.journal, { type: 'commission.lecture', actor: this.actor(viewer), subject: `network:${viewer.networkId}`, data: { count: value.length } }, this.now);
    return { ok: true, value };
  }
}
