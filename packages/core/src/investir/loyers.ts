/**
 * Les loyers de marché (M17, Y02) : une estimation lue dans la base, jamais écrite dans le code ni lue en direct sur
 * Internet [R122]. Deux sources, dans cet ordre :
 *
 * 1. la Carte des loyers de l'ANIL, importée par la direction, un fichier par type de logement et par millésime,
 *    rangée avec sa source, son millésime et l'empreinte du fichier ; citée exactement comme l'ANIL le demande ;
 * 2. à défaut, les locations du réseau (M15) : les logements remis aux locataires dans la commune sur les 24 derniers
 *    mois, s'il y en a au moins 5 (réglages).
 *
 * La réponse dit toujours sa source, sa date et sa fiabilité : « peu d'observations » sous 30 observations ou quand
 * l'intervalle de prévision est plus large que 40 % du loyer (réglages). Sans donnée, elle dit « inconnu », jamais une
 * valeur inventée [R10]. Un fichier mal formé est refusé ligne à ligne, sans rien ranger.
 */
import type { Viewer } from '../acces/droits.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';

/** La mention exacte demandée par l'ANIL pour toute réutilisation de la Carte des loyers [R122]. */
export const ANIL_CITATION = 'Estimations ANIL, à partir des données du Groupe SeLoger et de leboncoin';

/** Les types de logement d'un fichier de la Carte des loyers. */
export const MARKET_RENT_KINDS = ['apartment', 'apartment_t1_t2', 'apartment_t3_plus', 'house'] as const;
export type MarketRentKind = (typeof MARKET_RENT_KINDS)[number];

export interface MarketRentSettings {
  /** Sous ce nombre d'observations, la réponse dit « peu d'observations ». */
  minObservations: number;
  /** Un intervalle plus large que ce pourcentage du loyer dit « peu d'observations ». */
  maxIntervalPct: number;
  /** Le nombre de locations du réseau qu'il faut dans la commune pour s'en servir. */
  minNetworkRentals: number;
  /** La fenêtre des locations du réseau, en mois. */
  networkMonths: number;
}

export const DEFAULT_MARKET_RENT_SETTINGS: Readonly<MarketRentSettings> = Object.freeze({
  minObservations: 30,
  maxIntervalPct: 40,
  minNetworkRentals: 5,
  networkMonths: 24,
});

/** Au plus ce nombre de lignes par fichier : la Carte des loyers compte moins de 36 000 communes. */
export const MAX_IMPORT_ROWS = 40_000;
/** Un loyer au m² au-delà est refusé comme mal lu. */
const MAX_RENT_M2_CENTS = 100_000;

const INSEE = /^(?:\d{5}|2[AB]\d{3})$/;

export interface MarketRentRow {
  inseeCode: string;
  rentM2Cents: number;
  lowerM2Cents: number;
  upperM2Cents: number;
  observations: number;
}

export interface RowError {
  /** Le numéro de ligne dans le fichier, en-tête compris (l'en-tête est la ligne 1). */
  line: number;
  /** `colonnes`, `insee`, `loyer`, `bornes`, `observations`, `doublon`. */
  code: string;
}

export type ParseResult = { ok: true; rows: MarketRentRow[] } | { ok: false; code: 'entete' | 'vide' | 'trop_long' | 'lignes'; errors: RowError[] };

/**
 * Lit un nombre décimal écrit en texte (virgule ou point) et le rend en centimes, arrondi au centime le plus proche,
 * la moitié vers le haut. Calcul sur les chiffres, sans virgule flottante : « 11,005 » donne 1101.
 */
export function decimalToCents(text: string): number | null {
  const m = /^(\d{1,7})(?:[.,](\d{1,12}))?$/.exec(text.trim());
  if (!m) return null;
  const whole = Number(m[1]);
  const frac = (m[2] ?? '').padEnd(3, '0');
  const cents = whole * 100 + Number(frac.slice(0, 2));
  return Number(frac[2]) >= 5 ? cents + 1 : cents;
}

/** Découpe une ligne CSV : séparateur donné, champs éventuellement entre guillemets doubles. */
function splitLine(line: string, sep: string): string[] | null {
  // Un guillemet mal placé ou non refermé rend la ligne mal formée : jamais corrigée en silence.
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  let closed = false;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i]!;
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else if (c === '"') {
        quoted = false;
        closed = true;
      } else cur += c;
    } else if (c === sep) {
      out.push(cur);
      cur = '';
      closed = false;
    } else if (c === '"') {
      if (cur.trim() !== '' || closed) return null;
      cur = '';
      quoted = true;
    } else if (closed) {
      if (c.trim() !== '') return null;
    } else cur += c;
  }
  if (quoted) return null;
  out.push(cur);
  return out.map((v) => v.trim());
}

/** Les colonnes lues dans le fichier de la Carte des loyers ; les autres sont laissées. */
const COLUMNS = { insee: 'insee_c', rent: 'loypredm2', lower: 'lwr.ipm2', upper: 'upr.ipm2', observations: 'nbobs_com' } as const;

/**
 * Lit un fichier au format de la Carte des loyers de l'ANIL : séparateur `;` (ou `,`), en-tête avec au moins
 * `INSEE_C`, `loypredm2`, `lwr.IPm2`, `upr.IPm2`, `nbobs_com`. Toutes les lignes sont contrôlées ; une seule fausse
 * et le fichier entier est refusé, avec la liste des lignes en cause.
 */
export function parseAnilCsv(text: string): ParseResult {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  while (lines.length > 0 && lines.at(-1)!.trim() === '') lines.pop();
  if (lines.length < 2) return { ok: false, code: 'vide', errors: [] };
  if (lines.length - 1 > MAX_IMPORT_ROWS) return { ok: false, code: 'trop_long', errors: [] };
  const head = lines[0]!;
  const sep = head.includes(';') ? ';' : ',';
  const headCells = splitLine(head, sep);
  if (headCells === null) return { ok: false, code: 'entete', errors: [] };
  const names = headCells.map((h) => h.toLowerCase());
  const index = Object.fromEntries(Object.entries(COLUMNS).map(([k, name]) => [k, names.indexOf(name)])) as Record<keyof typeof COLUMNS, number>;
  if (Object.values(index).some((i) => i < 0)) return { ok: false, code: 'entete', errors: [] };
  const rows: MarketRentRow[] = [];
  const errors: RowError[] = [];
  const seen = new Set<string>();
  for (let n = 1; n < lines.length; n += 1) {
    const line = n + 1;
    const cells = splitLine(lines[n]!, sep);
    if (cells === null) {
      errors.push({ line, code: 'guillemets' });
      continue;
    }
    if (cells.length !== names.length) {
      errors.push({ line, code: 'colonnes' });
      continue;
    }
    const insee = cells[index.insee]!;
    if (!INSEE.test(insee)) {
      errors.push({ line, code: 'insee' });
      continue;
    }
    const rent = decimalToCents(cells[index.rent]!);
    const lower = decimalToCents(cells[index.lower]!);
    const upper = decimalToCents(cells[index.upper]!);
    if (rent === null || rent <= 0 || rent > MAX_RENT_M2_CENTS) {
      errors.push({ line, code: 'loyer' });
      continue;
    }
    if (lower === null || upper === null || lower <= 0 || lower > rent || upper < rent || upper > MAX_RENT_M2_CENTS) {
      errors.push({ line, code: 'bornes' });
      continue;
    }
    const obsText = cells[index.observations]!;
    if (!/^\d{1,9}$/.test(obsText)) {
      errors.push({ line, code: 'observations' });
      continue;
    }
    if (seen.has(insee)) {
      errors.push({ line, code: 'doublon' });
      continue;
    }
    seen.add(insee);
    rows.push({ inseeCode: insee, rentM2Cents: rent, lowerM2Cents: lower, upperM2Cents: upper, observations: Number(obsText) });
  }
  if (errors.length > 0) return { ok: false, code: 'lignes', errors };
  return { ok: true, rows };
}

export type Reliability = 'fiable' | 'peu_observations';

/** Un loyer de marché connu, avec tout ce qui permet de le citer et d'en juger. */
export interface KnownMarketRent {
  status: 'connu';
  inseeCode: string;
  /** Le type demandé, ou `all` pour les locations du réseau, tous types confondus. */
  kind: MarketRentKind | 'all';
  rentM2Cents: number;
  lowerM2Cents: number;
  upperM2Cents: number;
  observations: number;
  source: 'anil' | 'reseau';
  /** La phrase à citer avec le chiffre. */
  citation: string;
  /** Le millésime de la Carte des loyers, `null` pour le réseau. */
  vintage: number | null;
  /** La date de l'import, ou du calcul pour le réseau. */
  asOf: string;
  /** L'import d'où vient le chiffre, `null` pour le réseau. */
  importId: string | null;
  reliability: Reliability;
  /** Pourquoi « peu d'observations » : `observations`, `intervalle`. */
  reasons: ('observations' | 'intervalle')[];
}
export type MarketRent = KnownMarketRent | { status: 'inconnu'; inseeCode: string; kind: MarketRentKind };

export type ImportResult =
  | {
      ok: true;
      importId: string;
      rows: number;
      /** Les lignes rangées à ce jour ; `en_cours` : rappeler avec le même fichier pour la suite. */
      stored: number;
      status: 'en_cours' | 'complet';
      /** L'import vient d'être ouvert par cet appel. */
      created: boolean;
    }
  | { ok: false; rule: 'R16' | 'R122'; code: string; errors?: RowError[] };

export interface LoyersMarcheOptions {
  now?: () => Date;
  newId?: () => string;
  settings?: Partial<MarketRentSettings>;
  maxChunksPerCall?: number;
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** La médiane d'une liste d'entiers ; pour un nombre pair, la moyenne des deux du milieu, arrondie vers le haut. */
export function medianCents(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid]!;
  return Math.ceil((sorted[mid - 1]! + sorted[mid]!) / 2);
}

/** Retire `months` mois à une date ISO, au jour près (un 31 devient le dernier jour du mois). */
function monthsBefore(at: Date, months: number): string {
  const y = at.getUTCFullYear();
  const m = at.getUTCMonth() - months;
  const target = new Date(Date.UTC(y, m, 1));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(at.getUTCDate(), last));
  return target.toISOString().slice(0, 10);
}

/** Les lignes d'un même fichier, par paquets : 16 lignes de 6 valeurs, 96 paramètres, restent sous la limite de D1 (100). */
const CHUNK = 16;
/**
 * Au plus ce nombre de paquets par appel : avec les quelques lectures et écritures autour, un appel reste sous la
 * limite de requêtes d'un Worker sur D1. Un fichier national se range en quelques appels.
 */
export const DEFAULT_MAX_CHUNKS_PER_CALL = 400;

export class LoyersMarche {
  private readonly now: () => Date;
  private readonly newId: () => string;
  readonly settings: MarketRentSettings;
  private readonly maxChunksPerCall: number;

  constructor(
    private readonly db: SqlDatabase,
    private readonly journal: JournalStore,
    options: LoyersMarcheOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => crypto.randomUUID());
    this.settings = { ...DEFAULT_MARKET_RENT_SETTINGS, ...(options.settings ?? {}) };
    this.maxChunksPerCall = Math.max(1, options.maxChunksPerCall ?? DEFAULT_MAX_CHUNKS_PER_CALL);
  }

  /**
   * La direction importe un fichier de la Carte des loyers, pour un type et un millésime. Le fichier entier est
   * contrôlé avant d'écrire quoi que ce soit ; un même fichier importé deux fois ne range rien de plus. Un gros
   * fichier se range en plusieurs appels avec le même fichier, chacun repris après les lignes déjà rangées ; il n'est lu
   * qu'une fois complet.
   */
  async importAnil(viewer: Viewer, input: { kind: unknown; vintage: unknown; csv: unknown }): Promise<ImportResult> {
    const actor = `${String(viewer.role)}:${viewer.userId}`;
    if (viewer.role !== 'direction') {
      await appendEvent(
        this.journal,
        { type: 'acces.refuse', actor, subject: `network:${viewer.networkId}`, data: { rule: 'R16', role: String(viewer.role), kind: 'market_rents', code: 'role' } },
        this.now,
      );
      return { ok: false, rule: 'R16', code: 'role' };
    }
    const refuse = async (code: string, errors?: RowError[]): Promise<ImportResult> => {
      await appendEvent(
        this.journal,
        {
          type: 'investir.loyers.refuse',
          actor,
          subject: `network:${viewer.networkId}`,
          data: { rule: 'R122', code, ...(errors ? { lines: errors.length, first: errors.slice(0, 20).map((e) => ({ line: e.line, code: e.code })) } : {}) },
        },
        this.now,
      );
      return errors ? { ok: false, rule: 'R122', code, errors } : { ok: false, rule: 'R122', code };
    };
    if (typeof input.kind !== 'string' || !(MARKET_RENT_KINDS as readonly string[]).includes(input.kind)) return refuse('type');
    if (typeof input.vintage !== 'number' || !Number.isInteger(input.vintage) || input.vintage < 2000 || input.vintage > this.now().getUTCFullYear() + 1) {
      return refuse('millesime');
    }
    if (typeof input.csv !== 'string') return refuse('vide');
    const parsed = parseAnilCsv(input.csv);
    if (!parsed.ok) return refuse(parsed.code, parsed.code === 'lignes' ? parsed.errors : undefined);
    const kind = input.kind as MarketRentKind;
    const hash = await sha256Hex(input.csv);
    const existing = await this.db.first<{ id: string; status: string }>(
      'SELECT id, status FROM market_rent_imports WHERE network_id = ? AND kind = ? AND file_sha256 = ?',
      [viewer.networkId, kind, hash],
    );
    if (existing && existing.status === 'complet') {
      return { ok: true, importId: existing.id, rows: parsed.rows.length, stored: parsed.rows.length, status: 'complet', created: false };
    }
    // Un import resté en cours (coupure) est repris : ses lignes déjà rangées ne sont pas récrites.
    const importId = existing?.id ?? this.newId();
    if (!existing) {
      const { changes } = await this.db.run(
        `INSERT INTO market_rent_imports (id, network_id, source, kind, vintage, file_sha256, rows_count, status, imported_by, imported_at)
         VALUES (?, ?, 'anil', ?, ?, ?, ?, 'en_cours', ?, ?) ON CONFLICT DO NOTHING`,
        [importId, viewer.networkId, kind, input.vintage, hash, parsed.rows.length, actor, this.now().toISOString()],
      );
      if (changes !== 1) {
        // Le même fichier, importé au même moment : l'autre import fait le travail.
        const other = await this.db.first<{ id: string }>('SELECT id FROM market_rent_imports WHERE network_id = ? AND kind = ? AND file_sha256 = ?', [
          viewer.networkId,
          kind,
          hash,
        ]);
        return { ok: true, importId: other?.id ?? importId, rows: parsed.rows.length, stored: 0, status: 'en_cours', created: false };
      }
    }
    // Reprise après les lignes déjà rangées : chaque paquet est une seule requête, rangé en entier ou pas du tout, dans
    // l'ordre du fichier ; les lignes rangées sont donc toujours le début du fichier.
    const already = Number((await this.db.first<{ n: number }>('SELECT count(*) AS n FROM market_rents WHERE import_id = ?', [importId]))?.n ?? 0);
    const end = Math.min(parsed.rows.length, already + this.maxChunksPerCall * CHUNK);
    for (let i = already; i < end; i += CHUNK) {
      const chunk = parsed.rows.slice(i, Math.min(i + CHUNK, end));
      try {
        await this.db.run(
          `INSERT INTO market_rents (import_id, insee_code, rent_m2_cents, lower_m2_cents, upper_m2_cents, observations) VALUES ${chunk
            .map(() => '(?, ?, ?, ?, ?, ?)')
            .join(', ')} ON CONFLICT DO NOTHING`,
          chunk.flatMap((r) => [importId, r.inseeCode, r.rentM2Cents, r.lowerM2Cents, r.upperM2Cents, r.observations]),
        );
      } catch (error) {
        // Une reprise simultanée a fini l'import entre-temps : il est complet, rien à refaire.
        const done = await this.db.first<{ status: string }>('SELECT status FROM market_rent_imports WHERE id = ?', [importId]);
        if (done?.status === 'complet') return { ok: true, importId, rows: parsed.rows.length, stored: parsed.rows.length, status: 'complet', created: false };
        throw error;
      }
    }
    const stored = Number((await this.db.first<{ n: number }>('SELECT count(*) AS n FROM market_rents WHERE import_id = ?', [importId]))?.n ?? 0);
    if (stored < parsed.rows.length) {
      // Le reste au prochain appel, avec le même fichier : un appel du Worker ne passe pas la limite de requêtes de D1.
      await appendEvent(
        this.journal,
        { type: 'investir.loyers.import', actor, subject: `network:${viewer.networkId}`, data: { import: importId, kind, vintage: input.vintage, stored, rows: parsed.rows.length } },
        this.now,
      );
      return { ok: true, importId, rows: parsed.rows.length, stored, status: 'en_cours', created: !existing };
    }
    if (stored !== parsed.rows.length) throw new Error('loyers de marché : import incohérent');
    await this.db.run("UPDATE market_rent_imports SET status = 'complet', completed_at = ? WHERE id = ? AND status = 'en_cours'", [
      this.now().toISOString(),
      importId,
    ]);
    await appendEvent(
      this.journal,
      { type: 'investir.loyers.import', actor, subject: `network:${viewer.networkId}`, data: { import: importId, kind, vintage: input.vintage, stored, rows: parsed.rows.length } },
      this.now,
    );
    return { ok: true, importId, rows: parsed.rows.length, stored, status: 'complet', created: !existing };
  }

  /**
   * Le loyer de marché d'une commune pour un type de logement : l'import complet le plus récent (millésime, puis
   * date) de ce type, ou à défaut celui des appartements pour un appartement d'un nombre de pièces donné ; puis les
   * locations du réseau ; sinon « inconnu ».
   */
  async marketRent(networkId: string, inseeCode: string, kind: MarketRentKind): Promise<MarketRent> {
    if (!INSEE.test(inseeCode) || !(MARKET_RENT_KINDS as readonly string[]).includes(kind)) return { status: 'inconnu', inseeCode, kind };
    const kinds: MarketRentKind[] = kind.startsWith('apartment_') ? [kind, 'apartment'] : [kind];
    for (const k of kinds) {
      const latest = await this.db.first<{ id: string; vintage: number; completed_at: string }>(
        "SELECT id, vintage, completed_at FROM market_rent_imports WHERE network_id = ? AND kind = ? AND status = 'complet' ORDER BY vintage DESC, imported_at DESC, id DESC LIMIT 1",
        [networkId, k],
      );
      if (!latest) continue;
      const row = await this.db.first<{ rent_m2_cents: number; lower_m2_cents: number; upper_m2_cents: number; observations: number }>(
        'SELECT rent_m2_cents, lower_m2_cents, upper_m2_cents, observations FROM market_rents WHERE import_id = ? AND insee_code = ?',
        [latest.id, inseeCode],
      );
      if (!row) continue;
      return this.known({
        inseeCode,
        kind: k,
        rentM2Cents: row.rent_m2_cents,
        lowerM2Cents: row.lower_m2_cents,
        upperM2Cents: row.upper_m2_cents,
        observations: row.observations,
        source: 'anil',
        citation: `${ANIL_CITATION}, millésime ${latest.vintage}`,
        vintage: latest.vintage,
        asOf: latest.completed_at,
        importId: latest.id,
      });
    }
    return (await this.fromNetwork(networkId, inseeCode)) ?? { status: 'inconnu', inseeCode, kind };
  }

  /** Les logements du réseau remis à un locataire dans la commune, dans la fenêtre réglée : loyer et charges au m². */
  private async fromNetwork(networkId: string, inseeCode: string): Promise<KnownMarketRent | null> {
    const now = this.now();
    const since = monthsBefore(now, this.settings.networkMonths);
    const today = now.toISOString().slice(0, 10);
    const rows = await this.db.all<{ rent_cents: number; charges_cents: number; living_area_hundredths: number }>(
      `SELECT f.rent_cents, f.charges_cents, f.living_area_hundredths
         FROM rental_handovers h
         JOIN rental_listings l ON l.id = h.listing_id AND l.network_id = h.network_id
         JOIN rental_listing_communes c ON c.listing_id = l.id
         JOIN rental_leases b ON b.id = h.lease_id
         -- Les faits du bail remis, tels qu'ils étaient : une correction plus tard ne change pas une location passée.
         JOIN rental_facts f ON f.listing_id = l.id AND f.version = b.facts_version
        WHERE h.network_id = ? AND c.insee_code = ? AND h.handed_on >= ? AND h.handed_on <= ?`,
      [networkId, inseeCode, since, today],
    );
    if (rows.length < this.settings.minNetworkRentals) return null;
    // Loyer et charges, en centimes, par m² : la surface est en centièmes de m², arrondi au centime le plus proche.
    const perM2 = rows.map((r) => Math.round(((r.rent_cents + r.charges_cents) * 100) / r.living_area_hundredths));
    return this.known({
      inseeCode,
      kind: 'all',
      rentM2Cents: medianCents(perM2),
      lowerM2Cents: Math.min(...perM2),
      upperM2Cents: Math.max(...perM2),
      observations: rows.length,
      source: 'reseau',
      citation: `Locations du réseau AIMMO : ${rows.length} logements remis aux locataires dans la commune sur ${this.settings.networkMonths} mois`,
      vintage: null,
      asOf: now.toISOString(),
      importId: null,
    });
  }

  private known(r: Omit<KnownMarketRent, 'status' | 'reliability' | 'reasons'>): KnownMarketRent {
    const reasons: KnownMarketRent['reasons'] = [];
    if (r.observations < this.settings.minObservations) reasons.push('observations');
    if ((r.upperM2Cents - r.lowerM2Cents) * 100 > this.settings.maxIntervalPct * r.rentM2Cents) reasons.push('intervalle');
    return { status: 'connu', ...r, reliability: reasons.length > 0 ? 'peu_observations' : 'fiable', reasons };
  }
}
