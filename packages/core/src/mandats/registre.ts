/**
 * Le registre des mandats (M06, D01) : un registre par réseau, en ajout seul.
 *
 * À son inscription, un mandat signé reçoit le numéro suivant, dans l'ordre chronologique, sans trou, au format réglé
 * pour le réseau (pendant la preuve, celui de l'agence : H23). Chaque ligne fige ce qui compte du mandat (agent, bien,
 * date de signature) et porte l'empreinte de la ligne précédente : le contrôle d'intégrité relit toute la chaîne et
 * compare chaque ligne au mandat, si bien qu'une modification après coup se voit [R39]. Rien ne s'efface ni ne se
 * modifie [R17] : une erreur se corrige par une ligne d'annulation, qui garde le numéro donné.
 *
 * Seuls l'agent du mandat, la direction et la conformité lisent une ligne ; chaque refus est au journal [R16]. Le
 * journal ne porte que des identifiants et des numéros, jamais un nom [R13].
 */
import type { Viewer } from '../acces/droits.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';

export const CANCEL_REASONS = ['error', 'withdrawal', 'termination'] as const;
export type CancelReason = (typeof CANCEL_REASONS)[number];

export interface RegisterSettings {
  prefix: string;
  firstNumber: number;
  width: number;
}

export interface RegisterLine {
  seq: number;
  kind: 'inscription' | 'annulation';
  mandateId: string;
  number: string;
  numberValue: number;
  agentId: string;
  propertyId: string | null;
  signedAt: string;
  cancelsSeq: number | null;
  reason: CancelReason | null;
  at: string;
  actor: string;
  prevHash: string;
  hash: string;
}

export type IntegrityReport =
  | { ok: true; lines: number }
  | { ok: false; lines: number; brokenAt: number; problem: 'hash' | 'chain' | 'sequence' | 'number' | 'mandate' | 'anchor' | 'missing' };

type Refusal = { ok: false; rule: 'R16'; code: 'role' | 'agent_inactive' | 'not_assigned' | 'unknown' };
type Problem = { ok: false; rule: 'R39' | null; code: 'not_configured' | 'already_configured' | 'bad_settings' | 'already_inscribed' | 'not_inscribed' | 'already_cancelled' | 'bad_reason' | 'busy' };

/** Empreinte de départ d'un registre vide. */
export const REGISTER_GENESIS = '0'.repeat(64);
const SETTINGS_PREFIX = /^[A-Za-z0-9 /._-]{0,20}$/;
// Assez pour un pic d'inscriptions au même instant ; au-delà, l'erreur remonte, jamais avalée.
const ATTEMPTS = 25;

interface LineRow {
  network_id: string;
  seq: number;
  kind: 'inscription' | 'annulation';
  mandate_id: string;
  number_value: number;
  number: string;
  agent_id: string;
  property_id: string | null;
  signed_at: string;
  cancels_seq: number | null;
  reason: CancelReason | null;
  at: string;
  actor: string;
  prev_hash: string;
  hash: string;
}

/** L'empreinte d'une ligne : tout ce qu'elle porte, dans un ordre fixe, et l'empreinte de la précédente. */
export async function hashRegisterLine(line: Omit<LineRow, 'hash'>): Promise<string> {
  const fields = [
    line.network_id,
    line.seq,
    line.kind,
    line.mandate_id,
    line.number_value,
    line.number,
    line.agent_id,
    line.property_id,
    line.signed_at,
    line.cancels_seq,
    line.reason,
    line.at,
    line.actor,
    line.prev_hash,
  ];
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(fields)));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const formatNumber = (s: RegisterSettings, value: number): string => `${s.prefix}${String(value).padStart(s.width, '0')}`;

const toLine = (r: LineRow): RegisterLine => ({
  seq: r.seq,
  kind: r.kind,
  mandateId: r.mandate_id,
  number: r.number,
  numberValue: r.number_value,
  agentId: r.agent_id,
  propertyId: r.property_id,
  signedAt: r.signed_at,
  cancelsSeq: r.cancels_seq,
  reason: r.reason,
  at: r.at,
  actor: r.actor,
  prevHash: r.prev_hash,
  hash: r.hash,
});

export class RegistreMandats {
  private readonly now: () => Date;

  constructor(
    private readonly db: SqlDatabase,
    private readonly journal: JournalStore,
    options: { now?: () => Date } = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  private actor(viewer: Viewer): string {
    return `${String(viewer.role)}:${viewer.userId}`;
  }

  private async refuse(viewer: Viewer, code: Refusal['code'], subject: string | null = null): Promise<Refusal> {
    await appendEvent(this.journal, { type: 'acces.refuse', actor: this.actor(viewer), subject, data: { rule: 'R16', role: String(viewer.role), kind: 'mandate_register', code } }, this.now);
    return { ok: false, rule: 'R16', code };
  }

  private async activeAgent(viewer: Viewer): Promise<boolean> {
    const agent = await this.db.first<{ network_id: string; status: string }>('SELECT network_id, status FROM agents WHERE id = ?', [viewer.userId]);
    return !!agent && agent.network_id === viewer.networkId && agent.status === 'active';
  }

  async settings(networkId: string): Promise<RegisterSettings | null> {
    const row = await this.db.first<{ prefix: string; first_number: number; width: number }>('SELECT prefix, first_number, width FROM mandate_register_settings WHERE network_id = ?', [networkId]);
    return row ? { prefix: row.prefix, firstNumber: Number(row.first_number), width: Number(row.width) } : null;
  }

  /** Le format du registre : la direction seule, une fois, avant la première inscription. */
  async configure(viewer: Viewer, settings: RegisterSettings): Promise<{ ok: true } | Refusal | Problem> {
    if (viewer.role !== 'direction') return this.refuse(viewer, 'role');
    if (
      typeof settings.prefix !== 'string' ||
      !SETTINGS_PREFIX.test(settings.prefix) ||
      !Number.isInteger(settings.firstNumber) ||
      settings.firstNumber < 1 ||
      !Number.isInteger(settings.width) ||
      settings.width < 1 ||
      settings.width > 10
    ) {
      return { ok: false, rule: null, code: 'bad_settings' };
    }
    const { changes } = await this.db.run(
      `INSERT INTO mandate_register_settings (network_id, prefix, first_number, width, set_by, set_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (network_id) DO NOTHING`,
      [viewer.networkId, settings.prefix, settings.firstNumber, settings.width, this.actor(viewer), this.now().toISOString()],
    );
    if (changes !== 1) return { ok: false, rule: null, code: 'already_configured' };
    await appendEvent(this.journal, { type: 'registre.regle', actor: this.actor(viewer), subject: null, data: { prefix: settings.prefix, firstNumber: settings.firstNumber, width: settings.width } }, this.now);
    return { ok: true };
  }

  /** Les droits sur un mandat : son agent, la direction, la conformité [R16]. */
  private async mandateFor(viewer: Viewer, mandateId: string, write: boolean): Promise<{ ok: true; mandate: { id: string; agent_id: string; property_id: string | null; signed_at: string } } | Refusal> {
    const subject = `mandate:${mandateId}`;
    if (!['agent', 'direction', 'compliance'].includes(viewer.role)) return this.refuse(viewer, 'role', subject);
    if (write && viewer.role === 'compliance') return this.refuse(viewer, 'role', subject);
    if (viewer.role === 'agent' && !(await this.activeAgent(viewer))) return this.refuse(viewer, 'agent_inactive', subject);
    const mandate = await this.db.first<{ id: string; network_id: string; agent_id: string; property_id: string | null; signed_at: string }>(
      'SELECT id, network_id, agent_id, property_id, signed_at FROM mandates WHERE id = ?',
      [mandateId],
    );
    if (!mandate || mandate.network_id !== viewer.networkId) return this.refuse(viewer, 'unknown', subject);
    if (viewer.role === 'agent' && mandate.agent_id !== viewer.userId) return this.refuse(viewer, 'not_assigned', subject);
    return { ok: true, mandate };
  }

  /** Ajoute une ligne à la suite ; si une autre inscription a pris le rang entre-temps, recommence. */
  private async append(networkId: string, build: (last: LineRow | null, count: number) => Omit<LineRow, 'hash' | 'seq' | 'prev_hash' | 'network_id'>): Promise<LineRow | null> {
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      const last = await this.db.first<LineRow>('SELECT * FROM mandate_register WHERE network_id = ? ORDER BY seq DESC LIMIT 1', [networkId]);
      const counted = await this.db.first<{ n: number }>(`SELECT COUNT(*) AS n FROM mandate_register WHERE network_id = ? AND kind = 'inscription'`, [networkId]);
      const body = build(last, Number(counted?.n ?? 0));
      const line: Omit<LineRow, 'hash'> = { network_id: networkId, seq: (last ? Number(last.seq) : 0) + 1, prev_hash: last ? last.hash : REGISTER_GENESIS, ...body };
      const hash = await hashRegisterLine(line);
      try {
        await this.db.run(
          `INSERT INTO mandate_register (network_id, seq, kind, mandate_id, number_value, number, agent_id, property_id, signed_at, cancels_seq, reason, at, actor, prev_hash, hash)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [line.network_id, line.seq, line.kind, line.mandate_id, line.number_value, line.number, line.agent_id, line.property_id, line.signed_at, line.cancels_seq, line.reason, line.at, line.actor, line.prev_hash, hash],
        );
        return { ...line, hash };
      } catch (error) {
        // Le rang ou le numéro vient d'être pris : on relit et on recommence. Un mandat déjà inscrit ne l'est pas deux fois.
        if (body.kind === 'inscription' && (await this.inscriptionOf(body.mandate_id))) return null;
        if (body.kind === 'annulation' && (await this.db.first('SELECT seq FROM mandate_register WHERE network_id = ? AND kind = ? AND cancels_seq = ?', [networkId, 'annulation', body.cancels_seq]))) return null;
        if (attempt === ATTEMPTS - 1) throw error;
      }
    }
    return null;
  }

  private inscriptionOf(mandateId: string): Promise<LineRow | null> {
    return this.db.first<LineRow>(`SELECT * FROM mandate_register WHERE mandate_id = ? AND kind = 'inscription'`, [mandateId]);
  }

  /** Inscrit un mandat signé : le numéro suivant, une seule fois par mandat [R39]. */
  async inscribe(viewer: Viewer, mandateId: string): Promise<{ ok: true; line: RegisterLine } | Refusal | Problem> {
    const found = await this.mandateFor(viewer, mandateId, true);
    if (!found.ok) return found;
    const settings = await this.settings(viewer.networkId);
    if (!settings) return { ok: false, rule: null, code: 'not_configured' };
    if (await this.inscriptionOf(mandateId)) return { ok: false, rule: 'R39', code: 'already_inscribed' };
    const at = this.now().toISOString();
    const line = await this.append(viewer.networkId, (_last, count) => {
      const value = settings.firstNumber + count;
      return {
        kind: 'inscription',
        mandate_id: mandateId,
        number_value: value,
        number: formatNumber(settings, value),
        agent_id: found.mandate.agent_id,
        property_id: found.mandate.property_id,
        signed_at: found.mandate.signed_at,
        cancels_seq: null,
        reason: null,
        at,
        actor: this.actor(viewer),
      };
    });
    if (!line) return { ok: false, rule: 'R39', code: 'already_inscribed' };
    await appendEvent(this.journal, { type: 'registre.inscrit', actor: this.actor(viewer), subject: `mandate:${mandateId}`, data: { network: viewer.networkId, seq: line.seq, number: line.number, hash: line.hash } }, this.now);
    return { ok: true, line: toLine(line) };
  }

  /** Annule une inscription par une ligne nouvelle : le numéro reste donné, rien n'est effacé [R17]. */
  async cancel(viewer: Viewer, mandateId: string, reason: CancelReason): Promise<{ ok: true; line: RegisterLine } | Refusal | Problem> {
    if (!(CANCEL_REASONS as readonly string[]).includes(reason)) return { ok: false, rule: null, code: 'bad_reason' };
    const found = await this.mandateFor(viewer, mandateId, true);
    if (!found.ok) return found;
    const inscription = await this.inscriptionOf(mandateId);
    if (!inscription) return { ok: false, rule: null, code: 'not_inscribed' };
    const done = await this.db.first('SELECT seq FROM mandate_register WHERE network_id = ? AND kind = ? AND cancels_seq = ?', [viewer.networkId, 'annulation', inscription.seq]);
    if (done) return { ok: false, rule: null, code: 'already_cancelled' };
    const at = this.now().toISOString();
    const line = await this.append(viewer.networkId, () => ({
      kind: 'annulation',
      mandate_id: mandateId,
      number_value: Number(inscription.number_value),
      number: inscription.number,
      agent_id: inscription.agent_id,
      property_id: inscription.property_id,
      signed_at: inscription.signed_at,
      cancels_seq: Number(inscription.seq),
      reason,
      at,
      actor: this.actor(viewer),
    }));
    if (!line) return { ok: false, rule: null, code: 'already_cancelled' };
    await appendEvent(this.journal, { type: 'registre.annule', actor: this.actor(viewer), subject: `mandate:${mandateId}`, data: { network: viewer.networkId, seq: line.seq, cancels: Number(inscription.seq), reason, hash: line.hash } }, this.now);
    return { ok: true, line: toLine(line) };
  }

  /** Les lignes d'un mandat : inscription, et annulation s'il y en a une. */
  async linesOf(viewer: Viewer, mandateId: string): Promise<{ ok: true; lines: RegisterLine[] } | Refusal> {
    const found = await this.mandateFor(viewer, mandateId, false);
    if (!found.ok) return found;
    const rows = await this.db.all<LineRow>('SELECT * FROM mandate_register WHERE network_id = ? AND mandate_id = ? ORDER BY seq', [viewer.networkId, mandateId]);
    await appendEvent(this.journal, { type: 'registre.lu', actor: this.actor(viewer), subject: `mandate:${mandateId}`, data: { rule: 'R16', lines: rows.length } }, this.now);
    return { ok: true, lines: rows.map(toLine) };
  }

  /**
   * Le contrôle d'intégrité du registre du réseau : rangs sans trou, chaque empreinte recalculée, chaque lien à la
   * précédente, les numéros dans l'ordre, et chaque ligne égale au mandat qu'elle fige [R39]. Direction et conformité.
   */
  async verify(viewer: Viewer): Promise<{ ok: true; value: IntegrityReport } | Refusal> {
    if (viewer.role !== 'direction' && viewer.role !== 'compliance') return this.refuse(viewer, 'role');
    const report = await this.check(viewer.networkId);
    await appendEvent(
      this.journal,
      { type: 'registre.controle', actor: this.actor(viewer), subject: null, data: report.ok ? { ok: true, lines: report.lines } : { ok: false, lines: report.lines, brokenAt: report.brokenAt, problem: report.problem } },
      this.now,
    );
    return { ok: true, value: report };
  }

  /** Le contrôle lui-même, sans droits : pour le planificateur et les tests. */
  async check(networkId: string): Promise<IntegrityReport> {
    const rows = await this.db.all<LineRow>('SELECT * FROM mandate_register WHERE network_id = ? ORDER BY seq', [networkId]);
    const settings = await this.settings(networkId);
    // L'ancre : chaque ligne inscrite a laissé son rang et son empreinte au journal, lui-même chaîné et en ajout seul.
    // Une ligne réécrite avec toute la suite recalculée, ou des lignes effacées en fin de registre, ne la retrouvent plus.
    const anchors = new Map<number, string>();
    const events = await this.db.all<{ data: string }>(`SELECT data FROM journal WHERE type IN ('registre.inscrit', 'registre.annule') ORDER BY seq`);
    for (const e of events) {
      try {
        const d = JSON.parse(e.data) as { network?: unknown; seq?: unknown; hash?: unknown };
        if (d.network === networkId && typeof d.seq === 'number' && typeof d.hash === 'string') anchors.set(d.seq, d.hash);
      } catch {
        // Une ligne illisible du journal n'ancre rien.
      }
    }
    let prev = REGISTER_GENESIS;
    let expected = settings?.firstNumber ?? 1;
    for (let i = 0; i < rows.length; i++) {
      const row = { ...rows[i]!, seq: Number(rows[i]!.seq), number_value: Number(rows[i]!.number_value), cancels_seq: rows[i]!.cancels_seq === null ? null : Number(rows[i]!.cancels_seq) };
      const broken = (problem: Exclude<IntegrityReport, { ok: true }>['problem']): IntegrityReport => ({ ok: false, lines: rows.length, brokenAt: row.seq, problem });
      if (row.seq !== i + 1) return broken('sequence');
      if (row.prev_hash !== prev) return broken('chain');
      const { hash, ...rest } = row;
      if ((await hashRegisterLine(rest)) !== hash) return broken('hash');
      if (anchors.get(row.seq) !== hash) return broken('anchor');
      if (row.kind === 'inscription') {
        if (!settings || row.number_value !== expected || row.number !== formatNumber(settings, expected)) return broken('number');
        expected += 1;
        const mandate = await this.db.first<{ network_id: string; agent_id: string; property_id: string | null; signed_at: string }>('SELECT network_id, agent_id, property_id, signed_at FROM mandates WHERE id = ?', [row.mandate_id]);
        if (!mandate || mandate.network_id !== networkId || mandate.agent_id !== row.agent_id || mandate.property_id !== row.property_id || mandate.signed_at !== row.signed_at) return broken('mandate');
      }
      prev = hash;
    }
    // Des lignes ancrées au journal mais absentes du registre : elles ont été effacées.
    const missing = [...anchors.keys()].filter((seq) => seq > rows.length).sort((a, b) => a - b)[0];
    if (missing !== undefined) return { ok: false, lines: rows.length, brokenAt: missing, problem: 'missing' };
    return { ok: true, lines: rows.length };
  }
}
