/**
 * Chaque mandat a sa source (M20, G03). Un mandat signé ne se range qu'avec sa source [R38] : donnée par l'agent,
 * ou reprise de la fiche quand elle y est connue. Une liste achetée ou les ventes publiques ne sont jamais une source,
 * et sont refusées avec leur règle [R37]. Chaque mois, les mandats sont comptés par source, sans donnée personnelle,
 * pour garder ce qui rapporte et arrêter le reste. Rien ne s'efface, rien ne change [R17].
 */
import type { Acces } from '../acces/acces.ts';
import type { Viewer } from '../acces/droits.ts';
import type { SqlDatabase } from '../db/sql.ts';
import type { FicheUnique } from '../fiche/fusion.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';

export const MANDATE_SOURCES = [
  'site',
  'online_valuation',
  'value_tracking',
  'referral',
  'social',
  'portal',
  'agent_network',
  'neighbourhood_letter',
  'other',
] as const;
export type MandateSource = (typeof MANDATE_SOURCES)[number];

/** Libellés français, pour l'application et le compte du mois. */
export const MANDATE_SOURCE_LABELS: Readonly<Record<MandateSource, string>> = Object.freeze({
  site: 'Site',
  online_valuation: 'Estimation en ligne',
  value_tracking: 'Suivi de valeur',
  referral: 'Recommandation',
  social: 'Réseaux sociaux',
  portal: 'Portail',
  agent_network: 'Connaissance de l’agent',
  neighbourhood_letter: 'Lettre de quartier',
  other: 'Autre',
});

/** Sources interdites [R37] : refusées par leur nom, même tapées à la main. */
export const FORBIDDEN_SOURCES: readonly string[] = Object.freeze(['purchased_list', 'public_sales', 'dvf', 'bought_list']);

/**
 * La source d'une fiche, par le canal de sa première source connue. Un canal d'import d'outil (GoHighLevel, ManyChat)
 * ne dit pas d'où vient la personne : pas de reprise, l'agent doit la donner.
 */
const CHANNEL_SOURCES: Readonly<Record<string, { kind: MandateSource; detail: string | null }>> = Object.freeze({
  site: { kind: 'site', detail: null },
  site_form: { kind: 'site', detail: null },
  assistant: { kind: 'site', detail: null },
  instagram: { kind: 'social', detail: null },
  facebook: { kind: 'social', detail: null },
  whatsapp: { kind: 'other', detail: 'WhatsApp' },
  email: { kind: 'other', detail: 'mail reçu' },
});

/** Les mêmes sources interdites, écrites en clair dans le détail d'« autre » [R37]. */
const FORBIDDEN_DETAIL = /(liste|fichier|base)s?\s+(de\s+\S+\s+)?achet|\bdvf\b|ventes?\s+publiques?|donn[ée]es\s+de\s+ventes|valeurs?\s+fonci[eè]res?/i;

const DETAIL_MAX = 80;

export interface NewMandate {
  personId: string;
  projectId?: string | null;
  propertyId?: string | null;
  signedAt: Date;
  /** Absente : reprise de la fiche si elle y est connue ; sinon le mandat est refusé [R38]. */
  source?: string | null;
  sourceDetail?: string | null;
}

export type MandateRefusal =
  | { ok: false; rule: 'R38'; code: 'missing_source' | 'missing_detail' | 'unknown_source' | 'detail_too_long' }
  | { ok: false; rule: 'R37'; code: 'forbidden_source' }
  | { ok: false; rule: 'R16'; code: string }
  | { ok: false; rule: null; code: 'bad_date' | 'project_mismatch' | 'property_mismatch' | 'no_agent' };

export type MandateResult = { ok: true; id: string; source: MandateSource; fromFiche: boolean } | MandateRefusal;

export interface MonthlyCount {
  /** `AAAA-MM`, heure de Paris. */
  month: string;
  agentId: string | null;
  total: number;
  bySource: Record<MandateSource, number>;
}

export interface MandatsOptions {
  now?: () => Date;
  newId?: () => string;
  timeZone?: string;
}

const placeholders = (n: number): string => Array.from({ length: n }, () => '?').join(', ');

export class Mandats {
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly timeZone: string;

  constructor(
    private readonly db: SqlDatabase,
    private readonly fiche: FicheUnique,
    private readonly journal: JournalStore,
    options: MandatsOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => crypto.randomUUID());
    this.timeZone = options.timeZone ?? 'Europe/Paris';
  }

  /** Range un mandat signé, avec sa source ; seul l'agent qui suit la fiche, ou la direction, le range [R16]. */
  async record(acces: Acces, viewer: Viewer, input: NewMandate): Promise<MandateResult> {
    if (!(input.signedAt instanceof Date) || Number.isNaN(input.signedAt.getTime())) return { ok: false, rule: null, code: 'bad_date' };
    const raw = typeof input.source === 'string' ? input.source.trim().toLowerCase() : null;
    if (raw !== null && FORBIDDEN_SOURCES.includes(raw)) return { ok: false, rule: 'R37', code: 'forbidden_source' };
    if (raw !== null && raw !== '' && !(MANDATE_SOURCES as readonly string[]).includes(raw)) return { ok: false, rule: 'R38', code: 'unknown_source' };
    const detail = typeof input.sourceDetail === 'string' && input.sourceDetail.trim() !== '' ? input.sourceDetail.trim() : null;
    if (detail !== null && detail.length > DETAIL_MAX) return { ok: false, rule: 'R38', code: 'detail_too_long' };
    if (detail !== null && FORBIDDEN_DETAIL.test(detail)) return { ok: false, rule: 'R37', code: 'forbidden_source' };

    const read = await acces.readFiche(viewer, input.personId);
    if (!read.ok) return read;
    if (read.view !== 'full') return { ok: false, rule: 'R16', code: 'not_assigned' };
    const fiche = read.value;
    const ids = fiche.members.map((m) => m.id);
    const agentId = viewer.role === 'agent' ? viewer.userId : (fiche.members.map((m) => m.agent_id).find((a) => a !== null) ?? null);
    if (agentId === null) return { ok: false, rule: null, code: 'no_agent' };

    if (input.projectId) {
      const project = await this.db.first<{ person_id: string }>('SELECT person_id FROM projects WHERE id = ? AND network_id = ?', [input.projectId, viewer.networkId]);
      if (!project || !ids.includes(project.person_id)) return { ok: false, rule: null, code: 'project_mismatch' };
    }
    if (input.propertyId) {
      const property = await this.db.first<{ id: string }>('SELECT id FROM properties WHERE id = ? AND network_id = ?', [input.propertyId, viewer.networkId]);
      if (!property) return { ok: false, rule: null, code: 'property_mismatch' };
    }

    let kind: MandateSource;
    let sourceDetail: string | null;
    let sourceId: string | null = null;
    let fromFiche = false;
    if (raw !== null && raw !== '') {
      kind = raw as MandateSource;
      if (kind === 'other' && detail === null) return { ok: false, rule: 'R38', code: 'missing_detail' };
      sourceDetail = kind === 'other' ? detail : null;
    } else {
      // Reprise de la fiche : sa première source connue, si son canal dit d'où vient la personne.
      const first = await this.db.first<{ id: string; channel: string }>(
        `SELECT id, channel FROM sources WHERE person_id IN (${placeholders(ids.length)}) ORDER BY occurred_at, created_at, id LIMIT 1`,
        ids,
      );
      const mapped = first ? CHANNEL_SOURCES[first.channel] : undefined;
      if (!first || !mapped) return { ok: false, rule: 'R38', code: 'missing_source' };
      kind = mapped.kind;
      sourceDetail = mapped.detail;
      sourceId = first.id;
      fromFiche = true;
    }

    const id = this.newId();
    await this.db.run(
      `INSERT INTO mandates (id, network_id, agent_id, person_id, project_id, property_id, signed_at, source_kind, source_detail, source_id, recorded_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        viewer.networkId,
        agentId,
        fiche.person.id,
        input.projectId ?? null,
        input.propertyId ?? null,
        input.signedAt.toISOString(),
        kind,
        sourceDetail,
        sourceId,
        `${viewer.role}:${viewer.userId}`,
        this.now().toISOString(),
      ],
    );
    // Le journal porte la source, jamais son détail ni un nom [R13].
    await appendEvent(
      this.journal,
      { type: 'mandat.range', actor: `${viewer.role}:${viewer.userId}`, subject: `person:${fiche.person.id}`, data: { mandate: id, source: kind, fromFiche } },
      this.now,
    );
    return { ok: true, id, source: kind, fromFiche };
  }

  /**
   * Le compte des mandats du mois par source, sans aucune donnée personnelle. Un agent ne voit que ses chiffres ;
   * la direction, ceux du réseau ou d'un agent [R16].
   */
  async monthly(acces: Acces, viewer: Viewer, month: string, agentId?: string): Promise<{ ok: true; value: MonthlyCount } | { ok: false; rule: 'R16'; code: string } | { ok: false; rule: null; code: 'bad_month' }> {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return { ok: false, rule: null, code: 'bad_month' };
    const target = viewer.role === 'agent' ? viewer.userId : (agentId ?? null);
    if (target !== null) {
      const decision = await acces.canSeeFigures(viewer, target);
      if (!decision.allowed) return { ok: false, rule: 'R16', code: decision.code };
    } else if (viewer.role !== 'direction') {
      return { ok: false, rule: 'R16', code: 'role' };
    }
    // Les bornes du mois, heure de Paris : on prend large en temps universel, puis on garde le mois local exact.
    const [y, m] = month.split('-').map(Number) as [number, number];
    const from = new Date(Date.UTC(y, m - 1, 1) - 86_400_000).toISOString();
    const to = new Date(Date.UTC(y, m, 1) + 86_400_000).toISOString();
    const rows = await this.db.all<{ signed_at: string; source_kind: MandateSource }>(
      `SELECT signed_at, source_kind FROM mandates WHERE network_id = ? AND signed_at >= ? AND signed_at < ?${target === null ? '' : ' AND agent_id = ?'}`,
      target === null ? [viewer.networkId, from, to] : [viewer.networkId, from, to, target],
    );
    const bySource = Object.fromEntries(MANDATE_SOURCES.map((s) => [s, 0])) as Record<MandateSource, number>;
    let total = 0;
    for (const row of rows) {
      if (localMonth(new Date(row.signed_at), this.timeZone) !== month) continue;
      bySource[row.source_kind] += 1;
      total += 1;
    }
    await appendEvent(
      this.journal,
      { type: 'mandats.compte_lu', actor: `${viewer.role}:${viewer.userId}`, subject: target === null ? null : `agent:${target}`, data: { rule: 'R16', month, total } },
      this.now,
    );
    return { ok: true, value: { month, agentId: target, total, bySource } };
  }
}

function localMonth(at: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit' }).formatToParts(at);
  return `${parts.find((p) => p.type === 'year')?.value}-${parts.find((p) => p.type === 'month')?.value}`;
}
