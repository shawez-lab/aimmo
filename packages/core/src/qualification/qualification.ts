/**
 * La qualification d'un message rattaché à sa fiche (M03, Q01) : catégorie et champs extraits, rangés une seule fois
 * par message [R18], puis le projet de la fiche ouvert ou complété, jamais écrasé.
 *
 * L'IA, si elle est branchée, ne reçoit que le texte reçu sans ses coordonnées [R15] ; sa sortie passe par
 * `checkAiQualification` et, refusée, laisse la place aux règles fixes, avec une ligne au journal sans texte [R13].
 */
import type { Acces } from '../acces/acces.ts';
import type { Viewer } from '../acces/droits.ts';
import type { ReconnaissanceBien } from '../biens/reconnaissance.ts';
import { withoutContactDetails } from '../captation/premiere-reponse.ts';
import type { FicheClient } from '../db/fiche-client.ts';
import type { SqlDatabase } from '../db/sql.ts';
import type { FicheUnique } from '../fiche/fusion.ts';
import { GeographieReseau } from '../geographie/communes.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import type { Reception } from '../reception/reception.ts';
import {
  CATEGORIES,
  ROUTES,
  checkAiQualification,
  projectKindOf,
  isCriterion,
  qualifyByRules,
  withoutNames,
  type Category,
  type Criterion,
  type Qualified,
  type Route,
} from './regles.ts';
import type { MeasureCase } from './mesure.ts';
import { scoreContact, type Temperature } from './note.ts';

/** Ce que l'IA reçoit : le strict nécessaire, aucune coordonnée [R15]. */
export interface QualifyBrief {
  text: string;
  channel: string;
  /** Le message cite un bien reconnu. */
  propertyRecognized: boolean;
  /** Les communes admises : la sortie n'en cite pas d'autre. */
  communes: readonly string[];
}

/** L'IA qui classe et extrait. Absente, en panne ou hors des règles : les règles fixes. */
export interface Qualifier {
  qualify(brief: QualifyBrief): Promise<unknown>;
}

export interface QualificationRow {
  id: string;
  network_id: string;
  inbound_id: string;
  person_id: string;
  project_id: string | null;
  category: Category;
  route: Route | null;
  city: string | null;
  budget_min_eur: number | null;
  budget_max_eur: number | null;
  price_eur: number | null;
  deadline: Qualified['deadline'];
  financing: Qualified['financing'];
  criteria: string;
  property_id: string | null;
  source: 'ai' | 'rules';
  created_at: string;
}

export interface QualificationOptions {
  qualifier?: Qualifier;
  communes?: readonly string[];
  /** Au-delà, l'IA est réputée ne pas répondre. */
  aiTimeoutMs?: number;
  now?: () => Date;
  newId?: () => string;
}

/** Le nombre de cas corrigés d'un fichier de mesure : les plus récents. */
export const MEASURE_CASES_MAX = 150;

const placeholders = (n: number): string => Array.from({ length: n }, () => '?').join(', ');

function timeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('délai dépassé')), ms);
  });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

/** Les critères du projet, complétés : rien de ce qui y est déjà n'est retiré ni remplacé. */
function mergeCriteria(current: string | null, add: { criteria: readonly string[]; city: string | null }): string {
  let known: { criteria?: unknown; city?: unknown } = {};
  try {
    const parsed: unknown = current ? JSON.parse(current) : {};
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) known = parsed as typeof known;
  } catch {
    known = {};
  }
  const before = Array.isArray(known.criteria) ? (known.criteria as unknown[]).filter((c): c is string => typeof c === 'string') : [];
  const merged = { ...known, criteria: [...new Set([...before, ...add.criteria])], city: typeof known.city === 'string' ? known.city : add.city };
  const next = JSON.stringify(merged);
  return current !== null && next === current ? current : next;
}

export interface ContactScoreRow {
  qualification_id: string;
  network_id: string;
  person_id: string;
  score: number;
  temperature: Temperature;
  reason: string;
  created_at: string;
}

function parseCriteria(json: string): Criterion[] {
  try {
    const value: unknown = JSON.parse(json);
    return Array.isArray(value) ? value.filter(isCriterion) : [];
  } catch {
    return [];
  }
}

export class Qualification {
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly geographie: GeographieReseau;

  constructor(
    private readonly db: SqlDatabase,
    private readonly store: FicheClient,
    private readonly fiche: FicheUnique,
    private readonly reception: Reception,
    private readonly biens: ReconnaissanceBien,
    private readonly journal: JournalStore,
    private readonly options: QualificationOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => crypto.randomUUID());
    this.geographie = new GeographieReseau(db, journal, { now: this.now });
  }

  get(inboundId: string): Promise<QualificationRow | null> {
    return this.db.first<QualificationRow>('SELECT * FROM qualifications WHERE inbound_id = ?', [inboundId]);
  }

  /** Qualifie le message reçu, une fois rattaché à sa fiche ; une seule qualification par message [R18]. */
  async qualify(inboundId: string): Promise<QualificationRow | null> {
    const row = await this.reception.get(inboundId);
    if (!row || row.kind === 'unreadable' || row.person_id === null) return null;
    const existing = await this.get(inboundId);
    if (existing) {
      // Une note interrompue (Worker coupé) est reprise : chaque qualification a la sienne.
      await this.scoreOf(existing);
      return existing;
    }

    const recognition = await this.biens.recognize(row.network_id, {
      postRef: row.post_ref,
      propertyRef: row.property_ref,
      portal: row.portal,
      subject: row.subject,
      text: row.body,
    });
    const propertyId = recognition.status === 'recognized' ? recognition.property.id : null;
    const text = [row.subject, row.body].filter((t): t is string => !!t).join('\n');
    // Les communes du réseau, lues dans son paramétrage géographique, jamais dans le code [R679].
    const communes = this.options.communes ?? (await this.geographie.names(row.network_id));
    const rules = qualifyByRules(text, { propertyRecognized: propertyId !== null, communes });

    let q: Qualified = rules;
    let source: 'ai' | 'rules' = 'rules';
    if (this.options.qualifier) {
      const brief: QualifyBrief = {
        // Ni coordonnée, ni nom : l'IA n'en a pas besoin pour classer [R15].
        text: withoutNames(withoutContactDetails(text), await this.namesOf(row.person_id, row.sender_name), communes),
        channel: row.channel,
        propertyRecognized: propertyId !== null,
        communes,
      };
      let raw: unknown;
      let failed = false;
      try {
        raw = await timeout(this.options.qualifier.qualify(brief), this.options.aiTimeoutMs ?? 20_000);
      } catch {
        failed = true;
      }
      const checked = failed ? null : checkAiQualification(raw, text, communes);
      if (checked !== null && 'category' in checked) {
        q = checked;
        source = 'ai';
      } else {
        await appendEvent(
          this.journal,
          {
            type: 'qualification.ia_refusee',
            actor: 'system:qualification',
            subject: `inbound:${inboundId}`,
            data: failed ? { rule: 'R12', reason: 'L’IA n’a pas répondu : règles fixes.' } : { rule: checked!.rule, reason: checked!.reason },
          },
          this.now,
        );
      }
    }

    const view = await this.fiche.view(row.person_id);
    const root = view.person;
    const at = this.now().toISOString();
    const id = this.newId();
    // Une seule qualification par message, même traitée deux fois en même temps [R18].
    const { changes } = await this.db.run(
      `INSERT INTO qualifications (id, network_id, inbound_id, person_id, project_id, category, route, city, budget_min_eur,
         budget_max_eur, price_eur, deadline, financing, criteria, property_id, source, created_at)
       VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (inbound_id) DO NOTHING`,
      [
        id,
        row.network_id,
        inboundId,
        root.id,
        q.category,
        q.route,
        q.city,
        q.budgetMinEur,
        q.budgetMaxEur,
        q.priceEur,
        q.deadline,
        q.financing,
        JSON.stringify(q.criteria),
        propertyId,
        source,
        at,
      ],
    );
    if (changes !== 1) {
      const other = await this.get(inboundId);
      if (other) await this.scoreOf(other);
      return other;
    }

    const projectId = await this.project(root.id, root.network_id, root.agent_id, view.members.map((m) => m.id), q, text, propertyId);
    if (projectId) await this.db.run('UPDATE qualifications SET project_id = ? WHERE id = ?', [projectId, id]);
    await appendEvent(
      this.journal,
      {
        type: 'qualification.rangee',
        actor: 'system:qualification',
        subject: `person:${root.id}`,
        data: { category: q.category, route: q.route, source, project: projectId !== null },
      },
      this.now,
    );
    const stored = await this.get(inboundId);
    if (stored) await this.scoreOf(stored);
    return stored;
  }

  /** La note de la qualification, par barème fixe, rangée une seule fois [R24] ; aucune pour un candidat à une location [R14]. */
  async scoreOf(row: QualificationRow): Promise<ContactScoreRow | null> {
    const score = scoreContact({
      category: row.category,
      route: row.route,
      deadline: row.deadline,
      city: row.city,
      criteria: parseCriteria(row.criteria),
      propertyRecognized: row.property_id !== null,
    });
    if (score === null) return null;
    await this.db.run(
      `INSERT INTO contact_scores (qualification_id, network_id, person_id, score, temperature, reason, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (qualification_id) DO NOTHING`,
      [row.id, row.network_id, row.person_id, score.score, score.temperature, score.reason, this.now().toISOString()],
    );
    const stored = await this.db.first<ContactScoreRow>('SELECT * FROM contact_scores WHERE qualification_id = ?', [row.id]);
    if (!stored) throw new Error('Note introuvable après son rangement.');
    return stored;
  }

  /** Les noms connus de la personne, fiches réunies comprises, et celui que le canal donne. */
  private async namesOf(personId: string, senderName: string | null): Promise<string[]> {
    const members = await this.fiche.membersOf(personId);
    const rows = await this.db.all<{ first_name: string | null; last_name: string | null }>(`SELECT first_name, last_name FROM person_known_names WHERE id IN (${placeholders(members.length)})`, members);
    return [...new Set([...rows.flatMap((m) => [m.first_name, m.last_name]), senderName].filter((n): n is string => !!n))];
  }

  /** Ouvre le projet de ce type, ou complète celui de la fiche : un champ déjà rempli n'est jamais remplacé. */
  private async project(
    personId: string,
    networkId: string,
    agentId: string | null,
    members: readonly string[],
    q: Qualified,
    text: string,
    propertyId: string | null,
  ): Promise<string | null> {
    const kind = projectKindOf(q, text);
    if (kind === null) return null;
    const criteria = q.criteria.length > 0 || q.city ? { criteria: q.criteria, city: q.city } : null;
    const budgetMin = q.priceEur === null ? q.budgetMinEur : null;
    const budgetMax = q.priceEur ?? q.budgetMaxEur;
    // Ouvert en une seule instruction s'il n'existe pas encore : deux messages qualifiés en même temps n'ouvrent
    // pas deux projets du même type pour la même personne.
    const at = this.now().toISOString();
    await this.db.run(
      `INSERT INTO projects (id, network_id, agent_id, person_id, kind, stage, deadline, budget_min_eur, budget_max_eur, criteria, note, created_at, updated_at)
       SELECT ?, ?, ?, ?, ?, 'new', NULL, NULL, NULL, NULL, NULL, ?, ?
       WHERE NOT EXISTS (SELECT 1 FROM projects WHERE person_id IN (${placeholders(members.length)}) AND kind = ?)`,
      [this.newId(), networkId, agentId, personId, kind, at, at, ...members, kind],
    );
    const found = await this.db.first<{ id: string; criteria: string | null }>(
      `SELECT id, criteria FROM projects WHERE person_id IN (${placeholders(members.length)}) AND kind = ? ORDER BY created_at, rowid LIMIT 1`,
      [...members, kind],
    );
    if (!found) throw new Error('Projet introuvable après son ouverture.');
    const projectId = found.id;
    // Un champ déjà rempli n'est jamais remplacé ; les critères nouveaux s'ajoutent.
    await this.db.run('UPDATE projects SET budget_min_eur = ?, updated_at = ? WHERE id = ? AND budget_min_eur IS NULL AND ? IS NOT NULL', [budgetMin, at, projectId, budgetMin]);
    await this.db.run('UPDATE projects SET budget_max_eur = ?, updated_at = ? WHERE id = ? AND budget_max_eur IS NULL AND ? IS NOT NULL', [budgetMax, at, projectId, budgetMax]);
    // Les critères se complètent par comparaison et échange : deux messages traités en même temps n'effacent pas
    // les critères l'un de l'autre.
    if (criteria) {
      let current = found.criteria;
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const next = mergeCriteria(current, criteria);
        if (next === current) break;
        const { changes } = await this.db.run('UPDATE projects SET criteria = ?, updated_at = ? WHERE id = ? AND criteria IS ?', [next, at, projectId, current]);
        if (changes === 1) break;
        current = (await this.db.first<{ criteria: string | null }>('SELECT criteria FROM projects WHERE id = ?', [projectId]))?.criteria ?? null;
      }
    }
    if (propertyId) {
      const role = kind === 'sell' || kind === 'valuation' ? null : 'interested';
      // Le lien au bien, une seule fois, même pour deux messages traités en même temps.
      if (role) {
        await this.db.run(
          `INSERT INTO project_properties (project_id, property_id, network_id, agent_id, role, created_at) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (project_id, property_id, role) DO NOTHING`,
          [projectId, propertyId, networkId, agentId, role, this.now().toISOString()],
        );
      }
    }
    return projectId;
  }

  /**
   * La correction de l'agent : gardée telle quelle, elle devient un cas de test (Q05). Seul celui qui voit la fiche
   * en entier peut corriger [R16].
   */
  async correct(acces: Acces, viewer: Viewer, qualificationId: string, category: Category, route: Route | null): Promise<boolean> {
    if (!(CATEGORIES as readonly string[]).includes(category)) throw new Error('Catégorie inconnue.');
    if (route !== null && !(ROUTES as readonly string[]).includes(route)) throw new Error('Module de suite inconnu.');
    const row = await this.db.first<QualificationRow>('SELECT * FROM qualifications WHERE id = ?', [qualificationId]);
    if (!row) return false;
    const read = await acces.readFiche(viewer, row.person_id);
    if (!read.ok || read.view !== 'full') return false;
    const actor = `${viewer.role}:${viewer.userId}`;
    await this.db.run(
      'INSERT INTO qualification_corrections (id, network_id, qualification_id, actor, category, route, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [this.newId(), row.network_id, qualificationId, actor, category, route, this.now().toISOString()],
    );
    await appendEvent(
      this.journal,
      { type: 'qualification.corrigee', actor, subject: `person:${row.person_id}`, data: { from: row.category, to: category, route } },
      this.now,
    );
    return true;
  }

  /** Les cas corrigés par les agents, avec la dernière correction : ils rejoignent la mesure (Q05). */
  async correctedCases(networkId: string): Promise<{ inboundId: string; category: Category; route: Route | null }[]> {
    return this.db.all(
      `SELECT q.inbound_id AS inboundId, c.category AS category, c.route AS route
       FROM qualification_corrections c JOIN qualifications q ON q.id = c.qualification_id
       WHERE c.network_id = ? AND c.rowid = (SELECT max(c2.rowid) FROM qualification_corrections c2 WHERE c2.qualification_id = c.qualification_id)
       ORDER BY c.created_at`,
      [networkId],
    );
  }

  /**
   * Les cas corrigés, prêts pour le banc de mesure (Q09) : la direction seule [R16], le texte reçu sans coordonnées ni nom
   * connu, comme pour l'IA [R15]. Un message effacé n'a plus de texte : il sort des cas. Le journal garde le nombre, jamais un
   * texte [R13]. Le repérage des noms est prudent, pas parfait : le fichier est à relire et reste hors du dépôt
   * (docs/MESURE.md). Les plus récents seulement : un appel sur D1 tient 1 000 requêtes.
   */
  async correctedMeasureCases(viewer: Viewer): Promise<{ ok: true; value: MeasureCase[] } | { ok: false; rule: 'R16'; code: 'not_direction' }> {
    const actor = `${viewer.role}:${viewer.userId}`;
    if (viewer.role !== 'direction') {
      await appendEvent(this.journal, { type: 'acces.refuse', actor, subject: null, data: { rule: 'R16', role: viewer.role, kind: 'cas_de_mesure', code: 'not_direction' } }, this.now);
      return { ok: false, rule: 'R16', code: 'not_direction' };
    }
    const rows = await this.db.all<{ person_id: string; subject: string | null; body: string | null; sender_name: string | null; category: Category; route: Route | null }>(
      `SELECT q.person_id AS person_id, i.subject AS subject, i.body AS body, i.sender_name AS sender_name, c.category AS category, c.route AS route
       FROM qualification_corrections c
       JOIN qualifications q ON q.id = c.qualification_id
       JOIN inbound_messages i ON i.id = q.inbound_id
       WHERE c.network_id = ? AND c.rowid = (SELECT max(c2.rowid) FROM qualification_corrections c2 WHERE c2.qualification_id = c.qualification_id)
       ORDER BY c.created_at DESC, c.rowid DESC LIMIT ?`,
      [viewer.networkId, MEASURE_CASES_MAX],
    );
    const value: MeasureCase[] = [];
    const communes = this.options.communes ?? (await this.geographie.names(viewer.networkId));
    for (const row of rows.reverse()) {
      const text = [row.subject, row.body].filter((t): t is string => !!t).join('\n');
      if (text.trim() === '') continue;
      const clean = withoutNames(withoutContactDetails(text), await this.namesOf(row.person_id, row.sender_name), communes);
      if (clean === '') continue;
      value.push({ text: clean, category: row.category, route: row.route });
    }
    await appendEvent(this.journal, { type: 'qualification.cas_exportes', actor, subject: null, data: { cases: value.length } }, this.now);
    return { ok: true, value };
  }
}
