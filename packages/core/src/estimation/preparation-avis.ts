/**
 * Préparer un avis de valeur pour un bien (M04, E09) : ce qui manquait pour que `AvisDeValeur` serve en production.
 *
 * L'agent qui suit le bien donne l'adresse et le type de logement ; le code collecte (E03), calcule (E01) et range le
 * brouillon (E04). L'adresse sert à la collecte et n'est gardée nulle part : ni colonne, ni journal [R13, R46]. Sans
 * fourchette possible, la raison est dite et rien n'est rangé [R27]. Les caractéristiques viennent de la dernière
 * version de la fiche du bien (P01), jamais d'une saisie à part ; ce que la fiche ne dit pas ne compte pas. Le calcul et
 * le texte disent la même classe énergie : celle de la fiche, sinon, pour une maison seulement, la dernière publiée à
 * son adresse. Dans un immeuble, la dernière publiée peut être celle d'un autre lot : elle n'est pas prise [R10].
 * Une source de ventes qui ne répond pas est dite, jamais attendue sans fin.
 */
import type { Acces } from '../acces/acces.ts';
import type { Viewer } from '../acces/droits.ts';
import type { PropertySheet } from '../annonces/fiche-bien.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import { DEFAULT_MANUAL_SETTINGS, MANUAL_REASONS, rangeFollowsReferences, readManual, type ManualInput, type ManualSettings } from './avis-manuel.ts';
import { AvisDeValeur, SALE_EXCLUSION_REASONS, type AgentExclusion, type CitedSale, type SaleExclusionReason, type ValuationReport, type ValuationWriter } from './avis.ts';
import { CollecteBien, type CollecteServices, type PublicFacts } from './collecte.ts';
import type { SaleDetail } from './dvf-site.ts';
import type { DetailedSales } from './en-ligne.ts';
import { ADJUSTMENT_LABELS, AGENT_ADJUSTMENT_MOTIVES, Fourchette, type Adjustment, type AgentAdjustment, type Condition, type DataInfo, type EnergyClass, type EstimatedProperty, type Era, type NoRangeReason, type RangeResult } from './fourchette.ts';

export interface PreparationServices {
  collecte: CollecteServices;
  sales: DetailedSales;
}

export type PreparationRefusal =
  | { ok: false; rule: 'R16' | 'R30'; code: string }
  | { ok: false; rule: 'R27'; code: NoRangeReason; comparablesFound: number; manualPossible: boolean }
  | { ok: false; rule: 'R692'; code: 'invalid_exclusion' | 'unknown_previous' | 'too_many_exclusions' }
  | { ok: false; rule: 'R693'; code: 'invalid_adjustment' | 'too_many_adjustments' }
  | { ok: false; rule: 'R690'; code: 'invalid_references' | 'invalid_range' | 'not_verified' | 'range_far_from_references' | 'range_available' }
  | { ok: false; rule: null; code: 'unknown' | 'invalid' | 'not_configured' | 'not_a_home' | 'no_surface' | 'address_not_found' | 'other_town' | 'sales_unavailable' };

const CONDITIONS: readonly string[] = ['travaux', 'rafraichir', 'bon', 'neuf'];
const CITED_SALES = 12;
/** Au plus tant de ventes écartées par l'agent, toutes versions comprises : écarter n'est pas choisir son prix [R692]. */
const MAX_EXCLUSIONS = 10;
/** Au plus tant d'ajustements de l'agent, chacun de -15 à +15 % [R693]. */
const MAX_AGENT_ADJUSTMENTS = 5;
const MAX_AGENT_PCT = 15;

/** Un résultat dans le délai, sinon une erreur : le minuteur ne reste jamais armé. */
function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('délai dépassé')), ms);
  });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

/** L'époque du calcul, d'après l'année de construction de la fiche. */
export function eraOf(buildYear: number | null): Era | null {
  if (buildYear === null) return null;
  if (buildYear < 1948) return 'avant1948';
  if (buildYear <= 1974) return '1948-1974';
  if (buildYear <= 2000) return '1975-2000';
  if (buildYear <= 2012) return '2001-2012';
  return 'apres2012';
}

/** Ce que la fiche du bien apporte au calcul. Sans fiche, ou sans la donnée, aucun ajustement. */
export function featuresOf(sheet: PropertySheet | null): Partial<EstimatedProperty> {
  if (!sheet) return {};
  const c = sheet.characteristics;
  return {
    era: eraOf(c.buildYear),
    floor: c.floor,
    buildingFloors: c.floorsTotal,
    land: c.landM2,
    balcony: c.outdoor.includes('balcon'),
    terrace: c.outdoor.includes('terrasse'),
    parking: (c.parkingSpaces ?? 0) > 0,
    ...(c.elevator !== null ? { elevator: c.elevator } : {}),
    ...(sheet.energy ? { energyClass: sheet.energy.energyClass } : {}),
  };
}

export class PreparationAvis {
  private readonly now: () => Date;
  private readonly avis: AvisDeValeur;

  constructor(
    private readonly db: SqlDatabase,
    private readonly acces: Acces,
    private readonly journal: JournalStore,
    private readonly services: PreparationServices | null,
    private readonly options: { now?: () => Date; writer?: ValuationWriter; newId?: () => string; salesTimeoutMs?: number; detailTimeoutMs?: number; manual?: ManualSettings } = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.avis = new AvisDeValeur(db, journal, { now: this.now, ...(options.writer ? { writer: options.writer } : {}), ...(options.newId ? { newId: options.newId } : {}) });
  }

  /** Seul l'agent actif qui suit le bien prépare un avis [R30]. La direction et la conformité lisent, sans préparer. */
  private async follower(viewer: Viewer, propertyId: string): Promise<{ ok: true; property: { network_id: string; kind: string; postal_code: string | null; surface_m2: number | null } } | PreparationRefusal> {
    const read = await this.acces.readProperty(viewer, propertyId);
    if (!read.ok) return read.code === 'unknown' ? { ok: false, rule: null, code: 'unknown' } : { ok: false, rule: 'R16', code: read.code };
    const agent = viewer.role === 'agent' ? await this.db.first<{ status: string }>('SELECT status FROM agents WHERE id = ? AND network_id = ?', [viewer.userId, viewer.networkId]) : null;
    if (read.view !== 'full' || viewer.role !== 'agent' || read.value.agent_id !== viewer.userId || agent?.status !== 'active') {
      await appendEvent(this.journal, { type: 'avis.refuse', actor: `${String(viewer.role)}:${viewer.userId}`, subject: `property:${propertyId}`, data: { code: 'not_following_agent' } }, this.now);
      return { ok: false, rule: 'R30', code: 'not_following_agent' };
    }
    return { ok: true, property: read.value };
  }

  /** La dernière version de la fiche, ou rien. */
  private async sheet(propertyId: string): Promise<PropertySheet | null> {
    const row = await this.db.first<{ data: string }>('SELECT data FROM property_sheets WHERE property_id = ? ORDER BY version DESC LIMIT 1', [propertyId]);
    return row ? (JSON.parse(row.data) as PropertySheet) : null;
  }

  /** Une voie et une commune par vente citée ; une vente sans détail reste citée sans son lieu. */
  private async details(ids: readonly string[]): Promise<Map<string, { street: string; town: string }>> {
    const found = await Promise.all(ids.map(async (id): Promise<[string, SaleDetail | null]> => [id, await within(this.services!.sales.detail(id), this.options.detailTimeoutMs ?? 5_000).catch(() => null)]));
    return new Map(found.flatMap(([id, d]) => (d ? [[id, { street: d.street, town: d.town }] as const] : [])));
  }

  /**
   * Les ventes écartées pour la nouvelle version : celles de la version précédente, plus les nouvelles, chacune citée
   * dans la version précédente et avec un motif de la liste [R692]. La version précédente ne change pas.
   */
  private async exclusions(
    propertyId: string,
    networkId: string,
    previous: unknown,
    exclude: unknown,
    adjust: unknown,
  ): Promise<{ ok: true; value: AgentExclusion[]; agent: AgentAdjustment[]; previous: string } | PreparationRefusal> {
    if (typeof previous !== 'string' || previous.length > 100) return { ok: false, rule: 'R692', code: 'unknown_previous' };
    const row = await this.db.first<{ computed: string }>('SELECT computed FROM valuation_reports WHERE id = ? AND property_id = ? AND network_id = ?', [previous, propertyId, networkId]);
    if (!row) return { ok: false, rule: 'R692', code: 'unknown_previous' };
    const before = JSON.parse(row.computed) as { method?: string; cited?: CitedSale[]; excluded?: AgentExclusion[]; adjustments?: Adjustment[] };
    // Un avis motivé n'a pas de ventes du calcul à écarter.
    if (before.method === 'manual') return { ok: false, rule: 'R692', code: 'unknown_previous' };
    // Une nouvelle version change quelque chose : une vente écartée, ou un ajustement de l'agent.
    if (exclude === undefined && adjust === undefined) return { ok: false, rule: 'R692', code: 'invalid_exclusion' };
    const kept: AgentExclusion[] = [...(before.excluded ?? [])];
    if (exclude !== undefined) {
      if (!Array.isArray(exclude) || exclude.length === 0) return { ok: false, rule: 'R692', code: 'invalid_exclusion' };
      const cited = new Map((before.cited ?? []).flatMap((c) => (c.id ? [[c.id, c] as const] : [])));
      for (const raw of exclude as unknown[]) {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, rule: 'R692', code: 'invalid_exclusion' };
        const { id, reason } = raw as { id?: unknown; reason?: unknown };
        const sale = typeof id === 'string' ? cited.get(id) : undefined;
        if (!sale || typeof reason !== 'string' || !Object.hasOwn(SALE_EXCLUSION_REASONS, reason) || kept.some((k) => k.id === id)) return { ok: false, rule: 'R692', code: 'invalid_exclusion' };
        kept.push({ id: id as string, reason: reason as SaleExclusionReason, month: sale.month, surface: sale.surface, pricePerM2: sale.pricePerM2, in: previous });
      }
      if (kept.length > MAX_EXCLUSIONS) return { ok: false, rule: 'R692', code: 'too_many_exclusions' };
    }
    // Les ajustements de l'agent de la version précédente restent, sauf ceux qu'il refait pour la même caractéristique.
    const agent: AgentAdjustment[] = (before.adjustments ?? []).filter((a) => a.source === 'agent' && a.motive).map((a) => ({ label: a.label as AgentAdjustment['label'], pct: a.pct, motive: a.motive! }));
    if (adjust !== undefined) {
      if (!Array.isArray(adjust) || adjust.length === 0) return { ok: false, rule: 'R693', code: 'invalid_adjustment' };
      const seen = new Set<string>();
      for (const raw of adjust as unknown[]) {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, rule: 'R693', code: 'invalid_adjustment' };
        const { label, pct, motive } = raw as { label?: unknown; pct?: unknown; motive?: unknown };
        if (typeof label !== 'string' || !(ADJUSTMENT_LABELS as readonly string[]).includes(label) || seen.has(label)) return { ok: false, rule: 'R693', code: 'invalid_adjustment' };
        if (typeof pct !== 'number' || !Number.isInteger(pct) || Math.abs(pct) > MAX_AGENT_PCT) return { ok: false, rule: 'R693', code: 'invalid_adjustment' };
        if (typeof motive !== 'string' || !Object.hasOwn(AGENT_ADJUSTMENT_MOTIVES, motive)) return { ok: false, rule: 'R693', code: 'invalid_adjustment' };
        seen.add(label);
        const at = agent.findIndex((a) => a.label === label);
        const next: AgentAdjustment = { label: label as AgentAdjustment['label'], pct, motive: motive as AgentAdjustment['motive'] };
        if (at >= 0) agent[at] = next;
        else agent.push(next);
      }
      if (agent.length > MAX_AGENT_ADJUSTMENTS) return { ok: false, rule: 'R693', code: 'too_many_adjustments' };
    }
    return { ok: true, value: kept, agent, previous };
  }

  /**
   * `exclude` et `previous` : une nouvelle version recalculée sans les ventes que l'agent écarte de la version
   * `previous`, chacune avec son motif [R692] ; `adjust` : les coefficients que l'agent retient à la place du barème,
   * chacun avec son motif, dans une nouvelle version aussi [R693].
   * `manual` : l'avis motivé par les ventes vérifiées de l'agent, `{ low, high, verified: true, references: [...] }`,
   * reçu seulement quand le calcul ne peut pas donner de fourchette pour ce logement [R27, R690].
   */
  async prepare(viewer: Viewer, propertyId: string, input: { address?: unknown; kind?: unknown; condition?: unknown; manual?: unknown; exclude?: unknown; previous?: unknown; adjust?: unknown }): Promise<{ ok: true; value: ValuationReport } | PreparationRefusal> {
    const allowed = await this.follower(viewer, propertyId);
    if (!allowed.ok) return allowed;
    if (!this.services) return { ok: false, rule: null, code: 'not_configured' };
    const { property } = allowed;
    // Un terrain ou un immeuble : le calcul ne les traite pas, l'avis motivé par les ventes de l'agent les traite [R690].
    // Les commerces et les entreprises ont leur propre estimation (M16).
    const manualOnly = property.kind === 'land' || property.kind === 'building';
    if (property.kind !== 'home' && !manualOnly) return { ok: false, rule: null, code: 'not_a_home' };
    if (property.surface_m2 === null) return { ok: false, rule: null, code: 'no_surface' };
    const { address, kind, condition } = input;
    if (typeof address !== 'string' || address.trim().length < 5 || address.length > 200) return { ok: false, rule: null, code: 'invalid' };
    if (manualOnly ? kind !== property.kind : kind !== 'apartment' && kind !== 'house') return { ok: false, rule: null, code: 'invalid' };
    const sort = kind as 'apartment' | 'house' | 'land' | 'building';
    if (condition !== undefined && condition !== null && (typeof condition !== 'string' || !CONDITIONS.includes(condition))) return { ok: false, rule: null, code: 'invalid' };
    const settings = this.options.manual ?? DEFAULT_MANUAL_SETTINGS;
    let manual: ManualInput | null = null;
    if (input.manual !== undefined && input.manual !== null) {
      const read = readManual(input.manual, this.now(), settings);
      if (!read.ok) return { ok: false, rule: 'R690', code: read.code };
      if (!rangeFollowsReferences(read.value, property.surface_m2, settings)) return { ok: false, rule: 'R690', code: 'range_far_from_references' };
      manual = read.value;
    }
    let excluded: AgentExclusion[] = [];
    let agentAdjustments: AgentAdjustment[] = [];
    let previous: string | null = null;
    if (input.exclude !== undefined || input.previous !== undefined || input.adjust !== undefined) {
      // Écarter des ventes du calcul et apporter ses propres ventes ne vont pas ensemble.
      if (manual || property.kind !== 'home') return { ok: false, rule: 'R692', code: 'invalid_exclusion' };
      const read = await this.exclusions(propertyId, property.network_id, input.previous, input.exclude, input.adjust);
      if (!read.ok) return read;
      excluded = read.value;
      agentAdjustments = read.agent;
      previous = read.previous;
    }

    const collected = await new CollecteBien(this.services.collecte, { now: this.now }).collect(address);
    if (!collected.address.ok) return { ok: false, rule: null, code: 'address_not_found' };
    const place = collected.address.value;
    // L'adresse d'une autre commune que celle du bien : un avis sur le mauvais bien, refusé.
    if (property.postal_code && property.postal_code !== place.postalCode) return { ok: false, rule: null, code: 'other_town' };

    const sheet = await this.sheet(propertyId);
    const at = this.now().toISOString();
    // La même classe au calcul et au texte : celle de la fiche ; sinon la publique, pour une maison seulement [R10].
    const energy: PublicFacts['energy'] = sheet?.energy && sort !== 'land'
      ? { ok: true, source: 'Fiche du bien', collectedAt: at, value: { energyClass: sheet.energy.energyClass, ghgClass: sheet.energy.climateClass, date: sheet.energy.diagnosedOn, diagnosisNumber: null } }
      : sort === 'house'
        ? collected.energy
        : { ok: false, source: collected.energy.source, collectedAt: at, reason: 'introuvable' };
    const facts: PublicFacts = { ...collected, energy, missing: energy.ok ? collected.missing.filter((m) => m !== 'energy') : [...new Set([...collected.missing, 'energy' as const])] };
    const energyClass: EnergyClass | null = energy.ok ? energy.value.energyClass : null;
    if (sort === 'land' || sort === 'building') {
      // Aucun calcul : sans les ventes vérifiées de l'agent, la raison est dite et rien n'est rangé [R27, R690].
      if (!manual) {
        await appendEvent(this.journal, { type: 'avis.sans_fourchette', actor: `agent:${viewer.userId}`, subject: `property:${propertyId}`, data: { rule: 'R27', reason: 'type', comparablesFound: 0 } }, this.now);
        return { ok: false, rule: 'R27', code: 'type', comparablesFound: 0, manualPossible: true };
      }
      const data: DataInfo = { lastSale: null, years: [], source: null, recentMissing: false, monthsSinceLastSale: null, dvfNotCovered: false };
      const report = await this.avis.draftManual({ networkId: property.network_id, propertyId, kind: sort, surface: property.surface_m2, manual, reason: 'type', comparablesFound: 0, data, facts, limits: { maxSpread: settings.maxSpread, maxGapFromReferences: settings.maxGapFromReferences } });
      return { ok: true, value: report };
    }
    let range: RangeResult;
    try {
      range = await within(
        new Fourchette(this.services.sales, undefined, this.now).estimate({
          kind: sort,
          surface: property.surface_m2,
          lat: place.lat,
          lon: place.lon,
          postalCode: place.postalCode,
          condition: (condition as Condition | null | undefined) ?? null,
          ...featuresOf(sheet),
          energyClass,
        }, new Set(excluded.map((e) => e.id)), agentAdjustments),
        this.options.salesTimeoutMs ?? 15_000,
      );
    } catch {
      await appendEvent(this.journal, { type: 'avis.ventes_indisponibles', actor: `agent:${viewer.userId}`, subject: `property:${propertyId}`, data: {} }, this.now);
      return { ok: false, rule: null, code: 'sales_unavailable' };
    }
    if (!range.ok) {
      const manualPossible = MANUAL_REASONS.includes(range.reason);
      // Sans fourchette du calcul, l'avis motivé de l'agent, s'il l'a apporté et si la raison le permet [R690].
      if (manual && manualPossible) {
        const report = await this.avis.draftManual({ networkId: property.network_id, propertyId, kind: sort, surface: property.surface_m2, manual, reason: range.reason, comparablesFound: range.comparablesFound, data: range.data, facts, limits: { maxSpread: settings.maxSpread, maxGapFromReferences: settings.maxGapFromReferences } });
        return { ok: true, value: report };
      }
      await appendEvent(this.journal, { type: 'avis.sans_fourchette', actor: `agent:${viewer.userId}`, subject: `property:${propertyId}`, data: { rule: 'R27', reason: range.reason, comparablesFound: range.comparablesFound } }, this.now);
      return { ok: false, rule: 'R27', code: range.reason, comparablesFound: range.comparablesFound, manualPossible };
    }
    // Le calcul a donné une fourchette : l'avis part de lui, jamais d'une fourchette saisie à côté [R27, R690].
    if (manual) return { ok: false, rule: 'R690', code: 'range_available' };
    const details = await this.details(range.comparables.slice(0, CITED_SALES).map((c) => c.id));
    const report = await this.avis.draft({ networkId: property.network_id, propertyId, kind: sort, surface: property.surface_m2, range, facts, details, excluded, previous });
    return { ok: true, value: report };
  }

  /** Les avis d'un bien, du plus récent au plus ancien : qui voit le bien en entier [R16]. */
  async list(viewer: Viewer, propertyId: string): Promise<{ ok: true; value: ValuationReport[] } | PreparationRefusal> {
    const read = await this.acces.readProperty(viewer, propertyId);
    if (!read.ok) return read.code === 'unknown' ? { ok: false, rule: null, code: 'unknown' } : { ok: false, rule: 'R16', code: read.code };
    if (read.view !== 'full') {
      await appendEvent(this.journal, { type: 'acces.refuse', actor: `${String(viewer.role)}:${viewer.userId}`, subject: `property:${propertyId}`, data: { rule: 'R16', role: String(viewer.role), kind: 'valuation_list', code: 'not_assigned' } }, this.now);
      return { ok: false, rule: 'R16', code: 'not_assigned' };
    }
    const rows = await this.db.all<ValuationReport>('SELECT * FROM valuation_reports WHERE property_id = ? AND network_id = ? ORDER BY created_at DESC, id DESC LIMIT 20', [propertyId, viewer.networkId]);
    return { ok: true, value: rows };
  }
}
