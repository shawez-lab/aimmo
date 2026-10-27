/**
 * La signature en ligne AIMMO (M06, D08), construite en mode essai.
 *
 * Un document contrôlé (D03) ouvre une session : un code à usage unique est envoyé au signataire par mail, par une
 * interface d'envoi (en essai : rangé pour l'essai, jamais envoyé ; le vrai envoi attend H05). Le code n'est jamais
 * gardé, seulement son empreinte ; il expire, ne sert qu'une fois, et cinq essais faux bloquent la session. La
 * signature manuscrite tracée à l'écran est possible : seule son empreinte est gardée. À la signature, le dossier de
 * preuve garde l'empreinte du document, l'horodatage et la méthode ; un document modifié depuis l'ouverture ne se
 * signe pas, et une modification après la signature est détectée par son empreinte.
 *
 * Tant que l'avocat n'a pas validé le dossier de preuve (H24), une signature en ligne ne rend jamais un mandat signé
 * réel : elle n'inscrit rien au registre et ne range aucun mandat. Le résultat le dit (`realSignature: false`).
 */
import type { Acces } from '../acces/acces.ts';
import type { Viewer } from '../acces/droits.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import { ControlesSignature, type SignatureCheck } from './controles.ts';
import { sha256 } from './modeles.ts';

export const CODE_TTL_MINUTES = 10;
export const MAX_CODE_ATTEMPTS = 5;
const MAX_DRAWING = 200_000;

/** L'envoi du code au signataire. En essai : rien ne part ; le vrai envoi par mail attend H05. */
export interface CodeSender {
  send(input: { networkId: string; personId: string; sessionId: string; code: string }): Promise<void>;
}

export interface SignatureProof {
  documentId: string;
  contentHash: string;
  signedAt: string;
  method: 'code' | 'code_et_trace';
  drawingHash: string | null;
  mode: 'essai';
  realSignature: false;
}

type Refusal = { ok: false; rule: 'R16'; code: string };
type Problem =
  | { ok: false; rule: 'R41'; code: 'checks_failed'; check: SignatureCheck }
  | { ok: false; rule: null; code: 'unknown_session' | 'expired' | 'blocked' | 'already_signed' | 'wrong_code' | 'document_changed' | 'bad_drawing' | 'unknown_document' | 'bad_schedule' | 'bad_piece' | 'bad_date' };

/** Un code de 6 chiffres, tiré au hasard sans biais. */
function newCode(): string {
  const buf = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(buf);
    const v = buf[0]!;
    if (v < 4_294_000_000) return String(v % 1_000_000).padStart(6, '0');
  }
}

/** Comparaison à temps constant de deux empreintes hexadécimales de même longueur. */
function sameHash(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

interface SessionRow {
  id: string;
  network_id: string;
  document_id: string;
  content_hash: string;
  code_hash: string;
  expires_at: string;
  attempts: number;
  status: 'ouverte' | 'signee' | 'bloquee';
  signed_at: string | null;
  proof: string | null;
}

export class SignatureEnLigne {
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly controles: ControlesSignature;

  constructor(
    private readonly db: SqlDatabase,
    private readonly acces: Acces,
    private readonly journal: JournalStore,
    private readonly sender: CodeSender,
    options: { now?: () => Date; newId?: () => string } = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => crypto.randomUUID());
    this.controles = new ControlesSignature(db, acces, journal, options);
  }

  private actor(viewer: Viewer): string {
    return `${String(viewer.role)}:${viewer.userId}`;
  }

  /** Ouvre une session de signature pour un document contrôlé et envoie le code au signataire. */
  async start(viewer: Viewer, documentId: string): Promise<{ ok: true; value: { sessionId: string; expiresAt: string; mode: 'essai' } } | Refusal | Problem> {
    if (viewer.role !== 'agent' && viewer.role !== 'direction') {
      await appendEvent(this.journal, { type: 'acces.refuse', actor: this.actor(viewer), subject: `document:${documentId}`, data: { rule: 'R16', role: String(viewer.role), kind: 'online_signature', code: 'role' } }, this.now);
      return { ok: false, rule: 'R16', code: 'role' };
    }
    const checked = await this.controles.check(viewer, documentId);
    if (!checked.ok) return checked as Refusal | Problem;
    if (!checked.value.passed) return { ok: false, rule: 'R41', code: 'checks_failed', check: checked.value };
    const doc = (await this.db.first<{ person_id: string; content: string }>('SELECT person_id, content FROM documents WHERE id = ?', [documentId]))!;
    const id = this.newId();
    const code = newCode();
    const expiresAt = new Date(this.now().getTime() + CODE_TTL_MINUTES * 60_000).toISOString();
    await this.db.run(
      `INSERT INTO signature_sessions (id, network_id, document_id, content_hash, code_hash, expires_at, attempts, status, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, 0, 'ouverte', ?, ?)`,
      [id, viewer.networkId, documentId, await sha256(doc.content), await sha256(`${id}:${code}`), expiresAt, this.actor(viewer), this.now().toISOString()],
    );
    await this.sender.send({ networkId: viewer.networkId, personId: doc.person_id, sessionId: id, code });
    await appendEvent(this.journal, { type: 'signature.ouverte', actor: this.actor(viewer), subject: `document:${documentId}`, data: { session: id, mode: 'essai' } }, this.now);
    return { ok: true, value: { sessionId: id, expiresAt, mode: 'essai' } };
  }

  /**
   * La signature : le code reçu, et le tracé à l'écran s'il y en a un. Un code ne sert qu'une fois, expire, et cinq
   * essais faux bloquent la session. Le résultat est toujours une signature d'essai.
   */
  async sign(viewer: Viewer, sessionId: string, input: { code: string; drawing?: string | null }): Promise<{ ok: true; value: SignatureProof } | Refusal | Problem> {
    const session = await this.db.first<SessionRow>('SELECT * FROM signature_sessions WHERE id = ?', [sessionId]);
    if (!session || session.network_id !== viewer.networkId) {
      await appendEvent(this.journal, { type: 'acces.refuse', actor: this.actor(viewer), subject: `signature:${sessionId}`, data: { rule: 'R16', role: String(viewer.role), kind: 'online_signature', code: 'unknown' } }, this.now);
      return { ok: false, rule: null, code: 'unknown_session' };
    }
    // Seul celui qui voit la fiche du document en entier présente la signature [R16].
    const doc = (await this.db.first<{ person_id: string; content: string }>('SELECT person_id, content FROM documents WHERE id = ?', [session.document_id]))!;
    const read = await this.acces.readFiche(viewer, doc.person_id);
    if (!read.ok) return read;
    if (read.view !== 'full' || (viewer.role !== 'agent' && viewer.role !== 'direction')) {
      await appendEvent(this.journal, { type: 'acces.refuse', actor: this.actor(viewer), subject: `signature:${sessionId}`, data: { rule: 'R16', role: String(viewer.role), kind: 'online_signature', code: 'not_assigned' } }, this.now);
      return { ok: false, rule: 'R16', code: 'not_assigned' };
    }
    if (session.status === 'signee') return { ok: false, rule: null, code: 'already_signed' };
    if (session.status === 'bloquee') return { ok: false, rule: null, code: 'blocked' };
    if (this.now().getTime() > Date.parse(session.expires_at)) return { ok: false, rule: null, code: 'expired' };
    if (input.drawing !== undefined && input.drawing !== null && (typeof input.drawing !== 'string' || input.drawing.length === 0 || input.drawing.length > MAX_DRAWING)) return { ok: false, rule: null, code: 'bad_drawing' };

    const given = typeof input.code === 'string' && /^\d{6}$/.test(input.code) ? await sha256(`${sessionId}:${input.code}`) : '';
    if (!given || !sameHash(given, session.code_hash)) {
      const attempts = Number(session.attempts) + 1;
      const blocked = attempts >= MAX_CODE_ATTEMPTS;
      // L'essai est compté seulement si la session est encore ouverte avec ce nombre d'essais : deux essais simultanés comptent deux fois.
      await this.db.run(`UPDATE signature_sessions SET attempts = ?, status = ? WHERE id = ? AND status = 'ouverte' AND attempts = ?`, [attempts, blocked ? 'bloquee' : 'ouverte', sessionId, Number(session.attempts)]);
      await appendEvent(this.journal, { type: 'signature.code_faux', actor: this.actor(viewer), subject: `signature:${sessionId}`, data: { attempts, blocked } }, this.now);
      return { ok: false, rule: null, code: blocked ? 'blocked' : 'wrong_code' };
    }
    // Le document n'a pas changé depuis l'ouverture de la session.
    const contentHash = await sha256(doc.content);
    if (contentHash !== session.content_hash) return { ok: false, rule: null, code: 'document_changed' };

    const signedAt = this.now().toISOString();
    const drawingHash = input.drawing ? await sha256(input.drawing) : null;
    const proof: SignatureProof = { documentId: session.document_id, contentHash, signedAt, method: drawingHash ? 'code_et_trace' : 'code', drawingHash, mode: 'essai', realSignature: false };
    const { changes } = await this.db.run(
      `UPDATE signature_sessions SET status = 'signee', signed_at = ?, drawing_hash = ?, proof = ? WHERE id = ? AND status = 'ouverte' AND attempts = ?`,
      [signedAt, drawingHash, JSON.stringify(proof), sessionId, Number(session.attempts)],
    );
    // Le code vient de servir à une autre demande : il ne sert qu'une fois.
    if (changes !== 1) return { ok: false, rule: null, code: 'already_signed' };
    await appendEvent(this.journal, { type: 'signature.essai', actor: this.actor(viewer), subject: `document:${session.document_id}`, data: { session: sessionId, method: proof.method, realSignature: false } }, this.now);
    return { ok: true, value: proof };
  }

  /** Le document signé est-il toujours celui de la preuve ? Une modification après coup se voit. */
  async verify(sessionId: string): Promise<{ signed: boolean; intact: boolean | null }> {
    const session = await this.db.first<SessionRow>('SELECT * FROM signature_sessions WHERE id = ?', [sessionId]);
    if (!session || session.status !== 'signee' || !session.proof) return { signed: false, intact: null };
    const proof = JSON.parse(session.proof) as SignatureProof;
    const doc = await this.db.first<{ content: string }>('SELECT content FROM documents WHERE id = ?', [session.document_id]);
    return { signed: true, intact: !!doc && (await sha256(doc.content)) === proof.contentHash };
  }
}

/** L'envoi d'essai : rien ne part ; l'envoi est seulement écrit au journal, sans le code ni la coordonnée [R13]. */
export class TrialCodeSender implements CodeSender {
  constructor(
    private readonly journal: JournalStore,
    private readonly now: () => Date = () => new Date(),
  ) {}
  async send(input: { networkId: string; personId: string; sessionId: string; code: string }): Promise<void> {
    await appendEvent(this.journal, { type: 'envoi.essai', actor: 'system:signature', subject: `person:${input.personId}`, data: { kind: 'signature_code', session: input.sessionId } }, this.now);
  }
}
