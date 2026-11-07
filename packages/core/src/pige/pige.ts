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
 * Un bien se reconnaît d'un site à l'autre par sorte, code postal, commune et surface à 1 m² près, ni prix ni pièces :
 * le doute ferme plus, jamais moins.
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
import { isWorkingDay, localTime } from '../envoi/horaires.ts';
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
}

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
}

const intIn = (v: unknown, min: number, max: number): number | null =>
  typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? Math.round(v) : null;

/**
 * Ce qui suffit à reconnaître le bien d'une annonce qui dit « pas d'agence » : sorte, code postal, commune et surface.
 * Lu avant tout le reste, pour qu'un prix ou une date manquants n'empêchent jamais de fermer le bien [R273].
 */
export function noAgencyKey(raw: RawAd): Pick<CleanAd, 'kind' | 'postalCode' | 'commune' | 'surfaceM2'> | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const says = raw.noAgency === true || (typeof raw.text === 'string' && saysNoAgency(raw.text));
  if (!says) return null;
  const { kind, commune, postalCode } = raw;
  if (typeof kind !== 'string' || !(PIGE_KINDS as readonly string[]).includes(kind)) return null;
  if (typeof commune !== 'string' || !COMMUNE.test(commune.trim())) return null;
  if (typeof postalCode !== 'string' || !POSTAL.test(postalCode)) return null;
  const surfaceM2 = intIn(raw.surfaceM2, 8, 2000);
  if (surfaceM2 === null) return null;
  return { kind: kind as PigeKind, postalCode, commune: commune.trim().replace(/\s+/g, ' '), surfaceM2 };
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
  const rooms = raw.rooms === undefined || raw.rooms === null ? null : intIn(raw.rooms, 1, 40);
  if (raw.rooms !== undefined && raw.rooms !== null && rooms === null) return null;
  if (typeof publishedAt !== 'string') return null;
  const at = Date.parse(publishedAt);
  if (Number.isNaN(at) || at > now.getTime()) return null;
  const noAgency = raw.noAgency === true || (typeof raw.text === 'string' && saysNoAgency(raw.text));
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
  };
}

async function sha256(text: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * L'empreinte d'un bien, la même d'un site à l'autre et après une baisse de prix : sorte, code postal, commune et
 * surface. Ni le prix (un bien dont le prix baisse reste le même bien, sans second message [R05]), ni les pièces, qu'un
 * site peut taire : le doute ferme plus, jamais moins [R273].
 */
export function adFingerprint(ad: Pick<CleanAd, 'kind' | 'postalCode' | 'commune' | 'surfaceM2'>): Promise<string> {
  return sha256(['pige', ad.kind, ad.postalCode, communeSlug(ad.commune), ad.surfaceM2].join('|'));
}

/** Écart de surface d'un site à l'autre tenu pour le même bien, en m², pour fermer un bien ou éviter un second message. */
export const SURFACE_TOLERANCE_M2 = 1;

/** Les empreintes du même bien à la surface près : celles qu'un « pas d'agence », un non ou un message ferment. */
export async function nearFingerprints(ad: Pick<CleanAd, 'kind' | 'postalCode' | 'commune' | 'surfaceM2'>): Promise<string[]> {
  const out: string[] = [];
  for (let d = -SURFACE_TOLERANCE_M2; d <= SURFACE_TOLERANCE_M2; d += 1) out.push(await adFingerprint({ ...ad, surfaceM2: ad.surfaceM2 + d }));
  return out;
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
}

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

export class Pige {
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(
    private readonly db: SqlDatabase,
    private readonly journal: JournalStore,
    private readonly market: MarketPrices,
    options: PigeOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => crypto.randomUUID());
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
        if (!zones.get(communeSlug(closing.commune))) {
          outside += 1;
          continue;
        }
        for (const f of await nearFingerprints(closing)) {
          await this.db.run('INSERT OR IGNORE INTO pige_no_agency (network_id, fingerprint, noted_at) VALUES (?, ?, ?)', [networkId, f, now.toISOString()]);
        }
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
      const fingerprint = await adFingerprint(ad);
      const r = await this.db.run(
        `INSERT INTO pige_ads (id, network_id, source, source_ref, fingerprint, kind, commune, postal_code, surface_m2, rooms, price_eur, published_at, collected_at)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
          WHERE NOT EXISTS (SELECT 1 FROM pige_no_agency WHERE network_id = ? AND fingerprint = ?)
            AND coalesce((SELECT price_eur FROM pige_ads WHERE network_id = ? AND source = ? AND source_ref = ? ORDER BY collected_at DESC, rowid DESC LIMIT 1), -1) <> ?`,
        [
          this.newId(), networkId, ad.source, ad.sourceRef, fingerprint, ad.kind, commune, ad.postalCode, ad.surfaceM2, ad.rooms, ad.priceEur, ad.publishedAt, now.toISOString(),
          networkId, fingerprint, networkId, ad.source, ad.sourceRef, ad.priceEur,
        ],
      );
      added += r.changes;
    }
    await appendEvent(this.journal, { type: 'pige.collectee', actor: 'system:pige', subject: `network:${networkId}`, data: { rule: 'R273', added, noAgency, outside, unreadable } }, this.now);
    return { added, noAgency, outside, unreadable };
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

  /** Le premier vu de chaque bien ouvert de la file, dans les communes demandées, du plus récent au plus ancien. */
  private async openAds(networkId: string, communes: readonly string[]): Promise<AdRow[]> {
    if (communes.length === 0) return [];
    const since = new Date(this.now().getTime() - PIGE_MAX_AGE_DAYS * DAY).toISOString();
    return this.db.all<AdRow>(
      `SELECT a.id, a.source, a.fingerprint, a.kind, a.commune, a.postal_code, a.surface_m2, a.rooms, a.price_eur, a.published_at,
              (SELECT count(DISTINCT b.source) FROM pige_ads b WHERE b.network_id = a.network_id AND b.fingerprint = a.fingerprint) AS sites
         FROM pige_ads a
        WHERE a.network_id = ? AND a.commune IN (${communes.map(() => '?').join(', ')}) AND a.published_at >= ?
          AND a.id = (SELECT b.id FROM pige_ads b WHERE b.network_id = a.network_id AND b.fingerprint = a.fingerprint AND b.published_at >= ? ORDER BY b.published_at, b.id LIMIT 1)
          AND NOT EXISTS (SELECT 1 FROM pige_no_agency n WHERE n.network_id = a.network_id AND n.fingerprint = a.fingerprint)
          AND NOT EXISTS (SELECT 1 FROM pige_oppositions o WHERE o.network_id = a.network_id AND o.fingerprint = a.fingerprint)
        ORDER BY a.published_at DESC, a.id`,
      [networkId, ...communes, since, since],
    );
  }

  /** La dernière annonce relevée d'un bien, tous sites réunis : son prix du moment. */
  private async latestPrice(networkId: string, fingerprint: string): Promise<number> {
    const r = await this.db.first<{ price_eur: number }>(
      'SELECT price_eur FROM pige_ads WHERE network_id = ? AND fingerprint = ? ORDER BY collected_at DESC, rowid DESC LIMIT 1',
      [networkId, fingerprint],
    );
    return r?.price_eur ?? 0;
  }

  /** La file de pige : l'agent voit les biens de ses communes ; la direction, ceux du réseau. */
  async queue(viewer: Viewer): Promise<{ ok: true; value: PigeEntry[] } | Refusal> {
    const g = await this.gate(viewer, `network:${viewer.networkId}`, false);
    if (g) return g;
    const zones = await this.zoneCommunes(viewer.networkId, viewer.role === 'agent' ? viewer.userId : undefined);
    const rows = await this.openAds(viewer.networkId, [...new Set(zones.values())]);
    const out: PigeEntry[] = [];
    for (const r of rows) {
      const priceEur = await this.latestPrice(viewer.networkId, r.fingerprint);
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

  private async closedReason(networkId: string, fingerprint: string): Promise<Problem | null> {
    if (await this.db.first('SELECT 1 AS x FROM pige_no_agency WHERE network_id = ? AND fingerprint = ?', [networkId, fingerprint])) return { ok: false, rule: 'R273', code: 'pas_agence' };
    if (await this.db.first('SELECT 1 AS x FROM pige_oppositions WHERE network_id = ? AND fingerprint = ?', [networkId, fingerprint])) return { ok: false, rule: 'R04', code: 'opposition' };
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
    const near = await nearFingerprints({ kind: ad.kind, postalCode: ad.postal_code, commune: ad.commune, surfaceM2: ad.surface_m2 });
    const nearIn = near.map(() => '?').join(', ');
    if (await this.db.first(`SELECT 1 AS x FROM pige_drafts WHERE network_id = ? AND fingerprint IN (${nearIn})`, [viewer.networkId, ...near])) {
      return { ok: false, rule: 'R05', code: 'deja_prepare' };
    }
    const agent = await this.db.first<{ first_name: string }>('SELECT first_name FROM agents WHERE id = ?', [viewer.userId]);
    const priceEur = await this.latestPrice(viewer.networkId, ad.fingerprint);
    const market = await this.marketGap(viewer.networkId, { commune: ad.commune, kind: ad.kind, surfaceM2: ad.surface_m2, priceEur });
    const body = firstMessage({ kind: ad.kind, commune: ad.commune, surfaceM2: ad.surface_m2, agentFirstName: (agent?.first_name ?? '').trim(), market });
    const problems = checkText(body, { audience: 'client', channel: 'email', firstOfConversation: true, figures: [ad.surface_m2, ...(market ? [market.medianPerM2] : [])], maxQuestions: 0 });
    if (problems.length > 0) return { ok: false, rule: (problems[0]?.rule === 'R10' ? 'R10' : null), code: 'texte', reason: problems.map((p) => p.reason).join(' ') };
    const id = this.newId();
    const r = await this.db.run(
      `INSERT INTO pige_drafts (id, network_id, fingerprint, ad_id, agent_id, body, gap_pct, market_source, market_last_sale, created_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        WHERE NOT EXISTS (SELECT 1 FROM pige_drafts WHERE network_id = ? AND fingerprint IN (${nearIn}))
          AND NOT EXISTS (SELECT 1 FROM pige_no_agency WHERE network_id = ? AND fingerprint = ?)
          AND NOT EXISTS (SELECT 1 FROM pige_oppositions WHERE network_id = ? AND fingerprint = ?)`,
      [
        id, viewer.networkId, ad.fingerprint, ad.id, viewer.userId, body, market?.gapPct ?? null, market?.source ?? null, market?.dvfLastSale ?? null, this.now().toISOString(),
        viewer.networkId, ...near, viewer.networkId, ad.fingerprint, viewer.networkId, ad.fingerprint,
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
    const local = localTime(at, DEFAULT_SEND_SETTINGS.timeZone);
    const inHours =
      DEFAULT_SEND_SETTINGS.initiativeDays.includes(local.weekday) &&
      isWorkingDay(local) &&
      local.minutes >= DEFAULT_SEND_SETTINGS.initiativeFrom &&
      local.minutes < DEFAULT_SEND_SETTINGS.initiativeUntil;
    if (!inHours) return this.refused(viewer, d.id, { ok: false, rule: 'R01', code: 'hors_heures' });
    const r = await this.db.run(
      `INSERT INTO pige_handovers (draft_id, agent_id, channel, handed_at) SELECT ?, ?, 'annonce', ?
        WHERE NOT EXISTS (SELECT 1 FROM pige_handovers WHERE draft_id = ?)`,
      [d.id, viewer.userId, at.toISOString(), d.id],
    );
    if (r.changes !== 1) return this.refused(viewer, d.id, { ok: false, rule: 'R05', code: 'deja_remis' });
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
    const ad = await this.db.first<{ kind: PigeKind; postal_code: string; surface_m2: number; commune: string }>(
      'SELECT kind, postal_code, surface_m2, commune FROM pige_ads WHERE id = ? AND network_id = ?',
      [adId, viewer.networkId],
    );
    if (!ad) return { ok: false, rule: null, code: 'unknown_ad' };
    if (viewer.role === 'agent' && !(await this.zoneCommunes(viewer.networkId, viewer.userId)).has(communeSlug(ad.commune))) return { ok: false, rule: null, code: 'hors_zone' };
    // Le même bien à la surface près, sur tous ses sites, est fermé avec lui [R04].
    for (const f of await nearFingerprints({ kind: ad.kind, postalCode: ad.postal_code, commune: ad.commune, surfaceM2: ad.surface_m2 })) {
      await this.db.run('INSERT OR IGNORE INTO pige_oppositions (network_id, fingerprint, noted_by, noted_at) VALUES (?, ?, ?, ?)', [viewer.networkId, f, this.actor(viewer), this.now().toISOString()]);
    }
    await appendEvent(this.journal, { type: 'pige.opposition', actor: this.actor(viewer), subject: `pige_ad:${adId}`, data: { rule: 'R04' } }, this.now);
    return { ok: true };
  }
}
