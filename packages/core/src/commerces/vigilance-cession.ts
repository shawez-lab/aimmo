/**
 * Vigilance renforcée de la cession d'un fonds (M16, CE08) [R118, R14, R15, R16, R17].
 *
 * L'agent du bien range l'acquéreur du dossier de cession (une personne de la base, physique ou morale). Avant le
 * compromis, le code regarde au coffre de la conformité (M12), par son seul état, si les bénéficiaires effectifs (pour
 * une personne morale : le registre des bénéficiaires) et l'origine des fonds y ont été déposés. S'il en manque, une
 * alerte est levée au responsable de la conformité, une seule par dossier et par acquéreur (un acquéreur substitué
 * est examiné à son tour). Une personne morale l'est si l'agent la range telle ou au moindre signe de société (Kbis au
 * coffre, déclaration « société » de L03). Elle ne bloque ni ne décide rien : ni la
 * cession prête (CE07), ni l'envoi du dossier ne la lisent ; la décision reste au responsable, avec son nom, sa date et
 * sa raison [R14], selon les décisions du registre de vigilance de L04.
 *
 * Aucune pièce, aucun montant ni aucune donnée de fonds n'est lu ni rangé ici, ni dans la fiche, ni envoyé à une IA :
 * seulement « déposé ou non » [R15]. L'agent ne voit jamais l'alerte : seulement, si le responsable l'a décidé, la
 * demande neutre d'origine des fonds de L04, identique pour tous. Le journal range l'alerte sous sa propre référence,
 * jamais sous le bien ni la personne [R13].
 *
 * Décidé, lecture prudente : « avant le compromis » se lit tant que la cession n'est pas signée ; l'examen se fait à
 * chaque acquéreur rangé et par la tâche quotidienne ; les alertes vivent dans leur table et s'ajouteront à la liste du
 * responsable de L04 au branchement (CE10).
 */
import type { Acces } from '../acces/acces.ts';
import type { Viewer } from '../acces/droits.ts';
import type { VaultPieceKind } from '../conformite/coffre.ts';
import { FicheClient } from '../db/fiche-client.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { FicheUnique } from '../fiche/fusion.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import { FUNDS_REQUEST_DOCUMENTS, FUNDS_REQUEST_TEXT, VIGILANCE_DECISIONS, type VigilanceDecisionKind } from '../conformite/vigilance.ts';

/** Ce que le contrôle lit du coffre : déposé ou non, rien d'autre [R15]. */
export interface VaultDeposits {
  everDeposited(networkId: string, personId: string, kinds: readonly VaultPieceKind[], before: Date): Promise<boolean>;
}

export type TransferVigilanceMissing = 'beneficiaires_effectifs' | 'origine_des_fonds';

export interface TransferVigilanceAlert {
  id: string;
  fileId: string;
  personId: string;
  missing: TransferVigilanceMissing[];
  raisedAt: string;
  decision: { decision: VigilanceDecisionKind; reason: string; validatorName: string; decidedAt: string } | null;
}

type Refusal = { ok: false; rule: 'R16'; code: string };
type Problem = { ok: false; rule: null; code: 'unknown_file' | 'unknown_person' | 'bad_buyer' | 'bad_decision' | 'missing_reason' | 'missing_name' | 'already_decided' | 'unknown_alert' | 'sorte' };
export type VigilanceCessionResult<T> = { ok: true; value: T } | Refusal | Problem;

interface FileRow {
  id: string;
  network_id: string;
  property_id: string;
}

interface AlertRow {
  id: string;
  network_id: string;
  file_id: string;
  person_id: string;
  missing: string;
  raised_at: string;
  decision: VigilanceDecisionKind | null;
  reason: string | null;
  validator_name: string | null;
  decided_at: string | null;
}

const ALERT_SELECT = `SELECT a.*, d.decision, d.reason, d.validator_name, d.decided_at FROM business_transfer_watch a
  LEFT JOIN business_transfer_watch_decisions d ON d.alert_id = a.id`;

const toAlert = (r: AlertRow): TransferVigilanceAlert => ({
  id: r.id,
  fileId: r.file_id,
  personId: r.person_id,
  missing: JSON.parse(r.missing) as TransferVigilanceMissing[],
  raisedAt: r.raised_at,
  decision: r.decision && r.reason && r.validator_name && r.decided_at ? { decision: r.decision, reason: r.reason, validatorName: r.validator_name, decidedAt: r.decided_at } : null,
});

export interface VigilanceCessionOptions {
  now?: () => Date;
  newId?: () => string;
}

export class VigilanceCession {
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(
    private readonly db: SqlDatabase,
    private readonly journal: JournalStore,
    private readonly vault: VaultDeposits,
    options: VigilanceCessionOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => crypto.randomUUID());
    this.unique = new FicheUnique(db, new FicheClient(db, { now: this.now }), { now: this.now });
  }

  private readonly unique: FicheUnique;

  private actor(viewer: Viewer): string {
    return `${String(viewer.role)}:${viewer.userId}`;
  }

  /** L'agent du bien ou la direction range l'acquéreur du dossier ; une correction est une nouvelle version [R17]. */
  async setBuyer(acces: Acces, viewer: Viewer, fileId: string, input: { personId?: unknown; legalPerson?: unknown }): Promise<VigilanceCessionResult<{ version: number }>> {
    const file = await this.fileFor(acces, viewer, fileId);
    if (!('id' in file)) return file;
    if (typeof input.personId !== 'string' || typeof input.legalPerson !== 'boolean') return { ok: false, rule: null, code: 'bad_buyer' };
    const person = await acces.readFiche(viewer, input.personId);
    if (!person.ok) return person.code === 'unknown' ? { ok: false, rule: null, code: 'unknown_person' } : { ok: false, rule: 'R16', code: person.code };
    if (person.view !== 'full') return this.refuse(viewer, `network:${viewer.networkId}`, 'not_assigned');
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const last = await this.db.first<{ v: number | null }>('SELECT MAX(version) AS v FROM business_transfer_buyers WHERE file_id = ?', [file.id]);
      const version = Number(last?.v ?? 0) + 1;
      const { changes } = await this.db.run(
        'INSERT INTO business_transfer_buyers (id, file_id, network_id, person_id, legal_person, version, recorded_by, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING',
        [this.newId(), file.id, file.network_id, input.personId, input.legalPerson ? 1 : 0, version, this.actor(viewer), this.now().toISOString()],
      );
      if (changes !== 1) continue;
      await appendEvent(this.journal, { type: 'commerces.cession.acquereur', actor: this.actor(viewer), subject: `property:${file.property_id}`, data: { version } }, this.now);
      await this.examine(file.network_id, file.id);
      return { ok: true, value: { version } };
    }
    throw new Error('acquéreur de la cession : trop d’écritures simultanées');
  }

  /**
   * Examine un dossier : tant que la cession n'est pas signée, si l'acquéreur est rangé et qu'il manque au coffre les
   * bénéficiaires effectifs (personne morale) ou l'origine des fonds, une alerte au responsable, une seule [R118].
   * Rend `true` si une alerte vient d'être levée.
   */
  async examine(networkId: string, fileId: string): Promise<boolean> {
    if (await this.db.first("SELECT 1 FROM business_transfer_dates WHERE file_id = ? AND kind = 'cession_signee'", [fileId])) return false;
    const buyer = await this.db.first<{ person_id: string; legal_person: number }>('SELECT person_id, legal_person FROM business_transfer_buyers WHERE file_id = ? AND network_id = ? ORDER BY version DESC LIMIT 1', [
      fileId,
      networkId,
    ]);
    if (!buyer) return false;
    const at = this.now();
    // Personne morale si l'agent l'a rangée telle, ou au moindre signe de société : un Kbis au coffre, ou une
    // déclaration « société » à l'identification (L03). L'agent ne peut pas écarter seul les bénéficiaires effectifs.
    const legal =
      Number(buyer.legal_person) === 1 ||
      (await this.vault.everDeposited(networkId, buyer.person_id, ['extrait_kbis', 'registre_beneficiaires'], at)) ||
      (await this.declaredCompany(networkId, buyer.person_id));
    if (await this.db.first('SELECT 1 FROM business_transfer_watch WHERE file_id = ? AND person_id = ? AND legal_person = ?', [fileId, buyer.person_id, legal ? 1 : 0])) return false;
    const missing: TransferVigilanceMissing[] = [];
    if (legal && !(await this.vault.everDeposited(networkId, buyer.person_id, ['registre_beneficiaires'], at))) missing.push('beneficiaires_effectifs');
    if (!(await this.vault.everDeposited(networkId, buyer.person_id, ['origine_fonds'], at))) missing.push('origine_des_fonds');
    if (missing.length === 0) return false;
    const id = this.newId();
    const { changes } = await this.db.run(
      'INSERT INTO business_transfer_watch (id, network_id, file_id, person_id, legal_person, missing, raised_by, raised_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING',
      [id, networkId, fileId, buyer.person_id, legal ? 1 : 0, JSON.stringify(missing), 'system:commerces', at.toISOString()],
    );
    if (changes !== 1) return false;
    // Sous la référence de l'alerte, jamais sous le bien ni la personne : l'agent ne la voit pas [R13].
    await appendEvent(this.journal, { type: 'commerces.cession.vigilance', actor: 'system:commerces', subject: `business_vigilance:${id}`, data: { rule: 'R118', missing } }, this.now);
    return true;
  }

  /** Une déclaration « société » à l'identification (L03), sur la fiche ou sur une fiche réunie avec elle. */
  private async declaredCompany(networkId: string, personId: string): Promise<boolean> {
    const ids = await this.unique.membersOf(personId);
    const row = await this.db.first(
      `SELECT 1 FROM client_identifications WHERE network_id = ? AND person_id IN (${ids.map(() => '?').join(', ')}) AND entity = 'societe' LIMIT 1`,
      [networkId, ...ids],
    );
    return !!row;
  }

  /** La tâche quotidienne : examine chaque dossier de cession ouvert du réseau. Rend le nombre d'alertes levées. */
  async run(networkId: string): Promise<number> {
    const files = await this.db.all<{ id: string }>('SELECT id FROM business_transfer_files WHERE network_id = ? ORDER BY created_at, id', [networkId]);
    let raised = 0;
    for (const f of files) if (await this.examine(networkId, f.id)) raised += 1;
    return raised;
  }

  /** Les alertes du réseau : pour le responsable de la conformité seul. */
  async list(viewer: Viewer): Promise<VigilanceCessionResult<TransferVigilanceAlert[]>> {
    if (viewer.role !== 'compliance') return this.refuse(viewer, `network:${viewer.networkId}`, 'role');
    const rows = await this.db.all<AlertRow>(`${ALERT_SELECT} WHERE a.network_id = ? ORDER BY a.raised_at, a.rowid`, [viewer.networkId]);
    return { ok: true, value: rows.map(toAlert) };
  }

  /** Le responsable décide, une seule fois, avec son nom et sa raison ; rien n'est bloqué ni envoyé [R14]. */
  async decide(viewer: Viewer, alertId: string, input: { decision?: unknown; reason?: unknown; validatorName?: unknown }): Promise<VigilanceCessionResult<TransferVigilanceAlert>> {
    if (viewer.role !== 'compliance') return this.refuse(viewer, `business_vigilance:${alertId}`, 'role');
    const row = await this.db.first<AlertRow>(`${ALERT_SELECT} WHERE a.id = ?`, [alertId]);
    if (!row || row.network_id !== viewer.networkId) return { ok: false, rule: null, code: 'unknown_alert' };
    if (typeof input.decision !== 'string' || !(VIGILANCE_DECISIONS as readonly string[]).includes(input.decision)) return { ok: false, rule: null, code: 'bad_decision' };
    if (typeof input.reason !== 'string' || input.reason.trim() === '' || input.reason.length > 1000) return { ok: false, rule: null, code: 'missing_reason' };
    if (typeof input.validatorName !== 'string' || input.validatorName.trim() === '' || input.validatorName.length > 120) return { ok: false, rule: null, code: 'missing_name' };
    const { changes } = await this.db.run(
      'INSERT INTO business_transfer_watch_decisions (alert_id, network_id, decision, reason, validator_name, decided_by, decided_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING',
      [row.id, row.network_id, input.decision, input.reason.trim(), input.validatorName.trim(), this.actor(viewer), this.now().toISOString()],
    );
    if (changes !== 1) return { ok: false, rule: null, code: 'already_decided' };
    await appendEvent(this.journal, { type: 'commerces.cession.vigilance_decision', actor: this.actor(viewer), subject: `business_vigilance:${row.id}`, data: { rule: 'R118', decision: input.decision } }, this.now);
    const done = await this.db.first<AlertRow>(`${ALERT_SELECT} WHERE a.id = ?`, [row.id]);
    return { ok: true, value: toAlert(done!) };
  }

  /**
   * Pour l'agent du bien : la seule demande neutre d'origine des fonds, si le responsable l'a décidée pour l'acquéreur
   * en vigueur ; jamais l'alerte,
   * ni sa raison, ni ce qui manque.
   */
  async fundsRequest(acces: Acces, viewer: Viewer, fileId: string): Promise<VigilanceCessionResult<{ text: string; documents: readonly string[]; sent: false } | null>> {
    const file = await this.fileFor(acces, viewer, fileId);
    if (!('id' in file)) return file;
    const asked = await this.db.first(
      `SELECT 1 FROM business_transfer_watch a JOIN business_transfer_watch_decisions d ON d.alert_id = a.id
       WHERE a.file_id = ? AND d.decision = 'origine_des_fonds_demandee'
         AND a.person_id = (SELECT b.person_id FROM business_transfer_buyers b WHERE b.file_id = a.file_id ORDER BY b.version DESC LIMIT 1)`,
      [file.id],
    );
    return { ok: true, value: asked ? { text: FUNDS_REQUEST_TEXT, documents: FUNDS_REQUEST_DOCUMENTS, sent: false } : null };
  }

  /** Le dossier, si le lecteur est l'agent du bien ou la direction et voit le bien en entier [R16]. */
  private async fileFor(acces: Acces, viewer: Viewer, fileId: string): Promise<FileRow | Refusal | Problem> {
    const file = await this.db.first<FileRow>('SELECT id, network_id, property_id FROM business_transfer_files WHERE id = ?', [fileId]);
    if (!file || file.network_id !== viewer.networkId) {
      await this.refuse(viewer, `network:${viewer.networkId}`, 'unknown');
      return { ok: false, rule: null, code: 'unknown_file' };
    }
    const read = await acces.readProperty(viewer, file.property_id);
    if (!read.ok) return { ok: false, rule: 'R16', code: read.code };
    if (read.view !== 'full') return this.refuse(viewer, `property:${file.property_id}`, 'not_assigned');
    if (!((viewer.role === 'agent' && read.value.agent_id === viewer.userId) || viewer.role === 'direction')) return this.refuse(viewer, `property:${file.property_id}`, 'role');
    return file;
  }

  private async refuse(viewer: Viewer, subject: string, code: string): Promise<Refusal> {
    await appendEvent(this.journal, { type: 'acces.refuse', actor: this.actor(viewer), subject, data: { rule: 'R16', role: String(viewer.role), kind: 'business_vigilance', code } }, this.now);
    return { ok: false, rule: 'R16', code };
  }
}
