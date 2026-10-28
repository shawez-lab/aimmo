/**
 * Signaler au responsable : dossier figé, rien au client (M12, L05) [R13, R16, R17, R94].
 *
 * L'agent du client, ou le responsable, signale un dossier (`mandate:<id>`, `offer:<id>` ou `sale_file:<id>`) avec ce
 * qu'il a vu. Le dossier est figé à cet instant : chaque ligne du dossier (mandat, offre, dossier de vente) et la
 * conformité de chacune de ses parties (coffre, identification, risque, vigilance) sont gardées par leur empreinte, avec l'empreinte de l'ensemble, et le responsable peut à tout moment vérifier que rien
 * n'a changé ni disparu depuis. Le responsable voit le signalement sans délai, dans sa liste, et décide seul, une
 * seule fois, de la déclaration à Tracfin.
 *
 * Jamais vu : le signalement ne touche à rien de ce qui part au client. Aucun autre code, ni le contrôle central des
 * envois, ni les relances, ni les annonces, ne lit ces tables (un test le vérifie) : les messages déjà prévus suivent
 * leur cours, rien n'est ajouté ni retiré, et le client reçoit exactement les mêmes textes avec ou sans signalement.
 * L'agent qui signale ne voit que « transmis » ; tout autre que le responsable ne voit rien, pas même qu'un
 * signalement existe. Le journal range le signalement sous sa propre référence, jamais sous la fiche du client.
 */
import type { Acces } from '../acces/acces.ts';
import type { Viewer } from '../acces/droits.ts';
import type { SqlDatabase, SqlValue } from '../db/sql.ts';
import { localTime } from '../envoi/horaires.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';

const TIME_ZONE = 'Europe/Paris';
const CASE_REF = /^(mandate|offer|sale_file):([A-Za-z0-9-]{8,64})$/;

export type SuspicionDecisionKind = 'declaration_faite' | 'pas_de_declaration';
export const SUSPICION_DECISIONS: readonly SuspicionDecisionKind[] = ['declaration_faite', 'pas_de_declaration'];

/** Ce que voit l'agent qui a signalé : un mot, toujours le même, quelle que soit la suite. */
export const SUSPICION_AGENT_STATUS = 'transmis';

/** La copie figée : pour chaque table du dossier, chaque ligne par sa clé et son empreinte. */
export type SuspicionSnapshot = Record<string, { key: string; sha256: string }[]>;

export interface SuspicionReport {
  reportId: string;
  caseRef: string;
  personId: string;
  note: string;
  reportedBy: string;
  reportedAt: string;
  snapshotSha256: string;
  lines: number;
  decision: { decision: SuspicionDecisionKind; reason: string; validatorName: string; decidedOn: string } | null;
}

export interface FrozenCheck {
  intact: boolean;
  /** Les lignes changées ou disparues depuis le signalement, par table et par clé. */
  changed: { table: string; key: string }[];
  missing: { table: string; key: string }[];
  /** Les lignes ajoutées depuis, qui ne changent pas la copie figée. */
  added: { table: string; key: string }[];
}

export type SuspicionRefusal = { ok: false; rule: 'R16' | 'R94' | null; code: string };

async function sha256Hex(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  return [...digest].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical((value as Record<string, unknown>)[key])]));
  }
  return value;
};

/** Ce que couvre un dossier : ses mandats, ses offres, ses dossiers de vente et toutes ses parties. */
interface CaseScope {
  mandates: string[];
  offers: string[];
  saleFiles: string[];
  persons: string[];
  caseRefs: string[];
}

/** Une partie du dossier : la requête rend chaque ligne, sa clé est la colonne `k`. */
interface Part {
  table: string;
  over: keyof CaseScope;
  sql: (marks: string) => string;
}

const PARTS: Part[] = [
  { table: 'mandates', over: 'mandates', sql: (q) => `SELECT id AS k, * FROM mandates WHERE id IN (${q})` },
  { table: 'mandate_register', over: 'mandates', sql: (q) => `SELECT seq AS k, * FROM mandate_register WHERE mandate_id IN (${q})` },
  { table: 'documents', over: 'mandates', sql: (q) => `SELECT id AS k, * FROM documents WHERE mandate_id IN (${q}) OR id IN (SELECT document_id FROM signed_documents WHERE mandate_id IN (${q}))` },
  { table: 'signed_documents', over: 'mandates', sql: (q) => `SELECT document_id AS k, * FROM signed_documents WHERE mandate_id IN (${q})` },
  { table: 'signed_amendments', over: 'mandates', sql: (q) => `SELECT document_id AS k, * FROM signed_amendments WHERE mandate_id IN (${q})` },
  { table: 'mandate_withdrawals', over: 'mandates', sql: (q) => `SELECT mandate_id AS k, * FROM mandate_withdrawals WHERE mandate_id IN (${q})` },
  { table: 'mandate_early_starts', over: 'mandates', sql: (q) => `SELECT mandate_id AS k, * FROM mandate_early_starts WHERE mandate_id IN (${q})` },
  { table: 'offer_register', over: 'offers', sql: (q) => `SELECT id AS k, * FROM offer_register WHERE id IN (${q})` },
  { table: 'offer_checks', over: 'offers', sql: (q) => `SELECT id AS k, * FROM offer_checks WHERE offer_id IN (${q})` },
  { table: 'offer_transmissions', over: 'offers', sql: (q) => `SELECT offer_id || ':' || at AS k, * FROM offer_transmissions WHERE offer_id IN (${q})` },
  { table: 'offer_responses', over: 'offers', sql: (q) => `SELECT offer_id AS k, * FROM offer_responses WHERE offer_id IN (${q})` },
  { table: 'offer_proposals', over: 'offers', sql: (q) => `SELECT id AS k, * FROM offer_proposals WHERE offer_id IN (${q})` },
  { table: 'sale_files', over: 'saleFiles', sql: (q) => `SELECT id AS k, * FROM sale_files WHERE id IN (${q})` },
  { table: 'sale_file_steps', over: 'saleFiles', sql: (q) => `SELECT file_id || ':' || step || ':' || at AS k, * FROM sale_file_steps WHERE file_id IN (${q})` },
  { table: 'sale_file_pieces', over: 'saleFiles', sql: (q) => `SELECT id AS k, * FROM sale_file_pieces WHERE file_id IN (${q})` },
  { table: 'sale_file_dates', over: 'saleFiles', sql: (q) => `SELECT file_id || ':' || kind || ':' || version AS k, * FROM sale_file_dates WHERE file_id IN (${q})` },
  { table: 'sale_file_financing', over: 'saleFiles', sql: (q) => `SELECT file_id || ':' || seq AS k, * FROM sale_file_financing WHERE file_id IN (${q})` },
  { table: 'sale_file_closings', over: 'saleFiles', sql: (q) => `SELECT file_id AS k, * FROM sale_file_closings WHERE file_id IN (${q})` },
  // La conformité de chaque partie : coffre, identification, bénéficiaires effectifs, risque, vigilance.
  { table: 'compliance_vault_pieces', over: 'persons', sql: (q) => `SELECT id AS k, * FROM compliance_vault_pieces WHERE person_id IN (${q})` },
  { table: 'identity_checks', over: 'persons', sql: (q) => `SELECT id AS k, * FROM identity_checks WHERE person_id IN (${q})` },
  { table: 'client_identifications', over: 'persons', sql: (q) => `SELECT id AS k, * FROM client_identifications WHERE person_id IN (${q})` },
  {
    table: 'beneficial_owners',
    over: 'persons',
    sql: (q) => `SELECT declaration_id || ':' || owner_person_id AS k, * FROM beneficial_owners WHERE declaration_id IN (SELECT id FROM client_identifications WHERE person_id IN (${q}))`,
  },
  { table: 'risk_sheets', over: 'persons', sql: (q) => `SELECT id AS k, * FROM risk_sheets WHERE person_id IN (${q})` },
  { table: 'risk_validations', over: 'persons', sql: (q) => `SELECT id AS k, * FROM risk_validations WHERE sheet_id IN (SELECT id FROM risk_sheets WHERE person_id IN (${q}))` },
  { table: 'vigilance_alerts', over: 'persons', sql: (q) => `SELECT id AS k, * FROM vigilance_alerts WHERE person_id IN (${q})` },
  { table: 'vigilance_decisions', over: 'persons', sql: (q) => `SELECT id AS k, * FROM vigilance_decisions WHERE alert_id IN (SELECT id FROM vigilance_alerts WHERE person_id IN (${q}))` },
];

const unique = (values: (string | null | undefined)[]): string[] => [...new Set(values.filter((v): v is string => typeof v === 'string'))].sort();

interface ReportRow {
  id: string;
  network_id: string;
  case_ref: string;
  person_id: string;
  note: string;
  snapshot: string;
  snapshot_sha256: string;
  reported_by: string;
  reported_at: string;
}

export class SignalementSoupcon {
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(
    private readonly db: SqlDatabase,
    private readonly acces: Acces,
    private readonly journal: JournalStore,
    options: { now?: () => Date; newId?: () => string } = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => crypto.randomUUID());
  }

  private actor(viewer: Viewer): string {
    return `${String(viewer.role)}:${viewer.userId}`;
  }

  /** Un refus dit le moins possible : jamais si un signalement existe. */
  private async refuse(viewer: Viewer, code: string): Promise<SuspicionRefusal> {
    await appendEvent(
      this.journal,
      { type: 'acces.refuse', actor: this.actor(viewer), subject: `network:${viewer.networkId}`, data: { rule: 'R16', role: String(viewer.role), kind: 'conformite', code } },
      this.now,
    );
    return { ok: false, rule: 'R16', code };
  }

  /** Le dossier et toutes ses parties : l'acquéreur, et le vendeur de chaque mandat du bien. `null` s'il est inconnu. */
  private async scopeOf(networkId: string, kind: 'mandate' | 'offer' | 'sale_file', id: string): Promise<{ personId: string; scope: CaseScope } | null> {
    const scope: CaseScope = { mandates: [], offers: [], saleFiles: [], persons: [], caseRefs: [] };
    let personId: string;
    if (kind === 'mandate') {
      const row = await this.db.first<{ network_id: string; person_id: string }>('SELECT network_id, person_id FROM mandates WHERE id = ?', [id]);
      if (!row || row.network_id !== networkId) return null;
      personId = row.person_id;
      scope.mandates = [id];
    } else {
      let offerId = id;
      if (kind === 'sale_file') {
        const file = await this.db.first<{ network_id: string; offer_id: string }>('SELECT network_id, offer_id FROM sale_files WHERE id = ?', [id]);
        if (!file || file.network_id !== networkId) return null;
        scope.saleFiles = [id];
        offerId = file.offer_id;
      }
      const offer = await this.db.first<{ network_id: string; buyer_person_id: string; property_id: string }>('SELECT network_id, buyer_person_id, property_id FROM offer_register WHERE id = ?', [offerId]);
      if (!offer || offer.network_id !== networkId) return null;
      personId = offer.buyer_person_id;
      scope.offers = [offerId];
      const mandates = await this.db.all<{ id: string; person_id: string }>('SELECT id, person_id FROM mandates WHERE network_id = ? AND property_id = ?', [networkId, offer.property_id]);
      scope.mandates = unique(mandates.map((m) => m.id));
      scope.persons = unique(mandates.map((m) => m.person_id));
    }
    scope.persons = unique([personId, ...scope.persons]);
    scope.caseRefs = unique([...scope.mandates.map((m) => `mandate:${m}`), ...scope.offers.map((o) => `offer:${o}`), ...scope.saleFiles.map((f) => `sale_file:${f}`)]);
    return { personId, scope };
  }

  /** La copie du dossier, ligne par ligne, par empreinte. */
  private async snapshotOf(scope: CaseScope): Promise<SuspicionSnapshot> {
    const snapshot: SuspicionSnapshot = {};
    for (const part of PARTS) {
      const ids = scope[part.over];
      const lines: { key: string; sha256: string }[] = [];
      if (ids.length > 0) {
        const sql = part.sql(ids.map(() => '?').join(', '));
        const repeats = (sql.match(/\?/g) ?? []).length / ids.length;
        const params: SqlValue[] = [];
        for (let i = 0; i < repeats; i++) params.push(...ids);
        for (const row of await this.db.all<Record<string, unknown> & { k: unknown }>(sql, params)) {
          const { k, ...rest } = row;
          lines.push({ key: String(k), sha256: await sha256Hex(JSON.stringify(canonical(rest))) });
        }
      }
      lines.sort((x, y) => (x.key < y.key ? -1 : x.key > y.key ? 1 : 0));
      snapshot[part.table] = lines;
    }
    return snapshot;
  }

  /**
   * Signale un dossier au responsable. L'agent du client (vue complète) ou le responsable ; tout autre est refusé.
   * Rend à l'agent le seul mot « transmis ».
   */
  async report(viewer: Viewer, caseRef: unknown, input: { note: unknown }): Promise<{ ok: true; status: typeof SUSPICION_AGENT_STATUS } | SuspicionRefusal> {
    if (viewer.role !== 'agent' && viewer.role !== 'compliance') return this.refuse(viewer, 'role');
    const m = typeof caseRef === 'string' ? CASE_REF.exec(caseRef) : null;
    if (!m) return { ok: false, rule: null, code: 'bad_case' };
    if (typeof input.note !== 'string' || input.note.trim() === '' || input.note.length > 4000) return { ok: false, rule: null, code: 'bad_note' };
    const found = await this.scopeOf(viewer.networkId, m[1] as 'mandate' | 'offer' | 'sale_file', m[2]!);
    if (!found) return { ok: false, rule: null, code: 'unknown_case' };
    const { personId, scope } = found;
    const read = await this.acces.readFiche(viewer, personId);
    if (!read.ok) return { ok: false, rule: 'R16', code: read.code };
    if (viewer.role === 'agent' && read.view !== 'full') return this.refuse(viewer, 'not_assigned');
    const snapshot = await this.snapshotOf(scope);
    const text = JSON.stringify(canonical({ scope, snapshot }));
    const id = this.newId();
    await this.db.run(
      `INSERT INTO suspicion_reports (id, network_id, case_ref, person_id, note, snapshot, snapshot_sha256, reported_by, reported_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, viewer.networkId, caseRef as string, personId, input.note.trim(), text, await sha256Hex(text), this.actor(viewer), this.now().toISOString()],
    );
    await this.ensureEvents(viewer.networkId);
    return { ok: true, status: SUSPICION_AGENT_STATUS };
  }

  /** Chaque signalement et chaque décision rangés ont leur événement au journal : un manquant est repris, une fois. */
  private async ensureEvents(networkId: string): Promise<void> {
    const rows = await this.db.all<{ id: string; reported_by: string; snapshot_sha256: string; decision: string | null; decided_by: string | null }>(
      `SELECT r.id, r.reported_by, r.snapshot_sha256, d.decision, d.decided_by FROM suspicion_reports r
       LEFT JOIN suspicion_decisions d ON d.report_id = r.id WHERE r.network_id = ? ORDER BY r.reported_at, r.id`,
      [networkId],
    );
    for (const r of rows) {
      const subject = `suspicion_report:${r.id}`;
      const types = new Set((await this.journal.bySubject(subject)).map((e) => e.type));
      if (!types.has('conformite.signalement')) {
        await appendEvent(this.journal, { type: 'conformite.signalement', actor: r.reported_by, subject, data: { rule: 'R94', snapshot: r.snapshot_sha256 } }, this.now);
      }
      if (r.decision !== null && !types.has('conformite.signalement_decision')) {
        await appendEvent(this.journal, { type: 'conformite.signalement_decision', actor: r.decided_by!, subject, data: { rule: 'R94', decision: r.decision } }, this.now);
      }
    }
  }

  private async toReport(row: ReportRow): Promise<SuspicionReport> {
    const d = await this.db.first<{ decision: SuspicionDecisionKind; reason: string; validator_name: string; decided_on: string }>(
      'SELECT decision, reason, validator_name, decided_on FROM suspicion_decisions WHERE report_id = ?',
      [row.id],
    );
    const { snapshot } = JSON.parse(row.snapshot) as { snapshot: SuspicionSnapshot };
    return {
      reportId: row.id,
      caseRef: row.case_ref,
      personId: row.person_id,
      note: row.note,
      reportedBy: row.reported_by,
      reportedAt: row.reported_at,
      snapshotSha256: row.snapshot_sha256,
      lines: Object.values(snapshot).reduce((n, lines) => n + lines.length, 0),
      decision: d ? { decision: d.decision, reason: d.reason, validatorName: d.validator_name, decidedOn: d.decided_on } : null,
    };
  }

  /** Les signalements du réseau, ceux qui attendent une décision d'abord : le responsable seul. */
  async list(viewer: Viewer): Promise<{ ok: true; value: SuspicionReport[] } | SuspicionRefusal> {
    if (viewer.role !== 'compliance') return this.refuse(viewer, 'role');
    await this.ensureEvents(viewer.networkId);
    const rows = await this.db.all<ReportRow>('SELECT * FROM suspicion_reports WHERE network_id = ? ORDER BY reported_at, id', [viewer.networkId]);
    const out: SuspicionReport[] = [];
    for (const row of rows) out.push(await this.toReport(row));
    return { ok: true, value: [...out.filter((r) => r.decision === null), ...out.filter((r) => r.decision !== null)] };
  }

  /** Le dossier est-il resté tel qu'au signalement ? Le responsable seul. */
  async checkFrozen(viewer: Viewer, reportId: string): Promise<{ ok: true; value: FrozenCheck } | SuspicionRefusal> {
    if (viewer.role !== 'compliance') return this.refuse(viewer, 'role');
    const row = await this.db.first<ReportRow>('SELECT * FROM suspicion_reports WHERE id = ? AND network_id = ?', [reportId, viewer.networkId]);
    if (!row) return { ok: false, rule: null, code: 'unknown_report' };
    // La copie se refait sur le même périmètre qu'au signalement : une partie ajoutée depuis n'y entre pas.
    const { scope, snapshot: then } = JSON.parse(row.snapshot) as { scope: CaseScope; snapshot: SuspicionSnapshot };
    const nowSnap = await this.snapshotOf(scope);
    const out: FrozenCheck = { intact: true, changed: [], missing: [], added: [] };
    for (const table of Object.keys(then)) {
      const current = new Map((nowSnap[table] ?? []).map((l) => [l.key, l.sha256]));
      for (const line of then[table]!) {
        const sha = current.get(line.key);
        if (sha === undefined) out.missing.push({ table, key: line.key });
        else if (sha !== line.sha256) out.changed.push({ table, key: line.key });
      }
      const before = new Set(then[table]!.map((l) => l.key));
      for (const line of nowSnap[table] ?? []) if (!before.has(line.key)) out.added.push({ table, key: line.key });
    }
    out.intact = out.changed.length === 0 && out.missing.length === 0;
    return { ok: true, value: out };
  }

  /** Le responsable décide, seul et une seule fois, avec sa raison, son nom et sa date. */
  async decide(
    viewer: Viewer,
    reportId: string,
    input: { decision: unknown; reason: unknown; validatorName: unknown },
  ): Promise<{ ok: true; value: SuspicionReport } | SuspicionRefusal> {
    if (viewer.role !== 'compliance') return this.refuse(viewer, 'role');
    if (!SUSPICION_DECISIONS.includes(input.decision as SuspicionDecisionKind)) return { ok: false, rule: null, code: 'bad_decision' };
    if (typeof input.reason !== 'string' || input.reason.trim() === '' || input.reason.length > 4000) return { ok: false, rule: null, code: 'bad_reason' };
    if (typeof input.validatorName !== 'string' || input.validatorName.trim() === '' || input.validatorName.length > 120) return { ok: false, rule: null, code: 'missing_name' };
    const row = await this.db.first<ReportRow>('SELECT * FROM suspicion_reports WHERE id = ? AND network_id = ?', [reportId, viewer.networkId]);
    if (!row) return { ok: false, rule: null, code: 'unknown_report' };
    const { changes } = await this.db.run(
      `INSERT INTO suspicion_decisions (report_id, network_id, decision, reason, validator_name, decided_by, decided_on, at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (report_id) DO NOTHING`,
      [reportId, viewer.networkId, input.decision as string, input.reason.trim(), input.validatorName.trim(), this.actor(viewer), localTime(this.now(), TIME_ZONE).date, this.now().toISOString()],
    );
    await this.ensureEvents(viewer.networkId);
    if (changes === 0) return { ok: false, rule: null, code: 'already_decided' };
    return { ok: true, value: await this.toReport(row) };
  }
}
