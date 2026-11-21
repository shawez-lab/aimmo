/**
 * Factures d'honoraires et de reversement, en mode essai (M13, K02) [R13, R15, R16, R17, R18, R26, R67, R71].
 *
 * À la commission due (K01), le code prépare :
 * - la facture d'honoraires du réseau au client qui les paie (le vendeur du mandat ou l'acquéreur, selon le mandat) ;
 * - une facture de reversement par agent qui a une part (l'agent de la vente, l'agent qui partage), émise au nom de
 *   l'agent au réseau.
 * La direction valide chaque brouillon : la facture reçoit le numéro suivant de son émetteur pour l'année, sans trou ni
 * doublon, dans l'ordre des jours, même en deux validations simultanées ; son contenu est figé ; elle part à la
 * plateforme agréée de facturation électronique par une interface, en mode essai seulement tant que H26 n'est pas
 * fait. Une facture ne change ni ne s'efface : un avoir, numéroté dans la même suite, la corrige, et un nouveau
 * brouillon peut alors être préparé. La facture d'honoraires validée passe la commission à « facturée ». L'export
 * comptable, au format tableur, recompte les montants au centime.
 *
 * Décidé, lecture prudente : TVA de 20 % sur les honoraires du réseau. Le reversement suit le régime de TVA de l'agent
 * qui le facture, lu dans son identité réelle (AU093) : la part de l'agent est hors taxe ; soumis à la TVA, il facture
 * cette part et 20 % de TVA en plus ; en franchise en base, la part seule, avec la mention de son exonération ; son
 * identité absente, aucune TVA, ce que la facture dit, en attendant la validation de l'expert-comptable (H26) ; chaque facture d'essai porte
 * « facture d'essai, sans valeur comptable » ; la prime de parrainage n'est facturée qu'après l'encaissement (K03, R83) ;
 * une part nulle ne donne pas de facture ; aucune coordonnée bancaire nulle part [R15].
 *
 * Factures réelles (AU013) [R71] : derrière une plateforme agréée réelle (H26), une facture validée est réelle. Elle
 * n'est numérotée que si ses identités sont complètes (son XML Factur-X s'écrira, R254) ; elle prend alors, dans la même
 * écriture, son numéro officiel dans une suite réelle à elle (`FAC-`, `REV-`, `AVO-`), sans trou ni numéro d'essai ;
 * ses mentions sont tirées des identités réelles, jamais de l'essai ; elle n'est déposée qu'avec son XML, et le cycle de
 * vie que la plateforme renvoie (déposée, rejetée, refusée, encaissée…) est rangé statut après statut. Une facture
 * d'essai ne part jamais à la plateforme réelle, ni une facture réelle à celle d'essai.
 */
import { ROLES, decideAccess, type Viewer } from '../acces/droits.ts';
import { runBatch, type SqlDatabase, type SqlStatement } from '../db/sql.ts';
import { localTime } from '../envoi/horaires.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import type { Acces } from '../acces/acces.ts';
import { Commissions } from './commissions.ts';
import { FACTURX_PROFILE, factureElectronique, manquesFacturX, type IdentiteClient, type IdentiteEmetteur, type RegimeTva } from './facturx.ts';

const TIME_ZONE = 'Europe/Paris';
export const TRIAL_NOTICE = 'Facture d’essai, sans valeur comptable.';
export const DEFAULT_VAT_BP = { honoraires: 2000, reversement: 0 } as const;
/** AU093 · le taux normal de la TVA, pour le reversement d'un agent soumis à la TVA. */
export const STANDARD_VAT_BP = 2000;

/**
 * AU093 · le reversement d'une part hors taxe, selon le régime de l'agent qui le facture : le montant toutes taxes et
 * son taux. Le hors taxe recompté par `splitVat` est toujours la part, au centime.
 */
export function reversementAmount(shareHtCents: number, regime: RegimeTva | null, fallbackBp: number): { ttcCents: number; vatBp: number } {
  if (regime === null) return { ttcCents: shareHtCents, vatBp: fallbackBp };
  if (regime.category === 'E') return { ttcCents: shareHtCents, vatBp: 0 };
  let ttc = shareHtCents + Math.round((shareHtCents * STANDARD_VAT_BP) / 10_000);
  // Un arrondi qui ne rendrait pas la part au centime est repris d'un centime, dans le sens qui la rend.
  for (let i = 0; i < 3 && splitVat(ttc, STANDARD_VAT_BP).htCents !== shareHtCents; i++) ttc += splitVat(ttc, STANDARD_VAT_BP).htCents < shareHtCents ? 1 : -1;
  return { ttcCents: ttc, vatBp: STANDARD_VAT_BP };
}

export type InvoiceKind = 'honoraires' | 'reversement' | 'avoir';
export const CREDIT_REASONS = ['erreur_montant', 'erreur_destinataire', 'vente_annulee', 'autre'] as const;
const REASONS = CREDIT_REASONS;

export interface InvoiceContent {
  label: string;
  kind: InvoiceKind;
  issuedOn: string;
  issuer: string;
  recipient: string;
  designation: string;
  htCents: number;
  vatBp: number;
  vatCents: number;
  ttcCents: number;
  mentions: string[];
  corrects: string | null;
  /** Le jour de l'acte de la vente facturée. */
  saleDay: string | null;
  /** La raison d'un avoir. */
  reason: (typeof REASONS)[number] | null;
  /** `reel` pour une facture réelle (AU013) ; absent ou `essai` sinon, comme toutes les factures d'avant. */
  mode?: InvoiceMode;
}

export type InvoiceMode = 'essai' | 'reel';

/**
 * Le cycle de vie d'une facture électronique, dans la liste fermée de la réforme (codes 200 à 213). Déposée, rejetée,
 * refusée et encaissée sont les statuts que toute plateforme agréée doit transmettre ; les autres sont facultatifs.
 */
export const STATUTS_CYCLE: Readonly<Record<number, string>> = {
  200: 'Déposée',
  201: 'Émise par la plateforme',
  202: 'Reçue par la plateforme',
  203: 'Mise à disposition',
  204: 'Prise en charge',
  205: 'Approuvée',
  206: 'Approuvée partiellement',
  207: 'En litige',
  208: 'Suspendue',
  209: 'Complétée',
  210: 'Refusée',
  211: 'Paiement transmis',
  212: 'Encaissée',
  213: 'Rejetée',
};
/** Les statuts après lesquels plus rien n'est demandé à la plateforme. */
const FINAL_STATUSES = [210, 212, 213] as const;

export interface InvoiceView {
  id: string;
  fileId: string;
  issuer: string;
  content: InvoiceContent;
  transmitted: { mode: InvoiceMode; platformRef: string } | null;
  /** Le dernier statut du cycle de vie dit par la plateforme réelle ; `null` en essai ou avant le premier statut. */
  status: { code: number; name: string; at: string } | null;
  /** Le XML Factur-X écrit pour cette facture, par son empreinte ; `null` tant qu'une identité manque (HX04). */
  facturX: { profile: string; sha256: string } | null;
}

/**
 * Les identités réelles de la facture électronique (HX04) : la société du réseau et chaque agent qui facture, avec
 * leur SIREN, leur adresse, leur régime de TVA et leurs conditions de paiement ; l'adresse du client qui paie. Rien
 * n'est deviné : une identité absente rend `null`, et la facture attend, sans XML [R254].
 */
export interface IdentitesFacturation {
  emetteur(networkId: string, issuer: string): Promise<IdentiteEmetteur | null>;
  client(networkId: string, personId: string): Promise<IdentiteClient | null>;
}

/** Tant que la société n'est pas créée (H09) et que les adresses ne sont pas saisies : aucune identité. */
export const AUCUNE_IDENTITE: IdentitesFacturation = { emetteur: async () => null, client: async () => null };

const sha256 = async (text: string): Promise<string> =>
  [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].map((b) => b.toString(16).padStart(2, '0')).join('');

export interface DraftView {
  id: string;
  fileId: string;
  kind: 'honoraires' | 'reversement';
  issuer: string;
  amountCents: number;
  vatBp: number;
  createdAt: string;
}

/**
 * La plateforme agréée de facturation électronique, derrière une interface [R26]. Celle d'essai ne transmet rien ; la
 * réelle (H26) reçoit chaque facture réelle avec son XML, écarte un second dépôt du même identifiant, et rend le cycle
 * de vie de chaque dépôt.
 */
export interface PlateformeFacturation {
  readonly mode: InvoiceMode;
  transmit(invoice: { id: string; content: InvoiceContent; facturX: string | null }): Promise<{ ref: string }>;
  /** Les statuts du cycle de vie d'un dépôt, dans l'ordre où la plateforme les a pris (code de 200 à 213, horodatage). */
  statuses?(ref: string): Promise<{ code: number; at: string }[]>;
}

/** La plateforme d'essai : elle reçoit, ne transmet rien à personne. */
export class PlateformeEssai implements PlateformeFacturation {
  readonly mode = 'essai' as const;
  readonly received: string[] = [];
  /** Les XML Factur-X reçus, par numéro de facture. */
  readonly xml = new Map<string, string>();
  async transmit(invoice: { id: string; content: InvoiceContent; facturX: string | null }): Promise<{ ref: string }> {
    this.received.push(invoice.content.label);
    if (invoice.facturX) this.xml.set(invoice.content.label, invoice.facturX);
    return { ref: `essai:${invoice.id}` };
  }
}

export type InvoiceRefusal = { ok: false; rule: 'R16'; code: string };
type InvoiceProblem = { ok: false; rule: null | 'R71' | 'R254'; code: 'unknown' | 'already' | 'bad_reason' | 'not_creditable' | 'bad_day' | 'busy' | 'sale_cancelled' | 'identity_missing' | 'platform_essai' };

/** Hors taxe et TVA d'un montant toutes taxes, au centime ; la TVA est le reste, pour que tout se recompte. */
export function splitVat(ttcCents: number, vatBp: number): { htCents: number; vatCents: number } {
  const htCents = Math.round((ttcCents * 10_000) / (10_000 + vatBp));
  return { htCents, vatCents: ttcCents - htCents };
}

const euros = (cents: number): string => {
  const sign = cents < 0 ? '-' : '';
  const a = Math.abs(cents);
  return `${sign}${Math.floor(a / 100)},${String(a % 100).padStart(2, '0')}`;
};

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Les mentions d'une facture réelle, toutes tirées des identités réelles, jamais inventées [R71, R254] : la catégorie de
 * l'opération (une prestation de services), les identifiants de l'émetteur, celui du client professionnel, le motif
 * d'exonération de TVA quand il y en a un, l'option pour la TVA d'après les débits quand l'émetteur l'a prise, et ses
 * conditions de paiement (pénalités et indemnité de recouvrement comprises, dites par lui).
 */
export function realMentions(kind: InvoiceKind, seller: IdentiteEmetteur, buyer: IdentiteClient): string[] {
  return [
    'Catégorie de l’opération : prestation de services.',
    `SIREN de l’émetteur : ${seller.siren}.`,
    ...(seller.vatId ? [`TVA intracommunautaire de l’émetteur : ${seller.vatId}.`] : []),
    ...(buyer.siren ? [`SIREN du client : ${buyer.siren}.`] : []),
    ...(seller.regime.category === 'E' ? [`${seller.regime.exemptionReason.trim().replace(/\.$/, '')}.`] : []),
    ...(seller.vatOnDebits === true && kind !== 'avoir' ? ['Option pour le paiement de la taxe d’après les débits.'] : []),
    seller.paymentTerms.trim(),
  ];
}

export class Factures {
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly plateforme: PlateformeFacturation;
  private readonly vat: { honoraires: number; reversement: number };
  private readonly commissions: Commissions;
  private readonly identites: IdentitesFacturation;

  constructor(
    private readonly db: SqlDatabase,
    acces: Acces,
    private readonly journal: JournalStore,
    options: { now?: () => Date; newId?: () => string; plateforme?: PlateformeFacturation; vatBp?: { honoraires: number; reversement: number }; identites?: IdentitesFacturation } = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => crypto.randomUUID());
    this.plateforme = options.plateforme ?? new PlateformeEssai();
    if (this.plateforme.mode !== 'essai' && this.plateforme.mode !== 'reel') throw new Error('Plateforme de facturation inconnue [R71].');
    this.vat = options.vatBp ?? { ...DEFAULT_VAT_BP };
    this.identites = options.identites ?? AUCUNE_IDENTITE;
    this.commissions = new Commissions(db, acces, journal, { now: this.now });
  }

  private actor(viewer: Viewer): string {
    return `${String(viewer.role)}:${viewer.userId}`;
  }

  private async refuse(viewer: Viewer, kind: string, code: string): Promise<InvoiceRefusal> {
    await appendEvent(this.journal, { type: 'acces.refuse', actor: this.actor(viewer), subject: `network:${viewer.networkId}`, data: { rule: 'R16', role: String(viewer.role), kind, code } }, this.now);
    return { ok: false, rule: 'R16', code };
  }

  /** La direction seule valide, corrige et exporte (droits du socle : les chiffres) [R16]. */
  private async directionRefusal(viewer: Viewer, kind: string): Promise<InvoiceRefusal | null> {
    if (viewer.role !== 'direction') return this.refuse(viewer, kind, 'role');
    const d = decideAccess(viewer, { kind: 'figures', networkId: viewer.networkId, agentId: viewer.userId });
    return d.allowed ? null : this.refuse(viewer, kind, d.code);
  }

  private async waiting(fileId: string, code: string): Promise<void> {
    const seen = (await this.journal.bySubject(`sale_file:${fileId}`)).some((e) => e.type === 'facture.attente' && e.data.code === code);
    if (!seen) await appendEvent(this.journal, { type: 'facture.attente', actor: 'system:pilotage', subject: `sale_file:${fileId}`, data: { rule: 'R71', code } }, this.now);
  }

  /** Ce qui reste à facturer pour ce dossier, cette sorte et cet émetteur : rien d'émis net, aucun brouillon ouvert. */
  private async nextRound(fileId: string, kind: 'honoraires' | 'reversement', issuer: string): Promise<number | null> {
    const open = await this.db.first('SELECT 1 FROM invoice_drafts d WHERE d.file_id = ? AND d.kind = ? AND d.issuer = ? AND NOT EXISTS (SELECT 1 FROM invoices i WHERE i.draft_id = d.id)', [fileId, kind, issuer]);
    if (open) return null;
    const net = await this.db.first<{ n: number | null }>(
      `SELECT SUM(i.amount_cents) AS n FROM invoices i WHERE i.file_id = ? AND i.issuer = ?
         AND (i.kind = ? OR (i.kind = 'avoir' AND (SELECT o.kind FROM invoices o WHERE o.id = i.corrects_invoice_id) = ?))`,
      [fileId, issuer, kind, kind],
    );
    const issued = await this.db.first<{ n: number }>('SELECT COUNT(*) AS n FROM invoices WHERE file_id = ? AND issuer = ? AND kind = ?', [fileId, issuer, kind]);
    if ((issued?.n ?? 0) > 0 && (net?.n ?? 0) !== 0) return null;
    // Une vente annulée ne se refacture jamais d'elle-même.
    const cancelled = await this.db.first("SELECT 1 FROM invoices WHERE file_id = ? AND kind = 'avoir' AND json_extract(content, '$.reason') = 'vente_annulee'", [fileId]);
    if (cancelled) return null;
    const last = await this.db.first<{ r: number | null }>('SELECT MAX(round) AS r FROM invoice_drafts WHERE file_id = ? AND kind = ? AND issuer = ?', [fileId, kind, issuer]);
    return (last?.r ?? 0) + 1;
  }

  /**
   * Le passage : un brouillon d'honoraires et un brouillon de reversement par agent pour chaque commission due, une
   * seule fois [R18]. Rend le nombre de brouillons préparés.
   */
  async prepare(networkId: string): Promise<number> {
    await this.reconcile(networkId);
    let made = 0;
    const files = await this.db.all<{ file_id: string; fee_cents: number; fee_charge: 'vendeur' | 'acquereur' | null; mandate_id: string }>(
      `SELECT c.file_id, c.fee_cents, c.fee_charge, c.mandate_id FROM commissions c
       WHERE c.network_id = ? AND EXISTS (SELECT 1 FROM commission_steps s WHERE s.file_id = c.file_id AND s.status = 'due')
       ORDER BY c.compromis_on, c.file_id`,
      [networkId],
    );
    const at = this.now().toISOString();
    const add = async (fileId: string, kind: 'honoraires' | 'reversement', issuer: string, recipient: string | null, amount: number, vatBp: number) => {
      const round = await this.nextRound(fileId, kind, issuer);
      if (round === null) return;
      const { changes } = await this.db.run(
        'INSERT INTO invoice_drafts (id, network_id, file_id, kind, issuer, recipient_person_id, amount_cents, vat_bp, round, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING',
        [this.newId(), networkId, fileId, kind, issuer, recipient, amount, vatBp, round, at],
      );
      if (changes === 1) made += 1;
    };
    for (const f of files) {
      if (f.fee_charge === null) {
        await this.waiting(f.file_id, 'payeur_inconnu');
      } else if (f.fee_cents > 0) {
        const payer =
          f.fee_charge === 'vendeur'
            ? (await this.db.first<{ person_id: string }>('SELECT person_id FROM mandates WHERE id = ?', [f.mandate_id]))?.person_id
            : (await this.db.first<{ buyer_person_id: string }>('SELECT buyer_person_id FROM sale_files WHERE id = ?', [f.file_id]))?.buyer_person_id;
        if (payer) await add(f.file_id, 'honoraires', 'reseau', payer, f.fee_cents, this.vat.honoraires);
        else await this.waiting(f.file_id, 'payeur_inconnu');
      }
      const shares = await this.db.all<{ beneficiary_id: string; amount_cents: number }>(
        "SELECT beneficiary_id, SUM(amount_cents) AS amount_cents FROM commission_shares WHERE file_id = ? AND kind IN ('agent', 'partage') GROUP BY beneficiary_id ORDER BY beneficiary_id",
        [f.file_id],
      );
      for (const s of shares) {
        if (s.amount_cents <= 0) continue;
        const issuer = `agent:${s.beneficiary_id}`;
        const seller = await this.regimeOf(networkId, issuer);
        const r = reversementAmount(s.amount_cents, seller, this.vat.reversement);
        await add(f.file_id, 'reversement', issuer, null, r.ttcCents, r.vatBp);
      }
    }
    return made;
  }

  /** Les brouillons à valider : la direction seule [R16]. */
  async drafts(viewer: Viewer): Promise<{ ok: true; value: DraftView[] } | InvoiceRefusal> {
    const refusal = await this.directionRefusal(viewer, 'invoice_drafts');
    if (refusal) return refusal;
    const rows = await this.db.all<{ id: string; file_id: string; kind: 'honoraires' | 'reversement'; issuer: string; amount_cents: number; vat_bp: number; created_at: string }>(
      "SELECT d.id, d.file_id, d.kind, d.issuer, d.amount_cents, d.vat_bp, d.created_at FROM invoice_drafts d WHERE d.network_id = ? AND NOT EXISTS (SELECT 1 FROM invoices i WHERE i.draft_id = d.id) ORDER BY d.created_at, CASE d.kind WHEN 'honoraires' THEN 0 ELSE 1 END, d.issuer, d.round",
      [viewer.networkId],
    );
    return { ok: true, value: rows.map((r) => ({ id: r.id, fileId: r.file_id, kind: r.kind, issuer: r.issuer, amountCents: r.amount_cents, vatBp: r.vat_bp, createdAt: r.created_at })) };
  }

  private async nameOf(networkId: string, party: string): Promise<string> {
    if (party === 'reseau') return (await this.db.first<{ name: string }>('SELECT name FROM networks WHERE id = ?', [networkId]))?.name ?? 'Réseau';
    if (party.startsWith('agent:')) {
      const a = await this.db.first<{ first_name: string; last_name: string }>('SELECT first_name, last_name FROM agents WHERE id = ?', [party.slice(6)]);
      return a ? `${a.first_name} ${a.last_name}` : 'Agent';
    }
    const p = await this.db.first<{ first_name: string | null; last_name: string | null }>('SELECT first_name, last_name FROM persons WHERE id = ?', [party.slice(7)]);
    return [p?.first_name, p?.last_name].filter((x) => x).join(' ') || 'Client';
  }

  /** Le code d'un émetteur dans le numéro : rien pour le réseau, l'agent sinon, pour qu'un numéro soit unique. */
  private issuerCode(issuer: string): string {
    // Les tirets de l'identifiant sont gardés : collés, les chiffres d'un UUID peuvent former un faux numéro de
    // téléphone, que le journal refuse ; un UUID entier est reconnu comme identifiant interne [R13].
    return issuer === 'reseau' ? '' : `${issuer.slice(6).toUpperCase().replace(/[^A-Z0-9-]/g, '')}-`;
  }

  /**
   * Le numéro lisible. Une facture réelle a son préfixe à elle (`FAC`, `REV`, `AVO`) et son numéro officiel : jamais le
   * même texte qu'une facture d'essai, dont les numéros d'avant restent ce qu'ils étaient.
   */
  private label(kind: InvoiceKind, issuer: string, year: number, number: number, mode: InvoiceMode = 'essai'): string {
    const prefix = mode === 'reel' ? (kind === 'honoraires' ? 'FAC' : kind === 'reversement' ? 'REV' : 'AVO') : kind === 'honoraires' ? 'F' : kind === 'reversement' ? 'RV' : 'AV';
    return `${prefix}-${this.issuerCode(issuer)}${year}-${String(number).padStart(5, '0')}`;
  }

  /**
   * Numérote et range une facture en une seule écriture : le numéro est le suivant de l'émetteur pour l'année, calculé
   * dans l'écriture même, atomique ; le numéro n'est pas dans le contenu figé, il se lit dans la ligne. Deux validations
   * simultanées prennent deux numéros qui se suivent. Rend l'identifiant, `null` si le brouillon ou la facture corrigée
   * l'ont déjà été, `busy` si l'ordre des jours n'a pas pu être tenu (passage de minuit).
   */
  private async insert(networkId: string, issuer: string, kind: InvoiceKind, fileId: string, draftId: string | null, correctsId: string | null, content: Omit<InvoiceContent, 'label' | 'issuedOn'>, by: string): Promise<string | null | 'busy'> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const issuedOn = localTime(this.now(), TIME_ZONE).date;
      const year = Number(issuedOn.slice(0, 4));
      const id = this.newId();
      try {
        const statements: SqlStatement[] = [
          {
            sql: `INSERT INTO invoices (id, network_id, issuer, year, number, kind, file_id, draft_id, corrects_invoice_id, content, amount_cents, issued_on, validated_by, created_at)
           SELECT ?, ?, ?, ?, COALESCE(MAX(number), 0) + 1, ?, ?, ?, ?, ?, ?, ?, ?, ? FROM invoices WHERE network_id = ? AND issuer = ? AND year = ?
           ON CONFLICT (draft_id) DO NOTHING`,
            params: [id, networkId, issuer, year, kind, fileId, draftId, correctsId, JSON.stringify({ ...content, issuedOn }), content.ttcCents, issuedOn, by, this.now().toISOString(), networkId, issuer, year],
          },
        ];
        // Une facture réelle prend, dans la même écriture, le numéro suivant de sa suite réelle : les deux lignes
        // existent ensemble ou pas du tout [R71].
        if (content.mode === 'reel') {
          statements.push({
            sql: `INSERT INTO invoice_real_numbers (invoice_id, network_id, issuer, year, number, issued_on)
             SELECT ?, ?, ?, ?, COALESCE((SELECT MAX(number) FROM invoice_real_numbers WHERE network_id = ? AND issuer = ? AND year = ?), 0) + 1, ?
             WHERE EXISTS (SELECT 1 FROM invoices WHERE id = ?)`,
            params: [id, networkId, issuer, year, networkId, issuer, year, issuedOn, id],
          });
        }
        // Une facture d'essai reste une seule écriture, comme avant ; une réelle, un lot tout ou rien.
        const first = statements.length === 1 ? await this.db.run(statements[0]!.sql, statements[0]!.params) : (await runBatch(this.db, statements))[0]!;
        return first.changes === 1 ? id : null;
      } catch (error) {
        if (correctsId && (await this.db.first('SELECT 1 FROM invoices WHERE corrects_invoice_id = ?', [correctsId]))) return null;
        if (draftId && (await this.db.first('SELECT 1 FROM invoices WHERE draft_id = ?', [draftId]))) return null;
        // Seul un conflit de suite (numéro pris, jour passé) se reprend ; toute autre panne va au journal et remonte.
        const message = error instanceof Error ? error.message : '';
        if (!/hors suite|UNIQUE constraint/i.test(message)) {
          await appendEvent(this.journal, { type: 'facture.erreur', actor: by, subject: `sale_file:${fileId}`, data: { kind, error: error instanceof Error ? error.name : 'unknown' } }, this.now);
          throw error;
        }
        if (attempt === 2) return 'busy';
      }
    }
    return 'busy';
  }

  /**
   * Le XML Factur-X de la facture, écrit une seule fois puis relu tel quel [R254]. Une identité manque : rien n'est
   * écrit, et ce qui manque va une fois au journal, par règle EN 16931, sans aucune donnée [R13] ; il sera écrit au
   * passage suivant si l'identité est donnée entre-temps, même si la facture est déjà partie en essai sans lui.
   */
  private async facturX(invoiceId: string, networkId: string, v: InvoiceView): Promise<string | null> {
    const stored = await this.db.first<{ xml: string }>('SELECT xml FROM invoice_facturx WHERE invoice_id = ?', [invoiceId]);
    if (stored) return stored.xml;
    const recipient = (await this.db.first<{ person_id: string | null }>(
      'SELECT d.recipient_person_id AS person_id FROM invoices i LEFT JOIN invoices o ON o.id = i.corrects_invoice_id JOIN invoice_drafts d ON d.id = COALESCE(i.draft_id, o.draft_id) WHERE i.id = ?',
      [invoiceId],
    ))?.person_id ?? null;
    let seller: IdentiteEmetteur | null = null;
    let buyer: IdentiteClient | null = null;
    try {
      ({ seller, buyer } = await this.parties(networkId, v.issuer, recipient));
    } catch (error) {
      // Une panne des identités n'arrête ni la facture ni le passage : sans XML cette fois, repris au suivant.
      await appendEvent(this.journal, { type: 'facture.facturx_panne', actor: 'system:pilotage', subject: `sale_file:${v.fileId}`, data: { rule: 'R254', label: v.content.label, error: error instanceof Error ? error.name : 'unknown' } }, this.now);
      return null;
    }
    const built = factureElectronique({ content: v.content, seller, buyer });
    if (!built.ok) {
      // Une fois par manque, avec sa règle EN 16931 : un manque nouveau (une identité donnée sans son adresse, par
      // exemple) va au journal même si la facture attendait déjà pour autre chose.
      const before = new Set(
        (await this.journal.bySubject(`sale_file:${v.fileId}`))
          .filter((e) => e.type === 'facture.facturx_attente' && e.data.label === v.content.label)
          .flatMap((e) => (Array.isArray(e.data.missing) ? (e.data.missing as string[]) : [])),
      );
      const fresh = built.missing.filter((m) => !before.has(m));
      if (fresh.length > 0) await appendEvent(this.journal, { type: 'facture.facturx_attente', actor: 'system:pilotage', subject: `sale_file:${v.fileId}`, data: { rule: 'R254', label: v.content.label, missing: fresh } }, this.now);
      return null;
    }
    await this.db.run('INSERT INTO invoice_facturx (invoice_id, profile, xml, sha256, at) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING', [invoiceId, FACTURX_PROFILE, built.xml, await sha256(built.xml), this.now().toISOString()]);
    return (await this.db.first<{ xml: string }>('SELECT xml FROM invoice_facturx WHERE invoice_id = ?', [invoiceId]))!.xml;
  }

  /** Les identités de la facture : l'émetteur ; le client d'honoraires qui paie, ou la société du réseau pour un reversement. */
  private async parties(networkId: string, issuer: string, recipient: string | null): Promise<{ seller: IdentiteEmetteur | null; buyer: IdentiteClient | null }> {
    const seller = await this.identites.emetteur(networkId, issuer);
    if (recipient) return { seller, buyer: await this.identites.client(networkId, recipient) };
    const reseau = await this.identites.emetteur(networkId, 'reseau');
    return { seller, buyer: reseau ? { name: reseau.name, siren: reseau.siren, address: reseau.address } : null };
  }

  /**
   * Avant de numéroter une facture réelle : ses identités, et ce qui manquerait à son XML [R254]. Le manque va une fois
   * au journal, par règle, sans donnée [R13] ; aucun numéro réel n'est pris, la facture attend. Rend les identités
   * complètes, ou `null`.
   */
  private async realParties(
    networkId: string,
    fileId: string,
    issuer: string,
    recipient: string | null,
    content: Omit<InvoiceContent, 'label' | 'issuedOn'>,
  ): Promise<{ seller: IdentiteEmetteur; buyer: IdentiteClient } | null> {
    let seller: IdentiteEmetteur | null = null;
    let buyer: IdentiteClient | null = null;
    try {
      ({ seller, buyer } = await this.parties(networkId, issuer, recipient));
    } catch (error) {
      await appendEvent(this.journal, { type: 'facture.facturx_panne', actor: 'system:pilotage', subject: `sale_file:${fileId}`, data: { rule: 'R254', mode: 'reel', error: error instanceof Error ? error.name : 'unknown' } }, this.now);
      return null;
    }
    const probe: InvoiceContent = { ...content, label: 'AVANT-NUMERO', issuedOn: localTime(this.now(), TIME_ZONE).date, mentions: seller && buyer ? realMentions(content.kind, seller, buyer) : [] };
    const missing = manquesFacturX({ content: probe, seller, buyer });
    if (missing.length === 0 && seller && buyer) return { seller, buyer };
    const key = `${content.kind}:${issuer}`;
    const before = new Set(
      (await this.journal.bySubject(`sale_file:${fileId}`))
        .filter((e) => e.type === 'facture.reelle_attente' && e.data.key === key)
        .flatMap((e) => (Array.isArray(e.data.missing) ? (e.data.missing as string[]) : [])),
    );
    const fresh = missing.filter((m) => !before.has(m));
    if (fresh.length > 0) await appendEvent(this.journal, { type: 'facture.reelle_attente', actor: 'system:pilotage', subject: `sale_file:${fileId}`, data: { rule: 'R254', key, missing: fresh } }, this.now);
    return null;
  }

  /**
   * Réserve un essai d'envoi : le numéro d'essai suivant, pris par une seule écriture. Rend `null` si un autre essai est
   * en cours : réservé, ni réussi, ni dit en panne au journal, depuis moins d'une heure (au-delà, une coupure l'a
   * perdu, et la plateforme écarte un doublon par l'identifiant de la facture).
   */
  private async claimTransmission(invoiceId: string, fileId: string, label: string): Promise<number | null> {
    const last = await this.db.first<{ attempt: number; at: string }>('SELECT attempt, at FROM invoice_transmission_claims WHERE invoice_id = ? ORDER BY attempt DESC LIMIT 1', [invoiceId]);
    if (last) {
      const failed = (await this.journal.bySubject(`sale_file:${fileId}`)).some((e) => e.type === 'facture.envoi_en_panne' && e.data.label === label && e.data.attempt === last.attempt);
      const stale = this.now().getTime() - Date.parse(last.at) > 3_600_000;
      if (!failed && !stale) return null;
    }
    const attempt = (last?.attempt ?? 0) + 1;
    const { changes } = await this.db.run('INSERT INTO invoice_transmission_claims (invoice_id, attempt, at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING', [invoiceId, attempt, this.now().toISOString()]);
    return changes === 1 ? attempt : null;
  }

  /**
   * Ce qui suit une facture rangée, repris tant qu'il manque : l'envoi à la plateforme d'essai, la ligne du journal, et
   * pour une facture d'honoraires non annulée, la commission « facturée » [R67]. Une panne de la plateforme laisse la
   * facture rangée, sans envoi, reprise au passage suivant ; elle va au journal, sans donnée [R13].
   */
  private async follow(invoiceId: string, actor: string): Promise<void> {
    const v = (await this.byId(invoiceId))!;
    const row = (await this.db.first<{ network_id: string; kind: InvoiceKind }>('SELECT network_id, kind FROM invoices WHERE id = ?', [invoiceId]))!;
    // Un seul envoi à la fois : l'essai est réservé en base avant d'appeler la plateforme ; un autre passage qui le
    // trouve en cours s'arrête là, et le gagnant fait la suite, ligne du journal comprise, avant l'envoi (HX04) [R255].
    // L'identifiant de la facture va aussi à la plateforme, qui écarte un second envoi du même identifiant.
    // Une facture ne part qu'à une plateforme de son mode : jamais une facture d'essai à la plateforme réelle, ni une
    // réelle à celle d'essai. Une facture réelle ne part qu'avec son XML [R71, R254].
    const mode: InvoiceMode = v.content.mode === 'reel' ? 'reel' : 'essai';
    // Une facture réelle sans XML (identités tombées en panne après le numéro) ne réserve aucun envoi : elle est dite
    // une fois à la direction, et part au passage qui retrouve son XML.
    let realXml: string | null = null;
    if (!v.transmitted && mode === 'reel' && this.plateforme.mode === 'reel') {
      realXml = await this.facturX(invoiceId, row.network_id, v);
      if (realXml === null) await this.waiting(v.fileId, 'reelle_sans_xml:' + v.content.label); // un code d'attente, pas un sujet
    }
    const sendable = !v.transmitted && mode === this.plateforme.mode && (mode === 'essai' || realXml !== null);
    const attempt = sendable ? await this.claimTransmission(invoiceId, v.fileId, v.content.label) : null;
    if (sendable && attempt === null) return;
    const type = row.kind === 'avoir' ? 'facture.avoir' : 'facture.emise';
    if (!(await this.journal.bySubject(`sale_file:${v.fileId}`)).some((e) => e.type === type && e.data.label === v.content.label)) {
      // Au journal : la sorte, le numéro et le client qui paie (sa fiche, pour sa demande d'accès), jamais un montant
      // ni un nom [R13]. Un reversement n'a pas de client.
      const recipient = (await this.db.first<{ person_id: string | null }>(
        'SELECT d.recipient_person_id AS person_id FROM invoices i LEFT JOIN invoices o ON o.id = i.corrects_invoice_id JOIN invoice_drafts d ON d.id = COALESCE(i.draft_id, o.draft_id) WHERE i.id = ?',
        [invoiceId],
      ))?.person_id ?? null;
      await appendEvent(this.journal, { type, actor, subject: `sale_file:${v.fileId}`, data: { rule: 'R71', kind: row.kind, label: v.content.label, mode, ...(v.content.corrects ? { corrects: v.content.corrects } : {}), ...(recipient ? { client: `person:${recipient}` } : {}) } }, this.now);
    }
    // Le XML s'écrit dès que les identités sont là, même pour une facture déjà partie en essai sans lui [R254].
    const facturX = await this.facturX(invoiceId, row.network_id, v);
    if (sendable) {
      let ref: string | null = null;
      try {
        ref = (await this.plateforme.transmit({ id: invoiceId, content: v.content, facturX })).ref;
      } catch (error) {
        await appendEvent(this.journal, { type: 'facture.envoi_en_panne', actor: 'system:pilotage', subject: `sale_file:${v.fileId}`, data: { label: v.content.label, attempt, error: error instanceof Error ? error.name : 'unknown' } }, this.now);
      }
      // Hors du bloc de panne : une écriture ratée après un envoi reçu ne se dit jamais en panne, l'essai reste
      // réservé et ne se reprend qu'après l'heure, la plateforme écartant le doublon par l'identifiant [R255].
      if (ref !== null && mode === 'reel') await this.db.run('INSERT INTO invoice_real_deposits (invoice_id, platform_ref, at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING', [invoiceId, ref, this.now().toISOString()]);
      else if (ref !== null) await this.db.run("INSERT INTO invoice_transmissions (invoice_id, mode, platform_ref, at) VALUES (?, 'essai', ?, ?) ON CONFLICT DO NOTHING", [invoiceId, ref, this.now().toISOString()]);
    }
    if (row.kind === 'honoraires' && !(await this.db.first('SELECT 1 FROM invoices WHERE corrects_invoice_id = ?', [invoiceId]))) {
      const step = await this.commissions.recordStep(row.network_id, v.fileId, 'facturee', `facture:${v.content.label}`, actor);
      if (!step.ok && step.code !== 'already') {
        await this.waiting(v.fileId, `etape_${step.code}`);
      } else if (!step.ok) {
        // Déjà facturée par une facture depuis annulée par un avoir : la nouvelle facture le dit au journal, une fois.
        const proof = await this.db.first<{ proof_ref: string }>("SELECT proof_ref FROM commission_steps WHERE file_id = ? AND status = 'facturee'", [v.fileId]);
        if (proof && proof.proof_ref !== `facture:${v.content.label}`) await this.waiting(v.fileId, `remplace:${v.content.label}`);
      }
    }
  }

  /** Le régime de TVA de l'émetteur, s'il est connu ; une panne des identités n'arrête rien et ne devine rien. */
  private async regimeOf(networkId: string, issuer: string): Promise<RegimeTva | null> {
    try {
      return (await this.identites.emetteur(networkId, issuer))?.regime ?? null;
    } catch {
      return null;
    }
  }

  /** Les mentions d'une facture d'essai : jamais sur une facture réelle. */
  private mentions(vatBp: number, regime: RegimeTva | null = null): string[] {
    return [
      TRIAL_NOTICE,
      // AU093 · l'agent en franchise dit son exonération ; sans régime connu, la facture dit qu'elle attend.
      ...(vatBp === 0 && regime?.category === 'E' ? [`${regime.exemptionReason.trim().replace(/\.$/, '')}.`] : vatBp === 0 ? ['TVA non appliquée en mode essai, en attente de la validation de l’expert-comptable.'] : []),
      // Aucune mention inventée : les identifiants de l'émetteur viennent de la société et de la plateforme réelles.
      'Identifiants de l’émetteur, adresse du destinataire et conditions de paiement : à compléter à la création de la société (H09) et à la mise en service de la plateforme agréée (H26).',
    ];
  }

  /** La direction valide un brouillon : la facture est numérotée, figée, transmise en mode essai [R71, R26]. */
  async validate(viewer: Viewer, draftId: string): Promise<{ ok: true; value: InvoiceView } | InvoiceRefusal | InvoiceProblem> {
    const refusal = await this.directionRefusal(viewer, 'invoice');
    if (refusal) return refusal;
    return this.issue(viewer.networkId, draftId, this.actor(viewer));
  }

  /**
   * Le jour de l'acte, les factures partent toutes seules (HX04) [R255] : chaque brouillon d'un dossier dont l'acte est
   * signé est validé par le système, sans attendre la direction, s'il retombe encore au centime sur le dossier — les
   * honoraires de la commission, la part de chaque agent après la part de l'agence partenaire (HX59). Un écart n'émet
   * rien et va une fois au journal. La numérotation reste celle de K02 : jamais deux factures d'un même brouillon.
   * Rend le nombre de factures émises.
   */
  async issueOnDeed(networkId: string): Promise<number> {
    const today = localTime(this.now(), TIME_ZONE).date;
    const rows = await this.db.all<{ id: string; file_id: string; kind: 'honoraires' | 'reversement'; issuer: string; amount_cents: number }>(
      `SELECT d.id, d.file_id, d.kind, d.issuer, d.amount_cents FROM invoice_drafts d JOIN sale_file_closings c ON c.file_id = d.file_id
       WHERE d.network_id = ? AND c.signed_on <= ? AND NOT EXISTS (SELECT 1 FROM invoices i WHERE i.draft_id = d.id)
       ORDER BY d.created_at, CASE d.kind WHEN 'honoraires' THEN 0 ELSE 1 END, d.issuer, d.round`,
      [networkId, today],
    );
    let issued = 0;
    for (const d of rows) {
      const expected =
        d.kind === 'honoraires'
          ? (await this.db.first<{ n: number }>('SELECT fee_cents AS n FROM commissions WHERE file_id = ?', [d.file_id]))?.n
          : (await this.db.first<{ n: number | null }>("SELECT SUM(amount_cents) AS n FROM commission_shares WHERE file_id = ? AND kind IN ('agent', 'partage') AND beneficiary_id = ?", [d.file_id, d.issuer.slice(6)]))?.n;
      if (expected !== d.amount_cents) {
        await this.waiting(d.file_id, `ecart_dossier:${d.kind}`);
        continue;
      }
      const r = await this.issue(networkId, d.id, 'system:facturation');
      if (r.ok) issued += 1;
    }
    return issued;
  }

  private async issue(networkId: string, draftId: string, actor: string): Promise<{ ok: true; value: InvoiceView } | InvoiceProblem> {
    const d = await this.db.first<{ id: string; network_id: string; file_id: string; kind: 'honoraires' | 'reversement'; issuer: string; recipient_person_id: string | null; amount_cents: number; vat_bp: number }>(
      'SELECT id, network_id, file_id, kind, issuer, recipient_person_id, amount_cents, vat_bp FROM invoice_drafts WHERE id = ?',
      [draftId],
    );
    if (!d || d.network_id !== networkId) return { ok: false, rule: null, code: 'unknown' };
    const done = await this.db.first<{ id: string }>('SELECT id FROM invoices WHERE draft_id = ?', [draftId]);
    if (done) {
      // Déjà numérotée : ce qui aurait manqué après une coupure est repris.
      await this.follow(done.id, actor);
      return { ok: false, rule: null, code: 'already' };
    }
    // Une vente annulée par un avoir n'émet plus aucune facture, même d'un brouillon préparé avant.
    if (await this.db.first("SELECT 1 FROM invoices WHERE file_id = ? AND kind = 'avoir' AND json_extract(content, '$.reason') = 'vente_annulee'", [d.file_id])) {
      return { ok: false, rule: 'R71', code: 'sale_cancelled' };
    }
    const reference = (await this.db.first<{ reference: string }>('SELECT p.reference FROM sale_files f JOIN properties p ON p.id = f.property_id WHERE f.id = ?', [d.file_id]))?.reference ?? '';
    const saleDay = (await this.db.first<{ signed_on: string }>('SELECT signed_on FROM sale_file_closings WHERE file_id = ?', [d.file_id]))?.signed_on ?? null;
    const { htCents, vatCents } = splitVat(d.amount_cents, d.vat_bp);
    const content: Omit<InvoiceContent, 'label' | 'issuedOn'> = {
      kind: d.kind,
      issuer: await this.nameOf(d.network_id, d.issuer),
      recipient: d.kind === 'honoraires' ? await this.nameOf(d.network_id, `person:${d.recipient_person_id}`) : await this.nameOf(d.network_id, 'reseau'),
      designation: d.kind === 'honoraires' ? `Honoraires de transaction, bien ${reference}` : `Reversement de commission, vente du bien ${reference}`,
      saleDay,
      htCents,
      vatBp: d.vat_bp,
      vatCents,
      ttcCents: d.amount_cents,
      mentions: this.mentions(d.vat_bp, d.kind === 'reversement' ? await this.regimeOf(d.network_id, d.issuer) : null),
      corrects: null,
      reason: null,
    };
    if (this.plateforme.mode === 'reel') {
      // Une facture réelle : identités complètes d'abord, ou rien n'est numéroté ; ses mentions viennent d'elles [R71, R254].
      const parties = await this.realParties(d.network_id, d.file_id, d.issuer, d.kind === 'honoraires' ? d.recipient_person_id : null, content);
      if (!parties) return { ok: false, rule: 'R254', code: 'identity_missing' };
      content.mode = 'reel';
      content.mentions = realMentions(d.kind, parties.seller, parties.buyer);
    }
    const id = await this.insert(d.network_id, d.issuer, d.kind, d.file_id, d.id, null, content, actor);
    if (id === 'busy') return { ok: false, rule: null, code: 'busy' };
    if (!id) return { ok: false, rule: null, code: 'already' };
    await this.follow(id, actor);
    return { ok: true, value: (await this.byId(id))! };
  }

  /** Un avoir corrige une facture émise, une seule fois, dans la même suite de numéros [R71, R17]. */
  async credit(viewer: Viewer, invoiceId: string, reason: string): Promise<{ ok: true; value: InvoiceView } | InvoiceRefusal | InvoiceProblem> {
    const refusal = await this.directionRefusal(viewer, 'invoice_credit');
    if (refusal) return refusal;
    if (!(REASONS as readonly string[]).includes(reason)) return { ok: false, rule: null, code: 'bad_reason' };
    const original = await this.byId(invoiceId);
    const row = await this.db.first<{ network_id: string; file_id: string; issuer: string; kind: InvoiceKind }>('SELECT network_id, file_id, issuer, kind FROM invoices WHERE id = ?', [invoiceId]);
    if (!original || !row || row.network_id !== viewer.networkId) return { ok: false, rule: null, code: 'unknown' };
    if (row.kind === 'avoir') return { ok: false, rule: 'R71', code: 'not_creditable' };
    const done = await this.db.first<{ id: string }>('SELECT id FROM invoices WHERE corrects_invoice_id = ?', [invoiceId]);
    if (done) {
      await this.follow(done.id, this.actor(viewer));
      return { ok: false, rule: null, code: 'already' };
    }
    const o = original.content;
    const content: Omit<InvoiceContent, 'label' | 'issuedOn'> = {
      kind: 'avoir',
      issuer: o.issuer,
      recipient: o.recipient,
      designation: `Avoir sur la facture ${o.label}`,
      saleDay: o.saleDay,
      htCents: -o.htCents,
      vatBp: o.vatBp,
      vatCents: -o.vatCents,
      ttcCents: -o.ttcCents,
      mentions: [...this.mentions(o.vatBp), `Annule la facture ${o.label}.`],
      corrects: o.label,
      reason: reason as (typeof REASONS)[number],
    };
    // L'avoir suit sa facture : réel pour une facture réelle, par la plateforme réelle seulement ; d'essai sinon, jamais
    // numéroté dans la suite réelle [R71].
    if (o.mode === 'reel') {
      if (this.plateforme.mode !== 'reel') return { ok: false, rule: 'R71', code: 'platform_essai' };
      const recipient = (await this.db.first<{ person_id: string | null }>('SELECT d.recipient_person_id AS person_id FROM invoices i JOIN invoice_drafts d ON d.id = i.draft_id WHERE i.id = ?', [invoiceId]))?.person_id ?? null;
      const parties = await this.realParties(row.network_id, row.file_id, row.issuer, row.kind === 'honoraires' ? recipient : null, content);
      if (!parties) return { ok: false, rule: 'R254', code: 'identity_missing' };
      content.mode = 'reel';
      content.mentions = [...realMentions('avoir', parties.seller, parties.buyer), `Annule la facture ${o.label}.`];
    }
    const id = await this.insert(row.network_id, row.issuer, 'avoir', row.file_id, null, invoiceId, content, this.actor(viewer));
    if (id === 'busy') return { ok: false, rule: null, code: 'busy' };
    if (!id) return { ok: false, rule: null, code: 'already' };
    await this.follow(id, this.actor(viewer));
    if (reason === 'vente_annulee') await this.waiting(row.file_id, 'vente_annulee');
    return { ok: true, value: (await this.byId(id))! };
  }

  /** Reprend, pour chaque facture du réseau, ce qui aurait manqué après une coupure ou une panne de la plateforme. */
  async reconcile(networkId: string): Promise<number> {
    const rows = await this.db.all<{ id: string; validated_by: string }>('SELECT id, validated_by FROM invoices WHERE network_id = ? ORDER BY created_at, id', [networkId]);
    for (const r of rows) await this.follow(r.id, r.validated_by);
    return rows.length;
  }

  private async byId(id: string): Promise<InvoiceView | null> {
    const r = await this.db.first<{ id: string; file_id: string; issuer: string; kind: InvoiceKind; year: number; number: number; real_number: number | null; content: string; platform_ref: string | null; real_ref: string | null; profile: string | null; sha256: string | null }>(
      `SELECT i.id, i.file_id, i.issuer, i.kind, i.year, i.number, n.number AS real_number, i.content, t.platform_ref, rd.platform_ref AS real_ref, x.profile, x.sha256
       FROM invoices i LEFT JOIN invoice_transmissions t ON t.invoice_id = i.id LEFT JOIN invoice_real_numbers n ON n.invoice_id = i.id
       LEFT JOIN invoice_real_deposits rd ON rd.invoice_id = i.id LEFT JOIN invoice_facturx x ON x.invoice_id = i.id WHERE i.id = ?`,
      [id],
    );
    if (!r) return null;
    const stored = JSON.parse(r.content) as Omit<InvoiceContent, 'label'>;
    // Réelle seulement avec son numéro réel : la base les écrit ensemble [R71].
    const real = stored.mode === 'reel' && r.real_number !== null;
    const content: InvoiceContent = { ...stored, label: real ? this.label(r.kind, r.issuer, r.year, r.real_number!, 'reel') : this.label(r.kind, r.issuer, r.year, r.number) };
    const last = real ? await this.db.first<{ code: number; at: string }>('SELECT code, at FROM invoice_real_statuses WHERE invoice_id = ? ORDER BY seq DESC LIMIT 1', [id]) : null;
    return {
      id: r.id,
      fileId: r.file_id,
      issuer: r.issuer,
      content,
      transmitted: real ? (r.real_ref ? { mode: 'reel', platformRef: r.real_ref } : null) : r.platform_ref ? { mode: 'essai', platformRef: r.platform_ref } : null,
      status: last ? { code: last.code, name: STATUTS_CYCLE[last.code] ?? String(last.code), at: last.at } : null,
      facturX: r.profile && r.sha256 ? { profile: r.profile, sha256: r.sha256 } : null,
    };
  }

  /** La ligne du journal d'un statut rangé, et l'alerte d'une facture rejetée ou refusée : une seule fois chacune. */
  private async noteStatus(fileId: string, label: string, code: number, at: string): Promise<void> {
    const seen = (await this.journal.bySubject(`sale_file:${fileId}`)).some((e) => e.type === 'facture.statut' && e.data.label === label && e.data.code === code && e.data.at === at);
    if (!seen) await appendEvent(this.journal, { type: 'facture.statut', actor: 'system:pilotage', subject: `sale_file:${fileId}`, data: { rule: 'R71', label, code, at } }, this.now);
    if (code === 213) await this.waiting(fileId, 'rejetee:' + label);
    if (code === 210) await this.waiting(fileId, 'refusee:' + label);
  }

  /**
   * Le suivi réel : pour chaque facture réelle déposée dont le cycle n'est pas fini, les statuts nouveaux que la
   * plateforme rend sont rangés dans l'ordre, une seule fois chacun ; un code hors de la liste de la réforme n'est
   * jamais rangé et va une fois au journal. Une facture rejetée ou refusée est dite à la direction, une fois. Au
   * journal : le numéro et le code, jamais un montant ni un nom [R13]. Rend le nombre de statuts rangés.
   */
  async track(networkId: string): Promise<number> {
    if (this.plateforme.mode !== 'reel' || !this.plateforme.statuses) return 0;
    // D'abord, ce qu'une coupure aurait laissé après un statut rangé : sa ligne du journal et l'alerte d'une facture
    // rejetée ou refusée, repris même pour une facture au cycle fini.
    const stored = await this.db.all<{ invoice_id: string; file_id: string; code: number; at: string }>(
      `SELECT s.invoice_id, i.file_id, s.code, s.at FROM invoice_real_statuses s JOIN invoices i ON i.id = s.invoice_id
       WHERE i.network_id = ? ORDER BY s.invoice_id, s.seq`,
      [networkId],
    );
    for (const st of stored) await this.noteStatus(st.file_id, (await this.byId(st.invoice_id))!.content.label, st.code, st.at);
    const rows = await this.db.all<{ invoice_id: string; platform_ref: string; file_id: string }>(
      `SELECT d.invoice_id, d.platform_ref, i.file_id FROM invoice_real_deposits d JOIN invoices i ON i.id = d.invoice_id
       WHERE i.network_id = ? AND NOT EXISTS (SELECT 1 FROM invoice_real_statuses s WHERE s.invoice_id = d.invoice_id AND s.code IN (${FINAL_STATUSES.join(', ')}))
       ORDER BY d.at, CASE i.issuer WHEN 'reseau' THEN 0 ELSE 1 END, i.issuer, i.year, i.number`,
      [networkId],
    );
    let added = 0;
    for (const r of rows) {
      const label = (await this.byId(r.invoice_id))!.content.label;
      let statuses: { code: number; at: string }[];
      try {
        statuses = await this.plateforme.statuses(r.platform_ref);
      } catch (error) {
        await appendEvent(this.journal, { type: 'facture.suivi_en_panne', actor: 'system:pilotage', subject: `sale_file:${r.file_id}`, data: { label, error: error instanceof Error ? error.name : 'unknown' } }, this.now);
        continue;
      }
      for (const st of statuses) {
        if (!Number.isInteger(st.code) || STATUTS_CYCLE[st.code] === undefined || Number.isNaN(Date.parse(st.at))) {
          await this.waiting(r.file_id, `statut_inconnu:${label}`);
          continue;
        }
        if (await this.db.first('SELECT 1 FROM invoice_real_statuses WHERE invoice_id = ? AND code = ? AND at = ?', [r.invoice_id, st.code, st.at])) continue;
        const { changes } = await this.db.run(
          `INSERT INTO invoice_real_statuses (invoice_id, seq, code, at, recorded_at)
           SELECT ?, COALESCE((SELECT MAX(seq) FROM invoice_real_statuses WHERE invoice_id = ?), 0) + 1, ?, ?, ? ON CONFLICT DO NOTHING`,
          [r.invoice_id, r.invoice_id, st.code, st.at, this.now().toISOString()],
        );
        if (changes !== 1) continue;
        added += 1;
        await this.noteStatus(r.file_id, label, st.code, st.at);
        if ((FINAL_STATUSES as readonly number[]).includes(st.code)) break;
      }
    }
    return added;
  }

  /** Les factures : la direction voit le réseau ; un agent, seulement les reversements émis à son nom [R16, R68]. */
  async list(viewer: Viewer): Promise<{ ok: true; value: InvoiceView[] } | InvoiceRefusal> {
    if (!(ROLES as readonly string[]).includes(viewer.role)) return this.refuse(viewer, 'invoices', 'role');
    if (viewer.role === 'agent') {
      const agent = await this.db.first<{ network_id: string; status: string }>('SELECT network_id, status FROM agents WHERE id = ?', [viewer.userId]);
      if (!agent || agent.network_id !== viewer.networkId || agent.status !== 'active') return this.refuse(viewer, 'invoices', 'agent_inactive');
    } else {
      const refusal = await this.directionRefusal(viewer, 'invoices');
      if (refusal) return refusal;
    }
    const own = viewer.role === 'agent';
    const rows = await this.db.all<{ id: string }>(
      `SELECT id FROM invoices WHERE network_id = ?${own ? ' AND issuer = ?' : ''} ORDER BY CASE issuer WHEN 'reseau' THEN 0 ELSE 1 END, issuer, year, number`,
      own ? [viewer.networkId, `agent:${viewer.userId}`] : [viewer.networkId],
    );
    const value: InvoiceView[] = [];
    for (const r of rows) value.push((await this.byId(r.id))!);
    return { ok: true, value };
  }

  /**
   * L'export comptable d'une période, au format tableur (séparateur « ; », montants en euros à la virgule) : une ligne
   * par facture et avoir, dans l'ordre des suites ; la dernière ligne totalise, au centime [R69]. Derrière la plateforme
   * réelle, seules les factures réelles y sont : une facture d'essai n'entre jamais dans la comptabilité [R71].
   */
  async exportCsv(viewer: Viewer, fromDay: string, toDay: string): Promise<{ ok: true; value: string } | InvoiceRefusal | InvoiceProblem> {
    const refusal = await this.directionRefusal(viewer, 'invoice_export');
    if (refusal) return refusal;
    if (!DAY.test(fromDay) || !DAY.test(toDay) || fromDay > toDay) return { ok: false, rule: null, code: 'bad_day' };
    const rows = await this.db.all<{ id: string }>(
      `SELECT id FROM invoices i WHERE network_id = ? AND issued_on >= ? AND issued_on <= ?
         AND EXISTS (SELECT 1 FROM invoice_real_numbers n WHERE n.invoice_id = i.id) = ?
       ORDER BY CASE issuer WHEN 'reseau' THEN 0 ELSE 1 END, issuer, year, number`,
      [viewer.networkId, fromDay, toDay, this.plateforme.mode === 'reel' ? 1 : 0],
    );
    // Un texte qui commence comme une formule de tableur est neutralisé ; les montants ne passent pas par là.
    const text = (v: string) => (/^[=+\-@\t\r]/.test(v) ? `'${v}` : v);
    const cell = (v: string) => (/[;"\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
    const lines = ['numero;date;sorte;emetteur;destinataire;designation;ht;tva;ttc;facture_corrigee;mode'];
    let ht = 0;
    let vat = 0;
    let ttc = 0;
    for (const r of rows) {
      const c = (await this.byId(r.id))!.content;
      ht += c.htCents;
      vat += c.vatCents;
      ttc += c.ttcCents;
      lines.push([text(c.label), c.issuedOn, c.kind, text(c.issuer), text(c.recipient), text(c.designation), euros(c.htCents), euros(c.vatCents), euros(c.ttcCents), text(c.corrects ?? ''), c.mode === 'reel' ? 'reel' : 'essai'].map(cell).join(';'));
    }
    lines.push(['total', '', '', '', '', '', euros(ht), euros(vat), euros(ttc), '', ''].join(';'));
    await appendEvent(this.journal, { type: 'facture.export', actor: this.actor(viewer), subject: `network:${viewer.networkId}`, data: { from: fromDay, to: toDay, count: rows.length } }, this.now);
    return { ok: true, value: `${lines.join('\r\n')}\r\n` };
  }
}
