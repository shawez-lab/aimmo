/**
 * Lancement de la reprise sur les vraies bases (I05).
 *
 * Lancé à la main par le travail GitHub « Reprise des contacts », jamais par une requête du Worker (une requête ne peut
 * pas faire des milliers de lectures et d'écritures). Il lit les trois fichiers déposés par la direction dans la base
 * `aimmo`, la base `espace-estimation` du site en lecture seule, puis enchaîne la reprise par morceaux, dans l'ordre de
 * `docs/REPRISE.md`. Après chaque morceau, l'avancement est rangé : un travail coupé (temps écoulé, panne) reprend au
 * morceau suivant ; un morceau coupé net est refait, ce qui ne double rien (la reprise est relançable, I02).
 *
 * Rien ne tourne sans les trois fichiers, tous lus avant la première écriture, et sans la lecture du site [R02, R04].
 * Le rapport, l'avancement et le journal ne portent que des nombres [R13]. Rien n'est envoyé, rien n'est effacé [R17].
 */
import type { SqlDatabase } from '../db/sql.ts';
import { FicheClient } from '../db/fiche-client.ts';
import { DecisionEnvoi } from '../envoi/service.ts';
import { FicheUnique } from '../fiche/fusion.ts';
import { appendEvent } from '../journal/journal.ts';
import { SqlJournalStore } from '../journal/sql-store.ts';
import { DepotsReprise, sha256Hex, type DepotInfo } from './depots.ts';
import { readOnly } from './lecture-seule.ts';
import { TOOL_FILES, readToolCsv } from './outils.ts';
import { RepriseReelle, type RepriseControl } from './reelle.ts';
import { RepriseSite, type ImportBatch, type ImportReport, type ImportedContact } from './reprise.ts';
import { readSiteContacts } from './site.ts';

/** Contacts repris par morceau, entre deux enregistrements de l'avancement. */
export const LANCEMENT_CHUNK = 100;

export const LANCEMENT_SOURCES = ['site', ...TOOL_FILES] as const;
export type LancementSource = (typeof LANCEMENT_SOURCES)[number];
/** Les étapes : les sources, puis la source « site » refaite si le site a reçu de nouveaux contacts entre-temps. */
const STEPS = [...LANCEMENT_SOURCES, 'site_again'] as const;
export type LancementStep = (typeof STEPS)[number];

/** Les nombres d'un lot, additionnés morceau par morceau. */
export interface LancementTotals {
  read: number;
  created: number;
  matched: number;
  merged: number;
  apart: number;
  flagged: number;
  withoutIdentifier: number;
  projects: number;
  consents: number;
  exclusions: number;
  skippedSuspect: number;
  skippedTest: number;
  /** Numéros de ligne dans le fichier : à regarder à la main. */
  unreadableLines: number[];
  partialLines: number[];
}

export type LancementReport =
  | { state: 'stopped'; code: 'no_files' | 'missing_files' | 'several_networks' | 'several_agents' }
  | { state: 'to_continue'; networkId: string; source: LancementStep; position: number; totals: Partial<Record<LancementStep, LancementTotals>> }
  | { state: 'done'; networkId: string; totals: Partial<Record<LancementStep, LancementTotals>>; control: RepriseControl; already: boolean };

export interface LancementOptions {
  actor?: string;
  now?: () => Date;
  random?: () => number;
  chunk?: number;
  /** Vrai tant qu'il reste du temps pour un morceau de plus ; sinon le travail s'arrête proprement, à reprendre. */
  timeLeft?: () => boolean;
}

interface Progress {
  /** Empreinte des dépôts, et de la lecture du site sur laquelle la source « site » a été faite. */
  depotsFp: string;
  siteFp: string;
  source: LancementStep;
  position: number;
  totals: Partial<Record<LancementStep, LancementTotals>>;
  doneAt: string | null;
}

const zero = (): LancementTotals => ({
  read: 0,
  created: 0,
  matched: 0,
  merged: 0,
  apart: 0,
  flagged: 0,
  withoutIdentifier: 0,
  projects: 0,
  consents: 0,
  exclusions: 0,
  skippedSuspect: 0,
  skippedTest: 0,
  unreadableLines: [],
  partialLines: [],
});

function add(t: LancementTotals, r: ImportReport): LancementTotals {
  return {
    read: t.read + r.read,
    created: t.created + r.created,
    matched: t.matched + r.matched,
    merged: t.merged + r.merged,
    apart: t.apart + r.apart,
    flagged: t.flagged + r.flagged,
    withoutIdentifier: t.withoutIdentifier + r.withoutIdentifier,
    projects: t.projects + r.projects,
    consents: t.consents + r.consents,
    exclusions: t.exclusions + r.exclusions,
    skippedSuspect: t.skippedSuspect + r.skipped.suspect,
    skippedTest: t.skippedTest + r.skipped.test,
    unreadableLines: [...t.unreadableLines, ...r.unreadableLines],
    partialLines: [...t.partialLines, ...r.partialLines],
  };
}

export class LancementReprise {
  private readonly now: () => Date;
  private readonly actor: string;
  private readonly chunk: number;
  private readonly timeLeft: () => boolean;
  private readonly journal: SqlJournalStore;
  private readonly depots: DepotsReprise;

  constructor(
    private readonly db: SqlDatabase,
    private readonly site: SqlDatabase,
    private readonly options: LancementOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.actor = options.actor ?? 'reprise:lancement';
    this.chunk = Math.max(1, Math.floor(options.chunk ?? LANCEMENT_CHUNK));
    this.timeLeft = options.timeLeft ?? (() => true);
    this.journal = new SqlJournalStore(db);
    this.depots = new DepotsReprise(db, this.journal, { now: this.now });
  }

  async run(): Promise<LancementReport> {
    // 1. Les dépôts : un seul réseau, les trois sortes, un seul agent. Sinon rien ne tourne.
    const networks = await this.depots.networks();
    if (networks.length === 0) return this.stop(null, 'no_files');
    if (networks.length > 1) return this.stop(null, 'several_networks');
    const networkId = networks[0] as string;
    const depots = await this.depots.latest(networkId);
    if (TOOL_FILES.some((tool) => !depots.some((d) => d.tool === tool))) return this.stop(networkId, 'missing_files');
    const agents = new Set(depots.map((d) => d.agentId));
    if (agents.size !== 1) return this.stop(networkId, 'several_agents');
    const agentId = [...agents][0] as string;

    // 2. Tout lire avant la première écriture : les trois fichiers, puis le site en lecture seule.
    const files = await this.depots.files(depots);
    const batches = {} as Record<LancementSource, ImportBatch>;
    for (const tool of TOOL_FILES) {
      const depot = depots.find((d) => d.tool === tool) as DepotInfo;
      batches[tool] = await readToolCsv(files[tool], tool, new Date(depot.depositedAt));
    }
    const siteReading = await readSiteContacts(readOnly(this.site));
    batches.site = { contacts: siteReading.contacts, skipped: siteReading.skipped, flagged: siteReading.flagged };

    // 3. L'avancement vaut pour ces dépôts : de nouveaux fichiers font repartir du début. La lecture du site, base en
    //    service, change entre deux lancements (nouvelles demandes) : la position dans les fichiers est gardée, et la
    //    source « site » est refaite en entier à la fin (`site_again`), ce qui ne double rien (I02).
    const depotsFp = await sha256Hex(JSON.stringify(depots.map((d) => d.id)));
    const siteFp = await sha256Hex(JSON.stringify(siteReading.contacts.map((c) => c.origin)));
    const saved = await this.progress(networkId);
    const fiches = new FicheClient(this.db, { now: this.now });
    const unique = new FicheUnique(this.db, fiches, { now: this.now });
    const reprise = new RepriseSite(this.db, fiches, unique, new DecisionEnvoi(this.db, fiches, unique, { now: this.now }), this.journal, { networkId, agentId, actor: this.actor, now: this.now });
    const reelle = new RepriseReelle(this.db, reprise, unique, this.journal, {
      networkId,
      actor: this.actor,
      now: this.now,
      ...(this.options.random ? { random: this.options.random } : {}),
    });
    const all: ImportedContact[] = LANCEMENT_SOURCES.flatMap((s) => batches[s].contacts);
    const same = saved !== null && saved.depotsFp === depotsFp;
    if (same && saved.doneAt !== null && saved.siteFp === siteFp) {
      // Déjà fini sur ces mêmes données : le contrôle est refait, rien n'est écrit.
      return { state: 'done', networkId, totals: saved.totals, control: await reelle.control(all), already: true };
    }
    let progress: Progress;
    if (!same) {
      progress = { depotsFp, siteFp, source: 'site', position: 0, totals: {}, doneAt: null };
      await appendEvent(this.journal, { type: 'reprise.lancement', actor: this.actor, subject: `network:${networkId}`, data: { start: true, ...this.counts(batches) } }, this.now);
    } else if (saved.doneAt !== null) {
      // Fini, mais le site a reçu de nouveaux contacts : seule la source « site » est refaite.
      progress = { ...saved, source: 'site_again', position: 0, siteFp, doneAt: null };
    } else if (saved.siteFp !== siteFp && (saved.source === 'site' || saved.source === 'site_again')) {
      // En pleine source « site » sur une lecture qui a changé : cette source repart de zéro, sur la nouvelle lecture.
      progress = { ...saved, siteFp, position: 0 };
    } else {
      progress = saved;
    }

    // 4. Les sources dans l'ordre, morceau par morceau, l'avancement rangé après chacun.
    for (let s = STEPS.indexOf(progress.source); s < STEPS.length; s++) {
      const source = STEPS[s] as LancementStep;
      // La source « site » n'est refaite que si sa lecture a changé depuis qu'elle a été faite.
      if (source === 'site_again' && progress.source !== 'site_again') {
        if (progress.siteFp === siteFp) break;
        progress = { ...progress, source, position: 0, siteFp };
      }
      const batch = batches[source === 'site_again' ? 'site' : source];
      let position = source === progress.source ? progress.position : 0;
      while (position < batch.contacts.length || (position === 0 && batch.contacts.length === 0)) {
        if (!this.timeLeft()) {
          await this.save(networkId, { ...progress, source, position });
          return { state: 'to_continue', networkId, source, position, totals: progress.totals };
        }
        const first = position === 0;
        // Les nombres de la lecture (lignes signalées, écartées) ne comptent qu'avec le premier morceau.
        const slice: ImportBatch = {
          contacts: batch.contacts.slice(position, position + this.chunk),
          skipped: first ? batch.skipped : { suspect: 0, test: 0 },
          flagged: first ? batch.flagged : 0,
          unreadableLines: first ? (batch.unreadableLines ?? []) : [],
          partialLines: first ? (batch.partialLines ?? []) : [],
        };
        const report = await reprise.run(slice, source === 'site_again' ? 'site' : source);
        position = Math.min(batch.contacts.length, position + this.chunk);
        const before = source === 'site_again' && first ? zero() : (progress.totals[source] ?? zero());
        progress = { ...progress, source, position, totals: { ...progress.totals, [source]: add(before, report) } };
        await this.save(networkId, progress);
        if (batch.contacts.length === 0) break;
      }
      const next = STEPS[s + 1];
      if (next && next !== 'site_again') {
        progress = { ...progress, source: next, position: 0 };
        await this.save(networkId, progress);
      }
    }

    // 5. Le contrôle sur 50 personnes, écrit au journal (des nombres), puis la fin rangée.
    const control = await reelle.control(all);
    await appendEvent(this.journal, { type: 'reprise.controle', actor: this.actor, subject: null, data: { ...control } }, this.now);
    await this.save(networkId, { ...progress, doneAt: this.now().toISOString() });
    return { state: 'done', networkId, totals: progress.totals, control, already: false };
  }

  private counts(batches: Record<LancementSource, ImportBatch>): Record<string, number> {
    const out: Record<string, number> = {};
    for (const s of LANCEMENT_SOURCES) out[s] = batches[s].contacts.length;
    return out;
  }

  private async stop(networkId: string | null, code: 'no_files' | 'missing_files' | 'several_networks' | 'several_agents'): Promise<LancementReport> {
    await appendEvent(this.journal, { type: 'reprise.lancement', actor: this.actor, subject: networkId === null ? null : `network:${networkId}`, data: { stopped: code } }, this.now);
    return { state: 'stopped', code };
  }

  private async progress(networkId: string): Promise<Progress | null> {
    const row = await this.db.first<{ fingerprint: string; source: string; position: number; totals: string; done_at: string | null }>(
      'SELECT fingerprint, source, position, totals, done_at FROM reprise_avancement WHERE network_id = ?',
      [networkId],
    );
    if (!row || !(STEPS as readonly string[]).includes(row.source)) return null;
    const [depotsFp = '', siteFp = ''] = row.fingerprint.split(':');
    return { depotsFp, siteFp, source: row.source as LancementStep, position: Number(row.position), totals: JSON.parse(row.totals) as Progress['totals'], doneAt: row.done_at };
  }

  private async save(networkId: string, p: Progress): Promise<void> {
    await this.db.run(
      `INSERT INTO reprise_avancement (network_id, fingerprint, source, position, totals, updated_at, done_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (network_id) DO UPDATE SET fingerprint = excluded.fingerprint, source = excluded.source, position = excluded.position,
         totals = excluded.totals, updated_at = excluded.updated_at, done_at = excluded.done_at`,
      [networkId, `${p.depotsFp}:${p.siteFp}`, p.source, p.position, JSON.stringify(p.totals), this.now().toISOString(), p.doneAt],
    );
  }
}
