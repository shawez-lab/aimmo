/**
 * Les jours limites de congé du bail commercial, en tâches de l'agent (AU101b) : la tâche quotidienne de M16 range une
 * tâche à l'agent du bien quand le jour limite d'un congé (échéance triennale ou fin du bail, par `leaseMilestones`)
 * approche, une seule par bien, sorte et jour limite. Rien n'est envoyé : la tâche est rangée pour les écrans [R10].
 * Une tâche ne se montre que tant que le jour limite est encore celui de la fiche et n'est pas passé.
 */
import type { Viewer } from '../acces/droits.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { localTime } from '../envoi/horaires.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import { leaseMilestones, type FicheCommerce } from './fiche.ts';

/** Combien de jours avant le jour limite la tâche est rangée. */
export const LEASE_TASK_ADVANCE_DAYS = 60;
export const LEASE_TASK_KINDS = ['conge_triennal', 'conge_fin'] as const;
export type LeaseTaskKind = (typeof LEASE_TASK_KINDS)[number];

export interface LeaseTask {
  propertyId: string;
  reference: string;
  kind: LeaseTaskKind;
  /** Le dernier jour pour donner congé. */
  deadline: string;
  /** L'échéance que ce congé vise. */
  expiry: string;
}

const addDays = (day: string, n: number): string => {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/** Les jours limites à venir d'une fiche, avec l'échéance que chacun vise. */
function deadlinesOf(sheet: Parameters<typeof leaseMilestones>[0], today: string): { kind: LeaseTaskKind; deadline: string; expiry: string }[] {
  const m = leaseMilestones(sheet, today);
  if (!m) return [];
  const out: { kind: LeaseTaskKind; deadline: string; expiry: string }[] = [];
  if (m.nextTriennial && m.triennialNoticeBy) out.push({ kind: 'conge_triennal', deadline: m.triennialNoticeBy, expiry: m.nextTriennial });
  if (!m.ended) out.push({ kind: 'conge_fin', deadline: m.endNoticeBy, expiry: m.leaseEnd });
  return out.filter((d) => d.deadline >= today);
}

export class TachesBail {
  private readonly now: () => Date;

  constructor(
    private readonly db: SqlDatabase,
    private readonly journal: JournalStore,
    private readonly fiches: FicheCommerce,
    options: { now?: () => Date } = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  private today(): string {
    return localTime(this.now(), 'Europe/Paris').date;
  }

  /** Range les tâches qui approchent pour les commerces d'un réseau ; rend le nombre de nouvelles tâches. */
  async run(networkId: string): Promise<number> {
    const today = this.today();
    const rows = await this.db.all<{ id: string; agent_id: string | null }>(
      "SELECT id, agent_id FROM properties WHERE network_id = ? AND kind IN ('business', 'business_walls', 'commercial') ORDER BY id",
      [networkId],
    );
    let created = 0;
    for (const p of rows) {
      if (!p.agent_id) continue;
      const sheet = await this.fiches.current(p.id);
      if (!sheet) continue;
      for (const d of deadlinesOf(sheet.sheet, today)) {
        if (addDays(d.deadline, -LEASE_TASK_ADVANCE_DAYS) > today) continue;
        const { changes } = await this.db.run(
          'INSERT INTO business_lease_tasks (property_id, network_id, agent_id, kind, deadline, expiry, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING',
          [p.id, networkId, p.agent_id, d.kind, d.deadline, d.expiry, this.now().toISOString()],
        );
        if (changes !== 1) continue;
        created += 1;
        // Le journal porte la sorte et le jour limite, aucun chiffre du bail [R13].
        await appendEvent(this.journal, { type: 'commerces.bail.tache', actor: 'system:commerces', subject: `property:${p.id}`, data: { kind: d.kind, day: d.deadline } }, this.now);
      }
    }
    return created;
  }

  /**
   * Les tâches de l'agent du bien, aujourd'hui (un bien repris passe ses tâches à son nouvel agent), encore utiles : jour
   * limite à venir et toujours celui de la fiche ; l'échéance montrée est celle de la fiche du jour. Chaque fiche lue
   * est écrite au journal avant d'être rendue [R16].
   */
  async tasksOf(viewer: Viewer): Promise<{ ok: true; value: LeaseTask[] } | { ok: false; rule: 'R16'; code: 'role' }> {
    if (viewer.role !== 'agent') return { ok: false, rule: 'R16', code: 'role' };
    const today = this.today();
    const rows = await this.db.all<{ property_id: string; reference: string; kind: LeaseTaskKind; deadline: string; expiry: string }>(
      `SELECT t.property_id, p.reference, t.kind, t.deadline, t.expiry FROM business_lease_tasks t JOIN properties p ON p.id = t.property_id
       WHERE t.network_id = ? AND p.network_id = t.network_id AND p.agent_id = ? AND t.deadline >= ? ORDER BY t.deadline, t.created_at`,
      [viewer.networkId, viewer.userId, today],
    );
    const out: LeaseTask[] = [];
    const read = new Set<string>();
    for (const r of rows) {
      if (!read.has(r.property_id)) {
        await appendEvent(this.journal, { type: 'commerces.bail.lu', actor: `agent:${viewer.userId}`, subject: `property:${r.property_id}`, data: { rule: 'R16', what: 'lease_tasks' } }, this.now);
        read.add(r.property_id);
      }
      const sheet = await this.fiches.current(r.property_id);
      const match = sheet ? deadlinesOf(sheet.sheet, today).find((d) => d.kind === r.kind && d.deadline === r.deadline) : undefined;
      if (match) out.push({ propertyId: r.property_id, reference: r.reference, kind: r.kind, deadline: match.deadline, expiry: match.expiry });
    }
    return { ok: true, value: out };
  }
}

