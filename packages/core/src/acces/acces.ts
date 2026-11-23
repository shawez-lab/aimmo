import type { FicheClient } from '../db/fiche-client.ts';
import type { SqlDatabase } from '../db/sql.ts';
import type { Agent, Person, Property } from '../db/types.ts';
import type { FicheComplete, FicheUnique } from '../fiche/fusion.ts';
import { localTime } from '../envoi/horaires.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalEntry, JournalStore } from '../journal/types.ts';
import {
  decideAccess,
  ROLES,
  type AccessDecision,
  type RefusalCode,
  type ResourceKind,
  type Viewer,
} from './droits.ts';
import { agentState } from './etat-agent.ts';

export type AccessResult<T> =
  | { ok: true; view: 'full' | 'shared'; value: T }
  | { ok: false; rule: 'R16'; code: RefusalCode };

type Refused = { ok: false; rule: 'R16'; code: RefusalCode };

export interface AccesOptions {
  now?: () => Date;
}

/** Sujet d'une ligne du journal pour une fiche : un identifiant interne, jamais un nom [R13]. */
export const personSubject = (personId: string): string => `person:${personId}`;

/**
 * Lecture des données sous droits d'accès [R16]. Chaque lecture d'une fiche, et chaque refus, est écrit
 * au journal à empreintes avant que la moindre donnée ne soit rendue : si le journal ne répond pas,
 * rien n'est lu.
 */
export class Acces {
  private readonly now: () => Date;

  constructor(
    private readonly db: SqlDatabase,
    private readonly fiches: FicheClient,
    private readonly unique: FicheUnique,
    private readonly journal: JournalStore,
    options: AccesOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  /** Toute la fiche d'une personne, avec les fiches qui y sont réunies. */
  async readFiche(viewer: Viewer, personId: string): Promise<AccessResult<FicheComplete>> {
    const subject = personSubject(personId);
    const blocked = await this.checkViewer(viewer, 'person', subject);
    if (blocked) return blocked;
    // Aucune fiche client avant un dossier d'agent complet et valide ce jour-là [R82].
    if (await this.restricted(viewer)) return this.refused(viewer, 'person', subject, 'agent_file_incomplete');

    const person = await this.fiches.getPerson(personId);
    if (!person) return this.refused(viewer, 'person', subject, 'unknown');
    const fiche = await this.unique.view(personId);
    const decision = decideAccess(viewer, {
      kind: 'person',
      networkId: person.network_id,
      agentIds: fiche.members.map((member) => member.agent_id),
    });
    // Le binôme d'un agent absent ouvre les fiches de l'absent pendant l'absence déclarée, et seulement alors [R680].
    const cover = decision.allowed ? null : await this.coverOf(viewer, fiche.members.map((member) => member.agent_id));
    if (!decision.allowed && !cover) return this.refused(viewer, 'person', subject, decision.code);

    await this.write(viewer, 'fiche.lue', personSubject(fiche.person.id), {
      rule: 'R16',
      role: viewer.role,
      requested: subject,
      members: fiche.members.map((member) => personSubject(member.id)),
      ...(cover ? { cover } : {}),
    });
    return { ok: true, view: decision.allowed ? decision.view : 'full', value: fiche };
  }

  /**
   * L'absence qui ouvre la fiche à l'agent, s'il reprend ce jour (heure de Paris) les dossiers de chaque autre agent
   * qui la suit (J09) ; null sinon [R680]. Rend la référence de l'absence, jamais un nom.
   */
  private async coverOf(viewer: Viewer, agentIds: readonly (string | null)[]): Promise<string | null> {
    if (viewer.role !== 'agent') return null;
    const others = [...new Set(agentIds.filter((id): id is string => id !== null && id !== viewer.userId))];
    if (others.length === 0) return null;
    const day = localTime(this.now(), 'Europe/Paris').date;
    const refs: string[] = [];
    for (const absentId of others) {
      const row = await this.db.first<{ id: string }>(
        `SELECT x.id FROM agent_absences x
         WHERE x.network_id = ? AND x.agent_id = ? AND x.cover_agent_id = ? AND x.from_day <= ? AND x.until_day >= ?
         ORDER BY x.declared_at DESC, x.rowid DESC LIMIT 1`,
        [viewer.networkId, absentId, viewer.userId, day, day],
      );
      if (!row) return null;
      refs.push(`agent_absence:${row.id}`);
    }
    return refs.join(',');
  }

  /** La liste des fiches qu'on a le droit de voir : pour un agent, ses clients seulement. */
  async listPersons(viewer: Viewer, via?: string): Promise<AccessResult<Person[]>> {
    const blocked = await this.checkViewer(viewer, 'person', null);
    if (blocked) return blocked;
    if (await this.restricted(viewer)) return this.refused(viewer, 'person', null, 'agent_file_incomplete');
    if (!decideAccess(viewer, { kind: 'person', networkId: viewer.networkId, agentIds: [viewer.userId] }).allowed) {
      return this.refused(viewer, 'person', null, 'role');
    }

    const candidates =
      viewer.role === 'agent'
        ? await this.fiches.listPersonsOfAgent(viewer.networkId, viewer.userId)
        : await this.db.all<Person>('SELECT * FROM persons WHERE network_id = ? ORDER BY created_at, id', [
            viewer.networkId,
          ]);
    // Chaque fiche repasse par la règle : une fiche réunie à celle d'un autre agent n'apparaît pas.
    const visible: Person[] = [];
    for (const person of candidates) {
      const members = await this.unique.membersOf(person.id);
      const rows = await Promise.all(members.map((id) => this.fiches.getPerson(id)));
      const decision = decideAccess(viewer, {
        kind: 'person',
        networkId: person.network_id,
        agentIds: rows.map((row) => row?.agent_id ?? null),
      });
      if (decision.allowed) visible.push(person);
    }

    await this.write(viewer, 'fiches.listees', null, {
      rule: 'R16',
      role: viewer.role,
      count: visible.length,
      persons: visible.map((person) => personSubject(person.id)),
      // Lu par le système pour l'agent, comme le plan du jour figé par le planificateur.
      ...(via === undefined ? {} : { via }),
    });
    return { ok: true, view: 'full', value: visible };
  }

  /** Un bien : complet pour son agent, la direction et la conformité ; fiche commune pour les autres agents. */
  async readProperty(viewer: Viewer, propertyId: string): Promise<AccessResult<Property>> {
    const subject = `property:${propertyId}`;
    const blocked = await this.checkViewer(viewer, 'property', subject);
    if (blocked) return blocked;
    const property = await this.fiches.getProperty(propertyId);
    if (!property) return this.refused(viewer, 'property', subject, 'unknown');
    // Un agent au dossier incomplet ne voit que le fichier commun, même pour un bien qui lui est confié [R82].
    const restricted = await this.restricted(viewer);
    const decision = decideAccess(viewer, {
      kind: 'property',
      networkId: property.network_id,
      agentId: restricted ? null : property.agent_id,
      status: property.status,
    });
    if (!decision.allowed) return this.refused(viewer, 'property', subject, decision.code);
    await this.write(viewer, 'bien.lu', subject, { rule: 'R16', role: viewer.role, view: decision.view });
    return { ok: true, view: decision.view, value: property };
  }

  /** Le journal d'audit d'une fiche : qui l'a vue, quand. Direction et conformité seulement. */
  async readJournalOf(viewer: Viewer, personId: string): Promise<AccessResult<JournalEntry[]>> {
    const subject = personSubject(personId);
    const blocked = await this.checkViewer(viewer, 'journal', subject);
    if (blocked) return blocked;
    const person = await this.fiches.getPerson(personId);
    if (!person) return this.refused(viewer, 'journal', subject, 'unknown');
    const decision = decideAccess(viewer, { kind: 'journal', networkId: person.network_id });
    if (!decision.allowed) return this.refused(viewer, 'journal', subject, decision.code);
    // Une fiche réunie : son histoire est celle de la fiche gardée et de toutes les fiches qui y sont réunies.
    const members = await this.unique.membersOf(personId);
    await this.write(viewer, 'journal.lu', subject, {
      rule: 'R16',
      role: viewer.role,
      members: members.map((id) => personSubject(id)),
    });
    const bySeq = new Map<number, JournalEntry>();
    for (const id of members) {
      for (const entry of await this.journal.bySubject(personSubject(id))) bySeq.set(entry.seq, entry);
    }
    return { ok: true, view: 'full', value: [...bySeq.values()].sort((a, b) => a.seq - b.seq) };
  }

  /** Les chiffres d'un agent. Seule la décision existe tant que M13 n'a pas créé les chiffres. */
  async canSeeFigures(viewer: Viewer, agentId: string): Promise<AccessDecision> {
    const subject = `agent:${agentId}`;
    const blocked = await this.checkViewer(viewer, 'figures', subject);
    if (blocked) return { allowed: false, rule: 'R16', code: blocked.code };
    const target = await this.db.first<Agent>('SELECT * FROM agents WHERE id = ?', [agentId]);
    if (!target) {
      await this.refused(viewer, 'figures', subject, 'unknown');
      return { allowed: false, rule: 'R16', code: 'unknown' };
    }
    const decision = decideAccess(viewer, { kind: 'figures', networkId: target.network_id, agentId: target.id });
    if (!decision.allowed) await this.refused(viewer, 'figures', subject, decision.code);
    return decision;
  }

  /**
   * Un agent doit exister dans le réseau annoncé et être en activité : le jour de son départ, son accès
   * est coupé dès minuit à Paris, avant même le passage du planificateur [R86]. L'identité des autres rôles vient de
   * la connexion (S09).
   */
  private async checkViewer(viewer: Viewer, kind: ResourceKind, subject: string | null): Promise<Refused | null> {
    if (!(ROLES as readonly string[]).includes(viewer.role)) return this.refused(viewer, kind, subject, 'role');
    if (viewer.role !== 'agent') return null;
    const agent = await this.db.first<Agent>('SELECT * FROM agents WHERE id = ?', [viewer.userId]);
    if (!agent || agent.network_id !== viewer.networkId || agent.status !== 'active') {
      return this.refused(viewer, kind, subject, 'agent_inactive');
    }
    if ((await agentState(this.db, viewer.networkId, viewer.userId, this.now())) === 'parti') {
      return this.refused(viewer, kind, subject, 'agent_inactive');
    }
    return null;
  }

  /** Un agent dont le dossier d'agent n'est pas complet et valide ce jour-là [R82]. */
  private async restricted(viewer: Viewer): Promise<boolean> {
    return viewer.role === 'agent' && (await agentState(this.db, viewer.networkId, viewer.userId, this.now())) === 'dossier_incomplet';
  }

  private async refused(
    viewer: Viewer,
    kind: ResourceKind,
    subject: string | null,
    code: RefusalCode,
  ): Promise<{ ok: false; rule: 'R16'; code: RefusalCode }> {
    await this.write(viewer, 'acces.refuse', subject, { rule: 'R16', role: String(viewer.role), kind, code });
    return { ok: false, rule: 'R16', code };
  }

  private async write(
    viewer: Viewer,
    type: string,
    subject: string | null,
    data: Record<string, string | number | string[]>,
  ): Promise<void> {
    await appendEvent(this.journal, { type, actor: `${String(viewer.role)}:${viewer.userId}`, subject, data }, this.now);
  }
}
