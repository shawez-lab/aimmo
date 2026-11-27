/**
 * Dossier de présentation pour chaque rendez-vous de mandat (M20 complet, G07). Jamais vu : chaque engagement de
 * service du réseau s'affiche avec le taux que l'agent a réellement tenu sur les 12 derniers mois, recalculé depuis la
 * base, et le détail daté qui le prouve.
 *
 * Pour un rendez-vous d'estimation de l'agent, le dossier rassemble, chaque nombre avec sa source [R141] :
 * - les ventes du quartier du dernier avis de valeur validé du bien (M04) : mois, surface, prix au m², distance
 *   arrondie, avec la source des données et la date de la vente la plus récente [R28] ; jamais une rue ni un nom [R46] ;
 * - le plan de vente : les canaux de publication (M07) et le Studio (M19) ;
 * - les engagements de service rangés par la direction, versionnés, chacun avec son taux tenu et sa preuve ;
 * - les avis réels des clients de l'agent (M11) : tous ceux des 12 derniers mois, avec leur date, jamais choisis ni
 *   réécrits ; la note seulement, jamais le commentaire ni la personne [R13, R46] ; le lien de sa fiche d'avis ;
 * - ses résultats calculés (M13) : mandats signés, ventes conclues, rendez-vous d'estimation tenus.
 * Aucune promesse de prix ni de délai : les textes passent une liste fermée de tournures interdites [R141]. L'IA ne fait
 * qu'une phrase d'accueil, derrière une interface, sans aucune donnée ; refusée, la phrase du code la remplace.
 */
import type { Viewer } from '../../acces/droits.ts';
import { frenchDate, frenchMonth } from '../../attirer/page-prix.ts';
import type { SqlDatabase, SqlValue } from '../../db/sql.ts';
import { DESIGN_CSS, LIEN_CSS } from '../../design/systeme.ts';
import { checkText, plain } from '../../envoi/texte.ts';
import { localTime } from '../../envoi/horaires.ts';
import { appendEvent } from '../../journal/journal.ts';
import type { JournalStore } from '../../journal/types.ts';
import { parisDayStart } from '../../pilotage/tableau-agent.ts';
import { agentBlocked } from './etat-agent.ts';

/** Ce qu'un compte rendu ou un point est devenu : tenu veut dire reçu, comme la mesure de la direction (IN07, R216). */
interface Delivery {
  status: string | null;
  delivery_status: string | null;
  sent_at: string | null;
  trial: number;
}
const IN_TRIAL = (m: string) => `EXISTS (SELECT 1 FROM trial_outbox b WHERE b.message_id = ${m})`;
const reachedInTime = (r: Delivery, deadline: number): boolean => r.status === 'valide' && r.delivery_status === 'sent' && r.sent_at !== null && Number(r.trial) !== 1 && Date.parse(r.sent_at) <= deadline;

export const COMMITMENT_MEASURES = ['compte_rendu_visite', 'point_semaine'] as const;
export type CommitmentMeasure = (typeof COMMITMENT_MEASURES)[number];
/** Ce que chaque mesure compte, écrit dans le code, le même pour tous. */
export const COMMITMENT_MEASURE_RULES: Readonly<Record<CommitmentMeasure, string>> = Object.freeze({
  compte_rendu_visite: 'Chaque visite finie compte ; l’engagement est tenu si son compte rendu est parti au vendeur dans le délai après la fin de la visite. Refusé à l’envoi ou resté en essai, il n’est pas tenu.',
  point_semaine: 'Chaque point est dû le lundi qui suit sa semaine ; l’engagement est tenu s’il est parti au vendeur dans le délai à partir de ce lundi. Refusé à l’envoi ou resté en essai, il n’est pas tenu. Un point que le système n’a jamais préparé ne se voit pas ici.',
});
export const SALE_PLAN = Object.freeze([
  'Annonce sur le site du réseau, avec la page du bien',
  'Publication sur les réseaux sociaux de l’agence',
  'Fiche Google de l’agent',
  'Diffusion sur les portails immobiliers',
  'Photos et vidéo du Studio AIMMO, prises pièce par pièce, sans adresse visible',
]);
const WINDOW_DAYS = 365;
const DAY = 86_400_000;
/** Les rendez-vous montrés à l'écran : de trois heures avant maintenant à quinze jours après. */
export const UPCOMING_DAYS = 15;
const UPCOMING_BEFORE_MS = 3 * 3_600_000;

/**
 * Une promesse de prix ou de délai, ou un chiffre : jamais dans un texte du dossier [R141]. Liste fermée de tournures,
 * relue sur le texte sans accents.
 */
const PROMISES =
  /\bgaranti\w*|\bassur(e|es|ee|ees|ons|ez|ont|ance)\b|\bpromet\w*|\bpromis\w*|\bcertain\w*|\ben moins de\b|\bsous (quinze|trente|huit) jours\b|\bvendu en\b|\bvendre en\b|\bnous vendrons\b|\bje vendrai\b|\bau prix (de|fort|demande)\b|\bmeilleur prix\b|\bprix (garanti|assure|record)\b|\bplus cher\b|\brapidement vendu\b|\bvente rapide\b|\bvente assuree\b|\bsans faute\b|\bdans (le|la|les) (mois|semaine|semaines|jours)\b|\bsous (un|une|deux|trois|quatre|six|quinze|trente|huit) (jours?|semaines?|mois)\b|\bd ici\b|\ben quelques (jours|semaines|mois)\b|\bvite\b|\brapidement\b|\ble plus (haut|cher|eleve)\b|\bprix le plus\b|\btrouvera (preneur|acquereur)\b|\bvente en\b|\bvendu sous\b|\bau dessus du marche\b|\b(dans|sous|en|d ici) (un|une|deux|trois|quatre|cinq|six|sept|huit|neuf|dix|onze|douze|quinze|vingt|trente|quarante|soixante|quatre vingt|cent|quelques|peu de) (heures?|jours?|semaines?|mois|ans?)\b|\bsera (vendu|vendue|loue|louee)\b|\bvendu(e|s|es)? (dans|sous|avant)\b/;

export function promisesSomething(text: string): boolean {
  return /\d/.test(text) || PROMISES.test(plain(text));
}

/**
 * Un texte du dossier, lu par le client : aucune promesse ni chiffre [R141], et les règles d'écriture de tout message
 * au client (« agent immobilier », jamais « mandataire » ; « offert », jamais « gratuit » ; aucune mention de l'IA ;
 * vouvoiement ; ni parenthèses ni formules administratives) [R06, R07, R08]. Rend vrai s'il peut paraître.
 */
export function dossierTextOk(text: string): boolean {
  return !promisesSomething(text) && checkText(text, { audience: 'client', channel: 'email', firstOfConversation: false }).length === 0;
}

/** La phrase d'accueil par l'IA : elle ne reçoit rien de la personne ni du bien. */
export interface DossierDrafter {
  welcome(): Promise<string>;
}

export const DEFAULT_WELCOME = 'Voici, pour notre rendez-vous, ce que je vous propose et ce que j’ai réellement tenu pour mes clients.';

export interface CommitmentView {
  code: string;
  version: number;
  label: string;
  rule: string;
  delayHours: number;
  kept: number;
  total: number;
  /** Le taux tenu, de 0 à 1 ; `null` sans aucun cas sur la période. */
  rate: number | null;
  /** Le détail qui le prouve : chaque cas, daté au jour de Paris, tenu ou non. */
  proof: { day: string; kept: boolean }[];
}

export interface Dossier {
  generatedAt: string;
  period: { from: string; to: string };
  welcome: string;
  welcomeBy: 'ia' | 'code';
  sales: { source: string | null; latestUsedSale: string | null; recentMissing: boolean; dvfNotCovered: boolean; validatedOn: string; items: { month: string; surfaceM2: number; pricePerM2: number; distanceM: number }[] } | null;
  plan: readonly string[];
  commitments: CommitmentView[];
  reviews: { link: string | null; source: string; count: number; average: number | null; answers: { day: string; score: number }[] };
  results: { source: string; mandates: number; sales: number; estimationsHonored: number };
}

export type DossierRefusal = { ok: false; rule: 'R16' | 'R141' | null; code: string };
export type DossierResult<T> = { ok: true; value: T } | DossierRefusal;

export interface DossierPresentationOptions {
  now?: () => Date;
  newId?: () => string;
  drafter?: DossierDrafter | null;
}

const day = (iso: string): string => localTime(new Date(iso), 'Europe/Paris').date;
const escape = (t: string): string => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

export class DossierPresentation {
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly drafter: DossierDrafter | null;

  constructor(
    private readonly db: SqlDatabase,
    private readonly journal: JournalStore,
    options: DossierPresentationOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => crypto.randomUUID());
    this.drafter = options.drafter ?? null;
  }

  private actor(viewer: Viewer): string {
    return `${String(viewer.role)}:${viewer.userId}`;
  }

  private async refused(viewer: Viewer, code: string): Promise<DossierRefusal> {
    await appendEvent(this.journal, { type: 'acces.refuse', actor: this.actor(viewer), subject: null, data: { rule: 'R16', role: String(viewer.role), kind: 'presentation_file', code } }, this.now);
    return { ok: false, rule: 'R16', code };
  }

  /** La direction range un engagement de service, ou une nouvelle version d'un engagement ; jamais une promesse [R141]. */
  async setCommitment(viewer: Viewer, input: { code?: unknown; label?: unknown; measure?: unknown; delayHours?: unknown; active?: unknown }): Promise<DossierResult<{ version: number }>> {
    if (viewer.role !== 'direction') return this.refused(viewer, 'role');
    const { code, label, measure, delayHours, active } = input;
    if (typeof code !== 'string' || !/^[a-z][a-z0-9_]{1,39}$/.test(code)) return { ok: false, rule: null, code: 'bad_code' };
    if (typeof measure !== 'string' || !(COMMITMENT_MEASURES as readonly string[]).includes(measure)) return { ok: false, rule: null, code: 'bad_measure' };
    if (typeof delayHours !== 'number' || !Number.isInteger(delayHours) || delayHours < 1 || delayHours > 336) return { ok: false, rule: null, code: 'bad_delay' };
    if (typeof label !== 'string' || label.trim().length < 5 || label.trim().length > 120) return { ok: false, rule: null, code: 'bad_label' };
    if (promisesSomething(label)) return { ok: false, rule: 'R141', code: 'promise' };
    if (!dossierTextOk(label)) return { ok: false, rule: null, code: 'wording' };
    if (typeof active !== 'boolean') return { ok: false, rule: null, code: 'bad_active' };
    const last = await this.db.first<{ v: number | null }>('SELECT max(version) AS v FROM service_commitments WHERE network_id = ? AND code = ?', [viewer.networkId, code]);
    const version = Number(last?.v ?? 0) + 1;
    const { changes } = await this.db.run(
      'INSERT INTO service_commitments (id, network_id, code, version, label, measure, delay_hours, active, set_by, set_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING',
      [this.newId(), viewer.networkId, code, version, label.trim(), measure, delayHours, active ? 1 : 0, this.actor(viewer), this.now().toISOString()],
    );
    if (changes !== 1) return { ok: false, rule: null, code: 'conflict' };
    await appendEvent(this.journal, { type: 'engagements.version', actor: this.actor(viewer), subject: null, data: { code, version, measure, delayHours, active } }, this.now);
    return { ok: true, value: { version } };
  }

  /** Les engagements du réseau pour la direction : la dernière version de chacun, actif ou non ; rien d'un agent ni d'un client. */
  async commitments(viewer: Viewer): Promise<DossierResult<{ code: string; version: number; label: string; measure: CommitmentMeasure; rule: string; delayHours: number; active: boolean; setAt: string }[]>> {
    if (viewer.role !== 'direction') return this.refused(viewer, 'role');
    const rows = await this.db.all<{ code: string; version: number; label: string; measure: CommitmentMeasure; delay_hours: number; active: number; set_at: string }>(
      `SELECT c.code, c.version, c.label, c.measure, c.delay_hours, c.active, c.set_at FROM service_commitments c WHERE c.network_id = ?
       AND c.version = (SELECT max(version) FROM service_commitments d WHERE d.network_id = c.network_id AND d.code = c.code) ORDER BY c.code`,
      [viewer.networkId],
    );
    return { ok: true, value: rows.map((r) => ({ code: r.code, version: Number(r.version), label: r.label, measure: r.measure, rule: COMMITMENT_MEASURE_RULES[r.measure], delayHours: Number(r.delay_hours), active: r.active === 1, setAt: r.set_at })) };
  }

  /** Les cas d'une mesure pour un agent sur un intervalle, et si chacun a été tenu dans ce délai. */
  private async cases(networkId: string, agentId: string, measure: CommitmentMeasure, delayHours: number, from: Date, to: Date, now: Date): Promise<{ at: string; kept: boolean }[]> {
    const delay = delayHours * 3_600_000;
    const out: { at: string; kept: boolean }[] = [];
    // Un cas ne compte que quand son délai est écoulé : avant, il n'est ni tenu ni manqué.
    const due = (at: string): boolean => Date.parse(at) + delay <= now.getTime();
    if (measure === 'compte_rendu_visite') {
      // Toute visite terminée et non annulée compte, que l'agent l'ait marquée tenue ou non, et qu'elle ait été ouverte
      // ou non (un rendez-vous décalé n'a sa ligne de visite qu'à sa première ouverture) : le taux ne dépend pas de ce
      // que l'agent choisit de marquer ou d'ouvrir.
      const rows = await this.db.all<Delivery & { end_at: string }>(
        `SELECT a.end_at, r.status, r.delivery_status, m.occurred_at AS sent_at, ${IN_TRIAL('r.message_id')} AS trial FROM appointments a
         LEFT JOIN visit_reports r ON r.appointment_id = a.id LEFT JOIN messages m ON m.id = r.message_id
         WHERE a.network_id = ? AND a.agent_id = ? AND a.kind = 'visite' AND a.status IN ('booked', 'honored') AND a.end_at >= ? AND a.end_at < ? ORDER BY a.end_at, a.id`,
        [networkId, agentId, from.toISOString(), to.toISOString()],
      );
      for (const r of rows) if (due(r.end_at)) out.push({ at: r.end_at, kept: reachedInTime(r, Date.parse(r.end_at) + delay) });
    } else {
      // Comme la mesure de la direction (IN07) : le lundi qui suit la semaine fait le cas, et un mandat signé après ce lundi
      // n'en a pas. Le délai court depuis le début de ce lundi à Paris.
      const firstDay = new Date(from.getTime() - 86_400_000).toISOString().slice(0, 10);
      const lastDay = new Date(to.getTime() + 86_400_000).toISOString().slice(0, 10);
      const rows = await this.db.all<Delivery & { monday: string; signed_at: string | null }>(
        `SELECT date(p.week, '+7 days') AS monday, d.signed_at, p.status, p.delivery_status, m.occurred_at AS sent_at, ${IN_TRIAL('p.message_id')} AS trial
         FROM weekly_points p LEFT JOIN mandates d ON d.id = p.mandate_id LEFT JOIN messages m ON m.id = p.message_id
         WHERE p.network_id = ? AND p.agent_id = ? AND date(p.week, '+7 days') >= ? AND date(p.week, '+7 days') <= ? ORDER BY monday, p.mandate_id`,
        [networkId, agentId, firstDay, lastDay],
      );
      for (const r of rows) {
        const at = parisDayStart(r.monday);
        if (at.getTime() < from.getTime() || at.getTime() >= to.getTime()) continue;
        if (r.signed_at !== null && day(r.signed_at) > r.monday) continue;
        if (due(at.toISOString())) out.push({ at: at.toISOString(), kept: reachedInTime(r, at.getTime() + delay) });
      }
    }
    return out;
  }

  /**
   * Le taux tenu d'un engagement par un agent sur la période : chaque cas est jugé par la version de l'engagement en
   * vigueur à sa date (sa mesure, son délai) ; un cas d'avant la première version, ou d'une version retirée, ne compte
   * pas. Rend aussi chaque cas qui le prouve.
   */
  async rate(networkId: string, agentId: string, code: string, from: Date, to: Date): Promise<{ kept: number; total: number; proof: { day: string; kept: boolean }[] }> {
    const versions = await this.db.all<{ measure: CommitmentMeasure; delay_hours: number; active: number; set_at: string }>(
      'SELECT measure, delay_hours, active, set_at FROM service_commitments WHERE network_id = ? AND code = ? ORDER BY version',
      [networkId, code],
    );
    const all: { at: string; kept: boolean }[] = [];
    for (const [i, v] of versions.entries()) {
      if (v.active !== 1) continue;
      const start = new Date(Math.max(Date.parse(v.set_at), from.getTime()));
      const end = new Date(Math.min(i + 1 < versions.length ? Date.parse(versions[i + 1]!.set_at) : Infinity, to.getTime() + 1));
      if (start.getTime() >= end.getTime()) continue;
      all.push(...(await this.cases(networkId, agentId, v.measure, Number(v.delay_hours), start, end, to)));
    }
    all.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
    return { kept: all.filter((c) => c.kept).length, total: all.length, proof: all.map((c) => ({ day: day(c.at), kept: c.kept })) };
  }

  /**
   * Les rendez-vous d'estimation à venir de l'agent, pour ouvrir leur dossier depuis l'application (G13) : prévus, de
   * trois heures avant maintenant à quinze jours après, dans l'ordre des heures. Seuls l'heure, la référence et la
   * commune du bien : aucune donnée du client [R16, R46]. La lecture est au journal, sans donnée [R13].
   */
  async upcoming(viewer: Viewer): Promise<DossierResult<{ appointmentId: string; startAt: string; endAt: string; reference: string | null; city: string | null }[]>> {
    if (viewer.role !== 'agent') return this.refused(viewer, 'role');
    const blocked = await agentBlocked(this.db, viewer, this.now());
    if (blocked) return this.refused(viewer, blocked);
    const at = this.now().getTime();
    const rows = await this.db.all<{ id: string; start_at: string; end_at: string; reference: string | null; city: string | null }>(
      `SELECT a.id, a.start_at, a.end_at, p.reference, p.city FROM appointments a LEFT JOIN properties p ON p.id = a.property_id AND p.network_id = a.network_id
        WHERE a.network_id = ? AND a.agent_id = ? AND a.kind = 'estimation' AND a.status = 'booked' AND a.start_at >= ? AND a.start_at <= ?
        ORDER BY a.start_at, a.id`,
      [viewer.networkId, viewer.userId, new Date(at - UPCOMING_BEFORE_MS).toISOString(), new Date(at + UPCOMING_DAYS * DAY).toISOString()],
    );
    await appendEvent(this.journal, { type: 'dossier_presentation.rendez_vous_lus', actor: this.actor(viewer), subject: `agent:${viewer.userId}`, data: { rule: 'R16', count: rows.length } }, this.now);
    return { ok: true, value: rows.map((r) => ({ appointmentId: r.id, startAt: r.start_at, endAt: r.end_at, reference: r.reference, city: r.city })) };
  }

  /** Le dossier d'un rendez-vous d'estimation de l'agent ; la lecture est au journal, sans donnée [R16, R13]. */
  async build(viewer: Viewer, appointmentId: string): Promise<DossierResult<Dossier>> {
    if (viewer.role !== 'agent') return this.refused(viewer, 'role');
    // Un agent parti, même le jour de son départ, ou au dossier incomplet, n'ouvre aucun dossier [R86, R82].
    const blocked = await agentBlocked(this.db, viewer, this.now());
    if (blocked) return this.refused(viewer, blocked);
    const appt = await this.db.first<{ agent_id: string; kind: string; property_id: string | null }>('SELECT agent_id, kind, property_id FROM appointments WHERE id = ? AND network_id = ?', [appointmentId, viewer.networkId]);
    if (!appt) return this.refused(viewer, 'unknown');
    if (appt.agent_id !== viewer.userId) return this.refused(viewer, 'not_assigned');
    if (appt.kind !== 'estimation') return { ok: false, rule: null, code: 'not_a_mandate_appointment' };
    const at = this.now();
    const from = new Date(at.getTime() - WINDOW_DAYS * DAY);

    // Les ventes du quartier : le dernier avis de valeur validé du bien, tel que le code l'a calculé.
    let sales: Dossier['sales'] = null;
    if (appt.property_id) {
      const report = await this.db.first<{ computed: string; validated_at: string }>(
        "SELECT computed, validated_at FROM valuation_reports WHERE property_id = ? AND network_id = ? AND status = 'validated' ORDER BY validated_at DESC, id DESC LIMIT 1",
        [appt.property_id, viewer.networkId],
      );
      if (report) {
        const c = JSON.parse(report.computed) as { cited?: { month: string; surface: number; pricePerM2: number; distance: number }[]; latestUsedSale?: string; data?: { source?: string | null; recentMissing?: boolean; dvfNotCovered?: boolean } };
        sales = {
          source: c.data?.source ?? null,
          latestUsedSale: c.latestUsedSale ?? null,
          // Les ventes les plus récentes ne sont pas encore publiées, ou le département n'est pas couvert : dit tel quel [R28].
          recentMissing: c.data?.recentMissing === true,
          dvfNotCovered: c.data?.dvfNotCovered === true,
          validatedOn: day(report.validated_at),
          // Ni rue ni commune : rien qui situe la vente d'un autre [R46].
          items: (c.cited ?? []).map((s) => ({ month: s.month, surfaceM2: s.surface, pricePerM2: s.pricePerM2, distanceM: Math.round(s.distance / 50) * 50 })),
        };
      }
    }

    // Les engagements : la dernière version de chacun, s'il est actif.
    const versions = await this.db.all<{ code: string; version: number; label: string; measure: CommitmentMeasure; delay_hours: number; active: number }>(
      `SELECT c.code, c.version, c.label, c.measure, c.delay_hours, c.active FROM service_commitments c WHERE c.network_id = ?
       AND c.version = (SELECT max(version) FROM service_commitments d WHERE d.network_id = c.network_id AND d.code = c.code) ORDER BY c.code`,
      [viewer.networkId],
    );
    const commitments: CommitmentView[] = [];
    for (const v of versions) {
      if (v.active !== 1) continue;
      const r = await this.rate(viewer.networkId, viewer.userId, v.code, from, at);
      commitments.push({ code: v.code, version: Number(v.version), label: v.label, rule: COMMITMENT_MEASURE_RULES[v.measure], delayHours: Number(v.delay_hours), kept: r.kept, total: r.total, rate: r.total === 0 ? null : r.kept / r.total, proof: r.proof });
    }

    // Les avis : tous ceux de la période, dans l'ordre des dates ; la note seulement.
    const answers = await this.db.all<{ score: number; answered_at: string }>(
      'SELECT score, answered_at FROM satisfaction_answers WHERE network_id = ? AND agent_id = ? AND answered_at >= ? AND answered_at <= ? ORDER BY answered_at, file_id, person_id',
      [viewer.networkId, viewer.userId, from.toISOString(), at.toISOString()],
    );
    const link = await this.db.first<{ url: string }>('SELECT url FROM agent_review_links WHERE network_id = ? AND agent_id = ? ORDER BY set_at DESC, id DESC LIMIT 1', [viewer.networkId, viewer.userId]);
    const total = answers.reduce((a, r) => a + Number(r.score), 0);
    const reviews = {
      link: link?.url ?? null,
      source: 'Réponses de satisfaction des clients après la vente (M11), toutes celles des 12 derniers mois',
      count: answers.length,
      average: answers.length === 0 ? null : Math.round((total / answers.length) * 10) / 10,
      answers: answers.map((r) => ({ day: day(r.answered_at), score: Number(r.score) })),
    };

    // Les résultats de l'agent, calculés sur la même période.
    const count = async (sql: string, params: readonly SqlValue[]): Promise<number> => Number((await this.db.first<{ n: number }>(sql, params))?.n ?? 0);
    const results = {
      source: 'Base AIMMO : mandats rangés, actes signés, rendez-vous tenus des 12 derniers mois',
      mandates: await count('SELECT count(*) AS n FROM mandates WHERE network_id = ? AND agent_id = ? AND signed_at >= ? AND signed_at <= ?', [viewer.networkId, viewer.userId, from.toISOString(), at.toISOString()]),
      // Une vente compte au jour de l'acte (comme le tableau de M13), pas au jour où elle a été rangée.
      sales: await count('SELECT count(*) AS n FROM sale_file_closings c JOIN sale_commissions s ON s.file_id = c.file_id WHERE c.network_id = ? AND s.agent_id = ? AND c.signed_on >= ? AND c.signed_on <= ?', [viewer.networkId, viewer.userId, day(from.toISOString()), day(at.toISOString())]),
      estimationsHonored: await count("SELECT count(*) AS n FROM appointments WHERE network_id = ? AND agent_id = ? AND kind = 'estimation' AND status = 'honored' AND start_at >= ? AND start_at <= ?", [
        viewer.networkId,
        viewer.userId,
        from.toISOString(),
        at.toISOString(),
      ]),
    };

    let welcome = DEFAULT_WELCOME;
    let welcomeBy: 'ia' | 'code' = 'code';
    if (this.drafter) {
      try {
        const w = (await this.drafter.welcome()).trim();
        if (w.length >= 10 && w.length <= 300 && dossierTextOk(w)) {
          welcome = w;
          welcomeBy = 'ia';
        } else {
          await appendEvent(this.journal, { type: 'dossier_presentation.ia_refusee', actor: 'system:dossier', subject: null, data: { rule: 'R141' } }, this.now);
        }
      } catch (error) {
        await appendEvent(this.journal, { type: 'dossier_presentation.ia_en_panne', actor: 'system:dossier', subject: null, data: { error: error instanceof Error ? error.name : 'erreur' } }, this.now);
      }
    }

    await appendEvent(this.journal, { type: 'dossier_presentation.lu', actor: this.actor(viewer), subject: `appointment:${appointmentId}`, data: { rule: 'R16', commitments: commitments.length } }, this.now);
    return { ok: true, value: { generatedAt: at.toISOString(), period: { from: day(from.toISOString()), to: day(at.toISOString()) }, welcome, welcomeBy, sales, plan: SALE_PLAN, commitments, reviews, results } };
  }
}

const pct = (rate: number): string => `${Math.round(rate * 100)} %`;
/** « 1 mandat signé », « 3 mandats signés » : le nombre et son accord. */
const count = (n: number, one: string, many: string): string => `${n} ${n > 1 ? many : one}`;
const euros = (n: number): string => `${new Intl.NumberFormat('fr-FR').format(n).replace(/[  ]/g, ' ')} €`;

/** Le dossier, lisible sur téléphone et imprimable : la base du système de design, puis des règles de jetons [R201]. */
export function renderDossier(d: Dossier, agentName: string): string {
  const sales = d.sales
    ? `<section><h2>Les ventes du quartier</h2><p class="doux">Source : ${escape(d.sales.source ?? 'non précisée')}, vente la plus récente : ${escape(d.sales.latestUsedSale ? frenchMonth(d.sales.latestUsedSale) : 'non précisée')}, avis validé le ${escape(frenchDate(d.sales.validatedOn))}.${d.sales.recentMissing ? ' Les ventes les plus récentes ne sont pas encore publiées.' : ''}${d.sales.dvfNotCovered ? ' Le département n’est pas couvert par les ventes publiques : ce sont les ventes connues de l’agence.' : ''}</p><table><caption>Ventes comparables</caption><thead><tr><th scope="col">Mois</th><th scope="col">Surface</th><th scope="col">Prix au m²</th><th scope="col">Distance</th></tr></thead><tbody>${d.sales.items
        .map((s) => `<tr><td>${escape(frenchMonth(s.month))}</td><td>${s.surfaceM2} m²</td><td>${euros(s.pricePerM2)}</td><td>${s.distanceM} m</td></tr>`)
        .join('')}</tbody></table></section>`
    : '<section><h2>Les ventes du quartier</h2><p>Pas encore d’avis de valeur validé pour ce bien.</p></section>';
  const commitments = d.commitments
    .map(
      (c) =>
        `<li><h3>${escape(c.label)}</h3><p class="taux">${c.rate === null ? 'Aucun cas sur la période' : `Tenu ${c.kept} fois sur ${c.total}, soit ${pct(c.rate)}`}</p><p class="doux">${escape(c.rule)} Délai : ${c.delayHours} h. Version ${c.version}.</p>` +
        `<p class="doux">Le détail, cas par cas :</p><ul class="preuve">${c.proof.map((p) => `<li>${escape(frenchDate(p.day))} : ${p.kept ? 'tenu' : 'non tenu'}</li>`).join('')}</ul></li>`,
    )
    .join('');
  const reviews = d.reviews.count === 0 ? '<p>Aucun avis sur la période.</p>' : `<p>${d.reviews.count} avis, note moyenne ${String(d.reviews.average).replace('.', ',')} sur 5.</p><ul class="avis">${d.reviews.answers.map((a) => `<li>${escape(frenchDate(a.day))} : ${a.score} sur 5</li>`).join('')}</ul>`;
  const link = d.reviews.link ? `<p><a class="lien" href="${escape(d.reviews.link)}" rel="noopener">Tous les avis publics</a></p>` : '';
  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Dossier de présentation</title>
<style>${DOSSIER_CSS}</style>
</head>
<body><header class="tete"><p class="marque">AIMMO</p><span class="doux">${escape(agentName)}, agent immobilier</span></header><main><h1>Dossier de présentation</h1><p>${escape(d.welcome)}</p>
${sales}
<section><h2>Le plan de vente</h2><ul>${d.plan.map((p) => `<li>${escape(p)}</li>`).join('')}</ul></section>
<section><h2>Mes engagements, et ce que j’ai réellement tenu</h2><p class="doux">Du ${escape(frenchDate(d.period.from))} au ${escape(frenchDate(d.period.to))}, recalculé depuis la base AIMMO.</p><ul class="engagements">${commitments}</ul></section>
<section><h2>Les avis de mes clients</h2><p class="doux">${escape(d.reviews.source)}.</p>${reviews}${link}</section>
<section><h2>Mes résultats</h2><p class="doux">${escape(d.results.source)}.</p><ul><li>${count(d.results.mandates, 'mandat signé', 'mandats signés')}</li><li>${count(d.results.sales, 'vente conclue', 'ventes conclues')}</li><li>${count(d.results.estimationsHonored, 'rendez-vous d’estimation tenu', 'rendez-vous d’estimation tenus')}</li></ul></section>
</main></body>
</html>`;
}

/** La feuille du dossier : la base du système, téléphone d'abord, et l'impression. */
export const DOSSIER_CSS =
  DESIGN_CSS +
  LIEN_CSS +
  `.tete{display:flex;align-items:center;justify-content:space-between;gap:var(--e-4);padding:var(--e-4)}
main{max-width:var(--colonne);margin:0 auto;padding:var(--e-4) var(--e-4) var(--e-8)}
section{margin-top:var(--e-6)}
table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:var(--e-2);border-bottom:1px solid var(--trait)}
.engagements{list-style:none;padding:0}.engagements>li{border-top:1px solid var(--trait);padding:var(--e-4) 0}
.taux{font-size:var(--t-l);font-weight:700;color:var(--accent)}
@media print{.tete{padding:0}main{max-width:none;padding:0}}`;
