/**
 * Demande d'avis le lendemain de l'acte, à tous, en mode essai (M11, F02) [R01, R02, R04, R05, R11, R13, R16, R26, R64].
 *
 * Le lendemain d'un dossier clos, à partir de 10 h, heure de Paris, une demande d'avis à chaque client du dossier,
 * vendeurs et acquéreurs, écrite par le code, sans IA, avec le lien de la fiche Google de l'agent (un réglage de
 * l'agent). Elle passe par le contrôle central, comme tout envoi : heures d'envoi, exclusions, arrêts, accord,
 * plafond des demandes d'avis, jamais à un proche, anti-doublon ; en mode essai, elle est rangée dans la boîte d'essai,
 * rien ne part [R26]. Une seule par client et par dossier.
 *
 * La demande ne dépend d'aucune note de satisfaction : rien ici n'en lit une, aucun client n'est trié [R64]. Le texte ne
 * promet rien et dit que l'avis est bienvenu, qu'il soit bon ou mauvais. AIMMO n'écrit jamais d'avis à la place d'un
 * client : il donne seulement le lien.
 *
 * Décidé, lecture prudente :
 * - le dossier clos est lu par une interface (`DossiersClos`) : M10 (N06) la branchera ; les tests en donnent un faux ;
 * - le canal est le mail, la finalité celle du suivi de la vente (`suivi_vente`), dont l'accord est exigé [R03] ;
 * - sans lien réglé, rien ne part, et l'agent reçoit une tâche « régler le lien de ma fiche Google » par dossier ; un
 *   lien réglé dans les 7 jours qui suivent l'acte laisse partir les demandes ; au-delà, elles sont closes, au journal,
 *   et l'agent reçoit une tâche « demande d'avis non partie » par dossier, pour la faire lui-même ;
 * - les dossiers les plus anciens passent d'abord, pour que le plafond du jour [R11] ne laisse personne derrière ;
 * - une demande refusée pour l'heure attend le passage suivant [R01, R11] ; refusée pour le plafond du jour, elle attend
 *   le lendemain [R11], et le délai ne la close jamais : elle part à son tour, même après 7 jours (AU087) ; toute autre règle, un proche de l'agent compris, la refuse pour de bon, avec sa raison ;
 * - deux fiches réunies d'un même client ne reçoivent qu'une demande par dossier.
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
import { SELLER_UPDATE_PURPOSE, nameWords } from '../visites/compte-rendu.ts';
import { viewerRefusal } from './lecteur.ts';
import { checkSatisfactionBase, newSatisfactionLink } from './satisfaction.ts';

const TIME_ZONE = 'Europe/Paris';
export const REVIEW_PURPOSE = SELLER_UPDATE_PURPOSE;
/** La demande part le lendemain de l'acte, à partir de cette heure, à Paris. */
export const REVIEW_HOUR = 10;
/** Passé ce nombre de jours après le lendemain de l'acte, une demande qui n'a pas pu partir est close. */
export const REVIEW_WINDOW_DAYS = 7;

/** Un client d'un dossier clos. */
export interface ClosedSaleClient {
  personId: string;
  side: 'vendeur' | 'acquereur';
}

/** Un dossier clos, tel que M10 le rapporte (N06). */
export interface ClosedSale {
  fileId: string;
  agentId: string;
  /** Jour de la signature de l'acte, `AAAA-MM-JJ` à Paris. */
  closedOn: string;
  city: string | null;
  /** Référence d'agence du bien, jamais son adresse [R19]. */
  reference: string;
  clients: readonly ClosedSaleClient[];
}

/** Les dossiers clos d'un réseau, rapportés par M10 (N06). */
export interface DossiersClos {
  /** Les dossiers signés entre deux jours inclus. */
  closedBetween(networkId: string, fromDay: string, toDay: string): Promise<readonly ClosedSale[]>;
  /** Un dossier clos du réseau, ou `null` s'il n'est pas clos ou pas de ce réseau. */
  byId(networkId: string, fileId: string): Promise<ClosedSale | null>;
}

export type AfterSaleTaskKind = 'lien_avis' | 'avis_non_parti';

export type ReviewStatus = 'sent' | 'waiting' | 'refused' | 'failed' | 'closed';

export interface ReviewRequest {
  fileId: string;
  personId: string;
  side: 'vendeur' | 'acquereur';
  dueDay: string;
  status: ReviewStatus;
  rule: string | null;
  updatedAt: string;
}

export type ReviewRefusal = { ok: false; rule: 'R16' | null; code: string };

const addDays = (day: string, n: number): string => new Date(Date.parse(`${day}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/**
 * Les adresses d'une fiche Google d'établissement, et elles seules : un hôte de Google et un chemin qui désigne une
 * fiche ou son formulaire d'avis. La page d'accueil ou une recherche de Google ne suffisent pas.
 */
const LISTING_PATHS: Record<string, (u: URL) => boolean> = {
  'g.page': (u) => /^\/(?:r\/)?[\w-]{3,}(?:\/review)?\/?$/.test(u.pathname),
  'maps.app.goo.gl': (u) => /^\/[\w-]{5,}\/?$/.test(u.pathname),
  'g.co': (u) => /^\/kgs\/[\w-]{3,}\/?$/.test(u.pathname),
  'search.google.com': (u) => /^\/local\/(?:writereview|reviews)\/?$/.test(u.pathname) && /^[\w-]{10,}$/.test(u.searchParams.get('placeid') ?? ''),
  'www.google.com': (u) => /^\/maps\/place\/[^/]+/.test(u.pathname),
  'google.com': (u) => /^\/maps\/place\/[^/]+/.test(u.pathname),
  'www.google.fr': (u) => /^\/maps\/place\/[^/]+/.test(u.pathname),
  'google.fr': (u) => /^\/maps\/place\/[^/]+/.test(u.pathname),
  'maps.google.com': (u) => /^\/maps\/place\/[^/]+/.test(u.pathname) || (u.pathname === '/' && /^\d{5,}$/.test(u.searchParams.get('cid') ?? '')),
};

/** Un lien de fiche Google acceptable : https, une fiche de Google, sans identifiants, sans espace, 300 caractères au plus. */
export function isReviewLink(url: string): boolean {
  if (url.length < 12 || url.length > 300 || /\s/.test(url) || /[()]/.test(url)) return false;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' || u.username || u.password || u.port) return false;
  const path = LISTING_PATHS[u.hostname.toLowerCase()];
  return path ? path(u) : false;
}

/**
 * Le texte d'une demande d'avis, écrit par le code : vouvoiement avec le prénom, aucune parenthèse [R08], aucun chiffre
 * hors de la référence du bien et du lien [R10], aucune promesse ni contrepartie, un avis bienvenu quel qu'il soit [R64].
 */
export function reviewText(firstName: string | null, side: 'vendeur' | 'acquereur', property: { city: string | null; reference: string }, url: string, satisfactionLink: string | null = null): string {
  const hello = firstName ? `Bonjour ${firstName},` : 'Bonjour,';
  const where = `${property.city ? ` à ${property.city}` : ''}, référence ${property.reference}`;
  const thanks = side === 'vendeur' ? `merci encore de nous avoir confié la vente de votre bien${where}.` : `merci encore de votre confiance pour l'achat de votre bien${where}.`;
  return `${hello} ${thanks} Si vous le voulez bien, vous pouvez donner votre avis sur votre agent immobilier, sur sa fiche Google, que l'expérience vous ait plu ou non : ${url} Votre avis, quel qu'il soit, aide d'autres personnes à choisir.${satisfactionLink ? ` Pour dire à votre agent immobilier seulement ce que vous en avez pensé, sans rien publier : ${satisfactionLink}` : ''} Merci !`;
}

export class DemandesAvis {
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly controle: ControleEnvois;
  private readonly unique: FicheUnique;
  private readonly satisfactionBase: string | null;

  constructor(
    private readonly db: SqlDatabase,
    private readonly journal: JournalStore,
    private readonly dossiers: DossiersClos,
    options: { now?: () => Date; newId?: () => string; satisfactionBase?: string | null } = {},
  ) {
    this.now = options.now ?? (() => new Date());
    // L'adresse du lien de satisfaction (F05) ; absente, la demande d'avis part sans lui.
    this.satisfactionBase = checkSatisfactionBase(options.satisfactionBase ?? null);
    this.newId = options.newId ?? (() => crypto.randomUUID());
    const fiches = new FicheClient(db, { now: this.now });
    this.unique = new FicheUnique(db, fiches, { now: this.now });
    this.controle = new ControleEnvois(db, this.unique, new DecisionEnvoi(db, fiches, this.unique, { now: this.now }), {
      channels: trialChannels(db, journal, this.now),
      journal: new SqlSendJournal(db, undefined, this.now),
      now: this.now,
    });
  }

  private async refuse(viewer: Viewer, subject: string, kind: string, code: string): Promise<ReviewRefusal> {
    await appendEvent(this.journal, { type: 'acces.refuse', actor: `${String(viewer.role)}:${viewer.userId}`, subject, data: { rule: 'R16', role: String(viewer.role), kind, code } }, this.now);
    return { ok: false, rule: 'R16', code };
  }

  /** Le lien de la fiche Google d'un agent : l'agent lui-même, ou la direction de son réseau [R16]. */
  async setReviewLink(viewer: Viewer, agentId: string, url: string): Promise<{ ok: true } | ReviewRefusal> {
    const subject = `agent:${agentId}`;
    const agent = await this.db.first<{ network_id: string; status: string }>('SELECT network_id, status FROM agents WHERE id = ?', [agentId]);
    if (!agent || agent.network_id !== viewer.networkId) {
      await this.refuse(viewer, subject, 'review_link', 'unknown');
      return { ok: false, rule: null, code: 'unknown_agent' };
    }
    const inactive = await viewerRefusal(this.db, viewer);
    if (inactive) return this.refuse(viewer, subject, 'review_link', inactive);
    const allowed = (viewer.role === 'agent' && viewer.userId === agentId) || viewer.role === 'direction';
    if (!allowed) return this.refuse(viewer, subject, 'review_link', 'role');
    if (agent.status !== 'active') return { ok: false, rule: null, code: 'agent_left' };
    const link = url.trim();
    if (!isReviewLink(link)) return { ok: false, rule: null, code: 'invalid_link' };
    const at = this.now().toISOString();
    await this.db.run('INSERT INTO agent_review_links (id, network_id, agent_id, url, set_by, set_at) VALUES (?, ?, ?, ?, ?, ?)', [this.newId(), viewer.networkId, agentId, link, `${String(viewer.role)}:${viewer.userId}`, at]);
    // Le lien réglé fait la tâche « régler le lien » de l'agent.
    await this.db.run("UPDATE after_sale_tasks SET done_at = ? WHERE agent_id = ? AND kind = 'lien_avis' AND done_at IS NULL", [at, agentId]);
    await appendEvent(this.journal, { type: 'apres_vente.lien_avis', actor: `${String(viewer.role)}:${viewer.userId}`, subject, data: {} }, this.now);
    return { ok: true };
  }

  private async linkOf(agentId: string): Promise<string | null> {
    return (await this.db.first<{ url: string }>('SELECT url FROM agent_review_links WHERE agent_id = ? ORDER BY set_at DESC, rowid DESC LIMIT 1', [agentId]))?.url ?? null;
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

  /** Une tâche « régler le lien de ma fiche Google » pour l'agent, une par dossier. */
  private async missingLink(networkId: string, sale: ClosedSale): Promise<void> {
    const { changes } = await this.db.run(
      "INSERT INTO after_sale_tasks (id, network_id, agent_id, file_id, kind, created_at, done_at) VALUES (?, ?, ?, ?, 'lien_avis', ?, NULL) ON CONFLICT DO NOTHING",
      [this.newId(), networkId, sale.agentId, sale.fileId, this.now().toISOString()],
    );
    if (changes === 1) await appendEvent(this.journal, { type: 'apres_vente.lien_avis_manquant', actor: 'system:apres-vente', subject: `sale_file:${sale.fileId}`, data: { agent: sale.agentId } }, this.now);
  }

  /**
   * Le passage : pour chaque dossier clos du réseau dont c'est le lendemain ou plus, dans le délai, une demande par
   * client. Rend le nombre de demandes rangées dans la boîte d'essai.
   */
  async run(networkId: string): Promise<number> {
    const now = this.now();
    const local = localTime(now, TIME_ZONE);
    const today = local.date;
    const at = now.toISOString();
    const deadline = addDays(today, -REVIEW_WINDOW_DAYS);
    // Les dossiers les plus anciens d'abord : le plafond du jour ne laisse jamais un client derrière les suivants [R11, R64].
    // Trois jours de plus que le délai : un dossier qui vient d'en sortir est clos avec ses clients sous les yeux, même
    // après un dimanche sans passage.
    // AU087 · une demande retenue par le seul plafond du jour [R11] n'expire pas : son dossier reste lu jusqu'à ce qu'elle
    // parte (ou soit refusée pour une autre règle).
    const capped = await this.db.first<{ d: string | null }>("SELECT MIN(due_day) AS d FROM review_requests WHERE network_id = ? AND status = 'waiting' AND next_try_day IS NOT NULL", [networkId]);
    const usual = addDays(today, -REVIEW_WINDOW_DAYS - 3);
    const from = capped?.d && addDays(capped.d, -1) < usual ? addDays(capped.d, -1) : usual;
    const sales = [...(await this.dossiers.closedBetween(networkId, from, addDays(today, -1)))].sort(
      (a, b) => a.closedOn.localeCompare(b.closedOn) || a.fileId.localeCompare(b.fileId),
    );
    let sent = 0;
    for (const sale of sales) {
      const dueDay = addDays(sale.closedOn, 1);
      if (dueDay > today || (dueDay === today && local.minutes < REVIEW_HOUR * 60)) continue;
      // Une demande par client, fiches réunies comprises : le premier côté nommé l'emporte.
      const seen = new Set<string>();
      const clients: { personId: string; side: 'vendeur' | 'acquereur' }[] = [];
      for (const c of sale.clients) {
        const root = await this.unique.rootOf(c.personId);
        if (seen.has(root)) continue;
        seen.add(root);
        clients.push({ personId: root, side: c.side });
      }
      if (dueDay < deadline) {
        await this.expire(networkId, sale.fileId, seen);
        // Seules restent les demandes retenues par le plafond du jour : elles partent à leur tour.
        if (!(await this.db.first("SELECT 1 FROM review_requests WHERE file_id = ? AND status = 'waiting' AND next_try_day IS NOT NULL", [sale.fileId]))) continue;
      }
      // Une demande en attente d'une fiche réunie depuis à une autre reste en attente, sans partir : la demande part sous
      // la fiche gardée ; si la réunion est défaite dans le délai, elle repart d'elle-même.
      // Chaque demande est rangée tout de suite, même sans lien : le délai la clora et l'agent sera prévenu.
      for (const c of clients) {
        await this.db.run(
          "INSERT INTO review_requests (file_id, person_id, network_id, agent_id, side, due_day, status, rule, next_try_day, message_id, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'waiting', NULL, NULL, NULL, ?) ON CONFLICT DO NOTHING",
          [sale.fileId, c.personId, networkId, sale.agentId, c.side, dueDay, at],
        );
      }
      const url = await this.linkOf(sale.agentId);
      if (!url) {
        await this.missingLink(networkId, sale);
        await this.db.run("UPDATE review_requests SET rule = 'lien_avis', updated_at = ? WHERE file_id = ? AND status = 'waiting' AND (rule IS NULL OR rule <> 'lien_avis')", [at, sale.fileId]);
        continue;
      }
      for (const c of clients) {
        const row = await this.db.first<{ status: ReviewStatus; next_try_day: string | null }>('SELECT status, next_try_day FROM review_requests WHERE file_id = ? AND person_id = ?', [sale.fileId, c.personId]);
        if (!row || (row.status !== 'waiting' && row.status !== 'failed')) continue;
        if (row.next_try_day && row.next_try_day > today) continue;
        const firstName = await this.firstName(c.personId);
        const others = clients.filter((o) => o.side !== c.side).map((o) => o.personId);
        const satisfactionLink = this.satisfactionBase ? await newSatisfactionLink(this.db, this.satisfactionBase, { networkId, fileId: sale.fileId, personId: c.personId, agentId: sale.agentId }, this.now()) : null;
        const result = await this.controle.send({
          networkId,
          agentId: sale.agentId,
          personId: c.personId,
          channel: 'email',
          kind: 'review_request',
          purpose: REVIEW_PURPOSE,
          subject: `avis:${sale.fileId}`,
          fallbackTexts: [reviewText(firstName, c.side, sale, url, satisfactionLink)],
          // Le lien de satisfaction donne la note de ce client : remis au canal, jamais rangé en clair [HX61, RC16].
          ...(satisfactionLink ? { secrets: [{ kind: 'lien' as const, value: satisfactionLink }] } : {}),
          // Les chiffres de la référence du bien et ceux du lien, lus dans la base [R10].
          figures: [...(sale.reference.match(/\d+/g) ?? []).map(Number), url],
          // Le nom d'un client de l'autre côté n'apparaît jamais [R19].
          sellerNames: await this.forbiddenNames(others, firstName),
        });
        let status: ReviewStatus;
        let nextTry: string | null = null;
        if (result.status === 'sent') status = 'sent';
        else if (result.status === 'failed') status = 'failed';
        else if (result.rule === 'R01') status = 'waiting';
        else if (result.rule === 'R11' && /aujourd/i.test(result.reason)) {
          // Le plafond du jour est atteint : le lendemain.
          status = 'waiting';
          nextTry = addDays(today, 1);
        } else if (result.rule === 'R11' && !/coll[eè]gue|associ|proche/i.test(result.reason)) {
          // Hors de l'heure des demandes d'avis : le passage suivant.
          status = 'waiting';
        } else status = 'refused';
        const rule = result.status === 'sent' ? null : result.rule;
        // Une demande déjà retenue par le plafond le reste pour le délai : `next_try_day` ne redevient jamais nul tant
        // qu'elle attend, pour qu'aucun délai ne la close à cause du seul plafond (AU087).
        const keepCapped = status === 'waiting' && nextTry === null && row.next_try_day !== null ? today : nextTry;
        await this.db.run(
          "UPDATE review_requests SET status = ?, rule = ?, next_try_day = ?, message_id = COALESCE(?, message_id), updated_at = ? WHERE file_id = ? AND person_id = ? AND status IN ('waiting', 'failed')",
          [status, rule, keepCapped, result.messageId, this.now().toISOString(), sale.fileId, c.personId],
        );
        await appendEvent(this.journal, { type: 'apres_vente.demande_avis', actor: 'system:apres-vente', subject: `sale_file:${sale.fileId}`, data: { mode: 'essai', side: c.side, client: `person:${c.personId}`, status, rule } }, this.now);
        if (status === 'sent') sent += 1;
      }
    }
    // Une demande d'un dossier que M10 ne rend plus : close, l'agent prévenu.
    for (const f of await this.db.all<{ file_id: string }>("SELECT DISTINCT file_id FROM review_requests WHERE network_id = ? AND status IN ('waiting', 'failed') AND due_day < ? ORDER BY file_id", [networkId, deadline])) {
      await this.expire(networkId, f.file_id, null);
    }
    return sent;
  }

  /**
   * Une demande restée en attente au-delà du délai ne partira plus : elle est close, avec sa raison, au journal.
   * - la fiche a été réunie à une autre dont la demande est partie : `fiche_reunie`, rien à faire pour l'agent ;
   * - la fiche n'est plus celle d'un client du dossier, une réunion ayant été défaite : `plus_client`, rien à faire ;
   * - sinon `delai_depasse`, et l'agent reçoit une tâche « demande d'avis non partie », une par dossier.
   * `clients` : les fiches gardées des clients du dossier, ou `null` si le dossier n'est plus rendu par M10.
   */
  private async expire(networkId: string, fileId: string, clients: ReadonlySet<string> | null): Promise<void> {
    const at = this.now().toISOString();
    const rows = await this.db.all<{ person_id: string; agent_id: string; side: string; capped: number }>(
      "SELECT person_id, agent_id, side, CASE WHEN status = 'waiting' AND next_try_day IS NOT NULL THEN 1 ELSE 0 END AS capped FROM review_requests WHERE file_id = ? AND status IN ('waiting', 'failed') ORDER BY person_id",
      [fileId],
    );
    for (const r of rows) {
      const root = await this.unique.rootOf(r.person_id);
      const merged = root !== r.person_id && !!(await this.db.first("SELECT 1 AS x FROM review_requests WHERE file_id = ? AND person_id = ? AND status = 'sent'", [fileId, root]));
      const reason = merged ? 'fiche_reunie' : clients && !clients.has(root) ? 'plus_client' : 'delai_depasse';
      // Jamais close pour le seul délai une demande retenue par le plafond du jour : elle partira à son tour (AU087).
      if (reason === 'delai_depasse' && Number(r.capped) === 1) continue;
      const { changes } = await this.db.run("UPDATE review_requests SET status = 'closed', rule = ?, updated_at = ? WHERE file_id = ? AND person_id = ? AND status IN ('waiting', 'failed')", [reason, at, fileId, r.person_id]);
      if (changes !== 1) continue;
      await appendEvent(this.journal, { type: 'apres_vente.demande_avis', actor: 'system:apres-vente', subject: `sale_file:${fileId}`, data: { mode: 'essai', side: r.side, client: `person:${r.person_id}`, status: 'closed', rule: reason } }, this.now);
      if (reason !== 'delai_depasse') continue;
      await this.db.run(
        "INSERT INTO after_sale_tasks (id, network_id, agent_id, file_id, kind, created_at, done_at) VALUES (?, ?, ?, ?, 'avis_non_parti', ?, NULL) ON CONFLICT DO NOTHING",
        [this.newId(), networkId, r.agent_id, fileId, at],
      );
    }
  }

  /** Les demandes d'avis : un agent voit celles de ses dossiers, la direction et la conformité celles du réseau [R16]. */
  async list(viewer: Viewer): Promise<{ ok: true; value: ReviewRequest[] } | ReviewRefusal> {
    const refusal = (await viewerRefusal(this.db, viewer)) ?? (viewer.role !== 'agent' && viewer.role !== 'direction' && viewer.role !== 'compliance' ? 'role' : null);
    if (refusal) return this.refuse(viewer, `network:${viewer.networkId}`, 'review_requests', refusal);
    const own = viewer.role === 'agent';
    const rows = await this.db.all<{ file_id: string; person_id: string; side: 'vendeur' | 'acquereur'; due_day: string; status: ReviewStatus; rule: string | null; updated_at: string }>(
      `SELECT file_id, person_id, side, due_day, status, rule, updated_at FROM review_requests WHERE network_id = ?${own ? ' AND agent_id = ?' : ''} ORDER BY due_day, file_id, side, person_id`,
      own ? [viewer.networkId, viewer.userId] : [viewer.networkId],
    );
    await appendEvent(this.journal, { type: 'apres_vente.lecture', actor: `${String(viewer.role)}:${viewer.userId}`, subject: `network:${viewer.networkId}`, data: { kind: 'review_requests', count: rows.length } }, this.now);
    return { ok: true, value: rows.map((r) => ({ fileId: r.file_id, personId: r.person_id, side: r.side, dueDay: r.due_day, status: r.status, rule: r.rule, updatedAt: r.updated_at })) };
  }

  /**
   * Les tâches encore ouvertes : « régler le lien de ma fiche Google » (`lien_avis`), « demande d'avis non partie dans
   * le délai, à faire moi-même » (`avis_non_parti`). L'agent ne voit que les siennes [R16].
   */
  async openTasks(viewer: Viewer): Promise<{ ok: true; value: { fileId: string; agentId: string; kind: AfterSaleTaskKind; createdAt: string }[] } | ReviewRefusal> {
    const refusal = (await viewerRefusal(this.db, viewer)) ?? (viewer.role !== 'agent' && viewer.role !== 'direction' ? 'role' : null);
    if (refusal) return this.refuse(viewer, `network:${viewer.networkId}`, 'after_sale_tasks', refusal);
    const own = viewer.role === 'agent';
    const rows = await this.db.all<{ file_id: string; agent_id: string; kind: AfterSaleTaskKind; created_at: string }>(
      `SELECT file_id, agent_id, kind, created_at FROM after_sale_tasks WHERE network_id = ? AND done_at IS NULL${own ? ' AND agent_id = ?' : ''} ORDER BY created_at, file_id, kind`,
      own ? [viewer.networkId, viewer.userId] : [viewer.networkId],
    );
    return { ok: true, value: rows.map((r) => ({ fileId: r.file_id, agentId: r.agent_id, kind: r.kind, createdAt: r.created_at })) };
  }
}

export const REVIEW_REQUEST_JOB = 'apres_vente.demandes_avis';

/** Du lundi au samedi, d'heure en heure de 10 h à 18 h : les demandes du jour, et celles qui attendaient [R01, R11]. */
export function reviewRequestJob(db: SqlDatabase, journal: JournalStore, dossiers: DossiersClos, options: { now?: () => Date; satisfactionBase?: string | null } = {}): ScheduledJob {
  return {
    name: REVIEW_REQUEST_JOB,
    hours: [10, 11, 12, 13, 14, 15, 16, 17, 18],
    weekdays: [1, 2, 3, 4, 5, 6],
    run: async () => {
      const d = new DemandesAvis(db, journal, dossiers, options);
      for (const n of await db.all<{ id: string }>('SELECT id FROM networks')) await d.run(n.id);
    },
  };
}
