/**
 * Les statistiques du site (HX15) [R285, R286, R287].
 *
 * - Une vue n'est comptée que pour un contenu public connu du réseau (le code porteur de AT05), par un compteur par
 *   contenu et par jour de Paris. Rien d'autre n'est gardé du visiteur : ni adresse IP, ni navigateur, ni page d'arrivée,
 *   ni cookie, ni heure ; la fonction ne reçoit d'ailleurs rien d'autre que le code et le navigateur annoncé, lu
 *   seulement pour écarter les robots (RC12) [R285, R156].
 * - Chaque chiffre est relié à des demandes réelles : une demande est une conversation reçue dont la première origine
 *   connue est ce contenu (la règle de la mesure de AT05), nommée par son premier message ; sa personne est la première
 *   rattachée à ses messages ; un mandat, une demande dont la personne a signé un mandat ensuite, projet ou non ; un
 *   vendeur, une demande dont la personne a un projet de vente, d'estimation ou de cession, ou un tel mandat.
 *   La direction voit tout le réseau ; l'agent, sa page et ses biens [R286, R16]. Aucun nom.
 * - Jamais vu : la prochaine page à écrire, par une règle écrite, sans IA. Parmi les pages rédactionnelles (prix,
 *   quartier), la sorte qui amène le plus de vendeurs par vue ; puis, parmi les communes des zones qui n'ont pas encore
 *   cette page, celle où les vendeurs arrivent déjà le plus. Chaque proposition dit ses chiffres ; sans vendeur mesuré,
 *   rien n'est proposé [R287].
 * - Rien n'est envoyé.
 */
import type { Viewer } from '../acces/droits.ts';
import { agentState } from '../acces/etat-agent.ts';
import { communeSlug } from '../attirer/liste-biens.ts';
import type { ContentKind } from '../attirer/origine-contacts.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { localTime } from '../envoi/horaires.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import { parisDayStart } from '../pilotage/tableau-agent.ts';
import { isRobotVisit } from './robots.ts';

const TIME_ZONE = 'Europe/Paris';
const CODE = /^[a-z2-7]{12}$/;
/** Les projets d'un vendeur : vendre, faire estimer, céder une affaire. */
export const SELLER_PROJECTS = ['sell', 'valuation', 'sell_business'] as const;
/** Les pages rédactionnelles qu'on peut écrire pour attirer des vendeurs. */
export const WRITTEN_KINDS = ['prix', 'quartier'] as const;
export type WrittenKind = (typeof WRITTEN_KINDS)[number];
export const DEFAULT_PERIOD_DAYS = 90;

type Refusal = { ok: false; rule: 'R16'; code: string };

export interface PageStat {
  contentId: string;
  kind: ContentKind;
  ref: string;
  views: number;
  /** Les demandes, chacune par l'identifiant de son premier message : le chiffre se vérifie [R286]. */
  demandes: string[];
  vendeurs: string[];
  mandats: string[];
  /** Vendeurs pour 1 000 vues ; nul sans vue. */
  vendeursPour1000Vues: number | null;
}

export interface NextPage {
  kind: WrittenKind;
  commune: string;
  path: string;
  /** Les chiffres qui font la proposition. */
  figures: { kindVendeurs: number; kindViews: number; communeVendeurs: number };
  text: string;
}

interface Conversation {
  firstInbound: string;
  contentId: string;
  personId: string | null;
  firstAt: string;
}

const addDays = (day: string, n: number): string => new Date(Date.parse(`${day}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const per1000 = (n: number, views: number): number | null => (views === 0 ? null : Math.floor((n * 1000) / views));

export class StatistiquesSite {
  private readonly now: () => Date;

  constructor(
    private readonly db: SqlDatabase,
    private readonly journal: JournalStore,
    options: { now?: () => Date } = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  private async refuse(viewer: Viewer, code: string): Promise<Refusal> {
    await appendEvent(this.journal, { type: 'acces.refuse', actor: `${String(viewer.role)}:${viewer.userId}`, subject: null, data: { rule: 'R16', role: String(viewer.role), kind: 'statistiques_site', code } }, this.now);
    return { ok: false, rule: 'R16', code };
  }

  private async member(viewer: Viewer): Promise<Refusal | null> {
    if (viewer.role === 'direction') return null;
    if (viewer.role !== 'agent') return this.refuse(viewer, 'role');
    const a = await this.db.first<{ id: string }>('SELECT id FROM agents WHERE id = ? AND network_id = ?', [viewer.userId, viewer.networkId]);
    if (!a || (await agentState(this.db, viewer.networkId, viewer.userId, this.now())) !== 'actif') return this.refuse(viewer, 'agent_inactive');
    return null;
  }

  /**
   * Compter une vue d'un contenu public : le seul code porteur, rien du visiteur. Le navigateur annoncé est lu pour
   * écarter les robots, jamais rangé ni écrit au journal ; obligatoire, pour qu'aucun appel ne l'oublie [R285, RC12].
   */
  async countView(
    networkId: string,
    code: unknown,
    visit: { userAgent: unknown },
  ): Promise<{ ok: true; counted: boolean } | { ok: false; code: 'unknown_content' }> {
    if (typeof code !== 'string' || !CODE.test(code)) return { ok: false, code: 'unknown_content' };
    const c = await this.db.first<{ id: string }>('SELECT id FROM public_contents WHERE id = ? AND network_id = ?', [code, networkId]);
    if (!c) return { ok: false, code: 'unknown_content' };
    if (isRobotVisit(visit?.userAgent)) return { ok: true, counted: false };
    const day = localTime(this.now(), TIME_ZONE).date;
    await this.db.run(
      'INSERT INTO site_page_views (network_id, content_id, day, views) VALUES (?, ?, ?, 1) ON CONFLICT (network_id, content_id, day) DO UPDATE SET views = views + 1',
      [networkId, code, day],
    );
    return { ok: true, counted: true };
  }

  private period(input: unknown): { firstDay: string; lastDay: string; from: string; to: string } | null {
    const days = input === undefined ? DEFAULT_PERIOD_DAYS : input;
    if (typeof days !== 'number' || !Number.isInteger(days) || days < 7 || days > 365) return null;
    const lastDay = localTime(this.now(), TIME_ZONE).date;
    const firstDay = addDays(lastDay, -(days - 1));
    return { firstDay, lastDay, from: parisDayStart(firstDay).toISOString(), to: parisDayStart(addDays(lastDay, 1)).toISOString() };
  }

  /** Les conversations commencées dans la période, chacune avec sa première origine connue (la règle de AT05). */
  private async conversations(networkId: string, from: string, to: string): Promise<Conversation[]> {
    // Le premier message, la première origine connue et la première personne rattachée : chacun par l'ordre des messages.
    const rows = await this.db.all<{ known: string | null; person: string | null; first: string; first_at: string }>(
      `SELECT min(m.received_at) AS first_at,
              min(m.received_at || '|' || m.id) AS first,
              min(CASE WHEN o.content_id IS NOT NULL THEN m.received_at || '|' || m.id || '|' || o.content_id END) AS known,
              min(CASE WHEN m.person_id IS NOT NULL THEN m.received_at || '|' || m.id || '|' || m.person_id END) AS person
         FROM inbound_messages m LEFT JOIN contact_origins o ON o.inbound_id = m.id
        WHERE m.network_id = ? AND m.status <> 'unreadable' AND m.kind <> 'unreadable'
        GROUP BY m.channel, coalesce(m.conversation_ref, m.kind || ':' || m.external_id, m.id)
       HAVING min(m.received_at) >= ? AND min(m.received_at) < ?`,
      [networkId, from, to],
    );
    const out: Conversation[] = [];
    for (const r of rows) {
      if (!r.known) continue;
      const last = (v: string): string => v.slice(v.lastIndexOf('|') + 1);
      out.push({ firstInbound: last(r.first), contentId: last(r.known), personId: r.person ? last(r.person) : null, firstAt: r.first_at });
    }
    return out;
  }

  /** Les statistiques de chaque contenu de la période, toutes reliées à des demandes réelles [R286]. */
  private async compute(networkId: string, p: { firstDay: string; lastDay: string; from: string; to: string }): Promise<PageStat[]> {
    const contents = await this.db.all<{ id: string; kind: ContentKind; ref: string }>('SELECT id, kind, ref FROM public_contents WHERE network_id = ?', [networkId]);
    const views = new Map(
      (
        await this.db.all<{ content_id: string; n: number }>('SELECT content_id, SUM(views) AS n FROM site_page_views WHERE network_id = ? AND day >= ? AND day <= ? GROUP BY content_id', [
          networkId,
          p.firstDay,
          p.lastDay,
        ])
      ).map((r) => [r.content_id, Number(r.n)]),
    );
    const byContent = new Map<string, Conversation[]>();
    for (const c of await this.conversations(networkId, p.from, p.to)) byContent.set(c.contentId, [...(byContent.get(c.contentId) ?? []), c]);
    const stats: PageStat[] = [];
    for (const c of contents) {
      const convs = byContent.get(c.id) ?? [];
      const v = views.get(c.id) ?? 0;
      if (v === 0 && convs.length === 0) continue;
      const vendeurs: string[] = [];
      const mandats: string[] = [];
      for (const conv of convs) {
        if (!conv.personId) continue;
        const seller = await this.db.first<{ n: number }>(
          `SELECT COUNT(*) AS n FROM projects WHERE person_id = ? AND network_id = ? AND kind IN (${SELLER_PROJECTS.map(() => '?').join(', ')})`,
          [conv.personId, networkId, ...SELLER_PROJECTS],
        );
        // Un mandat compte de lui-même, projet ou non ; qui signe un mandat est un vendeur.
        const mandate = await this.db.first<{ n: number }>('SELECT COUNT(*) AS n FROM mandates WHERE person_id = ? AND network_id = ? AND signed_at >= ?', [conv.personId, networkId, conv.firstAt]);
        const signed = (mandate?.n ?? 0) > 0;
        if (signed) mandats.push(conv.firstInbound);
        if (signed || (seller?.n ?? 0) > 0) vendeurs.push(conv.firstInbound);
      }
      const demandes = convs.map((x) => x.firstInbound).sort();
      stats.push({ contentId: c.id, kind: c.kind, ref: c.ref, views: v, demandes, vendeurs: vendeurs.sort(), mandats: mandats.sort(), vendeursPour1000Vues: per1000(vendeurs.length, v) });
    }
    stats.sort((a, b) => b.vendeurs.length - a.vendeurs.length || b.demandes.length - a.demandes.length || b.views - a.views || a.contentId.localeCompare(b.contentId));
    return stats;
  }

  /**
   * Les communes qui ont déjà la page de cette sorte, lues dans les sources mêmes des pages : la dernière version complète
   * des prix regroupés (une case publiée de la commune, ni la commune ni le quartier retirés) ou une page de quartier
   * validée ; et, par prudence, tout contenu déjà connu de AT05 [R287].
   */
  private async coveredCommunes(networkId: string, kind: WrittenKind): Promise<Set<string>> {
    const slugs = new Set<string>();
    const known = await this.db.all<{ ref: string }>('SELECT ref FROM public_contents WHERE network_id = ? AND kind = ?', [networkId, kind]);
    for (const k of known) slugs.add(k.ref.split('/')[0]!);
    if (kind === 'prix') {
      const version = await this.db.first<{ id: string }>("SELECT id FROM price_versions WHERE network_id = ? AND status = 'complet' ORDER BY completed_at DESC, rowid DESC LIMIT 1", [networkId]);
      if (version) {
        const rows = await this.db.all<{ slug: string }>(
          `SELECT DISTINCT coalesce(p.slug, z.slug) AS slug FROM price_cells c JOIN price_zones z ON z.id = c.area_id LEFT JOIN price_zones p ON p.id = z.parent_id
            WHERE c.version_id = ? AND c.status IN ('publiee', 'reprise')
              AND z.id NOT IN (SELECT area_id FROM price_zone_retirements)
              AND (z.parent_id IS NULL OR z.parent_id NOT IN (SELECT area_id FROM price_zone_retirements))`,
          [version.id],
        );
        for (const r of rows) slugs.add(r.slug);
      }
    } else {
      const rows = await this.db.all<{ slug: string }>(
        `SELECT DISTINCT coalesce(p.slug, z.slug) AS slug FROM neighbourhood_drafts d JOIN neighbourhood_validations v ON v.draft_id = d.id
           JOIN price_zones z ON z.id = d.zone_id LEFT JOIN price_zones p ON p.id = z.parent_id
          WHERE d.network_id = ? AND d.kind = 'page'`,
        [networkId],
      );
      for (const r of rows) slugs.add(r.slug);
    }
    return slugs;
  }

  /** Les contenus que l'agent voit : sa page et ses biens. */
  private async ownContents(viewer: Viewer): Promise<Set<string>> {
    const rows = await this.db.all<{ id: string }>(
      `SELECT c.id FROM public_contents c WHERE c.network_id = ? AND (
         (c.kind = 'agent' AND c.ref = ?) OR (c.kind = 'bien' AND EXISTS (SELECT 1 FROM properties p WHERE p.id = c.ref AND p.network_id = c.network_id AND p.agent_id = ?)))`,
      [viewer.networkId, viewer.userId, viewer.userId],
    );
    return new Set(rows.map((r) => r.id));
  }

  /** Quelle page amène des vendeurs : chaque chiffre avec ses demandes [R286]. */
  async pages(viewer: Viewer, input: { days?: unknown } = {}): Promise<{ ok: true; firstDay: string; lastDay: string; pages: PageStat[] } | Refusal | { ok: false; rule: null; code: 'bad_period' }> {
    const blocked = await this.member(viewer);
    if (blocked) return blocked;
    const p = this.period(input.days);
    if (!p) return { ok: false, rule: null, code: 'bad_period' };
    let stats = await this.compute(viewer.networkId, p);
    if (viewer.role === 'agent') {
      const own = await this.ownContents(viewer);
      stats = stats.filter((s) => own.has(s.contentId));
    }
    return { ok: true, firstDay: p.firstDay, lastDay: p.lastDay, pages: stats };
  }

  /**
   * La prochaine page à écrire, par la règle écrite de R287 : la sorte de page rédactionnelle qui amène le plus de
   * vendeurs par vue, dans la commune des zones qui ne l'a pas encore et où les vendeurs arrivent déjà le plus.
   */
  async nextPage(
    viewer: Viewer,
    input: { days?: unknown } = {},
  ): Promise<{ ok: true; suggestion: NextPage | null; reason: 'proposee' | 'aucun_vendeur_mesure' | 'toutes_les_communes_ont_leur_page' } | Refusal | { ok: false; rule: null; code: 'bad_period' }> {
    const blocked = await this.member(viewer);
    if (blocked) return blocked;
    const p = this.period(input.days);
    if (!p) return { ok: false, rule: null, code: 'bad_period' };
    const stats = await this.compute(viewer.networkId, p);
    // 1. La sorte : le plus de vendeurs par vue, puis le plus de vendeurs, puis l'ordre des noms.
    const kinds = WRITTEN_KINDS.map((kind) => {
      const of = stats.filter((s) => s.kind === kind);
      return { kind, vendeurs: of.reduce((n, s) => n + s.vendeurs.length, 0), views: of.reduce((n, s) => n + s.views, 0) };
    }).filter((k) => k.vendeurs > 0);
    if (kinds.length === 0) return { ok: true, suggestion: null, reason: 'aucun_vendeur_mesure' };
    // Comparer v1/max(1,w1) et v2/max(1,w2) sans division.
    kinds.sort((a, b) => b.vendeurs * Math.max(1, a.views) - a.vendeurs * Math.max(1, b.views) || b.vendeurs - a.vendeurs || a.kind.localeCompare(b.kind));
    const best = kinds[0]!;
    // 2. Les communes des zones : celles de l'agent, ou de tout le réseau pour la direction.
    const zones = await this.db.all<{ commune: string }>(
      viewer.role === 'agent'
        ? 'SELECT DISTINCT commune FROM agent_zones WHERE network_id = ? AND agent_id = ? AND ended_at IS NULL'
        : 'SELECT DISTINCT commune FROM agent_zones WHERE network_id = ? AND ended_at IS NULL',
      viewer.role === 'agent' ? [viewer.networkId, viewer.userId] : [viewer.networkId],
    );
    const covered = await this.coveredCommunes(viewer.networkId, best.kind);
    // Les vendeurs déjà arrivés par commune : une page de prix ou de quartier par le début de son chemin, un bien par sa commune.
    const sellersBySlug = new Map<string, number>();
    for (const s of stats) {
      if (s.vendeurs.length === 0) continue;
      let slug: string | null = null;
      if (s.kind === 'prix' || s.kind === 'quartier') slug = s.ref.split('/')[0]!;
      else if (s.kind === 'bien') {
        const city = await this.db.first<{ city: string | null }>('SELECT city FROM properties WHERE id = ? AND network_id = ?', [s.ref, viewer.networkId]);
        slug = city?.city ? communeSlug(city.city) : null;
      }
      if (slug) sellersBySlug.set(slug, (sellersBySlug.get(slug) ?? 0) + s.vendeurs.length);
    }
    const candidates = zones
      .map((z) => ({ commune: z.commune, slug: communeSlug(z.commune) }))
      .filter((c) => c.slug.length > 0 && !covered.has(c.slug))
      .map((c) => ({ ...c, vendeurs: sellersBySlug.get(c.slug) ?? 0 }))
      .sort((a, b) => b.vendeurs - a.vendeurs || a.slug.localeCompare(b.slug));
    const pick = candidates[0];
    if (!pick) return { ok: true, suggestion: null, reason: 'toutes_les_communes_ont_leur_page' };
    const label = best.kind === 'prix' ? 'des prix' : 'de quartier';
    const rate = per1000(best.vendeurs, best.views);
    const text =
      `Écrire la page ${label} de ${pick.commune} : sur la période, les pages ${label} ont amené ${best.vendeurs} vendeur${best.vendeurs > 1 ? 's' : ''}` +
      (rate === null ? '' : ` pour ${best.views} vue${best.views > 1 ? 's' : ''} (${rate} pour 1 000 vues)`) +
      `, et ${pick.commune} n'a pas encore la sienne` +
      (pick.vendeurs > 0 ? ` alors que ${pick.vendeurs} vendeur${pick.vendeurs > 1 ? 's' : ''} y sont déjà arrivés par le site.` : '.');
    return {
      ok: true,
      reason: 'proposee',
      suggestion: {
        kind: best.kind,
        commune: pick.commune,
        path: best.kind === 'prix' ? `/prix/${pick.slug}` : `/quartiers/${pick.slug}/`,
        figures: { kindVendeurs: best.vendeurs, kindViews: best.views, communeVendeurs: pick.vendeurs },
        text,
      },
    };
  }
}
