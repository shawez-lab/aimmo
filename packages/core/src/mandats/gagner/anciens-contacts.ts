/**
 * Anciens contacts relancés quand la loi le permet (M20 complet, G09).
 *
 * Chaque mois, le code dresse la liste des anciens contacts qu'un agent peut relancer, au bon moment, par des règles
 * écrites, les mêmes pour tous, jamais une note de l'IA [R35] :
 * - la base légale, au jour de la liste puis de nouveau au jour de l'envoi [R143] : un accord en cours pour cette
 *   relance (`OLD_CONTACT_PURPOSE`), une personne ni exclue ni arrêtée [R02, R04], qui ne s'est pas opposée aux
 *   relances après la vente [R65], et, si elle n'est pas cliente, un dernier contact venu d'elle depuis moins de 3 ans
 *   (au-delà, seule la demande de consentement de L08 lui est faite) [R97] ;
 * - le moment, par ordre de règle : une fin de bail notée par l'agent dans les 90 jours, l'anniversaire de l'achat
 *   fait avec l'agence, un avis de valeur remis il y a plus d'un an ;
 * - au plus une relance par période réglée (182 jours), relances après la vente comprises [R143, R05].
 *
 * La relance est proposée par l'IA derrière une interface, qui ne reçoit que la raison, jamais la personne ; un texte
 * qui ne passe pas les contrôles est remplacé par le texte de secours du code. L'agent qui suit la fiche la valide,
 * puis elle passe par le contrôle central, en mode essai : rien ne part [R26]. Rien ne s'efface [R17].
 */
import type { Viewer } from '../../acces/droits.ts';
import { anniversary, mentionsReward } from '../../apres-vente/index.ts';
import { trialChannels } from '../../captation/essai.ts';
import { DureesProspects } from '../../conformite/durees-prospects.ts';
import { FicheClient } from '../../db/fiche-client.ts';
import type { SqlDatabase } from '../../db/sql.ts';
import { ControleEnvois } from '../../envoi/controle.ts';
import { localTime } from '../../envoi/horaires.ts';
import { SqlSendJournal } from '../../envoi/journal-envois.ts';
import { DecisionEnvoi } from '../../envoi/service.ts';
import { plain } from '../../envoi/texte.ts';
import { FicheUnique } from '../../fiche/fusion.ts';
import { appendEvent } from '../../journal/journal.ts';
import type { JournalStore } from '../../journal/types.ts';

/** Finalité de l'accord d'une relance d'ancien contact [R03]. */
export const OLD_CONTACT_PURPOSE = 'relance_ancien_contact';
export const OLD_CONTACT_REASONS = ['fin_de_bail', 'anniversaire_achat', 'estimation_ancienne'] as const;
export type OldContactReason = (typeof OLD_CONTACT_REASONS)[number];
export const OLD_CONTACT_REASON_LABELS: Readonly<Record<OldContactReason, string>> = Object.freeze({
  fin_de_bail: 'Fin de bail prochaine',
  anniversaire_achat: 'Anniversaire de l’achat',
  estimation_ancienne: 'Avis de valeur de plus d’un an',
});
export type OldContactChannel = 'email' | 'sms' | 'whatsapp';
/** L'ordre de préférence des canaux, quand plusieurs accords sont en cours. */
export const OLD_CONTACT_CHANNELS: readonly OldContactChannel[] = ['email', 'sms', 'whatsapp'];

export interface OldContactSettings {
  /** Jours au moins entre deux relances d'une même personne. */
  periodDays: number;
  /** Une fin de bail entre aujourd'hui et ce nombre de jours. */
  leaseEndLeadDays: number;
  /** Un avis de valeur plus ancien que ce nombre de mois. */
  valuationAgeMonths: number;
  /** Au-delà de ce nombre de mois sans contact venu de lui, un prospect n'est plus relancé [R97]. */
  prospectMonths: number;
}

export const DEFAULT_OLD_CONTACT_SETTINGS: OldContactSettings = Object.freeze({ periodDays: 182, leaseEndLeadDays: 90, valuationAgeMonths: 12, prospectMonths: 36 });

/** La rédaction par l'IA : elle reçoit la raison, jamais la personne ni ses coordonnées. */
export interface OldContactDrafter {
  draft(input: { reason: OldContactReason }): Promise<string>;
}

export interface OldContactItem {
  followupId: string;
  personId: string;
  firstName: string | null;
  reason: OldContactReason;
  /** La raison écrite, lisible par l'agent. */
  reasonLabel: string;
  reasonDay: string;
  draft: string;
  draftBy: 'ia' | 'secours';
}

export type OldContactRefusal = { ok: false; rule: 'R16' | 'R143' | 'R03' | null; code: string };
export type OldContactResult<T> = { ok: true; value: T } | OldContactRefusal;

export interface AnciensContactsOptions {
  now?: () => Date;
  newId?: () => string;
  settings?: OldContactSettings;
  drafter?: OldContactDrafter | null;
}

interface FollowupRow {
  id: string;
  network_id: string;
  agent_id: string;
  person_id: string;
  month: string;
  reason: OldContactReason;
  reason_day: string;
  draft: string;
  draft_by: 'ia' | 'secours';
  status: string;
  created_at: string;
}

const TIME_ZONE = 'Europe/Paris';
const DAY = 86_400_000;
const DRAFT_MAX = 600;
const RANK: Readonly<Record<OldContactReason, number>> = Object.freeze({ fin_de_bail: 0, anniversaire_achat: 1, estimation_ancienne: 2 });
const marks = (n: number): string => Array.from({ length: n }, () => '?').join(', ');

/** Le jour de Paris, `AAAA-MM-JJ`. */
const parisDay = (at: Date): string => localTime(at, TIME_ZONE).date;
function addDays(day: string, days: number): string {
  return new Date(Date.parse(`${day}T12:00:00.000Z`) + days * DAY).toISOString().slice(0, 10);
}
function addMonths(day: string, months: number): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const total = y * 12 + (m - 1) + months;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  const last = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
  return `${String(ny).padStart(4, '0')}-${String(nm).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`;
}

/** Les textes de secours, écrits par le code : aucun chiffre, aucune promesse. */
export function oldContactFallback(reason: OldContactReason, firstName: string | null): string {
  const hello = firstName ? `Bonjour ${firstName},` : 'Bonjour,';
  const body: Record<OldContactReason, string> = {
    fin_de_bail: 'vous m’aviez parlé de la fin prochaine de votre bail. Si vous pensez à acheter ou à louer ensuite, je peux vous aider à préparer la suite.',
    anniversaire_achat: 'une année de plus dans votre logement : j’espère que tout va bien. Si vous avez un projet ou une question sur votre bien, je reste à votre écoute.',
    estimation_ancienne: 'l’avis de valeur que je vous avais remis date de plus d’un an. Si vous le souhaitez, je peux le mettre à jour avec les ventes récentes.',
  };
  return `${hello} ${body[reason]} Il vous suffit de répondre à ce message.`;
}

/**
 * Un texte proposé par l'IA ou corrigé par l'agent, contrôlé par des règles fixes : longueur, aucun chiffre ni lien
 * (rien d'inventé) [R10], aucune récompense [R66], « agent immobilier » et « offert » seulement, aucune mention de l'IA.
 */
export function checkOldContactText(text: string): string | null {
  const t = text.trim();
  if (t.length < 20 || t.length > DRAFT_MAX) return 'length';
  if (/\d/.test(t)) return 'figure';
  if (/https?:|www\.|@/.test(t)) return 'link';
  const p = plain(t);
  if (mentionsReward(t)) return 'reward';
  if (/\bmandataire|\bgratuit|\bintelligence artificielle\b|\bia\b|\bchatgpt\b|\brobot\b/.test(p)) return 'wording';
  return null;
}

export class AnciensContacts {
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly settings: OldContactSettings;
  private readonly drafter: OldContactDrafter | null;
  private readonly fiche: FicheUnique;
  private readonly durees: DureesProspects;
  private readonly controle: ControleEnvois;

  constructor(
    private readonly db: SqlDatabase,
    private readonly journal: JournalStore,
    options: AnciensContactsOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => crypto.randomUUID());
    this.settings = options.settings ?? DEFAULT_OLD_CONTACT_SETTINGS;
    this.drafter = options.drafter ?? null;
    const store = new FicheClient(db, { now: this.now });
    this.fiche = new FicheUnique(db, store, { now: this.now });
    this.durees = new DureesProspects(db, journal, this.fiche, { now: this.now });
    const decisions = new DecisionEnvoi(db, store, this.fiche, { now: this.now });
    // Seuls les canaux du mode essai : aucun vrai canal ne peut être passé de l'extérieur [R26].
    this.controle = new ControleEnvois(db, this.fiche, decisions, { channels: trialChannels(db, journal, this.now), journal: new SqlSendJournal(db, undefined, this.now), now: this.now });
  }

  private actor(viewer: Viewer): string {
    return `${String(viewer.role)}:${viewer.userId}`;
  }

  private async refused(viewer: Viewer, code: string): Promise<OldContactRefusal> {
    await appendEvent(this.journal, { type: 'acces.refuse', actor: this.actor(viewer), subject: null, data: { rule: 'R16', role: String(viewer.role), kind: 'old_contact', code } }, this.now);
    return { ok: false, rule: 'R16', code };
  }

  /** L'agent note la fin connue d'un bail d'une personne qu'il suit. */
  async noteLeaseEnd(viewer: Viewer, personId: string, onDay: unknown): Promise<OldContactResult<{ id: string }>> {
    if (viewer.role !== 'agent') return this.refused(viewer, 'role');
    if (typeof onDay !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(onDay) || Number.isNaN(Date.parse(`${onDay}T12:00:00Z`))) return { ok: false, rule: null, code: 'bad_day' };
    const root = await this.fiche.rootOf(personId).catch(() => null);
    const owner = root ? await this.agentOf(viewer.networkId, root) : null;
    if (!root || owner !== viewer.userId) return this.refused(viewer, 'not_assigned');
    const id = this.newId();
    await this.db.run('INSERT INTO old_contact_moments (id, network_id, person_id, kind, on_day, noted_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [id, viewer.networkId, root, 'fin_de_bail', onDay, this.actor(viewer), this.now().toISOString()]);
    return { ok: true, value: { id } };
  }

  /** L'agent qui suit la fiche gardée, s'il est encore en activité. */
  private async agentOf(networkId: string, root: string): Promise<string | null> {
    const members = await this.fiche.membersOf(root);
    const row = await this.db.first<{ agent_id: string }>(
      `SELECT p.agent_id FROM persons p JOIN agents a ON a.id = p.agent_id AND a.status = 'active' WHERE p.network_id = ? AND p.id IN (${marks(members.length)}) AND p.agent_id IS NOT NULL ORDER BY p.id = ? DESC, p.id LIMIT 1`,
      [networkId, ...members, root],
    );
    return row?.agent_id ?? null;
  }

  /** Les canaux où l'accord de relance est en cours à cet instant [R03]. */
  private async consentedChannels(members: readonly string[], at: Date): Promise<OldContactChannel[]> {
    const iso = at.toISOString();
    const rows = await this.db.all<{ channel: string }>(
      `SELECT DISTINCT channel FROM consents WHERE person_id IN (${marks(members.length)}) AND purpose = ? AND given_at <= ? AND (withdrawn_at IS NULL OR withdrawn_at > ?)`,
      [...members, OLD_CONTACT_PURPOSE, iso, iso],
    );
    const set = new Set(rows.map((r) => r.channel));
    return OLD_CONTACT_CHANNELS.filter((c) => set.has(c));
  }

  /**
   * La base légale d'une personne à cet instant [R143] : rend `null` si elle a tout, sinon la règle qui manque.
   * `state` vient de L08 : le dernier contact venu d'elle, et si elle est cliente.
   */
  private async basis(root: string, at: Date, state: { lastContactAt: string; client: boolean } | undefined): Promise<'R02' | 'R03' | 'R65' | 'R97' | null> {
    const members = await this.fiche.membersOf(root);
    const iso = at.toISOString();
    const excluded = await this.db.first(`SELECT 1 FROM exclusions WHERE person_id IN (${marks(members.length)}) AND noted_at <= ? AND (lifted_at IS NULL OR lifted_at > ?) LIMIT 1`, [...members, iso, iso]);
    if (excluded) return 'R02';
    if ((await this.consentedChannels(members, at)).length === 0) return 'R03';
    // Une opposition aux relances après la vente est définitive : elle vaut aussi ici [R65].
    const opposed = await this.db.first(`SELECT 1 FROM after_sale_choices WHERE person_id IN (${marks(members.length)}) AND choice = 'non' AND recorded_at <= ? LIMIT 1`, [...members, iso]);
    if (opposed) return 'R65';
    if (!state || (!state.client && (state.lastContactAt === '' || addMonths(parisDay(new Date(state.lastContactAt)), this.settings.prospectMonths) <= parisDay(at)))) return 'R97';
    return null;
  }

  /** Une relance (de cette tâche ou après la vente) dans la période réglée : pas de nouvelle relance [R143, R05]. */
  private async recentlyFollowed(members: readonly string[], at: Date): Promise<boolean> {
    const since = new Date(at.getTime() - this.settings.periodDays * DAY).toISOString();
    const mine = await this.db.first(`SELECT 1 FROM old_contact_followups WHERE person_id IN (${marks(members.length)}) AND created_at > ? LIMIT 1`, [...members, since]);
    if (mine) return true;
    const afterSale = await this.db.first(`SELECT 1 FROM after_sale_reminders WHERE person_id IN (${marks(members.length)}) AND status = 'sent' AND updated_at > ? LIMIT 1`, [...members, since]);
    return afterSale !== null;
  }

  /** Le moment de la relance, par la première règle qui s'applique ; aucun moment, aucune relance [R35]. */
  private async moment(members: readonly string[], today: string): Promise<{ reason: OldContactReason; day: string } | null> {
    const m = marks(members.length);
    const lease = await this.db.first<{ on_day: string }>(`SELECT on_day FROM old_contact_moments WHERE person_id IN (${m}) AND kind = 'fin_de_bail' AND on_day >= ? AND on_day <= ? ORDER BY on_day, id LIMIT 1`, [
      ...members,
      today,
      addDays(today, this.settings.leaseEndLeadDays),
    ]);
    if (lease) return { reason: 'fin_de_bail', day: lease.on_day };
    const month = today.slice(0, 7);
    const buys = await this.db.all<{ signed_on: string }>(`SELECT c.signed_on FROM sale_file_closings c JOIN sale_files f ON f.id = c.file_id WHERE f.buyer_person_id IN (${m}) ORDER BY c.signed_on, c.file_id`, members);
    for (const b of buys) {
      const years = Number(month.slice(0, 4)) - Number(b.signed_on.slice(0, 4));
      if (years >= 1 && anniversary(b.signed_on, years).slice(0, 7) === month) return { reason: 'anniversaire_achat', day: anniversary(b.signed_on, years) };
    }
    // Le dernier avis de valeur validé d'un bien que la personne possède, s'il a plus d'un an et aucun plus récent.
    const valuation = await this.db.first<{ at: string }>(
      `SELECT max(v.validated_at) AS at FROM valuation_reports v JOIN project_properties pp ON pp.property_id = v.property_id AND pp.role = 'owned'
       JOIN projects p ON p.id = pp.project_id WHERE p.person_id IN (${m}) AND v.status = 'validated'`,
      members,
    );
    if (valuation?.at && addMonths(parisDay(new Date(valuation.at)), this.settings.valuationAgeMonths) <= today) return { reason: 'estimation_ancienne', day: parisDay(new Date(valuation.at)) };
    return null;
  }

  private async draftFor(reason: OldContactReason, firstName: string | null): Promise<{ text: string; by: 'ia' | 'secours' }> {
    if (this.drafter) {
      try {
        const body = (await this.drafter.draft({ reason })).trim();
        const hello = firstName ? `Bonjour ${firstName},` : 'Bonjour,';
        const text = /^bonjour\b/i.test(body) ? body : `${hello} ${body}`;
        if (checkOldContactText(text) === null) return { text, by: 'ia' };
      } catch (error) {
        // Une panne de l'IA n'arrête rien : le texte de secours la remplace, et la panne est au journal [R12].
        await appendEvent(this.journal, { type: 'anciens_contacts.ia_en_panne', actor: 'system:planificateur', subject: null, data: { reason, error: error instanceof Error ? error.name : 'erreur' } }, this.now);
      }
    }
    return { text: oldContactFallback(reason, firstName), by: 'secours' };
  }

  /**
   * Le passage du mois pour un réseau : chaque personne qui a un accord de relance en cours, une base légale et un
   * moment reçoit une relance à valider, rangée pour son agent. Se relance sans doublon. Rend le nombre préparé.
   */
  async prepareMonth(networkId: string): Promise<number> {
    const at = this.now();
    const today = parisDay(at);
    const month = today.slice(0, 7);
    const states = await this.durees.states(networkId);
    const candidates = await this.db.all<{ person_id: string }>('SELECT DISTINCT person_id FROM consents WHERE network_id = ? AND purpose = ? ORDER BY person_id', [networkId, OLD_CONTACT_PURPOSE]);
    const roots = [...new Set(await Promise.all(candidates.map((c) => this.fiche.rootOf(c.person_id))))].sort();
    let prepared = 0;
    for (const root of roots) {
      if ((await this.basis(root, at, states.get(root))) !== null) continue;
      const members = await this.fiche.membersOf(root);
      if (await this.recentlyFollowed(members, at)) continue;
      const moment = await this.moment(members, today);
      if (!moment) continue;
      const agentId = await this.agentOf(networkId, root);
      if (agentId === null) continue;
      const names = await this.db.all<{ first_name: string | null }>(`SELECT first_name FROM persons WHERE id IN (${marks(members.length)}) ORDER BY id = ? DESC, id`, [...members, root]);
      const draft = await this.draftFor(moment.reason, names.map((n) => n.first_name).find((n) => n) ?? null);
      const id = this.newId();
      const { changes } = await this.db.run(
        `INSERT INTO old_contact_followups (id, network_id, agent_id, person_id, month, reason, reason_day, draft, draft_by, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'a_valider', ?) ON CONFLICT (person_id, month) DO NOTHING`,
        [id, networkId, agentId, root, month, moment.reason, moment.day, draft.text, draft.by, at.toISOString()],
      );
      if (changes !== 1) continue;
      prepared += 1;
      await appendEvent(this.journal, { type: 'anciens_contacts.preparee', actor: 'system:planificateur', subject: `person:${root}`, data: { rule: 'R143', followup: id, reason: moment.reason, draftBy: draft.by } }, this.now);
    }
    return prepared;
  }

  /**
   * Les relances à valider de l'agent, dans l'ordre des règles écrites : raison, jour, identifiant [R35]. La base
   * légale est relue aujourd'hui : une personne qui l'a perdue sort de la liste, et sa relance est close [R143].
   */
  async toValidate(viewer: Viewer): Promise<OldContactResult<OldContactItem[]>> {
    if (viewer.role !== 'agent') return this.refused(viewer, 'role');
    const at = this.now();
    const rows = await this.db.all<FollowupRow>("SELECT * FROM old_contact_followups WHERE network_id = ? AND agent_id = ? AND status = 'a_valider'", [viewer.networkId, viewer.userId]);
    const states = rows.length > 0 ? await this.durees.states(viewer.networkId) : new Map();
    const items: OldContactItem[] = [];
    for (const r of rows) {
      const root = await this.fiche.rootOf(r.person_id);
      const lost = await this.basis(root, at, states.get(root));
      if (lost !== null || (await this.agentOf(viewer.networkId, root)) !== viewer.userId) {
        await this.close(r, lost ?? 'R16', 'system:planificateur');
        continue;
      }
      const members = await this.fiche.membersOf(root);
      const names = await this.db.all<{ first_name: string | null }>(`SELECT first_name FROM persons WHERE id IN (${marks(members.length)}) ORDER BY id = ? DESC, id`, [...members, root]);
      items.push({ followupId: r.id, personId: root, firstName: names.map((n) => n.first_name).find((n) => n) ?? null, reason: r.reason, reasonLabel: OLD_CONTACT_REASON_LABELS[r.reason], reasonDay: r.reason_day, draft: r.draft, draftBy: r.draft_by });
    }
    items.sort((a, b) => RANK[a.reason] - RANK[b.reason] || (a.reasonDay < b.reasonDay ? -1 : a.reasonDay > b.reasonDay ? 1 : 0) || (a.followupId < b.followupId ? -1 : 1));
    return { ok: true, value: items };
  }

  private async close(r: FollowupRow, rule: string, by: string): Promise<void> {
    await this.db.run("UPDATE old_contact_followups SET status = 'sans_base', rule = ?, decided_at = ?, decided_by = ? WHERE id = ? AND status = 'a_valider'", [rule, this.now().toISOString(), by, r.id]);
    await appendEvent(this.journal, { type: 'anciens_contacts.close', actor: by, subject: `person:${r.person_id}`, data: { rule, followup: r.id } }, this.now);
  }

  /**
   * L'agent valide la relance, avec le texte proposé ou le sien, sur un canal où l'accord est en cours. La base légale
   * est relue à cet instant ; la relance passe par le contrôle central, en mode essai : rien ne part [R143, R03, R26].
   */
  async validate(viewer: Viewer, followupId: string, input: { channel?: unknown; text?: unknown } = {}): Promise<OldContactResult<{ status: 'essai' | 'refusee'; rule: string | null; delivered: false }>> {
    if (viewer.role !== 'agent') return this.refused(viewer, 'role');
    const r = await this.db.first<FollowupRow>('SELECT * FROM old_contact_followups WHERE id = ? AND network_id = ?', [followupId, viewer.networkId]);
    if (!r || r.agent_id !== viewer.userId) return this.refused(viewer, 'not_assigned');
    if (r.status !== 'a_valider') return { ok: false, rule: null, code: 'already_decided' };
    const root = await this.fiche.rootOf(r.person_id);
    if ((await this.agentOf(viewer.networkId, root)) !== viewer.userId) return this.refused(viewer, 'not_assigned');
    let text = r.draft;
    if (input.text !== undefined) {
      if (typeof input.text !== 'string') return { ok: false, rule: null, code: 'bad_text' };
      const problem = checkOldContactText(input.text);
      if (problem !== null) return { ok: false, rule: null, code: `text_${problem}` };
      text = input.text.trim();
    }
    const at = this.now();
    const lost = await this.basis(root, at, (await this.durees.states(viewer.networkId)).get(root));
    if (lost !== null) {
      await this.close(r, lost, this.actor(viewer));
      return { ok: false, rule: 'R143', code: `no_basis_${lost}` };
    }
    const members = await this.fiche.membersOf(root);
    const channels = await this.consentedChannels(members, at);
    const channel = input.channel === undefined ? channels[0]! : (input.channel as OldContactChannel);
    if (!channels.includes(channel)) return { ok: false, rule: 'R03', code: 'no_consent_on_channel' };
    const result = await this.controle.send({
      networkId: viewer.networkId,
      agentId: viewer.userId,
      personId: root,
      channel,
      kind: 'follow_up',
      purpose: OLD_CONTACT_PURPOSE,
      subject: `ancien_contact:${r.id}`,
      fallbackTexts: [text],
      figures: [],
    });
    const status = result.status === 'sent' ? 'essai' : 'refusee';
    const rule = result.status === 'sent' ? null : result.rule;
    await this.db.run('UPDATE old_contact_followups SET status = ?, channel = ?, rule = ?, message_id = ?, decided_at = ?, decided_by = ? WHERE id = ? AND status = ?', [
      status,
      channel,
      rule,
      result.messageId,
      this.now().toISOString(),
      this.actor(viewer),
      r.id,
      'a_valider',
    ]);
    await appendEvent(this.journal, { type: 'anciens_contacts.essai', actor: this.actor(viewer), subject: `person:${root}`, data: { mode: 'essai', sent: false, followup: r.id, status, rule } }, this.now);
    return { ok: true, value: { status, rule, delivered: false } };
  }
}
