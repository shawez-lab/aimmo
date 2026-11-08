/**
 * HX47 · Dossiers de location contrôlés contre la fraude [R530, R531, R532, R533, R534].
 *
 * L'agent du logement lit une pièce déjà rangée dans une candidature (W04) : le code 2D-Doc et ce qui est imprimé sur
 * l'avis d'impôt, les montants des trois derniers bulletins, le numéro SIRET de l'employeur. Le code contrôle ce qui se
 * vérifie et rend un constat ligne par ligne, à l'agent seul.
 *
 * Décidé, lecture prudente :
 * - seules trois sortes de la liste officielle se contrôlent : avis d'imposition, bulletins de salaire, contrat de
 *   travail ; aucune autre pièce n'est demandée pour contrôler [R104] ;
 * - le constat n'est ni une note, ni un total, ni un rang : il ne change ni l'ordre d'arrivée, ni la complétude, ni ce
 *   que voit le propriétaire, qui ne le voit jamais [R14, R105, R530] ;
 * - seul le constat est rangé, en ajout seul : jamais une valeur lue (revenu, montant, référence, numéro fiscal ou
 *   SIRET), ni dans la base ni au journal [R534, R13, R17] ;
 * - un nouveau contrôle de la même pièce s'ajoute en nouvelle version ; la dernière vaut.
 */
import type { Viewer } from '../acces/droits.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import type { LocationRefusal, MisesEnLocation } from '../location/logement.ts';
import { checkEmployerFindings, checkPayslips, checkTaxNotice, CONTROLS, findingText, type Finding, type PayslipRead, type TaxNoticeRead } from './controles.ts';
import type { TrustList } from './deux-d-doc.ts';
import type { CompanyRegistry } from './entreprise.ts';

/** Les sortes de la liste officielle que le code sait contrôler. */
export const CHECKABLE_SORTS = ['avis_imposition', 'bulletins_salaire', 'contrat_travail'] as const;
export type CheckableSort = (typeof CHECKABLE_SORTS)[number];

export interface PieceCheck {
  pieceId: string;
  sort: CheckableSort;
  holder: string;
  version: number;
  checkedAt: string;
  findings: (Finding & { text: string })[];
}

export type CheckRefusal = LocationRefusal;
export type CheckResult<T> = { ok: true; value: T } | CheckRefusal;

export interface ControleDossiersOptions {
  now?: () => Date;
}

interface PieceRow {
  id: string;
  application_id: string;
  listing_id: string;
  holder: string;
  sort: string;
}

const MAX_PAYSLIPS = 6;
const DAY = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

const isPlain = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export class ControleDossiers {
  private readonly now: () => Date;

  constructor(
    private readonly db: SqlDatabase,
    private readonly listings: MisesEnLocation,
    private readonly trust: TrustList,
    private readonly registry: CompanyRegistry,
    private readonly journal: JournalStore,
    options: ControleDossiersOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  private actor(viewer: Viewer): string {
    return `${String(viewer.role)}:${viewer.userId}`;
  }

  /** Le constat est à l'agent du logement seul : ni la direction ni un autre rôle ne le fait ni ne le lit [R530]. */
  private async agentOnly(viewer: Viewer, subject: string): Promise<CheckRefusal | null> {
    if (viewer.role === 'agent') return null;
    await appendEvent(this.journal, { type: 'acces.refuse', actor: this.actor(viewer), subject, data: { rule: 'R16', role: String(viewer.role), kind: 'piece_findings', code: 'agent_only' } }, this.now);
    return { ok: false, rule: 'R16', code: 'agent_only' };
  }

  /** La pièce et son logement, sous les droits d'écriture de l'agent du logement [R16]. */
  private async piece(viewer: Viewer, pieceId: unknown): Promise<CheckRefusal | PieceRow> {
    const refused = await this.agentOnly(viewer, `piece:${String(pieceId).slice(0, 100)}`);
    if (refused) return refused;
    const row =
      typeof pieceId === 'string' && pieceId.length <= 100
        ? await this.db.first<PieceRow>(
            `SELECT p.id, p.application_id, a.listing_id, p.holder, p.sort FROM rental_application_pieces p
             JOIN rental_applications a ON a.id = p.application_id
             WHERE p.id = ? AND a.network_id = ?`,
            [pieceId, viewer.networkId],
          )
        : null;
    const listing = await this.listings.listing(viewer, row?.listing_id ?? `piece:${String(pieceId).slice(0, 100)}`, true);
    if ('ok' in listing) return listing;
    return row!;
  }

  private async findingsFor(row: PieceRow, read: Record<string, unknown>, today: string): Promise<Finding[] | null> {
    const sort = row.sort as CheckableSort;
    if (sort === 'avis_imposition') {
      const printed = read.printed;
      if (printed !== undefined && !isPlain(printed)) return null;
      return checkTaxNotice({ twoDDoc: read.twoDDoc, ...(printed === undefined ? {} : { printed: printed as NonNullable<TaxNoticeRead['printed']> }) }, this.trust, today);
    }
    if (sort === 'bulletins_salaire') {
      const slips = read.payslips;
      if (!Array.isArray(slips) || slips.length === 0 || slips.length > MAX_PAYSLIPS || !slips.every(isPlain)) return null;
      return checkPayslips(slips as PayslipRead[], this.registry);
    }
    // La date de signature du contrat ou de l'attestation : l'établissement est jugé ce jour-là. Sans elle, un
    // établissement fermé depuis ne dit rien de la pièce : non vérifiable [R532].
    const signedOn = read.signedOn;
    if (signedOn !== undefined && (typeof signedOn !== 'string' || !DAY.test(signedOn) || signedOn > today)) return null;
    return checkEmployerFindings(this.registry, read.siret, (signedOn as string | undefined) ?? null);
  }

  /** Contrôle une pièce rangée et range le constat, en nouvelle version. */
  async check(viewer: Viewer, pieceId: unknown, read: unknown): Promise<CheckResult<PieceCheck>> {
    const row = await this.piece(viewer, pieceId);
    if ('ok' in row) return row;
    if (!(CHECKABLE_SORTS as readonly string[]).includes(row.sort)) return { ok: false, rule: null, code: 'not_checkable' };
    if (!isPlain(read)) return { ok: false, rule: null, code: 'bad_read' };
    const at = this.now().toISOString();
    const findings = await this.findingsFor(row, read, at.slice(0, 10));
    if (findings === null) return { ok: false, rule: null, code: 'bad_read' };
    for (let attempt = 0; attempt < 5; attempt++) {
      const last = await this.db.first<{ v: number | null }>('SELECT MAX(version) AS v FROM rental_piece_findings WHERE piece_id = ?', [row.id]);
      const version = (last?.v ?? 0) + 1;
      try {
        await this.db.run(
          'INSERT INTO rental_piece_findings (piece_id, version, network_id, application_id, findings, checked_by, checked_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [row.id, version, viewer.networkId, row.application_id, JSON.stringify(findings), this.actor(viewer), at],
        );
      } catch (error) {
        if (attempt < 4 && (await this.db.first('SELECT 1 FROM rental_piece_findings WHERE piece_id = ? AND version = ?', [row.id, version]))) continue;
        throw error;
      }
      await appendEvent(
        this.journal,
        {
          type: 'location.piece_controlee',
          actor: this.actor(viewer),
          subject: `rental_application:${row.application_id}`,
          data: { piece: row.id, sort: row.sort, version, findings: findings.map((f) => (f.month ? [f.control, f.outcome, f.month] : [f.control, f.outcome])) },
        },
        this.now,
      );
      return { ok: true, value: this.view(row, version, at, findings) };
    }
    return { ok: false, rule: null, code: 'busy' };
  }

  private view(row: PieceRow, version: number, checkedAt: string, findings: Finding[]): PieceCheck {
    return { pieceId: row.id, sort: row.sort as CheckableSort, holder: row.holder, version, checkedAt, findings: findings.map((f) => ({ ...f, text: findingText(f) })) };
  }

  /** Le dernier constat de chaque pièce contrôlée d'une candidature, pour l'agent du logement seul [R16, R530]. */
  async read(viewer: Viewer, applicationId: unknown): Promise<CheckResult<PieceCheck[]>> {
    const refused = await this.agentOnly(viewer, `rental_application:${String(applicationId).slice(0, 100)}`);
    if (refused) return refused;
    const app =
      typeof applicationId === 'string' && applicationId.length <= 100
        ? await this.db.first<{ listing_id: string }>('SELECT listing_id FROM rental_applications WHERE id = ? AND network_id = ?', [applicationId, viewer.networkId])
        : null;
    const listing = await this.listings.listing(viewer, app?.listing_id ?? `application:${String(applicationId).slice(0, 100)}`, true);
    if ('ok' in listing) return listing;
    const rows = await this.db.all<PieceRow & { version: number; checked_at: string; findings: string }>(
      `SELECT p.id, p.application_id, ? AS listing_id, p.holder, p.sort, f.version, f.checked_at, f.findings
       FROM rental_piece_findings f JOIN rental_application_pieces p ON p.id = f.piece_id
       WHERE f.application_id = ? AND f.version = (SELECT MAX(g.version) FROM rental_piece_findings g WHERE g.piece_id = f.piece_id)
       ORDER BY p.added_at, p.id`,
      [app!.listing_id, applicationId as string],
    );
    await appendEvent(this.journal, { type: 'location.lue', actor: this.actor(viewer), subject: `rental_application:${applicationId as string}`, data: { rule: 'R16', what: 'piece_findings' } }, this.now);
    const known = new Set<string>(CONTROLS);
    return {
      ok: true,
      value: rows.map((r) => {
        const findings = (JSON.parse(r.findings) as Finding[]).filter((f) => known.has(f.control));
        return this.view(r, r.version, r.checked_at, findings);
      }),
    };
  }
}
