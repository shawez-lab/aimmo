/**
 * Scénarios automatiques réglables, essayés avant d'être allumés (HX24).
 *
 * La direction compose ses scénarios : un déclencheur pris dans une liste fermée (un nouveau contact, un nouveau projet
 * d'un type choisi, une visite faite, un mandat signé), une attente, un message au texte fixe et contrôlé, une tâche
 * [R403]. Chaque version est gardée et ne change jamais.
 *
 * Une visite faite est une visite (rendez-vous relié à un bien et à un projet d'achat) notée honorée : le fait est cet
 * instant, la personne est l'acquéreur ; une visite annulée ou manquée ne déclenche rien. Un mandat signé est un mandat
 * inscrit au registre (R39) : le fait est l'inscription, la personne est le mandant ; un mandat signé et pas inscrit ne
 * déclenche rien, et un mandat retiré (annulation au registre, quelle qu'en soit la raison, ou rétractation) non plus :
 * son passage encore en attente est annulé, sans message ni tâche [R403, RC18].
 *
 * Jamais vu : avant d'être allumée, une version est rejouée sur les faits datés du mois passé. L'essai dit combien de
 * messages elle aurait envoyés, à combien de personnes, combien le contrôle central en aurait refusé et pour quelle
 * règle, et combien de fois une personne aurait reçu deux messages de scénario le même jour, avec les scénarios déjà
 * allumés. Il n'envoie rien, ne range aucun message, aucun passage, aucune tâche [R400]. Un scénario n'est allumé que
 * par un essai de sa version exacte, plus récent que le dernier allumage du réseau, sans aucun double du même jour
 * [R400, R402].
 *
 * Allumé, un scénario ne regarde que les faits venus après son allumage, jamais le passé ; un fait ne le déclenche
 * qu'une fois. Le passage relit les faits depuis le dernier rangé, moins une marge, pas toute l'histoire depuis
 * l'allumage [RC19]. Son message ne part que par le contrôle central des envois, en mode essai : rien ne part vraiment
 * [R401, R26]. Une personne ne reçoit qu'un message de scénario par jour, tous scénarios confondus, message de date compris [R402]. Le journal
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
export const AUTOMATION_TRIGGERS = ['nouveau_contact', 'nouveau_projet', 'visite_faite', 'mandat_signe'] as const;
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
  /**
   * Marge du passage, en heures : il relit les faits à partir du plus récent déjà rangé pour le scénario, moins cette
   * marge, jamais avant l'allumage [R401, RC19].
   */
  rescanHours: number;
  window: SendingWindow;
}

export const DEFAULT_SCENARIO_SETTINGS: ScenarioSettings = Object.freeze({
  simulationDays: 30,
  simulationValidHours: 24,
  maxWaitHours: 90 * 24,
  maxTaskDays: 30,
  rescanHours: 24,
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
  /** Messages qui seraient tombés le même jour qu'un autre message de scénario ou de date à la même personne [R402]. */
  sameDayTwice: number;
  /** Parmi eux, ceux qui tombent le jour d'un message de date remis ou en préparation, fiches réunies comprises [R402, RC10]. */
  sameDayAsDate: number;
  /** Peut être allumé : aucun double du même jour. */
  canSwitchOn: boolean;
}

/** Un scénario du réseau, lu par la direction : sa dernière version, son état et le dernier essai de cette version. */
export interface ScenarioSummary {
  scenarioId: string;
  /** La dernière version composée. */
  version: number;
  definition: ScenarioDefinition;
  composedAt: string;
  /** Allumé : la version allumée, peut-être plus ancienne que la dernière composée. */
  litVersion: number | null;
  litSince: string | null;
  /** Le dernier essai de la dernière version, ou `null` : sans lui, rien ne s'allume [R400]. */
  lastSimulation: {
    simulationId: string;
    at: string;
    from: string;
    to: string;
    messages: number;
    persons: number;
    tasks: number;
    refused: Record<string, number>;
    sameDayTwice: number;
    /** L'allumage passerait sur cet essai, lu à l'instant : récent, après le dernier allumage du réseau, sans double [R400, R402]. */
    canSwitchOn: boolean;
  } | null;
}

/** Au plus tant de scénarios lus par la direction, les plus anciens d'abord. */
export const MAX_LISTED_SCENARIOS = 200;

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
/** L'allumage lu est encore le dernier état du scénario : paramètres, le scénario, la séquence de l'allumage [R401]. */
const SAME_SWITCH = '(SELECT MAX(seq) FROM automation_switches WHERE scenario_id = ?) = ?';
/** Le mandat `m`, inscrit au registre par la ligne `r`, n'a été ni annulé au registre ni rétracté [R39, RC18]. */
const MANDATE_HOLDS = `NOT EXISTS (SELECT 1 FROM mandate_register c WHERE c.network_id = r.network_id AND c.kind = 'annulation' AND c.cancels_seq = r.seq)
  AND NOT EXISTS (SELECT 1 FROM mandate_withdrawals w WHERE w.mandate_id = m.id)`;
/** Le préfixe du fait rangé dans `trigger_ref`, par déclencheur. */
const FACT_PREFIX: Readonly<Record<AutomationTrigger, string>> = { nouveau_contact: 'person', nouveau_projet: 'project', visite_faite: 'visit', mandat_signe: 'mandate' };
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const isInt = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
const text = (v: unknown, max: number): string | null => (typeof v === 'string' && v.trim() !== '' && v.length <= max ? v.trim() : null);
const SAMPLE_FIRST_NAME = 'Camille';
/** Les coordonnées de la fiche par où part chaque canal, comme au contrôle central. */
/** La coordonnée qui rend une personne joignable sur un canal, comme le contrôle central la cherche. */
export const IDENTIFIER_FOR: Readonly<Record<AutomationChannel, readonly string[]>> = { email: ['email'], sms: ['phone'], whatsapp: ['whatsapp', 'phone'] };
/** Un texte comparé comme au contrôle central : minuscules, sans accents ni ponctuation [R05]. */
const sameText = (body: string): string => plain(body).replace(/[^a-z0-9]+/g, ' ').trim();
/** La plus longue mention que le contrôle central peut ajouter au premier message [R06]. */
const LONGEST_MENTION = Math.max(DEFAULT_CONTROLE_SETTINGS.mentionWithAgent.length + 40, DEFAULT_CONTROLE_SETTINGS.mentionWithoutAgent.length) + 2;

/** Le texte du message pour une personne : son prénom à la place de `{prenom}`, ou rien s'il n'est pas connu. */
export function renderScenarioText(template: string, firstName: string | null): string {
  const name = firstName?.trim() ?? '';
  return name === '' ? template.replace(/\s*\{prenom\}/, '').replace(/\s+,/, ',') : template.replace(FIRST_NAME_SLOT, name);
}

/**
 * Un texte fixe de la direction pour un message automatique : le prénom une seule fois, et dès maintenant les contrôles
 * du contrôle central, sans aucun chiffre, mention comprise dans la longueur du canal [R06 à R10, R403].
 */
export function checkFixedText(channel: AutomationChannel, input: unknown, rule = 'R403'): ScenarioResult<string> {
  const bad = (code: string, r: string | null = rule): ScenarioResult<string> => ({ ok: false, rule: r, code });
  const body = text(input, 4000);
  if (body === null) return bad('bad_text');
  // Le prénom une seule fois : le premier message s'adresse à la personne par son prénom [R08].
  if (body.split(FIRST_NAME_SLOT).length !== 2) return bad('first_name_slot');
  if (/[{}]/.test(body.replace(FIRST_NAME_SLOT, ''))) return bad('first_name_slot');
  for (const firstName of [SAMPLE_FIRST_NAME, null]) {
    const problems = checkText(renderScenarioText(body, firstName), { audience: 'client', channel, firstOfConversation: true, firstName, figures: [] });
    if (problems.length > 0) return bad(`text_${problems[0]!.rule}`, problems[0]!.rule);
  }
  // Mention comprise, le texte tient dans le canal : sinon le contrôle central le refuserait à chaque envoi.
  if (body.replace(FIRST_NAME_SLOT, 'x'.repeat(40)).length + LONGEST_MENTION > DEFAULT_TEXT_SETTINGS.maxLength[channel]) return bad('text_length');
  return { ok: true, value: body };
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
    const checked = checkFixedText(channel as AutomationChannel, mm['text']);
    if (!checked.ok) return checked;
    message = { channel: channel as AutomationChannel, text: checked.value };
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
  private async litScenarios(networkId: string): Promise<{ scenarioId: string; version: number; since: string; seq: number }[]> {
    const rows = await this.db.all<{ scenario_id: string; version: number; lit: number; at: string; seq: number }>(
      `SELECT s.scenario_id, s.version, s.lit, s.at, s.seq FROM automation_switches s
       WHERE s.network_id = ? AND s.seq = (SELECT MAX(seq) FROM automation_switches WHERE scenario_id = s.scenario_id)
       ORDER BY s.scenario_id`,
      [networkId],
    );
    return rows.filter((r) => r.lit === 1).map((r) => ({ scenarioId: r.scenario_id, version: r.version, since: r.at, seq: r.seq }));
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
    let rows: { id: string; person_id: string; at: string }[];
    if (def.trigger === 'nouveau_contact') {
      rows = await this.db.all<{ id: string; person_id: string; at: string }>(
        `SELECT p.id, p.id AS person_id, p.created_at AS at FROM persons p
         WHERE p.network_id = ? AND p.created_at >= ? AND p.created_at < ?
           AND NOT EXISTS (SELECT 1 FROM import_keys k WHERE k.network_id = p.network_id AND k.target_kind = 'person' AND k.target_id = p.id)
           AND NOT EXISTS (SELECT 1 FROM person_merges m WHERE m.merged_id = p.id AND m.undone_at IS NULL)
         ORDER BY p.created_at, p.id`,
        range,
      );
    } else if (def.trigger === 'nouveau_projet') {
      rows = await this.db.all<{ id: string; person_id: string; at: string }>(
        `SELECT j.id, j.person_id, j.created_at AS at FROM projects j
         WHERE j.network_id = ? AND j.created_at >= ? AND j.created_at < ?${def.projectKind === null ? '' : ' AND j.kind = ?'}
           AND NOT EXISTS (SELECT 1 FROM import_keys k WHERE k.network_id = j.network_id AND k.target_kind = 'project' AND k.target_id = j.id)
         ORDER BY j.created_at, j.id`,
        def.projectKind === null ? range : [...range, def.projectKind],
      );
    } else if (def.trigger === 'visite_faite') {
      // La visite notée honorée : son statut final ne change plus, l'instant où il est noté est le fait [RC18].
      rows = await this.db.all<{ id: string; person_id: string; at: string }>(
        `SELECT v.appointment_id AS id, v.person_id, a.updated_at AS at FROM visits v JOIN appointments a ON a.id = v.appointment_id
         WHERE a.network_id = ? AND a.updated_at >= ? AND a.updated_at < ? AND v.network_id = a.network_id
           AND a.kind = 'visite' AND a.status = 'honored'
         ORDER BY a.updated_at, a.id`,
        range,
      );
    } else {
      // Le mandat inscrit au registre, jamais retiré : l'inscription est le fait, le mandant la personne [R39, RC18].
      rows = await this.db.all<{ id: string; person_id: string; at: string }>(
        `SELECT m.id, m.person_id, r.at FROM mandate_register r JOIN mandates m ON m.id = r.mandate_id
         WHERE r.network_id = ? AND r.at >= ? AND r.at < ? AND r.kind = 'inscription' AND m.network_id = r.network_id
           AND ${MANDATE_HOLDS}
         ORDER BY r.at, m.id`,
        range,
      );
    }
    const prefix = FACT_PREFIX[def.trigger];
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
   * Un message de date (anniversaire, fête) tient la place du jour de la personne, fiches réunies comprises : remis à la
   * boîte d'essai ce jour de Paris, ou en cours de préparation depuis ce jour. Un message reporté ou refusé ne la tient
   * pas [R402, R405].
   */
  private async dateMessageOn(networkId: string, day: string, members: string[]): Promise<boolean> {
    const rows = await this.db.all<{ status: string; created_at: string; done_at: string | null }>(
      `SELECT status, created_at, done_at FROM client_date_messages WHERE network_id = ? AND status IN ('en_cours', 'essai') AND person_id IN (${members.map(() => '?').join(', ')})`,
      [networkId, ...members],
    );
    return rows.some((r) => {
      const at = r.status === 'essai' ? r.done_at : r.created_at;
      return at !== null && this.day(new Date(at)) === day;
    });
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
    for (const lit of await this.litScenarios(viewer.networkId)) {
      if (lit.scenarioId === scenarioId) continue;
      const otherDef = await this.definitionOf(lit.scenarioId, lit.version);
      if (otherDef.message === null) continue;
      // Lecture prudente : chaque message prévu d'un scénario allumé tient sa journée, même si le contrôle central avait
      // pu le refuser. Un refus d'hier (accord manquant, texte déjà parti) peut ne plus valoir demain ; un double
      // annoncé à tort fait seulement refuser l'allumage, jamais partir un message [R402].
      for (const fact of await this.facts(viewer.networkId, otherDef, from, to)) others.push({ scenarioId: lit.scenarioId, ref: fact.ref, personId: fact.personId, dueAt: this.dueAt(otherDef, fact.at) });
    }
    const taken = new Set(others.map((p) => `${p.personId}|${this.day(p.dueAt)}`));
    let sameDayTwice = 0;
    let sameDayAsDate = 0;
    for (const p of [...allowed].sort((a, b) => a.dueAt.getTime() - b.dueAt.getTime() || a.ref.localeCompare(b.ref))) {
      const day = this.day(p.dueAt);
      const key = `${p.personId}|${day}`;
      const scenarioTwice = taken.has(key);
      taken.add(key);
      // Un message de date remis ou en préparation ce jour-là tient la place du jour : allumé, le scénario aurait été
      // refusé, ou passé le premier et fait perdre la date de l'année. Fiches réunies d'aujourd'hui comprises. Regardé
      // même quand un autre scénario tient déjà le jour, pour que la direction voie la date ; le message n'est compté
      // qu'une fois dans les doubles [R402, RC10].
      const members = await this.fiche.membersOf(await this.fiche.rootOf(p.personId));
      const dateTwice = await this.dateMessageOn(viewer.networkId, day, members);
      if (dateTwice) sameDayAsDate += 1;
      if (scenarioTwice || dateTwice) sameDayTwice += 1;
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
      { type: 'automatismes.essai', actor: this.actor(viewer), subject: `scenario:${scenarioId}`, data: { rule: 'R400', version: current.version, simulation: id, messages: allowed.length, persons, tasks, sameDayTwice, sameDayAsDate, sent: false } },
      this.now,
    );
    return {
      ok: true,
      value: { simulationId: id, scenarioId, version: current.version, from: from.toISOString(), to: to.toISOString(), messages: allowed.length, persons, tasks, refused: refusedBy, sameDayTwice, sameDayAsDate, canSwitchOn: sameDayTwice === 0 },
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
      'SELECT id, same_day_twice, lit_revision, created_at FROM automation_simulations WHERE scenario_id = ? AND version = ? ORDER BY created_at DESC, id DESC LIMIT 1',
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
    // Annulés seulement tant que cet arrêt est le dernier état, lu dans la même écriture : un allumage venu juste après
    // garde ses passages [R401].
    const cancelled = await this.db.run(
      "UPDATE automation_runs SET status = 'annule', done_at = ? WHERE scenario_id = ? AND status = 'a_faire' AND (SELECT lit FROM automation_switches WHERE scenario_id = ? ORDER BY seq DESC LIMIT 1) = 0",
      [now, scenarioId, scenarioId],
    );
    await appendEvent(this.journal, { type: 'automatismes.eteint', actor: this.actor(viewer), subject: `scenario:${scenarioId}`, data: { rule: 'R401', cancelled: cancelled.changes } }, this.now);
    return { ok: true, value: { cancelled: cancelled.changes } };
  }

  /**
   * Les scénarios du réseau, pour la direction seule : la dernière version de chacun, son état, et le dernier essai de
   * cette version avec ce que l'allumage en dirait à l'instant. Rien n'est écrit, hors le refus d'un autre rôle [R16, R400].
   */
  async list(viewer: Viewer): Promise<ScenarioResult<ScenarioSummary[]>> {
    const refused = await this.refuseUnlessDirection(viewer, 'list');
    if (refused) return refused;
    const now = this.now().getTime();
    const rows = await this.db.all<{ id: string; version: number; definition: string; created_at: string }>(
      `SELECT s.id, s.version, s.definition, s.created_at FROM automation_scenarios s
       WHERE s.network_id = ? AND s.version = (SELECT MAX(version) FROM automation_scenarios WHERE id = s.id)
       ORDER BY (SELECT MIN(created_at) FROM automation_scenarios WHERE id = s.id), s.id LIMIT ?`,
      [viewer.networkId, MAX_LISTED_SCENARIOS],
    );
    const lit = new Map((await this.litScenarios(viewer.networkId)).map((l) => [l.scenarioId, l]));
    const revision = await this.litRevision(viewer.networkId);
    const out: ScenarioSummary[] = [];
    for (const r of rows) {
      const sim = await this.db.first<{ id: string; created_at: string; period_from: string; period_to: string; messages: number; reached: number; tasks: number; refused: string; same_day_twice: number; lit_revision: number }>(
        `SELECT id, created_at, period_from, period_to, messages, reached, tasks, refused, same_day_twice, lit_revision FROM automation_simulations
         WHERE scenario_id = ? AND version = ? AND network_id = ? ORDER BY created_at DESC, id DESC LIMIT 1`,
        [r.id, r.version, viewer.networkId],
      );
      const on = lit.get(r.id) ?? null;
      out.push({
        scenarioId: r.id,
        version: r.version,
        definition: JSON.parse(r.definition) as ScenarioDefinition,
        composedAt: r.created_at,
        litVersion: on ? on.version : null,
        litSince: on ? on.since : null,
        lastSimulation: sim
          ? {
              simulationId: sim.id,
              at: sim.created_at,
              from: sim.period_from,
              to: sim.period_to,
              messages: sim.messages,
              persons: sim.reached,
              tasks: sim.tasks,
              refused: JSON.parse(sim.refused) as Record<string, number>,
              sameDayTwice: sim.same_day_twice,
              // Les mêmes conditions que l'allumage, dans le même ordre [R400, R402].
              canSwitchOn: now - Date.parse(sim.created_at) <= this.settings.simulationValidHours * HOUR && sim.lit_revision === revision && sim.same_day_twice === 0,
            }
          : null,
      });
    }
    return { ok: true, value: out };
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
      // Jamais le passé : seulement les faits venus après l'allumage [R401]. Et pas toute l'histoire depuis l'allumage à
      // chaque passage : à partir du dernier fait rangé, moins la marge [RC19].
      for (const fact of await this.facts(networkId, def, await this.scanFrom(s), new Date(now.getTime() + 1))) {
        // Rangé seulement si l'allumage lu est encore le dernier état du scénario, dans la même écriture : un arrêt, ou
        // un arrêt suivi d'un nouvel allumage, venu entre-temps ne laisse naître aucun passage d'avant [R401].
        const inserted = await this.db.run(
          `INSERT OR IGNORE INTO automation_runs (id, network_id, scenario_id, version, trigger_ref, person_id, triggered_at, due_at, status, created_at)
           SELECT ?, ?, ?, ?, ?, ?, ?, ?, 'a_faire', ? WHERE ${SAME_SWITCH}`,
          [this.newId(), networkId, s.scenarioId, s.version, fact.ref, fact.personId, fact.at, this.dueAt(def, fact.at).toISOString(), now.toISOString(), s.scenarioId, s.seq],
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
        // Annulé seulement si sa version n'est vraiment plus allumée, lu dans la même écriture : un allumage venu après
        // la lecture des scénarios garde ses passages [R401].
        const cancelled = await this.db.run(`UPDATE automation_runs SET status = 'annule', done_at = ? WHERE id = ? AND status = 'a_faire' AND NOT ${STILL_LIT}`, [
          now.toISOString(),
          run.id,
          run.scenario_id,
          run.version,
          run.scenario_id,
        ]);
        if (cancelled.changes === 1) continue;
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
        // Un mandat retiré depuis son inscription ne déclenche plus rien : le passage est annulé, jamais effacé [RC18].
        // Dans le bloc de reprise : une panne de cette lecture rend le passage à faire.
        if (!(await this.factHolds(run.trigger_ref))) {
          await this.db.run("UPDATE automation_runs SET status = 'annule', done_at = ? WHERE id = ? AND status = 'en_cours'", [now.toISOString(), run.id]);
          continue;
        }
        await this.execute(networkId, run, def, now, report);
      } catch (error) {
        // Une panne rend le passage à faire ; l'erreur remonte, jamais avalée.
        await this.db.run("UPDATE automation_runs SET status = 'a_faire' WHERE id = ? AND status = 'en_cours'", [run.id]);
        throw error;
      }
    }
    return report;
  }

  /**
   * D'où le passage relit les faits d'un scénario allumé : du fait le plus récent déjà rangé pour lui depuis l'allumage,
   * moins la marge, jamais avant l'allumage ; sans passage rangé, de l'allumage. Un fait daté de plus d'une marge avant
   * le dernier rangé, qui n'apparaît qu'après coup, ne déclenche plus rien : c'est plus prudent [R401, RC19].
   */
  private async scanFrom(s: { scenarioId: string; since: string }): Promise<Date> {
    const since = Date.parse(s.since);
    const last = await this.db.first<{ at: string | null }>('SELECT MAX(triggered_at) AS at FROM automation_runs WHERE scenario_id = ? AND triggered_at >= ?', [s.scenarioId, s.since]);
    const lastAt = last?.at ? Date.parse(last.at) : Number.NaN;
    if (!Number.isFinite(lastAt)) return new Date(since);
    return new Date(Math.max(since, lastAt - this.settings.rescanHours * HOUR));
  }

  /** Le fait tient encore : seul un mandat peut être retiré après coup (annulé au registre ou rétracté) [RC18]. */
  private async factHolds(ref: string): Promise<boolean> {
    if (!ref.startsWith('mandate:')) return true;
    const row = await this.db.first<{ ok: number }>(
      `SELECT 1 AS ok FROM mandate_register r JOIN mandates m ON m.id = r.mandate_id
       WHERE m.id = ? AND r.kind = 'inscription' AND m.network_id = r.network_id AND ${MANDATE_HOLDS}`,
      [ref.slice('mandate:'.length)],
    );
    return row !== null;
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
    const subject = `scenario:${run.scenario_id}:${run.trigger_ref}`;
    // Repris après une panne, un message déjà remis à la boîte d'essai l'est resté : il garde sa place du jour, rien ne
    // repart [R05, R402]. Un sujet rangé sans remise n'en est pas un : le contrôle central le refusera, place rendue.
    const alreadySent =
      def.message === null
        ? null
        : await this.db.first<{ message_id: string }>(
            `SELECT s.message_id FROM message_subjects s JOIN trial_outbox o ON o.message_id = s.message_id
             WHERE s.subject = ? AND s.person_id IN (${members.map(() => '?').join(', ')}) LIMIT 1`,
            [subject, ...members],
          );
    if (alreadySent) {
      messageStatus = 'essai';
      messageId = alreadySent.message_id;
      report.messagesInTrial += 1;
    } else if (def.message !== null) {
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
        // Une autre fiche réunie tient déjà la place : celle prise ici sous la fiche gardée est rendue, sinon elle
        // ferait attendre pour rien le message de date de la personne ce jour-là [R402, RC09].
        await this.db.run('UPDATE automation_daily_messages SET run_id = NULL WHERE network_id = ? AND person_id = ? AND day = ? AND run_id = ?', [networkId, root, day, run.id]);
        messageStatus = 'refuse';
        messageRule = 'R402';
      } else if (await this.dateMessageOn(networkId, day, members)) {
        // Un message de date remis ce jour, ou en cours de préparation, tient la place du jour : rien ne part, la place
        // prise est rendue. Prise avant de regarder, la place fait aussi attendre un message de date venu en même temps :
        // de deux passages simultanés, au plus un message part, jamais deux [R402, RC09].
        await this.db.run('UPDATE automation_daily_messages SET run_id = NULL WHERE network_id = ? AND person_id = ? AND day = ? AND run_id = ?', [networkId, root, day, run.id]);
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
          subject,
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
        // Remis à la boîte d'essai, il est parti, même si le contrôle central a ensuite noté une panne : il garde sa place.
        const delivered = result.messageId !== null && (await this.db.first<{ n: number }>('SELECT 1 AS n FROM trial_outbox WHERE message_id = ?', [result.messageId])) !== null;
        messageStatus = delivered ? 'essai' : 'refuse';
        // Refusé, ou en panne avant la remise : rien n'est parti, la place du jour est rendue à un autre scénario [R402].
        if (!delivered) await this.db.run('UPDATE automation_daily_messages SET run_id = NULL WHERE network_id = ? AND person_id = ? AND day = ? AND run_id = ?', [networkId, root, day, run.id]);
        messageRule = delivered ? null : (result.rule ?? result.status);
        messageId = result.messageId;
      }
      if (messageStatus === 'essai') report.messagesInTrial += 1;
      else report.messagesRefused += 1;
    }
    let taskId: string | null = null;
    if (def.task !== null) {
      // Une seule tâche par passage, même repris après une panne : celle déjà rangée est retrouvée.
      await this.db.run('INSERT OR IGNORE INTO automation_tasks (id, network_id, run_id, agent_id, person_id, title, due_day, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [
        this.newId(),
        networkId,
        run.id,
        agentId,
        root,
        def.task.title,
        this.day(new Date(now.getTime() + def.task.dueInDays * DAY)),
        now.toISOString(),
      ]);
      taskId = (await this.db.first<{ id: string }>('SELECT id FROM automation_tasks WHERE run_id = ?', [run.id]))?.id ?? null;
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
