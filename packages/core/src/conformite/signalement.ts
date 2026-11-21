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
import { FicheClient } from '../db/fiche-client.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { FicheUnique } from '../fiche/fusion.ts';
import { localTime } from '../envoi/horaires.ts';
import { canonical, caseScopeOf, caseSnapshotOf, compareSnapshots, sha256Hex, type CaseScope, type CaseSnapshot, type FrozenCheck } from './dossier-fige.ts';
import { appendEvent } from '../journal/journal.ts';
import { DispositifLcb } from './dispositif-lcb.ts';
import type { JournalStore } from '../journal/types.ts';

const TIME_ZONE = 'Europe/Paris';
const CASE_REF = /^(mandate|offer|sale_file):([A-Za-z0-9-]{8,64})$/;

export type SuspicionDecisionKind = 'declaration_faite' | 'pas_de_declaration';
export const SUSPICION_DECISIONS: readonly SuspicionDecisionKind[] = ['declaration_faite', 'pas_de_declaration'];

/** Ce que voit l'agent qui a signalé : un mot, toujours le même, quelle que soit la suite. */
export const SUSPICION_AGENT_STATUS = 'transmis';

/** La copie figée : pour chaque table du dossier, chaque ligne par sa clé et son empreinte. */
export type SuspicionSnapshot = CaseSnapshot;
export type { FrozenCheck } from './dossier-fige.ts';

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

export type SuspicionRefusal = { ok: false; rule: 'R16' | 'R94' | null; code: string };

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
  private readonly unique: FicheUnique;

  constructor(
    private readonly db: SqlDatabase,
    private readonly acces: Acces,
    private readonly journal: JournalStore,
    options: { now?: () => Date; newId?: () => string } = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => crypto.randomUUID());
    this.unique = new FicheUnique(db, new FicheClient(db, { now: this.now }), { now: this.now });
    this.dispositif = new DispositifLcb(db, journal, { now: this.now });
  }

  private readonly dispositif: DispositifLcb;

  /** AU089 · le responsable nommé seul lit ; décider demande aussi la procédure approuvée [R94]. */
  private async gate(viewer: Viewer, needProcedure: boolean): Promise<SuspicionRefusal | null> {
    const code = await this.dispositif.officerGate(viewer, needProcedure);
    return code === null ? null : this.refuse(viewer, code);
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


  /**
   * Signale un dossier au responsable. L'agent du client (vue complète) ou le responsable ; tout autre est refusé.
   * Rend à l'agent le seul mot « transmis ».
   */
  async report(viewer: Viewer, caseRef: unknown, input: { note: unknown }): Promise<{ ok: true; status: typeof SUSPICION_AGENT_STATUS } | SuspicionRefusal> {
    if (viewer.role !== 'agent' && viewer.role !== 'compliance') return this.refuse(viewer, 'role');
    const m = typeof caseRef === 'string' ? CASE_REF.exec(caseRef) : null;
    if (!m) return { ok: false, rule: null, code: 'bad_case' };
    if (typeof input.note !== 'string' || input.note.trim() === '' || input.note.length > 4000) return { ok: false, rule: null, code: 'bad_note' };
    const found = await caseScopeOf(this.db, this.unique, viewer.networkId, m[1] as 'mandate' | 'offer' | 'sale_file', m[2]!, { withSale: true });
    if (!found) return { ok: false, rule: null, code: 'unknown_case' };
    const { personId, scope } = found;
    const read = await this.acces.readFiche(viewer, personId);
    if (!read.ok) return { ok: false, rule: 'R16', code: read.code };
    if (viewer.role === 'agent' && read.view !== 'full') return this.refuse(viewer, 'not_assigned');
    const snapshot = await caseSnapshotOf(this.db, scope);
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
        // L'empreinte est permise au journal : le filtre des données personnelles écarte les empreintes SHA-256.
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
    const closed = await this.gate(viewer, false);
    if (closed) return closed;
    await this.ensureEvents(viewer.networkId);
    const rows = await this.db.all<ReportRow>('SELECT * FROM suspicion_reports WHERE network_id = ? ORDER BY reported_at, id', [viewer.networkId]);
    const out: SuspicionReport[] = [];
    for (const row of rows) out.push(await this.toReport(row));
    return { ok: true, value: [...out.filter((r) => r.decision === null), ...out.filter((r) => r.decision !== null)] };
  }

  /** Le dossier est-il resté tel qu'au signalement ? Le responsable seul. */
  async checkFrozen(viewer: Viewer, reportId: string): Promise<{ ok: true; value: FrozenCheck } | SuspicionRefusal> {
    const closed = await this.gate(viewer, false);
    if (closed) return closed;
    const row = await this.db.first<ReportRow>('SELECT * FROM suspicion_reports WHERE id = ? AND network_id = ?', [reportId, viewer.networkId]);
    if (!row) return { ok: false, rule: null, code: 'unknown_report' };
    // La copie se refait sur le même périmètre qu'au signalement : une partie ajoutée depuis n'y entre pas.
    const { scope, snapshot: then } = JSON.parse(row.snapshot) as { scope: CaseScope; snapshot: SuspicionSnapshot };
    const nowSnap = await caseSnapshotOf(this.db, scope);
    return { ok: true, value: compareSnapshots(then, nowSnap) };
  }

  /** Le responsable décide, seul et une seule fois, avec sa raison, son nom et sa date. */
  async decide(
    viewer: Viewer,
    reportId: string,
    input: { decision: unknown; reason: unknown; validatorName: unknown },
  ): Promise<{ ok: true; value: SuspicionReport } | SuspicionRefusal> {
    const closed = await this.gate(viewer, true);
    if (closed) return closed;
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
