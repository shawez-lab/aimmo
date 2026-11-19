/**
 * Le mode présentation pendant la visite (HX13) [R279, R280, R281].
 *
 * Comme Live Visit et le mode présentation : l'agent tend son téléphone à l'acquéreur, qui voit le bien visité et les
 * biens du réseau qui répondent à sa recherche, sans rien voir de l'agence [R279]. La page ne se fait qu'à partir de la
 * dernière version publiée de chaque annonce (titre, prix, mentions, photo, référence), au caractère près : jamais le
 * vendeur, ses coordonnées, le mandat, les notes de l'agent, l'état du dossier ni le journal. Elle se relit avant d'être
 * rendue : un nom, une coordonnée ou une note connus du dossier, ou un chiffre qui ne vient pas de l'annonce, et elle
 * n'est pas montrée.
 *
 * Jamais vu : à la fin, l'acquéreur note chaque pièce d'un geste (aimée, moyenne, pas aimée) [R280], et le code en tire
 * seul, sans IA, le compte rendu au vendeur et la prochaine proposition [R281]. Le compte rendu ne dit que les notes,
 * jamais « prêt à faire une offre », jamais le nom de l'acquéreur ; il ne part au vendeur que validé par l'agent, par le
 * contrôle central (T06). La prochaine proposition est une contre-visite si l'intérêt est fort, sinon le premier bien
 * qui répond à la recherche et que l'acquéreur n'a pas encore visité, avec ses raisons ; rien n'est envoyé à l'acquéreur.
 *
 * Décidé, lecture prudente : les mentions publiées de l'annonce restent, car la loi les veut sur toute présentation d'un
 * bien (prix, part des honoraires, énergie, carte) [R43] ; aucun autre chiffre des honoraires n'est montré. Le bien
 * visité est montré « en vente » ou « sous offre », s'il est diffusable ; les autres seulement « en vente », disponibles
 * et diffusables au moment même [R42], au plus 4, dans l'ordre écrit du rapprochement [R51]. Les pièces à noter sont la
 * liste de cadrage du bien (HX12). Un bien proposé dont la page trahirait un nom de son dossier est retiré de la page.
 *
 * Le branchement au Worker (`app.ts`) et l'écran sur le téléphone sont une tâche à part : `app.ts` ne change pas ici.
 */
import { areaOfProject } from '../acquereurs/secteurs.ts';
import type { Acces } from '../acces/acces.ts';
import type { Viewer } from '../acces/droits.ts';
import { matchBuyer, Rapprochement, type BuyerMatch, type DiffusionGate } from '../acquereurs/rapprochement.ts';
import { EMPTY_SEARCH, toVersion, type BuyerSearch, type BuyerSearchRow } from '../acquereurs/fiche-acquereur.ts';
import { euros } from '../annonces/mentions.ts';
import { Referencement, type PublishedListing } from '../attirer/referencement.ts';
import { unsourcedFigures, visibleText } from '../boutique/supports.ts';
import { FicheClient } from '../db/fiche-client.ts';
import type { SqlDatabase } from '../db/sql.ts';
import type { Property } from '../db/types.ts';
import { DESIGN_CSS, THEME_COLOR } from '../design/systeme.ts';
import { escapeHtml } from '../documents/modeles.ts';
import { Diffusion } from '../documents/retractation.ts';
import { plain } from '../envoi/texte.ts';
import { FicheUnique } from '../fiche/fusion.ts';
import { shotPlan, type Shot } from '../hors-ligne/cadrage.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import type { ComptesRendus, Interest, VisitReport } from '../visites/compte-rendu.ts';
import type { Visites } from '../visites/visites.ts';

/** Les notes d'une pièce, d'une liste fermée [R280]. */
export const ROOM_VERDICTS = ['aime', 'moyen', 'non'] as const;
export type RoomVerdict = (typeof ROOM_VERDICTS)[number];
const VERDICT_LABEL: Record<RoomVerdict, string> = { aime: 'Aimé', moyen: 'Moyen', non: 'Pas aimé' };

/** Au plus tant de biens proposés à côté du bien visité. */
export const PRESENTATION_MAX_MATCHES = 4;
/** Les notes se donnent jusqu'à 24 heures après la fin de la visite. */
export const RATING_WINDOW_HOURS = 24;

/** Ce que le mode présentation sait d'un bien : la dernière version publiée de son annonce, et rien d'autre [R279]. */
export interface PresentedProperty {
  propertyId: string;
  reference: string;
  title: string;
  priceEur: number;
  mentions: string;
  photo: { ref: string; overlay: string | null } | null;
}

export interface PresentedMatch extends PresentedProperty {
  /** Pourquoi il répond à la recherche, sans aucun chiffre de la recherche. */
  reasons: string[];
}

export interface Presentation {
  html: string;
  visited: PresentedProperty;
  rooms: Shot[];
  matches: PresentedMatch[];
  /** Les biens qui répondaient à la recherche et n'ont pas été montrés, avec la raison : l'agent seul le voit. */
  leftOut: { propertyId: string; reason: 'confidentiel' | 'chiffre_invente' | 'au_dela' }[];
}

export type PresentationRefusal = { ok: false; rule: string | null; code: string };
export type RoomRatings = Record<string, RoomVerdict>;

export type NextProposal =
  | { kind: 'contre_visite'; propertyId: string; reference: string; reasons: string[] }
  | { kind: 'bien'; propertyId: string; reference: string; reasons: string[] }
  | { kind: 'aucune'; reasons: string[] };

export interface RatingOutcome {
  report: VisitReport;
  next: NextProposal;
}

/** Le lien du bien : la page publiée, servie par le site qui sert l'écran. */
const mediaPath = (ref: string): string => `/medias/${ref.split('/').map(encodeURIComponent).join('/')}`;

const PRESENTATION_CSS =
  '.tete{display:flex;align-items:center;justify-content:space-between;gap:var(--e-4);padding:var(--e-4)}' +
  'main{display:grid;gap:var(--e-6);padding:var(--e-4);max-width:48rem;margin:0 auto}' +
  '.bien{display:grid;gap:var(--e-3)}.bien h2{margin:0;font-size:var(--t-xl)}' +
  '.cadre{position:relative}.photo{width:100%;aspect-ratio:4/3;object-fit:cover;border-radius:var(--r-l);background:var(--trait)}' +
  '.virtuel{position:absolute;left:var(--e-3);top:var(--e-3);padding:var(--e-1) var(--e-3);border-radius:var(--r-s);background:var(--encre);color:var(--papier);font-weight:700;font-size:var(--t-s)}' +
  '.prix{font:700 var(--t-xl)/1 var(--police-titre);color:var(--accent);margin:0}' +
  '.mentions{margin:0;padding:var(--e-2) var(--e-3);border-left:3px solid var(--moutarde);font-size:var(--t-s);white-space:pre-line}' +
  '.ref{color:var(--doux);font-size:var(--t-s);letter-spacing:.08em;margin:0}' +
  '.notes-pieces{display:grid;gap:var(--e-3)}.piece{border:1px solid var(--trait);border-radius:var(--r-m);padding:var(--e-3);margin:0;display:grid;gap:var(--e-2)}' +
  '.piece legend{font-weight:700;padding:0 var(--e-1)}.gestes{display:grid;grid-template-columns:repeat(3,1fr);gap:var(--e-2)}' +
  '.gestes label{display:flex;align-items:center;justify-content:center;min-height:3rem;border:2px solid var(--trait);border-radius:var(--r-m);font-weight:600;cursor:pointer}' +
  '.gestes input{position:absolute;opacity:0;width:1px;height:1px}.gestes input:checked+span{color:var(--accent)}' +
  '.gestes label:has(input:checked){border-color:var(--accent);background:var(--surface)}' +
  '.gestes label:has(input:focus-visible){outline:3px solid var(--moutarde);outline-offset:2px}' +
  '.autres{display:grid;gap:var(--e-4)}@media (min-width:40rem){.autres{grid-template-columns:1fr 1fr}}' +
  '.raisons{margin:0;padding-left:1.2em;font-size:var(--t-s)}';

const CSS = DESIGN_CSS + PRESENTATION_CSS;

function propertyBlock(p: PresentedProperty, id: string, heading: 'h2' | 'h3'): string {
  const photo = p.photo
    ? `<div class="cadre"><img class="photo" src="${escapeHtml(mediaPath(p.photo.ref))}" alt="${p.photo.overlay ? 'Photo du bien, aménagement virtuel' : 'Photo du bien'}">${p.photo.overlay ? `<span class="virtuel">${escapeHtml(p.photo.overlay)}</span>` : ''}</div>`
    : '';
  return (
    `${photo}<${heading} id="${id}">${escapeHtml(p.title)}</${heading}>` +
    `<p class="prix">${escapeHtml(euros(p.priceEur))}</p><p class="mentions">${escapeHtml(p.mentions)}</p><p class="ref">Réf. ${escapeHtml(p.reference)}</p>`
  );
}

/**
 * La page du mode présentation : le bien visité, les pièces à noter d'un geste, les biens qui répondent à la recherche.
 * Elle ne prend que des biens publiés : aucun autre champ n'existe dans ce qu'elle reçoit [R279]. Sans script.
 */
export function renderPresentation(input: { visited: PresentedProperty; rooms: readonly Shot[]; matches: readonly PresentedMatch[]; action: string }): string {
  const rooms = input.rooms
    .map(
      (r) =>
        `<fieldset class="piece"><legend>${escapeHtml(r.label)}</legend><div class="gestes">` +
        ROOM_VERDICTS.map((v) => `<label><input type="radio" name="${escapeHtml(r.key)}" value="${v}" required><span>${VERDICT_LABEL[v]}</span></label>`).join('') +
        `</div></fieldset>`,
    )
    .join('');
  const matches =
    input.matches.length > 0
      ? `<section aria-labelledby="autres"><h2 id="autres">Ces biens répondent aussi à votre recherche</h2><div class="autres">` +
        input.matches
          .map(
            (m, i) =>
              `<article class="bien bloc" aria-labelledby="m${i + 1}">${propertyBlock(m, `m${i + 1}`, 'h3')}<ul class="raisons">${m.reasons.map((x) => `<li>${escapeHtml(x)}</li>`).join('')}</ul></article>`,
          )
          .join('') +
        `</div></section>`
      : '';
  return (
    `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<meta name="robots" content="noindex"><meta name="referrer" content="no-referrer"><meta name="theme-color" content="${THEME_COLOR}">` +
    `<title>Votre visite</title><style>${CSS}</style></head>` +
    `<body><header class="tete"><p class="marque">AIMMO</p></header><div class="frise" aria-hidden="true"></div><h1 class="visuellement-cache">Votre visite</h1><main>` +
    `<section class="bien" aria-labelledby="visite">${propertyBlock(input.visited, 'visite', 'h2')}</section>` +
    `<section aria-labelledby="noter"><h2 id="noter">Votre avis, pièce par pièce</h2>` +
    `<form class="notes-pieces" method="post" action="${escapeHtml(input.action)}">${rooms}<button type="submit">Donner mon avis</button></form></section>` +
    `${matches}</main></body></html>`
  );
}

/** La feuille de style de la page, retirée avant la relecture. */
const STYLE_SHEET = new RegExp(`<${'style'}>[\\s\\S]*?</${'style'}>`, 'g');

/** Les mots d'un nom, accents et casse ignorés, coupés sur tout ce qui n'est ni lettre ni chiffre : « Victor. »,
 * « Marc-Victor » donnent « victor ». Les mots de moins de 3 lettres ne nomment personne seuls. */
const wordsOf = (text: string): string[] => plain(text).split(/[^\p{L}\d]+/u).filter((w) => w.length >= 3);

/**
 * Ce que la page trahirait d'un dossier : un mot d'un nom connu, une coordonnée ou une note, tels qu'ils y sont rangés.
 * La page est lue comme elle s'affiche (balises retirées, entités rendues), et ses attributs aussi. Rend la liste de ce
 * qui a été trouvé, vide si rien [R279].
 */
export function confidentialIn(html: string, secrets: { names: readonly string[]; values: readonly string[] }): string[] {
  const page = html.replace(STYLE_SHEET, ' ');
  const attributes = [...page.matchAll(/="([^"]*)"/g)].map((m) => m[1]!).join(' ');
  const text = plain(`${visibleText(page)} ${visibleText(attributes)}`);
  const words = new Set(wordsOf(text));
  const flat = text.replace(/[\s.\-\u00a0\u202f]/g, '');
  const found: string[] = [];
  for (const n of secrets.names) for (const w of wordsOf(n)) if (words.has(w)) found.push(w);
  for (const v of secrets.values) {
    const x = plain(v).trim();
    if (x.length >= 4 && text.includes(x)) found.push(x);
    const digits = x.replace(/[^\d]/g, '');
    if (digits.length >= 8 && flat.includes(digits)) found.push(digits);
    // Un numéro rangé au format international se lit aussi au format national, et l'inverse : « +33 6 11… » comme
    // « 06 11… ». Les 9 derniers chiffres suffisent à le reconnaître sous l'un ou l'autre.
    else if (digits.length >= 9 && flat.includes(digits.slice(-9))) found.push(digits);
  }
  return [...new Set(found)];
}

const REASON: Record<string, { met: string; tolerated: string }> = {
  kind: { met: 'Le type de bien que vous cherchez', tolerated: 'Le type de bien que vous cherchez' },
  commune: { met: 'Dans une commune que vous cherchez', tolerated: 'Dans une commune que vous cherchez' },
  budget: { met: 'Dans votre budget', tolerated: 'Un peu au-dessus de votre budget' },
  surface: { met: 'La surface que vous cherchez', tolerated: 'Un peu plus petit que la surface cherchée' },
  rooms: { met: 'Le nombre de pièces que vous cherchez', tolerated: 'Une pièce de moins que cherché' },
  bedrooms: { met: 'Le nombre de chambres que vous cherchez', tolerated: 'Une chambre de moins que cherché' },
};

/** Les raisons montrées à l'acquéreur : chaque critère rempli ou toléré, sans aucun chiffre de sa recherche. */
export function reasonsOf(m: BuyerMatch, search: BuyerSearch): string[] {
  const asked: Record<string, boolean> = {
    kind: search.propertyKinds.length > 0,
    commune: search.communes.length > 0,
    budget: search.budgetMaxEur !== null,
    surface: search.surfaceMinM2 !== null,
    rooms: search.roomsMin !== null,
    bedrooms: search.bedroomsMin !== null,
  };
  return m.checks.filter((c) => c.state !== 'unmet' && asked[c.criterion]).map((c) => REASON[c.criterion]![c.state === 'met' ? 'met' : 'tolerated']);
}

/** L'empreinte SHA-256 d'un texte, en hexadécimal. */
async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Les notes, contrôlées : chaque pièce de la liste, et elle seule, avec une note de la liste fermée [R280]. */
export function checkRatings(rooms: readonly Shot[], raw: unknown): { ok: true; ratings: RoomRatings } | { ok: false; code: string } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ok: false, code: 'bad_ratings' };
  const r = raw as Record<string, unknown>;
  const keys = rooms.map((x) => x.key);
  const given = Object.keys(r);
  if (given.some((k) => !keys.includes(k))) return { ok: false, code: 'unknown_room' };
  if (keys.some((k) => !(k in r))) return { ok: false, code: 'missing_room' };
  if (given.some((k) => !(ROOM_VERDICTS as readonly unknown[]).includes(r[k]))) return { ok: false, code: 'bad_verdict' };
  // Dans l'ordre de la liste : la même note donne toujours le même contenu.
  return { ok: true, ratings: Object.fromEntries(keys.map((k) => [k, r[k] as RoomVerdict])) };
}

/** L'intérêt tiré des notes seules, par une règle écrite [R281]. */
export function interestOf(ratings: RoomRatings): Interest {
  const values = Object.values(ratings);
  const liked = values.filter((v) => v === 'aime').length;
  const disliked = values.filter((v) => v === 'non').length;
  if (liked === 0) return 'aucun';
  if (disliked === 0 && liked * 3 >= values.length * 2) return 'fort';
  return liked > disliked ? 'moyen' : 'faible';
}

/**
 * Le compte rendu tiré des notes, par le code seul : les pièces aimées en points forts, les pièces pas aimées en
 * réserves, l'intérêt par la règle écrite ; jamais « prêt à faire une offre », qu'un geste ne dit pas [R281].
 */
export function reportFromRatings(rooms: readonly Shot[], ratings: RoomRatings): VisitReport {
  const label = (k: string): string => rooms.find((r) => r.key === k)?.label ?? k;
  const keys = rooms.map((r) => r.key).filter((k) => k in ratings);
  const strengths = keys.filter((k) => ratings[k] === 'aime').map(label);
  const reservations = keys.filter((k) => ratings[k] === 'non').map(label);
  const middle = keys.filter((k) => ratings[k] === 'moyen').map(label);
  const opinion =
    `Le visiteur a noté chaque pièce à la fin de la visite. ` +
    (middle.length > 0 ? `Avis moyen sur : ${middle.join(', ')}.` : 'Aucune pièce jugée moyenne.');
  // Au plus 5 entrées de chaque, comme tout compte rendu (T06) : au-delà, les pièces sont regroupées, aucune n'est perdue.
  return { opinion, strengths: grouped(strengths), reservations: grouped(reservations), interest: interestOf(ratings), readyToOffer: false };
}

/** Les pièces en au plus 5 entrées, dans l'ordre de la visite, sans en perdre une. */
export function grouped(labels: readonly string[], max = 5): string[] {
  if (labels.length <= max) return [...labels];
  const size = Math.ceil(labels.length / max);
  const out: string[] = [];
  for (let i = 0; i < labels.length; i += size) out.push(labels.slice(i, i + size).join(', '));
  return out;
}

/** La dictée rangée avec le compte rendu : les notes elles-mêmes, écrites par le code, jamais par une IA. */
export function ratingsText(rooms: readonly Shot[], ratings: RoomRatings): string {
  return rooms
    .filter((r) => r.key in ratings)
    .map((r) => `${r.label} : ${VERDICT_LABEL[ratings[r.key]!].toLowerCase()}.`)
    .join(' ');
}

interface StoredRatings {
  rooms: Shot[];
  ratings: RoomRatings;
  outcome: RatingOutcome;
  hash: string;
}

interface VisitRow {
  network_id: string;
  property_id: string;
  project_id: string;
  person_id: string;
  agent_id: string;
}

export interface ModePresentationOptions {
  now?: () => Date;
  /** Les annonces publiées du réseau ; `Referencement.published` par défaut. */
  listings?: { published(networkId: string): Promise<PublishedListing[]> };
  /** La porte de toute diffusion ; `Diffusion` de D05 par défaut [R42]. */
  diffusion?: DiffusionGate;
  /** Le compte rendu de visite (T06), par où le compte rendu validé part au vendeur. */
  comptesRendus?: ComptesRendus;
  /** L'adresse où la page envoie les notes. */
  ratingAction?: (appointmentId: string) => string;
}

export class ModePresentation {
  private readonly now: () => Date;
  private readonly fiche: FicheUnique;
  private readonly listings: { published(networkId: string): Promise<PublishedListing[]> };
  private readonly diffusion: DiffusionGate;
  private readonly rapprochement: Rapprochement;

  constructor(
    private readonly db: SqlDatabase,
    acces: Acces,
    private readonly journal: JournalStore,
    private readonly visites: Visites,
    private readonly options: ModePresentationOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.fiche = new FicheUnique(db, new FicheClient(db, { now: this.now }), { now: this.now });
    this.listings = options.listings ?? new Referencement(db, journal, { now: this.now });
    this.diffusion = options.diffusion ?? new Diffusion(db, acces, journal, { now: this.now });
    this.rapprochement = new Rapprochement(db, this.fiche, this.diffusion, journal, { now: this.now });
  }

  private actor(viewer: Viewer): string {
    return `${String(viewer.role)}:${viewer.userId}`;
  }

  private async visit(viewer: Viewer, appointmentId: string): Promise<{ ok: true; v: VisitRow } | PresentationRefusal> {
    if (typeof appointmentId !== 'string' || appointmentId === '') return { ok: false, rule: null, code: 'unknown' };
    // La visite, pour qui voit la fiche de l'acquéreur en entier : la lecture est au journal [R16].
    const access = await this.visites.accessVisit(viewer, appointmentId);
    if (!access.ok) return access;
    const v = await this.db.first<VisitRow>(
      `SELECT v.network_id, v.property_id, v.project_id, v.person_id, v.agent_id FROM visits v WHERE v.appointment_id = ?`,
      [appointmentId],
    );
    if (!v || v.network_id !== viewer.networkId) return { ok: false, rule: null, code: 'unknown' };
    return { ok: true, v };
  }

  /** Les noms et coordonnées connus du dossier d'un bien : chaque mandant de ses mandats, fiches réunies comprises. */
  private async secretsOf(networkId: string, propertyId: string): Promise<{ names: string[]; values: string[] }> {
    const owners = await this.db.all<{ person_id: string }>(
      `SELECT person_id FROM mandates WHERE network_id = ? AND property_id = ?
       UNION SELECT pp.person_id FROM project_properties x JOIN projects pp ON pp.id = x.project_id WHERE x.network_id = ? AND x.property_id = ? AND x.role = 'owned'`,
      [networkId, propertyId, networkId, propertyId],
    );
    const names: string[] = [];
    const values: string[] = [];
    for (const o of owners) {
      const view = await this.fiche.view(o.person_id);
      for (const m of view.members) for (const n of [m.first_name, m.last_name]) if (typeof n === 'string' && n.trim() !== '') names.push(n);
      for (const i of view.identifiers) values.push(i.value);
    }
    // Les notes des projets du dossier : celui qui possède le bien, et celui de chaque mandat.
    const notes = await this.db.all<{ note: string | null }>(
      `SELECT pp.note FROM project_properties x JOIN projects pp ON pp.id = x.project_id WHERE x.network_id = ? AND x.property_id = ? AND x.role = 'owned'
       UNION SELECT pp.note FROM mandates m JOIN projects pp ON pp.id = m.project_id WHERE m.network_id = ? AND m.property_id = ?`,
      [networkId, propertyId, networkId, propertyId],
    );
    for (const n of notes) if (typeof n.note === 'string' && n.note.trim() !== '') values.push(n.note);
    const register = await this.db.all<{ number: string }>('SELECT number FROM mandate_register WHERE network_id = ? AND property_id = ?', [networkId, propertyId]);
    for (const r of register) values.push(r.number);
    return { names, values };
  }

  /** Les noms, coordonnées et notes de la visite elle-même : l'acquéreur, l'agent, ce que l'agent a écrit. */
  private async visitSecrets(appointmentId: string, v: VisitRow): Promise<{ names: string[]; values: string[] }> {
    const buyer = await this.fiche.view(v.person_id);
    const names = buyer.members.flatMap((m) => [m.first_name, m.last_name]).filter((n): n is string => typeof n === 'string' && n.trim() !== '');
    const values = buyer.identifiers.map((i) => i.value);
    const notes = await this.db.all<{ body: string }>('SELECT body FROM visit_field_notes WHERE appointment_id = ?', [appointmentId]);
    const report = await this.db.first<{ dictation: string }>('SELECT dictation FROM visit_reports WHERE appointment_id = ?', [appointmentId]);
    const project = await this.db.first<{ note: string | null }>('SELECT note FROM projects WHERE id = ?', [v.project_id]);
    const projectNote = typeof project?.note === 'string' && project.note.trim() !== '' ? [project.note] : [];
    return { names, values: [...values, ...notes.map((n) => n.body), ...(report ? [report.dictation] : []), ...projectNote] };
  }

  private async search(projectId: string): Promise<BuyerSearch | null> {
    const row = await this.db.first<BuyerSearchRow>('SELECT * FROM buyer_searches WHERE project_id = ? ORDER BY version DESC LIMIT 1', [projectId]);
    // Le secteur privé de la recherche compte aussi ici ; un projet au seul secteur a une recherche vide (AU073).
    const area = await areaOfProject(this.db, projectId);
    if (!row) return area ? { ...EMPTY_SEARCH, propertyKinds: [], communes: [], features: [], requiredFeatures: [], area } : null;
    return area ? { ...toVersion(row).search, area } : toVersion(row).search;
  }

  private async reference(networkId: string, propertyId: string): Promise<string | null> {
    return (await this.db.first<{ reference: string }>('SELECT reference FROM properties WHERE id = ? AND network_id = ?', [propertyId, networkId]))?.reference ?? null;
  }

  private presented(l: PublishedListing, reference: string): PresentedProperty {
    return { propertyId: l.propertyId, reference, title: l.title, priceEur: l.priceEur, mentions: l.mentions, photo: l.photo };
  }

  /** Les biens du réseau qui répondent à la recherche, dans l'ordre écrit du rapprochement, sauf ceux déjà exclus [R51, R42]. */
  private async matchingListings(
    networkId: string,
    listings: PublishedListing[],
    search: BuyerSearch | null,
    skip: ReadonlySet<string>,
  ): Promise<{ listing: PublishedListing; reference: string; match: BuyerMatch; reasons: string[] }[]> {
    if (!search) return [];
    const at = this.now();
    const out: { listing: PublishedListing; reference: string; match: BuyerMatch; reasons: string[] }[] = [];
    for (const l of listings) {
      if (skip.has(l.propertyId) || l.state !== 'en_vente' || l.propertyStatus !== 'available') continue;
      const p = await this.db.first<Property>('SELECT * FROM properties WHERE id = ? AND network_id = ?', [l.propertyId, networkId]);
      if (!p) continue;
      const m = matchBuyer(await this.rapprochement.propertyForMatch(p), search);
      if (m.status === 'miss') continue;
      if (!(await this.diffusion.canDiffuse(networkId, l.propertyId, at)).allowed) continue;
      out.push({ listing: l, reference: p.reference, match: m, reasons: reasonsOf(m, search) });
    }
    return out.sort(
      (a, b) =>
        Number(a.match.status !== 'match') - Number(b.match.status !== 'match') ||
        a.match.gap - b.match.gap ||
        b.match.featuresMet.length - a.match.featuresMet.length ||
        a.reference.localeCompare(b.reference),
    );
  }

  /**
   * Ouvre le mode présentation d'une visite : le bien visité, ses pièces à noter et les biens qui répondent à la
   * recherche de l'acquéreur, tirés des seules annonces publiées, relus avant d'être rendus [R279].
   */
  async open(viewer: Viewer, appointmentId: string): Promise<{ ok: true; presentation: Presentation } | PresentationRefusal> {
    const found = await this.visit(viewer, appointmentId);
    if (!found.ok) return found;
    const v = found.v;
    const at = this.now();
    const appt = await this.db.first<{ status: string }>('SELECT status FROM appointments WHERE id = ?', [appointmentId]);
    if (!appt || appt.status === 'cancelled') return { ok: false, rule: null, code: 'cancelled' };
    const listings = await this.listings.published(v.network_id);
    const mine = listings.find((l) => l.propertyId === v.property_id);
    if (!mine || (mine.state !== 'en_vente' && mine.state !== 'sous_offre')) return { ok: false, rule: 'R279', code: 'not_published' };
    if (!(await this.diffusion.canDiffuse(v.network_id, v.property_id, at)).allowed) return { ok: false, rule: 'R42', code: 'not_diffusable' };
    const reference = await this.reference(v.network_id, v.property_id);
    const p = await this.db.first<Property>('SELECT * FROM properties WHERE id = ? AND network_id = ?', [v.property_id, v.network_id]);
    if (!reference || !p) return { ok: false, rule: null, code: 'unknown' };
    const visited = this.presented(mine, reference);
    const rooms = shotPlan(p.kind, p.rooms);
    const visitSecrets = await this.visitSecrets(appointmentId, v);
    const ownSecrets = await this.secretsOf(v.network_id, v.property_id);
    const action = this.options.ratingAction?.(appointmentId) ?? `/app/visites/${encodeURIComponent(appointmentId)}/presentation/notes`;
    const sourcesOf = (x: PresentedProperty): string[] => [x.title, x.mentions, euros(x.priceEur), x.reference, x.photo?.overlay ?? ''];
    const roomSources = rooms.map((r) => r.label);
    const alone = renderPresentation({ visited, rooms, matches: [], action });
    const visitedLeak = [...confidentialIn(alone, ownSecrets), ...confidentialIn(alone, visitSecrets)];
    if (visitedLeak.length > 0) {
      await appendEvent(this.journal, { type: 'presentation.refusee', actor: this.actor(viewer), subject: `visit:${appointmentId}`, data: { rule: 'R279', code: 'confidentiel' } }, this.now);
      return { ok: false, rule: 'R279', code: 'confidential' };
    }
    if (unsourcedFigures(visibleText(alone), [...sourcesOf(visited), ...roomSources]).length > 0) return { ok: false, rule: 'R279', code: 'invented_figure' };
    // Les biens déjà visités par ce projet ne sont pas reproposés.
    const visitedBefore = await this.db.all<{ property_id: string }>('SELECT property_id FROM visits WHERE project_id = ?', [v.project_id]);
    const skip = new Set([v.property_id, ...visitedBefore.map((x) => x.property_id)]);
    const candidates = await this.matchingListings(v.network_id, listings, await this.search(v.project_id), skip);
    const matches: PresentedMatch[] = [];
    const leftOut: Presentation['leftOut'] = [];
    const shownSecrets: { names: string[]; values: string[] }[] = [];
    for (const c of candidates) {
      if (matches.length >= PRESENTATION_MAX_MATCHES) {
        leftOut.push({ propertyId: c.listing.propertyId, reason: 'au_dela' });
        continue;
      }
      const m: PresentedMatch = { ...this.presented(c.listing, c.reference), reasons: c.reasons };
      const one = renderPresentation({ visited, rooms, matches: [m], action });
      const secrets = await this.secretsOf(v.network_id, m.propertyId);
      if ([secrets, ownSecrets, visitSecrets].some((x) => confidentialIn(one, x).length > 0)) {
        leftOut.push({ propertyId: m.propertyId, reason: 'confidentiel' });
        continue;
      }
      if (unsourcedFigures(visibleText(one), [...sourcesOf(visited), ...sourcesOf(m), ...roomSources]).length > 0) {
        leftOut.push({ propertyId: m.propertyId, reason: 'chiffre_invente' });
        continue;
      }
      matches.push(m);
      shownSecrets.push(secrets);
    }
    const html = renderPresentation({ visited, rooms, matches, action });
    // Toute la page se relit encore contre chaque dossier montré, celui du bien visité et la visite elle-même [R279].
    if ([ownSecrets, visitSecrets, ...shownSecrets].some((x) => confidentialIn(html, x).length > 0)) throw new Error('Mode présentation : une donnée du dossier dans la page.');
    // Toute la page se relit à la fin : seuls les annonces publiées et les pièces du bien.
    const allowed = [...sourcesOf(visited), ...matches.flatMap(sourcesOf), ...roomSources];
    if (unsourcedFigures(visibleText(html), allowed).length > 0) throw new Error('Mode présentation : un chiffre sans source.');
    await appendEvent(
      this.journal,
      { type: 'presentation.ouverte', actor: this.actor(viewer), subject: `visit:${appointmentId}`, data: { rule: 'R279', biens: matches.length } },
      this.now,
    );
    return { ok: true, presentation: { html, visited, rooms, matches, leftOut } };
  }

  /**
   * Range les notes de l'acquéreur, une seule fois par visite, à partir du début de la visite et jusqu'à 24 heures
   * après sa fin [R280]. Rejouées à l'identique, elles rendent la même réponse ; un autre contenu est refusé.
   */
  async rate(viewer: Viewer, appointmentId: string, raw: unknown): Promise<{ ok: true; already: boolean; outcome: RatingOutcome } | PresentationRefusal> {
    const found = await this.visit(viewer, appointmentId);
    if (!found.ok) return found;
    const v = found.v;
    const appt = await this.db.first<{ status: string; start_at: string; end_at: string }>('SELECT status, start_at, end_at FROM appointments WHERE id = ?', [appointmentId]);
    if (!appt || appt.status === 'cancelled') return { ok: false, rule: 'R280', code: 'cancelled' };
    const at = this.now();
    if (at.getTime() < Date.parse(appt.start_at)) return { ok: false, rule: 'R280', code: 'too_early' };
    // Déjà notée : la même note rend la même réponse, celle du premier envoi, contre la liste des pièces d'alors.
    const known = await this.stored(appointmentId);
    if (known) return this.replay(known, raw);
    const p = await this.db.first<Property>('SELECT * FROM properties WHERE id = ? AND network_id = ?', [v.property_id, v.network_id]);
    if (!p) return { ok: false, rule: null, code: 'unknown' };
    const rooms = shotPlan(p.kind, p.rooms).map((r) => ({ key: r.key, label: r.label, advice: r.advice }));
    const checked = checkRatings(rooms, raw);
    if (!checked.ok) return { ok: false, rule: 'R280', code: checked.code };
    if (at.getTime() > Date.parse(appt.end_at) + RATING_WINDOW_HOURS * 3_600_000) return { ok: false, rule: 'R280', code: 'too_late' };
    const content = JSON.stringify(checked.ratings);
    const report = reportFromRatings(rooms, checked.ratings);
    const outcome: RatingOutcome = { report, next: await this.nextProposal(v, report.interest) };
    const inserted = await this.db.run(
      'INSERT OR IGNORE INTO presentation_ratings (appointment_id, network_id, property_id, rooms, ratings, outcome, content_hash, recorded_by, rated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [appointmentId, v.network_id, v.property_id, JSON.stringify(rooms), content, JSON.stringify(outcome), await sha256(content), this.actor(viewer), at.toISOString()],
    );
    if (inserted.changes !== 1) {
      // Un autre envoi a gagné entre la lecture et l'écriture : seule la même note rend sa réponse.
      const won = await this.stored(appointmentId);
      return won ? this.replay(won, raw) : { ok: false, rule: 'R280', code: 'already_rated' };
    }
    await appendEvent(this.journal, { type: 'presentation.notee', actor: this.actor(viewer), subject: `visit:${appointmentId}`, data: { rule: 'R280', pieces: rooms.length } }, this.now);
    return { ok: true, already: false, outcome };
  }

  private async replay(known: StoredRatings, raw: unknown): Promise<{ ok: true; already: true; outcome: RatingOutcome } | PresentationRefusal> {
    const checked = checkRatings(known.rooms, raw);
    if (!checked.ok || (await sha256(JSON.stringify(checked.ratings))) !== known.hash) return { ok: false, rule: 'R280', code: 'already_rated' };
    return { ok: true, already: true, outcome: known.outcome };
  }

  /** Les notes rangées, avec la liste des pièces notées et la réponse du premier envoi, figées ensemble [R280]. */
  private async stored(appointmentId: string): Promise<StoredRatings | null> {
    const row = await this.db.first<{ rooms: string; ratings: string; outcome: string; content_hash: string }>(
      'SELECT rooms, ratings, outcome, content_hash FROM presentation_ratings WHERE appointment_id = ?',
      [appointmentId],
    );
    if (!row) return null;
    return { rooms: JSON.parse(row.rooms) as Shot[], ratings: JSON.parse(row.ratings) as RoomRatings, outcome: JSON.parse(row.outcome) as RatingOutcome, hash: row.content_hash };
  }

  /** Le compte rendu et la prochaine proposition tirés des notes, tels qu'au premier envoi : rien n'est rangé ni envoyé ici [R281]. */
  async outcomeOf(viewer: Viewer, appointmentId: string): Promise<{ ok: true; outcome: RatingOutcome } | PresentationRefusal> {
    const found = await this.visit(viewer, appointmentId);
    if (!found.ok) return found;
    const known = await this.stored(appointmentId);
    if (!known) return { ok: false, rule: 'R281', code: 'not_rated' };
    return { ok: true, outcome: known.outcome };
  }

  /**
   * La prochaine proposition, par une règle écrite [R281] : intérêt fort, une contre-visite du bien ; sinon le premier
   * bien en vente du réseau qui répond à la recherche et que le projet n'a pas visité ; sinon rien à proposer.
   */
  private async nextProposal(v: VisitRow, interest: Interest): Promise<NextProposal> {
    const reference = (await this.reference(v.network_id, v.property_id)) ?? '';
    if (interest === 'fort') return { kind: 'contre_visite', propertyId: v.property_id, reference, reasons: ['Intérêt fort : chaque pièce notée, au moins deux sur trois aimées, aucune pas aimée.'] };
    const visitedBefore = await this.db.all<{ property_id: string }>('SELECT property_id FROM visits WHERE project_id = ?', [v.project_id]);
    const skip = new Set([v.property_id, ...visitedBefore.map((x) => x.property_id)]);
    const listings = await this.listings.published(v.network_id);
    const [first] = await this.matchingListings(v.network_id, listings, await this.search(v.project_id), skip);
    if (!first) return { kind: 'aucune', reasons: ['Aucun autre bien en vente du réseau ne répond aujourd’hui à la recherche.'] };
    return { kind: 'bien', propertyId: first.listing.propertyId, reference: first.reference, reasons: first.reasons };
  }

  /**
   * L'agent valide d'un geste le compte rendu tiré des notes : il est rangé comme compte rendu de la visite (T06), avec
   * les notes en guise de dictée, puis part au vendeur par le contrôle central, sans le nom de l'acquéreur [R281, R52].
   * Rien ne part sans ce geste.
   */
  async validateReport(viewer: Viewer, appointmentId: string): Promise<{ ok: true; delivery: string; rule: string | null } | PresentationRefusal> {
    const comptes = this.options.comptesRendus;
    if (!comptes) return { ok: false, rule: null, code: 'no_report_service' };
    const found = await this.visit(viewer, appointmentId);
    if (!found.ok) return found;
    const known = await this.stored(appointmentId);
    if (!known) return { ok: false, rule: 'R281', code: 'not_rated' };
    // Le compte rendu des notes telles qu'elles ont été données, sur la liste des pièces d'alors.
    const report = known.outcome.report;
    const text = ratingsText(known.rooms, known.ratings);
    const existing = await this.db.first<{ status: string; dictation: string }>('SELECT status, dictation FROM visit_reports WHERE appointment_id = ?', [appointmentId]);
    // Un compte rendu dicté par l'agent (T06) n'est jamais remplacé par les notes : l'agent le valide lui-même.
    if (existing && existing.dictation !== text) return { ok: false, rule: null, code: 'dictated_report' };
    if (!existing) {
      const drafted = await comptes.dictate(viewer, appointmentId, text, { withoutWriter: true });
      if (!drafted.ok) return drafted;
    }
    const sent = await comptes.validate(viewer, appointmentId, report);
    if (sent.ok) await appendEvent(this.journal, { type: 'presentation.compte_rendu_valide', actor: this.actor(viewer), subject: `visit:${appointmentId}`, data: { rule: 'R281' } }, this.now);
    return sent;
  }
}
