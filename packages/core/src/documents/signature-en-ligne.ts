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
 * Essai ou réel (AU003) : une session est réelle seulement si la direction a enregistré la validation, par l'avocat du
 * réseau, du format de ce dossier de preuve (`PROOF_FORMAT`, H24) et si le mail réel est branché (H05, canaux donnés).
 * Sinon elle est d'essai : le code et l'exemplaire restent dans la boîte d'essai, rien n'est inscrit au registre, et
 * chaque résultat et chaque message le disent (`mode: 'essai'`, `realSignature: false`, « sans valeur juridique »). Le
 * mode est fixé à l'ouverture de la session et ne change plus.
 *
 * Signé réellement par tous les mandants dans la même version (`finish`) : le mandat est inscrit au registre comme un
 * mandat signé à distance (D04), le dossier de preuve est figé (empreintes du document, de l'exemplaire numéroté, de
 * chaque signature, horodatages, méthodes, référence de la validation), et chaque mandant reçoit, par le contrôle
 * central, son exemplaire suivi du dossier. Une signature d'essai ne compte jamais pour une signature réelle.
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
import { ControlesSignature, documentMandants, documentPersons, documentProxies, type SignatureCheck } from './controles.ts';
import { escapeHtml, sha256 } from './modeles.ts';
import { SignaturePapier } from './signature-papier.ts';
import type { OutboundChannel } from '../envoi/canaux.ts';

export const CODE_TTL_MINUTES = 10;
export const MAX_CODE_ATTEMPTS = 5;
const MAX_DRAWING = 200_000;

/** La finalité de l'accord du signataire à recevoir son code et son exemplaire par mail [R03]. */
export const ONLINE_SIGNATURE_PURPOSE = 'signature_en_ligne';

/**
 * Le format du dossier de preuve, tel que l'avocat le valide (H24). Un format nouveau demande une validation nouvelle :
 * celle d'un autre format ne rend aucune signature réelle.
 */
export const PROOF_FORMAT = 'aimmo-preuve-1';

export type SignatureMode = 'essai' | 'reel';

/** Ce qui manque pour signer réellement : le mail réel (H05), la validation de l'avocat (H24). */
export type RealSignatureMissing = 'mail_reel' | 'validation_avocat';

const MANDATE_KINDS = ['mandat_vente_simple', 'mandat_vente_exclusif'];
/** Un essai de remise réservé sans accusé ni échec depuis ce temps est tenu pour abandonné (panne avant la remise). */
const ABANDONED_SEND_MS = 60 * 60_000;
const VALIDATION_REF = /^[\p{L}\p{N} ._/'-]{3,120}$/u;

/** Le dossier de preuve d'un document signé réellement par tous, et ce qui en est remis à chaque mandant. */
export interface SignatureDossier {
  documentId: string;
  contentHash: string;
  dossierHash: string;
  copyHash: string;
  /** Le numéro au registre, pour un mandat ; null pour un autre document. */
  number: string | null;
  remises: { position: number; sent: boolean }[];
}

export interface SignatureProof {
  /** L'exemplaire est-il parti au signataire ? Sinon, `sendCopy` le reprendra. */
  copySent?: boolean;
  documentId: string;
  contentHash: string;
  signedAt: string;
  method: 'code' | 'code_et_trace';
  drawingHash: string | null;
  mode: SignatureMode;
  /** Vrai seulement pour une session réelle (AU003) ; une signature d'essai ne vaut jamais signature. */
  realSignature: boolean;
  /** Tous les mandants ont-ils signé cette version du document ? Sinon, le document n'est pas signé. */
  allSigned: boolean;
}

/** Où en est la signature en ligne d'un document : chaque mandant, dans l'ordre du document. */
export interface SignatureProgress {
  documentId: string;
  signers: { personId: string; signed: boolean }[];
  allSigned: boolean;
  /** Chaque mandant a-t-il signé cette version en réel (AU003) ? */
  allSignedReal: boolean;
}

type Refusal = { ok: false; rule: 'R16'; code: string };
type Problem =
  | { ok: false; rule: 'R41'; code: 'checks_failed'; check: SignatureCheck }
  | { ok: false; rule: 'R41'; code: 'mandants_merged' }
  | { ok: false; rule: string | null; code: 'send_refused' }
  | { ok: false; rule: null; code: 'not_all_signed' | 'no_validation' | 'bad_reference' | 'not_a_mandate' | 'bad_consent' | 'bad_signer' | 'unknown_session' | 'expired' | 'blocked' | 'already_signed' | 'wrong_code' | 'document_changed' | 'bad_drawing' | 'unknown_document' | 'bad_schedule' | 'bad_piece' | 'bad_date' };

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
  mode: SignatureMode | null;
  created_at: string;
}

export class SignatureEnLigne {
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly controles: ControlesSignature;

  constructor(
    private readonly db: SqlDatabase,
    private readonly acces: Acces,
    private readonly journal: JournalStore,
    private readonly options: {
      now?: () => Date;
      newId?: () => string;
      channels?: readonly OutboundChannel[];
      /** Le stockage des scans du mandat, où la procuration d'un mandant représenté se vérifie (AU059). */
      scans?: { has(ref: string): Promise<boolean> } | null;
    } = {},
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
    // Le mail réel, quand il est branché (H05) : seulement pour une session réelle.
    this.realEnvois = options.channels && options.channels.length > 0
      ? new ControleEnvois(db, fiche, new DecisionEnvoi(db, store, fiche, { now: this.now }), {
        channels: [...options.channels],
        journal: new SqlSendJournal(db, undefined, this.now),
        now: this.now,
      })
      : null;
  }

  private readonly store: FicheClient;
  private readonly envois: ControleEnvois;
  private readonly realEnvois: ControleEnvois | null;

  /** Une session réelle ne part que par le mail réel, jamais par la boîte d'essai : sans lui, rien ne part. */
  private envoisFor(mode: SignatureMode | null): ControleEnvois | null {
    return mode === 'reel' ? this.realEnvois : this.envois;
  }

  /**
   * Ce sujet a-t-il été remis à la personne par le canal réel (envoi fait, puis panne avant d'être noté) ? Seul l'accusé
   * du canal le prouve (`outbound_refs`, écrit après la remise) ; un sujet réservé ou un envoi en cours ne suffit pas.
   */
  private async deliveredBefore(personId: string, subject: string): Promise<boolean> {
    const row = await this.db.first(
      `SELECT 1 FROM message_subjects s JOIN outbound_refs r ON r.message_id = s.message_id
       WHERE s.person_id = ? AND s.subject = ?
         AND NOT EXISTS (SELECT 1 FROM send_log l WHERE l.message_id = s.message_id AND l.outcome = 'failed')
         AND NOT EXISTS (SELECT 1 FROM trial_outbox t WHERE t.message_id = s.message_id) LIMIT 1`,
      [personId, subject],
    );
    return row !== null;
  }

  /** La validation de l'avocat en vigueur pour le format de ce dossier de preuve, s'il y en a une. */
  private async validationOf(networkId: string): Promise<{ id: string; reference: string; validated_on: string } | null> {
    return this.db.first<{ id: string; reference: string; validated_on: string }>(
      'SELECT id, reference, validated_on FROM signature_validations WHERE network_id = ? AND proof_format = ? ORDER BY recorded_at DESC, id DESC LIMIT 1',
      [networkId, PROOF_FORMAT],
    );
  }

  private async modeFor(networkId: string): Promise<{ mode: SignatureMode; missing: RealSignatureMissing[] }> {
    const missing: RealSignatureMissing[] = [];
    if (!this.realEnvois) missing.push('mail_reel');
    if (!(await this.validationOf(networkId))) missing.push('validation_avocat');
    return { mode: missing.length === 0 ? 'reel' : 'essai', missing };
  }

  /** Le mode d'une signature en ligne ouverte maintenant, et ce qui manque pour qu'elle soit réelle. Agent ou direction [R16]. */
  async mode(viewer: Viewer): Promise<{ ok: true; value: { mode: SignatureMode; missing: RealSignatureMissing[]; proofFormat: string } } | Refusal> {
    if (viewer.role !== 'agent' && viewer.role !== 'direction') {
      await appendEvent(this.journal, { type: 'acces.refuse', actor: this.actor(viewer), subject: null, data: { rule: 'R16', role: String(viewer.role), kind: 'online_signature_mode', code: 'role' } }, this.now);
      return { ok: false, rule: 'R16', code: 'role' };
    }
    return { ok: true, value: { ...(await this.modeFor(viewer.networkId)), proofFormat: PROOF_FORMAT } };
  }

  /**
   * La direction enregistre la validation, par l'avocat du réseau, du format de ce dossier de preuve (H24) : la référence
   * de son avis écrit et sa date. C'est un geste humain : rien ne l'enregistre à sa place. Rien ne s'efface ensuite.
   */
  async recordValidation(viewer: Viewer, input: { reference: string; validatedOn: Date }): Promise<{ ok: true; id: string } | Refusal | Problem> {
    if (viewer.role !== 'direction') {
      await appendEvent(this.journal, { type: 'acces.refuse', actor: this.actor(viewer), subject: null, data: { rule: 'R16', role: String(viewer.role), kind: 'signature_validation', code: 'role' } }, this.now);
      return { ok: false, rule: 'R16', code: 'role' };
    }
    if (typeof input.reference !== 'string' || !VALIDATION_REF.test(input.reference.trim())) return { ok: false, rule: null, code: 'bad_reference' };
    if (!(input.validatedOn instanceof Date) || Number.isNaN(input.validatedOn.getTime()) || input.validatedOn.getTime() > this.now().getTime()) return { ok: false, rule: null, code: 'bad_date' };
    const id = this.newId();
    await this.db.run(
      'INSERT INTO signature_validations (id, network_id, proof_format, reference, validated_on, recorded_by, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [id, viewer.networkId, PROOF_FORMAT, input.reference.trim(), input.validatedOn.toISOString().slice(0, 10), this.actor(viewer), this.now().toISOString()],
    );
    await appendEvent(this.journal, { type: 'signature.validation_avocat', actor: this.actor(viewer), subject: null, data: { validation: id, proofFormat: PROOF_FORMAT } }, this.now);
    return { ok: true, id };
  }
  private readonly fiche: FicheUnique;

  private actor(viewer: Viewer): string {
    return `${String(viewer.role)}:${viewer.userId}`;
  }

  /** Ouvre une session de signature pour un document contrôlé et envoie le code au signataire. */
  async start(viewer: Viewer, documentId: string, input: { consentProof: string; signerId?: string }): Promise<{ ok: true; value: { sessionId: string; expiresAt: string; mode: SignatureMode } } | Refusal | Problem> {
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
    // Le mode est fixé ici, et ne change plus. Une signature d'essai ne compte pas pour une session réelle (AU003).
    // Seul un mandat de vente se signe en réel : il s'inscrit au registre. Un avenant ou un autre document reste d'essai
    // tant que sa propre inscription n'est pas faite (signed_amendments, R44) : une tâche à part (AU003).
    const docKind = (await this.db.first<{ kind: string }>('SELECT kind FROM documents WHERE id = ?', [documentId]))!.kind;
    const mode: SignatureMode = MANDATE_KINDS.includes(docKind) ? (await this.modeFor(viewer.networkId)).mode : 'essai';
    if (await this.signedBy(documentId, doc.person_id, signer, contentHash, mode === 'reel' ? 'reel' : undefined)) return { ok: false, rule: null, code: 'already_signed' };
    // Un mandant représenté par procuration (AU059) : le code part à son représentant, qui signe pour lui.
    const proxy = (await documentProxies(this.db, documentId)).find((p) => p.mandantId === signer) ?? null;
    if (proxy && !(await this.seesInFull(viewer, proxy.proxyId, `document:${documentId}`))) return { ok: false, rule: 'R16', code: 'not_assigned' };
    const recipient = proxy ? proxy.proxyId : signer;
    // Celui qui reçoit le code accepte, au rendez-vous, de recevoir son code et son exemplaire par mail ; l'agent en garde la preuve [R03].
    const consent = await this.fiche.hasConsentInForce(recipient, ONLINE_SIGNATURE_PURPOSE, 'email');
    if (!consent) await this.store.addConsent({ networkId: viewer.networkId, personId: recipient, purpose: ONLINE_SIGNATURE_PURPOSE, channel: 'email', proof: input.consentProof.trim(), givenAt: this.now() });
    const id = this.newId();
    const code = newCode();
    const expiresAt = new Date(this.now().getTime() + CODE_TTL_MINUTES * 60_000).toISOString();
    await this.db.run(
      `INSERT INTO signature_sessions (id, network_id, document_id, content_hash, code_hash, expires_at, attempts, status, created_by, created_at, signer_person_id, mode) VALUES (?, ?, ?, ?, ?, ?, 0, 'ouverte', ?, ?, ?, ?)`,
      [id, viewer.networkId, documentId, contentHash, await sha256(`${id}:${code}`), expiresAt, this.actor(viewer), this.now().toISOString(), signer, mode],
    );
    if (proxy) {
      await this.db.run('INSERT INTO signature_session_proxies (session_id, network_id, document_id, mandant_person_id, proxy_person_id, created_at) VALUES (?, ?, ?, ?, ?, ?)', [
        id,
        viewer.networkId,
        documentId,
        signer,
        proxy.proxyId,
        this.now().toISOString(),
      ]);
    }
    const hello = await this.greeting(recipient);
    const sent = await this.envoisFor(mode)!.send({
      networkId: viewer.networkId,
      agentId: doc.agent_id,
      personId: recipient,
      channel: 'email',
      kind: 'alert',
      purpose: ONLINE_SIGNATURE_PURPOSE,
      subject: `signature:${id}`,
      fallbackTexts: [`${hello}${proxy ? 'Vous signez en vertu de votre procuration. ' : ''}Votre code de signature AIMMO : ${code}. Il est valable ${CODE_TTL_MINUTES} minutes. Ne le donnez à personne, pas même à votre agent.${mode === 'essai' ? ' Signature d’essai, sans valeur juridique.' : ''}`],
      figures: [code, CODE_TTL_MINUTES],
      secrets: [{ kind: 'code', value: code }],
    });
    // Refusé (heure, exclusion, arrêt, pas de mail…) : la session reste sans code utilisable et expire.
    if (sent.status !== 'sent') return { ok: false, rule: sent.rule, code: 'send_refused' };
    await appendEvent(this.journal, { type: 'signature.ouverte', actor: this.actor(viewer), subject: `document:${documentId}`, data: { session: id, mode } }, this.now);
    return { ok: true, value: { sessionId: id, expiresAt, mode } };
  }

  /**
   * La signature : le code reçu, et le tracé à l'écran s'il y en a un. Un code ne sert qu'une fois, expire, et cinq
   * essais faux bloquent la session. Le résultat dit le mode de la session ; signé réellement par tous, le document est
   * fini (`finish`).
   */
  async sign(viewer: Viewer, sessionId: string, input: { code: string; drawing?: string | null }): Promise<{ ok: true; value: SignatureProof & { finished?: { ok: true } | { ok: false; rule: string | null; code: string } } } | Refusal | Problem> {
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
    // Chaque représentant aussi, avant que le code ne serve (AU059).
    for (const personId of await documentPersons(this.db, session.document_id, doc.person_id)) {
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
    const mode: SignatureMode = session.mode === 'reel' ? 'reel' : 'essai';
    const proof = { documentId: session.document_id, contentHash, signedAt, method: drawingHash ? 'code_et_trace' : 'code', drawingHash, mode, realSignature: mode === 'reel' } as const;
    // L'exemplaire : le document signé, suivi de sa preuve, gardé avec la session pour être relu et envoyé.
    const label = mode === 'reel' ? 'Signature électronique AIMMO' : 'Signature en ligne d\'essai, sans valeur juridique';
    const copy = `${doc.content}\n<!-- ${label} : session ${sessionId}, empreinte ${contentHash}, ${signedAt}, ${proof.method} -->\n`;
    const { changes } = await this.db.run(
      `UPDATE signature_sessions SET status = 'signee', signed_at = ?, drawing_hash = ?, proof = ?, copy_content = ?, copy_status = 'a_envoyer' WHERE id = ? AND status = 'ouverte'`,
      [signedAt, drawingHash, JSON.stringify(proof), copy, sessionId],
    );
    // Le code vient de servir à une autre demande : il ne sert qu'une fois.
    if (changes !== 1) return { ok: false, rule: null, code: 'already_signed' };
    // Le document n'est signé que quand chaque mandant a signé cette même version (AU001).
    // Une session réelle : seules les signatures réelles comptent, jamais une d'essai (AU003).
    const allSigned = (await this.progressOf(session.document_id, doc.person_id, contentHash, mode === 'reel' ? 'reel' : undefined)).allSigned;
    await appendEvent(this.journal, { type: mode === 'reel' ? 'signature.reelle' : 'signature.essai', actor: this.actor(viewer), subject: `document:${session.document_id}`, data: { session: sessionId, method: proof.method, realSignature: mode === 'reel', allSigned } }, this.now);
    // Le signataire reçoit son exemplaire, par le contrôle central ; refusé pour l'heure, il est repris plus tard.
    const copySent = await this.sendCopy(viewer, sessionId);
    // Le dernier mandant a signé réellement : le document est fini, et chacun reçoit son exemplaire et le dossier.
    // La source du mandat manque encore (R38) : le document attend, et l'agent le finit en la donnant.
    if (mode === 'reel' && allSigned) {
      const finished = await this.finish(viewer, session.document_id);
      return { ok: true, value: { ...proof, allSigned, copySent, finished: finished.ok ? { ok: true } : { ok: false, rule: finished.rule, code: finished.code } } };
    }
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
    const mandant = session.signer_person_id ?? doc.person_id;
    if (mandant !== doc.person_id && !(await this.seesInFull(viewer, mandant, `signature:${sessionId}`))) return false;
    // Signé par un représentant (AU059) : la référence part à lui, qui a reçu le code et donné son accord.
    const proxy = await this.db.first<{ proxy_person_id: string }>('SELECT proxy_person_id FROM signature_session_proxies WHERE session_id = ?', [sessionId]);
    if (proxy && !(await this.seesInFull(viewer, proxy.proxy_person_id, `signature:${sessionId}`))) return false;
    const signer = proxy?.proxy_person_id ?? mandant;
    const hello = await this.greeting(signer);
    const real = session.mode === 'reel';
    const envois = this.envoisFor(session.mode);
    if (!envois) return false;
    const result = await envois.send({
      networkId: viewer.networkId,
      agentId: doc.agent_id,
      personId: signer,
      channel: 'email',
      kind: 'alert',
      purpose: ONLINE_SIGNATURE_PURPOSE,
      subject: `signature:${sessionId}:exemplaire`,
      fallbackTexts: [real
        ? `${hello}Votre signature électronique AIMMO est enregistrée sous la référence ${sessionId}. Quand chaque mandant aura signé, votre exemplaire signé et son dossier de preuve vous seront remis.`
        : `${hello}Votre document signé en ligne est enregistré sous la référence ${sessionId}. Votre exemplaire vous est remis avec ce message. Signature d’essai, sans valeur juridique.`],
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
    // L'exemplaire nomme chaque mandant : chacune de leurs fiches est vue en entier (AU001).
    let others = true;
    for (const personId of (await documentPersons(this.db, session.document_id, doc.person_id)).slice(1)) {
      if (!(await this.seesInFull(viewer, personId, `signature:${sessionId}`))) others = false;
    }
    if (read.view !== 'full' || !others) {
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
    for (const personId of await documentPersons(this.db, documentId, doc.person_id)) {
      if (personId !== doc.person_id && !(await this.seesInFull(viewer, personId, `document:${documentId}`))) return { ok: false, rule: 'R16', code: 'not_assigned' };
    }
    const hash = await sha256(doc.content);
    // `allSignedReal` : chacun a signé cette version en réel ; une signature d'essai n'y compte jamais (AU003).
    const real = await this.progressOf(documentId, doc.person_id, hash, 'reel');
    return { ok: true, value: { documentId, ...(await this.progressOf(documentId, doc.person_id, hash)), allSignedReal: real.allSigned } };
  }

  private async progressOf(documentId: string, firstPersonId: string, contentHash: string, mode?: 'reel'): Promise<{ signers: { personId: string; signed: boolean }[]; allSigned: boolean }> {
    const signers: { personId: string; signed: boolean }[] = [];
    for (const personId of await documentMandants(this.db, documentId, firstPersonId)) {
      signers.push({ personId, signed: await this.signedBy(documentId, firstPersonId, personId, contentHash, mode) });
    }
    // Des mandants réunis depuis la génération : le document ne peut plus être signé par tous [R41].
    return { signers, allSigned: signers.every((s) => s.signed) && (await this.distinctMandants(documentId, firstPersonId)) };
  }

  /** Chaque mandant du document est-il encore une fiche à part ? */
  private async distinctMandants(documentId: string, firstPersonId: string): Promise<boolean> {
    const ids = await documentMandants(this.db, documentId, firstPersonId);
    const roots = new Set(await Promise.all(ids.map((id) => this.fiche.rootOf(id))));
    if (roots.size !== ids.length) return false;
    // Un représentant réuni depuis à un mandant n'en est plus un : rien ne se signe (AU059) [R41].
    for (const p of await documentProxies(this.db, documentId)) {
      if (roots.has(await this.fiche.rootOf(p.proxyId))) return false;
    }
    return true;
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
  private async signedBy(documentId: string, firstPersonId: string, personId: string, contentHash: string, mode?: 'reel'): Promise<boolean> {
    const row = await this.db.first(
      `SELECT id FROM signature_sessions WHERE document_id = ? AND status = 'signee' AND content_hash = ? AND COALESCE(signer_person_id, ?) = ?${mode === 'reel' ? ` AND mode = 'reel'` : ''} LIMIT 1`,
      [documentId, contentHash, firstPersonId, personId],
    );
    return row !== null;
  }

  /** Le premier message s'adresse à la personne par son prénom [R08]. */
  private async greeting(personId: string): Promise<string> {
    const first = await ficheFirstName(this.db, await this.fiche.membersOf(personId));
    return first ? `Bonjour ${first},\n\n` : 'Bonjour,\n\n';
  }

  /**
   * Finit un document signé réellement par chacun de ses mandants dans sa version actuelle (AU003) : un mandat est inscrit
   * au registre comme signé à distance (D04) ; le dossier de preuve est figé ; chaque mandant reçoit, par le contrôle
   * central, son exemplaire suivi du dossier. Une signature d'essai n'y compte jamais. Redemandé, il reprend là où il
   * s'était arrêté (une remise refusée pour l'heure part à la demande suivante), sans rien refaire. Qui voit la fiche de
   * chaque mandant en entier, agent ou direction [R16].
   */
  async finish(viewer: Viewer, documentId: string, input: { source?: string | null; sourceDetail?: string | null } = {}): Promise<{ ok: true; value: SignatureDossier } | Refusal | Problem | { ok: false; rule: string | null; code: string }> {
    const doc = await this.db.first<{ network_id: string; person_id: string; agent_id: string; kind: string; content: string; template_id: string | null; template_version: number | null; template_hash: string | null }>(
      'SELECT network_id, person_id, agent_id, kind, content, template_id, template_version, template_hash FROM documents WHERE id = ?',
      [documentId],
    );
    if (!doc || doc.network_id !== viewer.networkId) return { ok: false, rule: null, code: 'unknown_document' };
    if (!MANDATE_KINDS.includes(doc.kind)) return { ok: false, rule: null, code: 'not_a_mandate' };
    const mandants = await documentMandants(this.db, documentId, doc.person_id);
    for (const personId of mandants) {
      if (!(await this.seesInFull(viewer, personId, `document:${documentId}`))) return { ok: false, rule: 'R16', code: 'not_assigned' };
    }
    const contentHash = await sha256(doc.content);
    // Chaque mandant, une session réelle signée sur cette version ; des mandants réunis depuis ne passent pas [R41].
    const sessions: (SessionRow & { drawing_hash: string | null })[] = [];
    for (const personId of mandants) {
      const row = await this.db.first<SessionRow & { drawing_hash: string | null }>(
        `SELECT * FROM signature_sessions WHERE document_id = ? AND status = 'signee' AND mode = 'reel' AND content_hash = ? AND COALESCE(signer_person_id, ?) = ? ORDER BY signed_at, id LIMIT 1`,
        [documentId, contentHash, doc.person_id, personId],
      );
      if (!row) return { ok: false, rule: 'R41', code: 'not_all_signed' };
      sessions.push(row);
    }
    if (!(await this.distinctMandants(documentId, doc.person_id))) return { ok: false, rule: 'R41', code: 'mandants_merged' };

    type DossierRow = { dossier_hash: string; copy_hash: string; content_hash: string; dossier: string; copy_content: string };
    const DOSSIER_SQL = 'SELECT dossier_hash, copy_hash, content_hash, dossier, copy_content FROM signature_dossiers WHERE document_id = ?';
    let dossierRow = await this.db.first<DossierRow>(DOSSIER_SQL, [documentId]);
    if (dossierRow && dossierRow.content_hash !== contentHash) return { ok: false, rule: null, code: 'document_changed' };
    let number: string | null = null;
    if (!dossierRow) {
      const validation = await this.validationOf(viewer.networkId);
      if (!validation) return { ok: false, rule: null, code: 'no_validation' };
      const signedAt = sessions.map((r) => r.signed_at!).sort().at(-1)!;
      // Le mandat, inscrit au registre avec son numéro, comme un mandat signé à distance : les contrôles sont refaits,
      // et une reprise continue là où elle s'était arrêtée [R39, R41].
      let numbered = doc.content;
      if (MANDATE_KINDS.includes(doc.kind)) {
        const registered = await new SignaturePapier(this.db, this.acces, this.journal, { now: this.now, ...(this.options.scans !== undefined ? { powers: this.options.scans } : {}) }).register(viewer, documentId, {
          signedAt: new Date(signedAt),
          place: 'distance',
          scanRef: `signature-en-ligne/${documentId}`,
          // La source du mandat, donnée ou reprise de la fiche [R38].
          source: input.source ?? null,
          sourceDetail: input.sourceDetail ?? null,
        });
        if (!registered.ok && registered.code !== 'already_signed') return registered;
        const signed = await this.db.first<{ number: string | null; copy_content: string | null }>('SELECT number, copy_content FROM signed_documents WHERE document_id = ?', [documentId]);
        if (!signed?.number || !signed.copy_content) return { ok: false, rule: 'R39', code: 'not_inscribed' };
        number = signed.number;
        numbered = signed.copy_content;
      }
      const copyOfNumbered = await sha256(numbered);
      const fmt = (iso: string) => escapeHtml(iso);
      // Qui a signé pour qui (AU059) : la session d'un mandant représenté a envoyé son code au représentant.
      const byProxy = new Set((await this.db.all<{ session_id: string }>('SELECT session_id FROM signature_session_proxies WHERE document_id = ?', [documentId])).map((r) => r.session_id));
      const lines = sessions.map((r, i) =>
        `<li>Mandant ${i + 1} : session ${escapeHtml(r.id)} ; ${byProxy.has(r.id) ? 'signé par son représentant, en vertu de la procuration nommée au document ; ' : ''}code à usage unique envoyé par mail le ${fmt(r.created_at)} ; signé le ${fmt(r.signed_at!)} ; ${r.drawing_hash ? `code et signature tracée à l’écran (empreinte du tracé ${escapeHtml(r.drawing_hash)})` : 'code'}.</li>`);
      const dossier = [
        '<section class="dossier-preuve">',
        '<h2>Dossier de preuve de la signature électronique AIMMO</h2>',
        `<p>Format ${PROOF_FORMAT}, validé par l’avocat du réseau : référence ${escapeHtml(validation.reference)}, du ${escapeHtml(validation.validated_on)}.</p>`,
        `<p>Document ${escapeHtml(documentId)}${doc.template_id ? `, modèle ${escapeHtml(doc.template_id)} version ${String(doc.template_version ?? '')} (empreinte ${escapeHtml(doc.template_hash ?? '')})` : ''}.</p>`,
        `<p>Empreinte SHA-256 du document signé : ${contentHash}.</p>`,
        number ? `<p>Numéro au registre des mandats : ${escapeHtml(number)} ; empreinte de l’exemplaire numéroté : ${copyOfNumbered}.</p>` : '',
        `<ol>${lines.join('')}</ol>`,
        '<p>Chaque signataire a signé cette même version. Une modification du document après coup change son empreinte et se voit.</p>',
        '</section>',
      ].filter((l) => l !== '').join('\n');
      const dossierHash = await sha256(dossier);
      const copy = `${numbered}\n${dossier}\n`;
      const { changes } = await this.db.run(
        `INSERT INTO signature_dossiers (document_id, network_id, content_hash, validation_id, dossier, dossier_hash, copy_content, copy_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (document_id) DO NOTHING`,
        [documentId, viewer.networkId, contentHash, validation.id, dossier, dossierHash, copy, await sha256(copy), this.now().toISOString()],
      );
      if (changes === 1) {
        await appendEvent(this.journal, { type: 'signature.dossier', actor: this.actor(viewer), subject: `document:${documentId}`, data: { dossierHash, signers: mandants.length, registered: number !== null } }, this.now);
      }
      dossierRow = (await this.db.first<DossierRow>(DOSSIER_SQL, [documentId]))!;
    }
    // Une remise par mandant, posée à chaque demande : une panne après le dossier ne les perd jamais.
    let position = 1;
    for (const personId of mandants) {
      await this.db.run(
        `INSERT INTO signature_remises (document_id, person_id, network_id, position, status, created_at) VALUES (?, ?, ?, ?, 'a_envoyer', ?) ON CONFLICT (document_id, person_id) DO NOTHING`,
        [documentId, personId, viewer.networkId, position++, this.now().toISOString()],
      );
    }
    if (number === null && MANDATE_KINDS.includes(doc.kind)) number = (await this.db.first<{ number: string | null }>('SELECT number FROM signed_documents WHERE document_id = ?', [documentId]))?.number ?? null;

    // La remise : chaque mandant, son exemplaire et le dossier, par le mail réel et le contrôle central [R16, R26].
    const remises: { position: number; sent: boolean }[] = [];
    const markSent = (personId: string) => this.db.run(`UPDATE signature_remises SET status = 'envoyee', sent_at = ? WHERE document_id = ? AND person_id = ? AND status = 'a_envoyer'`, [this.now().toISOString(), documentId, personId]);
    // Un mandant représenté (AU059) : son exemplaire part à son représentant, qui a reçu le code et donné son accord.
    const proxies = await documentProxies(this.db, documentId);
    for (const row of await this.db.all<{ person_id: string; position: number; status: string; attempt: number }>('SELECT person_id, position, status, attempt FROM signature_remises WHERE document_id = ? ORDER BY position', [documentId])) {
      const r = { ...row, mandant_id: row.person_id, person_id: proxies.find((p) => p.mandantId === row.person_id)?.proxyId ?? row.person_id };
      if (r.status === 'envoyee') { remises.push({ position: r.position, sent: true }); continue; }
      const envois = this.envoisFor('reel');
      // Sans mail réel, rien ne part : la remise reste à envoyer.
      if (!envois) { remises.push({ position: r.position, sent: false }); continue; }
      // Le sujet d'un essai d'envoi : le premier garde le sujet de base, les suivants portent leur rang.
      const subjectOf = (attempt: number) => `signature:${documentId}:remise:${r.position}${attempt > 1 ? `:${attempt}` : ''}`;
      // Déjà partie par un essai, puis une panne avant d'être notée : elle est notée, jamais renvoyée.
      let delivered = false;
      for (let a = 1; a <= r.attempt && !delivered; a++) delivered = await this.deliveredBefore(r.person_id, subjectOf(a));
      if (delivered) { await markSent(r.mandant_id); remises.push({ position: r.position, sent: true }); continue; }
      let attempt = r.attempt;
      // Un essai réservé, sans accusé du canal ni échec écrit, depuis plus d'une heure : abandonné (panne avant la
      // remise). Un nouvel essai, sous un nouveau sujet et avec un texte qui porte son rang (l'anti-doublon du texte,
      // R05, refuserait sinon le même texte), le remplace ; au pire, le mandant reçoit deux fois son exemplaire.
      const stale = await this.db.first<{ created_at: string }>('SELECT created_at FROM message_subjects WHERE person_id = ? AND subject = ? ORDER BY created_at DESC LIMIT 1', [r.person_id, subjectOf(attempt)]);
      if (stale && this.now().getTime() - Date.parse(stale.created_at) > ABANDONED_SEND_MS) {
        const { changes } = await this.db.run(`UPDATE signature_remises SET attempt = attempt + 1 WHERE document_id = ? AND person_id = ? AND status = 'a_envoyer' AND attempt = ?`, [documentId, r.mandant_id, attempt]);
        // Une autre demande vient de prendre le nouvel essai : elle l'envoie.
        if (changes !== 1) { remises.push({ position: r.position, sent: false }); continue; }
        attempt += 1;
      }
      const hello = await this.greeting(r.person_id);
      const what = number ? `Votre mandat n° ${number} est signé électroniquement par chaque mandant.` : 'Votre document est signé électroniquement par chaque signataire.';
      const sent = await envois.send({
        networkId: viewer.networkId,
        agentId: doc.agent_id,
        personId: r.person_id,
        channel: 'email',
        kind: 'alert',
        purpose: ONLINE_SIGNATURE_PURPOSE,
        subject: subjectOf(attempt),
        fallbackTexts: [`${hello}${what} Votre exemplaire signé et son dossier de preuve vous sont remis en pièces jointes de ce message, sous la référence ${documentId}, empreinte ${dossierRow.copy_hash}.${attempt > 1 ? ` Envoi n° ${attempt} : le précédent n’a pas abouti.` : ''}`],
        // L'exemplaire signé (suivi du dossier) et le dossier seul, en pièces jointes : le mandant les garde chez lui.
        attachments: [
          { name: `exemplaire-signe-${number ?? documentId}.html`, contentType: 'text/html', content: dossierRow.copy_content },
          { name: `dossier-de-preuve-${number ?? documentId}.html`, contentType: 'text/html', content: dossierRow.dossier },
        ],
        // Le numéro, la référence et l'empreinte sont des identifiants, pas des chiffres à vérifier [R10].
        figures: [attempt, ...(number?.match(/\d+/g) ?? []), ...(documentId.match(/\d+/g) ?? []), ...(dossierRow.copy_hash.match(/\d+/g) ?? [])],
      });
      const ok = sent.status === 'sent';
      if (ok) await markSent(r.mandant_id);
      remises.push({ position: r.position, sent: ok });
    }
    return { ok: true, value: { documentId, contentHash, dossierHash: dossierRow.dossier_hash, copyHash: dossierRow.copy_hash, number, remises } };
  }

  /** L'exemplaire remis et son dossier de preuve, pour l'agent ou la direction qui voit chaque mandant en entier [R16]. */
  async dossier(viewer: Viewer, documentId: string): Promise<{ ok: true; value: { copy: string; dossier: string; dossierHash: string; copyHash: string } } | Refusal | { ok: false; rule: null; code: 'unknown_document' | 'not_finished' }> {
    const doc = await this.db.first<{ network_id: string; person_id: string }>('SELECT network_id, person_id FROM documents WHERE id = ?', [documentId]);
    if (!doc || doc.network_id !== viewer.networkId) return { ok: false, rule: null, code: 'unknown_document' };
    for (const personId of await documentPersons(this.db, documentId, doc.person_id)) {
      if (!(await this.seesInFull(viewer, personId, `document:${documentId}`))) return { ok: false, rule: 'R16', code: 'not_assigned' };
    }
    const row = await this.db.first<{ copy_content: string; dossier: string; dossier_hash: string; copy_hash: string }>('SELECT copy_content, dossier, dossier_hash, copy_hash FROM signature_dossiers WHERE document_id = ?', [documentId]);
    if (!row) return { ok: false, rule: null, code: 'not_finished' };
    return { ok: true, value: { copy: row.copy_content, dossier: row.dossier, dossierHash: row.dossier_hash, copyHash: row.copy_hash } };
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
