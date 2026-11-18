/**
 * La signature en ligne AIMMO (M06, D08), construite en mode essai.
 *
 * Un document contrôlé (D03) ouvre une session : un code à usage unique est envoyé au signataire par mail, par une
 * passant par le contrôle central des envois (en essai : rangé dans la boîte d'essai, jamais envoyé ; le vrai envoi
 * attend H05). Le code n'est jamais
 * gardé, seulement son empreinte ; il expire, ne sert qu'une fois, et cinq essais faux bloquent la session. La
 * signature manuscrite tracée à l'écran est possible : seule son empreinte est gardée. À la signature, le dossier de
 * preuve garde l'empreinte du document, l'horodatage et la méthode ; un document modifié depuis l'ouverture ne se
 * signe pas, et une modification après la signature est détectée par son empreinte.
 *
 * Un mandat à plusieurs mandants (couple, indivision, AU001) : chacun signe dans sa propre session, avec son propre code
 * envoyé à sa propre adresse ; le document n'est signé que quand tous l'ont signé dans sa même version (`allSigned`).
 *
 * Tant que l'avocat n'a pas validé le dossier de preuve (H24), une signature en ligne ne rend jamais un mandat signé
 * réel : elle n'inscrit rien au registre et ne range aucun mandat. Le résultat le dit (`realSignature: false`).
 */
import type { Acces } from '../acces/acces.ts';
import type { Viewer } from '../acces/droits.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import { trialChannels } from '../captation/essai.ts';
import { FicheClient } from '../db/fiche-client.ts';
import { ControleEnvois } from '../envoi/controle.ts';
import { SqlSendJournal } from '../envoi/journal-envois.ts';
import { DecisionEnvoi } from '../envoi/service.ts';
import { FicheUnique } from '../fiche/fusion.ts';
import { ficheFirstName } from '../fiche/prenom.ts';
import { ControlesSignature, documentMandants, type SignatureCheck } from './controles.ts';
import { sha256 } from './modeles.ts';

export const CODE_TTL_MINUTES = 10;
export const MAX_CODE_ATTEMPTS = 5;
const MAX_DRAWING = 200_000;

/** La finalité de l'accord du signataire à recevoir son code et son exemplaire par mail [R03]. */
export const ONLINE_SIGNATURE_PURPOSE = 'signature_en_ligne';

export interface SignatureProof {
  /** L'exemplaire est-il parti au signataire ? Sinon, `sendCopy` le reprendra. */
  copySent?: boolean;
  documentId: string;
  contentHash: string;
  signedAt: string;
  method: 'code' | 'code_et_trace';
  drawingHash: string | null;
  mode: 'essai';
  realSignature: false;
  /** Tous les mandants ont-ils signé cette version du document ? Sinon, le document n'est pas signé. */
  allSigned: boolean;
}

/** Où en est la signature en ligne d'un document : chaque mandant, dans l'ordre du document. */
export interface SignatureProgress {
  documentId: string;
  signers: { personId: string; signed: boolean }[];
  allSigned: boolean;
}

type Refusal = { ok: false; rule: 'R16'; code: string };
type Problem =
  | { ok: false; rule: 'R41'; code: 'checks_failed'; check: SignatureCheck }
  | { ok: false; rule: 'R41'; code: 'mandants_merged' }
  | { ok: false; rule: string | null; code: 'send_refused' }
  | { ok: false; rule: null; code: 'bad_consent' | 'bad_signer' | 'unknown_session' | 'expired' | 'blocked' | 'already_signed' | 'wrong_code' | 'document_changed' | 'bad_drawing' | 'unknown_document' | 'bad_schedule' | 'bad_piece' | 'bad_date' };

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
  signer_person_id: string | null;
}

export class SignatureEnLigne {
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly controles: ControlesSignature;

  constructor(
    private readonly db: SqlDatabase,
    private readonly acces: Acces,
    private readonly journal: JournalStore,
    options: { now?: () => Date; newId?: () => string } = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => crypto.randomUUID());
    this.controles = new ControlesSignature(db, acces, journal, options);
    const store = new FicheClient(db, { now: this.now });
    this.store = store;
    const fiche = new FicheUnique(db, store, { now: this.now });
    this.fiche = fiche;
    // Le code et l'exemplaire passent par le contrôle central, avec les seuls canaux du mode essai : rangés dans la
    // boîte d'essai, jamais envoyés [R26] ; le vrai envoi par mail attend H05.
    this.envois = new ControleEnvois(db, fiche, new DecisionEnvoi(db, store, fiche, { now: this.now }), {
      channels: trialChannels(db, journal, this.now),
      journal: new SqlSendJournal(db, undefined, this.now),
      now: this.now,
    });
  }

  private readonly store: FicheClient;
  private readonly envois: ControleEnvois;
  private readonly fiche: FicheUnique;

  private actor(viewer: Viewer): string {
    return `${String(viewer.role)}:${viewer.userId}`;
  }

  /** Ouvre une session de signature pour un document contrôlé et envoie le code au signataire. */
  async start(viewer: Viewer, documentId: string, input: { consentProof: string; signerId?: string }): Promise<{ ok: true; value: { sessionId: string; expiresAt: string; mode: 'essai' } } | Refusal | Problem> {
    if (viewer.role !== 'agent' && viewer.role !== 'direction') {
      await appendEvent(this.journal, { type: 'acces.refuse', actor: this.actor(viewer), subject: `document:${documentId}`, data: { rule: 'R16', role: String(viewer.role), kind: 'online_signature', code: 'role' } }, this.now);
      return { ok: false, rule: 'R16', code: 'role' };
    }
    if (typeof input.consentProof !== 'string' || input.consentProof.trim() === '' || input.consentProof.length > 300) return { ok: false, rule: null, code: 'bad_consent' };
    const checked = await this.controles.check(viewer, documentId);
    if (!checked.ok) return checked as Refusal | Problem;
    if (!checked.value.passed) return { ok: false, rule: 'R41', code: 'checks_failed', check: checked.value };
    const doc = (await this.db.first<{ person_id: string; content: string; agent_id: string }>('SELECT person_id, content, agent_id FROM documents WHERE id = ?', [documentId]))!;
    // Le signataire : un mandant du document, le premier par défaut ; jamais une autre fiche (AU001).
    const signer = await this.signerOf(documentId, doc.person_id, input.signerId);
    if (!signer) return { ok: false, rule: null, code: 'bad_signer' };
    // L'accord, le code et l'exemplaire touchent la fiche du signataire : qui présente la signature la voit en entier [R16].
    if (signer !== doc.person_id && !(await this.seesInFull(viewer, signer, `document:${documentId}`))) return { ok: false, rule: 'R16', code: 'not_assigned' };
    const contentHash = await sha256(doc.content);
    if (await this.signedBy(documentId, doc.person_id, signer, contentHash)) return { ok: false, rule: null, code: 'already_signed' };
    // Le signataire accepte, au rendez-vous, de recevoir son code et son exemplaire par mail ; l'agent en garde la preuve [R03].
    const consent = await this.fiche.hasConsentInForce(signer, ONLINE_SIGNATURE_PURPOSE, 'email');
    if (!consent) await this.store.addConsent({ networkId: viewer.networkId, personId: signer, purpose: ONLINE_SIGNATURE_PURPOSE, channel: 'email', proof: input.consentProof.trim(), givenAt: this.now() });
    const id = this.newId();
    const code = newCode();
    const expiresAt = new Date(this.now().getTime() + CODE_TTL_MINUTES * 60_000).toISOString();
    await this.db.run(
      `INSERT INTO signature_sessions (id, network_id, document_id, content_hash, code_hash, expires_at, attempts, status, created_by, created_at, signer_person_id) VALUES (?, ?, ?, ?, ?, ?, 0, 'ouverte', ?, ?, ?)`,
      [id, viewer.networkId, documentId, contentHash, await sha256(`${id}:${code}`), expiresAt, this.actor(viewer), this.now().toISOString(), signer],
    );
    const hello = await this.greeting(signer);
    const sent = await this.envois.send({
      networkId: viewer.networkId,
      agentId: doc.agent_id,
      personId: signer,
      channel: 'email',
      kind: 'alert',
      purpose: ONLINE_SIGNATURE_PURPOSE,
      subject: `signature:${id}`,
      fallbackTexts: [`${hello}Votre code de signature AIMMO : ${code}. Il est valable ${CODE_TTL_MINUTES} minutes. Ne le donnez à personne, pas même à votre agent.`],
      figures: [code, CODE_TTL_MINUTES],
      secrets: [{ kind: 'code', value: code }],
    });
    // Refusé (heure, exclusion, arrêt, pas de mail…) : la session reste sans code utilisable et expire.
    if (sent.status !== 'sent') return { ok: false, rule: sent.rule, code: 'send_refused' };
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
    // Chaque mandant aussi : une fiche confiée depuis à un autre agent arrête la signature, dont le résultat dit l'état de
    // tous [R16].
    for (const personId of await documentMandants(this.db, session.document_id, doc.person_id)) {
      if (personId !== doc.person_id && !(await this.seesInFull(viewer, personId, `signature:${sessionId}`))) return { ok: false, rule: 'R16', code: 'not_assigned' };
    }
    if (session.status === 'signee') return { ok: false, rule: null, code: 'already_signed' };
    if (session.status === 'bloquee') return { ok: false, rule: null, code: 'blocked' };
    if (this.now().getTime() > Date.parse(session.expires_at)) return { ok: false, rule: null, code: 'expired' };
    if (input.drawing !== undefined && input.drawing !== null && (typeof input.drawing !== 'string' || input.drawing.length === 0 || input.drawing.length > MAX_DRAWING)) return { ok: false, rule: null, code: 'bad_drawing' };

    const given = typeof input.code === 'string' && /^\d{6}$/.test(input.code) ? await sha256(`${sessionId}:${input.code}`) : '';
    if (!given || !sameHash(given, session.code_hash)) {
      // L'essai est compté dans la base, en un seul ordre : des essais simultanés comptent chacun [P0].
      const after = await this.db.first<{ attempts: number; status: string }>(
        `UPDATE signature_sessions SET attempts = attempts + 1, status = CASE WHEN attempts + 1 >= ? THEN 'bloquee' ELSE status END
         WHERE id = ? AND status = 'ouverte' RETURNING attempts, status`,
        [MAX_CODE_ATTEMPTS, sessionId],
      );
      const attempts = Number(after?.attempts ?? MAX_CODE_ATTEMPTS);
      const blocked = !after || after.status === 'bloquee';
      await appendEvent(this.journal, { type: 'signature.code_faux', actor: this.actor(viewer), subject: `signature:${sessionId}`, data: { attempts, blocked } }, this.now);
      return { ok: false, rule: null, code: blocked ? 'blocked' : 'wrong_code' };
    }
    // Le document n'a pas changé depuis l'ouverture de la session.
    const contentHash = await sha256(doc.content);
    if (contentHash !== session.content_hash) return { ok: false, rule: null, code: 'document_changed' };
    // Deux mandants réunis depuis l'ouverture ne sont plus deux personnes : aucune signature n'est reçue [R41].
    if (!(await this.distinctMandants(session.document_id, doc.person_id))) return { ok: false, rule: 'R41', code: 'mandants_merged' };

    const signedAt = this.now().toISOString();
    const drawingHash = input.drawing ? await sha256(input.drawing) : null;
    const proof = { documentId: session.document_id, contentHash, signedAt, method: drawingHash ? 'code_et_trace' : 'code', drawingHash, mode: 'essai', realSignature: false } as const;
    // L'exemplaire : le document signé, suivi de sa preuve, gardé avec la session pour être relu et envoyé.
    const copy = `${doc.content}\n<!-- Signature en ligne d'essai : session ${sessionId}, empreinte ${contentHash}, ${signedAt}, ${proof.method} -->\n`;
    const { changes } = await this.db.run(
      `UPDATE signature_sessions SET status = 'signee', signed_at = ?, drawing_hash = ?, proof = ?, copy_content = ?, copy_status = 'a_envoyer' WHERE id = ? AND status = 'ouverte'`,
      [signedAt, drawingHash, JSON.stringify(proof), copy, sessionId],
    );
    // Le code vient de servir à une autre demande : il ne sert qu'une fois.
    if (changes !== 1) return { ok: false, rule: null, code: 'already_signed' };
    // Le document n'est signé que quand chaque mandant a signé cette même version (AU001).
    const allSigned = (await this.progressOf(session.document_id, doc.person_id, contentHash)).allSigned;
    await appendEvent(this.journal, { type: 'signature.essai', actor: this.actor(viewer), subject: `document:${session.document_id}`, data: { session: sessionId, method: proof.method, realSignature: false, allSigned } }, this.now);
    // Le signataire reçoit son exemplaire, par le contrôle central ; refusé pour l'heure, il est repris plus tard.
    const copySent = await this.sendCopy(viewer, sessionId);
    return { ok: true, value: { ...proof, allSigned, copySent } };
  }

  /**
   * Envoie au signataire la référence de son exemplaire, par le contrôle central, si ce n'est pas déjà fait. Un refus
   * (heure, exclusion…) laisse l'exemplaire « à envoyer » : une nouvelle demande le reprendra.
   */
  async sendCopy(viewer: Viewer, sessionId: string): Promise<boolean> {
    const session = await this.db.first<SessionRow & { copy_status: string | null }>('SELECT * FROM signature_sessions WHERE id = ? AND network_id = ?', [sessionId, viewer.networkId]);
    if (!session || session.status !== 'signee') return false;
    if (session.copy_status === 'envoye') return true;
    const doc = await this.db.first<{ person_id: string; agent_id: string }>('SELECT person_id, agent_id FROM documents WHERE id = ?', [session.document_id]);
    if (!doc) return false;
    // Seul celui qui voit la fiche en entier, agent ou direction, demande l'envoi [R16].
    const read = await this.acces.readFiche(viewer, doc.person_id);
    if (!read.ok || read.view !== 'full' || (viewer.role !== 'agent' && viewer.role !== 'direction')) return false;
    const signer = session.signer_person_id ?? doc.person_id;
    if (signer !== doc.person_id && !(await this.seesInFull(viewer, signer, `signature:${sessionId}`))) return false;
    const hello = await this.greeting(signer);
    const result = await this.envois.send({
      networkId: viewer.networkId,
      agentId: doc.agent_id,
      personId: signer,
      channel: 'email',
      kind: 'alert',
      purpose: ONLINE_SIGNATURE_PURPOSE,
      subject: `signature:${sessionId}:exemplaire`,
      fallbackTexts: [`${hello}Votre document signé en ligne est enregistré sous la référence ${sessionId}. Votre exemplaire vous est remis avec ce message. Signature d’essai, sans valeur juridique.`],
      // La référence est un identifiant, pas un chiffre à vérifier : ses nombres sont permis [R10].
      figures: sessionId.match(/\d+/g) ?? [],
    });
    if (result.status !== 'sent') return false;
    await this.db.run(`UPDATE signature_sessions SET copy_status = 'envoye' WHERE id = ? AND copy_status = 'a_envoyer'`, [sessionId]);
    return true;
  }

  /** L'exemplaire d'une signature en ligne : qui voit la fiche du document en entier [R16]. */
  async copy(viewer: Viewer, sessionId: string): Promise<{ ok: true; content: string; sent: boolean } | Refusal | { ok: false; rule: null; code: 'unknown_session' | 'not_signed' }> {
    const session = await this.db.first<SessionRow & { copy_content: string | null; copy_status: string | null }>('SELECT * FROM signature_sessions WHERE id = ? AND network_id = ?', [sessionId, viewer.networkId]);
    if (!session) return { ok: false, rule: null, code: 'unknown_session' };
    if (session.status !== 'signee' || !session.copy_content) return { ok: false, rule: null, code: 'not_signed' };
    const doc = (await this.db.first<{ person_id: string }>('SELECT person_id FROM documents WHERE id = ?', [session.document_id]))!;
    const read = await this.acces.readFiche(viewer, doc.person_id);
    if (!read.ok) return read;
    if (read.view !== 'full') {
      await appendEvent(this.journal, { type: 'acces.refuse', actor: this.actor(viewer), subject: `signature:${sessionId}`, data: { rule: 'R16', role: String(viewer.role), kind: 'online_signature', code: 'not_assigned' } }, this.now);
      return { ok: false, rule: 'R16', code: 'not_assigned' };
    }
    return { ok: true, content: session.copy_content, sent: session.copy_status === 'envoye' };
  }

  /**
   * Où en est la signature en ligne d'un document : chaque mandant, et s'il a signé sa version actuelle. Qui voit la
   * fiche du document en entier, agent ou direction [R16].
   */
  async progress(viewer: Viewer, documentId: string): Promise<{ ok: true; value: SignatureProgress } | Refusal | { ok: false; rule: null; code: 'unknown_document' }> {
    const doc = await this.db.first<{ network_id: string; person_id: string; content: string }>('SELECT network_id, person_id, content FROM documents WHERE id = ?', [documentId]);
    if (!doc || doc.network_id !== viewer.networkId) return { ok: false, rule: null, code: 'unknown_document' };
    const read = await this.acces.readFiche(viewer, doc.person_id);
    if (!read.ok) return read;
    if (read.view !== 'full' || (viewer.role !== 'agent' && viewer.role !== 'direction')) {
      await appendEvent(this.journal, { type: 'acces.refuse', actor: this.actor(viewer), subject: `document:${documentId}`, data: { rule: 'R16', role: String(viewer.role), kind: 'online_signature', code: 'not_assigned' } }, this.now);
      return { ok: false, rule: 'R16', code: 'not_assigned' };
    }
    // Chaque signataire est une fiche : son état n'est rendu qu'à qui les voit toutes en entier [R16].
    for (const personId of await documentMandants(this.db, documentId, doc.person_id)) {
      if (personId !== doc.person_id && !(await this.seesInFull(viewer, personId, `document:${documentId}`))) return { ok: false, rule: 'R16', code: 'not_assigned' };
    }
    return { ok: true, value: { documentId, ...(await this.progressOf(documentId, doc.person_id, await sha256(doc.content))) } };
  }

  private async progressOf(documentId: string, firstPersonId: string, contentHash: string): Promise<{ signers: { personId: string; signed: boolean }[]; allSigned: boolean }> {
    const signers: { personId: string; signed: boolean }[] = [];
    for (const personId of await documentMandants(this.db, documentId, firstPersonId)) {
      signers.push({ personId, signed: await this.signedBy(documentId, firstPersonId, personId, contentHash) });
    }
    // Des mandants réunis depuis la génération : le document ne peut plus être signé par tous [R41].
    return { signers, allSigned: signers.every((s) => s.signed) && (await this.distinctMandants(documentId, firstPersonId)) };
  }

  /** Chaque mandant du document est-il encore une fiche à part ? */
  private async distinctMandants(documentId: string, firstPersonId: string): Promise<boolean> {
    const ids = await documentMandants(this.db, documentId, firstPersonId);
    const roots = new Set(await Promise.all(ids.map((id) => this.fiche.rootOf(id))));
    return roots.size === ids.length;
  }

  /** Le viewer voit-il cette fiche en entier, agent ou direction ? Sinon le refus va au journal [R16]. */
  private async seesInFull(viewer: Viewer, personId: string, subject: string): Promise<boolean> {
    const read = await this.acces.readFiche(viewer, personId);
    if (read.ok && read.view === 'full' && (viewer.role === 'agent' || viewer.role === 'direction')) return true;
    if (read.ok) await appendEvent(this.journal, { type: 'acces.refuse', actor: this.actor(viewer), subject, data: { rule: 'R16', role: String(viewer.role), kind: 'online_signature', code: 'not_assigned' } }, this.now);
    return false;
  }

  /** Le mandant qui signe : celui demandé s'il en est un, le premier sinon ; null pour toute autre fiche. */
  private async signerOf(documentId: string, firstPersonId: string, signerId: string | undefined): Promise<string | null> {
    if (signerId === undefined) return firstPersonId;
    if (typeof signerId !== 'string') return null;
    return (await documentMandants(this.db, documentId, firstPersonId)).includes(signerId) ? signerId : null;
  }

  /** Ce mandant a-t-il signé cette version du document ? Une session d'avant AU001 est celle du premier mandant. */
  private async signedBy(documentId: string, firstPersonId: string, personId: string, contentHash: string): Promise<boolean> {
    const row = await this.db.first(
      `SELECT id FROM signature_sessions WHERE document_id = ? AND status = 'signee' AND content_hash = ? AND COALESCE(signer_person_id, ?) = ? LIMIT 1`,
      [documentId, contentHash, firstPersonId, personId],
    );
    return row !== null;
  }

  /** Le premier message s'adresse à la personne par son prénom [R08]. */
  private async greeting(personId: string): Promise<string> {
    const first = await ficheFirstName(this.db, await this.fiche.membersOf(personId));
    return first ? `Bonjour ${first},\n\n` : 'Bonjour,\n\n';
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

/** Le code à usage unique et sa comparaison, repris par la signature en ligne du bail (M15, W12). */
export { newCode as newSignatureCode, sameHash as sameSignatureHash };
