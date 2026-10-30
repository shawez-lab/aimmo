/**
 * La bibliothèque de musiques et d'images sous licence du réseau (M19, X07) [R133].
 *
 * Seule la direction range une entrée, avec sa source et sa licence prises dans des listes fermées, sa date de fin
 * (ou aucune pour une licence sans fin), la mention d'auteur quand la licence l'exige, et la preuve de la licence par sa
 * référence de stockage, vérifiée dans le stockage. Une entrée sans licence ni preuve est refusée.
 *
 * Une licence expirée, ou une entrée retirée par la direction, sort des choix sans rien effacer [R17]. Le montage (X03)
 * et les publications (X05) ne prennent leurs musiques et leurs images que là.
 */
import type { Viewer } from '../acces/droits.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import type { MusicLibrary } from './montage.ts';

export const ASSET_KINDS = ['musique', 'image'] as const;
export type AssetKind = (typeof ASSET_KINDS)[number];
export const ASSET_SOURCES = ['banque_sous_licence', 'achat_unitaire', 'creation_commandee', 'domaine_public'] as const;
export const ASSET_LICENCES = ['cc0', 'cc_by', 'licence_achetee', 'abonnement', 'cession_de_droits'] as const;
export type AssetLicence = (typeof ASSET_LICENCES)[number];
export const WITHDRAWAL_REASONS = ['licence_retiree', 'preuve_invalide', 'choix_de_la_direction'] as const;

/** Les licences qui exigent de nommer l'auteur à chaque usage. */
const NEEDS_ATTRIBUTION: readonly AssetLicence[] = ['cc_by'];

/** Le stockage des preuves : seule l'existence d'une référence est lue, jamais son contenu. */
export interface LibraryProofStore {
  has(ref: string): Promise<boolean>;
}

export interface LicensedAsset {
  id: string;
  kind: AssetKind;
  title: string;
  source: (typeof ASSET_SOURCES)[number];
  licence: AssetLicence;
  attribution: string | null;
  validUntil: string | null;
  recordedAt: string;
  withdrawn: { reason: string; at: string } | null;
  /** Utilisable ce jour-là : ni retirée, ni expirée. */
  usable: boolean;
}

export type LibraryResult<T> = { ok: true; value: T } | { ok: false; rule: 'R16' | 'R133' | 'R10'; code: string };

interface AssetRow {
  id: string;
  network_id: string;
  kind: AssetKind;
  title: string;
  source: LicensedAsset['source'];
  licence: AssetLicence;
  attribution: string | null;
  valid_until: string | null;
  proof_ref: string;
  recorded_at: string;
  reason: string | null;
  withdrawn_at: string | null;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const PROOF = new RegExp(`^bibliotheque/preuves/${UUID}\\.(?:pdf|jpg|png)$`);
const SELECT = `SELECT a.id, a.network_id, a.kind, a.title, a.source, a.licence, a.attribution, a.valid_until, a.proof_ref, a.recorded_at, w.reason, w.withdrawn_at
  FROM licensed_assets a LEFT JOIN licensed_asset_withdrawals w ON w.asset_id = a.id`;

/** Le jour à Paris : une licence vaut jusqu'à la fin de son dernier jour, heure de Paris. */
export function parisDay(at: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
}

function validDay(v: string): boolean {
  if (!DAY.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

export interface BibliothequeOptions {
  now?: () => Date;
  newId?: () => string;
}

export class Bibliotheque implements MusicLibrary {
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(
    private readonly db: SqlDatabase,
    private readonly journal: JournalStore,
    private readonly proofs: LibraryProofStore,
    options: BibliothequeOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => crypto.randomUUID());
  }

  /** La direction range une entrée, avec sa licence et sa preuve [R133, R16]. */
  async add(
    viewer: Viewer,
    input: { kind: unknown; title: unknown; source: unknown; licence: unknown; attribution?: unknown; validUntil: unknown; proofRef: unknown },
  ): Promise<LibraryResult<LicensedAsset>> {
    if (viewer.role !== 'direction') return this.refused(viewer, 'role');
    const actor = `direction:${viewer.userId}`;
    const bad = async (rule: 'R133' | 'R10', code: string): Promise<LibraryResult<LicensedAsset>> => {
      await appendEvent(this.journal, { type: 'studio.bibliotheque.refuse', actor, subject: `network:${viewer.networkId}`, data: { rule, code } }, this.now);
      return { ok: false, rule, code };
    };
    if (!(ASSET_KINDS as readonly unknown[]).includes(input.kind)) return bad('R10', 'sorte_inconnue');
    if (typeof input.title !== 'string' || input.title.trim().length < 2 || input.title.trim().length > 120) return bad('R10', 'titre_invalide');
    if (!(ASSET_SOURCES as readonly unknown[]).includes(input.source)) return bad('R133', 'sans_source');
    if (!(ASSET_LICENCES as readonly unknown[]).includes(input.licence)) return bad('R133', 'sans_licence');
    const licence = input.licence as AssetLicence;
    let attribution: string | null = null;
    if (input.attribution !== undefined && input.attribution !== null) {
      if (typeof input.attribution !== 'string' || input.attribution.trim().length < 2 || input.attribution.trim().length > 200) return bad('R133', 'mention_auteur_invalide');
      attribution = input.attribution.trim();
    }
    if (NEEDS_ATTRIBUTION.includes(licence) && attribution === null) return bad('R133', 'mention_auteur_absente');
    if (input.validUntil !== null && (typeof input.validUntil !== 'string' || !validDay(input.validUntil))) return bad('R133', 'date_de_fin_invalide');
    const validUntil = input.validUntil as string | null;
    if (validUntil !== null && validUntil < parisDay(this.now())) return bad('R133', 'licence_expiree');
    if (typeof input.proofRef !== 'string' || !PROOF.test(input.proofRef)) return bad('R133', 'sans_preuve');
    let stored: boolean;
    try {
      stored = await this.proofs.has(input.proofRef);
    } catch (error) {
      await appendEvent(this.journal, { type: 'studio.bibliotheque.stockage_indisponible', actor, subject: `network:${viewer.networkId}`, data: { rule: 'R133', error: error instanceof Error ? error.name : 'inconnue' } }, this.now);
      return { ok: false, rule: 'R133', code: 'stockage_indisponible' };
    }
    if (!stored) return bad('R133', 'preuve_absente');
    const kind = input.kind as AssetKind;
    const source = input.source as LicensedAsset['source'];
    const id = this.newId();
    const at = this.now().toISOString();
    await this.db.run(
      'INSERT INTO licensed_assets (id, network_id, kind, title, source, licence, attribution, valid_until, proof_ref, recorded_by, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [id, viewer.networkId, kind, input.title.trim(), source, licence, attribution, validUntil, input.proofRef, actor, at],
    );
    await appendEvent(this.journal, { type: 'studio.bibliotheque.ajout', actor, subject: `network:${viewer.networkId}`, data: { id, kind, licence } }, this.now);
    return { ok: true, value: (await this.get(viewer.networkId, id))! };
  }

  /** La direction retire une entrée : elle sort des choix, rien ne s'efface [R17]. */
  async withdraw(viewer: Viewer, id: unknown, reason: unknown): Promise<LibraryResult<LicensedAsset>> {
    if (viewer.role !== 'direction') return this.refused(viewer, 'role');
    const bad = async (code: string): Promise<LibraryResult<LicensedAsset>> => {
      // Un retrait refusé est au journal, sans l'identifiant demandé : une entrée d'un autre réseau ne se devine pas.
      await appendEvent(this.journal, { type: 'studio.bibliotheque.refuse', actor: `direction:${viewer.userId}`, subject: `network:${viewer.networkId}`, data: { rule: 'R10', code } }, this.now);
      return { ok: false, rule: 'R10', code };
    };
    const asset = typeof id === 'string' ? await this.get(viewer.networkId, id) : null;
    if (!asset) {
      // Inconnue ici, ou d'un autre réseau : un refus d'accès au journal [R16], la même réponse dans les deux cas.
      await appendEvent(
        this.journal,
        { type: 'acces.refuse', actor: `direction:${viewer.userId}`, subject: `network:${viewer.networkId}`, data: { rule: 'R16', role: 'direction', kind: 'licensed_assets', code: 'unknown' } },
        this.now,
      );
      return { ok: false, rule: 'R10', code: 'entree_inconnue' };
    }
    if (typeof reason !== 'string' || !(WITHDRAWAL_REASONS as readonly string[]).includes(reason)) return bad('motif_inconnu');
    if (asset.withdrawn) return { ok: true, value: asset };
    const { changes } = await this.db.run('INSERT INTO licensed_asset_withdrawals (id, asset_id, reason, withdrawn_by, withdrawn_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING', [
      this.newId(),
      asset.id,
      reason,
      `direction:${viewer.userId}`,
      this.now().toISOString(),
    ]);
    if (changes === 1) await appendEvent(this.journal, { type: 'studio.bibliotheque.retrait', actor: `direction:${viewer.userId}`, subject: `network:${viewer.networkId}`, data: { id: asset.id, reason } }, this.now);
    return { ok: true, value: (await this.get(viewer.networkId, asset.id))! };
  }

  /** Les choix offerts aux agents et à la direction du réseau : seulement les entrées utilisables ce jour [R133]. */
  async choices(viewer: Viewer, kind: unknown): Promise<LibraryResult<LicensedAsset[]>> {
    if (viewer.role !== 'agent' && viewer.role !== 'direction') return this.refused(viewer, 'role');
    if (typeof kind !== 'string' || !(ASSET_KINDS as readonly string[]).includes(kind)) {
      await appendEvent(this.journal, { type: 'studio.bibliotheque.refuse', actor: `${viewer.role}:${viewer.userId}`, subject: `network:${viewer.networkId}`, data: { rule: 'R10', code: 'sorte_inconnue' } }, this.now);
      return { ok: false, rule: 'R10', code: 'sorte_inconnue' };
    }
    const rows = await this.db.all<AssetRow>(`${SELECT} WHERE a.network_id = ? AND a.kind = ? ORDER BY a.title, a.id`, [viewer.networkId, kind]);
    return { ok: true, value: rows.map((r) => this.view(r)).filter((a) => a.usable) };
  }

  /** Toute la bibliothèque, retraits et licences expirées compris, pour la direction. */
  async all(viewer: Viewer): Promise<LibraryResult<LicensedAsset[]>> {
    if (viewer.role !== 'direction') return this.refused(viewer, 'role');
    const rows = await this.db.all<AssetRow>(`${SELECT} WHERE a.network_id = ? ORDER BY a.kind, a.title, a.id`, [viewer.networkId]);
    return { ok: true, value: rows.map((r) => this.view(r)) };
  }

  /** Pour le montage (X03) : une musique du réseau, utilisable à cet instant, ou null [R133]. */
  async licensedMusic(networkId: string, id: string, at: Date): Promise<{ id: string; licence: AssetLicence; attribution: string | null } | null> {
    const a = await this.licensed(networkId, 'musique', id, at);
    return a ? { id: a.id, licence: a.licence, attribution: a.attribution } : null;
  }

  /** Pour les publications (X05) : une image du réseau, utilisable à cet instant, ou null [R133]. */
  async licensedImage(networkId: string, id: string, at: Date): Promise<{ id: string; attribution: string | null } | null> {
    const a = await this.licensed(networkId, 'image', id, at);
    return a ? { id: a.id, attribution: a.attribution } : null;
  }

  private async licensed(networkId: string, kind: AssetKind, id: string, at: Date): Promise<LicensedAsset | null> {
    const row = await this.db.first<AssetRow>(`${SELECT} WHERE a.id = ? AND a.network_id = ? AND a.kind = ?`, [id, networkId, kind]);
    if (!row) return null;
    const a = this.view(row, at);
    if (!a.usable) return null;
    // La preuve de la licence est encore rangée au moment de l'usage ; absente ou stockage en panne, rien [R133].
    let stored = false;
    try {
      stored = await this.proofs.has(row.proof_ref);
    } catch (error) {
      await appendEvent(this.journal, { type: 'studio.bibliotheque.stockage_indisponible', actor: 'systeme:studio', subject: `network:${networkId}`, data: { rule: 'R133', asset: id, error: error instanceof Error ? error.name : 'inconnue' } }, this.now);
      return null;
    }
    if (!stored) {
      await appendEvent(this.journal, { type: 'studio.bibliotheque.preuve_absente', actor: 'systeme:studio', subject: `network:${networkId}`, data: { rule: 'R133', asset: id } }, this.now);
      return null;
    }
    return a;
  }

  private async get(networkId: string, id: string): Promise<LicensedAsset | null> {
    const row = await this.db.first<AssetRow>(`${SELECT} WHERE a.id = ? AND a.network_id = ?`, [id, networkId]);
    return row ? this.view(row) : null;
  }

  private view(r: AssetRow, at: Date = this.now()): LicensedAsset {
    const withdrawn = r.reason && r.withdrawn_at ? { reason: r.reason, at: r.withdrawn_at } : null;
    const expired = r.valid_until !== null && r.valid_until < parisDay(at);
    return {
      id: r.id,
      kind: r.kind,
      title: r.title,
      source: r.source,
      licence: r.licence,
      attribution: r.attribution,
      validUntil: r.valid_until,
      recordedAt: r.recorded_at,
      withdrawn,
      usable: withdrawn === null && !expired,
    };
  }

  private async refused<T>(viewer: Viewer, code: string): Promise<LibraryResult<T>> {
    await appendEvent(
      this.journal,
      { type: 'acces.refuse', actor: `${String(viewer.role)}:${viewer.userId}`, subject: `network:${viewer.networkId}`, data: { rule: 'R16', role: String(viewer.role), kind: 'licensed_assets', code } },
      this.now,
    );
    return { ok: false, rule: 'R16', code };
  }
}
