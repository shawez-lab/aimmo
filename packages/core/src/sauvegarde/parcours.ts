/**
 * Le parcours complet fictif de chaque mois, son reçu et ce que la direction en lit (BR72, après SV04) [R16, R13].
 *
 * Jamais vu : la direction lit chaque mois la preuve datée qu'un client inventé traverse tout le logiciel, du premier
 * message à l'après-vente, et l'étape exacte où il s'arrête sinon, sans ouvrir GitHub.
 *
 * Décidé, lecture prudente :
 * - le parcours se joue sans secret ni base ; seul son résultat est rangé, par un second travail : le mois, réussi ou
 *   raté, et l'identifiant de l'étape cassée pris dans une liste fermée. Rien d'autre, ni raison ni texte d'erreur, qui
 *   pourraient citer une donnée ;
 * - une étape hors liste ou un résultat illisible : raté, sans étape. Jamais un vert par défaut ;
 * - réussi seulement si le travail du parcours a réussi et qu'il a dit n'avoir cassé nulle part ;
 * - le parcours passe le 3 du mois : jusqu'au 3 au soir, le mois attendu est encore le mois d'avant, comme la restauration ;
 * - le dernier reçu du mois décide ; un reçu ne se réécrit ni ne s'efface.
 */
import type { Viewer } from '../acces/droits.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { localTime } from '../envoi/horaires.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import { expectedRestoreMonth } from './restauration.ts';

/** Les étapes du parcours, dans l'ordre. Le test du parcours vérifie qu'elles sont exactement les siennes. */
export const JOURNEY_STEPS = ['premier_message', 'qualification', 'rendez_vous', 'estimation', 'mandat', 'annonce', 'acquereur', 'visite', 'offre', 'compromis_acte', 'apres_vente'] as const;
export type JourneyStepId = (typeof JOURNEY_STEPS)[number];

export type JourneyReceipt =
  | { id: string; ranAt: string; month: string; outcome: 'reussi' }
  | { id: string; ranAt: string; month: string; outcome: 'rate'; step: JourneyStepId | null };

/** Ce que le premier travail a dit : `aucune` si rien n'a cassé, sinon l'étape. */
export const JOURNEY_NONE = 'aucune';

const isStep = (v: string): v is JourneyStepId => (JOURNEY_STEPS as readonly string[]).includes(v);

/**
 * Le reçu, d'après le résultat du travail du parcours (`success`, `failure`…) et l'étape qu'il a dite. Tout ce qui
 * n'est pas une réussite nette est un échec ; une étape hors liste n'est pas recopiée.
 */
export function journeyReceipt(input: { id: string; ranAt: Date; jobResult: string; said: string }): JourneyReceipt {
  const head = { id: input.id, ranAt: input.ranAt.toISOString(), month: localTime(input.ranAt, 'Europe/Paris').date.slice(0, 7) };
  const said = input.said.trim();
  if (input.jobResult.trim() === 'success' && said === JOURNEY_NONE) return { ...head, outcome: 'reussi' };
  return { ...head, outcome: 'rate', step: isStep(said) ? said : null };
}

export async function recordJourneyReceipt(db: SqlDatabase, r: JourneyReceipt): Promise<void> {
  await db.run('INSERT INTO journey_receipts (id, ran_at, month, outcome, step) VALUES (?, ?, ?, ?, ?)', [r.id, r.ranAt, r.month, r.outcome, r.outcome === 'rate' ? r.step : null]);
}

export type JourneyState = 'reussi' | 'echec' | 'manquant';

export interface JourneyStatus {
  state: JourneyState;
  /** Le mois dont un reçu est attendu aujourd'hui. */
  expectedMonth: string;
  /** Le dernier reçu du mois attendu ; sinon le dernier connu, pour dire depuis quand. */
  receipt: JourneyReceipt | null;
}

interface Row {
  id: string;
  ran_at: string;
  month: string;
  outcome: 'reussi' | 'rate';
  step: string | null;
}

const toReceipt = (r: Row): JourneyReceipt => {
  const head = { id: r.id, ranAt: r.ran_at, month: r.month };
  return r.outcome === 'reussi' ? { ...head, outcome: 'reussi' } : { ...head, outcome: 'rate', step: r.step && isStep(r.step) ? r.step : null };
};

export class RecusParcours {
  private readonly now: () => Date;

  constructor(
    private readonly db: SqlDatabase,
    private readonly journal: JournalStore,
    options: { now?: () => Date } = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  /** La direction seule [R16]. Sans reçu du mois attendu : « manquant », jamais vert par défaut. */
  async status(viewer: Viewer): Promise<{ ok: true; value: JourneyStatus } | { ok: false; rule: 'R16'; code: 'role' }> {
    const actor = `${String(viewer.role)}:${viewer.userId}`;
    const subject = `network:${viewer.networkId}`;
    if (viewer.role !== 'direction') {
      await appendEvent(this.journal, { type: 'acces.refuse', actor, subject, data: { rule: 'R16', role: String(viewer.role), kind: 'journey_receipt', code: 'role' } }, this.now);
      return { ok: false, rule: 'R16', code: 'role' };
    }
    const expectedMonth = expectedRestoreMonth(this.now());
    // Un reçu daté dans le futur (une horloge fausse) ne doit jamais cacher les vrais.
    const latest = await this.db.first<Row>('SELECT * FROM journey_receipts WHERE ran_at <= ? ORDER BY ran_at DESC LIMIT 1', [this.now().toISOString()]);
    const current = latest && latest.month >= expectedMonth ? latest : null;
    const state: JourneyState = !current ? 'manquant' : current.outcome === 'reussi' ? 'reussi' : 'echec';
    await appendEvent(this.journal, { type: 'pilotage.lecture', actor, subject, data: { kind: 'journey_receipt' } }, this.now);
    return { ok: true, value: { state, expectedMonth, receipt: latest ? toReceipt(latest) : null } };
  }
}
