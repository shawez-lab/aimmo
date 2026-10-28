/**
 * Branchement de M14 au planificateur du socle (J13) [R82, R85, R86, R13, R18].
 *
 * - `reseauHourlyJob`, chaque heure : les départs du jour (`Departs.runDue`), dès le premier passage après minuit,
 *   puis les alertes de l'assistance à la direction (avant l'échéance, puis échéance dépassée).
 * - `reseauDailyJob`, à 6 h : les alertes d'échéance des pièces du dossier d'agent (30 jours avant) et celles du
 *   compteur de formation (90 puis 30 jours avant).
 *
 * Chaque alerte est rangée une seule fois par sa couche métier, rejouer un passage n'ajoute rien [R18] ; elles sont
 * lues par les écrans (J14), jamais envoyées d'ici : rien ne part réellement tant que le plan ne l'a pas mis en
 * service. Le journal ne porte ni nom ni référence de pièce [R13].
 */
import type { ScheduledJob } from '../bascule/planificateur.ts';
import { FicheClient } from '../db/fiche-client.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import { Academie } from './academie.ts';
import { Accompagnement } from './accompagnement.ts';
import { Departs } from './depart.ts';
import { DossierAgent, type AgentPieceStore } from './dossier-agent.ts';
import { Entretiens } from './entretiens.ts';

export const RESEAU_HOURLY_JOB = 'reseau.passage';
export const RESEAU_DAILY_JOB = 'reseau.alertes';

/** Les alertes d'échéance ne lisent aucun fichier : ce stockage-là ne sert jamais, et le dit s'il était appelé. */
const NO_PIECE_STORE: AgentPieceStore = {
  has: () => Promise.reject(new Error('Stockage des pièces non attendu au planificateur.')),
  putDraft: () => Promise.reject(new Error('Stockage des pièces non attendu au planificateur.')),
};

const networks = (db: SqlDatabase): Promise<{ id: string }[]> => db.all<{ id: string }>('SELECT id FROM networks ORDER BY id');

export function reseauHourlyJob(db: SqlDatabase, journal: JournalStore, options: { now?: () => Date } = {}): ScheduledJob {
  const now = options.now ?? (() => new Date());
  return {
    name: RESEAU_HOURLY_JOB,
    hours: Array.from({ length: 24 }, (_, h) => h),
    run: async () => {
      const departs = new Departs(db, journal, { now });
      const accompagnement = new Accompagnement(db, journal, { now });
      for (const n of await networks(db)) {
        // Les départs d'abord : l'accès coupé, clients, biens et projets passés au successeur ou à la direction [R86].
        await departs.runDue(n.id);
        await accompagnement.dueAlerts(n.id);
      }
    },
  };
}

export function reseauDailyJob(db: SqlDatabase, journal: JournalStore, options: { now?: () => Date } = {}): ScheduledJob {
  const now = options.now ?? (() => new Date());
  return {
    name: RESEAU_DAILY_JOB,
    hours: [6],
    run: async () => {
      const dossier = new DossierAgent(db, new FicheClient(db, { now }), new Entretiens(db, journal, { now }), NO_PIECE_STORE, journal, { now });
      const academie = new Academie(db, journal, { now });
      for (const n of await networks(db)) {
        for (const a of await dossier.dueAlerts(n.id)) {
          await appendEvent(journal, { type: 'dossier_agent.alerte', actor: 'system:planificateur', subject: `agent:${a.agentId}`, data: { rule: 'R82', kind: a.kind, validUntil: a.validUntil } }, now);
        }
        await academie.dueAlerts(n.id);
      }
    },
  };
}

export function reseauJobs(db: SqlDatabase, journal: JournalStore, options: { now?: () => Date } = {}): ScheduledJob[] {
  return [reseauHourlyJob(db, journal, options), reseauDailyJob(db, journal, options)];
}
