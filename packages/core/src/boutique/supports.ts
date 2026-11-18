/**
 * Les supports imprimés de l'agent, tirés du bien lui-même (HX07) [R263, R264].
 *
 * Panneau « À vendre », flyer et vitrine sortent de la dernière version publiée de l'annonce, jamais d'un brouillon ni de
 * la fiche du bien : titre, prix, mentions et photo y sont ceux de la page du bien, au caractère près. La carte de visite
 * sort de la carte professionnelle de l'agent. Chaque support porte un code QR vers la page de référence du bien (ou le
 * site de l'agent pour la carte), et le mot-clé « RÉF <référence> », que la captation reconnaît pour répondre aussitôt
 * avec les vraies données du bien (C03, C04).
 *
 * Lecture prudente :
 * - le panneau ne porte aucun prix : il n'a donc besoin d'aucune mention de prix ; flyer et vitrine portent le prix et
 *   toutes les mentions de l'annonce, en entier, sous le prix ;
 * - aucun chiffre n'apparaît sur un support s'il ne vient pas de l'annonce publiée, de la carte de l'agent ou de
 *   l'adresse du code : le rendu se relit lui-même et refuse sinon ;
 * - sans téléphone professionnel de l'agent, aucun support : le mot-clé n'aurait nulle part où être envoyé.
 */
import { PRINT_DESIGN_CSS } from '../design/systeme.ts';
import { escapeHtml } from '../documents/modeles.ts';
import type { AgentCard } from '../annonces/page-bien.ts';
import { DEFAULT_PROFESSIONAL_TITLE, capitalizedTitle } from '../attirer/qualite.ts';
import { euros } from '../annonces/mentions.ts';
import type { ListingPayload } from '../annonces/publication.ts';
import { encodeQr, qrSvg } from './qr.ts';

export const SUPPORTS = ['panneau', 'flyer', 'vitrine', 'carte'] as const;
export type Support = (typeof SUPPORTS)[number];
export const PROPERTY_SUPPORTS: readonly Support[] = ['panneau', 'flyer', 'vitrine'];

export const SUPPORT_LABEL: Record<Support, string> = { panneau: 'Panneau « À vendre »', flyer: 'Flyer', vitrine: 'Affiche de vitrine', carte: 'Carte de visite' };

/** Le mot-clé à écrire à l'agent : la captation y lit la référence du bien (`referencesIn`). */
export const keywordFor = (reference: string): string => `RÉF ${reference}`;

export interface PropertySupportInput {
  support: 'panneau' | 'flyer' | 'vitrine';
  payload: ListingPayload;
  agent: AgentCard;
  /** La page de référence du bien, où mène le code QR. */
  url: string;
}

export interface CardSupportInput {
  support: 'carte';
  agent: AgentCard;
  /** Le site de l'agent (ou du réseau), où mène le code QR. */
  url: string;
}

export type SupportInput = PropertySupportInput | CardSupportInput;

export type SupportRefusal = {
  ok: false;
  code: 'annonce_pas_en_vente' | 'annonce_incomplete' | 'pas_de_telephone' | 'adresse_invalide' | 'qr_trop_long' | 'chiffre_invente' | 'reference_illisible';
};

const PHONE = /^\+?[0-9 .]{6,20}$/;
const READABLE_REFERENCE = /^[a-z0-9](?:[^\s,;!?()«»"']*[^\s,;!?()«»"'.:])?$/i;
const PAGE_SIZE: Record<Support, string> = { panneau: '800mm 600mm', flyer: 'A5', vitrine: 'A4', carte: '85mm 55mm' };

const CSS =
  PRINT_DESIGN_CSS +
  `.support{position:relative;overflow:hidden;display:grid;gap:4mm;align-content:start}
.marque{font:600 8pt/1 var(--police-texte);letter-spacing:.12em;text-transform:uppercase;color:var(--accent)}
.frise{height:0;border-top:2mm solid var(--accent);border-bottom:1mm solid var(--moutarde)}
.prix{font-weight:700;color:var(--accent);margin:0;letter-spacing:-.01em}
.mentions{border-left:2pt solid var(--moutarde);padding:1mm 3mm;margin:0;font-size:7.5pt;line-height:1.35;white-space:pre-line}
.qr{display:grid;grid-template-columns:auto 1fr;gap:4mm;align-items:center}.qr svg{display:block;color:var(--encre);background:var(--papier)}
.mot{margin:0;font-weight:700}.mot strong{color:var(--accent);white-space:nowrap}
.ref{font:600 8pt var(--police-texte);letter-spacing:.08em;color:var(--doux)}
.photo{width:100%;object-fit:cover;background:var(--trait)}
.virtuel{position:absolute;left:2mm;top:2mm;background:var(--encre);color:var(--papier);font:700 7pt var(--police-texte);padding:1mm 2mm}
.cadre{position:relative}h1{margin:0;line-height:1.15}
.panneau{width:800mm;height:600mm;padding:30mm;background:var(--papier);border:12mm solid var(--accent)}
.panneau .vendre{font:800 150mm/0.9 var(--police-titre);margin:0;color:var(--accent);letter-spacing:-.03em}
.panneau .tel{font:700 70mm/1 var(--police-titre);margin:0;color:var(--encre)}
.panneau .qr svg{width:170mm;height:170mm}.panneau .mot{font-size:22mm}.panneau .ref{font-size:12mm}.panneau .marque{font-size:14mm}
.flyer{width:148mm;height:210mm;padding:10mm}.flyer .photo{height:70mm}.flyer h1{font-size:15pt}.flyer .prix{font-size:24pt}
.flyer .qr svg{width:28mm;height:28mm}.flyer .mot{font-size:9pt}
.vitrine{width:210mm;height:297mm;padding:14mm}.vitrine .photo{height:120mm}.vitrine h1{font-size:20pt}.vitrine .prix{font-size:34pt}
.vitrine .qr svg{width:36mm;height:36mm}.vitrine .mot{font-size:11pt}
.agent{font-size:9pt;border-top:1pt solid var(--accent);padding-top:2mm}
.carte{width:85mm;height:55mm;padding:5mm;grid-template-columns:1fr auto;gap:2mm 4mm}.carte .nom{font:700 12pt/1.1 var(--police-titre);margin:0}
.carte p{margin:0;font-size:8pt}.carte .qr svg{width:20mm;height:20mm}.carte .titre{color:var(--accent);font-weight:600}`;

/** L'adresse entière d'une photo, sur le site de la page du bien : l'imprimeur reçoit le seul HTML. */
const mediaUrl = (origin: string, ref: string): string => `${origin}/medias/${ref.split('/').map(encodeURIComponent).join('/')}`;

/**
 * Les nombres d'un texte, sans séparateur de milliers : « 210 000 € » donne « 210000 ». Un séparateur ne compte que
 * seul entre deux chiffres : deux nombres de deux blocs voisins ne se collent jamais.
 */
export function figuresIn(text: string): string[] {
  return (text.match(/\d(?:[\d.,]|[ \u00a0\u202f](?=\d))*/g) ?? []).map((n) => n.replace(/[.,]+$/, '').replace(/[\u00a0\u202f .]/g, ''));
}

/** Les nombres du texte visible d'un support qui ne figurent, entiers, dans aucune source permise : vide quand tout est sourcé. */
export function unsourcedFigures(visible: string, sources: readonly string[]): string[] {
  const allowed = new Set(sources.flatMap(figuresIn));
  return [...new Set(figuresIn(visible))].filter((n) => !allowed.has(n));
}

/** Le texte imprimé : le corps seul, sans balise ni dessin du code QR, entités rendues. */
export function visibleText(html: string): string {
  return html
    .replace(/<head>[\s\S]*?<\/head>/g, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function validUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' && u.username === '' && u.password === '';
  } catch {
    return false;
  }
}

function qrBlock(url: string, keyword: string | null, phone: string): string | SupportRefusal {
  const qr = encodeQr(url);
  if (!qr.ok) return { ok: false, code: 'qr_trop_long' };
  const svg = qrSvg(qr.qr, keyword ? 'Code QR vers la page du bien' : 'Code QR vers le site de l’agent');
  const mot = keyword ? `<p class="mot">Écrivez <strong>« ${escapeHtml(keyword)} »</strong> au ${escapeHtml(phone)} ou scannez le code.</p>` : '';
  return `<div class="qr">${svg}${mot}</div>`;
}

function document(support: Support, title: string, body: string): string {
  const style = `${CSS}@page{size:${PAGE_SIZE[support]};margin:0}`;
  return (
    `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>` +
    `<style>${style}</style></head><body>${body}</body></html>`
  );
}

export type RenderedSupport = { ok: true; html: string; keyword: string | null; url: string };

/** Le support prêt à imprimer, ou la raison pour laquelle il ne peut pas exister. */
export function renderSupport(input: SupportInput): RenderedSupport | SupportRefusal {
  const agent = input.agent;
  if (!agent.phone || !PHONE.test(agent.phone)) return { ok: false, code: 'pas_de_telephone' };
  if (!validUrl(input.url)) return { ok: false, code: 'adresse_invalide' };
  const name = `${agent.firstName} ${agent.lastName}`;
  const agentSources = [agent.phone, agent.email ?? '', name];

  if (input.support === 'carte') {
    const qr = qrBlock(input.url, null, agent.phone);
    if (typeof qr !== 'string') return qr;
    const email = agent.email ? `<p>${escapeHtml(agent.email)}</p>` : '';
    const body =
      `<section class="support carte"><div><p class="nom">${escapeHtml(name)}</p><p class="titre">${escapeHtml(capitalizedTitle(agent.title ?? DEFAULT_PROFESSIONAL_TITLE))}</p>` +
      `<p>${escapeHtml(agent.phone)}</p>${email}<p class="marque">AIMMO</p></div>${qr}</section>`;
    const html = document('carte', `Carte de visite · ${name}`, body);
    if (unsourcedFigures(visibleText(html), agentSources).length > 0) return { ok: false, code: 'chiffre_invente' };
    return { ok: true, html, keyword: null, url: input.url };
  }

  const p = input.payload;
  if (p.state !== 'en_vente') return { ok: false, code: 'annonce_pas_en_vente' };
  if (!p.title || !p.mentions || p.priceEur === null || !(p.priceEur > 0) || !p.reference) return { ok: false, code: 'annonce_incomplete' };
  // Le mot-clé doit se relire tel quel par la captation : une référence entière, sans espace ni ponctuation finale.
  if (!READABLE_REFERENCE.test(p.reference)) return { ok: false, code: 'reference_illisible' };
  const keyword = keywordFor(p.reference);
  const qr = qrBlock(input.url, keyword, agent.phone);
  if (typeof qr !== 'string') return qr;
  const ref = `<p class="ref">Réf. ${escapeHtml(p.reference)}</p>`;
  const quality = escapeHtml(agent.title ?? DEFAULT_PROFESSIONAL_TITLE);
  const agentLine = `<p class="agent"><strong>${escapeHtml(name)}</strong>, ${quality} · ${escapeHtml(agent.phone)}${agent.email ? ` · ${escapeHtml(agent.email)}` : ''}</p>`;
  let body: string;
  if (input.support === 'panneau') {
    body = `<section class="support panneau"><p class="vendre">À vendre</p><p class="tel">${escapeHtml(agent.phone)}</p>${qr}${ref}<p class="marque">${escapeHtml(name)} · ${quality} · AIMMO</p></section>`;
  } else {
    // La première photo de l'annonce publiée, avec sa mention d'aménagement virtuel sur l'image [R48].
    const first = p.media.find((m) => m.kind === 'photo');
    const photo = first
      ? `<div class="cadre"><img class="photo" src="${escapeHtml(mediaUrl(new URL(input.url).origin, first.ref))}" alt="${first.overlay ? 'Photo du bien, aménagement virtuel' : 'Photo du bien'}">${first.overlay ? `<span class="virtuel">${escapeHtml(first.overlay)}</span>` : ''}</div>`
      : '';
    body =
      `<section class="support ${input.support}"><p class="marque">AIMMO · ${escapeHtml(SUPPORT_LABEL[input.support])}</p><div class="frise" aria-hidden="true"></div>` +
      `${photo}<h1>${escapeHtml(p.title)}</h1><p class="prix">${escapeHtml(euros(p.priceEur))}</p>` +
      `<p class="mentions">${escapeHtml(p.mentions)}</p>${qr}${ref}${agentLine}</section>`;
  }
  const html = document(input.support, `${SUPPORT_LABEL[input.support]} · ${p.title}`, body);
  const sources = [p.title, p.mentions, euros(p.priceEur), p.reference, ...agentSources];
  if (unsourcedFigures(visibleText(html), sources).length > 0) return { ok: false, code: 'chiffre_invente' };
  return { ok: true, html, keyword, url: input.url };
}
