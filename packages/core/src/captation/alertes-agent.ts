/**
 * Les alertes de l'agent, telles que son application les montre (C09c) [R12, R16, R17, R21, R13].
 *
 * Une conversation à reprendre ou une réponse qui n'a pas pu partir ne doit jamais rester invisible. L'agent voit les
 * alertes des fiches qu'il a le droit de voir maintenant, fusions comprises : une alerte suit la fiche. Décidé, lecture
 * prudente : l'agent qui recevait une alerte et dont la fiche est passée à un autre ne la voit plus ; une fiche réunie à
 * celle d'un autre agent n'est vue de personne tant que la direction ne l'a pas attribuée, comme partout ailleurs.
 *
 * Marquer une alerte vue ne supprime rien : la ligne garde sa date [R17]. Une alerte inconnue et l'alerte d'un autre
 * reçoivent le même refus : rien n'est dit de son existence. Rien n'est envoyé d'ici, et le journal ne porte que des
 * identifiants et des nombres [R13].
 */
import { personSubject } from '../acces/acces.ts';
import { decideAccess, type Viewer } from '../acces/droits.ts';
import { agentState } from '../acces/etat-agent.ts';
import { FicheClient } from '../db/fiche-client.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { FicheUnique } from '../fiche/fusion.ts';
import { ficheFirstName } from '../fiche/prenom.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import type { AgentAlertRow, AlertReason } from './relais.ts';

/** Les alertes rendues en une fois : les plus anciennes d'abord, les suivantes apparaissent quand celles-ci sont vues. */
export const MAX_AGENT_ALERTS = 30;
/** Les alertes examinées : une fiche réunie à celle d'un autre agent ne doit pas prendre toutes les places. */
const MAX_ALERT_CANDIDATES = 100;
const ALERT_CHANNELS: ReadonlySet<string> = new Set(['instagram', 'facebook', 'whatsapp', 'email', 'site']);

export interface AgentAlertView {
  id: string;
  /** La fiche gardée : la seule à ouvrir. */
  personId: string;
  firstName: string | null;
  reason: AlertReason;
  /** Le canal de la conversation, dans une liste fermée : jamais sa référence, qui peut être une coordonnée [R13]. */
  channel: string | null;
  createdAt: string;
  /** Une exclusion est active : l'agent le sait avant de reprendre la conversation [R02, R04]. */
  contactClosed: boolean;
}

type Refusal = { ok: false; rule: 'R16'; code: 'role' | 'agent_inactive' | 'agent_file_incomplete' | 'not_assigned' };
export type AgentAlertsRead = { ok: true; value: { alerts: AgentAlertView[]; more: boolean } } | Refusal;
export type AgentAlertsUnseen = { ok: true; value: { total: number; exchanges: number; needsReply: number; more: boolean } } | Refusal;
export type AgentAlertSeen = { ok: true; value: { already: boolean; changed: boolean } } | Refusal;

const placeholders = (n: number): string => Array.from({ length: n }, () => '?').join(', ');

export class AlertesAgent {
  private readonly now: () => Date;
  private readonly unique: FicheUnique;

  constructor(
    private readonly db: SqlDatabase,
    private readonly journal: JournalStore,
    options: { now?: () => Date } = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.unique = new FicheUnique(db, new FicheClient(db, { now: this.now }), { now: this.now });
  }

  private refuse(viewer: Viewer, code: Refusal['code'], subject: string | null, via: string): Promise<Refusal> {
    return appendEvent(
      this.journal,
      { type: 'acces.refuse', actor: `${String(viewer.role)}:${viewer.userId}`, subject, data: { rule: 'R16', role: String(viewer.role), kind: 'agent_alerts', code, via } },
      this.now,
    ).then(() => ({ ok: false, rule: 'R16', code }));
  }

  /** Le lecteur, s'il peut lire ses alertes : un agent en activité, au dossier complet [R16, R82, R86]. */
  private async blocked(viewer: Viewer, via: string): Promise<Refusal | null> {
    if (viewer.role !== 'agent') return this.refuse(viewer, 'role', null, via);
    const agent = await this.db.first<{ network_id: string }>('SELECT network_id FROM agents WHERE id = ?', [viewer.userId]);
    if (!agent || agent.network_id !== viewer.networkId) return this.refuse(viewer, 'agent_inactive', null, via);
    const state = await agentState(this.db, viewer.networkId, viewer.userId, this.now());
    if (state === 'parti') return this.refuse(viewer, 'agent_inactive', null, via);
    return state === 'dossier_incomplet' ? this.refuse(viewer, 'agent_file_incomplete', null, via) : null;
  }

  /** Les fiches réunies de la personne, si l'agent a le droit de la voir maintenant ; sinon null. */
  private async membersIfAllowed(viewer: Viewer, personId: string): Promise<string[] | null> {
    const ids = await this.unique.membersOf(personId);
    const rows = await this.db.all<{ agent_id: string | null; network_id: string }>(`SELECT agent_id, network_id FROM persons WHERE id IN (${placeholders(ids.length)})`, ids);
    const allowed =
      rows.length === ids.length &&
      rows.every((r) => r.network_id === viewer.networkId) &&
      decideAccess(viewer, { kind: 'person', networkId: viewer.networkId, agentIds: rows.map((r) => r.agent_id) }).allowed;
    return allowed ? ids : null;
  }

  /**
   * Le compte, pour la direction, des alertes qu'aucun agent ne voit : fiche sans agent, réunie à celle d'un autre, ou
   * suivie par un agent parti ou au dossier incomplet (C09d) [R12]. Des nombres seulement : la direction attribue les
   * fiches, et l'alerte reparaît chez l'agent [R13, R16]. Les fiches réunies examinées sont bornées : `more` dit qu'il en reste.
   */
  async unseenByAnyAgent(viewer: Viewer): Promise<AgentAlertsUnseen> {
    if (viewer.role !== 'direction') return this.refuse(viewer, 'role', null, 'alertes_agent.sans_agent');
    // Une ligne par fiche et par raison : un stock d'alertes chez des agents actifs ne prend la place de personne.
    const rows = await this.db.all<{ person_id: string; reason: AlertReason; n: number; agent_id: string | null; merged: number }>(
      `SELECT a.person_id, a.reason, count(*) AS n, p.agent_id,
         EXISTS (SELECT 1 FROM person_merges m WHERE m.undone_at IS NULL AND (m.survivor_id = a.person_id OR m.merged_id = a.person_id)) AS merged
       FROM agent_alerts a JOIN persons p ON p.id = a.person_id
       WHERE a.network_id = ? AND a.seen_at IS NULL GROUP BY a.person_id, a.reason ORDER BY a.person_id, a.reason`,
      [viewer.networkId],
    );
    const states = new Map<string, string>();
    const counts: Record<AlertReason, number> = { exchanges: 0, needs_reply: 0 };
    let examined = 0;
    let more = false;
    for (const row of rows) {
      let assigned = row.agent_id === null ? [] : [row.agent_id];
      // Seules les fiches réunies coûtent une lecture de plus ; au-delà de la borne, le compte le dit.
      if (Number(row.merged) === 1) {
        if (examined === MAX_ALERT_CANDIDATES) {
          more = true;
          continue;
        }
        examined += 1;
        const ids = await this.unique.membersOf(row.person_id);
        const members = await this.db.all<{ agent_id: string | null }>(`SELECT agent_id FROM persons WHERE id IN (${placeholders(ids.length)})`, ids);
        assigned = [...new Set(members.map((m) => m.agent_id).filter((id): id is string => id !== null))];
      }
      const agent = assigned.length === 1 ? (assigned[0] as string) : null;
      if (agent !== null && !states.has(agent)) states.set(agent, await agentState(this.db, viewer.networkId, agent, this.now()));
      if (agent === null || states.get(agent) !== 'actif') counts[row.reason] += Number(row.n);
    }
    const total = counts.exchanges + counts.needs_reply;
    await appendEvent(
      this.journal,
      { type: 'alertes_agent.sans_agent_lues', actor: `direction:${viewer.userId}`, subject: `network:${viewer.networkId}`, data: { rule: 'R16', count: total } },
      this.now,
    );
    return { ok: true, value: { total, exchanges: counts.exchanges, needsReply: counts.needs_reply, more } };
  }

  /** Les alertes non vues des fiches de l'agent, les plus anciennes d'abord. */
  async list(viewer: Viewer): Promise<AgentAlertsRead> {
    const blocked = await this.blocked(viewer, 'alertes_agent');
    if (blocked) return blocked;
    const actor = `agent:${viewer.userId}`;
    // Ses fiches et, de proche en proche, celles qui y sont réunies : le nombre de lectures suit le nombre d'alertes,
    // jamais le nombre de ses clients. Le droit lui-même est décidé ligne par ligne ci-dessous.
    const candidates = await this.db.all<AgentAlertRow>(
      `WITH RECURSIVE mine (id) AS (
         SELECT id FROM persons WHERE network_id = ? AND agent_id = ?
         UNION SELECT m.merged_id FROM person_merges m JOIN mine ON m.survivor_id = mine.id WHERE m.undone_at IS NULL
         UNION SELECT m.survivor_id FROM person_merges m JOIN mine ON m.merged_id = mine.id WHERE m.undone_at IS NULL
       )
       SELECT a.* FROM agent_alerts a WHERE a.network_id = ? AND a.seen_at IS NULL AND a.person_id IN (SELECT id FROM mine)
       ORDER BY a.created_at, a.rowid LIMIT ?`,
      [viewer.networkId, viewer.userId, viewer.networkId, MAX_ALERT_CANDIDATES],
    );
    const at = this.now().toISOString();
    const alerts: AgentAlertView[] = [];
    const reads: { root: string; members: string[]; alert: string }[] = [];
    let more = candidates.length === MAX_ALERT_CANDIDATES;
    for (const row of candidates) {
      const members = await this.membersIfAllowed(viewer, row.person_id);
      if (!members) continue;
      if (alerts.length === MAX_AGENT_ALERTS) {
        more = true;
        break;
      }
      const root = members[0] as string;
      const closed = await this.db.first(
        `SELECT 1 AS yes FROM exclusions WHERE person_id IN (${placeholders(members.length)}) AND noted_at <= ? AND (lifted_at IS NULL OR lifted_at > ?) LIMIT 1`,
        [...members, at, at],
      );
      const channel = row.conversation_id.split(':', 1)[0] as string;
      alerts.push({
        id: row.id,
        personId: root,
        firstName: await ficheFirstName(this.db, members),
        reason: row.reason,
        channel: ALERT_CHANNELS.has(channel) ? channel : null,
        createdAt: row.created_at,
        contactClosed: closed !== null,
      });
      reads.push({ root, members, alert: row.id });
    }
    // Un prénom est une donnée de la fiche : sa lecture est écrite avant d'être rendue, sans nom ni contenu [R16, R13].
    for (const read of reads) {
      await appendEvent(
        this.journal,
        { type: 'fiche.lue', actor, subject: personSubject(read.root), data: { rule: 'R16', role: 'agent', via: 'alertes_agent', alert: `agent_alert:${read.alert}`, members: read.members.map((m) => personSubject(m)) } },
        this.now,
      );
    }
    await appendEvent(this.journal, { type: 'alertes_agent.lues', actor, subject: `agent:${viewer.userId}`, data: { rule: 'R16', count: alerts.length } }, this.now);
    return { ok: true, value: { alerts, more } };
  }

  /**
   * L'agent a vu l'alerte telle qu'il l'a lue (`createdAt`) : la ligne reste, avec sa date [R17]. Une alerte rouverte
   * depuis cette lecture n'est pas refermée : `changed` demande de relire la liste [R12].
   */
  async markSeen(viewer: Viewer, alertId: string, createdAt: string): Promise<AgentAlertSeen> {
    const blocked = await this.blocked(viewer, 'alerte_agent.vue');
    if (blocked) return blocked;
    const row = await this.db.first<AgentAlertRow>('SELECT * FROM agent_alerts WHERE id = ? AND network_id = ?', [alertId, viewer.networkId]);
    if (!row || !(await this.membersIfAllowed(viewer, row.person_id))) {
      return this.refuse(viewer, 'not_assigned', row ? personSubject(row.person_id) : null, 'alerte_agent.vue');
    }
    if (row.created_at !== createdAt) return { ok: true, value: { already: false, changed: true } };
    const { changes } = await this.db.run('UPDATE agent_alerts SET seen_at = ? WHERE id = ? AND seen_at IS NULL AND created_at = ?', [this.now().toISOString(), row.id, createdAt]);
    if (changes !== 1) return { ok: true, value: { already: true, changed: false } };
    await appendEvent(
      this.journal,
      { type: 'alerte_agent.vue', actor: `agent:${viewer.userId}`, subject: personSubject(row.person_id), data: { rule: 'R17', alert: `agent_alert:${row.id}`, reason: row.reason, raisedAt: row.created_at } },
      this.now,
    );
    return { ok: true, value: { already: false, changed: false } };
  }
}
