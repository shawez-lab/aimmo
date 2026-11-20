/**
 * Dossier d'agent et parcours d'intégration (M14, J04) [R82].
 *
 * Un candidat retenu (dernière décision « oui », J03) entre au réseau : la direction crée son agent, une seule fois.
 * Son dossier liste les pièces attendues par des règles écrites, les mêmes pour tous (`AGENT_FILE_PIECES`) ; chaque
 * pièce est rangée par sa référence de stockage, jamais son contenu, avec la date du document et sa date de fin de
 * validité saisie depuis le document ; celle de l'attestation de vigilance est calculée par le code, 6 mois après sa
 * date. Une pièce rangée ne change plus : une nouvelle version s'ajoute, la dernière compte [R17].
 *
 * `complete(networkId, agentId, at)` dit si le dossier est complet et valide ce jour-là, et pourquoi sinon : une pièce
 * manquante, échue ou seulement en projet suffit à le dire incomplet [R82]. Le contrat et l'attestation préparés par le
 * réseau portent « PROJET » tant que les modèles ne sont pas validés (H08) et ne comptent jamais comme pièce signée.
 * Une pièce d'identité, un document anti-blanchiment ou un RIB ne sont jamais une pièce du dossier [R15].
 *
 * L'agent lui-même, la direction et la conformité lisent le dossier ; l'agent et la direction y rangent une pièce
 * [R16]. Aucun nom ni aucune référence au journal [R13]. Rien n'est envoyé ici : les alertes d'échéance sont rendues au
 * planificateur (J13), une seule fois par pièce.
 */
import type { Viewer } from '../acces/droits.ts';
import type { FicheClient } from '../db/fiche-client.ts';
import { runBatch, type SqlDatabase } from '../db/sql.ts';
import { FORBIDDEN_PIECES } from '../dossiers/pieces.ts';
import { localTime } from '../envoi/horaires.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import { AGENT_FILE_PIECES, type AgentFilePiece, type Entretiens } from './entretiens.ts';
import { agentFileStatus, type AgentFileStatus, type PieceRow } from './etat-dossier.ts';

const TIME_ZONE = 'Europe/Paris';
/** Jours avant l'échéance d'une pièce où l'agent est prévenu. */
export const AGENT_PIECE_ALERT_DAYS = 30;
/** Durée de validité d'une attestation de vigilance, en mois. */
export const VIGILANCE_MONTHS = 6;

/** Ce que chaque pièce exige comme fin de validité : aucune (contrat), facultative, ou obligatoire. */
const VALIDITY: Readonly<Record<AgentFilePiece, 'none' | 'optional' | 'required' | 'computed'>> = Object.freeze({
  contrat_agent_commercial: 'none',
  attestation_habilitation: 'required',
  immatriculation_rsac: 'optional',
  assurance_rcp: 'required',
  attestation_vigilance: 'computed',
});

/** Les pièces que le réseau prépare lui-même, en projet tant que leur modèle n'est pas validé (H08). */
export const DRAFTABLE_PIECES = ['contrat_agent_commercial', 'attestation_habilitation'] as const satisfies readonly AgentFilePiece[];

export interface AgentPieceStore {
  /** La référence existe dans le stockage. */
  has(ref: string): Promise<boolean>;
  /** Range un document préparé par le réseau, rend sa référence. */
  putDraft(agentId: string, text: string): Promise<string>;
  /** Range le fichier d'une pièce déposée depuis l'écran (AU024), rend sa référence ; absent, le dépôt est fermé. */
  putFile?(agentId: string, bytes: Uint8Array, ext: AgentPieceExt, contentType: string): Promise<string>;
}

/** AU024 · Les seuls fichiers qu'un agent dépose depuis son téléphone : un PDF, une photo JPEG ou PNG. */
export const AGENT_PIECE_FILE_TYPES = Object.freeze({ 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png' } as const);
export type AgentPieceExt = (typeof AGENT_PIECE_FILE_TYPES)[keyof typeof AGENT_PIECE_FILE_TYPES];
/** Le poids le plus lourd d'une pièce déposée : une photo de téléphone ou un PDF de quelques pages. */
export const AGENT_PIECE_MAX_BYTES = 10 * 1024 * 1024;
/** Le fichier dit-il vraiment ce que son type annonce ? Les premiers octets d'un PDF, d'un JPEG, d'un PNG. */
function looksLike(ext: AgentPieceExt, b: Uint8Array): boolean {
  if (ext === 'pdf') return b.length >= 5 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46 && b[4] === 0x2d;
  if (ext === 'jpg') return b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
  return b.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((x, i) => b[i] === x);
}

/** L'accusé de réception d'une pièce déposée : ce qui est rangé, sa version, l'heure ; jamais la référence. */
export interface AgentPieceReceipt {
  kind: AgentFilePiece;
  label: string;
  version: number;
  receivedAt: string;
  bytes: number;
}

export type AgentFileRefusal = { ok: false; rule: 'R16' | 'R15' | 'R82' | null; code: string };


const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const REF_FILE = new RegExp(`^${UUID}\\.(?:pdf|jpg|png|txt)$`);
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const validDay = (v: unknown): v is string => {
  if (typeof v !== 'string' || !DAY.test(v)) return false;
  const d = new Date(`${v}T12:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
};
/** Ajoute des mois à un jour, en restant au dernier jour du mois s'il le faut ; puis retire un jour. */
export function vigilanceUntil(issuedOn: string): string {
  const [y, m, d] = issuedOn.split('-').map(Number) as [number, number, number];
  const target = new Date(Date.UTC(y, m - 1 + VIGILANCE_MONTHS, 1));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d, last));
  target.setUTCDate(target.getUTCDate() - 1);
  return target.toISOString().slice(0, 10);
}
const addDays = (day: string, n: number): string => new Date(Date.parse(`${day}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const frDate = (day: string): string => `${day.slice(8, 10)}/${day.slice(5, 7)}/${day.slice(0, 4)}`;
const labelOf = (kind: AgentFilePiece): string => AGENT_FILE_PIECES.find((p) => p.kind === kind)!.label;
const lower = (s: string): string => s.charAt(0).toLocaleLowerCase('fr') + s.slice(1);

/** L'identifiant de l'agent d'une candidature : une empreinte stable, à la forme d'un UUID. */
export async function agentIdFor(candidateId: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`agent:${candidateId}`)));
  const hex = [...digest.slice(0, 16)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export interface DossierAgentOptions {
  now?: () => Date;
  newId?: () => string;
}

export class DossierAgent {
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(
    private readonly db: SqlDatabase,
    private readonly store: FicheClient,
    private readonly entretiens: Entretiens,
    private readonly pieces: AgentPieceStore,
    private readonly journal: JournalStore,
    options: DossierAgentOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => crypto.randomUUID());
  }

  private actor(viewer: Viewer): string {
    return `${String(viewer.role)}:${viewer.userId}`;
  }

  private async refuse(viewer: Viewer, subject: string, code: string): Promise<AgentFileRefusal> {
    await appendEvent(this.journal, { type: 'acces.refuse', actor: this.actor(viewer), subject, data: { rule: 'R16', role: String(viewer.role), kind: 'agent_file', code } }, this.now);
    return { ok: false, rule: 'R16', code };
  }

  /** Qui lit (ou écrit) le dossier d'un agent : l'agent lui-même, actif ; la direction ; la conformité en lecture. */
  private async gate(viewer: Viewer, agentId: string, write: boolean): Promise<AgentFileRefusal | null> {
    const agent = await this.db.first<{ network_id: string; status: string }>('SELECT network_id, status FROM agents WHERE id = ?', [agentId]);
    if (!agent || agent.network_id !== viewer.networkId) return this.refuse(viewer, `agent:${agentId}`, 'unknown');
    if (viewer.role === 'direction') return null;
    if (viewer.role === 'compliance' && !write) return null;
    if (viewer.role === 'agent' && viewer.userId === agentId) return agent.status === 'active' ? null : this.refuse(viewer, `agent:${agentId}`, 'agent_inactive');
    return this.refuse(viewer, `agent:${agentId}`, viewer.role === 'agent' ? 'not_assigned' : 'role');
  }

  private today(at: Date = this.now()): string {
    return localTime(at, TIME_ZONE).date;
  }

  /**
   * La direction fait entrer un candidat retenu : son agent est créé, une seule fois par candidature. Sans « oui »
   * rangé par un humain (J03), rien n'est créé [R81].
   */
  async admit(viewer: Viewer, candidateId: string, input: { zone?: unknown } = {}): Promise<{ ok: true; agentId: string } | AgentFileRefusal> {
    if (viewer.role !== 'direction') return this.refuse(viewer, `candidate:${candidateId}`, 'role');
    if (!(await this.entretiens.acceptedIn(viewer.networkId, candidateId))) return { ok: false, rule: null, code: 'not_accepted' };
    const already = await this.db.first<{ agent_id: string }>('SELECT agent_id FROM agent_onboardings WHERE candidate_id = ?', [candidateId]);
    if (already) return { ok: true, agentId: already.agent_id };
    const c = (await this.db.first<{ first_name: string; last_name: string | null }>('SELECT first_name, last_name FROM candidates WHERE id = ?', [candidateId]))!;
    const zone = typeof input.zone === 'string' && input.zone.trim() !== '' && input.zone.trim().length <= 80 ? input.zone.trim() : null;
    // L'identifiant de l'agent est tiré de la candidature : deux entrées en même temps n'en créent qu'un [R18].
    const agentId = await agentIdFor(candidateId);
    const at = this.now().toISOString();
    // L'agent et son entrée dans un même lot : si l'un échoue, rien n'est gardé, et l'agent n'a aucun droit sans son entrée.
    const [, entry] = await runBatch(this.db, [
      {
        sql: "INSERT INTO agents (id, network_id, first_name, last_name, zone, status, sponsor_agent_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'active', NULL, ?, ?) ON CONFLICT (id) DO NOTHING",
        params: [agentId, viewer.networkId, c.first_name, c.last_name ?? '', zone, at, at],
      },
      {
        sql: 'INSERT INTO agent_onboardings (agent_id, network_id, candidate_id, created_by, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING',
        params: [agentId, viewer.networkId, candidateId, this.actor(viewer), at],
      },
    ]);
    const changes = entry!.changes;
    if (changes !== 1) return { ok: true, agentId };
    await appendEvent(this.journal, { type: 'agent.entre', actor: this.actor(viewer), subject: `agent:${agentId}`, data: { candidate: `candidate:${candidateId}` } }, this.now);
    return { ok: true, agentId };
  }

  /**
   * Range une pièce reçue, par sa référence de stockage dans le dossier de l'agent. La fin de validité est saisie
   * depuis le document, sauf pour l'attestation de vigilance, où le code la calcule [R82, R10].
   */
  async addPiece(viewer: Viewer, agentId: string, input: { kind: unknown; ref: unknown; issuedOn: unknown; validUntil?: unknown }): Promise<{ ok: true; value: AgentFileStatus } | AgentFileRefusal> {
    const denied = await this.gate(viewer, agentId, true);
    if (denied) return denied;
    const checked = await this.checkPiece(viewer, agentId, input);
    if (!checked.ok) return checked;
    const prefix = `agents/${agentId}/`;
    if (typeof input.ref !== 'string' || !input.ref.startsWith(prefix) || !REF_FILE.test(input.ref.slice(prefix.length))) return { ok: false, rule: null, code: 'bad_ref' };
    if (!(await this.pieces.has(input.ref))) return { ok: false, rule: null, code: 'not_stored' };
    return this.record(viewer, agentId, checked.kind, input.ref, checked.issuedOn, checked.validUntil, false);
  }

  /**
   * AU024 · L'agent (ou la direction) dépose le fichier même d'une pièce, depuis l'écran : tout est vérifié avant que
   * rien ne soit rangé (droits, pièce, dates, type, poids, premiers octets), puis le fichier est rangé sous un nom tiré
   * au hasard et la pièce enregistrée. L'accusé de réception dit la pièce, sa version et l'heure ; jamais la référence,
   * ni au journal [R82, R15, R13].
   */
  async addPieceFile(
    viewer: Viewer,
    agentId: string,
    input: { kind: unknown; issuedOn: unknown; validUntil?: unknown },
    file: { bytes: Uint8Array; contentType: unknown },
  ): Promise<{ ok: true; value: AgentFileStatus & { receipt: AgentPieceReceipt } } | AgentFileRefusal> {
    const denied = await this.gate(viewer, agentId, true);
    if (denied) return denied;
    const checked = await this.checkPiece(viewer, agentId, input);
    if (!checked.ok) return checked;
    const type = typeof file.contentType === 'string' ? file.contentType.split(';')[0]!.trim().toLowerCase() : '';
    // Seules les clés propres de la liste : `__proto__` ou `constructor` ne sont pas un type admis.
    const ext = Object.hasOwn(AGENT_PIECE_FILE_TYPES, type) ? (AGENT_PIECE_FILE_TYPES as Record<string, AgentPieceExt>)[type] : undefined;
    if (!ext) return { ok: false, rule: null, code: 'bad_file_type' };
    if (file.bytes.length === 0) return { ok: false, rule: null, code: 'empty_file' };
    if (file.bytes.length > AGENT_PIECE_MAX_BYTES) return { ok: false, rule: null, code: 'file_too_large' };
    if (!looksLike(ext, file.bytes)) return { ok: false, rule: null, code: 'bad_file' };
    if (!this.pieces.putFile) return { ok: false, rule: null, code: 'upload_unavailable' };
    const ref = await this.pieces.putFile(agentId, file.bytes, ext, type);
    const done = await this.record(viewer, agentId, checked.kind, ref, checked.issuedOn, checked.validUntil, false);
    if (!done.ok) return done;
    const line = done.value.lines.find((l) => l.kind === checked.kind)!;
    const receipt: AgentPieceReceipt = { kind: checked.kind, label: line.label, version: Number(line.version), receivedAt: this.now().toISOString(), bytes: file.bytes.length };
    return { ok: true, value: { ...done.value, receipt } };
  }

  /** La pièce et ses dates, vérifiées de la même façon pour une référence et pour un fichier déposé [R82, R15, R10]. */
  private async checkPiece(
    viewer: Viewer,
    agentId: string,
    input: { kind: unknown; issuedOn: unknown; validUntil?: unknown },
  ): Promise<{ ok: true; kind: AgentFilePiece; issuedOn: string; validUntil: string | null } | AgentFileRefusal> {
    if (typeof input.kind === 'string' && (FORBIDDEN_PIECES as readonly string[]).includes(input.kind)) {
      await appendEvent(this.journal, { type: 'dossier_agent.piece_refusee', actor: this.actor(viewer), subject: `agent:${agentId}`, data: { rule: 'R15', kind: input.kind } }, this.now);
      return { ok: false, rule: 'R15', code: 'forbidden_piece' };
    }
    if (typeof input.kind !== 'string' || !AGENT_FILE_PIECES.some((p) => p.kind === input.kind)) return { ok: false, rule: null, code: 'unknown_piece' };
    const kind = input.kind as AgentFilePiece;
    const today = this.today();
    if (!validDay(input.issuedOn) || input.issuedOn > today) return { ok: false, rule: null, code: 'bad_date' };
    const rule = VALIDITY[kind];
    let validUntil: string | null = null;
    if (rule === 'computed') validUntil = vigilanceUntil(input.issuedOn);
    else if (input.validUntil !== undefined && input.validUntil !== null && input.validUntil !== '') {
      if (rule === 'none' || !validDay(input.validUntil) || input.validUntil < input.issuedOn) return { ok: false, rule: null, code: 'bad_valid_until' };
      validUntil = input.validUntil;
    } else if (rule === 'required') return { ok: false, rule: 'R82', code: 'valid_until_required' };
    return { ok: true, kind, issuedOn: input.issuedOn, validUntil };
  }

  private async record(viewer: Viewer, agentId: string, kind: AgentFilePiece, ref: string, issuedOn: string, validUntil: string | null, draft: boolean): Promise<{ ok: true; value: AgentFileStatus } | AgentFileRefusal> {
    if (await this.db.first('SELECT 1 FROM agent_file_pieces WHERE ref = ?', [ref])) return { ok: false, rule: null, code: 'ref_used' };
    const last = await this.db.first<{ v: number | null }>('SELECT MAX(version) AS v FROM agent_file_pieces WHERE agent_id = ? AND kind = ?', [agentId, kind]);
    const version = Number(last?.v ?? 0) + 1;
    try {
      await this.db.run(
        'INSERT INTO agent_file_pieces (id, network_id, agent_id, kind, version, ref, issued_on, valid_until, is_draft, recorded_by, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [this.newId(), viewer.networkId, agentId, kind, version, ref, issuedOn, validUntil, draft ? 1 : 0, this.actor(viewer), this.now().toISOString()],
      );
    } catch (error) {
      if (/UNIQUE/i.test(String(error))) return { ok: false, rule: null, code: /\.ref/.test(String(error)) ? 'ref_used' : 'busy' };
      throw error;
    }
    await appendEvent(this.journal, { type: draft ? 'dossier_agent.projet_prepare' : 'dossier_agent.piece_rangee', actor: this.actor(viewer), subject: `agent:${agentId}`, data: { rule: 'R82', kind, version } }, this.now);
    return { ok: true, value: await this.compute(agentId, this.now()) };
  }

  /**
   * La direction prépare le contrat d'agent commercial ou l'attestation d'habilitation. Tant que les modèles ne sont
   * pas validés (H08), le document porte « PROJET » et ne compte jamais comme pièce signée [R82].
   */
  async prepareDraft(viewer: Viewer, agentId: string, kind: unknown): Promise<{ ok: true; value: AgentFileStatus } | AgentFileRefusal> {
    if (viewer.role !== 'direction') return this.refuse(viewer, `agent:${agentId}`, 'role');
    const denied = await this.gate(viewer, agentId, true);
    if (denied) return denied;
    if (typeof kind !== 'string' || !(DRAFTABLE_PIECES as readonly string[]).includes(kind)) return { ok: false, rule: null, code: 'not_draftable' };
    const agent = (await this.db.first<{ first_name: string; last_name: string }>('SELECT first_name, last_name FROM agents WHERE id = ?', [agentId]))!;
    const network = (await this.db.first<{ name: string }>('SELECT name FROM networks WHERE id = ?', [viewer.networkId]))!;
    const today = this.today();
    const text = [
      'PROJET — modèle en attente de validation juridique. Ne pas signer.',
      '',
      kind === 'contrat_agent_commercial' ? 'Contrat d’agent commercial' : 'Attestation d’habilitation',
      `Réseau : ${network.name}`,
      `Agent : ${agent.first_name} ${agent.last_name}`.trim(),
      `Préparé le ${frDate(today)}`,
    ].join('\n');
    const ref = await this.pieces.putDraft(agentId, text);
    return this.record(viewer, agentId, kind as AgentFilePiece, ref, today, null, true);
  }

  /** L'état du dossier, pour qui a le droit de le lire [R16]. */
  async status(viewer: Viewer, agentId: string): Promise<{ ok: true; value: AgentFileStatus } | AgentFileRefusal> {
    const denied = await this.gate(viewer, agentId, false);
    if (denied) return denied;
    const value = await this.compute(agentId, this.now());
    // La lecture est écrite au journal avant que le dossier soit rendu, sans référence ni nom [R16, R13].
    await appendEvent(this.journal, { type: 'dossier_agent.lu', actor: this.actor(viewer), subject: `agent:${agentId}`, data: { rule: 'R16', kind: 'agent_file' } }, this.now);
    return { ok: true, value };
  }

  /** Le dossier est-il complet et valide à cette date ? Lu par les droits d'accès au branchement (J13) [R82]. */
  async complete(networkId: string, agentId: string, at: Date): Promise<boolean> {
    const agent = await this.db.first<{ network_id: string; status: string }>('SELECT network_id, status FROM agents WHERE id = ?', [agentId]);
    if (!agent || agent.network_id !== networkId || agent.status !== 'active') return false;
    return (await this.compute(agentId, at)).complete;
  }

  private async compute(agentId: string, at: Date): Promise<AgentFileStatus> {
    return agentFileStatus(this.db, agentId, this.today(at));
  }

  /**
   * Les pièces qui arrivent à échéance dans les 30 jours : une alerte par pièce, une seule fois [R82]. Rendues au
   * planificateur (J13), qui préviendra l'agent ; rien n'est envoyé ici.
   */
  async dueAlerts(networkId: string): Promise<{ agentId: string; kind: AgentFilePiece; validUntil: string }[]> {
    const day = this.today();
    const limit = addDays(day, AGENT_PIECE_ALERT_DAYS);
    const rows = await this.db.all<PieceRow & { agent_id: string }>(
      `SELECT p.id, p.agent_id, p.kind, p.version, p.issued_on, p.valid_until, p.is_draft FROM agent_file_pieces p JOIN agents a ON a.id = p.agent_id
       WHERE p.network_id = ? AND a.status = 'active' AND p.is_draft = 0 AND p.valid_until IS NOT NULL AND p.valid_until >= ? AND p.valid_until <= ?
       AND p.version = (SELECT MAX(q.version) FROM agent_file_pieces q WHERE q.agent_id = p.agent_id AND q.kind = p.kind AND q.is_draft = 0)
       ORDER BY p.valid_until, p.agent_id, p.kind`,
      [networkId, day, limit],
    );
    const out: { agentId: string; kind: AgentFilePiece; validUntil: string }[] = [];
    for (const r of rows) {
      const { changes } = await this.db.run("INSERT INTO agent_file_alerts (piece_id, alert, network_id, agent_id, created_at) VALUES (?, 'j30', ?, ?, ?) ON CONFLICT DO NOTHING", [
        r.id,
        networkId,
        r.agent_id,
        this.now().toISOString(),
      ]);
      if (changes === 1) out.push({ agentId: r.agent_id, kind: r.kind, validUntil: r.valid_until! });
    }
    return out;
  }
}
export const AGENT_PIECE_VALIDITY = VALIDITY;
