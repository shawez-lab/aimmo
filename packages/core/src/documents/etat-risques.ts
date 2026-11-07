/**
 * L'état des risques et la déclaration d'intention d'aliéner préparés depuis le dossier (HX34, M06 et M10).
 *
 * L'état des risques est rempli depuis les données publiques que la collecte de E03 rapporte (Base adresse nationale,
 * cadastre, Géorisques) : chaque rubrique cite sa source et le jour de sa collecte, et ce qui manque est dit avec sa
 * raison, jamais deviné [R444]. Sa date est celle de la donnée la plus ancienne qu'il porte ; il vaut 6 mois. Rangé
 * comme pièce `etat_risques` du dossier, sa fin de validité entre dans le chemin critique de N07, et un état qui aura
 * plus de 6 mois au jour de l'acte est signalé [R445].
 *
 * La déclaration d'intention d'aliéner est préparée pour le notaire : chaque champ rempli dit d'où vient sa valeur
 * (le bien, sa fiche, le dossier, l'échéancier, l'état des risques) ; un champ sans donnée du dossier reste vide avec
 * sa raison, et les noms du propriétaire et de l'acquéreur restent au notaire [R446].
 *
 * Tout s'ajoute, rien ne se réécrit [R447]. Le journal ne porte que des identifiants, des codes et des nombres de
 * champs, jamais une adresse, une parcelle ni un prix [R13]. L'IA n'écrit rien.
 *
 * Décidé, lecture prudente :
 * - la déclaration des sinistres indemnisés est celle du vendeur : l'appli ne la remplit jamais, elle la laisse
 *   « à déclarer par le vendeur » et l'état n'est pas complet sans les données publiques des trois autres rubriques ;
 * - une source qui ne vient pas de la collecte de E03 (nom de source inconnu) ou un jour de collecte dans le futur
 *   sont refusés : on ne range pas une donnée dont on ne sait pas d'où elle vient ;
 * - la date de l'état est le jour, à Paris, de la donnée la plus ancienne : la validité se compte au plus court ;
 * - le jour de l'acte jugé est l'acte prévu s'il est saisi, sinon le jour au plus tôt du chemin critique (N07) ;
 * - la déclaration d'intention d'aliéner n'est pas gardée : elle se recalcule depuis le dossier, et chaque
 *   préparation est écrite au journal.
 */
import type { Acces } from '../acces/acces.ts';
import type { Viewer } from '../acces/droits.ts';
import type { PropertySheet } from '../annonces/fiche-bien.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { DEFAULT_VALIDITY_MONTHS, validUntil } from '../dossiers/acte.ts';
import { actorOf, gateSaleFile, type FileRefusal, type FileUnknown } from '../dossiers/acces-dossier.ts';
import { CheminCritique } from '../dossiers/chemin-critique.ts';
import { Echeancier } from '../dossiers/echeancier.ts';
import { PiecesDossier, type FileStatus, type PieceProblem, type PieceStore } from '../dossiers/pieces.ts';
import { localTime } from '../envoi/horaires.ts';
import { SOURCES, type Collected, type Geocoded, type Parcel, type PublicFacts, type Risk } from '../estimation/collecte.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import { sha256 } from './modeles.ts';

const TIME_ZONE = 'Europe/Paris';
/** Durée de validité de l'état des risques, en mois : la même que celle de la pièce au jour de l'acte (N06). */
export const RISK_STATEMENT_VALIDITY_MONTHS = DEFAULT_VALIDITY_MONTHS.etat_risques ?? 6;

export const RUBRICS = ['adresse', 'parcelle', 'risques', 'sinistres_indemnises'] as const;
export type Rubric = (typeof RUBRICS)[number];

/** Une rubrique de l'état : remplie avec sa source et son jour de collecte, ou non remplie avec sa raison [R444]. */
export type RubricLine =
  | { rubric: 'adresse'; filled: true; value: { label: string; postalCode: string; inseeCode: string; town: string }; source: string; collectedOn: string }
  | { rubric: 'parcelle'; filled: true; value: { id: string; section: string; number: string }; source: string; collectedOn: string }
  | { rubric: 'risques'; filled: true; value: Risk[]; source: string; collectedOn: string }
  | { rubric: Exclude<Rubric, 'sinistres_indemnises'>; filled: false; value: null; source: string; collectedOn: string; reason: 'introuvable' | 'panne' | 'adresse_introuvable' | 'adresse_incertaine' }
  | { rubric: 'sinistres_indemnises'; filled: false; value: null; source: 'déclaration du vendeur'; collectedOn: null; reason: 'a_declarer_par_le_vendeur' };

export interface RiskStatement {
  id: string;
  fileId: string;
  version: number;
  rubrics: RubricLine[];
  /** Les trois rubriques publiques sont remplies : l'état peut se ranger comme pièce. */
  complete: boolean;
  /** Le jour de la donnée la plus ancienne, ou null si aucune n'est remplie. */
  statementDate: string | null;
  /** Le dernier jour de validité, ou null. */
  validUntil: string | null;
  hash: string;
  preparedAt: string;
}

export type StatementProblem = { ok: false; rule: null; code: 'bad_facts' | 'unknown_statement' | 'incomplete' | 'not_latest' | 'no_statement' | 'busy' };
type Res<T> = { ok: true; value: T } | FileRefusal | FileUnknown | StatementProblem;

/** La validité de l'état au jour de l'acte [R445]. */
export interface StatementValidity {
  statementId: string;
  statementDate: string;
  validUntil: string;
  /** Le jour de l'acte jugé : l'acte prévu, sinon le jour au plus tôt ; null s'il ne se calcule pas. */
  actDay: string | null;
  actDaySource: 'acte_prevu' | 'au_plus_tot' | null;
  /** true : l'état aura plus de 6 mois au jour de l'acte. */
  expiredAtAct: boolean;
}

// --- Les champs de la déclaration d'intention d'aliéner ---------------------------------------------------------

export const DIA_FIELDS = ['commune', 'adresse', 'parcelle', 'nature', 'lot_copropriete', 'surface_habitable', 'surface_terrain', 'prix', 'date_acte_prevue', 'honoraires', 'proprietaire', 'acquereur'] as const;
export type DiaField = (typeof DIA_FIELDS)[number];

/** D'où vient la valeur d'un champ : une donnée du dossier nommée, jamais une saisie libre [R446]. */
export type DiaOrigin =
  | { kind: 'bien'; ref: string }
  | { kind: 'fiche'; ref: string; version: number }
  | { kind: 'dossier'; ref: string }
  | { kind: 'echeancier'; ref: string; version: number }
  | { kind: 'etat_risques'; ref: string; source: string; collectedOn: string };

export type DiaLine =
  | { field: DiaField; value: string | number; from: DiaOrigin }
  | { field: DiaField; value: null; from: null; reason: 'absent_du_dossier' | 'tenu_par_le_notaire' | 'sans_objet' };

export interface DiaDraft {
  fileId: string;
  preparedAt: string;
  lines: DiaLine[];
  /** Les champs que le notaire doit compléter. */
  toComplete: DiaField[];
}

const KIND_LABEL: Record<string, string> = { home: 'immeuble bâti', building: 'immeuble bâti', land: 'terrain non bâti', commercial: 'local commercial', business_walls: 'murs commerciaux', business: 'fonds de commerce' };

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const isStr = (v: unknown, max = 300): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;

interface StatementRow {
  id: string;
  file_id: string;
  version: number;
  content: string;
  complete: number;
  statement_date: string | null;
  valid_until: string | null;
  hash: string;
  prepared_at: string;
}

export class EtatRisques {
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly pieces: PiecesDossier;
  private readonly chemin: CheminCritique;
  private readonly echeancier: Echeancier;

  constructor(
    private readonly db: SqlDatabase,
    private readonly acces: Acces,
    private readonly journal: JournalStore,
    store: PieceStore,
    options: { now?: () => Date; newId?: () => string } = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => crypto.randomUUID());
    this.pieces = new PiecesDossier(db, acces, journal, store, { now: this.now });
    this.chemin = new CheminCritique(db, acces, journal, store, { now: this.now });
    this.echeancier = new Echeancier(db, acces, journal, { now: this.now });
  }

  private gate(viewer: Viewer, fileId: string, write: boolean, kind: string) {
    return gateSaleFile({ db: this.db, acces: this.acces, journal: this.journal, now: this.now }, viewer, fileId, write, kind);
  }

  /** Le jour à Paris d'une heure de collecte, ou null si elle est mal formée ou dans le futur. */
  private dayOf(collectedAt: unknown): string | null {
    if (typeof collectedAt !== 'string' || !ISO.test(collectedAt)) return null;
    const t = Date.parse(collectedAt);
    if (Number.isNaN(t) || t > this.now().getTime()) return null;
    return localTime(new Date(t), TIME_ZONE).date;
  }

  /** Les rubriques, depuis ce que la collecte de E03 a rapporté ; null si une donnée n'en vient pas [R444]. */
  rubricsOf(facts: PublicFacts): RubricLine[] | null {
    const lines: RubricLine[] = [];
    const take = <T>(rubric: Exclude<Rubric, 'sinistres_indemnises'>, c: Collected<T> | undefined, source: string, read: (v: T) => RubricLine['value'] | null): boolean => {
      if (!c || typeof c !== 'object' || c.source !== source) return false;
      const collectedOn = this.dayOf(c.collectedAt);
      if (collectedOn === null) return false;
      if (!c.ok) {
        if (!['introuvable', 'panne', 'adresse_introuvable', 'adresse_incertaine'].includes(c.reason)) return false;
        lines.push({ rubric, filled: false, value: null, source, collectedOn, reason: c.reason });
        return true;
      }
      const value = read(c.value);
      if (value === null) return false;
      lines.push({ rubric, filled: true, value, source, collectedOn } as RubricLine);
      return true;
    };
    const okAddress = take<Geocoded>('adresse', facts?.address, SOURCES.address, (g) =>
      isStr(g?.label) && isStr(g.postalCode, 10) && isStr(g.inseeCode, 10) && isStr(g.town, 100) ? { label: g.label, postalCode: g.postalCode, inseeCode: g.inseeCode, town: g.town } : null,
    );
    const okParcel = take<Parcel>('parcelle', facts?.parcel, SOURCES.parcel, (p) => (isStr(p?.id, 40) && isStr(p.section, 10) && isStr(p.number, 10) ? { id: p.id, section: p.section, number: p.number } : null));
    const okRisks = take<Risk[]>('risques', facts?.risks, SOURCES.risks, (rs) =>
      Array.isArray(rs) && rs.length <= 100 && rs.every((r) => isStr(r?.code, 20) && isStr(r.label, 200)) ? rs.map((r) => ({ code: r.code, label: r.label })) : null,
    );
    if (!okAddress || !okParcel || !okRisks) return null;
    lines.push({ rubric: 'sinistres_indemnises', filled: false, value: null, source: 'déclaration du vendeur', collectedOn: null, reason: 'a_declarer_par_le_vendeur' });
    return lines;
  }

  private toStatement(r: StatementRow): RiskStatement {
    return {
      id: r.id,
      fileId: r.file_id,
      version: Number(r.version),
      rubrics: JSON.parse(r.content) as RubricLine[],
      complete: Number(r.complete) === 1,
      statementDate: r.statement_date,
      validUntil: r.valid_until,
      hash: r.hash,
      preparedAt: r.prepared_at,
    };
  }

  private async latestRow(fileId: string): Promise<StatementRow | null> {
    return this.db.first<StatementRow>('SELECT id, file_id, version, content, complete, statement_date, valid_until, hash, prepared_at FROM risk_statements WHERE file_id = ? ORDER BY version DESC LIMIT 1', [fileId]);
  }

  /** L'agent du bien prépare l'état depuis la collecte de E03 ; chaque préparation est une nouvelle version [R444, R447]. */
  async prepare(viewer: Viewer, fileId: string, facts: PublicFacts): Promise<Res<RiskStatement>> {
    const g = await this.gate(viewer, fileId, true, 'risk_statement');
    if (!g.ok) return g;
    const rubrics = this.rubricsOf(facts);
    if (!rubrics) return { ok: false, rule: null, code: 'bad_facts' };
    const publicLines = rubrics.filter((l) => l.rubric !== 'sinistres_indemnises');
    const complete = publicLines.every((l) => l.filled);
    const days = rubrics.filter((l) => l.filled).map((l) => l.collectedOn as string).sort();
    const statementDate = days[0] ?? null;
    const until = statementDate === null ? null : validUntil(statementDate, RISK_STATEMENT_VALIDITY_MONTHS);
    const content = JSON.stringify(rubrics);
    const hash = await sha256(content);
    const last = await this.latestRow(fileId);
    const version = last ? Number(last.version) + 1 : 1;
    const id = this.newId();
    const preparedAt = this.now().toISOString();
    try {
      await this.db.run(
        `INSERT INTO risk_statements (id, network_id, file_id, version, content, complete, statement_date, valid_until, hash, prepared_by, prepared_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, g.file.network_id, fileId, version, content, complete ? 1 : 0, statementDate, until, hash, actorOf(viewer), preparedAt],
      );
    } catch {
      return { ok: false, rule: null, code: 'busy' };
    }
    await appendEvent(this.journal, { type: 'dossier.etat_risques_prepare', actor: actorOf(viewer), subject: `sale_file:${fileId}`, data: { statement: id, version, complete, filled: rubrics.filter((l) => l.filled).length } }, this.now);
    return { ok: true, value: { id, fileId, version, rubrics, complete, statementDate, validUntil: until, hash, preparedAt } };
  }

  /** Le dernier état préparé, lu par qui voit le dossier en entier [R16]. */
  async latest(viewer: Viewer, fileId: string): Promise<Res<RiskStatement>> {
    const g = await this.gate(viewer, fileId, false, 'risk_statement');
    if (!g.ok) return g;
    const row = await this.latestRow(fileId);
    return row ? { ok: true, value: this.toStatement(row) } : { ok: false, rule: null, code: 'no_statement' };
  }

  /**
   * L'agent du bien range le dernier état complet comme pièce `etat_risques`, daté du jour de l'état : sa fin de
   * validité entre ainsi dans le chemin critique de N07 [R445]. La référence est celle du fichier rendu et déposé.
   */
  async range(viewer: Viewer, fileId: string, input: { statementId: string; ref: string }): Promise<{ ok: true; value: FileStatus } | FileRefusal | FileUnknown | StatementProblem | PieceProblem> {
    const g = await this.gate(viewer, fileId, true, 'risk_statement');
    if (!g.ok) return g;
    const last = await this.latestRow(fileId);
    if (!last || typeof input?.statementId !== 'string') return { ok: false, rule: null, code: 'unknown_statement' };
    if (last.id !== input.statementId) {
      const known = await this.db.first('SELECT 1 FROM risk_statements WHERE id = ? AND file_id = ?', [input.statementId, fileId]);
      return { ok: false, rule: null, code: known ? 'not_latest' : 'unknown_statement' };
    }
    if (Number(last.complete) !== 1 || last.statement_date === null) return { ok: false, rule: null, code: 'incomplete' };
    const r = await this.pieces.add(viewer, fileId, { piece: 'etat_risques', ref: input.ref, issuedOn: last.statement_date });
    if (r.ok) await appendEvent(this.journal, { type: 'dossier.etat_risques_range', actor: actorOf(viewer), subject: `sale_file:${fileId}`, data: { statement: last.id, version: Number(last.version) } }, this.now);
    return r;
  }

  /** La validité du dernier état au jour de l'acte : un état de plus de 6 mois ce jour-là est signalé [R445]. */
  async validity(viewer: Viewer, fileId: string): Promise<Res<StatementValidity>> {
    const g = await this.gate(viewer, fileId, false, 'risk_statement');
    if (!g.ok) return g;
    const last = await this.latestRow(fileId);
    if (!last) return { ok: false, rule: null, code: 'no_statement' };
    if (last.statement_date === null || last.valid_until === null) return { ok: false, rule: null, code: 'incomplete' };
    const path = await this.chemin.of(viewer, fileId);
    if (!path.ok) return path;
    const planned = path.value.path.plannedActDay;
    const earliest = path.value.path.earliestActDay;
    const actDay = planned ?? earliest;
    const actDaySource = planned !== null ? 'acte_prevu' : earliest !== null ? 'au_plus_tot' : null;
    const expiredAtAct = actDay !== null && last.valid_until < actDay;
    if (expiredAtAct) await appendEvent(this.journal, { type: 'dossier.etat_risques_perime_a_l_acte', actor: actorOf(viewer), subject: `sale_file:${fileId}`, data: { statement: last.id, source: actDaySource } }, this.now);
    return { ok: true, value: { statementId: last.id, statementDate: last.statement_date, validUntil: last.valid_until, actDay, actDaySource, expiredAtAct } };
  }

  /** La déclaration d'intention d'aliéner préparée pour le notaire : aucun champ sans donnée du dossier [R446]. */
  async dia(viewer: Viewer, fileId: string): Promise<Res<DiaDraft>> {
    const g = await this.gate(viewer, fileId, false, 'dia_draft');
    if (!g.ok) return g;
    const file = g.file;
    const property = await this.db.first<{ id: string; kind: string; postal_code: string | null; city: string | null; surface_m2: number | null }>('SELECT id, kind, postal_code, city, surface_m2 FROM properties WHERE id = ?', [file.property_id]);
    const sale = await this.db.first<{ amount_eur: number }>('SELECT amount_eur FROM sale_files WHERE id = ?', [fileId]);
    const sheetRow = await this.db.first<{ data: string; version: number }>('SELECT data, version FROM property_sheets WHERE property_id = ? ORDER BY version DESC LIMIT 1', [file.property_id]);
    const sheet = sheetRow ? (JSON.parse(sheetRow.data) as PropertySheet) : null;
    const schedule = await this.echeancier.scheduleOf(file);
    const st = await this.latestRow(fileId);
    const rubrics = st ? (JSON.parse(st.content) as RubricLine[]) : [];
    const rubric = <R extends 'adresse' | 'parcelle'>(name: R) => rubrics.find((l): l is Extract<RubricLine, { rubric: R; filled: true }> => l.rubric === name && l.filled);

    const lines: DiaLine[] = [];
    const none = (field: DiaField, reason: 'absent_du_dossier' | 'tenu_par_le_notaire' | 'sans_objet') => lines.push({ field, value: null, from: null, reason });
    const put = (field: DiaField, value: string | number | null | undefined, from: DiaOrigin) => (value === null || value === undefined || value === '' ? none(field, 'absent_du_dossier') : lines.push({ field, value, from }));
    const bien: DiaOrigin = { kind: 'bien', ref: `property:${file.property_id}` };
    const fiche = (): DiaOrigin | null => (sheetRow ? { kind: 'fiche', ref: `property:${file.property_id}`, version: Number(sheetRow.version) } : null);

    put('commune', property?.postal_code && property.city ? `${property.postal_code} ${property.city}` : null, bien);
    const addr = rubric('adresse');
    if (addr) put('adresse', addr.value.label, { kind: 'etat_risques', ref: `risk_statement:${st!.id}`, source: addr.source, collectedOn: addr.collectedOn });
    else none('adresse', 'absent_du_dossier');
    const parcel = rubric('parcelle');
    if (parcel) put('parcelle', `section ${parcel.value.section}, n° ${parcel.value.number} (${parcel.value.id})`, { kind: 'etat_risques', ref: `risk_statement:${st!.id}`, source: parcel.source, collectedOn: parcel.collectedOn });
    else none('parcelle', 'absent_du_dossier');
    put('nature', property ? KIND_LABEL[property.kind] : null, bien);
    const f = fiche();
    if (f && sheet?.coownership) put('lot_copropriete', sheet.coownership.isCoownership ? 'oui' : 'non', f);
    else none('lot_copropriete', 'absent_du_dossier');
    if (property?.kind === 'land') none('surface_habitable', 'sans_objet');
    else put('surface_habitable', property?.surface_m2 ?? null, bien);
    if (f && sheet?.characteristics?.landM2 != null) put('surface_terrain', sheet.characteristics.landM2, f);
    else none('surface_terrain', 'absent_du_dossier');
    put('prix', sale?.amount_eur ?? null, { kind: 'dossier', ref: `sale_file:${fileId}` });
    const acte = schedule.dates.acte_prevu;
    if (acte) put('date_acte_prevue', acte.day, { kind: 'echeancier', ref: `sale_file:${fileId}`, version: acte.version });
    else none('date_acte_prevue', 'absent_du_dossier');
    // Les honoraires ne sont pas encore une donnée du dossier de vente : le notaire les reprend du mandat.
    none('honoraires', 'absent_du_dossier');
    // Les noms des parties : le notaire les tient du titre et de l'avant-contrat, l'appli ne les recopie pas [R16].
    none('proprietaire', 'tenu_par_le_notaire');
    none('acquereur', 'tenu_par_le_notaire');

    const toComplete = lines.filter((l) => l.value === null && l.reason !== 'sans_objet').map((l) => l.field);
    await appendEvent(this.journal, { type: 'dossier.dia_preparee', actor: actorOf(viewer), subject: `sale_file:${fileId}`, data: { filled: lines.length - lines.filter((l) => l.value === null).length, toComplete: toComplete.length } }, this.now);
    return { ok: true, value: { fileId, preparedAt: this.now().toISOString(), lines, toComplete } };
  }
}
