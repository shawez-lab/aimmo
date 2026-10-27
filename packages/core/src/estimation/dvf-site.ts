/**
 * Les ventes DVF déjà préparées par le site (E02) : `donnees-dvf/` de shawez-immo, produit par `outils/dvf.py`, lu ici
 * en lecture seule, comme source de la fourchette (E01).
 *
 *   index.json        { source, departement, annees, derniere_vente, tuile, tuiles: ["x_y", …] }
 *   t/<x_y>.json      [[lat, lon, type (0 appartement, 1 maison), surface, prix au m², AAAAMM, pièces, terrain], …]
 *   d/<x_y>.txt       une ligne JSON par vente, dans le même ordre : [prix, voie sans numéro, commune, jour du mois]
 *
 * Seule une fonction de lecture est donnée : rien n'est jamais écrit. Une tuile absente ou illisible ne casse rien,
 * elle est comptée. Une vente citée n'a ni nom ni numéro de voie [R29].
 */
import type { EstimatedKind, Sale, SalesCoverage, SalesSource } from './fourchette.ts';

/** Lit un fichier de `donnees-dvf/` (chemin relatif) ; `null` s'il n'existe pas. */
export type DvfFileReader = (path: string) => Promise<string | null>;

export interface SaleDetail {
  /** Prix signé, tel que publié. */
  price: number | null;
  /** Voie, sans numéro [R29]. */
  street: string;
  town: string;
  /** Jour du mois de la vente, s'il est publié. */
  day: number | null;
}

interface DvfIndex {
  source: string;
  departement: string;
  annees: number[];
  derniere_vente: string;
  tuile: number;
  tuiles: string[];
}

const TILE = /^-?\d{1,4}_-?\d{1,4}$/;

function parseIndex(text: string | null): DvfIndex | null {
  if (text === null) return null;
  try {
    const v = JSON.parse(text) as Partial<DvfIndex>;
    if (
      typeof v.source !== 'string' ||
      typeof v.departement !== 'string' ||
      !/^\d{2,3}$/.test(v.departement) ||
      !Array.isArray(v.annees) ||
      typeof v.derniere_vente !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}$/.test(v.derniere_vente) ||
      typeof v.tuile !== 'number' ||
      !(v.tuile > 0) ||
      !Array.isArray(v.tuiles)
    ) {
      return null;
    }
    return { ...(v as DvfIndex), tuiles: v.tuiles.filter((t): t is string => typeof t === 'string' && TILE.test(t)) };
  } catch {
    return null;
  }
}

const SMALL = new Set(['de', 'du', 'des', 'la', 'le', 'les', 'aux', 'au', 'en', 'sur', 'sous', 'et', 'a', 'l', 'd']);
const ABBREVIATIONS: Record<string, string> = {
  R: 'Rue', RUE: 'Rue', AV: 'Avenue', AVE: 'Avenue', BD: 'Boulevard', BLD: 'Boulevard', PL: 'Place', IMP: 'Impasse', ALL: 'Allée',
  CHE: 'Chemin', CRS: 'Cours', QU: 'Quai', QUAI: 'Quai', RTE: 'Route', SQ: 'Square', PAS: 'Passage', LOT: 'Lotissement', RES: 'Résidence',
  CITE: 'Cité', HAM: 'Hameau', VLA: 'Villa', RPT: 'Rond-point', PROM: 'Promenade', SEN: 'Sente', TRA: 'Traverse', MTE: 'Montée',
  FG: 'Faubourg', CR: 'Chemin rural', VC: 'Voie communale', ZA: 'ZA',
};

/** La voie lisible, comme sur le site, sans aucun numéro devant [R29]. */
export function readableStreet(raw: string): string {
  // Numéros simples ou composés (`12`, `12-14`, `12/14`, `3 bis`, `7B`) : tout le préfixe part ; ce qui commence
  // encore par un chiffre n'est pas cité.
  const withoutNumber = String(raw)
    .trim()
    .replace(/^(?:[\d\s\-/,&.]+(?:bis|ter|quater|[a-z])?\b[\s,]*)+/i, '');
  if (/^\d/.test(withoutNumber)) return '';
  const words = withoutNumber.split(/\s+/).filter(Boolean);
  return words
    .map((word, i) => {
      if (i === 0 && ABBREVIATIONS[word.toUpperCase()]) return ABBREVIATIONS[word.toUpperCase()]!;
      const low = word.toLowerCase();
      if (i > 0 && SMALL.has(low.replace(/['’]$/, ''))) return low;
      return low.replace(/(^|[-'’])([a-zà-ÿ])/g, (_m, s: string, c: string) => s + c.toUpperCase());
    })
    .join(' ')
    .replace(/(^| )([dl]) (?=[aeiouyhéèàâêîôûAEIOUYHÉÈÀÂÊÎÔÛ])/g, (_m, a: string, c: string) => `${a}${c}'`);
}

export function readableTown(raw: string): string {
  return String(raw)
    .toLowerCase()
    .replace(/(^|[\s-])(?!(?:de|du|des|la|le|les|sur|sous|en|et|aux?|lès|lez)(?:[\s-]|$))([a-zà-ÿ])/g, (_m, s: string, x: string) => s + x.toUpperCase())
    .replace(/^./, (x) => x.toUpperCase());
}

export class DvfSiteSales implements SalesSource {
  private index: Promise<DvfIndex | null> | null = null;
  private readonly tiles = new Map<string, Promise<unknown[][]>>();
  private readonly details = new Map<string, Promise<string[] | null>>();
  /** Tuiles annoncées mais absentes ou illisibles, et ventes mal formées écartées. */
  readonly skipped = { tiles: 0, sales: 0, details: 0 };

  constructor(private readonly read: DvfFileReader) {}

  private loadIndex(): Promise<DvfIndex | null> {
    this.index ??= this.read('index.json').then(parseIndex, () => null);
    return this.index;
  }

  async coverage(): Promise<SalesCoverage | null> {
    const idx = await this.loadIndex();
    return idx ? { department: idx.departement, lastSale: idx.derniere_vente, years: idx.annees, source: idx.source } : null;
  }

  private tile(name: string): Promise<unknown[][]> {
    let p = this.tiles.get(name);
    if (!p) {
      p = this.read(`t/${name}.json`).then(
        (text) => {
          try {
            const v: unknown = text === null ? null : JSON.parse(text);
            if (Array.isArray(v)) return v as unknown[][];
          } catch {
            // illisible : compté ci-dessous
          }
          this.skipped.tiles++;
          return [];
        },
        () => {
          this.skipped.tiles++;
          return [];
        },
      );
      this.tiles.set(name, p);
    }
    return p;
  }

  async within(kind: EstimatedKind, lat: number, lon: number, radius: number): Promise<Sale[]> {
    const idx = await this.loadIndex();
    if (!idx) return [];
    const known = new Set(idx.tuiles);
    const step = idx.tuile;
    const dLat = radius / 111320;
    const dLon = radius / (111320 * Math.cos((lat * Math.PI) / 180));
    const wanted = kind === 'house' ? 1 : 0;
    const out: Sale[] = [];
    for (let x = Math.floor((lon - dLon) / step); x <= Math.floor((lon + dLon) / step); x++) {
      for (let y = Math.floor((lat - dLat) / step); y <= Math.floor((lat + dLat) / step); y++) {
        const name = `${x}_${y}`;
        if (!known.has(name)) continue;
        const rows = await this.tile(name);
        rows.forEach((row, i) => {
          if (!Array.isArray(row) || row[2] !== wanted) return;
          const [rLat, rLon, , surface, pm2, month, rooms, land] = row as number[];
          if (![rLat, rLon, surface, pm2, month].every((n) => typeof n === 'number' && Number.isFinite(n)) || !(surface! > 0) || !(pm2! > 0)) {
            this.skipped.sales++;
            return;
          }
          const m = month!;
          if (m < 190001 || m % 100 < 1 || m % 100 > 12) {
            this.skipped.sales++;
            return;
          }
          out.push({
            id: `${name}:${i}`,
            kind,
            lat: rLat!,
            lon: rLon!,
            surface: surface!,
            pricePerM2: pm2!,
            month: `${Math.floor(m / 100)}-${String(m % 100).padStart(2, '0')}`,
            rooms: typeof rooms === 'number' && rooms > 0 ? rooms : null,
            land: kind === 'house' && typeof land === 'number' && land > 0 ? land : null,
          });
        });
      }
    }
    return out;
  }

  /** Le détail publié d'une vente : prix signé, voie sans numéro, commune [R29]. `null` s'il manque. */
  async detail(saleId: string): Promise<SaleDetail | null> {
    const match = /^(-?\d{1,4}_-?\d{1,4}):(\d{1,6})$/.exec(saleId);
    if (!match) return null;
    const [, name, at] = match;
    const idx = await this.loadIndex();
    if (!idx || !idx.tuiles.includes(name!)) return null;
    let p = this.details.get(name!);
    if (!p) {
      p = this.read(`d/${name}.txt`).then(
        (text) => {
          if (text === null) this.skipped.details++;
          return text === null ? null : text.split('\n');
        },
        () => {
          this.skipped.details++;
          return null;
        },
      );
      this.details.set(name!, p);
    }
    const line = (await p)?.[Number(at)];
    if (!line) return null;
    try {
      const v: unknown = JSON.parse(line);
      if (!Array.isArray(v)) return null;
      const [price, street, town, day] = v as unknown[];
      return {
        price: typeof price === 'number' && Number.isFinite(price) && price > 0 ? price : null,
        street: typeof street === 'string' ? readableStreet(street) : '',
        town: typeof town === 'string' ? readableTown(town) : '',
        day: typeof day === 'number' && Number.isInteger(day) && day >= 1 && day <= 31 ? day : null,
      };
    } catch {
      return null;
    }
  }
}

/**
 * Lecteur des fichiers DVF publics du site, par HTTPS et en lecture seule (GET), à partir d'une fonction `fetch`
 * donnée. Seuls les chemins produits par `DvfSiteSales` sont lus, sous l'adresse de base.
 */
export function httpDvfReader(
  fetcher: (url: string, init?: { headers?: Record<string, string> }) => Promise<{ ok: boolean; text(): Promise<string> }>,
  base: string,
): DvfFileReader | null {
  if (!/^https:\/\/[^\s]+\/$/.test(base)) return null;
  return async (path) => {
    if (!/^(index\.json|t\/-?\d{1,4}_-?\d{1,4}\.json|d\/-?\d{1,4}_-?\d{1,4}\.txt)$/.test(path)) return null;
    const res = await fetcher(new URL(path, base).toString(), { headers: { accept: 'application/json, text/plain' } });
    return res.ok ? res.text() : null;
  };
}
