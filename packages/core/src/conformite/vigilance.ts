/**
 * Vigilance renforcée et origine des fonds (M12, L04) [R10, R14, R16, R17, R93].
 *
 * Quatre règles écrites, en code, aux seuils réglés par le responsable de la conformité, examinent un dossier (une offre
 * du registre des offres, ou un mandat) et lèvent une alerte au responsable :
 * - « prix écarté de la valeur » : le prix de l'offre ou du mandat en vigueur sort de la fourchette du dernier avis de
 *   valeur validé du bien (M04) au-delà de l'écart réglé ;
 * - « montant inhabituel » : ce prix atteint le seuil réglé ;
 * - « personne politiquement exposée » et « paiement comptant » : déclarés sur la fiche de risque du client (L02).
 * Chaque alerte cite sa règle et ses chiffres, tous lus dans la base, jamais saisis ni tirés d'une IA [R10, R93]. Les
 * mêmes données et le même réglage donnent la même empreinte, donc la même alerte, jamais un doublon.
 *
 * L'alerte ne bloque ni ne refuse rien : aucun contrôle de mandat, d'offre ou de compromis ne lit ces tables, et la
 * décision reste au responsable, avec son nom et sa date [R14]. Seul le responsable voit les alertes ; l'agent du
 * dossier ne reçoit que la demande d'origine des fonds préparée pour lui quand le responsable a décidé de la faire, au
 * texte neutre et identique pour tous, qui ne dit ni l'alerte ni sa règle. Le journal range alertes et décisions sous
 * la référence de l'alerte, jamais sous la fiche du client, que la direction peut lire ; ni le client ni l'autre partie n'ont rien à lire ici. Rien n'est envoyé, rien ne
 * s'efface [R17].
 */
import type { Acces } from '../acces/acces.ts';
import type { Viewer } from '../acces/droits.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { mandateTerms } from '../documents/conditions.ts';
import { localTime } from '../envoi/horaires.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';

const TIME_ZONE = 'Europe/Paris';

export type VigilanceRuleKey = 'prix_ecarte_valeur' | 'montant_inhabituel' | 'personne_politiquement_exposee' | 'paiement_comptant';
export const VIGILANCE_RULES: readonly VigilanceRuleKey[] = ['prix_ecarte_valeur', 'montant_inhabituel', 'personne_politiquement_exposee', 'paiement_comptant'];

export type VigilanceDecisionKind = 'classee' | 'origine_des_fonds_demandee' | 'vigilance_maintenue';
export const VIGILANCE_DECISIONS: readonly VigilanceDecisionKind[] = ['classee', 'origine_des_fonds_demandee', 'vigilance_maintenue'];

export interface VigilanceSettings {
  version: string;
  trial: boolean;
  /** Écart toléré autour de la fourchette d'estimation, en pour cent entier. */
  priceGapPercent: number;
  /** Montant à partir duquel le prix est inhabituel, en euros. */
  amountThresholdEur: number;
  setOn: string;
  validatorName: string | null;
}

/** Le réglage d'essai, en attendant celui du responsable nommé (H29). Même seuil de montant que la grille de L02. */
export const VIGILANCE_SETTINGS_TRIAL: VigilanceSettings = Object.freeze({
  version: 'essai-2026-10-28',
  trial: true,
  priceGapPercent: 20,
  amountThresholdEur: 1_000_000,
  setOn: '2026-10-28',
  validatorName: null,
});

/** Ce que la base dit du dossier : rien d'autre n'entre dans le calcul. */
export interface VigilanceFacts {
  /** Le montant de l'offre au registre, ou le prix du mandat en vigueur ; `null` s'il n'y en a pas. */
  priceEur: number | null;
  /** La fourchette du dernier avis de valeur validé du bien, ou `null`. */
  valuation: { lowEur: number; highEur: number; validatedOn: string; ref: string } | null;
  /** Les déclarations de la dernière fiche de risque du client, ou `null`. */
  declared: { politicallyExposed: boolean; cashPayment: boolean; preparedOn: string; ref: string } | null;
}

export type VigilanceFigures = Record<string, string | number>;

export interface ComputedAlert {
  key: VigilanceRuleKey;
  rule: 'R93';
  label: string;
  figures: VigilanceFigures;
  /** La phrase de l'alerte : sa règle et ses chiffres, rien d'autre. */
  text: string;
}

const LABELS: Record<VigilanceRuleKey, string> = {
  prix_ecarte_valeur: 'Prix écarté de la valeur estimée',
  montant_inhabituel: 'Montant inhabituel',
  personne_politiquement_exposee: 'Personne politiquement exposée déclarée',
  paiement_comptant: 'Paiement comptant déclaré',
};

const fmtEur = (n: number): string => `${String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')} €`;

/** Le calcul des règles : pur, sans IA, sans horloge, sans hasard. Les mêmes faits donnent les mêmes alertes. */
export function computeVigilance(settings: VigilanceSettings, facts: VigilanceFacts): ComputedAlert[] {
  const alerts: Omit<ComputedAlert, 'text'>[] = [];
  const price = facts.priceEur;
  const v = facts.valuation;
  if (price !== null && v !== null) {
    const p = settings.priceGapPercent;
    // En entiers : prix × 100 comparé aux bornes × (100 ± écart).
    const below = price * 100 < v.lowEur * (100 - p);
    const above = price * 100 > v.highEur * (100 + p);
    if (below || above) {
      const gapPercent = above ? Math.floor(((price - v.highEur) * 100) / v.highEur) : Math.floor(((v.lowEur - price) * 100) / v.lowEur);
      const direction = above ? 'au-dessus' : 'au-dessous';
      alerts.push({
        key: 'prix_ecarte_valeur',
        rule: 'R93',
        label: LABELS.prix_ecarte_valeur,
        figures: { priceEur: price, lowEur: v.lowEur, highEur: v.highEur, valuation: v.ref, valuationOn: v.validatedOn, gapPercent, direction, thresholdPercent: p },
      });
    }
  }
  if (price !== null && price >= settings.amountThresholdEur) {
    alerts.push({
      key: 'montant_inhabituel',
      rule: 'R93',
      label: LABELS.montant_inhabituel,
      figures: { priceEur: price, thresholdEur: settings.amountThresholdEur },
    });
  }
  const d = facts.declared;
  if (d?.politicallyExposed) {
    alerts.push({
      key: 'personne_politiquement_exposee',
      rule: 'R93',
      label: LABELS.personne_politiquement_exposee,
      figures: { sheet: d.ref, preparedOn: d.preparedOn },
    });
  }
  if (d?.cashPayment) {
    alerts.push({
      key: 'paiement_comptant',
      rule: 'R93',
      label: LABELS.paiement_comptant,
      figures: { sheet: d.ref, preparedOn: d.preparedOn },
    });
  }
  return alerts.map((a) => ({ ...a, text: textOf(a.key, a.figures) }));
}

/**
 * La demande d'origine des fonds préparée pour l'agent : la même pour tous les dossiers, sans un mot sur l'alerte, sa
 * règle ou ses chiffres. Rien n'est envoyé : l'agent la remet lui-même.
 */
export const FUNDS_REQUEST_TEXT =
  'Pour compléter le dossier, merci de nous remettre un justificatif de l’origine des fonds : par exemple un relevé du compte d’où vient l’apport, un acte de vente, une offre de prêt ou un acte de donation.';
export const FUNDS_REQUEST_DOCUMENTS: readonly string[] = ['relevé du compte de l’apport', 'acte de vente d’un bien', 'offre de prêt', 'acte de donation ou de succession'];

export interface FundsRequest {
  caseRef: string;
  text: string;
  documents: readonly string[];
  sent: false;
}

export interface VigilanceDecision {
  decision: VigilanceDecisionKind;
  reason: string;
  validatorName: string;
  decidedOn: string;
}

export interface VigilanceAlert extends ComputedAlert {
  alertId: string;
  caseRef: string;
  personId: string;
  settingsVersion: string;
  fingerprint: string;
  raisedAt: string;
  decision: VigilanceDecision | null;
  notice: string;
}

export const VIGILANCE_NOTICE = 'L’alerte ne bloque ni ne refuse rien : la décision reste au responsable de la conformité.';

export type VigilanceRefusal = { ok: false; rule: 'R16' | 'R93' | null; code: string };

interface AlertRow {
  id: string;
  network_id: string;
  case_ref: string;
  person_id: string;
  rule_key: VigilanceRuleKey;
  settings_version: string;
  figures: string;
  fingerprint: string;
  raised_by: string;
  raised_at: string;
}

const OFFER_REF = /^offer:([A-Za-z0-9-]{8,64})$/;
const MANDATE_REF = /^mandate:([A-Za-z0-9-]{8,64})$/;

async function sha256Hex(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  return [...digest].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export interface VigilanceOptions {
  now?: () => Date;
  newId?: () => string;
}

export class VigilanceRenforcee {
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(
    private readonly db: SqlDatabase,
    private readonly acces: Acces,
    private readonly journal: JournalStore,
    options: VigilanceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => crypto.randomUUID());
  }

  private actor(viewer: Viewer): string {
    return `${String(viewer.role)}:${viewer.userId}`;
  }

  private async refuse(viewer: Viewer, subject: string, code: string): Promise<VigilanceRefusal> {
    await appendEvent(
      this.journal,
      { type: 'acces.refuse', actor: this.actor(viewer), subject, data: { rule: 'R93', role: String(viewer.role), kind: 'vigilance', code } },
      this.now,
    );
    return { ok: false, rule: 'R93', code };
  }

  /** Le réglage en vigueur du réseau : le dernier du responsable, sinon celui d'essai. */
  async currentSettings(networkId: string): Promise<VigilanceSettings> {
    const row = await this.db.first<{ version: number; price_gap_percent: number; amount_threshold_eur: number; validator_name: string; set_at: string }>(
      'SELECT version, price_gap_percent, amount_threshold_eur, validator_name, set_at FROM vigilance_settings WHERE network_id = ? ORDER BY version DESC LIMIT 1',
      [networkId],
    );
    if (!row) return VIGILANCE_SETTINGS_TRIAL;
    return {
      version: `reglage-${row.version}`,
      trial: false,
      priceGapPercent: row.price_gap_percent,
      amountThresholdEur: row.amount_threshold_eur,
      setOn: localTime(new Date(row.set_at), TIME_ZONE).date,
      validatorName: row.validator_name,
    };
  }

  /** Le responsable règle les seuils, avec son nom. Les alertes déjà levées gardent leur réglage. */
  async setSettings(
    viewer: Viewer,
    input: { priceGapPercent: unknown; amountThresholdEur: unknown; validatorName: unknown },
  ): Promise<{ ok: true; settings: VigilanceSettings } | VigilanceRefusal> {
    if (viewer.role !== 'compliance') return this.refuse(viewer, `network:${viewer.networkId}`, 'role');
    const gap = input.priceGapPercent;
    const amount = input.amountThresholdEur;
    if (typeof gap !== 'number' || !Number.isInteger(gap) || gap < 1 || gap > 100) return { ok: false, rule: null, code: 'bad_gap' };
    if (typeof amount !== 'number' || !Number.isInteger(amount) || amount <= 0) return { ok: false, rule: null, code: 'bad_amount' };
    if (typeof input.validatorName !== 'string' || input.validatorName.trim() === '' || input.validatorName.length > 120) return { ok: false, rule: null, code: 'missing_name' };
    const last = await this.db.first<{ version: number }>('SELECT MAX(version) AS version FROM vigilance_settings WHERE network_id = ?', [viewer.networkId]);
    const version = (last?.version ?? 0) + 1;
    await this.db.run(
      'INSERT INTO vigilance_settings (id, network_id, version, price_gap_percent, amount_threshold_eur, validator_name, set_by, set_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [this.newId(), viewer.networkId, version, gap, amount, input.validatorName.trim(), this.actor(viewer), this.now().toISOString()],
    );
    await appendEvent(
      this.journal,
      { type: 'vigilance.reglage', actor: this.actor(viewer), subject: `network:${viewer.networkId}`, data: { rule: 'R93', version, priceGapPercent: gap, amountThresholdEur: amount } },
      this.now,
    );
    return { ok: true, settings: await this.currentSettings(viewer.networkId) };
  }

  /** Le dossier cité : son client, son bien et son prix, lus dans la base. */
  private async loadCase(networkId: string, caseRef: string): Promise<{ personId: string; propertyId: string | null; priceEur: number | null } | null> {
    const offer = OFFER_REF.exec(caseRef);
    if (offer) {
      const row = await this.db.first<{ network_id: string; buyer_person_id: string; property_id: string; amount_eur: number }>(
        'SELECT network_id, buyer_person_id, property_id, amount_eur FROM offer_register WHERE id = ?',
        [offer[1]!],
      );
      if (!row || row.network_id !== networkId) return null;
      return { personId: row.buyer_person_id, propertyId: row.property_id, priceEur: row.amount_eur };
    }
    const mandate = MANDATE_REF.exec(caseRef);
    if (mandate) {
      const row = await this.db.first<{ network_id: string; person_id: string; property_id: string | null }>('SELECT network_id, person_id, property_id FROM mandates WHERE id = ?', [mandate[1]!]);
      if (!row || row.network_id !== networkId) return null;
      const terms = await mandateTerms(this.db, mandate[1]!);
      return { personId: row.person_id, propertyId: row.property_id, priceEur: terms?.priceEur ?? null };
    }
    return null;
  }

  private async facts(networkId: string, caseRef: string, memberIds: string[], propertyId: string | null, priceEur: number | null): Promise<VigilanceFacts> {
    let valuation: VigilanceFacts['valuation'] = null;
    if (propertyId !== null) {
      const r = await this.db.first<{ id: string; computed_low: number; computed_high: number; agent_low: number | null; agent_high: number | null; validated_at: string }>(
        `SELECT id, computed_low, computed_high, agent_low, agent_high, validated_at FROM valuation_reports
         WHERE network_id = ? AND property_id = ? AND status = 'validated' ORDER BY validated_at DESC, id DESC LIMIT 1`,
        [networkId, propertyId],
      );
      if (r) {
        // La fourchette validée est celle de l'agent quand il l'a changée, sinon celle du calcul.
        const agentRange = r.agent_low !== null && r.agent_high !== null;
        valuation = {
          lowEur: agentRange ? r.agent_low! : r.computed_low,
          highEur: agentRange ? r.agent_high! : r.computed_high,
          validatedOn: localTime(new Date(r.validated_at), TIME_ZONE).date,
          ref: `valuation:${r.id}`,
        };
      }
    }
    // La fiche de risque de ce dossier d'abord, sinon la plus récente du client.
    const sheet = await this.db.first<{ id: string; inputs: string; prepared_at: string }>(
      `SELECT id, inputs, prepared_at FROM risk_sheets WHERE network_id = ? AND person_id IN (${memberIds.map(() => '?').join(', ')})
       ORDER BY CASE WHEN case_ref = ? THEN 0 ELSE 1 END, prepared_at DESC, id DESC LIMIT 1`,
      [networkId, ...memberIds, caseRef],
    );
    let declared: VigilanceFacts['declared'] = null;
    if (sheet) {
      const inputs = JSON.parse(sheet.inputs) as { declarations?: { politicallyExposed?: unknown; cashPayment?: unknown } };
      declared = {
        politicallyExposed: inputs.declarations?.politicallyExposed === true,
        cashPayment: inputs.declarations?.cashPayment === true,
        preparedOn: localTime(new Date(sheet.prepared_at), TIME_ZONE).date,
        ref: `risk_sheet:${sheet.id}`,
      };
    }
    return { priceEur, valuation, declared };
  }

  /**
   * Examine un dossier (`offer:<id>` ou `mandate:<id>`) avec les règles et le réglage en vigueur, et range les alertes
   * nouvelles. L'agent du client (vue complète) ou le responsable ; tout autre est refusé, au journal. Le responsable
   * reçoit les alertes du dossier ; l'agent, seulement la demande d'origine des fonds décidée par le responsable.
   */
  async examine(
    viewer: Viewer,
    caseRef: unknown,
  ): Promise<{ ok: true; fundsRequest: FundsRequest | null; alerts?: VigilanceAlert[] } | VigilanceRefusal> {
    if (typeof caseRef !== 'string' || !(OFFER_REF.test(caseRef) || MANDATE_REF.test(caseRef))) return { ok: false, rule: null, code: 'bad_case' };
    if (viewer.role !== 'agent' && viewer.role !== 'compliance') return this.refuse(viewer, caseRef, 'role');
    const found = await this.loadCase(viewer.networkId, caseRef);
    if (!found) return { ok: false, rule: null, code: 'unknown_case' };
    const read = await this.acces.readFiche(viewer, found.personId);
    if (!read.ok) return { ok: false, rule: 'R16', code: read.code };
    if (read.view !== 'full') return this.refuse(viewer, caseRef, 'not_assigned');
    const memberIds = read.value.members.map((m) => m.id);

    const settings = await this.currentSettings(viewer.networkId);
    const facts = await this.facts(viewer.networkId, caseRef, memberIds, found.propertyId, found.priceEur);
    for (const alert of computeVigilance(settings, facts)) {
      const fingerprint = await sha256Hex(JSON.stringify([caseRef, alert.key, settings.version, alert.figures]));
      await this.db.run(
        `INSERT INTO vigilance_alerts (id, network_id, case_ref, person_id, rule_key, settings_version, figures, fingerprint, raised_by, raised_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (network_id, fingerprint) DO NOTHING`,
        [this.newId(), viewer.networkId, caseRef, found.personId, alert.key, settings.version, JSON.stringify(alert.figures), fingerprint, this.actor(viewer), this.now().toISOString()],
      );
    }
    const rows = await this.db.all<AlertRow>('SELECT * FROM vigilance_alerts WHERE network_id = ? AND case_ref = ? ORDER BY raised_at, rowid', [viewer.networkId, caseRef]);
    for (const row of rows) await this.ensureEvents(row);
    // La demande n'est préparée qu'une fois le responsable décidé à la faire : une alerte classée n'en donne aucune.
    const asked = await this.db.first(
      `SELECT d.alert_id FROM vigilance_decisions d JOIN vigilance_alerts a ON a.id = d.alert_id
       WHERE a.network_id = ? AND a.case_ref = ? AND d.decision = 'origine_des_fonds_demandee' LIMIT 1`,
      [viewer.networkId, caseRef],
    );
    const fundsRequest: FundsRequest | null = asked ? { caseRef, text: FUNDS_REQUEST_TEXT, documents: FUNDS_REQUEST_DOCUMENTS, sent: false } : null;
    if (viewer.role !== 'compliance') return { ok: true, fundsRequest };
    const alerts: VigilanceAlert[] = [];
    for (const row of rows) alerts.push(await this.toAlert(row));
    return { ok: true, fundsRequest, alerts };
  }

  /** Toutes les alertes du réseau, de la plus ancienne à la plus récente : pour le responsable seul. */
  async list(viewer: Viewer): Promise<{ ok: true; value: VigilanceAlert[] } | VigilanceRefusal> {
    if (viewer.role !== 'compliance') return this.refuse(viewer, `network:${viewer.networkId}`, 'role');
    const rows = await this.db.all<AlertRow>('SELECT * FROM vigilance_alerts WHERE network_id = ? ORDER BY raised_at, rowid', [viewer.networkId]);
    const out: VigilanceAlert[] = [];
    for (const row of rows) {
      await this.ensureEvents(row);
      out.push(await this.toAlert(row));
    }
    return { ok: true, value: out };
  }

  /** Le responsable décide, une seule fois par alerte, avec son nom, sa date et sa raison. */
  async decide(
    viewer: Viewer,
    alertId: string,
    input: { decision: unknown; reason: unknown; validatorName: unknown },
  ): Promise<{ ok: true; alert: VigilanceAlert } | VigilanceRefusal> {
    if (viewer.role !== 'compliance') return this.refuse(viewer, `vigilance_alert:${alertId}`, 'role');
    const row = await this.db.first<AlertRow>('SELECT * FROM vigilance_alerts WHERE id = ?', [alertId]);
    if (!row || row.network_id !== viewer.networkId) return this.refuse(viewer, `vigilance_alert:${alertId}`, 'unknown');
    if (typeof input.decision !== 'string' || !(VIGILANCE_DECISIONS as readonly string[]).includes(input.decision)) return { ok: false, rule: null, code: 'bad_decision' };
    if (typeof input.reason !== 'string' || input.reason.trim() === '' || input.reason.length > 1000) return { ok: false, rule: null, code: 'missing_reason' };
    if (typeof input.validatorName !== 'string' || input.validatorName.trim() === '' || input.validatorName.length > 120) return { ok: false, rule: null, code: 'missing_name' };
    await this.ensureRaisedEvent(row);
    if (await this.db.first('SELECT alert_id FROM vigilance_decisions WHERE alert_id = ?', [row.id])) return this.alreadyDecided(row);
    try {
      await this.db.run(
        'INSERT INTO vigilance_decisions (id, network_id, alert_id, decision, reason, validator_name, decided_by, decided_on, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [this.newId(), viewer.networkId, row.id, input.decision, input.reason.trim(), input.validatorName.trim(), this.actor(viewer), localTime(this.now(), TIME_ZONE).date, this.now().toISOString()],
      );
    } catch (error) {
      // Deux décisions en même temps : une seule passe.
      if (await this.db.first('SELECT alert_id FROM vigilance_decisions WHERE alert_id = ?', [row.id])) return this.alreadyDecided(row);
      throw error;
    }
    await this.ensureDecisionEvent(row);
    return { ok: true, alert: await this.toAlert(row) };
  }

  /** Une décision déjà rangée : son événement au journal est repris s'il manque, puis le refus. */
  private async alreadyDecided(row: AlertRow): Promise<VigilanceRefusal> {
    await this.ensureDecisionEvent(row);
    return { ok: false, rule: null, code: 'already_decided' };
  }

  private async ensureEvents(row: AlertRow): Promise<void> {
    await this.ensureRaisedEvent(row);
    await this.ensureDecisionEvent(row);
  }

  /** L'événement d'une décision, écrit une fois d'après la décision rangée ; repris s'il a manqué. */
  private async ensureDecisionEvent(row: AlertRow): Promise<void> {
    const d = await this.db.first<{ decision: VigilanceDecisionKind; decided_by: string }>('SELECT decision, decided_by FROM vigilance_decisions WHERE alert_id = ?', [row.id]);
    if (!d) return;
    const seen = await this.db.first(`SELECT seq FROM journal WHERE type = 'vigilance.decision' AND json_extract(data, '$.alert') = ? LIMIT 1`, [`vigilance_alert:${row.id}`]);
    if (seen) return;
    await appendEvent(
      this.journal,
      { type: 'vigilance.decision', actor: d.decided_by, subject: `vigilance_alert:${row.id}`, data: { rule: 'R93', alert: `vigilance_alert:${row.id}`, decision: d.decision } },
      this.now,
    );
  }

  /** L'événement d'une alerte levée, écrit une fois ; repris s'il a manqué (journal en panne après l'écriture). */
  private async ensureRaisedEvent(row: AlertRow): Promise<void> {
    const seen = await this.db.first(`SELECT seq FROM journal WHERE type = 'vigilance.alerte' AND json_extract(data, '$.alert') = ? LIMIT 1`, [`vigilance_alert:${row.id}`]);
    if (seen) return;
    await appendEvent(
      this.journal,
      { type: 'vigilance.alerte', actor: row.raised_by, subject: `vigilance_alert:${row.id}`, data: { rule: 'R93', alert: `vigilance_alert:${row.id}` } },
      this.now,
    );
  }

  private async toAlert(row: AlertRow): Promise<VigilanceAlert> {
    const figures = JSON.parse(row.figures) as VigilanceFigures;
    // La phrase est refaite par le même code depuis les chiffres rangés : rien n'est ressaisi.
    const text = textOf(row.rule_key, figures);
    const d = await this.db.first<{ decision: VigilanceDecisionKind; reason: string; validator_name: string; decided_on: string }>(
      'SELECT decision, reason, validator_name, decided_on FROM vigilance_decisions WHERE alert_id = ?',
      [row.id],
    );
    return {
      alertId: row.id,
      caseRef: row.case_ref,
      personId: row.person_id,
      key: row.rule_key,
      rule: 'R93',
      label: LABELS[row.rule_key],
      figures,
      text,
      settingsVersion: row.settings_version,
      fingerprint: row.fingerprint,
      raisedAt: row.raised_at,
      decision: d ? { decision: d.decision, reason: d.reason, validatorName: d.validator_name, decidedOn: d.decided_on } : null,
      notice: VIGILANCE_NOTICE,
    };
  }
}

/** La phrase d'une alerte rangée, depuis ses chiffres. */
function textOf(key: VigilanceRuleKey, f: VigilanceFigures): string {
  switch (key) {
    case 'prix_ecarte_valeur':
      return `${LABELS[key]} : ${fmtEur(Number(f.priceEur))}, soit ${f.gapPercent} % ${f.direction} de la fourchette ${fmtEur(Number(f.lowEur))} à ${fmtEur(Number(f.highEur))} de l’avis de valeur validé le ${f.valuationOn} ; écart réglé : ${f.thresholdPercent} %.`;
    case 'montant_inhabituel':
      return `${LABELS[key]} : ${fmtEur(Number(f.priceEur))}, au seuil réglé de ${fmtEur(Number(f.thresholdEur))} ou au-delà.`;
    default:
      return `${LABELS[key]} sur la fiche de risque du ${f.preparedOn}.`;
  }
}
