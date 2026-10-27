/**
 * Le brief du rendez-vous (M05, V05).
 *
 * Une heure avant chaque rendez-vous au moins, le planificateur (B02) range pour l'agent un brief : le client et son
 * histoire, le bien, les ventes du quartier, les questions à prévoir, les documents à apporter et le lien d'itinéraire
 * vers l'application de navigation du téléphone. Le brief est fait par le code, sans IA : chaque élément vient de la
 * base, avec sa source citée, ou d'un réglage du réseau dit comme tel ; ce qui manque est dit, rien n'est inventé
 * [R34]. Seul l'agent du rendez-vous le lit. Le journal ne porte que le nombre d'éléments manquants [R13].
 *
 * Décidé : la base ne garde pas l'adresse exacte d'un bien ; l'itinéraire mène à sa commune, et le brief dit que
 * l'adresse exacte manque. Les ventes du quartier sont celles citées par le dernier avis de valeur du bien (E04), avec
 * la source de ses données ; sans avis, le brief dit qu'elles manquent. Questions et documents viennent de listes de
 * réglage par type de rendez-vous, plus une question par donnée utile absente.
 */
import type { SqlDatabase } from '../db/sql.ts';
import type { Viewer } from '../acces/droits.ts';
import { FicheClient } from '../db/fiche-client.ts';
import { FicheUnique } from '../fiche/fusion.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import type { ScheduledJob } from '../bascule/planificateur.ts';
import { localTime } from '../envoi/horaires.ts';
import { AGENDA_TIME_ZONE, isOnSite, type AppointmentKind } from './creneaux.ts';

export type BriefSection = 'client' | 'histoire' | 'bien' | 'ventes' | 'questions' | 'documents' | 'itineraire';
export const BRIEF_SECTIONS: readonly BriefSection[] = ['client', 'histoire', 'bien', 'ventes', 'questions', 'documents', 'itineraire'];

/** Un élément du brief : une valeur avec sa source, ou ce qui manque, jamais les deux à moitié [R34]. */
export type BriefItem =
  | { section: BriefSection; label: string; value: string; source: string }
  | { section: BriefSection; label: string; value: null; missing: string };

export interface Brief {
  appointmentId: string;
  kind: AppointmentKind;
  start: string;
  preparedAt: string;
  items: BriefItem[];
}

export interface BriefSettings {
  /** Les questions à prévoir, par type de rendez-vous : un réglage du réseau. */
  questions: Record<AppointmentKind, readonly string[]>;
  /** Les documents à apporter, par type de rendez-vous : un réglage du réseau. */
  documents: Record<AppointmentKind, readonly string[]>;
  /** Le brief est prêt au moins ce nombre de minutes avant le rendez-vous. */
  leadMinutes: number;
  /** Ventes du quartier citées au plus. */
  sales: number;
}

export const DEFAULT_BRIEF_SETTINGS: BriefSettings = Object.freeze({
  questions: {
    estimation: ['Pourquoi vendre, et pour quand ?', 'Quels travaux ont été faits, ou sont à prévoir ?', 'Un autre professionnel a-t-il déjà estimé le bien ?'],
    visite: ['Le financement est-il prêt ?', 'Quels critères sont indispensables ?', 'D’autres biens ont-ils été visités ?'],
    signature: ['Tous les signataires seront-ils présents ?', 'Reste-t-il une condition à lever ?'],
    appel: ['Quel est l’objet de l’appel ?'],
  },
  documents: {
    estimation: ['Étude des ventes du quartier', 'Mandat de vente à présenter (modèle du réseau)', 'Liste des pièces à demander au vendeur'],
    visite: ['Bon de visite à faire signer', 'Fiche du bien'],
    signature: ['Documents à signer', 'Liste des pièces d’identité des signataires'],
    appel: [],
  },
  leadMinutes: 60,
  sales: 5,
});

export const BRIEF_JOB = 'rdv.briefs';
/** Les briefs ne sont pas des messages : la tâche passe à toute heure, tous les jours. */
export const BRIEF_HOURS: readonly number[] = Object.freeze(Array.from({ length: 24 }, (_, h) => h));

const SOURCE = {
  fiche: 'fiche client',
  origine: 'origine du contact (fiche client)',
  projet: 'projet du client (fiche client)',
  qualification: 'qualification du contact',
  messages: 'messages de la conversation',
  rdv: 'rendez-vous de la base',
  bien: 'fiche du bien',
  detail: 'détails du bien',
  reglage: 'réglage du réseau',
  manque: 'donnée absente de la base',
  type: 'type du rendez-vous',
  commune: 'commune du bien (fiche du bien)',
} as const;

const PROJECT_KIND: Record<string, string> = {
  sell: 'vendre',
  buy: 'acheter',
  rent_out: 'mettre en location',
  rent: 'louer',
  invest: 'investir',
  sell_business: 'céder une entreprise',
  buy_business: 'reprendre une entreprise',
  valuation: 'faire estimer',
};
const PROPERTY_KIND: Record<string, string> = {
  home: 'logement',
  land: 'terrain',
  building: 'immeuble',
  commercial: 'local commercial',
  business_walls: 'murs commerciaux',
  business: 'fonds de commerce',
};
const PROPERTY_STATUS: Record<string, string> = {
  draft: 'en préparation',
  available: 'en vente',
  under_offer: 'sous offre',
  sold: 'vendu',
  rented: 'loué',
  withdrawn: 'retiré',
};
const CATEGORY: Record<string, string> = {
  seller: 'vendeur',
  buyer: 'acquéreur',
  valuation: 'estimation',
  rent_out: 'bailleur',
  professional: 'professionnel',
  partner: 'partenaire',
  curious: 'curieux',
  spam: 'indésirable',
};
const DEADLINE: Record<string, string> = {
  now: 'tout de suite',
  within_3_months: 'sous 3 mois',
  within_6_months: 'sous 6 mois',
  within_1_year: 'sous un an',
  later: 'plus tard',
};
const FINANCING: Record<string, string> = {
  cash: 'comptant',
  loan_approved: 'prêt accordé',
  loan_in_progress: 'prêt en cours',
  loan_needed: 'prêt à trouver',
};
const TEMPERATURE: Record<string, string> = { cold: 'froid', warm: 'tiède', hot: 'chaud' };
const APPOINTMENT_STATUS: Record<string, string> = { booked: 'prévu', cancelled: 'annulé', honored: 'honoré', absent: 'absent' };
const KIND_LABEL: Record<AppointmentKind, string> = { estimation: 'estimation', visite: 'visite', signature: 'signature', appel: 'appel' };

const number = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 1 });
const eur = (n: number): string => `${number.format(n)} €`;
/** La date de Paris, `JJ/MM/AAAA`. */
const day = (iso: string): string => {
  const d = localTime(new Date(iso), AGENDA_TIME_ZONE).date;
  return `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}`;
};
const placeholders = (n: number): string => Array.from({ length: n }, () => '?').join(', ');
const EXCERPT = 280;

export interface BriefOptions {
  now?: () => Date;
  settings?: BriefSettings;
  /** Rendez-vous traités au plus par passage. */
  batch?: number;
}

interface AppointmentRow {
  id: string;
  network_id: string;
  agent_id: string;
  person_id: string;
  property_id: string | null;
  kind: AppointmentKind;
  start_at: string;
  status: string;
}

export type BriefRead = { ok: true; brief: Brief } | { ok: false; code: 'unknown' | 'not_agent' | 'not_ready' };

export class BriefsRendezVous {
  private readonly now: () => Date;
  private readonly settings: BriefSettings;
  private readonly batch: number;
  private readonly fiche: FicheUnique;

  constructor(
    private readonly db: SqlDatabase,
    private readonly journal: JournalStore,
    options: BriefOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.settings = options.settings ?? DEFAULT_BRIEF_SETTINGS;
    this.batch = options.batch ?? 200;
    const store = new FicheClient(db, { now: this.now });
    this.fiche = new FicheUnique(db, store, { now: this.now });
  }

  /**
   * Un passage : chaque rendez-vous tenu qui commence avant le passage suivant plus le délai réglé reçoit son brief.
   * Le planificateur passe chaque heure : un rendez-vous est donc couvert au plus tard au passage qui précède son
   * début d'au moins le délai.
   */
  async run(): Promise<string[]> {
    const at = this.now();
    const until = new Date(at.getTime() + (this.settings.leadMinutes + 65) * 60_000);
    const rows = await this.db.all<AppointmentRow>(
      `SELECT a.id, a.network_id, a.agent_id, a.person_id, a.property_id, a.kind, a.start_at, a.status FROM appointments a
       WHERE a.status = 'booked' AND a.start_at > ? AND a.start_at <= ?
       AND NOT EXISTS (SELECT 1 FROM appointment_briefs b WHERE b.appointment_id = a.id)
       ORDER BY a.start_at, a.id LIMIT ?`,
      [at.toISOString(), until.toISOString(), this.batch],
    );
    const done: string[] = [];
    let failure: unknown = null;
    for (const row of rows) {
      // Une panne sur un brief n'arrête pas les autres ; elle remonte ensuite au planificateur [R13].
      try {
        if (await this.prepare(row)) done.push(row.id);
      } catch (error) {
        failure ??= error;
      }
    }
    if (failure !== null) throw failure;
    return done;
  }

  /** Construit le brief d'un rendez-vous, sans le ranger. */
  private async build(row: AppointmentRow): Promise<Brief> {
    const items: BriefItem[] = [];
    const add = (section: BriefSection, label: string, value: string | null | undefined, source: string, missing: string): void => {
      if (value === null || value === undefined || value.trim() === '') items.push({ section, label, value: null, missing });
      else items.push({ section, label, value, source });
    };
    const ids = await this.fiche.membersOf(row.person_id);
    const inIds = placeholders(ids.length);

    // Le client.
    const person = await this.db.first<{ first_name: string | null; last_name: string | null; created_at: string }>(
      'SELECT first_name, last_name, created_at FROM persons WHERE id = ?',
      [row.person_id],
    );
    const name = [person?.first_name, person?.last_name].filter((p) => p && p.trim()).join(' ');
    add('client', 'Nom', name, SOURCE.fiche, 'nom absent de la fiche');
    add('client', 'Client depuis', person ? day(person.created_at) : null, SOURCE.fiche, 'fiche introuvable');
    const origin = await this.db.first<{ channel: string; detail: string | null; occurred_at: string }>(
      `SELECT channel, detail, occurred_at FROM sources WHERE person_id IN (${inIds}) ORDER BY occurred_at, id LIMIT 1`,
      ids,
    );
    add('client', 'Origine', origin ? `${origin.channel}${origin.detail ? ` (${origin.detail})` : ''}, le ${day(origin.occurred_at)}` : null, SOURCE.origine, 'origine du contact absente');
    const projects = await this.db.all<{ kind: string; stage: string; deadline: string | null; budget_min_eur: number | null; budget_max_eur: number | null }>(
      `SELECT kind, stage, deadline, budget_min_eur, budget_max_eur FROM projects WHERE person_id IN (${inIds}) ORDER BY created_at, id`,
      ids,
    );
    if (projects.length === 0) add('client', 'Projet', null, SOURCE.projet, 'aucun projet en base');
    for (const p of projects) {
      const budget =
        p.budget_min_eur !== null && p.budget_max_eur !== null
          ? `, budget de ${eur(p.budget_min_eur)} à ${eur(p.budget_max_eur)}`
          : p.budget_max_eur !== null
            ? `, budget jusqu’à ${eur(p.budget_max_eur)}`
            : p.budget_min_eur !== null
              ? `, budget dès ${eur(p.budget_min_eur)}`
              : '';
      add('client', 'Projet', `${PROJECT_KIND[p.kind] ?? p.kind} (étape : ${p.stage})${budget}${p.deadline ? `, échéance le ${day(p.deadline)}` : ''}`, SOURCE.projet, '');
    }
    const qualification = await this.db.first<{ id: string; category: string; deadline: string | null; financing: string | null; created_at: string }>(
      `SELECT id, category, deadline, financing, created_at FROM qualifications WHERE person_id IN (${inIds}) ORDER BY created_at DESC, id DESC LIMIT 1`,
      ids,
    );
    if (qualification) {
      const score = await this.db.first<{ score: number; temperature: string }>('SELECT score, temperature FROM contact_scores WHERE qualification_id = ?', [qualification.id]);
      const parts = [
        CATEGORY[qualification.category] ?? qualification.category,
        qualification.deadline ? `délai ${DEADLINE[qualification.deadline] ?? qualification.deadline}` : null,
        qualification.financing ? `financement : ${FINANCING[qualification.financing] ?? qualification.financing}` : null,
        score ? `note ${score.score} sur 100, ${TEMPERATURE[score.temperature] ?? score.temperature}` : null,
      ].filter(Boolean);
      add('client', 'Qualification', `${parts.join(', ')} (le ${day(qualification.created_at)})`, SOURCE.qualification, '');
    } else {
      add('client', 'Qualification', null, SOURCE.qualification, 'contact pas encore qualifié');
    }

    // Son histoire.
    const counts = await this.db.first<{ total: number; inbound: number; last_at: string | null }>(
      `SELECT COUNT(*) AS total, SUM(CASE WHEN direction = 'in' THEN 1 ELSE 0 END) AS inbound, MAX(occurred_at) AS last_at FROM messages WHERE person_id IN (${inIds})`,
      ids,
    );
    add(
      'histoire',
      'Échanges',
      counts && counts.total > 0 ? `${counts.total} message(s), dont ${counts.inbound ?? 0} reçu(s) ; dernier le ${day(counts.last_at!)}` : null,
      SOURCE.messages,
      'aucun message en base',
    );
    const lastIn = await this.db.first<{ body: string; channel: string; occurred_at: string }>(
      `SELECT body, channel, occurred_at FROM messages WHERE person_id IN (${inIds}) AND direction = 'in' ORDER BY occurred_at DESC, id DESC LIMIT 1`,
      ids,
    );
    if (lastIn) {
      const body = lastIn.body.length > EXCERPT ? `${lastIn.body.slice(0, EXCERPT)}…` : lastIn.body;
      add('histoire', 'Dernier message reçu', `« ${body} » (${lastIn.channel}, le ${day(lastIn.occurred_at)})`, SOURCE.messages, '');
    }
    const past = await this.db.all<{ kind: AppointmentKind; start_at: string; status: string }>(
      `SELECT kind, start_at, status FROM appointments WHERE person_id IN (${inIds}) AND id <> ? AND start_at < ? ORDER BY start_at`,
      [...ids, row.id, row.start_at],
    );
    const shown = past.slice(-5);
    add(
      'histoire',
      'Rendez-vous précédents',
      shown.length > 0 ? shown.map((p) => `${KIND_LABEL[p.kind]} le ${day(p.start_at)} (${APPOINTMENT_STATUS[p.status] ?? p.status})`).join(' ; ') : null,
      SOURCE.rdv,
      'aucun rendez-vous précédent',
    );

    // Le bien.
    const property = row.property_id
      ? await this.db.first<{
          reference: string;
          kind: string;
          postal_code: string | null;
          city: string | null;
          surface_m2: number | null;
          rooms: number | null;
          price_eur: number | null;
          status: string;
        }>('SELECT reference, kind, postal_code, city, surface_m2, rooms, price_eur, status FROM properties WHERE id = ?', [row.property_id])
      : null;
    const questions: string[] = [];
    if (!property) {
      add('bien', 'Bien', null, SOURCE.bien, 'aucun bien lié au rendez-vous');
    } else {
      add('bien', 'Référence', property.reference, SOURCE.bien, '');
      add('bien', 'Type', `${PROPERTY_KIND[property.kind] ?? property.kind}, ${PROPERTY_STATUS[property.status] ?? property.status}`, SOURCE.bien, '');
      add('bien', 'Commune', [property.postal_code, property.city].filter(Boolean).join(' '), SOURCE.bien, 'commune absente de la fiche du bien');
      add('bien', 'Surface', property.surface_m2 !== null ? `${number.format(property.surface_m2)} m²` : null, SOURCE.bien, 'surface absente');
      add('bien', 'Pièces', property.rooms !== null ? String(property.rooms) : null, SOURCE.bien, 'nombre de pièces absent');
      add('bien', 'Prix', property.price_eur !== null ? eur(property.price_eur) : null, SOURCE.bien, 'prix absent');
      if (property.surface_m2 === null) questions.push('Quelle est la surface du bien ?');
      if (property.rooms === null) questions.push('Combien de pièces compte le bien ?');
      if (property.price_eur === null && row.kind !== 'estimation') questions.push('Quel est le prix du bien ?');
      const detail = await this.db.first<{ neighborhood: string | null; highlight: string | null }>('SELECT neighborhood, highlight FROM property_details WHERE property_id = ?', [row.property_id]);
      add('bien', 'Quartier', detail?.neighborhood, SOURCE.detail, 'quartier absent');
      if (detail?.highlight) add('bien', 'Point fort', detail.highlight, SOURCE.detail, '');
    }

    // Les ventes du quartier : celles citées par le dernier avis de valeur du bien.
    const report = row.property_id
      ? await this.db.first<{ computed: string; created_at: string; status: string }>(
          'SELECT computed, created_at, status FROM valuation_reports WHERE property_id = ? ORDER BY created_at DESC, id DESC LIMIT 1',
          [row.property_id],
        )
      : null;
    const cited = report ? readCited(report.computed) : null;
    if (!report || !cited || cited.sales.length === 0) {
      add('ventes', 'Ventes du quartier', null, '', row.property_id ? 'aucun avis de valeur avec des ventes pour ce bien' : 'aucun bien lié au rendez-vous');
    } else {
      const source = `avis de valeur du ${day(report.created_at)}${report.status === 'draft' ? ' (brouillon)' : ''}${cited.source ? `, ${cited.source}` : ''}`;
      for (const s of cited.sales.slice(0, this.settings.sales)) {
        add('ventes', 'Vente', `${s.month} · ${number.format(s.surface)} m² · ${eur(s.pricePerM2)} le m² · à ${number.format(s.distance)} m`, source, '');
      }
      if (cited.medianPerM2 !== null) add('ventes', 'Prix médian au m²', eur(cited.medianPerM2), source, '');
      if (cited.lastSale) add('ventes', 'Dernière vente publiée', cited.lastSale, source, '');
    }

    // Les questions à prévoir et les documents à apporter.
    if (!qualification?.deadline && projects.every((p) => !p.deadline)) questions.push('Quel est le délai du projet ?');
    for (const q of questions) add('questions', 'Question', q, SOURCE.manque, '');
    for (const q of this.settings.questions[row.kind]) add('questions', 'Question', q, SOURCE.reglage, '');
    const documents = this.settings.documents[row.kind];
    if (documents.length === 0) add('documents', 'Documents', null, SOURCE.reglage, 'aucun document prévu pour ce type de rendez-vous');
    for (const d of documents) add('documents', 'Document', d, SOURCE.reglage, '');

    // L'itinéraire.
    if (!isOnSite(row.kind)) {
      add('itineraire', 'Itinéraire', 'sans objet : rendez-vous par téléphone', SOURCE.type, '');
    } else {
      const town = property ? [property.postal_code, property.city].filter(Boolean).join(' ') : '';
      add(
        'itineraire',
        'Itinéraire vers la commune',
        town ? `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(`${town}, France`)}` : null,
        SOURCE.commune,
        property ? 'commune absente : pas d’itinéraire' : 'aucun bien lié au rendez-vous : pas d’itinéraire',
      );
      add('itineraire', 'Adresse exacte', null, '', 'l’adresse exacte n’est pas gardée dans la base : à demander au client');
    }

    return { appointmentId: row.id, kind: row.kind, start: row.start_at, preparedAt: this.now().toISOString(), items };
  }

  private async prepare(row: AppointmentRow): Promise<boolean> {
    const brief = await this.build(row);
    const missing = brief.items.filter((i) => i.value === null).length;
    const done = await this.db.run(
      `INSERT INTO appointment_briefs (appointment_id, network_id, agent_id, content, missing_count, prepared_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
      [row.id, row.network_id, row.agent_id, JSON.stringify(brief), missing, brief.preparedAt],
    );
    if (done.changes !== 1) return false;
    await appendEvent(
      this.journal,
      { type: 'rdv.brief.pret', actor: 'system:planificateur', subject: `appointment:${row.id}`, data: { agent: row.agent_id, kind: row.kind, missing } },
      this.now,
    );
    return true;
  }

  /** Le brief, pour le seul agent du rendez-vous. */
  async read(viewer: Viewer, appointmentId: string): Promise<BriefRead> {
    const appointment = await this.db.first<{ network_id: string; agent_id: string }>('SELECT network_id, agent_id FROM appointments WHERE id = ?', [appointmentId]);
    if (!appointment || appointment.network_id !== viewer.networkId) return { ok: false, code: 'unknown' };
    if (viewer.role !== 'agent' || viewer.userId !== appointment.agent_id) return { ok: false, code: 'not_agent' };
    const row = await this.db.first<{ content: string; agent_id: string }>('SELECT content, agent_id FROM appointment_briefs WHERE appointment_id = ?', [appointmentId]);
    // Le brief suit l'agent qui l'a reçu : un rendez-vous passé à un autre agent ne lui ouvre pas l'ancien brief.
    if (!row) return { ok: false, code: 'not_ready' };
    if (row.agent_id !== viewer.userId) return { ok: false, code: 'not_agent' };
    return { ok: true, brief: JSON.parse(row.content) as Brief };
  }
}

/** Les ventes citées par un avis de valeur (E04), lues avec prudence : ce qui n'a pas la bonne forme est écarté. */
function readCited(computed: string): { sales: { month: string; surface: number; pricePerM2: number; distance: number }[]; medianPerM2: number | null; lastSale: string | null; source: string | null } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(computed);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const c = parsed as { cited?: unknown; medianPerM2?: unknown; data?: { source?: unknown; lastSale?: unknown } };
  const sales = Array.isArray(c.cited)
    ? c.cited.filter(
        (s): s is { month: string; surface: number; pricePerM2: number; distance: number } =>
          !!s &&
          typeof s === 'object' &&
          typeof (s as { month?: unknown }).month === 'string' &&
          typeof (s as { surface?: unknown }).surface === 'number' &&
          typeof (s as { pricePerM2?: unknown }).pricePerM2 === 'number' &&
          typeof (s as { distance?: unknown }).distance === 'number',
      )
    : [];
  return {
    sales: sales.map((s) => ({ month: s.month, surface: s.surface, pricePerM2: s.pricePerM2, distance: s.distance })),
    medianPerM2: typeof c.medianPerM2 === 'number' ? c.medianPerM2 : null,
    lastSale: typeof c.data?.lastSale === 'string' ? c.data.lastSale : null,
    source: typeof c.data?.source === 'string' ? c.data.source : null,
  };
}

/** La tâche du planificateur : les briefs des rendez-vous. */
export function appointmentBriefJob(db: SqlDatabase, journal: JournalStore, options: BriefOptions = {}): ScheduledJob {
  return {
    name: BRIEF_JOB,
    hours: BRIEF_HOURS,
    run: async () => {
      await new BriefsRendezVous(db, journal, options).run();
    },
  };
}
