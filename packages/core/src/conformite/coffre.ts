/**
 * Coffre de la conformité (M12, L01) [R13, R15, R16, R17, R90].
 *
 * L'agent, ou le responsable de la conformité, dépose une pièce d'identité ou un document anti-blanchiment qu'il a
 * vérifié : le contenu part au stockage du coffre (une interface, un faux dans les tests), la base ne garde que sa
 * référence, son empreinte SHA-256, sa sorte, sa date de vérification et qui l'a déposée, jamais son contenu ni un
 * numéro de pièce. Le déposant reçoit une preuve de dépôt (identifiant, empreinte, heure), sans référence de stockage :
 * même l'agent qui l'a déposée ne la relit jamais.
 *
 * Seul le responsable de la conformité (rôle `compliance`) liste et ouvre les pièces ; chaque lecture et chaque refus
 * vont au journal, sans donnée personnelle en clair. Les autres modules ne voient qu'un état : `identityVerifiedOn`,
 * la date de la dernière pièce d'identité vérifiée et valide ce jour-là, sans sa sorte ni sa référence. Une pièce
 * d'identité déposée range aussi l'identité vérifiée de D03 (`identity_checks`), que lisent les contrôles avant
 * signature.
 *
 * Une fiche réunie à une autre (S04) garde ses pièces : le coffre lit toujours toutes les fiches réunies.
 *
 * Rien ne s'efface et rien ne change : une pièce remplacée reste au coffre, la nouvelle dit laquelle elle remplace,
 * une seule fois [R17].
 */
import type { Acces } from '../acces/acces.ts';
import type { Viewer } from '../acces/droits.ts';
import { FicheClient } from '../db/fiche-client.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { FicheUnique } from '../fiche/fusion.ts';
import { IDENTITY_PIECES } from './pieces-identite.ts';
import { localTime } from '../envoi/horaires.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';

const TIME_ZONE = 'Europe/Paris';

export const VAULT_PIECES = [
  { kind: 'carte_identite', label: 'Carte d’identité' },
  { kind: 'passeport', label: 'Passeport' },
  { kind: 'permis_conduire', label: 'Permis de conduire' },
  { kind: 'extrait_kbis', label: 'Extrait Kbis' },
  { kind: 'registre_beneficiaires', label: 'Registre des bénéficiaires effectifs' },
  { kind: 'origine_fonds', label: 'Justificatif de l’origine des fonds' },
  { kind: 'autre_lcb', label: 'Autre document anti-blanchiment' },
] as const;
export type VaultPieceKind = (typeof VAULT_PIECES)[number]['kind'];

export const VAULT_CONTENT_TYPES = ['application/pdf', 'image/jpeg', 'image/png'] as const;
export type VaultContentType = (typeof VAULT_CONTENT_TYPES)[number];
/** Taille maximale d'une pièce déposée, en octets. */
export const VAULT_MAX_BYTES = 10 * 1024 * 1024;

/** Le stockage du coffre, séparé de tout autre stockage (R2 en production, un faux dans les tests). */
export interface VaultStorage {
  /** Range le contenu, rend sa référence. Le contenu n'est jamais rendu ailleurs que par `open`. */
  put(networkId: string, content: Uint8Array, contentType: VaultContentType): Promise<string>;
}

export interface VaultReceipt {
  pieceId: string;
  kind: VaultPieceKind;
  label: string;
  sha256: string;
  depositedAt: string;
}

export interface VaultLine {
  pieceId: string;
  kind: VaultPieceKind;
  label: string;
  caseRef: string | null;
  sha256: string;
  contentType: VaultContentType;
  sizeBytes: number;
  verifiedOn: string;
  validUntil: string | null;
  replacesId: string | null;
  replacedBy: string | null;
  depositedBy: string;
  depositedAt: string;
}

export type VaultRefusal = { ok: false; rule: 'R16' | 'R90' | null; code: string };

interface PieceRow {
  id: string;
  network_id: string;
  person_id: string;
  kind: VaultPieceKind;
  case_ref: string | null;
  storage_ref: string;
  sha256: string;
  content_type: VaultContentType;
  size_bytes: number;
  verified_on: string;
  valid_until: string | null;
  replaces_id: string | null;
  deposited_by: string;
  deposited_at: string;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const validDay = (v: unknown): v is string => {
  if (typeof v !== 'string' || !DAY.test(v)) return false;
  const d = new Date(`${v}T12:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
};
const CASE_REF = /^[a-z_]{2,20}:[0-9a-f-]{8,40}$/;
const labelOf = (kind: VaultPieceKind): string => VAULT_PIECES.find((p) => p.kind === kind)!.label;
const isKind = (v: unknown): v is VaultPieceKind => typeof v === 'string' && VAULT_PIECES.some((p) => p.kind === v);
const isIdentity = (kind: VaultPieceKind): boolean => (IDENTITY_PIECES as readonly string[]).includes(kind);

async function sha256Hex(content: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', content));
  return [...digest].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export interface CoffreOptions {
  now?: () => Date;
  newId?: () => string;
}

export class CoffreConformite {
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly unique: FicheUnique;

  constructor(
    private readonly db: SqlDatabase,
    private readonly acces: Acces,
    private readonly storage: VaultStorage,
    private readonly journal: JournalStore,
    options: CoffreOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => crypto.randomUUID());
    this.unique = new FicheUnique(db, new FicheClient(db, { now: this.now }), { now: this.now });
  }

  private actor(viewer: Viewer): string {
    return `${String(viewer.role)}:${viewer.userId}`;
  }

  private today(): string {
    return localTime(this.now(), TIME_ZONE).date;
  }

  private async refuse(viewer: Viewer, subject: string | null, code: string): Promise<VaultRefusal> {
    await appendEvent(
      this.journal,
      { type: 'acces.refuse', actor: this.actor(viewer), subject, data: { rule: 'R90', role: String(viewer.role), kind: 'compliance_vault', code } },
      this.now,
    );
    return { ok: false, rule: 'R90', code };
  }

  /**
   * Dépose une pièce vérifiée. L'agent de la fiche (vue complète) ou le responsable ; jamais la direction ni un
   * partenaire. Rend la preuve de dépôt, jamais la référence de stockage.
   */
  async deposit(
    viewer: Viewer,
    personId: string,
    input: { kind: unknown; content: unknown; contentType: unknown; verifiedOn: unknown; validUntil?: unknown; caseRef?: unknown; replaces?: unknown },
  ): Promise<{ ok: true; receipt: VaultReceipt } | VaultRefusal> {
    if (viewer.role !== 'agent' && viewer.role !== 'compliance') return this.refuse(viewer, `person:${personId}`, 'role');
    if (!isKind(input.kind)) return { ok: false, rule: null, code: 'unknown_piece' };
    if (!(input.content instanceof Uint8Array) || input.content.byteLength === 0) return { ok: false, rule: null, code: 'empty_content' };
    if (input.content.byteLength > VAULT_MAX_BYTES) return { ok: false, rule: null, code: 'too_large' };
    if (typeof input.contentType !== 'string' || !(VAULT_CONTENT_TYPES as readonly string[]).includes(input.contentType)) return { ok: false, rule: null, code: 'bad_content_type' };
    const today = this.today();
    if (!validDay(input.verifiedOn) || input.verifiedOn > today) return { ok: false, rule: null, code: 'bad_date' };
    const validUntil = input.validUntil === undefined || input.validUntil === null ? null : input.validUntil;
    if (validUntil !== null && (!validDay(validUntil) || validUntil < input.verifiedOn)) return { ok: false, rule: null, code: 'bad_date' };
    const caseRef = input.caseRef === undefined || input.caseRef === null ? null : input.caseRef;
    if (caseRef !== null && (typeof caseRef !== 'string' || !CASE_REF.test(caseRef))) return { ok: false, rule: null, code: 'bad_case' };

    const read = await this.acces.readFiche(viewer, personId);
    if (!read.ok) return { ok: false, rule: 'R16', code: read.code };
    if (read.view !== 'full') return this.refuse(viewer, `person:${personId}`, 'not_assigned');
    const person = read.value.person;

    let replaces: string | null = null;
    if (input.replaces !== undefined && input.replaces !== null) {
      const old = typeof input.replaces === 'string'
        ? await this.db.first<{ id: string; person_id: string; network_id: string }>('SELECT id, person_id, network_id FROM compliance_vault_pieces WHERE id = ?', [input.replaces])
        : null;
      if (!old || old.network_id !== viewer.networkId || !read.value.members.some((m) => m.id === old.person_id)) return { ok: false, rule: null, code: 'unknown_replaced' };
      const taken = await this.db.first<{ id: string }>('SELECT id FROM compliance_vault_pieces WHERE replaces_id = ?', [old.id]);
      if (taken) return { ok: false, rule: null, code: 'already_replaced' };
      replaces = old.id;
    }

    const content = new Uint8Array(input.content);
    const sha256 = await sha256Hex(content);
    const storageRef = await this.storage.put(viewer.networkId, content, input.contentType as VaultContentType);
    const id = this.newId();
    const at = this.now().toISOString();
    try {
      await this.db.run(
        'INSERT INTO compliance_vault_pieces (id, network_id, person_id, kind, case_ref, storage_ref, sha256, content_type, size_bytes, verified_on, valid_until, replaces_id, deposited_by, deposited_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [id, viewer.networkId, person.id, input.kind, caseRef, storageRef, sha256, input.contentType, content.byteLength, input.verifiedOn, validUntil, replaces, this.actor(viewer), at],
      );
    } catch (error) {
      // Deux remplacements de la même pièce en même temps : un seul passe [R17].
      if (replaces && (await this.db.first('SELECT id FROM compliance_vault_pieces WHERE replaces_id = ?', [replaces]))) return { ok: false, rule: null, code: 'already_replaced' };
      throw error;
    }
    if (isIdentity(input.kind)) {
      // L'état « identité vérifiée » que lisent les contrôles avant signature (D03), sans numéro ni copie.
      await this.db.run('INSERT INTO identity_checks (id, network_id, person_id, piece, seen_at, checked_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [
        this.newId(),
        viewer.networkId,
        person.id,
        input.kind,
        // Jamais dans l'avenir : une pièce vérifiée aujourd'hui vaut tout de suite pour les contrôles (D03, O07).
        new Date(Math.min(Date.parse(`${input.verifiedOn}T12:00:00.000Z`), this.now().getTime())).toISOString(),
        this.actor(viewer),
        at,
      ]);
    }
    await appendEvent(
      this.journal,
      { type: 'coffre.depose', actor: this.actor(viewer), subject: `person:${person.id}`, data: { rule: 'R90', piece: `vault_piece:${id}`, kind: input.kind, replaces: replaces ? `vault_piece:${replaces}` : null } },
      this.now,
    );
    return { ok: true, receipt: { pieceId: id, kind: input.kind, label: labelOf(input.kind), sha256, depositedAt: at } };
  }

  /** Les pièces d'une personne, pour le responsable seul. Chaque lecture au journal. */
  async list(viewer: Viewer, personId: string): Promise<{ ok: true; value: VaultLine[] } | VaultRefusal> {
    if (viewer.role !== 'compliance') return this.refuse(viewer, `person:${personId}`, 'role');
    const read = await this.acces.readFiche(viewer, personId);
    if (!read.ok) return { ok: false, rule: 'R16', code: read.code };
    const ids = read.value.members.map((m) => m.id);
    const rows = await this.db.all<PieceRow>(
      `SELECT * FROM compliance_vault_pieces WHERE network_id = ? AND person_id IN (${ids.map(() => '?').join(', ')}) ORDER BY deposited_at, id`,
      [viewer.networkId, ...ids],
    );
    const replacedBy = new Map(rows.filter((r) => r.replaces_id).map((r) => [r.replaces_id!, r.id]));
    await appendEvent(
      this.journal,
      { type: 'coffre.lu', actor: this.actor(viewer), subject: `person:${read.value.person.id}`, data: { rule: 'R90', count: rows.length } },
      this.now,
    );
    return {
      ok: true,
      value: rows.map((r) => ({
        pieceId: r.id,
        kind: r.kind,
        label: labelOf(r.kind),
        caseRef: r.case_ref,
        sha256: r.sha256,
        contentType: r.content_type,
        sizeBytes: r.size_bytes,
        verifiedOn: r.verified_on,
        validUntil: r.valid_until,
        replacesId: r.replaces_id,
        replacedBy: replacedBy.get(r.id) ?? null,
        depositedBy: r.deposited_by,
        depositedAt: r.deposited_at,
      })),
    };
  }

  /** La référence de stockage d'une pièce, pour que le responsable seul l'ouvre. Chaque ouverture au journal. */
  async open(viewer: Viewer, pieceId: string): Promise<{ ok: true; storageRef: string; contentType: VaultContentType; sha256: string } | VaultRefusal> {
    if (viewer.role !== 'compliance') return this.refuse(viewer, `vault_piece:${pieceId}`, 'role');
    const row = await this.db.first<PieceRow>('SELECT * FROM compliance_vault_pieces WHERE id = ?', [pieceId]);
    if (!row || row.network_id !== viewer.networkId) return this.refuse(viewer, `vault_piece:${pieceId}`, 'unknown');
    await appendEvent(
      this.journal,
      { type: 'coffre.ouvert', actor: this.actor(viewer), subject: `person:${row.person_id}`, data: { rule: 'R90', piece: `vault_piece:${row.id}` } },
      this.now,
    );
    return { ok: true, storageRef: row.storage_ref, contentType: row.content_type, sha256: row.sha256 };
  }

  /**
   * Les preuves de dépôt d'une personne, pour l'agent de la fiche ou le responsable : ce qui a été déposé, quand, et son
   * empreinte ; jamais la pièce ni sa référence.
   */
  async receipts(viewer: Viewer, personId: string): Promise<{ ok: true; value: VaultReceipt[] } | VaultRefusal> {
    if (viewer.role !== 'agent' && viewer.role !== 'compliance') return this.refuse(viewer, `person:${personId}`, 'role');
    const read = await this.acces.readFiche(viewer, personId);
    if (!read.ok) return { ok: false, rule: 'R16', code: read.code };
    if (read.view !== 'full') return this.refuse(viewer, `person:${personId}`, 'not_assigned');
    const ids = read.value.members.map((m) => m.id);
    const rows = await this.db.all<Pick<PieceRow, 'id' | 'kind' | 'sha256' | 'deposited_at'>>(
      `SELECT id, kind, sha256, deposited_at FROM compliance_vault_pieces WHERE network_id = ? AND person_id IN (${ids.map(() => '?').join(', ')}) ORDER BY deposited_at, id`,
      [viewer.networkId, ...ids],
    );
    return { ok: true, value: rows.map((r) => ({ pieceId: r.id, kind: r.kind, label: labelOf(r.kind), sha256: r.sha256, depositedAt: r.deposited_at })) };
  }

  /**
   * L'état que voient les autres modules : la date de vérification de la dernière pièce d'identité valide au jour
   * donné, ou `null`. Ni sorte, ni référence, ni empreinte.
   */
  async state(networkId: string, personId: string, day: string = this.today()): Promise<{ identityVerifiedOn: string | null }> {
    if (!validDay(day)) throw new Error('jour invalide');
    const kinds = [...IDENTITY_PIECES];
    const ids = await this.unique.membersOf(personId);
    const row = await this.db.first<{ verified_on: string }>(
      `SELECT p.verified_on FROM compliance_vault_pieces p
       WHERE p.network_id = ? AND p.person_id IN (${ids.map(() => '?').join(', ')}) AND p.kind IN (${kinds.map(() => '?').join(', ')})
         AND p.verified_on <= ? AND (p.valid_until IS NULL OR p.valid_until >= ?)
         AND NOT EXISTS (SELECT 1 FROM compliance_vault_pieces n WHERE n.replaces_id = p.id AND n.deposited_at <= ?)
       ORDER BY p.verified_on DESC LIMIT 1`,
      [networkId, ...ids, ...kinds, day, day, `${day}T23:59:59.999Z`],
    );
    return { identityVerifiedOn: row?.verified_on ?? null };
  }
}

/** Ce que le coffre dit d'une sorte de pièces pour une personne, à un instant : jamais la pièce ni sa référence. */
export interface VaultPieceStatus {
  /** La date de vérification de la pièce la plus récente valide ce jour-là, ou `null`. */
  verifiedOn: string | null;
  /** Une pièce existe mais n'est plus valide ce jour-là (date de fin passée) : elle bloque comme une pièce absente. */
  expired: boolean;
}

/**
 * La lecture seule du coffre pour les contrôles (L03) : une pièce compte à l'instant `at` si elle était déjà déposée,
 * vérifiée depuis au plus `maxAgeDays` jours, valide ce jour-là (Paris) et pas encore remplacée. Ni sorte, ni
 * référence, ni empreinte ne sortent d'ici.
 */
export class EtatCoffre {
  private readonly unique: FicheUnique;

  constructor(private readonly db: SqlDatabase, options: { now?: () => Date } = {}) {
    const now = options.now ?? (() => new Date());
    this.unique = new FicheUnique(db, new FicheClient(db, { now }), { now });
  }

  async pieceStatus(networkId: string, personId: string, kinds: readonly VaultPieceKind[], at: Date, maxAgeDays: number): Promise<VaultPieceStatus> {
    if (!(at instanceof Date) || Number.isNaN(at.getTime())) throw new Error('instant invalide');
    if (!Number.isInteger(maxAgeDays) || maxAgeDays < 0) throw new Error('durée invalide');
    if (kinds.length === 0) return { verifiedOn: null, expired: false };
    const day = localTime(at, TIME_ZONE).date;
    // En jours du calendrier de Paris, sans heure : le passage à l'heure d'été ne décale rien.
    const since = new Date(Date.parse(`${day}T00:00:00.000Z`) - maxAgeDays * 86_400_000).toISOString().slice(0, 10);
    const iso = at.toISOString();
    const ids = await this.unique.membersOf(personId);
    const rows = await this.db.all<{ verified_on: string; valid_until: string | null }>(
      `SELECT p.verified_on, p.valid_until FROM compliance_vault_pieces p
       WHERE p.network_id = ? AND p.person_id IN (${ids.map(() => '?').join(', ')}) AND p.kind IN (${kinds.map(() => '?').join(', ')})
         AND p.deposited_at <= ? AND p.verified_on <= ?
         AND NOT EXISTS (SELECT 1 FROM compliance_vault_pieces n WHERE n.replaces_id = p.id AND n.deposited_at <= ?)`,
      [networkId, ...ids, ...kinds, iso, day, iso],
    );
    let verifiedOn: string | null = null;
    let expired = false;
    for (const r of rows) {
      if (r.valid_until !== null && r.valid_until < day) {
        expired = true;
        continue;
      }
      if (r.verified_on < since) continue;
      if (verifiedOn === null || r.verified_on > verifiedOn) verifiedOn = r.verified_on;
    }
    return { verifiedOn, expired: verifiedOn === null && expired };
  }
}
