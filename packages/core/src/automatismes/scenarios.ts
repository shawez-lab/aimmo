/**
 * Scénarios automatiques réglables, essayés avant d'être allumés (HX24).
 *
 * La direction compose ses scénarios : un déclencheur pris dans une liste fermée (un nouveau contact, un nouveau projet
 * d'un type choisi), une attente, un message au texte fixe et contrôlé, une tâche [R403]. Chaque version est gardée et
 * ne change jamais.
 *
 * Jamais vu : avant d'être allumée, une version est rejouée sur les faits datés du mois passé. L'essai dit combien de
 * messages elle aurait envoyés, à combien de personnes, combien le contrôle central en aurait refusé et pour quelle
 * règle, et combien de fois une personne aurait reçu deux messages de scénario le même jour, avec les scénarios déjà
 * allumés. Il n'envoie rien, ne range aucun message, aucun passage, aucune tâche [R400]. Un scénario n'est allumé que
 * par un essai de sa version exacte, plus récent que le dernier allumage du réseau, sans aucun double du même jour
 * [R400, R402].
 *
 * Allumé, un scénario ne regarde que les faits venus après son allumage, jamais le passé ; un fait ne le déclenche
 * qu'une fois. Son message ne part que par le contrôle central des envois, en mode essai : rien ne part vraiment
 * [R401, R26]. Une personne ne reçoit qu'un message de scénario par jour, tous scénarios confondus [R402]. Le journal
 * ne garde ni texte ni coordonnée [R13]. Rien ne s'efface [R17].
 */
import type { Viewer } from '../acces/droits.ts';
import { trialChannels } from '../captation/essai.ts';
import { FicheClient } from '../db/fiche-client.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { PROJECT_KINDS, type ProjectKind } from '../db/types.ts';
import { DEFAULT_SEND_SETTINGS, type SendRule } from '../envoi/decision.ts';
import { afterSendingTime, localTime, type SendingWindow } from '../envoi/horaires.ts';
import { SqlSendJournal } from '../envoi/journal-envois.ts';
import { DecisionEnvoi } from '../envoi/service.ts';
import { ControleEnvois, DEFAULT_CONTROLE_SETTINGS } from '../envoi/controle.ts';
import { DEFAULT_TEXT_SETTINGS, checkText, plain } from '../envoi/texte.ts';
import { FicheUnique } from '../fiche/fusion.ts';
import { ficheFirstName } from '../fiche/prenom.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';

/** Finalité de l'accord d'un message de scénario [R03]. */
export const AUTOMATION_PURPOSE = 'automatismes';
export const AUTOMATION_TRIGGERS = ['nouveau_contact', 'nouveau_projet'] as const;
export type AutomationTrigger = (typeof AUTOMATION_TRIGGERS)[number];
export const AUTOMATION_CHANNELS = ['email', 'sms', 'whatsapp'] as const;
export type AutomationChannel = (typeof AUTOMATION_CHANNELS)[number];
/** Le prénom de la personne, écrit une fois dans le texte du message. */
export const FIRST_NAME_SLOT = '{prenom}';

export interface ScenarioDefinition {
  name: string;
  trigger: AutomationTrigger;
  /** Seulement pour `nouveau_projet` : le type de projet, ou `null` pour tous. */
  projectKind: ProjectKind | null;
  waitHours: number;
  message: { channel: AutomationChannel; text: string } | null;
  task: { title: string; dueInDays: number } | null;
}

export interface ScenarioSettings {
  /** Jours du passé rejoués par l'essai. */
  simulationDays: number;
  /** Heures pendant lesquelles un essai permet d'allumer. */
  simulationValidHours: number;
  maxWaitHours: number;
  maxTaskDays: number;
  window: SendingWindow;
}

export const DEFAULT_SCENARIO_SETTINGS: ScenarioSettings = Object.freeze({
  simulationDays: 30,
  simulationValidHours: 24,
  maxWaitHours: 90 * 24,
  maxTaskDays: 30,
  window: Object.freeze({
    timeZone: DEFAULT_SEND_SETTINGS.timeZone,
    initiativeFrom: DEFAULT_SEND_SETTINGS.initiativeFrom,
    initiativeUntil: DEFAULT_SEND_SETTINGS.initiativeUntil,
    initiativeDays: DEFAULT_SEND_SETTINGS.initiativeDays,
  }),
});

export type ScenarioResult<T> = { ok: true; value: T } | { ok: false; rule: string | null; code: string };

export interface SimulationReport {
  simulationId: string;
  scenarioId: string;
  version: number;
  from: string;
  to: string;
  /** Messages que le contrôle central aurait laissés partir. */
  messages: number;
  /** Personnes qui les auraient reçus. */
  persons: number;
  tasks: number;
  /** Messages que le contrôle central aurait refusés, par règle. */
  refused: Record<string, number>;
  /** Messages qui seraient tombés le même jour qu'un autre message de scénario à la même personne [R402]. */
  sameDayTwice: number;
  /** Peut être allumé : aucun double du même jour. */
  canSwitchOn: boolean;
}

export interface TickReport {
  created: number;
  messagesInTrial: number;
  messagesRefused: number;
  tasks: number;
  postponed: number;
}

export interface ScenariosOptions {
  now?: () => Date;
  newId?: () => string;
  settings?: ScenarioSettings;
}

interface Fact {
  ref: string;
  personId: string;
  at: string;
}

interface Planned {
  scenarioId: string;
  ref: string;
  personId: string;
  dueAt: Date;
}

interface RunRow {
  id: string;
  scenario_id: string;
  version: number;
  trigger_ref: string;
  person_id: string;
  due_at: string;
}

/** La version citée est la dernière allumée du scénario : paramètres, le scénario, la version, le scénario [R401]. */
const STILL_LIT = `EXISTS (SELECT 1 FROM automation_switches w WHERE w.scenario_id = ? AND w.version = ? AND w.lit = 1
  AND w.seq = (SELECT MAX(seq) FROM automation_switches WHERE scenario_id = ?))`;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const isInt = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
const text = (v: unknown, max: number): string | null => (typeof v === 'string' && v.trim() !== '' && v.length <= max ? v.trim() : null);
const SAMPLE_FIRST_NAME = 'Camille';
/** Les coordonnées de la fiche par où part chaque canal, comme au contrôle central. */
const IDENTIFIER_FOR: Readonly<Record<AutomationChannel, readonly string[]>> = { email: ['email'], sms: ['phone'], whatsapp: ['whatsapp', 'phone'] };
/** Un texte comparé comme au contrôle central : minuscules, sans accents ni ponctuation [R05]. */
const sameText = (body: string): string => plain(body).replace(/[^a-z0-9]+/g, ' ').trim();
/** La plus longue mention que le contrôle central peut ajouter au premier message [R06]. */
const LONGEST_MENTION = Math.max(DEFAULT_CONTROLE_SETTINGS.mentionWithAgent.length + 40, DEFAULT_CONTROLE_SETTINGS.mentionWithoutAgent.length) + 2;

/** Le texte du message pour une personne : son prénom à la place de `{prenom}`, ou rien s'il n'est pas connu. */
export function renderScenarioText(template: string, firstName: string | null): string {
  const name = firstName?.trim() ?? '';
  return name === '' ? template.replace(/\s*\{prenom\}/, '').replace(/\s+,/, ',') : template.replace(FIRST_NAME_SLOT, name);
}

/** Lit une définition reçue, champ par champ, en listes fermées [R403]. */
export function parseScenario(input: unknown, settings: ScenarioSettings = DEFAULT_SCENARIO_SETTINGS): ScenarioResult<ScenarioDefinition> {
  const bad = (code: string, rule: string | null = 'R403'): ScenarioResult<ScenarioDefinition> => ({ ok: false, rule, code });
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return bad('bad_definition');
  const i = input as Record<string, unknown>;
  const allowed = new Set(['name', 'trigger', 'projectKind', 'waitHours', 'message', 'task']);
  if (Object.keys(i).some((k) => !allowed.has(k))) return bad('unknown_field');
  const name = text(i['name'], 80);
  if (name === null) return bad('bad_name');
  const trigger = i['trigger'];
  if (typeof trigger !== 'string' || !(AUTOMATION_TRIGGERS as readonly string[]).includes(trigger)) return bad('bad_trigger');
  const rawKind = i['projectKind'] ?? null;
  if (rawKind !== null && (trigger !== 'nouveau_projet' || typeof rawKind !== 'string' || !(PROJECT_KINDS as readonly string[]).includes(rawKind))) return bad('bad_project_kind');
  if (!isInt(i['waitHours'], 0, settings.maxWaitHours)) return bad('bad_wait');
  let message: ScenarioDefinition['message'] = null;
  const m = i['message'] ?? null;
  if (m !== null) {
    if (typeof m !== 'object' || Array.isArray(m)) return bad('bad_message');
    const mm = m as Record<string, unknown>;
    if (Object.keys(mm).some((k) => k !== 'channel' && k !== 'text')) return bad('unknown_field');
    const channel = mm['channel'];
    if (typeof channel !== 'string' || !(AUTOMATION_CHANNELS as readonly string[]).includes(channel)) return bad('bad_channel');
    const body = text(mm['text'], 4000);
    if (body === null) return bad('bad_text');
    // Le prénom une seule fois : le premier message s'adresse à la personne par son prénom [R08].
    if (body.split(FIRST_NAME_SLOT).length !== 2) return bad('first_name_slot');
    if (/[{}]/.test(body.replace(FIRST_NAME_SLOT, ''))) return bad('first_name_slot');
    // Le texte passe dès maintenant les contrôles du contrôle central, sans aucun chiffre [R06 à R10].
    for (const firstName of [SAMPLE_FIRST_NAME, null]) {
      const problems = checkText(renderScenarioText(body, firstName), { audience: 'client', channel: channel as AutomationChannel, firstOfConversation: true, firstName, figures: [] });
      if (problems.length > 0) return bad(`text_${problems[0]!.rule}`, problems[0]!.rule);
    }
    // Mention comprise, le texte tient dans le canal : sinon le contrôle central le refuserait à chaque envoi.
    if (body.replace(FIRST_NAME_SLOT, 'x'.repeat(40)).length + LONGEST_MENTION > DEFAULT_TEXT_SETTINGS.maxLength[channel as AutomationChannel]) return bad('text_length');
    message = { channel: channel as AutomationChannel, text: body };
  }
  let task: ScenarioDefinition['task'] = null;
  const t = i['task'] ?? null;
  if (t !== null) {
    if (typeof t !== 'object' || Array.isArray(t)) return bad('bad_task');
    const tt = t as Record<string, unknown>;
    if (Object.keys(tt).some((k) => k !== 'title' && k !== 'dueInDays')) return bad('unknown_field');
    const title = text(tt['title'], 120);
    if (title === null) return bad('bad_task_title');
    if (!isInt(tt['dueInDays'], 0, settings.maxTaskDays)) return bad('bad_task_due');
    task = { title, dueInDays: tt['dueInDays'] };
  }
  if (message === null && task === null) return bad('empty_scenario');
  return { ok: true, value: { name, trigger: trigger as AutomationTrigger, projectKind: rawKind as ProjectKind | null, waitHours: i['waitHours'] as number, message, task } };
}

export class ScenariosAutomatiques {
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly settings: ScenarioSettings;
  private readonly fiche: FicheUnique;
  private readonly decisions: DecisionEnvoi;
  private readonly controle: ControleEnvois;

  constructor(
    private readonly db: SqlDatabase,
    private readonly journal: JournalStore,
    options: ScenariosOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => crypto.randomUUID());
    this.settings = options.settings ?? DEFAULT_SCENARIO_SETTINGS;
    const store = new FicheClient(db, { now: this.now });
    this.fiche = new FicheUnique(db, store, { now: this.now });
    this.decisions = new DecisionEnvoi(db, store, this.fiche, { now: this.now });
    // Seuls les canaux du mode essai : aucun vrai canal ne peut être passé de l'extérieur [R26, R401].
    this.controle = new ControleEnvois(db, this.fiche, this.decisions, { channels: trialChannels(db, journal, this.now), journal: new SqlSendJournal(db, undefined, this.now), now: this.now });
  }

  private actor(viewer: Viewer): string {
    return `${String(viewer.role)}:${viewer.userId}`;
  }

  /** Seule la direction compose, essaie, allume et arrête un scénario [R403, R16]. */
  private async refuseUnlessDirection(viewer: Viewer, gesture: string): Promise<ScenarioResult<never> | null> {
    if (viewer.role === 'direction') return null;
    await appendEvent(this.journal, { type: 'acces.refuse', actor: this.actor(viewer), subject: null, data: { rule: 'R16', role: String(viewer.role), kind: 'automation_scenario', code: 'not_direction', gesture } }, this.now);
    return { ok: false, rule: 'R16', code: 'not_direction' };
  }

  private async latest(networkId: string, scenarioId: string): Promise<{ version: number; definition: ScenarioDefinition } | null> {
    const row = await this.db.first<{ version: number; definition: string }>('SELECT version, definition FROM automation_scenarios WHERE id = ? AND network_id = ? ORDER BY version DESC LIMIT 1', [scenarioId, networkId]);
    return row ? { version: row.version, definition: JSON.parse(row.definition) as ScenarioDefinition } : null;
  }

  private async definitionOf(scenarioId: string, version: number): Promise<ScenarioDefinition> {
    const row = await this.db.first<{ definition: string }>('SELECT definition FROM automation_scenarios WHERE id = ? AND version = ?', [scenarioId, version]);
    if (!row) throw new Error('Version de scénario introuvable.');
    return JSON.parse(row.definition) as ScenarioDefinition;
  }

  /** Les scénarios allumés du réseau : la version allumée et l'heure de l'allumage. */
  private async litScenarios(networkId: string): Promise<{ scenarioId: string; version: number; since: string }[]> {
    const rows = await this.db.all<{ scenario_id: string; version: number; lit: number; at: string }>(
      `SELECT s.scenario_id, s.version, s.lit, s.at FROM automation_switches s
       WHERE s.network_id = ? AND s.seq = (SELECT MAX(seq) FROM automation_switches WHERE scenario_id = s.scenario_id)
       ORDER BY s.scenario_id`,
      [networkId],
    );
    return rows.filter((r) => r.lit === 1).map((r) => ({ scenarioId: r.scenario_id, version: r.version, since: r.at }));
  }

  /** Compose un scénario, ou une nouvelle version d'un scénario du réseau. La version d'avant reste [R403, R17]. */
  async compose(viewer: Viewer, input: unknown, scenarioId: string | null = null): Promise<ScenarioResult<{ scenarioId: string; version: number }>> {
    const refused = await this.refuseUnlessDirection(viewer, 'compose');
    if (refused) return refused;
    const parsed = parseScenario(input, this.settings);
    if (!parsed.ok) return parsed;
    let id = scenarioId;
    let version = 1;
    if (id !== null) {
      const current = await this.latest(viewer.networkId, id);
      if (!current) return { ok: false, rule: 'R16', code: 'unknown' };
      version = current.version + 1;
    } else {
      id = this.newId();
    }
    await this.db.run('INSERT INTO automation_scenarios (id, version, network_id, definition, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)', [
      id,
      version,
      viewer.networkId,
      JSON.stringify(parsed.value),
      this.actor(viewer),
      this.now().toISOString(),
    ]);
    await appendEvent(this.journal, { type: 'automatismes.compose', actor: this.actor(viewer), subject: `scenario:${id}`, data: { rule: 'R403', version } }, this.now);
    return { ok: true, value: { scenarioId: id, version } };
  }

  /** Les faits datés qui déclenchent ce scénario, dans `[from, to)` : jamais une fiche reprise, réunie, ni d'un autre réseau. */
  private async facts(networkId: string, def: ScenarioDefinition, from: Date, to: Date): Promise<Fact[]> {
    const range = [networkId, from.toISOString(), to.toISOString()];
    const rows =
      def.trigger === 'nouveau_contact'
        ? await this.db.all<{ id: string; person_id: string; at: string }>(
            `SELECT p.id, p.id AS person_id, p.created_at AS at FROM persons p
             WHERE p.network_id = ? AND p.created_at >= ? AND p.created_at < ?
               AND NOT EXISTS (SELECT 1 FROM import_keys k WHERE k.network_id = p.network_id AND k.target_kind = 'person' AND k.target_id = p.id)
               AND NOT EXISTS (SELECT 1 FROM person_merges m WHERE m.merged_id = p.id AND m.undone_at IS NULL)
             ORDER BY p.created_at, p.id`,
            range,
          )
        : await this.db.all<{ id: string; person_id: string; at: string }>(
            `SELECT j.id, j.person_id, j.created_at AS at FROM projects j
             WHERE j.network_id = ? AND j.created_at >= ? AND j.created_at < ?${def.projectKind === null ? '' : ' AND j.kind = ?'}
               AND NOT EXISTS (SELECT 1 FROM import_keys k WHERE k.network_id = j.network_id AND k.target_kind = 'project' AND k.target_id = j.id)
             ORDER BY j.created_at, j.id`,
            def.projectKind === null ? range : [...range, def.projectKind],
          );
    const prefix = def.trigger === 'nouveau_contact' ? 'person' : 'project';
    const facts: Fact[] = [];
    for (const r of rows) facts.push({ ref: `${prefix}:${r.id}`, personId: await this.fiche.rootOf(r.person_id), at: r.at });
    return facts;
  }

  /** L'heure du passage : après l'attente, et pour un message, à la prochaine heure d'envoi permise [R01]. */
  private dueAt(def: ScenarioDefinition, triggeredAt: string): Date {
    const after = new Date(Date.parse(triggeredAt) + def.waitHours * HOUR);
    return def.message === null ? after : afterSendingTime(after, 0, this.settings.window);
  }

  private day(at: Date): string {
    return localTime(at, this.settings.window.timeZone).date;
  }

  /**
   * Ce que le contrôle central dirait d'un message, lu sans rien écrire : la décision à l'heure du passage [R01 à R04],
   * une coordonnée pour ce canal, et jamais deux fois le même texte à la même personne [R05]. `null` : il partirait.
   */
  private async preflight(message: NonNullable<ScenarioDefinition['message']>, fact: Fact, dueAt: Date, textsOf: Map<string, Set<string>>): Promise<string | null> {
    const decision = await this.decisions.decide(fact.personId, { channel: message.channel, kind: 'follow_up', purpose: AUTOMATION_PURPOSE, conversationId: null, at: dueAt });
    if (!decision.allowed) return (decision.rule as SendRule | null) ?? 'refus';
    const view = await this.fiche.view(fact.personId);
    if (!view.identifiers.some((i) => IDENTIFIER_FOR[message.channel].includes(i.kind))) return 'sans_coordonnee';
    const body = sameText(renderScenarioText(message.text, view.members.map((m) => m.first_name).find((n) => n) ?? null));
    let seen = textsOf.get(fact.personId);
    if (!seen) {
      seen = new Set<string>();
      for (const m of view.messages) {
        if (m.direction !== 'out') continue;
        seen.add(sameText(m.body));
        // Sans sa mention de premier message [R06].
        seen.add(sameText(m.body.split('\n\n').slice(1).join('\n\n')));
      }
      textsOf.set(fact.personId, seen);
    }
    if (seen.has(body)) return 'R05';
    seen.add(body);
    return null;
  }

  /**
   * Rejoue la dernière version sur les faits du mois passé, avec les scénarios déjà allumés. N'envoie rien, ne range ni
   * message, ni passage, ni tâche : seul le compte rendu de l'essai est gardé [R400, R402].
   */
  async simulate(viewer: Viewer, scenarioId: string): Promise<ScenarioResult<SimulationReport>> {
    const refused = await this.refuseUnlessDirection(viewer, 'simulate');
    if (refused) return refused;
    const current = await this.latest(viewer.networkId, scenarioId);
    if (!current) return { ok: false, rule: 'R16', code: 'unknown' };
    // Le nombre d'allumages est lu avant les scénarios allumés : un allumage venu pendant l'essai le rend caduc [R400].
    const revision = await this.litRevision(viewer.networkId);
    const to = this.now();
    const from = new Date(to.getTime() - this.settings.simulationDays * DAY);
    const def = current.definition;
    const facts = await this.facts(viewer.networkId, def, from, to);
    const refusedBy: Record<string, number> = {};
    /** Les textes déjà partis ou qui partiraient dans l'essai, par personne [R05]. */
    const textsOf = new Map<string, Set<string>>();
    const allowed: Planned[] = [];
    const refuse = (rule: string): void => {
      refusedBy[rule] = (refusedBy[rule] ?? 0) + 1;
    };
    let tasks = 0;
    for (const fact of facts) {
      const dueAt = this.dueAt(def, fact.at);
      if (def.task !== null) tasks += 1;
      if (def.message === null) continue;
      const rule = await this.preflight(def.message, fact, dueAt, textsOf);
      if (rule !== null) refuse(rule);
      else allowed.push({ scenarioId, ref: fact.ref, personId: fact.personId, dueAt });
    }
    // Les messages des scénarios déjà allumés, sur la même période, pour voir les doubles du même jour [R402].
    const others: Planned[] = [];
    const otherTexts = new Map<string, Set<string>>();
    for (const lit of await this.litScenarios(viewer.networkId)) {
      if (lit.scenarioId === scenarioId) continue;
      const otherDef = await this.definitionOf(lit.scenarioId, lit.version);
      if (otherDef.message === null) continue;
      // Seulement ce que le contrôle central leur aurait laissé envoyer [R400].
      for (const fact of await this.facts(viewer.networkId, otherDef, from, to)) {
        const dueAt = this.dueAt(otherDef, fact.at);
        if ((await this.preflight(otherDef.message, fact, dueAt, otherTexts)) === null) others.push({ scenarioId: lit.scenarioId, ref: fact.ref, personId: fact.personId, dueAt });
      }
    }
    const taken = new Set(others.map((p) => `${p.personId}|${this.day(p.dueAt)}`));
    let sameDayTwice = 0;
    for (const p of [...allowed].sort((a, b) => a.dueAt.getTime() - b.dueAt.getTime() || a.ref.localeCompare(b.ref))) {
      const key = `${p.personId}|${this.day(p.dueAt)}`;
      if (taken.has(key)) sameDayTwice += 1;
      else taken.add(key);
    }
    const persons = new Set(allowed.map((p) => p.personId)).size;
    const id = this.newId();
    await this.db.run(
      `INSERT INTO automation_simulations (id, network_id, scenario_id, version, period_from, period_to, messages, reached, tasks, refused, same_day_twice, lit_revision, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, viewer.networkId, scenarioId, current.version, from.toISOString(), to.toISOString(), allowed.length, persons, tasks, JSON.stringify(refusedBy), sameDayTwice, revision, this.actor(viewer), to.toISOString()],
    );
    await appendEvent(
      this.journal,
      { type: 'automatismes.essai', actor: this.actor(viewer), subject: `scenario:${scenarioId}`, data: { rule: 'R400', version: current.version, simulation: id, messages: allowed.length, persons, tasks, sameDayTwice, sent: false } },
      this.now,
    );
    return {
      ok: true,
      value: { simulationId: id, scenarioId, version: current.version, from: from.toISOString(), to: to.toISOString(), messages: allowed.length, persons, tasks, refused: refusedBy, sameDayTwice, canSwitchOn: sameDayTwice === 0 },
    };
  }

  /** Le nombre d'allumages du réseau : un essai ne vaut que si aucun autre allumage n'est venu depuis [R400]. */
  private async litRevision(networkId: string): Promise<number> {
    return (await this.db.first<{ n: number }>('SELECT COUNT(*) AS n FROM automation_switches WHERE network_id = ? AND lit = 1', [networkId]))?.n ?? 0;
  }

  private async nextSeq(scenarioId: string): Promise<number> {
    const row = await this.db.first<{ seq: number | null }>('SELECT MAX(seq) AS seq FROM automation_switches WHERE scenario_id = ?', [scenarioId]);
    return (row?.seq ?? 0) + 1;
  }

  /**
   * Allume la dernière version, seulement sur son propre essai, récent, fait après le dernier allumage du réseau, et sans
   * double du même jour [R400, R402].
   */
  async switchOn(viewer: Viewer, scenarioId: string): Promise<ScenarioResult<{ version: number }>> {
    const refused = await this.refuseUnlessDirection(viewer, 'switch_on');
    if (refused) return refused;
    const current = await this.latest(viewer.networkId, scenarioId);
    if (!current) return { ok: false, rule: 'R16', code: 'unknown' };
    const now = this.now();
    const sim = await this.db.first<{ id: string; same_day_twice: number; lit_revision: number; created_at: string }>(
      'SELECT id, same_day_twice, lit_revision, created_at FROM automation_simulations WHERE scenario_id = ? AND version = ? ORDER BY created_at DESC, rowid DESC LIMIT 1',
      [scenarioId, current.version],
    );
    const refuse = async (rule: string, code: string): Promise<ScenarioResult<{ version: number }>> => {
      await appendEvent(this.journal, { type: 'automatismes.allumage_refuse', actor: this.actor(viewer), subject: `scenario:${scenarioId}`, data: { rule, code, version: current.version } }, this.now);
      return { ok: false, rule, code };
    };
    if (!sim) return refuse('R400', 'not_simulated');
    if (now.getTime() - Date.parse(sim.created_at) > this.settings.simulationValidHours * HOUR) return refuse('R400', 'simulation_too_old');
    if (sim.lit_revision !== (await this.litRevision(viewer.networkId))) return refuse('R400', 'simulation_before_last_switch_on');
    if (sim.same_day_twice > 0) return refuse('R402', 'same_day_twice');
    // L'allumage n'est rangé que si aucun autre n'est venu entre-temps, dans la même écriture : de deux allumages
    // simultanés sur des essais du même état, un seul passe [R400].
    const inserted = await this.db.run(
      `INSERT INTO automation_switches (id, network_id, scenario_id, version, lit, simulation_id, at, seq, by)
       SELECT ?, ?, ?, ?, 1, ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM automation_switches WHERE network_id = ? AND lit = 1) = ?`,
      [this.newId(), viewer.networkId, scenarioId, current.version, sim.id, now.toISOString(), await this.nextSeq(scenarioId), this.actor(viewer), viewer.networkId, sim.lit_revision],
    );
    if (inserted.changes !== 1) return refuse('R400', 'simulation_before_last_switch_on');
    // Une version plus ancienne cède la place : ses passages en attente sont annulés, jamais effacés.
    await this.db.run("UPDATE automation_runs SET status = 'annule', done_at = ? WHERE scenario_id = ? AND version <> ? AND status = 'a_faire'", [now.toISOString(), scenarioId, current.version]);
    await appendEvent(this.journal, { type: 'automatismes.allume', actor: this.actor(viewer), subject: `scenario:${scenarioId}`, data: { rule: 'R400', version: current.version, simulation: sim.id } }, this.now);
    return { ok: true, value: { version: current.version } };
  }

  /** Arrête un scénario : ses passages en attente sont annulés, jamais effacés [R17]. */
  async switchOff(viewer: Viewer, scenarioId: string): Promise<ScenarioResult<{ cancelled: number }>> {
    const refused = await this.refuseUnlessDirection(viewer, 'switch_off');
    if (refused) return refused;
    const current = await this.latest(viewer.networkId, scenarioId);
    if (!current) return { ok: false, rule: 'R16', code: 'unknown' };
    const now = this.now().toISOString();
    await this.db.run('INSERT INTO automation_switches (id, network_id, scenario_id, version, lit, simulation_id, at, seq, by) VALUES (?, ?, ?, ?, 0, NULL, ?, ?, ?)', [
      this.newId(),
      viewer.networkId,
      scenarioId,
      current.version,
      now,
      await this.nextSeq(scenarioId),
      this.actor(viewer),
    ]);
    const cancelled = await this.db.run("UPDATE automation_runs SET status = 'annule', done_at = ? WHERE scenario_id = ? AND status = 'a_faire'", [now, scenarioId]);
    await appendEvent(this.journal, { type: 'automatismes.eteint', actor: this.actor(viewer), subject: `scenario:${scenarioId}`, data: { rule: 'R401', cancelled: cancelled.changes } }, this.now);
    return { ok: true, value: { cancelled: cancelled.changes } };
  }

  /**
   * Le passage du planificateur : range les faits venus depuis l'allumage, une fois chacun, puis fait les passages dus.
   * Chaque message passe par le contrôle central, en mode essai [R401, R26].
   */
  async tick(networkId: string): Promise<TickReport> {
    const report: TickReport = { created: 0, messagesInTrial: 0, messagesRefused: 0, tasks: 0, postponed: 0 };
    const now = this.now();
    const lit = await this.litScenarios(networkId);
    for (const s of lit) {
      const def = await this.definitionOf(s.scenarioId, s.version);
      // Jamais le passé : seulement les faits venus après l'allumage [R401].
      for (const fact of await this.facts(networkId, def, new Date(s.since), new Date(now.getTime() + 1))) {
        // Rangé seulement si cette version est encore celle allumée, dans la même écriture : un arrêt venu entre-temps
        // ne laisse naître aucun passage [R401].
        const inserted = await this.db.run(
          `INSERT OR IGNORE INTO automation_runs (id, network_id, scenario_id, version, trigger_ref, person_id, triggered_at, due_at, status, created_at)
           SELECT ?, ?, ?, ?, ?, ?, ?, ?, 'a_faire', ? WHERE ${STILL_LIT}`,
          [this.newId(), networkId, s.scenarioId, s.version, fact.ref, fact.personId, fact.at, this.dueAt(def, fact.at).toISOString(), now.toISOString(), s.scenarioId, s.version, s.scenarioId],
        );
        report.created += inserted.changes;
      }
    }
    const litVersion = new Map(lit.map((s) => [s.scenarioId, s.version]));
    const due = await this.db.all<RunRow>(
      "SELECT id, scenario_id, version, trigger_ref, person_id, due_at FROM automation_runs WHERE network_id = ? AND status = 'a_faire' AND due_at <= ? ORDER BY due_at, id",
      [networkId, now.toISOString()],
    );
    for (const run of due) {
      if (litVersion.get(run.scenario_id) !== run.version) {
        await this.db.run("UPDATE automation_runs SET status = 'annule', done_at = ? WHERE id = ? AND status = 'a_faire'", [now.toISOString(), run.id]);
        continue;
      }
      const def = await this.definitionOf(run.scenario_id, run.version);
      // Le soir ou le dimanche, le passage attend la prochaine heure permise, sans rien prendre [R01].
      if (def.message !== null) {
        const open = afterSendingTime(now, 0, this.settings.window);
        if (open.getTime() > now.getTime()) {
          await this.db.run("UPDATE automation_runs SET due_at = ? WHERE id = ? AND status = 'a_faire'", [open.toISOString(), run.id]);
          report.postponed += 1;
          continue;
        }
      }
      // Réserver le passage : deux planificateurs en même temps n'en font qu'un [R18].
      // Et seulement si sa version est encore celle allumée à cet instant [R401].
      const claimed = await this.db.run(`UPDATE automation_runs SET status = 'en_cours' WHERE id = ? AND status = 'a_faire' AND ${STILL_LIT}`, [run.id, run.scenario_id, run.version, run.scenario_id]);
      if (claimed.changes !== 1) continue;
      try {
        await this.execute(networkId, run, def, now, report);
      } catch (error) {
        // Une panne rend le passage à faire ; l'erreur remonte, jamais avalée.
        await this.db.run("UPDATE automation_runs SET status = 'a_faire' WHERE id = ? AND status = 'en_cours'", [run.id]);
        throw error;
      }
    }
    return report;
  }

  private async execute(networkId: string, run: RunRow, def: ScenarioDefinition, now: Date, report: TickReport): Promise<void> {
    // La fiche d'aujourd'hui : deux fiches réunies depuis le fait ne sont plus qu'une personne [R402].
    const root = await this.fiche.rootOf(run.person_id);
    const members = await this.fiche.membersOf(root);
    const person = await this.db.first<{ agent_id: string | null }>('SELECT agent_id FROM persons WHERE id = ?', [root]);
    const agentId = person?.agent_id ?? null;
    let messageStatus: 'essai' | 'refuse' | null = null;
    let messageRule: string | null = null;
    let messageId: string | null = null;
    if (def.message !== null) {
      const day = this.day(now);
      // Un seul message de scénario par personne et par jour, tous scénarios confondus [R402].
      // La place du jour est prise sous la fiche gardée ; une place prise avant la réunion sous une autre fiche compte aussi.
      // Une place rendue (message refusé) se reprend.
      await this.db.run('INSERT OR IGNORE INTO automation_daily_messages (network_id, person_id, day, run_id, created_at) VALUES (?, ?, ?, ?, ?)', [networkId, root, day, run.id, now.toISOString()]);
      await this.db.run('UPDATE automation_daily_messages SET run_id = ? WHERE network_id = ? AND person_id = ? AND day = ? AND run_id IS NULL', [run.id, networkId, root, day]);
      const holders = await this.db.all<{ run_id: string }>(
        `SELECT run_id FROM automation_daily_messages WHERE network_id = ? AND day = ? AND run_id IS NOT NULL AND person_id IN (${members.map(() => '?').join(', ')})`,
        [networkId, day, ...members],
      );
      if (!holders.some((h) => h.run_id === run.id) || holders.some((h) => h.run_id !== run.id)) {
        messageStatus = 'refuse';
        messageRule = 'R402';
      } else {
        const body = renderScenarioText(def.message.text, await ficheFirstName(this.db, members));
        const result = await this.controle.send({
          networkId,
          agentId,
          personId: root,
          channel: def.message.channel,
          kind: 'follow_up',
          purpose: AUTOMATION_PURPOSE,
          subject: `scenario:${run.scenario_id}:${run.trigger_ref}`,
          fallbackTexts: [body],
          figures: [],
        });
        // Refusé pour l'heure seulement (passé 20 h pendant le passage) : le passage attend la prochaine heure permise,
        // la place du jour est rendue, rien n'est perdu [R01].
        if (result.status === 'refused' && result.rule === 'R01') {
          await this.db.run('UPDATE automation_daily_messages SET run_id = NULL WHERE network_id = ? AND person_id = ? AND day = ? AND run_id = ?', [networkId, root, day, run.id]);
          await this.db.run("UPDATE automation_runs SET status = 'a_faire', due_at = ? WHERE id = ? AND status = 'en_cours'", [afterSendingTime(this.now(), 0, this.settings.window).toISOString(), run.id]);
          report.postponed += 1;
          return;
        }
        messageStatus = result.status === 'sent' ? 'essai' : 'refuse';
        // Refusé par le contrôle central, rien n'est parti : la place du jour est rendue à un autre scénario [R402].
        if (result.status !== 'sent') await this.db.run('UPDATE automation_daily_messages SET run_id = NULL WHERE network_id = ? AND person_id = ? AND day = ? AND run_id = ?', [networkId, root, day, run.id]);
        messageRule = result.status === 'sent' ? null : result.rule;
        messageId = result.messageId;
      }
      if (messageStatus === 'essai') report.messagesInTrial += 1;
      else report.messagesRefused += 1;
    }
    let taskId: string | null = null;
    if (def.task !== null) {
      taskId = this.newId();
      await this.db.run('INSERT INTO automation_tasks (id, network_id, run_id, agent_id, person_id, title, due_day, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [
        taskId,
        networkId,
        run.id,
        agentId,
        root,
        def.task.title,
        this.day(new Date(now.getTime() + def.task.dueInDays * DAY)),
        now.toISOString(),
      ]);
      report.tasks += 1;
    }
    await this.db.run("UPDATE automation_runs SET status = 'fait', message_status = ?, message_rule = ?, message_id = ?, task_id = ?, done_at = ? WHERE id = ? AND status = 'en_cours'", [
      messageStatus,
      messageRule,
      messageId,
      taskId,
      now.toISOString(),
      run.id,
    ]);
    await appendEvent(
      this.journal,
      { type: 'automatismes.passage', actor: 'system:automatismes', subject: `person:${root}`, data: { rule: 'R401', scenario: run.scenario_id, run: run.id, mode: 'essai', message: messageStatus, messageRule, task: taskId !== null } },
      this.now,
    );
  }
}
