/**
 * Pièces déposées par les partenaires, rangées d'elles-mêmes (M18, U05) [R78].
 *
 * Le partenaire confié (U04) dépose une pièce dans sa mise en relation ouverte : sa sorte, sa référence de stockage,
 * son empreinte et la date du document ; jamais son contenu. Une règle écrite (`PIECE_RULES`) dit, pour chaque sorte,
 * quels métiers peuvent la déposer et où elle va :
 * - un diagnostic ou un bornage va à la fiche du bien, si le client du projet en est le propriétaire ;
 * - une pièce du notaire va au dossier de vente, si le client du projet en est le vendeur ou l'acquéreur ;
 * - un accord de prêt va au financement du dossier de vente, si le client du projet en est l'acquéreur ;
 * - un devis reste dans la mise en relation.
 * Une sorte inconnue, une sorte qui ne va pas avec le métier du déposant, un diagnostic d'un autre domaine que celui
 * demandé, une destination absente (pas de bien, pas de dossier de vente) ou un client qui n'y est pas partie envoient la pièce à la file de l'agent du
 * projet, avec la raison : elle n'est rangée nulle part au hasard [R78]. Une pièce d'identité, un document
 * anti-blanchiment ou un RIB ne sont jamais acceptés ici [R15].
 *
 * La place est rangée avec la pièce, dans la même écriture, une place par pièce ; le dossier de vente et la fiche
 * du bien le lisent au branchement (U09). Rien ne change ni ne s'efface [R17] ; chaque dépôt au journal, sans nom [R13].
 */
import type { Viewer } from '../acces/droits.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { FORBIDDEN_PIECES } from '../dossiers/pieces.ts';
import { localTime } from '../envoi/horaires.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import type { Annuaire, CertifiedDomain, CredentialKind, PartnerTrade } from './annuaire.ts';
import type { EspacePartenaire } from './espace-partenaire.ts';
import type { MiseEnRelation } from './mise-en-relation.ts';

const TIME_ZONE = 'Europe/Paris';

export type Destination = 'property' | 'sale_file' | 'financing' | 'referral' | 'agent_queue';

interface PieceRule {
  /** Métiers qui peuvent déposer cette sorte. */
  trades: readonly PartnerTrade[];
  /** Où elle va : un diagnostic à la fiche du bien, le reste au dossier de vente, à son financement ou à la mise en relation. */
  to: 'diagnostic' | 'sale_file' | 'financing' | 'referral';
  /** Le domaine de diagnostic que la sorte prouve, à comparer au domaine demandé. */
  domain?: string;
  /** Le nom de la pièce dans le dossier de vente de M10, quand elle y en a un. */
  piece?: string;
}

/** La règle écrite du rangement, sorte par sorte [R78]. */
export const PIECE_RULES: Readonly<Record<string, PieceRule>> = Object.freeze({
  dpe: { trades: ['diagnostiqueur'], to: 'diagnostic', domain: 'dpe', piece: 'dpe' },
  amiante: { trades: ['diagnostiqueur'], to: 'diagnostic', domain: 'amiante', piece: 'amiante' },
  plomb: { trades: ['diagnostiqueur'], to: 'diagnostic', domain: 'plomb', piece: 'plomb' },
  electricite: { trades: ['diagnostiqueur'], to: 'diagnostic', domain: 'electricite', piece: 'electricite' },
  gaz: { trades: ['diagnostiqueur'], to: 'diagnostic', domain: 'gaz', piece: 'gaz' },
  termites: { trades: ['diagnostiqueur'], to: 'diagnostic', domain: 'termites' },
  mesurage_carrez: { trades: ['diagnostiqueur'], to: 'diagnostic', domain: 'mesurage', piece: 'mesurage_carrez' },
  bornage: { trades: ['geometre'], to: 'diagnostic', piece: 'bornage' },
  titre_propriete: { trades: ['notaire'], to: 'sale_file', piece: 'titre_propriete' },
  pre_etat_date: { trades: ['notaire', 'gestionnaire'], to: 'sale_file', piece: 'pre_etat_date' },
  projet_compromis: { trades: ['notaire'], to: 'sale_file' },
  projet_acte: { trades: ['notaire'], to: 'sale_file' },
  accord_principe: { trades: ['courtier'], to: 'financing' },
  offre_pret: { trades: ['courtier'], to: 'financing' },
  devis: { trades: ['artisan', 'demenageur', 'photographe', 'geometre', 'diagnostiqueur', 'expert_viager', 'avocat', 'expert_comptable'], to: 'referral' },
});

export interface DepositedPiece {
  documentId: string;
  sort: string;
  version: number;
  destination: Destination;
  /** Où, précisément : l'identifiant du bien, du dossier de vente ou de la mise en relation ; du projet pour la file. */
  targetId: string;
  piece: string | null;
  /** Pourquoi là, en code : `rule` quand la règle a rangé, sinon la raison du passage à la file. */
  reason: string;
}

export type DepositRefusal = { ok: false; rule: 'R16' | 'R73' | 'R77' | 'R15' | null; code: string };
export type DepositResult<T> = { ok: true; value: T } | DepositRefusal;

export interface PartnerDocumentStore {
  has(ref: string): Promise<boolean>;
}

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const REF_FILE = new RegExp(`^${UUID}\\.(?:pdf|jpg|png)$`);
const SORT = /^[a-z_]{2,40}$/;
const SHA = /^[0-9a-f]{64}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const validDay = (v: unknown): v is string => {
  if (typeof v !== 'string' || !DAY.test(v)) return false;
  const d = new Date(`${v}T12:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
};

interface ReferralSource {
  id: string;
  network_id: string;
  project_id: string;
  property_id: string | null;
  trade: PartnerTrade;
  domain: string;
}

/** Un contrôle supplémentaire avant le rangement (U06) : rend la raison d'envoyer la pièce à la file, ou `null`. */
export type PlacementCheck = (input: { networkId: string; partnerId: string; trade: PartnerTrade; sort: string; issuedOn: string }) => Promise<string | null>;

/**
 * Le justificatif qui devait couvrir chaque sorte de pièce le jour où elle a été faite (U06) : la certification du
 * domaine pour un diagnostic, l'immatriculation ORIAS pour un accord de prêt, la carte G pour une pièce de gestion,
 * l'inscription à l'ordre pour un bornage. Règle écrite [R73, R78].
 */
export const PIECE_CREDENTIALS: Readonly<Record<string, { kind: CredentialKind; domain: CertifiedDomain | null; trades: readonly PartnerTrade[] }>> = Object.freeze({
  dpe: { kind: 'certification_diagnostic', domain: 'dpe', trades: ['diagnostiqueur'] },
  amiante: { kind: 'certification_diagnostic', domain: 'amiante', trades: ['diagnostiqueur'] },
  plomb: { kind: 'certification_diagnostic', domain: 'plomb', trades: ['diagnostiqueur'] },
  electricite: { kind: 'certification_diagnostic', domain: 'electricite', trades: ['diagnostiqueur'] },
  gaz: { kind: 'certification_diagnostic', domain: 'gaz', trades: ['diagnostiqueur'] },
  termites: { kind: 'certification_diagnostic', domain: 'termites', trades: ['diagnostiqueur'] },
  accord_principe: { kind: 'immatriculation_orias', domain: null, trades: ['courtier'] },
  offre_pret: { kind: 'immatriculation_orias', domain: null, trades: ['courtier'] },
  pre_etat_date: { kind: 'carte_g', domain: null, trades: ['gestionnaire'] },
  bornage: { kind: 'inscription_ordre', domain: null, trades: ['geometre'] },
});

/**
 * Jamais vu (U06) : chaque pièce est jugée contre les justificatifs de son auteur le jour où elle a été faite, et non
 * le jour du dépôt. Un diagnostic fait pendant que la certification de son domaine était échue, ou d'un domaine que le
 * diagnostiqueur ne couvrait pas, n'entre dans aucun dossier : il va à la file de l'agent avec la raison. L'assurance
 * du jour où la pièce a été faite est aussi exigée. Décision par règles écrites, rejouable, jamais par l'IA [R73, R78].
 */
export function credentialCheck(annuaire: Annuaire): PlacementCheck {
  return async ({ networkId, partnerId, trade, sort, issuedOn }) => {
    if (!(await annuaire.coveredOn(networkId, partnerId, 'assurance_rcp', null, issuedOn))) return 'insurance_not_valid_on_date';
    const need = Object.hasOwn(PIECE_CREDENTIALS, sort) ? PIECE_CREDENTIALS[sort] : undefined;
    if (!need || !need.trades.includes(trade)) return null;
    if (await annuaire.coveredOn(networkId, partnerId, need.kind, need.domain, issuedOn)) return null;
    return need.kind === 'certification_diagnostic' ? 'certification_not_valid_on_date' : 'credential_not_valid_on_date';
  };
}

export interface PiecesPartenairesOptions {
  now?: () => Date;
  newId?: () => string;
  /** Contrôles ajoutés après celui des justificatifs, dans l'ordre ; le premier qui rend une raison envoie la pièce à la file. */
  checks?: readonly PlacementCheck[];
}

export class PiecesPartenaires {
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly checks: readonly PlacementCheck[];

  constructor(
    private readonly db: SqlDatabase,
    private readonly space: EspacePartenaire,
    private readonly relations: MiseEnRelation,
    annuaire: Annuaire,
    private readonly store: PartnerDocumentStore,
    private readonly journal: JournalStore,
    options: PiecesPartenairesOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => crypto.randomUUID());
    // Le contrôle des justificatifs au jour de la pièce passe toujours, avant tout autre (U06).
    this.checks = [credentialCheck(annuaire), ...(options.checks ?? [])];
  }

  private actor(viewer: Viewer): string {
    return `${String(viewer.role)}:${viewer.userId}`;
  }

  /** Le partenaire confié dépose une pièce ; elle est rangée aussitôt par la règle écrite, ou va à la file de l'agent [R78]. */
  async deposit(viewer: Viewer, referralId: unknown, input: { sort: unknown; ref: unknown; sha256: unknown; issuedOn: unknown }): Promise<DepositResult<DepositedPiece>> {
    // Une pièce déjà faite se dépose même si un justificatif a expiré depuis : elle est jugée sur ceux du jour où elle a
    // été faite, contrôle toujours appliqué ci-dessous (U06) [R73, R78].
    const access = await this.space.access(viewer, referralId, { credentialsToday: false });
    if (!access.ok) return access;
    const id = referralId as string;
    const subject = `referral:${id}`;
    if (typeof input.sort === 'string' && (FORBIDDEN_PIECES as readonly string[]).includes(input.sort)) {
      await appendEvent(this.journal, { type: 'piece_partenaire.refusee', actor: this.actor(viewer), subject, data: { rule: 'R15', sort: input.sort } }, this.now);
      return { ok: false, rule: 'R15', code: 'forbidden_piece' };
    }
    if (typeof input.sort !== 'string' || !SORT.test(input.sort)) return { ok: false, rule: null, code: 'bad_sort' };
    const prefix = `partenaires/${viewer.userId}/relations/${id}/`;
    if (typeof input.ref !== 'string' || !input.ref.startsWith(prefix) || !REF_FILE.test(input.ref.slice(prefix.length))) return { ok: false, rule: null, code: 'bad_ref' };
    if (typeof input.sha256 !== 'string' || !SHA.test(input.sha256)) return { ok: false, rule: null, code: 'bad_sha256' };
    if (!validDay(input.issuedOn) || input.issuedOn > localTime(this.now(), TIME_ZONE).date) return { ok: false, rule: null, code: 'bad_date' };
    if (!(await this.store.has(input.ref))) return { ok: false, rule: null, code: 'not_stored' };
    if (await this.db.first('SELECT 1 FROM partner_documents WHERE ref = ?', [input.ref])) return { ok: false, rule: null, code: 'ref_used' };
    const src = (await this.db.first<ReferralSource>('SELECT id, network_id, project_id, property_id, trade, domain FROM partner_referrals WHERE id = ?', [id]))!;
    const last = await this.db.first<{ v: number | null }>('SELECT MAX(version) AS v FROM partner_documents WHERE referral_id = ? AND sort = ?', [id, input.sort]);
    const version = Number(last?.v ?? 0) + 1;
    const docId = this.newId();
    // La place est décidée avant l'écriture et rangée avec la pièce, d'un seul coup : jamais une pièce sans place.
    const place = await this.route(src, viewer.userId, input.sort, input.issuedOn);
    try {
      await this.db.run(
        'INSERT INTO partner_documents (id, network_id, referral_id, partner_id, sort, version, ref, sha256, issued_on, deposited_at, destination, target_id, piece, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [docId, src.network_id, id, viewer.userId, input.sort, version, input.ref, input.sha256, input.issuedOn, this.now().toISOString(), place.destination, place.targetId, place.piece, place.reason],
      );
    } catch (error) {
      if (/mise en relation close/.test(String(error))) return { ok: false, rule: 'R16', code: 'closed' };
      if (/UNIQUE/i.test(String(error))) return { ok: false, rule: null, code: /\.ref/.test(String(error)) ? 'ref_used' : 'busy' };
      throw error;
    }
    await appendEvent(
      this.journal,
      { type: 'piece_partenaire.rangee', actor: this.actor(viewer), subject, data: { rule: 'R78', sort: input.sort, version, destination: place.destination, reason: place.reason } },
      this.now,
    );
    return { ok: true, value: { documentId: docId, sort: input.sort, version, ...place } };
  }

  /** La règle écrite du rangement, sans rien écrire : rejouable [R78]. */
  private async route(src: ReferralSource, partnerId: string, sort: string, issuedOn: string): Promise<Omit<DepositedPiece, 'documentId' | 'sort' | 'version'>> {
    const queue = (reason: string) => ({ destination: 'agent_queue' as const, targetId: src.project_id, piece: null, reason });
    // Une sorte inconnue, même nommée comme une propriété héritée (`constructor`, `__proto__`), va à la file [R78].
    const rule = Object.hasOwn(PIECE_RULES, sort) ? PIECE_RULES[sort] : undefined;
    if (!rule) return queue('unknown_sort');
    if (!rule.trades.includes(src.trade)) return queue('sort_not_for_trade');
    if (rule.domain !== undefined && rule.domain !== src.domain) return queue('other_domain');
    for (const check of this.checks) {
      const reason = await check({ networkId: src.network_id, partnerId, trade: src.trade, sort, issuedOn });
      if (reason) return queue(reason);
    }
    if (rule.to === 'referral') return { destination: 'referral', targetId: src.id, piece: null, reason: 'rule' };
    if (!src.property_id) return queue('no_property');
    // Le client du projet doit être partie au bien ou au dossier : jamais une pièce d'un client chez un autre [R78, R16].
    const owner = await this.db.first("SELECT 1 FROM project_properties WHERE project_id = ? AND property_id = ? AND role = 'owned'", [src.project_id, src.property_id]);
    if (rule.to === 'diagnostic') {
      // Un diagnostic ou un bornage va toujours à la fiche du bien, d'où le dossier de vente le lit (U09).
      if (!owner) return queue('not_party');
      return { destination: 'property', targetId: src.property_id, piece: rule.piece ?? sort, reason: 'rule' };
    }
    const sale = await this.db.first<{ id: string; buyer_person_id: string }>('SELECT f.id, f.buyer_person_id FROM sale_files f WHERE f.property_id = ? AND f.network_id = ? AND NOT EXISTS (SELECT 1 FROM sale_file_stops stop_ WHERE stop_.file_id = f.id)', [src.property_id, src.network_id]);
    if (!sale) return queue('no_sale_file');
    const person = (await this.db.first<{ person_id: string }>('SELECT person_id FROM projects WHERE id = ?', [src.project_id]))!;
    const buyer = sale.buyer_person_id === person.person_id;
    if (rule.to === 'financing') {
      // Un accord de prêt est celui de l'acquéreur du dossier, et de lui seul.
      if (!buyer) return queue('not_party');
      return { destination: 'financing', targetId: sale.id, piece: sort, reason: 'rule' };
    }
    if (!owner && !buyer) return queue('not_party');
    return { destination: 'sale_file', targetId: sale.id, piece: rule.piece ?? sort, reason: 'rule' };
  }

  /** Les pièces d'une mise en relation et leur place, pour l'agent du projet ou la direction [R16]. */
  async placements(viewer: Viewer, referralId: unknown): Promise<DepositResult<DepositedPiece[]>> {
    const r = await this.relations.get(viewer, referralId);
    if (!r.ok) return { ok: false, rule: r.rule === 'R16' ? 'R16' : null, code: r.code };
    const rows = await this.db.all<{ id: string; sort: string; version: number; destination: Destination; target_id: string; piece: string | null; reason: string }>(
      'SELECT id, sort, version, destination, target_id, piece, reason FROM partner_documents WHERE referral_id = ? ORDER BY deposited_at, id',
      [r.value.referralId],
    );
    return {
      ok: true,
      value: rows.map((x) => ({ documentId: x.id, sort: x.sort, version: Number(x.version), destination: x.destination, targetId: x.target_id, piece: x.piece, reason: x.reason })),
    };
  }
}
