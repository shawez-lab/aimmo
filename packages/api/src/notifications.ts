/**
 * Le passage des notifications aux agents, à chaque minute (BR65, HX27, RC33, SV15).
 *
 * Le déclencheur du Worker passe chaque minute. À chaque passage, en mode essai seulement : le rattrapage relit les
 * contacts chauds et les messages reçus que personne n'a encore notifiés (`catchUp`), puis l'envoi fait partir ce qui
 * est dû, urgence par urgence, heures calmes tenues (`flush`) [R412, R413, R414]. Rien ne part que par le contrôle
 * central des envois, construit ici sans aucun canal vers une personne et avec la seule boîte d'essai des
 * notifications : rien ne part vers un téléphone tant que le vrai service n'est pas en service (H57) [R225, R26].
 * Une erreur du passage est écrite au journal, jamais avalée, et n'empêche pas le reste du déclencheur [R13].
 */
import { AgentPushTrialBox, ControleEnvois, DecisionEnvoi, FicheClient, FicheUnique, SqlJournalStore, SqlSendJournal, type SqlDatabase } from '@aimmo/core';
import { Notifications, type CatchUpResult } from '../../core/src/automatismes/notifications.ts';
import { TRIAL_MODE, journalError } from './app.ts';

export interface NotificationsPassConfig {
  db: SqlDatabase;
  /** Variable `MODE` : hors essai, rien ne passe. */
  mode: string | undefined;
  now?: () => Date;
}

/** Ce qu'un passage a fait : le rattrapage, et le nombre d'envois faits. */
export interface NotificationsPassResult {
  caughtUp: CatchUpResult;
  pushes: number;
}

/** Le contrôle central du passage : aucun canal vers une personne, la seule boîte d'essai des notifications [R26]. */
function trialGate(db: SqlDatabase, journal: SqlJournalStore, now: () => Date): ControleEnvois {
  const store = new FicheClient(db, { now });
  const unique = new FicheUnique(db, store, { now });
  return new ControleEnvois(db, unique, new DecisionEnvoi(db, store, unique, { now }), {
    channels: [],
    journal: new SqlSendJournal(db, undefined, now),
    agentPush: new AgentPushTrialBox(db, journal, now),
    now,
  });
}

/** Le passage de chaque minute. Hors mode essai, ou en panne (écrite au journal), rend `null`. */
export async function runNotificationsPass(config: NotificationsPassConfig): Promise<NotificationsPassResult | null> {
  if (config.mode !== TRIAL_MODE) return null;
  const now = config.now ?? (() => new Date());
  const journal = new SqlJournalStore(config.db);
  try {
    const notifications = new Notifications(config.db, journal, trialGate(config.db, journal, now), { now });
    const caughtUp = await notifications.catchUp();
    const pushes = await notifications.flush();
    return { caughtUp, pushes: pushes.length };
  } catch (error) {
    await journalError(journal, 'system:notifications', 'notifications.passage', error, now);
    return null;
  }
}

/** Le planificateur et la publication ne passent qu'aux quarts d'heure, comme avant BR65. */
export const isQuarterMinute = (at: Date): boolean => at.getUTCMinutes() % 15 === 0;
