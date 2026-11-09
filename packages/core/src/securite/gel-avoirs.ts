/**
 * Contrôle du gel des avoirs (Sécurité et conformité, HX57) [R13, R16, R17, R603, R604, R605].
 *
 * Chaque partie d'un dossier (mandat, offre, dossier de vente) est comparée au registre national des gels, importé par
 * le responsable de la conformité. Le périmètre est celui du signalement (L05) : l'acquéreur, le vendeur de chaque
 * mandat du bien, leurs fiches réunies (S04) et les bénéficiaires effectifs d'une société.
 *
 * Jamais vu : à chaque nouvelle version du registre, tous les dossiers ouverts sont revérifiés aussitôt, sans attendre
 * qu'un agent y pense ; et une correspondance va au seul responsable, avec la copie figée du dossier à cet instant, sans
 * rien changer à ce que voit le client ni l'agent, comme le signalement de L05. L'agent qui demande un contrôle reçoit
 * toujours le même mot, quel que soit le résultat. Aucun autre code ne lit ces tables (un test le vérifie).
 *
 * Chaque contrôle est daté, avec la version du registre (date de publication et empreinte) et l'empreinte du périmètre
 * contrôlé ; un même périmètre ne se contrôle qu'une fois par version.
 *
 * Décidé, lecture prudente :
 * - les noms sont comparés sans accents, casse ni ponctuation, mot à mot et dans n'importe quel ordre (nom, prénoms,
 *   chaque alias) ; il y a correspondance quand les mots sont les mêmes, ou quand l'un contient tous les mots de
 *   l'autre et que le plus court en a au moins deux. Un seul prénom ne suffit jamais. Dans le doute, l'alerte part : le
 *   responsable seul la juge (fausse correspondance ou correspondance confirmée), avec sa raison, son nom et sa date ;
 * - une fiche sans nom de famille ne peut pas être jugée : le contrôle le dit (« nom manquant »), au responsable seul ;
 * - lettres liées et barrées transcrites (æ → AE, ł → L…) ; un alias dans une autre écriture est laissé, pas le registre ;
 * - un dossier est ouvert tant qu'il n'est pas fini : un mandat sans retrait ni acte signé sur son bien, une offre et un
 *   dossier de vente sans acte ni arrêt ; un acte ne finit un mandat que si son dossier a été ouvert après la signature. Revérifier trop vaut mieux que pas assez ;
 * - « figer » a le sens de L05 : une copie par empreinte, que le responsable compare à tout moment. Le blocage des
 *   fonds et la déclaration à la DG Trésor restent la décision du responsable, hors d'AIMMO ;
 * - le registre arrive par le responsable, déjà lu (identifiant, nature, noms) ; la lecture du fichier public de la DG
 *   Trésor se branchera derrière `importRegistry`, sans rien changer ici ;
 * - au journal, des codes seulement, sous la référence du contrôle, jamais sous la fiche du client, jamais un nom [R13].
 */
import type { Acces } from '../acces/acces.ts';
import type { Viewer } from '../acces/droits.ts';
import { canonical, caseScopeOf, caseSnapshotOf, compareSnapshots, sha256Hex, type CaseScope, type CaseSnapshot, type FrozenCheck } from '../conformite/dossier-fige.ts';
import { FicheClient } from '../db/fiche-client.ts';
import { runBatch, type SqlDatabase, type SqlStatement } from '../db/sql.ts';
import { localTime } from '../envoi/horaires.ts';
import { FicheUnique } from '../fiche/fusion.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';

const TIME_ZONE = 'Europe/Paris';
const CASE_REF = /^(mandate|offer|sale_file):([A-Za-z0-9-]{8,64})$/;
const ENTRY_ID = /^[A-Za-z0-9_.:-]{1,64}$/;
const MAX_ENTRIES = 20000;
const MAX_NAMES = 30;
const MAX_NAME_LENGTH = 200;
// D1 refuse plus de 100 valeurs liées par requête : 25 entrées de 4 valeurs.
const CHUNK = 25;

/** Ce que voit celui qui demande un contrôle : un mot, toujours le même, quel que soit le résultat. */
export const FREEZE_CHECK_STATUS = 'controle_fait';

export type FreezeNature = 'personne_physique' | 'personne_morale';
export const FREEZE_NATURES: readonly FreezeNature[] = ['personne_physique', 'personne_morale'];
export type FreezeResult = 'aucune' | 'correspondance' | 'nom_manquant';
export type FreezeReason = 'demande' | 'mise_a_jour' | 'passage';
export type FreezeDecisionKind = 'fausse_correspondance' | 'correspondance_confirmee';
export const FREEZE_DECISIONS: readonly FreezeDecisionKind[] = ['fausse_correspondance', 'correspondance_confirmee'];

export interface FreezeRegistryEntry {
  entryId: string;
  nature: FreezeNature;
  /** Nom complet, et chaque alias : « Nom Prénom1 Prénom2 ». */
  names: string[];
}

export interface FreezeCheck {
  checkId: string;
  caseRef: string;
  checkedAt: string;
  version: { versionId: string; publishedAt: string; sha256: string };
  scopeSha256: string;
  persons: number;
  result: FreezeResult;
  matches: { personId: string; entryId: string }[];
  unnamed: string[];
  reason: FreezeReason;
}

export interface FreezeMatch {
  matchId: string;
  caseRef: string;
  createdAt: string;
  check: FreezeCheck;
  snapshotSha256: string;
  lines: number;
  decision: { decision: FreezeDecisionKind; reason: string; validatorName: string; decidedOn: string } | null;
}

export type FreezeRefusal = { ok: false; rule: 'R16' | 'R605' | null; code: string };

/** Les mots d'un nom : sans accents, casse ni ponctuation. */
const LIGATURES: Record<string, string> = { æ: 'ae', Æ: 'AE', œ: 'oe', Œ: 'OE', ł: 'l', Ł: 'L', ø: 'o', Ø: 'O', đ: 'd', Đ: 'D', þ: 'th', Þ: 'TH', ß: 'ss', ð: 'd', Ð: 'D', ı: 'i' };

export function nameTokens(text: string | null | undefined): string[] {
  if (typeof text !== 'string') return [];
  const plain = text.replace(/[æÆœŒłŁøØđĐþÞßðÐı]/g, (c) => LIGATURES[c]!).normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ');
  return [...new Set(plain.split(' ').filter((t) => t.length > 0))].sort();
}

/** Deux noms se correspondent : mêmes mots, ou l'un contient tous les mots de l'autre, qui en a au moins deux. */
export function namesMatch(a: readonly string[], b: readonly string[]): boolean {
  if (a.length === 0 || b.length === 0) return false;
  const [small, large] = a.length <= b.length ? [a, b] : [b, a];
  const set = new Set(large);
  if (!small.every((t) => set.has(t))) return false;
  return small.length === large.length || small.length >= 2;
}

interface VersionRow {
  id: string;
  published_at: string;
  sha256: string;
}

interface CheckRow {
  id: string;
  case_ref: string;
  version_id: string;
  scope_sha256: string;
  persons: number;
  result: FreezeResult;
  matches: string;
  unnamed: string;
  reason: FreezeReason;
  checked_at: string;
}

export class ControleGels {
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly fiches: FicheUnique;

  constructor(
    private readonly db: SqlDatabase,
    private readonly acces: Acces,
    private readonly journal: JournalStore,
    options: { now?: () => Date; newId?: () => string } = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => crypto.randomUUID());
    this.fiches = new FicheUnique(db, new FicheClient(db, { now: this.now }), { now: this.now });
  }

  private actor(viewer: Viewer): string {
    return `${String(viewer.role)}:${viewer.userId}`;
  }

  private async refuse(viewer: Viewer, code: string): Promise<FreezeRefusal> {
    await appendEvent(
      this.journal,
      { type: 'acces.refuse', actor: this.actor(viewer), subject: `network:${viewer.networkId}`, data: { rule: 'R16', role: String(viewer.role), kind: 'gel_avoirs', code } },
      this.now,
    );
    return { ok: false, rule: 'R16', code };
  }

  private async latestVersion(networkId: string): Promise<VersionRow | null> {
    return this.db.first<VersionRow>(
      'SELECT id, published_at, sha256 FROM freeze_registry_versions WHERE network_id = ? AND sealed_at IS NOT NULL ORDER BY published_at DESC LIMIT 1',
      [networkId],
    );
  }

  /**
   * Le responsable importe une version du registre, plus récente que la précédente. Elle est scellée, puis chaque
   * dossier ouvert du réseau est revérifié aussitôt contre elle.
   */
  async importRegistry(
    viewer: Viewer,
    input: { publishedAt: unknown; entries: unknown },
  ): Promise<{ ok: true; value: { versionId: string; entries: number; sha256: string; checked: number } } | FreezeRefusal> {
    if (viewer.role !== 'compliance') return this.refuse(viewer, 'role');
    if (typeof input.publishedAt !== 'string' || Number.isNaN(Date.parse(input.publishedAt))) return { ok: false, rule: null, code: 'bad_date' };
    const publishedAt = new Date(input.publishedAt);
    if (publishedAt.getTime() > this.now().getTime()) return { ok: false, rule: null, code: 'future_date' };
    if (!Array.isArray(input.entries) || input.entries.length === 0 || input.entries.length > MAX_ENTRIES) return { ok: false, rule: null, code: 'bad_entries' };
    const entries: { entryId: string; nature: FreezeNature; names: string[] }[] = [];
    const seen = new Set<string>();
    for (const raw of input.entries as unknown[]) {
      const e = raw as Partial<FreezeRegistryEntry> | null;
      if (!e || typeof e !== 'object' || Object.keys(e).some((k) => !['entryId', 'nature', 'names'].includes(k))) return { ok: false, rule: null, code: 'bad_entry' };
      if (typeof e.entryId !== 'string' || !ENTRY_ID.test(e.entryId) || seen.has(e.entryId)) return { ok: false, rule: null, code: 'bad_entry' };
      if (!FREEZE_NATURES.includes(e.nature as FreezeNature)) return { ok: false, rule: null, code: 'bad_entry' };
      if (!Array.isArray(e.names) || e.names.length === 0 || e.names.length > MAX_NAMES) return { ok: false, rule: null, code: 'bad_entry' };
      const names: string[] = [];
      for (const n of e.names as unknown[]) {
        if (typeof n !== 'string' || n.length > MAX_NAME_LENGTH) return { ok: false, rule: null, code: 'bad_entry' };
        // Un alias dans une autre écriture (cyrillique, arabe…) ne donne aucun mot : il est laissé, pas le registre.
        const tokens = nameTokens(n);
        if (tokens.length > 0) names.push(tokens.join(' '));
      }
      if (names.length === 0) return { ok: false, rule: null, code: 'bad_entry' };
      seen.add(e.entryId);
      entries.push({ entryId: e.entryId, nature: e.nature as FreezeNature, names: [...new Set(names)].sort() });
    }
    entries.sort((x, y) => (x.entryId < y.entryId ? -1 : x.entryId > y.entryId ? 1 : 0));
    const sha256 = await sha256Hex(JSON.stringify(canonical({ publishedAt: publishedAt.toISOString(), entries })));
    const same = await this.db.first<{ id: string }>('SELECT id FROM freeze_registry_versions WHERE network_id = ? AND sha256 = ?', [viewer.networkId, sha256]);
    if (same) return { ok: false, rule: null, code: 'already_imported' };
    const latest = await this.db.first<{ published_at: string }>('SELECT published_at FROM freeze_registry_versions WHERE network_id = ? ORDER BY published_at DESC LIMIT 1', [viewer.networkId]);
    if (latest && latest.published_at >= publishedAt.toISOString()) return { ok: false, rule: 'R605', code: 'older_version' };
    const versionId = this.newId();
    // La version, ses entrées et son sceau dans une seule écriture : un import interrompu ne laisse rien.
    const statements: SqlStatement[] = [
      {
        sql: 'INSERT INTO freeze_registry_versions (id, network_id, published_at, sha256, entries, imported_by, imported_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        params: [versionId, viewer.networkId, publishedAt.toISOString(), sha256, entries.length, this.actor(viewer), this.now().toISOString()],
      },
    ];
    for (let i = 0; i < entries.length; i += CHUNK) {
      const part = entries.slice(i, i + CHUNK);
      statements.push({
        sql: `INSERT INTO freeze_registry_entries (version_id, entry_id, nature, names) VALUES ${part.map(() => '(?, ?, ?, ?)').join(', ')}`,
        params: part.flatMap((e) => [versionId, e.entryId, e.nature, JSON.stringify(e.names)]),
      });
    }
    statements.push({ sql: 'UPDATE freeze_registry_versions SET sealed_at = ? WHERE id = ?', params: [this.now().toISOString(), versionId] });
    try {
      await runBatch(this.db, statements);
    } catch (error) {
      // Une version plus récente rangée entre-temps : la base refuse, rien n'est gardé.
      const sealed = await this.db.first<{ id: string }>('SELECT id FROM freeze_registry_versions WHERE id = ?', [versionId]);
      if (!sealed && /plus récente/.test(String(error))) return { ok: false, rule: 'R605', code: 'older_version' };
      throw error;
    }
    await appendEvent(this.journal, { type: 'securite.gel_registre', actor: this.actor(viewer), subject: `freeze_registry:${versionId}`, data: { rule: 'R605', entries: entries.length, sha256 } }, this.now);
    const checked = await this.recheckOpen(viewer.networkId, 'mise_a_jour', 'system:gel-avoirs');
    return { ok: true, value: { versionId, entries: entries.length, sha256, checked } };
  }

  /** Les dossiers ouverts du réseau. */
  private async openCases(networkId: string): Promise<string[]> {
    const mandates = await this.db.all<{ id: string }>(
      `SELECT m.id FROM mandates m WHERE m.network_id = ?
         AND NOT EXISTS (SELECT 1 FROM mandate_withdrawals w WHERE w.mandate_id = m.id)
         AND NOT EXISTS (SELECT 1 FROM sale_files f JOIN offer_register o ON o.id = f.offer_id JOIN sale_file_closings c ON c.file_id = f.id
                         WHERE o.property_id = m.property_id AND f.opened_at >= m.signed_at)
       ORDER BY m.id`,
      [networkId],
    );
    const offers = await this.db.all<{ id: string }>(
      `SELECT o.id FROM offer_register o WHERE o.network_id = ?
         AND NOT EXISTS (SELECT 1 FROM sale_files f WHERE f.offer_id = o.id
                         AND (EXISTS (SELECT 1 FROM sale_file_closings c WHERE c.file_id = f.id) OR EXISTS (SELECT 1 FROM sale_file_stops s WHERE s.file_id = f.id)))
       ORDER BY o.id`,
      [networkId],
    );
    const files = await this.db.all<{ id: string }>(
      `SELECT f.id FROM sale_files f WHERE f.network_id = ?
         AND NOT EXISTS (SELECT 1 FROM sale_file_closings c WHERE c.file_id = f.id)
         AND NOT EXISTS (SELECT 1 FROM sale_file_stops s WHERE s.file_id = f.id)
       ORDER BY f.id`,
      [networkId],
    );
    return [...mandates.map((m) => `mandate:${m.id}`), ...offers.map((o) => `offer:${o.id}`), ...files.map((f) => `sale_file:${f.id}`)];
  }

  private async recheckOpen(networkId: string, reason: FreezeReason, by: string): Promise<number> {
    const version = await this.latestVersion(networkId);
    if (!version) return 0;
    let checked = 0;
    for (const caseRef of await this.openCases(networkId)) {
      if (await this.checkWith(networkId, caseRef, version, reason, by)) checked++;
    }
    return checked;
  }

  /** Le passage planifié : chaque dossier ouvert qui n'a pas encore été contrôlé sur la dernière version, l'est. */
  async sweep(networkId: string): Promise<{ checked: number }> {
    return { checked: await this.recheckOpen(networkId, 'passage', 'system:gel-avoirs') };
  }

  /** Le passage planifié de chaque réseau qui a un registre scellé ; un réseau en panne n'arrête pas les autres. */
  async sweepAll(): Promise<{ checked: number }> {
    let checked = 0;
    let failure: unknown = null;
    for (const n of await this.db.all<{ network_id: string }>('SELECT DISTINCT network_id FROM freeze_registry_versions WHERE sealed_at IS NOT NULL ORDER BY network_id')) {
      try {
        checked += (await this.sweep(n.network_id)).checked;
      } catch (error) {
        failure ??= error;
      }
    }
    if (failure !== null) throw failure;
    return { checked };
  }

  /**
   * Contrôle d'un dossier, demandé par l'agent du client ou par le responsable. Rend toujours le même mot ; le
   * résultat ne se lit que par le responsable.
   */
  async checkCase(viewer: Viewer, caseRef: unknown): Promise<{ ok: true; status: typeof FREEZE_CHECK_STATUS } | FreezeRefusal> {
    if (viewer.role !== 'agent' && viewer.role !== 'compliance') return this.refuse(viewer, 'role');
    const m = typeof caseRef === 'string' ? CASE_REF.exec(caseRef) : null;
    if (!m) return { ok: false, rule: null, code: 'bad_case' };
    const found = await caseScopeOf(this.db, this.fiches, viewer.networkId, m[1] as 'mandate' | 'offer' | 'sale_file', m[2]!);
    if (!found) return { ok: false, rule: null, code: 'unknown_case' };
    const read = await this.acces.readFiche(viewer, found.personId);
    if (!read.ok) return { ok: false, rule: 'R16', code: read.code };
    if (viewer.role === 'agent' && read.view !== 'full') return this.refuse(viewer, 'not_assigned');
    const version = await this.latestVersion(viewer.networkId);
    if (!version) return { ok: false, rule: 'R605', code: 'no_registry' };
    await this.checkWith(viewer.networkId, caseRef as string, version, 'demande', this.actor(viewer));
    return { ok: true, status: FREEZE_CHECK_STATUS };
  }

  /** Contrôle un dossier contre une version ; `false` s'il l'était déjà sur ce périmètre et cette version. */
  private async checkWith(networkId: string, caseRef: string, version: VersionRow, reason: FreezeReason, by: string): Promise<boolean> {
    const m = CASE_REF.exec(caseRef)!;
    const found = await caseScopeOf(this.db, this.fiches, networkId, m[1] as 'mandate' | 'offer' | 'sale_file', m[2]!);
    if (!found) return false;
    const { scope } = found;

    // Les noms de chaque partie. Les fiches réunies (S04) se complètent : chaque prénom d'une fiche du groupe est
    // essayé avec chaque nom de famille du groupe, en plus du nom de chaque fiche. Une partie n'est « sans nom » que si
    // aucune fiche du groupe n'a de nom de famille.
    const marks = scope.persons.map(() => '?').join(', ');
    const rows = await this.db.all<{ id: string; first_name: string | null; last_name: string | null }>(
      `SELECT id, first_name, last_name FROM persons WHERE network_id = ? AND id IN (${marks}) ORDER BY id`,
      [networkId, ...scope.persons],
    );
    const byId = new Map(rows.map((r) => [r.id, r]));
    const candidates = new Map<string, string[][]>();
    const unnamed: string[] = [];
    for (const p of scope.persons) {
      const group = [...new Set([p, ...(await this.fiches.membersOf(p))])].map((id) => byId.get(id)).filter((r) => r !== undefined);
      const firsts = [...new Set(group.map((r) => r.first_name ?? ''))];
      const lasts = [...new Set(group.map((r) => r.last_name ?? '').filter((l) => nameTokens(l).length > 0))];
      if (lasts.length === 0) unnamed.push(p);
      const sets = new Map<string, string[]>();
      for (const r of group) {
        const t = nameTokens(`${r.first_name ?? ''} ${r.last_name ?? ''}`);
        if (t.length > 0) sets.set(t.join(' '), t);
      }
      for (const f of firsts) {
        for (const l of lasts) {
          const t = nameTokens(`${f} ${l}`);
          sets.set(t.join(' '), t);
        }
      }
      candidates.set(p, [...sets.values()].sort((a, b) => (a.join(' ') < b.join(' ') ? -1 : 1)));
    }

    // L'empreinte du contrôle porte le périmètre et les noms comparés : un nom corrigé ou complété se recontrôle.
    const scopeSha256 = await sha256Hex(JSON.stringify(canonical({ scope, names: [...candidates.entries()].sort(([a], [b]) => (a < b ? -1 : 1)) })));
    const done = await this.db.first<{ id: string }>('SELECT id FROM freeze_checks WHERE case_ref = ? AND version_id = ? AND scope_sha256 = ?', [caseRef, version.id, scopeSha256]);
    if (done) return false;

    const matches: { personId: string; entryId: string }[] = [];
    const entries = await this.db.all<{ entry_id: string; names: string }>('SELECT entry_id, names FROM freeze_registry_entries WHERE version_id = ? ORDER BY entry_id', [version.id]);
    for (const e of entries) {
      const names = (JSON.parse(e.names) as string[]).map((n) => n.split(' '));
      for (const p of scope.persons) {
        const sets = candidates.get(p) ?? [];
        if (names.some((n) => sets.some((t) => namesMatch(n, t)))) matches.push({ personId: p, entryId: e.entry_id });
      }
    }
    const result: FreezeResult = matches.length > 0 ? 'correspondance' : unnamed.length > 0 ? 'nom_manquant' : 'aucune';
    const checkId = this.newId();
    const at = this.now().toISOString();
    const statements: SqlStatement[] = [
      {
        sql: `INSERT INTO freeze_checks (id, network_id, case_ref, version_id, scope_sha256, persons, result, matches, unnamed, reason, requested_by, checked_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (case_ref, version_id, scope_sha256) DO NOTHING`,
        params: [checkId, networkId, caseRef, version.id, scopeSha256, scope.persons.length, result, JSON.stringify(matches), JSON.stringify(unnamed), reason, by, at],
      },
    ];
    if (result === 'correspondance') {
      // Le dossier est figé dans la même écriture que le contrôle : sa copie, ligne par ligne, par empreinte.
      const snapshot = await caseSnapshotOf(this.db, scope);
      const text = JSON.stringify(canonical({ scope, snapshot }));
      statements.push({
        sql: `INSERT INTO freeze_matches (id, network_id, check_id, case_ref, snapshot, snapshot_sha256, created_at)
              SELECT ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM freeze_checks WHERE id = ?)`,
        params: [this.newId(), networkId, checkId, caseRef, text, await sha256Hex(text), at, checkId],
      });
    }
    const [inserted] = await runBatch(this.db, statements);
    if (!inserted || inserted.changes === 0) return false;
    await this.ensureEvents(networkId, checkId);
    return true;
  }

  /** Chaque contrôle et chaque correspondance rangés ont leur événement au journal : un manquant est repris, une fois. */
  private async ensureEvents(networkId: string, onlyCheck: string | null = null): Promise<void> {
    const rows = await this.db.all<{ id: string; version_id: string; requested_by: string; match_id: string | null; snapshot_sha256: string | null; decision: string | null; decided_by: string | null }>(
      `SELECT c.id, c.version_id, c.requested_by, m.id AS match_id, m.snapshot_sha256, d.decision, d.decided_by FROM freeze_checks c
       LEFT JOIN freeze_matches m ON m.check_id = c.id LEFT JOIN freeze_match_decisions d ON d.match_id = m.id
       WHERE c.network_id = ? AND (? IS NULL OR c.id = ?) ORDER BY c.checked_at, c.id`,
      [networkId, onlyCheck, onlyCheck],
    );
    for (const r of rows) {
      const subject = `freeze_check:${r.id}`;
      const types = new Set((await this.journal.bySubject(subject)).map((e) => e.type));
      // Le contrôle lui-même ne dit pas son résultat : seule l'existence d'une correspondance, sous sa propre référence.
      if (!types.has('securite.gel_controle')) {
        await appendEvent(this.journal, { type: 'securite.gel_controle', actor: r.requested_by, subject, data: { rule: 'R605', version: r.version_id } }, this.now);
      }
      if (r.match_id === null) continue;
      const matchSubject = `freeze_match:${r.match_id}`;
      const matchTypes = new Set((await this.journal.bySubject(matchSubject)).map((e) => e.type));
      if (!matchTypes.has('securite.gel_correspondance')) {
        await appendEvent(this.journal, { type: 'securite.gel_correspondance', actor: 'system:gel-avoirs', subject: matchSubject, data: { rule: 'R603', snapshot: r.snapshot_sha256! } }, this.now);
      }
      if (r.decision !== null && !matchTypes.has('securite.gel_decision')) {
        await appendEvent(this.journal, { type: 'securite.gel_decision', actor: r.decided_by!, subject: matchSubject, data: { rule: 'R603', decision: r.decision } }, this.now);
      }
    }
  }

  private async toCheck(row: CheckRow): Promise<FreezeCheck> {
    const v = (await this.db.first<VersionRow>('SELECT id, published_at, sha256 FROM freeze_registry_versions WHERE id = ?', [row.version_id]))!;
    return {
      checkId: row.id,
      caseRef: row.case_ref,
      checkedAt: row.checked_at,
      version: { versionId: v.id, publishedAt: v.published_at, sha256: v.sha256 },
      scopeSha256: row.scope_sha256,
      persons: row.persons,
      result: row.result,
      matches: JSON.parse(row.matches) as { personId: string; entryId: string }[],
      unnamed: JSON.parse(row.unnamed) as string[],
      reason: row.reason,
    };
  }

  /** Les contrôles d'un dossier, du plus ancien au plus récent, chacun daté avec sa version : le responsable seul. */
  async checks(viewer: Viewer, caseRef: string): Promise<{ ok: true; value: FreezeCheck[] } | FreezeRefusal> {
    if (viewer.role !== 'compliance') return this.refuse(viewer, 'role');
    const rows = await this.db.all<CheckRow>('SELECT * FROM freeze_checks WHERE network_id = ? AND case_ref = ? ORDER BY checked_at, id', [viewer.networkId, caseRef]);
    const out: FreezeCheck[] = [];
    for (const row of rows) out.push(await this.toCheck(row));
    return { ok: true, value: out };
  }

  /** Les dossiers dont une fiche n'a pas de nom, au dernier contrôle de chacun : le responsable seul. */
  async unnamedCases(viewer: Viewer): Promise<{ ok: true; value: FreezeCheck[] } | FreezeRefusal> {
    if (viewer.role !== 'compliance') return this.refuse(viewer, 'role');
    const rows = await this.db.all<CheckRow>(
      `SELECT c.* FROM freeze_checks c WHERE c.network_id = ? AND c.result = 'nom_manquant'
         AND c.checked_at = (SELECT max(x.checked_at) FROM freeze_checks x WHERE x.network_id = c.network_id AND x.case_ref = c.case_ref)
       ORDER BY c.checked_at, c.id`,
      [viewer.networkId],
    );
    const out: FreezeCheck[] = [];
    for (const row of rows) out.push(await this.toCheck(row));
    return { ok: true, value: out };
  }

  private async toMatch(row: { id: string; check_id: string; case_ref: string; snapshot: string; snapshot_sha256: string; created_at: string }): Promise<FreezeMatch> {
    const check = (await this.db.first<CheckRow>('SELECT * FROM freeze_checks WHERE id = ?', [row.check_id]))!;
    const d = await this.db.first<{ decision: FreezeDecisionKind; reason: string; validator_name: string; decided_on: string }>(
      'SELECT decision, reason, validator_name, decided_on FROM freeze_match_decisions WHERE match_id = ?',
      [row.id],
    );
    const { snapshot } = JSON.parse(row.snapshot) as { snapshot: CaseSnapshot };
    return {
      matchId: row.id,
      caseRef: row.case_ref,
      createdAt: row.created_at,
      check: await this.toCheck(check),
      snapshotSha256: row.snapshot_sha256,
      lines: Object.values(snapshot).reduce((n, lines) => n + lines.length, 0),
      decision: d ? { decision: d.decision, reason: d.reason, validatorName: d.validator_name, decidedOn: d.decided_on } : null,
    };
  }

  /** Les correspondances du réseau, celles qui attendent une décision d'abord : le responsable seul. */
  async matches(viewer: Viewer): Promise<{ ok: true; value: FreezeMatch[] } | FreezeRefusal> {
    if (viewer.role !== 'compliance') return this.refuse(viewer, 'role');
    await this.ensureEvents(viewer.networkId);
    const rows = await this.db.all<{ id: string; check_id: string; case_ref: string; snapshot: string; snapshot_sha256: string; created_at: string }>(
      'SELECT id, check_id, case_ref, snapshot, snapshot_sha256, created_at FROM freeze_matches WHERE network_id = ? ORDER BY created_at, id',
      [viewer.networkId],
    );
    const out: FreezeMatch[] = [];
    for (const row of rows) out.push(await this.toMatch(row));
    return { ok: true, value: [...out.filter((x) => x.decision === null), ...out.filter((x) => x.decision !== null)] };
  }

  /** Le dossier est-il resté tel qu'à la correspondance ? Le responsable seul. */
  async checkFrozen(viewer: Viewer, matchId: string): Promise<{ ok: true; value: FrozenCheck } | FreezeRefusal> {
    if (viewer.role !== 'compliance') return this.refuse(viewer, 'role');
    const row = await this.db.first<{ snapshot: string }>('SELECT snapshot FROM freeze_matches WHERE id = ? AND network_id = ?', [matchId, viewer.networkId]);
    if (!row) return { ok: false, rule: null, code: 'unknown_match' };
    const { scope, snapshot } = JSON.parse(row.snapshot) as { scope: CaseScope; snapshot: CaseSnapshot };
    return { ok: true, value: compareSnapshots(snapshot, await caseSnapshotOf(this.db, scope)) };
  }

  /** Le responsable juge la correspondance, seul et une seule fois, avec sa raison, son nom et sa date. */
  async decide(
    viewer: Viewer,
    matchId: string,
    input: { decision: unknown; reason: unknown; validatorName: unknown },
  ): Promise<{ ok: true; value: FreezeMatch } | FreezeRefusal> {
    if (viewer.role !== 'compliance') return this.refuse(viewer, 'role');
    if (!FREEZE_DECISIONS.includes(input.decision as FreezeDecisionKind)) return { ok: false, rule: null, code: 'bad_decision' };
    if (typeof input.reason !== 'string' || input.reason.trim() === '' || input.reason.length > 4000) return { ok: false, rule: null, code: 'bad_reason' };
    if (typeof input.validatorName !== 'string' || input.validatorName.trim() === '' || input.validatorName.length > 120) return { ok: false, rule: null, code: 'missing_name' };
    const row = await this.db.first<{ id: string; check_id: string; case_ref: string; snapshot: string; snapshot_sha256: string; created_at: string }>(
      'SELECT id, check_id, case_ref, snapshot, snapshot_sha256, created_at FROM freeze_matches WHERE id = ? AND network_id = ?',
      [matchId, viewer.networkId],
    );
    if (!row) return { ok: false, rule: null, code: 'unknown_match' };
    const { changes } = await this.db.run(
      `INSERT INTO freeze_match_decisions (match_id, network_id, decision, reason, validator_name, decided_by, decided_on, at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (match_id) DO NOTHING`,
      [matchId, viewer.networkId, input.decision as string, input.reason.trim(), input.validatorName.trim(), this.actor(viewer), localTime(this.now(), TIME_ZONE).date, this.now().toISOString()],
    );
    await this.ensureEvents(viewer.networkId);
    if (changes === 0) return { ok: false, rule: null, code: 'already_decided' };
    return { ok: true, value: await this.toMatch(row) };
  }
}
