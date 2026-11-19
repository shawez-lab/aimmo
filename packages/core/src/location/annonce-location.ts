/**
 * Annonce de location conforme (M15, W03) [R100, R101, R102, R103, R06].
 *
 * Le texte de l'annonce est proposé par l'IA, derrière une interface, à partir des seuls faits du logement : ni nom, ni
 * adresse, ni montant [R15]. Il passe le contrôle de l'annonce sourcée de M07 (P03) : chaque nombre et chaque fait relié
 * à la fiche, aucune voie nommée, aucun critère discriminant, aucun mot interdit [R46, R47] ; plus une liste écrite propre
 * à la location (« CDI exigé », « garant en France », métier, revenus…) [R103]. Un texte de l'IA absent, trop lent ou
 * refusé laisse la place au secours fait par le code, qui passe toujours le contrôle. L'agent peut écrire son propre
 * texte, contrôlé de la même façon.
 *
 * Les mentions obligatoires sont calculées par le code, jamais par l'IA, et ajoutées au texte : vide ou meublé, loyer
 * charges comprises et charges avec leur mode (provision régularisée ou forfait), honoraires du locataire dont l'état des lieux, dépôt de garantie, surface habitable,
 * commune, classes énergie et climat, consommation excessive pour F et G, dépenses annuelles d'énergie estimées par le diagnostic.
 *
 * Une annonce n'existe que pour un logement passé au contrôle de W01 et sous un barème en vigueur de W02 ; elle n'est
 * publiable qu'une fois validée par l'agent du logement, et tant que les faits, le barème et la fiche qu'elle a vus sont
 * encore ceux du logement. Rien ne s'efface : une correction est une nouvelle version [R17]. Aucune mention de l'IA
 * dans ce que lit le public [R06].
 *
 * Décidé, lecture prudente : sans dépenses d'énergie estimées dans la fiche du bien (P01), ou avec une classe énergie de
 * la fiche différente de celle de la mise en location, aucune annonce n'est faite. Dans une commune à loyer encadré
 * (AU015), l'annonce porte la zone, le loyer de référence majoré, le loyer de base et le complément de loyer s'il y en a.
 */
import type { Viewer } from '../acces/droits.ts';
import type { PropertyKind } from '../db/types.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { fallbackListing, traceListing, type ListingFacts, type SentenceProblem } from '../annonces/annonce-sourcee.ts';
import { energyPriceText, type PropertySheet } from '../annonces/fiche-bien.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import type { HonorairesLocation, RentalFees } from './honoraires.ts';
import { rentCeilingCents, type LocationRefusal, type MisesEnLocation, type RentalFacts } from './logement.ts';

const MAX_TITLE = 120;
const MAX_BODY = 3000;
const AI_TIMEOUT_MS = 20_000;

/** Ce que l'IA reçoit : les faits de la fiche et le type de location, rien d'autre [R15]. */
export interface RentalAdFacts extends ListingFacts {
  furnished: boolean;
}

export interface RentalAdWriter {
  write(facts: RentalAdFacts): Promise<{ title: string; body: string }>;
}

/** Critères propres à la location, refusés dans l'annonce : liste écrite, volontairement large [R103]. */
export const RENTAL_DISCRIMINATORY_TERMS: readonly string[] = [
  'cdi', 'cdi exigé', 'fonctionnaire', 'fonctionnaires', 'garant français', 'garante française', 'garant en france', 'caution en france', 'caution française',
  'étudiant', 'étudiante', 'étudiants', 'étudiantes', 'salarié', 'salariée', 'salariés', 'profession', 'professionnel uniquement', 'revenu', 'revenus', 'salaire',
  'salaires', 'fiche de paie', 'fiches de paie', 'bulletin de salaire', 'trois fois le loyer', '3 fois le loyer', 'non-fumeur', 'non fumeur', 'sans animaux',
  'pas d’animaux', "pas d'animaux", 'visale refusé', 'pas de visale', 'apl refusées', 'pas d’apl', "pas d'apl", 'caf', 'aides au logement',
  'santé', 'bonne santé', 'malade', 'maladie', 'personne valide', 'valide uniquement', 'invalide', 'marié', 'mariée', 'mariés', 'mariage', 'pacsé', 'pacsée',
  'personne seule', 'seul', 'seule', 'chômeur', 'chômeuse', 'chômage', 'demandeur d’emploi', "demandeur d'emploi", 'rsa', 'allocataire', 'allocataires', 'monsieur',
  'madame', 'mademoiselle', 'locataire sérieux', 'locataire sérieuse', 'bonne moralité', 'résident', 'résidente', 'nationaux',
];

/** Des tournures, et non des mots : un garant ou une caution liés à la France, dans un sens ou dans l'autre [R103]. */
const RENTAL_DISCRIMINATORY_PATTERNS: readonly RegExp[] = [
  /(?<![\p{L}])(?:garants?|garantes?|cautions?|cautionnaires?|garanties?)(?![\p{L}])[^.!?\n]*(?<![\p{L}])(?:france|francais|francaise|metropole|ue|union europeenne|europe)(?![\p{L}])/u,
  /(?<![\p{L}])(?:france|francais|francaise|metropole)(?![\p{L}])[^.!?\n]*(?<![\p{L}])(?:garants?|garantes?|cautions?)(?![\p{L}])/u,
];

const norm = (s: string): string =>
  s
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[’`]/g, "'")
    // Les sigles à points ou à tirets se lisent d'un bloc : « C.D.I. » et « C-D-I » sont « cdi ».
    .replace(/(?<![\p{L}])\p{L}(?:[.-]\p{L})+\.?(?![\p{L}])/gu, (m) => m.replace(/[.-]/g, ''))
    .replace(/\s+/g, ' ');
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Les critères propres à la location trouvés dans un texte, tels qu'ils sont lus [R103]. */
export function rentalCriteria(text: string): string[] {
  const lower = norm(text);
  const found: string[] = [];
  for (const term of RENTAL_DISCRIMINATORY_TERMS) {
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(norm(term))}(?:e|s|es|x)?(?![\\p{L}\\p{N}])`, 'iu');
    const m = re.exec(lower);
    if (m && !found.includes(m[0])) found.push(m[0]);
  }
  for (const re of RENTAL_DISCRIMINATORY_PATTERNS) {
    const m = re.exec(lower);
    if (m && !found.includes(m[0])) found.push(m[0]);
  }
  return found;
}

export type AdProblem = SentenceProblem | { code: 'critere_location'; value: string } | { code: 'fait_sans_source'; value: string };

/** Ce que le texte dit du type de location doit être ce que disent les faits : vide ou meublé [R47]. */
export function furnishedClaims(text: string, furnished: boolean): string[] {
  const lower = norm(text);
  const out: string[] = [];
  const unfurnished = /(?<![\p{L}])(?:non[- ]?meubl(?:e|ee|es|ees)|location (?:vide|nue)|(?:logement|appartement|maison|studio|bien) (?:vide|nu|nue))(?![\p{L}])/u.exec(lower);
  const furnishedWord = /(?<![\p{L}])(?<!non[- ]?)meubl(?:e|ee|es|ees)(?![\p{L}])|(?<![\p{L}])(?:entierement equipe|tout equipe|equipe et meuble)(?![\p{L}])/u.exec(lower);
  if (!furnished && furnishedWord) out.push(furnishedWord[0]);
  if (furnished && unfurnished) out.push(unfurnished[0]);
  return out;
}

/** Le contrôle complet d'un texte d'annonce de location : M07, puis la liste propre à la location. */
export function checkRentalAd(title: string, body: string, facts: RentalAdFacts): { ok: boolean; problems: AdProblem[] } {
  const trace = traceListing(title, body, facts);
  const problems: AdProblem[] = trace.sentences.flatMap((s) => s.problems);
  for (const value of rentalCriteria(`${title}\n${body}`)) problems.push({ code: 'critere_location', value });
  for (const value of furnishedClaims(`${title}\n${body}`, facts.furnished)) problems.push({ code: 'fait_sans_source', value });
  return { ok: trace.ok && problems.length === 0, problems };
}

/** Un montant en centimes, en euros à la française : « 650 », « 127,50 ». */
export function euros(cents: number): string {
  const e = Math.floor(cents / 100);
  const c = cents % 100;
  return c === 0 ? String(e) : `${e},${String(c).padStart(2, '0')}`;
}

const surface = (hundredths: number): string => euros(hundredths);

export interface EnergyCost {
  climateClass: string;
  annualCostMinEur: number;
  annualCostMaxEur: number;
  costReferenceYear: number;
  costReferenceYears?: number[];
}

/** Les mentions obligatoires, écrites par le code depuis les données contrôlées : rien d'autre [R102, R103]. */
export function rentalMentions(
  facts: RentalFacts,
  fees: Pick<RentalFees, 'tenantCents' | 'tenantInventoryCents' | 'depositCents'>,
  city: string,
  energy: EnergyCost,
  rentControlled = false,
): string {
  const lines = [
    `Location ${facts.furnished ? 'meublée' : 'vide'}.`,
    `Loyer : ${euros(facts.rentCents + facts.chargesCents)} € par mois charges comprises, dont ${euros(facts.chargesCents)} € de charges ${facts.chargesMode === 'forfait' ? 'forfaitaires' : 'en provision, avec régularisation annuelle'}.`,
    // Encadrement des loyers : les trois montants, dans les mots de l'arrêté du 21 avril 2022 (AU015).
    ...(rentControlled && facts.rentControl ? rentControlMentions(facts) : []),
    `Honoraires à la charge du locataire : ${euros(fees.tenantCents + fees.tenantInventoryCents)} € TTC, dont ${euros(fees.tenantInventoryCents)} € pour l'état des lieux.`,
    `Dépôt de garantie : ${euros(fees.depositCents)} €.`,
    `Surface habitable : ${surface(facts.livingAreaHundredths)} m².`,
    `Commune : ${city}.`,
    `Classe énergie ${facts.energyClass}, classe climat ${energy.climateClass}.`,
  ];
  if (facts.energyClass === 'F' || facts.energyClass === 'G') lines.push('Logement à consommation énergétique excessive.');
  lines.push(
    `Montant estimé des dépenses annuelles d'énergie pour un usage standard : entre ${energy.annualCostMinEur} € et ${energy.annualCostMaxEur} € par an. ${energyPriceText(energy)}`,
  );
  return lines.join('\n');
}

/** Les mentions d'une commune à loyer encadré : la zone, le loyer de référence majoré, le loyer de base, le complément s'il y en a un. */
export function rentControlMentions(facts: RentalFacts): string[] {
  const rc = facts.rentControl!;
  return [
    'Zone soumise à encadrement des loyers.',
    `Loyer de référence majoré (loyer de base à ne pas dépasser) : ${euros(rentCeilingCents(rc, facts.livingAreaHundredths))} € par mois.`,
    `Loyer de base : ${euros(facts.rentCents - rc.complementCents)} € par mois.`,
    ...(rc.complementCents > 0 ? [`Complément de loyer : ${euros(rc.complementCents)} € par mois.`] : []),
  ];
}

export interface RentalAd {
  adId: string;
  listingId: string;
  version: number;
  title: string;
  body: string;
  mentions: string;
  origin: 'ia' | 'secours' | 'agent';
  validatedAt: string | null;
}

export type AdRefusal = Omit<LocationRefusal, 'rule'> & { rule: LocationRefusal['rule'] | 'R103'; problems?: AdProblem[] };
export type AdResult<T> = { ok: true; value: T } | AdRefusal;

export interface AnnoncesLocationOptions {
  now?: () => Date;
  newId?: () => string;
  writer?: RentalAdWriter | undefined;
  timeoutMs?: number;
}

interface Basis {
  networkId: string;
  propertyId: string;
  facts: RentalFacts & { version: number };
  fees: RentalFees;
  sheetVersion: number;
  adFacts: RentalAdFacts;
  mentions: string;
}

interface AdRow {
  id: string;
  listing_id: string;
  network_id: string;
  version: number;
  facts_version: number;
  fees_version: number;
  sheet_version: number;
  title: string;
  body: string;
  mentions: string;
  origin: 'ia' | 'secours' | 'agent';
  validated_at: string | null;
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const AD_SELECT =
  'SELECT a.id, a.listing_id, a.network_id, a.version, a.facts_version, a.fees_version, a.sheet_version, a.title, a.body, a.mentions, a.origin, v.validated_at FROM rental_ads a LEFT JOIN rental_ad_validations v ON v.ad_id = a.id';

const toAd = (r: AdRow): RentalAd => ({
  adId: r.id,
  listingId: r.listing_id,
  version: Number(r.version),
  title: r.title,
  body: r.body,
  mentions: r.mentions,
  origin: r.origin,
  validatedAt: r.validated_at,
});

export class AnnoncesLocation {
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly writer: RentalAdWriter | undefined;
  private readonly timeoutMs: number;

  constructor(
    private readonly db: SqlDatabase,
    private readonly listings: MisesEnLocation,
    private readonly fees: HonorairesLocation,
    private readonly journal: JournalStore,
    options: AnnoncesLocationOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => crypto.randomUUID());
    this.writer = options.writer;
    this.timeoutMs = options.timeoutMs ?? AI_TIMEOUT_MS;
  }

  private actor(viewer: Viewer): string {
    return `${String(viewer.role)}:${viewer.userId}`;
  }

  /** Ce que l'annonce peut dire, et la raison quand elle ne peut rien dire [R100, R101, R102]. */
  private async basis(networkId: string, listingId: string): Promise<Basis | AdRefusal> {
    if (!(await this.listings.advertisable(networkId, listingId))) return { ok: false, rule: 'R100', code: 'not_advertisable' };
    const fees = await this.fees.current(networkId, listingId);
    if (!fees) return { ok: false, rule: 'R102', code: 'no_fees' };
    const facts = (await this.listings.currentFacts(listingId))!;
    const row = await this.db.first<{ property_id: string }>('SELECT property_id FROM rental_listings WHERE id = ?', [listingId]);
    const p = await this.db.first<{ kind: PropertyKind; city: string | null; postal_code: string | null; rooms: number | null }>('SELECT kind, city, postal_code, rooms FROM properties WHERE id = ?', [row!.property_id]);
    if (!p?.city) return { ok: false, rule: null, code: 'missing_city' };
    const sheetRow = await this.db.first<{ version: number; data: string }>('SELECT version, data FROM property_sheets WHERE property_id = ? ORDER BY version DESC LIMIT 1', [row!.property_id]);
    const sheet = sheetRow ? (JSON.parse(sheetRow.data) as PropertySheet) : null;
    if (!sheet?.energy) return { ok: false, rule: null, code: 'missing_energy_cost' };
    if (sheet.energy.energyClass !== facts.energyClass) return { ok: false, rule: 'R100', code: 'energy_mismatch' };
    if (!facts.chargesMode) return { ok: false, rule: null, code: 'missing_charges_mode' };
    const c = sheet.characteristics;
    const adFacts: RentalAdFacts = {
      kind: p.kind,
      city: p.city,
      postalCode: p.postal_code,
      // La surface dite est la surface habitable de la mise en location, contrôlée en W01.
      surfaceM2: facts.livingAreaHundredths / 100,
      rooms: p.rooms === null ? null : Number(p.rooms),
      bedrooms: c?.bedrooms ?? null,
      floor: c?.floor ?? null,
      floorsTotal: c?.floorsTotal ?? null,
      buildYear: c?.buildYear ?? null,
      heating: c?.heating ?? null,
      outdoor: c?.outdoor ?? [],
      landM2: c?.landM2 ?? null,
      parkingSpaces: c?.parkingSpaces ?? null,
      elevator: c?.elevator ?? null,
      energyClass: facts.energyClass,
      climateClass: sheet.energy.climateClass,
      furnished: facts.furnished,
    };
    const controlled = await this.listings.rentControlledFor({ id: listingId, network_id: networkId }, facts.leaseStart);
    const mentions = rentalMentions(facts, fees, p.city, sheet.energy, controlled);
    return { networkId, propertyId: row!.property_id, facts, fees, sheetVersion: Number(sheetRow!.version), adFacts, mentions };
  }

  private async askWriter(facts: RentalAdFacts): Promise<{ title: string; body: string } | null> {
    if (!this.writer) return null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const out = await Promise.race([
        this.writer.write(structuredClone(facts)),
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), this.timeoutMs);
        }),
      ]);
      if (!out || typeof out.title !== 'string' || typeof out.body !== 'string') return null;
      const title = out.title.trim();
      const body = out.body.trim();
      if (title === '' || body === '' || title.length > MAX_TITLE || body.length > MAX_BODY) return null;
      return { title, body };
    } catch {
      return null;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async store(viewer: Viewer, listingId: string, b: Basis, text: { title: string; body: string }, origin: RentalAd['origin']): Promise<AdResult<RentalAd>> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const id = this.newId();
      try {
        await this.db.run(
          `INSERT INTO rental_ads (id, listing_id, network_id, version, facts_version, fees_version, sheet_version, title, body, mentions, origin, created_by, created_at)
           SELECT ?, ?, ?, COALESCE(MAX(version), 0) + 1, ?, ?, ?, ?, ?, ?, ?, ?, ? FROM rental_ads WHERE listing_id = ?`,
          [id, listingId, b.networkId, b.facts.version, b.fees.version, b.sheetVersion, text.title, text.body, b.mentions, origin, this.actor(viewer), this.now().toISOString(), listingId],
        );
      } catch (error) {
        if (/UNIQUE/i.test(String(error))) continue;
        throw error;
      }
      const row = (await this.db.first<AdRow>(`${AD_SELECT} WHERE a.id = ?`, [id]))!;
      await appendEvent(this.journal, { type: 'location.annonce', actor: this.actor(viewer), subject: `rental:${listingId}`, data: { rule: 'R103', version: Number(row.version), origin } }, this.now);
      return { ok: true, value: toAd(row) };
    }
    return { ok: false, rule: null, code: 'busy' };
  }

  /** Propose l'annonce : le texte de l'IA s'il passe le contrôle, sinon le secours ; les mentions du code [R103]. */
  async draft(viewer: Viewer, listingId: unknown): Promise<AdResult<RentalAd>> {
    const listing = await this.listings.listing(viewer, listingId, true);
    if ('ok' in listing) return listing;
    const b = await this.basis(listing.networkId, listing.id);
    if ('ok' in b) return b;
    const proposed = await this.askWriter(b.adFacts);
    if (proposed) {
      const checked = checkRentalAd(proposed.title, proposed.body, b.adFacts);
      if (checked.ok) return this.store(viewer, listing.id, b, proposed, 'ia');
      // Le texte refusé n'est jamais rangé : seuls les codes de ses problèmes vont au journal [R13].
      await appendEvent(this.journal, { type: 'location.annonce_ia_refusee', actor: 'system:location', subject: `rental:${listing.id}`, data: { rule: 'R103', problems: [...new Set(checked.problems.map((p) => p.code))] } }, this.now);
    }
    const fallback = fallbackListing(b.adFacts);
    return this.store(viewer, listing.id, b, fallback, 'secours');
  }

  /** Le texte de l'agent, contrôlé comme celui de l'IA ; refusé avec ses problèmes [R103]. */
  async write(viewer: Viewer, listingId: unknown, input: { title: unknown; body: unknown }): Promise<AdResult<RentalAd>> {
    const listing = await this.listings.listing(viewer, listingId, true);
    if ('ok' in listing) return listing;
    if (typeof input.title !== 'string' || typeof input.body !== 'string') return { ok: false, rule: null, code: 'invalid' };
    const title = input.title.trim();
    const body = input.body.trim();
    if (title === '' || body === '' || title.length > MAX_TITLE || body.length > MAX_BODY) return { ok: false, rule: null, code: 'invalid' };
    const b = await this.basis(listing.networkId, listing.id);
    if ('ok' in b) return b;
    const checked = checkRentalAd(title, body, b.adFacts);
    if (!checked.ok) {
      await appendEvent(this.journal, { type: 'location.annonce_refusee', actor: this.actor(viewer), subject: `rental:${listing.id}`, data: { rule: 'R103', problems: [...new Set(checked.problems.map((p) => p.code))] } }, this.now);
      return { ok: false, rule: 'R103', code: 'text_refused', problems: checked.problems };
    }
    return this.store(viewer, listing.id, b, { title, body }, 'agent');
  }

  /** L'annonce vaut-elle encore : dernière version, et les faits, le barème et la fiche qu'elle a vus sont les derniers. */
  private async stillValid(row: AdRow): Promise<AdRefusal | null> {
    const latest = await this.db.first<{ v: number }>('SELECT MAX(version) AS v FROM rental_ads WHERE listing_id = ?', [row.listing_id]);
    if (Number(latest?.v) !== Number(row.version)) return { ok: false, rule: null, code: 'superseded' };
    const b = await this.basis(row.network_id, row.listing_id);
    if ('ok' in b) return b;
    if (b.facts.version !== Number(row.facts_version) || b.fees.version !== Number(row.fees_version) || b.sheetVersion !== Number(row.sheet_version)) return { ok: false, rule: null, code: 'stale' };
    // Les mentions et le texte sont recontrôlés tels qu'ils seraient publiés.
    if (b.mentions !== row.mentions || !checkRentalAd(row.title, row.body, b.adFacts).ok) return { ok: false, rule: 'R103', code: 'stale' };
    return null;
  }

  /** L'agent du logement valide le texte exact ; rien n'est publiable sans cette validation. */
  async validate(viewer: Viewer, adId: unknown): Promise<AdResult<RentalAd>> {
    const row = typeof adId === 'string' ? await this.db.first<AdRow>(`${AD_SELECT} WHERE a.id = ? AND a.network_id = ?`, [adId, viewer.networkId]) : null;
    const listing = await this.listings.listing(viewer, row?.listing_id ?? `ad:${String(adId)}`, true);
    if ('ok' in listing) return listing;
    if (viewer.role !== 'agent') {
      await appendEvent(this.journal, { type: 'acces.refuse', actor: this.actor(viewer), subject: `rental:${listing.id}`, data: { rule: 'R16', role: String(viewer.role), kind: 'rental_ad', code: 'role' } }, this.now);
      return { ok: false, rule: 'R16', code: 'role' };
    }
    if (!row) return { ok: false, rule: null, code: 'unknown' };
    if (row.validated_at) return { ok: false, rule: null, code: 'already_validated' };
    const invalid = await this.stillValid(row);
    if (invalid) return invalid;
    const hash = await sha256(`${row.title}\n${row.body}\n${row.mentions}`);
    try {
      await this.db.run('INSERT INTO rental_ad_validations (ad_id, text_sha256, validated_by, validated_at) VALUES (?, ?, ?, ?)', [row.id, hash, this.actor(viewer), this.now().toISOString()]);
    } catch (error) {
      if (/UNIQUE|PRIMARY/i.test(String(error))) return { ok: false, rule: null, code: 'already_validated' };
      throw error;
    }
    await appendEvent(this.journal, { type: 'location.annonce_validee', actor: this.actor(viewer), subject: `rental:${row.listing_id}`, data: { version: Number(row.version) } }, this.now);
    return { ok: true, value: toAd((await this.db.first<AdRow>(`${AD_SELECT} WHERE a.id = ?`, [row.id]))!) };
  }

  /** Les versions de l'annonce, pour l'agent ; la lecture est au journal avant d'être rendue [R16]. */
  async list(viewer: Viewer, listingId: unknown): Promise<AdResult<RentalAd[]>> {
    const listing = await this.listings.listing(viewer, listingId, false);
    if ('ok' in listing) return listing;
    await appendEvent(this.journal, { type: 'location.lue', actor: this.actor(viewer), subject: `rental:${listing.id}`, data: { rule: 'R16', what: 'ads' } }, this.now);
    const rows = await this.db.all<AdRow>(`${AD_SELECT} WHERE a.listing_id = ? ORDER BY a.version`, [listing.id]);
    return { ok: true, value: rows.map(toAd) };
  }

  /**
   * Le texte publiable aujourd'hui : la dernière version, validée par l'agent, dont le texte exact n'a pas changé et dont
   * les faits, le barème et la fiche sont encore ceux du logement ; `null` sinon. Pour la diffusion de M07.
   */
  async publishable(networkId: string, listingId: string): Promise<{ title: string; body: string; mentions: string } | null> {
    const row = await this.db.first<AdRow>(`${AD_SELECT} WHERE a.listing_id = ? AND a.network_id = ? ORDER BY a.version DESC LIMIT 1`, [listingId, networkId]);
    if (!row?.validated_at) return null;
    const v = await this.db.first<{ text_sha256: string }>('SELECT text_sha256 FROM rental_ad_validations WHERE ad_id = ?', [row.id]);
    if (!v || v.text_sha256 !== (await sha256(`${row.title}\n${row.body}\n${row.mentions}`))) return null;
    if (await this.stillValid(row)) return null;
    return { title: row.title, body: row.body, mentions: row.mentions };
  }
}
