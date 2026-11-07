/**
 * Les clés des biens (HX10) [R270, R271, R272].
 *
 * - Chaque trousseau d'un bien est rangé dans l'armoire de l'agence avec un numéro donné par le code, unique dans le
 *   réseau, et un libellé qui dit ce qu'il ouvre ; jamais une adresse ni un code d'accès [R270].
 * - Une sortie dit qui l'a (un agent du réseau en activité), depuis quand, et pour quoi : un rendez-vous du bien (visite
 *   ou estimation, dont l'agent est celui qui prend la clé) ou une raison d'une liste fermée, avec l'heure du retour.
 *   Un trousseau n'est jamais chez deux personnes à la fois : la base refuse une sortie tant que la précédente n'est pas
 *   revenue, même demandée deux fois en même temps [R271]. Rien ne change ni ne s'efface [R17].
 * - Chaque mouvement (rangé, sorti, rendu, perdu, retiré) va au journal, avec des identifiants et des nombres seulement
 *   [R271, R13].
 * - Jamais vu : l'agenda de l'agent rappelle de rendre la clé à la fin de la visite, et tout de suite si le rendez-vous
 *   est annulé ; le vendeur voit dans son espace qui a pris la clé de chez lui, quand, pour quel rendez-vous et quand
 *   elle est revenue, sans jamais le nom d'un visiteur [R272, R161].
 * - Rien n'est envoyé : aucun message, aucune notification.
 */
import type { Acces } from '../acces/acces.ts';
import type { Viewer } from '../acces/droits.ts';
import { agentState } from '../acces/etat-agent.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { runBatch } from '../db/sql.ts';
import type { ClientViewer } from '../espaces/entree.ts';
import { sellerWindows } from '../espaces/sources-vendeur.ts';
import type { FicheUnique } from '../fiche/fusion.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';

/** Pourquoi un trousseau sort. Visite et estimation : toujours pour un rendez-vous du bien. */
export const PURPOSES = ['visite', 'estimation', 'photos', 'diagnostic', 'travaux'] as const;
export type Purpose = (typeof PURPOSES)[number];
const WITH_APPOINTMENT: ReadonlySet<Purpose> = new Set(['visite', 'estimation']);

export const PURPOSE_LABEL: Record<Purpose, string> = {
  visite: 'Visite',
  estimation: 'Estimation',
  photos: 'Photos du bien',
  diagnostic: 'Diagnostics',
  travaux: 'Travaux ou artisan',
};

export const RETIREMENT_REASONS = ['rendu_au_proprietaire', 'perdu'] as const;
export type RetirementReason = (typeof RETIREMENT_REASONS)[number];

/** Au plus tant d'heures dehors pour une sortie sans rendez-vous. */
export const MAX_LOAN_HOURS = 12;
const HOUR = 3_600_000;

/** Ce qui, dans un libellé, ressemble à une adresse ou à un code d'accès : jamais rangé [R270]. */
const FORBIDDEN_LABEL = /\d|(?<!\p{L})(rue|avenue|av|boulevard|bd|chemin|allée|allee|impasse|place|quai|route|code|digicode|alarme|bâtiment|batiment|étage|etage)(?!\p{L})/iu;

type Refusal = { ok: false; rule: 'R16'; code: string };
type Problem = { ok: false; rule: 'R270' | 'R271' | null; code: string };

export interface KeyHolder {
  agentId: string;
  /** Prénom et initiale du nom de l'agent. */
  name: string;
  since: string;
  purpose: Purpose;
  appointmentId: string | null;
  dueAt: string;
}

export interface KeyView {
  id: string;
  number: number;
  label: string;
  propertyId: string;
  /** `armoire` : à l'agence ; `sorti` : chez un agent ; `retire` : rendu au propriétaire ou perdu. */
  state: 'armoire' | 'sorti' | 'retire';
  holder: KeyHolder | null;
  retirement: { reason: RetirementReason; at: string } | null;
}

export interface Movement {
  loanId: string;
  holder: { agentId: string; name: string };
  purpose: Purpose;
  appointmentId: string | null;
  outAt: string;
  dueAt: string;
  returned: { outcome: 'rendu' | 'perdu'; at: string } | null;
}

/** Un rappel de l'agenda de l'agent : rendre tel trousseau, à telle heure. */
export interface KeyReminder {
  keyId: string;
  number: number;
  propertyId: string;
  reference: string;
  /** L'heure du retour : la fin du rendez-vous, son annulation, ou l'heure dite à la sortie. */
  dueAt: string;
  overdue: boolean;
  text: string;
}

/** Ce que le vendeur voit : qui a pris la clé de chez lui, quand, pour quoi, et quand elle est revenue [R272]. */
export interface SellerKeyEntry {
  number: number;
  label: string;
  /** L'agent, prénom et initiale ; jamais un visiteur. */
  agent: string;
  purpose: string;
  takenAt: string;
  appointment: { start: string; end: string; state: 'prevu' | 'fait' | 'absent' | 'annule' } | null;
  returnedAt: string | null;
  lost: boolean;
}

interface KeyRow {
  id: string;
  network_id: string;
  property_id: string;
  number: number;
  label: string;
}

interface LoanRow {
  id: string;
  key_id: string;
  holder_agent_id: string;
  first_name: string;
  last_name: string;
  purpose: Purpose;
  appointment_id: string | null;
  due_at: string;
  out_at: string;
  outcome: 'rendu' | 'perdu' | null;
  returned_at: string | null;
}

const shortName = (first: string, last: string): string => `${first.trim()} ${last.trim().charAt(0).toUpperCase()}.`;

/** Le libellé d'un trousseau : ce qu'il ouvre, en quelques mots, sans adresse ni code [R270]. */
export function cleanLabel(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  if (/[\r\n]/.test(input)) return null;
  const t = input.trim().replace(/\s+/g, ' ');
  const n = [...t].length;
  if (n < 2 || n > 80) return null;
  if (FORBIDDEN_LABEL.test(t)) return null;
  return t;
}

const LOAN_SELECT = `
  SELECT l.id, l.key_id, l.holder_agent_id, a.first_name, a.last_name, l.purpose, l.appointment_id, l.due_at, l.out_at,
         r.outcome, r.returned_at
    FROM property_key_loans l
    JOIN agents a ON a.id = l.holder_agent_id
    LEFT JOIN property_key_returns r ON r.loan_id = l.id`;

/** Une sortie sans retour, quand le trousseau est encore dans l'armoire et pas retiré : la condition de la base aussi. */
const IN_CABINET = `NOT EXISTS (SELECT 1 FROM property_key_loans l WHERE l.key_id = ? AND NOT EXISTS (SELECT 1 FROM property_key_returns r WHERE r.loan_id = l.id))
  AND NOT EXISTS (SELECT 1 FROM property_key_retirements t WHERE t.key_id = ?)`;

export interface ClesOptions {
  now?: () => Date;
  newId?: () => string;
}

export class Cles {
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(
    private readonly db: SqlDatabase,
    private readonly acces: Acces,
    private readonly fiche: FicheUnique,
    private readonly journal: JournalStore,
    options: ClesOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => crypto.randomUUID());
  }

  private actor(viewer: Viewer): string {
    return `${String(viewer.role)}:${viewer.userId}`;
  }

  private async refuse(viewer: Viewer, subject: string, code: string): Promise<Refusal> {
    await appendEvent(this.journal, { type: 'acces.refuse', actor: this.actor(viewer), subject, data: { rule: 'R16', role: String(viewer.role), kind: 'cles', code } }, this.now);
    return { ok: false, rule: 'R16', code };
  }

  private async activeAgent(networkId: string, agentId: string): Promise<boolean> {
    const a = await this.db.first<{ id: string }>('SELECT id FROM agents WHERE id = ? AND network_id = ?', [agentId, networkId]);
    if (!a) return false;
    return (await agentState(this.db, networkId, agentId, this.now())) === 'actif';
  }

  /**
   * Celui qui tient l'armoire pour ce bien : l'agent du bien, en activité, ou la direction. Le bien est lu par le chemin
   * des droits, qui écrit la lecture au journal [R16].
   */
  private async keeper(viewer: Viewer, propertyId: string): Promise<{ ok: true; status: string } | Refusal> {
    if (viewer.role !== 'agent' && viewer.role !== 'direction') return this.refuse(viewer, `property:${propertyId}`, 'role');
    if (viewer.role === 'agent' && !(await this.activeAgent(viewer.networkId, viewer.userId))) return this.refuse(viewer, `property:${propertyId}`, 'agent_inactive');
    const read = await this.acces.readProperty(viewer, propertyId);
    if (!read.ok) return { ok: false, rule: 'R16', code: read.code };
    if (read.value.network_id !== viewer.networkId) return this.refuse(viewer, `property:${propertyId}`, 'network');
    if (viewer.role === 'agent' && (read.view !== 'full' || read.value.agent_id !== viewer.userId)) return this.refuse(viewer, `property:${propertyId}`, 'pas_son_bien');
    return { ok: true, status: read.value.status };
  }

  private async keyRow(networkId: string, keyId: string): Promise<KeyRow | null> {
    return this.db.first<KeyRow>('SELECT id, network_id, property_id, number, label FROM property_keys WHERE id = ? AND network_id = ?', [keyId, networkId]);
  }

  private async openLoan(keyId: string): Promise<LoanRow | null> {
    return this.db.first<LoanRow>(`${LOAN_SELECT} WHERE l.key_id = ? AND r.loan_id IS NULL`, [keyId]);
  }

  /** Ranger un trousseau dans l'armoire : son numéro est donné par le code, le suivant dans le réseau [R270]. */
  async register(viewer: Viewer, propertyId: string, labelInput: unknown): Promise<{ ok: true; keyId: string; number: number } | Refusal | Problem> {
    const k = await this.keeper(viewer, propertyId);
    if (!k.ok) return k;
    if (k.status === 'withdrawn') return { ok: false, rule: null, code: 'bien_retire' };
    const label = cleanLabel(labelInput);
    if (!label) return { ok: false, rule: 'R270', code: 'bad_label' };
    const id = this.newId();
    // Le numéro et l'écriture en une seule instruction : deux trousseaux rangés en même temps n'ont jamais le même.
    await this.db.run(
      `INSERT INTO property_keys (id, network_id, property_id, number, label, created_by, created_at)
       SELECT ?, ?, ?, coalesce(max(number), 0) + 1, ?, ?, ? FROM property_keys WHERE network_id = ?`,
      [id, viewer.networkId, propertyId, label, this.actor(viewer), this.now().toISOString(), viewer.networkId],
    );
    const row = await this.keyRow(viewer.networkId, id);
    if (!row) return { ok: false, rule: null, code: 'non_range' };
    await appendEvent(this.journal, { type: 'cle.rangee', actor: this.actor(viewer), subject: `key:${id}`, data: { rule: 'R270', number: row.number, property: propertyId } }, this.now);
    return { ok: true, keyId: id, number: row.number };
  }

  /**
   * Sortir un trousseau de l'armoire, pour un agent du réseau en activité. Pour une visite ou une estimation, le
   * rendez-vous est un rendez-vous prévu du bien, de cet agent, et la clé revient à sa fin ; sinon, l'heure du retour est
   * dite, dans les 12 heures. Jamais chez deux personnes à la fois [R271].
   */
  async handOut(
    viewer: Viewer,
    keyId: string,
    input: { holderAgentId: unknown; purpose: unknown; appointmentId?: unknown; dueAt?: unknown },
  ): Promise<{ ok: true; loanId: string; dueAt: string } | Refusal | Problem> {
    const key = await this.keyRow(viewer.networkId, keyId);
    if (!key) return { ok: false, rule: null, code: 'unknown_key' };
    const k = await this.keeper(viewer, key.property_id);
    if (!k.ok) return k;
    if (k.status === 'withdrawn') return { ok: false, rule: null, code: 'bien_retire' };
    if (typeof input.purpose !== 'string' || !(PURPOSES as readonly string[]).includes(input.purpose)) return { ok: false, rule: 'R271', code: 'bad_purpose' };
    const purpose = input.purpose as Purpose;
    if (typeof input.holderAgentId !== 'string' || !(await this.activeAgent(viewer.networkId, input.holderAgentId))) return { ok: false, rule: 'R271', code: 'bad_holder' };
    const holder = input.holderAgentId;
    const now = this.now();
    let dueAt: string;
    let appointmentId: string | null = null;
    let appointmentEnd: string | null = null;
    if (WITH_APPOINTMENT.has(purpose)) {
      if (typeof input.appointmentId !== 'string') return { ok: false, rule: 'R271', code: 'sans_rendez_vous' };
      const a = await this.db.first<{ id: string; agent_id: string; property_id: string | null; kind: string; status: string; end_at: string }>(
        'SELECT id, agent_id, property_id, kind, status, end_at FROM appointments WHERE id = ? AND network_id = ?',
        [input.appointmentId, viewer.networkId],
      );
      if (!a || a.property_id !== key.property_id || a.kind !== purpose) return { ok: false, rule: 'R271', code: 'bad_appointment' };
      if (a.status !== 'booked' || Date.parse(a.end_at) <= now.getTime()) return { ok: false, rule: 'R271', code: 'rendez_vous_passe' };
      // La clé va à celui qui tient le rendez-vous, personne d'autre.
      if (a.agent_id !== holder) return { ok: false, rule: 'R271', code: 'pas_son_rendez_vous' };
      appointmentId = a.id;
      appointmentEnd = a.end_at;
      dueAt = new Date(Date.parse(a.end_at)).toISOString();
    } else {
      if (input.appointmentId !== undefined && input.appointmentId !== null) return { ok: false, rule: 'R271', code: 'bad_appointment' };
      const due = typeof input.dueAt === 'string' ? Date.parse(input.dueAt) : Number.NaN;
      if (Number.isNaN(due) || due <= now.getTime() || due > now.getTime() + MAX_LOAN_HOURS * HOUR) return { ok: false, rule: 'R271', code: 'bad_due' };
      dueAt = new Date(due).toISOString();
    }
    const id = this.newId();
    // La sortie n'entre que si le trousseau est dans l'armoire, relu dans la même instruction : deux sorties demandées en
    // même temps n'en font jamais qu'une [R271].
    const r = await this.db.run(
      `INSERT INTO property_key_loans (id, key_id, network_id, holder_agent_id, purpose, appointment_id, due_at, handed_by, out_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${IN_CABINET}
          AND (? IS NULL OR EXISTS (SELECT 1 FROM appointments a WHERE a.id = ? AND a.status = 'booked' AND a.end_at = ? AND a.agent_id = ? AND a.property_id = ? AND a.kind = ?))`,
      [id, keyId, viewer.networkId, holder, purpose, appointmentId, dueAt, this.actor(viewer), now.toISOString(), keyId, keyId, appointmentId, appointmentId, appointmentEnd, holder, key.property_id, purpose],
    );
    if (r.changes === 0) {
      // Le rendez-vous annulé ou décalé entre la lecture et l'écriture : la clé ne sort pas.
      if (appointmentId) {
        const still = await this.db.first<{ id: string }>("SELECT id FROM appointments WHERE id = ? AND status = 'booked' AND end_at = ?", [appointmentId, appointmentEnd]);
        if (!still) return { ok: false, rule: 'R271', code: 'rendez_vous_passe' };
      }
      const retired = await this.db.first<{ key_id: string }>('SELECT key_id FROM property_key_retirements WHERE key_id = ?', [keyId]);
      return { ok: false, rule: 'R271', code: retired ? 'retire' : 'deja_sorti' };
    }
    await appendEvent(this.journal, { type: 'cle.sortie', actor: this.actor(viewer), subject: `key:${keyId}`, data: { rule: 'R271', loan: id, holder: `agent:${holder}`, purpose, appointment: appointmentId } }, this.now);
    return { ok: true, loanId: id, dueAt };
  }

  /**
   * Le retour d'un trousseau sorti. Rendu à l'armoire : noté par celui qui la tient (l'agent du bien ou la direction).
   * Perdu : dit aussi par l'agent qui l'avait ; le trousseau est alors retiré, il ne sort plus [R271].
   */
  async giveBack(viewer: Viewer, keyId: string, outcomeInput: unknown = 'rendu'): Promise<{ ok: true } | Refusal | Problem> {
    const key = await this.keyRow(viewer.networkId, keyId);
    if (!key) return { ok: false, rule: null, code: 'unknown_key' };
    if (outcomeInput !== 'rendu' && outcomeInput !== 'perdu') return { ok: false, rule: null, code: 'bad_outcome' };
    const outcome = outcomeInput;
    const loan = await this.openLoan(keyId);
    if (!loan) return { ok: false, rule: 'R271', code: 'pas_sorti' };
    const holderSaysLost = outcome === 'perdu' && viewer.role === 'agent' && viewer.userId === loan.holder_agent_id && (await this.activeAgent(viewer.networkId, viewer.userId));
    if (!holderSaysLost) {
      const k = await this.keeper(viewer, key.property_id);
      if (!k.ok) return k;
    }
    const at = this.now().toISOString();
    const statements = [{ sql: 'INSERT INTO property_key_returns (loan_id, outcome, recorded_by, returned_at) VALUES (?, ?, ?, ?) ON CONFLICT (loan_id) DO NOTHING', params: [loan.id, outcome, this.actor(viewer), at] }];
    // Le retrait n'est écrit que si ce retour « perdu » vient d'être écrit : un « rendu » noté juste avant le laisse dehors.
    if (outcome === 'perdu')
      statements.push({
        sql: `INSERT INTO property_key_retirements (key_id, reason, retired_by, retired_at)
              SELECT ?, 'perdu', ?, ? WHERE EXISTS (SELECT 1 FROM property_key_returns r WHERE r.loan_id = ? AND r.outcome = 'perdu' AND r.recorded_by = ? AND r.returned_at = ?)
              ON CONFLICT (key_id) DO NOTHING`,
        params: [keyId, this.actor(viewer), at, loan.id, this.actor(viewer), at],
      });
    const [res] = await runBatch(this.db, statements);
    if (!res || res.changes === 0) return { ok: false, rule: 'R271', code: 'pas_sorti' };
    await appendEvent(this.journal, { type: outcome === 'rendu' ? 'cle.rendue' : 'cle.perdue', actor: this.actor(viewer), subject: `key:${keyId}`, data: { rule: 'R271', loan: loan.id, holder: `agent:${loan.holder_agent_id}` } }, this.now);
    return { ok: true };
  }

  /** Le trousseau quitte l'armoire pour de bon : rendu au propriétaire (depuis l'armoire seulement) ou perdu. */
  async retire(viewer: Viewer, keyId: string, reasonInput: unknown): Promise<{ ok: true } | Refusal | Problem> {
    const key = await this.keyRow(viewer.networkId, keyId);
    if (!key) return { ok: false, rule: null, code: 'unknown_key' };
    const k = await this.keeper(viewer, key.property_id);
    if (!k.ok) return k;
    if (typeof reasonInput !== 'string' || !(RETIREMENT_REASONS as readonly string[]).includes(reasonInput)) return { ok: false, rule: null, code: 'bad_reason' };
    // Sorti : il revient d'abord, ou il est dit perdu par son retour.
    if (await this.openLoan(keyId)) {
      if (reasonInput === 'perdu') return this.giveBack(viewer, keyId, 'perdu');
      return { ok: false, rule: 'R271', code: 'encore_sorti' };
    }
    const r = await this.db.run(
      `INSERT INTO property_key_retirements (key_id, reason, retired_by, retired_at)
       SELECT ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM property_key_loans l WHERE l.key_id = ? AND NOT EXISTS (SELECT 1 FROM property_key_returns r WHERE r.loan_id = l.id))
       ON CONFLICT (key_id) DO NOTHING`,
      [keyId, reasonInput, this.actor(viewer), this.now().toISOString(), keyId],
    );
    if (r.changes === 0) return { ok: false, rule: 'R271', code: 'deja_retire' };
    await appendEvent(this.journal, { type: 'cle.retiree', actor: this.actor(viewer), subject: `key:${keyId}`, data: { rule: 'R271', reason: reasonInput } }, this.now);
    return { ok: true };
  }

  /** Les trousseaux d'un bien, avec qui les a et depuis quand : l'agent du bien ou la direction. */
  async cabinet(viewer: Viewer, propertyId: string): Promise<{ ok: true; value: KeyView[] } | Refusal> {
    const k = await this.keeper(viewer, propertyId);
    if (!k.ok) return k;
    const keys = await this.db.all<KeyRow & { reason: RetirementReason | null; retired_at: string | null }>(
      `SELECT k.id, k.network_id, k.property_id, k.number, k.label, t.reason, t.retired_at
         FROM property_keys k LEFT JOIN property_key_retirements t ON t.key_id = k.id
        WHERE k.network_id = ? AND k.property_id = ? ORDER BY k.number`,
      [viewer.networkId, propertyId],
    );
    const out: KeyView[] = [];
    for (const key of keys) {
      const loan = await this.openLoan(key.id);
      out.push({
        id: key.id,
        number: key.number,
        label: key.label,
        propertyId: key.property_id,
        state: key.reason ? 'retire' : loan ? 'sorti' : 'armoire',
        holder: loan
          ? { agentId: loan.holder_agent_id, name: shortName(loan.first_name, loan.last_name), since: loan.out_at, purpose: loan.purpose, appointmentId: loan.appointment_id, dueAt: loan.due_at }
          : null,
        retirement: key.reason && key.retired_at ? { reason: key.reason, at: key.retired_at } : null,
      });
    }
    await appendEvent(this.journal, { type: 'cle.armoire_lue', actor: this.actor(viewer), subject: `property:${propertyId}`, data: { rule: 'R271', count: out.length } }, this.now);
    return { ok: true, value: out };
  }

  /** Tous les mouvements d'un trousseau, du plus ancien au plus récent : l'agent du bien ou la direction. */
  async history(viewer: Viewer, keyId: string): Promise<{ ok: true; value: Movement[] } | Refusal | Problem> {
    const key = await this.keyRow(viewer.networkId, keyId);
    if (!key) return { ok: false, rule: null, code: 'unknown_key' };
    const k = await this.keeper(viewer, key.property_id);
    if (!k.ok) return k;
    const rows = await this.db.all<LoanRow>(`${LOAN_SELECT} WHERE l.key_id = ? ORDER BY l.out_at, l.rowid`, [keyId]);
    return {
      ok: true,
      value: rows.map((l) => ({
        loanId: l.id,
        holder: { agentId: l.holder_agent_id, name: shortName(l.first_name, l.last_name) },
        purpose: l.purpose,
        appointmentId: l.appointment_id,
        outAt: l.out_at,
        dueAt: l.due_at,
        returned: l.outcome && l.returned_at ? { outcome: l.outcome, at: l.returned_at } : null,
      })),
    };
  }

  /**
   * Les rappels de l'agenda de l'agent : chaque trousseau qu'il a encore, à rendre à la fin de son rendez-vous, ou tout
   * de suite si le rendez-vous a été annulé ou décalé ; en retard une fois l'heure passée [R272]. Rien n'est envoyé.
   */
  async reminders(viewer: Viewer): Promise<{ ok: true; value: KeyReminder[] } | Refusal> {
    if (viewer.role !== 'agent') return this.refuse(viewer, `agent:${viewer.userId}`, 'role');
    if (!(await this.activeAgent(viewer.networkId, viewer.userId))) return this.refuse(viewer, `agent:${viewer.userId}`, 'agent_inactive');
    const rows = await this.db.all<{ key_id: string; number: number; property_id: string; reference: string; label: string; purpose: Purpose; due_at: string; out_at: string; status: string | null; cancelled_at: string | null; updated_at: string | null; start_at: string | null }>(
      `SELECT k.id AS key_id, k.number, k.property_id, p.reference, k.label, l.purpose, l.due_at, l.out_at, a.status, a.cancelled_at, a.updated_at, a.start_at
         FROM property_key_loans l
         JOIN property_keys k ON k.id = l.key_id
         JOIN properties p ON p.id = k.property_id
         LEFT JOIN appointments a ON a.id = l.appointment_id
        WHERE l.network_id = ? AND l.holder_agent_id = ?
          AND NOT EXISTS (SELECT 1 FROM property_key_returns r WHERE r.loan_id = l.id)`,
      [viewer.networkId, viewer.userId],
    );
    const now = this.now().getTime();
    const out: KeyReminder[] = rows.map((r) => {
      // Annulé (ou décalé, l'ancien étant annulé) : la clé n'a plus rien à faire dehors, elle revient tout de suite.
      const cancelled = r.status === 'cancelled';
      const cancelAt = cancelled ? Math.max(Date.parse(r.cancelled_at ?? r.updated_at ?? r.out_at), Date.parse(r.out_at)) : Number.NaN;
      const due = cancelled ? Math.min(cancelAt, Date.parse(r.due_at)) : Date.parse(r.due_at);
      const dueAt = new Date(due).toISOString();
      const why = cancelled ? `le rendez-vous est annulé` : WITH_APPOINTMENT.has(r.purpose) ? `après ${r.purpose === 'visite' ? 'la visite' : 'l’estimation'}` : `après « ${PURPOSE_LABEL[r.purpose].toLowerCase()} »`;
      return {
        keyId: r.key_id,
        number: r.number,
        propertyId: r.property_id,
        reference: r.reference,
        dueAt,
        overdue: now >= due,
        text: `Rendre le trousseau n° ${r.number} (${r.label}) du bien ${r.reference} à l’agence : ${why}.`,
      };
    });
    out.sort((a, b) => a.dueAt.localeCompare(b.dueAt) || a.number - b.number);
    await appendEvent(this.journal, { type: 'cle.rappels_lus', actor: this.actor(viewer), subject: `agent:${viewer.userId}`, data: { rule: 'R272', count: out.length, overdue: out.filter((r) => r.overdue).length } }, this.now);
    return { ok: true, value: out };
  }

  /**
   * L'espace du vendeur : qui a pris la clé de chez lui et quand, pour quel rendez-vous, et quand elle est revenue. Le
   * vendeur ne voit que les biens dont il est le mandant aujourd'hui, et rien d'avant le début de sa suite de mandats ;
   * jamais le nom d'un visiteur ni d'un acquéreur [R272, R161].
   */
  async forSeller(viewer: ClientViewer, propertyId: string): Promise<{ ok: true; value: SellerKeyEntry[] } | { ok: false; rule: 'R161'; code: string }> {
    const subject = `property:${propertyId}`;
    const actor = `client:${viewer.personId}`;
    const refuse = async (code: string) => {
      await appendEvent(this.journal, { type: 'acces.refuse', actor, subject, data: { rule: 'R161', kind: 'cles', code } }, this.now);
      return { ok: false as const, rule: 'R161' as const, code };
    };
    if (viewer.kind !== 'client' || !viewer.sides.includes('vendeur')) return refuse('side');
    const windows = await sellerWindows(this.db, this.fiche, viewer.networkId, viewer.personId);
    const w = windows.find((x) => x.propertyId === propertyId);
    // Un bien qui n'est pas le sien : refusé comme s'il n'existait pas.
    if (!w) return refuse('unknown');
    const rows = await this.db.all<LoanRow & { number: number; label: string; start_at: string | null; end_at: string | null; status: string | null }>(
      `SELECT l.id, l.key_id, l.holder_agent_id, ag.first_name, ag.last_name, l.purpose, l.appointment_id, l.due_at, l.out_at,
              r.outcome, r.returned_at, k.number, k.label, a.start_at, a.end_at, a.status
         FROM property_key_loans l
         JOIN property_keys k ON k.id = l.key_id
         JOIN agents ag ON ag.id = l.holder_agent_id
         LEFT JOIN property_key_returns r ON r.loan_id = l.id
         LEFT JOIN appointments a ON a.id = l.appointment_id
        WHERE k.network_id = ? AND k.property_id = ? AND l.out_at >= ?
        ORDER BY l.out_at DESC, l.id`,
      [viewer.networkId, propertyId, w.since],
    );
    const value: SellerKeyEntry[] = rows.map((l) => ({
      number: l.number,
      label: l.label,
      agent: shortName(l.first_name, l.last_name),
      purpose: PURPOSE_LABEL[l.purpose],
      takenAt: l.out_at,
      appointment:
        l.appointment_id && l.start_at && l.end_at
          ? { start: l.start_at, end: l.end_at, state: l.status === 'cancelled' ? 'annule' : l.status === 'honored' ? 'fait' : l.status === 'absent' ? 'absent' : 'prevu' }
          : null,
      returnedAt: l.outcome === 'rendu' ? l.returned_at : null,
      lost: l.outcome === 'perdu',
    }));
    await appendEvent(this.journal, { type: 'cle.vue_vendeur', actor, subject, data: { rule: 'R272', count: value.length } }, this.now);
    return { ok: true, value };
  }
}
