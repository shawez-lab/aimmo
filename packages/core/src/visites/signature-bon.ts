/**
 * Le bon de visite signé sans papier (M08, AU075) [R40, R03, R16, R26, R506].
 *
 * Constat de l'audit : pour une visite sur place, le seul parcours rangeait un bon signé sur papier, daté et scanné.
 * Ici, le visiteur signe sans impression :
 * - sur place, sur le téléphone de l'agent : l'agent ouvre la signature, le visiteur reçoit un code sur son propre
 *   téléphone (SMS) ou par mail, lit le bon à l'écran de l'agent et tape lui-même le code, avec son tracé s'il veut ;
 * - à distance, après la visite : un lien et un code, chacun dans son message ; le visiteur lit et signe sur son
 *   téléphone, sans l'agent.
 * Le code expire, ne sert qu'une fois, et cinq essais faux bloquent la signature ; seules les empreintes sont gardées
 * (code, lien, tracé). Le bon signé est celui qui est rangé, au caractère près : son empreinte entre dans la preuve.
 * Signé, le bon est rangé signé (`visit_slips.signed_at`, `signed_by = 'visiteur:en_ligne'`) et le visiteur reçoit
 * aussitôt, par le contrôle central, le lien de son exemplaire : le bon tel qu'il l'a signé, suivi de sa preuve (heure,
 * manière, empreinte du bon, empreinte du tracé) [R506].
 *
 * Décidé, lecture prudente :
 * - la signature d'une visite faite à distance reste celle de HX44 (`VisiteDistance`), qui garde aussi le registre des
 *   offres [R505] : ici, une visite à distance est refusée (`remote_visit`), et la base le garde ;
 * - le bon papier reste possible en secours (`recordPaperSignature`), mais le premier des deux qui signe ferme l'autre ;
 * - tant que H24 (dossier de preuve validé par l'avocat) n'est pas réglé, la signature est d'essai, dite comme telle
 *   dans la preuve, l'exemplaire et la réponse (`realSignature: false`) ; le bon d'essai reste un bon d'essai (H08) ;
 * - l'accord du visiteur de recevoir code et exemplaire sur ce canal est exigé [R03], comme pour HX44 ;
 * - sur place, la signature s'ouvre au plus tôt 30 minutes avant la visite et au plus tard 2 heures après sa fin ; à
 *   distance, à partir de l'heure de la visite et jusqu'à 7 jours après sa fin ;
 * - l'exemplaire n'a ni adresse exacte ni nom du vendeur : c'est le bon rangé, déjà sans eux [R19].
 *
 * Les routes de l'agent vivent dans `packages/api/src/acquereurs.ts` ; les pages publiques du lien (lecture, signature
 * et exemplaire) se branchent au Worker par la voie 1, comme celles de HX44.
 */
import type { Viewer } from '../acces/droits.ts';
import { trialChannels } from '../captation/essai.ts';
import { FicheClient } from '../db/fiche-client.ts';
import { runBatch, type SqlDatabase } from '../db/sql.ts';
import { DESIGN_CSS, THEME_COLOR } from '../design/systeme.ts';
import { escapeHtml, sha256 } from '../documents/modeles.ts';
import { CODE_TTL_MINUTES, MAX_CODE_ATTEMPTS, newSignatureCode, sameSignatureHash } from '../documents/signature-en-ligne.ts';
import { ControleEnvois } from '../envoi/controle.ts';
import { SqlSendJournal } from '../envoi/journal-envois.ts';
import { DecisionEnvoi } from '../envoi/service.ts';
import { FicheUnique } from '../fiche/fusion.ts';
import { ficheFirstName } from '../fiche/prenom.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import { ONLINE_SLIP_SIGNER, type Visites } from './visites.ts';

/** La finalité de l'accord du visiteur à recevoir le code et l'exemplaire de son bon (la même que HX44) [R03]. */
export const SLIP_SIGNATURE_PURPOSE = 'signature_bon_visite';
/** Sur place : la signature s'ouvre au plus tôt tant de minutes avant la visite… */
export const ONSITE_EARLY_MINUTES = 30;
/** … et au plus tard tant d'heures après sa fin. */
export const ONSITE_LATE_HOURS = 2;
/** À distance : le lien s'envoie jusqu'à tant de jours après la fin de la visite, et vit tant d'heures. */
export const DISTANCE_DAYS_AFTER = 7;
export const DISTANCE_LINK_HOURS = 48;
/** L'exemplaire reste lisible tant de jours par son lien. */
export const COPY_DAYS = 365;
const MAX_DRAWING = 200_000;
const DAY = 86_400_000;
const TOKEN = /^[0-9a-f]{64}$/;

export type SlipPlace = 'sur_place' | 'distance';
export type SlipChannel = 'sms' | 'email';
export type SlipSignatureRefusal = { ok: false; rule: string | null; code: string; reason?: string };

/** La preuve gardée avec la signature et remise dans l'exemplaire. */
export interface SlipSignatureProof {
  appointmentId: string;
  slipId: string;
  slipHash: string;
  signedAt: string;
  place: SlipPlace;
  method: 'code' | 'code_et_trace';
  channel: SlipChannel;
  drawingHash: string | null;
  mode: 'essai';
  realSignature: false;
}

export interface SlipSignatureDone {
  proof: SlipSignatureProof;
  /** La remise du lien de l'exemplaire au visiteur, par le contrôle central. */
  copy: 'remis' | 'refuse';
}

export interface SignatureBonOptions {
  /** Le contrôle central des envois ; par défaut, celui du mode essai (boîte d'essai, rien ne part) [R26]. */
  envois?: ControleEnvois;
  /** L'adresse de la page de signature, pour un jeton. */
  signUrl?: (token: string) => string;
  /** L'adresse de l'exemplaire signé, pour un jeton. */
  copyUrl?: (token: string) => string;
  now?: () => Date;
  newId?: () => string;
  newToken?: () => string;
  newCode?: () => string;
}

interface VisitRow {
  network_id: string;
  property_id: string;
  project_id: string;
  person_id: string;
  agent_id: string;
  status: string;
  start_at: string;
  end_at: string;
}

interface SessionRow {
  id: string;
  network_id: string;
  appointment_id: string;
  slip_id: string;
  slip_hash: string;
  place: SlipPlace;
  channel: SlipChannel;
  code_hash: string;
  code_expires_at: string;
  link_expires_at: string;
  attempts: number;
  status: 'ouverte' | 'signee' | 'bloquee' | 'remplacee';
  signed_at: string | null;
  proof: string | null;
  created_at: string;
}

function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const parisDateTime = (iso: string): string =>
  new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(iso));

const COPY_CSS =
  'main{max-width:40rem;margin:0 auto;padding:var(--e-4)}pre{white-space:pre-wrap;font:inherit;line-height:1.5}' +
  '.preuve{border-top:1px solid var(--trait);margin-top:var(--e-5);padding-top:var(--e-4)}.preuve dt{font-weight:600}.preuve dd{margin:0 0 var(--e-2);overflow-wrap:anywhere}';

/** L'exemplaire du visiteur : le bon tel qu'il est rangé, puis sa preuve. Rendu par le code, sans rien venu d'ailleurs. */
export function renderSlipCopy(content: string, proof: SlipSignatureProof): string {
  const how = proof.method === 'code_et_trace' ? 'code à usage unique et tracé' : 'code à usage unique';
  const where = proof.place === 'sur_place' ? 'sur place, sur le téléphone de l’agent' : 'à distance, par le lien reçu';
  const rows: [string, string][] = [
    ['Signé le', `${parisDateTime(proof.signedAt)} (heure de Paris)`],
    ['Manière', `${how}, ${where} ; code reçu par ${proof.channel === 'sms' ? 'SMS' : 'mail'}`],
    ['Empreinte du bon (SHA-256)', proof.slipHash],
  ];
  if (proof.drawingHash) rows.push(['Empreinte du tracé (SHA-256)', proof.drawingHash]);
  rows.push(['Valeur', 'Signature d’essai : sans valeur juridique tant que le dossier de preuve n’est pas validé.']);
  return (
    '<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
    `<meta name="theme-color" content="${THEME_COLOR}"><meta name="robots" content="noindex"><title>Votre bon de visite signé</title>` +
    `<style>${DESIGN_CSS}${COPY_CSS}</style></head><body><main><h1>Votre bon de visite signé</h1>` +
    `<pre>${escapeHtml(content)}</pre><section class="preuve" aria-label="Preuve de la signature"><h2>Preuve de la signature</h2><dl>` +
    rows.map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd>`).join('') +
    '</dl></section></main></body></html>'
  );
}

export class SignatureBon {
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly newToken: () => string;
  private readonly newCode: () => string;
  private readonly store: FicheClient;
  private readonly fiche: FicheUnique;
  private readonly envois: ControleEnvois;
  private readonly signUrl: (token: string) => string;
  private readonly copyUrl: (token: string) => string;

  constructor(
    private readonly db: SqlDatabase,
    private readonly journal: JournalStore,
    private readonly visites: Visites,
    options: SignatureBonOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => crypto.randomUUID());
    this.newToken = options.newToken ?? randomToken;
    this.newCode = options.newCode ?? newSignatureCode;
    this.store = new FicheClient(db, { now: this.now });
    this.fiche = new FicheUnique(db, this.store, { now: this.now });
    this.envois =
      options.envois ??
      new ControleEnvois(db, this.fiche, new DecisionEnvoi(db, this.store, this.fiche, { now: this.now }), {
        channels: trialChannels(db, journal, this.now),
        journal: new SqlSendJournal(db, undefined, this.now),
        now: this.now,
      });
    this.signUrl = options.signUrl ?? ((t) => `https://aimmo.fr/visite/signer/${t}`);
    this.copyUrl = options.copyUrl ?? ((t) => `https://aimmo.fr/visite/exemplaire/${t}`);
  }

  private actor(viewer: Viewer): string {
    return `${String(viewer.role)}:${viewer.userId}`;
  }

  /** La visite, pour l'agent qui voit la fiche du visiteur en entier ou la direction ; un refus est au journal [R16]. */
  private async visit(viewer: Viewer, appointmentId: unknown): Promise<{ ok: true; v: VisitRow } | SlipSignatureRefusal> {
    if (typeof appointmentId !== 'string' || appointmentId === '' || appointmentId.length > 100) return { ok: false, rule: null, code: 'unknown' };
    const access = await this.visites.accessVisit(viewer, appointmentId);
    if (!access.ok) return access;
    const v = await this.db.first<VisitRow>(
      `SELECT v.network_id, v.property_id, v.project_id, v.person_id, v.agent_id, a.status, a.start_at, a.end_at
         FROM visits v JOIN appointments a ON a.id = v.appointment_id WHERE v.appointment_id = ?`,
      [appointmentId],
    );
    if (!v || v.network_id !== viewer.networkId) return { ok: false, rule: null, code: 'unknown' };
    return { ok: true, v };
  }

  /** L'accord du visiteur sur ce canal : en cours, ou donné maintenant avec sa preuve ; jamais redonné après un retrait [R03]. */
  private async ensureConsent(v: VisitRow, channel: SlipChannel, proof: unknown): Promise<'ok' | 'no_consent' | 'consent_withdrawn'> {
    if (await this.fiche.hasConsentInForce(v.person_id, SLIP_SIGNATURE_PURPOSE, channel)) return 'ok';
    const members = await this.fiche.membersOf(v.person_id);
    const withdrawn = await this.db.first(
      `SELECT id FROM consents WHERE person_id IN (${members.map(() => '?').join(', ')}) AND purpose = ? AND channel = ? AND withdrawn_at IS NOT NULL`,
      [...members, SLIP_SIGNATURE_PURPOSE, channel],
    );
    if (withdrawn) return 'consent_withdrawn';
    if (typeof proof !== 'string' || proof.trim() === '' || proof.length > 300) return 'no_consent';
    await this.store.addConsent({ networkId: v.network_id, personId: v.person_id, purpose: SLIP_SIGNATURE_PURPOSE, channel, proof: proof.trim(), givenAt: this.now() });
    return 'ok';
  }

  private async greeting(personId: string, channel: SlipChannel): Promise<string> {
    const first = await ficheFirstName(this.db, await this.fiche.membersOf(personId));
    if (channel === 'sms') return first ? `Bonjour ${first}, ` : 'Bonjour, ';
    return first ? `Bonjour ${first},\n\n` : 'Bonjour,\n\n';
  }

  /**
   * L'agent ouvre la signature du bon, sur place ou à distance : le code part au visiteur (et le lien, à distance), par
   * le contrôle central. Une signature encore ouverte est remplacée [R40, R03, R16].
   */
  async open(
    viewer: Viewer,
    appointmentId: string,
    input: { place?: unknown; channel?: unknown; consentProof?: unknown },
  ): Promise<{ ok: true; value: { sessionId: string; place: SlipPlace; channel: SlipChannel; codeExpiresAt: string; mode: 'essai' } } | SlipSignatureRefusal> {
    const place = input.place;
    const asked = input.channel ?? (place === 'sur_place' ? 'sms' : 'email');
    if (place !== 'sur_place' && place !== 'distance') return { ok: false, rule: null, code: 'bad_place' };
    if (asked !== 'sms' && asked !== 'email') return { ok: false, rule: null, code: 'bad_channel' };
    const channel: SlipChannel = asked;
    const found = await this.visit(viewer, appointmentId);
    if (!found.ok) return found;
    const v = found.v;
    if (await this.db.first('SELECT 1 FROM remote_visits WHERE appointment_id = ?', [appointmentId])) return { ok: false, rule: 'R504', code: 'remote_visit' };
    if (v.status !== 'booked' && v.status !== 'honored') return { ok: false, rule: null, code: 'not_booked' };
    const at = this.now();
    const t = at.getTime();
    const start = Date.parse(v.start_at);
    const end = Date.parse(v.end_at);
    const inWindow = place === 'sur_place' ? t >= start - ONSITE_EARLY_MINUTES * 60_000 && t <= end + ONSITE_LATE_HOURS * 3_600_000 : t >= start && t <= end + DISTANCE_DAYS_AFTER * DAY;
    if (!inWindow) return { ok: false, rule: null, code: 'outside_window' };
    const slip = await this.visites.slipOf(viewer, appointmentId);
    if (!slip.ok) return slip;
    if (slip.slip.signedAt) return { ok: false, rule: null, code: 'already_signed' };
    if (slip.slip.status !== 'complet') return { ok: false, rule: 'R40', code: 'slip_incomplete' };
    const view = await this.fiche.view(v.person_id);
    if (!view.identifiers.some((i) => i.kind === (channel === 'sms' ? 'phone' : 'email'))) return { ok: false, rule: null, code: channel === 'sms' ? 'no_phone' : 'no_email' };
    const consent = await this.ensureConsent(v, channel, input.consentProof);
    if (consent !== 'ok') return { ok: false, rule: 'R03', code: consent };
    const id = this.newId();
    const token = place === 'distance' ? this.newToken() : null;
    const code = this.newCode();
    const codeExpiresAt = new Date(t + CODE_TTL_MINUTES * 60_000).toISOString();
    const linkExpiresAt = new Date(place === 'distance' ? t + DISTANCE_LINK_HOURS * 3_600_000 : t + CODE_TTL_MINUTES * 60_000).toISOString();
    await this.db.run(`UPDATE visit_slip_signatures SET status = 'remplacee' WHERE appointment_id = ? AND status = 'ouverte'`, [appointmentId]);
    // Deux ouvertures en même temps : la base n'en garde qu'une ouverte ; l'autre est dite, sans rien envoyer.
    try {
      await this.db.run(
        `INSERT INTO visit_slip_signatures (id, network_id, appointment_id, slip_id, slip_hash, place, channel, token_hash, code_hash, code_expires_at, link_expires_at, attempts, status, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'ouverte', ?, ?)`,
        [
          id,
          v.network_id,
          appointmentId,
          slip.slip.id,
          slip.slip.contentHash,
          place,
          channel,
          token ? await sha256(token) : null,
          await sha256(`${id}:${code}`),
          codeExpiresAt,
          linkExpiresAt,
          this.actor(viewer),
          at.toISOString(),
        ],
      );
    } catch (e) {
      if (await this.db.first(`SELECT 1 FROM visit_slip_signatures WHERE appointment_id = ? AND status IN ('ouverte', 'signee')`, [appointmentId])) return { ok: false, rule: null, code: 'already_open' };
      if (await this.db.first('SELECT 1 FROM visit_slips WHERE appointment_id = ? AND signed_at IS NOT NULL', [appointmentId])) return { ok: false, rule: null, code: 'already_signed' };
      throw e;
    }
    const hello = await this.greeting(v.person_id, channel);
    const base = { networkId: v.network_id, agentId: v.agent_id, personId: v.person_id, projectId: v.project_id, channel, kind: 'follow_up' as const, purpose: SLIP_SIGNATURE_PURPOSE };
    if (token) {
      const link = this.signUrl(token);
      const sentLink = await this.envois.send({
        ...base,
        subject: `bon-visite:${id}:lien`,
        fallbackTexts: [`${hello}Votre bon de visite vous attend ici, à lire puis à signer avec le code reçu dans un autre message : ${link}`],
        figures: link.match(/\d+/g) ?? [],
        secrets: [{ kind: 'lien', value: link }],
      });
      if (sentLink.status !== 'sent') return this.unsent(id, sentLink.rule, sentLink.reason);
    }
    const codeText =
      place === 'sur_place'
        ? `${hello}votre code pour signer votre bon de visite : ${code}. Valable ${CODE_TTL_MINUTES} minutes. Tapez-le vous-même sur l’écran de votre agent, après avoir lu le bon.`
        : `${hello}Votre code pour signer votre bon de visite : ${code}. Il est valable ${CODE_TTL_MINUTES} minutes. Ne le donnez à personne, pas même à votre agent.`;
    const sentCode = await this.envois.send({ ...base, subject: `bon-visite:${id}:code`, fallbackTexts: [codeText], figures: [code, CODE_TTL_MINUTES], secrets: [{ kind: 'code', value: code }] });
    if (sentCode.status !== 'sent') return this.unsent(id, sentCode.rule, sentCode.reason);
    await appendEvent(this.journal, { type: 'bon_visite.signature_ouverte', actor: this.actor(viewer), subject: `visit:${appointmentId}`, data: { session: id, place, channel, mode: 'essai' } }, this.now);
    return { ok: true, value: { sessionId: id, place, channel, codeExpiresAt, mode: 'essai' } };
  }

  /** Un message refusé par le contrôle central : la signature ouverte est close, aucun code ne pourra servir. */
  private async unsent(id: string, rule: string | null, reason: string | undefined): Promise<SlipSignatureRefusal> {
    await this.db.run(`UPDATE visit_slip_signatures SET status = 'remplacee' WHERE id = ? AND status = 'ouverte'`, [id]);
    return { ok: false, rule, code: 'send_refused', ...(reason ? { reason } : {}) };
  }

  /** Le bon à lire sur le téléphone de l'agent, pendant que la signature sur place est ouverte. */
  async readOnSite(viewer: Viewer, appointmentId: string): Promise<{ ok: true; value: { content: string; codeExpiresAt: string; mode: 'essai' } } | SlipSignatureRefusal> {
    const found = await this.visit(viewer, appointmentId);
    if (!found.ok) return found;
    const s = await this.db.first<SessionRow>(`SELECT * FROM visit_slip_signatures WHERE appointment_id = ? AND status = 'ouverte' AND place = 'sur_place'`, [appointmentId]);
    if (!s) return { ok: false, rule: null, code: 'not_open' };
    const slip = await this.db.first<{ content: string; content_hash: string }>('SELECT content, content_hash FROM visit_slips WHERE id = ?', [s.slip_id]);
    if (!slip || slip.content_hash !== s.slip_hash) return { ok: false, rule: null, code: 'slip_changed' };
    return { ok: true, value: { content: slip.content, codeExpiresAt: s.code_expires_at, mode: 'essai' } };
  }

  /** Sur place : le visiteur tape son code sur le téléphone de l'agent, avec son tracé s'il veut. */
  async signOnSite(viewer: Viewer, appointmentId: string, input: { code?: unknown; drawing?: unknown }): Promise<{ ok: true; value: SlipSignatureDone } | SlipSignatureRefusal> {
    const found = await this.visit(viewer, appointmentId);
    if (!found.ok) return found;
    const s = await this.db.first<SessionRow>(
      `SELECT * FROM visit_slip_signatures WHERE appointment_id = ? AND place = 'sur_place' AND status <> 'remplacee' ORDER BY CASE status WHEN 'ouverte' THEN 0 ELSE 1 END, created_at DESC LIMIT 1`,
      [appointmentId],
    );
    if (!s) return { ok: false, rule: null, code: 'not_open' };
    return this.sign(s, input, this.actor(viewer));
  }

  private async byToken(token: unknown): Promise<SessionRow | null> {
    if (typeof token !== 'string' || !TOKEN.test(token)) return null;
    return this.db.first<SessionRow>('SELECT * FROM visit_slip_signatures WHERE token_hash = ?', [await sha256(token)]);
  }

  /** À distance : le bon à lire, pour qui tient le lien, tant que la signature est ouverte et le lien valable. */
  async readByLink(token: unknown): Promise<{ ok: true; content: string } | SlipSignatureRefusal> {
    const s = await this.byToken(token);
    if (!s || s.status === 'remplacee') return { ok: false, rule: null, code: 'unknown' };
    if (s.status !== 'ouverte') return { ok: false, rule: null, code: s.status === 'signee' ? 'already_signed' : 'blocked' };
    if (this.now().getTime() > Date.parse(s.link_expires_at)) return { ok: false, rule: null, code: 'expired' };
    const slip = await this.db.first<{ content: string; content_hash: string }>('SELECT content, content_hash FROM visit_slips WHERE id = ?', [s.slip_id]);
    if (!slip || slip.content_hash !== s.slip_hash) return { ok: false, rule: null, code: 'slip_changed' };
    return { ok: true, content: slip.content };
  }

  /** À distance : le visiteur signe par le lien, avec le code reçu. */
  async signByLink(token: unknown, input: { code?: unknown; drawing?: unknown }): Promise<{ ok: true; value: SlipSignatureDone } | SlipSignatureRefusal> {
    const s = await this.byToken(token);
    if (!s || s.status === 'remplacee') return { ok: false, rule: null, code: 'unknown' };
    return this.sign(s, input, 'visiteur');
  }

  /**
   * La signature elle-même : un code ne sert qu'une fois, expire, et cinq essais faux bloquent ; le bon doit être celui
   * qui a été ouvert, pas déjà signé (papier compris). Signé : le bon est rangé signé, puis l'exemplaire part [R506].
   */
  private async sign(s: SessionRow, input: { code?: unknown; drawing?: unknown }, actor: string): Promise<{ ok: true; value: SlipSignatureDone } | SlipSignatureRefusal> {
    if (s.status === 'signee') return { ok: false, rule: null, code: 'already_signed' };
    if (s.status === 'bloquee') return { ok: false, rule: null, code: 'blocked' };
    if (s.status !== 'ouverte') return { ok: false, rule: null, code: 'not_open' };
    const at = this.now();
    if (at.getTime() > Date.parse(s.link_expires_at) || at.getTime() > Date.parse(s.code_expires_at)) return { ok: false, rule: null, code: 'expired' };
    const drawing = input.drawing ?? null;
    if (drawing !== null && (typeof drawing !== 'string' || drawing.length === 0 || drawing.length > MAX_DRAWING)) return { ok: false, rule: null, code: 'bad_drawing' };
    const given = typeof input.code === 'string' && /^\d{6}$/.test(input.code) ? await sha256(`${s.id}:${input.code}`) : '';
    if (!given || !sameSignatureHash(given, s.code_hash)) {
      // L'essai est compté dans la base, en un seul ordre : des essais simultanés comptent chacun.
      const after = await this.db.first<{ attempts: number; status: string }>(
        `UPDATE visit_slip_signatures SET attempts = attempts + 1, status = CASE WHEN attempts + 1 >= ? THEN 'bloquee' ELSE status END
         WHERE id = ? AND status = 'ouverte' RETURNING attempts, status`,
        [MAX_CODE_ATTEMPTS, s.id],
      );
      const blocked = !after || after.status === 'bloquee';
      await appendEvent(this.journal, { type: 'bon_visite.code_faux', actor, subject: `visit:${s.appointment_id}`, data: { attempts: Number(after?.attempts ?? MAX_CODE_ATTEMPTS), blocked } }, this.now);
      return { ok: false, rule: null, code: blocked ? 'blocked' : 'wrong_code' };
    }
    const slip = await this.db.first<{ content: string; content_hash: string; signed_at: string | null }>('SELECT content, content_hash, signed_at FROM visit_slips WHERE id = ?', [s.slip_id]);
    if (!slip || slip.content_hash !== s.slip_hash) return { ok: false, rule: null, code: 'slip_changed' };
    if (slip.signed_at) return { ok: false, rule: null, code: 'already_signed' };
    const signedAt = at.toISOString();
    const drawingHash = typeof drawing === 'string' ? await sha256(drawing) : null;
    const proof: SlipSignatureProof = {
      appointmentId: s.appointment_id,
      slipId: s.slip_id,
      slipHash: s.slip_hash,
      signedAt,
      place: s.place,
      method: drawingHash ? 'code_et_trace' : 'code',
      channel: s.channel,
      drawingHash,
      mode: 'essai',
      realSignature: false,
    };
    const copyToken = this.newToken();
    // Le bon et la signature se rangent ensemble, ou rien : un bon signé sur papier entre-temps ferme cette signature.
    const results = await runBatch(this.db, [
      { sql: `UPDATE visit_slips SET signed_at = ?, signed_by = ? WHERE id = ? AND signed_at IS NULL AND content_hash = ?`, params: [signedAt, ONLINE_SLIP_SIGNER, s.slip_id, s.slip_hash] },
      {
        sql: `UPDATE visit_slip_signatures SET status = 'signee', signed_at = ?, drawing_hash = ?, proof = ?, copy_token_hash = ?
               WHERE id = ? AND status = 'ouverte' AND EXISTS (SELECT 1 FROM visit_slips WHERE id = ? AND signed_at = ? AND signed_by = ?)`,
        params: [signedAt, drawingHash, JSON.stringify(proof), await sha256(copyToken), s.id, s.slip_id, signedAt, ONLINE_SLIP_SIGNER],
      },
    ]);
    if (results[0]?.changes !== 1 || results[1]?.changes !== 1) {
      if (results[0]?.changes === 1) throw new Error('bon de visite : rangé signé sans sa signature');
      return { ok: false, rule: null, code: 'already_signed' };
    }
    await appendEvent(this.journal, { type: 'bon_visite.signe', actor, subject: `visit:${s.appointment_id}`, data: { slip: s.slip_id, mode: 'en_ligne', place: s.place, method: proof.method, realSignature: false } }, this.now);
    const copy = await this.sendCopy(s, copyToken, signedAt);
    return { ok: true, value: { proof, copy } };
  }

  /** Le lien de l'exemplaire part au visiteur par le contrôle central, sur le canal du code ; l'issue est notée une fois [R506]. */
  private async sendCopy(s: SessionRow, copyToken: string, signedAt: string): Promise<'remis' | 'refuse'> {
    const v = (await this.db.first<VisitRow>('SELECT network_id, property_id, project_id, person_id, agent_id FROM visits WHERE appointment_id = ?', [s.appointment_id]))!;
    const hello = await this.greeting(v.person_id, s.channel);
    const link = this.copyUrl(copyToken);
    const when = parisDateTime(signedAt);
    const text = `${hello}${s.channel === 'sms' ? 'v' : 'V'}otre bon de visite est signé, le ${when}. Votre exemplaire, avec la preuve de votre signature : ${link}`;
    const sent = await this.envois.send({
      networkId: v.network_id,
      agentId: v.agent_id,
      personId: v.person_id,
      projectId: v.project_id,
      channel: s.channel,
      kind: 'follow_up',
      purpose: SLIP_SIGNATURE_PURPOSE,
      subject: `bon-visite:${s.id}:exemplaire`,
      fallbackTexts: [text],
      figures: text.match(/\d+/g) ?? [],
      secrets: [{ kind: 'lien', value: link }],
    });
    const status = sent.status === 'sent' ? 'remis' : 'refuse';
    await this.db.run('UPDATE visit_slip_signatures SET copy_status = ? WHERE id = ? AND copy_status IS NULL', [status, s.id]);
    await appendEvent(this.journal, { type: 'bon_visite.exemplaire', actor: 'system:visites', subject: `visit:${s.appointment_id}`, data: { session: s.id, status, rule: sent.status === 'sent' ? null : sent.rule } }, this.now);
    return status;
  }

  /** L'exemplaire signé, pour qui tient son lien, pendant un an : le bon rangé et sa preuve [R506]. */
  async copy(token: unknown): Promise<{ ok: true; html: string } | SlipSignatureRefusal> {
    if (typeof token !== 'string' || !TOKEN.test(token)) return { ok: false, rule: null, code: 'unknown' };
    const s = await this.db.first<SessionRow>(`SELECT * FROM visit_slip_signatures WHERE copy_token_hash = ? AND status = 'signee'`, [await sha256(token)]);
    if (!s || !s.signed_at || !s.proof) return { ok: false, rule: null, code: 'unknown' };
    if (this.now().getTime() > Date.parse(s.signed_at) + COPY_DAYS * DAY) return { ok: false, rule: null, code: 'expired' };
    const slip = await this.db.first<{ content: string; content_hash: string }>('SELECT content, content_hash FROM visit_slips WHERE id = ?', [s.slip_id]);
    if (!slip || slip.content_hash !== s.slip_hash || (await sha256(slip.content)) !== slip.content_hash) throw new Error('Bon de visite : contenu changé depuis la signature.');
    return { ok: true, html: renderSlipCopy(slip.content, JSON.parse(s.proof) as SlipSignatureProof) };
  }

  /** L'état de la signature en ligne d'une visite, pour l'écran de l'agent : jamais un code ni un lien. */
  async state(viewer: Viewer, appointmentId: string): Promise<{ ok: true; value: { status: 'aucune' | 'ouverte' | 'signee' | 'bloquee'; place: SlipPlace | null; channel: SlipChannel | null; signedAt: string | null; copy: 'remis' | 'refuse' | null } } | SlipSignatureRefusal> {
    const found = await this.visit(viewer, appointmentId);
    if (!found.ok) return found;
    const s = await this.db.first<SessionRow & { copy_status: 'remis' | 'refuse' | null }>(
      `SELECT * FROM visit_slip_signatures WHERE appointment_id = ? AND status <> 'remplacee' ORDER BY CASE status WHEN 'signee' THEN 0 ELSE 1 END, created_at DESC LIMIT 1`,
      [appointmentId],
    );
    if (!s) return { ok: true, value: { status: 'aucune', place: null, channel: null, signedAt: null, copy: null } };
    return { ok: true, value: { status: s.status as 'ouverte' | 'signee' | 'bloquee', place: s.place, channel: s.channel, signedAt: s.signed_at, copy: s.copy_status } };
  }
}
