/**
 * La page publique de chaque agent (M01, AT03) [R152, R64, R16, R46, R07, R201].
 *
 * À côté du nom de l'agent, toujours : son statut d'agent commercial, son numéro d'immatriculation et son greffe, et
 * la carte professionnelle du titulaire qui l'habilite (numéro de `listing_settings`, titulaire de `card_holders`).
 * Sans l'une de ces mentions, la page n'est pas publiée et la raison est dite [R152]. Un agent parti n'a plus de page.
 *
 * La page montre les biens de l'agent dont la dernière version publiée est en vente ou sous offre (le fichier
 * diffusable, jamais un brouillon ni une donnée de client) [R16, R46], et le lien vers les avis publiés par ses clients
 * eux-mêmes, celui que la demande d'avis de M11 envoie à chaque client sans tri (F02) [R64]. Les réponses de satisfaction
 * (F05) ne sont jamais publiées, ni une à une ni en moyenne : une moyenne qui bouge à chaque réponse laisserait lire la
 * note d'un client par différence entre deux visites.
 */
import type { Viewer } from '../acces/droits.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { DESIGN_CSS, THEME_COLOR } from '../design/systeme.ts';
import { escapeHtml } from '../documents/modeles.ts';
import { euros } from '../annonces/mentions.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';

export interface AgentMentions {
  rsacNumber: string;
  rsacRegistry: string;
  cardNumber: string;
  cardHolder: string;
}

export interface AgentListing {
  propertyId: string;
  title: string;
  priceEur: number;
  state: 'en_vente' | 'sous_offre';
}

export interface AgentPageInput {
  agentId: string;
  firstName: string;
  lastName: string;
  zone: string | null;
  phone: string | null;
  email: string | null;
  mentions: AgentMentions;
  listings: AgentListing[];
  /** Le lien vers les avis publiés par les clients eux-mêmes (fiche Google de l'agent), s'il est réglé. */
  reviewsUrl: string | null;
}

export type MissingMention = 'agent_inconnu' | 'agent_parti' | 'statut_manquant' | 'carte_manquante' | 'titulaire_manquant';

export type AgentPage = { ok: true; html: string; input: AgentPageInput } | { ok: false; rule: 'R152' | 'R16'; reason: MissingMention };

type Refusal = { ok: false; rule: 'R16'; code: 'role' | 'agent_inconnu' | 'agent_parti' } | { ok: false; rule: 'R152'; code: 'rsac' | 'greffe' | 'titulaire' };

const PHONE = /^\+?[0-9 .]{6,20}$/;
const EMAIL = /^[^\s@<>"']{1,64}@[A-Za-z0-9.-]{1,60}\.[A-Za-z]{2,}$/;
const REVIEWS_URL = /^https:\/\/[^\s"'<>]{4,290}$/;
const STATE_LABEL = { en_vente: 'En vente', sous_offre: 'Sous offre' } as const;

/** Un numéro d'immatriculation : les 9 chiffres du SIREN, écrits « 123 456 789 ». `null` s'il n'en a pas 9. */
export function normalizeRsac(value: string): string | null {
  const digits = value.replace(/^\s*RSAC\s*/i, '').replace(/[\s.]/g, '');
  return /^\d{9}$/.test(digits) ? `${digits.slice(0, 3)} ${digits.slice(3, 6)} ${digits.slice(6)}` : null;
}

const CSS =
  DESIGN_CSS +
  `.tete{display:flex;justify-content:space-between;align-items:center;gap:var(--e-4);padding:var(--e-4)}
main{max-width:46rem;margin:0 auto;padding:0 var(--e-4) var(--e-8)}
.qui{margin:var(--e-6) 0 var(--e-5);border-bottom:2px solid var(--accent);padding-bottom:var(--e-5)}
.qui h1{margin:0 0 var(--e-2);font-size:clamp(2rem,9vw,3rem);line-height:1.05;letter-spacing:-.02em}
.metier{margin:0;font-weight:700;color:var(--accent);letter-spacing:.08em;text-transform:uppercase;font-size:var(--t-xs)}
.statut{background:var(--surface);border-radius:var(--r-m);box-shadow:inset 4px 0 0 var(--moutarde);padding:var(--e-3) var(--e-4);margin:var(--e-4) 0 0;font-size:var(--t-s);max-width:38rem}
.contact{display:flex;flex-wrap:wrap;gap:var(--e-3);margin:var(--e-5) 0}
.contact a{display:inline-block;padding:var(--e-2) var(--e-4);border:2px solid var(--accent);border-radius:var(--r-s);font-weight:600;text-decoration:none;color:var(--accent);min-height:44px}
.biens{list-style:none;margin:0;padding:0;display:grid;gap:var(--e-3)}
.biens a{display:block;padding:var(--e-4);background:var(--surface);border-radius:var(--r-m);text-decoration:none;color:var(--encre)}
.biens strong{display:block;font-size:var(--t-l)}.biens .prix{font:600 var(--t-l) var(--police-titre);color:var(--accent)}
.etat{font-size:var(--t-xs);font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--doux)}
.doux{color:var(--doux)}`;

/** La phrase des mentions, à côté du nom : jamais « mandataire » [R07, R152]. */
export function mentionsLine(m: AgentMentions): string {
  return `Agent commercial, immatriculé au registre spécial des agents commerciaux (RSAC) de ${m.rsacRegistry} sous le n° ${m.rsacNumber}. Habilité par ${m.cardHolder}, titulaire de la carte professionnelle n° ${m.cardNumber}.`;
}

/** La page de l'agent : la base du système de design d'AIMMO, puis sa mise en page, en jetons [R201]. */
export function renderAgentPage(input: AgentPageInput): string {
  const name = `${input.firstName} ${input.lastName}`;
  const title = `${name}, agent immobilier`;
  const head = `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="referrer" content="no-referrer"><meta name="robots" content="index"><meta name="theme-color" content="${THEME_COLOR}"><title>${escapeHtml(title)}</title><style>${CSS}</style></head>`;
  const brand = `<header class="tete"><p class="marque">AIMMO</p></header><div class="frise" aria-hidden="true"></div>`;
  const contact: string[] = [];
  if (input.phone && PHONE.test(input.phone)) contact.push(`<a href="tel:${escapeHtml(input.phone.replace(/[ .]/g, ''))}">Appeler ${escapeHtml(input.phone)}</a>`);
  if (input.email && EMAIL.test(input.email)) contact.push(`<a href="mailto:${escapeHtml(input.email)}">Écrire à ${escapeHtml(input.firstName)}</a>`);
  const listings =
    input.listings.length > 0
      ? `<ul class="biens">${input.listings
          .map(
            (l) =>
              `<li><a href="/biens/${encodeURIComponent(l.propertyId)}"><span class="etat">${STATE_LABEL[l.state]}</span><strong>${escapeHtml(l.title)}</strong><span class="prix">${escapeHtml(euros(l.priceEur))}</span></a></li>`,
          )
          .join('')}</ul>`
      : `<p class="doux">Aucun bien en vente en ce moment.</p>`;
  const reviews =
    input.reviewsUrl && REVIEWS_URL.test(input.reviewsUrl)
      ? `<p><a href="${escapeHtml(input.reviewsUrl)}" rel="noopener noreferrer">Lire les avis de ses clients</a>, publiés par eux-mêmes. Chaque client est invité à en laisser un après la vente, sans tri ni contrepartie.</p>`
      : `<p class="doux">Les avis de ses clients seront bientôt en ligne.</p>`;
  return (
    `${head}<body>${brand}<main>` +
    `<section class="qui" aria-labelledby="nom"><p class="metier">Agent immobilier${input.zone ? ` · ${escapeHtml(input.zone)}` : ''}</p><h1 id="nom">${escapeHtml(name)}</h1>` +
    `<p class="statut">${escapeHtml(mentionsLine(input.mentions))}</p></section>` +
    (contact.length > 0 ? `<nav class="contact" aria-label="Contacter ${escapeHtml(input.firstName)}">${contact.join('')}</nav>` : '') +
    `<h2>Ses biens</h2>${listings}` +
    `<h2>Avis de ses clients</h2>${reviews}` +
    `</main></body></html>`
  );
}

export class PageAgent {
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(
    private readonly db: SqlDatabase,
    private readonly journal: JournalStore,
    options: { now?: () => Date; newId?: () => string } = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => crypto.randomUUID());
  }

  private async refuse(viewer: Viewer, subject: string, code: 'role' | 'agent_inconnu' | 'agent_parti'): Promise<Refusal> {
    await appendEvent(
      this.journal,
      { type: 'acces.refuse', actor: `${String(viewer.role)}:${viewer.userId}`, subject, data: { rule: 'R16', role: String(viewer.role), kind: 'agent_page', code } },
      this.now,
    );
    return { ok: false, rule: 'R16', code };
  }

  /** Les mentions légales d'un agent, réglées par la direction, qui a vu son immatriculation. Chaque réglage s'ajoute. */
  async setLegalMentions(viewer: Viewer, agentId: string, input: { rsacNumber: unknown; rsacRegistry: unknown }): Promise<{ ok: true } | Refusal> {
    if (viewer.role !== 'direction') return this.refuse(viewer, `agent:${agentId}`, 'role');
    const agent = await this.db.first<{ status: string }>('SELECT status FROM agents WHERE id = ? AND network_id = ?', [agentId, viewer.networkId]);
    if (!agent) return this.refuse(viewer, `agent:${agentId}`, 'agent_inconnu');
    if (agent.status !== 'active') return this.refuse(viewer, `agent:${agentId}`, 'agent_parti');
    const rsac = typeof input.rsacNumber === 'string' ? normalizeRsac(input.rsacNumber) : null;
    if (!rsac) return { ok: false, rule: 'R152', code: 'rsac' };
    const registry = typeof input.rsacRegistry === 'string' ? input.rsacRegistry.trim() : '';
    if (registry.length < 2 || registry.length > 80 || /[<>]/.test(registry)) return { ok: false, rule: 'R152', code: 'greffe' };
    await this.db.run(
      "INSERT INTO agent_legal_mentions (id, agent_id, network_id, legal_status, rsac_number, rsac_registry, set_by, set_at) VALUES (?, ?, ?, 'agent_commercial', ?, ?, ?, ?)",
      [this.newId(), agentId, viewer.networkId, rsac, registry, `direction:${viewer.userId}`, this.now().toISOString()],
    );
    await appendEvent(this.journal, { type: 'attirer.agent.mentions', actor: `direction:${viewer.userId}`, subject: `agent:${agentId}`, data: { rule: 'R152' } }, this.now);
    return { ok: true };
  }

  /** Le titulaire de la carte professionnelle du réseau (la société, H09), réglé par la direction. */
  async setCardHolder(viewer: Viewer, holder: unknown): Promise<{ ok: true } | Refusal> {
    if (viewer.role !== 'direction') return this.refuse(viewer, `network:${viewer.networkId}`, 'role');
    const name = typeof holder === 'string' ? holder.trim() : '';
    if (name.length < 2 || name.length > 120 || /[<>]/.test(name)) return { ok: false, rule: 'R152', code: 'titulaire' };
    await this.db.run('INSERT INTO card_holders (id, network_id, holder_name, set_by, set_at) VALUES (?, ?, ?, ?, ?)', [
      this.newId(), viewer.networkId, name, `direction:${viewer.userId}`, this.now().toISOString(),
    ]);
    await appendEvent(this.journal, { type: 'attirer.carte.titulaire', actor: `direction:${viewer.userId}`, subject: `network:${viewer.networkId}`, data: { rule: 'R152' } }, this.now);
    return { ok: true };
  }

  /** Ce que montre la page, ou pourquoi elle n'est pas publiée [R152]. */
  async inputFor(networkId: string, agentId: string): Promise<{ ok: true; input: AgentPageInput } | { ok: false; rule: 'R152' | 'R16'; reason: MissingMention }> {
    const agent = await this.db.first<{ first_name: string; last_name: string; zone: string | null; status: string }>(
      'SELECT first_name, last_name, zone, status FROM agents WHERE id = ? AND network_id = ?',
      [agentId, networkId],
    );
    if (!agent) return { ok: false, rule: 'R16', reason: 'agent_inconnu' };
    if (agent.status !== 'active') return { ok: false, rule: 'R16', reason: 'agent_parti' };
    const legal = await this.db.first<{ rsac_number: string; rsac_registry: string }>(
      'SELECT rsac_number, rsac_registry FROM agent_legal_mentions WHERE agent_id = ? AND network_id = ? ORDER BY set_at DESC, rowid DESC LIMIT 1',
      [agentId, networkId],
    );
    if (!legal) return { ok: false, rule: 'R152', reason: 'statut_manquant' };
    const card = await this.db.first<{ card_number: string }>('SELECT card_number FROM listing_settings WHERE network_id = ? ORDER BY set_at DESC, rowid DESC LIMIT 1', [networkId]);
    if (!card || card.card_number.trim() === '') return { ok: false, rule: 'R152', reason: 'carte_manquante' };
    const holder = await this.db.first<{ holder_name: string }>('SELECT holder_name FROM card_holders WHERE network_id = ? ORDER BY set_at DESC, rowid DESC LIMIT 1', [networkId]);
    if (!holder) return { ok: false, rule: 'R152', reason: 'titulaire_manquant' };
    const contact = await this.db.first<{ phone: string; email: string }>(
      'SELECT phone, email FROM agent_public_cards WHERE agent_id = ? AND network_id = ? ORDER BY set_at DESC, rowid DESC LIMIT 1',
      [agentId, networkId],
    );
    // La dernière version publiée de chaque bien de l'agent, seulement en vente ou sous offre [R16, R46].
    const versions = await this.db.all<{ property_id: string; state: string; payload: string }>(
      `SELECT v.property_id, v.state, v.payload FROM listing_versions v
         JOIN properties p ON p.id = v.property_id
        WHERE p.agent_id = ? AND p.network_id = ? AND v.network_id = p.network_id
          AND v.seq = (SELECT max(seq) FROM listing_versions w WHERE w.property_id = v.property_id)
        ORDER BY v.property_id`,
      [agentId, networkId],
    );
    const listings: AgentListing[] = [];
    for (const v of versions) {
      if (v.state !== 'en_vente' && v.state !== 'sous_offre') continue;
      let payload: { title?: unknown; priceEur?: unknown; body?: unknown; mentions?: unknown };
      try {
        payload = JSON.parse(v.payload) as typeof payload;
      } catch {
        continue;
      }
      // Les mêmes conditions que la page du bien : sans texte ni mentions, elle dirait « plus proposé » [R43].
      if (typeof payload.body === 'string' && payload.body !== '' && typeof payload.mentions === 'string' && payload.mentions !== '' && typeof payload.title === 'string' && payload.title !== '' && typeof payload.priceEur === 'number' && payload.priceEur > 0) {
        listings.push({ propertyId: v.property_id, title: payload.title, priceEur: payload.priceEur, state: v.state });
      }
    }
    const reviews = await this.db.first<{ url: string }>(
      'SELECT url FROM agent_review_links WHERE agent_id = ? AND network_id = ? ORDER BY set_at DESC, rowid DESC LIMIT 1',
      [agentId, networkId],
    );
    return {
      ok: true,
      input: {
        agentId,
        firstName: agent.first_name,
        lastName: agent.last_name,
        zone: agent.zone,
        phone: contact?.phone ?? null,
        email: contact?.email ?? null,
        mentions: { rsacNumber: legal.rsac_number, rsacRegistry: legal.rsac_registry, cardNumber: card.card_number.trim(), cardHolder: holder.holder_name },
        listings,
        reviewsUrl: reviews?.url ?? null,
      },
    };
  }

  async page(networkId: string, agentId: string): Promise<AgentPage> {
    const r = await this.inputFor(networkId, agentId);
    return r.ok ? { ok: true, html: renderAgentPage(r.input), input: r.input } : r;
  }
}
