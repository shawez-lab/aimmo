/**
 * AU010b · L'audit énergétique remis à l'acquéreur dès la première visite (M08) [R60, R10, R16, R17].
 *
 * Quand la vente d'une maison ou d'un immeuble hors copropriété y est soumise (`energyAuditCase`, AU010), l'audit
 * énergétique est communiqué à l'acquéreur potentiel dès la première visite (art. L126-28-1 du code de la construction
 * et de l'habitation, lu le 2026-11-18). Avant chaque visite, l'agent lit ce qu'il doit faire : remettre l'audit du
 * bien, le faire faire s'il manque ou s'il est périmé au jour de la visite, faire préciser la classe du DPE quand la
 * fiche ne permet pas de trancher, ou rien. Après, il range la remise : la date et le moyen qu'il déclare, jamais une
 * date inventée [R10], une seule fois par visite, sans retour en arrière [R17].
 *
 * Décidé, lecture prudente :
 * - l'année des règles est celle de la visite, à Paris ;
 * - l'audit du bien est le plus récent déposé à la fiche du bien par un partenaire (U05) ou rangé à un dossier de vente
 *   du bien ; il vaut 5 ans, comme à l'acte (`DEFAULT_VALIDITY_MONTHS`) ; un audit daté après la visite n'existait pas ;
 * - une remise déjà rangée pour le même visiteur (fiches réunies comprises) et le même bien suffit : c'est la première
 *   visite qui compte. Une remise se range même quand la classe est inconnue (une remise de trop ne nuit pas), jamais
 *   pour un bien qui n'y est pas soumis, ni datée dans le futur ou plus de 30 jours avant la visite ;
 * - l'agent de la visite ou la direction, qui voient la fiche du visiteur en entier [R16].
 */
import type { Acces } from '../acces/acces.ts';
import type { Viewer } from '../acces/droits.ts';
import type { EnergyClass, PropertySheet } from '../annonces/fiche-bien.ts';
import { FicheClient } from '../db/fiche-client.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { DEFAULT_VALIDITY_MONTHS, validUntil } from '../dossiers/acte.ts';
import { energyAuditCase, type PropertyKind } from '../dossiers/pieces.ts';
import { localTime } from '../envoi/horaires.ts';
import { FicheUnique } from '../fiche/fusion.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';

const TIME_ZONE = 'Europe/Paris';
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const validDay = (v: unknown): v is string => {
  if (typeof v !== 'string' || !DAY.test(v)) return false;
  const d = new Date(`${v}T12:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
};

/** Au plus tant de jours avant la visite, une remise compte encore pour elle (un envoi par mail la veille, par exemple). */
export const HANDOVER_EARLIEST_DAYS = 30;

export const HANDOVER_MEANS = ['papier', 'mail', 'espace'] as const;
export type HandoverMeans = (typeof HANDOVER_MEANS)[number];

/** Ce que l'agent doit faire pour l'audit, avant la visite. */
export type AuditAction = 'remettre' | 'faire_faire' | 'preciser_classe' | 'deja_remis' | 'aucune';

export interface AuditNotice {
  appointmentId: string;
  visitDay: string;
  case: 'requis' | 'non_requis' | 'inconnu';
  energyClass: EnergyClass | null;
  /** L'audit le plus récent du bien, et s'il vaut encore le jour de la visite. */
  audit: { issuedOn: string; validUntil: string; valid: boolean } | null;
  /** La remise déjà rangée pour ce visiteur et ce bien, s'il y en a une. */
  handover: { appointmentId: string; handedOn: string; means: HandoverMeans } | null;
  action: AuditAction;
  /** La phrase à l'agent, en français simple, sans aucun chiffre inventé [R10]. */
  message: string;
}

export type RemiseRefusal = { ok: false; rule: 'R16' | 'R10' | 'R60' | null; code: string };
export type RemiseResult<T> = { ok: true; value: T } | RemiseRefusal;

interface VisitRow {
  appointment_id: string;
  network_id: string;
  property_id: string;
  person_id: string;
  agent_id: string;
  start_at: string;
  status: string;
}

const frDay = (day: string): string => `${day.slice(8, 10)}/${day.slice(5, 7)}/${day.slice(0, 4)}`;

function messageFor(n: Omit<AuditNotice, 'message'>): string {
  switch (n.action) {
    case 'remettre':
      return `Audit énergétique à remettre au visiteur dès cette visite (classe ${n.energyClass}), puis à noter comme remis.`;
    case 'faire_faire':
      return n.audit
        ? `Audit énergétique obligatoire (classe ${n.energyClass}) : celui du bien, daté du ${frDay(n.audit.issuedOn)}, ne vaut plus le jour de la visite. En faire faire un nouveau et le remettre au visiteur.`
        : `Audit énergétique obligatoire (classe ${n.energyClass}) et absent du bien : le faire faire par un diagnostiqueur certifié avec mention, et le remettre au visiteur dès la première visite.`;
    case 'preciser_classe':
      return 'Classe énergie du bien inconnue ou lue sur un DPE d’avant juillet 2021 : impossible de savoir si l’audit énergétique est dû. Préciser la fiche du bien avant la visite.';
    case 'deja_remis':
      return `Audit énergétique déjà remis à ce visiteur le ${frDay(n.handover!.handedOn)}.`;
    default:
      return 'Aucun audit énergétique à remettre pour ce bien.';
  }
}

export class RemiseAudit {
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly fiche: FicheUnique;

  constructor(
    private readonly db: SqlDatabase,
    private readonly journal: JournalStore,
    private readonly acces: Acces,
    options: { now?: () => Date; newId?: () => string } = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => crypto.randomUUID());
    this.fiche = new FicheUnique(db, new FicheClient(db, { now: this.now }), { now: this.now });
  }

  private actor(viewer: Viewer): string {
    return `${String(viewer.role)}:${viewer.userId}`;
  }

  private async refuse(viewer: Viewer, code: string, subject: string): Promise<RemiseRefusal> {
    await appendEvent(this.journal, { type: 'acces.refuse', actor: this.actor(viewer), subject, data: { rule: 'R16', role: String(viewer.role), kind: 'visit_energy_audit', code } }, this.now);
    return { ok: false, rule: 'R16', code };
  }

  /** La visite, si le lecteur en est l'agent ou la direction et voit la fiche du visiteur en entier [R16]. */
  private async gate(viewer: Viewer, appointmentId: unknown): Promise<{ ok: true; visit: VisitRow; members: string[] } | RemiseRefusal> {
    const subject = `appointment:${String(appointmentId)}`;
    if (typeof appointmentId !== 'string' || appointmentId.length > 80) return { ok: false, rule: null, code: 'unknown' };
    if (viewer.role !== 'agent' && viewer.role !== 'direction') return this.refuse(viewer, 'role', subject);
    const visit = await this.db.first<VisitRow>(
      'SELECT v.appointment_id, v.network_id, v.property_id, v.person_id, v.agent_id, a.start_at, a.status FROM visits v JOIN appointments a ON a.id = v.appointment_id WHERE v.appointment_id = ?',
      [appointmentId],
    );
    if (!visit || visit.network_id !== viewer.networkId) return this.refuse(viewer, 'unknown', subject);
    if (viewer.role === 'agent' && visit.agent_id !== viewer.userId) return this.refuse(viewer, 'not_assigned', subject);
    const fiche = await this.acces.readFiche(viewer, visit.person_id);
    if (!fiche.ok) return { ok: false, rule: 'R16', code: fiche.code };
    if (fiche.view !== 'full') return this.refuse(viewer, 'not_assigned', `person:${visit.person_id}`);
    return { ok: true, visit, members: fiche.value.members.map((m) => m.id) };
  }

  private async compute(visit: VisitRow, members: readonly string[]): Promise<AuditNotice> {
    const visitDay = localTime(new Date(visit.start_at), TIME_ZONE).date;
    const year = Number(visitDay.slice(0, 4));
    const prop = await this.db.first<{ kind: PropertyKind }>('SELECT kind FROM properties WHERE id = ?', [visit.property_id]);
    const row = await this.db.first<{ data: string }>('SELECT data FROM property_sheets WHERE property_id = ? ORDER BY version DESC LIMIT 1', [visit.property_id]);
    const sheet = row ? (JSON.parse(row.data) as PropertySheet) : null;
    const c = energyAuditCase(prop!.kind, sheet, year);
    // L'audit le plus récent du bien, à la date de la visite : déposé à sa fiche (U05) ou rangé à un de ses dossiers.
    const docs = await this.db.all<{ issued_on: string }>(
      `SELECT issued_on FROM partner_documents WHERE destination = 'property' AND target_id = ? AND piece = 'audit_energetique' AND issued_on <= ?
       UNION ALL SELECT p.issued_on FROM sale_file_pieces p JOIN sale_files f ON f.id = p.file_id WHERE f.property_id = ? AND p.piece = 'audit_energetique' AND p.issued_on <= ?`,
      [visit.property_id, visitDay, visit.property_id, visitDay],
    );
    const latest = docs.map((d) => d.issued_on).sort().at(-1) ?? null;
    const until = latest ? validUntil(latest, DEFAULT_VALIDITY_MONTHS.audit_energetique!) : null;
    const audit = latest && until ? { issuedOn: latest, validUntil: until, valid: visitDay <= until } : null;
    const ids = members.length > 0 ? members : [visit.person_id];
    const h = await this.db.first<{ appointment_id: string; handed_on: string; means: HandoverMeans }>(
      `SELECT appointment_id, handed_on, means FROM visit_energy_audit_handovers WHERE property_id = ? AND person_id IN (${ids.map(() => '?').join(', ')}) ORDER BY handed_on, recorded_at LIMIT 1`,
      [visit.property_id, ...ids],
    );
    const handover = h ? { appointmentId: h.appointment_id, handedOn: h.handed_on, means: h.means } : null;
    const energyClass = c.case === 'requis' ? c.energyClass : null;
    let action: AuditAction;
    if (c.case === 'non_requis') action = 'aucune';
    else if (handover) action = 'deja_remis';
    else if (c.case === 'inconnu') action = 'preciser_classe';
    else action = audit?.valid ? 'remettre' : 'faire_faire';
    const notice = { appointmentId: visit.appointment_id, visitDay, case: c.case, energyClass, audit, handover, action };
    return { ...notice, message: messageFor(notice) };
  }

  /**
   * L'avis d'une visite dont l'appelant a déjà fait les contrôles d'accès (la prise de visite de `Visites`), avec la
   * fiche du visiteur et ses fiches réunies. `null` : visite introuvable.
   */
  async noticeAfterChecks(appointmentId: string): Promise<AuditNotice | null> {
    const visit = await this.db.first<VisitRow>(
      'SELECT v.appointment_id, v.network_id, v.property_id, v.person_id, v.agent_id, a.start_at, a.status FROM visits v JOIN appointments a ON a.id = v.appointment_id WHERE v.appointment_id = ?',
      [appointmentId],
    );
    if (!visit) return null;
    return this.compute(visit, await this.fiche.membersOf(visit.person_id));
  }

  /** Ce que l'agent doit faire pour l'audit énergétique, avant la visite. Rien n'est écrit. */
  async notice(viewer: Viewer, appointmentId: unknown): Promise<RemiseResult<AuditNotice>> {
    const g = await this.gate(viewer, appointmentId);
    if (!g.ok) return g;
    return { ok: true, value: await this.compute(g.visit, g.members) };
  }

  /**
   * Range la remise de l'audit au visiteur : la date et le moyen déclarés par l'agent [R10], une fois par visite [R17].
   * Refusée pour un bien qui n'y est pas soumis, une date future ou trop ancienne, une visite annulée.
   */
  async recordHandover(viewer: Viewer, appointmentId: unknown, input: { handedOn: unknown; means: unknown }): Promise<RemiseResult<AuditNotice>> {
    const g = await this.gate(viewer, appointmentId);
    if (!g.ok) return g;
    const { visit } = g;
    if (visit.status === 'cancelled' || visit.status === 'absent') return { ok: false, rule: null, code: 'visit_not_held' };
    if (!validDay(input.handedOn)) return { ok: false, rule: 'R10', code: 'date_required' };
    if (typeof input.means !== 'string' || !(HANDOVER_MEANS as readonly string[]).includes(input.means)) return { ok: false, rule: null, code: 'bad_means' };
    const today = localTime(this.now(), TIME_ZONE).date;
    if (input.handedOn > today) return { ok: false, rule: 'R10', code: 'date_in_future' };
    const before = await this.compute(visit, g.members);
    const earliest = new Date(Date.parse(`${before.visitDay}T12:00:00Z`) - HANDOVER_EARLIEST_DAYS * 86_400_000).toISOString().slice(0, 10);
    if (input.handedOn < earliest) return { ok: false, rule: 'R10', code: 'date_too_early' };
    if (before.case === 'non_requis') return { ok: false, rule: 'R60', code: 'not_required' };
    const ref = await this.db.first<{ ref: string }>(
      `SELECT ref FROM (SELECT ref, issued_on FROM partner_documents WHERE destination = 'property' AND target_id = ? AND piece = 'audit_energetique' AND issued_on <= ?
       UNION ALL SELECT p.ref, p.issued_on FROM sale_file_pieces p JOIN sale_files f ON f.id = p.file_id WHERE f.property_id = ? AND p.piece = 'audit_energetique' AND p.issued_on <= ?) ORDER BY issued_on DESC LIMIT 1`,
      [visit.property_id, input.handedOn, visit.property_id, input.handedOn],
    );
    const { changes } = await this.db.run(
      `INSERT INTO visit_energy_audit_handovers (id, network_id, appointment_id, property_id, person_id, handed_on, means, audit_ref, recorded_by, recorded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (appointment_id) DO NOTHING`,
      [this.newId(), visit.network_id, visit.appointment_id, visit.property_id, visit.person_id, input.handedOn, input.means, ref?.ref ?? null, this.actor(viewer), this.now().toISOString()],
    );
    if (changes !== 1) return { ok: false, rule: null, code: 'already_recorded' };
    // Ni nom ni document au journal : la visite, la date et le moyen suffisent [R13].
    await appendEvent(
      this.journal,
      { type: 'visite.audit_remis', actor: this.actor(viewer), subject: `appointment:${visit.appointment_id}`, data: { rule: 'R60', handedOn: input.handedOn, means: input.means, withDocument: ref !== null } },
      this.now,
    );
    return { ok: true, value: await this.compute(visit, g.members) };
  }
}
