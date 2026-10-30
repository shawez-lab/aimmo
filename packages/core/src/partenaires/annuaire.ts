/**
 * Annuaire des partenaires par zone, justificatifs datés (M18, U01) [R73].
 *
 * Un partenaire est un professionnel, rangé dans ses propres tables, jamais dans la fiche client. Son métier vient d'une
 * liste fermée (`PARTNER_TRADES`) ; les justificatifs qu'il doit fournir sont écrits par métier (`REQUIRED_CREDENTIALS`) :
 * l'assurance de responsabilité civile professionnelle pour tous, l'immatriculation ORIAS d'un courtier, la carte G d'un
 * gestionnaire, l'inscription à l'ordre d'un géomètre, d'un avocat ou d'un expert-comptable, et pour un diagnostiqueur
 * une certification par domaine. Chaque justificatif est une référence de stockage de sa preuve, jamais son contenu, avec
 * sa période de validité et qui l'a vérifié. Un justificatif rangé ne change plus : une nouvelle version s'ajoute, la
 * dernière compte [R17].
 *
 * Un partenaire n'est proposable, un jour donné, que si chacun de ses justificatifs exigés est valide ce jour-là ; un
 * diagnostiqueur ne l'est que pour les domaines couverts par une certification valide [R73]. Sinon la raison est dite à
 * l'agent. La recherche ne rend ni note, ni rang, ni avis : l'ordre est celui des identifiants, neutre ; le tirage au sort
 * montré au client vient avec la mise en relation (U02) [R14, R75].
 *
 * La direction et les agents actifs du réseau rangent un partenaire et ses justificatifs ; la conformité lit ; un
 * partenaire ne lit pas l'annuaire [R16]. Chaque ajout et chaque vérification est écrit au journal, sans nom ni numéro
 * [R13]. Rien n'est envoyé ici : les alertes d'échéance sont rendues au planificateur (U09), une seule fois.
 */
import type { Viewer } from '../acces/droits.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { localTime } from '../envoi/horaires.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';

const TIME_ZONE = 'Europe/Paris';
/** Jours avant l'échéance d'un justificatif où une alerte est rendue au planificateur. */
export const PARTNER_CREDENTIAL_ALERT_DAYS = 30;
/** Nombre de zones au plus par ajout. */
export const MAX_ZONES_PER_CALL = 50;

export const PARTNER_TRADES = [
  { trade: 'notaire', label: 'Notaire' },
  { trade: 'diagnostiqueur', label: 'Diagnostiqueur certifié' },
  { trade: 'courtier', label: 'Courtier en crédit' },
  { trade: 'artisan', label: 'Artisan' },
  { trade: 'demenageur', label: 'Déménageur' },
  { trade: 'photographe', label: 'Photographe' },
  { trade: 'geometre', label: 'Géomètre-expert' },
  { trade: 'gestionnaire', label: 'Gestionnaire titulaire de la carte G' },
  { trade: 'avocat', label: 'Avocat' },
  { trade: 'expert_comptable', label: 'Expert-comptable' },
  { trade: 'promoteur', label: 'Promoteur' },
  { trade: 'expert_viager', label: 'Expert du viager' },
] as const;
export type PartnerTrade = (typeof PARTNER_TRADES)[number]['trade'];

export const CREDENTIAL_KINDS = [
  { kind: 'assurance_rcp', label: 'Assurance de responsabilité civile professionnelle' },
  { kind: 'certification_diagnostic', label: 'Certification' },
  { kind: 'immatriculation_orias', label: 'Immatriculation ORIAS' },
  { kind: 'carte_g', label: 'Carte professionnelle G' },
  { kind: 'inscription_ordre', label: 'Inscription à l’ordre' },
] as const;
export type CredentialKind = (typeof CREDENTIAL_KINDS)[number]['kind'];

/** Domaines de diagnostic qui exigent une certification. */
export const CERTIFIED_DOMAINS = [
  { domain: 'amiante', label: 'amiante' },
  { domain: 'plomb', label: 'plomb' },
  { domain: 'dpe', label: 'performance énergétique' },
  { domain: 'electricite', label: 'électricité' },
  { domain: 'gaz', label: 'gaz' },
  { domain: 'termites', label: 'termites' },
] as const;
export type CertifiedDomain = (typeof CERTIFIED_DOMAINS)[number]['domain'];
/**
 * Domaines qu'on peut demander à un diagnostiqueur. Le mesurage de la surface n'exige aucune certification : l'assurance
 * suffit. Chacun des autres exige sa certification [R73].
 */
export type DiagnosticDomain = CertifiedDomain | 'mesurage';
export const DIAGNOSTIC_DOMAINS: readonly DiagnosticDomain[] = [...CERTIFIED_DOMAINS.map((d) => d.domain), 'mesurage'];

/** Les justificatifs exigés par métier, hors certifications de diagnostic (exigées par domaine). Règle écrite [R73]. */
export const REQUIRED_CREDENTIALS: Readonly<Record<PartnerTrade, readonly CredentialKind[]>> = Object.freeze({
  notaire: ['assurance_rcp'],
  diagnostiqueur: ['assurance_rcp'],
  courtier: ['assurance_rcp', 'immatriculation_orias'],
  artisan: ['assurance_rcp'],
  demenageur: ['assurance_rcp'],
  photographe: ['assurance_rcp'],
  geometre: ['assurance_rcp', 'inscription_ordre'],
  gestionnaire: ['assurance_rcp', 'carte_g'],
  avocat: ['assurance_rcp', 'inscription_ordre'],
  expert_comptable: ['assurance_rcp', 'inscription_ordre'],
  promoteur: ['assurance_rcp'],
  expert_viager: ['assurance_rcp'],
});

export interface PartnerProofStore {
  /** La référence existe dans le stockage. */
  has(ref: string): Promise<boolean>;
}

export type CredentialState = 'manquant' | 'a_venir' | 'echu' | 'valide';

export interface CredentialLine {
  kind: CredentialKind;
  /** Le domaine d'une certification de diagnostic, `null` sinon. */
  domain: CertifiedDomain | null;
  label: string;
  state: CredentialState;
  version: number | null;
  validFrom: string | null;
  validUntil: string | null;
}

export interface PartnerStatus {
  partnerId: string;
  trade: PartnerTrade;
  businessName: string;
  postcodes: string[];
  /** Tous les justificatifs exigés sont valides ce jour-là (pour un diagnostiqueur : son assurance ; ses domaines sont listés à part). */
  proposable: boolean;
  /** Domaines de diagnostic proposables ce jour-là (vide hors diagnostiqueur). */
  domains: DiagnosticDomain[];
  lines: CredentialLine[];
  /** Chaque justificatif exigé ou rangé qui n'est pas valide ce jour-là, en phrases pour l'agent. */
  reasons: string[];
}

export interface PartnerCard {
  partnerId: string;
  trade: PartnerTrade;
  businessName: string;
}

export interface PartnerSearch {
  day: string;
  proposable: PartnerCard[];
  unavailable: (PartnerCard & { reasons: string[] })[];
}

export type AnnuaireRefusal = { ok: false; rule: 'R16' | 'R73' | null; code: string };
export type AnnuaireResult<T> = { ok: true; value: T } | AnnuaireRefusal;

interface CredentialRow {
  id: string;
  kind: CredentialKind;
  domain: string;
  version: number;
  valid_from: string;
  valid_until: string;
}

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const REF_FILE = new RegExp(`^${UUID}\\.(?:pdf|jpg|png)$`);
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const POSTCODE = /^\d{5}$/;
const NUMBER = /^[A-Za-z0-9][A-Za-z0-9 ./-]{0,39}$/;
const validDay = (v: unknown): v is string => {
  if (typeof v !== 'string' || !DAY.test(v)) return false;
  const d = new Date(`${v}T12:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
};
const addDays = (day: string, n: number): string => new Date(Date.parse(`${day}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const frDate = (day: string): string => `${day.slice(8, 10)}/${day.slice(5, 7)}/${day.slice(0, 4)}`;
const isTrade = (v: unknown): v is PartnerTrade => typeof v === 'string' && PARTNER_TRADES.some((t) => t.trade === v);
const isKind = (v: unknown): v is CredentialKind => typeof v === 'string' && CREDENTIAL_KINDS.some((k) => k.kind === v);
const isCertified = (v: unknown): v is CertifiedDomain => typeof v === 'string' && CERTIFIED_DOMAINS.some((d) => d.domain === v);
const kindLabel = (kind: CredentialKind, domain: CertifiedDomain | null): string =>
  domain ? `Certification ${CERTIFIED_DOMAINS.find((d) => d.domain === domain)!.label}` : CREDENTIAL_KINDS.find((k) => k.kind === kind)!.label;

/**
 * La version qui fait foi un jour donné, parmi les versions d'un même justificatif (même sorte, même domaine) : celle
 * dont la période contient le jour, sauf si une version plus récente, déjà commencée ce jour-là, chevauche sa période,
 * c'est-à-dire la corrige. Ainsi une correction qui raccourcit une période l'emporte, un renouvellement rangé à l'avance
 * ne retire pas la version en cours avant son premier jour, et une version passée reste vraie pour sa propre période,
 * pour juger une pièce faite à cette date (U06) [R73, R17]. `null` : rien ne couvre ce jour.
 */
export function authoritativeOn<T extends { version: number; valid_from: string; valid_until: string }>(versions: readonly T[], day: string): T | null {
  const overlaps = (a: T, b: T): boolean => a.valid_from <= b.valid_until && b.valid_from <= a.valid_until;
  const covering = versions
    .filter((v) => v.valid_from <= day && day <= v.valid_until)
    .filter((v) => !versions.some((w) => Number(w.version) > Number(v.version) && w.valid_from <= day && overlaps(w, v)));
  return covering.sort((a, b) => Number(b.version) - Number(a.version))[0] ?? null;
}

/** Ce qu'on montre d'un justificatif ce jour-là : la version qui fait foi, sinon le renouvellement à venir, sinon l'échue. */
const shownOn = (versions: readonly CredentialRow[], day: string): { row: CredentialRow | undefined; state: CredentialState } => {
  const valid = authoritativeOn(versions, day);
  if (valid) return { row: valid, state: 'valide' };
  const next = versions.filter((v) => v.valid_from > day).sort((a, b) => (a.valid_from < b.valid_from ? -1 : a.valid_from > b.valid_from ? 1 : Number(b.version) - Number(a.version)))[0];
  if (next) return { row: next, state: 'a_venir' };
  // Une version corrigée par une plus récente qui la chevauche ne sert plus à dire la date d'échéance.
  const overlaps = (a: CredentialRow, b: CredentialRow): boolean => a.valid_from <= b.valid_until && b.valid_from <= a.valid_until;
  const current = versions.filter((v) => v.valid_from <= day && !versions.some((w) => Number(w.version) > Number(v.version) && w.valid_from <= day && overlaps(w, v)));
  const past = [...current].sort((a, b) => (a.valid_until > b.valid_until ? -1 : a.valid_until < b.valid_until ? 1 : Number(b.version) - Number(a.version)))[0];
  return past ? { row: past, state: 'echu' } : { row: undefined, state: 'manquant' };
};

const reasonOf = (line: CredentialLine): string | null => {
  if (line.state === 'manquant') return `${line.label} : manquante.`;
  if (line.state === 'echu') return `${line.label} : échue le ${frDate(line.validUntil!)}.`;
  if (line.state === 'a_venir') return `${line.label} : valable seulement à partir du ${frDate(line.validFrom!)}.`;
  return null;
};

export interface AnnuaireOptions {
  now?: () => Date;
  newId?: () => string;
}

export class Annuaire {
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(
    private readonly db: SqlDatabase,
    private readonly proofs: PartnerProofStore,
    private readonly journal: JournalStore,
    options: AnnuaireOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => crypto.randomUUID());
  }

  private actor(viewer: Viewer): string {
    return `${String(viewer.role)}:${viewer.userId}`;
  }

  private today(at: Date = this.now()): string {
    return localTime(at, TIME_ZONE).date;
  }

  private async refuse(viewer: Viewer, subject: string, code: string): Promise<AnnuaireRefusal> {
    await appendEvent(this.journal, { type: 'acces.refuse', actor: this.actor(viewer), subject, data: { rule: 'R16', role: String(viewer.role), kind: 'partner_directory', code } }, this.now);
    return { ok: false, rule: 'R16', code };
  }

  /** La direction et les agents actifs écrivent ; la conformité lit en plus ; tout autre rôle est refusé [R16]. */
  private async gate(viewer: Viewer, subject: string, write: boolean): Promise<AnnuaireRefusal | null> {
    if (viewer.role === 'direction') return null;
    if (viewer.role === 'compliance') return write ? this.refuse(viewer, subject, 'role') : null;
    if (viewer.role === 'agent') {
      const agent = await this.db.first<{ status: string }>('SELECT status FROM agents WHERE id = ? AND network_id = ?', [viewer.userId, viewer.networkId]);
      if (!agent) return this.refuse(viewer, subject, 'unknown');
      return agent.status === 'active' ? null : this.refuse(viewer, subject, 'agent_inactive');
    }
    return this.refuse(viewer, subject, 'role');
  }

  private async partnerIn(viewer: Viewer, partnerId: string): Promise<{ trade: PartnerTrade; business_name: string } | null> {
    if (typeof partnerId !== 'string') return null;
    return (await this.db.first<{ trade: PartnerTrade; business_name: string }>('SELECT trade, business_name FROM partners WHERE id = ? AND network_id = ?', [partnerId, viewer.networkId])) ?? null;
  }

  /** Range un partenaire, son métier et ses zones. Il n'est proposable qu'une fois ses justificatifs vérifiés [R73]. */
  async addPartner(viewer: Viewer, input: { trade: unknown; businessName: unknown; postcodes: unknown }): Promise<AnnuaireResult<PartnerStatus>> {
    const denied = await this.gate(viewer, 'partner:new', true);
    if (denied) return denied;
    if (!isTrade(input.trade)) return { ok: false, rule: null, code: 'unknown_trade' };
    const name = typeof input.businessName === 'string' ? input.businessName.trim().replace(/\s+/g, ' ') : '';
    if (name.length < 2 || name.length > 120) return { ok: false, rule: null, code: 'bad_name' };
    const postcodes = this.postcodes(input.postcodes);
    if (!postcodes) return { ok: false, rule: null, code: 'bad_postcodes' };
    const id = this.newId();
    const at = this.now().toISOString();
    await this.db.run('INSERT INTO partners (id, network_id, trade, business_name, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)', [id, viewer.networkId, input.trade, name, this.actor(viewer), at]);
    for (const p of postcodes) {
      await this.db.run('INSERT INTO partner_zones (partner_id, postcode, network_id, created_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING', [id, p, viewer.networkId, at]);
    }
    await appendEvent(this.journal, { type: 'partenaire.ajoute', actor: this.actor(viewer), subject: `partner:${id}`, data: { rule: 'R73', trade: input.trade, zones: postcodes.length } }, this.now);
    return { ok: true, value: await this.compute(id, this.now()) };
  }

  /** Ajoute des zones à un partenaire ; une zone déjà rangée ne compte pas deux fois, et aucune ne s'efface [R17]. */
  async addZones(viewer: Viewer, partnerId: string, postcodesInput: unknown): Promise<AnnuaireResult<PartnerStatus>> {
    const denied = await this.gate(viewer, `partner:${partnerId}`, true);
    if (denied) return denied;
    if (!(await this.partnerIn(viewer, partnerId))) return this.refuse(viewer, `partner:${partnerId}`, 'unknown');
    const postcodes = this.postcodes(postcodesInput);
    if (!postcodes) return { ok: false, rule: null, code: 'bad_postcodes' };
    const at = this.now().toISOString();
    let added = 0;
    for (const p of postcodes) {
      const { changes } = await this.db.run('INSERT INTO partner_zones (partner_id, postcode, network_id, created_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING', [partnerId, p, viewer.networkId, at]);
      added += changes;
    }
    if (added > 0) await appendEvent(this.journal, { type: 'partenaire.zones_ajoutees', actor: this.actor(viewer), subject: `partner:${partnerId}`, data: { zones: added } }, this.now);
    return { ok: true, value: await this.compute(partnerId, this.now()) };
  }

  private postcodes(input: unknown): string[] | null {
    if (!Array.isArray(input) || input.length === 0 || input.length > MAX_ZONES_PER_CALL) return null;
    const out = new Set<string>();
    for (const p of input) {
      if (typeof p !== 'string' || !POSTCODE.test(p.trim())) return null;
      out.add(p.trim());
    }
    return [...out].sort();
  }

  /**
   * Range un justificatif vérifié : sa sorte doit être exigée pour le métier du partenaire, sa preuve rangée au
   * stockage, sa période lisible. Celui qui le range en est le vérificateur, écrit au journal [R73, R13].
   */
  async addCredential(
    viewer: Viewer,
    partnerId: string,
    input: { kind: unknown; domain?: unknown; number: unknown; validFrom: unknown; validUntil: unknown; proofRef: unknown },
  ): Promise<AnnuaireResult<PartnerStatus>> {
    const denied = await this.gate(viewer, `partner:${partnerId}`, true);
    if (denied) return denied;
    const partner = await this.partnerIn(viewer, partnerId);
    if (!partner) return this.refuse(viewer, `partner:${partnerId}`, 'unknown');
    if (!isKind(input.kind)) return { ok: false, rule: null, code: 'unknown_kind' };
    const kind = input.kind;
    let domain: CertifiedDomain | null = null;
    if (kind === 'certification_diagnostic') {
      if (partner.trade !== 'diagnostiqueur') return { ok: false, rule: 'R73', code: 'kind_not_for_trade' };
      if (!isCertified(input.domain)) return { ok: false, rule: null, code: 'bad_domain' };
      domain = input.domain;
    } else {
      if (!REQUIRED_CREDENTIALS[partner.trade].includes(kind)) return { ok: false, rule: 'R73', code: 'kind_not_for_trade' };
      if (input.domain !== undefined && input.domain !== null && input.domain !== '') return { ok: false, rule: null, code: 'bad_domain' };
    }
    const number = typeof input.number === 'string' ? input.number.trim() : '';
    if (!NUMBER.test(number)) return { ok: false, rule: null, code: 'bad_number' };
    if (!validDay(input.validFrom) || !validDay(input.validUntil) || input.validUntil < input.validFrom) return { ok: false, rule: null, code: 'bad_dates' };
    const prefix = `partenaires/${partnerId}/`;
    if (typeof input.proofRef !== 'string' || !input.proofRef.startsWith(prefix) || !REF_FILE.test(input.proofRef.slice(prefix.length))) return { ok: false, rule: null, code: 'bad_ref' };
    if (await this.db.first('SELECT 1 FROM partner_credentials WHERE proof_ref = ?', [input.proofRef])) return { ok: false, rule: null, code: 'ref_used' };
    if (!(await this.proofs.has(input.proofRef))) return { ok: false, rule: null, code: 'not_stored' };
    const last = await this.db.first<{ v: number | null }>('SELECT MAX(version) AS v FROM partner_credentials WHERE partner_id = ? AND kind = ? AND domain = ?', [partnerId, kind, domain ?? '']);
    const version = Number(last?.v ?? 0) + 1;
    try {
      await this.db.run(
        'INSERT INTO partner_credentials (id, network_id, partner_id, kind, domain, version, number, valid_from, valid_until, proof_ref, verified_by, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [this.newId(), viewer.networkId, partnerId, kind, domain ?? '', version, number, input.validFrom, input.validUntil, input.proofRef, this.actor(viewer), this.now().toISOString()],
      );
    } catch (error) {
      if (/UNIQUE/i.test(String(error))) return { ok: false, rule: null, code: /proof_ref/.test(String(error)) ? 'ref_used' : 'busy' };
      throw error;
    }
    // Ni numéro ni nom au journal : la sorte, le domaine et la version suffisent à retrouver la vérification [R13].
    await appendEvent(this.journal, { type: 'partenaire.justificatif_verifie', actor: this.actor(viewer), subject: `partner:${partnerId}`, data: { rule: 'R73', kind, domain, version } }, this.now);
    return { ok: true, value: await this.compute(partnerId, this.now()) };
  }

  /** L'état d'un partenaire ce jour, pour qui peut lire l'annuaire [R16]. */
  async status(viewer: Viewer, partnerId: string): Promise<AnnuaireResult<PartnerStatus>> {
    const denied = await this.gate(viewer, `partner:${partnerId}`, false);
    if (denied) return denied;
    if (!(await this.partnerIn(viewer, partnerId))) return this.refuse(viewer, `partner:${partnerId}`, 'unknown');
    return { ok: true, value: await this.compute(partnerId, this.now()) };
  }

  /**
   * Les partenaires d'un métier dans une zone, ce jour : proposables d'un côté, indisponibles de l'autre avec leurs
   * raisons. Pour un diagnostiqueur, le domaine est demandé. Ni note, ni rang, ni avis : ordre des identifiants [R73, R14].
   */
  async search(viewer: Viewer, input: { trade: unknown; postcode: unknown; domain?: unknown }): Promise<AnnuaireResult<PartnerSearch>> {
    const denied = await this.gate(viewer, 'partner:search', false);
    if (denied) return denied;
    if (!isTrade(input.trade)) return { ok: false, rule: null, code: 'unknown_trade' };
    if (typeof input.postcode !== 'string' || !POSTCODE.test(input.postcode)) return { ok: false, rule: null, code: 'bad_postcode' };
    let domain: DiagnosticDomain | null = null;
    if (input.trade === 'diagnostiqueur') {
      if (typeof input.domain !== 'string' || !DIAGNOSTIC_DOMAINS.includes(input.domain as DiagnosticDomain)) return { ok: false, rule: null, code: 'domain_required' };
      domain = input.domain as DiagnosticDomain;
    } else if (input.domain !== undefined && input.domain !== null && input.domain !== '') return { ok: false, rule: null, code: 'bad_domain' };
    const at = this.now();
    const rows = await this.db.all<{ id: string }>(
      'SELECT p.id FROM partners p JOIN partner_zones z ON z.partner_id = p.id WHERE p.network_id = ? AND p.trade = ? AND z.postcode = ? ORDER BY p.id',
      [viewer.networkId, input.trade, input.postcode],
    );
    const proposable: PartnerCard[] = [];
    const unavailable: (PartnerCard & { reasons: string[] })[] = [];
    for (const { id } of rows) {
      const s = await this.compute(id, at);
      const card: PartnerCard = { partnerId: s.partnerId, trade: s.trade, businessName: s.businessName };
      if (domain === null) {
        if (s.proposable) proposable.push(card);
        else unavailable.push({ ...card, reasons: s.reasons });
        continue;
      }
      // Un diagnostiqueur : son assurance, plus la certification du domaine demandé, sauf pour le mesurage [R73].
      const base = s.lines.filter((l) => l.domain === null);
      const cert = domain === 'mesurage' ? [] : s.lines.filter((l) => l.domain === domain);
      const needed = domain === 'mesurage' ? base : [...base, ...(cert.length > 0 ? cert : [this.missingCert(domain)])];
      const reasons = needed.map(reasonOf).filter((r): r is string => r !== null);
      if (reasons.length === 0) proposable.push(card);
      else unavailable.push({ ...card, reasons });
    }
    return { ok: true, value: { day: this.today(at), proposable, unavailable } };
  }

  private missingCert(domain: CertifiedDomain): CredentialLine {
    return { kind: 'certification_diagnostic', domain, label: kindLabel('certification_diagnostic', domain), state: 'manquant', version: null, validFrom: null, validUntil: null };
  }

  /**
   * Un justificatif de ce partenaire couvrait-il ce jour ? La version qui faisait foi ce jour-là décide, même remplacée
   * depuis par un renouvellement ; une correction qui a raccourci sa période l'emporte (`authoritativeOn`). C'est ce qui
   * valait le jour où une pièce a été faite (U06) [R73].
   */
  async coveredOn(networkId: string, partnerId: string, kind: CredentialKind, domain: CertifiedDomain | null, day: string): Promise<boolean> {
    if (!validDay(day)) return false;
    const rows = await this.db.all<CredentialRow>('SELECT id, kind, domain, version, valid_from, valid_until FROM partner_credentials WHERE network_id = ? AND partner_id = ? AND kind = ? AND domain = ?', [
      networkId,
      partnerId,
      kind,
      domain ?? '',
    ]);
    return authoritativeOn(rows, day) !== null;
  }

  /** Le partenaire est-il proposable ce jour-là ? Lu par la mise en relation (U02) et l'espace partenaire (U04) [R73]. */
  async proposableOn(networkId: string, partnerId: string, at: Date, domain: DiagnosticDomain | null = null): Promise<boolean> {
    const p = await this.db.first<{ trade: PartnerTrade }>('SELECT trade FROM partners WHERE id = ? AND network_id = ?', [partnerId, networkId]);
    if (!p) return false;
    const s = await this.compute(partnerId, at);
    if (domain === null) return s.proposable;
    return p.trade === 'diagnostiqueur' && s.domains.includes(domain);
  }

  private async compute(partnerId: string, at: Date): Promise<PartnerStatus> {
    const p = (await this.db.first<{ trade: PartnerTrade; business_name: string }>('SELECT trade, business_name FROM partners WHERE id = ?', [partnerId]))!;
    const zones = await this.db.all<{ postcode: string }>('SELECT postcode FROM partner_zones WHERE partner_id = ? ORDER BY postcode', [partnerId]);
    const rows = await this.db.all<CredentialRow>('SELECT id, kind, domain, version, valid_from, valid_until FROM partner_credentials WHERE partner_id = ? ORDER BY kind, domain, version', [partnerId]);
    const day = this.today(at);
    // La version qui fait foi ce jour-là décide (`authoritativeOn`) [R73, R17].
    const line = (kind: CredentialKind, domain: CertifiedDomain | null): CredentialLine => {
      const { row, state } = shownOn(
        rows.filter((r) => r.kind === kind && r.domain === (domain ?? '')),
        day,
      );
      return { kind, domain, label: kindLabel(kind, domain), state, version: row ? Number(row.version) : null, validFrom: row?.valid_from ?? null, validUntil: row?.valid_until ?? null };
    };
    const lines: CredentialLine[] = REQUIRED_CREDENTIALS[p.trade].map((k) => line(k, null));
    let domains: DiagnosticDomain[] = [];
    const reasons = lines.map(reasonOf).filter((r): r is string => r !== null);
    const proposable = reasons.length === 0;
    if (p.trade === 'diagnostiqueur') {
      const certDomains = CERTIFIED_DOMAINS.map((d) => d.domain).filter((d) => rows.some((r) => r.kind === 'certification_diagnostic' && r.domain === d));
      const certLines = certDomains.map((d) => line('certification_diagnostic', d));
      lines.push(...certLines);
      const valid = certLines.filter((l) => l.state === 'valide').map((l) => l.domain!);
      // Sans assurance valide, un diagnostiqueur n'est proposable pour rien ; avec elle, pour le mesurage et ses domaines
      // certifiés ce jour-là.
      if (proposable) domains = [...valid, 'mesurage'];
      for (const l of certLines) {
        const r = reasonOf(l);
        if (r) reasons.push(r);
      }
    }
    return { partnerId, trade: p.trade, businessName: p.business_name, postcodes: zones.map((z) => z.postcode), proposable, domains, lines, reasons };
  }

  /**
   * Les justificatifs qui font foi aujourd'hui et arrivent à échéance dans les 30 jours, sans qu'aucune autre version
   * ne couvre le lendemain de leur échéance : une alerte par justificatif, une seule fois. Un renouvellement qui laisse
   * un trou garde donc l'alerte. Rendues au planificateur (U09), qui préviendra la direction ; rien n'est envoyé ici [R73].
   * Avec `notify`, chaque alerte est d'abord remise, puis seulement marquée : une remise qui échoue laisse l'alerte au
   * passage suivant, jamais perdue (U09).
   */
  async dueAlerts(
    networkId: string,
    notify?: (alert: { partnerId: string; kind: CredentialKind; domain: CertifiedDomain | null; validUntil: string }) => Promise<void>,
  ): Promise<{ partnerId: string; kind: CredentialKind; domain: CertifiedDomain | null; validUntil: string }[]> {
    const day = this.today();
    const limit = addDays(day, PARTNER_CREDENTIAL_ALERT_DAYS);
    const all = await this.db.all<CredentialRow & { partner_id: string }>(
      `SELECT c.id, c.partner_id, c.kind, c.domain, c.version, c.valid_from, c.valid_until FROM partner_credentials c
       WHERE c.network_id = ? AND c.partner_id IN (SELECT partner_id FROM partner_credentials WHERE network_id = ? AND valid_until >= ? AND valid_until <= ?)
       ORDER BY c.partner_id, c.kind, c.domain, c.version`,
      [networkId, networkId, day, limit],
    );
    const groups = new Map<string, (CredentialRow & { partner_id: string })[]>();
    for (const r of all) {
      const key = `${r.partner_id}|${r.kind}|${r.domain}`;
      groups.set(key, [...(groups.get(key) ?? []), r]);
    }
    const rows: (CredentialRow & { partner_id: string })[] = [];
    for (const versions of groups.values()) {
      const current = authoritativeOn(versions, day);
      if (!current || current.valid_until > limit) continue;
      if (authoritativeOn(versions, addDays(current.valid_until, 1))) continue;
      rows.push(current);
    }
    rows.sort((a, b) => (a.valid_until < b.valid_until ? -1 : a.valid_until > b.valid_until ? 1 : a.partner_id < b.partner_id ? -1 : 1));
    const out: { partnerId: string; kind: CredentialKind; domain: CertifiedDomain | null; validUntil: string }[] = [];
    for (const r of rows) {
      const alert = { partnerId: r.partner_id, kind: r.kind, domain: r.domain === '' ? null : (r.domain as CertifiedDomain), validUntil: r.valid_until };
      if (notify) {
        if (await this.db.first("SELECT 1 FROM partner_credential_alerts WHERE credential_id = ? AND alert = 'j30'", [r.id])) continue;
        await notify(alert);
      }
      const { changes } = await this.db.run("INSERT INTO partner_credential_alerts (credential_id, alert, network_id, created_at) VALUES (?, 'j30', ?, ?) ON CONFLICT DO NOTHING", [r.id, networkId, this.now().toISOString()]);
      if (changes === 1) out.push(alert);
    }
    return out;
  }
}
