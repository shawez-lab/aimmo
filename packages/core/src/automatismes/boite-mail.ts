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
  from: string;
  body: string;
  receivedAt: Date;
  attachments: readonly MailAttachmentIn[];
}

/** La boîte d'un agent chez Gmail ou Outlook (H05, H55) : les mails reçus depuis une date. */
export interface MailboxProvider {
  provider: MailProvider;
  receivedSince(agentId: string, since: Date | null): Promise<MailIn[]>;
}

/** Le stockage des pièces des dossiers (R2, ou Drive une fois relié). */
export interface DossierFileStore {
  put(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
}

export type AttachmentOutcome = 'range' | 'deja_range' | 'en_attente' | 'inutile' | 'interdit' | 'type_refuse';
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

export interface BoiteMailOptions {
  now?: () => Date;
  newId?: () => string;
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

  /** Lit les mails reçus depuis le dernier tri de cette boîte, et les trie un par un, les plus anciens d'abord. */
  async sync(viewer: Viewer, provider: MailboxProvider): Promise<ScenarioResult<SortedMail[]>> {
    if (!(await this.ownAgent(viewer))) return this.refuse(viewer, 'not_mailbox_agent', 'sync');
    const last = await this.db.first<{ at: string | null }>('SELECT MAX(received_at) AS at FROM mailbox_mails WHERE network_id = ? AND agent_id = ? AND provider = ?', [viewer.networkId, viewer.userId, provider.provider]);
    const mails = await provider.receivedSince(viewer.userId, last?.at ? new Date(last.at) : null);
    const out: SortedMail[] = [];
    for (const mail of [...mails].sort((a, b) => a.receivedAt.getTime() - b.receivedAt.getTime())) {
      if (mail.provider !== provider.provider) continue;
      const r = await this.sort(viewer, mail);
      if (r.ok) out.push(r.value);
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
    if (mail.attachments.length > MAX_ATTACHMENTS) return { ok: false, rule: 'R410', code: 'too_many_attachments' };
    const networkId = viewer.networkId;
    const agentId = viewer.userId;
    const now = this.now();

    // Prendre le mail : deux lectures du même mail n'en trient qu'une [R18].
    const mailId = this.newId();
    const taken = await this.db.run(
      "INSERT OR IGNORE INTO mailbox_mails (id, network_id, agent_id, provider, external_id, status, received_at, created_at) VALUES (?, ?, ?, ?, ?, 'en_cours', ?, ?)",
      [mailId, networkId, agentId, mail.provider, mail.externalId, mail.receivedAt.toISOString(), now.toISOString()],
    );
    if (taken.changes !== 1) {
      const existing = await this.db.first<{ id: string }>('SELECT id FROM mailbox_mails WHERE network_id = ? AND agent_id = ? AND provider = ? AND external_id = ?', [networkId, agentId, mail.provider, mail.externalId]);
      return { ok: true, value: { mailId: existing?.id ?? '', outcome: null, personId: null, projectId: null, attachments: [], draftId: null } };
    }

    // 1. La fiche : l'adresse normalisée, parmi les seules fiches que l'agent peut voir [R16, R408].
    const candidates = await this.fiche.findByIdentifier(networkId, 'email', mail.from);
    const visible: string[] = [];
    for (const p of candidates) {
      const read = await this.acces.readFiche(viewer, p.id);
      if (read.ok) visible.push(read.value.person.id);
    }
    const roots = [...new Set(visible)];
    if (roots.length !== 1) {
      const outcome: MailOutcome = roots.length === 0 ? 'inconnu' : 'ambigu';
      await this.db.run('UPDATE mailbox_mails SET status = ?, done_at = ? WHERE id = ?', [outcome, now.toISOString(), mailId]);
      await appendEvent(this.journal, { type: 'boite.mail.trie', actor: this.actor(viewer), subject: null, data: { rule: 'R408', outcome, attachments: mail.attachments.length } }, this.now);
      return { ok: true, value: { mailId, outcome, personId: null, projectId: null, attachments: [], draftId: null } };
    }
    const personId = roots[0]!;
    const members = await this.fiche.membersOf(personId);

    // 2. Le dossier : le seul projet ouvert de la fiche, fiches réunies comprises ; sinon l'agent choisit.
    const open = (await this.db.all<{ id: string; stage: string }>(`SELECT id, stage FROM projects WHERE network_id = ? AND person_id IN (${marks(members.length)}) ORDER BY created_at, id`, [networkId, ...members])).filter(
      (p) => !CLOSED_PROJECT_STAGES.includes(p.stage),
    );
    const projectId = open.length === 1 ? open[0]!.id : null;

    // 3. Le mail entre dans la fiche comme un message reçu, IBAN masqué [R15], dans la conversation de son fil.
    const body = maskIban(String(mail.body ?? '').slice(0, MAX_BODY)).trim() || '(mail sans texte)';
    const person = await this.store.getPerson(personId);
    const message = await this.store.recordMessage({
      networkId,
      agentId: person?.agent_id ?? null,
      personId,
      projectId,
      conversationId: `email:${mail.provider}:${mail.threadId}`,
      channel: 'email',
      direction: 'in',
      authorKind: 'person',
      body,
      occurredAt: mail.receivedAt,
    });
    // Une demande d'arrêt, un refus ou « vendu » valent dès la réception, comme pour tout message [R04, R02].
    const exclusion = classifyReceived(body);
    if (exclusion) {
      for (const id of members) {
        const m = await this.store.getPerson(id);
        await this.decisions.recordExclusion({ networkId, agentId: m?.agent_id ?? null, personId: id, at: mail.receivedAt, reason: exclusion });
      }
    }

    // 4. Les pièces jointes, une seule fois par empreinte dans le dossier [R410].
    const outcomes: AttachmentOutcome[] = [];
    const kept: string[] = [];
    const seen = new Set<string>();
    for (const a of mail.attachments) {
      const sha = await sha256Hex(a.bytes);
      if (seen.has(sha)) continue;
      seen.add(sha);
      const judged = judgeAttachment(a);
      let outcome: AttachmentOutcome;
      let attachmentId: string | null = null;
      if (!judged.ok) outcome = judged.outcome;
      else if (projectId === null) outcome = 'en_attente';
      else {
        const already = await this.db.first<{ id: string }>('SELECT id FROM mailbox_attachments WHERE network_id = ? AND project_id = ? AND sha256 = ?', [networkId, projectId, sha]);
        if (already) {
          outcome = 'deja_range';
          attachmentId = already.id;
        } else {
          const id = this.newId();
          const ref = `boite/${projectId}/${sha}.${judged.ext}`;
          await this.files.put(ref, a.bytes, judged.type);
          // Deux tris en même temps du même fichier : la contrainte d'unicité n'en garde qu'un [R18, R410].
          const ins = await this.db.run(
            'INSERT OR IGNORE INTO mailbox_attachments (id, network_id, project_id, sha256, ref, content_type, size, first_mail_id, stored_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [id, networkId, projectId, sha, ref, judged.type, a.bytes.length, mailId, now.toISOString()],
          );
          if (ins.changes === 1) {
            outcome = 'range';
            attachmentId = id;
          } else {
            outcome = 'deja_range';
            attachmentId = (await this.db.first<{ id: string }>('SELECT id FROM mailbox_attachments WHERE network_id = ? AND project_id = ? AND sha256 = ?', [networkId, projectId, sha]))?.id ?? null;
          }
        }
      }
      await this.db.run('INSERT OR IGNORE INTO mailbox_attachment_links (mail_id, sha256, outcome, attachment_id, created_at) VALUES (?, ?, ?, ?, ?)', [mailId, sha, outcome, attachmentId, now.toISOString()]);
      if (attachmentId) kept.push(attachmentId);
      outcomes.push(outcome);
    }

    // 5. La réponse préparée, sauf si la personne a demandé l'arrêt ou est exclue : elle attend la validation [R409].
    let draftId: string | null = null;
    const blocked = await this.decisions.decide(personId, { channel: 'email', kind: 'reply', conversationId: `email:${mail.provider}:${mail.threadId}`, at: now });
    if (!exclusion && !(blocked.allowed === false && (blocked.rule === 'R02' || blocked.rule === 'R04'))) {
      const draft = await this.compose(agentId, members, personId, kept, now);
      draftId = this.newId();
      await this.db.run(
        "INSERT INTO mailbox_drafts (id, network_id, mail_id, agent_id, person_id, body, sentences, figures, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'prepare', ?)",
        [draftId, networkId, mailId, agentId, personId, draft.sentences.map((s) => s.text).join('\n\n'), JSON.stringify(draft.sentences), JSON.stringify(draft.figures), now.toISOString()],
      );
    }

    await this.db.run("UPDATE mailbox_mails SET status = 'rattache', person_id = ?, project_id = ?, message_id = ?, done_at = ? WHERE id = ?", [personId, projectId, message.id, now.toISOString(), mailId]);
    const count = (o: AttachmentOutcome) => outcomes.filter((x) => x === o).length;
    await appendEvent(
      this.journal,
      {
        type: 'boite.mail.trie',
        actor: this.actor(viewer),
        subject: `person:${personId}`,
        data: { rule: 'R408', outcome: 'rattache', dossier: projectId !== null, range: count('range'), dejaRange: count('deja_range'), enAttente: count('en_attente'), interdit: count('interdit'), inutile: count('inutile'), refuse: count('type_refuse'), reponsePreparee: draftId !== null },
      },
      this.now,
    );
    return { ok: true, value: { mailId, outcome: 'rattache', personId, projectId, attachments: outcomes, draftId } };
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
    const at = this.now().toISOString();
    // Prendre la validation : de deux validations en même temps, une seule envoie [R18, R409].
    const won = await this.db.run("UPDATE mailbox_drafts SET status = 'valide', validated_by = ?, validated_at = ? WHERE id = ? AND status = 'prepare'", [viewer.userId, at, draftId]);
    if (won.changes !== 1) return { ok: false, rule: 'R409', code: 'already_validated' };
    const mail = await this.db.first<{ provider: string; message_id: string | null; project_id: string | null }>('SELECT provider, message_id, project_id FROM mailbox_mails WHERE id = ?', [draft.mail_id]);
    const conversation = mail?.message_id ? (await this.db.first<{ conversation_id: string | null }>('SELECT conversation_id FROM messages WHERE id = ?', [mail.message_id]))?.conversation_id ?? null : null;
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
