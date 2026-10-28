/**
 * État des lieux d'entrée dans l'application (M15, W07) [R106, R17, R16].
 *
 * L'agent le fait sur son téléphone, pièce par pièce : éléments et leur état, photos (par leur référence), observations
 * dictées ; puis les relevés des compteurs, les clés remises et, pour un meublé, l'inventaire du mobilier. Le document
 * est écrit par le code depuis ces données. L'IA, derrière une interface, ne fait que mettre en forme le dicté de chaque
 * pièce : le texte rendu ne doit contenir aucun élément, aucun état, aucun chiffre ni aucune négation absents du dicté,
 * sinon le secours du code (le dicté lui-même, propre) est pris. Elle ne reçoit que le dicté et le nom de la pièce.
 *
 * L'état des lieux ne se fait que sur le bail en vigueur (W06), pour le bailleur et le locataire choisi, lus sous les
 * droits des fiches [R16]. Chaque version est figée ; une correction est une nouvelle version, permise tant que
 * l'état des lieux n'est pas clos. Une signature porte l'empreinte de la version signée : une nouvelle version demande
 * de nouvelles signatures. Il n'est clos qu'avec chaque pièce renseignée et la signature des deux parties ; à la
 * clôture, chaque partie reçoit le même exemplaire, de même empreinte, préparé ici et envoyé par le contrôle central
 * (W10) [R106].
 *
 * Décidé, lecture prudente : un état des lieux est « complet » seulement avec les noms des deux parties, le domicile du
 * bailleur, l'adresse du logement, au moins une pièce, chaque pièce avec au moins un élément et son état, au moins un
 * relevé de compteur et une remise de clés, et, pour un meublé, l'inventaire du mobilier (décret du 30 mars 2016) ; il
 * ne se signe que complet. Le tracé de la signature n'est jamais gardé, seulement son empreinte.
 */
import type { Viewer } from '../acces/droits.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { sha256 } from '../documents/modeles.ts';
import { localTime } from '../envoi/horaires.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import type { BauxLocation, LeaseFileStore, PersonReader } from './bail.ts';
import type { ChoixProprietaire } from './choix.ts';
import { dayInFrench, type LocationRefusal, type MisesEnLocation } from './logement.ts';

export const ELEMENT_STATES = { neuf: 'neuf', bon: 'bon état', usage: 'état d’usage', mauvais: 'mauvais état' } as const;
export type ElementState = keyof typeof ELEMENT_STATES;
export const METER_KINDS = { electricite: 'Électricité', gaz: 'Gaz', eau_froide: 'Eau froide', eau_chaude: 'Eau chaude' } as const;
export type MeterKind = keyof typeof METER_KINDS;
export const PARTIES = ['bailleur', 'locataire'] as const;
export type Party = (typeof PARTIES)[number];

export interface InventoryElement {
  name: string;
  state: ElementState;
}

export interface InventoryRoomInput {
  name: string;
  elements: InventoryElement[];
  dictation?: string | null;
  photos?: string[];
}

export interface InventoryRoom extends InventoryRoomInput {
  /** Les observations mises en forme, et leur origine : l'IA si son texte a passé le contrôle, sinon le secours. */
  text: string | null;
  origin: 'ia' | 'secours' | null;
}

export interface InventoryInput {
  address?: unknown;
  ownerAddress?: unknown;
  rooms?: unknown;
  meters?: unknown;
  keys?: unknown;
  furniture?: unknown;
}

/** La mise en forme du dicté d'une pièce, par l'IA. Elle ne reçoit que le nom de la pièce et le dicté. */
export interface InventoryFormatter {
  format(input: { room: string; dictation: string }): Promise<string>;
}

export interface Inventory {
  inventoryId: string;
  listingId: string;
  version: number;
  mode: 'essai' | 'reel';
  status: 'complet' | 'incomplet';
  missing: string[];
  rooms: InventoryRoom[];
  content: string;
  contentSha256: string;
}

export type InventoryRefusal = Omit<LocationRefusal, 'rule'> & { rule: LocationRefusal['rule'] | 'R105' | 'R106' };
export type InventoryResult<T> = { ok: true; value: T } | InventoryRefusal;

export interface EtatDesLieuxOptions {
  now?: () => Date;
  newId?: () => string;
}

// ---------------------------------------------------------------------------------------------------------------------
// Le contrôle de la mise en forme [R106]
// ---------------------------------------------------------------------------------------------------------------------

/** Éléments d'un logement : chaque groupe réunit les formes d'un même élément. Liste écrite, volontairement large. */
const ELEMENT_WORDS: readonly (readonly string[])[] = [
  ['sol'], ['mur'], ['plafond'], ['porte'], ['fenêtre'], ['volet'], ['radiateur'], ['prise'], ['interrupteur'], ['évier'], ['lavabo'], ['baignoire'],
  ['douche'], ['wc', 'toilette', 'cuvette'], ['robinet', 'robinetterie', 'mitigeur'], ['placard'], ['plinthe'], ['parquet'], ['carrelage'], ['moquette'],
  ['lino', 'linoléum'], ['peinture'], ['papier peint', 'tapisserie'], ['vitre', 'vitrage', 'carreau'], ['serrure', 'verrou'], ['poignée'], ['luminaire', 'lustre', 'applique'],
  ['ampoule'], ['plan de travail'], ['hotte'], ['four'], ['plaque', 'cuisinière'], ['réfrigérateur', 'frigo', 'frigidaire'], ['congélateur'], ['lave-vaisselle'],
  ['lave-linge', 'machine à laver'], ['sèche-linge'], ['micro-ondes'], ['chaudière'], ['ballon', 'chauffe-eau', 'cumulus'], ['miroir'], ['meuble'], ['table'],
  ['chaise'], ['lit', 'sommier'], ['matelas'], ['canapé'], ['armoire', 'penderie'], ['étagère'], ['rideau', 'voilage'], ['store'], ['boîte aux lettres'],
  ['clé', 'clef'], ['compteur'], ['joint'], ['faïence'], ['crédence'], ['escalier'], ['rampe'], ['balcon'], ['terrasse'], ['cave'], ['garage'], ['grenier'],
  ['interphone', 'visiophone'], ['sonnette'], ['détecteur'], ['ventilation', 'vmc', 'aération', 'bouche'], ['cheminée'], ['tableau électrique', 'disjoncteur'],
  ['thermostat'], ['tuyau', 'canalisation', 'évacuation', 'siphon'], ['seuil', 'barre de seuil'], ['moulure', 'corniche'], ['huisserie', 'encadrement', 'chambranle'],
];

/** États et défauts : chaque groupe réunit les formes d'un même état. Liste écrite, volontairement large. */
const STATE_WORDS: readonly (readonly string[])[] = [
  ['neuf', 'neuve'], ['bon', 'bonne'], ['mauvais', 'mauvaise'], ['usage', 'usé', 'usure', 'usagé'], ['abîmé', 'abîme'], ['dégradé', 'dégradation'],
  ['cassé', 'casse', 'brisé'], ['fissuré', 'fissure', 'fêlé', 'fêlure', 'lézarde'], ['rayé', 'rayure'], ['taché', 'tache', 'auréole'], ['sale', 'saleté', 'encrassé'],
  ['propre'], ['endommagé', 'dommage'], ['vétuste', 'vétusté'], ['moisi', 'moisissure'], ['humide', 'humidité'], ['trou', 'troué', 'percé'], ['éclat', 'ébréché'],
  ['écaillé', 'écaillement', 'cloqué', 'cloque'], ['défectueux', 'défaut', 'défaillant'], ['fonctionne', 'fonctionnel', 'marche'], ['hors service', 'en panne', 'panne'],
  ['manquant', 'manque', 'absent', 'absence'], ['excellent', 'parfait'], ['correct'], ['moyen'], ['rénové', 'refait', 'repeint'], ['jauni', 'jaunissement'],
  ['décollé', 'décollement'], ['rouillé', 'rouille'], ['bouché', 'fuite', 'fuit'], ['grippé', 'dur'], ['branlant', 'descellé'], ['calcaire', 'tartre'],
];

/** La négation change le sens d'un constat : elle doit rester à sa place, sinon le secours est pris. */
const NEGATIONS = ['pas', 'sans', 'aucun', 'aucune', 'ni', 'non', 'jamais', 'rien', 'nul', 'nulle'];

/**
 * Les seuls mots que la mise en forme peut ajouter : des mots outils, qui ne portent ni élément, ni état, ni chiffre, ni
 * personne. Tout autre mot du texte rendu doit venir du dicté [R106].
 */
const TOOL_WORDS = new Set([
  'de', 'd', 'du', 'des', 'la', 'le', 'les', 'l', 'un', 'une', 'au', 'aux', 'a', 'avec', 'et', 'ou', 'sur', 'sous', 'pres', 'dans', 'en', 'est', 'sont',
  'ce', 'cet', 'cette', 'ces', 'son', 'sa', 'ses', 'leur', 'leurs', 'qui', 'que', 'y', 'par', 'pour', 'ne', 'n', 'il', 'elle', 'ils', 'elles', 'on',
]);

/** Tout mot qui parlerait de l'IA dans un texte remis aux parties [R06]. */
const AI_WORDS = ['ia', 'intelligence artificielle', 'assistant', 'chatgpt', 'gpt', 'claude', 'algorithme', 'automatique', 'automatiquement', 'robot'];

const NUMBER_WORDS: Readonly<Record<string, string>> = {
  deux: '2', trois: '3', quatre: '4', cinq: '5', six: '6', sept: '7', huit: '8', neuf_: '9', dix: '10', onze: '11', douze: '12', treize: '13',
  quatorze: '14', quinze: '15', seize: '16', vingt: '20', trente: '30', quarante: '40', cinquante: '50', soixante: '60', cent: '100', mille: '1000',
  moitie: '1/2', demi: '1/2', tiers: '1/3', quart: '1/4', double: 'x2', triple: 'x3',
};

function plain(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[’']/g, ' ');
}

function words(text: string): string[] {
  return plain(text).split(/[^a-z0-9]+/).filter((w) => w !== '');
}

/** Une racine grossière : pluriel et féminin ôtés, pour qu'« usées » et « usé » se rejoignent. */
function stem(word: string): string {
  let w = word;
  if (w.length > 3 && /[sx]$/.test(w)) w = w.slice(0, -1);
  while (w.length > 3 && w.endsWith('e')) w = w.slice(0, -1);
  return w;
}

/** Les groupes du vocabulaire présents dans un texte, mot par mot ou par expression. */
function groupsIn(text: string, groups: readonly (readonly string[])[]): Set<number> {
  const ws = words(text).map(stem);
  const joined = ` ${ws.join(' ')} `;
  const found = new Set<number>();
  groups.forEach((forms, i) => {
    for (const f of forms) {
      const fw = words(f).map(stem);
      if (fw.length === 0) continue;
      if (joined.includes(` ${fw.join(' ')} `)) {
        found.add(i);
        break;
      }
    }
  });
  return found;
}

/** Les chiffres d'un texte : nombres écrits en chiffres (virgule ou point), et nombres écrits en lettres. */
function numbersIn(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of plain(text).matchAll(/\d+(?:[.,]\d+)?/g)) out.add(m[0].replace(',', '.').replace(/^0+(?=\d)/, ''));
  for (const w of words(text)) {
    const key = w === 'neuf' ? null : w;
    if (key !== null && Object.prototype.hasOwnProperty.call(NUMBER_WORDS, key)) out.add(NUMBER_WORDS[key]!);
  }
  return out;
}

function has(text: string, list: readonly string[]): boolean {
  const ws = ` ${words(text).join(' ')} `;
  return list.some((l) => ws.includes(` ${words(l).join(' ')} `));
}

export type FormatProblem =
  | 'empty'
  | 'too_long'
  | 'word_added'
  | 'element_added'
  | 'state_added'
  | 'number_added'
  | 'negation_changed'
  | 'order_changed'
  | 'words_changed'
  | 'mentions_ai'
  | 'markup';

/** Les seuls mots qu'une mise en forme peut ajouter ou ôter : articles et liaisons, qui ne changent pas un constat. */
const FORM_WORDS = new Set(['de', 'd', 'du', 'des', 'la', 'le', 'les', 'l', 'au', 'aux', 'à', 'a', 'et', 'est', 'sont', 'avec', 'ce', 'cet', 'cette', 'ces', 'y']);

/** Les mots porteurs d'un texte, dans l'ordre, tels quels (accents gardés) ; les nombres ramenés à leur valeur. */
function meaningful(text: string): string[] {
  return text
    .normalize('NFC')
    .toLocaleLowerCase('fr-FR')
    .replace(/[’']/g, ' ')
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w !== '' && !FORM_WORDS.has(w))
    .map((w) => {
      if (/^\d+$/.test(w)) return `#${w.replace(/^0+(?=\d)/, '')}`;
      if (w === 'un' || w === 'une') return '#1';
      return w !== 'neuf' && Object.prototype.hasOwnProperty.call(NUMBER_WORDS, w) ? `#${NUMBER_WORDS[w]}` : w;
    });
}

/**
 * La suite des marques d'un texte, dans l'ordre : éléments, états, chiffres et négations. La mise en forme doit garder
 * exactement la même suite que le dicté : rien d'ajouté, rien d'ôté, rien d'échangé, aucune négation déplacée.
 */
function marks(text: string): string[] {
  const ws = words(text);
  const stems = ws.map(stem);
  const phrases: { forms: string[][]; mark: string }[] = [];
  ELEMENT_WORDS.forEach((forms, i) => phrases.push({ forms: forms.map((f) => words(f).map(stem)), mark: `E${i}` }));
  STATE_WORDS.forEach((forms, i) => phrases.push({ forms: forms.map((f) => words(f).map(stem)), mark: `S${i}` }));
  // Les expressions les plus longues d'abord : « plan de travail » avant « plan ».
  const all = phrases.flatMap((p) => p.forms.map((f) => ({ f, mark: p.mark }))).sort((a, b) => b.f.length - a.f.length);
  const out: string[] = [];
  for (let i = 0; i < ws.length; ) {
    const w = ws[i]!;
    if (/^\d/.test(w)) {
      out.push(`N${w.replace(/^0+(?=\d)/, '')}`);
      i += 1;
      continue;
    }
    if (w !== 'neuf' && Object.prototype.hasOwnProperty.call(NUMBER_WORDS, w)) {
      out.push(`N${NUMBER_WORDS[w]}`);
      i += 1;
      continue;
    }
    if (NEGATIONS.includes(w)) {
      out.push('NEG');
      i += 1;
      continue;
    }
    const hit = all.find((p) => p.f.length > 0 && p.f.every((x, k) => stems[i + k] === x));
    if (hit) {
      out.push(hit.mark);
      i += hit.f.length;
      continue;
    }
    i += 1;
  }
  return out;
}

/**
 * Le texte de l'IA ne fait que mettre en forme le dicté : chaque mot vient du dicté, hors mots outils ; la suite des
 * éléments, états, chiffres et négations est celle du dicté ; une seule ligne, aucun balisage, rien sur l'IA [R106, R06].
 */
export function checkFormatted(dictation: string, formatted: string): { ok: true } | { ok: false; problems: FormatProblem[] } {
  const problems: FormatProblem[] = [];
  const text = formatted.trim();
  if (text === '') problems.push('empty');
  if (text.length > Math.max(400, dictation.length * 2)) problems.push('too_long');
  if (/[<>{}[\]`*#|\r\n\u2028\u2029]/.test(text)) problems.push('markup');
  const known = new Set(words(dictation).map(stem));
  const numbers = numbersIn(dictation);
  const added = words(text).some((w) => {
    if (TOOL_WORDS.has(w) || known.has(stem(w))) return false;
    const n = /^\d/.test(w) ? w.replace(/^0+(?=\d)/, '') : w !== 'neuf' && Object.prototype.hasOwnProperty.call(NUMBER_WORDS, w) ? NUMBER_WORDS[w]! : null;
    return n === null || !numbers.has(n);
  });
  if (added) problems.push('word_added');
  // Mot à mot et dans l'ordre : hors mots outils, le texte rendu redit exactement les mots du dicté, sans changer un
  // accent, un nombre (« deux » vaut « 2 ») ni un pluriel. Sinon la fidélité n'est pas établie et le secours est pris.
  if (JSON.stringify(meaningful(text)) !== JSON.stringify(meaningful(dictation))) problems.push('words_changed');
  const sub = (a: Set<string> | Set<number>, b: Set<string> | Set<number>) => [...a].every((x) => (b as Set<typeof x>).has(x));
  if (!sub(groupsIn(text, ELEMENT_WORDS), groupsIn(dictation, ELEMENT_WORDS))) problems.push('element_added');
  if (!sub(groupsIn(text, STATE_WORDS), groupsIn(dictation, STATE_WORDS))) problems.push('state_added');
  if (!sub(numbersIn(text), numbers)) problems.push('number_added');
  if (has(text, NEGATIONS) !== has(dictation, NEGATIONS)) problems.push('negation_changed');
  if (JSON.stringify(marks(text)) !== JSON.stringify(marks(dictation))) problems.push('order_changed');
  if (has(text, AI_WORDS) && !has(dictation, AI_WORDS)) problems.push('mentions_ai');
  return problems.length === 0 ? { ok: true } : { ok: false, problems };
}

/** Le secours du code : le dicté lui-même, espaces resserrés, majuscule au début et point à la fin. */
export function fallbackFormatted(dictation: string): string {
  const t = dictation.replace(/\s+/g, ' ').trim();
  if (t === '') return '';
  const s = t.charAt(0).toLocaleUpperCase('fr-FR') + t.slice(1);
  return /[.!?…]$/.test(s) ? s : `${s}.`;
}

// ---------------------------------------------------------------------------------------------------------------------
// La saisie
// ---------------------------------------------------------------------------------------------------------------------

const NAME = /^[\p{L}\p{N} ,.'’()/-]{1,60}$/u;
const ADDRESS = /^[\p{L}\p{N} ,.'’-]{5,160}$/u;
const DICTATION = /^[^<>{}`]{0,4000}$/u;
const METER_INDEX = /^\d{1,9}(?:[.,]\d{1,3})?$/;
const METER_NUMBER = /^[0-9A-Z-]{1,30}$/;
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const PHOTO = new RegExp(`^${UUID}\\.(?:jpg|jpeg|png|webp)$`);
const MAX_ROOMS = 40;
const MAX_ELEMENTS = 60;
const MAX_PHOTOS = 30;
const MAX_LINES = 100;
const MAX_DRAWING = 200_000;

type Parsed<T> = T | { ok: false; rule: null; code: string };
const bad = (code: string) => ({ ok: false as const, rule: null, code });
const isBad = (v: unknown): v is { ok: false; rule: null; code: string } => typeof v === 'object' && v !== null && (v as { ok?: unknown }).ok === false;

function parseList<T>(v: unknown, max: number, code: string, item: (x: Record<string, unknown>) => T | null): Parsed<T[]> {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.length > max) return bad(code);
  const out: T[] = [];
  for (const x of v) {
    if (typeof x !== 'object' || x === null) return bad(code);
    const r = item(x as Record<string, unknown>);
    if (r === null) return bad(code);
    out.push(r);
  }
  return out;
}

const text = (v: unknown, re: RegExp): string | null => (typeof v === 'string' && re.test(v.trim()) ? v.trim() : null);
const state = (v: unknown): ElementState | null => (typeof v === 'string' && Object.prototype.hasOwnProperty.call(ELEMENT_STATES, v) ? (v as ElementState) : null);
const count = (v: unknown, max: number): number | null => (typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= max ? v : null);

interface RoomRow {
  name: string;
  elements: InventoryElement[];
  dictation: string | null;
  photos: string[];
  text: string | null;
  origin: 'ia' | 'secours' | null;
}

interface InventoryRow {
  id: string;
  listing_id: string;
  network_id: string;
  version: number;
  lease_id: string;
  mode: 'essai' | 'reel';
  status: 'complet' | 'incomplet';
  missing: string;
  rooms: string;
  content: string;
  content_sha256: string;
}

const ROW = 'SELECT id, listing_id, network_id, version, lease_id, mode, status, missing, rooms, content, content_sha256 FROM rental_inventories';

export class EtatsDesLieux {
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(
    private readonly db: SqlDatabase,
    private readonly listings: MisesEnLocation,
    private readonly leases: BauxLocation,
    private readonly choices: ChoixProprietaire,
    private readonly files: LeaseFileStore,
    private readonly persons: PersonReader,
    private readonly formatter: InventoryFormatter | null,
    private readonly journal: JournalStore,
    options: EtatDesLieuxOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => crypto.randomUUID());
  }

  private actor(viewer: Viewer): string {
    return `${String(viewer.role)}:${viewer.userId}`;
  }

  private async refuse(viewer: Viewer, subject: string | null, code: string): Promise<InventoryRefusal> {
    await appendEvent(this.journal, { type: 'acces.refuse', actor: this.actor(viewer), subject, data: { rule: 'R16', role: String(viewer.role), kind: 'rental_inventory', code } }, this.now);
    return { ok: false, rule: 'R16', code };
  }

  /** La mise en forme d'une pièce : le texte de l'IA s'il passe le contrôle, sinon le secours [R106]. */
  private async formatRoom(listingId: string, index: number, room: string, dictation: string): Promise<{ text: string; origin: 'ia' | 'secours' }> {
    if (this.formatter) {
      let proposed: string | null = null;
      try {
        const r = await this.formatter.format({ room, dictation });
        proposed = typeof r === 'string' ? r : null;
      } catch {
        proposed = null;
      }
      const checked: { ok: true } | { ok: false; problems: FormatProblem[] } = proposed === null ? { ok: false, problems: ['empty'] } : checkFormatted(dictation, proposed);
      if (checked.ok) return { text: proposed!.trim(), origin: 'ia' };
      // Le texte refusé n'est jamais rangé : seuls la pièce, par son rang, et les codes des problèmes vont au journal [R13].
      await appendEvent(this.journal, { type: 'location.etat_des_lieux_ia_refusee', actor: 'system:location', subject: `rental:${listingId}`, data: { rule: 'R106', room: index, problems: checked.problems } }, this.now);
    }
    return { text: fallbackFormatted(dictation), origin: 'secours' };
  }

  /**
   * Range une nouvelle version de l'état des lieux d'entrée, sur le bail en vigueur ; refusée une fois l'état des lieux
   * clos [R106, R17].
   */
  async record(viewer: Viewer, listingId: unknown, input: InventoryInput): Promise<InventoryResult<Inventory>> {
    const listing = await this.listings.listing(viewer, listingId, true);
    if ('ok' in listing) return listing;
    const lease = await this.leases.current(listing.networkId, listing.id);
    if (!lease) return { ok: false, rule: 'R106', code: 'no_current_lease' };
    if (!lease.complete) return { ok: false, rule: 'R106', code: 'lease_incomplete' };
    const chosen = await this.choices.chosen(listing.networkId, listing.id);
    if (!chosen) return { ok: false, rule: 'R105', code: 'no_choice' };
    const last = await this.latestRow(listing.networkId, listing.id);
    // Un état des lieux clos l'est pour son bail : un nouveau bail en vigueur demande le sien [R106].
    if (last && last.lease_id === lease.leaseId && (await this.closed(last.id))) return { ok: false, rule: 'R106', code: 'closed' };

    // La saisie, contrôlée champ par champ ; rien n'est inventé.
    const address = input.address === undefined || input.address === null ? null : text(input.address, ADDRESS);
    if (input.address !== undefined && input.address !== null && address === null) return bad('bad_address');
    const ownerAddress = input.ownerAddress === undefined || input.ownerAddress === null ? null : text(input.ownerAddress, ADDRESS);
    if (input.ownerAddress !== undefined && input.ownerAddress !== null && ownerAddress === null) return bad('bad_owner_address');
    const photoPrefix = `location/${listing.id}/etat-des-lieux/`;
    const rooms = parseList(input.rooms, MAX_ROOMS, 'bad_rooms', (r) => {
      const name = text(r.name, NAME);
      if (name === null) return null;
      const elements = parseList(r.elements, MAX_ELEMENTS, 'bad_rooms', (e) => {
        const n = text(e.name, NAME);
        const s = state(e.state);
        return n === null || s === null ? null : { name: n, state: s };
      });
      if (isBad(elements)) return null;
      const dictation = r.dictation === undefined || r.dictation === null ? null : typeof r.dictation === 'string' && DICTATION.test(r.dictation) ? r.dictation.trim() || null : undefined;
      if (dictation === undefined) return null;
      const photos = r.photos === undefined || r.photos === null ? [] : r.photos;
      if (!Array.isArray(photos) || photos.length > MAX_PHOTOS) return null;
      if (!photos.every((x): x is string => typeof x === 'string' && x.startsWith(photoPrefix) && PHOTO.test(x.slice(photoPrefix.length)))) return null;
      if (new Set(photos).size !== photos.length) return null;
      return { name, elements, dictation, photos: photos as string[] };
    });
    if (isBad(rooms)) return rooms;
    for (const r of rooms) for (const p of r.photos) if (!(await this.files.has(p))) return bad('photo_not_stored');
    const meters = parseList(input.meters, 10, 'bad_meters', (m) => {
      const kind = typeof m.kind === 'string' && Object.prototype.hasOwnProperty.call(METER_KINDS, m.kind) ? (m.kind as MeterKind) : null;
      const index = typeof m.index === 'string' && METER_INDEX.test(m.index) ? m.index : null;
      const number = m.number === undefined || m.number === null ? null : typeof m.number === 'string' && METER_NUMBER.test(m.number) ? m.number : undefined;
      return kind === null || index === null || number === undefined ? null : { kind, index, number };
    });
    if (isBad(meters)) return meters;
    const keys = parseList(input.keys, 30, 'bad_keys', (k) => {
      const kind = text(k.kind, NAME);
      const n = count(k.count, 50);
      return kind === null || n === null ? null : { kind, count: n };
    });
    if (isBad(keys)) return keys;
    const furniture = parseList(input.furniture, MAX_LINES, 'bad_furniture', (f) => {
      const item = text(f.item, NAME);
      const n = count(f.count, 99);
      const s = state(f.state);
      return item === null || n === null || s === null ? null : { item, count: n, state: s };
    });
    if (isBad(furniture)) return furniture;

    // Les noms des deux parties, lus sous les droits des fiches [R16] ; prénom et nom exigés tous les deux.
    const names: (string | null)[] = [];
    for (const personId of [listing.ownerPersonId, chosen.personId]) {
      const read = await this.persons.readFiche(viewer, personId);
      if (!read.ok) return { ok: false, rule: 'R16', code: read.code };
      if (read.view !== 'full') return this.refuse(viewer, `person:${personId}`, 'not_assigned');
      const first = read.value.person.first_name?.trim() ?? '';
      const lastName = read.value.person.last_name?.trim() ?? '';
      names.push(first === '' || lastName === '' ? null : `${first} ${lastName}`);
    }
    const facts = (await this.listings.currentFacts(listing.id))!;

    // Chaque pièce : ses observations mises en forme, l'IA ne faisant que la forme [R106].
    const shaped: RoomRow[] = [];
    for (const [i, r] of rooms.entries()) {
      const f = r.dictation === null ? null : await this.formatRoom(listing.id, i, r.name, r.dictation);
      shaped.push({ ...r, text: f?.text ?? null, origin: f?.origin ?? null });
    }
    const missing: string[] = [];
    if (names[0] === null) missing.push('bailleur.nom');
    if (ownerAddress === null) missing.push('bailleur.domicile');
    if (names[1] === null) missing.push('locataire.nom');
    if (address === null) missing.push('logement.adresse');
    const p = await this.db.first<{ city: string | null }>('SELECT city FROM properties WHERE id = ?', [listing.propertyId]);
    if (!p?.city || p.city.trim() === '') missing.push('logement.commune');
    if (shaped.length === 0) missing.push('pieces');
    shaped.forEach((r, i) => {
      if (r.elements.length === 0) missing.push(`piece.${i + 1}`);
    });
    if (meters.length === 0) missing.push('compteurs');
    if (keys.length === 0) missing.push('cles');
    if (facts.furnished && furniture.length === 0) missing.push('mobilier');

    const today = localTime(this.now(), 'Europe/Paris').date;
    const trial = lease.mode !== 'reel';
    const hole = (label: string) => `[à compléter : ${label}]`;
    const lines: string[] = [];
    lines.push(facts.furnished ? 'ÉTAT DES LIEUX D’ENTRÉE ET INVENTAIRE DU MOBILIER' : 'ÉTAT DES LIEUX D’ENTRÉE');
    if (trial) lines.push('DOCUMENT D’ESSAI, SANS VALEUR');
    lines.push('');
    lines.push(`Établi le ${dayInFrench(today)}, contradictoirement entre les parties, pour le bail de ${facts.furnished ? 'location meublée' : 'location vide'} prenant effet le ${dayInFrench(facts.leaseStart)}.`);
    lines.push(`Bailleur : ${names[0] ?? hole('nom du bailleur')}, domicilié ${ownerAddress ?? hole('domicile du bailleur')}.`);
    lines.push(`Locataire : ${names[1] ?? hole('nom du locataire')}.`);
    lines.push(`Logement : ${address ?? hole('adresse du logement')}, ${p?.city ?? hole('commune du logement')}.`);
    lines.push('');
    if (shaped.length === 0) lines.push(hole('pièces du logement'));
    for (const r of shaped) {
      lines.push(`Pièce : ${r.name}`);
      if (r.elements.length === 0) lines.push(`- ${hole('éléments et leur état')}`);
      for (const e of r.elements) lines.push(`- ${e.name} : ${ELEMENT_STATES[e.state]}`);
      if (r.text) lines.push(`Observations : ${r.text}`);
      // Chaque photo est désignée par sa référence dans le document signé : son empreinte couvre les photos jointes.
      if (r.photos.length > 0) lines.push(`Photos jointes : ${r.photos.length}`);
      for (const ph of r.photos) lines.push(`- Photo : ${ph}`);
      lines.push('');
    }
    lines.push('Relevés des compteurs');
    if (meters.length === 0) lines.push(`- ${hole('relevés des compteurs')}`);
    for (const m of meters) lines.push(`- ${METER_KINDS[m.kind]}${m.number ? `, compteur ${m.number}` : ''} : ${m.index}`);
    lines.push('');
    lines.push('Clés et moyens d’accès remis');
    if (keys.length === 0) lines.push(`- ${hole('clés remises')}`);
    for (const k of keys) lines.push(`- ${k.kind} : ${k.count}`);
    if (facts.furnished) {
      lines.push('');
      lines.push('Inventaire du mobilier');
      if (furniture.length === 0) lines.push(`- ${hole('inventaire du mobilier')}`);
      for (const f of furniture) lines.push(`- ${f.item} (${f.count}) : ${ELEMENT_STATES[f.state]}`);
    }
    lines.push('');
    lines.push('Signé par le bailleur et par le locataire, qui en reçoivent chacun un exemplaire identique.');
    const content = lines.join('\n');
    const contentSha = await sha256(content);
    const status = missing.length === 0 ? 'complet' : 'incomplet';

    for (let attempt = 0; attempt < 5; attempt++) {
      const id = this.newId();
      let inserted = 0;
      try {
        // La nouvelle version n'est rangée que si l'état des lieux n'a pas été clos entre-temps : la vérification et
        // l'écriture sont une seule instruction [R106].
        const { changes } = await this.db.run(
          `INSERT INTO rental_inventories (id, listing_id, network_id, version, lease_id, lease_sha256, mode, status, missing, rooms, meters, keys_given, furniture, content, content_sha256, created_by, created_at)
           SELECT ?, ?, ?, m.v, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? FROM (SELECT COALESCE(MAX(version), 0) + 1 AS v FROM rental_inventories WHERE listing_id = ?) m
           WHERE NOT EXISTS (SELECT 1 FROM rental_inventory_copies c JOIN rental_inventories i ON i.id = c.inventory_id WHERE i.listing_id = ? AND i.lease_id = ?)`,
          [
            id,
            listing.id,
            listing.networkId,
            lease.leaseId,
            lease.contentSha256,
            trial ? 'essai' : 'reel',
            status,
            JSON.stringify(missing),
            JSON.stringify(shaped),
            JSON.stringify(meters),
            JSON.stringify(keys),
            JSON.stringify(furniture),
            content,
            contentSha,
            this.actor(viewer),
            this.now().toISOString(),
            listing.id,
            listing.id,
            lease.leaseId,
          ],
        );
        inserted = changes;
      } catch (error) {
        if (/UNIQUE/i.test(String(error))) continue;
        throw error;
      }
      if (inserted !== 1) return { ok: false, rule: 'R106', code: 'closed' };
      const version = Number((await this.db.first<{ version: number }>('SELECT version FROM rental_inventories WHERE id = ?', [id]))!.version);
      await appendEvent(
        this.journal,
        { type: 'location.etat_des_lieux', actor: this.actor(viewer), subject: `rental:${listing.id}`, data: { rule: 'R106', version, status, missing, origins: shaped.map((r) => r.origin) } },
        this.now,
      );
      return { ok: true, value: { inventoryId: id, listingId: listing.id, version, mode: trial ? 'essai' : 'reel', status, missing, rooms: shaped, content, contentSha256: contentSha } };
    }
    return bad('busy');
  }

  private async latestRow(networkId: string, listingId: string): Promise<InventoryRow | null> {
    return this.db.first<InventoryRow>(`${ROW} WHERE listing_id = ? AND network_id = ? ORDER BY version DESC LIMIT 1`, [listingId, networkId]);
  }

  private async closed(inventoryId: string): Promise<boolean> {
    const r = await this.db.first<{ n: number }>('SELECT COUNT(*) AS n FROM rental_inventory_copies WHERE inventory_id = ?', [inventoryId]);
    return Number(r?.n ?? 0) > 0;
  }

  /** L'état des lieux par son identifiant, sous les droits de la mise en location [R16]. */
  private async gate(viewer: Viewer, inventoryId: unknown): Promise<InventoryRefusal | InventoryRow> {
    const row = typeof inventoryId === 'string' ? await this.db.first<InventoryRow>(`${ROW} WHERE id = ? AND network_id = ?`, [inventoryId, viewer.networkId]) : null;
    if (!row) return bad('unknown_inventory');
    const listing = await this.listings.listing(viewer, row.listing_id, true);
    if ('ok' in listing) return listing;
    return row;
  }

  /**
   * La signature d'une partie, tracée à l'écran devant l'agent, sur la dernière version, complète, du bail en vigueur.
   * À la seconde signature, l'état des lieux est clos et chaque partie reçoit le même exemplaire [R106].
   */
  async sign(viewer: Viewer, inventoryId: unknown, input: { party?: unknown; contentSha256?: unknown; drawing?: unknown }): Promise<InventoryResult<{ party: Party; closed: boolean }>> {
    const row = await this.gate(viewer, inventoryId);
    if ('ok' in row) return row;
    if (typeof input.party !== 'string' || !(PARTIES as readonly string[]).includes(input.party)) return bad('bad_party');
    const party = input.party as Party;
    if (typeof input.drawing !== 'string' || input.drawing.length < 10 || input.drawing.length > MAX_DRAWING || !/^[A-Za-z0-9+/=:;,. -]+$/.test(input.drawing)) return bad('bad_drawing');
    const latest = (await this.latestRow(row.network_id, row.listing_id))!;
    if (latest.id !== row.id) return { ok: false, rule: 'R106', code: 'not_latest' };
    if (await this.closed(row.id)) return { ok: false, rule: 'R106', code: 'closed' };
    if (row.status !== 'complet') return { ok: false, rule: 'R106', code: 'incomplete' };
    // La partie signe ce qu'elle a vu : l'empreinte montrée doit être celle de la version rangée, contenu intact.
    if (input.contentSha256 !== row.content_sha256 || (await sha256(row.content)) !== row.content_sha256) return { ok: false, rule: 'R106', code: 'document_changed' };
    const lease = await this.leases.current(row.network_id, row.listing_id);
    if (!lease || lease.leaseId !== row.lease_id) return { ok: false, rule: 'R106', code: 'lease_changed' };
    // La signature n'est rangée que si cette version est encore la dernière : une correction rangée entre-temps l'emporte.
    const newer = 'NOT EXISTS (SELECT 1 FROM rental_inventories WHERE listing_id = ? AND version > ?)';
    const { changes } = await this.db.run(
      `INSERT INTO rental_inventory_signatures (id, inventory_id, party, content_sha256, drawing_sha256, signed_by, signed_at) SELECT ?, ?, ?, ?, ?, ?, ? WHERE ${newer}
       ON CONFLICT (inventory_id, party) DO NOTHING`,
      [this.newId(), row.id, party, row.content_sha256, await sha256(input.drawing), this.actor(viewer), this.now().toISOString(), row.listing_id, Number(row.version)],
    );
    if (changes !== 1) {
      const mine = await this.db.first('SELECT 1 FROM rental_inventory_signatures WHERE inventory_id = ? AND party = ?', [row.id, party]);
      if (!mine) return { ok: false, rule: 'R106', code: 'not_latest' };
    } else {
      await appendEvent(this.journal, { type: 'location.etat_des_lieux_signe', actor: this.actor(viewer), subject: `rental:${row.listing_id}`, data: { rule: 'R106', version: Number(row.version), party } }, this.now);
    }
    const signed = await this.db.all<{ party: string }>('SELECT party FROM rental_inventory_signatures WHERE inventory_id = ? AND content_sha256 = ?', [row.id, row.content_sha256]);
    const both = PARTIES.every((p) => signed.some((s) => s.party === p));
    // Déjà signé par cette partie : seule une clôture interrompue (les deux signatures, aucun exemplaire) est reprise.
    if (changes !== 1 && !both) return { ok: false, rule: 'R106', code: 'already_signed' };
    if (!both) return { ok: true, value: { party, closed: false } };
    // Clos : un exemplaire par partie, le même, de même empreinte ; l'envoi passe par le contrôle central (W10).
    // Les deux exemplaires en une seule instruction : tous deux ou aucun, jamais un seul [R106].
    const at = this.now().toISOString();
    await this.db.run(
      `INSERT INTO rental_inventory_copies (id, inventory_id, party, content_sha256, prepared_at)
       SELECT ?, ?, 'bailleur', ?, ? WHERE ${newer}
       UNION ALL SELECT ?, ?, 'locataire', ?, ? WHERE ${newer}
       ON CONFLICT (inventory_id, party) DO NOTHING`,
      [this.newId(), row.id, row.content_sha256, at, row.listing_id, Number(row.version), this.newId(), row.id, row.content_sha256, at, row.listing_id, Number(row.version)],
    );
    // Une correction rangée entre la signature et la clôture l'emporte : pas d'exemplaire, la nouvelle version se signe.
    const copies = await this.db.first<{ n: number }>('SELECT COUNT(*) AS n FROM rental_inventory_copies WHERE inventory_id = ?', [row.id]);
    if (Number(copies?.n ?? 0) !== PARTIES.length) return { ok: true, value: { party, closed: false } };
    await appendEvent(this.journal, { type: 'location.etat_des_lieux_clos', actor: this.actor(viewer), subject: `rental:${row.listing_id}`, data: { rule: 'R106', version: Number(row.version) } }, this.now);
    return { ok: true, value: { party, closed: true } };
  }

  /** L'exemplaire d'une partie, une fois clos : le contenu signé, vérifié par son empreinte [R106]. */
  async copy(viewer: Viewer, inventoryId: unknown, party: unknown): Promise<InventoryResult<{ content: string; contentSha256: string; photos: string[] }>> {
    const row = await this.gate(viewer, inventoryId);
    if ('ok' in row) return row;
    if (typeof party !== 'string' || !(PARTIES as readonly string[]).includes(party)) return bad('bad_party');
    const c = await this.db.first<{ content_sha256: string }>('SELECT content_sha256 FROM rental_inventory_copies WHERE inventory_id = ? AND party = ?', [row.id, party]);
    if (!c) return { ok: false, rule: 'R106', code: 'not_closed' };
    if (c.content_sha256 !== row.content_sha256 || (await sha256(row.content)) !== c.content_sha256) return { ok: false, rule: 'R106', code: 'document_changed' };
    const photos = (JSON.parse(row.rooms) as RoomRow[]).flatMap((r) => r.photos);
    return { ok: true, value: { content: row.content, contentSha256: c.content_sha256, photos } };
  }

  /** L'état des lieux clos d'une mise en location, s'il existe : pour la remise des clés (W08). */
  async closedInventory(networkId: string, listingId: string): Promise<{ inventoryId: string; leaseId: string; contentSha256: string; mode: 'essai' | 'reel' } | null> {
    const last = await this.latestRow(networkId, listingId);
    if (!last || !(await this.closed(last.id))) return null;
    return { inventoryId: last.id, leaseId: last.lease_id, contentSha256: last.content_sha256, mode: last.mode };
  }
}
