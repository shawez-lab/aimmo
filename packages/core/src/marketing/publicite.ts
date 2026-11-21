/**
 * Publicité payante mesurée au mandat (HX54, M07, M20 « Mesure », M12).
 *
 * Une campagne Google Ads ou Meta ne dépense rien sans la validation de la direction : un budget par jour, un budget
 * total et un seuil de coût par contact. La plateforme ne reçoit que ces budgets, en mode essai seulement tant que le
 * plan ne l'a pas mise en service ; le lancement est tenu par la base, une fois par validation, jamais sur une
 * validation arrêtée ni remplacée [R587].
 *
 * La campagne s'arrête seule dès que son coût par contact dépasse le seuil (dépense > seuil × contacts, et sans
 * contact dès que la dépense passe le seuil) ou que son budget total est atteint ; la pause est redemandée à la
 * plateforme jusqu'à sa confirmation. L'arrêt protège la dépense, il ne décide pas de garder une source : relancer
 * reste une décision de la direction, par une nouvelle validation [R588, R144].
 * Un lancement resté sans réponse de la plateforme (coupure) est soldé en échec après `LAUNCH_ANSWER_MINUTES`, la
 * pause demandée : la campagne ne reste jamais figée. Chaque campagne est jugée sur les
 * mandats et les ventes qu'elle rapporte, lus dans la base comme la mesure mensuelle de G10 : les mandats signés par
 * une personne qu'elle a amenée, après son arrivée, et les actes de ces biens ou de ces acquéreurs.
 *
 * Le ciblage ne porte que sur des communes et un rayon d'au moins 15 km, pour tous les adultes : âge, sexe, origine,
 * nationalité, religion, langue, situation de famille, handicap, revenus, centres d'intérêt, listes de contacts ou
 * audiences semblables sont refusés et nommés ; la base ne range rien d'autre [R589, R50]. Au journal : les issues,
 * les règles et des montants, jamais une personne [R13]. Rien ne s'efface [R17].
 *
 * AU038 : une plateforme réelle (Google Ads, Meta) n'est admise qu'avec un plafond du budget total d'une validation,
 * réglé à la mise en service (H63) ; au-delà, la validation est refusée. Le lancement range l'accusé de la plateforme
 * (sa référence de la campagne et le mode réel ou d'essai) avant la réponse ; un lancement réel sans accusé est un
 * échec. Chaque échec d'appel est rangé en code fermé et en geste (reconnecter, donner l'accès, corriger, réessayer,
 * vérifier). Le passage planifié lit la dépense des trois derniers jours chez la plateforme et rapproche des campagnes
 * les demandes arrivées par leur lien (`?o=<code>`), une fois le message rattaché à une fiche [R588].
 */
import type { Viewer } from '../acces/droits.ts';
import { randomContentCode } from '../attirer/origine-contacts.ts';
import { FicheClient } from '../db/fiche-client.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { localTime } from '../envoi/horaires.ts';
import { FicheUnique } from '../fiche/fusion.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';

export const AD_PLATFORMS = ['google_ads', 'meta'] as const;
export type AdPlatformName = (typeof AD_PLATFORMS)[number];
export const MIN_RADIUS_KM = 15;
export const MAX_RADIUS_KM = 80;
export const MAX_COMMUNES = 30;
/** Au-delà, un lancement sans réponse de la plateforme est tenu pour perdu et soldé au passage suivant [R587]. */
export const LAUNCH_ANSWER_MINUTES = 15;
/**
 * Une plateforme qui n'a pas répondu au lancement en 5 minutes est tenue en échec par le lancement lui-même : ainsi un
 * lancement vivant a toujours fini avant d'être soldé, et une réponse tardive ne peut plus suivre un solde.
 */
export const LAUNCH_TIMEOUT_MS = 5 * 60_000;
const LAUNCH_TIMED_OUT = new Error('lancement sans réponse dans le délai');

/** Les seuls critères de ciblage admis [R589]. */
export const ALLOWED_TARGETING = ['communes', 'rayonKm'] as const;

/**
 * Les critères interdits pour une annonce de logement, nommés quand ils sont demandés [R589, R50]. La liste admise
 * reste fermée : un critère qui n'est ni admis ni ici est refusé aussi, sans être nommé.
 */
export const FORBIDDEN_TARGETING: readonly string[] = Object.freeze([
  'age',
  'ages',
  'ageMin',
  'ageMax',
  'tranche_age',
  'sexe',
  'genre',
  'gender',
  'origine',
  'ethnie',
  'nationalite',
  'religion',
  'langue',
  'langues',
  'language',
  'situationFamille',
  'situation_famille',
  'parents',
  'enfants',
  'handicap',
  'sante',
  'orientation',
  'revenus',
  'revenu',
  'income',
  'interets',
  'centresInteret',
  'interests',
  'comportements',
  'behaviors',
  'codePostal',
  'code_postal',
  'adresse',
  'listeContacts',
  'audiencePersonnalisee',
  'customAudience',
  'audienceSimilaire',
  'lookalike',
  'politique',
  'syndicat',
]);

export type AdRule = 'R16' | 'R587' | 'R588' | 'R589';
export type AdResult<T> = { ok: true; value: T } | { ok: false; rule: AdRule | null; code: string; detail?: string };

/** Ce que la plateforme reçoit au lancement : le code de suivi, la zone, les budgets validés. Rien d'autre. */
export interface AdLaunch {
  code: string;
  communes: string[];
  radiusKm: number | null;
  dailyBudgetCents: number;
  totalBudgetCents: number;
}

export type AdMode = 'essai' | 'reel';

/** L'accusé de la plateforme au lancement : sa référence de la campagne créée. */
export interface AdReceipt {
  externalRef: string;
}

/** Ce qu'une plateforme sait d'une campagne lancée : son code de suivi et, si elle l'a rendue, sa référence. */
export interface AdRef {
  code: string;
  externalRef: string | null;
}

/** Les échecs d'un appel à la plateforme, en liste fermée, chacun avec son geste [R587]. */
export const AD_FAILURE_ACTIONS = {
  reconnecter: 'reconnecter',
  acces: 'donner_acces',
  refusee: 'corriger',
  lieu_inconnu: 'corriger',
  rayon: 'corriger',
  indisponible: 'reessayer',
  inconnue: 'verifier',
} as const;
export type AdFailureCode = keyof typeof AD_FAILURE_ACTIONS;
export type AdAction = (typeof AD_FAILURE_ACTIONS)[AdFailureCode];
export type AdStep = 'lancement' | 'pause' | 'depense';

/** Une erreur de la plateforme, déjà classée ; toute autre erreur compte comme `inconnue`. */
export class AdPlatformError extends Error {
  constructor(readonly failure: AdFailureCode) {
    super(`plateforme publicitaire : ${failure}`);
    this.name = 'AdPlatformError';
  }
}

/**
 * Une plateforme de publicité. L'essai est la règle ; une plateforme réelle n'est admise qu'avec un plafond réglé à la
 * mise en service (H63) [R587]. `pause` reçoit la référence rendue au lancement quand elle est connue ; sans elle, la
 * plateforme cherche la campagne par son code. `spend` lit la dépense d'un jour, en centimes.
 */
export interface AdPlatform {
  readonly mode: AdMode;
  start(launch: AdLaunch): Promise<AdReceipt | void>;
  pause(code: string, externalRef?: string | null): Promise<void>;
  spend?(ref: AdRef, day: string): Promise<number>;
}

/** Une plateforme d'essai : elle note ce qu'elle reçoit, n'appelle personne et ne dépense rien. */
export function trialAdPlatform(): AdPlatform & { started: AdLaunch[]; paused: string[] } {
  const started: AdLaunch[] = [];
  const paused: string[] = [];
  return {
    mode: 'essai',
    started,
    paused,
    start: async (launch) => {
      started.push(structuredClone(launch));
    },
    pause: async (code) => {
      paused.push(code);
    },
  };
}

export type CampaignState = 'a_valider' | 'validee' | 'en_cours' | 'arretee';
export type StopReason = 'seuil' | 'budget' | 'direction' | 'echec_lancement';

export interface CampaignReport {
  id: string;
  platform: AdPlatformName;
  name: string;
  state: CampaignState;
  stopReason: StopReason | null;
  spendCents: number;
  contacts: number;
  mandates: number;
  sales: number;
  /** Arrondis à l'entier ; `null` sans contact, sans mandat ou sans vente. */
  costPerContactCents: number | null;
  costPerMandateCents: number | null;
  costPerSaleCents: number | null;
  maxCostPerContactCents: number | null;
  /** Le mode du dernier accusé de la plateforme ; `null` tant qu'aucun lancement n'a d'accusé. */
  mode: AdMode | null;
  /** Le dernier échec depuis la dernière validation, avec son geste ; `null` s'il n'y en a pas. */
  failure: { step: AdStep; code: AdFailureCode; action: AdAction } | null;
  /** Les demandes arrivées par le lien de la campagne et pas encore rattachées à une fiche. */
  pendingArrivals: number;
}

export interface PubliciteOptions {
  now?: () => Date;
  newId?: () => string;
  newCode?: () => string;
  /** Le temps laissé à la plateforme pour répondre au lancement, bien en deçà de `LAUNCH_ANSWER_MINUTES`. */
  launchTimeoutMs?: number;
  /** AU038 : le plafond du budget total d'une validation, en centimes, obligatoire avec une plateforme réelle (H63). */
  realCapCents?: number;
}

/** Les jours de dépense relus à chaque passage : aujourd'hui et les deux jours d'avant, corrections comprises. */
export const SPEND_DAYS = 3;
const EXTERNAL_REF = /^[A-Za-z0-9_/:.-]{1,200}$/;

interface CampaignRow {
  id: string;
  network_id: string;
  platform: AdPlatformName;
  name: string;
  code: string;
  communes: string;
  radius_km: number | null;
  created_at: string;
}

interface ApprovalRow {
  id: string;
  version: number;
  daily_budget_cents: number;
  total_budget_cents: number;
  max_cost_per_contact_cents: number;
}

const INSEE = /^(\d{5}|2[AB]\d{3})$/;
/** Le paramètre porteur des liens, le même que celui de l'origine des contacts (AT05). */
const CARRIER = 'o';
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const marks = (n: number): string => Array.from({ length: n }, () => '?').join(', ');
const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
const cents = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;

/** Un nom de critère ramené à sa forme simple, pour le reconnaître même écrit autrement. */
const simple = (k: string): string =>
  k
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
const FORBIDDEN_SIMPLE = new Map(FORBIDDEN_TARGETING.map((k) => [simple(k), k]));

/** Lit un ciblage : communes et rayon seulement ; le premier critère interdit est nommé [R589]. */
export function readTargeting(raw: unknown): AdResult<{ communes: string[]; radiusKm: number | null }> {
  if (!isPlainObject(raw)) return { ok: false, rule: 'R589', code: 'ciblage_invalide' };
  for (const key of Object.keys(raw)) {
    if ((ALLOWED_TARGETING as readonly string[]).includes(key)) continue;
    const named = FORBIDDEN_SIMPLE.get(simple(key));
    if (named) return { ok: false, rule: 'R589', code: 'critere_interdit', detail: named };
    return { ok: false, rule: 'R589', code: 'critere_inconnu' };
  }
  const communes = raw.communes;
  if (!Array.isArray(communes) || communes.length < 1 || communes.length > MAX_COMMUNES) return { ok: false, rule: 'R589', code: 'communes' };
  if (!communes.every((c): c is string => typeof c === 'string' && INSEE.test(c)) || new Set(communes).size !== communes.length) return { ok: false, rule: 'R589', code: 'communes' };
  const r = raw.rayonKm;
  if (r !== undefined && r !== null && (typeof r !== 'number' || !Number.isSafeInteger(r) || r < MIN_RADIUS_KM || r > MAX_RADIUS_KM)) return { ok: false, rule: 'R589', code: 'rayon' };
  return { ok: true, value: { communes: [...communes].sort(), radiusKm: typeof r === 'number' ? r : null } };
}

export interface AdArrivalSignals {
  link?: unknown;
  landingPage?: unknown;
}

/**
 * Une demande arrivée par le lien d'une campagne lancée (AU038) : un seul code `o`, celui d'une campagne du réseau.
 * Seuls le message et la campagne sont gardés, jamais l'adresse de la page [R156]. Rangée une fois ; elle devient un
 * contact de la campagne au rapprochement, quand le message est rattaché à une fiche [R588].
 */
export async function recordAdArrival(db: SqlDatabase, journal: JournalStore, now: () => Date, networkId: string, inboundId: string, signals: AdArrivalSignals): Promise<{ campaignId: string } | null> {
  for (const raw of [signals.link, signals.landingPage]) {
    if (typeof raw !== 'string' || raw.length > 2_000) continue;
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      continue;
    }
    const codes = url.searchParams.getAll(CARRIER);
    if (codes.length !== 1) continue;
    const c = await db.first<{ id: string }>('SELECT c.id FROM ad_campaigns c WHERE c.code = ? AND c.network_id = ? AND EXISTS (SELECT 1 FROM ad_campaign_starts s WHERE s.campaign_id = c.id)', [codes[0]!, networkId]);
    if (!c) continue;
    const m = await db.first<{ received_at: string }>('SELECT received_at FROM inbound_messages WHERE id = ? AND network_id = ?', [inboundId, networkId]);
    if (!m) return null;
    const { changes } = await db.run('INSERT INTO ad_campaign_arrivals (inbound_id, campaign_id, network_id, arrived_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING', [inboundId, c.id, networkId, m.received_at]);
    if (changes === 1) await appendEvent(journal, { type: 'publicite.demande', actor: 'system:publicite', subject: `ad_campaign:${c.id}`, data: { rule: 'R588' } }, now);
    return { campaignId: c.id };
  }
  return null;
}

export class PublicitePayante {
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly newCode: () => string;
  private readonly launchTimeoutMs: number;
  private readonly realCapCents: number | null;
  private readonly fiche: FicheUnique;

  constructor(
    private readonly db: SqlDatabase,
    private readonly journal: JournalStore,
    private readonly platforms: Readonly<Record<AdPlatformName, AdPlatform>>,
    options: PubliciteOptions = {},
  ) {
    const cap = options.realCapCents;
    this.realCapCents = typeof cap === 'number' && Number.isSafeInteger(cap) && cap > 0 ? cap : null;
    for (const name of AD_PLATFORMS) {
      const mode = platforms[name]?.mode;
      // Aucun envoi réel tant que le plan ne l'a pas mis en service : le réel demande son plafond (H63) [R587].
      if (mode === 'reel' && this.realCapCents === null) throw new Error(`plateforme ${name} : le mode réel demande un plafond`);
      if (mode !== 'essai' && mode !== 'reel') throw new Error(`plateforme ${name} : mode inconnu`);
    }
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => crypto.randomUUID());
    this.newCode = options.newCode ?? randomContentCode;
    this.launchTimeoutMs = options.launchTimeoutMs ?? LAUNCH_TIMEOUT_MS;
    if (!(this.launchTimeoutMs > 0 && this.launchTimeoutMs < LAUNCH_ANSWER_MINUTES * 60_000)) throw new Error('launchTimeoutMs : sous LAUNCH_ANSWER_MINUTES');
    this.fiche = new FicheUnique(db, new FicheClient(db, { now: this.now }), { now: this.now });
  }

  private actor(viewer: Viewer): string {
    return `${String(viewer.role)}:${viewer.userId}`;
  }

  private async refuse<T>(viewer: Viewer | null, kind: string, rule: AdRule, code: string, data: Record<string, unknown> = {}, detail?: string): Promise<AdResult<T>> {
    await appendEvent(this.journal, { type: rule === 'R16' ? 'acces.refuse' : 'publicite.refus', actor: viewer ? this.actor(viewer) : 'system:publicite', subject: null, data: { rule, kind, code, ...data } }, this.now);
    return detail === undefined ? { ok: false, rule, code } : { ok: false, rule, code, detail };
  }

  /** Seule la direction valide, lance, arrête et lit les chiffres [R16, R587]. */
  private async direction<T>(viewer: Viewer, kind: string): Promise<AdResult<T> | null> {
    if (viewer.role === 'direction') return null;
    return this.refuse(viewer, kind, 'R16', 'role', { role: String(viewer.role) });
  }

  private async campaign(networkId: string, id: unknown): Promise<CampaignRow | null> {
    if (typeof id !== 'string') return null;
    return (await this.db.first<CampaignRow>('SELECT id, network_id, platform, name, code, communes, radius_km, created_at FROM ad_campaigns WHERE id = ? AND network_id = ?', [id, networkId])) ?? null;
  }

  private async lastApproval(campaignId: string): Promise<ApprovalRow | null> {
    return (
      (await this.db.first<ApprovalRow>(
        'SELECT id, version, daily_budget_cents, total_budget_cents, max_cost_per_contact_cents FROM ad_campaign_approvals WHERE campaign_id = ? ORDER BY version DESC LIMIT 1',
        [campaignId],
      )) ?? null
    );
  }

  /** La direction ou un agent du réseau propose une campagne ; elle ne dépense rien tant qu'elle n'est pas validée. */
  async create(viewer: Viewer, input: { platform?: unknown; name?: unknown; targeting?: unknown }): Promise<AdResult<{ id: string; code: string }>> {
    if (viewer.role !== 'direction' && viewer.role !== 'agent') return this.refuse(viewer, 'ad_campaign', 'R16', 'role', { role: String(viewer.role) });
    const { platform, name } = input;
    if (typeof platform !== 'string' || !(AD_PLATFORMS as readonly string[]).includes(platform)) return { ok: false, rule: null, code: 'bad_platform' };
    if (typeof name !== 'string' || name.trim().length < 3 || name.trim().length > 80) return { ok: false, rule: null, code: 'bad_name' };
    const targeting = readTargeting(input.targeting);
    if (!targeting.ok) return this.refuse(viewer, 'ad_campaign', 'R589', targeting.code, targeting.detail ? { criterion: targeting.detail } : {}, targeting.detail);
    const id = this.newId();
    const code = this.newCode();
    await this.db.run('INSERT INTO ad_campaigns (id, network_id, platform, name, code, communes, radius_km, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [
      id,
      viewer.networkId,
      platform,
      name.trim(),
      code,
      JSON.stringify(targeting.value.communes),
      targeting.value.radiusKm,
      this.actor(viewer),
      this.now().toISOString(),
    ]);
    await appendEvent(this.journal, { type: 'publicite.campagne', actor: this.actor(viewer), subject: `ad_campaign:${id}`, data: { rule: 'R589', platform, communes: targeting.value.communes.length, radiusKm: targeting.value.radiusKm } }, this.now);
    return { ok: true, value: { id, code } };
  }

  /** La direction valide les budgets et le seuil ; chaque validation est une version nouvelle [R587]. */
  async approve(viewer: Viewer, campaignId: unknown, input: { dailyBudgetCents?: unknown; totalBudgetCents?: unknown; maxCostPerContactCents?: unknown }): Promise<AdResult<{ approvalId: string; version: number }>> {
    const denied = await this.direction<{ approvalId: string; version: number }>(viewer, 'ad_approval');
    if (denied) return denied;
    const c = await this.campaign(viewer.networkId, campaignId);
    if (!c) return { ok: false, rule: null, code: 'unknown' };
    const { dailyBudgetCents: daily, totalBudgetCents: total, maxCostPerContactCents: max } = input;
    if (!cents(daily) || !cents(total) || !cents(max) || total < daily) return { ok: false, rule: 'R587', code: 'bad_budget' };
    // Une plateforme réelle : jamais plus que le plafond réglé à la mise en service (AU038, H63) [R587].
    if (this.platforms[c.platform].mode === 'reel' && total > this.realCapCents!) return this.refuse(viewer, 'ad_approval', 'R587', 'plafond', { campaign: c.id, totalBudgetCents: total, capCents: this.realCapCents });
    // Une validation en cours de dépense n'est pas remplacée sous ses pieds : elle s'arrête d'abord.
    const last = await this.lastApproval(c.id);
    if (last && (await this.running(last.id))) return { ok: false, rule: 'R587', code: 'en_cours' };
    // Une pause pas encore confirmée par la plateforme : rien de nouveau tant qu'elle ne l'est pas [R588].
    if (await this.pausePending(c.id)) return { ok: false, rule: 'R588', code: 'pause_en_attente' };
    if (await this.launchPending(c.id)) return { ok: false, rule: 'R587', code: 'lancement_en_cours' };
    const version = (last?.version ?? 0) + 1;
    const approvalId = this.newId();
    let changes = 0;
    try {
      ({ changes } = await this.db.run(
        'INSERT INTO ad_campaign_approvals (id, campaign_id, version, daily_budget_cents, total_budget_cents, max_cost_per_contact_cents, approved_by, approved_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING',
        [approvalId, c.id, version, daily, total, max, this.actor(viewer), this.now().toISOString()],
      ));
    } catch {
      // Lancée entre-temps : la base refuse une validation nouvelle tant que l'autre dépense [R587].
      return { ok: false, rule: 'R587', code: 'en_cours' };
    }
    if (changes !== 1) return { ok: false, rule: null, code: 'conflict' };
    await appendEvent(this.journal, { type: 'publicite.validation', actor: this.actor(viewer), subject: `ad_campaign:${c.id}`, data: { rule: 'R587', version, dailyBudgetCents: daily, totalBudgetCents: total, maxCostPerContactCents: max } }, this.now);
    return { ok: true, value: { approvalId, version } };
  }

  private async running(approvalId: string): Promise<boolean> {
    const r = await this.db.first<{ s: number; t: number }>(
      'SELECT EXISTS (SELECT 1 FROM ad_campaign_starts WHERE approval_id = ?) AS s, EXISTS (SELECT 1 FROM ad_campaign_stops WHERE approval_id = ?) AS t',
      [approvalId, approvalId],
    );
    return Number(r?.s) === 1 && Number(r?.t) === 0;
  }

  /** La dépense de la campagne, dernière version de chaque jour, et ses contacts : tout depuis la base. */
  private async totals(campaignId: string): Promise<{ spendCents: number; contacts: number }> {
    const s = await this.db.first<{ total: number | null }>(
      `SELECT sum(amount_cents) AS total FROM ad_campaign_spend s WHERE campaign_id = ?
       AND version = (SELECT max(version) FROM ad_campaign_spend d WHERE d.campaign_id = s.campaign_id AND d.day = s.day)`,
      [campaignId],
    );
    // Une personne par fiche : deux contacts réunis après coup ne comptent qu'une fois [R588].
    const k = await this.db.all<{ person_id: string }>('SELECT person_id FROM ad_campaign_contacts WHERE campaign_id = ?', [campaignId]);
    const roots = new Set(await Promise.all(k.map((r) => this.fiche.rootOf(r.person_id))));
    return { spendCents: Number(s?.total ?? 0), contacts: roots.size };
  }

  /** Un lancement demandé à la plateforme dont la réponse n'est pas encore revenue. */
  private async launchPending(campaignId: string): Promise<boolean> {
    const r = await this.db.first<{ n: number }>('SELECT count(*) AS n FROM ad_campaign_starts s WHERE s.campaign_id = ? AND NOT EXISTS (SELECT 1 FROM ad_campaign_launches l WHERE l.approval_id = s.approval_id)', [campaignId]);
    return Number(r?.n) > 0;
  }

  /** Une pause demandée à la plateforme et pas encore confirmée, pour cette campagne. */
  private async pausePending(campaignId: string): Promise<boolean> {
    const r = await this.db.first<{ n: number }>(
      `SELECT (SELECT count(*) FROM ad_campaign_stops WHERE campaign_id = ? AND paused_at IS NULL)
        + (SELECT count(*) FROM ad_campaign_repauses r JOIN ad_campaign_stops s ON s.approval_id = r.approval_id WHERE s.campaign_id = ? AND r.paused_at IS NULL) AS n`,
      [campaignId, campaignId],
    );
    return Number(r?.n) > 0;
  }

  /** Les validations lancées et pas encore arrêtées : une seule en principe, toutes contrôlées quand même. */
  private async runningApprovals(campaignId: string): Promise<ApprovalRow[]> {
    return this.db.all<ApprovalRow>(
      `SELECT a.id, a.version, a.daily_budget_cents, a.total_budget_cents, a.max_cost_per_contact_cents FROM ad_campaign_approvals a
       JOIN ad_campaign_starts s ON s.approval_id = a.id
       WHERE a.campaign_id = ? AND NOT EXISTS (SELECT 1 FROM ad_campaign_stops t WHERE t.approval_id = a.id) ORDER BY a.version`,
      [campaignId],
    );
  }

  /** Le motif d'arrêt automatique, ou null : seuil de coût par contact dépassé, ou budget total atteint [R588]. */
  private overLimit(a: ApprovalRow, t: { spendCents: number; contacts: number }): 'seuil' | 'budget' | null {
    if (t.spendCents > Number(a.max_cost_per_contact_cents) * Math.max(t.contacts, 1)) return 'seuil';
    if (t.spendCents >= Number(a.total_budget_cents)) return 'budget';
    return null;
  }

  /** La direction lance la dernière validation, une fois ; la plateforme ne reçoit que les budgets validés [R587]. */
  async start(viewer: Viewer, campaignId: unknown): Promise<AdResult<{ approvalId: string }>> {
    const denied = await this.direction<{ approvalId: string }>(viewer, 'ad_start');
    if (denied) return denied;
    const c = await this.campaign(viewer.networkId, campaignId);
    if (!c) return { ok: false, rule: null, code: 'unknown' };
    const a = await this.lastApproval(c.id);
    if (!a) return this.refuse(viewer, 'ad_start', 'R587', 'sans_validation', { campaign: c.id });
    // Une validation déjà lancée ou arrêtée ne repart jamais : il en faut une nouvelle de la direction [R587].
    const used = await this.db.first<{ n: number }>('SELECT (SELECT count(*) FROM ad_campaign_starts WHERE approval_id = ?) + (SELECT count(*) FROM ad_campaign_stops WHERE approval_id = ?) AS n', [a.id, a.id]);
    if (Number(used?.n) > 0) return this.refuse(viewer, 'ad_start', 'R587', 'deja_lancee_ou_arretee', { campaign: c.id });
    if (await this.launchPending(c.id)) return this.refuse(viewer, 'ad_start', 'R587', 'lancement_en_cours', { campaign: c.id });
    if (await this.pausePending(c.id)) return this.refuse(viewer, 'ad_start', 'R588', 'pause_en_attente', { campaign: c.id });
    // Déjà au-delà du seuil ou du budget avec ce qui est dépensé : rien ne repart [R588].
    const over = this.overLimit(a, await this.totals(c.id));
    if (over) return this.refuse(viewer, 'ad_start', 'R588', over, { campaign: c.id });
    let changes = 0;
    try {
      ({ changes } = await this.db.run("INSERT INTO ad_campaign_starts (approval_id, campaign_id, mode, started_by, started_at) VALUES (?, ?, 'essai', ?, ?) ON CONFLICT DO NOTHING", [
        a.id,
        c.id,
        this.actor(viewer),
        this.now().toISOString(),
      ]));
    } catch {
      changes = 0;
    }
    // Déjà lancée, arrêtée ou remplacée : la base refuse, rien ne part [R587].
    if (changes !== 1) return this.refuse(viewer, 'ad_start', 'R587', 'deja_lancee_ou_arretee', { campaign: c.id });
    const launch: AdLaunch = { code: c.code, communes: JSON.parse(c.communes) as string[], radiusKm: c.radius_km === null ? null : Number(c.radius_km), dailyBudgetCents: Number(a.daily_budget_cents), totalBudgetCents: Number(a.total_budget_cents) };
    let answered = false;
    const platform = this.platforms[c.platform];
    const call = platform.start(launch);
    try {
      const receipt = await this.withinTimeout(call);
      const ref = receipt && typeof receipt.externalRef === 'string' && EXTERNAL_REF.test(receipt.externalRef) ? receipt.externalRef : null;
      // Un lancement réel sans accusé lisible : la campagne n'est pas tenue, c'est un échec (AU038) [R587].
      if (platform.mode === 'reel' && ref === null) throw new AdPlatformError('inconnue');
      // L'accusé est rangé avant la réponse : une réponse rangée a toujours son accusé.
      if (ref !== null) {
        await this.db.run('INSERT INTO ad_campaign_receipts (approval_id, campaign_id, mode, external_ref, received_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING', [a.id, c.id, platform.mode, ref, this.now().toISOString()]);
      }
      answered = await this.launched(a.id, 'lancee');
    } catch (e) {
      const failure: AdFailureCode = e instanceof AdPlatformError ? e.failure : e === LAUNCH_TIMED_OUT ? 'indisponible' : 'inconnue';
      await this.fail(c, 'lancement', failure);
      // L'arrêt d'abord : coupé avant la réponse rangée, le lancement est soldé au passage suivant, rien n'est perdu.
      await this.stopApproval(c, a.id, 'echec_lancement', `${String(viewer.role)}:${viewer.userId}`);
      if (e !== LAUNCH_TIMED_OUT) {
        await this.launched(a.id, 'echec');
      } else {
        // Délai passé, l'appel continue peut-être chez la plateforme : la réponse reste à venir, donc rien ne se valide
        // ni ne se relance avant elle ou avant le solde, qui redemandera la pause [R587, R588].
        void call.then(
          (late) => this.answeredLate(c, a.id, late).catch(() => undefined),
          () => undefined,
        );
      }
      return { ok: false, rule: 'R587', code: 'echec_lancement', detail: failure };
    }
    if (!answered) return this.lateAnswer(c);
    // Arrêtée pendant que la plateforme lançait : la pause a pu passer avant le lancement, elle est redemandée.
    const stoppedMeanwhile = await this.db.first<{ n: number }>('SELECT count(*) AS n FROM ad_campaign_stops WHERE approval_id = ?', [a.id]);
    if (Number(stoppedMeanwhile?.n) > 0) {
      await this.pause(c, a.id, true);
      return { ok: false, rule: 'R588', code: 'arretee_au_lancement' };
    }
    await appendEvent(this.journal, { type: 'publicite.lancee', actor: this.actor(viewer), subject: `ad_campaign:${c.id}`, data: { rule: 'R587', mode: platform.mode, version: a.version, dailyBudgetCents: launch.dailyBudgetCents, totalBudgetCents: launch.totalBudgetCents } }, this.now);
    return { ok: true, value: { approvalId: a.id } };
  }

  /** La réponse de la plateforme, ou une erreur passé le délai de lancement. */
  private async withinTimeout<T>(call: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(LAUNCH_TIMED_OUT), this.launchTimeoutMs);
    });
    try {
      return await Promise.race([call, late]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * La plateforme a lancé après le délai, la validation déjà arrêtée : la pause à redemander est rangée d'abord, puis
   * la réponse. Avant le solde, une coupure ici laisse le lancement sans réponse et le solde redemande la pause.
   */
  private async answeredLate(c: CampaignRow, approvalId: string, receipt?: AdReceipt | void): Promise<void> {
    // L'accusé tardif est gardé quand même : la pause redemandée vise alors la bonne campagne chez la plateforme.
    const ref = receipt && typeof receipt.externalRef === 'string' && EXTERNAL_REF.test(receipt.externalRef) ? receipt.externalRef : null;
    if (ref !== null) {
      await this.db.run('INSERT INTO ad_campaign_receipts (approval_id, campaign_id, mode, external_ref, received_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING', [approvalId, c.id, this.platforms[c.platform].mode, ref, this.now().toISOString()]);
    }
    await this.db.run('INSERT INTO ad_campaign_repauses (approval_id, asked_at) VALUES (?, ?) ON CONFLICT DO NOTHING', [approvalId, this.now().toISOString()]);
    if (await this.launched(approvalId, 'lancee')) await this.pause(c, approvalId, true);
    else await this.lateAnswer(c);
  }

  /**
   * Une réponse arrivée après le solde : l'état de la plateforme n'est plus sûr (le
   * lancement tardif a pu remplacer celui d'une validation plus récente). Toute validation lancée depuis est arrêtée, sa pause redemandée jusqu'à confirmation ;
   * sinon la pause est redemandée [R588].
   */
  private async lateAnswer(c: CampaignRow): Promise<AdResult<{ approvalId: string }>> {
    let stopped = 0;
    for (const r of await this.runningApprovals(c.id)) if (await this.stopApproval(c, r.id, 'echec_lancement', 'system:publicite')) stopped += 1;
    if (stopped === 0) {
      const last = await this.db.first<{ approval_id: string }>('SELECT approval_id FROM ad_campaign_stops WHERE campaign_id = ? ORDER BY stopped_at DESC, approval_id DESC LIMIT 1', [c.id]);
      if (last) {
        // La pause à redemander est rangée avant d'être demandée : une coupure ne la perd pas.
        await this.db.run('INSERT INTO ad_campaign_repauses (approval_id, asked_at) VALUES (?, ?) ON CONFLICT DO NOTHING', [last.approval_id, this.now().toISOString()]);
        await this.pause(c, last.approval_id, true);
      }
    }
    await appendEvent(this.journal, { type: 'publicite.reponse_tardive', actor: 'system:publicite', subject: `ad_campaign:${c.id}`, data: { rule: 'R588', stopped } }, this.now);
    return { ok: false, rule: 'R588', code: 'reponse_tardive' };
  }

  /** La réponse de la plateforme au lancement, rangée une fois : tant qu'elle manque, rien d'autre ne se lance. */
  private async launched(approvalId: string, outcome: 'lancee' | 'echec'): Promise<boolean> {
    const { changes } = await this.db.run('INSERT INTO ad_campaign_launches (approval_id, outcome, done_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING', [approvalId, outcome, this.now().toISOString()]);
    return changes === 1;
  }

  /**
   * Un lancement resté sans réponse de la plateforme depuis `LAUNCH_ANSWER_MINUTES` (Worker arrêté pendant l'appel) est
   * soldé comme un échec : rangé une fois par la base (une vraie réponse arrivée avant l'emporte), la validation arrêtée
   * et sa pause demandée jusqu'à confirmation, puisque la plateforme a peut-être lancé. Déjà arrêtée par la direction :
   * la pause est redemandée quand même. Relancer demande une validation nouvelle [R587, R588].
   */
  private async settleLostLaunches(c: CampaignRow): Promise<void> {
    const before = new Date(this.now().getTime() - LAUNCH_ANSWER_MINUTES * 60_000).toISOString();
    const lost = await this.db.all<{ approval_id: string }>(
      'SELECT s.approval_id FROM ad_campaign_starts s WHERE s.campaign_id = ? AND s.started_at <= ? AND NOT EXISTS (SELECT 1 FROM ad_campaign_launches l WHERE l.approval_id = s.approval_id) ORDER BY s.started_at, s.approval_id',
      [c.id, before],
    );
    for (const l of lost) {
      // L'arrêt, ou la pause redemandée, passe avant l'échec rangé : coupé entre les deux, le lancement est encore sans
      // réponse et le passage suivant reprend ; une pause non confirmée reste redemandée [R588].
      // Déjà arrêtée par la direction : la pause est redemandée ; en échec, elle reste à confirmer.
      if (!(await this.stopApproval(c, l.approval_id, 'echec_lancement', 'system:publicite'))) await this.pause(c, l.approval_id, true);
      if (await this.launched(l.approval_id, 'echec')) {
        await appendEvent(this.journal, { type: 'publicite.lancement_sans_reponse', actor: 'system:publicite', subject: `ad_campaign:${c.id}`, data: { rule: 'R587', minutes: LAUNCH_ANSWER_MINUTES } }, this.now);
      }
    }
  }

  /** Range l'arrêt une fois, puis demande la pause à la plateforme ; une pause non confirmée sera redemandée. */
  private async stopApproval(c: CampaignRow, approvalId: string, reason: StopReason, by: string): Promise<boolean> {
    const t = await this.totals(c.id);
    const { changes } = await this.db.run('INSERT INTO ad_campaign_stops (approval_id, campaign_id, reason, spend_cents, contacts, stopped_by, stopped_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING', [
      approvalId,
      c.id,
      reason,
      t.spendCents,
      t.contacts,
      by,
      this.now().toISOString(),
    ]);
    if (changes !== 1) return false;
    await appendEvent(this.journal, { type: 'publicite.arretee', actor: by, subject: `ad_campaign:${c.id}`, data: { rule: reason === 'direction' ? 'R587' : 'R588', reason, spendCents: t.spendCents, contacts: t.contacts } }, this.now);
    await this.pause(c, approvalId);
    return true;
  }

  private async pause(c: CampaignRow, approvalId: string, again = false): Promise<void> {
    const receipt = await this.db.first<{ external_ref: string }>('SELECT external_ref FROM ad_campaign_receipts WHERE approval_id = ?', [approvalId]);
    try {
      await this.platforms[c.platform].pause(c.code, receipt?.external_ref ?? null);
    } catch (e) {
      await this.fail(c, 'pause', e instanceof AdPlatformError ? e.failure : 'inconnue');
      await appendEvent(this.journal, { type: 'publicite.pause_echec', actor: 'system:publicite', subject: `ad_campaign:${c.id}`, data: { rule: 'R588' } }, this.now);
      // Une pause redemandée après le lancement et en échec redevient à confirmer.
      if (again) await this.db.run('INSERT INTO ad_campaign_repauses (approval_id, asked_at) VALUES (?, ?) ON CONFLICT DO NOTHING', [approvalId, this.now().toISOString()]);
      return;
    }
    if (again) await this.db.run('UPDATE ad_campaign_repauses SET paused_at = ? WHERE approval_id = ? AND paused_at IS NULL', [this.now().toISOString(), approvalId]);
    await this.db.run('UPDATE ad_campaign_stops SET paused_at = ? WHERE approval_id = ? AND paused_at IS NULL', [this.now().toISOString(), approvalId]);
  }

  /** La direction arrête une campagne en cours. */
  async stop(viewer: Viewer, campaignId: unknown): Promise<AdResult<null>> {
    const denied = await this.direction<null>(viewer, 'ad_stop');
    if (denied) return denied;
    const c = await this.campaign(viewer.networkId, campaignId);
    if (!c) return { ok: false, rule: null, code: 'unknown' };
    const runs = await this.runningApprovals(c.id);
    if (runs.length === 0) return { ok: false, rule: null, code: 'pas_en_cours' };
    for (const a of runs) await this.stopApproval(c, a.id, 'direction', this.actor(viewer));
    return { ok: true, value: null };
  }

  /**
   * La dépense d'un jour lue chez la plateforme ; une correction s'ajoute en version. Une dépense sur une campagne
   * jamais lancée n'est pas rangée : elle est signalée [R587]. Le contrôle du seuil passe aussitôt [R588].
   */
  async recordSpend(networkId: string, campaignId: unknown, day: unknown, amountCents: unknown): Promise<AdResult<{ stopped: boolean }>> {
    const c = await this.campaign(networkId, campaignId);
    if (!c) return { ok: false, rule: null, code: 'unknown' };
    if (typeof day !== 'string' || !DAY.test(day)) return { ok: false, rule: null, code: 'bad_day' };
    if (typeof amountCents !== 'number' || !Number.isSafeInteger(amountCents) || amountCents < 0) return { ok: false, rule: null, code: 'bad_amount' };
    const started = await this.db.first<{ n: number }>('SELECT count(*) AS n FROM ad_campaign_starts WHERE campaign_id = ?', [c.id]);
    if (Number(started?.n) === 0) return this.refuse(null, 'ad_spend', 'R587', 'depense_sans_lancement', { campaign: c.id, amountCents });
    // Deux lectures du même jour en même temps : la version prise est réessayée, aucune lecture n'est perdue [R588].
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const last = await this.db.first<{ v: number | null; a: number | null }>(
        'SELECT max(version) AS v, (SELECT amount_cents FROM ad_campaign_spend WHERE campaign_id = ? AND day = ? ORDER BY version DESC LIMIT 1) AS a FROM ad_campaign_spend WHERE campaign_id = ? AND day = ?',
        [c.id, day, c.id, day],
      );
      const previous = last?.a === null || last?.a === undefined ? null : Number(last.a);
      if (previous === amountCents) break;
      const { changes } = await this.db.run('INSERT INTO ad_campaign_spend (campaign_id, day, version, amount_cents, reported_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING', [
        c.id,
        day,
        Number(last?.v ?? 0) + 1,
        amountCents,
        this.now().toISOString(),
      ]);
      if (changes !== 1) continue;
      // Une dépense qui monte alors qu'aucune validation n'est en cours est rangée telle que lue, et signalée [R587].
      if ((previous === null ? amountCents > 0 : amountCents > previous) && (await this.runningApprovals(c.id)).length === 0) {
        await this.refuse(null, 'ad_spend', 'R587', 'depense_hors_validation', { campaign: c.id, amountCents });
      }
      break;
    }
    return { ok: true, value: { stopped: await this.check(c) } };
  }

  /** Un contact amené par le code de suivi d'une campagne lancée, une fois par personne. */
  async recordContact(networkId: string, code: unknown, personId: unknown, arrivedAt?: string): Promise<AdResult<{ campaignId: string; counted: boolean }>> {
    if (typeof code !== 'string' || typeof personId !== 'string') return { ok: false, rule: null, code: 'bad_input' };
    const c = await this.db.first<{ id: string }>('SELECT id FROM ad_campaigns WHERE code = ? AND network_id = ?', [code, networkId]);
    if (!c) return { ok: false, rule: null, code: 'unknown' };
    const started = await this.db.first<{ n: number }>('SELECT count(*) AS n FROM ad_campaign_starts WHERE campaign_id = ?', [c.id]);
    if (Number(started?.n) === 0) return { ok: false, rule: null, code: 'pas_lancee' };
    const root = await this.fiche.rootOf(personId);
    const members = await this.fiche.membersOf(root);
    const seen = await this.db.first<{ n: number }>(`SELECT count(*) AS n FROM ad_campaign_contacts WHERE campaign_id = ? AND person_id IN (${marks(members.length)})`, [c.id, ...members]);
    if (Number(seen?.n) > 0) return { ok: true, value: { campaignId: c.id, counted: false } };
    const { changes } = await this.db.run('INSERT INTO ad_campaign_contacts (campaign_id, network_id, person_id, arrived_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING', [c.id, networkId, root, arrivedAt ?? this.now().toISOString()]);
    if (changes === 1) await appendEvent(this.journal, { type: 'publicite.contact', actor: 'system:publicite', subject: `ad_campaign:${c.id}`, data: { rule: 'R588' } }, this.now);
    return { ok: true, value: { campaignId: c.id, counted: changes === 1 } };
  }

  /** Le contrôle d'une campagne : arrêt au seuil ou au budget, et pause redemandée tant qu'elle n'est pas confirmée. */
  private async check(c: CampaignRow): Promise<boolean> {
    const pending = await this.db.all<{ approval_id: string }>('SELECT approval_id FROM ad_campaign_stops WHERE campaign_id = ? AND paused_at IS NULL', [c.id]);
    for (const p of pending) await this.pause(c, p.approval_id);
    const again = await this.db.all<{ approval_id: string }>('SELECT r.approval_id FROM ad_campaign_repauses r JOIN ad_campaign_stops s ON s.approval_id = r.approval_id WHERE s.campaign_id = ? AND r.paused_at IS NULL', [c.id]);
    for (const p of again) await this.pause(c, p.approval_id, true);
    await this.settleLostLaunches(c);
    const totals = await this.totals(c.id);
    let stopped = false;
    for (const a of await this.runningApprovals(c.id)) {
      const over = this.overLimit(a, totals);
      if (over && (await this.stopApproval(c, a.id, over, 'system:publicite'))) stopped = true;
    }
    return stopped;
  }

  /** Le passage planifié : chaque campagne du réseau contrôlée [R588]. */
  async runChecks(networkId: string): Promise<{ stopped: number }> {
    const rows = await this.db.all<CampaignRow>('SELECT id, network_id, platform, name, code, communes, radius_km, created_at FROM ad_campaigns WHERE network_id = ? ORDER BY created_at, id', [networkId]);
    let stopped = 0;
    for (const c of rows) if (await this.check(c)) stopped += 1;
    return { stopped };
  }

  /** Un échec d'appel à la plateforme, rangé en code et en geste, et écrit au journal sans personne [R587, R13]. */
  private async fail(c: CampaignRow, step: AdStep, code: AdFailureCode): Promise<void> {
    const action = AD_FAILURE_ACTIONS[code];
    await this.db.run('INSERT INTO ad_campaign_failures (id, campaign_id, step, code, action, at) VALUES (?, ?, ?, ?, ?, ?)', [this.newId(), c.id, step, code, action, this.now().toISOString()]);
    await appendEvent(this.journal, { type: 'publicite.echec', actor: 'system:publicite', subject: `ad_campaign:${c.id}`, data: { rule: 'R587', step, code, action } }, this.now);
  }

  /**
   * La dépense lue chez la plateforme pour chaque campagne lancée qui a un accusé : aujourd'hui et les deux jours
   * d'avant (heure de Paris), chaque lancement de la campagne additionné. Une lecture en échec est rangée avec son geste
   * et le jour n'est pas rangé ; le contrôle du seuil suit chaque jour lu [R588].
   */
  async syncSpend(networkId: string): Promise<{ days: number; failures: number }> {
    const rows = await this.db.all<CampaignRow>(
      `SELECT id, network_id, platform, name, code, communes, radius_km, created_at FROM ad_campaigns c WHERE network_id = ?
        AND EXISTS (SELECT 1 FROM ad_campaign_receipts r WHERE r.campaign_id = c.id) ORDER BY created_at, id`,
      [networkId],
    );
    let days = 0;
    let failures = 0;
    const now = this.now();
    for (const c of rows) {
      const platform = this.platforms[c.platform];
      if (!platform.spend) continue;
      // Une campagne arrêtée et mise en pause depuis plus que la fenêtre ne dépense plus : rien à relire.
      const open = await this.db.first<{ n: number }>(
        `SELECT count(*) AS n FROM ad_campaign_starts s WHERE s.campaign_id = ? AND NOT EXISTS (
           SELECT 1 FROM ad_campaign_stops t WHERE t.approval_id = s.approval_id AND t.paused_at IS NOT NULL AND t.paused_at < ?)`,
        [c.id, new Date(now.getTime() - SPEND_DAYS * 86_400_000).toISOString()],
      );
      if (Number(open?.n) === 0) continue;
      const receipts = await this.db.all<{ external_ref: string; received_at: string }>('SELECT external_ref, received_at FROM ad_campaign_receipts WHERE campaign_id = ? ORDER BY received_at, approval_id', [c.id]);
      const firstDay = PublicitePayante.parisDay(new Date(receipts[0]!.received_at));
      for (let back = SPEND_DAYS - 1; back >= 0; back -= 1) {
        const day = PublicitePayante.parisDay(new Date(now.getTime() - back * 86_400_000));
        if (day < firstDay) continue;
        let total = 0;
        let failed = false;
        for (const r of receipts) {
          if (PublicitePayante.parisDay(new Date(r.received_at)) > day) continue;
          try {
            const amount = await platform.spend({ code: c.code, externalRef: r.external_ref }, day);
            if (!Number.isSafeInteger(amount) || amount < 0) throw new AdPlatformError('inconnue');
            total += amount;
          } catch (e) {
            await this.fail(c, 'depense', e instanceof AdPlatformError ? e.failure : 'inconnue');
            failed = true;
            break;
          }
        }
        // Une lecture incomplète n'est jamais rangée : elle ferait baisser la dépense d'un jour.
        if (failed) {
          failures += 1;
          continue;
        }
        const r = await this.recordSpend(networkId, c.id, day, total);
        if (r.ok) days += 1;
      }
    }
    return { days, failures };
  }

  /** Une demande arrivée par le lien d'une campagne lancée, rangée une fois (voir `recordAdArrival`). */
  async recordArrival(networkId: string, inboundId: string, signals: AdArrivalSignals): Promise<{ campaignId: string } | null> {
    return recordAdArrival(this.db, this.journal, this.now, networkId, inboundId, signals);
  }

  /** Le rapprochement : chaque demande arrivée par une campagne et désormais rattachée à une fiche en devient un contact [R588]. */
  async matchArrivals(networkId: string): Promise<{ matched: number }> {
    const rows = await this.db.all<{ inbound_id: string; code: string; person_id: string; arrived_at: string }>(
      `SELECT a.inbound_id, c.code, m.person_id, a.arrived_at FROM ad_campaign_arrivals a
         JOIN ad_campaigns c ON c.id = a.campaign_id
         JOIN inbound_messages m ON m.id = a.inbound_id
        WHERE a.network_id = ? AND a.matched_at IS NULL AND m.person_id IS NOT NULL ORDER BY a.arrived_at, a.inbound_id`,
      [networkId],
    );
    let matched = 0;
    for (const r of rows) {
      const k = await this.recordContact(networkId, r.code, r.person_id, r.arrived_at);
      if (!k.ok) continue;
      const { changes } = await this.db.run('UPDATE ad_campaign_arrivals SET matched_at = ? WHERE inbound_id = ? AND matched_at IS NULL', [this.now().toISOString(), r.inbound_id]);
      if (changes === 1) matched += 1;
    }
    return { matched };
  }

  /** Les mandats et les ventes qu'une campagne rapporte, lus dans la base comme ceux de G10. */
  private async outcomes(campaignId: string): Promise<{ mandates: number; sales: number }> {
    const contacts = await this.db.all<{ person_id: string; arrived_at: string }>('SELECT person_id, arrived_at FROM ad_campaign_contacts WHERE campaign_id = ?', [campaignId]);
    const mandates = new Set<string>();
    const sales = new Set<string>();
    for (const k of contacts) {
      const members = await this.fiche.membersOf(await this.fiche.rootOf(k.person_id));
      const m = await this.db.all<{ id: string; property_id: string | null }>(`SELECT id, property_id FROM mandates WHERE person_id IN (${marks(members.length)}) AND signed_at >= ?`, [...members, k.arrived_at]);
      for (const r of m) mandates.add(r.id);
      const props = m.map((r) => r.property_id).filter((p): p is string => p !== null);
      const s = await this.db.all<{ file_id: string }>(
        `SELECT c.file_id FROM sale_file_closings c JOIN sale_files f ON f.id = c.file_id
         WHERE c.signed_on >= ? AND (f.buyer_person_id IN (${marks(members.length)})${props.length ? ` OR f.property_id IN (${marks(props.length)})` : ''})`,
        // Le jour de l'acte, à Paris, jamais le jour où il a été rangé.
        [PublicitePayante.parisDay(new Date(k.arrived_at)), ...members, ...props],
      );
      for (const r of s) sales.add(r.file_id);
    }
    return { mandates: mandates.size, sales: sales.size };
  }

  /** Le compte rendu des campagnes pour la direction : dépense, contacts, mandats, ventes et leurs coûts. */
  async report(viewer: Viewer): Promise<AdResult<CampaignReport[]>> {
    const denied = await this.direction<CampaignReport[]>(viewer, 'ad_report');
    if (denied) return denied;
    const rows = await this.db.all<CampaignRow>('SELECT id, network_id, platform, name, code, communes, radius_km, created_at FROM ad_campaigns WHERE network_id = ? ORDER BY created_at, id', [viewer.networkId]);
    const out: CampaignReport[] = [];
    for (const c of rows) {
      const a = await this.lastApproval(c.id);
      const t = await this.totals(c.id);
      const o = await this.outcomes(c.id);
      const stop = a ? await this.db.first<{ reason: StopReason }>('SELECT reason FROM ad_campaign_stops WHERE approval_id = ?', [a.id]) : null;
      const started = a ? await this.db.first<{ n: number }>('SELECT count(*) AS n FROM ad_campaign_starts WHERE approval_id = ?', [a.id]) : null;
      const state: CampaignState = !a ? 'a_valider' : stop ? 'arretee' : Number(started?.n) > 0 ? 'en_cours' : 'validee';
      const per = (n: number): number | null => (n === 0 ? null : Math.round(t.spendCents / n));
      out.push({
        id: c.id,
        platform: c.platform,
        name: c.name,
        state,
        stopReason: stop?.reason ?? null,
        spendCents: t.spendCents,
        contacts: t.contacts,
        mandates: o.mandates,
        sales: o.sales,
        costPerContactCents: per(t.contacts),
        costPerMandateCents: per(o.mandates),
        costPerSaleCents: per(o.sales),
        maxCostPerContactCents: a ? Number(a.max_cost_per_contact_cents) : null,
        ...(await this.platformState(c.id)),
      });
    }
    await appendEvent(this.journal, { type: 'publicite.compte_rendu', actor: this.actor(viewer), subject: null, data: { rule: 'R16', campaigns: out.length } }, this.now);
    return { ok: true, value: out };
  }

  /** L'accusé, le dernier échec depuis la dernière validation et les demandes à rapprocher d'une campagne. */
  private async platformState(campaignId: string): Promise<Pick<CampaignReport, 'mode' | 'failure' | 'pendingArrivals'>> {
    const r = await this.db.first<{ mode: AdMode }>('SELECT mode FROM ad_campaign_receipts WHERE campaign_id = ? ORDER BY received_at DESC, approval_id DESC LIMIT 1', [campaignId]);
    const since = await this.db.first<{ at: string | null }>('SELECT max(approved_at) AS at FROM ad_campaign_approvals WHERE campaign_id = ?', [campaignId]);
    const f = await this.db.first<{ step: AdStep; code: AdFailureCode; action: AdAction }>(
      'SELECT step, code, action FROM ad_campaign_failures WHERE campaign_id = ? AND at >= ? ORDER BY at DESC, id DESC LIMIT 1',
      [campaignId, since?.at ?? ''],
    );
    const p = await this.db.first<{ n: number }>('SELECT count(*) AS n FROM ad_campaign_arrivals WHERE campaign_id = ? AND matched_at IS NULL', [campaignId]);
    return { mode: r?.mode ?? null, failure: f ? { step: f.step, code: f.code, action: f.action } : null, pendingArrivals: Number(p?.n ?? 0) };
  }

  /** Le jour de Paris d'un instant, pour ranger la dépense du jour. */
  static parisDay(at: Date): string {
    return localTime(at, 'Europe/Paris').date;
  }
}
