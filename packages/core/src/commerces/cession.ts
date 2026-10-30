/**
 * Les étapes de la cession d'un fonds de commerce (M16, CE07) [R116, R117, R10, R17].
 *
 * Le dossier de cession d'un fonds (`business`) porte ses dates, chacune avec sa preuve et versionnée, et son séquestre.
 * Le code calcule chaque étape et son échéance ; une étape bloquante non faite empêche de déclarer la cession prête.
 *
 * - Information des salariés (entreprise de moins de 250 salariés) : reçue au plus tard 2 mois avant la cession prévue ;
 *   le dernier jour est avancé au jour ouvrable précédent s'il tombe un samedi, un dimanche ou un jour férié, pour ne
 *   jamais annoncer trop tard. Sans salarié : sans objet. Nombre de salariés inconnu : à saisir, bloquant. 250 salariés
 *   et plus : hors de ce régime, sans objet ici (lecture prudente : l'agent est alerté par la liste de contrôle).
 * - Préemption de la commune : si la commune du bien est rangée par la direction comme dotée d'un périmètre de
 *   sauvegarde (lecture prudente : toute la commune), la déclaration est faite et la commune a 2 mois pour répondre ;
 *   son silence vaut renonciation. Fin reportée au jour ouvrable suivant. Une commune que la direction n'a pas encore
 *   rangée laisse l'étape « à saisir », bloquante. Une préemption exercée bloque la cession pour de bon.
 * - Autorisations propres à l'activité (licences, débit de tabac, officine…) : leur transfert vérifié, avec sa preuve.
 * - Séquestre : un tiers nommé, avocat, notaire ou banque ; jamais le réseau ni un agent [R117].
 * - Après la cession signée : avis au journal d'annonces légales et au BODACC dans les 15 jours (dernier jour avancé au
 *   jour ouvrable précédent), puis 10 jours d'opposition des créanciers après le BODACC (fin reportée au jour ouvrable
 *   suivant : le prix n'est jamais libéré trop tôt).
 *
 * Aucune date inventée : sans sa date et sa preuve, l'étape est « à saisir » [R10]. Une tâche à l'agent du bien avant
 * chaque échéance, une seule par étape et par date ; rien n'est envoyé aux clients. Le journal ne porte ni nom ni
 * preuve [R13].
 */
import type { Acces } from '../acces/acces.ts';
import type { Viewer } from '../acces/droits.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { frenchHolidays, localTime } from '../envoi/horaires.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import { PROOF_REF } from '../offres/transmission.ts';
import type { FicheCommerce, License } from './fiche.ts';

const TIME_ZONE = 'Europe/Paris';
export const EMPLOYEE_NOTICE_MONTHS = 2;
export const EMPLOYEE_THRESHOLD = 250;
export const TRANSFER_PREEMPTION_MONTHS = 2;
export const PUBLICATION_DAYS = 15;
export const OPPOSITION_DAYS = 10;

export const TRANSFER_DATE_KINDS = [
  'cession_prevue',
  'information_salaries',
  'declaration_preemption',
  'renonciation_commune',
  'preemption_exercee',
  'autorisations_verifiees',
  'cession_signee',
  'publication_jal',
  'publication_bodacc',
] as const;
export type TransferDateKind = (typeof TRANSFER_DATE_KINDS)[number];

/** Les dates qui ont eu lieu : jamais dans le futur. La cession prévue, seule, est à venir. */
const PAST_KINDS: readonly TransferDateKind[] = TRANSFER_DATE_KINDS.filter((k) => k !== 'cession_prevue');

export const ESCROW_KINDS = ['avocat', 'notaire', 'banque'] as const;
export type EscrowKind = (typeof ESCROW_KINDS)[number];

export const TRANSFER_STEPS = [
  'cession_prevue',
  'sequestre',
  'information_salaries',
  'preemption',
  'autorisations',
  'publication_jal',
  'publication_bodacc',
  'fin_oppositions',
] as const;
export type TransferStep = (typeof TRANSFER_STEPS)[number];

/** Les étapes à faire avant la cession : non faites, elles empêchent de la déclarer prête [R116]. */
export const BLOCKING_STEPS: readonly TransferStep[] = ['cession_prevue', 'sequestre', 'information_salaries', 'preemption', 'autorisations'];

export type StepStatus = 'fait' | 'a_faire' | 'a_saisir' | 'en_retard' | 'sans_objet' | 'apres_cession' | 'preemptee';

export interface TransferStepLine {
  step: TransferStep;
  status: StepStatus;
  /** L'échéance de l'étape, `AAAA-MM-JJ`, ou null. */
  due: string | null;
  blocking: boolean;
}

export interface TransferFacts {
  employees: number | null;
  licenses: readonly License[];
  /** `null` : la direction n'a pas rangé la commune ; l'étape est à saisir, par prudence. */
  inPerimeter: boolean | null;
  escrow: { kind: EscrowKind; name: string } | null;
  dates: Partial<Record<TransferDateKind, string>>;
  today: string;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const validDay = (v: unknown): v is string => {
  if (typeof v !== 'string' || !DAY.test(v)) return false;
  const d = new Date(`${v}T12:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
};
const addDays = (day: string, n: number): string => new Date(Date.parse(`${day}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const isWorkingDay = (day: string): boolean => {
  const w = new Date(`${day}T12:00:00Z`).getUTCDay();
  return w !== 0 && w !== 6 && !frenchHolidays(Number(day.slice(0, 4))).has(day);
};
const nextWorkingDay = (day: string): string => {
  let d = day;
  while (!isWorkingDay(d)) d = addDays(d, 1);
  return d;
};
const previousWorkingDay = (day: string): string => {
  let d = day;
  while (!isWorkingDay(d)) d = addDays(d, -1);
  return d;
};
/** Le même jour, `n` mois plus tard (ou plus tôt) ; au dernier jour du mois s'il est plus court. */
function addMonths(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const months = m - 1 + n;
  const year = y + Math.floor(months / 12);
  const month = ((months % 12) + 12) % 12;
  const lastOfMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return `${year}-${String(month + 1).padStart(2, '0')}-${String(Math.min(d, lastOfMonth)).padStart(2, '0')}`;
}

/** Les étapes de la cession, depuis les faits et les dates saisies. Fonction pure : mêmes faits, mêmes étapes [R116]. */
export function transferSteps(f: TransferFacts): { lines: TransferStepLine[]; ready: boolean; missing: TransferStep[] } {
  const d = f.dates;
  const line = (step: TransferStep, status: StepStatus, due: string | null): TransferStepLine => ({ step, status, due, blocking: BLOCKING_STEPS.includes(step) });
  const lines: TransferStepLine[] = [];
  lines.push(line('cession_prevue', d.cession_prevue ? 'fait' : 'a_saisir', d.cession_prevue ?? null));
  lines.push(line('sequestre', f.escrow ? 'fait' : 'a_saisir', null));

  // Information des salariés, au plus tard 2 mois avant la cession prévue.
  if (f.employees === 0 || (f.employees !== null && f.employees >= EMPLOYEE_THRESHOLD)) lines.push(line('information_salaries', 'sans_objet', null));
  else if (f.employees === null) lines.push(line('information_salaries', 'a_saisir', null));
  else {
    const due = d.cession_prevue ? previousWorkingDay(addMonths(d.cession_prevue, -EMPLOYEE_NOTICE_MONTHS)) : null;
    const info = d.information_salaries;
    const status: StepStatus = !due ? 'a_saisir' : info ? (info <= due ? 'fait' : 'en_retard') : f.today > due ? 'en_retard' : 'a_faire';
    lines.push(line('information_salaries', status, due));
  }

  // Préemption de la commune, dans un périmètre de sauvegarde : 2 mois pour répondre, le silence vaut renonciation.
  if (f.inPerimeter === false) lines.push(line('preemption', 'sans_objet', null));
  else if (f.inPerimeter === null || !d.declaration_preemption) lines.push(line('preemption', 'a_saisir', null));
  else {
    const due = nextWorkingDay(addMonths(d.declaration_preemption, TRANSFER_PREEMPTION_MONTHS));
    // La commune qui préempte achète à la place du repreneur : la cession ne sera jamais prête.
    const status: StepStatus = d.preemption_exercee ? 'preemptee' : d.renonciation_commune || f.today > due ? 'fait' : 'a_faire';
    lines.push(line('preemption', status, due));
  }

  // Autorisations propres à l'activité.
  if (f.licenses.length === 0) lines.push(line('autorisations', 'sans_objet', null));
  else lines.push(line('autorisations', d.autorisations_verifiees ? 'fait' : 'a_faire', d.cession_prevue ?? null));

  // Après la cession signée : publications, puis oppositions.
  const signed = d.cession_signee;
  if (!signed) {
    for (const s of ['publication_jal', 'publication_bodacc', 'fin_oppositions'] as const) lines.push(line(s, 'apres_cession', null));
  } else {
    // Une obligation de l'acquéreur : son dernier jour est avancé au jour ouvrable précédent, jamais annoncé trop tard.
    const pubDue = previousWorkingDay(addDays(signed, PUBLICATION_DAYS));
    for (const [s, k] of [['publication_jal', 'publication_jal'], ['publication_bodacc', 'publication_bodacc']] as const) {
      const done = d[k];
      lines.push(line(s, done ? (done <= pubDue ? 'fait' : 'en_retard') : f.today > pubDue ? 'en_retard' : 'a_faire', pubDue));
    }
    if (!d.publication_bodacc) lines.push(line('fin_oppositions', 'a_saisir', null));
    else {
      const end = nextWorkingDay(addDays(d.publication_bodacc, OPPOSITION_DAYS));
      lines.push(line('fin_oppositions', f.today > end ? 'fait' : 'a_faire', end));
    }
  }
  const missing = lines.filter((l) => l.blocking && l.status !== 'fait' && l.status !== 'sans_objet').map((l) => l.step);
  return { lines, ready: missing.length === 0, missing };
}

const norm = (s: string): string =>
  s
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

type Refusal = { ok: false; rule: 'R16'; code: string };
type Problem =
  | { ok: false; rule: null; code: 'sorte' | 'unknown_file' | 'already_open' | 'kind' | 'bad_day' | 'bad_proof' | 'future_day' | 'bad_source' | 'bad_commune' | 'bad_name' }
  | { ok: false; rule: 'R117'; code: 'sequestre_interdit' }
  | { ok: false; rule: 'R116'; code: 'etapes_bloquantes'; missing: TransferStep[] };
export type TransferResult<T> = { ok: true; value: T } | Refusal | Problem;

export interface TransferView {
  fileId: string;
  propertyId: string;
  dates: Partial<Record<TransferDateKind, { day: string; version: number }>>;
  escrow: { kind: EscrowKind; name: string; version: number } | null;
  inPerimeter: boolean | null;
  lines: TransferStepLine[];
  ready: boolean;
  missing: TransferStep[];
  declaredReady: string | null;
}

export interface TransferTask {
  fileId: string;
  propertyId: string;
  step: TransferStep;
  /** Le jour de l'échéance ; null pour une date encore à saisir. */
  due: string | null;
}

/** Jours d'avance de la tâche de l'agent, par étape : des réglages. */
export const DEFAULT_TRANSFER_NOTICE_DAYS: Record<TransferStep, number> = {
  cession_prevue: 14,
  sequestre: 14,
  information_salaries: 14,
  preemption: 7,
  autorisations: 14,
  publication_jal: 5,
  publication_bodacc: 5,
  fin_oppositions: 2,
};

interface FileRow {
  id: string;
  network_id: string;
  property_id: string;
}

export interface CessionCommerceOptions {
  now?: () => Date;
  newId?: () => string;
  notice?: Partial<Record<TransferStep, number>>;
}

export class CessionCommerce {
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly notice: Record<TransferStep, number>;

  constructor(
    private readonly db: SqlDatabase,
    private readonly journal: JournalStore,
    private readonly fiches: FicheCommerce,
    options: CessionCommerceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => crypto.randomUUID());
    this.notice = { ...DEFAULT_TRANSFER_NOTICE_DAYS, ...(options.notice ?? {}) };
    for (const v of Object.values(this.notice)) if (!Number.isInteger(v) || v < 0 || v > 60) throw new Error('avance de tâche invalide');
  }

  private today(): string {
    return localTime(this.now(), TIME_ZONE).date;
  }

  private actor(viewer: Viewer): string {
    return `${String(viewer.role)}:${viewer.userId}`;
  }

  /** La direction range une commune dotée (ou plus) d'un périmètre de sauvegarde, avec sa source [R116, R10]. */
  async recordCommune(viewer: Viewer, input: { postalCode?: unknown; city?: unknown; inPerimeter?: unknown; source?: unknown; sourceDate?: unknown }): Promise<TransferResult<{ version: number }>> {
    if (viewer.role !== 'direction') return this.refuse(viewer, `network:${viewer.networkId}`, 'role');
    const { postalCode, city, inPerimeter, source, sourceDate } = input;
    if (typeof postalCode !== 'string' || !/^\d{5}$/.test(postalCode) || typeof city !== 'string' || city.trim() === '' || city.trim().length > 120 || typeof inPerimeter !== 'boolean') {
      return { ok: false, rule: null, code: 'bad_commune' };
    }
    if (typeof source !== 'string' || source.trim().length < 3 || source.trim().length > 300 || !validDay(sourceDate)) return { ok: false, rule: null, code: 'bad_source' };
    for (let attempt = 0; attempt < 5; attempt += 1) {
      // Les versions se comptent sur le nom normalisé : « Dijon » et « DIJON » sont la même commune.
      const same = (await this.db.all<{ city: string; version: number }>('SELECT city, version FROM business_safeguard_communes WHERE network_id = ? AND postal_code = ?', [viewer.networkId, postalCode])).filter(
        (r) => norm(r.city) === norm(city),
      );
      const last = { v: same.reduce((m, r) => Math.max(m, Number(r.version)), 0) };
      const version = Number(last?.v ?? 0) + 1;
      const { changes } = await this.db.run(
        `INSERT INTO business_safeguard_communes (id, network_id, postal_code, city, in_perimeter, source, source_date, version, recorded_by, recorded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
        [this.newId(), viewer.networkId, postalCode, city.trim(), inPerimeter ? 1 : 0, source.trim(), sourceDate, version, this.actor(viewer), this.now().toISOString()],
      );
      if (changes !== 1) continue;
      await appendEvent(this.journal, { type: 'commerces.cession.perimetre', actor: this.actor(viewer), subject: `network:${viewer.networkId}`, data: { postalCode, inPerimeter, version } }, this.now);
      return { ok: true, value: { version } };
    }
    throw new Error('périmètre de sauvegarde : trop d’écritures simultanées');
  }

  /** L'agent du bien ou la direction ouvre le dossier de cession d'un fonds ; un seul par bien. */
  async open(acces: Acces, viewer: Viewer, propertyId: string): Promise<TransferResult<{ fileId: string }>> {
    const g = await this.gate(acces, viewer, propertyId, 'write');
    if (!g.ok) return g;
    const id = this.newId();
    const { changes } = await this.db.run('INSERT INTO business_transfer_files (id, network_id, property_id, created_by, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING', [
      id,
      viewer.networkId,
      propertyId,
      this.actor(viewer),
      this.now().toISOString(),
    ]);
    if (changes !== 1) return { ok: false, rule: null, code: 'already_open' };
    await appendEvent(this.journal, { type: 'commerces.cession.ouverte', actor: this.actor(viewer), subject: `property:${propertyId}`, data: { file: id } }, this.now);
    return { ok: true, value: { fileId: id } };
  }

  /** Le séquestre : un avocat, un notaire ou une banque nommés ; jamais le réseau ni un agent [R117]. */
  async setEscrow(acces: Acces, viewer: Viewer, fileId: string, input: { kind?: unknown; name?: unknown }): Promise<TransferResult<TransferView>> {
    const file = await this.fileFor(acces, viewer, fileId, 'write');
    if (!('id' in file)) return file;
    const { kind, name } = input;
    if (typeof kind !== 'string' || !(ESCROW_KINDS as readonly string[]).includes(kind)) {
      await appendEvent(this.journal, { type: 'commerces.cession.sequestre_refuse', actor: this.actor(viewer), subject: `property:${file.property_id}`, data: { rule: 'R117', code: 'sorte' } }, this.now);
      return { ok: false, rule: 'R117', code: 'sequestre_interdit' };
    }
    if (typeof name !== 'string' || name.trim().length < 3 || name.trim().length > 160) return { ok: false, rule: null, code: 'bad_name' };
    if (await this.isNetworkOrAgent(file.network_id, name)) {
      await appendEvent(this.journal, { type: 'commerces.cession.sequestre_refuse', actor: this.actor(viewer), subject: `property:${file.property_id}`, data: { rule: 'R117', code: 'reseau_ou_agent' } }, this.now);
      return { ok: false, rule: 'R117', code: 'sequestre_interdit' };
    }
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const last = await this.db.first<{ v: number | null }>('SELECT MAX(version) AS v FROM business_transfer_third_parties WHERE file_id = ?', [file.id]);
      const version = Number(last?.v ?? 0) + 1;
      const { changes } = await this.db.run(
        'INSERT INTO business_transfer_third_parties (id, file_id, network_id, kind, name, version, recorded_by, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING',
        [this.newId(), file.id, file.network_id, kind, name.trim(), version, this.actor(viewer), this.now().toISOString()],
      );
      if (changes !== 1) continue;
      await appendEvent(this.journal, { type: 'commerces.cession.sequestre', actor: this.actor(viewer), subject: `property:${file.property_id}`, data: { kind, version } }, this.now);
      return { ok: true, value: await this.view(file) };
    }
    throw new Error('séquestre : trop d’écritures simultanées');
  }

  /** Une date de la cession, avec sa preuve ; une date corrigée s'ajoute en nouvelle version [R17, R10]. */
  async record(acces: Acces, viewer: Viewer, fileId: string, input: { kind?: unknown; day?: unknown; proofRef?: unknown }): Promise<TransferResult<TransferView>> {
    const file = await this.fileFor(acces, viewer, fileId, 'write');
    if (!('id' in file)) return file;
    const { kind, day, proofRef } = input;
    if (typeof kind !== 'string' || !(TRANSFER_DATE_KINDS as readonly string[]).includes(kind)) return { ok: false, rule: null, code: 'kind' };
    if (!validDay(day)) return { ok: false, rule: null, code: 'bad_day' };
    if (typeof proofRef !== 'string' || !PROOF_REF.test(proofRef)) return { ok: false, rule: null, code: 'bad_proof' };
    if (PAST_KINDS.includes(kind as TransferDateKind) && day > this.today()) return { ok: false, rule: null, code: 'future_day' };
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const last = await this.db.first<{ v: number | null }>('SELECT MAX(version) AS v FROM business_transfer_dates WHERE file_id = ? AND kind = ?', [file.id, kind]);
      const version = Number(last?.v ?? 0) + 1;
      const { changes } = await this.db.run(
        'INSERT INTO business_transfer_dates (id, file_id, network_id, kind, day, proof_ref, version, recorded_by, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING',
        [this.newId(), file.id, file.network_id, kind, day, proofRef, version, this.actor(viewer), this.now().toISOString()],
      );
      if (changes !== 1) continue;
      await appendEvent(this.journal, { type: 'commerces.cession.date', actor: this.actor(viewer), subject: `property:${file.property_id}`, data: { kind, version } }, this.now);
      return { ok: true, value: await this.view(file) };
    }
    throw new Error('date de cession : trop d’écritures simultanées');
  }

  /** Le dossier et ses étapes, pour qui voit le bien en entier [R16]. */
  async read(acces: Acces, viewer: Viewer, fileId: string): Promise<TransferResult<TransferView>> {
    const file = await this.fileFor(acces, viewer, fileId, 'read');
    if (!('id' in file)) return file;
    return { ok: true, value: await this.view(file) };
  }

  /** Le dossier de cession d'un bien, s'il y en a un, pour qui voit le bien en entier [R16]. */
  async forProperty(acces: Acces, viewer: Viewer, propertyId: string): Promise<TransferResult<TransferView | null>> {
    const g = await this.gate(acces, viewer, propertyId, 'read');
    if (!g.ok) return g;
    const file = await this.db.first<FileRow>('SELECT id, network_id, property_id FROM business_transfer_files WHERE property_id = ? AND network_id = ?', [propertyId, viewer.networkId]);
    return { ok: true, value: file ? await this.view(file) : null };
  }

  /** L'agent du bien déclare la cession prête : refusé tant qu'une étape bloquante manque [R116]. */
  async declareReady(acces: Acces, viewer: Viewer, fileId: string): Promise<TransferResult<TransferView>> {
    const file = await this.fileFor(acces, viewer, fileId, 'write');
    if (!('id' in file)) return file;
    const v = await this.view(file);
    if (!v.ready) {
      await appendEvent(this.journal, { type: 'commerces.cession.pas_prete', actor: this.actor(viewer), subject: `property:${file.property_id}`, data: { rule: 'R116', missing: v.missing } }, this.now);
      return { ok: false, rule: 'R116', code: 'etapes_bloquantes', missing: v.missing };
    }
    await this.db.run('INSERT INTO business_transfer_ready (id, file_id, network_id, declared_by, declared_at) VALUES (?, ?, ?, ?, ?)', [this.newId(), file.id, file.network_id, this.actor(viewer), this.now().toISOString()]);
    await appendEvent(this.journal, { type: 'commerces.cession.prete', actor: this.actor(viewer), subject: `property:${file.property_id}`, data: { rule: 'R116' } }, this.now);
    return { ok: true, value: await this.view(file) };
  }

  /**
   * La tâche quotidienne : pour chaque dossier ouvert, une tâche à l'agent du bien avant chaque échéance (avance en
   * réglage) et pour chaque date encore à saisir ; une seule par étape et par échéance. Rend le nombre de tâches créées.
   */
  async run(networkId: string): Promise<number> {
    const today = this.today();
    const files = await this.db.all<FileRow & { agent_id: string | null }>(
      'SELECT f.id, f.network_id, f.property_id, p.agent_id FROM business_transfer_files f JOIN properties p ON p.id = f.property_id WHERE f.network_id = ? ORDER BY f.created_at, f.id',
      [networkId],
    );
    let created = 0;
    for (const f of files) {
      if (!f.agent_id) continue;
      const v = await this.view(f);
      for (const l of v.lines) {
        let due: string | null = null;
        if (l.status === 'a_saisir') due = '';
        else if ((l.status === 'a_faire' || l.status === 'en_retard') && l.due && addDays(l.due, -this.notice[l.step]) <= today) due = l.due;
        if (due === null) continue;
        const { changes } = await this.db.run(
          'INSERT INTO business_transfer_tasks (file_id, network_id, agent_id, step, due_day, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING',
          [f.id, networkId, f.agent_id, l.step, due, this.now().toISOString()],
        );
        if (changes !== 1) continue;
        created += 1;
        await appendEvent(this.journal, { type: 'commerces.cession.tache', actor: 'system:commerces', subject: `property:${f.property_id}`, data: { rule: 'R116', step: l.step, ...(due === '' ? {} : { day: due }) } }, this.now);
      }
    }
    return created;
  }

  /** Les tâches de l'agent, pour lui seul, encore utiles : l'étape n'est pas faite et son échéance n'a pas changé. */
  async tasksOf(viewer: Viewer): Promise<TransferResult<TransferTask[]>> {
    if (viewer.role !== 'agent') return this.refuse(viewer, `network:${viewer.networkId}`, 'role');
    const rows = await this.db.all<{ file_id: string; property_id: string; network_id: string; step: TransferStep; due_day: string }>(
      `SELECT k.file_id, f.property_id, f.network_id, k.step, k.due_day FROM business_transfer_tasks k JOIN business_transfer_files f ON f.id = k.file_id
       JOIN properties p ON p.id = f.property_id WHERE k.network_id = ? AND k.agent_id = ? AND p.agent_id = ? ORDER BY k.due_day, k.created_at`,
      [viewer.networkId, viewer.userId, viewer.userId],
    );
    const out: TransferTask[] = [];
    for (const r of rows) {
      const v = await this.view({ id: r.file_id, network_id: r.network_id, property_id: r.property_id });
      const line = v.lines.find((l) => l.step === r.step);
      if (!line || line.status === 'fait' || line.status === 'sans_objet') continue;
      if (r.due_day === '' ? line.status !== 'a_saisir' : line.due !== r.due_day) continue;
      out.push({ fileId: r.file_id, propertyId: r.property_id, step: r.step, due: r.due_day === '' ? null : r.due_day });
    }
    return { ok: true, value: out };
  }

  private async view(file: FileRow): Promise<TransferView> {
    const rows = await this.db.all<{ kind: TransferDateKind; day: string; version: number }>(
      `SELECT d.kind, d.day, d.version FROM business_transfer_dates d
       WHERE d.file_id = ? AND d.version = (SELECT MAX(version) FROM business_transfer_dates e WHERE e.file_id = d.file_id AND e.kind = d.kind)`,
      [file.id],
    );
    const dates: TransferView['dates'] = {};
    for (const r of rows) dates[r.kind] = { day: r.day, version: Number(r.version) };
    const escrow = await this.db.first<{ kind: EscrowKind; name: string; version: number }>('SELECT kind, name, version FROM business_transfer_third_parties WHERE file_id = ? ORDER BY version DESC LIMIT 1', [file.id]);
    const sheet = await this.fiches.current(file.property_id);
    const property = await this.db.first<{ postal_code: string | null; city: string | null }>('SELECT postal_code, city FROM properties WHERE id = ?', [file.property_id]);
    const inPerimeter = await this.inPerimeter(file.network_id, property?.postal_code ?? null, property?.city ?? null);
    const steps = transferSteps({
      employees: sheet?.sheet.employees ?? null,
      licenses: sheet?.sheet.licenses ?? [],
      inPerimeter,
      escrow: escrow ? { kind: escrow.kind, name: escrow.name } : null,
      dates: Object.fromEntries(Object.entries(dates).map(([k, v]) => [k, v!.day])),
      today: this.today(),
    });
    const declared = await this.db.first<{ declared_at: string }>('SELECT declared_at FROM business_transfer_ready WHERE file_id = ? ORDER BY declared_at DESC LIMIT 1', [file.id]);
    return {
      fileId: file.id,
      propertyId: file.property_id,
      dates,
      escrow: escrow ? { kind: escrow.kind, name: escrow.name, version: Number(escrow.version) } : null,
      inPerimeter,
      ...steps,
      declaredReady: declared?.declared_at ?? null,
    };
  }

  /** La commune du bien, à sa dernière version : dans un périmètre de sauvegarde, hors, ou pas encore rangée (`null`). */
  private async inPerimeter(networkId: string, postalCode: string | null, city: string | null): Promise<boolean | null> {
    if (!postalCode || !city) return null;
    const rows = await this.db.all<{ city: string; in_perimeter: number; version: number }>(
      'SELECT city, in_perimeter, version FROM business_safeguard_communes WHERE network_id = ? AND postal_code = ? ORDER BY version DESC',
      [networkId, postalCode],
    );
    const match = rows.filter((r) => norm(r.city) === norm(city)).sort((a, b) => Number(b.version) - Number(a.version))[0];
    return match ? Number(match.in_perimeter) === 1 : null;
  }

  /** Le nom donné désigne-t-il le réseau, AIMMO ou un agent du réseau ? */
  private async isNetworkOrAgent(networkId: string, name: string): Promise<boolean> {
    const n = ` ${norm(name)} `;
    if (n.includes(' aimmo ')) return true;
    const network = await this.db.first<{ name: string }>('SELECT name FROM networks WHERE id = ?', [networkId]);
    if (network?.name && n.includes(` ${norm(network.name)} `)) return true;
    const agents = await this.db.all<{ first_name: string | null; last_name: string | null }>('SELECT first_name, last_name FROM agents WHERE network_id = ?', [networkId]);
    return agents.some((a) => {
      const full = norm(`${a.first_name ?? ''} ${a.last_name ?? ''}`);
      const reversed = norm(`${a.last_name ?? ''} ${a.first_name ?? ''}`);
      return (full.length > 0 && n.includes(` ${full} `)) || (reversed.length > 0 && n.includes(` ${reversed} `));
    });
  }

  private async fileFor(acces: Acces, viewer: Viewer, fileId: string, need: 'read' | 'write'): Promise<FileRow | Refusal | Problem> {
    const file = await this.db.first<FileRow>('SELECT id, network_id, property_id FROM business_transfer_files WHERE id = ?', [fileId]);
    if (!file || file.network_id !== viewer.networkId) {
      await this.refuse(viewer, `network:${viewer.networkId}`, 'unknown');
      return { ok: false, rule: null, code: 'unknown_file' };
    }
    const g = await this.gate(acces, viewer, file.property_id, need);
    if (!g.ok) return g;
    return file;
  }

  /** Qui voit le bien en entier lit ; l'agent du bien et la direction écrivent ; un fonds seulement [R16]. */
  private async gate(acces: Acces, viewer: Viewer, propertyId: string, need: 'read' | 'write'): Promise<{ ok: true } | Refusal | Problem> {
    const read = await acces.readProperty(viewer, propertyId);
    if (!read.ok) return { ok: false, rule: 'R16', code: read.code };
    if (read.view !== 'full') return this.refuse(viewer, `property:${propertyId}`, 'not_assigned');
    if (need === 'write' && !((viewer.role === 'agent' && read.value.agent_id === viewer.userId) || viewer.role === 'direction')) return this.refuse(viewer, `property:${propertyId}`, 'role');
    if (read.value.kind !== 'business') return { ok: false, rule: null, code: 'sorte' };
    return { ok: true };
  }

  private async refuse(viewer: Viewer, subject: string, code: string): Promise<Refusal> {
    await appendEvent(this.journal, { type: 'acces.refuse', actor: this.actor(viewer), subject, data: { rule: 'R16', role: String(viewer.role), kind: 'business_transfer', code } }, this.now);
    return { ok: false, rule: 'R16', code };
  }
}
