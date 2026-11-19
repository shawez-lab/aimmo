/**
 * L'accès de sortie d'un agent parti (M14, AU111) [R16, R17, R86].
 *
 * Le jour de son départ, l'agent perd tout accès : ses clients et ses biens passent à son successeur ou à la direction.
 * Il lui reste pourtant à récupérer son solde, ses pièces personnelles et son temps de formation. La direction lui
 * donne un lien de sortie, à durée limitée (90 jours par défaut, un an au plus), qu'elle peut retirer. Ce lien ne montre
 * que ce qui est à lui : les commissions pas encore payées et ses parts, ses pièces signées, son temps de formation, et
 * un relevé de sortie portant son empreinte. Jamais un client, un bien, un rendez-vous ni un mandat : ils ont été
 * réattribués.
 *
 * Le lien n'est rendu qu'une fois, à la direction, qui le remet à l'agent ; AIMMO n'en garde que l'empreinte. Chaque
 * lecture est écrite au journal, sans le lien ni aucun montant [R13]. Rien n'est envoyé d'ici.
 */
import type { Viewer } from '../acces/droits.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { localTime } from '../envoi/horaires.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import { fingerprintOf } from '../rapports/export-agent.ts';
import { agentGone, personalContentsOf, settlementOf, type PersonalContents, type SettlementLine } from './depart.ts';

const TIME_ZONE = 'Europe/Paris';
export const EXIT_STATEMENT_FORMAT = 'aimmo-sortie-agent/1';
/** La durée d'un accès de sortie, en jours : par défaut, et au plus. */
export const EXIT_ACCESS_DAYS = Object.freeze({ default: 90, max: 365 });
const TOKEN_LETTERS = 'abcdefghijklmnopqrstuvwxyz234567';
const TOKEN = /^[a-z2-7]{32}$/;

export interface ExitStatement {
  format: typeof EXIT_STATEMENT_FORMAT;
  networkId: string;
  agentId: string;
  madeAt: string;
  /** Ses commissions pas encore payées et ses parts : par dossier de vente, jamais par client. */
  settlement: SettlementLine[];
  /** Ses pièces signées : la sorte et la version, la référence restant interne. */
  pieces: { kind: string; version: number }[];
  trainingMinutes: number;
}

export interface ExitView {
  agentId: string;
  firstName: string | null;
  lastName: string | null;
  expiresOn: string;
  statement: ExitStatement;
  /** L'empreinte SHA-256 du relevé, rangée : le relevé se vérifie ensuite comme un export d'agent. */
  fingerprint: string;
}

type Refusal = { ok: false; rule: 'R16'; code: string };
type Problem = { ok: false; rule: null; code: 'bad_days' | 'not_gone' | 'unknown_access' | 'already_revoked' };

function newExitToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return [...bytes].map((b) => TOKEN_LETTERS[b % 32]).join('');
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const addDays = (day: string, n: number): string => {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

export class AccesSortie {
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly newToken: () => string;

  constructor(
    private readonly db: SqlDatabase,
    private readonly journal: JournalStore,
    options: { now?: () => Date; newId?: () => string; newToken?: () => string } = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => crypto.randomUUID());
    this.newToken = options.newToken ?? newExitToken;
  }

  private actor(viewer: Viewer): string {
    return `${String(viewer.role)}:${viewer.userId}`;
  }

  private async refuse(viewer: Viewer, subject: string, code: string): Promise<Refusal> {
    await appendEvent(this.journal, { type: 'acces.refuse', actor: this.actor(viewer), subject, data: { rule: 'R16', role: String(viewer.role), kind: 'agent_exit_access', code } }, this.now);
    return { ok: false, rule: 'R16', code };
  }

  /** La direction donne un accès de sortie à un agent parti ; le lien n'est rendu qu'ici, une fois. */
  async grant(viewer: Viewer, agentId: string, input: { days?: unknown } = {}): Promise<{ ok: true; value: { accessId: string; token: string; expiresOn: string } } | Refusal | Problem> {
    if (viewer.role !== 'direction') return this.refuse(viewer, `agent:${agentId}`, 'role');
    const agent = await this.db.first<{ network_id: string }>('SELECT network_id FROM agents WHERE id = ?', [agentId]);
    if (!agent || agent.network_id !== viewer.networkId) return this.refuse(viewer, `agent:${agentId}`, 'unknown');
    const days = input.days === undefined ? EXIT_ACCESS_DAYS.default : input.days;
    if (typeof days !== 'number' || !Number.isInteger(days) || days < 1 || days > EXIT_ACCESS_DAYS.max) return { ok: false, rule: null, code: 'bad_days' };
    // Un agent encore en activité garde son propre accès et son export (HX62) : la sortie n'est que pour un départ fait.
    if (!(await agentGone(this.db, viewer.networkId, agentId, this.now()))) return { ok: false, rule: null, code: 'not_gone' };
    const token = this.newToken();
    if (!TOKEN.test(token)) throw new Error('lien de sortie mal formé');
    const id = this.newId();
    const expiresOn = addDays(localTime(this.now(), TIME_ZONE).date, days);
    await this.db.run('INSERT INTO agent_exit_accesses (id, network_id, agent_id, token_hash, expires_on, granted_by, granted_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [
      id,
      viewer.networkId,
      agentId,
      await sha256(token),
      expiresOn,
      this.actor(viewer),
      this.now().toISOString(),
    ]);
    await appendEvent(this.journal, { type: 'agent_sortie.acces_donne', actor: this.actor(viewer), subject: `agent:${agentId}`, data: { access: id, expiresOn } }, this.now);
    return { ok: true, value: { accessId: id, token, expiresOn } };
  }

  /** La direction retire un accès de sortie : le lien ne montre plus rien. */
  async revoke(viewer: Viewer, accessId: string): Promise<{ ok: true } | Refusal | Problem> {
    if (viewer.role !== 'direction') return this.refuse(viewer, `exit_access:${accessId}`, 'role');
    const row = await this.db.first<{ network_id: string; agent_id: string }>('SELECT network_id, agent_id FROM agent_exit_accesses WHERE id = ?', [accessId]);
    if (!row || row.network_id !== viewer.networkId) return { ok: false, rule: null, code: 'unknown_access' };
    const { changes } = await this.db.run('INSERT INTO agent_exit_access_revocations (access_id, network_id, revoked_by, revoked_at) VALUES (?, ?, ?, ?) ON CONFLICT (access_id) DO NOTHING', [
      accessId,
      viewer.networkId,
      this.actor(viewer),
      this.now().toISOString(),
    ]);
    if (changes !== 1) return { ok: false, rule: null, code: 'already_revoked' };
    await appendEvent(this.journal, { type: 'agent_sortie.acces_retire', actor: this.actor(viewer), subject: `agent:${row.agent_id}`, data: { access: accessId } }, this.now);
    return { ok: true };
  }

  /** L'accès d'un lien : en cours, ni retiré ni échu, pour un agent toujours parti ; sinon `null`. */
  private async accessOf(token: string): Promise<{ id: string; network_id: string; agent_id: string; expires_on: string } | null> {
    if (typeof token !== 'string' || !TOKEN.test(token)) return null;
    const row = await this.db.first<{ id: string; network_id: string; agent_id: string; expires_on: string }>(
      `SELECT a.id, a.network_id, a.agent_id, a.expires_on FROM agent_exit_accesses a
       WHERE a.token_hash = ? AND NOT EXISTS (SELECT 1 FROM agent_exit_access_revocations r WHERE r.access_id = a.id)`,
      [await sha256(token)],
    );
    if (!row || row.expires_on < localTime(this.now(), TIME_ZONE).date) return null;
    // Un départ annulé rend à l'agent son propre accès : le lien de sortie ne sert plus.
    if (!(await agentGone(this.db, row.network_id, row.agent_id, this.now()))) return null;
    return row;
  }

  /**
   * Ce que le lien montre : solde, pièces, temps de formation et relevé de sortie avec son empreinte. Un lien inconnu,
   * retiré ou échu ne montre rien, et le même refus est rendu dans tous les cas.
   */
  async read(token: string): Promise<{ ok: true; value: ExitView } | { ok: false; rule: 'R16'; code: 'unknown_link' }> {
    const access = await this.accessOf(token);
    if (!access) {
      await appendEvent(this.journal, { type: 'acces.refuse', actor: 'public:sortie', subject: null, data: { rule: 'R16', kind: 'agent_exit_access', code: 'unknown_link' } }, this.now);
      return { ok: false, rule: 'R16', code: 'unknown_link' };
    }
    const agent = await this.db.first<{ first_name: string | null; last_name: string | null }>('SELECT first_name, last_name FROM agents WHERE id = ?', [access.agent_id]);
    const contents: PersonalContents = await personalContentsOf(this.db, access.agent_id);
    const statement: ExitStatement = {
      format: EXIT_STATEMENT_FORMAT,
      networkId: access.network_id,
      agentId: access.agent_id,
      madeAt: this.now().toISOString(),
      settlement: await settlementOf(this.db, access.network_id, access.agent_id),
      pieces: contents.pieces.map((p) => ({ kind: p.kind, version: p.version })),
      trainingMinutes: contents.trainingMinutes,
    };
    const fingerprint = await fingerprintOf(statement);
    const rows = statement.settlement.length + statement.pieces.length + 1;
    await this.db.run('INSERT INTO agent_exports (id, network_id, agent_id, fingerprint, row_count, made_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (agent_id, fingerprint) DO NOTHING', [
      this.newId(),
      access.network_id,
      access.agent_id,
      fingerprint,
      rows,
      statement.madeAt,
    ]);
    await appendEvent(this.journal, { type: 'agent_sortie.lu', actor: `agent:${access.agent_id}`, subject: `agent:${access.agent_id}`, data: { access: access.id, fingerprint } }, this.now);
    return { ok: true, value: { agentId: access.agent_id, firstName: agent?.first_name ?? null, lastName: agent?.last_name ?? null, expiresOn: access.expires_on, statement, fingerprint } };
  }

  /** La référence de stockage d'une de ses pièces signées, par sa sorte, pour la remettre par le lien ; sinon `null`. */
  async pieceRef(token: string, kind: string): Promise<string | null> {
    const access = await this.accessOf(token);
    if (!access) return null;
    const piece = (await personalContentsOf(this.db, access.agent_id)).pieces.find((p) => p.kind === kind);
    if (!piece) return null;
    await appendEvent(this.journal, { type: 'agent_sortie.piece', actor: `agent:${access.agent_id}`, subject: `agent:${access.agent_id}`, data: { access: access.id, kind } }, this.now);
    return piece.ref;
  }

  /** Vérifie un relevé de sortie : son empreinte recalculée doit être celle rangée à sa remise. */
  async verify(statement: unknown): Promise<boolean> {
    if (statement === null || typeof statement !== 'object' || (statement as { format?: unknown }).format !== EXIT_STATEMENT_FORMAT) return false;
    let fingerprint: string;
    try {
      fingerprint = await fingerprintOf(statement);
    } catch {
      return false;
    }
    const s = statement as { agentId?: unknown; networkId?: unknown };
    return Boolean(await this.db.first('SELECT id FROM agent_exports WHERE agent_id = ? AND network_id = ? AND fingerprint = ?', [String(s.agentId), String(s.networkId), fingerprint]));
  }
}
