/**
 * Le suivi de valeur (M20, G04). Un propriétaire qui l'a demandé, avec son accord enregistré pour ce suivi, reçoit à
 * intervalle réglé la fourchette de prix au m² de sa commune, jamais le prix de son bien [R31], avec la date des
 * données [R28]. Chaque envoi passe par le contrôle central (S06) : heures d'envoi [R01], exclusions [R02], accord pour
 * ce suivi [R03], arrêt [R04], un envoi par période [R05] ; seuls les canaux du mode essai sont branchés, rien ne
 * part [R26]. Quand il répond qu'il pense à vendre, son agent est alerté et le plan du jour le porte en tête des
 * rendez-vous à proposer. Le journal ne porte ni texte ni coordonnée [R13]. Rien ne s'efface [R17].
 */
import type { Acces } from '../acces/acces.ts';
import type { Viewer } from '../acces/droits.ts';
import type { ScheduledJob } from '../bascule/planificateur.ts';
import { trialChannels } from '../captation/essai.ts';
import { FicheClient } from '../db/fiche-client.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { ControleEnvois } from '../envoi/controle.ts';
import { SqlSendJournal } from '../envoi/journal-envois.ts';
import { DecisionEnvoi } from '../envoi/service.ts';
import type { CommuneResult } from '../estimation/en-ligne.ts';
import type { EstimatedKind } from '../estimation/fourchette.ts';
import { FicheUnique } from '../fiche/fusion.ts';
import { ficheFirstName } from '../fiche/prenom.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import { plain } from '../envoi/texte.ts';

/** Finalité de l'accord du suivi de valeur [R03]. */
export const VALUE_TRACKING_PURPOSE = 'value_tracking';
export const VALUE_TRACKING_JOB = 'mandats.suivi_valeur';
export const VALUE_TRACKING_HOURS: readonly number[] = Object.freeze([9, 10, 11, 12, 13, 14, 15, 16, 17, 18]);
export const VALUE_TRACKING_WEEKDAYS: readonly number[] = Object.freeze([1, 2, 3, 4, 5, 6]);

export type TrackingChannel = 'email' | 'sms' | 'whatsapp';
export const TRACKING_CHANNELS: readonly TrackingChannel[] = ['email', 'sms', 'whatsapp'];

/** La fourchette de la commune : l'estimation en ligne du site (E05) la donne. */
export interface CommuneRanges {
  forTown(postalCode: string, town: string, kind: EstimatedKind): Promise<CommuneResult>;
}

export interface ValueTrackingSettings {
  /** Jours entre deux envois. Réglage de départ : six mois. */
  intervalDays: number;
  /** Suivis traités au plus par passage. */
  batch: number;
}

export const DEFAULT_VALUE_TRACKING_SETTINGS: ValueTrackingSettings = Object.freeze({ intervalDays: 182, batch: 50 });

export interface ValueTrackingOptions {
  now?: () => Date;
  newId?: () => string;
  settings?: ValueTrackingSettings;
  /** Absente : aucun envoi n'est préparé, seules les réponses sont lues. */
  ranges?: CommuneRanges | null;
}

export interface Enrolment {
  personId: string;
  postalCode: string;
  town: string;
  kind: EstimatedKind;
  channel: TrackingChannel;
}

export type EnrolResult =
  | { ok: true; id: string; already: boolean }
  | { ok: false; rule: 'R03'; code: 'no_consent' }
  | { ok: false; rule: 'R16'; code: string }
  | { ok: false; rule: null; code: 'bad_input' | 'no_agent' };

export type TrackingStatus = 'waiting' | 'sent' | 'refused' | 'failed' | 'no_data';

export interface TrackingOutcome {
  trackingId: string;
  period: number;
  status: TrackingStatus;
  rule: string | null;
  /** Toujours faux : en mode essai, rien ne part [R26]. */
  delivered: false;
}

interface TrackingRow {
  id: string;
  network_id: string;
  agent_id: string | null;
  person_id: string;
  postal_code: string;
  town: string;
  kind: EstimatedKind;
  channel: TrackingChannel;
  created_at: string;
}

/**
 * La personne dit penser à vendre : une intention positive, à la première personne, sans aucune négation dans le
 * message. Dans le doute, pas d'alerte : l'agent ne démarche jamais quelqu'un qui a dit non. Règles fixes, sans IA.
 */
const SELLING_INTENT =
  /\b(je|j|nous|on)\s+(pense|pensons|envisage|envisageons|souhaite|souhaitons|voudrais|voudrions|veux|voulons|aimerais|aimerions|compte|comptons|vais|allons|songe|songeons|reflechis|reflechissons|prevois|prevoyons)\s+(serieusement\s+|bien\s+|peut etre\s+)?(a|de|d)?\s*(vendre|mettre en vente|la vente)\b|\b(je suis|nous sommes|on est)\s+(pret|prets|prete|pretes)\s+a\s+vendre\b|\bmettre (ma|mon|notre|nos) \S+ en vente\b/;
const NEGATION = /\b(ne|n)\b[^.!?]{0,40}\b(pas|plus|jamais|point|guere)\b|\bpas (question|du tout|maintenant|pour l instant|pour le moment|encore)\b|\bhors de question\b|\baucune(ment)?\b|\bnon merci\b|\bjamais\b|\bstop\b/;

export function saysSellingIntent(text: string): boolean {
  const p = plain(text).replace(/[^a-z0-9]+/g, ' ');
  return SELLING_INTENT.test(p) && !NEGATION.test(p);
}

const DAY = 86_400_000;
const placeholders = (n: number): string => Array.from({ length: n }, () => '?').join(', ');
const MONTHS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
const KIND_LABEL: Readonly<Record<EstimatedKind, string>> = Object.freeze({ house: 'des maisons', apartment: 'des appartements' });

const euros = (n: number): string => `${new Intl.NumberFormat('fr-FR').format(n).replace(/[  ]/g, ' ')} €`;
function monthLabel(month: string): string {
  const [y, m] = month.split('-');
  return `${MONTHS[Number(m) - 1] ?? ''} ${y}`;
}

/**
 * Le texte du suivi, sans IA : la fourchette de la commune, jamais un prix du bien [R31], la date des données [R28],
 * vouvoiement avec le prénom [R08]. Rend le texte et les chiffres qu'il cite, tous tirés de la fourchette [R10].
 */
export function valueTrackingText(firstName: string | null, town: string, kind: EstimatedKind, range: Extract<CommuneResult, { ok: true }>['value']): { text: string; figures: string[] } {
  const hello = firstName ? `Bonjour ${firstName},` : 'Bonjour,';
  const low = euros(range.perM2.low);
  const high = euros(range.perM2.high);
  const median = euros(range.perM2.median);
  const until = monthLabel(range.data.lastSale.slice(0, 7));
  const recent = range.data.recentMissing ? ' Les ventes les plus récentes ne sont pas encore publiées.' : '';
  const text =
    `${hello} comme convenu, voici la valeur ${KIND_LABEL[kind]} à ${town} : de ${low} à ${high} le m², ${median} au milieu, ` +
    `d’après les ventes publiées jusqu’en ${until}.${recent} Pour le prix de votre bien, je peux passer le voir quand vous le souhaitez.`;
  return { text, figures: [low, high, median, until] };
}

export class SuiviDeValeur {
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly settings: ValueTrackingSettings;
  private readonly ranges: CommuneRanges | null;
  private readonly fiche: FicheUnique;
  private readonly controle: ControleEnvois;

  constructor(
    private readonly db: SqlDatabase,
    private readonly journal: JournalStore,
    options: ValueTrackingOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => crypto.randomUUID());
    this.settings = options.settings ?? DEFAULT_VALUE_TRACKING_SETTINGS;
    this.ranges = options.ranges ?? null;
    const store = new FicheClient(db, { now: this.now });
    this.fiche = new FicheUnique(db, store, { now: this.now });
    const decisions = new DecisionEnvoi(db, store, this.fiche, { now: this.now });
    // Seuls les canaux du mode essai : aucun vrai canal ne peut être passé de l'extérieur [R26].
    this.controle = new ControleEnvois(db, this.fiche, decisions, {
      channels: trialChannels(db, journal, this.now),
      journal: new SqlSendJournal(db, undefined, this.now),
      now: this.now,
    });
  }

  /**
   * Inscrit un propriétaire au suivi de valeur, seulement avec son accord en cours pour ce suivi sur ce canal [R03] ;
   * par l'agent qui suit la fiche ou la direction [R16]. Une seule inscription par fiche.
   */
  async enrol(acces: Acces, viewer: Viewer, input: Enrolment): Promise<EnrolResult> {
    if (
      !TRACKING_CHANNELS.includes(input.channel) ||
      (input.kind !== 'house' && input.kind !== 'apartment') ||
      !/^\d{5}$/.test(input.postalCode) ||
      input.town.trim() === '' ||
      input.town.length > 80
    ) {
      return { ok: false, rule: null, code: 'bad_input' };
    }
    if (viewer.role !== 'agent' && viewer.role !== 'direction') {
      await appendEvent(this.journal, { type: 'acces.refuse', actor: `${String(viewer.role)}:${viewer.userId}`, subject: null, data: { rule: 'R16', role: String(viewer.role), kind: 'value_tracking', code: 'role' } }, this.now);
      return { ok: false, rule: 'R16', code: 'role' };
    }
    const read = await acces.readFiche(viewer, input.personId);
    if (!read.ok) return read;
    if (read.view !== 'full') return { ok: false, rule: 'R16', code: 'not_assigned' };
    const ids = read.value.members.map((m) => m.id);
    const root = read.value.person.id;
    const agentId = read.value.members.map((m) => m.agent_id).find((a) => a !== null) ?? null;
    if (agentId === null) return { ok: false, rule: null, code: 'no_agent' };
    if (!(await this.consented(ids, input.channel))) return { ok: false, rule: 'R03', code: 'no_consent' };
    const known = await this.db.first<{ id: string }>(`SELECT id FROM value_tracking WHERE person_id IN (${placeholders(ids.length)}) LIMIT 1`, ids);
    if (known) return { ok: true, id: known.id, already: true };
    const id = this.newId();
    const { changes } = await this.db.run(
      `INSERT INTO value_tracking (id, network_id, agent_id, person_id, postal_code, town, kind, channel, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
      [id, viewer.networkId, agentId, root, input.postalCode, input.town.trim(), input.kind, input.channel, `${viewer.role}:${viewer.userId}`, this.now().toISOString()],
    );
    if (changes !== 1) {
      const again = await this.db.first<{ id: string }>('SELECT id FROM value_tracking WHERE person_id = ?', [root]);
      return { ok: true, id: again?.id ?? id, already: true };
    }
    await appendEvent(this.journal, { type: 'suivi_valeur.inscrit', actor: `${viewer.role}:${viewer.userId}`, subject: `person:${root}`, data: { tracking: id, channel: input.channel } }, this.now);
    return { ok: true, id, already: false };
  }

  /** Un passage : d'abord les réponses, puis les envois dus. */
  async run(): Promise<{ alerts: number; outcomes: TrackingOutcome[] }> {
    const alerts = await this.readAnswers();
    const outcomes = this.ranges ? await this.sendDue(this.ranges) : [];
    return { alerts, outcomes };
  }

  /**
   * Les réponses reçues après un envoi du suivi : une réponse qui dit penser à vendre alerte l'agent, une fois par
   * message. Le texte n'est lu que par les règles fixes de classement, jamais gardé ailleurs ni écrit au journal.
   */
  async readAnswers(): Promise<number> {
    const tracked = await this.db.all<{ id: string; network_id: string; person_id: string; first_sent: string }>(
      `SELECT t.id, t.network_id, t.person_id, min(s.sent_at) AS first_sent FROM value_tracking t
       JOIN value_tracking_sends s ON s.tracking_id = t.id AND s.status = 'sent' GROUP BY t.id, t.network_id, t.person_id`,
    );
    let created = 0;
    for (const t of tracked) {
      const ids = await this.fiche.membersOf(t.person_id);
      const answers = await this.db.all<{ id: string; body: string }>(
        `SELECT m.id, m.body FROM messages m WHERE m.person_id IN (${placeholders(ids.length)}) AND m.direction = 'in' AND m.occurred_at > ?
         AND NOT EXISTS (SELECT 1 FROM value_tracking_alerts a WHERE a.message_id = m.id) ORDER BY m.occurred_at, m.id`,
        [...ids, t.first_sent],
      );
      for (const answer of answers) {
        if (!saysSellingIntent(answer.body)) continue;
        const id = this.newId();
        const { changes } = await this.db.run(
          `INSERT INTO value_tracking_alerts (id, tracking_id, network_id, person_id, message_id, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
          [id, t.id, t.network_id, t.person_id, answer.id, this.now().toISOString()],
        );
        if (changes !== 1) continue;
        created += 1;
        await appendEvent(this.journal, { type: 'suivi_valeur.alerte', actor: 'system:planificateur', subject: `person:${t.person_id}`, data: { tracking: t.id, alert: id } }, this.now);
      }
    }
    return created;
  }

  private async sendDue(ranges: CommuneRanges): Promise<TrackingOutcome[]> {
    const at = this.now();
    const interval = this.settings.intervalDays * DAY;
    // Les suivis jamais essayés d'abord, puis le plus ancien essai : un suivi qui attend sa source ne bloque pas les autres.
    const rows = await this.db.all<TrackingRow>(
      `SELECT t.* FROM value_tracking t
       LEFT JOIN (SELECT tracking_id, max(updated_at) AS last FROM value_tracking_sends GROUP BY tracking_id) s ON s.tracking_id = t.id
       WHERE t.created_at <= ? ORDER BY s.last IS NOT NULL, s.last, t.created_at, t.id`,
      [new Date(at.getTime() - interval).toISOString()],
    );
    const outcomes: TrackingOutcome[] = [];
    let failure: unknown = null;
    // Chaque essai réservé compte, panne comprise : une source en panne ne multiplie pas les appels.
    let attempts = 0;
    for (const row of rows) {
      if (attempts >= this.settings.batch) break;
      const period = Math.floor((at.getTime() - Date.parse(row.created_at)) / interval);
      if (period < 1) continue;
      // Une panne sur un suivi n'arrête pas les autres ; elle remonte ensuite au planificateur, jamais avalée [R13].
      try {
        const outcome = await this.sendOne(row, period, ranges, at);
        if (outcome) {
          outcomes.push(outcome);
          attempts += 1;
        }
      } catch (error) {
        attempts += 1;
        failure ??= error;
      }
    }
    if (failure !== null) throw failure;
    return outcomes;
  }

  private async sendOne(row: TrackingRow, period: number, ranges: CommuneRanges, at: Date): Promise<TrackingOutcome | null> {
    const stamp = at.toISOString();
    // Réserver la période avant tout envoi : deux passages en même temps n'en font qu'un [R05].
    const inserted = await this.db.run(
      `INSERT INTO value_tracking_sends (tracking_id, period, status, mode, updated_at) VALUES (?, ?, 'pending', 'essai', ?) ON CONFLICT DO NOTHING`,
      [row.id, period, stamp],
    );
    const claimed =
      inserted.changes === 1 ||
      (await this.db.run(`UPDATE value_tracking_sends SET status = 'pending', updated_at = ? WHERE tracking_id = ? AND period = ? AND status = 'waiting'`, [stamp, row.id, period])).changes === 1;
    if (!claimed) return null;
    try {
      return await this.afterClaim(row, period, ranges);
    } catch (error) {
      // Une panne après la réservation ne perd pas l'envoi : il repart au créneau suivant ; le sujet garde
      // l'anti-doublon du contrôle central [R05].
      await this.db.run(`UPDATE value_tracking_sends SET status = 'waiting', updated_at = ? WHERE tracking_id = ? AND period = ? AND status = 'pending'`, [
        this.now().toISOString(),
        row.id,
        period,
      ]);
      throw error;
    }
  }

  private async afterClaim(row: TrackingRow, period: number, ranges: CommuneRanges): Promise<TrackingOutcome> {
    const ids = await this.fiche.membersOf(row.person_id);
    let status: TrackingStatus;
    let rule: string | null = null;
    let messageId: string | null = null;
    // Sans accord en cours pour ce suivi, rien n'est préparé : le contrôle central le refuserait de toute façon [R03].
    if (!(await this.consented(ids, row.channel))) {
      status = 'refused';
      rule = 'R03';
    } else {
      const range = await ranges.forTown(row.postal_code, row.town, row.kind);
      if (!range.ok) {
        // Données absentes pour l'heure (source indisponible) : la période est reprise au passage suivant ; un manque
        // durable (peu de ventes, hors zone) vaut pour la période.
        status = range.reason === 'donnees_absentes' ? 'waiting' : 'no_data';
      } else {
        const firstName = await ficheFirstName(this.db, ids);
        const { text, figures } = valueTrackingText(firstName, range.value.town, row.kind, range.value);
        const result = await this.controle.send({
          networkId: row.network_id,
          agentId: row.agent_id,
          personId: row.person_id,
          channel: row.channel,
          kind: 'follow_up',
          purpose: VALUE_TRACKING_PURPOSE,
          subject: `suivi_valeur:${row.id}:${period}`,
          fallbackTexts: [text],
          figures,
        });
        rule = result.status === 'sent' ? null : result.rule;
        messageId = result.messageId;
        // Refusé pour l'heure seulement [R01] : repris au créneau suivant. Tout autre refus vaut pour la période.
        status = result.status === 'sent' ? 'sent' : result.status === 'failed' ? 'failed' : result.rule === 'R01' ? 'waiting' : 'refused';
      }
    }
    await this.db.run(`UPDATE value_tracking_sends SET status = ?, rule = ?, message_id = ?, sent_at = ?, updated_at = ? WHERE tracking_id = ? AND period = ?`, [
      status,
      rule,
      messageId,
      status === 'sent' ? this.now().toISOString() : null,
      this.now().toISOString(),
      row.id,
      period,
    ]);
    await appendEvent(
      this.journal,
      { type: 'suivi_valeur.essai', actor: 'system:planificateur', subject: `person:${row.person_id}`, data: { mode: 'essai', sent: false, tracking: row.id, period, status, rule } },
      this.now,
    );
    return { trackingId: row.id, period, status, rule, delivered: false };
  }

  private async consented(ids: readonly string[], channel: TrackingChannel): Promise<boolean> {
    const at = this.now().toISOString();
    const row = await this.db.first<{ n: number }>(
      `SELECT count(*) AS n FROM consents WHERE person_id IN (${placeholders(ids.length)}) AND purpose = ? AND channel = ?
       AND given_at <= ? AND (withdrawn_at IS NULL OR withdrawn_at > ?)`,
      [...ids, VALUE_TRACKING_PURPOSE, channel, at, at],
    );
    return Number(row?.n ?? 0) > 0;
  }
}

/** La tâche du planificateur : le suivi de valeur, en mode essai. */
export function valueTrackingJob(db: SqlDatabase, journal: JournalStore, options: ValueTrackingOptions = {}): ScheduledJob {
  return {
    name: VALUE_TRACKING_JOB,
    hours: VALUE_TRACKING_HOURS,
    weekdays: VALUE_TRACKING_WEEKDAYS,
    run: async () => {
      await new SuiviDeValeur(db, journal, options).run();
    },
  };
}
