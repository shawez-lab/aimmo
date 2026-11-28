/**
 * Le mandat d'un bien vu depuis le téléphone (M06, D11) [R16, R13].
 *
 * Aucune route ne listait les documents d'un bien : un document généré se perdait une fois l'écran quitté, et
 * `signature-papier` attendait une référence de scan que personne ne saurait saisir.
 * - `read` : les documents du bien (sans leur contenu, qui reste derrière la fiche), le mandat en cours et les mandants
 *   possibles. Seuls l'agent du bien, la direction et la conformité lisent. Un mandant est la fiche liée au bien comme
 *   propriétaire (`owned`) ; elle n'est rendue qu'à qui la voit en entier, et sa lecture est écrite au journal.
 * - `depositScan` : le scan signé, rangé tel quel sous `mandats/<bien>/`. L'agent du bien ou la direction, droits vérifiés
 *   avant de lire un octet. Déposer ne signe rien : la référence rendue sert à `signature-papier` ou `signature-avenant`.
 * Au journal : ni contenu, ni donnée personnelle.
 */
import type { Acces } from '../acces/acces.ts';
import type { Viewer } from '../acces/droits.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { checkDepositedFile, type FileDepositInput } from '../dossiers/depot.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import { Diffusion, type DiffusionDecision } from './retractation.ts';
import { latestDesignation, latestDomicile, type PostalAddress, type PropertyDesignation } from './designation.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Les plus récents : une page de téléphone, pas une archive. */
export const PROPERTY_DOCUMENTS_MAX = 50;

/** Le début de la référence d'un scan de mandat : `signature-papier` n'accepte que celle du bien du document. */
export const mandateScanPrefix = (propertyId: string): string => `mandats/${propertyId}/`;

export interface PropertyMandate {
  propertyId: string;
  /** Du plus récent au plus ancien, sans contenu. Un document d'essai porte `mode: 'essai'` [R40]. */
  documents: {
    id: string;
    kind: string;
    mode: 'essai' | 'reel';
    status: 'complet' | 'incomplet';
    missing: string[];
    createdAt: string;
    /** Pour un avenant : le mandat qu'il modifie, qui n'est pas toujours le mandat en cours du bien. */
    mandateId: string | null;
    /** `complete` faux : l'enregistrement s'est arrêté en route (source manquante, coupure) et se reprend ; il n'est pas signé. */
    signature: { signedAt: string; place: string; number: string | null; complete: boolean } | null;
  }[];
  /** La décision de diffusion dit l'état du mandat ; `mandate` est nul s'il n'y en a aucun. */
  mandate: { id: string; number: string | null; signedAt: string | null; allowed: boolean; reason: DiffusionDecision['reason']; withdrawalLastDay: string | null; withdrawalUnfinished: boolean } | null;
  /**
   * Le mandat de location du bien, lu de la même façon par la porte de la location (AU120) : un mandat de vente n'ouvre pas
   * la location, ni l'inverse, et l'un ne dit rien de l'autre. Nul s'il n'y en a aucun.
   */
  rental: PropertyMandate['mandate'];
  /** Chaque propriétaire vu en entier, avec son domicile repris par le mandat (AU002), ou null s'il manque. */
  owners: { personId: string; firstName: string | null; lastName: string | null; domicile: PostalAddress | null }[];
  /** L'adresse et les parcelles du bien que reprend chaque mandat de vente (AU002), ou null si elles manquent. */
  designation: Omit<PropertyDesignation, 'setAt'> | null;
}

type Refusal = { ok: false; rule: 'R16'; code: string };

export class MandatDuBien {
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(
    private readonly db: SqlDatabase,
    private readonly acces: Acces,
    private readonly journal: JournalStore,
    options: { now?: () => Date; newId?: () => string } = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => crypto.randomUUID());
  }

  private actor(viewer: Viewer): string {
    return `${String(viewer.role)}:${viewer.userId}`;
  }

  private async refuse(viewer: Viewer, propertyId: string, kind: string, code: string): Promise<Refusal> {
    await appendEvent(this.journal, { type: 'acces.refuse', actor: this.actor(viewer), subject: `property:${propertyId}`, data: { rule: 'R16', role: String(viewer.role), kind, code } }, this.now);
    return { ok: false, rule: 'R16', code };
  }

  async read(viewer: Viewer, propertyId: string): Promise<{ ok: true; value: PropertyMandate } | Refusal> {
    if (viewer.role !== 'agent' && viewer.role !== 'direction' && viewer.role !== 'compliance') return this.refuse(viewer, propertyId, 'mandat_du_bien', 'role');
    const seen = await this.acces.readProperty(viewer, propertyId);
    if (!seen.ok) return seen;
    if (seen.view !== 'full') return this.refuse(viewer, propertyId, 'mandat_du_bien', 'not_assigned');

    const rows = await this.db.all<{ id: string; kind: string; mode: 'essai' | 'reel'; status: 'complet' | 'incomplet'; missing: string; created_at: string; mandate_id: string | null; signed_at: string | null; place: string | null; number: string | null; complete: number }>(
      `SELECT d.id, d.kind, d.mode, d.status, d.missing, d.created_at, d.mandate_id,
              COALESCE(s.signed_at, a.signed_at) AS signed_at, COALESCE(s.place, a.place) AS place,
              COALESCE(s.number, parent.number) AS number,
              CASE WHEN a.document_id IS NOT NULL OR s.copy_content IS NOT NULL THEN 1 ELSE 0 END AS complete
       FROM documents d
       LEFT JOIN signed_documents s ON s.document_id = d.id
       LEFT JOIN signed_amendments a ON a.document_id = d.id
       LEFT JOIN signed_documents parent ON parent.mandate_id = a.mandate_id
       WHERE d.network_id = ? AND d.property_id = ? ORDER BY d.created_at DESC, d.rowid DESC LIMIT ?`,
      [viewer.networkId, propertyId, PROPERTY_DOCUMENTS_MAX],
    );
    const diffusion = new Diffusion(this.db, this.acces, this.journal, { now: this.now });
    // Le mandat que retient la porte de la diffusion, pour la vente puis pour la location : son numéro, sa date, son état.
    const summary = async (object: 'vente' | 'location'): Promise<PropertyMandate['mandate']> => {
      const decision = await diffusion.canDiffuse(viewer.networkId, propertyId, undefined, object);
      if (decision.mandateId === null) return null;
      const unfinished = decision.reason === 'withdrawn' && (await diffusion.withdrawalUnfinished(viewer.networkId, decision.mandateId));
      const signed = await this.db.first<{ number: string | null; signed_at: string }>('SELECT number, signed_at FROM signed_documents WHERE mandate_id = ?', [decision.mandateId]);
      return { id: decision.mandateId, number: signed?.number ?? null, signedAt: signed?.signed_at ?? null, allowed: decision.allowed, reason: decision.reason, withdrawalLastDay: decision.withdrawalLastDay, withdrawalUnfinished: unfinished };
    };

    const links = await this.db.all<{ person_id: string }>(
      `SELECT DISTINCT p.person_id AS person_id FROM project_properties l JOIN projects p ON p.id = l.project_id
       WHERE l.network_id = ? AND l.property_id = ? AND l.role = 'owned' ORDER BY p.person_id`,
      [viewer.networkId, propertyId],
    );
    const owners = new Map<string, PropertyMandate['owners'][number]>();
    for (const link of links) {
      const fiche = await this.acces.readFiche(viewer, link.person_id);
      if (!fiche.ok || fiche.view !== 'full') continue;
      const person = fiche.value.person;
      owners.set(person.id, { personId: person.id, firstName: person.first_name, lastName: person.last_name, domicile: await latestDomicile(this.db, viewer.networkId, fiche.value.members.map((m) => m.id)) });
    }

    return {
      ok: true,
      value: {
        propertyId,
        documents: rows.map((r) => ({
          id: r.id,
          kind: r.kind,
          mode: r.mode,
          status: r.status,
          missing: parseMissing(r.missing),
          createdAt: r.created_at,
          mandateId: r.mandate_id,
          signature: r.signed_at ? { signedAt: r.signed_at, place: r.place as string, number: r.number, complete: r.complete === 1 } : null,
        })),
        mandate: await summary('vente'),
        rental: await summary('location'),
        owners: [...owners.values()],
        designation: await (async () => {
          const d = await latestDesignation(this.db, viewer.networkId, propertyId);
          return d ? { address: d.address, parcels: d.parcels } : null;
        })(),
      },
    };
  }

  /** Range le scan signé d'un mandat et rend sa référence ; rien n'est signé ni rattaché ici. */
  async depositScan(
    viewer: Viewer,
    propertyId: string,
    store: { put(key: string, bytes: Uint8Array, contentType: string): Promise<void> },
    input: Pick<FileDepositInput, 'contentType' | 'sha256' | 'declaredSize' | 'read'>,
  ): Promise<{ ok: true; value: { ref: string; sha256: string; size: number } } | Refusal | { ok: false; rule: null; code: string }> {
    // Les droits d'abord, avant de lire un seul octet [R16].
    if (viewer.role !== 'agent' && viewer.role !== 'direction') return this.refuse(viewer, propertyId, 'mandat_scan', 'role');
    const seen = await this.acces.readProperty(viewer, propertyId);
    if (!seen.ok) return seen;
    if (seen.view !== 'full') return this.refuse(viewer, propertyId, 'mandat_scan', 'not_assigned');
    const actor = this.actor(viewer);
    const subject = `property:${propertyId}`;
    const bad = async (code: string): Promise<{ ok: false; rule: null; code: string }> => {
      await appendEvent(this.journal, { type: 'mandat.depot.refuse', actor, subject, data: { code } }, this.now);
      return { ok: false, rule: null, code };
    };
    const file = await checkDepositedFile(input);
    if (!file.ok) return bad(file.code);
    const id = this.newId();
    if (!UUID.test(id)) throw new Error('identifiant de fichier invalide');
    const ref = `${mandateScanPrefix(propertyId)}${id}.${file.ext}`;
    try {
      await store.put(ref, file.bytes, file.type);
    } catch {
      return bad('stockage_indisponible');
    }
    await appendEvent(this.journal, { type: 'mandat.depot', actor, subject, data: { ref, size: file.bytes.length, sha256: file.sha } }, this.now);
    return { ok: true, value: { ref, sha256: file.sha, size: file.bytes.length } };
  }
}

function parseMissing(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((m): m is string => typeof m === 'string') : [];
  } catch {
    return [];
  }
}
