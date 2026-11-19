/**
 * La fiche acquéreur (M08, T01) : la recherche d'un projet d'achat, versionnée. Une modification ajoute une version,
 * l'ancienne reste lisible [R17]. Seulement des champs sur le bien et le projet, pris dans des listes fermées : aucun
 * texte libre, aucun critère discriminant [R50]. Chaque champ rempli porte sa source, le message reçu ou la personne
 * qui l'a écrit.
 *
 * Mise à jour depuis la qualification de Q01, seulement avec ce que le message dit [R10] ; un champ que l'agent a
 * écrit lui-même n'est plus changé par un message : la parole de l'agent l'emporte. Lecture et écriture sous R16, et
 * chaque geste au journal, sans aucune valeur de la recherche [R13].
 */
import type { Acces } from '../acces/acces.ts';
import type { Viewer } from '../acces/droits.ts';
import type { SqlDatabase } from '../db/sql.ts';
import type { Project } from '../db/types.ts';
import { plain } from '../envoi/texte.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import { DEADLINES, DEFAULT_COMMUNES, FINANCINGS, isCriterion, type Deadline, type Financing } from '../qualification/regles.ts';

/** Les types de bien recherchés : une liste fermée. */
export const BUYER_PROPERTY_KINDS = ['house', 'apartment', 'land', 'building', 'commercial'] as const;
export type BuyerPropertyKind = (typeof BUYER_PROPERTY_KINDS)[number];

/** Les contraintes sur le bien : une liste fermée, rien sur la personne [R50]. */
export const BUYER_FEATURES = [
  'garden',
  'balcony',
  'terrace',
  'garage',
  'parking',
  'cellar',
  'elevator',
  'pool',
  'single_storey',
  'quiet',
  'bright',
  'view',
  'fireplace',
  'outbuilding',
] as const;
export type BuyerFeature = (typeof BUYER_FEATURES)[number];

/** La recherche, et seulement ces champs. */
export interface BuyerSearch {
  propertyKinds: BuyerPropertyKind[];
  communes: string[];
  features: BuyerFeature[];
  surfaceMinM2: number | null;
  roomsMin: number | null;
  bedroomsMin: number | null;
  budgetMaxEur: number | null;
  /** Les équipements sans lesquels la personne ne veut pas du bien : éliminatoires, quand `features` n'en fait que des souhaits (AU071). */
  requiredFeatures?: BuyerFeature[];
  /** Le budget dit infranchissable : aucune tolérance au-dessus (AU115). */
  budgetStrict?: boolean;
  /** Étages acceptés, 0 pour le rez-de-chaussée : « pas de rez-de-chaussée » donne 1 au moins (AU072). */
  floorMin?: number | null;
  floorMax?: number | null;
  /** La classe énergie la moins bonne acceptée : « D au moins » accepte A à D (AU072). */
  energyClassMax?: SearchEnergyClass | null;
  /** Le terrain minimal, en m² (AU072). */
  landMinM2?: number | null;
  /** Parmi l'étage, la classe et le terrain, ceux qui ne sont que des souhaits : jamais éliminatoires (AU072). */
  softCriteria?: SoftCriterion[];
  /** Tel que la personne l'a déclaré, jamais évalué [R24]. */
  financing: Financing | null;
  urgency: Deadline | null;
}
export type SearchField = keyof BuyerSearch;

export const SEARCH_ENERGY_CLASSES = ['A', 'B', 'C', 'D', 'E', 'F', 'G'] as const;
export type SearchEnergyClass = (typeof SEARCH_ENERGY_CLASSES)[number];
export const SOFT_CRITERIA = ['floor', 'energy', 'land'] as const;
export type SoftCriterion = (typeof SOFT_CRITERIA)[number];

export const SEARCH_FIELDS: readonly SearchField[] = [
  'propertyKinds',
  'communes',
  'features',
  'surfaceMinM2',
  'roomsMin',
  'bedroomsMin',
  'budgetMaxEur',
  'requiredFeatures',
  'budgetStrict',
  'floorMin',
  'floorMax',
  'energyClassMax',
  'landMinM2',
  'softCriteria',
  'financing',
  'urgency',
];

/**
 * Les critères discriminants, liste fermée de mots : un champ ou une valeur qui en porte un est refusé avec R50, nommé
 * comme tel. Tout autre champ inconnu est refusé aussi : la liste des champs est fermée.
 */
export const DISCRIMINATING_TERMS: readonly string[] = Object.freeze([
  'origine',
  'origin',
  'ethnie',
  'ethnique',
  'ethnicity',
  'race',
  'racial',
  'couleur de peau',
  'religion',
  'religieux',
  'confession',
  'culte',
  'nationalite',
  'nationality',
  'situation de famille',
  'situation familiale',
  'family',
  'famille',
  'enfant',
  'enfants',
  'children',
  'celibataire',
  'marie',
  'mariee',
  'couple',
  'handicap',
  'disability',
  'sante',
  'health',
  'sexe',
  'genre',
  'gender',
  'orientation sexuelle',
  'age',
  'grossesse',
  'enceinte',
  'opinion politique',
  'politique',
  'syndicat',
  'syndical',
  'patronyme',
  'apparence',
  'langue maternelle',
  'lieu de residence',
]);

const termKey = (value: string): string => plain(value).replace(/[^a-z0-9]+/g, ' ').trim();
const TERM_KEYS = DISCRIMINATING_TERMS.map(termKey);

/** Le mot ou la clé porte un critère discriminant de la liste fermée. */
export function isDiscriminating(value: string): boolean {
  const p = ` ${termKey(value.replace(/([a-z])([A-Z])/g, '$1 $2'))} `;
  return TERM_KEYS.some((t) => p.includes(` ${t} `));
}

export type SearchRefusal = {
  ok: false;
  rule: 'R50' | 'R16';
  /** `discriminant`, `champ_inconnu`, `hors_liste`, `valeur`, ou un code d'accès. */
  code: string;
  /** Le champ en cause, seulement quand il fait partie des champs prévus. */
  field?: SearchField;
};
export type SearchCheck = { ok: true; value: Partial<BuyerSearch> } | SearchRefusal;

const LIST_FIELDS: readonly SearchField[] = ['propertyKinds', 'communes', 'features', 'requiredFeatures', 'softCriteria'];
const INT_LIMITS: Partial<Record<SearchField, [number, number]>> = {
  floorMin: [0, 100],
  floorMax: [0, 100],
  landMinM2: [1, 10_000_000],
  surfaceMinM2: [1, 100_000],
  roomsMin: [1, 50],
  bedroomsMin: [1, 50],
  budgetMaxEur: [1, 1_000_000_000],
};

const refuse = (code: string, field?: SearchField, rule: 'R50' | 'R16' = 'R50'): SearchRefusal =>
  field === undefined ? { ok: false, rule, code } : { ok: false, rule, code, field };

function isListed(key: string, value: string, communes: readonly string[]): boolean {
  if (key === 'communes') return communes.some((c) => termKey(c) === termKey(value));
  if (key === 'propertyKinds') return (BUYER_PROPERTY_KINDS as readonly string[]).includes(value);
  if (key === 'features' || key === 'requiredFeatures') return (BUYER_FEATURES as readonly string[]).includes(value);
  if (key === 'softCriteria') return (SOFT_CRITERIA as readonly string[]).includes(value);
  if (key === 'energyClassMax') return (SEARCH_ENERGY_CLASSES as readonly string[]).includes(value);
  if (key === 'financing') return (FINANCINGS as readonly string[]).includes(value);
  if (key === 'urgency') return (DEADLINES as readonly string[]).includes(value);
  return false;
}

/**
 * Contrôle d'une modification de la recherche : seulement des champs prévus, des valeurs prises dans leur liste fermée
 * et des nombres entiers bornés. `null` retire un critère ; une liste vide aussi.
 */
export function checkSearchChanges(input: unknown, communes: readonly string[] = DEFAULT_COMMUNES): SearchCheck {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return refuse('valeur');
  const out: Partial<Record<SearchField, unknown>> = {};
  const entries = Object.entries(input as Record<string, unknown>);
  // Un critère discriminant est nommé comme tel, où qu'il soit, avant toute autre erreur.
  for (const [key, value] of entries) {
    if (isDiscriminating(key)) return refuse('discriminant');
    const values = Array.isArray(value) ? value : [value];
    for (const v of values) {
      // Une valeur de liste fermée reste permise, même si son nom ressemble à un mot de la liste (une commune).
      if (typeof v === 'string' && isDiscriminating(v) && !isListed(key, v, communes)) {
        return (SEARCH_FIELDS as readonly string[]).includes(key) ? refuse('discriminant', key as SearchField) : refuse('discriminant');
      }
    }
  }
  for (const [key, value] of entries) {
    if (!(SEARCH_FIELDS as readonly string[]).includes(key)) return refuse('champ_inconnu');
    const field = key as SearchField;
    if (LIST_FIELDS.includes(field)) {
      if (value === null) {
        out[field] = [];
        continue;
      }
      if (!Array.isArray(value) || value.length > 50) return refuse('valeur', field);
      const kept: string[] = [];
      for (const v of value) {
        if (typeof v !== 'string') return refuse('valeur', field);
        let canonical: string | undefined;
        if (field === 'communes') canonical = communes.find((c) => termKey(c) === termKey(v));
        else if (field === 'propertyKinds') canonical = (BUYER_PROPERTY_KINDS as readonly string[]).includes(v) ? v : undefined;
        else if (field === 'softCriteria') canonical = (SOFT_CRITERIA as readonly string[]).includes(v) ? v : undefined;
        else canonical = (BUYER_FEATURES as readonly string[]).includes(v) ? v : undefined;
        if (canonical === undefined) return refuse('hors_liste', field);
        if (!kept.includes(canonical)) kept.push(canonical);
      }
      out[field] = kept;
      continue;
    }
    if (field === 'budgetStrict') {
      if (value !== null && typeof value !== 'boolean') return refuse('valeur', field);
      out[field] = value === true;
      continue;
    }
    if (value === null) {
      out[field] = null;
      continue;
    }
    const limits = INT_LIMITS[field];
    if (limits) {
      if (typeof value !== 'number' || !Number.isInteger(value) || value < limits[0] || value > limits[1]) return refuse('valeur', field);
      out[field] = value;
      continue;
    }
    const allowed: readonly string[] = field === 'financing' ? FINANCINGS : field === 'energyClassMax' ? SEARCH_ENERGY_CLASSES : DEADLINES;
    if (typeof value !== 'string' || !allowed.includes(value)) return refuse('hors_liste', field);
    out[field] = value;
  }
  // Un étage minimal au-dessus du maximal ne laisse aucun bien : refusé, nommé.
  const fMin = 'floorMin' in out ? out.floorMin : undefined;
  const fMax = 'floorMax' in out ? out.floorMax : undefined;
  if (typeof fMin === 'number' && typeof fMax === 'number' && fMin > fMax) return refuse('valeur', 'floorMin');
  return { ok: true, value: out as Partial<BuyerSearch> };
}

export interface BuyerSearchRow {
  id: string;
  network_id: string;
  project_id: string;
  person_id: string;
  version: number;
  property_kinds: string;
  communes: string;
  features: string;
  surface_min_m2: number | null;
  rooms_min: number | null;
  bedrooms_min: number | null;
  budget_max_eur: number | null;
  required_features?: string | null;
  budget_strict?: number | null;
  floor_min?: number | null;
  floor_max?: number | null;
  energy_class_max?: string | null;
  land_min_m2?: number | null;
  soft_criteria?: string | null;
  financing: Financing | null;
  urgency: Deadline | null;
  sources: string;
  origin: string;
  created_at: string;
}

/** Une version de la recherche, avec la source de chaque champ rempli. */
export interface BuyerSearchVersion {
  id: string;
  projectId: string;
  personId: string;
  version: number;
  search: BuyerSearch;
  /** Champ → `message:<id>`, `agent:<id>` ou `direction:<id>`. */
  sources: Partial<Record<SearchField, string>>;
  origin: string;
  createdAt: string;
}

export const EMPTY_SEARCH: Readonly<BuyerSearch> = Object.freeze({
  propertyKinds: [],
  communes: [],
  features: [],
  surfaceMinM2: null,
  roomsMin: null,
  bedroomsMin: null,
  budgetMaxEur: null,
  requiredFeatures: [],
  budgetStrict: false,
  floorMin: null,
  floorMax: null,
  energyClassMax: null,
  landMinM2: null,
  softCriteria: [],
  financing: null,
  urgency: null,
});

const parseList = <T extends string>(json: string): T[] => {
  try {
    const value: unknown = JSON.parse(json);
    return Array.isArray(value) ? (value.filter((v) => typeof v === 'string') as T[]) : [];
  } catch {
    return [];
  }
};

export function toVersion(row: BuyerSearchRow): BuyerSearchVersion {
  let sources: Partial<Record<SearchField, string>> = {};
  try {
    const parsed: unknown = JSON.parse(row.sources);
    if (parsed && typeof parsed === 'object') sources = parsed as Partial<Record<SearchField, string>>;
  } catch {
    sources = {};
  }
  return {
    id: row.id,
    projectId: row.project_id,
    personId: row.person_id,
    version: row.version,
    search: {
      propertyKinds: parseList<BuyerPropertyKind>(row.property_kinds),
      communes: parseList<string>(row.communes),
      features: parseList<BuyerFeature>(row.features),
      surfaceMinM2: row.surface_min_m2,
      roomsMin: row.rooms_min,
      bedroomsMin: row.bedrooms_min,
      budgetMaxEur: row.budget_max_eur,
      requiredFeatures: parseList<BuyerFeature>(row.required_features ?? '[]'),
      budgetStrict: Number(row.budget_strict ?? 0) === 1,
      floorMin: row.floor_min ?? null,
      floorMax: row.floor_max ?? null,
      energyClassMax: (row.energy_class_max ?? null) as SearchEnergyClass | null,
      landMinM2: row.land_min_m2 ?? null,
      softCriteria: parseList<SoftCriterion>(row.soft_criteria ?? '[]'),
      financing: row.financing,
      urgency: row.urgency,
    },
    sources,
    origin: row.origin,
    createdAt: row.created_at,
  };
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** Ce qu'un message de type « studio » ou « maison » dit du type de bien. */
const KIND_OF_CRITERION: Record<string, BuyerPropertyKind> = {
  house: 'house',
  apartment: 'apartment',
  studio: 'apartment',
  land: 'land',
  building: 'building',
};

export type UpdateResult =
  | { ok: true; created: boolean; value: BuyerSearchVersion | null }
  | SearchRefusal;

export interface FicheAcquereurOptions {
  communes?: readonly string[];
  now?: () => Date;
  newId?: () => string;
}

interface QualificationRow {
  id: string;
  network_id: string;
  inbound_id: string;
  project_id: string | null;
  category: string;
  city: string | null;
  budget_max_eur: number | null;
  deadline: Deadline | null;
  financing: Financing | null;
  criteria: string;
}

export class FicheAcquereur {
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly communes: readonly string[];

  constructor(
    private readonly db: SqlDatabase,
    private readonly journal: JournalStore,
    options: FicheAcquereurOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => crypto.randomUUID());
    this.communes = options.communes ?? DEFAULT_COMMUNES;
  }

  /** La dernière version, sans contrôle d'accès : pour le code du système (rapprochement). */
  async current(projectId: string): Promise<BuyerSearchVersion | null> {
    const row = await this.db.first<BuyerSearchRow>('SELECT * FROM buyer_searches WHERE project_id = ? ORDER BY version DESC LIMIT 1', [projectId]);
    return row ? toVersion(row) : null;
  }

  /** La recherche et toutes ses versions, pour qui voit la fiche en entier [R16]. */
  async read(
    acces: Acces,
    viewer: Viewer,
    projectId: string,
  ): Promise<{ ok: true; value: { current: BuyerSearchVersion | null; history: BuyerSearchVersion[] } } | SearchRefusal> {
    const project = await this.buyProject(viewer, projectId);
    if (!project) return this.refused(viewer, projectId, 'unknown');
    const read = await acces.readFiche(viewer, project.person_id);
    if (!read.ok) return refuse(read.code, undefined, 'R16');
    if (read.view !== 'full') return this.refused(viewer, projectId, 'not_assigned');
    const rows = await this.db.all<BuyerSearchRow>('SELECT * FROM buyer_searches WHERE project_id = ? ORDER BY version', [projectId]);
    const history = rows.map(toVersion);
    return { ok: true, value: { current: history.at(-1) ?? null, history } };
  }

  /**
   * L'agent de la fiche ou la direction modifie la recherche : une nouvelle version, l'ancienne gardée [R17]. Un
   * champ hors liste ou discriminant est refusé, et le refus va au journal sans la valeur [R13, R50].
   */
  /**
   * L'acquéreur dit sa recherche toujours d'actualité (AU074) : elle reste active au rapprochement sans que l'agent
   * modifie un critère. Mêmes droits qu'une modification ; une ligne par confirmation, rien ne change ni ne s'efface.
   */
  async confirm(acces: Acces, viewer: Viewer, projectId: string): Promise<{ ok: true; value: { confirmedAt: string } } | SearchRefusal> {
    const project = await this.buyProject(viewer, projectId);
    if (!project) return this.refused(viewer, projectId, 'unknown');
    if (viewer.role !== 'agent' && viewer.role !== 'direction') return this.refused(viewer, projectId, 'role');
    const read = await acces.readFiche(viewer, project.person_id);
    if (!read.ok) return refuse(read.code, undefined, 'R16');
    if (read.view !== 'full') return this.refused(viewer, projectId, 'not_assigned');
    if (!(await this.current(project.id))) return refuse('sans_recherche', undefined, 'R16');
    const at = this.now().toISOString();
    await this.db.run('INSERT INTO buyer_search_confirmations (project_id, network_id, confirmed_at, confirmed_by) VALUES (?, ?, ?, ?)', [project.id, project.network_id, at, `${viewer.role}:${viewer.userId}`]);
    await appendEvent(this.journal, { type: 'acquereur.recherche_confirmee', actor: `${viewer.role}:${viewer.userId}`, subject: `person:${project.person_id}`, data: { project: project.id } }, this.now);
    return { ok: true, value: { confirmedAt: at } };
  }

  async update(acces: Acces, viewer: Viewer, projectId: string, input: unknown): Promise<UpdateResult> {
    const project = await this.buyProject(viewer, projectId);
    if (!project) return this.refused(viewer, projectId, 'unknown');
    if (viewer.role !== 'agent' && viewer.role !== 'direction') {
      // La conformité lit, elle n'écrit pas la recherche d'un client.
      await acces.readFiche(viewer, project.person_id);
      return this.refused(viewer, projectId, 'role');
    }
    const read = await acces.readFiche(viewer, project.person_id);
    if (!read.ok) return refuse(read.code, undefined, 'R16');
    if (read.view !== 'full') return this.refused(viewer, projectId, 'not_assigned');

    const checked = checkSearchChanges(input, this.communes);
    if (!checked.ok) {
      await appendEvent(
        this.journal,
        {
          type: 'acquereur.refuse',
          actor: `${viewer.role}:${viewer.userId}`,
          subject: `person:${project.person_id}`,
          data: { rule: checked.rule, code: checked.code, project: projectId, ...(checked.field ? { field: checked.field } : {}) },
        },
        this.now,
      );
      return checked;
    }
    const author = `${viewer.role}:${viewer.userId}`;
    return this.addVersion(project, author, `${author}`, () => checked.value, author);
  }

  /**
   * La recherche complétée depuis une qualification d'acquéreur (Q01) : seulement ce que le message dit [R10], une
   * seule fois par qualification [R18]. Un champ écrit par l'agent ou la direction n'est pas changé par un message.
   */
  async fromQualification(qualificationId: string): Promise<BuyerSearchVersion | null> {
    const q = await this.db.first<QualificationRow>(
      'SELECT id, network_id, inbound_id, project_id, category, city, budget_max_eur, deadline, financing, criteria FROM qualifications WHERE id = ?',
      [qualificationId],
    );
    if (!q || q.category !== 'buyer' || q.project_id === null) return null;
    const project = await this.db.first<Project>("SELECT * FROM projects WHERE id = ? AND network_id = ? AND kind = 'buy'", [q.project_id, q.network_id]);
    if (!project) return null;
    const origin = `qualification:${q.id}`;
    const done = await this.db.first<BuyerSearchRow>('SELECT * FROM buyer_searches WHERE project_id = ? AND origin = ?', [project.id, origin]);
    if (done) return toVersion(done);

    const said: Partial<BuyerSearch> = {};
    const criteria = parseList<string>(q.criteria).filter((c) => isCriterion(c));
    const kinds = [...new Set(criteria.map((c) => KIND_OF_CRITERION[c]).filter((k): k is BuyerPropertyKind => k !== undefined))];
    if (kinds.length > 0) said.propertyKinds = kinds;
    const features = criteria.filter((c): c is BuyerFeature => (BUYER_FEATURES as readonly string[]).includes(c));
    if (features.length > 0) said.features = features;
    const city = q.city === null ? undefined : this.communes.find((c) => termKey(c) === termKey(q.city ?? ''));
    if (city) said.communes = [city];
    for (const c of criteria) {
      const m = /^(rooms|bedrooms):(\d{1,2})$/.exec(c);
      if (m) said[m[1] === 'rooms' ? 'roomsMin' : 'bedroomsMin'] = Number(m[2]);
    }
    if (q.budget_max_eur !== null && q.budget_max_eur > 0) said.budgetMaxEur = q.budget_max_eur;
    if (q.financing !== null) said.financing = q.financing;
    if (q.deadline !== null) said.urgency = q.deadline;

    const source = `message:${q.inbound_id}`;
    const receivedAt = async (inboundId: string): Promise<string | null> =>
      (await this.db.first<{ received_at: string }>('SELECT received_at FROM inbound_messages WHERE id = ?', [inboundId]))?.received_at ?? null;
    const mine = await receivedAt(q.inbound_id);
    // La date des messages déjà sources d'un champ : un message plus ancien, rejoué ou traité en retard, ne remplace
    // jamais ce qu'un message plus récent a dit. Une source inconnue ici (écrite entre-temps) est tenue pour plus récente.
    const dates = new Map<string, string | null>();
    for (const from of Object.values((await this.current(project.id))?.sources ?? {})) {
      if (from?.startsWith('message:') && !dates.has(from)) dates.set(from, await receivedAt(from.slice('message:'.length)));
    }
    const newer = (from: string): boolean => {
      if (from === source) return false;
      if (!dates.has(from)) return true;
      const theirs = dates.get(from) ?? null;
      return mine === null || (theirs !== null && mine < theirs);
    };
    const result = await this.addVersion(
      project,
      'system:qualification',
      origin,
      (previous, sources) => {
        const changes: Partial<Record<SearchField, unknown>> = {};
        for (const field of SEARCH_FIELDS) {
          const value = said[field];
          if (value === undefined) continue;
          // La parole de l'agent l'emporte sur un message.
          const from = sources[field];
          if (from !== undefined && !from.startsWith('message:')) continue;
          // Les listes s'ajoutent à ce qui est déjà dit ; un nombre ou un état dit plus tard remplace l'ancien, jamais
          // celui d'un message plus récent.
          if (Array.isArray(value)) changes[field] = [...new Set([...(previous[field] as string[]), ...value])];
          else if (from === undefined || !newer(from)) changes[field] = value;
        }
        return changes as Partial<BuyerSearch>;
      },
      source,
    );
    if (!result.ok) return null;
    if (result.value) return result.value;
    return this.current(project.id);
  }

  /**
   * Ajoute une version si quelque chose change ; deux écritures simultanées ne prennent jamais le même numéro, la
   * seconde se recalcule sur la première.
   */
  private async addVersion(
    project: Project,
    actor: string,
    origin: string,
    changesOf: (previous: BuyerSearch, sources: Partial<Record<SearchField, string>>) => Partial<BuyerSearch>,
    source: string,
  ): Promise<UpdateResult> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const last = await this.current(project.id);
      const previous: BuyerSearch = last ? last.search : { ...EMPTY_SEARCH, propertyKinds: [], communes: [], features: [], requiredFeatures: [], softCriteria: [] };
      const sources: Partial<Record<SearchField, string>> = last ? { ...last.sources } : {};
      const changes = changesOf(previous, sources);
      const next: BuyerSearch = { ...previous };
      const changed: SearchField[] = [];
      for (const field of SEARCH_FIELDS) {
        if (!(field in changes)) continue;
        const value = changes[field];
        if (same(value, previous[field])) continue;
        (next as unknown as Record<string, unknown>)[field] = value;
        changed.push(field);
        // Même vidé, un champ garde qui l'a vidé : un message suivant ne le remplit pas contre l'avis de l'agent.
        sources[field] = source;
      }
      if (changed.length === 0) return { ok: true, created: false, value: last };
      const version = (last?.version ?? 0) + 1;
      const id = this.newId();
      const { changes: inserted } = await this.db.run(
        `INSERT INTO buyer_searches (id, network_id, project_id, person_id, version, property_kinds, communes, features, surface_min_m2,
           rooms_min, bedrooms_min, budget_max_eur, required_features, budget_strict, floor_min, floor_max, energy_class_max, land_min_m2, soft_criteria,
           financing, urgency, sources, origin, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
        [
          id,
          project.network_id,
          project.id,
          project.person_id,
          version,
          JSON.stringify(next.propertyKinds),
          JSON.stringify(next.communes),
          JSON.stringify(next.features),
          next.surfaceMinM2,
          next.roomsMin,
          next.bedroomsMin,
          next.budgetMaxEur,
          JSON.stringify(next.requiredFeatures ?? []),
          next.budgetStrict ? 1 : 0,
          next.floorMin ?? null,
          next.floorMax ?? null,
          next.energyClassMax ?? null,
          next.landMinM2 ?? null,
          JSON.stringify(next.softCriteria ?? []),
          next.financing,
          next.urgency,
          JSON.stringify(sources),
          origin,
          this.now().toISOString(),
        ],
      );
      if (inserted !== 1) {
        // Une qualification déjà appliquée par une écriture simultanée : rien à refaire.
        if (origin.startsWith('qualification:')) {
          const done = await this.db.first<BuyerSearchRow>('SELECT * FROM buyer_searches WHERE project_id = ? AND origin = ?', [project.id, origin]);
          if (done) return { ok: true, created: false, value: toVersion(done) };
        }
        continue;
      }
      await appendEvent(
        this.journal,
        { type: 'acquereur.fiche', actor, subject: `person:${project.person_id}`, data: { project: project.id, version, fields: changed } },
        this.now,
      );
      const row = await this.db.first<BuyerSearchRow>('SELECT * FROM buyer_searches WHERE id = ?', [id]);
      return { ok: true, created: true, value: row ? toVersion(row) : null };
    }
    throw new Error('fiche acquéreur : trop d’écritures simultanées');
  }

  private async buyProject(viewer: Viewer, projectId: string): Promise<Project | null> {
    return this.db.first<Project>("SELECT * FROM projects WHERE id = ? AND network_id = ? AND kind = 'buy'", [projectId, viewer.networkId]);
  }

  private async refused(viewer: Viewer, projectId: string, code: string): Promise<SearchRefusal> {
    await appendEvent(
      this.journal,
      {
        type: 'acces.refuse',
        actor: `${String(viewer.role)}:${viewer.userId}`,
        subject: `project:${projectId}`,
        data: { rule: 'R16', role: String(viewer.role), kind: 'buyer_search', code },
      },
      this.now,
    );
    return refuse(code, undefined, 'R16');
  }
}
