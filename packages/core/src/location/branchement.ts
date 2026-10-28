/**
 * Branchement de M15 au planificateur du socle (W10) [R100, R105, R01, R03, R05, R18, R26].
 *
 * M15 prépare deux sortes de textes pour un client, sans jamais les envoyer lui-même : l'échéance du propriétaire d'un
 * logement classé E, F ou G (W01) et les reçus d'équité de la présentation au propriétaire (W05). `EnvoisLocation`
 * les passe par le contrôle central des envois, qui redécide au moment de l'envoi : heures, exclusion, arrêt, accord,
 * un seul envoi par sujet. Les canaux sont ceux du mode essai : rangé dans la boîte d'essai, rien ne part réellement
 * tant que le plan ne l'a pas mis en service [R26].
 *
 * Chaque texte a une ligne dans `rental_sends` : envoyé ou refusé, c'est fini ; en attente de l'heure ou en échec,
 * il est repris au passage suivant. Rejouer un passage n'envoie rien deux fois : le contrôle refuse un second envoi
 * du même sujet [R05], et une issue définitive n'est plus relue [R18].
 *
 * Décidé, lecture prudente : l'accord demandé est celui du suivi de la location (`suivi_location`), par mail ; sans cet
 * accord, rien ne part : le texte reste préparé, lisible par l'agent, et le contrôle redemande l'accord à chaque
 * passage. Un texte devenu faux avant son envoi (classe énergie corrigée, présentation refaite) est refusé, jamais
 * envoyé. Le passage tourne une fois par heure, de
 * 9 h à 19 h, aux heures où un envoi peut partir [R01].
 */
import type { ScheduledJob } from '../bascule/planificateur.ts';
import { trialChannels } from '../captation/essai.ts';
import { FicheClient } from '../db/fiche-client.ts';
import type { SqlDatabase } from '../db/sql.ts';
import type { ControleEnvois as ControleEnvoisType, SendResult } from '../envoi/controle.ts';
import { ControleEnvois } from '../envoi/controle.ts';
import { SqlSendJournal } from '../envoi/journal-envois.ts';
import { DecisionEnvoi } from '../envoi/service.ts';
import { FicheUnique } from '../fiche/fusion.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';

export const RENTAL_UPDATE_PURPOSE = 'suivi_location';
export const LOCATION_SEND_JOB = 'location.envois';
/** Les heures de passage : celles où un envoi peut partir [R01]. */
export const LOCATION_SEND_HOURS: readonly number[] = [9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19];

export type RentalSendKind = 'echeance' | 'recu';
export type RentalSendStatus = 'sent' | 'refused' | 'waiting' | 'failed';

interface Pending {
  kind: RentalSendKind;
  id: string;
  network_id: string;
  person_id: string;
  agent_id: string | null;
  subject_ref: string;
  text: string;
  recipient: string | null;
  application_id: string | null;
  /** Le texte vaut encore : l'échéance pour la classe des derniers faits, le reçu de la dernière présentation. */
  current: number;
  last_status: string | null;
  last_rule: string | null;
}

/**
 * Le statut rangé d'après la réponse du contrôle : l'heure attend, l'accord manquant attend qu'il soit donné (rien ne
 * part sans lui, le contrôle le redemande à chaque passage) [R01, R03], la panne se reprend, le reste est fini.
 */
export function sendStatus(r: Pick<SendResult, 'status' | 'rule'>): RentalSendStatus {
  if (r.status === 'sent') return 'sent';
  if (r.status === 'failed') return 'failed';
  return r.rule === 'R01' || r.rule === 'R03' ? 'waiting' : 'refused';
}

/** La raison rangée d'un texte devenu faux avant son envoi : classe corrigée, présentation refaite. */
export const STALE_RULE = 'perime';

export class EnvoisLocation {
  private readonly now: () => Date;
  private readonly controle: Pick<ControleEnvoisType, 'send'>;

  constructor(
    private readonly db: SqlDatabase,
    private readonly journal: JournalStore,
    options: { now?: () => Date; controle?: Pick<ControleEnvoisType, 'send'> } = {},
  ) {
    this.now = options.now ?? (() => new Date());
    const store = new FicheClient(db, { now: this.now });
    const fiche = new FicheUnique(db, store, { now: this.now });
    // Les seuls canaux du mode essai : rangé dans la boîte d'essai, jamais envoyé [R26].
    this.controle =
      options.controle ??
      new ControleEnvois(db, fiche, new DecisionEnvoi(db, store, fiche, { now: this.now }), {
        channels: trialChannels(db, journal, this.now),
        journal: new SqlSendJournal(db, undefined, this.now),
        now: this.now,
      });
  }

  /** Les textes préparés du réseau qui n'ont pas encore d'issue définitive, dans l'ordre de leur préparation. */
  private async pending(networkId: string): Promise<Pending[]> {
    const open = "NOT EXISTS (SELECT 1 FROM rental_sends s WHERE s.kind = ? AND s.ref_id = x.id AND s.status IN ('sent', 'refused'))";
    const notices = await this.db.all<Omit<Pending, 'kind'>>(
      `SELECT x.id, l.network_id, x.owner_person_id AS person_id, p.agent_id, l.id AS subject_ref, x.text, NULL AS recipient, NULL AS application_id,
         (x.energy_class = (SELECT f.energy_class FROM rental_facts f WHERE f.listing_id = x.listing_id ORDER BY f.version DESC LIMIT 1)) AS current,
         s.status AS last_status, s.rule AS last_rule
       FROM rental_owner_notices x JOIN rental_listings l ON l.id = x.listing_id LEFT JOIN properties p ON p.id = l.property_id
       LEFT JOIN rental_sends s ON s.kind = 'echeance' AND s.ref_id = x.id
       WHERE l.network_id = ? AND ${open} ORDER BY x.prepared_at, x.id`,
      [networkId, 'echeance'],
    );
    const receipts = await this.db.all<Omit<Pending, 'kind'>>(
      `SELECT x.id, r.network_id, x.person_id, p.agent_id, r.id AS subject_ref, x.text, x.recipient, x.application_id,
         (r.version = (SELECT MAX(q.version) FROM rental_presentations q WHERE q.listing_id = r.listing_id)) AS current,
         s.status AS last_status, s.rule AS last_rule
       FROM rental_fairness_receipts x JOIN rental_presentations r ON r.id = x.presentation_id
       JOIN rental_listings l ON l.id = r.listing_id LEFT JOIN properties p ON p.id = l.property_id
       LEFT JOIN rental_sends s ON s.kind = 'recu' AND s.ref_id = x.id
       WHERE r.network_id = ? AND ${open} ORDER BY x.prepared_at, x.id`,
      [networkId, 'recu'],
    );
    return [...notices.map((n) => ({ ...n, kind: 'echeance' as const })), ...receipts.map((r) => ({ ...r, kind: 'recu' as const }))];
  }

  /** Passe chaque texte en attente par le contrôle central ; rend le nombre de textes passés. */
  async run(networkId: string): Promise<number> {
    let n = 0;
    for (const p of await this.pending(networkId)) {
      // Un texte devenu faux (classe corrigée depuis, présentation refaite) ne part jamais : refusé, avec sa raison.
      if (!Number(p.current)) {
        await this.record(p, 'refused', STALE_RULE);
        n += 1;
        continue;
      }
      // Le texte préparé salue sans nom (il est rangé tel quel, rejouable) : le prénom n'est ajouté qu'à l'envoi [R08].
      const person = await this.db.first<{ first_name: string | null }>('SELECT first_name FROM persons WHERE id = ?', [p.person_id]);
      const text = person?.first_name ? p.text.replace(/^Bonjour,/, `Bonjour ${person.first_name},`) : p.text;
      const result = await this.controle.send({
        networkId: p.network_id,
        agentId: p.agent_id,
        personId: p.person_id,
        channel: 'email',
        kind: 'follow_up',
        purpose: RENTAL_UPDATE_PURPOSE,
        // Un seul envoi par texte préparé [R05].
        subject: p.kind === 'echeance' ? `echeance_location:${p.id}` : `recu_equite:${p.id}`,
        fallbackTexts: [text],
        // Les nombres du texte sont ceux du code (dates, ordre d'arrivée, empreinte), vérifiés à la préparation [R10].
        figures: (text.match(/\d+/g) ?? []).map(Number),
      });
      const status = sendStatus(result);
      await this.record(p, status, status === 'sent' ? null : result.rule);
      n += 1;
    }
    return n;
  }

  /** Range l'issue ; le journal ne la note que quand elle change, pas à chaque passage qui attend encore. */
  private async record(p: Pending, status: RentalSendStatus, rule: string | null): Promise<void> {
    const at = this.now().toISOString();
    await this.db.run(
      `INSERT INTO rental_sends (kind, ref_id, network_id, status, rule, updated_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (kind, ref_id) DO UPDATE SET status = excluded.status, rule = excluded.rule, updated_at = excluded.updated_at`,
      [p.kind, p.id, p.network_id, status, rule, at],
    );
    // Au journal : la sorte, l'issue et la règle ; jamais le texte ni le nom [R13]. Un reçu porte, comme sa
    // préparation, son destinataire et la candidature : la réponse d'accès le rend ainsi à qui il est (L07).
    const subject = p.kind === 'echeance' ? `rental:${p.subject_ref}` : `rental_presentation:${p.subject_ref}`;
    const data = p.kind === 'echeance' ? { kind: p.kind, ref: p.id, mode: 'essai', status, rule } : { kind: p.kind, ref: p.id, recipient: p.recipient, application: p.application_id, mode: 'essai', status, rule };
    if (p.last_status !== status || p.last_rule !== rule) await appendEvent(this.journal, { type: 'location.envoi', actor: 'system:location', subject, data }, this.now);
  }
}

export function locationSendJob(db: SqlDatabase, journal: JournalStore, options: { now?: () => Date } = {}): ScheduledJob {
  const now = options.now ?? (() => new Date());
  return {
    name: LOCATION_SEND_JOB,
    hours: LOCATION_SEND_HOURS,
    run: async () => {
      const envois = new EnvoisLocation(db, journal, { now });
      for (const n of await db.all<{ id: string }>('SELECT id FROM networks ORDER BY id')) await envois.run(n.id);
    },
  };
}
