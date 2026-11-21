/**
 * Le tableau de mise en service du réseau (AU088) [R675, R221, R16, R17].
 *
 * Carte professionnelle, garantie financière, assurance de responsabilité civile professionnelle, adhésion au médiateur
 * de la consommation et relecture des mentions par l'avocat : chacune se déclare par la direction avec sa preuve (numéro,
 * émetteur, référence du document, dates de validité). Le tableau dit, pour le jour de la lecture, si chaque preuve est
 * valide, expirée, à venir, retirée ou en écart, et ferme les fonctions qui en dépendent tant qu'une manque.
 *
 * AIMMO ne vérifie pas la situation réelle : le tableau dit ce que la direction a déclaré, jamais plus.
 *
 * Jamais vu : une preuve ne vaut que si elle dit la même chose que ce que le réseau montre. Le numéro de carte de la
 * preuve doit être celui écrit sur les annonces et le site, le médiateur de la preuve celui proposé aux clients qui se
 * plaignent, et la relecture de l'avocat doit être postérieure au dernier changement de ce que montre la page des
 * mentions (ses réglages, le numéro et le titulaire de la carte) : un changement après la relecture la rend « à relire ».
 */
import type { Viewer } from '../acces/droits.ts';
// La page des mentions et ce tableau lisent le numéro affiché par la même fonction (import croisé, lu à l'appel seulement).
import { displayedCardNumber } from '../attirer/mentions-site.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';

export const LAUNCH_PREREQUISITES = {
  carte: 'Carte professionnelle « transaction » du réseau',
  garantie: 'Garantie financière',
  assurance: 'Assurance de responsabilité civile professionnelle',
  mediateur: 'Adhésion au médiateur de la consommation',
  mentions: 'Relecture des mentions légales par l’avocat',
} as const;
export type LaunchPrerequisite = keyof typeof LAUNCH_PREREQUISITES;
const PREREQUISITES = Object.keys(LAUNCH_PREREQUISITES) as LaunchPrerequisite[];

/** Les fonctions fermées tant qu'une de leurs preuves n'est pas valide. */
export const LAUNCH_FEATURES = {
  site_reel: { label: 'Site en réel : indexé et signalé aux moteurs', needs: ['carte', 'garantie', 'assurance', 'mediateur', 'mentions'] },
} as const satisfies Record<string, { label: string; needs: readonly LaunchPrerequisite[] }>;
export type LaunchFeature = keyof typeof LAUNCH_FEATURES;

/** Une preuve qui expire dans ce nombre de jours ou moins se signale. */
export const LAUNCH_SOON_DAYS = 30;

export type LaunchState = 'valide' | 'manquante' | 'a_venir' | 'expiree' | 'retiree' | 'ecart' | 'a_relire';

export interface LaunchProof {
  version: number;
  documentNumber: string;
  issuer: string;
  proofRef: string;
  validFrom: string;
  validUntil: string | null;
  declaredAt: string;
}

export interface LaunchLine {
  prerequisite: LaunchPrerequisite;
  label: string;
  state: LaunchState;
  /** La preuve qui vaut le jour de la lecture, ou la dernière retirée ou expirée. */
  proof: LaunchProof | null;
  /** Une preuve déclarée qui ne vaut pas encore (un renouvellement). */
  next: LaunchProof | null;
  /** Jours restants jusqu'à la fin de validité incluse, quand elle est connue. */
  daysLeft: number | null;
  soon: boolean;
  /** Pour un écart : ce que le réseau montre et que la preuve ne dit pas. */
  gap: 'numero_affiche' | 'mediateur_propose' | null;
}

export interface LaunchBoard {
  day: string;
  lines: LaunchLine[];
  features: { feature: LaunchFeature; label: string; open: boolean; closedBy: LaunchPrerequisite[] }[];
  /** Toujours faux : AIMMO ne vérifie pas la situation réelle. */
  verified: false;
}

export type LaunchResult = { ok: true; version: number } | { ok: false; rule: 'R16' | null; code: string };

interface Row {
  prerequisite: string;
  version: number;
  withdrawn: number;
  document_number: string | null;
  issuer: string | null;
  proof_ref: string | null;
  valid_from: string | null;
  valid_until: string | null;
  set_at: string;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const isDay = (v: unknown): v is string => {
  if (typeof v !== 'string' || !DAY.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
};
const isPrerequisite = (v: unknown): v is LaunchPrerequisite => typeof v === 'string' && Object.hasOwn(LAUNCH_PREREQUISITES, v);

/** Le jour à Paris : une preuve vaut jusqu'à la fin de son dernier jour, heure de Paris. */
export function launchDay(at: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
}

/** Un numéro ou un nom comparé sans casse, accents, espaces ni ponctuation. */
export function sameLaunchText(a: string, b: string): boolean {
  const n = (s: string): string => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return n(a) !== '' && n(a) === n(b);
}

const daysBetween = (from: string, to: string): number => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

const text = (v: unknown, max: number): string | null => {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t === '' || t.length > max || /[<>]/.test(t) ? null : t;
};

const toProof = (r: Row): LaunchProof => ({
  version: r.version,
  documentNumber: r.document_number ?? '',
  issuer: r.issuer ?? '',
  proofRef: r.proof_ref ?? '',
  validFrom: r.valid_from ?? '',
  validUntil: r.valid_until,
  declaredAt: r.set_at,
});

export class MiseEnService {
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(
    private readonly db: SqlDatabase,
    private readonly journal: JournalStore,
    options: { now?: () => Date; newId?: () => string } = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => crypto.randomUUID());
  }

  /**
   * La direction déclare une preuve, ou la retire (`{ prerequisite, withdrawn: true }`). Chaque déclaration s'ajoute en
   * nouvelle version [R17]. La fin de validité est exigée, sauf pour la relecture des mentions, qui n'en a pas.
   */
  async declare(viewer: Viewer, input: unknown): Promise<LaunchResult> {
    if (viewer.role !== 'direction') {
      await appendEvent(this.journal, { type: 'acces.refuse', actor: `${String(viewer.role)}:${viewer.userId}`, subject: null, data: { rule: 'R16', role: String(viewer.role), kind: 'mise_en_service', code: 'role' } }, this.now);
      return { ok: false, rule: 'R16', code: 'role' };
    }
    if (typeof input !== 'object' || input === null || Array.isArray(input)) return { ok: false, rule: null, code: 'preuve_invalide' };
    const b = input as Record<string, unknown>;
    if (!isPrerequisite(b.prerequisite)) return { ok: false, rule: null, code: 'prerequis_inconnu' };
    const prerequisite = b.prerequisite;
    let values: [number, string | null, string | null, string | null, string | null, string | null];
    if (b.withdrawn === true) {
      if (Object.keys(b).some((k) => k !== 'prerequisite' && k !== 'withdrawn')) return { ok: false, rule: null, code: 'preuve_invalide' };
      values = [1, null, null, null, null, null];
    } else {
      if (b.withdrawn !== undefined && b.withdrawn !== false) return { ok: false, rule: null, code: 'preuve_invalide' };
      const documentNumber = text(b.documentNumber, 120);
      const issuer = text(b.issuer, 120);
      const proofRef = text(b.proofRef, 200);
      if (!documentNumber || !issuer || !proofRef) return { ok: false, rule: null, code: 'preuve_invalide' };
      if (!isDay(b.validFrom)) return { ok: false, rule: null, code: 'date_invalide' };
      let validUntil: string | null = null;
      if (prerequisite === 'mentions') {
        if (b.validUntil !== undefined && b.validUntil !== null) return { ok: false, rule: null, code: 'date_invalide' };
        // Une relecture se date au jour où l'avocat l'a faite, jamais dans l'avenir.
        if (b.validFrom > launchDay(this.now())) return { ok: false, rule: null, code: 'date_invalide' };
      } else {
        if (!isDay(b.validUntil) || b.validUntil < b.validFrom) return { ok: false, rule: null, code: 'date_invalide' };
        validUntil = b.validUntil;
      }
      values = [0, documentNumber, issuer, proofRef, b.validFrom, validUntil];
    }
    const at = this.now().toISOString();
    const id = this.newId();
    await this.db.run(
      `INSERT INTO launch_proofs (id, network_id, prerequisite, version, withdrawn, document_number, issuer, proof_ref, valid_from, valid_until, set_by, set_at)
       SELECT ?, ?, ?, COALESCE(MAX(version), 0) + 1, ?, ?, ?, ?, ?, ?, ?, ? FROM launch_proofs WHERE network_id = ? AND prerequisite = ?`,
      [id, viewer.networkId, prerequisite, ...values, `direction:${viewer.userId}`, at, viewer.networkId, prerequisite],
    );
    // La version de cette déclaration-ci, relue par son identifiant : une autre déclaration simultanée ne la change pas.
    const row = await this.db.first<{ version: number }>('SELECT version FROM launch_proofs WHERE id = ?', [id]);
    const version = row!.version;
    await appendEvent(this.journal, { type: 'conformite.mise_en_service', actor: `direction:${viewer.userId}`, subject: `network:${viewer.networkId}`, data: { rule: 'R675', prerequisite, version, withdrawn: values[0] === 1 } }, this.now);
    return { ok: true, version };
  }

  /** Le tableau du jour : chaque preuve et son état, et les fonctions qu'elles ouvrent ou ferment. */
  async board(networkId: string): Promise<LaunchBoard> {
    const day = launchDay(this.now());
    const rows = await this.db.all<Row>(
      'SELECT prerequisite, version, withdrawn, document_number, issuer, proof_ref, valid_from, valid_until, set_at FROM launch_proofs WHERE network_id = ? ORDER BY prerequisite, version',
      [networkId],
    );
    const card = await displayedCardNumber(this.db, networkId);
    const mediator = await this.db.first<{ mediator_name: string }>('SELECT mediator_name FROM complaint_settings WHERE network_id = ? ORDER BY version DESC LIMIT 1', [networkId]);
    // Tout ce que la page des mentions montre : ses réglages, et le numéro et le titulaire de la carte, lus ailleurs.
    const changes = await this.db.all<{ at: string | null }>(
      `SELECT MAX(CASE WHEN set_at >= '0000' AND set_at < ':' THEN set_at END) AS at FROM site_legal_mentions WHERE network_id = ?
       UNION ALL SELECT MAX(CASE WHEN set_at >= '0000' AND set_at < ':' THEN set_at END) FROM card_holders WHERE network_id = ?
       UNION ALL SELECT MAX(CASE WHEN set_at >= '0000' AND set_at < ':' THEN set_at END) FROM listing_settings WHERE network_id = ?`,
      [networkId, networkId, networkId],
    );
    const mentionChange = changes.map((c) => c.at).filter((at): at is string => typeof at === 'string' && ISO.test(at) && !Number.isNaN(Date.parse(at))).sort().at(-1) ?? null;
    const lines = PREREQUISITES.map((p) => this.line(p, rows.filter((r) => r.prerequisite === p), day, { card, mediator: mediator?.mediator_name ?? null, mentionChange }));
    const byId = new Map(lines.map((l) => [l.prerequisite, l]));
    const features = (Object.keys(LAUNCH_FEATURES) as LaunchFeature[]).map((feature) => {
      const closedBy = LAUNCH_FEATURES[feature].needs.filter((p) => byId.get(p)!.state !== 'valide');
      return { feature, label: LAUNCH_FEATURES[feature].label, open: closedBy.length === 0, closedBy };
    });
    return { day, lines, features, verified: false };
  }

  /** Une fonction est-elle ouverte ce jour ? Sinon, les preuves qui la ferment. */
  async gate(networkId: string, feature: LaunchFeature): Promise<{ open: boolean; closedBy: LaunchPrerequisite[] }> {
    const f = (await this.board(networkId)).features.find((x) => x.feature === feature)!;
    return { open: f.open, closedBy: f.closedBy };
  }

  private line(p: LaunchPrerequisite, rows: Row[], day: string, shown: { card: string | null; mediator: string | null; mentionChange: string | null }): LaunchLine {
    // La dernière version déjà en vigueur ce jour (un retrait vaut dès sa déclaration) ; une version plus récente qui
    // ne vaut pas encore est un renouvellement annoncé.
    const applicable = rows.filter((r) => r.withdrawn === 1 || (r.valid_from !== null && r.valid_from <= day));
    const current = applicable.at(-1) ?? null;
    const future = rows.filter((r) => r.withdrawn === 0 && r.valid_from !== null && r.valid_from > day && r.version > (current?.version ?? 0)).at(-1) ?? null;
    const base: LaunchLine = { prerequisite: p, label: LAUNCH_PREREQUISITES[p], state: 'manquante', proof: null, next: future ? toProof(future) : null, daysLeft: null, soon: false, gap: null };
    if (!current) return { ...base, state: future ? 'a_venir' : 'manquante' };
    if (current.withdrawn === 1) return { ...base, state: 'retiree' };
    const proof = toProof(current);
    const daysLeft = current.valid_until ? daysBetween(day, current.valid_until) : null;
    const line = { ...base, proof, daysLeft };
    if (daysLeft !== null && daysLeft < 0) return { ...line, state: 'expiree' };
    if (p === 'carte' && shown.card && !sameLaunchText(shown.card, proof.documentNumber)) return { ...line, state: 'ecart', gap: 'numero_affiche' };
    if (p === 'mediateur' && shown.mediator && !sameLaunchText(shown.mediator, proof.issuer)) return { ...line, state: 'ecart', gap: 'mediateur_propose' };
    // Une mention changée après le jour de la relecture, ou après sa déclaration, n'a pas été relue.
    if (p === 'mentions' && shown.mentionChange && (launchDay(new Date(shown.mentionChange)) > proof.validFrom || shown.mentionChange > proof.declaredAt)) return { ...line, state: 'a_relire' };
    // Un renouvellement déjà annoncé couvre la suite : pas d'alerte de fin proche.
    const soon = daysLeft !== null && daysLeft <= LAUNCH_SOON_DAYS && !(future && future.valid_from !== null && current.valid_until !== null && daysBetween(current.valid_until, future.valid_from) <= 1);
    return { ...line, state: 'valide', soon };
  }
}
