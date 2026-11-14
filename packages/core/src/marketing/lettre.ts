/**
 * La lettre d'information et le magazine des biens (M07, M08, M12, HX53), en mode essai.
 *
 * Jamais vu : chaque lettre est faite pour sa personne. Elle porte les biens diffusables qui remplissent tous ses
 * critères de recherche (rapprochement de T02), la fourchette au m² de la commune de son bien si elle a demandé le
 * suivi de valeur (G04, jamais le prix de son bien [R31]), et les prix regroupés de sa commune et de ses quartiers
 * (AT01), chacun avec sa source et sa date [R150, R151]. Le magazine imprimable sort de la même base, par les mêmes
 * fonctions : les mêmes biens, les mêmes prix.
 *
 * - Aucune lettre sans accord rangé et en cours pour la lettre, sur le mail [R583, R03].
 * - Chaque lettre finit par son lien de désinscription, qui ne retire que l'accord de la lettre [R584].
 * - Aucun prix qui ne vienne de la base : chaque montant en euros du texte est relu contre les prix des biens et les
 *   cases publiées ; un seul montant inconnu, et rien ne part, ni lettre ni magazine [R585, R10].
 * - Tout passe par le contrôle central : exclusions, heures, accord, arrêt, une lettre par édition et par personne
 *   [R01 à R05], boîte d'essai seule [R26] ; au journal, l'issue et sa règle, jamais le texte [R13, R586].
 *
 * Décidé, lecture prudente : la lettre part par mail seulement ; une personne sans aucun bien, ni suivi, ni prix de
 * sa commune ne reçoit rien (lettre vide) ; « son quartier » est lu comme les quartiers publiés de sa commune, car la
 * base ne range pas l'adresse d'un acquéreur ; une commune se reconnaît par le nom de sa zone ou son identifiant
 * court, jamais devinée autrement ; cinq biens au plus par lettre, les plus récents d'abord.
 */
import { Acces } from '../acces/acces.ts';
import type { Viewer } from '../acces/droits.ts';
import { Rapprochement, type DiffusionGate } from '../acquereurs/rapprochement.ts';
import { checkUnsubscribeBase, newAlertToken } from '../acquereurs/alertes.ts';
import { PrixRegroupes, type CommunePrices, type PublicCell } from '../attirer/prix-versions.ts';
import { shownPrice } from '../biens/prix-publie.ts';
import { trialChannels } from '../captation/essai.ts';
import { isUnlistedBusiness } from '../commerces/disponibilite.ts';
import { FicheClient } from '../db/fiche-client.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { Diffusion } from '../documents/retractation.ts';
import type { OutboundChannel } from '../envoi/canaux.ts';
import { ControleEnvois } from '../envoi/controle.ts';
import { SqlSendJournal } from '../envoi/journal-envois.ts';
import { DecisionEnvoi } from '../envoi/service.ts';
import { PRINT_DESIGN_CSS } from '../design/systeme.ts';
import { checkText, plain } from '../envoi/texte.ts';
import { FicheUnique } from '../fiche/fusion.ts';
import { ficheFirstName } from '../fiche/prenom.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import { VALUE_TRACKING_PURPOSE } from '../mandats/suivi-valeur.ts';

/** La finalité de l'accord de la lettre d'information [R03, R583]. */
export const LETTER_PURPOSE = 'lettre_information';
/** Cinq biens au plus par lettre. */
export const LETTER_MAX_PROPERTIES = 5;
/** La longueur permise d'une lettre, lien de désinscription compris : celle d'un mail au contrôle central. */
export const LETTER_MAX_LENGTH = 4000;
/** La place gardée pour le lien de désinscription et la mention légale du premier message automatique [R06]. */
export const LETTER_FOOTER_ROOM = 160;
export const LETTER_MENTION_ROOM = 300;

/**
 * La lettre tenue dans la longueur d'un mail : on retire d'abord les quartiers les plus loin dans la liste, puis les
 * communes, puis les biens les plus anciens ; la case de la commune et le suivi de valeur restent les derniers.
 */
export function fitLetter(content: LetterContent, max = LETTER_MAX_LENGTH - LETTER_FOOTER_ROOM - LETTER_MENTION_ROOM): LetterContent {
  const c: LetterContent = { ...content, properties: [...content.properties], prices: content.prices.map((p) => ({ ...p, cells: [...p.cells] })) };
  while (letterText(c).length > max) {
    const withQuarter = [...c.prices].reverse().find((p) => p.cells.some((x) => x.zone.level === 'quartier'));
    if (withQuarter) {
      const at = withQuarter.cells.map((x) => x.zone.level).lastIndexOf('quartier');
      withQuarter.cells.splice(at, 1);
    } else if (c.prices.length > 0) c.prices.pop();
    else if (c.properties.length > 0) c.properties.pop();
    else break;
  }
  return c;
}

const placeholders = (n: number): string => Array.from({ length: n }, () => '?').join(', ');

/** Les prix regroupés d'une commune : AT01 les donne. */
export interface CommunePriceReader {
  communePrices(networkId: string, communeSlug: string): Promise<CommunePrices | null>;
}

export interface LettreOptions {
  diffusion?: DiffusionGate;
  /** Les prix de AT01 ; absents : ceux de la base, par `PrixRegroupes`. */
  prices?: CommunePriceReader;
  /** Les canaux ; absents : ceux du mode essai, rien ne part [R26]. */
  channels?: readonly OutboundChannel[];
  unsubscribeBase?: string | null;
  /**
   * Les mentions obligatoires d'une annonce, calculées par le code de M07 depuis le mandat, la fiche et la carte du
   * réseau [R43] : le Worker les branche comme pour le studio. Absentes : aucun magazine ne sort.
   */
  mentions?: ListingMentions;
  now?: () => Date;
}

export interface ListingMentions {
  checklist(networkId: string, propertyId: string): Promise<{ complete: boolean; text: string; publishedPriceEur: number | null } | null>;
}

/** La feuille du magazine imprimé : les jetons du papier du système de design, A4 [R201]. */
const MAGAZINE_CSS =
  PRINT_DESIGN_CSS +
  `@page{size:A4;margin:18mm}
body{font:11pt/1.5 var(--police-titre)}
h1{font-size:24pt;line-height:1.15;margin:0 0 8mm;color:var(--accent)}
h2{font-size:14pt;margin:8mm 0 3mm;border-bottom:1pt solid var(--accent);padding-bottom:2mm}
ul{padding-left:4mm}li{margin:0 0 4mm}section{break-inside:avoid}
.mentions{border-left:2pt solid var(--moutarde);padding:1mm 3mm;margin:2mm 0 0;font-size:9pt}`;

/** Le titre du magazine, écrit par le code : aucun texte libre n'entre dans un contenu imprimé public [R09, R15]. */
export const MAGAZINE_TITLE = 'Nos biens et les prix de nos quartiers';

/** Un bien de la lettre ou du magazine, avec son prix lu dans la base. */
export interface LetterProperty {
  id: string;
  kind: string;
  city: string | null;
  priceEur: number;
  surfaceM2: number | null;
  rooms: number | null;
}

/** Les prix d'une commune montrés dans la lettre : seulement des cases publiées, avec leur source [R150, R151]. */
export interface LetterPrices {
  commune: string;
  cells: PublicCell[];
}

/** Le contenu d'une lettre, fait par le code depuis la base. */
export interface LetterContent {
  firstName: string | null;
  properties: LetterProperty[];
  /** La fourchette au m² de la commune du bien suivi, jamais le prix du bien [R31] ; absente sans suivi demandé. */
  valueTracking: { town: string; kind: 'apartment' | 'house'; cell: PublicCell } | null;
  prices: LetterPrices[];
}

export type LetterStatus = 'sent' | 'refused' | 'waiting' | 'failed' | 'no_consent' | 'done' | 'empty';
export interface LetterOutcome {
  personId: string;
  status: LetterStatus;
  rule: string | null;
}

export type EditionResult = { ok: true; id: string } | { ok: false; rule: 'R16' | 'R586'; code: string };
export type MagazineResult = { ok: true; html: string; properties: number } | { ok: false; rule: string; code: string };

/** Un fournisseur de prix qui n'a pas de ventes : la lettre ne fait que lire les versions déjà calculées. */
const NO_SALES = {
  coverage: async () => null,
  within: async () => [],
};

const KIND_LABEL: Record<string, string> = { home: 'logement', building: 'immeuble', commercial: 'local professionnel', business_walls: 'murs commerciaux', land: 'terrain', business: 'fonds de commerce' };
const CELL_KIND: Record<string, string> = { apartment: 'appartement', house: 'maison' };

/** Un montant en euros, à la française, espace simple : la forme que le contrôle relit [R585]. */
export const euros = (n: number): string => `${new Intl.NumberFormat('fr-FR').format(n).replace(/ | /g, ' ')} €`;

/** L'identifiant court d'une commune, depuis son nom : minuscules, sans accent, tirets. */
export function communeSlug(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Les montants en euros d'un texte : « 280 000 € » ou « 2 600 €/m² ». Un montant écrit autrement (« 280k », « 280 000
 * euros ») compte comme inconnu : il ne peut pas être relu contre la base.
 */
export function euroAmounts(text: string): { amounts: number[]; unreadable: boolean } {
  const amounts: number[] = [];
  for (const m of text.matchAll(/(\d{1,3}(?:[   ]\d{3})*|\d+)[   ]?€/g)) amounts.push(Number(m[1]!.replace(/[   ]/g, '')));
  const unreadable = /\d\s*(?:k€|k\b|euros?\b|eur\b|m€)/i.test(text);
  return { amounts, unreadable };
}

/** Tous les montants du texte viennent de la base : prix des biens et chiffres des cases publiées [R585]. */
export function pricesFromBase(text: string, content: Pick<LetterContent, 'properties' | 'valueTracking' | 'prices'>): boolean {
  const allowed = new Set<number>();
  for (const p of content.properties) allowed.add(p.priceEur);
  const cells = [...content.prices.flatMap((p) => p.cells), ...(content.valueTracking ? [content.valueTracking.cell] : [])];
  for (const c of cells) for (const v of [c.median, c.q1, c.q3]) allowed.add(v);
  const { amounts, unreadable } = euroAmounts(text);
  return !unreadable && amounts.every((a) => allowed.has(a));
}

const cellLine = (c: PublicCell): string =>
  `${c.zone.name}, ${CELL_KIND[c.kind] ?? c.kind} : ${euros(c.median)}/m² au milieu, de ${euros(c.q1)}/m² à ${euros(c.q3)}/m², sur ${c.sales} ventes. Source : ${c.source}, ventes jusqu’au ${c.dvfLastSale}.`;

const propertyLine = (p: LetterProperty): string => {
  const facts = [
    `${KIND_LABEL[p.kind] ?? 'bien'}${p.city ? ` à ${p.city}` : ''}`,
    ...(p.surfaceM2 !== null ? [`${String(p.surfaceM2).replace('.', ',')} m²`] : []),
    ...(p.rooms !== null ? [`${p.rooms} pièces`] : []),
    euros(p.priceEur),
  ];
  return `- ${facts.join(', ')}`;
};

/** Le texte de la lettre, écrit par le code, sans parenthèses [R08], sans un chiffre qui ne vienne de la base [R10]. */
export function letterText(content: LetterContent): string {
  const parts: string[] = [content.firstName ? `Bonjour ${content.firstName},` : 'Bonjour,', 'Voici votre lettre immobilière, faite pour vous.'];
  if (content.properties.length > 0) parts.push(['Les biens qui correspondent à votre recherche :', ...content.properties.map(propertyLine)].join('\n'));
  if (content.valueTracking) {
    const v = content.valueTracking;
    parts.push(
      `Le suivi de valeur que vous avez demandé, pour une ${CELL_KIND[v.kind]} à ${v.town} : ${euros(v.cell.median)}/m² au milieu, de ${euros(v.cell.q1)}/m² à ${euros(v.cell.q3)}/m², sur ${v.cell.sales} ventes. C’est la fourchette de la commune, pas le prix de votre bien : votre agent immobilier l’estime sur simple réponse. Source : ${v.cell.source}, ventes jusqu’au ${v.cell.dvfLastSale}.`,
    );
  }
  for (const p of content.prices) parts.push([`Les prix au m² de ${p.commune} et de ses quartiers :`, ...p.cells.map((c) => `- ${cellLine(c)}`)].join('\n'));
  parts.push('Votre agent immobilier vous en dit plus sur simple réponse.');
  return parts.join('\n\n');
}

/** Les chiffres que le contrôle central admet dans la lettre : seulement ceux de la base [R10]. */
function figuresOf(content: LetterContent): (string | number)[] {
  const out: (string | number)[] = [];
  // Les noms de lieux de la base, chiffres compris : « Paris 15e », un quartier numéroté.
  for (const p of content.properties) if (p.city) out.push(p.city);
  for (const c of [...content.prices.flatMap((p) => p.cells), ...(content.valueTracking ? [content.valueTracking.cell] : [])]) out.push(c.zone.name);
  for (const p of content.prices) out.push(p.commune);
  if (content.valueTracking) out.push(content.valueTracking.town);
  for (const p of content.properties) out.push(p.priceEur, euros(p.priceEur), ...(p.surfaceM2 !== null ? [p.surfaceM2, String(p.surfaceM2).replace('.', ',')] : []), ...(p.rooms !== null ? [p.rooms] : []));
  const cells = [...content.prices.flatMap((p) => p.cells), ...(content.valueTracking ? [content.valueTracking.cell] : [])];
  for (const c of cells) out.push(c.median, c.q1, c.q3, c.sales, euros(c.median), euros(c.q1), euros(c.q3), c.dvfLastSale, c.source);
  return out;
}

/**
 * Le texte où chaque nom de lieu de la base cité perd ses mots composés à trait d'union (« Saint-Pierre-de-Varennes »,
 * « Pierre-de-Bresse ») : un prénom pris dans un nom de lieu composé n'est pas le nom d'une personne [R09]. Un mot
 * composé égal au prénom, au nom ou au nom complet d'une personne (« Jean-Pierre »), ou à un mot composé de l'un d'eux
 * (« Roche-sur-Yon » de « La Roche-sur-Yon »), reste ; un nom seul ou écrit sans trait d'union aussi : côté prudent.
 */
export function withoutCompoundPlaces(text: string, places: readonly string[], names: readonly string[]): string {
  // Chaque mot composé est lu entier, d'un bout à l'autre du texte : « Saint-Martin » ne masque jamais le début de
  // « Saint-Martin-du-Mont ».
  const compound = /[\p{L}'’]+(?:-[\p{L}'’]+)+/gu;
  // Un nom de personne protège aussi chaque mot composé qu'il contient : « La Roche-sur-Yon » garde « Roche-sur-Yon ».
  const known = new Set(names.flatMap((n) => [plain(n).trim(), ...(n.match(compound) ?? []).map((w) => plain(w))]));
  const fromPlaces = new Set(places.flatMap((p) => p.match(compound) ?? []).map((w) => plain(w)));
  return text.replace(compound, (word) => (fromPlaces.has(plain(word)) && !known.has(plain(word)) ? ' ' : word));
}

const escapeHtml = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export class LettreInformation {
  private readonly now: () => Date;
  private readonly store: FicheClient;
  private readonly fiche: FicheUnique;
  private readonly controle: ControleEnvois;
  private readonly gate: DiffusionGate;
  private readonly rapprochement: Rapprochement;
  private readonly prices: CommunePriceReader;
  private readonly unsubscribeBase: string | null;
  private readonly mentionsReader: ListingMentions | null;

  constructor(
    private readonly db: SqlDatabase,
    private readonly journal: JournalStore,
    options: LettreOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.store = new FicheClient(db, { now: this.now });
    this.fiche = new FicheUnique(db, this.store, { now: this.now });
    const decisions = new DecisionEnvoi(db, this.store, this.fiche, { now: this.now });
    this.controle = new ControleEnvois(db, this.fiche, decisions, {
      channels: options.channels ?? trialChannels(db, journal, this.now),
      journal: new SqlSendJournal(db, undefined, this.now),
      now: this.now,
    });
    this.gate = options.diffusion ?? new Diffusion(db, new Acces(db, this.store, this.fiche, journal, { now: this.now }), journal, { now: this.now });
    this.rapprochement = new Rapprochement(db, this.fiche, this.gate, journal, { now: this.now });
    this.prices = options.prices ?? new PrixRegroupes(db, journal, NO_SALES, { now: this.now });
    this.unsubscribeBase = checkUnsubscribeBase(options.unsubscribeBase ?? null);
    this.mentionsReader = options.mentions ?? null;
  }

  /** La direction ouvre une édition ; un titre en lettres seules, sans chiffre [R10, R16]. */
  async createEdition(viewer: Viewer, title: unknown): Promise<EditionResult> {
    if (viewer.role !== 'direction') return { ok: false, rule: 'R16', code: 'role' };
    if (typeof title !== 'string' || title.trim().length < 3 || title.trim().length > 80 || /\d/.test(title)) return { ok: false, rule: 'R586', code: 'titre' };
    const id = crypto.randomUUID();
    await this.db.run('INSERT INTO newsletter_editions (id, network_id, title, created_by, created_at) VALUES (?, ?, ?, ?, ?)', [id, viewer.networkId, title.trim(), `direction:${viewer.userId}`, this.now().toISOString()]);
    await appendEvent(this.journal, { type: 'lettre.edition', actor: `direction:${viewer.userId}`, subject: `edition:${id}`, data: {} }, this.now);
    return { ok: true, id };
  }

  /** Les biens diffusables du réseau, prix lu dans la base, les plus récents d'abord. */
  private async diffusable(networkId: string): Promise<LetterProperty[]> {
    const rows = await this.db.all<{ id: string; kind: string; city: string | null; price_eur: number | null; surface_m2: number | null; rooms: number | null }>(
      "SELECT id, kind, city, price_eur, surface_m2, rooms FROM properties WHERE network_id = ? AND status = 'available' ORDER BY created_at DESC, id DESC",
      [networkId],
    );
    const out: LetterProperty[] = [];
    for (const r of rows) {
      if (await isUnlistedBusiness(this.db, r.id)) continue;
      if (!(await this.gate.canDiffuse(networkId, r.id, this.now())).allowed) continue;
      const price = await shownPrice(this.db, r.id, r.price_eur === null ? null : Number(r.price_eur));
      if (price === null || price <= 0) continue;
      out.push({ id: r.id, kind: r.kind, city: r.city, priceEur: price, surfaceM2: r.surface_m2 === null ? null : Number(r.surface_m2), rooms: r.rooms === null ? null : Number(r.rooms) });
    }
    return out;
  }

  /** Les cases publiées d'une commune, par son nom ; rien si la commune n'a pas de version. */
  private async communeCells(networkId: string, town: string): Promise<LetterPrices | null> {
    const p = await this.prices.communePrices(networkId, communeSlug(town));
    if (!p || p.cells.length === 0) return null;
    const name = p.cells.find((c) => c.zone.level === 'commune')?.zone.name ?? town;
    return { commune: name, cells: p.cells };
  }

  /** Le contenu de la lettre d'une personne, fait depuis la base seule. */
  async contentFor(networkId: string, personId: string): Promise<LetterContent> {
    const root = await this.fiche.rootOf(personId);
    const ids = await this.fiche.membersOf(root);
    const properties: LetterProperty[] = [];
    // Les communes où des biens correspondent à sa recherche, même déjà envoyés : leurs prix restent dans la lettre.
    const searchTowns: string[] = [];
    for (const p of await this.diffusable(networkId)) {
      if (properties.length >= LETTER_MAX_PROPERTIES) break;
      const matches = await this.rapprochement.systemMatches(networkId, p.id);
      if (!matches.some((m) => m.status === 'match' && ids.includes(m.personId))) continue;
      if (p.city) searchTowns.push(p.city);
      // Jamais deux fois le même bien à la même personne, alertes comprises [R05].
      if (await this.alreadySent(ids, p.id)) continue;
      properties.push(p);
    }

    // Le suivi de valeur, seulement s'il est demandé et que son accord est en cours [R03, R31].
    let valueTracking: LetterContent['valueTracking'] = null;
    const tracking = await this.db.first<{ town: string; kind: 'apartment' | 'house' }>(
      `SELECT town, kind FROM value_tracking WHERE network_id = ? AND person_id IN (${placeholders(ids.length)}) LIMIT 1`,
      [networkId, ...ids],
    );
    // L'accord en vigueur, comme le contrôle central le lit : un retrait plus récent l'emporte sur un accord plus ancien.
    const trackingInForce = tracking ? await this.fiche.channelsInForce(root, VALUE_TRACKING_PURPOSE) : [];
    const towns: string[] = [];
    if (tracking && trackingInForce.length > 0) {
      const prices = await this.communeCells(networkId, tracking.town);
      const cell = prices?.cells.find((c) => c.zone.level === 'commune' && c.kind === tracking.kind);
      if (prices && cell) {
        valueTracking = { town: prices.commune, kind: tracking.kind, cell };
        towns.push(tracking.town);
      }
    }
    for (const city of searchTowns) if (!towns.some((t) => communeSlug(t) === communeSlug(city))) towns.push(city);
    const prices: LetterPrices[] = [];
    for (const t of towns) {
      const c = await this.communeCells(networkId, t);
      if (c) prices.push(c);
    }
    return { firstName: await ficheFirstName(this.db, ids), properties, valueTracking, prices };
  }

  /** Le bien est déjà parti à la personne, fiches réunies comprises, par un envoi qui n'a pas échoué [R05]. */
  private async alreadySent(ids: readonly string[], propertyId: string): Promise<boolean> {
    return this.alreadySentSubject(ids, `bien:${propertyId}`);
  }

  private async alreadySentSubject(personIds: readonly string[], subject: string): Promise<boolean> {
    const ids = personIds.length === 1 ? await this.fiche.membersOf(personIds[0]!) : personIds;
    const row = await this.db.first<{ n: number }>(
      `SELECT count(*) AS n FROM message_subjects s WHERE s.person_id IN (${placeholders(ids.length)}) AND s.subject = ?
         AND NOT EXISTS (SELECT 1 FROM send_log l WHERE l.message_id = s.message_id AND l.outcome = 'failed')`,
      [...ids, subject],
    );
    return Number(row?.n ?? 0) > 0;
  }

  /** Les personnes du réseau dont l'accord de la lettre est en cours, une par fiche réunie. */
  async recipients(networkId: string): Promise<string[]> {
    const iso = this.now().toISOString();
    const rows = await this.db.all<{ person_id: string }>(
      `SELECT DISTINCT c.person_id FROM consents c JOIN persons p ON p.id = c.person_id
        WHERE p.network_id = ? AND c.purpose = ? AND c.channel = 'email' AND c.given_at <= ? AND (c.withdrawn_at IS NULL OR c.withdrawn_at > ?)
        ORDER BY c.person_id`,
      [networkId, LETTER_PURPOSE, iso, iso],
    );
    const roots = new Set<string>();
    for (const r of rows) roots.add(await this.fiche.rootOf(r.person_id));
    return [...roots];
  }

  /** Une édition : une lettre à chaque personne qui l'a demandée. */
  async sendEdition(editionId: string): Promise<LetterOutcome[]> {
    const edition = await this.db.first<{ id: string; network_id: string }>('SELECT id, network_id FROM newsletter_editions WHERE id = ?', [editionId]);
    if (!edition) return [];
    if (this.unsubscribeBase === null) {
      await appendEvent(this.journal, { type: 'lettre.sans_lien', actor: 'system:lettre', subject: `edition:${editionId}`, data: { rule: 'R584' } }, this.now);
      return [];
    }
    const out: LetterOutcome[] = [];
    for (const personId of await this.recipients(edition.network_id)) out.push(await this.sendOne(edition.network_id, editionId, personId));
    return out;
  }

  /** La lettre d'une personne pour une édition, au plus une fois [R05, R583, R584, R585]. */
  async sendOne(networkId: string, editionId: string, personId: string): Promise<LetterOutcome> {
    const root = await this.fiche.rootOf(personId);
    if (this.unsubscribeBase === null) return { personId: root, status: 'refused', rule: 'R584' };
    const at = this.now();
    const iso = at.toISOString();
    const edition = await this.db.first<{ id: string }>('SELECT id FROM newsletter_editions WHERE id = ? AND network_id = ?', [editionId, networkId]);
    if (!edition) return { personId: root, status: 'refused', rule: 'R16' };
    const known = await this.db.first<{ status: string }>('SELECT status FROM newsletter_letters WHERE edition_id = ? AND person_id = ?', [editionId, root]);
    if (known && known.status !== 'waiting' && known.status !== 'failed') return { personId: root, status: 'done', rule: null };

    // L'accord de la lettre, rangé et en cours, sur le mail [R583] : sinon rien n'est même préparé.
    const inForce = await this.fiche.channelsInForce(root, LETTER_PURPOSE);
    if (!inForce.includes('email')) return { personId: root, status: 'no_consent', rule: 'R583' };

    // La longueur d'un mail, lien de désinscription et mention du premier message comptés [R06, R584].
    const footer = `\n\nNe plus recevoir cette lettre : ${this.unsubscribeBase}${'x'.repeat(32)}`.length;
    const content = fitLetter(await this.contentFor(networkId, root), LETTER_MAX_LENGTH - Math.max(footer, LETTER_FOOTER_ROOM) - LETTER_MENTION_ROOM);
    if (content.properties.length === 0 && content.valueTracking === null && content.prices.length === 0) return { personId: root, status: 'empty', rule: null };
    const body = letterText(content);
    if (!pricesFromBase(body, content)) return { personId: root, status: 'refused', rule: 'R585' };

    const { changes } = known
      ? await this.db.run("UPDATE newsletter_letters SET status = 'pending', updated_at = ? WHERE edition_id = ? AND person_id = ? AND status IN ('waiting', 'failed')", [iso, editionId, root])
      : await this.db.run(
          "INSERT INTO newsletter_letters (edition_id, person_id, network_id, status, rule, message_id, properties, mode, created_at, updated_at) VALUES (?, ?, ?, 'pending', NULL, NULL, ?, 'essai', ?, ?) ON CONFLICT DO NOTHING",
          [editionId, root, networkId, content.properties.length, iso, iso],
        );
    if (changes !== 1) return { personId: root, status: 'done', rule: null };

    let status: LetterStatus = 'refused';
    let rule: string | null = null;
    let messageId: string | null = null;
    try {
      const token = newAlertToken();
      await this.db.run('INSERT INTO newsletter_unsubscribe_tokens (token_hash, network_id, person_id, created_at, used_at) VALUES (?, ?, ?, ?, NULL)', [await sha256(token), networkId, root, iso]);
      const text = `${body}\n\nNe plus recevoir cette lettre : ${this.unsubscribeBase}${token}`;
      const agent = await this.db.first<{ agent_id: string | null }>('SELECT agent_id FROM persons WHERE id = ?', [root]);
      const result = await this.controle.send({
        networkId,
        agentId: agent?.agent_id ?? null,
        personId: root,
        channel: 'email',
        kind: 'alert',
        purpose: LETTER_PURPOSE,
        consentOnEveryChannel: true,
        subject: `lettre:${editionId}`,
        propertyIds: content.properties.map((p) => p.id),
        // Au moment d'envoyer : chaque bien encore diffusable, chaque prix encore celui de la base [R42, R585].
        stillAllowed: async () => {
          for (const p of content.properties) {
            if (!(await this.gate.canDiffuse(networkId, p.id, this.now())).allowed) return { allowed: false, rule: 'R42', reason: 'Un bien ne peut plus être diffusé.' };
            const row = await this.db.first<{ price_eur: number | null; status: string }>('SELECT price_eur, status FROM properties WHERE id = ?', [p.id]);
            const price = row && row.status === 'available' ? await shownPrice(this.db, p.id, row.price_eur === null ? null : Number(row.price_eur)) : null;
            if (price !== p.priceEur) return { allowed: false, rule: 'R585', reason: 'Un prix a changé dans la base.' };
          }
          return { allowed: true, rule: 'R585', reason: 'Biens et prix de la base.' };
        },
        fallbackTexts: [text],
        figures: [...figuresOf(content), this.unsubscribeBase, token],
      });
      messageId = result.messageId;
      rule = result.status === 'sent' ? null : result.rule;
      // Un bien parti entre-temps par une alerte : la lettre attend, et se refait sans lui au passage suivant [R05].
      // Deux envois simultanés : le perdant peut lire « Ce sujet part déjà » ; seule la lettre déjà partie est finie. La
      // mention du premier message réservée par un autre envoi (R06) se libère : la lettre est écrite par le code, elle attend.
      const propertyAlreadySent = result.rule === 'R05' && content.properties.length > 0 && !(await this.alreadySentSubject([root], `lettre:${editionId}`));
      status = result.status === 'sent' ? 'sent' : result.status === 'failed' ? 'failed' : result.rule === 'R01' || result.rule === 'R42' || result.rule === 'R585' || result.rule === 'R06' || propertyAlreadySent ? 'waiting' : 'refused';
    } catch (error) {
      await this.db.run("UPDATE newsletter_letters SET status = 'failed', updated_at = ? WHERE edition_id = ? AND person_id = ? AND status = 'pending'", [this.now().toISOString(), editionId, root]);
      throw error;
    }
    await this.db.run('UPDATE newsletter_letters SET status = ?, rule = ?, message_id = ?, updated_at = ? WHERE edition_id = ? AND person_id = ?', [status, rule, messageId, this.now().toISOString(), editionId, root]);
    await appendEvent(this.journal, { type: 'lettre.essai', actor: 'system:lettre', subject: `person:${root}`, data: { mode: 'essai', sent: false, edition: editionId, status, rule } }, this.now);
    return { personId: root, status, rule };
  }

  /** Retire l'accord de la lettre de la personne du jeton, fiches réunies comprises, et rien d'autre [R584]. */
  async unsubscribe(token: string): Promise<boolean> {
    if (!/^[a-z]{32}$/.test(token)) return false;
    const row = await this.db.first<{ token_hash: string; person_id: string }>('SELECT token_hash, person_id FROM newsletter_unsubscribe_tokens WHERE token_hash = ?', [await sha256(token)]);
    if (!row) return false;
    const at = this.now();
    const ids = await this.fiche.membersOf(row.person_id);
    const consents = await this.db.all<{ id: string }>(`SELECT id FROM consents WHERE person_id IN (${placeholders(ids.length)}) AND purpose = ? AND withdrawn_at IS NULL`, [...ids, LETTER_PURPOSE]);
    for (const c of consents) await this.store.withdrawConsent(c.id, at);
    await this.db.run('UPDATE newsletter_unsubscribe_tokens SET used_at = ? WHERE token_hash = ? AND used_at IS NULL', [at.toISOString(), row.token_hash]);
    await appendEvent(this.journal, { type: 'lettre.desinscription', actor: 'system:lettre', subject: `person:${row.person_id}`, data: { rule: 'R584', withdrawn: consents.length } }, this.now);
    return true;
  }

  /**
   * Le magazine imprimable du réseau, de la même base : les biens diffusables et les prix publiés de leurs communes,
   * sans nom, adresse ni coordonnée [R15] ; la direction ou un agent du réseau le tire [R16]. Un seul prix inconnu de la
   * base, et rien ne sort [R585].
   */
  async magazine(viewer: Viewer): Promise<MagazineResult> {
    if (viewer.role !== 'direction' && viewer.role !== 'agent') return { ok: false, rule: 'R16', code: 'role' };
    if (!this.mentionsReader) return { ok: false, rule: 'R43', code: 'mentions_absentes' };
    const title = MAGAZINE_TITLE;
    const properties: LetterProperty[] = [];
    const mentions = new Map<string, string>();
    // Chaque bien du magazine porte toutes ses mentions obligatoires, sous lui ; une seule manque et il n'y entre pas [R43].
    for (const p of await this.diffusable(viewer.networkId)) {
      const m = await this.mentionsReader.checklist(viewer.networkId, p.id);
      if (!m || !m.complete || m.text.trim() === '' || m.publishedPriceEur !== p.priceEur) continue;
      properties.push(p);
      mentions.set(p.id, m.text);
    }
    const prices: LetterPrices[] = [];
    const seen = new Set<string>();
    for (const p of properties) {
      if (!p.city || seen.has(communeSlug(p.city))) continue;
      seen.add(communeSlug(p.city));
      const c = await this.communeCells(viewer.networkId, p.city);
      if (c) prices.push(c);
    }
    const content: LetterContent = { firstName: null, properties, valueTracking: null, prices };
    const sections = [
      `<h1>${escapeHtml(title.trim())}</h1>`,
      `<section><h2>Nos biens</h2><ul>${properties.map((p) => `<li>${escapeHtml(propertyLine(p).slice(2))}<p class="mentions">${escapeHtml(mentions.get(p.id)!).replace(/\n/g, '<br>')}</p></li>`).join('')}</ul></section>`,
      ...prices.map((p) => `<section><h2>Les prix au m² de ${escapeHtml(p.commune)}</h2><ul>${p.cells.map((c) => `<li>${escapeHtml(cellLine(c))}</li>`).join('')}</ul></section>`),
    ];
    const html = `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>${escapeHtml(title.trim())}</title><style>${MAGAZINE_CSS}</style></head><body>${sections.join('')}</body></html>`;
    const visible = sections.join('').replace(/<[^>]+>/g, '\n').replace(/&[a-z]+;/g, ' ');
    // Les montants des mentions sont calculés par M07 depuis le mandat : ils viennent de la base, eux aussi.
    const mentionTexts = [...mentions.values()];
    const extra = new Set(mentionTexts.flatMap((t) => euroAmounts(t).amounts));
    const withoutMentions = mentionTexts.reduce((v, t) => v.split(t).join('\n'), sections.join('').replace(/<br>/g, '\n').replace(/<[^>]+>/g, '\n').replace(/&[a-z]+;/g, ' '));
    if (!pricesFromBase(withoutMentions, content) || ![...euroAmounts(visible).amounts].every((a) => extra.has(a) || euroAmounts(withoutMentions).amounts.includes(a)))
      return { ok: false, rule: 'R585', code: 'prix_inconnu' };
    // Aucune coordonnée dans un contenu public [R09, R15].
    if (/@|\bhttps?:|\bwww\./i.test(withoutMentions)) return { ok: false, rule: 'R09', code: 'coordonnee' };
    // Un contenu public : vocabulaire, adresse, chiffres de la base, aucune mention de l'IA [R07, R09, R10]. Le
    // magazine s'imprime : sa longueur n'est pas celle d'une page.
    // La liste des mots de l'IA n'est lue que pour un client : on la passe aussi, sans les exigences d'une conversation.
    // Aucun nom de personne du réseau dans un contenu public [R09, R15].
    const people = await this.db.all<{ first_name: string | null; last_name: string | null }>('SELECT first_name, last_name FROM persons WHERE network_id = ?', [viewer.networkId]);
    const clientNames = people.flatMap((x) => [x.first_name, x.last_name, x.first_name && x.last_name ? `${x.first_name} ${x.last_name}` : null]).filter((x): x is string => typeof x === 'string' && x.trim().length > 1);
    // Les noms se cherchent sur le texte où les lieux composés de la base sont mis à part (« Saint-Pierre », RC38) ;
    // tout le reste du contrôle lit le texte entier.
    const placeNames = [...properties.flatMap((p) => (p.city ? [p.city] : [])), ...prices.flatMap((p) => [p.commune, ...p.cells.map((c) => c.zone.name)])];
    const forNames = withoutCompoundPlaces(withoutMentions, placeNames, clientNames);
    const nameProblems = (names: readonly string[]): number => checkText(forNames, { audience: 'public', clientNames: names }).filter((p) => p.rule === 'R09').length;
    const problem =
      checkText(withoutMentions, { audience: 'public', figures: figuresOf(content) }).find((p) => p.rule !== 'length') ??
      (nameProblems(clientNames) > nameProblems([]) ? { rule: 'R09' } : undefined) ??
      checkText(withoutMentions, { audience: 'client', channel: 'email' }).find((p) => p.rule === 'R06');
    if (problem) return { ok: false, rule: problem.rule, code: 'texte' };
    await appendEvent(this.journal, { type: 'lettre.magazine', actor: `${viewer.role}:${viewer.userId}`, subject: null, data: { properties: properties.length, communes: prices.length } }, this.now);
    return { ok: true, html, properties: properties.length };
  }
}
