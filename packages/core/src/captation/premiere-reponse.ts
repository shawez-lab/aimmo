/**
 * La première réponse à un contact (C04), avec les vraies données du bien reconnu (C03) et une seule question
 * pour avancer : visite, rappel ou estimation. L'IA rédige derrière une interface ; tout part par le contrôle
 * central (S06), qui ajoute la mention [R06], contrôle le texte [R07 à R10, R19] et passe au secours [R12].
 * Sans bien reconnu, un message simple et honnête, sans aucune donnée de bien [R20].
 */
import type { SqlDatabase } from '../db/sql.ts';
import type { OutboundChannelName, Person, Property, PropertyKind } from '../db/types.ts';
import type { ReconnaissanceBien, Recognition } from '../biens/reconnaissance.ts';
import type { ControleEnvois, SendOrder, SendResult } from '../envoi/controle.ts';
import { plain } from '../envoi/texte.ts';
import type { InboundRow, Reception } from '../reception/reception.ts';
import type { FicheUnique } from '../fiche/fusion.ts';

export type SkipCode = 'not_attached' | 'no_channel' | 'already_replied';
export type NextStep = 'visit' | 'callback' | 'valuation';
export type ReplyLanguage = 'fr' | 'en';

/** Ce qu'on dit à l'IA : le strict nécessaire, aucune coordonnée [R15]. */
export interface ReplyBrief {
  channel: OutboundChannelName;
  language: ReplyLanguage;
  /** Tutoiement sur Instagram, vouvoiement ailleurs [R08]. */
  informal: boolean;
  /** Prénom de la personne, pour la saluer hors d'Instagram. */
  firstName: string | null;
  /** Le message reçu, tel quel. */
  received: string;
  /** Les données du bien reconnu, et seulement elles ; null : bien non reconnu [R20]. */
  property: PropertyFacts | null;
  /** La seule question à poser ; null : clôture courte, aucune question. */
  nextStep: NextStep | null;
}

export interface PropertyFacts {
  kind: PropertyKind;
  status: Property['status'];
  priceEur: number | null;
  surfaceM2: number | null;
  rooms: number | null;
  city: string | null;
  neighborhood: string | null;
  highlight: string | null;
}

/** L'IA qui rédige. Absente ou en panne : texte de secours. */
export interface ReplyWriter {
  write(brief: ReplyBrief): Promise<string>;
}

export interface FirstReplyOutcome {
  inboundId: string;
  recognition: Recognition['status'];
  nextStep: NextStep | null;
  result: SendResult | null;
  /** Rien n'a été tenté : canal sans réponse automatique ici, ou message non rattaché. */
  skipped: string | null;
  /** Le motif, en code : `not_attached`, `no_channel` ou `already_replied`. */
  skipCode: SkipCode | null;
}

const KIND_FR: Record<PropertyKind, string> = {
  home: 'le bien',
  land: 'le terrain',
  building: "l'immeuble",
  commercial: 'le local',
  business_walls: 'les murs',
  business: 'le fonds',
};
const KIND_EN: Record<PropertyKind, string> = {
  home: 'the property',
  land: 'the land',
  building: 'the building',
  commercial: 'the commercial space',
  business_walls: 'the premises',
  business: 'the business',
};

const EMAIL_IN_TEXT = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const PHONE_IN_TEXT = /(?:\+|00)?\d(?:[ ().-]*\d){7,14}/g;
const STREET_IN_TEXT =
  /\b\d{1,4}\s?(?:bis|ter)?,?\s+(?:rue|avenue|av\.?|boulevard|bd|place|chemin|all[ée]e|impasse|route|quai|cours|square|passage|faubourg|rond-point|r[ée]sidence|lotissement)\b[^,\n]*/gi;

/**
 * Le message reçu sans ses coordonnées : un mail de portail ou une signature en portent souvent. L'IA n'en a pas
 * besoin pour répondre [R15].
 */
export function withoutContactDetails(text: string): string {
  return text.replace(EMAIL_IN_TEXT, '[mail]').replace(STREET_IN_TEXT, '[adresse]').replace(PHONE_IN_TEXT, '[téléphone]');
}

const THANKS = /^(?:merci|thanks?|thank you|super merci|ok merci|merci beaucoup|parfait merci|top merci)\b[\s!.]*(?:beaucoup|bien|a vous|a toi|bonne journee|bonne soiree)?[\s!.]*$/;
const VALUATION = /\b(?:estim|vendre|vend|valeur|combien vaut|avis de valeur|sell|valuation)/;
const ENGLISH = /\b(?:hello|hi|is it|still available|price|please|thanks|could|would|visit|viewing|interested)\b/;
const FRENCH = /\b(?:bonjour|merci|est-ce|disponible|prix|visite|je|vous|svp|bonsoir)\b/;

/** Langue du client : celle de sa fiche si elle n'est pas le français, sinon devinée du message. */
export function replyLanguage(person: Pick<Person, 'language'> | null, text: string): ReplyLanguage {
  if (person?.language === 'en') return 'en';
  const p = plain(text);
  return ENGLISH.test(p) && !FRENCH.test(p) ? 'en' : 'fr';
}

/** La seule question : visite pour un bien en vente, estimation pour un vendeur, sinon rappel. Rien pour un merci. */
export function nextStepFor(text: string, property: PropertyFacts | null): NextStep | null {
  const p = plain(text).trim();
  if (THANKS.test(p)) return null;
  if (property && (property.status === 'available' || property.status === 'under_offer')) return 'visit';
  if (VALUATION.test(p)) return 'valuation';
  return 'callback';
}

const euros = (n: number): string => `${n.toLocaleString('fr-FR').replace(/[  ]/g, ' ')} €`;
// Écriture française des nombres, dans toutes les langues : c'est elle que lit le contrôle des chiffres [R10].
const surface = (n: number): string => `${String(n).replace('.', ',')} m²`;

/** Les chiffres que la réponse peut citer : ceux du bien, et seulement eux [R10]. */
export function figuresOf(facts: PropertyFacts | null): (string | number)[] {
  if (!facts) return [];
  return [facts.priceEur, facts.surfaceM2, facts.rooms, facts.highlight, facts.neighborhood].filter(
    (v): v is string | number => v !== null,
  );
}

function question(step: NextStep, informal: boolean, language: ReplyLanguage): string {
  if (language === 'en') {
    return { visit: 'Would you like to arrange a visit?', callback: 'Would you like me to call you back?', valuation: 'Would you like a valuation of your property?' }[step];
  }
  if (informal) {
    return { visit: 'Tu veux qu’on organise une visite ?', callback: 'Tu préfères que je t’appelle ?', valuation: 'Tu veux qu’on estime ton bien ?' }[step];
  }
  return { visit: 'Souhaitez-vous organiser une visite ?', callback: 'Souhaitez-vous que je vous rappelle ?', valuation: 'Souhaitez-vous une estimation de votre bien ?' }[step];
}

/**
 * Les textes de secours, écrits sans IA, du plus complet au plus simple. Chacun passe le même contrôle :
 * le premier qui passe part. Un atout ou un quartier refusé par le contrôle laisse partir le texte suivant.
 */
export function fallbackTexts(brief: ReplyBrief): string[] {
  const { informal, language, firstName, property, nextStep } = brief;
  const hello =
    language === 'en' ? `Hello${firstName ? ` ${firstName}` : ''},` : informal ? 'Hello !' : `Bonjour${firstName ? ` ${firstName}` : ''},`;
  if (nextStep === null) {
    return [language === 'en' ? `You are welcome${firstName ? ` ${firstName}` : ''}, have a nice day!` : informal ? 'Avec plaisir, belle journée !' : `Avec plaisir${firstName ? ` ${firstName}` : ''}, belle journée !`];
  }
  const ask = question(nextStep, informal, language);
  if (!property) {
    const body =
      language === 'en'
        ? 'Thank you for your message, I will come back to you very quickly.'
        : informal
          ? 'Merci pour ton message, je reviens vers toi très vite.'
          : 'Merci pour votre message, je reviens vers vous très vite.';
    return [`${hello} ${body} ${ask}`];
  }

  const what = language === 'en' ? KIND_EN[property.kind] : KIND_FR[property.kind];
  const where = property.city ? (language === 'en' ? ` in ${property.city}` : ` à ${property.city}`) : '';
  const quarter = property.neighborhood ? (language === 'en' ? `, ${property.neighborhood} area` : `, quartier ${property.neighborhood}`) : '';
  const facts = [
    property.priceEur !== null ? euros(property.priceEur) : null,
    property.surfaceM2 !== null ? surface(property.surfaceM2) : null,
  ].filter((v): v is string => v !== null);
  const status =
    property.status === 'available'
      ? language === 'en' ? 'is available' : 'est disponible'
      : property.status === 'under_offer'
        ? language === 'en' ? 'already has an offer, but visits are still possible' : 'a déjà une offre, mais on peut encore le visiter'
        : language === 'en' ? 'is no longer for sale' : 'n’est plus en vente';
  // Après « Bonjour Camille, » la phrase continue en minuscule ; après « Hello ! », elle commence par une majuscule.
  const Cap = (t: string): string => (hello.endsWith(',') ? t : t.charAt(0).toUpperCase() + t.slice(1));
  const base = `${Cap(what)}${where}${quarter} ${status}${facts.length > 0 ? ` : ${facts.join(', ')}` : ''}.`;
  const withHighlight = property.highlight ? `${base.slice(0, -1)}, ${property.highlight.replace(/[.!]+$/, '')}.` : null;
  const plainBase = `${Cap(what)}${where} ${status}${facts.length > 0 ? ` : ${facts.join(', ')}` : ''}.`;
  return [...new Set([withHighlight, base, plainBase].filter((t): t is string => t !== null).map((t) => `${hello} ${t} ${ask}`))];
}

/** Canal de la réponse : celui du message, le mail donné dans le formulaire du site, ou la session de l'assistant du site (C08). */
function replyChannel(row: InboundRow, hasEmail: boolean): OutboundChannelName | null {
  switch (row.channel) {
    case 'instagram':
    case 'facebook':
    case 'whatsapp':
    case 'email':
      return row.channel;
    case 'site':
      // L'assistant du site répond dans la session du visiteur (C08) ; le formulaire, par mail s'il en donne un.
      if (row.kind === 'site_chat') return 'site';
      return row.kind === 'form' && hasEmail ? 'email' : null;
  }
}

export interface PremiereReponseOptions {
  writer?: ReplyWriter;
}

type LastCheck = (networkId: string, conversationId: string) => Promise<{ allowed: boolean; rule: string; reason: string }>;

export class PremiereReponse {
  constructor(
    private readonly db: SqlDatabase,
    private readonly fiche: FicheUnique,
    private readonly reception: Reception,
    private readonly biens: ReconnaissanceBien,
    private readonly controle: ControleEnvois,
    private readonly options: PremiereReponseOptions = {},
  ) {}

  private beforeSend: LastCheck | null = null;

  /** Ce que le dernier contrôle de chaque réponse doit aussi relire (les échos humains gardés, C09a) [R21]. */
  checkBeforeSend(check: LastCheck): void {
    this.beforeSend = check;
  }

  /** Répond au message reçu, une fois rattaché à sa fiche (C02). Ne répond jamais deux fois au même message [R05]. */
  async reply(inboundId: string): Promise<FirstReplyOutcome> {
    const row = await this.reception.get(inboundId);
    const skip = (code: SkipCode, reason: string, recognition: Recognition['status'] = 'unrecognized'): FirstReplyOutcome => ({
      inboundId,
      recognition,
      nextStep: null,
      result: null,
      skipped: reason,
      skipCode: code,
    });
    if (!row || row.kind === 'unreadable' || row.person_id === null) return skip('not_attached', 'Message non rattaché à une fiche.');
    const view = await this.fiche.view(row.person_id);
    const channel = replyChannel(row, view.identifiers.some((i) => i.kind === 'email'));
    if (!channel) return skip('no_channel', 'Pas de réponse automatique sur ce canal ici.');

    const recognition = await this.biens.recognize(row.network_id, {
      postRef: row.post_ref,
      propertyRef: row.property_ref,
      portal: row.portal,
      subject: row.subject,
      text: row.body,
    });
    const recognized = recognition.status === 'recognized' ? recognition.property : null;
    // Un bien déjà envoyé à la personne ne repart pas [R05] : la réponse ne le cite plus et propose le rappel,
    // pour ne jamais laisser la personne sans réponse [R12].
    const notSent = recognized && !(await this.alreadySent(view.members.map((p) => p.id), recognized.id)) ? recognized : null;
    // Un simple merci reçoit une clôture courte : elle ne cite pas le bien, qui reste à envoyer plus tard.
    const closing = nextStepFor(row.body, null) === null;
    const property = closing ? null : notSent;
    const facts = property ? await this.facts(property) : null;
    const firstName = view.members.map((p) => p.first_name).find((n) => n) ?? null;
    const brief: ReplyBrief = {
      channel,
      language: replyLanguage(view.person, row.body),
      informal: channel === 'instagram',
      firstName: channel === 'instagram' ? null : firstName,
      received: withoutContactDetails(row.body),
      property: facts,
      nextStep: closing ? null : nextStepFor(row.body, facts),
    };
    const sellers = property ? await this.sellerNames(property) : [];
    const recipient = firstName ? plain(firstName) : null;
    // Un vendeur qui porte le prénom de la personne : le prénom n'est permis que dans la salutation des textes de
    // secours, et l'IA ne rédige pas, pour que ce prénom ne puisse jamais désigner le vendeur [R19].
    const sharedName = recipient !== null && sellers.some((n) => plain(n) === recipient);
    // Sans bien reconnu, l'IA ne rédige pas : seul le texte simple et honnête part [R20].
    const writer = property && !sharedName ? this.options.writer : undefined;
    const conversationKey = `${row.channel}:${row.conversation_ref ?? `${row.kind}:${row.external_id}`}`;
    const order: SendOrder = {
      networkId: row.network_id,
      agentId: view.person.agent_id,
      personId: view.person.id,
      conversationId: conversationKey,
      channel,
      kind: 'reply',
      ...(this.beforeSend ? { stillAllowed: () => this.beforeSend!(row.network_id, conversationKey) } : {}),
      ...(property ? { propertyIds: [property.id] } : {}),
      ...(writer ? { compose: () => writer.write(brief) } : {}),
      fallbackTexts: fallbackTexts(brief),
      rolloutRef: inboundId,
      figures: figuresOf(facts),
      sellerNames: sellers.filter((n) => plain(n) !== recipient),
      maxQuestions: brief.nextStep === null ? 0 : 1,
    };
    // Une seule réponse par message reçu, même relancé ou traité deux fois en même temps [R18].
    const claimId = crypto.randomUUID();
    const { changes } = await this.db.run(
      `INSERT INTO first_reply_claims (claim_key, inbound_id, claim_id, outcome, created_at) VALUES (?, ?, ?, NULL, ?)
       ON CONFLICT (claim_key) DO NOTHING`,
      [inboundId, inboundId, claimId, new Date().toISOString()],
    );
    if (changes !== 1) return skip('already_replied', 'Ce message a déjà reçu sa réponse.', recognition.status);
    let result: SendResult;
    try {
      result = await this.controle.send(order);
    } catch (error) {
      await this.releaseClaim(claimId, 'erreur');
      throw error;
    }
    await this.db.run('UPDATE first_reply_claims SET outcome = ? WHERE claim_id = ?', [result.status, claimId]);
    // Seule une réponse partie garde sa réservation : un refus ou une panne laissent réessayer plus tard,
    // et le contrôle central réexamine tout à chaque essai.
    if (result.status !== 'sent') await this.releaseClaim(claimId, result.status === 'failed' ? 'panne' : 'refus');
    return { inboundId, recognition: recognition.status, nextStep: brief.nextStep, result, skipped: null, skipCode: null };
  }

  /** Rend la réservation pour un nouvel essai, sans effacer sa ligne. */
  private async releaseClaim(claimId: string, reason: string): Promise<void> {
    await this.db.run(`UPDATE first_reply_claims SET claim_key = claim_key || '#${reason}:' || claim_id WHERE claim_id = ?`, [claimId]);
  }

  private async alreadySent(personIds: readonly string[], propertyId: string): Promise<boolean> {
    const row = await this.db.first<{ n: number }>(
      `SELECT count(*) AS n FROM message_subjects s
       WHERE s.person_id IN (${personIds.map(() => '?').join(', ')}) AND s.subject = ?
         AND NOT EXISTS (SELECT 1 FROM send_log l WHERE l.message_id = s.message_id AND l.outcome = 'failed')
         ${this.controle.trialNotCounted ? 'AND NOT EXISTS (SELECT 1 FROM trial_outbox t WHERE t.message_id = s.message_id)' : ''}`,
      [...personIds, `bien:${propertyId}`],
    );
    return Number(row?.n ?? 0) > 0;
  }

  private async facts(property: Property): Promise<PropertyFacts> {
    const details = await this.db.first<{ neighborhood: string | null; highlight: string | null }>(
      'SELECT neighborhood, highlight FROM property_details WHERE property_id = ? AND network_id = ?',
      [property.id, property.network_id],
    );
    return {
      kind: property.kind,
      status: property.status,
      priceEur: property.price_eur,
      surfaceM2: property.surface_m2,
      rooms: property.rooms,
      city: property.city,
      neighborhood: details?.neighborhood ?? null,
      highlight: details?.highlight ?? null,
    };
  }

  /** Noms et prénoms des vendeurs du bien [R19]. */
  private async sellerNames(property: Property): Promise<string[]> {
    const rows = await this.db.all<{ first_name: string | null; last_name: string | null }>(
      `SELECT DISTINCT p.first_name, p.last_name FROM project_properties pp
       JOIN projects pr ON pr.id = pp.project_id
       JOIN persons p ON p.id = pr.person_id
       WHERE pp.property_id = ? AND pp.role = 'owned'`,
      [property.id],
    );
    return rows.flatMap((r) => [r.first_name, r.last_name]).filter((n): n is string => !!n && n.trim().length > 1);
  }
}
