/**
 * La bascule des automatisations du site sur le socle (S11, B01).
 *
 * Le site garde ses données et ses textes ; avant chaque envoi d'une de ses automatisations, il demande au socle si
 * le message peut partir. Le socle retrouve la fiche par l'adresse, puis passe la demande par le contrôle central des
 * envois (S06) avec les canaux du mode essai : la décision et sa règle sont rendues, rien n'est envoyé [R26].
 * Le journal ne porte ni adresse ni texte [R13].
 */
import type { SqlDatabase } from '../db/sql.ts';
import { FicheClient } from '../db/fiche-client.ts';
import { FicheUnique } from '../fiche/fusion.ts';
import { DecisionEnvoi } from '../envoi/service.ts';
import type { SendKind } from '../envoi/decision.ts';
import { ControleEnvois } from '../envoi/controle.ts';
import { SqlSendJournal } from '../envoi/journal-envois.ts';
import { trialChannels } from '../captation/essai.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import { VALUATION_PURPOSE } from '../reprise/reprise.ts';
import { PaliersBascule, type RolloutStage } from './paliers.ts';

/** Les automatisations du site qui envoient aujourd'hui (docs/EXISTANT.md), et ce qu'elles sont pour le contrôle. */
export const AUTOMATIONS = {
  /** Rappel de la visite d'estimation, la veille. */
  rappel_visite: { kind: 'reminder' as SendKind, purpose: VALUATION_PURPOSE },
  /** Mail au vendeur sur le suivi de son estimation, gardé la nuit et parti le matin. */
  courrier_vendeur: { kind: 'follow_up' as SendKind, purpose: VALUATION_PURPOSE },
} as const;
export type Automation = keyof typeof AUTOMATIONS;
export const AUTOMATION_NAMES = Object.keys(AUTOMATIONS) as Automation[];

export const AUTOMATION_JOURNAL_TYPE = 'bascule.demande.essai';

export interface AutomationRequest {
  networkId: string;
  automation: Automation;
  /** Adresse mail de la personne, telle que le site la connaît. */
  email: string;
  /** Référence de l'envoi chez le site (visite, courrier) : un même envoi ne part qu'une fois [R05]. */
  ref: string;
  /** Le texte du site, contrôlé comme tout texte [R06 à R10]. */
  text: string;
  /** Chiffres permis dans le texte : ceux des données du site [R10]. */
  figures?: readonly (string | number)[];
}

export interface AutomationDecision {
  /** `would_send` : le message aurait pu partir ; il n'est jamais envoyé en mode essai [R26]. */
  status: 'would_send' | 'refused' | 'failed';
  rule: string | null;
  /** `unknown_person`, `ambiguous_person` quand la fiche n'a pas pu être trouvée, sinon `null`. */
  code: 'unknown_person' | 'ambiguous_person' | null;
  reason: string;
  sent: false;
  /** Le palier en vigueur (B04a). */
  stage: RolloutStage;
  /** La décision vaut-elle pour le site ? Sinon il décide seul, comme avant [R26]. */
  decides: boolean;
  /** La mention était due et le texte du site ne la porte pas [R06] : refusé si le socle décide, sinon seulement signalé. */
  mentionMissing: boolean;
}

export interface AutomatisationsOptions {
  now?: () => Date;
}

/** Une référence courte, sans espace ni donnée : l'identifiant de la visite ou du courrier chez le site. */
export const REF_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export class Automatisations {
  private readonly now: () => Date;
  private readonly fiche: FicheUnique;
  private readonly controle: ControleEnvois;
  private readonly paliers: PaliersBascule;

  constructor(
    private readonly db: SqlDatabase,
    private readonly journal: JournalStore,
    options: AutomatisationsOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    const store = new FicheClient(db, { now: this.now });
    this.fiche = new FicheUnique(db, store, { now: this.now });
    this.paliers = new PaliersBascule(db, journal, { now: this.now });
    const decisions = new DecisionEnvoi(db, store, this.fiche, { now: this.now });
    // Seuls les canaux du mode essai sont branchés ici : aucun vrai canal ne peut être passé de l'extérieur [R26].
    this.controle = new ControleEnvois(db, this.fiche, decisions, {
      channels: trialChannels(db, journal, this.now),
      journal: new SqlSendJournal(db, undefined, this.now),
      now: this.now,
    });
  }

  async request(req: AutomationRequest): Promise<AutomationDecision> {
    const spec = AUTOMATIONS[req.automation];
    if (!spec) throw new Error('Automatisation inconnue.');
    if (!REF_PATTERN.test(req.ref)) throw new Error('Référence mal formée.');

    const palier = await this.paliers.decide(req.networkId, req.automation, req.ref);
    const persons = await this.fiche.findByIdentifier(req.networkId, 'email', req.email);
    if (persons.length !== 1) {
      const code = persons.length === 0 ? 'unknown_person' : 'ambiguous_person';
      const decision: AutomationDecision = {
        status: 'refused',
        rule: null,
        code,
        reason: code === 'unknown_person' ? 'Aucune fiche pour cette adresse.' : 'Plusieurs fiches pour cette adresse : à réunir avant tout envoi.',
        sent: false,
        stage: palier.stage,
        // Sans fiche, le socle ne sait rien de la personne : il ne décide pas à la place du site. Plusieurs fiches non
        // réunies : l'une peut être exclue ou arrêtée, le refus vaut donc selon le palier. Rien de cela n'est compté :
        // un palier se prouve sur de vraies décisions [R26].
        decides: code === 'unknown_person' ? false : palier.decides,
        mentionMissing: false,
      };
      await this.write(req, null, decision);
      return decision;
    }
    const person = persons[0]!;
    const result = await this.controle.send({
      networkId: req.networkId,
      agentId: person.agent_id ?? null,
      personId: person.id,
      channel: 'email',
      kind: spec.kind,
      purpose: spec.purpose,
      subject: `${req.automation}:${req.ref}`,
      fallbackTexts: [req.text],
      figures: req.figures ?? [],
      // Le site envoie lui-même : son message est rangé tel quel, compté une fois, sans mention ajoutée [R06, R11].
      asWritten: { refuseWithoutMention: palier.decides },
    });
    // Une panne du contrôle ramène l'automatisation en ombre, avant de répondre [R26].
    const failed = result.status === 'failed';
    if (failed) await this.paliers.incident(req.networkId, req.automation, 'failure', null, 'system:bascule');
    // Une demande refaite pour le même envoi ne compte pas deux fois ; à 10 %, seuls comptent les envois où le socle décide.
    // Un refus pour une mention que le site ne porte pas ne prouve rien : le site n'est pas encore aligné.
    else if (result.rule !== 'R05' && !(result.status === 'refused' && result.mentionMissing) && (palier.stage !== 'ten_percent' || palier.decides)) await this.paliers.countRequest(req.networkId, req.automation, palier.stageSince);
    const decision: AutomationDecision = {
      status: result.status === 'sent' ? 'would_send' : result.status,
      rule: result.rule,
      code: null,
      reason: result.reason,
      sent: false,
      stage: failed ? 'shadow' : palier.stage,
      decides: failed ? false : palier.decides,
      mentionMissing: result.mentionMissing ?? false,
    };
    await this.write(req, person.id, decision);
    return decision;
  }

  /** Au journal : l'automatisation, la décision et sa règle ; ni adresse, ni texte, ni référence du site [R13]. */
  private async write(req: AutomationRequest, personId: string | null, decision: AutomationDecision): Promise<void> {
    await appendEvent(
      this.journal,
      {
        type: AUTOMATION_JOURNAL_TYPE,
        actor: 'intake:site_auto',
        subject: personId === null ? null : `person:${personId}`,
        data: { mode: 'essai', sent: false, automation: req.automation, status: decision.status, rule: decision.rule, code: decision.code, stage: decision.stage, decides: decision.decides, mention_missing: decision.mentionMissing },
      },
      this.now,
    );
  }
}
