/**
 * Le brouillon d'avis de valeur et sa validation par l'agent (M04, E04).
 *
 * Le code calcule (E01) ; l'IA rédige, derrière une interface, à partir de chiffres qu'elle ne peut pas changer ;
 * sans elle, ou si son texte ne passe pas le contrôle du texte, un texte de secours écrit par le code. Le texte dit
 * toujours que c'est un avis et que le prix appartient au vendeur, la date des données et ce qui manque [R28].
 * L'agent qui suit le bien ajuste la fourchette et le texte, puis valide : rien ne part sans cette validation [R30].
 * Le journal ne porte ni texte ni chiffre de l'avis [R13].
 */
import type { SqlDatabase } from '../db/sql.ts';
import type { Viewer } from '../acces/droits.ts';
import { checkText } from '../envoi/texte.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import type { PublicFacts } from './collecte.ts';
import { DEFAULT_MANUAL_SETTINGS, MANUAL_REASON_TEXT, REFERENCE_PROOFS, manualRangeAllowed, perM2Shown, perM2Text, referencesMedian, type ManualInput, type ManualSettings } from './avis-manuel.ts';
import type { DataInfo, NoRangeReason, RangeResult } from './fourchette.ts';

type Range = Extract<RangeResult, { ok: true }>;

/** Une vente citée dans l'avis : sans nom ni numéro de voie [R29]. */
export interface CitedSale {
  month: string;
  surface: number;
  pricePerM2: number;
  /** En mètres, arrondie à la dizaine. */
  distance: number;
  street?: string;
  town?: string;
}

/** Ce que l'IA reçoit pour rédiger : des chiffres du calcul, ni nom, ni adresse, ni coordonnée. */
export interface ValuationBrief {
  kind: 'apartment' | 'house';
  surface: number;
  town: string | null;
  low: number;
  high: number;
  pricePerM2: number;
  medianPerM2: number;
  comparables: number;
  radius: number;
  adjustments: readonly { label: string; pct: number }[];
  energyClass: string | null;
  risks: readonly string[];
  dataMonth: string | null;
  latestUsedSale: string;
  recentMissing: boolean;
  /** La fenêtre de temps des ventes retenues [R691]. */
  window: { months: number; from: string; excludedOld: number; justification: string };
}

export interface ValuationWriter {
  write(brief: ValuationBrief): Promise<string>;
}

export interface ValuationReport {
  id: string;
  network_id: string;
  property_id: string;
  agent_id: string | null;
  status: 'draft' | 'validated';
  computed: string;
  computed_low: number;
  computed_high: number;
  agent_low: number | null;
  agent_high: number | null;
  text: string;
  text_by: 'ai' | 'fallback' | 'agent';
  created_at: string;
  updated_at: string;
  validated_by: string | null;
  validated_at: string | null;
}

export type AvisRefusal = 'unknown' | 'not_following_agent' | 'already_validated' | 'not_validated' | 'invalid_range' | 'text_refused' | 'range_not_in_text' | 'other_range_in_text' | 'changed_meanwhile';
export type AvisResult<T> = { ok: true; value: T } | { ok: false; rule: 'R30'; code: AvisRefusal };

export interface DraftInput {
  networkId: string;
  propertyId: string;
  kind: 'apartment' | 'house';
  surface: number;
  range: Range;
  facts?: PublicFacts | null;
  /** Détail des ventes citées, par identifiant de vente (E02) : voie sans numéro et commune. */
  details?: ReadonlyMap<string, { street: string; town: string }>;
}

export interface AvisOptions {
  now?: () => Date;
  writer?: ValuationWriter;
  aiTimeoutMs?: number;
  newId?: () => string;
  /** Nombre de ventes citées dans l'avis, les plus proches. */
  citedSales?: number;
}

/** Le paragraphe que le code ajoute toujours, quel que soit l'auteur du texte. */
export const ADVICE_NOTICE =
  'Cet avis de valeur n’est pas une expertise. Il s’appuie sur des ventes réelles publiées, sans visite de leurs biens. La décision du prix appartient au vendeur, conseillé par son agent.';

/** La mention d'un avis motivé par les références de l'agent : aucune vente publiée n'a donné la fourchette [R690]. */
export const MANUAL_ADVICE_NOTICE =
  'Cet avis de valeur n’est pas une expertise. Faute de ventes publiées suffisantes, il s’appuie sur des ventes réelles que votre agent a vérifiées, sans visite de leurs biens. La décision du prix appartient au vendeur, conseillé par son agent.';

/** L'avis motivé : le calcul n'a pas donné de fourchette, l'agent apporte la sienne et ses ventes vérifiées. */
export interface ManualDraftInput {
  networkId: string;
  propertyId: string;
  /** Un terrain ou un immeuble n'a jamais de fourchette du calcul : seulement l'avis motivé. */
  kind: 'apartment' | 'house' | 'land' | 'building';
  surface: number;
  manual: ManualInput;
  reason: NoRangeReason;
  comparablesFound: number;
  data: DataInfo;
  facts?: PublicFacts | null;
  /** Les limites de la fourchette de l'agent, gardées dans l'avis pour chaque ajustement et la validation. */
  limits?: Pick<ManualSettings, 'maxSpread' | 'maxGapFromReferences'>;
}

/** Ce que l'avis motivé garde de ses ventes pour revérifier la fourchette de l'agent [R690]. */
interface ManualComputed {
  method?: string;
  surface?: number;
  referencesMedianPerM2?: number;
  limits?: Pick<ManualSettings, 'maxSpread' | 'maxGapFromReferences'>;
}

/** Une fourchette permise : pour un avis motivé, celle qui suit ses ventes vérifiées ; sinon, toute fourchette valide. */
function rangeAllowedFor(computed: ManualComputed, low: number, high: number): boolean {
  if (computed.method !== 'manual') return true;
  if (typeof computed.surface !== 'number' || typeof computed.referencesMedianPerM2 !== 'number') return false;
  return manualRangeAllowed(low, high, computed.referencesMedianPerM2, computed.surface, computed.limits ?? DEFAULT_MANUAL_SETTINGS);
}

const MONTHS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
const monthLabel = (yyyyMm: string): string => `${MONTHS[Number(yyyyMm.slice(5, 7)) - 1] ?? ''} ${yyyyMm.slice(0, 4)}`.trim();
/** Les milliers séparés par une espace simple, pour que le contrôle du texte lise le nombre entier [R10]. */
export const euros = (n: number): string => `${String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')} €`;

function timeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('délai dépassé')), ms);
  });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

export class AvisDeValeur {
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(
    private readonly db: SqlDatabase,
    private readonly journal: JournalStore,
    private readonly options: AvisOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => crypto.randomUUID());
  }

  /** Le brief de l'IA et les chiffres permis dans le texte [R10]. */
  private briefOf(input: DraftInput): { brief: ValuationBrief; figures: (string | number)[] } {
    const r = input.range;
    const energy = input.facts?.energy.ok ? input.facts.energy.value.energyClass : null;
    const risks = input.facts?.risks.ok ? input.facts.risks.value.map((x) => x.label) : [];
    const town = input.facts?.address.ok ? input.facts.address.value.town : null;
    const brief: ValuationBrief = {
      kind: input.kind,
      surface: input.surface,
      town,
      low: r.low,
      high: r.high,
      pricePerM2: r.pricePerM2,
      medianPerM2: r.medianPerM2,
      comparables: r.comparables.length,
      radius: r.radius,
      adjustments: r.adjustments,
      energyClass: energy,
      risks,
      dataMonth: r.data.lastSale ? r.data.lastSale.slice(0, 7) : null,
      latestUsedSale: r.latestUsedSale,
      recentMissing: r.data.recentMissing,
      window: r.window,
    };
    const dates = [r.latestUsedSale, ...(r.data.lastSale ? [r.data.lastSale.slice(0, 7)] : []), ...r.comparables.map((c) => c.month)].flatMap((m) => [m.slice(0, 4)]);
    const figures: (string | number)[] = [
      r.low,
      r.high,
      r.pricePerM2,
      r.medianPerM2,
      r.comparables.length,
      r.radius,
      input.surface,
      ...r.adjustments.map((a) => Math.abs(a.pct)),
      ...r.data.years,
      ...dates,
      r.window.months,
      r.window.from.slice(0, 4),
      r.window.excludedOld,
    ];
    return { brief, figures };
  }

  /** Le texte de secours, écrit par le code avec les seuls chiffres du calcul. */
  private fallbackText(b: ValuationBrief): string {
    const what = b.kind === 'house' ? 'maison' : 'appartement';
    const lines = [
      `Pour votre ${what} de ${String(b.surface).replace('.', ',')} m²${b.town ? ` à ${b.town}` : ''}, nous estimons la valeur entre ${euros(b.low)} et ${euros(b.high)}.`,
      `Méthode : ${b.comparables} ventes réelles de biens comparables, situées à moins de ${b.radius} m, dont la plus récente date de ${monthLabel(b.latestUsedSale)}. Leur prix médian est de ${euros(b.medianPerM2)} le m², soit ${euros(b.pricePerM2)} le m² pour votre bien une fois ses caractéristiques prises en compte.`,
    ];
    if (b.adjustments.length > 0) {
      lines.push(`Caractéristiques prises en compte : ${b.adjustments.map((a) => `${a.label.toLowerCase()} ${a.pct > 0 ? '+' : '-'}${Math.abs(a.pct)} %`).join(', ')}.`);
    }
    if (b.energyClass) lines.push(`Diagnostic énergétique connu : classe ${b.energyClass}.`);
    if (b.risks.length > 0) lines.push(`Risques signalés sur la commune : ${b.risks.join(', ').toLowerCase()}.`);
    lines.push('Pour la mise en vente, votre agent vous propose un plan de commercialisation adapté à votre bien et à votre calendrier.');
    return lines.join('\n\n');
  }

  /**
   * Le pied que le code ajoute toujours, quel que soit l'auteur du texte : la date des ventes utilisées et des données,
   * ce qui manque encore [R28], puis la mention d'avis.
   */
  private footer(b: ValuationBrief): string {
    const data = [
      `Ventes utilisées jusqu’à ${monthLabel(b.latestUsedSale)}${b.dataMonth ? `, données publiées jusqu’à ${monthLabel(b.dataMonth)}` : ''}.`,
      // La fenêtre de temps et sa raison, toujours dites [R691].
      `Seules les ventes depuis ${monthLabel(b.window.from)} sont retenues, soit ${b.window.months} mois. ${b.window.justification}${b.window.excludedOld > 0 ? ` ${b.window.excludedOld === 1 ? 'Une vente plus ancienne a été écartée.' : `${b.window.excludedOld} ventes plus anciennes ont été écartées.`}` : ''}`,
      ...(b.recentMissing ? ['Les ventes des derniers mois ne sont pas encore publiées : votre agent complète avec le marché qu’il connaît.'] : []),
    ].join(' ');
    return `${data}\n\n${ADVICE_NOTICE}`;
  }

  /** Le brouillon, toujours : un texte de l'IA qui ne passe pas le contrôle est remplacé par le secours. */
  async draft(input: DraftInput): Promise<ValuationReport> {
    const { brief, figures } = this.briefOf(input);
    const property = await this.db.first<{ agent_id: string | null }>('SELECT agent_id FROM properties WHERE id = ? AND network_id = ?', [input.propertyId, input.networkId]);
    if (!property) throw new Error('Bien inconnu dans ce réseau.');
    const footer = this.footer(brief);
    const check = (text: string) => checkText(`${text}\n\n${footer}`, { audience: 'client', channel: 'email', figures });
    // Le texte dit la fourchette du calcul, telle quelle : sinon il part au secours.
    const saysRange = (text: string) => text.includes(euros(brief.low)) && text.includes(euros(brief.high));
    let text = this.fallbackText(brief);
    let by: ValuationReport['text_by'] = 'fallback';
    let aiNote: string | null = null;
    if (this.options.writer) {
      try {
        const written = (await timeout(this.options.writer.write(brief), this.options.aiTimeoutMs ?? 30_000)).trim();
        const problems = check(written);
        if (problems.length === 0 && saysRange(written)) {
          text = written;
          by = 'ai';
        } else {
          aiNote = problems[0]?.rule ?? 'range_missing';
        }
      } catch {
        aiNote = 'timeout_or_error';
      }
    }
    if (by === 'fallback' && check(text).length > 0) throw new Error('Le texte de secours ne passe pas le contrôle du texte.');
    const cited = input.range.comparables.slice(0, this.options.citedSales ?? 12).map((c): CitedSale => {
      const d = input.details?.get(c.id);
      return { month: c.month, surface: c.surface, pricePerM2: c.pricePerM2, distance: Math.round(c.distance / 10) * 10, ...(d ? { street: d.street, town: d.town } : {}) };
    });
    const computed = {
      // Le bien estimé, pour que tout ce qui s'ajoute à l'avis porte sur lui seul (HX32) : sorte, surface, commune.
      kind: input.kind,
      surface: input.surface,
      inseeCode: input.facts?.address.ok ? input.facts.address.value.inseeCode : null,
      low: input.range.low,
      high: input.range.high,
      pricePerM2: input.range.pricePerM2,
      medianPerM2: input.range.medianPerM2,
      margin: input.range.margin,
      comparables: input.range.comparables.length,
      radius: input.range.radius,
      cited,
      adjustments: input.range.adjustments,
      latestUsedSale: input.range.latestUsedSale,
      data: input.range.data,
      window: input.range.window,
      energyClass: brief.energyClass,
      risks: brief.risks,
      missing: input.facts?.missing ?? null,
      figures,
      footer,
    };
    const at = this.now().toISOString();
    const report: ValuationReport = {
      id: this.newId(),
      network_id: input.networkId,
      property_id: input.propertyId,
      agent_id: property.agent_id,
      status: 'draft',
      computed: JSON.stringify(computed),
      computed_low: input.range.low,
      computed_high: input.range.high,
      agent_low: null,
      agent_high: null,
      text: `${text}\n\n${footer}`,
      text_by: by,
      created_at: at,
      updated_at: at,
      validated_by: null,
      validated_at: null,
    };
    await this.db.run(
      `INSERT INTO valuation_reports (id, network_id, property_id, agent_id, status, computed, computed_low, computed_high, agent_low, agent_high, text, text_by, created_at, updated_at, validated_by, validated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [report.id, report.network_id, report.property_id, report.agent_id, report.status, report.computed, report.computed_low, report.computed_high, null, null, report.text, report.text_by, at, at, null, null],
    );
    await this.log('avis.brouillon', 'system:estimation', report, { textBy: by, aiRefused: aiNote });
    return report;
  }

  /**
   * Le brouillon d'un avis motivé par les ventes de l'agent [R690]. Le texte est écrit par le code : il dit qu'il n'y a
   * pas de fourchette automatique et pourquoi, que la fourchette est celle de l'agent, et sur combien de ventes vérifiées
   * elle s'appuie. Il ne passe pas par l'IA. Il reste un brouillon jusqu'à la validation de l'agent [R30].
   */
  async draftManual(input: ManualDraftInput): Promise<ValuationReport> {
    const property = await this.db.first<{ agent_id: string | null }>('SELECT agent_id FROM properties WHERE id = ? AND network_id = ?', [input.propertyId, input.networkId]);
    if (!property) throw new Error('Bien inconnu dans ce réseau.');
    const { low, high, references } = input.manual;
    const median = referencesMedian(references);
    const latest = references.reduce((m, r) => (r.month > m ? r.month : m), references[0]!.month);
    const energy = input.facts?.energy.ok ? input.facts.energy.value.energyClass : null;
    const risks = input.facts?.risks.ok ? input.facts.risks.value.map((x) => x.label) : [];
    const town = input.facts?.address.ok ? input.facts.address.value.town : null;
    const what = { house: 'maison', apartment: 'appartement', land: 'terrain', building: 'immeuble' }[input.kind];
    const lines = [`Pour votre ${what} de ${String(input.surface).replace('.', ',')} m²${town ? ` à ${town}` : ''}, votre agent estime la valeur entre ${euros(low)} et ${euros(high)}.`];
    if (energy) lines.push(`Diagnostic énergétique connu : classe ${energy}.`);
    if (risks.length > 0) lines.push(`Risques signalés sur la commune : ${risks.join(', ').toLowerCase()}.`);
    lines.push('Pour la mise en vente, votre agent vous propose un plan de commercialisation adapté à votre bien et à votre calendrier.');
    // Ce que l'avis motivé doit toujours dire est dans le pied, que le code garde à chaque correction du texte [R690].
    const footer = [
      `Il n’y a pas de fourchette automatique pour ce bien : ${MANUAL_REASON_TEXT[input.reason] ?? 'les ventes publiées ne suffisent pas'}. La fourchette est celle de votre agent. Elle s’appuie sur ${references.length} ventes réelles de biens comparables qu’il a vérifiées lui-même, dont la plus récente date de ${monthLabel(latest)}. Leur prix médian est de ${perM2Text(median)} le m².`,
      MANUAL_ADVICE_NOTICE,
    ].join('\n\n');
    const text = `${lines.join('\n\n')}\n\n${footer}`;
    const years = [...new Set(references.map((r) => r.month.slice(0, 4)))];
    const figures: (string | number)[] = [low, high, perM2Shown(median), references.length, input.surface, ...years, ...references.map((r) => r.pricePerM2)];
    if (checkText(text, { audience: 'client', channel: 'email', figures }).length > 0) throw new Error('Le texte de l’avis motivé ne passe pas le contrôle du texte.');
    const computed = {
      // Pas de calcul : la fourchette est celle de l'agent, et l'avis le garde à part de tout avis calculé [R690].
      method: 'manual' as const,
      kind: input.kind,
      surface: input.surface,
      inseeCode: input.facts?.address.ok ? input.facts.address.value.inseeCode : null,
      low,
      high,
      noRangeReason: input.reason,
      comparablesFound: input.comparablesFound,
      // Aucune vente publiée citée, ni médiane publiée : rien de ce qui suit l'avis ne prend les ventes de l'agent pour
      // des ventes publiées.
      medianPerM2: null,
      comparables: 0,
      radius: null,
      cited: [] as CitedSale[],
      adjustments: [] as { label: string; pct: number }[],
      references: references.map((r) => ({ ...r, proofLabel: REFERENCE_PROOFS[r.proof] })),
      referencesMedianPerM2: median,
      limits: input.limits ?? { maxSpread: DEFAULT_MANUAL_SETTINGS.maxSpread, maxGapFromReferences: DEFAULT_MANUAL_SETTINGS.maxGapFromReferences },
      latestUsedSale: latest,
      data: input.data,
      energyClass: energy,
      risks,
      missing: input.facts?.missing ?? null,
      figures,
      footer,
    };
    const at = this.now().toISOString();
    const report: ValuationReport = {
      id: this.newId(),
      network_id: input.networkId,
      property_id: input.propertyId,
      agent_id: property.agent_id,
      status: 'draft',
      computed: JSON.stringify(computed),
      // La fourchette de l'agent est aussi celle du brouillon : il n'y en a pas d'autre.
      computed_low: low,
      computed_high: high,
      agent_low: low,
      agent_high: high,
      text,
      text_by: 'fallback',
      created_at: at,
      updated_at: at,
      validated_by: null,
      validated_at: null,
    };
    await this.db.run(
      `INSERT INTO valuation_reports (id, network_id, property_id, agent_id, status, computed, computed_low, computed_high, agent_low, agent_high, text, text_by, created_at, updated_at, validated_by, validated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [report.id, report.network_id, report.property_id, report.agent_id, report.status, report.computed, low, high, low, high, report.text, report.text_by, at, at, null, null],
    );
    await this.log('avis.brouillon', 'system:estimation', report, { textBy: 'fallback', manual: true, reason: input.reason });
    return report;
  }

  async get(id: string): Promise<ValuationReport | null> {
    return this.db.first<ValuationReport>('SELECT * FROM valuation_reports WHERE id = ?', [id]);
  }

  /** Seul l'agent actif qui suit le bien, dans son réseau, ajuste et valide [R30]. */
  private async mine(viewer: Viewer, id: string): Promise<AvisResult<ValuationReport>> {
    const report = await this.get(id);
    if (!report || report.network_id !== viewer.networkId) return { ok: false, rule: 'R30', code: 'unknown' };
    const property = await this.db.first<{ agent_id: string | null }>('SELECT agent_id FROM properties WHERE id = ? AND network_id = ?', [report.property_id, report.network_id]);
    const agent =
      viewer.role === 'agent'
        ? await this.db.first<{ status: string }>('SELECT status FROM agents WHERE id = ? AND network_id = ?', [viewer.userId, viewer.networkId])
        : null;
    if (viewer.role !== 'agent' || !property || property.agent_id !== viewer.userId || agent?.status !== 'active') {
      await this.log('avis.refuse', `${viewer.role}:${viewer.userId}`, report, { code: 'not_following_agent' });
      return { ok: false, rule: 'R30', code: 'not_following_agent' };
    }
    if (report.status === 'validated') return { ok: false, rule: 'R30', code: 'already_validated' };
    return { ok: true, value: report };
  }

  /** L'agent change la fourchette ou le texte ; le calcul du code reste à côté, tel quel. */
  async adjust(viewer: Viewer, id: string, change: { low?: number; high?: number; text?: string }): Promise<AvisResult<ValuationReport>> {
    const found = await this.mine(viewer, id);
    if (!found.ok) return found;
    const r = found.value;
    const low = change.low ?? r.agent_low ?? r.computed_low;
    const high = change.high ?? r.agent_high ?? r.computed_high;
    if (!Number.isInteger(low) || !Number.isInteger(high) || low <= 0 || high <= low) return { ok: false, rule: 'R30', code: 'invalid_range' };
    const rangeChanged = change.low !== undefined || change.high !== undefined;
    const computed = JSON.parse(r.computed) as { figures: (string | number)[]; footer: string } & ManualComputed;
    // L'avis motivé garde une fourchette qui suit ses ventes vérifiées, ajustement compris [R690].
    if (!rangeAllowedFor(computed, low, high)) return { ok: false, rule: 'R30', code: 'invalid_range' };
    const before = { low: r.agent_low ?? r.computed_low, high: r.agent_high ?? r.computed_high };
    let text: string;
    if (change.text !== undefined) {
      // Le texte de l'agent passe le même contrôle que celui de l'IA [R06 à R10] ; le pied du code reste.
      const body = change.text.trim().replace(computed.footer, '').trim();
      text = `${body}\n\n${computed.footer}`;
      // Une borne du calcul que l'agent a écartée n'est plus un chiffre permis : l'avis ne dit qu'une fourchette.
      const dropped = [r.computed_low, r.computed_high].filter((b) => b !== low && b !== high);
      const figures = computed.figures.filter((f) => typeof f !== 'number' || !dropped.includes(f));
      if (body === '' || checkText(text, { audience: 'client', channel: 'email', figures: [...figures, low, high] }).length > 0) {
        return { ok: false, rule: 'R30', code: 'text_refused' };
      }
    } else {
      // Fourchette changée sans nouveau texte : la phrase de fourchette suit.
      const swap = new Map([
        [euros(before.low), euros(low)],
        [euros(before.high), euros(high)],
      ]);
      const pattern = new RegExp([...swap.keys()].map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g');
      // En un seul passage : une borne déjà remplacée n'est jamais remplacée une seconde fois.
      text = r.text.replace(pattern, (m) => swap.get(m) ?? m);
    }
    // Une version toujours plus récente que la version lue, même horloge arrêtée ou en retard sur un relevé joint
    // (HX32) : une version déjà lue ne revient jamais [R30, R306].
    const nowMs = this.now().getTime();
    const readMs = Date.parse(r.updated_at);
    const at = new Date(Number.isFinite(readMs) && nowMs <= readMs ? readMs + 1 : nowMs).toISOString();
    // Sur la version lue seulement : validée ou modifiée entre-temps, l'ajustement n'est pas fait, et c'est dit.
    const done = await this.db.run(
      `UPDATE valuation_reports SET agent_low = ?, agent_high = ?, text = ?, text_by = ?, updated_at = ?
       WHERE id = ? AND status = 'draft' AND text = ? AND agent_low IS ? AND agent_high IS ? AND updated_at = ?`,
      [rangeChanged ? low : r.agent_low, rangeChanged ? high : r.agent_high, text, change.text === undefined ? r.text_by : 'agent', at, id, r.text, r.agent_low, r.agent_high, r.updated_at],
    );
    if (done.changes !== 1) return { ok: false, rule: 'R30', code: 'changed_meanwhile' };
    const updated = (await this.get(id))!;
    await this.log('avis.ajuste', `agent:${viewer.userId}`, updated, { range: rangeChanged, text: change.text !== undefined });
    return { ok: true, value: updated };
  }

  /** La validation par l'agent qui suit le bien ; un avis validé ne change plus. */
  async validate(viewer: Viewer, id: string, readVersion?: string): Promise<AvisResult<ValuationReport>> {
    const found = await this.mine(viewer, id);
    if (!found.ok) return found;
    const r = found.value;
    // Avec la version lue : celle qu'un autre appareil a enregistrée depuis ne se valide pas à l'aveugle.
    if (readVersion !== undefined && readVersion !== r.updated_at) return { ok: false, rule: 'R30', code: 'changed_meanwhile' };
    // Un avis motivé ne se valide qu'avec une fourchette qui suit ses ventes vérifiées [R690].
    if (!rangeAllowedFor(JSON.parse(r.computed) as ManualComputed, r.agent_low ?? r.computed_low, r.agent_high ?? r.computed_high)) return { ok: false, rule: 'R30', code: 'invalid_range' };
    // L'avis validé ne porte qu'une fourchette : celle qui partira.
    if (!r.text.includes(euros(r.agent_low ?? r.computed_low)) || !r.text.includes(euros(r.agent_high ?? r.computed_high))) {
      return { ok: false, rule: 'R30', code: 'range_not_in_text' };
    }
    // Ni la fourchette du calcul quand l'agent l'a changée : le texte a pu être écrit avant le changement.
    const kept = [r.agent_low ?? r.computed_low, r.agent_high ?? r.computed_high];
    if ([r.computed_low, r.computed_high].some((b) => !kept.includes(b) && r.text.includes(euros(b)))) {
      return { ok: false, rule: 'R30', code: 'other_range_in_text' };
    }
    const at = this.now().toISOString();
    // On valide la version vérifiée, et elle seule : une modification faite entre-temps demande une nouvelle validation.
    const done = await this.db.run(
      `UPDATE valuation_reports SET status = 'validated', validated_by = ?, validated_at = ?, updated_at = ?
       WHERE id = ? AND status = 'draft' AND text = ? AND agent_low IS ? AND agent_high IS ? AND updated_at = ?`,
      [viewer.userId, at, at, id, r.text, r.agent_low, r.agent_high, r.updated_at],
    );
    if (done.changes !== 1) return { ok: false, rule: 'R30', code: 'changed_meanwhile' };
    const validated = (await this.get(id))!;
    await this.log('avis.valide', `agent:${viewer.userId}`, validated, {});
    return { ok: true, value: validated };
  }

  /**
   * Le seul passage vers un envoi : l'avis tel que validé, avec la fourchette de l'agent s'il l'a changée ;
   * un brouillon est refusé [R30].
   */
  async releasable(id: string): Promise<AvisResult<{ report: ValuationReport; low: number; high: number }>> {
    const report = await this.get(id);
    if (!report) return { ok: false, rule: 'R30', code: 'unknown' };
    if (report.status !== 'validated' || !report.validated_by) {
      await this.log('avis.refuse', 'system:envoi', report, { code: 'not_validated' });
      return { ok: false, rule: 'R30', code: 'not_validated' };
    }
    // Validé par un agent qui ne suit plus le bien, ou parti : ce n'est plus la validation de l'agent qui le suit.
    const follower = await this.db.first<{ status: string }>(
      'SELECT a.status FROM properties p JOIN agents a ON a.id = p.agent_id WHERE p.id = ? AND p.network_id = ? AND p.agent_id = ?',
      [report.property_id, report.network_id, report.validated_by],
    );
    if (follower?.status !== 'active') {
      await this.log('avis.refuse', 'system:envoi', report, { code: 'not_following_agent' });
      return { ok: false, rule: 'R30', code: 'not_following_agent' };
    }
    return { ok: true, value: { report, low: report.agent_low ?? report.computed_low, high: report.agent_high ?? report.computed_high } };
  }

  private async log(type: string, actor: string, report: ValuationReport, data: Record<string, string | boolean | null>): Promise<void> {
    await appendEvent(this.journal, { type, actor, subject: `property:${report.property_id}`, data: { report: report.id, status: report.status, ...data } }, this.now);
  }
}
