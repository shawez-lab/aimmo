/**
 * Prospection de nouveaux partenaires entre professionnels (M18, U08) [R79, R03, R04, R05, R06, R07, R11].
 *
 * La direction range des futurs partenaires trouvés dans une source publique : une adresse déclarée professionnelle,
 * jamais une adresse déclarée personnelle, un métier de la liste fermée, le nom de l'entreprise et la source [R79].
 * Chaque adresse n'est rangée qu'une fois par réseau, et ne reçoit jamais deux fois le premier mail [R05].
 *
 * Chaque jour ouvré, le passage prépare au plus `PROSPECT_MAILS_PER_WORKING_DAY` premiers mails (réglage), dans les
 * heures d'envoi : un texte écrit par le code, qui ne promet rien et ne parle pas de l'IA [R06, R07], terminé par son
 * lien d'opposition. Une opposition, par le lien ou rangée par la direction, arrête tout pour cette adresse, sur tous
 * les canaux et pour toujours [R04, R02] ; la base la vérifie encore au moment même de l'écriture.
 *
 * Chaque mail est soumis à la décision unique du contrôle central des envois (`decideSend`, type `prospecting`,
 * canal mail), avec l'opposition comme arrêt [R04]. Décidé, lecture prudente (2026-10-28, voie 2) : tel qu'écrit,
 * R03 exige un accord préalable pour tout premier mail, prospection entre professionnels comprise ; tant que H32
 * n'est pas tranché et que R03 n'a pas reçu son exception écrite, le réglage `professionalException` reste faux, le
 * contrôle refuse sous R03 et rien n'est préparé. Même permis, rien ne part d'ici : le mail est rangé dans la boîte
 * de M18, en mode essai ; son passage réel par le contrôle central revient au branchement (U09).
 *
 * Rien ne change ni ne s'efface [R17] ; chaque ajout, préparation, refus et opposition au journal, sans adresse [R13].
 */
import type { Viewer } from '../acces/droits.ts';
import { checkUnsubscribeBase, newAlertToken } from '../acquereurs/alertes.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { decideSend, DEFAULT_SEND_SETTINGS, type SendDecision } from '../envoi/decision.ts';
import { isWorkingDay, localTime } from '../envoi/horaires.ts';
import { checkText } from '../envoi/texte.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import { PARTNER_TRADES, type PartnerTrade } from './annuaire.ts';

const TIME_ZONE = 'Europe/Paris';

/** Premiers mails préparés au plus par jour ouvré, pour tout le réseau. Réglage [R79]. */
export const PROSPECT_MAILS_PER_WORKING_DAY = 5;
/** La finalité de la prospection, pour la décision du contrôle central [R03]. */
export const PROSPECTING_PURPOSE = 'prospection_partenaire';

/** Le métier, au pluriel, dans le texte du mail. */
const TRADE_PLURAL: Readonly<Record<PartnerTrade, string>> = Object.freeze({
  notaire: 'notaires',
  diagnostiqueur: 'diagnostiqueurs certifiés',
  courtier: 'courtiers en crédit',
  artisan: 'artisans',
  demenageur: 'déménageurs',
  photographe: 'photographes',
  geometre: 'géomètres-experts',
  gestionnaire: 'gestionnaires titulaires de la carte G',
  avocat: 'avocats',
  expert_comptable: 'experts-comptables',
  promoteur: 'promoteurs',
  expert_viager: 'experts du viager',
});

/** Mots d'une promesse, refusés dans le texte : rien n'est promis à un futur partenaire [R79]. */
export const PROMISE_WORDS = /garanti|assur[ée]s? de|chiffre d.affaires|revenu|commission|rémunér|€|%|clients? assurés?|exclusi/i;

const EMAIL = /^[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}$/;
const isTrade = (v: unknown): v is PartnerTrade => typeof v === 'string' && PARTNER_TRADES.some((t) => t.trade === v);

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Le texte du premier mail, écrit par le code, sans le lien : présentation, aucune promesse, aucune mention de l'IA. */
export function prospectText(networkName: string, trade: PartnerTrade): string {
  return `Bonjour, ${networkName} est un réseau d'agents immobiliers. Nous cherchons des ${TRADE_PLURAL[trade]} avec qui travailler, quand nos clients ont besoin de votre métier et l'acceptent. Si un échange vous intéresse, il vous suffit de répondre à ce mail. Sinon, vous n'aurez plus de message de notre part.`;
}

export interface Prospect {
  prospectId: string;
  trade: PartnerTrade;
  businessName: string;
  source: string;
  addedAt: string;
  /** Le premier mail préparé, son jour ; `null` s'il ne l'est pas encore. */
  mailedOn: string | null;
  opposed: boolean;
}

export interface PreparedMail {
  prospectId: string;
  day: string;
  text: string;
}

export type ProspectRefusal = { ok: false; rule: 'R16' | 'R79' | 'R05' | 'R04' | null; code: string };
export type ProspectResult<T> = { ok: true; value: T } | ProspectRefusal;

export interface ProspectionOptions {
  now?: () => Date;
  newId?: () => string;
  /** Le début du lien d'opposition, en https, sans chiffre, terminé par « / ». Absent : aucun mail préparé. */
  optOutBase?: string | null;
  /** Plafond par jour ouvré. */
  perWorkingDay?: number;
  /**
   * L'exception de R03 pour la prospection entre professionnels (information et opposition à chaque mail). Faux tant
   * que H32 n'est pas tranché et que la règle n'est pas écrite dans `docs/REGLES.md` : le contrôle refuse alors sous R03.
   */
  professionalException?: boolean;
}

export class Prospection {
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly optOutBase: string | null;
  private readonly perDay: number;
  private readonly exception: boolean;

  constructor(
    private readonly db: SqlDatabase,
    private readonly journal: JournalStore,
    options: ProspectionOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => crypto.randomUUID());
    this.optOutBase = checkUnsubscribeBase(options.optOutBase ?? null);
    this.perDay = options.perWorkingDay ?? PROSPECT_MAILS_PER_WORKING_DAY;
    if (!Number.isInteger(this.perDay) || this.perDay < 0 || this.perDay > PROSPECT_MAILS_PER_WORKING_DAY) throw new Error(`Plafond de prospection : de 0 à ${PROSPECT_MAILS_PER_WORKING_DAY} par jour ouvré [R79].`);
    this.exception = options.professionalException ?? false;
  }

  private actor(viewer: Viewer): string {
    return `${String(viewer.role)}:${viewer.userId}`;
  }

  /** Seule la direction prospecte ; tout autre est refusé et le refus écrit au journal [R16]. */
  private async gate(viewer: Viewer, subject: string): Promise<ProspectRefusal | null> {
    if (viewer.role === 'direction') return null;
    await appendEvent(this.journal, { type: 'acces.refuse', actor: this.actor(viewer), subject, data: { rule: 'R16', role: String(viewer.role), kind: 'partner_prospect' } }, this.now);
    return { ok: false, rule: 'R16', code: 'role' };
  }

  /** Range un futur partenaire : adresse professionnelle, métier, entreprise et source publique [R79, R05]. */
  async add(viewer: Viewer, input: { email: unknown; addressKind: unknown; trade: unknown; businessName: unknown; source: unknown }): Promise<ProspectResult<Prospect>> {
    const denied = await this.gate(viewer, 'partner_prospect:add');
    if (denied) return denied;
    if (input.addressKind !== 'professionnelle') return { ok: false, rule: 'R79', code: 'not_professional' };
    const email = typeof input.email === 'string' ? input.email.trim().toLowerCase() : '';
    if (!EMAIL.test(email) || email.length > 254) return { ok: false, rule: null, code: 'bad_email' };
    if (!isTrade(input.trade)) return { ok: false, rule: null, code: 'unknown_trade' };
    if (typeof input.businessName !== 'string' || input.businessName.trim().length < 2 || input.businessName.trim().length > 120) return { ok: false, rule: null, code: 'bad_name' };
    if (typeof input.source !== 'string' || input.source.trim().length < 3 || input.source.trim().length > 300) return { ok: false, rule: null, code: 'bad_source' };
    // Une adresse opposée ne revient jamais, même rangée de nouveau [R04].
    if (await this.db.first('SELECT 1 FROM partner_prospect_optouts WHERE network_id = ? AND email = ?', [viewer.networkId, email])) return { ok: false, rule: 'R04', code: 'opposed' };
    const id = this.newId();
    const at = this.now().toISOString();
    try {
      await this.db.run('INSERT INTO partner_prospects (id, network_id, email, address_kind, trade, business_name, source, added_by, added_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [
        id,
        viewer.networkId,
        email,
        'professionnelle',
        input.trade,
        input.businessName.trim(),
        input.source.trim(),
        this.actor(viewer),
        at,
      ]);
    } catch (error) {
      if (/UNIQUE/i.test(String(error))) return { ok: false, rule: 'R05', code: 'already_listed' };
      throw error;
    }
    await appendEvent(this.journal, { type: 'prospection.ajout', actor: this.actor(viewer), subject: `partner_prospect:${id}`, data: { trade: input.trade } }, this.now);
    return { ok: true, value: { prospectId: id, trade: input.trade, businessName: input.businessName.trim(), source: input.source.trim(), addedAt: at, mailedOn: null, opposed: false } };
  }

  /** La liste des futurs partenaires, pour la direction : où en est chacun [R16]. */
  async list(viewer: Viewer): Promise<ProspectResult<Prospect[]>> {
    const denied = await this.gate(viewer, 'partner_prospect:list');
    if (denied) return denied;
    const rows = await this.db.all<{ id: string; trade: PartnerTrade; business_name: string; source: string; added_at: string; day: string | null; opposed: number }>(
      `SELECT p.id, p.trade, p.business_name, p.source, p.added_at, m.day,
              EXISTS (SELECT 1 FROM partner_prospect_optouts o WHERE o.network_id = p.network_id AND o.email = p.email) AS opposed
       FROM partner_prospects p LEFT JOIN partner_prospect_mails m ON m.prospect_id = p.id
       WHERE p.network_id = ? ORDER BY p.added_at, p.id`,
      [viewer.networkId],
    );
    return { ok: true, value: rows.map((r) => ({ prospectId: r.id, trade: r.trade, businessName: r.business_name, source: r.source, addedAt: r.added_at, mailedOn: r.day, opposed: Number(r.opposed) === 1 })) };
  }

  /** La direction range une opposition reçue autrement que par le lien (réponse, appel) [R04]. */
  async oppose(viewer: Viewer, prospectId: unknown): Promise<ProspectResult<true>> {
    const denied = await this.gate(viewer, `partner_prospect:${String(prospectId)}`);
    if (denied) return denied;
    const p = typeof prospectId === 'string' ? await this.db.first<{ email: string }>('SELECT email FROM partner_prospects WHERE id = ? AND network_id = ?', [prospectId, viewer.networkId]) : null;
    if (!p) return { ok: false, rule: null, code: 'unknown' };
    await this.recordOptOut(viewer.networkId, p.email, 'agent', this.actor(viewer), `partner_prospect:${String(prospectId)}`);
    return { ok: true, value: true };
  }

  /** L'opposition par le lien du mail : sans compte, le jeton seul suffit ; rien n'est dit de l'adresse [R04]. */
  async optOut(token: unknown): Promise<boolean> {
    if (typeof token !== 'string' || !/^[a-z]{32}$/.test(token)) return false;
    const row = await this.db.first<{ network_id: string; email: string; prospect_id: string }>(
      'SELECT m.network_id, p.email, m.prospect_id FROM partner_prospect_mails m JOIN partner_prospects p ON p.id = m.prospect_id WHERE m.optout_token_sha256 = ?',
      [await sha256(token)],
    );
    if (!row) return false;
    await this.recordOptOut(row.network_id, row.email, 'lien', 'public:opposition', `partner_prospect:${row.prospect_id}`);
    return true;
  }

  private async recordOptOut(networkId: string, email: string, via: 'lien' | 'agent', actor: string, subject: string): Promise<void> {
    const r = await this.db.run('INSERT INTO partner_prospect_optouts (network_id, email, via, at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING', [networkId, email, via, this.now().toISOString()]);
    if (r.changes > 0) await appendEvent(this.journal, { type: 'prospection.opposition', actor, subject, data: { rule: 'R04', via } }, this.now);
  }

  /** La décision du contrôle central pour un premier mail, avec l'opposition comme arrêt [R03, R04, R01]. */
  private decide(addedAt: string, opposedAt: string | null): SendDecision {
    const at = this.now();
    return decideSend(
      { channel: 'email', kind: 'prospecting', purpose: PROSPECTING_PURPOSE, at },
      {
        exclusions: opposedAt ? [{ reason: 'stop', channel: null, noted_at: opposedAt, lifted_at: null }] : [],
        // L'exception entre professionnels, une fois écrite (H32) : l'information et l'opposition à chaque mail tiennent
        // lieu d'accord, de l'ajout de l'adresse jusqu'à son opposition. Faux par défaut : refus sous R03.
        consents: this.exception ? [{ purpose: PROSPECTING_PURPOSE, channel: 'email', given_at: addedAt, withdrawn_at: opposedAt }] : [],
        messages: [],
        relations: [],
        sentToday: { review_request: 0, partner: 0 },
      },
      DEFAULT_SEND_SETTINGS,
    );
  }

  /**
   * Le passage du jour : sur un jour ouvré, prépare au plus le plafond de premiers mails, aux adresses jamais écrites et
   * non opposées, dans l'ordre où elles ont été rangées. Rend le nombre de mails préparés. Rien ne part [R79].
   */
  async run(networkId: string): Promise<number> {
    const now = this.now();
    const local = localTime(now, TIME_ZONE);
    if (!isWorkingDay(local)) return 0;
    if (this.optOutBase === null) {
      // Sans lien d'opposition, aucun mail : la tâche le dit au journal [R79].
      await appendEvent(this.journal, { type: 'prospection.sans_opposition', actor: 'system:partenaires', subject: null, data: { rule: 'R79' } }, this.now);
      return 0;
    }
    const done = Number((await this.db.first<{ n: number }>('SELECT COUNT(*) AS n FROM partner_prospect_mails WHERE network_id = ? AND day = ?', [networkId, local.date]))?.n ?? 0);
    let left = this.perDay - done;
    if (left <= 0) return 0;
    const network = await this.db.first<{ name: string }>('SELECT name FROM networks WHERE id = ?', [networkId]);
    if (!network) return 0;
    const candidates = await this.db.all<{ id: string; trade: PartnerTrade; added_at: string }>(
      `SELECT p.id, p.trade, p.added_at FROM partner_prospects p
       WHERE p.network_id = ? AND NOT EXISTS (SELECT 1 FROM partner_prospect_mails m WHERE m.prospect_id = p.id)
         AND NOT EXISTS (SELECT 1 FROM partner_prospect_optouts o WHERE o.network_id = p.network_id AND o.email = p.email)
       ORDER BY p.added_at, p.id`,
      [networkId],
    );
    let prepared = 0;
    let refused: SendDecision | null = null;
    for (const c of candidates) {
      if (left <= 0) break;
      const decision = this.decide(c.added_at, null);
      if (!decision.allowed) {
        // Le même refus vaut pour toutes les adresses de ce passage (heures, accord) : un seul au journal.
        refused = decision;
        break;
      }
      const body = prospectText(network.name, c.trade);
      const problems = checkText(body, { audience: 'client', channel: 'email', figures: [] }).filter((p) => p.rule !== 'R08');
      if (problems.length > 0 || PROMISE_WORDS.test(body)) {
        await appendEvent(this.journal, { type: 'prospection.texte_refuse', actor: 'system:partenaires', subject: `partner_prospect:${c.id}`, data: { rules: problems.map((p) => p.rule) } }, this.now);
        continue;
      }
      const token = newAlertToken();
      const text = `${body}\n\nNe plus recevoir de message de notre part : ${this.optOutBase}${token}`;
      try {
        await this.db.run('INSERT INTO partner_prospect_mails (id, network_id, prospect_id, day, text, optout_token_sha256, prepared_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [
          this.newId(),
          networkId,
          c.id,
          local.date,
          text,
          await sha256(token),
          now.toISOString(),
        ]);
      } catch (error) {
        // Une opposition passée entre la lecture et l'écriture l'emporte ; un autre passage a pu écrire avant [R04, R05].
        if (/adresse opposée|UNIQUE/i.test(String(error))) continue;
        throw error;
      }
      left--;
      prepared++;
      await appendEvent(this.journal, { type: 'prospection.mail_prepare', actor: 'system:partenaires', subject: `partner_prospect:${c.id}`, data: { rule: 'R79', mode: 'essai', day: local.date } }, this.now);
    }
    if (refused) {
      await appendEvent(this.journal, { type: 'prospection.refusee', actor: 'system:partenaires', subject: null, data: { rule: refused.rule, reason: refused.reason, waiting: candidates.length } }, this.now);
    }
    return prepared;
  }

  /** Les mails préparés d'un jour, pour la direction ; ils attendent leur passage par le contrôle central (U09). */
  async mailsOf(viewer: Viewer, day: unknown): Promise<ProspectResult<PreparedMail[]>> {
    const denied = await this.gate(viewer, 'partner_prospect:mails');
    if (denied) return denied;
    if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return { ok: false, rule: null, code: 'bad_day' };
    const rows = await this.db.all<{ prospect_id: string; day: string; text: string }>('SELECT prospect_id, day, text FROM partner_prospect_mails WHERE network_id = ? AND day = ? ORDER BY prepared_at, id', [viewer.networkId, day]);
    return { ok: true, value: rows.map((r) => ({ prospectId: r.prospect_id, day: r.day, text: r.text })) };
  }
}
