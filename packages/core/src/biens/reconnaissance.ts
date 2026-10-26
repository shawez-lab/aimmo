/**
 * Reconnaître le bien dont parle un message reçu (C03) : publication ou vidéo commentée, lien d'annonce,
 * référence de portail, référence citée dans le texte. Lecture prudente : sans correspondance sûre avec un seul
 * bien, aucun bien, jamais une supposition [R20].
 */
import type { SqlDatabase } from '../db/sql.ts';
import type { Property } from '../db/types.ts';

export type PropertyLinkKind = 'post' | 'url' | 'portal';

/** Ce que le message donne pour retrouver le bien. */
export interface PropertyClues {
  /** Publication ou vidéo commentée, identifiant chez le canal. */
  postRef?: string | null;
  /** Bien cité par le canal lui-même : référence ou page du formulaire du site. */
  propertyRef?: string | null;
  /** Portail d'où vient un mail de portail. */
  portal?: string | null;
  subject?: string | null;
  text?: string | null;
}

export type Recognition =
  | { status: 'recognized'; property: Property; via: Clue['via'][] }
  /**
   * `no_clue` : le message ne cite aucun bien ; `unknown` : il en cite un qu'on ne connaît pas ;
   * `ambiguous` : plusieurs biens possibles.
   */
  | { status: 'unrecognized'; rule: 'R20'; reason: 'no_clue' | 'unknown' | 'ambiguous' };

interface Clue {
  via: 'post' | 'property_ref' | 'url' | 'reference' | 'portal';
  /** Biens trouvés pour cet indice. */
  ids: string[];
}

export interface ReconnaissanceSettings {
  /** Adresses du site où une page d'annonce porte la référence du bien : `/biens/<référence>-…`. */
  siteHosts: readonly string[];
  listingPath: RegExp;
}

export const DEFAULT_RECONNAISSANCE_SETTINGS: ReconnaissanceSettings = Object.freeze({
  siteHosts: Object.freeze(['shawez-immo.com']),
  listingPath: /^\/biens\/([a-z0-9]+)(?:-[^/]*)?$/i,
});

const placeholders = (n: number): string => Array.from({ length: n }, () => '?').join(', ');

/** Adresse sans protocole, sans « www », sans paramètres ni ancre, sans barre finale, en minuscules. */
export function normalizeUrl(raw: string): string | null {
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw.trim()) ? raw.trim() : `https://${raw.trim()}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  if (!url.hostname.includes('.')) return null;
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  const path = decodeURI(url.pathname).replace(/\/+$/, '');
  return `${host}${path}`.toLowerCase();
}

const URLS = /\b(?:https?:\/\/|www\.)[^\s<>"'()]+|\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|fr|net|org|immo)\/[^\s<>"'()]*/gi;

/** Liens cités dans un texte, normalisés. */
export function urlsIn(text: string): string[] {
  return [...new Set((text.match(URLS) ?? []).map((u) => normalizeUrl(u.replace(/[.,;:!?]+$/, ''))).filter((u): u is string => u !== null))];
}

/**
 * Références citées après « réf », « ref » ou « référence » : un nombre seul dans un texte
 * est trop souvent un prix ou une surface pour valoir référence.
 */
export function referencesIn(text: string): string[] {
  const found = new Set<string>();
  const pattern = /\b(?:r[ée]f(?:[ée]rence)?s?)\b\.?\s*(?:n[°o]\.?\s*)?[:#-]?\s*([a-z0-9][a-z0-9_-]{1,30})/gi;
  for (const match of text.matchAll(pattern)) if (match[1]) found.add(match[1].toLowerCase());
  return [...found];
}

/** Clé d'un lien de portail : « <portail>:<référence> ». */
export const portalKey = (portal: string, reference: string): string => `${portal.toLowerCase()}:${reference.toLowerCase()}`;

export class ReconnaissanceBien {
  private readonly settings: ReconnaissanceSettings;

  constructor(
    private readonly db: SqlDatabase,
    settings: Partial<ReconnaissanceSettings> = {},
  ) {
    this.settings = { ...DEFAULT_RECONNAISSANCE_SETTINGS, ...settings };
  }

  /** Note qu'une publication, un lien ou une référence de portail désigne ce bien. Sans doublon. */
  async link(input: { networkId: string; propertyId: string; kind: PropertyLinkKind; value: string; at: Date; newId?: () => string }): Promise<void> {
    const value = this.linkValue(input.kind, input.value);
    if (value === null) throw new Error('Correspondance non valable.');
    await this.db.run(
      `INSERT INTO property_links (id, network_id, property_id, kind, value, created_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (network_id, kind, value, property_id) DO NOTHING`,
      [(input.newId ?? (() => crypto.randomUUID()))(), input.networkId, input.propertyId, input.kind, value, input.at.toISOString()],
    );
  }

  /** Retire une correspondance qui ne vaut plus, par une date ; la ligne reste [R17]. */
  async retire(input: { networkId: string; propertyId: string; kind: PropertyLinkKind; value: string; at: Date }): Promise<number> {
    const value = this.linkValue(input.kind, input.value);
    if (value === null) return 0;
    const { changes } = await this.db.run(
      'UPDATE property_links SET retired_at = ? WHERE network_id = ? AND property_id = ? AND kind = ? AND value = ? AND retired_at IS NULL',
      [input.at.toISOString(), input.networkId, input.propertyId, input.kind, value],
    );
    return changes;
  }

  async recognize(networkId: string, clues: PropertyClues): Promise<Recognition> {
    const found: Clue[] = [];
    const text = [clues.subject, clues.text].filter((t): t is string => typeof t === 'string').join('\n');

    if (clues.postRef) found.push({ via: 'post', ids: await this.byLink(networkId, 'post', [clues.postRef.trim()]) });

    if (clues.propertyRef) {
      const ref = clues.propertyRef.trim();
      const url = /[/.]/.test(ref) ? normalizeUrl(ref.startsWith('/') ? `${this.settings.siteHosts[0] ?? 'site.invalid'}${ref}` : ref) : null;
      const ids = url !== null ? await this.byUrl(networkId, url) : await this.byReference(networkId, [ref.toLowerCase()]);
      found.push({ via: 'property_ref', ids });
    }

    for (const url of urlsIn(text)) found.push({ via: 'url', ids: await this.byUrl(networkId, url) });

    const references = referencesIn(text);
    if (references.length > 0) {
      for (const reference of references) {
        const ids = [
          ...(await this.byReference(networkId, [reference])),
          ...(clues.portal ? await this.byLink(networkId, 'portal', [portalKey(clues.portal, reference)]) : []),
        ];
        found.push({ via: clues.portal ? 'portal' : 'reference', ids: [...new Set(ids)] });
      }
    }

    if (found.length === 0) return { status: 'unrecognized', rule: 'R20', reason: 'no_clue' };
    const all = new Set(found.flatMap((clue) => clue.ids));
    // Un indice qui désigne plusieurs biens, ou deux indices qui en désignent deux différents : aucun bien.
    if (found.some((clue) => clue.ids.length > 1) || all.size > 1) return { status: 'unrecognized', rule: 'R20', reason: 'ambiguous' };
    // Une référence citée qu'on ne connaît pas, à côté d'un bien reconnu : deux biens possibles, dans le doute.
    if (all.size === 1 && found.some((clue) => (clue.via === 'reference' || clue.via === 'portal') && clue.ids.length === 0)) {
      return { status: 'unrecognized', rule: 'R20', reason: 'ambiguous' };
    }
    const [id] = [...all];
    if (id === undefined) return { status: 'unrecognized', rule: 'R20', reason: 'unknown' };
    const property = await this.db.first<Property>('SELECT * FROM properties WHERE id = ? AND network_id = ?', [id, networkId]);
    if (!property) return { status: 'unrecognized', rule: 'R20', reason: 'unknown' };
    return { status: 'recognized', property, via: [...new Set(found.filter((c) => c.ids.length > 0).map((c) => c.via))] };
  }

  private linkValue(kind: PropertyLinkKind, raw: string): string | null {
    const trimmed = raw.trim();
    if (trimmed === '') return null;
    if (kind === 'url') return normalizeUrl(trimmed);
    if (kind === 'portal') return /^[a-z0-9_-]+:.+$/i.test(trimmed) ? trimmed.toLowerCase() : null;
    return trimmed;
  }

  private async byLink(networkId: string, kind: PropertyLinkKind, values: readonly string[]): Promise<string[]> {
    if (values.length === 0) return [];
    const rows = await this.db.all<{ property_id: string }>(
      `SELECT DISTINCT property_id FROM property_links
       WHERE network_id = ? AND kind = ? AND value IN (${placeholders(values.length)}) AND retired_at IS NULL`,
      [networkId, kind, ...values],
    );
    return rows.map((row) => row.property_id);
  }

  private async byReference(networkId: string, references: readonly string[]): Promise<string[]> {
    const rows = await this.db.all<{ id: string }>(
      `SELECT id FROM properties WHERE network_id = ? AND lower(reference) IN (${placeholders(references.length)})`,
      [networkId, ...references],
    );
    return rows.map((row) => row.id);
  }

  /** Un lien noté, ou une page d'annonce du site qui porte la référence du bien. */
  private async byUrl(networkId: string, url: string): Promise<string[]> {
    const ids = new Set(await this.byLink(networkId, 'url', [url]));
    const slash = url.indexOf('/');
    const host = slash === -1 ? url : url.slice(0, slash);
    const path = slash === -1 ? '' : url.slice(slash);
    const listing = this.settings.siteHosts.includes(host) ? this.settings.listingPath.exec(path) : null;
    if (listing?.[1]) for (const id of await this.byReference(networkId, [listing[1].toLowerCase()])) ids.add(id);
    return [...ids];
  }
}
