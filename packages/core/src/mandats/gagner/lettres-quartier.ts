/**
 * Lettres de quartier, adressées sans nom (M20 complet, G06).
 *
 * Après un mandat signé ou une vente rapportée sur un bien qu'il suit, l'agent prépare une campagne de lettres : il
 * saisit lui-même chaque adresse (numéro, voie, code postal, commune), et le code vérifie qu'elle est dans le rayon
 * réglé autour du bien. Le destinataire n'est jamais un nom : « Au propriétaire » ou « Aux habitants » seulement ; une
 * civilité ou un nom glissé dans une adresse est refusé [R140]. Les adresses ne viennent jamais des ventes publiques ni
 * d'une liste achetée [R37]. L'adresse du bien ne sert qu'à placer le centre du rayon : elle n'est ni rangée ni citée
 * dans la lettre [R46]. Le texte est proposé par l'IA derrière une interface, qui ne reçoit que la sorte de campagne et
 * la commune ; un texte refusé par les contrôles est remplacé par le texte du code. Chaque lettre s'imprime avec le
 * système de design et passe son contrôle [R201]. L'agent note chaque dépôt. Rien ne s'efface [R17].
 */
import type { Viewer } from '../../acces/droits.ts';
import { mentionsReward } from '../../apres-vente/recommandations.ts';
import type { SqlDatabase } from '../../db/sql.ts';
import { PRINT_DESIGN_CSS } from '../../design/systeme.ts';
import { plain } from '../../envoi/texte.ts';
import type { Geocoder } from '../../estimation/collecte.ts';
import { appendEvent } from '../../journal/journal.ts';
import type { JournalStore } from '../../journal/types.ts';
import { withoutRoadTitles } from '../../veille-dpe/titre-voie.ts';
import { FORBIDDEN_SOURCES, isForbiddenSource } from '../source.ts';
import { agentBlocked } from './etat-agent.ts';

export const LETTER_TRIGGERS = ['mandat', 'vente'] as const;
export type LetterTrigger = (typeof LETTER_TRIGGERS)[number];
export const LETTER_RECIPIENTS = ['au_proprietaire', 'aux_habitants'] as const;
export type LetterRecipient = (typeof LETTER_RECIPIENTS)[number];
export const LETTER_RECIPIENT_LABELS: Readonly<Record<LetterRecipient, string>> = Object.freeze({ au_proprietaire: 'Au propriétaire', aux_habitants: 'Aux habitants' });
/** La seule origine admise d'une adresse : l'agent l'a saisie lui-même, dans le quartier. */
export const LETTER_ORIGIN = 'saisie_agent';
/** Le rayon autour du bien, en mètres. Réglage. */
export const DEFAULT_LETTER_RADIUS_M = 500;
export const LETTER_MAX_ADDRESSES = 200;
/** La confiance minimale du géocodage, de 0 à 1 : en dessous, la position n'est pas sûre. Réglage. */
export const LETTER_MIN_GEOCODE_SCORE = 0.8;

export const CAMPAIGN_FIELDS = ['propertyId', 'trigger', 'propertyAddress', 'recipient', 'origin', 'addresses'] as const;
export const ADDRESS_FIELDS = ['number', 'street', 'postcode', 'city'] as const;

/** La rédaction par l'IA : la sorte de campagne et la commune, jamais une adresse ni un nom. */
export interface LetterDrafter {
  draft(input: { trigger: LetterTrigger; city: string | null }): Promise<string>;
}

export type LetterRefusal = { ok: false; rule: 'R16' | 'R140' | 'R37' | 'R46' | null; code: string; index?: number };
export type LetterResult<T> = { ok: true; value: T } | LetterRefusal;

export interface LettresQuartierOptions {
  now?: () => Date;
  newId?: () => string;
  radiusM?: number;
  geocoder?: Geocoder | null;
  drafter?: LetterDrafter | null;
}

const NUMBER = /^\d{1,4}(?: ?(?:bis|ter|quater|[a-d]))?$/i;
/** Les types de voie d'une adresse de lettre ; un titre qui suit l'un d'eux n'est pas une personne (`withoutRoadTitles`, RC06). */
export const LETTER_STREET_TYPES = Object.freeze([
  'rue', 'avenue', 'av', 'boulevard', 'bd', 'place', 'chemin', 'allee', 'impasse', 'route', 'quai', 'cours', 'square', 'passage',
  'faubourg', 'rond point', 'residence', 'lotissement', 'ruelle', 'sentier', 'promenade', 'esplanade', 'voie', 'parvis', 'hameau',
  'lieu dit', 'clos', 'cite', 'montee', 'venelle', 'traverse', 'mail',
] as const);
const STREET_TYPES = new RegExp(`^(?:${LETTER_STREET_TYPES.join('|')})\\b`);
/** Une civilité ou une marque de personne : jamais dans une adresse de lettre de quartier [R140]. */
const PERSON_MARKERS = /(?:^|\s)(?:m|mr|mme|mlle|mm|dr|me|monsieur|madame|mademoiselle|messieurs|famille|chez|maitre|docteur|c o|attn|a l attention|aux bons soins)(?:\s|$)/;
/** Les mots qui diraient d'où vient l'adresse, quand elle ne vient pas de l'agent [R37]. */
const LETTER_WORDING = /\bmandataire|\bgratuit|\bintelligence artificielle\b|\bia\b|\bchatgpt\b|\brobot\b/;

const words = (t: string): string => plain(t).replace(/[^a-z0-9]+/g, ' ').trim();
const escape = (t: string): string => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** La distance entre deux points, en mètres (formule de haversine). */
export function distanceM(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const r = 6_371_000;
  const rad = (d: number): number => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return Math.round(2 * r * Math.asin(Math.sqrt(h)));
}

/** Le texte du code, sans chiffre ni adresse : il dit ce qui s'est passé, sans situer le bien. */
export function letterFallback(trigger: LetterTrigger, city: string | null): string {
  const where = city ? `à ${city}` : 'dans votre quartier';
  const what = trigger === 'vente' ? `Un logement de votre quartier, ${where}, vient de trouver acquéreur avec notre agence.` : `Un propriétaire de votre quartier, ${where}, vient de nous confier la vente de son logement.`;
  return `${what} D’autres familles cherchent encore dans le secteur. Si vous pensez un jour à vendre, ou si vous voulez simplement connaître la valeur de votre bien, je me tiens à votre disposition pour en parler, sans engagement.`;
}

/**
 * Le contrôle d'un texte de lettre : longueur, aucun chiffre ni lien (rien d'inventé, aucun numéro de rue) [R10, R46],
 * aucune récompense [R66], « agent immobilier » et « offert » seulement, aucune mention de l'IA, et aucun mot de la voie
 * du bien [R46]. Rend le code du problème, ou `null`.
 */
export function checkLetterText(text: string, propertyStreet: string | null): string | null {
  const t = text.trim();
  if (t.length < 20 || t.length > 1200) return 'length';
  if (/\d/.test(t)) return 'figure';
  if (/https?:|www\.|@/.test(t)) return 'link';
  if (mentionsReward(t)) return 'reward';
  if (LETTER_WORDING.test(plain(t))) return 'wording';
  if (propertyStreet) {
    // La voie du bien, sans son type (« rue », « avenue ») : son nom propre ne doit pas paraître dans la lettre [R46].
    const rest = words(propertyStreet).replace(STREET_TYPES, '').trim();
    const tokens = rest.split(' ').filter((w) => w !== '' && !/\d/.test(w));
    const strong = tokens.filter((w) => w.length > 2 && !['des', 'les', 'aux', 'du', 'de', 'la', 'le'].includes(w));
    // Une voie faite de mots courts (« rue de l’If ») garde tous ses mots : jamais aucun contrôle vide.
    const name = strong.length > 0 ? strong : tokens;
    const body = ` ${words(t)} `;
    if (name.length > 0 && name.every((w) => body.includes(` ${w} `))) return 'property_street';
    if (tokens.length > 0 && body.includes(` ${tokens.join(' ')} `)) return 'property_street';
  }
  return null;
}

/** Une adresse saisie, contrôlée : numéro, voie, code postal, commune, jamais un nom [R140]. */
function readAddress(raw: unknown): { ok: true; value: { number: string; street: string; postcode: string; city: string } } | { ok: false; rule: 'R140' | null; code: string } {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, rule: null, code: 'bad_address' };
  const a = raw as Record<string, unknown>;
  if (Object.keys(a).some((k) => !(ADDRESS_FIELDS as readonly string[]).includes(k))) return { ok: false, rule: 'R140', code: 'unknown_field' };
  const { number, street, postcode, city } = a;
  if (typeof number !== 'string' || typeof street !== 'string' || typeof postcode !== 'string' || typeof city !== 'string') return { ok: false, rule: null, code: 'bad_address' };
  // Le titre d'une voie (« rue du Docteur Chaussier ») n'est pas une personne ; toute autre civilité refuse l'adresse [R140].
  for (const v of [number, withoutRoadTitles(words(street)), city]) if (PERSON_MARKERS.test(` ${words(v)} `)) return { ok: false, rule: 'R140', code: 'name_in_address' };
  if (!NUMBER.test(number.trim())) return { ok: false, rule: null, code: 'bad_number' };
  const s = street.trim();
  if (s.length < 3 || s.length > 80 || !STREET_TYPES.test(words(s))) return { ok: false, rule: null, code: 'bad_street' };
  if (!/^\d{5}$/.test(postcode.trim())) return { ok: false, rule: null, code: 'bad_postcode' };
  const c = city.trim();
  if (c === '' || c.length > 60 || /\d/.test(c)) return { ok: false, rule: null, code: 'bad_city' };
  return { ok: true, value: { number: number.trim(), street: s, postcode: postcode.trim(), city: c } };
}

interface CampaignRow {
  id: string;
  network_id: string;
  agent_id: string;
  property_id: string;
  trigger: LetterTrigger;
  recipient: LetterRecipient;
  text: string;
  created_at: string;
}

export class LettresQuartier {
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly radiusM: number;
  private readonly geocoder: Geocoder | null;
  private readonly drafter: LetterDrafter | null;

  constructor(
    private readonly db: SqlDatabase,
    private readonly journal: JournalStore,
    options: LettresQuartierOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => crypto.randomUUID());
    this.radiusM = options.radiusM ?? DEFAULT_LETTER_RADIUS_M;
    this.geocoder = options.geocoder ?? null;
    this.drafter = options.drafter ?? null;
  }

  private actor(viewer: Viewer): string {
    return `${String(viewer.role)}:${viewer.userId}`;
  }

  private async refusedAccess(viewer: Viewer, code: string): Promise<LetterRefusal> {
    await appendEvent(this.journal, { type: 'acces.refuse', actor: this.actor(viewer), subject: null, data: { rule: 'R16', role: String(viewer.role), kind: 'neighbourhood_letter', code } }, this.now);
    return { ok: false, rule: 'R16', code };
  }

  /**
   * L'agent qui suit le bien prépare une campagne. Tout est contrôlé avant la première écriture ; un refus est écrit au
   * journal avec sa règle, sans adresse [R13].
   */
  async createCampaign(viewer: Viewer, input: unknown): Promise<LetterResult<{ campaignId: string; letters: number; textBy: 'ia' | 'secours' }>> {
    if (viewer.role !== 'agent') return this.refusedAccess(viewer, 'role');
    const blocked = await agentBlocked(this.db, viewer, this.now());
    if (blocked) return this.refusedAccess(viewer, blocked);
    const stop = async (rule: LetterRefusal['rule'], code: string, index?: number): Promise<LetterRefusal> => {
      await appendEvent(this.journal, { type: 'lettres_quartier.refusee', actor: this.actor(viewer), subject: null, data: { rule, code, ...(index === undefined ? {} : { index }) } }, this.now);
      return { ok: false, rule, code, ...(index === undefined ? {} : { index }) };
    };
    if (input === null || typeof input !== 'object' || Array.isArray(input)) return stop(null, 'bad_shape');
    const raw = input as Record<string, unknown>;
    if (Object.keys(raw).some((k) => !(CAMPAIGN_FIELDS as readonly string[]).includes(k))) return stop('R140', 'unknown_field');
    const { propertyId, trigger, propertyAddress, recipient, origin, addresses } = raw;
    // L'origine des adresses d'abord : jamais les ventes publiques ni une liste achetée [R37].
    if (typeof origin !== 'string') return stop('R140', 'bad_origin');
    if (FORBIDDEN_SOURCES.includes(words(origin).replace(/ /g, '_')) || isForbiddenSource(origin)) return stop('R37', 'forbidden_source');
    if (origin !== LETTER_ORIGIN) return stop('R140', 'bad_origin');
    if (typeof recipient !== 'string' || !(LETTER_RECIPIENTS as readonly string[]).includes(recipient)) return stop('R140', 'bad_recipient');
    if (typeof trigger !== 'string' || !(LETTER_TRIGGERS as readonly string[]).includes(trigger)) return stop(null, 'bad_trigger');
    if (typeof propertyId !== 'string' || propertyId.length > 64) return stop(null, 'bad_property');
    if (typeof propertyAddress !== 'string' || propertyAddress.trim().length < 5 || propertyAddress.length > 160) return stop(null, 'bad_property_address');
    if (!Array.isArray(addresses) || addresses.length === 0 || addresses.length > LETTER_MAX_ADDRESSES) return stop(null, 'bad_addresses');
    const list: { number: string; street: string; postcode: string; city: string }[] = [];
    for (const [i, a] of addresses.entries()) {
      const read = readAddress(a);
      if (!read.ok) return stop(read.rule, read.code, i);
      if (list.some((x) => words(`${x.number} ${x.street} ${x.postcode}`) === words(`${read.value.number} ${read.value.street} ${read.value.postcode}`))) return stop(null, 'duplicate_address', i);
      list.push(read.value);
    }

    // Le bien : suivi par cet agent, avec un mandat signé ou une vente rapportée [R16, R140].
    const property = await this.db.first<{ agent_id: string | null; city: string | null; postal_code: string | null }>('SELECT agent_id, city, postal_code FROM properties WHERE id = ? AND network_id = ?', [propertyId, viewer.networkId]);
    if (!property || property.agent_id !== viewer.userId) return this.refusedAccess(viewer, 'not_assigned');
    const happened =
      trigger === 'mandat'
        ? // Un mandat annulé au registre (erreur, rétractation, résiliation) n'ouvre rien.
          await this.db.first("SELECT 1 FROM mandates m WHERE m.property_id = ? AND m.network_id = ? AND NOT EXISTS (SELECT 1 FROM mandate_register r WHERE r.mandate_id = m.id AND r.kind = 'annulation') LIMIT 1", [propertyId, viewer.networkId])
        : await this.db.first('SELECT 1 FROM sale_files f JOIN sale_file_closings c ON c.file_id = f.id WHERE f.property_id = ? AND f.network_id = ? LIMIT 1', [propertyId, viewer.networkId]);
    if (!happened) return stop('R140', 'no_trigger');

    // Le rayon, vérifié adresse par adresse ; sans géocodage, rien ne peut être vérifié : refus [R140].
    if (!this.geocoder) return stop('R140', 'no_geocoder');
    const center = await this.geocoder.geocode(propertyAddress.trim());
    if (!center || center.score < LETTER_MIN_GEOCODE_SCORE) return stop(null, 'property_address_unknown');
    // Le centre est bien celui du bien : même code postal et même commune que sa fiche [R140].
    if (center.postalCode !== property.postal_code || words(center.town) !== words(property.city ?? '')) return stop('R140', 'center_not_property');
    const placed: { distance: number }[] = [];
    for (const [i, a] of list.entries()) {
      const typed = `${a.number} ${a.street} ${a.postcode} ${a.city}`;
      const g = await this.geocoder.geocode(typed);
      if (!g || g.score < LETTER_MIN_GEOCODE_SCORE) return stop(null, 'address_unknown', i);
      // L'adresse est rangée et imprimée seulement si elle est, mot pour mot, celle de la Base adresse nationale : un nom
      // glissé dans la voie ou à la place de la commune ne correspond à aucune adresse [R140].
      if (words(g.label) !== words(typed) || g.postalCode !== a.postcode || words(g.town) !== words(a.city)) return stop('R140', 'not_an_address', i);
      if (g.label === center.label || (g.banId !== null && g.banId === center.banId)) return stop('R46', 'property_itself', i);
      const d = distanceM(center, g);
      if (d > this.radiusM) return stop('R140', 'out_of_radius', i);
      placed.push({ distance: d });
    }

    // Le texte : l'IA ne voit que la sorte de campagne et la commune ; contrôlé, sinon le texte du code.
    // La voie du bien, sans son numéro ni, avec ou sans virgule, son code postal et sa commune.
    const streetOf = (address: string): string | null => address.replace(/^\s*\d+\s*(?:bis|ter|quater|[a-d])?\b\s*,?\s*/i, '').split(/,|\s\d{5}\b/)[0]?.trim() || null;
    // La voie telle que saisie et telle que la Base adresse nationale l'a corrigée : aucune des deux ne paraît [R46].
    const streets = [streetOf(propertyAddress), streetOf(center.label)].filter((x): x is string => x !== null);
    const checkText = (t: string): string | null => {
      for (const street of streets.length > 0 ? streets : [null]) {
        const problem = checkLetterText(t, street);
        if (problem !== null) return problem;
      }
      return null;
    };
    let text = letterFallback(trigger as LetterTrigger, property.city);
    let textBy: 'ia' | 'secours' = 'secours';
    if (this.drafter) {
      try {
        const proposed = (await this.drafter.draft({ trigger: trigger as LetterTrigger, city: property.city })).trim();
        const problem = checkText(proposed);
        if (problem === null) {
          text = proposed;
          textBy = 'ia';
        } else {
          await appendEvent(this.journal, { type: 'lettres_quartier.ia_refusee', actor: 'system:lettres', subject: null, data: { code: problem } }, this.now);
        }
      } catch (error) {
        await appendEvent(this.journal, { type: 'lettres_quartier.ia_en_panne', actor: 'system:lettres', subject: null, data: { error: error instanceof Error ? error.name : 'erreur' } }, this.now);
      }
    }
    if (checkText(text) !== null) return stop('R46', 'text_names_property');

    const id = this.newId();
    const at = this.now().toISOString();
    await this.db.run(
      `INSERT INTO neighbourhood_campaigns (id, network_id, agent_id, property_id, trigger, recipient, radius_m, center_lat, center_lon, text, text_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, viewer.networkId, viewer.userId, propertyId, trigger, recipient, this.radiusM, center.lat, center.lon, text, textBy, at],
    );
    for (const [i, a] of list.entries()) {
      await this.db.run(
        `INSERT INTO neighbourhood_letters (id, campaign_id, network_id, street_number, street, postcode, city, distance_m, position, deposited_at, deposited_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)`,
        [this.newId(), id, viewer.networkId, a.number, a.street, a.postcode, a.city, placed[i]!.distance, i + 1, at],
      );
    }
    await appendEvent(this.journal, { type: 'lettres_quartier.campagne', actor: this.actor(viewer), subject: `property:${propertyId}`, data: { rule: 'R140', campaign: id, letters: list.length, trigger, textBy } }, this.now);
    return { ok: true, value: { campaignId: id, letters: list.length, textBy } };
  }

  private async ownCampaign(viewer: Viewer, campaignId: string): Promise<CampaignRow | LetterRefusal> {
    if (viewer.role !== 'agent') return this.refusedAccess(viewer, 'role');
    const blocked = await agentBlocked(this.db, viewer, this.now());
    if (blocked) return this.refusedAccess(viewer, blocked);
    const c = await this.db.first<CampaignRow>('SELECT * FROM neighbourhood_campaigns WHERE id = ? AND network_id = ?', [campaignId, viewer.networkId]);
    if (!c) return this.refusedAccess(viewer, 'unknown');
    if (c.agent_id !== viewer.userId) return this.refusedAccess(viewer, 'not_assigned');
    return c;
  }

  /**
   * Les lettres d'une campagne, prêtes à imprimer : une page A4 par adresse, avec le destinataire de la liste fermée,
   * l'adresse saisie, le texte et la signature de l'agent ; les jetons du papier du système de design [R201].
   */
  async printable(viewer: Viewer, campaignId: string): Promise<LetterResult<{ html: string; letters: number }>> {
    const c = await this.ownCampaign(viewer, campaignId);
    if ('ok' in c) return c;
    const agent = await this.db.first<{ first_name: string; last_name: string }>('SELECT first_name, last_name FROM agents WHERE id = ?', [c.agent_id]);
    const letters = await this.db.all<{ street_number: string; street: string; postcode: string; city: string }>('SELECT street_number, street, postcode, city FROM neighbourhood_letters WHERE campaign_id = ? ORDER BY position', [c.id]);
    const html = renderLetters(c.recipient, c.text, agent ? `${agent.first_name} ${agent.last_name}` : '', letters.map((l) => ({ number: l.street_number, street: l.street, postcode: l.postcode, city: l.city })));
    await appendEvent(this.journal, { type: 'lettres_quartier.imprimees', actor: this.actor(viewer), subject: `property:${c.property_id}`, data: { rule: 'R16', campaign: c.id, letters: letters.length } }, this.now);
    return { ok: true, value: { html, letters: letters.length } };
  }

  /** Les lettres d'une campagne, avec leur dépôt, pour l'agent qui l'a faite. */
  async letters(viewer: Viewer, campaignId: string): Promise<LetterResult<{ letterId: string; number: string; street: string; postcode: string; city: string; distanceM: number; depositedAt: string | null }[]>> {
    const c = await this.ownCampaign(viewer, campaignId);
    if ('ok' in c) return c;
    const rows = await this.db.all<{ id: string; street_number: string; street: string; postcode: string; city: string; distance_m: number; deposited_at: string | null }>(
      'SELECT id, street_number, street, postcode, city, distance_m, deposited_at FROM neighbourhood_letters WHERE campaign_id = ? ORDER BY position',
      [c.id],
    );
    return { ok: true, value: rows.map((r) => ({ letterId: r.id, number: r.street_number, street: r.street, postcode: r.postcode, city: r.city, distanceM: Number(r.distance_m), depositedAt: r.deposited_at })) };
  }

  /**
   * Ce que l'écran « Gagner des mandats » montre à l'agent (G13) : ses campagnes, chacune avec le compte de ses lettres
   * et de celles déjà déposées, et les biens qu'il suit qui peuvent en ouvrir une, avec les seuls événements permis : un
   * mandat signé et jamais annulé au registre, ou une vente rapportée [R140]. Aucune adresse de lettre n'est rendue ici ;
   * la lecture est au journal, sans donnée [R16, R13].
   */
  async overview(viewer: Viewer): Promise<
    LetterResult<{
      campaigns: { campaignId: string; propertyId: string; reference: string; trigger: LetterTrigger; recipient: LetterRecipient; createdAt: string; letters: number; deposited: number }[];
      properties: { propertyId: string; reference: string; city: string | null; triggers: LetterTrigger[] }[];
    }>
  > {
    if (viewer.role !== 'agent') return this.refusedAccess(viewer, 'role');
    const blocked = await agentBlocked(this.db, viewer, this.now());
    if (blocked) return this.refusedAccess(viewer, blocked);
    const campaigns = await this.db.all<{ id: string; property_id: string; reference: string; trigger: LetterTrigger; recipient: LetterRecipient; created_at: string; letters: number; deposited: number }>(
      `SELECT c.id, c.property_id, p.reference, c.trigger, c.recipient, c.created_at,
              (SELECT count(*) FROM neighbourhood_letters l WHERE l.campaign_id = c.id) AS letters,
              (SELECT count(*) FROM neighbourhood_letters l WHERE l.campaign_id = c.id AND l.deposited_at IS NOT NULL) AS deposited
         FROM neighbourhood_campaigns c JOIN properties p ON p.id = c.property_id AND p.network_id = c.network_id
        WHERE c.network_id = ? AND c.agent_id = ? ORDER BY c.created_at DESC, c.id`,
      [viewer.networkId, viewer.userId],
    );
    const properties = await this.db.all<{ id: string; reference: string; city: string | null; mandat: number; vente: number }>(
      `SELECT p.id, p.reference, p.city,
              EXISTS (SELECT 1 FROM mandates m WHERE m.property_id = p.id AND m.network_id = p.network_id
                        AND NOT EXISTS (SELECT 1 FROM mandate_register r WHERE r.mandate_id = m.id AND r.kind = 'annulation')) AS mandat,
              EXISTS (SELECT 1 FROM sale_files f JOIN sale_file_closings c ON c.file_id = f.id WHERE f.property_id = p.id AND f.network_id = p.network_id) AS vente
         FROM properties p WHERE p.network_id = ? AND p.agent_id = ? ORDER BY p.reference, p.id`,
      [viewer.networkId, viewer.userId],
    );
    await appendEvent(this.journal, { type: 'lettres_quartier.liste_lue', actor: this.actor(viewer), subject: `agent:${viewer.userId}`, data: { rule: 'R16', campaigns: campaigns.length } }, this.now);
    return {
      ok: true,
      value: {
        campaigns: campaigns.map((c) => ({ campaignId: c.id, propertyId: c.property_id, reference: c.reference, trigger: c.trigger, recipient: c.recipient, createdAt: c.created_at, letters: Number(c.letters), deposited: Number(c.deposited) })),
        properties: properties
          .map((p) => ({ propertyId: p.id, reference: p.reference, city: p.city, triggers: LETTER_TRIGGERS.filter((t) => Number(t === 'mandat' ? p.mandat : p.vente) === 1) }))
          .filter((p) => p.triggers.length > 0),
      },
    };
  }

  /** L'agent note qu'il a déposé une lettre ; une fois. */
  async deposited(viewer: Viewer, letterId: string): Promise<LetterResult<{ depositedAt: string }>> {
    if (viewer.role !== 'agent') return this.refusedAccess(viewer, 'role');
    const blocked = await agentBlocked(this.db, viewer, this.now());
    if (blocked) return this.refusedAccess(viewer, blocked);
    const l = await this.db.first<{ campaign_id: string; deposited_at: string | null }>('SELECT campaign_id, deposited_at FROM neighbourhood_letters WHERE id = ? AND network_id = ?', [letterId, viewer.networkId]);
    if (!l) return this.refusedAccess(viewer, 'unknown');
    const c = await this.ownCampaign(viewer, l.campaign_id);
    if ('ok' in c) return c;
    if (l.deposited_at !== null) return { ok: true, value: { depositedAt: l.deposited_at } };
    const at = this.now().toISOString();
    await this.db.run('UPDATE neighbourhood_letters SET deposited_at = ?, deposited_by = ? WHERE id = ? AND deposited_at IS NULL', [at, this.actor(viewer), letterId]);
    await appendEvent(this.journal, { type: 'lettres_quartier.deposee', actor: this.actor(viewer), subject: `property:${c.property_id}`, data: { campaign: c.id, letter: letterId } }, this.now);
    return { ok: true, value: { depositedAt: at } };
  }
}

/**
 * Les lettres à imprimer : une page A4 par adresse, avec le destinataire de la liste fermée, l'adresse saisie, le texte
 * et la signature de l'agent ; les jetons du papier du système de design [R201]. Tout est échappé ici.
 */
export function renderLetters(recipient: LetterRecipient, text: string, agentName: string, letters: readonly { number: string; street: string; postcode: string; city: string }[]): string {
  const who = LETTER_RECIPIENT_LABELS[recipient];
  const pages = letters
    .map(
      (l) =>
        `<article class="lettre"><p class="marque">AIMMO</p><address class="dest">${escape(who)}<br>${escape(l.number)} ${escape(l.street)}<br>${escape(l.postcode)} ${escape(l.city)}</address>` +
        `<p>Madame, Monsieur,</p><p>${escape(text)}</p><p class="signe">${escape(agentName)}<br>Agent immobilier, réseau AIMMO</p></article>`,
    )
    .join('');
  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<title>Lettres de quartier</title>
<style>${LETTER_CSS}</style>
</head>
<body><main><h1 class="cache">Lettres de quartier</h1>${pages}</main></body>
</html>`;
}

/** La feuille des lettres : la base du papier du système de design, puis des règles qui ne lisent que ses jetons. */
export const LETTER_CSS =
  PRINT_DESIGN_CSS +
  `@page{size:A4;margin:0}
body{font:11pt/1.5 var(--police-titre)}
.cache{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
.lettre{width:210mm;min-height:297mm;padding:20mm 22mm;break-after:page;page-break-after:always}
.lettre:last-child{break-after:auto;page-break-after:auto}
.marque{font:600 8pt/1 var(--police-texte);letter-spacing:.12em;text-transform:uppercase;color:var(--accent);border-bottom:1pt solid var(--accent);padding-bottom:4mm;margin:0 0 18mm}
.dest{font-style:normal;margin:0 0 18mm 95mm;line-height:1.4}
.signe{margin-top:12mm;border-top:1pt solid var(--trait);padding-top:3mm}`;
