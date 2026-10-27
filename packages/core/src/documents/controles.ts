/**
 * Les contrôles avant signature (M06, D03) [R41].
 *
 * Avant toute signature, le document passe un contrôle écrit, ligne par ligne :
 * - champs : tous les champs du modèle sont remplis ;
 * - modèle : le modèle est validé (un document d'essai ne se signe jamais pour de vrai) ;
 * - honoraires : montant, prix et qui les paie connus, montant dans le barème du réseau (taux maximal du prix et
 *   minimum, réglés par la direction) ;
 * - mandants : les propriétaires du bien connus dans la base sont exactement le mandant du document ;
 * - identité : l'identité de chaque mandant a été vérifiée (pièce vue, quand, par qui) depuis moins d'un an.
 * Un seul échec suffit : le document ne peut pas être signé. Le résultat est gardé et rendu à l'agent.
 *
 * Décidé, lecture prudente : le modèle ne porte qu'un mandant ; un bien à plusieurs propriétaires ne passe pas tant
 * que le modèle ne les nomme pas tous. Un bien sans propriétaire connu ne passe pas. L'identité vérifiée ne garde ni
 * numéro ni copie de la pièce, qui vivent dans le coffre de la conformité [R15]. Le journal ne porte que des codes
 * [R13]. Droits : ceux de la fiche et du bien [R16].
 */
import type { Acces } from '../acces/acces.ts';
import type { Viewer } from '../acces/droits.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { FicheClient } from '../db/fiche-client.ts';
import { FicheUnique } from '../fiche/fusion.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import type { DocumentFacts } from './modeles.ts';

export const IDENTITY_PIECES = ['carte_identite', 'passeport', 'permis_conduire'] as const;
export type IdentityPiece = (typeof IDENTITY_PIECES)[number];
export const CHECK_NAMES = ['champs', 'modele', 'honoraires', 'mandants', 'identite'] as const;
export type CheckName = (typeof CHECK_NAMES)[number];

export interface CheckLine {
  check: CheckName;
  ok: boolean;
  /** Pourquoi, en un code : jamais une donnée personnelle. */
  code: string;
}

export interface SignatureCheck {
  documentId: string;
  passed: boolean;
  lines: CheckLine[];
  checkedAt: string;
}

export interface ControlSettings {
  /** Durée de validité d'une identité vérifiée, en jours. */
  identityDays: number;
}
export const DEFAULT_CONTROL_SETTINGS: ControlSettings = Object.freeze({ identityDays: 365 });

type Refusal = { ok: false; rule: 'R16'; code: string };
type Problem = { ok: false; rule: null; code: 'bad_schedule' | 'bad_piece' | 'bad_date' | 'unknown_document' };

const DAY = 86_400_000;
const placeholders = (n: number): string => Array.from({ length: n }, () => '?').join(', ');

export class ControlesSignature {
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly settings: ControlSettings;
  private readonly unique: FicheUnique;

  constructor(
    private readonly db: SqlDatabase,
    private readonly acces: Acces,
    private readonly journal: JournalStore,
    options: { now?: () => Date; newId?: () => string; settings?: ControlSettings } = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => crypto.randomUUID());
    this.settings = options.settings ?? DEFAULT_CONTROL_SETTINGS;
    this.unique = new FicheUnique(db, new FicheClient(db, { now: this.now }), { now: this.now });
  }

  private actor(viewer: Viewer): string {
    return `${String(viewer.role)}:${viewer.userId}`;
  }

  private async refuse(viewer: Viewer, kind: string, code: string, subject: string | null = null): Promise<Refusal> {
    await appendEvent(this.journal, { type: 'acces.refuse', actor: this.actor(viewer), subject, data: { rule: 'R16', role: String(viewer.role), kind, code } }, this.now);
    return { ok: false, rule: 'R16', code };
  }

  /** Le barème des honoraires : la direction seule ; le dernier réglé est en vigueur. */
  async setFeeSchedule(viewer: Viewer, schedule: { maxRatePercent: number; minEur: number }): Promise<{ ok: true } | Refusal | Problem> {
    if (viewer.role !== 'direction') return this.refuse(viewer, 'fee_schedule', 'role');
    const bp = Math.round(schedule.maxRatePercent * 100);
    if (typeof schedule.maxRatePercent !== 'number' || !Number.isFinite(schedule.maxRatePercent) || bp < 1 || bp > 10_000 || Math.abs(bp - schedule.maxRatePercent * 100) > 1e-6) return { ok: false, rule: null, code: 'bad_schedule' };
    if (!Number.isInteger(schedule.minEur) || schedule.minEur < 0) return { ok: false, rule: null, code: 'bad_schedule' };
    await this.db.run('INSERT INTO fee_schedules (id, network_id, max_rate_bp, min_eur, set_by, set_at) VALUES (?, ?, ?, ?, ?, ?)', [this.newId(), viewer.networkId, bp, schedule.minEur, this.actor(viewer), this.now().toISOString()]);
    await appendEvent(this.journal, { type: 'bareme.regle', actor: this.actor(viewer), subject: null, data: { maxRateBp: bp, minEur: schedule.minEur } }, this.now);
    return { ok: true };
  }

  /** L'identité vérifiée d'une personne : pièce vue, quand, par qui ; l'agent de la fiche ou la conformité. */
  async recordIdentity(viewer: Viewer, personId: string, input: { piece: string; seenAt: Date }): Promise<{ ok: true; id: string } | Refusal | Problem> {
    if (!(IDENTITY_PIECES as readonly string[]).includes(input.piece)) return { ok: false, rule: null, code: 'bad_piece' };
    if (!(input.seenAt instanceof Date) || Number.isNaN(input.seenAt.getTime()) || input.seenAt.getTime() > this.now().getTime()) return { ok: false, rule: null, code: 'bad_date' };
    if (viewer.role !== 'agent' && viewer.role !== 'compliance') return this.refuse(viewer, 'identity', 'role', `person:${personId}`);
    const read = await this.acces.readFiche(viewer, personId);
    if (!read.ok) return read;
    if (read.view !== 'full') return this.refuse(viewer, 'identity', 'not_assigned', `person:${personId}`);
    const id = this.newId();
    await this.db.run('INSERT INTO identity_checks (id, network_id, person_id, piece, seen_at, checked_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [
      id,
      viewer.networkId,
      read.value.person.id,
      input.piece,
      input.seenAt.toISOString(),
      this.actor(viewer),
      this.now().toISOString(),
    ]);
    await appendEvent(this.journal, { type: 'identite.verifiee', actor: this.actor(viewer), subject: `person:${read.value.person.id}`, data: { piece: input.piece } }, this.now);
    return { ok: true, id };
  }

  /** Le contrôle d'un document avant signature : chaque ligne, et le verdict ; gardé et écrit au journal [R41]. */
  async check(viewer: Viewer, documentId: string): Promise<{ ok: true; value: SignatureCheck } | Refusal | Problem> {
    if (viewer.role !== 'agent' && viewer.role !== 'direction' && viewer.role !== 'compliance') return this.refuse(viewer, 'document', 'role', `document:${documentId}`);
    const doc = await this.db.first<{ id: string; network_id: string; mode: string; status: string; person_id: string; property_id: string | null; facts: string | null }>(
      'SELECT id, network_id, mode, status, person_id, property_id, facts FROM documents WHERE id = ?',
      [documentId],
    );
    if (!doc || doc.network_id !== viewer.networkId) return this.refuse(viewer, 'document', 'unknown', `document:${documentId}`);
    const fiche = await this.acces.readFiche(viewer, doc.person_id);
    if (!fiche.ok) return fiche;
    if (fiche.view !== 'full') return this.refuse(viewer, 'document', 'not_assigned', `document:${documentId}`);
    if (doc.property_id) {
      const property = await this.acces.readProperty(viewer, doc.property_id);
      if (!property.ok) return property;
      if (property.view !== 'full') return this.refuse(viewer, 'document', 'not_assigned', `document:${documentId}`);
    }

    const at = this.now();
    const lines: CheckLine[] = [];
    lines.push({ check: 'champs', ok: doc.status === 'complet', code: doc.status === 'complet' ? 'complete' : 'missing_fields' });
    lines.push({ check: 'modele', ok: doc.mode === 'reel', code: doc.mode === 'reel' ? 'validated_template' : 'trial_template' });
    lines.push(await this.fees(doc.network_id, doc.facts));
    const mandants = await this.mandants(doc.person_id, doc.property_id);
    lines.push(mandants);
    lines.push(await this.identity(doc.network_id, doc.person_id, at));

    const passed = lines.every((l) => l.ok);
    const result: SignatureCheck = { documentId: doc.id, passed, lines, checkedAt: at.toISOString() };
    await this.db.run('INSERT INTO document_checks (id, network_id, document_id, passed, lines, checked_by, checked_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [
      this.newId(),
      doc.network_id,
      doc.id,
      passed ? 1 : 0,
      JSON.stringify(lines),
      this.actor(viewer),
      result.checkedAt,
    ]);
    await appendEvent(
      this.journal,
      { type: 'document.controle', actor: this.actor(viewer), subject: `document:${doc.id}`, data: { rule: 'R41', passed, failed: lines.filter((l) => !l.ok).map((l) => l.code) } },
      this.now,
    );
    return { ok: true, value: result };
  }

  private async fees(networkId: string, rawFacts: string | null): Promise<CheckLine> {
    let facts: DocumentFacts | null = null;
    try {
      facts = rawFacts ? (JSON.parse(rawFacts) as DocumentFacts) : null;
    } catch {
      facts = null;
    }
    const line = (ok: boolean, code: string): CheckLine => ({ check: 'honoraires', ok, code });
    if (!facts || facts.feeEur === null || facts.priceEur === null) return line(false, 'fee_or_price_unknown');
    if (facts.feeCharge === null) return line(false, 'fee_payer_unknown');
    const schedule = await this.db.first<{ max_rate_bp: number; min_eur: number }>('SELECT max_rate_bp, min_eur FROM fee_schedules WHERE network_id = ? ORDER BY set_at DESC, rowid DESC LIMIT 1', [networkId]);
    if (!schedule) return line(false, 'no_fee_schedule');
    // Calcul en entiers : honoraires × 10 000 ≤ prix × taux en points de base.
    if (facts.feeEur * 10_000 > facts.priceEur * Number(schedule.max_rate_bp)) return line(false, 'fee_above_schedule');
    if (facts.feeEur < Number(schedule.min_eur)) return line(false, 'fee_below_minimum');
    return line(true, 'fee_in_schedule');
  }

  private async mandants(personId: string, propertyId: string | null): Promise<CheckLine> {
    const line = (ok: boolean, code: string): CheckLine => ({ check: 'mandants', ok, code });
    if (!propertyId) return line(false, 'no_property');
    const owners = await this.db.all<{ person_id: string }>(
      `SELECT DISTINCT p.person_id FROM project_properties pp JOIN projects p ON p.id = pp.project_id WHERE pp.property_id = ? AND pp.role = 'owned'`,
      [propertyId],
    );
    if (owners.length === 0) return line(false, 'owners_unknown');
    const roots = new Set<string>();
    for (const o of owners) roots.add(await this.unique.rootOf(o.person_id));
    const mandant = await this.unique.rootOf(personId);
    if (roots.size !== 1 || !roots.has(mandant)) return line(false, 'mandants_differ');
    return line(true, 'mandants_match');
  }

  private async identity(networkId: string, personId: string, at: Date): Promise<CheckLine> {
    const ids = await this.unique.membersOf(personId);
    const since = new Date(at.getTime() - this.settings.identityDays * DAY).toISOString();
    const found = await this.db.first<{ id: string }>(
      `SELECT id FROM identity_checks WHERE network_id = ? AND person_id IN (${placeholders(ids.length)}) AND seen_at >= ? AND seen_at <= ? LIMIT 1`,
      [networkId, ...ids, since, at.toISOString()],
    );
    return { check: 'identite', ok: !!found, code: found ? 'identity_verified' : 'identity_missing' };
  }

  /** Le dernier contrôle gardé d'un document. */
  async last(documentId: string): Promise<SignatureCheck | null> {
    const row = await this.db.first<{ document_id: string; passed: number; lines: string; checked_at: string }>('SELECT document_id, passed, lines, checked_at FROM document_checks WHERE document_id = ? ORDER BY checked_at DESC, rowid DESC LIMIT 1', [documentId]);
    return row ? { documentId: row.document_id, passed: Number(row.passed) === 1, lines: JSON.parse(row.lines) as CheckLine[], checkedAt: row.checked_at } : null;
  }
}
