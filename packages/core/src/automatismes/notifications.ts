/**
 * Notifications sur le téléphone de l'agent, réglables (HX27).
 *
 * Un contact chaud est notifié tout de suite, seul, à l'agent qui suit la fiche [R412, R16]. Le reste est groupé par
 * urgence : un seul envoi par urgence et par période (15 minutes pour « haute », une heure pour « normale », un jour
 * pour « basse »), qui dit combien il y a de nouveautés de chaque sorte [R414]. Pendant les heures calmes de l'agent,
 * rien ne part, sauf ce qui touche une personne qui vient d'écrire : un message reçu d'elle depuis 30 minutes au plus ;
 * le reste attend la fin des heures calmes [R413]. Le texte visible écran verrouillé n'est fait que de phrases fixes et
 * de nombres : ni nom, ni coordonnée, ni texte d'un client ; le détail se lit dans l'application, sous les droits de
 * l'agent [R415, R13].
 *
 * Chaque envoi est réservé en base avant l'appel au service de notification : deux passages n'envoient jamais le même
 * groupe, et un passage coupé avant la réponse rend ses notifications au passage suivant [R18]. Rien ne s'efface [R17].
 * Rien ne part que par le contrôle central des envois (`ControleEnvois.sendToAgent`, SV15), seule porte branchée, en
 * mode essai tant que le vrai service (Web Push, H57) n'est pas là [R26, R225]. Le branchement au planificateur, aux
 * routes et à l'écran des réglages est une tâche de la voie 1 (`app.ts`).
 */
import { Acces } from '../acces/acces.ts';
import type { Viewer } from '../acces/droits.ts';
import { FicheClient } from '../db/fiche-client.ts';
import { runBatch, type SqlDatabase, type SqlStatement } from '../db/sql.ts';
import type { ControleEnvois } from '../envoi/controle.ts';
import { localTime } from '../envoi/horaires.ts';
import type { AgentPushPayload } from '../envoi/notifications-agents.ts';
import { agentState } from '../acces/etat-agent.ts';
import { FicheUnique } from '../fiche/fusion.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';

const TIME_ZONE = 'Europe/Paris';
const MIN = 60_000;

export const NOTIFICATION_KINDS = ['contact_chaud', 'client_ecrit', 'rendez_vous', 'piece_recue', 'tache', 'info'] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];
export type Urgency = 'immediate' | 'haute' | 'normale' | 'basse';
export type GroupedUrgency = Exclude<Urgency, 'immediate'>;
export type KindLevel = GroupedUrgency | 'coupee';
/** Les sortes que l'agent règle ; le contact chaud reste toujours immédiat [R412]. */
export type SettableKind = Exclude<NotificationKind, 'contact_chaud'>;
const SETTABLE_KINDS: readonly SettableKind[] = ['client_ecrit', 'rendez_vous', 'piece_recue', 'tache', 'info'];
const LEVELS: readonly KindLevel[] = ['haute', 'normale', 'basse', 'coupee'];

export const DEFAULT_LEVELS: Readonly<Record<SettableKind, GroupedUrgency>> = {
  client_ecrit: 'haute',
  rendez_vous: 'haute',
  piece_recue: 'normale',
  tache: 'normale',
  info: 'basse',
};
/** Heures calmes par défaut : de 21 h à 8 h, heure de Paris, jusqu'à ce que l'agent en décide autrement. */
export const DEFAULT_QUIET = { start: 21 * 60, end: 8 * 60 } as const;
/** Le rythme de chaque groupe : un envoi au plus par période [R414]. */
export const GROUP_PERIOD_MS: Readonly<Record<GroupedUrgency, number>> = { haute: 15 * MIN, normale: 60 * MIN, basse: 24 * 60 * MIN };
/** « Vient d'écrire » : un message reçu de la personne depuis 30 minutes au plus [R413]. */
export const JUST_WROTE_MS = 30 * MIN;
/** Un envoi réservé sans réponse du service depuis ce délai : passage coupé, ses notifications sont reprises [R18]. */
const STALE_RESERVATION_MS = 2 * MIN;
/** Identifiants par écriture : D1 n'accepte pas plus de 100 paramètres. */
const CLAIM_CHUNK = 90;
const URGENCY_ORDER: readonly Urgency[] = ['immediate', 'haute', 'normale', 'basse'];

/** Les mots des textes visibles écran verrouillé, au singulier et au pluriel [R415]. */
const KIND_LABELS: Readonly<Record<NotificationKind, readonly [string, string]>> = {
  contact_chaud: ['contact chaud à rappeler', 'contacts chauds à rappeler'],
  client_ecrit: ['message de client', 'messages de clients'],
  rendez_vous: ['rendez-vous', 'rendez-vous'],
  piece_recue: ['pièce reçue', 'pièces reçues'],
  tache: ['tâche à faire', 'tâches à faire'],
  info: ['information', 'informations'],
};
export const LOCK_TITLE = 'AIMMO';
const SAFE_WORDS = new Set([
  'aimmo',
  'un',
  'une',
  'maintenant',
  'nouveauté',
  'nouveautés',
  ...Object.values(KIND_LABELS).flatMap(([one, many]) => [...one.split(/[\s]+/), ...many.split(/[\s]+/)]),
]);

/**
 * Le texte écran verrouillé n'est fait que des mots fixes et de nombres : un prénom, une adresse, un numéro ou un
 * montant ne peuvent pas y entrer, même par erreur [R415].
 */
export function lockTextIsSafe(text: string): boolean {
  const tokens = text
    .toLowerCase()
    .split(/[\s·,.]+/)
    .filter((t) => t.length > 0);
  if (tokens.length === 0) return false;
  return tokens.every((t) => SAFE_WORDS.has(t) || /^[1-9][0-9]{0,3}$/.test(t));
}

/** Le texte écran verrouillé d'un envoi : des nombres par sorte, rien d'autre [R415]. */
export function lockText(urgency: Urgency, kinds: readonly NotificationKind[]): { title: string; body: string } {
  const counts = new Map<NotificationKind, number>();
  for (const k of kinds) counts.set(k, (counts.get(k) ?? 0) + 1);
  const parts: string[] = [];
  for (const k of NOTIFICATION_KINDS) {
    const n = counts.get(k);
    if (!n) continue;
    const [one, many] = KIND_LABELS[k];
    parts.push(n === 1 ? `${k === 'info' || k === 'piece_recue' || k === 'tache' ? 'une' : 'un'} ${one}` : `${n} ${many}`);
  }
  let body = parts.join(' · ');
  if (urgency === 'immediate') body = `${body} maintenant`;
  body = body.charAt(0).toUpperCase() + body.slice(1);
  if (!lockTextIsSafe(LOCK_TITLE) || !lockTextIsSafe(body)) throw new Error('Texte de notification non sûr [R415].');
  return { title: LOCK_TITLE, body };
}

/** Ce que reçoit le téléphone : le texte écran verrouillé et le lien vers le détail, dans l'application [R415]. */
export type PushPayload = AgentPushPayload;

/**
 * La porte de sortie des notifications aux agents : le contrôle central des envois, et lui seul [R26, R225]. Il réserve
 * chaque envoi par son identifiant [R05], vérifie l'agent [R86] et, en mode essai, ne remet rien à un téléphone.
 */
export type AgentPushGate = Pick<ControleEnvois, 'sendToAgent'>;

export interface NotificationSettings {
  quietStart: number;
  quietEnd: number;
  levels: Record<SettableKind, KindLevel>;
}

export interface NotificationRow {
  id: string;
  network_id: string;
  agent_id: string;
  person_id: string;
  kind: NotificationKind;
  urgency: Urgency;
  dedup_key: string;
  status: 'a_envoyer' | 'en_envoi' | 'envoyee' | 'sans_appareil' | 'remplacee' | 'annulee';
  push_id: string | null;
  created_at: string;
  sent_at: string | null;
}

export interface PushRow {
  id: string;
  network_id: string;
  agent_id: string;
  urgency: Urgency;
  count: number;
  lock_title: string;
  lock_line: string;
  status: 'reservee' | 'partie' | 'aucun_appareil' | 'echec' | 'incertaine' | 'abandonnee';
  reserved_at: string;
  done_at: string | null;
}

export type NotifyResult =
  | { ok: true; value: NotificationRow | null; reason?: 'coupee' | 'deja_dit' | 'exclue' | 'agent_parti' }
  | { ok: false; rule: 'R16'; code: string };

export interface NotificationsOptions {
  now?: () => Date;
  newId?: () => string;
  timeZone?: string;
  /** La fenêtre du rattrapage : les faits plus vieux ne notifient plus rien (RC33). 15 minutes par défaut. */
  catchUpWindowMs?: number;
}

/** Le rattrapage de chaque passage ne relit que les faits de ces dernières minutes (RC33). */
export const CATCH_UP_WINDOW_MS = 15 * MIN;

/** Ce qu'un rattrapage a fait : les notifications rangées, et les faits relus. */
export interface CatchUpResult {
  hotContacts: number;
  inbound: number;
  notified: number;
}

const placeholders = (n: number): string => Array.from({ length: n }, () => '?').join(', ');

export class Notifications {
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly timeZone: string;
  private readonly store: FicheClient;
  private readonly fiche: FicheUnique;
  private readonly acces: Acces;
  private readonly catchUpWindowMs: number;

  constructor(
    private readonly db: SqlDatabase,
    private readonly journal: JournalStore,
    private readonly gate: AgentPushGate,
    options: NotificationsOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => crypto.randomUUID());
    this.timeZone = options.timeZone ?? TIME_ZONE;
    this.catchUpWindowMs = options.catchUpWindowMs ?? CATCH_UP_WINDOW_MS;
    this.store = new FicheClient(db, { now: this.now });
    this.fiche = new FicheUnique(db, this.store, { now: this.now });
    this.acces = new Acces(db, this.store, this.fiche, journal, { now: this.now });
  }

  /** Les réglages en vigueur de l'agent : le dernier enregistré, sinon ceux par défaut. */
  async settings(agentId: string): Promise<NotificationSettings> {
    const row = await this.db.first<{ quiet_start: number; quiet_end: number; levels: string }>(
      'SELECT quiet_start, quiet_end, levels FROM agent_notification_settings WHERE agent_id = ? ORDER BY set_at DESC, rowid DESC LIMIT 1',
      [agentId],
    );
    const levels: Record<SettableKind, KindLevel> = { ...DEFAULT_LEVELS };
    if (!row) return { quietStart: DEFAULT_QUIET.start, quietEnd: DEFAULT_QUIET.end, levels };
    const stored = JSON.parse(row.levels) as Partial<Record<string, string>>;
    for (const k of SETTABLE_KINDS) {
      const v = stored[k];
      if (v && (LEVELS as readonly string[]).includes(v)) levels[k] = v as KindLevel;
    }
    return { quietStart: Number(row.quiet_start), quietEnd: Number(row.quiet_end), levels };
  }

  /**
   * L'agent règle ses heures calmes et le niveau de chaque sorte ; lui seul, pour lui seul. Le contact chaud ne se
   * règle pas : il reste immédiat [R412].
   */
  async setSettings(
    viewer: Viewer,
    input: { quietStart: number; quietEnd: number; levels?: Partial<Record<string, string>> },
  ): Promise<{ ok: true; value: NotificationSettings } | { ok: false; code: 'not_self' | 'invalid_quiet' | 'invalid_level' | 'hot_fixed' }> {
    if (viewer.role !== 'agent') return { ok: false, code: 'not_self' };
    const agent = await this.db.first<{ id: string; status: string }>('SELECT id, status FROM agents WHERE id = ? AND network_id = ?', [viewer.userId, viewer.networkId]);
    if (!agent || agent.status !== 'active') return { ok: false, code: 'not_self' };
    const minute = (v: unknown): boolean => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 1439;
    if (!minute(input.quietStart) || !minute(input.quietEnd)) return { ok: false, code: 'invalid_quiet' };
    const current = await this.settings(agent.id);
    const levels = { ...current.levels };
    for (const [k, v] of Object.entries(input.levels ?? {})) {
      if (k === 'contact_chaud') return { ok: false, code: 'hot_fixed' };
      if (!(SETTABLE_KINDS as readonly string[]).includes(k) || !(LEVELS as readonly string[]).includes(String(v))) return { ok: false, code: 'invalid_level' };
      levels[k as SettableKind] = v as KindLevel;
    }
    await this.db.run(
      'INSERT INTO agent_notification_settings (id, network_id, agent_id, quiet_start, quiet_end, levels, set_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [this.newId(), viewer.networkId, agent.id, input.quietStart, input.quietEnd, JSON.stringify(levels), this.now().toISOString()],
    );
    await appendEvent(
      this.journal,
      { type: 'notifications.reglees', actor: `agent:${agent.id}`, subject: `agent:${agent.id}`, data: { quietStart: input.quietStart, quietEnd: input.quietEnd, levels } },
      this.now,
    );
    return { ok: true, value: { quietStart: input.quietStart, quietEnd: input.quietEnd, levels } };
  }

  /**
   * Le contact chaud d'une tâche « rappeler » : notifié tout de suite à chaque agent qui suit la fiche, et ses messages
   * pas encore partis de la même personne sont dits par lui [R412].
   */
  async hotContact(taskId: string): Promise<NotifyResult[]> {
    const task = await this.db.first<{ id: string; person_id: string }>('SELECT id, person_id FROM callback_tasks WHERE id = ? AND done_at IS NULL', [taskId]);
    if (!task) return [];
    const results: NotifyResult[] = [];
    for (const agentId of await this.agentsOf(task.person_id)) {
      results.push(await this.notify({ agentId, personId: task.person_id, kind: 'contact_chaud', sourceKey: `callback:${task.id}` }));
    }
    return results;
  }

  /** Un message reçu d'un client : notifié à l'agent du message, ou à ceux qui suivent la fiche. */
  async inbound(messageId: string): Promise<NotifyResult[]> {
    const m = await this.db.first<{ id: string; agent_id: string | null; person_id: string; direction: string; author_kind: string }>(
      'SELECT id, agent_id, person_id, direction, author_kind FROM messages WHERE id = ?',
      [messageId],
    );
    if (!m || m.direction !== 'in' || m.author_kind !== 'person') return [];
    const agents = m.agent_id ? [m.agent_id] : await this.agentsOf(m.person_id);
    const results: NotifyResult[] = [];
    for (const agentId of agents) results.push(await this.notify({ agentId, personId: m.person_id, kind: 'client_ecrit', sourceKey: `message:${m.id}` }));
    return results;
  }

  /**
   * Une notification pour un agent, une seule par fait (`sourceKey`) [R18], seulement si l'agent voit la fiche en
   * entier [R16] ; jamais pour une personne exclue [R25]. Un contact chaud part aussitôt [R412].
   */
  async notify(input: { agentId: string; personId: string; kind: NotificationKind; sourceKey: string }): Promise<NotifyResult> {
    if (!(NOTIFICATION_KINDS as readonly string[]).includes(input.kind) || input.sourceKey.trim().length === 0) return { ok: false, rule: 'R16', code: 'invalid' };
    const agent = await this.db.first<{ id: string; network_id: string; status: string }>('SELECT id, network_id, status FROM agents WHERE id = ?', [input.agentId]);
    if (!agent) return { ok: false, rule: 'R16', code: 'unknown_agent' };
    if (agent.status !== 'active') return { ok: true, value: null, reason: 'agent_parti' };
    const viewer: Viewer = { role: 'agent', userId: agent.id, networkId: agent.network_id };
    const read = await this.acces.readFiche(viewer, input.personId);
    if (!read.ok) return { ok: false, rule: 'R16', code: read.code };
    if (read.view !== 'full') return { ok: false, rule: 'R16', code: 'shared_view' };
    const members = read.value.members.map((p) => p.id);
    const root = read.value.person.id;
    if (await this.excluded(members)) return { ok: true, value: null, reason: 'exclue' };

    const dedup = `${agent.id}:${input.kind}:${input.sourceKey}`;
    const existing = await this.db.first<NotificationRow>('SELECT * FROM agent_notifications WHERE dedup_key = ?', [dedup]);
    if (existing) return { ok: true, value: existing };

    let urgency: Urgency;
    if (input.kind === 'contact_chaud') urgency = 'immediate';
    else {
      const level = (await this.settings(agent.id)).levels[input.kind];
      if (level === 'coupee') return { ok: true, value: null, reason: 'coupee' };
      urgency = level;
    }
    const at = this.now();
    // Un message de la personne déjà dit par son contact chaud, il y a peu ou encore à partir, n'est pas redit [R412].
    if (input.kind === 'client_ecrit' && (await this.toldByHot(agent.id, members, at))) return { ok: true, value: null, reason: 'deja_dit' };
    const { changes } = await this.db.run(
      `INSERT INTO agent_notifications (id, network_id, agent_id, person_id, kind, urgency, dedup_key, status, push_id, created_at, sent_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'a_envoyer', NULL, ?, NULL) ON CONFLICT (dedup_key) DO NOTHING`,
      [this.newId(), agent.network_id, agent.id, root, input.kind, urgency, dedup, at.toISOString()],
    );
    const row = await this.db.first<NotificationRow>('SELECT * FROM agent_notifications WHERE dedup_key = ?', [dedup]);
    if (!row) return { ok: false, rule: 'R16', code: 'not_stored' };
    if (changes !== 1) return { ok: true, value: row };
    await appendEvent(this.journal, { type: 'notification.creee', actor: 'system:notifications', subject: `person:${root}`, data: { notification: row.id, kind: row.kind, urgency } }, this.now);
    if (input.kind === 'contact_chaud') {
      await this.db.run(
        `UPDATE agent_notifications SET status = 'remplacee' WHERE agent_id = ? AND kind = 'client_ecrit' AND status = 'a_envoyer' AND person_id IN (${placeholders(members.length)})`,
        [agent.id, ...members],
      );
      for (let i = 0; i < 50; i++) {
        const push = await this.pushGroup(agent.id, 'immediate');
        if (!push || push.status === 'echec') break;
      }
    }
    return { ok: true, value: (await this.db.first<NotificationRow>('SELECT * FROM agent_notifications WHERE id = ?', [row.id])) ?? row };
  }

  /**
   * Le rattrapage du passage de chaque minute, à appeler juste avant `flush()` (RC33) : relit dans chaque réseau les
   * tâches « rappeler » encore ouvertes et les messages reçus d'une personne de la fenêtre (15 minutes par défaut), et
   * notifie ce qui ne l'est pas encore, par `notify`, sous les mêmes règles [R412, R16]. Ainsi un contact chaud ou un
   * message n'attend plus qu'on ait appelé `hotContact` ou `inbound`. Un fait déjà notifié, ou qui ne le serait pas
   * (agent parti, dossier d'agent incomplet, sorte coupée, personne exclue, déjà dit par un contact chaud), est écarté
   * avant toute lecture de la fiche : le journal ne reçoit pas une lecture à chaque passage [R13]. Un fait plus vieux que
   * la fenêtre ne notifie plus rien ; un message daté dans le futur attend.
   */
  async catchUp(): Promise<CatchUpResult> {
    const at = this.now();
    const from = new Date(at.getTime() - this.catchUpWindowMs).toISOString();
    const to = at.toISOString();
    const result: CatchUpResult = { hotContacts: 0, inbound: 0, notified: 0 };
    const networks = await this.db.all<{ id: string }>('SELECT id FROM networks ORDER BY id');
    for (const network of networks) {
      const tasks = await this.db.all<{ id: string; person_id: string }>(
        'SELECT id, person_id FROM callback_tasks WHERE network_id = ? AND done_at IS NULL AND created_at >= ? AND created_at <= ? ORDER BY created_at, id',
        [network.id, from, to],
      );
      for (const task of tasks) {
        result.hotContacts += 1;
        for (const agentId of await this.agentsOf(task.person_id)) {
          if (await this.wouldNotify(agentId, task.person_id, 'contact_chaud', `callback:${task.id}`, at)) {
            const r = await this.notify({ agentId, personId: task.person_id, kind: 'contact_chaud', sourceKey: `callback:${task.id}` });
            if (r.ok && r.value) result.notified += 1;
          }
        }
      }
      const messages = await this.db.all<{ id: string; agent_id: string | null; person_id: string }>(
        `SELECT id, agent_id, person_id FROM messages WHERE network_id = ? AND direction = 'in' AND author_kind = 'person'
         AND occurred_at >= ? AND occurred_at <= ? ORDER BY occurred_at, id`,
        [network.id, from, to],
      );
      for (const m of messages) {
        result.inbound += 1;
        // L'agent du message s'il suit encore la fiche ; sinon ceux qui la suivent.
        const followers = await this.agentsOf(m.person_id);
        const agents = m.agent_id && followers.includes(m.agent_id) ? [m.agent_id] : followers;
        for (const agentId of agents) {
          if (await this.wouldNotify(agentId, m.person_id, 'client_ecrit', `message:${m.id}`, at)) {
            const r = await this.notify({ agentId, personId: m.person_id, kind: 'client_ecrit', sourceKey: `message:${m.id}` });
            if (r.ok && r.value) result.notified += 1;
          }
        }
      }
    }
    return result;
  }

  /**
   * Avant toute lecture de la fiche : le fait n'est pas déjà notifié à cet agent, l'agent est en activité avec un
   * dossier complet et suit la fiche, la sorte n'est pas coupée, la personne n'est pas exclue, et un contact chaud ne
   * l'a pas déjà dit (RC33). Ce que `notify` contrôle encore ensuite (droits [R16]) reste à lui.
   */
  private async wouldNotify(agentId: string, personId: string, kind: NotificationKind, sourceKey: string, at: Date): Promise<boolean> {
    const done = await this.db.first<{ id: string }>('SELECT id FROM agent_notifications WHERE dedup_key = ?', [`${agentId}:${kind}:${sourceKey}`]);
    if (done) return false;
    const agent = await this.db.first<{ network_id: string; status: string }>('SELECT network_id, status FROM agents WHERE id = ?', [agentId]);
    if (!agent || agent.status !== 'active') return false;
    if ((await agentState(this.db, agent.network_id, agentId, at)) !== 'actif') return false;
    const members = await this.fiche.membersOf(personId);
    if (members.length === 0) return false;
    const follows = await this.db.first<{ n: number }>(
      `SELECT count(*) AS n FROM persons WHERE id IN (${placeholders(members.length)}) AND network_id = ? AND agent_id = ?`,
      [...members, agent.network_id, agentId],
    );
    if (Number(follows?.n ?? 0) === 0) return false;
    if (kind !== 'contact_chaud') {
      if ((await this.settings(agentId)).levels[kind as SettableKind] === 'coupee') return false;
      if (kind === 'client_ecrit' && (await this.toldByHot(agentId, members, at))) return false;
    }
    return !(await this.excluded(members));
  }

  /** Un contact chaud de la même personne, créé ou parti depuis 30 minutes au plus, ou encore à partir [R412]. */
  private async toldByHot(agentId: string, members: readonly string[], at: Date): Promise<boolean> {
    const since = new Date(at.getTime() - JUST_WROTE_MS).toISOString();
    const hot = await this.db.first<{ n: number }>(
      `SELECT count(*) AS n FROM agent_notifications WHERE agent_id = ? AND kind = 'contact_chaud' AND person_id IN (${placeholders(members.length)})
       AND (created_at >= ? OR sent_at >= ? OR status IN ('a_envoyer', 'en_envoi'))`,
      [agentId, ...members, since, since],
    );
    return Number(hot?.n ?? 0) > 0;
  }

  /**
   * Le passage de chaque minute : reprend les envois coupés, puis envoie ce qui est dû pour chaque agent, urgence par
   * urgence. Rend les envois faits.
   */
  async flush(): Promise<PushRow[]> {
    const at = this.now();
    await this.releaseStale(at);
    const agents = await this.db.all<{ agent_id: string }>("SELECT DISTINCT agent_id FROM agent_notifications WHERE status = 'a_envoyer' ORDER BY agent_id");
    const pushes: PushRow[] = [];
    for (const { agent_id } of agents) {
      for (const urgency of URGENCY_ORDER) {
        // Les contacts chauds partent un par un ; les autres urgences, un groupe par passage [R412, R414].
        for (let i = 0; i < (urgency === 'immediate' ? 50 : 1); i++) {
          const push = await this.pushGroup(agent_id, urgency);
          if (!push) break;
          pushes.push(push);
          // Un refus du service : on réessaie au passage suivant, pas dans celui-ci.
          if (push.status === 'echec') break;
        }
      }
    }
    return pushes;
  }

  /** Les notifications d'un agent : la liste du détail, dans l'application, lue par lui seul et sous ses droits [R16]. */
  async listFor(viewer: Viewer): Promise<NotificationRow[]> {
    if (viewer.role !== 'agent') return [];
    const rows = await this.db.all<NotificationRow>('SELECT * FROM agent_notifications WHERE agent_id = ? AND network_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 200', [
      viewer.userId,
      viewer.networkId,
    ]);
    return this.visibleTo(viewer, rows);
  }

  /**
   * Les notifications d'un envoi, pour l'agent qui l'a reçu (BR66) : lues par l'envoi, jamais dans la liste bornée des
   * dernières, puis gardées sur les seules fiches qu'il voit en entier [R16].
   */
  async listForPush(viewer: Viewer, pushId: string): Promise<NotificationRow[]> {
    if (viewer.role !== 'agent') return [];
    const rows = await this.db.all<NotificationRow>('SELECT * FROM agent_notifications WHERE push_id = ? AND agent_id = ? AND network_id = ? ORDER BY created_at DESC, id DESC', [
      pushId,
      viewer.userId,
      viewer.networkId,
    ]);
    return rows.length === 0 ? [] : this.visibleTo(viewer, rows);
  }

  private async visibleTo(viewer: Viewer, rows: NotificationRow[]): Promise<NotificationRow[]> {
    const visible = await this.acces.listPersons(viewer);
    if (!visible.ok) return [];
    const allowed = new Set<string>();
    for (const p of visible.value) for (const id of await this.fiche.membersOf(p.id)) allowed.add(id);
    return rows.filter((r) => allowed.has(r.person_id));
  }

  /**
   * Envoie à l'agent le groupe dû de cette urgence, s'il y en a un ; un contact chaud part toujours seul [R412].
   * Chaque notification est relue juste avant de partir : agent encore actif, fiche encore vue en entier [R16],
   * personne pas exclue entre-temps [R25] ; sinon elle est annulée, jamais envoyée.
   */
  private async pushGroup(agentId: string, urgency: Urgency): Promise<PushRow | null> {
    const at = this.now();
    const agent = await this.db.first<{ network_id: string; status: string }>('SELECT network_id, status FROM agents WHERE id = ?', [agentId]);
    if (!agent || agent.status !== 'active') return null;
    if (urgency !== 'immediate') {
      const last = await this.db.first<{ reserved_at: string }>(
        "SELECT reserved_at FROM agent_pushes WHERE agent_id = ? AND urgency = ? AND status IN ('reservee', 'partie', 'aucun_appareil') ORDER BY reserved_at DESC LIMIT 1",
        [agentId, urgency],
      );
      if (last && at.getTime() - Date.parse(last.reserved_at) < GROUP_PERIOD_MS[urgency]) return null;
    }
    const waiting = await this.db.all<NotificationRow>(
      "SELECT * FROM agent_notifications WHERE agent_id = ? AND urgency = ? AND status = 'a_envoyer' AND created_at <= ? ORDER BY created_at, rowid",
      [agentId, urgency, at.toISOString()],
    );
    if (waiting.length === 0) return null;
    const settings = await this.settings(agentId);
    const quiet = this.inQuiet(at, settings);
    const viewer: Viewer = { role: 'agent', userId: agentId, networkId: agent.network_id };
    const due: NotificationRow[] = [];
    for (const n of waiting) {
      // Pendant les heures calmes, seule passe une personne qui vient d'écrire [R413].
      if (quiet && !(await this.justWrote(n.person_id, at))) continue;
      // Un réglage coupé depuis la création : la notification attend, elle n'est pas envoyée.
      if (n.kind !== 'contact_chaud' && settings.levels[n.kind as SettableKind] === 'coupee') continue;
      const read = await this.acces.readFiche(viewer, n.person_id);
      if (!read.ok || read.view !== 'full' || (await this.excluded(read.value.members.map((p) => p.id)))) {
        await this.db.run("UPDATE agent_notifications SET status = 'annulee' WHERE id = ? AND status = 'a_envoyer'", [n.id]);
        continue;
      }
      due.push(n);
      if (urgency === 'immediate') break;
    }
    if (due.length === 0) return null;

    const text = lockText(urgency, due.map((n) => n.kind));
    const pushId = this.newId();
    // Réservation et prise des notifications, tout ou rien : un autre passage qui en a pris une fait tout annuler [R18].
    // La période se vérifie dans l'écriture même : deux passages qui se croisent ne réservent jamais deux envois de la
    // même urgence dans une période [R414].
    const periodStart = urgency === 'immediate' ? at.toISOString() : new Date(at.getTime() - GROUP_PERIOD_MS[urgency] + 1).toISOString();
    const reserved = await this.db.run(
      `INSERT INTO agent_pushes (id, network_id, agent_id, urgency, count, lock_title, lock_line, status, reserved_at, done_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, 'reservee', ?, NULL
       WHERE ? = 'immediate' OR NOT EXISTS (
         SELECT 1 FROM agent_pushes WHERE agent_id = ? AND urgency = ? AND status IN ('reservee', 'partie', 'aucun_appareil') AND reserved_at >= ?
       )`,
      [pushId, agent.network_id, agentId, urgency, due.length, text.title, text.body, at.toISOString(), urgency, agentId, urgency, periodStart],
    );
    if (reserved.changes !== 1) return null;
    // Par paquets de 90 identifiants au plus, sous la limite de 100 paramètres de D1, dans un même lot tout ou rien.
    const claims: SqlStatement[] = [];
    for (let i = 0; i < due.length; i += CLAIM_CHUNK) {
      const ids = due.slice(i, i + CLAIM_CHUNK).map((n) => n.id);
      claims.push({
        sql: `UPDATE agent_notifications SET status = 'en_envoi', push_id = ? WHERE status = 'a_envoyer' AND id IN (${placeholders(ids.length)})
       AND EXISTS (SELECT 1 FROM agent_pushes WHERE id = ? AND status = 'reservee')`,
        params: [pushId, ...ids, pushId],
      });
    }
    const changes = (await runBatch(this.db, claims)).reduce((sum, r) => sum + r.changes, 0);
    if (changes !== due.length) {
      // Le texte ne dirait pas le bon nombre : rien ne part [R18].
      await this.finish(pushId, 'abandonnee', at.toISOString());
      return null;
    }
    if (urgency === 'immediate') {
      // Le contact chaud dit à sa place les messages pas encore partis de la même personne, même arrivés pendant
      // qu'il attendait [R412].
      const members = await this.fiche.membersOf(due[0]?.person_id ?? '');
      await this.db.run(
        `UPDATE agent_notifications SET status = 'remplacee' WHERE agent_id = ? AND kind = 'client_ecrit' AND status = 'a_envoyer' AND person_id IN (${placeholders(members.length)})`,
        [agentId, ...members],
      );
    }
    // Une réservation reprise entre-temps par un autre passage n'envoie rien : ses notifications sont déjà rendues [R18].
    const live = await this.db.first<{ status: string }>('SELECT status FROM agent_pushes WHERE id = ?', [pushId]);
    if (live?.status !== 'reservee') return null;
    let outcome: 'ok' | 'aucun_appareil' | 'echec';
    try {
      outcome = await this.gate.sendToAgent({ networkId: agent.network_id, agentId, payload: { pushId, urgency, title: text.title, body: text.body, url: `/notifications/${pushId}` } });
    } catch {
      outcome = 'echec';
    }
    const pushStatus = outcome === 'ok' ? 'partie' : outcome;
    await this.finish(pushId, pushStatus, this.now().toISOString());
    await appendEvent(
      this.journal,
      { type: 'notification.envoyee', actor: 'system:notifications', subject: `agent:${agentId}`, data: { push: pushId, urgency, count: due.length, status: pushStatus } },
      this.now,
    );
    return this.db.first<PushRow>('SELECT * FROM agent_pushes WHERE id = ?', [pushId]);
  }

  /**
   * L'envoi et ses notifications changent d'état ensemble, tout ou rien, et seulement si l'envoi était encore réservé :
   * un passage plus lent que la reprise ne réécrit rien [R18].
   */
  private async finish(pushId: string, status: 'partie' | 'aucun_appareil' | 'echec' | 'incertaine' | 'abandonnee', at: string): Promise<void> {
    const back = status === 'echec' || status === 'incertaine' || status === 'abandonnee';
    const stillReserved = "EXISTS (SELECT 1 FROM agent_pushes WHERE id = ? AND status = 'reservee')";
    await runBatch(this.db, [
      back
        ? { sql: `UPDATE agent_notifications SET status = 'a_envoyer', push_id = NULL WHERE push_id = ? AND status = 'en_envoi' AND ${stillReserved}`, params: [pushId, pushId] }
        : { sql: `UPDATE agent_notifications SET status = ?, sent_at = ? WHERE push_id = ? AND status = 'en_envoi' AND ${stillReserved}`, params: [status === 'partie' ? 'envoyee' : 'sans_appareil', at, pushId, pushId] },
      { sql: "UPDATE agent_pushes SET status = ?, done_at = ? WHERE id = ? AND status = 'reservee'", params: [status, at, pushId] },
    ]);
  }

  /**
   * Un envoi réservé resté sans réponse : déclaré incertain, ses notifications reviennent à envoyer. Et une
   * notification restée « en envoi » derrière un envoi déjà fini (base sans lot) suit l'état de son envoi [R18].
   */
  private async releaseStale(at: Date): Promise<void> {
    const limit = new Date(at.getTime() - STALE_RESERVATION_MS).toISOString();
    const stale = await this.db.all<{ id: string }>("SELECT id FROM agent_pushes WHERE status = 'reservee' AND reserved_at <= ?", [limit]);
    for (const { id } of stale) await this.finish(id, 'incertaine', at.toISOString());
    await this.db.run(
      `UPDATE agent_notifications SET status = 'a_envoyer', push_id = NULL WHERE status = 'en_envoi'
       AND push_id IN (SELECT id FROM agent_pushes WHERE status IN ('echec', 'incertaine', 'abandonnee'))`,
    );
    await this.db.run(
      `UPDATE agent_notifications SET status = CASE (SELECT status FROM agent_pushes p WHERE p.id = push_id) WHEN 'partie' THEN 'envoyee' ELSE 'sans_appareil' END,
       sent_at = (SELECT done_at FROM agent_pushes p WHERE p.id = push_id)
       WHERE status = 'en_envoi' AND push_id IN (SELECT id FROM agent_pushes WHERE status IN ('partie', 'aucun_appareil'))`,
    );
  }

  private inQuiet(at: Date, s: NotificationSettings): boolean {
    const local = localTime(at, this.timeZone);
    // Le dimanche entier est calme, quels que soient les réglages [R413].
    if (local.weekday === 7) return true;
    if (s.quietStart === s.quietEnd) return false;
    const m = local.minutes;
    return s.quietStart < s.quietEnd ? m >= s.quietStart && m < s.quietEnd : m >= s.quietStart || m < s.quietEnd;
  }

  /** La personne, fiches réunies comprises, a écrit depuis 30 minutes au plus [R413]. */
  private async justWrote(personId: string, at: Date): Promise<boolean> {
    const members = await this.fiche.membersOf(personId);
    const row = await this.db.first<{ n: number }>(
      `SELECT count(*) AS n FROM messages WHERE person_id IN (${placeholders(members.length)}) AND direction = 'in' AND author_kind = 'person' AND occurred_at >= ? AND occurred_at <= ?`,
      [...members, new Date(at.getTime() - JUST_WROTE_MS).toISOString(), at.toISOString()],
    );
    return Number(row?.n ?? 0) > 0;
  }

  /** Les agents qui suivent la fiche, fiches réunies comprises. */
  private async agentsOf(personId: string): Promise<string[]> {
    const members = await this.fiche.membersOf(personId);
    if (members.length === 0) return [];
    const rows = await this.db.all<{ id: string; agent_id: string | null }>(`SELECT id, agent_id FROM persons WHERE id IN (${placeholders(members.length)})`, members);
    const byId = new Map(rows.map((r) => [r.id, r.agent_id]));
    return [...new Set(members.map((id) => byId.get(id)).filter((a): a is string => typeof a === 'string'))];
  }

  private async excluded(ids: readonly string[]): Promise<boolean> {
    const at = this.now().toISOString();
    const row = await this.db.first<{ n: number }>(
      `SELECT count(*) AS n FROM exclusions WHERE person_id IN (${placeholders(ids.length)}) AND noted_at <= ? AND (lifted_at IS NULL OR lifted_at > ?)`,
      [...ids, at, at],
    );
    return Number(row?.n ?? 0) > 0;
  }
}
