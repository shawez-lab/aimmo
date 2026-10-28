/**
 * Rapport du matin, chaque jour ouvré à 7 h 30 (M13, K06) [R13, R14, R16, R18, R68, R69].
 *
 * Chaque jour ouvré (du lundi au vendredi, hors jours fériés), à 7 h 30, heure de Paris, le code range un rapport pour
 * la direction de chaque réseau et pour chaque agent actif : les chiffres de la période écoulée depuis le jour ouvré
 * précédent jusqu'à la veille (le lundi : vendredi, samedi et dimanche), les contacts chauds à rappeler, les alertes, en
 * quelques lignes écrites par le code, sans IA. Les chiffres sont ceux des tableaux de bord (K04, K05). Un agent n'a
 * que les siens [R68] ; un seul rapport par lecteur et par jour, même si le planificateur repasse [R18]. Rien n'est
 * envoyé : le rapport se lit dans l'application.
 */
import { Acces } from '../acces/acces.ts';
import type { Viewer } from '../acces/droits.ts';
import { FicheClient } from '../db/fiche-client.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { isWorkingDay, localTime } from '../envoi/horaires.ts';
import { FicheUnique } from '../fiche/fusion.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import type { ScheduledJob } from '../bascule/planificateur.ts';
import { Rappels } from '../qualification/rappel.ts';
import { TableauAgent, type AgentDashboard } from './tableau-agent.ts';
import { TableauReseau, type Counts } from './tableau-reseau.ts';

const TIME_ZONE = 'Europe/Paris';
export const MORNING_REPORT_JOB = 'pilotage.rapport_matin';
export const MORNING_REPORT_HOUR = 7;
export const MORNING_REPORT_MINUTE = 30;

const addDays = (day: string, n: number): string => new Date(Date.parse(`${day}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const weekdayOf = (day: string): number => {
  const w = new Date(`${day}T12:00:00Z`).getUTCDay();
  return w === 0 ? 7 : w;
};

/** La période d'un rapport du jour `day` : du lendemain du jour ouvré précédent jusqu'à la veille. */
export function reportPeriod(day: string): { from: string; to: string } {
  const to = addDays(day, -1);
  let previous = to;
  for (let i = 0; i < 14; i += 1) {
    if (isWorkingDay({ date: previous, weekday: weekdayOf(previous), minutes: 0 })) break;
    previous = addDays(previous, -1);
  }
  // Le jour ouvré précédent est lui-même compris : le lundi couvre vendredi, samedi et dimanche.
  return { from: previous, to };
}

const euros = (cents: number): string => `${(cents / 100).toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`.replace(/ | /g, ' ');
const plural = (n: number, one: string, many: string) => `${n} ${n > 1 ? many : one}`;

function countsText(c: Counts): string {
  return `${plural(c.contacts, 'contact', 'contacts')}, ${plural(c.appointments, 'rendez-vous tenu', 'rendez-vous tenus')}, ${plural(c.mandates, 'mandat signé', 'mandats signés')}, ${plural(c.sales, 'vente', 'ventes')}`;
}

const periodText = (p: { from: string; to: string }): string => (p.from === p.to ? 'Hier' : `Du ${p.from.slice(8, 10)}/${p.from.slice(5, 7)} au ${p.to.slice(8, 10)}/${p.to.slice(5, 7)}`);

export interface MorningReport {
  day: string;
  period: { from: string; to: string };
  text: string;
  content: Record<string, unknown>;
}

export class RapportMatin {
  private readonly now: () => Date;

  constructor(
    private readonly db: SqlDatabase,
    private readonly journal: JournalStore,
    options: { now?: () => Date } = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  private async store(networkId: string, reader: string, day: string, period: { from: string; to: string }, content: Record<string, unknown>, text: string): Promise<boolean> {
    const { changes } = await this.db.run(
      'INSERT INTO morning_reports (network_id, reader, day, period_from, period_to, content, text, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING',
      [networkId, reader, day, period.from, period.to, JSON.stringify(content), text, this.now().toISOString()],
    );
    return changes === 1;
  }

  /** Le passage d'un réseau : rien un jour non ouvré ; sinon un rapport par lecteur, une fois. Rend le nombre rangé. */
  async run(networkId: string): Promise<number> {
    const local = localTime(this.now(), TIME_ZONE);
    if (!isWorkingDay(local)) return 0;
    const day = local.date;
    const period = reportPeriod(day);
    let made = 0;
    const store = new FicheClient(this.db, { now: this.now });
    const fiche = new FicheUnique(this.db, store, { now: this.now });
    const acces = new Acces(this.db, store, fiche, this.journal, { now: this.now });
    const rappels = new Rappels(this.db, fiche, this.journal, { now: this.now });
    const tableau = new TableauAgent(this.db, this.journal, { now: this.now });

    // La direction : les chiffres du réseau, les reversements en retard ou proches, les dossiers en attente.
    if (!(await this.db.first('SELECT 1 FROM morning_reports WHERE network_id = ? AND reader = ? AND day = ?', [networkId, 'direction', day]))) {
      const direction: Viewer = { role: 'direction', networkId, userId: 'system:rapport' };
      const net = await new TableauReseau(this.db, this.journal, { now: this.now }).of(direction, period);
      if (net.ok) {
        const payouts = (await this.db.first<{ n: number }>(
          'SELECT COUNT(DISTINCT a.file_id) AS n FROM commission_payout_alerts a JOIN commission_receipts r ON r.file_id = a.file_id WHERE r.network_id = ? AND NOT EXISTS (SELECT 1 FROM commission_payouts p WHERE p.file_id = a.file_id)',
          [networkId],
        ))!.n;
        const hot = await rappels.hotList(acces, direction);
        const hotCount = hot.ok ? hot.value.contacts.length : 0;
        const lines = [`${periodText(period)} : ${countsText(net.value.totals)}.`, `${plural(hotCount, 'contact chaud', 'contacts chauds')} gardés par la direction à rappeler.`];
        if (payouts > 0) lines.push(`Alerte : ${plural(payouts, 'reversement à faire', 'reversements à faire')} sous 24 h ouvrées.`);
        if (await this.store(networkId, 'direction', day, period, { totals: net.value.totals, hotContacts: hotCount, payoutAlerts: payouts }, lines.join('\n'))) made += 1;
      }
    }

    // Chaque agent actif : ses seuls chiffres, ses contacts chauds [R68].
    for (const a of await this.db.all<{ id: string }>("SELECT id FROM agents WHERE network_id = ? AND status = 'active' ORDER BY id", [networkId])) {
      const reader = `agent:${a.id}`;
      if (await this.db.first('SELECT 1 FROM morning_reports WHERE network_id = ? AND reader = ? AND day = ?', [networkId, reader, day])) continue;
      const viewer: Viewer = { role: 'agent', networkId, userId: a.id };
      const dash = await tableau.of(viewer, period);
      if (!dash.ok) continue;
      const d: AgentDashboard = dash.value;
      const hot = await rappels.hotList(acces, viewer);
      const hotCount = hot.ok ? hot.value.contacts.length : 0;
      const overdue = hot.ok ? hot.value.contacts.filter((c) => c.overdue).length : 0;
      const counts: Counts = { contacts: d.contacts.value, appointments: d.appointments.value, mandates: d.mandates.value, sales: d.sales.value };
      const lines = [`${periodText(period)} : ${countsText(counts)}.`, `${plural(hotCount, 'contact chaud', 'contacts chauds')} à rappeler.`];
      if (overdue > 0) lines.push(`Alerte : ${plural(overdue, 'rappel en retard', 'rappels en retard')}.`);
      if (d.upcomingFees.value > 0) lines.push(`Honoraires à venir : ${euros(d.upcomingFees.value)}.`);
      if (await this.store(networkId, reader, day, period, { counts, hotContacts: hotCount, overdue, upcomingFeesCents: d.upcomingFees.value }, lines.join('\n'))) made += 1;
    }
    if (made > 0) await appendEvent(this.journal, { type: 'pilotage.rapport_matin', actor: 'system:pilotage', subject: `network:${networkId}`, data: { day, count: made } }, this.now);
    return made;
  }

  /** Le rapport du jour du lecteur : un agent le sien, la direction celui du réseau [R16, R68]. */
  async read(viewer: Viewer, day?: string): Promise<{ ok: true; value: MorningReport | null } | { ok: false; rule: 'R16'; code: string }> {
    let reader: string | null = null;
    if (viewer.role === 'agent') {
      const me = await this.db.first<{ network_id: string; status: string }>('SELECT network_id, status FROM agents WHERE id = ?', [viewer.userId]);
      if (me && me.network_id === viewer.networkId && me.status === 'active') reader = `agent:${viewer.userId}`;
    } else if (viewer.role === 'direction') {
      reader = 'direction';
    }
    if (!reader) {
      await appendEvent(this.journal, { type: 'acces.refuse', actor: `${String(viewer.role)}:${viewer.userId}`, subject: `network:${viewer.networkId}`, data: { rule: 'R16', role: String(viewer.role), kind: 'morning_report', code: 'role' } }, this.now);
      return { ok: false, rule: 'R16', code: 'role' };
    }
    const target = day ?? localTime(this.now(), TIME_ZONE).date;
    const row = await this.db.first<{ day: string; period_from: string; period_to: string; content: string; text: string }>(
      'SELECT day, period_from, period_to, content, text FROM morning_reports WHERE network_id = ? AND reader = ? AND day = ?',
      [viewer.networkId, reader, target],
    );
    return { ok: true, value: row ? { day: row.day, period: { from: row.period_from, to: row.period_to }, text: row.text, content: JSON.parse(row.content) as Record<string, unknown> } : null };
  }
}

/** Le passage du planificateur : du lundi au vendredi à 7 h 30, heure de Paris ; un jour férié, rien. */
export function morningReportJob(db: SqlDatabase, journal: JournalStore, options: { now?: () => Date } = {}): ScheduledJob {
  return {
    name: MORNING_REPORT_JOB,
    hours: [MORNING_REPORT_HOUR],
    minute: MORNING_REPORT_MINUTE,
    weekdays: [1, 2, 3, 4, 5],
    run: async () => {
      const r = new RapportMatin(db, journal, options);
      for (const n of await db.all<{ id: string }>('SELECT id FROM networks ORDER BY id')) await r.run(n.id);
    },
  };
}
