/**
 * Export complet des données d'un agent, avec son empreinte (M13, HX62, « Jamais vu ») [R13, R16, R561].
 *
 * À tout moment, un agent actif emporte en un fichier tout ce que le réseau range à son nom : sa fiche, les fiches
 * qu'il suit et les contacts qui lui ont été attribués, ses rendez-vous, ses mandats, ses biens, ses ventes, ses parts de commission et ses
 * rapports enregistrés. Rien d'un autre agent n'y entre, pas même un identifiant (parrain, attribution remplacée). Les clients n'y figurent que par leurs identifiants : leurs
 * fiches sont à eux et au réseau, et se demandent par les droits de la personne (M12).
 *
 * Le fichier porte son empreinte SHA-256, calculée sur son écriture canonique ; AIMMO range l'empreinte, jamais le
 * contenu. N'importe qui peut ensuite vérifier qu'un fichier vient d'AIMMO et n'a pas changé d'un octet.
 * L'agent seul tire son export : ni la direction ni un autre rôle ne le tire à sa place [R16].
 */
import type { Viewer } from '../acces/droits.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { localTime } from '../envoi/horaires.ts';
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
    /** Les fiches qu'il suit, par leur identifiant seul, même sans attribution (une reprise, par exemple). */
    contacts: Row[];
    attributions: Row[];
    appointments: Row[];
    mandates: Row[];
    properties: Row[];
    sales: Row[];
    commissionShares: Row[];
    customReports: Row[];
    /** AU110 · export de reprise autorisé : les fiches de ses clients, avec leurs coordonnées et leurs consentements. */
    clients?: Row[];
    clientIdentifiers?: Row[];
    clientConsents?: Row[];
    /** AU110 · périmètre « avec pièces » : les références des pièces de son portefeuille, chacune avec sa table. */
    files?: Row[];
  };
  /** AU110 · le périmètre et le contrat de l'export de reprise ; absent pour l'export de l'agent seul. */
  authorization?: { id: string; scope: ExportScope; contractRef: string; expiresOn: string };
  /** AU110 · ce que le périmètre écarte, compté par table : une ligne qui désigne un client hors de ses fiches. */
  excluded?: Record<string, number>;
}

export const EXPORT_SCOPES = ['clients', 'clients_pieces'] as const;
export type ExportScope = (typeof EXPORT_SCOPES)[number];
/** La durée d'une autorisation d'export de reprise, en jours, au plus. */
export const EXPORT_AUTHORIZATION_DAYS = 90;

/**
 * Les références orphelines d'un export (AU110) : chaque client, bien ou mandat désigné par une ligne doit avoir sa ligne
 * dans l'export. Vide pour un export de reprise : il s'importe dans un environnement de contrôle tel quel.
 */
export function exportOrphans(doc: AgentExport): string[] {
  const t = doc.tables;
  const persons = new Set((t.contacts ?? []).map((r) => String(r.id)));
  const props = new Set((t.properties ?? []).map((r) => String(r.id)));
  const mandates = new Set((t.mandates ?? []).map((r) => String(r.id)));
  const out: string[] = [];
  const check = (table: string, rows: Row[] | undefined, column: string, known: Set<string>) => {
    for (const r of rows ?? []) {
      const v = r[column];
      if (v !== null && v !== undefined && !known.has(String(v))) out.push(`${table}.${column}:${String(v)}`);
    }
  };
  check('attributions', t.attributions, 'person_id', persons);
  check('appointments', t.appointments, 'person_id', persons);
  check('appointments', t.appointments, 'property_id', props);
  check('mandates', t.mandates, 'person_id', persons);
  check('mandates', t.mandates, 'property_id', props);
  check('sales', t.sales, 'mandate_id', mandates);
  if (t.clients) {
    const clients = new Set(t.clients.map((r) => String(r.id)));
    for (const id of persons) if (!clients.has(id)) out.push(`clients.id:${id}`);
    check('clientIdentifiers', t.clientIdentifiers, 'person_id', clients);
    check('clientConsents', t.clientConsents, 'person_id', clients);
  }
  return out.sort();
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

type Refusal = { ok: false; rule: 'R16' | 'R601'; code: string };

/** La porte du second facteur (HX56, `ClesAppareil.requireSecondFactor`) [R601]. */
export interface SecondFactorGate {
  requireSecondFactor(viewer: Viewer, action: 'export_complet', subject: string, stepUpId: unknown): Promise<{ ok: true } | { ok: false; rule: string; code: string }>;
}

export class ExportAgent {
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(
    private readonly db: SqlDatabase,
    private readonly journal: JournalStore,
    /** L'export complet est une action sensible : il exige la preuve d'une clé d'appareil active, pour lui seul [R601]. */
    private readonly secondFactor: SecondFactorGate,
    options: { now?: () => Date; newId?: () => string } = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => crypto.randomUUID());
  }

  /**
   * AU110 · La direction autorise un export de reprise, au vu d'un contrat : son périmètre (les fiches des clients de
   * l'agent, et leurs pièces s'il le dit), la référence du contrat, et sa durée, 90 jours au plus [R16].
   */
  async authorize(viewer: Viewer, agentId: string, input: { scope: unknown; contractRef: unknown; days?: unknown }): Promise<{ ok: true; value: { id: string; expiresOn: string } } | Refusal | { ok: false; rule: null; code: 'bad_scope' | 'bad_contract' | 'bad_days' | 'unknown_agent' }> {
    if (viewer.role !== 'direction') {
      await appendEvent(this.journal, { type: 'acces.refuse', actor: `${String(viewer.role)}:${viewer.userId}`, subject: `agent:${agentId}`, data: { rule: 'R16', role: String(viewer.role), kind: 'agent_export_authorization', code: 'role' } }, this.now);
      return { ok: false, rule: 'R16', code: 'role' };
    }
    const agent = await this.db.first<{ network_id: string }>('SELECT network_id FROM agents WHERE id = ?', [agentId]);
    if (!agent || agent.network_id !== viewer.networkId) return { ok: false, rule: null, code: 'unknown_agent' };
    if (typeof input.scope !== 'string' || !(EXPORT_SCOPES as readonly string[]).includes(input.scope)) return { ok: false, rule: null, code: 'bad_scope' };
    if (typeof input.contractRef !== 'string' || input.contractRef.trim() === '' || input.contractRef.length > 200) return { ok: false, rule: null, code: 'bad_contract' };
    const days = input.days === undefined ? 30 : input.days;
    if (typeof days !== 'number' || !Number.isInteger(days) || days < 1 || days > EXPORT_AUTHORIZATION_DAYS) return { ok: false, rule: null, code: 'bad_days' };
    const end = new Date(`${localTime(this.now(), 'Europe/Paris').date}T12:00:00.000Z`);
    end.setUTCDate(end.getUTCDate() + days);
    const expiresOn = end.toISOString().slice(0, 10);
    const id = this.newId();
    await this.db.run('INSERT INTO agent_export_authorizations (id, network_id, agent_id, scope, contract_ref, expires_on, granted_by, granted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [
      id,
      viewer.networkId,
      agentId,
      input.scope,
      input.contractRef.trim(),
      expiresOn,
      `direction:${viewer.userId}`,
      this.now().toISOString(),
    ]);
    await appendEvent(this.journal, { type: 'export.autorise', actor: `direction:${viewer.userId}`, subject: `agent:${agentId}`, data: { authorization: id, scope: input.scope, expiresOn } }, this.now);
    return { ok: true, value: { id, expiresOn } };
  }

  /**
   * Tire l'export complet de l'agent lecteur, sur la preuve du second facteur, et range son empreinte [R601]. Avec une
   * autorisation de la direction en cours (AU110), l'export de reprise porte aussi les fiches de ses clients et, si le
   * périmètre le dit, les références de ses pièces ; une ligne qui désigne un client hors de ses fiches est écartée et
   * comptée, pour qu'il s'importe sans référence orpheline.
   */
  async make(viewer: Viewer, stepUpId?: unknown, options: { authorizationId?: string } = {}): Promise<{ ok: true; value: { document: AgentExport; fingerprint: string } } | Refusal> {
    const refuse = async (code: string): Promise<Refusal> => {
      await appendEvent(this.journal, { type: 'acces.refuse', actor: `${String(viewer.role)}:${viewer.userId}`, subject: `network:${viewer.networkId}`, data: { rule: 'R16', role: String(viewer.role), kind: 'agent_export', code } }, this.now);
      return { ok: false, rule: 'R16', code };
    };
    if (viewer.role !== 'agent') return refuse('role');
    const me = await this.db.first<{ network_id: string; status: string }>('SELECT network_id, status FROM agents WHERE id = ?', [viewer.userId]);
    if (!me || me.network_id !== viewer.networkId || me.status !== 'active') return refuse('agent_inactive');
    // Avant toute lecture : sans preuve pour cet export, rien n'est lu (la porte écrit son refus au journal) [R601].
    const proof = await this.secondFactor.requireSecondFactor(viewer, 'export_complet', `agent:${viewer.userId}`, stepUpId);
    if (!proof.ok) return { ok: false, rule: 'R601', code: proof.code };
    const net = viewer.networkId;
    const id = viewer.userId;
    const q = (sql: string, args: string[] = [net, id]) => this.db.all<Row>(sql, args);
    let auth: { id: string; scope: ExportScope; contract_ref: string; expires_on: string } | null = null;
    if (options.authorizationId !== undefined) {
      auth = await this.db.first<{ id: string; scope: ExportScope; contract_ref: string; expires_on: string }>(
        'SELECT id, scope, contract_ref, expires_on FROM agent_export_authorizations WHERE id = ? AND network_id = ? AND agent_id = ?',
        [options.authorizationId, net, id],
      );
      if (!auth || auth.expires_on < localTime(this.now(), 'Europe/Paris').date) return refuse('no_authorization');
    }

    const tables: AgentExport['tables'] = {
      agent: await q('SELECT id, first_name, last_name, zone, status, created_at, updated_at FROM agents WHERE network_id = ? AND id = ?'),
      contacts: await q('SELECT id, created_at FROM persons WHERE network_id = ? AND agent_id = ? ORDER BY created_at, id'),
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
    let extra: Pick<AgentExport, 'authorization' | 'excluded'> = {};
    if (auth) {
      // Ses fiches seules, avec ce qu'il faut pour reprendre le suivi : nom, coordonnées, consentements.
      tables.clients = await q('SELECT id, first_name, last_name, created_at FROM persons WHERE network_id = ? AND agent_id = ? ORDER BY created_at, id');
      const mine = new Set(tables.clients.map((r) => String(r.id)));
      tables.clientIdentifiers = (await q('SELECT i.person_id, i.kind, i.value FROM person_identifiers i JOIN persons p ON p.id = i.person_id WHERE p.network_id = ? AND p.agent_id = ? ORDER BY i.person_id, i.kind, i.value'));
      tables.clientConsents = await q('SELECT c.person_id, c.purpose, c.channel, c.given_at, c.withdrawn_at FROM consents c JOIN persons p ON p.id = c.person_id WHERE p.network_id = ? AND p.agent_id = ? ORDER BY c.person_id, c.given_at, c.id');
      // Une ligne qui désigne un client hors de ses fiches, ou un bien hors des siens, n'est pas à lui : écartée et comptée.
      const props = new Set(tables.properties.map((r) => String(r.id)));
      const keep = (r: Row) => (r.person_id === null || r.person_id === undefined || mine.has(String(r.person_id))) && (r.property_id === null || r.property_id === undefined || props.has(String(r.property_id)));
      const excluded: Record<string, number> = {};
      for (const key of ['attributions', 'appointments', 'mandates'] as const) {
        const before = tables[key].length;
        tables[key] = tables[key].filter(keep);
        if (tables[key].length !== before) excluded[key] = before - tables[key].length;
      }
      const mandateIds = new Set(tables.mandates.map((r) => String(r.id)));
      const sales = tables.sales.length;
      tables.sales = tables.sales.filter((r) => mandateIds.has(String(r.mandate_id)));
      if (tables.sales.length !== sales) excluded.sales = sales - tables.sales.length;
      if (auth.scope === 'clients_pieces') {
        // Les pièces de son portefeuille : scans des mandats et avenants signés, et photos de ses biens.
        const files: Row[] = [
          ...(await q(`SELECT 'signed_documents' AS "table", s.scan_ref AS ref FROM signed_documents s JOIN documents d ON d.id = s.document_id WHERE d.network_id = ? AND d.agent_id = ? AND s.scan_ref IS NOT NULL ORDER BY s.scan_ref`)),
          ...(await q(`SELECT 'signed_amendments' AS "table", a.scan_ref AS ref FROM signed_amendments a JOIN documents d ON d.id = a.document_id WHERE d.network_id = ? AND d.agent_id = ? AND a.scan_ref IS NOT NULL ORDER BY a.scan_ref`)),
        ];
        for (const p of tables.properties) {
          const sheet = await this.db.first<{ data: string }>('SELECT data FROM property_sheets WHERE property_id = ? ORDER BY version DESC LIMIT 1', [String(p.id)]);
          let media: { ref?: unknown }[] = [];
          try {
            media = sheet ? ((JSON.parse(sheet.data) as { media?: { ref?: unknown }[] }).media ?? []) : [];
          } catch {
            media = [];
          }
          for (const m of media) if (typeof m.ref === 'string') files.push({ table: 'property_sheets', ref: m.ref, property_id: String(p.id) });
        }
        tables.files = files;
      }
      extra = { authorization: { id: auth.id, scope: auth.scope, contractRef: auth.contract_ref, expiresOn: auth.expires_on }, ...(Object.keys(excluded).length > 0 ? { excluded } : {}) };
    }
    const document: AgentExport = { format: EXPORT_FORMAT, networkId: net, agentId: id, madeAt: this.now().toISOString(), tables, ...extra };
    const fingerprint = await fingerprintOf(document);
    const rowCount = Object.values(tables).reduce((a, t) => a + t.length, 0);
    await this.db.run('INSERT OR IGNORE INTO agent_exports (id, network_id, agent_id, fingerprint, row_count, made_at) VALUES (?, ?, ?, ?, ?, ?)', [this.newId(), net, id, fingerprint, rowCount, document.madeAt]);
    // Au journal : l'empreinte et les comptes, jamais le contenu [R13].
    await appendEvent(this.journal, { type: 'export.agent', actor: `agent:${id}`, subject: `agent:${id}`, data: { fingerprint, rows: rowCount, ...(auth ? { authorization: auth.id, scope: auth.scope } : {}) } }, this.now);
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
