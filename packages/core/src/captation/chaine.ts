/**
 * La chaîne de captation, de bout en bout (C06) : notification brute reçue → rangée une seule fois (C01, R18)
 * → rattachée à sa fiche (C02) → bien reconnu et réponse composée (C03, C04) → relais à l'agent (C05) → contrôle
 * central (S06) → canal. En mode essai, le canal est la boîte d'essai : rien ne part.
 */
import { Acces } from '../acces/acces.ts';
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
import { PremiereReponse, type ReplyWriter } from './premiere-reponse.ts';
import { ConversationRelais, type RelayOutcome } from './relais.ts';

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

export class ChaineCaptation {
  constructor(
    private readonly reception: Reception,
    private readonly rattachement: Rattachement,
    private readonly relais: ConversationRelais,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async receive(networkId: string, source: InboundSource, raw: unknown, ctx: Partial<AdaptContext> = {}): Promise<ChainResult[]> {
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
        results.push(done('duplicate'));
        continue;
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
      const relayed = await this.relais.process(item.inboundId);
      const messageId = relayed.status === 'replied' ? (relayed.reply.result?.messageId ?? null) : null;
      results.push(done(relayed.status, messageId));
    }
    return results;
  }
}

export interface CaptationOptions {
  now?: () => Date;
  /** Les vrais canaux ; absents : la boîte d'essai, rien ne part. */
  channels?: readonly OutboundChannel[];
  writer?: ReplyWriter;
  budget?: AiBudget;
}

/** Assemble toute la chaîne sur une base. Sans canaux fournis, elle tourne en mode essai. */
export function createCaptation(db: SqlDatabase, journal: JournalStore, options: CaptationOptions = {}) {
  const now = options.now ?? (() => new Date());
  const store = new FicheClient(db, { now });
  const fiche = new FicheUnique(db, store, { now });
  const decisions = new DecisionEnvoi(db, store, fiche, { now });
  const reception = new Reception(db, undefined, now);
  const rattachement = new Rattachement(db, store, fiche, decisions, reception, { now });
  const controle = new ControleEnvois(db, fiche, decisions, {
    channels: options.channels ?? trialChannels(db, journal, now),
    journal: new SqlSendJournal(db, undefined, now),
    ...(options.budget ? { budget: options.budget } : {}),
    now,
  });
  const premiere = new PremiereReponse(db, fiche, reception, new ReconnaissanceBien(db), controle, options.writer ? { writer: options.writer } : {});
  const acces = new Acces(db, store, fiche, journal, { now });
  const relais = new ConversationRelais(db, store, fiche, reception, premiere, acces, { now });
  return { chaine: new ChaineCaptation(reception, rattachement, relais, now), store, fiche, reception, relais, controle };
}
