/**
 * Les vraies plateformes de publicité (AU038) : Google Ads et Meta, derrière l'interface `AdPlatform` de HX54.
 *
 * Elles ne sont faites que par le Worker, et seulement quand tout est rangé (H63) : comptes du réseau, accès de
 * programmation, plafond du budget total d'une validation, lieux de chaque commune chez la plateforme, textes des
 * annonces choisis par la direction. Sinon tout reste d'essai [R587].
 *
 * Ce qui part : le code de suivi (dans le nom de la campagne et dans le lien `?o=<code>`), les communes et le rayon, les
 * budgets validés ; jamais un âge, un sexe ni aucun autre critère [R589]. Chez Meta, la catégorie spéciale « logement »
 * est toujours déclarée. La campagne est créée en pause, complétée, puis seulement activée : un échec en chemin laisse
 * une campagne en pause, que la pause demandée par HX54 retrouve par son nom.
 *
 * Chaque échec devient une `AdPlatformError` au code fermé : `reconnecter` (jeton refusé ou expiré), `acces` (le compte
 * ne donne pas l'accès), `refusee` (la plateforme refuse la demande : corriger), `lieu_inconnu` (une commune sans lieu
 * réglé), `rayon` (rayon trop petit pour le logement chez Meta), `indisponible` (quota, panne, pas de réponse). Ni le
 * jeton, ni la réponse de la plateforme ne sortent d'ici : seul le code [R13].
 */
import { AdPlatformError, type AdLaunch, type AdPlatform, type AdReceipt, type AdRef } from './publicite.ts';

/** v26, annoncée en octobre 2026 ; v21 et v22 sont arrêtées ou en fin de vie. Réglable dans le client. */
export const GOOGLE_ADS_VERSION = 'v26';
export const META_GRAPH_VERSION = 'v23.0';
/** Chez Meta, une annonce de logement vise un rayon d'au moins 15 miles autour d'une ville : 25 km, arrondi au-dessus. */
export const META_HOUSING_MIN_RADIUS_KM = 25;
/** Le plus petit plafond de dépense d'une campagne admis par Meta, en centimes. */
export const META_MIN_SPEND_CAP_CENTS = 10_000;

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const DIGITS = /^[0-9]{1,30}$/;
const GOOGLE_CAMPAIGN = /^customers\/[0-9]{1,20}\/campaigns\/[0-9]{1,30}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const CODE = /^[A-Za-z0-9_-]{4,40}$/;

type Json = Record<string, unknown>;
type Http = typeof fetch;

interface Common {
  /** L'appel HTTP vers la plateforme, donné par le Worker seul. */
  http: Http;
  /** La page d'arrivée des annonces, en https, sur un site du réseau ; le code de suivi s'y ajoute. */
  landingUrl: string;
  /** Le lieu de chaque commune chez la plateforme (code INSEE → identifiant de la plateforme), réglé à la mise en service. */
  places: Readonly<Record<string, string>>;
  now?: () => Date;
  timeoutMs?: number;
}

export interface GoogleAdsConfig extends Common {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  developerToken: string;
  /** Le compte Google Ads du réseau, en chiffres (sans tirets). */
  customerId: string;
  /** Le compte gestionnaire, s'il y en a un. */
  loginCustomerId?: string | null;
  /** Les mots clés, les titres (3 à 15, 30 caractères au plus) et les textes (2 à 4, 90 caractères au plus) des annonces. */
  keywords: readonly string[];
  headlines: readonly string[];
  descriptions: readonly string[];
  version?: string;
}

export interface MetaAdsConfig extends Common {
  /** Le jeton d'accès durable du compte publicitaire du réseau, un secret. */
  accessToken: string;
  /** Le compte publicitaire, en chiffres (sans `act_`). */
  adAccountId: string;
  /** La page Facebook du réseau, qui porte les annonces. */
  pageId: string;
  /** Le texte de l'annonce, choisi par la direction. */
  message: string;
  version?: string;
}

/** Le nom de la campagne chez la plateforme : le code de suivi, que la pause retrouve même sans accusé. */
export const platformName = (code: string): string => `AIMMO ${code}`;

/** La page d'arrivée avec le code de suivi, seul paramètre ajouté [R156]. */
export function trackedLanding(landingUrl: string, code: string): string {
  const url = new URL(landingUrl);
  url.searchParams.delete('o');
  url.searchParams.set('o', code);
  return url.toString();
}

/** Les lieux des communes, ou l'erreur qui demande de les régler : rien ne part vers une zone incomplète. */
function placesOf(launch: AdLaunch, places: Readonly<Record<string, string>>): string[] {
  const out: string[] = [];
  for (const insee of launch.communes) {
    const key = places[insee];
    if (typeof key !== 'string' || !DIGITS.test(key)) throw new AdPlatformError('lieu_inconnu');
    out.push(key);
  }
  return out;
}

/** Un appel borné dans le temps ; un appel qui n'aboutit pas, ou une réponse qui traîne, est `indisponible`. */
async function call(http: Http, timeoutMs: number, url: string, init: RequestInit): Promise<{ status: number; body: unknown }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    let res: Response;
    let text: string;
    try {
      res = await http(url, { ...init, signal: ctrl.signal, redirect: 'error' });
      text = await res.text();
    } catch {
      throw new AdPlatformError('indisponible');
    }
    let body: unknown = null;
    try {
      body = text === '' ? null : JSON.parse(text);
    } catch {
      body = null;
    }
    return { status: res.status, body };
  } finally {
    clearTimeout(timer);
  }
}

const obj = (v: unknown): Json | null => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : null);

/** Le code fermé d'une réponse d'erreur de Google, sans garder son message. */
export function googleAdsError(status: number, body: unknown): AdPlatformError {
  const err = obj(body)?.error;
  const reason = typeof err === 'string' ? err : typeof obj(err)?.status === 'string' ? String(obj(err)!.status) : '';
  if (status === 401 || reason === 'UNAUTHENTICATED' || reason === 'invalid_grant' || reason === 'invalid_client' || reason === 'unauthorized_client') return new AdPlatformError('reconnecter');
  if (status === 429 || reason === 'RESOURCE_EXHAUSTED' || status >= 500) return new AdPlatformError('indisponible');
  if (status === 403 || reason === 'PERMISSION_DENIED') return new AdPlatformError('acces');
  if (status === 400 || status === 404 || status === 409 || reason === 'INVALID_ARGUMENT' || reason === 'FAILED_PRECONDITION') return new AdPlatformError('refusee');
  return new AdPlatformError('inconnue');
}

/** Le code fermé d'une réponse d'erreur de Meta (codes de l'API Graph), sans garder son message. */
export function metaAdsError(status: number, body: unknown): AdPlatformError {
  const e = obj(obj(body)?.error);
  const code = typeof e?.code === 'number' ? e.code : -1;
  if (code === 190 || code === 102 || status === 401) return new AdPlatformError('reconnecter');
  if (code === 4 || code === 17 || code === 32 || code === 613 || code === 80004 || code === 2 || status === 429 || status >= 500) return new AdPlatformError('indisponible');
  if (code === 10 || code === 200 || code === 294 || (code >= 200 && code <= 299) || status === 403) return new AdPlatformError('acces');
  if (code === 100 || status === 400) return new AdPlatformError('refusee');
  return new AdPlatformError('inconnue');
}

function checkCommon(c: Common): void {
  let url: URL;
  try {
    url = new URL(c.landingUrl);
  } catch {
    throw new Error('page d’arrivée invalide');
  }
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('page d’arrivée : https seulement');
}

/** Google Ads : une campagne sur le Réseau de Recherche, sa zone en communes, ses mots clés et son annonce. */
export function googleAdsPlatform(config: GoogleAdsConfig): AdPlatform {
  checkCommon(config);
  const { clientId, clientSecret, refreshToken, developerToken } = config;
  if ([clientId, clientSecret, refreshToken, developerToken].some((v) => typeof v !== 'string' || v.trim() === '')) throw new Error('Compte Google Ads incomplet');
  if (!/^[0-9]{10}$/.test(config.customerId) || (config.loginCustomerId != null && !/^[0-9]{10}$/.test(config.loginCustomerId))) throw new Error('Compte Google Ads : dix chiffres');
  const headlines = config.headlines.map((h) => h.trim()).filter((h) => h.length > 0);
  const descriptions = config.descriptions.map((h) => h.trim()).filter((h) => h.length > 0);
  const keywords = config.keywords.map((h) => h.trim()).filter((h) => h.length > 0);
  if (headlines.length < 3 || headlines.length > 15 || headlines.some((h) => h.length > 30)) throw new Error('Titres Google Ads : 3 à 15, 30 caractères au plus');
  if (descriptions.length < 2 || descriptions.length > 4 || descriptions.some((h) => h.length > 90)) throw new Error('Textes Google Ads : 2 à 4, 90 caractères au plus');
  if (keywords.length < 1 || keywords.length > 50 || keywords.some((k) => k.length > 80)) throw new Error('Mots clés Google Ads : 1 à 50');
  const http = config.http;
  const now = config.now ?? (() => new Date());
  const timeoutMs = config.timeoutMs ?? 20_000;
  const base = `https://googleads.googleapis.com/${config.version ?? GOOGLE_ADS_VERSION}/customers/${config.customerId}`;
  let token: { value: string; until: number } | null = null;

  async function accessToken(): Promise<string> {
    if (token && token.until > now().getTime()) return token.value;
    const form = new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: 'refresh_token' });
    const r = await call(http, timeoutMs, TOKEN_URL, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form.toString() });
    const b = obj(r.body);
    if (r.status !== 200 || typeof b?.access_token !== 'string') throw googleAdsError(r.status === 200 ? 500 : r.status, r.body);
    const life = typeof b.expires_in === 'number' ? b.expires_in : 3600;
    token = { value: b.access_token, until: now().getTime() + Math.max(0, life - 60) * 1000 };
    return token.value;
  }

  async function post(path: string, payload: unknown): Promise<Json> {
    const headers: Record<string, string> = { authorization: `Bearer ${await accessToken()}`, 'developer-token': developerToken, 'content-type': 'application/json' };
    if (config.loginCustomerId) headers['login-customer-id'] = config.loginCustomerId;
    const r = await call(http, timeoutMs, `${base}/${path}`, { method: 'POST', headers, body: JSON.stringify(payload) });
    if (r.status !== 200) throw googleAdsError(r.status, r.body);
    return obj(r.body) ?? {};
  }

  /** La référence de la première ligne rendue par une création ; sans elle, rien n'est tenu pour créé. */
  async function create(path: string, operations: unknown[]): Promise<string[]> {
    const b = await post(path, { operations });
    const results = Array.isArray(b.results) ? b.results : [];
    const names = results.map((x) => obj(x)?.resourceName).filter((x): x is string => typeof x === 'string' && x.startsWith(`customers/${config.customerId}/`));
    if (names.length !== operations.length) throw new AdPlatformError('inconnue');
    return names;
  }

  async function search(query: string): Promise<Json[]> {
    const b = await post('googleAds:search', { query });
    return (Array.isArray(b.results) ? b.results : []).map((x) => obj(x) ?? {});
  }

  async function setStatus(resourceName: string, status: 'PAUSED' | 'ENABLED'): Promise<void> {
    await create('campaigns:mutate', [{ update: { resourceName, status }, updateMask: 'status' }]);
  }

  return {
    mode: 'reel',
    async start(launch: AdLaunch): Promise<AdReceipt> {
      if (!CODE.test(launch.code)) throw new AdPlatformError('refusee');
      const places = placesOf(launch, config.places);
      // Google refuse deux campagnes (ou deux budgets) du même nom, même en pause : chaque lancement a le sien, qui
      // commence toujours par le code de suivi, pour que la pause le retrouve sans accusé.
      const name = `${platformName(launch.code)} ${now().toISOString().replace(/[-:.]/g, '')}`;
      const [budget] = await create('campaignBudgets:mutate', [{ create: { name, amountMicros: String(launch.dailyBudgetCents * 10_000), deliveryMethod: 'STANDARD', explicitlyShared: false } }]);
      // Créée en pause : rien ne dépense avant que la zone, les mots et l'annonce soient en place.
      const [campaign] = await create('campaigns:mutate', [
        {
          create: {
            name,
            status: 'PAUSED',
            advertisingChannelType: 'SEARCH',
            campaignBudget: budget,
            manualCpc: {},
            networkSettings: { targetGoogleSearch: true, targetSearchNetwork: false, targetContentNetwork: false },
            geoTargetTypeSetting: { positiveGeoTargetType: 'PRESENCE' },
            containsEuPoliticalAdvertising: 'DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING',
          },
        },
      ]);
      // Les communes seules : ni âge, ni sexe, ni audience [R589]. Le rayon n'a pas de sens autour d'une commune ici.
      await create('campaignCriteria:mutate', places.map((p) => ({ create: { campaign, location: { geoTargetConstant: `geoTargetConstants/${p}` } } })));
      const cpc = Math.max(100, Math.min(launch.dailyBudgetCents, Math.floor(launch.dailyBudgetCents / 10)));
      const [group] = await create('adGroups:mutate', [{ create: { name, campaign, status: 'ENABLED', type: 'SEARCH_STANDARD', cpcBidMicros: String(cpc * 10_000) } }]);
      await create('adGroupCriteria:mutate', keywords.map((text) => ({ create: { adGroup: group, status: 'ENABLED', keyword: { text, matchType: 'PHRASE' } } })));
      await create('adGroupAds:mutate', [
        {
          create: {
            adGroup: group,
            status: 'ENABLED',
            ad: { finalUrls: [trackedLanding(config.landingUrl, launch.code)], responsiveSearchAd: { headlines: headlines.map((text) => ({ text })), descriptions: descriptions.map((text) => ({ text })) } },
          },
        },
      ]);
      await setStatus(campaign!, 'ENABLED');
      return { externalRef: campaign! };
    },
    async pause(code: string, externalRef?: string | null): Promise<void> {
      let refs: string[];
      if (typeof externalRef === 'string' && GOOGLE_CAMPAIGN.test(externalRef)) refs = [externalRef];
      else {
        if (!CODE.test(code)) throw new AdPlatformError('refusee');
        // Chaque lancement de ce code, déjà en pause ou non : redemander une pause ne coûte rien.
        const rows = await search(`SELECT campaign.resource_name FROM campaign WHERE campaign.name LIKE '${platformName(code)} %' AND campaign.status != 'REMOVED'`);
        refs = rows.map((r) => obj(r.campaign)?.resourceName).filter((x): x is string => typeof x === 'string' && GOOGLE_CAMPAIGN.test(x));
      }
      // Rien trouvé sous ce nom : rien ne dépense, la pause est tenue.
      for (const r of refs) await setStatus(r, 'PAUSED');
    },
    async spend(ref: AdRef, day: string): Promise<number> {
      if (!DAY.test(day) || typeof ref.externalRef !== 'string' || !GOOGLE_CAMPAIGN.test(ref.externalRef)) throw new AdPlatformError('inconnue');
      const rows = await search(`SELECT metrics.cost_micros FROM campaign WHERE campaign.resource_name = '${ref.externalRef}' AND segments.date = '${day}'`);
      let micros = 0;
      for (const r of rows) {
        const v = obj(r.metrics)?.costMicros;
        const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
        if (!Number.isFinite(n) || n < 0) throw new AdPlatformError('inconnue');
        micros += n;
      }
      return Math.round(micros / 10_000);
    },
  };
}

/** Meta : une campagne de la catégorie « logement », son ensemble de publicités autour des communes et son annonce. */
export function metaAdsPlatform(config: MetaAdsConfig): AdPlatform {
  checkCommon(config);
  if (typeof config.accessToken !== 'string' || config.accessToken.trim() === '') throw new Error('Compte Meta incomplet');
  if (!DIGITS.test(config.adAccountId) || !DIGITS.test(config.pageId)) throw new Error('Compte Meta : identifiants en chiffres');
  const message = config.message.trim();
  if (message.length < 10 || message.length > 500) throw new Error('Texte Meta : 10 à 500 caractères');
  const http = config.http;
  const timeoutMs = config.timeoutMs ?? 20_000;
  const graph = `https://graph.facebook.com/${config.version ?? META_GRAPH_VERSION}`;
  const account = `${graph}/act_${config.adAccountId}`;
  const auth = { authorization: `Bearer ${config.accessToken}` };

  async function post(url: string, payload: Json): Promise<Json> {
    const r = await call(http, timeoutMs, url, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify(payload) });
    if (r.status !== 200) throw metaAdsError(r.status, r.body);
    return obj(r.body) ?? {};
  }
  async function get(url: string): Promise<Json> {
    const r = await call(http, timeoutMs, url, { method: 'GET', headers: auth });
    if (r.status !== 200) throw metaAdsError(r.status, r.body);
    return obj(r.body) ?? {};
  }
  async function created(url: string, payload: Json): Promise<string> {
    const id = (await post(url, payload)).id;
    if (typeof id !== 'string' || !DIGITS.test(id)) throw new AdPlatformError('inconnue');
    return id;
  }

  return {
    mode: 'reel',
    async start(launch: AdLaunch): Promise<AdReceipt> {
      if (!CODE.test(launch.code)) throw new AdPlatformError('refusee');
      // Le logement chez Meta : un rayon d'au moins 15 miles autour de chaque ville ; rien ne part en dessous.
      if (launch.radiusKm === null || launch.radiusKm < META_HOUSING_MIN_RADIUS_KM) throw new AdPlatformError('rayon');
      const places = placesOf(launch, config.places);
      const name = platformName(launch.code);
      // La catégorie spéciale « logement », toujours ; le budget total en plafond de dépense de la campagne, quand Meta
      // l'admet (100 unités de la monnaie du compte au moins). En dessous, l'arrêt au budget de HX54 tient seul [R588].
      const campaign = await created(`${account}/campaigns`, {
        name,
        objective: 'OUTCOME_TRAFFIC',
        status: 'PAUSED',
        special_ad_categories: ['HOUSING'],
        special_ad_category_country: ['FR'],
        ...(launch.totalBudgetCents >= META_MIN_SPEND_CAP_CENTS ? { spend_cap: launch.totalBudgetCents } : {}),
      });
      // Les villes et leur rayon, pour tous les adultes : aucun autre critère [R589].
      const adset = await created(`${account}/adsets`, {
        name,
        campaign_id: campaign,
        daily_budget: launch.dailyBudgetCents,
        billing_event: 'IMPRESSIONS',
        optimization_goal: 'LINK_CLICKS',
        bid_strategy: 'LOWEST_COST_WITHOUT_CAP',
        status: 'ACTIVE',
        targeting: { geo_locations: { cities: places.map((key) => ({ key, radius: launch.radiusKm, distance_unit: 'kilometer' })), location_types: ['home', 'recent'] }, age_min: 18, age_max: 65 },
      });
      const creative = await created(`${account}/adcreatives`, { name, object_story_spec: { page_id: config.pageId, link_data: { link: trackedLanding(config.landingUrl, launch.code), message } } });
      await created(`${account}/ads`, { name, adset_id: adset, creative: { creative_id: creative }, status: 'ACTIVE' });
      const on = await post(`${graph}/${campaign}`, { status: 'ACTIVE' });
      if (on.success !== true) throw new AdPlatformError('inconnue');
      return { externalRef: campaign };
    },
    async pause(code: string, externalRef?: string | null): Promise<void> {
      let ids: string[];
      if (typeof externalRef === 'string' && DIGITS.test(externalRef)) ids = [externalRef];
      else {
        if (!CODE.test(code)) throw new AdPlatformError('refusee');
        const filtering = JSON.stringify([{ field: 'name', operator: 'EQUAL', value: platformName(code) }]);
        const b = await get(`${account}/campaigns?fields=id&filtering=${encodeURIComponent(filtering)}`);
        ids = (Array.isArray(b.data) ? b.data : []).map((x) => obj(x)?.id).filter((x): x is string => typeof x === 'string' && DIGITS.test(x));
      }
      for (const id of ids) {
        const r = await post(`${graph}/${id}`, { status: 'PAUSED' });
        if (r.success !== true) throw new AdPlatformError('inconnue');
      }
    },
    async spend(ref: AdRef, day: string): Promise<number> {
      if (!DAY.test(day) || typeof ref.externalRef !== 'string' || !DIGITS.test(ref.externalRef)) throw new AdPlatformError('inconnue');
      const range = JSON.stringify({ since: day, until: day });
      const b = await get(`${graph}/${ref.externalRef}/insights?fields=spend&time_range=${encodeURIComponent(range)}`);
      const rows = Array.isArray(b.data) ? b.data : [];
      let total = 0;
      for (const r of rows) {
        const v = obj(r)?.spend;
        // La dépense en unités de la monnaie du compte, en texte (« 12.34 ») : ramenée en centimes.
        if (typeof v !== 'string' || !/^\d{1,12}(\.\d{1,2})?$/.test(v)) throw new AdPlatformError('inconnue');
        total += Math.round(Number(v) * 100);
      }
      return total;
    },
  };
}
