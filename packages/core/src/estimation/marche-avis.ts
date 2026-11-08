/**
 * L'avis de valeur enrichi du marché réel (M04, HX32) [R303 à R306].
 *
 * Avant de valider son avis, l'agent qui suit le bien y joint un relevé du marché, calculé par le code :
 * - les biens en concurrence : les annonces de particuliers de la pige (HX11) de la même sorte, dans la commune du bien,
 *   de surface proche, vues en ligne ces derniers jours. Pour chacune : son site, le jour de son relevé, depuis combien
 *   de jours elle est en ligne, ses baisses de prix avec leur date [R303]. Un bien fermé (« pas d'agence », non du
 *   particulier, trop relié) n'y entre pas. Seuls les champs d'une liste fermée sont gardés : ni nom, ni adresse, ni
 *   référence de l'annonce, ni texte [R305] ;
 * - le loyer possible : le loyer de marché de Y02 (Carte des loyers de l'ANIL importée, sinon les locations du réseau),
 *   rapporté à la surface du bien, avec sa source citée telle quelle, son millésime, sa date et sa fiabilité ; sans donnée,
 *   « inconnu », jamais un chiffre deviné [R304, R122, R10] ;
 * - le marché de la commune : combien d'annonces de particuliers en ligne, leur durée médiane, combien ont baissé leur
 *   prix, et le prix médian affiché au m² face au prix médian des ventes réelles retenues par l'avis.
 *
 * Jamais vu : le vendeur voit le marché réel, ce que les autres affichent, depuis quand ils n'ont pas vendu et ce qu'ils
 * ont déjà baissé, à côté des ventes réelles et du loyer qu'il pourrait tirer de son bien.
 *
 * Le relevé ne se joint qu'à un brouillon ; une nouvelle relève ajoute une version, la page imprimée lit la dernière, et
 * un avis validé n'en reçoit plus : ce qui part est ce que l'agent a vu en validant [R306, R30, R17]. Le journal ne porte
 * que des comptes [R13].
 */
import type { Viewer } from '../acces/droits.ts';
import { agentState } from '../acces/etat-agent.ts';
import { communeSlug } from '../attirer/liste-biens.ts';
import { runBatch, type SqlDatabase } from '../db/sql.ts';
import { escapeHtml } from '../documents/modeles.ts';
import { localTime } from '../envoi/horaires.ts';
import type { MarketRent, MarketRentKind } from '../investir/loyers.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import { euros } from './avis.ts';

export interface MarketSettings {
  /** Une annonce vue en ligne depuis au plus ce nombre de jours compte comme en ligne. */
  onlineDays: number;
  /** Écart de surface admis pour un concurrent, en pour cent de la surface du bien. */
  surfaceTolerancePct: number;
  /** Au plus ce nombre de concurrents sur l'avis, les plus proches en surface. */
  maxCompetitors: number;
}

export const DEFAULT_MARKET_SETTINGS: Readonly<MarketSettings> = Object.freeze({ onlineDays: 7, surfaceTolerancePct: 25, maxCompetitors: 10 });

/** Une baisse de prix d'un concurrent : le jour où la pige l'a vue, le prix d'avant et le nouveau. */
export interface PriceDrop {
  on: string;
  fromEur: number;
  toEur: number;
}

/** Un concurrent sur l'avis : ces champs-là, et aucun autre [R305]. */
export interface Competitor {
  /** Le site où l'annonce est relevée. */
  source: string;
  /** Sur combien de sites le même bien est vu. */
  sites: number;
  /** Le jour du dernier relevé en ligne, `AAAA-MM-JJ` à Paris [R303]. */
  seenOn: string;
  publishedOn: string;
  daysOnline: number;
  surfaceM2: number;
  rooms: number | null;
  priceEur: number;
  firstPriceEur: number;
  perM2: number;
  drops: PriceDrop[];
}

export const COMPETITOR_FIELDS: readonly (keyof Competitor)[] = Object.freeze(['source', 'sites', 'seenOn', 'publishedOn', 'daysOnline', 'surfaceM2', 'rooms', 'priceEur', 'firstPriceEur', 'perM2', 'drops']);

export type RentPart =
  | {
      status: 'connu';
      /** Loyer mensuel charges comprises, arrondi à la dizaine d'euros, et les bornes de l'intervalle de prévision. */
      monthlyEur: number;
      lowEur: number;
      highEur: number;
      rentM2Cents: number;
      source: 'anil' | 'reseau';
      citation: string;
      vintage: number | null;
      asOf: string;
      observations: number;
      reliability: 'fiable' | 'peu_observations';
      reasons: ('observations' | 'intervalle')[];
    }
  | { status: 'inconnu' };

export interface CommuneMarket {
  ads: number;
  medianDaysOnline: number | null;
  withDrops: number;
  medianAskedPerM2: number | null;
  /** Le prix médian au m² des ventes réelles retenues par l'avis (E01). */
  soldMedianPerM2: number | null;
  /** Écart du prix affiché sur le prix vendu, en pour cent arrondi ; positif quand on affiche plus cher. */
  gapPct: number | null;
}

export interface MarketSection {
  /** Le jour du relevé, à Paris. */
  takenOn: string;
  commune: string;
  kind: 'apartment' | 'house';
  surfaceM2: number;
  competitors: Competitor[];
  rent: RentPart;
  market: CommuneMarket;
}

/** Le loyer de marché de Y02, par code de commune. */
export interface RentLookup {
  marketRent(networkId: string, inseeCode: string, kind: MarketRentKind): Promise<MarketRent>;
}

/** Ce qui ferme un bien de la pige (HX11) : une raison, ou null s'il est ouvert. */
export interface PigeClosure {
  closure(networkId: string, fingerprint: string): Promise<unknown>;
}

export type MarketRefusal = { ok: false; rule: 'R30' | 'R306'; code: 'unknown' | 'not_following_agent' | 'already_validated' | 'changed_meanwhile' } | { ok: false; rule: null; code: 'invalid' | 'no_surface' | 'no_commune' };

const DAY = 86_400_000;
const INSEE = /^(?:\d{5}|2[AB]\d{3})$/;
/** Le département d'un code postal : deux premiers chiffres, Corse comprise (20). */
const departmentOf = (postalCode: string): string => postalCode.slice(0, 2);
const parisDay = (d: Date): string => localTime(d, 'Europe/Paris').date;
const dayNumber = (day: string): number => Math.round(Date.parse(`${day}T00:00:00.000Z`) / DAY);

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[m]! : Math.round((s[m - 1]! + s[m]!) / 2);
}

interface AdRow {
  source: string;
  source_ref: string;
  fingerprint: string;
  commune: string;
  surface_m2: number;
  rooms: number | null;
  price_eur: number;
  published_at: string;
  collected_at: string;
}

/** Une annonce suivie sur son site : ses relèves dans l'ordre, et son dernier jour vu en ligne. */
interface Followed {
  rows: AdRow[];
  seenOn: string;
}

export class MarcheAvis {
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly settings: MarketSettings;

  constructor(
    private readonly db: SqlDatabase,
    private readonly journal: JournalStore,
    private readonly rents: RentLookup,
    private readonly pige: PigeClosure,
    options: { now?: () => Date; newId?: () => string; settings?: Partial<MarketSettings> } = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => crypto.randomUUID());
    this.settings = { ...DEFAULT_MARKET_SETTINGS, ...options.settings };
  }

  /**
   * L'agent actif qui suit le bien joint le relevé du marché à son brouillon [R306]. La sorte, la surface et le code de
   * commune sont ceux de l'avis (E09) ; la commune vient du bien, tous ses codes postaux compris, dans son département.
   */
  async attach(viewer: Viewer, reportId: unknown): Promise<{ ok: true; value: MarketSection } | MarketRefusal> {
    if (typeof reportId !== 'string') return { ok: false, rule: null, code: 'invalid' };
    const report = await this.db.first<{ id: string; network_id: string; property_id: string; status: string; computed: string; updated_at: string }>(
      'SELECT id, network_id, property_id, status, computed, updated_at FROM valuation_reports WHERE id = ?',
      [reportId],
    );
    if (!report || report.network_id !== viewer.networkId) return { ok: false, rule: 'R30', code: 'unknown' };
    const property = await this.db.first<{ agent_id: string | null; city: string | null; postal_code: string | null }>(
      'SELECT agent_id, city, postal_code FROM properties WHERE id = ? AND network_id = ?',
      [report.property_id, report.network_id],
    );
    const agent = viewer.role === 'agent' ? await this.db.first<{ status: string }>('SELECT status FROM agents WHERE id = ? AND network_id = ?', [viewer.userId, viewer.networkId]) : null;
    // L'état réel de l'agent, départ du jour compris, pas seulement la colonne [R86, R16].
    const effective = agent ? await agentState(this.db, viewer.networkId, viewer.userId, this.now()) : null;
    if (viewer.role !== 'agent' || !property || property.agent_id !== viewer.userId || agent?.status !== 'active' || effective !== 'actif') {
      await this.log('avis.marche_refuse', `${String(viewer.role)}:${viewer.userId}`, report.property_id, { report: report.id, code: 'not_following_agent' });
      return { ok: false, rule: 'R30', code: 'not_following_agent' };
    }
    if (report.status !== 'draft') return { ok: false, rule: 'R306', code: 'already_validated' };
    // La sorte, la surface et la commune sont celles du bien estimé, lues dans l'avis même, jamais données par l'écran :
    // le relevé ne peut porter sur un autre bien [R303, R304, R10].
    const computed = JSON.parse(report.computed) as { kind?: unknown; surface?: unknown; inseeCode?: unknown; medianPerM2?: unknown };
    if (computed.kind !== 'apartment' && computed.kind !== 'house') return { ok: false, rule: null, code: 'invalid' };
    if (typeof computed.surface !== 'number' || !(computed.surface > 0)) return { ok: false, rule: null, code: 'no_surface' };
    if (!property.city || !property.postal_code || !/^\d{5}$/.test(property.postal_code)) return { ok: false, rule: null, code: 'no_commune' };
    const section = await this.compose(viewer.networkId, {
      kind: computed.kind,
      // Sans code de commune collecté, le loyer est « inconnu » [R304].
      inseeCode: typeof computed.inseeCode === 'string' && INSEE.test(computed.inseeCode) ? computed.inseeCode : null,
      commune: property.city,
      department: departmentOf(property.postal_code),
      surfaceM2: computed.surface,
      soldMedianPerM2: typeof computed.medianPerM2 === 'number' ? computed.medianPerM2 : null,
    });
    // Le relevé change la version de l'avis, dans le même lot : une validation faite sur la version lue avant ce relevé
    // est refusée, et ce qui part est toujours ce que l'agent a vu en validant [R306, R30].
    const nowMs = this.now().getTime();
    const before = Date.parse(report.updated_at);
    const at = new Date(Number.isFinite(before) && nowMs <= before ? before + 1 : nowMs).toISOString();
    // La base refuse aussi un avis validé entre-temps [R306].
    try {
      // Comparer puis poser : la version ne change que si elle est encore celle lue, et le relevé n'entre que si cette
      // écriture-là vient de réussir (`changes()` de l'écriture d'avant, dans le même lot), que sa version est en place et
      // qu'aucun autre relevé ne la porte déjà. Deux relevés croisés ne partagent jamais une
      // version : le second n'entre pas, et c'est dit [R306].
      const done = await runBatch(this.db, [
        {
          // Et toujours suivi par cet agent, actif, au moment d'écrire : une réattribution pendant le calcul l'arrête.
          sql: `UPDATE valuation_reports SET updated_at = ? WHERE id = ? AND status = 'draft' AND updated_at = ?
                  AND EXISTS (SELECT 1 FROM properties p JOIN agents a ON a.id = p.agent_id AND a.network_id = p.network_id
                               WHERE p.id = ? AND p.network_id = ? AND p.agent_id = ? AND a.status = 'active')`,
          params: [at, report.id, report.updated_at, report.property_id, viewer.networkId, viewer.userId],
        },
        {
          sql: `INSERT INTO valuation_market_snapshots (id, network_id, report_id, agent_id, market, created_at)
                SELECT ?, ?, ?, ?, ?, ?
                 WHERE changes() = 1
                   AND EXISTS (SELECT 1 FROM valuation_reports WHERE id = ? AND updated_at = ?)
                   AND NOT EXISTS (SELECT 1 FROM valuation_market_snapshots WHERE report_id = ? AND created_at = ?)`,
          params: [this.newId(), viewer.networkId, report.id, viewer.userId, JSON.stringify(section), at, report.id, at, report.id, at],
        },
      ]);
      if (done[1]?.changes !== 1) {
        const still = await this.db.first<{ status: string }>('SELECT status FROM valuation_reports WHERE id = ?', [report.id]);
        const follower = await this.db.first<{ x: number }>(
          "SELECT 1 AS x FROM properties p JOIN agents a ON a.id = p.agent_id AND a.network_id = p.network_id WHERE p.id = ? AND p.network_id = ? AND p.agent_id = ? AND a.status = 'active'",
          [report.property_id, viewer.networkId, viewer.userId],
        );
        if (!follower) {
          await this.log('avis.marche_refuse', `agent:${viewer.userId}`, report.property_id, { report: report.id, code: 'not_following_agent' });
          return { ok: false, rule: 'R30', code: 'not_following_agent' };
        }
        return still?.status === 'validated' ? { ok: false, rule: 'R306', code: 'already_validated' } : { ok: false, rule: 'R306', code: 'changed_meanwhile' };
      }
    } catch (error) {
      // Seul le refus de la base pour un avis validé entre-temps se dit « déjà validé » ; toute autre panne remonte.
      const still = await this.db.first<{ status: string }>('SELECT status FROM valuation_reports WHERE id = ?', [report.id]);
      if (still?.status === 'validated' && /avis validé/.test(String(error))) return { ok: false, rule: 'R306', code: 'already_validated' };
      throw error;
    }
    await this.log('avis.marche', `agent:${viewer.userId}`, report.property_id, {
      report: report.id,
      competitors: section.competitors.length,
      ads: section.market.ads,
      rent: section.rent.status,
    });
    return { ok: true, value: section };
  }

  /** Le dernier relevé joint à un avis, ou null. */
  async latest(reportId: string): Promise<MarketSection | null> {
    const row = await this.db.first<{ market: string }>('SELECT market FROM valuation_market_snapshots WHERE report_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1', [reportId]);
    return row ? (JSON.parse(row.market) as MarketSection) : null;
  }

  /** Le relevé lui-même, calculé par le code depuis la pige et les loyers de marché. */
  async compose(
    networkId: string,
    q: { kind: 'apartment' | 'house'; inseeCode: string | null; commune: string; department: string; surfaceM2: number; soldMedianPerM2: number | null },
  ): Promise<MarketSection> {
    const now = this.now();
    const takenOn = parisDay(now);
    const online = await this.onlineAds(networkId, q.kind, q.commune, q.department, takenOn);
    const all = online.map((f) => this.competitor(f));
    const tolerance = (q.surfaceM2 * this.settings.surfaceTolerancePct) / 100;
    const competitors = all
      .filter((c) => Math.abs(c.surfaceM2 - q.surfaceM2) <= tolerance)
      .sort((a, b) => Math.abs(a.surfaceM2 - q.surfaceM2) - Math.abs(b.surfaceM2 - q.surfaceM2) || a.perM2 - b.perM2 || a.source.localeCompare(b.source))
      .slice(0, this.settings.maxCompetitors);
    const asked = median(all.map((c) => c.perM2));
    const market: CommuneMarket = {
      ads: all.length,
      medianDaysOnline: median(all.map((c) => c.daysOnline)),
      withDrops: all.filter((c) => c.drops.length > 0).length,
      medianAskedPerM2: asked,
      soldMedianPerM2: q.soldMedianPerM2,
      gapPct: asked !== null && q.soldMedianPerM2 ? Math.round(((asked - q.soldMedianPerM2) / q.soldMedianPerM2) * 100) : null,
    };
    return { takenOn, commune: q.commune, kind: q.kind, surfaceM2: q.surfaceM2, competitors, rent: await this.rent(networkId, q.inseeCode, q.kind, q.surfaceM2), market };
  }

  /** Le loyer possible, rapporté à la surface, avec sa source et sa fiabilité ; « inconnu » sans donnée [R304]. */
  private async rent(networkId: string, inseeCode: string | null, kind: 'apartment' | 'house', surface: number): Promise<RentPart> {
    if (inseeCode === null) return { status: 'inconnu' };
    const r = await this.rents.marketRent(networkId, inseeCode, kind);
    if (r.status !== 'connu' || !(r.rentM2Cents > 0) || !r.citation) return { status: 'inconnu' };
    const monthly = (cents: number) => Math.round((cents * surface) / 100 / 10) * 10;
    return {
      status: 'connu',
      monthlyEur: monthly(r.rentM2Cents),
      lowEur: monthly(r.lowerM2Cents),
      highEur: monthly(r.upperM2Cents),
      rentM2Cents: r.rentM2Cents,
      source: r.source,
      citation: r.citation,
      vintage: r.vintage,
      asOf: r.asOf.slice(0, 10),
      observations: r.observations,
      reliability: r.reliability,
      reasons: [...r.reasons],
    };
  }

  /** Les annonces de la sorte et de la commune vues en ligne ces derniers jours, sans les biens fermés [R303, R305]. */
  private async onlineAds(networkId: string, kind: string, commune: string, department: string, today: string): Promise<Followed[]> {
    // Toutes les relèves de chaque annonce passée un jour par la commune du bien, tous codes postaux et toutes sortes
    // confondus : c'est la dernière qui dit si l'annonce est de la sorte et de la commune du bien, jamais une relève
    // corrigée depuis [R303].
    const slug = communeSlug(commune);
    const names = (await this.db.all<{ commune: string }>('SELECT DISTINCT commune FROM pige_ads WHERE network_id = ?', [networkId]))
      .map((r) => r.commune)
      .filter((c) => communeSlug(c) === slug);
    const rows =
      names.length === 0
        ? []
        : await this.db.all<AdRow & { kind: string; postal_code: string }>(
            `SELECT a.source, a.source_ref, a.fingerprint, a.kind, a.postal_code, a.commune, a.surface_m2, a.rooms, a.price_eur, a.published_at, a.collected_at
               FROM pige_ads a
              WHERE a.network_id = ?
                AND EXISTS (SELECT 1 FROM pige_ads b WHERE b.network_id = a.network_id AND b.source = a.source AND b.source_ref = a.source_ref
                              AND b.commune IN (SELECT value FROM json_each(?)))
              ORDER BY a.collected_at, a.rowid`,
            [networkId, JSON.stringify(names)],
          );
    const all = new Map<string, (AdRow & { kind: string; postal_code: string })[]>();
    for (const r of rows) {
      const k = `${r.source}\u0000${r.source_ref}`;
      all.set(k, [...(all.get(k) ?? []), r]);
    }
    const bySite = new Map<string, AdRow[]>();
    for (const [k, list] of all) {
      const last = list[list.length - 1]!;
      // Même nom et même département : deux communes homonymes de départements différents ne se mêlent jamais.
      if (last.kind !== kind || communeSlug(last.commune) !== slug || departmentOf(last.postal_code) !== department) continue;
      // L'historique des prix : toutes les relèves de cette annonce de la même sorte et de la même commune, dans l'ordre ;
      // une surface corrigée en route ne fait pas perdre les baisses d'avant [R303].
      bySite.set(k, list.filter((r) => r.kind === last.kind && communeSlug(r.commune) === slug && departmentOf(r.postal_code) === department));
    }
    const firstOnline = dayNumber(today) - this.settings.onlineDays;
    const out: Followed[] = [];
    const closed = new Map<string, boolean>();
    for (const list of bySite.values()) {
      const last = list[list.length - 1]!;
      const seen = await this.db.first<{ day: string | null }>('SELECT max(seen_on) AS day FROM pige_ad_sightings WHERE network_id = ? AND source = ? AND source_ref = ?', [networkId, last.source, last.source_ref]);
      const collected = parisDay(new Date(last.collected_at));
      const seenOn = seen?.day && seen.day > collected ? seen.day : collected;
      if (dayNumber(seenOn) < firstOnline) continue;
      // Un bien fermé n'est jamais montré, quel que soit le site d'où il vient [R273, R04].
      if (!closed.has(last.fingerprint)) closed.set(last.fingerprint, (await this.pige.closure(networkId, last.fingerprint)) !== null);
      if (closed.get(last.fingerprint)) continue;
      out.push({ rows: list, seenOn });
    }
    // Le même bien sur plusieurs sites ne compte qu'une fois : l'annonce la plus ancienne le porte. Deux annonces d'un
    // même site sont deux biens, même de même empreinte : un groupe ne prend qu'une annonce par site, la n-ième de chaque.
    // Deux annonces de sites différents sont le même bien si elles ont porté un jour la même empreinte, même corrigée
    // depuis : les liens se suivent de proche en proche (union des empreintes de tout leur historique).
    const groups: Followed[][] = [];
    const parent = out.map((_, i) => i);
    const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
    const owner = new Map<string, number>();
    out.forEach((f, i) => {
      for (const r of f.rows) {
        const j = owner.get(r.fingerprint);
        if (j === undefined) owner.set(r.fingerprint, i);
        else parent[find(i)] = find(j);
      }
    });
    const byProperty = new Map<number, Map<string, Followed[]>>();
    out.forEach((f, i) => {
      const root = find(i);
      const sites = byProperty.get(root) ?? new Map<string, Followed[]>();
      byProperty.set(root, sites);
      const src = f.rows[0]!.source;
      sites.set(src, [...(sites.get(src) ?? []), f]);
    });
    for (const sites of byProperty.values()) {
      const lists = [...sites.values()].map((l) => [...l].sort((a, b) => a.rows[0]!.published_at.localeCompare(b.rows[0]!.published_at) || a.rows[0]!.source_ref.localeCompare(b.rows[0]!.source_ref)));
      const size = Math.max(...lists.map((l) => l.length));
      for (let i = 0; i < size; i += 1) groups.push(lists.flatMap((l) => (l[i] ? [l[i]!] : [])));
    }
    return groups.map((group) => {
      const sorted = [...group].sort((a, b) => a.rows[0]!.published_at.localeCompare(b.rows[0]!.published_at) || a.rows[0]!.source.localeCompare(b.rows[0]!.source));
      return Object.assign(sorted[0]!, { sites: new Set(group.map((g) => g.rows[0]!.source)).size });
    });
  }

  /** Un concurrent, avec les seuls champs de la liste fermée [R305]. */
  private competitor(f: Followed & { sites?: number }): Competitor {
    const first = f.rows[0]!;
    const last = f.rows[f.rows.length - 1]!;
    const drops: PriceDrop[] = [];
    for (let i = 1; i < f.rows.length; i += 1) {
      const before = f.rows[i - 1]!;
      const after = f.rows[i]!;
      if (after.price_eur < before.price_eur) drops.push({ on: parisDay(new Date(after.collected_at)), fromEur: before.price_eur, toEur: after.price_eur });
    }
    const publishedOn = parisDay(new Date(first.published_at));
    return {
      source: last.source,
      sites: f.sites ?? 1,
      seenOn: f.seenOn,
      publishedOn,
      daysOnline: Math.max(0, dayNumber(f.seenOn) - dayNumber(publishedOn)),
      surfaceM2: last.surface_m2,
      rooms: last.rooms,
      priceEur: last.price_eur,
      firstPriceEur: first.price_eur,
      perM2: Math.round(last.price_eur / last.surface_m2),
      drops,
    };
  }

  private async log(type: string, actor: string, propertyId: string, data: Record<string, string | number | null>): Promise<void> {
    await appendEvent(this.journal, { type, actor, subject: `property:${propertyId}`, data }, this.now);
  }
}

const MONTHS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
const dayLabel = (day: string): string => `${Number(day.slice(8, 10))} ${MONTHS[Number(day.slice(5, 7)) - 1] ?? ''} ${day.slice(0, 4)}`;
const pct = (n: number): string => `${n > 0 ? '+' : n < 0 ? '−' : ''}${Math.abs(n)} %`;

/** Les baisses d'un concurrent, en mots : chacune avec son jour et ses prix, puis l'écart total. */
function dropsLabel(c: Competitor): string {
  if (c.drops.length === 0) return 'aucune';
  // Chaque baisse, avec son jour et ses prix [R303], puis l'écart depuis le premier prix vu.
  const each = c.drops.map((d) => `le ${dayLabel(d.on)}, de ${euros(d.fromEur)} à ${euros(d.toEur)}`).join(' ; ');
  const total = Math.round(((c.firstPriceEur - c.priceEur) / c.firstPriceEur) * 100);
  return `${each} (${pct(-total)} depuis ${euros(c.firstPriceEur)})`;
}

/**
 * Les trois parties du relevé sur la page imprimée : concurrents, loyer possible, marché de la commune. Chaque chiffre
 * dit d'où il vient et à quelle date [R303, R304] ; aucun nom ni adresse de concurrent [R305]. Le texte est échappé.
 */
export function renderMarketSection(m: MarketSection): string {
  const what = m.kind === 'house' ? 'maisons' : 'appartements';
  const commune = escapeHtml(m.commune);
  const rows = m.competitors
    .map(
      (c) =>
        `<tr><td>${escapeHtml(c.source)}${c.sites > 1 ? ` <small>(et ${c.sites - 1} autre${c.sites > 2 ? 's' : ''} site${c.sites > 2 ? 's' : ''})</small>` : ''}</td><td>${escapeHtml(dayLabel(c.seenOn))}</td><td class="nombre">${c.daysOnline} j</td><td class="nombre">${c.surfaceM2} m²</td><td class="nombre">${escapeHtml(euros(c.priceEur))}</td><td class="nombre">${escapeHtml(euros(c.perM2))}/m²</td><td>${escapeHtml(dropsLabel(c))}</td></tr>`,
    )
    .join('');
  const competitors =
    rows !== ''
      ? `<table><caption>Annonces de particuliers de ${what} à ${commune}, de surface proche, vues en ligne par notre relevé. Site et jour du relevé pour chacune ; ni nom ni adresse.</caption><thead><tr><th scope="col">Site</th><th scope="col">Relevé le</th><th scope="col" class="nombre">En ligne</th><th scope="col" class="nombre">Surface</th><th scope="col" class="nombre">Prix affiché</th><th scope="col" class="nombre">Prix</th><th scope="col">Baisses</th></tr></thead><tbody>${rows}</tbody></table>`
      : `<p>Aucune annonce de particulier de surface proche vue en ligne à ${commune} au ${escapeHtml(dayLabel(m.takenOn))}.</p>`;
  const r = m.rent;
  const rent =
    r.status === 'connu'
      ? `<p>Entre ${escapeHtml(euros(r.lowEur))} et ${escapeHtml(euros(r.highEur))} par mois, charges comprises, pour ${String(m.surfaceM2).replace('.', ',')} m² ; ${escapeHtml(euros(r.monthlyEur))} au milieu de l'intervalle.</p>` +
        `<p class="date">Source : ${escapeHtml(r.citation)}${r.vintage ? `, millésime ${r.vintage}` : ''}, données du ${escapeHtml(dayLabel(r.asOf))}. Fiabilité : ${r.reliability === 'fiable' ? 'fiable' : "peu d'observations"} (${r.observations} observation${r.observations > 1 ? 's' : ''}${r.reasons.includes('intervalle') ? ', intervalle large' : ''}).</p>`
      : `<p>Loyer possible : inconnu. Aucune donnée de loyer pour cette commune au ${escapeHtml(dayLabel(m.takenOn))}.</p>`;
  const k = m.market;
  const items: string[] = [];
  if (k.ads === 0) items.push(`Aucune annonce de particulier vue en ligne pour des ${what}.`);
  else {
    items.push(`${k.ads} annonce${k.ads > 1 ? 's' : ''} de particulier${k.ads > 1 ? 's' : ''} en ligne pour des ${what}.`);
    if (k.medianDaysOnline !== null) items.push(`Durée médiane en ligne : ${k.medianDaysOnline} jour${k.medianDaysOnline > 1 ? 's' : ''}.`);
    items.push(k.withDrops === 0 ? 'Aucune n’a encore baissé son prix.' : k.withDrops === 1 ? 'Une a déjà baissé son prix.' : `${k.withDrops} ont déjà baissé leur prix.`);
    if (k.medianAskedPerM2 !== null) {
      items.push(
        `Prix médian affiché : ${euros(k.medianAskedPerM2)} le m²${k.soldMedianPerM2 ? `, contre ${euros(k.soldMedianPerM2)} pour les ventes réelles retenues ci-dessus${k.gapPct !== null ? ` (écart ${pct(k.gapPct)})` : ''}` : ''}.`,
      );
    }
  }
  return (
    `<h2>Les biens en concurrence</h2>${competitors}` +
    `<h2>Loyer possible</h2>${rent}` +
    `<h2>Le marché à ${commune}</h2><p class="date">Relevé du ${escapeHtml(dayLabel(m.takenOn))}.</p><ul>${items.map((i) => `<li>${escapeHtml(i)}</li>`).join('')}</ul>`
  );
}
