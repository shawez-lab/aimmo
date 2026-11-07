/**
 * L'écran de vitrine en agence (HX31) [R432, R433, R434].
 *
 * Comme Clap.show d'Apimo : un écran en vitrine fait défiler les biens. Jamais vu :
 * - l'écran ne montre que les biens disponibles que la diffusion autorise au moment même [R42], au prix publié du
 *   moment : titre, prix, mentions et photo sont ceux de la dernière version publiée de l'annonce, au caractère près,
 *   jamais ceux de la fiche du bien ; la page se relit elle-même et refuse un chiffre qui ne vient ni de l'annonce ni de
 *   l'heure du relevé [R432] ;
 * - la page est recalculée à chaque mise à jour (toutes les 5 minutes) : un bien vendu, sous offre ou retiré en
 *   disparaît à la suivante, sans geste de personne [R432] ;
 * - chaque bien porte un code QR vers sa page de référence, marqué du code porteur du bien (AT05) et du code de
 *   l'écran (`vitrine=`) [R433] ; le contact qui arrive par ce lien est compté pour cet écran et ce bien, une fois, et
 *   la mesure du mois dit combien de contacts chaque vitrine a amenés [R434, R16].
 *
 * Décidé, lecture prudente : seuls les biens « en vente » ; « sous offre » n'est pas montré en vitrine, pour ne pas faire
 * venir pour un bien qu'on ne peut plus visiter. Un bien sans page de référence en ligne n'a pas de code QR, donc pas de
 * place à l'écran. La page est servie par le site du réseau, qui sert aussi les photos (`/medias/…`). Dix biens au
 * plus, l'annonce la plus récente d'abord. Sans script, la page montre tous les biens
 * les uns sous les autres ; avec, un seul à la fois. Le nom de l'écran n'est jamais montré : il ne sert qu'à la mesure.
 *
 * Le branchement au Worker (route publique `/vitrine/<code>`, transmission du lien d'arrivée à la captation, écran de
 * réglage) est une tâche de la voie 1 : `app.ts` ne change pas ici.
 */
import type { Acces } from '../acces/acces.ts';
import type { Viewer } from '../acces/droits.ts';
import { contentOfPath, OrigineContacts, randomContentCode, taggedLink } from '../attirer/origine-contacts.ts';
import { Referencement, type PublishedListing } from '../attirer/referencement.ts';
import { euros } from '../annonces/mentions.ts';
import { encodeQr, qrSvg } from '../boutique/qr.ts';
import { unsourcedFigures, visibleText } from '../boutique/supports.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { DESIGN_CSS, THEME_COLOR } from '../design/systeme.ts';
import { escapeHtml } from '../documents/modeles.ts';
import { Diffusion } from '../documents/retractation.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import { parisDayStart } from '../pilotage/tableau-agent.ts';

/** Le paramètre qui marque un lien venu d'une vitrine [R433]. */
export const VITRINE_PARAM = 'vitrine';
/** La page se recharge toutes les 5 minutes : un prix ou un retrait y arrive à la mise à jour suivante [R432]. */
export const VITRINE_REFRESH_SECONDS = 300;
/** Dix biens au plus : la page tient dans le budget d'une page publique, codes QR compris [R201]. */
export const VITRINE_MAX_SLIDES = 10;
export const DEFAULT_SECONDS_PER_SLIDE = 10;

const CODE = /^[a-z2-7]{12}$/;
const MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;
const LABEL = /^[^<>\d]{1,60}$/u;

/** Pourquoi un bien n'est pas à l'écran : l'agent le voit dans l'aperçu, jamais le passant. */
export type LeftOutReason = 'pas_en_vente' | 'diffusion' | 'pas_de_page' | 'qr_trop_long' | 'chiffre_invente' | 'au_dela';

export interface Slide {
  propertyId: string;
  reference: string;
  versionId: string;
  priceEur: number;
  /** L'adresse du code QR : la page de référence du bien, marquée [R433]. */
  link: string;
}

export interface VitrineRender {
  html: string;
  slides: Slide[];
  leftOut: { propertyId: string; reference: string; reason: LeftOutReason }[];
}

export type ScreenResult = { ok: true; screenId: string } | { ok: false; rule: 'R16' | null; code: string };
export type RenderResult = { ok: true; render: VitrineRender } | { ok: false; rule: 'R16' | null; code: string };
export type VitrineRecordResult = { ok: true; screenId: string | null; already: boolean } | { ok: false; code: 'unknown_inbound' };

export interface VitrineMeasure {
  month: string;
  byScreen: { screenId: string; label: string; contacts: number; byProperty: { reference: string; contacts: number }[] }[];
  contacts: number;
}
export type VitrineMeasureResult = { ok: true; measure: VitrineMeasure } | { ok: false; rule: 'R16' | null; code: string };

interface ScreenRow {
  id: string;
  network_id: string;
  agent_id: string | null;
  label: string;
  seconds_per_slide: number;
}

/** L'adresse https lisible, sans identifiant ; rien d'autre n'en est lu. */
function parseUrl(value: unknown): URL | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2000) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.username === '' && url.password === '' ? url : null;
  } catch {
    return null;
  }
}

/** Le lien d'un code QR de vitrine : la page de référence, son code porteur (AT05) et le code de l'écran [R433]. */
export function vitrineLink(canonical: string, contentId: string, screenId: string): string | null {
  if (!CODE.test(screenId)) return null;
  const tagged = taggedLink(canonical, contentId);
  if (!tagged) return null;
  const u = new URL(tagged);
  u.searchParams.set(VITRINE_PARAM, screenId);
  return u.toString();
}

/** Le code d'écran que porte un lien, seulement s'il est seul et bien formé ; `null` sinon. */
export function screenCodeOf(url: URL): string | null {
  const codes = url.searchParams.getAll(VITRINE_PARAM);
  return codes.length === 1 && CODE.test(codes[0]!) ? codes[0]! : null;
}

/** La photo, servie par le site même qui sert l'écran : rien ne vient d'ailleurs [R201]. */
const mediaPath = (ref: string): string => `/medias/${ref.split('/').map(encodeURIComponent).join('/')}`;

/** L'heure de Paris, en « 14 h 05 », et le jour, en « 07/11/2026 ». */
function parisClock(at: Date): { day: string; time: string } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(at)
      .map((p) => [p.type, p.value]),
  );
  return { day: `${parts.day}/${parts.month}/${parts.year}`, time: `${parts.hour} h ${parts.minute}` };
}

/** Les règles propres à l'écran : seulement des jetons du système, aucun mouvement à lui [R201]. */
const VITRINE_CSS =
  'body{min-height:100vh;display:flex;flex-direction:column}' +
  '.tete{display:flex;align-items:center;justify-content:space-between;gap:var(--e-4);padding:var(--e-4)}' +
  'main{flex:1;display:grid;gap:var(--e-6);padding:var(--e-4)}' +
  '.bien{display:grid;gap:var(--e-4);align-content:start}' +
  '.cadre{position:relative}.photo{width:100%;aspect-ratio:4/3;object-fit:cover;border-radius:var(--r-l);background:var(--trait)}' +
  '.virtuel{position:absolute;left:var(--e-3);top:var(--e-3);padding:var(--e-1) var(--e-3);border-radius:var(--r-s);background:var(--encre);color:var(--papier);font-weight:700;font-size:var(--t-s)}' +
  '.bien h2{font-size:var(--t-xxl);margin:0}' +
  '.prix{font:700 var(--t-xxl)/1 var(--police-titre);color:var(--accent);margin:0}' +
  '.mentions{margin:0;padding:var(--e-2) var(--e-3);border-left:3px solid var(--moutarde);font-size:var(--t-s);white-space:pre-line}' +
  '.qr{display:flex;align-items:center;gap:var(--e-4)}.qr svg{width:9rem;height:9rem;flex:none;color:var(--encre);background:var(--surface);border-radius:var(--r-s)}' +
  '.qr p{margin:0;font-weight:600}.ref{color:var(--doux);font-size:var(--t-s);letter-spacing:.08em}' +
  '.pied{padding:var(--e-3) var(--e-4)}' +
  '@media (min-width:60rem){.bien{grid-template-columns:3fr 2fr;align-items:center}.bien .cadre{grid-row:span 5}.qr svg{width:12rem;height:12rem}}';

/** La feuille de l'écran : la base du système, puis ses règles propres. */
const CSS = DESIGN_CSS + VITRINE_CSS;

/**
 * Le petit script de défilement : un bien à la fois, dans l'ordre, sans rien charger ni rien envoyer. Toutes les 5
 * minutes, la page se recharge et reprend au bien où elle en était (noté dans l'ancre de l'adresse) : la mise à jour
 * suivante ne fait jamais repartir du premier bien, et tous les biens passent, quel que soit leur nombre.
 */
const script = (seconds: number): string =>
  `<script>(function(){var s=document.querySelectorAll('main>section'),n=s.length,i=parseInt(location.hash.slice(1),10);i=i>=0&&i<n?i:0;` +
  `for(var k=0;k<n;k++)s[k].hidden=k!==i;if(n>1)setInterval(function(){s[i].hidden=true;i=(i+1)%n;s[i].hidden=false},${seconds * 1000});` +
  `setTimeout(function(){history.replaceState(null,'','#'+i);location.reload()},${VITRINE_REFRESH_SECONDS * 1000})})()</script>`;

export interface SlideInput {
  listing: Pick<PublishedListing, 'title' | 'priceEur' | 'mentions' | 'photo'>;
  reference: string;
  link: string;
}

/** Une diapositive : seulement ce que dit la dernière version publiée de l'annonce, jamais l'adresse [R432]. */
export function renderSlide(input: SlideInput, index: number): string | 'qr_trop_long' {
  const l = input.listing;
  const qr = encodeQr(input.link);
  if (!qr.ok) return 'qr_trop_long';
  const photo = l.photo
    ? `<div class="cadre"><img class="photo" src="${escapeHtml(mediaPath(l.photo.ref))}" alt="${l.photo.overlay ? 'Photo du bien, aménagement virtuel' : 'Photo du bien'}">${l.photo.overlay ? `<span class="virtuel">${escapeHtml(l.photo.overlay)}</span>` : ''}</div>`
    : '';
  return (
    `<section class="bien" aria-labelledby="b${index}">${photo}<h2 id="b${index}">${escapeHtml(l.title)}</h2>` +
    `<p class="prix">${escapeHtml(euros(l.priceEur))}</p><p class="mentions">${escapeHtml(l.mentions)}</p>` +
    `<div class="qr">${qrSvg(qr.qr, 'Code QR vers la page du bien')}<p>Scannez pour voir le bien et nous écrire.</p></div>` +
    `<p class="ref">Réf. ${escapeHtml(input.reference)}</p></section>`
  );
}

/** La page entière de l'écran, à partir des diapositives déjà rendues. */
export function renderVitrinePage(slides: readonly string[], at: Date, seconds: number): string {
  const clock = parisClock(at);
  const body = slides.length > 0 ? slides.join('') : '<section class="bien"><h2>Nos biens arrivent bientôt.</h2></section>';
  return (
    `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<meta name="robots" content="noindex"><meta name="referrer" content="no-referrer"><noscript><meta http-equiv="refresh" content="${VITRINE_REFRESH_SECONDS}"></noscript>` +
    `<meta name="theme-color" content="${THEME_COLOR}"><title>Nos biens en vente</title><style>${CSS}</style></head>` +
    `<body><header class="tete"><p class="marque">AIMMO</p></header><div class="frise" aria-hidden="true"></div>` +
    `<h1 class="visuellement-cache">Nos biens en vente</h1><main>${body}</main>` +
    `<footer class="pied doux"><p>Prix et disponibilités vérifiés le ${clock.day} à ${clock.time}.</p></footer>${script(seconds)}</body></html>`
  );
}

function monthStart(year: number, month: number): string {
  const y = month > 12 ? year + 1 : year;
  const m = month > 12 ? 1 : month;
  return parisDayStart(`${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-01`).toISOString();
}

export interface VitrineOptions {
  now?: () => Date;
  newId?: () => string;
  newCode?: () => string;
  referencement?: Referencement;
  origine?: OrigineContacts;
}

export class Vitrine {
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly newCode: () => string;
  private readonly referencement: Referencement;
  private readonly origine: OrigineContacts;
  private readonly diffusion: Diffusion;

  constructor(
    private readonly db: SqlDatabase,
    acces: Acces,
    private readonly journal: JournalStore,
    options: VitrineOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => crypto.randomUUID());
    this.newCode = options.newCode ?? randomContentCode;
    this.referencement = options.referencement ?? new Referencement(db, journal, { now: this.now });
    this.origine = options.origine ?? new OrigineContacts(db, journal, { now: this.now });
    this.diffusion = new Diffusion(db, acces, journal, { now: this.now });
  }

  private async refuse(viewer: Viewer, subject: string | null, code: string): Promise<{ ok: false; rule: 'R16'; code: string }> {
    await appendEvent(this.journal, { type: 'acces.refuse', actor: `${String(viewer.role)}:${viewer.userId}`, subject, data: { rule: 'R16', kind: 'vitrine', code } }, this.now);
    return { ok: false, rule: 'R16', code };
  }

  private async screen(id: unknown): Promise<ScreenRow | null> {
    if (typeof id !== 'string' || !CODE.test(id)) return null;
    return (await this.db.first<ScreenRow>('SELECT id, network_id, agent_id, label, seconds_per_slide FROM vitrine_screens WHERE id = ?', [id])) ?? null;
  }

  /** La direction règle l'écran de toute agence ; un agent, seulement le sien [R16]. */
  private async mayManage(viewer: Viewer, s: ScreenRow): Promise<boolean> {
    if (s.network_id !== viewer.networkId) return false;
    return viewer.role === 'direction' || (viewer.role === 'agent' && s.agent_id === viewer.userId);
  }

  /**
   * Crée un écran : un écran du réseau (direction seule), ou l'écran d'un agent, qui ne montrera que ses biens. Le nom
   * ne sert qu'à la mesure ; il ne porte ni chiffre ni balise.
   */
  async createScreen(viewer: Viewer, input: { agentId?: unknown; label: unknown; secondsPerSlide?: unknown }): Promise<ScreenResult> {
    if (viewer.role !== 'direction' && viewer.role !== 'agent') return this.refuse(viewer, null, 'role');
    const agentId = input.agentId === undefined || input.agentId === null ? null : input.agentId;
    if (agentId !== null && typeof agentId !== 'string') return { ok: false, rule: null, code: 'bad_agent' };
    if (viewer.role === 'agent' && agentId !== viewer.userId) return this.refuse(viewer, agentId ? `agent:${agentId}` : null, 'not_own_screen');
    if (agentId !== null) {
      const a = await this.db.first<{ status: string }>('SELECT status FROM agents WHERE id = ? AND network_id = ?', [agentId, viewer.networkId]);
      if (!a || a.status !== 'active') return { ok: false, rule: null, code: 'unknown_agent' };
    }
    const label = typeof input.label === 'string' ? input.label.trim() : '';
    if (!LABEL.test(label)) return { ok: false, rule: null, code: 'bad_label' };
    const seconds = input.secondsPerSlide === undefined ? DEFAULT_SECONDS_PER_SLIDE : input.secondsPerSlide;
    if (typeof seconds !== 'number' || !Number.isInteger(seconds) || seconds < 6 || seconds > 60) return { ok: false, rule: null, code: 'bad_seconds' };
    const id = this.newCode();
    if (!CODE.test(id)) throw new Error('Code d’écran invalide.');
    const at = this.now().toISOString();
    await this.db.run('INSERT INTO vitrine_screens (id, network_id, agent_id, label, seconds_per_slide, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [
      id,
      viewer.networkId,
      agentId,
      label,
      seconds,
      `${viewer.role}:${viewer.userId}`,
      at,
    ]);
    await this.db.run('INSERT INTO vitrine_screen_switches (id, screen_id, active, by_actor, at) VALUES (?, ?, 1, ?, ?)', [this.newId(), id, `${viewer.role}:${viewer.userId}`, at]);
    await appendEvent(this.journal, { type: 'recherche.vitrine_creee', actor: `${viewer.role}:${viewer.userId}`, subject: `vitrine:${id}`, data: { agent: agentId !== null } }, this.now);
    return { ok: true, screenId: id };
  }

  /** Allume ou éteint un écran ; un écran éteint ne montre plus aucun bien. */
  async setActive(viewer: Viewer, screenId: unknown, active: unknown): Promise<ScreenResult> {
    if (typeof active !== 'boolean') return { ok: false, rule: null, code: 'bad_active' };
    const s = await this.screen(screenId);
    if (!s || s.network_id !== viewer.networkId) return { ok: false, rule: null, code: 'unknown_screen' };
    if (!(await this.mayManage(viewer, s))) return this.refuse(viewer, `vitrine:${s.id}`, 'not_own_screen');
    await this.db.run('INSERT INTO vitrine_screen_switches (id, screen_id, active, by_actor, at) VALUES (?, ?, ?, ?, ?)', [this.newId(), s.id, active ? 1 : 0, `${viewer.role}:${viewer.userId}`, this.now().toISOString()]);
    return { ok: true, screenId: s.id };
  }

  private async isActive(screenId: string): Promise<boolean> {
    const last = await this.db.first<{ active: number }>('SELECT active FROM vitrine_screen_switches WHERE screen_id = ? ORDER BY at DESC, rowid DESC LIMIT 1', [screenId]);
    return last?.active === 1;
  }

  /** Ce que l'écran montre maintenant, recalculé depuis la base à chaque appel [R432]. */
  private async build(s: ScreenRow): Promise<VitrineRender> {
    const at = this.now();
    const clock = parisClock(at);
    const listings = (await this.referencement.published(s.network_id))
      .filter((l) => s.agent_id === null || l.agentId === s.agent_id)
      .sort((a, b) => (b.day ?? '').localeCompare(a.day ?? '') || a.propertyId.localeCompare(b.propertyId));
    const slides: Slide[] = [];
    const html: string[] = [];
    const leftOut: VitrineRender['leftOut'] = [];
    for (const l of listings) {
      const reference = (await this.db.first<{ reference: string }>('SELECT reference FROM properties WHERE id = ? AND network_id = ?', [l.propertyId, s.network_id]))?.reference;
      if (!reference) continue;
      const leave = (reason: LeftOutReason): void => void leftOut.push({ propertyId: l.propertyId, reference, reason });
      // Seul un bien en vente et disponible, au moment même : la version publiée et le bien lui-même le disent.
      if (l.state !== 'en_vente' || l.propertyStatus !== 'available') {
        leave('pas_en_vente');
        continue;
      }
      // Les places prises, plus rien de coûteux n'est relu pour les biens suivants.
      if (slides.length >= VITRINE_MAX_SLIDES) {
        leave('au_dela');
        continue;
      }
      // La porte de toute diffusion, demandée à chaque rendu, pas seulement au dernier passage de la publication [R42].
      if (!(await this.diffusion.canDiffuse(s.network_id, l.propertyId, at)).allowed) {
        leave('diffusion');
        continue;
      }
      const canonical = await this.referencement.canonicalFor(s.network_id, l.propertyId);
      if (!canonical) {
        leave('pas_de_page');
        continue;
      }
      const content = await this.origine.contentFor(s.network_id, 'bien', l.propertyId);
      const link = content.ok ? vitrineLink(canonical, content.contentId, s.id) : null;
      if (!link) {
        leave('pas_de_page');
        continue;
      }
      const one = renderSlide({ listing: l, reference, link }, slides.length + 1);
      if (one === 'qr_trop_long') {
        leave('qr_trop_long');
        continue;
      }
      // La diapositive se relit : aucun chiffre qui ne vienne de l'annonce publiée [R432].
      const sources = [l.title, l.mentions, euros(l.priceEur), reference, l.photo?.overlay ?? ''];
      if (unsourcedFigures(visibleText(one), sources).length > 0) {
        leave('chiffre_invente');
        continue;
      }
      html.push(one);
      slides.push({ propertyId: l.propertyId, reference, versionId: l.versionId, priceEur: l.priceEur, link });
    }
    const full = renderVitrinePage(html, at, s.seconds_per_slide);
    // Toute la page se relit à la fin : seuls l'annonce, l'heure du relevé et le numéro des diapositives sont permis.
    const allowed = [...slides.flatMap((x) => [x.reference, euros(x.priceEur)]), ...listings.flatMap((l) => [l.title, l.mentions, l.photo?.overlay ?? '']), clock.day, clock.time];
    if (unsourcedFigures(visibleText(full.replace(/<script>[\s\S]*?<\/script>/g, ' ')), allowed).length > 0) throw new Error('Vitrine : un chiffre sans source.');
    return { html: full, slides, leftOut };
  }

  /** La page publique de l'écran : sans droits, elle ne dit que ce que disent les annonces publiées [R432]. */
  async page(screenId: unknown): Promise<{ ok: true; html: string; slides: Slide[] } | { ok: false; code: 'unknown_screen' | 'screen_off' }> {
    const s = await this.screen(screenId);
    if (!s) return { ok: false, code: 'unknown_screen' };
    if (!(await this.isActive(s.id))) return { ok: false, code: 'screen_off' };
    const r = await this.build(s);
    return { ok: true, html: r.html, slides: r.slides };
  }

  /** L'aperçu pour qui règle l'écran : la page, et pourquoi chaque bien absent ne s'y trouve pas [R16]. */
  async preview(viewer: Viewer, screenId: unknown): Promise<RenderResult> {
    const s = await this.screen(screenId);
    if (!s || s.network_id !== viewer.networkId) return { ok: false, rule: null, code: 'unknown_screen' };
    if (!(await this.mayManage(viewer, s))) return this.refuse(viewer, `vitrine:${s.id}`, 'not_own_screen');
    return { ok: true, render: await this.build(s) };
  }

  /**
   * Range l'écran d'où vient un message reçu, une seule fois : la première lecture compte. L'écran se lit sur un seul
   * code `vitrine=` d'un écran du réseau, dans le lien d'arrivée ou la page de départ ; deux codes différents, c'est un
   * doute, rien n'est rangé. Le bien est celui de la page du lien, s'il est du réseau. Rien d'autre n'est gardé [R434].
   */
  async record(networkId: string, inboundId: string, signals: { link?: unknown; landingPage?: unknown } = {}): Promise<VitrineRecordResult> {
    const row = await this.db.first<{ id: string }>('SELECT id FROM inbound_messages WHERE id = ? AND network_id = ?', [inboundId, networkId]);
    if (!row) return { ok: false, code: 'unknown_inbound' };
    const existing = await this.stored(inboundId);
    if (existing) return { ok: true, screenId: existing, already: true };
    const found: { screenId: string; url: URL }[] = [];
    for (const raw of [signals.link, signals.landingPage]) {
      const url = parseUrl(raw);
      if (!url) continue;
      if (url.searchParams.getAll(VITRINE_PARAM).length > 1) return { ok: true, screenId: null, already: false };
      const code = screenCodeOf(url);
      if (code) found.push({ screenId: code, url });
    }
    if (found.length === 0 || new Set(found.map((f) => f.screenId)).size !== 1) return { ok: true, screenId: null, already: false };
    const s = await this.screen(found[0]!.screenId);
    if (!s || s.network_id !== networkId) return { ok: true, screenId: null, already: false };
    // Le bien : celui de la page visée par le lien, s'il est du réseau ; deux pages différentes, aucun bien.
    const targets = new Set(found.map((f) => contentOfPath(f.url.pathname)).filter((t) => t?.kind === 'bien').map((t) => t!.ref));
    let propertyId: string | null = null;
    if (targets.size === 1) {
      const id = [...targets][0]!;
      propertyId = (await this.db.first<{ id: string }>('SELECT id FROM properties WHERE id = ? AND network_id = ?', [id, networkId]))?.id ?? null;
    }
    const inserted = await this.db.run('INSERT OR IGNORE INTO contact_vitrines (id, network_id, inbound_id, screen_id, property_id, recorded_at) VALUES (?, ?, ?, ?, ?, ?)', [
      this.newId(),
      networkId,
      inboundId,
      s.id,
      propertyId,
      this.now().toISOString(),
    ]);
    const already = inserted.changes === 0;
    if (!already) await appendEvent(this.journal, { type: 'recherche.contact_vitrine', actor: 'system', subject: `inbound:${inboundId}`, data: { rule: 'R434', screen: s.id } }, this.now);
    return { ok: true, screenId: (await this.stored(inboundId))!, already };
  }

  async stored(inboundId: string): Promise<string | null> {
    return (await this.db.first<{ screen_id: string }>('SELECT screen_id FROM contact_vitrines WHERE inbound_id = ?', [inboundId]))?.screen_id ?? null;
  }

  /**
   * La mesure d'un mois (`AAAA-MM`, heure de Paris) : les contacts venus de chaque vitrine, comptés comme dans AT05 (une
   * conversation, le mois de son premier message, par le premier message qui porte une vitrine). La direction voit tous
   * les écrans du réseau ; un agent, seulement les siens [R16].
   */
  async measure(viewer: Viewer, month: unknown): Promise<VitrineMeasureResult> {
    if (viewer.role !== 'direction' && viewer.role !== 'agent') return this.refuse(viewer, null, 'role');
    const m = typeof month === 'string' ? MONTH.exec(month) : null;
    if (!m) return { ok: false, rule: null, code: 'bad_month' };
    const from = monthStart(Number(m[1]), Number(m[2]));
    const to = monthStart(Number(m[1]), Number(m[2]) + 1);
    const screens = await this.db.all<ScreenRow>(
      'SELECT id, network_id, agent_id, label, seconds_per_slide FROM vitrine_screens WHERE network_id = ? AND (? = 1 OR agent_id = ?) ORDER BY created_at, id',
      [viewer.networkId, viewer.role === 'direction' ? 1 : 0, viewer.userId],
    );
    const rows = await this.db.all<{ known: string | null }>(
      `SELECT min(CASE WHEN v.screen_id IS NOT NULL THEN m.received_at || '|' || m.id || '|' || v.screen_id || '|' || coalesce(v.property_id, '') END) AS known
         FROM inbound_messages m LEFT JOIN contact_vitrines v ON v.inbound_id = m.id AND v.network_id = m.network_id
        WHERE m.network_id = ? AND m.status <> 'unreadable' AND m.kind <> 'unreadable'
        GROUP BY m.channel, coalesce(m.conversation_ref, m.kind || ':' || m.external_id, m.id)
       HAVING min(m.received_at) >= ? AND min(m.received_at) < ?`,
      [viewer.networkId, from, to],
    );
    const mine = new Set(screens.map((s) => s.id));
    const counts = new Map<string, Map<string, number>>();
    for (const r of rows) {
      if (!r.known) continue;
      const parts = r.known.split('|');
      const propertyId = parts.pop()!;
      const screenId = parts.pop()!;
      if (!mine.has(screenId)) continue;
      const byProperty = counts.get(screenId) ?? new Map<string, number>();
      byProperty.set(propertyId, (byProperty.get(propertyId) ?? 0) + 1);
      counts.set(screenId, byProperty);
    }
    const byScreen: VitrineMeasure['byScreen'] = [];
    for (const s of screens) {
      const byProperty = counts.get(s.id) ?? new Map<string, number>();
      const list: { reference: string; contacts: number }[] = [];
      for (const [propertyId, contacts] of byProperty) {
        const ref = propertyId ? (await this.db.first<{ reference: string }>('SELECT reference FROM properties WHERE id = ? AND network_id = ?', [propertyId, viewer.networkId]))?.reference : undefined;
        list.push({ reference: ref ?? 'bien non lu', contacts });
      }
      list.sort((a, b) => b.contacts - a.contacts || a.reference.localeCompare(b.reference));
      byScreen.push({ screenId: s.id, label: s.label, contacts: list.reduce((a, b) => a + b.contacts, 0), byProperty: list });
    }
    return { ok: true, measure: { month: month as string, byScreen, contacts: byScreen.reduce((a, b) => a + b.contacts, 0) } };
  }
}
