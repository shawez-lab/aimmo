/**
 * Espace partenaire : le dossier utile, rien d'autre (M18, U04) [R77].
 *
 * Un partenaire (rôle `partner`, `userId` = son identifiant dans l'annuaire) ne lit que les mises en relation qui lui
 * ont été confiées (U02), tant qu'elles sont ouvertes, puis pendant `CLOSED_ACCESS_DAYS` jours après leur clôture. Pour
 * chacune, il ne reçoit que les champs du dossier utile à son métier, listés par une règle écrite (`PARTNER_FIELDS`) :
 * jamais la fiche client entière, jamais une note, des critères libres ou une donnée sensible [R77, R23]. Un partenaire
 * dont un justificatif exigé est échu ce jour-là est refusé [R73].
 *
 * Chaque lecture et chaque refus sont écrits au journal avant que la donnée soit rendue, sans nom [R13, R16]. Le
 * partenaire dit où il en est (en cours, terminée) ; il ne dépose ses pièces qu'en U05.
 */
import type { Viewer } from '../acces/droits.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import type { Annuaire, DiagnosticDomain, PartnerTrade } from './annuaire.ts';
import type { MiseEnRelation, ReferralState } from './mise-en-relation.ts';

/** Jours pendant lesquels un partenaire relit une mise en relation close. Réglage. */
export const CLOSED_ACCESS_DAYS = 30;

/** Les champs qu'un partenaire peut recevoir ; chacun a sa source unique, écrite ci-dessous. */
export type PartnerField =
  | 'domain'
  | 'postcode'
  | 'city'
  | 'propertyKind'
  | 'surfaceM2'
  | 'rooms'
  | 'priceEur'
  | 'clientFirstName'
  | 'clientLastName'
  | 'projectKind'
  | 'budgetMinEur'
  | 'budgetMaxEur'
  | 'deadline'
  | 'saleAmountEur'
  | 'saleOpenedOn';

const PROPERTY: readonly PartnerField[] = ['postcode', 'city', 'propertyKind', 'surfaceM2', 'rooms'];

/**
 * Le dossier utile de chaque métier, champ par champ. Règle écrite : un champ absent de la liste n'est jamais rendu.
 * Le nom du client n'est donné qu'aux métiers qui ne peuvent pas travailler sans lui (acte, prêt, gestion, conseil) ;
 * les autres passent par l'agent [R77].
 */
export const PARTNER_FIELDS: Readonly<Record<PartnerTrade, readonly PartnerField[]>> = Object.freeze({
  diagnostiqueur: ['domain', ...PROPERTY],
  notaire: [...PROPERTY, 'priceEur', 'clientFirstName', 'clientLastName', 'saleAmountEur', 'saleOpenedOn'],
  courtier: ['clientFirstName', 'clientLastName', 'projectKind', 'budgetMinEur', 'budgetMaxEur', 'deadline', 'postcode'],
  artisan: PROPERTY,
  demenageur: ['postcode', 'city', 'propertyKind', 'surfaceM2', 'rooms', 'deadline'],
  photographe: PROPERTY,
  geometre: PROPERTY,
  gestionnaire: [...PROPERTY, 'clientFirstName', 'clientLastName'],
  avocat: ['clientFirstName', 'clientLastName', 'projectKind', 'postcode', 'city', 'propertyKind'],
  expert_comptable: ['clientFirstName', 'clientLastName', 'projectKind'],
  promoteur: ['postcode', 'city', 'propertyKind', 'surfaceM2'],
  expert_viager: [...PROPERTY, 'priceEur'],
});

export type PartnerFile = Partial<Record<PartnerField, string | number | null>>;

export interface PartnerReferral {
  referralId: string;
  trade: PartnerTrade;
  state: ReferralState;
  /** Le dossier utile, seulement les champs de `PARTNER_FIELDS` pour ce métier. */
  file: PartnerFile;
}

export type SpaceRefusal = { ok: false; rule: 'R16' | 'R73' | 'R77' | null; code: string };
export type SpaceResult<T> = { ok: true; value: T } | SpaceRefusal;

interface Source {
  id: string;
  network_id: string;
  project_id: string;
  property_id: string | null;
  trade: PartnerTrade;
  domain: string;
  postcode: string;
}

export interface EspacePartenaireOptions {
  now?: () => Date;
}

export class EspacePartenaire {
  private readonly now: () => Date;

  constructor(
    private readonly db: SqlDatabase,
    private readonly annuaire: Annuaire,
    private readonly relations: MiseEnRelation,
    private readonly journal: JournalStore,
    options: EspacePartenaireOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  private actor(viewer: Viewer): string {
    return `${String(viewer.role)}:${viewer.userId}`;
  }

  private async refuse(viewer: Viewer, subject: string, code: string, rule: 'R16' | 'R73' = 'R16'): Promise<SpaceRefusal> {
    await appendEvent(this.journal, { type: 'acces.refuse', actor: this.actor(viewer), subject, data: { rule, role: String(viewer.role), kind: 'partner_space', code } }, this.now);
    return { ok: false, rule, code };
  }

  /** Seul un partenaire connu du réseau, aux justificatifs valides ce jour-là, entre dans son espace [R16, R73]. */
  private async gate(viewer: Viewer, subject: string, credentialsToday = true): Promise<SpaceRefusal | null> {
    if (viewer.role !== 'partner') return this.refuse(viewer, subject, 'role');
    const p = await this.db.first('SELECT 1 FROM partners WHERE id = ? AND network_id = ?', [viewer.userId, viewer.networkId]);
    if (!p) return this.refuse(viewer, subject, 'unknown');
    if (credentialsToday && !(await this.annuaire.proposableOn(viewer.networkId, viewer.userId, this.now()))) return this.refuse(viewer, subject, 'credentials', 'R73');
    return null;
  }

  /**
   * La mise en relation est-elle confiée à ce partenaire, et encore lisible aujourd'hui ? Pour un domaine de diagnostic,
   * la certification de ce domaine doit aussi être valide ce jour-là : sinon `credentials` [R77, R73].
   */
  private async held(viewer: Viewer, referralId: string, credentialsToday = true): Promise<ReferralState | 'credentials' | null> {
    const held = await this.relations.entrusted(viewer.networkId, referralId);
    if (!held || held.partnerId !== viewer.userId) return null;
    if (held.state === 'terminee' || held.state === 'abandonnee') {
      const closed = await this.relations.closedAt(referralId);
      if (!closed || this.now().getTime() - Date.parse(closed) > CLOSED_ACCESS_DAYS * 86_400_000) return null;
    }
    const r = (await this.db.first<{ domain: string }>('SELECT domain FROM partner_referrals WHERE id = ?', [referralId]))!;
    if (credentialsToday && r.domain !== '' && !(await this.annuaire.proposableOn(viewer.networkId, viewer.userId, this.now(), r.domain as DiagnosticDomain))) return 'credentials';
    return held.state;
  }

  /** Les mises en relation confiées à ce partenaire et encore lisibles, sans leur dossier [R77]. */
  async list(viewer: Viewer): Promise<SpaceResult<{ referralId: string; trade: PartnerTrade; state: ReferralState }[]>> {
    const denied = await this.gate(viewer, `partner:${viewer.userId}`);
    if (denied) return denied;
    const rows = await this.db.all<{ referral_id: string; trade: PartnerTrade }>(
      `SELECT DISTINCT s.referral_id, r.trade FROM partner_referral_steps s JOIN partner_referrals r ON r.id = s.referral_id
       WHERE r.network_id = ? AND s.state = 'accord_client' AND s.partner_id = ? ORDER BY r.created_at, s.referral_id`,
      [viewer.networkId, viewer.userId],
    );
    const out: { referralId: string; trade: PartnerTrade; state: ReferralState }[] = [];
    for (const r of rows) {
      const state = await this.held(viewer, r.referral_id);
      if (state && state !== 'credentials') out.push({ referralId: r.referral_id, trade: r.trade, state });
    }
    await appendEvent(this.journal, { type: 'espace_partenaire.liste', actor: this.actor(viewer), subject: `partner:${viewer.userId}`, data: { rule: 'R77', count: out.length } }, this.now);
    return { ok: true, value: out };
  }

  /** Le dossier utile d'une mise en relation confiée, champ par champ, écrit au journal avant d'être rendu [R77, R13]. */
  async read(viewer: Viewer, referralId: unknown): Promise<SpaceResult<PartnerReferral>> {
    const subject = `referral:${String(referralId)}`;
    const denied = await this.gate(viewer, subject);
    if (denied) return denied;
    if (typeof referralId !== 'string') return this.refuse(viewer, subject, 'not_assigned');
    const state = await this.held(viewer, referralId);
    if (!state) return this.refuse(viewer, subject, 'not_assigned');
    if (state === 'credentials') return this.refuse(viewer, subject, 'credentials', 'R73');
    const src = (await this.db.first<Source>('SELECT id, network_id, project_id, property_id, trade, domain, postcode FROM partner_referrals WHERE id = ?', [referralId]))!;
    const file = await this.file(src);
    await appendEvent(this.journal, { type: 'espace_partenaire.lu', actor: this.actor(viewer), subject, data: { rule: 'R77', fields: Object.keys(file).sort() } }, this.now);
    return { ok: true, value: { referralId, trade: src.trade, state, file } };
  }

  /**
   * Le partenaire peut-il agir sur cette mise en relation (déposer une pièce, U05) ? Seulement si elle lui est confiée et
   * encore ouverte ; tout refus est écrit au journal [R77, R73, R16]. Par défaut, ses justificatifs doivent être valides
   * aujourd'hui. Pour déposer une pièce déjà faite, `credentialsToday: false` : la pièce est alors jugée sur les
   * justificatifs du jour où elle a été faite (U06), ce qui distingue une pièce passée d'un nouveau travail [R73].
   */
  async access(viewer: Viewer, referralId: unknown, options: { credentialsToday?: boolean } = {}): Promise<SpaceResult<ReferralState>> {
    const subject = `referral:${String(referralId)}`;
    const today = options.credentialsToday ?? true;
    const denied = await this.gate(viewer, subject, today);
    if (denied) return denied;
    const held = typeof referralId === 'string' ? await this.held(viewer, referralId, today) : null;
    if (!held) return this.refuse(viewer, subject, 'not_assigned');
    if (held === 'credentials') return this.refuse(viewer, subject, 'credentials', 'R73');
    if (held !== 'confiee' && held !== 'en_cours') return this.refuse(viewer, subject, 'closed');
    return { ok: true, value: held };
  }

  /** Le partenaire dit où il en est [R77]. */
  async progress(viewer: Viewer, referralId: unknown, state: unknown): Promise<SpaceResult<ReferralState>> {
    const subject = `referral:${String(referralId)}`;
    const denied = await this.gate(viewer, subject);
    if (denied) return denied;
    if (state !== 'en_cours' && state !== 'terminee') return { ok: false, rule: null, code: 'bad_state' };
    const held = typeof referralId === 'string' ? await this.held(viewer, referralId) : null;
    if (!held) return this.refuse(viewer, subject, 'not_assigned');
    if (held === 'credentials') return this.refuse(viewer, subject, 'credentials', 'R73');
    const r = await this.relations.advanceByPartner(viewer.networkId, referralId as string, viewer.userId, state, this.actor(viewer));
    if (!r.ok) return { ok: false, rule: r.rule === 'R16' ? 'R16' : null, code: r.code };
    return { ok: true, value: r.value };
  }

  /** Construit le dossier utile : chaque champ lu de sa source, seulement s'il est dans la liste du métier. */
  private async file(src: Source): Promise<PartnerFile> {
    const fields = PARTNER_FIELDS[src.trade];
    const want = (f: PartnerField): boolean => fields.includes(f);
    const out: PartnerFile = {};
    const property = src.property_id
      ? await this.db.first<{ postal_code: string | null; city: string | null; kind: string; surface_m2: number | null; rooms: number | null; price_eur: number | null }>(
          'SELECT postal_code, city, kind, surface_m2, rooms, price_eur FROM properties WHERE id = ? AND network_id = ?',
          [src.property_id, src.network_id],
        )
      : null;
    const project = (await this.db.first<{ person_id: string; kind: string; budget_min_eur: number | null; budget_max_eur: number | null; deadline: string | null }>(
      'SELECT person_id, kind, budget_min_eur, budget_max_eur, deadline FROM projects WHERE id = ? AND network_id = ?',
      [src.project_id, src.network_id],
    ))!;
    if (want('domain')) out.domain = src.domain === '' ? null : (src.domain as DiagnosticDomain);
    if (want('postcode')) out.postcode = property?.postal_code ?? src.postcode;
    if (want('city')) out.city = property?.city ?? null;
    if (want('propertyKind')) out.propertyKind = property?.kind ?? null;
    if (want('surfaceM2')) out.surfaceM2 = property?.surface_m2 ?? null;
    if (want('rooms')) out.rooms = property?.rooms ?? null;
    if (want('priceEur')) out.priceEur = property?.price_eur ?? null;
    if (want('clientFirstName') || want('clientLastName')) {
      const person = await this.db.first<{ first_name: string | null; last_name: string | null }>('SELECT first_name, last_name FROM persons WHERE id = ?', [project.person_id]);
      if (want('clientFirstName')) out.clientFirstName = person?.first_name ?? null;
      if (want('clientLastName')) out.clientLastName = person?.last_name ?? null;
    }
    if (want('projectKind')) out.projectKind = project.kind;
    if (want('budgetMinEur')) out.budgetMinEur = project.budget_min_eur;
    if (want('budgetMaxEur')) out.budgetMaxEur = project.budget_max_eur;
    if (want('deadline')) out.deadline = project.deadline;
    if (want('saleAmountEur') || want('saleOpenedOn')) {
      // Le dossier de vente n'est montré que si le client du projet y est partie : propriétaire du bien ou acquéreur du
      // dossier. Jamais le dossier d'un autre client [R77].
      const found = src.property_id
        ? await this.db.first<{ amount_eur: number; opened_at: string; buyer_person_id: string }>(
            'SELECT amount_eur, opened_at, buyer_person_id FROM sale_files WHERE property_id = ? AND network_id = ?',
            [src.property_id, src.network_id],
          )
        : null;
      const owner = found ? await this.db.first("SELECT 1 FROM project_properties WHERE project_id = ? AND property_id = ? AND role = 'owned'", [src.project_id, src.property_id]) : null;
      const sale = found && (owner || found.buyer_person_id === project.person_id) ? found : null;
      if (want('saleAmountEur')) out.saleAmountEur = sale?.amount_eur ?? null;
      if (want('saleOpenedOn')) out.saleOpenedOn = sale ? sale.opened_at.slice(0, 10) : null;
    }
    return out;
  }
}
