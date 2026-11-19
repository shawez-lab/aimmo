/**
 * Signature en ligne du bail par la signature de D08, en mode essai (M15, W12) [R108, R101, R105, R16].
 *
 * Seul le bail en vigueur (W06 : dernière version, même candidat choisi, mêmes faits et même barème, logement encore
 * louable, annexes à jour) et complet se signe [R101, R105]. Chaque partie, le bailleur et le locataire choisi, signe
 * l'empreinte du bail qu'elle a reçue à l'ouverture : un code à usage unique de D08 lui est envoyé par le contrôle
 * central (en essai : boîte d'essai) ; seule l'empreinte du code est gardée ; il expire, ne sert qu'une fois, et cinq
 * essais faux bloquent la session. Un bail remplacé, même après une signature, demande de nouvelles signatures : une
 * signature vaut pour un bail et une empreinte, jamais pour le suivant.
 *
 * Quand les deux parties ont signé, un seul exemplaire est fait (le bail suivi des deux preuves) et chaque partie en
 * reçoit l'avis par le contrôle central : la même référence et la même empreinte, pour vérifier l'exemplaire que l'agent
 * lui remet (`copy`). Décidé, lecture prudente : le canal n'a pas de pièce jointe et aucune page client ne sert le bail ;
 * l'envoi du document lui-même attend le vrai canal mail (H05) et le branchement (W10). La remise enregistrée est celle
 * de l'avis, jamais celle du document.
 *
 * Tant que H08 (modèles validés) et H24 (dossier de preuve validé par l'avocat) ne sont pas faits, une signature reste
 * d'essai : `signedAt`, lu par la remise des clés (W08), ne rend jamais un bail signé réel. Le parcours d'essai lit la
 * signature d'essai par `trialState()`, nommée comme telle.
 *
 * Décidé, lecture prudente : `REAL_LEASE_SIGNATURE` reste faux dans le code ; il ne passera à vrai que par une tâche du
 * plan, après H08 et H24 ; même alors, seul un bail fait d'un modèle validé (mode « réel ») pourra être signé en vrai.
 */
import type { Viewer } from '../acces/droits.ts';
import { trialChannels } from '../captation/essai.ts';
import { FicheClient } from '../db/fiche-client.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { sha256 } from '../documents/modeles.ts';
import { MAX_CODE_ATTEMPTS, CODE_TTL_MINUTES, ONLINE_SIGNATURE_PURPOSE, newSignatureCode, sameSignatureHash } from '../documents/signature-en-ligne.ts';
import { ControleEnvois } from '../envoi/controle.ts';
import { SqlSendJournal } from '../envoi/journal-envois.ts';
import { DecisionEnvoi } from '../envoi/service.ts';
import { FicheUnique } from '../fiche/fusion.ts';
import { ficheFirstName } from '../fiche/prenom.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import { leaseCotenants, type BauxLocation, type PersonReader } from './bail.ts';
import type { ChoixProprietaire } from './choix.ts';
import type { LocationRefusal, MisesEnLocation } from './logement.ts';
import type { LeaseSignatureState } from './remise-cles.ts';

/** Une signature en ligne du bail n'est jamais réelle tant que H08 et H24 ne sont pas faits. */
export const REAL_LEASE_SIGNATURE = false;

export const LEASE_PARTIES = ['bailleur', 'locataire'] as const;
export type LeaseParty = (typeof LEASE_PARTIES)[number];
/** AU097 · un colocataire signe le même bail, en son nom, comme une partie de plus. */
export type SignerParty = LeaseParty | 'colocataire';
/** La table des sessions d'une partie : les colocataires ont la leur, une signature par personne et par bail. */
const TABLE = (party: SignerParty): string => (party === 'colocataire' ? 'rental_lease_cotenant_signatures' : 'rental_lease_signatures');

const MAX_DRAWING = 200_000;

export interface LeaseSignatureProof {
  leaseId: string;
  party: SignerParty;
  contentSha256: string;
  signedAt: string;
  method: 'code' | 'code_et_trace';
  drawingHash: string | null;
  mode: 'essai';
  realSignature: false;
}

export interface LeaseSignatureStatus {
  leaseId: string;
  contentSha256: string;
  bailleur: string | null;
  locataire: string | null;
  /** Chaque colocataire nommé au bail, et quand il a signé (AU097). */
  colocataires: { personId: string; signedAt: string | null }[];
  /** La date où le dernier signataire a signé, bailleur, locataire et chaque colocataire, ou rien. */
  signedAt: string | null;
  realSignature: false;
  copySha256: string | null;
  copiesSent: LeaseParty[];
  /** Les colocataires à qui l'avis de l'exemplaire est parti (AU097). */
  cotenantCopiesSent: string[];
}

export type LeaseSignatureRefusal = Omit<LocationRefusal, 'rule'> & { rule: LocationRefusal['rule'] | 'R101' | 'R105' | 'R108' | (string & {}) };
export type LeaseSignatureResult<T> = { ok: true; value: T } | LeaseSignatureRefusal;

interface SessionRow {
  id: string;
  network_id: string;
  listing_id: string;
  lease_id: string;
  party: SignerParty;
  person_id: string;
  content_sha256: string;
  code_hash: string;
  expires_at: string;
  attempts: number;
  status: 'ouverte' | 'signee' | 'bloquee';
}

export interface SignatureBailOptions {
  now?: () => Date;
  newId?: () => string;
  newCode?: () => string;
}

export class SignaturesBail implements LeaseSignatureState {
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly newCode: () => string;
  private readonly store: FicheClient;
  private readonly envois: ControleEnvois;
  private readonly fiche: FicheUnique;

  constructor(
    private readonly db: SqlDatabase,
    private readonly listings: MisesEnLocation,
    private readonly leases: BauxLocation,
    private readonly choices: ChoixProprietaire,
    private readonly persons: PersonReader,
    private readonly journal: JournalStore,
    options: SignatureBailOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => crypto.randomUUID());
    this.newCode = options.newCode ?? newSignatureCode;
    this.store = new FicheClient(db, { now: this.now });
    const fiche = new FicheUnique(db, this.store, { now: this.now });
    this.fiche = fiche;
    // Le code et l'exemplaire passent par le contrôle central, avec les seuls canaux du mode essai : rangés dans la
    // boîte d'essai, jamais envoyés [R26] ; le vrai envoi par mail attend H05.
    this.envois = new ControleEnvois(db, fiche, new DecisionEnvoi(db, this.store, fiche, { now: this.now }), {
      channels: trialChannels(db, journal, this.now),
      journal: new SqlSendJournal(db, undefined, this.now),
      now: this.now,
    });
  }

  private actor(viewer: Viewer): string {
    return `${String(viewer.role)}:${viewer.userId}`;
  }

  private async refuse(viewer: Viewer, subject: string, code: string): Promise<LeaseSignatureRefusal> {
    await appendEvent(this.journal, { type: 'acces.refuse', actor: this.actor(viewer), subject, data: { rule: 'R16', role: String(viewer.role), kind: 'lease_signature', code } }, this.now);
    return { ok: false, rule: 'R16', code };
  }

  /** Le bail en vigueur et complet du logement, et la personne de la partie [R101, R105]. */
  private async target(networkId: string, listingId: string, ownerPersonId: string, party: SignerParty, cotenant?: unknown): Promise<{ leaseId: string; contentSha256: string; mode: 'essai' | 'reel'; personId: string } | LeaseSignatureRefusal> {
    const lease = await this.leases.current(networkId, listingId);
    if (!lease) return { ok: false, rule: 'R108', code: 'no_current_lease' };
    if (!lease.complete) return { ok: false, rule: 'R101', code: 'lease_incomplete' };
    const chosen = await this.choices.chosen(networkId, listingId);
    if (!chosen) return { ok: false, rule: 'R105', code: 'no_choice' };
    if (party === 'colocataire') {
      // Seul un colocataire nommé dans ce bail le signe (AU097).
      if (typeof cotenant !== 'string' || !(await leaseCotenants(this.db, lease.leaseId)).includes(cotenant)) return { ok: false, rule: null, code: 'not_cotenant' };
      return { ...lease, personId: cotenant };
    }
    return { ...lease, personId: party === 'bailleur' ? ownerPersonId : chosen.personId };
  }

  /** Celui qui présente la signature voit la fiche de la partie en entier [R16]. */
  private async seesParty(viewer: Viewer, personId: string): Promise<true | LeaseSignatureRefusal> {
    const read = await this.persons.readFiche(viewer, personId);
    if (!read.ok) return { ok: false, rule: 'R16', code: read.code };
    if (read.view !== 'full') return this.refuse(viewer, `person:${personId}`, 'not_assigned');
    return true;
  }

  /**
   * Ouvre la signature d'une partie sur le bail en vigueur : son code lui est envoyé par le contrôle central. La partie
   * accepte, au rendez-vous, de recevoir son code et son exemplaire par mail ; l'agent en garde la preuve [R03].
   */
  async start(viewer: Viewer, listingId: unknown, input: { party?: unknown; personId?: unknown; consentProof?: unknown }): Promise<LeaseSignatureResult<{ sessionId: string; leaseId: string; contentSha256: string; expiresAt: string; mode: 'essai' }>> {
    const listing = await this.listings.listing(viewer, listingId, true);
    if ('ok' in listing) return listing;
    if (viewer.role !== 'agent' && viewer.role !== 'direction') return this.refuse(viewer, `rental:${listing.id}`, 'role');
    const party = input.party;
    if (typeof party !== 'string' || !([...LEASE_PARTIES, 'colocataire'] as readonly string[]).includes(party)) return { ok: false, rule: null, code: 'bad_party' };
    if (typeof input.consentProof !== 'string' || input.consentProof.trim() === '' || input.consentProof.length > 300) return { ok: false, rule: null, code: 'bad_consent' };
    const target = await this.target(listing.networkId, listing.id, listing.ownerPersonId, party as SignerParty, input.personId);
    if ('ok' in target) return target;
    const sees = await this.seesParty(viewer, target.personId);
    if (sees !== true) return sees;
    const done = await this.db.first(`SELECT 1 FROM ${TABLE(party as SignerParty)} WHERE lease_id = ? AND party = ? AND person_id = ? AND status = ?`, [target.leaseId, party, target.personId, 'signee']);
    if (done) return { ok: false, rule: null, code: 'already_signed' };
    const consent = await this.fiche.hasConsentInForce(target.personId, ONLINE_SIGNATURE_PURPOSE, 'email');
    if (!consent) await this.store.addConsent({ networkId: listing.networkId, personId: target.personId, purpose: ONLINE_SIGNATURE_PURPOSE, channel: 'email', proof: input.consentProof.trim(), givenAt: this.now() });
    const id = this.newId();
    const code = this.newCode();
    const expiresAt = new Date(this.now().getTime() + CODE_TTL_MINUTES * 60_000).toISOString();
    await this.db.run(
      `INSERT INTO ${TABLE(party as SignerParty)} (id, network_id, listing_id, lease_id, party, person_id, content_sha256, code_hash, expires_at, attempts, status, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'ouverte', ?, ?)`,
      [id, listing.networkId, listing.id, target.leaseId, party, target.personId, target.contentSha256, await sha256(`${id}:${code}`), expiresAt, this.actor(viewer), this.now().toISOString()],
    );
    const agent = await this.db.first<{ agent_id: string | null }>('SELECT agent_id FROM properties WHERE id = ?', [listing.propertyId]);
    const sent = await this.envois.send({
      networkId: listing.networkId,
      agentId: agent?.agent_id ?? null,
      personId: target.personId,
      channel: 'email',
      kind: 'alert',
      purpose: ONLINE_SIGNATURE_PURPOSE,
      subject: `signature_bail:${id}`,
      fallbackTexts: [`${await this.greeting(target.personId)}Votre code de signature du bail : ${code}. Il est valable ${CODE_TTL_MINUTES} minutes. Ne le donnez à personne, pas même à votre agent.`],
      figures: [code, CODE_TTL_MINUTES],
      secrets: [{ kind: 'code', value: code }],
    });
    // Refusé (heure, exclusion, arrêt, pas de mail…) : la session reste sans code utilisable et expire.
    if (sent.status !== 'sent') return { ok: false, rule: sent.rule, code: 'send_refused' };
    await appendEvent(this.journal, { type: 'location.signature_ouverte', actor: this.actor(viewer), subject: `rental:${listing.id}`, data: { session: id, party, lease: `rental_lease:${target.leaseId}`, mode: 'essai' } }, this.now);
    return { ok: true, value: { sessionId: id, leaseId: target.leaseId, contentSha256: target.contentSha256, expiresAt, mode: 'essai' } };
  }

  /**
   * La signature d'une partie : son code, et son tracé à l'écran s'il y en a un. Le bail doit être encore celui de
   * l'ouverture, en vigueur, de même empreinte ; sinon de nouvelles signatures sont demandées [R108].
   */
  async sign(viewer: Viewer, sessionId: unknown, input: { code?: unknown; drawing?: unknown }): Promise<LeaseSignatureResult<LeaseSignatureProof & { bothSigned: boolean }>> {
    const session =
      typeof sessionId === 'string'
        ? ((await this.db.first<SessionRow>('SELECT * FROM rental_lease_signatures WHERE id = ?', [sessionId])) ?? (await this.db.first<SessionRow>('SELECT * FROM rental_lease_cotenant_signatures WHERE id = ?', [sessionId])))
        : null;
    if (!session || session.network_id !== viewer.networkId) {
      await appendEvent(this.journal, { type: 'acces.refuse', actor: this.actor(viewer), subject: `lease_signature:${String(sessionId)}`, data: { rule: 'R16', role: String(viewer.role), kind: 'lease_signature', code: 'unknown' } }, this.now);
      return { ok: false, rule: null, code: 'unknown_session' };
    }
    const listing = await this.listings.listing(viewer, session.listing_id, true);
    if ('ok' in listing) return listing;
    if (viewer.role !== 'agent' && viewer.role !== 'direction') return this.refuse(viewer, `rental:${listing.id}`, 'role');
    const sees = await this.seesParty(viewer, session.person_id);
    if (sees !== true) return sees;
    if (session.status === 'signee') return { ok: false, rule: null, code: 'already_signed' };
    if (session.status === 'bloquee') return { ok: false, rule: null, code: 'blocked' };
    if (this.now().getTime() > Date.parse(session.expires_at)) return { ok: false, rule: null, code: 'expired' };
    const drawing = input.drawing;
    if (drawing !== undefined && drawing !== null && (typeof drawing !== 'string' || drawing.length === 0 || drawing.length > MAX_DRAWING)) return { ok: false, rule: null, code: 'bad_drawing' };

    const given = typeof input.code === 'string' && /^\d{6}$/.test(input.code) ? await sha256(`${session.id}:${input.code}`) : '';
    if (!given || !sameSignatureHash(given, session.code_hash)) {
      // L'essai est compté dans la base, en un seul ordre : des essais simultanés comptent chacun.
      const after = await this.db.first<{ attempts: number; status: string }>(
        `UPDATE ${TABLE(session.party)} SET attempts = attempts + 1, status = CASE WHEN attempts + 1 >= ? THEN 'bloquee' ELSE status END
         WHERE id = ? AND status = 'ouverte' RETURNING attempts, status`,
        [MAX_CODE_ATTEMPTS, session.id],
      );
      const blocked = !after || after.status === 'bloquee';
      await appendEvent(this.journal, { type: 'location.signature_code_faux', actor: this.actor(viewer), subject: `lease_signature:${session.id}`, data: { attempts: Number(after?.attempts ?? MAX_CODE_ATTEMPTS), blocked } }, this.now);
      return { ok: false, rule: null, code: blocked ? 'blocked' : 'wrong_code' };
    }
    // Le bail est encore celui de l'ouverture : en vigueur, complet, même empreinte, même partie [R108, R101, R105].
    const target = await this.target(listing.networkId, listing.id, listing.ownerPersonId, session.party, session.person_id);
    if ('ok' in target || target.leaseId !== session.lease_id || target.contentSha256 !== session.content_sha256 || target.personId !== session.person_id) {
      return { ok: false, rule: 'R108', code: 'lease_changed' };
    }
    const signedAt = this.now().toISOString();
    const drawingHash = typeof drawing === 'string' ? await sha256(drawing) : null;
    const proof: LeaseSignatureProof = {
      leaseId: session.lease_id,
      party: session.party,
      contentSha256: session.content_sha256,
      signedAt,
      method: drawingHash ? 'code_et_trace' : 'code',
      drawingHash,
      mode: 'essai',
      realSignature: false,
    };
    let changes = 0;
    try {
      ({ changes } = await this.db.run(`UPDATE ${TABLE(session.party)} SET status = 'signee', signed_at = ?, drawing_hash = ?, proof = ? WHERE id = ? AND status = 'ouverte'`, [
        signedAt,
        drawingHash,
        JSON.stringify(proof),
        session.id,
      ]));
    } catch (error) {
      // Une autre session de la même partie a signé ce bail entre-temps : une seule signature par partie.
      if (/UNIQUE/i.test(String(error))) return { ok: false, rule: null, code: 'already_signed' };
      throw error;
    }
    if (changes !== 1) return { ok: false, rule: null, code: 'already_signed' };
    await appendEvent(this.journal, { type: 'location.signature_essai', actor: this.actor(viewer), subject: `rental:${listing.id}`, data: { rule: 'R108', session: session.id, party: session.party, method: proof.method, realSignature: false } }, this.now);
    const status = await this.status(listing.networkId, session.lease_id);
    const bothSigned = status?.signedAt !== null && status?.signedAt !== undefined;
    if (bothSigned) await this.deliverCopies(viewer, listing.networkId, listing.id, listing.propertyId, session.lease_id);
    return { ok: true, value: { ...proof, bothSigned } };
  }

  /** Les signatures d'un bail : de chaque partie, et la date où la seconde a signé. */
  async status(networkId: string, leaseId: string): Promise<LeaseSignatureStatus | null> {
    const lease = await this.db.first<{ content_sha256: string }>('SELECT content_sha256 FROM rental_leases WHERE id = ? AND network_id = ?', [leaseId, networkId]);
    if (!lease) return null;
    const rows = await this.db.all<{ party: LeaseParty; signed_at: string; content_sha256: string }>(
      "SELECT party, signed_at, content_sha256 FROM rental_lease_signatures WHERE lease_id = ? AND network_id = ? AND status = 'signee'",
      [leaseId, networkId],
    );
    // Une signature ne vaut que pour l'empreinte du bail rangé.
    const of = (p: LeaseParty) => rows.find((r) => r.party === p && r.content_sha256 === lease.content_sha256)?.signed_at ?? null;
    const bailleur = of('bailleur');
    const locataire = of('locataire');
    // AU097 · chaque colocataire nommé au bail signe à son tour ; le bail n'est signé qu'avec tous.
    const coRows = await this.db.all<{ person_id: string; signed_at: string; content_sha256: string }>(
      "SELECT person_id, signed_at, content_sha256 FROM rental_lease_cotenant_signatures WHERE lease_id = ? AND network_id = ? AND status = 'signee'",
      [leaseId, networkId],
    );
    const colocataires = (await leaseCotenants(this.db, leaseId)).map((personId) => ({ personId, signedAt: coRows.find((r) => r.person_id === personId && r.content_sha256 === lease.content_sha256)?.signed_at ?? null }));
    const all = [bailleur, locataire, ...colocataires.map((c) => c.signedAt)];
    const copy = await this.db.first<{ content_sha256: string }>('SELECT content_sha256 FROM rental_lease_copies WHERE lease_id = ?', [leaseId]);
    const sent = await this.db.all<{ party: LeaseParty }>('SELECT party FROM rental_lease_copy_deliveries WHERE lease_id = ? ORDER BY party', [leaseId]);
    const coSent = await this.db.all<{ person_id: string }>('SELECT person_id FROM rental_lease_cotenant_copy_deliveries WHERE lease_id = ? ORDER BY person_id', [leaseId]);
    return {
      leaseId,
      contentSha256: lease.content_sha256,
      bailleur,
      locataire,
      colocataires,
      signedAt: all.every((d) => d !== null) ? (all as string[]).reduce((a, b) => (a > b ? a : b)) : null,
      realSignature: false,
      copySha256: copy?.content_sha256 ?? null,
      copiesSent: sent.map((r) => r.party),
      cotenantCopiesSent: coSent.map((r) => r.person_id),
    };
  }

  /**
   * Pour la remise des clés (W08) : la date de signature d'un bail signé en vrai. Tant que H08 et H24 ne sont pas faits,
   * jamais : une signature d'essai ne rend pas un bail signé réel [R108].
   */
  async signedAt(networkId: string, leaseId: string): Promise<string | null> {
    if (!REAL_LEASE_SIGNATURE) return null;
    const lease = await this.db.first<{ mode: string }>('SELECT mode FROM rental_leases WHERE id = ? AND network_id = ?', [leaseId, networkId]);
    if (lease?.mode !== 'reel') return null;
    return (await this.status(networkId, leaseId))?.signedAt ?? null;
  }

  /**
   * Pour le seul parcours d'essai (tests et W09) : la signature d'essai lue comme une signature. Jamais branchée sur la
   * remise des clés réelle (W10) : seul `signedAt` l'est.
   */
  trialState(): LeaseSignatureState {
    return { signedAt: async (networkId, leaseId) => (await this.status(networkId, leaseId))?.signedAt ?? null };
  }

  /**
   * L'exemplaire unique du bail signé par les deux parties (le bail suivi des deux preuves), et sa remise à chacune par
   * le contrôle central : la même référence et la même empreinte. Une remise refusée (heure…) est reprise plus tard.
   */
  async sendCopies(viewer: Viewer, listingId: unknown): Promise<LeaseSignatureResult<{ copySha256: string; sent: LeaseParty[] }>> {
    const listing = await this.listings.listing(viewer, listingId, true);
    if ('ok' in listing) return listing;
    if (viewer.role !== 'agent' && viewer.role !== 'direction') return this.refuse(viewer, `rental:${listing.id}`, 'role');
    // Toute remise en attente est reprise, même si le bail signé n'est plus en vigueur depuis : un bail signé par les
    // deux parties est toujours remis à chacune [R108].
    const pending = await this.db.all<{ lease_id: string }>(
      `SELECT c.lease_id FROM rental_lease_copies c WHERE c.listing_id = ? AND c.network_id = ?
       AND (SELECT COUNT(*) FROM rental_lease_copy_deliveries d WHERE d.lease_id = c.lease_id)
         + (SELECT COUNT(*) FROM rental_lease_cotenant_copy_deliveries e WHERE e.lease_id = c.lease_id)
         < 2 + (SELECT COUNT(*) FROM rental_lease_cotenants t WHERE t.lease_id = c.lease_id) ORDER BY c.created_at`,
      [listing.id, listing.networkId],
    );
    for (const p of pending) await this.deliverCopies(viewer, listing.networkId, listing.id, listing.propertyId, p.lease_id);
    const lease = await this.leases.current(listing.networkId, listing.id);
    const target = lease ? lease.leaseId : (await this.db.first<{ lease_id: string }>('SELECT lease_id FROM rental_lease_copies WHERE listing_id = ? ORDER BY created_at DESC LIMIT 1', [listing.id]))?.lease_id;
    if (!target) return { ok: false, rule: 'R108', code: 'no_current_lease' };
    const status = await this.status(listing.networkId, target);
    if (!status?.signedAt) return { ok: false, rule: 'R108', code: 'not_signed' };
    return this.deliverCopies(viewer, listing.networkId, listing.id, listing.propertyId, target);
  }

  private async deliverCopies(viewer: Viewer, networkId: string, listingId: string, propertyId: string, leaseId: string): Promise<LeaseSignatureResult<{ copySha256: string; sent: LeaseParty[] }>> {
    const lease = (await this.db.first<{ content: string; content_sha256: string }>('SELECT content, content_sha256 FROM rental_leases WHERE id = ?', [leaseId]))!;
    const proofs = [
      ...(await this.db.all<{ id: string; party: SignerParty; proof: string }>(
        "SELECT id, party, proof FROM rental_lease_signatures WHERE lease_id = ? AND status = 'signee' AND content_sha256 = ? ORDER BY party",
        [leaseId, lease.content_sha256],
      )),
      // Puis chaque colocataire, dans l'ordre du bail (AU097).
      ...(await this.db.all<{ id: string; party: SignerParty; proof: string }>(
        `SELECT s.id, s.party, s.proof FROM rental_lease_cotenant_signatures s JOIN rental_lease_cotenants t ON t.lease_id = s.lease_id AND t.person_id = s.person_id
         WHERE s.lease_id = ? AND s.status = 'signee' AND s.content_sha256 = ? ORDER BY t.position`,
        [leaseId, lease.content_sha256],
      )),
    ];
    const lines = proofs.map((p) => {
      const proof = JSON.parse(p.proof) as LeaseSignatureProof;
      return `<!-- Signature en ligne d'essai du ${p.party} : session ${p.id}, empreinte ${proof.contentSha256}, ${proof.signedAt}, ${proof.method} -->`;
    });
    const content = `${lease.content}\n${lines.join('\n')}\n`;
    const copySha = await sha256(content);
    await this.db.run('INSERT INTO rental_lease_copies (lease_id, network_id, listing_id, content, content_sha256, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (lease_id) DO NOTHING', [
      leaseId,
      networkId,
      listingId,
      content,
      copySha,
      this.now().toISOString(),
    ]);
    // L'exemplaire rangé fait foi : le même pour les deux parties.
    const copy = (await this.db.first<{ content_sha256: string }>('SELECT content_sha256 FROM rental_lease_copies WHERE lease_id = ?', [leaseId]))!;
    const agent = await this.db.first<{ agent_id: string | null }>('SELECT agent_id FROM properties WHERE id = ?', [propertyId]);
    const sessions = [
      ...(await this.db.all<{ id: string; party: SignerParty; person_id: string }>("SELECT id, party, person_id FROM rental_lease_signatures WHERE lease_id = ? AND status = 'signee' ORDER BY party", [leaseId])),
      ...(await this.db.all<{ id: string; party: SignerParty; person_id: string }>("SELECT id, party, person_id FROM rental_lease_cotenant_signatures WHERE lease_id = ? AND status = 'signee' ORDER BY person_id", [leaseId])),
    ];
    const shared = (await leaseCotenants(this.db, leaseId)).length > 0;
    for (const s of sessions) {
      const delivered =
        s.party === 'colocataire'
          ? await this.db.first('SELECT 1 FROM rental_lease_cotenant_copy_deliveries WHERE lease_id = ? AND person_id = ?', [leaseId, s.person_id])
          : await this.db.first('SELECT 1 FROM rental_lease_copy_deliveries WHERE lease_id = ? AND party = ?', [leaseId, s.party]);
      if (delivered) continue;
      const reference = `bail ${leaseId}`;
      const result = await this.envois.send({
        networkId,
        agentId: agent?.agent_id ?? null,
        personId: s.person_id,
        channel: 'email',
        kind: 'alert',
        purpose: ONLINE_SIGNATURE_PURPOSE,
        subject: `signature_bail:${leaseId}:exemplaire`,
        fallbackTexts: [
          shared
            ? `${await this.greeting(s.person_id)}Votre bail signé en ligne par le bailleur et chaque colocataire est enregistré sous la référence ${reference}. Votre agent vous remet votre exemplaire, le même pour tous : il porte l’empreinte ${copy.content_sha256}. Signature d’essai, sans valeur juridique.`
            : `${await this.greeting(s.person_id)}Votre bail signé en ligne par les deux parties est enregistré sous la référence ${reference}. Votre agent vous remet votre exemplaire, le même pour le bailleur et le locataire : il porte l’empreinte ${copy.content_sha256}. Signature d’essai, sans valeur juridique.`,
        ],
        // La référence et l'empreinte sont des identifiants, pas des chiffres à vérifier : leurs nombres sont permis [R10].
        figures: [...(leaseId.match(/\d+/g) ?? []), ...(copy.content_sha256.match(/\d+/g) ?? [])],
      });
      if (result.status !== 'sent') continue;
      if (s.party === 'colocataire') await this.db.run('INSERT INTO rental_lease_cotenant_copy_deliveries (lease_id, person_id, copy_sha256, sent_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING', [leaseId, s.person_id, copy.content_sha256, this.now().toISOString()]);
      else await this.db.run('INSERT INTO rental_lease_copy_deliveries (lease_id, party, copy_sha256, sent_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING', [leaseId, s.party, copy.content_sha256, this.now().toISOString()]);
      await appendEvent(
        this.journal,
        // Un colocataire est nommé par sa session de signature : l'avis est à lui seul dans sa réponse d'accès (AU097).
        { type: 'location.bail_exemplaire', actor: this.actor(viewer), subject: `rental:${listingId}`, data: { rule: 'R108', party: s.party, copy: copy.content_sha256, ...(s.party === 'colocataire' ? { session: s.id } : {}) } },
        this.now,
      );
    }
    const sent = await this.db.all<{ party: LeaseParty }>('SELECT party FROM rental_lease_copy_deliveries WHERE lease_id = ? ORDER BY party', [leaseId]);
    return { ok: true, value: { copySha256: copy.content_sha256, sent: sent.map((r) => r.party) } };
  }

  /** L'exemplaire du bail signé, pour qui voit la mise en location [R16]. */
  async copy(viewer: Viewer, listingId: unknown, leaseId: unknown): Promise<LeaseSignatureResult<{ content: string; contentSha256: string }>> {
    // Comme l'état des lieux (W07) : l'agent du bien ou la direction seuls, jamais la conformité [R16].
    const listing = await this.listings.listing(viewer, listingId, true);
    if ('ok' in listing) return listing;
    const row = typeof leaseId === 'string' ? await this.db.first<{ content: string; content_sha256: string }>('SELECT content, content_sha256 FROM rental_lease_copies WHERE lease_id = ? AND listing_id = ?', [leaseId, listing.id]) : null;
    if (!row) return { ok: false, rule: null, code: 'not_signed' };
    // L'exemplaire porte l'identité des deux parties : le lecteur doit voir chacune de leurs fiches en entier [R16].
    const signers = await this.db.all<{ person_id: string }>(
      "SELECT person_id FROM rental_lease_signatures WHERE lease_id = ? AND status = 'signee' UNION SELECT person_id FROM rental_lease_cotenant_signatures WHERE lease_id = ? AND status = 'signee' ORDER BY person_id",
      [leaseId as string, leaseId as string],
    );
    for (const s of signers) {
      const sees = await this.seesParty(viewer, s.person_id);
      if (sees !== true) return sees;
    }
    await appendEvent(this.journal, { type: 'location.lue', actor: this.actor(viewer), subject: `rental:${listing.id}`, data: { rule: 'R16', what: 'lease_copy' } }, this.now);
    return { ok: true, value: { content: row.content, contentSha256: row.content_sha256 } };
  }

  /**
   * Le texte du bail en vigueur, à relire avec les parties après une réouverture (W15). Il porte l'identité des deux
   * parties : l'agent du bien ou la direction seuls, voyant chaque fiche en entier ; la lecture est au journal [R16].
   */
  async text(viewer: Viewer, listingId: unknown): Promise<LeaseSignatureResult<{ leaseId: string; content: string; contentSha256: string }>> {
    const listing = await this.listings.listing(viewer, listingId, true);
    if ('ok' in listing) return listing;
    if (viewer.role !== 'agent' && viewer.role !== 'direction') return this.refuse(viewer, `rental:${listing.id}`, 'role');
    let lease: { leaseId: string; contentSha256: string } | null = null;
    for (const party of LEASE_PARTIES) {
      const target = await this.target(listing.networkId, listing.id, listing.ownerPersonId, party);
      if ('ok' in target) return target;
      const sees = await this.seesParty(viewer, target.personId);
      if (sees !== true) return sees;
      lease = target;
    }
    // AU097 · le bail nomme aussi chaque colocataire : le lecteur voit chacune de leurs fiches en entier [R16].
    for (const personId of await leaseCotenants(this.db, lease!.leaseId)) {
      const sees = await this.seesParty(viewer, personId);
      if (sees !== true) return sees;
    }
    const row = await this.db.first<{ content: string }>('SELECT content FROM rental_leases WHERE id = ? AND listing_id = ?', [lease!.leaseId, listing.id]);
    if (!row) return { ok: false, rule: null, code: 'no_current_lease' };
    await appendEvent(this.journal, { type: 'location.lue', actor: this.actor(viewer), subject: `rental:${listing.id}`, data: { rule: 'R16', what: 'lease_text' } }, this.now);
    return { ok: true, value: { leaseId: lease!.leaseId, content: row.content, contentSha256: lease!.contentSha256 } };
  }

  /** Le premier message s'adresse à la personne par son prénom [R08]. */
  private async greeting(personId: string): Promise<string> {
    const first = await ficheFirstName(this.db, await this.fiche.membersOf(personId));
    return first ? `Bonjour ${first},\n\n` : 'Bonjour,\n\n';
  }
}
