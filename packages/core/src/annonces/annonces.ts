/**
 * Annonce rédigée par l'IA, sourcée, validée par l'agent du bien (M07, P03) [R46, R47].
 *
 * L'IA, derrière une interface, propose un titre et un texte à partir des seules données contrôlées du bien
 * (`ListingFacts` : ni nom, ni coordonnée, ni adresse, ni texte libre [R15]). Le code contrôle chaque phrase
 * (annonce sourcée) ; un texte de l'IA refusé n'est pas gardé, le texte de secours fait par le code le remplace, et la
 * raison du refus est rendue à l'agent. L'agent peut corriger le texte, contrôlé de la même façon. Les mentions
 * obligatoires ne sont jamais dans ce texte : le code les place (P02).
 *
 * Seul l'agent du bien valide [R47], et seulement le dernier brouillon, contrôlé sur la dernière version de la fiche,
 * quand la liste de contrôle des mentions est complète [R43]. Une nouvelle version de la fiche ou un nouveau brouillon
 * rend la validation caduque : il faut valider de nouveau.
 */
import type { Acces } from '../acces/acces.ts';
import type { Viewer } from '../acces/droits.ts';
import type { SqlDatabase } from '../db/sql.ts';
import type { PropertyKind } from '../db/types.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import { bindingHolds, fallbackListing, traceListing, type ListingFacts, type SourcedSentence } from './annonce-sourcee.ts';
import type { PropertySheet } from './fiche-bien.ts';
import { computeMentions, MentionsAnnonce, type MentionItem } from './mentions.ts';

/** L'IA qui rédige. Absente, trop lente, en panne ou refusée par le contrôle : texte de secours. */
export interface ListingWriter {
  write(facts: ListingFacts): Promise<{ title: string; body: string }>;
}

export type DraftOrigin = 'ia' | 'secours' | 'agent';

export interface ListingDraft {
  id: string;
  propertyId: string;
  seq: number;
  title: string;
  body: string;
  origin: DraftOrigin;
  sheetVersion: number | null;
  sentences: SourcedSentence[];
  createdBy: string;
  createdAt: string;
  validated: { by: string; at: string } | null;
}

type Refusal = { ok: false; rule: 'R16'; code: string };
type Problem =
  | { ok: false; rule: null; code: 'unknown_property' | 'unknown_draft' | 'no_draft' | 'bad_text' | 'busy' }
  | { ok: false; rule: 'R46' | 'R47'; code: 'refused_text'; sentences: SourcedSentence[] }
  | { ok: false; rule: 'R47'; code: 'not_latest_draft' | 'stale_sheet' | 'already_validated' }
  | { ok: false; rule: 'R43'; code: 'mentions_incomplete'; missing: MentionItem[] };

const MAX_TITLE = 120;
const MAX_BODY = 3000;
const AI_TIMEOUT_MS = 20_000;

interface DraftRow {
  id: string;
  property_id: string;
  seq: number;
  title: string;
  body: string;
  origin: DraftOrigin;
  sheet_version: number | null;
  trace: string;
  created_by: string;
  created_at: string;
  validated_by: string | null;
  validated_at: string | null;
}

const DRAFT_SELECT = `SELECT d.id, d.property_id, d.seq, d.title, d.body, d.origin, d.sheet_version, d.trace, d.created_by, d.created_at,
  v.validated_by, v.validated_at FROM listing_drafts d LEFT JOIN listing_validations v ON v.draft_id = d.id`;

const toDraft = (r: DraftRow): ListingDraft => ({
  id: r.id,
  propertyId: r.property_id,
  seq: Number(r.seq),
  title: r.title,
  body: r.body,
  origin: r.origin,
  sheetVersion: r.sheet_version === null ? null : Number(r.sheet_version),
  sentences: JSON.parse(r.trace) as SourcedSentence[],
  createdBy: r.created_by,
  createdAt: r.created_at,
  validated: r.validated_by && r.validated_at ? { by: r.validated_by, at: r.validated_at } : null,
});

/** Le problème le plus grave d'un texte refusé : une adresse ou un critère discriminant [R46], sinon une invention [R47]. */
const refusalRule = (sentences: SourcedSentence[]): 'R46' | 'R47' =>
  sentences.some((s) => s.problems.some((p) => p.code === 'adresse' || p.code === 'critere_discriminant')) ? 'R46' : 'R47';

export class Annonces {
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly writer: ListingWriter | null;
  private readonly timeoutMs: number;
  private readonly mentions: MentionsAnnonce;

  constructor(
    private readonly db: SqlDatabase,
    private readonly acces: Acces,
    private readonly journal: JournalStore,
    options: { now?: () => Date; newId?: () => string; writer?: ListingWriter; timeoutMs?: number } = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => crypto.randomUUID());
    this.writer = options.writer ?? null;
    this.timeoutMs = options.timeoutMs ?? AI_TIMEOUT_MS;
    this.mentions = new MentionsAnnonce(db, acces, journal, { now: this.now });
  }

  private actor(viewer: Viewer): string {
    return `${String(viewer.role)}:${viewer.userId}`;
  }

  private async refuse(viewer: Viewer, propertyId: string, code: string): Promise<Refusal> {
    await appendEvent(this.journal, { type: 'acces.refuse', actor: this.actor(viewer), subject: `property:${propertyId}`, data: { rule: 'R16', role: String(viewer.role), kind: 'listing', code } }, this.now);
    return { ok: false, rule: 'R16', code };
  }

  /** Qui voit le bien en entier lit ; seuls l'agent du bien et la direction écrivent ; seul l'agent du bien valide. */
  private async gate(viewer: Viewer, propertyId: string, need: 'read' | 'write' | 'validate'): Promise<{ ok: true; networkId: string } | Refusal | Problem> {
    const p = await this.acces.readProperty(viewer, propertyId);
    if (!p.ok) return p.code === 'unknown' ? { ok: false, rule: null, code: 'unknown_property' } : (p as Refusal);
    if (p.view !== 'full') return this.refuse(viewer, propertyId, 'not_assigned');
    if (need === 'write' && viewer.role !== 'agent' && viewer.role !== 'direction') return this.refuse(viewer, propertyId, 'role');
    if (need === 'validate' && (viewer.role !== 'agent' || p.value.agent_id !== viewer.userId)) return this.refuse(viewer, propertyId, 'role');
    return { ok: true, networkId: p.value.network_id };
  }

  /** Les faits du bien que l'IA et le contrôle connaissent, et la version de la fiche d'où ils viennent. */
  async factsFor(propertyId: string): Promise<{ facts: ListingFacts; sheetVersion: number | null } | null> {
    const p = await this.db.first<{ kind: PropertyKind; city: string | null; postal_code: string | null; surface_m2: number | null; rooms: number | null }>(
      'SELECT kind, city, postal_code, surface_m2, rooms FROM properties WHERE id = ?',
      [propertyId],
    );
    if (!p) return null;
    const row = await this.db.first<{ version: number; data: string }>('SELECT version, data FROM property_sheets WHERE property_id = ? ORDER BY version DESC LIMIT 1', [propertyId]);
    const sheet = row ? (JSON.parse(row.data) as PropertySheet) : null;
    const c = sheet?.characteristics;
    const facts: ListingFacts = {
      kind: p.kind,
      city: p.city,
      postalCode: p.postal_code,
      surfaceM2: p.surface_m2 === null ? null : Number(p.surface_m2),
      rooms: p.rooms === null ? null : Number(p.rooms),
      bedrooms: c?.bedrooms ?? null,
      floor: c?.floor ?? null,
      floorsTotal: c?.floorsTotal ?? null,
      buildYear: c?.buildYear ?? null,
      heating: c?.heating ?? null,
      outdoor: c?.outdoor ?? [],
      landM2: c?.landM2 ?? null,
      parkingSpaces: c?.parkingSpaces ?? null,
      elevator: c?.elevator ?? null,
      energyClass: sheet?.energy?.energyClass ?? null,
      climateClass: sheet?.energy?.climateClass ?? null,
    };
    return { facts, sheetVersion: row ? Number(row.version) : null };
  }

  private async askWriter(facts: ListingFacts): Promise<{ title: string; body: string } | null> {
    if (!this.writer) return null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // L'IA reçoit une copie des seuls faits : elle ne peut rien changer, ni rien recevoir d'autre [R15].
      const out = await Promise.race([
        this.writer.write(structuredClone(facts)),
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), this.timeoutMs);
        }),
      ]);
      if (!out || typeof out.title !== 'string' || typeof out.body !== 'string') return null;
      const title = out.title.trim();
      const body = out.body.trim();
      if (title === '' || body === '' || title.length > MAX_TITLE || body.length > MAX_BODY) return null;
      return { title, body };
    } catch {
      return null;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async store(viewer: Viewer, networkId: string, propertyId: string, text: { title: string; body: string }, origin: DraftOrigin, sheetVersion: number | null, sentences: SourcedSentence[]): Promise<ListingDraft | null> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const id = this.newId();
      try {
        await this.db.run(
          `INSERT INTO listing_drafts (id, property_id, network_id, seq, title, body, origin, sheet_version, trace, created_by, created_at)
           SELECT ?, ?, ?, COALESCE(MAX(seq), 0) + 1, ?, ?, ?, ?, ?, ?, ? FROM listing_drafts WHERE property_id = ?`,
          [id, propertyId, networkId, text.title, text.body, origin, sheetVersion, JSON.stringify(sentences), this.actor(viewer), this.now().toISOString(), propertyId],
        );
      } catch (error) {
        if (/UNIQUE/i.test(String(error))) continue;
        throw error;
      }
      const row = await this.db.first<DraftRow>(`${DRAFT_SELECT} WHERE d.id = ?`, [id]);
      if (!row) continue;
      const draft = toDraft(row);
      await appendEvent(this.journal, { type: 'annonce.brouillon', actor: this.actor(viewer), subject: `property:${propertyId}`, data: { rule: 'R47', seq: draft.seq, origin } }, this.now);
      return draft;
    }
    return null;
  }

  /**
   * L'IA propose un texte ; le code le contrôle. Refusé, il n'est pas gardé : le texte de secours le remplace, et
   * les phrases refusées sont rendues à l'agent avec leurs problèmes.
   */
  async propose(viewer: Viewer, propertyId: string): Promise<{ ok: true; value: ListingDraft; aiRefused: SourcedSentence[] | null } | Refusal | Problem> {
    const g = await this.gate(viewer, propertyId, 'write');
    if (!g.ok) return g;
    const f = await this.factsFor(propertyId);
    if (!f) return { ok: false, rule: null, code: 'unknown_property' };
    let aiRefused: SourcedSentence[] | null = null;
    const ai = await this.askWriter(f.facts);
    if (ai) {
      const trace = traceListing(ai.title, ai.body, f.facts);
      if (trace.ok) {
        const draft = await this.store(viewer, g.networkId, propertyId, ai, 'ia', f.sheetVersion, trace.sentences);
        return draft ? { ok: true, value: draft, aiRefused: null } : { ok: false, rule: null, code: 'busy' };
      }
      aiRefused = trace.sentences.filter((s) => s.problems.length > 0);
      // Au journal : les codes des problèmes seulement, jamais le texte.
      await appendEvent(this.journal, { type: 'annonce.ia_refusee', actor: this.actor(viewer), subject: `property:${propertyId}`, data: { rule: refusalRule(aiRefused), codes: [...new Set(aiRefused.flatMap((s) => s.problems.map((p) => p.code)))] } }, this.now);
    }
    const fallback = fallbackListing(f.facts);
    const trace = traceListing(fallback.title, fallback.body, f.facts);
    // Le texte de secours passe toujours le contrôle ; s'il ne le passait pas, rien n'est rangé.
    if (!trace.ok) return { ok: false, rule: refusalRule(trace.sentences), code: 'refused_text', sentences: trace.sentences.filter((s) => s.problems.length > 0) };
    const draft = await this.store(viewer, g.networkId, propertyId, fallback, 'secours', f.sheetVersion, trace.sentences);
    return draft ? { ok: true, value: draft, aiRefused } : { ok: false, rule: null, code: 'busy' };
  }

  /** L'agent corrige le texte : il est contrôlé de la même façon, phrase par phrase. */
  async correct(viewer: Viewer, propertyId: string, text: { title: unknown; body: unknown }): Promise<{ ok: true; value: ListingDraft } | Refusal | Problem> {
    const g = await this.gate(viewer, propertyId, 'write');
    if (!g.ok) return g;
    if (typeof text.title !== 'string' || typeof text.body !== 'string') return { ok: false, rule: null, code: 'bad_text' };
    const title = text.title.trim();
    const body = text.body.trim();
    if (title === '' || body === '' || title.length > MAX_TITLE || body.length > MAX_BODY) return { ok: false, rule: null, code: 'bad_text' };
    const f = await this.factsFor(propertyId);
    if (!f) return { ok: false, rule: null, code: 'unknown_property' };
    const trace = traceListing(title, body, f.facts);
    if (!trace.ok) {
      const refused = trace.sentences.filter((s) => s.problems.length > 0);
      await appendEvent(this.journal, { type: 'annonce.texte_refuse', actor: this.actor(viewer), subject: `property:${propertyId}`, data: { rule: refusalRule(refused), codes: [...new Set(refused.flatMap((s) => s.problems.map((p) => p.code)))] } }, this.now);
      return { ok: false, rule: refusalRule(refused), code: 'refused_text', sentences: refused };
    }
    const draft = await this.store(viewer, g.networkId, propertyId, { title, body }, 'agent', f.sheetVersion, trace.sentences);
    return draft ? { ok: true, value: draft } : { ok: false, rule: null, code: 'busy' };
  }

  /** Le dernier brouillon du bien, avec ses phrases sourcées et sa validation. */
  async read(viewer: Viewer, propertyId: string): Promise<{ ok: true; value: ListingDraft } | Refusal | Problem> {
    const g = await this.gate(viewer, propertyId, 'read');
    if (!g.ok) return g;
    const row = await this.db.first<DraftRow>(`${DRAFT_SELECT} WHERE d.property_id = ? ORDER BY d.seq DESC LIMIT 1`, [propertyId]);
    return row ? { ok: true, value: toDraft(row) } : { ok: false, rule: null, code: 'no_draft' };
  }

  /**
   * L'agent du bien valide le dernier brouillon [R47]. Il doit avoir été contrôlé sur la dernière version de la
   * fiche, passer encore le contrôle, et la liste des mentions doit être complète [R43].
   */
  async validate(viewer: Viewer, draftId: string): Promise<{ ok: true; value: ListingDraft } | Refusal | Problem> {
    const row = await this.db.first<DraftRow & { network_id: string }>(`${DRAFT_SELECT.replace('SELECT d.id,', 'SELECT d.network_id, d.id,')} WHERE d.id = ?`, [draftId]);
    if (!row || row.network_id !== viewer.networkId) {
      await appendEvent(this.journal, { type: 'acces.refuse', actor: this.actor(viewer), subject: `listing:${draftId}`, data: { rule: 'R16', role: String(viewer.role), kind: 'listing', code: 'unknown' } }, this.now);
      return { ok: false, rule: null, code: 'unknown_draft' };
    }
    const g = await this.gate(viewer, row.property_id, 'validate');
    if (!g.ok) return g;
    const draft = toDraft(row);
    if (draft.validated) return { ok: false, rule: 'R47', code: 'already_validated' };
    const latest = await this.db.first<{ id: string }>('SELECT id FROM listing_drafts WHERE property_id = ? ORDER BY seq DESC LIMIT 1', [row.property_id]);
    if (latest?.id !== draftId) return { ok: false, rule: 'R47', code: 'not_latest_draft' };
    const f = await this.factsFor(row.property_id);
    if (!f) return { ok: false, rule: null, code: 'unknown_property' };
    if (f.sheetVersion !== draft.sheetVersion) return { ok: false, rule: 'R47', code: 'stale_sheet' };
    const trace = traceListing(draft.title, draft.body, f.facts);
    if (!trace.ok) return { ok: false, rule: refusalRule(trace.sentences), code: 'refused_text', sentences: trace.sentences.filter((s) => s.problems.length > 0) };
    const input = await this.mentions.inputFor(viewer.networkId, row.property_id);
    if (!input) return { ok: false, rule: null, code: 'unknown_property' };
    const checklist = computeMentions(input);
    if (!checklist.complete) return { ok: false, rule: 'R43', code: 'mentions_incomplete', missing: checklist.items.filter((i) => i.status === 'manquante') };
    const at = this.now().toISOString();
    const { changes } = await this.db.run(
      'INSERT INTO listing_validations (draft_id, property_id, network_id, validated_by, validated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (draft_id) DO NOTHING',
      [draftId, row.property_id, viewer.networkId, this.actor(viewer), at],
    );
    if (changes !== 1) return { ok: false, rule: 'R47', code: 'already_validated' };
    await appendEvent(this.journal, { type: 'annonce.validee', actor: this.actor(viewer), subject: `property:${row.property_id}`, data: { rule: 'R47', seq: draft.seq } }, this.now);
    return { ok: true, value: { ...draft, validated: { by: this.actor(viewer), at } } };
  }

  /**
   * Pour le système qui publie (P04) : le texte validé à publier, ou null. Le dernier brouillon validé compte : une
   * correction en cours, pas encore validée, ne retire pas la version conforme déjà en ligne (AU066). Il reste publié
   * tant que chacune de ses phrases est encore vraie pour la fiche du jour ; un fait changé qui le rend faux ou obsolète
   * le retire [R47].
   */
  async publishable(networkId: string, propertyId: string): Promise<ListingDraft | null> {
    const row = await this.db.first<DraftRow & { network_id: string }>(
      `${DRAFT_SELECT.replace('SELECT d.id,', 'SELECT d.network_id, d.id,')} WHERE d.property_id = ? AND EXISTS (SELECT 1 FROM listing_validations v WHERE v.draft_id = d.id) ORDER BY d.seq DESC LIMIT 1`,
      [propertyId],
    );
    if (!row || row.network_id !== networkId) return null;
    const draft = toDraft(row);
    if (!draft.validated) return null;
    const f = await this.factsFor(propertyId);
    if (!f) return null;
    const fresh = traceListing(draft.title, draft.body, f.facts);
    if (!fresh.ok) return null;
    if (f.sheetVersion === draft.sheetVersion) return draft;
    // La fiche a changé depuis la validation : chaque source rangée doit encore être vraie, dans son champ. Un étage
    // corrigé que le nombre d'étages de l'immeuble « explique » encore rend la phrase fausse ; un autre champ devenu
    // égal ne la rend pas fausse [R47].
    return draft.sentences.every((s) => s.sources.every((x) => bindingHolds(x, f.facts))) ? draft : null;
  }
}
