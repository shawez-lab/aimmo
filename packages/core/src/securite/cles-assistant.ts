/**
 * Les clés que l'agent confie à son assistant (ChatGPT, Claude…) pour parler au serveur MCP d'AIMMO (BR09, HX55)
 * [R590, R601, R82, R13, R17].
 *
 * - L'agent crée la clé lui-même, depuis l'application : par la séance de sa clé d'appareil (contrôlée par la route),
 *   sur une preuve « créer une clé d'API » faite pour l'objet `cle_assistant:<lui>` [R601]. La clé, tirée au hasard,
 *   n'est rendue qu'une fois ; seule son empreinte est rangée, jamais la clé, et le journal ne garde ni l'une ni
 *   l'autre [R13].
 * - La clé créée porte la portée « mcp » : elle n'ouvre que `POST /v1/mcp`, et le socle refuse toute autre route
 *   [R590].
 * - L'agent la retire d'un geste, sans second facteur (c'est un geste qui protège) ; la direction peut retirer celle de
 *   tout agent de son réseau [R600]. Retirée, elle est refusée à l'appel suivant : elle est relue à chaque demande.
 * - Un agent parti n'en a plus aucune : sa clé n'est plus reconnue, dès minuit le jour de son départ [R82].
 *
 * Décidé, lecture prudente : trois clés actives au plus par agent (un assistant par usage), un nom court pour les
 * reconnaître ; une clé ne s'efface jamais [R17].
 */
import type { Viewer } from '../acces/droits.ts';
import { agentState } from '../acces/etat-agent.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import type { SensitiveAction } from './cles-appareil.ts';
import { sha256, toBase64Url } from './webauthn.ts';

/** Clés actives au plus par agent. */
export const MAX_ASSISTANT_KEYS = 3;
/** L'action et l'objet de la preuve qui ouvre la création [R601]. */
export const ASSISTANT_KEY_ACTION: SensitiveAction = 'creer_cle_api';
export const assistantKeySubject = (userId: string): string => `cle_assistant:${userId}`;

const ID = /^[A-Za-z0-9_-]{1,64}$/;
/** Un nom court, lisible : lettres, chiffres, espaces, points, tirets. */
const LABEL = /^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,39}$/u;

export interface AssistantKey {
  id: string;
  label: string;
  createdAt: string;
  revokedAt: string | null;
}

export type AssistantResult<T> = { ok: true; value: T } | { ok: false; rule: string | null; code: string };

/** La porte du second facteur (`ClesAppareil.requireSecondFactor`). */
export interface AssistantSecondFactor {
  requireSecondFactor(viewer: Viewer, action: SensitiveAction, subject: string, stepUpId: unknown): Promise<{ ok: true; value: { deviceId: string } } | { ok: false; rule: string; code: string }>;
}

export interface ClesAssistantOptions {
  now?: () => Date;
  newId?: () => string;
  randomBytes?: (n: number) => Uint8Array;
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** L'empreinte rangée d'une clé : SHA-256 en hexadécimal, comme celles du secret `API_KEYS`. */
export async function assistantKeyHash(key: string): Promise<string> {
  return hex(await sha256(key));
}

/**
 * L'agent qui tient cette clé, relu à cet instant : `null` si elle est inconnue, retirée, ou si son agent est parti
 * [R82]. Le socle la lit à chaque demande, avec la portée « mcp ».
 */
export async function assistantKeyViewer(db: SqlDatabase, hash: string, at: Date): Promise<Viewer | null> {
  if (!/^[0-9a-f]{64}$/.test(hash)) return null;
  const row = await db.first<{ network_id: string; user_id: string; status: string }>(
    'SELECT k.network_id, k.user_id, a.status FROM assistant_keys k JOIN agents a ON a.id = k.user_id AND a.network_id = k.network_id WHERE k.sha256 = ? AND k.revoked_at IS NULL',
    [hash],
  );
  if (!row || row.status !== 'active') return null;
  if ((await agentState(db, row.network_id, row.user_id, at)) === 'parti') return null;
  return { role: 'agent', userId: row.user_id, networkId: row.network_id };
}

export class ClesAssistant {
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly randomBytes: (n: number) => Uint8Array;

  constructor(
    private readonly db: SqlDatabase,
    private readonly journal: JournalStore,
    private readonly secondFactor: AssistantSecondFactor,
    options: ClesAssistantOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => crypto.randomUUID());
    this.randomBytes = options.randomBytes ?? ((n) => crypto.getRandomValues(new Uint8Array(n)));
  }

  /**
   * Crée une clé pour l'assistant de l'agent, sur sa preuve [R601]. La clé n'est rendue qu'ici, une fois. La limite est
   * lue avant la preuve, pour ne pas l'user en vain ; l'écriture la relit, pour que deux créations simultanées ne la
   * dépassent pas.
   */
  async create(viewer: Viewer, stepUpId: unknown, label: unknown): Promise<AssistantResult<AssistantKey & { key: string }>> {
    if (viewer.role !== 'agent' || !ID.test(viewer.userId) || !ID.test(viewer.networkId)) return this.refuse(viewer, 'R16', 'role');
    const name = typeof label === 'string' ? label.trim() : label;
    if (typeof name !== 'string' || !LABEL.test(name)) return this.refuse(viewer, null, 'bad_label');
    if ((await this.activeCount(viewer)) >= MAX_ASSISTANT_KEYS) return this.refuse(viewer, null, 'limite_atteinte');
    const subject = assistantKeySubject(viewer.userId);
    const proof = await this.secondFactor.requireSecondFactor(viewer, ASSISTANT_KEY_ACTION, subject, stepUpId);
    if (!proof.ok) return { ok: false, rule: proof.rule, code: proof.code };

    const key = toBase64Url(this.randomBytes(32));
    if (key.length < 32) throw new Error('clé trop courte');
    const id = this.newId();
    const createdAt = this.now().toISOString();
    const done = await this.db.run(
      `INSERT INTO assistant_keys (id, network_id, user_id, sha256, label, device_id, created_at)
       SELECT ?, ?, ?, ?, ?, ?, ? WHERE (SELECT count(*) FROM assistant_keys WHERE network_id = ? AND user_id = ? AND revoked_at IS NULL) < ?`,
      [id, viewer.networkId, viewer.userId, await assistantKeyHash(key), name, proof.value.deviceId, createdAt, viewer.networkId, viewer.userId, MAX_ASSISTANT_KEYS],
    );
    if (done.changes !== 1) return this.refuse(viewer, null, 'limite_atteinte');
    // Au journal : l'identifiant et l'appareil qui a prouvé, jamais la clé ni son empreinte [R13].
    await this.write(viewer, 'cles.assistant.creee', { rule: 'R601', id, device: proof.value.deviceId });
    return { ok: true, value: { id, label: name, createdAt, revokedAt: null, key } };
  }

  /** Les clés de l'agent, sans aucune empreinte. */
  async listOwn(viewer: Viewer): Promise<AssistantResult<AssistantKey[]>> {
    if (viewer.role !== 'agent') return this.refuse(viewer, 'R16', 'role');
    const rows = await this.db.all<{ id: string; label: string; created_at: string; revoked_at: string | null }>(
      'SELECT id, label, created_at, revoked_at FROM assistant_keys WHERE network_id = ? AND user_id = ? ORDER BY created_at, id',
      [viewer.networkId, viewer.userId],
    );
    return { ok: true, value: rows.map((r) => ({ id: r.id, label: r.label, createdAt: r.created_at, revokedAt: r.revoked_at })) };
  }

  /** Retire une clé d'un geste : l'agent les siennes, la direction toute clé de son réseau [R600]. */
  async revoke(viewer: Viewer, id: unknown): Promise<AssistantResult<AssistantKey>> {
    if (viewer.role !== 'agent' && viewer.role !== 'direction') return this.refuse(viewer, 'R16', 'role');
    if (typeof id !== 'string' || !ID.test(id)) return this.refuse(viewer, null, 'unknown');
    const row = await this.db.first<{ id: string; user_id: string; label: string; created_at: string; revoked_at: string | null }>(
      'SELECT id, user_id, label, created_at, revoked_at FROM assistant_keys WHERE id = ? AND network_id = ?',
      [id, viewer.networkId],
    );
    // La clé d'un autre agent n'existe pas pour un agent : 404, sans dire qu'elle existe.
    if (!row || (viewer.role === 'agent' && row.user_id !== viewer.userId)) return this.refuse(viewer, null, 'unknown');
    if (row.revoked_at !== null) return { ok: true, value: { id: row.id, label: row.label, createdAt: row.created_at, revokedAt: row.revoked_at } };
    const at = this.now().toISOString();
    await this.db.run('UPDATE assistant_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL', [at, row.id]);
    const after = await this.db.first<{ revoked_at: string }>('SELECT revoked_at FROM assistant_keys WHERE id = ?', [row.id]);
    await this.write(viewer, 'cles.assistant.retiree', { rule: 'R600', id: row.id, agent: row.user_id });
    return { ok: true, value: { id: row.id, label: row.label, createdAt: row.created_at, revokedAt: after?.revoked_at ?? at } };
  }

  private async activeCount(viewer: Viewer): Promise<number> {
    const row = await this.db.first<{ n: number }>('SELECT count(*) AS n FROM assistant_keys WHERE network_id = ? AND user_id = ? AND revoked_at IS NULL', [viewer.networkId, viewer.userId]);
    return Number(row?.n ?? 0);
  }

  private async refuse(viewer: Viewer, rule: string | null, code: string): Promise<{ ok: false; rule: string | null; code: string }> {
    await appendEvent(this.journal, { type: 'cles.assistant.refus', actor: `${String(viewer.role)}:${viewer.userId}`, subject: `network:${viewer.networkId}`, data: { rule: rule ?? '', code } }, this.now);
    return { ok: false, rule, code };
  }

  private async write(viewer: Viewer, type: string, data: Record<string, string>): Promise<void> {
    await appendEvent(this.journal, { type, actor: `${String(viewer.role)}:${viewer.userId}`, subject: `agent:${data.agent ?? viewer.userId}`, data }, this.now);
  }
}
