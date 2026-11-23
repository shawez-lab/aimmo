/**
 * Les gestes du client branchés sur les modules qui les tiennent (EC10) [R165, R161, R49, R03, R26, R13].
 *
 * Décidé, lecture prudente :
 * - l'espace a déjà vérifié que le bien est proposé au client ou que le dossier est le sien ; ce port ne refait aucun
 *   contrôle métier : il appelle la route du module, avec ses propres refus, et rend ce refus tel quel [R165] ;
 * - les modules qui demandent un lecteur reçoivent la direction sous le nom `system:espace` (comme les lecteurs de
 *   EC08), jamais un agent : rien n'est écrit au nom d'un agent qui n'a rien fait. Le financement, que M10 ne laisse
 *   écrire qu'à l'agent du dossier, passe par `declareByBuyer`, qui écrit l'auteur tel qu'il est (`client:<séance>`) ;
 * - ce que le client envoie ne choisit jamais qui il est : l'acquéreur d'une offre est sa fiche, l'heure de réception
 *   celle du serveur, le déclarant du financement « acquéreur » ; un champ inconnu est refusé, jamais ignoré [R14] ;
 * - une offre se fait sur le document signé déposé dans le stockage des offres : une référence absente du stockage est
 *   refusée avant M09 ;
 * - la visite est fixée par M05 (bon de visite R40, bien diffusable R42, créneau libre de l'agent qui suit le client)
 *   sans canal de confirmation : rien ne part [R26] ; l'espace la montre ; le rendez-vous porte la source `espace` et la
 *   visite son auteur `client:<séance>` ;
 * - demander les alertes range l'accord « alertes de biens » du client, par mail (l'adresse par laquelle il entre),
 *   avec sa preuve ; rien ne part ici : M08 enverra plus tard par le contrôle central, avec la désinscription [R49, R03] ;
 * - la réponse ne rend que ce que le client doit voir de son geste : jamais le bon de visite d'un autre, l'agent, ni
 *   l'empreinte du registre [R161] ; une panne d'un module est écrite au journal et rendue « indisponible », jamais
 *   avalée ; le journal ne porte que des codes [R13].
 */
import type { SqlDatabase } from '../db/sql.ts';
import type { NewConsent } from '../db/fiche-client.ts';
import { ALERT_PURPOSE } from '../acquereurs/alertes.ts';
import type { FinancementDossier } from '../dossiers/financement.ts';
import type { FicheUnique } from '../fiche/fusion.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import type { RegistreOffres } from '../offres/registre-offres.ts';
import type { Visites } from '../visites/visites.ts';
import type { GesteResult, GestesAcquereur } from './acquereur.ts';
import type { ClientViewer } from './entree.ts';
import { espaceViewer } from './sources-vendeur.ts';

/** Le stockage des offres signées : il dit seulement s'il tient une référence. */
export interface SignedOfferStore {
  has(ref: string): Promise<boolean>;
}

export interface GestesModulesDeps {
  db: SqlDatabase;
  journal: JournalStore;
  fiche: Pick<FicheUnique, 'membersOf' | 'rootOf' | 'hasConsentInForce'>;
  consents: { addConsent(input: NewConsent): Promise<unknown> };
  visites: Pick<Visites, 'schedule'>;
  offres: Pick<RegistreOffres, 'record'>;
  financement: Pick<FinancementDossier, 'declareByBuyer'>;
  signedOffers: SignedOfferStore;
}

const VISIT_FIELDS = ['start', 'projectId'] as const;
const OFFER_FIELDS = ['amountEur', 'conditions', 'validUntil', 'downPaymentEur', 'loanEur', 'signedRef', 'requestKey'] as const;
const ALERT_FIELDS = ['accepted'] as const;
/** Une heure complète, avec son fuseau : jamais lue selon le fuseau du serveur. */
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;

type Refus = { ok: false; rule: string | null; code: string; field?: string };

const refus = (rule: string | null, code: string, field?: string): Refus => ({ ok: false, rule, code, ...(field ? { field } : {}) });

/** Vrai si l'objet ne porte que des champs permis. */
function only(input: Record<string, unknown>, allowed: readonly string[]): string | null {
  return Object.keys(input).find((k) => !allowed.includes(k)) ?? null;
}

export class GestesModules implements GestesAcquereur {
  private readonly now: () => Date;

  constructor(
    private readonly deps: GestesModulesDeps,
    options: { now?: () => Date } = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  /** Réserver une visite : par M05, son bon de visite et ses refus [R165, R40, R42]. */
  async bookVisit(client: ClientViewer, propertyId: string, input: Record<string, unknown>): Promise<GesteResult> {
    return this.guard(client, 'visite', async () => {
      const extra = only(input, VISIT_FIELDS);
      if (extra) return refus(null, 'invalid', extra);
      if (typeof input.start !== 'string' || !INSTANT.test(input.start) || !Number.isFinite(Date.parse(input.start))) return refus(null, 'invalid', 'start');
      // Le projet d'achat du client, pris dans ses fiches réunies ; jamais celui d'un autre.
      const members = await this.deps.fiche.membersOf(client.personId);
      const q = members.map(() => '?').join(', ');
      const projects = await this.deps.db.all<{ id: string }>(
        `SELECT id FROM projects WHERE network_id = ? AND kind = 'buy' AND person_id IN (${q}) ORDER BY created_at, id`,
        [client.networkId, ...members],
      );
      let projectId: string;
      if (input.projectId !== undefined) {
        if (typeof input.projectId !== 'string' || !projects.some((p) => p.id === input.projectId)) return refus('R161', 'not_party', 'projectId');
        projectId = input.projectId;
      } else if (projects.length === 1) projectId = projects[0]!.id;
      else return refus(null, projects.length === 0 ? 'no_project' : 'project_required', 'projectId');
      const r = await this.deps.visites.schedule(espaceViewer(client.networkId), { propertyId, projectId, start: new Date(input.start), channel: null, byClient: `client:${client.sessionId}` });
      if (!r.ok) return refus(r.rule, r.code);
      return { ok: true, value: { appointmentId: r.visit.appointment.id, start: r.visit.appointment.start_at, end: r.visit.appointment.end_at } };
    });
  }

  /** Écrire une offre : par le registre de M09, sur l'offre signée déposée [R165, R42, R56]. */
  async writeOffer(client: ClientViewer, propertyId: string, input: Record<string, unknown>): Promise<GesteResult> {
    return this.guard(client, 'offre', async () => {
      const extra = only(input, OFFER_FIELDS);
      if (extra) return refus(null, 'invalid', extra);
      if (typeof input.signedRef !== 'string' || !(await this.deps.signedOffers.has(input.signedRef))) return refus(null, 'not_stored', 'signedRef');
      const buyerPersonId = await this.deps.fiche.rootOf(client.personId);
      // Un renvoi de la même offre avec sa clé (réponse perdue) garde l'heure de réception de la première : M09 la
      // reconnaît et la rend telle qu'enregistrée, au lieu de la refuser comme une clé réutilisée [R56].
      let receivedAt = this.now().toISOString();
      if (typeof input.requestKey === 'string') {
        const known = await this.deps.db.first<{ received_at: string; buyer_person_id: string }>('SELECT received_at, buyer_person_id FROM offer_register WHERE property_id = ? AND request_key = ?', [propertyId, input.requestKey]);
        if (known && known.buyer_person_id === buyerPersonId) receivedAt = known.received_at;
      }
      const r = await this.deps.offres.record(espaceViewer(client.networkId), propertyId, {
        buyerPersonId,
        amountEur: input.amountEur,
        conditions: input.conditions,
        validUntil: input.validUntil,
        downPaymentEur: input.downPaymentEur,
        loanEur: input.loanEur,
        signedRef: input.signedRef,
        receivedAt,
        ...(input.requestKey !== undefined ? { requestKey: input.requestKey } : {}),
      });
      if (!r.ok) return refus(r.rule, r.code, 'field' in r && typeof r.field === 'string' ? r.field : undefined);
      const o = r.value;
      return { ok: true, value: { seq: o.seq, receivedAt: o.receivedAt, amountEur: o.amountEur, validUntil: o.validUntil } };
    });
  }

  /** Ranger une étape de son financement : par M10, déclarée par l'acquéreur [R165, R14]. */
  async addFinancingPiece(client: ClientViewer, fileId: string, input: Record<string, unknown>): Promise<GesteResult> {
    return this.guard(client, 'piece', async () => {
      const members = await this.deps.fiche.membersOf(client.personId);
      const r = await this.deps.financement.declareByBuyer(client.networkId, members, fileId, input, `client:${client.sessionId}`);
      if (!r.ok) return refus(r.rule, r.code);
      return { ok: true, value: { steps: r.value.steps.map((s) => ({ step: s.step, day: s.day, declaredBy: s.declaredBy })) } };
    });
  }

  /** Demander les alertes de biens : l'accord rangé avec sa preuve, rien ne part ici [R49, R03, R26]. */
  async requestAlerts(client: ClientViewer, input: Record<string, unknown>): Promise<GesteResult> {
    return this.guard(client, 'alertes', async () => {
      const extra = only(input, ALERT_FIELDS);
      if (extra) return refus(null, 'invalid', extra);
      // La demande est un geste exprès du client : sans case cochée, aucun accord.
      if (input.accepted !== true) return refus('R03', 'not_accepted', 'accepted');
      const members = await this.deps.fiche.membersOf(client.personId);
      const q = members.map(() => '?').join(', ');
      const at = this.now();
      const iso = at.toISOString();
      const active = await this.deps.fiche.hasConsentInForce(client.personId, ALERT_PURPOSE, 'email');
      if (!active) {
        const email = await this.deps.db.first(`SELECT 1 FROM person_identifiers WHERE network_id = ? AND kind = 'email' AND person_id IN (${q}) LIMIT 1`, [client.networkId, ...members]);
        if (!email) return refus('R03', 'no_email');
        await this.deps.consents.addConsent({
          networkId: client.networkId,
          personId: await this.deps.fiche.rootOf(client.personId),
          purpose: ALERT_PURPOSE,
          channel: 'email',
          proof: `demande faite dans l'espace client (séance ${client.sessionId}) le ${iso}`,
          givenAt: at,
        });
      }
      return { ok: true, value: { requested: true } };
    });
  }

  /** Une panne d'un module : écrite au journal, en codes, et rendue « indisponible », jamais avalée. */
  private async guard(client: ClientViewer, kind: string, run: () => Promise<GesteResult>): Promise<GesteResult> {
    try {
      return await run();
    } catch (error) {
      await appendEvent(
        this.deps.journal,
        { type: 'espaces.geste_panne', actor: `client:${client.sessionId}`, subject: `person:${client.personId}`, data: { rule: 'R165', kind, error: error instanceof Error ? error.name : 'unknown' } },
        this.now,
      );
      // AU053 : l'agenda relié de l'agent injoignable : rien n'est réservé, et le client le sait [R702].
      if (error instanceof Error && error.name === 'AgendaUnavailableError') return refus('R702', 'agenda_indisponible');
      return refus(null, 'indisponible');
    }
  }
}
