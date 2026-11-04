/**
 * Accès aux chiffres d'un commerce (M16, CE04) : engagement de confidentialité signé et pièce d'identité vérifiée avant
 * tout chiffre [R113].
 *
 * Une demande d'accès d'un repreneur, rangée par l'agent du bien (ou la direction), reçoit tout de suite la vue publique
 * et la présentation publiable, rien d'autre [R110]. L'engagement de confidentialité est fait du dernier modèle rangé par
 * la direction (versionné, jamais réécrit), au nom de la personne et pour ce bien ; il se signe en ligne avec un code à
 * usage unique de D08, envoyé par le contrôle central (en essai : boîte d'essai, jamais envoyé [R26]) ; seule
 * l'empreinte du code est gardée, il expire, ne sert qu'une fois, et cinq essais faux bloquent la session. Tant que H24
 * n'est pas fait, la signature reste d'essai (`realSignature: false`), comme celle du mandat et du bail.
 *
 * Une seule porte, `canSendConfidential(réseau, bien, personne)`, utilisée par tout envoi de chiffres ou de documents
 * confidentiels : il faut un engagement de cette personne pour ce bien, non révoqué, signé sur l'empreinte du texte
 * rangé, ce texte toujours intact ; et l'identité de la personne vérifiée par l'agent, lue au coffre de la conformité
 * comme un simple état (`identityVerifiedOn`), jamais la pièce ni son numéro [R15]. Chaque refus va au journal avec ses
 * seuls codes [R13].
 */
import type { Acces } from '../acces/acces.ts';
import type { Viewer } from '../acces/droits.ts';
import { trialChannels } from '../captation/essai.ts';
import { FicheClient } from '../db/fiche-client.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { sha256 } from '../documents/modeles.ts';
import { CODE_TTL_MINUTES, MAX_CODE_ATTEMPTS, ONLINE_SIGNATURE_PURPOSE, newSignatureCode, sameSignatureHash } from '../documents/signature-en-ligne.ts';
import { ControleEnvois } from '../envoi/controle.ts';
import { SqlSendJournal } from '../envoi/journal-envois.ts';
import { DecisionEnvoi } from '../envoi/service.ts';
import { FicheUnique } from '../fiche/fusion.ts';
import { sellerNameWords } from '../fiche/noms-vendeur.ts';
import { ficheFirstName } from '../fiche/prenom.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import type { BusinessPublicView, BusinessSheetVersion, FicheCommerce } from './fiche.ts';
import type { BusinessPresentation, PresentationCommerce } from './presentation.ts';
import type { BusinessDiffusionGate } from './repreneurs.ts';

/** Une signature d'engagement n'est jamais réelle tant que H24 n'est pas fait. */
export const REAL_NDA_SIGNATURE = false;

/** L'état du coffre de la conformité, et rien d'autre : ni sorte, ni référence, ni numéro de pièce [R15]. */
export interface IdentityState {
  state(networkId: string, personId: string): Promise<{ identityVerifiedOn: string | null }>;
}

export const NDA_REVOCATION_REASONS = ['demande_repreneur', 'manquement', 'fin_de_vente', 'autre'] as const;
export type NdaRevocationReason = (typeof NDA_REVOCATION_REASONS)[number];

/** La finalité de l'accord de la personne à recevoir par mail les informations publiques d'un commerce [R03]. */
export const PUBLIC_INFO_PURPOSE = 'information_commerce';

export type ConfidentialRefusalCode =
  | 'engagement_absent'
  | 'engagement_revoque'
  | 'engagement_non_signe'
  | 'engagement_modifie'
  | 'identite_non_verifiee';

export type ConfidentialGate =
  | { ok: true; ndaId: string; signedAt: string; identityVerifiedOn: string; mode: 'essai' }
  | { ok: false; rule: 'R113'; codes: ConfidentialRefusalCode[] };

export interface NdaSignatureProof {
  ndaId: string;
  contentSha256: string;
  signedAt: string;
  method: 'code' | 'code_et_trace';
  drawingHash: string | null;
  mode: 'essai';
  realSignature: false;
}

export interface NdaTemplate {
  id: string;
  version: number;
  bodySha256: string;
  createdAt: string;
}

export interface AccessRequestAnswer {
  requestId: string;
  /** La vue publique seule [R110]. */
  publicView: BusinessPublicView;
  /** La présentation publiable, s'il y en a une. */
  presentation: { title: string; body: string } | null;
  /** L'engagement à signer ; `null` si la direction n'a encore rangé aucun modèle. */
  ndaId: string | null;
}

type Refusal = { ok: false; rule: 'R16'; code: string };
type Problem = {
  ok: false;
  rule: 'R113' | 'R110' | string | null;
  code:
    | 'sorte'
    | 'bad_body'
    | 'bad_reason'
    | 'bad_consent'
    | 'unknown_nda'
    | 'unknown_session'
    | 'revoked'
    | 'already_signed'
    | 'already_revoked'
    | 'blocked'
    | 'expired'
    | 'wrong_code'
    | 'bad_drawing'
    | 'nda_changed'
    | 'send_refused'
    | 'unknown_person'
    | 'pas_de_demande'
    | 'presentation_absente'
    | 'non_diffusable'
    | 'consent_withdrawn';
};
export type ConfidentialResult<T> = { ok: true; value: T } | Refusal | Problem | { ok: false; rule: 'R113'; code: 'door_closed'; codes: ConfidentialRefusalCode[] };

interface NdaRow {
  id: string;
  network_id: string;
  property_id: string;
  person_id: string;
  template_id: string;
  content: string;
  content_sha256: string;
}

interface SessionRow {
  id: string;
  network_id: string;
  nda_id: string;
  person_id: string;
  content_sha256: string;
  code_hash: string;
  expires_at: string;
  attempts: number;
  status: 'ouverte' | 'signee' | 'bloquee';
  signed_at: string | null;
}

const MAX_DRAWING = 200_000;

export interface ConfidentialiteCommerceOptions {
  now?: () => Date;
  newId?: () => string;
  newCode?: () => string;
}

export class ConfidentialiteCommerce {
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly newCode: () => string;
  private readonly store: FicheClient;
  private readonly envois: ControleEnvois;
  private readonly fiche: FicheUnique;

  constructor(
    private readonly db: SqlDatabase,
    private readonly journal: JournalStore,
    private readonly fiches: FicheCommerce,
    private readonly presentations: PresentationCommerce,
    private readonly identity: IdentityState,
    options: ConfidentialiteCommerceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => crypto.randomUUID());
    this.newCode = options.newCode ?? newSignatureCode;
    this.store = new FicheClient(db, { now: this.now });
    const fiche = new FicheUnique(db, this.store, { now: this.now });
    this.fiche = fiche;
    // Le code passe par le contrôle central, avec les seuls canaux du mode essai : rangé dans la boîte d'essai, jamais
    // envoyé [R26] ; le vrai envoi attend H05.
    this.envois = new ControleEnvois(db, fiche, new DecisionEnvoi(db, this.store, fiche, { now: this.now }), {
      channels: trialChannels(db, journal, this.now),
      journal: new SqlSendJournal(db, undefined, this.now),
      now: this.now,
    });
  }

  /** La direction range une nouvelle version du modèle d'engagement ; l'ancienne reste [R17]. */
  async recordTemplate(viewer: Viewer, body: unknown): Promise<ConfidentialResult<NdaTemplate>> {
    if (viewer.role !== 'direction') return this.refuse(viewer, `network:${viewer.networkId}`, 'role');
    if (typeof body !== 'string' || body.trim().length < 50 || body.trim().length > 20_000) return { ok: false, rule: null, code: 'bad_body' };
    const text = body.trim();
    const bodySha256 = await sha256(text);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const last = await this.db.first<{ v: number | null }>('SELECT MAX(version) AS v FROM business_nda_templates WHERE network_id = ?', [viewer.networkId]);
      const version = Number(last?.v ?? 0) + 1;
      const id = this.newId();
      const createdAt = this.now().toISOString();
      const { changes } = await this.db.run(
        `INSERT INTO business_nda_templates (id, network_id, version, body, body_sha256, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT DO NOTHING`,
        [id, viewer.networkId, version, text, bodySha256, this.actor(viewer), createdAt],
      );
      if (changes !== 1) continue;
      await appendEvent(this.journal, { type: 'commerces.engagement.modele', actor: this.actor(viewer), subject: `network:${viewer.networkId}`, data: { version } }, this.now);
      return { ok: true, value: { id, version, bodySha256, createdAt } };
    }
    throw new Error('modèle d’engagement : trop d’écritures simultanées');
  }

  /** Le modèle en vigueur, pour que la direction ne range jamais à l'aveugle ; `null` si aucun n'est rangé. */
  async currentTemplate(viewer: Viewer): Promise<ConfidentialResult<(NdaTemplate & { body: string }) | null>> {
    if (viewer.role !== 'direction') return this.refuse(viewer, `network:${viewer.networkId}`, 'role');
    const row = await this.db.first<{ id: string; version: number; body: string; body_sha256: string; created_at: string }>(
      'SELECT id, version, body, body_sha256, created_at FROM business_nda_templates WHERE network_id = ? ORDER BY version DESC LIMIT 1',
      [viewer.networkId],
    );
    return { ok: true, value: row ? { id: row.id, version: row.version, body: row.body, bodySha256: row.body_sha256, createdAt: row.created_at } : null };
  }

  /** Le texte d'un engagement, à faire lire avant le code : ni chiffre, ni document, seulement le modèle, le bien et le signataire [R110]. */
  async text(acces: Acces, viewer: Viewer, ndaId: string): Promise<ConfidentialResult<{ ndaId: string; content: string; contentSha256: string; signed: boolean; revoked: boolean }>> {
    const nda = await this.ndaFor(acces, viewer, ndaId);
    if (!('content' in nda)) return nda;
    const signed = !!(await this.db.first("SELECT 1 FROM business_nda_signatures WHERE nda_id = ? AND status = 'signee'", [nda.id]));
    return { ok: true, value: { ndaId: nda.id, content: nda.content, contentSha256: nda.content_sha256, signed, revoked: await this.revoked(nda.id) } };
  }

  /**
   * L'agent du bien (ou la direction) range la demande d'accès d'un repreneur qu'il suit. La réponse ne porte que la
   * vue publique et la présentation publiable [R110] ; l'engagement est fait du dernier modèle s'il n'en existe pas
   * déjà un, non révoqué, pour cette personne et ce bien.
   */
  async requestAccess(acces: Acces, viewer: Viewer, propertyId: string, personId: string): Promise<ConfidentialResult<AccessRequestAnswer>> {
    const g = await this.gate(acces, viewer, propertyId, personId);
    if (!g.ok) return g;
    const publicView = await this.fiches.publicView(propertyId);
    if (!publicView) return { ok: false, rule: null, code: 'sorte' };
    let nda = await this.db.first<{ id: string }>(
      `SELECT n.id FROM business_ndas n WHERE n.network_id = ? AND n.property_id = ? AND n.person_id = ?
         AND NOT EXISTS (SELECT 1 FROM business_nda_revocations r WHERE r.nda_id = n.id)
       ORDER BY n.created_at DESC, n.rowid DESC LIMIT 1`,
      [viewer.networkId, propertyId, personId],
    );
    if (!nda) nda = await this.makeNda(viewer, propertyId, personId);
    const requestId = this.newId();
    await this.db.run(
      'INSERT INTO business_access_requests (id, network_id, property_id, person_id, nda_id, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [requestId, viewer.networkId, propertyId, personId, nda?.id ?? null, this.actor(viewer), this.now().toISOString()],
    );
    await appendEvent(
      this.journal,
      { type: 'commerces.acces.demande', actor: this.actor(viewer), subject: `property:${propertyId}`, data: { request: requestId, engagement: nda ? 'pret' : 'modele_absent' } },
      this.now,
    );
    const shown: BusinessPresentation | null = await this.presentations.publishable(viewer.networkId, propertyId);
    return {
      ok: true,
      value: { requestId, publicView, presentation: shown ? { title: shown.title, body: shown.body } : null, ndaId: nda?.id ?? null },
    };
  }

  /**
   * La réponse immédiate au repreneur (CE16) : la présentation validée et publiable, rien d'autre [R110], à qui a une
   * demande rangée pour ce bien, et si le bien peut être diffusé [R42]. Elle part par le contrôle central, en essai dans
   * la boîte d'essai [R26], avec les seuls chiffres de la présentation [R10], une seule fois par bien [R05]. Lecture
   * prudente, comme la sécurité des visites, tant que H42 n'est pas tranché : un accord retiré ne se redonne pas par la
   * seule parole de l'agent [R03].
   */
  async sendPublicInfo(
    acces: Acces,
    viewer: Viewer,
    propertyId: string,
    personId: string,
    input: { consentProof?: unknown },
    diffusion: BusinessDiffusionGate,
  ): Promise<ConfidentialResult<{ mode: 'essai' }>> {
    const g = await this.gate(acces, viewer, propertyId, personId);
    if (!g.ok) return g;
    if (typeof input.consentProof !== 'string' || input.consentProof.trim() === '' || input.consentProof.length > 300) return { ok: false, rule: null, code: 'bad_consent' };
    const members = await this.fiche.membersOf(personId);
    const marks = members.map(() => '?').join(', ');
    if (!(await this.db.first(`SELECT 1 FROM business_access_requests WHERE network_id = ? AND property_id = ? AND person_id IN (${marks}) LIMIT 1`, [viewer.networkId, propertyId, ...members]))) {
      return { ok: false, rule: null, code: 'pas_de_demande' };
    }
    // Un envoi refusé laisse sa trace au journal, ses seuls codes [R13].
    const refused = async <C extends 'non_diffusable' | 'presentation_absente' | 'consent_withdrawn' | 'send_refused'>(rule: string | null, code: C) => {
      await appendEvent(this.journal, { type: 'commerces.acces.informations_refusees', actor: this.actor(viewer), subject: `property:${propertyId}`, data: { rule, code } }, this.now);
      return { ok: false as const, rule, code };
    };
    if (!(await diffusion.canDiffuse(viewer.networkId, propertyId, this.now())).allowed) return refused('R42', 'non_diffusable');
    const shown = await this.presentations.publishable(viewer.networkId, propertyId);
    if (!shown) return refused('R110', 'presentation_absente');
    const consent = await this.fiche.hasConsentInForce(personId, PUBLIC_INFO_PURPOSE, 'email');
    if (!consent) {
      const withdrawn = await this.db.first(`SELECT 1 FROM consents WHERE person_id IN (${marks}) AND purpose = ? AND channel = 'email' AND withdrawn_at IS NOT NULL LIMIT 1`, [...members, PUBLIC_INFO_PURPOSE]);
      if (withdrawn) return refused('R03', 'consent_withdrawn');
      await this.store.addConsent({ networkId: viewer.networkId, personId, purpose: PUBLIC_INFO_PURPOSE, channel: 'email', proof: input.consentProof.trim(), givenAt: this.now() });
    }
    const agent = await this.db.first<{ agent_id: string | null }>('SELECT agent_id FROM properties WHERE id = ?', [propertyId]);
    const first = await ficheFirstName(this.db, members);
    // La présentation écrit « à Dijon (21000) » ; un message à une personne n'a pas de parenthèses [R08], les mots et les chiffres restent.
    const flat = (text: string): string => text.replace(/\s*\(([^()]*)\)/g, ', $1');
    // Jamais le nom du vendeur à un repreneur [R19] : l'agent peut avoir corrigé la présentation à la main. Le destinataire n'en est pas un.
    const sellers = await sellerNameWords(this.db, this.fiche, propertyId, members);
    const sent = await this.envois.send({
      networkId: viewer.networkId,
      agentId: agent?.agent_id ?? null,
      personId,
      channel: 'email',
      kind: 'alert',
      purpose: PUBLIC_INFO_PURPOSE,
      propertyIds: [propertyId],
      fallbackTexts: [
        `${first ? `Bonjour ${first},\n\n` : 'Bonjour,\n\n'}Votre agent immobilier vous transmet les informations publiques de ce commerce.\n\n${flat(shown.title)}\n\n${flat(shown.body)}\n\nLe détail s’ouvre après la signature d’un engagement de confidentialité et la vérification de votre pièce d’identité.`,
      ],
      figures: [shown.title, shown.body],
      sellerNames: sellers,
    });
    if (sent.status !== 'sent') return refused(sent.rule, 'send_refused');
    await appendEvent(this.journal, { type: 'commerces.acces.informations', actor: this.actor(viewer), subject: `property:${propertyId}`, data: { mode: 'essai' } }, this.now);
    return { ok: true, value: { mode: 'essai' } };
  }

  /** Ouvre la signature de l'engagement : le code est envoyé à la personne par le contrôle central [R26, R03]. */
  async startSignature(
    acces: Acces,
    viewer: Viewer,
    ndaId: string,
    input: { consentProof?: unknown },
  ): Promise<ConfidentialResult<{ sessionId: string; contentSha256: string; expiresAt: string; mode: 'essai' }>> {
    const nda = await this.ndaFor(acces, viewer, ndaId);
    if (!('content' in nda)) return nda;
    if (await this.revoked(nda.id)) return { ok: false, rule: 'R113', code: 'revoked' };
    if (await this.db.first("SELECT 1 FROM business_nda_signatures WHERE nda_id = ? AND status = 'signee'", [nda.id])) return { ok: false, rule: null, code: 'already_signed' };
    if (typeof input.consentProof !== 'string' || input.consentProof.trim() === '' || input.consentProof.length > 300) return { ok: false, rule: null, code: 'bad_consent' };
    const consent = await this.fiche.hasConsentInForce(nda.person_id, ONLINE_SIGNATURE_PURPOSE, 'email');
    if (!consent) await this.store.addConsent({ networkId: nda.network_id, personId: nda.person_id, purpose: ONLINE_SIGNATURE_PURPOSE, channel: 'email', proof: input.consentProof.trim(), givenAt: this.now() });
    const id = this.newId();
    const code = this.newCode();
    const expiresAt = new Date(this.now().getTime() + CODE_TTL_MINUTES * 60_000).toISOString();
    await this.db.run(
      `INSERT INTO business_nda_signatures (id, network_id, nda_id, person_id, content_sha256, code_hash, expires_at, attempts, status, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'ouverte', ?, ?)`,
      [id, nda.network_id, nda.id, nda.person_id, nda.content_sha256, await sha256(`${id}:${code}`), expiresAt, this.actor(viewer), this.now().toISOString()],
    );
    const agent = await this.db.first<{ agent_id: string | null }>('SELECT agent_id FROM properties WHERE id = ?', [nda.property_id]);
    const first = await ficheFirstName(this.db, await this.fiche.membersOf(nda.person_id));
    const sent = await this.envois.send({
      networkId: nda.network_id,
      agentId: agent?.agent_id ?? null,
      personId: nda.person_id,
      channel: 'email',
      kind: 'alert',
      purpose: ONLINE_SIGNATURE_PURPOSE,
      subject: `signature_engagement:${id}`,
      fallbackTexts: [
        `${first ? `Bonjour ${first},\n\n` : 'Bonjour,\n\n'}Votre code de signature de l’engagement de confidentialité : ${code}. Il est valable ${CODE_TTL_MINUTES} minutes. Ne le donnez à personne, pas même à votre agent.`,
      ],
      figures: [code, CODE_TTL_MINUTES],
    });
    // Refusé (heure, exclusion, arrêt, pas de mail…) : la session reste sans code utilisable et expire.
    if (sent.status !== 'sent') return { ok: false, rule: sent.rule, code: 'send_refused' };
    await appendEvent(this.journal, { type: 'commerces.engagement.signature_ouverte', actor: this.actor(viewer), subject: `property:${nda.property_id}`, data: { session: id, mode: 'essai' } }, this.now);
    return { ok: true, value: { sessionId: id, contentSha256: nda.content_sha256, expiresAt, mode: 'essai' } };
  }

  /** La signature : le code reçu, et le tracé à l'écran s'il y en a un. Toujours une signature d'essai. */
  async sign(acces: Acces, viewer: Viewer, sessionId: string, input: { code?: unknown; drawing?: unknown }): Promise<ConfidentialResult<NdaSignatureProof>> {
    const session = await this.db.first<SessionRow>('SELECT * FROM business_nda_signatures WHERE id = ?', [sessionId]);
    if (!session || session.network_id !== viewer.networkId) {
      await appendEvent(this.journal, { type: 'acces.refuse', actor: this.actor(viewer), subject: `network:${viewer.networkId}`, data: { rule: 'R16', role: String(viewer.role), kind: 'business_nda', code: 'unknown' } }, this.now);
      return { ok: false, rule: null, code: 'unknown_session' };
    }
    const nda = await this.ndaFor(acces, viewer, session.nda_id);
    if (!('content' in nda)) return nda;
    if (session.status === 'signee') return { ok: false, rule: null, code: 'already_signed' };
    if (session.status === 'bloquee') return { ok: false, rule: null, code: 'blocked' };
    if (this.now().getTime() > Date.parse(session.expires_at)) return { ok: false, rule: null, code: 'expired' };
    const drawing = input.drawing;
    if (drawing !== undefined && drawing !== null && (typeof drawing !== 'string' || drawing.length === 0 || drawing.length > MAX_DRAWING)) return { ok: false, rule: null, code: 'bad_drawing' };
    const given = typeof input.code === 'string' && /^\d{6}$/.test(input.code) ? await sha256(`${session.id}:${input.code}`) : '';
    if (!given || !sameSignatureHash(given, session.code_hash)) {
      // L'essai est compté dans la base, en un seul ordre : des essais simultanés comptent chacun.
      const after = await this.db.first<{ attempts: number; status: string }>(
        `UPDATE business_nda_signatures SET attempts = attempts + 1, status = CASE WHEN attempts + 1 >= ? THEN 'bloquee' ELSE status END
         WHERE id = ? AND status = 'ouverte' RETURNING attempts, status`,
        [MAX_CODE_ATTEMPTS, session.id],
      );
      const blocked = !after || after.status === 'bloquee';
      await appendEvent(this.journal, { type: 'commerces.engagement.code_faux', actor: this.actor(viewer), subject: `property:${nda.property_id}`, data: { attempts: Number(after?.attempts ?? MAX_CODE_ATTEMPTS), blocked } }, this.now);
      return { ok: false, rule: null, code: blocked ? 'blocked' : 'wrong_code' };
    }
    if (await this.revoked(nda.id)) return { ok: false, rule: 'R113', code: 'revoked' };
    // L'engagement est encore celui de l'ouverture : même texte, même empreinte.
    if ((await sha256(nda.content)) !== session.content_sha256 || nda.content_sha256 !== session.content_sha256) return { ok: false, rule: 'R113', code: 'nda_changed' };
    const signedAt = this.now().toISOString();
    const drawingHash = typeof drawing === 'string' ? await sha256(drawing) : null;
    const proof: NdaSignatureProof = { ndaId: nda.id, contentSha256: session.content_sha256, signedAt, method: drawingHash ? 'code_et_trace' : 'code', drawingHash, mode: 'essai', realSignature: false };
    let changes = 0;
    try {
      ({ changes } = await this.db.run(`UPDATE business_nda_signatures SET status = 'signee', signed_at = ?, drawing_hash = ?, proof = ? WHERE id = ? AND status = 'ouverte'`, [
        signedAt,
        drawingHash,
        JSON.stringify(proof),
        session.id,
      ]));
    } catch (error) {
      if (/UNIQUE/i.test(String(error))) return { ok: false, rule: null, code: 'already_signed' };
      throw error;
    }
    if (changes !== 1) return { ok: false, rule: null, code: 'already_signed' };
    await appendEvent(this.journal, { type: 'commerces.engagement.signe', actor: this.actor(viewer), subject: `property:${nda.property_id}`, data: { rule: 'R113', session: session.id, method: proof.method, realSignature: false } }, this.now);
    return { ok: true, value: proof };
  }

  /** L'agent du bien ou la direction révoque un engagement : plus rien de confidentiel ne part par lui. */
  async revoke(acces: Acces, viewer: Viewer, ndaId: string, reason: unknown): Promise<ConfidentialResult<{ revokedAt: string }>> {
    const nda = await this.ndaFor(acces, viewer, ndaId);
    if (!('content' in nda)) return nda;
    if (typeof reason !== 'string' || !(NDA_REVOCATION_REASONS as readonly string[]).includes(reason)) return { ok: false, rule: null, code: 'bad_reason' };
    const revokedAt = this.now().toISOString();
    const { changes } = await this.db.run(
      'INSERT INTO business_nda_revocations (nda_id, network_id, reason, revoked_by, revoked_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING',
      [nda.id, nda.network_id, reason, this.actor(viewer), revokedAt],
    );
    if (changes !== 1) return { ok: false, rule: null, code: 'already_revoked' };
    await appendEvent(this.journal, { type: 'commerces.engagement.revoque', actor: this.actor(viewer), subject: `property:${nda.property_id}`, data: { reason } }, this.now);
    return { ok: true, value: { revokedAt } };
  }

  /**
   * La seule porte de tout envoi confidentiel d'un commerce [R113] : un engagement de cette personne pour ce bien,
   * non révoqué, signé sur l'empreinte du texte rangé, ce texte intact ; et l'identité vérifiée, lue au coffre comme un
   * état [R15]. Un refus va au journal avec ses seuls codes [R13].
   */
  async canSendConfidential(networkId: string, propertyId: string, personId: string, actor = 'systeme', quiet = false): Promise<ConfidentialGate> {
    const ndas = await this.db.all<NdaRow & { revoked: number; signed_sha: string | null; signed_at: string | null }>(
      `SELECT n.*, EXISTS (SELECT 1 FROM business_nda_revocations r WHERE r.nda_id = n.id) AS revoked, s.content_sha256 AS signed_sha, s.signed_at
       FROM business_ndas n LEFT JOIN business_nda_signatures s ON s.nda_id = n.id AND s.status = 'signee'
       WHERE n.network_id = ? AND n.property_id = ? AND n.person_id = ?
       ORDER BY n.created_at DESC, n.rowid DESC`,
      [networkId, propertyId, personId],
    );
    const codes = new Set<ConfidentialRefusalCode>();
    let passed: { id: string; signedAt: string } | null = null;
    if (ndas.length === 0) codes.add('engagement_absent');
    for (const n of ndas) {
      if (Number(n.revoked) === 1) {
        codes.add('engagement_revoque');
        continue;
      }
      if (!n.signed_sha || !n.signed_at) {
        codes.add('engagement_non_signe');
        continue;
      }
      if (n.signed_sha !== n.content_sha256 || (await sha256(n.content)) !== n.content_sha256) {
        codes.add('engagement_modifie');
        continue;
      }
      passed = { id: n.id, signedAt: n.signed_at };
      break;
    }
    const { identityVerifiedOn } = await this.identity.state(networkId, personId);
    if (!identityVerifiedOn) codes.add('identite_non_verifiee');
    if (passed && identityVerifiedOn) return { ok: true, ndaId: passed.id, signedAt: passed.signedAt, identityVerifiedOn, mode: 'essai' };
    if (passed) for (const c of ['engagement_absent', 'engagement_revoque', 'engagement_non_signe', 'engagement_modifie'] as const) codes.delete(c);
    const list = [...codes].sort();
    // Une lecture de l'état pour l'écran n'est pas une tentative d'envoi : rien au journal.
    if (!quiet) await appendEvent(this.journal, { type: 'commerces.confidentiel.refuse', actor, subject: `property:${propertyId}`, data: { rule: 'R113', codes: list } }, this.now);
    return { ok: false, rule: 'R113', codes: list };
  }

  /**
   * La fiche complète d'un commerce, pour l'envoyer à un repreneur : seulement par la porte [R113]. L'agent du bien ou
   * la direction la demande ; CE05 la sert dans le dossier protégé.
   */
  async confidentialSheet(acces: Acces, viewer: Viewer, propertyId: string, personId: string): Promise<ConfidentialResult<BusinessSheetVersion>> {
    const g = await this.gate(acces, viewer, propertyId, personId);
    if (!g.ok) return g;
    const door = await this.canSendConfidential(viewer.networkId, propertyId, personId, this.actor(viewer));
    if (!door.ok) return { ok: false, rule: 'R113', code: 'door_closed', codes: door.codes };
    const sheet = await this.fiches.current(propertyId);
    if (!sheet) return { ok: false, rule: null, code: 'sorte' };
    return { ok: true, value: sheet };
  }

  /**
   * Les demandes d'accès d'un commerce, une ligne par repreneur, avec l'état de la porte, pour l'écran de l'agent du
   * bien ou de la direction : jamais un chiffre de la fiche [R110, R16]. Le prénom seul, pour que l'agent s'y retrouve.
   */
  async requests(
    acces: Acces,
    viewer: Viewer,
    propertyId: string,
  ): Promise<ConfidentialResult<{ personId: string; firstName: string | null; requestedAt: string; open: boolean; codes: ConfidentialRefusalCode[]; ndaId: string | null; signed: boolean }[]>> {
    const read = await acces.readProperty(viewer, propertyId);
    if (!read.ok) return { ok: false, rule: 'R16', code: read.code };
    if (read.view !== 'full') return this.refuse(viewer, `property:${propertyId}`, 'not_assigned');
    if (!((viewer.role === 'agent' && read.value.agent_id === viewer.userId) || viewer.role === 'direction')) return this.refuse(viewer, `property:${propertyId}`, 'role');
    if (!(await this.fiches.publicView(propertyId))) return { ok: false, rule: null, code: 'sorte' };
    const rows = await this.db.all<{ person_id: string; first_name: string | null; at: string }>(
      `SELECT r.person_id, p.first_name, MAX(r.created_at) AS at FROM business_access_requests r JOIN persons p ON p.id = r.person_id
       WHERE r.network_id = ? AND r.property_id = ? GROUP BY r.person_id, p.first_name ORDER BY at`,
      [viewer.networkId, propertyId],
    );
    const out = [];
    for (const r of rows) {
      const gate = await this.canSendConfidential(viewer.networkId, propertyId, r.person_id, this.actor(viewer), true);
      // L'engagement en vigueur de cette personne, pour les gestes de l'écran ; aucun si le dernier est révoqué.
      const nda = await this.db.first<{ id: string; signed: number }>(
        `SELECT n.id, EXISTS (SELECT 1 FROM business_nda_signatures s WHERE s.nda_id = n.id AND s.status = 'signee') AS signed FROM business_ndas n
         WHERE n.network_id = ? AND n.property_id = ? AND n.person_id = ? AND NOT EXISTS (SELECT 1 FROM business_nda_revocations x WHERE x.nda_id = n.id)
         ORDER BY n.created_at DESC, n.rowid DESC LIMIT 1`,
        [viewer.networkId, propertyId, r.person_id],
      );
      out.push({ personId: r.person_id, firstName: r.first_name, requestedAt: r.at, open: gate.ok, codes: gate.ok ? [] : gate.codes, ndaId: nda?.id ?? null, signed: Number(nda?.signed ?? 0) === 1 });
    }
    return { ok: true, value: out };
  }

  private actor(viewer: Viewer): string {
    return `${String(viewer.role)}:${viewer.userId}`;
  }

  private async revoked(ndaId: string): Promise<boolean> {
    return !!(await this.db.first('SELECT 1 FROM business_nda_revocations WHERE nda_id = ?', [ndaId]));
  }

  /** Fait l'engagement depuis le dernier modèle : son texte, le bien et le nom du signataire. */
  private async makeNda(viewer: Viewer, propertyId: string, personId: string): Promise<{ id: string } | null> {
    const template = await this.db.first<{ id: string; version: number; body: string }>(
      'SELECT id, version, body FROM business_nda_templates WHERE network_id = ? ORDER BY version DESC LIMIT 1',
      [viewer.networkId],
    );
    if (!template) return null;
    const property = await this.db.first<{ reference: string }>('SELECT reference FROM properties WHERE id = ?', [propertyId]);
    const person = await this.db.first<{ first_name: string | null; last_name: string | null }>('SELECT first_name, last_name FROM persons WHERE id = ?', [personId]);
    const name = [person?.first_name, person?.last_name].filter((x): x is string => !!x && x.trim() !== '').join(' ') || 'à compléter';
    const content = `${template.body}\n\nBien : ${property?.reference ?? propertyId}\nSignataire : ${name}\nModèle : version ${template.version}`;
    const id = this.newId();
    await this.db.run(
      'INSERT INTO business_ndas (id, network_id, property_id, person_id, template_id, content, content_sha256, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [id, viewer.networkId, propertyId, personId, template.id, content, await sha256(content), this.actor(viewer), this.now().toISOString()],
    );
    await appendEvent(this.journal, { type: 'commerces.engagement.fait', actor: this.actor(viewer), subject: `property:${propertyId}`, data: { template: template.version } }, this.now);
    return { id };
  }

  /** L'engagement, si le lecteur est l'agent du bien ou la direction et voit la personne en entier [R16]. */
  private async ndaFor(acces: Acces, viewer: Viewer, ndaId: string): Promise<NdaRow | Refusal | Problem> {
    const nda = await this.db.first<NdaRow>('SELECT * FROM business_ndas WHERE id = ?', [ndaId]);
    if (!nda || nda.network_id !== viewer.networkId) {
      await appendEvent(this.journal, { type: 'acces.refuse', actor: this.actor(viewer), subject: `network:${viewer.networkId}`, data: { rule: 'R16', role: String(viewer.role), kind: 'business_nda', code: 'unknown' } }, this.now);
      return { ok: false, rule: null, code: 'unknown_nda' };
    }
    const g = await this.gate(acces, viewer, nda.property_id, nda.person_id);
    if (!g.ok) return g;
    return nda;
  }

  /** L'agent du bien ou la direction, qui voit le bien et la personne en entier ; un bien qui est un commerce [R16]. */
  private async gate(acces: Acces, viewer: Viewer, propertyId: string, personId: string): Promise<{ ok: true } | Refusal | Problem> {
    const read = await acces.readProperty(viewer, propertyId);
    if (!read.ok) return { ok: false, rule: 'R16', code: read.code };
    if (read.view !== 'full') return this.refuse(viewer, `property:${propertyId}`, 'not_assigned');
    if (!((viewer.role === 'agent' && read.value.agent_id === viewer.userId) || viewer.role === 'direction')) return this.refuse(viewer, `property:${propertyId}`, 'role');
    if (!(await this.fiches.publicView(propertyId))) return { ok: false, rule: null, code: 'sorte' };
    const person = await acces.readFiche(viewer, personId);
    if (!person.ok) return person.code === 'unknown' ? { ok: false, rule: null, code: 'unknown_person' } : { ok: false, rule: 'R16', code: person.code };
    if (person.view !== 'full') return this.refuse(viewer, `property:${propertyId}`, 'person_not_assigned');
    return { ok: true };
  }

  private async refuse(viewer: Viewer, subject: string, code: string): Promise<Refusal> {
    await appendEvent(this.journal, { type: 'acces.refuse', actor: this.actor(viewer), subject, data: { rule: 'R16', role: String(viewer.role), kind: 'business_nda', code } }, this.now);
    return { ok: false, rule: 'R16', code };
  }
}
