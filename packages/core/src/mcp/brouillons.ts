/**
 * Brouillons de l'assistant de l'agent (HX55) [R591, R16, R13, R17].
 *
 * Un outil du serveur MCP n'écrit jamais rien de définitif : il range un brouillon « à valider ». Seul l'agent du
 * brouillon le valide ou le refuse, depuis l'application, sous ses propres droits revérifiés à ce moment-là : un
 * agent parti, ou qui ne suit plus la fiche ou le bien, ne valide plus rien. Le serveur MCP n'a aucun outil pour
 * décider (voir `serveur.ts`).
 *
 * Un brouillon validé est la décision de l'agent, rangée et datée. Décidé, lecture prudente : il ne change pas encore
 * la fiche ni le bien. Un prix publié ne change pas sans avenant signé au mandat [R44], une note se range dans la fiche par son
 * module : ce branchement est une tâche à part.
 */
import type { Acces } from '../acces/acces.ts';
import type { Viewer } from '../acces/droits.ts';
import { agentState } from '../acces/etat-agent.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';

export type DraftKind = 'note' | 'prix';
export type DraftStatus = 'a_valider' | 'valide' | 'refuse';

export interface Draft {
  id: string;
  kind: DraftKind;
  /** `person:<id>` ou `property:<id>`, jamais un nom. */
  subject: string;
  /** Le texte de la note, ou le prix proposé en euros. */
  content: { text: string } | { priceEur: number };
  status: DraftStatus;
  createdAt: string;
  decidedAt: string | null;
}

export type DraftRefusal = { ok: false; rule: 'R16' | 'R591'; code: string };
export type DraftResult<T> = { ok: true; value: T } | DraftRefusal;

export const NOTE_MAX_CHARS = 2000;
export const PRICE_MAX_EUR = 100_000_000;
const ID = /^[A-Za-z0-9_-]{1,64}$/;
// Aucun caractère de contrôle hors du retour à la ligne et de la tabulation.
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

export interface BrouillonsOptions {
  now?: () => Date;
  newId?: () => string;
}

interface DraftRow {
  id: string;
  network_id: string;
  agent_id: string;
  kind: DraftKind;
  subject: string;
  payload: string;
  status: DraftStatus;
  created_at: string;
  decided_at: string | null;
}

/** Le texte d'une note : 1 à 2 000 caractères, sans caractère de contrôle. `null` sinon. */
export function parseNoteText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (text.length === 0 || text.length > NOTE_MAX_CHARS || CONTROL.test(text)) return null;
  return text;
}

/** Un prix proposé : un nombre entier d'euros, de 1 à 100 millions. `null` sinon. */
export function parsePrice(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > PRICE_MAX_EUR) return null;
  return value;
}

export class Brouillons {
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(
    private readonly db: SqlDatabase,
    private readonly acces: Acces,
    private readonly journal: JournalStore,
    options: BrouillonsOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => crypto.randomUUID());
  }

  /** Une note proposée pour une fiche que l'agent suit lui-même, rangée « à valider » [R591]. */
  async draftNote(viewer: Viewer, personId: unknown, text: unknown): Promise<DraftResult<Draft>> {
    if (viewer.role !== 'agent') return this.refused(viewer, 'R16', 'role', null);
    if (typeof personId !== 'string' || !ID.test(personId)) return this.refused(viewer, 'R591', 'bad_input', null);
    const note = parseNoteText(text);
    if (note === null) return this.refused(viewer, 'R591', 'bad_input', `person:${personId}`);
    const read = await this.acces.readFiche(viewer, personId);
    if (!read.ok) return { ok: false, rule: 'R16', code: read.code };
    if (read.view !== 'full') return this.refused(viewer, 'R16', 'not_assigned', `person:${personId}`);
    // Une fiche réunie : la note va à la fiche gardée.
    return this.insert(viewer, 'note', `person:${read.value.person.id}`, { text: note });
  }

  /** Un prix proposé pour un bien que l'agent tient lui-même, jamais un bien du fichier commun [R16, R591]. */
  async draftPrice(viewer: Viewer, propertyId: unknown, priceEur: unknown): Promise<DraftResult<Draft>> {
    if (viewer.role !== 'agent') return this.refused(viewer, 'R16', 'role', null);
    if (typeof propertyId !== 'string' || !ID.test(propertyId)) return this.refused(viewer, 'R591', 'bad_input', null);
    const price = parsePrice(priceEur);
    if (price === null) return this.refused(viewer, 'R591', 'bad_input', `property:${propertyId}`);
    const read = await this.acces.readProperty(viewer, propertyId);
    if (!read.ok) return { ok: false, rule: 'R16', code: read.code };
    if (read.view !== 'full' || read.value.agent_id !== viewer.userId) return this.refused(viewer, 'R16', 'not_assigned', `property:${propertyId}`);
    return this.insert(viewer, 'prix', `property:${propertyId}`, { priceEur: price });
  }

  /** Les brouillons de l'agent lui-même, du plus récent au plus ancien ; 50 au plus. */
  async listOwn(viewer: Viewer): Promise<DraftResult<Draft[]>> {
    if (viewer.role !== 'agent') return this.refused(viewer, 'R16', 'role', null);
    if (!(await this.activeAgent(viewer))) return this.refused(viewer, 'R16', 'agent_inactive', null);
    const rows = await this.db.all<DraftRow>(
      'SELECT * FROM mcp_drafts WHERE network_id = ? AND agent_id = ? ORDER BY created_at DESC, id DESC LIMIT 50',
      [viewer.networkId, viewer.userId],
    );
    await this.write(viewer, 'mcp.brouillons.lus', null, { rule: 'R16', count: rows.length });
    return { ok: true, value: rows.map(toDraft) };
  }

  /**
   * L'agent valide ou refuse son brouillon, depuis l'application. Ses droits sont revérifiés sur le sujet à cet
   * instant : la décision n'est prise que s'il le suit encore [R16, R591]. Une décision ne change plus.
   */
  async decide(viewer: Viewer, draftId: unknown, decision: unknown): Promise<DraftResult<Draft>> {
    if (viewer.role !== 'agent') return this.refused(viewer, 'R16', 'role', null);
    if (typeof draftId !== 'string' || !ID.test(draftId)) return this.refused(viewer, 'R591', 'bad_input', null);
    if (decision !== 'valide' && decision !== 'refuse') return this.refused(viewer, 'R591', 'bad_input', `mcp_draft:${draftId}`);
    const subject = `mcp_draft:${draftId}`;
    const row = await this.db.first<DraftRow>('SELECT * FROM mcp_drafts WHERE id = ?', [draftId]);
    if (!row || row.network_id !== viewer.networkId || row.agent_id !== viewer.userId) return this.refused(viewer, 'R16', 'not_assigned', subject);
    if (row.status !== 'a_valider') return this.refused(viewer, 'R591', 'already_decided', subject);
    if (decision === 'valide' && !(await this.stillHolds(viewer, row))) return this.refused(viewer, 'R16', 'not_assigned', subject);
    if (decision === 'refuse' && !(await this.activeAgent(viewer))) return this.refused(viewer, 'R16', 'agent_inactive', subject);
    const at = this.now().toISOString();
    await this.write(viewer, decision === 'valide' ? 'mcp.brouillon.valide' : 'mcp.brouillon.refuse', subject, {
      rule: 'R591',
      kind: row.kind,
      about: row.subject,
    });
    const done = await this.db.run(
      "UPDATE mcp_drafts SET status = ?, decided_at = ?, decided_by = ? WHERE id = ? AND status = 'a_valider'",
      [decision, at, viewer.userId, draftId],
    );
    // Une autre décision est passée entre la lecture et l'écriture : la première l'emporte.
    if (done.changes !== 1) return this.refused(viewer, 'R591', 'already_decided', subject);
    return { ok: true, value: toDraft({ ...row, status: decision, decided_at: at }) };
  }

  private async stillHolds(viewer: Viewer, row: DraftRow): Promise<boolean> {
    const [kind, id] = [row.subject.slice(0, row.subject.indexOf(':')), row.subject.slice(row.subject.indexOf(':') + 1)];
    if (kind === 'person') {
      const read = await this.acces.readFiche(viewer, id!);
      return read.ok && read.view === 'full';
    }
    const read = await this.acces.readProperty(viewer, id!);
    return read.ok && read.view === 'full' && read.value.agent_id === viewer.userId;
  }

  /** L'agent existe dans ce réseau, en activité : `readProperty` sur un bien inexistant ne le dirait pas. */
  private async activeAgent(viewer: Viewer): Promise<boolean> {
    const agent = await this.db.first<{ status: string }>('SELECT status FROM agents WHERE id = ? AND network_id = ?', [viewer.userId, viewer.networkId]);
    if (!agent || agent.status !== 'active') return false;
    return (await agentState(this.db, viewer.networkId, viewer.userId, this.now())) !== 'parti';
  }

  private async insert(viewer: Viewer, kind: DraftKind, subject: string, content: Draft['content']): Promise<DraftResult<Draft>> {
    const id = this.newId();
    const at = this.now().toISOString();
    // Le journal d'abord : sans lui, rien n'est rangé [R13].
    await this.write(viewer, 'mcp.brouillon.range', `mcp_draft:${id}`, { rule: 'R591', kind, about: subject });
    await this.db.run(
      "INSERT INTO mcp_drafts (id, network_id, agent_id, kind, subject, payload, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'a_valider', ?)",
      [id, viewer.networkId, viewer.userId, kind, subject, JSON.stringify(content), at],
    );
    return { ok: true, value: { id, kind, subject, content, status: 'a_valider', createdAt: at, decidedAt: null } };
  }

  private async refused(viewer: Viewer, rule: 'R16' | 'R591', code: string, subject: string | null): Promise<DraftRefusal> {
    await this.write(viewer, 'mcp.refus', subject, { rule, code, role: String(viewer.role) });
    return { ok: false, rule, code };
  }

  private async write(viewer: Viewer, type: string, subject: string | null, data: Record<string, string | number>): Promise<void> {
    await appendEvent(this.journal, { type, actor: `${String(viewer.role)}:${viewer.userId}`, subject, data }, this.now);
  }
}

function toDraft(row: DraftRow): Draft {
  const parsed = JSON.parse(row.payload) as { text?: unknown; priceEur?: unknown };
  const content: Draft['content'] = row.kind === 'note' ? { text: String(parsed.text) } : { priceEur: Number(parsed.priceEur) };
  return { id: row.id, kind: row.kind, subject: row.subject, content, status: row.status, createdAt: row.created_at, decidedAt: row.decided_at };
}
