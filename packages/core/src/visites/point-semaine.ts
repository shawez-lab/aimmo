/**
 * Le point de la semaine au vendeur (M08, T07). Chaque lundi, le planificateur prépare, pour chaque mandat en cours,
 * le point de la semaine écoulée : vues de l'annonce par canal (P08), contacts reçus pour le bien (C03), visites faites
 * et prévues, avis des visiteurs (comptes rendus validés de T06). Chaque chiffre est lu dans la base ; une donnée
 * absente est écrite « non communiquée » ; jamais une baisse de prix, décision prise de vive voix avec l'agent [R53].
 * Aucun nom d'acquéreur [R52]. L'agent ajoute ses prochaines actions et valide ; le point part alors par le contrôle
 * central (boîte d'essai), une seule fois par mandat et par lundi [R18].
 *
 * AU078 : une décision de repositionnement du prix déjà convenue de vive voix peut y être consignée, seulement si
 * l'agent la valide explicitement et la lie au rendez-vous tenu avec le vendeur. Sa phrase est faite par le code, le
 * prix seul vient de l'agent ; elle ne change ni l'annonce, ni le mandat, ni la fiche, et ne prévient personne d'autre
 * que le vendeur : aucune négociation ne part d'elle [R53].
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
import { checkText, plain } from '../envoi/texte.ts';
import { FicheUnique } from '../fiche/fusion.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import { shownPrice } from '../biens/prix-publie.ts';
import { withoutContactDetails } from '../captation/premiere-reponse.ts';
import { CONTACT, SELLER_UPDATE_PURPOSE, nameWords, type VisitReport } from './compte-rendu.ts';
import { numbersIn } from '../envoi/texte.ts';

/** Les tournures d'une baisse de prix, liste fermée : refusées partout dans le point [R53]. */
export const PRICE_DROP = /\bprix\b|€|\bcher\b|\bmoins\b|abaiss|\b(?:baisse|baisser|baissons|diminu\w*|reduire|reduction|revoir le prix|revoir a la baisse|ajuster le prix|ajustement du prix|repositionn\w*|prix trop eleve|prix trop haut|rabais|remise)\b/;

/** Au plus huit avis dans un point. */
export const MAX_OPINIONS = 8;

export interface WeeklyFigures {
  week: string;
  /** null : aucun canal n'a rapporté de vues pour la semaine. */
  views: number | null;
  contacts: number;
  visitsDone: number;
  visitsPlanned: number;
  opinions: string[];
  /** D'autres avis que ceux montrés, au-delà de huit : le point reste lisible et sous la longueur d'un mail. */
  moreOpinions?: boolean;
}

/** La décision de prix convenue, telle que l'agent la valide : le rendez-vous tenu avec le vendeur, et le prix. */
export interface PriceDecisionInput {
  appointmentId: string;
  priceEur: number;
  /** L'agent confirme que la décision est déjà prise avec le vendeur : sans `true`, rien n'est consigné. */
  confirmed: boolean;
}

/** La décision consignée, figée avec le point. */
export interface PriceDecision {
  appointmentId: string;
  kind: 'estimation' | 'signature' | 'appel';
  /** Le jour de Paris du rendez-vous, AAAA-MM-JJ. */
  day: string;
  priceEur: number;
}

const EXCHANGE_WORDS: Record<PriceDecision['kind'], string> = { estimation: 'notre rendez-vous', signature: 'notre rendez-vous', appel: 'notre échange téléphonique' };

/** La phrase de la décision, faite par le code : jamais un mot de l'agent [R53]. */
export function priceDecisionLine(d: PriceDecision): string {
  return `Décision prise ensemble lors de ${EXCHANGE_WORDS[d.kind]} du ${dmy(d.day)} : le prix demandé pour votre bien passe à ${number(d.priceEur)} €. L’annonce change après votre accord écrit.`;
}

export type PointRefusal = { ok: false; rule: string | null; code: string };

const addDays = (day: string, n: number): string => new Date(Date.parse(`${day}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const number = (n: number): string => new Intl.NumberFormat('fr-FR').format(n).replace(/ | /g, ' ');
const dmy = (day: string): string => `${day.slice(8, 10)}/${day.slice(5, 7)}`;

/** Le texte du point, fait par le code : chiffres de la base, « non communiquée » pour une donnée absente [R53]. */
export function weeklyPointText(firstName: string | null, f: WeeklyFigures, nextActions: readonly string[], decision: PriceDecision | null = null): string {
  const end = addDays(f.week, 6);
  const lines = [
    `${firstName ? `Bonjour ${firstName},` : 'Bonjour,'} voici le point de la semaine du ${dmy(f.week)} au ${dmy(end)} pour votre bien.`,
    `Vues de l’annonce : ${f.views === null ? 'non communiquées' : number(f.views)}.`,
    `Contacts reçus : ${number(f.contacts)}.`,
    `Visites faites : ${number(f.visitsDone)} ; visites prévues : ${number(f.visitsPlanned)}.`,
    f.opinions.length > 0 ? `Avis des visiteurs : ${f.opinions.join(' / ')}${f.moreOpinions ? ' / et d’autres avis, que votre agent immobilier vous donne de vive voix.' : ''}` : 'Avis des visiteurs : non communiqués.',
    ...(decision ? [priceDecisionLine(decision)] : []),
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
  validated_by: string | null;
  price_decision: string | null;
}

const decisionOf = (row: PointRow): PriceDecision | null => (row.price_decision ? (JSON.parse(row.price_decision) as PriceDecision) : null);
const parisDay = (iso: string): string => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));

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
  async read(viewer: Viewer, mandateId: string, week: string): Promise<{ ok: true; figures: WeeklyFigures; priceDecision: PriceDecision | null; text: string } | PointRefusal> {
    const row = await this.access(viewer, mandateId, week);
    if (!row.ok) return row;
    const figures = JSON.parse(row.row.figures) as WeeklyFigures;
    const first = await this.firstName(row.row.person_id);
    const decision = decisionOf(row.row);
    return { ok: true, figures, priceDecision: decision, text: weeklyPointText(first, figures, row.row.next_actions ? (JSON.parse(row.row.next_actions) as string[]) : [], decision) };
  }

  /** L'agent valide, avec ses prochaines actions ; jamais une baisse de prix [R53]. Le point part alors. */
  async validate(viewer: Viewer, mandateId: string, week: string, actions: readonly string[] = [], priceDecision: PriceDecisionInput | null = null): Promise<{ ok: true; delivery: string; rule: string | null } | PointRefusal> {
    const access = await this.access(viewer, mandateId, week);
    if (!access.ok) return access;
    const row = access.row;
    let nextActions: readonly string[] = actions;
    if (row.status === 'valide') {
      if (row.delivery_status === null) return this.send(mandateId, week);
      return { ok: true, delivery: row.delivery_status, rule: row.delivery_rule };
    }
    if (!Array.isArray(nextActions) || nextActions.length > 5 || nextActions.some((a) => typeof a !== 'string' || a.trim() === '' || a.length > 200)) return { ok: false, rule: null, code: 'bad_actions' };
    // Les actions sont contrôlées telles qu'elles partiront : sans parenthèses, qui ne doivent pas couper un nom [R08, R52].
    nextActions = nextActions.map((a) => a.replace(/[()]/g, '').trim());
    if (nextActions.some((a) => a === '')) return { ok: false, rule: null, code: 'bad_actions' };
    // Le prix ne se discute que de vive voix : aucune action n'en parle, ni n'avance un chiffre [R10, R53].
    if (nextActions.some((a) => PRICE_DROP.test(plain(a)))) return { ok: false, rule: 'R53', code: 'price_drop' };
    if (nextActions.some((a) => /\d/.test(a))) return { ok: false, rule: 'R10', code: 'figure' };
    // Ni le nom ni une coordonnée d'une personne venue pour ce bien [R52].
    const people = await this.peopleOf(row.network_id, row.property_id, row.person_id);
    const named = (a: string): boolean => {
      const text = ` ${plain(a).replace(/[^\p{L}]+/gu, ' ')} `;
      return CONTACT.test(a) || withoutContactDetails(a) !== a || people.words.some((w) => text.includes(` ${w} `)) || people.identifiers.some((x) => plain(a).includes(x));
    };
    if (nextActions.some(named)) return { ok: false, rule: 'R52', code: 'buyer_named' };
    // Une décision de prix convenue : validée explicitement, liée au rendez-vous tenu avec le vendeur [R53].
    let decision: PriceDecision | null = null;
    if (priceDecision !== null && priceDecision !== undefined) {
      const checked = await this.checkDecision(row, priceDecision);
      if (!checked.ok) return checked;
      decision = checked.decision;
    }
    // Le texte entier passe le contrôle du texte avant d'être figé : une action refusée se corrige [R07, R08].
    const figures = JSON.parse(row.figures) as WeeklyFigures;
    const preview = weeklyPointText(await this.firstName(row.person_id), figures, nextActions.map((a) => a.trim()), decision);
    const problems = checkText(preview, {
      audience: 'client',
      channel: 'email',
      firstOfConversation: false,
      firstName: await this.firstName(row.person_id),
      figures: this.allowedFigures(row.week, figures, decision),
      sellerNames: people.outsideGreeting,
    });
    if (problems.length > 0) return { ok: false, rule: problems[0]!.rule, code: 'text_refused' };
    const iso = this.now().toISOString();
    const { changes } = await this.db.run(
      "UPDATE weekly_points SET next_actions = ?, price_decision = ?, status = 'valide', validated_by = ?, validated_at = ?, updated_at = ? WHERE mandate_id = ? AND week = ? AND status = 'prepare'",
      [JSON.stringify(nextActions.map((a) => a.trim())), decision ? JSON.stringify(decision) : null, `${viewer.role}:${viewer.userId}`, iso, iso, mandateId, week],
    );
    if (changes === 1) {
      await appendEvent(this.journal, { type: 'point_semaine.valide', actor: `${viewer.role}:${viewer.userId}`, subject: `mandate:${mandateId}`, data: { week } }, this.now);
      // La décision est dite au journal par son rendez-vous, sans le prix ni personne [R13].
      if (decision) await appendEvent(this.journal, { type: 'point_semaine.decision_prix', actor: `${viewer.role}:${viewer.userId}`, subject: `mandate:${mandateId}`, data: { week, appointment: decision.appointmentId } }, this.now);
    }
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

  /**
   * Les mots des noms et les coordonnées des personnes venues pour ce bien (visites, messages), hors du vendeur
   * lui-même. Les actions sont contrôlées sur tous ces mots, même ceux que le vendeur porte aussi [R52].
   */
  private async peopleOf(networkId: string, propertyId: string, sellerId: string): Promise<{ words: string[]; outsideGreeting: string[]; identifiers: string[] }> {
    const ids = await this.db.all<{ person_id: string }>(
      `SELECT person_id FROM appointments WHERE network_id = ? AND property_id = ?
       UNION SELECT person_id FROM qualifications WHERE network_id = ? AND property_id = ?`,
      [networkId, propertyId, networkId, propertyId],
    );
    const seller = await this.fiche.view(sellerId);
    const sellerWords = new Set(seller.members.flatMap((m) => [m.first_name, m.last_name]).filter((n): n is string => !!n).flatMap(nameWords));
    const words = new Set<string>();
    const identifiers = new Set<string>();
    for (const { person_id } of ids) {
      const view = await this.fiche.view(person_id);
      if (view.person.id === seller.person.id) continue;
      // Les noms d'avant une correction restent à retenir (SV10) [R19].
      const known = await this.db.all<{ first_name: string | null; last_name: string | null }>(`SELECT first_name, last_name FROM person_known_names WHERE id IN (${view.members.map(() => '?').join(', ')})`, view.members.map((m) => m.id));
      for (const m of known) for (const n of [m.first_name, m.last_name]) if (n) for (const w of nameWords(n)) words.add(w);
      for (const i of view.identifiers) if (i.value.length > 2) identifiers.add(plain(i.value));
    }
    // `outsideGreeting` : les mots qui ne sont pas aussi ceux du vendeur, que la salutation porte.
    return { words: [...words], outsideGreeting: [...words].filter((w) => !sellerWords.has(w)), identifiers: [...identifiers] };
  }

  /**
   * La décision de prix, contrôlée : confirmée par l'agent ; un prix entier, plausible, différent de celui montré ; le
   * rendez-vous est celui de l'agent du mandat avec le vendeur (sa fiche, fusions comprises), pour ce bien ou sans bien,
   * tenu ou passé et jamais annulé ni manqué, depuis la signature du mandat [R53].
   */
  private async checkDecision(row: PointRow, input: PriceDecisionInput): Promise<{ ok: true; decision: PriceDecision } | PointRefusal> {
    const refuse = (code: string): PointRefusal => ({ ok: false, rule: 'R53', code });
    if (typeof input !== 'object' || input === null) return refuse('bad_price_decision');
    if (input.confirmed !== true) return refuse('price_decision_not_confirmed');
    if (typeof input.appointmentId !== 'string' || input.appointmentId === '') return refuse('bad_price_decision');
    if (typeof input.priceEur !== 'number' || !Number.isInteger(input.priceEur) || input.priceEur < 1_000 || input.priceEur > 100_000_000) return refuse('bad_price');
    const a = await this.db.first<{ network_id: string; agent_id: string; person_id: string; property_id: string | null; kind: string; status: string; start_at: string; end_at: string }>(
      'SELECT network_id, agent_id, person_id, property_id, kind, status, start_at, end_at FROM appointments WHERE id = ?',
      [input.appointmentId],
    );
    const seller = await this.fiche.view(row.person_id);
    const sellerIds = new Set([seller.person.id, ...seller.members.map((m) => m.id)]);
    if (!a || a.network_id !== row.network_id || !sellerIds.has(a.person_id) || a.agent_id !== row.agent_id || (a.property_id !== null && a.property_id !== row.property_id)) return refuse('exchange_unknown');
    if (a.kind === 'visite') return refuse('exchange_unknown');
    const now = this.now().toISOString();
    if (!(a.status === 'honored' || (a.status === 'booked' && a.end_at <= now)) || a.start_at > now) return refuse('exchange_not_held');
    const signed = await this.db.first<{ signed_at: string | null }>('SELECT signed_at FROM mandates WHERE id = ?', [row.mandate_id]);
    if (!signed?.signed_at || a.start_at < signed.signed_at) return refuse('exchange_before_mandate');
    const property = await this.db.first<{ price_eur: number | null }>('SELECT price_eur FROM properties WHERE id = ?', [row.property_id]);
    const current = await shownPrice(this.db, row.property_id, property?.price_eur ?? null);
    if (current !== null && Number(current) === input.priceEur) return refuse('same_price');
    return { ok: true, decision: { appointmentId: input.appointmentId, kind: a.kind as PriceDecision['kind'], day: parisDay(a.start_at), priceEur: input.priceEur } };
  }

  /** Les chiffres permis : ceux de la base, ceux des avis venus de comptes rendus validés, et la décision validée [R10]. */
  private allowedFigures(week: string, f: WeeklyFigures, decision: PriceDecision | null = null): number[] {
    return [
      ...(decision ? [decision.priceEur, Number(decision.day.slice(8, 10)), Number(decision.day.slice(5, 7))] : []),
      f.views ?? 0,
      f.contacts,
      f.visitsDone,
      f.visitsPlanned,
      ...[week, addDays(week, 6)].flatMap((d) => [Number(d.slice(8, 10)), Number(d.slice(5, 7))]),
      ...f.opinions.flatMap(numbersIn).map(Number),
    ];
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
      opinions: opinions.slice(-MAX_OPINIONS),
      ...(opinions.length > MAX_OPINIONS ? { moreOpinions: true } : {}),
    };
  }

  private async send(mandateId: string, week: string): Promise<{ ok: true; delivery: string; rule: string | null }> {
    const row = (await this.db.first<PointRow>('SELECT * FROM weekly_points WHERE mandate_id = ? AND week = ?', [mandateId, week]))!;
    if (row.delivery_status === 'sent' || row.delivery_status === 'refused') return { ok: true, delivery: row.delivery_status, rule: row.delivery_rule };
    const figures = JSON.parse(row.figures) as WeeklyFigures;
    const actions = row.next_actions ? (JSON.parse(row.next_actions) as string[]) : [];
    const decision = decisionOf(row);
    const text = weeklyPointText(await this.firstName(row.person_id), figures, actions, decision);
    let status: 'sent' | 'waiting' | 'refused' | 'failed';
    let rule: string | null;
    let messageId: string | null = null;
    // Hors de la phrase de la décision validée, faite par le code, rien ne parle de prix [R53].
    if (PRICE_DROP.test(plain(weeklyPointText(await this.firstName(row.person_id), figures, actions)))) {
      status = 'refused';
      rule = 'R53';
    } else {

      const result = await this.controle.send({
        networkId: row.network_id,
        agentId: row.agent_id,
        // Validé par un agent : parti, son point ne part plus, même repris par un autre [R86].
        preparedBy: row.validated_by?.startsWith('agent:') ? row.validated_by.slice('agent:'.length) : null,
        personId: row.person_id,
        channel: 'email',
        kind: 'follow_up',
        purpose: SELLER_UPDATE_PURPOSE,
        subject: `point_semaine:${mandateId}:${week}`,
        fallbackTexts: [text],
        // Les chiffres de la base, et ceux des avis venus de comptes rendus validés ; jamais d'autres [R10].
        figures: this.allowedFigures(week, figures, decision),
        // Aucun nom d'une personne venue pour ce bien [R52].
        sellerNames: (await this.peopleOf(row.network_id, row.property_id, row.person_id)).outsideGreeting,
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
