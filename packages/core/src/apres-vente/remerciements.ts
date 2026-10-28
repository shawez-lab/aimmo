/**
 * Remerciement : l'agent appelle, le message est préparé (M11, F03) [R01, R02, R04, R05, R13, R16, R18, R26].
 *
 * À la clôture d'un dossier, une tâche « appeler pour remercier » par client, pour l'agent du dossier, avec un message
 * de remerciement préparé par le code, sans IA. L'agent le valide ou non : rien ne part sans sa validation. Validé, il
 * passe par le contrôle central, en mode essai ; refusé pour l'heure, il attend le passage suivant [R01].
 *
 * Décidé, lecture prudente :
 * - le dossier clos est lu par l'interface `DossiersClos` (N06 la branchera) ; les tâches sont créées par le passage
 *   quotidien, pour les dossiers clos des 7 derniers jours ; une seule par client et par dossier, fiches réunies
 *   comprises [R18] ;
 * - le message part par mail, avec la finalité du suivi de la vente (`suivi_vente`), dont l'accord est exigé [R03] ;
 * - un message validé qui n'a pas pu partir dans les 7 jours est clos, au journal ;
 * - l'agent peut marquer l'appel fait, indépendamment du message.
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
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import { nameWords } from '../visites/compte-rendu.ts';
import { REVIEW_PURPOSE, type DossiersClos } from './demandes-avis.ts';
import { viewerRefusal } from './lecteur.ts';

const TIME_ZONE = 'Europe/Paris';
export const THANK_YOU_PURPOSE = REVIEW_PURPOSE;
/** Les dossiers clos depuis au plus ce nombre de jours reçoivent leurs tâches ; un message validé attend au plus autant. */
export const THANK_YOU_WINDOW_DAYS = 7;

export type ThankYouSendStatus = 'sent' | 'waiting' | 'refused' | 'failed' | 'closed';

export interface ThankYouTask {
  fileId: string;
  personId: string;
  firstName: string | null;
  side: 'vendeur' | 'acquereur';
  dueDay: string;
  draft: string;
  calledAt: string | null;
  decision: 'send' | 'decline' | null;
  sendStatus: ThankYouSendStatus | null;
  rule: string | null;
}

export type ThankYouRefusal = { ok: false; rule: 'R16' | null; code: string };

const addDays = (day: string, n: number): string => new Date(Date.parse(`${day}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** Le message préparé, écrit par le code : vouvoiement avec le prénom, aucune parenthèse [R08], aucun chiffre hors de la référence [R10]. */
export function thankYouText(firstName: string | null, side: 'vendeur' | 'acquereur', property: { city: string | null; reference: string }): string {
  const hello = firstName ? `Bonjour ${firstName},` : 'Bonjour,';
  const where = `${property.city ? ` à ${property.city}` : ''}, référence ${property.reference}`;
  const what = side === 'vendeur' ? `la vente de votre bien${where}` : `l'achat de votre bien${where}`;
  return `${hello} merci pour votre confiance tout au long de ${what}. C'était un plaisir de vous accompagner jusqu'à la signature. Votre agent immobilier reste là pour toute question : il suffit de répondre à ce message.`;
}

export class Remerciements {
  private readonly now: () => Date;
  private readonly unique: FicheUnique;
  private readonly controle: ControleEnvois;

  constructor(
    private readonly db: SqlDatabase,
    private readonly journal: JournalStore,
    private readonly dossiers: DossiersClos,
    options: { now?: () => Date } = {},
  ) {
    this.now = options.now ?? (() => new Date());
    const fiches = new FicheClient(db, { now: this.now });
    this.unique = new FicheUnique(db, fiches, { now: this.now });
    this.controle = new ControleEnvois(db, this.unique, new DecisionEnvoi(db, fiches, this.unique, { now: this.now }), {
      channels: trialChannels(db, journal, this.now),
      journal: new SqlSendJournal(db, undefined, this.now),
      now: this.now,
    });
  }

  private async refuse(viewer: Viewer, subject: string, kind: string, code: string): Promise<ThankYouRefusal> {
    await appendEvent(this.journal, { type: 'acces.refuse', actor: `${String(viewer.role)}:${viewer.userId}`, subject, data: { rule: 'R16', role: String(viewer.role), kind, code } }, this.now);
    return { ok: false, rule: 'R16', code };
  }

  private async firstName(personId: string): Promise<string | null> {
    return (await this.db.first<{ first_name: string | null }>('SELECT first_name FROM persons WHERE id = ?', [personId]))?.first_name ?? null;
  }

  /**
   * Le passage : une tâche par client des dossiers clos des 7 derniers jours ; les messages validés en attente sont
   * retentés ; ceux qui attendent depuis plus de 7 jours sont clos. Rend le nombre de tâches créées.
   */
  async run(networkId: string): Promise<number> {
    const today = localTime(this.now(), TIME_ZONE).date;
    const at = this.now().toISOString();
    let created = 0;
    const sales = [...(await this.dossiers.closedBetween(networkId, addDays(today, -THANK_YOU_WINDOW_DAYS), today))].sort((a, b) => a.closedOn.localeCompare(b.closedOn) || a.fileId.localeCompare(b.fileId));
    for (const sale of sales) {
      const seen = new Set<string>();
      for (const c of sale.clients) {
        const root = await this.unique.rootOf(c.personId);
        if (seen.has(root)) continue;
        seen.add(root);
        const draft = thankYouText(await this.firstName(root), c.side, sale);
        const { changes } = await this.db.run(
          `INSERT INTO thank_you_tasks (file_id, person_id, network_id, agent_id, side, due_day, draft, called_at, decision, decided_at, send_status, rule, message_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?) ON CONFLICT DO NOTHING`,
          [sale.fileId, root, networkId, sale.agentId, c.side, sale.closedOn, draft, at, at],
        );
        if (changes === 1) {
          created += 1;
          await appendEvent(this.journal, { type: 'apres_vente.remerciement_tache', actor: 'system:apres-vente', subject: `sale_file:${sale.fileId}`, data: { side: c.side } }, this.now);
        }
      }
    }
    // Un message validé resté en attente plus de 7 jours ne part plus.
    for (const r of await this.db.all<{ file_id: string; person_id: string }>(
      "SELECT file_id, person_id FROM thank_you_tasks WHERE network_id = ? AND decision = 'send' AND send_status IN ('waiting', 'failed') AND decided_at < ? ORDER BY file_id, person_id",
      [networkId, new Date(this.now().getTime() - THANK_YOU_WINDOW_DAYS * 86_400_000).toISOString()],
    )) {
      const { changes } = await this.db.run("UPDATE thank_you_tasks SET send_status = 'closed', rule = 'delai_depasse', updated_at = ? WHERE file_id = ? AND person_id = ? AND send_status IN ('waiting', 'failed')", [at, r.file_id, r.person_id]);
      if (changes === 1) await appendEvent(this.journal, { type: 'apres_vente.remerciement', actor: 'system:apres-vente', subject: `sale_file:${r.file_id}`, data: { mode: 'essai', status: 'closed', rule: 'delai_depasse' } }, this.now);
    }
    for (const r of await this.db.all<{ file_id: string; person_id: string }>(
      "SELECT file_id, person_id FROM thank_you_tasks WHERE network_id = ? AND decision = 'send' AND send_status IN ('waiting', 'failed') ORDER BY decided_at, file_id, person_id",
      [networkId],
    )) {
      await this.send(r.file_id, r.person_id);
    }
    return created;
  }

  /** Envoie un message validé par le contrôle central, et range son issue. */
  private async send(fileId: string, personId: string): Promise<ThankYouSendStatus> {
    const t = await this.db.first<{ network_id: string; agent_id: string; side: string; draft: string; send_status: ThankYouSendStatus | null }>(
      'SELECT network_id, agent_id, side, draft, send_status FROM thank_you_tasks WHERE file_id = ? AND person_id = ?',
      [fileId, personId],
    );
    if (!t || (t.send_status !== 'waiting' && t.send_status !== 'failed')) return t?.send_status ?? 'refused';
    const others = (await this.db.all<{ person_id: string }>('SELECT person_id FROM thank_you_tasks WHERE file_id = ? AND side <> ?', [fileId, t.side])).map((o) => o.person_id);
    const sale = await this.dossiers.byId(t.network_id, fileId);
    const result = await this.controle.send({
      networkId: t.network_id,
      agentId: t.agent_id,
      personId,
      channel: 'email',
      kind: 'follow_up',
      purpose: THANK_YOU_PURPOSE,
      subject: `merci:${fileId}`,
      fallbackTexts: [t.draft],
      // Les chiffres de la référence du bien, lus dans la base [R10].
      figures: (sale?.reference.match(/\d+/g) ?? []).map(Number),
      // Le nom d'un client de l'autre côté n'apparaît jamais [R19].
      sellerNames: await this.forbiddenNames(others, await this.firstName(personId)),
    });
    const status: ThankYouSendStatus = result.status === 'sent' ? 'sent' : result.status === 'failed' ? 'failed' : result.rule === 'R01' ? 'waiting' : 'refused';
    const rule = result.status === 'sent' ? null : result.rule;
    await this.db.run(
      "UPDATE thank_you_tasks SET send_status = ?, rule = ?, message_id = COALESCE(?, message_id), updated_at = ? WHERE file_id = ? AND person_id = ? AND send_status IN ('waiting', 'failed')",
      [status, rule, result.messageId, this.now().toISOString(), fileId, personId],
    );
    await appendEvent(this.journal, { type: 'apres_vente.remerciement', actor: 'system:apres-vente', subject: `sale_file:${fileId}`, data: { mode: 'essai', status, rule } }, this.now);
    return status;
  }

  private async forbiddenNames(others: readonly string[], recipientFirstName: string | null): Promise<string[]> {
    const members = [...new Set((await Promise.all(others.map((o) => this.unique.membersOf(o)))).flat())];
    if (members.length === 0) return [];
    const rows = await this.db.all<{ first_name: string | null; last_name: string | null }>(`SELECT first_name, last_name FROM persons WHERE id IN (${members.map(() => '?').join(', ')})`, members);
    const greeting = new Set(recipientFirstName ? nameWords(recipientFirstName) : []);
    const words = new Set(rows.flatMap((r) => [r.first_name, r.last_name]).filter((n): n is string => !!n).flatMap(nameWords));
    return [...words].filter((w) => !greeting.has(w));
  }

  /** La tâche, si le lecteur est l'agent du dossier, actif [R16]. */
  private async ownTask(viewer: Viewer, fileId: string, personId: string, kind: string): Promise<{ ok: true; decision: string | null; calledAt: string | null } | ThankYouRefusal> {
    const subject = `sale_file:${fileId}`;
    const inactive = await viewerRefusal(this.db, viewer);
    if (inactive) return this.refuse(viewer, subject, kind, inactive);
    const t = await this.db.first<{ network_id: string; agent_id: string; decision: string | null; called_at: string | null }>(
      'SELECT network_id, agent_id, decision, called_at FROM thank_you_tasks WHERE file_id = ? AND person_id = ?',
      [fileId, personId],
    );
    if (!t || t.network_id !== viewer.networkId) {
      await this.refuse(viewer, subject, kind, 'unknown');
      return { ok: false, rule: null, code: 'unknown_task' };
    }
    if (viewer.role !== 'agent' || viewer.userId !== t.agent_id) return this.refuse(viewer, subject, kind, 'role');
    return { ok: true, decision: t.decision, calledAt: t.called_at };
  }

  /**
   * La décision de l'agent sur le message préparé : `send` le fait passer par le contrôle central, `decline` le garde ;
   * une décision rangée ne change plus. Seul l'agent du dossier décide [R16].
   */
  async decide(viewer: Viewer, fileId: string, personId: string, decision: 'send' | 'decline'): Promise<{ ok: true; status: ThankYouSendStatus | null } | ThankYouRefusal> {
    if (decision !== 'send' && decision !== 'decline') return { ok: false, rule: null, code: 'invalid_decision' };
    const own = await this.ownTask(viewer, fileId, personId, 'thank_you');
    if (!own.ok) return own;
    if (own.decision !== null) return { ok: false, rule: null, code: 'already_decided' };
    const at = this.now().toISOString();
    const { changes } = await this.db.run(
      'UPDATE thank_you_tasks SET decision = ?, decided_at = ?, send_status = ?, updated_at = ? WHERE file_id = ? AND person_id = ? AND decision IS NULL',
      [decision, at, decision === 'send' ? 'waiting' : null, at, fileId, personId],
    );
    if (changes !== 1) return { ok: false, rule: null, code: 'already_decided' };
    await appendEvent(this.journal, { type: 'apres_vente.remerciement_decision', actor: `agent:${viewer.userId}`, subject: `sale_file:${fileId}`, data: { decision } }, this.now);
    if (decision === 'decline') return { ok: true, status: null };
    return { ok: true, status: await this.send(fileId, personId) };
  }

  /** L'appel est fait : la tâche sort de la liste de l'agent. */
  async markCalled(viewer: Viewer, fileId: string, personId: string): Promise<{ ok: true } | ThankYouRefusal> {
    const own = await this.ownTask(viewer, fileId, personId, 'thank_you');
    if (!own.ok) return own;
    if (own.calledAt === null) {
      await this.db.run('UPDATE thank_you_tasks SET called_at = ?, updated_at = ? WHERE file_id = ? AND person_id = ? AND called_at IS NULL', [this.now().toISOString(), this.now().toISOString(), fileId, personId]);
      await appendEvent(this.journal, { type: 'apres_vente.remerciement_appel', actor: `agent:${viewer.userId}`, subject: `sale_file:${fileId}`, data: {} }, this.now);
    }
    return { ok: true };
  }

  /** Les remerciements de l'agent : appels à faire et messages à valider ; `open` : seulement ce qui reste à faire [R16]. */
  async list(viewer: Viewer, options: { open?: boolean } = {}): Promise<{ ok: true; value: ThankYouTask[] } | ThankYouRefusal> {
    const refusal = (await viewerRefusal(this.db, viewer)) ?? (viewer.role !== 'agent' ? 'role' : null);
    if (refusal) return this.refuse(viewer, `network:${viewer.networkId}`, 'thank_you_tasks', refusal);
    const rows = await this.db.all<{ file_id: string; person_id: string; side: 'vendeur' | 'acquereur'; due_day: string; draft: string; called_at: string | null; decision: 'send' | 'decline' | null; send_status: ThankYouSendStatus | null; rule: string | null }>(
      `SELECT file_id, person_id, side, due_day, draft, called_at, decision, send_status, rule FROM thank_you_tasks WHERE network_id = ? AND agent_id = ?${options.open ? ' AND (called_at IS NULL OR decision IS NULL)' : ''} ORDER BY due_day, file_id, side, person_id`,
      [viewer.networkId, viewer.userId],
    );
    await appendEvent(this.journal, { type: 'apres_vente.lecture', actor: `agent:${viewer.userId}`, subject: `network:${viewer.networkId}`, data: { kind: 'thank_you_tasks', count: rows.length } }, this.now);
    const value: ThankYouTask[] = [];
    for (const r of rows) {
      value.push({ fileId: r.file_id, personId: r.person_id, firstName: await this.firstName(r.person_id), side: r.side, dueDay: r.due_day, draft: r.draft, calledAt: r.called_at, decision: r.decision, sendStatus: r.send_status, rule: r.rule });
    }
    return { ok: true, value };
  }
}

export const THANK_YOU_JOB = 'apres_vente.remerciements';

/** Du lundi au samedi, d'heure en heure de 8 h à 19 h : les tâches des dossiers clos, et les messages validés qui attendaient [R01]. */
export function thankYouJob(db: SqlDatabase, journal: JournalStore, dossiers: DossiersClos, options: { now?: () => Date } = {}): ScheduledJob {
  return {
    name: THANK_YOU_JOB,
    hours: [8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19],
    weekdays: [1, 2, 3, 4, 5, 6],
    run: async () => {
      const r = new Remerciements(db, journal, dossiers, options);
      for (const n of await db.all<{ id: string }>('SELECT id FROM networks')) await r.run(n.id);
    },
  };
}
