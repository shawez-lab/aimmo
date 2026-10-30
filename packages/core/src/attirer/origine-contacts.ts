/**
 * L'origine des contacts (M01, AT05) [R156, R16].
 *
 * Chaque contenu public (page de bien, page de prix, page d'agent, page de quartier, simulateur, vidéo, publication,
 * annonce sur un portail) a un identifiant court, tiré au hasard, que ses liens portent : `?o=<code>`. Quand un contact
 * arrive, l'origine est lue dans cet ordre, et la première trouvée compte :
 *
 * 1. `lien` : le code porté par le lien d'arrivée, s'il est connu du réseau ;
 * 2. `page` : la page de départ, quand elle est une page publique d'un site en service du réseau ;
 * 3. `publication` : la publication ou la vidéo commentée ou citée sur un réseau social, quand elle est connue ;
 * 4. `portail` : le portail qui a transmis la demande ;
 * 5. sinon `inconnue`. Rien n'est jamais deviné : un code inconnu, une page d'un autre site, un chemin qui ne vise aucun
 *    contenu du réseau ne donnent rien.
 *
 * Rien d'autre n'est gardé que le contenu, sa sorte et la façon dont l'origine a été lue, en listes fermées : ni adresse
 * de page, ni paramètre de suivi, ni cookie, ni identifiant de navigateur, ni donnée personnelle [R156].
 *
 * La mesure mensuelle compte, depuis la base, les contacts (une conversation, comptée le mois de son premier message)
 * dont l'origine est renseignée ; la cible est 95 %. Elle est réservée à la direction [R16].
 *
 * Le branchement dans la chaîne de captation est fait par AT10 (voie 1) : ce module ne touche à aucun fichier du socle.
 */
import type { Viewer } from '../acces/droits.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import { parisDayStart } from '../pilotage/tableau-agent.ts';
import { Referencement } from './referencement.ts';

export const CONTENT_KINDS = ['bien', 'prix', 'agent', 'video', 'publication', 'quartier', 'simulateur', 'portail'] as const;
export type ContentKind = (typeof CONTENT_KINDS)[number];
export type OriginKind = ContentKind | 'inconnue';
export const ORIGIN_METHODS = ['lien', 'page', 'publication', 'portail', 'inconnue'] as const;
export type OriginMethod = (typeof ORIGIN_METHODS)[number];
export const POST_CHANNELS = ['instagram', 'facebook', 'whatsapp'] as const;
export type PostChannel = (typeof POST_CHANNELS)[number];

/** Le nom du paramètre porteur, dans les liens des contenus publics. */
export const CARRIER_PARAM = 'o';
/** La part visée de contacts avec une origine renseignée, en pour cent (cahier, M01). */
export const ORIGIN_TARGET_PERCENT = 95;

const CODE = /^[a-z2-7]{12}$/;
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const PORTAL = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;
const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

/** Un code de 12 caractères en base 32, tiré au hasard : il ne dit rien du contenu qu'il désigne. */
export function randomContentCode(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => BASE32[b & 31]).join('');
}

export interface Origin {
  contentId: string | null;
  kind: OriginKind;
  method: OriginMethod;
}

/** Ce que la page de captation transmet, et rien d'autre : le lien d'arrivée et la page de départ. */
export interface OriginSignals {
  link?: unknown;
  landingPage?: unknown;
}

export type ContentResult = { ok: true; contentId: string } | { ok: false; code: 'bad_kind' | 'bad_ref' | 'unknown_ref' };

export type RecordResult = { ok: true; origin: Origin; already: boolean } | { ok: false; code: 'unknown_inbound' };

export interface OriginMeasure {
  month: string;
  /** Contacts du mois : conversations dont le premier message est arrivé ce mois-là, heure de Paris. */
  contacts: number;
  /** Contacts dont l'origine est un contenu connu. */
  withOrigin: number;
  /** La part, en dixièmes de pour cent arrondis vers le bas. */
  percent: number;
  targetPercent: number;
  meetsTarget: boolean;
  byKind: { kind: OriginKind; contacts: number }[];
  /** Les contenus précis qui ont amené des contacts, du plus au moins fourni. */
  byContent: { contentId: string; kind: ContentKind; ref: string; contacts: number }[];
}

export type MeasureResult = { ok: true; measure: OriginMeasure } | { ok: false; rule: 'R16' | null; code: string };

export interface OrigineOptions {
  now?: () => Date;
  newId?: () => string;
  newCode?: () => string;
  targetPercent?: number;
}

interface InboundOriginRow {
  id: string;
  network_id: string;
  channel: string;
  kind: string;
  post_ref: string | null;
  portal: string | null;
}

/** L'adresse donnée, seulement si c'est une adresse https lisible ; rien d'autre n'en sera gardé. */
function parseUrl(value: unknown): URL | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2000) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.username === '' && url.password === '' ? url : null;
  } catch {
    return null;
  }
}

/** Le contenu public que vise un chemin d'un site du réseau, en liste fermée ; `null` pour tout autre chemin. */
export function contentOfPath(pathname: string): { kind: ContentKind; ref: string } | null {
  const path = pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
  const parts = path.split('/').slice(1);
  let decoded: string[];
  try {
    decoded = parts.map((p) => decodeURIComponent(p));
  } catch {
    return null;
  }
  const [head, a, b] = decoded;
  if (head === 'biens' && decoded.length === 2 && ID.test(a!)) return { kind: 'bien', ref: a! };
  if (head === 'agents' && decoded.length === 2 && ID.test(a!)) return { kind: 'agent', ref: a! };
  if (head === 'prix' && decoded.length === 2 && SLUG.test(a!)) return { kind: 'prix', ref: a! };
  if (head === 'prix' && decoded.length === 3 && SLUG.test(a!) && SLUG.test(b!)) return { kind: 'prix', ref: `${a}/${b}` };
  if (head === 'quartiers' && decoded.length === 3 && SLUG.test(a!) && SLUG.test(b!)) return { kind: 'quartier', ref: `${a}/${b}` };
  if (head === 'simulateur' && decoded.length === 1) return { kind: 'simulateur', ref: 'simulateur' };
  return null;
}

/** Le lien d'un contenu, avec son code porteur ; tout autre paramètre est gardé tel quel. */
export function taggedLink(url: string, contentId: string): string | null {
  const u = parseUrl(url);
  if (!u || !CODE.test(contentId)) return null;
  u.searchParams.set(CARRIER_PARAM, contentId);
  return u.toString();
}

/** Le premier instant d'un mois de Paris, en ISO. */
function monthStart(year: number, month: number): string {
  const y = month > 12 ? year + 1 : year;
  const m = month > 12 ? 1 : month;
  return parisDayStart(`${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-01`).toISOString();
}

export class OrigineContacts {
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly newCode: () => string;
  private readonly targetPercent: number;
  private readonly referencement: Referencement;

  constructor(
    private readonly db: SqlDatabase,
    private readonly journal: JournalStore,
    options: OrigineOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => crypto.randomUUID());
    this.newCode = options.newCode ?? randomContentCode;
    this.targetPercent = options.targetPercent ?? ORIGIN_TARGET_PERCENT;
    this.referencement = new Referencement(db, journal, { now: this.now });
  }

  /**
   * L'identifiant d'un contenu public du réseau, créé à sa première demande, puis toujours le même. Un bien ou un agent
   * doit être du réseau ; un chemin de prix ou de quartier, une publication, un portail suivent leur forme.
   */
  async contentFor(networkId: string, kind: unknown, ref: unknown): Promise<ContentResult> {
    if (typeof kind !== 'string' || !(CONTENT_KINDS as readonly string[]).includes(kind)) return { ok: false, code: 'bad_kind' };
    if (typeof ref !== 'string' || !this.validRef(kind as ContentKind, ref)) return { ok: false, code: 'bad_ref' };
    if (kind === 'bien' && !(await this.db.first('SELECT id FROM properties WHERE id = ? AND network_id = ?', [ref, networkId]))) return { ok: false, code: 'unknown_ref' };
    if (kind === 'agent' && !(await this.db.first('SELECT id FROM agents WHERE id = ? AND network_id = ?', [ref, networkId]))) return { ok: false, code: 'unknown_ref' };
    const existing = await this.db.first<{ id: string }>('SELECT id FROM public_contents WHERE network_id = ? AND kind = ? AND ref = ?', [networkId, kind, ref]);
    if (existing) return { ok: true, contentId: existing.id };
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const code = this.newCode();
      if (!CODE.test(code)) throw new Error('Code de contenu invalide.');
      // Le même contenu demandé deux fois en même temps : l'index unique garde le premier.
      await this.db.run('INSERT OR IGNORE INTO public_contents (id, network_id, kind, ref, created_at) VALUES (?, ?, ?, ?, ?)', [code, networkId, kind, ref, this.now().toISOString()]);
      const row = await this.db.first<{ id: string }>('SELECT id FROM public_contents WHERE network_id = ? AND kind = ? AND ref = ?', [networkId, kind, ref]);
      if (row) return { ok: true, contentId: row.id };
    }
    throw new Error('Code de contenu introuvable après trois essais.');
  }

  private validRef(kind: ContentKind, ref: string): boolean {
    switch (kind) {
      case 'bien':
      case 'agent':
      case 'video':
      case 'publication':
        return ID.test(ref);
      case 'prix':
        return ref.split('/').length <= 2 && ref.split('/').every((s) => SLUG.test(s));
      case 'quartier':
        return ref.split('/').length === 2 && ref.split('/').every((s) => SLUG.test(s));
      case 'simulateur':
        return ref === 'simulateur';
      case 'portail':
        return ref.length <= 40 && PORTAL.test(ref);
    }
  }

  /** Relie une vidéo ou une publication du réseau à sa référence chez un réseau social. La première liaison compte. */
  async linkPost(networkId: string, contentId: string, channel: unknown, postRef: unknown): Promise<{ ok: boolean; code?: string }> {
    if (typeof channel !== 'string' || !(POST_CHANNELS as readonly string[]).includes(channel)) return { ok: false, code: 'bad_channel' };
    if (typeof postRef !== 'string' || postRef.length < 1 || postRef.length > 200) return { ok: false, code: 'bad_post' };
    const content = await this.db.first<{ kind: string }>('SELECT kind FROM public_contents WHERE id = ? AND network_id = ?', [contentId, networkId]);
    if (!content) return { ok: false, code: 'unknown_content' };
    if (content.kind !== 'video' && content.kind !== 'publication') return { ok: false, code: 'not_a_post' };
    await this.db.run('INSERT OR IGNORE INTO public_content_posts (network_id, channel, post_ref, content_id, created_at) VALUES (?, ?, ?, ?, ?)', [
      networkId,
      channel,
      postRef,
      contentId,
      this.now().toISOString(),
    ]);
    const row = await this.db.first<{ content_id: string }>('SELECT content_id FROM public_content_posts WHERE network_id = ? AND channel = ? AND post_ref = ?', [networkId, channel, postRef]);
    return row?.content_id === contentId ? { ok: true } : { ok: false, code: 'post_taken' };
  }

  private async knownContent(networkId: string, code: string): Promise<{ id: string; kind: ContentKind } | null> {
    if (!CODE.test(code)) return null;
    return (await this.db.first<{ id: string; kind: ContentKind }>('SELECT id, kind FROM public_contents WHERE id = ? AND network_id = ?', [code, networkId])) ?? null;
  }

  /** Lit l'origine d'un message reçu, sans rien écrire. */
  async read(row: InboundOriginRow, signals: OriginSignals): Promise<Origin> {
    const networkId = row.network_id;
    const link = parseUrl(signals.link);
    const landing = parseUrl(signals.landingPage);
    // 1. Le code porteur : un seul paramètre `o`, connu du réseau. Plusieurs codes, c'est un doute : rien n'est choisi.
    for (const url of [link, landing]) {
      if (!url) continue;
      const codes = url.searchParams.getAll(CARRIER_PARAM);
      if (codes.length !== 1) continue;
      const content = await this.knownContent(networkId, codes[0]!);
      if (content) return { contentId: content.id, kind: content.kind, method: 'lien' };
    }
    // 2. La page de départ, seulement sur un site en service du réseau.
    if (landing) {
      const sites = await this.referencement.sites(networkId);
      if (sites.some((s) => s.baseUrl === landing.origin)) {
        const target = contentOfPath(landing.pathname);
        if (target) {
          const content = await this.contentFor(networkId, target.kind, target.ref);
          if (content.ok) return { contentId: content.contentId, kind: target.kind, method: 'page' };
        }
      }
    }
    // 3. La publication commentée ou citée sur un réseau social, quand elle est connue.
    if (row.post_ref && (POST_CHANNELS as readonly string[]).includes(row.channel)) {
      const post = await this.db.first<{ id: string; kind: ContentKind }>(
        'SELECT c.id, c.kind FROM public_content_posts p JOIN public_contents c ON c.id = p.content_id WHERE p.network_id = ? AND p.channel = ? AND p.post_ref = ?',
        [networkId, row.channel, row.post_ref],
      );
      if (post) return { contentId: post.id, kind: post.kind, method: 'publication' };
    }
    // 4. Le portail qui a transmis la demande.
    if (row.kind === 'portal_email' && row.portal) {
      const content = await this.contentFor(networkId, 'portail', row.portal.toLowerCase());
      if (content.ok) return { contentId: content.contentId, kind: 'portail', method: 'portail' };
    }
    return { contentId: null, kind: 'inconnue', method: 'inconnue' };
  }

  /**
   * Range l'origine d'un message reçu, une seule fois : la première lecture compte, une seconde ne change rien.
   * Seuls le contenu, sa sorte et la façon de la lire sont gardés [R156].
   */
  async record(networkId: string, inboundId: string, signals: OriginSignals = {}): Promise<RecordResult> {
    const row = await this.db.first<InboundOriginRow>('SELECT id, network_id, channel, kind, post_ref, portal FROM inbound_messages WHERE id = ? AND network_id = ?', [inboundId, networkId]);
    if (!row) return { ok: false, code: 'unknown_inbound' };
    const existing = await this.stored(inboundId);
    if (existing) return { ok: true, origin: existing, already: true };
    const origin = await this.read(row, signals);
    const inserted = await this.db.run('INSERT OR IGNORE INTO contact_origins (id, network_id, inbound_id, content_id, content_kind, method, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [
      this.newId(),
      networkId,
      inboundId,
      origin.contentId,
      origin.kind,
      origin.method,
      this.now().toISOString(),
    ]);
    const kept = (await this.stored(inboundId))!;
    // Une autre lecture du même message, en même temps, a pu ranger la sienne d'abord : c'est elle qui compte.
    const already = inserted.changes === 0;
    if (!already) {
      await appendEvent(this.journal, { type: 'attirer.origine', actor: 'system', subject: `inbound:${inboundId}`, data: { rule: 'R156', kind: origin.kind, method: origin.method } }, this.now);
    }
    return { ok: true, origin: kept, already };
  }

  /** L'origine rangée d'un message reçu, s'il y en a une. */
  async stored(inboundId: string): Promise<Origin | null> {
    const r = await this.db.first<{ content_id: string | null; content_kind: OriginKind; method: OriginMethod }>('SELECT content_id, content_kind, method FROM contact_origins WHERE inbound_id = ?', [inboundId]);
    return r ? { contentId: r.content_id, kind: r.content_kind, method: r.method } : null;
  }

  /**
   * La mesure d'un mois (`AAAA-MM`, heure de Paris), comptée depuis la base : un contact est une conversation, comptée le
   * mois de son premier message lisible ; elle a une origine quand l'un de ses messages a un contenu connu, et c'est le
   * premier de ceux-là qui la classe. Réservée à la direction [R16].
   */
  async measure(viewer: Viewer, month: unknown): Promise<MeasureResult> {
    const actor = `${String(viewer.role)}:${viewer.userId}`;
    if (viewer.role !== 'direction') {
      await appendEvent(this.journal, { type: 'acces.refuse', actor, subject: null, data: { rule: 'R16', kind: 'origine_mesure', code: 'role' } }, this.now);
      return { ok: false, rule: 'R16', code: 'role' };
    }
    const m = typeof month === 'string' ? MONTH.exec(month) : null;
    if (!m) return { ok: false, rule: null, code: 'bad_month' };
    const year = Number(m[1]);
    const mon = Number(m[2]);
    const from = monthStart(year, mon);
    const to = monthStart(year, mon + 1);
    const rows = await this.db.all<{ first_at: string; known: string | null }>(
      `SELECT min(m.received_at) AS first_at,
              min(CASE WHEN o.content_id IS NOT NULL THEN m.received_at || '|' || m.id || '|' || o.content_id END) AS known
         FROM inbound_messages m LEFT JOIN contact_origins o ON o.inbound_id = m.id
        WHERE m.network_id = ? AND m.status <> 'unreadable' AND m.kind <> 'unreadable'
        GROUP BY m.channel, coalesce(m.conversation_ref, m.kind || ':' || m.external_id, m.id)
       HAVING min(m.received_at) >= ? AND min(m.received_at) < ?`,
      [viewer.networkId, from, to],
    );
    const counts = new Map<string, number>();
    let withOrigin = 0;
    for (const r of rows) {
      if (!r.known) continue;
      withOrigin += 1;
      const contentId = r.known.slice(r.known.lastIndexOf('|') + 1);
      counts.set(contentId, (counts.get(contentId) ?? 0) + 1);
    }
    const byContent: OriginMeasure['byContent'] = [];
    for (const [contentId, n] of counts) {
      const c = await this.db.first<{ kind: ContentKind; ref: string }>('SELECT kind, ref FROM public_contents WHERE id = ? AND network_id = ?', [contentId, viewer.networkId]);
      if (c) byContent.push({ contentId, kind: c.kind, ref: c.ref, contacts: n });
    }
    byContent.sort((a, b) => b.contacts - a.contacts || a.kind.localeCompare(b.kind) || a.ref.localeCompare(b.ref));
    const kinds = new Map<OriginKind, number>();
    for (const c of byContent) kinds.set(c.kind, (kinds.get(c.kind) ?? 0) + c.contacts);
    const unknown = rows.length - withOrigin;
    if (unknown > 0) kinds.set('inconnue', unknown);
    const byKind = [...kinds].map(([kind, contacts]) => ({ kind, contacts })).sort((a, b) => b.contacts - a.contacts || a.kind.localeCompare(b.kind));
    const contacts = rows.length;
    return {
      ok: true,
      measure: {
        month: month as string,
        contacts,
        withOrigin,
        percent: contacts === 0 ? 0 : Math.floor((withOrigin * 1000) / contacts) / 10,
        targetPercent: this.targetPercent,
        meetsTarget: contacts > 0 && withOrigin * 100 >= this.targetPercent * contacts,
        byKind,
        byContent,
      },
    };
  }
}
