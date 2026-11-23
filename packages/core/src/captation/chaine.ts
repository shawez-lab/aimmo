/**
 * La chaîne de captation, de bout en bout (C06) : notification brute reçue → rangée une seule fois (C01, R18)
 * → rattachée à sa fiche (C02) → bien reconnu et réponse composée (C03, C04) → relais à l'agent (C05) → contrôle
 * central (S06) → canal. En mode essai, le canal est la boîte d'essai : rien ne part.
 */
import { Acces } from '../acces/acces.ts';
import { AnnoncesTraduites } from '../annonces/traductions.ts';
import { ReconnaissanceBien } from '../biens/reconnaissance.ts';
import { FicheClient } from '../db/fiche-client.ts';
import type { SqlDatabase } from '../db/sql.ts';
import type { OutboundChannel } from '../envoi/canaux.ts';
import { ControleEnvois, type AiBudget } from '../envoi/controle.ts';
import { SqlSendJournal } from '../envoi/journal-envois.ts';
import { DecisionEnvoi } from '../envoi/service.ts';
import { FicheUnique } from '../fiche/fusion.ts';
import type { JournalStore } from '../journal/types.ts';
import { adaptInbound, type InboundSource } from '../reception/adaptateurs.ts';
import type { AdaptContext } from '../reception/entrant.ts';
import { Rattachement } from '../reception/rattachement.ts';
import { Reception } from '../reception/reception.ts';
import { trialChannels } from './essai.ts';
import { PaliersCanaux } from './paliers-canaux.ts';
import { PremiereReponse, type ReplyWriter } from './premiere-reponse.ts';
import { ConversationRelais, type RelayOutcome } from './relais.ts';
import { appendEvent } from '../journal/journal.ts';
import { Attribution } from '../qualification/attribution.ts';
import { Diffusion } from '../documents/retractation.ts';
import { Qualification, type Qualifier } from '../qualification/qualification.ts';
import { Rappels } from '../qualification/rappel.ts';
import { FicheAcquereur } from '../acquereurs/fiche-acquereur.ts';
import { BouclierFonds } from '../dossiers/bouclier.ts';
import { OrigineContacts, type OriginSignals } from '../attirer/origine-contacts.ts';
import { recordAdArrival } from '../marketing/publicite.ts';

export type ChainStatus =
  /** Le même message, déjà reçu : rien de plus [R18]. */
  | 'duplicate'
  /** Illisible : rangé et signalé à l'agent, jamais jeté. */
  | 'unreadable'
  /** Déjà pris par un autre traitement [R18]. */
  | 'taken'
  /** Personne exclue ou qui a dit stop : rien ne lui répond [R02, R04]. */
  | 'silenced'
  | RelayOutcome['status'];

export interface ChainResult {
  inboundId: string;
  status: ChainStatus;
  /** Le message prêt (en essai) ou parti, s'il y en a un. */
  messageId: string | null;
  /** Temps entre la réception et la réponse prête, en millisecondes. */
  elapsedMs: number;
}

export interface ChainHooks {
  /** Appelé après le rattachement de chaque message, avant sa réponse. */
  beforeReply?: () => Promise<void>;
  /**
   * Le lien d'arrivée et la page de départ transmis par la page de captation (AT10) : lus pour l'origine du contact,
   * jamais gardés [R156]. Absents (mail, Meta) : l'origine se lit dans le message lui-même (publication, portail).
   */
  origin?: OriginSignals;
}

/** Range l'origine d'un message reçu (AT05, AT10). Ne lève jamais d'erreur, ne retarde aucune réponse. */
export interface OriginRecorder {
  (networkId: string, inboundId: string, signals: OriginSignals): Promise<void>;
}

/** Ce qui suit la réponse : qualifier, noter, attribuer, créer la tâche (M03). Ne doit jamais retarder la réponse. */
export interface AfterReply {
  (inboundId: string): Promise<void>;
}

export class ChaineCaptation {
  constructor(
    private readonly reception: Reception,
    private readonly rattachement: Rattachement,
    private readonly relais: ConversationRelais,
    private readonly now: () => Date = () => new Date(),
    private readonly afterReply: AfterReply | null = null,
    private readonly recordOrigin: OriginRecorder | null = null,
  ) {}

  async receive(
    networkId: string,
    source: InboundSource,
    raw: unknown,
    ctx: Partial<AdaptContext> = {},
    hooks: ChainHooks = {},
  ): Promise<ChainResult[]> {
    const started = this.now().getTime();
    const adapted = adaptInbound(source, raw, { now: ctx.now ?? this.now(), ...(ctx.ownIds ? { ownIds: ctx.ownIds } : {}) });
    // Un mail ou un formulaire est « reçu » quand AIMMO le reçoit [R01] : la date qu'il porte vient de l'horloge de
    // l'expéditeur ou d'une file d'attente, en avance ou en retard ; elle ne doit pas priver la personne de sa réponse.
    if (source === 'email' || source === 'site_form') {
      const at = new Date(started);
      adapted.messages = adapted.messages.map((m) => ({ ...m, receivedAt: at }));
    }
    const ingested = await this.reception.store(networkId, adapted);
    const results: ChainResult[] = [];
    const toQualify: string[] = [];
    for (const item of ingested.received) {
      const done = (status: ChainStatus, messageId: string | null = null): ChainResult => ({
        inboundId: item.inboundId,
        status,
        messageId,
        elapsedMs: this.now().getTime() - started,
      });
      if (item.outcome === 'unreadable') {
        results.push(done('unreadable'));
        continue;
      }
      if (!item.toProcess) {
        // Déjà reçu. Un rattachement abandonné (Worker coupé) est d'abord rendu, puis repris ; un message rattaché
        // dont la réponse n'a pas abouti voit sa réponse reprise. Les réservations empêchent tout doublon [R18].
        let row = await this.reception.get(item.inboundId);
        if (row?.status === 'processing') {
          await this.rattachement.reclaimStale(networkId);
          row = await this.reception.get(item.inboundId);
        }
        if (row?.status !== 'received') {
          if (row?.status !== 'processed' || row.person_id === null) {
            results.push(done('duplicate'));
            continue;
          }
          // La reprise passe par le même point que la première fois : rien ne répond avant lui [R21].
          if (hooks.beforeReply) await hooks.beforeReply();
          const resumed = await this.relais.process(item.inboundId);
          if (resumed.status === 'skipped' || resumed.status === 'silent') {
            // Une qualification interrompue est reprise, sans doublon [R18].
            toQualify.push(item.inboundId);
            results.push(done('duplicate'));
            continue;
          }
          results.push(done(resumed.status, resumed.status === 'replied' ? (resumed.reply.result?.messageId ?? null) : null));
          toQualify.push(item.inboundId);
          continue;
        }
      }
      const attached = await this.rattachement.attach(item.inboundId);
      if (attached.outcome === null) {
        results.push(done('taken'));
        continue;
      }
      if (attached.silenced) {
        results.push(done('silenced'));
        continue;
      }
      // Le message est rangé dans sa fiche : ce qui attendait sa conversation (un écho humain du même lot) passe
      // avant la réponse [R21].
      if (hooks.beforeReply) await hooks.beforeReply();
      const relayed = await this.relais.process(item.inboundId);
      const messageId = relayed.status === 'replied' ? (relayed.reply.result?.messageId ?? null) : null;
      results.push(done(relayed.status, messageId));
      toQualify.push(item.inboundId);
    }
    // Toutes les réponses du lot sont prêtes : l'origine de chaque message lisible est rangée, une seule fois (la
    // première lecture compte), même pour un doublon dont la première lecture avait échoué [R156] ; puis la
    // qualification suit. Ni l'une ni l'autre ne retarde une réponse ni ne lève d'erreur (voir createCaptation).
    if (this.recordOrigin) {
      for (const item of ingested.received) {
        if (item.outcome === 'unreadable') continue;
        // Un illisible reçu une seconde fois revient en doublon : sa ligne dit qu'il est illisible, il n'a pas d'origine.
        if (item.outcome === 'duplicate' && (await this.reception.get(item.inboundId))?.kind === 'unreadable') continue;
        await this.recordOrigin(networkId, item.inboundId, hooks.origin ?? {});
      }
    }
    if (this.afterReply) for (const inboundId of toQualify) await this.afterReply(inboundId);
    return results;
  }
}

export interface CaptationOptions {
  now?: () => Date;
  /** Tous les messages à ces canaux, sans palier (bac à sable et tests d'une étape). Absents : les paliers ci-dessous. */
  channels?: readonly OutboundChannel[];
  /** Les vrais canaux, derrière leur palier [R26]. Absents : tout reste dans la boîte d'essai, à tout palier. */
  realChannels?: readonly OutboundChannel[];
  writer?: ReplyWriter;
  budget?: AiBudget;
  /** L'IA qui classe et extrait (M03) ; absente : règles fixes. */
  qualifier?: Qualifier;
  /** Faux : la chaîne s'arrête à la réponse, sans qualifier (pour éprouver chaque étape à part). Vrai par défaut. */
  withQualification?: boolean;
  /** Faux : l'origine des contacts n'est pas rangée (pour éprouver chaque étape à part). Vrai par défaut. */
  withOrigin?: boolean;
}

/** Assemble toute la chaîne sur une base. Sans canaux fournis, elle tourne en mode essai. */
export function createCaptation(db: SqlDatabase, journal: JournalStore, options: CaptationOptions = {}) {
  const now = options.now ?? (() => new Date());
  const store = new FicheClient(db, { now });
  const fiche = new FicheUnique(db, store, { now });
  const decisions = new DecisionEnvoi(db, store, fiche, { now });
  const reception = new Reception(db, undefined, now);
  // Le bouclier contre le faux RIB (N05) lit chaque message reçu dès qu'il est rangé dans sa fiche ; une panne va au
  // journal, sans texte [R13], et le filet du passage des dossiers le relira.
  let bouclier: BouclierFonds | null = null;
  const afterAttach = async (messageId: string): Promise<void> => {
    try {
      bouclier ??= new BouclierFonds(db, new Acces(db, store, fiche, journal, { now }), journal, { now });
      await bouclier.scan(messageId);
    } catch (error) {
      try {
        await appendEvent(journal, { type: 'dossier.bouclier_erreur', actor: 'system:dossiers', subject: `message:${messageId}`, data: { error: error instanceof Error ? error.name : 'unknown' } }, now);
      } catch {
        console.error('aimmo : bouclier non passé, journal indisponible');
      }
    }
  };
  const rattachement = new Rattachement(db, store, fiche, decisions, reception, { now, afterAttach });
  const controle = new ControleEnvois(db, fiche, decisions, {
    channels: options.channels ?? trialChannels(db, journal, now),
    journal: new SqlSendJournal(db, undefined, now),
    ...(options.budget ? { budget: options.budget } : {}),
    ...(options.channels ? {} : { staging: new PaliersCanaux(db, journal, { now, realChannels: options.realChannels ?? [] }) }),
    now,
  });
  const acces = new Acces(db, store, fiche, journal, { now });
  const premiere = new PremiereReponse(db, fiche, reception, new ReconnaissanceBien(db), controle, {
    ...(options.writer ? { writer: options.writer } : {}),
    diffusion: new Diffusion(db, acces, journal, { now }),
    // L'annonce validée dans la langue d'un acheteur étranger suit sa première réponse (RC34) [R259].
    translations: new AnnoncesTraduites(db, acces, journal, { now }),
  });
  const relais = new ConversationRelais(db, store, fiche, reception, premiere, acces, { now });
  const qualification = new Qualification(db, store, fiche, reception, new ReconnaissanceBien(db), journal, {
    now,
    ...(options.qualifier ? { qualifier: options.qualifier } : {}),
  });
  const attribution = new Attribution(db, fiche, journal, { now });
  const rappels = new Rappels(db, fiche, journal, { now });
  const acquereurs = new FicheAcquereur(db, journal, { now });
  // Qualifier, noter, attribuer, créer la tâche : une erreur est écrite au journal, sans texte ni coordonnée [R13],
  // et n'empêche jamais la réponse déjà prête ; le prochain envoi du même message reprend là où elle s'est arrêtée.
  const afterReply: AfterReply = async (inboundId) => {
    try {
      const q = await qualification.qualify(inboundId);
      if (!q) return;
      const a = await attribution.attribute(q.id);
      if (a) await rappels.forQualification(q.id);
      // La fiche acquéreur suit ce que le message dit (T01) ; rien pour un autre projet.
      if (q.category === 'buyer') await acquereurs.fromQualification(q.id);
    } catch (error) {
      try {
        await appendEvent(
          journal,
          { type: 'qualification.erreur', actor: 'system:qualification', subject: `inbound:${inboundId}`, data: { error: error instanceof Error ? error.name : 'unknown' } },
          now,
        );
      } catch {
        // Le journal lui-même est en panne : la réponse est déjà prête, rien ne doit l'empêcher ; la trace va à la
        // console, sans donnée [R13], et le prochain envoi du même message reprendra la qualification.
        console.error('aimmo : qualification non faite, journal indisponible');
      }
    }
  };
  // L'origine du contact (AT05, AT10) : une panne va au journal, sans texte ni adresse [R13, R156] ; le prochain envoi
  // du même message la relit, et la première lecture rangée reste la seule.
  const origine = new OrigineContacts(db, journal, { now });
  const recordOrigin: OriginRecorder = async (networkId, inboundId, signals) => {
    try {
      await origine.record(networkId, inboundId, signals);
      // AU038 : la demande venue par le lien d'une campagne de publicité, rapprochée d'elle au passage planifié [R588].
      await recordAdArrival(db, journal, now, networkId, inboundId, signals);
    } catch (error) {
      try {
        await appendEvent(journal, { type: 'attirer.origine_erreur', actor: 'system:attirer', subject: `inbound:${inboundId}`, data: { rule: 'R156', error: error instanceof Error ? error.name : 'unknown' } }, now);
      } catch {
        console.error('aimmo : origine non rangée, journal indisponible');
      }
    }
  };
  return {
    chaine: new ChaineCaptation(reception, rattachement, relais, now, options.withQualification === false ? null : afterReply, options.withOrigin === false ? null : recordOrigin),
    origine,
    store,
    fiche,
    reception,
    relais,
    controle,
    qualification,
    attribution,
    rappels,
    acquereurs,
    acces,
  };
}
