/**
 * Relecture trimestrielle du registre des traitements (M12, L06) [R16, R17, R95].
 *
 * La date de la dernière relecture est un réglage tenu par le responsable de la conformité seul : il inscrit chaque
 * relecture avec son nom et sa date, et l'empreinte du registre qu'il a relu. Sans relecture inscrite, le registre
 * compte comme relu le jour où il a été écrit. La prochaine échéance tombe trois mois après la dernière relecture.
 *
 * Chaque jour, le planificateur appelle `run` : 15 jours avant l'échéance, une alerte part au responsable, une seule
 * fois par échéance, même si le planificateur repasse ou si l'échéance est dépassée. Rien n'est envoyé : l'alerte
 * attend dans la liste du responsable. Rien ne s'efface [R17].
 */
import type { Viewer } from '../acces/droits.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { localTime } from '../envoi/horaires.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import { registryFingerprint, type Traitement } from './registre.ts';
import { COLONNES_SANS_DONNEE_PERSONNELLE, REGISTRE_ECRIT_LE, REGISTRE_TRAITEMENTS, TABLES_SANS_DONNEE_PERSONNELLE } from './registre-traitements.ts';

const TIME_ZONE = 'Europe/Paris';
const DAY = /^\d{4}-\d{2}-\d{2}$/;

export const REGISTRY_REVIEW_MONTHS = 3;
export const REGISTRY_NOTICE_DAYS = 15;

const validDay = (v: unknown): v is string => {
  if (typeof v !== 'string' || !DAY.test(v)) return false;
  const d = new Date(`${v}T12:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
};

/** Ajoute des mois à un jour, en restant au dernier jour du mois s'il le faut. */
export function addCalendarMonths(day: string, months: number): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const target = new Date(Date.UTC(y, m - 1 + months, 1));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d, last));
  return target.toISOString().slice(0, 10);
}

const addDays = (day: string, days: number): string => new Date(Date.parse(`${day}T00:00:00.000Z`) + days * 86_400_000).toISOString().slice(0, 10);

export interface RegistryReviewStatus {
  /** La date de la dernière relecture, ou celle où le registre a été écrit. */
  lastReviewOn: string;
  /** Aucune relecture inscrite : la date est celle où le registre a été écrit. */
  initial: boolean;
  dueOn: string;
  /** Le jour où l'alerte part : 15 jours avant l'échéance. */
  noticeOn: string;
  /** L'empreinte du registre tel qu'il est aujourd'hui, et si elle a changé depuis la dernière relecture. */
  registryHash: string;
  changedSinceReview: boolean;
}

export interface RegistryReviewAlert {
  dueOn: string;
  lastReviewOn: string;
  text: string;
  createdAt: string;
}

export type RegistryRefusal = { ok: false; rule: 'R16' | 'R95' | null; code: string };

export class RelectureRegistre {
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly registre: readonly Traitement[];
  private readonly sansDonnee: Readonly<Record<string, string>>;
  private readonly colonnesSansDonnee: Readonly<Record<string, readonly string[]>>;
  private readonly writtenOn: string;

  constructor(
    private readonly db: SqlDatabase,
    private readonly journal: JournalStore,
    options: {
      now?: () => Date;
      newId?: () => string;
      registre?: readonly Traitement[];
      sansDonnee?: Readonly<Record<string, string>>;
      colonnesSansDonnee?: Readonly<Record<string, readonly string[]>>;
      writtenOn?: string;
    } = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => crypto.randomUUID());
    this.registre = options.registre ?? REGISTRE_TRAITEMENTS;
    this.sansDonnee = options.sansDonnee ?? TABLES_SANS_DONNEE_PERSONNELLE;
    this.colonnesSansDonnee = options.colonnesSansDonnee ?? COLONNES_SANS_DONNEE_PERSONNELLE;
    this.writtenOn = options.writtenOn ?? REGISTRE_ECRIT_LE;
  }

  private today(): string {
    return localTime(this.now(), TIME_ZONE).date;
  }

  private actor(viewer: Viewer): string {
    return `${String(viewer.role)}:${viewer.userId}`;
  }

  private async refuse(viewer: Viewer, code: string): Promise<RegistryRefusal> {
    await appendEvent(
      this.journal,
      { type: 'acces.refuse', actor: this.actor(viewer), subject: `network:${viewer.networkId}`, data: { rule: 'R16', role: String(viewer.role), kind: 'registre_traitements', code } },
      this.now,
    );
    return { ok: false, rule: 'R16', code };
  }

  private async lastReview(networkId: string): Promise<{ id: string; reviewed_on: string; registry_hash: string } | null> {
    return this.db.first<{ id: string; reviewed_on: string; registry_hash: string }>(
      'SELECT id, reviewed_on, registry_hash FROM registry_reviews WHERE network_id = ? ORDER BY reviewed_on DESC, recorded_at DESC LIMIT 1',
      [networkId],
    );
  }

  private async statusOf(networkId: string): Promise<RegistryReviewStatus> {
    const last = await this.lastReview(networkId);
    const lastReviewOn = last?.reviewed_on ?? this.writtenOn;
    const dueOn = addCalendarMonths(lastReviewOn, REGISTRY_REVIEW_MONTHS);
    const registryHash = await registryFingerprint(this.registre, this.sansDonnee, this.colonnesSansDonnee);
    return {
      lastReviewOn,
      initial: last === null,
      dueOn,
      noticeOn: addDays(dueOn, -REGISTRY_NOTICE_DAYS),
      registryHash,
      changedSinceReview: last !== null && last.registry_hash !== registryHash,
    };
  }

  /** L'état de la relecture : le responsable de la conformité et la direction le lisent. */
  async status(viewer: Viewer): Promise<{ ok: true; value: RegistryReviewStatus } | RegistryRefusal> {
    if (viewer.role !== 'compliance' && viewer.role !== 'direction') return this.refuse(viewer, 'role');
    return { ok: true, value: await this.statusOf(viewer.networkId) };
  }

  /** Le responsable inscrit une relecture, avec son nom et sa date, jamais dans l'avenir ni avant la précédente. */
  async recordReview(
    viewer: Viewer,
    input: { reviewedOn: string; validatorName: string },
  ): Promise<{ ok: true; value: RegistryReviewStatus } | RegistryRefusal> {
    if (viewer.role !== 'compliance') return this.refuse(viewer, 'role');
    if (!validDay(input.reviewedOn)) return { ok: false, rule: null, code: 'bad_date' };
    if (input.reviewedOn > this.today()) return { ok: false, rule: null, code: 'future_date' };
    if (typeof input.validatorName !== 'string' || input.validatorName.trim() === '' || input.validatorName.length > 120) return { ok: false, rule: null, code: 'bad_name' };
    const before = await this.statusOf(viewer.networkId);
    if (input.reviewedOn < before.lastReviewOn) return { ok: false, rule: null, code: 'before_last_review' };
    const id = this.newId();
    await this.db.run(
      'INSERT INTO registry_reviews (id, network_id, reviewed_on, validator_name, registry_hash, recorded_by, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [id, viewer.networkId, input.reviewedOn, input.validatorName.trim(), before.registryHash, this.actor(viewer), this.now().toISOString()],
    );
    await appendEvent(
      this.journal,
      { type: 'registre.relecture', actor: this.actor(viewer), subject: `registry:${viewer.networkId}`, data: { rule: 'R95', review: `registry_review:${id}`, reviewedOn: input.reviewedOn, registryHash: before.registryHash } },
      this.now,
    );
    return { ok: true, value: await this.statusOf(viewer.networkId) };
  }

  /**
   * Le passage du jour : l'alerte part au responsable à partir de 15 jours avant l'échéance, une seule fois par
   * échéance. Rend le nombre d'alertes levées (0 ou 1). Une alerte rangée sans son événement est reprise au journal.
   */
  async run(networkId: string): Promise<number> {
    const status = await this.statusOf(networkId);
    if (this.today() < status.noticeOn) return 0;
    const { changes } = await this.db.run(
      'INSERT INTO registry_review_alerts (network_id, due_on, last_review_on, created_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING',
      [networkId, status.dueOn, status.lastReviewOn, this.now().toISOString()],
    );
    await this.journalAlert(networkId, status.dueOn);
    return changes > 0 ? 1 : 0;
  }

  private async journalAlert(networkId: string, dueOn: string): Promise<void> {
    const subject = `registry:${networkId}`;
    const done = (await this.journal.bySubject(subject)).some((e) => e.type === 'registre.relecture_alerte' && e.data.dueOn === dueOn);
    if (done) return;
    await appendEvent(this.journal, { type: 'registre.relecture_alerte', actor: 'system:registre', subject, data: { rule: 'R95', dueOn } }, this.now);
  }

  /** Les alertes de relecture : le responsable de la conformité seul. */
  async alerts(viewer: Viewer): Promise<{ ok: true; value: RegistryReviewAlert[] } | RegistryRefusal> {
    if (viewer.role !== 'compliance') return this.refuse(viewer, 'role');
    const rows = await this.db.all<{ due_on: string; last_review_on: string; created_at: string }>(
      'SELECT due_on, last_review_on, created_at FROM registry_review_alerts WHERE network_id = ? ORDER BY due_on',
      [viewer.networkId],
    );
    for (const r of rows) await this.journalAlert(viewer.networkId, r.due_on);
    const fr = (day: string): string => `${day.slice(8, 10)}/${day.slice(5, 7)}/${day.slice(0, 4)}`;
    return {
      ok: true,
      value: rows.map((r) => ({
        dueOn: r.due_on,
        lastReviewOn: r.last_review_on,
        createdAt: r.created_at,
        text: `Relecture trimestrielle du registre des traitements à faire avant le ${fr(r.due_on)} (dernière relecture le ${fr(r.last_review_on)}).`,
      })),
    };
  }
}
