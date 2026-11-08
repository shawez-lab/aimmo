/**
 * Le filigrane de chaque photo exportée (M19, HX40) [R491].
 *
 * L'image est assemblée sur l'appareil de l'agent, jamais sur un serveur [R130] : le serveur ne donne que le calque du
 * filigrane, dessiné par le code (SVG), et range ce qui a été posé. Une photo ne s'exporte que si elle a son certificat
 * (X02) ; le calque porte toujours le nom de l'agent du bien et le code de contenu du bien (AT05), pour qu'une photo
 * reprise par d'autres ramène à lui. Le lien marqué du bien (`?o=<code>`) est donné à part, pour les métadonnées de
 * l'image ; il n'existe que si le bien a sa page en ligne.
 *
 * Ni adresse, ni ville, ni nom de client sur le calque ni dans ce qui est rangé [R46, R13] : le nom professionnel de
 * l'agent et un code tiré au hasard, qui ne dit rien du bien.
 */
import type { Acces } from '../acces/acces.ts';
import type { Viewer } from '../acces/droits.ts';
import { OrigineContacts, taggedLink } from '../attirer/origine-contacts.ts';
import { Referencement } from '../attirer/referencement.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { PALETTE, POLICES } from '../design/systeme.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import type { CertificatsPhotos, CertifiedPhoto } from '../studio/certificats.ts';

export const WATERMARK_BRAND = 'AIMMO';

export interface PhotoExport {
  exportId: string;
  ref: string;
  /** Le texte du filigrane : « Prénom Nom · AIMMO · <code> ». */
  watermarkText: string;
  contentCode: string;
  /** Le lien marqué de la page du bien, ou null tant qu'elle n'est pas en ligne. */
  link: string | null;
  /** Les mentions déjà posées sur l'image certifiée [R48, R490]. */
  mentions: string[];
  certificatePath: string;
  /** Le calque à poser sur l'image, à ses dimensions. */
  svg: string;
  width: number;
  height: number;
}

export type ExportResult = { ok: true; value: PhotoExport } | { ok: false; rule: 'R16' | 'R10' | 'R130' | 'R491'; code: string };

export interface FiligraneOptions {
  now?: () => Date;
  newId?: () => string;
  origine?: OrigineContacts;
}

const CODE = /^[a-z2-7]{12}$/;

function xml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** Le nom de l'agent, ramené à ce qu'un filigrane peut porter : lettres, espaces, traits d'union et apostrophes. */
export function watermarkName(firstName: string, lastName: string): string | null {
  const clean = (s: string) => s.normalize('NFC').replace(/[^\p{L}\p{M} '’-]/gu, '').replace(/\s+/g, ' ').trim();
  const name = `${clean(firstName)} ${clean(lastName)}`.trim();
  return name.length >= 2 && name.length <= 80 ? name : null;
}

export function watermarkText(name: string, contentCode: string): string {
  return `${name} · ${WATERMARK_BRAND} · ${contentCode}`;
}

/** La plus petite taille de lettre du filigrane, en pixels de l'image : en dessous, il ne se lirait plus. */
export const WATERMARK_MIN_FONT = 10;

/** Largeur prudente d'un caractère, en part de la taille de lettre (police du système, majuscules comprises). */
const CHAR_WIDTH = 0.62;

/** Les deux lignes du filigrane : le nom de l'agent, puis la marque et le code. */
export function watermarkLines(text: string): [string, string] {
  const i = text.indexOf(` · ${WATERMARK_BRAND} · `);
  return i < 0 ? [text, ''] : [text.slice(0, i), text.slice(i + 3)];
}

/**
 * La taille de lettre du filigrane pour une image : 2,8 % du petit côté, réduite pour que chaque ligne tienne entière
 * dans la largeur ; null si elle tomberait sous le minimum lisible.
 */
export function watermarkFontSize(text: string, width: number, height: number): number | null {
  const longest = Math.max(...watermarkLines(text).map((l) => [...l].length), 1);
  const wanted = Math.min(width, height) * 0.028;
  // Le texte et ses marges (une demi-taille de chaque côté) tiennent dans la largeur.
  const fits = (width * 0.96) / (longest * CHAR_WIDTH + 1.2);
  const size = Math.floor(Math.max(Math.min(wanted, fits), Math.min(fits, WATERMARK_MIN_FONT)));
  return size >= WATERMARK_MIN_FONT ? size : null;
}

/**
 * Le calque du filigrane, aux dimensions de l'image : une bande en bas à droite, deux lignes, lisible sur fond clair
 * comme sombre, jamais au centre. Chaque ligne est tenue dans sa largeur (`textLength`) : rien ne sort de l'image,
 * quelle que soit la police de l'appareil. Null si l'image est trop petite pour un filigrane lisible.
 */
export function watermarkSvg(text: string, width: number, height: number): string | null {
  const size = watermarkFontSize(text, width, height);
  if (size === null) return null;
  const lines = watermarkLines(text).filter((l) => l.length > 0);
  const pad = Math.round(size * 0.6);
  const lineWidths = lines.map((l) => Math.min(Math.ceil([...l].length * size * CHAR_WIDTH), width - pad * 2));
  const bandWidth = Math.min(width, Math.max(...lineWidths) + pad * 2);
  const lineHeight = Math.round(size * 1.25);
  const bandHeight = lineHeight * lines.length + pad * 2;
  const x = width - bandWidth;
  const y = height - bandHeight;
  const texts = lines.map((l, i) => {
    const baseline = y + pad + lineHeight * (i + 1) - Math.round(size * 0.3);
    return `<text x="${width - pad}" y="${baseline}" text-anchor="end" textLength="${lineWidths[i]}" lengthAdjust="spacingAndGlyphs" font-family="${xml(POLICES.texte)}" font-size="${size}" fill="${PALETTE.clair.surface}" fill-opacity="0.92">${xml(l)}</text>`;
  });
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${xml(text)}">`,
    `<rect x="${x}" y="${y}" width="${bandWidth}" height="${bandHeight}" fill="${PALETTE.clair.encre}" fill-opacity="0.55"/>`,
    ...texts,
    '</svg>',
  ].join('');
}

export class FiligranePhotos {
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly origine: OrigineContacts;
  private readonly referencement: Referencement;

  constructor(
    private readonly db: SqlDatabase,
    private readonly acces: Acces,
    private readonly journal: JournalStore,
    private readonly certificats: CertificatsPhotos,
    options: FiligraneOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => crypto.randomUUID());
    this.origine = options.origine ?? new OrigineContacts(db, journal, { now: this.now });
    this.referencement = new Referencement(db, journal, { now: this.now });
  }

  /**
   * L'agent du bien, ou la direction, exporte une photo certifiée : le calque du filigrane lui est donné, et l'export est
   * rangé avec ce qu'il porte. Une photo sans certificat, un bien sans agent ou des dimensions impossibles : refusé.
   */
  async exportPhoto(viewer: Viewer, propertyId: string, input: { ref: unknown; width: unknown; height: unknown }): Promise<ExportResult> {
    const actor = `${String(viewer.role)}:${viewer.userId}`;
    if (viewer.role !== 'agent' && viewer.role !== 'direction') return this.refused(viewer, propertyId, 'role');
    const read = await this.acces.readProperty(viewer, propertyId);
    if (!read.ok) return { ok: false, rule: 'R16', code: read.code };
    if (read.view !== 'full') return this.refused(viewer, propertyId, 'not_assigned');
    const networkId = read.value.network_id;
    const bad = async (rule: 'R10' | 'R130' | 'R491', code: string): Promise<ExportResult> => {
      await appendEvent(this.journal, { type: 'medias.export.refuse', actor, subject: `property:${propertyId}`, data: { rule, code } }, this.now);
      return { ok: false, rule, code };
    };
    const dim = (v: unknown) => typeof v === 'number' && Number.isInteger(v) && v >= 200 && v <= 12000;
    if (!dim(input.width) || !dim(input.height)) return bad('R10', 'dimensions_invalides');
    const width = input.width as number;
    const height = input.height as number;
    const check = await this.certificats.checkPublishable(propertyId, input.ref);
    if (!check.ok) return bad(check.rule, check.code);
    const photo: CertifiedPhoto = check.value;
    // Le filigrane porte l'agent du bien, en activité : un bien sans agent, ou dont l'agent est parti, ne s'exporte pas.
    const agent = await this.db.first<{ first_name: string; last_name: string }>(
      `SELECT a.first_name, a.last_name FROM properties p JOIN agents a ON a.id = p.agent_id AND a.network_id = p.network_id AND a.status = 'active' WHERE p.id = ? AND p.network_id = ?`,
      [propertyId, networkId],
    );
    const name = agent ? watermarkName(agent.first_name, agent.last_name) : null;
    if (!name) return bad('R491', 'sans_agent');
    const content = await this.origine.contentFor(networkId, 'bien', propertyId);
    if (!content.ok || !CODE.test(content.contentId)) return bad('R491', 'sans_code_contenu');
    const text = watermarkText(name, content.contentId);
    // Le filigrane entier doit se lire sur l'image : trop petite, elle ne s'exporte pas.
    const svg = watermarkSvg(text, width, height);
    if (svg === null) return bad('R491', 'image_trop_petite');
    const canonical = await this.taggedPage(networkId, propertyId, content.contentId);
    const id = this.newId();
    await this.db.run(
      `INSERT INTO photo_exports (id, network_id, property_id, result_ref, certificate_token, content_id, watermark_text, width, height, exported_by, exported_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, networkId, propertyId, photo.ref, photo.certificateToken, content.contentId, text, width, height, actor, this.now().toISOString()],
    );
    const mentions = [photo.overlay, photo.retouchMention].filter((m): m is NonNullable<typeof m> => m !== null);
    await appendEvent(this.journal, { type: 'medias.photo.exportee', actor, subject: `property:${propertyId}`, data: { rule: 'R491', mentions } }, this.now);
    return {
      ok: true,
      value: { exportId: id, ref: photo.ref, watermarkText: text, contentCode: content.contentId, link: canonical, mentions, certificatePath: photo.certificatePath, svg, width, height },
    };
  }

  /** Les exports rangés d'une photo, pour vérifier ce qui a été posé. */
  async exportsOf(propertyId: string, ref: string): Promise<{ watermarkText: string; contentCode: string; certificateToken: string }[]> {
    const rows = await this.db.all<{ watermark_text: string; content_id: string; certificate_token: string }>(
      'SELECT watermark_text, content_id, certificate_token FROM photo_exports WHERE property_id = ? AND result_ref = ? ORDER BY exported_at, rowid',
      [propertyId, ref],
    );
    return rows.map((r) => ({ watermarkText: r.watermark_text, contentCode: r.content_id, certificateToken: r.certificate_token }));
  }

  /** Le lien marqué de la page de référence du bien, seulement si elle est en ligne aujourd'hui. */
  private async taggedPage(networkId: string, propertyId: string, code: string): Promise<string | null> {
    const canonical = await this.referencement.canonicalFor(networkId, propertyId);
    return canonical ? taggedLink(canonical, code) : null;
  }

  private async refused(viewer: Viewer, propertyId: string, code: string): Promise<ExportResult> {
    await appendEvent(
      this.journal,
      { type: 'acces.refuse', actor: `${String(viewer.role)}:${viewer.userId}`, subject: `property:${propertyId}`, data: { rule: 'R16', role: String(viewer.role), kind: 'photo_export', code } },
      this.now,
    );
    return { ok: false, rule: 'R16', code };
  }
}
