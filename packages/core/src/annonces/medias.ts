/**
 * Photos et vidéos sans tromper ni montrer l'adresse (M07, P06) [R46, R48].
 *
 * - Une photo d'aménagement virtuel n'est publiée qu'avec la mention « Aménagement virtuel » à poser sur l'image :
 *   chaque canal la reçoit avec la photo, la page et la fiche la posent elles-mêmes (P05) [R48]. Une retouche
 *   au-delà de la lumière et du cadrage n'a pas de case dans la fiche : elle est refusée à la saisie (P01).
 * - Une vidéo n'est publiée qu'une fois son montage rangé par le Studio (M19, musique sous licence [R133]) et ses
 *   sous-titres et sa légende contrôlés : ni adresse, ni voie nommée, ni
 *   critère discriminant, ni mot interdit [R46]. Le contrôle porte sur le texte ; l'image elle-même suit le plan de
 *   tournage, qui dit ce qu'il ne faut jamais filmer.
 * - Le plan de tournage est tiré de la fiche seule : il ne demande de filmer que ce que la fiche dit exister.
 *
 * Le montage de la vidéo vient avec M19 Studio.
 */
import type { Acces } from '../acces/acces.ts';
import type { Viewer } from '../acces/droits.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { sha256 } from '../documents/modeles.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import { publicTextProblems, sentences, type SentenceProblem } from './annonce-sourcee.ts';
import { parisDay } from '../studio/bibliotheque.ts';
import type { PropertySheet } from './fiche-bien.ts';

export const VIRTUAL_STAGING_LABEL = 'Aménagement virtuel';

/** Ce qu'un canal reçoit d'une photo ou d'une vidéo. */
export interface PublishedMedia {
  ref: string;
  kind: 'photo' | 'video' | 'visite_virtuelle';
  /** La mention à poser sur l'image, ou null [R48]. */
  overlay: typeof VIRTUAL_STAGING_LABEL | null;
}

/** Ce qu'il ne faut jamais filmer ni photographier : rien qui situe le bien ni qui montre une personne [R46]. */
export const NEVER_FILM: readonly string[] = [
  'le numéro de la maison ou de l’immeuble',
  'la plaque de la rue',
  'les boîtes aux lettres et l’interphone',
  'une plaque d’immatriculation',
  'une personne, un visage, une photo de famille',
  'un document, un courrier ou un écran allumé',
];

export interface Shot {
  /** Le plan, tiré d'un champ de la fiche. */
  shot: string;
  /** Le champ qui le justifie. */
  source: string;
}

/** Le plan de tournage d'un bien, tiré de sa fiche seule : rien d'autre n'est demandé que ce que la fiche dit exister. */
export function shootingPlan(input: { rooms: number | null; sheet: PropertySheet | null }): { shots: Shot[]; neverFilm: readonly string[] } {
  const shots: Shot[] = [];
  const c = input.sheet?.characteristics;
  if (input.rooms !== null && input.rooms > 0) shots.push({ shot: `Chacune des ${input.rooms} pièces principales, en plan large depuis l’entrée de la pièce`, source: 'rooms' });
  if (c?.bedrooms !== null && c?.bedrooms !== undefined && c.bedrooms > 0) shots.push({ shot: `Les ${c.bedrooms} chambres, fenêtre comprise`, source: 'bedrooms' });
  const OUTDOOR: Record<string, string> = { balcon: 'Le balcon', terrasse: 'La terrasse', jardin: 'Le jardin', cour: 'La cour' };
  for (const o of c?.outdoor ?? []) shots.push({ shot: `${OUTDOOR[o]} : un plan large, sans la rue ni les voisins`, source: 'outdoor' });
  if (c?.landM2 !== null && c?.landM2 !== undefined) shots.push({ shot: 'Le terrain, vu depuis le bien, sans la rue', source: 'landM2' });
  if (c?.parkingSpaces) shots.push({ shot: 'La place de stationnement, sans plaque d’immatriculation', source: 'parkingSpaces' });
  if (c?.elevator === true) shots.push({ shot: 'L’ascenseur, porte ouverte', source: 'elevator' });
  return { shots, neverFilm: NEVER_FILM };
}

type Refusal = { ok: false; rule: 'R16'; code: string };
type Problem =
  | { ok: false; rule: null; code: 'unknown_property' | 'unknown_media' | 'bad_text' }
  | { ok: false; rule: 'R46'; code: 'refused_text'; problems: { text: string; problems: SentenceProblem[] }[] };

const MAX_TEXT = 20_000;

export class MediasBien {
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(
    private readonly db: SqlDatabase,
    private readonly acces: Acces,
    private readonly journal: JournalStore,
    options: { now?: () => Date; newId?: () => string } = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => crypto.randomUUID());
  }

  /**
   * Contrôle les sous-titres et la légende d'une vidéo de la fiche, et garde le résultat. Seul un contrôle réussi,
   * le dernier, permet de publier la vidéo. L'agent du bien ou la direction.
   */
  async checkVideoText(viewer: Viewer, propertyId: string, mediaRef: string, text: { subtitles: unknown; caption: unknown }): Promise<{ ok: true } | Refusal | Problem> {
    const p = await this.acces.readProperty(viewer, propertyId);
    if (!p.ok) return p.code === 'unknown' ? { ok: false, rule: null, code: 'unknown_property' } : (p as Refusal);
    if (p.view !== 'full' || (viewer.role !== 'agent' && viewer.role !== 'direction')) {
      const code = p.view !== 'full' ? 'not_assigned' : 'role';
      await appendEvent(this.journal, { type: 'acces.refuse', actor: `${String(viewer.role)}:${viewer.userId}`, subject: `property:${propertyId}`, data: { rule: 'R16', role: String(viewer.role), kind: 'video', code } }, this.now);
      return { ok: false, rule: 'R16', code };
    }
    if (!Array.isArray(text.subtitles) || text.subtitles.some((s) => typeof s !== 'string') || typeof text.caption !== 'string') return { ok: false, rule: null, code: 'bad_text' };
    const all = [...(text.subtitles as string[]), text.caption];
    if (all.join('\n').length > MAX_TEXT) return { ok: false, rule: null, code: 'bad_text' };
    const sheet = await this.db.first<{ data: string }>('SELECT data FROM property_sheets WHERE property_id = ? ORDER BY version DESC LIMIT 1', [propertyId]);
    const media = sheet ? (JSON.parse(sheet.data) as PropertySheet).media : [];
    if (!media.some((m) => m.ref === mediaRef && m.kind !== 'photo')) return { ok: false, rule: null, code: 'unknown_media' };
    // Chaque ligne seule, puis tous les sous-titres à la suite : une adresse coupée entre deux sous-titres
    // (« au 12 », « rue des Essais ») est lue d'un bloc [R46].
    const continuous = (text.subtitles as string[]).join(' ');
    const seen = new Set<string>();
    // Les textes entiers aussi, sans découpage : un point mal placé ne coupe jamais une adresse en deux.
    const refused = [...all, continuous]
      .flatMap((line) => [...sentences(line), line.replace(/\s+/g, ' ').trim()])
      .map((s) => ({ text: s, problems: publicTextProblems(s) }))
      .filter((s) => s.problems.length > 0 && !seen.has(s.text) && (seen.add(s.text), true));
    const outcome = refused.length === 0 ? 'ok' : 'refuse';
    await this.db.run('INSERT INTO video_text_checks (id, property_id, network_id, media_ref, outcome, text_hash, checked_by, checked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [
      this.newId(), propertyId, viewer.networkId, mediaRef, outcome, await sha256(JSON.stringify(all)), `${String(viewer.role)}:${viewer.userId}`, this.now().toISOString(),
    ]);
    // Au journal : l'issue et les codes, jamais le texte [R13].
    await appendEvent(this.journal, { type: 'video.texte_controle', actor: `${String(viewer.role)}:${viewer.userId}`, subject: `property:${propertyId}`, data: { rule: 'R46', outcome, codes: [...new Set(refused.flatMap((r) => r.problems.map((x) => x.code)))] } }, this.now);
    return refused.length === 0 ? { ok: true } : { ok: false, rule: 'R46', code: 'refused_text', problems: refused };
  }

  /**
   * Les photos et vidéos à publier, pour le système (P04) : toutes les photos de la fiche publiée, avec la mention
   * posée sur l'aménagement virtuel [R48] ; les vidéos et visites seulement après un dernier contrôle réussi [R46].
   */
  async publishable(propertyId: string, sheetVersion: number | null): Promise<PublishedMedia[]> {
    if (sheetVersion === null) return [];
    const sheet = await this.db.first<{ data: string }>('SELECT data FROM property_sheets WHERE property_id = ? AND version = ?', [propertyId, sheetVersion]);
    if (!sheet) return [];
    const out: PublishedMedia[] = [];
    for (const m of (JSON.parse(sheet.data) as PropertySheet).media) {
      if (m.kind === 'photo') {
        out.push({ ref: m.ref, kind: 'photo', overlay: m.edit === 'amenagement_virtuel' ? VIRTUAL_STAGING_LABEL : null });
        continue;
      }
      const last = await this.db.first<{ outcome: string }>('SELECT outcome FROM video_text_checks WHERE property_id = ? AND media_ref = ? ORDER BY checked_at DESC, rowid DESC LIMIT 1', [propertyId, m.ref]);
      if (last?.outcome !== 'ok') continue;
      // Une vidéo ne part qu'une fois son montage rangé par le Studio (M19, X03) : sa musique y a été contrôlée contre
      // la bibliothèque sous licence [R133]. Une vidéo venue d'ailleurs, à la musique inconnue, ne part pas.
      // Sa musique est relue au moment de publier : une licence retirée ou expirée depuis le montage retire la vidéo.
      if (m.kind === 'video' && !(await this.montageStillLicensed(propertyId, m.ref))) continue;
      out.push({ ref: m.ref, kind: m.kind, overlay: null });
    }
    return out;
  }

  /** Le montage de la vidéo existe, et sa musique, s'il en a une, a encore sa licence à cet instant [R133]. */
  private async montageStillLicensed(propertyId: string, videoRef: string): Promise<boolean> {
    const montage = await this.db.first<{ network_id: string; music_id: string | null }>('SELECT network_id, music_id FROM video_montages WHERE property_id = ? AND video_ref = ? LIMIT 1', [propertyId, videoRef]);
    if (!montage) return false;
    if (montage.music_id === null) return true;
    const asset = await this.db.first<{ valid_until: string | null; withdrawn: string | null }>(
      `SELECT a.valid_until, w.asset_id AS withdrawn FROM licensed_assets a LEFT JOIN licensed_asset_withdrawals w ON w.asset_id = a.id
       WHERE a.id = ? AND a.network_id = ? AND a.kind = 'musique'`,
      [montage.music_id, montage.network_id],
    );
    if (!asset || asset.withdrawn !== null) return false;
    return asset.valid_until === null || asset.valid_until >= parisDay(this.now());
  }
}
