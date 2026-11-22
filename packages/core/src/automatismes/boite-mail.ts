/**
 * Tri de la boîte mail de l'agent (HX26).
 *
 * Chaque mail lu dans la boîte Gmail ou Outlook d'un agent est rattaché à la fiche de son expéditeur, par son adresse
 * normalisée, seulement si l'agent a le droit de voir cette fiche [R16, R408] ; une adresse inconnue ne crée jamais de
 * fiche, et plusieurs fiches possibles laissent le choix à l'agent. Le dossier est le seul projet ouvert de la fiche.
 * Les pièces jointes utiles, PDF, JPEG ou PNG confirmés par leurs premiers octets, sont rangées dans ce dossier une seule
 * fois par leur empreinte ; une pièce d'identité, un RIB ou un document fiscal ne sont jamais rangés [R15, R410].
 * La réponse préparée n'est faite que de phrases fixes, sans IA, et chaque fait qu'elle reprend cite la ligne du
 * dossier d'où il vient [R411]. Rien ne part sans la validation de l'agent de la boîte, une seule fois, par le contrôle
 * central des envois, en mode essai [R409, R26]. Au journal : ni adresse, ni objet, ni nom de fichier [R13]. Rien ne
 * s'efface [R17].
 *
 * Un mail envoyé par l'agent lui-même depuis sa boîte (RC28) entre aussi dans la fiche, comme un message sortant de
 * l'agent, dans le fil de son mail : rattaché par les adresses de ses destinataires, à une seule fiche que l'agent peut
 * voir, sinon rien n'en est gardé [R408]. Ses mots ne valent jamais demande d'arrêt de la personne, aucune réponse
 * n'est préparée, et la réponse déjà préparée dans ce fil ne part plus : l'agent y a répondu [R21, R409]. Ses pièces
 * suivent les mêmes règles que celles d'un mail reçu [R410].
 *
 * Les vrais accès à Gmail, Outlook et Drive attendent un humain (H05, H55) : d'ici là, `MailboxProvider` et le stockage
 * des pièces sont des interfaces, avec des faux dans les tests.
 */
import { Acces } from '../acces/acces.ts';
import type { Viewer } from '../acces/droits.ts';
import { trialChannels } from '../captation/essai.ts';
import { FicheClient } from '../db/fiche-client.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { localTime } from '../envoi/horaires.ts';
import { SqlSendJournal } from '../envoi/journal-envois.ts';
import { ControleEnvois } from '../envoi/controle.ts';
import { DecisionEnvoi, classifyReceived } from '../envoi/service.ts';
import { maskIban, plain } from '../envoi/texte.ts';
import { FicheUnique } from '../fiche/fusion.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import { matchesType, sha256Hex } from '../location/depot.ts';
import { CLOSED_PROJECT_STAGES } from './prochaine-action.ts';
import type { ScenarioResult } from './scenarios.ts';

const TIME_ZONE = 'Europe/Paris';
export const MAIL_PROVIDERS = ['gmail', 'outlook'] as const;
export type MailProvider = (typeof MAIL_PROVIDERS)[number];

/** Les seuls types rangés, ceux des pièces du dossier. */
export const MAIL_ATTACHMENT_TYPES: Readonly<Record<string, string>> = { 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png' };
export const MAIL_ATTACHMENT_MAX_BYTES = 20 * 1024 * 1024;
/** Une image plus petite est un logo ou une signature, jamais une pièce utile. */
export const MAIL_SIGNATURE_IMAGE_MAX_BYTES = 20 * 1024;
const MAX_BODY = 20_000;
const MAX_ATTACHMENTS = 20;
/** Au-delà, un mail envoyé n'est pas rattaché : trop de destinataires pour dire à qui il parle. */
export const MAIL_MAX_RECIPIENTS = 50;
const STALE_CLAIM_MS = 10 * 60_000;

/**
 * Ce qui n'est jamais rangé depuis un mail, reconnu au nom du fichier : identité, banque, impôts, revenus [R15].
 * Ces pièces vivent dans le coffre de la conformité, déposées par l'agent, ou nulle part.
 */
const FORBIDDEN_NAME_WORDS: readonly string[][] = [
  ['identite'],
  ['identity'],
  ['cni'],
  ['passeport'],
  ['passport'],
  ['permis', 'conduire'],
  ['permis', 'de', 'conduire'],
  ['titre', 'sejour'],
  ['titre', 'de', 'sejour'],
  ['rib'],
  ['iban'],
  ['releve'],
  ['bancaire'],
  ['banque'],
  ['bank'],
  ['imposition'],
  ['impot'],
  ['fiscal'],
  ['fiscale'],
  ['tax'],
  ['salaire'],
  ['salary'],
  ['paie'],
  ['payslip'],
  ['revenu'],
  ['domicile'],
  ['blanchiment'],
];

export interface MailAttachmentIn {
  contentType: string;
  /** Le nom donné par l'expéditeur : lu pour écarter une pièce interdite, jamais gardé [R13, R15]. */
  fileName: string;
  bytes: Uint8Array;
}

export interface MailIn {
  provider: MailProvider;
  /** La clé du mail chez le fournisseur. */
  externalId: string;
  /** Le fil de discussion chez le fournisseur : la conversation de la réponse. */
  threadId: string;
  /** L'expéditeur d'un mail reçu ; ignoré pour un mail envoyé par l'agent. */
  from: string;
  /** `out` : envoyé par l'agent lui-même depuis sa boîte (RC28). Absent : reçu. */
  direction?: 'in' | 'out';
  /** Les destinataires d'un mail envoyé (à, copie), lus pour trouver la fiche, jamais gardés [R13]. */
  to?: readonly string[];
  body: string;
  receivedAt: Date;
  attachments: readonly MailAttachmentIn[];
}

/**
 * La boîte d'un agent chez Gmail ou Outlook (H05, H55) : les mails de la boîte depuis une date, ceux que l'agent a
 * envoyés lui-même compris, marqués `direction: 'out'`, dans un seul ordre de dates.
 */
export interface MailboxProvider {
  provider: MailProvider;
  /**
   * `skip` (AU043) : les clés des mails déjà triés autour de `since`, que la boîte relirait sinon à chaque lecture ; un
   * fournisseur réel ne les compte pas dans son lot, pour qu'un lot plein de mails de la même heure avance toujours [R18].
   */
  receivedSince(agentId: string, since: Date | null, skip?: ReadonlySet<string>): Promise<MailIn[]>;
}

/** Le stockage des pièces des dossiers (R2, ou Drive une fois relié). */
export interface DossierFileStore {
  put(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
}

export type AttachmentOutcome = 'range' | 'deja_range' | 'en_attente' | 'inutile' | 'interdit' | 'type_refuse' | 'trop';
export type MailOutcome = 'rattache' | 'inconnu' | 'ambigu';

export interface DraftSource {
  table: 'persons' | 'agents' | 'appointments' | 'mailbox_attachments';
  id: string;
  field: string;
}

export interface DraftSentence {
  text: string;
  /** Vide seulement pour une formule fixe qui ne reprend rien du dossier. */
  sources: DraftSource[];
}

export interface SortedMail {
  mailId: string;
  /** null : déjà trié par une autre lecture [R18]. */
  outcome: MailOutcome | null;
  personId: string | null;
  projectId: string | null;
  attachments: AttachmentOutcome[];
  draftId: string | null;
}

/** Un mail dont des pièces attendent le choix du dossier par l'agent [R410]. */
export interface WaitingMail {
  mailId: string;
  provider: MailProvider;
  /** La clé du mail chez le fournisseur, pour le relire. */
  externalId: string;
  personId: string;
  receivedAt: string;
  /** Le nombre de pièces en attente. */
  waiting: number;
  /** Les dossiers ouverts de la fiche, fiches réunies comprises : les seuls choix possibles. */
  projects: { id: string; kind: string; stage: string }[];
}

export interface FiledWaiting {
  mailId: string;
  projectId: string;
  range: number;
  dejaRange: number;
  /** Les pièces encore en attente : absentes du mail relu ou plus utiles. */
  restent: number;
}

export interface BoiteMailOptions {
  now?: () => Date;
  newId?: () => string;
}

function validRecipients(to: unknown): to is readonly string[] {
  return Array.isArray(to) && to.length > 0 && to.every((a) => typeof a === 'string' && a.length > 0 && a.length <= 320);
}

const marks = (n: number): string => Array.from({ length: n }, () => '?').join(', ');
const two = (n: number): string => String(n).padStart(2, '0');

const singular = (w: string): string => (w.length > 3 ? w.replace(/aux$/, 'al').replace(/s$/, '') : w);

/** Les mots du nom d'un fichier, sans accent ni extension, au singulier (« revenus », « fiscaux »). */
function nameWords(fileName: string): string[] {
  return plain(fileName.replace(/\.[a-z0-9]{1,5}$/i, ''))
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .map(singular);
}

/** Le nom du fichier dit-il une pièce qui n'est jamais rangée [R15] ? Les mots se cherchent entiers, dans l'ordre. */
export function forbiddenAttachment(fileName: string): boolean {
  const words = nameWords(fileName);
  return FORBIDDEN_NAME_WORDS.some((seq) => {
    for (let i = 0; i + seq.length <= words.length; i += 1) {
      if (seq.every((w, k) => words[i + k] === singular(w))) return true;
    }
    return false;
  });
}

/** Ce que le tri fait d'une pièce jointe, avant tout dossier : utile, inutile, interdite ou refusée [R410, R15]. */
export function judgeAttachment(a: MailAttachmentIn): { ok: true; type: string; ext: string } | { ok: false; outcome: 'inutile' | 'interdit' | 'type_refuse' } {
  if (forbiddenAttachment(a.fileName)) return { ok: false, outcome: 'interdit' };
  const type = a.contentType.split(';')[0]!.trim().toLowerCase();
  const ext = Object.prototype.hasOwnProperty.call(MAIL_ATTACHMENT_TYPES, type) ? MAIL_ATTACHMENT_TYPES[type] : undefined;
  if (!ext || a.bytes.length === 0 || a.bytes.length > MAIL_ATTACHMENT_MAX_BYTES || !matchesType(type, a.bytes)) return { ok: false, outcome: 'type_refuse' };
  if (type !== 'application/pdf' && a.bytes.length < MAIL_SIGNATURE_IMAGE_MAX_BYTES) return { ok: false, outcome: 'inutile' };
  return { ok: true, type, ext };
}

export class BoiteMail {
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly store: FicheClient;
  private readonly fiche: FicheUnique;
  private readonly acces: Acces;
  private readonly decisions: DecisionEnvoi;
  private readonly controle: ControleEnvois;

  constructor(
    private readonly db: SqlDatabase,
    private readonly journal: JournalStore,
    private readonly files: DossierFileStore,
    options: BoiteMailOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => crypto.randomUUID());
    this.store = new FicheClient(db, { now: this.now });
    this.fiche = new FicheUnique(db, this.store, { now: this.now });
    this.acces = new Acces(db, this.store, this.fiche, journal, { now: this.now });
    this.decisions = new DecisionEnvoi(db, this.store, this.fiche, { now: this.now });
    // Seuls les canaux du mode essai : aucun vrai canal ne peut être passé de l'extérieur [R26].
    this.controle = new ControleEnvois(db, this.fiche, this.decisions, { channels: trialChannels(db, journal, this.now), journal: new SqlSendJournal(db, undefined, this.now), now: this.now });
  }

  private actor(viewer: Viewer): string {
    return `${String(viewer.role)}:${viewer.userId}`;
  }

  private async refuse<T>(viewer: Viewer, code: string, gesture: string, rule = 'R16'): Promise<ScenarioResult<T>> {
    await appendEvent(this.journal, { type: 'acces.refuse', actor: this.actor(viewer), subject: null, data: { rule, role: String(viewer.role), kind: 'mailbox', code, gesture } }, this.now);
    return { ok: false, rule, code };
  }

  /** La boîte est celle d'un agent du réseau, et lui seul la trie [R16]. */
  private async ownAgent(viewer: Viewer): Promise<boolean> {
    if (viewer.role !== 'agent') return false;
    return (await this.db.first('SELECT 1 FROM agents WHERE id = ? AND network_id = ?', [viewer.userId, viewer.networkId])) !== null;
  }

  /**
   * Lit les mails reçus depuis le dernier tri de cette boîte, et les trie un par un, les plus anciens d'abord. Le curseur
   * ne dépasse jamais un tri coupé : la lecture reprend au plus ancien mail pas encore fini [R18]. Un mail illisible
   * arrête la lecture avant qu'un mail plus récent ne fasse avancer le curseur au-delà de lui.
   */
  async sync(viewer: Viewer, provider: MailboxProvider): Promise<ScenarioResult<SortedMail[]>> {
    if (!(await this.ownAgent(viewer))) return this.refuse(viewer, 'not_mailbox_agent', 'sync');
    const scope = [viewer.networkId, viewer.userId, provider.provider];
    const unfinished = await this.db.first<{ at: string | null }>("SELECT MIN(received_at) AS at FROM mailbox_mails WHERE network_id = ? AND agent_id = ? AND provider = ? AND status IN ('en_cours', 'a_reprendre')", scope);
    const last = unfinished?.at ? unfinished : await this.db.first<{ at: string | null }>('SELECT MAX(received_at) AS at FROM mailbox_mails WHERE network_id = ? AND agent_id = ? AND provider = ?', scope);
    const since = last?.at ? new Date(last.at) : null;
    // Les mails déjà finis des deux secondes avant le curseur et après : la boîte les rendrait encore (AU043, R683).
    const done = since
      ? await this.db.all<{ external_id: string }>(
          "SELECT external_id FROM mailbox_mails WHERE network_id = ? AND agent_id = ? AND provider = ? AND received_at >= ? AND status NOT IN ('en_cours', 'a_reprendre') ORDER BY received_at LIMIT 5000",
          [...scope, new Date(since.getTime() - 2000).toISOString()],
        )
      : [];
    const mails = await provider.receivedSince(viewer.userId, since, new Set(done.map((d) => d.external_id)));
    const out: SortedMail[] = [];
    for (const mail of [...mails].sort((x, y) => x.receivedAt.getTime() - y.receivedAt.getTime())) {
      if (mail.provider !== provider.provider) continue;
      const r = await this.sort(viewer, mail);
      if (!r.ok) return r;
      out.push(r.value);
    }
    return { ok: true, value: out };
  }

  /** Trie un mail : fiche, dossier, pièces jointes, réponse préparée. N'envoie jamais rien [R409]. */
  async sort(viewer: Viewer, mail: MailIn): Promise<ScenarioResult<SortedMail>> {
    if (!(await this.ownAgent(viewer))) return this.refuse(viewer, 'not_mailbox_agent', 'sort');
    if (!(MAIL_PROVIDERS as readonly string[]).includes(mail.provider)) return { ok: false, rule: 'R408', code: 'bad_provider' };
    if (typeof mail.externalId !== 'string' || mail.externalId.length === 0 || mail.externalId.length > 200) return { ok: false, rule: 'R408', code: 'bad_mail' };
    if (typeof mail.threadId !== 'string' || mail.threadId.length === 0 || mail.threadId.length > 200) return { ok: false, rule: 'R408', code: 'bad_mail' };
    if (!(mail.receivedAt instanceof Date) || Number.isNaN(mail.receivedAt.getTime())) return { ok: false, rule: 'R408', code: 'bad_mail' };
    if (!Array.isArray(mail.attachments)) return { ok: false, rule: 'R408', code: 'bad_mail' };
    if (mail.direction !== undefined && mail.direction !== 'in' && mail.direction !== 'out') return { ok: false, rule: 'R408', code: 'bad_mail' };
    if (mail.direction === 'out' && !validRecipients(mail.to)) return { ok: false, rule: 'R408', code: 'bad_mail' };
    const networkId = viewer.networkId;
    const agentId = viewer.userId;
    const now = this.now();

    // Prendre le mail : deux lectures du même mail n'en trient qu'une [R18]. Un tri coupé par une panne, ou abandonné
    // depuis plus de 10 minutes, se reprend sur la même ligne, sans rien doubler.
    let mailId = this.newId();
    const taken = await this.db.run(
      "INSERT OR IGNORE INTO mailbox_mails (id, network_id, agent_id, provider, external_id, status, claimed_at, received_at, created_at) VALUES (?, ?, ?, ?, ?, 'en_cours', ?, ?, ?)",
      [mailId, networkId, agentId, mail.provider, mail.externalId, now.toISOString(), mail.receivedAt.toISOString(), now.toISOString()],
    );
    if (taken.changes !== 1) {
      const existing = await this.db.first<{ id: string; status: string; claimed_at: string }>('SELECT id, status, claimed_at FROM mailbox_mails WHERE network_id = ? AND agent_id = ? AND provider = ? AND external_id = ?', [networkId, agentId, mail.provider, mail.externalId]);
      const resumable = existing && (existing.status === 'a_reprendre' || (existing.status === 'en_cours' && Date.parse(existing.claimed_at) < now.getTime() - STALE_CLAIM_MS));
      const retaken = resumable
        ? await this.db.run("UPDATE mailbox_mails SET status = 'en_cours', claimed_at = ? WHERE id = ? AND status = ? AND claimed_at = ?", [now.toISOString(), existing.id, existing.status, existing.claimed_at])
        : { changes: 0 };
      if (retaken.changes !== 1) return { ok: true, value: { mailId: existing?.id ?? '', outcome: null, personId: null, projectId: null, attachments: [], draftId: null } };
      mailId = existing!.id;
    }
    try {
      return { ok: true, value: await this.sortClaimed(viewer, mail, mailId, now) };
    } catch (error) {
      // Une panne rend le mail à la lecture suivante, jamais perdu ni tenu pour trié.
      await this.db.run("UPDATE mailbox_mails SET status = 'a_reprendre' WHERE id = ? AND status = 'en_cours'", [mailId]);
      throw error;
    }
  }

  private async sortClaimed(viewer: Viewer, mail: MailIn, mailId: string, now: Date): Promise<SortedMail> {
    const networkId = viewer.networkId;
    const agentId = viewer.userId;
    const sent = mail.direction === 'out';
    const sens = sent ? 'envoye' : 'recu';
    // 1. La fiche : l'adresse normalisée de l'expéditeur, ou pour un mail de l'agent celles de ses destinataires, parmi
    // les seules fiches que l'agent peut voir [R16, R408]. Trop de destinataires : le mail ne dit pas à qui il parle.
    const addresses = sent ? [...new Set(mail.to!)] : [mail.from];
    const visible: string[] = [];
    if (addresses.length <= MAIL_MAX_RECIPIENTS) {
      for (const address of addresses) {
        for (const p of await this.fiche.findByIdentifier(networkId, 'email', address)) {
          const read = await this.acces.readFiche(viewer, p.id);
          if (read.ok) visible.push(read.value.person.id);
        }
      }
    }
    const roots = [...new Set(visible)];
    if (roots.length !== 1) {
      const outcome: MailOutcome = roots.length === 0 ? 'inconnu' : 'ambigu';
      await this.db.run('UPDATE mailbox_mails SET status = ?, done_at = ? WHERE id = ?', [outcome, now.toISOString(), mailId]);
      await appendEvent(this.journal, { type: 'boite.mail.trie', actor: this.actor(viewer), subject: null, data: { rule: 'R408', outcome, sens, attachments: mail.attachments.length } }, this.now);
      return { mailId, outcome, personId: null, projectId: null, attachments: [], draftId: null };
    }
    const personId = roots[0]!;
    const members = await this.fiche.membersOf(personId);

    // 2. Une demande d'arrêt, un refus ou « vendu » valent dès la réception, comme pour tout message [R04, R02], avant
    // tout le reste et quoi que portent les pièces jointes : lus dans le texte entier, jamais dans la seule partie gardée.
    // Les mots de l'agent ne sont jamais ceux de la personne : son mail envoyé n'exclut personne.
    const exclusion = sent ? null : classifyReceived(String(mail.body ?? ''));
    if (exclusion) {
      for (const id of members) {
        const m = await this.store.getPerson(id);
        await this.decisions.recordExclusion({ networkId, agentId: m?.agent_id ?? null, personId: id, at: mail.receivedAt, reason: exclusion });
      }
    }

    // 3. Le dossier : le seul projet ouvert de la fiche, fiches réunies comprises ; sinon l'agent choisit.
    const open = await this.openProjects(networkId, members);
    const projectId = open.length === 1 ? open[0]!.id : null;

    // 4. Le mail entre dans la fiche comme un message reçu, ou comme un message sortant de l'agent s'il l'a envoyé, IBAN masqué [R15], dans la conversation de son fil ; une
    // seule fois, même repris après une panne.
    const conversationId = `email:${mail.provider}:${mail.threadId}`;
    let messageId = (await this.db.first<{ message_id: string | null }>('SELECT message_id FROM mailbox_mails WHERE id = ?', [mailId]))?.message_id ?? null;
    const body = maskIban(String(mail.body ?? '').slice(0, MAX_BODY)).trim() || '(mail sans texte)';
    if (messageId === null) {
      // Coupé entre le message et son lien : le même texte du même fil, à la même heure, rangé dans la fiche et lié à
      // aucun autre mail de la boîte, est ce message-là. Un autre mail du même fil à la même heure n'est jamais pris pour lui.
      const found = await this.db.first<{ id: string }>(
        `SELECT id FROM messages m WHERE network_id = ? AND person_id IN (${marks(members.length)}) AND conversation_id = ? AND direction = ? AND author_kind = ? AND channel = 'email' AND occurred_at = ? AND body = ?
           AND NOT EXISTS (SELECT 1 FROM mailbox_mails b WHERE b.message_id = m.id) ORDER BY rowid LIMIT 1`,
        [networkId, ...members, conversationId, sent ? 'out' : 'in', sent ? 'agent' : 'person', mail.receivedAt.toISOString(), body],
      );
      if (found) {
        messageId = found.id;
        await this.db.run('UPDATE mailbox_mails SET person_id = ?, project_id = ?, message_id = ? WHERE id = ?', [personId, projectId, messageId, mailId]);
      }
    }
    if (messageId === null) {
      const person = await this.store.getPerson(personId);
      const message = await this.store.recordMessage({ networkId, agentId: person?.agent_id ?? null, personId, projectId, conversationId, channel: 'email', direction: sent ? 'out' : 'in', authorKind: sent ? 'agent' : 'person', body, occurredAt: mail.receivedAt });
      messageId = message.id;
      await this.db.run('UPDATE mailbox_mails SET person_id = ?, project_id = ?, message_id = ? WHERE id = ?', [personId, projectId, messageId, mailId]);
    }

    // 5. Les pièces jointes, une seule fois par empreinte dans le dossier [R410].
    const outcomes: AttachmentOutcome[] = [];
    const kept: string[] = [];
    const seen = new Set<string>();
    for (const [position, a] of mail.attachments.entries()) {
      const sha = await sha256Hex(a.bytes);
      if (seen.has(sha)) continue;
      seen.add(sha);
      let outcome: AttachmentOutcome;
      let attachmentId: string | null = null;
      // La limite tient à la place de la pièce dans le mail, doublons compris.
      const judged = position >= MAX_ATTACHMENTS ? ({ ok: false, outcome: 'trop' } as const) : judgeAttachment(a);
      if (!judged.ok) outcome = judged.outcome;
      else if (projectId === null) outcome = 'en_attente';
      else {
        const stored = await this.storeAttachment(networkId, projectId, mailId, sha, judged, a.bytes, now);
        outcome = stored.outcome;
        attachmentId = stored.attachmentId;
      }
      await this.db.run('INSERT OR IGNORE INTO mailbox_attachment_links (mail_id, sha256, outcome, attachment_id, created_at) VALUES (?, ?, ?, ?, ?)', [mailId, sha, outcome, attachmentId, now.toISOString()]);
      if (attachmentId) kept.push(attachmentId);
      outcomes.push(outcome);
    }

    // 6. La réponse préparée, sauf à un mail de l'agent lui-même, ou si la personne a demandé l'arrêt ou est exclue :
    // elle attend la validation [R409].
    let draftId: string | null = null;
    const blocked = sent ? null : await this.decisions.decide(personId, { channel: 'email', kind: 'reply', conversationId, at: now });
    if (blocked && !exclusion && !(blocked.allowed === false && (blocked.rule === 'R02' || blocked.rule === 'R04'))) {
      const draft = await this.compose(agentId, members, personId, kept, now);
      await this.db.run(
        "INSERT OR IGNORE INTO mailbox_drafts (id, network_id, mail_id, agent_id, person_id, body, sentences, figures, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'prepare', ?)",
        [this.newId(), networkId, mailId, agentId, personId, draft.sentences.map((s) => s.text).join('\n\n'), JSON.stringify(draft.sentences), JSON.stringify(draft.figures), now.toISOString()],
      );
      draftId = (await this.db.first<{ id: string }>('SELECT id FROM mailbox_drafts WHERE mail_id = ?', [mailId]))?.id ?? null;
    }

    await this.db.run("UPDATE mailbox_mails SET status = 'rattache', done_at = ? WHERE id = ?", [now.toISOString(), mailId]);
    const count = (o: AttachmentOutcome) => outcomes.filter((x) => x === o).length;
    await appendEvent(
      this.journal,
      {
        type: 'boite.mail.trie',
        actor: this.actor(viewer),
        subject: `person:${personId}`,
        data: { rule: 'R408', outcome: 'rattache', sens, dossier: projectId !== null, range: count('range'), dejaRange: count('deja_range'), enAttente: count('en_attente'), interdit: count('interdit'), inutile: count('inutile'), refuse: count('type_refuse'), trop: count('trop'), reponsePreparee: draftId !== null },
      },
      this.now,
    );
    return { mailId, outcome: 'rattache', personId, projectId, attachments: outcomes, draftId };
  }

  /**
   * Range une pièce jugée utile dans un dossier, une seule fois par empreinte [R410] : rangée par ce mail-ci, au premier
   * essai ou à la reprise, elle est « rangée » ; déjà là par un autre mail, « déjà rangée ».
   */
  private async storeAttachment(networkId: string, projectId: string, mailId: string, sha: string, judged: { type: string; ext: string }, bytes: Uint8Array, now: Date): Promise<{ outcome: 'range' | 'deja_range'; attachmentId: string }> {
    const lookup = () => this.db.first<{ id: string; first_mail_id: string }>('SELECT id, first_mail_id FROM mailbox_attachments WHERE network_id = ? AND project_id = ? AND sha256 = ?', [networkId, projectId, sha]);
    let row = await lookup();
    if (!row) {
      const id = this.newId();
      const ref = `boite/${projectId}/${sha}.${judged.ext}`;
      await this.files.put(ref, bytes, judged.type);
      // Deux tris en même temps du même fichier : la contrainte d'unicité n'en garde qu'un [R18, R410].
      await this.db.run(
        'INSERT OR IGNORE INTO mailbox_attachments (id, network_id, project_id, sha256, ref, content_type, size, first_mail_id, stored_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [id, networkId, projectId, sha, ref, judged.type, bytes.length, mailId, now.toISOString()],
      );
      row = await lookup();
    }
    if (!row) throw new Error('pièce jointe introuvable après son rangement');
    return { outcome: row.first_mail_id === mailId ? 'range' : 'deja_range', attachmentId: row.id };
  }

  /** Les dossiers ouverts d'une fiche, fiches réunies comprises, les plus anciens d'abord. */
  private async openProjects(networkId: string, members: readonly string[]): Promise<{ id: string; kind: string; stage: string }[]> {
    const rows = await this.db.all<{ id: string; kind: string; stage: string }>(`SELECT id, kind, stage FROM projects WHERE network_id = ? AND person_id IN (${marks(members.length)}) ORDER BY created_at, id`, [networkId, ...members]);
    return rows.filter((p) => !CLOSED_PROJECT_STAGES.includes(p.stage));
  }

  /**
   * Les mails de la boîte dont des pièces attendent que l'agent choisisse le dossier [R410] : la fiche doit être encore
   * à lui [R16], et seuls ses dossiers ouverts sont proposés. Ni adresse, ni nom de fichier : la clé du mail chez le
   * fournisseur sert à le relire.
   */
  async waiting(viewer: Viewer): Promise<ScenarioResult<WaitingMail[]>> {
    if (!(await this.ownAgent(viewer))) return this.refuse(viewer, 'not_mailbox_agent', 'waiting', 'R410');
    const rows = await this.db.all<{ id: string; provider: MailProvider; external_id: string; person_id: string; received_at: string; waiting: number }>(
      `SELECT b.id, b.provider, b.external_id, b.person_id, b.received_at, COUNT(l.sha256) AS waiting
         FROM mailbox_mails b JOIN mailbox_attachment_links l ON l.mail_id = b.id AND l.outcome = 'en_attente'
        WHERE b.network_id = ? AND b.agent_id = ? AND b.status = 'rattache' AND b.person_id IS NOT NULL
        GROUP BY b.id ORDER BY b.received_at, b.id`,
      [viewer.networkId, viewer.userId],
    );
    const out: WaitingMail[] = [];
    for (const r of rows) {
      const read = await this.acces.readFiche(viewer, r.person_id);
      if (!read.ok) continue;
      const personId = read.value.person.id;
      const members = await this.fiche.membersOf(personId);
      const projects = await this.openProjects(viewer.networkId, members);
      out.push({ mailId: r.id, provider: r.provider, externalId: r.external_id, personId, receivedAt: r.received_at, waiting: Number(r.waiting), projects });
    }
    return { ok: true, value: out };
  }

  /**
   * L'agent de la boîte choisit le dossier des pièces en attente d'un mail [R410]. Le mail, relu chez le fournisseur, doit
   * être celui du tri ; seules ses pièces restées « en attente » sont rangées, reconnues par leur empreinte, jamais une
   * autre ; le dossier doit être un dossier ouvert de la fiche du mail, fiches réunies comprises, et la fiche encore à
   * l'agent [R16]. Une fois choisi, le dossier du mail ne change plus. Deux choix en même temps ne rangent qu'une fois [R18].
   */
  async fileWaiting(viewer: Viewer, mailId: string, projectId: string, mail: MailIn): Promise<ScenarioResult<FiledWaiting>> {
    if (!(await this.ownAgent(viewer))) return this.refuse(viewer, 'not_mailbox_agent', 'file_waiting', 'R410');
    const row = typeof mailId === 'string'
      ? await this.db.first<{ id: string; network_id: string; agent_id: string; provider: string; external_id: string; status: string; person_id: string | null; project_id: string | null }>('SELECT id, network_id, agent_id, provider, external_id, status, person_id, project_id FROM mailbox_mails WHERE id = ?', [mailId])
      : null;
    if (!row || row.network_id !== viewer.networkId || row.agent_id !== viewer.userId) return this.refuse(viewer, 'not_mailbox_agent', 'file_waiting', 'R410');
    if (row.status !== 'rattache' || row.person_id === null) return { ok: false, rule: 'R410', code: 'nothing_waiting' };
    if (!mail || mail.provider !== row.provider || mail.externalId !== row.external_id || !Array.isArray(mail.attachments)) return { ok: false, rule: 'R410', code: 'mail_mismatch' };
    const read = await this.acces.readFiche(viewer, row.person_id);
    if (!read.ok) return this.refuse(viewer, 'not_your_fiche', 'file_waiting');
    const personId = read.value.person.id;
    const members = await this.fiche.membersOf(personId);
    const open = await this.openProjects(viewer.networkId, members);
    if (typeof projectId !== 'string' || !open.some((p) => p.id === projectId)) return { ok: false, rule: 'R410', code: 'project_not_open' };
    if (row.project_id !== null && row.project_id !== projectId) return { ok: false, rule: 'R410', code: 'other_project' };
    const waitingShas = new Set((await this.db.all<{ sha256: string }>("SELECT sha256 FROM mailbox_attachment_links WHERE mail_id = ? AND outcome = 'en_attente'", [row.id])).map((l) => l.sha256));
    if (waitingShas.size === 0) return { ok: false, rule: 'R410', code: 'nothing_waiting' };

    // Le dossier du mail : choisi une fois, par le premier choix [R18].
    await this.db.run('UPDATE mailbox_mails SET project_id = ? WHERE id = ? AND project_id IS NULL', [projectId, row.id]);
    const fixed = await this.db.first<{ project_id: string | null }>('SELECT project_id FROM mailbox_mails WHERE id = ?', [row.id]);
    if (fixed?.project_id !== projectId) return { ok: false, rule: 'R410', code: 'other_project' };

    const now = this.now();
    let range = 0;
    let dejaRange = 0;
    const done = new Set<string>();
    for (const a of mail.attachments) {
      if (!a || !(a.bytes instanceof Uint8Array)) continue;
      const sha = await sha256Hex(a.bytes);
      if (!waitingShas.has(sha) || done.has(sha)) continue;
      done.add(sha);
      // Jugée utile au tri ; relue, elle doit l'être encore : sinon elle reste en attente.
      const judged = judgeAttachment(a);
      if (!judged.ok) continue;
      const stored = await this.storeAttachment(viewer.networkId, projectId, row.id, sha, judged, a.bytes, now);
      const won = await this.db.run("UPDATE mailbox_attachment_links SET outcome = ?, attachment_id = ? WHERE mail_id = ? AND sha256 = ? AND outcome = 'en_attente'", [stored.outcome, stored.attachmentId, row.id, sha]);
      if (won.changes !== 1) continue;
      if (stored.outcome === 'range') range += 1;
      else dejaRange += 1;
    }
    const restent = (await this.db.first<{ n: number }>("SELECT COUNT(*) AS n FROM mailbox_attachment_links WHERE mail_id = ? AND outcome = 'en_attente'", [row.id]))?.n ?? 0;
    await appendEvent(
      this.journal,
      { type: 'boite.pieces.rangees', actor: this.actor(viewer), subject: `person:${personId}`, data: { rule: 'R410', mail: row.id, project: projectId, range, dejaRange, restent: Number(restent) } },
      this.now,
    );
    return { ok: true, value: { mailId: row.id, projectId, range, dejaRange, restent: Number(restent) } };
  }

  /** Les phrases fixes de la réponse, chacune avec la ligne du dossier qu'elle reprend [R411]. Jamais d'IA. */
  private async compose(agentId: string, members: readonly string[], personId: string, attachmentIds: readonly string[], now: Date): Promise<{ sentences: DraftSentence[]; figures: string[] }> {
    const sentences: DraftSentence[] = [];
    const figures: string[] = [];
    const named = await this.db.first<{ id: string; first_name: string | null }>(
      `SELECT id, first_name FROM persons WHERE id IN (${marks(members.length)}) AND first_name IS NOT NULL AND trim(first_name) <> '' ORDER BY CASE WHEN id = ? THEN 0 ELSE 1 END, created_at, id LIMIT 1`,
      [...members, personId],
    );
    sentences.push(named ? { text: `Bonjour ${named.first_name!.trim()},`, sources: [{ table: 'persons', id: named.id, field: 'first_name' }] } : { text: 'Bonjour,', sources: [] });

    if (attachmentIds.length > 0) {
      const n = attachmentIds.length;
      if (n > 1) figures.push(String(n));
      sentences.push({
        text: n === 1 ? 'Bien reçu votre pièce jointe, elle est rangée dans votre dossier.' : `Bien reçu vos ${n} pièces jointes, elles sont rangées dans votre dossier.`,
        sources: attachmentIds.map((id) => ({ table: 'mailbox_attachments' as const, id, field: 'sha256' })),
      });
    }

    const next = await this.db.first<{ id: string; start_at: string }>(
      `SELECT id, start_at FROM appointments WHERE person_id IN (${marks(members.length)}) AND status = 'booked' AND start_at > ? ORDER BY start_at, id LIMIT 1`,
      [...members, now.toISOString()],
    );
    if (next) {
      const local = localTime(new Date(next.start_at), TIME_ZONE);
      const [, month, day] = local.date.split('-');
      const dayText = `${day}/${month}`;
      const hourText = `${Math.floor(local.minutes / 60)} h ${two(local.minutes % 60)}`;
      figures.push(dayText, hourText);
      sentences.push({ text: `Je vous confirme notre rendez-vous du ${dayText} à ${hourText}.`, sources: [{ table: 'appointments', id: next.id, field: 'start_at' }] });
    }

    sentences.push({ text: 'Je reviens vers vous très vite.', sources: [] });
    const agent = await this.db.first<{ id: string; first_name: string | null }>('SELECT id, first_name FROM agents WHERE id = ?', [agentId]);
    if (agent?.first_name && agent.first_name.trim() !== '') sentences.push({ text: agent.first_name.trim(), sources: [{ table: 'agents', id: agent.id, field: 'first_name' }] });
    return { sentences, figures };
  }

  /** Les réponses préparées de la boîte, en attente de validation. */
  async drafts(viewer: Viewer): Promise<ScenarioResult<{ id: string; mailId: string; personId: string; body: string; sentences: DraftSentence[] }[]>> {
    if (!(await this.ownAgent(viewer))) return this.refuse(viewer, 'not_mailbox_agent', 'drafts');
    const rows = await this.db.all<{ id: string; mail_id: string; person_id: string; body: string; sentences: string }>(
      "SELECT id, mail_id, person_id, body, sentences FROM mailbox_drafts WHERE network_id = ? AND agent_id = ? AND status = 'prepare' ORDER BY created_at, id",
      [viewer.networkId, viewer.userId],
    );
    // Les droits se relisent à chaque fois : une fiche passée à un autre agent depuis le tri n'est plus montrée [R16].
    const out: { id: string; mailId: string; personId: string; body: string; sentences: DraftSentence[] }[] = [];
    for (const r of rows) {
      if (!(await this.acces.readFiche(viewer, r.person_id)).ok) continue;
      out.push({ id: r.id, mailId: r.mail_id, personId: r.person_id, body: r.body, sentences: JSON.parse(r.sentences) as DraftSentence[] });
    }
    return { ok: true, value: out };
  }

  /**
   * L'agent de la boîte valide la réponse préparée : elle part telle quelle, une seule fois, par le contrôle central,
   * en mode essai [R409, R26]. Personne d'autre ne peut la valider ; une seconde validation ne renvoie rien.
   */
  async validate(viewer: Viewer, draftId: string): Promise<ScenarioResult<{ status: 'parti' | 'refuse'; rule: string | null; messageId: string | null }>> {
    if (!(await this.ownAgent(viewer))) return this.refuse(viewer, 'not_mailbox_agent', 'validate', 'R409');
    const draft = await this.db.first<{ id: string; network_id: string; agent_id: string; person_id: string; mail_id: string; body: string; figures: string; status: string }>('SELECT * FROM mailbox_drafts WHERE id = ?', [draftId]);
    if (!draft || draft.network_id !== viewer.networkId || draft.agent_id !== viewer.userId) return this.refuse(viewer, 'not_mailbox_agent', 'validate', 'R409');
    // L'agent doit encore pouvoir voir la fiche, dossier d'agent valide compris : sinon rien ne part [R16, R82].
    const access = await this.acces.readFiche(viewer, draft.person_id);
    if (!access.ok) return { ok: false, rule: 'R16', code: access.code };
    // Tout ce que l'envoi doit lire est lu avant de prendre la validation : une lecture en panne ne bloque jamais la réponse.
    const mail = await this.db.first<{ provider: string; message_id: string | null; project_id: string | null }>('SELECT provider, message_id, project_id FROM mailbox_mails WHERE id = ?', [draft.mail_id]);
    const conversation = mail?.message_id ? (await this.db.first<{ conversation_id: string | null }>('SELECT conversation_id FROM messages WHERE id = ?', [mail.message_id]))?.conversation_id ?? null : null;
    const at = this.now().toISOString();
    // Prendre la validation : de deux validations en même temps, une seule envoie [R18, R409].
    const won = await this.db.run("UPDATE mailbox_drafts SET status = 'valide', validated_by = ?, validated_at = ? WHERE id = ? AND status = 'prepare'", [viewer.userId, at, draftId]);
    if (won.changes !== 1) return { ok: false, rule: 'R409', code: 'already_validated' };
    let result;
    try {
      result = await this.controle.send({
        networkId: draft.network_id,
        agentId: draft.agent_id,
        preparedBy: viewer.userId,
        personId: draft.person_id,
        projectId: mail?.project_id ?? null,
        conversationId: conversation,
        channel: 'email',
        kind: 'reply',
        subject: `mail:${draft.mail_id}`,
        fallbackTexts: [draft.body],
        figures: JSON.parse(draft.figures) as string[],
      });
    } catch (error) {
      // Une panne rend la validation : l'agent pourra valider de nouveau, rien n'est parti.
      await this.db.run("UPDATE mailbox_drafts SET status = 'prepare', validated_by = NULL, validated_at = NULL WHERE id = ? AND status = 'valide'", [draftId]);
      throw error;
    }
    // Refusée pour l'heure seulement : la réponse reste préparée, l'agent la validera aux heures permises [R01].
    if (result.status === 'refused' && result.rule === 'R01') {
      await this.db.run("UPDATE mailbox_drafts SET status = 'prepare', validated_by = NULL, validated_at = NULL, rule = 'R01' WHERE id = ? AND status = 'valide'", [draftId]);
      await appendEvent(this.journal, { type: 'boite.reponse.validee', actor: this.actor(viewer), subject: `person:${draft.person_id}`, data: { rule: 'R409', mode: 'essai', status: 'reportee', sendRule: 'R01' } }, this.now);
      return { ok: false, rule: 'R01', code: 'outside_sending_hours' };
    }
    const status = result.status === 'sent' ? 'parti' : 'refuse';
    await this.db.run('UPDATE mailbox_drafts SET status = ?, rule = ?, sent_message_id = ? WHERE id = ?', [status, result.rule, result.messageId, draftId]);
    await appendEvent(this.journal, { type: 'boite.reponse.validee', actor: this.actor(viewer), subject: `person:${draft.person_id}`, data: { rule: 'R409', mode: 'essai', status, sendRule: result.rule } }, this.now);
    return { ok: true, value: { status, rule: result.rule, messageId: result.messageId } };
  }
}
