/**
 * Délais de validité suivis (M09, O05) [R59].
 *
 * Chaque jour, une tâche pour l'agent du bien quand une offre sans réponse arrive à son échéance : le nombre de jours
 * d'avance est un réglage (1 jour : la veille du dernier jour). Une seule tâche par offre. L'offre passe « échue » le
 * lendemain de son dernier jour, à l'heure de Paris, et ne peut plus être acceptée (O03). Rien n'est envoyé au vendeur
 * ni à l'acquéreur.
 */
import type { Viewer } from '../acces/droits.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { localTime } from '../envoi/horaires.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';

const TIME_ZONE = 'Europe/Paris';
export const DEFAULT_OFFER_NOTICE_DAYS = 1;

const addDays = (day: string, n: number): string => new Date(Date.parse(`${day}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

export interface OfferTask {
  offerId: string;
  /** La proposition (contre-offre) dont l'échéance approche, ou null pour l'offre elle-même. */
  proposalId: string | null;
  propertyId: string;
  lastDay: string;
  createdAt: string;
}

export class EcheancesOffres {
  private readonly now: () => Date;
  private readonly noticeDays: number;

  constructor(
    private readonly db: SqlDatabase,
    private readonly journal: JournalStore,
    options: { now?: () => Date; noticeDays?: number } = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.noticeDays = options.noticeDays ?? DEFAULT_OFFER_NOTICE_DAYS;
    if (!Number.isInteger(this.noticeDays) || this.noticeDays < 0 || this.noticeDays > 30) throw new Error('Délai de rappel des offres : de 0 à 30 jours.');
  }

  /** Le passage du jour : une tâche pour chaque offre sans réponse dont l'échéance approche. Rend les offres traitées. */
  async run(networkId: string): Promise<string[]> {
    const today = localTime(this.now(), TIME_ZONE).date;
    const rows = await this.db.all<{ id: string; agent_id: string; property_id: string; valid_until: string }>(
      `SELECT o.id, o.agent_id, o.property_id, o.valid_until FROM offer_register o
       WHERE o.network_id = ? AND o.valid_until >= ? AND o.valid_until <= ?
       AND NOT EXISTS (SELECT 1 FROM offer_responses r WHERE r.offer_id = o.id)
       AND NOT EXISTS (SELECT 1 FROM offer_tasks k WHERE k.offer_id = o.id) ORDER BY o.valid_until, o.at`,
      [networkId, today, addDays(today, this.noticeDays)],
    );
    const done: string[] = [];
    for (const r of rows) {
      const { changes } = await this.db.run('INSERT INTO offer_tasks (offer_id, network_id, agent_id, last_day, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (offer_id) DO NOTHING', [r.id, networkId, r.agent_id, r.valid_until, this.now().toISOString()]);
      if (changes !== 1) continue;
      await appendEvent(this.journal, { type: 'offre.echeance', actor: 'system:offres', subject: `offer:${r.id}`, data: { rule: 'R59', lastDay: r.valid_until } }, this.now);
      done.push(r.id);
    }
    // Les propositions (contre-offres) sans réponse : même suivi, une tâche par proposition [R59].
    const proposals = await this.db.all<{ id: string; offer_id: string; agent_id: string; valid_until: string }>(
      `SELECT p.id, p.offer_id, o.agent_id, p.valid_until FROM offer_proposals p JOIN offer_register o ON o.id = p.offer_id
       WHERE p.network_id = ? AND p.valid_until >= ? AND p.valid_until <= ?
       AND NOT EXISTS (SELECT 1 FROM proposal_responses r WHERE r.proposal_id = p.id)
       AND NOT EXISTS (SELECT 1 FROM proposal_tasks k WHERE k.proposal_id = p.id) ORDER BY p.valid_until, p.at`,
      [networkId, today, addDays(today, this.noticeDays)],
    );
    for (const p of proposals) {
      const { changes } = await this.db.run('INSERT INTO proposal_tasks (proposal_id, network_id, agent_id, last_day, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (proposal_id) DO NOTHING', [p.id, networkId, p.agent_id, p.valid_until, this.now().toISOString()]);
      if (changes !== 1) continue;
      await appendEvent(this.journal, { type: 'offre.echeance', actor: 'system:offres', subject: `offer:${p.offer_id}`, data: { rule: 'R59', lastDay: p.valid_until, proposal: true } }, this.now);
      done.push(p.id);
    }
    return done;
  }

  /**
   * Les tâches d'échéance de l'agent qui suit le bien aujourd'hui, celles des offres encore sans réponse [R16] : un bien
   * qui change de main emporte ses échéances, sinon plus personne ne les verrait [R59].
   */
  async tasksOf(viewer: Viewer): Promise<{ ok: true; tasks: OfferTask[] } | { ok: false; rule: 'R16'; code: 'not_agent' | 'agent_inactive' }> {
    const refuse = async (code: 'not_agent' | 'agent_inactive') => {
      await appendEvent(this.journal, { type: 'acces.refuse', actor: `${String(viewer.role)}:${viewer.userId}`, subject: null, data: { rule: 'R16', role: String(viewer.role), kind: 'offer_tasks', code } }, this.now);
      return { ok: false as const, rule: 'R16' as const, code };
    };
    if (viewer.role !== 'agent') return refuse('not_agent');
    // Un agent parti, ou d'un autre réseau, ne voit plus rien [R16].
    const agent = await this.db.first<{ network_id: string; status: string }>('SELECT network_id, status FROM agents WHERE id = ?', [viewer.userId]);
    if (!agent || agent.network_id !== viewer.networkId || agent.status !== 'active') return refuse('agent_inactive');
    const rows = await this.db.all<{ offer_id: string; property_id: string; last_day: string; created_at: string }>(
      `SELECT k.offer_id, o.property_id, k.last_day, k.created_at FROM offer_tasks k JOIN offer_register o ON o.id = k.offer_id
       JOIN properties p ON p.id = o.property_id
       WHERE k.network_id = ? AND p.agent_id = ? AND NOT EXISTS (SELECT 1 FROM offer_responses r WHERE r.offer_id = k.offer_id)
       ORDER BY k.last_day, k.created_at`,
      [viewer.networkId, viewer.userId],
    );
    const proposalRows = await this.db.all<{ proposal_id: string; offer_id: string; property_id: string; last_day: string; created_at: string }>(
      `SELECT k.proposal_id, p.offer_id, o.property_id, k.last_day, k.created_at FROM proposal_tasks k JOIN offer_proposals p ON p.id = k.proposal_id
       JOIN offer_register o ON o.id = p.offer_id JOIN properties b ON b.id = o.property_id
       WHERE k.network_id = ? AND b.agent_id = ? AND NOT EXISTS (SELECT 1 FROM proposal_responses r WHERE r.proposal_id = k.proposal_id)`,
      [viewer.networkId, viewer.userId],
    );
    const tasks: OfferTask[] = [
      ...rows.map((r) => ({ offerId: r.offer_id, proposalId: null, propertyId: r.property_id, lastDay: r.last_day, createdAt: r.created_at })),
      ...proposalRows.map((r) => ({ offerId: r.offer_id, proposalId: r.proposal_id, propertyId: r.property_id, lastDay: r.last_day, createdAt: r.created_at })),
    ].sort((a, b) => (a.lastDay < b.lastDay ? -1 : a.lastDay > b.lastDay ? 1 : a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
    return { ok: true, tasks };
  }
}
