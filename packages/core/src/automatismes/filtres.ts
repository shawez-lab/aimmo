/**
 * Filtres avancés des fiches : budget, secteur et sorte de projet (HX25).
 *
 * Un filtre ne cherche que dans les fiches que la personne qui filtre a le droit de voir : la liste passe d'abord par
 * les droits d'accès, fiche réunie comprise, et la lecture va au journal [R16, R407]. Un filtre est en liste fermée ;
 * chaque critère doit tenir sur le même projet. Le journal ne garde que les noms des critères, jamais leurs valeurs [R13].
 */
import { Acces, type AccessResult } from '../acces/acces.ts';
import type { Viewer } from '../acces/droits.ts';
import { FicheClient } from '../db/fiche-client.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { PROJECT_KINDS, type ProjectKind } from '../db/types.ts';
import { plain } from '../envoi/texte.ts';
import { FicheUnique } from '../fiche/fusion.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import { CLOSED_PROJECT_STAGES } from './prochaine-action.ts';

export interface FicheFilter {
  /** Budget cherché, en euros : un projet dont la fourchette touche celle-ci. */
  budgetMin: number | null;
  budgetMax: number | null;
  /** Villes, codes postaux ou débuts de code postal (département). */
  sectors: string[];
  kinds: ProjectKind[];
  /** Seulement les projets ouverts (par défaut). */
  openOnly: boolean;
}

export type FilterResult<T> = AccessResult<T> | { ok: false; rule: 'R407'; code: string };

export interface FilteredFiche {
  personId: string;
  /** Les projets de la fiche qui tiennent tous les critères. */
  projectIds: string[];
}

const MAX_SECTORS = 20;
const isBudget = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 1_000_000_000;
const norm = (s: string): string => plain(s).replace(/[^a-z0-9]+/g, ' ').trim();

/** Lit un filtre reçu, champ par champ, en liste fermée [R407]. */
export function parseFilter(input: unknown): { ok: true; value: FicheFilter } | { ok: false; rule: 'R407'; code: string } {
  const bad = (code: string) => ({ ok: false as const, rule: 'R407' as const, code });
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return bad('bad_filter');
  const i = input as Record<string, unknown>;
  const allowed = new Set(['budgetMin', 'budgetMax', 'sectors', 'kinds', 'openOnly']);
  if (Object.keys(i).some((k) => !allowed.has(k))) return bad('unknown_field');
  const budgetMin = i['budgetMin'] ?? null;
  const budgetMax = i['budgetMax'] ?? null;
  if (budgetMin !== null && !isBudget(budgetMin)) return bad('bad_budget');
  if (budgetMax !== null && !isBudget(budgetMax)) return bad('bad_budget');
  if (budgetMin !== null && budgetMax !== null && budgetMin > budgetMax) return bad('bad_budget');
  const sectors = i['sectors'] ?? [];
  if (!Array.isArray(sectors) || sectors.length > MAX_SECTORS || sectors.some((s) => typeof s !== 'string' || norm(s) === '' || s.length > 80)) return bad('bad_sector');
  const kinds = i['kinds'] ?? [];
  if (!Array.isArray(kinds) || kinds.some((k) => typeof k !== 'string' || !(PROJECT_KINDS as readonly string[]).includes(k))) return bad('bad_kind');
  const openOnly = i['openOnly'] ?? true;
  if (typeof openOnly !== 'boolean') return bad('bad_open_only');
  return { ok: true, value: { budgetMin: budgetMin as number | null, budgetMax: budgetMax as number | null, sectors: (sectors as string[]).map(norm), kinds: [...new Set(kinds as ProjectKind[])], openOnly } };
}

interface ProjectFacts {
  id: string;
  kind: ProjectKind;
  stage: string;
  min: number | null;
  max: number | null;
  places: { city: string | null; postalCode: string | null }[];
}

/** La ville et le code postal d'un projet, lus dans ses critères, sans jamais échouer sur un critère mal formé. */
function placeOf(criteria: string | null): { city: string | null; postalCode: string | null } {
  if (!criteria) return { city: null, postalCode: null };
  try {
    const c = JSON.parse(criteria) as Record<string, unknown>;
    const city = typeof c['city'] === 'string' && c['city'].trim() !== '' ? norm(c['city']) : null;
    const postalCode = typeof c['postalCode'] === 'string' && /^\d{5}$/.test(c['postalCode'].trim()) ? c['postalCode'].trim() : null;
    return { city, postalCode };
  } catch {
    return { city: null, postalCode: null };
  }
}

/** Le projet tient-il tous les critères du filtre ? */
export function matches(filter: FicheFilter, p: ProjectFacts): boolean {
  if (filter.openOnly && CLOSED_PROJECT_STAGES.includes(p.stage)) return false;
  if (filter.kinds.length > 0 && !filter.kinds.includes(p.kind)) return false;
  if (filter.budgetMin !== null || filter.budgetMax !== null) {
    // Un projet sans aucun budget ne tient pas un filtre de budget : on ne devine pas.
    if (p.min === null && p.max === null) return false;
    const lo = p.min ?? 0;
    const hi = p.max ?? Number.POSITIVE_INFINITY;
    if (filter.budgetMin !== null && hi < filter.budgetMin) return false;
    if (filter.budgetMax !== null && lo > filter.budgetMax) return false;
  }
  if (filter.sectors.length > 0) {
    const hit = filter.sectors.some((s) =>
      /^\d{2,5}$/.test(s) ? p.places.some((pl) => pl.postalCode !== null && pl.postalCode.startsWith(s)) : p.places.some((pl) => pl.city === s),
    );
    if (!hit) return false;
  }
  return true;
}

export interface FiltresOptions {
  now?: () => Date;
}

export class FiltresFiches {
  private readonly now: () => Date;
  private readonly acces: Acces;
  private readonly unique: FicheUnique;

  constructor(
    private readonly db: SqlDatabase,
    private readonly journal: JournalStore,
    options: FiltresOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    const store = new FicheClient(db, { now: this.now });
    this.unique = new FicheUnique(db, store, { now: this.now });
    this.acces = new Acces(db, store, this.unique, journal, { now: this.now });
  }

  /** Les fiches visibles qui tiennent le filtre, et leurs projets qui le tiennent [R16, R407]. */
  async filter(viewer: Viewer, input: unknown): Promise<FilterResult<FilteredFiche[]>> {
    const parsed = parseFilter(input);
    if (!parsed.ok) return parsed;
    const f = parsed.value;
    // D'abord les droits : jamais une fiche hors de ce que la personne qui filtre peut voir [R16].
    const visible = await this.acces.listPersons(viewer, 'filtre');
    if (!visible.ok) return visible;
    const out: FilteredFiche[] = [];
    const seen = new Set<string>();
    for (const person of visible.value) {
      const root = await this.unique.rootOf(person.id);
      if (seen.has(root)) continue;
      seen.add(root);
      // La fiche gardée n'est montrée que si elle est elle-même dans la liste visible.
      if (!visible.value.some((p) => p.id === root)) continue;
      const members = await this.unique.membersOf(root);
      const marks = members.map(() => '?').join(', ');
      const projects = await this.db.all<{ id: string; kind: ProjectKind; stage: string; budget_min_eur: number | null; budget_max_eur: number | null; criteria: string | null }>(
        `SELECT id, kind, stage, budget_min_eur, budget_max_eur, criteria FROM projects WHERE network_id = ? AND person_id IN (${marks}) ORDER BY created_at, id`,
        [viewer.networkId, ...members],
      );
      const quals = await this.db.all<{ project_id: string | null; city: string | null; budget_min_eur: number | null; budget_max_eur: number | null }>(
        `SELECT project_id, city, budget_min_eur, budget_max_eur FROM qualifications WHERE network_id = ? AND person_id IN (${marks}) AND project_id IS NOT NULL ORDER BY created_at, id`,
        [viewer.networkId, ...members],
      );
      const hits: string[] = [];
      for (const p of projects) {
        const q = quals.filter((x) => x.project_id === p.id);
        const lastQ = q[q.length - 1];
        const facts: ProjectFacts = {
          id: p.id,
          kind: p.kind,
          stage: p.stage,
          // Le budget du projet, sinon celui de sa dernière qualification.
          min: p.budget_min_eur ?? (p.budget_max_eur === null ? (lastQ?.budget_min_eur ?? null) : null),
          max: p.budget_max_eur ?? (p.budget_min_eur === null ? (lastQ?.budget_max_eur ?? null) : null),
          places: [placeOf(p.criteria), ...q.map((x) => ({ city: x.city && x.city.trim() !== '' ? norm(x.city) : null, postalCode: null }))],
        };
        if (matches(f, facts)) hits.push(p.id);
      }
      if (hits.length > 0) out.push({ personId: root, projectIds: hits });
    }
    await appendEvent(
      this.journal,
      {
        type: 'fiches.filtrees',
        actor: `${String(viewer.role)}:${viewer.userId}`,
        subject: null,
        data: { rule: 'R407', criteria: Object.entries(input as Record<string, unknown>).filter(([, v]) => v !== null && !(Array.isArray(v) && v.length === 0)).map(([k]) => k).sort(), count: out.length },
      },
      this.now,
    );
    return { ok: true, view: 'full', value: out };
  }
}
