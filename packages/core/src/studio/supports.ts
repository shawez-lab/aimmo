/**
 * Supports imprimés à la marque de l'agent (M19, X06) [R201, R46, R43, R44].
 *
 * Fiche du bien, panneau, flyer, lettre de quartier et carte de visite, rendus par le code en pages à imprimer (A4,
 * A4 à l'italienne, A5, carte de 85 × 55 mm), sur la base papier du système de design, sans rien d'extérieur.
 *
 * Tout ce qui parle du bien vient de la dernière version publiée (P04), comme la page et la fiche de P05 : titre,
 * état, prix et mentions sont partout les mêmes [R44, R43]. Un support qui montre le prix montre aussi les mentions.
 * Aucune adresse : la version publiée n'en porte pas, et les textes ajoutés ici sont écrits par le code [R46]. Une
 * annonce retirée ne s'imprime plus. Un agent parti n'a plus ni carte ni support.
 */
import type { Acces } from '../acces/acces.ts';
import type { Viewer } from '../acces/droits.ts';
import type { PageBien, PageInput } from '../annonces/page-bien.ts';
import { renderListingPrint } from '../annonces/page-bien.ts';
import { euros } from '../annonces/mentions.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { PRINT_DESIGN_CSS } from '../design/systeme.ts';
import { escapeHtml } from '../documents/modeles.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';

export const PRINT_SUPPORTS = ['fiche', 'panneau', 'flyer', 'lettre_quartier'] as const;
export type PrintSupport = (typeof PRINT_SUPPORTS)[number];

/** Le format de chaque support : la taille de la feuille, en millimètres. */
export const SUPPORT_SIZES: Readonly<Record<PrintSupport | 'carte_visite', { widthMm: number; heightMm: number; pages: number }>> = Object.freeze({
  fiche: { widthMm: 210, heightMm: 297, pages: 2 },
  panneau: { widthMm: 297, heightMm: 210, pages: 1 },
  flyer: { widthMm: 148, heightMm: 210, pages: 1 },
  lettre_quartier: { widthMm: 210, heightMm: 297, pages: 1 },
  carte_visite: { widthMm: 85, heightMm: 55, pages: 1 },
});

const STATE_STAMP: Record<string, string> = { en_vente: 'À vendre', sous_offre: 'Sous offre', vendu: 'Vendu' };

const mediaUrl = (ref: string): string => `/medias/${ref.split('/').map(encodeURIComponent).join('/')}`;

/** La base papier, puis la feuille du support : seulement des jetons [R201]. */
function css(size: { widthMm: number; heightMm: number }, local: string): string {
  return (
    PRINT_DESIGN_CSS +
    `@page{size:${size.widthMm}mm ${size.heightMm}mm;margin:0}` +
    `.page{width:${size.widthMm}mm;height:${size.heightMm}mm;overflow:hidden;position:relative;break-after:page;page-break-after:always}` +
    '.page:last-child{break-after:auto;page-break-after:auto}' +
    '.marque{font:600 8pt/1 var(--police-texte);letter-spacing:.14em;text-transform:uppercase;color:var(--accent)}' +
    '.frise{height:1.5mm;background:var(--accent);box-shadow:0 1.5mm 0 var(--moutarde);margin-bottom:1.5mm}' +
    '.mentions{border-left:2pt solid var(--moutarde);padding:1.5mm 3mm;font:8pt/1.35 var(--police-texte);white-space:pre-line;margin:0}' +
    '.virtuel{position:absolute;left:1.5mm;bottom:1.5mm;background:var(--encre);color:var(--papier);font:700 6.5pt var(--police-texte);padding:.8mm 1.6mm}' +
    local
  );
}

function doc(title: string, style: string, body: string): string {
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>${style}</style></head><body>${body}</body></html>`;
}

function photos(input: PageInput, limit: number): string {
  const items = input.photos
    .filter((p) => p.kind === 'photo')
    .slice(0, limit)
    .map((p) => {
      const virtual = p.overlay ? `<span class="virtuel">${escapeHtml(p.overlay)}</span>` : '';
      return `<li><img src="${escapeHtml(mediaUrl(p.ref))}" alt="${p.overlay ? 'Photo du bien, aménagement virtuel' : 'Photo du bien'}">${virtual}</li>`;
    });
  return items.length > 0 ? `<ul class="photos">${items.join('')}</ul>` : '';
}

function agentLines(input: PageInput): string {
  const a = input.agent;
  if (!a) return '';
  const lines = [`<strong>${escapeHtml(`${a.firstName} ${a.lastName}`)}</strong>, agent immobilier`];
  if (a.phone) lines.push(escapeHtml(a.phone));
  if (a.email) lines.push(escapeHtml(a.email));
  return `<p class="agent">${lines.join('<br>')}</p>`;
}

/** Ce qu'un support exige de la version publiée : une annonce en cours, avec prix, titre et mentions. */
function printable(input: PageInput): boolean {
  const p = input.payload;
  return p.state !== 'retiree' && p.priceEur !== null && !!p.title && !!p.mentions && !!p.body;
}

/** Le panneau, A4 à l'italienne : l'état en très grand, le titre, les mentions obligatoires de la version publiée, l'agent. */
export function renderPanel(input: PageInput): string | null {
  if (!printable(input) || !input.agent) return null;
  const p = input.payload;
  const style = css(
    SUPPORT_SIZES.panneau,
    '.page{padding:14mm 16mm;display:flex;flex-direction:column;justify-content:space-between}' +
      '.etat{font:700 80pt/1.2 var(--police-titre);color:var(--accent);margin:2mm 0 0;letter-spacing:-.03em}' +
      'h1{font:600 22pt/1.2 var(--police-titre);margin:5mm 0 0;max-width:60ch}' +
      '.mentions{margin:4mm 0 0;max-width:150mm}' +
      '.agent{font:600 18pt/1.3 var(--police-texte);margin:0;border-top:2pt solid var(--accent);padding-top:4mm}',
  );
  return doc(
    `Panneau · ${p.title}`,
    style,
    `<section class="page"><div><p class="marque">AIMMO · Réf. ${escapeHtml(p.reference)}</p><p class="etat">${STATE_STAMP[p.state] ?? 'À vendre'}</p><h1>${escapeHtml(p.title!)}</h1><p class="mentions">${escapeHtml(p.mentions!)}</p></div>${agentLines(input)}</section>`,
  );
}

/** Le flyer, A5 : titre, prix et mentions, deux photos, l'agent. */
export function renderFlyer(input: PageInput): string | null {
  if (!printable(input)) return null;
  const p = input.payload;
  const style = css(
    SUPPORT_SIZES.flyer,
    '.page{padding:9mm 9mm 8mm}' +
      'h1{font:600 14pt/1.2 var(--police-titre);margin:4mm 0 2mm}' +
      '.prix{font:700 22pt/1 var(--police-titre);color:var(--accent);margin:2mm 0 3mm}' +
      '.photos{display:grid;grid-template-columns:1fr 1fr;gap:2mm;margin:0 0 3mm;padding:0;list-style:none}.photos li{position:relative}' +
      '.photos img{width:100%;height:36mm;object-fit:cover;display:block}' +
      '.agent{position:absolute;left:9mm;right:9mm;bottom:8mm;margin:0;border-top:1pt solid var(--accent);padding-top:2mm;font:9pt/1.35 var(--police-texte)}',
  );
  return doc(
    `Flyer · ${p.title}`,
    style,
    `<section class="page"><p class="marque">AIMMO · Réf. ${escapeHtml(p.reference)}</p><div class="frise" aria-hidden="true"></div><h1>${escapeHtml(p.title!)}</h1><p class="prix">${escapeHtml(euros(p.priceEur!))}</p>${photos(input, 2)}<p class="mentions">${escapeHtml(p.mentions!)}</p>${agentLines(input)}</section>`,
  );
}

/** La lettre de quartier, A4 : un texte écrit ici, sans adresse ; le bien, son prix et ses mentions ; l'agent. */
export function renderNeighbourhoodLetter(input: PageInput): string | null {
  if (!printable(input) || !input.agent) return null;
  const p = input.payload;
  const style = css(
    SUPPORT_SIZES.lettre_quartier,
    '.page{padding:18mm 20mm}' +
      'h1{font:600 18pt/1.25 var(--police-titre);margin:10mm 0 4mm}' +
      '.lettre{font:11pt/1.55 var(--police-titre);margin:0 0 4mm;max-width:40em}' +
      '.bien{border:1pt solid var(--trait);padding:4mm 5mm;margin:6mm 0}' +
      '.bien h2{font:600 13pt/1.25 var(--police-titre);margin:0 0 2mm}' +
      '.prix{font:700 18pt/1 var(--police-titre);color:var(--accent);margin:2mm 0 3mm}' +
      '.agent{position:absolute;left:20mm;right:20mm;bottom:18mm;margin:0;border-top:1pt solid var(--accent);padding-top:3mm;font:10pt/1.4 var(--police-texte)}',
  );
  const letter = [
    'Madame, Monsieur,',
    'Un bien vient d’être mis en vente dans votre quartier. Si vous connaissez quelqu’un qui cherche à s’y installer, ou si vous pensez vous-même à vendre, je serai heureux d’en parler avec vous.',
  ];
  return doc(
    `Lettre de quartier · ${p.title}`,
    style,
    `<section class="page"><p class="marque">AIMMO</p><div class="frise" aria-hidden="true"></div><h1>Du nouveau dans votre quartier</h1>${letter.map((l) => `<p class="lettre">${escapeHtml(l)}</p>`).join('')}` +
      `<div class="bien"><h2>${escapeHtml(p.title!)}</h2><p class="prix">${escapeHtml(euros(p.priceEur!))}</p><p class="mentions">${escapeHtml(p.mentions!)}</p></div>${agentLines(input)}</section>`,
  );
}

export interface BusinessCard {
  firstName: string;
  lastName: string;
  phone: string | null;
  email: string | null;
}

/** La carte de visite, 85 × 55 mm : le nom, « agent immobilier », les coordonnées professionnelles, la marque. */
export function renderBusinessCard(card: BusinessCard): string {
  const style = css(
    SUPPORT_SIZES.carte_visite,
    '.page{padding:5mm 6mm;display:flex;flex-direction:column;justify-content:space-between}' +
      'h1{font:600 13pt/1.15 var(--police-titre);margin:0}' +
      '.metier{font:9pt/1.2 var(--police-texte);color:var(--doux);margin:1mm 0 0}' +
      '.coord{font:8.5pt/1.4 var(--police-texte);margin:0}',
  );
  const coord = [card.phone, card.email].filter((v): v is string => !!v).map(escapeHtml).join('<br>');
  return doc(
    `Carte de visite · ${card.firstName} ${card.lastName}`,
    style,
    `<section class="page"><div><h1>${escapeHtml(`${card.firstName} ${card.lastName}`)}</h1><p class="metier">Agent immobilier</p></div><div><p class="coord">${coord}</p><div class="frise" aria-hidden="true"></div><p class="marque">AIMMO</p></div></section>`,
  );
}

export type SupportResult = { ok: true; html: string } | { ok: false; rule: 'R16' | 'R10'; code: string };

export class Supports {
  private readonly now: () => Date;

  constructor(
    private readonly db: SqlDatabase,
    private readonly acces: Acces,
    private readonly journal: JournalStore,
    private readonly pages: PageBien,
    options: { now?: () => Date } = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  /** Un support du bien, pour l'agent du bien ou la direction, depuis la dernière version publiée. */
  async render(viewer: Viewer, propertyId: string, kind: unknown): Promise<SupportResult> {
    if (viewer.role !== 'agent' && viewer.role !== 'direction') return this.refused(viewer, `property:${propertyId}`, 'role');
    const read = await this.acces.readProperty(viewer, propertyId);
    if (!read.ok) return { ok: false, rule: 'R16', code: read.code };
    if (read.view !== 'full') return this.refused(viewer, `property:${propertyId}`, 'not_assigned');
    if (!(PRINT_SUPPORTS as readonly unknown[]).includes(kind)) return { ok: false, rule: 'R10', code: 'support_inconnu' };
    const input = await this.pages.inputFor(read.value.network_id, propertyId);
    if (!input) return { ok: false, rule: 'R10', code: 'pas_publie' };
    const html =
      kind === 'fiche' ? renderListingPrint(input) : kind === 'panneau' ? renderPanel(input) : kind === 'flyer' ? renderFlyer(input) : renderNeighbourhoodLetter(input);
    if (!html) return { ok: false, rule: 'R10', code: input.payload.state === 'retiree' ? 'annonce_retiree' : input.agent ? 'pas_publie' : 'agent_parti' };
    await appendEvent(this.journal, { type: 'studio.support.imprime', actor: `${viewer.role}:${viewer.userId}`, subject: `property:${propertyId}`, data: { kind: kind as string } }, this.now);
    return { ok: true, html };
  }

  /** La carte de visite d'un agent actif : l'agent lui-même, ou la direction. */
  async businessCard(viewer: Viewer, agentId: string): Promise<SupportResult> {
    if (!((viewer.role === 'agent' && viewer.userId === agentId) || viewer.role === 'direction')) return this.refused(viewer, `agent:${agentId}`, 'role');
    const a = await this.db.first<{ network_id: string; status: string; first_name: string; last_name: string }>('SELECT network_id, status, first_name, last_name FROM agents WHERE id = ?', [agentId]);
    if (!a || a.network_id !== viewer.networkId) return { ok: false, rule: 'R10', code: 'agent_inconnu' };
    if (a.status !== 'active') return this.refused(viewer, `agent:${agentId}`, 'agent_inactive');
    const card = await this.db.first<{ phone: string; email: string }>('SELECT phone, email FROM agent_public_cards WHERE agent_id = ? ORDER BY set_at DESC, rowid DESC LIMIT 1', [agentId]);
    return { ok: true, html: renderBusinessCard({ firstName: a.first_name, lastName: a.last_name, phone: card?.phone ?? null, email: card?.email ?? null }) };
  }

  private async refused(viewer: Viewer, subject: string, code: string): Promise<SupportResult> {
    await appendEvent(
      this.journal,
      { type: 'acces.refuse', actor: `${String(viewer.role)}:${viewer.userId}`, subject, data: { rule: 'R16', role: String(viewer.role), kind: 'print_support', code } },
      this.now,
    );
    return { ok: false, rule: 'R16', code };
  }
}
