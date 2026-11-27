/**
 * Page du bien et fiche imprimable à la marque de l'agent (M07, P05) [R43, R46].
 *
 * Les deux sont rendues depuis la dernière version publiée (P04), jamais depuis un brouillon : prix, état, texte et
 * mentions sont donc partout les mêmes, et se mettent à jour d'eux-mêmes à chaque nouvelle version. Une annonce
 * retirée ne montre plus rien du bien. Aucune adresse, aucun nom du vendeur : la version publiée n'en porte pas [R46].
 * Tout texte est échappé.
 *
 * Le dessin suit le système de design d'AIMMO (Z03), avec une mise en page de catalogue :
 * prix en grands chiffres, état comme un tampon, mentions lisibles et non cachées. Téléphone d'abord ; la fiche
 * imprimable a exactement deux pages A4, la première porte toujours le prix et les mentions.
 */
import type { Acces } from '../acces/acces.ts';
import type { Viewer } from '../acces/droits.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { DESIGN_CSS, ETIQUETTES_CSS, PRINT_DESIGN_CSS, THEME_COLOR } from '../design/systeme.ts';
import { escapeHtml } from '../documents/modeles.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import { DEFAULT_PROFESSIONAL_TITLE, professionalTitle, type ProfessionalTitle } from '../attirer/qualite.ts';
import { TextesPortails } from '../diffusion/textes.ts';
import type { PublishedMedia } from './medias.ts';
import { energyLabels } from './etiquettes.ts';
import { euros } from './mentions.ts';
import type { ListingPayload, ListingState } from './publication.ts';

export interface AgentCard {
  firstName: string;
  lastName: string;
  phone: string | null;
  email: string | null;
  /** Le titre réglé par la direction (AU012) ; sans lui, « agent immobilier » [R07]. */
  title?: ProfessionalTitle;
}

export interface PageInput {
  payload: ListingPayload;
  agent: AgentCard | null;
  /** Les photos de la version publiée, dans l'ordre, avec leur mention [R48] et leur légende [R478] quand elle est faite. */
  photos: (PublishedMedia & { caption?: string | null })[];
}

const STATE_LABEL: Record<ListingState, string> = { en_vente: 'En vente', sous_offre: 'Sous offre', vendu: 'Vendu', retiree: 'Retiré de la vente' };
const MAX_PRINT_PHOTOS = 4;

const PHONE = /^\+?[0-9 .]{6,20}$/;
const EMAIL = /^[^\s@<>"']{1,64}@[A-Za-z0-9.-]{1,60}\.[A-Za-z]{2,}$/;

const mediaUrl = (ref: string): string => `/medias/${ref.split('/').map(encodeURIComponent).join('/')}`;

/** La page du bien : la base du système de design d'AIMMO (Z03), puis la mise en page de catalogue, en jetons [R201]. */
const CSS =
  DESIGN_CSS +
  ETIQUETTES_CSS +
  `.tete{display:flex;justify-content:space-between;align-items:center;gap:var(--e-4);padding:var(--e-4)}
.ref{font-size:var(--t-xs);letter-spacing:.12em;text-transform:uppercase;color:var(--doux)}
main{max-width:56rem;margin:0 auto;padding:0 var(--e-4) var(--e-8)}
h1{margin:var(--e-6) 0 var(--e-3);max-width:24ch}
.etat{display:inline-block;padding:var(--e-1) var(--e-3);border:2px solid var(--accent);color:var(--accent);font-weight:700;font-size:var(--t-xs);letter-spacing:.12em;text-transform:uppercase;border-radius:var(--r-s);transform:rotate(-2deg)}
.prix{font:600 clamp(2.4rem,11vw,3.6rem)/1 var(--police-titre);margin:var(--e-4) 0 var(--e-2);color:var(--accent);letter-spacing:-.02em}
.photos{display:grid;grid-template-columns:repeat(auto-fill,minmax(14rem,1fr));gap:var(--e-2);margin:var(--e-5) calc(-1 * var(--e-4));padding:0;list-style:none}
.photos li{position:relative;margin:0}.photos img{width:100%;aspect-ratio:4/3;object-fit:cover;background:var(--trait)}
.virtuel{position:absolute;left:var(--e-2);bottom:var(--e-2);background:var(--encre);color:var(--papier);font-size:var(--t-xs);font-weight:700;padding:2px var(--e-2);border-radius:var(--r-s);letter-spacing:.04em}
.legende{display:block;font-size:var(--t-xs);color:var(--doux);padding-top:var(--e-1)}
.texte{white-space:pre-line;font-size:var(--t-l);line-height:1.6;max-width:38rem}
.mentions{background:var(--surface);border-radius:var(--r-m);box-shadow:inset 4px 0 0 var(--moutarde);padding:var(--e-4) var(--e-5);margin:var(--e-6) 0;font-size:var(--t-s);white-space:pre-line;max-width:38rem}
.agent{border-top:1px solid var(--trait);padding-top:var(--e-5);margin-top:var(--e-6)}.agent a{font-weight:600}
.retire{margin:var(--e-7) 0;font-size:var(--t-l);color:var(--doux)}
@media (min-width:48rem){.photos{margin-left:0;margin-right:0}.photos img{border-radius:var(--r-m)}}`;

/** La fiche imprimable : les jetons du papier, deux pages A4 exactement. */
const PRINT_CSS =
  PRINT_DESIGN_CSS +
  ETIQUETTES_CSS +
  `@page{size:A4;margin:0}
body{font:10.5pt/1.45 var(--police-titre)}
.page{width:210mm;height:297mm;padding:16mm 16mm 14mm;overflow:hidden;break-after:page;page-break-after:always;position:relative}
.page:last-child{break-after:auto;page-break-after:auto}
.marque{font:600 8pt/1 var(--police-texte);letter-spacing:.12em;text-transform:uppercase;color:var(--accent);border-bottom:1pt solid var(--accent);padding-bottom:4mm}
h1{font-size:20pt;line-height:1.15;margin:8mm 0 3mm}.prix{font-size:30pt;font-weight:700;color:var(--accent);margin:4mm 0}
.etat{display:inline-block;border:1.5pt solid var(--accent);color:var(--accent);padding:1mm 3mm;font:700 8pt var(--police-texte);letter-spacing:.1em;text-transform:uppercase}
.mentions{border-left:2pt solid var(--moutarde);padding:2mm 4mm;margin:6mm 0;font-size:9pt;white-space:pre-line}
.photos{display:grid;grid-template-columns:1fr 1fr;gap:3mm;margin:0;padding:0;list-style:none}.photos li{position:relative}
.photos img{width:100%;height:44mm;object-fit:cover}.etiquettes{grid-template-columns:1fr 1fr;gap:6mm;margin:0 0 5mm;font-size:8pt}.virtuel{position:absolute;left:2mm;bottom:2mm;background:var(--encre);color:var(--papier);font:700 7pt var(--police-texte);padding:1mm 2mm}.legende{display:block;font:7pt var(--police-texte);padding-top:1mm}
.page+.page{padding-bottom:42mm}.texte{margin:6mm 0}.agent{position:absolute;left:16mm;right:16mm;bottom:14mm;border-top:1pt solid var(--accent);padding-top:3mm;font-size:9.5pt}`;

function photoList(photos: PageInput['photos'], limit: number): string {
  const items = photos
    .filter((p) => p.kind === 'photo')
    .slice(0, limit)
    .map((p) => {
      // Une photo d'aménagement virtuel porte la mention sur l'image elle-même [R48].
      const virtual = p.overlay ? `<span class="virtuel">${escapeHtml(p.overlay)}</span>` : '';
      // La légende des portails [R478], quand la version publiée en a une : texte de remplacement et légende visible (AU114).
      const alt = p.caption ?? (p.overlay ? 'Photo du bien, aménagement virtuel' : 'Photo du bien');
      const caption = p.caption ? `<span class="legende">${escapeHtml(p.caption)}</span>` : '';
      return `<li><img src="${escapeHtml(mediaUrl(p.ref))}" alt="${escapeHtml(alt)}" loading="lazy" decoding="async">${virtual}${caption}</li>`;
    });
  return items.length > 0 ? `<ul class="photos">${items.join('')}</ul>` : '';
}

export function agentBlock(agent: AgentCard | null): string {
  if (!agent) return '';
  const name = escapeHtml(`${agent.firstName} ${agent.lastName}`);
  const parts = [`<p><strong>${name}</strong>, ${escapeHtml(agent.title ?? DEFAULT_PROFESSIONAL_TITLE)}</p>`];
  if (agent.phone && PHONE.test(agent.phone)) parts.push(`<p><a class="lien" href="tel:${escapeHtml(agent.phone.replace(/[ .]/g, ''))}">${escapeHtml(agent.phone)}</a></p>`);
  if (agent.email && EMAIL.test(agent.email)) parts.push(`<p><a class="lien" href="mailto:${escapeHtml(agent.email)}">${escapeHtml(agent.email)}</a></p>`);
  return `<section class="agent" aria-label="Votre agent">${parts.join('')}</section>`;
}

/** La page publique du bien, depuis la version publiée. Une annonce retirée ne montre plus rien du bien. */
export function renderListingPage(input: PageInput): string {
  const p = input.payload;
  const title = p.state === 'retiree' || !p.title ? 'Bien retiré de la vente' : p.title;
  const head = `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="referrer" content="no-referrer"><meta name="robots" content="${p.state === 'retiree' ? 'noindex' : 'index'}"><meta name="theme-color" content="${THEME_COLOR}"><title>${escapeHtml(title)}</title><style>${CSS}</style></head>`;
  const brand = `<header class="tete"><p class="marque">AIMMO</p><p class="ref">Réf. ${escapeHtml(p.reference)}</p></header><div class="frise" aria-hidden="true"></div>`;
  if (p.state === 'retiree' || p.priceEur === null || !p.body || !p.mentions) {
    return `${head}<body>${brand}<main><h1>${escapeHtml(title)}</h1><p class="retire">Ce bien n'est plus proposé à la vente.</p>${agentBlock(input.agent)}</main></body></html>`;
  }
  return (
    `${head}<body>${brand}<main>` +
    `<h1>${escapeHtml(p.title ?? '')}</h1>` +
    `<p><span class="etat">${STATE_LABEL[p.state]}</span></p>` +
    `<p class="prix">${escapeHtml(euros(p.priceEur))}</p>` +
    photoList(input.photos, 40) +
    `<p class="texte">${escapeHtml(p.body)}</p>` +
    `<section class="mentions" aria-label="Informations obligatoires">${escapeHtml(p.mentions)}</section>` +
    // Les deux étiquettes du DPE en couleur, de la même version que les mentions (AU006) [R43].
    energyLabels(p.mentions) +
    agentBlock(input.agent) +
    `</main></body></html>`
  );
}

/** La fiche imprimable : exactement deux pages A4. Page 1 : titre, état, prix, mentions, étiquettes du DPE, photos ; page 2 : texte et agent. */
export function renderListingPrint(input: PageInput): string | null {
  const p = input.payload;
  if (p.state === 'retiree' || p.priceEur === null || !p.body || !p.mentions || !p.title) return null;
  const brand = `<div class="marque">AIMMO · Réf. ${escapeHtml(p.reference)}</div>`;
  return (
    `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>${escapeHtml(p.title)}</title><style>${PRINT_CSS}</style></head><body><main>` +
    `<section class="page">${brand}<h1>${escapeHtml(p.title)}</h1><span class="etat">${STATE_LABEL[p.state]}</span>` +
    `<p class="prix">${escapeHtml(euros(p.priceEur))}</p><div class="mentions">${escapeHtml(p.mentions)}</div>${energyLabels(p.mentions)}${photoList(input.photos, MAX_PRINT_PHOTOS)}</section>` +
    // Sur papier, les retours à la ligne deviennent des espaces : 3 000 caractères tiennent toujours dans la page 2,
    // au-dessus de la carte de l'agent, sans rien couper.
    `<section class="page">${brand}<p class="texte">${escapeHtml(p.body.replace(/\s*\n\s*/g, ' '))}</p>${agentBlock(input.agent)}</section>` +
    `</main></body></html>`
  );
}

type Refusal = { ok: false; rule: 'R16'; code: string };

export class PageBien {
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(
    private readonly db: SqlDatabase,
    private readonly acces: Acces,
    private readonly journal: JournalStore,
    options: { now?: () => Date; newId?: () => string } = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => crypto.randomUUID());
  }

  /** Les coordonnées professionnelles de l'agent sur ses annonces : l'agent lui-même ou la direction. */
  async setAgentCard(viewer: Viewer, agentId: string, card: { phone: unknown; email: unknown }): Promise<{ ok: true } | Refusal | { ok: false; rule: null; code: 'bad_phone' | 'bad_email' | 'unknown_agent' }> {
    const allowed = (viewer.role === 'agent' && viewer.userId === agentId) || viewer.role === 'direction';
    if (!allowed) {
      await appendEvent(this.journal, { type: 'acces.refuse', actor: `${String(viewer.role)}:${viewer.userId}`, subject: `agent:${agentId}`, data: { rule: 'R16', role: String(viewer.role), kind: 'agent_card', code: 'role' } }, this.now);
      return { ok: false, rule: 'R16', code: 'role' };
    }
    if (typeof card.phone !== 'string' || !PHONE.test(card.phone.trim())) return { ok: false, rule: null, code: 'bad_phone' };
    if (typeof card.email !== 'string' || !EMAIL.test(card.email.trim())) return { ok: false, rule: null, code: 'bad_email' };
    const agent = await this.db.first<{ network_id: string; status: string }>('SELECT network_id, status FROM agents WHERE id = ?', [agentId]);
    if (!agent || agent.network_id !== viewer.networkId) return { ok: false, rule: null, code: 'unknown_agent' };
    // Un agent parti ne règle plus rien, et ses coordonnées ne changent plus [R16].
    if (agent.status !== 'active') {
      await appendEvent(this.journal, { type: 'acces.refuse', actor: `${String(viewer.role)}:${viewer.userId}`, subject: `agent:${agentId}`, data: { rule: 'R16', role: String(viewer.role), kind: 'agent_card', code: 'agent_inactive' } }, this.now);
      return { ok: false, rule: 'R16', code: 'agent_inactive' };
    }
    await this.db.run('INSERT INTO agent_public_cards (id, agent_id, network_id, phone, email, set_by, set_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [
      this.newId(), agentId, viewer.networkId, card.phone.trim(), card.email.trim(), `${String(viewer.role)}:${viewer.userId}`, this.now().toISOString(),
    ]);
    await appendEvent(this.journal, { type: 'agent.carte_reglee', actor: `${String(viewer.role)}:${viewer.userId}`, subject: `agent:${agentId}`, data: {} }, this.now);
    return { ok: true };
  }

  /** Ce que la page et la fiche montrent : la dernière version publiée, l'agent du bien, les photos de la fiche publiée. */
  async inputFor(networkId: string, propertyId: string): Promise<PageInput | null> {
    const v = await this.db.first<{ network_id: string; seq: number; payload: string }>(
      'SELECT network_id, seq, payload FROM listing_versions WHERE property_id = ? ORDER BY seq DESC LIMIT 1',
      [propertyId],
    );
    if (!v || v.network_id !== networkId) return null;
    const payload = { ...(JSON.parse(v.payload) as Omit<ListingPayload, 'version'>), version: Number(v.seq) };
    const captions = await new TextesPortails(this.db, this.acces, this.journal, { now: this.now }).publishedCaptions(networkId, propertyId);
    const photos = (payload.media ?? []).filter((m) => m.kind === 'photo').map((m) => (captions.has(m.ref) ? { ...m, caption: captions.get(m.ref)! } : m));
    const a = await this.db.first<{ id: string; first_name: string; last_name: string; status: string }>('SELECT a.id, a.first_name, a.last_name, a.status FROM properties p JOIN agents a ON a.id = p.agent_id WHERE p.id = ?', [propertyId]);
    const card = await this.db.first<{ phone: string; email: string }>(
      'SELECT c.phone, c.email FROM agent_public_cards c JOIN properties p ON p.agent_id = c.agent_id WHERE p.id = ? ORDER BY c.set_at DESC, c.rowid DESC LIMIT 1',
      [propertyId],
    );
    // Un agent parti n'est plus montré : la page reste, sans ses coordonnées.
    const agent =
      a && a.status === 'active'
        ? { firstName: a.first_name, lastName: a.last_name, phone: card?.phone ?? null, email: card?.email ?? null, title: await professionalTitle(this.db, networkId, a.id) }
        : null;
    return { payload, agent, photos };
  }

  async page(networkId: string, propertyId: string): Promise<string | null> {
    const input = await this.inputFor(networkId, propertyId);
    return input ? renderListingPage(input) : null;
  }

  async print(networkId: string, propertyId: string): Promise<string | null> {
    const input = await this.inputFor(networkId, propertyId);
    return input ? renderListingPrint(input) : null;
  }
}
