/**
 * Vidéos et épisodes du podcast, mesurés jusqu'à l'agent resté (HX64 ; M14, « Candidature » ; Feuille de route,
 * phase 4) [R620, R621, R622].
 *
 * La direction range chaque vidéo YouTube et chaque épisode du podcast qui sert au recrutement. Son titre et sa
 * description passent le contrôle des textes de recrutement [R80] ; sinon, rien n'est rangé. Chaque contenu reçoit
 * son code, tiré au hasard, porté par le lien vers la page de candidature : une candidature déposée avec ce code lui
 * est rattachée par `Candidatures.apply`, dans la même écriture [R621].
 *
 * Jamais vu : pour chaque contenu, le chemin entier lu dans la base, des candidatures aux entretiens tenus, aux « oui »,
 * aux entrées, aux agents encore là 90 jours après leur entrée et à ceux qui ont signé un mandat qui compte dans leurs
 * 90 premiers jours [R622]. Des nombres seulement : aucun nom, aucune coordonnée, aucune liste de personnes, aucun
 * classement de candidat ni d'agent [R81, R14]. Les contenus se lisent dans l'ordre de leur date, jamais classés.
 * La direction seule range, retire et lit ; la lecture est écrite au journal avant d'être rendue [R16].
 * Rien n'est envoyé ici, rien ne s'efface [R17].
 */
import type { Viewer } from '../acces/droits.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import { LIVE_REGISTERED_MANDATES } from '../pilotage/parcours.ts';
import { checkRecruitingText, type RecruitingReason } from './recrutement.ts';

/** La page de candidature du réseau (J12), servie par le socle sous ce chemin. */
export const CANDIDATURE_PAGE_PATH = '/rejoindre';

/** Le lien marqué d'un contenu : la page de candidature avec son code [R621]. */
export const contentLink = (code: string): string => `${CANDIDATURE_PAGE_PATH}?c=${encodeURIComponent(code)}`;

export const RECRUITING_CONTENT_KINDS = ['video', 'podcast'] as const;
export type RecruitingContentKind = (typeof RECRUITING_CONTENT_KINDS)[number];

/** Les seuls champs d'un contenu rangé par la direction. */
export const RECRUITING_CONTENT_FIELDS = ['kind', 'title', 'url', 'description', 'publishedOn'] as const;

/** Les hôtes d'une vidéo : YouTube seulement, comme le dit le cahier (« la chaîne YouTube »). */
export const VIDEO_HOSTS: readonly string[] = ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be'];

/** Le nombre de jours après l'entrée où l'on regarde si l'agent est resté et s'il a signé [R622]. */
export const RETENTION_DAYS = 90;

const CODE_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
const CODE_LENGTH = 12;

export type ContentRefusal =
  | { ok: false; rule: 'R16'; code: 'role' }
  | { ok: false; rule: 'R80'; code: 'promesse'; field: 'title' | 'description'; reasons: RecruitingReason[] }
  | { ok: false; rule: 'R620' | null; code: string };

export interface RecruitingContent {
  id: string;
  kind: RecruitingContentKind;
  title: string;
  url: string;
  description: string | null;
  publishedOn: string;
  code: string;
  /** Le chemin de la page de candidature avec le code, à coller sous la vidéo ou dans les notes de l'épisode. */
  link: string;
  withdrawnAt: string | null;
}

/** Ce que la page de recrutement montre : les contenus actifs, sans code ni auteur. */
export interface PublicRecruitingContent {
  kind: RecruitingContentKind;
  title: string;
  url: string;
  description: string | null;
  publishedOn: string;
}

/** Le chemin d'un contenu, en nombres seulement [R622]. */
export interface ContentFunnel {
  candidatures: number;
  /** Candidats dont au moins un entretien a été tenu. */
  interviewsHeld: number;
  /** Candidats dont la dernière décision est « oui ». */
  accepted: number;
  /** Agents entrés au réseau depuis une candidature de ce contenu. */
  entered: number;
  /** Entrés depuis 90 jours au moins : la base du « restés ». */
  enteredAtLeast90DaysAgo: number;
  /** Parmi eux, encore là au 90e jour. */
  stayed90Days: number;
  /** Entrés ayant signé un mandat qui compte dans leurs 90 premiers jours. */
  signedMandateWithin90Days: number;
}

export interface ContentReportLine {
  content: RecruitingContent;
  funnel: ContentFunnel;
}

export interface ContenusRecrutementOptions {
  now?: () => Date;
  newId?: () => string;
  newCode?: () => string;
}

interface ContentRow {
  id: string;
  kind: RecruitingContentKind;
  title: string;
  url: string;
  description: string | null;
  published_on: string;
  code: string;
  withdrawn_at: string | null;
}

const randomCode = (): string => {
  const bytes = new Uint8Array(CODE_LENGTH);
  crypto.getRandomValues(bytes);
  let out = '';
  for (const b of bytes) out += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return out;
};

const text = (v: unknown, min: number, max: number): string | null | undefined => {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string') return undefined;
  const t = v.trim().replace(/\s+/g, ' ');
  if (t === '') return null;
  return t.length < min || t.length > max ? undefined : t;
};

const isDay = (v: unknown): v is string => {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
};

/** Un lien `https` sans identifiants ; pour une vidéo, YouTube seulement [R620]. */
export function checkContentUrl(kind: RecruitingContentKind, value: unknown): string | null {
  if (typeof value !== 'string' || value.length < 12 || value.length > 500) return null;
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.port !== '') return null;
  const host = url.hostname.toLowerCase();
  if (!host.includes('.') || host === 'localhost' || /^[\d.]+$/.test(host) || host.startsWith('[')) return null;
  if (kind === 'video' && !VIDEO_HOSTS.includes(host)) return null;
  return url.toString();
}

const toContent = (r: ContentRow): RecruitingContent => ({
  id: r.id,
  kind: r.kind,
  title: r.title,
  url: r.url,
  description: r.description,
  publishedOn: r.published_on,
  code: r.code,
  link: contentLink(r.code),
  withdrawnAt: r.withdrawn_at,
});

const CONTENT_SELECT = `SELECT r.id, r.kind, r.title, r.url, r.description, r.published_on, r.code, w.withdrawn_at
  FROM recruiting_contents r LEFT JOIN recruiting_content_withdrawals w ON w.content_id = r.id`;

export class ContenusRecrutement {
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly newCode: () => string;

  constructor(
    private readonly db: SqlDatabase,
    private readonly journal: JournalStore,
    options: ContenusRecrutementOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => crypto.randomUUID());
    this.newCode = options.newCode ?? randomCode;
  }

  private actor(viewer: Viewer): string {
    return `${String(viewer.role)}:${viewer.userId}`;
  }

  /** La direction seule ; tout autre rôle est refusé et le refus écrit au journal [R16]. */
  private async direction(viewer: Viewer, kind: string): Promise<ContentRefusal | null> {
    if (viewer.role === 'direction') return null;
    await appendEvent(
      this.journal,
      { type: 'acces.refuse', actor: this.actor(viewer), subject: `network:${viewer.networkId}`, data: { rule: 'R16', role: String(viewer.role), kind, code: 'role' } },
      this.now,
    );
    return { ok: false, rule: 'R16', code: 'role' };
  }

  private async refuse(viewer: Viewer, refusal: ContentRefusal): Promise<ContentRefusal> {
    const data = 'reasons' in refusal ? { rule: refusal.rule, code: refusal.code, field: refusal.field, reasons: refusal.reasons } : { rule: refusal.rule, code: refusal.code };
    await appendEvent(this.journal, { type: 'recrutement.contenu_refuse', actor: this.actor(viewer), subject: `network:${viewer.networkId}`, data }, this.now);
    return refusal;
  }

  /** Range une vidéo ou un épisode du podcast, si son titre et sa description ne promettent aucun revenu [R620, R80]. */
  async create(viewer: Viewer, input: unknown): Promise<{ ok: true; value: RecruitingContent } | ContentRefusal> {
    const denied = await this.direction(viewer, 'recruiting_content');
    if (denied) return denied;
    if (input === null || typeof input !== 'object' || Array.isArray(input)) return this.refuse(viewer, { ok: false, rule: null, code: 'bad_shape' });
    const raw = input as Record<string, unknown>;
    if (Object.keys(raw).some((k) => !(RECRUITING_CONTENT_FIELDS as readonly string[]).includes(k))) return this.refuse(viewer, { ok: false, rule: null, code: 'unknown_field' });
    if (typeof raw.kind !== 'string' || !(RECRUITING_CONTENT_KINDS as readonly string[]).includes(raw.kind)) return this.refuse(viewer, { ok: false, rule: null, code: 'bad_kind' });
    const kind = raw.kind as RecruitingContentKind;
    const title = text(raw.title, 3, 140);
    if (!title) return this.refuse(viewer, { ok: false, rule: null, code: 'bad_title' });
    const description = text(raw.description, 1, 2000);
    if (description === undefined) return this.refuse(viewer, { ok: false, rule: null, code: 'bad_description' });
    const url = checkContentUrl(kind, raw.url);
    if (!url) return this.refuse(viewer, { ok: false, rule: 'R620', code: 'bad_url' });
    if (!isDay(raw.publishedOn)) return this.refuse(viewer, { ok: false, rule: null, code: 'bad_published_on' });

    // Aucune promesse de revenus, ni dans le titre ni dans la description [R80].
    for (const [field, value] of [['title', title], ['description', description]] as const) {
      if (value === null) continue;
      const check = checkRecruitingText(value);
      if (!check.ok) return this.refuse(viewer, { ok: false, rule: 'R80', code: 'promesse', field, reasons: check.reasons });
    }

    const id = this.newId();
    const code = this.newCode();
    const at = this.now().toISOString();
    await this.db.run(
      'INSERT INTO recruiting_contents (id, network_id, kind, title, url, description, published_on, code, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [id, viewer.networkId, kind, title, url, description, raw.publishedOn, code, this.actor(viewer), at],
    );
    await appendEvent(this.journal, { type: 'recrutement.contenu_range', actor: this.actor(viewer), subject: `network:${viewer.networkId}`, data: { contentId: id, kind } }, this.now);
    return { ok: true, value: toContent({ id, kind, title, url, description, published_on: raw.publishedOn, code, withdrawn_at: null }) };
  }

  /** Retire un contenu : son lien ne rattache plus rien ; il reste au compte rendu [R620, R621, R17]. */
  async withdraw(viewer: Viewer, contentId: unknown): Promise<{ ok: true; value: { withdrawnAt: string } } | ContentRefusal> {
    const denied = await this.direction(viewer, 'recruiting_content');
    if (denied) return denied;
    if (typeof contentId !== 'string' || contentId.length > 64) return this.refuse(viewer, { ok: false, rule: null, code: 'not_found' });
    const row = await this.db.first<{ id: string }>('SELECT id FROM recruiting_contents WHERE id = ? AND network_id = ?', [contentId, viewer.networkId]);
    if (!row) return this.refuse(viewer, { ok: false, rule: null, code: 'not_found' });
    const at = this.now().toISOString();
    const { changes } = await this.db.run(
      'INSERT INTO recruiting_content_withdrawals (content_id, network_id, withdrawn_by, withdrawn_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING',
      [contentId, viewer.networkId, this.actor(viewer), at],
    );
    if (changes !== 1) return this.refuse(viewer, { ok: false, rule: 'R620', code: 'deja_retire' });
    await appendEvent(this.journal, { type: 'recrutement.contenu_retire', actor: this.actor(viewer), subject: `network:${viewer.networkId}`, data: { contentId } }, this.now);
    return { ok: true, value: { withdrawnAt: at } };
  }

  /** Les contenus actifs d'un réseau pour la page de recrutement : ni code, ni auteur, dans l'ordre de leur date. */
  async listPublic(networkId: string): Promise<PublicRecruitingContent[]> {
    const rows = await this.db.all<ContentRow>(`${CONTENT_SELECT} WHERE r.network_id = ? AND w.content_id IS NULL ORDER BY r.published_on DESC, r.id`, [networkId]);
    return rows.map((r) => ({ kind: r.kind, title: r.title, url: r.url, description: r.description, publishedOn: r.published_on }));
  }

  /**
   * Le compte rendu de chaque contenu, du lien à l'agent resté, pour la direction seule [R622, R16]. Les contenus
   * se lisent dans l'ordre de leur date, retirés compris ; aucun nom ni aucune liste de personnes.
   */
  async report(viewer: Viewer): Promise<{ ok: true; value: ContentReportLine[] } | ContentRefusal> {
    const denied = await this.direction(viewer, 'recruiting_report');
    if (denied) return denied;
    const net = viewer.networkId;
    const nowIso = this.now().toISOString();
    const cutoff = new Date(this.now().getTime() - RETENTION_DAYS * 86_400_000).toISOString();
    const days = `+${RETENTION_DAYS} days`;
    const rows = await this.db.all<ContentRow & { [K in keyof ContentFunnel]: number | null }>(
      `WITH origin AS (
         SELECT o.content_id, o.candidate_id FROM candidate_content_origins o JOIN candidates c ON c.id = o.candidate_id AND c.network_id = o.network_id
          WHERE o.network_id = ?
       ),
       latest AS (
         SELECT d.candidate_id, d.decision FROM candidate_decisions d
          WHERE d.network_id = ? AND NOT EXISTS (
            SELECT 1 FROM candidate_decisions e WHERE e.candidate_id = d.candidate_id AND (e.decided_at > d.decided_at OR (e.decided_at = d.decided_at AND e.id > d.id)))
       ),
       entry AS (
         SELECT origin.content_id, a.id AS agent_id, a.status, ob.created_at AS entered_at,
                strftime('%Y-%m-%dT%H:%M:%fZ', ob.created_at, ?) AS day90_at,
                date(ob.created_at, ?) AS day90
           FROM origin JOIN agent_onboardings ob ON ob.candidate_id = origin.candidate_id AND ob.network_id = ?
           JOIN agents a ON a.id = ob.agent_id AND a.network_id = ob.network_id
          WHERE ob.created_at <= ?
       )
       SELECT r.id, r.kind, r.title, r.url, r.description, r.published_on, r.code, w.withdrawn_at,
         (SELECT COUNT(*) FROM origin WHERE origin.content_id = r.id) AS candidatures,
         (SELECT COUNT(DISTINCT origin.candidate_id) FROM origin JOIN candidate_interviews i ON i.candidate_id = origin.candidate_id
            JOIN candidate_interview_outcomes x ON x.interview_id = i.id WHERE origin.content_id = r.id) AS interviewsHeld,
         (SELECT COUNT(*) FROM origin JOIN latest ON latest.candidate_id = origin.candidate_id WHERE origin.content_id = r.id AND latest.decision = 'oui') AS accepted,
         (SELECT COUNT(*) FROM entry WHERE entry.content_id = r.id) AS entered,
         (SELECT COUNT(*) FROM entry WHERE entry.content_id = r.id AND entry.entered_at <= ?) AS enteredAtLeast90DaysAgo,
         (SELECT COUNT(*) FROM entry WHERE entry.content_id = r.id AND entry.entered_at <= ?
            AND NOT EXISTS (SELECT 1 FROM agent_departures d WHERE d.agent_id = entry.agent_id AND d.cancelled_at IS NULL AND d.leaves_on <= entry.day90)
            AND (entry.status = 'active' OR EXISTS (SELECT 1 FROM agent_departures d WHERE d.agent_id = entry.agent_id AND d.cancelled_at IS NULL AND d.leaves_on > entry.day90))) AS stayed90Days,
         (SELECT COUNT(*) FROM entry WHERE entry.content_id = r.id
            AND EXISTS (SELECT 1 FROM (${LIVE_REGISTERED_MANDATES}) m WHERE m.network_id = ? AND m.agent_id = entry.agent_id
                         AND m.signed_at >= entry.entered_at AND m.signed_at < entry.day90_at AND m.signed_at <= ?)) AS signedMandateWithin90Days
         FROM recruiting_contents r LEFT JOIN recruiting_content_withdrawals w ON w.content_id = r.id
        WHERE r.network_id = ?
        ORDER BY r.published_on, r.id`,
      [net, net, days, days, net, nowIso, cutoff, cutoff, net, nowIso, net],
    );
    // La lecture est écrite au journal avant que le compte rendu soit rendu [R16].
    await appendEvent(this.journal, { type: 'recrutement.contenus_lus', actor: this.actor(viewer), subject: `network:${net}`, data: { rule: 'R16', count: rows.length } }, this.now);
    const n = (v: number | null): number => Number(v ?? 0);
    return {
      ok: true,
      value: rows.map((r) => ({
        content: toContent(r),
        funnel: {
          candidatures: n(r.candidatures),
          interviewsHeld: n(r.interviewsHeld),
          accepted: n(r.accepted),
          entered: n(r.entered),
          enteredAtLeast90DaysAgo: n(r.enteredAtLeast90DaysAgo),
          stayed90Days: n(r.stayed90Days),
          signedMandateWithin90Days: n(r.signedMandateWithin90Days),
        },
      })),
    };
  }
}
