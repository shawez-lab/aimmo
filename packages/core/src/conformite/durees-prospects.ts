/**
 * Prospects à 3 ans (M12, L08) [R16, R17, R26, R97].
 *
 * Cahier, Conformité, « Durées » : un prospect est conservé 3 ans après son dernier contact ; à 3 ans, demande de
 * consentement, sinon suppression.
 *
 * Lecture prudente :
 * - le dernier contact est celui qui vient de la personne, jamais un message qu'on lui a écrit : son dernier message
 *   reçu, un accord donné, un projet ouvert, un rendez-vous pris (même annulé ensuite) ou tenu, une visite ; à défaut, la création de sa
 *   fiche. Un accord ancien ne prolonge rien : il compte comme un contact de son jour ;
 * - toutes les fiches réunies d'une personne (S04) comptent ensemble, sous la fiche gardée ;
 * - un client n'est pas un prospect, et n'est jamais listé : une personne qui a signé un mandat, l'acquéreur d'un
 *   dossier de vente, le locataire ou le propriétaire d'un bail fait par AIMMO, une personne identifiée pour la lutte
 *   contre le blanchiment et les bénéficiaires effectifs d'une société cliente. Ses durées sont celles du contrat ;
 * - « 3 ans » se compte en jours de Paris, par le calendrier : un contact du 10 février 2024 est listé le 10 février
 *   2027, pas la veille ;
 * - la demande de consentement est préparée en mode essai, sans canal ni envoi [R26] ; quand le plan la mettra en
 *   service, elle passera par le contrôle central, qui refusera une personne arrêtée ou exclue [R02, R04] ;
 * - sans réponse au bout de 30 jours (un nouveau contact de la personne vaut réponse), l'effacement suit la procédure
 *   de L07 : le plan dit ce qui serait effacé et ce que la loi oblige à garder, et, tant que H29 n'est pas fait,
 *   rien n'est effacé [R17].
 */
import type { Viewer } from '../acces/droits.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { localTime } from '../envoi/horaires.ts';
import type { FicheUnique } from '../fiche/fusion.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import { CARTE_ACCES, type AccessMapEntry } from './carte-acces.ts';
import { ERASURE_MODE, assembleAccessDetail, erasurePlan, sha256Of, type ErasurePlan } from './demandes-personnes.ts';
import { addCalendarMonths } from './registre-relecture.ts';
import type { Traitement } from './registre.ts';
import { REGISTRE_TRAITEMENTS } from './registre-traitements.ts';

const TIME_ZONE = 'Europe/Paris';

/** Un prospect est gardé 3 ans après son dernier contact. */
export const PROSPECT_RETENTION_MONTHS = 36;
/** Le temps laissé à la personne pour répondre à la demande de consentement. */
export const PROSPECT_ANSWER_DAYS = 30;
/** Tant que le plan ne l'a pas mise en service, la demande de consentement n'est qu'un brouillon. */
export const CONSENT_REQUEST_MODE = 'essai' as const;

const addDays = (day: string, days: number): string => new Date(Date.parse(`${day}T00:00:00.000Z`) + days * 86_400_000).toISOString().slice(0, 10);
const fr = (day: string): string => `${day.slice(8, 10)}/${day.slice(5, 7)}/${day.slice(0, 4)}`;

/** Le texte de la demande de consentement : sans nom, sans bien, sans rien de la personne. */
export function consentRequestText(answerDueOn: string): string {
  return (
    'Bonjour, vous avez été en contact avec notre réseau d\'agents immobiliers il y a trois ans. ' +
    'Souhaitez-vous que nous gardions vos coordonnées pour vous tenir informé de votre projet ? ' +
    `Répondez simplement oui à ce message. Sans réponse de votre part d'ici le ${fr(answerDueOn)}, vos coordonnées seront effacées.`
  );
}

export type RetentionOutcome = 'contact_repris' | 'devenu_client' | 'effacement';

export interface RetentionCycle {
  id: string;
  personId: string;
  lastContactAt: string;
  reachedOn: string;
  listedOn: string;
  answerDueOn: string;
  request: { mode: 'essai' | 'reel'; text: string; blockedBy: 'R02' | 'R04' | null };
  outcome: RetentionOutcome | null;
  decidedOn: string | null;
  planSha256: string | null;
}

export interface RetentionRun {
  /** Prospects arrivés à 3 ans ce jour-là. */
  listed: number;
  /** Cycles clos parce que la personne est revenue ou devenue cliente. */
  closed: number;
  /** Effacements préparés (en essai : rien n'est effacé). */
  erasures: number;
}

interface CycleRow {
  id: string;
  network_id: string;
  person_id: string;
  last_contact_at: string;
  reached_on: string;
  listed_on: string;
  answer_due_on: string;
  request_mode: 'essai' | 'reel';
  outcome: RetentionOutcome | null;
  decided_on: string | null;
  plan_sha256: string | null;
}

interface PersonState {
  root: string;
  members: string[];
  lastContactAt: string;
  client: boolean;
}

export type RetentionRefusal = { ok: false; rule: 'R16'; code: string };

export class DureesProspects {
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly carte: Readonly<Record<string, AccessMapEntry>>;
  private readonly registre: readonly Traitement[];

  constructor(
    private readonly db: SqlDatabase,
    private readonly journal: JournalStore,
    private readonly fiche: FicheUnique,
    options: { now?: () => Date; newId?: () => string; carte?: Readonly<Record<string, AccessMapEntry>>; registre?: readonly Traitement[] } = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => crypto.randomUUID());
    this.carte = options.carte ?? CARTE_ACCES;
    this.registre = options.registre ?? REGISTRE_TRAITEMENTS;
  }

  private today(): string {
    return localTime(this.now(), TIME_ZONE).date;
  }

  /**
   * Le dernier contact venu de chaque personne du réseau et sa qualité de client, par fiche gardée. Quelques requêtes
   * groupées, quel que soit le nombre de fiches.
   */
  async states(networkId: string): Promise<Map<string, PersonState>> {
    const persons = await this.db.all<{ id: string; created_at: string }>('SELECT id, created_at FROM persons WHERE network_id = ?', [networkId]);
    const merges = await this.db.all<{ survivor_id: string; merged_id: string }>(
      'SELECT survivor_id, merged_id FROM person_merges WHERE network_id = ? AND undone_at IS NULL',
      [networkId],
    );
    const parent = new Map(merges.map((m) => [m.merged_id, m.survivor_id]));
    const rootOf = (id: string): string => {
      const seen = new Set<string>();
      let current = id;
      while (parent.has(current)) {
        if (seen.has(current)) throw new Error('Boucle de fusions : à corriger à la main.');
        seen.add(current);
        current = parent.get(current)!;
      }
      return current;
    };

    const contacts = new Map<string, string[]>();
    const note = (personId: string, at: string | null): void => {
      if (!at || Number.isNaN(Date.parse(at))) return;
      contacts.set(personId, [...(contacts.get(personId) ?? []), at]);
    };
    for (const p of persons) note(p.id, p.created_at);
    const sources: [string, readonly unknown[]][] = [
      // Ce qui vient de la personne : jamais un message qu'on lui a écrit.
      ["SELECT person_id, max(occurred_at) AS at FROM messages WHERE network_id = ? AND direction = 'in' AND author_kind = 'person' GROUP BY person_id", [networkId]],
      ['SELECT person_id, max(given_at) AS at FROM consents WHERE network_id = ? GROUP BY person_id', [networkId]],
      ['SELECT person_id, max(created_at) AS at FROM projects WHERE network_id = ? GROUP BY person_id', [networkId]],
      // Un rendez-vous compte le jour où il est pris, quel que soit son sort, et le jour où il est tenu : une annulation
      // ne fait jamais reculer le dernier contact (un cycle clos ne doit pas bloquer la personne hors de la procédure).
      ['SELECT person_id, max(created_at) AS at FROM appointments WHERE network_id = ? GROUP BY person_id', [networkId]],
      ["SELECT person_id, max(start_at) AS at FROM appointments WHERE network_id = ? AND status = 'honored' GROUP BY person_id", [networkId]],
      ['SELECT person_id, max(created_at) AS at FROM visits WHERE network_id = ? GROUP BY person_id', [networkId]],
    ];
    for (const [sql, params] of sources) {
      for (const r of await this.db.all<{ person_id: string; at: string | null }>(sql, params as never)) note(r.person_id, r.at);
    }

    const clients = new Set<string>();
    const clientSources = [
      'SELECT DISTINCT person_id AS id FROM mandates WHERE network_id = ?',
      'SELECT DISTINCT buyer_person_id AS id FROM sale_files WHERE network_id = ?',
      'SELECT DISTINCT a.person_id AS id FROM rental_leases l JOIN rental_applications a ON a.id = l.application_id WHERE l.network_id = ?',
      'SELECT DISTINCT r.owner_person_id AS id FROM rental_leases l JOIN rental_listings r ON r.id = l.listing_id WHERE l.network_id = ?',
      // Une personne identifiée pour la lutte contre le blanchiment (L03), et les bénéficiaires effectifs d'une société
      // cliente : parties à un mandat ou à une vente, jamais des prospects.
      'SELECT DISTINCT person_id AS id FROM client_identifications WHERE network_id = ?',
      'SELECT DISTINCT owner_person_id AS id FROM beneficial_owners WHERE network_id = ?',
    ];
    for (const sql of clientSources) for (const r of await this.db.all<{ id: string | null }>(sql, [networkId])) if (r.id) clients.add(r.id);

    const states = new Map<string, PersonState>();
    for (const p of persons) {
      const root = rootOf(p.id);
      const state = states.get(root) ?? { root, members: [], lastContactAt: '', client: false };
      state.members.push(p.id);
      for (const at of contacts.get(p.id) ?? []) {
        if (state.lastContactAt === '' || Date.parse(at) > Date.parse(state.lastContactAt)) state.lastContactAt = new Date(Date.parse(at)).toISOString();
      }
      if (clients.has(p.id)) state.client = true;
      states.set(root, state);
    }
    for (const s of states.values()) s.members.sort((a, b) => (a === s.root ? -1 : b === s.root ? 1 : a < b ? -1 : a > b ? 1 : 0));
    return states;
  }

  /** Le jour où un contact atteint 3 ans, à l'heure de Paris. */
  static reachedOn(lastContactAt: string): string {
    return addCalendarMonths(localTime(new Date(lastContactAt), TIME_ZONE).date, PROSPECT_RETENTION_MONTHS);
  }

  /**
   * Le passage du jour : liste les prospects arrivés à 3 ans (demande de consentement préparée, en essai), clôt les
   * cycles d'une personne revenue ou devenue cliente, et prépare l'effacement des autres à l'échéance de la réponse,
   * par la procédure de L07, sans rien effacer tant que H29 n'est pas fait. Repasser le même jour ne fait rien de plus.
   */
  async run(networkId: string): Promise<RetentionRun> {
    const today = this.today();
    const states = await this.states(networkId);
    const result: RetentionRun = { listed: 0, closed: 0, erasures: 0 };

    // D'abord les cycles ouverts : une personne revenue n'est pas effacée.
    const open = await this.db.all<CycleRow>(
      `SELECT c.* FROM prospect_retention_cycles c WHERE c.network_id = ?
       AND NOT EXISTS (SELECT 1 FROM prospect_retention_outcomes o WHERE o.cycle_id = c.id) ORDER BY c.answer_due_on, c.id`,
      [networkId],
    );
    const rootsOf = new Map<string, string>();
    for (const s of states.values()) for (const m of s.members) rootsOf.set(m, s.root);
    for (const c of open) {
      const state = states.get(rootsOf.get(c.person_id) ?? c.person_id);
      let outcome: RetentionOutcome | null = null;
      let plan: { plan: ErasurePlan; sha256: string } | null = null;
      if (!state || state.client) outcome = 'devenu_client';
      else if (Date.parse(state.lastContactAt) > Date.parse(c.last_contact_at)) outcome = 'contact_repris';
      else if (today >= c.answer_due_on) {
        const detail = await assembleAccessDetail(this.db, state.members, { carte: this.carte, registre: this.registre });
        const p = erasurePlan(detail, this.registre);
        plan = { plan: p, sha256: await sha256Of(p) };
        outcome = 'effacement';
      }
      if (!outcome) continue;
      const { changes } = await this.db.run(
        'INSERT INTO prospect_retention_outcomes (cycle_id, outcome, mode, plan_sha256, decided_on, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING',
        [c.id, outcome, outcome === 'effacement' ? ERASURE_MODE : CONSENT_REQUEST_MODE, plan?.sha256 ?? null, today, this.now().toISOString()],
      );
      if (changes === 0) continue;
      if (plan) {
        result.erasures += 1;
        const lines = plan.plan.lines;
        await appendEvent(
          this.journal,
          {
            type: 'rgpd.effacement_essai',
            actor: 'system:durees',
            subject: `prospect_retention:${c.id}`,
            data: { rule: 'R17', origin: 'duree', mode: ERASURE_MODE, sha256: plan.sha256, erased: 0, wouldErase: lines.filter((l) => l.action === 'effacer').reduce((n, l) => n + l.rows, 0), kept: lines.filter((l) => l.action !== 'effacer').reduce((n, l) => n + l.rows, 0) },
          },
          this.now,
        );
      } else {
        result.closed += 1;
        await appendEvent(this.journal, { type: 'rgpd.prospect_clos', actor: 'system:durees', subject: `prospect_retention:${c.id}`, data: { rule: 'R97', outcome } }, this.now);
      }
    }

    // Puis les prospects arrivés à 3 ans : un cycle par dernier contact.
    for (const s of [...states.values()].sort((a, b) => (a.root < b.root ? -1 : 1))) {
      if (s.client || s.lastContactAt === '') continue;
      const reachedOn = DureesProspects.reachedOn(s.lastContactAt);
      if (today < reachedOn) continue;
      const known = await this.db.first<{ id: string; outcome: RetentionOutcome | null }>(
        `SELECT c.id, o.outcome FROM prospect_retention_cycles c LEFT JOIN prospect_retention_outcomes o ON o.cycle_id = c.id
         WHERE c.network_id = ? AND c.person_id IN (${s.members.map(() => '?').join(', ')}) AND c.last_contact_at >= ? ORDER BY c.listed_on DESC LIMIT 1`,
        [networkId, ...s.members, s.lastContactAt],
      );
      // Déjà listé pour ce contact (ou effacement préparé, ou pour un contact plus récent d'une fiche réunie) : rien.
      if (known) continue;
      const id = this.newId();
      const answerDueOn = addDays(today, PROSPECT_ANSWER_DAYS);
      const { changes } = await this.db.run(
        `INSERT INTO prospect_retention_cycles (id, network_id, person_id, last_contact_at, reached_on, listed_on, answer_due_on, request_mode, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
        [id, networkId, s.root, s.lastContactAt, reachedOn, today, answerDueOn, CONSENT_REQUEST_MODE, this.now().toISOString()],
      );
      if (changes === 0) continue;
      result.listed += 1;
      await appendEvent(
        this.journal,
        { type: 'rgpd.prospect_3_ans', actor: 'system:durees', subject: `prospect_retention:${id}`, data: { rule: 'R97', reachedOn, answerDueOn, mode: CONSENT_REQUEST_MODE } },
        this.now,
      );
    }
    return result;
  }

  private async refuse(viewer: Viewer, code: string): Promise<RetentionRefusal> {
    await appendEvent(
      this.journal,
      { type: 'acces.refuse', actor: `${String(viewer.role)}:${viewer.userId}`, subject: `network:${viewer.networkId}`, data: { rule: 'R16', role: String(viewer.role), kind: 'durees_prospects', code } },
      this.now,
    );
    return { ok: false, rule: 'R16', code };
  }

  /** Les cycles du réseau, les plus proches de l'échéance d'abord, avec la demande préparée : le responsable seul. */
  async list(viewer: Viewer): Promise<{ ok: true; value: RetentionCycle[] } | RetentionRefusal> {
    if (viewer.role !== 'compliance') return this.refuse(viewer, 'role');
    const rows = await this.db.all<CycleRow>(
      `SELECT c.*, o.outcome, o.decided_on, o.plan_sha256 FROM prospect_retention_cycles c
       LEFT JOIN prospect_retention_outcomes o ON o.cycle_id = c.id WHERE c.network_id = ? ORDER BY c.answer_due_on, c.id`,
      [viewer.networkId],
    );
    const out: RetentionCycle[] = [];
    for (const r of rows) {
      const members = await this.fiche.membersOf(r.person_id);
      const blocks = await this.db.all<{ reason: string }>(
        `SELECT reason FROM exclusions WHERE person_id IN (${members.map(() => '?').join(', ')}) AND channel IS NULL AND lifted_at IS NULL`,
        members,
      );
      out.push({
        id: r.id,
        personId: r.person_id,
        lastContactAt: r.last_contact_at,
        reachedOn: r.reached_on,
        listedOn: r.listed_on,
        answerDueOn: r.answer_due_on,
        request: { mode: r.request_mode, text: consentRequestText(r.answer_due_on), blockedBy: blocks.some((b) => b.reason === 'stop') ? 'R04' : blocks.length > 0 ? 'R02' : null },
        outcome: r.outcome,
        decidedOn: r.decided_on,
        planSha256: r.plan_sha256,
      });
    }
    // Chaque lecture réussie est écrite au journal avant de rendre les fiches, comme `Acces.listPersons` [R16].
    await appendEvent(
      this.journal,
      { type: 'rgpd.prospects_lus', actor: `${String(viewer.role)}:${viewer.userId}`, subject: `network:${viewer.networkId}`, data: { rule: 'R16', role: String(viewer.role), count: out.length, persons: [...new Set(out.map((c) => `person:${c.personId}`))] } },
      this.now,
    );
    return { ok: true, value: out };
  }
}
