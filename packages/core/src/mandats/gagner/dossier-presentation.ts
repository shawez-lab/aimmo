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
import type { SqlDatabase, SqlValue } from '../../db/sql.ts';
import { DESIGN_CSS } from '../../design/systeme.ts';
import { plain } from '../../envoi/texte.ts';
import { localTime } from '../../envoi/horaires.ts';
import { appendEvent } from '../../journal/journal.ts';
import type { JournalStore } from '../../journal/types.ts';

export const COMMITMENT_MEASURES = ['compte_rendu_visite', 'point_semaine'] as const;
export type CommitmentMeasure = (typeof COMMITMENT_MEASURES)[number];
/** Ce que chaque mesure compte, écrit dans le code, le même pour tous. */
export const COMMITMENT_MEASURE_RULES: Readonly<Record<CommitmentMeasure, string>> = Object.freeze({
  compte_rendu_visite: 'Chaque visite tenue compte ; elle est tenue si son compte rendu est validé dans le délai après la fin de la visite.',
  point_semaine: 'Chaque point de la semaine préparé compte ; il est tenu s’il est validé dans le délai après sa préparation.',
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

/**
 * Une promesse de prix ou de délai, ou un chiffre : jamais dans un texte du dossier [R141]. Liste fermée de tournures,
 * relue sur le texte sans accents.
 */
const PROMISES =
  /\bgaranti\w*|\bassur(e|es|ee|ees|ons|ez|ont|ance)\b|\bpromet\w*|\bpromis\w*|\bcertain\w*|\ben moins de\b|\bsous (quinze|trente|huit) jours\b|\bvendu en\b|\bvendre en\b|\bnous vendrons\b|\bje vendrai\b|\bau prix (de|fort|demande)\b|\bmeilleur prix\b|\bprix (garanti|assure|record)\b|\bplus cher\b|\brapidement vendu\b|\bvente rapide\b|\bvente assuree\b|\bsans faute\b/;

export function promisesSomething(text: string): boolean {
  return /\d/.test(text) || PROMISES.test(plain(text));
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
  sales: { source: string | null; latestUsedSale: string | null; validatedOn: string; items: { month: string; surfaceM2: number; pricePerM2: number; distanceM: number }[] } | null;
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

  /** Le taux tenu d'un engagement par un agent sur la période, et chaque cas qui le prouve. */
  async rate(networkId: string, agentId: string, measure: CommitmentMeasure, delayHours: number, from: Date, to: Date): Promise<{ kept: number; total: number; proof: { day: string; kept: boolean }[] }> {
    const delay = delayHours * 3_600_000;
    const cases: { at: string; kept: boolean }[] = [];
    if (measure === 'compte_rendu_visite') {
      const rows = await this.db.all<{ end_at: string; validated_at: string | null; status: string | null }>(
        `SELECT a.end_at, r.validated_at, r.status FROM appointments a JOIN visits v ON v.appointment_id = a.id
         LEFT JOIN visit_reports r ON r.appointment_id = a.id
         WHERE a.network_id = ? AND a.agent_id = ? AND a.kind = 'visite' AND a.status = 'honored' AND a.end_at >= ? AND a.end_at <= ? ORDER BY a.end_at, a.id`,
        [networkId, agentId, from.toISOString(), to.toISOString()],
      );
      for (const r of rows) cases.push({ at: r.end_at, kept: r.status === 'valide' && r.validated_at !== null && Date.parse(r.validated_at) <= Date.parse(r.end_at) + delay });
    } else {
      const rows = await this.db.all<{ created_at: string; validated_at: string | null; status: string }>(
        'SELECT created_at, validated_at, status FROM weekly_points WHERE network_id = ? AND agent_id = ? AND created_at >= ? AND created_at <= ? ORDER BY created_at, mandate_id, week',
        [networkId, agentId, from.toISOString(), to.toISOString()],
      );
      for (const r of rows) cases.push({ at: r.created_at, kept: r.status === 'valide' && r.validated_at !== null && Date.parse(r.validated_at) <= Date.parse(r.created_at) + delay });
    }
    return { kept: cases.filter((c) => c.kept).length, total: cases.length, proof: cases.map((c) => ({ day: day(c.at), kept: c.kept })) };
  }

  /** Le dossier d'un rendez-vous d'estimation de l'agent ; la lecture est au journal, sans donnée [R16, R13]. */
  async build(viewer: Viewer, appointmentId: string): Promise<DossierResult<Dossier>> {
    if (viewer.role !== 'agent') return this.refused(viewer, 'role');
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
        const c = JSON.parse(report.computed) as { cited?: { month: string; surface: number; pricePerM2: number; distance: number }[]; latestUsedSale?: string; data?: { source?: string | null } };
        sales = {
          source: c.data?.source ?? null,
          latestUsedSale: c.latestUsedSale ?? null,
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
      const r = await this.rate(viewer.networkId, viewer.userId, v.measure, Number(v.delay_hours), from, at);
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
      sales: await count('SELECT count(*) AS n FROM sale_file_closings c JOIN sale_commissions s ON s.file_id = c.file_id WHERE c.network_id = ? AND s.agent_id = ? AND c.at >= ? AND c.at <= ?', [viewer.networkId, viewer.userId, from.toISOString(), at.toISOString()]),
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
        if (w.length >= 10 && w.length <= 300 && !promisesSomething(w)) {
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
const euros = (n: number): string => `${new Intl.NumberFormat('fr-FR').format(n).replace(/[  ]/g, ' ')} €`;

/** Le dossier, lisible sur téléphone et imprimable : la base du système de design, puis des règles de jetons [R201]. */
export function renderDossier(d: Dossier, agentName: string): string {
  const sales = d.sales
    ? `<section><h2>Les ventes du quartier</h2><p class="doux">Source : ${escape(d.sales.source ?? 'non précisée')}, vente la plus récente : ${escape(d.sales.latestUsedSale ?? 'non précisée')}, avis validé le ${escape(d.sales.validatedOn)}.</p><table><caption>Ventes comparables</caption><thead><tr><th scope="col">Mois</th><th scope="col">Surface</th><th scope="col">Prix au m²</th><th scope="col">Distance</th></tr></thead><tbody>${d.sales.items
        .map((s) => `<tr><td>${escape(s.month)}</td><td>${s.surfaceM2} m²</td><td>${euros(s.pricePerM2)}</td><td>${s.distanceM} m</td></tr>`)
        .join('')}</tbody></table></section>`
    : '<section><h2>Les ventes du quartier</h2><p>Pas encore d’avis de valeur validé pour ce bien.</p></section>';
  const commitments = d.commitments
    .map(
      (c) =>
        `<li><h3>${escape(c.label)}</h3><p class="taux">${c.rate === null ? 'Aucun cas sur la période' : `Tenu ${c.kept} fois sur ${c.total}, soit ${pct(c.rate)}`}</p><p class="doux">${escape(c.rule)} Délai : ${c.delayHours} h. Version ${c.version}.</p>` +
        `<details><summary>Le détail, cas par cas</summary><ul>${c.proof.map((p) => `<li>${escape(p.day)} : ${p.kept ? 'tenu' : 'non tenu'}</li>`).join('')}</ul></details></li>`,
    )
    .join('');
  const reviews = d.reviews.count === 0 ? '<p>Aucun avis sur la période.</p>' : `<p>${d.reviews.count} avis, note moyenne ${String(d.reviews.average).replace('.', ',')} sur 5.</p><ul class="avis">${d.reviews.answers.map((a) => `<li>${escape(a.day)} : ${a.score} sur 5</li>`).join('')}</ul>`;
  const link = d.reviews.link ? `<p><a href="${escape(d.reviews.link)}" rel="noopener">Tous les avis publics</a></p>` : '';
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
<section><h2>Mes engagements, et ce que j’ai réellement tenu</h2><p class="doux">Du ${escape(d.period.from)} au ${escape(d.period.to)}, recalculé depuis la base AIMMO.</p><ul class="engagements">${commitments}</ul></section>
<section><h2>Les avis de mes clients</h2><p class="doux">${escape(d.reviews.source)}.</p>${reviews}${link}</section>
<section><h2>Mes résultats</h2><p class="doux">${escape(d.results.source)}.</p><ul><li>${d.results.mandates} mandats signés</li><li>${d.results.sales} ventes conclues</li><li>${d.results.estimationsHonored} rendez-vous d’estimation tenus</li></ul></section>
</main></body>
</html>`;
}

/** La feuille du dossier : la base du système, téléphone d'abord, et l'impression. */
export const DOSSIER_CSS =
  DESIGN_CSS +
  `.tete{display:flex;align-items:center;justify-content:space-between;gap:var(--e-4);padding:var(--e-4)}
main{max-width:var(--colonne);margin:0 auto;padding:var(--e-4) var(--e-4) var(--e-8)}
section{margin-top:var(--e-6)}
table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:var(--e-2);border-bottom:1px solid var(--trait)}
.engagements{list-style:none;padding:0}.engagements>li{border-top:1px solid var(--trait);padding:var(--e-4) 0}
.taux{font-size:var(--t-l);font-weight:700;color:var(--accent)}
@media print{.tete{padding:0}main{max-width:none;padding:0}details{display:block}}`;
