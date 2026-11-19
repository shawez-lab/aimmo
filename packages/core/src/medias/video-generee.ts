/**
 * Vidéo générée depuis les photos, voix off et avatar de l'agent (M19, HX42) [R130, R495, R496, R497].
 *
 * Comme Hektor, Talqor ou Kappn : une vidéo animée tirée des photos du bien, le mobilier qui apparaît, une voix off,
 * des sous-titres, l'avatar de l'agent. La vidéo est faite sur l'appareil de l'agent, jamais sur un serveur [R130] :
 * ici, le code donne le plan de la vidéo et range sa description une fois faite.
 *
 * Jamais vu :
 * - la voix et l'avatar ne viennent que de l'agent lui-même : son accord écrit, donné par lui seul sur un texte
 *   versionné, pour son propre enregistrement (seule son empreinte est rangée) ; retirable à tout moment, et la vidéo qui
 *   l'utilisait n'est plus diffusable [R495] ;
 * - chaque plan porte la mention « Vidéo générée », et celle de la voix ou de l'avatar de synthèse quand il y en a ;
 *   l'image aménagée garde sa mention et n'apparaît qu'en fondu depuis sa photo réelle jumelle [R496, R48, R493] ;
 * - les sous-titres sortent en français et dans les langues ouvertes pour le bien (HX05), chaque ligne contrôlée comme
 *   une traduction d'annonce ; une adresse exacte est refusée dans toutes les langues, comme en P06 [R497, R46, R257].
 *
 * Décidé, lecture prudente : seul l'agent du bien, lui-même, utilise sa voix ou son avatar ; la direction peut ranger
 * une vidéo générée, sans voix ni avatar. La vidéo suit le plan des photos du moment : si les photos changent, elle
 * n'est plus diffusable tant qu'une nouvelle n'est pas faite.
 */
import type { Acces } from '../acces/acces.ts';
import type { Viewer } from '../acces/droits.ts';
import { controlTranslation, type ListingLanguage, type TranslationProblem } from '../annonces/traductions.ts';
import { publicTextProblems, type SentenceProblem } from '../annonces/annonce-sourcee.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';

export const GENERATED_VIDEO_MENTION = 'Vidéo générée';
export const LIKENESS_KINDS = ['voix', 'avatar'] as const;
export type LikenessKind = (typeof LIKENESS_KINDS)[number];
export const CONSENT_TEXT_VERSION = 'HX42-2026-11-08';
export const VIDEO_ANIMATIONS = ['zoom_avant', 'panoramique_droite', 'zoom_arriere', 'panoramique_gauche'] as const;
export type VideoAnimation = (typeof VIDEO_ANIMATIONS)[number] | 'apparition_amenagement' | 'fin_marque';
export const MAX_GENERATED_CLIPS = 12;
/** 24 lignes de 160 signes : lues à la suite, elles tiennent dans la longueur d'un texte d'annonce (R257). */
export const MAX_SUBTITLE_LINES = 24;
export const MAX_SUBTITLE_CHARS = 160;
const CLIP_SECONDS = 4;

/** Le texte de l'accord, tel que l'agent le lit et le recopie : nommé, daté par sa version, retirable. */
export function consentText(kind: LikenessKind, firstName: string, lastName: string): string {
  const what = kind === 'voix' ? 'ma voix de synthèse, tirée de mon propre enregistrement' : 'mon avatar de synthèse, tiré de ma propre image';
  return (
    `Je soussigné(e) ${firstName} ${lastName} autorise l’usage de ${what}, dans les vidéos des seuls biens dont je suis l’agent. ` +
    `Chaque vidéo porte la mention « ${GENERATED_VIDEO_MENTION} ». Je peux retirer cet accord à tout moment : aucune vidéo ne l’utilisera plus, ` +
    `et celles qui l’utilisent ne seront plus diffusées. (${CONSENT_TEXT_VERSION})`
  );
}

/** La mention de la voix ou de l'avatar de synthèse, posée avec « Vidéo générée » [R496]. */
export function likenessMention(voice: boolean, avatar: boolean): string | null {
  if (voice && avatar) return 'Voix et avatar de synthèse de l’agent, avec son accord écrit';
  if (voice) return 'Voix de synthèse de l’agent, avec son accord écrit';
  if (avatar) return 'Avatar de synthèse de l’agent, avec son accord écrit';
  return null;
}

/** Une photo prête à partir, comme la donne le Studio (X02) : déjà dans l'ordre de R493. */
export interface PlanPhoto {
  ref: string;
  overlay: 'Aménagement virtuel' | null;
  retouchMention: string | null;
  twin?: string;
}

export interface GeneratedClip {
  order: number;
  animation: VideoAnimation;
  /** La photo montrée ; null pour la fin à la marque de l'agent, posée par l'application. */
  photoRef: string | null;
  /** Pour le mobilier qui apparaît : la photo réelle d'où part le fondu. */
  fromRef: string | null;
  seconds: number;
  /** Les mentions posées sur tout le plan : toujours « Vidéo générée » [R496]. */
  overlays: string[];
}

export interface GeneratedPlan {
  clips: GeneratedClip[];
  totalSeconds: number;
}

/**
 * Le plan de la vidéo, tiré des seules photos publiables : chaque photo réelle animée (zoom ou panoramique, dans une
 * liste fermée), chaque image aménagée en fondu depuis sa jumelle réelle, jamais en premier ni sans elle [R493].
 */
export function generatedVideoPlan(photos: readonly PlanPhoto[]): GeneratedPlan {
  const clips: GeneratedClip[] = [];
  const shown = new Set<string>();
  let real = 0;
  for (const p of photos) {
    if (clips.length >= MAX_GENERATED_CLIPS - 1) break;
    const overlays = [GENERATED_VIDEO_MENTION, ...(p.overlay ? [p.overlay] : []), ...(p.retouchMention ? [p.retouchMention] : [])];
    if (p.overlay !== null) {
      // Le mobilier n'apparaît que sur sa pièce réelle, montrée juste avant : sinon, l'image ne part pas.
      const prev = clips[clips.length - 1];
      if (p.twin === undefined || !shown.has(p.twin) || prev === undefined || (prev.photoRef !== p.twin && prev.fromRef !== p.twin)) continue;
      clips.push({ order: clips.length + 1, animation: 'apparition_amenagement', photoRef: p.ref, fromRef: p.twin, seconds: CLIP_SECONDS, overlays });
      continue;
    }
    clips.push({ order: clips.length + 1, animation: VIDEO_ANIMATIONS[real % VIDEO_ANIMATIONS.length]!, photoRef: p.ref, fromRef: null, seconds: CLIP_SECONDS, overlays });
    shown.add(p.ref);
    real += 1;
  }
  if (clips.length === 0) return { clips: [], totalSeconds: 0 };
  clips.push({ order: clips.length + 1, animation: 'fin_marque', photoRef: null, fromRef: null, seconds: CLIP_SECONDS, overlays: [GENERATED_VIDEO_MENTION] });
  return { clips, totalSeconds: clips.reduce((n, c) => n + c.seconds, 0) };
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export const planSha256 = (plan: GeneratedPlan): Promise<string> => sha256Hex(JSON.stringify(plan.clips));

export type SubtitleLanguage = 'fr' | ListingLanguage;
/** `line` : la ligne en cause ; -1 pour un nombre de lignes différent du français ; null pour les lignes lues à la suite. */
export type SubtitleProblem = { language: ListingLanguage; line: number | null; problems: TranslationProblem[] };

/** Ce qui se lit sur les sous-titres à la suite : ce qu'aucun texte public ne porte [R46]. */
const CONTINUOUS_PROBLEMS = ['adresse', 'critere_discriminant', 'mot_interdit', 'lien_ou_mail'] as const;

/** Le contrôle des sous-titres traduits : même nombre de lignes, chaque ligne comme une traduction d'annonce [R497]. */
export function checkSubtitleTranslations(fr: readonly string[], translations: ReadonlyMap<ListingLanguage, readonly string[]>): SubtitleProblem[] {
  const out: SubtitleProblem[] = [];
  for (const [language, lines] of translations) {
    if (lines.length !== fr.length) {
      out.push({ language, line: -1, problems: ['texte_vide'] });
      continue;
    }
    lines.forEach((line, i) => {
      const c = controlTranslation({ title: fr[i]!, body: fr[i]! }, { title: line, body: line }, language);
      if (!c.ok) out.push({ language, line: i, problems: [...new Set([...c.title, ...c.body])] });
    });
    // Tous les sous-titres à la suite, aussi : une adresse coupée entre deux lignes (« At 12 », « Test Street ») est lue
    // d'un bloc, comme le français en P06 [R46]. Seuls ces contrôles-là : les nombres et les classes ont été comparés
    // ligne par ligne, et lues à la suite, un « A » en tête de ligne passerait pour une lettre de classe.
    if (out.some((p) => p.language === language)) continue;
    const joined = lines.join(' ');
    const whole = controlTranslation({ title: fr[0]!, body: fr.join(' ') }, { title: lines[0]!, body: joined }, language);
    const found = new Set<TranslationProblem>(whole.body.filter((c) => (CONTINUOUS_PROBLEMS as readonly string[]).includes(c)));
    for (const p of publicTextProblems(joined)) found.add(p.code as TranslationProblem);
    if (found.size > 0) out.push({ language, line: null, problems: [...found] });
  }
  return out;
}

/** Ce que le Studio donne : les photos publiables du bien, dans l'ordre de R493 (X02, HX41). */
export interface PublishablePhotos {
  publishable(propertyId: string): Promise<PlanPhoto[]>;
}
/** Le contrôle des textes d'une vidéo de M07 (P06) [R46]. */
export interface VideoTextCheck {
  checkVideoText(viewer: Viewer, propertyId: string, mediaRef: string, text: { subtitles: unknown; caption: unknown }): Promise<{ ok: true } | { ok: false; rule: 'R16' | 'R46' | null; code: string; problems?: { text: string; problems: SentenceProblem[] }[] }>;
}
/** Les langues ouvertes pour un bien : l'anglais et celles de son agent (HX05). */
export interface OpenLanguages {
  /** Les langues ouvertes sur ce bien : celles que son agent déclare, et celles d'un relecteur désigné pour lui (AU113). */
  languagesFor(networkId: string, agentId: string | null, propertyId?: string): Promise<ListingLanguage[]>;
}

export interface LikenessConsent {
  id: string;
  kind: LikenessKind;
  sampleSha256: string;
  textVersion: string;
  givenAt: string;
  revokedAt: string | null;
}

export interface GeneratedVideoPlanView {
  plan: GeneratedPlan;
  planSha256: string;
  mention: typeof GENERATED_VIDEO_MENTION;
  languages: SubtitleLanguage[];
  /** Ce que ce lecteur peut utiliser : sa propre voix ou son avatar, seulement s'il est l'agent du bien et a donné son accord. */
  voice: boolean;
  avatar: boolean;
}

export interface GeneratedVideoRecord {
  propertyId: string;
  videoRef: string;
  mentions: string[];
  languages: SubtitleLanguage[];
  voice: boolean;
  avatar: boolean;
  recordedAt: string;
}

export type VideoResult<T> =
  | { ok: true; value: T }
  | { ok: false; rule: 'R16' | 'R10' | 'R130' | 'R46' | 'R495' | 'R496' | 'R497'; code: string; problems?: unknown };

const SHA = /^[0-9a-f]{64}$/;
const INPUT_KEYS = ['videoRef', 'videoSha256', 'durationSeconds', 'planSha256', 'mentions', 'voice', 'avatar', 'voiceSampleSha256', 'avatarSampleSha256', 'subtitles', 'caption', 'processedOn'];
const FILE_KEYS = /^(file|fichier|data|donnees|content|contenu|bytes|blob|base64|video|audio|sample|echantillon)$/i;
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

interface ConsentRow {
  id: string;
  kind: LikenessKind;
  sample_sha256: string;
  text_version: string;
  given_at: string;
  revoked_at: string | null;
}

export type Diffusability = { ok: true } | { ok: false; code: 'inconnue' | 'accord_retire' | 'accord_hors_agent_du_bien' | 'photos_changees' };

/**
 * Une vidéo générée peut-elle être diffusée maintenant ? Seulement si elle suit encore le plan des photos du moment,
 * et si l'accord de voix ou d'avatar qu'elle utilise n'a pas été retiré et vient toujours de l'agent du bien en
 * activité [R495, R493]. Relu au moment d'envoyer, par le Studio et par chaque annonce [R498].
 */
export async function generatedVideoDiffusable(db: SqlDatabase, photos: PublishablePhotos, propertyId: string, videoRef: string): Promise<Diffusability> {
  const row = await db.first<{ plan_sha256: string; voice_consent_id: string | null; avatar_consent_id: string | null }>(
    'SELECT plan_sha256, voice_consent_id, avatar_consent_id FROM generated_videos WHERE property_id = ? AND video_ref = ?',
    [propertyId, videoRef],
  );
  if (!row) return { ok: false, code: 'inconnue' };
  for (const id of [row.voice_consent_id, row.avatar_consent_id]) {
    if (id === null) continue;
    if (await db.first('SELECT consent_id FROM agent_likeness_revocations WHERE consent_id = ?', [id])) return { ok: false, code: 'accord_retire' };
    // L'accord ne vaut que pour les biens de l'agent qui l'a donné, tant qu'il en est l'agent en activité : un bien
    // repris par un autre, ou un agent parti, et la vidéo ne part plus [R495].
    const owner = await db.first<{ id: string }>(
      `SELECT c.id FROM agent_likeness_consents c JOIN properties p ON p.id = ? AND p.agent_id = c.agent_id AND p.network_id = c.network_id
       JOIN agents a ON a.id = c.agent_id AND a.network_id = c.network_id AND a.status = 'active' WHERE c.id = ?`,
      [propertyId, id],
    );
    if (!owner) return { ok: false, code: 'accord_hors_agent_du_bien' };
  }
  if ((await planSha256(generatedVideoPlan(await photos.publishable(propertyId)))) !== row.plan_sha256) return { ok: false, code: 'photos_changees' };
  return { ok: true };
}

export interface VideosGenereesOptions {
  now?: () => Date;
  newId?: () => string;
}

export class VideosGenerees {
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(
    private readonly db: SqlDatabase,
    private readonly acces: Acces,
    private readonly journal: JournalStore,
    private readonly photos: PublishablePhotos,
    private readonly texts: VideoTextCheck,
    private readonly languages: OpenLanguages,
    options: VideosGenereesOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => crypto.randomUUID());
  }

  // ——— L'accord de l'agent, pour sa voix ou son avatar ———

  /** Le texte que l'agent lit et recopie pour donner son accord : seulement le sien. */
  async consentTextFor(viewer: Viewer, kind: unknown): Promise<VideoResult<string>> {
    const agent = await this.self(viewer);
    if (!agent.ok) return agent;
    if (!(LIKENESS_KINDS as readonly unknown[]).includes(kind)) return { ok: false, rule: 'R10', code: 'sorte_inconnue' };
    return { ok: true, value: consentText(kind as LikenessKind, agent.value.first_name, agent.value.last_name) };
  }

  /**
   * L'agent, lui-même, donne son accord écrit pour sa voix ou son avatar : il recopie le texte, et seule l'empreinte de
   * son enregistrement, fait sur son appareil, est rangée [R495, R130]. Personne ne peut le donner pour lui.
   */
  async giveConsent(viewer: Viewer, input: Record<string, unknown>): Promise<VideoResult<LikenessConsent>> {
    const agent = await this.self(viewer);
    if (!agent.ok) return agent;
    const subject = `agent:${viewer.userId}`;
    const bad = async (rule: 'R10' | 'R130' | 'R495', code: string): Promise<VideoResult<LikenessConsent>> => {
      await appendEvent(this.journal, { type: 'medias.accord_voix.refuse', actor: `agent:${viewer.userId}`, subject, data: { rule, code } }, this.now);
      return { ok: false, rule, code };
    };
    if (!isRecord(input)) return bad('R10', 'saisie_invalide');
    if (Object.keys(input).some((k) => FILE_KEYS.test(k))) return bad('R130', 'fichier_refuse');
    if (Object.keys(input).some((k) => !['kind', 'sampleSha256', 'acceptedText', 'processedOn'].includes(k))) return bad('R10', 'saisie_invalide');
    if (input.processedOn !== 'appareil') return bad('R130', 'traitement_hors_appareil');
    if (!(LIKENESS_KINDS as readonly unknown[]).includes(input.kind)) return bad('R10', 'sorte_inconnue');
    const kind = input.kind as LikenessKind;
    if (typeof input.sampleSha256 !== 'string' || !SHA.test(input.sampleSha256)) return bad('R10', 'empreinte_invalide');
    const text = consentText(kind, agent.value.first_name, agent.value.last_name);
    // L'accord est écrit : le texte recopié à l'identique, rien de moins.
    if (input.acceptedText !== text) return bad('R495', 'texte_non_accepte');
    const existing = await this.db.first<ConsentRow>(
      'SELECT c.id, c.kind, c.sample_sha256, c.text_version, c.given_at, r.revoked_at FROM agent_likeness_consents c LEFT JOIN agent_likeness_revocations r ON r.consent_id = c.id WHERE c.agent_id = ? AND c.kind = ? AND c.sample_sha256 = ?',
      [viewer.userId, kind, input.sampleSha256],
    );
    if (existing) return existing.revoked_at === null ? { ok: true, value: this.consentView(existing) } : bad('R495', 'accord_retire_nouvel_enregistrement');
    const id = this.newId();
    const at = this.now().toISOString();
    const { changes } = await this.db.run(
      `INSERT INTO agent_likeness_consents (id, network_id, agent_id, kind, sample_sha256, text_version, text_sha256, given_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
      [id, viewer.networkId, viewer.userId, kind, input.sampleSha256, CONSENT_TEXT_VERSION, await sha256Hex(text), at],
    );
    if (changes !== 1) return bad('R10', 'deja_donne');
    await appendEvent(this.journal, { type: 'medias.accord_voix.donne', actor: `agent:${viewer.userId}`, subject, data: { rule: 'R495', kind, version: CONSENT_TEXT_VERSION } }, this.now);
    return { ok: true, value: { id, kind, sampleSha256: input.sampleSha256, textVersion: CONSENT_TEXT_VERSION, givenAt: at, revokedAt: null } };
  }

  /** L'agent retire son accord, à tout moment : plus aucune vidéo ne l'utilise ni n'est diffusée avec [R495]. */
  async revokeConsent(viewer: Viewer, consentId: unknown): Promise<VideoResult<LikenessConsent>> {
    const agent = await this.self(viewer);
    if (!agent.ok) return agent;
    if (typeof consentId !== 'string') return { ok: false, rule: 'R10', code: 'accord_inconnu' };
    const row = await this.db.first<{ id: string }>('SELECT id FROM agent_likeness_consents WHERE id = ? AND agent_id = ? AND network_id = ?', [consentId, viewer.userId, viewer.networkId]);
    if (!row) return { ok: false, rule: 'R10', code: 'accord_inconnu' };
    await this.db.run('INSERT INTO agent_likeness_revocations (consent_id, revoked_at) VALUES (?, ?) ON CONFLICT DO NOTHING', [consentId, this.now().toISOString()]);
    await appendEvent(this.journal, { type: 'medias.accord_voix.retire', actor: `agent:${viewer.userId}`, subject: `agent:${viewer.userId}`, data: { rule: 'R495' } }, this.now);
    const now = await this.db.first<ConsentRow>(
      'SELECT c.id, c.kind, c.sample_sha256, c.text_version, c.given_at, r.revoked_at FROM agent_likeness_consents c LEFT JOIN agent_likeness_revocations r ON r.consent_id = c.id WHERE c.id = ?',
      [consentId],
    );
    return { ok: true, value: this.consentView(now!) };
  }

  /** Les accords de l'agent, lui seul les voit. */
  async consents(viewer: Viewer): Promise<VideoResult<LikenessConsent[]>> {
    const agent = await this.self(viewer);
    if (!agent.ok) return agent;
    const rows = await this.db.all<ConsentRow>(
      'SELECT c.id, c.kind, c.sample_sha256, c.text_version, c.given_at, r.revoked_at FROM agent_likeness_consents c LEFT JOIN agent_likeness_revocations r ON r.consent_id = c.id WHERE c.agent_id = ? AND c.network_id = ? ORDER BY c.given_at, c.id',
      [viewer.userId, viewer.networkId],
    );
    return { ok: true, value: rows.map((r) => this.consentView(r)) };
  }

  // ——— La vidéo ———

  /** Le plan de la vidéo du bien, ses langues de sous-titres, et ce que ce lecteur peut y mettre de lui. */
  async plan(viewer: Viewer, propertyId: string): Promise<VideoResult<GeneratedVideoPlanView>> {
    const seen = await this.full(viewer, propertyId);
    if (!seen.ok) return seen;
    const plan = generatedVideoPlan(await this.photos.publishable(propertyId));
    const own = viewer.role === 'agent' && seen.value.agentId === viewer.userId;
    return {
      ok: true,
      value: {
        plan,
        planSha256: await planSha256(plan),
        mention: GENERATED_VIDEO_MENTION,
        languages: ['fr', ...(await this.languages.languagesFor(seen.value.networkId, seen.value.agentId, propertyId))],
        voice: own && (await this.activeConsent(viewer.userId, 'voix')) !== null,
        avatar: own && (await this.activeConsent(viewer.userId, 'avatar')) !== null,
      },
    };
  }

  /** L'agent du bien, ou la direction, range la description d'une vidéo générée sur l'appareil. */
  async record(viewer: Viewer, propertyId: string, input: Record<string, unknown>): Promise<VideoResult<GeneratedVideoRecord>> {
    if (viewer.role !== 'agent' && viewer.role !== 'direction') return this.refused(viewer, propertyId, 'role');
    const seen = await this.full(viewer, propertyId);
    if (!seen.ok) return seen;
    const actor = `${viewer.role}:${viewer.userId}`;
    const bad = async (rule: 'R10' | 'R130' | 'R46' | 'R495' | 'R496' | 'R497', code: string, problems?: unknown): Promise<VideoResult<GeneratedVideoRecord>> => {
      // Au journal : la règle et le code, jamais le texte [R13].
      await appendEvent(this.journal, { type: 'medias.video_generee.refuse', actor, subject: `property:${propertyId}`, data: { rule, code } }, this.now);
      return problems === undefined ? { ok: false, rule, code } : { ok: false, rule, code, problems };
    };
    if (!isRecord(input)) return bad('R10', 'saisie_invalide');
    // Aucun fichier, aucune voix, aucune image : seulement les références et les empreintes [R130].
    if (Object.keys(input).some((k) => FILE_KEYS.test(k))) return bad('R130', 'fichier_refuse');
    if (Object.keys(input).some((k) => !INPUT_KEYS.includes(k))) return bad('R10', 'saisie_invalide');
    if (input.processedOn !== 'appareil') return bad('R130', 'traitement_hors_appareil');
    if (typeof input.videoRef !== 'string' || input.videoRef.length > 200) return bad('R10', 'video_inconnue');
    if (typeof input.videoSha256 !== 'string' || !SHA.test(input.videoSha256)) return bad('R10', 'empreinte_invalide');
    // La vidéo suit le plan des photos publiables du moment, rien d'autre.
    const plan = generatedVideoPlan(await this.photos.publishable(propertyId));
    if (plan.clips.length === 0) return bad('R10', 'aucune_photo');
    const sha = await planSha256(plan);
    if (input.planSha256 !== sha) return bad('R10', 'plan_perime');
    const d = input.durationSeconds;
    if (typeof d !== 'number' || !Number.isInteger(d) || d < 1 || d > plan.totalSeconds + 30) return bad('R10', 'duree_invalide');

    // La voix et l'avatar : ceux de l'agent du bien, lui-même, avec son accord écrit en cours, pour cet enregistrement.
    if (input.voice !== undefined && typeof input.voice !== 'boolean') return bad('R10', 'saisie_invalide');
    if (input.avatar !== undefined && typeof input.avatar !== 'boolean') return bad('R10', 'saisie_invalide');
    const voice = input.voice === true;
    const avatar = input.avatar === true;
    const used: Partial<Record<LikenessKind, string>> = {};
    for (const [kind, wanted, sample] of [['voix', voice, input.voiceSampleSha256], ['avatar', avatar, input.avatarSampleSha256]] as const) {
      if (!wanted) {
        if (sample !== undefined) return bad('R10', 'saisie_invalide');
        continue;
      }
      if (viewer.role !== 'agent' || seen.value.agentId !== viewer.userId) return bad('R495', 'pas_l_agent_lui_meme');
      const consent = await this.activeConsent(viewer.userId, kind);
      if (!consent) return bad('R495', 'sans_accord');
      if (sample !== consent.sample_sha256) return bad('R495', 'enregistrement_sans_accord');
      used[kind] = consent.id;
    }

    // Les mentions : « Vidéo générée », et celle de la voix ou de l'avatar quand il y en a, posées sur l'appareil [R496].
    const expected = [GENERATED_VIDEO_MENTION, ...[likenessMention(voice, avatar)].filter((m): m is string => m !== null)];
    const mentions = input.mentions;
    if (!Array.isArray(mentions) || mentions.length !== expected.length || !expected.every((m) => mentions.includes(m))) return bad('R496', 'mention_absente');

    // Les sous-titres : le français, puis chaque langue ouverte pour le bien, ligne pour ligne [R497].
    const subs = input.subtitles;
    if (!isRecord(subs)) return bad('R497', 'sous_titres_invalides');
    const open = ['fr', ...(await this.languages.languagesFor(seen.value.networkId, seen.value.agentId, propertyId))] as SubtitleLanguage[];
    const fr = subs.fr;
    const okLines = (v: unknown): v is string[] => Array.isArray(v) && v.length >= 1 && v.length <= MAX_SUBTITLE_LINES && v.every((s) => typeof s === 'string' && s.trim() !== '' && s.length <= MAX_SUBTITLE_CHARS);
    if (!okLines(fr)) return bad('R497', 'sous_titres_invalides');
    const translations = new Map<ListingLanguage, string[]>();
    for (const [language, lines] of Object.entries(subs)) {
      if (language === 'fr') continue;
      if (!open.includes(language as SubtitleLanguage)) return bad('R497', 'langue_non_ouverte');
      if (!okLines(lines)) return bad('R497', 'sous_titres_invalides');
      translations.set(language as ListingLanguage, lines);
    }
    if (typeof input.caption !== 'string') return bad('R10', 'saisie_invalide');
    if (await this.db.first('SELECT id FROM generated_videos WHERE property_id = ? AND video_ref = ?', [propertyId, input.videoRef])) return bad('R10', 'deja_rangee');
    // Le français et la légende : le contrôle de M07, qui refuse une adresse ou un mot interdit [R46].
    const checked = await this.texts.checkVideoText(viewer, propertyId, input.videoRef, { subtitles: fr, caption: input.caption });
    if (!checked.ok) {
      if (checked.rule === 'R46') return bad('R46', 'texte_refuse', checked.problems);
      if (checked.rule === 'R16') return { ok: false, rule: 'R16', code: checked.code };
      return bad('R10', checked.code === 'unknown_media' ? 'video_inconnue' : checked.code);
    }
    // Chaque langue : mêmes nombres, mêmes classes, aucune voie nommée ni mot interdit [R257, R46].
    const problems = checkSubtitleTranslations(fr, translations);
    if (problems.length > 0) return bad('R497', 'traduction_refusee', problems);

    const languages = open.filter((l) => l === 'fr' || translations.has(l as ListingLanguage));
    const at = this.now().toISOString();
    const { changes } = await this.db.run(
      `INSERT INTO generated_videos (id, network_id, property_id, video_ref, video_sha256, plan_sha256, clips_count, duration_s, mentions, languages, voice_consent_id, avatar_consent_id, processed_on, recorded_by, recorded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'appareil', ?, ?) ON CONFLICT DO NOTHING`,
      [this.newId(), seen.value.networkId, propertyId, input.videoRef, input.videoSha256, sha, plan.clips.length, d, JSON.stringify(expected), JSON.stringify(languages), used.voix ?? null, used.avatar ?? null, actor, at],
    );
    if (changes !== 1) return bad('R10', 'deja_rangee');
    await appendEvent(this.journal, { type: 'medias.video_generee.rangee', actor, subject: `property:${propertyId}`, data: { rule: 'R496', clips: plan.clips.length, languages, voice, avatar } }, this.now);
    return { ok: true, value: { propertyId, videoRef: input.videoRef, mentions: expected, languages, voice, avatar, recordedAt: at } };
  }

  /**
   * Une vidéo générée peut-elle être diffusée maintenant ? Seulement si elle suit encore le plan des photos du moment,
   * et si l'accord de voix ou d'avatar qu'elle utilise n'a pas été retiré et vient toujours de l'agent du bien en
   * activité [R495, R493]. Relu au moment d'envoyer.
   */
  async diffusable(propertyId: string, videoRef: string): Promise<Diffusability> {
    return generatedVideoDiffusable(this.db, this.photos, propertyId, videoRef);
  }

  private async activeConsent(agentId: string, kind: LikenessKind): Promise<{ id: string; sample_sha256: string } | null> {
    return (
      (await this.db.first<{ id: string; sample_sha256: string }>(
        `SELECT c.id, c.sample_sha256 FROM agent_likeness_consents c JOIN agents a ON a.id = c.agent_id AND a.network_id = c.network_id AND a.status = 'active'
         WHERE c.agent_id = ? AND c.kind = ? AND NOT EXISTS (SELECT 1 FROM agent_likeness_revocations r WHERE r.consent_id = c.id) ORDER BY c.given_at DESC, c.id DESC LIMIT 1`,
        [agentId, kind],
      )) ?? null
    );
  }

  private consentView(r: ConsentRow): LikenessConsent {
    return { id: r.id, kind: r.kind, sampleSha256: r.sample_sha256, textVersion: r.text_version, givenAt: r.given_at, revokedAt: r.revoked_at };
  }

  /** L'agent lui-même, en activité dans son réseau : personne d'autre ne donne ni ne retire son accord [R495]. */
  private async self(viewer: Viewer): Promise<VideoResult<{ first_name: string; last_name: string }>> {
    const agent =
      viewer.role === 'agent'
        ? await this.db.first<{ first_name: string; last_name: string }>("SELECT first_name, last_name FROM agents WHERE id = ? AND network_id = ? AND status = 'active'", [viewer.userId, viewer.networkId])
        : null;
    if (!agent) {
      await appendEvent(
        this.journal,
        { type: 'acces.refuse', actor: `${String(viewer.role)}:${viewer.userId}`, subject: `agent:${viewer.userId}`, data: { rule: 'R495', role: String(viewer.role), kind: 'likeness_consent', code: 'pas_l_agent_lui_meme' } },
        this.now,
      );
      return { ok: false, rule: 'R495', code: 'pas_l_agent_lui_meme' };
    }
    return { ok: true, value: agent };
  }

  private async full(viewer: Viewer, propertyId: string): Promise<VideoResult<{ networkId: string; agentId: string | null }>> {
    const read = await this.acces.readProperty(viewer, propertyId);
    if (!read.ok) return { ok: false, rule: 'R16', code: read.code };
    if (read.view !== 'full') return this.refused(viewer, propertyId, 'not_assigned');
    const row = await this.db.first<{ agent_id: string | null }>(
      `SELECT a.id AS agent_id FROM properties p LEFT JOIN agents a ON a.id = p.agent_id AND a.network_id = p.network_id AND a.status = 'active' WHERE p.id = ? AND p.network_id = ?`,
      [propertyId, read.value.network_id],
    );
    return { ok: true, value: { networkId: read.value.network_id, agentId: row?.agent_id ?? null } };
  }

  private async refused<T>(viewer: Viewer, propertyId: string, code: string): Promise<VideoResult<T>> {
    await appendEvent(
      this.journal,
      { type: 'acces.refuse', actor: `${String(viewer.role)}:${viewer.userId}`, subject: `property:${propertyId}`, data: { rule: 'R16', role: String(viewer.role), kind: 'generated_video', code } },
      this.now,
    );
    return { ok: false, rule: 'R16', code };
  }
}
