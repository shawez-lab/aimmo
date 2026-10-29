/**
 * Les repreneurs de commerces (M16, CE06) : le profil d'un projet `buy_business`, versionné, sans évaluation de
 * solvabilité [R115, R14].
 *
 * Le profil ne porte que ce que la personne cherche et ce qu'elle déclare, tel qu'elle le dit : activités et sortes de
 * biens (listes fermées), secteurs (codes postaux), budget, expérience (liste fermée), apport et financement déclarés.
 * Aucun champ de revenus, de patrimoine, de crédit, de note ni de score : un champ inconnu est refusé, jamais ignoré.
 * Chaque champ rempli porte sa source (l'agent ou la direction qui l'a écrit) ; rien n'est déduit ni inventé [R10].
 *
 * Le rapprochement, par le code, ne range que des biens : les présentations publiables (CE03) dont la vue publique
 * répond à chaque critère rempli (activité, sorte, code postal, fourchette basse dans le budget), triées par une règle
 * écrite (fourchette basse croissante, puis commune, puis identifiant). Il ne trie ni ne note jamais les repreneurs ; il
 * ne lit jamais l'apport, le financement ni l'expérience [R14]. Lecture et écriture sous R16, journal sans valeur [R13].
 */
import type { Acces } from '../acces/acces.ts';
import type { Viewer } from '../acces/droits.ts';
import type { SqlDatabase } from '../db/sql.ts';
import type { PropertyKind } from '../db/types.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import type { EstimationCommerce } from './estimation.ts';
import { ACTIVITIES, BUSINESS_KINDS, type Activity, type BusinessPublicView, type FicheCommerce } from './fiche.ts';
import { toEuros, type PresentationCommerce } from './presentation.ts';

export const BUYER_EXPERIENCES = ['aucune', 'salarie_du_metier', 'gerant_du_metier', 'gerant_autre_metier', 'reconversion'] as const;
export type BuyerExperience = (typeof BUYER_EXPERIENCES)[number];

export const DECLARED_FINANCINGS = ['apport_seul', 'pret_bancaire', 'pret_et_apport', 'a_definir'] as const;
export type DeclaredFinancing = (typeof DECLARED_FINANCINGS)[number];

/** Le profil, et seulement ces champs. */
export interface BusinessBuyerProfile {
  activities: Activity[];
  kinds: PropertyKind[];
  postalCodes: string[];
  budgetMaxEur: number | null;
  experience: BuyerExperience | null;
  declaredContributionEur: number | null;
  declaredFinancing: DeclaredFinancing | null;
}
export type BuyerField = keyof BusinessBuyerProfile;

export const BUYER_FIELDS: readonly BuyerField[] = ['activities', 'kinds', 'postalCodes', 'budgetMaxEur', 'experience', 'declaredContributionEur', 'declaredFinancing'];

const EMPTY: BusinessBuyerProfile = { activities: [], kinds: [], postalCodes: [], budgetMaxEur: null, experience: null, declaredContributionEur: null, declaredFinancing: null };

export interface BuyerProfileVersion {
  projectId: string;
  version: number;
  profile: BusinessBuyerProfile;
  /** Champ → `agent:<id>` ou `direction:<id>`. */
  sources: Partial<Record<BuyerField, string>>;
  author: string;
  createdAt: string;
}

export interface BusinessMatch {
  propertyId: string;
  publicView: BusinessPublicView;
  title: string;
  priceLowEuros: number;
  priceHighEuros: number;
}

type Refusal = { ok: false; rule: 'R16'; code: string };
type Problem = { ok: false; rule: 'R115' | null; code: 'champ_inconnu' | 'valeur' | 'hors_liste' | 'projet' | 'unknown_project'; field?: string };
export type BuyerResult<T> = { ok: true; value: T } | Refusal | Problem;

const MAX_EUR = 1_000_000_000;
const isEur = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= MAX_EUR;

/** Contrôle d'une modification du profil : champs prévus, listes fermées, montants bornés. `null` retire un champ. */
export function checkBuyerChanges(input: unknown): { ok: true; value: Partial<BusinessBuyerProfile> } | Problem {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return { ok: false, rule: null, code: 'valeur' };
  const entries = Object.entries(input as Record<string, unknown>);
  if (entries.length === 0) return { ok: false, rule: null, code: 'valeur' };
  // Un champ inconnu (revenus, patrimoine, crédit, note…) est refusé, jamais ignoré [R115].
  for (const [key] of entries) if (!(BUYER_FIELDS as readonly string[]).includes(key)) return { ok: false, rule: 'R115', code: 'champ_inconnu', field: key };
  const out: Partial<Record<BuyerField, unknown>> = {};
  for (const [key, value] of entries) {
    const field = key as BuyerField;
    if (field === 'activities' || field === 'kinds' || field === 'postalCodes') {
      if (value === null) {
        out[field] = [];
        continue;
      }
      if (!Array.isArray(value) || value.length > 30) return { ok: false, rule: null, code: 'valeur', field };
      const list = field === 'activities' ? (ACTIVITIES as readonly string[]) : field === 'kinds' ? (BUSINESS_KINDS as readonly string[]) : null;
      const kept: string[] = [];
      for (const v of value) {
        if (typeof v !== 'string') return { ok: false, rule: null, code: 'valeur', field };
        if (list && !list.includes(v)) return { ok: false, rule: null, code: 'hors_liste', field };
        if (!list && !/^\d{5}$/.test(v)) return { ok: false, rule: null, code: 'valeur', field };
        if (!kept.includes(v)) kept.push(v);
      }
      out[field] = kept.sort();
      continue;
    }
    if (value === null) {
      out[field] = null;
      continue;
    }
    if (field === 'budgetMaxEur' || field === 'declaredContributionEur') {
      if (!isEur(value)) return { ok: false, rule: null, code: 'valeur', field };
      out[field] = value;
      continue;
    }
    const list = field === 'experience' ? BUYER_EXPERIENCES : DECLARED_FINANCINGS;
    if (typeof value !== 'string' || !(list as readonly string[]).includes(value)) return { ok: false, rule: null, code: 'hors_liste', field };
    out[field] = value;
  }
  return { ok: true, value: out as Partial<BusinessBuyerProfile> };
}

interface ProfileRow {
  project_id: string;
  version: number;
  activities: string;
  kinds: string;
  postal_codes: string;
  budget_max_eur: number | null;
  experience: BuyerExperience | null;
  declared_contribution_eur: number | null;
  declared_financing: DeclaredFinancing | null;
  sources: string;
  author: string;
  created_at: string;
}

/** Une colonne JSON illisible fait échouer la lecture, jamais lue vide [R17]. */
function parseList<T>(json: string, column: string): T[] {
  let v: unknown;
  try {
    v = JSON.parse(json);
  } catch {
    throw new Error(`profil du repreneur : colonne ${column} illisible`);
  }
  if (!Array.isArray(v)) throw new Error(`profil du repreneur : colonne ${column} illisible`);
  return v as T[];
}

const toVersion = (r: ProfileRow): BuyerProfileVersion => {
  let sources: unknown;
  try {
    sources = JSON.parse(r.sources);
  } catch {
    throw new Error('profil du repreneur : colonne sources illisible');
  }
  if (typeof sources !== 'object' || sources === null || Array.isArray(sources)) throw new Error('profil du repreneur : colonne sources illisible');
  return {
    projectId: r.project_id,
    version: Number(r.version),
    profile: {
      activities: parseList<Activity>(r.activities, 'activities'),
      kinds: parseList<PropertyKind>(r.kinds, 'kinds'),
      postalCodes: parseList<string>(r.postal_codes, 'postal_codes'),
      budgetMaxEur: r.budget_max_eur === null ? null : Number(r.budget_max_eur),
      experience: r.experience,
      declaredContributionEur: r.declared_contribution_eur === null ? null : Number(r.declared_contribution_eur),
      declaredFinancing: r.declared_financing,
    },
    sources: sources as Partial<Record<BuyerField, string>>,
    author: r.author,
    createdAt: r.created_at,
  };
};

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

export interface RepreneursCommerceOptions {
  now?: () => Date;
  newId?: () => string;
}

export class RepreneursCommerce {
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(
    private readonly db: SqlDatabase,
    private readonly journal: JournalStore,
    private readonly fiches: FicheCommerce,
    private readonly estimations: EstimationCommerce,
    private readonly presentations: PresentationCommerce,
    options: RepreneursCommerceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => crypto.randomUUID());
  }

  /** Le profil et toutes ses versions, pour qui voit la personne en entier [R16]. */
  async read(acces: Acces, viewer: Viewer, projectId: string): Promise<BuyerResult<{ current: BuyerProfileVersion | null; history: BuyerProfileVersion[] }>> {
    const g = await this.gate(acces, viewer, projectId, 'read');
    if (!g.ok) return g;
    const rows = await this.db.all<ProfileRow>('SELECT * FROM business_buyer_profiles WHERE project_id = ? ORDER BY version', [projectId]);
    const history = rows.map(toVersion);
    return { ok: true, value: { current: history.at(-1) ?? null, history } };
  }

  /** L'agent du projet ou la direction modifie le profil : une nouvelle version, l'ancienne gardée [R17]. */
  async update(acces: Acces, viewer: Viewer, projectId: string, input: unknown): Promise<BuyerResult<BuyerProfileVersion | null>> {
    const g = await this.gate(acces, viewer, projectId, 'write');
    if (!g.ok) return g;
    const author = `${String(viewer.role)}:${viewer.userId}`;
    const checked = checkBuyerChanges(input);
    if (!checked.ok) {
      // Au journal, le code et le nom d'un champ prévu, jamais une valeur ni un nom de champ inconnu [R13].
      await appendEvent(this.journal, { type: 'commerces.repreneur.refuse', actor: author, subject: `project:${projectId}`, data: { rule: checked.rule, code: checked.code, ...(checked.field && checked.code !== 'champ_inconnu' ? { field: checked.field } : {}) } }, this.now);
      return checked;
    }
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const lastRow = await this.db.first<ProfileRow>('SELECT * FROM business_buyer_profiles WHERE project_id = ? ORDER BY version DESC LIMIT 1', [projectId]);
      const last = lastRow ? toVersion(lastRow) : null;
      const next: BusinessBuyerProfile = last ? { ...last.profile } : { ...EMPTY, activities: [], kinds: [], postalCodes: [] };
      const sources: Partial<Record<BuyerField, string>> = last ? { ...last.sources } : {};
      const changed: BuyerField[] = [];
      for (const field of BUYER_FIELDS) {
        if (!(field in checked.value)) continue;
        const value = checked.value[field];
        if (same(value, next[field])) continue;
        (next as unknown as Record<string, unknown>)[field] = value;
        changed.push(field);
        if (value === null || (Array.isArray(value) && value.length === 0)) delete sources[field];
        else sources[field] = author;
      }
      if (changed.length === 0) return { ok: true, value: last };
      const version = (last?.version ?? 0) + 1;
      const { changes } = await this.db.run(
        `INSERT INTO business_buyer_profiles (id, network_id, project_id, version, activities, kinds, postal_codes, budget_max_eur, experience,
           declared_contribution_eur, declared_financing, sources, author, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
        [
          this.newId(),
          g.networkId,
          projectId,
          version,
          JSON.stringify(next.activities),
          JSON.stringify(next.kinds),
          JSON.stringify(next.postalCodes),
          next.budgetMaxEur,
          next.experience,
          next.declaredContributionEur,
          next.declaredFinancing,
          JSON.stringify(sources),
          author,
          this.now().toISOString(),
        ],
      );
      if (changes !== 1) continue;
      await appendEvent(this.journal, { type: 'commerces.repreneur', actor: author, subject: `project:${projectId}`, data: { version, fields: changed } }, this.now);
      const row = await this.db.first<ProfileRow>('SELECT * FROM business_buyer_profiles WHERE project_id = ? AND version = ?', [projectId, version]);
      return { ok: true, value: row ? toVersion(row) : null };
    }
    throw new Error('profil du repreneur : trop d’écritures simultanées');
  }

  /**
   * Les biens qui répondent au profil, par le code : seulement des présentations publiables, filtrées par chaque
   * critère rempli, triées par une règle écrite. Ni l'apport, ni le financement, ni l'expérience ne sont lus [R14].
   */
  async match(acces: Acces, viewer: Viewer, projectId: string): Promise<BuyerResult<BusinessMatch[]>> {
    const g = await this.gate(acces, viewer, projectId, 'read');
    if (!g.ok) return g;
    const row = await this.db.first<ProfileRow>('SELECT * FROM business_buyer_profiles WHERE project_id = ? ORDER BY version DESC LIMIT 1', [projectId]);
    if (!row) return { ok: true, value: [] };
    const p = toVersion(row).profile;
    const candidates = await this.db.all<{ id: string }>(
      `SELECT id FROM properties WHERE network_id = ? AND kind IN (${BUSINESS_KINDS.map(() => '?').join(', ')}) ORDER BY id`,
      [g.networkId, ...BUSINESS_KINDS],
    );
    const out: BusinessMatch[] = [];
    for (const c of candidates) {
      const shown = await this.presentations.publishable(g.networkId, c.id);
      if (!shown) continue;
      const view = await this.fiches.publicView(c.id);
      const range = await this.estimations.validatedRange(c.id);
      if (!view || !range) continue;
      const low = toEuros(range.lowCents);
      const high = toEuros(range.highCents);
      if (p.activities.length > 0 && (view.activity === null || !p.activities.includes(view.activity))) continue;
      if (p.kinds.length > 0 && !p.kinds.includes(view.kind)) continue;
      if (p.postalCodes.length > 0 && (view.postalCode === null || !p.postalCodes.includes(view.postalCode))) continue;
      if (p.budgetMaxEur !== null && low > p.budgetMaxEur) continue;
      out.push({ propertyId: c.id, publicView: view, title: shown.title, priceLowEuros: low, priceHighEuros: high });
    }
    out.sort((a, b) => a.priceLowEuros - b.priceLowEuros || (a.publicView.city ?? '').localeCompare(b.publicView.city ?? '', 'fr') || a.propertyId.localeCompare(b.propertyId));
    await appendEvent(this.journal, { type: 'commerces.repreneur.rapprochement', actor: `${String(viewer.role)}:${viewer.userId}`, subject: `project:${projectId}`, data: { count: out.length } }, this.now);
    return { ok: true, value: out };
  }

  /** Qui voit la personne du projet en entier lit ; l'agent du projet et la direction écrivent [R16]. */
  private async gate(acces: Acces, viewer: Viewer, projectId: string, need: 'read' | 'write'): Promise<{ ok: true; networkId: string } | Refusal | Problem> {
    const project = await this.db.first<{ id: string; network_id: string; person_id: string; agent_id: string | null; kind: string }>(
      'SELECT id, network_id, person_id, agent_id, kind FROM projects WHERE id = ?',
      [projectId],
    );
    if (!project || project.network_id !== viewer.networkId) {
      await this.refuse(viewer, `network:${viewer.networkId}`, 'unknown');
      return { ok: false, rule: null, code: 'unknown_project' };
    }
    const read = await acces.readFiche(viewer, project.person_id);
    if (!read.ok) return { ok: false, rule: 'R16', code: read.code };
    if (read.view !== 'full') return this.refuse(viewer, `project:${projectId}`, 'not_assigned');
    if (need === 'write' && !((viewer.role === 'agent' && project.agent_id === viewer.userId) || viewer.role === 'direction')) return this.refuse(viewer, `project:${projectId}`, 'role');
    if (project.kind !== 'buy_business') return { ok: false, rule: null, code: 'projet' };
    return { ok: true, networkId: project.network_id };
  }

  private async refuse(viewer: Viewer, subject: string, code: string): Promise<Refusal> {
    await appendEvent(this.journal, { type: 'acces.refuse', actor: `${String(viewer.role)}:${viewer.userId}`, subject, data: { rule: 'R16', role: String(viewer.role), kind: 'business_buyer', code } }, this.now);
    return { ok: false, rule: 'R16', code };
  }
}
