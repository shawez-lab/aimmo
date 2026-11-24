/**
 * L'espace du vendeur : le suivi de la vente en direct (EC02) [R161, R163, R16, R06, R13].
 *
 * Décidé, lecture prudente :
 * - l'espace ne refait aucun module : il lit, par l'interface `SourcesVendeur`, ce que les modules ont rangé (mandat,
 *   visites et comptes rendus validés par l'agent, registre des offres et tableau du vendeur, dossier et pièces,
 *   rendez-vous, points de la semaine validés, date d'acte au plus tôt et ce qui la tient) ; fausse dans les tests ;
 * - un vendeur ne voit que les biens dont il est le mandant ; tout autre bien est refusé, comme s'il n'existait pas
 *   [R161, R16] ;
 * - la vue est construite champ par champ, depuis la liste écrite `CHAMPS_VENDEUR` : ce que les sources rendent en plus
 *   (nom, coordonnées ou fiche d'un visiteur ou d'un acquéreur) n'en sort jamais [R161] ;
 * - un texte libre (compte rendu, point de la semaine) n'est montré que validé par l'agent ; s'il cite le nom ou une
 *   coordonnée d'une personne venue pour le bien, ou parle de l'IA, il est retenu et dit « non communiqué » [R161, R06] ;
 * - chaque chiffre, date et statut porte sa source et sa date ; une donnée absente est « non communiquée » [R163, R10] ;
 * - chaque lecture va au journal, avec des identifiants et des nombres seulement [R13].
 */
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import type { ClientViewer } from './entree.ts';

/** Une donnée de la base avec sa source et sa date, ou « non communiquée » [R163]. */
export type Fait<T> = { value: T; source: string; at: string } | { value: null; label: 'non communiquée' };

export const NON_COMMUNIQUE = 'non communiquée' as const;

/** Ce que les sources disent d'un bien du vendeur. */
export interface SellerProperty {
  propertyId: string;
  reference: string;
  city: string;
  status: string;
  statusAt: string;
  /** Le prix du mandat en vigueur, avec la date du mandat ; absent : non communiqué. */
  askingPriceEur: number | null;
  mandateSignedAt: string | null;
}

export interface SellerVisit {
  id: string;
  at: string;
  state: 'prevue' | 'faite' | 'annulee';
  /** Le compte rendu validé par l'agent (T06), déjà rédigé pour le vendeur. */
  report: { text: string; interest: string | null; validatedAt: string } | null;
  /**
   * Ce qui identifie le visiteur : lu seulement pour être retenu, jamais montré. Contrat des sources (EC06) : toujours
   * rattaché quand la visite a un visiteur connu ; la retenue ne connaît que les personnes rattachées, le reste repose sur
   * la validation du compte rendu par l'agent (T06, R52).
   */
  visitor: SourcePerson | null;
}

/**
 * Une offre dont le dossier de vente a été arrêté : ce que lisent le vendeur et l'acquéreur, sans la raison, qui reste à
 * l'agent [R233, R14]. La sous-requête s'emploie là où `o` est la ligne de `offer_register`.
 */
export const OFFER_STOPPED_STATE = 'la vente ne se fait plus';
export const OFFER_STOPPED_AT = 'SELECT stop_.at FROM sale_files f_ JOIN sale_file_stops stop_ ON stop_.file_id = f_.id WHERE f_.offer_id = o.id';

export interface SellerOffer {
  id: string;
  receivedAt: string;
  /** Le montant en vigueur (O06) ; absent quand le tableau des offres n'a pu être lu : non communiqué. */
  amountEur: number | null;
  /** Net vendeur après les honoraires du mandat (O06) ; absent : non communiqué. */
  netSellerEur: number | null;
  conditions: readonly string[];
  validUntil: string | null;
  state: string | null;
  stateAt: string;
  buyer: SourcePerson | null;
}

export interface SellerDocument {
  id: string;
  title: string;
  kind: string;
  addedAt: string;
  signature: 'sans' | 'a_signer' | 'signe';
  signedAt: string | null;
  /** Le numéro du registre d'un mandat signé [R39] ; absent : non communiqué. */
  number?: string | null;
}

export interface SellerAppointment {
  id: string;
  at: string;
  kind: string;
  state: string;
}

export interface SellerWeeklyPoint {
  weekOf: string;
  text: string;
  validatedAt: string | null;
}

export interface SellerDeedDate {
  date: string | null;
  holds: readonly { label: string }[];
  computedAt: string;
}

/** Une personne venue pour le bien : ce qui l'identifie, pour la retenir de tout texte [R161]. */
export interface SourcePerson {
  personId: string;
  firstName?: string | null;
  lastName?: string | null;
  emails?: readonly string[];
  phones?: readonly string[];
}

/**
 * Les sources de l'espace du vendeur. Fausses dans les tests ; lecteurs SQL dans `sources-vendeur.ts` (EC08). Chaque
 * lecture d'un bien reçoit le vendeur qui lit : rien de ce qui précède son premier mandat sur le bien ne lui est rendu
 * [R161].
 */
export interface SourcesVendeur {
  sellerPropertiesOf(networkId: string, personId: string): Promise<readonly SellerProperty[]>;
  visitsOf(networkId: string, propertyId: string, personId: string): Promise<readonly SellerVisit[]>;
  offersOf(networkId: string, propertyId: string, personId: string): Promise<readonly SellerOffer[]>;
  documentsOf(networkId: string, propertyId: string, personId: string): Promise<readonly SellerDocument[]>;
  appointmentsOf(networkId: string, propertyId: string, personId: string): Promise<readonly SellerAppointment[]>;
  weeklyPointsOf(networkId: string, propertyId: string, personId: string): Promise<readonly SellerWeeklyPoint[]>;
  earliestDeedOf(networkId: string, propertyId: string, personId: string): Promise<SellerDeedDate | null>;
}

/** La liste écrite des champs que le vendeur voit, par rubrique : rien d'autre ne sort [R161]. */
export const CHAMPS_VENDEUR = {
  bien: ['reference', 'city', 'status', 'price'],
  visite: ['at', 'state', 'report', 'interest'],
  offre: ['receivedAt', 'amount', 'netSeller', 'conditions', 'validUntil', 'state'],
  document: ['title', 'kind', 'addedAt', 'signature', 'number'],
  rendezVous: ['at', 'kind', 'state'],
  point: ['weekOf', 'text'],
  acte: ['date', 'holds'],
} as const;

export interface VueVisite {
  at: Fait<string>;
  state: Fait<string>;
  report: Fait<string>;
  interest: Fait<string>;
}

export interface VueOffre {
  receivedAt: Fait<string>;
  amount: Fait<number>;
  netSeller: Fait<number>;
  conditions: Fait<readonly string[]>;
  validUntil: Fait<string>;
  state: Fait<string>;
}

export interface VueDocument {
  title: string;
  kind: string;
  addedAt: Fait<string>;
  /** « signé », « à signer » ou « pas à signer » : le mot, jamais le code. */
  signature: Fait<string>;
  number: Fait<string>;
}

export interface VueRendezVous {
  at: Fait<string>;
  kind: string;
  state: Fait<string>;
}

export interface VuePoint {
  weekOf: Fait<string>;
  text: Fait<string>;
}

export interface VueBienVendeur {
  propertyId: string;
  reference: string;
  city: string;
  status: Fait<string>;
  price: Fait<number>;
  visits: VueVisite[];
  offers: VueOffre[];
  documents: VueDocument[];
  appointments: VueRendezVous[];
  weeklyPoints: VuePoint[];
  deed: { date: Fait<string>; holds: Fait<readonly string[]> };
}

export type VueResult<T> = { ok: true; value: T } | { ok: false; rule: 'R161'; code: 'side' | 'not_party' };

const SOURCES = {
  mandat: 'mandat en vigueur',
  bien: 'fiche du bien',
  agenda: 'agenda du bien',
  compteRendu: 'compte rendu validé par l’agent',
  offres: 'registre des offres',
  dossier: 'dossier de vente',
  point: 'point de la semaine validé par l’agent',
  echeancier: 'échéancier du dossier',
  registre: 'registre des mandats',
} as const;

/** Le libellé qui remplace un intitulé retenu. */
const LIBELLES: Record<string, string> = { title: 'Document', kind: 'Rendez-vous', reference: 'Bien', city: 'non communiquée' };

export const absent = <T>(): Fait<T> => ({ value: null, label: NON_COMMUNIQUE });

/** L'état d'une visite, dit au vendeur en français, jamais le code des sources [R163]. */
export const VISIT_STATE_WORDS: Readonly<Record<SellerVisit['state'], string>> = Object.freeze({ prevue: 'prévue', faite: 'faite', annulee: 'annulée' });
/** Où en est la signature d'un document, en français, jamais le code des sources [R163]. */
export const SIGNATURE_WORDS: Readonly<Record<SellerDocument['signature'], string>> = Object.freeze({ sans: 'pas à signer', a_signer: 'à signer', signe: 'signé' });
/** Le mot français d'un code ; un code que la liste ne connaît pas n'est jamais montré tel quel : il est « non communiqué ». */
export const wordOfCode = (words: Readonly<Record<string, string>>, code: string | null | undefined): string | null =>
  typeof code === 'string' && Object.hasOwn(words, code) ? words[code]! : null;
export const fait = <T>(value: T | null | undefined, source: string, at: string | null | undefined): Fait<T> =>
  value === null || value === undefined || !at ? absent<T>() : { value, source, at };

/** Les mots qui parlent de l'IA à un client : interdits dans l'espace [R06]. */
const IA = /(?:\bi\.\s?a\.|\b(?:ia|intelligences? artificielles?|chatgpt|gpt|robots?|algorithmes?|automatiques?|automatiquement|assistants? virtuels?)\b)/iu;

/** Vrai si le texte parle de l'IA à un client [R06]. */
export function speaksOfAi(text: string): boolean {
  return IA.test(text);
}

const fold = (text: string): string =>
  text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase();

/** Ce qui, dans un texte, désigne une des personnes venues pour le bien : prénom, nom, mail ou téléphone. */
export function citesPerson(text: string, persons: readonly SourcePerson[]): boolean {
  const folded = ` ${fold(text).replace(/[^\p{L}\p{N}@.+]+/gu, ' ')} `;
  const digits = text.replace(/\D/g, '');
  for (const p of persons) {
    for (const name of [p.firstName, p.lastName]) {
      if (!name) continue;
      for (const part of fold(name).split(/[^\p{L}]+/u)) {
        if (part.length >= 2 && folded.includes(` ${part} `)) return true;
      }
    }
    for (const email of p.emails ?? []) if (email && fold(text).includes(fold(email))) return true;
    for (const phone of p.phones ?? []) {
      const d = phone.replace(/\D/g, '');
      const tail = d.slice(-9);
      if (tail.length >= 8 && digits.includes(tail)) return true;
    }
  }
  return false;
}

export class EspaceVendeur {
  private readonly now: () => Date;

  constructor(
    private readonly sources: SourcesVendeur,
    private readonly journal: JournalStore,
    options: { now?: () => Date } = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  /** Tous les biens du vendeur, chacun avec son suivi. */
  async vue(viewer: ClientViewer): Promise<VueResult<VueBienVendeur[]>> {
    if (!viewer.sides.includes('vendeur')) return this.refuse(viewer, 'side');
    const properties = await this.sources.sellerPropertiesOf(viewer.networkId, viewer.personId);
    const views: VueBienVendeur[] = [];
    let retained = 0;
    for (const p of properties) {
      const built = await this.build(viewer, p);
      views.push(built.view);
      retained += built.retained;
    }
    await appendEvent(
      this.journal,
      { type: 'espaces.vue', actor: `client:${viewer.sessionId}`, subject: `person:${viewer.personId}`, data: { rule: 'R161', side: 'vendeur', properties: views.length, retained } },
      this.now,
    );
    return { ok: true, value: views };
  }

  /** Un seul bien : refusé s'il n'est pas un bien du vendeur, sans dire s'il existe [R161]. */
  async bien(viewer: ClientViewer, propertyId: string): Promise<VueResult<VueBienVendeur>> {
    if (!viewer.sides.includes('vendeur')) return this.refuse(viewer, 'side');
    const properties = await this.sources.sellerPropertiesOf(viewer.networkId, viewer.personId);
    const p = properties.find((x) => x.propertyId === propertyId);
    if (!p) return this.refuse(viewer, 'not_party');
    const built = await this.build(viewer, p);
    await appendEvent(
      this.journal,
      { type: 'espaces.vue', actor: `client:${viewer.sessionId}`, subject: `person:${viewer.personId}`, data: { rule: 'R161', side: 'vendeur', property: propertyId, retained: built.retained } },
      this.now,
    );
    return { ok: true, value: built.view };
  }

  private async build(viewer: ClientViewer, p: SellerProperty): Promise<{ view: VueBienVendeur; retained: number }> {
    const n = viewer.networkId;
    const [visits, offers, documents, appointments, points, deed] = await Promise.all([
      this.sources.visitsOf(n, p.propertyId, viewer.personId),
      this.sources.offersOf(n, p.propertyId, viewer.personId),
      this.sources.documentsOf(n, p.propertyId, viewer.personId),
      this.sources.appointmentsOf(n, p.propertyId, viewer.personId),
      this.sources.weeklyPointsOf(n, p.propertyId, viewer.personId),
      this.sources.earliestDeedOf(n, p.propertyId, viewer.personId),
    ]);
    // Toutes les personnes venues pour le bien : aucun texte montré ne doit les citer [R161].
    const persons = [...visits.map((v) => v.visitor), ...offers.map((o) => o.buyer)].filter((x): x is SourcePerson => x !== null && x.personId !== viewer.personId);
    let retained = 0;
    const safeText = (text: string | null | undefined, source: string, at: string | null | undefined): Fait<string> => {
      if (!text || !at) return absent();
      if (citesPerson(text, persons) || IA.test(text)) {
        retained += 1;
        return absent();
      }
      return { value: text, source, at };
    };
    const byDate = <T>(items: readonly T[], date: (x: T) => string) => [...items].sort((a, b) => date(a).localeCompare(date(b)));
    const view: VueBienVendeur = {
      propertyId: p.propertyId,
      reference: p.reference,
      city: p.city,
      status: fait(p.status, SOURCES.bien, p.statusAt),
      price: fait(p.askingPriceEur, SOURCES.mandat, p.mandateSignedAt),
      visits: byDate(visits, (v) => v.at).map((v) => ({
        at: fait(v.at, SOURCES.agenda, v.at),
        state: fait(wordOfCode(VISIT_STATE_WORDS, v.state), SOURCES.agenda, v.at),
        report: v.report ? safeText(v.report.text, SOURCES.compteRendu, v.report.validatedAt) : absent(),
        interest: v.report ? safeText(v.report.interest, SOURCES.compteRendu, v.report.validatedAt) : absent(),
      })),
      // Dans l'ordre d'arrivée, sans tri ni note [R14, R57].
      offers: byDate(offers, (o) => o.receivedAt).map((o) => ({
        receivedAt: fait(o.receivedAt, SOURCES.offres, o.receivedAt),
        amount: fait(o.amountEur, SOURCES.offres, o.receivedAt),
        netSeller: fait(o.netSellerEur, SOURCES.mandat, o.receivedAt),
        conditions: fait([...o.conditions], SOURCES.offres, o.receivedAt),
        validUntil: fait(o.validUntil, SOURCES.offres, o.receivedAt),
        state: fait(o.state, SOURCES.offres, o.stateAt),
      })),
      documents: byDate(documents, (d) => d.addedAt).map((d) => ({
        title: d.title,
        kind: d.kind,
        addedAt: fait(d.addedAt, SOURCES.dossier, d.addedAt),
        signature: fait(wordOfCode(SIGNATURE_WORDS, d.signature), SOURCES.dossier, d.signature === 'signe' ? d.signedAt : d.addedAt),
        number: fait(d.number ?? null, SOURCES.registre, d.signedAt),
      })),
      appointments: byDate(appointments, (a) => a.at).map((a) => ({ at: fait(a.at, SOURCES.agenda, a.at), kind: a.kind, state: fait(a.state, SOURCES.agenda, a.at) })),
      weeklyPoints: byDate(points, (w) => w.weekOf)
        .reverse()
        .slice(0, 4)
        .map((w) => ({ weekOf: fait(w.weekOf, SOURCES.point, w.validatedAt), text: w.validatedAt ? safeText(w.text, SOURCES.point, w.validatedAt) : absent() })),
      deed: deed
        ? { date: fait(deed.date, SOURCES.echeancier, deed.computedAt), holds: fait(deed.holds.map((h) => h.label), SOURCES.echeancier, deed.computedAt) }
        : { date: absent(), holds: absent() },
    };
    // Tout ce qui reste de texte dans la vue passe la même retenue, champ par champ : un texte qui cite une personne
    // venue pour le bien ou parle de l'IA est retenu [R161, R06].
    const bad = (t: string): boolean => citesPerson(t, persons) || IA.test(t);
    const scrub = (x: unknown): unknown => {
      if (Array.isArray(x)) {
        return x.map((e) => {
          if (typeof e === 'string' && bad(e)) {
            retained += 1;
            return NON_COMMUNIQUE;
          }
          return scrub(e);
        });
      }
      if (!x || typeof x !== 'object') return x;
      const o = x as Record<string, unknown>;
      if ('value' in o && ('source' in o || 'label' in o)) {
        const v = o.value;
        if ((typeof v === 'string' && bad(v)) || (Array.isArray(v) && v.some((e) => typeof e === 'string' && bad(e)))) {
          retained += 1;
          return absent();
        }
        return o;
      }
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(o)) {
        if (typeof v === 'string' && k !== 'propertyId' && bad(v)) {
          retained += 1;
          out[k] = LIBELLES[k] ?? 'non communiqué';
        } else out[k] = scrub(v);
      }
      return out;
    };
    const clean = scrub(view) as VueBienVendeur;
    return { view: clean, retained };
  }

  private async refuse(viewer: ClientViewer, code: 'side' | 'not_party'): Promise<{ ok: false; rule: 'R161'; code: 'side' | 'not_party' }> {
    await appendEvent(
      this.journal,
      { type: 'espaces.vue', actor: `client:${viewer.sessionId}`, subject: `person:${viewer.personId}`, data: { rule: 'R161', side: 'vendeur', status: 'refuse', code } },
      this.now,
    );
    return { ok: false, rule: 'R161', code };
  }
}
