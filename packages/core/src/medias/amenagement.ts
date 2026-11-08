/**
 * Aménagement virtuel des pièces (M19, HX41) [R48, R492, R493].
 *
 * Meubler une pièce vide, redécorer, montrer des sols ou des murs refaits, désencombrer, transformer un objet : l'image
 * est faite sur l'appareil (R130) et certifiée par X02 comme « aménagement virtuel », mention posée sur l'image (R48).
 * Ici, l'agent du bien déclare ce qui a changé, en liste fermée, et désigne la photo réelle jumelle.
 *
 * Jamais vu :
 * - la jumelle est prouvée par le code : une photo de la fiche, certifiée sans aménagement, tirée du même cliché (même
 *   empreinte d'original rangée par X02). L'image transformée ne part jamais sans elle, et toujours juste après elle :
 *   jamais en couverture, jamais seule photo de sa pièce [R493] ;
 * - le certificat dit exactement ce qui a changé, ligne par ligne [R492].
 *
 * Une déclaration ne change plus [R17] : une autre transformation fait une autre image, sous une autre référence.
 */
import type { Acces } from '../acces/acces.ts';
import type { Viewer } from '../acces/droits.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';

export const STAGING_STYLES = ['contemporain', 'scandinave', 'industriel', 'classique', 'campagne'] as const;
export type StagingStyle = (typeof STAGING_STYLES)[number];
export const FLOOR_MATERIALS = ['parquet', 'carrelage', 'beton_cire', 'moquette'] as const;
export type FloorMaterial = (typeof FLOOR_MATERIALS)[number];
export const WALL_FINISHES = ['peinture', 'papier_peint', 'enduit'] as const;
export type WallFinish = (typeof WALL_FINISHES)[number];
export const TRANSFORMED_OBJECTS = ['meubles_de_cuisine', 'plan_de_travail', 'cheminee', 'luminaire', 'placard'] as const;
export type TransformedObject = (typeof TRANSFORMED_OBJECTS)[number];

export const STAGING_CHANGE_KINDS = ['meubler', 'redecorer', 'sols', 'murs', 'desencombrer', 'transformer_objet'] as const;
export type StagingChangeKind = (typeof STAGING_CHANGE_KINDS)[number];

export type StagingChange =
  | { kind: 'meubler'; style: StagingStyle }
  | { kind: 'redecorer'; style: StagingStyle }
  | { kind: 'sols'; material: FloorMaterial }
  | { kind: 'murs'; finish: WallFinish }
  | { kind: 'desencombrer' }
  | { kind: 'transformer_objet'; object: TransformedObject };

const STYLE_LABELS: Record<StagingStyle, string> = { contemporain: 'contemporain', scandinave: 'scandinave', industriel: 'industriel', classique: 'classique', campagne: 'campagne' };
const FLOOR_LABELS: Record<FloorMaterial, string> = { parquet: 'parquet', carrelage: 'carrelage', beton_cire: 'béton ciré', moquette: 'moquette' };
const WALL_LABELS: Record<WallFinish, string> = { peinture: 'peinture neuve', papier_peint: 'papier peint', enduit: 'enduit' };
const OBJECT_LABELS: Record<TransformedObject, string> = { meubles_de_cuisine: 'Meubles de cuisine transformés', plan_de_travail: 'Plan de travail transformé', cheminee: 'Cheminée transformée', luminaire: 'Luminaire transformé', placard: 'Placard transformé' };

/** L'option exigée par chaque sorte de changement, et sa liste fermée. */
const OPTION: Record<StagingChangeKind, { key: string; values: readonly string[] } | null> = {
  meubler: { key: 'style', values: STAGING_STYLES },
  redecorer: { key: 'style', values: STAGING_STYLES },
  sols: { key: 'material', values: FLOOR_MATERIALS },
  murs: { key: 'finish', values: WALL_FINISHES },
  desencombrer: null,
  transformer_objet: { key: 'object', values: TRANSFORMED_OBJECTS },
};

export const STAGING_CHANGE_LABELS: Record<StagingChangeKind, string> = {
  meubler: 'Pièce meublée',
  redecorer: 'Décoration changée',
  sols: 'Sols refaits',
  murs: 'Murs refaits',
  desencombrer: 'Pièce désencombrée',
  transformer_objet: 'Objet transformé',
};

/** Ce qui a changé, dit en français pour le client : toujours « virtuel », jamais un fait du bien. */
export function describeStagingChange(c: StagingChange): string {
  switch (c.kind) {
    case 'meubler':
      return `Pièce meublée virtuellement, style ${STYLE_LABELS[c.style]} : ce mobilier n’est pas dans le bien`;
    case 'redecorer':
      return `Décoration changée virtuellement, style ${STYLE_LABELS[c.style]} : elle n’est pas celle du bien`;
    case 'sols':
      return `Sols montrés en ${FLOOR_LABELS[c.material]} : travaux simulés, non faits`;
    case 'murs':
      return `Murs montrés en ${WALL_LABELS[c.finish]} : travaux simulés, non faits`;
    case 'desencombrer':
      return 'Pièce désencombrée virtuellement : des affaires présentes dans le bien ont été retirées de l’image';
    case 'transformer_objet':
      return `${OBJECT_LABELS[c.object]} virtuellement : travaux simulés, non faits`;
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export type StagingChangesCheck = { ok: true; value: StagingChange[] } | { ok: false; code: 'changements_invalides' | 'changement_hors_liste' | 'option_hors_liste' | 'changement_en_double'; index: number | null };

/** Contrôle ce qui a changé : au moins une sorte, liste fermée, une fois chacune, option prise dans sa liste [R492]. */
export function checkStagingChanges(input: unknown): StagingChangesCheck {
  if (!Array.isArray(input) || input.length === 0 || input.length > STAGING_CHANGE_KINDS.length) return { ok: false, code: 'changements_invalides', index: null };
  const seen = new Set<string>();
  const out: StagingChange[] = [];
  for (const [i, raw] of input.entries()) {
    if (!isRecord(raw) || typeof raw.kind !== 'string') return { ok: false, code: 'changements_invalides', index: i };
    if (!(STAGING_CHANGE_KINDS as readonly string[]).includes(raw.kind)) return { ok: false, code: 'changement_hors_liste', index: i };
    const kind = raw.kind as StagingChangeKind;
    if (seen.has(kind)) return { ok: false, code: 'changement_en_double', index: i };
    seen.add(kind);
    const keys = Object.keys(raw).filter((k) => k !== 'kind');
    const option = OPTION[kind];
    if (option === null) {
      if (keys.length !== 0) return { ok: false, code: 'changements_invalides', index: i };
      out.push({ kind } as StagingChange);
      continue;
    }
    if (keys.length !== 1 || keys[0] !== option.key) return { ok: false, code: 'changements_invalides', index: i };
    const value = raw[option.key];
    if (typeof value !== 'string' || !option.values.includes(value)) return { ok: false, code: 'option_hors_liste', index: i };
    out.push({ kind, [option.key]: value } as StagingChange);
  }
  return { ok: true, value: out };
}

/** Une image aménagée telle que le certificat la dit : chaque changement, et la jumelle. */
export interface StagingDeclaration {
  stagedRef: string;
  realRef: string;
  changes: { kind: StagingChangeKind; label: string; detail: string }[];
}

export function stagingView(changesJson: string): StagingDeclaration['changes'] {
  const check = checkStagingChanges(JSON.parse(changesJson) as unknown);
  if (!check.ok) throw new Error('Aménagement rangé illisible');
  return check.value.map((c) => ({ kind: c.kind, label: STAGING_CHANGE_LABELS[c.kind], detail: describeStagingChange(c) }));
}

/** Une photo prête à partir, comme la donne le Studio (X02) ou l'annonce (P06). */
export interface GalleryPhoto {
  ref: string;
  overlay: 'Aménagement virtuel' | null;
}

export type GalleryRemoval = { ref: string; code: 'sans_declaration' | 'sans_jumelle' };

/**
 * L'ordre de publication des photos d'un bien [R493] : chaque image aménagée part juste après sa jumelle réelle ; une
 * image aménagée sans déclaration, ou dont la jumelle ne part pas, est retirée. La couverture est donc toujours une
 * photo réelle, et aucune pièce n'est montrée seulement transformée. Les autres photos gardent leur ordre.
 */
export function orderGallery<T extends GalleryPhoto>(photos: readonly T[], twins: ReadonlyMap<string, string>): { photos: T[]; removed: GalleryRemoval[] } {
  const real = photos.filter((p) => p.overlay === null);
  const realRefs = new Set(real.map((p) => p.ref));
  const removed: GalleryRemoval[] = [];
  const after = new Map<string, T[]>();
  for (const p of photos) {
    if (p.overlay === null) continue;
    const twin = twins.get(p.ref);
    if (twin === undefined) removed.push({ ref: p.ref, code: 'sans_declaration' });
    else if (!realRefs.has(twin)) removed.push({ ref: p.ref, code: 'sans_jumelle' });
    else after.set(twin, [...(after.get(twin) ?? []), p]);
  }
  return { photos: real.flatMap((p) => [p, ...(after.get(p.ref) ?? [])]), removed };
}

/** Ce qui ne va pas dans un ordre de photos donné : une image aménagée en couverture, ou pas juste après sa jumelle. */
export function galleryProblems(photos: readonly GalleryPhoto[], twins: ReadonlyMap<string, string>): { ref: string; code: 'couverture_amenagee' | 'sans_declaration' | 'jumelle_absente_ou_eloignee' }[] {
  const out: { ref: string; code: 'couverture_amenagee' | 'sans_declaration' | 'jumelle_absente_ou_eloignee' }[] = [];
  photos.forEach((p, i) => {
    if (p.overlay === null) return;
    if (i === 0) out.push({ ref: p.ref, code: 'couverture_amenagee' });
    const twin = twins.get(p.ref);
    if (twin === undefined) return void out.push({ ref: p.ref, code: 'sans_declaration' });
    // Juste avant elle : sa jumelle, ou une autre image aménagée de la même jumelle.
    let j = i - 1;
    while (j >= 0 && photos[j]!.overlay !== null && twins.get(photos[j]!.ref) === twin) j--;
    if (j < 0 || photos[j]!.ref !== twin) out.push({ ref: p.ref, code: 'jumelle_absente_ou_eloignee' });
  });
  return out;
}

interface CertLite {
  token: string;
  result_ref: string;
  original_sha256: string;
  virtual_staging: number;
}

export type DeclareResult = { ok: true; value: StagingDeclaration } | { ok: false; rule: 'R16' | 'R10' | 'R48' | 'R492' | 'R493'; code: string };

export interface AmenagementsOptions {
  now?: () => Date;
  newId?: () => string;
}

export class AmenagementsVirtuels {
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(
    private readonly db: SqlDatabase,
    private readonly acces: Acces,
    private readonly journal: JournalStore,
    options: AmenagementsOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => crypto.randomUUID());
  }

  /**
   * L'agent du bien, ou la direction, déclare ce qui a changé sur une image aménagée et désigne sa jumelle réelle.
   * L'image doit être certifiée « aménagement virtuel » (R48) ; la jumelle, certifiée sans aménagement, du même cliché.
   */
  async declare(viewer: Viewer, propertyId: string, input: { stagedRef: unknown; realRef: unknown; changes: unknown }): Promise<DeclareResult> {
    const actor = `${String(viewer.role)}:${viewer.userId}`;
    if (viewer.role !== 'agent' && viewer.role !== 'direction') return this.refused(viewer, propertyId, 'role');
    const read = await this.acces.readProperty(viewer, propertyId);
    if (!read.ok) return { ok: false, rule: 'R16', code: read.code };
    if (read.view !== 'full') return this.refused(viewer, propertyId, 'not_assigned');
    const bad = async (rule: 'R10' | 'R48' | 'R492' | 'R493', code: string): Promise<DeclareResult> => {
      await appendEvent(this.journal, { type: 'medias.amenagement.refuse', actor, subject: `property:${propertyId}`, data: { rule, code } }, this.now);
      return { ok: false, rule, code };
    };
    const changes = checkStagingChanges(input.changes);
    if (!changes.ok) return bad('R492', changes.code);
    if (typeof input.stagedRef !== 'string' || typeof input.realRef !== 'string' || input.stagedRef === input.realRef) return bad('R10', 'photo_inconnue');
    const sheet = await this.sheetPhotos(propertyId);
    const stagedEdit = sheet.get(input.stagedRef);
    const realEdit = sheet.get(input.realRef);
    if (stagedEdit === undefined || realEdit === undefined) return bad('R10', 'photo_inconnue');
    const certs = await this.db.all<CertLite>('SELECT token, result_ref, original_sha256, virtual_staging FROM photo_certificates WHERE property_id = ? AND result_ref IN (?, ?)', [propertyId, input.stagedRef, input.realRef]);
    const staged = certs.find((c) => c.result_ref === input.stagedRef);
    const real = certs.find((c) => c.result_ref === input.realRef);
    // L'image transformée porte sa mention : certifiée « aménagement virtuel », et la fiche le dit [R48].
    if (!staged || staged.virtual_staging !== 1 || stagedEdit !== 'amenagement_virtuel') return bad('R48', 'sans_mention');
    // La jumelle est une vraie photo : certifiée sans aménagement, et la fiche ne la dit pas aménagée.
    if (!real || real.virtual_staging !== 0 || realEdit === 'amenagement_virtuel') return bad('R493', 'jumelle_non_reelle');
    // Le même cliché : même empreinte d'original, rangée par X02 de part et d'autre.
    if (real.original_sha256 !== staged.original_sha256) return bad('R493', 'pas_le_meme_cliche');
    const json = JSON.stringify(changes.value);
    const existing = await this.db.first<{ real_ref: string; changes: string }>('SELECT real_ref, changes FROM virtual_stagings WHERE property_id = ? AND staged_ref = ?', [propertyId, input.stagedRef]);
    const view: StagingDeclaration = { stagedRef: input.stagedRef, realRef: input.realRef, changes: stagingView(json) };
    if (existing) return existing.real_ref === input.realRef && existing.changes === json ? { ok: true, value: view } : bad('R10', 'deja_declaree');
    const { changes: n } = await this.db.run(
      `INSERT INTO virtual_stagings (id, network_id, property_id, staged_ref, staged_token, real_ref, real_token, changes, declared_by, declared_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
      [this.newId(), read.value.network_id, propertyId, input.stagedRef, staged.token, input.realRef, real.token, json, actor, this.now().toISOString()],
    );
    if (n !== 1) {
      const now = await this.db.first<{ real_ref: string; changes: string }>('SELECT real_ref, changes FROM virtual_stagings WHERE property_id = ? AND staged_ref = ?', [propertyId, input.stagedRef]);
      return now && now.real_ref === input.realRef && now.changes === json ? { ok: true, value: view } : bad('R10', 'deja_declaree');
    }
    await appendEvent(this.journal, { type: 'medias.amenagement.declare', actor, subject: `property:${propertyId}`, data: { rule: 'R492', changes: changes.value.map((c) => c.kind) } }, this.now);
    return { ok: true, value: view };
  }

  /** Les jumelles déclarées d'un bien : image aménagée → photo réelle. */
  async twins(propertyId: string): Promise<Map<string, string>> {
    const rows = await this.db.all<{ staged_ref: string; real_ref: string }>('SELECT staged_ref, real_ref FROM virtual_stagings WHERE property_id = ?', [propertyId]);
    return new Map(rows.map((r) => [r.staged_ref, r.real_ref] as const));
  }

  /** L'ordre de publication de photos prêtes à partir, jumelles comprises [R493]. */
  async gallery<T extends GalleryPhoto>(propertyId: string, photos: readonly T[]): Promise<{ photos: T[]; removed: GalleryRemoval[] }> {
    return orderGallery(photos, await this.twins(propertyId));
  }

  private async sheetPhotos(propertyId: string): Promise<Map<string, string>> {
    const row = await this.db.first<{ data: string }>('SELECT data FROM property_sheets WHERE property_id = ? ORDER BY version DESC LIMIT 1', [propertyId]);
    const out = new Map<string, string>();
    if (!row) return out;
    let media: unknown;
    try {
      const data = JSON.parse(row.data) as unknown;
      media = isRecord(data) ? data.media : null;
    } catch {
      media = null;
    }
    if (!Array.isArray(media)) return out;
    for (const m of media) if (isRecord(m) && m.kind === 'photo' && typeof m.ref === 'string' && typeof m.edit === 'string') out.set(m.ref, m.edit);
    return out;
  }

  private async refused(viewer: Viewer, propertyId: string, code: string): Promise<DeclareResult> {
    await appendEvent(
      this.journal,
      { type: 'acces.refuse', actor: `${String(viewer.role)}:${viewer.userId}`, subject: `property:${propertyId}`, data: { rule: 'R16', role: String(viewer.role), kind: 'virtual_staging', code } },
      this.now,
    );
    return { ok: false, rule: 'R16', code };
  }
}
