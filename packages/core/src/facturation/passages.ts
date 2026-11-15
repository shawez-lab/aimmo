/**
 * Les passages du rapprochement bancaire et des relances d'impayés, pour le planificateur (M13, HX49, RC55)
 * [R13, R26, R551, R553].
 *
 * - `facturation.rapprochement`, chaque heure : chaque réseau qui a déposé un relevé voit rapprocher seul ce qui ne
 *   laisse qu'un choix [R551].
 * - `facturation.relances_preparation`, à 6 h : un rapprochement d'abord, pour qu'un paiement que la banque prouve déjà
 *   ferme la facture avant qu'on la relance ; puis les relances dues, à valider par la direction [R553].
 * - `facturation.relances_envoi`, de 9 h à 19 h du lundi au samedi : un rapprochement d'abord, puis l'envoi des seules
 *   relances validées, par le contrôle central, dans la boîte d'essai [R26] ; sur un relevé ancien, elles attendent.
 *
 * Jamais une relance sur une banque qu'on ne connaît plus : si le dernier relevé déposé a plus de 7 jours (réglage), ou
 * si aucun n'a jamais été déposé, aucune relance n'est préparée. Que la facture n'apparaisse pas dans les encaissements
 * ne prouve rien quand les encaissements ne sont plus lus. Le passage le dit au journal, sans montant [R13].
 *
 * Un réseau en panne n'arrête pas les autres ; la première erreur remonte au planificateur, qui l'écrit au journal.
 */
import type { Acces } from '../acces/acces.ts';
import type { ScheduledJob } from '../bascule/planificateur.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import { Rapprochements } from './banque.ts';
import { todayInParis } from './commun.ts';
import { RelancesImpayes } from './relances.ts';

export const RECONCILIATION_JOB = 'facturation.rapprochement';
export const REMINDERS_PREPARE_JOB = 'facturation.relances_preparation';
export const REMINDERS_SEND_JOB = 'facturation.relances_envoi';
export const DEFAULT_STATEMENT_MAX_AGE_DAYS = 7;

const ALL_HOURS: readonly number[] = Object.freeze(Array.from({ length: 24 }, (_, h) => h));
const SEND_HOURS: readonly number[] = Object.freeze([9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
const SEND_WEEKDAYS: readonly number[] = Object.freeze([1, 2, 3, 4, 5, 6]);

export interface StatementFreshness {
  /** Le jour (heure de Paris) du dernier dépôt d'un relevé qui a rangé au moins une ligne ; `null` : aucun. */
  lastImportDay: string | null;
  /** L'âge de ce dépôt en jours ; `null` : aucun relevé. */
  ageDays: number | null;
  /** Vrai seulement si un relevé a été déposé il y a au plus `maxAgeDays` jours. */
  fresh: boolean;
  reason: 'frais' | 'releve_ancien' | 'aucun_releve';
  maxAgeDays: number;
}

function checkMaxAge(maxAgeDays: number): number {
  if (!Number.isInteger(maxAgeDays) || maxAgeDays < 1 || maxAgeDays > 31) throw new Error('Âge du relevé de banque : de 1 à 31 jours.');
  return maxAgeDays;
}

const dayNumber = (day: string): number => Math.round(Date.parse(`${day}T12:00:00Z`) / 86_400_000);

/**
 * Le dernier relevé de banque du réseau est-il assez récent pour qu'une facture absente des encaissements soit dite
 * impayée ? Lu sur les lignes rangées, jamais sur un réglage ni une saisie.
 */
export async function bankStatementFreshness(db: SqlDatabase, networkId: string, now: Date, maxAgeDays = DEFAULT_STATEMENT_MAX_AGE_DAYS): Promise<StatementFreshness> {
  checkMaxAge(maxAgeDays);
  const row = await db.first<{ at: string | null }>('SELECT MAX(created_at) AS at FROM bank_lines WHERE network_id = ?', [networkId]);
  if (!row?.at) return { lastImportDay: null, ageDays: null, fresh: false, reason: 'aucun_releve', maxAgeDays };
  const lastImportDay = todayInParis(new Date(row.at));
  const ageDays = Math.max(0, dayNumber(todayInParis(now)) - dayNumber(lastImportDay));
  const fresh = ageDays <= maxAgeDays;
  return { lastImportDay, ageDays, fresh, reason: fresh ? 'frais' : 'releve_ancien', maxAgeDays };
}

export interface FacturationJobsOptions {
  now?: () => Date;
  /** Âge au-delà duquel le dernier relevé ne prouve plus rien : de 1 à 31 jours, 7 par défaut. */
  statementMaxAgeDays?: number;
  /** Réglages des relances (échéance, écart), passés tels quels à `RelancesImpayes`. */
  paymentDays?: number;
  gapDays?: number;
}

/** Chaque réseau, l'un après l'autre : une panne n'arrête pas les suivants, la première remonte. */
async function eachNetwork(networks: { network_id: string }[], step: (networkId: string) => Promise<void>): Promise<void> {
  let failure: unknown = null;
  for (const n of networks) {
    try {
      await step(n.network_id);
    } catch (error) {
      failure ??= error;
    }
  }
  if (failure !== null) throw failure;
}

/** Les trois passages de la facturation, dans l'ordre où le planificateur doit les tenir. */
export function facturationJobs(db: SqlDatabase, journal: JournalStore, acces: Acces, options: FacturationJobsOptions = {}): ScheduledJob[] {
  const now = options.now ?? (() => new Date());
  const maxAgeDays = checkMaxAge(options.statementMaxAgeDays ?? DEFAULT_STATEMENT_MAX_AGE_DAYS);
  const banque = () => new Rapprochements(db, acces, journal, { now });
  const relances = () =>
    new RelancesImpayes(db, journal, {
      now,
      ...(options.paymentDays !== undefined ? { paymentDays: options.paymentDays } : {}),
      ...(options.gapDays !== undefined ? { gapDays: options.gapDays } : {}),
    });
  const bankNetworks = () => db.all<{ network_id: string }>('SELECT DISTINCT network_id FROM bank_lines ORDER BY network_id');
  /** Rapproche un réseau s'il a déposé un relevé : sans ligne de banque, il n'y a rien à rapprocher. */
  const reconcile = async (networkId: string) => {
    if (await db.first('SELECT 1 FROM bank_lines WHERE network_id = ? LIMIT 1', [networkId])) await banque().run(networkId);
  };
  return [
    {
      name: RECONCILIATION_JOB,
      hours: ALL_HOURS,
      run: async () => {
        const b = banque();
        await eachNetwork(await bankNetworks(), async (networkId) => {
          await b.run(networkId);
        });
      },
    },
    {
      name: REMINDERS_PREPARE_JOB,
      hours: [6],
      run: async () => {
        const r = relances();
        const networks = await db.all<{ network_id: string }>("SELECT DISTINCT network_id FROM invoices WHERE kind = 'honoraires' ORDER BY network_id");
        await eachNetwork(networks, async (networkId) => {
          await reconcile(networkId);
          const freshness = await bankStatementFreshness(db, networkId, now(), maxAgeDays);
          if (!freshness.fresh) {
            await appendEvent(
              journal,
              {
                type: 'facture.relances_attente',
                actor: 'system:facturation',
                subject: `network:${networkId}`,
                data: { rule: 'R553', reason: freshness.reason, lastImportDay: freshness.lastImportDay, maxAgeDays },
              },
              now,
            );
            return;
          }
          await r.prepare(networkId);
        });
      },
    },
    {
      name: REMINDERS_SEND_JOB,
      hours: SEND_HOURS,
      weekdays: SEND_WEEKDAYS,
      run: async () => {
        const r = relances();
        const networks = await db.all<{ network_id: string }>("SELECT DISTINCT network_id FROM invoice_reminders WHERE status = 'validee' ORDER BY network_id");
        await eachNetwork(networks, async (networkId) => {
          await reconcile(networkId);
          // La relance dit que la facture n'apparaît pas dans les encaissements : sur un relevé ancien, elle attend
          // le dépôt suivant, validée, sans rien écrire au journal à chaque heure.
          if (!(await bankStatementFreshness(db, networkId, now(), maxAgeDays)).fresh) return;
          await r.send(networkId);
        });
      },
    },
  ];
}
