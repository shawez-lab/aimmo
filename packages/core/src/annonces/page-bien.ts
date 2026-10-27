/**
 * Page du bien et fiche imprimable à la marque de l'agent (M07, P05) [R43, R46].
 *
 * Les deux sont rendues depuis la dernière version publiée (P04), jamais depuis un brouillon : prix, état, texte et
 * mentions sont donc partout les mêmes, et se mettent à jour d'eux-mêmes à chaque nouvelle version. Une annonce
 * retirée ne montre plus rien du bien. Aucune adresse, aucun nom du vendeur : la version publiée n'en porte pas [R46].
 * Tout texte est échappé.
 *
 * Le dessin suit le système de l'application AIMMO (encre marine, papier blanc), avec une mise en page de catalogue :
 * prix en grands chiffres, état comme un tampon, mentions lisibles et non cachées. Téléphone d'abord ; la fiche
 * imprimable a exactement deux pages A4, la première porte toujours le prix et les mentions.
 */
import type { Acces } from '../acces/acces.ts';
import type { Viewer } from '../acces/droits.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { escapeHtml } from '../documents/modeles.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import type { Media, PropertySheet } from './fiche-bien.ts';
import { euros } from './mentions.ts';
import type { ListingPayload, ListingState } from './publication.ts';

export interface AgentCard {
  firstName: string;
  lastName: string;
  phone: string | null;
  email: string | null;
}

export interface PageInput {
  payload: ListingPayload;
  agent: AgentCard | null;
  /** Les photos de la fiche publiée, dans l'ordre. */
  photos: Media[];
}

const STATE_LABEL: Record<ListingState, string> = { en_vente: 'En vente', sous_offre: 'Sous offre', vendu: 'Vendu', retiree: 'Retiré de la vente' };
const MAX_PRINT_PHOTOS = 4;

const PHONE = /^\+?[0-9 .]{6,20}$/;
const EMAIL = /^[^\s@<>"']{1,64}@[A-Za-z0-9.-]{1,60}\.[A-Za-z]{2,}$/;

const mediaUrl = (ref: string): string => `/medias/${ref.split('/').map(encodeURIComponent).join('/')}`;

const CSS = `:root{color-scheme:light dark;--fond:#fff;--papier:#f6f4ef;--texte:#14202e;--accent:#1f3a5f;--doux:#5b6b7d;--trait:#d9dee5}
@media (prefers-color-scheme:dark){:root{--fond:#10161d;--papier:#17202a;--texte:#e8eef4;--accent:#8fb3dd;--doux:#9aa8b6;--trait:#2a3644}}
*{box-sizing:border-box}body{margin:0;background:var(--fond);color:var(--texte);font:16px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:46rem;margin:0 auto;padding:0 16px 48px}
.marque{display:flex;justify-content:space-between;align-items:baseline;padding:14px 16px;border-bottom:1px solid var(--trait);font-size:.85rem;letter-spacing:.08em;text-transform:uppercase;color:var(--accent)}
h1{font:600 clamp(1.5rem,5vw,2.2rem)/1.15 Georgia,"Iowan Old Style",serif;margin:28px 0 8px}
.etat{display:inline-block;border:2px solid var(--accent);color:var(--accent);padding:2px 10px;font-weight:700;font-size:.8rem;letter-spacing:.1em;text-transform:uppercase;transform:rotate(-2deg)}
.prix{font:700 clamp(2rem,9vw,3.2rem)/1 Georgia,serif;font-variant-numeric:tabular-nums;margin:18px 0 4px;color:var(--accent)}
.photos{display:grid;grid-template-columns:repeat(auto-fill,minmax(14rem,1fr));gap:8px;margin:24px 0;padding:0;list-style:none}
.photos li{position:relative;margin:0}.photos img{display:block;width:100%;aspect-ratio:4/3;object-fit:cover;background:var(--papier)}
.virtuel{position:absolute;left:8px;bottom:8px;background:rgba(20,32,46,.85);color:#fff;font-size:.75rem;font-weight:700;padding:2px 8px;letter-spacing:.04em}
.texte{white-space:pre-line;font-size:1.05rem}
.mentions{background:var(--papier);border-left:4px solid var(--accent);padding:14px 16px;margin:28px 0;font-size:.92rem;white-space:pre-line}
.agent{border-top:1px solid var(--trait);padding-top:18px;margin-top:28px}.agent a{color:var(--accent);font-weight:600}
.retire{margin:56px 0;font-size:1.2rem;color:var(--doux)}
a:focus-visible{outline:3px solid var(--accent);outline-offset:2px}`;

const PRINT_CSS = `@page{size:A4;margin:0}*{box-sizing:border-box}
body{margin:0;color:#14202e;font:10.5pt/1.45 Georgia,"Iowan Old Style",serif}
.page{width:210mm;height:297mm;padding:16mm 16mm 14mm;overflow:hidden;break-after:page;page-break-after:always;position:relative}
.page:last-child{break-after:auto;page-break-after:auto}
.marque{font:600 8pt/1 system-ui,sans-serif;letter-spacing:.12em;text-transform:uppercase;color:#1f3a5f;border-bottom:1pt solid #1f3a5f;padding-bottom:4mm}
h1{font-size:20pt;line-height:1.15;margin:8mm 0 3mm}.prix{font-size:30pt;font-weight:700;color:#1f3a5f;margin:4mm 0}
.etat{display:inline-block;border:1.5pt solid #1f3a5f;color:#1f3a5f;padding:1mm 3mm;font:700 8pt system-ui,sans-serif;letter-spacing:.1em;text-transform:uppercase}
.mentions{border-left:2pt solid #1f3a5f;padding:2mm 4mm;margin:6mm 0;font-size:9pt;white-space:pre-line}
.photos{display:grid;grid-template-columns:1fr 1fr;gap:3mm;margin:0;padding:0;list-style:none}.photos li{position:relative}
.photos img{width:100%;height:52mm;object-fit:cover}.virtuel{position:absolute;left:2mm;bottom:2mm;background:#14202e;color:#fff;font:700 7pt system-ui,sans-serif;padding:1mm 2mm}
.page+.page{padding-bottom:42mm}.texte{margin:6mm 0}.agent{position:absolute;left:16mm;right:16mm;bottom:14mm;border-top:1pt solid #1f3a5f;padding-top:3mm;font-size:9.5pt}`;

function photoList(photos: Media[], limit: number): string {
  const items = photos
    .filter((p) => p.kind === 'photo')
    .slice(0, limit)
    .map((p) => {
      // Une photo d'aménagement virtuel porte la mention sur l'image elle-même [R48].
      const virtual = p.edit === 'amenagement_virtuel' ? '<span class="virtuel">Aménagement virtuel</span>' : '';
      const alt = p.edit === 'amenagement_virtuel' ? 'Photo du bien, aménagement virtuel' : 'Photo du bien';
      return `<li><img src="${escapeHtml(mediaUrl(p.ref))}" alt="${alt}" loading="lazy" decoding="async">${virtual}</li>`;
    });
  return items.length > 0 ? `<ul class="photos">${items.join('')}</ul>` : '';
}

function agentBlock(agent: AgentCard | null): string {
  if (!agent) return '';
  const name = escapeHtml(`${agent.firstName} ${agent.lastName}`);
  const parts = [`<p><strong>${name}</strong>, agent immobilier</p>`];
  if (agent.phone && PHONE.test(agent.phone)) parts.push(`<p><a href="tel:${escapeHtml(agent.phone.replace(/[ .]/g, ''))}">${escapeHtml(agent.phone)}</a></p>`);
  if (agent.email && EMAIL.test(agent.email)) parts.push(`<p><a href="mailto:${escapeHtml(agent.email)}">${escapeHtml(agent.email)}</a></p>`);
  return `<section class="agent" aria-label="Votre agent">${parts.join('')}</section>`;
}

/** La page publique du bien, depuis la version publiée. Une annonce retirée ne montre plus rien du bien. */
export function renderListingPage(input: PageInput): string {
  const p = input.payload;
  const title = p.state === 'retiree' || !p.title ? 'Bien retiré de la vente' : p.title;
  const head = `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="referrer" content="no-referrer"><meta name="robots" content="${p.state === 'retiree' ? 'noindex' : 'index'}"><title>${escapeHtml(title)}</title><style>${CSS}</style></head>`;
  const brand = `<header class="marque"><span>AIMMO</span><span>Réf. ${escapeHtml(p.reference)}</span></header>`;
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
    agentBlock(input.agent) +
    `</main></body></html>`
  );
}

/** La fiche imprimable : exactement deux pages A4. Page 1 : titre, état, prix, mentions, photos ; page 2 : texte et agent. */
export function renderListingPrint(input: PageInput): string | null {
  const p = input.payload;
  if (p.state === 'retiree' || p.priceEur === null || !p.body || !p.mentions || !p.title) return null;
  const brand = `<div class="marque">AIMMO · Réf. ${escapeHtml(p.reference)}</div>`;
  return (
    `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>${escapeHtml(p.title)}</title><style>${PRINT_CSS}</style></head><body>` +
    `<section class="page">${brand}<h1>${escapeHtml(p.title)}</h1><span class="etat">${STATE_LABEL[p.state]}</span>` +
    `<p class="prix">${escapeHtml(euros(p.priceEur))}</p><div class="mentions">${escapeHtml(p.mentions)}</div>${photoList(input.photos, MAX_PRINT_PHOTOS)}</section>` +
    // Sur papier, les retours à la ligne deviennent des espaces : 3 000 caractères tiennent toujours dans la page 2,
    // au-dessus de la carte de l'agent, sans rien couper.
    `<section class="page">${brand}<p class="texte">${escapeHtml(p.body.replace(/\s*\n\s*/g, ' '))}</p>${agentBlock(input.agent)}</section>` +
    `</body></html>`
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
    const v = await this.db.first<{ network_id: string; seq: number; payload: string; draft_id: string | null }>(
      'SELECT network_id, seq, payload, draft_id FROM listing_versions WHERE property_id = ? ORDER BY seq DESC LIMIT 1',
      [propertyId],
    );
    if (!v || v.network_id !== networkId) return null;
    const payload = { ...(JSON.parse(v.payload) as Omit<ListingPayload, 'version'>), version: Number(v.seq) };
    let photos: Media[] = [];
    if (v.draft_id) {
      const sheet = await this.db.first<{ data: string }>(
        'SELECT s.data FROM listing_drafts d JOIN property_sheets s ON s.property_id = d.property_id AND s.version = d.sheet_version WHERE d.id = ?',
        [v.draft_id],
      );
      photos = sheet ? (JSON.parse(sheet.data) as PropertySheet).media.filter((m) => m.kind === 'photo') : [];
    }
    const a = await this.db.first<{ first_name: string; last_name: string; status: string }>('SELECT a.first_name, a.last_name, a.status FROM properties p JOIN agents a ON a.id = p.agent_id WHERE p.id = ?', [propertyId]);
    const card = await this.db.first<{ phone: string; email: string }>(
      'SELECT c.phone, c.email FROM agent_public_cards c JOIN properties p ON p.agent_id = c.agent_id WHERE p.id = ? ORDER BY c.set_at DESC, c.rowid DESC LIMIT 1',
      [propertyId],
    );
    // Un agent parti n'est plus montré : la page reste, sans ses coordonnées.
    const agent = a && a.status === 'active' ? { firstName: a.first_name, lastName: a.last_name, phone: card?.phone ?? null, email: card?.email ?? null } : null;
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
