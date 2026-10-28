/**
 * Parrainage dans les règles (M14, J10) [R83].
 *
 * Le parrain d'un agent est rangé à son entrée, une seule fois, par la direction, et jamais après la première
 * commission de l'agent. La prime de parrainage est calculée par le code sur la part du réseau de chaque commission du
 * filleul, au taux réglé par la direction, sur le nombre de niveaux réglé : 1, tant que l'avocat n'en a pas fixé un
 * autre (H09) ; au-delà, aucune prime. Sans taux réglé, aucune prime.
 *
 * `Parrainage` répond à l'interface `PrimesParrainage` de M13 : la prime entre dans les parts de la commission prévue
 * (K01), elle n'est facturée qu'après l'encaissement (K02, K03). Au parrain, elle n'est montrée qu'une fois la
 * commission réellement encaissée, et retirée si un avoir annule la facture d'honoraires : jamais à l'arrivée d'un
 * agent, jamais promise d'avance. Un parrain parti ne touche rien de nouveau. Aucun frais d'entrée nulle part. Aucun
 * texte de parrainage ne promet de revenus [R80].
 */
import type { Viewer } from '../acces/droits.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import type { PrimesParrainage } from '../pilotage/commissions.ts';

/** Le nombre de niveaux permis tant que l'avocat n'en a pas fixé un autre (H09). */
export const REFERRAL_MAX_LEVELS = 1;
/** Plafond du taux réglable, en points de base de la part du réseau. */
export const REFERRAL_MAX_RATE_BP = 5000;

/** Ce que l'agent lit sur le parrainage : sans promesse ni montant d'avance [R80]. */
export const REFERRAL_TEXT =
  'Le parrainage est sans frais d’entrée. Une prime n’est due qu’après une commission réellement encaissée par la personne que vous avez présentée, au taux écrit par la direction. Rien n’est dû à son arrivée.';

export type ReferralRefusal = { ok: false; rule: 'R16' | 'R83' | null; code: string };

export interface ReferralPrime {
  fileId: string;
  agentId: string;
  amountCents: number;
  receivedAt: string;
}

export class Parrainage implements PrimesParrainage {
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(
    private readonly db: SqlDatabase,
    private readonly journal: JournalStore,
    options: { now?: () => Date; newId?: () => string } = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => crypto.randomUUID());
  }

  private actor(viewer: Viewer): string {
    return `${String(viewer.role)}:${viewer.userId}`;
  }

  private async refuse(viewer: Viewer, subject: string | null, code: string): Promise<ReferralRefusal> {
    await appendEvent(this.journal, { type: 'acces.refuse', actor: this.actor(viewer), subject, data: { rule: 'R16', role: String(viewer.role), kind: 'referral', code } }, this.now);
    return { ok: false, rule: 'R16', code };
  }

  private async status(networkId: string, agentId: unknown): Promise<string | null> {
    if (typeof agentId !== 'string') return null;
    return (await this.db.first<{ status: string }>('SELECT status FROM agents WHERE id = ? AND network_id = ?', [agentId, networkId]))?.status ?? null;
  }

  /**
   * Le parrain d'un agent : celui déclaré à sa création (depuis sa candidature), sinon celui rangé par la direction à
   * son entrée. Les deux ne peuvent jamais se contredire (`recordSponsor` le refuse).
   */
  async sponsorOf(networkId: string, agentId: string): Promise<string | null> {
    const declared = await this.db.first<{ sponsor_agent_id: string | null }>('SELECT sponsor_agent_id FROM agents WHERE id = ? AND network_id = ?', [agentId, networkId]);
    if (declared?.sponsor_agent_id) return declared.sponsor_agent_id;
    return (await this.db.first<{ sponsor_id: string }>('SELECT sponsor_id FROM sponsorships WHERE agent_id = ? AND network_id = ?', [agentId, networkId]))?.sponsor_id ?? null;
  }

  /** La direction règle le taux (sur la part du réseau) et le nombre de niveaux ; plus d'un niveau est refusé [R83]. */
  async setRules(viewer: Viewer, input: { rateBp: unknown; levels?: unknown }): Promise<{ ok: true } | ReferralRefusal> {
    if (viewer.role !== 'direction') return this.refuse(viewer, null, 'role');
    if (!Number.isInteger(input.rateBp) || (input.rateBp as number) < 0 || (input.rateBp as number) > REFERRAL_MAX_RATE_BP) return { ok: false, rule: null, code: 'invalid_rate' };
    const levels = input.levels ?? 1;
    if (!Number.isInteger(levels) || (levels as number) < 1) return { ok: false, rule: null, code: 'invalid_levels' };
    if ((levels as number) > REFERRAL_MAX_LEVELS) return { ok: false, rule: 'R83', code: 'levels_not_allowed' };
    await this.db.run('INSERT INTO referral_settings (id, network_id, rate_bp, levels, written_by, written_at) VALUES (?, ?, ?, ?, ?, ?)', [
      this.newId(),
      viewer.networkId,
      input.rateBp as number,
      levels as number,
      this.actor(viewer),
      this.now().toISOString(),
    ]);
    await appendEvent(this.journal, { type: 'parrainage.regle', actor: this.actor(viewer), subject: null, data: { rateBp: input.rateBp as number, levels: levels as number } }, this.now);
    return { ok: true };
  }

  private async rules(networkId: string): Promise<{ rateBp: number; levels: number } | null> {
    const row = await this.db.first<{ rate_bp: number; levels: number }>(
      'SELECT rate_bp, levels FROM referral_settings WHERE network_id = ? AND written_at <= ? ORDER BY written_at DESC, rowid DESC LIMIT 1',
      [networkId, this.now().toISOString()],
    );
    return row ? { rateBp: row.rate_bp, levels: row.levels } : null;
  }

  /**
   * La direction range le parrain d'un agent, une seule fois, à son entrée : jamais après une commission de l'agent,
   * jamais un parrain parti, jamais une boucle de parrainage.
   */
  async recordSponsor(viewer: Viewer, agentId: string, sponsorId: unknown): Promise<{ ok: true } | ReferralRefusal> {
    if (viewer.role !== 'direction') return this.refuse(viewer, `agent:${agentId}`, 'role');
    if ((await this.status(viewer.networkId, agentId)) !== 'active') return { ok: false, rule: null, code: 'unknown_agent' };
    if (sponsorId === agentId || (await this.status(viewer.networkId, sponsorId)) !== 'active') return { ok: false, rule: null, code: 'invalid_sponsor' };
    const sponsor = sponsorId as string;
    const declared = (await this.db.first<{ sponsor_agent_id: string | null }>('SELECT sponsor_agent_id FROM agents WHERE id = ?', [agentId]))?.sponsor_agent_id ?? null;
    if (declared !== null && declared !== sponsor) return { ok: false, rule: 'R83', code: 'other_sponsor_declared' };
    // Pas de boucle : le parrain n'a pas l'agent parmi ses parrains.
    let cursor: string | null = sponsor;
    for (let depth = 0; cursor !== null && depth < 100; depth += 1) {
      if (cursor === agentId) return { ok: false, rule: null, code: 'loop' };
      cursor = await this.sponsorOf(viewer.networkId, cursor);
    }
    const sold = await this.db.first('SELECT 1 AS ok FROM commissions WHERE network_id = ? AND agent_id = ? LIMIT 1', [viewer.networkId, agentId]);
    if (sold) return { ok: false, rule: 'R83', code: 'after_first_commission' };
    const { changes } = await this.db.run('INSERT INTO sponsorships (agent_id, network_id, sponsor_id, recorded_by, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING', [
      agentId,
      viewer.networkId,
      sponsor,
      this.actor(viewer),
      this.now().toISOString(),
    ]);
    if (changes !== 1) return { ok: false, rule: null, code: 'already_recorded' };
    await appendEvent(this.journal, { type: 'parrainage.parrain', actor: this.actor(viewer), subject: `agent:${agentId}`, data: { sponsor: `agent:${sponsor}` } }, this.now);
    return { ok: true };
  }

  /**
   * La prime sur une commission du filleul, pour M13 : le parrain direct seulement (un niveau), actif, au taux réglé,
   * sur la part du réseau, arrondie au centime inférieur. `null` sans parrain, parrain parti, sans taux ou à 0.
   */
  async of(networkId: string, agentId: string, networkShareCents: number): Promise<{ parrainId: string; amountCents: number } | null> {
    if (!Number.isInteger(networkShareCents) || networkShareCents <= 0) return null;
    const sponsorId = await this.sponsorOf(networkId, agentId);
    if (!sponsorId) return null;
    if ((await this.status(networkId, sponsorId)) !== 'active') return null;
    const rules = await this.rules(networkId);
    if (!rules || rules.rateBp === 0 || rules.levels < 1) return null;
    const amountCents = Math.floor((networkShareCents * rules.rateBp) / 10_000);
    return amountCents > 0 ? { parrainId: sponsorId, amountCents } : null;
  }

  /**
   * Les primes du parrain : seulement sur les commissions de ses filleuls réellement encaissées, et dont la facture
   * d'honoraires n'est pas annulée par un avoir. Lues par le parrain lui-même et par la direction [R16].
   */
  async primesOf(viewer: Viewer, sponsorId: string): Promise<{ ok: true; value: { primes: ReferralPrime[]; totalCents: number; text: string } } | ReferralRefusal> {
    const allowed = viewer.role === 'direction' || (viewer.role === 'agent' && viewer.userId === sponsorId);
    if (!allowed) return this.refuse(viewer, `agent:${sponsorId}`, viewer.role === 'agent' ? 'not_assigned' : 'role');
    const rows = await this.db.all<{ file_id: string; agent_id: string; amount_cents: number; received_at: string }>(
      `SELECT s.file_id, c.agent_id, s.amount_cents, r.received_at
       FROM commission_shares s
       JOIN commissions c ON c.file_id = s.file_id
       JOIN commission_receipts r ON r.file_id = s.file_id
       WHERE s.kind = 'parrainage' AND s.beneficiary_id = ? AND c.network_id = ? AND s.amount_cents > 0
       ORDER BY r.received_at, s.file_id`,
      [sponsorId, viewer.networkId],
    );
    // Un parrain parti ne touche rien de nouveau : seules restent les primes déjà reversées avant son départ.
    const left = (await this.status(viewer.networkId, sponsorId)) !== 'active';
    const primes: ReferralPrime[] = [];
    for (const r of rows) {
      if (await this.cancelled(r.file_id)) continue;
      if (left && !(await this.db.first('SELECT 1 AS ok FROM commission_payouts WHERE file_id = ?', [r.file_id]))) continue;
      primes.push({ fileId: r.file_id, agentId: r.agent_id, amountCents: r.amount_cents, receivedAt: r.received_at });
    }
    return { ok: true, value: { primes, totalCents: primes.reduce((a, p) => a + p.amountCents, 0), text: REFERRAL_TEXT } };
  }

  /**
   * Les primes figées au compromis mais à ne pas reverser : parrain parti avant le reversement, ou facture annulée.
   * Pour M13 (J13), qui les garde au réseau.
   */
  async withheld(networkId: string): Promise<{ fileId: string; sponsorId: string; amountCents: number }[]> {
    const rows = await this.db.all<{ file_id: string; beneficiary_id: string; amount_cents: number }>(
      `SELECT s.file_id, s.beneficiary_id, s.amount_cents FROM commission_shares s JOIN commissions c ON c.file_id = s.file_id
       WHERE s.kind = 'parrainage' AND c.network_id = ? AND s.amount_cents > 0
       AND NOT EXISTS (SELECT 1 FROM commission_payouts p WHERE p.file_id = s.file_id) ORDER BY s.file_id`,
      [networkId],
    );
    const out: { fileId: string; sponsorId: string; amountCents: number }[] = [];
    for (const r of rows) {
      const left = (await this.status(networkId, r.beneficiary_id)) !== 'active';
      const hasInvoice = await this.db.first("SELECT 1 AS ok FROM invoices WHERE file_id = ? AND kind = 'honoraires'", [r.file_id]);
      if (left || (hasInvoice && (await this.cancelled(r.file_id)))) out.push({ fileId: r.file_id, sponsorId: r.beneficiary_id, amountCents: r.amount_cents });
    }
    return out;
  }

  /** Vrai si la dernière facture d'honoraires du dossier est annulée par un avoir, ou s'il n'y en a aucune. */
  private async cancelled(fileId: string): Promise<boolean> {
    const last = await this.db.first<{ id: string }>("SELECT id FROM invoices WHERE file_id = ? AND kind = 'honoraires' ORDER BY issued_on DESC, created_at DESC, id DESC LIMIT 1", [fileId]);
    if (!last) return true;
    const credit = await this.db.first("SELECT 1 AS ok FROM invoices WHERE kind = 'avoir' AND corrects_invoice_id = ?", [last.id]);
    return credit !== null;
  }
}
