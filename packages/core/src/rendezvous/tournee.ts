/**
 * Les visites enchaînées et la tournée partagée (M05, V07).
 *
 * Visites enchaînées : pour des biens d'un même secteur, le code propose un ordre et des créneaux le même jour, chacun
 * libre (dans les disponibilités de l'agent et hors de ses événements occupés [R33], sans chevaucher un rendez-vous,
 * trajet compris [R32]), et qui s'enchaînent entre eux en laissant le temps de trajet [R32]. Les biens d'une même
 * commune se suivent. C'est une proposition : rien n'est réservé.
 *
 * Tournée partagée : l'agent, lui seul et seulement quand il le demande, envoie sa tournée du jour à un proche ou à
 * son accompagnateur, par le contrôle central et les seuls canaux du mode essai [R26]. Le proche est une fiche du
 * réseau, avec son accord pour la tournée [R03]. Le texte ne porte que les heures et les communes, jamais d'adresse
 * exacte, de référence ni de nom de client [R09]. Le journal ne porte ni texte ni commune [R13].
 */
import type { SqlDatabase } from '../db/sql.ts';
import type { OutboundChannelName } from '../db/types.ts';
import type { Viewer } from '../acces/droits.ts';
import { FicheClient } from '../db/fiche-client.ts';
import { FicheUnique } from '../fiche/fusion.ts';
import { DecisionEnvoi } from '../envoi/service.ts';
import { ControleEnvois, type SendResult } from '../envoi/controle.ts';
import { SqlSendJournal } from '../envoi/journal-envois.ts';
import { localTime } from '../envoi/horaires.ts';
import { trialChannels } from '../captation/essai.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import { AGENDA_TIME_ZONE, DEFAULT_SLOT_SETTINGS, isOnSite, parisInstant, type Slot, type SlotSettings } from './creneaux.ts';
import { RendezVous, appointmentWhen, type RendezVousOptions } from './reservation.ts';

/** La finalité de l'accord du proche qui reçoit la tournée [R03]. */
export const ROUTE_SHARE_PURPOSE = 'route_share';

export interface ChainedVisit {
  propertyId: string;
  /** La commune du bien, telle qu'en base ; `null` si elle manque. */
  town: string | null;
  start: Date;
  end: Date;
}

export type VisitChainResult =
  | { ok: true; visits: ChainedVisit[] }
  | { ok: false; code: 'not_agent' | 'bad_date' | 'no_property' | 'too_many' | 'unknown_property' | 'no_room' };

export type ShareResult =
  | { ok: true; count: number; send: Pick<SendResult, 'status' | 'rule'> }
  | { ok: false; code: 'not_agent' | 'bad_date' | 'unknown_recipient' | 'empty' };

export interface TourneeOptions extends Pick<RendezVousOptions, 'now' | 'agenda' | 'settings'> {
  /** Visites enchaînées au plus. */
  maxVisits?: number;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MINUTE = 60_000;

const nextDate = (date: string): string => {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
};
const validDate = (date: string): boolean => {
  if (!DATE.test(date)) return false;
  const d = new Date(`${date}T12:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === date;
};

/**
 * Le premier enchaînement de `count` créneaux libres, chacun commençant après la fin du précédent plus le trajet
 * (sur place). Les créneaux donnés sont libres un à un ; l'écart les garde libres ensemble [R32].
 */
export function chainSlots(free: readonly Slot[], count: number, settings: SlotSettings = DEFAULT_SLOT_SETTINGS): Slot[] | null {
  if (count < 1) return null;
  const sorted = [...free].sort((a, b) => a.start.getTime() - b.start.getTime());
  for (let i = 0; i < sorted.length; i++) {
    const chain: Slot[] = [sorted[i]!];
    for (let j = i + 1; j < sorted.length && chain.length < count; j++) {
      const last = chain[chain.length - 1]!;
      const gap = isOnSite(last.kind) || isOnSite(sorted[j]!.kind) ? settings.travelMinutes * MINUTE : 0;
      if (sorted[j]!.start.getTime() >= last.end.getTime() + gap) chain.push(sorted[j]!);
    }
    if (chain.length === count) return chain;
  }
  return null;
}

/** Le texte de la tournée : les heures et les communes, rien d'autre [R09] ; le prénom du proche s'il est connu [R08]. */
export function routeText(date: Date, stops: readonly { start: Date; town: string | null }[], firstName: string | null = null): { text: string; figures: number[] } {
  const day = appointmentWhen(date).text.replace(/ à .*$/, '');
  const figures = new Set<number>(appointmentWhen(date).figures.slice(0, 1));
  const parts = stops.map((s) => {
    const l = localTime(s.start, AGENDA_TIME_ZONE);
    const h = Math.floor(l.minutes / 60);
    const m = l.minutes % 60;
    figures.add(h);
    figures.add(m);
    return `${m === 0 ? `${h} h` : `${h} h ${String(m).padStart(2, '0')}`} à ${s.town ?? 'commune non précisée'}`;
  });
  return { text: `${firstName ? `Bonjour ${firstName},` : 'Bonjour,'} voici ma tournée du ${day.replace(/^le /, '')} : ${parts.join(' ; ')}.`, figures: [...figures] };
}

export class TourneeRendezVous {
  private readonly now: () => Date;
  private readonly settings: SlotSettings;
  private readonly maxVisits: number;
  private readonly rdv: RendezVous;
  private readonly controle: ControleEnvois;

  constructor(
    private readonly db: SqlDatabase,
    private readonly journal: JournalStore,
    options: TourneeOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.settings = options.settings ?? DEFAULT_SLOT_SETTINGS;
    this.maxVisits = options.maxVisits ?? 8;
    this.rdv = new RendezVous(db, journal, { now: this.now, settings: this.settings, ...(options.agenda ? { agenda: options.agenda } : {}) });
    const store = new FicheClient(db, { now: this.now });
    const fiche = new FicheUnique(db, store, { now: this.now });
    const decisions = new DecisionEnvoi(db, store, fiche, { now: this.now });
    // Seuls les canaux du mode essai : aucun vrai canal ne peut être passé de l'extérieur [R26].
    this.controle = new ControleEnvois(db, fiche, decisions, {
      channels: trialChannels(db, journal, this.now),
      journal: new SqlSendJournal(db, undefined, this.now),
      now: this.now,
    });
  }

  private async activeAgent(viewer: Viewer): Promise<boolean> {
    if (viewer.role !== 'agent') return false;
    return !!(await this.db.first<{ id: string }>("SELECT id FROM agents WHERE id = ? AND network_id = ? AND status = 'active'", [viewer.userId, viewer.networkId]));
  }

  /** Propose un ordre et des créneaux de visite, le même jour, pour des biens du réseau. Rien n'est réservé. */
  async proposeChain(viewer: Viewer, date: string, propertyIds: readonly string[]): Promise<VisitChainResult> {
    if (!(await this.activeAgent(viewer))) return { ok: false, code: 'not_agent' };
    if (!validDate(date)) return { ok: false, code: 'bad_date' };
    const ids = [...new Set(propertyIds)];
    if (ids.length === 0) return { ok: false, code: 'no_property' };
    if (ids.length > this.maxVisits) return { ok: false, code: 'too_many' };
    const properties: { id: string; postal_code: string | null; city: string | null }[] = [];
    for (const id of ids) {
      const p = await this.db.first<{ id: string; postal_code: string | null; city: string | null }>('SELECT id, postal_code, city FROM properties WHERE id = ? AND network_id = ?', [
        id,
        viewer.networkId,
      ]);
      if (!p) return { ok: false, code: 'unknown_property' };
      properties.push(p);
    }
    // Les biens d'une même commune se suivent, dans l'ordre où chaque commune paraît d'abord.
    const key = (p: { postal_code: string | null; city: string | null }) => `${p.postal_code ?? ''}|${(p.city ?? '').trim().toLowerCase()}`;
    const order: string[] = [];
    for (const p of properties) if (!order.includes(key(p))) order.push(key(p));
    const ordered = order.flatMap((k) => properties.filter((p) => key(p) === k));
    const from = parisInstant(date, 0);
    const to = parisInstant(nextDate(date), 0);
    if (!from || !to) return { ok: false, code: 'bad_date' };
    const free = await this.rdv.freeSlotsFor(viewer.userId, 'visite', from, to);
    const chain = chainSlots(free, ordered.length, this.settings);
    if (!chain) return { ok: false, code: 'no_room' };
    return { ok: true, visits: ordered.map((p, i) => ({ propertyId: p.id, town: p.city?.trim() || null, start: chain[i]!.start, end: chain[i]!.end })) };
  }

  /** L'agent envoie sa tournée du jour à un proche, à sa demande seulement, par le contrôle central (mode essai). */
  async shareDay(viewer: Viewer, date: string, recipientId: string, channel: OutboundChannelName): Promise<ShareResult> {
    if (!(await this.activeAgent(viewer))) return { ok: false, code: 'not_agent' };
    if (!validDate(date)) return { ok: false, code: 'bad_date' };
    const recipient = await this.db.first<{ id: string; first_name: string | null }>('SELECT id, first_name FROM persons WHERE id = ? AND network_id = ?', [recipientId, viewer.networkId]);
    if (!recipient) return { ok: false, code: 'unknown_recipient' };
    const from = parisInstant(date, 0);
    const to = parisInstant(nextDate(date), 0);
    if (!from || !to) return { ok: false, code: 'bad_date' };
    const rows = await this.db.all<{ kind: string; start_at: string; city: string | null }>(
      `SELECT a.kind, a.start_at, p.city FROM appointments a LEFT JOIN properties p ON p.id = a.property_id
       WHERE a.agent_id = ? AND a.network_id = ? AND a.status = 'booked' AND a.start_at >= ? AND a.start_at < ?
       ORDER BY a.start_at, a.id`,
      [viewer.userId, viewer.networkId, from.toISOString(), to.toISOString()],
    );
    // La tournée, ce sont les déplacements : les rendez-vous par téléphone n'y sont pas.
    const stops = rows.filter((r) => r.kind !== 'appel').map((r) => ({ start: new Date(r.start_at), town: r.city?.trim() || null }));
    if (stops.length === 0) return { ok: false, code: 'empty' };
    const { text, figures } = routeText(from, stops, recipient.first_name?.trim() || null);
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    const short = [...new Uint8Array(digest)].slice(0, 6).map((b) => b.toString(16).padStart(2, '0')).join('');
    const sent = await this.controle.send({
      networkId: viewer.networkId,
      agentId: viewer.userId,
      personId: recipientId,
      channel,
      kind: 'alert',
      purpose: ROUTE_SHARE_PURPOSE,
      // La même tournée ne part qu'une fois au même proche ; une tournée changée peut repartir [R05].
      subject: `tournee:${viewer.userId}:${date}:${short}`,
      fallbackTexts: [text],
      figures,
    });
    await appendEvent(
      this.journal,
      {
        type: 'rdv.tournee.essai',
        actor: `agent:${viewer.userId}`,
        subject: `agent:${viewer.userId}`,
        data: { mode: 'essai', sent: false, stops: stops.length, status: sent.status, rule: sent.rule },
      },
      this.now,
    );
    return { ok: true, count: stops.length, send: { status: sent.status, rule: sent.rule } };
  }
}
