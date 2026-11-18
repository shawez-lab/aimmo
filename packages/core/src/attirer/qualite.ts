/**
 * La qualité professionnelle écrite à côté du nom d'un agent (AU012) [R07, R152].
 *
 * Un agent d'AIMMO est un agent commercial habilité par le titulaire de la carte professionnelle du réseau : il n'a pas
 * de carte à son nom. Le titre écrit à côté de son nom ne vient donc plus d'un texte en dur : c'est un réglage de la
 * direction, pris dans une liste fermée, rangé avec son auteur et sa date, jamais réécrit. Aucun titre de la liste ne
 * dit « mandataire » [R07] ni ne fait de l'agent le titulaire d'une carte : la carte reste celle du titulaire, dite dans
 * la phrase des mentions [R152].
 *
 * Tant que rien n'est réglé, le titre reste « agent immobilier », la règle R07 de Shawez : le texte affiché ne change
 * pas avant que l'avocat ait dit quel titre convient à un agent commercial sans carte personnelle (H24).
 */
import type { Viewer } from '../acces/droits.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';

/** Les titres que la direction peut choisir, en minuscules, tels qu'ils suivent le nom de l'agent. */
export const PROFESSIONAL_TITLES = ['agent immobilier', 'agent commercial en immobilier', 'conseiller immobilier'] as const;
export type ProfessionalTitle = (typeof PROFESSIONAL_TITLES)[number];

/** Le titre tant que la direction n'a rien réglé : la règle R07, inchangée en attendant l'avocat (H24). */
export const DEFAULT_PROFESSIONAL_TITLE: ProfessionalTitle = 'agent immobilier';

/** Le statut légal d'un agent : celui que rangent ses mentions (AT03), ou inconnu tant qu'elles manquent. */
export type AgentLegalStatus = 'agent_commercial' | 'inconnu';

/**
 * Le titre d'un agent selon son statut et le réglage du réseau. Ni un statut inconnu ni un réglage abîmé ne donnent un
 * titre hors de la liste : un agent n'est jamais qualifié d'office de titulaire de carte.
 */
export function titleFor(_status: AgentLegalStatus, setting: string | null | undefined): ProfessionalTitle {
  return isProfessionalTitle(setting) ? setting : DEFAULT_PROFESSIONAL_TITLE;
}

export function isProfessionalTitle(value: unknown): value is ProfessionalTitle {
  return typeof value === 'string' && (PROFESSIONAL_TITLES as readonly string[]).includes(value);
}

/** Le titre en tête de ligne, avec sa majuscule (« Agent immobilier · Dijon »). */
export function capitalizedTitle(title: ProfessionalTitle): string {
  return title.charAt(0).toUpperCase() + title.slice(1);
}

/** Le dernier titre réglé par la direction du réseau, ou `null`. */
export async function networkTitleSetting(db: SqlDatabase, networkId: string): Promise<string | null> {
  const row = await db.first<{ title: string }>('SELECT title FROM agent_title_settings WHERE network_id = ? ORDER BY set_at DESC, id DESC LIMIT 1', [networkId]);
  return row?.title ?? null;
}

/** Le statut légal rangé pour l'agent dans son réseau. */
export async function agentLegalStatus(db: SqlDatabase, networkId: string, agentId: string): Promise<AgentLegalStatus> {
  const row = await db.first<{ legal_status: string }>(
    'SELECT legal_status FROM agent_legal_mentions WHERE agent_id = ? AND network_id = ? ORDER BY set_at DESC, id DESC LIMIT 1',
    [agentId, networkId],
  );
  return row?.legal_status === 'agent_commercial' ? 'agent_commercial' : 'inconnu';
}

/** Le titre écrit à côté du nom de cet agent, partout où il est montré à un client ou au public. */
export async function professionalTitle(db: SqlDatabase, networkId: string, agentId: string): Promise<ProfessionalTitle> {
  return titleFor(await agentLegalStatus(db, networkId, agentId), await networkTitleSetting(db, networkId));
}

export type TitleRefusal = { ok: false; rule: 'R16'; code: 'role' } | { ok: false; rule: 'R07'; code: 'titre_hors_liste' };

/** Le réglage du titre : la direction seule, un titre de la liste, une ligne de plus à chaque changement. */
export class QualiteAgent {
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(
    private readonly db: SqlDatabase,
    private readonly journal: JournalStore,
    options: { now?: () => Date; newId?: () => string } = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => crypto.randomUUID());
  }

  async setTitle(viewer: Viewer, title: unknown): Promise<{ ok: true; value: ProfessionalTitle } | TitleRefusal> {
    if (viewer.role !== 'direction') return this.refuse(viewer);
    if (!isProfessionalTitle(title)) return { ok: false, rule: 'R07', code: 'titre_hors_liste' };
    await this.db.run('INSERT INTO agent_title_settings (id, network_id, title, set_by, set_at) VALUES (?, ?, ?, ?, ?)', [
      this.newId(), viewer.networkId, title, `direction:${viewer.userId}`, this.now().toISOString(),
    ]);
    await appendEvent(this.journal, { type: 'attirer.titre_agent', actor: `direction:${viewer.userId}`, subject: `network:${viewer.networkId}`, data: { rule: 'R07', title } }, this.now);
    return { ok: true, value: title };
  }

  async title(viewer: Viewer): Promise<{ ok: true; value: { setting: ProfessionalTitle | null; shown: ProfessionalTitle; choices: readonly ProfessionalTitle[] } } | TitleRefusal> {
    if (viewer.role !== 'direction') return this.refuse(viewer);
    const setting = await networkTitleSetting(this.db, viewer.networkId);
    return { ok: true, value: { setting: isProfessionalTitle(setting) ? setting : null, shown: titleFor('agent_commercial', setting), choices: PROFESSIONAL_TITLES } };
  }

  private async refuse(viewer: Viewer): Promise<TitleRefusal> {
    await appendEvent(
      this.journal,
      { type: 'acces.refuse', actor: `${String(viewer.role)}:${viewer.userId}`, subject: `network:${viewer.networkId}`, data: { rule: 'R16', role: String(viewer.role), kind: 'agent_title', code: 'role' } },
      this.now,
    );
    return { ok: false, rule: 'R16', code: 'role' };
  }
}
