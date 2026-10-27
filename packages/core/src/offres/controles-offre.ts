/**
 * Contrôles de l'offre, sans évaluer personne (M09, O02) [R14, R15].
 *
 * Un contrôle écrit, ligne par ligne, rendu à l'agent et gardé : l'identité de l'acquéreur est-elle vérifiée (un état
 * lu dans les vérifications de D03, jamais une pièce) ; l'apport et le prêt déclarés couvrent-ils le prix offert (l'écart
 * est chiffré, sans jugement) ; le prêt de la condition suspensive est-il celui qui est déclaré ; l'offre est-elle encore
 * dans sa durée de validité. Aucun score, aucun classement, aucune évaluation de solvabilité : des constats.
 *
 * Décidé, lecture prudente : une identité compte comme vérifiée si elle l'a été depuis moins d'un an (comme D03) ; les
 * frais d'acquisition ne sont pas déclarés dans l'offre, la cohérence porte sur le prix offert seul.
 */
import type { Acces } from '../acces/acces.ts';
import type { Viewer } from '../acces/droits.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { localTime } from '../envoi/horaires.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import { RegistreOffres, type Offer } from './registre-offres.ts';

const TIME_ZONE = 'Europe/Paris';
export const IDENTITY_VALID_DAYS = 365;

export type CheckLine =
  | { check: 'identite'; status: 'verifiee'; checkedOn: string }
  | { check: 'identite'; status: 'non_verifiee' }
  | { check: 'financement'; status: 'couvert' }
  | { check: 'financement'; status: 'ecart'; missingEur: number }
  | { check: 'pret'; status: 'coherent' | 'sans_objet' }
  | { check: 'pret'; status: 'different'; conditionLoanEur: number; declaredLoanEur: number }
  | { check: 'validite'; status: 'en_cours' | 'echue'; lastDay: string };

/** Les lignes du contrôle d'une offre : des constats, dans un ordre fixe. Fonction pure. */
export function offerCheckLines(offer: Offer, identitySeenAt: string | null, now: Date): CheckLine[] {
  const lines: CheckLine[] = [];
  const fresh = identitySeenAt !== null && now.getTime() - Date.parse(identitySeenAt) <= IDENTITY_VALID_DAYS * 86_400_000;
  lines.push(fresh ? { check: 'identite', status: 'verifiee', checkedOn: localTime(new Date(identitySeenAt!), TIME_ZONE).date } : { check: 'identite', status: 'non_verifiee' });
  const covered = offer.downPaymentEur + offer.loanEur;
  lines.push(covered >= offer.amountEur ? { check: 'financement', status: 'couvert' } : { check: 'financement', status: 'ecart', missingEur: offer.amountEur - covered });
  const loan = offer.conditions.find((c) => c.kind === 'pret');
  if (!loan || loan.kind !== 'pret') lines.push({ check: 'pret', status: 'sans_objet' });
  else if (loan.amountEur === offer.loanEur) lines.push({ check: 'pret', status: 'coherent' });
  else lines.push({ check: 'pret', status: 'different', conditionLoanEur: loan.amountEur, declaredLoanEur: offer.loanEur });
  const today = localTime(now, TIME_ZONE).date;
  lines.push({ check: 'validite', status: today <= offer.validUntil ? 'en_cours' : 'echue', lastDay: offer.validUntil });
  return lines;
}

type Refusal = { ok: false; rule: 'R16'; code: string };

export class ControlesOffre {
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly registre: RegistreOffres;

  constructor(
    private readonly db: SqlDatabase,
    acces: Acces,
    private readonly journal: JournalStore,
    options: { now?: () => Date; newId?: () => string } = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => crypto.randomUUID());
    this.registre = new RegistreOffres(db, acces, journal, { now: this.now, newId: this.newId });
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
    // L'état de l'identité seulement : la date de la dernière vérification, jamais la pièce [R15].
    const identity = await this.db.first<{ seen_at: string }>('SELECT seen_at FROM identity_checks WHERE network_id = ? AND person_id = ? ORDER BY seen_at DESC LIMIT 1', [viewer.networkId, offer.buyerPersonId]);
    const lines = offerCheckLines(offer, identity?.seen_at ?? null, this.now());
    await this.db.run('INSERT INTO offer_checks (id, offer_id, network_id, lines, checked_by, checked_at) VALUES (?, ?, ?, ?, ?, ?)', [
      this.newId(), offerId, viewer.networkId, JSON.stringify(lines), `${String(viewer.role)}:${viewer.userId}`, this.now().toISOString(),
    ]);
    // Au journal : les constats en codes, sans montant ni nom [R13].
    await appendEvent(this.journal, { type: 'offre.controlee', actor: `${String(viewer.role)}:${viewer.userId}`, subject: `offer:${offerId}`, data: { rule: 'R14', lines: lines.map((l) => `${l.check}:${l.status}`) } }, this.now);
    return { ok: true, value: lines };
  }
}
