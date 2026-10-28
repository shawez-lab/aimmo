/**
 * Rémunérations des partenaires, déclarées ou refusées (M18, U03) [R76].
 *
 * Toute rémunération venant d'un partenaire, au réseau ou à l'agent, se déclare dans la mise en relation, pour un
 * partenaire montré au client, avant son accord : sorte, montant ou taux, qui paie, qui reçoit. Sont toujours refusées :
 * toute rémunération venant d'un diagnostiqueur, sous toute forme ; toute rémunération d'un courtier ou d'une banque tant
 * que le statut requis n'est pas validé par l'avocat (réglage `brokerStatusValidated`, faux par défaut, H31). Après
 * l'accord du client, plus rien ne s'ajoute : il faut une nouvelle mise en relation, donc un nouvel accord.
 *
 * `disclose` rend le texte montré au client, qui cite chaque rémunération déclarée, partenaire par partenaire, ou dit
 * qu'il n'y en a aucune ; il passe le contrôle des textes (aucune mention de l'IA, chiffres venus des données) et son
 * empreinte est rangée : l'accord du client n'est accepté qu'après que ce texte lui a été montré (U02) [R76, R06].
 *
 * Rien ne change ni ne s'efface [R17] ; chaque déclaration et chaque refus au journal, sans nom [R13].
 */
import type { Viewer } from '../acces/droits.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { checkText } from '../envoi/texte.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import type { MiseEnRelation, Referral, ReferralRefusal } from './mise-en-relation.ts';

export const FEE_KINDS = [
  { kind: 'commission', label: 'une commission' },
  { kind: 'remise', label: 'une remise' },
  { kind: 'cadeau', label: 'un cadeau' },
  { kind: 'prestation', label: 'une prestation offerte' },
  { kind: 'autre', label: 'un avantage' },
] as const;
export type FeeKind = (typeof FEE_KINDS)[number]['kind'];
export type FeePayer = 'partenaire' | 'banque';
export type FeePayee = 'reseau' | 'agent';

export interface FeeSettings {
  /** Le statut requis pour être rémunéré par un courtier ou une banque est validé par l'avocat (H31). */
  brokerStatusValidated: boolean;
}
export const DEFAULT_FEE_SETTINGS: FeeSettings = Object.freeze({ brokerStatusValidated: false });

export interface DeclaredFee {
  feeId: string;
  partnerId: string;
  kind: FeeKind;
  amountCents: number | null;
  rateBp: number | null;
  payer: FeePayer;
  payee: FeePayee;
  declaredAt: string;
}

export interface Disclosure {
  text: string;
  fees: DeclaredFee[];
  textSha256: string;
}

export type FeeRefusal = { ok: false; rule: 'R16' | 'R73' | 'R74' | 'R75' | 'R76' | 'R06' | null; code: string };
export type FeeResult<T> = { ok: true; value: T } | FeeRefusal;

const euros = (cents: number): string => `${Math.floor(cents / 100).toLocaleString('fr-FR').replace(/ | /g, ' ')},${String(cents % 100).padStart(2, '0')} €`;
const percent = (bp: number): string => `${(bp / 100).toLocaleString('fr-FR', { maximumFractionDigits: 2 })} %`;
const hex = (buf: ArrayBuffer): string => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

export interface RemunerationsOptions {
  now?: () => Date;
  newId?: () => string;
  settings?: FeeSettings;
}

interface FeeRow {
  id: string;
  partner_id: string;
  kind: FeeKind;
  amount_cents: number | null;
  rate_bp: number | null;
  payer: FeePayer;
  payee: FeePayee;
  declared_at: string;
}

export class Remunerations {
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly settings: FeeSettings;

  constructor(
    private readonly db: SqlDatabase,
    private readonly relations: MiseEnRelation,
    private readonly journal: JournalStore,
    options: RemunerationsOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => crypto.randomUUID());
    this.settings = options.settings ?? DEFAULT_FEE_SETTINGS;
  }

  private actor(viewer: Viewer): string {
    return `${String(viewer.role)}:${viewer.userId}`;
  }

  private async refused(viewer: Viewer, referralId: string, code: string): Promise<FeeRefusal> {
    await appendEvent(this.journal, { type: 'remuneration.refusee', actor: this.actor(viewer), subject: `referral:${referralId}`, data: { rule: 'R76', code } }, this.now);
    return { ok: false, rule: 'R76', code };
  }

  /** La mise en relation, lue avec les droits de l'agent du projet ou de la direction [R16]. */
  private async referral(viewer: Viewer, referralId: unknown): Promise<Referral | ReferralRefusal> {
    const r = await this.relations.get(viewer, referralId);
    return r.ok ? r.value : r;
  }

  /** Déclare une rémunération venant d'un partenaire montré, avant l'accord du client [R76]. */
  async declare(
    viewer: Viewer,
    referralId: unknown,
    input: { partnerId: unknown; kind: unknown; amountCents?: unknown; rateBp?: unknown; payer: unknown; payee: unknown },
  ): Promise<FeeResult<DeclaredFee[]>> {
    const r = await this.referral(viewer, referralId);
    if ('ok' in r) return r;
    const shown = r.shown.find((p) => p.partnerId === input.partnerId);
    if (!shown) return { ok: false, rule: 'R75', code: 'not_shown' };
    if (typeof input.kind !== 'string' || !FEE_KINDS.some((k) => k.kind === input.kind)) return { ok: false, rule: null, code: 'bad_kind' };
    if (input.payer !== 'partenaire' && input.payer !== 'banque') return { ok: false, rule: null, code: 'bad_payer' };
    if (input.payee !== 'reseau' && input.payee !== 'agent') return { ok: false, rule: null, code: 'bad_payee' };
    const amount = input.amountCents === undefined || input.amountCents === null ? null : input.amountCents;
    const rate = input.rateBp === undefined || input.rateBp === null ? null : input.rateBp;
    const okAmount = amount === null || (typeof amount === 'number' && Number.isSafeInteger(amount) && amount > 0);
    const okRate = rate === null || (typeof rate === 'number' && Number.isInteger(rate) && rate >= 1 && rate <= 10_000);
    if (!okAmount || !okRate || (amount === null) === (rate === null)) return { ok: false, rule: null, code: 'bad_amount' };
    // Les refus de R76 passent avant l'état : ils valent à tout moment, et sont écrits au journal.
    if (shown.trade === 'diagnostiqueur') return this.refused(viewer, r.referralId, 'diagnostician_fee');
    if ((shown.trade === 'courtier' || input.payer === 'banque') && !this.settings.brokerStatusValidated) return this.refused(viewer, r.referralId, 'broker_status');
    if (r.state !== 'proposee') return this.refused(viewer, r.referralId, 'new_consent_required');
    const id = this.newId();
    try {
      await this.db.run(
        'INSERT INTO partner_referral_fees (id, referral_id, partner_id, kind, amount_cents, rate_bp, payer, payee, declared_by, declared_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [id, r.referralId, shown.partnerId, input.kind, amount as number | null, rate as number | null, input.payer, input.payee, this.actor(viewer), this.now().toISOString()],
      );
    } catch (error) {
      // L'accord a été rangé entre-temps : la base refuse, il faut un nouvel accord [R76].
      if (/accord du client déjà rangé/.test(String(error))) return this.refused(viewer, r.referralId, 'new_consent_required');
      throw error;
    }
    await appendEvent(
      this.journal,
      { type: 'remuneration.declaree', actor: this.actor(viewer), subject: `referral:${r.referralId}`, data: { rule: 'R76', partner: `partner:${shown.partnerId}`, kind: input.kind, payer: input.payer, payee: input.payee } },
      this.now,
    );
    return { ok: true, value: await this.list(r.referralId) };
  }

  private async list(referralId: string): Promise<DeclaredFee[]> {
    const rows = await this.db.all<FeeRow>('SELECT id, partner_id, kind, amount_cents, rate_bp, payer, payee, declared_at FROM partner_referral_fees WHERE referral_id = ? ORDER BY declared_at, id', [referralId]);
    return rows.map((f) => ({
      feeId: f.id,
      partnerId: f.partner_id,
      kind: f.kind,
      amountCents: f.amount_cents === null ? null : Number(f.amount_cents),
      rateBp: f.rate_bp === null ? null : Number(f.rate_bp),
      payer: f.payer,
      payee: f.payee,
      declaredAt: f.declared_at,
    }));
  }

  /**
   * Le texte des rémunérations à montrer au client avant son accord : partenaire par partenaire, dans l'ordre du tirage.
   * Il est contrôlé, puis son empreinte est rangée comme preuve qu'il a été montré [R76, R06].
   */
  async disclose(viewer: Viewer, referralId: unknown): Promise<FeeResult<Disclosure>> {
    const r = await this.referral(viewer, referralId);
    if ('ok' in r) return r;
    if (r.state !== 'proposee') return { ok: false, rule: 'R74', code: 'bad_state' };
    const fees = await this.list(r.referralId);
    const figures: string[] = [];
    const lines: string[] = [];
    if (fees.length === 0) lines.push('Aucun des professionnels proposés ne rémunère le réseau ni votre agent.');
    for (const p of r.shown) {
      const mine = fees.filter((f) => f.partnerId === p.partnerId);
      figures.push(p.businessName);
      if (fees.length === 0) continue;
      if (mine.length === 0) {
        lines.push(`${p.businessName} : aucune rémunération, ni au réseau ni à votre agent.`);
        continue;
      }
      const parts = mine.map((f) => {
        const what = FEE_KINDS.find((k) => k.kind === f.kind)!.label;
        const value = f.amountCents !== null ? euros(f.amountCents) : `${percent(f.rateBp!)} du montant de sa prestation`;
        figures.push(value);
        const payer = f.payer === 'banque' ? 'sa banque verse' : 'il verse';
        return `${payer} ${f.payee === 'reseau' ? 'au réseau' : 'à votre agent'} ${what} de ${value}`;
      });
      lines.push(`${p.businessName} : si vous le choisissez, ${parts.join(' ; ')}.`);
    }
    lines.push('Vous choisissez librement, avec votre agent ; ce choix ne change rien au prix de nos services.');
    const text = lines.join('\n');
    const problems = checkText(text, { audience: 'client', channel: 'email', figures });
    if (problems.length > 0) {
      await appendEvent(this.journal, { type: 'remuneration.texte_refuse', actor: this.actor(viewer), subject: `referral:${r.referralId}`, data: { rules: problems.map((x) => x.rule) } }, this.now);
      return { ok: false, rule: problems[0]!.rule === 'R06' ? 'R06' : null, code: 'text_refused' };
    }
    const textSha256 = hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
    await this.db.run('INSERT INTO partner_referral_disclosures (id, referral_id, text_sha256, fees_count, shown_by, shown_at) VALUES (?, ?, ?, ?, ?, ?)', [
      this.newId(),
      r.referralId,
      textSha256,
      fees.length,
      this.actor(viewer),
      this.now().toISOString(),
    ]);
    await appendEvent(this.journal, { type: 'remuneration.montree', actor: this.actor(viewer), subject: `referral:${r.referralId}`, data: { rule: 'R76', fees: fees.length, sha256: textSha256 } }, this.now);
    return { ok: true, value: { text, fees, textSha256 } };
  }
}
