/**
 * Mentions obligatoires d'une annonce et liste de contrôle (M07, P02) [R43, R44, R45].
 *
 * Le code calcule et place les mentions ; l'IA n'en écrit aucune. Chaque mention est rendue « présente »,
 * « manquante » (avec sa raison) ou « sans objet ». Une seule mention manquante bloque la publication.
 *
 * Décidé, lecture prudente :
 * - le prix du mandat est le prix demandé hors honoraires à la charge de l'acquéreur. Quand l'acquéreur paie les
 *   honoraires, le prix publié est ce prix plus les honoraires TTC, écrit en plus grand, suivi du prix hors honoraires et
 *   des honoraires en pourcentage du prix hors honoraires. Quand le vendeur les paie, le prix publié est le prix du
 *   mandat, honoraires à la charge du vendeur ;
 * - le pourcentage est arrondi au centième, le demi vers le haut, et écrit sans zéro inutile (« 5 % », « 4,5 % ») ;
 * - le prix vient du mandat en vigueur, avenant de prix signé compris, jamais d'une saisie ni du prix de la fiche du
 *   bien [R44] ; les honoraires sont ceux du mandat signé ;
 * - un terrain n'a pas de diagnostic énergétique ; tout autre bien d'habitation en exige un [R45] ; les commerces et
 *   entreprises suivront M16 et ne passent pas encore ;
 * - « très énergivore » : classe F ou G, avec la mention « Logement à consommation énergétique excessive » ;
 * - le numéro de carte professionnelle est un réglage du réseau, réglé par la direction (H09 pour le vrai) ;
 * - un diagnostic énergétique n'est retenu que s'il est encore valable au jour de Paris du calcul (AU005, R45) :
 *   fait avant le 1er janvier 2018, valable au plus tard jusqu'au 31 décembre 2022 ; fait du 1er janvier 2018 au
 *   30 juin 2021, jusqu'au 31 décembre 2024 ; fait depuis le 1er juillet 2021, dix ans, jusqu'à la veille du même jour
 *   dix ans plus tard (code de la construction et de l'habitation, art. D126-19 et décret n° 2020-1610, lus le
 *   2026-11-19 sur service-public.gouv.fr F16096). Le jour est donné à chaque calcul : chaque passage de publication
 *   le relit, une annonce dont le diagnostic expire est retirée au passage suivant ;
 * - l'intervenant d'une annonce est l'agent du bien (AU007, R43, R152) : un agent d'AIMMO est un agent commercial habilité
 *   par le titulaire de la carte du réseau, sans carte à son nom. Ses mentions suivent son statut réel, celui que la
 *   direction a rangé pour lui (AT03) : statut, greffe et numéro d'immatriculation au RSAC, titulaire qui l'habilite.
 *   Sans statut rangé, agent parti ou sans titulaire, la mention manque et l'annonce ne part pas ; elle est relue à
 *   chaque passage de publication, et suit donc l'agent du bien quand il change.
 */
import type { Acces } from '../acces/acces.ts';
import type { Viewer } from '../acces/droits.ts';
import type { SqlDatabase } from '../db/sql.ts';
import type { PropertyKind } from '../db/types.ts';
import { mandateTerms } from '../documents/conditions.ts';
import type { DocumentFacts } from '../documents/modeles.ts';
import { Diffusion } from '../documents/retractation.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import { energyPriceText, type EnergyClass, type PropertySheet } from './fiche-bien.ts';

/** Le jour à Paris, `AAAA-MM-JJ`. */
function parisDay(at: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
}

export const MENTION_IDS = ['prix', 'energie', 'copropriete', 'risques', 'intervenant', 'carte'] as const;
export type MentionId = (typeof MENTION_IDS)[number];

export type MissingReason =
  | 'pas_de_mandat'
  | 'prix_inconnu'
  | 'honoraires_inconnus'
  | 'pas_de_diagnostic'
  | 'diagnostic_perime'
  | 'copropriete_inconnue'
  | 'risques_inconnus'
  | 'statut_intervenant_inconnu'
  | 'titulaire_inconnu'
  | 'carte_inconnue'
  | 'type_de_bien_non_pris_en_charge';

export type MentionItem =
  | { id: MentionId; status: 'presente'; text: string }
  | { id: MentionId; status: 'manquante'; reason: MissingReason }
  | { id: MentionId; status: 'sans_objet' };

export interface PriceTerms {
  /** Prix du mandat en vigueur, hors honoraires à la charge de l'acquéreur. */
  priceEur: number | null;
  feeEur: number | null;
  feeCharge: 'vendeur' | 'acquereur' | null;
}

/** L'agent du bien, avec le statut rangé par la direction (AT03). Seul statut connu : agent commercial [R152]. */
export interface Intervenant {
  firstName: string;
  lastName: string;
  status: 'agent_commercial';
  rsacNumber: string;
  rsacRegistry: string;
  /** Le titulaire de la carte professionnelle qui l'habilite ; null tant que la direction ne l'a pas réglé. */
  cardHolder: string | null;
}

export interface MentionsInput {
  kind: PropertyKind;
  /** null quand aucun mandat signé n'existe pour le bien. */
  terms: PriceTerms | null;
  sheet: PropertySheet | null;
  cardNumber: string | null;
  /** L'agent du bien et son statut ; null s'il n'y en a pas, s'il est parti ou si son statut n'est pas rangé (AU007). */
  intervenant: Intervenant | null;
  /** Le jour de Paris du calcul, `AAAA-MM-JJ` : la validité du diagnostic énergétique se juge ce jour-là [R45]. */
  today: string;
}

export interface Checklist {
  /** true seulement quand aucune mention ne manque [R43]. */
  complete: boolean;
  items: MentionItem[];
  /** Le prix publié, celui que tous les canaux montreront [R44] ; null s'il ne peut pas être calculé. */
  publishedPriceEur: number | null;
  /** Les mentions présentes, dans l'ordre, prêtes à placer sous l'annonce. */
  text: string;
}

const NBSP = ' ';
const NNBSP = ' ';

/** `210 000 €`, avec des espaces fines insécables, comme en français. */
export function euros(amount: number): string {
  const digits = String(Math.trunc(amount));
  return `${digits.replace(/\B(?=(\d{3})+(?!\d))/g, NNBSP)}${NBSP}€`;
}

/** Pourcentage en centièmes, arrondi le demi vers le haut, calculé en entiers pour éviter les erreurs de virgule. */
export function feePercent(feeEur: number, netPriceEur: number): string {
  // centièmes de pour cent = fee * 10 000 / net, arrondi au plus proche, le demi vers le haut.
  const hundredths = Math.floor((feeEur * 10_000 * 2 + netPriceEur) / (2 * netPriceEur));
  const whole = Math.floor(hundredths / 100);
  const rest = hundredths % 100;
  const decimals = rest === 0 ? '' : `,${String(rest).padStart(2, '0').replace(/0$/, '')}`;
  return `${whole}${decimals}${NBSP}%`;
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

function realDay(v: unknown): v is string {
  if (typeof v !== 'string' || !ISO_DAY.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

/**
 * Le dernier jour de validité d'un diagnostic énergétique fait le jour donné, ou null si la date n'est pas un vrai jour
 * [R45]. Dix ans au plus ; les diagnostics d'avant le 1er juillet 2021 ont une fin fixée par le décret n° 2020-1610.
 */
export function dpeValidUntil(diagnosedOn: string): string | null {
  if (!realDay(diagnosedOn)) return null;
  const d = new Date(`${diagnosedOn}T00:00:00Z`);
  // Dix ans, jusqu'à la veille du même jour : un 29 février donne le 28 février, dix ans plus tard.
  const tenYears = new Date(Date.UTC(d.getUTCFullYear() + 10, d.getUTCMonth(), d.getUTCDate()));
  if (tenYears.getUTCMonth() !== d.getUTCMonth()) tenYears.setUTCDate(1);
  tenYears.setUTCDate(tenYears.getUTCDate() - 1);
  const decennial = tenYears.toISOString().slice(0, 10);
  if (diagnosedOn >= '2021-07-01') return decennial;
  const cap = diagnosedOn >= '2018-01-01' ? '2024-12-31' : '2022-12-31';
  return decennial < cap ? decennial : cap;
}

/** Vrai seulement si le diagnostic fait ce jour-là est encore valable le jour donné, et n'est pas daté après lui. */
export function dpeValidOn(diagnosedOn: string, today: string): boolean {
  const until = dpeValidUntil(diagnosedOn);
  if (until === null || !realDay(today)) return false;
  return diagnosedOn <= today && today <= until;
}

const HOMES: readonly PropertyKind[] = ['home', 'building', 'land'];
const GEORISQUES = 'Les informations sur les risques auxquels ce bien est exposé sont disponibles sur le site Géorisques : www.georisques.gouv.fr';

/**
 * Les deux classes lues dans les mentions publiées (AU006) : la phrase « Classe énergie X, classe climat Y. » est
 * écrite par `computeMentions` seule, au début d'une ligne ; la page et la fiche en tirent les deux étiquettes, de la
 * même version publiée que le texte [R43]. Toute autre forme ne rend rien.
 */
export function energyClassesOf(mentions: string | null): { energy: EnergyClass; climate: EnergyClass } | null {
  const m = mentions ? /^Classe énergie ([A-G]), classe climat ([A-G])\./m.exec(mentions) : null;
  return m ? { energy: m[1] as EnergyClass, climate: m[2] as EnergyClass } : null;
}

/** La phrase de l'intervenant, jamais « mandataire » [R07, R152]. */
export function intervenantLine(who: Intervenant): string {
  const name = `${who.firstName.trim()} ${who.lastName.trim()}`.trim();
  return `Votre agent : ${name}, agent commercial, RSAC de ${who.rsacRegistry.trim()} n° ${who.rsacNumber.trim()}, habilité par ${who.cardHolder!.trim()}, titulaire de la carte.`;
}

/** Calcule chaque mention et la liste de contrôle. Fonction pure : mêmes données, même texte, au caractère près. */
export function computeMentions(input: MentionsInput): Checklist {
  const items: MentionItem[] = [];
  let publishedPriceEur: number | null = null;
  const supported = HOMES.includes(input.kind);

  // Prix et honoraires [R44].
  const t = input.terms;
  if (!supported) items.push({ id: 'prix', status: 'manquante', reason: 'type_de_bien_non_pris_en_charge' });
  else if (t === null) items.push({ id: 'prix', status: 'manquante', reason: 'pas_de_mandat' });
  else if (t.priceEur === null || !Number.isInteger(t.priceEur) || t.priceEur <= 0) items.push({ id: 'prix', status: 'manquante', reason: 'prix_inconnu' });
  else if (t.feeCharge === null || t.feeEur === null || !Number.isInteger(t.feeEur) || t.feeEur < 0) items.push({ id: 'prix', status: 'manquante', reason: 'honoraires_inconnus' });
  else if (t.feeCharge === 'acquereur') {
    publishedPriceEur = t.priceEur + t.feeEur;
    items.push({
      id: 'prix',
      status: 'presente',
      text: `Prix : ${euros(publishedPriceEur)} honoraires inclus, soit ${euros(t.priceEur)} hors honoraires et ${feePercent(t.feeEur, t.priceEur)} TTC du prix hors honoraires, à la charge de l'acquéreur.`,
    });
  } else {
    publishedPriceEur = t.priceEur;
    items.push({ id: 'prix', status: 'presente', text: `Prix : ${euros(publishedPriceEur)}, honoraires à la charge du vendeur.` });
  }

  // Énergie [R45].
  const sheet = input.sheet;
  if (!supported) items.push({ id: 'energie', status: 'manquante', reason: 'type_de_bien_non_pris_en_charge' });
  else if (input.kind === 'land') items.push({ id: 'energie', status: 'sans_objet' });
  else if (!sheet?.energy) items.push({ id: 'energie', status: 'manquante', reason: 'pas_de_diagnostic' });
  else if (!dpeValidOn(sheet.energy.diagnosedOn, input.today)) items.push({ id: 'energie', status: 'manquante', reason: 'diagnostic_perime' });
  else {
    const e = sheet.energy;
    const excessive = e.energyClass === 'F' || e.energyClass === 'G' ? ' Logement à consommation énergétique excessive.' : '';
    items.push({
      id: 'energie',
      status: 'presente',
      text:
        `Classe énergie ${e.energyClass}, classe climat ${e.climateClass}.${excessive} ` +
        `Montant estimé des dépenses annuelles d'énergie pour un usage standard : entre ${euros(e.annualCostMinEur)} et ${euros(e.annualCostMaxEur)} par an. ` +
        energyPriceText(e),
    });
  }

  // Copropriété.
  if (!supported) items.push({ id: 'copropriete', status: 'manquante', reason: 'type_de_bien_non_pris_en_charge' });
  else if (!sheet?.coownership) items.push({ id: 'copropriete', status: 'manquante', reason: 'copropriete_inconnue' });
  else if (!sheet.coownership.isCoownership) items.push({ id: 'copropriete', status: 'sans_objet' });
  else {
    const k = sheet.coownership;
    items.push({
      id: 'copropriete',
      status: 'presente',
      text: `Bien en copropriété : ${k.lots} lot${k.lots > 1 ? 's' : ''}, charges annuelles moyennes de ${euros(k.annualChargesEur)}. ${k.proceedings ? 'Le syndicat des copropriétaires fait l\'objet d\'une procédure en cours.' : 'Aucune procédure en cours.'}`,
    });
  }

  // Risques.
  if (!supported) items.push({ id: 'risques', status: 'manquante', reason: 'type_de_bien_non_pris_en_charge' });
  else if (!sheet?.risks) items.push({ id: 'risques', status: 'manquante', reason: 'risques_inconnus' });
  else if (!sheet.risks.inRiskZone) items.push({ id: 'risques', status: 'sans_objet' });
  else items.push({ id: 'risques', status: 'presente', text: `${GEORISQUES}.` });

  // L'intervenant : son statut réel, son immatriculation, le titulaire qui l'habilite (AU007) [R43, R152].
  const who = input.intervenant;
  if (who === null || who.status !== 'agent_commercial' || !who.rsacNumber.trim() || !who.rsacRegistry.trim() || !`${who.firstName}${who.lastName}`.trim()) {
    items.push({ id: 'intervenant', status: 'manquante', reason: 'statut_intervenant_inconnu' });
  } else if (who.cardHolder === null || who.cardHolder.trim() === '') items.push({ id: 'intervenant', status: 'manquante', reason: 'titulaire_inconnu' });
  else items.push({ id: 'intervenant', status: 'presente', text: intervenantLine(who) });

  // Carte professionnelle.
  if (input.cardNumber === null || input.cardNumber.trim() === '') items.push({ id: 'carte', status: 'manquante', reason: 'carte_inconnue' });
  else items.push({ id: 'carte', status: 'presente', text: `Carte professionnelle n° ${input.cardNumber.trim()}.` });

  const complete = items.every((i) => i.status !== 'manquante');
  const text = items.flatMap((i) => (i.status === 'presente' ? [i.text] : [])).join('\n');
  return { complete, items, publishedPriceEur: complete ? publishedPriceEur : null, text };
}

/** Un numéro de carte : lettres, chiffres, espaces et tirets, sans rien d'autre. */
const CARD = /^[A-Za-z0-9][A-Za-z0-9 -]{3,39}$/;

type Refusal = { ok: false; rule: 'R16'; code: string };
type Problem = { ok: false; rule: null; code: 'bad_card' | 'unknown_property' };

export class MentionsAnnonce {
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly diffusion: Diffusion;

  constructor(
    private readonly db: SqlDatabase,
    private readonly acces: Acces,
    private readonly journal: JournalStore,
    options: { now?: () => Date; newId?: () => string } = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => crypto.randomUUID());
    this.diffusion = new Diffusion(db, acces, journal, { now: this.now });
  }

  private actor(viewer: Viewer): string {
    return `${String(viewer.role)}:${viewer.userId}`;
  }

  /** Le numéro de carte professionnelle du réseau, réglé par la direction. Chaque réglage s'ajoute, rien ne s'efface. */
  async setCardNumber(viewer: Viewer, cardNumber: string): Promise<{ ok: true } | Refusal | Problem> {
    if (viewer.role !== 'direction') {
      await appendEvent(this.journal, { type: 'acces.refuse', actor: this.actor(viewer), subject: null, data: { rule: 'R16', role: String(viewer.role), kind: 'listing_settings', code: 'role' } }, this.now);
      return { ok: false, rule: 'R16', code: 'role' };
    }
    if (typeof cardNumber !== 'string' || !CARD.test(cardNumber.trim())) return { ok: false, rule: null, code: 'bad_card' };
    await this.db.run('INSERT INTO listing_settings (id, network_id, card_number, set_by, set_at) VALUES (?, ?, ?, ?, ?)', [this.newId(), viewer.networkId, cardNumber.trim(), this.actor(viewer), this.now().toISOString()]);
    await appendEvent(this.journal, { type: 'annonce.carte_reglee', actor: this.actor(viewer), subject: null, data: { rule: 'R43' } }, this.now);
    return { ok: true };
  }

  /**
   * Les données des mentions d'un bien, lues par le système : le mandat en vigueur, la dernière fiche, la carte.
   * Le mandat retenu est celui que la porte de diffusion retient (D05) ; sans mandat en vigueur, le prix manque.
   */
  async inputFor(networkId: string, propertyId: string): Promise<MentionsInput | null> {
    const property = await this.db.first<{ kind: PropertyKind; network_id: string }>('SELECT kind, network_id FROM properties WHERE id = ?', [propertyId]);
    if (!property || property.network_id !== networkId) return null;
    const decision = await this.diffusion.canDiffuse(networkId, propertyId, this.now());
    let terms: PriceTerms | null = null;
    // Seul un mandat en vigueur donne un prix : diffusable, ou signé et numéroté mais encore dans son délai de
    // rétractation. Un mandat rétracté, annulé, échu, sans durée ou pas encore numéroté n'en donne aucun [R44].
    const inForceReasons = ['allowed', 'allowed_early_start', 'withdrawal_period'];
    if (decision.mandateId !== null && inForceReasons.includes(decision.reason)) {
      const inForce = await mandateTerms(this.db, decision.mandateId);
      const base = await this.db.first<{ facts: string | null }>(
        'SELECT d.facts FROM signed_documents s JOIN documents d ON d.id = s.document_id WHERE s.mandate_id = ? AND s.copy_content IS NOT NULL',
        [decision.mandateId],
      );
      let facts: DocumentFacts | null = null;
      try {
        facts = base?.facts ? (JSON.parse(base.facts) as DocumentFacts) : null;
      } catch {
        facts = null;
      }
      if (inForce) terms = { priceEur: inForce.priceEur, feeEur: facts?.feeEur ?? null, feeCharge: facts?.feeCharge ?? null };
    }
    const sheetRow = await this.db.first<{ data: string }>('SELECT data FROM property_sheets WHERE property_id = ? ORDER BY version DESC LIMIT 1', [propertyId]);
    const card = await this.db.first<{ card_number: string }>('SELECT card_number FROM listing_settings WHERE network_id = ? ORDER BY set_at DESC, rowid DESC LIMIT 1', [networkId]);
    return { kind: property.kind, terms, sheet: sheetRow ? (JSON.parse(sheetRow.data) as PropertySheet) : null, cardNumber: card?.card_number ?? null, intervenant: await this.intervenantOf(networkId, propertyId), today: parisDay(this.now()) };
  }

  /** L'agent du bien et son dernier statut rangé, s'il est en activité dans le réseau ; sinon null (AU007) [R152]. */
  private async intervenantOf(networkId: string, propertyId: string): Promise<Intervenant | null> {
    const a = await this.db.first<{ id: string; first_name: string; last_name: string; status: string; network_id: string }>(
      'SELECT a.id, a.first_name, a.last_name, a.status, a.network_id FROM properties p JOIN agents a ON a.id = p.agent_id WHERE p.id = ?',
      [propertyId],
    );
    if (!a || a.network_id !== networkId || a.status !== 'active') return null;
    const legal = await this.db.first<{ legal_status: string; rsac_number: string; rsac_registry: string }>(
      'SELECT legal_status, rsac_number, rsac_registry FROM agent_legal_mentions WHERE agent_id = ? AND network_id = ? ORDER BY set_at DESC, id DESC LIMIT 1',
      [a.id, networkId],
    );
    if (!legal || legal.legal_status !== 'agent_commercial') return null;
    const holder = await this.db.first<{ holder_name: string }>('SELECT holder_name FROM card_holders WHERE network_id = ? ORDER BY set_at DESC, id DESC LIMIT 1', [networkId]);
    return { firstName: a.first_name, lastName: a.last_name, status: 'agent_commercial', rsacNumber: legal.rsac_number, rsacRegistry: legal.rsac_registry, cardHolder: holder?.holder_name ?? null };
  }

  /** La liste de contrôle d'un bien, pour qui voit le bien en entier : l'agent du bien, la direction, la conformité [R16]. */
  async check(viewer: Viewer, propertyId: string): Promise<{ ok: true; value: Checklist } | Refusal | Problem> {
    const p = await this.acces.readProperty(viewer, propertyId);
    if (!p.ok) return p.code === 'unknown' ? { ok: false, rule: null, code: 'unknown_property' } : (p as Refusal);
    if (p.view !== 'full') {
      await appendEvent(this.journal, { type: 'acces.refuse', actor: this.actor(viewer), subject: `property:${propertyId}`, data: { rule: 'R16', role: String(viewer.role), kind: 'listing_checklist', code: 'not_assigned' } }, this.now);
      return { ok: false, rule: 'R16', code: 'not_assigned' };
    }
    const input = await this.inputFor(viewer.networkId, propertyId);
    if (!input) return { ok: false, rule: null, code: 'unknown_property' };
    return { ok: true, value: computeMentions(input) };
  }
}
