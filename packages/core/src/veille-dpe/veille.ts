/**
 * Veille des nouveaux diagnostics énergétiques par secteur (HX16) [R288, R289, R290].
 *
 * - Une source (port) rend les diagnostics de performance énergétique publiés par l'ADEME pour un code postal, depuis
 *   un jour. Seuls des champs d'une liste fermée sont lus : numéro, dates, classes, sorte, surface, adresse du logement,
 *   position. Le diagnostic ne porte aucun propriétaire, et aucun n'est jamais cherché : ni nom, ni numéro, ni mail.
 *   Une adresse qui porte une civilité ou un nom (« M. », « famille », « chez ») est écartée entière [R288].
 * - Chaque diagnostic est rangé une seule fois par réseau, sous son numéro ADEME : un diagnostic déjà vu ne remonte
 *   jamais deux fois, même rejoué ou revu le lendemain par la fenêtre de reprise [R288, R18].
 * - Un secteur de veille est une commune des zones en cours de l'agent, avec son code postal. Chaque passage range dans
 *   l'alerte du jour de chaque secteur les seuls diagnostics nouveaux de sa commune ; l'alerte ne montre que les
 *   communes encore dans les zones de l'agent. Rien n'est envoyé : l'alerte se lit dans l'application [R289].
 * - La carte du secteur : chaque diagnostic avec sa position, sa classe et, pour E, F et G, la date à partir de laquelle
 *   le logement ne peut plus être loué, calculée par M15 (`banDate`) [R100].
 * - Jamais vu : pour un logement classé F ou G, l'agent de la zone fait préparer une lettre « Au propriétaire » (la
 *   liste fermée de G06), à l'adresse du diagnostic, dont le texte est écrit par le code : la classe et la date
 *   d'interdiction de M15, ce que cette date change pour lui, rien d'autre. Une seule par diagnostic dans le réseau.
 *   Elle s'imprime avec la feuille des lettres de G06 ; AIMMO n'envoie rien [R290, R140, R201].
 * - Au journal : des identifiants, des classes, des comptes, jamais une adresse [R13]. Rien ne change ni ne s'efface [R17].
 */
import type { Viewer } from '../acces/droits.ts';
import { agentState } from '../acces/etat-agent.ts';
import { communeSlug } from '../attirer/liste-biens.ts';
import type { ScheduledJob } from '../bascule/planificateur.ts';
import { runBatch, type SqlDatabase } from '../db/sql.ts';
import { localTime } from '../envoi/horaires.ts';
import { plain } from '../envoi/texte.ts';
import type { Fetcher } from '../estimation/collecte.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import { banDate, dayInFrench, ownerNoticeText, territoryOf } from '../location/logement.ts';
import { checkLetterText, LETTER_RECIPIENT_LABELS, renderLetters } from '../mandats/gagner/lettres-quartier.ts';
import { withoutRoadTitles } from './titre-voie.ts';

const TIME_ZONE = 'Europe/Paris';
export const DPE_WATCH_JOB = 'veille_dpe.passage';
/** Combien de jours la source est relue en arrière : l'ADEME publie avec retard. Ce qui est déjà vu ne remonte pas. */
export const DPE_LOOKBACK_DAYS = 7;
/** La carte montre les diagnostics reçus dans ces derniers jours. Réglage. */
export const DPE_MAP_DAYS = 90;
export const DPE_MAX_SECTORS_PER_AGENT = 30;

export const DPE_CLASSES = ['A', 'B', 'C', 'D', 'E', 'F', 'G'] as const;
export type DpeClass = (typeof DPE_CLASSES)[number];
export const DPE_KINDS = ['apartment', 'house', 'building'] as const;
export type DpeKind = (typeof DPE_KINDS)[number];

/** La source des diagnostics publiés : les lignes brutes, lues ensuite champ par champ. */
export interface DiagnosisFeed {
  recent(query: { postcode: string; since: string }): Promise<readonly unknown[]>;
}

/** Un diagnostic lu, sans rien d'autre que ce qui décrit le logement [R288]. */
export interface Diagnosis {
  number: string;
  kind: DpeKind;
  energyClass: DpeClass;
  ghgClass: DpeClass | null;
  surfaceM2: number | null;
  diagnosedOn: string;
  receivedOn: string;
  streetNumber: string | null;
  street: string;
  postcode: string;
  commune: string;
  lat: number | null;
  lon: number | null;
}

type Refusal = { ok: false; rule: 'R16'; code: string };
type Problem = { ok: false; rule: 'R288' | 'R289' | 'R290' | null; code: string };

export interface DpePoint {
  diagnosisId: string;
  number: string;
  kind: DpeKind;
  energyClass: DpeClass;
  ghgClass: DpeClass | null;
  surfaceM2: number | null;
  diagnosedOn: string;
  receivedOn: string;
  address: { streetNumber: string | null; street: string; postcode: string; commune: string };
  position: { lat: number; lon: number } | null;
  /** Le jour à partir duquel le logement ne peut plus être loué (M15), ou `null` [R100]. */
  rentBanFrom: string | null;
  /** La lettre « Au propriétaire » déjà préparée dans le réseau, ou `null`. */
  letterId: string | null;
  /**
   * Vrai seulement quand une lettre existe et que celui qui lit est l'agent qui l'a préparée : lui seul peut la
   * télécharger parmi les agents. Faux sans lettre, pour la lettre d'un autre agent, et pour la direction [R290, R16].
   */
  letterMine: boolean;
}

export interface DpeAlert {
  sectorId: string;
  commune: string;
  postcode: string;
  day: string;
  items: DpePoint[];
}

// Les champs lus, liste fermée : tout autre champ de la source est ignoré, jamais rangé [R288].
export const ADEME_FIELDS = [
  'numero_dpe',
  'date_etablissement_dpe',
  'date_reception_dpe',
  'etiquette_dpe',
  'etiquette_ges',
  'type_batiment',
  'surface_habitable_logement',
  'numero_voie_ban',
  'nom_rue_ban',
  'code_postal_ban',
  'nom_commune_ban',
  '_geopoint',
] as const;

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const NUMBER = /^[A-Z0-9]{8,24}$/;
const STREET_NUMBER = /^\d{1,4}(?: ?(?:bis|ter|quater|[a-z]))?$/iu;
const STREET = /^[\p{L}\d][\p{L}\d '’.-]{1,78}[\p{L}\d.]$/u;
const POSTCODE = /^\d{5}$/;
/** Une civilité ou une marque de personne : une adresse qui en porte une est écartée entière [R288]. */
const PERSON_MARKERS = /(?:^| )(?:m|mr|mme|mlle|mm|dr|me|monsieur|madame|mademoiselle|messieurs|famille|chez|maitre|docteur|c o|attn|a l attention|aux bons soins|proprietaire|nom)(?: |$)/;
const KINDS: Record<string, DpeKind> = { appartement: 'apartment', maison: 'house', immeuble: 'building' };

const words = (t: string): string => plain(t).replace(/[^a-z0-9]+/g, ' ').trim();
/** Vrai si le texte porte une civilité ou une marque de personne : il est alors écarté entier [R288, R292]. */
export const carriesPerson = (t: string): boolean => PERSON_MARKERS.test(` ${words(t)} `);
/**
 * Vrai si l'adresse porte une civilité ou un nom de personne. Le titre d'une voie (« rue du Docteur Chaussier ») n'en est
 * pas un : il est retiré avant le contrôle ; toute autre marque écarte l'adresse entière [R288, R292].
 */
export function addressCarriesPerson(t: string): boolean {
  return carriesPerson(withoutRoadTitles(words(t.normalize('NFD').replace(/\p{M}/gu, ''))));
}
const text = (v: unknown, max: number): string | null => {
  if (typeof v !== 'string' || /[\r\n\t<>]/.test(v)) return null;
  const t = v.trim().replace(/\s+/g, ' ');
  return t === '' || t.length > max ? null : t;
};
const asClass = (v: unknown): DpeClass | null => {
  const t = typeof v === 'string' ? v.trim().toUpperCase() : '';
  return (DPE_CLASSES as readonly string[]).includes(t) ? (t as DpeClass) : null;
};
const asDay = (v: unknown): string | null => {
  if (typeof v !== 'string') return null;
  const d = v.trim().slice(0, 10);
  if (!DAY.test(d)) return null;
  const t = Date.parse(`${d}T00:00:00.000Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === d ? d : null;
};

/**
 * Une ligne de la source, lue champ par champ dans la liste fermée, ou la raison de l'écarter. Rien d'autre n'est lu :
 * un champ de plus (un nom, un numéro) ne passe jamais [R288].
 */
export function readDiagnosis(raw: unknown, postcode: string): { ok: true; value: Diagnosis } | { ok: false; code: 'illisible' | 'nom_dans_adresse' | 'hors_code_postal' } {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, code: 'illisible' };
  const r = raw as Record<string, unknown>;
  const number = typeof r['numero_dpe'] === 'string' ? r['numero_dpe'].trim().toUpperCase() : '';
  if (!NUMBER.test(number)) return { ok: false, code: 'illisible' };
  const energyClass = asClass(r['etiquette_dpe']);
  const diagnosedOn = asDay(r['date_etablissement_dpe']);
  const receivedOn = asDay(r['date_reception_dpe']);
  const kind = typeof r['type_batiment'] === 'string' ? KINDS[plain(r['type_batiment']).trim()] : undefined;
  if (!energyClass || !diagnosedOn || !receivedOn || !kind || diagnosedOn > receivedOn) return { ok: false, code: 'illisible' };
  const street = text(r['nom_rue_ban'], 80);
  const commune = text(r['nom_commune_ban'], 80);
  const pc = text(r['code_postal_ban'], 5);
  const rawNumber = r['numero_voie_ban'];
  const streetNumber = rawNumber === undefined || rawNumber === null || rawNumber === '' ? null : text(typeof rawNumber === 'number' ? String(rawNumber) : rawNumber, 12);
  if (!street || !commune || !pc || !POSTCODE.test(pc) || !/\p{L}/u.test(commune) || !STREET.test(street) || !/\p{L}{2}/u.test(street)) return { ok: false, code: 'illisible' };
  if (rawNumber !== undefined && rawNumber !== null && rawNumber !== '' && (!streetNumber || !STREET_NUMBER.test(streetNumber))) return { ok: false, code: 'illisible' };
  if (addressCarriesPerson(street) || carriesPerson(commune) || carriesPerson(streetNumber ?? '')) return { ok: false, code: 'nom_dans_adresse' };
  if (pc !== postcode) return { ok: false, code: 'hors_code_postal' };
  const s = r['surface_habitable_logement'];
  const surfaceM2 = typeof s === 'number' && Number.isFinite(s) && s > 0 && s < 10_000 ? Math.round(s * 100) / 100 : null;
  let lat: number | null = null;
  let lon: number | null = null;
  const g = r['_geopoint'];
  if (typeof g === 'string') {
    const m = /^\s*(-?\d{1,2}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)\s*$/.exec(g);
    if (m) {
      const a = Number(m[1]);
      const b = Number(m[2]);
      if (a >= -90 && a <= 90 && b >= -180 && b <= 180) [lat, lon] = [a, b];
    }
  }
  return { ok: true, value: { number, kind, energyClass, ghgClass: asClass(r['etiquette_ges']), surfaceM2, diagnosedOn, receivedOn, streetNumber, street, postcode: pc, commune, lat, lon } };
}

/**
 * Le texte de la lettre au propriétaire d'un logement classé F ou G, écrit par le code : la classe, la date
 * d'interdiction de louer de M15, ce qu'elle change, et l'offre d'en parler. Aucun nom, aucune adresse [R290, R10].
 */
export function ownerLetterText(energyClass: 'F' | 'G', bannedFrom: string, today: string): string {
  const notice = ownerNoticeText(energyClass, bannedFrom, today).replace(/^Bonjour, /, '').replace(/ Votre agent immobilier peut vous expliquer les étapes possibles\.$/, '');
  const head = notice.charAt(0).toUpperCase() + notice.slice(1);
  const after =
    bannedFrom <= today
      ? ' Si le logement est loué, le bail en cours continue, mais il ne pourra être ni renouvelé ni reconduit sans travaux.'
      : ' D’ici là, un bail peut encore être signé ; ensuite, il ne pourra être ni signé, ni renouvelé, ni reconduit sans travaux.';
  return `${head}${after} Trois voies s’offrent à vous : engager des travaux pour changer de classe, garder le logement pour votre usage, ou le vendre en connaissant sa valeur avec et sans travaux. Je vous adresse ce courrier sans connaître votre nom, à partir du diagnostic publié pour cette adresse. Si vous voulez en parler, je me tiens à votre disposition, sans engagement.`;
}

/**
 * Le contrôle du texte d'une lettre de veille : celui de G06, la date de M15 mise à part, seule donnée chiffrée
 * permise ; elle doit y être [R290, R10].
 */
export function checkOwnerLetter(body: string, bannedFrom: string): string | null {
  const when = dayInFrench(bannedFrom);
  if (!body.includes(when)) return 'sans_date';
  return checkLetterText(body.split(when).join('cette date'), null);
}

interface DiagnosisRow {
  id: string;
  network_id: string;
  number: string;
  kind: DpeKind;
  energy_class: DpeClass;
  ghg_class: DpeClass | null;
  surface_m2: number | null;
  diagnosed_on: string;
  received_on: string;
  street_number: string | null;
  street: string;
  postcode: string;
  commune: string;
  commune_slug: string;
  lat: number | null;
  lon: number | null;
  letter_id: string | null;
  letter_agent_id: string | null;
}

const DIAGNOSIS_SELECT = `
  SELECT d.id, d.network_id, d.number, d.kind, d.energy_class, d.ghg_class, d.surface_m2, d.diagnosed_on, d.received_on,
         d.street_number, d.street, d.postcode, d.commune, d.commune_slug, d.lat, d.lon, l.id AS letter_id, l.agent_id AS letter_agent_id
    FROM dpe_diagnoses d
    LEFT JOIN dpe_letters l ON l.diagnosis_id = d.id AND l.network_id = d.network_id`;

/** Un point lu par `viewer` : `letterMine` ne vaut que pour l'agent qui a préparé la lettre [R290]. */
const pointOf = (viewer: Viewer) => (r: DiagnosisRow): DpePoint => ({
  diagnosisId: r.id,
  number: r.number,
  kind: r.kind,
  energyClass: r.energy_class,
  ghgClass: r.ghg_class,
  surfaceM2: r.surface_m2 === null ? null : Number(r.surface_m2),
  diagnosedOn: r.diagnosed_on,
  receivedOn: r.received_on,
  address: { streetNumber: r.street_number, street: r.street, postcode: r.postcode, commune: r.commune },
  position: r.lat === null || r.lon === null ? null : { lat: Number(r.lat), lon: Number(r.lon) },
  rentBanFrom: banDate(r.energy_class, territoryOf(r.postcode)),
  letterId: r.letter_id,
  letterMine: viewer.role === 'agent' && r.letter_id !== null && r.letter_agent_id === viewer.userId,
});

const shiftDay = (day: string, days: number): string => new Date(Date.parse(`${day}T12:00:00.000Z`) + days * 86_400_000).toISOString().slice(0, 10);

export interface VeilleDpeOptions {
  now?: () => Date;
  newId?: () => string;
}

export interface PassReport {
  inserted: number;
  alerted: number;
  /** Lignes écartées : illisibles, adresse portant un nom, hors du code postal demandé. */
  skipped: { illisible: number; nom_dans_adresse: number; hors_code_postal: number };
}

export class VeilleDpe {
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(
    private readonly db: SqlDatabase,
    private readonly feed: DiagnosisFeed | null,
    private readonly journal: JournalStore,
    options: VeilleDpeOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => crypto.randomUUID());
  }

  private actor(viewer: Viewer): string {
    return `${String(viewer.role)}:${viewer.userId}`;
  }

  private today(): string {
    return localTime(this.now(), TIME_ZONE).date;
  }

  private async refuse(viewer: Viewer, subject: string | null, code: string): Promise<Refusal> {
    await appendEvent(this.journal, { type: 'acces.refuse', actor: this.actor(viewer), subject, data: { rule: 'R16', role: String(viewer.role), kind: 'veille_dpe', code } }, this.now);
    return { ok: false, rule: 'R16', code };
  }

  private async activeAgent(networkId: string, agentId: string): Promise<boolean> {
    const a = await this.db.first<{ id: string }>('SELECT id FROM agents WHERE id = ? AND network_id = ?', [agentId, networkId]);
    if (!a) return false;
    return (await agentState(this.db, networkId, agentId, this.now())) === 'actif';
  }

  /** Un agent du réseau en activité ; la direction lit tout le réseau quand `direction` est permis. */
  private async member(viewer: Viewer, direction: boolean): Promise<Refusal | null> {
    if (viewer.role === 'direction' && direction) return null;
    if (viewer.role !== 'agent') return this.refuse(viewer, null, 'role');
    if (!(await this.activeAgent(viewer.networkId, viewer.userId))) return this.refuse(viewer, null, 'agent_inactive');
    return null;
  }

  /** Les communes des zones en cours d'un agent, ou de tout le réseau, ramenées à leur forme simple. */
  private async zoneSlugs(networkId: string, agentId?: string): Promise<Map<string, string>> {
    const rows = await this.db.all<{ commune: string }>(
      `SELECT commune FROM agent_zones WHERE network_id = ? AND ended_at IS NULL ${agentId ? 'AND agent_id = ?' : ''}`,
      agentId ? [networkId, agentId] : [networkId],
    );
    return new Map(rows.map((r) => [communeSlug(r.commune), r.commune]));
  }

  /** Ouvrir un secteur de veille : une commune des zones en cours de l'agent, avec son code postal [R289]. */
  async watch(viewer: Viewer, input: { commune: unknown; postcode: unknown }): Promise<{ ok: true; sectorId: string } | Refusal | Problem> {
    const blocked = await this.member(viewer, false);
    if (blocked) return blocked;
    const commune = text(input.commune, 80);
    if (!commune || !/\p{L}/u.test(commune)) return { ok: false, rule: 'R289', code: 'bad_commune' };
    if (typeof input.postcode !== 'string' || !POSTCODE.test(input.postcode.trim())) return { ok: false, rule: 'R289', code: 'bad_postcode' };
    const postcode = input.postcode.trim();
    const slug = communeSlug(commune);
    const zones = await this.zoneSlugs(viewer.networkId, viewer.userId);
    if (!zones.has(slug)) return { ok: false, rule: 'R289', code: 'hors_zone' };
    const open = await this.openSectors(viewer.networkId, viewer.userId);
    if (open.some((s) => s.commune_slug === slug && s.postcode === postcode)) return { ok: false, rule: 'R289', code: 'deja_suivi' };
    if (open.length >= DPE_MAX_SECTORS_PER_AGENT) return { ok: false, rule: 'R289', code: 'trop_de_secteurs' };
    const id = this.newId();
    await this.db.run(
      'INSERT INTO dpe_watch_sectors (id, network_id, agent_id, commune, commune_slug, postcode, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [id, viewer.networkId, viewer.userId, zones.get(slug)!, slug, postcode, this.actor(viewer), this.now().toISOString()],
    );
    await appendEvent(this.journal, { type: 'veille_dpe.secteur_ouvert', actor: this.actor(viewer), subject: `dpe_sector:${id}`, data: { rule: 'R289' } }, this.now);
    return { ok: true, sectorId: id };
  }

  /** Fermer un de ses secteurs : il ne reçoit plus rien ; ce qu'il a reçu reste [R17]. */
  async unwatch(viewer: Viewer, sectorId: string): Promise<{ ok: true } | Refusal | Problem> {
    const blocked = await this.member(viewer, false);
    if (blocked) return blocked;
    const s = await this.db.first<{ agent_id: string }>('SELECT agent_id FROM dpe_watch_sectors WHERE id = ? AND network_id = ?', [sectorId, viewer.networkId]);
    if (!s) return { ok: false, rule: null, code: 'unknown_sector' };
    if (s.agent_id !== viewer.userId) return this.refuse(viewer, `dpe_sector:${sectorId}`, 'pas_son_secteur');
    const { changes } = await this.db.run('INSERT INTO dpe_watch_stops (sector_id, network_id, stopped_by, stopped_at) VALUES (?, ?, ?, ?) ON CONFLICT (sector_id) DO NOTHING', [
      sectorId,
      viewer.networkId,
      this.actor(viewer),
      this.now().toISOString(),
    ]);
    if (changes !== 1) return { ok: false, rule: 'R289', code: 'deja_ferme' };
    await appendEvent(this.journal, { type: 'veille_dpe.secteur_ferme', actor: this.actor(viewer), subject: `dpe_sector:${sectorId}`, data: { rule: 'R289' } }, this.now);
    return { ok: true };
  }

  private async openSectors(networkId: string | null, agentId?: string): Promise<{ id: string; network_id: string; agent_id: string; commune: string; commune_slug: string; postcode: string }[]> {
    const where: string[] = ['NOT EXISTS (SELECT 1 FROM dpe_watch_stops t WHERE t.sector_id = s.id)'];
    const params: string[] = [];
    if (networkId) {
      where.push('s.network_id = ?');
      params.push(networkId);
    }
    if (agentId) {
      where.push('s.agent_id = ?');
      params.push(agentId);
    }
    return this.db.all(`SELECT s.id, s.network_id, s.agent_id, s.commune, s.commune_slug, s.postcode FROM dpe_watch_sectors s WHERE ${where.join(' AND ')} ORDER BY s.created_at, s.id`, params);
  }

  /**
   * Un passage : pour chaque réseau et chaque code postal suivi par un secteur ouvert d'un agent en activité dont la
   * commune est encore dans ses zones, lit la source sur les derniers jours, range chaque diagnostic nouveau une seule
   * fois [R288], puis le met dans l'alerte du jour de chaque secteur de sa commune [R289]. Sans source, rien ne se passe.
   */
  async run(): Promise<PassReport> {
    const report: PassReport = { inserted: 0, alerted: 0, skipped: { illisible: 0, nom_dans_adresse: 0, hors_code_postal: 0 } };
    if (!this.feed) return report;
    const today = this.today();
    const since = shiftDay(today, -DPE_LOOKBACK_DAYS);
    // Les secteurs vivants : agent en activité, commune encore dans ses zones [R289].
    const live: { id: string; network_id: string; commune_slug: string; postcode: string }[] = [];
    for (const s of await this.openSectors(null)) {
      if (!(await this.activeAgent(s.network_id, s.agent_id))) continue;
      if (!(await this.zoneSlugs(s.network_id, s.agent_id)).has(s.commune_slug)) continue;
      live.push(s);
    }
    const queries = new Map<string, { networkId: string; postcode: string }>();
    for (const s of live) queries.set(`${s.network_id}|${s.postcode}`, { networkId: s.network_id, postcode: s.postcode });
    let failure: unknown = null;
    for (const q of queries.values()) {
      try {
        const rows = await this.feed.recent({ postcode: q.postcode, since });
        const watched = new Set(live.filter((s) => s.network_id === q.networkId && s.postcode === q.postcode).map((s) => s.commune_slug));
        let inserted = 0;
        for (const raw of rows) {
          const read = readDiagnosis(raw, q.postcode);
          if (!read.ok) {
            report.skipped[read.code] += 1;
            continue;
          }
          const d = read.value;
          const slug = communeSlug(d.commune);
          // Seules les communes suivies entrent : rien d'une commune hors des secteurs [R289].
          if (!watched.has(slug)) continue;
          const id = this.newId();
          const at = this.now().toISOString();
          const sectors = live.filter((s) => s.network_id === q.networkId && s.postcode === q.postcode && s.commune_slug === slug);
          // Le diagnostic et ses lignes d'alerte en un seul lot, tout ou rien : une panne entre les deux ne laisse jamais
          // un diagnostic rangé sans son alerte. Déjà vu, rien n'est écrit : il ne remonte jamais deux fois [R288, R289].
          const results = await runBatch(this.db, [
            {
              sql: `INSERT INTO dpe_diagnoses (id, network_id, number, kind, energy_class, ghg_class, surface_m2, diagnosed_on, received_on, street_number, street, postcode, commune, commune_slug, lat, lon, first_seen_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (network_id, number) DO NOTHING`,
              params: [id, q.networkId, d.number, d.kind, d.energyClass, d.ghgClass, d.surfaceM2, d.diagnosedOn, d.receivedOn, d.streetNumber, d.street, d.postcode, d.commune, slug, d.lat, d.lon, at],
            },
            ...sectors.map((s) => ({
              sql: `INSERT INTO dpe_alert_items (sector_id, diagnosis_id, network_id, alerted_on, created_at)
                    SELECT ?, d.id, d.network_id, ?, ? FROM dpe_diagnoses d WHERE d.id = ? AND d.network_id = ?
                    ON CONFLICT (sector_id, diagnosis_id) DO NOTHING`,
              params: [s.id, today, at, id, q.networkId],
            })),
          ]);
          if (results[0]?.changes !== 1) continue;
          inserted += 1;
          for (const r of results.slice(1)) report.alerted += r.changes;
        }
        report.inserted += inserted;
        if (inserted > 0) {
          await appendEvent(this.journal, { type: 'veille_dpe.passage', actor: 'system:planificateur', subject: `network:${q.networkId}`, data: { rule: 'R288', nouveaux: inserted } }, this.now);
        }
      } catch (error) {
        // Une panne de la source sur un code postal n'arrête pas les autres ; elle remonte ensuite au planificateur [R13].
        failure ??= error;
      }
    }
    if (failure !== null) throw failure;
    return report;
  }

  /** Les secteurs ouverts de l'agent. */
  async sectors(viewer: Viewer): Promise<{ ok: true; sectors: { sectorId: string; commune: string; postcode: string; inZone: boolean }[] } | Refusal> {
    const blocked = await this.member(viewer, false);
    if (blocked) return blocked;
    const zones = await this.zoneSlugs(viewer.networkId, viewer.userId);
    const rows = await this.openSectors(viewer.networkId, viewer.userId);
    return { ok: true, sectors: rows.map((s) => ({ sectorId: s.id, commune: s.commune, postcode: s.postcode, inZone: zones.has(s.commune_slug) })) };
  }

  /**
   * L'alerte d'un jour, pour chaque secteur ouvert de l'agent : les diagnostics nouveaux de ce jour, des seules communes
   * encore dans ses zones [R289]. Rien n'est envoyé ; l'alerte se lit ici.
   */
  async alerts(viewer: Viewer, dayInput?: unknown): Promise<{ ok: true; alerts: DpeAlert[] } | Refusal | Problem> {
    const blocked = await this.member(viewer, false);
    if (blocked) return blocked;
    const day = dayInput === undefined ? this.today() : asDay(dayInput);
    if (!day || (typeof dayInput === 'string' && dayInput !== day)) return { ok: false, rule: null, code: 'bad_day' };
    const zones = await this.zoneSlugs(viewer.networkId, viewer.userId);
    const alerts: DpeAlert[] = [];
    for (const s of await this.openSectors(viewer.networkId, viewer.userId)) {
      if (!zones.has(s.commune_slug)) continue;
      const rows = await this.db.all<DiagnosisRow>(
        `${DIAGNOSIS_SELECT} JOIN dpe_alert_items a ON a.diagnosis_id = d.id
          WHERE a.sector_id = ? AND a.alerted_on = ? AND d.network_id = ? AND d.commune_slug = ?
          ORDER BY d.energy_class DESC, d.received_on DESC, d.number`,
        [s.id, day, viewer.networkId, s.commune_slug],
      );
      if (rows.length > 0) alerts.push({ sectorId: s.id, commune: s.commune, postcode: s.postcode, day, items: rows.map(pointOf(viewer)) });
    }
    return { ok: true, alerts };
  }

  /**
   * La carte : les diagnostics reçus ces derniers jours dans les communes des zones de l'agent, ou de tout le réseau
   * pour la direction, avec leur position, leur classe et la date d'interdiction de louer de M15 [R289, R100].
   */
  async map(viewer: Viewer, filter: { commune?: unknown; classes?: unknown } = {}): Promise<{ ok: true; points: DpePoint[] } | Refusal | Problem> {
    const blocked = await this.member(viewer, true);
    if (blocked) return blocked;
    const zones = await this.zoneSlugs(viewer.networkId, viewer.role === 'agent' ? viewer.userId : undefined);
    let slugs = [...zones.keys()];
    if (filter.commune !== undefined) {
      const c = text(filter.commune, 80);
      if (!c) return { ok: false, rule: null, code: 'bad_commune' };
      const slug = communeSlug(c);
      if (!zones.has(slug)) return { ok: false, rule: 'R289', code: 'hors_zone' };
      slugs = [slug];
    }
    let classes: readonly DpeClass[] = DPE_CLASSES;
    if (filter.classes !== undefined) {
      if (!Array.isArray(filter.classes) || filter.classes.length === 0 || !filter.classes.every((c) => asClass(c) !== null && c === asClass(c))) return { ok: false, rule: null, code: 'bad_classes' };
      classes = filter.classes as DpeClass[];
    }
    if (slugs.length === 0) return { ok: true, points: [] };
    const from = shiftDay(this.today(), -DPE_MAP_DAYS);
    const rows = await this.db.all<DiagnosisRow>(
      `${DIAGNOSIS_SELECT} WHERE d.network_id = ? AND d.received_on >= ? AND d.commune_slug IN (${slugs.map(() => '?').join(', ')})
          AND d.energy_class IN (${classes.map(() => '?').join(', ')})
        ORDER BY d.received_on DESC, d.number`,
      [viewer.networkId, from, ...slugs, ...classes],
    );
    return { ok: true, points: rows.map(pointOf(viewer)) };
  }

  /**
   * Jamais vu : préparer la lettre « Au propriétaire » d'un logement classé F ou G. L'agent dont une zone en cours
   * couvre la commune ; une seule lettre par diagnostic dans le réseau ; texte écrit par le code avec la date de M15 ;
   * aucun nom n'est cherché ni demandé [R290].
   */
  async prepareLetter(viewer: Viewer, diagnosisId: string): Promise<{ ok: true; letterId: string; body: string; bannedFrom: string } | Refusal | Problem> {
    const blocked = await this.member(viewer, false);
    if (blocked) return blocked;
    const d = await this.db.first<DiagnosisRow>(`${DIAGNOSIS_SELECT} WHERE d.id = ? AND d.network_id = ?`, [diagnosisId, viewer.networkId]);
    if (!d) return { ok: false, rule: null, code: 'unknown_diagnosis' };
    if (!(await this.zoneSlugs(viewer.networkId, viewer.userId)).has(d.commune_slug)) return this.refuse(viewer, `dpe:${d.id}`, 'hors_zone');
    if (d.energy_class !== 'F' && d.energy_class !== 'G') return { ok: false, rule: 'R290', code: 'classe_sans_lettre' };
    const bannedFrom = banDate(d.energy_class, territoryOf(d.postcode));
    if (!bannedFrom) return { ok: false, rule: 'R290', code: 'sans_date' };
    if (d.letter_id) return { ok: false, rule: 'R290', code: 'deja_preparee' };
    const body = ownerLetterText(d.energy_class, bannedFrom, this.today());
    const problem = checkOwnerLetter(body, bannedFrom);
    if (problem) return { ok: false, rule: 'R290', code: problem };
    const id = this.newId();
    const { changes } = await this.db.run(
      `INSERT INTO dpe_letters (id, network_id, diagnosis_id, agent_id, energy_class, banned_from, body, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (network_id, diagnosis_id) DO NOTHING`,
      [id, viewer.networkId, d.id, viewer.userId, d.energy_class, bannedFrom, body, this.now().toISOString()],
    );
    if (changes !== 1) return { ok: false, rule: 'R290', code: 'deja_preparee' };
    await appendEvent(this.journal, { type: 'veille_dpe.lettre_preparee', actor: this.actor(viewer), subject: `dpe:${d.id}`, data: { rule: 'R290', letter: id, energyClass: d.energy_class, bannedFrom } }, this.now);
    return { ok: true, letterId: id, body, bannedFrom };
  }

  /** La lettre à imprimer, avec la feuille des lettres de G06 : l'agent qui l'a préparée, ou la direction [R290, R201]. */
  async printLetter(viewer: Viewer, letterId: string): Promise<{ ok: true; html: string } | Refusal | Problem> {
    const blocked = await this.member(viewer, true);
    if (blocked) return blocked;
    const l = await this.db.first<{ id: string; agent_id: string; diagnosis_id: string; body: string; first_name: string; last_name: string; street_number: string | null; street: string; postcode: string; commune: string }>(
      `SELECT l.id, l.agent_id, l.diagnosis_id, l.body, a.first_name, a.last_name, d.street_number, d.street, d.postcode, d.commune
         FROM dpe_letters l JOIN agents a ON a.id = l.agent_id JOIN dpe_diagnoses d ON d.id = l.diagnosis_id
        WHERE l.id = ? AND l.network_id = ?`,
      [letterId, viewer.networkId],
    );
    if (!l) return { ok: false, rule: null, code: 'unknown_letter' };
    if (viewer.role === 'agent' && l.agent_id !== viewer.userId) return this.refuse(viewer, `dpe:${l.diagnosis_id}`, 'pas_sa_lettre');
    const html = renderLetters('au_proprietaire', l.body, `${l.first_name} ${l.last_name}`, [{ number: l.street_number ?? '', street: l.street, postcode: l.postcode, city: l.commune }]).replace(
      '<title>Lettres de quartier</title>',
      `<title>Lettre ${LETTER_RECIPIENT_LABELS.au_proprietaire.toLowerCase()}</title>`,
    );
    await appendEvent(this.journal, { type: 'veille_dpe.lettre_imprimee', actor: this.actor(viewer), subject: `dpe:${l.diagnosis_id}`, data: { rule: 'R290', letter: l.id } }, this.now);
    return { ok: true, html };
  }
}

/** La tâche du planificateur : un passage chaque jour à 7 h, heure de Paris [R288, R289]. */
export function dpeWatchJob(db: SqlDatabase, feed: DiagnosisFeed | null, journal: JournalStore, options: VeilleDpeOptions = {}): ScheduledJob {
  return {
    name: DPE_WATCH_JOB,
    hours: [7],
    run: async () => {
      await new VeilleDpe(db, feed, journal, options).run();
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Le vrai branchement, par `fetch`, à la base ouverte des diagnostics de l'ADEME. L'adresse de base est un réglage.

export const ADEME_DPE_URL = 'https://data.ademe.fr/data-fair/api/v1/datasets/dpe03existant/lines';
export const ADEME_PAGE_SIZE = 500;
export const ADEME_MAX_PAGES = 10;

export class AdemeDiagnosisFeed implements DiagnosisFeed {
  constructor(
    private readonly fetcher: Fetcher,
    private readonly base = ADEME_DPE_URL,
  ) {}

  /** Seuls le code postal et le jour partent ; seuls les champs de la liste fermée sont demandés [R288]. */
  async recent(query: { postcode: string; since: string }): Promise<readonly unknown[]> {
    if (!POSTCODE.test(query.postcode) || !DAY.test(query.since)) return [];
    const qs = `code_postal_ban:"${query.postcode}" AND date_reception_dpe:[${query.since} TO *]`;
    let url: string | null = `${this.base}?qs=${encodeURIComponent(qs)}&size=${ADEME_PAGE_SIZE}&sort=date_reception_dpe&select=${ADEME_FIELDS.join(',')}`;
    const out: unknown[] = [];
    for (let page = 0; url && page < ADEME_MAX_PAGES; page += 1) {
      const res = await this.fetcher(url, { headers: { accept: 'application/json' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as Record<string, unknown> | null;
      const results = body && Array.isArray(body['results']) ? body['results'] : [];
      out.push(...results);
      const next = body ? body['next'] : null;
      // La page suivante n'est suivie que sur la même adresse de base : jamais ailleurs.
      url = typeof next === 'string' && next.startsWith(`${this.base}?`) ? next : null;
    }
    return out;
  }
}
