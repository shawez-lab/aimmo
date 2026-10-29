/**
 * Le montage vidéo sur l'appareil, à partir d'un modèle (M19, X03).
 *
 * Le modèle est décrit par le code depuis le plan de tournage de M07 (P06) et la fiche du bien : l'ordre des plans,
 * leur durée, un sous-titre tiré de la fiche pour chacun (jamais d'adresse, rien d'inventé [R10, R46]), la musique à
 * choisir dans la bibliothèque sous licence, et une fin à la marque de l'agent, posée par l'application. Le montage se
 * fait sur le téléphone ou l'ordinateur de l'agent : aucun fichier vidéo ne passe par le serveur, seule sa référence
 * dans la fiche et son empreinte [R130].
 *
 * Le serveur range la description du montage fini, après avoir contrôlé :
 * - la musique : seulement de la bibliothèque, licence et preuve rangées et en cours de validité [R133] ;
 * - les sous-titres et la légende : le contrôle de M07, qui refuse une adresse ou un mot interdit, et dont la réussite
 *   seule permet ensuite de publier la vidéo (P04) [R46, R132].
 *
 * Le modèle tient en 10 minutes de montage : au plus 10 plans, et une estimation par gestes vérifiée par les tests.
 */
import type { Acces } from '../acces/acces.ts';
import type { Viewer } from '../acces/droits.ts';
import { shootingPlan, type MediasBien } from '../annonces/medias.ts';
import type { PropertySheet } from '../annonces/fiche-bien.ts';
import type { SqlDatabase } from '../db/sql.ts';
import type { PropertyKind } from '../db/types.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';

/** La bibliothèque de musiques sous licence (X07) : null pour une musique inconnue, sans preuve ou expirée [R133]. */
export interface MusicLibrary {
  licensedMusic(networkId: string, id: string, at: Date): Promise<{ id: string } | null>;
}

export interface TemplateClip {
  order: number;
  kind: 'accroche' | 'plan' | 'fin_marque';
  /** Ce qu'il faut montrer, tiré du plan de tournage. */
  shot: string;
  /** Le champ de la fiche qui justifie le plan, ou `marque` pour la fin. */
  source: string;
  seconds: number;
  /** Le sous-titre proposé, tiré de la fiche ; null pour la fin, posée par l'application à la marque de l'agent. */
  subtitle: string | null;
}

export interface MontageTemplate {
  clips: TemplateClip[];
  totalSeconds: number;
  /** Les gestes de l'agent : choisir chaque plan, choisir la musique, relire, valider. */
  gestures: number;
  /** Le temps de montage prévu, en minutes : gestes et deux visionnages de la vidéo. */
  estimatedMinutes: number;
  neverFilm: readonly string[];
}

export const MAX_PLAN_CLIPS = 10;
const CLIP_SECONDS = 4;
const SECONDS_PER_GESTURE = 20;

const KIND_LABEL: Record<PropertyKind, string> = {
  home: 'Logement',
  land: 'Terrain',
  building: 'Immeuble',
  commercial: 'Local',
  business_walls: 'Murs commerciaux',
  business: 'Fonds de commerce',
};
const OUTDOOR_LABEL: Record<string, string> = { balcon: 'Balcon', terrasse: 'Terrasse', jardin: 'Jardin', cour: 'Cour' };

const fr = (n: number): string => n.toLocaleString('fr-FR').replace(/[  ]/g, ' ');
const plural = (n: number, one: string, many: string): string => `${fr(n)} ${n > 1 ? many : one}`;

/** Le sous-titre d'un plan, tiré du seul champ qui le justifie ; rien d'autre. */
function subtitleFor(source: string, facts: { rooms: number | null; sheet: PropertySheet | null }, outdoorIndex: number): string | null {
  const c = facts.sheet?.characteristics;
  switch (source) {
    case 'rooms':
      return facts.rooms !== null && facts.rooms > 0 ? plural(facts.rooms, 'pièce principale', 'pièces principales') : null;
    case 'bedrooms':
      return c?.bedrooms ? plural(c.bedrooms, 'chambre', 'chambres') : null;
    case 'outdoor': {
      const o = c?.outdoor[outdoorIndex];
      return o ? (OUTDOOR_LABEL[o] ?? null) : null;
    }
    case 'landM2':
      return c?.landM2 ? `Terrain de ${fr(c.landM2)} m²` : null;
    case 'parkingSpaces':
      return c?.parkingSpaces ? plural(c.parkingSpaces, 'place de stationnement', 'places de stationnement') : null;
    case 'elevator':
      return c?.elevator === true ? 'Ascenseur' : null;
    default:
      return null;
  }
}

/** Le modèle de montage d'un bien, tiré de sa fiche seule. */
export function montageTemplate(facts: { kind: PropertyKind; surfaceM2: number | null; rooms: number | null; sheet: PropertySheet | null }): MontageTemplate {
  const plan = shootingPlan({ rooms: facts.rooms, sheet: facts.sheet });
  const clips: TemplateClip[] = [];
  const hook = [KIND_LABEL[facts.kind], facts.surfaceM2 !== null && facts.surfaceM2 > 0 ? `${fr(facts.surfaceM2)} m²` : null].filter(Boolean).join(' de ');
  const energy = facts.sheet?.energy ? ` · DPE ${facts.sheet.energy.energyClass}` : '';
  clips.push({ order: 1, kind: 'accroche', shot: plan.shots[0]?.shot ?? 'Un plan large de la pièce principale', source: plan.shots[0]?.source ?? 'kind', seconds: CLIP_SECONDS, subtitle: hook + energy });
  let outdoorIndex = 0;
  for (const s of plan.shots.slice(0, MAX_PLAN_CLIPS)) {
    const subtitle = subtitleFor(s.source, facts, s.source === 'outdoor' ? outdoorIndex : 0);
    if (s.source === 'outdoor') outdoorIndex += 1;
    clips.push({ order: clips.length + 1, kind: 'plan', shot: s.shot, source: s.source, seconds: CLIP_SECONDS, subtitle });
  }
  clips.push({ order: clips.length + 1, kind: 'fin_marque', shot: 'Fin à la marque de l’agent, posée par l’application', source: 'marque', seconds: CLIP_SECONDS, subtitle: null });
  const totalSeconds = clips.reduce((n, c) => n + c.seconds, 0);
  // Un geste par plan à choisir (la fin est posée seule), un pour la musique, un pour relire, un pour valider.
  const gestures = clips.filter((c) => c.kind !== 'fin_marque').length + 3;
  const estimatedMinutes = Math.ceil((gestures * SECONDS_PER_GESTURE + totalSeconds * 2) / 60);
  return { clips, totalSeconds, gestures, estimatedMinutes, neverFilm: plan.neverFilm };
}

export interface MontageRecord {
  propertyId: string;
  videoRef: string;
  durationSeconds: number;
  clipsCount: number;
  musicId: string | null;
  recordedAt: string;
}

export type MontageResult<T> =
  | { ok: true; value: T }
  | { ok: false; rule: 'R16' | 'R10' | 'R130' | 'R133' | 'R46' | null; code: string; problems?: unknown };

const SHA = /^[0-9a-f]{64}$/;
const INPUT_KEYS = ['videoRef', 'videoSha256', 'durationSeconds', 'subtitles', 'caption', 'musicId', 'processedOn'];
const FILE_KEYS = /^(file|fichier|data|donnees|content|contenu|bytes|blob|base64|video)$/i;

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export interface MontagesOptions {
  now?: () => Date;
  newId?: () => string;
}

export class Montages {
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(
    private readonly db: SqlDatabase,
    private readonly acces: Acces,
    private readonly journal: JournalStore,
    private readonly medias: MediasBien,
    private readonly music: MusicLibrary,
    options: MontagesOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => crypto.randomUUID());
  }

  /** Le modèle de montage du bien, pour qui le voit en entier [R16]. */
  async template(viewer: Viewer, propertyId: string): Promise<MontageResult<MontageTemplate>> {
    const seen = await this.full(viewer, propertyId);
    if (!seen.ok) return seen;
    return { ok: true, value: montageTemplate({ ...seen.value, sheet: await this.sheet(propertyId) }) };
  }

  /** L'agent du bien, ou la direction, range la description d'un montage fait sur son appareil. */
  async record(viewer: Viewer, propertyId: string, input: Record<string, unknown>): Promise<MontageResult<MontageRecord>> {
    if (viewer.role !== 'agent' && viewer.role !== 'direction') return this.refused(viewer, propertyId, 'role');
    const seen = await this.full(viewer, propertyId);
    if (!seen.ok) return seen;
    const actor = `${viewer.role}:${viewer.userId}`;
    const bad = async (rule: 'R10' | 'R130' | 'R133' | 'R46', code: string, problems?: unknown): Promise<MontageResult<MontageRecord>> => {
      await appendEvent(this.journal, { type: 'studio.montage.refuse', actor, subject: `property:${propertyId}`, data: { rule, code } }, this.now);
      return problems === undefined ? { ok: false, rule, code } : { ok: false, rule, code, problems };
    };
    if (typeof input !== 'object' || input === null) return bad('R10', 'saisie_invalide');
    // Aucun fichier, aucun contenu : seulement la référence et l'empreinte de la vidéo finie [R130].
    if (Object.keys(input).some((k) => FILE_KEYS.test(k))) return bad('R130', 'fichier_refuse');
    if (Object.keys(input).some((k) => !INPUT_KEYS.includes(k))) return bad('R10', 'saisie_invalide');
    if (input.processedOn !== 'appareil') return bad('R130', 'traitement_hors_appareil');
    const sheet = await this.sheet(propertyId);
    const video = typeof input.videoRef === 'string' ? sheet?.media.find((m) => m.ref === input.videoRef && m.kind === 'video') : undefined;
    if (!video) return bad('R10', 'video_inconnue');
    if (typeof input.videoSha256 !== 'string' || !SHA.test(input.videoSha256)) return bad('R10', 'empreinte_invalide');
    const template = montageTemplate({ ...seen.value, sheet });
    const d = input.durationSeconds;
    // La durée dite par l'appareil reste dans celle du modèle, à quelques secondes près.
    if (typeof d !== 'number' || !Number.isInteger(d) || d < 1 || d > template.totalSeconds + 15) return bad('R10', 'duree_invalide');
    // La musique : rien, ou une musique de la bibliothèque, licence et preuve rangées, en cours de validité [R133].
    let musicId: string | null = null;
    if (input.musicId !== null && input.musicId !== undefined) {
      if (typeof input.musicId !== 'string' || input.musicId.length > 80) return bad('R133', 'musique_sans_licence');
      const licensed = await this.music.licensedMusic(seen.value.networkId, input.musicId, this.now());
      if (!licensed || licensed.id !== input.musicId) return bad('R133', 'musique_sans_licence');
      musicId = input.musicId;
    }
    if (await this.db.first('SELECT id FROM video_montages WHERE property_id = ? AND video_ref = ?', [propertyId, video.ref])) return bad('R10', 'deja_rangee');
    // Les textes : le contrôle de M07, gardé, dont seule la réussite rend la vidéo publiable [R46, R132].
    const checked = await this.medias.checkVideoText(viewer, propertyId, video.ref, { subtitles: input.subtitles, caption: input.caption });
    if (!checked.ok) {
      if (checked.rule === 'R46') return bad('R46', 'texte_refuse', 'problems' in checked ? checked.problems : undefined);
      if (checked.rule === 'R16') return { ok: false, rule: 'R16', code: checked.code };
      return bad('R10', checked.code);
    }
    const at = this.now().toISOString();
    const { changes } = await this.db.run(
      `INSERT INTO video_montages (id, property_id, network_id, video_ref, video_sha256, template_sha256, clips_count, duration_s, music_id, processed_on, recorded_by, recorded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'appareil', ?, ?) ON CONFLICT DO NOTHING`,
      [this.newId(), propertyId, seen.value.networkId, video.ref, input.videoSha256, await sha256Hex(JSON.stringify(template.clips)), template.clips.length, d, musicId, actor, at],
    );
    if (changes !== 1) return bad('R10', 'deja_rangee');
    await appendEvent(this.journal, { type: 'studio.montage.range', actor, subject: `property:${propertyId}`, data: { clips: template.clips.length, seconds: d, music: musicId !== null } }, this.now);
    return { ok: true, value: { propertyId, videoRef: video.ref, durationSeconds: d, clipsCount: template.clips.length, musicId, recordedAt: at } };
  }

  private async sheet(propertyId: string): Promise<PropertySheet | null> {
    const row = await this.db.first<{ data: string }>('SELECT data FROM property_sheets WHERE property_id = ? ORDER BY version DESC LIMIT 1', [propertyId]);
    if (!row) return null;
    const data = JSON.parse(row.data) as PropertySheet;
    return data && Array.isArray(data.media) && data.characteristics ? data : null;
  }

  private async full(viewer: Viewer, propertyId: string): Promise<MontageResult<{ networkId: string; kind: PropertyKind; surfaceM2: number | null; rooms: number | null }>> {
    const read = await this.acces.readProperty(viewer, propertyId);
    if (!read.ok) return { ok: false, rule: 'R16', code: read.code };
    if (read.view !== 'full') return this.refused(viewer, propertyId, 'not_assigned');
    return { ok: true, value: { networkId: read.value.network_id, kind: read.value.kind, surfaceM2: read.value.surface_m2, rooms: read.value.rooms } };
  }

  private async refused<T>(viewer: Viewer, propertyId: string, code: string): Promise<MontageResult<T>> {
    await appendEvent(
      this.journal,
      { type: 'acces.refuse', actor: `${String(viewer.role)}:${viewer.userId}`, subject: `property:${propertyId}`, data: { rule: 'R16', role: String(viewer.role), kind: 'video_montage', code } },
      this.now,
    );
    return { ok: false, rule: 'R16', code };
  }
}
