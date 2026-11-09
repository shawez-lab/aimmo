/**
 * Clés d'accès par appareil et second facteur des actions sensibles (HX56) [R600, R601, R16, R13, R17].
 *
 * Chaque appareil d'un utilisateur du réseau (agent, direction, conformité) a sa propre clé d'accès WebAuthn :
 * l'empreinte ou le visage débloque la clé privée, qui ne quitte jamais l'appareil ; AIMMO n'en garde que la clé
 * publique. La direction retire une clé d'un geste : l'appareil ne se connecte plus, et ses séances ouvertes cessent à
 * l'instant même, car chaque lecture de séance relit l'état de sa clé.
 *
 * Jamais vu : le second facteur est lié à l'action exacte et à son objet. Une preuve faite pour exporter le fichier d'un
 * agent ne sert ni à un effacement, ni à un autre export, ni deux fois, ni après cinq minutes.
 *
 * Décidé, lecture prudente :
 * - la première clé d'un utilisateur est active d'emblée (il faut bien commencer) ; chaque clé suivante attend l'accord
 *   de la direction, ou une preuve faite pour « ajouter un appareil » par une clé déjà active de l'utilisateur ; une
 *   clé volée avec une clé d'API ne s'ajoute donc pas en silence ;
 * - l'accord d'une clé en attente est lui-même une action sensible : la direction le prouve par sa propre clé ;
 * - retirer une clé n'exige aucun second facteur : c'est un geste qui protège, il doit rester d'un seul geste ; la
 *   direction retire toute clé de son réseau, l'utilisateur les siennes ;
 * - un défi sert une fois, même raté : on ne réessaie pas une signature sur le même défi ;
 * - un compteur de signatures qui ne monte pas (hors appareils qui le laissent à zéro) trahit une clé copiée : la
 *   connexion est refusée, notée au journal, la clé reste à retirer par la direction ;
 * - un agent parti ne se connecte plus et ses séances cessent [R82].
 */
import type { Role, Viewer } from '../acces/droits.ts';
import { agentState } from '../acces/etat-agent.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import { ES256, fromBase64Url, sha256, toBase64Url, verifyAssertion, verifyRegistration, type Expected } from './webauthn.ts';

/** Les actions qui exigent un second facteur, liste fermée [R601]. */
export const SENSITIVE_ACTIONS = [
  'ajouter_appareil',
  'approuver_appareil',
  'export_complet',
  'effacement',
  'modifier_droits',
  'modifier_rib',
  'creer_cle_api',
] as const;
export type SensitiveAction = (typeof SENSITIVE_ACTIONS)[number];

export const CHALLENGE_MINUTES = 5;
export const STEP_UP_MINUTES = 5;
export const SESSION_HOURS = 12;
export const MAX_DEVICES_PER_USER = 10;

const DEVICE_ROLES: readonly Role[] = ['agent', 'direction', 'compliance'];
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const SUBJECT = /^[a-z_]{1,24}:[A-Za-z0-9_-]{1,64}$/;
const LABEL = /^[\p{L}\p{N} '’-]{1,40}$/u;

export type SecurityRule = 'R16' | 'R600' | 'R601';
export type SecurityRefusal = { ok: false; rule: SecurityRule; code: string };
export type SecurityResult<T> = { ok: true; value: T } | SecurityRefusal;

export type DeviceStatus = 'en_attente' | 'actif' | 'retire';

export interface Device {
  id: string;
  userRole: Role;
  userId: string;
  label: string;
  status: DeviceStatus;
  createdAt: string;
  approvedAt: string | null;
  revokedAt: string | null;
}

export interface Challenge {
  challengeId: string;
  /** Le défi à passer tel quel à `navigator.credentials`, en base64url. */
  challenge: string;
  rpId: string;
  expiresAt: string;
  /** Identifiants des clés actives (connexion, preuve) ou déjà rangées (enregistrement, à exclure). */
  credentialIds: string[];
}

/** Ce que rend le navigateur, chaque champ en base64url. */
export interface RegistrationPayload {
  challengeId: unknown;
  credentialId: unknown;
  publicKey: unknown;
  clientDataJSON: unknown;
  authenticatorData: unknown;
  label: unknown;
  /** Une preuve « ajouter_appareil » faite par une clé active, pour une clé active d'emblée. */
  stepUpId?: unknown;
}

export interface AssertionPayload {
  challengeId: unknown;
  credentialId: unknown;
  clientDataJSON: unknown;
  authenticatorData: unknown;
  signature: unknown;
}

export interface Session {
  token: string;
  expiresAt: string;
  viewer: Viewer;
  deviceId: string;
}

export interface ClesAppareilOptions {
  /** L'identifiant du site WebAuthn (le domaine de l'application), sans schéma. */
  rpId: string;
  /** Les origines admises, en https. */
  origins: readonly string[];
  now?: () => Date;
  newId?: () => string;
  randomBytes?: (n: number) => Uint8Array;
}

interface DeviceRow {
  id: string;
  network_id: string;
  user_role: Role;
  user_id: string;
  credential_id: string;
  public_key: string;
  alg: number;
  sign_count: number;
  label: string;
  status: DeviceStatus;
  created_at: string;
  approved_at: string | null;
  revoked_at: string | null;
}

interface ChallengeRow {
  id: string;
  network_id: string;
  user_role: Role;
  user_id: string;
  purpose: 'register' | 'login' | 'step_up';
  challenge: string;
  action: string | null;
  subject: string | null;
  expires_at: string;
  used_at: string | null;
}

const isRole = (value: unknown): value is Role => typeof value === 'string' && (DEVICE_ROLES as readonly string[]).includes(value);

export class ClesAppareil {
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly randomBytes: (n: number) => Uint8Array;
  private readonly rpId: string;
  private readonly origins: readonly string[];

  constructor(
    private readonly db: SqlDatabase,
    private readonly journal: JournalStore,
    options: ClesAppareilOptions,
  ) {
    if (!/^[a-z0-9.-]{1,253}$/.test(options.rpId) || options.rpId.startsWith('.') || options.rpId.endsWith('.')) throw new Error('rpId invalide');
    if (options.origins.length === 0) throw new Error('aucune origine admise');
    for (const origin of options.origins) {
      let url: URL;
      try {
        url = new URL(origin);
      } catch {
        throw new Error(`origine invalide : ${origin}`);
      }
      if (url.protocol !== 'https:' || url.origin !== origin) throw new Error(`origine invalide : ${origin}`);
      if (url.hostname !== options.rpId && !url.hostname.endsWith(`.${options.rpId}`)) throw new Error(`origine hors du site : ${origin}`);
    }
    this.rpId = options.rpId;
    this.origins = [...options.origins];
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => crypto.randomUUID());
    this.randomBytes = options.randomBytes ?? ((n) => crypto.getRandomValues(new Uint8Array(n)));
  }

  // ---------------------------------------------------------------- enregistrement

  /** Un défi pour enregistrer la clé de cet appareil [R600]. */
  async beginRegistration(viewer: Viewer): Promise<SecurityResult<Challenge>> {
    const who = await this.checkUser(viewer, null);
    if (!who.ok) return who;
    const rows = await this.devicesOf(viewer);
    if (rows.filter((d) => d.status !== 'retire').length >= MAX_DEVICES_PER_USER) return this.refused(viewer, 'R600', 'too_many_devices', null);
    return this.issue(viewer, 'register', null, null, rows.map((d) => d.credential_id));
  }

  /**
   * La clé de l'appareil, rangée : active si c'est la toute première clé de l'utilisateur, ou si une preuve « ajouter
   * un appareil » d'une clé active l'accompagne ; sinon en attente de la direction [R600].
   */
  async finishRegistration(viewer: Viewer, payload: RegistrationPayload): Promise<SecurityResult<Device>> {
    const who = await this.checkUser(viewer, null);
    if (!who.ok) return who;
    const label = typeof payload.label === 'string' ? payload.label.trim() : '';
    const credentialId = fromBase64Url(payload.credentialId, 1023);
    const publicKey = fromBase64Url(payload.publicKey, 512);
    const clientDataJSON = fromBase64Url(payload.clientDataJSON);
    const authenticatorData = fromBase64Url(payload.authenticatorData);
    if (!LABEL.test(label) || !credentialId || !publicKey || !clientDataJSON || !authenticatorData) return this.refused(viewer, 'R600', 'bad_input', null);
    const challenge = await this.consumeChallenge(viewer, payload.challengeId, 'register');
    if (!challenge.ok) return challenge;
    const check = await verifyRegistration({ credentialId, publicKey, clientDataJSON, authenticatorData }, this.expected('webauthn.create', challenge.value.challenge));
    if (!check.ok) return this.refused(viewer, 'R600', check.code, null);
    const credential = toBase64Url(credentialId);
    if (await this.db.first('SELECT 1 FROM security_devices WHERE credential_id = ?', [credential])) return this.refused(viewer, 'R600', 'already_registered', null);

    const previous = await this.devicesOf(viewer);
    if (previous.filter((d) => d.status !== 'retire').length >= MAX_DEVICES_PER_USER) return this.refused(viewer, 'R600', 'too_many_devices', null);
    const id = this.newId();
    const at = this.now().toISOString();
    let approvedBy: string | null = null;
    if (previous.length > 0 && payload.stepUpId !== undefined) {
      const proof = await this.requireSecondFactor(viewer, 'ajouter_appareil', `user:${viewer.userId}`, payload.stepUpId);
      if (!proof.ok) return proof;
      approvedBy = `step_up:${proof.value.deviceId}`;
    }
    const insert = (status: DeviceStatus, by: string | null, onlyIfFirst: boolean) =>
      this.db.run(
        `INSERT INTO security_devices (id, network_id, user_role, user_id, credential_id, public_key, alg, sign_count, label, status, created_at, approved_at, approved_by)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?${onlyIfFirst ? ' WHERE NOT EXISTS (SELECT 1 FROM security_devices WHERE network_id = ? AND user_role = ? AND user_id = ?)' : ''}`,
        [id, viewer.networkId, viewer.role, viewer.userId, credential, toBase64Url(publicKey), ES256, check.value.signCount, label, status, at, by === null ? null : at, by, ...(onlyIfFirst ? [viewer.networkId, viewer.role, viewer.userId] : [])],
      );
    let status: DeviceStatus = approvedBy === null ? 'en_attente' : 'actif';
    let stored = false;
    if (previous.length === 0) {
      // La toute première clé, seulement si aucune autre n'est rangée entre-temps : deux enregistrements simultanés ne
      // font pas deux premières clés [R600].
      // Si la course est perdue, une seconde ligne du journal dit la clé en attente.
      await this.write(viewer, 'securite.cle.rangee', `device:${id}`, { rule: 'R600', status: 'actif', by: 'premiere_cle' });
      stored = (await insert('actif', 'premiere_cle', true)).changes === 1;
      if (stored) {
        status = 'actif';
        approvedBy = 'premiere_cle';
      }
    }
    if (!stored) {
      await this.write(viewer, 'securite.cle.rangee', `device:${id}`, { rule: 'R600', status, by: approvedBy ?? 'direction_attendue' });
      await insert(status, approvedBy, false);
    }
    return { ok: true, value: { id, userRole: viewer.role, userId: viewer.userId, label, status, createdAt: at, approvedAt: approvedBy === null ? null : at, revokedAt: null } };
  }

  // ---------------------------------------------------------------- direction

  /** Toutes les clés du réseau, pour la direction ; jamais une clé publique ni un identifiant de clé. */
  async listDevices(viewer: Viewer): Promise<SecurityResult<Device[]>> {
    if (viewer.role !== 'direction') return this.refused(viewer, 'R16', 'role', null);
    const rows = await this.db.all<DeviceRow>('SELECT * FROM security_devices WHERE network_id = ? ORDER BY created_at DESC, id', [viewer.networkId]);
    await this.write(viewer, 'securite.cles.lues', null, { rule: 'R600', count: rows.length });
    return { ok: true, value: rows.map(toDevice) };
  }

  /** La direction accepte une clé en attente, sur la preuve de sa propre clé pour cette clé-là [R600, R601]. */
  async approveDevice(viewer: Viewer, deviceId: unknown, stepUpId: unknown): Promise<SecurityResult<Device>> {
    if (viewer.role !== 'direction') return this.refused(viewer, 'R16', 'role', null);
    if (typeof deviceId !== 'string' || !ID.test(deviceId)) return this.refused(viewer, 'R600', 'bad_input', null);
    const subject = `device:${deviceId}`;
    const row = await this.db.first<DeviceRow>('SELECT * FROM security_devices WHERE id = ?', [deviceId]);
    if (!row || row.network_id !== viewer.networkId) return this.refused(viewer, 'R16', 'other_network', subject);
    if (row.status !== 'en_attente') return this.refused(viewer, 'R600', 'not_pending', subject);
    const proof = await this.requireSecondFactor(viewer, 'approuver_appareil', subject, stepUpId);
    if (!proof.ok) return proof;
    const at = this.now().toISOString();
    await this.write(viewer, 'securite.cle.acceptee', subject, { rule: 'R600' });
    const done = await this.db.run(
      "UPDATE security_devices SET status = 'actif', approved_at = ?, approved_by = ? WHERE id = ? AND status = 'en_attente'",
      [at, `direction:${viewer.userId}`, deviceId],
    );
    if (done.changes !== 1) return this.refused(viewer, 'R600', 'not_pending', subject);
    return { ok: true, value: toDevice({ ...row, status: 'actif', approved_at: at }) };
  }

  /**
   * Retirer une clé, d'un geste : la direction pour toute clé de son réseau, l'utilisateur pour les siennes. L'appareil
   * ne se connecte plus et ses séances cessent à l'instant [R600]. Aucun second facteur : c'est un geste qui protège.
   */
  async revokeDevice(viewer: Viewer, deviceId: unknown): Promise<SecurityResult<Device>> {
    if (typeof deviceId !== 'string' || !ID.test(deviceId)) return this.refused(viewer, 'R600', 'bad_input', null);
    const subject = `device:${deviceId}`;
    const row = await this.db.first<DeviceRow>('SELECT * FROM security_devices WHERE id = ?', [deviceId]);
    if (!row || row.network_id !== viewer.networkId) return this.refused(viewer, 'R16', 'other_network', subject);
    const own = row.user_role === viewer.role && row.user_id === viewer.userId;
    if (viewer.role !== 'direction' && !own) return this.refused(viewer, 'R16', 'role', subject);
    if (row.status === 'retire') return this.refused(viewer, 'R600', 'already_revoked', subject);
    const at = this.now().toISOString();
    await this.write(viewer, 'securite.cle.retiree', subject, { rule: 'R600', by: own ? 'utilisateur' : 'direction' });
    const done = await this.db.run(
      "UPDATE security_devices SET status = 'retire', revoked_at = ?, revoked_by = ? WHERE id = ? AND status <> 'retire'",
      [at, `${viewer.role}:${viewer.userId}`, deviceId],
    );
    if (done.changes !== 1) return this.refused(viewer, 'R600', 'already_revoked', subject);
    return { ok: true, value: toDevice({ ...row, status: 'retire', revoked_at: at }) };
  }

  // ---------------------------------------------------------------- connexion

  /** Un défi de connexion pour un utilisateur, avec ses seules clés actives [R600]. */
  async beginLogin(networkId: unknown, role: unknown, userId: unknown): Promise<SecurityResult<Challenge>> {
    if (typeof networkId !== 'string' || !ID.test(networkId) || !isRole(role) || typeof userId !== 'string' || !ID.test(userId)) {
      return { ok: false, rule: 'R600', code: 'bad_input' };
    }
    const viewer: Viewer = { networkId, role, userId };
    const who = await this.checkUser(viewer, null);
    if (!who.ok) return who;
    const active = (await this.devicesOf(viewer)).filter((d) => d.status === 'actif');
    if (active.length === 0) return this.refused(viewer, 'R600', 'no_device', null);
    return this.issue(viewer, 'login', null, null, active.map((d) => d.credential_id));
  }

  /** La signature de l'appareil sur le défi : une séance, dont seule l'empreinte du jeton est rangée [R600]. */
  async finishLogin(payload: AssertionPayload): Promise<SecurityResult<Session>> {
    if (typeof payload.challengeId !== 'string' || !ID.test(payload.challengeId)) return { ok: false, rule: 'R600', code: 'bad_input' };
    const row = await this.db.first<ChallengeRow>('SELECT * FROM security_challenges WHERE id = ?', [payload.challengeId]);
    if (!row || row.purpose !== 'login') return { ok: false, rule: 'R600', code: 'unknown_challenge' };
    const viewer: Viewer = { networkId: row.network_id, role: row.user_role, userId: row.user_id };
    const signed = await this.verifySigned(viewer, payload, 'login');
    if (!signed.ok) return signed;
    const token = toBase64Url(this.randomBytes(32));
    const id = this.newId();
    const at = this.now();
    const expiresAt = new Date(at.getTime() + SESSION_HOURS * 3_600_000).toISOString();
    await this.write(viewer, 'securite.connexion', `device:${signed.value.id}`, { rule: 'R600' });
    await this.db.run(
      'INSERT INTO security_sessions (id, token_hash, network_id, user_role, user_id, device_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [id, toBase64Url(await sha256(token)), viewer.networkId, viewer.role, viewer.userId, signed.value.id, at.toISOString(), expiresAt],
    );
    return { ok: true, value: { token, expiresAt, viewer, deviceId: signed.value.id } };
  }

  /**
   * Qui tient ce jeton, à cet instant : `null` si la séance est inconnue ou finie, si sa clé n'est plus active, ou si
   * l'agent est parti. Relu à chaque demande : retirer la clé coupe la séance tout de suite [R600, R82].
   */
  async authenticate(token: unknown): Promise<{ viewer: Viewer; deviceId: string } | null> {
    if (typeof token !== 'string' || fromBase64Url(token, 64) === null) return null;
    const row = await this.db.first<{ network_id: string; user_role: Role; user_id: string; device_id: string; expires_at: string; status: DeviceStatus; d_role: Role; d_user: string }>(
      'SELECT s.network_id, s.user_role, s.user_id, s.device_id, s.expires_at, d.status, d.user_role AS d_role, d.user_id AS d_user FROM security_sessions s JOIN security_devices d ON d.id = s.device_id WHERE s.token_hash = ?',
      [toBase64Url(await sha256(token))],
    );
    if (!row || row.status !== 'actif' || row.d_role !== row.user_role || row.d_user !== row.user_id) return null;
    if (Date.parse(row.expires_at) <= this.now().getTime()) return null;
    const viewer: Viewer = { networkId: row.network_id, role: row.user_role, userId: row.user_id };
    if (!(await this.userActive(viewer))) return null;
    return { viewer, deviceId: row.device_id };
  }

  // ---------------------------------------------------------------- second facteur

  /** Un défi pour prouver une action sensible précise sur un objet précis [R601]. */
  async beginStepUp(viewer: Viewer, action: unknown, subject: unknown): Promise<SecurityResult<Challenge>> {
    if (!isSensitive(action) || typeof subject !== 'string' || !SUBJECT.test(subject)) return this.refused(viewer, 'R601', 'bad_input', null);
    const who = await this.checkUser(viewer, null);
    if (!who.ok) return who;
    const active = (await this.devicesOf(viewer)).filter((d) => d.status === 'actif');
    if (active.length === 0) return this.refused(viewer, 'R601', 'no_device', subject);
    return this.issue(viewer, 'step_up', action, subject, active.map((d) => d.credential_id));
  }

  /** La signature d'une clé active de l'utilisateur sur ce défi : une preuve pour cette action et cet objet seuls [R601]. */
  async finishStepUp(viewer: Viewer, payload: AssertionPayload): Promise<SecurityResult<{ stepUpId: string; action: SensitiveAction; subject: string; expiresAt: string }>> {
    const signed = await this.verifySigned(viewer, payload, 'step_up');
    if (!signed.ok) return signed;
    const challenge = signed.value.challenge;
    const id = this.newId();
    const at = this.now();
    const expiresAt = new Date(at.getTime() + STEP_UP_MINUTES * 60_000).toISOString();
    await this.write(viewer, 'securite.second_facteur.prouve', challenge.subject, { rule: 'R601', action: challenge.action!, device: signed.value.id });
    await this.db.run(
      'INSERT INTO security_step_ups (id, network_id, user_role, user_id, device_id, action, subject, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [id, viewer.networkId, viewer.role, viewer.userId, signed.value.id, challenge.action, challenge.subject, at.toISOString(), expiresAt],
    );
    return { ok: true, value: { stepUpId: id, action: challenge.action as SensitiveAction, subject: challenge.subject!, expiresAt } };
  }

  /**
   * La porte de toute action sensible : passe une fois, pour cette action, cet objet et cet utilisateur, dans les cinq
   * minutes, si la clé qui a prouvé est encore active [R601]. La preuve est usée même si l'action échoue ensuite.
   */
  async requireSecondFactor(viewer: Viewer, action: SensitiveAction, subject: string, stepUpId: unknown): Promise<SecurityResult<{ deviceId: string }>> {
    if (!isSensitive(action) || !SUBJECT.test(subject)) return this.refused(viewer, 'R601', 'bad_input', null);
    if (typeof stepUpId !== 'string' || !ID.test(stepUpId)) return this.refused(viewer, 'R601', 'second_factor_required', subject);
    const row = await this.db.first<{ network_id: string; user_role: string; user_id: string; device_id: string; action: string; subject: string; expires_at: string; used_at: string | null; status: DeviceStatus }>(
      'SELECT p.network_id, p.user_role, p.user_id, p.device_id, p.action, p.subject, p.expires_at, p.used_at, d.status FROM security_step_ups p JOIN security_devices d ON d.id = p.device_id WHERE p.id = ?',
      [stepUpId],
    );
    if (!row || row.network_id !== viewer.networkId || row.user_role !== viewer.role || row.user_id !== viewer.userId) return this.refused(viewer, 'R601', 'second_factor_required', subject);
    if (row.action !== action || row.subject !== subject) return this.refused(viewer, 'R601', 'other_action', subject);
    if (row.used_at !== null) return this.refused(viewer, 'R601', 'already_used', subject);
    const at = this.now();
    if (Date.parse(row.expires_at) <= at.getTime()) return this.refused(viewer, 'R601', 'expired', subject);
    if (row.status !== 'actif') return this.refused(viewer, 'R601', 'device_revoked', subject);
    if (!(await this.userActive(viewer))) return this.refused(viewer, 'R16', 'agent_inactive', subject);
    await this.write(viewer, 'securite.second_facteur.utilise', subject, { rule: 'R601', action });
    // Usée en une écriture, si sa clé est encore active et la preuve encore valable à cet instant même, relu après le
    // journal : un retrait ou une échéance passés entre la lecture et ici l'emportent [R600, R601].
    const usedAt = this.now().toISOString();
    const done = await this.db.run(
      "UPDATE security_step_ups SET used_at = ? WHERE id = ? AND used_at IS NULL AND expires_at > ? AND EXISTS (SELECT 1 FROM security_devices d WHERE d.id = security_step_ups.device_id AND d.status = 'actif')",
      [usedAt, stepUpId, usedAt],
    );
    if (done.changes !== 1) {
      const now = await this.db.first<{ used_at: string | null; status: DeviceStatus }>(
        'SELECT p.used_at, d.status FROM security_step_ups p JOIN security_devices d ON d.id = p.device_id WHERE p.id = ?',
        [stepUpId],
      );
      const code = now?.status !== 'actif' ? 'device_revoked' : now.used_at !== null ? 'already_used' : 'expired';
      return this.refused(viewer, 'R601', code, subject);
    }
    return { ok: true, value: { deviceId: row.device_id } };
  }

  // ---------------------------------------------------------------- outils

  private expected(type: Expected['type'], challenge: string): Expected {
    return { type, challenge, origins: this.origins, rpId: this.rpId };
  }

  /** Défi, clé et signature d'une connexion ou d'une preuve. Le défi est usé avant la vérification, même raté. */
  private async verifySigned(viewer: Viewer, payload: AssertionPayload, purpose: 'login' | 'step_up'): Promise<SecurityResult<DeviceRow & { challenge: ChallengeRow }>> {
    const rule: SecurityRule = purpose === 'login' ? 'R600' : 'R601';
    const credentialId = fromBase64Url(payload.credentialId, 1023);
    const clientDataJSON = fromBase64Url(payload.clientDataJSON);
    const authenticatorData = fromBase64Url(payload.authenticatorData);
    const signature = fromBase64Url(payload.signature, 128);
    if (!credentialId || !clientDataJSON || !authenticatorData || !signature) return this.refused(viewer, rule, 'bad_input', null);
    const who = await this.checkUser(viewer, null);
    if (!who.ok) return who;
    const challenge = await this.consumeChallenge(viewer, payload.challengeId, purpose);
    if (!challenge.ok) return challenge;
    const device = await this.db.first<DeviceRow>('SELECT * FROM security_devices WHERE credential_id = ?', [toBase64Url(credentialId)]);
    if (!device || device.network_id !== viewer.networkId || device.user_role !== viewer.role || device.user_id !== viewer.userId) {
      return this.refused(viewer, rule, 'unknown_device', null);
    }
    const subject = `device:${device.id}`;
    if (device.status !== 'actif') return this.refused(viewer, rule, device.status === 'retire' ? 'device_revoked' : 'device_pending', subject);
    const check = await verifyAssertion({ clientDataJSON, authenticatorData, signature }, fromBase64Url(device.public_key, 512)!, this.expected('webauthn.get', challenge.value.challenge));
    if (!check.ok) return this.refused(viewer, rule, check.code, subject);
    const count = check.value.signCount;
    if ((count !== 0 || device.sign_count !== 0) && count <= device.sign_count) return this.refused(viewer, rule, 'clone_suspect', subject);
    if (count !== device.sign_count) {
      const done = await this.db.run("UPDATE security_devices SET sign_count = ? WHERE id = ? AND sign_count = ? AND status = 'actif'", [count, device.id, device.sign_count]);
      if (done.changes !== 1) return this.refused(viewer, rule, 'clone_suspect', subject);
    }
    return { ok: true, value: { ...device, sign_count: count, challenge: challenge.value } };
  }

  private async issue(viewer: Viewer, purpose: ChallengeRow['purpose'], action: string | null, subject: string | null, credentialIds: string[]): Promise<SecurityResult<Challenge>> {
    const id = this.newId();
    const challenge = toBase64Url(this.randomBytes(32));
    const at = this.now();
    const expiresAt = new Date(at.getTime() + CHALLENGE_MINUTES * 60_000).toISOString();
    await this.write(viewer, 'securite.defi', subject, { rule: purpose === 'step_up' ? 'R601' : 'R600', purpose, ...(action ? { action } : {}) });
    await this.db.run(
      'INSERT INTO security_challenges (id, network_id, user_role, user_id, purpose, challenge, action, subject, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [id, viewer.networkId, viewer.role, viewer.userId, purpose, challenge, action, subject, at.toISOString(), expiresAt],
    );
    return { ok: true, value: { challengeId: id, challenge, rpId: this.rpId, expiresAt, credentialIds } };
  }

  /** Le défi de cet utilisateur, pour cet usage, encore valable : usé à l'instant, une seule fois. */
  private async consumeChallenge(viewer: Viewer, challengeId: unknown, purpose: ChallengeRow['purpose']): Promise<SecurityResult<ChallengeRow>> {
    const rule: SecurityRule = purpose === 'step_up' ? 'R601' : 'R600';
    if (typeof challengeId !== 'string' || !ID.test(challengeId)) return this.refused(viewer, rule, 'bad_input', null);
    const row = await this.db.first<ChallengeRow>('SELECT * FROM security_challenges WHERE id = ?', [challengeId]);
    if (!row || row.purpose !== purpose || row.network_id !== viewer.networkId || row.user_role !== viewer.role || row.user_id !== viewer.userId) {
      return this.refused(viewer, rule, 'unknown_challenge', null);
    }
    if (row.used_at !== null) return this.refused(viewer, rule, 'challenge_used', null);
    const at = this.now();
    if (Date.parse(row.expires_at) <= at.getTime()) return this.refused(viewer, rule, 'challenge_expired', null);
    const done = await this.db.run('UPDATE security_challenges SET used_at = ? WHERE id = ? AND used_at IS NULL', [at.toISOString(), challengeId]);
    if (done.changes !== 1) return this.refused(viewer, rule, 'challenge_used', null);
    return { ok: true, value: row };
  }

  private async devicesOf(viewer: Viewer): Promise<DeviceRow[]> {
    return this.db.all<DeviceRow>('SELECT * FROM security_devices WHERE network_id = ? AND user_role = ? AND user_id = ? ORDER BY created_at, id', [viewer.networkId, viewer.role, viewer.userId]);
  }

  private async checkUser(viewer: Viewer, subject: string | null): Promise<SecurityResult<null>> {
    if (!isRole(viewer.role) || !ID.test(viewer.networkId) || !ID.test(viewer.userId)) return { ok: false, rule: 'R16', code: 'role' };
    if (!(await this.db.first('SELECT 1 FROM networks WHERE id = ?', [viewer.networkId]))) return { ok: false, rule: 'R16', code: 'other_network' };
    if (!(await this.userActive(viewer))) return this.refused(viewer, 'R16', 'agent_inactive', subject);
    return { ok: true, value: null };
  }

  /** Un agent : présent dans ce réseau, en activité, pas parti [R82]. La direction et la conformité n'ont pas de table. */
  private async userActive(viewer: Viewer): Promise<boolean> {
    if (viewer.role !== 'agent') return true;
    const agent = await this.db.first<{ status: string }>('SELECT status FROM agents WHERE id = ? AND network_id = ?', [viewer.userId, viewer.networkId]);
    if (!agent || agent.status !== 'active') return false;
    return (await agentState(this.db, viewer.networkId, viewer.userId, this.now())) !== 'parti';
  }

  private async refused(viewer: Viewer, rule: SecurityRule, code: string, subject: string | null): Promise<SecurityRefusal> {
    await this.write(viewer, 'securite.refus', subject, { rule, code });
    return { ok: false, rule, code };
  }

  private async write(viewer: Viewer, type: string, subject: string | null, data: Record<string, string | number>): Promise<void> {
    await appendEvent(this.journal, { type, actor: `${String(viewer.role)}:${viewer.userId}`, subject, data }, this.now);
  }
}

export function isSensitive(action: unknown): action is SensitiveAction {
  return typeof action === 'string' && (SENSITIVE_ACTIONS as readonly string[]).includes(action);
}

function toDevice(row: DeviceRow): Device {
  return {
    id: row.id,
    userRole: row.user_role,
    userId: row.user_id,
    label: row.label,
    status: row.status,
    createdAt: row.created_at,
    approvedAt: row.approved_at,
    revokedAt: row.revoked_at,
  };
}
