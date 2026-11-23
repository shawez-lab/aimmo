/**
 * Adresse probable d'une annonce de particulier, et bien créé sans ressaisie (HX18) [R294, R295, R296].
 *
 * - Pour une annonce ouverte de la pige (HX11), les adresses possibles sont tirées des seuls diagnostics énergétiques
 *   publiés par l'ADEME : même sorte, même code postal et même commune, surface à 1 m² près, et, quand l'annonce les
 *   dit, même classe énergie et même date de diagnostic. Le cadastre confirme la parcelle de chaque adresse. Chaque
 *   adresse porte sa confiance, de 0 à 100, et chaque point de confiance cite sa donnée, sa source et sa date ; la
 *   confiance se partage entre les adresses qui restent. Le calcul est une fonction pure [R294].
 * - Les coordonnées du particulier ne sont jamais cherchées : aucun nom, aucun numéro, aucun mail, aucun propriétaire ;
 *   une adresse qui porte une civilité ou un nom est écartée. Seuls le code postal, la sorte, la surface et la classe
 *   partent vers l'ADEME ; seuls les champs de la liste fermée de HX16 sont lus [R294, R288].
 * - L'agent de la zone crée la fiche du bien d'un geste : tous les champs de l'annonce sont repris, sans ressaisie, et
 *   la source « pige » reste attachée au bien jusqu'au mandat. Un bien « pas d'agence », ou fermé par un non, n'est
 *   jamais converti, ni par le code, ni par la base. Un seul bien par bien de pige [R295, R273, R04].
 * - Jamais vu : ce que la pige rapporte se mesure, biens créés et mandats signés, par niveau de confiance de l'adresse
 *   retenue [R296].
 * Rien n'est envoyé ; au journal, des identifiants et des nombres, jamais une adresse [R13].
 */
import type { Viewer } from '../acces/droits.ts';
import { agentState } from '../acces/etat-agent.ts';
import { communeSlug } from '../attirer/liste-biens.ts';
import { runBatch, type SqlDatabase } from '../db/sql.ts';
import type { CadastreService, Fetcher } from '../estimation/collecte.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import type { OpenAd, Pige, PigeEnergyClass, PigeKind, PigeProblem } from '../pige/pige.ts';
import { addressCarriesPerson } from '../score-adresse/score.ts';
import { ADEME_FIELDS, readDiagnosis, type Diagnosis } from '../veille-dpe/veille.ts';

export const ENERGY_SOURCE = 'Diagnostics de performance énergétique (ADEME)';
export const CADASTRE_SOURCE = 'Cadastre (IGN, API Carto)';
/** Écart de surface tenu pour le même logement, en m² : celui de la pige (HX11). */
export const ADDRESS_SURFACE_TOLERANCE_M2 = 1;
/** Un diagnostic plus vieux que cela n'est plus valable : il ne propose pas d'adresse. */
export const DIAGNOSIS_VALIDITY_YEARS = 10;
/** Au plus tant d'adresses montrées. */
export const MAX_CANDIDATES = 5;

export const CONFIDENCE_LEVELS = ['forte', 'moyenne', 'faible'] as const;
export type ConfidenceLevel = (typeof CONFIDENCE_LEVELS)[number];
export const levelOf = (c: number): ConfidenceLevel => (c >= 70 ? 'forte' : c >= 40 ? 'moyenne' : 'faible');

export const CRITERIA = ['surface', 'classe_energie', 'date_diagnostic', 'cadastre', 'partage'] as const;
export type Criterion = (typeof CRITERIA)[number];

/** Un point de confiance : sa donnée en mots, sa source et sa date. Aucun nom [R294]. */
export interface ConfidencePoint {
  criterion: Criterion;
  points: number;
  fact: string;
  source: string;
  /** `AAAA-MM-JJ`. */
  date: string;
}

export interface AddressCandidate {
  diagnosisNumber: string;
  streetNumber: string | null;
  street: string;
  postcode: string;
  commune: string;
  confidence: number;
  level: ConfidenceLevel;
  points: ConfidencePoint[];
}

/** Ce que l'annonce dit du bien : rien d'autre n'entre au calcul. */
export interface AdFacts {
  kind: PigeKind;
  postcode: string;
  commune: string;
  surfaceM2: number;
  energyClass: PigeEnergyClass | null;
  diagnosedOn: string | null;
  /** Le jour de publication, `AAAA-MM-JJ`. */
  publishedOn: string;
  site: string;
}

/** La parcelle trouvée sous chaque diagnostic, par son numéro, et le jour de lecture. */
export interface ParcelFacts {
  byDiagnosis: Readonly<Record<string, { id: string; areaM2: number | null } | null>>;
  readOn: string;
}

const fr = (n: number): string => String(Math.round(n * 100) / 100).replace('.', ',');
const shiftYears = (day: string, years: number): string => `${String(Number(day.slice(0, 4)) + years).padStart(4, '0')}${day.slice(4)}`;

/**
 * Les adresses probables d'une annonce, par les seules règles écrites ici : une fonction pure, rejouable. Un critère que
 * l'annonce tait ne donne aucun point et le dit ; un critère qu'elle dit et que le diagnostic contredit écarte
 * l'adresse [R294].
 */
export function proposeAddresses(ad: AdFacts, diagnoses: readonly Diagnosis[], parcels: ParcelFacts, limit: number = MAX_CANDIDATES): AddressCandidate[] {
  const slug = communeSlug(ad.commune);
  const oldest = shiftYears(ad.publishedOn, -DIAGNOSIS_VALIDITY_YEARS);
  const seen = new Set<string>();
  const kept: { d: Diagnosis; points: ConfidencePoint[]; base: number }[] = [];
  const sorted = [...diagnoses].sort((a, b) => (a.number < b.number ? -1 : a.number > b.number ? 1 : 0));
  for (const d of sorted) {
    if (seen.has(d.number)) continue;
    seen.add(d.number);
    if (d.kind !== ad.kind || d.postcode !== ad.postcode || communeSlug(d.commune) !== slug) continue;
    if (d.surfaceM2 === null || Math.abs(d.surfaceM2 - ad.surfaceM2) > ADDRESS_SURFACE_TOLERANCE_M2) continue;
    if (d.diagnosedOn > ad.publishedOn || d.diagnosedOn < oldest) continue;
    if (ad.energyClass && d.energyClass !== ad.energyClass) continue;
    if (ad.diagnosedOn && d.diagnosedOn !== ad.diagnosedOn) continue;
    const label = [d.streetNumber, d.street, d.postcode, d.commune].filter(Boolean).join(' ');
    if (addressCarriesPerson(label)) continue;
    const points: ConfidencePoint[] = [];
    const exact = Math.abs(d.surfaceM2 - ad.surfaceM2) < 0.5;
    points.push({
      criterion: 'surface',
      points: exact ? 35 : 25,
      fact: `Surface de ${ad.surfaceM2} m² dans l’annonce, ${fr(d.surfaceM2)} m² au diagnostic n° ${d.number}.`,
      source: ENERGY_SOURCE,
      date: d.diagnosedOn,
    });
    points.push(
      ad.energyClass
        ? { criterion: 'classe_energie', points: 25, fact: `Classe énergie ${ad.energyClass} dans l’annonce et au diagnostic.`, source: ENERGY_SOURCE, date: d.diagnosedOn }
        : { criterion: 'classe_energie', points: 0, fact: `L’annonce ne dit pas sa classe énergie : le diagnostic est classé ${d.energyClass}.`, source: ad.site, date: ad.publishedOn },
    );
    points.push(
      ad.diagnosedOn
        ? { criterion: 'date_diagnostic', points: 25, fact: `Diagnostic du ${ad.diagnosedOn.split('-').reverse().join('/')} dans l’annonce et à l’ADEME.`, source: ENERGY_SOURCE, date: d.diagnosedOn }
        : { criterion: 'date_diagnostic', points: 0, fact: 'L’annonce ne dit pas la date de son diagnostic.', source: ad.site, date: ad.publishedOn },
    );
    const parcel = parcels.byDiagnosis[d.number];
    points.push(
      parcel
        ? { criterion: 'cadastre', points: 15, fact: `Parcelle cadastrale ${parcel.id} à cette adresse.`, source: CADASTRE_SOURCE, date: parcels.readOn }
        : { criterion: 'cadastre', points: 0, fact: 'Aucune parcelle cadastrale lue à cette adresse.', source: CADASTRE_SOURCE, date: parcels.readOn },
    );
    // Une même adresse ne compte qu'une fois : plusieurs diagnostics d'un même logement n'en font pas des adresses
    // concurrentes ; le plus récent la représente.
    const where = [d.streetNumber ?? '', communeSlug(d.street), d.postcode, slug].join('|');
    const twin = kept.findIndex((k) => [k.d.streetNumber ?? '', communeSlug(k.d.street), k.d.postcode, slug].join('|') === where);
    const entry = { d, points, base: Math.min(100, points.reduce((n, p) => n + p.points, 0)) };
    if (twin === -1) kept.push(entry);
    else if (d.diagnosedOn > kept[twin]!.d.diagnosedOn) kept[twin] = entry;
  }
  const total = kept.reduce((n, k) => n + k.base, 0);
  const out = kept.map(({ d, points, base }): AddressCandidate => {
    // La confiance se partage entre les adresses qui restent, au prorata de leurs points : deux adresses aussi probables
    // l'une que l'autre en ont chacune la moitié.
    const confidence = kept.length === 1 ? base : Math.round((base * base) / total);
    const all = kept.length === 1 ? points : [...points, { criterion: 'partage' as const, points: confidence - base, fact: `${kept.length} adresses répondent à l’annonce : la confiance se partage entre elles.`, source: ENERGY_SOURCE, date: ad.publishedOn }];
    return { diagnosisNumber: d.number, streetNumber: d.streetNumber, street: d.street, postcode: d.postcode, commune: d.commune, confidence, level: levelOf(confidence), points: all };
  });
  out.sort((a, b) => b.confidence - a.confidence || (a.diagnosisNumber < b.diagnosisNumber ? -1 : 1));
  return out.slice(0, limit);
}

/** La recherche des diagnostics publiés qui ressemblent à une annonce : les lignes brutes, lues ensuite champ par champ. */
export interface DiagnosisSearch {
  matching(query: { postcode: string; kind: PigeKind; surfaceMin: number; surfaceMax: number; energyClass: PigeEnergyClass | null }): Promise<readonly unknown[]>;
}

export const ADEME_SEARCH_MAX_PAGES = 10;
/** Au plus tant de parcelles lues pour une annonce ; au-delà, la source le dit. */
export const MAX_PARCEL_READS = 50;
export const ADEME_SEARCH_URL = 'https://data.ademe.fr/data-fair/api/v1/datasets/dpe03existant/lines';
const ADEME_KIND: Record<PigeKind, string> = { apartment: 'appartement', house: 'maison' };

/** Le vrai branchement à la base ouverte de l'ADEME. Seuls le code postal, la sorte, la surface et la classe partent. */
export class AdemeDiagnosisSearch implements DiagnosisSearch {
  constructor(
    private readonly fetcher: Fetcher,
    private readonly base = ADEME_SEARCH_URL,
  ) {}

  async matching(q: { postcode: string; kind: PigeKind; surfaceMin: number; surfaceMax: number; energyClass: PigeEnergyClass | null }): Promise<readonly unknown[]> {
    if (!/^\d{5}$/.test(q.postcode) || !Number.isFinite(q.surfaceMin) || !Number.isFinite(q.surfaceMax)) return [];
    const parts = [`code_postal_ban:"${q.postcode}"`, `type_batiment:"${ADEME_KIND[q.kind]}"`, `surface_habitable_logement:[${q.surfaceMin} TO ${q.surfaceMax}]`];
    if (q.energyClass) parts.push(`etiquette_dpe:"${q.energyClass}"`);
    let url: string | null = `${this.base}?qs=${encodeURIComponent(parts.join(' AND '))}&size=100&select=${ADEME_FIELDS.join(',')}`;
    const out: unknown[] = [];
    for (let page = 0; url && page < ADEME_SEARCH_MAX_PAGES; page += 1) {
      const res = await this.fetcher(url, { headers: { accept: 'application/json' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as Record<string, unknown> | null;
      if (body && Array.isArray(body['results'])) out.push(...body['results']);
      const next = body ? body['next'] : null;
      // La page suivante n'est suivie que sur la même adresse de base : jamais ailleurs.
      url = typeof next === 'string' && next.startsWith(`${this.base}?`) ? next : null;
    }
    return out;
  }
}

export interface AdressePigeServices {
  /** La recherche dans la base de l'ADEME ; sans elle, seuls les diagnostics déjà rangés par la veille (HX16) servent. */
  search?: DiagnosisSearch;
  cadastre?: CadastreService;
}

type Refusal = { ok: false; rule: 'R16'; code: string };
type Problem = { ok: false; rule: 'R294' | 'R295' | 'R273' | 'R04' | 'R05' | null; code: string };

export interface Proposal {
  proposalId: string;
  adId: string;
  candidates: AddressCandidate[];
  /** Les sources qui n'ont rien donné, avec la raison. */
  missing: { source: string; reason: string }[];
}

export interface PigeProperty {
  propertyId: string;
  reference: string;
  kind: 'home';
  adKind: PigeKind;
  postalCode: string;
  city: string;
  surfaceM2: number;
  rooms: number | null;
  priceEur: number;
  energyClass: PigeEnergyClass | null;
  diagnosedOn: string | null;
  source: 'pige';
  adSite: string;
  publishedAt: string;
  address: { streetNumber: string | null; street: string; confidence: number; level: ConfidenceLevel; diagnosisNumber: string } | null;
}

export interface PigeYield {
  /** Par niveau de confiance de l'adresse retenue, puis sans adresse. */
  rows: { level: ConfidenceLevel | 'sans_adresse'; properties: number; mandates: number }[];
  properties: number;
  mandates: number;
  /** Mandats signés par bien créé depuis la pige, ou null sans bien. */
  rate: number | null;
}

export interface AdressePigeOptions {
  now?: () => Date;
  newId?: () => string;
  newReference?: () => string;
}

const asProblem = (p: PigeProblem): Problem => ({ ok: false, rule: p.rule === 'R273' || p.rule === 'R04' || p.rule === 'R05' ? p.rule : null, code: p.code });

export class AdressePige {
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly newReference: () => string;

  constructor(
    private readonly db: SqlDatabase,
    private readonly journal: JournalStore,
    private readonly pige: Pige,
    private readonly services: AdressePigeServices = {},
    options: AdressePigeOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => crypto.randomUUID());
    this.newReference = options.newReference ?? (() => `B-${crypto.randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase()}`);
  }

  private actor(viewer: Viewer): string {
    return `${String(viewer.role)}:${viewer.userId}`;
  }

  private async refuse(viewer: Viewer, subject: string, code: string): Promise<Refusal> {
    await appendEvent(this.journal, { type: 'acces.refuse', actor: this.actor(viewer), subject, data: { rule: 'R16', role: String(viewer.role), kind: 'adresse_pige', code } }, this.now);
    return { ok: false, rule: 'R16', code };
  }

  /** Seul un agent du réseau en activité ; la direction lit la mesure. */
  private async gate(viewer: Viewer, subject: string, agentOnly: boolean): Promise<Refusal | null> {
    if (viewer.role !== 'agent' && (agentOnly || viewer.role !== 'direction')) return this.refuse(viewer, subject, 'role');
    if (viewer.role === 'agent') {
      const a = await this.db.first<{ id: string }>('SELECT id FROM agents WHERE id = ? AND network_id = ?', [viewer.userId, viewer.networkId]);
      if (!a || (await agentState(this.db, viewer.networkId, viewer.userId, this.now())) !== 'actif') return this.refuse(viewer, subject, 'agent_inactive');
    }
    return null;
  }

  /** Ce que dit du diagnostic la dernière relève de cette annonce sur son site : une correction remplace l'ancienne. */
  private async energyOf(adId: string): Promise<{ energy_class: PigeEnergyClass | null; diagnosed_on: string | null } | null> {
    const r = await this.db.first<{ energy_class: PigeEnergyClass | null; diagnosed_on: string | null }>(
      `SELECT e.energy_class, e.diagnosed_on FROM pige_ads a
         JOIN pige_ads b ON b.network_id = a.network_id AND b.source = a.source AND b.source_ref = a.source_ref
         LEFT JOIN pige_ad_energy e ON e.ad_id = b.id
        WHERE a.id = ? ORDER BY b.collected_at DESC, b.rowid DESC LIMIT 1`,
      [adId],
    );
    return r && (r.energy_class || r.diagnosed_on) ? { energy_class: r.energy_class, diagnosed_on: r.diagnosed_on } : null;
  }

  /**
   * La dernière relève, sur son site, de l'annonce demandée, ouverte et de la zone de cet agent : rien ne mélange deux
   * relèves [R295]. `askedId` est l'identifiant demandé.
   */
  private async current(viewer: Viewer, adId: unknown): Promise<(OpenAd & { askedId: string }) | Problem> {
    const asked = await this.open(viewer, adId);
    if ('ok' in asked) return asked;
    const latest = await this.db.first<{ id: string }>(
      `SELECT b.id FROM pige_ads a JOIN pige_ads b ON b.network_id = a.network_id AND b.source = a.source AND b.source_ref = a.source_ref
        WHERE a.id = ? ORDER BY b.collected_at DESC, b.rowid DESC LIMIT 1`,
      [asked.id],
    );
    const ad = latest && latest.id !== asked.id ? await this.open(viewer, latest.id) : asked;
    return 'ok' in ad ? ad : { ...ad, askedId: asked.id };
  }

  /** Une annonce ouverte de la zone de cet agent, ou la raison du refus : « pas d'agence » et non ferment tout. */
  private async open(viewer: Viewer, adId: unknown): Promise<OpenAd | Problem> {
    const ad = await this.pige.openAd(viewer, adId);
    return 'ok' in ad ? asProblem(ad) : ad;
  }

  /** Les adresses probables d'une annonce de la file, chacune avec sa confiance et ses sources [R294]. */
  async propose(viewer: Viewer, adId: unknown): Promise<({ ok: true } & Proposal) | Refusal | Problem> {
    const g = await this.gate(viewer, `pige_ad:${String(adId)}`, true);
    if (g) return g;
    const ad = await this.current(viewer, adId);
    if ('ok' in ad) return ad;
    const { candidates, missing } = await this.compute(viewer, ad);
    const id = this.newId();
    // Rangés : le numéro de chaque diagnostic et sa confiance, jamais l'adresse elle-même, qui se relit à la source [R273].
    const kept = candidates.map((c) => ({ diagnosisNumber: c.diagnosisNumber, confidence: c.confidence, level: c.level }));
    await this.db.run('INSERT INTO pige_address_proposals (id, network_id, ad_id, agent_id, candidates, missing, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [
      id, viewer.networkId, ad.id, viewer.userId, JSON.stringify(kept), JSON.stringify(missing), this.now().toISOString(),
    ]);
    await appendEvent(this.journal, { type: 'pige.adresses_proposees', actor: this.actor(viewer), subject: `pige_ad:${ad.id}`, data: { rule: 'R294', candidates: candidates.length, best: candidates[0]?.confidence ?? null } }, this.now);
    return { ok: true, proposalId: id, adId: ad.id, candidates, missing };
  }

  /** Les adresses probables, relues aux sources à chaque fois [R294]. */
  private async compute(viewer: Viewer, ad: OpenAd): Promise<{ candidates: AddressCandidate[]; missing: { source: string; reason: string }[] }> {
    const energy = await this.energyOf(ad.id);
    const now = this.now();
    const today = now.toISOString().slice(0, 10);
    const facts: AdFacts = {
      kind: ad.kind,
      postcode: ad.postal_code,
      commune: ad.commune,
      surfaceM2: ad.surface_m2,
      energyClass: energy?.energy_class ?? null,
      diagnosedOn: energy?.diagnosed_on ?? null,
      publishedOn: ad.published_at.slice(0, 10),
      site: ad.source,
    };
    const missing: { source: string; reason: string }[] = [];
    const diagnoses: Diagnosis[] = [];
    // Les diagnostics déjà rangés par la veille du réseau (HX16), puis ceux de la base de l'ADEME.
    const stored = await this.db.all<{ number: string; kind: Diagnosis['kind']; energy_class: Diagnosis['energyClass']; ghg_class: Diagnosis['ghgClass']; surface_m2: number | null; diagnosed_on: string; received_on: string; street_number: string | null; street: string; postcode: string; commune: string; lat: number | null; lon: number | null }>(
      `SELECT number, kind, energy_class, ghg_class, surface_m2, diagnosed_on, received_on, street_number, street, postcode, commune, lat, lon
         FROM dpe_diagnoses WHERE network_id = ? AND postcode = ? AND commune_slug = ? AND kind = ? AND surface_m2 BETWEEN ? AND ?`,
      [viewer.networkId, ad.postal_code, communeSlug(ad.commune), ad.kind, ad.surface_m2 - ADDRESS_SURFACE_TOLERANCE_M2, ad.surface_m2 + ADDRESS_SURFACE_TOLERANCE_M2],
    );
    for (const r of stored) {
      diagnoses.push({ number: r.number, kind: r.kind, energyClass: r.energy_class, ghgClass: r.ghg_class, surfaceM2: r.surface_m2 === null ? null : Number(r.surface_m2), diagnosedOn: r.diagnosed_on, receivedOn: r.received_on, streetNumber: r.street_number, street: r.street, postcode: r.postcode, commune: r.commune, lat: r.lat, lon: r.lon });
    }
    if (this.services.search) {
      try {
        const raws = await this.services.search.matching({ postcode: ad.postal_code, kind: ad.kind, surfaceMin: ad.surface_m2 - ADDRESS_SURFACE_TOLERANCE_M2, surfaceMax: ad.surface_m2 + ADDRESS_SURFACE_TOLERANCE_M2, energyClass: facts.energyClass });
        for (const raw of raws) {
          // Lu champ par champ dans la liste fermée de HX16 : un nom, un numéro de plus ne passent jamais [R288].
          const d = readDiagnosis(raw, ad.postal_code);
          if (d.ok) diagnoses.push(d.value);
        }
      } catch {
        missing.push({ source: ENERGY_SOURCE, reason: 'base de l’ADEME injoignable : seuls les diagnostics de la veille ont servi' });
      }
    } else {
      missing.push({ source: ENERGY_SOURCE, reason: 'base de l’ADEME non branchée : seuls les diagnostics de la veille ont servi' });
    }
    // Le cadastre, seulement pour les diagnostics qui peuvent encore répondre.
    // Toutes les adresses possibles, avant toute limite : chacune peut recevoir ses points du cadastre.
    const first = proposeAddresses(facts, diagnoses, { byDiagnosis: {}, readOn: today }, Number.POSITIVE_INFINITY);
    let reads = 0;
    const byDiagnosis: Record<string, { id: string; areaM2: number | null } | null> = {};
    let cadastreDown = false;
    for (const c of first) {
      const d = diagnoses.find((x) => x.number === c.diagnosisNumber);
      if (!d || d.lat === null || d.lon === null || !this.services.cadastre || cadastreDown || reads >= MAX_PARCEL_READS) {
        byDiagnosis[c.diagnosisNumber] = null;
        continue;
      }
      try {
        reads += 1;
        const p = await this.services.cadastre.parcelAt(d.lat, d.lon);
        byDiagnosis[c.diagnosisNumber] = p ? { id: p.id, areaM2: p.area } : null;
      } catch {
        cadastreDown = true;
        byDiagnosis[c.diagnosisNumber] = null;
      }
    }
    if (!this.services.cadastre) missing.push({ source: CADASTRE_SOURCE, reason: 'cadastre non branché' });
    else if (cadastreDown) missing.push({ source: CADASTRE_SOURCE, reason: 'cadastre injoignable' });
    else if (first.length > MAX_PARCEL_READS) missing.push({ source: CADASTRE_SOURCE, reason: `plus de ${MAX_PARCEL_READS} adresses possibles : le cadastre n’a été lu que pour les premières` });
    return { candidates: proposeAddresses(facts, diagnoses, { byDiagnosis, readOn: today }), missing };
  }

  /**
   * Crée la fiche du bien d'une annonce de la file, sans ressaisie : tous les champs de l'annonce, la source « pige », et
   * l'adresse retenue parmi celles proposées, avec sa confiance, ou aucune. Un bien fermé n'est jamais converti [R295].
   */
  async convert(viewer: Viewer, input: { adId: unknown; proposalId?: unknown; diagnosisNumber?: unknown }): Promise<{ ok: true; value: PigeProperty } | Refusal | Problem> {
    const g = await this.gate(viewer, `pige_ad:${String(input.adId)}`, true);
    if (g) return g;
    const ad = await this.current(viewer, input.adId);
    if ('ok' in ad) return ad;
    const linked = await this.pige.linkedOf(viewer.networkId, ad.fingerprint);
    if (!linked.complete) return { ok: false, rule: 'R273', code: 'bien_trop_relie' };
    // Un seul bien par bien de pige, même vu sur un autre site ou à 1 m² près.
    if (await this.db.first('SELECT 1 AS x FROM pige_property_keys WHERE network_id = ? AND key IN (SELECT value FROM json_each(?))', [viewer.networkId, JSON.stringify(linked.keys)])) {
      return { ok: false, rule: 'R295', code: 'deja_cree' };
    }
    let chosen: AddressCandidate | null = null;
    let proposalId: string | null = null;
    if (input.diagnosisNumber !== undefined && input.diagnosisNumber !== null) {
      if (typeof input.proposalId !== 'string' || typeof input.diagnosisNumber !== 'string') return { ok: false, rule: 'R294', code: 'adresse_inconnue' };
      const p = await this.db.first<{ id: string; candidates: string }>('SELECT id, candidates FROM pige_address_proposals WHERE id = ? AND network_id = ? AND ad_id IN (?, ?) AND agent_id = ?', [input.proposalId, viewer.networkId, ad.id, ad.askedId, viewer.userId]);
      const proposed = p ? (JSON.parse(p.candidates) as { diagnosisNumber: string }[]).some((c) => c.diagnosisNumber === input.diagnosisNumber) : false;
      // Seule une adresse proposée se retient, jamais une adresse tapée ; relue aux sources, avec sa confiance du moment.
      const found = proposed ? (await this.compute(viewer, ad)).candidates.find((c) => c.diagnosisNumber === input.diagnosisNumber) : undefined;
      if (!p || !found) return { ok: false, rule: 'R294', code: 'adresse_inconnue' };
      chosen = found;
      proposalId = p.id;
    }
    const priceEur = await this.pige.currentPrice(viewer.networkId, ad.fingerprint);
    if (priceEur === null) return { ok: false, rule: null, code: 'annonce_remplacee' };
    const energy = await this.energyOf(ad.id);
    const at = this.now().toISOString();
    const propertyId = this.newId();
    // La base lit le doute de la relève avant de la convertir : ses empreintes doivent y être [R672].
    await this.pige.fillDoubtKeys(viewer.networkId);
    let reference = this.newReference();
    for (let attempt = 1; ; attempt += 1) {
      try {
        await runBatch(this.db, [
          {
            sql: "INSERT INTO properties (id, network_id, agent_id, reference, kind, postal_code, city, surface_m2, rooms, price_eur, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'home', ?, ?, ?, ?, ?, 'draft', ?, ?)",
            params: [propertyId, viewer.networkId, viewer.userId, reference, ad.postal_code, ad.commune, ad.surface_m2, ad.rooms, priceEur, at, at],
          },
          {
            sql: `INSERT INTO pige_properties (property_id, network_id, source, ad_id, fingerprint, ad_site, ad_kind, energy_class, diagnosed_on, published_at, proposal_id, diagnosis_number, street_number, street, confidence, agent_id, created_at)
                  VALUES (?, ?, 'pige', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            params: [
              propertyId, viewer.networkId, ad.id, ad.fingerprint, ad.source, ad.kind, energy?.energy_class ?? null, energy?.diagnosed_on ?? null, ad.published_at, proposalId,
              chosen?.diagnosisNumber ?? null, chosen?.streetNumber ?? null, chosen?.street ?? null, chosen?.confidence ?? null, viewer.userId, at,
            ],
          },
          // Chaque clé reliée : un seul bien par bien de pige, et aucune clé fermée, vérifié par la base [R295, R273].
          ...[...new Set([ad.fingerprint, ...linked.keys])].map((key) => ({ sql: 'INSERT INTO pige_property_keys (network_id, key, property_id) VALUES (?, ?, ?)', params: [viewer.networkId, key, propertyId] })),
        ]);
        break;
      } catch (error) {
        const msg = String(error);
        if (/relève remplacée/.test(msg)) return { ok: false, rule: null, code: 'annonce_remplacee' };
        if (/bien fermé/.test(msg)) return (await this.closed(viewer.networkId, ad.fingerprint)) ?? { ok: false, rule: 'R273', code: 'pas_agence' };
        if (/UNIQUE/i.test(msg) && /pige_propert/.test(msg)) return { ok: false, rule: 'R295', code: 'deja_cree' };
        if (!/UNIQUE/i.test(msg) || attempt >= 3) throw error;
        reference = this.newReference();
      }
    }
    await appendEvent(this.journal, { type: 'bien.cree', actor: this.actor(viewer), subject: `property:${propertyId}`, data: { rule: 'R295', kind: 'home', source: 'pige', ad: ad.id, confidence: chosen?.confidence ?? null } }, this.now);
    return {
      ok: true,
      value: {
        propertyId,
        reference,
        kind: 'home',
        adKind: ad.kind,
        postalCode: ad.postal_code,
        city: ad.commune,
        surfaceM2: ad.surface_m2,
        rooms: ad.rooms,
        priceEur,
        energyClass: energy?.energy_class ?? null,
        diagnosedOn: energy?.diagnosed_on ?? null,
        source: 'pige',
        adSite: ad.source,
        publishedAt: ad.published_at,
        address: chosen ? { streetNumber: chosen.streetNumber, street: chosen.street, confidence: chosen.confidence, level: chosen.level, diagnosisNumber: chosen.diagnosisNumber } : null,
      },
    };
  }

  private async closed(networkId: string, fingerprint: string): Promise<Problem | null> {
    const c = await this.pige.closure(networkId, fingerprint);
    return c ? asProblem(c) : null;
  }

  /**
   * Ce que la pige rapporte : les biens créés depuis la pige et les mandats signés sur eux (G03), par niveau de confiance
   * de l'adresse retenue. L'agent voit les siens, la direction tout le réseau. Des nombres seulement [R296].
   */
  async yieldOf(viewer: Viewer): Promise<{ ok: true; value: PigeYield } | Refusal> {
    const g = await this.gate(viewer, `network:${viewer.networkId}`, false);
    if (g) return g;
    const mine = viewer.role === 'agent';
    const rows = await this.db.all<{ confidence: number | null; mandates: number }>(
      `SELECT p.confidence,
              (SELECT count(*) FROM mandates m WHERE m.network_id = p.network_id AND m.property_id = p.property_id AND m.signed_at >= p.created_at) AS mandates
         FROM pige_properties p WHERE p.network_id = ? ${mine ? 'AND p.agent_id = ?' : ''}`,
      mine ? [viewer.networkId, viewer.userId] : [viewer.networkId],
    );
    const order: (ConfidenceLevel | 'sans_adresse')[] = [...CONFIDENCE_LEVELS, 'sans_adresse'];
    const out = order.map((level) => {
      const of = rows.filter((r) => (r.confidence === null ? 'sans_adresse' : levelOf(r.confidence)) === level);
      // Un bien compte au plus un mandat : la pige a rapporté ce bien, ou non.
      return { level, properties: of.length, mandates: of.filter((r) => r.mandates > 0).length };
    });
    const properties = rows.length;
    const mandates = out.reduce((n, r) => n + r.mandates, 0);
    await appendEvent(this.journal, { type: 'pige.rapport_lu', actor: this.actor(viewer), subject: `network:${viewer.networkId}`, data: { rule: 'R296', properties, mandates } }, this.now);
    return { ok: true, value: { rows: out, properties, mandates, rate: properties === 0 ? null : Math.round((mandates / properties) * 1000) / 1000 } };
  }

  /** La fiche d'un bien créé depuis la pige, pour l'agent du bien ou la direction : la source reste « pige ». */
  async sourceOf(viewer: Viewer, propertyId: unknown): Promise<{ ok: true; source: 'pige'; adSite: string; confidence: number | null } | Refusal | Problem> {
    const g = await this.gate(viewer, `property:${String(propertyId)}`, false);
    if (g) return g;
    if (typeof propertyId !== 'string') return { ok: false, rule: null, code: 'inconnu' };
    const r = await this.db.first<{ source: 'pige'; ad_site: string; confidence: number | null; agent_id: string }>('SELECT source, ad_site, confidence, agent_id FROM pige_properties WHERE property_id = ? AND network_id = ?', [propertyId, viewer.networkId]);
    if (!r) return { ok: false, rule: null, code: 'inconnu' };
    if (viewer.role === 'agent' && r.agent_id !== viewer.userId) return this.refuse(viewer, `property:${propertyId}`, 'pas_son_bien');
    return { ok: true, source: r.source, adSite: r.ad_site, confidence: r.confidence };
  }
}
