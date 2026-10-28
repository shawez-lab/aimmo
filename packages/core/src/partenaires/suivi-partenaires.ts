/**
 * Suivi des demandes, relances et avis lus par un humain (M18, U07) [R01, R05, R14, R15, R23, R75, R79].
 *
 * Pour chaque mise en relation confiée (U02), le code mesure le délai de réponse du partenaire : de l'étape « confiée »
 * à sa première réponse, c'est-à-dire la première étape qu'il range lui-même (en cours, terminée) ou la première pièce
 * qu'il dépose (U05). Sans réponse au bout de `FOLLOW_UP_WORKING_DAYS` jours ouvrés, une relance est préparée au
 * partenaire ; sans réponse encore `FOLLOW_UP_WORKING_DAYS` jours ouvrés après la date due de la relance, une alerte
 * est préparée à l'agent du projet. Au plus une relance et une alerte par mise en relation, la base le garantit [R05].
 *
 * Décidé, lecture prudente (2026-10-28, voie 2) : un partenaire n'est pas une personne de la fiche client, et le
 * contrôle central des envois n'écrit qu'à une personne de la fiche. Ici, rien ne part : la relance est rangée avec son
 * texte écrit par le code, contrôlé comme un texte à un client (aucune mention de l'IA, R06), et sa date due placée dans
 * les heures d'envoi [R01]. Son passage par le contrôle central, en mode essai, revient au branchement (U09).
 *
 * Le résumé des réponses est fait par l'IA derrière une interface (`FollowUpSummaryWriter`), à partir de faits sans
 * aucune donnée de personne : métier, domaine, états, dates, sortes de pièces [R15, R23]. Sa réponse est contrôlée
 * (forme exacte, aucun chiffre absent des faits, aucune coordonnée) ; au moindre écart, ou si l'IA ne répond pas, le
 * secours du code rend la même structure [R12].
 *
 * L'avis du client sur le service rendu est un texte rangé tel quel, lu par un humain nommé ; il n'est jamais
 * transformé en note, en rang ni en tri, et rien ici ne le donne à l'annuaire ni au tirage [R14, R75].
 *
 * Rien ne change ni ne s'efface [R17] ; chaque relance, alerte, avis et lecture au journal, sans nom [R13].
 */
import type { Viewer } from '../acces/droits.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { DEFAULT_SEND_SETTINGS } from '../envoi/decision.ts';
import { isWorkingDay, localTime } from '../envoi/horaires.ts';
import { checkText } from '../envoi/texte.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import type { DiagnosticDomain, PartnerTrade } from './annuaire.ts';
import { CONSENT_CHANNELS, type ConsentChannel, type MiseEnRelation, type ReferralState } from './mise-en-relation.ts';

const TIME_ZONE = 'Europe/Paris';
const MINUTE = 60_000;
const DAY = 86_400_000;

/** Jours ouvrés sans réponse avant la relance, puis avant l'alerte à l'agent. Réglage. */
export const FOLLOW_UP_WORKING_DAYS = 2;
/** Longueur maximale d'un avis du client. */
export const MAX_REVIEW_LENGTH = 2000;

const MONTHS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];

/** Le jour d'une date, à Paris, en mots : « 12 juillet ». */
export function dayInWords(at: Date): string {
  const d = localTime(at, TIME_ZONE).date;
  return `${Number(d.slice(8, 10))} ${MONTHS[Number(d.slice(5, 7)) - 1]}`;
}

/** L'instant de Paris qui porte cette date et ces minutes locales ; une heure sautée au printemps glisse d'une heure. */
function parisInstant(date: string, minutes: number): Date {
  const base = Date.parse(`${date}T00:00:00.000Z`) + minutes * MINUTE;
  for (const offset of [60, 120, 0]) {
    const t = new Date(base - offset * MINUTE);
    const l = localTime(t, TIME_ZONE);
    if (l.date === date && l.minutes === minutes) return t;
  }
  return new Date(base - 60 * MINUTE);
}

/**
 * L'instant `days` jours ouvrés après `from`, à la même heure de Paris : chaque jour du lundi au vendredi hors jour
 * férié compte, à Paris, en dates locales (un changement d'heure ne décale pas le jour compté). Un départ un samedi
 * compte à partir du lundi.
 */
export function addWorkingDays(from: Date, days: number): Date {
  const start = localTime(from, TIME_ZONE);
  let date = start.date;
  let left = days;
  while (left > 0) {
    date = new Date(Date.parse(`${date}T12:00:00.000Z`) + DAY).toISOString().slice(0, 10);
    if (isWorkingDay(localTime(new Date(`${date}T12:00:00.000Z`), TIME_ZONE))) left--;
  }
  return parisInstant(date, start.minutes);
}

const inSendingHours = (at: Date): boolean => {
  const l = localTime(at, TIME_ZONE);
  return DEFAULT_SEND_SETTINGS.initiativeDays.includes(l.weekday) && l.minutes >= DEFAULT_SEND_SETTINGS.initiativeFrom && l.minutes < DEFAULT_SEND_SETTINGS.initiativeUntil;
};

/** Le premier instant, à partir de `at`, compris dans les heures d'envoi d'initiative, à la minute près [R01]. */
export function nextSendingSlot(at: Date): Date {
  if (inSendingHours(at)) return at;
  let t = Math.ceil(at.getTime() / MINUTE) * MINUTE;
  // Pas d'une heure jusqu'à entrer dans les heures d'envoi, puis retour minute par minute jusqu'à leur début.
  while (!inSendingHours(new Date(t))) t += 60 * MINUTE;
  while (t - MINUTE > at.getTime() && inSendingHours(new Date(t - MINUTE))) t -= MINUTE;
  return new Date(t);
}

/** Le texte de la relance au partenaire, écrit par le code : la date de la demande, rien sur le client [R10, R19]. */
export function followUpText(entrustedAt: Date): string {
  return `Bonjour, la demande qui vous a été confiée le ${dayInWords(entrustedAt)} attend encore votre réponse. Vous la retrouvez dans votre espace partenaire : il vous suffit d'y indiquer où vous en êtes. Merci !`;
}

/** Le texte de l'alerte à l'agent, écrit par le code. */
export function agentAlertText(entrustedAt: Date, followUpDue: Date): string {
  return `Le partenaire ne répond pas à la demande confiée le ${dayInWords(entrustedAt)}, malgré la relance du ${dayInWords(followUpDue)}. Appelez-le, ou proposez un autre professionnel au client.`;
}

export interface FollowUp {
  kind: 'relance' | 'alerte_agent';
  recipient: string;
  text: string;
  dueAt: string;
  preparedAt: string;
}

export interface ResponseMeasure {
  referralId: string;
  state: ReferralState;
  entrustedAt: string | null;
  /** La première réponse du partenaire : sa première étape ou sa première pièce. */
  firstResponseAt: string | null;
  /** Le délai de réponse, en minutes ; sans réponse, le temps écoulé jusqu'à maintenant. */
  delayMinutes: number | null;
  answered: boolean;
}

/** Les faits donnés au résumé : aucune donnée de personne, aucun nom, aucune adresse [R15, R23]. */
export interface SummaryFacts {
  trade: PartnerTrade;
  domain: DiagnosticDomain | null;
  state: ReferralState;
  entrustedOn: string | null;
  firstResponseOn: string | null;
  delayHours: number | null;
  documents: { sort: string; destination: string; depositedOn: string }[];
  followUps: { kind: 'relance' | 'alerte_agent'; dueOn: string }[];
}

export interface FollowUpSummary {
  headline: string;
  points: string[];
}

export interface FollowUpSummaryWriter {
  /** Le résumé des réponses du partenaire, tiré des faits seuls. */
  write(facts: SummaryFacts): Promise<unknown>;
}

export type SuiviRefusal = { ok: false; rule: 'R16' | 'R14' | 'R74' | null; code: string };
export type SuiviResult<T> = { ok: true; value: T } | SuiviRefusal;

export interface PartnerReview {
  reviewId: string;
  text: string;
  channel: ConsentChannel;
  recordedAt: string;
}

const CONTACT = /@|\+\d{2}|\b00\d{2}|\b0\d(?:[ .-]?\d{2}){4}\b|https?:\/\//i;
const numbersIn = (text: string): string[] => (text.match(/\d+/g) ?? []).map((n) => n.replace(/^0+(?=\d)/, ''));

/** Les nombres permis dans un résumé : ceux des faits, dates découpées comprises [R10]. */
function allowedNumbers(facts: SummaryFacts): Set<string> {
  const out = new Set<string>(numbersIn(JSON.stringify(facts)));
  for (const s of [facts.entrustedOn, facts.firstResponseOn, ...facts.documents.map((d) => d.depositedOn), ...facts.followUps.map((f) => f.dueOn)]) {
    if (s) out.add(String(Number(s.slice(8, 10))));
  }
  out.add(String(facts.documents.length));
  out.add(String(facts.followUps.length));
  return out;
}

/** Le contrôle d'un résumé rendu par l'IA : forme exacte, aucun chiffre absent des faits, aucune coordonnée. */
export function checkSummary(raw: unknown, facts: SummaryFacts): FollowUpSummary | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (Object.keys(r).sort().join(',') !== 'headline,points') return null;
  const ok = (v: unknown, max: number): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= max;
  if (!ok(r.headline, 160)) return null;
  if (!Array.isArray(r.points) || r.points.length > 6 || !r.points.every((p) => ok(p, 200))) return null;
  const texts = [r.headline, ...(r.points as string[])];
  if (texts.some((t) => CONTACT.test(t))) return null;
  const allowed = allowedNumbers(facts);
  if (texts.some((t) => numbersIn(t).some((n) => !allowed.has(n)))) return null;
  return { headline: r.headline.trim(), points: (r.points as string[]).map((p) => p.trim()) };
}

const STATE_WORDS: Record<ReferralState, string> = {
  proposee: 'proposée au client',
  accord_client: 'acceptée par le client, pas encore confiée',
  confiee: 'confiée, sans réponse du partenaire',
  en_cours: 'en cours chez le partenaire',
  terminee: 'terminée',
  abandonnee: 'abandonnée',
};

const frDay = (iso: string): string => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;

/** Le secours sans IA : la même structure, écrite par le code depuis les faits seuls [R12]. */
export function fallbackSummary(facts: SummaryFacts): FollowUpSummary {
  const points: string[] = [];
  if (facts.entrustedOn) points.push(`Confiée le ${frDay(facts.entrustedOn)}.`);
  if (facts.firstResponseOn) points.push(`Première réponse le ${frDay(facts.firstResponseOn)}${facts.delayHours !== null ? `, après ${facts.delayHours} h` : ''}.`);
  else if (facts.entrustedOn) points.push('Aucune réponse du partenaire pour l’instant.');
  if (facts.documents.length > 0) points.push(`Pièces déposées : ${facts.documents.map((d) => d.sort.replace(/_/g, ' ')).join(', ')}.`);
  for (const f of facts.followUps) points.push(f.kind === 'relance' ? `Relance préparée pour le ${frDay(f.dueOn)}.` : `Alerte à l’agent le ${frDay(f.dueOn)}.`);
  return { headline: `Demande ${STATE_WORDS[facts.state]}.`, points: points.slice(0, 6) };
}

interface ReferralRow {
  id: string;
  network_id: string;
  project_id: string;
  trade: PartnerTrade;
  domain: string;
}

export interface SuiviPartenairesOptions {
  now?: () => Date;
  newId?: () => string;
  writer?: FollowUpSummaryWriter | undefined;
  /** Jours ouvrés sans réponse avant la relance, puis avant l'alerte. */
  workingDays?: number;
}

export class SuiviPartenaires {
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly writer: FollowUpSummaryWriter | undefined;
  private readonly workingDays: number;

  constructor(
    private readonly db: SqlDatabase,
    private readonly relations: MiseEnRelation,
    private readonly journal: JournalStore,
    options: SuiviPartenairesOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => crypto.randomUUID());
    this.writer = options.writer;
    this.workingDays = options.workingDays ?? FOLLOW_UP_WORKING_DAYS;
    if (!Number.isInteger(this.workingDays) || this.workingDays < 1 || this.workingDays > 10) throw new Error('Délai de relance des partenaires : de 1 à 10 jours ouvrés.');
  }

  private actor(viewer: Viewer): string {
    return `${String(viewer.role)}:${viewer.userId}`;
  }

  /** L'agent du projet ou la direction, contrôlés par la mise en relation elle-même [R16]. */
  private async gate(viewer: Viewer, referralId: unknown): Promise<SuiviRefusal | ReferralRow> {
    const got = await this.relations.get(viewer, referralId);
    if (!got.ok) return { ok: false, rule: got.rule === 'R16' ? 'R16' : null, code: got.code };
    return (await this.db.first<ReferralRow>('SELECT id, network_id, project_id, trade, domain FROM partner_referrals WHERE id = ?', [got.value.referralId]))!;
  }

  /** Le délai de réponse du partenaire, mesuré par le code. */
  async measure(referralId: string): Promise<ResponseMeasure> {
    const steps = await this.db.all<{ state: ReferralState; actor: string; at: string }>('SELECT state, actor, at FROM partner_referral_steps WHERE referral_id = ? ORDER BY seq', [referralId]);
    const entrusted = steps.find((s) => s.state === 'confiee');
    const partnerStep = steps.find((s) => (s.state === 'en_cours' || s.state === 'terminee') && s.actor.startsWith('partner:'));
    const doc = await this.db.first<{ at: string | null }>('SELECT MIN(deposited_at) AS at FROM partner_documents WHERE referral_id = ?', [referralId]);
    const firsts = [partnerStep?.at, doc?.at ?? undefined].filter((v): v is string => !!v).sort();
    const first = firsts[0] ?? null;
    const state = steps.at(-1)?.state ?? 'proposee';
    const end = first ? Date.parse(first) : this.now().getTime();
    return {
      referralId,
      state,
      entrustedAt: entrusted?.at ?? null,
      firstResponseAt: first,
      delayMinutes: entrusted ? Math.max(0, Math.round((end - Date.parse(entrusted.at)) / MINUTE)) : null,
      answered: first !== null,
    };
  }

  /**
   * Le passage : pour chaque mise en relation confiée du réseau encore sans réponse, prépare la relance puis l'alerte
   * quand leur heure est venue, chacune une seule fois [R05]. Rien ne part [R79]. Rend le nombre de préparations.
   */
  async run(networkId: string): Promise<number> {
    const open = await this.db.all<{ id: string; project_id: string }>(
      `SELECT r.id, r.project_id FROM partner_referrals r
       WHERE r.network_id = ? AND (SELECT s.state FROM partner_referral_steps s WHERE s.referral_id = r.id ORDER BY s.seq DESC LIMIT 1) = 'confiee'
       ORDER BY r.created_at, r.id`,
      [networkId],
    );
    const now = this.now();
    let prepared = 0;
    for (const r of open) {
      const m = await this.measure(r.id);
      if (m.answered || !m.entrustedAt) continue;
      const entrustedAt = new Date(m.entrustedAt);
      const held = await this.relations.entrusted(networkId, r.id);
      if (!held) continue;
      const existing = await this.db.all<{ kind: 'relance' | 'alerte_agent'; due_at: string }>('SELECT kind, due_at FROM partner_followups WHERE referral_id = ?', [r.id]);
      const relance = existing.find((f) => f.kind === 'relance');
      if (!relance) {
        if (now < addWorkingDays(entrustedAt, this.workingDays)) continue;
        const text = followUpText(entrustedAt);
        const due = nextSendingSlot(now);
        if (await this.prepare(networkId, r.id, 'relance', `partner:${held.partnerId}`, text, due, [entrustedAt])) prepared++;
        continue;
      }
      if (existing.some((f) => f.kind === 'alerte_agent')) continue;
      const relanceDue = new Date(relance.due_at);
      if (now < addWorkingDays(relanceDue, this.workingDays)) continue;
      const agent = await this.db.first<{ agent_id: string | null }>('SELECT agent_id FROM projects WHERE id = ?', [r.project_id]);
      const text = agentAlertText(entrustedAt, relanceDue);
      if (await this.prepare(networkId, r.id, 'alerte_agent', `agent:${agent?.agent_id ?? 'direction'}`, text, nextSendingSlot(now), [entrustedAt, relanceDue])) prepared++;
    }
    return prepared;
  }

  private async prepare(networkId: string, referralId: string, kind: 'relance' | 'alerte_agent', recipient: string, text: string, due: Date, dates: readonly Date[]): Promise<boolean> {
    // Le texte est contrôlé comme un texte à une personne : aucune mention de l'IA, chiffres des seules dates citées
    // [R06, R10]. R08 (vouvoiement avec le prénom) ne s'applique pas : un partenaire est un professionnel sans prénom
    // dans l'annuaire, et le texte vouvoie.
    const figures = dates.map((d) => Number(localTime(d, TIME_ZONE).date.slice(8, 10)));
    const problems = checkText(text, { audience: 'client', channel: 'email', figures }).filter((p) => p.rule !== 'R08');
    if (problems.length > 0) {
      await appendEvent(this.journal, { type: 'partenaire.suivi_refuse', actor: 'system:partenaires', subject: `referral:${referralId}`, data: { kind, rules: problems.map((p) => p.rule) } }, this.now);
      return false;
    }
    const at = this.now().toISOString();
    const result = await this.db.run('INSERT INTO partner_followups (id, network_id, referral_id, kind, recipient, text, due_at, prepared_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING', [
      this.newId(),
      networkId,
      referralId,
      kind,
      recipient,
      text,
      due.toISOString(),
      at,
    ]);
    if (result.changes === 0) return false;
    await appendEvent(
      this.journal,
      { type: kind === 'relance' ? 'partenaire.relance_preparee' : 'partenaire.alerte_agent', actor: 'system:partenaires', subject: `referral:${referralId}`, data: { rule: kind === 'relance' ? 'R01' : null, mode: 'essai', due: due.toISOString() } },
      this.now,
    );
    return true;
  }

  /** Les relances et alertes préparées d'une mise en relation, pour l'agent du projet ou la direction [R16]. */
  async followUps(viewer: Viewer, referralId: unknown): Promise<SuiviResult<{ measure: ResponseMeasure; followUps: FollowUp[] }>> {
    const row = await this.gate(viewer, referralId);
    if ('ok' in row) return row;
    const rows = await this.db.all<{ kind: 'relance' | 'alerte_agent'; recipient: string; text: string; due_at: string; prepared_at: string }>(
      "SELECT kind, recipient, text, due_at, prepared_at FROM partner_followups WHERE referral_id = ? ORDER BY CASE kind WHEN 'relance' THEN 1 ELSE 2 END",
      [row.id],
    );
    return {
      ok: true,
      value: { measure: await this.measure(row.id), followUps: rows.map((f) => ({ kind: f.kind, recipient: f.recipient, text: f.text, dueAt: f.due_at, preparedAt: f.prepared_at })) },
    };
  }

  /** Les faits d'une mise en relation, sans aucune donnée de personne [R15, R23]. */
  private async facts(row: ReferralRow): Promise<SummaryFacts> {
    const m = await this.measure(row.id);
    const docs = await this.db.all<{ sort: string; destination: string; deposited_at: string }>('SELECT sort, destination, deposited_at FROM partner_documents WHERE referral_id = ? ORDER BY deposited_at, id', [row.id]);
    const fups = await this.db.all<{ kind: 'relance' | 'alerte_agent'; due_at: string }>('SELECT kind, due_at FROM partner_followups WHERE referral_id = ? ORDER BY due_at', [row.id]);
    const day = (iso: string): string => localTime(new Date(iso), TIME_ZONE).date;
    return {
      trade: row.trade,
      domain: row.domain === '' ? null : (row.domain as DiagnosticDomain),
      state: m.state,
      entrustedOn: m.entrustedAt ? day(m.entrustedAt) : null,
      firstResponseOn: m.firstResponseAt ? day(m.firstResponseAt) : null,
      delayHours: m.answered && m.delayMinutes !== null ? Math.round(m.delayMinutes / 60) : null,
      documents: docs.map((d) => ({ sort: d.sort, destination: d.destination, depositedOn: day(d.deposited_at) })),
      followUps: fups.map((f) => ({ kind: f.kind, dueOn: day(f.due_at) })),
    };
  }

  /** Le résumé des réponses du partenaire : par l'IA, contrôlé, ou par le secours du code, de même structure. */
  async summary(viewer: Viewer, referralId: unknown): Promise<SuiviResult<{ summary: FollowUpSummary; source: 'ia' | 'secours' }>> {
    const row = await this.gate(viewer, referralId);
    if ('ok' in row) return row;
    const facts = await this.facts(row);
    if (this.writer) {
      let raw: unknown;
      let failed = false;
      try {
        raw = await this.writer.write(structuredClone(facts));
      } catch {
        failed = true;
      }
      const checked = failed ? null : checkSummary(raw, facts);
      if (checked) return { ok: true, value: { summary: checked, source: 'ia' } };
      await appendEvent(this.journal, { type: 'partenaire.resume_secours', actor: this.actor(viewer), subject: `referral:${row.id}`, data: { rule: 'R12', reason: failed ? 'ia_erreur' : 'ia_refusee' } }, this.now);
    }
    return { ok: true, value: { summary: fallbackSummary(facts), source: 'secours' } };
  }

  /**
   * Range l'avis du client sur le service rendu : un texte et son canal, rien d'autre. Toute note, étoile ou rang est
   * refusé [R14, R75]. Seulement sur une mise en relation qui a été confiée.
   */
  async recordReview(viewer: Viewer, referralId: unknown, input: Record<string, unknown>): Promise<SuiviResult<PartnerReview>> {
    const row = await this.gate(viewer, referralId);
    if ('ok' in row) return row;
    const extra = Object.keys(input).filter((k) => k !== 'text' && k !== 'channel');
    if (extra.length > 0) return { ok: false, rule: 'R14', code: 'only_text' };
    if (typeof input.text !== 'string' || input.text.trim().length === 0 || input.text.length > MAX_REVIEW_LENGTH) return { ok: false, rule: null, code: 'bad_text' };
    if (typeof input.channel !== 'string' || !(CONSENT_CHANNELS as readonly string[]).includes(input.channel)) return { ok: false, rule: null, code: 'bad_channel' };
    if (!(await this.relations.entrusted(row.network_id, row.id))) return { ok: false, rule: 'R74', code: 'not_entrusted' };
    const id = this.newId();
    const at = this.now().toISOString();
    await this.db.run('INSERT INTO partner_reviews (id, network_id, referral_id, text, channel, recorded_by, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [
      id,
      row.network_id,
      row.id,
      input.text.trim(),
      input.channel,
      this.actor(viewer),
      at,
    ]);
    await appendEvent(this.journal, { type: 'partenaire.avis_range', actor: this.actor(viewer), subject: `referral:${row.id}`, data: { channel: input.channel } }, this.now);
    return { ok: true, value: { reviewId: id, text: input.text.trim(), channel: input.channel as ConsentChannel, recordedAt: at } };
  }

  /** Lire les avis d'une mise en relation : chaque lecture est rangée au nom de l'humain qui lit [R13, R16]. */
  async readReviews(viewer: Viewer, referralId: unknown): Promise<SuiviResult<PartnerReview[]>> {
    const row = await this.gate(viewer, referralId);
    if ('ok' in row) return row;
    const rows = await this.db.all<{ id: string; text: string; channel: ConsentChannel; recorded_at: string }>('SELECT id, text, channel, recorded_at FROM partner_reviews WHERE referral_id = ? ORDER BY recorded_at, id', [row.id]);
    const at = this.now().toISOString();
    for (const r of rows) await this.db.run('INSERT INTO partner_review_reads (review_id, reader, read_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING', [r.id, this.actor(viewer), at]);
    await appendEvent(this.journal, { type: 'partenaire.avis_lus', actor: this.actor(viewer), subject: `referral:${row.id}`, data: { count: rows.length } }, this.now);
    return { ok: true, value: rows.map((r) => ({ reviewId: r.id, text: r.text, channel: r.channel, recordedAt: r.recorded_at })) };
  }

  /** Les avis rangés et pas encore lus par un humain, pour l'écran de l'agent ou de la direction. */
  async unreadReviewCount(viewer: Viewer, referralId: unknown): Promise<SuiviResult<number>> {
    const row = await this.gate(viewer, referralId);
    if ('ok' in row) return row;
    const n = await this.db.first<{ n: number }>('SELECT COUNT(*) AS n FROM partner_reviews r WHERE r.referral_id = ? AND NOT EXISTS (SELECT 1 FROM partner_review_reads x WHERE x.review_id = r.id)', [row.id]);
    return { ok: true, value: Number(n?.n ?? 0) };
  }
}
