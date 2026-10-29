/**
 * Le profil investisseur (M17, Y01) : le profil d'un projet `invest`, versionné. Une modification ajoute une version,
 * l'ancienne reste lisible et ne change plus [R17]. Seulement des listes fermées et des nombres : budget en centimes,
 * apport déclaré, location visée, secteurs (codes INSEE), rendement brut attendu en points de base, délai.
 *
 * Aucun champ de revenus, d'emploi, de patrimoine, de crédit ni de solvabilité n'existe, et rien ne l'évalue [R123] :
 * un tel champ dans l'entrée est refusé et nommé comme tel, jamais ignoré. Chaque champ rempli porte sa source,
 * `agent:<id>` (l'agent l'écrit), `client_dit:<id de l'agent>` (le client l'a dit, l'agent le note) ou
 * `qualification:<id>` (le message reçu, seulement ce qu'il dit [R10]). Lecture et écriture sous R16, chaque geste au
 * journal sans aucune valeur du profil [R13].
 */
import type { Acces } from '../acces/acces.ts';
import type { Viewer } from '../acces/droits.ts';
import type { SqlDatabase } from '../db/sql.ts';
import type { Project } from '../db/types.ts';
import { plain } from '../envoi/texte.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import { DEADLINES, type Deadline } from '../qualification/regles.ts';

/** La location visée : une liste fermée ; `none` pour un investisseur qui ne veut pas louer. */
export const RENTAL_TARGETS = ['none', 'unfurnished', 'furnished', 'shared'] as const;
export type RentalTarget = (typeof RENTAL_TARGETS)[number];

/** Le profil, et seulement ces champs. */
export interface InvestorProfile {
  budgetCents: number | null;
  /** Tel que la personne l'a déclaré, jamais vérifié ni évalué [R123]. */
  declaredDownPaymentCents: number | null;
  rentalTarget: RentalTarget | null;
  /** Codes INSEE de communes. */
  sectors: string[];
  targetGrossYieldBp: number | null;
  deadline: Deadline | null;
}
export type ProfileField = keyof InvestorProfile;

export const PROFILE_FIELDS: readonly ProfileField[] = [
  'budgetCents',
  'declaredDownPaymentCents',
  'rentalTarget',
  'sectors',
  'targetGrossYieldBp',
  'deadline',
];

/** Les colonnes de la table, toutes : un test les compare à la base [R123]. */
export const PROFILE_COLUMNS: readonly string[] = [
  'id',
  'network_id',
  'project_id',
  'person_id',
  'version',
  'budget_cents',
  'declared_down_payment_cents',
  'rental_target',
  'sectors',
  'target_gross_yield_bp',
  'deadline',
  'sources',
  'origin',
  'created_at',
];

/**
 * Les mots de la solvabilité, liste fermée : un champ qui en porte un est refusé avec R123, nommé comme tel. Rien de
 * cela ne s'écrit dans un profil, ni sous un autre nom.
 */
export const SOLVENCY_TERMS: readonly string[] = Object.freeze([
  'revenu',
  'revenus',
  'income',
  'salaire',
  'salary',
  'wage',
  'paie',
  'emploi',
  'employment',
  'employer',
  'employeur',
  'job',
  'profession',
  'metier',
  'contrat de travail',
  'cdi',
  'cdd',
  'patrimoine',
  'wealth',
  'net worth',
  'assets',
  'epargne',
  'savings',
  'credit',
  'loan',
  'pret',
  'emprunt',
  'mortgage',
  'dette',
  'debt',
  'endettement',
  'mensualite',
  'solvabilite',
  'solvency',
  'solvable',
  'score',
  'scoring',
  'capacite d emprunt',
  'borrowing capacity',
  'banque',
  'bank',
  'fiche de paie',
  'avis d imposition',
  'impot sur le revenu',
  'tax return',
]);

const termKey = (value: string): string => plain(value).replace(/[^a-z0-9]+/g, ' ').trim();
const SOLVENCY_KEYS = SOLVENCY_TERMS.map(termKey);

/** Le nom ou le mot porte un terme de la solvabilité (camelCase et snake_case compris). */
export function isSolvencyTerm(value: string): boolean {
  const p = ` ${termKey(value.replace(/([a-z])([A-Z])/g, '$1 $2'))} `;
  return SOLVENCY_KEYS.some((t) => p.includes(` ${t} `));
}

const INSEE = /^(?:\d{5}|2[AB]\d{3})$/;

export type ProfileRefusal = {
  ok: false;
  rule: 'R123' | 'R16' | 'R10';
  /** `solvabilite`, `champ_inconnu`, `hors_liste`, `valeur`, `source`, ou un code d'accès. */
  code: string;
  /** Le champ en cause, seulement quand il fait partie des champs prévus. */
  field?: ProfileField;
};
export type ProfileCheck = { ok: true; value: Partial<InvestorProfile> } | ProfileRefusal;

const INT_LIMITS: Partial<Record<ProfileField, [number, number]>> = {
  budgetCents: [100, 100_000_000_000],
  declaredDownPaymentCents: [0, 100_000_000_000],
  targetGrossYieldBp: [1, 10_000],
};

const refuse = (code: string, field?: ProfileField, rule: ProfileRefusal['rule'] = 'R123'): ProfileRefusal =>
  field === undefined ? { ok: false, rule, code } : { ok: false, rule, code, field };

/**
 * Contrôle d'une modification du profil : seulement des champs prévus, des valeurs prises dans leur liste fermée et
 * des entiers bornés. `null` retire un champ ; une liste vide aussi. Un champ inconnu est refusé, jamais ignoré.
 */
export function checkProfileChanges(input: unknown): ProfileCheck {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return refuse('valeur');
  const entries = Object.entries(input as Record<string, unknown>);
  if (entries.length === 0) return refuse('valeur');
  // La solvabilité est nommée comme telle, où qu'elle soit, avant toute autre erreur.
  for (const [key] of entries) if (isSolvencyTerm(key)) return refuse('solvabilite');
  const out: Partial<Record<ProfileField, unknown>> = {};
  for (const [key, value] of entries) {
    if (!(PROFILE_FIELDS as readonly string[]).includes(key)) return refuse('champ_inconnu');
    const field = key as ProfileField;
    if (field === 'sectors') {
      if (value === null) {
        out.sectors = [];
        continue;
      }
      if (!Array.isArray(value) || value.length > 50) return refuse('valeur', field);
      const kept: string[] = [];
      for (const v of value) {
        if (typeof v !== 'string' || !INSEE.test(v)) return refuse('hors_liste', field);
        if (!kept.includes(v)) kept.push(v);
      }
      out.sectors = kept;
      continue;
    }
    if (value === null) {
      out[field] = null;
      continue;
    }
    const limits = INT_LIMITS[field];
    if (limits) {
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < limits[0] || value > limits[1]) return refuse('valeur', field);
      out[field] = value;
      continue;
    }
    const allowed: readonly string[] = field === 'rentalTarget' ? RENTAL_TARGETS : DEADLINES;
    if (typeof value !== 'string' || !allowed.includes(value)) return refuse('hors_liste', field);
    out[field] = value;
  }
  return { ok: true, value: out as Partial<InvestorProfile> };
}

export interface InvestorProfileRow {
  id: string;
  network_id: string;
  project_id: string;
  person_id: string;
  version: number;
  budget_cents: number | null;
  declared_down_payment_cents: number | null;
  rental_target: RentalTarget | null;
  sectors: string;
  target_gross_yield_bp: number | null;
  deadline: Deadline | null;
  sources: string;
  origin: string;
  created_at: string;
}

/** Une version du profil, avec la source de chaque champ rempli. */
export interface InvestorProfileVersion {
  id: string;
  projectId: string;
  personId: string;
  version: number;
  profile: InvestorProfile;
  /** Champ → `agent:<id>`, `client_dit:<id>`, `direction:<id>` ou `qualification:<id>`. */
  sources: Partial<Record<ProfileField, string>>;
  origin: string;
  createdAt: string;
}

export const EMPTY_PROFILE: Readonly<InvestorProfile> = Object.freeze({
  budgetCents: null,
  declaredDownPaymentCents: null,
  rentalTarget: null,
  sectors: [],
  targetGrossYieldBp: null,
  deadline: null,
});

function parseSectors(json: string): string[] {
  try {
    const value: unknown = JSON.parse(json);
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

export function toProfileVersion(row: InvestorProfileRow): InvestorProfileVersion {
  let sources: Partial<Record<ProfileField, string>> = {};
  try {
    const parsed: unknown = JSON.parse(row.sources);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) sources = parsed as Partial<Record<ProfileField, string>>;
  } catch {
    sources = {};
  }
  return {
    id: row.id,
    projectId: row.project_id,
    personId: row.person_id,
    version: row.version,
    profile: {
      budgetCents: row.budget_cents,
      declaredDownPaymentCents: row.declared_down_payment_cents,
      rentalTarget: row.rental_target,
      sectors: parseSectors(row.sectors),
      targetGrossYieldBp: row.target_gross_yield_bp,
      deadline: row.deadline,
    },
    sources,
    origin: row.origin,
    createdAt: row.created_at,
  };
}

/** Qui a donné ce que l'agent écrit : lui-même, ou le client qui l'a dit. */
export const PROFILE_SOURCES = ['agent', 'client_dit'] as const;
export type ProfileSource = (typeof PROFILE_SOURCES)[number];

export type ProfileResult = { ok: true; created: boolean; value: InvestorProfileVersion | null } | ProfileRefusal;

export interface ProfilInvestisseurOptions {
  now?: () => Date;
  newId?: () => string;
}

interface QualificationRow {
  id: string;
  network_id: string;
  project_id: string | null;
  budget_max_eur: number | null;
  deadline: Deadline | null;
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

export class ProfilInvestisseur {
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(
    private readonly db: SqlDatabase,
    private readonly journal: JournalStore,
    options: ProfilInvestisseurOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => crypto.randomUUID());
  }

  /** La dernière version, sans contrôle d'accès : pour le code du système (calcul, alertes). */
  async current(projectId: string): Promise<InvestorProfileVersion | null> {
    const row = await this.db.first<InvestorProfileRow>('SELECT * FROM investor_profiles WHERE project_id = ? ORDER BY version DESC LIMIT 1', [projectId]);
    return row ? toProfileVersion(row) : null;
  }

  /** Le profil et toutes ses versions, pour qui voit la fiche en entier [R16]. */
  async read(
    acces: Acces,
    viewer: Viewer,
    projectId: string,
  ): Promise<{ ok: true; value: { current: InvestorProfileVersion | null; history: InvestorProfileVersion[] } } | ProfileRefusal> {
    const project = await this.investProject(viewer, projectId);
    if (!project) return this.refused(viewer, projectId, 'unknown');
    const read = await acces.readFiche(viewer, project.person_id);
    if (!read.ok) return refuse(read.code, undefined, 'R16');
    if (read.view !== 'full') return this.refused(viewer, projectId, 'not_assigned');
    const rows = await this.db.all<InvestorProfileRow>('SELECT * FROM investor_profiles WHERE project_id = ? ORDER BY version', [projectId]);
    const history = rows.map(toProfileVersion);
    return { ok: true, value: { current: history.at(-1) ?? null, history } };
  }

  /**
   * L'agent de la fiche ou la direction modifie le profil : une nouvelle version, l'ancienne gardée [R17]. `from` dit
   * d'où vient ce qui est écrit : l'agent lui-même, ou le client qui l'a dit. Un champ inconnu, hors liste ou de
   * solvabilité est refusé, et le refus va au journal sans la valeur [R13, R123].
   */
  async update(acces: Acces, viewer: Viewer, projectId: string, input: unknown, from: unknown = 'agent'): Promise<ProfileResult> {
    const project = await this.investProject(viewer, projectId);
    if (!project) return this.refused(viewer, projectId, 'unknown');
    if (viewer.role !== 'agent' && viewer.role !== 'direction') {
      // La conformité lit, elle n'écrit pas le profil d'un client ; la lecture refusée ou permise va au journal.
      await acces.readFiche(viewer, project.person_id);
      return this.refused(viewer, projectId, 'role');
    }
    const read = await acces.readFiche(viewer, project.person_id);
    if (!read.ok) return refuse(read.code, undefined, 'R16');
    if (read.view !== 'full') return this.refused(viewer, projectId, 'not_assigned');

    const author = `${viewer.role}:${viewer.userId}`;
    const checked: ProfileCheck = !(PROFILE_SOURCES as readonly unknown[]).includes(from)
      ? refuse('source', undefined, 'R10')
      : checkProfileChanges(input);
    if (!checked.ok) {
      await appendEvent(
        this.journal,
        {
          type: 'investir.profil.refuse',
          actor: author,
          subject: `person:${project.person_id}`,
          data: { rule: checked.rule, code: checked.code, project: projectId, ...(checked.field ? { field: checked.field } : {}) },
        },
        this.now,
      );
      return checked;
    }
    const source = from === 'client_dit' ? `client_dit:${viewer.userId}` : author;
    return this.addVersion(project, author, author, () => checked.value, source);
  }

  /**
   * Le profil complété depuis une qualification d'investisseur (Q01) : seulement ce que le message dit, budget et
   * délai [R10], une seule fois par qualification. Un champ écrit par l'agent n'est pas changé par un message.
   */
  async fromQualification(qualificationId: string): Promise<InvestorProfileVersion | null> {
    const q = await this.db.first<QualificationRow>('SELECT id, network_id, project_id, budget_max_eur, deadline FROM qualifications WHERE id = ?', [
      qualificationId,
    ]);
    if (!q || q.project_id === null) return null;
    const project = await this.db.first<Project>("SELECT * FROM projects WHERE id = ? AND network_id = ? AND kind = 'invest'", [q.project_id, q.network_id]);
    if (!project) return null;
    const origin = `qualification:${q.id}`;
    const done = await this.db.first<InvestorProfileRow>('SELECT * FROM investor_profiles WHERE project_id = ? AND origin = ?', [project.id, origin]);
    if (done) return toProfileVersion(done);
    const said: Partial<InvestorProfile> = {};
    if (q.budget_max_eur !== null && Number.isSafeInteger(q.budget_max_eur) && q.budget_max_eur >= 1 && q.budget_max_eur <= 1_000_000_000) {
      said.budgetCents = q.budget_max_eur * 100;
    }
    if (q.deadline !== null && (DEADLINES as readonly string[]).includes(q.deadline)) said.deadline = q.deadline;
    const result = await this.addVersion(
      project,
      'system:qualification',
      origin,
      (_previous, sources) => {
        const changes: Partial<Record<ProfileField, unknown>> = {};
        for (const field of PROFILE_FIELDS) {
          if (said[field] === undefined) continue;
          // La parole de l'agent, ou du client qu'il a notée, l'emporte sur un message.
          const was = sources[field];
          if (was !== undefined && !was.startsWith('qualification:')) continue;
          changes[field] = said[field];
        }
        return changes as Partial<InvestorProfile>;
      },
      origin,
    );
    if (!result.ok) return null;
    return result.value ?? this.current(project.id);
  }

  /**
   * Ajoute une version si quelque chose change ; deux écritures simultanées ne prennent jamais le même numéro, la
   * seconde se recalcule sur la première.
   */
  private async addVersion(
    project: Project,
    actor: string,
    origin: string,
    changesOf: (previous: InvestorProfile, sources: Partial<Record<ProfileField, string>>) => Partial<InvestorProfile>,
    source: string,
  ): Promise<ProfileResult> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const last = await this.current(project.id);
      const previous: InvestorProfile = last ? last.profile : { ...EMPTY_PROFILE, sectors: [] };
      const sources: Partial<Record<ProfileField, string>> = last ? { ...last.sources } : {};
      const changes = changesOf(previous, sources);
      const next: InvestorProfile = { ...previous };
      const changed: ProfileField[] = [];
      for (const field of PROFILE_FIELDS) {
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
        `INSERT INTO investor_profiles (id, network_id, project_id, person_id, version, budget_cents, declared_down_payment_cents,
           rental_target, sectors, target_gross_yield_bp, deadline, sources, origin, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
        [
          id,
          project.network_id,
          project.id,
          project.person_id,
          version,
          next.budgetCents,
          next.declaredDownPaymentCents,
          next.rentalTarget,
          JSON.stringify(next.sectors),
          next.targetGrossYieldBp,
          next.deadline,
          JSON.stringify(sources),
          origin,
          this.now().toISOString(),
        ],
      );
      if (inserted !== 1) {
        if (origin.startsWith('qualification:')) {
          const done = await this.db.first<InvestorProfileRow>('SELECT * FROM investor_profiles WHERE project_id = ? AND origin = ?', [project.id, origin]);
          if (done) return { ok: true, created: false, value: toProfileVersion(done) };
        }
        continue;
      }
      await appendEvent(
        this.journal,
        { type: 'investir.profil', actor, subject: `person:${project.person_id}`, data: { project: project.id, version, fields: changed } },
        this.now,
      );
      const row = await this.db.first<InvestorProfileRow>('SELECT * FROM investor_profiles WHERE id = ?', [id]);
      return { ok: true, created: true, value: row ? toProfileVersion(row) : null };
    }
    throw new Error('profil investisseur : trop d’écritures simultanées');
  }

  private async investProject(viewer: Viewer, projectId: string): Promise<Project | null> {
    return this.db.first<Project>("SELECT * FROM projects WHERE id = ? AND network_id = ? AND kind = 'invest'", [projectId, viewer.networkId]);
  }

  private async refused(viewer: Viewer, projectId: string, code: string): Promise<ProfileRefusal> {
    await appendEvent(
      this.journal,
      {
        type: 'acces.refuse',
        actor: `${String(viewer.role)}:${viewer.userId}`,
        subject: `project:${projectId}`,
        data: { rule: 'R16', role: String(viewer.role), kind: 'investor_profile', code },
      },
      this.now,
    );
    return refuse(code, undefined, 'R16');
  }
}
