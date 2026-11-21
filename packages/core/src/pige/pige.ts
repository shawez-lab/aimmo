/**
 * Pige des annonces de particuliers (HX11) [R273, R274, R275, R01 à R05].
 *
 * - Une source de pige (port) rend des annonces de particuliers. Seules entrent celles d'une commune couverte par une
 *   zone d'un agent du réseau. Le texte de l'annonce n'est lu que pour y chercher la mention « pas d'agence », puis
 *   oublié ; aucun nom, numéro, mail ni adresse du particulier n'est accepté ni gardé [R273, R13].
 * - Une annonce marquée « pas d'agence », par la case de la source ou par ses mots (liste fermée), n'entre jamais dans
 *   la file : seule l'empreinte du bien est gardée, pour que le même bien vu sur un autre site, avant ou après, n'y entre
 *   pas non plus et n'ait jamais de message. La base le vérifie aussi [R273].
 * - Jamais vu : pour chaque bien de la file, l'écart de son prix au mètre carré avec le prix médian des ventes de la
 *   commune et de la sorte, lu dans la dernière version publiée des prix regroupés (AT01), avec sa source et la date de
 *   sa dernière vente. Sans case publiée : « marché non chiffré », jamais un chiffre deviné [R274].
 * - Et un premier message utile, écrit par le code avec les seuls chiffres de l'annonce et de cette case, vérifié par
 *   `checkText` [R06 à R10], préparé une seule fois par bien [R05]. Seul l'agent de la zone le valide. Par la
 *   messagerie de l'annonce, il lui est remis à coller lui-même, dans les heures d'envoi [R01] ; par téléphone, SMS,
 *   WhatsApp ou mail, la décision unique du contrôle central refuse faute d'accord préalable [R03]. Un non ou un stop du
 *   particulier ferme ce bien pour toujours [R04, R02]. AIMMO n'envoie rien : ce module n'a aucun canal [R275].
 *
 * Un bien se reconnaît d'un site à l'autre seulement sur preuve (AU035) [R672] : même sorte, code postal, commune,
 * surface à 1 m² près et même nombre de pièces, dit des deux côtés. Deux annonces dont les pièces diffèrent restent deux
 * biens, même de même surface dans la même commune : rien ne passe de l'une à l'autre. Quand un site tait les pièces, le
 * doute ne réunit rien (deux biens dans la file), mais il ferme plus, jamais moins : un « pas d'agence », un non ou un
 * message de l'une tient l'autre fermée, sans jamais se ranger sur elle, pour que le doute ne passe pas d'un bien à un
 * troisième.
 * Décidé (2026-11-07), lecture prudente : répondre à l'annonce par sa propre messagerie, message collé par l'agent, est
 * tenu pour hors du champ de R03, qui vise le téléphone, le SMS, WhatsApp et le mail ; à faire confirmer (H58).
 * Rien ne change ni ne s'efface [R17] ; chaque mouvement au journal, sans donnée du particulier [R13].
 */
import type { Viewer } from '../acces/droits.ts';
import { agentState } from '../acces/etat-agent.ts';
import { communeSlug } from '../attirer/liste-biens.ts';
import type { CommunePrices } from '../attirer/prix-versions.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { decideSend, DEFAULT_SEND_SETTINGS } from '../envoi/decision.ts';
import { localTime } from '../envoi/horaires.ts';
import { checkText, plain } from '../envoi/texte.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';

export const PIGE_KINDS = ['apartment', 'house'] as const;
export type PigeKind = (typeof PIGE_KINDS)[number];

/** Canaux possibles d'un premier message. `annonce` : la messagerie de l'annonce, où l'agent colle le texte. */
export const PIGE_CHANNELS = ['annonce', 'phone', 'sms', 'whatsapp', 'email'] as const;
export type PigeChannel = (typeof PIGE_CHANNELS)[number];

/** La finalité de l'accord demandé à la décision unique [R03]. */
export const PIGE_PURPOSE = 'pige_particulier';

/** Une annonce plus vieille que ce nombre de jours sort de la file. Réglage. */
export const PIGE_MAX_AGE_DAYS = 60;
const DAY = 86_400_000;

/**
 * Les mots qui disent « pas d'agence », sur le texte ramené en minuscules sans accents. Liste fermée, prudente : un
 * doute écarte l'annonce [R273]. « Pas de frais d'agence » n'en est pas un.
 */
export const NO_AGENCY_PATTERNS: readonly RegExp[] = Object.freeze([
  /\bpas d'agences?\b/,
  /\bsans agences?\b/,
  /\baucune agence\b/,
  /\bni agences?\b/,
  /\bagences? (?:immobilieres? )?(?:s'abstenir|non merci|merci de s'abstenir|s'abstiennent|exclues?|interdites?)\b/,
  /\bpas de demarchage\b/,
  /\b(?:demarchage|intermediaires?) (?:interdit|non merci|s'abstenir)\b/,
  /\bentre particuliers uniquement\b/,
  /\bparticuliers? (?:a particuliers? )?uniquement\b/,
  /\bno agenc(?:y|ies)\b/,
]);

/** Vrai si le texte de l'annonce refuse les agences [R273]. */
export function saysNoAgency(text: string): boolean {
  const p = plain(text).replace(/\s+/g, ' ');
  return NO_AGENCY_PATTERNS.some((r) => r.test(p));
}

/** Une annonce telle que la rend la source. Le texte n'est jamais gardé ; toute autre clé est ignorée. */
export interface RawAd {
  source: unknown;
  sourceRef: unknown;
  kind: unknown;
  commune: unknown;
  postalCode: unknown;
  surfaceM2: unknown;
  rooms?: unknown;
  priceEur: unknown;
  publishedAt: unknown;
  /** La case « pas d'agence » de la source, quand elle en a une. */
  noAgency?: unknown;
  /** Le texte de l'annonce, lu seulement pour la mention « pas d'agence ». */
  text?: unknown;
  /** La classe énergie affichée par l'annonce, quand elle la dit (HX18). */
  energyClass?: unknown;
  /** La date du diagnostic affichée par l'annonce, `AAAA-MM-JJ`, quand elle la dit (HX18). */
  diagnosedOn?: unknown;
}

export const PIGE_ENERGY_CLASSES = ['A', 'B', 'C', 'D', 'E', 'F', 'G'] as const;
export type PigeEnergyClass = (typeof PIGE_ENERGY_CLASSES)[number];

/** La source de pige : un fournisseur, branché plus tard. */
export interface PigeSource {
  ads(networkId: string, since: Date): Promise<readonly RawAd[]>;
}

/** Les prix regroupés de la commune, lus comme le site les lit (AT01). */
export interface MarketPrices {
  communePrices(networkId: string, communeSlug: string): Promise<CommunePrices | null>;
}

export interface MarketGap {
  /** Prix de l'annonce au mètre carré, arrondi à l'euro. */
  adPerM2: number;
  medianPerM2: number;
  /** Écart en pour cent, arrondi : positif quand l'annonce est au-dessus du marché. */
  gapPct: number;
  sales: number;
  source: string;
  dvfLastSale: string;
}

export interface PigeEntry {
  adId: string;
  source: string;
  kind: PigeKind;
  commune: string;
  postalCode: string;
  surfaceM2: number;
  rooms: number | null;
  priceEur: number;
  publishedAt: string;
  /** Sur combien de sites ce même bien a été vu. */
  sites: number;
  market: MarketGap | { unpriced: true; reason: 'marche_non_chiffre' };
  draft: { id: string; body: string; handed: boolean } | null;
}

type Refusal = { ok: false; rule: 'R16'; code: string };
type Problem = { ok: false; rule: 'R273' | 'R275' | 'R01' | 'R02' | 'R03' | 'R04' | 'R05' | 'R10' | null; code: string; reason?: string };

const SOURCE = /^[\p{L}\p{N}][\p{L}\p{N} .'’-]{1,59}$/u;
const SOURCE_REF = /^[A-Za-z0-9._:-]{1,120}$/;
const POSTAL = /^\d{5}$/;
const COMMUNE = /^[\p{L}][\p{L} '’-]{0,79}$/u;

interface CleanAd {
  source: string;
  sourceRef: string;
  kind: PigeKind;
  commune: string;
  postalCode: string;
  surfaceM2: number;
  rooms: number | null;
  priceEur: number;
  publishedAt: string;
  noAgency: boolean;
  /** Classe énergie et date du diagnostic dites par l'annonce ; une valeur illisible est tue, jamais devinée (HX18). */
  energyClass: PigeEnergyClass | null;
  diagnosedOn: string | null;
}

/** Au plus tant de pièces lues sur une annonce. */
export const MAX_ROOMS = 40;

const intIn = (v: unknown, min: number, max: number): number | null =>
  typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? Math.round(v) : null;

/**
 * Ce qui suffit à fermer le bien d'une annonce qui dit « pas d'agence », lu avant tout le reste : sa clé sur son site,
 * dès que la source et la référence se lisent, et le bien (sorte, code postal, commune, surface) quand il se lit. Un
 * prix, une date ou une surface manquants n'empêchent jamais de fermer ce qui se reconnaît [R273].
 */
export function noAgencyKey(raw: RawAd): { key: PropertyKey | null; ref: AdRef | null } | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const says = raw.noAgency === true || (typeof raw.text === 'string' && saysNoAgency(raw.text));
  if (!says) return null;
  const ref = readRef(raw);
  const key = readPropertyKey(raw);
  if (!key && !ref) return null;
  return { key, ref };
}

export type PropertyKey = Pick<CleanAd, 'kind' | 'postalCode' | 'commune' | 'surfaceM2' | 'rooms'>;
export interface AdRef {
  source: string;
  sourceRef: string;
}

/** La source et la référence d'une annonce, quand elles se lisent. */
export function readRef(raw: RawAd): AdRef | null {
  if (typeof raw !== 'object' || raw === null) return null;
  return typeof raw.source === 'string' && SOURCE.test(raw.source.trim()) && typeof raw.sourceRef === 'string' && SOURCE_REF.test(raw.sourceRef)
    ? { source: raw.source.trim(), sourceRef: raw.sourceRef }
    : null;
}

/** Sorte, code postal, commune et surface, quand ils se lisent, même sans prix ni date ; les pièces quand elles se lisent. */
export function readPropertyKey(raw: RawAd): PropertyKey | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const { kind, commune, postalCode } = raw;
  const surfaceM2 = intIn(raw.surfaceM2, 8, 2000);
  return typeof kind === 'string' && (PIGE_KINDS as readonly string[]).includes(kind) && typeof commune === 'string' && COMMUNE.test(commune.trim()) && typeof postalCode === 'string' && POSTAL.test(postalCode) && surfaceM2 !== null
    ? { kind: kind as PigeKind, postalCode, commune: commune.trim().replace(/\s+/g, ' '), surfaceM2, rooms: intIn(raw.rooms, 1, MAX_ROOMS) }
    : null;
}

/** Lit une annonce reçue ; rend null quand elle n'est pas utilisable. */
export function cleanAd(raw: RawAd, now: Date): CleanAd | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const { source, sourceRef, kind, commune, postalCode, publishedAt } = raw;
  if (typeof source !== 'string' || !SOURCE.test(source.trim())) return null;
  if (typeof sourceRef !== 'string' || !SOURCE_REF.test(sourceRef)) return null;
  if (typeof kind !== 'string' || !(PIGE_KINDS as readonly string[]).includes(kind)) return null;
  if (typeof commune !== 'string' || !COMMUNE.test(commune.trim())) return null;
  if (typeof postalCode !== 'string' || !POSTAL.test(postalCode)) return null;
  const surfaceM2 = intIn(raw.surfaceM2, 8, 2000);
  const priceEur = intIn(raw.priceEur, 1000, 50_000_000);
  if (surfaceM2 === null || priceEur === null) return null;
  const rooms = raw.rooms === undefined || raw.rooms === null ? null : intIn(raw.rooms, 1, MAX_ROOMS);
  if (raw.rooms !== undefined && raw.rooms !== null && rooms === null) return null;
  if (typeof publishedAt !== 'string') return null;
  const at = Date.parse(publishedAt);
  if (Number.isNaN(at) || at > now.getTime()) return null;
  const noAgency = raw.noAgency === true || (typeof raw.text === 'string' && saysNoAgency(raw.text));
  const ec = typeof raw.energyClass === 'string' ? raw.energyClass.trim().toUpperCase() : '';
  const energyClass = (PIGE_ENERGY_CLASSES as readonly string[]).includes(ec) ? (ec as PigeEnergyClass) : null;
  const dd = typeof raw.diagnosedOn === 'string' ? raw.diagnosedOn.trim().slice(0, 10) : '';
  const ddAt = /^\d{4}-\d{2}-\d{2}$/.test(dd) ? Date.parse(`${dd}T12:00:00.000Z`) : Number.NaN;
  // Une date de diagnostic se garde même sans classe, jamais après l'annonce.
  const diagnosedOn = Number.isFinite(ddAt) && new Date(ddAt).toISOString().slice(0, 10) === dd && ddAt <= at + DAY ? dd : null;
  return {
    source: source.trim(),
    sourceRef,
    kind: kind as PigeKind,
    commune: commune.trim().replace(/\s+/g, ' '),
    postalCode,
    surfaceM2,
    rooms,
    priceEur,
    publishedAt: new Date(at).toISOString(),
    noAgency,
    energyClass,
    diagnosedOn,
  };
}

async function sha256(text: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Ce qui fait l'empreinte d'un bien ; des pièces tues ou absentes valent « non dites ». */
export type FingerprintInput = Pick<CleanAd, 'kind' | 'postalCode' | 'commune' | 'surfaceM2'> & { rooms?: number | null };

/**
 * L'empreinte d'un bien, la même d'un site à l'autre et après une baisse de prix : sorte, code postal, commune, surface
 * et pièces quand elles sont dites. Ni le prix (un bien dont le prix baisse reste le même bien, sans second message
 * [R05]). Sans pièces, l'empreinte est celle d'avant AU035 : ce qui a été fermé avant reste fermé pour tout bien qui
 * pourrait être celui-là [R672].
 */
export function adFingerprint(ad: FingerprintInput): Promise<string> {
  const parts: (string | number)[] = ['pige', ad.kind, ad.postalCode, communeSlug(ad.commune), ad.surfaceM2];
  if (typeof ad.rooms === 'number') parts.push(`p${ad.rooms}`);
  return sha256(parts.join('|'));
}

/** Écart de surface d'un site à l'autre tenu pour le même bien, en m², pour fermer un bien ou éviter un second message. */
export const SURFACE_TOLERANCE_M2 = 1;

/**
 * Les empreintes du même bien prouvé, à la surface près et aux mêmes pièces : celles où se range un « pas d'agence », un
 * non ou un message [R672].
 */
export async function nearFingerprints(ad: FingerprintInput): Promise<string[]> {
  const out: string[] = [];
  for (let d = -SURFACE_TOLERANCE_M2; d <= SURFACE_TOLERANCE_M2; d += 1) out.push(await adFingerprint({ ...ad, surfaceM2: ad.surfaceM2 + d, rooms: ad.rooms ?? null }));
  return out;
}

/**
 * Les empreintes des biens qui pourraient être celui-ci faute de pièces dites d'un côté : à la surface près, le bien
 * sans pièces quand celui-ci les dit, et chaque nombre de pièces quand il les tait. Lues pour fermer, jamais pour
 * ranger ni pour réunir [R672, R273].
 */
export async function doubtFingerprints(ad: FingerprintInput): Promise<string[]> {
  const rooms: (number | null)[] = typeof ad.rooms === 'number' ? [null] : [null, ...Array.from({ length: MAX_ROOMS }, (_, i) => i + 1)];
  const out: string[] = [];
  for (const r of rooms) out.push(...(await nearFingerprints({ ...ad, rooms: r })));
  return out;
}

/**
 * L'empreinte rangée avec une relève : celle du bien quand ses pièces sont dites ; propre à l'annonce quand elle les
 * tait, pour que deux annonces sans pièces ne soient jamais réunies. L'empreinte du bien sans pièces reste celle où se
 * rangent ses fermetures, lue dans le doute par les autres [R672].
 */
export function storedFingerprint(ad: FingerprintInput & AdRef): Promise<string> {
  if (typeof ad.rooms === 'number') return adFingerprint(ad);
  return sha256(['pige-sans-pieces', ad.kind, ad.postalCode, communeSlug(ad.commune), ad.surfaceM2, ad.source, ad.sourceRef].join('|'));
}

const KIND_WORD: Record<PigeKind, { noun: string; plural: string }> = {
  apartment: { noun: 'appartement', plural: 'appartements' },
  house: { noun: 'maison', plural: 'maisons' },
};

const euros = (n: number): string => n.toLocaleString('fr-FR').replace(/[  ]/g, ' ');

/** Le premier message, écrit par le code : il sert le particulier avant de parler de l'agent [R275]. */
export function firstMessage(input: { kind: PigeKind; commune: string; surfaceM2: number; agentFirstName: string; market: MarketGap | null }): string {
  const w = KIND_WORD[input.kind];
  const article = input.kind === 'house' ? 'votre maison' : 'votre appartement';
  const lines = [`Bonjour, j’ai vu l’annonce de ${article} de ${input.surfaceM2} m² à ${input.commune}.`];
  if (input.market) {
    lines.push(
      `Pour vous situer : le prix médian des ventes récentes de ${w.plural} à ${input.commune} est de ${euros(input.market.medianPerM2)} € le m², d’après les ventes publiques DVF.`,
    );
  } else {
    lines.push(`Je peux vous donner les prix des ventes récentes de ${w.plural} à ${input.commune}, d’après les ventes publiques.`);
  }
  lines.push(`Si cela vous est utile, je vous les explique en dix minutes, sans engagement de votre part.`);
  lines.push(`${input.agentFirstName}, agent immobilier`);
  return lines.join('\n');
}

export interface PigeOptions {
  now?: () => Date;
  newId?: () => string;
  /** Réglage : au plus tant d'annonces suivies pour un bien ; au-delà, tout se ferme. */
  maxLinkedAds?: number;
}

/** Une annonce ouverte, telle que la base la garde. */
export type OpenAd = AdRow & { network_id: string };
export type PigeProblem = Problem;

interface AdRow {
  id: string;
  source: string;
  fingerprint: string;
  kind: PigeKind;
  commune: string;
  postal_code: string;
  surface_m2: number;
  rooms: number | null;
  price_eur: number;
  published_at: string;
  sites: number;
}

/** La clé d'une annonce sur son site, rangée parmi les empreintes fermées : elle ferme l'annonce quelle que soit sa surface. */
export function refKey(source: string, sourceRef: string): Promise<string> {
  return sha256(['pige-ref', source, sourceRef].join('|'));
}

/** Au plus tant d'annonces suivies pour relier un bien d'un site et d'une correction à l'autre. */
export const MAX_LINKED_ADS = 400;

export class Pige {
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly maxLinkedAds: number;

  constructor(
    private readonly db: SqlDatabase,
    private readonly journal: JournalStore,
    private readonly market: MarketPrices,
    options: PigeOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => crypto.randomUUID());
    this.maxLinkedAds = options.maxLinkedAds ?? MAX_LINKED_ADS;
  }

  private actor(viewer: Viewer): string {
    return `${String(viewer.role)}:${viewer.userId}`;
  }

  private async refuse(viewer: Viewer, subject: string, code: string): Promise<Refusal> {
    await appendEvent(this.journal, { type: 'acces.refuse', actor: this.actor(viewer), subject, data: { rule: 'R16', role: String(viewer.role), kind: 'pige', code } }, this.now);
    return { ok: false, rule: 'R16', code };
  }

  /** Les communes des zones en cours du réseau, ou d'un seul agent, ramenées à leur forme simple. */
  private async zoneCommunes(networkId: string, agentId?: string): Promise<Map<string, string>> {
    const rows = await this.db.all<{ commune: string }>(
      `SELECT commune FROM agent_zones WHERE network_id = ? AND ended_at IS NULL ${agentId ? 'AND agent_id = ?' : ''}`,
      agentId ? [networkId, agentId] : [networkId],
    );
    return new Map(rows.map((r) => [communeSlug(r.commune), r.commune]));
  }

  /** Un agent du réseau en activité ; la direction lit la file de tout le réseau mais ne signe aucun message. */
  private async gate(viewer: Viewer, subject: string, agentOnly: boolean): Promise<Refusal | null> {
    if (viewer.role !== 'agent' && (agentOnly || viewer.role !== 'direction')) return this.refuse(viewer, subject, 'role');
    if (viewer.role === 'agent') {
      const a = await this.db.first<{ id: string }>('SELECT id FROM agents WHERE id = ? AND network_id = ?', [viewer.userId, viewer.networkId]);
      if (!a || (await agentState(this.db, viewer.networkId, viewer.userId, this.now())) !== 'actif') return this.refuse(viewer, subject, 'agent_inactive');
    }
    return null;
  }

  /**
   * Range les annonces d'un passage. Rend combien sont entrées, combien ont été écartées « pas d'agence », combien hors
   * des zones ou illisibles. Rejouée, rien ne double.
   */
  async ingest(networkId: string, raws: readonly RawAd[]): Promise<{ added: number; noAgency: number; outside: number; unreadable: number }> {
    const now = this.now();
    const zones = await this.zoneCommunes(networkId);
    let added = 0;
    let noAgency = 0;
    let outside = 0;
    let unreadable = 0;
    for (const raw of raws) {
      // « Pas d'agence » d'abord, même sur une annonce incomplète : seule l'empreinte reste, et le même bien déjà entré
      // par un autre site sort de la file avec elle [R273].
      const closing = noAgencyKey(raw);
      if (closing) {
        const keys: string[] = [];
        // L'annonce elle-même sur son site, quelle que soit la surface qu'elle a portée ou portera, dès que sa source et
        // sa référence se lisent : une empreinte seule, sans rien d'elle, même vue pour la première fois incomplète.
        if (closing.ref) keys.push(await refKey(closing.ref.source, closing.ref.sourceRef));
        // Le bien dit, à 1 m² près, dans une commune du réseau.
        if (closing.key && zones.get(communeSlug(closing.key.commune))) keys.push(...(await nearFingerprints(closing.key)));
        // Et le bien que cette annonce a déjà porté sur son site, à 1 m² près : la base le voit fermé sans calculer de clé (HX18).
        if (closing.ref) {
          const before = await this.db.all<{ fingerprint: string; kind: PigeKind; postal_code: string; commune: string; surface_m2: number; rooms: number | null }>(
            'SELECT DISTINCT fingerprint, kind, postal_code, commune, surface_m2, rooms FROM pige_ads WHERE network_id = ? AND source = ? AND source_ref = ?',
            [networkId, closing.ref.source, closing.ref.sourceRef],
          );
          for (const b of before) {
            keys.push(b.fingerprint);
            if (b.rooms !== null) keys.push(...(await nearFingerprints({ kind: b.kind, postalCode: b.postal_code, commune: b.commune, surfaceM2: b.surface_m2, rooms: b.rooms })));
          }
        }
        if (keys.length === 0) {
          outside += 1;
          continue;
        }
        for (const f of keys) {
          await this.db.run('INSERT OR IGNORE INTO pige_no_agency (network_id, fingerprint, noted_at) VALUES (?, ?, ?)', [networkId, f, now.toISOString()]);
        }
        noAgency += 1;
        continue;
      }
      // Avant d'exiger une annonce complète : si sa clé ou son bien, dès qu'ils se lisent, sont déjà fermés (« pas
      // d'agence » ou non du particulier), la fermeture passe à l'autre, pour qu'une correction plus tard ne rouvre rien ;
      // rien d'autre n'est gardé de cette annonce [R273, R04].
      if (await this.carryClosures(networkId, raw, now)) {
        noAgency += 1;
        continue;
      }
      const ad = cleanAd(raw, now);
      if (!ad) {
        unreadable += 1;
        continue;
      }
      const commune = zones.get(communeSlug(ad.commune));
      if (!commune) {
        outside += 1;
        continue;
      }
      if (ad.noAgency) {
        noAgency += 1;
        continue;
      }
      const fingerprint = await storedFingerprint(ad);
      const adId = this.newId();
      const r = await this.db.run(
        `INSERT INTO pige_ads (id, network_id, source, source_ref, fingerprint, kind, commune, postal_code, surface_m2, rooms, price_eur, published_at, collected_at)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
          WHERE NOT EXISTS (SELECT 1 FROM pige_no_agency WHERE network_id = ? AND fingerprint = ?)
            AND (coalesce((SELECT price_eur FROM pige_ads WHERE network_id = ? AND source = ? AND source_ref = ? ORDER BY collected_at DESC, rowid DESC LIMIT 1), -1) <> ?
              OR coalesce((SELECT published_at || '|' || fingerprint || '|' || coalesce(rooms, '') FROM pige_ads WHERE network_id = ? AND source = ? AND source_ref = ? ORDER BY collected_at DESC, rowid DESC LIMIT 1), '') <> ?
              -- Une classe ou une date de diagnostic changée est aussi une nouvelle relève (HX18).
              OR coalesce((SELECT coalesce(e.energy_class, '') || '|' || coalesce(e.diagnosed_on, '') FROM pige_ads b LEFT JOIN pige_ad_energy e ON e.ad_id = b.id WHERE b.network_id = ? AND b.source = ? AND b.source_ref = ? ORDER BY b.collected_at DESC, b.rowid DESC LIMIT 1), '|') <> ?)`,
        [
          adId, networkId, ad.source, ad.sourceRef, fingerprint, ad.kind, commune, ad.postalCode, ad.surfaceM2, ad.rooms, ad.priceEur, ad.publishedAt, now.toISOString(),
          networkId, fingerprint, networkId, ad.source, ad.sourceRef, ad.priceEur, networkId, ad.source, ad.sourceRef, `${ad.publishedAt}|${fingerprint}|${ad.rooms ?? ''}`,
          networkId, ad.source, ad.sourceRef, `${ad.energyClass ?? ''}|${ad.diagnosedOn ?? ''}`,
        ],
      );
      added += r.changes;
      // Le jour où l'annonce est vue en ligne, même à prix inchangé : son relevé et sa durée en ligne (HX32) [R303].
      await this.db.run(
        `INSERT OR IGNORE INTO pige_ad_sightings (network_id, source, source_ref, seen_on)
         SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM pige_ads WHERE network_id = ? AND source = ? AND source_ref = ?)`,
        [networkId, ad.source, ad.sourceRef, localTime(now, 'Europe/Paris').date, networkId, ad.source, ad.sourceRef],
      );
      // Ce que l'annonce dit du diagnostic, rangé à part avec elle, pour proposer son adresse (HX18).
      if (r.changes === 1 && (ad.energyClass || ad.diagnosedOn)) {
        await this.db.run('INSERT INTO pige_ad_energy (ad_id, network_id, energy_class, diagnosed_on) VALUES (?, ?, ?, ?)', [adId, networkId, ad.energyClass, ad.diagnosedOn]);
      }
    }
    await appendEvent(this.journal, { type: 'pige.collectee', actor: 'system:pige', subject: `network:${networkId}`, data: { rule: 'R273', added, noAgency, outside, unreadable } }, this.now);
    return { added, noAgency, outside, unreadable };
  }

  /**
   * Fait passer une fermeture déjà rangée entre la clé d'une annonce et son bien (à 1 m² près), dans les deux sens, pour
   * « pas d'agence » comme pour un non. Rend vrai si l'annonce est fermée : elle n'entre pas.
   */
  private async carryClosures(networkId: string, raw: RawAd, now: Date): Promise<boolean> {
    const ref = readRef(raw);
    const key = readPropertyKey(raw);
    const keys: string[] = [];
    // Ce qui pourrait être ce bien faute de pièces dites : lu pour fermer, jamais pour ranger [R672].
    let marks: string[] = [];
    let provenKeys: string[] = [];
    if (ref) keys.push(await refKey(ref.source, ref.sourceRef));
    // Ce que cette annonce a déjà porté sur son site : le parcours part aussi de là.
    const before = ref
      ? (await this.db.all<{ fingerprint: string }>('SELECT DISTINCT fingerprint FROM pige_ads WHERE network_id = ? AND source = ? AND source_ref = ?', [networkId, ref.source, ref.sourceRef])).map((r) => r.fingerprint)
      : [];
    // Le bien et tout ce qui lui est relié sur preuve, de proche en proche, clés des annonces comprises.
    if (key || before.length > 0) {
      // Un bien sans pièces dites ne relie rien sur preuve : ses empreintes ne sont lues que dans le doute [R672].
      const proven = key && key.rooms !== null ? await nearFingerprints(key) : [];
      const seeds = [...proven, ...before];
      const start = key ? (ref ? await storedFingerprint({ ...key, ...ref }) : await adFingerprint(key)) : (before[0] ?? '');
      // Le doute vient de ce que l'annonce dit aujourd'hui, jamais de ce qu'elle a tu avant d'être corrigée [R672].
      const l = await this.linked(networkId, start, seeds, key ? await this.doubtsOf(networkId, key, ref) : [], ref);
      // Trop relié pour être suivi en entier : l'annonce n'entre pas, et sa clé et son bien sont fermés pour de bon, par
      // prudence, pour qu'une correction plus tard ne les rouvre pas [R273].
      if (!l.complete) {
        const closeAll = [...keys, ...proven];
        for (const f of closeAll) {
          await this.db.run('INSERT OR IGNORE INTO pige_no_agency (network_id, fingerprint, noted_at) VALUES (?, ?, ?)', [networkId, f, now.toISOString()]);
        }
        return true;
      }
      keys.push(...l.keys);
      marks = l.marks;
      provenKeys = proven;
    }
    if (keys.length === 0) return false;
    let closed = false;
    for (const table of ['pige_no_agency', 'pige_oppositions'] as const) {
      const hit = await this.db.first(`SELECT 1 AS x FROM ${table} WHERE network_id = ? AND fingerprint IN (SELECT value FROM json_each(?))`, [networkId, JSON.stringify(keys)]);
      if (!hit) {
        // Fermé seulement dans le doute : l'annonce n'entre pas, mais rien n'est rangé sur elle. Le jour où ses pièces se
        // disent et la séparent du bien fermé, elle entre [R672].
        if (marks.length > 0 && (await this.db.first(`SELECT 1 AS x FROM ${table} WHERE network_id = ? AND fingerprint IN (SELECT value FROM json_each(?))`, [networkId, JSON.stringify(marks)]))) closed = true;
        continue;
      }
      closed = true;
      const all = [...new Set([...keys, ...provenKeys])];
      for (const f of all) {
        await this.db.run(
          table === 'pige_no_agency'
            ? 'INSERT OR IGNORE INTO pige_no_agency (network_id, fingerprint, noted_at) VALUES (?, ?, ?)'
            : "INSERT OR IGNORE INTO pige_oppositions (network_id, fingerprint, noted_by, noted_at) VALUES (?, ?, 'system:pige', ?)",
          [networkId, f, now.toISOString()],
        );
      }
    }
    return closed;
  }

  /** Un passage de la source : les annonces des derniers jours. */
  async collect(networkId: string, source: PigeSource): Promise<{ added: number; noAgency: number; outside: number; unreadable: number }> {
    const since = new Date(this.now().getTime() - PIGE_MAX_AGE_DAYS * DAY);
    return this.ingest(networkId, await source.ads(networkId, since));
  }

  /** L'écart avec le marché, lu dans la case publiée de la commune et de la sorte, ou rien [R274]. */
  async marketGap(networkId: string, ad: { commune: string; kind: PigeKind; surfaceM2: number; priceEur: number }): Promise<MarketGap | null> {
    const prices = await this.market.communePrices(networkId, communeSlug(ad.commune));
    if (!prices) return null;
    const cell = prices.cells.find((c) => c.zone.level === 'commune' && c.kind === ad.kind);
    if (!cell || !(cell.median > 0) || !cell.source || !cell.dvfLastSale) return null;
    const adPerM2 = Math.round(ad.priceEur / ad.surfaceM2);
    return {
      adPerM2,
      medianPerM2: cell.median,
      gapPct: Math.round(((adPerM2 - cell.median) / cell.median) * 100),
      sales: cell.sales,
      source: cell.source,
      dvfLastSale: cell.dvfLastSale,
    };
  }

  /**
   * Le premier vu de chaque bien ouvert de la file, dans les communes demandées, du plus récent au plus ancien. Seule
   * compte la dernière relève de chaque annonce : une annonce dont la surface a été corrigée depuis ne garde pas
   * l'ancien bien dans la file.
   */
  private async openAds(networkId: string, communes: readonly string[]): Promise<AdRow[]> {
    if (communes.length === 0) return [];
    const since = new Date(this.now().getTime() - PIGE_MAX_AGE_DAYS * DAY).toISOString();
    return this.db.all<AdRow>(
      `WITH current AS (
         SELECT a.* FROM pige_ads a
          WHERE a.network_id = ?
            AND a.rowid = (SELECT b.rowid FROM pige_ads b WHERE b.network_id = a.network_id AND b.source = a.source AND b.source_ref = a.source_ref ORDER BY b.collected_at DESC, b.rowid DESC LIMIT 1)
       )
       SELECT a.id, a.source, a.fingerprint, a.kind, a.commune, a.postal_code, a.surface_m2, a.rooms, a.price_eur, a.published_at,
              (SELECT count(DISTINCT c.source) FROM current c WHERE c.fingerprint = a.fingerprint) AS sites
         FROM current a
        WHERE a.commune IN (SELECT value FROM json_each(?)) AND a.published_at >= ?
          AND a.id = (SELECT c.id FROM current c WHERE c.fingerprint = a.fingerprint AND c.published_at >= ? ORDER BY c.published_at, c.id LIMIT 1)
          AND NOT EXISTS (SELECT 1 FROM pige_no_agency n WHERE n.network_id = a.network_id AND n.fingerprint = a.fingerprint)
          AND NOT EXISTS (SELECT 1 FROM pige_oppositions o WHERE o.network_id = a.network_id AND o.fingerprint = a.fingerprint)
        ORDER BY a.published_at DESC, a.id`,
      [networkId, JSON.stringify(communes), since, since],
    );
  }

  /**
   * Le prix du moment d'un bien : la dernière relève de chacune de ses annonces, puis celle publiée le plus récemment
   * (à égalité, la moins chère). Une relève rejouée sans changement n'ajoute rien et ne change pas ce prix.
   */
  private async latestPrice(networkId: string, fingerprint: string): Promise<number | null> {
    const r = await this.db.first<{ price_eur: number }>(
      `SELECT a.price_eur FROM pige_ads a
        WHERE a.network_id = ? AND a.fingerprint = ?
          AND a.rowid = (SELECT b.rowid FROM pige_ads b WHERE b.network_id = a.network_id AND b.source = a.source AND b.source_ref = a.source_ref ORDER BY b.collected_at DESC, b.rowid DESC LIMIT 1)
        ORDER BY a.published_at DESC, a.price_eur ASC LIMIT 1`,
      [networkId, fingerprint],
    );
    return r?.price_eur ?? null;
  }

  /** Une annonce ouverte d'une commune de cet agent, ou la raison de la refuser (HX18). */
  async openAd(viewer: Viewer, adId: unknown): Promise<OpenAd | Problem> {
    return this.openAdFor(viewer, adId);
  }

  /** La raison qui ferme ce bien (« pas d'agence », non, trop relié), ou null (HX18). */
  async closure(networkId: string, fingerprint: string): Promise<Problem | null> {
    return this.closedReason(networkId, fingerprint);
  }

  /** Toutes les empreintes et clés reliées à ce bien, et si le parcours est complet (HX18). */
  async linkedOf(networkId: string, fingerprint: string): Promise<{ keys: string[]; complete: boolean }> {
    return this.linked(networkId, fingerprint);
  }

  /** Le prix du moment de ce bien, ou null (HX18). */
  async currentPrice(networkId: string, fingerprint: string): Promise<number | null> {
    return this.latestPrice(networkId, fingerprint);
  }

  /** La file de pige : l'agent voit les biens de ses communes ; la direction, ceux du réseau. */
  async queue(viewer: Viewer): Promise<{ ok: true; value: PigeEntry[] } | Refusal> {
    const g = await this.gate(viewer, `network:${viewer.networkId}`, false);
    if (g) return g;
    const zones = await this.zoneCommunes(viewer.networkId, viewer.role === 'agent' ? viewer.userId : undefined);
    const rows = await this.openAds(viewer.networkId, [...new Set(zones.values())]);
    const out: PigeEntry[] = [];
    for (const r of rows) {
      // Un bien fermé par une de ses annonces liées, d'un site ou d'une correction à l'autre, ne se montre pas.
      if (await this.closedReason(viewer.networkId, r.fingerprint)) continue;
      // Jamais un prix inventé : sans relève en cours, le bien ne se montre pas.
      const priceEur = await this.latestPrice(viewer.networkId, r.fingerprint);
      if (priceEur === null) continue;
      const gap = await this.marketGap(viewer.networkId, { commune: r.commune, kind: r.kind, surfaceM2: r.surface_m2, priceEur });
      const d = await this.db.first<{ id: string; body: string; agent_id: string; handed: number }>(
        'SELECT d.id, d.body, d.agent_id, EXISTS (SELECT 1 FROM pige_handovers h WHERE h.draft_id = d.id) AS handed FROM pige_drafts d WHERE d.network_id = ? AND d.fingerprint = ?',
        [viewer.networkId, r.fingerprint],
      );
      out.push({
        adId: r.id,
        source: r.source,
        kind: r.kind,
        commune: r.commune,
        postalCode: r.postal_code,
        surfaceM2: r.surface_m2,
        rooms: r.rooms,
        priceEur,
        publishedAt: r.published_at,
        sites: r.sites,
        market: gap ?? { unpriced: true, reason: 'marche_non_chiffre' },
        // Le message d'un autre agent ne se lit pas : seulement qu'il existe.
        draft: d ? (viewer.role === 'direction' || d.agent_id === viewer.userId ? { id: d.id, body: d.body, handed: d.handed === 1 } : { id: d.id, body: '', handed: d.handed === 1 }) : null,
      });
    }
    await appendEvent(this.journal, { type: 'pige.lue', actor: this.actor(viewer), subject: `network:${viewer.networkId}`, data: { rule: 'R273', count: out.length } }, this.now);
    return { ok: true, value: out };
  }

  /** L'annonce, si elle est ouverte et dans une commune de cet agent. */
  private async openAdFor(viewer: Viewer, adId: unknown): Promise<(AdRow & { network_id: string }) | Problem> {
    if (typeof adId !== 'string') return { ok: false, rule: null, code: 'unknown_ad' };
    const ad = await this.db.first<AdRow & { network_id: string }>(
      'SELECT id, network_id, source, fingerprint, kind, commune, postal_code, surface_m2, rooms, price_eur, published_at, 1 AS sites FROM pige_ads WHERE id = ? AND network_id = ?',
      [adId, viewer.networkId],
    );
    if (!ad) return { ok: false, rule: null, code: 'unknown_ad' };
    const zones = await this.zoneCommunes(viewer.networkId, viewer.userId);
    if (!zones.has(communeSlug(ad.commune))) return { ok: false, rule: null, code: 'hors_zone' };
    const closed = await this.closedReason(viewer.networkId, ad.fingerprint);
    if (closed) return closed;
    return ad;
  }

  /**
   * Tout ce qui est relié à cette empreinte, de proche en proche : les annonces qui l'ont portée, toutes les empreintes
   * qu'elles ont portées avant ou après une surface corrigée, celles à 1 m² près, et ainsi de suite. Rend ces empreintes,
   * leurs voisines et la clé de chaque annonce : un « pas d'agence », un non ou un message sur l'une vaut pour toutes
   * [R273, R04, R05].
   */
  private async linkedKeys(networkId: string, fingerprint: string, seeds: readonly string[] = []): Promise<string[]> {
    return (await this.linked(networkId, fingerprint, seeds)).keys;
  }

  /**
   * Ce qui pourrait être ce bien faute de pièces dites d'un côté : les empreintes du doute, et chaque annonce dont la
   * relève en cours est de la même sorte, du même code postal, de la même commune, de la surface à 1 m² près, et tait ses
   * pièces (ou les dit, quand ce bien tait les siennes). De ces annonces sont lues leur clé et toutes leurs empreintes,
   * anciennes comprises, pour qu'un message ou une fermeture d'avant une correction compte encore. Lu pour fermer, jamais
   * parcouru : le doute ne passe pas d'un bien à un troisième [R672].
   */
  private async doubtsOf(networkId: string, ad: FingerprintInput, except: AdRef | null = null): Promise<string[]> {
    const out = await doubtFingerprints(ad);
    const rows = await this.db.all<{ source: string; source_ref: string; commune: string }>(
      `SELECT b.source, b.source_ref, b.commune FROM pige_ads b
        WHERE b.network_id = ? AND b.kind = ? AND b.postal_code = ? AND b.surface_m2 BETWEEN ? AND ? ${typeof ad.rooms === 'number' ? 'AND b.rooms IS NULL' : ''}
          AND b.rowid = (SELECT c.rowid FROM pige_ads c WHERE c.network_id = b.network_id AND c.source = b.source AND c.source_ref = b.source_ref
                          ORDER BY c.collected_at DESC, c.rowid DESC LIMIT 1)`,
      [networkId, ad.kind, ad.postalCode, ad.surfaceM2 - SURFACE_TOLERANCE_M2, ad.surfaceM2 + SURFACE_TOLERANCE_M2],
    );
    const slug = communeSlug(ad.commune);
    for (const r of rows) {
      if (communeSlug(r.commune) !== slug) continue;
      if (except && r.source === except.source && r.source_ref === except.sourceRef) continue;
      out.push(await refKey(r.source, r.source_ref));
      const fps = await this.db.all<{ fingerprint: string }>('SELECT DISTINCT fingerprint FROM pige_ads WHERE network_id = ? AND source = ? AND source_ref = ?', [networkId, r.source, r.source_ref]);
      for (const f of fps) out.push(f.fingerprint);
    }
    return out;
  }

  /**
   * Le parcours lui-même ; `complete` est faux quand la limite l'a coupé : alors tout se ferme [R273]. Il ne suit que la
   * preuve : la même annonce sur son site, et les mêmes sorte, code postal, commune, surface à 1 m² près et pièces dites
   * [R672]. `marks` ajoute le doute, tiré de la relève en cours de chaque annonce, sauf de `current`, dont le doute est
   * donné par `doubtSeeds`.
   */
  private async linked(networkId: string, fingerprint: string, seeds: readonly string[] = [], doubtSeeds: readonly string[] = [], current: AdRef | null = null): Promise<{ keys: string[]; marks: string[]; complete: boolean }> {
    const start = [...new Set([fingerprint, ...seeds])];
    const fps = new Set<string>(start);
    const refs = new Set<string>();
    const keys = new Set<string>(start);
    // Ce qui ferme sans réunir : les biens qui pourraient être l'un de ceux-ci faute de pièces dites. Jamais parcourus :
    // le doute ne passe pas d'un bien à un troisième [R672].
    const doubts = new Set<string>(doubtSeeds);
    let frontier = start;
    while (frontier.length > 0 && refs.size < this.maxLinkedAds) {
      const rows = await this.db.all<{ source: string; source_ref: string; fingerprint: string; kind: PigeKind; postal_code: string; commune: string; surface_m2: number; rooms: number | null; collected_at: string; rid: number }>(
        `SELECT DISTINCT b.source, b.source_ref, b.fingerprint, b.kind, b.postal_code, b.commune, b.surface_m2, b.rooms, b.collected_at, b.rowid AS rid
           FROM pige_ads x JOIN pige_ads b ON b.network_id = x.network_id AND b.source = x.source AND b.source_ref = x.source_ref
          WHERE x.network_id = ? AND x.fingerprint IN (SELECT value FROM json_each(?))
          ORDER BY b.source, b.source_ref, b.collected_at DESC, b.rowid DESC`,
        [networkId, JSON.stringify(frontier)],
      );
      const next: string[] = [];
      const add = (f: string): void => {
        keys.add(f);
        if (!fps.has(f)) {
          fps.add(f);
          next.push(f);
        }
      };
      let lastRef = '';
      for (const r of rows) {
        const ref = `${r.source}\u0000${r.source_ref}`;
        // Les relèves d'une annonce arrivent de la plus récente à la plus ancienne : la première est celle en cours.
        const latest = ref !== lastRef;
        lastRef = ref;
        const fresh = !refs.has(ref);
        if (fresh) {
          refs.add(ref);
          keys.add(await refKey(r.source, r.source_ref));
        }
        add(r.fingerprint);
        const property = { kind: r.kind, postalCode: r.postal_code, commune: r.commune, surfaceM2: r.surface_m2, rooms: r.rooms };
        // Une relève qui dit ses pièces relie le bien prouvé ; une relève sans pièces ne relie que sa propre annonce : ses
        // fermetures se rangent sur elle, et les autres les lisent dans le doute tant qu'elle tait ses pièces.
        if (r.rooms !== null) for (const f of await nearFingerprints(property)) add(f);
        const isCurrent = current !== null && r.source === current.source && r.source_ref === current.sourceRef;
        if (latest && fresh && !isCurrent) for (const f of await this.doubtsOf(networkId, property, { source: r.source, sourceRef: r.source_ref })) doubts.add(f);
      }
      frontier = next;
    }
    return { keys: [...keys], marks: [...new Set([...keys, ...doubts])], complete: frontier.length === 0 };
  }

  private async closedReason(networkId: string, fingerprint: string): Promise<Problem | null> {
    const l = await this.linked(networkId, fingerprint);
    // Un bien relié à trop d'annonces pour être suivi en entier : fermé, jamais supposé ouvert.
    if (!l.complete) return { ok: false, rule: 'R273', code: 'bien_trop_relie' };
    // Prouvé ou dans le doute, ce qui ferme l'un ferme l'autre [R672].
    const marks = JSON.stringify(l.marks);
    if (await this.db.first(`SELECT 1 AS x FROM pige_no_agency WHERE network_id = ? AND fingerprint IN (SELECT value FROM json_each(?))`, [networkId, marks])) return { ok: false, rule: 'R273', code: 'pas_agence' };
    if (await this.db.first(`SELECT 1 AS x FROM pige_oppositions WHERE network_id = ? AND fingerprint IN (SELECT value FROM json_each(?))`, [networkId, marks])) return { ok: false, rule: 'R04', code: 'opposition' };
    return null;
  }

  /**
   * Prépare le premier message d'un bien de la file, une seule fois par bien [R05] : écrit par le code, vérifié par
   * `checkText` (chiffres de l'annonce et du marché seulement) [R10]. Rien ne part.
   */
  async prepare(viewer: Viewer, adId: unknown): Promise<{ ok: true; draftId: string; body: string } | Refusal | Problem> {
    const g = await this.gate(viewer, `pige_ad:${String(adId)}`, true);
    if (g) return g;
    const ad = await this.openAdFor(viewer, adId);
    if ('ok' in ad) return ad;
    const l = await this.linked(viewer.networkId, ad.fingerprint);
    if (!l.complete) return { ok: false, rule: 'R273', code: 'bien_trop_relie' };
    // Un message préparé pour ce bien, ou pour un bien qui pourrait être celui-ci, et pas un second [R05, R672].
    const near = l.marks;
    if (await this.db.first(`SELECT 1 AS x FROM pige_drafts WHERE network_id = ? AND fingerprint IN (SELECT value FROM json_each(?))`, [viewer.networkId, JSON.stringify(near)])) {
      return { ok: false, rule: 'R05', code: 'deja_prepare' };
    }
    const agent = await this.db.first<{ first_name: string }>('SELECT first_name FROM agents WHERE id = ?', [viewer.userId]);
    const priceEur = await this.latestPrice(viewer.networkId, ad.fingerprint);
    if (priceEur === null) return { ok: false, rule: null, code: 'annonce_remplacee' };
    const market = await this.marketGap(viewer.networkId, { commune: ad.commune, kind: ad.kind, surfaceM2: ad.surface_m2, priceEur });
    const body = firstMessage({ kind: ad.kind, commune: ad.commune, surfaceM2: ad.surface_m2, agentFirstName: (agent?.first_name ?? '').trim(), market });
    const problems = checkText(body, { audience: 'client', channel: 'email', firstOfConversation: true, figures: [ad.surface_m2, ...(market ? [market.medianPerM2] : [])], maxQuestions: 0 });
    if (problems.length > 0) return { ok: false, rule: (problems[0]?.rule === 'R10' ? 'R10' : null), code: 'texte', reason: problems.map((p) => p.reason).join(' ') };
    const id = this.newId();
    const r = await this.db.run(
      `INSERT INTO pige_drafts (id, network_id, fingerprint, ad_id, agent_id, body, gap_pct, market_source, market_last_sale, created_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        WHERE NOT EXISTS (SELECT 1 FROM pige_drafts WHERE network_id = ? AND fingerprint IN (SELECT value FROM json_each(?)))
          AND NOT EXISTS (SELECT 1 FROM pige_no_agency WHERE network_id = ? AND fingerprint = ?)
          AND NOT EXISTS (SELECT 1 FROM pige_oppositions WHERE network_id = ? AND fingerprint = ?)`,
      [
        id, viewer.networkId, ad.fingerprint, ad.id, viewer.userId, body, market?.gapPct ?? null, market?.source ?? null, market?.dvfLastSale ?? null, this.now().toISOString(),
        viewer.networkId, JSON.stringify(near), viewer.networkId, ad.fingerprint, viewer.networkId, ad.fingerprint,
      ],
    );
    if (r.changes !== 1) return (await this.closedReason(viewer.networkId, ad.fingerprint)) ?? { ok: false, rule: 'R05', code: 'deja_prepare' };
    await appendEvent(this.journal, { type: 'pige.preparee', actor: this.actor(viewer), subject: `pige_draft:${id}`, data: { rule: 'R275', ad: ad.id, gap: market?.gapPct ?? null } }, this.now);
    return { ok: true, draftId: id, body };
  }

  /**
   * L'agent valide son message. Par la messagerie de l'annonce : remis à lui seul, à coller, une fois, dans les heures
   * d'envoi [R01, R05]. Par téléphone, SMS, WhatsApp ou mail : la décision unique refuse sans accord [R03]. Rien ne part
   * d'AIMMO, dans aucun cas [R275].
   */
  async validate(viewer: Viewer, draftId: unknown, channelInput: unknown): Promise<{ ok: true; body: string; channel: 'annonce' } | Refusal | Problem> {
    const g = await this.gate(viewer, `pige_draft:${String(draftId)}`, true);
    if (g) return g;
    if (typeof channelInput !== 'string' || !(PIGE_CHANNELS as readonly string[]).includes(channelInput)) return { ok: false, rule: null, code: 'bad_channel' };
    const channel = channelInput as PigeChannel;
    if (typeof draftId !== 'string') return { ok: false, rule: null, code: 'unknown_draft' };
    const d = await this.db.first<{ id: string; fingerprint: string; agent_id: string; body: string; ad_id: string }>(
      'SELECT id, fingerprint, agent_id, body, ad_id FROM pige_drafts WHERE id = ? AND network_id = ?',
      [draftId, viewer.networkId],
    );
    if (!d) return { ok: false, rule: null, code: 'unknown_draft' };
    if (d.agent_id !== viewer.userId) return this.refuse(viewer, `pige_draft:${d.id}`, 'pas_son_message');
    const ad = await this.openAdFor(viewer, d.ad_id);
    if ('ok' in ad) return this.refused(viewer, d.id, ad);
    const at = this.now();
    if (channel !== 'annonce') {
      // Le contrôle central décide, comme pour tout envoi : aucun accord n'existe pour un particulier de la pige [R03].
      const decision = decideSend(
        { channel, kind: 'prospecting', purpose: PIGE_PURPOSE, at },
        { exclusions: [], consents: [], messages: [], relations: [], sentToday: { review_request: 0, partner: 0 } },
        DEFAULT_SEND_SETTINGS,
      );
      const rule = (decision.rule ?? 'R03') as Problem['rule'];
      return this.refused(viewer, d.id, { ok: false, rule, code: 'controle', reason: decision.reason });
    }
    // Un seul message par bien : un autre message du même bien, relié depuis par une correction, déjà remis, ferme
    // celui-ci [R05, R275].
    const linked = (await this.linked(viewer.networkId, d.fingerprint)).marks;
    const handed = await this.db.first(
      `SELECT 1 AS x FROM pige_drafts o JOIN pige_handovers h ON h.draft_id = o.id
        WHERE o.network_id = ? AND o.id <> ? AND o.fingerprint IN (SELECT value FROM json_each(?))`,
      [viewer.networkId, d.id, JSON.stringify(linked)],
    );
    if (handed) return this.refused(viewer, d.id, { ok: false, rule: 'R05', code: 'bien_deja_contacte' });
    const local = localTime(at, DEFAULT_SEND_SETTINGS.timeZone);
    const inHours =
      DEFAULT_SEND_SETTINGS.initiativeDays.includes(local.weekday) &&
      local.minutes >= DEFAULT_SEND_SETTINGS.initiativeFrom &&
      local.minutes < DEFAULT_SEND_SETTINGS.initiativeUntil;
    if (!inHours) return this.refused(viewer, d.id, { ok: false, rule: 'R01', code: 'hors_heures' });
    // La même condition dans l'écriture : deux remises en même temps pour un même bien relié, une seule passe.
    const r = await this.db.run(
      `INSERT INTO pige_handovers (draft_id, agent_id, channel, handed_at) SELECT ?, ?, 'annonce', ?
        WHERE NOT EXISTS (SELECT 1 FROM pige_handovers WHERE draft_id = ?)
          AND NOT EXISTS (SELECT 1 FROM pige_drafts o JOIN pige_handovers h ON h.draft_id = o.id
                           WHERE o.network_id = ? AND o.fingerprint IN (SELECT value FROM json_each(?)))
          AND NOT EXISTS (SELECT 1 FROM pige_no_agency WHERE network_id = ? AND fingerprint IN (SELECT value FROM json_each(?)))
          AND NOT EXISTS (SELECT 1 FROM pige_oppositions WHERE network_id = ? AND fingerprint IN (SELECT value FROM json_each(?)))`,
      [d.id, viewer.userId, at.toISOString(), d.id, viewer.networkId, JSON.stringify(linked), viewer.networkId, JSON.stringify(linked), viewer.networkId, JSON.stringify(linked)],
    );
    if (r.changes !== 1) return this.refused(viewer, d.id, (await this.closedReason(viewer.networkId, d.fingerprint)) ?? { ok: false, rule: 'R05', code: 'deja_remis' });
    // La remise est réservée ; le texte n'est rendu que si, relu après l'écriture, rien ne la ferme : une correction qui a
    // relié entre-temps ce bien à un non, un « pas d'agence » ou un autre message remis la garde pour toujours, sans
    // texte rendu. Rien n'est jamais parti d'AIMMO [R04, R05, R273].
    const after = await this.closedReason(viewer.networkId, d.fingerprint);
    const relinked = (await this.linked(viewer.networkId, d.fingerprint)).marks;
    const twice = await this.db.first(
      `SELECT 1 AS x FROM pige_drafts o JOIN pige_handovers h ON h.draft_id = o.id
        WHERE o.network_id = ? AND o.id <> ? AND o.fingerprint IN (SELECT value FROM json_each(?))`,
      [viewer.networkId, d.id, JSON.stringify(relinked)],
    );
    if (after || twice) return this.refused(viewer, d.id, after ?? { ok: false, rule: 'R05', code: 'bien_deja_contacte' });
    await appendEvent(this.journal, { type: 'pige.remise', actor: this.actor(viewer), subject: `pige_draft:${d.id}`, data: { rule: 'R275', channel: 'annonce' } }, this.now);
    return { ok: true, body: d.body, channel: 'annonce' };
  }

  private async refused(viewer: Viewer, draftId: string, p: Problem): Promise<Problem> {
    await appendEvent(this.journal, { type: 'pige.refusee', actor: this.actor(viewer), subject: `pige_draft:${draftId}`, data: { rule: p.rule, code: p.code } }, this.now);
    return p;
  }

  /** Le particulier a dit non ou stop : ce bien est fermé pour toujours, sur tous les canaux [R04, R02]. */
  async oppose(viewer: Viewer, adId: unknown): Promise<{ ok: true } | Refusal | Problem> {
    const g = await this.gate(viewer, `pige_ad:${String(adId)}`, false);
    if (g) return g;
    if (typeof adId !== 'string') return { ok: false, rule: null, code: 'unknown_ad' };
    const ad = await this.db.first<{ fingerprint: string; commune: string }>(
      'SELECT fingerprint, commune FROM pige_ads WHERE id = ? AND network_id = ?',
      [adId, viewer.networkId],
    );
    if (!ad) return { ok: false, rule: null, code: 'unknown_ad' };
    if (viewer.role === 'agent' && !(await this.zoneCommunes(viewer.networkId, viewer.userId)).has(communeSlug(ad.commune))) return { ok: false, rule: null, code: 'hors_zone' };
    // Le même bien, sur tous ses sites, avant et après chaque correction, et chacune de ses annonces : fermés avec lui [R04].
    for (const f of await this.linkedKeys(viewer.networkId, ad.fingerprint)) {
      await this.db.run('INSERT OR IGNORE INTO pige_oppositions (network_id, fingerprint, noted_by, noted_at) VALUES (?, ?, ?, ?)', [viewer.networkId, f, this.actor(viewer), this.now().toISOString()]);
    }
    await appendEvent(this.journal, { type: 'pige.opposition', actor: this.actor(viewer), subject: `pige_ad:${adId}`, data: { rule: 'R04' } }, this.now);
    return { ok: true };
  }
}
