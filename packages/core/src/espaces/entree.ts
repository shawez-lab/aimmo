/**
 * L'entrée d'un client dans son espace, sans mot de passe (EC01) [R160, R03, R16, R26, R13].
 *
 * Décidé, lecture prudente :
 * - l'espace d'une personne s'ouvre d'abord par son agent (ou la direction), seulement si elle est partie à au moins un
 *   dossier, et avec la preuve de son accord pour recevoir le lien de son espace par mail [R03] : une adresse tapée par
 *   n'importe qui ne vaut pas accord ;
 * - le lien est personnel, à usage unique, valable 30 minutes (réglage) ; il part par le contrôle central, avec les
 *   seuls canaux du mode essai : rangé, jamais envoyé [R26] ; un lien que le contrôle refuse (exclusion, arrêt, heure)
 *   est révoqué aussitôt ;
 * - ouvert, le lien donne une séance de 12 heures (réglage) ; la séance ne vaut plus si l'accord est retiré ;
 * - le client redemande un lien par son adresse mail : la réponse est la même que l'adresse soit connue ou non, qu'elle
 *   ait un espace ou non, et au-delà de 3 liens par 24 heures (réglage) ;
 * - seule l'empreinte SHA-256 d'un jeton est rangée ; le journal ne porte ni adresse ni jeton, seulement des codes [R13].
 */
import type { Acces } from '../acces/acces.ts';
import type { Viewer } from '../acces/droits.ts';
import { trialChannels } from '../captation/essai.ts';
import { FicheClient } from '../db/fiche-client.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { sha256 } from '../documents/modeles.ts';
import { ControleEnvois } from '../envoi/controle.ts';
import { SqlSendJournal } from '../envoi/journal-envois.ts';
import { DecisionEnvoi } from '../envoi/service.ts';
import { FicheUnique } from '../fiche/fusion.ts';
import { normalizeIdentifier } from '../fiche/normalize.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';

/** Les côtés d'un client dans ses dossiers ; chacun ouvre sa vue de l'espace. */
export const CLIENT_SIDES = ['vendeur', 'bailleur', 'proprietaire', 'acquereur', 'investisseur', 'candidat_locataire'] as const;
export type ClientSide = (typeof CLIENT_SIDES)[number];

/** Ce que les modules disent des dossiers d'une personne : ses côtés, rien d'autre. Faux dans les tests. */
export interface ClientParties {
  sidesOf(networkId: string, personId: string): Promise<readonly ClientSide[]>;
}

/** La finalité de l'accord du client à recevoir le lien de son espace par mail [R03]. */
export const CLIENT_SPACE_PURPOSE = 'espace_client';

export interface EntreeSettings {
  linkMinutes: number;
  sessionHours: number;
  linksPerDay: number;
}

export const DEFAULT_ENTREE_SETTINGS: EntreeSettings = { linkMinutes: 30, sessionHours: 12, linksPerDay: 3 };

export interface EntreeOptions {
  now?: () => Date;
  newId?: () => string;
  newToken?: () => string;
  settings?: Partial<EntreeSettings>;
  /** Le début de l'adresse de l'espace, en https, sans chiffre, terminé par `/`. */
  baseUrl?: string;
}

/** Celui qui lit dans l'espace : un client, par sa séance, jamais une clé d'API. */
export interface ClientViewer {
  kind: 'client';
  networkId: string;
  personId: string;
  sessionId: string;
  sides: readonly ClientSide[];
}

export type EntreeRefusal = { ok: false; rule: 'R16' | 'R160' | 'R03' | string | null; code: string };
export type EntreeResult<T> = { ok: true; value: T } | EntreeRefusal;

/** La réponse à une demande de lien : toujours la même, que l'adresse soit connue ou non [R160]. */
export const LINK_REQUEST_ANSWER = Object.freeze({ status: 'demande_recue' as const });

const TOKEN = /^[a-z]{40}$/;

/** Un jeton : 40 lettres tirées au hasard, sans biais (environ 188 bits). */
export function newSpaceToken(): string {
  const letters = 'abcdefghijklmnopqrstuvwxyz';
  const buf = new Uint8Array(64);
  let out = '';
  while (out.length < 40) {
    crypto.getRandomValues(buf);
    for (const b of buf) if (b < 234 && out.length < 40) out += letters[b % 26];
  }
  return out;
}

/** L'adresse de l'espace : https, sans chiffre (aucun numéro ne s'invente dans un texte [R10]), terminée par `/`. */
export function checkSpaceBase(raw: string): string | null {
  if (typeof raw !== 'string' || /\d/.test(raw) || !raw.endsWith('/')) return null;
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' && url.username === '' && url.password === '' && url.search === '' && url.hash === '' ? url.href : null;
  } catch {
    return null;
  }
}

interface LinkRow {
  id: string;
  network_id: string;
  person_id: string;
  expires_at: string;
}

interface SessionRow {
  id: string;
  network_id: string;
  person_id: string;
  expires_at: string;
}

export class EntreeEspace {
  readonly settings: EntreeSettings;
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly newToken: () => string;
  private readonly baseUrl: string;
  private readonly store: FicheClient;
  private readonly fiche: FicheUnique;
  private readonly envois: ControleEnvois;

  constructor(
    private readonly db: SqlDatabase,
    private readonly journal: JournalStore,
    private readonly parties: ClientParties,
    options: EntreeOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => crypto.randomUUID());
    this.newToken = options.newToken ?? newSpaceToken;
    this.settings = { ...DEFAULT_ENTREE_SETTINGS, ...options.settings };
    const { linkMinutes, sessionHours, linksPerDay } = this.settings;
    if (!Number.isInteger(linkMinutes) || linkMinutes < 5 || linkMinutes > 120) throw new Error('durée du lien invalide');
    if (!Number.isInteger(sessionHours) || sessionHours < 1 || sessionHours > 24) throw new Error('durée de la séance invalide');
    if (!Number.isInteger(linksPerDay) || linksPerDay < 1 || linksPerDay > 10) throw new Error('plafond de liens invalide');
    const base = checkSpaceBase(options.baseUrl ?? 'https://app.aimmo.fr/espace/');
    if (!base) throw new Error('L’adresse de l’espace est en https, sans chiffre, terminée par « / ».');
    this.baseUrl = base;
    this.store = new FicheClient(db, { now: this.now });
    this.fiche = new FicheUnique(db, this.store, { now: this.now });
    // Le lien passe par le contrôle central, avec les seuls canaux du mode essai : rangé, jamais envoyé [R26].
    this.envois = new ControleEnvois(db, this.fiche, new DecisionEnvoi(db, this.store, this.fiche, { now: this.now }), {
      channels: trialChannels(db, journal, this.now),
      journal: new SqlSendJournal(db, undefined, this.now),
      now: this.now,
    });
  }

  /**
   * L'agent de la personne, ou la direction, ouvre son espace : la personne est partie à au moins un dossier, son accord
   * pour recevoir le lien par mail est rangé avec sa preuve [R03], et un premier lien part par le contrôle central.
   */
  async invite(acces: Acces, viewer: Viewer, personId: string, input: { consentProof?: unknown }): Promise<EntreeResult<{ linkId: string; expiresAt: string; mode: 'essai' }>> {
    if (viewer.role !== 'agent' && viewer.role !== 'direction') return { ok: false, rule: 'R16', code: 'role' };
    const read = await this.access(acces, viewer, personId);
    if (!read.ok) return read;
    const root = read.value;
    const proof = input.consentProof;
    if (typeof proof !== 'string' || proof.trim() === '' || proof.length > 300) return { ok: false, rule: 'R03', code: 'bad_consent' };
    const sides = await this.parties.sidesOf(viewer.networkId, root);
    if (sides.length === 0) {
      await this.event('espaces.invitation', `person:${root}`, { status: 'sans_dossier' }, this.actor(viewer));
      return { ok: false, rule: 'R161', code: 'no_file' };
    }
    if (!(await this.consentOf(root))) {
      await this.store.addConsent({ networkId: viewer.networkId, personId: root, purpose: CLIENT_SPACE_PURPOSE, channel: 'email', proof: proof.trim(), givenAt: this.now() });
    }
    const sent = await this.issue(viewer.networkId, root, 'invitation', this.actor(viewer));
    if (!sent.ok) return sent;
    await this.event('espaces.invitation', `person:${root}`, { status: 'envoye', link: sent.value.linkId, mode: 'essai' }, this.actor(viewer));
    return sent;
  }

  /**
   * Le client redemande un lien par son adresse mail. La réponse est toujours la même [R160] : rien ne dit si l'adresse
   * est connue, si elle a un espace, ni si le plafond est atteint. Le motif ne va qu'au journal, en code.
   */
  async requestLink(networkId: string, email: unknown): Promise<typeof LINK_REQUEST_ANSWER> {
    const silent = async (status: string, subject = 'espaces'): Promise<typeof LINK_REQUEST_ANSWER> => {
      await this.event('espaces.demande', subject, { status }, 'client');
      return LINK_REQUEST_ANSWER;
    };
    if (typeof email !== 'string' || email.length > 254) return silent('illisible');
    const persons = await this.fiche.findByIdentifier(networkId, 'email', email);
    // Deux fiches pour une même adresse : on n'en choisit aucune au hasard.
    if (persons.length !== 1) return silent(persons.length === 0 ? 'inconnu' : 'ambigu');
    const root = persons[0]!.id;
    const subject = `person:${root}`;
    if (!(await this.consentOf(root))) return silent('sans_accord', subject);
    if ((await this.parties.sidesOf(networkId, root)).length === 0) return silent('sans_dossier', subject);
    const since = new Date(this.now().getTime() - 86_400_000).toISOString();
    const count = await this.db.first<{ n: number }>('SELECT COUNT(*) AS n FROM client_space_links WHERE network_id = ? AND person_id = ? AND created_at > ?', [networkId, root, since]);
    if ((count?.n ?? 0) >= this.settings.linksPerDay) return silent('plafond', subject);
    // Le lien part à l'adresse donnée, qui est une adresse de la fiche, pas à une autre de ses adresses.
    const sent = await this.issue(networkId, root, 'demande', 'client', normalizeIdentifier('email', email));
    return silent(sent.ok ? 'envoye' : 'refuse', subject);
  }

  /** Le client ouvre son lien : une seule fois, avant son expiration ; il reçoit une séance. */
  async open(token: unknown): Promise<EntreeResult<{ sessionToken: string; expiresAt: string; sides: readonly ClientSide[] }>> {
    if (typeof token !== 'string' || !TOKEN.test(token)) return this.openRefused('inconnu');
    const link = await this.db.first<LinkRow>('SELECT id, network_id, person_id, expires_at FROM client_space_links WHERE token_hash = ?', [await sha256(token)]);
    if (!link) return this.openRefused('inconnu');
    const subject = `person:${link.person_id}`;
    if (await this.db.first('SELECT link_id FROM client_space_link_revocations WHERE link_id = ?', [link.id])) return this.openRefused('revoque', subject, link.id);
    const at = this.now();
    if (at.toISOString() >= link.expires_at) return this.openRefused('expire', subject, link.id);
    if (!(await this.consentOf(link.person_id))) return this.openRefused('sans_accord', subject, link.id);
    const sides = await this.parties.sidesOf(link.network_id, link.person_id);
    if (sides.length === 0) return this.openRefused('sans_dossier', subject, link.id);
    // La clé primaire tranche : de deux ouvertures en même temps, une seule passe [R18].
    const { changes } = await this.db.run('INSERT INTO client_space_link_uses (link_id, used_at) VALUES (?, ?) ON CONFLICT DO NOTHING', [link.id, at.toISOString()]);
    if (changes !== 1) return this.openRefused('deja_ouvert', subject, link.id);
    const sessionToken = this.newToken();
    const id = this.newId();
    const expiresAt = new Date(at.getTime() + this.settings.sessionHours * 3_600_000).toISOString();
    await this.db.run(
      'INSERT INTO client_space_sessions (id, network_id, person_id, link_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [id, link.network_id, link.person_id, link.id, await sha256(sessionToken), expiresAt, at.toISOString()],
    );
    await this.event('espaces.ouverture', subject, { status: 'ouvert', link: link.id, session: id }, 'client');
    return { ok: true, value: { sessionToken, expiresAt, sides } };
  }

  /** La séance d'un client, ou `null` : inconnue, fermée, expirée, accord retiré, ou plus aucun dossier. */
  async session(sessionToken: unknown): Promise<ClientViewer | null> {
    if (typeof sessionToken !== 'string' || !TOKEN.test(sessionToken)) return null;
    const row = await this.db.first<SessionRow>('SELECT id, network_id, person_id, expires_at FROM client_space_sessions WHERE token_hash = ?', [await sha256(sessionToken)]);
    if (!row) return null;
    if (this.now().toISOString() >= row.expires_at) return null;
    if (await this.db.first('SELECT session_id FROM client_space_session_closures WHERE session_id = ?', [row.id])) return null;
    if (!(await this.consentOf(row.person_id))) return null;
    const sides = await this.parties.sidesOf(row.network_id, row.person_id);
    if (sides.length === 0) return null;
    return { kind: 'client', networkId: row.network_id, personId: row.person_id, sessionId: row.id, sides };
  }

  /** Le client ferme sa séance ; une séance inconnue ou déjà fermée ne fait rien. */
  async close(sessionToken: unknown): Promise<void> {
    if (typeof sessionToken !== 'string' || !TOKEN.test(sessionToken)) return;
    const row = await this.db.first<{ id: string; person_id: string }>('SELECT id, person_id FROM client_space_sessions WHERE token_hash = ?', [await sha256(sessionToken)]);
    if (!row) return;
    const { changes } = await this.db.run('INSERT INTO client_space_session_closures (session_id, closed_at) VALUES (?, ?) ON CONFLICT DO NOTHING', [row.id, this.now().toISOString()]);
    if (changes === 1) await this.event('espaces.fermeture', `person:${row.person_id}`, { session: row.id }, 'client');
  }

  /** Range un lien, puis le fait partir par le contrôle central ; refusé, il est révoqué aussitôt. */
  private async issue(networkId: string, personId: string, origin: 'invitation' | 'demande', by: string, to: string | null = null): Promise<EntreeResult<{ linkId: string; expiresAt: string; mode: 'essai' }>> {
    const id = this.newId();
    const token = this.newToken();
    const at = this.now();
    const expiresAt = new Date(at.getTime() + this.settings.linkMinutes * 60_000).toISOString();
    await this.db.run(
      'INSERT INTO client_space_links (id, network_id, person_id, token_hash, expires_at, origin, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [id, networkId, personId, await sha256(token), expiresAt, origin, by, at.toISOString()],
    );
    const person = await this.db.first<{ first_name: string | null; agent_id: string | null }>('SELECT first_name, agent_id FROM persons WHERE id = ?', [personId]);
    const minutes = this.settings.linkMinutes;
    const sent = await this.envois.send({
      networkId,
      agentId: person?.agent_id ?? null,
      personId,
      channel: 'email',
      kind: 'alert',
      purpose: CLIENT_SPACE_PURPOSE,
      subject: `espace_client:${id}`,
      fallbackTexts: [
        `${person?.first_name ? `Bonjour ${person.first_name},\n\n` : 'Bonjour,\n\n'}Voici le lien de votre espace, pour suivre votre dossier : ${this.baseUrl}${token}\n\nCe lien vous est personnel. Il est valable ${minutes} minutes et ne sert qu’une fois. Si vous n’avez rien demandé, ne faites rien.`,
      ],
      figures: [minutes],
      to,
    });
    if (sent.status !== 'sent') {
      await this.db.run('INSERT INTO client_space_link_revocations (link_id, code, revoked_at) VALUES (?, ?, ?)', [id, 'non_remis', this.now().toISOString()]);
      await this.event('espaces.lien', `person:${personId}`, { status: 'non_remis', link: id, rule: sent.rule }, by);
      return { ok: false, rule: sent.rule, code: 'send_refused' };
    }
    return { ok: true, value: { linkId: id, expiresAt, mode: 'essai' } };
  }

  /** La fiche gardée de la personne, lue sous les droits de celui qui demande [R16]. */
  private async access(acces: Acces, viewer: Viewer, personId: string): Promise<EntreeResult<string>> {
    if (typeof personId !== 'string' || personId === '') return { ok: false, rule: null, code: 'person' };
    const read = await acces.readFiche(viewer, personId);
    if (!read.ok) return { ok: false, rule: 'R16', code: read.code };
    return { ok: true, value: read.value.person.id };
  }

  /** Un accord du client pour recevoir le lien de son espace par mail, non retiré [R03]. */
  private async consentOf(personId: string): Promise<boolean> {
    const row = await this.db.first(
      'SELECT id FROM consents WHERE person_id = ? AND purpose = ? AND channel = ? AND withdrawn_at IS NULL',
      [personId, CLIENT_SPACE_PURPOSE, 'email'],
    );
    return row !== null;
  }

  private async openRefused(status: string, subject = 'espaces', link?: string): Promise<EntreeRefusal> {
    await this.event('espaces.ouverture', subject, { status, ...(link ? { link } : {}) }, 'client');
    return { ok: false, rule: 'R160', code: status };
  }

  private async event(type: string, subject: string, data: Record<string, unknown>, actor: string): Promise<void> {
    await appendEvent(this.journal, { type, actor, subject, data: { rule: 'R160', ...data } }, this.now);
  }

  private actor(viewer: Viewer): string {
    return `${viewer.role}:${viewer.userId}`;
  }
}
