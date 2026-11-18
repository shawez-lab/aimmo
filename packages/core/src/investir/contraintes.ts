/**
 * Les contraintes d'un investissement (M17, Y04), signalées sur chaque calcul :
 * - énergie : la classe du diagnostic et la date d'interdiction de louer, par le code de M15 (`banDate`, seuil de
 *   450 kWh/m²/an d'énergie finale) [R100] ; un bien interdit à la location porte l'alerte « interdit à la location »
 *   avant toute note, alerte ou proposition à un investisseur qui veut louer [R124] ;
 * - copropriété : lue dans la fiche du bien de M07 (lots, charges, procédure en cours) ;
 * - règles de la commune (autorisation préalable de mise en location, déclaration de mise en location, encadrement
 *   des loyers, changement d'usage), rangées par la direction avec leur source et leur date, jamais écrites dans le
 *   code ; une règle sans source est refusée.
 *
 * `energyAlertGate` est la porte unique que la note (Y05), les alertes (Y06) et les routes (Y07) passent : sans
 * contraintes calculées, ou sans l'alerte en tête d'un texte pour un bien interdit, rien ne sort.
 */
import type { Viewer } from '../acces/droits.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import { FINAL_ENERGY_BAN_FROM, MAX_FINAL_ENERGY_KWH, banDate, territoryOf, type Territory } from '../location/logement.ts';
import type { RentalTarget } from './profil.ts';

export const ENERGY_CLASSES = ['A', 'B', 'C', 'D', 'E', 'F', 'G'] as const;
export type InvestEnergyClass = (typeof ENERGY_CLASSES)[number];

/** Les règles de commune qu'un investisseur doit connaître : une liste fermée. */
export const COMMUNE_RULE_KINDS = ['autorisation_prealable', 'declaration_mise_en_location', 'encadrement_loyers', 'changement_usage'] as const;
export type CommuneRuleKind = (typeof COMMUNE_RULE_KINDS)[number];

export const COMMUNE_RULE_LABELS: Record<CommuneRuleKind, string> = {
  autorisation_prealable: 'Autorisation préalable de mise en location (permis de louer)',
  declaration_mise_en_location: 'Déclaration de mise en location',
  encadrement_loyers: 'Encadrement des loyers',
  changement_usage: 'Changement d’usage soumis à autorisation',
};

/** L'alerte écrite en tête de tout texte sur un bien interdit à la location [R124]. */
export const RENTAL_BAN_ALERT = 'Interdit à la location';

export type EnergyStatus = 'interdit' | 'echeance' | 'aucune' | 'inconnue';

export interface EnergyConstraint {
  kind: 'energie';
  status: EnergyStatus;
  energyClass: InvestEnergyClass | null;
  finalEnergyKwh: number | null;
  /** La date à partir de laquelle la location est interdite, quand la loi en fixe une. */
  bannedFrom: string | null;
  text: string;
  source: string;
}

export interface CoownershipConstraint {
  kind: 'copropriete';
  lots: number;
  annualChargesEur: number;
  proceedings: boolean;
  text: string;
  source: string;
}

export interface CommuneConstraint {
  kind: 'commune';
  rule: CommuneRuleKind;
  inseeCode: string;
  effectiveFrom: string;
  text: string;
  source: string;
}

export type Constraint = EnergyConstraint | CoownershipConstraint | CommuneConstraint;

export interface ConstraintSet {
  constraints: Constraint[];
  /** L'alerte « interdit à la location » est due : l'investisseur veut louer (ou on ne sait pas) et le bien est interdit. */
  rentalBan: boolean;
  /** La classe ou la consommation manque : à vérifier avant toute proposition à qui veut louer. */
  energyUnknown: boolean;
  /** Les textes à mettre en tête, dans l'ordre. */
  alertsFirst: string[];
  computedAt: string;
}

const dayFr = (iso: string): string => {
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
};

/**
 * La contrainte d'énergie, par les seules règles écrites de M15 : une classe G (date passée) ou une consommation au-delà
 * de 450 kWh/m²/an rend le bien interdit ; F et E portent leur date à venir ; sans classe, « inconnue ».
 */
export function energyConstraint(energyClass: InvestEnergyClass | null, finalEnergyKwh: number | null, today: string, source: string, territory: Territory = 'metropole'): EnergyConstraint {
  const base = { kind: 'energie' as const, energyClass, finalEnergyKwh, source };
  // Le seuil de consommation passe avant tout : il interdit même quand la classe manque.
  // Le seuil des 450 kWh ne vaut qu'en métropole ; l'outre-mer a son propre calendrier par classe (AU098b).
  if (territory === 'metropole' && finalEnergyKwh !== null && finalEnergyKwh > MAX_FINAL_ENERGY_KWH && FINAL_ENERGY_BAN_FROM <= today) {
    return {
      ...base,
      status: 'interdit',
      bannedFrom: FINAL_ENERGY_BAN_FROM,
      text: `${RENTAL_BAN_ALERT} : consommation de ${finalEnergyKwh} kWh/m²/an, au-delà de ${MAX_FINAL_ENERGY_KWH} kWh/m²/an, interdite pour un bail depuis le ${dayFr(FINAL_ENERGY_BAN_FROM)}.`,
    };
  }
  if (energyClass === null) {
    return { ...base, status: 'inconnue', bannedFrom: null, text: 'Classe énergie inconnue : à vérifier avant toute proposition de location.' };
  }
  const ban = banDate(energyClass, territory);
  if (ban !== null && ban <= today) {
    return { ...base, status: 'interdit', bannedFrom: ban, text: `${RENTAL_BAN_ALERT} : classe énergie ${energyClass}, interdite à la location depuis le ${dayFr(ban)}.` };
  }
  if (ban !== null) {
    return { ...base, status: 'echeance', bannedFrom: ban, text: `Classe énergie ${energyClass} : interdite à la location à partir du ${dayFr(ban)}, sauf travaux qui la font changer de classe.` };
  }
  return { ...base, status: 'aucune', bannedFrom: null, text: `Classe énergie ${energyClass} : aucune date d’interdiction de louer.` };
}

export type GateResult = { ok: true } | { ok: false; rule: 'R124'; code: 'contraintes_absentes' | 'alerte_absente' | 'interdit_a_qui_veut_louer' };

/**
 * La porte de R124, passée par chaque chemin qui montre un bien à un investisseur : un texte d'un bien interdit à la
 * location, ou dont la classe est inconnue, commence par son alerte ; sans contraintes calculées, rien ne passe.
 */
export function energyAlertGate(set: ConstraintSet | null | undefined, text: string): GateResult {
  if (!set || !Array.isArray(set.alertsFirst)) return { ok: false, rule: 'R124', code: 'contraintes_absentes' };
  if (set.alertsFirst.length === 0) return { ok: true };
  const head = text.trimStart();
  let rest = head;
  for (const alert of set.alertsFirst) {
    if (!rest.startsWith(alert)) return { ok: false, rule: 'R124', code: 'alerte_absente' };
    rest = rest.slice(alert.length).trimStart();
  }
  return { ok: true };
}

export interface CommuneRule {
  id: string;
  inseeCode: string;
  rule: CommuneRuleKind;
  effectiveFrom: string;
  effectiveUntil: string | null;
  source: string;
  sourceDate: string;
  recordedBy: string;
  recordedAt: string;
}

interface CommuneRuleRow {
  id: string;
  network_id: string;
  insee_code: string;
  rule: CommuneRuleKind;
  effective_from: string;
  effective_until: string | null;
  source: string;
  source_date: string;
  recorded_by: string;
  recorded_at: string;
}

const INSEE = /^(?:\d{5}|2[AB]\d{3})$/;
const isDay = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));

export type RuleResult = { ok: true; value: CommuneRule } | { ok: false; rule: 'R16' | 'R124'; code: string };

export interface ContraintesOptions {
  now?: () => Date;
  newId?: () => string;
}

export interface ConstraintsInput {
  networkId: string;
  /** La fiche du bien de M07, quand le bien en a une : la classe et la copropriété en sont lues. */
  propertyId: string | null;
  inseeCode: string | null;
  /** La classe dite par l'agent quand la fiche ne la porte pas, avec sa source. */
  energyClass?: InvestEnergyClass | null;
  finalEnergyKwh?: number | null;
  energySource?: string;
  rentalTarget: RentalTarget | null;
}

/** Ce que les contraintes lisent dans la fiche du bien de M07. */
interface SheetData {
  energy?: { energyClass?: unknown } | null;
  coownership?: Record<string, unknown> | null;
}

export class Contraintes {
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(
    private readonly db: SqlDatabase,
    private readonly journal: JournalStore,
    options: ContraintesOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => crypto.randomUUID());
  }

  /** La direction range une règle de commune, avec sa source et sa date ; sans source, refusée. Rien ne s'efface. */
  async recordCommuneRule(
    viewer: Viewer,
    input: { inseeCode: unknown; rule: unknown; effectiveFrom: unknown; effectiveUntil?: unknown; source: unknown; sourceDate: unknown },
  ): Promise<RuleResult> {
    const actor = `${String(viewer.role)}:${viewer.userId}`;
    if (viewer.role !== 'direction') {
      await appendEvent(
        this.journal,
        { type: 'acces.refuse', actor, subject: `network:${viewer.networkId}`, data: { rule: 'R16', role: String(viewer.role), kind: 'commune_rule', code: 'role' } },
        this.now,
      );
      return { ok: false, rule: 'R16', code: 'role' };
    }
    const bad = async (code: string): Promise<RuleResult> => {
      await appendEvent(this.journal, { type: 'investir.regle.refuse', actor, subject: `network:${viewer.networkId}`, data: { rule: 'R124', code } }, this.now);
      return { ok: false, rule: 'R124', code };
    };
    if (typeof input.inseeCode !== 'string' || !INSEE.test(input.inseeCode)) return bad('insee');
    if (typeof input.rule !== 'string' || !(COMMUNE_RULE_KINDS as readonly string[]).includes(input.rule)) return bad('regle');
    if (typeof input.source !== 'string' || input.source.trim().length < 3 || input.source.length > 300) return bad('source');
    if (!isDay(input.sourceDate) || input.sourceDate > this.now().toISOString().slice(0, 10)) return bad('date_source');
    if (!isDay(input.effectiveFrom)) return bad('date');
    const until = input.effectiveUntil ?? null;
    if (until !== null && (!isDay(until) || until < input.effectiveFrom)) return bad('date');
    const value: CommuneRule = {
      id: this.newId(),
      inseeCode: input.inseeCode,
      rule: input.rule as CommuneRuleKind,
      effectiveFrom: input.effectiveFrom,
      effectiveUntil: until,
      source: input.source.trim(),
      sourceDate: input.sourceDate,
      recordedBy: actor,
      recordedAt: this.now().toISOString(),
    };
    await this.db.run(
      `INSERT INTO commune_rental_rules (id, network_id, insee_code, rule, effective_from, effective_until, source, source_date, recorded_by, recorded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [value.id, viewer.networkId, value.inseeCode, value.rule, value.effectiveFrom, value.effectiveUntil, value.source, value.sourceDate, actor, value.recordedAt],
    );
    await appendEvent(
      this.journal,
      { type: 'investir.regle', actor, subject: `network:${viewer.networkId}`, data: { id: value.id, insee: value.inseeCode, rule: value.rule } },
      this.now,
    );
    return { ok: true, value };
  }

  /**
   * Ce que l'écran lit d'une commune : ses règles en vigueur aujourd'hui, avec leur source, et si le lecteur peut en
   * ranger (la direction seule) (Y11) [R16]. Rien de rangé n'est pas une preuve qu'il n'y en a pas.
   */
  async communeRulesScreen(viewer: Viewer, inseeCode: unknown): Promise<{ ok: true; value: { canRecord: boolean; rules: Array<Pick<CommuneRule, 'rule' | 'effectiveFrom' | 'effectiveUntil' | 'source' | 'sourceDate'> & { label: string }> } } | { ok: false; rule: 'R124'; code: 'insee' }> {
    if (typeof inseeCode !== 'string' || !INSEE.test(inseeCode)) return { ok: false, rule: 'R124', code: 'insee' };
    const rules = await this.communeRules(viewer.networkId, inseeCode, this.now().toISOString().slice(0, 10));
    return {
      ok: true,
      value: {
        canRecord: viewer.role === 'direction',
        rules: rules.map((r) => ({ rule: r.rule, label: COMMUNE_RULE_LABELS[r.rule], effectiveFrom: r.effectiveFrom, effectiveUntil: r.effectiveUntil, source: r.source, sourceDate: r.sourceDate })),
      },
    };
  }

  /** Les règles de la commune en vigueur ce jour-là. */
  async communeRules(networkId: string, inseeCode: string, today: string): Promise<CommuneRule[]> {
    const rows = await this.db.all<CommuneRuleRow>(
      `SELECT * FROM commune_rental_rules WHERE network_id = ? AND insee_code = ? ORDER BY recorded_at DESC, id DESC`,
      [networkId, inseeCode],
    );
    // Par sorte, la règle rangée le plus récemment qui a déjà commencé décide : en vigueur, ou finie. Une règle rangée
    // pour plus tard (un renouvellement) ne cache jamais celle qui s'applique aujourd'hui.
    const seen = new Set<string>();
    const out: CommuneRule[] = [];
    for (const r of rows) {
      if (seen.has(r.rule) || r.effective_from > today) continue;
      seen.add(r.rule);
      if (r.effective_until !== null && r.effective_until < today) continue;
      out.push({
        id: r.id,
        inseeCode: r.insee_code,
        rule: r.rule,
        effectiveFrom: r.effective_from,
        effectiveUntil: r.effective_until,
        source: r.source,
        sourceDate: r.source_date,
        recordedBy: r.recorded_by,
        recordedAt: r.recorded_at,
      });
    }
    return out.sort((a, b) => COMMUNE_RULE_KINDS.indexOf(a.rule) - COMMUNE_RULE_KINDS.indexOf(b.rule));
  }

  /**
   * Toutes les contraintes d'un bien pour un investisseur. La classe vient de la fiche du bien (M07) ; à défaut, de
   * ce que l'agent a dit avec sa source ; sinon elle est « inconnue ». Un investisseur dont la location visée n'est
   * pas « aucune » (ou pas encore dite) reçoit l'alerte d'un bien interdit en tête.
   */
  async forProperty(input: ConstraintsInput): Promise<ConstraintSet> {
    const now = this.now();
    const today = now.toISOString().slice(0, 10);
    let sheet = null as SheetData | null;
    let sheetVersion: number | null = null;
    if (input.propertyId !== null) {
      const row = await this.db.first<{ data: string; version: number }>(
        'SELECT data, version FROM property_sheets WHERE property_id = ? AND network_id = ? ORDER BY version DESC LIMIT 1',
        [input.propertyId, input.networkId],
      );
      if (row) {
        try {
          sheet = JSON.parse(row.data) as SheetData;
          sheetVersion = row.version;
        } catch {
          sheet = null;
        }
      }
    }
    const sheetClass = sheet?.energy?.energyClass;
    const fromSheet = typeof sheetClass === 'string' && (ENERGY_CLASSES as readonly string[]).includes(sheetClass) ? (sheetClass as InvestEnergyClass) : null;
    const energyClass = fromSheet ?? input.energyClass ?? null;
    // Une consommation non entière est arrondie vers le haut : « au-delà de 450 » reste vrai pour 450,2. Une valeur
    // impossible n'est jamais ignorée en silence.
    const rawKwh = input.finalEnergyKwh ?? null;
    if (rawKwh !== null && (typeof rawKwh !== 'number' || !Number.isFinite(rawKwh) || rawKwh < 0 || rawKwh > 100_000)) {
      throw new Error('contraintes : consommation d’énergie impossible');
    }
    const kwh = rawKwh === null ? null : Math.ceil(rawKwh);
    const energySource =
      fromSheet !== null ? `fiche du bien ${input.propertyId}, version ${sheetVersion}` : energyClass !== null ? (input.energySource ?? 'dit par l’agent') : 'aucune';
    const energy = energyConstraint(energyClass, kwh, today, energySource, territoryOf(input.inseeCode));
    const constraints: Constraint[] = [energy];

    const k = sheet?.coownership;
    if (k && k.isCoownership === true && typeof k.lots === 'number' && typeof k.annualChargesEur === 'number' && typeof k.proceedings === 'boolean') {
      constraints.push({
        kind: 'copropriete',
        lots: k.lots,
        annualChargesEur: k.annualChargesEur,
        proceedings: k.proceedings,
        text: `Copropriété de ${k.lots} lots, ${k.annualChargesEur} € de charges par an${k.proceedings ? ', procédure en cours' : ''}.`,
        source: `fiche du bien ${input.propertyId}, version ${sheetVersion}`,
      });
    }
    if (input.inseeCode !== null && INSEE.test(input.inseeCode)) {
      for (const r of await this.communeRules(input.networkId, input.inseeCode, today)) {
        constraints.push({
          kind: 'commune',
          rule: r.rule,
          inseeCode: r.inseeCode,
          effectiveFrom: r.effectiveFrom,
          text: `${COMMUNE_RULE_LABELS[r.rule]} dans la commune depuis le ${dayFr(r.effectiveFrom)}.`,
          source: `${r.source}, ${dayFr(r.sourceDate)}`,
        });
      }
    }
    const wantsToRent = input.rentalTarget !== 'none';
    const rentalBan = wantsToRent && energy.status === 'interdit';
    const energyUnknown = energy.status === 'inconnue';
    const alertsFirst: string[] = [];
    if (rentalBan) alertsFirst.push(energy.text);
    else if (wantsToRent && energyUnknown) alertsFirst.push(energy.text);
    return { constraints, rentalBan, energyUnknown, alertsFirst, computedAt: now.toISOString() };
  }
}
