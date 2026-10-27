/**
 * Visite sécurisée (M08, T05). Avant la visite, le visiteur confirme son téléphone, par un code à usage unique envoyé
 * par le contrôle central (rangé dans la boîte d'essai), et son identité, par son nom, égal à celui de sa fiche :
 * aucune visite n'est confirmée sans les deux [R54]. Aucune pièce d'identité n'est demandée ni gardée [R15]. L'agent
 * dispose d'une alerte en un geste : elle est rangée d'abord, avec l'heure, la commune et l'heure de la visite en cours,
 * puis la direction est prévenue ; un envoi en panne est réessayé, sans doublon.
 *
 * Décidé, lecture prudente : la tournée partagée avec un proche existe déjà (V07) : un message par le contrôle central,
 * avec les heures et les communes seulement, plutôt qu'un lien ; T05 ne la refait pas. La confirmation de réservation
 * d'une visite dit « réservée », jamais « confirmée » [R54]. Le code part par SMS, avec l'accord du visiteur, donné à l'agent et dont
 * l'agent garde la preuve [R03]. Un code vaut 30 minutes, cinq essais faux le bloquent.
 */
import type { Viewer } from '../acces/droits.ts';
import { trialChannels } from '../captation/essai.ts';
import { FicheClient } from '../db/fiche-client.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { sha256 } from '../documents/modeles.ts';
import { ControleEnvois } from '../envoi/controle.ts';
import { SqlSendJournal } from '../envoi/journal-envois.ts';
import { DecisionEnvoi } from '../envoi/service.ts';
import { plain } from '../envoi/texte.ts';
import { FicheUnique } from '../fiche/fusion.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import type { Visites } from './visites.ts';

/** La finalité de l'accord du visiteur pour recevoir son code [R03]. */
export const VISIT_SAFETY_PURPOSE = 'visite_securisee';
export const VISIT_CODE_TTL_MINUTES = 30;
export const VISIT_CODE_MAX_ATTEMPTS = 5;

function newCode(): string {
  const buf = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(buf);
    const v = buf[0]!;
    if (v < 4_294_000_000) return String(v % 1_000_000).padStart(6, '0');
  }
}

const sameName = (a: string, b: string): boolean => plain(a).replace(/[^a-z]+/g, ' ').trim() === plain(b).replace(/[^a-z]+/g, ' ').trim();

export type SafetyRefusal = { ok: false; rule: string | null; code: string };

/** Ce que la direction reçoit : aucun nom, aucune adresse. */
export interface SafetyAlert {
  id: string;
  agentId: string;
  raisedAt: string;
  town: string | null;
  visitStartAt: string | null;
  appointmentId: string | null;
}

/** Qui prévient la direction. En essai : une ligne au journal, rien ne part. */
export interface DirectionNotifier {
  notify(alert: SafetyAlert): Promise<void>;
}

export class TrialDirectionNotifier implements DirectionNotifier {
  constructor(
    private readonly journal: JournalStore,
    private readonly now: () => Date,
  ) {}

  async notify(alert: SafetyAlert): Promise<void> {
    await appendEvent(this.journal, { type: 'alerte.direction.essai', actor: 'system:securite', subject: `alert:${alert.id}`, data: { mode: 'essai', sent: false, agent: alert.agentId } }, this.now);
  }
}

export interface SecuriteOptions {
  notifier?: DirectionNotifier;
  now?: () => Date;
}

export class VisiteSecurisee {
  private readonly now: () => Date;
  private readonly store: FicheClient;
  private readonly fiche: FicheUnique;
  private readonly controle: ControleEnvois;
  private readonly notifier: DirectionNotifier;

  constructor(
    private readonly db: SqlDatabase,
    private readonly journal: JournalStore,
    private readonly visites: Visites,
    options: SecuriteOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.store = new FicheClient(db, { now: this.now });
    this.fiche = new FicheUnique(db, this.store, { now: this.now });
    this.controle = new ControleEnvois(db, this.fiche, new DecisionEnvoi(db, this.store, this.fiche, { now: this.now }), {
      channels: trialChannels(db, journal, this.now),
      journal: new SqlSendJournal(db, undefined, this.now),
      now: this.now,
    });
    this.notifier = options.notifier ?? new TrialDirectionNotifier(journal, this.now);
  }

  private actor(viewer: Viewer): string {
    return `${String(viewer.role)}:${viewer.userId}`;
  }

  private async refused(viewer: Viewer, subject: string | null, code: string): Promise<SafetyRefusal> {
    await appendEvent(this.journal, { type: 'acces.refuse', actor: this.actor(viewer), subject, data: { rule: 'R16', role: String(viewer.role), kind: 'safety_alert', code } }, this.now);
    return { ok: false, rule: 'R16', code };
  }

  /**
   * Envoie au visiteur son code, par SMS, par le contrôle central. L'accord du visiteur est rangé avec sa preuve
   * s'il n'y est pas déjà [R03]. Un nouveau code remplace l'ancien.
   */
  async sendCode(viewer: Viewer, appointmentId: string, input: { consentProof: string }): Promise<{ ok: true; expiresAt: string } | SafetyRefusal> {
    const visit = await this.visites.accessVisit(viewer, appointmentId);
    if (!visit.ok) return visit;
    if (typeof input.consentProof !== 'string' || input.consentProof.trim() === '' || input.consentProof.length > 300) return { ok: false, rule: null, code: 'bad_consent' };
    const v = (await this.db.first<{ network_id: string; person_id: string; agent_id: string }>('SELECT network_id, person_id, agent_id FROM visits WHERE appointment_id = ?', [appointmentId]))!;
    const appt = await this.db.first<{ status: string }>('SELECT status FROM appointments WHERE id = ?', [appointmentId]);
    if (appt?.status !== 'booked') return { ok: false, rule: null, code: 'not_booked' };
    const safety = await this.db.first<{ phone_confirmed_at: string | null }>('SELECT phone_confirmed_at FROM visit_safety WHERE appointment_id = ?', [appointmentId]);
    if (safety?.phone_confirmed_at) return { ok: false, rule: null, code: 'already_confirmed' };
    const members = await this.fiche.membersOf(v.person_id);
    const consent = await this.db.first(
      `SELECT id FROM consents WHERE person_id IN (${members.map(() => '?').join(', ')}) AND purpose = ? AND channel = 'sms' AND withdrawn_at IS NULL`,
      [...members, VISIT_SAFETY_PURPOSE],
    );
    const at = this.now();
    // Un accord retiré par le visiteur ne se redonne pas par la seule parole de l'agent [R03].
    if (!consent) {
      const withdrawn = await this.db.first(
        `SELECT id FROM consents WHERE person_id IN (${members.map(() => '?').join(', ')}) AND purpose = ? AND channel = 'sms' AND withdrawn_at IS NOT NULL`,
        [...members, VISIT_SAFETY_PURPOSE],
      );
      if (withdrawn) return { ok: false, rule: 'R03', code: 'consent_withdrawn' };
    }
    if (!consent) await this.store.addConsent({ networkId: v.network_id, personId: v.person_id, purpose: VISIT_SAFETY_PURPOSE, channel: 'sms', proof: input.consentProof.trim(), givenAt: at });
    const code = newCode();
    const expiresAt = new Date(at.getTime() + VISIT_CODE_TTL_MINUTES * 60_000).toISOString();
    const requestId = crypto.randomUUID();
    const first = (await this.fiche.view(v.person_id)).members.map((m) => m.first_name).find((n) => n) ?? null;
    const sent = await this.controle.send({
      networkId: v.network_id,
      agentId: v.agent_id,
      personId: v.person_id,
      channel: 'sms',
      kind: 'alert',
      purpose: VISIT_SAFETY_PURPOSE,
      subject: `visite_code:${appointmentId}:${requestId}`,
      fallbackTexts: [
        `${first ? `Bonjour ${first}, v` : 'V'}otre code pour confirmer la visite : ${code}. Il est valable ${VISIT_CODE_TTL_MINUTES} minutes. Donnez-le seulement à votre agent immobilier, au moment de la visite.`,
      ],
      figures: [code, VISIT_CODE_TTL_MINUTES],
    });
    if (sent.status !== 'sent') return { ok: false, rule: sent.rule, code: 'send_refused' };
    // Le code n'est rangé qu'une fois envoyé : un code jamais parti ne peut pas servir.
    const hash = await sha256(`${appointmentId}:${code}`);
    await this.db.run(
      `INSERT INTO visit_safety (appointment_id, network_id, code_hash, code_expires_at, attempts, requested_at) VALUES (?, ?, ?, ?, 0, ?)
       ON CONFLICT (appointment_id) DO UPDATE SET code_hash = excluded.code_hash, code_expires_at = excluded.code_expires_at, attempts = 0, requested_at = excluded.requested_at`,
      [appointmentId, v.network_id, hash, expiresAt, at.toISOString()],
    );
    await appendEvent(this.journal, { type: 'visite.code_envoye', actor: this.actor(viewer), subject: `visit:${appointmentId}`, data: { mode: 'essai' } }, this.now);
    return { ok: true, expiresAt };
  }

  /**
   * Le visiteur donne son code et son nom à l'agent, qui les saisit. Le code ne sert qu'une fois, expire, et cinq essais
   * faux le bloquent ; le nom doit être celui de la fiche. Rien de ce qui est saisi n'est gardé ni écrit au journal.
   */
  async confirm(viewer: Viewer, appointmentId: string, input: { code: string; lastName: string }): Promise<{ ok: true; confirmed: boolean } | SafetyRefusal> {
    const visit = await this.visites.accessVisit(viewer, appointmentId);
    if (!visit.ok) return visit;
    const row = await this.db.first<{ code_hash: string | null; code_expires_at: string | null; attempts: number; phone_confirmed_at: string | null; identity_confirmed_at: string | null }>(
      'SELECT code_hash, code_expires_at, attempts, phone_confirmed_at, identity_confirmed_at FROM visit_safety WHERE appointment_id = ?',
      [appointmentId],
    );
    if (!row || !row.code_hash || !row.code_expires_at) return { ok: false, rule: 'R54', code: 'no_code' };
    if (row.phone_confirmed_at && row.identity_confirmed_at) return { ok: true, confirmed: true };
    const at = this.now();
    if (Number(row.attempts) >= VISIT_CODE_MAX_ATTEMPTS) return { ok: false, rule: 'R54', code: 'blocked' };
    if (Date.parse(row.code_expires_at) <= at.getTime()) return { ok: false, rule: 'R54', code: 'expired' };
    // Chaque essai est compté d'abord : deux essais simultanés ne passent pas la limite.
    const { changes } = await this.db.run('UPDATE visit_safety SET attempts = attempts + 1 WHERE appointment_id = ? AND attempts < ?', [appointmentId, VISIT_CODE_MAX_ATTEMPTS]);
    if (changes !== 1) return { ok: false, rule: 'R54', code: 'blocked' };
    if (typeof input.code !== 'string' || (await sha256(`${appointmentId}:${input.code.trim()}`)) !== row.code_hash) {
      await appendEvent(this.journal, { type: 'visite.code_faux', actor: this.actor(viewer), subject: `visit:${appointmentId}`, data: { rule: 'R54' } }, this.now);
      return { ok: false, rule: 'R54', code: 'bad_code' };
    }
    const v = (await this.db.first<{ person_id: string }>('SELECT person_id FROM visits WHERE appointment_id = ?', [appointmentId]))!;
    const names = (await this.fiche.view(v.person_id)).members.map((m) => m.last_name).filter((n): n is string => typeof n === 'string' && n.trim() !== '');
    if (names.length === 0) return { ok: false, rule: 'R54', code: 'no_identity' };
    if (typeof input.lastName !== 'string' || !names.some((n) => sameName(n, input.lastName))) {
      await appendEvent(this.journal, { type: 'visite.identite_refusee', actor: this.actor(viewer), subject: `visit:${appointmentId}`, data: { rule: 'R54' } }, this.now);
      return { ok: false, rule: 'R54', code: 'bad_identity' };
    }
    // Le code est consommé avec la confirmation : il ne servira plus.
    const iso = at.toISOString();
    const done = await this.db.run(
      'UPDATE visit_safety SET code_hash = NULL, phone_confirmed_at = ?, identity_confirmed_at = ? WHERE appointment_id = ? AND code_hash = ? AND phone_confirmed_at IS NULL',
      [iso, iso, appointmentId, row.code_hash],
    );
    if (done.changes !== 1) {
      // Un nouveau code a pris la place de celui-ci entre-temps : seule une confirmation rangée compte [R54].
      return (await this.isConfirmed(appointmentId)) ? { ok: true, confirmed: true } : { ok: false, rule: 'R54', code: 'superseded' };
    }
    await appendEvent(this.journal, { type: 'visite.confirmee', actor: this.actor(viewer), subject: `visit:${appointmentId}`, data: { rule: 'R54' } }, this.now);
    return { ok: true, confirmed: true };
  }

  /** La visite est confirmée seulement quand le téléphone et l'identité du visiteur le sont [R54]. */
  async isConfirmed(appointmentId: string): Promise<boolean> {
    const row = await this.db.first<{ phone_confirmed_at: string | null; identity_confirmed_at: string | null }>(
      'SELECT phone_confirmed_at, identity_confirmed_at FROM visit_safety WHERE appointment_id = ?',
      [appointmentId],
    );
    return Boolean(row?.phone_confirmed_at && row.identity_confirmed_at);
  }

  /**
   * L'alerte en un geste : l'agent seul, pour lui-même. Elle est rangée d'abord, une seule fois pour un même geste,
   * avec la visite en cours s'il y en a une ; puis la direction est prévenue. Un envoi en panne est repris.
   */
  async raise(viewer: Viewer, alertId: string): Promise<{ ok: true; recorded: true; notified: boolean } | SafetyRefusal> {
    if (viewer.role !== 'agent') return this.refused(viewer, null, 'role');
    if (typeof alertId !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(alertId)) return { ok: false, rule: null, code: 'bad_id' };
    const agent = await this.db.first<{ status: string }>('SELECT status FROM agents WHERE id = ? AND network_id = ?', [viewer.userId, viewer.networkId]);
    if (agent?.status !== 'active') return this.refused(viewer, null, 'agent_inactive');
    const at = this.now();
    const iso = at.toISOString();
    // La visite en cours d'abord ; sinon la prochaine dans l'heure : sa commune et son heure, rien d'autre.
    const pick = (where: string, order: string, params: string[]) =>
      this.db.first<{ id: string; start_at: string; city: string | null }>(
        `SELECT a.id, a.start_at, p.city FROM appointments a JOIN visits v ON v.appointment_id = a.id JOIN properties p ON p.id = v.property_id
         WHERE a.agent_id = ? AND a.network_id = ? AND a.status = 'booked' AND ${where} ORDER BY ${order} LIMIT 1`,
        [viewer.userId, viewer.networkId, ...params],
      );
    const current =
      (await pick('a.start_at <= ? AND a.end_at >= ?', 'a.start_at DESC', [iso, iso])) ??
      (await pick('a.start_at > ? AND a.start_at <= ?', 'a.start_at ASC', [iso, new Date(at.getTime() + 3_600_000).toISOString()]));
    const { changes } = await this.db.run(
      `INSERT INTO safety_alerts (id, network_id, agent_id, appointment_id, raised_at, town, visit_start_at, notified_at, attempts) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 0)
       ON CONFLICT (id) DO NOTHING`,
      [alertId, viewer.networkId, viewer.userId, current?.id ?? null, iso, current?.city ?? null, current?.start_at ?? null],
    );
    if (changes === 1) await appendEvent(this.journal, { type: 'visite.alerte', actor: this.actor(viewer), subject: `alert:${alertId}`, data: { visit: current ? 1 : 0 } }, this.now);
    const row = await this.db.first<{ agent_id: string; network_id: string }>('SELECT agent_id, network_id FROM safety_alerts WHERE id = ?', [alertId]);
    if (!row || row.agent_id !== viewer.userId || row.network_id !== viewer.networkId) return this.refused(viewer, `alert:${alertId}`, 'not_assigned');
    return { ok: true, recorded: true, notified: await this.notifyOne(alertId) };
  }

  /** Reprend les alertes que la direction n'a pas encore reçues ; chacune n'est envoyée avec succès qu'une fois. */
  async retry(): Promise<number> {
    const open = await this.db.all<{ id: string }>('SELECT id FROM safety_alerts WHERE notified_at IS NULL ORDER BY raised_at');
    let done = 0;
    for (const a of open) if (await this.notifyOne(a.id)) done += 1;
    return done;
  }

  /** Les alertes du réseau, pour la direction seule. */
  async list(viewer: Viewer): Promise<{ ok: true; alerts: (SafetyAlert & { notified: boolean })[] } | SafetyRefusal> {
    if (viewer.role !== 'direction') return this.refused(viewer, null, 'role');
    const rows = await this.db.all<{ id: string; agent_id: string; raised_at: string; town: string | null; visit_start_at: string | null; appointment_id: string | null; notified_at: string | null }>(
      'SELECT * FROM safety_alerts WHERE network_id = ? ORDER BY raised_at DESC',
      [viewer.networkId],
    );
    return {
      ok: true,
      alerts: rows.map((r) => ({ id: r.id, agentId: r.agent_id, raisedAt: r.raised_at, town: r.town, visitStartAt: r.visit_start_at, appointmentId: r.appointment_id, notified: r.notified_at !== null })),
    };
  }

  private async notifyOne(alertId: string): Promise<boolean> {
    // Une seule prise à la fois, pour deux minutes : deux reprises simultanées ne préviennent pas deux fois.
    const nowIso = this.now().toISOString();
    const claim = await this.db.run(
      'UPDATE safety_alerts SET attempts = attempts + 1, claimed_until = ? WHERE id = ? AND notified_at IS NULL AND (claimed_until IS NULL OR claimed_until <= ?)',
      [new Date(this.now().getTime() + 120_000).toISOString(), alertId, nowIso],
    );
    if (claim.changes !== 1) return (await this.db.first('SELECT id FROM safety_alerts WHERE id = ? AND notified_at IS NOT NULL', [alertId])) !== null;
    const r = (await this.db.first<{ id: string; agent_id: string; raised_at: string; town: string | null; visit_start_at: string | null; appointment_id: string | null; attempts: number }>(
      'SELECT * FROM safety_alerts WHERE id = ?',
      [alertId],
    ))!;
    try {
      await this.notifier.notify({ id: r.id, agentId: r.agent_id, raisedAt: r.raised_at, town: r.town, visitStartAt: r.visit_start_at, appointmentId: r.appointment_id });
    } catch {
      await this.db.run('UPDATE safety_alerts SET claimed_until = NULL WHERE id = ? AND notified_at IS NULL', [alertId]);
      await appendEvent(this.journal, { type: 'visite.alerte_en_panne', actor: 'system:securite', subject: `alert:${alertId}`, data: { attempts: Number(r.attempts) } }, this.now);
      return false;
    }
    await this.db.run('UPDATE safety_alerts SET notified_at = ? WHERE id = ? AND notified_at IS NULL', [this.now().toISOString(), alertId]);
    return true;
  }
}
