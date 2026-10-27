/**
 * L'estimation en ligne du site (M04, E05) : sans visite, seulement la fourchette de prix au m² de la commune, pour un
 * type de logement, jamais le prix d'un bien précis [R31] ; puis une proposition de rendez-vous.
 *
 * La commune est retrouvée par la Base adresse nationale ; ses ventes sont celles de DVF dans un rayon autour de son
 * centre, gardées seulement si leur détail publié porte le nom de la commune. La fourchette va du premier au
 * troisième quartile du prix au m², avec la médiane ; la date des données et le manque des ventes récentes sont dits
 * [R28]. Rien de ce que le visiteur donne n'est gardé : la demande ne porte que la commune et le type.
 */
import { plain } from '../envoi/texte.ts';
import type { Geocoder } from './collecte.ts';
import type { SaleDetail } from './dvf-site.ts';
import { DEFAULT_RANGE_SETTINGS, departmentOf, type EstimatedKind, type Sale, type SalesSource } from './fourchette.ts';

export interface DetailedSales extends SalesSource {
  detail(saleId: string): Promise<SaleDetail | null>;
  /** Les ventes du cercle et le nombre de fichiers ou de lignes illisibles pour cette recherche. */
  scan(kind: EstimatedKind, lat: number, lon: number, radius: number): Promise<{ sales: Sale[]; issues: number }>;
}

export interface CommuneEstimate {
  town: string;
  postalCode: string;
  kind: EstimatedKind;
  /** Prix au m² de la commune : premier quartile, médiane, troisième quartile, arrondis à la dizaine. */
  perM2: { low: number; median: number; high: number };
  sales: number;
  /** Mois de la plus ancienne et de la plus récente des ventes utilisées, `AAAA-MM`. */
  period: { from: string; to: string };
  data: { lastSale: string; source: string; recentMissing: boolean };
  /** Sans visite, pas de prix du bien : l'étape suivante est un rendez-vous avec l'agent [R31]. */
  next: 'appointment';
}

export type CommuneResult =
  | { ok: true; value: CommuneEstimate }
  | {
      ok: false;
      reason: 'commune_introuvable' | 'hors_zone' | 'dvf_non_couvert' | 'donnees_absentes' | 'peu_de_ventes';
      next: 'appointment';
      /** Fichiers de ventes manquants ou illisibles pendant la demande. */
      missingFiles?: number;
    };

export interface EnLigneSettings {
  /** Rayon autour du centre de la commune, en mètres. */
  radius: number;
  /** En dessous, pas de fourchette de commune. */
  minimum: number;
  recentMissingAfterMonths: number;
}

export const DEFAULT_EN_LIGNE_SETTINGS: EnLigneSettings = Object.freeze({ radius: 4000, minimum: 10, recentMissingAfterMonths: 3 });

function quantile(sorted: readonly number[], q: number): number {
  const p = (sorted.length - 1) * q;
  const b = Math.floor(p);
  const lo = sorted[b]!;
  const hi = sorted[Math.min(b + 1, sorted.length - 1)]!;
  return lo + (hi - lo) * (p - b);
}
const tens = (n: number): number => Math.round(n / 10) * 10;
const sameTown = (a: string, b: string): boolean => plain(a).replace(/[^a-z]+/g, ' ').trim() === plain(b).replace(/[^a-z]+/g, ' ').trim();

export class EstimationEnLigne {
  constructor(
    private readonly geocoder: Geocoder,
    private readonly sales: DetailedSales,
    private readonly settings: EnLigneSettings = DEFAULT_EN_LIGNE_SETTINGS,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async forTown(postalCode: string, town: string, kind: EstimatedKind): Promise<CommuneResult> {
    const none = (reason: Extract<CommuneResult, { ok: false }>['reason']): CommuneResult => ({ ok: false, reason, next: 'appointment' });
    const department = departmentOf(postalCode);
    if (department === null || town.trim() === '') return none('commune_introuvable');
    if (DEFAULT_RANGE_SETTINGS.dvfNotCovered.includes(department)) return none('dvf_non_couvert');
    const coverage = await this.sales.coverage();
    if (!coverage) return none('donnees_absentes');
    if (coverage.department !== department) return none('hors_zone');
    // Seuls le code postal et le nom de la commune partent au géocodage : jamais une adresse.
    const place = await this.geocoder.geocode(`${postalCode} ${town.trim()}`);
    if (!place || place.postalCode !== postalCode || !sameTown(place.town, town)) return none('commune_introuvable');

    const { sales: around, issues } = await this.sales.scan(kind, place.lat, place.lon, this.settings.radius);
    const inTown: Sale[] = [];
    let unknown = 0;
    for (const sale of around) {
      const detail = await this.sales.detail(sale.id);
      if (!detail) unknown++;
      else if (sameTown(detail.town, place.town)) inTown.push(sale);
    }
    // Une partie des ventes illisible : la fourchette serait faussée, mieux vaut ne rien dire que dire faux.
    if (issues > 0 || unknown > 0) return { ok: false, reason: 'donnees_absentes', next: 'appointment', missingFiles: issues + unknown };
    if (inTown.length < this.settings.minimum) return none('peu_de_ventes');
    const perM2 = inTown.map((s) => s.pricePerM2).sort((a, b) => a - b);
    const months = inTown.map((s) => s.month).sort();
    const at = this.now();
    const since = (at.getUTCFullYear() - Number(coverage.lastSale.slice(0, 4))) * 12 + (at.getUTCMonth() + 1 - Number(coverage.lastSale.slice(5, 7)));
    return {
      ok: true,
      value: {
        town: place.town,
        postalCode,
        kind,
        perM2: { low: tens(quantile(perM2, 0.25)), median: tens(quantile(perM2, 0.5)), high: tens(quantile(perM2, 0.75)) },
        sales: inTown.length,
        period: { from: months[0]!, to: months[months.length - 1]! },
        data: { lastSale: coverage.lastSale, source: coverage.source, recentMissing: since > this.settings.recentMissingAfterMonths },
        next: 'appointment',
      },
    };
  }
}
