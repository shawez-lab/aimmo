/**
 * Prochaine action sur une fiche (HX25).
 *
 * Comme Modelo et Hektor : une action proposée sur chaque fiche. Jamais vu : elle dit en une ligne pourquoi, d'après un
 * fait daté de la fiche qu'elle cite (le message, la tâche, le projet, l'arrêt demandé), jamais une impression ni une
 * note de la personne [R406]. Des règles fixes, sans IA, lues dans un ordre écrit ici. La fiche se lit sous droits
 * d'accès et chaque lecture va au journal [R16] ; le journal ne garde ni texte ni raison [R13].
 */
import { Acces, type AccessResult } from '../acces/acces.ts';
import type { Viewer } from '../acces/droits.ts';
import { FicheClient } from '../db/fiche-client.ts';
import type { SqlDatabase } from '../db/sql.ts';
import type { ProjectKind } from '../db/types.ts';
import { DEFAULT_SEND_SETTINGS } from '../envoi/decision.ts';
import { localTime } from '../envoi/horaires.ts';
import { FicheUnique } from '../fiche/fusion.ts';
import type { JournalStore } from '../journal/types.ts';

export const NEXT_ACTIONS = ['ne_pas_relancer', 'repondre', 'faire_tache', 'relancer', 'qualifier', 'attendre'] as const;
export type NextActionKind = (typeof NEXT_ACTIONS)[number];

export interface NextAction {
  action: NextActionKind;
  /** Une ligne, en français, qui cite le fait daté d'où vient l'action. */
  reason: string;
  /** Le fait cité : `message:<id>`, `tache:<id>`, `projet:<id>`, `fiche:<id>` ou `arret:<id>`, et sa date. */
  basis: { ref: string; at: string };
}

export interface NextActionSettings {
  /** Jours sans échange avant de proposer une relance sur un projet ouvert. */
  followUpDays: number;
  timeZone: string;
}

export const DEFAULT_NEXT_ACTION_SETTINGS: NextActionSettings = Object.freeze({ followUpDays: 14, timeZone: DEFAULT_SEND_SETTINGS.timeZone });

/** Étapes où un projet est fini : plus de relance. Lecture prudente : une étape inconnue laisse le projet ouvert. */
export const CLOSED_PROJECT_STAGES: readonly string[] = ['acte_signe', 'arrete', 'abandonne', 'perdu', 'termine', 'vendu', 'loue'];

export const PROJECT_LABEL: Readonly<Record<ProjectKind, string>> = {
  sell: 'de vente',
  buy: 'd’achat',
  rent_out: 'de mise en location',
  rent: 'de location',
  invest: 'd’investissement',
  sell_business: 'de cession',
  buy_business: 'de reprise',
  valuation: 'd’estimation',
};

const EXCLUSION_LABEL: Readonly<Record<string, string>> = {
  stop: 'a demandé l’arrêt',
  refused: 'a dit non',
  sold: 'a dit avoir vendu',
  network_list: 'est sur la liste d’exclusion du réseau',
  followed_elsewhere: 'est suivie par quelqu’un d’autre',
};

const DAY = 86_400_000;

export interface ProchaineActionOptions {
  now?: () => Date;
  settings?: NextActionSettings;
}

export class ProchaineAction {
  private readonly now: () => Date;
  private readonly settings: NextActionSettings;
  private readonly acces: Acces;

  constructor(
    private readonly db: SqlDatabase,
    journal: JournalStore,
    options: ProchaineActionOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.settings = options.settings ?? DEFAULT_NEXT_ACTION_SETTINGS;
    const store = new FicheClient(db, { now: this.now });
    this.acces = new Acces(db, store, new FicheUnique(db, store, { now: this.now }), journal, { now: this.now });
  }

  /** « le 12/10 à 10 h 05 », heure du réseau. */
  private when(iso: string, withHour = true): string {
    const t = localTime(new Date(iso), this.settings.timeZone);
    const day = `${t.date.slice(8, 10)}/${t.date.slice(5, 7)}`;
    return withHour ? `le ${day} à ${Math.floor(t.minutes / 60)} h ${String(t.minutes % 60).padStart(2, '0')}` : `le ${day}`;
  }

  private daysSince(iso: string): number {
    const a = localTime(new Date(iso), this.settings.timeZone).date;
    const b = localTime(this.now(), this.settings.timeZone).date;
    return Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / DAY);
  }

  /** La prochaine action de la fiche, lue sous droits d'accès [R16, R406]. */
  async suggest(viewer: Viewer, personId: string): Promise<AccessResult<NextAction>> {
    const read = await this.acces.readFiche(viewer, personId);
    if (!read.ok) return read;
    const fiche = read.value;
    const now = this.now();
    const at = now.toISOString();
    const done = (action: NextActionKind, reason: string, ref: string, when: string): AccessResult<NextAction> => ({ ok: true, view: read.view, value: { action, reason, basis: { ref, at: when } } });

    // 1. La personne a demandé l'arrêt, ou est exclue : aucune relance, et l'on dit depuis quand [R02, R04].
    const exclusions = fiche.exclusions
      .filter((e) => e.noted_at <= at && (e.lifted_at === null || e.lifted_at > at))
      .sort((a, b) => (a.reason === 'stop' ? -1 : b.reason === 'stop' ? 1 : a.noted_at.localeCompare(b.noted_at)));
    const excluded = exclusions[0];
    if (excluded) {
      return done('ne_pas_relancer', `Ne pas relancer : la personne ${EXCLUSION_LABEL[excluded.reason] ?? 'est exclue'} ${this.when(excluded.noted_at, false)}.`, `arret:${excluded.id}`, excluded.noted_at);
    }

    // 2. Le dernier message est celui de la personne : lui répondre.
    const messages = fiche.messages.filter((m) => m.occurred_at <= at).sort((a, b) => a.occurred_at.localeCompare(b.occurred_at) || a.created_at.localeCompare(b.created_at));
    const last = messages[messages.length - 1];
    if (last && last.direction === 'in') {
      return done('repondre', `Répondre : message reçu ${this.when(last.occurred_at)}, sans réponse depuis.`, `message:${last.id}`, last.occurred_at);
    }

    // 3. Une tâche ouverte dont le jour est venu, la plus ancienne d'abord.
    const members = fiche.members.map((m) => m.id);
    const today = localTime(now, this.settings.timeZone).date;
    const task = await this.db.first<{ id: string; title: string; due_day: string }>(
      `SELECT id, title, due_day FROM automation_tasks WHERE network_id = ? AND done_at IS NULL AND due_day <= ?
         AND person_id IN (${members.map(() => '?').join(', ')}) ORDER BY due_day, created_at, id LIMIT 1`,
      [fiche.person.network_id, today, ...members],
    );
    if (task) {
      const late = task.due_day < today ? ', en retard' : '';
      return done('faire_tache', `Faire la tâche « ${task.title} », prévue le ${task.due_day.slice(8, 10)}/${task.due_day.slice(5, 7)}${late}.`, `tache:${task.id}`, `${task.due_day}T00:00:00.000Z`);
    }

    // 4. Un projet ouvert sans échange depuis le délai réglé : le relancer.
    const open = fiche.projects.filter((p) => !CLOSED_PROJECT_STAGES.includes(p.stage) && p.created_at <= at).sort((a, b) => a.created_at.localeCompare(b.created_at));
    if (open.length > 0) {
      const project = open[open.length - 1]!;
      const since = last ? last.occurred_at : project.created_at;
      const days = this.daysSince(since);
      if (days >= this.settings.followUpDays) {
        const fact = last ? `dernier échange ${this.when(since, false)}` : `projet noté ${this.when(since, false)}, sans échange`;
        return done('relancer', `Relancer le projet ${PROJECT_LABEL[project.kind]} : ${fact}, il y a ${days} jours.`, last ? `message:${last.id}` : `projet:${project.id}`, since);
      }
      const next = localTime(new Date(Date.parse(since) + this.settings.followUpDays * DAY), this.settings.timeZone).date;
      return done(
        'attendre',
        `Rien à faire avant le ${next.slice(8, 10)}/${next.slice(5, 7)} : ${last ? `dernier échange ${this.when(since, false)}` : `projet ${PROJECT_LABEL[project.kind]} noté ${this.when(since, false)}`}.`,
        last ? `message:${last.id}` : `projet:${project.id}`,
        since,
      );
    }

    // 5. Aucun projet ouvert : le qualifier, ou dire depuis quand le dernier est fini.
    if (fiche.projects.length === 0) {
      return done('qualifier', `Qualifier le projet : fiche créée ${this.when(fiche.person.created_at, false)}, aucun projet noté.`, `fiche:${fiche.person.id}`, fiche.person.created_at);
    }
    const closed = [...fiche.projects].sort((a, b) => a.updated_at.localeCompare(b.updated_at)).pop()!;
    return done('attendre', `Rien à faire : le projet ${PROJECT_LABEL[closed.kind]} est fini depuis ${this.when(closed.updated_at, false)}.`, `projet:${closed.id}`, closed.updated_at);
  }
}
