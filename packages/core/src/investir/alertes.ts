/**
 * Les alertes aux investisseurs (M17, Y06), en mode essai : quand un bien diffusable du fichier commun correspond au
 * profil d'un investisseur (secteur, budget, location visée, rendement brut attendu calculé par le code de Y03), un
 * texte d'alerte est préparé pour les seuls investisseurs dont l'accord aux alertes est rangé [R03], avec le calcul et
 * ses contraintes. Il passe par le contrôle central des envois : exclusions, horaires, accord, jamais deux fois le même
 * bien à la même personne [R05], chiffres [R10] ; rien ne part réellement, les messages vont dans la boîte d'essai
 * [R26].
 *
 * Un bien interdit à la location (classe G, ou au-delà de 450 kWh/m²/an) porte l'alerte en tête, et n'est jamais
 * proposé sans elle à un investisseur qui veut louer : la porte de Y04 est passée à la préparation et revérifiée au
 * moment de l'envoi, contraintes recalculées [R124]. Le texte, écrit par le code, passe la liste des tournures
 * interdites et renvoie aux professionnels [R125].
 *
 * Décidé, lecture prudente : un profil sans secteur ni budget ne reçoit rien ; un rendement attendu qu'on ne peut pas
 * calculer (loyer de marché inconnu, barème des frais non réglé, bien sans prix ni surface) ne laisse rien partir ; la
 * commune et le type de logement d'un bien sont dits par son agent, jamais devinés.
 */
import { Acces } from '../acces/acces.ts';
import type { Viewer } from '../acces/droits.ts';
import { ALERT_CHANNELS, ALERT_PURPOSE, checkUnsubscribeBase, newUnsubscribeLine } from '../acquereurs/alertes.ts';
import type { DiffusionGate } from '../acquereurs/rapprochement.ts';
import { trialChannels } from '../captation/essai.ts';
import { FicheClient } from '../db/fiche-client.ts';
import type { SqlDatabase } from '../db/sql.ts';
import type { OutboundChannelName } from '../db/types.ts';
import { Diffusion } from '../documents/retractation.ts';
import type { OutboundChannel } from '../envoi/canaux.ts';
import { ControleEnvois } from '../envoi/controle.ts';
import { SqlSendJournal } from '../envoi/journal-envois.ts';
import { DecisionEnvoi } from '../envoi/service.ts';
import { FicheUnique } from '../fiche/fusion.ts';
import { ficheFirstName } from '../fiche/prenom.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import { computeYield, type Sourced } from './calcul.ts';
import { Contraintes, energyAlertGate, type ConstraintSet } from './contraintes.ts';
import { LoyersMarche, MARKET_RENT_KINDS, type MarketRentKind } from './loyers.ts';
import { PROFESSIONAL_REFERRAL, forbiddenPhrases, formatLine } from './note.ts';
import { ProfilInvestisseur, type InvestorProfileVersion } from './profil.ts';

const INSEE = /^(?:\d{5}|2[AB]\d{3})$/;
const placeholders = (n: number): string => Array.from({ length: n }, () => '?').join(', ');

export interface InvestorAlertOutcome {
  propertyId: string;
  personId: string;
  status: 'sent' | 'refused' | 'waiting' | 'failed' | 'no_consent' | 'done' | 'no_match';
  rule: string | null;
}

export interface AlertesInvestisseursOptions {
  /** Le taux du barème des frais d'acquisition réglé par la direction ; absent : aucun rendement, aucune alerte de rendement. */
  feesRateBp?: Sourced<number> | null;
  diffusion?: DiffusionGate;
  /** Les canaux ; absents : ceux du mode essai, rien ne part [R26]. */
  channels?: readonly OutboundChannel[];
  unsubscribeBase?: string | null;
  now?: () => Date;
}

interface PropertyRow {
  id: string;
  network_id: string;
  kind: string;
  city: string | null;
  price_eur: number | null;
  surface_m2: number | null;
  insee_code: string;
  rent_kind: MarketRentKind;
}

/** Ce que le calcul rend pour une alerte : le rendement brut et sa fourchette, avec la source du loyer. */
export interface AlertYield {
  grossBp: number;
  lowBp: number;
  highBp: number;
  rentCitation: string;
  fewObservations: boolean;
}

const KIND_LABEL: Record<string, string> = { home: 'logement', building: 'immeuble', commercial: 'local professionnel', business_walls: 'murs commerciaux', land: 'terrain', business: 'fonds de commerce' };

export class AlertesInvestisseurs {
  private readonly now: () => Date;
  private readonly store: FicheClient;
  private readonly fiche: FicheUnique;
  private readonly controle: ControleEnvois;
  private readonly gate: DiffusionGate;
  private readonly unsubscribeBase: string | null;
  private readonly profils: ProfilInvestisseur;
  private readonly loyers: LoyersMarche;
  private readonly contraintes: Contraintes;

  constructor(
    private readonly db: SqlDatabase,
    private readonly journal: JournalStore,
    private readonly options: AlertesInvestisseursOptions = {},
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
    this.gate = options.diffusion ?? new Diffusion(db, new Acces(db, this.store, this.fiche, journal, { now: this.now }), journal, { now: this.now });
    this.unsubscribeBase = checkUnsubscribeBase(options.unsubscribeBase ?? null);
    this.profils = new ProfilInvestisseur(db, journal, { now: this.now });
    this.loyers = new LoyersMarche(db, journal, { now: this.now });
    this.contraintes = new Contraintes(db, journal, { now: this.now });
  }

  /** L'agent du bien, ou la direction, dit sa commune et son type de logement ; une fois, sans retour [R16, R17]. */
  async recordPropertyCommune(acces: Acces, viewer: Viewer, propertyId: string, input: { inseeCode: unknown; rentKind: unknown }): Promise<{ ok: true } | { ok: false; rule: 'R16' | 'R122'; code: string }> {
    if (viewer.role !== 'agent' && viewer.role !== 'direction') return { ok: false, rule: 'R16', code: 'role' };
    const read = await acces.readProperty(viewer, propertyId);
    if (!read.ok) return { ok: false, rule: 'R16', code: read.code };
    if (viewer.role === 'agent' && read.view !== 'full') return { ok: false, rule: 'R16', code: 'not_assigned' };
    if (typeof input.inseeCode !== 'string' || !INSEE.test(input.inseeCode)) return { ok: false, rule: 'R122', code: 'insee' };
    if (typeof input.rentKind !== 'string' || !(MARKET_RENT_KINDS as readonly string[]).includes(input.rentKind)) return { ok: false, rule: 'R122', code: 'type' };
    const { changes } = await this.db.run(
      'INSERT INTO property_communes (property_id, network_id, insee_code, rent_kind, recorded_by, recorded_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING',
      [propertyId, viewer.networkId, input.inseeCode, input.rentKind, `${viewer.role}:${viewer.userId}`, this.now().toISOString()],
    );
    if (changes !== 1) return { ok: false, rule: 'R122', code: 'deja_rangee' };
    await appendEvent(this.journal, { type: 'investir.commune_bien', actor: `${viewer.role}:${viewer.userId}`, subject: `property:${propertyId}`, data: { insee: input.inseeCode } }, this.now);
    return { ok: true };
  }

  /** Un passage : chaque bien en vente du réseau, chaque investisseur dont le profil y correspond. */
  async run(): Promise<InvestorAlertOutcome[]> {
    if (this.unsubscribeBase === null) {
      await appendEvent(this.journal, { type: 'investir.alerte.sans_lien', actor: 'system:investir', subject: null, data: { rule: 'R49' } }, this.now);
      return [];
    }
    const properties = await this.db.all<{ id: string; network_id: string }>("SELECT id, network_id FROM properties WHERE status = 'available' ORDER BY created_at, id");
    const out: InvestorAlertOutcome[] = [];
    for (const p of properties) out.push(...(await this.forProperty(p.network_id, p.id)));
    return out;
  }

  /** Les alertes d'un bien : rien si la diffusion le refuse, ni sans sa commune [R42]. */
  async forProperty(networkId: string, propertyId: string): Promise<InvestorAlertOutcome[]> {
    if (this.unsubscribeBase === null) return [];
    const property = await this.db.first<PropertyRow>(
      `SELECT p.id, p.network_id, p.kind, p.city, p.price_eur, p.surface_m2, c.insee_code, c.rent_kind
         FROM properties p JOIN property_communes c ON c.property_id = p.id AND c.network_id = p.network_id
        WHERE p.id = ? AND p.network_id = ? AND p.status = 'available'`,
      [propertyId, networkId],
    );
    if (!property || property.price_eur === null || property.price_eur <= 0) return [];
    if (!(await this.gate.canDiffuse(networkId, propertyId, this.now())).allowed) return [];
    const projects = await this.db.all<{ id: string; person_id: string; agent_id: string | null }>(
      "SELECT id, person_id, agent_id FROM projects WHERE network_id = ? AND kind = 'invest' ORDER BY created_at, id",
      [networkId],
    );
    const yieldOf = await this.alertYield(property);
    const out: InvestorAlertOutcome[] = [];
    for (const project of projects) {
      const profile = await this.profils.current(project.id);
      if (!profile || !matches(profile, property, yieldOf)) continue;
      out.push(await this.alertOne(property, project, profile, yieldOf));
    }
    return out;
  }

  /** Le rendement brut du bien par les formules de Y03 : prix et surface du bien, loyer de la base, barème réglé. */
  async alertYield(property: Pick<PropertyRow, 'network_id' | 'id' | 'price_eur' | 'surface_m2' | 'insee_code' | 'rent_kind'>): Promise<AlertYield | null> {
    const fees = this.options.feesRateBp ?? null;
    if (fees === null || property.price_eur === null || property.surface_m2 === null || property.surface_m2 <= 0) return null;
    const rent = await this.loyers.marketRent(property.network_id, property.insee_code, property.rent_kind);
    if (rent.status !== 'connu') return null;
    const today = this.now().toISOString().slice(0, 10);
    const given = (value: number, source: string, hypothesis: string): Sourced<number> => ({ value, source, asOf: today, hypothesis });
    // Le rendement brut ne dépend ni des charges, ni de la taxe, ni de la vacance : seules ses lignes sont lues.
    const r = computeYield(
      {
        price: given(property.price_eur * 100, `bien:${property.id}`, 'prix affiché du bien'),
        acquisitionFeesRateBp: fees,
        works: given(0, 'alerte', 'sans travaux estimés'),
        livingArea: given(Math.round(property.surface_m2 * 100), `bien:${property.id}`, 'surface du bien'),
        marketRent: {
          value: { centralM2Cents: rent.rentM2Cents, lowerM2Cents: rent.lowerM2Cents, upperM2Cents: rent.upperM2Cents },
          source: rent.citation,
          asOf: rent.asOf.slice(0, 10),
          hypothesis: 'loyer central',
        },
        nonRecoverableCharges: given(0, 'alerte', 'non lu pour le brut'),
        propertyTax: given(0, 'alerte', 'non lu pour le brut'),
        vacancyMonths: given(0, 'alerte', 'non lu pour le brut'),
      },
      this.now().toISOString(),
    );
    if (r.status !== 'complet') return null;
    return { grossBp: r.grossYieldBp.central, lowBp: r.grossYieldBp.low, highBp: r.grossYieldBp.high, rentCitation: rent.citation, fewObservations: rent.reliability === 'peu_observations' };
  }

  private async constraintsOf(property: PropertyRow, profile: InvestorProfileVersion): Promise<ConstraintSet> {
    return this.contraintes.forProperty({
      networkId: property.network_id,
      propertyId: property.id,
      inseeCode: property.insee_code,
      rentalTarget: profile.profile.rentalTarget,
    });
  }

  private async alertOne(
    property: PropertyRow,
    project: { id: string; person_id: string; agent_id: string | null },
    profile: InvestorProfileVersion,
    yieldOf: AlertYield | null,
  ): Promise<InvestorAlertOutcome> {
    const personId = project.person_id;
    const at = this.now();
    const iso = at.toISOString();
    const known = await this.db.first<{ status: string }>('SELECT status FROM investor_alerts WHERE property_id = ? AND person_id = ?', [property.id, personId]);
    if (known && known.status !== 'waiting' && known.status !== 'failed') return { propertyId: property.id, personId, status: 'done', rule: null };

    // L'accord des alertes, en cours, sur un canal [R03] : sinon rien.
    const ids = await this.fiche.membersOf(personId);
    const consents = await this.db.all<{ channel: OutboundChannelName }>(
      `SELECT channel FROM consents WHERE person_id IN (${placeholders(ids.length)}) AND purpose = ? AND given_at <= ? AND (withdrawn_at IS NULL OR withdrawn_at > ?)`,
      [...ids, ALERT_PURPOSE, iso, iso],
    );
    const channels = ALERT_CHANNELS.filter((c) => consents.some((k) => k.channel === c));
    if (channels.length === 0) return { propertyId: property.id, personId, status: 'no_consent', rule: 'R03' };

    const constraints = await this.constraintsOf(property, profile);
    const firstName = await ficheFirstName(this.db, ids);
    const body = investorAlertText(firstName, property, constraints, yieldOf);
    // La porte de R124 et la liste des tournures, avant toute réservation.
    const gate = energyAlertGate(constraints, body.replace(/^Bonjour[^,]*,\s*/, ''));
    if (!gate.ok) return { propertyId: property.id, personId, status: 'refused', rule: 'R124' };
    if (forbiddenPhrases(body).length > 0) return { propertyId: property.id, personId, status: 'refused', rule: 'R125' };

    const { changes } = known
      ? await this.db.run(
          "UPDATE investor_alerts SET status = 'pending', updated_at = ? WHERE property_id = ? AND person_id = ? AND status IN ('waiting', 'failed')",
          [iso, property.id, personId],
        )
      : await this.db.run(
          `INSERT INTO investor_alerts (property_id, person_id, network_id, project_id, channel, status, rule, message_id, gross_yield_bp, created_at, updated_at)
           VALUES (?, ?, ?, ?, NULL, 'pending', NULL, NULL, ?, ?, ?) ON CONFLICT DO NOTHING`,
          [property.id, personId, property.network_id, project.id, yieldOf?.grossBp ?? null, iso, iso],
        );
    if (changes !== 1) return { propertyId: property.id, personId, status: 'done', rule: null };

    let status: InvestorAlertOutcome['status'] = 'refused';
    let rule: string | null = null;
    let messageId: string | null = null;
    let used: OutboundChannelName | null = null;
    try {
      const link = await newUnsubscribeLine(this.db, property.network_id, personId, this.unsubscribeBase ?? '', at);
      const text = `${body}\n\n${link}`;
      for (const via of channels) {
        const result = await this.controle.send({
          networkId: property.network_id,
          agentId: project.agent_id,
          personId,
          projectId: project.id,
          channel: via,
          kind: 'alert',
          purpose: ALERT_PURPOSE,
          consentOnEveryChannel: true,
          // Au moment d'envoyer : le bien encore diffusable, et l'alerte d'énergie encore en tête, contraintes et profil
          // relus [R42, R124].
          stillAllowed: async () => {
            const d = await this.gate.canDiffuse(property.network_id, property.id, this.now());
            if (!d.allowed) return { allowed: false, rule: 'R42', reason: 'Le bien ne peut plus être diffusé.' };
            const fresh = await this.profils.current(project.id);
            if (!fresh) return { allowed: false, rule: 'R124', reason: 'Le profil a disparu.' };
            const again = await this.constraintsOf(property, fresh);
            const ok = energyAlertGate(again, body.replace(/^Bonjour[^,]*,\s*/, '')).ok;
            return { allowed: ok, rule: 'R124', reason: ok ? 'Alerte d’énergie en tête.' : 'L’alerte d’énergie manque en tête.' };
          },
          propertyIds: [property.id],
          fallbackTexts: [text],
          figures: [text],
        });
        messageId = result.messageId;
        rule = result.status === 'sent' ? null : result.rule;
        status = result.status === 'sent' ? 'sent' : result.status === 'failed' ? 'failed' : result.rule === 'R01' || result.rule === 'R42' ? 'waiting' : 'refused';
        used = via;
        const channelBound = result.status === 'refused' && (result.rule === 'R22' || result.rule === 'R03' || result.rule === null);
        if (!channelBound) break;
      }
    } catch (error) {
      await this.db.run("UPDATE investor_alerts SET status = 'failed', updated_at = ? WHERE property_id = ? AND person_id = ? AND status = 'pending'", [
        this.now().toISOString(),
        property.id,
        personId,
      ]);
      throw error;
    }
    await this.db.run('UPDATE investor_alerts SET status = ?, rule = ?, message_id = ?, channel = ?, updated_at = ? WHERE property_id = ? AND person_id = ?', [
      status,
      rule,
      messageId,
      used,
      this.now().toISOString(),
      property.id,
      personId,
    ]);
    await appendEvent(
      this.journal,
      { type: 'investir.alerte.essai', actor: 'system:investir', subject: `person:${personId}`, data: { mode: 'essai', sent: false, property: property.id, status, rule } },
      this.now,
    );
    return { propertyId: property.id, personId, status, rule };
  }
}

/** Le profil correspond au bien : secteur, budget, location visée, rendement brut attendu ; rien d'inconnu ne passe. */
export function matches(profile: InvestorProfileVersion, property: Pick<PropertyRow, 'insee_code' | 'price_eur'>, yieldOf: AlertYield | null): boolean {
  const p = profile.profile;
  if (p.sectors.length === 0 || !p.sectors.includes(property.insee_code)) return false;
  if (p.budgetCents === null || property.price_eur === null || property.price_eur * 100 > p.budgetCents) return false;
  if (p.targetGrossYieldBp !== null && (yieldOf === null || yieldOf.grossBp < p.targetGrossYieldBp)) return false;
  return true;
}

const pct = (bp: number): string => formatLine({ key: 'x', value: bp, unit: 'bp', source: '', asOf: '', hypothesis: '' });
const eur = (cents: number): string => formatLine({ key: 'x', value: cents, unit: 'cents', source: '', asOf: '', hypothesis: '' });

/** Le texte de l'alerte, écrit par le code, sans parenthèses [R08] : l'alerte d'énergie en tête, le calcul, les contraintes, le renvoi. */
export function investorAlertText(firstName: string | null, property: Pick<PropertyRow, 'kind' | 'city' | 'price_eur' | 'surface_m2'>, constraints: ConstraintSet, y: AlertYield | null): string {
  const hello = firstName ? `Bonjour ${firstName},` : 'Bonjour,';
  const what = `${KIND_LABEL[property.kind] ?? 'bien'}${property.city ? ` à ${property.city}` : ''}`;
  const facts = [property.price_eur !== null ? eur(property.price_eur * 100) : null, property.surface_m2 !== null ? `${property.surface_m2} m²` : null].filter(Boolean).join(', ');
  const lines = [
    hello,
    ...constraints.alertsFirst,
    `Un ${what} correspond à votre projet d’investissement${facts ? ` : ${facts}` : ''}.`,
    ...(y
      ? [
          `Rendement brut estimé avant frais de gestion et impôts : ${pct(y.grossBp)}, de ${pct(y.lowBp)} à ${pct(y.highBp)} selon le loyer de marché bas ou haut, sans travaux, avec le loyer de marché de la commune. Source du loyer : ${y.rentCitation}.${y.fewObservations ? ' Peu d’observations : ce loyer est moins sûr.' : ''}`,
        ]
      : []),
    ...constraints.constraints.filter((c) => !constraints.alertsFirst.includes(c.text)).map((c) => c.text),
    PROFESSIONAL_REFERRAL,
    'Votre agent immobilier vous envoie le détail du calcul sur simple réponse.',
  ];
  return lines.join('\n\n');
}
