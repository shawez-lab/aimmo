/**
 * Séquence de prospection sur plusieurs canaux (HX20) [R300, R301, R302].
 *
 * Une séquence, c'est une suite d'étapes pour une seule personne, sur mail, SMS, appel, courrier et porte-à-porte,
 * chacune à un nombre de jours du départ. L'agent de la fiche la prépare ; rien ne part au départ.
 *
 * - Aucun envoi hors du contrôle central [R300] : un mail ou un SMS ne part que par `ControleEnvois.send`, avec la
 *   finalité « prospection » et un sujet propre à l'étape ; ce module n'appelle jamais un canal. Un refus du contrôle
 *   est rangé avec sa règle. Un appel, un courrier, un passage à la porte ne partent pas d'ici : ils sont proposés à
 *   l'agent dans son plan du jour, qui les fait lui-même et le note.
 * - Arrêt sur tous les canaux [R301] : à chaque lecture et à chaque passage, avant toute étape, la séquence s'arrête
 *   d'elle-même et pour de bon à la première réponse de la personne (un message reçu d'elle, fiches réunies comprises),
 *   à la première opposition (exclusion ou demande d'arrêt, accord retiré, refus noté au téléphone, inscription sur la
 *   liste d'opposition au démarchage téléphonique), si la fiche change d'agent ou si l'agent part. La base refuse toute
 *   issue d'étape d'une séquence arrêtée.
 * - Appel dans les heures permises [R302] : une étape d'appel n'est proposée que si le bouton d'appel de la fiche est
 *   ouvert à cet instant (accord, fréquence et heures de AC06 [R203, R204]). Quand l'appel ne repose que sur la
 *   prospection acceptée, le numéro doit aussi avoir été vérifié absent de la liste d'opposition (Bloctel) ; sans
 *   vérification possible, l'appel n'est pas proposé.
 *
 * Au journal : des identifiants et des issues, jamais un texte ni une coordonnée [R13].
 */
import type { Acces } from '../acces/acces.ts';
import type { Viewer } from '../acces/droits.ts';
import { agentState } from '../acces/etat-agent.ts';
import type { AppelsFiche } from '../acces/appels.ts';
import { CALL_FREQUENCY, type FicheAgent } from '../acces/fiche-agent.ts';
import type { SqlDatabase } from '../db/sql.ts';
import type { ControleEnvois, SendResult } from '../envoi/controle.ts';
import { localTime } from '../envoi/horaires.ts';
import type { FicheUnique } from '../fiche/fusion.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';

export const SEQUENCE_CHANNELS = ['email', 'sms', 'phone', 'letter', 'door'] as const;
export type SequenceChannel = (typeof SEQUENCE_CHANNELS)[number];
export const SEQUENCE_MAX_STEPS = 8;
export const SEQUENCE_MAX_DAYS = 90;
const TIME_ZONE = 'Europe/Paris';
const DAY_MS = 86_400_000;

export type EndReason = 'reply' | 'excluded' | 'withdrawn' | 'call_refused' | 'opposition_list' | 'reassigned' | 'agent_gone' | 'refused_send' | 'merged';

export interface StepInput {
  channel: SequenceChannel;
  /** Jours après le départ, de 0 à 90, jamais avant l'étape d'avant. */
  afterDays: number;
  /** Le texte d'un mail ou d'un SMS, écrit par l'agent ; contrôlé de nouveau par le contrôle central au départ. */
  text?: string;
}

/** La liste d'opposition au démarchage téléphonique (Bloctel), en port : le vrai service attend un humain (H61). */
export interface OppositionList {
  check(phone: string, at: Date): Promise<'listed' | 'not_listed' | 'unavailable'>;
}

export interface TodayStep {
  sequenceId: string;
  stepId: string;
  position: number;
  channel: SequenceChannel;
  personId: string;
  firstName: string | null;
  /** `auto` : mail ou SMS, part seul par le contrôle central au prochain passage. */
  action: 'auto' | 'call' | 'letter' | 'door';
  /** L'agent peut la faire maintenant. */
  proposed: boolean;
  /** Pourquoi elle n'est pas proposée ; null sinon. */
  reason: string | null;
  /** Le numéro à appeler, seulement si l'appel est proposé. */
  call: string | null;
  /** Fin du créneau d'appel quand l'appel ne repose que sur la prospection [R203]. */
  callClosesAt: string | null;
}

export type Refusal = { ok: false; rule: string; code: string };
export type Result<T> = { ok: true; value: T } | Refusal;

export interface SequencesOptions {
  now?: () => Date;
  newId?: () => string;
  opposition?: OppositionList;
}

interface SequenceRow {
  id: string;
  network_id: string;
  agent_id: string;
  person_id: string;
  started_at: string;
  start_day: string;
  status: 'active' | 'stopped' | 'finished';
}

interface StepRow {
  id: string;
  sequence_id: string;
  position: number;
  channel: SequenceChannel;
  after_days: number;
  body: string | null;
  outcome: 'sent' | 'done' | 'skipped' | null;
}

const placeholders = (n: number): string => Array.from({ length: n }, () => '?').join(', ');

/** Le jour `AAAA-MM-JJ` plus `n` jours, au calendrier. */
export function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T12:00:00.000Z`) + n * DAY_MS).toISOString().slice(0, 10);
}

/** Les règles du contrôle qui disent une opposition de la personne : la séquence s'arrête partout [R301]. */
const OPPOSITION_RULES: Readonly<Record<string, EndReason>> = Object.freeze({ R02: 'excluded', R04: 'excluded', R86: 'agent_gone' });
/** Les règles qui disent « pas maintenant » : l'étape attend le passage suivant. */
const WAIT_RULES: readonly string[] = Object.freeze(['R01', 'R11']);

export class SequencesProspection {
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly opposition: OppositionList | null;

  constructor(
    private readonly db: SqlDatabase,
    private readonly acces: Acces,
    private readonly fiche: FicheUnique,
    private readonly controle: ControleEnvois,
    private readonly ficheAgent: FicheAgent,
    private readonly appels: AppelsFiche,
    private readonly journal: JournalStore,
    options: SequencesOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => crypto.randomUUID());
    this.opposition = options.opposition ?? null;
  }

  private actor(viewer: Viewer): string {
    return `${String(viewer.role)}:${viewer.userId}`;
  }

  private async refuse(viewer: Viewer, subject: string | null, rule: string, code: string): Promise<Refusal> {
    await appendEvent(this.journal, { type: 'acces.refuse', actor: this.actor(viewer), subject, data: { rule, role: String(viewer.role), kind: 'sequence_prospection', code } }, this.now);
    return { ok: false, rule, code };
  }

  private async activeAgent(viewer: Viewer): Promise<Refusal | null> {
    if (viewer.role !== 'agent') return this.refuse(viewer, null, 'R16', 'role');
    const a = await this.db.first<{ id: string }>('SELECT id FROM agents WHERE id = ? AND network_id = ?', [viewer.userId, viewer.networkId]);
    if (!a || (await agentState(this.db, viewer.networkId, viewer.userId, this.now())) !== 'actif') return this.refuse(viewer, null, 'R16', 'agent_inactive');
    return null;
  }

  /** Prépare une séquence pour une fiche de l'agent. Rien ne part ici. */
  async start(viewer: Viewer, input: { personId: string; steps: readonly StepInput[] }): Promise<Result<{ sequenceId: string }>> {
    const blocked = await this.activeAgent(viewer);
    if (blocked) return blocked;
    const read = await this.acces.readFiche(viewer, input.personId);
    if (!read.ok) return { ok: false, rule: read.rule, code: read.code };
    if (read.view !== 'full') return this.refuse(viewer, `person:${input.personId}`, 'R16', 'not_assigned');
    const steps = input.steps;
    if (steps.length === 0 || steps.length > SEQUENCE_MAX_STEPS) return this.refuse(viewer, null, 'HX20', 'steps_count');
    let previous = 0;
    for (const s of steps) {
      if (!SEQUENCE_CHANNELS.includes(s.channel)) return this.refuse(viewer, null, 'HX20', 'channel');
      if (!Number.isInteger(s.afterDays) || s.afterDays < previous || s.afterDays > SEQUENCE_MAX_DAYS) return this.refuse(viewer, null, 'HX20', 'after_days');
      previous = s.afterDays;
      const written = s.channel === 'email' || s.channel === 'sms';
      const text = s.text?.trim() ?? '';
      if (written !== (text.length > 0) || text.length > 1000) return this.refuse(viewer, null, 'HX20', 'text');
    }
    const fiche = read.value;
    const root = fiche.person.id;
    const at = this.now();
    // Une personne déjà opposée ne reçoit pas de séquence [R301].
    const stop = await this.stopReason({ id: '', network_id: viewer.networkId, agent_id: viewer.userId, person_id: root, started_at: at.toISOString(), start_day: '', status: 'active' }, at);
    if (stop) return this.refuse(viewer, `person:${root}`, stop.rule, `opposition_${stop.reason}`);
    const ids = fiche.members.map((m) => m.id);
    // Une opposition d'avant le départ compte aussi : un accord retiré sans accord redonné depuis sur ce canal et pour
    // cette finalité, ou un refus noté au téléphone dans la période de R204 [R301].
    const withdrawn = fiche.consents.some(
      (c) =>
        c.withdrawn_at !== null &&
        !fiche.consents.some((n) => n.channel === c.channel && n.purpose === c.purpose && n.withdrawn_at === null && Date.parse(n.given_at) > Date.parse(c.withdrawn_at as string)),
    );
    if (withdrawn) return this.refuse(viewer, `person:${root}`, 'R03', 'opposition_withdrawn');
    const refusedCall = await this.db.first<{ n: number }>(
      `SELECT COUNT(*) AS n FROM call_notes WHERE outcome = 'refused' AND noted_at > ? AND person_id IN (${placeholders(ids.length)})`,
      [new Date(at.getTime() - CALL_FREQUENCY.refusalDays * DAY_MS).toISOString(), ...ids],
    );
    if (Number(refusedCall?.n ?? 0) > 0) return this.refuse(viewer, `person:${root}`, 'R204', 'opposition_call_refused');
    const running = await this.db.first<{ id: string }>(`SELECT id FROM prospecting_sequences WHERE status = 'active' AND person_id IN (${placeholders(ids.length)})`, ids);
    if (running) return this.refuse(viewer, `person:${root}`, 'HX20', 'already_active');

    const id = this.newId();
    await this.db.run(
      `INSERT INTO prospecting_sequences (id, network_id, agent_id, person_id, started_at, start_day, status) VALUES (?, ?, ?, ?, ?, ?, 'active')`,
      [id, viewer.networkId, viewer.userId, root, at.toISOString(), localTime(at, TIME_ZONE).date],
    );
    let position = 0;
    for (const s of steps) {
      position += 1;
      const written = s.channel === 'email' || s.channel === 'sms';
      await this.db.run('INSERT INTO prospecting_sequence_steps (id, sequence_id, network_id, position, channel, after_days, body) VALUES (?, ?, ?, ?, ?, ?, ?)', [
        this.newId(),
        id,
        viewer.networkId,
        position,
        s.channel,
        s.afterDays,
        written ? (s.text as string).trim() : null,
      ]);
    }
    await appendEvent(this.journal, { type: 'sequence.preparee', actor: this.actor(viewer), subject: `prospecting_sequence:${id}`, data: { rule: 'R300', steps: steps.length, channels: steps.map((s) => s.channel) } }, this.now);
    return { ok: true, value: { sequenceId: id } };
  }

  /**
   * Pourquoi la séquence doit s'arrêter maintenant, ou null [R301]. Tout ce qui s'est passé depuis le départ compte,
   * sur toutes les fiches réunies ; une exclusion en cours compte d'où qu'elle vienne.
   */
  private async stopReason(seq: SequenceRow, at: Date): Promise<{ reason: EndReason; rule: string } | null> {
    if ((await agentState(this.db, seq.network_id, seq.agent_id, at)) === 'parti') return { reason: 'agent_gone', rule: 'R86' };
    // La liste d'opposition au démarchage vaut pour toute la séquence, pas seulement pour ses appels [R301, R302].
    // Regardée d'abord : le service peut être lent, la fiche est lue après lui, réponses comprises.
    if (this.opposition) {
      // Tous les numéros de la fiche, fiches réunies comprises : le contrôle peut viser n'importe lequel.
      const numbers = new Set(
        (await this.fiche.view(seq.person_id)).identifiers
          .filter((i) => i.kind === 'phone')
          .map((i) => i.value.replace(/[^+\d]/g, ''))
          .filter((d) => /^\+?\d{6,15}$/.test(d)),
      );
      for (const digits of numbers) {
        let listed: 'listed' | 'not_listed' | 'unavailable' = 'unavailable';
        try {
          listed = await this.opposition.check(digits, at);
        } catch {
          listed = 'unavailable';
        }
        if (listed === 'listed') return { reason: 'opposition_list', rule: 'R302' };
      }
    }
    const view = await this.fiche.view(seq.person_id);
    const stamp = at.getTime();
    const since = Date.parse(seq.started_at);
    // Une exclusion en cours, ou qui a couru pendant la séquence même si elle est levée depuis : la levée ne relance rien.
    const exclusion = view.exclusions.find((e) => Date.parse(e.noted_at) <= stamp && (e.lifted_at === null || Date.parse(e.lifted_at) > Math.min(stamp, since)));
    if (exclusion) return { reason: 'excluded', rule: exclusion.reason === 'stop' ? 'R04' : 'R02' };
    if (view.consents.some((c) => c.withdrawn_at !== null && Date.parse(c.withdrawn_at) >= since)) return { reason: 'withdrawn', rule: 'R03' };
    if (view.messages.some((m) => m.direction === 'in' && Date.parse(m.occurred_at) >= since)) return { reason: 'reply', rule: 'R301' };
    const ids = view.members.map((m) => m.id);
    const refused = await this.db.first<{ n: number }>(
      `SELECT COUNT(*) AS n FROM call_notes WHERE outcome = 'refused' AND noted_at >= ? AND person_id IN (${placeholders(ids.length)})`,
      [seq.started_at, ...ids],
    );
    if (Number(refused?.n ?? 0) > 0) return { reason: 'call_refused', rule: 'R204' };
    if (seq.id !== '' && !view.members.some((m) => m.agent_id === seq.agent_id)) return { reason: 'reassigned', rule: 'R16' };
    // Deux fiches réunies qui avaient chacune leur séquence : seule la plus ancienne continue, une seule par personne [R300].
    if (seq.id !== '') {
      const older = await this.db.first<{ id: string }>(
        `SELECT id FROM prospecting_sequences WHERE id <> ? AND person_id IN (${placeholders(ids.length)})
         AND (started_at < ? OR (started_at = ? AND id < ?)) AND (ended_at IS NULL OR ended_at >= ?) LIMIT 1`,
        [seq.id, ...ids, seq.started_at, seq.started_at, seq.id, seq.started_at],
      );
      // Une plus ancienne qui courait encore au départ de celle-ci, finie ou non depuis : celle-ci n'aurait pas dû courir.
      if (older) return { reason: 'merged', rule: 'R300' };
    }
    return null;
  }

  private async end(seq: SequenceRow, reason: EndReason | 'done', rule: string, actor: string): Promise<void> {
    const status = reason === 'done' ? 'finished' : 'stopped';
    const changed = await this.db.run(`UPDATE prospecting_sequences SET status = ?, ended_at = ?, end_reason = ?, end_rule = ? WHERE id = ? AND status = 'active'`, [
      status,
      this.now().toISOString(),
      reason,
      rule,
      seq.id,
    ]);
    if (changed.changes === 0) return;
    seq.status = status;
    await appendEvent(this.journal, { type: reason === 'done' ? 'sequence.finie' : 'sequence.arretee', actor, subject: `prospecting_sequence:${seq.id}`, data: { rule, reason } }, this.now);
  }

  /** Relit la séquence et l'arrête si elle doit l'être. Rend vrai si elle est encore en cours. */
  private async refresh(seq: SequenceRow, actor: string): Promise<boolean> {
    if (seq.status !== 'active') return false;
    const stop = await this.stopReason(seq, this.now());
    if (stop) {
      await this.end(seq, stop.reason, stop.rule, actor);
      return false;
    }
    return true;
  }

  /** L'étape à faire : la première sans issue, si son jour est venu. */
  private async currentStep(seq: SequenceRow, day: string): Promise<StepRow | null> {
    const step = await this.db.first<StepRow>('SELECT * FROM prospecting_sequence_steps WHERE sequence_id = ? AND outcome IS NULL ORDER BY position LIMIT 1', [seq.id]);
    if (!step) return null;
    return addDays(seq.start_day, Number(step.after_days)) <= day ? { ...step, position: Number(step.position), after_days: Number(step.after_days) } : null;
  }

  private async settle(seq: SequenceRow, step: StepRow, outcome: 'sent' | 'done' | 'skipped', rule: string | null, messageId: string | null, actor: string): Promise<boolean> {
    const changed = await this.db.run(`UPDATE prospecting_sequence_steps SET outcome = ?, rule = ?, message_id = ?, ended_at = ? WHERE id = ? AND outcome IS NULL`, [
      outcome,
      rule,
      messageId,
      this.now().toISOString(),
      step.id,
    ]);
    if (changed.changes === 0) return false;
    await appendEvent(this.journal, { type: 'sequence.etape', actor, subject: `prospecting_sequence:${seq.id}`, data: { rule: rule ?? 'R300', position: step.position, channel: step.channel, outcome } }, this.now);
    const left = await this.db.first<{ n: number }>('SELECT COUNT(*) AS n FROM prospecting_sequence_steps WHERE sequence_id = ? AND outcome IS NULL', [seq.id]);
    if (Number(left?.n ?? 0) === 0) await this.end(seq, 'done', 'R300', actor);
    return true;
  }

  /**
   * Un appel peut-il être proposé maintenant ? Le bouton de la fiche décide (accord, fréquence, heures) [R203, R204] ;
   * un appel sur la seule prospection exige en plus le numéro vérifié hors de la liste d'opposition [R302].
   */
  private async callCheck(viewer: Viewer, seq: SequenceRow): Promise<{ proposed: true; call: string; closesAt: string | null } | { proposed: false; reason: string; stop?: true }> {
    const read = await this.ficheAgent.read(viewer, seq.person_id);
    if (!read.ok) return { proposed: false, reason: read.code };
    const f = read.value;
    if (f.call === null) return { proposed: false, reason: f.callRefusal ?? 'no_consent' };
    if (f.callClosesAt === null) return { proposed: true, call: f.call, closesAt: null };
    if (!this.opposition) return { proposed: false, reason: 'opposition_unchecked' };
    let listed: 'listed' | 'not_listed' | 'unavailable';
    try {
      listed = await this.opposition.check(f.call.slice('tel:'.length), this.now());
    } catch {
      listed = 'unavailable';
    }
    if (listed === 'listed') return { proposed: false, reason: 'opposition_list', stop: true };
    if (listed !== 'not_listed') return { proposed: false, reason: 'opposition_unchecked' };
    // Le service a pu prendre du temps : l'appel est relu à cet instant, heures comprises, et doit viser le même numéro.
    const again = await this.ficheAgent.read(viewer, seq.person_id);
    if (!again.ok) return { proposed: false, reason: again.code };
    if (again.value.call === null) return { proposed: false, reason: again.value.callRefusal ?? 'no_consent' };
    if (again.value.call !== f.call) return { proposed: false, reason: 'opposition_unchecked' };
    return { proposed: true, call: again.value.call, closesAt: again.value.callClosesAt };
  }

  private async sequencesOf(viewer: Viewer): Promise<SequenceRow[]> {
    return this.db.all<SequenceRow>(`SELECT * FROM prospecting_sequences WHERE network_id = ? AND agent_id = ? AND status = 'active' ORDER BY started_at, id`, [viewer.networkId, viewer.userId]);
  }

  /** Les étapes du jour de l'agent, pour son plan du jour (G01). Les séquences à arrêter s'arrêtent ici. */
  async today(viewer: Viewer): Promise<Result<{ day: string; steps: TodayStep[] }>> {
    const blocked = await this.activeAgent(viewer);
    if (blocked) return blocked;
    const day = localTime(this.now(), TIME_ZONE).date;
    const out: TodayStep[] = [];
    for (const seq of await this.sequencesOf(viewer)) {
      if (!(await this.refresh(seq, this.actor(viewer)))) continue;
      const step = await this.currentStep(seq, day);
      if (!step) continue;
      const view = await this.fiche.view(seq.person_id);
      const firstName = view.members.map((m) => m.first_name).find((n) => n) ?? null;
      const base = { sequenceId: seq.id, stepId: step.id, position: step.position, channel: step.channel, personId: seq.person_id, firstName, call: null, callClosesAt: null };
      if (step.channel === 'email' || step.channel === 'sms') {
        out.push({ ...base, action: 'auto', proposed: false, reason: 'part_par_le_controle_central' });
      } else if (step.channel === 'phone') {
        const c = await this.callCheck(viewer, seq);
        if (!c.proposed && c.stop) {
          await this.end(seq, 'opposition_list', 'R302', this.actor(viewer));
          continue;
        }
        out.push(c.proposed ? { ...base, action: 'call', proposed: true, reason: null, call: c.call, callClosesAt: c.closesAt } : { ...base, action: 'call', proposed: false, reason: c.reason });
      } else {
        out.push({ ...base, action: step.channel, proposed: true, reason: null });
      }
    }
    return { ok: true, value: { day, steps: out } };
  }

  /**
   * L'agent note fait un appel, un courrier ou un passage à la porte. Revérifié à cet instant [R301, R302]. Un appel
   * dit son issue (`called` ou `refused`) : il est noté dans les appels de la fiche, il compte dans la fréquence [R204],
   * et un refus arrête la séquence sur tous les canaux [R301].
   */
  async markDone(viewer: Viewer, stepId: string, input: { callOutcome?: 'called' | 'refused' } = {}): Promise<Result<{ finished: boolean; stopped: boolean }>> {
    const blocked = await this.activeAgent(viewer);
    if (blocked) return blocked;
    const subject = `prospecting_sequence_step:${stepId}`;
    const row = await this.db.first<SequenceRow & { step_channel: string }>(
      `SELECT s.*, st.channel AS step_channel FROM prospecting_sequence_steps st JOIN prospecting_sequences s ON s.id = st.sequence_id WHERE st.id = ? AND s.network_id = ?`,
      [stepId, viewer.networkId],
    );
    if (!row || row.agent_id !== viewer.userId) return this.refuse(viewer, subject, 'R16', 'unknown');
    const seq: SequenceRow = { id: row.id, network_id: row.network_id, agent_id: row.agent_id, person_id: row.person_id, started_at: row.started_at, start_day: row.start_day, status: row.status };
    if (!(await this.refresh(seq, this.actor(viewer)))) return this.refuse(viewer, subject, 'R301', 'stopped');
    const step = await this.currentStep(seq, localTime(this.now(), TIME_ZONE).date);
    if (!step || step.id !== stepId) return this.refuse(viewer, subject, 'HX20', 'not_due');
    if (step.channel === 'email' || step.channel === 'sms') return this.refuse(viewer, subject, 'R300', 'sent_by_control');
    if (step.channel === 'phone') {
      if (input.callOutcome !== 'called' && input.callOutcome !== 'refused') return this.refuse(viewer, subject, 'R204', 'call_outcome');
      const c = await this.callCheck(viewer, seq);
      if (!c.proposed) {
        if (c.stop) await this.end(seq, 'opposition_list', 'R302', this.actor(viewer));
        return this.refuse(viewer, subject, 'R302', c.reason);
      }
      const noted = await this.appels.note(viewer, seq.person_id, { outcome: input.callOutcome });
      if (!noted.ok) return this.refuse(viewer, subject, noted.rule ?? 'R204', noted.code);
      if (input.callOutcome === 'refused') {
        await this.end(seq, 'call_refused', 'R204', this.actor(viewer));
        return { ok: true, value: { finished: false, stopped: true } };
      }
    }
    await this.settle(seq, step, 'done', null, null, this.actor(viewer));
    return { ok: true, value: { finished: seq.status === 'finished', stopped: false } };
  }

  /**
   * Le passage : pour chaque séquence en cours, arrête ce qui doit l'être, puis remet au contrôle central les mails et
   * SMS dont le jour est venu [R300]. Rend des comptes.
   */
  async run(): Promise<{ sent: number; skipped: number; waiting: number; stopped: number }> {
    const counts = { sent: 0, skipped: 0, waiting: 0, stopped: 0 };
    const day = localTime(this.now(), TIME_ZONE).date;
    const all = await this.db.all<SequenceRow>(`SELECT * FROM prospecting_sequences WHERE status = 'active' ORDER BY started_at, id`);
    for (const seq of all) {
      for (let guard = 0; guard < SEQUENCE_MAX_STEPS; guard += 1) {
        if (!(await this.refresh(seq, 'system'))) {
          if (seq.status === 'stopped') counts.stopped += 1;
          break;
        }
        const step = await this.currentStep(seq, day);
        if (!step || (step.channel !== 'email' && step.channel !== 'sms')) break;
        const r: SendResult = await this.controle.send({
          networkId: seq.network_id,
          agentId: seq.agent_id,
          personId: seq.person_id,
          channel: step.channel,
          kind: 'prospecting',
          purpose: 'prospecting',
          subject: `sequence:${seq.id}:${step.position}`,
          fallbackTexts: [step.body as string],
          // Revérifié juste avant l'enregistrement : une réponse ou une opposition arrivée entre-temps retient l'envoi [R301].
          stillAllowed: async () => {
            const stop = await this.stopReason(seq, this.now());
            return stop ? { allowed: false, rule: stop.rule, reason: `sequence_${stop.reason}` } : { allowed: true, rule: 'R301', reason: 'en cours' };
          },
        });
        if (r.status === 'sent' && r.messageId && !r.trial) {
          await this.settle(seq, step, 'sent', null, r.messageId, 'system');
          counts.sent += 1;
          continue;
        }
        if (r.status === 'sent') {
          // Rangé dans la boîte d'essai : rien n'est parti, l'étape ne compte pas comme envoyée [R26].
          await this.settle(seq, step, 'skipped', 'R26', null, 'system');
          counts.skipped += 1;
          continue;
        }
        // Un refus peut venir d'un arrêt dû entre-temps : relu avant tout le reste [R301].
        if (!(await this.refresh(seq, 'system'))) {
          counts.stopped += 1;
          break;
        }
        if (r.status === 'failed' || (r.rule !== null && WAIT_RULES.includes(r.rule))) {
          counts.waiting += 1;
          break;
        }
        const opposed = r.rule !== null ? OPPOSITION_RULES[r.rule] : undefined;
        if (opposed) {
          await this.end(seq, opposed, r.rule as string, 'system');
          counts.stopped += 1;
          break;
        }
        await this.settle(seq, step, 'skipped', r.rule ?? 'refused_send', null, 'system');
        counts.skipped += 1;
      }
    }
    return counts;
  }
}
