/**
 * Dépôt des fichiers de la reprise par la direction (I05). Shawez dépose ses trois exports (H15) depuis l'écran du
 * réseau de l'application, sans geste technique : le texte est rangé dans la base `aimmo`, en morceaux, jamais dans le
 * dépôt ni dans un journal [R13]. Un dépôt s'ajoute au précédent, rien n'est effacé [R17] ; le lancement prend le
 * dernier de chaque sorte. Un fichier que la reprise ne saurait pas lire est refusé au dépôt, sans rien ranger.
 */
import type { Viewer } from '../acces/droits.ts';
import { runBatch, type SqlDatabase, type SqlStatement } from '../db/sql.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import { TOOL_FILES, readToolCsv, type ToolFile } from './outils.ts';
import type { ToolFiles } from './reelle.ts';

/** Taille d'un morceau rangé : une ligne de D1 reste loin de sa limite. */
export const DEPOT_PART_CHARS = 200_000;
/** Taille maximale d'un fichier déposé. */
export const DEPOT_MAX_BYTES = 20_000_000;

export interface DepotInfo {
  id: string;
  networkId: string;
  tool: ToolFile;
  agentId: string;
  sha256: string;
  bytes: number;
  lines: number;
  parts: number;
  depositedAt: string;
}

export interface DepotsOptions {
  now?: () => Date;
  newId?: () => string;
}

type Refusal = { ok: false; rule: 'R16' | null; code: string };

interface DepotRow {
  id: string;
  network_id: string;
  tool: ToolFile;
  agent_id: string;
  sha256: string;
  bytes: number;
  lines: number;
  parts: number;
  deposited_at: string;
}

const info = (r: DepotRow): DepotInfo => ({
  id: r.id,
  networkId: r.network_id,
  tool: r.tool,
  agentId: r.agent_id,
  sha256: r.sha256,
  bytes: Number(r.bytes),
  lines: Number(r.lines),
  parts: Number(r.parts),
  depositedAt: r.deposited_at,
});

export async function sha256Hex(text: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export class DepotsReprise {
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(
    private readonly db: SqlDatabase,
    private readonly journal: JournalStore,
    options: DepotsOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => crypto.randomUUID());
  }

  /**
   * La direction seule dépose [R16]. Les fiches reprises sont confiées à l'agent nommé, ou, sans nom, à la fiche
   * d'agent de la personne qui dépose ; il doit être actif dans son réseau. Rend des nombres, jamais le contenu.
   */
  async deposit(viewer: Viewer, input: { tool: unknown; csv: unknown; agentId?: unknown }): Promise<{ ok: true; value: DepotInfo & { unreadableLines: number; partialLines: number } } | Refusal> {
    if (viewer.role !== 'direction') return this.refuse(viewer, 'reprise.depot');
    const tool = input.tool;
    if (typeof tool !== 'string' || !(TOOL_FILES as readonly string[]).includes(tool)) return { ok: false, rule: null, code: 'bad_tool' };
    const csv = input.csv;
    if (typeof csv !== 'string' || csv.trim() === '') return { ok: false, rule: null, code: 'empty_file' };
    const bytes = new TextEncoder().encode(csv).length;
    if (bytes > DEPOT_MAX_BYTES) return { ok: false, rule: null, code: 'file_too_large' };
    const agentId = input.agentId === undefined || input.agentId === null ? viewer.userId : input.agentId;
    if (typeof agentId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(agentId)) return { ok: false, rule: null, code: 'bad_agent' };
    const agent = await this.db.first<{ status: string }>('SELECT status FROM agents WHERE id = ? AND network_id = ?', [agentId, viewer.networkId]);
    if (!agent || agent.status !== 'active') return { ok: false, rule: null, code: 'bad_agent' };

    const at = this.now();
    let reading: Awaited<ReturnType<typeof readToolCsv>>;
    try {
      reading = await readToolCsv(csv, tool as ToolFile, at);
    } catch {
      // Le message de lecture ne sort pas : il pourrait citer le fichier.
      return { ok: false, rule: null, code: 'unreadable_file' };
    }
    const lines = reading.contacts.length + reading.unreadableLines.length;
    const id = this.newId();
    const parts: string[] = [];
    for (let i = 0; i < csv.length; i += DEPOT_PART_CHARS) parts.push(csv.slice(i, i + DEPOT_PART_CHARS));
    const sha = await sha256Hex(csv);
    const statements: SqlStatement[] = [
      {
        sql: `INSERT INTO reprise_depots (id, network_id, tool, agent_id, sha256, bytes, lines, parts, deposited_by, deposited_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        params: [id, viewer.networkId, tool, agentId, sha, bytes, lines, parts.length, `direction:${viewer.userId}`, at.toISOString()],
      },
      ...parts.map((content, rank) => ({ sql: 'INSERT INTO reprise_depot_morceaux (depot_id, rank, content) VALUES (?, ?, ?)', params: [id, rank, content] })),
    ];
    // Tout ou rien : un dépôt n'existe jamais sans tous ses morceaux.
    await runBatch(this.db, statements);
    await appendEvent(
      this.journal,
      { type: 'reprise.depot', actor: `direction:${viewer.userId}`, subject: `network:${viewer.networkId}`, data: { tool, bytes, lines, unreadableLines: reading.unreadableLines.length, partialLines: reading.partialLines.length } },
      this.now,
    );
    return {
      ok: true,
      value: {
        id,
        networkId: viewer.networkId,
        tool: tool as ToolFile,
        agentId,
        sha256: sha,
        bytes,
        lines,
        parts: parts.length,
        depositedAt: at.toISOString(),
        unreadableLines: reading.unreadableLines.length,
        partialLines: reading.partialLines.length,
      },
    };
  }

  /** L'état pour l'écran : le dernier dépôt de chaque sorte et l'avancement du lancement, des nombres seulement. */
  async status(viewer: Viewer): Promise<{ ok: true; value: { depots: Partial<Record<ToolFile, Omit<DepotInfo, 'networkId' | 'sha256' | 'id'>>>; progress: unknown } } | Refusal> {
    if (viewer.role !== 'direction') return this.refuse(viewer, 'reprise.etat');
    const depots: Partial<Record<ToolFile, Omit<DepotInfo, 'networkId' | 'sha256' | 'id'>>> = {};
    for (const d of await this.latest(viewer.networkId)) {
      depots[d.tool] = { tool: d.tool, agentId: d.agentId, bytes: d.bytes, lines: d.lines, parts: d.parts, depositedAt: d.depositedAt };
    }
    const row = await this.db.first<{ source: string; position: number; totals: string; updated_at: string; done_at: string | null }>(
      'SELECT source, position, totals, updated_at, done_at FROM reprise_avancement WHERE network_id = ?',
      [viewer.networkId],
    );
    const progress = row === null ? null : { source: row.source, position: Number(row.position), totals: JSON.parse(row.totals) as unknown, updatedAt: row.updated_at, doneAt: row.done_at };
    return { ok: true, value: { depots, progress } };
  }

  /** Le dernier dépôt de chaque sorte du réseau. */
  async latest(networkId: string): Promise<DepotInfo[]> {
    const rows = await this.db.all<DepotRow>(
      `SELECT id, network_id, tool, agent_id, sha256, bytes, lines, parts, deposited_at FROM reprise_depots d
       WHERE network_id = ? AND id = (
         SELECT id FROM reprise_depots e WHERE e.network_id = d.network_id AND e.tool = d.tool ORDER BY deposited_at DESC, rowid DESC LIMIT 1
       ) ORDER BY tool`,
      [networkId],
    );
    return rows.map(info);
  }

  /** Les réseaux qui ont au moins un dépôt. */
  async networks(): Promise<string[]> {
    return (await this.db.all<{ network_id: string }>('SELECT DISTINCT network_id FROM reprise_depots ORDER BY network_id')).map((r) => r.network_id);
  }

  /** Le texte d'un dépôt, recousu et vérifié par son empreinte : un dépôt abîmé arrête tout. */
  async content(depot: DepotInfo): Promise<string> {
    const parts = await this.db.all<{ rank: number; content: string }>('SELECT rank, content FROM reprise_depot_morceaux WHERE depot_id = ? ORDER BY rank', [depot.id]);
    if (parts.length !== depot.parts || parts.some((p, i) => Number(p.rank) !== i)) throw new Error(`Reprise : dépôt ${depot.tool} incomplet.`);
    const text = parts.map((p) => p.content).join('');
    if ((await sha256Hex(text)) !== depot.sha256) throw new Error(`Reprise : dépôt ${depot.tool} abîmé.`);
    return text;
  }

  /** Les trois fichiers du dernier dépôt, recousus. */
  async files(depots: readonly DepotInfo[]): Promise<ToolFiles> {
    const out: Partial<ToolFiles> = {};
    for (const d of depots) out[d.tool] = await this.content(d);
    return out as ToolFiles;
  }

  private async refuse(viewer: Viewer, kind: string): Promise<Refusal> {
    await appendEvent(
      this.journal,
      { type: 'acces.refuse', actor: `${String(viewer.role)}:${viewer.userId}`, subject: `network:${viewer.networkId}`, data: { rule: 'R16', role: String(viewer.role), kind, code: 'role' } },
      this.now,
    );
    return { ok: false, rule: 'R16', code: 'role' };
  }
}
