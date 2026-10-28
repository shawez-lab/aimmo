/**
 * L'état du dossier d'un agent (M14, J04), à un jour donné [R82] : chaque pièce attendue, manquante, en projet, échue
 * ou valide, et l'étape suivante en une phrase. Sans dépendance au reste du métier, pour que les droits d'accès et le
 * contrôle des envois le lisent (J13) sans tirer les autres modules.
 */
import type { SqlDatabase } from '../db/sql.ts';
import { AGENT_FILE_PIECES, type AgentFilePiece } from './entretiens.ts';

export type PieceState = 'manquante' | 'projet' | 'echue' | 'valide';

export interface AgentFileLine {
  kind: AgentFilePiece;
  label: string;
  state: PieceState;
  version: number | null;
  issuedOn: string | null;
  validUntil: string | null;
}

export interface AgentFileStatus {
  agentId: string;
  complete: boolean;
  lines: AgentFileLine[];
  missing: AgentFilePiece[];
  expired: AgentFilePiece[];
  drafts: AgentFilePiece[];
  /** L'étape suivante, en une phrase. */
  nextStep: string;
}

export interface PieceRow {
  id: string;
  kind: AgentFilePiece;
  version: number;
  issued_on: string;
  valid_until: string | null;
  is_draft: number;
}

const frDate = (day: string): string => `${day.slice(8, 10)}/${day.slice(5, 7)}/${day.slice(0, 4)}`;
const lower = (s: string): string => s.charAt(0).toLocaleLowerCase('fr') + s.slice(1);

/** L'état du dossier de l'agent au jour `day` (heure de Paris, `AAAA-MM-JJ`). */
export async function agentFileStatus(db: SqlDatabase, agentId: string, day: string): Promise<AgentFileStatus> {
    const rows = await db.all<PieceRow>('SELECT id, kind, version, issued_on, valid_until, is_draft FROM agent_file_pieces WHERE agent_id = ? ORDER BY kind, version', [agentId]);
    const lines: AgentFileLine[] = AGENT_FILE_PIECES.map(({ kind, label }) => {
      const mine = rows.filter((r) => r.kind === kind);
      // La dernière pièce signée compte ; un projet ne remplace jamais une pièce signée.
      const signed = mine.filter((r) => r.is_draft === 0).at(-1);
      const draft = mine.filter((r) => r.is_draft === 1).at(-1);
      const shown = signed ?? draft;
      let state: PieceState = 'manquante';
      if (signed) state = signed.valid_until !== null && signed.valid_until < day ? 'echue' : 'valide';
      else if (draft) state = 'projet';
      return { kind, label, state, version: shown ? Number(shown.version) : null, issuedOn: shown?.issued_on ?? null, validUntil: signed?.valid_until ?? null };
    });
    const missing = lines.filter((l) => l.state === 'manquante').map((l) => l.kind);
    const expired = lines.filter((l) => l.state === 'echue').map((l) => l.kind);
    const drafts = lines.filter((l) => l.state === 'projet').map((l) => l.kind);
    const complete = lines.every((l) => l.state === 'valide');
    const first = lines.find((l) => l.state !== 'valide');
    let nextStep = 'Votre dossier est complet : l’accès à vos clients est ouvert.';
    if (first?.state === 'manquante') nextStep = `Déposez votre ${lower(first.label)}.`;
    else if (first?.state === 'projet') nextStep = `Votre ${lower(first.label)} est encore un projet : déposez-le une fois signé.`;
    else if (first?.state === 'echue') nextStep = `Votre ${lower(first.label)} a expiré le ${frDate(first.validUntil!)} : déposez la nouvelle.`;
    return { agentId, complete, lines, missing, expired, drafts, nextStep };
  }
