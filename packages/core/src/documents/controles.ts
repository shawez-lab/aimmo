/**
 * Les contrôles avant signature (M06, D03) [R41].
 *
 * Avant toute signature, le document passe un contrôle écrit, ligne par ligne :
 * - champs : tous les champs du modèle sont remplis ;
 * - modèle : le modèle est validé (un document d'essai ne se signe jamais pour de vrai) ;
 * - honoraires : montant, prix et qui les paie connus, montant dans le barème du réseau (taux maximal du prix et
 *   minimum, réglés par la direction) ;
 * - mandants : les propriétaires du bien connus dans la base sont exactement le mandant du document ;
 * - identité : l'identité de chaque mandant est vérifiée au coffre de la conformité, pièce valide ce jour-là et vérifiée depuis
 *   moins d'un an ; pour une société, son Kbis et chaque bénéficiaire effectif à 25 % ou plus (L03) [R92].
 * - questionnaire : pour un mandat préparé par questionnaire (HX33), l'écart de prix a été montré au vendeur [R441].
 * Un seul échec suffit : le document ne peut pas être signé. Le résultat est gardé et rendu à l'agent.
 *
 * Décidé, lecture prudente : un bien à plusieurs propriétaires (couple, indivision) ne passe que si le document les
 * nomme tous comme mandants, chacun avec sa propre fiche, jamais réunies (AU001) ; l'identité de chacun est vérifiée, et
 * la première qui manque est dite. Un bien sans propriétaire connu ne passe pas. L'identité vérifiée ne garde ni
 * numéro ni copie de la pièce, qui vivent dans le coffre de la conformité [R15]. Le journal ne porte que des codes
 * [R13]. Droits : ceux de la fiche et du bien [R16].
 */
import type { Acces } from '../acces/acces.ts';
import type { Viewer } from '../acces/droits.ts';
import { runBatch, type SqlDatabase } from '../db/sql.ts';
import { FicheClient } from '../db/fiche-client.ts';
import { FicheUnique } from '../fiche/fusion.ts';
import { Identification } from '../conformite/identification.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import type { DocumentFacts } from './modeles.ts';
import { mandateEndDay, mandateExpired, mandateTerms } from './conditions.ts';
import { localTime } from '../envoi/horaires.ts';

import { IDENTITY_PIECES } from '../conformite/pieces-identite.ts';
import { MANDATE_DESIGNATION_FIELDS } from './designation.ts';

/**
 * Les mandants d'un document, dans l'ordre où il les nomme : son premier mandant, puis les autres (AU001).
 */
export async function documentMandants(db: SqlDatabase, documentId: string, firstPersonId: string): Promise<string[]> {
  // Une base d'avant la migration 3920 n'a qu'un mandant par document.
  if (!(await db.first(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'document_co_mandants'`))) return [firstPersonId];
  const rows = await db.all<{ person_id: string }>('SELECT person_id FROM document_co_mandants WHERE document_id = ? ORDER BY position', [documentId]);
  return [firstPersonId, ...rows.map((r) => r.person_id)];
}
/**
 * Les fiches qu'un document nomme : ses mandants, puis les représentants de ceux qui le sont (AU059). Qui lit le
 * document, son exemplaire ou son dossier les voit toutes en entier [R16].
 */
export async function documentPersons(db: SqlDatabase, documentId: string, firstPersonId: string): Promise<string[]> {
  const mandants = await documentMandants(db, documentId, firstPersonId);
  return [...mandants, ...(await documentProxies(db, documentId)).map((p) => p.proxyId)];
}

/** Les droits des mandants sur le bien, s'ils sont dits (AU060) ; vide sinon, et pour une base d'avant la migration 4047. */
export async function documentRights(db: SqlDatabase, documentId: string): Promise<{ personId: string; right: 'pleine_propriete' | 'usufruit' | 'nue_propriete'; proofRef: string | null }[]> {
  if (!(await db.first(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'document_mandant_rights'`))) return [];
  const rows = await db.all<{ person_id: string; right_kind: 'pleine_propriete' | 'usufruit' | 'nue_propriete'; proof_ref: string | null }>(
    'SELECT person_id, right_kind, proof_ref FROM document_mandant_rights WHERE document_id = ? ORDER BY person_id',
    [documentId],
  );
  return rows.map((r) => ({ personId: r.person_id, right: r.right_kind, proofRef: r.proof_ref }));
}

export const POWER_KINDS = ['notariee', 'sous_seing_prive'] as const;
export type PowerKind = (typeof POWER_KINDS)[number];

/** Les procurations d'un document (AU059) : qui est représenté, par qui ; vide pour un document sans procuration. */
export async function documentProxies(db: SqlDatabase, documentId: string): Promise<{ mandantId: string; proxyId: string; powerKind: PowerKind; grantedOn: string; powerRef: string }[]> {
  // Une base d'avant la migration 4020 n'a aucune procuration.
  if (!(await db.first(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'document_proxies'`))) return [];
  const rows = await db.all<{ mandant_person_id: string; proxy_person_id: string; power_kind: PowerKind; granted_on: string; power_ref: string }>(
    'SELECT mandant_person_id, proxy_person_id, power_kind, granted_on, power_ref FROM document_proxies WHERE document_id = ? ORDER BY mandant_person_id',
    [documentId],
  );
  return rows.map((r) => ({ mandantId: r.mandant_person_id, proxyId: r.proxy_person_id, powerKind: r.power_kind, grantedOn: r.granted_on, powerRef: r.power_ref }));
}

export { IDENTITY_PIECES, type IdentityPiece } from '../conformite/pieces-identite.ts';
export const CHECK_NAMES = ['champs', 'modele', 'honoraires', 'mandants', 'identite', 'mandat', 'questionnaire', 'procuration', 'droits'] as const;
export type CheckName = (typeof CHECK_NAMES)[number];

export interface CheckLine {
  check: CheckName;
  ok: boolean;
  /** Pourquoi, en un code : jamais une donnée personnelle. */
  code: string;
}

export interface SignatureCheck {
  documentId: string;
  passed: boolean;
  lines: CheckLine[];
  checkedAt: string;
}

export interface ControlSettings {
  /** Durée de validité d'une identité vérifiée, en jours. */
  identityDays: number;
}
export const DEFAULT_CONTROL_SETTINGS: ControlSettings = Object.freeze({ identityDays: 365 });

type Refusal = { ok: false; rule: 'R16'; code: string };
type Problem = { ok: false; rule: null; code: 'bad_schedule' | 'bad_tiers' | 'bad_piece' | 'bad_date' | 'unknown_document' };

const DAY = 86_400_000;
const placeholders = (n: number): string => Array.from({ length: n }, () => '?').join(', ');

/** Une tranche du barème (AU058) : jusqu'à ce prix (null : au-delà), un plafond en taux du prix ou en forfait. */
export interface FeeTier {
  upToEur: number | null;
  ratePercent?: number;
  flatEur?: number;
}

export class ControlesSignature {
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly settings: ControlSettings;
  private readonly unique: FicheUnique;
  private readonly identification: Identification;

  constructor(
    private readonly db: SqlDatabase,
    private readonly acces: Acces,
    private readonly journal: JournalStore,
    private readonly options: {
      now?: () => Date;
      newId?: () => string;
      settings?: ControlSettings;
      /**
       * Le stockage des scans du mandat (D14), où la procuration d'un mandant représenté doit se trouver (AU059). Nul ou
       * absent : la procuration ne se vérifie pas, et le document ne passe pas.
       */
      scans?: { has(ref: string): Promise<boolean> } | null;
      /** Où vérifier la procuration, quand ce n'est pas `scans` (la signature en ligne, qui n'a pas de scan) (AU059). */
      powers?: { has(ref: string): Promise<boolean> } | null;
    } = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => crypto.randomUUID());
    this.settings = options.settings ?? DEFAULT_CONTROL_SETTINGS;
    this.unique = new FicheUnique(db, new FicheClient(db, { now: this.now }), { now: this.now });
    this.identification = new Identification(db, null, null, { now: this.now, maxAgeDays: this.settings.identityDays });
  }

  private actor(viewer: Viewer): string {
    return `${String(viewer.role)}:${viewer.userId}`;
  }

  private async refuse(viewer: Viewer, kind: string, code: string, subject: string | null = null): Promise<Refusal> {
    await appendEvent(this.journal, { type: 'acces.refuse', actor: this.actor(viewer), subject, data: { rule: 'R16', role: String(viewer.role), kind, code } }, this.now);
    return { ok: false, rule: 'R16', code };
  }

  /** Le barème en vigueur, ou null s'il n'y en a pas encore : la direction seule [R16, R41]. */
  async readFeeSchedule(viewer: Viewer): Promise<{ ok: true; value: { maxRatePercent: number; minEur: number; setAt: string; tiers: FeeTier[] } | null } | Refusal> {
    if (viewer.role !== 'direction') return this.refuse(viewer, 'fee_schedule', 'role');
    const row = await this.db.first<{ id: string; max_rate_bp: number; min_eur: number; set_at: string }>('SELECT id, max_rate_bp, min_eur, set_at FROM fee_schedules WHERE network_id = ? ORDER BY set_at DESC, rowid DESC LIMIT 1', [viewer.networkId]);
    return { ok: true, value: row ? { maxRatePercent: Number(row.max_rate_bp) / 100, minEur: Number(row.min_eur), setAt: row.set_at, tiers: await this.tiersOf(row.id) } : null };
  }

  /** Les tranches d'un barème, dans l'ordre (AU058). */
  private async tiersOf(scheduleId: string): Promise<FeeTier[]> {
    // Une base d'avant la migration 4019 n'a aucune tranche : le barème y est un plafond seul.
    if (!(await this.db.first(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'fee_schedule_tiers'`))) return [];
    const rows = await this.db.all<{ up_to_eur: number | null; rate_bp: number | null; flat_eur: number | null }>('SELECT up_to_eur, rate_bp, flat_eur FROM fee_schedule_tiers WHERE schedule_id = ? ORDER BY position', [scheduleId]);
    return rows.map((r) => ({ upToEur: r.up_to_eur === null ? null : Number(r.up_to_eur), ...(r.rate_bp !== null ? { ratePercent: Number(r.rate_bp) / 100 } : { flatEur: Number(r.flat_eur) }) }));
  }

  /** Le barème des honoraires : la direction seule ; le dernier réglé est en vigueur. */
  async setFeeSchedule(viewer: Viewer, schedule: { maxRatePercent: number; minEur: number; tiers?: unknown }): Promise<{ ok: true } | Refusal | Problem> {
    if (viewer.role !== 'direction') return this.refuse(viewer, 'fee_schedule', 'role');
    const toBp = (v: unknown): number | null => {
      if (typeof v !== 'number' || !Number.isFinite(v)) return null;
      const b = Math.round(v * 100);
      return b >= 1 && b <= 10_000 && Math.abs(b - v * 100) <= 1e-6 ? b : null;
    };
    const bp = toBp(schedule.maxRatePercent);
    if (bp === null) return { ok: false, rule: null, code: 'bad_schedule' };
    if (!Number.isInteger(schedule.minEur) || schedule.minEur < 0) return { ok: false, rule: null, code: 'bad_schedule' };
    // AU058 · des tranches de prix, chacune avec son plafond en taux ou en forfait ; bornes croissantes, seule la
    // dernière peut rester ouverte.
    const raw = schedule.tiers === undefined || schedule.tiers === null ? [] : schedule.tiers;
    if (!Array.isArray(raw) || raw.length > 10) return { ok: false, rule: null, code: 'bad_tiers' };
    const tiers: { upTo: number | null; rate: number | null; flat: number | null }[] = [];
    for (const [i, t] of raw.entries()) {
      if (typeof t !== 'object' || t === null || Object.keys(t).some((k) => !['upToEur', 'ratePercent', 'flatEur'].includes(k))) return { ok: false, rule: null, code: 'bad_tiers' };
      const { upToEur, ratePercent, flatEur } = t as Record<string, unknown>;
      const upTo = upToEur === null || upToEur === undefined ? null : Number.isInteger(upToEur) && (upToEur as number) >= 1 ? (upToEur as number) : NaN;
      if (Number.isNaN(upTo) || (upTo === null && i !== raw.length - 1)) return { ok: false, rule: null, code: 'bad_tiers' };
      const previous = tiers.at(-1);
      if (previous && upTo !== null && previous.upTo !== null && upTo <= previous.upTo) return { ok: false, rule: null, code: 'bad_tiers' };
      const rate = ratePercent === undefined ? null : toBp(ratePercent);
      const flat = flatEur === undefined ? null : Number.isInteger(flatEur) && (flatEur as number) >= 0 ? (flatEur as number) : NaN;
      if ((ratePercent === undefined) === (flatEur === undefined) || (ratePercent !== undefined && rate === null) || Number.isNaN(flat)) return { ok: false, rule: null, code: 'bad_tiers' };
      tiers.push({ upTo, rate, flat });
    }
    const id = this.newId();
    // Le barème et ses tranches en un seul lot, tout ou rien : jamais un barème en vigueur sans toutes ses tranches.
    await runBatch(this.db, [
      { sql: 'INSERT INTO fee_schedules (id, network_id, max_rate_bp, min_eur, set_by, set_at) VALUES (?, ?, ?, ?, ?, ?)', params: [id, viewer.networkId, bp, schedule.minEur, this.actor(viewer), this.now().toISOString()] },
      ...tiers.map((t, i) => ({ sql: 'INSERT INTO fee_schedule_tiers (schedule_id, position, up_to_eur, rate_bp, flat_eur) VALUES (?, ?, ?, ?, ?)', params: [id, i + 1, t.upTo, t.rate, t.flat] })),
    ]);
    await appendEvent(this.journal, { type: 'bareme.regle', actor: this.actor(viewer), subject: null, data: { maxRateBp: bp, minEur: schedule.minEur, tiers: tiers.length } }, this.now);
    return { ok: true };
  }

  /**
   * La trace « pièce vue » d'une personne (D03), gardée pour l'historique : depuis L03, elle ne suffit plus, seul le
   * coffre de la conformité fait foi [R92].
   */
  async recordIdentity(viewer: Viewer, personId: string, input: { piece: string; seenAt: Date }): Promise<{ ok: true; id: string } | Refusal | Problem> {
    if (!(IDENTITY_PIECES as readonly string[]).includes(input.piece)) return { ok: false, rule: null, code: 'bad_piece' };
    if (!(input.seenAt instanceof Date) || Number.isNaN(input.seenAt.getTime()) || input.seenAt.getTime() > this.now().getTime()) return { ok: false, rule: null, code: 'bad_date' };
    if (viewer.role !== 'agent' && viewer.role !== 'compliance') return this.refuse(viewer, 'identity', 'role', `person:${personId}`);
    const read = await this.acces.readFiche(viewer, personId);
    if (!read.ok) return read;
    if (read.view !== 'full') return this.refuse(viewer, 'identity', 'not_assigned', `person:${personId}`);
    const id = this.newId();
    await this.db.run('INSERT INTO identity_checks (id, network_id, person_id, piece, seen_at, checked_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [
      id,
      viewer.networkId,
      read.value.person.id,
      input.piece,
      input.seenAt.toISOString(),
      this.actor(viewer),
      this.now().toISOString(),
    ]);
    await appendEvent(this.journal, { type: 'identite.verifiee', actor: this.actor(viewer), subject: `person:${read.value.person.id}`, data: { piece: input.piece } }, this.now);
    return { ok: true, id };
  }

  /**
   * Le contrôle d'un document avant signature : chaque ligne, et le verdict ; gardé et écrit au journal [R41]. Pour un
   * mandat signé sur papier et enregistré après coup, `identitySignedAt` juge l'identité au jour de la signature (L03) :
   * une pièce vérifiée après ne la couvre pas, une pièce valide ce jour-là, échue depuis, ne la bloque pas [R92].
   */
  /** Le modèle du document a la place de chaque champ de désignation (AU002). */
  private async designated(documentId: string): Promise<boolean> {
    const row = await this.db.first<{ fields: string }>('SELECT t.fields FROM documents d JOIN document_templates t ON t.id = d.template_id WHERE d.id = ?', [documentId]);
    let fields: unknown = null;
    try {
      fields = row ? JSON.parse(row.fields) : null;
    } catch {
      fields = null;
    }
    return Array.isArray(fields) && MANDATE_DESIGNATION_FIELDS.every((f) => fields.includes(f));
  }

  async check(viewer: Viewer, documentId: string, options: { identitySignedAt?: Date; signedAt?: Date } = {}): Promise<{ ok: true; value: SignatureCheck } | Refusal | Problem> {
    if (viewer.role !== 'agent' && viewer.role !== 'direction' && viewer.role !== 'compliance') return this.refuse(viewer, 'document', 'role', `document:${documentId}`);
    const doc = await this.db.first<{ id: string; network_id: string; kind: string; mode: string; status: string; person_id: string; property_id: string | null; facts: string | null; mandate_id: string | null }>(
      'SELECT id, network_id, kind, mode, status, person_id, property_id, facts, mandate_id FROM documents WHERE id = ?',
      [documentId],
    );
    if (!doc || doc.network_id !== viewer.networkId) return this.refuse(viewer, 'document', 'unknown', `document:${documentId}`);
    const fiche = await this.acces.readFiche(viewer, doc.person_id);
    if (!fiche.ok) return fiche;
    if (fiche.view !== 'full') return this.refuse(viewer, 'document', 'not_assigned', `document:${documentId}`);
    if (doc.property_id) {
      const property = await this.acces.readProperty(viewer, doc.property_id);
      if (!property.ok) return property;
      if (property.view !== 'full') return this.refuse(viewer, 'document', 'not_assigned', `document:${documentId}`);
    }

    // Chaque autre mandant est une fiche : qui contrôle le document les voit toutes en entier (AU001) [R16].
    const persons = await documentMandants(this.db, doc.id, doc.person_id);
    for (const personId of persons.slice(1)) {
      const co = await this.acces.readFiche(viewer, personId);
      if (!co.ok) return co;
      if (co.view !== 'full') return this.refuse(viewer, 'document', 'not_assigned', `document:${documentId}`);
    }

    // Chaque représentant nommé au document (AU059) : qui le contrôle le voit aussi en entier [R16].
    const proxies = await documentProxies(this.db, doc.id);
    for (const p of proxies) {
      const proxy = await this.acces.readFiche(viewer, p.proxyId);
      if (!proxy.ok) return proxy;
      if (proxy.view !== 'full') return this.refuse(viewer, 'document', 'not_assigned', `document:${documentId}`);
    }

    const at = this.now();
    const lines: CheckLine[] = [];
    // Un mandat de vente préparé avant AU002 a pu se dire « complet » sans désignation : son modèle n'en avait pas la
    // place. Il ne se signe pas ; il faut le refaire sur un modèle qui la porte [R40].
    const designated = doc.kind === 'avenant_mandat' || (await this.designated(doc.id));
    const complete = doc.status === 'complet' && designated;
    lines.push({ check: 'champs', ok: complete, code: complete ? 'complete' : 'missing_fields' });
    lines.push({ check: 'modele', ok: doc.mode === 'reel', code: doc.mode === 'reel' ? 'validated_template' : 'trial_template' });
    const amendment = doc.kind === 'avenant_mandat';
    lines.push(doc.kind === 'mandat_location' ? rentalFeeLine(doc.facts) : await this.fees(doc.network_id, doc.facts, amendment, options.signedAt ?? options.identitySignedAt, doc.id));
    lines.push(await this.mandants(persons, doc.property_id));
    lines.push(await this.identities(doc.network_id, persons, at, options.identitySignedAt));
    // Un mandant représenté (AU059) : la procuration est dans le stockage, l'identité du représentant vérifiée, et le
    // représentant n'est pas devenu, par une réunion de fiches, l'un des mandants [R41].
    // Un bien démembré (AU060) : usufruitier et nus-propriétaires signent ensemble, chacun avec le justificatif de son
    // droit dans le stockage [R41].
    const rights = await documentRights(this.db, doc.id);
    if (rights.length > 0) lines.push(await this.rightsLine(rights));
    if (proxies.length > 0) lines.push(await this.proxyLine(doc.network_id, persons, proxies, at, options.signedAt ?? options.identitySignedAt));
    // Un avenant ne modifie qu'un mandat signé, numéroté, ni annulé ni rétracté.
    if (amendment) lines.push(await this.linkedMandate(doc.network_id, doc.mandate_id));
    // Une date d'effet se revoit à la signature : jamais après la fin du mandat telle qu'elle est ce jour-là, avenants
    // signés depuis la préparation compris (AU057) [R42].
    if (amendment) {
      const end = await this.effectAfterEnd(doc.id, doc.facts, options.signedAt ?? options.identitySignedAt);
      if (end) lines.push(end);
    }
    // Un mandat préparé par questionnaire (HX33) : un écart de prix, un avis ou un prix absents doivent avoir été
    // montrés au vendeur par l'agent du bien avant toute signature [R441].
    // Une base d'avant la migration 2100 n'a aucun mandat par questionnaire.
    const hasQuestionnaires = await this.db.first(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'mandate_questionnaires'`);
    const questionnaire = hasQuestionnaires ? await this.db.first<{ id: string; price_check: string }>('SELECT id, price_check FROM mandate_questionnaires WHERE document_id = ?', [doc.id]) : null;
    if (questionnaire) {
      const shown = questionnaire.price_check === 'dans_fourchette' || (await this.db.first('SELECT questionnaire_id FROM mandate_questionnaire_gap_acks WHERE questionnaire_id = ?', [questionnaire.id])) !== null;
      lines.push({ check: 'questionnaire', ok: shown, code: shown ? 'price_checked' : `price_${questionnaire.price_check}_not_shown` });
    }

    const passed = lines.every((l) => l.ok);
    const result: SignatureCheck = { documentId: doc.id, passed, lines, checkedAt: at.toISOString() };
    await this.db.run('INSERT INTO document_checks (id, network_id, document_id, passed, lines, checked_by, checked_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [
      this.newId(),
      doc.network_id,
      doc.id,
      passed ? 1 : 0,
      JSON.stringify(lines),
      this.actor(viewer),
      result.checkedAt,
    ]);
    await appendEvent(
      this.journal,
      { type: 'document.controle', actor: this.actor(viewer), subject: `document:${doc.id}`, data: { rule: 'R41', passed, failed: lines.filter((l) => !l.ok).map((l) => l.code) } },
      this.now,
    );
    return { ok: true, value: result };
  }

  private async rightsLine(rights: { right: string; proofRef: string | null }[]): Promise<CheckLine> {
    const line = (ok: boolean, code: string): CheckLine => ({ check: 'droits', ok, code });
    if (rights.some((r) => r.right === 'usufruit') !== rights.some((r) => r.right === 'nue_propriete')) return line(false, 'dismembered_incomplete');
    const store = this.options.powers !== undefined ? this.options.powers : this.options.scans;
    for (const r of rights) {
      if (r.right === 'pleine_propriete' && r.proofRef === null) continue;
      if (!store) return line(false, 'depot_ferme');
      if (!r.proofRef || !(await store.has(r.proofRef))) return line(false, 'proof_absent');
    }
    return line(true, rights.some((r) => r.right !== 'pleine_propriete') ? 'dismembered_checked' : 'rights_checked');
  }

  private async proxyLine(networkId: string, mandants: readonly string[], proxies: { mandantId: string; proxyId: string; powerRef: string; grantedOn: string }[], at: Date, signedAt?: Date): Promise<CheckLine> {
    const line = (ok: boolean, code: string): CheckLine => ({ check: 'procuration', ok, code });
    const mandantRoots = new Set<string>();
    for (const id of mandants) mandantRoots.add(await this.unique.rootOf(id));
    for (const p of proxies) {
      if (mandantRoots.has(await this.unique.rootOf(p.proxyId))) return line(false, 'proxy_is_mandant');
      // Le représentant ne signe qu'à partir du jour de sa procuration (AU059b).
      if (localTime(signedAt ?? at, 'Europe/Paris').date < p.grantedOn) return line(false, 'signed_before_power');
      // Sans stockage où la vérifier, la procuration n'est pas vérifiée : le document ne passe pas.
      const store = this.options.powers !== undefined ? this.options.powers : this.options.scans;
      if (!store) return line(false, 'depot_ferme');
      if (!(await store.has(p.powerRef))) return line(false, 'power_absent');
      const identity = signedAt ? await this.identityAtSignature(networkId, p.proxyId, signedAt) : await this.identity(networkId, p.proxyId, at);
      if (!identity.ok) return line(false, `proxy_${identity.code}`);
    }
    return line(true, 'power_checked');
  }

  /**
   * Aucun avenant différé ne prend effet après la fin du mandat : ni celui-ci, ni un avenant déjà signé dont la date
   * d'effet viendrait après une fin avancée par celui-ci, rejoué à sa date de signature (AU057) [R42].
   */
  private async effectAfterEnd(documentId: string, rawFacts: string | null, signedAt?: Date): Promise<CheckLine | null> {
    let facts: DocumentFacts | null = null;
    try {
      facts = rawFacts ? (JSON.parse(rawFacts) as DocumentFacts) : null;
    } catch {
      facts = null;
    }
    if (!facts?.mandateId) return null;
    const base = await this.db.first<{ signed_at: string }>('SELECT signed_at FROM signed_documents WHERE mandate_id = ? AND copy_content IS NOT NULL', [facts.mandateId]);
    if (!base) return null;
    const candidate = { documentId, signedAt: (signedAt ?? this.now()).toISOString(), facts };
    const all = await mandateTerms(this.db, facts.mandateId, undefined, candidate);
    if (!all) return null;
    const deferred = all.amendments.filter((a) => a.effectiveOn > localTime(new Date(a.signedAt), 'Europe/Paris').date);
    if (deferred.length === 0) return null;
    for (const a of deferred) {
      // Les conditions de la veille de son effet : lui ne compte pas encore.
      const eve = new Date(`${a.effectiveOn}T12:00:00.000Z`);
      eve.setUTCDate(eve.getUTCDate() - 1);
      const before = await mandateTerms(this.db, facts.mandateId, eve, candidate);
      if (!before || before.durationMonths === null) continue;
      if (a.effectiveOn >= mandateEndDay(new Date(base.signed_at), before.durationMonths)) return { check: 'mandat', ok: false, code: 'effect_after_end' };
    }
    return { check: 'mandat', ok: true, code: 'effect_before_end' };
  }

  private async linkedMandate(networkId: string, mandateId: string | null): Promise<CheckLine> {
    const line = (ok: boolean, code: string): CheckLine => ({ check: 'mandat', ok, code });
    if (!mandateId) return line(false, 'no_mandate');
    const inscription = await this.db.first<{ seq: number }>(`SELECT seq FROM mandate_register WHERE mandate_id = ? AND kind = 'inscription' AND network_id = ?`, [mandateId, networkId]);
    if (!inscription) return line(false, 'mandate_not_numbered');
    if (await this.db.first('SELECT mandate_id FROM mandate_withdrawals WHERE mandate_id = ?', [mandateId])) return line(false, 'mandate_withdrawn');
    if (await this.db.first(`SELECT seq FROM mandate_register WHERE network_id = ? AND kind = 'annulation' AND cancels_seq = ?`, [networkId, Number(inscription.seq)])) return line(false, 'mandate_cancelled');
    // Un mandat échu ne reçoit plus d'avenant, même préparé avant son échéance [R42].
    if (await mandateExpired(this.db, mandateId, this.now())) return line(false, 'mandate_expired');
    return line(true, 'mandate_in_force');
  }

  private async fees(networkId: string, rawFacts: string | null, amendment = false, signedAt?: Date, documentId = ''): Promise<CheckLine> {
    let facts: DocumentFacts | null = null;
    try {
      facts = rawFacts ? (JSON.parse(rawFacts) as DocumentFacts) : null;
    } catch {
      facts = null;
    }
    const line = (ok: boolean, code: string): CheckLine => ({ check: 'honoraires', ok, code });
    // Un avenant qui ne touche ni au prix ni aux honoraires ne les change pas ; sinon, les honoraires en vigueur après lui
    // restent au barème, sur le prix en vigueur après lui (AU057).
    if (amendment && facts && facts.priceEur === null && facts.feeChanged !== true && facts.feeChargeChanged !== true) return line(true, 'fees_unchanged');
    // Ce que l'avenant ne change pas se lit au contrôle, dans les conditions en vigueur, avenants signés depuis sa
    // préparation compris : jamais une copie prise à la préparation, qui a pu changer depuis. Et chaque jour compte, du
    // jour où il prend effet à chaque date d'effet d'un avenant déjà signé qui viendra après lui (AU057).
    if (amendment && facts) {
      if (!facts.mandateId) return line(false, 'fee_or_price_unknown');
      // L'avenant est rejoué à sa date de signature parmi les avenants signés, comme les conditions le seront : chaque
      // jour compte, du jour où il prend effet à chaque date d'effet qui viendra après lui (signature sur papier
      // enregistrée plus tard comprise).
      const candidate = { documentId, signedAt: (signedAt ?? this.now()).toISOString(), facts };
      const all = await mandateTerms(this.db, facts.mandateId, undefined, candidate);
      const own = all?.amendments.find((a) => a.documentId === documentId);
      if (!all || !own) return line(false, 'fee_or_price_unknown');
      const days = [own.effectiveOn, ...new Set(all.amendments.map((a) => a.effectiveOn).filter((d) => d > own.effectiveOn))].sort();
      let last: CheckLine = line(false, 'fee_or_price_unknown');
      for (const day of days) {
        const inForce = await mandateTerms(this.db, facts.mandateId, new Date(`${day}T12:00:00.000Z`), candidate);
        if (!inForce) return line(false, 'fee_or_price_unknown');
        last = await this.scheduleLine(networkId, { priceEur: inForce.priceEur, feeEur: inForce.feeEur, feeCharge: inForce.feeCharge });
        if (!last.ok) return last;
      }
      return last;
    }
    if (!facts) return line(false, 'fee_or_price_unknown');
    return this.scheduleLine(networkId, facts);
  }

  /** Des honoraires au barème du réseau, sur un prix, avec qui les paie [R41]. */
  private async scheduleLine(networkId: string, facts: Pick<DocumentFacts, 'priceEur' | 'feeEur' | 'feeCharge'>): Promise<CheckLine> {
    const line = (ok: boolean, code: string): CheckLine => ({ check: 'honoraires', ok, code });
    if (facts.feeEur === null || facts.priceEur === null) return line(false, 'fee_or_price_unknown');
    if (facts.feeCharge === null) return line(false, 'fee_payer_unknown');
    const schedule = await this.db.first<{ id: string; max_rate_bp: number; min_eur: number }>('SELECT id, max_rate_bp, min_eur FROM fee_schedules WHERE network_id = ? ORDER BY set_at DESC, rowid DESC LIMIT 1', [networkId]);
    if (!schedule) return line(false, 'no_fee_schedule');
    // AU058 · la tranche du prix fait le plafond : son taux ou son forfait ; au-delà de la dernière tranche fermée, le
    // taux maximal du barème.
    const tier = (await this.tiersOf(schedule.id)).find((t) => t.upToEur === null || facts!.priceEur! <= t.upToEur);
    if (tier && tier.flatEur !== undefined) {
      if (facts.feeEur > tier.flatEur) return line(false, 'fee_above_schedule');
    } else {
      const rateBp = tier && tier.ratePercent !== undefined ? Math.round(tier.ratePercent * 100) : Number(schedule.max_rate_bp);
      // Calcul en entiers : honoraires × 10 000 ≤ prix × taux en points de base.
      if (facts.feeEur * 10_000 > facts.priceEur * rateBp) return line(false, 'fee_above_schedule');
    }
    if (facts.feeEur < Number(schedule.min_eur)) return line(false, 'fee_below_minimum');
    return line(true, 'fee_in_schedule');
  }

  private async mandants(personIds: readonly string[], propertyId: string | null): Promise<CheckLine> {
    const line = (ok: boolean, code: string): CheckLine => ({ check: 'mandants', ok, code });
    if (!propertyId) return line(false, 'no_property');
    const owners = await this.db.all<{ person_id: string }>(
      `SELECT DISTINCT p.person_id FROM project_properties pp JOIN projects p ON p.id = pp.project_id WHERE pp.property_id = ? AND pp.role = 'owned'`,
      [propertyId],
    );
    if (owners.length === 0) return line(false, 'owners_unknown');
    const roots = new Set<string>();
    for (const o of owners) roots.add(await this.unique.rootOf(o.person_id));
    // Chaque mandant est une fiche à part : deux mandants réunis depuis la génération ne comptent plus que pour un.
    const mandants = new Set<string>();
    for (const id of personIds) mandants.add(await this.unique.rootOf(id));
    if (mandants.size !== personIds.length) return line(false, 'mandants_merged');
    if (roots.size !== mandants.size || [...roots].some((r) => !mandants.has(r))) return line(false, 'mandants_differ');
    return line(true, 'mandants_match');
  }

  /** L'identité de chaque mandant, dans l'ordre du document : la première qui manque fait échouer la ligne [R41, R92]. */
  private async identities(networkId: string, personIds: readonly string[], at: Date, signedAt?: Date): Promise<CheckLine> {
    let last: CheckLine = { check: 'identite', ok: false, code: 'identity_missing' };
    for (const id of personIds) {
      last = signedAt ? await this.identityAtSignature(networkId, id, signedAt) : await this.identity(networkId, id, at);
      if (!last.ok) return last;
    }
    return last;
  }

  private async identity(networkId: string, personId: string, at: Date): Promise<CheckLine> {
    // L'état du coffre, jamais une case cochée [R92].
    const status = await this.identification.status(networkId, personId, at);
    return { check: 'identite', ok: status.ok, code: status.ok ? 'identity_verified' : status.code };
  }

  /**
   * L'identification du mandant au jour d'une signature passée (mandat papier enregistré après coup) : pièce vérifiée ce
   * jour-là au plus tard et valide ce jour-là, déposée au coffre au plus tard maintenant [R92].
   */
  async identityAtSignature(networkId: string, personId: string, signedAt: Date): Promise<CheckLine> {
    const status = await this.identification.status(networkId, personId, signedAt, this.now());
    return { check: 'identite', ok: status.ok, code: status.ok ? 'identity_verified' : status.code };
  }

  /** Le dernier contrôle gardé d'un document. */
  async last(documentId: string): Promise<SignatureCheck | null> {
    const row = await this.db.first<{ document_id: string; passed: number; lines: string; checked_at: string }>('SELECT document_id, passed, lines, checked_at FROM document_checks WHERE document_id = ? ORDER BY checked_at DESC, rowid DESC LIMIT 1', [documentId]);
    return row ? { documentId: row.document_id, passed: Number(row.passed) === 1, lines: JSON.parse(row.lines) as CheckLine[], checkedAt: row.checked_at } : null;
  }
}

/**
 * AU014 · Les honoraires d'un mandat de location : ceux du bailleur, connus. Ceux du locataire ne s'écrivent pas au
 * mandat : ils suivent le barème plafonné de la mise en location (W02) [R102].
 */
function rentalFeeLine(rawFacts: string | null): CheckLine {
  let fee: unknown = null;
  try {
    fee = rawFacts ? (JSON.parse(rawFacts) as DocumentFacts).feeEur : null;
  } catch {
    fee = null;
  }
  const ok = typeof fee === 'number' && Number.isInteger(fee) && fee >= 0;
  return { check: 'honoraires', ok, code: ok ? 'rental_fee_known' : 'fee_or_price_unknown' };
}
