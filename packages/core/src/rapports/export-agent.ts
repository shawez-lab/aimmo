/**
 * Export complet des données d'un agent, avec son empreinte (M13, HX62, « Jamais vu ») [R13, R16, R561].
 *
 * À tout moment, un agent actif emporte en un fichier tout ce que le réseau range à son nom : sa fiche, les contacts
 * qui lui ont été attribués, ses rendez-vous, ses mandats, ses biens, ses ventes, ses parts de commission et ses
 * rapports enregistrés. Rien d'un autre agent n'y entre, pas même un identifiant (parrain, attribution remplacée). Les clients n'y figurent que par leurs identifiants : leurs
 * fiches sont à eux et au réseau, et se demandent par les droits de la personne (M12).
 *
 * Le fichier porte son empreinte SHA-256, calculée sur son écriture canonique ; AIMMO range l'empreinte, jamais le
 * contenu. N'importe qui peut ensuite vérifier qu'un fichier vient d'AIMMO et n'a pas changé d'un octet.
 * L'agent seul tire son export : ni la direction ni un autre rôle ne le tire à sa place [R16].
 */
import type { Viewer } from '../acces/droits.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';

export const EXPORT_FORMAT = 'aimmo-export-agent/1';

type Json = string | number | boolean | null | Json[] | { [k: string]: Json };
type Row = Record<string, Json>;

export interface AgentExport {
  format: typeof EXPORT_FORMAT;
  networkId: string;
  agentId: string;
  madeAt: string;
  tables: {
    agent: Row[];
    attributions: Row[];
    appointments: Row[];
    mandates: Row[];
    properties: Row[];
    sales: Row[];
    commissionShares: Row[];
    customReports: Row[];
  };
}

/** Écriture canonique : clés triées, sans espace, pour que la même donnée donne toujours la même empreinte. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
      .join(',')}}`;
  }
  if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('Nombre non fini dans un export.');
  return JSON.stringify(value);
}

export async function fingerprintOf(doc: unknown): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalJson(doc)));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

type Refusal = { ok: false; rule: 'R16'; code: string };

export class ExportAgent {
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

  /** Tire l'export complet de l'agent lecteur, et range son empreinte. */
  async make(viewer: Viewer): Promise<{ ok: true; value: { document: AgentExport; fingerprint: string } } | Refusal> {
    const refuse = async (code: string): Promise<Refusal> => {
      await appendEvent(this.journal, { type: 'acces.refuse', actor: `${String(viewer.role)}:${viewer.userId}`, subject: `network:${viewer.networkId}`, data: { rule: 'R16', role: String(viewer.role), kind: 'agent_export', code } }, this.now);
      return { ok: false, rule: 'R16', code };
    };
    if (viewer.role !== 'agent') return refuse('role');
    const me = await this.db.first<{ network_id: string; status: string }>('SELECT network_id, status FROM agents WHERE id = ?', [viewer.userId]);
    if (!me || me.network_id !== viewer.networkId || me.status !== 'active') return refuse('agent_inactive');
    const net = viewer.networkId;
    const id = viewer.userId;
    const q = (sql: string, args: string[] = [net, id]) => this.db.all<Row>(sql, args);

    const tables: AgentExport['tables'] = {
      agent: await q('SELECT id, first_name, last_name, zone, status, created_at, updated_at FROM agents WHERE network_id = ? AND id = ?'),
      attributions: await q('SELECT id, person_id, reason, callback_hours, created_at FROM attributions WHERE network_id = ? AND agent_id = ? ORDER BY created_at, id'),
      appointments: await q('SELECT id, person_id, property_id, kind, start_at, end_at, status, source, created_at FROM appointments WHERE network_id = ? AND agent_id = ? ORDER BY start_at, id'),
      mandates: await q('SELECT id, person_id, project_id, property_id, signed_at, source_kind, created_at FROM mandates WHERE network_id = ? AND agent_id = ? ORDER BY signed_at, id'),
      properties: await q('SELECT id, reference, kind, postal_code, city, surface_m2, rooms, price_eur, status, created_at FROM properties WHERE network_id = ? AND agent_id = ? ORDER BY created_at, id'),
      sales: await q('SELECT file_id, mandate_id, fee_eur, fee_charge, due_on, status FROM sale_commissions WHERE network_id = ? AND agent_id = ? ORDER BY due_on, file_id'),
      commissionShares: await q(
        `SELECT s.file_id, s.seq, s.kind, s.reason, s.amount_cents FROM commission_shares s JOIN commissions c ON c.file_id = s.file_id
         WHERE c.network_id = ? AND s.beneficiary_id = ? ORDER BY s.file_id, s.seq`,
      ),
      customReports: await q("SELECT id, name, definition, created_at FROM custom_reports WHERE network_id = ? AND owner_id = ? AND owner_role = 'agent' ORDER BY created_at, id"),
    };
    const document: AgentExport = { format: EXPORT_FORMAT, networkId: net, agentId: id, madeAt: this.now().toISOString(), tables };
    const fingerprint = await fingerprintOf(document);
    const rowCount = Object.values(tables).reduce((a, t) => a + t.length, 0);
    await this.db.run('INSERT OR IGNORE INTO agent_exports (id, network_id, agent_id, fingerprint, row_count, made_at) VALUES (?, ?, ?, ?, ?, ?)', [this.newId(), net, id, fingerprint, rowCount, document.madeAt]);
    // Au journal : l'empreinte et les comptes, jamais le contenu [R13].
    await appendEvent(this.journal, { type: 'export.agent', actor: `agent:${id}`, subject: `agent:${id}`, data: { fingerprint, rows: rowCount } }, this.now);
    return { ok: true, value: { document, fingerprint } };
  }

  /**
   * Vérifie un fichier d'export : son empreinte recalculée doit être celle qu'AIMMO a rangée en le remettant à cet
   * agent ; un octet changé, et elle ne l'est plus. Ne lit que
   * l'empreinte rangée : rien du contenu n'est rendu ni gardé.
   */
  async verify(document: unknown): Promise<{ verified: boolean; fingerprint: string | null }> {
    if (document === null || typeof document !== 'object' || (document as { format?: unknown }).format !== EXPORT_FORMAT) return { verified: false, fingerprint: null };
    let fingerprint: string;
    try {
      fingerprint = await fingerprintOf(document);
    } catch {
      return { verified: false, fingerprint: null };
    }
    const d = document as { agentId?: unknown; networkId?: unknown };
    const row = await this.db.first<{ id: string }>('SELECT id FROM agent_exports WHERE agent_id = ? AND network_id = ? AND fingerprint = ?', [String(d.agentId), String(d.networkId), fingerprint]);
    return { verified: Boolean(row), fingerprint };
  }
}
