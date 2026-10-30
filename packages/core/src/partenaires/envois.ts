/**
 * Le passage des envois de M18 (U12) : chaque relance préparée à un partenaire (U07) dont l'heure est venue, et chaque
 * brouillon de prospection (U08), passe par le contrôle central des envois, en mode essai, qui redécide maintenant
 * [R01, R03, R04, R05, R06, R11, R79]. Un envoi parti ou refusé pour de bon n'est plus repris ; une attente (heure,
 * plafond, jour, adresse) l'est au passage suivant.
 *
 * Une relance ne part que si la demande est toujours confiée au même partenaire et toujours sans réponse de sa part :
 * une réponse arrivée entre la préparation et l'envoi l'arrête. Un brouillon de prospection reste refusé sous R03 tant
 * que H32 n'a pas écrit son exception dans R03 et dans `decideSend`. Les alertes à l'agent (U07) restent dans
 * l'application : elles ne sortent pas du réseau.
 *
 * Rien ne part réellement : le contrôle n'admet que la boîte d'essai des professionnels.
 */
import { FicheClient } from '../db/fiche-client.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { ControleEnvois } from '../envoi/controle.ts';
import { localTime } from '../envoi/horaires.ts';
import { SqlSendJournal } from '../envoi/journal-envois.ts';
import { lastProDecision, ProTrialMailbox, type ProSendResult } from '../envoi/professionnels.ts';
import { DecisionEnvoi } from '../envoi/service.ts';
import { FicheUnique } from '../fiche/fusion.ts';
import type { JournalStore } from '../journal/types.ts';
import type { MiseEnRelation } from './mise-en-relation.ts';
import type { SuiviPartenaires } from './suivi-partenaires.ts';

const TIME_ZONE = 'Europe/Paris';

/** Le sujet d'une relance et d'un brouillon de prospection, une seule fois chacun [R05]. */
export const followUpSubject = (referralId: string): string => `relance:${referralId}`;
export const prospectSubject = (prospectId: string): string => `prospection:${prospectId}`;

export interface EnvoisPartenairesReport {
  sent: number;
  refused: number;
  waiting: number;
  failed: number;
}

export class EnvoisPartenaires {
  private readonly now: () => Date;
  private readonly controle: ControleEnvois;

  constructor(
    private readonly db: SqlDatabase,
    private readonly relations: MiseEnRelation,
    private readonly suivi: SuiviPartenaires,
    journal: JournalStore,
    options: { now?: () => Date; controle?: ControleEnvois } = {},
  ) {
    this.now = options.now ?? (() => new Date());
    const fiches = new FicheClient(db, { now: this.now });
    const unique = new FicheUnique(db, fiches, { now: this.now });
    this.controle =
      options.controle ??
      new ControleEnvois(db, unique, new DecisionEnvoi(db, fiches, unique, { now: this.now }), {
        // Aucun canal de client : ce passage n'écrit qu'à des professionnels, et seulement dans la boîte d'essai.
        channels: [],
        journal: new SqlSendJournal(db, undefined, this.now),
        now: this.now,
        proMailbox: new ProTrialMailbox(db, journal, this.now),
      });
  }

  private async open(networkId: string, subject: string): Promise<boolean> {
    const last = await lastProDecision(this.db, networkId, subject);
    return !last || last.outcome === 'waiting' || last.outcome === 'failed';
  }

  /** Le passage d'un réseau : relances dues, puis brouillons de prospection, dans l'ordre de leur préparation. */
  async run(networkId: string): Promise<EnvoisPartenairesReport> {
    const report: EnvoisPartenairesReport = { sent: 0, refused: 0, waiting: 0, failed: 0 };
    const count = (r: ProSendResult): void => {
      report[r.status]++;
    };
    const now = this.now();

    const followUps = await this.db.all<{ referral_id: string; recipient: string; text: string }>(
      "SELECT referral_id, recipient, text FROM partner_followups WHERE network_id = ? AND kind = 'relance' AND due_at <= ? ORDER BY due_at, id",
      [networkId, now.toISOString()],
    );
    for (const f of followUps) {
      const subject = followUpSubject(f.referral_id);
      if (!(await this.open(networkId, subject))) continue;
      const partnerId = f.recipient.startsWith('partner:') ? f.recipient.slice('partner:'.length) : null;
      if (!partnerId) continue;
      const measure = await this.suivi.measure(f.referral_id);
      const figures = measure.entrustedAt ? [Number(localTime(new Date(measure.entrustedAt), TIME_ZONE).date.slice(8, 10))] : [];
      count(
        await this.controle.sendToProfessional({
          networkId,
          kind: 'partner',
          recipient: { partnerId },
          subject,
          text: f.text,
          figures,
          // Redécidé au moment de l'envoi : toujours confiée à ce partenaire, toujours sans sa réponse.
          stillAllowed: async () => {
            const held = await this.relations.entrusted(networkId, f.referral_id);
            if (!held || held.partnerId !== partnerId || held.state !== 'confiee') return { allowed: false, rule: null, reason: 'La demande n’est plus confiée à ce partenaire, ou il y a répondu.' };
            if ((await this.suivi.measure(f.referral_id)).answered) return { allowed: false, rule: null, reason: 'Le partenaire a répondu : la relance ne part pas.' };
            return { allowed: true, rule: null, reason: '' };
          },
        }),
      );
    }

    const network = await this.db.first<{ name: string }>('SELECT name FROM networks WHERE id = ?', [networkId]);
    const figures = (network?.name.match(/\d+/g) ?? []).map(Number);
    const mails = await this.db.all<{ prospect_id: string; text: string }>('SELECT prospect_id, text FROM partner_prospect_mails WHERE network_id = ? ORDER BY prepared_at, id', [networkId]);
    for (const m of mails) {
      const subject = prospectSubject(m.prospect_id);
      if (!(await this.open(networkId, subject))) continue;
      count(await this.controle.sendToProfessional({ networkId, kind: 'prospecting', recipient: { prospectId: m.prospect_id }, subject, text: m.text, figures }));
    }
    return report;
  }
}
