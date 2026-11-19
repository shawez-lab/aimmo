/**
 * Texte par portail et légendes des photos (HX39) [R476, R477, R478].
 *
 * Comme Apimo et Hektor : un texte différent par portail, des titres de photos générés. Jamais vu :
 * - seul le texte change d'un portail à l'autre : le prix, les mentions et les photos restent ceux de la version publiée
 *   (P04), au caractère près, et le texte d'un portail porte exactement les mêmes nombres et les mêmes lettres de classe
 *   que le texte publié, dans le même ordre, chaque phrase sourcée par la fiche comme l'annonce (P03) [R476] ;
 * - chaque photo reçoit une légende écrite par le code, utile aussi aux personnes malvoyantes (texte de remplacement) :
 *   sa place, ce qu'elle montre dans une liste fermée dite par l'agent, et seulement si la fiche le porte, l'étage tiré de
 *   la fiche, et l'aménagement virtuel ou la retouche dits ; rien d'autre n'est affirmé [R478].
 *
 * Décidé, lecture prudente :
 * - l'IA, derrière une interface, ne voit ni chiffre ni lettre de classe : des repères, comme les traductions (HX05) ;
 *   une IA qui perd ou déplace un repère, ou dont le texte ne passe pas le contrôle, est refusée et rien n'est gardé ;
 * - un texte compte seulement validé par l'agent du bien, pour la version publiée du moment : une nouvelle version le
 *   rend caduc, et le portail reçoit alors le texte publié [R477] ; il est relu par le contrôle à chaque rendu, contre la
 *   fiche du moment : une fiche changée qui ne le porte plus le fait retomber sur le texte publié ;
 * - aucun prix dans le texte d'un portail : il n'est pas un fait de la fiche, le contrôle le refuse ; le prix vient de la
 *   version publiée seule ;
 * - ce que montre une photo est dit par l'agent, jamais deviné : sans choix, la légende dit seulement sa place ;
 * - la publication (P04), l'export (P07) et la diffusion surveillée (HX38) ne changent pas : `portalListings` part du
 *   flux de HX38 et n'y change que le titre et le texte, et ajoute les légendes ; le branchement au Worker, les routes et
 *   l'écran sont des tâches de la voie 1.
 */
import type { Acces } from '../acces/acces.ts';
import type { Viewer } from '../acces/droits.ts';
import { agentState } from '../acces/etat-agent.ts';
import { traceListing, type ListingFacts } from '../annonces/annonce-sourcee.ts';
import { Annonces } from '../annonces/annonces.ts';
import type { MediaEdit, PropertySheet } from '../annonces/fiche-bien.ts';
import type { PublishedMedia } from '../annonces/medias.ts';
import type { ListingPayload } from '../annonces/publication.ts';
import { unmaskFigures } from '../annonces/traductions.ts';
import { runBatch, type SqlDatabase, type SqlStatement } from '../db/sql.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import { LOCAL_EDIT_LABELS, type LocalEditKind } from '../studio/certificats.ts';
import { DiffusionSurveillee } from './surveillance.ts';

// ——— Contrôle du texte d'un portail [R476] ———

export type PortalTextProblem =
  | 'texte_vide'
  | 'trop_long'
  | 'chiffres_differents'
  | 'classes_differentes'
  | 'nombre_en_lettres'
  | 'lien_ou_mail'
  | 'phrase_sans_source';

const MAX_TITLE = 160;
const MAX_BODY = 4000;
/** Un nombre écrit à la française : milliers séparés par une espace (ordinaire, fine ou insécable), ou décimale. */
/** Le signe collé devant compte avec le nombre : « -3e étage » n'est jamais « 3e étage ». */
const NUMBER = /(?:(?<![\p{L}\p{N}])[-−+])?(?:\d{1,3}(?:[ \u202F\u00A0]\d{3})+(?![\d])|\d+(?:[.,]\d+)?)/gu;
/** Une lettre de classe seule, majuscule ou minuscule ; « a » minuscule seulement après un mot du diagnostic (« il a » est un verbe). */
const CLASS_LETTER = /(?<![\p{L}\p{N}])[A-G](?![\p{L}\p{N}])/giu;
const ANY_DIGIT = /\p{Nd}/u;
const ASCII_DIGIT = /[0-9]/;
const LINK_OR_MAIL = /@|https?:|www\./i;
/**
 * Nombres en lettres, lus sans accents : la liste de l'annonce sourcée (P03), ordinaux compris. « un », « une » et
 * « neuf » sont surtout des mots ordinaires : ils ne comptent que devant une unité, comme dans l'annonce.
 */
const NUMBER_WORDS = new Set([
  'deux', 'trois', 'quatre', 'cinq', 'six', 'sept', 'huit', 'dix', 'onze', 'douze', 'treize', 'quatorze', 'quinze', 'seize', 'vingt', 'vingts', 'trente', 'quarante',
  'cinquante', 'soixante', 'septante', 'octante', 'nonante', 'cent', 'cents', 'mille', 'million', 'millions', 'milliers', 'centaine', 'centaines', 'dizaine', 'dizaines', 'douzaine',
  'premier', 'premiere', 'premiers', 'premieres', 'deuxieme', 'second', 'seconde', 'troisieme', 'quatrieme', 'cinquieme', 'sixieme', 'septieme', 'huitieme', 'neuvieme', 'dixieme',
  'onzieme', 'douzieme', 'vingtieme', 'centieme', 'millieme', 'double', 'triple', 'quadruple', 'demi', 'demie', 'moitie', 'quart', 'tiers',
]);
const NUMBER_WORDS_NEED_UNIT = new Set(['un', 'une', 'neuf']);
const WORD_UNIT_AFTER = /^\s*(?:pieces?|chambres?|etages?|niveaux?|places?|m²|m2|metres?|ans?|salles?|lots?)(?![\p{L}\p{N}])/iu;
const unaccent = (t: string): string => t.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[’`]/g, "'");

function hasNumberWord(text: string): boolean {
  const plain = unaccent(text);
  for (const m of plain.matchAll(/\p{L}+/gu)) {
    const w = m[0];
    if (NUMBER_WORDS.has(w)) return true;
    if (NUMBER_WORDS_NEED_UNIT.has(w) && WORD_UNIT_AFTER.test(plain.slice((m.index ?? 0) + w.length))) return true;
  }
  // Les mots composés : « vingt-deux », « dix-huitième ».
  return /(?<!\p{L})(?:dix|vingt|trente|quarante|cinquante|soixante)-\p{L}+/u.test(plain);
}

/** Ce qu'un nombre compte, quand le mot qui le suit le dit : « 3 pièces », « 62 m² », « 3e étage ». */
const COUNTED_AFTER = /^[ \u202F\u00A0]*(pieces?|chambres?|etages?|niveaux?|places?|m²|m2|metres?|ans?|salles?|lots?|euros?|€|%)(?![\p{L}\p{N}])/u;
/** Ce que mesure un nombre, quand sa phrase le dit avant lui : « Logement de 62 m² » n'est jamais « Terrain de 62 m² ». */
const MEASURED = /(?<!\p{L})(logement|appartement|maison|studio|immeuble|local|terrain|parcelle|jardin|surface)(?!\p{L})/gu;

/**
 * Chaque nombre avec ce qui le rattache à son champ, dans l'ordre : sa valeur et son signe ; les lettres collées
 * (« 3e ») ; ce qu'il compte (le mot qui le suit, d'une liste fermée) ; ce que mesure sa phrase avant lui (le dernier
 * nom d'une liste fermée). « Au 3e étage sur 5 » n'est jamais « 3 étages, au 5e étage », ni la surface du logement
 * celle du terrain [R476].
 */
const numbersOf = (s: string): string[] =>
  [...s.matchAll(NUMBER)].map((m) => {
    const at = m.index ?? 0;
    const after = unaccent(s.slice(at + m[0].length));
    const glued = /^\p{L}*/u.exec(after)?.[0] ?? '';
    const counted = glued === '' ? (COUNTED_AFTER.exec(after)?.[1] ?? '') : (COUNTED_AFTER.exec(after.slice(glued.length))?.[1] ?? '');
    const before = unaccent(s.slice(0, at));
    const sentence = before.slice(Math.max(before.lastIndexOf('.'), before.lastIndexOf('!'), before.lastIndexOf('?'), before.lastIndexOf('\n'), before.lastIndexOf(';')) + 1);
    const measured = [...sentence.matchAll(MEASURED)].pop()?.[1] ?? '';
    const unit = counted.replace(/s$/, '').replace(/^m2$/, 'm²').replace(/^euro$/, '€');
    return `${m[0].replace(/[\u202F\u00A0]/g, ' ').replace('−', '-')}|${glued}|${unit}|${measured}`;
  });
const DIAGNOSTIC_BEFORE = /(?:classe|énergie|energie|climat|dpe|ges|étiquette|etiquette)\s*:?\s*$/iu;
/** Les lettres de classe d'un texte, avec leur place : « a » minuscule seulement juste après un mot du diagnostic. */
const classMatches = (s: string): { at: number; letter: string }[] =>
  [...s.matchAll(CLASS_LETTER)].filter((m) => m[0] !== 'a' || DIAGNOSTIC_BEFORE.test(s.slice(0, m.index))).map((m) => ({ at: m.index ?? 0, letter: m[0] }));
/**
 * Le champ d'une lettre de classe : le dernier mot du diagnostic qui la précède dans sa phrase (énergie ou climat) ;
 * « Classe énergie D. Classe climat C. » n'est jamais « Classe climat D. Classe énergie C. ».
 */
function classField(s: string, at: number): 'energie' | 'climat' | '' {
  const before = unaccent(s.slice(0, at));
  const sentence = before.slice(Math.max(before.lastIndexOf('.'), before.lastIndexOf('!'), before.lastIndexOf('?'), before.lastIndexOf('\n')) + 1);
  const words = [...sentence.matchAll(/(?<!\p{L})(energie|energetique|dpe|climat|ges|gaz a effet de serre)(?!\p{L})/gu)];
  const last = words[words.length - 1]?.[1];
  if (last === undefined) return '';
  return last === 'climat' || last === 'ges' || last === 'gaz a effet de serre' ? 'climat' : 'energie';
}
const classesOf = (s: string): string[] => classMatches(s).map((m) => `${classField(s, m.at)}:${m.letter.toUpperCase()}`);

/** Le texte avec des repères à la place des nombres et des classes, minuscules comprises ; la table pour les remettre. */
export function maskPortalText(text: string, values: string[]): string {
  const spots = [...[...text.matchAll(NUMBER)].map((m) => ({ at: m.index ?? 0, raw: m[0] })), ...classMatches(text).map((m) => ({ at: m.at, raw: m.letter }))].sort((x, y) => x.at - y.at);
  let out = '';
  let from = 0;
  for (const spot of spots) {
    if (spot.at < from) continue;
    out += text.slice(from, spot.at);
    values.push(spot.raw);
    out += `⟦${values.length}⟧`;
    from = spot.at + spot.raw.length;
  }
  return out + text.slice(from);
}
const sameSequence = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

function fieldProblems(source: string, text: string, max: number): PortalTextProblem[] {
  if (text.trim() === '') return ['texte_vide'];
  const out: PortalTextProblem[] = [];
  if (text.length > max) out.push('trop_long');
  if ([...text].some((c) => ANY_DIGIT.test(c) && !ASCII_DIGIT.test(c)) || !sameSequence(numbersOf(source), numbersOf(text))) out.push('chiffres_differents');
  if (!sameSequence(classesOf(source), classesOf(text))) out.push('classes_differentes');
  if (hasNumberWord(text)) out.push('nombre_en_lettres');
  if (LINK_OR_MAIL.test(text)) out.push('lien_ou_mail');
  return out;
}

/**
 * Le contrôle du texte d'un portail [R476] : dans le titre et dans le texte, les mêmes nombres écrits pareil et les mêmes
 * lettres de classe que le texte publié, dans le même ordre ; aucun nombre en lettres, aucun lien ; et chaque phrase
 * sourcée par la fiche comme l'annonce publiée (P03) : aucun prix, aucune adresse, aucun fait que la fiche ne porte pas.
 */
export function controlPortalText(
  source: { title: string; body: string },
  text: { title: string; body: string },
  facts: ListingFacts | readonly ListingFacts[],
): { ok: boolean; title: PortalTextProblem[]; body: PortalTextProblem[] } {
  const title = fieldProblems(source.title, text.title, MAX_TITLE);
  const body = fieldProblems(source.body, text.body, MAX_BODY);
  const all: readonly ListingFacts[] = Array.isArray(facts) ? facts : [facts as ListingFacts];
  if (title.length === 0 && body.length === 0 && (all.length === 0 || !all.every((f) => traceListing(text.title, text.body, f).ok))) body.push('phrase_sans_source');
  return { ok: title.length === 0 && body.length === 0, title, body };
}

/** L'IA qui écrit le texte d'un portail : elle reçoit le texte publié avec des repères à la place des chiffres et des classes. */
export interface PortalTextWriter {
  write(input: { portal: string; title: string; body: string }): Promise<{ title: string; body: string }>;
}

// ——— Légendes [R478] ———

/** Ce qu'une photo peut montrer, dans une liste fermée : chacun n'est dit que si la fiche le porte. */
export const PHOTO_SUBJECTS = [
  'piece_principale', 'chambre', 'cuisine', 'salle_de_bain', 'toilettes', 'entree', 'facade',
  'balcon', 'terrasse', 'jardin', 'cour', 'terrain', 'stationnement', 'ascenseur',
] as const;
export type PhotoSubject = (typeof PHOTO_SUBJECTS)[number];

/**
 * Le dernier sujet dit de chaque photo d'un bien : les choix d'avant AU114 (`diffusion_photo_subjects`) et ceux d'après
 * (`diffusion_photo_descriptions`, liste élargie), le plus récent faisant foi.
 */
const LATEST_SUBJECTS = `SELECT media_ref, subject FROM (
  SELECT media_ref, subject, at, 1 AS src, id FROM diffusion_photo_subjects WHERE property_id = ?
  UNION ALL SELECT media_ref, subject, at, 2 AS src, id FROM diffusion_photo_descriptions WHERE property_id = ?
) a WHERE NOT EXISTS (
  SELECT 1 FROM (
    SELECT media_ref, at, 1 AS src, id FROM diffusion_photo_subjects WHERE property_id = ?
    UNION ALL SELECT media_ref, at, 2 AS src, id FROM diffusion_photo_descriptions WHERE property_id = ?
  ) b WHERE b.media_ref = a.media_ref AND (b.at > a.at OR (b.at = a.at AND (b.src > a.src OR (b.src = a.src AND b.id > a.id))))
)`;

/** La fiche porte-t-elle ce que la photo est dite montrer ? */
export function subjectInSheet(subject: PhotoSubject, f: ListingFacts): boolean {
  switch (subject) {
    case 'piece_principale':
      return (f.rooms ?? 0) > 0;
    case 'chambre':
      return (f.bedrooms ?? 0) > 0;
    // Toute habitation a sa cuisine, sa salle d'eau, ses toilettes, son entrée et sa façade (AU114).
    case 'cuisine':
    case 'salle_de_bain':
    case 'toilettes':
    case 'entree':
    case 'facade':
      return f.kind === 'home' || f.kind === 'building';
    case 'balcon':
    case 'terrasse':
    case 'jardin':
    case 'cour':
      return f.outdoor.includes(subject);
    case 'terrain':
      return f.landM2 !== null && f.landM2 > 0;
    case 'stationnement':
      return (f.parkingSpaces ?? 0) > 0;
    case 'ascenseur':
      return f.elevator === true;
  }
}

const floorText = (floor: number | null): string | null => (floor === null ? null : floor === 0 ? 'au rez-de-chaussée' : `au ${floor === 1 ? '1er' : `${floor}e`} étage`);
const fr = (n: number): string => String(n).replace('.', ',');

/** Ce que la photo montre, en mots, tiré de la fiche seule. */
function subjectText(subject: PhotoSubject, f: ListingFacts): string {
  const outdoorFloor = (name: string) => {
    const at = floorText(f.floor);
    return at && f.kind !== 'land' && f.floor !== 0 ? `${name}, ${at}` : name;
  };
  switch (subject) {
    case 'piece_principale':
      return f.rooms === 1 ? 'la pièce principale' : `une des ${f.rooms} pièces principales`;
    case 'chambre':
      return f.bedrooms === 1 ? 'la chambre' : `une des ${f.bedrooms} chambres`;
    case 'cuisine':
      return 'la cuisine';
    case 'salle_de_bain':
      return 'une salle d’eau';
    case 'toilettes':
      return 'les toilettes';
    case 'entree':
      return 'l’entrée';
    case 'facade':
      return 'la façade';
    case 'balcon':
      return outdoorFloor('le balcon');
    case 'terrasse':
      return outdoorFloor('la terrasse');
    case 'jardin':
      return 'le jardin';
    case 'cour':
      return 'la cour';
    case 'terrain':
      return `le terrain de ${fr(f.landM2 ?? 0)} m²`;
    case 'stationnement':
      return f.parkingSpaces === 1 ? 'la place de stationnement' : `une des ${f.parkingSpaces} places de stationnement`;
    case 'ascenseur':
      return 'l’ascenseur de l’immeuble';
  }
}

/**
 * La légende d'une photo [R478] : sa place parmi les photos, ce qu'elle montre seulement si l'agent l'a dit et que la
 * fiche le porte, l'aménagement virtuel ou la retouche dits. Rien d'autre : ni couleur, ni lumière, ni qualité.
 */
export function photoCaption(input: { index: number; total: number; subject: PhotoSubject | null; facts: ListingFacts; edit: MediaEdit | null; overlay: string | null; retouches?: readonly LocalEditKind[] }): string {
  const place = `Photo ${input.index} sur ${input.total}`;
  const subject = input.subject !== null && subjectInSheet(input.subject, input.facts) ? subjectText(input.subject, input.facts) : null;
  const parts = [subject === null ? `${place} du bien.` : `${place} : ${subject}.`];
  if (input.overlay !== null || input.edit === 'amenagement_virtuel') parts.push('Aménagement virtuel : le mobilier et la décoration montrés sont ajoutés à l’image, ils ne sont pas dans le bien.');
  else if (input.edit === 'lumiere_cadrage') parts.push('Lumière et cadrage retouchés.');
  // Les retouches locales déclarées au certificat (HX40), dites telles quelles [R490].
  const retouches = input.retouches ?? [];
  if (retouches.length > 0) parts.push(`Photo retouchée : ${[...new Set(retouches)].map((k) => LOCAL_EDIT_LABELS[k].toLowerCase()).join(', ')}.`);
  return parts.join(' ');
}

// ——— Le service ———

export interface CaptionedMedia extends PublishedMedia {
  /** La légende, et le texte de remplacement de l'image ; null pour une vidéo. */
  caption: string | null;
}

/** Ce qu'un portail reçoit : la version publiée, son titre et son texte propres au portail quand ils sont validés. */
export interface PortalPayload extends Omit<ListingPayload, 'media'> {
  media: CaptionedMedia[];
  /** Le texte validé pour ce portail, ou null : le texte publié. */
  portalTextId: string | null;
}

export interface PortalText {
  id: string;
  portal: string;
  listingSeq: number;
  title: string;
  body: string;
  origin: 'ia' | 'agent';
  validatedAt: string | null;
}

type Refusal = { ok: false; rule: 'R16'; code: string };
type Problem =
  | { ok: false; rule: 'R476'; code: 'texte_refuse'; title: PortalTextProblem[]; body: PortalTextProblem[] }
  | { ok: false; rule: 'R476'; code: 'ia_refusee' }
  | { ok: false; rule: 'R477'; code: 'version_depassee' | 'deja_valide' | 'inconnu' | 'pas_publiee' | 'portail_inconnu' }
  | { ok: false; rule: 'R478'; code: 'photo_inconnue' | 'sujet_inconnu' | 'absent_de_la_fiche' };

interface VersionRow {
  seq: number;
  payload: string;
}

export class TextesPortails {
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly annonces: Annonces;
  private readonly surveillance: DiffusionSurveillee;

  constructor(
    private readonly db: SqlDatabase,
    private readonly acces: Acces,
    private readonly journal: JournalStore,
    options: { now?: () => Date; newId?: () => string; writer?: PortalTextWriter } = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => crypto.randomUUID());
    this.writer = options.writer ?? null;
    this.annonces = new Annonces(db, acces, journal, { now: this.now });
    this.surveillance = new DiffusionSurveillee(db, acces, journal, { now: this.now, newId: this.newId });
  }

  private readonly writer: PortalTextWriter | null;

  private actor(viewer: Viewer): string {
    return `${String(viewer.role)}:${viewer.userId}`;
  }

  private async refuse(viewer: Viewer, subject: string | null, code: string): Promise<Refusal> {
    await appendEvent(this.journal, { type: 'acces.refuse', actor: this.actor(viewer), subject, data: { rule: 'R16', role: String(viewer.role), kind: 'texte_portail', code } }, this.now);
    return { ok: false, rule: 'R16', code };
  }

  /** L'agent du bien, en activité : lui seul écrit, valide et dit ce que montrent les photos [R477, R478]. */
  private async owner(viewer: Viewer, propertyId: unknown): Promise<Refusal | { ok: true; propertyId: string; networkId: string }> {
    if (viewer.role !== 'agent') return this.refuse(viewer, null, 'role');
    if (typeof propertyId !== 'string' || !propertyId) return this.refuse(viewer, null, 'unknown');
    const subject = `property:${propertyId}`;
    if ((await agentState(this.db, viewer.networkId, viewer.userId, this.now())) !== 'actif') return this.refuse(viewer, subject, 'agent_inactive');
    const read = await this.acces.readProperty(viewer, propertyId);
    if (!read.ok) return { ok: false, rule: 'R16', code: read.code };
    if (read.value.network_id !== viewer.networkId) return this.refuse(viewer, subject, 'network');
    if (read.view !== 'full' || read.value.agent_id !== viewer.userId) return this.refuse(viewer, subject, 'pas_son_bien');
    return { ok: true, propertyId, networkId: viewer.networkId };
  }

  private async latestVersion(networkId: string, propertyId: string): Promise<VersionRow | null> {
    return (await this.db.first<VersionRow>('SELECT seq, payload FROM listing_versions WHERE network_id = ? AND property_id = ? ORDER BY seq DESC LIMIT 1', [networkId, propertyId])) ?? null;
  }

  private async knownPortal(networkId: string, code: unknown): Promise<string | null> {
    if (typeof code !== 'string') return null;
    return (await this.surveillance.portals(networkId)).find((p) => p.code === code)?.code ?? null;
  }

  /** Le texte publié, la fiche du moment, et le numéro de la version : ce contre quoi tout texte de portail est contrôlé. */
  private async basis(networkId: string, propertyId: string): Promise<{ seq: number; source: { title: string; body: string }; facts: ListingFacts[]; payload: Omit<ListingPayload, 'version'> } | null> {
    const v = await this.latestVersion(networkId, propertyId);
    if (!v) return null;
    const payload = JSON.parse(v.payload) as Omit<ListingPayload, 'version'>;
    if (!payload.title || !payload.body) return null;
    const f = await this.factsOf(propertyId, Number(v.seq));
    if (!f) return null;
    return { seq: Number(v.seq), source: { title: payload.title, body: payload.body }, facts: [f.current, f.published], payload };
  }

  /**
   * Les faits de la fiche du moment, et ceux de la fiche d'où vient la version publiée (celle de son annonce validée) :
   * un texte doit tenir pour les deux ; une légende parle des photos publiées, avec la fiche publiée [R476, R478].
   */
  private async factsOf(propertyId: string, seq: number): Promise<{ current: ListingFacts; published: ListingFacts; publishedSheet: PropertySheet | null } | null> {
    const f = await this.annonces.factsFor(propertyId);
    if (!f) return null;
    const row = await this.db.first<{ data: string }>(
      `SELECT s.data FROM listing_versions v JOIN listing_drafts d ON d.id = v.draft_id
       JOIN property_sheets s ON s.property_id = v.property_id AND s.version = d.sheet_version
       WHERE v.property_id = ? AND v.seq = ?`,
      [propertyId, seq],
    );
    const sheet = row ? (JSON.parse(row.data) as PropertySheet) : null;
    const c = sheet?.characteristics;
    const published: ListingFacts = sheet
      ? {
          ...f.facts,
          bedrooms: c?.bedrooms ?? null,
          floor: c?.floor ?? null,
          floorsTotal: c?.floorsTotal ?? null,
          buildYear: c?.buildYear ?? null,
          heating: c?.heating ?? null,
          outdoor: c?.outdoor ?? [],
          landM2: c?.landM2 ?? null,
          parkingSpaces: c?.parkingSpaces ?? null,
          elevator: c?.elevator ?? null,
          energyClass: sheet.energy?.energyClass ?? null,
          climateClass: sheet.energy?.climateClass ?? null,
        }
      : { ...f.facts, bedrooms: null, floor: null, floorsTotal: null, buildYear: null, heating: null, outdoor: [], landM2: null, parkingSpaces: null, elevator: null, energyClass: null, climateClass: null };
    return { current: f.facts, published, publishedSheet: sheet };
  }

  private async store(o: { propertyId: string; networkId: string }, viewer: Viewer, portal: string, seq: number, text: { title: string; body: string }, origin: 'ia' | 'agent', validated: boolean): Promise<string> {
    const id = this.newId();
    const at = this.now().toISOString();
    const statements: SqlStatement[] = [
      {
        sql: `INSERT INTO diffusion_portal_texts (id, network_id, property_id, portal, listing_seq, title, body, origin, created_by, created_at)
              SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM listing_versions w WHERE w.property_id = ? AND w.seq > ?)`,
        params: [id, o.networkId, o.propertyId, portal, seq, text.title, text.body, origin, this.actor(viewer), at, o.propertyId, seq],
      },
    ];
    if (validated) statements.push({ sql: 'INSERT INTO diffusion_portal_text_validations (text_id, by_actor, at) SELECT id, ?, ? FROM diffusion_portal_texts WHERE id = ?', params: [this.actor(viewer), at, id] });
    await runBatch(this.db, statements);
    return id;
  }

  /**
   * L'agent du bien écrit lui-même le texte d'un portail, pour la version publiée du moment [R476, R477]. Il passe le
   * contrôle, puis compte aussitôt : l'agent l'a écrit, il le valide en l'écrivant.
   */
  async write(viewer: Viewer, input: { propertyId: unknown; portal: unknown; title: unknown; body: unknown }): Promise<{ ok: true; textId: string } | Refusal | Problem> {
    const o = await this.owner(viewer, input.propertyId);
    if (!o.ok) return o;
    const portal = await this.knownPortal(o.networkId, input.portal);
    if (!portal) return { ok: false, rule: 'R477', code: 'portail_inconnu' };
    const b = await this.basis(o.networkId, o.propertyId);
    if (!b) return { ok: false, rule: 'R477', code: 'pas_publiee' };
    const text = { title: typeof input.title === 'string' ? input.title.trim() : '', body: typeof input.body === 'string' ? input.body.trim() : '' };
    const c = controlPortalText(b.source, text, b.facts);
    if (!c.ok) return { ok: false, rule: 'R476', code: 'texte_refuse', title: c.title, body: c.body };
    const textId = await this.store(o, viewer, portal, b.seq, text, 'agent', true);
    if (!(await this.db.first('SELECT 1 FROM diffusion_portal_texts WHERE id = ?', [textId]))) return { ok: false, rule: 'R477', code: 'version_depassee' };
    await appendEvent(this.journal, { type: 'diffusion.texte_portail_valide', actor: this.actor(viewer), subject: `property:${o.propertyId}`, data: { rule: 'R477', portal, seq: b.seq, origin: 'agent' } }, this.now);
    return { ok: true, textId };
  }

  /**
   * L'IA propose le texte d'un portail [R476] : elle reçoit le texte publié avec des repères, jamais un chiffre ni une
   * classe ; le code remet les valeurs, puis contrôle. Refusée, rien n'est gardé. Gardé, il attend la validation.
   */
  async draft(viewer: Viewer, input: { propertyId: unknown; portal: unknown }): Promise<{ ok: true; textId: string; title: string; body: string } | Refusal | Problem> {
    const o = await this.owner(viewer, input.propertyId);
    if (!o.ok) return o;
    const portal = await this.knownPortal(o.networkId, input.portal);
    if (!portal) return { ok: false, rule: 'R477', code: 'portail_inconnu' };
    const b = await this.basis(o.networkId, o.propertyId);
    if (!b) return { ok: false, rule: 'R477', code: 'pas_publiee' };
    if (!this.writer) return { ok: false, rule: 'R476', code: 'ia_refusee' };
    const titleValues: string[] = [];
    const bodyValues: string[] = [];
    const masked = { title: maskPortalText(b.source.title, titleValues), body: maskPortalText(b.source.body, bodyValues) };
    let out: { title: string; body: string };
    try {
      out = await this.writer.write({ portal, ...masked });
    } catch {
      await appendEvent(this.journal, { type: 'diffusion.texte_portail_ia_refuse', actor: this.actor(viewer), subject: `property:${o.propertyId}`, data: { rule: 'R476', portal, reason: 'panne' } }, this.now);
      return { ok: false, rule: 'R476', code: 'ia_refusee' };
    }
    const order = (n: number) => Array.from({ length: n }, (_, i) => i + 1);
    const title = typeof out?.title === 'string' ? unmaskFigures(out.title.trim(), titleValues, order(titleValues.length)) : null;
    const body = typeof out?.body === 'string' ? unmaskFigures(out.body.trim(), bodyValues, order(bodyValues.length)) : null;
    const text = title !== null && body !== null ? { title, body } : null;
    if (!text || !controlPortalText(b.source, text, b.facts).ok) {
      await appendEvent(this.journal, { type: 'diffusion.texte_portail_ia_refuse', actor: this.actor(viewer), subject: `property:${o.propertyId}`, data: { rule: 'R476', portal, reason: text ? 'controle' : 'reperes' } }, this.now);
      return { ok: false, rule: 'R476', code: 'ia_refusee' };
    }
    const textId = await this.store(o, viewer, portal, b.seq, text, 'ia', false);
    if (!(await this.db.first('SELECT 1 FROM diffusion_portal_texts WHERE id = ?', [textId]))) return { ok: false, rule: 'R477', code: 'version_depassee' };
    return { ok: true, textId, ...text };
  }

  /** L'agent du bien valide un texte proposé par l'IA, seulement pour la version publiée du moment, et s'il passe encore le contrôle [R477]. */
  async validate(viewer: Viewer, textIdInput: unknown): Promise<{ ok: true } | Refusal | Problem> {
    if (typeof textIdInput !== 'string') return { ok: false, rule: 'R477', code: 'inconnu' };
    const row = await this.db.first<{ id: string; property_id: string; network_id: string; portal: string; listing_seq: number; title: string; body: string }>(
      'SELECT id, property_id, network_id, portal, listing_seq, title, body FROM diffusion_portal_texts WHERE id = ?',
      [textIdInput],
    );
    if (!row) return { ok: false, rule: 'R477', code: 'inconnu' };
    const o = await this.owner(viewer, row.property_id);
    if (!o.ok) return o;
    if (row.network_id !== o.networkId) return this.refuse(viewer, `property:${row.property_id}`, 'network');
    const b = await this.basis(o.networkId, o.propertyId);
    if (!b || b.seq !== Number(row.listing_seq)) return { ok: false, rule: 'R477', code: 'version_depassee' };
    const c = controlPortalText(b.source, { title: row.title, body: row.body }, b.facts);
    if (!c.ok) return { ok: false, rule: 'R476', code: 'texte_refuse', title: c.title, body: c.body };
    const at = this.now().toISOString();
    // La validation et la condition « pas de version plus récente » dans la même instruction ; une seule par texte.
    const r = await this.db.run(
      `INSERT OR IGNORE INTO diffusion_portal_text_validations (text_id, by_actor, at)
       SELECT ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM listing_versions w WHERE w.property_id = ? AND w.seq > ?)`,
      [row.id, this.actor(viewer), at, row.property_id, Number(row.listing_seq)],
    );
    if (r.changes === 0) {
      const done = await this.db.first('SELECT 1 FROM diffusion_portal_text_validations WHERE text_id = ?', [row.id]);
      return { ok: false, rule: 'R477', code: done ? 'deja_valide' : 'version_depassee' };
    }
    await appendEvent(this.journal, { type: 'diffusion.texte_portail_valide', actor: this.actor(viewer), subject: `property:${row.property_id}`, data: { rule: 'R477', portal: row.portal, seq: Number(row.listing_seq), origin: 'ia' } }, this.now);
    return { ok: true };
  }

  /** Les textes du bien pour la version publiée du moment, portail par portail, pour l'écran de l'agent. */
  async texts(viewer: Viewer, propertyId: unknown): Promise<{ ok: true; texts: PortalText[] } | Refusal> {
    const o = await this.owner(viewer, propertyId);
    if (!o.ok) return o;
    const v = await this.latestVersion(o.networkId, o.propertyId);
    if (!v) return { ok: true, texts: [] };
    const rows = await this.db.all<{ id: string; portal: string; listing_seq: number; title: string; body: string; origin: 'ia' | 'agent'; validated_at: string | null }>(
      `SELECT t.id, t.portal, t.listing_seq, t.title, t.body, t.origin, va.at AS validated_at FROM diffusion_portal_texts t
       LEFT JOIN diffusion_portal_text_validations va ON va.text_id = t.id
       WHERE t.property_id = ? AND t.listing_seq = ? ORDER BY t.portal, t.created_at, t.rowid`,
      [o.propertyId, Number(v.seq)],
    );
    return { ok: true, texts: rows.map((r) => ({ id: r.id, portal: r.portal, listingSeq: Number(r.listing_seq), title: r.title, body: r.body, origin: r.origin, validatedAt: r.validated_at })) };
  }

  /** Le texte validé d'un portail pour une version, relu par le contrôle contre la fiche du moment, ou null [R477]. */
  private async validatedText(propertyId: string, portal: string, seq: number, source: { title: string; body: string }, facts: readonly ListingFacts[]): Promise<{ id: string; title: string; body: string } | null> {
    const r = await this.db.first<{ id: string; title: string; body: string }>(
      `SELECT t.id, t.title, t.body FROM diffusion_portal_texts t JOIN diffusion_portal_text_validations va ON va.text_id = t.id
       WHERE t.property_id = ? AND t.portal = ? AND t.listing_seq = ? ORDER BY va.at DESC, va.rowid DESC LIMIT 1`,
      [propertyId, portal, seq],
    );
    if (!r) return null;
    return controlPortalText(source, { title: r.title, body: r.body }, facts).ok ? r : null;
  }

  // ------------------------------------------------------------------ Photos

  /**
   * Les légendes des photos de la dernière version publiée, pour la page et la fiche du bien (AU114) : les mêmes que
   * celles des portails [R478]. Rien de publié : aucune.
   */
  async publishedCaptions(networkId: string, propertyId: string): Promise<Map<string, string>> {
    const v = await this.latestVersion(networkId, propertyId);
    if (!v) return new Map();
    const payload = JSON.parse(v.payload) as Omit<ListingPayload, 'version'>;
    const facts = await this.factsOf(propertyId, Number(v.seq));
    if (!facts) return new Map();
    const media = await this.captioned(propertyId, payload.media ?? [], facts);
    return new Map(media.filter((m) => m.caption !== null).map((m) => [m.ref, m.caption!] as const));
  }

  /** Pour l'agent du bien : chaque photo de la fiche avec ce qu'elle est dite montrer, et les sujets que la fiche permet [R478]. */
  async photoSubjects(viewer: Viewer, propertyId: unknown): Promise<{ ok: true; value: { photos: { ref: string; subject: PhotoSubject | null }[]; allowed: PhotoSubject[] } } | Refusal> {
    const o = await this.owner(viewer, propertyId);
    if (!o.ok) return o;
    const sheet = await this.sheet(o.propertyId);
    const f = await this.annonces.factsFor(o.propertyId);
    const rows = await this.db.all<{ media_ref: string; subject: string }>(
      LATEST_SUBJECTS,
      [o.propertyId, o.propertyId, o.propertyId, o.propertyId],
    );
    const said = new Map(rows.map((r) => [r.media_ref, r.subject] as const));
    const allowed = f ? PHOTO_SUBJECTS.filter((s) => subjectInSheet(s, f.facts)) : [];
    const photos = (sheet?.media ?? [])
      .filter((m) => m.kind === 'photo')
      .map((m) => {
        const s = said.get(m.ref);
        return { ref: m.ref, subject: s && s !== 'aucun' && (allowed as string[]).includes(s) ? (s as PhotoSubject) : null };
      });
    return { ok: true, value: { photos, allowed } };
  }

  /** L'agent du bien dit ce que montre une photo de la fiche, dans la liste fermée, et seulement si la fiche le porte [R478]. */
  async describePhoto(viewer: Viewer, input: { propertyId: unknown; ref: unknown; subject: unknown }): Promise<{ ok: true } | Refusal | Problem> {
    const o = await this.owner(viewer, input.propertyId);
    if (!o.ok) return o;
    const subject = input.subject === null ? 'aucun' : input.subject;
    if (subject !== 'aucun' && !(PHOTO_SUBJECTS as readonly unknown[]).includes(subject)) return { ok: false, rule: 'R478', code: 'sujet_inconnu' };
    const sheet = await this.sheet(o.propertyId);
    if (typeof input.ref !== 'string' || !sheet?.media.some((m) => m.ref === input.ref && m.kind === 'photo')) return { ok: false, rule: 'R478', code: 'photo_inconnue' };
    const f = await this.annonces.factsFor(o.propertyId);
    if (subject !== 'aucun' && (!f || !subjectInSheet(subject as PhotoSubject, f.facts))) return { ok: false, rule: 'R478', code: 'absent_de_la_fiche' };
    // La légende se lit aussi contre la fiche publiée : un sujet qu'elle ne porte pas encore n'apparaît qu'à la publication suivante.
    await this.db.run('INSERT INTO diffusion_photo_descriptions (id, network_id, property_id, media_ref, subject, by_actor, at) VALUES (?, ?, ?, ?, ?, ?, ?)', [
      this.newId(),
      o.networkId,
      o.propertyId,
      input.ref,
      subject as string,
      this.actor(viewer),
      this.now().toISOString(),
    ]);
    await appendEvent(this.journal, { type: 'diffusion.photo_decrite', actor: this.actor(viewer), subject: `property:${o.propertyId}`, data: { rule: 'R478', subject: subject as string } }, this.now);
    return { ok: true };
  }

  private async sheet(propertyId: string): Promise<PropertySheet | null> {
    const row = await this.db.first<{ data: string }>('SELECT data FROM property_sheets WHERE property_id = ? ORDER BY version DESC LIMIT 1', [propertyId]);
    return row ? (JSON.parse(row.data) as PropertySheet) : null;
  }

  /** Les photos et vidéos d'une version, chaque photo avec sa légende [R478]. */
  private async captioned(propertyId: string, media: readonly PublishedMedia[], facts: { current: ListingFacts; published: ListingFacts; publishedSheet: PropertySheet | null }): Promise<CaptionedMedia[]> {
    // Les retouches déclarées des photos publiées : celles de la fiche d'où vient la version, jamais d'une fiche plus récente.
    const edits = new Map((facts.publishedSheet?.media ?? []).map((m) => [m.ref, m.edit] as const));
    const rows = await this.db.all<{ media_ref: string; subject: string }>(
      LATEST_SUBJECTS,
      [propertyId, propertyId, propertyId, propertyId],
    );
    const subjects = new Map(rows.filter((r) => r.subject !== 'aucun').map((r) => [r.media_ref, r.subject as PhotoSubject] as const));
    // Les retouches locales déclarées au certificat de chaque photo [R490].
    const certs = await this.db.all<{ result_ref: string; local_edits: string }>('SELECT result_ref, local_edits FROM photo_certificates WHERE property_id = ?', [propertyId]);
    const retouchesOf = new Map(certs.map((c) => [c.result_ref, (JSON.parse(c.local_edits) as { kind: LocalEditKind }[]).map((e) => e.kind)] as const));
    const total = media.filter((m) => m.kind === 'photo').length;
    let index = 0;
    return media.map((m) => {
      if (m.kind !== 'photo') return { ...m, caption: null };
      index++;
      // Le sujet doit tenir dans la fiche du moment ; la légende l'écrit avec la fiche publiée, qui le vérifie aussi.
      const said = subjects.get(m.ref) ?? null;
      const subject = said !== null && subjectInSheet(said, facts.current) ? said : null;
      return { ...m, caption: photoCaption({ index, total, subject, facts: facts.published, edit: edits.get(m.ref) ?? null, overlay: m.overlay, retouches: retouchesOf.get(m.ref) ?? [] }) };
    });
  }

  // ------------------------------------------------------------------ Ce que reçoit chaque portail

  /** Une version publiée pour un portail : son titre et son texte s'ils sont validés pour cette version, les légendes ; le reste tel quel [R476]. */
  private async forPortal(propertyId: string, portal: string, payload: ListingPayload): Promise<PortalPayload> {
    const facts = await this.factsOf(propertyId, payload.version);
    const media = facts ? await this.captioned(propertyId, payload.media, facts) : payload.media.map((m) => ({ ...m, caption: null }));
    const base: PortalPayload = { ...payload, media, portalTextId: null };
    if (!facts || !payload.title || !payload.body) return base;
    const t = await this.validatedText(propertyId, portal, payload.version, { title: payload.title, body: payload.body }, [facts.current, facts.published]);
    return t ? { ...base, title: t.title, body: t.body, portalTextId: t.id } : base;
  }

  /** La dernière version publiée d'un bien telle qu'un portail la reçoit [R476, R477, R478]. */
  async portalPayload(networkId: string, propertyId: string, portal: string): Promise<PortalPayload | null> {
    const v = await this.latestVersion(networkId, propertyId);
    if (!v) return null;
    const payload = { ...(JSON.parse(v.payload) as Omit<ListingPayload, 'version'>), version: Number(v.seq) };
    return this.forPortal(propertyId, portal, payload);
  }

  /** Le flux d'un portail : celui de la diffusion surveillée (HX38), avec le texte du portail et les légendes [R476, R478]. */
  async portalListings(networkId: string, portal: string): Promise<PortalPayload[]> {
    const listings = await this.surveillance.portalListings(networkId, portal);
    const out: PortalPayload[] = [];
    for (const l of listings) {
      const p = await this.db.first<{ id: string }>('SELECT id FROM properties WHERE network_id = ? AND reference = ?', [networkId, l.reference]);
      if (p) out.push(await this.forPortal(p.id, portal, l));
    }
    return out;
  }
}
