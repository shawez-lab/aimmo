/**
 * Contrôles de l'offre, sans évaluer personne (M09, O02) [R14, R15].
 *
 * Un contrôle écrit, ligne par ligne, rendu à l'agent et gardé : l'identité de l'acquéreur est-elle vérifiée (un état
 * lu dans les vérifications de D03, jamais une pièce) ; l'apport et le prêt déclarés couvrent-ils le prix offert (l'écart
 * est chiffré, sans jugement) ; le prêt de la condition suspensive est-il celui qui est déclaré ; l'offre est-elle encore
 * dans sa durée de validité, et cette durée est-elle inhabituelle (plus de 60 jours, AU080). Aucun score, aucun classement, aucune évaluation de solvabilité : des constats.
 *
 * Décidé, lecture prudente : une identité compte comme vérifiée selon la même règle que D03 (même réglage de durée, toutes
 * les fiches réunies de la personne) ; le cahier demande la cohérence « entre le montant et le financement déclaré » :
 * elle porte sur le prix offert, l'offre ne portant pas de frais.
 */
import type { Acces } from '../acces/acces.ts';
import { DEFAULT_CONTROL_SETTINGS, type ControlSettings } from '../documents/controles.ts';
import { Identification, type IdentificationStatus } from '../conformite/identification.ts';
import type { Viewer } from '../acces/droits.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { localTime } from '../envoi/horaires.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import { RegistreOffres, USUAL_VALIDITY_DAYS, validityDays, type Offer, type OfferInput } from './registre-offres.ts';

const TIME_ZONE = 'Europe/Paris';

export type CheckLine =
  | { check: 'identite'; status: 'verifiee'; checkedOn: string }
  | { check: 'identite'; status: 'non_verifiee' }
  | { check: 'financement'; status: 'couvert' }
  | { check: 'financement'; status: 'ecart'; missingEur: number }
  | { check: 'pret'; status: 'coherent' | 'sans_objet' }
  | { check: 'pret'; status: 'different'; conditionLoanEur: number; declaredLoanEur: number }
  | { check: 'validite'; status: 'en_cours' | 'echue'; lastDay: string }
  /** Une durée de validité au-delà de l'usage : l'offre est gardée telle quelle, l'agent vérifie la date sur l'offre signée (AU080). */
  | { check: 'validite_longue'; status: 'atypique'; days: number; usualDays: number };

/**
 * Les lignes du contrôle d'une offre : des constats, dans un ordre fixe. Fonction pure. `identitySeenAt` est la dernière
 * vérification d'identité déjà retenue dans la fenêtre du réglage, ou null.
 */
export function offerCheckLines(offer: Offer, identitySeenAt: string | null, now: Date): CheckLine[] {
  const lines: CheckLine[] = [];
  const fresh = identitySeenAt !== null;
  lines.push(fresh ? { check: 'identite', status: 'verifiee', checkedOn: localTime(new Date(identitySeenAt!), TIME_ZONE).date } : { check: 'identite', status: 'non_verifiee' });
  const covered = offer.downPaymentEur + offer.loanEur;
  lines.push(covered >= offer.amountEur ? { check: 'financement', status: 'couvert' } : { check: 'financement', status: 'ecart', missingEur: offer.amountEur - covered });
  const loan = offer.conditions.find((c) => c.kind === 'pret');
  if (!loan || loan.kind !== 'pret') lines.push({ check: 'pret', status: 'sans_objet' });
  else if (loan.amountEur === offer.loanEur) lines.push({ check: 'pret', status: 'coherent' });
  else lines.push({ check: 'pret', status: 'different', conditionLoanEur: loan.amountEur, declaredLoanEur: offer.loanEur });
  const today = localTime(now, TIME_ZONE).date;
  lines.push({ check: 'validite', status: today <= offer.validUntil ? 'en_cours' : 'echue', lastDay: offer.validUntil });
  // Seulement quand elle est inhabituelle : une offre d'une durée usuelle garde exactement les lignes d'avant.
  const days = validityDays(offer.receivedAt, offer.validUntil);
  if (days > USUAL_VALIDITY_DAYS) lines.push({ check: 'validite_longue', status: 'atypique', days, usualDays: USUAL_VALIDITY_DAYS });
  return lines;
}

type Refusal = { ok: false; rule: 'R16'; code: string };

export class ControlesOffre {
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly registre: RegistreOffres;
  private readonly identification: Identification;
  private readonly settings: ControlSettings;

  constructor(
    private readonly db: SqlDatabase,
    private readonly acces: Acces,
    private readonly journal: JournalStore,
    options: { now?: () => Date; newId?: () => string; settings?: ControlSettings } = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => crypto.randomUUID());
    this.settings = options.settings ?? DEFAULT_CONTROL_SETTINGS;
    this.registre = new RegistreOffres(db, acces, journal, { now: this.now, newId: this.newId });
    this.identification = new Identification(db, null, null, { now: this.now, maxAgeDays: this.settings.identityDays });
  }

  /** L'état d'identification de la personne au coffre de la conformité, à l'instant `at` (L03) [R92]. */
  async identificationAt(networkId: string, personId: string, at: Date): Promise<IdentificationStatus> {
    return this.identification.status(networkId, personId, at);
  }

  /**
   * La vérification d'identité qui vaut à l'instant `at`, toutes fiches réunies, lue au coffre (L03) : midi UTC du jour
   * de vérification, ou null si la pièce manque, a échu ou date de plus que le réglage [R92].
   */
  async identitySeenAt(networkId: string, personId: string, at: Date): Promise<string | null> {
    const status = await this.identification.status(networkId, personId, at);
    return status.ok ? `${status.verifiedOn}T12:00:00.000Z` : null;
  }

  /** Enregistre une offre et la contrôle aussitôt : chaque offre enregistrée a son contrôle écrit. */
  async recordAndCheck(viewer: Viewer, propertyId: string, input: OfferInput): Promise<{ ok: true; value: { offer: Offer; lines: CheckLine[] } } | Awaited<ReturnType<RegistreOffres['record']>> & { ok: false } | Refusal | { ok: false; rule: null; code: 'unknown_offer' | 'unknown_property' }> {
    const recorded = await this.registre.record(viewer, propertyId, input);
    if (!recorded.ok) return recorded;
    const checked = await this.check(viewer, recorded.value.id);
    if (!checked.ok) return checked;
    return { ok: true, value: { offer: recorded.value, lines: checked.value } };
  }

  /** Contrôle une offre, garde le résultat et l'écrit au journal en codes. L'agent du bien ou la direction [R16]. */
  async check(viewer: Viewer, offerId: string): Promise<{ ok: true; value: CheckLine[] } | Refusal | { ok: false; rule: null; code: 'unknown_offer' | 'unknown_property' }> {
    const row = await this.db.first<{ property_id: string; network_id: string }>('SELECT property_id, network_id FROM offer_register WHERE id = ?', [offerId]);
    if (!row || row.network_id !== viewer.networkId) {
      await appendEvent(this.journal, { type: 'acces.refuse', actor: `${String(viewer.role)}:${viewer.userId}`, subject: `offer:${offerId}`, data: { rule: 'R16', role: String(viewer.role), kind: 'offer', code: 'unknown' } }, this.now);
      return { ok: false, rule: null, code: 'unknown_offer' };
    }
    const list = await this.registre.list(viewer, row.property_id);
    if (!list.ok) return list as Refusal | { ok: false; rule: null; code: 'unknown_property' };
    const offer = list.value.find((o) => o.id === offerId)!;
    // L'état d'identité est une donnée de l'acquéreur : il faut voir sa fiche en entier, ou que le collègue qui la suit
    // l'ait partagée pour ce bien (AU081) ; la lecture est écrite au journal [R16]. Seul l'état est rendu, jamais la pièce.
    const buyer = await this.registre.buyerFor(viewer, row.property_id, offer.buyerPersonId);
    if (!buyer.ok) return buyer.rule === 'R16' ? buyer : { ok: false, rule: 'R16', code: 'unknown' };
    // L'état de l'identité seulement : la date de la dernière vérification, jamais la pièce [R15].
    const now = this.now();
    const lines = offerCheckLines(offer, await this.identitySeenAt(viewer.networkId, offer.buyerPersonId, now), now);
    await this.db.run('INSERT INTO offer_checks (id, offer_id, network_id, lines, checked_by, checked_at) VALUES (?, ?, ?, ?, ?, ?)', [
      this.newId(), offerId, viewer.networkId, JSON.stringify(lines), `${String(viewer.role)}:${viewer.userId}`, this.now().toISOString(),
    ]);
    // Au journal : les constats en codes, sans montant ni nom [R13].
    await appendEvent(this.journal, { type: 'offre.controlee', actor: `${String(viewer.role)}:${viewer.userId}`, subject: `offer:${offerId}`, data: { rule: 'R14', lines: lines.map((l) => `${l.check}:${l.status}`) } }, this.now);
    return { ok: true, value: lines };
  }
}
