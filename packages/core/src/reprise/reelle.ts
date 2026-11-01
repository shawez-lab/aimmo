/**
 * Reprise réelle et contrôle sur 50 fiches (I04).
 * Enchaîne, dans l'ordre de `docs/REPRISE.md`, la base du site (lue en lecture seule), la liste d'exclusion de Shawez,
 * GoHighLevel et ManyChat, puis tire au hasard 50 contacts repris et vérifie que chacun a une seule fiche et que
 * toute exclusion connue est bien posée sur ses fiches.
 * Les trois fichiers sont exigés et tous lus avant la première écriture : sans eux, des exclusions seraient perdues
 * [R02, R04]. Le rapport et le journal ne portent que des nombres [R13]. Rien n'est envoyé, rien n'est effacé [R17].
 */
import type { SqlDatabase } from '../db/sql.ts';
import type { FicheUnique } from '../fiche/fusion.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import { readOnly } from './lecture-seule.ts';
import { TOOL_FILES, readToolCsv, type ToolFile } from './outils.ts';
import { contactIdentifiers, lostExclusion, type ImportBatch, type ImportReport, type ImportedContact, type RepriseSite } from './reprise.ts';
import { readSiteContacts } from './site.ts';

/** Nombre de contacts tirés au hasard pour le contrôle (Feuille de route, novembre 2026). */
export const CONTROL_SAMPLE = 50;

/** Les trois exports de Shawez (H15), en texte CSV. */
export type ToolFiles = Record<ToolFile, string>;

export interface RepriseControl {
  /** Contacts repris, parmi lesquels le tirage est fait. */
  population: number;
  /** Contacts tirés : 50, ou tous s'il y en a moins. */
  drawn: number;
  /** Contacts dont l'identifiant mène à plusieurs fiches d'un même agent : une fusion manquée. */
  duplicates: number;
  /** Contacts exclus à la source (liste, désabonnement, « Perdu ») dont une fiche n'a aucune exclusion en cours. */
  missingExclusions: number;
  /** Contacts dont les fiches sont suivies par plusieurs agents : laissées à part, à attribuer par la direction. */
  toAssign: number;
  /** Contacts introuvables après la reprise. */
  missing: number;
  ok: boolean;
}

export interface RepriseReelleReport {
  batches: Record<'site' | ToolFile, ImportReport>;
  control: RepriseControl;
}

export interface RepriseReelleOptions {
  networkId: string;
  actor: string;
  now?: () => Date;
  /** Tirage dans [0, 1[ ; par défaut le hasard cryptographique. */
  random?: () => number;
}

const cryptoRandom = (): number => {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return (buf[0] as number) / 2 ** 32;
};

/** Tire `n` éléments distincts au hasard (Fisher-Yates partiel), sans toucher à la liste reçue. */
export function draw<T>(items: readonly T[], n: number, random: () => number = cryptoRandom): T[] {
  const pool = [...items];
  const count = Math.min(n, pool.length);
  for (let i = 0; i < count; i++) {
    const j = i + Math.floor(random() * (pool.length - i));
    [pool[i], pool[j]] = [pool[j] as T, pool[i] as T];
  }
  return pool.slice(0, count);
}

/** Vrai si la source dit que la personne ne doit plus être démarchée. */
const excludedAtSource = (contact: ImportedContact): boolean =>
  Boolean(contact.exclusion) || contact.requests.some((request) => lostExclusion(request) !== null);

export class RepriseReelle {
  private readonly now: () => Date;
  private readonly random: () => number;

  constructor(
    private readonly db: SqlDatabase,
    private readonly reprise: RepriseSite,
    private readonly fiche: FicheUnique,
    private readonly journal: JournalStore,
    private readonly options: RepriseReelleOptions,
  ) {
    this.now = options.now ?? (() => new Date());
    this.random = options.random ?? cryptoRandom;
  }

  /**
   * Reprend la base du site et les trois fichiers, puis contrôle 50 contacts. Un fichier manquant, vide ou illisible
   * arrête tout avant la première écriture.
   */
  async run(site: SqlDatabase, files: Partial<ToolFiles>): Promise<RepriseReelleReport> {
    const at = this.now();
    const tools: Partial<Record<ToolFile, ImportBatch>> = {};
    for (const tool of TOOL_FILES) {
      const text = files[tool];
      if (typeof text !== 'string' || text.trim() === '') throw new Error(`Reprise réelle : fichier ${tool} manquant ou vide.`);
      tools[tool] = await readToolCsv(text, tool, at);
    }
    const siteReading = await readSiteContacts(readOnly(site));

    const batches = { site: await this.reprise.run(siteReading, 'site') } as RepriseReelleReport['batches'];
    const contacts: ImportedContact[] = [...siteReading.contacts];
    for (const tool of TOOL_FILES) {
      const batch = tools[tool] as ImportBatch;
      batches[tool] = await this.reprise.run(batch, tool);
      contacts.push(...batch.contacts);
    }

    const control = await this.control(contacts);
    await appendEvent(this.journal, { type: 'reprise.controle', actor: this.options.actor, subject: null, data: { ...control } }, this.now);
    return { batches, control };
  }

  /** Contrôle sur 50 contacts tirés au hasard parmi ceux repris. */
  async control(contacts: readonly ImportedContact[]): Promise<RepriseControl> {
    const sample = draw(contacts, CONTROL_SAMPLE, this.random);
    const control: RepriseControl = { population: contacts.length, drawn: sample.length, duplicates: 0, missingExclusions: 0, toAssign: 0, missing: 0, ok: false };
    for (const contact of sample) {
      const roots = await this.rootsOf(contact);
      if (roots.length === 0) {
        control.missing += 1;
        continue;
      }
      if (roots.length > 1) {
        const agents = new Set<string | null>();
        for (const root of roots) agents.add(await this.agentOf(root));
        // Plusieurs fiches d'un même agent : la reprise aurait dû les réunir. D'agents différents : la direction attribue.
        if (agents.size < roots.length) control.duplicates += 1;
        else control.toAssign += 1;
      }
      if (excludedAtSource(contact)) {
        for (const root of roots) {
          if (!(await this.hasActiveExclusion(root))) {
            control.missingExclusions += 1;
            break;
          }
        }
      }
    }
    control.ok = control.duplicates === 0 && control.missingExclusions === 0 && control.missing === 0;
    return control;
  }

  /** Les fiches racines de la personne : celle de son origine, et toutes celles qui portent un de ses identifiants. */
  private async rootsOf(contact: ImportedContact): Promise<string[]> {
    const ids = new Set<string>();
    const origin = await this.db.first<{ target_id: string }>(
      "SELECT target_id FROM import_keys WHERE network_id = ? AND key = ? AND target_kind = 'person'",
      [this.options.networkId, contact.origin],
    );
    if (origin) ids.add(await this.fiche.rootOf(origin.target_id));
    for (const id of contactIdentifiers(contact)) {
      for (const person of await this.fiche.findByIdentifier(this.options.networkId, id.kind, id.value)) ids.add(await this.fiche.rootOf(person.id));
    }
    return [...ids].sort();
  }

  private async agentOf(personId: string): Promise<string | null> {
    return (await this.db.first<{ agent_id: string | null }>('SELECT agent_id FROM persons WHERE id = ?', [personId]))?.agent_id ?? null;
  }

  private async hasActiveExclusion(rootId: string): Promise<boolean> {
    const members = await this.fiche.membersOf(rootId);
    const row = await this.db.first<{ n: number }>(
      `SELECT count(*) AS n FROM exclusions WHERE person_id IN (${members.map(() => '?').join(', ')}) AND lifted_at IS NULL`,
      members,
    );
    return Number(row?.n ?? 0) > 0;
  }
}
