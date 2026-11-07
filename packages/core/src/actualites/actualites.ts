/**
 * Actualités utiles, pas du bruit (HX09) [R268, R269].
 *
 * - La direction range chaque actualité juridique ou de marché avec sa source : le nom de l'éditeur, l'adresse https du
 *   texte et sa date, jamais sans, jamais une date à venir. Elle écrit aussi, en une ligne, ce que l'actualité change pour
 *   l'agent. Une actualité rangée ne change plus : une correction est une nouvelle actualité, l'ancienne retirée [R17].
 *   La même source n'est jamais rangée deux fois dans le réseau, même avec des marqueurs de suivi dans l'adresse [R268].
 * - Jamais vu : la direction ne choisit pas les dossiers, elle décrit une cible fermée (sortes de biens, codes postaux,
 *   moments du dossier, classes énergie, copropriété) ; le code lit au moment de montrer quels dossiers vivants de
 *   l'agent la remplissent, chacun avec sa raison lue dans la base. Une actualité ciblée qui ne touche aucun de ses
 *   dossiers ne lui est pas montrée : c'est du bruit pour lui. Une actualité sans cible va à tout le réseau [R269].
 * - Une actualité n'est montrée qu'une fois à chaque agent, jamais deux, même quand deux écrans demandent le fil en même
 *   temps ; elle n'est plus montrée 60 jours après sa publication, ni après un retrait [R269].
 * - Rien ne part : aucun message, aucune notification. L'agent lit son fil dans l'application.
 * - Aucune donnée personnelle au journal : seulement des identifiants internes et des nombres [R13].
 */
import type { Acces } from '../acces/acces.ts';
import type { Viewer } from '../acces/droits.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { localTime } from '../envoi/horaires.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import { Remises, type DossierMoment } from '../remises/remises.ts';

export const TOPICS = ['juridique', 'marche'] as const;
export type Topic = (typeof TOPICS)[number];

export const PROPERTY_KINDS = ['home', 'land', 'building', 'commercial', 'business_walls', 'business'] as const;
export type PropertyKind = (typeof PROPERTY_KINDS)[number];
export const TARGET_MOMENTS = ['estimation', 'mandat', 'en_vente', 'compromis', 'acte'] as const satisfies readonly DossierMoment[];
export const ENERGY_CLASSES = ['A', 'B', 'C', 'D', 'E', 'F', 'G'] as const;
export type EnergyClass = (typeof ENERGY_CLASSES)[number];

/** Jours après sa publication pendant lesquels une actualité peut encore être montrée. */
export const NEWS_WINDOW_DAYS = 60;
/** Au plus tant de codes postaux dans une cible. */
export const MAX_POSTCODES = 60;

/** La cible d'une actualité : chaque critère présent doit être rempli par le dossier ; aucun critère, tout le réseau. */
export interface Target {
  kinds?: PropertyKind[];
  postcodes?: string[];
  moments?: DossierMoment[];
  energyClasses?: EnergyClass[];
  coownership?: true;
}

export interface NewsInput {
  topic: unknown;
  title: unknown;
  impact: unknown;
  sourceName: unknown;
  sourceUrl: unknown;
  sourceDate: unknown;
  target?: unknown;
}

export interface NewsView {
  id: string;
  topic: Topic;
  title: string;
  /** Ce que l'actualité change pour l'agent, en une ligne. */
  impact: string;
  source: { name: string; url: string; date: string };
  target: Target;
  publishedOn: string;
}

export interface ConcernedDossier {
  propertyId: string;
  reference: string;
  /** Pourquoi ce dossier est concerné, lu dans la base. */
  why: string;
}

export interface FeedItem extends NewsView {
  /** Les dossiers de l'agent concernés ; vide pour une actualité de tout le réseau. */
  concerned: ConcernedDossier[];
}

export interface CatalogueItem extends NewsView {
  withdrawn: boolean;
}

type Refusal = { ok: false; rule: 'R16'; code: string };
type Problem = { ok: false; rule: 'R268' | 'R269' | null; code: string };

interface Row {
  id: string;
  topic: Topic;
  title: string;
  impact: string;
  source_name: string;
  source_url: string;
  source_date: string;
  target: string;
  published_on: string;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const isDay = (v: unknown): v is string => typeof v === 'string' && DAY.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;
const text = (v: unknown, min: number, max: number): string | null => {
  if (typeof v !== 'string') return null;
  const t = v.trim().replace(/\s+/g, ' ');
  return t.length >= min && t.length <= max ? t : null;
};
const addDays = (day: string, n: number): string => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** Paramètres de suivi retirés d'une adresse : ils ne font pas une autre source. */
const TRACKING = /^(utm_.*|fbclid|gclid|mc_cid|mc_eid|xtor|at_medium|at_campaign)$/i;

/**
 * L'adresse d'une source, ramenée à une forme unique : https seulement, sans identifiant ni mot de passe, sans ancre,
 * sans paramètre de suivi, sans barre finale. `null` si ce n'est pas une adresse publique https [R268].
 */
export function normaliseSourceUrl(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const raw = input.trim();
  if (raw.length === 0 || raw.length > 500 || /\s/.test(raw)) return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || u.username !== '' || u.password !== '' || u.port !== '') return null;
  const host = u.hostname;
  if (!host.includes('.') || host.startsWith('.') || host.endsWith('.') || /^[\d.]+$/.test(host) || host.includes('[')) return null;
  u.hash = '';
  for (const key of [...u.searchParams.keys()]) if (TRACKING.test(key)) u.searchParams.delete(key);
  u.searchParams.sort();
  let out = u.toString();
  if (u.pathname.length > 1 && u.pathname.endsWith('/') && u.search === '') out = out.slice(0, -1);
  return out.length <= 500 ? out : null;
}

const sortedUnique = <T extends string>(xs: T[]): T[] => [...new Set(xs)].sort();

/** La cible, lue dans une liste fermée, rangée sous une forme unique ; `null` si elle est mal faite [R269]. */
export function parseTarget(input: unknown): Target | null {
  if (input === undefined || input === null) return {};
  if (typeof input !== 'object' || Array.isArray(input)) return null;
  const o = input as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!['kinds', 'postcodes', 'moments', 'energyClasses', 'coownership'].includes(k)) return null;
  const list = <T extends string>(v: unknown, allowed: (x: string) => boolean, max: number): T[] | null | undefined => {
    if (v === undefined) return undefined;
    if (!Array.isArray(v) || v.length === 0 || v.length > max) return null;
    if (!v.every((x) => typeof x === 'string' && allowed(x))) return null;
    return sortedUnique(v as T[]);
  };
  const out: Target = {};
  const kinds = list<PropertyKind>(o.kinds, (x) => (PROPERTY_KINDS as readonly string[]).includes(x), PROPERTY_KINDS.length);
  if (kinds === null) return null;
  if (kinds) out.kinds = kinds;
  const postcodes = list<string>(o.postcodes, (x) => /^\d{5}$/.test(x), MAX_POSTCODES);
  if (postcodes === null) return null;
  if (postcodes) out.postcodes = postcodes;
  const moments = list<DossierMoment>(o.moments, (x) => (TARGET_MOMENTS as readonly string[]).includes(x), TARGET_MOMENTS.length);
  if (moments === null) return null;
  if (moments) out.moments = moments;
  const classes = list<EnergyClass>(o.energyClasses, (x) => (ENERGY_CLASSES as readonly string[]).includes(x), ENERGY_CLASSES.length);
  if (classes === null) return null;
  if (classes) out.energyClasses = classes;
  if (o.coownership !== undefined) {
    if (o.coownership !== true) return null;
    out.coownership = true;
  }
  return out;
}

const isWholeNetwork = (t: Target): boolean => Object.keys(t).length === 0;

const MOMENT_LABEL: Record<DossierMoment, string> = {
  estimation: 'en estimation',
  mandat: 'mandat inscrit',
  en_vente: 'en vente',
  compromis: 'compromis en préparation',
  acte: 'acte signé il y a moins de 90 jours',
};
const KIND_LABEL: Record<PropertyKind, string> = {
  home: 'logement',
  land: 'terrain',
  building: 'immeuble',
  commercial: 'local commercial',
  business_walls: 'murs commerciaux',
  business: 'fonds de commerce',
};

const toView = (r: Row): NewsView => ({
  id: r.id,
  topic: r.topic,
  title: r.title,
  impact: r.impact,
  source: { name: r.source_name, url: r.source_url, date: r.source_date },
  target: JSON.parse(r.target) as Target,
  publishedOn: r.published_on,
});

interface Dossier {
  id: string;
  reference: string;
  kind: PropertyKind;
  postcode: string | null;
  moment: DossierMoment | null;
  energyClass: EnergyClass | null;
  coownership: boolean;
}

export interface ActualitesOptions {
  now?: () => Date;
  newId?: () => string;
}

export class Actualites {
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly remises: Remises;

  constructor(
    private readonly db: SqlDatabase,
    acces: Acces,
    private readonly journal: JournalStore,
    options: ActualitesOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => crypto.randomUUID());
    // Seul le moment du dossier, lu dans la base, sert ici : aucune remise n'est rangée ni proposée.
    this.remises = new Remises(db, acces, journal, { now: this.now });
  }

  private actor(viewer: Viewer): string {
    return `${String(viewer.role)}:${viewer.userId}`;
  }

  private today(): string {
    return localTime(this.now(), 'Europe/Paris').date;
  }

  private async refuse(viewer: Viewer, subject: string, code: string): Promise<Refusal> {
    await appendEvent(this.journal, { type: 'acces.refuse', actor: this.actor(viewer), subject, data: { rule: 'R16', role: String(viewer.role), kind: 'actualites', code } }, this.now);
    return { ok: false, rule: 'R16', code };
  }

  private async activeAgent(viewer: Viewer): Promise<boolean> {
    if (viewer.role !== 'agent') return false;
    const a = await this.db.first<{ status: string }>('SELECT status FROM agents WHERE id = ? AND network_id = ?', [viewer.userId, viewer.networkId]);
    return a?.status === 'active';
  }

  /** Une actualité, avec sa source et sa ligne d'effet : la direction seule [R268]. */
  async publish(viewer: Viewer, input: NewsInput): Promise<{ ok: true; newsId: string } | Refusal | Problem> {
    if (viewer.role !== 'direction') return this.refuse(viewer, `network:${viewer.networkId}`, 'role');
    if (typeof input.topic !== 'string' || !(TOPICS as readonly string[]).includes(input.topic)) return { ok: false, rule: null, code: 'bad_topic' };
    const title = text(input.title, 4, 140);
    if (!title) return { ok: false, rule: null, code: 'bad_title' };
    // Une ligne, pas un article : ce que l'actualité change pour l'agent.
    if (typeof input.impact === 'string' && /[\r\n]/.test(input.impact.trim())) return { ok: false, rule: 'R268', code: 'impact_une_ligne' };
    const impact = text(input.impact, 10, 200);
    if (!impact) return { ok: false, rule: 'R268', code: 'sans_effet' };
    const sourceName = text(input.sourceName, 2, 80);
    if (!sourceName) return { ok: false, rule: 'R268', code: 'sans_source' };
    if (input.sourceUrl === undefined || input.sourceUrl === null || (typeof input.sourceUrl === 'string' && input.sourceUrl.trim() === '')) return { ok: false, rule: 'R268', code: 'sans_source' };
    const sourceUrl = normaliseSourceUrl(input.sourceUrl);
    if (!sourceUrl) return { ok: false, rule: 'R268', code: 'bad_source_url' };
    if (!isDay(input.sourceDate)) return { ok: false, rule: 'R268', code: 'bad_source_date' };
    const today = this.today();
    // Un texte daté de demain n'existe pas encore : sa date serait inventée.
    if (input.sourceDate > today) return { ok: false, rule: 'R268', code: 'source_a_venir' };
    const target = parseTarget(input.target);
    if (!target) return { ok: false, rule: 'R269', code: 'bad_target' };
    const id = this.newId();
    const r = await this.db.run(
      `INSERT OR IGNORE INTO network_news (id, network_id, topic, title, impact, source_name, source_url, source_date, target, published_on, set_by, set_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, viewer.networkId, input.topic, title, impact, sourceName, sourceUrl, input.sourceDate, JSON.stringify(target), today, this.actor(viewer), this.now().toISOString()],
    );
    // La même source, déjà rangée : jamais deux fois la même actualité [R269].
    if (r.changes === 0) return { ok: false, rule: 'R269', code: 'deja_rangee' };
    await appendEvent(this.journal, { type: 'actualite.rangee', actor: this.actor(viewer), subject: `news:${id}`, data: { rule: 'R268', topic: input.topic, targeted: !isWholeNetwork(target) } }, this.now);
    return { ok: true, newsId: id };
  }

  /** Retirer une actualité : la direction seule, une fois, avec sa raison. Elle n'est plus montrée. */
  async withdraw(viewer: Viewer, newsId: string, reasonInput: unknown): Promise<{ ok: true } | Refusal | Problem> {
    if (viewer.role !== 'direction') return this.refuse(viewer, `news:${newsId}`, 'role');
    const n = await this.db.first<{ id: string }>('SELECT id FROM network_news WHERE id = ? AND network_id = ?', [newsId, viewer.networkId]);
    if (!n) return { ok: false, rule: null, code: 'unknown_news' };
    const reason = text(reasonInput, 2, 200);
    if (!reason) return { ok: false, rule: null, code: 'bad_reason' };
    const r = await this.db.run('INSERT OR IGNORE INTO network_news_withdrawals (news_id, reason, withdrawn_by, withdrawn_at) VALUES (?, ?, ?, ?)', [newsId, reason, this.actor(viewer), this.now().toISOString()]);
    if (r.changes === 0) return { ok: false, rule: null, code: 'deja_retiree' };
    await appendEvent(this.journal, { type: 'actualite.retiree', actor: this.actor(viewer), subject: `news:${newsId}`, data: { rule: 'R269' } }, this.now);
    return { ok: true };
  }

  /** Toutes les actualités du réseau, retirées comprises : la direction seule. */
  async catalogue(viewer: Viewer): Promise<{ ok: true; value: CatalogueItem[] } | Refusal> {
    if (viewer.role !== 'direction') return this.refuse(viewer, `network:${viewer.networkId}`, 'role');
    const rows = await this.db.all<Row & { withdrawn: number }>(
      `SELECT n.id, n.topic, n.title, n.impact, n.source_name, n.source_url, n.source_date, n.target, n.published_on,
              EXISTS (SELECT 1 FROM network_news_withdrawals w WHERE w.news_id = n.id) AS withdrawn
         FROM network_news n WHERE n.network_id = ? ORDER BY n.published_on DESC, n.set_at DESC, n.id`,
      [viewer.networkId],
    );
    return { ok: true, value: rows.map((r) => ({ ...toView(r), withdrawn: Number(r.withdrawn) === 1 })) };
  }

  /**
   * Les dossiers vivants de l'agent : ses biens non retirés dont le moment se lit dans la base, ou encore en projet, en
   * vente ou sous offre. Un bien vendu depuis plus de 90 jours n'est plus un dossier.
   */
  private async dossiersOf(networkId: string, agentId: string): Promise<Dossier[]> {
    const rows = await this.db.all<{ id: string; reference: string; kind: PropertyKind; postal_code: string | null; status: string; energy: string | null; coownership: number | null }>(
      `SELECT p.id, p.reference, p.kind, p.postal_code, p.status,
              (SELECT json_extract(s.data, '$.energy.energyClass') FROM property_sheets s WHERE s.property_id = p.id ORDER BY s.version DESC LIMIT 1) AS energy,
              (SELECT json_extract(s.data, '$.coownership.isCoownership') FROM property_sheets s WHERE s.property_id = p.id ORDER BY s.version DESC LIMIT 1) AS coownership
         FROM properties p
        WHERE p.network_id = ? AND p.agent_id = ? AND p.status <> 'withdrawn'
        ORDER BY p.reference, p.id`,
      [networkId, agentId],
    );
    const out: Dossier[] = [];
    for (const r of rows) {
      const moment = await this.remises.momentOf(networkId, r.id);
      if (moment === null && !['draft', 'available', 'under_offer'].includes(r.status)) continue;
      out.push({
        id: r.id,
        reference: r.reference,
        kind: r.kind,
        postcode: r.postal_code,
        moment,
        energyClass: (ENERGY_CLASSES as readonly string[]).includes(String(r.energy)) ? (r.energy as EnergyClass) : null,
        coownership: Number(r.coownership) === 1,
      });
    }
    return out;
  }

  /** La raison pour laquelle un dossier est concerné, ou `null` s'il ne l'est pas : chaque critère doit être rempli. */
  private static match(t: Target, d: Dossier): string | null {
    const why: string[] = [];
    if (t.kinds) {
      if (!t.kinds.includes(d.kind)) return null;
      why.push(KIND_LABEL[d.kind]);
    }
    if (t.energyClasses) {
      if (!d.energyClass || !t.energyClasses.includes(d.energyClass)) return null;
      why.push(`classe énergie ${d.energyClass}`);
    }
    if (t.coownership) {
      if (!d.coownership) return null;
      why.push('en copropriété');
    }
    if (t.moments) {
      if (!d.moment || !t.moments.includes(d.moment)) return null;
      why.push(MOMENT_LABEL[d.moment]);
    }
    if (t.postcodes) {
      if (!d.postcode || !t.postcodes.includes(d.postcode)) return null;
      why.push(d.postcode);
    }
    const line = why.join(', ');
    return line.charAt(0).toUpperCase() + line.slice(1) + '.';
  }

  /**
   * Le fil de l'agent : les actualités qu'il n'a jamais vues, en vigueur, chacune avec ses dossiers concernés ; une
   * actualité ciblée qui ne touche aucun de ses dossiers n'est pas montrée. Ce qui est rendu est marqué vu, une fois
   * pour toutes : le même fil redemandé ne le rend plus [R269].
   */
  async feed(viewer: Viewer): Promise<{ ok: true; value: FeedItem[] } | Refusal> {
    if (!(await this.activeAgent(viewer))) return this.refuse(viewer, `agent:${viewer.userId}`, viewer.role === 'agent' ? 'agent_inactive' : 'role');
    const today = this.today();
    const rows = await this.db.all<Row>(
      `SELECT n.id, n.topic, n.title, n.impact, n.source_name, n.source_url, n.source_date, n.target, n.published_on
         FROM network_news n
        WHERE n.network_id = ? AND n.published_on >= ? AND n.published_on <= ?
          AND NOT EXISTS (SELECT 1 FROM network_news_withdrawals w WHERE w.news_id = n.id)
          AND NOT EXISTS (SELECT 1 FROM network_news_deliveries d WHERE d.news_id = n.id AND d.agent_id = ?)
        ORDER BY n.published_on DESC, n.set_at DESC, n.id`,
      [viewer.networkId, addDays(today, -NEWS_WINDOW_DAYS), today, viewer.userId],
    );
    const dossiers = rows.length > 0 ? await this.dossiersOf(viewer.networkId, viewer.userId) : [];
    const items: FeedItem[] = [];
    for (const r of rows) {
      const v = toView(r);
      const concerned: ConcernedDossier[] = [];
      if (!isWholeNetwork(v.target)) {
        for (const d of dossiers) {
          const why = Actualites.match(v.target, d);
          if (why) concerned.push({ propertyId: d.id, reference: d.reference, why });
        }
        // Ciblée, et aucun de ses dossiers n'est touché : du bruit pour lui, pas montrée (elle pourra l'être plus tard).
        if (concerned.length === 0) continue;
      }
      // Réservée avant d'être rendue : deux fils demandés en même temps ne la montrent qu'une fois.
      const res = await this.db.run('INSERT OR IGNORE INTO network_news_deliveries (news_id, agent_id, network_id, concerned, shown_at) VALUES (?, ?, ?, ?, ?)', [v.id, viewer.userId, viewer.networkId, concerned.length, this.now().toISOString()]);
      if (res.changes === 0) continue;
      items.push({ ...v, concerned });
    }
    // Celles qui touchent ses dossiers d'abord, puis les plus récentes.
    items.sort((a, b) => Number(b.concerned.length > 0) - Number(a.concerned.length > 0));
    await appendEvent(this.journal, { type: 'actualite.montree', actor: this.actor(viewer), subject: `agent:${viewer.userId}`, data: { rule: 'R269', count: items.length, concerned: items.filter((i) => i.concerned.length > 0).length } }, this.now);
    return { ok: true, value: items };
  }
}
