/**
 * Options payantes du Studio et mesure des visuels publiés (M19, X08).
 *
 * Une option (photographe, drone, visite virtuelle, aménagement virtuel) n'est rien d'autre qu'une mise en relation de
 * M18 avec un photographe de l'annuaire : partenaires proposables tirés au sort, accord du client avec sa date et sa
 * preuve avant de confier, rémunération déclarée [R74, R75, R76]. Le Studio note seulement quelle option a été
 * demandée sur quelle mise en relation.
 *
 * La mesure des visuels (critère de M19 « aucune adresse visible sur 20 visuels publiés ») : les 20 derniers visuels
 * réellement envoyés par les publications de X05, chacun avec sa liste de contrôle ; le compte rendu, pour la direction,
 * dit chacun « sans adresse visible », ou le nomme avec la raison [R132].
 */
import type { Viewer } from '../acces/droits.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import type { Referral, ReferralResult } from '../partenaires/mise-en-relation.ts';

export const STUDIO_OPTIONS = Object.freeze({
  photographe: 'Photographe professionnel',
  drone: 'Prises de vue par drone',
  visite_virtuelle: 'Visite virtuelle',
  amenagement_virtuel: 'Aménagement virtuel',
} as const);
export type StudioOption = keyof typeof STUDIO_OPTIONS;

/** Le métier de M18 qui rend chaque option : rien de neuf dans l'annuaire. */
export const OPTION_TRADE: Readonly<Record<StudioOption, 'photographe'>> = Object.freeze({
  photographe: 'photographe',
  drone: 'photographe',
  visite_virtuelle: 'photographe',
  amenagement_virtuel: 'photographe',
});

export const MEASURE_SIZE = 20;

export interface VisualMeasureLine {
  postId: string;
  mediaRef: string;
  sentAt: string;
  verdict: 'sans_adresse_visible' | 'adresse_visible' | 'liste_absente' | 'liste_refusee';
}

export interface VisualMeasure {
  /** 20 visuels comptés, ou moins tant qu'il n'y en a pas eu autant. */
  counted: number;
  complete: boolean;
  /** Tous sans adresse visible, et 20 comptés. */
  passed: boolean;
  lines: VisualMeasureLine[];
  /** Les visuels nommés : ceux qui ne sont pas « sans adresse visible ». */
  named: VisualMeasureLine[];
}

export type OptionResult<T> = { ok: true; value: T } | { ok: false; rule: 'R16' | 'R10' | 'R73' | 'R74' | 'R75' | 'R76' | null; code: string };

export interface OptionsStudioOptions {
  now?: () => Date;
  newId?: () => string;
}

export class OptionsStudio {
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(
    private readonly db: SqlDatabase,
    private readonly journal: JournalStore,
    private readonly relations: { propose(viewer: Viewer, input: { projectId: unknown; trade: unknown; propertyId?: unknown; postcode?: unknown }): Promise<ReferralResult<Referral>> },
    options: OptionsStudioOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => crypto.randomUUID());
  }

  /** Demande une option pour le bien d'un projet : une mise en relation de M18, avec ses garanties [R74, R75]. */
  async requestOption(viewer: Viewer, input: { projectId: unknown; propertyId: unknown; option: unknown; postcode?: unknown }): Promise<OptionResult<{ option: StudioOption; referral: Referral }>> {
    if (typeof input.option !== 'string' || !Object.hasOwn(STUDIO_OPTIONS, input.option)) return { ok: false, rule: 'R10', code: 'option_inconnue' };
    const option = input.option as StudioOption;
    if (typeof input.propertyId !== 'string') return { ok: false, rule: 'R10', code: 'bien_requis' };
    const proposed = await this.relations.propose(viewer, { projectId: input.projectId, trade: OPTION_TRADE[option], propertyId: input.propertyId, postcode: input.postcode });
    if (!proposed.ok) return proposed;
    const actor = `${viewer.role}:${viewer.userId}`;
    await this.db.run('INSERT INTO studio_option_requests (id, network_id, referral_id, option, requested_by, requested_at) VALUES (?, ?, ?, ?, ?, ?)', [
      this.newId(),
      viewer.networkId,
      proposed.value.referralId,
      option,
      actor,
      this.now().toISOString(),
    ]);
    await appendEvent(this.journal, { type: 'studio.option.demandee', actor, subject: `referral:${proposed.value.referralId}`, data: { option } }, this.now);
    return { ok: true, value: { option, referral: proposed.value } };
  }

  /** La mesure des 20 derniers visuels publiés du réseau, pour la direction [R132, R16]. */
  async measureVisuals(viewer: Viewer): Promise<OptionResult<VisualMeasure>> {
    if (viewer.role !== 'direction') {
      await appendEvent(
        this.journal,
        { type: 'acces.refuse', actor: `${String(viewer.role)}:${viewer.userId}`, subject: `network:${viewer.networkId}`, data: { rule: 'R16', role: String(viewer.role), kind: 'visual_measure', code: 'role' } },
        this.now,
      );
      return { ok: false, rule: 'R16', code: 'role' };
    }
    // Un visuel est publié quand sa publication est partie au moins une fois ; sa date est celle du premier envoi réussi.
    const posts = await this.db.all<{ post_id: string; visuals: string; sent_at: string }>(
      `SELECT p.id AS post_id, p.visuals, MIN(s.done_at) AS sent_at
       FROM social_posts p JOIN (
         SELECT a.post_id, d.outcome, d.done_at FROM social_post_attempts a JOIN social_post_sends d ON d.attempt_id = a.id
         UNION ALL
         SELECT a.post_id, d.outcome, d.done_at FROM social_live_attempts a JOIN social_live_sends d ON d.attempt_id = a.id
       ) s ON s.post_id = p.id
       WHERE p.network_id = ? AND s.outcome = 'envoye'
       GROUP BY p.id ORDER BY sent_at DESC, p.id DESC`,
      [viewer.networkId],
    );
    const lines: VisualMeasureLine[] = [];
    for (const p of posts) {
      const visuals = JSON.parse(p.visuals) as { ref: string }[];
      const checks = await this.db.all<{ media_ref: string; address_visible: number; outcome: string }>('SELECT media_ref, address_visible, outcome FROM social_visual_checks WHERE post_id = ?', [p.post_id]);
      const byRef = new Map(checks.map((c) => [c.media_ref, c]));
      for (const v of visuals) {
        if (lines.length >= MEASURE_SIZE) break;
        const c = byRef.get(v.ref);
        const verdict: VisualMeasureLine['verdict'] = !c ? 'liste_absente' : c.address_visible === 1 ? 'adresse_visible' : c.outcome !== 'admis' ? 'liste_refusee' : 'sans_adresse_visible';
        lines.push({ postId: p.post_id, mediaRef: v.ref, sentAt: p.sent_at, verdict });
      }
      if (lines.length >= MEASURE_SIZE) break;
    }
    const named = lines.filter((l) => l.verdict !== 'sans_adresse_visible');
    const complete = lines.length === MEASURE_SIZE;
    const measure: VisualMeasure = { counted: lines.length, complete, passed: complete && named.length === 0, lines, named };
    await appendEvent(this.journal, { type: 'studio.mesure.visuels', actor: `direction:${viewer.userId}`, subject: `network:${viewer.networkId}`, data: { rule: 'R132', counted: lines.length, named: named.length, passed: measure.passed } }, this.now);
    return { ok: true, value: measure };
  }
}
