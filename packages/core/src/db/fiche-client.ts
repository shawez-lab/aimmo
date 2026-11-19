import { normalizeIdentifier } from '../fiche/normalize.ts';
import type { SqlDatabase, SqlStatement, SqlValue } from './sql.ts';
import type {
  Agent,
  Channel,
  Consent,
  ContactStatus,
  Exclusion,
  ExclusionReason,
  IdentifierKind,
  Message,
  Dwelling,
  MessageAuthor,
  MessageChannel,
  MessageDirection,
  Network,
  Person,
  PersonIdentifier,
  Project,
  ProjectKind,
  ProjectProperty,
  ProjectPropertyRole,
  Property,
  PropertyKind,
  PropertyStatus,
  Source,
} from './types.ts';

type Table =
  | 'networks'
  | 'agents'
  | 'persons'
  | 'person_identifiers'
  | 'consents'
  | 'exclusions'
  | 'projects'
  | 'sources'
  | 'properties'
  | 'project_properties'
  | 'messages';

interface InScope {
  networkId: string;
  agentId?: string | null;
}

export interface NewAgent {
  networkId: string;
  firstName: string;
  lastName: string;
  zone?: string | null;
  sponsorAgentId?: string | null;
}

export interface NewPerson extends InScope {
  firstName?: string | null;
  lastName?: string | null;
  language?: string;
  contactStatus?: ContactStatus;
}

export interface NewIdentifier extends InScope {
  personId: string;
  kind: IdentifierKind;
  /** Telle que saisie : elle est normalisée avant d'être rangée. */
  value: string;
}

export interface NewConsent extends InScope {
  personId: string;
  purpose: string;
  channel: Channel;
  proof: string;
  givenAt: Date;
}

export interface NewExclusion extends InScope {
  personId: string;
  reason: ExclusionReason;
  /** Absent : tous les canaux. */
  channel?: Channel | null;
  notedAt: Date;
}

export interface NewProject extends InScope {
  personId: string;
  kind: ProjectKind;
  stage?: string;
  deadline?: Date | null;
  budgetMinEur?: number | null;
  budgetMaxEur?: number | null;
  criteria?: Record<string, unknown> | null;
  note?: string | null;
}

export interface NewSource extends InScope {
  personId: string;
  projectId?: string | null;
  channel: string;
  detail?: string | null;
  occurredAt: Date;
}

export interface NewProperty extends InScope {
  reference: string;
  kind: PropertyKind;
  postalCode?: string | null;
  city?: string | null;
  surfaceM2?: number | null;
  rooms?: number | null;
  priceEur?: number | null;
  status?: PropertyStatus;
  /** Pour un logement : maison ou appartement (AU070). */
  dwelling?: Dwelling | null;
}

export interface NewProjectProperty extends InScope {
  projectId: string;
  propertyId: string;
  role: ProjectPropertyRole;
}

export interface NewMessage extends InScope {
  personId: string;
  projectId?: string | null;
  conversationId?: string | null;
  channel: MessageChannel;
  direction: MessageDirection;
  authorKind: MessageAuthor;
  body: string;
  costCents?: number;
  occurredAt: Date;
}

export interface FicheClientOptions {
  now?: () => Date;
  newId?: () => string;
}

/**
 * Accès typé à la fiche client unique. Le code ajoute ou complète des lignes, il n'en efface aucune [R17] :
 * un accord retiré ou une exclusion levée gardent leur ligne, avec la date.
 */
export class FicheClient {
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(
    private readonly db: SqlDatabase,
    options: FicheClientOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => crypto.randomUUID());
  }

  private stamp(): string {
    return this.now().toISOString();
  }

  /**
   * Prépare des écritures de la fiche sans les faire : `write` reçoit un brouillon qui n'écrit nulle part, et les lignes
   * qu'il aurait écrites sont rendues, à passer à `runBatch` avec d'autres pour que tout passe ou rien. Le brouillon
   * n'écrit qu'en insérant : une méthode qui lit la base refuse, au lieu de lire ce que le lot n'a pas encore écrit.
   */
  async prepare<T>(write: (draft: FicheClient) => Promise<T>): Promise<{ value: T; statements: SqlStatement[] }> {
    const statements: SqlStatement[] = [];
    const refuse = (): never => {
      throw new Error('Un brouillon de la fiche n’écrit qu’en insérant.');
    };
    const recording: SqlDatabase = {
      exec: async () => refuse(),
      run: async (sql, params = []) => {
        statements.push({ sql, params });
        return { changes: 1 };
      },
      first: async () => refuse(),
      all: async () => refuse(),
    };
    const value = await write(new FicheClient(recording, { now: this.now, newId: this.newId }));
    return { value, statements };
  }

  private async insert<T>(table: Table, row: Record<string, SqlValue>): Promise<T> {
    const columns = Object.keys(row);
    const sql = `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`;
    await this.db.run(sql, Object.values(row));
    return { ...row } as T;
  }

  /** Remplit une date de fin une seule fois, sans jamais effacer la ligne. */
  private async closeOnce(
    table: 'consents' | 'exclusions',
    column: 'withdrawn_at' | 'lifted_at',
    id: string,
    at: Date,
    unknown: string,
  ): Promise<string> {
    const { changes } = await this.db.run(
      `UPDATE ${table} SET ${column} = ? WHERE id = ? AND ${column} IS NULL`,
      [at.toISOString(), id],
    );
    if (changes === 1) return at.toISOString();
    const row = await this.db.first<Record<string, string | null>>(
      `SELECT ${column} AS closed_at FROM ${table} WHERE id = ?`,
      [id],
    );
    if (!row?.['closed_at']) throw new Error(`${unknown} : ${id}`);
    return row['closed_at'];
  }

  private scope(input: InScope): { network_id: string; agent_id: string | null } {
    return { network_id: input.networkId, agent_id: input.agentId ?? null };
  }

  // Réseaux et agents

  createNetwork(name: string): Promise<Network> {
    return this.insert<Network>('networks', { id: this.newId(), name, created_at: this.stamp() });
  }

  createAgent(input: NewAgent): Promise<Agent> {
    const at = this.stamp();
    return this.insert<Agent>('agents', {
      id: this.newId(),
      network_id: input.networkId,
      first_name: input.firstName,
      last_name: input.lastName,
      zone: input.zone ?? null,
      status: 'active',
      sponsor_agent_id: input.sponsorAgentId ?? null,
      created_at: at,
      updated_at: at,
    });
  }

  getAgent(id: string): Promise<Agent | null> {
    return this.db.first<Agent>('SELECT * FROM agents WHERE id = ?', [id]);
  }

  // Personnes et identifiants

  createPerson(input: NewPerson): Promise<Person> {
    const at = this.stamp();
    return this.insert<Person>('persons', {
      id: this.newId(),
      ...this.scope(input),
      first_name: input.firstName ?? null,
      last_name: input.lastName ?? null,
      language: input.language ?? 'fr',
      contact_status: input.contactStatus ?? 'new',
      last_contact_at: null,
      created_at: at,
      updated_at: at,
    });
  }

  getPerson(id: string): Promise<Person | null> {
    return this.db.first<Person>('SELECT * FROM persons WHERE id = ?', [id]);
  }

  listPersonsOfAgent(networkId: string, agentId: string): Promise<Person[]> {
    return this.db.all<Person>(
      'SELECT * FROM persons WHERE network_id = ? AND agent_id = ? ORDER BY created_at, id',
      [networkId, agentId],
    );
  }

  /** Range l'identifiant normalisé ; une valeur qui n'est pas un identifiant valable est refusée. */
  async addIdentifier(input: NewIdentifier): Promise<PersonIdentifier> {
    const value = normalizeIdentifier(input.kind, input.value);
    if (value === null) throw new Error(`Identifiant non valable (${input.kind}).`);
    return this.insert<PersonIdentifier>('person_identifiers', {
      id: this.newId(),
      ...this.scope(input),
      person_id: input.personId,
      kind: input.kind,
      value,
      created_at: this.stamp(),
    });
  }

  listIdentifiers(personId: string): Promise<PersonIdentifier[]> {
    return this.db.all<PersonIdentifier>(
      'SELECT * FROM person_identifiers WHERE person_id = ? ORDER BY created_at, id',
      [personId],
    );
  }

  /** Toutes les personnes du réseau qui portent cet identifiant : plusieurs en cas de doublon (S04). */
  findPersonsByIdentifier(networkId: string, kind: IdentifierKind, value: string): Promise<Person[]> {
    return this.db.all<Person>(
      `SELECT DISTINCT p.* FROM persons p
       JOIN person_identifiers i ON i.person_id = p.id
       WHERE i.network_id = ? AND i.kind = ? AND i.value = ? AND p.network_id = ?
       ORDER BY p.created_at, p.id`,
      [networkId, kind, value, networkId],
    );
  }

  // Accords et exclusions

  async addConsent(input: NewConsent): Promise<Consent> {
    if (input.proof.trim() === '') throw new Error('Un accord sans preuve ne peut pas être enregistré.');
    return this.insert<Consent>('consents', {
      id: this.newId(),
      ...this.scope(input),
      person_id: input.personId,
      purpose: input.purpose,
      channel: input.channel,
      proof: input.proof,
      given_at: input.givenAt.toISOString(),
      withdrawn_at: null,
      created_at: this.stamp(),
    });
  }

  /** Retire un accord. Rend la date du retrait, celle d'avant si l'accord était déjà retiré. Accord inconnu : erreur. */
  async withdrawConsent(id: string, at: Date): Promise<string> {
    return this.closeOnce('consents', 'withdrawn_at', id, at, 'Accord inconnu');
  }

  listConsents(personId: string): Promise<Consent[]> {
    return this.db.all<Consent>('SELECT * FROM consents WHERE person_id = ? ORDER BY given_at, id', [
      personId,
    ]);
  }

  addExclusion(input: NewExclusion): Promise<Exclusion> {
    return this.insert<Exclusion>('exclusions', {
      id: this.newId(),
      ...this.scope(input),
      person_id: input.personId,
      reason: input.reason,
      channel: input.channel ?? null,
      noted_at: input.notedAt.toISOString(),
      lifted_at: null,
      created_at: this.stamp(),
    });
  }

  /** Lève une exclusion. Rend la date de levée, celle d'avant si elle était déjà levée. Exclusion inconnue : erreur. */
  async liftExclusion(id: string, at: Date): Promise<string> {
    return this.closeOnce('exclusions', 'lifted_at', id, at, 'Exclusion inconnue');
  }

  listExclusions(personId: string): Promise<Exclusion[]> {
    return this.db.all<Exclusion>('SELECT * FROM exclusions WHERE person_id = ? ORDER BY noted_at, id', [
      personId,
    ]);
  }

  // Projets, sources et biens

  createProject(input: NewProject): Promise<Project> {
    const at = this.stamp();
    return this.insert<Project>('projects', {
      id: this.newId(),
      ...this.scope(input),
      person_id: input.personId,
      kind: input.kind,
      stage: input.stage ?? 'new',
      deadline: input.deadline ? input.deadline.toISOString() : null,
      budget_min_eur: input.budgetMinEur ?? null,
      budget_max_eur: input.budgetMaxEur ?? null,
      criteria: input.criteria ? JSON.stringify(input.criteria) : null,
      note: input.note ?? null,
      created_at: at,
      updated_at: at,
    });
  }

  listProjects(personId: string): Promise<Project[]> {
    return this.db.all<Project>('SELECT * FROM projects WHERE person_id = ? ORDER BY created_at, id', [
      personId,
    ]);
  }

  addSource(input: NewSource): Promise<Source> {
    return this.insert<Source>('sources', {
      id: this.newId(),
      ...this.scope(input),
      person_id: input.personId,
      project_id: input.projectId ?? null,
      channel: input.channel,
      detail: input.detail ?? null,
      occurred_at: input.occurredAt.toISOString(),
      created_at: this.stamp(),
    });
  }

  listSources(personId: string): Promise<Source[]> {
    return this.db.all<Source>('SELECT * FROM sources WHERE person_id = ? ORDER BY occurred_at, id', [
      personId,
    ]);
  }

  createProperty(input: NewProperty): Promise<Property> {
    const at = this.stamp();
    return this.insert<Property>('properties', {
      id: this.newId(),
      ...this.scope(input),
      reference: input.reference,
      kind: input.kind,
      postal_code: input.postalCode ?? null,
      city: input.city ?? null,
      surface_m2: input.surfaceM2 ?? null,
      rooms: input.rooms ?? null,
      price_eur: input.priceEur ?? null,
      status: input.status ?? 'draft',
      created_at: at,
      updated_at: at,
      ...(input.dwelling ? { dwelling: input.dwelling } : {}),
    });
  }

  getProperty(id: string): Promise<Property | null> {
    return this.db.first<Property>('SELECT * FROM properties WHERE id = ?', [id]);
  }

  linkProjectProperty(input: NewProjectProperty): Promise<ProjectProperty> {
    return this.insert<ProjectProperty>('project_properties', {
      project_id: input.projectId,
      property_id: input.propertyId,
      ...this.scope(input),
      role: input.role,
      created_at: this.stamp(),
    });
  }

  listProjectProperties(projectId: string): Promise<ProjectProperty[]> {
    return this.db.all<ProjectProperty>(
      'SELECT * FROM project_properties WHERE project_id = ? ORDER BY created_at, property_id',
      [projectId],
    );
  }

  // Messages

  /** Range un message déjà reçu ou déjà autorisé. N'envoie rien : la sortie passe par le contrôle central (S06). */
  async recordMessage(input: NewMessage): Promise<Message> {
    const occurredAt = input.occurredAt.toISOString();
    const message = await this.insert<Message>('messages', {
      id: this.newId(),
      ...this.scope(input),
      person_id: input.personId,
      project_id: input.projectId ?? null,
      conversation_id: input.conversationId ?? null,
      channel: input.channel,
      direction: input.direction,
      author_kind: input.authorKind,
      body: input.body,
      cost_cents: input.costCents ?? 0,
      occurred_at: occurredAt,
      created_at: this.stamp(),
    });
    await this.db.run(
      `UPDATE persons SET last_contact_at = ?, updated_at = ?
       WHERE id = ? AND (last_contact_at IS NULL OR last_contact_at < ?)`,
      [occurredAt, this.stamp(), input.personId, occurredAt],
    );
    return message;
  }

  listMessages(personId: string): Promise<Message[]> {
    return this.db.all<Message>('SELECT * FROM messages WHERE person_id = ? ORDER BY occurred_at, id', [
      personId,
    ]);
  }
}
