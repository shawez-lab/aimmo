/**
 * Avis clients vérifiables, publiés partout (HX46, M11) [R520, R521, R522, R523].
 *
 * Un avis AIMMO ne vient que d'un client d'un dossier clos : l'agent du dossier, ou la direction, tire pour ce client
 * une invitation à usage unique, seulement si le dossier est clos (acte signé, rapporté par M10) et si la personne en est
 * bien un client ; le client y donne une note de 1 à 5 et son texte. Sans invitation consommée, la base refuse l'avis
 * [R520].
 *
 * Tous les avis sont publiés, dans l'ordre où ils arrivent, jamais triés ni filtrés par leur note. Aucun avis ne
 * s'efface, ne change ni ne se masque : la base n'a pas de colonne pour le cacher, et les avis d'un agent forment une
 * chaîne, chacun portant l'empreinte du précédent. Un avis retiré casserait la chaîne, et n'importe qui le verrait
 * [R521].
 *
 * « Jamais vu » : chaque avis porte une preuve publique qu'il vient d'un dossier réellement clos, vérifiable par
 * n'importe qui sans donnée personnelle. La preuve est un engagement (SHA-256) sur le dossier, le jour de l'acte et un
 * sel gardé par AIMMO : le public voit l'engagement et l'empreinte de l'avis, qu'il peut recalculer lui-même avec
 * `verifyChain` ; un contrôleur à qui la conformité remet le dossier et le sel (`auditProof`) retrouve l'engagement.
 * La vérification publique ne rend ni nom, ni personne, ni dossier, ni bien, ni commune, ni jour de l'acte [R522].
 *
 * Le texte du client est contrôlé à l'entrée, quelle que soit sa note : ni adresse mail, ni numéro de téléphone, ni
 * lien, ni adresse postale, ni nom d'un client du dossier. Un texte refusé ne consomme pas l'invitation : le client le
 * corrige. AIMMO n'écrit jamais d'avis à la place d'un client [R523, R64].
 *
 * Décidé, lecture prudente :
 * - l'invitation expire 60 jours après avoir été tirée ; une seule réponse par client et par dossier ;
 * - le public voit le côté (vendeur ou acquéreur), la note, le texte et le jour de publication, jamais le mois de l'acte
 *   ni la commune, qui, ensemble, désigneraient la vente ;
 * - le résumé (nombre, moyenne, répartition des notes) se calcule sur tous les avis, sans exception ;
 * - aucun envoi dans cette tâche : le lien sera porté par la demande d'avis (F02), et la diffusion sur les annonces, le
 *   site et les portails viendra avec les routes (voie 1).
 */
import type { Viewer } from '../acces/droits.ts';
import { FicheClient } from '../db/fiche-client.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { FicheUnique } from '../fiche/fusion.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import type { DossiersClos } from '../apres-vente/demandes-avis.ts';
import { viewerRefusal } from '../apres-vente/lecteur.ts';
import { checkAfterSaleUnsubscribeBase, newAfterSaleToken } from '../apres-vente/relances-apres-vente.ts';

export const REVIEW_INVITE_DAYS = 60;
export const REVIEW_TEXT_MIN = 20;
export const REVIEW_TEXT_MAX = 2000;
export const GENESIS_HASH = '0'.repeat(64);
const CODE_LETTERS = 'abcdefghjkmnpqrstuvwxyz';

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function randomHex(bytes: number): string {
  return [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function newCode(): string {
  return [...crypto.getRandomValues(new Uint8Array(12))].map((b) => CODE_LETTERS[b % CODE_LETTERS.length]).join('');
}

/** L'engagement public sur un dossier clos : rien ne s'en lit sans le sel [R522]. */
export function fileCommitment(fileId: string, closedOn: string, salt: string): Promise<string> {
  return sha256(`aimmo-dossier-1|${fileId}|${closedOn}|${salt}`);
}

/** Un avis tel que le public le voit : aucune donnée personnelle, rien qui désigne la vente [R522]. */
export interface PublicReview {
  code: string;
  agentId: string;
  seq: number;
  side: 'vendeur' | 'acquereur';
  score: number;
  text: string;
  publishedOn: string;
  fileCommitment: string;
  prevHash: string;
  hash: string;
}

/** L'empreinte d'un avis, recalculable par n'importe qui depuis ce qui est publié. */
export function reviewHash(r: Omit<PublicReview, 'hash'>): Promise<string> {
  return sha256(JSON.stringify(['aimmo-avis-1', r.code, r.agentId, r.seq, r.side, r.score, r.text, r.publishedOn, r.fileCommitment, r.prevHash]));
}

export type ChainCheck = { ok: true; count: number } | { ok: false; seq: number; reason: 'hash' | 'link' | 'gap' | 'agent' };

/**
 * Vérifie, sans rien demander à AIMMO, que la liste publiée d'un agent est entière et intacte : chaque empreinte se
 * recalcule, chaque avis porte celle du précédent, aucun numéro ne manque [R521, R522].
 */
export async function verifyChain(reviews: readonly PublicReview[]): Promise<ChainCheck> {
  const list = [...reviews].sort((a, b) => a.seq - b.seq);
  let prev = GENESIS_HASH;
  for (const [i, r] of list.entries()) {
    if (r.agentId !== list[0]!.agentId) return { ok: false, seq: r.seq, reason: 'agent' };
    if (r.seq !== i + 1) return { ok: false, seq: i + 1, reason: 'gap' };
    if (r.prevHash !== prev) return { ok: false, seq: r.seq, reason: 'link' };
    const { hash, ...rest } = r;
    if ((await reviewHash(rest)) !== hash) return { ok: false, seq: r.seq, reason: 'hash' };
    prev = hash;
  }
  return { ok: true, count: list.length };
}

const fold = (s: string): string => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const words = (s: string): string[] => fold(s).split(/[^a-z]+/).filter((w) => w.length > 0);

export type TextProblem = 'length' | 'control' | 'email' | 'phone' | 'link' | 'address' | 'name';

/**
 * Ce que le texte d'un avis ne peut pas porter, quelle que soit sa note [R523] : coordonnées, lien, adresse postale,
 * nom d'un client du dossier (mots de trois lettres au moins, sans accents ni casse).
 */
export function reviewTextProblem(text: string, forbiddenNames: readonly string[]): TextProblem | null {
  if (text.length < REVIEW_TEXT_MIN || text.length > REVIEW_TEXT_MAX) return 'length';
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) return 'control';
  if (/[^\s@]+\s*(?:@|\(at\)|\[at\])\s*[^\s@]+\.[a-z]{2,}/i.test(text)) return 'email';
  if (/(?:\+\s*33|\b0)\s*[1-9](?:[\s.\-]*\d){8}/.test(text)) return 'phone';
  if (/https?:\/\/|\bwww\.|\b[a-z0-9-]+\.(?:fr|com|net|org|eu|io)\b/i.test(text)) return 'link';
  if (/\b\d{1,4}\s*(?:bis|ter)?\s*,?\s*(?:rue|avenue|av\.|boulevard|bd|place|chemin|impasse|all[ée]e|route|quai|cours|square|r[ée]sidence)\b/i.test(text)) return 'address';
  const said = new Set(words(text));
  for (const name of forbiddenNames) for (const w of words(name)) if (w.length >= 3 && said.has(w)) return 'name';
  return null;
}

export type ReviewRefusal = { ok: false; rule: 'R16' | 'R520' | null; code: string };

export interface ReviewSummary {
  count: number;
  /** Moyenne de toutes les notes, à un chiffre après la virgule ; `null` sans avis. */
  average: number | null;
  /** Nombre d'avis par note, de 1 à 5 : tous comptés. */
  byScore: Record<1 | 2 | 3 | 4 | 5, number>;
}

interface ReviewRow {
  code: string;
  agent_id: string;
  seq: number;
  side: 'vendeur' | 'acquereur';
  score: number;
  text: string;
  published_on: string;
  file_commitment: string;
  prev_hash: string;
  hash: string;
}

const toPublic = (r: ReviewRow): PublicReview => ({
  code: r.code,
  agentId: r.agent_id,
  seq: r.seq,
  side: r.side,
  score: r.score,
  text: r.text,
  publishedOn: r.published_on,
  fileCommitment: r.file_commitment,
  prevHash: r.prev_hash,
  hash: r.hash,
});

const PUBLIC_COLUMNS = 'code, agent_id, seq, side, score, text, published_on, file_commitment, prev_hash, hash';

export class AvisVerifies {
  private readonly now: () => Date;
  private readonly unique: FicheUnique;
  private readonly base: string;

  constructor(
    private readonly db: SqlDatabase,
    private readonly journal: JournalStore,
    private readonly dossiers: DossiersClos,
    options: { now?: () => Date; base: string },
  ) {
    this.now = options.now ?? (() => new Date());
    const base = checkAfterSaleUnsubscribeBase(options.base);
    if (!base) throw new Error('Le début du lien d’avis est exigé.');
    this.base = base;
    this.unique = new FicheUnique(db, new FicheClient(db, { now: this.now }), { now: this.now });
  }

  private async refuse(viewer: Viewer, subject: string, kind: string, code: string): Promise<ReviewRefusal> {
    await appendEvent(this.journal, { type: 'acces.refuse', actor: `${String(viewer.role)}:${viewer.userId}`, subject, data: { rule: 'R16', role: String(viewer.role), kind, code } }, this.now);
    return { ok: false, rule: 'R16', code };
  }

  /**
   * L'invitation d'un client d'un dossier clos à donner son avis : l'agent du dossier ou la direction [R16] ; un dossier
   * qui n'est pas clos, ou une personne qui n'en est pas cliente, n'en reçoit pas [R520]. Rend le lien à porter.
   */
  async invite(viewer: Viewer, fileId: string, personId: string): Promise<{ ok: true; link: string } | ReviewRefusal> {
    const subject = `sale_file:${fileId}`;
    const inactive = await viewerRefusal(this.db, viewer);
    if (inactive) return this.refuse(viewer, subject, 'avis_invitation', inactive);
    if (viewer.role !== 'agent' && viewer.role !== 'direction') return this.refuse(viewer, subject, 'avis_invitation', 'role');
    const sale = await this.dossiers.byId(viewer.networkId, fileId);
    if (!sale) {
      await appendEvent(this.journal, { type: 'avis.refuse', actor: `${String(viewer.role)}:${viewer.userId}`, subject, data: { rule: 'R520', code: 'not_closed' } }, this.now);
      return { ok: false, rule: 'R520', code: 'not_closed' };
    }
    if (viewer.role === 'agent' && sale.agentId !== viewer.userId) return this.refuse(viewer, subject, 'avis_invitation', 'not_own');
    const members = await this.unique.membersOf(personId);
    const client = sale.clients.find((c) => c.personId === personId || members.includes(c.personId));
    if (!client) {
      await appendEvent(this.journal, { type: 'avis.refuse', actor: `${String(viewer.role)}:${viewer.userId}`, subject, data: { rule: 'R520', code: 'not_client' } }, this.now);
      return { ok: false, rule: 'R520', code: 'not_client' };
    }
    const done = await this.db.first<{ n: number }>('SELECT count(*) AS n FROM verified_reviews WHERE file_id = ? AND person_id = ?', [fileId, client.personId]);
    if (done!.n > 0) return { ok: false, rule: null, code: 'already_reviewed' };
    const token = newAfterSaleToken();
    const at = this.now();
    await this.db.run(
      'INSERT INTO verified_review_invites (token_hash, network_id, file_id, person_id, agent_id, side, closed_on, created_by, created_at, expires_at, used_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)',
      [await sha256(token), viewer.networkId, fileId, client.personId, sale.agentId, client.side, sale.closedOn, `${String(viewer.role)}:${viewer.userId}`, at.toISOString(), new Date(at.getTime() + REVIEW_INVITE_DAYS * 86_400_000).toISOString()],
    );
    await appendEvent(this.journal, { type: 'avis.invitation', actor: `${String(viewer.role)}:${viewer.userId}`, subject, data: { side: client.side } }, this.now);
    return { ok: true, link: `${this.base}${token}` };
  }

  /** Les noms des clients du dossier, avec ceux de leurs fiches réunies et leurs noms d'avant une correction. */
  private async clientNames(fileId: string, networkId: string): Promise<string[]> {
    const sale = await this.dossiers.byId(networkId, fileId);
    const ids = new Set<string>();
    for (const c of sale?.clients ?? []) for (const m of await this.unique.membersOf(c.personId)) ids.add(m);
    if (ids.size === 0) return [];
    const list = [...ids];
    const rows = await this.db.all<{ first_name: string | null; last_name: string | null }>(`SELECT first_name, last_name FROM person_known_names WHERE id IN (${list.map(() => '?').join(', ')})`, list);
    return rows.flatMap((r) => [r.first_name ?? '', r.last_name ?? '']).filter((n) => n.trim() !== '');
  }

  /**
   * L'avis du client, par son invitation : une seule fois, avant l'expiration, et seulement si le dossier est encore
   * clos [R520]. Publié aussitôt, en bout de chaîne, quelle que soit la note [R521].
   */
  async submit(token: string, input: { score: number; text: string }): Promise<{ ok: true; code: string } | { ok: false; rule: 'R520' | 'R523' | null; code: string }> {
    if (typeof token !== 'string' || !/^[a-z]{32}$/.test(token)) return { ok: false, rule: null, code: 'unknown' };
    const inv = await this.db.first<{ token_hash: string; network_id: string; file_id: string; person_id: string; agent_id: string; side: 'vendeur' | 'acquereur'; closed_on: string; expires_at: string; used_at: string | null }>(
      'SELECT token_hash, network_id, file_id, person_id, agent_id, side, closed_on, expires_at, used_at FROM verified_review_invites WHERE token_hash = ?',
      [await sha256(token)],
    );
    if (!inv) return { ok: false, rule: null, code: 'unknown' };
    if (inv.used_at) return { ok: false, rule: null, code: 'used' };
    const at = this.now();
    if (at.getTime() >= Date.parse(inv.expires_at)) return { ok: false, rule: null, code: 'expired' };
    if (!Number.isInteger(input.score) || input.score < 1 || input.score > 5) return { ok: false, rule: null, code: 'invalid_score' };
    if (typeof input.text !== 'string') return { ok: false, rule: 'R523', code: 'length' };
    // Le dossier doit être encore clos, avec le même jour d'acte, au moment de publier [R520].
    const sale = await this.dossiers.byId(inv.network_id, inv.file_id);
    if (!sale || sale.closedOn !== inv.closed_on) return { ok: false, rule: 'R520', code: 'not_closed' };
    const text = input.text.trim().replace(/\r\n/g, '\n');
    const problem = reviewTextProblem(text, await this.clientNames(inv.file_id, inv.network_id));
    if (problem) return { ok: false, rule: 'R523', code: problem };
    const already = await this.db.first<{ n: number }>('SELECT count(*) AS n FROM verified_reviews WHERE file_id = ? AND person_id = ?', [inv.file_id, inv.person_id]);
    if (already!.n > 0) return { ok: false, rule: null, code: 'used' };
    // L'invitation est consommée avec l'avis : si l'avis ne peut pas être rangé, elle est rendue.
    const taken = await this.db.run('UPDATE verified_review_invites SET used_at = ? WHERE token_hash = ? AND used_at IS NULL', [at.toISOString(), inv.token_hash]);
    if (taken.changes !== 1) return { ok: false, rule: null, code: 'used' };
    const salt = randomHex(32);
    const commitment = await fileCommitment(inv.file_id, inv.closed_on, salt);
    const publishedOn = at.toISOString().slice(0, 10);
    for (let attempt = 0; attempt < 3; attempt++) {
      const last = await this.db.first<{ seq: number; hash: string }>('SELECT seq, hash FROM verified_reviews WHERE agent_id = ? ORDER BY seq DESC LIMIT 1', [inv.agent_id]);
      const draft = { code: newCode(), agentId: inv.agent_id, seq: (last?.seq ?? 0) + 1, side: inv.side, score: input.score, text, publishedOn, fileCommitment: commitment, prevHash: last?.hash ?? GENESIS_HASH };
      const hash = await reviewHash(draft);
      try {
        await this.db.run(
          'INSERT INTO verified_reviews (code, network_id, agent_id, seq, file_id, person_id, side, score, text, published_on, file_salt, file_commitment, prev_hash, hash, published_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [draft.code, inv.network_id, inv.agent_id, draft.seq, inv.file_id, inv.person_id, inv.side, input.score, text, publishedOn, salt, commitment, draft.prevHash, hash, at.toISOString()],
        );
      } catch (e) {
        // Un autre avis du même agent est arrivé en même temps : on reprend en bout de chaîne.
        const exists = await this.db.first<{ n: number }>('SELECT count(*) AS n FROM verified_reviews WHERE file_id = ? AND person_id = ?', [inv.file_id, inv.person_id]);
        if (exists!.n > 0) return { ok: false, rule: null, code: 'used' };
        if (attempt === 2) {
          await this.db.run('UPDATE verified_review_invites SET used_at = NULL WHERE token_hash = ?', [inv.token_hash]);
          throw e;
        }
        continue;
      }
      // Au journal : l'agent, le code public, le côté et la note ; jamais le texte ni la personne [R13].
      await appendEvent(this.journal, { type: 'avis.publie', actor: 'client:lien', subject: `agent:${inv.agent_id}`, data: { code: draft.code, side: inv.side, score: input.score } }, this.now);
      return { ok: true, code: draft.code };
    }
    return { ok: false, rule: null, code: 'used' };
  }

  /**
   * Tous les avis publiés d'un agent, dans l'ordre d'arrivée, et leur résumé : aucun n'est écarté ni rangé selon sa
   * note [R521]. Lecture publique : rien de personnel [R522].
   */
  async publicList(networkId: string, agentId: string): Promise<{ reviews: PublicReview[]; summary: ReviewSummary }> {
    const rows = await this.db.all<ReviewRow>(`SELECT ${PUBLIC_COLUMNS} FROM verified_reviews WHERE network_id = ? AND agent_id = ? ORDER BY seq`, [networkId, agentId]);
    const reviews = rows.map(toPublic);
    return { reviews, summary: summarize(reviews) };
  }

  /** La vérification publique d'un avis par son code : l'avis tel que publié et si sa place dans la chaîne tient [R522]. */
  async verify(code: string): Promise<{ found: false } | { found: true; review: PublicReview; valid: boolean }> {
    if (typeof code !== 'string' || !/^[a-z]{12}$/.test(code)) return { found: false };
    const row = await this.db.first<ReviewRow & { network_id: string }>(`SELECT ${PUBLIC_COLUMNS}, network_id FROM verified_reviews WHERE code = ?`, [code]);
    if (!row) return { found: false };
    const review = toPublic(row);
    const { hash, ...rest } = review;
    let valid = (await reviewHash(rest)) === hash;
    const prev = row.seq === 1 ? { hash: GENESIS_HASH } : await this.db.first<{ hash: string }>('SELECT hash FROM verified_reviews WHERE agent_id = ? AND seq = ?', [row.agent_id, row.seq - 1]);
    if (!prev || prev.hash !== review.prevHash) valid = false;
    return { found: true, review, valid };
  }

  /**
   * Pour un contrôleur : le dossier, le jour de l'acte et le sel qui ouvrent l'engagement d'un avis. Conformité seule,
   * au journal [R16].
   */
  async auditProof(viewer: Viewer, code: string): Promise<{ ok: true; value: { fileId: string; closedOn: string; salt: string } } | ReviewRefusal> {
    const subject = `avis:${code}`;
    const inactive = await viewerRefusal(this.db, viewer);
    if (inactive) return this.refuse(viewer, subject, 'avis_preuve', inactive);
    if (viewer.role !== 'compliance') return this.refuse(viewer, subject, 'avis_preuve', 'role');
    const row = await this.db.first<{ file_id: string; file_salt: string; network_id: string; person_id: string }>('SELECT file_id, file_salt, network_id, person_id FROM verified_reviews WHERE code = ?', [code]);
    if (!row || row.network_id !== viewer.networkId) return { ok: false, rule: null, code: 'unknown' };
    const inv = await this.db.first<{ closed_on: string }>('SELECT closed_on FROM verified_review_invites WHERE file_id = ? AND person_id = ? AND used_at IS NOT NULL ORDER BY used_at LIMIT 1', [row.file_id, row.person_id]);
    if (!inv) return { ok: false, rule: null, code: 'unknown' };
    await appendEvent(this.journal, { type: 'avis.preuve', actor: `${String(viewer.role)}:${viewer.userId}`, subject, data: {} }, this.now);
    return { ok: true, value: { fileId: row.file_id, closedOn: inv.closed_on, salt: row.file_salt } };
  }
}

/** Le résumé de tous les avis : nombre, moyenne, répartition ; aucun écarté [R521]. */
export function summarize(reviews: readonly Pick<PublicReview, 'score'>[]): ReviewSummary {
  const byScore: ReviewSummary['byScore'] = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  let total = 0;
  for (const r of reviews) {
    byScore[r.score as 1 | 2 | 3 | 4 | 5] += 1;
    total += r.score;
  }
  return { count: reviews.length, average: reviews.length === 0 ? null : Math.round((total / reviews.length) * 10) / 10, byScore };
}
