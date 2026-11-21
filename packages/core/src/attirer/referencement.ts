/**
 * Le référencement des deux sites (M01, AT04) [R153, R26, R46, R16].
 *
 * Deux sites, un seul moteur : le site du réseau montre tous les biens publiés ; le site d'un agent, quand il en a un,
 * montre les siens. Les deux lisent la même base. Pour les moteurs, un bien n'a qu'une seule page de référence : celle
 * du site de son agent s'il en a un en service, sinon celle du réseau [R153]. Le plan de chaque site ne liste que des
 * pages publiées, chacune par sa page de référence : un bien test apparaît dans les deux plans, sous la même adresse.
 * Aucune page de référence ne vise une page non publiée : un brouillon, un bien vendu ou retiré n'en a pas.
 *
 * Les données structurées d'un bien et d'un agent ne portent que ce que la page publique montre déjà : titre, prix,
 * état, commune, nom de l'agent ; jamais d'adresse, de numéro de voie ni de code postal [R46].
 *
 * Chaque page publiée, modifiée ou retirée est signalée aux moteurs (IndexNow) derrière une interface. En mode essai,
 * rien ne part : la ligne est rangée « essai » [R26]. Une page déjà signalée dans le même état ne l'est pas de nouveau ;
 * un échec est rangé, puis signalé de nouveau au passage suivant.
 *
 * La grille d'un programme neuf n'a qu'une page de référence, sur le site du réseau ; elle n'est donnée aux moteurs que
 * tant qu'elle a au moins un lot publié, et signalée modifiée dès que sa grille publiée change (BR77) [R153, R543].
 */
import type { Viewer } from '../acces/droits.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import { sitePaths } from './accueil-site.ts';
import { LEGAL_PATHS, MentionsSite, siteReady } from './mentions-site.ts';
import { PageAgent } from './page-agent.ts';
import { ProgrammesNeufs } from '../neuf-viager/neuf.ts';

export const SITE_KINDS = ['reseau', 'agent'] as const;
export type SiteKind = (typeof SITE_KINDS)[number];
export type SeoMode = 'essai' | 'reel';
export type SeoChange = 'publiee' | 'modifiee' | 'retiree';

/** Une origine https, sans chemin, sans identifiants, sans port exotique. */
const ORIGIN = /^https:\/\/(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/;
const ID = /^[A-Za-z0-9_-]{1,64}$/;

export interface PublicSite {
  siteId: string;
  kind: SiteKind;
  agentId: string | null;
  baseUrl: string;
}

export interface SitemapEntry {
  /** La page de référence : la seule adresse donnée aux moteurs. */
  loc: string;
  /** Le jour de la dernière version publiée, `AAAA-MM-JJ`, quand il est connu. */
  lastmod: string | null;
  kind: 'page' | 'bien' | 'agent' | 'prix' | 'neuf';
}

/** Le service des moteurs (IndexNow) : un appel par hôte, avec ses adresses. Un faux service dans les tests. */
export interface IndexNowClient {
  submit(host: string, urls: readonly string[]): Promise<void>;
}

export interface ReferencementOptions {
  now?: () => Date;
  newId?: () => string;
  /** Le service réel ; absent, rien ne peut partir. */
  indexNow?: IndexNowClient | null;
  /** `essai` par défaut : rien ne part tant que le plan ne l'a pas mis en service [R26]. */
  mode?: SeoMode;
  /** Le réseau qui reçoit les candidatures de `/rejoindre` : son seul site y mène et la met à son plan. */
  recruitingNetworkId?: string | null;
}

export type SiteResult = { ok: true; siteId: string } | { ok: false; rule: 'R16' | 'R153' | null; code: string };

interface PublishedRow {
  property_id: string;
  property_status: string;
  agent_id: string | null;
  city: string | null;
  state: 'en_vente' | 'sous_offre';
  version_id: string;
  created_at: string;
  payload: string;
}

export interface PublicCommune {
  slug: string;
  name: string;
}

export interface PublishedListing {
  propertyId: string;
  agentId: string | null;
  city: string | null;
  state: 'en_vente' | 'sous_offre';
  versionId: string;
  title: string;
  priceEur: number;
  day: string | null;
  /** Les mentions de la version publiée [R43]. */
  mentions: string;
  /** La première photo publiée, et sa mention d'aménagement virtuel [R48]. */
  photo: { ref: string; overlay: string | null } | null;
  /** L'état du bien dans le socle, qui peut avoir changé depuis la version publiée. */
  propertyStatus: string;
}

/** L'empreinte SHA-256 d'un texte, en hexadécimal. */
async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const xml = (t: string): string => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
const dayOf = (iso: string): string | null => (/^\d{4}-\d{2}-\d{2}T/.test(iso) ? iso.slice(0, 10) : null);

/** Un JSON sûr dans une balise `<script type="application/ld+json">` : aucun `<`, `>` ni `&` ne peut fermer la balise. */
export function jsonLd(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

/**
 * Les données structurées d'un bien publié : titre, prix, état, commune, page de référence et agent. Rien qui situe le
 * bien plus finement que sa commune : ni voie, ni numéro, ni code postal [R46].
 */
export function listingStructuredData(input: { canonical: string; title: string; priceEur: number; state: 'en_vente' | 'sous_offre'; city: string | null; agentName: string | null }): string {
  const data: Record<string, unknown> = {
    '@context': 'https://schema.org',
    '@type': 'RealEstateListing',
    name: input.title,
    url: input.canonical,
    offers: {
      '@type': 'Offer',
      price: input.priceEur,
      priceCurrency: 'EUR',
      availability: input.state === 'en_vente' ? 'https://schema.org/InStock' : 'https://schema.org/LimitedAvailability',
    },
  };
  if (input.city) data.contentLocation = { '@type': 'Place', address: { '@type': 'PostalAddress', addressLocality: input.city, addressCountry: 'FR' } };
  if (input.agentName) data.provider = { '@type': 'RealEstateAgent', name: input.agentName };
  return jsonLd(data);
}

/** Les données structurées de la page d'un agent : son nom, son métier, sa zone, sa page ; rien d'autre. */
export function agentStructuredData(input: { url: string; firstName: string; lastName: string; zone: string | null }): string {
  const data: Record<string, unknown> = { '@context': 'https://schema.org', '@type': 'RealEstateAgent', name: `${input.firstName} ${input.lastName}`, jobTitle: 'Agent immobilier', url: input.url };
  if (input.zone) data.areaServed = input.zone;
  return jsonLd(data);
}

/** Le plan d'un site au format des moteurs (sitemaps.org), chaque adresse échappée. */
export function renderSitemap(entries: readonly SitemapEntry[]): string {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    entries.map((e) => `<url><loc>${xml(e.loc)}</loc>${e.lastmod ? `<lastmod>${e.lastmod}</lastmod>` : ''}</url>\n`).join('') +
    '</urlset>\n'
  );
}

export class Referencement {
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly indexNow: IndexNowClient | null;
  private readonly mode: SeoMode;
  private readonly recruitingNetworkId: string | null;

  constructor(
    private readonly db: SqlDatabase,
    private readonly journal: JournalStore,
    options: ReferencementOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => crypto.randomUUID());
    this.indexNow = options.indexNow ?? null;
    this.recruitingNetworkId = options.recruitingNetworkId ?? null;
    // Le mode réel exige un service réel : sans lui, on reste en essai.
    this.mode = options.mode === 'reel' && this.indexNow ? 'reel' : 'essai';
  }

  private actor(viewer: Viewer): string {
    return `${String(viewer.role)}:${viewer.userId}`;
  }

  /**
   * La direction règle le site du réseau, ou le site d'un agent en activité de son réseau ; ou le met hors service. Une
   * même adresse ne sert jamais deux sites en service : deux pages de référence pour un bien seraient possibles [R153].
   */
  async setSite(viewer: Viewer, input: { kind?: unknown; agentId?: unknown; baseUrl?: unknown; active?: unknown }): Promise<SiteResult> {
    const refuse = async (rule: 'R16' | 'R153' | null, code: string): Promise<SiteResult> => {
      await appendEvent(this.journal, { type: rule === 'R16' ? 'acces.refuse' : 'referencement.site_refuse', actor: this.actor(viewer), subject: null, data: { rule, kind: 'public_site', code } }, this.now);
      return { ok: false, rule, code };
    };
    if (viewer.role !== 'direction') return refuse('R16', 'role');
    const { kind, agentId, baseUrl, active } = input;
    if (typeof kind !== 'string' || !(SITE_KINDS as readonly string[]).includes(kind)) return refuse(null, 'bad_kind');
    if (typeof baseUrl !== 'string' || baseUrl.length > 200 || !ORIGIN.test(baseUrl)) return refuse(null, 'bad_url');
    if (typeof active !== 'boolean') return refuse(null, 'bad_active');
    let agent: string | null = null;
    if (kind === 'agent') {
      if (typeof agentId !== 'string' || !ID.test(agentId)) return refuse(null, 'bad_agent');
      const a = await this.db.first<{ status: string }>('SELECT status FROM agents WHERE id = ? AND network_id = ?', [agentId, viewer.networkId]);
      if (!a) return refuse('R16', 'unknown_agent');
      if (active && a.status !== 'active') return refuse('R16', 'agent_parti');
      agent = agentId;
    } else if (agentId !== undefined && agentId !== null) return refuse(null, 'bad_agent');
    if (active) {
      // L'adresse ne doit servir aucun autre site en service, dans aucun réseau.
      for (const s of await this.allActive()) {
        if (s.baseUrl !== baseUrl || (s.networkId === viewer.networkId && s.kind === kind && s.agentId === agent)) continue;
        // Gardée par un agent parti du même réseau : la direction peut la libérer. Un autre réseau n'en apprend rien.
        if (s.networkId === viewer.networkId && s.agentId !== null) {
          const holder = await this.db.first<{ status: string }>('SELECT status FROM agents WHERE id = ? AND network_id = ?', [s.agentId, viewer.networkId]);
          if (holder && holder.status !== 'active') return refuse('R153', 'url_agent_parti');
        }
        return refuse('R153', 'url_taken');
      }
    }
    const id = this.newId();
    await this.db.run('INSERT INTO public_sites (id, network_id, kind, agent_id, base_url, active, set_by, set_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [
      id,
      viewer.networkId,
      kind,
      agent,
      baseUrl,
      active ? 1 : 0,
      this.actor(viewer),
      this.now().toISOString(),
    ]);
    await appendEvent(this.journal, { type: 'referencement.site', actor: this.actor(viewer), subject: agent ? `agent:${agent}` : `network:${viewer.networkId}`, data: { rule: 'R153', kind, active, site: id } }, this.now);
    return { ok: true, siteId: id };
  }

  /** Le dernier réglage de chaque site, de tous les réseaux, s'il est en service. */
  private async allActive(): Promise<(PublicSite & { networkId: string })[]> {
    const rows = await this.db.all<{ id: string; network_id: string; kind: SiteKind; agent_id: string | null; base_url: string; active: number }>(
      `SELECT s.id, s.network_id, s.kind, s.agent_id, s.base_url, s.active FROM public_sites s
        WHERE s.rowid = (SELECT t.rowid FROM public_sites t WHERE t.network_id = s.network_id AND t.kind = s.kind AND t.agent_id IS s.agent_id ORDER BY t.set_at DESC, t.rowid DESC LIMIT 1)
        ORDER BY s.network_id, s.kind DESC, s.agent_id`,
    );
    return rows.filter((r) => Number(r.active) === 1).map((r) => ({ siteId: r.id, networkId: r.network_id, kind: r.kind, agentId: r.agent_id, baseUrl: r.base_url }));
  }

  /** Le dernier réglage du site de chaque agent du réseau, en service ou non : pour le remettre en service [R16]. */
  async agentSiteSettings(networkId: string): Promise<{ agentId: string; baseUrl: string; active: boolean }[]> {
    const rows = await this.db.all<{ agent_id: string; base_url: string; active: number }>(
      `SELECT s.agent_id, s.base_url, s.active FROM public_sites s
        WHERE s.network_id = ? AND s.kind = 'agent'
          AND s.rowid = (SELECT t.rowid FROM public_sites t WHERE t.network_id = s.network_id AND t.kind = s.kind AND t.agent_id IS s.agent_id ORDER BY t.set_at DESC, t.rowid DESC LIMIT 1)`,
      [networkId],
    );
    return rows.map((r) => ({ agentId: r.agent_id, baseUrl: r.base_url, active: Number(r.active) === 1 }));
  }

  /**
   * Les adresses encore gardées par un agent parti du réseau : son site n'est plus servi, mais aucun autre site ne peut
   * prendre l'adresse tant que son dernier réglage reste « en service » [R153]. Pour la direction seule, qui les libère.
   */
  async departedAgentSites(networkId: string): Promise<{ agentId: string; name: string; baseUrl: string }[]> {
    const rows = await this.db.all<{ id: string; first_name: string; last_name: string }>("SELECT id, first_name, last_name FROM agents WHERE network_id = ? AND status <> 'active' ORDER BY last_name, first_name, id", [networkId]);
    const settings = new Map((await this.agentSiteSettings(networkId)).map((x) => [x.agentId, x]));
    return rows.flatMap((a) => {
      const site = settings.get(a.id);
      return site?.active ? [{ agentId: a.id, name: `${a.first_name} ${a.last_name}`, baseUrl: site.baseUrl }] : [];
    });
  }

  /**
   * Les sites en service du réseau : le site du réseau d'abord, puis ceux des agents. Le site d'un agent qui n'est plus
   * en activité n'est plus en service : ses biens reviennent à la page du réseau.
   */
  async sites(networkId: string): Promise<PublicSite[]> {
    const out: PublicSite[] = [];
    for (const s of await this.allActive()) {
      if (s.networkId !== networkId) continue;
      if (s.kind === 'agent') {
        const a = await this.db.first<{ status: string }>('SELECT status FROM agents WHERE id = ? AND network_id = ?', [s.agentId, networkId]);
        if (!a || a.status !== 'active') continue;
      }
      out.push({ siteId: s.siteId, kind: s.kind, agentId: s.agentId, baseUrl: s.baseUrl });
    }
    return out;
  }

  /**
   * Les biens publiés du réseau : la dernière version de chacun, en vente ou sous offre, complète comme l'exige la page
   * du bien (titre, texte, mentions, prix) [R43]. Un brouillon, un bien vendu ou retiré n'y est jamais.
   */
  async published(networkId: string): Promise<PublishedListing[]> {
    const rows = await this.db.all<PublishedRow>(
      `SELECT v.property_id, p.agent_id, p.city, p.status AS property_status, v.state, v.id AS version_id, v.created_at, v.payload FROM listing_versions v
         JOIN properties p ON p.id = v.property_id AND p.network_id = v.network_id
        WHERE v.network_id = ? AND v.seq = (SELECT max(seq) FROM listing_versions w WHERE w.property_id = v.property_id)
        ORDER BY v.property_id`,
      [networkId],
    );
    const out: PublishedListing[] = [];
    for (const r of rows) {
      if (r.state !== 'en_vente' && r.state !== 'sous_offre') continue;
      if (!ID.test(r.property_id)) continue;
      let p: { title?: unknown; body?: unknown; mentions?: unknown; priceEur?: unknown; media?: unknown };
      try {
        const parsed: unknown = JSON.parse(r.payload);
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) continue;
        p = parsed as typeof p;
      } catch {
        continue;
      }
      if (typeof p.title !== 'string' || p.title === '' || typeof p.body !== 'string' || p.body === '' || typeof p.mentions !== 'string' || p.mentions === '' || typeof p.priceEur !== 'number' || !(p.priceEur > 0)) continue;
      const media: unknown[] = Array.isArray(p.media) ? p.media : [];
      const first = media.find((m): m is { ref: string; overlay?: unknown } => typeof m === 'object' && m !== null && (m as { kind?: unknown }).kind === 'photo' && typeof (m as { ref?: unknown }).ref === 'string');
      out.push({
        propertyId: r.property_id,
        agentId: r.agent_id,
        city: r.city,
        state: r.state,
        versionId: r.version_id,
        title: p.title,
        priceEur: p.priceEur,
        day: dayOf(r.created_at),
        mentions: p.mentions,
        photo: first ? { ref: first.ref, overlay: typeof first.overlay === 'string' ? first.overlay : null } : null,
        propertyStatus: r.property_status,
      });
    }
    return out;
  }

  /** Le site qui porte la page de référence d'un bien de cet agent : le sien s'il en a un en service, sinon le réseau. */
  private homeOf(sites: readonly PublicSite[], agentId: string | null): PublicSite | null {
    return sites.find((s) => s.kind === 'agent' && agentId !== null && s.agentId === agentId) ?? sites.find((s) => s.kind === 'reseau') ?? null;
  }

  /** La page de référence d'un bien publié, ou `null` : jamais vers une page non publiée [R153]. */
  async canonicalFor(networkId: string, propertyId: string): Promise<string | null> {
    if (!ID.test(propertyId)) return null;
    const listing = (await this.published(networkId)).find((l) => l.propertyId === propertyId);
    if (!listing) return null;
    const home = this.homeOf(await this.sites(networkId), listing.agentId);
    return home ? `${home.baseUrl}/biens/${encodeURIComponent(propertyId)}` : null;
  }

  /** La page de référence et les données structurées d'un bien publié, à poser dans sa page ; `null` sinon. */
  async listingSeo(networkId: string, propertyId: string): Promise<{ canonical: string; structuredData: string } | null> {
    const canonical = await this.canonicalFor(networkId, propertyId);
    if (!canonical) return null;
    const listing = (await this.published(networkId)).find((l) => l.propertyId === propertyId)!;
    const agent = listing.agentId ? await this.db.first<{ first_name: string; last_name: string; status: string }>('SELECT first_name, last_name, status FROM agents WHERE id = ? AND network_id = ?', [listing.agentId, networkId]) : null;
    const agentName = agent && agent.status === 'active' ? `${agent.first_name} ${agent.last_name}` : null;
    return { canonical, structuredData: listingStructuredData({ canonical, title: listing.title, priceEur: listing.priceEur, state: listing.state, city: listing.city, agentName }) };
  }

  /** Les pages de prix montrables de la dernière version complète : une zone avec au moins une case publiée. */
  private async pricePaths(networkId: string): Promise<{ path: string; day: string | null; commune: PublicCommune | null }[]> {
    const version = await this.db.first<{ id: string; completed_at: string }>(
      "SELECT id, completed_at FROM price_versions WHERE network_id = ? AND status = 'complet' ORDER BY completed_at DESC, rowid DESC LIMIT 1",
      [networkId],
    );
    if (!version) return [];
    const rows = await this.db.all<{ level: string; slug: string; name: string; parent_slug: string | null }>(
      `SELECT DISTINCT z.level, z.slug, z.label AS name, p.slug AS parent_slug FROM price_cells c JOIN price_zones z ON z.id = c.area_id LEFT JOIN price_zones p ON p.id = z.parent_id
        WHERE c.version_id = ? AND c.status IN ('publiee', 'reprise')
          AND z.id NOT IN (SELECT area_id FROM price_zone_retirements)
          AND (z.parent_id IS NULL OR z.parent_id NOT IN (SELECT area_id FROM price_zone_retirements))
        ORDER BY z.level, p.slug, z.slug`,
      [version.id],
    );
    const day = dayOf(version.completed_at);
    const slug = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
    return rows
      .filter((r) => slug.test(r.slug) && (r.level === 'commune' || (r.parent_slug !== null && slug.test(r.parent_slug))))
      .map((r) => ({ path: r.level === 'commune' ? `/prix/${r.slug}` : `/prix/${r.parent_slug}/${r.slug}`, day, commune: r.level === 'commune' ? { slug: r.slug, name: r.name } : null }));
  }

  /** Les communes dont la page de prix a au moins une case publiable, par ordre alphabétique (RS03) [R150]. */
  async priceCommunes(networkId: string): Promise<PublicCommune[]> {
    return (await this.pricePaths(networkId)).flatMap((p) => (p.commune ? [p.commune] : [])).sort((a, b) => a.name.localeCompare(b.name, 'fr'));
  }

  /**
   * Les grilles publiées des programmes neufs du réseau qui ont au moins un lot publié, avec le jour de confirmation le
   * plus récent et l'empreinte de ce que la page montre (BR77) [R543]. Une grille vide n'est pas donnée aux moteurs.
   */
  private async newBuildPages(networkId: string): Promise<{ path: string; day: string; fingerprint: string }[]> {
    const programs = await this.db.all<{ id: string }>('SELECT id FROM new_programs WHERE network_id = ? ORDER BY id', [networkId]);
    const neuf = new ProgrammesNeufs(this.db, this.journal, { now: this.now });
    const pages: { path: string; day: string; fingerprint: string }[] = [];
    for (const p of programs) {
      if (!ID.test(p.id)) continue;
      const grid = await neuf.publishedGrid(networkId, p.id);
      if (!grid || grid.lots.length === 0) continue;
      const day = grid.lots.reduce((d, l) => (l.confirmedOn > d ? l.confirmedOn : d), grid.lots[0]!.confirmedOn);
      const { programId, name, city, postalCode, promoter, lots } = grid;
      pages.push({ path: `/neuf/${encodeURIComponent(p.id)}`, day, fingerprint: await sha256(`neuf:${JSON.stringify({ programId, name, city, postalCode, promoter, lots })}`) });
    }
    return pages;
  }

  /**
   * Le plan d'un site en service : son accueil et les pages où il mène (RS02) ; ses biens publiés, chacun par sa page de
   * référence ; la page de chaque agent publiable qu'il montre ; et, pour le site du réseau, les pages de prix montrables
   * et les grilles des programmes neufs qui ont un lot publié (BR77). Rien d'autre [R153, R152, R150, R543].
   */
  async sitemap(networkId: string, siteId: string): Promise<{ ok: true; entries: SitemapEntry[]; xml: string } | { ok: false; code: 'unknown_site' }> {
    const sites = await this.sites(networkId);
    const site = sites.find((s) => s.siteId === siteId);
    if (!site) return { ok: false, code: 'unknown_site' };
    const entries: SitemapEntry[] = [{ loc: `${site.baseUrl}/`, lastmod: null, kind: 'page' }];
    for (const p of sitePaths(site.kind, this.recruitingNetworkId === networkId)) entries.push({ loc: `${site.baseUrl}${p.path}`, lastmod: null, kind: 'page' });
    for (const p of LEGAL_PATHS) entries.push({ loc: `${site.baseUrl}${p}`, lastmod: null, kind: 'page' });
    for (const l of await this.published(networkId)) {
      if (site.kind === 'agent' && l.agentId !== site.agentId) continue;
      const home = this.homeOf(sites, l.agentId);
      if (!home) continue;
      entries.push({ loc: `${home.baseUrl}/biens/${encodeURIComponent(l.propertyId)}`, lastmod: l.day, kind: 'bien' });
    }
    const pages = new PageAgent(this.db, this.journal, { now: this.now });
    const agents = site.kind === 'agent' ? [site.agentId!] : (await this.db.all<{ id: string }>("SELECT id FROM agents WHERE network_id = ? AND status = 'active' ORDER BY id", [networkId])).map((a) => a.id);
    for (const a of agents) {
      if (!ID.test(a)) continue;
      // Une page sans ses mentions n'est pas publiée : elle n'entre pas au plan [R152].
      if (!(await pages.inputFor(networkId, a)).ok) continue;
      entries.push({ loc: `${site.baseUrl}/agents/${encodeURIComponent(a)}`, lastmod: null, kind: 'agent' });
    }
    if (site.kind === 'reseau') for (const p of await this.pricePaths(networkId)) entries.push({ loc: `${site.baseUrl}${p.path}`, lastmod: p.day, kind: 'prix' });
    // La grille d'un programme neuf : sur le seul site du réseau, et seulement avec au moins un lot publié [R153, R543].
    if (site.kind === 'reseau') for (const p of await this.newBuildPages(networkId)) entries.push({ loc: `${site.baseUrl}${p.path}`, lastmod: p.day, kind: 'neuf' });
    return { ok: true, entries, xml: renderSitemap(entries) };
  }

  /** Chaque page de référence du réseau, avec l'empreinte de ce qu'elle montre. */
  private async currentPages(networkId: string): Promise<Map<string, string>> {
    const pages = new Map<string, string>();
    const sites = await this.sites(networkId);
    for (const l of await this.published(networkId)) {
      const home = this.homeOf(sites, l.agentId);
      if (home) pages.set(`${home.baseUrl}/biens/${encodeURIComponent(l.propertyId)}`, await sha256(`bien:${l.versionId}`));
    }
    const network = sites.find((s) => s.kind === 'reseau');
    const agentPages = new PageAgent(this.db, this.journal, { now: this.now });
    for (const s of sites) {
      const agents = s.kind === 'agent' ? [s.agentId!] : (await this.db.all<{ id: string }>("SELECT id FROM agents WHERE network_id = ? AND status = 'active' ORDER BY id", [networkId])).map((a) => a.id);
      for (const a of agents) {
        const r = await agentPages.inputFor(networkId, a);
        if (r.ok) pages.set(`${s.baseUrl}/agents/${encodeURIComponent(a)}`, await sha256(`agent:${JSON.stringify(r.input)}`));
      }
    }
    if (network) {
      const version = await this.db.first<{ id: string }>("SELECT id FROM price_versions WHERE network_id = ? AND status = 'complet' ORDER BY completed_at DESC, rowid DESC LIMIT 1", [networkId]);
      for (const p of await this.pricePaths(networkId)) pages.set(`${network.baseUrl}${p.path}`, await sha256(`prix:${version?.id ?? ''}`));
      for (const p of await this.newBuildPages(networkId)) pages.set(`${network.baseUrl}${p.path}`, p.fingerprint);
    }
    return pages;
  }

  /**
   * Le passage du signalement : chaque page publiée, modifiée ou retirée depuis le dernier signalement réussi du même
   * mode est signalée (au passage en mode réel, toutes les pages publiées pendant l'essai partent donc une fois), une fois, groupée par hôte. En mode essai, le service n'est jamais appelé [R26]. Une panne du
   * service est rangée « echec » et au journal, sans données, puis la page est signalée de nouveau au passage suivant.
   */
  async signalChanges(networkId: string): Promise<{ mode: SeoMode; signalled: number; failed: number }> {
    // Une mention légale manque, ou une preuve de mise en service n'est pas valide : le site reste en essai, rien ne
    // part aux moteurs [R221, R675].
    const complete = this.mode === 'reel' && siteReady(await new MentionsSite(this.db, this.journal, { now: this.now }).read(networkId));
    const mode: SeoMode = complete ? 'reel' : 'essai';
    const current = await this.currentPages(networkId);
    const last = await this.db.all<{ url: string; change: SeoChange; fingerprint: string }>(
      `SELECT s.url, s.change, s.fingerprint FROM seo_signals s
        WHERE s.network_id = ? AND s.mode = ? AND s.outcome IN ('essai', 'ok')
          AND s.rowid = (SELECT t.rowid FROM seo_signals t WHERE t.network_id = s.network_id AND t.url = s.url AND t.mode = s.mode AND t.outcome IN ('essai', 'ok') ORDER BY t.at DESC, t.rowid DESC LIMIT 1)`,
      [networkId, mode],
    );
    const known = new Map(last.map((l) => [l.url, l]));
    const todo: { url: string; change: SeoChange; fingerprint: string }[] = [];
    for (const [url, fingerprint] of [...current.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
      const k = known.get(url);
      if (!k || k.change === 'retiree') todo.push({ url, change: 'publiee', fingerprint });
      else if (k.fingerprint !== fingerprint) todo.push({ url, change: 'modifiee', fingerprint });
    }
    for (const k of [...known.values()].sort((a, b) => (a.url < b.url ? -1 : 1))) {
      if (k.change !== 'retiree' && !current.has(k.url)) todo.push({ url: k.url, change: 'retiree', fingerprint: await sha256(`retiree:${k.url}`) });
    }
    const byHost = new Map<string, typeof todo>();
    for (const t of todo) {
      const host = new URL(t.url).host;
      byHost.set(host, [...(byHost.get(host) ?? []), t]);
    }
    let failed = 0;
    for (const [host, items] of byHost) {
      let outcome: 'essai' | 'ok' | 'echec' = 'essai';
      if (mode === 'reel' && this.indexNow) {
        try {
          await this.indexNow.submit(host, items.map((i) => i.url));
          outcome = 'ok';
        } catch (error) {
          outcome = 'echec';
          failed += items.length;
          await appendEvent(this.journal, { type: 'referencement.signalement_echec', actor: 'system:referencement', subject: `network:${networkId}`, data: { host, count: items.length, error: error instanceof Error ? error.name : 'erreur' } }, this.now);
        }
      }
      const at = this.now().toISOString();
      for (const i of items) {
        await this.db.run('INSERT INTO seo_signals (id, network_id, url, change, fingerprint, mode, outcome, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [this.newId(), networkId, i.url, i.change, i.fingerprint, mode, outcome, at]);
      }
    }
    await appendEvent(this.journal, { type: 'referencement.signalement', actor: 'system:referencement', subject: `network:${networkId}`, data: { rule: 'R26', mode: mode, count: todo.length, failed } }, this.now);
    return { mode: mode, signalled: todo.length - failed, failed };
  }
}
