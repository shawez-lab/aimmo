/**
 * L'avis de valeur à imprimer, à la marque de l'agent (M04, E08).
 *
 * Rendu depuis l'avis validé seulement, par le seul passage vers un envoi [R30] : jamais un brouillon, jamais l'avis
 * d'un agent qui ne suit plus le bien. La fourchette est celle que l'agent a validée ; le texte, la date des données et
 * la mention d'avis sont ceux de l'avis, tels quels [R28]. Les ventes citées n'ont ni nom ni numéro de voie [R29].
 * Le journal porte l'avis et le bien, ni texte ni chiffre [R13]. Le texte est échappé. Le dessin suit le système de
 * design (Z03) ; la longueur suit le texte, chaque page en A4, et le navigateur l'enregistre en PDF.
 */
import type { Acces } from '../acces/acces.ts';
import type { Viewer } from '../acces/droits.ts';
import { agentBlock, type AgentCard } from '../annonces/page-bien.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { PRINT_DESIGN_CSS } from '../design/systeme.ts';
import { escapeHtml } from '../documents/modeles.ts';
import { localTime } from '../envoi/horaires.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import { AvisDeValeur, euros, type CitedSale, type ValuationReport } from './avis.ts';
import { perM2Text } from './avis-manuel.ts';
import { AGENT_ADJUSTMENT_MOTIVES } from './fourchette.ts';
import { renderMarketSection, type MarketSection } from './marche-avis.ts';

/** Ce que l'avis garde du calcul et que la page montre. */
interface PrintedFacts {
  medianPerM2: number;
  comparables: number;
  radius: number;
  cited: CitedSale[];
  adjustments: { label: string; pct: number; source?: 'agent'; motive?: string }[];
  /** L'avis motivé par les ventes vérifiées de l'agent [R690]. */
  method?: 'manual';
  references?: { month: string; surface: number; pricePerM2: number; proofLabel: string; street?: string; town?: string }[];
  referencesMedianPerM2?: number;
}

export interface ValuationPrintInput {
  low: number;
  high: number;
  /** `AAAA-MM-JJ`, le jour de la validation à l'heure de Paris. */
  validatedOn: string;
  /** Le texte de l'avis validé, avec son pied. */
  text: string;
  facts: PrintedFacts;
  agent: AgentCard;
  /** Le dernier relevé du marché joint au brouillon avant sa validation (HX32), s'il y en a un. */
  market?: MarketSection | null;
}

export type PrintRefusal = { ok: false; rule: 'R16' | 'R30'; code: string } | { ok: false; rule: null; code: 'unknown' };

const MONTHS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
const monthLabel = (yyyyMm: string): string => `${MONTHS[Number(yyyyMm.slice(5, 7)) - 1] ?? ''} ${yyyyMm.slice(0, 4)}`.trim();
const dayLabel = (day: string): string => `${Number(day.slice(8, 10))} ${monthLabel(day.slice(0, 7))}`;
const decimal = (n: number): string => String(n).replace('.', ',');

/** Une voie qui commence par un chiffre pourrait en porter le numéro : elle n'est pas citée [R29]. */
const safeStreet = (street: string | undefined): string | null => (street && !/^\s*\d/.test(street) ? street : null);

const CSS =
  PRINT_DESIGN_CSS +
  `@page{size:A4;margin:16mm}
body{font:10.5pt/1.5 var(--police-titre)}
.marque{display:flex;justify-content:space-between;gap:6mm;font:600 8pt/1 var(--police-texte);letter-spacing:.12em;text-transform:uppercase;color:var(--accent);border-bottom:1pt solid var(--accent);padding-bottom:4mm}
h1{font-size:20pt;line-height:1.15;margin:8mm 0 2mm}
h2{font-size:12pt;margin:7mm 0 2mm;break-after:avoid;page-break-after:avoid}
.prix{font-size:26pt;font-weight:700;color:var(--accent);margin:3mm 0 6mm;letter-spacing:-.01em}
.prix span{font-size:12pt;font-weight:400}
.date{font:400 9pt var(--police-texte);color:var(--doux);margin:0}
.texte p{margin:0 0 3mm}
table{width:100%;border-collapse:collapse;font:400 9pt/1.35 var(--police-texte)}
caption{text-align:left;color:var(--doux);padding-bottom:2mm}
th{text-align:left;font-weight:600;border-bottom:1pt solid var(--encre);padding:1mm 2mm 1mm 0}
td{border-bottom:.5pt solid var(--trait);padding:1mm 2mm 1mm 0}
tr{break-inside:avoid;page-break-inside:avoid}
.nombre{text-align:right;white-space:nowrap}
ul{margin:0;padding-left:5mm}
.agent{border-top:1pt solid var(--accent);margin-top:6mm;padding-top:3mm;font-size:9.5pt;break-inside:avoid;page-break-inside:avoid}.agent p{margin:0}.agent a{color:inherit;text-decoration:none}`;

/** La page à imprimer d'un avis validé : la fourchette d'abord, le texte, l'agent, puis ce qui fonde la fourchette. */
export function renderValuationPrint(input: ValuationPrintInput): string {
  const { facts, agent } = input;
  const paragraphs = input.text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p !== '')
    .map((p) => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`)
    .join('');
  const adjustments =
    facts.adjustments.length > 0
      ? `<h2>Caractéristiques prises en compte</h2><ul>${facts.adjustments.map((a) => `<li>${escapeHtml(a.label)} : ${a.pct > 0 ? '+' : a.pct < 0 ? '-' : ''}${decimal(Math.abs(a.pct))} %${a.source === 'agent' ? ` — retenu par votre agent, ${escapeHtml(a.motive && Object.hasOwn(AGENT_ADJUSTMENT_MOTIVES, a.motive) ? AGENT_ADJUSTMENT_MOTIVES[a.motive as keyof typeof AGENT_ADJUSTMENT_MOTIVES] : 'motif non dit')}` : ''}</li>`).join('')}</ul>`
      : '';
  const rows = facts.cited
    .map((c) => {
      const street = safeStreet(c.street);
      const place = [street, c.town].filter((x): x is string => Boolean(x)).join(', ');
      return `<tr><td>${escapeHtml(monthLabel(c.month))}</td><td>${escapeHtml(place)}</td><td class="nombre">${decimal(c.surface)} m²</td><td class="nombre">${escapeHtml(euros(c.pricePerM2))}/m²</td><td class="nombre">${c.distance} m</td></tr>`;
    })
    .join('');
  const sales =
    rows !== ''
      ? `<table><caption>Les ${facts.cited.length} plus proches des ${facts.comparables} ventes retenues, à moins de ${facts.radius} m. Prix médian de ces ${facts.comparables} ventes : ${escapeHtml(euros(facts.medianPerM2))} le m².</caption><thead><tr><th scope="col">Vente</th><th scope="col">Lieu</th><th scope="col" class="nombre">Surface</th><th scope="col" class="nombre">Prix</th><th scope="col" class="nombre">Distance</th></tr></thead><tbody>${rows}</tbody></table>`
      : '';
  // L'avis motivé : les ventes que l'agent a vérifiées, chacune avec sa preuve, sous un titre qui ne les fait jamais
  // passer pour des ventes publiées [R690, R29].
  const references = facts.method === 'manual' && facts.references && facts.references.length > 0
    ? `<h2>Ventes vérifiées par votre agent</h2><table><caption>Il n’y a pas de fourchette automatique pour ce bien. Les ${facts.references.length} ventes réelles retenues par votre agent${facts.referencesMedianPerM2 ? `, de prix médian ${escapeHtml(perM2Text(facts.referencesMedianPerM2))} le m²` : ''}.</caption><thead><tr><th scope="col">Vente</th><th scope="col">Lieu</th><th scope="col" class="nombre">Surface</th><th scope="col" class="nombre">Prix</th><th scope="col">Preuve</th></tr></thead><tbody>${facts.references
        .map((r) => {
          const placeName = [safeStreet(r.street), r.town].filter((x): x is string => Boolean(x)).join(', ');
          return `<tr><td>${escapeHtml(monthLabel(r.month))}</td><td>${escapeHtml(placeName)}</td><td class="nombre">${decimal(r.surface)} m²</td><td class="nombre">${escapeHtml(perM2Text(r.pricePerM2))}/m²</td><td>${escapeHtml(r.proofLabel)}</td></tr>`;
        })
        .join('')}</tbody></table>`
    : '';
  return (
    `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Avis de valeur</title><style>${CSS}</style></head><body><main>` +
    `<div class="marque"><span>AIMMO</span><span>${escapeHtml(`${agent.firstName} ${agent.lastName}`)}</span></div>` +
    `<h1>Avis de valeur</h1><p class="date">Validé le ${escapeHtml(dayLabel(input.validatedOn))}</p>` +
    `<p class="prix">${escapeHtml(euros(input.low))} <span>à</span> ${escapeHtml(euros(input.high))}</p>` +
    `<section class="texte">${paragraphs}</section>` +
    // L'agent juste après le texte : jamais seul sur une dernière page, quelle que soit la longueur du tableau.
    agentBlock(agent) +
    adjustments +
    (sales ? `<h2>Ventes réelles comparables</h2>${sales}` : '') +
    references +
    (input.market ? renderMarketSection(input.market) : '') +
    `</main></body></html>`
  );
}

export class AvisImprime {
  private readonly now: () => Date;
  private readonly avis: AvisDeValeur;

  constructor(
    private readonly db: SqlDatabase,
    private readonly acces: Acces,
    private readonly journal: JournalStore,
    options: { now?: () => Date } = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.avis = new AvisDeValeur(db, journal, { now: this.now });
  }

  /** La page d'un avis : qui voit le bien en entier, et seulement si l'avis peut partir [R16, R30]. */
  async print(viewer: Viewer, reportId: string): Promise<{ ok: true; html: string } | PrintRefusal> {
    const report: ValuationReport | null = await this.avis.get(reportId);
    if (!report || report.network_id !== viewer.networkId) {
      // Le refus est tracé, sans dire si l'avis existe ailleurs [R16].
      await appendEvent(this.journal, { type: 'acces.refuse', actor: `${String(viewer.role)}:${viewer.userId}`, subject: `valuation:${reportId}`, data: { rule: 'R16', role: String(viewer.role), kind: 'valuation_print', code: 'unknown' } }, this.now);
      return { ok: false, rule: null, code: 'unknown' };
    }
    const property = await this.acces.readProperty(viewer, report.property_id);
    if (!property.ok) return property.code === 'unknown' ? { ok: false, rule: null, code: 'unknown' } : { ok: false, rule: 'R16', code: property.code };
    if (property.view !== 'full') {
      await appendEvent(this.journal, { type: 'acces.refuse', actor: `${String(viewer.role)}:${viewer.userId}`, subject: `property:${report.property_id}`, data: { rule: 'R16', role: String(viewer.role), kind: 'valuation_print', code: 'not_assigned' } }, this.now);
      return { ok: false, rule: 'R16', code: 'not_assigned' };
    }
    const released = await this.avis.releasable(reportId);
    if (!released.ok) return { ok: false, rule: released.rule, code: released.code };
    const agent = await this.db.first<{ first_name: string; last_name: string }>('SELECT first_name, last_name FROM agents WHERE id = ?', [report.validated_by]);
    if (!agent) return { ok: false, rule: 'R30', code: 'not_following_agent' };
    const card = await this.db.first<{ phone: string; email: string }>('SELECT phone, email FROM agent_public_cards WHERE agent_id = ? ORDER BY set_at DESC, rowid DESC LIMIT 1', [report.validated_by]);
    // Le relevé du marché : seul un brouillon en reçoit, la base le garantit ; ce qui part est ce que l'agent a validé [R306].
    const market = await this.db.first<{ market: string }>('SELECT market FROM valuation_market_snapshots WHERE report_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1', [report.id]);
    const html = renderValuationPrint({
      low: released.value.low,
      high: released.value.high,
      validatedOn: localTime(new Date(report.validated_at!), 'Europe/Paris').date,
      text: report.text,
      facts: JSON.parse(report.computed) as PrintedFacts,
      agent: { firstName: agent.first_name, lastName: agent.last_name, phone: card?.phone ?? null, email: card?.email ?? null },
      market: market ? (JSON.parse(market.market) as MarketSection) : null,
    });
    await appendEvent(this.journal, { type: 'avis.imprime', actor: `${String(viewer.role)}:${viewer.userId}`, subject: `property:${report.property_id}`, data: { report: report.id } }, this.now);
    return { ok: true, html };
  }
}
