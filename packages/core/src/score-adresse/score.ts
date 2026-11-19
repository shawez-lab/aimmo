/**
 * Score de vente par adresse (HX17) [R291, R292, R293].
 *
 * - Le score d'une adresse est la somme de points tirés d'une liste fermée de signaux publics, chacun avec sa donnée,
 *   sa source et sa date : diagnostic énergétique récent (ADEME), date d'interdiction de louer proche (ADEME et M15),
 *   ventes du voisinage (DVF, en compte seulement), grande parcelle (cadastre). Ce qui manque est dit avec sa raison,
 *   jamais remplacé. Le calcul est une fonction pure : les mêmes données, le même jour, donnent le même score [R291].
 * - Lecture prudente des ventes publiques : jamais la vente d'une adresse, jamais sa date ni son prix, donc jamais la
 *   durée de détention d'un propriétaire. Seul le nombre de ventes dans un rayon de 200 m entre au calcul [R29, R37].
 *   Aucun nom, aucun propriétaire n'est cherché ni rangé ; une adresse qui porte un nom est refusée [R291, R292].
 * - Seul un agent en activité note une adresse d'une commune de ses zones ; la direction lit tout le réseau. Rien
 *   n'est envoyé ; au journal, des identifiants, le score et sa tranche, jamais l'adresse [R292, R13].
 * - Jamais vu : en face du score, le taux de mandats réellement signés par tranche, lu dans les mandats de G03 que
 *   mesure G10. L'agent du mandat le relie à l'adresse notée ; seul compte un mandat signé dans l'année qui suit le
 *   premier score de l'adresse. Le taux ne se calcule que sur les adresses dont l'année est close [R293, R144].
 */
import type { Viewer } from '../acces/droits.ts';
import { agentState } from '../acces/etat-agent.ts';
import { communeSlug } from '../attirer/liste-biens.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { localTime } from '../envoi/horaires.ts';
import { CollecteBien, SOURCES, type CadastreService, type EnergyService, type Geocoder } from '../estimation/collecte.ts';
import { DEFAULT_RANGE_SETTINGS, departmentOf, distance, type EstimatedKind, type Sale, type SalesCoverage } from '../estimation/fourchette.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import { banDate, dayInFrench, territoryOf } from '../location/logement.ts';
import { addressCarriesPerson } from '../veille-dpe/veille.ts';

/** La même lecture que la veille des diagnostics : le titre d'une voie n'est pas une personne [R292]. */
export { addressCarriesPerson };

const TIME_ZONE = 'Europe/Paris';
const DAY_MS = 86_400_000;
/** Le rayon du voisinage dont les ventes sont comptées, en mètres. */
export const NEIGHBOURHOOD_RADIUS_M = 200;
/** La fenêtre dans laquelle un mandat signé compte pour le premier score d'une adresse. */
export const MANDATE_WINDOW_DAYS = 365;

export const SCORE_BANDS = ['faible', 'moyen', 'fort', 'tres_fort'] as const;
export type ScoreBand = (typeof SCORE_BANDS)[number];
export const BAND_LABELS: Readonly<Record<ScoreBand, string>> = { faible: '0 à 14 points', moyen: '15 à 34 points', fort: '35 à 54 points', tres_fort: '55 points et plus' };

export const SIGNALS = ['diagnostic_recent', 'interdiction_louer', 'ventes_voisinage', 'grande_parcelle'] as const;
export type Signal = (typeof SIGNALS)[number];

/** Les données publiques lues pour une adresse, liste fermée : rien d'autre n'entre au calcul [R291]. */
export interface AddressFacts {
  address: { key: string; label: string; postcode: string; commune: string; inseeCode: string };
  energy: { energyClass: 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G'; diagnosedOn: string; number: string | null; source: string } | null;
  parcel: { id: string; areaM2: number | null; source: string; readOn: string } | null;
  /** Le nombre de ventes publiées dans le rayon, toutes années publiées : un compte, jamais une vente [R29]. */
  sales: { count: number; years: number[]; lastSale: string; source: string; radiusM: number } | null;
  /** Les sources qui n'ont rien donné, avec la raison. */
  missing: { source: string; reason: string }[];
}

export interface ScorePoint {
  signal: Signal;
  points: number;
  /** La donnée publique, en mots : aucun nom, aucune vente [R291]. */
  fact: string;
  source: string;
  /** La date de la donnée, `AAAA-MM-JJ`. */
  date: string;
}

export interface AddressScore {
  score: number;
  band: ScoreBand;
  points: ScorePoint[];
}

const shiftDay = (day: string, days: number): string => new Date(Date.parse(`${day}T12:00:00.000Z`) + days * DAY_MS).toISOString().slice(0, 10);
const daysBetween = (from: string, to: string): number => Math.round((Date.parse(`${to}T12:00:00.000Z`) - Date.parse(`${from}T12:00:00.000Z`)) / DAY_MS);

/** La source de la date d'interdiction de louer, reprise de M15. */
export const BAN_SOURCE = 'Loi Climat et résilience, article L173-2 du code de la construction et de l’habitation (M15)';

export function bandOf(score: number): ScoreBand {
  if (score >= 55) return 'tres_fort';
  if (score >= 35) return 'fort';
  if (score >= 15) return 'moyen';
  return 'faible';
}

/**
 * Le score d'une adresse, par les seules règles écrites ici : une fonction pure, rejouable. Chaque point cite sa
 * donnée, sa source et sa date ; une donnée absente ne donne aucun point [R291].
 */
export function computeScore(facts: AddressFacts, today: string): AddressScore {
  const points: ScorePoint[] = [];
  const e = facts.energy;
  if (e && e.diagnosedOn <= today) {
    const age = daysBetween(e.diagnosedOn, today);
    const p = age <= 180 ? 35 : age <= 365 ? 20 : 0;
    if (p > 0) points.push({ signal: 'diagnostic_recent', points: p, fact: `Diagnostic énergétique établi le ${dayInFrench(e.diagnosedOn)} : il est demandé pour vendre ou pour louer.`, source: e.source, date: e.diagnosedOn });
    const ban = e.energyClass === 'E' || e.energyClass === 'F' || e.energyClass === 'G' ? banDate(e.energyClass, territoryOf(facts.address.inseeCode || facts.address.postcode)) : null;
    if (ban !== null && ban <= shiftDay(today, 3 * 365)) {
      const when = ban <= today ? `ne peut plus être loué depuis le ${dayInFrench(ban)}` : `ne pourra plus être loué à partir du ${dayInFrench(ban)}`;
      points.push({
        signal: 'interdiction_louer',
        points: 20,
        fact: `Logement classé ${e.energyClass} par le diagnostic du ${dayInFrench(e.diagnosedOn)} (${e.source}) : il ${when}.`,
        source: BAN_SOURCE,
        date: ban,
      });
    }
  }
  const s = facts.sales;
  if (s && s.years.length > 0) {
    const perYear = s.count / s.years.length;
    const p = perYear >= 8 ? 15 : perYear >= 3 ? 8 : 0;
    if (p > 0) {
      const shown = Math.round(perYear * 10) / 10;
      points.push({
        signal: 'ventes_voisinage',
        points: p,
        fact: `${String(shown).replace('.', ',')} ventes par an en moyenne à moins de ${s.radiusM} m, de ${Math.min(...s.years)} à ${Math.max(...s.years)}.`,
        source: s.source,
        date: s.lastSale,
      });
    }
  }
  const c = facts.parcel;
  if (c && c.areaM2 !== null && c.areaM2 >= 1500) {
    points.push({ signal: 'grande_parcelle', points: 10, fact: `Parcelle cadastrale de ${Math.round(c.areaM2)} m² : un terrain qui peut se diviser.`, source: c.source, date: c.readOn });
  }
  const score = Math.min(100, points.reduce((n, p) => n + p.points, 0));
  return { score, band: bandOf(score), points };
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** L'empreinte des données lues, dans un ordre fixe : deux jeux égaux ont la même [R291]. */
export const factsHash = (f: AddressFacts): Promise<string> =>
  sha256Hex(
    JSON.stringify([
      [f.address.key, f.address.label, f.address.postcode, f.address.commune, f.address.inseeCode],
      f.energy ? [f.energy.energyClass, f.energy.diagnosedOn, f.energy.number, f.energy.source] : null,
      f.parcel ? [f.parcel.id, f.parcel.areaM2, f.parcel.source, f.parcel.readOn] : null,
      f.sales ? [f.sales.count, [...f.sales.years].sort((a, b) => a - b), f.sales.lastSale, f.sales.source, f.sales.radiusM] : null,
      [...f.missing].map((m) => [m.source, m.reason]).sort(),
    ]),
  );

export interface ScoreServices {
  geocoder: Geocoder;
  cadastre: CadastreService;
  energy: EnergyService;
  /** Les ventes publiées (DVF), lues seulement pour être comptées dans le rayon [R29]. */
  sales: CountableSales;
}

/** Les ventes publiées : la couverture, et les ventes des tuiles autour d'un point avec le nombre de problèmes. */
export interface CountableSales {
  coverage(): Promise<SalesCoverage | null>;
  scan(kind: EstimatedKind, lat: number, lon: number, radius: number): Promise<{ sales: Sale[]; issues: number }>;
}

const SALES_SOURCE = 'Demandes de valeurs foncières (DGFiP)';

type Refusal = { ok: false; rule: 'R16'; code: string };
type Problem = { ok: false; rule: 'R291' | 'R292' | 'R293' | null; code: string };

export interface StoredScore extends AddressScore {
  scoreId: string;
  address: { label: string; postcode: string; commune: string };
  scoredOn: string;
  factsHash: string;
  missing: { source: string; reason: string }[];
}

export interface BandMeasure {
  band: ScoreBand;
  label: string;
  /** Adresses notées dont c'est le premier score. */
  scored: number;
  /** Parmi elles, celles dont l'année qui suit le premier score est close. */
  closed: number;
  /** Mandats signés dans l'année, reliés à ces adresses : toutes, puis celles dont l'année est close. */
  signed: number;
  signedClosed: number;
  /** Mandats signés par adresse notée, sur les seules années closes ; `null` sans année close [R293]. */
  rate: number | null;
}

interface ScoreRow {
  id: string;
  label: string;
  postcode: string;
  commune: string;
  commune_slug: string;
  score: number;
  band: ScoreBand;
  points: string;
  facts_hash: string;
  scored_on: string;
}

export interface ScoreAdresseOptions {
  now?: () => Date;
  newId?: () => string;
}

const isDay = (v: string): boolean => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const t = Date.parse(`${v}T00:00:00.000Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === v;
};

export class ScoreAdresse {
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(
    private readonly db: SqlDatabase,
    private readonly services: ScoreServices | null,
    private readonly journal: JournalStore,
    options: ScoreAdresseOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => crypto.randomUUID());
  }

  private actor(viewer: Viewer): string {
    return `${String(viewer.role)}:${viewer.userId}`;
  }

  private today(): string {
    return localTime(this.now(), TIME_ZONE).date;
  }

  private async refuse(viewer: Viewer, subject: string | null, code: string): Promise<Refusal> {
    await appendEvent(this.journal, { type: 'acces.refuse', actor: this.actor(viewer), subject, data: { rule: 'R16', role: String(viewer.role), kind: 'score_adresse', code } }, this.now);
    return { ok: false, rule: 'R16', code };
  }

  private async member(viewer: Viewer, direction: boolean): Promise<Refusal | null> {
    if (viewer.role === 'direction' && direction) return null;
    if (viewer.role !== 'agent') return this.refuse(viewer, null, 'role');
    const a = await this.db.first<{ id: string }>('SELECT id FROM agents WHERE id = ? AND network_id = ?', [viewer.userId, viewer.networkId]);
    if (!a || (await agentState(this.db, viewer.networkId, viewer.userId, this.now())) !== 'actif') return this.refuse(viewer, null, 'agent_inactive');
    return null;
  }

  private async zoneSlugs(networkId: string, agentId: string): Promise<Set<string>> {
    const rows = await this.db.all<{ commune: string }>('SELECT commune FROM agent_zones WHERE network_id = ? AND ended_at IS NULL AND agent_id = ?', [networkId, agentId]);
    return new Set(rows.map((r) => communeSlug(r.commune)));
  }

  /** Les données publiques de l'adresse, par les services ; ce qui manque est dit avec sa raison [R291]. */
  private async collect(address: string, services: ScoreServices): Promise<{ ok: true; facts: AddressFacts; slug: string } | Problem> {
    const collecte = new CollecteBien({ geocoder: services.geocoder, cadastre: services.cadastre, energy: services.energy, risks: { risksAt: async () => [] } }, { now: this.now });
    const found = await collecte.collect(address);
    if (!found.address.ok) return { ok: false, rule: 'R291', code: found.address.reason === 'adresse_incertaine' ? 'adresse_incertaine' : 'adresse_introuvable' };
    const g = found.address.value;
    if (!/^\d/.test(g.label.trim())) return { ok: false, rule: 'R291', code: 'sans_numero' };
    if (addressCarriesPerson(g.label) || addressCarriesPerson(g.town)) return { ok: false, rule: 'R292', code: 'nom_dans_adresse' };
    const missing: { source: string; reason: string }[] = [];
    // Seuls les champs nommés ici sont repris : tout autre champ rendu par un service est ignoré [R291].
    let energy: AddressFacts['energy'] = null;
    if (found.energy.ok && isDay(found.energy.value.date)) {
      const v = found.energy.value;
      energy = { energyClass: v.energyClass, diagnosedOn: v.date, number: typeof v.diagnosisNumber === 'string' && /^[A-Z0-9]{8,24}$/.test(v.diagnosisNumber) ? v.diagnosisNumber : null, source: SOURCES.energy };
    } else missing.push({ source: SOURCES.energy, reason: found.energy.ok ? 'illisible' : found.energy.reason });
    let parcel: AddressFacts['parcel'] = null;
    if (found.parcel.ok) {
      const v = found.parcel.value;
      parcel = { id: String(v.id), areaM2: typeof v.area === 'number' && Number.isFinite(v.area) && v.area > 0 ? v.area : null, source: SOURCES.parcel, readOn: found.parcel.collectedAt.slice(0, 10) };
      // Une parcelle sans contenance publiée : le signal ne peut pas se juger, et cela se dit [R291].
      if (parcel.areaM2 === null) missing.push({ source: SOURCES.parcel, reason: 'contenance_absente' });
    } else missing.push({ source: SOURCES.parcel, reason: found.parcel.reason });
    let sales: AddressFacts['sales'] = null;
    const department = departmentOf(g.postalCode);
    try {
      const coverage = await services.sales.coverage();
      if (department === null || DEFAULT_RANGE_SETTINGS.dvfNotCovered.includes(department)) missing.push({ source: SALES_SOURCE, reason: 'dvf_non_couvert' });
      else if (!coverage || coverage.years.length === 0) missing.push({ source: SALES_SOURCE, reason: 'introuvable' });
      else if (coverage.department !== department) missing.push({ source: coverage.source, reason: 'hors_zone' });
      else {
        const [flats, houses] = await Promise.all([services.sales.scan('apartment', g.lat, g.lon, NEIGHBOURHOOD_RADIUS_M), services.sales.scan('house', g.lat, g.lon, NEIGHBOURHOOD_RADIUS_M)]);
        // Une tuile absente ou illisible : le compte serait faux, il n'est pas fait [R291].
        if (flats.issues + houses.issues > 0) missing.push({ source: coverage.source, reason: 'illisible' });
        else {
          // Les tuiles débordent le rayon : seules comptent les ventes à moins de 200 m. Un compte, rien d'autre : ni
          // prix, ni date, ni position d'une vente ne sortent d'ici [R29, R37].
          const near = [...flats.sales, ...houses.sales].filter((v) => distance(g.lat, g.lon, v.lat, v.lon) <= NEIGHBOURHOOD_RADIUS_M).length;
          sales = { count: near, years: [...coverage.years].sort((x, y) => x - y), lastSale: coverage.lastSale, source: coverage.source, radiusM: NEIGHBOURHOOD_RADIUS_M };
        }
      }
    } catch {
      missing.push({ source: SALES_SOURCE, reason: 'panne' });
    }
    const key = g.banId && /^[\w-]{3,80}$/.test(g.banId) ? `ban:${g.banId}` : `label:${communeSlug(g.label)}`;
    return {
      ok: true,
      slug: communeSlug(g.town),
      facts: { address: { key, label: g.label.trim().slice(0, 200), postcode: g.postalCode, commune: g.town, inseeCode: g.inseeCode }, energy, parcel, sales, missing },
    };
  }

  /**
   * Noter une adresse : un agent en activité, une adresse d'une commune de ses zones, sans nom [R292]. Le score du jour
   * est rangé une fois par adresse ; noté de nouveau le même jour, le premier rangé est rendu [R291].
   */
  async score(viewer: Viewer, input: { address: unknown }): Promise<{ ok: true; value: StoredScore } | Refusal | Problem> {
    const blocked = await this.member(viewer, false);
    if (blocked) return blocked;
    if (typeof input.address !== 'string' || /[\r\n\t<>]/.test(input.address)) return { ok: false, rule: null, code: 'bad_address' };
    const address = input.address.trim().replace(/\s+/g, ' ');
    if (address.length < 5 || address.length > 200) return { ok: false, rule: null, code: 'bad_address' };
    if (addressCarriesPerson(address)) return { ok: false, rule: 'R292', code: 'nom_dans_adresse' };
    if (!this.services) return { ok: false, rule: null, code: 'sources_absentes' };
    const read = await this.collect(address, this.services);
    if (!read.ok) return read;
    const zones = await this.zoneSlugs(viewer.networkId, viewer.userId);
    if (!zones.has(read.slug)) return this.refuse(viewer, null, 'hors_zone');
    const today = this.today();
    const result = computeScore(read.facts, today);
    const hash = await factsHash(read.facts);
    const id = this.newId();
    const f = read.facts.address;
    const { changes } = await this.db.run(
      `INSERT INTO address_scores (id, network_id, agent_id, address_key, label, postcode, commune, commune_slug, score, band, points, facts_hash, scored_on, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (network_id, address_key, scored_on) DO NOTHING`,
      [id, viewer.networkId, viewer.userId, f.key, f.label, f.postcode, f.commune, read.slug, result.score, result.band, JSON.stringify({ points: result.points, missing: read.facts.missing }), hash, today, this.now().toISOString()],
    );
    const row = await this.db.first<ScoreRow>('SELECT id, label, postcode, commune, commune_slug, score, band, points, facts_hash, scored_on FROM address_scores WHERE network_id = ? AND address_key = ? AND scored_on = ?', [
      viewer.networkId,
      f.key,
      today,
    ]);
    if (!row) return { ok: false, rule: null, code: 'introuvable' };
    if (changes === 1) {
      await appendEvent(this.journal, { type: 'score_adresse.calcule', actor: this.actor(viewer), subject: `address_score:${row.id}`, data: { rule: 'R291', score: row.score, band: row.band, points: result.points.length } }, this.now);
    }
    return { ok: true, value: this.stored(row) };
  }

  private stored(r: ScoreRow): StoredScore {
    const p = JSON.parse(r.points) as { points: ScorePoint[]; missing: { source: string; reason: string }[] };
    return { scoreId: r.id, address: { label: r.label, postcode: r.postcode, commune: r.commune }, scoredOn: r.scored_on, score: Number(r.score), band: r.band, points: p.points, missing: p.missing, factsHash: r.facts_hash };
  }

  /**
   * Les adresses notées, le dernier score de chacune, du plus fort au plus faible : celles des communes de ses zones
   * pour l'agent, tout le réseau pour la direction [R292].
   */
  async list(viewer: Viewer): Promise<{ ok: true; scores: StoredScore[] } | Refusal> {
    const blocked = await this.member(viewer, true);
    if (blocked) return blocked;
    const rows = await this.db.all<ScoreRow>(
      `SELECT s.id, s.label, s.postcode, s.commune, s.commune_slug, s.score, s.band, s.points, s.facts_hash, s.scored_on FROM address_scores s
        WHERE s.network_id = ? AND s.scored_on = (SELECT MAX(t.scored_on) FROM address_scores t WHERE t.network_id = s.network_id AND t.address_key = s.address_key)
        ORDER BY s.score DESC, s.scored_on DESC, s.id`,
      [viewer.networkId],
    );
    if (viewer.role === 'direction') return { ok: true, scores: rows.map((r) => this.stored(r)) };
    const zones = await this.zoneSlugs(viewer.networkId, viewer.userId);
    return { ok: true, scores: rows.filter((r) => zones.has(r.commune_slug)).map((r) => this.stored(r)) };
  }

  /**
   * Relier un mandat signé à une adresse notée : l'agent du mandat, ou la direction. Le mandat doit être signé après le
   * premier score de l'adresse et dans l'année qui suit, pour un bien de la même commune. Une fois par mandat, une fois
   * par adresse [R293].
   */
  async linkMandate(viewer: Viewer, input: { scoreId: string; mandateId: string }): Promise<{ ok: true } | Refusal | Problem> {
    const blocked = await this.member(viewer, true);
    if (blocked) return blocked;
    const s = await this.db.first<{ address_key: string; commune_slug: string }>('SELECT address_key, commune_slug FROM address_scores WHERE id = ? AND network_id = ?', [input.scoreId, viewer.networkId]);
    if (!s) return { ok: false, rule: null, code: 'unknown_score' };
    const m = await this.db.first<{ id: string; agent_id: string; signed_at: string; city: string | null }>(
      'SELECT m.id, m.agent_id, m.signed_at, p.city FROM mandates m LEFT JOIN properties p ON p.id = m.property_id AND p.network_id = m.network_id WHERE m.id = ? AND m.network_id = ?',
      [input.mandateId, viewer.networkId],
    );
    if (!m) return { ok: false, rule: null, code: 'unknown_mandate' };
    if (viewer.role === 'agent' && m.agent_id !== viewer.userId) return this.refuse(viewer, `address_score:${input.scoreId}`, 'pas_son_mandat');
    const first = await this.db.first<{ id: string; scored_on: string }>('SELECT id, scored_on FROM address_scores WHERE network_id = ? AND address_key = ? ORDER BY created_at, id LIMIT 1', [viewer.networkId, s.address_key]);
    // Au jour de Paris : un mandat signé le jour du premier score compte, quelle que soit l'heure [R293].
    const signedOn = localTime(new Date(m.signed_at), TIME_ZONE).date;
    if (signedOn < first!.scored_on) return { ok: false, rule: 'R293', code: 'mandat_avant_score' };
    if (signedOn > shiftDay(first!.scored_on, MANDATE_WINDOW_DAYS)) return { ok: false, rule: 'R293', code: 'mandat_hors_annee' };
    // Un bien sans commune ne se relie à aucune adresse : il gonflerait n'importe quelle tranche.
    if (m.city === null || m.city.trim() === '') return { ok: false, rule: 'R293', code: 'commune_inconnue' };
    if (communeSlug(m.city) !== s.commune_slug) return { ok: false, rule: 'R293', code: 'autre_commune' };
    const { changes } = await this.db.run('INSERT INTO address_score_mandates (mandate_id, network_id, address_key, score_id, linked_by, linked_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING', [
      m.id,
      viewer.networkId,
      s.address_key,
      first!.id,
      this.actor(viewer),
      this.now().toISOString(),
    ]);
    if (changes !== 1) return { ok: false, rule: 'R293', code: 'deja_relie' };
    await appendEvent(this.journal, { type: 'score_adresse.mandat_relie', actor: this.actor(viewer), subject: `address_score:${first!.id}`, data: { rule: 'R293', mandate: m.id } }, this.now);
    return { ok: true };
  }

  /**
   * Jamais vu : le taux de mandats réellement signés par tranche de score, sur le premier score de chaque adresse.
   * Tout se recalcule depuis la base ; aucune adresse, aucun nom dans le compte rendu [R293, R144, R13].
   */
  async measure(viewer: Viewer): Promise<{ ok: true; bands: BandMeasure[] } | Refusal> {
    const blocked = await this.member(viewer, true);
    if (blocked) return blocked;
    const closedBy = shiftDay(this.today(), -MANDATE_WINDOW_DAYS);
    const rows = await this.db.all<{ band: ScoreBand; scored_on: string; signed_at: string | null }>(
      `SELECT f.band, f.scored_on, m.signed_at
         FROM address_scores f
         LEFT JOIN address_score_mandates l ON l.network_id = f.network_id AND l.address_key = f.address_key
         LEFT JOIN mandates m ON m.id = l.mandate_id AND m.network_id = f.network_id
        WHERE f.network_id = ?
          AND f.id = (SELECT t.id FROM address_scores t WHERE t.network_id = f.network_id AND t.address_key = f.address_key ORDER BY t.created_at, t.id LIMIT 1)`,
      [viewer.networkId],
    );
    const bands: BandMeasure[] = SCORE_BANDS.map((band) => ({ band, label: BAND_LABELS[band], scored: 0, closed: 0, signed: 0, signedClosed: 0, rate: null }));
    for (const r of rows) {
      const b = bands.find((x) => x.band === r.band)!;
      // L'année d'une adresse est close quand son dernier jour est passé.
      const closed = r.scored_on < closedBy;
      const on = r.signed_at === null ? null : localTime(new Date(r.signed_at), TIME_ZONE).date;
      const counted = on !== null && on >= r.scored_on && on <= shiftDay(r.scored_on, MANDATE_WINDOW_DAYS);
      b.scored += 1;
      if (closed) b.closed += 1;
      if (counted) b.signed += 1;
      if (counted && closed) b.signedClosed += 1;
    }
    for (const b of bands) b.rate = b.closed === 0 ? null : Math.round((b.signedClosed / b.closed) * 1000) / 1000;
    return { ok: true, bands };
  }
}
