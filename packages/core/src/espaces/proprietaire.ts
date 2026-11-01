/**
 * L'espace du propriétaire : location, valeur suivie et documents rangés (EC03) [R161, R162, R163, R31, R14, R06, R13].
 *
 * Décidé, lecture prudente :
 * - la vue du bailleur lit, par l'interface `SourcesProprietaire`, ce que M15 a rangé : chaque mise en location du
 *   propriétaire, ses candidatures telles que W05 les présente (rang d'arrivée, complétude, pièces et garants, sans le
 *   nom du candidat), le bail et l'état des lieux ;
 * - les candidatures sont montrées dans l'ordre d'arrivée, et seulement là : aucune note, tri, avis ni classement venu
 *   des sources n'en sort [R162, R14] ; une pièce qui n'est pas de la liste officielle (W04) n'est jamais montrée, même
 *   si une source la rend [R162, R104] ;
 * - la valeur suivie (G04) n'est montrée que si le propriétaire a demandé le suivi et qu'il est en cours : c'est la
 *   fourchette de sa commune, avec sa date et ses sources, jamais un prix de son bien [R31, R163] ;
 * - ses documents sont rangés au même endroit, par bien, dans l'ordre des dates ;
 * - même retenue que pour le vendeur : un texte qui cite une personne venue pour le bien (candidat, garant) ou parle de
 *   l'IA est « non communiqué » [R161, R06] ; chaque lecture va au journal, en nombres [R13].
 */
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import { OFFICIAL_PIECES } from '../location/candidatures.ts';
import type { ClientViewer } from './entree.ts';
import { NON_COMMUNIQUE, citesPerson, speaksOfAi, type Fait, type SourcePerson } from './vendeur.ts';

export interface OwnerProperty {
  propertyId: string;
  reference: string;
  city: string;
}

export interface OwnerRental {
  rentalId: string;
  propertyId: string;
  openedAt: string;
  state: string;
  stateAt: string;
}

export interface OwnerApplication {
  id: string;
  receivedAt: string;
  complete: boolean;
  /** Les pièces par leur sorte de la liste officielle (W04), pour le candidat et chaque garant. */
  pieces: readonly { holder: 'candidat' | 'caution'; kind: string }[];
  guarantors: number;
  /** Ce qu'une source pourrait rendre en plus : jamais montré [R162]. */
  score?: unknown;
  /** Ce qui identifie le candidat et ses garants : lu seulement pour être retenu [R161]. */
  persons: readonly SourcePerson[];
}

export interface OwnerLease {
  signedAt: string | null;
  startsOn: string | null;
  rentEur: number | null;
  chargesEur: number | null;
}

export interface OwnerInspection {
  kind: 'entree' | 'sortie';
  signedAt: string | null;
}

export interface OwnerValue {
  /** Le suivi demandé, avec son accord en cours (G04) ; sinon, aucune valeur n'est montrée. */
  tracking: boolean;
  city: string;
  lowEur: number;
  highEur: number;
  computedAt: string;
  sources: readonly string[];
}

export interface OwnerDocument {
  id: string;
  propertyId: string;
  title: string;
  kind: string;
  addedAt: string;
}

/** Les sources de l'espace du propriétaire. Fausses dans les tests ; lecteurs SQL en EC06. */
export interface SourcesProprietaire {
  ownerPropertiesOf(networkId: string, personId: string): Promise<readonly OwnerProperty[]>;
  /** Les mises en location du bien qui sont à la personne, dans sa période de propriétaire [R161]. */
  rentalsOf(networkId: string, propertyId: string, personId: string): Promise<readonly OwnerRental[]>;
  applicationsOf(networkId: string, rentalId: string): Promise<readonly OwnerApplication[]>;
  leaseOf(networkId: string, rentalId: string): Promise<OwnerLease | null>;
  inspectionsOf(networkId: string, rentalId: string): Promise<readonly OwnerInspection[]>;
  valueOf(networkId: string, personId: string, propertyId: string): Promise<OwnerValue | null>;
  documentsOf(networkId: string, personId: string, propertyId: string): Promise<readonly OwnerDocument[]>;
}

/** La liste écrite des champs que le propriétaire voit, par rubrique [R161, R162]. */
export const CHAMPS_PROPRIETAIRE = {
  candidature: ['rank', 'receivedAt', 'complete', 'pieces', 'guarantors'],
  location: ['openedAt', 'state', 'waiting', 'applications', 'lease', 'inspections'],
  bail: ['signedAt', 'startsOn', 'rent', 'charges'],
  valeur: ['city', 'range', 'sources'],
  document: ['title', 'kind', 'addedAt'],
} as const;

export interface VueCandidature {
  /** Le rang d'arrivée, et rien d'autre : pas de note, pas de tri [R162]. */
  rank: number;
  receivedAt: Fait<string>;
  complete: Fait<boolean>;
  pieces: { holder: 'candidat'; label: string }[];
  guarantors: number;
}

export interface VueLocation {
  openedAt: Fait<string>;
  state: Fait<string>;
  /** Le nombre de dossiers encore incomplets, sans rien d'eux [R162]. */
  waiting: number;
  applications: VueCandidature[];
  lease: { signedAt: Fait<string>; startsOn: Fait<string>; rent: Fait<number>; charges: Fait<number> };
  inspections: { kind: 'entree' | 'sortie'; signedAt: Fait<string> }[];
}

export interface VueBienProprietaire {
  propertyId: string;
  reference: string;
  city: string;
  rentals: VueLocation[];
  value: { city: string; range: Fait<{ lowEur: number; highEur: number }>; sources: readonly string[] } | null;
  documents: { title: string; kind: string; addedAt: Fait<string> }[];
}

export type VueProprietaireResult<T> = { ok: true; value: T } | { ok: false; rule: 'R161'; code: 'side' | 'not_party' };

const SOURCES = {
  location: 'mise en location',
  candidature: 'dossier de candidature',
  bail: 'bail signé',
  etatDesLieux: 'état des lieux',
  valeur: 'suivi de valeur de la commune',
  documents: 'documents du bien',
} as const;

const absent = <T>(): Fait<T> => ({ value: null, label: NON_COMMUNIQUE });
const fait = <T>(value: T | null | undefined, source: string, at: string | null | undefined): Fait<T> =>
  value === null || value === undefined || !at ? absent<T>() : { value, source, at };

export class EspaceProprietaire {
  private readonly now: () => Date;

  constructor(
    private readonly sources: SourcesProprietaire,
    private readonly journal: JournalStore,
    options: { now?: () => Date } = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  /** Tous les biens du propriétaire. Vendeur ou bailleur, il est propriétaire. */
  async vue(viewer: ClientViewer): Promise<VueProprietaireResult<VueBienProprietaire[]>> {
    if (!this.isOwner(viewer)) return this.refuse(viewer, 'side');
    const properties = await this.sources.ownerPropertiesOf(viewer.networkId, viewer.personId);
    const views: VueBienProprietaire[] = [];
    let retained = 0;
    for (const p of properties) {
      const built = await this.build(viewer, p);
      views.push(built.view);
      retained += built.retained;
    }
    await this.log(viewer, { properties: views.length, retained });
    return { ok: true, value: views };
  }

  /** Un seul bien : refusé s'il n'est pas au propriétaire, sans dire s'il existe [R161]. */
  async bien(viewer: ClientViewer, propertyId: string): Promise<VueProprietaireResult<VueBienProprietaire>> {
    if (!this.isOwner(viewer)) return this.refuse(viewer, 'side');
    const p = (await this.sources.ownerPropertiesOf(viewer.networkId, viewer.personId)).find((x) => x.propertyId === propertyId);
    if (!p) return this.refuse(viewer, 'not_party');
    const built = await this.build(viewer, p);
    await this.log(viewer, { property: propertyId, retained: built.retained });
    return { ok: true, value: built.view };
  }

  private isOwner(viewer: ClientViewer): boolean {
    return viewer.sides.some((s) => s === 'proprietaire' || s === 'bailleur' || s === 'vendeur');
  }

  private async build(viewer: ClientViewer, p: OwnerProperty): Promise<{ view: VueBienProprietaire; retained: number }> {
    const n = viewer.networkId;
    const persons: SourcePerson[] = [];
    const rentals: VueLocation[] = [];
    const rentalRows = [...(await this.sources.rentalsOf(n, p.propertyId, viewer.personId))].filter((r) => r.propertyId === p.propertyId).sort((a, b) => a.openedAt.localeCompare(b.openedAt));
    for (const r of rentalRows) {
      const [apps, lease, inspections] = await Promise.all([this.sources.applicationsOf(n, r.rentalId), this.sources.leaseOf(n, r.rentalId), this.sources.inspectionsOf(n, r.rentalId)]);
      for (const a of apps) persons.push(...a.persons.filter((x) => x.personId !== viewer.personId));
      rentals.push({
        openedAt: fait(r.openedAt, SOURCES.location, r.openedAt),
        state: fait(r.state, SOURCES.location, r.stateAt),
        // L'ordre d'arrivée, et le rang qui en vient : jamais l'ordre des sources ni une note [R162].
        // Seuls les dossiers complets sont présentés, comme en W05 ; les autres ne sont qu'un nombre [R162, R105].
        waiting: apps.filter((a) => a.complete !== true).length,
        applications: apps
          .filter((a) => a.complete === true)
          .sort((a, b) => a.receivedAt.localeCompare(b.receivedAt) || a.id.localeCompare(b.id))
          .map((a, i) => ({
            rank: i + 1,
            receivedAt: fait(a.receivedAt, SOURCES.candidature, a.receivedAt),
            complete: fait(a.complete, SOURCES.candidature, a.receivedAt),
            // Seules les pièces du candidat de la liste officielle, comme en W05 : celles des garants ne sont pas
            // présentées au propriétaire [R162, R104].
            pieces: a.pieces.flatMap((x) => {
              const official = x.holder === 'candidat' && Object.hasOwn(OFFICIAL_PIECES, x.kind) ? OFFICIAL_PIECES[x.kind] : undefined;
              return official && official.holders.includes('candidat') ? [{ holder: 'candidat' as const, label: official.label }] : [];
            }),
            guarantors: Number.isInteger(a.guarantors) && a.guarantors >= 0 ? a.guarantors : 0,
          })),
        lease: lease
          ? {
              signedAt: fait(lease.signedAt, SOURCES.bail, lease.signedAt),
              startsOn: fait(lease.startsOn, SOURCES.bail, lease.signedAt),
              rent: fait(lease.rentEur, SOURCES.bail, lease.signedAt),
              charges: fait(lease.chargesEur, SOURCES.bail, lease.signedAt),
            }
          : { signedAt: absent(), startsOn: absent(), rent: absent(), charges: absent() },
        inspections: inspections.map((x) => ({ kind: x.kind, signedAt: fait(x.signedAt, SOURCES.etatDesLieux, x.signedAt) })),
      });
    }
    const value = await this.sources.valueOf(n, viewer.personId, p.propertyId);
    const shownValue =
      // La fourchette de la commune du bien, et elle seule, avec au moins une source [R31, R163].
      value && value.tracking && value.city === p.city && value.sources.length > 0 && value.sources.every((x) => typeof x === 'string' && x.trim() !== '') && Number.isFinite(value.lowEur) && Number.isFinite(value.highEur) && value.lowEur > 0 && value.lowEur <= value.highEur && value.computedAt
        ? { city: value.city, range: { value: { lowEur: value.lowEur, highEur: value.highEur }, source: SOURCES.valeur, at: value.computedAt }, sources: [...value.sources] }
        : null;
    const documents = [...(await this.sources.documentsOf(n, viewer.personId, p.propertyId))]
      .filter((d) => d.propertyId === p.propertyId)
      .sort((a, b) => a.addedAt.localeCompare(b.addedAt))
      .map((d) => ({ title: d.title, kind: d.kind, addedAt: fait(d.addedAt, SOURCES.documents, d.addedAt) }));
    const view: VueBienProprietaire = { propertyId: p.propertyId, reference: p.reference, city: p.city, rentals, value: shownValue, documents };
    return retain(view, persons);
  }

  private async log(viewer: ClientViewer, data: Record<string, unknown>): Promise<void> {
    await appendEvent(this.journal, { type: 'espaces.vue', actor: `client:${viewer.sessionId}`, subject: `person:${viewer.personId}`, data: { rule: 'R161', side: 'proprietaire', ...data } }, this.now);
  }

  private async refuse(viewer: ClientViewer, code: 'side' | 'not_party'): Promise<{ ok: false; rule: 'R161'; code: 'side' | 'not_party' }> {
    await this.log(viewer, { status: 'refuse', code });
    return { ok: false, rule: 'R161', code };
  }
}

const LIBELLES: Record<string, string> = { title: 'Document', kind: 'Document', reference: 'Bien', city: 'non communiquée' };

/** La retenue, champ par champ, sur tout texte de la vue [R161, R06]. */
export function retain<T>(view: T, persons: readonly SourcePerson[]): { view: T; retained: number } {
  let retained = 0;
  const bad = (t: string): boolean => citesPerson(t, persons) || speaksOfAi(t);
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
      if (typeof v === 'string' && k !== 'propertyId' && k !== 'holder' && bad(v)) {
        retained += 1;
        out[k] = LIBELLES[k] ?? NON_COMMUNIQUE;
      } else out[k] = scrub(v);
    }
    return out;
  };
  return { view: scrub(view) as T, retained };
}
