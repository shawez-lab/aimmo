/**
 * Relance un an après la vente, sans jamais relancer une personne opposée (M11, F04) [R01, R02, R03, R04, R05, R13,
 * R16, R26, R65].
 *
 * À l'acte, l'agent du dossier range le choix de chaque client sur les relances après la vente, avec sa preuve :
 * `oui` (aux dates clés), `un_an` (seulement à un an), `non`. Un an après l'acte, une relance écrite par le code, sans
 * IA, avec un lien de désinscription qui marche en un geste ; aux dates clés suivantes, seulement avec le `oui` donné.
 * Une opposition dite plus tard, par l'agent ou par le lien, arrête tout. Chaque relance passe par le contrôle central :
 * heures d'envoi, exclusions, arrêts, accord, anti-doublon ; en mode essai, elle est rangée dans la boîte d'essai.
 *
 * Décidé, lecture prudente :
 * - les dates clés sont les anniversaires de l'acte, de un à cinq ans ; un acte du 29 février a son anniversaire le
 *   28 février les années qui n'en ont pas ;
 * - sans choix rangé, aucune relance : « ne pas s'y être opposé » se prouve, comme un accord [R03, R65] ; un `oui` ou un
 *   `un_an` range l'accord `relances_apres_vente` sur le mail, avec la même preuve ; un `non` le retire, fiches réunies
 *   comprises, pour tous les dossiers de la personne ;
 * - un `oui` ou un `un_an` se range à l'acte, ou plus tard quand le client le donne réellement (AU086) : un accord
 *   explicite, daté et prouvé, qui n'ouvre que les dates clés à venir, jamais une date passée ; jamais après un `non` de
 *   la personne, pour quelque dossier que ce soit, fiches réunies comprises : une opposition est définitive et arrête
 *   tout ; un `non` se range à tout moment ;
 * - chaque date clé suit le choix rangé au plus tard ce jour-là : un accord donné après ne la rouvre pas ;
 * - sans lien de désinscription réglé, aucune relance ne part [R65] ;
 * - une relance refusée pour l'heure attend le passage suivant [R01], dans les 7 jours ; au-delà, elle est close, au
 *   journal ; toute autre règle la refuse pour de bon ;
 * - le texte ne propose rien, ne parle ni de vendre ni d'estimer : l'agent reste joignable, c'est tout.
 */
import type { Viewer } from '../acces/droits.ts';
import { trialChannels } from '../captation/essai.ts';
import { FicheClient } from '../db/fiche-client.ts';
import type { SqlDatabase } from '../db/sql.ts';
import type { ScheduledJob } from '../bascule/planificateur.ts';
import { ControleEnvois } from '../envoi/controle.ts';
import { localTime } from '../envoi/horaires.ts';
import { SqlSendJournal } from '../envoi/journal-envois.ts';
import { DecisionEnvoi } from '../envoi/service.ts';
import { FicheUnique } from '../fiche/fusion.ts';
import { ficheFirstName } from '../fiche/prenom.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import { nameWords } from '../visites/compte-rendu.ts';
import type { ClosedSale, DossiersClos } from './demandes-avis.ts';
import { viewerRefusal } from './lecteur.ts';

const TIME_ZONE = 'Europe/Paris';
export const AFTER_SALE_PURPOSE = 'relances_apres_vente';
/**
 * Jours sans relance après la vente qui suivent une relance d'ancien contact passée (G09, `old_contact_followups` en
 * `essai`) : la période réglée de G09, `DEFAULT_OLD_CONTACT_SETTINGS.periodDays`, une relance par période au plus,
 * toutes relances confondues [R143, R05]. Écrite ici pour ne pas lier M11 à M20 ; un test garde les deux égales.
 */
export const OLD_CONTACT_QUIET_DAYS = 182;
export const AFTER_SALE_CHOICES = ['oui', 'un_an', 'non'] as const;
export type AfterSaleChoice = (typeof AFTER_SALE_CHOICES)[number];
/** Les dates clés : de un à cinq ans après l'acte. */
export const KEY_YEARS = [1, 2, 3, 4, 5] as const;
/**
 * Un `oui` ou un `un_an` rangé dans ce nombre de jours après l'acte est une saisie en retard de l'accord donné à l'acte ;
 * au-delà, c'est un accord donné plus tard, qui n'ouvre que les dates clés à venir (AU086).
 */
export const CHOICE_GRACE_DAYS = 7;
/** Passé ce nombre de jours après la date clé, une relance qui n'a pas pu partir est close. */
export const AFTER_SALE_WINDOW_DAYS = 7;

const YEAR_WORDS: Record<number, string> = { 1: 'un an', 2: 'deux ans', 3: 'trois ans', 4: 'quatre ans', 5: 'cinq ans' };

/** Ce qui fait le carnet du propriétaire (F06) et rend un lien vers lui, ou `null`. */
export interface CarnetMaker {
  create(networkId: string, sale: ClosedSale, personId: string): Promise<string | null>;
}

export type AfterSaleRefusal = { ok: false; rule: 'R16' | 'R65' | null; code: string };

export interface AfterSaleReminder {
  fileId: string;
  personId: string;
  year: number;
  dueDay: string;
  status: 'sent' | 'waiting' | 'refused' | 'failed' | 'closed';
  rule: string | null;
  updatedAt: string;
}

const addDays = (day: string, n: number): string => new Date(Date.parse(`${day}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

const isLeap = (y: number): boolean => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

/** L'anniversaire d'un jour, `years` ans plus tard ; le 29 février devient le 28 les années qui n'en ont pas. */
export function anniversary(day: string, years: number): string {
  const y = Number(day.slice(0, 4)) + years;
  const md = day.slice(5);
  return `${String(y).padStart(4, '0')}-${md === '02-29' && !isLeap(y) ? '02-28' : md}`;
}

/** Le même jour, `years` ans plus tôt ; un jour de marge de chaque côté couvre le 29 février. */
const yearsBefore = (day: string, years: number): string => anniversary(day, -years);

const LETTERS = 'abcdefghijklmnopqrstuvwxyz';
/**
 * La première lettre du jeton, qui suit « / » dans le texte : jamais a, c, g, i ni r, pour qu'aucun jeton ne commence
 * comme un mot que le contrôle du texte lit comme une mention de l'IA, « gpt », « robot », « assistant »… [R06].
 */
const FIRST_LETTERS = 'bdefhjklmnopqstuvwxyz';
/** Un jeton de lettres seules : aucun chiffre dans le texte qui ne vienne de la base [R10]. */
export function newAfterSaleToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return [...bytes].map((b, i) => (i === 0 ? FIRST_LETTERS[b % FIRST_LETTERS.length] : LETTERS[b % 26])).join('');
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Le début du lien de désinscription : https, sans chiffre [R10], terminé par « / ». */
export function checkAfterSaleUnsubscribeBase(base: string | null): string | null {
  if (base !== null && !/^https:\/\/[^\s\d()]+\/$/.test(base)) throw new Error('Le lien de désinscription est en https, sans chiffre [R10], terminé par « / ».');
  return base;
}

/**
 * Le texte d'une relance, écrit par le code : vouvoiement avec le prénom, aucune parenthèse [R08], aucun chiffre hors
 * de la référence du bien [R10], aucune proposition ; le lien de désinscription à la fin [R65].
 */
export function afterSaleText(firstName: string | null, side: 'vendeur' | 'acquereur', year: number, property: { city: string | null; reference: string }, unsubscribeLink: string, carnetLink: string | null = null): string {
  const hello = firstName ? `Bonjour ${firstName},` : 'Bonjour,';
  const what = side === 'vendeur' ? 'vous avez vendu votre bien' : 'vous avez acheté votre bien';
  const where = `${property.city ? ` à ${property.city}` : ''}, référence ${property.reference}`;
  return `${hello} il y a ${YEAR_WORDS[year]}, ${what}${where}. Votre agent immobilier reste là pour toute question sur ce bien : il suffit de répondre à ce message.${carnetLink ? ` Le carnet de votre bien, un an après, sans rien à remplir : ${carnetLink}` : ''} Ne plus recevoir ces messages : ${unsubscribeLink}`;
}

export class RelancesApresVente {
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly store: FicheClient;
  private readonly unique: FicheUnique;
  private readonly controle: ControleEnvois;
  private readonly unsubscribeBase: string | null;
  private readonly carnets: CarnetMaker | null;
  private readonly oldContactQuietDays: number;

  constructor(
    private readonly db: SqlDatabase,
    private readonly journal: JournalStore,
    private readonly dossiers: DossiersClos,
    options: { now?: () => Date; newId?: () => string; unsubscribeBase?: string | null; carnets?: CarnetMaker | null; oldContactQuietDays?: number } = {},
  ) {
    this.oldContactQuietDays = options.oldContactQuietDays ?? OLD_CONTACT_QUIET_DAYS;
    this.carnets = options.carnets ?? null;
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => crypto.randomUUID());
    this.store = new FicheClient(db, { now: this.now });
    this.unique = new FicheUnique(db, this.store, { now: this.now });
    this.controle = new ControleEnvois(db, this.unique, new DecisionEnvoi(db, this.store, this.unique, { now: this.now }), {
      channels: trialChannels(db, journal, this.now),
      journal: new SqlSendJournal(db, undefined, this.now),
      now: this.now,
    });
    this.unsubscribeBase = checkAfterSaleUnsubscribeBase(options.unsubscribeBase ?? null);
  }

  private async refuse(viewer: Viewer, subject: string, kind: string, code: string): Promise<AfterSaleRefusal> {
    await appendEvent(this.journal, { type: 'acces.refuse', actor: `${String(viewer.role)}:${viewer.userId}`, subject, data: { rule: 'R16', role: String(viewer.role), kind, code } }, this.now);
    return { ok: false, rule: 'R16', code };
  }

  /** Retire l'accord des relances après la vente, sur tous les canaux, fiches réunies comprises ; rend le nombre retiré. */
  private async withdraw(personId: string, at: Date): Promise<number> {
    const ids = await this.unique.membersOf(personId);
    const consents = await this.db.all<{ id: string }>(`SELECT id FROM consents WHERE person_id IN (${ids.map(() => '?').join(', ')}) AND purpose = ? AND withdrawn_at IS NULL`, [...ids, AFTER_SALE_PURPOSE]);
    for (const c of consents) await this.store.withdrawConsent(c.id, at);
    return consents.length;
  }

  /**
   * Le choix d'un client du dossier sur les relances après la vente, avec sa preuve : seul l'agent du dossier le range
   * [R16]. Un choix dit plus tard s'ajoute et l'emporte ; un `non` arrête tout [R65].
   */
  async recordChoice(viewer: Viewer, fileId: string, personId: string, input: { choice: AfterSaleChoice; proof: string }): Promise<{ ok: true } | AfterSaleRefusal> {
    const subject = `sale_file:${fileId}`;
    const sale = await this.dossiers.byId(viewer.networkId, fileId);
    if (!sale) {
      await this.refuse(viewer, subject, 'after_sale_choice', 'unknown');
      return { ok: false, rule: null, code: 'unknown_file' };
    }
    const inactive = await viewerRefusal(this.db, viewer);
    if (inactive) return this.refuse(viewer, subject, 'after_sale_choice', inactive);
    if (viewer.role !== 'agent' || viewer.userId !== sale.agentId) return this.refuse(viewer, subject, 'after_sale_choice', 'role');
    if (!(AFTER_SALE_CHOICES as readonly string[]).includes(input.choice)) return { ok: false, rule: null, code: 'invalid_choice' };
    const proof = typeof input.proof === 'string' ? input.proof.trim() : '';
    if (proof.length < 3 || proof.length > 300) return { ok: false, rule: null, code: 'invalid_proof' };
    const root = await this.unique.rootOf(personId);
    const roots = await Promise.all(sale.clients.map((c) => this.unique.rootOf(c.personId)));
    if (!roots.includes(root)) return { ok: false, rule: null, code: 'not_client' };
    const at = this.now();
    if (input.choice !== 'non') {
      // L'accord se donne à l'acte ou plus tard, jamais avant l'acte, jamais après une opposition [R65, AU086].
      const today = localTime(at, TIME_ZONE).date;
      if (today < sale.closedOn) return { ok: false, rule: 'R65', code: 'not_at_signing' };
      const ids = await this.unique.membersOf(root);
      const opposed = await this.db.first(`SELECT 1 AS x FROM after_sale_choices WHERE choice = 'non' AND person_id IN (${ids.map(() => '?').join(', ')})`, ids);
      if (opposed) return { ok: false, rule: 'R65', code: 'opposed' };
    }
    await this.db.run('INSERT INTO after_sale_choices (id, network_id, file_id, person_id, choice, proof, recorded_by, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [
      this.newId(),
      viewer.networkId,
      fileId,
      root,
      input.choice,
      proof,
      `agent:${viewer.userId}`,
      at.toISOString(),
    ]);
    if (input.choice === 'non') {
      await this.withdraw(root, at);
    } else {
      const active = await this.unique.hasConsentInForce(root, AFTER_SALE_PURPOSE, 'email');
      if (!active) await this.store.addConsent({ networkId: viewer.networkId, personId: root, purpose: AFTER_SALE_PURPOSE, channel: 'email', proof, givenAt: at });
    }
    await appendEvent(this.journal, { type: 'apres_vente.choix_relances', actor: `agent:${viewer.userId}`, subject, data: { side: sale.clients[roots.indexOf(root)]!.side, client: `person:${root}`, choice: input.choice } }, this.now);
    return { ok: true };
  }

  /**
   * Le choix qui vaut pour ce dossier et cette personne, fiches réunies comprises : un `non` rangé sur l'une des fiches,
   * pour n'importe lequel de ses dossiers, l'emporte toujours, une opposition est définitive et arrête tout [R65] ;
   * sinon le dernier choix rangé pour ce dossier.
   */
  private async choiceOf(fileId: string, personId: string, dueDay?: string): Promise<AfterSaleChoice | null> {
    const ids = await this.unique.membersOf(personId);
    const opposed = await this.db.first(`SELECT 1 AS x FROM after_sale_choices WHERE choice = 'non' AND person_id IN (${ids.map(() => '?').join(', ')})`, ids);
    if (opposed) return 'non';
    const rows = await this.db.all<{ choice: AfterSaleChoice; recorded_at: string }>(
      `SELECT choice, recorded_at FROM after_sale_choices WHERE file_id = ? AND person_id IN (${ids.map(() => '?').join(', ')}) ORDER BY recorded_at DESC, rowid DESC`,
      [fileId, ...ids],
    );
    // AU086 · pour une date clé, le dernier choix rangé au plus tard ce jour-là : un accord tardif ne rouvre rien de passé.
    const row = dueDay === undefined ? rows[0] : rows.find((r) => localTime(new Date(r.recorded_at), TIME_ZONE).date <= dueDay);
    return row?.choice ?? null;
  }

  /**
   * Le lien de désinscription : retire l'accord des relances après la vente et range un `non` pour chaque dossier de
   * la personne, en un geste, sans rien demander [R65]. Rend vrai si le jeton est connu ; un jeton servi de nouveau ne
   * change rien.
   */
  async unsubscribe(token: string): Promise<boolean> {
    if (!/^[a-z]{32}$/.test(token)) return false;
    const row = await this.db.first<{ token_hash: string; person_id: string; network_id: string; used_at: string | null }>(
      'SELECT token_hash, person_id, network_id, used_at FROM after_sale_unsubscribe_tokens WHERE token_hash = ?',
      [await sha256(token)],
    );
    if (!row) return false;
    if (row.used_at) return true;
    const at = this.now();
    const withdrawn = await this.withdraw(row.person_id, at);
    const ids = await this.unique.membersOf(row.person_id);
    const files = await this.db.all<{ file_id: string }>(`SELECT DISTINCT file_id FROM after_sale_choices WHERE person_id IN (${ids.map(() => '?').join(', ')}) ORDER BY file_id`, ids);
    const root = await this.unique.rootOf(row.person_id);
    for (const f of files) {
      await this.db.run("INSERT INTO after_sale_choices (id, network_id, file_id, person_id, choice, proof, recorded_by, recorded_at) VALUES (?, ?, ?, ?, 'non', 'lien de désinscription', 'client:lien', ?)", [
        this.newId(),
        row.network_id,
        f.file_id,
        root,
        at.toISOString(),
      ]);
    }
    await this.db.run('UPDATE after_sale_unsubscribe_tokens SET used_at = ? WHERE token_hash = ? AND used_at IS NULL', [at.toISOString(), row.token_hash]);
    await appendEvent(this.journal, { type: 'apres_vente.desinscription', actor: 'client:lien', subject: `person:${root}`, data: { rule: 'R65', withdrawn, files: files.length } }, this.now);
    return true;
  }

  private async newUnsubscribeLink(networkId: string, personId: string, at: Date): Promise<string> {
    const token = newAfterSaleToken();
    await this.db.run('INSERT INTO after_sale_unsubscribe_tokens (token_hash, network_id, person_id, created_at, used_at) VALUES (?, ?, ?, ?, NULL)', [await sha256(token), networkId, personId, at.toISOString()]);
    return `${this.unsubscribeBase ?? ''}${token}`;
  }

  /** Une relance d'ancien contact décidée (passée par le contrôle, en essai) dans la période, sur l'une des fiches réunies. */
  private async oldContactFollowedUp(personId: string, at: Date): Promise<boolean> {
    const members = await this.unique.membersOf(await this.unique.rootOf(personId));
    const since = new Date(at.getTime() - this.oldContactQuietDays * 86_400_000).toISOString();
    const row = await this.db.first(
      `SELECT 1 FROM old_contact_followups WHERE person_id IN (${members.map(() => '?').join(', ')}) AND status = 'essai' AND decided_at > ? AND decided_at <= ? LIMIT 1`,
      [...members, since, at.toISOString()],
    );
    return row !== null;
  }

  private async firstName(personId: string): Promise<string | null> {
    return ficheFirstName(this.db, await this.unique.membersOf(personId));
  }

  /** Les mots des noms des clients de l'autre côté, interdits dans le message, sauf ceux du prénom salué [R19]. */
  private async forbiddenNames(others: readonly string[], recipientFirstName: string | null): Promise<string[]> {
    const members = [...new Set((await Promise.all(others.map((o) => this.unique.membersOf(o)))).flat())];
    if (members.length === 0) return [];
    const rows = await this.db.all<{ first_name: string | null; last_name: string | null }>(`SELECT first_name, last_name FROM person_known_names WHERE id IN (${members.map(() => '?').join(', ')})`, members);
    const greeting = new Set(recipientFirstName ? nameWords(recipientFirstName) : []);
    const words = new Set(rows.flatMap((r) => [r.first_name, r.last_name]).filter((n): n is string => !!n).flatMap(nameWords));
    return [...words].filter((w) => !greeting.has(w));
  }

  /**
   * Le côté du client dans le dossier (vendeur ou acquéreur), fiches réunies comprises : il range l'événement du journal
   * à la seule partie qu'il concerne (réponse d'accès, L07) ; `null` si la personne n'est plus partie au dossier.
   */
  private async sideOf(sale: ClosedSale, personId: string): Promise<'vendeur' | 'acquereur' | null> {
    const root = await this.unique.rootOf(personId);
    for (const c of sale.clients) if ((await this.unique.rootOf(c.personId)) === root) return c.side;
    return null;
  }

  /** Range l'issue d'une relance et l'écrit au journal, sans texte ni coordonnée [R13]. */
  private async settle(sale: ClosedSale, personId: string, year: number, status: AfterSaleReminder['status'], rule: string | null, messageId: string | null): Promise<void> {
    await this.db.run(
      "UPDATE after_sale_reminders SET status = ?, rule = ?, message_id = COALESCE(?, message_id), updated_at = ? WHERE file_id = ? AND person_id = ? AND year = ? AND status IN ('waiting', 'failed')",
      [status, rule, messageId, this.now().toISOString(), sale.fileId, personId, year],
    );
    await appendEvent(this.journal, { type: 'apres_vente.relance', actor: 'system:apres-vente', subject: `sale_file:${sale.fileId}`, data: { mode: 'essai', side: await this.sideOf(sale, personId), client: `person:${personId}`, year, status, rule } }, this.now);
  }

  /**
   * Le passage : pour chaque date clé tombée dans les 7 derniers jours, une relance par client du dossier qui l'a
   * acceptée. Rend le nombre de relances rangées dans la boîte d'essai.
   */
  async run(networkId: string): Promise<number> {
    const now = this.now();
    const today = localTime(now, TIME_ZONE).date;
    const at = now.toISOString();
    if (this.unsubscribeBase === null) {
      // Sans lien de désinscription, aucune relance : le passage le dit au journal, sans donnée [R65].
      await appendEvent(this.journal, { type: 'apres_vente.relance_sans_lien', actor: 'system:apres-vente', subject: null, data: { rule: 'R65' } }, this.now);
      return 0;
    }
    const deadline = addDays(today, -AFTER_SALE_WINDOW_DAYS);
    // Une relance restée en attente au-delà du délai ne partira plus : elle est close, au journal.
    for (const r of await this.db.all<{ file_id: string; person_id: string; year: number }>(
      "SELECT file_id, person_id, year FROM after_sale_reminders WHERE network_id = ? AND status IN ('waiting', 'failed') AND due_day < ? ORDER BY file_id, person_id, year",
      [networkId, deadline],
    )) {
      const { changes } = await this.db.run("UPDATE after_sale_reminders SET status = 'closed', rule = 'delai_depasse', updated_at = ? WHERE file_id = ? AND person_id = ? AND year = ? AND status IN ('waiting', 'failed')", [at, r.file_id, r.person_id, r.year]);
      if (changes !== 1) continue;
      const sale = await this.dossiers.byId(networkId, r.file_id);
      const side = sale ? await this.sideOf(sale, r.person_id) : null;
      await appendEvent(this.journal, { type: 'apres_vente.relance', actor: 'system:apres-vente', subject: `sale_file:${r.file_id}`, data: { mode: 'essai', side, client: `person:${r.person_id}`, year: r.year, status: 'closed', rule: 'delai_depasse' } }, this.now);
    }
    let sent = 0;
    for (const year of KEY_YEARS) {
      // Les actes dont la date clé tombe entre le délai et aujourd'hui, avec un jour de marge pour le 29 février.
      const sales = [...(await this.dossiers.closedBetween(networkId, addDays(yearsBefore(deadline, year), -1), addDays(yearsBefore(today, year), 1)))].sort(
        (a, b) => a.closedOn.localeCompare(b.closedOn) || a.fileId.localeCompare(b.fileId),
      );
      for (const sale of sales) {
        const dueDay = anniversary(sale.closedOn, year);
        if (dueDay > today || dueDay < deadline) continue;
        const seen = new Set<string>();
        const clients: { personId: string; side: 'vendeur' | 'acquereur' }[] = [];
        for (const c of sale.clients) {
          const root = await this.unique.rootOf(c.personId);
          if (seen.has(root)) continue;
          seen.add(root);
          clients.push({ personId: root, side: c.side });
        }
        for (const c of clients) {
          const row = await this.db.first<{ status: string }>('SELECT status FROM after_sale_reminders WHERE file_id = ? AND person_id = ? AND year = ?', [sale.fileId, c.personId, year]);
          if (row && row.status !== 'waiting' && row.status !== 'failed') continue;
          if (!row) {
            await this.db.run(
              "INSERT INTO after_sale_reminders (file_id, person_id, year, network_id, agent_id, due_day, status, rule, message_id, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'waiting', NULL, NULL, ?) ON CONFLICT DO NOTHING",
              [sale.fileId, c.personId, year, networkId, sale.agentId, dueDay, at],
            );
          }
          // Le choix du client, relu à chaque passage : une opposition dite entre-temps l'emporte [R65].
          const choice = await this.choiceOf(sale.fileId, c.personId, dueDay);
          if (choice !== 'oui' && !(choice === 'un_an' && year === 1)) {
            await this.settle(sale, c.personId, year, 'refused', 'R65', null);
            continue;
          }
          // Une relance d'ancien contact passée dans la période réglée de G09 : pas de relance après la vente [R143, R05].
          if (await this.oldContactFollowedUp(c.personId, now)) {
            await this.settle(sale, c.personId, year, 'refused', 'R143', null);
            continue;
          }
          const firstName = await this.firstName(c.personId);
          const link = await this.newUnsubscribeLink(networkId, c.personId, now);
          // À un an, l'acquéreur reçoit le carnet de son bien avec sa relance (F06), jamais sans son accord [R65].
          let carnet: string | null = null;
          if (year === 1 && c.side === 'acquereur' && this.carnets) {
            try {
              carnet = await this.carnets.create(networkId, sale, c.personId);
            } catch {
              // Les ventes publiques ou la base ne répondent pas : la relance part sans carnet, l'erreur va au journal.
              await appendEvent(this.journal, { type: 'apres_vente.carnet', actor: 'system:apres-vente', subject: `sale_file:${sale.fileId}`, data: { status: 'erreur' } }, this.now);
            }
          }
          const result = await this.controle.send({
            networkId,
            agentId: sale.agentId,
            personId: c.personId,
            channel: 'email',
            kind: 'follow_up',
            purpose: AFTER_SALE_PURPOSE,
            subject: `apres_vente:${sale.fileId}:${year}`,
            fallbackTexts: [afterSaleText(firstName, c.side, year, sale, link, carnet)],
            // Les chiffres de la référence du bien, lus dans la base [R10].
            figures: (sale.reference.match(/\d+/g) ?? []).map(Number),
            // Le nom d'un client de l'autre côté n'apparaît jamais [R19].
            sellerNames: await this.forbiddenNames(clients.filter((o) => o.side !== c.side).map((o) => o.personId), firstName),
          });
          const status = result.status === 'sent' ? 'sent' : result.status === 'failed' ? 'failed' : result.rule === 'R01' ? 'waiting' : 'refused';
          await this.settle(sale, c.personId, year, status, result.status === 'sent' ? null : result.rule, result.messageId);
          if (status === 'sent') sent += 1;
        }
      }
    }
    return sent;
  }

  /** Les relances après la vente : un agent voit celles de ses dossiers, la direction et la conformité le réseau [R16]. */
  async list(viewer: Viewer): Promise<{ ok: true; value: AfterSaleReminder[] } | AfterSaleRefusal> {
    const refusal = (await viewerRefusal(this.db, viewer)) ?? (viewer.role !== 'agent' && viewer.role !== 'direction' && viewer.role !== 'compliance' ? 'role' : null);
    if (refusal) return this.refuse(viewer, `network:${viewer.networkId}`, 'after_sale_reminders', refusal);
    const own = viewer.role === 'agent';
    const rows = await this.db.all<{ file_id: string; person_id: string; year: number; due_day: string; status: AfterSaleReminder['status']; rule: string | null; updated_at: string }>(
      `SELECT file_id, person_id, year, due_day, status, rule, updated_at FROM after_sale_reminders WHERE network_id = ?${own ? ' AND agent_id = ?' : ''} ORDER BY due_day, file_id, person_id, year`,
      own ? [viewer.networkId, viewer.userId] : [viewer.networkId],
    );
    await appendEvent(this.journal, { type: 'apres_vente.lecture', actor: `${String(viewer.role)}:${viewer.userId}`, subject: `network:${viewer.networkId}`, data: { kind: 'after_sale_reminders', count: rows.length } }, this.now);
    return { ok: true, value: rows.map((r) => ({ fileId: r.file_id, personId: r.person_id, year: r.year, dueDay: r.due_day, status: r.status, rule: r.rule, updatedAt: r.updated_at })) };
  }
}

export const AFTER_SALE_REMINDER_JOB = 'apres_vente.relances';

/** Du lundi au samedi, d'heure en heure de 10 h à 18 h : les relances du jour, et celles qui attendaient [R01]. */
export function afterSaleReminderJob(db: SqlDatabase, journal: JournalStore, dossiers: DossiersClos, options: { now?: () => Date; unsubscribeBase?: string | null; carnets?: CarnetMaker | null } = {}): ScheduledJob {
  return {
    name: AFTER_SALE_REMINDER_JOB,
    hours: [10, 11, 12, 13, 14, 15, 16, 17, 18],
    weekdays: [1, 2, 3, 4, 5, 6],
    run: async () => {
      const r = new RelancesApresVente(db, journal, dossiers, options);
      for (const n of await db.all<{ id: string }>('SELECT id FROM networks')) await r.run(n.id);
    },
  };
}
