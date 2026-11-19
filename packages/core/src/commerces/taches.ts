/**
 * La tâche quotidienne de M16 (CE10), à 6 h : pour chaque réseau, les tâches de la cession à l'agent du bien (CE07),
 * une seule par étape et par échéance, et l'examen de vigilance de chaque dossier de cession (CE08), une alerte au plus
 * par acquéreur. Rien n'est envoyé à personne : tâches et alertes sont rangées pour les écrans [R116, R118].
 */
import type { ScheduledJob } from '../bascule/planificateur.ts';
import { EtatCoffre } from '../conformite/coffre.ts';
import type { SqlDatabase } from '../db/sql.ts';
import type { JournalStore } from '../journal/types.ts';
import { CessionCommerce } from './cession.ts';
import { TachesBail } from './bail-taches.ts';
import { FicheCommerce } from './fiche.ts';
import { VigilanceCession, type VaultDeposits } from './vigilance-cession.ts';

export const COMMERCES_DAILY_JOB = 'commerces.cession_quotidienne';

export function commercesDailyJob(db: SqlDatabase, journal: JournalStore, options: { now?: () => Date; vault?: VaultDeposits } = {}): ScheduledJob {
  const now = options.now ?? (() => new Date());
  return {
    name: COMMERCES_DAILY_JOB,
    hours: [6],
    run: async () => {
      const fiches = new FicheCommerce(db, journal, { now });
      const cessions = new CessionCommerce(db, journal, fiches, { now });
      const vigilance = new VigilanceCession(db, journal, options.vault ?? new EtatCoffre(db, { now }), { now });
      const networks = await db.all<{ network_id: string }>('SELECT DISTINCT network_id FROM business_transfer_files ORDER BY network_id');
      for (const n of networks) {
        await cessions.run(n.network_id);
        await vigilance.run(n.network_id);
      }
      // AU101b · Les jours limites de congé des baux commerciaux, pour chaque réseau qui a une fiche de commerce.
      const bail = new TachesBail(db, journal, fiches, { now });
      const withSheets = await db.all<{ network_id: string }>('SELECT DISTINCT network_id FROM business_sheets ORDER BY network_id');
      for (const n of withSheets) await bail.run(n.network_id);
    },
  };
}
