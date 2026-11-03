/**
 * La date de mise en vente d'un bien (IN11) [R222, R42], qui sert à juger l'alerte dans l'heure [R216].
 *
 * Décidé, lecture prudente : un bien est mis en vente quand la porte de diffusion s'ouvre pour lui. La date est calculée
 * depuis les faits du mandat, jamais prise au passage qui la voit : sinon chaque alerte du même passage paraîtrait partie
 * à la seconde. Rangée une seule fois : un second mandat ne la déplace pas. Ce passage n'envoie rien, et il tourne à part
 * des alertes, qu'une panne ici ne peut pas arrêter.
 */
import { Acces } from '../acces/acces.ts';
import type { ScheduledJob } from '../bascule/planificateur.ts';
import { FicheClient } from '../db/fiche-client.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { Diffusion } from '../documents/retractation.ts';
import { FicheUnique } from '../fiche/fusion.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';

export const ON_SALE_JOB = 'acquereurs.mises_en_vente';

export class MisesEnVente {
  private readonly now: () => Date;
  private readonly diffusion: Diffusion;

  constructor(
    private readonly db: SqlDatabase,
    private readonly journal: JournalStore,
    options: { now?: () => Date } = {},
  ) {
    this.now = options.now ?? (() => new Date());
    const store = new FicheClient(db, { now: this.now });
    this.diffusion = new Diffusion(db, new Acces(db, store, new FicheUnique(db, store, { now: this.now }), journal, { now: this.now }), journal, { now: this.now });
  }

  /** Date les biens en vente qui ne le sont pas encore ; rend le nombre de dates rangées. */
  async run(): Promise<number> {
    const properties = await this.db.all<{ id: string; network_id: string }>(
      "SELECT p.id, p.network_id FROM properties p WHERE p.status = 'available' AND NOT EXISTS (SELECT 1 FROM property_on_sale s WHERE s.property_id = p.id) ORDER BY p.created_at, p.id",
    );
    let noted = 0;
    for (const p of properties) {
      const open = await this.diffusion.diffusableSince(p.network_id, p.id, this.now());
      if (!open) continue;
      const { changes } = await this.db.run(
        'INSERT INTO property_on_sale (property_id, network_id, mandate_id, on_sale_at, noted_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (property_id) DO NOTHING',
        [p.id, p.network_id, open.mandateId, open.since, this.now().toISOString()],
      );
      if (changes !== 1) continue;
      noted += 1;
      await appendEvent(this.journal, { type: 'bien.mise_en_vente', actor: 'system:mises_en_vente', subject: `property:${p.id}`, data: { rule: 'R222' } }, this.now);
    }
    return noted;
  }
}

/** La tâche du planificateur : aux mêmes jours que les alertes, sans aucun envoi. */
export function onSaleDatesJob(db: SqlDatabase, journal: JournalStore, options: { now?: () => Date } = {}): ScheduledJob {
  return {
    name: ON_SALE_JOB,
    hours: [8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19],
    weekdays: [1, 2, 3, 4, 5, 6],
    run: async () => {
      await new MisesEnVente(db, journal, options).run();
    },
  };
}
