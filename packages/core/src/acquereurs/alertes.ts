/**
 * Les alertes aux acquéreurs (M08, T03), en mode essai : quand un bien devient diffusable [R42], une alerte aux
 * acquéreurs rapprochés (T02) qui l'ont demandée, avec un lien de désinscription [R49]. Tout passe par le contrôle
 * central : exclusions, arrêt, horaires, accord [R01 à R04], jamais deux fois le même bien à la même personne, tous
 * canaux confondus [R05], vocabulaire et chiffres [R07, R10]. Les messages vont dans la boîte d'essai, jamais dehors.
 *
 * L'IA, derrière une interface, rédige à partir des seules données du bien et des critères remplis : ni nom, ni
 * coordonnée, ni adresse [R15]. Absente, en panne ou refusée : le texte de secours du code.
 *
 * Décidé, lecture prudente : seuls les acquéreurs qui remplissent tous les critères reçoivent une alerte, pas ceux dans
 * les tolérances ; le canal est le premier, dans l'ordre mail, Instagram, Facebook, SMS, où la personne a donné son
 * accord pour les alertes ; un refus autre que l'heure est définitif pour ce bien ; WhatsApp par le téléphone de
 * l'agent vient avec T09.
 */
import { Acces } from '../acces/acces.ts';
import { trialChannels } from '../captation/essai.ts';
import { FicheClient } from '../db/fiche-client.ts';
import type { SqlDatabase } from '../db/sql.ts';
import type { OutboundChannelName } from '../db/types.ts';
import { Diffusion } from '../documents/retractation.ts';
import { ControleEnvois } from '../envoi/controle.ts';
import { SqlSendJournal } from '../envoi/journal-envois.ts';
import { DecisionEnvoi } from '../envoi/service.ts';
import type { OutboundChannel } from '../envoi/canaux.ts';
import { FicheUnique } from '../fiche/fusion.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import type { ScheduledJob } from '../bascule/planificateur.ts';
import type { BuyerFeature } from './fiche-acquereur.ts';
import { Rapprochement, type DiffusionGate, type MatchProperty } from './rapprochement.ts';

/** La finalité de l'accord des alertes [R03, R49]. */
export const ALERT_PURPOSE = 'alertes_biens';
/** Les canaux d'une alerte, dans l'ordre de préférence. */
export const ALERT_CHANNELS: readonly OutboundChannelName[] = ['email', 'instagram', 'facebook', 'sms'];

/** Ce que l'IA reçoit : le bien, sans adresse ni vendeur, et les critères remplis. Aucun nom, aucune coordonnée [R15]. */
export interface AlertBrief {
  channel: OutboundChannelName;
  property: { kind: string; city: string | null; priceEur: number | null; surfaceM2: number | null; rooms: number | null; bedrooms: number | null; features: BuyerFeature[] };
}

export interface AlertWriter {
  /** Le corps de l'alerte, sans salutation ni lien : le code les place. */
  write(brief: AlertBrief): Promise<string>;
}

export interface AlertOutcome {
  propertyId: string;
  personId: string;
  status: 'sent' | 'refused' | 'waiting' | 'failed' | 'no_consent' | 'done';
  rule: string | null;
}

export interface AlertesOptions {
  writer?: AlertWriter;
  /** La porte de diffusion ; absente : celle de D05. */
  diffusion?: DiffusionGate;
  /** Les canaux ; absents : ceux du mode essai, rien ne part [R26]. */
  channels?: readonly OutboundChannel[];
  /**
   * Le début du lien de désinscription, en https, sans chiffre, terminé par `/` ; le jeton s'y ajoute. Absent : aucune
   * alerte ne part, faute de désinscription possible [R49].
   */
  unsubscribeBase?: string | null;
  now?: () => Date;
}

const placeholders = (n: number): string => Array.from({ length: n }, () => '?').join(', ');
const KIND_LABEL: Record<string, string> = {
  home: 'logement',
  land: 'terrain',
  building: 'immeuble',
  commercial: 'local professionnel',
  business_walls: 'murs commerciaux',
  business: 'fonds de commerce',
};
const FEATURE_LABEL: Record<BuyerFeature, string> = {
  garden: 'un jardin',
  balcony: 'un balcon',
  terrace: 'une terrasse',
  garage: 'un garage',
  parking: 'un stationnement',
  cellar: 'une cave',
  elevator: 'un ascenseur',
  pool: 'une piscine',
  single_storey: 'de plain-pied',
  quiet: 'au calme',
  bright: 'lumineux',
  view: 'avec vue',
  fireplace: 'une cheminée',
  outbuilding: 'une dépendance',
};

const eur = (n: number): string => `${new Intl.NumberFormat('fr-FR').format(n).replace(/ | /g, ' ')} €`;

/** Le texte de secours, fait par le code depuis le bien seul : vouvoiement, prénom, aucun chiffre inventé [R08, R10]. */
export function alertFallbackText(firstName: string | null, p: AlertBrief['property'], channel: OutboundChannelName = 'email', byAgent = false): string {
  const facts = [
    `${KIND_LABEL[p.kind] ?? 'bien'}${p.city ? ` à ${p.city}` : ''}`,
    ...(p.surfaceM2 !== null ? [`${String(p.surfaceM2).replace('.', ',')} m²`] : []),
    ...(p.rooms !== null ? [`${p.rooms} pièces`] : []),
    ...(p.bedrooms !== null ? [`${p.bedrooms} chambres`] : []),
    ...(p.priceEur !== null ? [eur(p.priceEur)] : []),
  ];
  const extras = p.features.map((f) => FEATURE_LABEL[f]);
  const hello = firstName ? `Bonjour ${firstName},` : 'Bonjour,';
  const what = `${facts.join(', ')}${extras.length > 0 ? `, avec ${extras.join(', ')}` : ''}`;
  // Tutoiement sur Instagram, vouvoiement ailleurs [R08].
  if (channel === 'instagram') return `${hello} un bien correspond à ta recherche : ${what}. Ton agent immobilier t’en dit plus sur simple réponse.`;
  // Écrit par l'agent lui-même, de son téléphone (T09) : il parle en son nom.
  if (byAgent) return `${hello} un bien correspond à votre recherche : ${what}. Dites-moi si vous souhaitez le visiter.`;
  return `${hello} un bien correspond à votre recherche : ${what}. Votre agent immobilier vous en dit plus sur simple réponse.`;
}

const LETTERS = 'abcdefghijklmnopqrstuvwxyz';
const TOKEN_FIRST_LETTERS = 'bdefhjklmnopqstuvwxyz';
/**
 * Un jeton de lettres seules : aucun chiffre dans le texte qui ne vienne de la base [R10] ; sa première lettre, qui
 * suit « / », n'est jamais a, c, g, i ni r, pour qu'il ne commence jamais comme une mention de l'IA [R06].
 */
export function newAlertToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return [...bytes].map((b, i) => (i === 0 ? TOKEN_FIRST_LETTERS[b % TOKEN_FIRST_LETTERS.length] : LETTERS[b % 26])).join('');
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Un lien de désinscription neuf pour la personne, rangé par l'empreinte de son jeton seulement, et la ligne à placer
 * à la fin d'une alerte [R49].
 */
export async function newUnsubscribeLine(db: SqlDatabase, networkId: string, personId: string, base: string, at: Date): Promise<string> {
  const token = newAlertToken();
  await db.run('INSERT INTO alert_unsubscribe_tokens (token_hash, network_id, person_id, created_at, used_at) VALUES (?, ?, ?, ?, NULL)', [
    await sha256(token),
    networkId,
    personId,
    at.toISOString(),
  ]);
  return `Ne plus recevoir ces alertes : ${base}${token}`;
}

/** Le début du lien de désinscription est en https, sans chiffre [R10], terminé par « / ». */
export function checkUnsubscribeBase(base: string | null): string | null {
  if (base !== null && !/^https:\/\/[^\s\d]+\/$/.test(base)) {
    throw new Error('Le lien de désinscription est en https, sans chiffre [R10], terminé par « / ».');
  }
  return base;
}

export class Alertes {
  private readonly now: () => Date;
  private readonly store: FicheClient;
  private readonly fiche: FicheUnique;
  private readonly controle: ControleEnvois;
  private readonly rapprochement: Rapprochement;
  private readonly unsubscribeBase: string | null;
  private readonly gate: DiffusionGate;

  constructor(
    private readonly db: SqlDatabase,
    private readonly journal: JournalStore,
    private readonly options: AlertesOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.store = new FicheClient(db, { now: this.now });
    this.fiche = new FicheUnique(db, this.store, { now: this.now });
    const decisions = new DecisionEnvoi(db, this.store, this.fiche, { now: this.now });
    this.controle = new ControleEnvois(db, this.fiche, decisions, {
      channels: options.channels ?? trialChannels(db, journal, this.now),
      journal: new SqlSendJournal(db, undefined, this.now),
      now: this.now,
    });
    const gate = (this.gate = options.diffusion ?? new Diffusion(db, new Acces(db, this.store, this.fiche, journal, { now: this.now }), journal, { now: this.now }));
    this.rapprochement = new Rapprochement(db, this.fiche, gate, journal, { now: this.now });
    this.unsubscribeBase = checkUnsubscribeBase(options.unsubscribeBase ?? null);
  }

  /** Un passage : chaque bien en vente du réseau, chaque acquéreur qui en remplit tous les critères. */
  async run(): Promise<AlertOutcome[]> {
    if (this.unsubscribeBase === null) {
      // Sans lien de désinscription, aucune alerte : la tâche le dit au journal, sans donnée [R49].
      await appendEvent(this.journal, { type: 'alerte.sans_lien', actor: 'system:alertes', subject: null, data: { rule: 'R49' } }, this.now);
      return [];
    }
    const properties = await this.db.all<{ id: string; network_id: string }>(
      "SELECT id, network_id FROM properties WHERE status = 'available' ORDER BY created_at, id",
    );
    const outcomes: AlertOutcome[] = [];
    for (const p of properties) outcomes.push(...(await this.forProperty(p.network_id, p.id)));
    return outcomes;
  }

  /** Les alertes d'un bien : rien si la diffusion le refuse [R42]. */
  async forProperty(networkId: string, propertyId: string): Promise<AlertOutcome[]> {
    if (this.unsubscribeBase === null) return [];
    const matches = (await this.rapprochement.systemMatches(networkId, propertyId)).filter((m) => m.status === 'match');
    const outcomes: AlertOutcome[] = [];
    for (const m of matches) outcomes.push(await this.alertOne(networkId, propertyId, m.personId, m.projectId, m.agentId, m.property));
    return outcomes;
  }

  /**
   * Retire l'accord des alertes de la personne du jeton, sur tous les canaux, fiches réunies comprises [R49]. Rend
   * vrai si le jeton est connu ; un jeton servi de nouveau ne change rien.
   */
  async unsubscribe(token: string): Promise<boolean> {
    if (!/^[a-z]{32}$/.test(token)) return false;
    const row = await this.db.first<{ token_hash: string; person_id: string; network_id: string }>(
      'SELECT token_hash, person_id, network_id FROM alert_unsubscribe_tokens WHERE token_hash = ?',
      [await sha256(token)],
    );
    if (!row) return false;
    const at = this.now();
    const ids = await this.fiche.membersOf(row.person_id);
    const consents = await this.db.all<{ id: string }>(
      `SELECT id FROM consents WHERE person_id IN (${placeholders(ids.length)}) AND purpose = ? AND withdrawn_at IS NULL`,
      [...ids, ALERT_PURPOSE],
    );
    for (const c of consents) await this.store.withdrawConsent(c.id, at);
    await this.db.run('UPDATE alert_unsubscribe_tokens SET used_at = ? WHERE token_hash = ? AND used_at IS NULL', [at.toISOString(), row.token_hash]);
    await appendEvent(
      this.journal,
      { type: 'alerte.desinscription', actor: 'system:alertes', subject: `person:${row.person_id}`, data: { rule: 'R49', withdrawn: consents.length } },
      this.now,
    );
    return true;
  }

  private async alertOne(
    networkId: string,
    propertyId: string,
    personId: string,
    projectId: string,
    agentId: string | null,
    property: MatchProperty,
  ): Promise<AlertOutcome> {
    const at = this.now();
    const iso = at.toISOString();
    const known = await this.db.first<{ status: string }>('SELECT status FROM property_alerts WHERE property_id = ? AND person_id = ?', [propertyId, personId]);
    if (known && known.status !== 'waiting' && known.status !== 'failed') return { propertyId, personId, status: 'done', rule: null };

    // L'accord des alertes, en cours, sur un canal [R49] : sinon rien, et la personne sera revue au passage suivant.
    const ids = await this.fiche.membersOf(personId);
    const consents = await this.db.all<{ channel: OutboundChannelName }>(
      `SELECT channel FROM consents WHERE person_id IN (${placeholders(ids.length)}) AND purpose = ? AND given_at <= ? AND (withdrawn_at IS NULL OR withdrawn_at > ?)`,
      [...ids, ALERT_PURPOSE, iso, iso],
    );
    const channels = ALERT_CHANNELS.filter((c) => consents.some((k) => k.channel === c));
    const channel = channels[0];
    if (!channel) return { propertyId, personId, status: 'no_consent', rule: 'R49' };

    // Réservation : de deux passages simultanés, un seul envoie.
    const { changes } = known
      ? await this.db.run(
          `UPDATE property_alerts SET status = 'pending', channel = ?, updated_at = ? WHERE property_id = ? AND person_id = ? AND status IN ('waiting', 'failed')`,
          [channel, iso, propertyId, personId],
        )
      : await this.db.run(
          `INSERT INTO property_alerts (property_id, person_id, network_id, project_id, channel, status, rule, message_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'pending', NULL, NULL, ?, ?) ON CONFLICT DO NOTHING`,
          [propertyId, personId, networkId, projectId, channel, iso, iso],
        );
    if (changes !== 1) return { propertyId, personId, status: 'done', rule: null };

    let status: AlertOutcome['status'];
    let rule: string | null;
    let messageId: string | null = null;
    let usedChannel: OutboundChannelName = channel;
    try {
      const link = await newUnsubscribeLine(this.db, networkId, personId, this.unsubscribeBase ?? '', at);
      const names = await this.db.all<{ first_name: string | null }>(`SELECT first_name FROM persons WHERE id IN (${placeholders(ids.length)})`, ids);
      const firstName = names.map((n) => n.first_name).find((n) => n) ?? null;
      const writer = this.options.writer;
      // Le lien est placé par le code, jamais par l'IA [R49].
      const withLink = (text: string): string => `${text.trim()}\n\n${link}`;
      status = 'refused';
      rule = null;
      // Chaque canal accordé, dans l'ordre : un refus qui tient au canal (fenêtre de Meta, accord du canal, pas de
      // coordonnée) laisse essayer le suivant ; un refus qui tient à la personne, au bien ou à l'heure arrête là.
      for (const via of channels) {
        const brief: AlertBrief = {
          channel: via,
          property: {
            kind: property.kind,
            city: property.city,
            priceEur: property.priceEur,
            surfaceM2: property.surfaceM2,
            rooms: property.rooms,
            bedrooms: property.bedrooms,
            features: property.features,
          },
        };
        const result = await this.controle.send({
          networkId,
          agentId,
          personId,
          projectId,
          channel: via,
          kind: 'alert',
          purpose: ALERT_PURPOSE,
          // L'accord des alertes est revérifié après la rédaction, sur tout canal : une désinscription l'emporte [R49].
          consentOnEveryChannel: true,
          // Le bien doit pouvoir être diffusé encore au moment d'envoyer, après la rédaction [R42].
          stillAllowed: async () => {
            const d = await this.gate.canDiffuse(networkId, propertyId, this.now());
            return { allowed: d.allowed, rule: 'R42', reason: d.allowed ? 'Bien diffusable.' : 'Le bien ne peut plus être diffusé.' };
          },
          propertyIds: [propertyId],
          // L'IA écrit le corps, sans salutation : le prénom, qu'elle ne reçoit pas, est placé par le code [R08, R15].
          ...(writer ? { compose: async () => withLink(`${firstName ? `Bonjour ${firstName},` : 'Bonjour,'} ${(await writer.write(brief)).trim()}`) } : {}),
          fallbackTexts: [withLink(alertFallbackText(firstName, brief.property, via))],
          figures: [property.priceEur, property.surfaceM2, property.rooms, property.bedrooms].filter((n): n is number => n !== null),
        });
        messageId = result.messageId;
        rule = result.status === 'sent' ? null : result.rule;
        // Refusée pour l'heure [R01] ou parce que le bien ne peut plus être diffusé [R42] : reprise si cela change.
        status = result.status === 'sent' ? 'sent' : result.status === 'failed' ? 'failed' : result.rule === 'R01' || result.rule === 'R42' ? 'waiting' : 'refused';
        usedChannel = via;
        const channelBound = result.status === 'refused' && (result.rule === 'R22' || result.rule === 'R03' || result.rule === null);
        if (!channelBound) break;
      }
    } catch (error) {
      // Une panne avant l'envoi ne perd pas l'alerte : elle repart au passage suivant ; le contrôle central garde
      // l'anti-doublon du bien [R05].
      await this.db.run(`UPDATE property_alerts SET status = 'failed', updated_at = ? WHERE property_id = ? AND person_id = ? AND status = 'pending'`, [
        this.now().toISOString(),
        propertyId,
        personId,
      ]);
      throw error;
    }
    await this.db.run('UPDATE property_alerts SET status = ?, rule = ?, message_id = ?, channel = ?, updated_at = ? WHERE property_id = ? AND person_id = ?', [
      status,
      rule,
      messageId,
      usedChannel,
      this.now().toISOString(),
      propertyId,
      personId,
    ]);
    await appendEvent(
      this.journal,
      {
        type: 'alerte.essai',
        actor: 'system:alertes',
        subject: `person:${personId}`,
        data: { mode: 'essai', sent: false, property: propertyId, status, rule },
      },
      this.now,
    );
    return { propertyId, personId, status, rule };
  }
}

export const ALERTS_JOB = 'acquereurs.alertes';

/** La tâche du planificateur : les alertes, du lundi au samedi, de 9 h à 19 h, par les canaux du mode essai [R01]. */
export function alertsJob(db: SqlDatabase, journal: JournalStore, options: Omit<AlertesOptions, 'channels'> = {}): ScheduledJob {
  return {
    name: ALERTS_JOB,
    hours: [9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19],
    weekdays: [1, 2, 3, 4, 5, 6],
    run: async () => {
      await new Alertes(db, journal, options).run();
    },
  };
}
