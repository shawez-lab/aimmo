/**
 * Les notifications aux agents (SV15) : elles passent par le seul chemin de sortie, le contrôle central des envois
 * (`ControleEnvois.sendToAgent`), comme tout message [R26]. Le contrôle vérifie que l'agent est encore en activité
 * [R86], réserve l'envoi par son identifiant pour qu'il ne parte qu'une fois [R05], puis le remet au service de
 * notification ; chaque décision est écrite au journal des notifications, sans texte ni donnée [R13, R415].
 *
 * Mode essai : le seul service admis est la boîte d'essai (`AgentPushTrialBox`), qui range l'envoi et n'envoie rien
 * vers un téléphone. Le vrai service Web Push ne sera branché qu'avec ses clés (H57), par une tâche du plan.
 */
import type { SqlDatabase } from '../db/sql.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';

export type AgentPushUrgency = 'immediate' | 'haute' | 'normale' | 'basse';

/** Ce que reçoit le téléphone : texte de l'écran verrouillé et lien vers le détail, dans l'application [R415]. */
export interface AgentPushPayload {
  pushId: string;
  urgency: AgentPushUrgency;
  title: string;
  body: string;
  url: string;
}

export interface AgentPushOrder {
  networkId: string;
  agentId: string;
  payload: AgentPushPayload;
}

/** `ok` : remis au service ; `aucun_appareil` : rien à faire, l'agent lit dans l'application ; `echec` : à reprendre. */
export type AgentPushOutcome = 'ok' | 'aucun_appareil' | 'echec';

/** Le service de notification des téléphones : seul le contrôle central l'appelle [R26, R225]. */
export interface AgentPushService {
  pushToDevices(order: AgentPushOrder): Promise<AgentPushOutcome>;
}

export const AGENT_PUSH_TRIAL_JOURNAL_TYPE = 'envoi.essai.notification';

/** Le lien d'un envoi : le détail de cet envoi, dans l'application, et rien d'autre [R415]. */
export const agentPushUrl = (pushId: string): string => `/notifications/${pushId}`;

/**
 * La boîte d'essai des notifications : elle range ce qui aurait pu partir, sans texte ni agent au journal [R13], et
 * n'envoie jamais rien vers un téléphone [R26].
 */
export class AgentPushTrialBox implements AgentPushService {
  constructor(
    private readonly db: SqlDatabase,
    private readonly journal: JournalStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async pushToDevices(order: AgentPushOrder): Promise<'ok'> {
    await this.db.run('INSERT INTO agent_push_trial_outbox (push_id, created_at) VALUES (?, ?) ON CONFLICT DO NOTHING', [order.payload.pushId, this.now().toISOString()]);
    await appendEvent(
      this.journal,
      { type: AGENT_PUSH_TRIAL_JOURNAL_TYPE, actor: 'system:essai', subject: `agent_push:${order.payload.pushId}`, data: { mode: 'essai', sent: false } },
      this.now,
    );
    return 'ok';
  }
}
