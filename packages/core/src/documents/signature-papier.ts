/**
 * Le mandat signé sur papier, numéroté au registre (M06, D04).
 *
 * L'agent enregistre un mandat généré (D02) et signé sur papier : date, lieu de signature, référence du scan. S'il
 * passe à cet instant les contrôles avant signature (D03), il devient un mandat signé avec sa source (G03, [R38]),
 * reçoit son numéro au registre (D01) et l'exemplaire du mandant est produit avec ce numéro [R39]. Un document qui
 * échoue aux contrôles n'est pas numéroté [R41] ; un même document ne reçoit jamais deux numéros, et un bien n'a qu'un mandat
 * vivant (D15).
 *
 * Décidé : la base n'a pas de transaction sur plusieurs requêtes ; le document est donc réservé d'abord, puis chaque
 * étape (mandat, numéro, exemplaire) remplit sa case une seule fois. Une coupure entre deux étapes se reprend en
 * redemandant l'enregistrement, qui continue là où il s'était arrêté, sans rien refaire.
 */
import type { Acces } from '../acces/acces.ts';
import type { Viewer } from '../acces/droits.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { FicheClient } from '../db/fiche-client.ts';
import { FicheUnique } from '../fiche/fusion.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import { localTime } from '../envoi/horaires.ts';
import { Mandats } from '../mandats/source.ts';
import { RegistreMandats } from '../mandats/registre.ts';
import { ControlesSignature, documentMandants, type SignatureCheck } from './controles.ts';
import { mandateScanPrefix } from './mandat-du-bien.ts';
import { Diffusion } from './retractation.ts';
import { escapeHtml, fillSignatureFields, sha256, signatureSpan } from './modeles.ts';

export const SIGNATURE_PLACES = ['agence', 'hors_agence', 'distance'] as const;
export type SignaturePlace = (typeof SIGNATURE_PLACES)[number];
const PLACE_LABEL: Record<SignaturePlace, string> = { agence: 'à l’agence', hors_agence: 'hors de l’agence', distance: 'à distance' };
const SCAN_REF = /^[A-Za-z0-9/_.-]{1,200}$/;
const MANDATE_KINDS = ['mandat_vente_simple', 'mandat_vente_exclusif'];

export interface PaperSignature {
  signedAt: Date;
  place: SignaturePlace;
  scanRef: string;
  /** La source du mandat, comme G03 : donnée, ou reprise de la fiche [R38]. */
  source?: string | null;
  sourceDetail?: string | null;
}

export interface SignedMandate {
  documentId: string;
  mandateId: string;
  number: string;
  place: SignaturePlace;
  signedAt: string;
  copyHash: string;
}

type Refusal = { ok: false; rule: 'R16'; code: string };
type Problem =
  | { ok: false; rule: 'R41'; code: 'checks_failed'; check: SignatureCheck }
  | { ok: false; rule: 'R39'; code: string }
  | { ok: false; rule: 'R38' | 'R37'; code: string }
  | { ok: false; rule: null; code: 'bad_date' | 'bad_place' | 'bad_scan' | 'not_a_mandate' | 'already_signed' | 'unknown_document' | string };

interface SignedRow {
  document_id: string;
  network_id: string;
  signed_at: string;
  place: SignaturePlace;
  scan_ref: string;
  mandate_id: string | null;
  number: string | null;
  copy_content: string | null;
  copy_hash: string | null;
}

export interface PaperSignatureOptions {
  now?: () => Date;
  newId?: () => string;
  /**
   * Le stockage où le scan doit se trouver (D11). Donné : la référence doit être celle d'un scan de ce bien, présent dans
   * le stockage, et qui n'a encore prouvé aucune signature. Nul : aucun stockage, rien ne se signe. Absent : non vérifié,
   * pour les appelants internes ; la route donne toujours l'un ou l'autre. Une reprise garde son scan et ne repasse pas ici.
   */
  scans?: { has(ref: string): Promise<boolean> } | null;
  /** Où vérifier la procuration d'un mandant représenté, quand ce n'est pas `scans` (la signature en ligne) (AU059). */
  powers?: { has(ref: string): Promise<boolean> } | null;
}

export class SignaturePapier {
  private readonly now: () => Date;
  private readonly controles: ControlesSignature;
  private readonly fiche: FicheUnique;
  private readonly options: PaperSignatureOptions;
  private readonly registre: RegistreMandats;

  constructor(
    private readonly db: SqlDatabase,
    private readonly acces: Acces,
    private readonly journal: JournalStore,
    options: PaperSignatureOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.controles = new ControlesSignature(db, acces, journal, options);
    this.fiche = new FicheUnique(db, new FicheClient(db, { now: this.now }), { now: this.now });
    this.options = options;
    this.registre = new RegistreMandats(db, journal, { now: this.now });
  }

  private actor(viewer: Viewer): string {
    return `${String(viewer.role)}:${viewer.userId}`;
  }

  /** Enregistre un mandat signé sur papier ; le reprend là où il s'était arrêté si une étape a manqué. */
  async register(viewer: Viewer, documentId: string, input: PaperSignature): Promise<{ ok: true; value: SignedMandate } | Refusal | Problem> {
    if (!(input.signedAt instanceof Date) || Number.isNaN(input.signedAt.getTime()) || input.signedAt.getTime() > this.now().getTime()) return { ok: false, rule: null, code: 'bad_date' };
    if (!(SIGNATURE_PLACES as readonly string[]).includes(input.place)) return { ok: false, rule: null, code: 'bad_place' };
    if (typeof input.scanRef !== 'string' || !SCAN_REF.test(input.scanRef) || input.scanRef.includes('..')) return { ok: false, rule: null, code: 'bad_scan' };
    if (viewer.role !== 'agent' && viewer.role !== 'direction') {
      await appendEvent(this.journal, { type: 'acces.refuse', actor: this.actor(viewer), subject: `document:${documentId}`, data: { rule: 'R16', role: String(viewer.role), kind: 'signature', code: 'role' } }, this.now);
      return { ok: false, rule: 'R16', code: 'role' };
    }
    const doc = await this.db.first<{ id: string; network_id: string; kind: string; mode: string; person_id: string; property_id: string | null; content: string; content_hash: string }>(
      'SELECT id, network_id, kind, mode, person_id, property_id, content, content_hash FROM documents WHERE id = ?',
      [documentId],
    );
    if (!doc || doc.network_id !== viewer.networkId) {
      await appendEvent(this.journal, { type: 'acces.refuse', actor: this.actor(viewer), subject: `document:${documentId}`, data: { rule: 'R16', role: String(viewer.role), kind: 'signature', code: 'unknown' } }, this.now);
      return { ok: false, rule: 'R16', code: 'unknown' };
    }
    if (!MANDATE_KINDS.includes(doc.kind)) return { ok: false, rule: null, code: 'not_a_mandate' };
    // Sans champ de numéro, l'exemplaire du mandant ne porterait pas son numéro : pas de numéro du tout [R39].
    if (!doc.content.includes(signatureSpan('registre.numero'))) return { ok: false, rule: 'R39', code: 'no_number_field' };

    // Une reprise garde la date de la première demande : c'est elle qui juge l'identité du mandant (L03) [R92].
    let row = await this.db.first<SignedRow>('SELECT * FROM signed_documents WHERE document_id = ?', [documentId]);
    const effectiveSignedAt = row ? new Date(row.signed_at) : input.signedAt;

    // Les contrôles, maintenant, sur ce document ; ils vérifient aussi les droits sur la fiche et le bien [R16, R41].
    // L'identité se juge au jour de la signature, les autres lignes au jour présent ; le résultat est gardé tel quel.
    const checked = await this.controles.check(viewer, documentId, { identitySignedAt: effectiveSignedAt });
    if (!checked.ok) return checked;

    if (row && row.number !== null && row.copy_content !== null) {
      // Déjà signé ; si la ligne de journal de la signature a manqué (panne), elle est écrite maintenant [R13].
      await this.ensureSignedEvent(viewer, row);
      return { ok: false, rule: null, code: 'already_signed' };
    }
    if (!checked.value.passed) return { ok: false, rule: 'R41', code: 'checks_failed', check: checked.value };
    // Un scan qui n'existe pas n'est pas une preuve ; une reprise garde le scan de la première demande.
    if (!row) {
      const scans = this.options.scans;
      if (scans === null) return { ok: false, rule: null, code: 'depot_ferme' };
      if (scans) {
        if (doc.property_id === null || !input.scanRef.startsWith(mandateScanPrefix(doc.property_id))) return { ok: false, rule: null, code: 'bad_scan' };
        if (!(await scans.has(input.scanRef))) return { ok: false, rule: null, code: 'scan_absent' };
        // Un scan prouve une seule signature ; l'index unique ferme la course entre deux demandes.
        const used = await this.db.first('SELECT 1 FROM signed_documents WHERE scan_ref = ? UNION ALL SELECT 1 FROM signed_amendments WHERE scan_ref = ?', [input.scanRef, input.scanRef]);
        if (used) return { ok: false, rule: null, code: 'scan_deja_utilise' };
      }
    }

    // Un seul mandat vivant par bien (D15) : un second recevrait un numéro du registre, qui est sans trou [R39]. Annulé,
    // rétracté ou échu, le bien se rouvre. Un document dont le mandat est déjà inscrit finit toujours son enregistrement.
    const ownMandate = `m-${documentId}`;
    if (doc.property_id !== null && !(await this.db.first(`SELECT seq FROM mandate_register WHERE mandate_id = ? AND kind = 'inscription'`, [ownMandate]))) {
      const other = await new Diffusion(this.db, this.acces, this.journal, { now: this.now }).otherLiveMandate(viewer.networkId, doc.property_id, ownMandate);
      if (other !== null) return { ok: false, rule: 'R39', code: 'mandate_in_force' };
    }

    // 1. Le document est réservé : un seul enregistrement, quelles que soient les demandes simultanées.
    if (!row) {
      await this.db.run(
        `INSERT INTO signed_documents (document_id, network_id, signed_at, place, scan_ref, registered_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (document_id) DO NOTHING`,
        [documentId, viewer.networkId, input.signedAt.toISOString(), input.place, input.scanRef, this.actor(viewer), this.now().toISOString()],
      );
      row = (await this.db.first<SignedRow>('SELECT * FROM signed_documents WHERE document_id = ?', [documentId]))!;
      // Une demande simultanée a réservé avec une autre date : c'est la sienne qui vaut, l'identité se rejuge à cette date.
      if (row.signed_at !== effectiveSignedAt.toISOString()) {
        const again = await this.controles.check(viewer, documentId, { identitySignedAt: new Date(row.signed_at) });
        if (!again.ok) return again;
        if (!again.value.passed) return { ok: false, rule: 'R41', code: 'checks_failed', check: again.value };
      }
    }
    // Une reprise garde la date, le lieu et le scan de la première demande.
    const signedAt = new Date(row.signed_at);

    // 2. Le mandat signé, avec sa source [R38].
    if (row.mandate_id === null) {
      // L'identifiant du mandat est tiré du document : deux demandes, ou une reprise après coupure, ne rangent jamais
      // deux mandats pour un même document.
      const fixedId = `m-${documentId}`;
      const existing = await this.db.first<{ id: string }>('SELECT id FROM mandates WHERE id = ?', [fixedId]);
      let mandate: { ok: true; id: string } | Problem | Refusal;
      if (existing) {
        // Reprise : le mandat est rangé ; si sa ligne de journal a manqué (panne), elle est écrite maintenant [R13].
        await this.ensureRecordedEvent(viewer, existing.id);
        mandate = { ok: true, id: existing.id };
      }
      else {
        try {
          const recorded = await new Mandats(this.db, this.fiche, this.journal, { ...this.options, newId: () => fixedId }).record(this.acces, viewer, {
            personId: doc.person_id,
            propertyId: doc.property_id,
            signedAt,
            source: input.source ?? null,
            sourceDetail: input.sourceDetail ?? null,
          });
          mandate = recorded.ok ? { ok: true, id: recorded.id } : (recorded as Problem | Refusal);
        } catch (error) {
          // Une autre demande a rangé ce même mandat, et son journal est écrit : on le reprend. Toute autre panne
          // (dont celle du journal après notre propre rangement) remonte ; la redemande la reprendra.
          if (!(await this.db.first('SELECT id FROM mandates WHERE id = ?', [fixedId])) || !(await this.hasRecordedEvent(fixedId))) throw error;
          mandate = { ok: true, id: fixedId };
        }
      }
      if (!mandate.ok) return mandate;
      const { changes } = await this.db.run('UPDATE signed_documents SET mandate_id = ? WHERE document_id = ? AND mandate_id IS NULL', [mandate.id, documentId]);
      row = (await this.db.first<SignedRow>('SELECT * FROM signed_documents WHERE document_id = ?', [documentId]))!;
      // Une autre demande a posé son mandat entre-temps : celui-ci reste rangé, sans numéro ; on le dit au journal.
      if (changes !== 1) await appendEvent(this.journal, { type: 'signature.doublon', actor: this.actor(viewer), subject: `document:${documentId}`, data: { mandate: mandate.id } }, this.now);
    }
    const mandateId = row.mandate_id!;

    // 3. Le numéro au registre [R39].
    if (row.number === null) {
      const inscribed = await this.registre.inscribe(viewer, mandateId);
      let number: string | null = null;
      if (inscribed.ok) number = inscribed.line.number;
      else if (inscribed.code === 'already_inscribed') {
        const line = await this.db.first<{ number: string }>(`SELECT number FROM mandate_register WHERE mandate_id = ? AND kind = 'inscription'`, [mandateId]);
        number = line?.number ?? null;
      } else return inscribed as Problem | Refusal;
      if (number === null) return { ok: false, rule: 'R39', code: 'not_inscribed' };
      await this.db.run('UPDATE signed_documents SET number = ? WHERE document_id = ? AND number IS NULL', [number, documentId]);
      row = (await this.db.first<SignedRow>('SELECT * FROM signed_documents WHERE document_id = ?', [documentId]))!;
    }

    // 4. L'exemplaire du mandant, avec son numéro, sa date et son lieu de signature.
    if (row.copy_content === null) {
      const day = localTime(signedAt, 'Europe/Paris').date;
      const copy = fillSignatureFields(doc.content, {
        'registre.numero': row.number!,
        'signature.date': `${day.slice(8, 10)}/${day.slice(5, 7)}/${day.slice(0, 4)}`,
        'signature.lieu': PLACE_LABEL[row.place],
      });
      // Le numéro doit figurer sur l'exemplaire ; sinon rien n'est figé [R39].
      if (!copy.includes(`<span class="signe">${escapeHtml(row.number!)}</span>`)) return { ok: false, rule: 'R39', code: 'no_number_on_copy' };
      const copyHash = await sha256(copy);
      await this.db.run('UPDATE signed_documents SET copy_content = ?, copy_hash = ?, completed_at = ? WHERE document_id = ? AND copy_content IS NULL', [copy, copyHash, this.now().toISOString(), documentId]);
      row = (await this.db.first<SignedRow>('SELECT * FROM signed_documents WHERE document_id = ?', [documentId]))!;
    }
    await this.ensureSignedEvent(viewer, row);
    return { ok: true, value: { documentId, mandateId, number: row.number!, place: row.place, signedAt: row.signed_at, copyHash: row.copy_hash! } };
  }

  /** La ligne de journal de la signature, écrite une fois ; reprise si une panne l'a empêchée. */
  private async ensureSignedEvent(viewer: Viewer, row: SignedRow): Promise<void> {
    const subject = `document:${row.document_id}`;
    if (await this.db.first(`SELECT seq FROM journal WHERE type = 'mandat.signe' AND subject = ? LIMIT 1`, [subject])) return;
    await appendEvent(this.journal, { type: 'mandat.signe', actor: this.actor(viewer), subject, data: { mandate: row.mandate_id ?? '', place: row.place, numberRegistered: row.number !== null } }, this.now);
  }

  private async hasRecordedEvent(mandateId: string): Promise<boolean> {
    const rows = await this.db.all<{ data: string }>(`SELECT data FROM journal WHERE type = 'mandat.range'`);
    return rows.some((r) => {
      try {
        return (JSON.parse(r.data) as { mandate?: unknown }).mandate === mandateId;
      } catch {
        return false;
      }
    });
  }

  private async ensureRecordedEvent(viewer: Viewer, mandateId: string): Promise<void> {
    if (await this.hasRecordedEvent(mandateId)) return;
    const m = await this.db.first<{ person_id: string; source_kind: string; source_id: string | null }>('SELECT person_id, source_kind, source_id FROM mandates WHERE id = ?', [mandateId]);
    if (!m) return;
    await appendEvent(
      this.journal,
      { type: 'mandat.range', actor: this.actor(viewer), subject: `person:${m.person_id}`, data: { mandate: mandateId, source: m.source_kind, fromFiche: m.source_id !== null, resumed: true } },
      this.now,
    );
  }

  /** L'exemplaire du mandant : celui qui voit la fiche en entier [R16]. */
  async copy(viewer: Viewer, documentId: string): Promise<{ ok: true; content: string; number: string } | Refusal | { ok: false; rule: null; code: 'not_signed' }> {
    // Un mandat signé, ou un avenant signé (D07), qui porte le numéro de son mandat.
    const row =
      (await this.db.first<{ copy_content: string | null; number: string | null; person_id: string }>(
        'SELECT s.copy_content, s.number, d.person_id FROM signed_documents s JOIN documents d ON d.id = s.document_id WHERE s.document_id = ? AND s.network_id = ?',
        [documentId, viewer.networkId],
      )) ??
      (await this.db.first<{ copy_content: string | null; number: string | null; person_id: string }>(
        `SELECT a.copy_content, s.number, d.person_id FROM signed_amendments a JOIN documents d ON d.id = a.document_id
         JOIN signed_documents s ON s.mandate_id = a.mandate_id WHERE a.document_id = ? AND a.network_id = ?`,
        [documentId, viewer.networkId],
      ));
    if (!row || row.copy_content === null || row.number === null) return { ok: false, rule: null, code: 'not_signed' };
    const read = await this.acces.readFiche(viewer, row.person_id);
    if (!read.ok) return read;
    // L'exemplaire nomme chaque mandant : chacune de leurs fiches est vue en entier (AU001) [R16].
    let others = true;
    for (const personId of (await documentMandants(this.db, documentId, row.person_id)).slice(1)) {
      const co = await this.acces.readFiche(viewer, personId);
      if (!co.ok) return co;
      if (co.view !== 'full') others = false;
    }
    if (read.view !== 'full' || !others) {
      await appendEvent(this.journal, { type: 'acces.refuse', actor: this.actor(viewer), subject: `document:${documentId}`, data: { rule: 'R16', role: String(viewer.role), kind: 'exemplaire', code: 'not_assigned' } }, this.now);
      return { ok: false, rule: 'R16', code: 'not_assigned' };
    }
    return { ok: true, content: row.copy_content, number: row.number };
  }
}
