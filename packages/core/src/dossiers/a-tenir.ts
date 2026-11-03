/**
 * Ce que l'agent doit tenir sur ses ventes, à l'accueil de l'application (W26) [R16, R59, R61, R62].
 *
 * Les passages rangeaient déjà les tâches d'échéance et les alertes, mais aucun écran ne les lisait : prévenu sur le
 * papier, l'agent ne voyait rien. Cette lecture réunit les quatre sources sous leurs propres droits, nomme chaque bien
 * par sa référence d'agence, et ne garde que ce qui sert encore. Elle ne décide rien, n'envoie rien et ne range rien.
 *
 * Décidé, lecture prudente : un bien passé à un autre agent sort de la liste de l'ancien [R16] ; une offre dont le
 * dernier jour est passé n'a plus d'échéance à tenir ; une alerte sur l'argent reste jusqu'à la fin du dossier, faute
 * de quoi une fraude en cours pourrait disparaître de l'écran, et les messages d'un même côté d'un dossier font une
 * seule ligne, sinon un dossier bavard noierait tout le reste. Le texte des messages n'est jamais repris [R15].
 */
import type { Acces } from '../acces/acces.ts';
import type { Viewer } from '../acces/droits.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { localTime } from '../envoi/horaires.ts';
import type { JournalStore } from '../journal/types.ts';
import { EcheancesOffres } from '../offres/echeances.ts';
import type { FileRefusal } from './acces-dossier.ts';
import { BouclierFonds, type FundSignal } from './bouclier.ts';
import { Echeancier, type Deadline } from './echeancier.ts';
import { FinancementDossier } from './financement.ts';

const TIME_ZONE = 'Europe/Paris';
const SIGNALS: readonly FundSignal[] = ['iban', 'coordonnees_bancaires', 'virement', 'acompte', 'sequestre', 'paiement'];
/** D1 borne le nombre de paramètres d'une requête. */
const CHUNK = 80;

/** `fait` : le rappel écrit est passé par le contrôle central (rangé, en mode essai) ; `attente` : pas encore passé ; `a_prevenir` : il ne passera pas. */
export type FundReminder = 'fait' | 'attente' | 'a_prevenir';

export interface FundLine {
  fileId: string;
  propertyId: string;
  reference: string;
  side: 'vendeur' | 'acquereur';
  signals: FundSignal[];
  messages: number;
  lastAt: string;
  reminder: FundReminder;
}

export interface FinancingLine {
  fileId: string;
  propertyId: string;
  reference: string;
  kind: 'sans_offre_de_pret' | 'refus_declare';
  day: string;
}

export type DeadlineLine =
  | { source: 'offre'; propertyId: string; reference: string; proposal: boolean; day: string }
  | { source: 'dossier'; fileId: string; propertyId: string; reference: string; deadline: Deadline; kind: 'avant_echeance' | 'a_saisir'; day: string | null };

export interface SaleWatch {
  fonds: FundLine[];
  financement: FinancingLine[];
  echeances: DeadlineLine[];
}

export class ATenirVente {
  private readonly now: () => Date;
  private readonly offres: EcheancesOffres;
  private readonly echeancier: Echeancier;
  private readonly financement: FinancementDossier;
  private readonly bouclier: BouclierFonds;

  constructor(
    private readonly db: SqlDatabase,
    acces: Acces,
    journal: JournalStore,
    options: { now?: () => Date } = {},
  ) {
    this.now = options.now ?? (() => new Date());
    const clock = { now: this.now };
    this.offres = new EcheancesOffres(db, journal, clock);
    this.echeancier = new Echeancier(db, acces, journal, clock);
    this.financement = new FinancementDossier(db, acces, journal, clock);
    this.bouclier = new BouclierFonds(db, acces, journal, clock);
  }

  /** Les biens encore à cet agent, avec leur référence et leur état. Tout autre bien sort de la liste [R16]. */
  private async own(viewer: Viewer, ids: string[]): Promise<Map<string, { reference: string; status: string }>> {
    const found = new Map<string, { reference: string; status: string }>();
    const unique = [...new Set(ids)];
    for (let i = 0; i < unique.length; i += CHUNK) {
      const part = unique.slice(i, i + CHUNK);
      const rows = await this.db.all<{ id: string; reference: string; status: string }>(
        `SELECT id, reference, status FROM properties WHERE network_id = ? AND agent_id = ? AND id IN (${part.map(() => '?').join(', ')})`,
        [viewer.networkId, viewer.userId, ...part],
      );
      for (const r of rows) found.set(r.id, { reference: r.reference, status: r.status });
    }
    return found;
  }

  /** Une lecture qui échoue rend le refus : jamais une liste vide qui se lirait « rien à tenir » [R10]. */
  async of(viewer: Viewer): Promise<{ ok: true; value: SaleWatch } | FileRefusal> {
    const offers = await this.offres.tasksOf(viewer);
    if (!offers.ok) return offers;
    const files = await this.echeancier.tasksOf(viewer);
    if (!files.ok) return files;
    const financing = await this.financement.alertsOf(viewer);
    if (!financing.ok) return financing;
    const funds = await this.bouclier.alertsOf(viewer);
    if (!funds.ok) return funds;

    const own = await this.own(viewer, [...offers.tasks, ...files.tasks, ...financing.alerts, ...funds.alerts].map((x) => x.propertyId));
    const today = localTime(this.now(), TIME_ZONE).date;

    const echeances: DeadlineLine[] = [];
    for (const k of offers.tasks) {
      const p = own.get(k.propertyId);
      if (p && k.lastDay >= today) echeances.push({ source: 'offre', propertyId: k.propertyId, reference: p.reference, proposal: k.proposalId !== null, day: k.lastDay });
    }
    for (const k of files.tasks) {
      const p = own.get(k.propertyId);
      if (p) echeances.push({ source: 'dossier', fileId: k.fileId, propertyId: k.propertyId, reference: p.reference, deadline: k.deadline, kind: k.kind, day: k.day });
    }
    // Le jour le plus proche d'abord ; une date à saisir n'a pas de jour : après celles qui en ont un.
    echeances.sort((a, b) => (a.day === b.day ? 0 : a.day === null ? 1 : b.day === null ? -1 : a.day < b.day ? -1 : 1));

    const financement: FinancingLine[] = [];
    for (const a of financing.alerts) {
      const p = own.get(a.propertyId);
      if (p) financement.push({ fileId: a.fileId, propertyId: a.propertyId, reference: p.reference, kind: a.kind, day: a.day });
    }

    const groups = new Map<string, FundLine & { reminders: Set<FundReminder> }>();
    for (const a of funds.alerts) {
      const p = own.get(a.propertyId);
      // Une alerte vaut tant que le dossier est en cours, comme la lecture des messages du bouclier.
      if (!p || p.status !== 'under_offer') continue;
      const key = `${a.fileId}:${a.side}`;
      const reminder: FundReminder = a.reminder === 'sent' || a.reminderRule === 'R05' ? 'fait' : a.reminder === 'refused' ? 'a_prevenir' : 'attente';
      const g = groups.get(key);
      if (!g) {
        groups.set(key, { fileId: a.fileId, propertyId: a.propertyId, reference: p.reference, side: a.side, signals: [...a.signals], messages: 1, lastAt: a.createdAt, reminder, reminders: new Set([reminder]) });
        continue;
      }
      g.messages += 1;
      g.signals.push(...a.signals);
      if (a.createdAt > g.lastAt) g.lastAt = a.createdAt;
      g.reminders.add(reminder);
    }
    const fonds = [...groups.values()]
      .map(({ reminders, ...g }): FundLine => ({
        ...g,
        signals: SIGNALS.filter((s) => g.signals.includes(s)),
        // Le rappel part une fois par personne et par dossier : un seul passé suffit ; sinon le pire est dit.
        reminder: reminders.has('fait') ? 'fait' : reminders.has('a_prevenir') ? 'a_prevenir' : 'attente',
      }))
      .sort((a, b) => (a.lastAt > b.lastAt ? -1 : a.lastAt < b.lastAt ? 1 : 0));

    return { ok: true, value: { fonds, financement, echeances } };
  }
}
