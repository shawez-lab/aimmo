/**
 * L'assistant vocal (HX22) : il répond quand l'agent ne peut pas décrocher, pendant une visite par exemple.
 *
 * L'agent garde son seul numéro : l'assistant ne prend qu'un appel renvoyé depuis le numéro que l'agent a déclaré, sur
 * non-réponse, occupation ou absence de réseau, et seulement si l'agent l'a allumé. Aucun second numéro n'est pris ni
 * donné [R246]. La première phrase de chaque appel dit que c'est un assistant automatique et pour quel agent ; la
 * deuxième annonce l'enregistrement et demande l'accord, rangé avec son heure pour HX21 [R246, R242].
 *
 * L'assistant ne dit que des chiffres de la fiche du bien (le bien de l'agent, en vente ou sous offre) et des créneaux
 * qu'il propose. Il ne dit que des phrases fixes, jamais reformulées par une IA : un nombre écrit en lettres ou une
 * tournure inventée ne se vérifient pas. Chaque phrase est encore contrôlée avant d'être dite : un nombre qui ne vient ni
 * de la fiche ni d'un créneau proposé, ou un nombre en lettres, la fait taire. Une question que la fiche ne couvre pas est
 * renvoyée à l'agent, jamais devinée [R247]. Il ne négocie rien et ne donne ni adresse ni numéro.
 *
 * Un rendez-vous n'est pris que sur un créneau proposé pendant cet appel et encore libre au moment de réserver, par la
 * réservation en ligne de V08 (source « assistant »), qui revérifie les disponibilités et l'agenda [R248, R32, R33].
 * Un numéro masqué ne réserve rien. À la fin, l'appel est rangé par HX21 et la main passe à l'agent avec son résumé,
 * le rendez-vous pris et les sujets restés sans réponse, ceux-ci gardés seulement avec l'accord d'enregistrement.
 *
 * Décidé, lecture prudente : la reconnaissance de la parole est celle du service téléphonique ; les intentions sont
 * lues par des règles fixes, sans IA, et ce que dit l'appelant n'est envoyé à aucune IA par l'assistant [R15]. Un « non »
 * ou un « pas », ou une question, dans le choix d'un créneau ne réserve jamais rien : le créneau désigné est répété, et
 * seul un oui franc le réserve. L'accord à l'enregistrement n'est, lui aussi, qu'un oui sans réserve. Rien de ce qui est dit au journal [R13].
 *
 * Une demande d'arrêt dite à l'assistant (« ne m'appelez plus », « stop ») vaut un « STOP » écrit, à tout moment de
 * l'appel, avec ou sans accord d'enregistrement : elle est lue par la même lecture que les messages reçus (dans le doute,
 * c'est un arrêt), rien n'est réservé ensuite, l'assistant le confirme et raccroche, et l'exclusion « stop » est rangée
 * sur tous les canaux de la fiche de l'appelant à la fin de l'appel, datée de l'instant dit [R04] (RC21). Seul l'instant
 * est gardé, jamais la phrase [R13] ; un numéro masqué n'a pas de fiche, rien n'est rangé [R244].
 */
import type { Acces } from '../acces/acces.ts';
import type { Viewer } from '../acces/droits.ts';
import type { PropertySheet } from '../annonces/fiche-bien.ts';
import { FicheBien } from '../annonces/fiche-bien.ts';
import type { SqlDatabase } from '../db/sql.ts';
import type { Property } from '../db/types.ts';
import { isStopRequest } from '../envoi/service.ts';
import { numbersIn, plain } from '../envoi/texte.ts';
import { normalizePhone } from '../fiche/normalize.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import type { AppointmentKind } from '../rendezvous/creneaux.ts';
import type { ReservationEnLigne } from '../rendezvous/en-ligne.ts';
import { appointmentWhen } from '../rendezvous/reservation.ts';
import type { Appels, CallView } from './appels.ts';

/**
 * Le motif du renvoi. `conditional` (AU045) : un renvoi conditionnel réglé chez l'opérateur de l'agent (non-réponse,
 * occupation, absence de réseau), dont le service téléphonique ne transmet pas le motif précis [R246, R710].
 */
export const FORWARD_REASONS = ['no_answer', 'busy', 'unreachable', 'conditional'] as const;
export type ForwardReason = (typeof FORWARD_REASONS)[number];

/** Un appel renvoyé vers l'assistant, tel que le service téléphonique le décrit en le décrochant. */
export interface ForwardedCall {
  provider: string;
  callId: string;
  /** Numéro de l'appelant ; null pour un numéro masqué. */
  from: string | null;
  /** Le numéro qui a renvoyé l'appel : celui de l'agent, déclaré dans sa ligne. */
  forwardedFrom: string;
  forwardReason: ForwardReason;
  startedAt: Date;
  /** Le bien dont parle l'appel (bouton d'appel marqué de AT05), retrouvé par le branchement ; sinon null. */
  propertyId: string | null;
  /** Code de contenu de AT05 porté par l'appel, repassé à HX21 pour la provenance. */
  originCode: string | null;
}

export const TOPICS = ['prix', 'surface', 'pieces', 'chambres', 'etage', 'energie', 'charges', 'exterieur', 'stationnement', 'annee', 'chauffage', 'commune', 'autre'] as const;
export type Topic = (typeof TOPICS)[number];

/** Ce que l'assistant peut dire du bien : une phrase par sujet, et les nombres qu'elle porte, tous tirés de la fiche. */
export type PropertyFacts = Partial<Record<Exclude<Topic, 'autre'>, string>>;

export type Phase = 'consent' | 'ask' | 'choose' | 'confirm' | 'done';

/** L'état d'un appel entre deux tours de parole, en JSON : le branchement le garde le temps de l'appel. */
export interface AssistantState {
  v: 1;
  networkId: string;
  agentId: string;
  agentName: string;
  provider: string;
  callId: string;
  /** Le numéro de l'appelant, normalisé ; null s'il est masqué. */
  from: string | null;
  propertyId: string | null;
  originCode: string | null;
  kind: AppointmentKind;
  facts: PropertyFacts;
  underOffer: boolean;
  startedAt: string;
  announcedAt: string;
  consentAt: string | null;
  phase: Phase;
  /** Les débuts des créneaux proposés pendant cet appel, seuls réservables [R248]. */
  offered: string[];
  /** Le créneau désigné, répété à l'appelant ; réservé seulement après son oui franc [R248]. */
  pending: string | null;
  misses: number;
  /** Créneaux choisis puis pris entre-temps : au second, l'agent rappellera. */
  lost: number;
  turns: number;
  unanswered: Topic[];
  booked: { kind: AppointmentKind; start: string } | null;
  /** L'instant où l'appelant a demandé l'arrêt [R04], sans sa phrase ; absent ou null sinon. */
  stopAt?: string | null;
}

export interface Turn {
  state: AssistantState;
  /** Les phrases à dire, dans l'ordre. */
  say: string[];
  /** L'assistant raccroche après ces phrases. */
  done: boolean;
}

export type StartResult = ({ ok: true } & Turn) | { ok: false; code: 'bad_call' | 'no_line' | 'line_off' | 'not_forwarded' };

export interface AssistantOptions {
  now?: () => Date;
  newId?: () => string;
  /** Jours de créneaux cherchés. 7 par défaut. */
  slotDays?: number;
}

export interface Handoff {
  /** L'appel rangé par HX21, avec son résumé ; null s'il n'a pas pu être rangé. */
  call: CallView | null;
  appointment: { kind: AppointmentKind; start: string } | null;
  /** Les sujets que la fiche ne couvrait pas, à reprendre par l'agent ; vide sans accord d'enregistrement. */
  unanswered: Topic[];
  /** L'appelant a demandé l'arrêt pendant l'appel ; l'exclusion « stop » est rangée sur sa fiche, s'il en a une [R04]. */
  stop: boolean;
  already: boolean;
}

const PROVIDER = /^[a-z0-9-]{1,32}$/;
const CALL_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const MAX_TURNS = 14;
const MAX_SAID = 400;
const OFFERS = 3;
const OFFER_GAP_MS = 90 * 60_000;
const DAY_MS = 86_400_000;

const validDate = (d: unknown): d is Date => d instanceof Date && Number.isFinite(d.getTime());

/** Un nombre dit en français : « 210 000 », « 82,5 ». */
function spoken(n: number): string {
  const [int, dec] = String(n).split('.');
  const grouped = int!.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return dec ? `${grouped},${dec}` : grouped;
}

const HEATING: Record<string, string> = {
  individuel_gaz: 'individuel au gaz',
  individuel_electrique: 'individuel électrique',
  collectif: 'collectif',
  pompe_a_chaleur: 'par pompe à chaleur',
  bois: 'au bois',
  fioul: 'au fioul',
  autre: 'd’un autre type',
};
const OUTDOOR: Record<string, string> = { balcon: 'un balcon', terrasse: 'une terrasse', jardin: 'un jardin', cour: 'une cour' };

/** Les phrases que l'assistant peut dire d'un bien : seulement ce que la fiche porte, sans adresse ni référence [R247]. `price_eur` : le prix publié. */
export function propertyFacts(p: Pick<Property, 'city' | 'surface_m2' | 'rooms' | 'price_eur'>, sheet: PropertySheet | null): PropertyFacts {
  const f: PropertyFacts = {};
  if (p.price_eur !== null) f.prix = `Le prix de l’annonce est de ${spoken(p.price_eur)} €.`;
  if (p.surface_m2 !== null) f.surface = `La surface est de ${spoken(p.surface_m2)} m².`;
  if (p.rooms !== null) f.pieces = `Le bien compte ${spoken(p.rooms)} pièce${p.rooms > 1 ? 's' : ''}.`;
  if (p.city !== null && !/\d/.test(p.city)) f.commune = `Le bien se trouve à ${p.city}.`;
  const c = sheet?.characteristics;
  if (c) {
    if (c.bedrooms !== null) f.chambres = c.bedrooms === 0 ? 'Le bien n’a pas de chambre séparée.' : `Il y a ${spoken(c.bedrooms)} chambre${c.bedrooms > 1 ? 's' : ''}.`;
    if (c.floor !== null) {
      const level = c.floor === 0 ? 'Le bien est au rez-de-chaussée' : `Le bien est au ${spoken(c.floor)}e étage`;
      const of = c.floorsTotal !== null && c.floor > 0 ? ` sur ${spoken(c.floorsTotal)}` : '';
      const lift = c.elevator === true ? ', avec ascenseur' : c.elevator === false ? ', sans ascenseur' : '';
      f.etage = `${level}${of}${lift}.`;
    }
    if (c.buildYear !== null) f.annee = `L’immeuble date de ${c.buildYear}.`;
    if (c.heating !== null) f.chauffage = `Le chauffage est ${HEATING[c.heating] ?? HEATING.autre}.`;
    const outside = c.outdoor.map((o) => OUTDOOR[o]).filter((o): o is string => !!o);
    if (outside.length > 0 || c.landM2 !== null) {
      const land = c.landM2 !== null ? `un terrain de ${spoken(c.landM2)} m²` : null;
      const all = [...outside, ...(land ? [land] : [])];
      f.exterieur = `Le bien a ${all.length > 1 ? `${all.slice(0, -1).join(', ')} et ${all[all.length - 1]}` : all[0]}.`;
    } else if (c.outdoor.length === 0 && c.landM2 === null && sheet) f.exterieur = 'Le bien n’a pas d’extérieur indiqué dans sa fiche.';
    if (c.parkingSpaces !== null) {
      f.stationnement = c.parkingSpaces === 0 ? 'Il n’y a pas de place de stationnement.' : `Il y a ${spoken(c.parkingSpaces)} place${c.parkingSpaces > 1 ? 's' : ''} de stationnement.`;
    }
  }
  const e = sheet?.energy;
  if (e) {
    f.energie = `La classe énergie est ${e.energyClass} et la classe climat ${e.climateClass}. Les dépenses d’énergie sont estimées entre ${spoken(e.annualCostMinEur)} et ${spoken(e.annualCostMaxEur)} € par an, aux prix ${e.costReferenceYears && e.costReferenceYears.length > 1 ? `des années ${e.costReferenceYears[0]} à ${e.costReferenceYears.at(-1)}` : `de ${e.costReferenceYear}`}.`;
  }
  const co = sheet?.coownership;
  if (co) {
    f.charges = co.isCoownership
      ? `Le bien est dans une copropriété de ${spoken(co.lots)} lots, avec ${spoken(co.annualChargesEur)} € de charges par an.`
      : 'Le bien n’est pas en copropriété : il n’y a pas de charges de copropriété.';
  }
  return f;
}

/** Les nombres permis dans une phrase : ceux des phrases de la fiche et des créneaux proposés. */
export function allowedFigures(facts: PropertyFacts, offered: readonly string[]): Set<string> {
  const allowed = new Set<string>();
  for (const text of Object.values(facts)) for (const n of numbersIn(text ?? '')) allowed.add(n);
  for (const s of offered) for (const n of numbersIn(appointmentWhen(new Date(s)).text)) allowed.add(n);
  return allowed;
}

/** Les nombres en lettres : jamais dans une phrase de l'assistant, car ils ne se vérifient pas contre la fiche. « un » et « une » sont des articles. */
const NUMBER_WORDS = /\b(?:deux|trois|quatre|cinq|six|sept|huit|neuf|dix|onze|douze|treize|quatorze|quinze|seize|vingts?|trente|quarante|cinquante|soixante|septante|octante|nonante|cents?|milles?|millions?|milliards?|demie?|quart|moitie|double|triple|dizaines?|douzaines?|centaines?|milliers?)\b/;

/** Vrai si chaque nombre de la phrase vient de la fiche ou d'un créneau proposé, et qu'aucun n'est en lettres [R247]. */
export function figuresFromSheet(text: string, allowed: ReadonlySet<string>): boolean {
  return !NUMBER_WORDS.test(plain(text)) && numbersIn(text).every((n) => allowed.has(n));
}

// Les intentions, par des règles fixes.
const TOPIC_WORDS: [Exclude<Topic, 'autre'>, RegExp][] = [
  ['prix', /\b(?:prix|cout|coute|coutent|tarif|honoraires|combien (?:il |elle |ca )?(?:coute|vaut|vend)|c'est combien)\b/],
  ['surface', /\b(?:surface|superficie|m2|metres? carres?|grand)\b/],
  ['chambres', /\bchambres?\b/],
  ['pieces', /\bpieces?\b/],
  ['etage', /\b(?:etage|ascenseur|rez)\b/],
  ['energie', /\b(?:dpe|energie|energetique|diagnostic|classe|isolation|consommation)\b/],
  ['charges', /\b(?:charges?|copropriete|copro|syndic|lots?)\b/],
  ['exterieur', /\b(?:exterieur|jardin|terrasse|balcon|cour|terrain)\b/],
  ['stationnement', /\b(?:parking|garage|stationnement|place de parc|box)\b/],
  ['annee', /\b(?:annee|construit|construction|date de quand|ancien)\b/],
  ['chauffage', /\b(?:chauffage|chauffe|chaudiere|radiateurs?)\b/],
  ['commune', /\b(?:ou se trouve|quelle ville|quel quartier|situe|adresse|quelle rue|ou est)\b/],
];
/** La négociation, le vendeur, ce que la fiche ne dit pas : jamais l'assistant, toujours l'agent. */
const OFF_SHEET = /\b(?:negociables?|negocier|negociation|baisser|baisse|faire une offre|vendeur|vendeuse|pourquoi|travaux|taxe fonciere|ecoles?|voisins?|libre quand)\b/;
const OTHER_QUESTION = /\?/;
const MEETING = /\b(?:rendez-vous|rdv|visite|visiter|voir le bien|le voir|rappeler|rappelle|rappel|creneau|disponibilites?|passer|estimer|estimation|faire estimer)\b/;
const SELLER = /\b(?:vendre|estimer|estimation|faire estimer|mettre en vente)\b/;
const BYE = /\b(?:au revoir|c'est tout|ce sera tout|rien d'autre|merci,? au revoir|bonne journee|non merci)\b/;
const YES = /\b(?:oui|ouais|d'accord|ok|okay|bien sur|allez-y|pas de probleme|ca marche|entendu|volontiers)\b/;
const NO = /\b(?:non|pas d'accord|refuse|je ne veux pas|surtout pas|sans enregistrement)\b/;
const NEGATION = /\b(?:non|pas|aucun|aucune|ni|jamais|refuse|plutot pas)\b|\bn'/;
const QUESTION = /\?|\b(?:quel|quelle|quels|quelles|quand|combien|est-ce|comment|pourquoi|c'est ou|ou est|ou ca)\b/;
const WEEKDAYS = ['lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi', 'dimanche'];

/** Les sujets de la fiche demandés dans une phrase ; `autre` pour une question que la fiche ne couvre pas. */
export function topicsIn(utterance: string): Topic[] {
  const p = plain(utterance);
  // Une question de négociation ou sur le vendeur n'est jamais lue comme une question de prix.
  if (OFF_SHEET.test(p)) return ['autre'];
  const found: Topic[] = TOPIC_WORDS.filter(([, re]) => re.test(p)).map(([t]) => t);
  if (found.length === 0 && OTHER_QUESTION.test(p) && !MEETING.test(p)) found.push('autre');
  return found;
}

/** Un oui franc : au moins un mot d'accord, et rien d'autre que d'autres mots d'accord ou des politesses. « Oui, mais pas pour enregistrer », « Merci. » n'en sont pas. */
const AGREE = "oui|ouais|d'accord|je suis d'accord|ok|okay|bien sur|allez-y|allez y|ca marche|entendu|volontiers|tout a fait|absolument|parfait|tres bien|c'est bon|pas de probleme|pas de souci|c'est parfait";
const COURTESY = 'merci|bonjour|madame|monsieur';
const PLAIN_YES = new RegExp(`^(?:(?:${COURTESY})[\\s,.!]*)*(?:${AGREE})[\\s,.!]*(?:(?:${AGREE}|${COURTESY})[\\s,.!]*)*$`);

/** L'accord, à l'enregistrement comme à un créneau : seulement un oui franc, sans réserve ni question. Un doute vaut refus. */
export function saysYes(utterance: string): boolean {
  return PLAIN_YES.test(plain(utterance).replace(/[’]/g, "'").trim());
}

/** Le créneau choisi parmi ceux proposés, par son rang, son jour ou son heure ; null si rien ne désigne un seul créneau. */
export function chosenSlot(utterance: string, offered: readonly string[]): string | null {
  const p = plain(utterance);
  if (offered.length === 0) return null;
  const ranks: [RegExp, number][] = [
    [/\b(?:premier|premiere|1er|1ere)\b/, 0],
    [/\b(?:deuxieme|second|seconde|2e|2eme)\b/, 1],
    [/\b(?:troisieme|3e|3eme)\b/, 2],
  ];
  const picks = new Set<number>();
  for (const [re, i] of ranks) if (re.test(p) && i < offered.length) picks.add(i);
  if (/\b(?:dernier|derniere)\b/.test(p)) picks.add(offered.length - 1);
  if (picks.size === 0) {
    const whens = offered.map((s) => plain(appointmentWhen(new Date(s)).text));
    const day = WEEKDAYS.find((d) => new RegExp(`\\b${d}\\b`).test(p));
    const hour = p.match(/\b(\d{1,2}) ?h(?: ?(\d{2}))?\b/);
    whens.forEach((w, i) => {
      const dayOk = !day || w.includes(`le ${day} `);
      const hourOk = !hour || w.endsWith(`a ${Number(hour[1])} h${hour[2] && hour[2] !== '00' ? ` ${hour[2]}` : ''}`);
      if ((day || hour) && dayOk && hourOk) picks.add(i);
    });
  }
  return picks.size === 1 ? offered[[...picks][0]!]! : null;
}

/** Un refus d'être enregistré, qui ne dit rien des envois : « je ne veux pas être enregistré », « pas d'enregistrement ». */
const RECORDING_REFUSAL = /\b(?:(?:je |nous )?ne (?:veux|voulons|souhaite|souhaitons|desire) (?:pas|plus) |pas |sans |surtout pas )(?:etre |d'etre |d'|de |l'|qu'on m'|que vous m')?(?:enregistr|registr)\w*/g;

/** Un mot qui parle d'un contact ou d'un envoi : s'il reste après le refus d'enregistrement, la phrase est un arrêt. */
const CONTACT_WORD = /\b(?:stop|arret\w*|appel\w*|rappel\w*|contact\w*|recontact\w*|ecri\w*|relanc\w*|recevoir|recu|envo\w*|messages?|sms|mails?|courriels?|derang\w*|tranquille|desinscri\w*|supprim\w*|effac\w*|retir\w*|coordonnees|numero|donnees)\b/;

/**
 * Une demande d'arrêt dite à l'assistant, lue comme un message reçu [R04] : dans le doute, c'est un arrêt. Une phrase
 * n'échappe à l'arrêt que si elle n'est qu'un refus d'être enregistré, qui répond à l'annonce et ne parle pas des envois :
 * dès qu'un mot de contact ou d'envoi reste à côté (« je ne veux plus être enregistré ni recevoir vos messages », « je ne
 * veux pas être enregistré, ne m'appelez plus »), c'est un arrêt.
 */
export function stopAsked(utterance: string): boolean {
  const p = plain(utterance);
  if (!isStopRequest(p)) return false;
  const rest = p.replace(RECORDING_REFUSAL, ' ');
  return rest === p || isStopRequest(rest) || CONTACT_WORD.test(rest);
}

export class AssistantVocal {
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly slotDays: number;
  private readonly sheets: FicheBien;

  constructor(
    private readonly db: SqlDatabase,
    private readonly journal: JournalStore,
    private readonly acces: Acces,
    private readonly reservation: ReservationEnLigne,
    private readonly appels: Appels,
    options: AssistantOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => crypto.randomUUID());
    this.slotDays = options.slotDays ?? 7;
    this.sheets = new FicheBien(db, acces, journal, { now: this.now });
  }

  /**
   * L'agent déclare son propre numéro, vers lequel il renverra ses appels sans réponse, et allume ou éteint l'assistant.
   * Seuls l'agent lui-même et la direction de son réseau le font.
   */
  async setLine(viewer: Viewer, input: { agentId: string; phone: string; enabled: boolean }): Promise<{ ok: true } | { ok: false; code: 'forbidden' | 'unknown_agent' | 'bad_phone' | 'taken' }> {
    const agent = await this.db.first<{ id: string; network_id: string }>("SELECT id, network_id FROM agents WHERE id = ? AND status = 'active'", [input.agentId]);
    if (!agent) return { ok: false, code: 'unknown_agent' };
    const allowed = viewer.networkId === agent.network_id && ((viewer.role === 'agent' && viewer.userId === agent.id) || viewer.role === 'direction');
    if (!allowed) return { ok: false, code: 'forbidden' };
    const phone = normalizePhone(input.phone);
    if (phone === null) return { ok: false, code: 'bad_phone' };
    const at = this.now().toISOString();
    try {
      await this.db.run(
        `INSERT INTO voice_assistant_lines (agent_id, network_id, phone, enabled, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (agent_id) DO UPDATE SET phone = excluded.phone, enabled = excluded.enabled, updated_at = excluded.updated_at`,
        [agent.id, agent.network_id, phone, input.enabled ? 1 : 0, at],
      );
    } catch (error) {
      if (/UNIQUE/i.test(String(error))) return { ok: false, code: 'taken' };
      throw error;
    }
    // Au journal : l'agent et l'état, jamais le numéro [R13].
    await appendEvent(this.journal, { type: 'voix.assistant_ligne', actor: `${String(viewer.role)}:${viewer.userId}`, subject: `agent:${agent.id}`, data: { rule: 'R246', enabled: input.enabled } }, this.now);
    return { ok: true };
  }

  /** Décroche un appel renvoyé : la mention de l'assistant d'abord, puis l'annonce de l'enregistrement [R246, R242]. */
  async start(call: ForwardedCall): Promise<StartResult> {
    if (!call || typeof call.provider !== 'string' || !PROVIDER.test(call.provider) || typeof call.callId !== 'string' || !CALL_ID.test(call.callId)) return { ok: false, code: 'bad_call' };
    if (!validDate(call.startedAt) || !FORWARD_REASONS.includes(call.forwardReason) || typeof call.forwardedFrom !== 'string') return { ok: false, code: 'bad_call' };
    const forwardedFrom = normalizePhone(call.forwardedFrom);
    if (forwardedFrom === null) return { ok: false, code: 'not_forwarded' };
    // Le numéro est unique dans la base ; si deux lignes le portaient, l'appel n'irait à aucune [R246].
    const lines = await this.db.all<{ agent_id: string; network_id: string; enabled: number }>(
      "SELECT l.agent_id, l.network_id, l.enabled FROM voice_assistant_lines l JOIN agents a ON a.id = l.agent_id AND a.network_id = l.network_id AND a.status = 'active' WHERE l.phone = ?",
      [forwardedFrom],
    );
    if (lines.length !== 1) return { ok: false, code: 'no_line' };
    const line = lines[0]!;
    if (line.enabled !== 1) return { ok: false, code: 'line_off' };
    const agent = (await this.db.first<{ first_name: string }>('SELECT first_name FROM agents WHERE id = ?', [line.agent_id]))!;
    const from = typeof call.from === 'string' ? normalizePhone(call.from) : null;

    const { facts, underOffer, propertyId } = await this.readProperty(line.network_id, line.agent_id, call.propertyId);
    const at = this.now();
    const name = agent.first_name.replace(/[^\p{L}' -]/gu, '').trim() || 'votre agent';
    const state: AssistantState = {
      v: 1,
      networkId: line.network_id,
      agentId: line.agent_id,
      agentName: name,
      provider: call.provider,
      callId: call.callId,
      from,
      propertyId,
      originCode: typeof call.originCode === 'string' ? call.originCode : null,
      kind: propertyId ? 'visite' : 'appel',
      facts,
      underOffer,
      startedAt: call.startedAt.toISOString(),
      announcedAt: at.toISOString(),
      consentAt: null,
      phase: 'consent',
      offered: [],
      pending: null,
      misses: 0,
      lost: 0,
      turns: 0,
      unanswered: [],
      booked: null,
    };
    await appendEvent(this.journal, { type: 'voix.assistant_decroche', actor: 'system', subject: `agent:${line.agent_id}`, data: { rule: 'R246', reason: call.forwardReason, property: propertyId !== null } }, this.now);
    // La mention de l'assistant est toujours la première phrase, jamais reformulée ni précédée [R246].
    return {
      ok: true,
      state,
      say: [
        `Bonjour, vous êtes sur l’assistant automatique de ${name}, agent immobilier AIMMO, qui ne peut pas vous répondre pour le moment.`,
        `Cet appel est enregistré pour que ${name} en ait le résumé. Êtes-vous d’accord ?`,
      ],
      done: false,
    };
  }

  /** Un tour de parole : ce que l'appelant vient de dire, et ce que l'assistant répond. */
  async hear(previous: AssistantState, utterance: string): Promise<Turn> {
    const state: AssistantState = structuredClone(previous);
    if (state.phase === 'done') return { state, say: [], done: true };
    state.turns += 1;
    const text = typeof utterance === 'string' ? utterance.slice(0, 1000) : '';
    // L'arrêt passe avant tout, même au-delà du nombre de tours, et ne réserve jamais le créneau en attente [R04].
    if (stopAsked(text)) {
      state.stopAt = this.now().toISOString();
      state.pending = null;
      return this.close(state, [state.from === null ? 'C’est noté : aucune coordonnée de vous n’est gardée.' : 'C’est noté : vous ne recevrez plus ni appel ni message de notre part.']);
    }
    if (state.turns > MAX_TURNS) return this.close(state, []);

    if (state.phase === 'consent') {
      if (saysYes(text)) state.consentAt = this.now().toISOString();
      state.phase = 'ask';
      const intro = state.consentAt ? 'Merci.' : 'C’est noté, l’appel ne sera pas enregistré.';
      return this.reply(state, [intro, this.offerHelp(state)]);
    }

    const p = plain(text);
    if (state.phase === 'confirm') {
      const pending = state.pending;
      state.pending = null;
      state.phase = 'choose';
      // Seul un oui franc au créneau répété réserve ; tout le reste le laisse libre [R248].
      if (pending && state.offered.includes(pending) && saysYes(text)) return this.book(state, pending);
      if (BYE.test(p)) return this.close(state, [`Très bien, ${state.agentName} vous rappellera.`]);
      state.misses += 1;
      if (state.misses >= 2) return this.close(state, [`Je n’ai rien réservé ; ${state.agentName} vous rappellera pour fixer le rendez-vous.`]);
      return this.reply(state, [`Je n’ai rien réservé. Lequel préférez-vous : ${this.listOffers(state.offered)} ?`]);
    }

    if (state.phase === 'choose') {
      if (BYE.test(p)) return this.close(state, [`Très bien, ${state.agentName} vous rappellera.`]);
      // Une négation ou une question ne vaut jamais choix : « non, pas le premier », « le premier est à quelle heure ? » [R248].
      const pick = NEGATION.test(p) || QUESTION.test(p) ? null : chosenSlot(text, state.offered);
      if (pick) {
        state.pending = pick;
        state.phase = 'confirm';
        state.misses = 0;
        return this.reply(state, [`Je réserve ${this.what(state)} ${appointmentWhen(new Date(pick)).text}. C’est bien cela ?`]);
      }
      if (NO.test(p) && !YES.test(p) && !/\b(?:pas|plutot|autre)\b/.test(p)) return this.close(state, [`Très bien, ${state.agentName} vous rappellera.`]);
      state.misses += 1;
      if (state.misses >= 2) return this.close(state, [`Je n’ai pas compris le créneau choisi ; ${state.agentName} vous rappellera pour le fixer.`]);
      return this.reply(state, [`Pardon, lequel préférez-vous : ${this.listOffers(state.offered)} ?`]);
    }

    // Phase « ask » : questions sur le bien, demande de rendez-vous, ou fin.
    const topics = topicsIn(text);
    const wantsMeeting = MEETING.test(p);
    if (SELLER.test(p) && !state.propertyId) state.kind = 'estimation';
    const said: string[] = [];
    for (const t of topics) {
      const fact = t === 'autre' ? undefined : state.facts[t];
      if (fact) said.push(fact);
      else {
        if (!state.unanswered.includes(t)) state.unanswered.push(t);
        said.push(
          t === 'autre'
            ? `Je ne peux pas répondre à cette question ; ${state.agentName} vous répondra lui-même.`
            : `Je n’ai pas cette information dans la fiche ; ${state.agentName} vous la donnera.`,
        );
      }
    }
    if (topics.length > 0 && state.underOffer && !said.some((s) => s.includes('sous offre'))) said.push('Le bien est déjà sous offre, des visites restent possibles.');
    if (wantsMeeting) return this.propose(state, said);
    if (topics.length > 0) return this.reply(state, [...said, 'Souhaitez-vous un rendez-vous, ou avez-vous une autre question ?']);
    if (BYE.test(p) || (NO.test(p) && !YES.test(p))) return this.close(state, [`Merci de votre appel, ${state.agentName} vous rappellera.`]);
    if (YES.test(p)) return this.propose(state, said);
    state.misses += 1;
    if (state.misses >= 2) return this.close(state, [`${state.agentName} vous rappellera dès que possible.`]);
    return this.reply(state, [`Je peux vous donner les informations de la fiche du bien, ou vous proposer un rendez-vous avec ${state.agentName}.`]);
  }

  /**
   * L'appel est fini : il est rangé par HX21, avec l'annonce et l'accord tels qu'ils ont été dits, puis la main passe à
   * l'agent. Une seule fois par appel, même livré plusieurs fois [R18].
   */
  async finish(state: AssistantState, end: { endedAt: Date; recordingRef: string | null }): Promise<Handoff> {
    const stopWanted = typeof state.stopAt === 'string' && Number.isFinite(Date.parse(state.stopAt));
    const existing = await this.db.first<{ call_row_id: string | null; appointment_kind: AppointmentKind | null; appointment_start: string | null; unanswered: string | null }>(
      'SELECT call_row_id, appointment_kind, appointment_start, unanswered FROM voice_assistant_calls WHERE network_id = ? AND provider = ? AND call_id = ?',
      [state.networkId, state.provider, state.callId],
    );
    if (existing) {
      let call = existing.call_row_id ? await this.appels.get(state.networkId, existing.call_row_id) : null;
      // Un passage de main rangé alors que HX21 n'avait pas fini l'appel : HX21 est repris, jamais laissé en plan [R18].
      if (existing.call_row_id && call === null) {
        const again = await this.appels.receive(state.networkId, this.callOf(state, end));
        if (!again.ok || again.status === 'en_cours') throw new Error('Appel encore en cours de rangement : passage de main à refaire.');
        call = await this.appels.get(state.networkId, existing.call_row_id);
      }
      return {
        call,
        appointment: existing.appointment_kind && existing.appointment_start ? { kind: existing.appointment_kind, start: existing.appointment_start } : null,
        unanswered: existing.unanswered ? (JSON.parse(existing.unanswered) as Topic[]) : [],
        stop: stopWanted,
        already: true,
      };
    }
    const received = await this.appels.receive(state.networkId, this.callOf(state, end));
    // Une autre livraison range encore l'appel (HX21) : aucun passage de main n'est rangé avant lui, tout reste à
    // refaire, pour que HX21 soit repris à la livraison suivante [R18].
    if (received.ok && received.status === 'en_cours') throw new Error('Appel encore en cours de rangement : passage de main à refaire.');
    const callRowId = received.ok ? received.callId : null;
    // L'arrêt est rangé avant le passage de main : une coupure entre les deux, la livraison suivante le refait sans le
    // doubler [R04, R18]. Tant qu'une autre livraison range encore l'appel, rien n'est rangé ici : à refaire.
    if (stopWanted && callRowId !== null && state.from !== null) {
      const noted = await this.appels.recordSpokenStop(state.networkId, callRowId, new Date(state.stopAt!));
      if (noted === 'en_cours') throw new Error('Appel encore en cours de rangement : passage de main à refaire.');
    }
    // Sans accord d'enregistrement, ou pour un numéro masqué, rien de ce qui a été dit n'est gardé, pas même les sujets [R242, R244].
    const unanswered = state.consentAt && state.from !== null ? state.unanswered.filter((t) => TOPICS.includes(t)) : [];
    try {
      await this.db.run(
        `INSERT INTO voice_assistant_calls (id, network_id, agent_id, provider, call_id, call_row_id, property_id, appointment_kind, appointment_start, unanswered, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [this.newId(), state.networkId, state.agentId, state.provider, state.callId, callRowId, state.propertyId, state.booked?.kind ?? null, state.booked?.start ?? null, unanswered.length ? JSON.stringify(unanswered) : null, this.now().toISOString()],
      );
    } catch (error) {
      if (/UNIQUE/i.test(String(error))) return this.finish(state, end);
      throw error;
    }
    await appendEvent(
      this.journal,
      { type: 'voix.assistant_passage', actor: 'system', subject: `agent:${state.agentId}`, data: { rule: 'R248', appointment: state.booked !== null, unanswered: unanswered.length, recorded: state.consentAt !== null, stop: stopWanted } },
      this.now,
    );
    return {
      call: callRowId ? await this.appels.get(state.networkId, callRowId) : null,
      appointment: state.booked,
      unanswered,
      stop: stopWanted,
      already: false,
    };
  }

  /** L'appel tel que HX21 le range. */
  private callOf(state: AssistantState, end: { endedAt: Date; recordingRef: string | null }) {
    return {
      provider: state.provider,
      callId: state.callId,
      from: state.from,
      startedAt: new Date(state.startedAt),
      endedAt: end.endedAt,
      announcedAt: new Date(state.announcedAt),
      consentAt: state.consentAt ? new Date(state.consentAt) : null,
      recordingRef: state.consentAt ? end.recordingRef : null,
      originCode: state.originCode,
    };
  }

  private offerHelp(state: AssistantState): string {
    return state.propertyId && Object.keys(state.facts).length > 0
      ? `Je peux répondre à vos questions sur ce bien, à partir de sa fiche, ou vous proposer un rendez-vous avec ${state.agentName}. Que souhaitez-vous ?`
      : `Je peux vous proposer un rendez-vous avec ${state.agentName}. Que souhaitez-vous ?`;
  }

  private what(state: AssistantState): string {
    return state.kind === 'visite' ? 'une visite' : state.kind === 'estimation' ? 'une estimation' : 'un rendez-vous téléphonique';
  }

  private listOffers(offered: readonly string[]): string {
    const whens = offered.map((s) => appointmentWhen(new Date(s)).text);
    return whens.length > 1 ? `${whens.slice(0, -1).join(', ')} ou ${whens[whens.length - 1]}` : whens[0]!;
  }

  /** Propose jusqu'à trois créneaux libres, espacés, de l'agenda de l'agent (V01) [R248, R33]. */
  private async propose(state: AssistantState, before: string[], exclude: readonly string[] = []): Promise<Turn> {
    if (state.from === null) {
      return this.close(state, [...before, `Votre numéro est masqué : je ne peux pas réserver de rendez-vous. Rappelez sans le masquer, ou ${state.agentName} reprendra contact avec vous.`]);
    }
    const from = this.now();
    const result = await this.reservation.slots({ networkId: state.networkId, agentId: state.agentId, kind: state.kind, from, to: new Date(from.getTime() + this.slotDays * DAY_MS) });
    const offered: string[] = [];
    if (result.ok) {
      let last = -Infinity;
      for (const s of result.slots) {
        const t = Date.parse(s.start);
        if (exclude.includes(s.start) || t - last < OFFER_GAP_MS) continue;
        offered.push(s.start);
        last = t;
        if (offered.length === OFFERS) break;
      }
    }
    if (offered.length === 0) return this.close(state, [...before, `Je n’ai pas de créneau libre à vous proposer ; ${state.agentName} vous rappellera.`]);
    state.offered = offered;
    state.pending = null;
    state.phase = 'choose';
    state.misses = 0;
    return this.reply(state, [...before, `Je peux vous proposer ${this.what(state)} ${this.listOffers(offered)}. Lequel vous convient ?`]);
  }

  /** Réserve le créneau choisi, revérifié libre par la réservation en ligne ; sinon de nouveaux créneaux [R248, R32]. */
  private async book(state: AssistantState, start: string): Promise<Turn> {
    const result = await this.reservation.book({
      networkId: state.networkId,
      agentId: state.agentId,
      kind: state.kind,
      start: new Date(start),
      source: 'assistant',
      phone: state.from,
      propertyId: state.propertyId,
      consentProof: bookingProofOf(state.provider, state.callId),
    });
    if (result.ok) {
      state.booked = { kind: state.kind, start };
      state.offered = [];
      state.pending = null;
      return this.close(state, [`C’est réservé, ${appointmentWhen(new Date(start)).text}. Vous recevrez une confirmation par message, et ${state.agentName} aura le résumé de notre échange.`]);
    }
    if (result.code === 'not_free' || result.code === 'taken' || result.code === 'agenda_busy' || result.code === 'outside_availability' || result.code === 'too_soon') {
      if (state.lost >= 1) return this.close(state, [`Ce créneau vient d’être pris ; ${state.agentName} vous rappellera pour en fixer un autre.`]);
      state.lost += 1;
      return this.propose(state, ['Ce créneau vient d’être pris.'], [...state.offered]);
    }
    return this.close(state, [`Je n’ai pas pu réserver ; ${state.agentName} vous rappellera pour fixer le rendez-vous.`]);
  }

  private reply(state: AssistantState, say: string[]): Turn {
    return { state, say: this.guard(state, say), done: false };
  }

  private close(state: AssistantState, say: string[]): Turn {
    state.phase = 'done';
    return { state, say: this.guard(state, [...say, 'Au revoir, et bonne journée.']), done: true };
  }

  /** Dernier contrôle avant de parler : une phrase qui porterait un nombre étranger à la fiche n'est pas dite [R247]. */
  private guard(state: AssistantState, say: string[]): string[] {
    const allowed = allowedFigures(state.facts, state.offered);
    if (state.booked) for (const n of numbersIn(appointmentWhen(new Date(state.booked.start)).text)) allowed.add(n);
    return say.filter((s) => s !== '' && figuresFromSheet(s, allowed)).map((s) => s.slice(0, MAX_SAID));
  }

  /** Le bien de l'appel : seulement un bien de l'agent, en vente ou sous offre, lu avec ses droits [R16]. */
  private async readProperty(networkId: string, agentId: string, propertyId: string | null): Promise<{ facts: PropertyFacts; underOffer: boolean; propertyId: string | null }> {
    if (typeof propertyId !== 'string' || propertyId === '') return { facts: {}, underOffer: false, propertyId: null };
    const viewer = { role: 'agent', networkId, userId: agentId } as Viewer;
    const read = await this.acces.readProperty(viewer, propertyId);
    if (!read.ok || read.view !== 'full') return { facts: {}, underOffer: false, propertyId: null };
    const p = read.value;
    if (p.agent_id !== agentId || (p.status !== 'available' && p.status !== 'under_offer')) return { facts: {}, underOffer: false, propertyId: null };
    const sheet = await this.sheets.read(viewer, propertyId);
    // Le prix dit est celui de l'annonce publiée, avenants compris, le même que sur tous les canaux [R44] ; sans annonce
    // en ligne, aucun prix n'est dit : l'agent le donnera.
    const listing = await this.db.first<{ state: string; price_eur: number | null }>('SELECT state, price_eur FROM listing_versions WHERE property_id = ? ORDER BY seq DESC LIMIT 1', [propertyId]);
    const published = listing && (listing.state === 'en_vente' || listing.state === 'sous_offre') && listing.price_eur !== null ? Number(listing.price_eur) : null;
    return { facts: propertyFacts({ ...p, price_eur: published }, sheet.ok ? sheet.value.sheet : null), underOffer: p.status === 'under_offer', propertyId };
  }
}

/** Où en est aujourd'hui le rendez-vous pris par l'assistant : suivi par ses décalages jusqu'au dernier. */
export type HandoffAppointmentState = 'prevu' | 'decale' | 'annule' | 'tenu' | 'absent' | 'introuvable';

/** Ce que la fiche montre d'un appel pris par l'assistant (BR63). */
export interface HandoffView {
  appointment: { kind: AppointmentKind; start: string; state: HandoffAppointmentState; current: string } | null;
  /** Les sujets que la fiche du bien ne couvrait pas, à reprendre ; vide sans accord d'enregistrement [R242]. */
  unanswered: Topic[];
  /** La référence du bien de l'appel, seulement pour l'agent du bien ou la direction [R16]. */
  propertyReference: string | null;
}

const MAX_MOVES = 50;
/**
 * La preuve de l'accord écrite avec le rendez-vous pris pendant un appel : elle finit par la référence propre à cet
 * appel, ce qui permet de retrouver le rendez-vous de cet appel-là, et d'aucun autre [R248, R03].
 */
export function bookingProofOf(provider: string, callId: string): string {
  return `rendez-vous demandé de vive voix à l'assistant vocal, appel ${provider}/${callId}`;
}

const APPOINTMENT_STATES: Record<string, HandoffAppointmentState> = { booked: 'prevu', cancelled: 'annule', honored: 'tenu', absent: 'absent' };

/**
 * BR63 · Le passage de main de l'assistant pour des appels déjà lus sous les droits de la fiche (BR61) : le rendez-vous
 * pris, suivi par ses décalages jusqu'à aujourd'hui, et les sujets restés sans réponse. Rien n'est écrit, rien au journal [R13].
 */
export async function handoffsOfCalls(db: SqlDatabase, viewer: Viewer, networkId: string, callRowIds: readonly string[]): Promise<Map<string, HandoffView>> {
  const out = new Map<string, HandoffView>();
  if (callRowIds.length === 0) return out;
  // La personne de l'appel : le rendez-vous suivi est le sien, jamais celui d'un autre appelant sur le même créneau libéré.
  const rows = await db.all<{ call_row_id: string; agent_id: string; person_id: string | null; property_id: string | null; appointment_kind: AppointmentKind | null; appointment_start: string | null; unanswered: string | null; created_at: string }>(
    `SELECT v.call_row_id, v.agent_id, c.person_id, v.property_id, v.appointment_kind, v.appointment_start, v.unanswered, v.created_at
     FROM voice_assistant_calls v JOIN calls c ON c.id = v.call_row_id
     WHERE v.network_id = ? AND v.call_row_id IN (${callRowIds.map(() => '?').join(', ')})`,
    [networkId, ...callRowIds],
  );
  for (const row of rows) {
    let unanswered: Topic[] = [];
    try {
      const parsed: unknown = row.unanswered ? JSON.parse(row.unanswered) : [];
      if (Array.isArray(parsed)) unanswered = parsed.filter((t): t is Topic => TOPICS.includes(t as Topic));
    } catch {
      unanswered = [];
    }
    let propertyReference: string | null = null;
    if (row.property_id) {
      const p = await db.first<{ reference: string; agent_id: string }>('SELECT reference, agent_id FROM properties WHERE id = ? AND network_id = ?', [row.property_id, networkId]);
      if (p && (viewer.role === 'direction' || (viewer.role === 'agent' && p.agent_id === viewer.userId))) propertyReference = p.reference;
    }
    out.set(row.call_row_id, { appointment: await followAppointment(db, networkId, row), unanswered, propertyReference });
  }
  return out;
}

/** Le rendez-vous réservé par l'assistant, puis chacun de ses décalages, jusqu'au dernier. */
async function followAppointment(
  db: SqlDatabase,
  networkId: string,
  row: { agent_id: string; person_id: string | null; property_id: string | null; appointment_kind: AppointmentKind | null; appointment_start: string | null; created_at: string },
): Promise<HandoffView['appointment']> {
  if (!row.appointment_kind || !row.appointment_start || !Number.isFinite(Date.parse(row.appointment_start))) return null;
  if (!row.person_id) return { kind: row.appointment_kind, start: new Date(row.appointment_start).toISOString(), state: 'introuvable', current: new Date(row.appointment_start).toISOString() };
  const start = new Date(row.appointment_start).toISOString();
  type Row = { id: string; start_at: string; status: string };
  const found = await db.first<Row>(
    `SELECT id, start_at, status FROM appointments
     WHERE network_id = ? AND agent_id = ? AND person_id = ? AND source = 'assistant' AND kind = ? AND start_at = ? AND replaces_id IS NULL AND property_id IS ? AND created_at <= ?
     ORDER BY created_at DESC, id DESC LIMIT 1`,
    [networkId, row.agent_id, row.person_id, row.appointment_kind, start, row.property_id, row.created_at],
  );
  // Jamais deviné : un rendez-vous qu'on ne retrouve pas dans l'agenda est dit tel.
  if (!found) return { kind: row.appointment_kind, start, state: 'introuvable', current: start };
  let current: Row = found;
  const first = found.id;
  for (let i = 0; i < MAX_MOVES; i += 1) {
    const next: Row | null = await db.first<Row>('SELECT id, start_at, status FROM appointments WHERE replaces_id = ? AND network_id = ? ORDER BY created_at DESC, id DESC LIMIT 1', [current.id, networkId]);
    if (!next) break;
    current = next;
  }
  const state = APPOINTMENT_STATES[current.status] ?? 'introuvable';
  return { kind: row.appointment_kind, start, state: state === 'prevu' && current.id !== first ? 'decale' : state, current: current.start_at };
}
