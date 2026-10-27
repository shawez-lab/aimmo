/**
 * Le point de la semaine au vendeur (M08, T07). Chaque lundi, le planificateur prépare, pour chaque mandat en cours,
 * le point de la semaine écoulée : vues de l'annonce par canal (P08), contacts reçus pour le bien (C03), visites faites
 * et prévues, avis des visiteurs (comptes rendus validés de T06). Chaque chiffre est lu dans la base ; une donnée
 * absente est écrite « non communiquée » ; jamais une baisse de prix, décision prise de vive voix avec l'agent [R53].
 * Aucun nom d'acquéreur [R52]. L'agent ajoute ses prochaines actions et valide ; le point part alors par le contrôle
 * central (boîte d'essai), une seule fois par mandat et par lundi [R18].
 *
 * Décidé, lecture prudente : le mandat est en cours quand la diffusion le permet, délai de rétractation compris ; les
 * vues sont « non communiquées » quand aucun canal n'en a rapporté pour la semaine ; l'avis d'un visiteur est son avis
 * validé, déjà sans nom ; le point est lu par le système comme le serait la mesure de P08 par la direction.
 */
import type { Acces } from '../acces/acces.ts';
import type { Viewer } from '../acces/droits.ts';
import { MesureBiens, mondayOf } from '../annonces/mesure.ts';
import type { ScheduledJob } from '../bascule/planificateur.ts';
import { trialChannels } from '../captation/essai.ts';
import { FicheClient } from '../db/fiche-client.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { Diffusion, type DiffusionDecision } from '../documents/retractation.ts';
import { ControleEnvois } from '../envoi/controle.ts';
import { SqlSendJournal } from '../envoi/journal-envois.ts';
import { DecisionEnvoi } from '../envoi/service.ts';
import { plain } from '../envoi/texte.ts';
import { FicheUnique } from '../fiche/fusion.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import { SELLER_UPDATE_PURPOSE, type VisitReport } from './compte-rendu.ts';

/** Les tournures d'une baisse de prix, liste fermée : refusées partout dans le point [R53]. */
export const PRICE_DROP = /\b(?:baisse|baisser|baissons|diminu\w*|reduire|reduction|revoir le prix|revoir a la baisse|ajuster le prix|ajustement du prix|repositionn\w*|prix trop eleve|prix trop haut|rabais|remise)\b/;

export interface WeeklyFigures {
  week: string;
  /** null : aucun canal n'a rapporté de vues pour la semaine. */
  views: number | null;
  contacts: number;
  visitsDone: number;
  visitsPlanned: number;
  opinions: string[];
}

export type PointRefusal = { ok: false; rule: string | null; code: string };

const addDays = (day: string, n: number): string => new Date(Date.parse(`${day}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const number = (n: number): string => new Intl.NumberFormat('fr-FR').format(n).replace(/ | /g, ' ');
const dmy = (day: string): string => `${day.slice(8, 10)}/${day.slice(5, 7)}`;

/** Le texte du point, fait par le code : chiffres de la base, « non communiquée » pour une donnée absente [R53]. */
export function weeklyPointText(firstName: string | null, f: WeeklyFigures, nextActions: readonly string[]): string {
  const end = addDays(f.week, 6);
  const lines = [
    `${firstName ? `Bonjour ${firstName},` : 'Bonjour,'} voici le point de la semaine du ${dmy(f.week)} au ${dmy(end)} pour votre bien.`,
    `Vues de l’annonce : ${f.views === null ? 'non communiquées' : number(f.views)}.`,
    `Contacts reçus : ${number(f.contacts)}.`,
    `Visites faites : ${number(f.visitsDone)} ; visites prévues : ${number(f.visitsPlanned)}.`,
    f.opinions.length > 0 ? `Avis des visiteurs : ${f.opinions.join(' / ')}` : 'Avis des visiteurs : non communiqués.',
    nextActions.length > 0 ? `Prochaines actions : ${nextActions.join(' ; ')}.` : 'Prochaines actions : votre agent immobilier vous les précise de vive voix.',
  ];
  return lines.join('\n').replace(/[()]/g, '');
}

/** La porte de diffusion de D05, qui dit aussi quel mandat est en cours. */
export interface MandateGate {
  canDiffuse(networkId: string, propertyId: string, at?: Date): Promise<DiffusionDecision>;
}

export interface PointSemaineOptions {
  /** Absente : celle de D05. */
  diffusion?: MandateGate;
  now?: () => Date;
}

interface PointRow {
  mandate_id: string;
  week: string;
  network_id: string;
  property_id: string;
  person_id: string;
  agent_id: string;
  figures: string;
  next_actions: string | null;
  status: 'prepare' | 'valide';
  delivery_status: 'sent' | 'waiting' | 'refused' | 'failed' | null;
  delivery_rule: string | null;
}

export class PointSemaine {
  private readonly now: () => Date;
  private readonly fiche: FicheUnique;
  private readonly controle: ControleEnvois;
  private readonly diffusion: MandateGate;
  private readonly mesure: MesureBiens;

  constructor(
    private readonly db: SqlDatabase,
    private readonly journal: JournalStore,
    private readonly acces: Acces,
    options: PointSemaineOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    const store = new FicheClient(db, { now: this.now });
    this.fiche = new FicheUnique(db, store, { now: this.now });
    this.controle = new ControleEnvois(db, this.fiche, new DecisionEnvoi(db, store, this.fiche, { now: this.now }), {
      channels: trialChannels(db, journal, this.now),
      journal: new SqlSendJournal(db, undefined, this.now),
      now: this.now,
    });
    this.diffusion = options.diffusion ?? new Diffusion(db, acces, journal, { now: this.now });
    this.mesure = new MesureBiens(db, acces, journal, { now: this.now });
  }

  /**
   * Prépare, une seule fois par mandat et par lundi, le point de la semaine écoulée de chaque mandat en cours du
   * réseau. Rien ne part : l'agent valide d'abord.
   */
  async prepare(networkId: string): Promise<number> {
    const at = this.now();
    const monday = mondayOf(at);
    const week = addDays(monday, -7);
    const properties = await this.db.all<{ property_id: string }>('SELECT DISTINCT property_id FROM mandates WHERE network_id = ? AND property_id IS NOT NULL', [networkId]);
    let made = 0;
    for (const { property_id } of properties) {
      const d = await this.diffusion.canDiffuse(networkId, property_id, at);
      if (!d.mandateId || !(d.allowed || d.reason === 'withdrawal_period')) continue;
      const mandate = (await this.db.first<{ id: string; person_id: string; agent_id: string }>('SELECT id, person_id, agent_id FROM mandates WHERE id = ?', [d.mandateId]))!;
      if (await this.db.first('SELECT mandate_id FROM weekly_points WHERE mandate_id = ? AND week = ?', [mandate.id, week])) continue;
      const figures = await this.figures(networkId, property_id, week);
      const iso = at.toISOString();
      const { changes } = await this.db.run(
        `INSERT INTO weekly_points (mandate_id, week, network_id, property_id, person_id, agent_id, figures, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'prepare', ?, ?)
         ON CONFLICT DO NOTHING`,
        [mandate.id, week, networkId, property_id, mandate.person_id, mandate.agent_id, JSON.stringify(figures), iso, iso],
      );
      if (changes === 1) {
        made += 1;
        await appendEvent(this.journal, { type: 'point_semaine.prepare', actor: 'system:point_semaine', subject: `mandate:${mandate.id}`, data: { week } }, this.now);
      }
    }
    return made;
  }

  /** Le point préparé, pour l'agent du mandat ou la direction [R16]. */
  async read(viewer: Viewer, mandateId: string, week: string): Promise<{ ok: true; figures: WeeklyFigures; text: string } | PointRefusal> {
    const row = await this.access(viewer, mandateId, week);
    if (!row.ok) return row;
    const figures = JSON.parse(row.row.figures) as WeeklyFigures;
    const first = await this.firstName(row.row.person_id);
    return { ok: true, figures, text: weeklyPointText(first, figures, row.row.next_actions ? (JSON.parse(row.row.next_actions) as string[]) : []) };
  }

  /** L'agent valide, avec ses prochaines actions ; jamais une baisse de prix [R53]. Le point part alors. */
  async validate(viewer: Viewer, mandateId: string, week: string, nextActions: readonly string[] = []): Promise<{ ok: true; delivery: string; rule: string | null } | PointRefusal> {
    const access = await this.access(viewer, mandateId, week);
    if (!access.ok) return access;
    const row = access.row;
    if (row.status === 'valide') {
      if (row.delivery_status === null) return this.send(mandateId, week);
      return { ok: true, delivery: row.delivery_status, rule: row.delivery_rule };
    }
    if (!Array.isArray(nextActions) || nextActions.length > 5 || nextActions.some((a) => typeof a !== 'string' || a.trim() === '' || a.length > 200)) return { ok: false, rule: null, code: 'bad_actions' };
    if (nextActions.some((a) => PRICE_DROP.test(plain(a)))) return { ok: false, rule: 'R53', code: 'price_drop' };
    const iso = this.now().toISOString();
    const { changes } = await this.db.run(
      "UPDATE weekly_points SET next_actions = ?, status = 'valide', validated_by = ?, validated_at = ?, updated_at = ? WHERE mandate_id = ? AND week = ? AND status = 'prepare'",
      [JSON.stringify(nextActions.map((a) => a.trim())), `${viewer.role}:${viewer.userId}`, iso, iso, mandateId, week],
    );
    if (changes === 1) await appendEvent(this.journal, { type: 'point_semaine.valide', actor: `${viewer.role}:${viewer.userId}`, subject: `mandate:${mandateId}`, data: { week } }, this.now);
    return this.send(mandateId, week);
  }

  /** Reprend les points validés qui n'ont pas pu partir pour l'heure, une panne, ou jamais. */
  async retry(): Promise<number> {
    const rows = await this.db.all<{ mandate_id: string; week: string }>(
      "SELECT mandate_id, week FROM weekly_points WHERE status = 'valide' AND (delivery_status IS NULL OR delivery_status IN ('waiting', 'failed'))",
    );
    let sent = 0;
    for (const r of rows) if ((await this.send(r.mandate_id, r.week)).delivery === 'sent') sent += 1;
    return sent;
  }

  private async access(viewer: Viewer, mandateId: string, week: string): Promise<{ ok: true; row: PointRow } | PointRefusal> {
    const refuse = async (code: string): Promise<PointRefusal> => {
      await appendEvent(this.journal, { type: 'acces.refuse', actor: `${String(viewer.role)}:${viewer.userId}`, subject: `mandate:${mandateId}`, data: { rule: 'R16', role: String(viewer.role), kind: 'weekly_point', code } }, this.now);
      return { ok: false, rule: 'R16', code };
    };
    if (viewer.role !== 'agent' && viewer.role !== 'direction') return refuse('role');
    const row = await this.db.first<PointRow>('SELECT * FROM weekly_points WHERE mandate_id = ? AND week = ?', [mandateId, week]);
    if (!row || row.network_id !== viewer.networkId) return refuse('unknown');
    if (viewer.role === 'agent' && viewer.userId !== row.agent_id) return refuse('not_assigned');
    const read = await this.acces.readFiche(viewer, row.person_id);
    if (!read.ok) return { ok: false, rule: 'R16', code: read.code };
    if (read.view !== 'full') return refuse('not_assigned');
    return { ok: true, row };
  }

  private async firstName(personId: string): Promise<string | null> {
    return (await this.fiche.view(personId)).members.map((m) => m.first_name).find((n) => n) ?? null;
  }

  /** Les chiffres de la semaine, lus dans la base ; les vues « non communiquées » si aucun canal n'en a rapporté. */
  private async figures(networkId: string, propertyId: string, week: string): Promise<WeeklyFigures> {
    // Lu par le système pour le point, avec les droits de la direction ; la lecture est écrite au journal.
    const system: Viewer = { role: 'direction', userId: 'system:point_semaine', networkId };
    const m = await this.mesure.weekly(system, propertyId, week);
    if (!m.ok) throw new Error(`mesure non lue : ${m.code}`);
    const reported = await this.db.first<{ n: number }>('SELECT count(*) AS n FROM listing_views WHERE property_id = ? AND day >= ? AND day <= ?', [propertyId, week, addDays(week, 6)]);
    const reports = await this.db.all<{ report: string; start_at: string }>(
      `SELECT r.report, a.start_at FROM visit_reports r JOIN appointments a ON a.id = r.appointment_id
       WHERE a.property_id = ? AND r.status = 'valide' ORDER BY a.start_at`,
      [propertyId],
    );
    const opinions = reports
      .filter((r) => mondayOf(new Date(r.start_at)) === week)
      .map((r) => JSON.parse(r.report) as VisitReport)
      .map((r) => `${r.opinion.replace(/[.\s]+$/, '')}, intérêt ${r.interest}`)
      // Un avis qui parlerait de baisse de prix n'entre pas dans le point [R53].
      .filter((o) => !PRICE_DROP.test(plain(o)));
    return {
      week,
      views: Number(reported?.n ?? 0) > 0 ? m.value.totalViews : null,
      contacts: m.value.contacts,
      visitsDone: m.value.visits.done,
      visitsPlanned: m.value.visits.planned,
      opinions,
    };
  }

  private async send(mandateId: string, week: string): Promise<{ ok: true; delivery: string; rule: string | null }> {
    const row = (await this.db.first<PointRow>('SELECT * FROM weekly_points WHERE mandate_id = ? AND week = ?', [mandateId, week]))!;
    if (row.delivery_status === 'sent' || row.delivery_status === 'refused') return { ok: true, delivery: row.delivery_status, rule: row.delivery_rule };
    const figures = JSON.parse(row.figures) as WeeklyFigures;
    const actions = row.next_actions ? (JSON.parse(row.next_actions) as string[]) : [];
    const text = weeklyPointText(await this.firstName(row.person_id), figures, actions);
    let status: 'sent' | 'waiting' | 'refused' | 'failed';
    let rule: string | null;
    let messageId: string | null = null;
    if (PRICE_DROP.test(plain(text))) {
      status = 'refused';
      rule = 'R53';
    } else {
      const numbers = [figures.views ?? 0, figures.contacts, figures.visitsDone, figures.visitsPlanned, ...[week, addDays(week, 6)].flatMap((d) => [Number(d.slice(8, 10)), Number(d.slice(5, 7))])];
      const result = await this.controle.send({
        networkId: row.network_id,
        agentId: row.agent_id,
        personId: row.person_id,
        channel: 'email',
        kind: 'follow_up',
        purpose: SELLER_UPDATE_PURPOSE,
        subject: `point_semaine:${mandateId}:${week}`,
        fallbackTexts: [text],
        // Les chiffres des avis et des actions viennent de comptes rendus validés et de l'agent.
        figures: [...numbers, ...text.match(/\d+/g)!.map(Number)],
      });
      messageId = result.messageId;
      rule = result.status === 'sent' ? null : result.rule;
      status = result.status === 'sent' ? 'sent' : result.status === 'failed' ? 'failed' : result.rule === 'R01' ? 'waiting' : 'refused';
    }
    await this.db.run(
      "UPDATE weekly_points SET delivery_status = ?, delivery_rule = ?, message_id = COALESCE(?, message_id), updated_at = ? WHERE mandate_id = ? AND week = ? AND (delivery_status IS NULL OR delivery_status <> 'sent')",
      [status, rule, messageId, this.now().toISOString(), mandateId, week],
    );
    await appendEvent(this.journal, { type: 'point_semaine.envoi', actor: 'system:point_semaine', subject: `mandate:${mandateId}`, data: { mode: 'essai', week, status, rule } }, this.now);
    return { ok: true, delivery: status, rule };
  }
}

export const WEEKLY_POINT_JOB = 'visites.point_semaine';

/** Chaque lundi à 8 h, le point de chaque mandat en cours est préparé pour son agent ; les points validés en attente repartent. */
export function weeklyPointJob(db: SqlDatabase, journal: JournalStore, acces: () => Acces, options: PointSemaineOptions = {}): ScheduledJob {
  return {
    name: WEEKLY_POINT_JOB,
    hours: [8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19],
    weekdays: [1, 2, 3, 4, 5, 6],
    run: async () => {
      const point = new PointSemaine(db, journal, acces(), options);
      for (const n of await db.all<{ id: string }>('SELECT id FROM networks')) await point.prepare(n.id);
      await point.retry();
    },
  };
}
