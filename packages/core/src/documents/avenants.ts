/**
 * L'avenant au mandat (M06, D07).
 *
 * Un avenant est généré depuis son modèle (D02), rattaché à un mandat signé et numéroté par sa référence et son
 * numéro au registre ; il change le prix ou la durée du mandat. Il passe les mêmes contrôles que le mandat (D03), plus
 * celui du mandat en vigueur, et s'enregistre de la même façon, signé sur papier, avec son exemplaire. Le prix et la
 * durée du mandat ne changent qu'une fois l'avenant signé ; le mandat garde l'historique de ses avenants, et rien ne
 * s'efface [R17].
 *
 * Décidé, lecture prudente : un avenant change le prix ou la durée, rien d'autre tant que des conditions écrites par
 * l'agent ne sont pas prévues par un modèle validé (l'IA ne rédige aucune clause [R40]). Il ne touche pas au prix
 * affiché du bien, qui relève de la diffusion (M07).
 */
import type { Acces } from '../acces/acces.ts';
import type { Viewer } from '../acces/droits.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { localTime } from '../envoi/horaires.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import { ControlesSignature, type SignatureCheck } from './controles.ts';
import { escapeHtml, fillSignatureFields, sha256 } from './modeles.ts';
import { mandateTerms, type MandateTerms } from './conditions.ts';
import { mandateScanPrefix } from './mandat-du-bien.ts';
import { SIGNATURE_PLACES, type SignaturePlace } from './signature-papier.ts';

const SCAN_REF = /^[A-Za-z0-9/_.-]{1,200}$/;
const PLACE_LABEL: Record<SignaturePlace, string> = { agence: 'à l’agence', hors_agence: 'hors de l’agence', distance: 'à distance' };

type Refusal = { ok: false; rule: 'R16'; code: string };
type Problem =
  | { ok: false; rule: 'R41'; code: 'checks_failed'; check: SignatureCheck }
  | { ok: false; rule: null; code: 'bad_date' | 'bad_place' | 'bad_scan' | 'not_an_amendment' | 'already_signed' | 'no_mandate' | 'before_mandate' | 'bad_schedule' | 'bad_piece' | 'unknown_document' | 'depot_ferme' | 'scan_absent' | 'scan_deja_utilise' };

export interface AmendmentSignatureOptions {
  now?: () => Date;
  newId?: () => string;
  /**
   * Le stockage où le scan doit se trouver (D14), comme à la signature du mandat. Donné : la référence doit être celle d'un
   * scan du bien du mandat, présent dans le stockage, et qui n'a encore prouvé aucune signature. Nul : aucun stockage, rien
   * ne se signe. Absent : non vérifié, pour les appelants internes ; la route donne toujours l'un ou l'autre.
   */
  scans?: { has(ref: string): Promise<boolean> } | null;
}

export class SignatureAvenant {
  private readonly now: () => Date;
  private readonly controles: ControlesSignature;

  constructor(
    private readonly db: SqlDatabase,
    private readonly acces: Acces,
    private readonly journal: JournalStore,
    private readonly options: AmendmentSignatureOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.controles = new ControlesSignature(db, acces, journal, options);
  }

  private actor(viewer: Viewer): string {
    return `${String(viewer.role)}:${viewer.userId}`;
  }

  /** Enregistre un avenant signé sur papier, contrôlé à l'instant ; une seule fois. */
  async register(viewer: Viewer, documentId: string, input: { signedAt: Date; place: SignaturePlace; scanRef: string }): Promise<{ ok: true; value: { documentId: string; mandateId: string; copyHash: string } } | Refusal | Problem> {
    if (!(input.signedAt instanceof Date) || Number.isNaN(input.signedAt.getTime()) || input.signedAt.getTime() > this.now().getTime()) return { ok: false, rule: null, code: 'bad_date' };
    if (!(SIGNATURE_PLACES as readonly string[]).includes(input.place)) return { ok: false, rule: null, code: 'bad_place' };
    if (typeof input.scanRef !== 'string' || !SCAN_REF.test(input.scanRef) || input.scanRef.includes('..')) return { ok: false, rule: null, code: 'bad_scan' };
    if (viewer.role !== 'agent' && viewer.role !== 'direction') {
      await appendEvent(this.journal, { type: 'acces.refuse', actor: this.actor(viewer), subject: `document:${documentId}`, data: { rule: 'R16', role: String(viewer.role), kind: 'amendment', code: 'role' } }, this.now);
      return { ok: false, rule: 'R16', code: 'role' };
    }
    const doc = await this.db.first<{ id: string; network_id: string; kind: string; content: string; mandate_id: string | null }>('SELECT id, network_id, kind, content, mandate_id FROM documents WHERE id = ?', [documentId]);
    if (!doc || doc.network_id !== viewer.networkId) {
      await appendEvent(this.journal, { type: 'acces.refuse', actor: this.actor(viewer), subject: `document:${documentId}`, data: { rule: 'R16', role: String(viewer.role), kind: 'amendment', code: 'unknown' } }, this.now);
      return { ok: false, rule: 'R16', code: 'unknown' };
    }
    if (doc.kind !== 'avenant_mandat') return { ok: false, rule: null, code: 'not_an_amendment' };
    if (!doc.mandate_id) return { ok: false, rule: null, code: 'no_mandate' };

    const checked = await this.controles.check(viewer, documentId, { signedAt: input.signedAt });
    if (!checked.ok) return checked;
    const existing = await this.db.first<{ document_id: string; mandate_id: string; copy_hash: string }>('SELECT document_id, mandate_id, copy_hash FROM signed_amendments WHERE document_id = ?', [documentId]);
    if (existing) {
      await this.ensureEvent(viewer, documentId, existing.mandate_id);
      return { ok: false, rule: null, code: 'already_signed' };
    }
    if (!checked.value.passed) return { ok: false, rule: 'R41', code: 'checks_failed', check: checked.value };
    const mandate = await this.db.first<{ signed_at: string; number: string }>('SELECT signed_at, number FROM signed_documents WHERE mandate_id = ?', [doc.mandate_id]);
    if (!mandate) return { ok: false, rule: null, code: 'no_mandate' };
    // Un avenant suit son mandat : il ne peut pas être signé avant lui.
    // Le jour de Paris compte : l'écran donne un jour, et l'heure d'un jour passé ne dit rien de l'ordre des deux signatures.
    if (localTime(input.signedAt, 'Europe/Paris').date < localTime(new Date(mandate.signed_at), 'Europe/Paris').date) return { ok: false, rule: null, code: 'before_mandate' };
    // Un scan qui n'existe pas n'est pas une preuve. Un avenant déjà signé est reparti plus haut : il garde son scan.
    const scanProblem = await this.scanProblem(doc.mandate_id, input.scanRef);
    if (scanProblem) return { ok: false, rule: null, code: scanProblem };

    const day = localTime(input.signedAt, 'Europe/Paris').date;
    const copy = fillSignatureFields(doc.content, {
      'registre.numero': mandate.number,
      'signature.date': `${day.slice(8, 10)}/${day.slice(5, 7)}/${day.slice(0, 4)}`,
      'signature.lieu': PLACE_LABEL[input.place],
    });
    // L'avenant porte le numéro du mandat qu'il modifie.
    if (!copy.includes(escapeHtml(mandate.number))) return { ok: false, rule: null, code: 'no_mandate' };
    const copyHash = await sha256(copy);
    let changes: number;
    try {
      ({ changes } = await this.db.run(
        `INSERT INTO signed_amendments (document_id, network_id, mandate_id, signed_at, place, scan_ref, copy_content, copy_hash, registered_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (document_id) DO NOTHING`,
        [documentId, viewer.networkId, doc.mandate_id, input.signedAt.toISOString(), input.place, input.scanRef, copy, copyHash, this.actor(viewer), this.now().toISOString()],
      ));
    } catch (error) {
      // Course perdue : une autre signature a pris ce scan entre le contrôle et l'écriture (index et déclencheurs de 1570).
      if (this.options.scans && (await this.scanUsed(input.scanRef))) return { ok: false, rule: null, code: 'scan_deja_utilise' };
      throw error;
    }
    if (changes !== 1) return { ok: false, rule: null, code: 'already_signed' };
    await this.ensureEvent(viewer, documentId, doc.mandate_id);
    return { ok: true, value: { documentId, mandateId: doc.mandate_id, copyHash } };
  }

  private async scanUsed(scanRef: string): Promise<boolean> {
    return Boolean(await this.db.first('SELECT 1 FROM signed_documents WHERE scan_ref = ? UNION ALL SELECT 1 FROM signed_amendments WHERE scan_ref = ?', [scanRef, scanRef]));
  }

  /** Le même contrôle qu'à la signature du mandat (D11), sur le bien du mandat modifié. */
  private async scanProblem(mandateId: string, scanRef: string): Promise<'depot_ferme' | 'bad_scan' | 'scan_absent' | 'scan_deja_utilise' | null> {
    const scans = this.options.scans;
    if (scans === undefined) return null;
    if (scans === null) return 'depot_ferme';
    const mandate = await this.db.first<{ property_id: string | null }>('SELECT property_id FROM mandates WHERE id = ?', [mandateId]);
    if (!mandate?.property_id || !scanRef.startsWith(mandateScanPrefix(mandate.property_id))) return 'bad_scan';
    if (!(await scans.has(scanRef))) return 'scan_absent';
    return (await this.scanUsed(scanRef)) ? 'scan_deja_utilise' : null;
  }

  /** La ligne de journal de l'avenant signé, écrite une fois ; reprise si une panne l'a empêchée [R13]. */
  private async ensureEvent(viewer: Viewer, documentId: string, mandateId: string): Promise<void> {
    const subject = `document:${documentId}`;
    if (await this.db.first(`SELECT seq FROM journal WHERE type = 'avenant.signe' AND subject = ? LIMIT 1`, [subject])) return;
    await appendEvent(this.journal, { type: 'avenant.signe', actor: this.actor(viewer), subject, data: { mandate: mandateId } }, this.now);
  }

  /** Les conditions en vigueur d'un mandat et l'historique de ses avenants : qui voit la fiche en entier [R16]. */
  async terms(viewer: Viewer, mandateId: string): Promise<{ ok: true; value: MandateTerms } | Refusal | { ok: false; rule: null; code: 'unknown_mandate' }> {
    const m = await this.db.first<{ person_id: string; network_id: string }>('SELECT person_id, network_id FROM mandates WHERE id = ?', [mandateId]);
    if (!m || m.network_id !== viewer.networkId) {
      await appendEvent(this.journal, { type: 'acces.refuse', actor: this.actor(viewer), subject: `mandate:${mandateId}`, data: { rule: 'R16', role: String(viewer.role), kind: 'mandate', code: 'unknown' } }, this.now);
      return { ok: false, rule: null, code: 'unknown_mandate' };
    }
    const read = await this.acces.readFiche(viewer, m.person_id);
    if (!read.ok) return read;
    if (read.view !== 'full') {
      await appendEvent(this.journal, { type: 'acces.refuse', actor: this.actor(viewer), subject: `mandate:${mandateId}`, data: { rule: 'R16', role: String(viewer.role), kind: 'mandate', code: 'not_assigned' } }, this.now);
      return { ok: false, rule: 'R16', code: 'not_assigned' };
    }
    const terms = await mandateTerms(this.db, mandateId);
    if (!terms) return { ok: false, rule: null, code: 'unknown_mandate' };
    return { ok: true, value: terms };
  }
}
