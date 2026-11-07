/**
 * Ordre des signataires, annexes groupées et rappels (M06, HX37) [R464 à R467].
 *
 * L'agent du bien réunit un document du dossier de vente et ses annexes en un circuit de signature : chaque pièce est
 * rangée au stockage du dossier et donnée avec l'empreinte de son contenu ; le document et toutes ses annexes, dans leur
 * ordre, forment une seule empreinte de dossier, et c'est elle que chaque signataire signe [R465]. Les signataires sont
 * rangés par groupes : un groupe ne signe qu'une fois le précédent complet ; dans un groupe, l'ordre est libre [R464].
 *
 * Jamais vu : avant de signer, chaque signataire lit, en mots simples, ce que chaque annexe change pour lui, vendeur ou
 * acquéreur ; le texte est écrit par le code, et sa lecture est rangée avec l'empreinte du texte montré [R466]. Les
 * rappels ne vont qu'aux signataires dont c'est le tour, par le contrôle central des envois, jamais la nuit ni le
 * dimanche [R467].
 *
 * Décidé, lecture prudente :
 * - un circuit ne change plus : une pièce corrigée demande un nouveau circuit, avec une nouvelle empreinte ;
 * - un signataire est un vendeur d'un mandat du bien ou l'acquéreur du dossier, fiches réunies comprises ;
 * - les textes en mots simples sont des textes de travail, à faire valider par la conformité (H08) ; un texte changé
 *   depuis sa lecture se relit avant de signer ;
 * - la signature est présentée par l'agent du bien, avec la preuve rangée par le service de signature ; ce circuit ne
 *   rend pas réelle une signature d'essai (H24) ;
 * - un rappel au plus toutes les 48 heures, trois au plus par signataire ; hors des heures d'envoi, aucun essai n'est
 *   fait, et le contrôle central redécide les heures et l'accord du signataire [R01, R03].
 */
import type { Acces } from '../acces/acces.ts';
import type { Viewer } from '../acces/droits.ts';
import { trialChannels } from '../captation/essai.ts';
import { FicheClient } from '../db/fiche-client.ts';
import { runBatch, type SqlDatabase } from '../db/sql.ts';
import { actorOf, gateSaleFile, type FileRefusal, type FileUnknown } from '../dossiers/acces-dossier.ts';
import type { PieceStore } from '../dossiers/pieces.ts';
import { ControleEnvois } from '../envoi/controle.ts';
import { DEFAULT_SEND_SETTINGS } from '../envoi/decision.ts';
import { localTime } from '../envoi/horaires.ts';
import { SqlSendJournal } from '../envoi/journal-envois.ts';
import { DecisionEnvoi } from '../envoi/service.ts';
import { FicheUnique } from '../fiche/fusion.ts';
import { ficheFirstName } from '../fiche/prenom.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import { PROOF_REF } from '../offres/transmission.ts';
import { ONLINE_SIGNATURE_PURPOSE } from './signature-en-ligne.ts';

export const ANNEX_KINDS = ['diagnostics', 'etat_risques', 'copropriete', 'mesurage', 'mobilier'] as const;
export type AnnexKind = (typeof ANNEX_KINDS)[number];
export type SignerRole = 'vendeur' | 'acquereur';

export const REMINDER_INTERVAL_HOURS = 48;
export const MAX_REMINDERS = 3;
const MAX_PIECES = 20;
const MAX_SIGNERS = 12;

/**
 * Ce que chaque annexe change pour chaque signataire, en mots simples, écrit par le code [R466]. Textes de travail : la
 * version définitive est celle que valide la conformité (H08).
 */
export const ANNEX_PLAIN_WORDS: Readonly<Record<AnnexKind, Readonly<Record<SignerRole, string>>>> = {
  diagnostics: {
    vendeur: 'Les diagnostics décrivent l’état du bien. En les annexant, vous les remettez à l’acquéreur : un défaut qu’ils montrent ne pourra plus vous être reproché comme caché.',
    acquereur: 'Les diagnostics décrivent l’état du bien. En signant, vous dites les avoir reçus : ce qu’ils montrent, vous l’achetez en le sachant.',
  },
  etat_risques: {
    vendeur: 'L’état des risques dit à l’acquéreur à quels risques naturels, miniers ou technologiques le bien est exposé. Sans lui, l’acquéreur pourrait demander l’annulation de la vente ou une baisse du prix.',
    acquereur: 'L’état des risques vous dit à quels risques naturels, miniers ou technologiques le bien est exposé. En signant, vous dites l’avoir reçu.',
  },
  copropriete: {
    vendeur: 'Les documents de la copropriété disent les règles, les charges et les travaux votés. Les travaux votés avant la vente restent à votre charge, sauf accord écrit contraire.',
    acquereur: 'Les documents de la copropriété disent les règles de l’immeuble, les charges que vous paierez et les travaux votés. En signant, vous dites les avoir reçus.',
  },
  mesurage: {
    vendeur: 'Le mesurage donne la surface vendue. Si la surface réelle est plus petite de plus d’un vingtième, l’acquéreur peut demander une baisse du prix.',
    acquereur: 'Le mesurage donne la surface que vous achetez. Si la surface réelle est plus petite de plus d’un vingtième, vous pouvez demander une baisse du prix.',
  },
  mobilier: {
    vendeur: 'La liste du mobilier dit les meubles que vous laissez avec le bien, et leur prix à part. Ils doivent être là le jour de l’acte.',
    acquereur: 'La liste du mobilier dit les meubles que vous achetez avec le bien, et leur prix à part. Ils doivent être là le jour de l’acte.',
  },
};

export interface CircuitSigner {
  personId: string;
  role: SignerRole;
  group: number;
  signedAt: string | null;
  /** Les annexes que ce signataire a lues, avec le texte qui lui a été montré. */
  read: number[];
  reminders: number;
}

export interface CircuitAnnex {
  position: number;
  kind: AnnexKind;
  ref: string;
  hash: string;
}

export interface Circuit {
  id: string;
  fileId: string;
  documentRef: string;
  documentHash: string;
  envelopeHash: string;
  annexes: CircuitAnnex[];
  signers: CircuitSigner[];
  /** Le groupe dont c'est le tour, ou null quand tous ont signé. */
  currentGroup: number | null;
  complete: boolean;
}

export type CircuitProblem = {
  ok: false;
  rule: 'R464' | 'R465' | 'R466' | null;
  code:
    | 'closed'
    | 'bad_ref'
    | 'not_stored'
    | 'bad_hash'
    | 'bad_annex'
    | 'bad_signers'
    | 'not_a_party'
    | 'unknown_circuit'
    | 'unknown_signer'
    | 'unknown_annex'
    | 'not_your_turn'
    | 'annexes_not_read'
    | 'text_changed'
    | 'envelope_mismatch'
    | 'already_signed'
    | 'proof_used'
    | 'busy';
};

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const HASH = /^[0-9a-f]{64}$/;

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * L'empreinte unique du document et de ses annexes [R465] : chaque pièce entre avec sa place, sa sorte, sa référence et
 * l'empreinte de son contenu ; changer, ôter, ajouter ou déplacer une pièce change l'empreinte.
 */
export function envelopeHash(document: { ref: string; hash: string }, annexes: readonly { kind: AnnexKind; ref: string; hash: string }[]): Promise<string> {
  const canonical = JSON.stringify({ v: 1, document: [document.ref, document.hash], annexes: annexes.map((a, i) => [i + 1, a.kind, a.ref, a.hash]) });
  return sha256Hex(canonical);
}

/** Le texte en mots simples d'une annexe pour un signataire, et son empreinte [R466]. */
export async function plainWords(kind: AnnexKind, role: SignerRole): Promise<{ text: string; hash: string }> {
  const text = ANNEX_PLAIN_WORDS[kind][role];
  return { text, hash: await sha256Hex(`${kind}:${role}:${text}`) };
}

/** Le texte du rappel, écrit par le code : prénom et nom de l'agent, aucun chiffre, aucun prix, aucune adresse. */
export function reminderText(input: { firstName: string; agentName: string; n: number }): string {
  // Chaque rappel a son texte : le contrôle central ne laisse jamais partir deux fois le même message [R05].
  const opening = ['Votre signature est attendue', 'Petit rappel : votre signature est toujours attendue', 'Dernier rappel : votre signature est toujours attendue'][Math.min(input.n, MAX_REMINDERS) - 1];
  return [
    `Bonjour ${input.firstName},`,
    `${opening} sur les documents de votre vente. Votre agent, ${input.agentName}, peut vous les présenter quand vous le souhaitez, avec ce que chaque annexe change pour vous.`,
  ].join('\n\n');
}

interface CircuitRow {
  id: string;
  network_id: string;
  file_id: string;
  document_ref: string;
  document_hash: string;
  envelope_hash: string;
  prepared_by: string;
  prepared_at: string;
}

interface SignerRow {
  person_id: string;
  role: SignerRole;
  grp: number;
}

interface EventRow {
  seq: number;
  kind: 'lecture' | 'signature' | 'rappel' | 'rappel_refuse';
  person_id: string;
  annex_position: number | null;
  shown_hash: string | null;
  envelope_hash: string | null;
  n: number | null;
  at: string;
}

export interface CircuitOptions {
  now?: () => Date;
  newId?: () => string;
}

export class CircuitSignature {
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly fiche: FicheUnique;
  private readonly envois: ControleEnvois;

  constructor(
    private readonly db: SqlDatabase,
    private readonly acces: Acces,
    private readonly journal: JournalStore,
    private readonly store: PieceStore,
    options: CircuitOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => crypto.randomUUID());
    const fiches = new FicheClient(db, { now: this.now });
    this.fiche = new FicheUnique(db, fiches, { now: this.now });
    // Les rappels passent par le contrôle central, avec les seuls canaux du mode essai : rangés dans la boîte d'essai,
    // jamais envoyés, comme le code de la signature en ligne ; le vrai envoi attend H05.
    this.envois = new ControleEnvois(db, this.fiche, new DecisionEnvoi(db, fiches, this.fiche, { now: this.now }), {
      channels: trialChannels(db, journal, this.now),
      journal: new SqlSendJournal(db, undefined, this.now),
      now: this.now,
    });
  }

  private gate(viewer: Viewer, fileId: string, write: boolean) {
    return gateSaleFile({ db: this.db, acces: this.acces, journal: this.journal, now: this.now }, viewer, fileId, write, 'signature_circuit');
  }

  private async closed(fileId: string): Promise<boolean> {
    return (await this.db.first('SELECT 1 FROM sale_file_closings WHERE file_id = ?', [fileId])) !== null;
  }

  /** Les personnes qui peuvent signer : les vendeurs des mandats du bien et l'acquéreur, fiches réunies comprises. */
  private async parties(file: { network_id: string; property_id: string; buyer_person_id: string }): Promise<Map<string, SignerRole>> {
    const sellers = await this.db.all<{ person_id: string }>('SELECT DISTINCT person_id FROM mandates WHERE property_id = ? AND network_id = ?', [file.property_id, file.network_id]);
    const out = new Map<string, SignerRole>();
    for (const s of sellers) for (const m of await this.fiche.membersOf(s.person_id)) out.set(m, 'vendeur');
    for (const m of await this.fiche.membersOf(file.buyer_person_id)) if (!out.has(m)) out.set(m, 'acquereur');
    return out;
  }

  private piece(fileId: string, v: unknown): v is { ref: string; hash: string } {
    if (!v || typeof v !== 'object') return false;
    const { ref, hash } = v as { ref?: unknown; hash?: unknown };
    return typeof ref === 'string' && new RegExp(`^dossiers/${fileId.replace(/[^0-9a-zA-Z-]/g, '')}/${UUID}\\.pdf$`).test(ref) && typeof hash === 'string' && HASH.test(hash);
  }

  /**
   * L'agent du bien prépare le circuit : le document, ses annexes dans l'ordre, et les signataires par groupes. Rien ne
   * part encore.
   */
  async prepare(
    viewer: Viewer,
    fileId: string,
    input: { document: unknown; annexes: unknown; signers: unknown },
  ): Promise<{ ok: true; value: Circuit } | FileRefusal | FileUnknown | CircuitProblem> {
    const g = await this.gate(viewer, fileId, true);
    if (!g.ok) return g;
    if (await this.closed(fileId)) return { ok: false, rule: null, code: 'closed' };
    if (!this.piece(fileId, input.document)) return { ok: false, rule: 'R465', code: 'bad_ref' };
    const document = { ref: input.document.ref, hash: input.document.hash };
    if (!Array.isArray(input.annexes) || input.annexes.length > MAX_PIECES) return { ok: false, rule: 'R465', code: 'bad_annex' };
    const annexes: { kind: AnnexKind; ref: string; hash: string }[] = [];
    const refs = new Set([document.ref]);
    for (const a of input.annexes as unknown[]) {
      if (!this.piece(fileId, a)) return { ok: false, rule: 'R465', code: 'bad_ref' };
      const kind = (a as { kind?: unknown }).kind;
      if (typeof kind !== 'string' || !(ANNEX_KINDS as readonly string[]).includes(kind)) return { ok: false, rule: 'R466', code: 'bad_annex' };
      if (refs.has(a.ref)) return { ok: false, rule: 'R465', code: 'bad_annex' };
      refs.add(a.ref);
      annexes.push({ kind: kind as AnnexKind, ref: a.ref, hash: a.hash });
    }
    for (const ref of refs) if (!(await this.store.has(ref))) return { ok: false, rule: 'R465', code: 'not_stored' };

    if (!Array.isArray(input.signers) || input.signers.length === 0 || input.signers.length > MAX_SIGNERS) return { ok: false, rule: 'R464', code: 'bad_signers' };
    const parties = await this.parties(g.file);
    const signers: SignerRow[] = [];
    const seen = new Set<string>();
    for (const s of input.signers as unknown[]) {
      const { personId, group } = (s ?? {}) as { personId?: unknown; group?: unknown };
      if (typeof personId !== 'string' || typeof group !== 'number' || !Number.isInteger(group) || group < 1) return { ok: false, rule: 'R464', code: 'bad_signers' };
      const role = parties.get(personId);
      if (!role) return { ok: false, rule: 'R464', code: 'not_a_party' };
      // Une même fiche ne signe qu'une fois, même sous deux de ses identifiants réunis.
      const root = (await this.fiche.membersOf(personId)).sort()[0]!;
      if (seen.has(root)) return { ok: false, rule: 'R464', code: 'bad_signers' };
      seen.add(root);
      signers.push({ person_id: personId, role, grp: group });
    }
    // Des groupes qui se suivent depuis 1, sans trou : l'ordre ne peut pas attendre un groupe vide.
    const groups = [...new Set(signers.map((s) => s.grp))].sort((a, b) => a - b);
    if (groups.some((n, i) => n !== i + 1)) return { ok: false, rule: 'R464', code: 'bad_signers' };

    const id = this.newId();
    const envelope = await envelopeHash(document, annexes);
    const at = this.now().toISOString();
    const by = actorOf(viewer);
    try {
      await runBatch(this.db, [
        {
          sql: 'INSERT INTO signature_circuits (id, network_id, file_id, document_ref, document_hash, envelope_hash, prepared_by, prepared_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          params: [id, g.file.network_id, fileId, document.ref, document.hash, envelope, by, at],
        },
        ...annexes.map((a, i) => ({
          sql: 'INSERT INTO signature_circuit_annexes (circuit_id, network_id, file_id, position, kind, ref, hash) VALUES (?, ?, ?, ?, ?, ?, ?)',
          params: [id, g.file.network_id, fileId, i + 1, a.kind, a.ref, a.hash],
        })),
        ...signers.map((s) => ({
          sql: 'INSERT INTO signature_circuit_signers (circuit_id, network_id, file_id, person_id, role, grp) VALUES (?, ?, ?, ?, ?, ?)',
          params: [id, g.file.network_id, fileId, s.person_id, s.role, s.grp],
        })),
      ]);
    } catch (error) {
      // Le même document avec les mêmes annexes : un circuit existe déjà sous cette empreinte.
      if (/UNIQUE|PRIMARY/i.test(String(error))) return { ok: false, rule: 'R465', code: 'busy' };
      throw error;
    }
    await appendEvent(this.journal, { type: 'dossier.circuit_prepare', actor: by, subject: `sale_file:${fileId}`, data: { rule: 'R465', circuit: id, annexes: annexes.length, signers: signers.length } }, this.now);
    return { ok: true, value: (await this.view(id))! };
  }

  private async row(viewer: Viewer, circuitId: unknown, write: boolean): Promise<{ ok: true; circuit: CircuitRow } | FileRefusal | FileUnknown | CircuitProblem> {
    if (typeof circuitId !== 'string') return { ok: false, rule: null, code: 'unknown_circuit' };
    const circuit = await this.db.first<CircuitRow>('SELECT * FROM signature_circuits WHERE id = ?', [circuitId]);
    if (!circuit || circuit.network_id !== viewer.networkId) return { ok: false, rule: null, code: 'unknown_circuit' };
    const g = await this.gate(viewer, circuit.file_id, write);
    if (!g.ok) return g;
    if (write && (await this.closed(circuit.file_id))) return { ok: false, rule: null, code: 'closed' };
    return { ok: true, circuit };
  }

  private async eventsOf(circuitId: string): Promise<EventRow[]> {
    return this.db.all<EventRow>('SELECT seq, kind, person_id, annex_position, shown_hash, envelope_hash, n, at FROM signature_circuit_events WHERE circuit_id = ? ORDER BY seq', [circuitId]);
  }

  private async addEvent(
    c: CircuitRow,
    e: { kind: EventRow['kind']; personId: string; annexPosition?: number; textHash?: string; envelopeHash?: string; proofRef?: string; n?: number; messageId?: string | null; rule?: string | null; by: string },
  ): Promise<boolean> {
    const last = await this.db.first<{ seq: number | null }>('SELECT MAX(seq) AS seq FROM signature_circuit_events WHERE circuit_id = ?', [c.id]);
    try {
      await this.db.run(
        `INSERT INTO signature_circuit_events (circuit_id, network_id, file_id, seq, kind, person_id, annex_position, shown_hash, envelope_hash, proof_ref, n, message_id, rule, at, by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          c.id,
          c.network_id,
          c.file_id,
          Number(last?.seq ?? 0) + 1,
          e.kind,
          e.personId,
          e.annexPosition ?? null,
          e.textHash ?? null,
          e.envelopeHash ?? null,
          e.proofRef ?? null,
          e.n ?? null,
          e.messageId ?? null,
          e.rule ?? null,
          this.now().toISOString(),
          e.by,
        ],
      );
      return true;
    } catch (error) {
      if (/UNIQUE|PRIMARY/i.test(String(error))) return false;
      throw error;
    }
  }

  /** Le groupe dont c'est le tour : le plus petit qui a encore un signataire sans signature [R464]. */
  private currentGroup(signers: readonly SignerRow[], events: readonly EventRow[]): number | null {
    const signed = new Set(events.filter((e) => e.kind === 'signature').map((e) => e.person_id));
    const waiting = signers.filter((s) => !signed.has(s.person_id)).map((s) => Number(s.grp));
    return waiting.length === 0 ? null : Math.min(...waiting);
  }

  private async signersOf(circuitId: string): Promise<SignerRow[]> {
    return this.db.all<SignerRow>('SELECT person_id, role, grp FROM signature_circuit_signers WHERE circuit_id = ? ORDER BY grp, person_id', [circuitId]);
  }

  private async annexesOf(circuitId: string): Promise<CircuitAnnex[]> {
    const rows = await this.db.all<{ position: number; kind: AnnexKind; ref: string; hash: string }>('SELECT position, kind, ref, hash FROM signature_circuit_annexes WHERE circuit_id = ? ORDER BY position', [circuitId]);
    return rows.map((r) => ({ position: Number(r.position), kind: r.kind, ref: r.ref, hash: r.hash }));
  }

  /**
   * Ce que le signataire lit avant de signer : pour chaque annexe, ce qu'elle change pour lui, en mots simples [R466].
   * L'agent du bien le présente.
   */
  async explain(viewer: Viewer, circuitId: unknown, personId: unknown): Promise<{ ok: true; value: { position: number; kind: AnnexKind; text: string; textHash: string }[] } | FileRefusal | FileUnknown | CircuitProblem> {
    const r = await this.row(viewer, circuitId, true);
    if (!r.ok) return r;
    const signer = (await this.signersOf(r.circuit.id)).find((s) => s.person_id === personId);
    if (!signer) return { ok: false, rule: null, code: 'unknown_signer' };
    const value = [];
    for (const a of await this.annexesOf(r.circuit.id)) {
      const w = await plainWords(a.kind, signer.role);
      value.push({ position: a.position, kind: a.kind, text: w.text, textHash: w.hash });
    }
    return { ok: true, value };
  }

  /** Le signataire a lu le texte en mots simples d'une annexe : rangé avec l'empreinte du texte montré [R466]. */
  async acknowledge(viewer: Viewer, circuitId: unknown, input: { personId: unknown; position: unknown; textHash: unknown }): Promise<{ ok: true; value: Circuit } | FileRefusal | FileUnknown | CircuitProblem> {
    const r = await this.row(viewer, circuitId, true);
    if (!r.ok) return r;
    const signer = (await this.signersOf(r.circuit.id)).find((s) => s.person_id === input.personId);
    if (!signer) return { ok: false, rule: null, code: 'unknown_signer' };
    const annex = (await this.annexesOf(r.circuit.id)).find((a) => a.position === input.position);
    if (!annex) return { ok: false, rule: 'R466', code: 'unknown_annex' };
    const w = await plainWords(annex.kind, signer.role);
    if (input.textHash !== w.hash) return { ok: false, rule: 'R466', code: 'text_changed' };
    const events = await this.eventsOf(r.circuit.id);
    if (events.some((e) => e.kind === 'signature' && e.person_id === signer.person_id)) return { ok: false, rule: null, code: 'already_signed' };
    const done = events.some((e) => e.kind === 'lecture' && e.person_id === signer.person_id && Number(e.annex_position) === annex.position && e.shown_hash === w.hash);
    if (!done) {
      if (!(await this.addEvent(r.circuit, { kind: 'lecture', personId: signer.person_id, annexPosition: annex.position, textHash: w.hash, rule: 'R466', by: actorOf(viewer) }))) return { ok: false, rule: null, code: 'busy' };
      await appendEvent(this.journal, { type: 'dossier.circuit_lecture', actor: actorOf(viewer), subject: `sale_file:${r.circuit.file_id}`, data: { rule: 'R466', circuit: r.circuit.id, annex: annex.position } }, this.now);
    }
    return { ok: true, value: (await this.view(r.circuit.id))! };
  }

  /**
   * La signature d'un signataire, présentée par l'agent du bien : c'est son tour [R464], il a lu chaque annexe dans sa
   * version du jour [R466], et il signe l'empreinte unique du circuit, avec la preuve rangée [R465].
   */
  async sign(viewer: Viewer, circuitId: unknown, input: { personId: unknown; envelopeHash: unknown; proofRef: unknown }): Promise<{ ok: true; value: Circuit } | FileRefusal | FileUnknown | CircuitProblem> {
    const r = await this.row(viewer, circuitId, true);
    if (!r.ok) return r;
    const c = r.circuit;
    const signers = await this.signersOf(c.id);
    const signer = signers.find((s) => s.person_id === input.personId);
    if (!signer) return { ok: false, rule: null, code: 'unknown_signer' };
    const events = await this.eventsOf(c.id);
    if (events.some((e) => e.kind === 'signature' && e.person_id === signer.person_id)) return { ok: false, rule: null, code: 'already_signed' };
    const turn = this.currentGroup(signers, events);
    if (turn === null || Number(signer.grp) !== turn) return { ok: false, rule: 'R464', code: 'not_your_turn' };
    // L'empreinte montrée au signataire est celle du circuit, refaite depuis ses pièces : ni une pièce seule, ni une autre.
    const annexes = await this.annexesOf(c.id);
    const envelope = await envelopeHash({ ref: c.document_ref, hash: c.document_hash }, annexes);
    if (envelope !== c.envelope_hash || input.envelopeHash !== envelope) return { ok: false, rule: 'R465', code: 'envelope_mismatch' };
    for (const a of annexes) {
      const w = await plainWords(a.kind, signer.role);
      const read = events.some((e) => e.kind === 'lecture' && e.person_id === signer.person_id && Number(e.annex_position) === a.position && e.shown_hash === w.hash);
      if (!read) return { ok: false, rule: 'R466', code: 'annexes_not_read' };
    }
    if (typeof input.proofRef !== 'string' || !PROOF_REF.test(input.proofRef)) return { ok: false, rule: 'R465', code: 'bad_ref' };
    if (!(await this.store.has(input.proofRef))) return { ok: false, rule: 'R465', code: 'not_stored' };
    if (await this.db.first('SELECT 1 FROM signature_circuit_events WHERE proof_ref = ?', [input.proofRef])) return { ok: false, rule: 'R465', code: 'proof_used' };
    const by = actorOf(viewer);
    if (!(await this.addEvent(c, { kind: 'signature', personId: signer.person_id, envelopeHash: envelope, proofRef: input.proofRef, rule: 'R465', by }))) {
      return (await this.db.first("SELECT 1 FROM signature_circuit_events WHERE circuit_id = ? AND person_id = ? AND kind = 'signature'", [c.id, signer.person_id]))
        ? { ok: false, rule: null, code: 'already_signed' }
        : { ok: false, rule: 'R465', code: 'proof_used' };
    }
    await appendEvent(this.journal, { type: 'dossier.circuit_signature', actor: by, subject: `sale_file:${c.file_id}`, data: { rule: 'R464', circuit: c.id, group: Number(signer.grp) } }, this.now);
    const value = (await this.view(c.id))!;
    if (value.complete) await appendEvent(this.journal, { type: 'dossier.circuit_complet', actor: by, subject: `sale_file:${c.file_id}`, data: { rule: 'R465', circuit: c.id } }, this.now);
    return { ok: true, value };
  }

  /** L'heure est-elle dans la fenêtre d'envoi d'initiative ? Du lundi au samedi, de 8 h à 20 h à Paris [R01, R467]. */
  static inSendingHours(at: Date): boolean {
    const s = DEFAULT_SEND_SETTINGS;
    const local = localTime(at, s.timeZone);
    return s.initiativeDays.includes(local.weekday) && local.minutes >= s.initiativeFrom && local.minutes < s.initiativeUntil;
  }

  /**
   * Le passage des rappels, lancé par le planificateur (pas d'agent) : un rappel à chaque signataire dont c'est le tour,
   * qui n'a pas signé, quand le dernier fait (début de son tour ou rappel précédent) a plus de 48 heures, trois au plus.
   * Hors des heures d'envoi, rien n'est tenté ; chaque rappel passe par le contrôle central [R467].
   */
  async remind(networkId: string): Promise<{ sent: number; refused: number; skipped: 'hors_heures' | null }> {
    const at = this.now();
    if (!CircuitSignature.inSendingHours(at)) return { sent: 0, refused: 0, skipped: 'hors_heures' };
    const circuits = await this.db.all<CircuitRow>(
      `SELECT c.* FROM signature_circuits c WHERE c.network_id = ?
       AND NOT EXISTS (SELECT 1 FROM sale_file_closings x WHERE x.file_id = c.file_id)
       AND NOT EXISTS (SELECT 1 FROM sale_file_stops y WHERE y.file_id = c.file_id)
       ORDER BY c.prepared_at, c.id`,
      [networkId],
    );
    let sent = 0;
    let refused = 0;
    const interval = REMINDER_INTERVAL_HOURS * 3_600_000;
    for (const c of circuits) {
      const signers = await this.signersOf(c.id);
      const events = await this.eventsOf(c.id);
      const turn = this.currentGroup(signers, events);
      if (turn === null) continue;
      // Le tour du groupe a commencé à la dernière signature du groupe d'avant, ou à la préparation.
      const previous = events.filter((e) => e.kind === 'signature' && signers.find((s) => s.person_id === e.person_id && Number(s.grp) < turn));
      const turnStart = previous.length ? Math.max(...previous.map((e) => Date.parse(e.at))) : Date.parse(c.prepared_at);
      const signed = new Set(events.filter((e) => e.kind === 'signature').map((e) => e.person_id));
      for (const s of signers) {
        if (Number(s.grp) !== turn || signed.has(s.person_id)) continue;
        const mine = events.filter((e) => (e.kind === 'rappel' || e.kind === 'rappel_refuse') && e.person_id === s.person_id);
        if (mine.length >= MAX_REMINDERS) continue;
        const last = mine.length ? Math.max(turnStart, ...mine.map((e) => Date.parse(e.at))) : turnStart;
        if (at.getTime() - last < interval) continue;
        const n = mine.length + 1;
        const subject = `circuit:${c.id}:${s.person_id}:${n}`;
        // Un rappel remis par le contrôle central sans être rangé ici (une coupure entre les deux) : il est rangé, sans
        // repartir [R05].
        const before = await this.db.first<{ message_id: string }>('SELECT message_id FROM message_subjects WHERE subject = ? AND network_id = ? LIMIT 1', [subject, c.network_id]);
        if (before) {
          if (await this.addEvent(c, { kind: 'rappel', personId: s.person_id, n, messageId: before.message_id, rule: 'R467', by: 'system:circuit' })) {
            await appendEvent(this.journal, { type: 'dossier.circuit_rappel', actor: 'system:circuit', subject: `sale_file:${c.file_id}`, data: { rule: 'R467', circuit: c.id, n } }, this.now);
          }
          continue;
        }
        const text = await this.reminder(c, s.person_id, n);
        const agent = await this.db.first<{ agent_id: string | null }>('SELECT p.agent_id FROM sale_files f JOIN properties p ON p.id = f.property_id WHERE f.id = ?', [c.file_id]);
        const result = text
          ? await this.envois.send({
              networkId: c.network_id,
              agentId: agent?.agent_id ?? null,
              personId: s.person_id,
              channel: 'email',
              kind: 'reminder',
              purpose: ONLINE_SIGNATURE_PURPOSE,
              subject,
              fallbackTexts: [text],
              figures: [],
              asWritten: { refuseWithoutMention: false, thread: `circuit:${c.id}` },
            })
          : null;
        const ok = result?.status === 'sent' && result.messageId !== null;
        const rule = ok ? 'R467' : (result?.rule ?? 'sans_texte');
        if (!(await this.addEvent(c, { kind: ok ? 'rappel' : 'rappel_refuse', personId: s.person_id, n, messageId: result?.messageId ?? null, rule, by: 'system:circuit' }))) continue;
        if (ok) await appendEvent(this.journal, { type: 'dossier.circuit_rappel', actor: 'system:circuit', subject: `sale_file:${c.file_id}`, data: { rule, circuit: c.id, n } }, this.now);
        else await appendEvent(this.journal, { type: 'dossier.circuit_rappel_refuse', actor: 'system:circuit', subject: `sale_file:${c.file_id}`, data: { rule, circuit: c.id, n } }, this.now);
        if (ok) sent += 1;
        else refused += 1;
      }
    }
    return { sent, refused, skipped: null };
  }

  private async reminder(c: CircuitRow, personId: string, n: number): Promise<string | null> {
    const firstName = await ficheFirstName(this.db, await this.fiche.membersOf(personId));
    const agent = await this.db.first<{ first_name: string; last_name: string }>(
      'SELECT a.first_name, a.last_name FROM sale_files f JOIN properties p ON p.id = f.property_id JOIN agents a ON a.id = p.agent_id WHERE f.id = ?',
      [c.file_id],
    );
    if (!firstName || !agent) return null;
    return reminderText({ firstName, agentName: `${agent.first_name} ${agent.last_name}`, n });
  }

  private async view(circuitId: string): Promise<Circuit | null> {
    const c = await this.db.first<CircuitRow>('SELECT * FROM signature_circuits WHERE id = ?', [circuitId]);
    if (!c) return null;
    const signers = await this.signersOf(circuitId);
    const events = await this.eventsOf(circuitId);
    const turn = this.currentGroup(signers, events);
    return {
      id: c.id,
      fileId: c.file_id,
      documentRef: c.document_ref,
      documentHash: c.document_hash,
      envelopeHash: c.envelope_hash,
      annexes: await this.annexesOf(circuitId),
      signers: signers.map((s) => ({
        personId: s.person_id,
        role: s.role,
        group: Number(s.grp),
        signedAt: events.find((e) => e.kind === 'signature' && e.person_id === s.person_id)?.at ?? null,
        read: [...new Set(events.filter((e) => e.kind === 'lecture' && e.person_id === s.person_id).map((e) => Number(e.annex_position)))].sort((a, b) => a - b),
        reminders: events.filter((e) => e.kind === 'rappel' && e.person_id === s.person_id).length,
      })),
      currentGroup: turn,
      complete: turn === null,
    };
  }

  /** Les circuits du dossier : agent du bien, direction, conformité [R16]. */
  async circuits(viewer: Viewer, fileId: string): Promise<{ ok: true; value: Circuit[] } | FileRefusal | FileUnknown> {
    const g = await this.gate(viewer, fileId, false);
    if (!g.ok) return g;
    const rows = await this.db.all<{ id: string }>('SELECT id FROM signature_circuits WHERE file_id = ? ORDER BY prepared_at, id', [fileId]);
    const value: Circuit[] = [];
    for (const r of rows) value.push((await this.view(r.id))!);
    return { ok: true, value };
  }
}
