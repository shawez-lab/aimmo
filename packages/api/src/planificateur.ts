import { Acces, DecisionEnvoi, Diffusion, investir, FicheClient, reseau, location, FicheUnique, Planificateur, SITE_JOBS_TRIAL, SqlJournalStore, Visites, alertsJob, onSaleDatesJob, visitReportsJob, weeklyPointJob, appointmentBriefJob, appointmentReminderJob, dailyPlanJob, legalBasisJob, mandateDeadlinesJob, valueTrackingJob, vendorFollowUpJob, type CommuneRanges, type ScheduledJob, type SqlDatabase, type TickResult, commerces, annonces } from '@aimmo/core';
import { TRIAL_MODE, journalError } from './app.ts';
import { offersDailyJob } from './offres.ts';
import { apresVenteBase, apresVenteJobs } from './apres-vente.ts';
import { pilotageJobs } from './pilotage.ts';
import { conformiteJobs } from './conformite.ts';
import { partenairesJobs } from './partenaires.ts';
import { gagnerJobs } from './gagner.ts';
import { dossiersJob, type PieceStore } from './dossiers.ts';
import { phase1ReadingJob } from './phases.ts';
import { postgresReadingJob } from './postgresql.ts';
import { sequencesJob } from './sequences.ts';
import { datesJob, scenariosJob } from './scenarios.ts';
import { marketingJobs } from './marketing-passage.ts';
import type { Geocoder, JournalStore, SalesSource } from '@aimmo/core';
import { PrixRegroupes, type PriceSalesSource } from '../../core/src/attirer/index.ts';
import { ControleGels, complaintsJob } from '../../core/src/securite/index.ts';
import { signPickupsJob } from '../../core/src/panneaux/index.ts';
import { dpeWatchJob, type DiagnosisFeed } from '../../core/src/veille-dpe/index.ts';
import { facturationJobs } from '../../core/src/facturation/index.ts';
import { Pige, pigeCollectJob, type PigeSource } from '../../core/src/pige/index.ts';

/** La pige ne lit que les cases déjà publiées des prix regroupés : jamais une source de ventes [R274]. */
const NO_SALES: PriceSalesSource = { coverage: async () => null, within: async () => [] };

export interface SchedulerConfig {
  db: SqlDatabase;
  /** Variable `MODE` : hors essai, rien ne passe. */
  mode: string | undefined;
  jobs?: readonly ScheduledJob[];
  /** AU068 · le lecteur réel des annonces en ligne (H10) ; absent, aucune relecture ne passe. */
  listingReader?: annonces.OnlineListingReader | null;
  /** Variable `RDV_LINK_BASE` : début du lien pour décaler ou annuler un rendez-vous ; absent, les rappels partent sans lien. */
  appointmentLinkBase?: string | undefined;
  /** La fourchette des communes (E05) pour le suivi de valeur ; absente, le suivi ne prépare aucun envoi. */
  communeRanges?: CommuneRanges | null;
  /** Variable `ALERT_UNSUBSCRIBE_BASE` : début du lien de désinscription des alertes ; absente, aucune alerte [R49]. */
  alertUnsubscribeBase?: string | undefined;
  /** Variable `APRES_VENTE_BASE` (`https://…/apres-vente/`) : liens de désinscription, de satisfaction et du carnet (F07). */
  apresVenteBase?: string | undefined;
  /** Les ventes publiques et le géocodeur, pour le carnet du propriétaire (F06) ; absents, aucun carnet. */
  soldSales?: SalesSource | null;
  geocoder?: Geocoder | null;
  /** Le stockage des pièces des dossiers (R2, `PIECES`) ; absent, le passage des dossiers ne tourne pas. */
  pieces?: PieceStore | null;
  /** Variable `PARTENAIRES_OPPOSITION_BASE` (`https://…/partenaires/opposition/`) : sans elle, la prospection ne prépare rien [R79]. */
  partnerOptOutBase?: string | undefined;
  /** Le barème des frais d'acquisition réglé par la direction (M17) ; absent, aucune alerte qui demande un rendement. */
  investorFeesRateBp?: investir.Sourced<number> | null;
  /** Variable `PLATFORM_NETWORK_ID` : le réseau qui exploite la plateforme, pour le rapport chronométré des seuils (BR25). */
  platformNetworkId?: string | undefined;
  /** La base ouverte des diagnostics de l'ADEME (HX16, BR26) ; absente, la veille ne lit rien. */
  dpeFeed?: DiagnosisFeed | null;
  /** Le stockage des fichiers du studio (`MEDIA`, X10) : sans lui, le passage du calendrier de publication ne tourne pas (BR112). */
  studioFiles?: { has(ref: string): Promise<boolean> } | null;
  /** Le lien de désinscription de la lettre, vérifié par `letterUnsubscribeBase` ; absent, aucune lettre ne part [R584]. */
  letterUnsubscribeBase?: string | null;
  /** AU034 : le vrai fournisseur de la pige et son réseau ; absent, la relève quotidienne ne lit rien [R671]. */
  pigeProvider?: { networkId: string; source: PigeSource } | null;
  now?: () => Date;
}

/**
 * Le passage horaire du déclencheur du Worker (B02). Lecture prudente : hors mode essai, aucune tâche ne passe.
 * Une erreur du planificateur lui-même est écrite au journal, jamais avalée [R13].
 */
export async function runScheduler(config: SchedulerConfig): Promise<TickResult | null> {
  if (config.mode !== TRIAL_MODE) return null;
  const now = config.now ?? (() => new Date());
  const journal = new SqlJournalStore(config.db);
  try {
    // Tâches du site notées sans appel ; relance des vendeurs (E06) et rappels des rendez-vous (V04), par les canaux
    // du mode essai ; briefs des rendez-vous (V05), rangés pour l'agent, sans aucun envoi.
    const jobs = config.jobs ?? [
      // Réseau (J13), en premier à chaque passage : les départs du jour passent clients, biens et projets à leur
      // successeur ou à la direction avant qu'un rappel ou une relance ne soit tenté au nom de l'agent parti [R86] ;
      // puis les alertes de l'assistance.
      reseau.reseauHourlyJob(config.db, journal, { now }),
      ...SITE_JOBS_TRIAL,
      vendorFollowUpJob(config.db, journal, { now }),
      appointmentReminderJob(config.db, journal, { now, linkBase: config.appointmentLinkBase || null }),
      appointmentBriefJob(config.db, journal, { now }),
      // Plan du jour de chaque agent, figé à 7 h 30 (G02), sans aucun envoi.
      dailyPlanJob(config.db, journal, { now }),
      // Suivi de valeur (G04) : réponses lues, envois par les canaux du mode essai seulement.
      valueTrackingJob(config.db, journal, { now, ranges: config.communeRanges ?? null }),
      // Contrôle de la base légale des plans du jour sur 30 jours (G05), à 8 h.
      legalBasisJob(config.db, journal, { now }),
      // Échéances des mandats (D06), à 6 h : tâches pour l'agent, sans aucun envoi.
      mandateDeadlinesJob(config.db, journal, { now }),
      // Alertes aux acquéreurs (T03), de 8 h à 19 h (IN14), par les canaux du mode essai seulement.
      alertsJob(config.db, journal, { now, unsubscribeBase: config.alertUnsubscribeBase || null }),
      // Date de mise en vente des biens (IN11), sans aucun envoi, pour mesurer l'alerte dans l'heure [R222].
      onSaleDatesJob(config.db, journal, { now }),
      // Comptes rendus de visite validés en attente (T06), au passage suivant, par les canaux du mode essai.
      visitReportsJob(config.db, journal, () => {
        const store = new FicheClient(config.db, { now });
        return new Visites(config.db, journal, new Acces(config.db, store, new FicheUnique(config.db, store, { now }), journal, { now }), { now });
      }, { now }),
      // Point de la semaine au vendeur (T07) : préparé le lundi pour l'agent, envoyé après sa validation.
      weeklyPointJob(config.db, journal, () => {
        const store = new FicheClient(config.db, { now });
        return new Acces(config.db, store, new FicheUnique(config.db, store, { now }), journal, { now });
      }, { now }),
      // Offres (O09), à 6 h : offres non transmises signalées [R56], tâches la veille des échéances [R59], sans envoi.
      offersDailyJob(config.db, journal, { now }),
      // Dossiers de vente (N09), de 9 h à 19 h : échéances, alertes de financement, filet du bouclier contre le faux
      // RIB, relances des pièces par les canaux du mode essai ; seulement avec le stockage des pièces.
      ...(config.pieces ? [dossiersJob(config.db, journal, config.pieces, { now })] : []),
      // Après la vente (F07) : demandes d'avis, remerciements préparés pour l'agent, relances aux dates clés avec le
      // carnet, par les canaux du mode essai seulement, sur les dossiers clos de M10.
      ...apresVenteJobs(config.db, journal, { base: apresVenteBase(config.apresVenteBase), sales: config.soldSales ?? null, geocoder: config.geocoder ?? null, now }),
      // Pilotage (K08) : commissions, factures d'essai et reversements chaque heure ; alertes à 6 h, avec les pièces du
      // dossier d'agent ; rapport du matin du lundi au vendredi à 7 h 30, rangé, jamais envoyé.
      ...pilotageJobs(config.db, journal, { now }),
      // Facturation (HX49, RC55, BR92), juste après le pilotage qui écrit les factures : le rapprochement chaque heure ;
      // à 6 h les relances dues préparées, à valider par la direction ; de 9 h à 19 h du lundi au samedi, les relances
      // validées par le contrôle central, canaux du mode essai seulement. Sur un relevé de banque de plus de 7 jours, ou
      // sans relevé, aucune relance n'est préparée ni envoyée [R551, R553, R26].
      ...(() => {
        const store = new FicheClient(config.db, { now });
        return facturationJobs(config.db, journal, new Acces(config.db, store, new FicheUnique(config.db, store, { now }), journal, { now }), { now });
      })(),
      // Réseau (J13), à 6 h : échéances des pièces du dossier d'agent et du compteur de formation, rangées pour les
      // écrans, jamais envoyées.
      reseau.reseauDailyJob(config.db, journal, { now }),
      // Location (W10), de 9 h à 19 h : l'échéance du propriétaire et les reçus d'équité préparés par M15, passés par le
      // contrôle central, qui redécide au moment de l'envoi ; canaux du mode essai seulement.
      location.locationSendJob(config.db, journal, { now }),
      // Conformité (L09) : alertes de fuite chaque heure ; à 6 h, prospects à 3 ans, échéances des demandes des
      // personnes et relecture du registre. Tout est rangé pour l'écran du responsable, rien n'est envoyé.
      ...conformiteJobs(config.db, journal, (() => {
        const store = new FicheClient(config.db, { now });
        return new DecisionEnvoi(config.db, store, new FicheUnique(config.db, store, { now }), { now });
      })(), { now }),
      // Partenaires (U09) : relances et alertes de 9 h à 19 h, prospection du jour ouvré à 10 h, échéances des
      // justificatifs à 6 h. Tout est préparé et rangé, rien n'est envoyé.
      ...partenairesJobs(config.db, journal, { now, optOutBase: config.partnerOptOutBase || null }),
      // Investir (Y08), de 9 h à 19 h : les alertes aux investisseurs qui les ont demandées, chacune décidée par le
      // contrôle central au moment de l'envoi ; canaux du mode essai seulement, rien ne part [R03, R26, R124].
      investorAlertsJob(config.db, journal, { now, unsubscribeBase: config.alertUnsubscribeBase || null, feesRateBp: config.investorFeesRateBp ?? null }),
      // Commerces (CE10), à 6 h : tâches de la cession pour l'agent du bien et examen de vigilance de chaque dossier,
      // rangés pour les écrans, jamais envoyés [R116, R118].
      commerces.commercesDailyJob(config.db, journal, { now }),
      // Gagner des mandats (G12) : à 6 h, la liste du mois des relances d'anciens contacts, rangées à valider pour leur
      // agent, rien n'est envoyé [R143, R26] ; le 1er du mois à 8 h, l'avis que la mesure du mois passé se lit [R144].
      ...gagnerJobs(config.db, journal, { now }),
      // Attirer (AT10), à 5 h : les pages de prix recalculées dès qu'une nouvelle publication DVF est lue ; la même
      // publication ne donne jamais deux versions [R150, R151]. Seulement avec les ventes publiques de l'estimation.
      ...(config.soldSales ? [pricesJob(config.db, journal, config.soldSales, { now })] : []),
      // Gel des avoirs (HX57), chaque heure : les dossiers ouverts depuis la dernière version du registre sont contrôlés ;
      // une correspondance va au seul responsable, rien n'est envoyé ni changé pour le client [R603, R604, R605].
      freezeSweepJob(config.db, journal, { now }),
      // Réclamations (HX58), de 9 h à 19 h : alertes de l'échéance rangées pour l'agent et la direction ; le médiateur
      // proposé de lui-même à l'échéance, par le contrôle central et les canaux du mode essai seulement [R606, R607].
      complaintsJob(config.db, journal, (() => {
        const store = new FicheClient(config.db, { now });
        return new Acces(config.db, store, new FicheUnique(config.db, store, { now }), journal, { now });
      })(), { now }),
      // Condition de la phase 1 (HX70), de minuit à 3 h : le relevé de la veille figé pour chaque réseau, une seule fois,
      // jamais rattrapé plus tard ; rien n'est envoyé [R643, R17].
      phase1ReadingJob(config.db, journal, { now }),
      // Seuils du passage à PostgreSQL (HX66, BR25), le lundi à 4 h : un relevé rangé, jamais changé ; sans réseau de la
      // plateforme, le temps du rapport est inconnu, jamais « sous le seuil » ; rien ne bascule seul [R630, R631].
      postgresReadingJob(config.db, journal, { now, platformNetworkId: config.platformNetworkId || null }),
      // Panneaux (HX14, BR23), à 6 h, 13 h et 19 h : un panneau posé sur un bien vendu ou qui ne peut plus être diffusé
      // reçoit sa tâche « récupérer le panneau », une seule par pose ; rien n'est envoyé [R283].
      (() => {
        const store = new FicheClient(config.db, { now });
        const acces = new Acces(config.db, store, new FicheUnique(config.db, store, { now }), journal, { now });
        const diffusion = new Diffusion(config.db, acces, journal, { now });
        return signPickupsJob(config.db, acces, { canDiffuse: (networkId, propertyId, at) => diffusion.canDiffuse(networkId, propertyId, at) }, journal, { now });
      })(),
      // Veille des diagnostics énergétiques (HX16, BR26), à 7 h : les diagnostics nouveaux des secteurs ouverts, rangés
      // une seule fois par réseau, dans l'alerte du jour ; seuls le code postal et le jour partent, rien n'est envoyé [R288, R289].
      dpeWatchJob(config.db, config.dpeFeed ?? null, journal, { now }),
      // Pige (AU034), à 6 h : les annonces du fournisseur réglé, par la même porte que toute relève ; chaque passage
      // laisse sa ligne, une panne va au journal et à l'écran [R671, R273].
      pigeCollectJob(config.db, journal, new Pige(config.db, journal, new PrixRegroupes(config.db, journal, NO_SALES, { now }), { now }), config.pigeProvider ?? null, { now }),
      // Séquences de prospection (HX20, BR31), de 9 h à 19 h du lundi au samedi : arrêt sur tous les canaux à la première
      // réponse ou opposition, puis les mails et SMS dus remis au contrôle central, canaux du mode essai seulement ;
      // Bloctel n'est pas branché (H61) [R300, R301, R26].
      sequencesJob(config.db, journal, { now }),
      // Scénarios automatiques (HX24, BR55), à chaque heure : les faits venus depuis l'allumage rangés une fois, puis les
      // passages dus ; un message attend l'heure permise et ne part que par le contrôle central, canaux du mode essai
      // seulement [R401, R402, R26].
      scenariosJob(config.db, journal, { now }),
      // Dates des clients (HX25, BR56), à chaque heure, juste après les scénarios : une place de scénario prise ce jour
      // fait attendre la date ; les messages du jour par le contrôle central, canaux du mode essai seulement [R402, R405, R26].
      datesJob(config.db, journal, { now }),
      // Marketing (HX52, HX53, BR112) : à chaque heure, les créneaux dus du calendrier de publication, chacun une seule
      // fois, par la porte de publication de X05 et ses canaux d'essai, seulement avec le stockage du studio ; du lundi au
      // samedi à 10 h et 16 h, les éditions de la lettre ouvertes depuis moins de sept jours, par le contrôle central,
      // seulement avec le lien de désinscription réglé [R582, R583, R584, R26].
      ...marketingJobs(config.db, journal, { now, files: config.studioFiles ?? null, letterUnsubscribeBase: config.letterUnsubscribeBase ?? null }),
      // Relecture des annonces en ligne (AU068), à 7 h, 12 h et 18 h, seulement avec le lecteur réel : un ancien prix
      // ou une annonce retirée encore visible ouvre une tâche datée pour l'agent [R473].
      ...(config.listingReader ? [portalCheckJob(config.db, journal, config.listingReader, { now })] : []),
    ];
    return await new Planificateur(config.db, journal, jobs, { now }).tick();
  } catch (error) {
    await journalError(journal, 'system:planificateur', 'planificateur', error, now);
    return null;
  }
}

/** Le nom du passage des alertes aux investisseurs, sans donnée. */
export const INVESTOR_ALERTS_JOB = 'investir.alertes';

/**
 * Les alertes aux investisseurs (Y06), au planificateur (Y08) : aux mêmes heures que celles des acquéreurs, une fois
 * par créneau. Les canaux sont ceux du mode essai : `AlertesInvestisseurs` n'en reçoit pas d'autres d'ici [R26].
 */
export function investorAlertsJob(db: SqlDatabase, journal: SqlJournalStore, options: { now: () => Date; unsubscribeBase: string | null; feesRateBp: investir.Sourced<number> | null }): ScheduledJob {
  return {
    name: INVESTOR_ALERTS_JOB,
    hours: [9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19],
    weekdays: [1, 2, 3, 4, 5, 6],
    run: async () => {
      await new investir.AlertesInvestisseurs(db, journal, { now: options.now, unsubscribeBase: options.unsubscribeBase, feesRateBp: options.feesRateBp }).run();
    },
  };
}

/**
 * Le barème des frais d'acquisition réglé par la direction (variable `INVESTIR_FRAIS_BAREME`, `750@2027-09-01`) : un
 * entier de points de base du prix, de 0 à 2 000, et la date du réglage. Lecture prudente : absent ou mal formé, rien,
 * et aucune alerte qui demande un rendement ne part.
 */
export function investorFeesRate(raw: string | undefined): investir.Sourced<number> | null {
  const m = /^(\d{1,4})@(\d{4}-\d{2}-\d{2})$/.exec((raw ?? '').trim());
  if (!m) return null;
  const value = Number(m[1]);
  const asOf = m[2]!;
  if (value > 2_000 || Number.isNaN(Date.parse(`${asOf}T00:00:00Z`)) || new Date(`${asOf}T00:00:00Z`).toISOString().slice(0, 10) !== asOf) return null;
  return { value, source: 'direction:INVESTIR_FRAIS_BAREME', asOf, hypothesis: 'barème des frais d’acquisition réglé par la direction' };
}

/** Le nom du passage des prix publics, sans donnée. */
export const PRICES_JOB = 'attirer.prix';

/**
 * Le recalcul des prix publics (AT01), au planificateur (AT10) : chaque jour à 5 h, pour chaque réseau qui a tracé des
 * zones. `recompute` ne calcule une version que pour une publication DVF (ou un jeu de zones) qu'il n'a pas encore :
 * une nouvelle publication donne une nouvelle version, la précédente reste lisible ; une lecture incomplète n'écrit
 * rien et sera reprise le lendemain [R150, R151, R17]. Un réseau en panne n'empêche pas les autres ; la première
 * erreur remonte au planificateur, qui l'écrit au journal [R13].
 */
export function pricesJob(db: SqlDatabase, journal: JournalStore, sales: PriceSalesSource, options: { now: () => Date }): ScheduledJob {
  return {
    name: PRICES_JOB,
    hours: [5],
    run: async () => {
      const prix = new PrixRegroupes(db, journal, sales, { now: options.now });
      let failure: unknown = null;
      for (const n of await db.all<{ network_id: string }>('SELECT DISTINCT network_id FROM price_zones ORDER BY network_id')) {
        try {
          await prix.recompute(n.network_id);
        } catch (error) {
          failure ??= error;
        }
      }
      if (failure !== null) throw failure;
    },
  };
}

/** Le nom du passage du gel des avoirs, sans donnée. */
export const FREEZE_SWEEP_JOB = 'securite.gel_avoirs';

/**
 * Le contrôle du gel des avoirs (HX57), au planificateur : chaque heure, chaque dossier ouvert qui n'a pas encore été
 * contrôlé sur la dernière version scellée du registre l'est. Le passage ne lit aucune table du gel lui-même.
 */
export function freezeSweepJob(db: SqlDatabase, journal: SqlJournalStore, options: { now: () => Date }): ScheduledJob {
  return {
    name: FREEZE_SWEEP_JOB,
    hours: Array.from({ length: 24 }, (_, h) => h),
    run: async () => {
      const store = new FicheClient(db, { now: options.now });
      const acces = new Acces(db, store, new FicheUnique(db, store, { now: options.now }), journal, { now: options.now });
      await new ControleGels(db, acces, journal, { now: options.now }).sweepAll();
    },
  };
}

/** Le nom du passage de relecture des annonces en ligne, sans donnée. */
export const PORTAL_CHECK_JOB = 'annonces.relecture';

/** AU068 · La relecture des annonces acceptées de chaque réseau, par le lecteur réel, trois fois par jour [R473]. */
export function portalCheckJob(db: SqlDatabase, journal: SqlJournalStore, reader: annonces.OnlineListingReader, options: { now: () => Date }): ScheduledJob {
  return {
    name: PORTAL_CHECK_JOB,
    hours: [7, 12, 18],
    run: async () => {
      const store = new FicheClient(db, { now: options.now });
      const acces = new Acces(db, store, new FicheUnique(db, store, { now: options.now }), journal, { now: options.now });
      const surveillance = new annonces.DiffusionSurveillee(db, acces, journal, { now: options.now });
      for (const n of await db.all<{ id: string }>('SELECT id FROM networks ORDER BY id')) await surveillance.verifyAll(n.id, reader);
    },
  };
}
