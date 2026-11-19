/**
 * Le rapprochement des acquéreurs (M08, T02), par le code seul : pour un bien diffusable [R42], les acquéreurs du
 * réseau entier (fichier commun) dont la recherche lui correspond, selon des critères obligatoires et des tolérances
 * écrites en réglage, puis classés par des règles écrites, chaque ligne avec ses raisons [R51]. Jamais par une note de
 * l'IA, jamais par le financement ni la solvabilité [R14] ; aucun critère discriminant n'existe dans la recherche [R50].
 * Jamais une personne exclue ou qui a demandé l'arrêt [R02, R04].
 *
 * Jamais vu : la carte de la demande. Pour un bien, combien d'acquéreurs actifs du réseau le cherchent, et quel critère
 * seul écarte le plus d'acquéreurs proches, sans aucun nom.
 *
 * Décidé, lecture prudente : le type « logement » du socle répond à une recherche de maison comme d'appartement, tant
 * que la fiche ne les distingue pas ; une valeur du bien inconnue ne remplit pas le critère qui la demande ; le prix
 * rapproché est celui de la fiche de base du bien ; un acquéreur est actif si son projet n'est pas clos et que sa
 * recherche a bougé, ou a été dite toujours d'actualité, depuis moins de `activeDays` jours. Un agent ne voit dans la liste que ses propres clients ; la
 * direction voit tout le réseau [R16].
 */
import { shownPrice } from '../biens/prix-publie.ts';
import type { Acces } from '../acces/acces.ts';
import { decideAccess, type Viewer } from '../acces/droits.ts';
import type { SqlDatabase } from '../db/sql.ts';
import type { Dwelling, Property, PropertyKind } from '../db/types.ts';
import type { FicheUnique } from '../fiche/fusion.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import type { Deadline } from '../qualification/regles.ts';
import { toVersion, type BuyerFeature, type BuyerPropertyKind, type BuyerSearch, type BuyerSearchRow } from './fiche-acquereur.ts';
const FEATURE_LABEL: Record<BuyerFeature, string> = { garden: 'jardin', balcony: 'balcon', terrace: 'terrasse', garage: 'garage', parking: 'stationnement', cellar: 'cave', elevator: 'ascenseur', pool: 'piscine', single_storey: 'plain-pied', quiet: 'calme', bright: 'lumineux', view: 'vue', fireplace: 'cheminée', outbuilding: 'dépendance' };

/** Les critères obligatoires, dans l'ordre où ils sont vérifiés et montrés. */
export const MANDATORY_CRITERIA = ['kind', 'commune', 'budget', 'surface', 'rooms', 'bedrooms', 'floor', 'energy', 'land', 'features'] as const;
export type MandatoryCriterion = (typeof MANDATORY_CRITERIA)[number];

/** Les tolérances, en réglage du réseau. */
export interface Tolerances {
  /** Prix au plus ce pourcentage au-dessus du budget. */
  budgetOverPct: number;
  /** Surface au plus ce pourcentage en dessous du minimum. */
  surfaceUnderPct: number;
  /** Pièces en moins admises. */
  roomsUnder: number;
}
export const DEFAULT_TOLERANCES: Readonly<Tolerances> = Object.freeze({ budgetOverPct: 5, surfaceUnderPct: 10, roomsUnder: 0 });

/** Une recherche sans nouvelle depuis plus longtemps ne compte plus, en jours. */
export const DEFAULT_ACTIVE_DAYS = 180;

/** Les projets clos : leurs recherches ne comptent plus. */
export const CLOSED_STAGES: readonly string[] = Object.freeze(['lost', 'closed', 'done', 'won', 'abandoned', 'bought']);

/** Ce que le code sait d'un bien pour le rapprocher : rien sur son vendeur, rien de son adresse. */
export interface MatchProperty {
  kind: PropertyKind;
  /** Pour un logement : maison ou appartement ; null tant que ni la fiche ni le bien ne le disent (AU070). */
  dwelling?: Dwelling | null;
  city: string | null;
  priceEur: number | null;
  surfaceM2: number | null;
  rooms: number | null;
  bedrooms: number | null;
  features: BuyerFeature[];
  /** Étage (0 : rez-de-chaussée), classe énergie et terrain, lus dans la fiche du bien ; absents s'ils ne sont pas dits (AU072). */
  floor?: number | null;
  energyClass?: string | null;
  landM2?: number | null;
}

export type CriterionState = 'met' | 'tolerated' | 'unmet';

export interface CriterionCheck {
  criterion: MandatoryCriterion;
  state: CriterionState;
  reason: string;
  /** Pour l'étage : la borne jugée, minimum ou maximum, pour citer les mots qui l'ont dite (AU072). */
  bound?: 'floorMin' | 'floorMax';
}

export interface BuyerMatch {
  /** `match` : tous les critères remplis ; `tolerated` : au moins un dans sa tolérance ; `miss` : un critère manqué. */
  status: 'match' | 'tolerated' | 'miss';
  checks: CriterionCheck[];
  unmet: MandatoryCriterion[];
  /** Contraintes de la recherche que le bien remplit. */
  featuresMet: BuyerFeature[];
  /** Somme des écarts tolérés, en pour cent, pour classer. */
  gap: number;
  /** Les souhaits d'étage, de classe énergie ou de terrain que le bien remplit, pour classer (AU072). */
  softMet?: number;
}

const eur = (n: number): string => `${new Intl.NumberFormat('fr-FR').format(n).replace(/ | /g, ' ')} €`;

const KIND_LABEL: Record<BuyerPropertyKind, string> = {
  house: 'maison',
  apartment: 'appartement',
  land: 'terrain',
  building: 'immeuble',
  commercial: 'local professionnel',
};

/** Les types de recherche auxquels répond un type du socle. */
const KINDS_OF_PROPERTY: Record<PropertyKind, readonly BuyerPropertyKind[]> = {
  home: ['house', 'apartment'],
  land: ['land'],
  building: ['building'],
  commercial: ['commercial'],
  business_walls: ['commercial'],
  business: ['commercial'],
};

/**
 * Le type cherché que ce bien remplit : un logement dit maison ou appartement ne répond qu'à ce type ; un logement dont
 * on ne sait pas lequel il est ne remplit qu'une recherche qui accepte les deux, et reste dans la tolérance sinon (AU070).
 */
export function kindMet(property: Pick<MatchProperty, 'kind' | 'dwelling'>, wanted: readonly BuyerPropertyKind[]): BuyerPropertyKind | undefined {
  if (property.kind === 'home' && !property.dwelling) return wanted.includes('house') && wanted.includes('apartment') ? 'house' : undefined;
  const offered = property.kind === 'home' ? [property.dwelling!] : (KINDS_OF_PROPERTY[property.kind] ?? []);
  return wanted.find((k) => offered.includes(k));
}

const same = (a: string, b: string): boolean => a.normalize('NFC').toLocaleLowerCase('fr') === b.normalize('NFC').toLocaleLowerCase('fr');

/** Le rapprochement d'une recherche et d'un bien : une fonction pure, chaque critère avec sa raison [R51]. */
export function matchBuyer(property: MatchProperty, search: BuyerSearch, tolerances: Tolerances = DEFAULT_TOLERANCES): BuyerMatch {
  const checks: CriterionCheck[] = [];
  let gap = 0;
  const add = (criterion: MandatoryCriterion, state: CriterionState, reason: string): void => {
    checks.push({ criterion, state, reason });
  };

  if (search.propertyKinds.length > 0) {
    const hit = kindMet(property, search.propertyKinds);
    if (hit) add('kind', 'met', property.kind === 'home' && !property.dwelling ? 'Type cherché : maison ou appartement.' : `Type cherché : ${KIND_LABEL[hit]}.`);
    else if (property.kind === 'home' && !property.dwelling && search.propertyKinds.some((k) => k === 'house' || k === 'apartment'))
      add('kind', 'tolerated', 'Maison ou appartement : pas encore dit sur la fiche du bien.');
    else add('kind', 'unmet', `Type cherché : ${search.propertyKinds.map((k) => KIND_LABEL[k]).join(', ')}.`);
  }
  if (search.communes.length > 0) {
    const city = property.city;
    if (city !== null && search.communes.some((c) => same(c, city))) add('commune', 'met', `Commune cherchée : ${city}.`);
    else add('commune', 'unmet', 'Commune hors de la recherche.');
  }
  if (search.budgetMaxEur !== null) {
    const price = property.priceEur;
    const budget = search.budgetMaxEur;
    if (price === null) add('budget', 'unmet', 'Prix du bien inconnu.');
    else if (price <= budget) add('budget', 'met', `Prix ${eur(price)} dans le budget de ${eur(budget)}.`);
    else {
      // En centièmes de pour cent, pour éviter les arrondis à la limite.
      // La limite se compare sans arrondi ; l'arrondi ne sert qu'à l'affichage.
      const over = Math.round(((price - budget) * 10_000) / budget) / 100;
      // Un budget dit infranchissable n'a aucune tolérance (AU115).
      if (search.budgetStrict !== true && (price - budget) * 100 <= tolerances.budgetOverPct * budget + 1e-9) {
        gap += over;
        add('budget', 'tolerated', `Prix ${over.toLocaleString('fr-FR')} % au-dessus du budget, dans la tolérance de ${tolerances.budgetOverPct} %.`);
      } else add('budget', 'unmet', search.budgetStrict === true ? 'Prix au-dessus du budget, que l’acquéreur dit infranchissable.' : 'Prix au-dessus du budget.');
    }
  }
  if (search.surfaceMinM2 !== null) {
    const surface = property.surfaceM2;
    const min = search.surfaceMinM2;
    if (surface === null) add('surface', 'unmet', 'Surface du bien inconnue.');
    else if (surface >= min) add('surface', 'met', `Surface ${surface} m² pour ${min} m² au moins.`);
    else {
      const under = Math.round(((min - surface) * 10_000) / min) / 100;
      if ((min - surface) * 100 <= tolerances.surfaceUnderPct * min + 1e-9) {
        gap += under;
        add('surface', 'tolerated', `Surface ${under.toLocaleString('fr-FR')} % sous le minimum, dans la tolérance de ${tolerances.surfaceUnderPct} %.`);
      } else add('surface', 'unmet', 'Surface sous le minimum.');
    }
  }
  if (search.roomsMin !== null) {
    const rooms = property.rooms;
    const min = search.roomsMin;
    if (rooms === null) add('rooms', 'unmet', 'Nombre de pièces inconnu.');
    else if (rooms >= min) add('rooms', 'met', `${rooms} pièces pour ${min} au moins.`);
    else if (min - rooms <= tolerances.roomsUnder) {
      gap += ((min - rooms) * 100) / min;
      add('rooms', 'tolerated', `${min - rooms} pièce en moins, dans la tolérance.`);
    } else add('rooms', 'unmet', 'Pas assez de pièces.');
  }
  if (search.bedroomsMin !== null) {
    const bedrooms = property.bedrooms;
    const min = search.bedroomsMin;
    if (bedrooms === null) add('bedrooms', 'unmet', 'Nombre de chambres inconnu.');
    else if (bedrooms >= min) add('bedrooms', 'met', `${bedrooms} chambres pour ${min} au moins.`);
    else add('bedrooms', 'unmet', 'Pas assez de chambres.');
  }

  // AU072 · étage, classe énergie et terrain : impératifs, sauf s'ils sont dits souhaits ; une valeur inconnue ne
  // remplit pas un impératif, et un souhait non rempli n'écarte rien.
  const soft = search.softCriteria ?? [];
  let softMet = 0;
  const judgeOne = (criterion: 'floor' | 'energy' | 'land', isSoft: boolean, ok: boolean | null, met: string, unmet: string, unknown: string, bound?: 'floorMin' | 'floorMax') => {
    const before = checks.length;
    if (ok === true) {
      add(criterion, 'met', met);
      if (isSoft) softMet += 1;
    } else if (!isSoft) add(criterion, 'unmet', ok === null ? unknown : unmet);
    if (bound && checks.length > before) checks[checks.length - 1]!.bound = bound;
  };
  // Chaque borne d'étage se juge avec sa propre force.
  const fMin = search.floorMin ?? null;
  const fMax = search.floorMax ?? null;
  const floor = property.floor ?? null;
  const at = floor === null ? '' : floor === 0 ? 'Rez-de-chaussée' : `${floor === 1 ? '1er' : `${floor}e`} étage`;
  if (fMin !== null) judgeOne('floor', soft.includes('floorMin'), floor === null ? null : floor >= fMin, `${at}, au-dessus du minimum demandé.`, `${at}, sous l’étage demandé.`, 'Étage du bien inconnu.', 'floorMin');
  if (fMax !== null) judgeOne('floor', soft.includes('floorMax'), floor === null ? null : floor <= fMax, `${at}, sous le maximum demandé.`, `${at}, au-dessus de l’étage demandé.`, 'Étage du bien inconnu.', 'floorMax');
  const eMax = search.energyClassMax ?? null;
  if (eMax !== null) {
    const cls = property.energyClass ?? null;
    judgeOne('energy', soft.includes('energy'), cls === null ? null : cls <= eMax, `Classe énergie ${cls} pour ${eMax} au moins.`, `Classe énergie ${cls}, moins bonne que ${eMax}.`, 'Classe énergie du bien inconnue.');
  }
  const lMin = search.landMinM2 ?? null;
  if (lMin !== null) {
    // Un terrain seul n'a pas de fiche de terrain : sa surface enregistrée est celle du terrain.
    const land = property.landM2 ?? (property.kind === 'land' ? property.surfaceM2 : null);
    judgeOne('land', soft.includes('land'), land === null ? null : land >= lMin, `Terrain de ${land} m² pour ${lMin} m² au moins.`, 'Terrain plus petit que demandé.', 'Terrain du bien inconnu.');
  }

  // Les équipements impératifs sont éliminatoires, chaque absence nommée ; une valeur inconnue ne les remplit pas (AU071).
  const required = search.requiredFeatures ?? [];
  if (required.length > 0) {
    const missing = required.filter((f) => !property.features.includes(f));
    if (missing.length === 0) add('features', 'met', `Impératifs présents : ${required.map((f) => FEATURE_LABEL[f] ?? f).join(', ')}.`);
    else add('features', 'unmet', `Impératif absent ou inconnu : ${missing.map((f) => FEATURE_LABEL[f] ?? f).join(', ')}.`);
  }
  const featuresMet = search.features.filter((f) => property.features.includes(f));
  // Une recherche sans aucun critère sur le bien ne se rapproche de rien : aucune proposition sans raison [R51].
  if (checks.length === 0) return { status: 'miss', checks, unmet: [], featuresMet, gap: 0, softMet };
  // Un critère manqué compte une fois, même jugé sur ses deux bornes (l'étage inconnu, par exemple).
  const unmet = [...new Set(checks.filter((c) => c.state === 'unmet').map((c) => c.criterion))];
  const status = unmet.length > 0 ? 'miss' : checks.some((c) => c.state === 'tolerated') ? 'tolerated' : 'match';
  return { status, checks, unmet, featuresMet, gap, softMet };
}

const URGENCY_RANK: Record<Deadline, number> = { now: 0, within_3_months: 1, within_6_months: 2, within_1_year: 3, later: 4 };

/** Une ligne de la liste : l'acquéreur, ses raisons, rien de plus. */
export interface ProposedBuyer {
  rank: number;
  projectId: string;
  personId: string;
  firstName: string | null;
  status: 'match' | 'tolerated';
  reasons: string[];
  featuresMet: BuyerFeature[];
}

export interface DemandMap {
  /** Acquéreurs actifs du réseau dont la recherche est remplie. */
  activeBuyers: number;
  /** Ceux pour qui le bien remplit tous les critères, ou dans les tolérances. */
  matching: number;
  /** Ceux qu'un seul critère écarte, par critère, du plus fréquent au moins fréquent. */
  nearMisses: { criterion: MandatoryCriterion; count: number }[];
}

export type RapprochementRefusal = { ok: false; rule: 'R16' | 'R42'; code: string };

/** La porte de toute diffusion, `Diffusion.canDiffuse` de D05 [R42]. */
export interface DiffusionGate {
  canDiffuse(networkId: string, propertyId: string, at?: Date): Promise<{ allowed: boolean; reason: string }>;
}

export interface RapprochementOptions {
  tolerances?: Tolerances;
  activeDays?: number;
  now?: () => Date;
}

interface Candidate {
  rootId: string;
  memberIds: string[];
  agentIds: (string | null)[];
  firstName: string | null;
  /** Chaque projet d'achat ouvert de la personne, fiches réunies comprises, la recherche la plus fraîche d'abord. */
  projects: { projectId: string; search: BuyerSearch; movedAt: string }[];
}

type Scored = { c: Candidate; projectId: string; search: BuyerSearch; movedAt: string; m: BuyerMatch };

/** L'ordre écrit du classement [R51] : jamais le financement [R14]. */
function compareScored(a: Scored, b: Scored): number {
  const strict = Number(a.m.status !== 'match') - Number(b.m.status !== 'match');
  if (strict !== 0) return strict;
  if (a.m.gap !== b.m.gap) return a.m.gap - b.m.gap;
  // Les souhaits remplis classent : équipements souhaités, et étage, classe ou terrain souhaités (AU072).
  const wa = a.m.featuresMet.length + (a.m.softMet ?? 0);
  const wb = b.m.featuresMet.length + (b.m.softMet ?? 0);
  if (wa !== wb) return wb - wa;
  const ua = a.search.urgency === null ? 5 : URGENCY_RANK[a.search.urgency];
  const ub = b.search.urgency === null ? 5 : URGENCY_RANK[b.search.urgency];
  if (ua !== ub) return ua - ub;
  if (a.movedAt !== b.movedAt) return a.movedAt < b.movedAt ? 1 : -1;
  return a.projectId < b.projectId ? -1 : 1;
}

const placeholders = (n: number): string => Array.from({ length: n }, () => '?').join(', ');
const OUTDOOR_FEATURE: Record<string, BuyerFeature> = { jardin: 'garden', balcon: 'balcony', terrasse: 'terrace' };

export class Rapprochement {
  private readonly now: () => Date;
  private readonly tolerances: Tolerances;
  private readonly activeDays: number;

  constructor(
    private readonly db: SqlDatabase,
    private readonly fiche: FicheUnique,
    private readonly diffusion: DiffusionGate,
    private readonly journal: JournalStore,
    options: RapprochementOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.tolerances = options.tolerances ?? DEFAULT_TOLERANCES;
    this.activeDays = options.activeDays ?? DEFAULT_ACTIVE_DAYS;
  }

  /**
   * Les acquéreurs proposés pour un bien diffusable, classés : d'abord ceux qui remplissent tous les critères, puis
   * ceux qui sont dans les tolérances ; puis par le plus petit écart, le plus de contraintes remplies, l'urgence
   * déclarée et la recherche la plus fraîche [R51]. Un agent ne voit que ses clients, la direction tout le réseau.
   */
  async propose(acces: Acces, viewer: Viewer, propertyId: string, limit = 10): Promise<{ ok: true; value: ProposedBuyer[] } | RapprochementRefusal> {
    if (viewer.role !== 'agent' && viewer.role !== 'direction') return this.refused(viewer, propertyId, 'R16', 'role');
    const read = await acces.readProperty(viewer, propertyId);
    if (!read.ok) return read;
    const gate = await this.diffusion.canDiffuse(viewer.networkId, propertyId, this.now());
    if (!gate.allowed) return this.refused(viewer, propertyId, 'R42', gate.reason);
    const property = await this.propertyForMatch(read.value);
    const ranked: Scored[] = [];
    for (const c of await this.candidates(viewer.networkId)) {
      if (!decideAccess(viewer, { kind: 'person', networkId: viewer.networkId, agentIds: c.agentIds }).allowed) continue;
      // Une ligne par personne : son meilleur projet d'achat pour ce bien.
      const best = c.projects
        .map((p): Scored => ({ c, ...p, m: matchBuyer(property, p.search, this.tolerances) }))
        .filter((x) => x.m.status !== 'miss')
        .sort(compareScored)[0];
      if (best) ranked.push(best);
    }
    ranked.sort(compareScored);
    const value = ranked.slice(0, Math.max(0, limit)).map(({ c, m, projectId }, i): ProposedBuyer => ({
      rank: i + 1,
      projectId,
      personId: c.rootId,
      firstName: c.firstName,
      status: m.status as 'match' | 'tolerated',
      reasons: m.checks.map((check) => check.reason),
      featuresMet: m.featuresMet,
    }));
    await appendEvent(
      this.journal,
      {
        type: 'rapprochement.lu',
        actor: `${viewer.role}:${viewer.userId}`,
        subject: `property:${propertyId}`,
        data: { rule: 'R51', role: viewer.role, count: value.length, persons: value.map((b) => `person:${b.personId}`) },
      },
      this.now,
    );
    return { ok: true, value };
  }

  /**
   * La carte de la demande d'un bien : des comptes sur tout le réseau, sans aucun nom ni identifiant de personne. Pour
   * qui peut lire le bien [R16].
   */
  async demandMap(acces: Acces, viewer: Viewer, propertyId: string): Promise<{ ok: true; value: DemandMap } | RapprochementRefusal> {
    if (viewer.role !== 'agent' && viewer.role !== 'direction') return this.refused(viewer, propertyId, 'R16', 'role');
    const read = await acces.readProperty(viewer, propertyId);
    if (!read.ok) return read;
    const property = await this.propertyForMatch(read.value);
    let active = 0;
    let matching = 0;
    const near = new Map<MandatoryCriterion, number>();
    for (const c of await this.candidates(viewer.networkId)) {
      active += 1;
      const matches = c.projects.map((p) => matchBuyer(property, p.search, this.tolerances));
      if (matches.some((m) => m.status !== 'miss')) {
        matching += 1;
        continue;
      }
      // Proche : aucun projet ne correspond, et le plus proche n'est écarté que par un critère ; une personne ne
      // compte qu'une fois, pour le critère de son projet le plus frais parmi les plus proches.
      const closest = matches.find((m) => m.unmet.length === 1);
      if (closest) near.set(closest.unmet[0]!, (near.get(closest.unmet[0]!) ?? 0) + 1);
    }
    const nearMisses = MANDATORY_CRITERIA.filter((k) => near.has(k))
      .map((criterion) => ({ criterion, count: near.get(criterion)! }))
      .sort((a, b) => b.count - a.count || MANDATORY_CRITERIA.indexOf(a.criterion) - MANDATORY_CRITERIA.indexOf(b.criterion));
    await appendEvent(
      this.journal,
      { type: 'demande.lue', actor: `${viewer.role}:${viewer.userId}`, subject: `property:${propertyId}`, data: { rule: 'R16', role: viewer.role } },
      this.now,
    );
    return { ok: true, value: { activeBuyers: active, matching, nearMisses } };
  }

  /**
   * Le rapprochement fait par le système, sans lecteur : pour les alertes (T03), sur tout le réseau. Rend, pour chaque
   * personne, son meilleur projet, avec l'agent qui la suit ; jamais une donnée de plus. Le bien doit être diffusable,
   * sinon rien [R42].
   */
  async systemMatches(
    networkId: string,
    propertyId: string,
  ): Promise<{ personId: string; projectId: string; agentId: string | null; status: 'match' | 'tolerated'; property: MatchProperty }[]> {
    const p = await this.db.first<Property>('SELECT * FROM properties WHERE id = ? AND network_id = ?', [propertyId, networkId]);
    if (!p) return [];
    if (!(await this.diffusion.canDiffuse(networkId, propertyId, this.now())).allowed) return [];
    const property = await this.propertyForMatch(p);
    const out: { personId: string; projectId: string; agentId: string | null; status: 'match' | 'tolerated'; property: MatchProperty }[] = [];
    for (const c of await this.candidates(networkId)) {
      const best = c.projects
        .map((x): Scored => ({ c, ...x, m: matchBuyer(property, x.search, this.tolerances) }))
        .filter((x) => x.m.status !== 'miss')
        .sort(compareScored)[0];
      if (!best) continue;
      const agentId = c.agentIds.find((a) => a !== null) ?? null;
      out.push({ personId: c.rootId, projectId: best.projectId, agentId, status: best.m.status as 'match' | 'tolerated', property });
    }
    return out;
  }

  /** Le bien vu par le rapprochement : sa fiche de base, et sa fiche complète (P01) quand elle existe. */
  async propertyForMatch(p: Property): Promise<MatchProperty> {
    let bedrooms: number | null = null;
    // La fiche du bien, plus récente, l'emporte sur ce qui a été dit à la création ou à l'import (AU070).
    let dwelling: Dwelling | null = p.kind === 'home' ? (p.dwelling ?? null) : null;
    let floor: number | null = null;
    let landM2: number | null = null;
    let energyClass: string | null = null;
    const features: BuyerFeature[] = [];
    const sheet = await this.db.first<{ data: string }>('SELECT data FROM property_sheets WHERE property_id = ? ORDER BY version DESC LIMIT 1', [p.id]);
    if (sheet) {
      try {
        const parsed: unknown = JSON.parse(sheet.data);
        const raw = typeof parsed === 'object' && parsed !== null ? (parsed as { characteristics?: unknown }).characteristics : undefined;
        if (typeof raw !== 'object' || raw === null) throw new Error('fiche du bien sans caractéristiques');
        const c = raw as { bedrooms?: unknown; outdoor?: unknown; elevator?: unknown; parkingSpaces?: unknown; dwelling?: unknown; floor?: unknown; landM2?: unknown };
        if (typeof c.bedrooms === 'number') bedrooms = c.bedrooms;
        if (c.dwelling === 'house' || c.dwelling === 'apartment') dwelling = c.dwelling;
        if (typeof c.floor === 'number') floor = c.floor;
        if (typeof c.landM2 === 'number') landM2 = c.landM2;
        const e = (parsed as { energy?: { energyClass?: unknown } | null }).energy;
        if (e && typeof e.energyClass === 'string' && /^[A-G]$/.test(e.energyClass)) energyClass = e.energyClass;
        if (Array.isArray(c.outdoor)) for (const o of c.outdoor) if (typeof o === 'string' && OUTDOOR_FEATURE[o]) features.push(OUTDOOR_FEATURE[o]);
        if (c.elevator === true) features.push('elevator');
        if (typeof c.parkingSpaces === 'number' && c.parkingSpaces > 0) features.push('parking');
      } catch {
        // Une fiche illisible ne donne rien de plus que la fiche de base ; l'écart est écrit au journal, sans donnée.
        await appendEvent(
          this.journal,
          { type: 'rapprochement.fiche_illisible', actor: 'system:rapprochement', subject: `property:${p.id}`, data: { rule: 'R51' } },
          this.now,
        );
      }
    }
    return { kind: p.kind, dwelling: p.kind === 'home' ? dwelling : null, city: p.city, priceEur: await shownPrice(this.db, p.id, p.price_eur), surfaceM2: p.surface_m2, rooms: p.rooms, bedrooms, features, floor, energyClass, landM2 };
  }

  /**
   * Les acquéreurs actifs du réseau : la dernière recherche de chaque projet d'achat ouvert, groupées par personne
   * réunie, jamais une personne exclue ou qui a demandé l'arrêt [R02, R04].
   */
  private async candidates(networkId: string): Promise<Candidate[]> {
    const at = this.now();
    const since = new Date(at.getTime() - this.activeDays * 86_400_000).toISOString();
    const rows = await this.db.all<BuyerSearchRow & { stage: string; confirmed_at: string | null }>(
      `SELECT s.*, p.stage, (SELECT max(c.confirmed_at) FROM buyer_search_confirmations c WHERE c.project_id = s.project_id) AS confirmed_at
       FROM buyer_searches s JOIN projects p ON p.id = s.project_id
       WHERE s.network_id = ? AND p.kind = 'buy'
         AND s.version = (SELECT max(version) FROM buyer_searches WHERE project_id = s.project_id)
       ORDER BY s.created_at DESC, s.project_id`,
      [networkId],
    );
    const nowIso = at.toISOString();
    const byRoot = new Map<string, Candidate>();
    for (const row of rows) {
      if (CLOSED_STAGES.includes(row.stage)) continue;
      // Active si la recherche a bougé, ou si l'acquéreur l'a dite toujours d'actualité, depuis moins de `activeDays` jours (AU074).
      const movedAt = row.confirmed_at && row.confirmed_at > row.created_at ? row.confirmed_at : row.created_at;
      if (movedAt < since) continue;
      const search = toVersion(row).search;
      // Une recherche sans aucun critère sur le bien n'est pas encore une recherche : elle ne compte pas.
      if (
        search.propertyKinds.length === 0 &&
        search.communes.length === 0 &&
        search.budgetMaxEur === null &&
        search.surfaceMinM2 === null &&
        search.roomsMin === null &&
        search.bedroomsMin === null &&
        (search.requiredFeatures ?? []).length === 0 &&
        (search.floorMin ?? null) === null &&
        (search.floorMax ?? null) === null &&
        (search.energyClassMax ?? null) === null &&
        (search.landMinM2 ?? null) === null
      ) continue;
      const view = await this.fiche.view(row.person_id);
      const root = view.person.id;
      const known = byRoot.get(root);
      if (known) {
        known.projects.push({ projectId: row.project_id, search, movedAt });
        continue;
      }
      const ids = view.members.map((m) => m.id);
      const excluded = await this.db.first<{ n: number }>(
        `SELECT count(*) AS n FROM exclusions WHERE person_id IN (${placeholders(ids.length)}) AND noted_at <= ? AND (lifted_at IS NULL OR lifted_at > ?)`,
        [...ids, nowIso, nowIso],
      );
      if (Number(excluded?.n ?? 0) > 0) continue;
      byRoot.set(root, {
        rootId: root,
        memberIds: ids,
        agentIds: view.members.map((m) => m.agent_id),
        firstName: view.members.map((m) => m.first_name).find((n) => n) ?? null,
        projects: [{ projectId: row.project_id, search, movedAt }],
      });
    }
    return [...byRoot.values()];
  }

  private async refused(viewer: Viewer, propertyId: string, rule: 'R16' | 'R42', code: string): Promise<RapprochementRefusal> {
    await appendEvent(
      this.journal,
      {
        type: rule === 'R16' ? 'acces.refuse' : 'rapprochement.refuse',
        actor: `${String(viewer.role)}:${viewer.userId}`,
        subject: `property:${propertyId}`,
        data: { rule, role: String(viewer.role), kind: 'rapprochement', code },
      },
      this.now,
    );
    return { ok: false, rule, code };
  }
}
