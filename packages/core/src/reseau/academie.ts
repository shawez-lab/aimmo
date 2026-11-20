/**
 * Académie du réseau (M14, J06) [R85].
 *
 * Des modules courts (une vidéo YouTube en accès restreint, par son identifiant ; un script par sa référence ; une
 * durée), rangés en parcours : l'entrée, puis une spécialité. Des séances en salle, en direct, mensuelles ou
 * régionales, dont la présence est saisie par un humain nommé de la direction.
 *
 * Le compteur des heures de formation obligatoire est calculé par le code, et seulement depuis des justificatifs
 * vérifiables [R85, R10] : une présence rangée par un humain nommé de la direction, ou un module couvert par une
 * attestation de quiz réussi, rangée avec son empreinte (HX63, R571). Un module seulement marqué « J'ai fini » est une
 * heure déclarée : elle est montrée à part et ne remplit aucune obligation (AU027). Par année d'activité (14 h), et par
 * période de 3 ans (42 h, dont 2 h de
 * déontologie et 2 h de non-discrimination). Les périodes partent de la période de référence de l'agent : celle de son
 * cycle d'avant l'arrivée quand la direction l'a reprise, avec ses attestations antérieures (AU028), sinon son jour
 * d'entrée au réseau. Quand une obligation
 * manque, l'agent est prévenu 90 puis 30 jours avant l'échéance, une seule fois par palier ; les alertes sont rendues
 * au planificateur (J13), rien n'est envoyé ici.
 *
 * L'académie forme : elle n'impose aucun horaire, aucune date limite de module, et ne note pas l'agent [R14]. Seuls
 * l'agent lui-même et la direction lisent son compteur [R16]. La direction range les modules, les séances et les
 * présences ; l'agent marque ses modules faits. Au journal, des identifiants internes et des nombres [R13].
 */
import type { Viewer } from '../acces/droits.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { localTime } from '../envoi/horaires.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';

const TIME_ZONE = 'Europe/Paris';

export const ACADEMY_TRACKS = ['entree', 'vente', 'location', 'commerces', 'investissement', 'conformite'] as const;
export type AcademyTrack = (typeof ACADEMY_TRACKS)[number];

export const ACADEMY_TOPICS = ['general', 'deontologie', 'non_discrimination'] as const;
export type AcademyTopic = (typeof ACADEMY_TOPICS)[number];

export const SESSION_KINDS = ['salle', 'direct', 'mensuelle', 'regionale'] as const;
export type SessionKind = (typeof SESSION_KINDS)[number];

export type Obligation = 'annuelle' | 'triennale' | 'deontologie' | 'non_discrimination';

/** Réglages des heures obligatoires, en minutes, et des paliers d'alerte, en jours avant l'échéance. */
export interface AcademySettings {
  annualMinutes: number;
  triennialMinutes: number;
  deontologyMinutes: number;
  nonDiscriminationMinutes: number;
  alertDays: readonly number[];
}

export const ACADEMY_SETTINGS: Readonly<AcademySettings> = Object.freeze({
  annualMinutes: 14 * 60,
  triennialMinutes: 42 * 60,
  deontologyMinutes: 2 * 60,
  nonDiscriminationMinutes: 2 * 60,
  alertDays: Object.freeze([90, 30]),
});

export interface ObligationStatus {
  obligation: Obligation;
  /** Premier jour de la période, `AAAA-MM-JJ`. */
  from: string;
  /** Dernier jour de la période, compris. */
  until: string;
  requiredMinutes: number;
  /** Minutes justifiées : présences rangées et modules couverts par une attestation. Seules elles comptent. */
  doneMinutes: number;
  /** Minutes déclarées (« J'ai fini ») sans justificatif dans la période : montrées à part, jamais comptées. */
  declaredMinutes: number;
  missingMinutes: number;
  daysLeft: number;
}

export interface TrainingCounter {
  agentId: string;
  /** Premier jour de la période de référence, d'où partent les périodes. */
  startedOn: string;
  /** Jour d'entrée de l'agent au réseau. */
  arrivedOn: string;
  /** D'où vient la période : le cycle d'avant l'arrivée repris par la direction, ou l'arrivée faute de mieux (AU028). */
  periodSource: 'cycle_anterieur' | 'arrivee';
  obligations: ObligationStatus[];
}

export interface AcademyAlert {
  agentId: string;
  obligation: Obligation;
  until: string;
  daysBefore: number;
  missingMinutes: number;
  /** Ce que l'agent lira, en une phrase. */
  text: string;
}

export type AcademyRefusal = { ok: false; rule: 'R16' | null; code: string };

export interface AcademieOptions {
  now?: () => Date;
  newId?: () => string;
  settings?: AcademySettings;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

const validDay = (v: unknown): v is string => {
  if (typeof v !== 'string' || !DAY.test(v)) return false;
  const d = new Date(`${v}T12:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
};

/** Le même jour, n années plus tard ; un 29 février devient le 28 les années sans. */
export function addYears(day: string, years: number): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const last = new Date(Date.UTC(y + years, m, 0)).getUTCDate();
  return new Date(Date.UTC(y + years, m - 1, Math.min(d, last), 12)).toISOString().slice(0, 10);
}

const addDays = (day: string, n: number): string => new Date(Date.parse(`${day}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const daysBetween = (from: string, to: string): number => Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86_400_000);
const frDate = (day: string): string => `${day.slice(8, 10)}/${day.slice(5, 7)}/${day.slice(0, 4)}`;

/** « 1 h 30 », « 45 min », « 14 h ». */
export function hours(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m} min`;
  return m === 0 ? `${h} h` : `${h} h ${String(m).padStart(2, '0')}`;
}

const LABEL: Record<Obligation, string> = {
  annuelle: "de formation pour l'année",
  triennale: 'de formation sur 3 ans',
  deontologie: 'de déontologie',
  non_discrimination: 'de non-discrimination',
};

/** La période (année ou 3 ans) qui contient le jour, à partir du jour d'entrée. */
function periodOf(startedOn: string, today: string, years: number): { from: string; until: string } {
  let k = Math.max(0, Math.floor(daysBetween(startedOn, today) / (365.25 * years)) - 1);
  while (addYears(startedOn, (k + 1) * years) <= today) k += 1;
  while (k > 0 && addYears(startedOn, k * years) > today) k -= 1;
  const from = addYears(startedOn, k * years);
  return { from, until: addDays(addYears(startedOn, (k + 1) * years), -1) };
}

interface Done {
  day: string;
  minutes: number;
  topic: AcademyTopic;
  /** Vrai si un justificatif vérifiable porte ces minutes ; faux pour un « J'ai fini » seul. */
  proved: boolean;
}

export class Academie {
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly settings: AcademySettings;

  constructor(
    private readonly db: SqlDatabase,
    private readonly journal: JournalStore,
    options: AcademieOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => crypto.randomUUID());
    this.settings = options.settings ?? ACADEMY_SETTINGS;
  }

  private actor(viewer: Viewer): string {
    return `${String(viewer.role)}:${viewer.userId}`;
  }

  private today(at: Date = this.now()): string {
    return localTime(at, TIME_ZONE).date;
  }

  private async refuse(viewer: Viewer, subject: string | null, kind: string, code: string): Promise<AcademyRefusal> {
    await appendEvent(this.journal, { type: 'acces.refuse', actor: this.actor(viewer), subject, data: { rule: 'R16', role: String(viewer.role), kind, code } }, this.now);
    return { ok: false, rule: 'R16', code };
  }

  private async agent(networkId: string, agentId: string): Promise<{ status: string; created_at: string } | null> {
    return this.db.first<{ status: string; created_at: string }>('SELECT status, created_at FROM agents WHERE id = ? AND network_id = ?', [agentId, networkId]);
  }

  /** La direction range un module. Un module ne porte ni date limite ni horaire [R85]. */
  async addModule(
    viewer: Viewer,
    input: { title: unknown; track: unknown; position: unknown; videoId: unknown; scriptRef?: unknown; durationMinutes: unknown; topic?: unknown; mandatory?: unknown },
  ): Promise<{ ok: true; moduleId: string } | AcademyRefusal> {
    if (viewer.role !== 'direction') return this.refuse(viewer, null, 'academy_module', 'role');
    const title = typeof input.title === 'string' ? input.title.trim() : '';
    if (title.length < 3 || title.length > 120) return { ok: false, rule: null, code: 'invalid_title' };
    if (typeof input.track !== 'string' || !(ACADEMY_TRACKS as readonly string[]).includes(input.track)) return { ok: false, rule: null, code: 'invalid_track' };
    if (!Number.isInteger(input.position) || (input.position as number) < 1 || (input.position as number) > 999) return { ok: false, rule: null, code: 'invalid_position' };
    if (typeof input.videoId !== 'string' || !VIDEO_ID.test(input.videoId)) return { ok: false, rule: null, code: 'invalid_video' };
    const scriptRef = input.scriptRef === undefined || input.scriptRef === null ? null : input.scriptRef;
    if (scriptRef !== null && (typeof scriptRef !== 'string' || scriptRef.length < 1 || scriptRef.length > 200)) return { ok: false, rule: null, code: 'invalid_script' };
    if (!Number.isInteger(input.durationMinutes) || (input.durationMinutes as number) < 1 || (input.durationMinutes as number) > 480) return { ok: false, rule: null, code: 'invalid_duration' };
    const topic = input.topic ?? 'general';
    if (typeof topic !== 'string' || !(ACADEMY_TOPICS as readonly string[]).includes(topic)) return { ok: false, rule: null, code: 'invalid_topic' };
    const mandatory = input.mandatory ?? true;
    if (typeof mandatory !== 'boolean') return { ok: false, rule: null, code: 'invalid_mandatory' };
    const id = this.newId();
    const { changes } = await this.db.run(
      `INSERT INTO academy_modules (id, network_id, title, track, position, video_id, script_ref, duration_minutes, topic, mandatory, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
      [id, viewer.networkId, title, input.track, input.position as number, input.videoId, scriptRef as string | null, input.durationMinutes as number, topic, mandatory ? 1 : 0, this.actor(viewer), this.now().toISOString()],
    );
    if (changes !== 1) return { ok: false, rule: null, code: 'position_taken' };
    await appendEvent(this.journal, { type: 'academie.module', actor: this.actor(viewer), subject: `academy_module:${id}`, data: { track: input.track, minutes: input.durationMinutes as number, topic } }, this.now);
    return { ok: true, moduleId: id };
  }

  /**
   * Les parcours : l'entrée d'abord, puis chaque spécialité, dans l'ordre des positions. Tout agent du réseau les lit.
   * Pour un agent, chaque module dit s'il l'a déjà fait (J14) : ses seuls modules, jamais ceux d'un autre [R16].
   * Aucun rang ni aucune note : fait ou pas, rien d'autre [R14].
   */
  async tracks(
    viewer: Viewer,
  ): Promise<{ ok: true; value: { track: AcademyTrack; modules: { id: string; title: string; position: number; videoId: string; durationMinutes: number; topic: AcademyTopic; mandatory: boolean; done: boolean }[] }[] } | AcademyRefusal> {
    if (viewer.role === 'partner') return this.refuse(viewer, null, 'academy_tracks', 'role');
    const rows = await this.db.all<{ id: string; title: string; track: AcademyTrack; position: number; video_id: string; duration_minutes: number; topic: AcademyTopic; mandatory: number }>(
      'SELECT id, title, track, position, video_id, duration_minutes, topic, mandatory FROM academy_modules WHERE network_id = ? ORDER BY position, id',
      [viewer.networkId],
    );
    const done =
      viewer.role === 'agent'
        ? new Set((await this.db.all<{ module_id: string }>('SELECT module_id FROM academy_completions WHERE agent_id = ? AND network_id = ?', [viewer.userId, viewer.networkId])).map((r) => r.module_id))
        : new Set<string>();
    const value = ACADEMY_TRACKS.map((track) => ({
      track,
      modules: rows
        .filter((r) => r.track === track)
        .map((r) => ({ id: r.id, title: r.title, position: r.position, videoId: r.video_id, durationMinutes: r.duration_minutes, topic: r.topic, mandatory: r.mandatory === 1, done: done.has(r.id) })),
    })).filter((t) => t.modules.length > 0);
    return { ok: true, value };
  }

  /**
   * L'agent marque un module fait, une seule fois. C'est une heure déclarée : elle ne compte pour les obligations
   * qu'une fois couverte par une attestation de quiz réussi (AU027) [R85].
   */
  async complete(viewer: Viewer, moduleId: string): Promise<{ ok: true; already: boolean } | AcademyRefusal> {
    if (viewer.role !== 'agent') return this.refuse(viewer, `academy_module:${moduleId}`, 'academy_completion', 'role');
    const agent = await this.agent(viewer.networkId, viewer.userId);
    if (!agent || agent.status !== 'active') return this.refuse(viewer, `academy_module:${moduleId}`, 'academy_completion', 'agent_inactive');
    const module = await this.db.first<{ id: string }>('SELECT id FROM academy_modules WHERE id = ? AND network_id = ?', [moduleId, viewer.networkId]);
    if (!module) return { ok: false, rule: null, code: 'unknown_module' };
    const at = this.now();
    const { changes } = await this.db.run(
      'INSERT INTO academy_completions (module_id, agent_id, network_id, completed_at, completed_on) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING',
      [moduleId, viewer.userId, viewer.networkId, at.toISOString(), this.today(at)],
    );
    if (changes === 1) await appendEvent(this.journal, { type: 'academie.module_fait', actor: this.actor(viewer), subject: `agent:${viewer.userId}`, data: { module: `academy_module:${moduleId}` } }, this.now);
    return { ok: true, already: changes !== 1 };
  }

  /** La direction range une séance tenue (ou à tenir) un jour donné. */
  async addSession(
    viewer: Viewer,
    input: { kind: unknown; title: unknown; heldOn: unknown; durationMinutes: unknown; topic?: unknown; mandatory?: unknown },
  ): Promise<{ ok: true; sessionId: string } | AcademyRefusal> {
    if (viewer.role !== 'direction') return this.refuse(viewer, null, 'academy_session', 'role');
    if (typeof input.kind !== 'string' || !(SESSION_KINDS as readonly string[]).includes(input.kind)) return { ok: false, rule: null, code: 'invalid_kind' };
    const title = typeof input.title === 'string' ? input.title.trim() : '';
    if (title.length < 3 || title.length > 120) return { ok: false, rule: null, code: 'invalid_title' };
    if (!validDay(input.heldOn)) return { ok: false, rule: null, code: 'invalid_day' };
    if (!Number.isInteger(input.durationMinutes) || (input.durationMinutes as number) < 1 || (input.durationMinutes as number) > 480) return { ok: false, rule: null, code: 'invalid_duration' };
    const topic = input.topic ?? 'general';
    if (typeof topic !== 'string' || !(ACADEMY_TOPICS as readonly string[]).includes(topic)) return { ok: false, rule: null, code: 'invalid_topic' };
    const mandatory = input.mandatory ?? true;
    if (typeof mandatory !== 'boolean') return { ok: false, rule: null, code: 'invalid_mandatory' };
    const id = this.newId();
    await this.db.run(
      `INSERT INTO academy_sessions (id, network_id, kind, title, held_on, duration_minutes, topic, mandatory, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, viewer.networkId, input.kind, title, input.heldOn, input.durationMinutes as number, topic, mandatory ? 1 : 0, this.actor(viewer), this.now().toISOString()],
    );
    await appendEvent(this.journal, { type: 'academie.seance', actor: this.actor(viewer), subject: `academy_session:${id}`, data: { kind: input.kind, minutes: input.durationMinutes as number, topic } }, this.now);
    return { ok: true, sessionId: id };
  }

  /**
   * La direction range la présence d'un agent à une séance déjà tenue, avec le nom de l'humain qui la saisit. Une
   * présence ne se devine jamais : sans cette saisie, la séance ne compte pas [R85, R10].
   */
  async recordAttendance(viewer: Viewer, sessionId: string, input: { agentId: unknown; recorderName: unknown }): Promise<{ ok: true; already: boolean } | AcademyRefusal> {
    if (viewer.role !== 'direction') return this.refuse(viewer, `academy_session:${sessionId}`, 'academy_attendance', 'role');
    const name = typeof input.recorderName === 'string' ? input.recorderName.trim() : '';
    if (name.length < 2 || name.length > 80) return { ok: false, rule: null, code: 'recorder_required' };
    const session = await this.db.first<{ held_on: string }>('SELECT held_on FROM academy_sessions WHERE id = ? AND network_id = ?', [sessionId, viewer.networkId]);
    if (!session) return { ok: false, rule: null, code: 'unknown_session' };
    if (session.held_on > this.today()) return { ok: false, rule: null, code: 'session_not_held' };
    if (typeof input.agentId !== 'string') return { ok: false, rule: null, code: 'unknown_agent' };
    const agent = await this.agent(viewer.networkId, input.agentId);
    if (!agent) return { ok: false, rule: null, code: 'unknown_agent' };
    const { changes } = await this.db.run(
      'INSERT INTO academy_attendance (session_id, agent_id, network_id, recorded_by, recorder_name, recorded_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING',
      [sessionId, input.agentId, viewer.networkId, this.actor(viewer), name, this.now().toISOString()],
    );
    if (changes === 1) await appendEvent(this.journal, { type: 'academie.presence', actor: this.actor(viewer), subject: `agent:${input.agentId}`, data: { session: `academy_session:${sessionId}` } }, this.now);
    return { ok: true, already: changes !== 1 };
  }

  /** Le compteur d'un agent : lu par l'agent lui-même et par la direction, personne d'autre [R16]. */
  async counter(viewer: Viewer, agentId: string): Promise<{ ok: true; value: TrainingCounter } | AcademyRefusal> {
    const agent = await this.agent(viewer.networkId, agentId);
    if (!agent) return this.refuse(viewer, `agent:${agentId}`, 'training_counter', 'unknown');
    const allowed = viewer.role === 'direction' || (viewer.role === 'agent' && viewer.userId === agentId);
    if (!allowed) return this.refuse(viewer, `agent:${agentId}`, 'training_counter', viewer.role === 'agent' ? 'not_assigned' : 'role');
    return { ok: true, value: await this.compute(viewer.networkId, agentId, this.today()) };
  }

  private async arrivedOn(networkId: string, agentId: string): Promise<string> {
    const onboarding = await this.db.first<{ created_at: string }>('SELECT created_at FROM agent_onboardings WHERE agent_id = ? AND network_id = ?', [agentId, networkId]);
    const agent = await this.agent(networkId, agentId);
    const at = onboarding?.created_at ?? agent?.created_at;
    if (!at) throw new Error(`Agent inconnu : ${agentId}`);
    return this.today(new Date(at));
  }

  /** La période de référence reprise du cycle d'avant l'arrivée : la dernière rangée l'emporte (AU028). */
  private async priorPeriod(networkId: string, agentId: string): Promise<string | null> {
    const row = await this.db.first<{ day: string }>(
      "SELECT day FROM academy_prior_entries WHERE agent_id = ? AND network_id = ? AND kind = 'periode' ORDER BY recorded_at DESC, rowid DESC LIMIT 1",
      [agentId, networkId],
    );
    return row?.day ?? null;
  }

  private async priorInput(
    viewer: Viewer,
    agentId: string,
    kind: 'periode' | 'formation',
    input: { day: unknown; proofRef: unknown; recorderName: unknown },
  ): Promise<{ ok: true; arrivedOn: string; day: string; proofRef: string; name: string } | AcademyRefusal> {
    if (viewer.role !== 'direction') return this.refuse(viewer, `agent:${agentId}`, `academy_prior_${kind}`, 'role');
    const agent = await this.agent(viewer.networkId, agentId);
    if (!agent) return { ok: false, rule: null, code: 'unknown_agent' };
    const name = typeof input.recorderName === 'string' ? input.recorderName.trim() : '';
    if (name.length < 2 || name.length > 80) return { ok: false, rule: null, code: 'recorder_required' };
    const proofRef = typeof input.proofRef === 'string' ? input.proofRef.trim() : '';
    if (proofRef.length < 1 || proofRef.length > 200) return { ok: false, rule: null, code: 'proof_required' };
    if (!validDay(input.day) || input.day < '1990-01-01') return { ok: false, rule: null, code: 'invalid_day' };
    const arrivedOn = await this.arrivedOn(viewer.networkId, agentId);
    // Repris du cycle d'avant : jamais après l'arrivée, ni dans l'avenir. Après l'arrivée, l'académie compte elle-même.
    if (input.day > arrivedOn || input.day > this.today()) return { ok: false, rule: null, code: 'not_before_arrival' };
    return { ok: true, arrivedOn, day: input.day, proofRef, name };
  }

  /**
   * La direction reprend la période de référence de l'agent : le premier jour de son cycle de formation d'avant son
   * arrivée, avec la pièce qui le prouve et le nom de l'humain qui le saisit. Les périodes en partent, sans remise à
   * zéro à l'arrivée (AU028) [R85, R10]. Une correction est une nouvelle ligne : la dernière l'emporte [R17].
   */
  async setPriorPeriod(viewer: Viewer, agentId: string, input: { cycleStart: unknown; proofRef: unknown; recorderName: unknown }): Promise<{ ok: true } | AcademyRefusal> {
    const checked = await this.priorInput(viewer, agentId, 'periode', { day: input.cycleStart, proofRef: input.proofRef, recorderName: input.recorderName });
    if (!checked.ok) return checked;
    const id = this.newId();
    await this.db.run(
      `INSERT INTO academy_prior_entries (id, network_id, agent_id, kind, day, duration_minutes, topic, proof_ref, recorded_by, recorder_name, recorded_at)
       VALUES (?, ?, ?, 'periode', ?, NULL, NULL, ?, ?, ?, ?)`,
      [id, viewer.networkId, agentId, checked.day, checked.proofRef, this.actor(viewer), checked.name, this.now().toISOString()],
    );
    await appendEvent(this.journal, { type: 'academie.periode_reprise', actor: this.actor(viewer), subject: `agent:${agentId}`, data: { entry: `academy_prior_entry:${id}` } }, this.now);
    return { ok: true };
  }

  /**
   * La direction reprend une formation suivie avant l'arrivée, sur son attestation : jour, durée, thème, référence de
   * la pièce et nom de l'humain qui la saisit. Elle compte comme justifiée dans la période qui contient son jour (AU028).
   */
  async addPriorTraining(
    viewer: Viewer,
    agentId: string,
    input: { heldOn: unknown; durationMinutes: unknown; topic?: unknown; proofRef: unknown; recorderName: unknown },
  ): Promise<{ ok: true; entryId: string } | AcademyRefusal> {
    const checked = await this.priorInput(viewer, agentId, 'formation', { day: input.heldOn, proofRef: input.proofRef, recorderName: input.recorderName });
    if (!checked.ok) return checked;
    if (!Number.isInteger(input.durationMinutes) || (input.durationMinutes as number) < 1 || (input.durationMinutes as number) > 2520) return { ok: false, rule: null, code: 'invalid_duration' };
    const topic = input.topic ?? 'general';
    if (typeof topic !== 'string' || !(ACADEMY_TOPICS as readonly string[]).includes(topic)) return { ok: false, rule: null, code: 'invalid_topic' };
    const id = this.newId();
    await this.db.run(
      `INSERT INTO academy_prior_entries (id, network_id, agent_id, kind, day, duration_minutes, topic, proof_ref, recorded_by, recorder_name, recorded_at)
       VALUES (?, ?, ?, 'formation', ?, ?, ?, ?, ?, ?, ?)`,
      [id, viewer.networkId, agentId, checked.day, input.durationMinutes as number, topic, checked.proofRef, this.actor(viewer), checked.name, this.now().toISOString()],
    );
    await appendEvent(this.journal, { type: 'academie.formation_reprise', actor: this.actor(viewer), subject: `agent:${agentId}`, data: { entry: `academy_prior_entry:${id}`, minutes: input.durationMinutes as number, topic } }, this.now);
    return { ok: true, entryId: id };
  }

  /**
   * Les minutes obligatoires, par jour et par thème [R85, R10]. Justifiées : une présence rangée par la direction (le
   * jour de la séance), ou un module fait et couvert par une attestation de quiz réussi de cet agent (le jour de la
   * première attestation qui le couvre). Déclarées : un module marqué fait sans attestation, au jour du clic. Un
   * module ne compte qu'une fois, quel que soit le nombre d'attestations.
   */
  private async done(networkId: string, agentId: string): Promise<Done[]> {
    const modules = await this.db.all<{ id: string; day: string; minutes: number; topic: AcademyTopic }>(
      `SELECT m.id AS id, c.completed_on AS day, m.duration_minutes AS minutes, m.topic AS topic FROM academy_completions c
       JOIN academy_modules m ON m.id = c.module_id AND m.network_id = c.network_id
       WHERE c.agent_id = ? AND c.network_id = ? AND m.mandatory = 1`,
      [agentId, networkId],
    );
    const attestations = await this.db.all<{ issued_on: string; document: string }>(
      'SELECT issued_on, document FROM quiz_attestations WHERE agent_id = ? AND network_id = ? ORDER BY issued_on, id',
      [agentId, networkId],
    );
    const provedOn = new Map<string, string>();
    for (const a of attestations) {
      let doc: { agentId?: unknown; modules?: unknown };
      try {
        doc = JSON.parse(a.document) as { agentId?: unknown; modules?: unknown };
      } catch {
        continue;
      }
      if (doc.agentId !== agentId || !Array.isArray(doc.modules)) continue;
      for (const m of doc.modules as unknown[]) {
        const id = (m as { moduleId?: unknown } | null)?.moduleId;
        if (typeof id === 'string' && !provedOn.has(id)) provedOn.set(id, a.issued_on);
      }
    }
    const sessions = await this.db.all<{ day: string; minutes: number; topic: AcademyTopic }>(
      `SELECT s.held_on AS day, s.duration_minutes AS minutes, s.topic AS topic FROM academy_attendance a
       JOIN academy_sessions s ON s.id = a.session_id AND s.network_id = a.network_id
       WHERE a.agent_id = ? AND a.network_id = ? AND s.mandatory = 1`,
      [agentId, networkId],
    );
    const prior = await this.db.all<{ day: string; minutes: number; topic: AcademyTopic }>(
      "SELECT day, duration_minutes AS minutes, topic FROM academy_prior_entries WHERE agent_id = ? AND network_id = ? AND kind = 'formation'",
      [agentId, networkId],
    );
    const fromModules = modules.map((m): Done => {
      const proof = provedOn.get(m.id);
      if (proof === undefined) return { day: m.day, minutes: m.minutes, topic: m.topic, proved: false };
      return { day: proof > m.day ? proof : m.day, minutes: m.minutes, topic: m.topic, proved: true };
    });
    return [...fromModules, ...sessions.map((x): Done => ({ ...x, proved: true })), ...prior.map((x): Done => ({ ...x, proved: true }))];
  }

  private async compute(networkId: string, agentId: string, today: string): Promise<TrainingCounter> {
    const arrivedOn = await this.arrivedOn(networkId, agentId);
    const prior = await this.priorPeriod(networkId, agentId);
    const startedOn = prior ?? arrivedOn;
    const done = await this.done(networkId, agentId);
    const s = this.settings;
    const sum = (proved: boolean, p: { from: string; until: string }, topic?: AcademyTopic): number =>
      done.filter((d) => d.proved === proved && d.day >= p.from && d.day <= p.until && (topic === undefined || d.topic === topic)).reduce((a, d) => a + d.minutes, 0);
    const year = periodOf(startedOn, today < startedOn ? startedOn : today, 1);
    const three = periodOf(startedOn, today < startedOn ? startedOn : today, 3);
    const line = (obligation: Obligation, p: { from: string; until: string }, required: number, topic?: AcademyTopic): ObligationStatus => {
      const doneMinutes = sum(true, p, topic);
      return {
        obligation,
        from: p.from,
        until: p.until,
        requiredMinutes: required,
        doneMinutes,
        declaredMinutes: sum(false, p, topic),
        missingMinutes: Math.max(0, required - doneMinutes),
        daysLeft: daysBetween(today, p.until),
      };
    };
    return {
      agentId,
      startedOn,
      arrivedOn,
      periodSource: prior === null ? 'arrivee' : 'cycle_anterieur',
      obligations: [
        line('annuelle', year, s.annualMinutes),
        line('triennale', three, s.triennialMinutes),
        line('deontologie', three, s.deontologyMinutes, 'deontologie'),
        line('non_discrimination', three, s.nonDiscriminationMinutes, 'non_discrimination'),
      ],
    };
  }

  /**
   * Les alertes du jour, pour le planificateur (J13) : pour chaque agent actif et chaque obligation qui manque, une
   * alerte au palier le plus proche atteint (90 puis 30 jours avant l'échéance), une seule fois [R85].
   */
  async dueAlerts(networkId: string): Promise<AcademyAlert[]> {
    const today = this.today();
    const agents = await this.db.all<{ id: string }>("SELECT id FROM agents WHERE network_id = ? AND status = 'active' ORDER BY id", [networkId]);
    const thresholds = [...this.settings.alertDays].sort((a, b) => a - b);
    const out: AcademyAlert[] = [];
    for (const { id } of agents) {
      const counter = await this.compute(networkId, id, today);
      for (const o of counter.obligations) {
        if (o.missingMinutes === 0 || o.daysLeft < 0) continue;
        const reached = thresholds.find((t) => o.daysLeft <= t);
        if (reached === undefined) continue;
        const { changes } = await this.db.run(
          `INSERT INTO academy_alerts (agent_id, network_id, obligation, period_end, days_before, missing_minutes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT DO NOTHING`,
          [id, networkId, o.obligation, o.until, reached, o.missingMinutes, this.now().toISOString()],
        );
        if (changes !== 1) continue;
        out.push({
          agentId: id,
          obligation: o.obligation,
          until: o.until,
          daysBefore: reached,
          missingMinutes: o.missingMinutes,
          text: `Il vous reste ${hours(o.missingMinutes)} ${LABEL[o.obligation]} à faire avant le ${frDate(o.until)}, à votre rythme.`,
        });
        await appendEvent(this.journal, { type: 'academie.alerte', actor: 'system:academie', subject: `agent:${id}`, data: { obligation: o.obligation, daysBefore: reached, missingMinutes: o.missingMinutes } }, this.now);
      }
    }
    return out;
  }
}
