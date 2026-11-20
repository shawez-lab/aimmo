/**
 * Le compte rendu de visite dicté (M08, T06). L'agent dicte une phrase ou trente secondes (le texte vient de la dictée
 * de son téléphone). L'IA, derrière une interface, en tire le compte rendu : avis, points forts, réserves, intérêt, prêt
 * à faire une offre. Le code vérifie qu'il ne porte que ce que la dictée dit : aucun chiffre absent de la dictée, une
 * offre seulement si la dictée en parle [R10]. L'agent le valide en un geste, ou l'écrit lui-même ; alors seulement le
 * vendeur le reçoit, par le contrôle central (boîte d'essai), sans le nom ni les coordonnées de l'acquéreur [R52].
 * Une relance de l'acquéreur est programmée, une seule par visite [R18], et « préparer l'offre » s'il se dit prêt.
 *
 * L'IA ne reçoit que la dictée, sans coordonnée ni nom connu de l'acquéreur ou du vendeur [R15]. Panne ou sortie
 * refusée : la dictée brute est gardée, l'agent écrit lui-même. La dictée n'est jamais écrite au journal [R13].
 *
 * Décidé, lecture prudente : la fiche de l'acquéreur garde le compte rendu, rattaché à son projet, sans changer sa
 * recherche (aucun critère ne se déduit d'un avis) ; le vendeur est le mandant du dernier mandat signé du bien ; son
 * accord pour le suivi de la vente (`suivi_vente`) est exigé par le contrôle central [R03].
 */
import { LIVE_MANDATES } from '../espaces/lecture.ts';
import type { Viewer } from '../acces/droits.ts';
import { trialChannels } from '../captation/essai.ts';
import { withoutContactDetails } from '../captation/premiere-reponse.ts';
import { FicheClient } from '../db/fiche-client.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { ControleEnvois } from '../envoi/controle.ts';
import { SqlSendJournal } from '../envoi/journal-envois.ts';
import { DecisionEnvoi } from '../envoi/service.ts';
import { plain } from '../envoi/texte.ts';
import { FicheUnique } from '../fiche/fusion.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import { withoutNames } from '../qualification/regles.ts';
import { appointmentWhen } from '../rendezvous/reservation.ts';
import type { ScheduledJob } from '../bascule/planificateur.ts';
import type { Visites } from './visites.ts';

/** La finalité de l'accord du vendeur pour le suivi de sa vente : comptes rendus et point de la semaine [R03]. */
export const SELLER_UPDATE_PURPOSE = 'suivi_vente';
export const INTEREST_LEVELS = ['aucun', 'faible', 'moyen', 'fort'] as const;
export type Interest = (typeof INTEREST_LEVELS)[number];

export interface VisitReport {
  opinion: string;
  strengths: string[];
  reservations: string[];
  interest: Interest;
  readyToOffer: boolean;
}

export interface ReportWriter {
  /** Le compte rendu tiré de la dictée, et d'elle seule. */
  write(brief: { dictation: string }): Promise<unknown>;
}

export type VisitReportRefusal = { ok: false; rule: string | null; code: string };

const numbersIn = (text: string): string[] =>
  (text.replace(/[  ]/g, ' ').match(/\d+(?:[ .]\d{3})*(?:,\d+)?/g) ?? []).map((n) => n.replace(/[ .]/g, '').replace(',', '.').replace(/^0+(?=\d)/, ''));
const OFFER_WORDS = /\b(?:offre|proposition|proposer|faire une offre|pret a acheter|prete a acheter|prets a acheter|signer|achete|acheter)\b/;
const OFFER_DENIED = /\b(?:ne|n|pas|aucune?|jamais|sans|plus)\b[^.!?]{0,40}\b(?:offre|proposition|proposer|acheter|achete|signer)\b/;
export const CONTACT = /@|\+\d{2}|\b00\d{2}|\b0\d(?:[ .-]?\d{2}){4}\b/;

/** Les particules d'un nom composé, qui ne nomment personne seules : « Le » de « Le Gall », « de » de « de Vries ». */
const PARTICLES = new Set(['le', 'la', 'les', 'de', 'du', 'des', 'd', 'l', 'van', 'von', 'der', 'den', 'da', 'di', 'del', 'della', 'dos', 'das', 'el', 'al', 'ben', 'bin', 'et', 'y', 'saint', 'sainte']);
export const nameWords = (n: string): string[] => plain(n).split(/[^\p{L}]+/u).filter((w) => w.length > 1 && !PARTICLES.has(w));

/** Retire les coordonnées connues des fiches, telles qu'elles y sont, et tout compte en « @ » [R15]. */
export function redactIdentifiers(text: string, identifiers: readonly string[]): string {
  let out = text;
  for (const raw of identifiers) {
    const value = raw.replace(/^@/, '').trim();
    if (value.length < 3) continue;
    out = out.replace(new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '[coordonnée]');
  }
  return out.replace(/@[\p{L}\d_]+(?:\.[\p{L}\d_]+)*/gu, '[compte]');
}

/** Retire chaque mot d'un nom connu, accents et casse ignorés : « Ines » comme « Inès » [R15]. */
export function redactNames(text: string, names: readonly string[]): string {
  const keys = new Set(names.flatMap(nameWords));
  return text.replace(/\p{L}+/gu, (word) => (keys.has(plain(word)) ? '[nom]' : word));
}

const textOk = (v: unknown, max: number): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= max;

/**
 * Le contrôle d'un compte rendu : seulement ses champs, aucune coordonnée, aucun chiffre absent de la dictée, une offre
 * seulement si la dictée en parle [R10].
 */
export function checkReport(raw: unknown, dictation: string): { ok: true; report: VisitReport } | { ok: false; code: string } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ok: false, code: 'shape' };
  const r = raw as Record<string, unknown>;
  const keys = Object.keys(r).sort();
  if (keys.join(',') !== ['interest', 'opinion', 'readyToOffer', 'reservations', 'strengths'].join(',')) return { ok: false, code: 'shape' };
  if (!textOk(r.opinion, 300)) return { ok: false, code: 'shape' };
  const list = (v: unknown): v is string[] => Array.isArray(v) && v.length <= 5 && v.every((x) => textOk(x, 200));
  if (!list(r.strengths) || !list(r.reservations)) return { ok: false, code: 'shape' };
  if (!(INTEREST_LEVELS as readonly unknown[]).includes(r.interest)) return { ok: false, code: 'shape' };
  if (typeof r.readyToOffer !== 'boolean') return { ok: false, code: 'shape' };
  const texts = [r.opinion, ...r.strengths, ...r.reservations];
  // Ni mail, ni téléphone, ni adresse postale [R52].
  if (texts.some((t) => CONTACT.test(t) || withoutContactDetails(t) !== t)) return { ok: false, code: 'contact' };
  const allowed = new Set(numbersIn(dictation));
  if (texts.some((t) => numbersIn(t).some((n) => !allowed.has(n)))) return { ok: false, code: 'invented_figure' };
  // Une offre seulement si la dictée en parle sans la nier : au moindre doute, l'agent écrit lui-même.
  if (r.readyToOffer && (!OFFER_WORDS.test(plain(dictation)) || OFFER_DENIED.test(plain(dictation)))) return { ok: false, code: 'invented_offer' };
  return {
    ok: true,
    report: { opinion: r.opinion.trim(), strengths: r.strengths.map((s) => s.trim()), reservations: r.reservations.map((s) => s.trim()), interest: r.interest as Interest, readyToOffer: r.readyToOffer },
  };
}

const INTEREST_LABEL: Record<Interest, string> = { aucun: 'aucun', faible: 'faible', moyen: 'moyen', fort: 'fort' };

/** Le texte au vendeur, fait par le code depuis le compte rendu validé : vouvoiement, prénom, aucune parenthèse [R08]. */
export function sellerReportText(firstName: string | null, start: Date, report: VisitReport): { text: string; figures: number[] } {
  const when = appointmentWhen(start);
  const parts = [
    `${firstName ? `Bonjour ${firstName},` : 'Bonjour,'} voici le compte rendu de la visite de votre bien ${when.text}.`,
    `Avis du visiteur : ${report.opinion.replace(/[()]/g, '')}`,
    ...(report.strengths.length > 0 ? [`Points forts : ${report.strengths.join(' ; ').replace(/[()]/g, '')}.`] : []),
    ...(report.reservations.length > 0 ? [`Réserves : ${report.reservations.join(' ; ').replace(/[()]/g, '')}.`] : []),
    `Intérêt : ${INTEREST_LABEL[report.interest]}.`,
    ...(report.readyToOffer ? ['Le visiteur envisage de faire une offre : votre agent immobilier vous en parle de vive voix.'] : []),
  ];
  const figures = [...when.figures, ...[report.opinion, ...report.strengths, ...report.reservations].flatMap(numbersIn).map(Number)];
  return { text: parts.join('\n'), figures };
}

interface ReportRow {
  appointment_id: string;
  network_id: string;
  dictation: string;
  report: string | null;
  source: 'ai' | 'agent' | null;
  status: 'brouillon' | 'valide';
  delivery_status: 'sent' | 'waiting' | 'refused' | 'failed' | null;
  delivery_rule: string | null;
  message_id: string | null;
  validated_by: string | null;
}

export interface ComptesRendusOptions {
  writer?: ReportWriter;
  aiTimeoutMs?: number;
  /** Délai de la relance de l'acquéreur, en heures. */
  followUpHours?: number;
  now?: () => Date;
}

function timeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('délai dépassé')), ms);
  });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

export class ComptesRendus {
  private readonly now: () => Date;
  private readonly fiche: FicheUnique;
  private readonly controle: ControleEnvois;

  constructor(
    private readonly db: SqlDatabase,
    private readonly journal: JournalStore,
    private readonly visites: Visites,
    private readonly options: ComptesRendusOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    const store = new FicheClient(db, { now: this.now });
    this.fiche = new FicheUnique(db, store, { now: this.now });
    this.controle = new ControleEnvois(db, this.fiche, new DecisionEnvoi(db, store, this.fiche, { now: this.now }), {
      channels: trialChannels(db, journal, this.now),
      journal: new SqlSendJournal(db, undefined, this.now),
      now: this.now,
    });
  }

  private actor(viewer: Viewer): string {
    return `${String(viewer.role)}:${viewer.userId}`;
  }

  /** Les noms connus de l'acquéreur, interdits dans tout ce qui va au vendeur [R52] et retirés de ce que lit l'IA. */
  private async buyerNames(personId: string): Promise<string[]> {
    const members = (await this.fiche.view(personId)).members;
    const whole = members.flatMap((m) => [m.first_name, m.last_name]).filter((n): n is string => typeof n === 'string' && n.trim().length > 1);
    // Les noms entiers et chacun de leurs mots : « Jean-Pierre », « Jean », « Pierre ».
    return [...new Set([...whole, ...whole.flatMap((n) => n.split(/[^\p{L}]+/u)).filter((w) => w.length > 1 && !PARTICLES.has(plain(w)))])];
  }

  /**
   * Le compte rendu que l'IA tire de la dictée, sans rien ranger : la dictée à la voix (HX06) le montre à l'agent avant
   * qu'il valide d'un geste [R261].
   */
  async preview(viewer: Viewer, appointmentId: string, dictation: string): Promise<{ ok: true; report: VisitReport | null } | VisitReportRefusal> {
    const visit = await this.visites.accessVisit(viewer, appointmentId);
    if (!visit.ok) return visit;
    if (typeof dictation !== 'string' || dictation.trim() === '' || dictation.length > 5000) return { ok: false, rule: null, code: 'bad_dictation' };
    const done = await this.db.first<{ status: string }>('SELECT status FROM visit_reports WHERE appointment_id = ?', [appointmentId]);
    if (done?.status === 'valide') return { ok: false, rule: null, code: 'already_validated' };
    return { ok: true, report: await this.draftReport(appointmentId, dictation) };
  }

  /** Le compte rendu de l'IA, contrôlé ; null sans IA, en panne, ou refusé. */
  private async draftReport(appointmentId: string, dictation: string): Promise<VisitReport | null> {
    const v = (await this.db.first<{ network_id: string; person_id: string; property_id: string }>('SELECT network_id, person_id, property_id FROM visits WHERE appointment_id = ?', [appointmentId]))!;
    const seller = await this.seller(v.network_id, v.property_id);
    const buyers = await this.visitBuyers(appointmentId, v.person_id);
    const names = [...(await Promise.all(buyers.map((b) => this.buyerNames(b)))).flat(), ...(seller ? await this.buyerNames(seller.person_id) : [])];
    let report: VisitReport | null = null;
    const writer = this.options.writer;
    if (writer) {
      try {
        const identifiers = [
          ...(await Promise.all(buyers.map(async (b) => (await this.fiche.view(b)).identifiers))).flat(),
          ...(seller ? (await this.fiche.view(seller.person_id)).identifiers : []),
        ].map((i) => i.value);
        // Les adresses mail entières d'abord, puis les coordonnées connues et les comptes, puis les noms [R15].
        const brief = redactNames(withoutNames(redactIdentifiers(withoutContactDetails(dictation), identifiers), names), names);
        const raw = await timeout(writer.write({ dictation: brief }), this.options.aiTimeoutMs ?? 20_000);
        const checked = checkReport(raw, dictation);
        if (checked.ok && !this.names(checked.report, names)) report = checked.report;
        else await appendEvent(this.journal, { type: 'compte_rendu.ia_refusee', actor: 'system:compte_rendu', subject: `visit:${appointmentId}`, data: { code: checked.ok ? 'buyer_named' : checked.code } }, this.now);
      } catch {
        await appendEvent(this.journal, { type: 'compte_rendu.ia_absente', actor: 'system:compte_rendu', subject: `visit:${appointmentId}`, data: {} }, this.now);
      }
    }
    return report;
  }

  /**
   * La dictée de l'agent, et le compte rendu que l'IA en tire ; tant qu'il n'est pas validé, une nouvelle dictée le
   * remplace. Avec `withoutWriter`, l'IA n'est pas appelée : l'agent écrira ou validera son compte rendu (HX06).
   */
  async dictate(viewer: Viewer, appointmentId: string, dictation: string, options: { withoutWriter?: boolean } = {}): Promise<{ ok: true; report: VisitReport | null; source: 'ai' | null } | VisitReportRefusal> {
    const visit = await this.visites.accessVisit(viewer, appointmentId);
    if (!visit.ok) return visit;
    if (typeof dictation !== 'string' || dictation.trim() === '' || dictation.length > 5000) return { ok: false, rule: null, code: 'bad_dictation' };
    const v = (await this.db.first<{ network_id: string }>('SELECT network_id FROM visits WHERE appointment_id = ?', [appointmentId]))!;
    const report = options.withoutWriter ? null : await this.draftReport(appointmentId, dictation);
    const at = this.now().toISOString();
    const { changes } = await this.db.run(
      `INSERT INTO visit_reports (appointment_id, network_id, dictation, report, source, status, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'brouillon', ?, ?, ?)
       ON CONFLICT (appointment_id) DO UPDATE SET dictation = excluded.dictation, report = excluded.report, source = excluded.source, updated_at = excluded.updated_at
       WHERE visit_reports.status = 'brouillon'`,
      [appointmentId, v.network_id, dictation, report ? JSON.stringify(report) : null, report ? 'ai' : null, this.actor(viewer), at, at],
    );
    if (changes !== 1) return { ok: false, rule: null, code: 'already_validated' };
    await appendEvent(this.journal, { type: 'compte_rendu.brouillon', actor: this.actor(viewer), subject: `visit:${appointmentId}`, data: { source: report ? 'ai' : 'none' } }, this.now);
    return { ok: true, report, source: report ? 'ai' : null };
  }

  /**
   * La validation en un geste : le compte rendu de l'IA tel quel, ou celui que l'agent écrit ou corrige. Il ne nomme
   * jamais l'acquéreur [R52]. Il part alors au vendeur ; la relance et, s'il le faut, « préparer l'offre » sont créées.
   */
  async validate(viewer: Viewer, appointmentId: string, edited?: VisitReport): Promise<{ ok: true; delivery: string; rule: string | null } | VisitReportRefusal> {
    const visit = await this.visites.accessVisit(viewer, appointmentId);
    if (!visit.ok) return visit;
    const row = await this.db.first<ReportRow>('SELECT * FROM visit_reports WHERE appointment_id = ?', [appointmentId]);
    if (!row) return { ok: false, rule: null, code: 'no_dictation' };
    if (row.status === 'valide') {
      // Validé mais jamais parti (panne avant l'envoi) : il part maintenant.
      if (row.delivery_status === null) return this.sendToSeller(appointmentId);
      return { ok: true, delivery: row.delivery_status, rule: row.delivery_rule };
    }
    const v = (await this.db.first<{ network_id: string; person_id: string; property_id: string; project_id: string; agent_id: string }>(
      'SELECT network_id, person_id, property_id, project_id, agent_id FROM visits WHERE appointment_id = ?',
      [appointmentId],
    ))!;
    let report: VisitReport | null = row.report ? (JSON.parse(row.report) as VisitReport) : null;
    let source = row.source;
    if (edited !== undefined) {
      // L'agent écrit ce qu'il a vu et entendu : la forme est contrôlée, pas l'origine de ses chiffres.
      const checked = checkReport(edited, `${row.dictation} ${[edited?.opinion, ...(edited?.strengths ?? []), ...(edited?.reservations ?? [])].join(' ')}`);
      if (!checked.ok) return { ok: false, rule: checked.code === 'contact' ? 'R52' : null, code: checked.code };
      report = checked.report;
      source = 'agent';
    }
    if (!report) return { ok: false, rule: null, code: 'no_report' };
    const named = await this.refusalFor(appointmentId, report);
    if (named) return named;
    const at = this.now();
    const iso = at.toISOString();
    const { changes } = await this.db.run(
      "UPDATE visit_reports SET report = ?, source = ?, status = 'valide', validated_by = ?, validated_at = ?, updated_at = ? WHERE appointment_id = ? AND status = 'brouillon'",
      [JSON.stringify(report), source, this.actor(viewer), iso, iso, appointmentId],
    );
    if (changes !== 1) {
      const again = await this.db.first<ReportRow>('SELECT * FROM visit_reports WHERE appointment_id = ?', [appointmentId]);
      return { ok: true, delivery: again?.delivery_status ?? 'none', rule: again?.delivery_rule ?? null };
    }
    await appendEvent(this.journal, { type: 'compte_rendu.valide', actor: this.actor(viewer), subject: `visit:${appointmentId}`, data: { source: source ?? 'none' } }, this.now);
    // Les suites, une seule de chaque par visite [R18].
    const followUp = new Date(at.getTime() + (this.options.followUpHours ?? 48) * 3_600_000).toISOString();
    await this.db.run(
      `INSERT INTO visit_tasks (appointment_id, kind, network_id, agent_id, project_id, due_at, created_at) VALUES (?, 'relance_acquereur', ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
      [appointmentId, v.network_id, v.agent_id, v.project_id, followUp, iso],
    );
    if (report.readyToOffer) {
      await this.db.run(
        `INSERT INTO visit_tasks (appointment_id, kind, network_id, agent_id, project_id, due_at, created_at) VALUES (?, 'preparer_offre', ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
        [appointmentId, v.network_id, v.agent_id, v.project_id, iso, iso],
      );
    }
    return this.sendToSeller(appointmentId);
  }

  /** Le refus d'un compte rendu qui nomme l'acquéreur de la visite ou porte une coordonnée de sa fiche [R52] ; null sinon. */
  async refusalFor(appointmentId: string, report: VisitReport): Promise<VisitReportRefusal | null> {
    const v = await this.db.first<{ person_id: string }>('SELECT person_id FROM visits WHERE appointment_id = ?', [appointmentId]);
    if (!v) return { ok: false, rule: null, code: 'unknown' };
    // AU077 : dans une visite groupée, aucun des acquéreurs venus ensemble n'est nommé, ni sa coordonnée [R52].
    for (const buyer of await this.visitBuyers(appointmentId, v.person_id)) {
      const refusal = await this.namesBuyer(buyer, report);
      if (refusal) return refusal;
    }
    return null;
  }

  /**
   * L'acquéreur de la visite et, dans une visite groupée (AU077), ceux qui l'ont faite avec lui, le sien d'abord : leurs
   * noms et coordonnées ne vont jamais au vendeur [R52], et ne sont jamais lus par l'IA.
   */
  private async visitBuyers(appointmentId: string, personId: string): Promise<string[]> {
    // Les rendez-vous du groupe, rattachés ou non à une visite : une visite prise en ligne compte aussi.
    const rows = await this.db.all<{ person_id: string }>(
      `SELECT DISTINCT person_id FROM appointments
       WHERE group_id IS NOT NULL AND group_id = (SELECT group_id FROM appointments WHERE id = ?)`,
      [appointmentId],
    );
    return [personId, ...rows.map((r) => r.person_id).filter((p) => p !== personId)];
  }

  private async namesBuyer(buyerId: string, report: VisitReport): Promise<VisitReportRefusal | null> {
    if (this.names(report, await this.buyerNames(buyerId))) return { ok: false, rule: 'R52', code: 'buyer_named' };
    // Aucune coordonnée de la fiche de l'acquéreur, telle qu'elle y est rangée [R52].
    const reportText = plain([report.opinion, ...report.strengths, ...report.reservations].join(' '));
    const identifiers = (await this.fiche.view(buyerId)).identifiers.map((i) => plain(i.value)).filter((x) => x.length > 2);
    if (identifiers.some((x) => reportText.includes(x) || reportText.replace(/[\s.-]/g, '').includes(x.replace(/[\s.+-]/g, '')))) return { ok: false, rule: 'R52', code: 'contact' };
    return null;
  }

  /** Reprend les comptes rendus validés qui n'ont pas pu partir pour l'heure ou une panne. */
  async retry(): Promise<number> {
    const rows = await this.db.all<{ appointment_id: string }>(
      "SELECT appointment_id FROM visit_reports WHERE status = 'valide' AND (delivery_status IS NULL OR delivery_status IN ('waiting', 'failed'))",
    );
    let sent = 0;
    for (const r of rows) if ((await this.sendToSeller(r.appointment_id)).delivery === 'sent') sent += 1;
    return sent;
  }

  private names(report: VisitReport, names: readonly string[]): boolean {
    const text = ` ${plain([report.opinion, ...report.strengths, ...report.reservations].join(' ')).replace(/[^\p{L}]+/gu, ' ')} `;
    // Chaque mot d'un nom compte seul : « Jean » pour « Jean-Pierre » [R52].
    return names.some((n) => nameWords(n).some((w) => text.includes(` ${w} `)));
  }

  private async seller(networkId: string, propertyId: string): Promise<{ person_id: string; agent_id: string } | null> {
    // Le dernier mandat vivant : le compte rendu ne part jamais au mandant d'un mandat annulé ou rétracté.
    return this.db.first<{ person_id: string; agent_id: string }>(
      `SELECT l.person_id, m.agent_id FROM (${LIVE_MANDATES}) l JOIN mandates m ON m.id = l.id WHERE l.property_id = ? ORDER BY l.signed_at DESC, l.id DESC LIMIT 1`,
      [networkId, propertyId],
    );
  }

  private async sendToSeller(appointmentId: string): Promise<{ ok: true; delivery: string; rule: string | null }> {
    const row = (await this.db.first<ReportRow>('SELECT * FROM visit_reports WHERE appointment_id = ?', [appointmentId]))!;
    if (row.delivery_status === 'sent' || row.delivery_status === 'refused') return { ok: true, delivery: row.delivery_status, rule: row.delivery_rule };
    const v = (await this.db.first<{ network_id: string; person_id: string; property_id: string }>('SELECT network_id, person_id, property_id FROM visits WHERE appointment_id = ?', [appointmentId]))!;
    const appointment = (await this.db.first<{ start_at: string }>('SELECT start_at FROM appointments WHERE id = ?', [appointmentId]))!;
    const seller = await this.seller(v.network_id, v.property_id);
    let status: 'sent' | 'waiting' | 'refused' | 'failed';
    let rule: string | null = null;
    let messageId: string | null = null;
    if (!seller) {
      status = 'refused';
      rule = null;
    } else {
      const sellerFirst = (await this.fiche.view(seller.person_id)).members.map((m) => m.first_name).find((n) => n) ?? null;
      const sellerNames = await this.buyerNames(seller.person_id);
      const report = JSON.parse(row.report!) as VisitReport;
      const { text, figures } = sellerReportText(sellerFirst, new Date(appointment.start_at), report);
      const result = await this.controle.send({
        networkId: v.network_id,
        agentId: seller.agent_id,
        // L'agent qui a validé le compte rendu : parti, il ne part plus, même si l'agent de la visite est encore là [R86].
        preparedBy: row.validated_by?.startsWith('agent:') ? row.validated_by.slice('agent:'.length) : null,
        personId: seller.person_id,
        channel: 'email',
        kind: 'follow_up',
        purpose: SELLER_UPDATE_PURPOSE,
        subject: `compte_rendu:${appointmentId}`,
        fallbackTexts: [text],
        figures,
        // Le nom de l'acquéreur ne va jamais au vendeur [R52] : le contrôle du texte le refuse.
        // Un prénom commun au vendeur et à l'acquéreur reste permis : c'est celui de la salutation.
        sellerNames: (await this.buyerNames(v.person_id)).filter((n) => !sellerNames.some((x) => plain(x) === plain(n))),
      });
      messageId = result.messageId;
      rule = result.status === 'sent' ? null : result.rule;
      status = result.status === 'sent' ? 'sent' : result.status === 'failed' ? 'failed' : result.rule === 'R01' ? 'waiting' : 'refused';
    }
    await this.db.run("UPDATE visit_reports SET delivery_status = ?, delivery_rule = ?, message_id = COALESCE(?, message_id), updated_at = ? WHERE appointment_id = ? AND (delivery_status IS NULL OR delivery_status <> 'sent')", [
      status,
      rule,
      messageId,
      this.now().toISOString(),
      appointmentId,
    ]);
    await appendEvent(this.journal, { type: 'compte_rendu.envoi', actor: 'system:compte_rendu', subject: `visit:${appointmentId}`, data: { mode: 'essai', status, rule } }, this.now);
    return { ok: true, delivery: status, rule };
  }
}

export const VISIT_REPORTS_JOB = 'visites.comptes_rendus';

/** La tâche du planificateur : les comptes rendus validés en attente partent au passage suivant, de 9 h à 19 h. */
export function visitReportsJob(db: SqlDatabase, journal: JournalStore, visites: () => Visites, options: Omit<ComptesRendusOptions, 'writer'> = {}): ScheduledJob {
  return {
    name: VISIT_REPORTS_JOB,
    hours: [9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19],
    weekdays: [1, 2, 3, 4, 5, 6],
    run: async () => {
      await new ComptesRendus(db, journal, visites(), options).retry();
    },
  };
}
