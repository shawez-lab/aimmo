/**
 * Recommandations des clients et des partenaires, avec leur source (M20 complet, G08).
 *
 * Un partenaire de l'annuaire (M18, rôle `partner`) recommande une personne à l'agence. La recommandation n'est rangée
 * qu'avec la preuve de l'accord de la personne recommandée : sa forme (message écrit de la personne, appel à trois,
 * formulaire signé), son canal, sa date récente et sa référence ; sans elle, rien n'est rangé et aucun contact n'est
 * possible [R142, R03]. La parole du partenaire seule ne vaut pas accord. Aucun champ de récompense, aucun texte qui en
 * parle [R66]. La personne arrive dans la fiche unique avec la source « recommandation », qui suit jusqu'au mandat
 * (`Mandats.record`, reprise de la fiche) [R38]. L'agent qui la suit, sinon celui qui a confié en dernier une mise en
 * relation à ce partenaire, est alerté par une tâche « appeler » ; sans agent, la direction l'attribue.
 *
 * Le partenaire ne voit rien de la suite : la réponse est la même que la personne soit nouvelle, suivie par un autre
 * agent ou exclue, et il ne relit que la date de ses recommandations [R77, R16]. Une personne exclue ou qui a demandé
 * l'arrêt n'est jamais rappelée, et rien ne s'ajoute à sa fiche [R02, R04]. Aucune coordonnée au journal [R13].
 *
 * La file « à appeler » de l'agent réunit ces recommandations et celles des clients (M11, F01), seulement quand la
 * personne a un accord « recommandation » en cours : une recommandation sans accord n'y entre jamais [R142].
 */
import { storedForms } from '../../fiche/empreinte.ts';
import type { Acces } from '../../acces/acces.ts';
import type { Viewer } from '../../acces/droits.ts';
import { REFERRAL_CALL_HOURS, REFERRAL_PURPOSE, REFERRAL_SOURCE, mentionsReward } from '../../apres-vente/recommandations.ts';
import type { FicheClient } from '../../db/fiche-client.ts';
import { runBatch, type SqlDatabase, type SqlStatement } from '../../db/sql.ts';
import { PROJECT_KINDS, type IdentifierKind, type ProjectKind } from '../../db/types.ts';
import type { FicheUnique } from '../../fiche/fusion.ts';
import { normalizeIdentifier } from '../../fiche/normalize.ts';
import { appendEvent } from '../../journal/journal.ts';
import type { JournalStore } from '../../journal/types.ts';
import type { Annuaire } from '../../partenaires/annuaire.ts';
import { agentState } from '../../acces/etat-agent.ts';
import { agentGone } from '../../reseau/depart.ts';
import { agentBlocked } from './etat-agent.ts';

/** Les seuls champs d'une recommandation de partenaire : aucun ne parle de récompense [R66]. */
export const PARTNER_RECOMMENDATION_FIELDS = ['firstName', 'email', 'phone', 'projectKind', 'consent'] as const;
/** Les champs de la preuve d'accord [R142]. */
export const RECOMMENDATION_CONSENT_FIELDS = ['kind', 'channel', 'givenAt', 'reference'] as const;
/** Les formes de preuve admises : chacune vient de la personne recommandée elle-même, jamais du seul partenaire. */
export const RECOMMENDATION_CONSENT_KINDS = ['message_ecrit', 'appel_a_trois', 'formulaire_signe'] as const;
export type RecommendationConsentKind = (typeof RECOMMENDATION_CONSENT_KINDS)[number];
export const RECOMMENDATION_CONSENT_CHANNELS = ['email', 'phone', 'sms', 'whatsapp'] as const;
export type RecommendationConsentChannel = (typeof RECOMMENDATION_CONSENT_CHANNELS)[number];
export const RECOMMENDATION_CONSENT_LABELS: Readonly<Record<RecommendationConsentKind, string>> = Object.freeze({
  message_ecrit: 'message écrit de la personne',
  appel_a_trois: 'appel à trois avec la personne',
  formulaire_signe: 'formulaire signé par la personne',
});
/** Un accord plus ancien n'est plus « récent » : réglage, jusqu'à ce que Shawez en décide autrement. */
export const RECOMMENDATION_CONSENT_MAX_DAYS = 30;
/** Le détail de la source, sur la fiche : il ne nomme jamais le partenaire, que l'agent lit dans sa file. */
export const PARTNER_SOURCE_DETAIL = 'recommandé par un partenaire';
const REFERENCE_MAX = 200;

export type RecommendationRefusal = { ok: false; rule: 'R16' | 'R66' | 'R73' | 'R142' | null; code: string };
export type RecommendationResult<T> = { ok: true; value: T } | RecommendationRefusal;

/** Une recommandation à appeler, dans la file de l'agent ou de la direction. */
export interface RecommendationToCall {
  origin: 'client' | 'partner';
  recommendationId: string;
  personId: string;
  firstName: string | null;
  /** « Recommandé par un client », ou le nom du partenaire. */
  sourceLabel: string;
  /** Le seul canal par lequel la personne a accepté d'être contactée : `phone` pour un appel. */
  channel: RecommendationConsentChannel;
  dueAt: string;
  /** Pour la direction : la personne n'a pas d'agent, la recommandation est à attribuer, pas à appeler (G16). */
  assignable?: true;
}

/** Un agent à qui la direction peut attribuer une recommandation : son nom, rien d'autre (G16) [R16]. */
export interface AssignableAgent {
  agentId: string;
  firstName: string;
  lastName: string;
}

interface PartnerRecommendationRow {
  id: string;
  network_id: string;
  partner_id: string;
  referred_id: string;
  first_name: string | null;
  agent_id: string | null;
  project_id: string | null;
  consent_channel: RecommendationConsentChannel;
  call_due_at: string | null;
  call_done_at: string | null;
  created_at: string;
}

export interface RecommandationsGagnerOptions {
  now?: () => Date;
  newId?: () => string;
}

/**
 * L'empreinte d'une coordonnée, propre au réseau : elle retrouve une coordonnée déjà donnée avec une personne opposée,
 * sans la garder en clair [R13].
 */
export async function identifierPrint(networkId: string, kind: IdentifierKind, value: string): Promise<string> {
  const data = new TextEncoder().encode(`${networkId}|${kind}|${normalizeIdentifier(kind, value) ?? value}`);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
  return [...digest].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export class RecommandationsGagner {
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(
    private readonly db: SqlDatabase,
    private readonly store: FicheClient,
    private readonly fiche: FicheUnique,
    private readonly acces: Acces,
    private readonly annuaire: Annuaire,
    private readonly journal: JournalStore,
    options: RecommandationsGagnerOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => crypto.randomUUID());
  }

  private actor(viewer: Viewer): string {
    return `${String(viewer.role)}:${viewer.userId}`;
  }

  private async refused(viewer: Viewer, subject: string | null, code: string, rule: 'R16' | 'R73' = 'R16'): Promise<RecommendationRefusal> {
    await appendEvent(this.journal, { type: 'acces.refuse', actor: this.actor(viewer), subject, data: { rule, role: String(viewer.role), kind: 'recommendation', code } }, this.now);
    return { ok: false, rule, code };
  }

  /** Exclusion active, ou accord « recommandation » retiré [R02, R03, R04]. */
  private async opposed(personId: string, at: Date): Promise<boolean> {
    const view = await this.fiche.view(personId);
    return (
      view.exclusions.some((e) => e.lifted_at === null || Date.parse(e.lifted_at) > at.getTime()) ||
      view.consents.some((c) => c.purpose === REFERRAL_PURPOSE && c.withdrawn_at !== null && Date.parse(c.withdrawn_at) <= at.getTime())
    );
  }

  /** Un accord « recommandation » en cours sur la fiche, pour ce canal : on ne contacte que par le canal accepté [R142, R03]. */
  private async hasConsent(personId: string, at: Date, channel: string): Promise<boolean> {
    const view = await this.fiche.view(personId);
    return view.consents.some((c) => c.purpose === REFERRAL_PURPOSE && c.channel === channel && Date.parse(c.given_at) <= at.getTime() && (c.withdrawn_at === null || Date.parse(c.withdrawn_at) > at.getTime()));
  }

  /** Seul un partenaire du réseau, aux justificatifs valides ce jour-là, recommande [R16, R73]. */
  private async gate(viewer: Viewer): Promise<RecommendationRefusal | null> {
    if (viewer.role !== 'partner') return this.refused(viewer, null, 'role');
    const p = await this.db.first('SELECT 1 FROM partners WHERE id = ? AND network_id = ?', [viewer.userId, viewer.networkId]);
    if (!p) return this.refused(viewer, `partner:${viewer.userId}`, 'unknown');
    if (!(await this.annuaire.proposableOn(viewer.networkId, viewer.userId, this.now()))) return this.refused(viewer, `partner:${viewer.userId}`, 'credentials', 'R73');
    return null;
  }

  /**
   * Un partenaire recommande une personne, avec la preuve de son accord. La réponse est la même dans tous les cas où
   * elle est rangée [R77, R16] ; chaque refus va au journal, sans donnée [R13].
   *
   * Deux envois simultanés passent tous deux les lectures ; un seul lot peut alors aboutir (`attempt`). Le perdant est
   * rejoué une fois, comme un renvoi : il retrouve la fiche du gagnant et reçoit la même réponse [R77]. Une vraie panne
   * n'est jamais rejouée : elle remonte, rien n'est gardé [R17].
   */
  async recommend(viewer: Viewer, input: unknown): Promise<RecommendationResult<{ recorded: true }>> {
    const first = await this.attempt(viewer, input);
    if (!('lost' in first)) return first;
    const second = await this.attempt(viewer, input);
    if ('lost' in second) throw second.lost;
    return second;
  }

  /** Une coordonnée nouvelle sur une fiche : un envoi simultané qui l'a posée d'abord n'est pas une erreur. */
  private async addContact(input: { networkId: string; agentId: string | null; personId: string; kind: IdentifierKind; value: string }): Promise<void> {
    if ((await this.fiche.findByIdentifier(input.networkId, input.kind, input.value)).length > 0) return;
    try {
      await this.fiche.addIdentifier(input);
    } catch (error) {
      if (!/UNIQUE/i.test(String(error))) throw error;
    }
  }

  private async attempt(viewer: Viewer, input: unknown): Promise<RecommendationResult<{ recorded: true }> | { lost: unknown }> {
    const denied = await this.gate(viewer);
    if (denied) return denied;
    const stop = async (rule: RecommendationRefusal['rule'], code: string): Promise<RecommendationRefusal> => {
      await appendEvent(this.journal, { type: 'recommandation.refusee', actor: this.actor(viewer), subject: `partner:${viewer.userId}`, data: { rule, code, origin: 'partner' } }, this.now);
      return { ok: false, rule, code };
    };
    const at = this.now();

    // La forme d'abord : aucun champ en dehors des listes, donc aucun champ de récompense possible [R66].
    if (input === null || typeof input !== 'object' || Array.isArray(input)) return stop(null, 'bad_shape');
    const raw = input as Record<string, unknown>;
    if (Object.keys(raw).some((k) => !(PARTNER_RECOMMENDATION_FIELDS as readonly string[]).includes(k))) return stop('R66', 'unknown_field');
    const consentRaw = raw.consent;
    if (consentRaw !== undefined && consentRaw !== null && typeof consentRaw === 'object' && !Array.isArray(consentRaw)) {
      if (Object.keys(consentRaw).some((k) => !(RECOMMENDATION_CONSENT_FIELDS as readonly string[]).includes(k))) return stop('R66', 'unknown_field');
    }
    const texts = [...Object.values(raw), ...(consentRaw && typeof consentRaw === 'object' ? Object.values(consentRaw) : [])];
    if (texts.some((v) => typeof v === 'string' && mentionsReward(v))) return stop('R66', 'reward');
    const { firstName, email, phone, projectKind } = raw;
    if (firstName !== undefined && firstName !== null && (typeof firstName !== 'string' || firstName.trim() === '' || firstName.trim().length > 60)) return stop(null, 'bad_first_name');
    if (typeof projectKind !== 'string' || !(PROJECT_KINDS as readonly string[]).includes(projectKind)) return stop(null, 'bad_project');

    // La preuve de l'accord de la personne recommandée, toujours exigée [R142].
    if (consentRaw === undefined || consentRaw === null) return stop('R142', 'no_consent');
    if (typeof consentRaw !== 'object' || Array.isArray(consentRaw)) return stop('R142', 'bad_consent');
    const consent = consentRaw as Record<string, unknown>;
    if (typeof consent.kind !== 'string' || !(RECOMMENDATION_CONSENT_KINDS as readonly string[]).includes(consent.kind)) return stop('R142', 'bad_consent_kind');
    if (typeof consent.channel !== 'string' || !(RECOMMENDATION_CONSENT_CHANNELS as readonly string[]).includes(consent.channel)) return stop('R142', 'bad_consent_channel');
    const givenAt = typeof consent.givenAt === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(consent.givenAt) ? new Date(consent.givenAt) : null;
    if (givenAt === null || Number.isNaN(givenAt.getTime())) return stop('R142', 'bad_consent_date');
    if (givenAt.getTime() > at.getTime()) return stop('R142', 'consent_in_future');
    if (at.getTime() - givenAt.getTime() > RECOMMENDATION_CONSENT_MAX_DAYS * 86_400_000) return stop('R142', 'consent_too_old');
    if (typeof consent.reference !== 'string' || consent.reference.trim() === '' || consent.reference.trim().length > REFERENCE_MAX) return stop('R142', 'bad_consent_reference');
    const kind = consent.kind as RecommendationConsentKind;
    const channel = consent.channel as RecommendationConsentChannel;

    const ids: { kind: IdentifierKind; value: string }[] = [];
    for (const [k, value] of [['email', email], ['phone', phone]] as const) {
      if (value === undefined || value === null) continue;
      if (typeof value !== 'string' || value.length > 254 || normalizeIdentifier(k, value) === null) return stop(null, `bad_${k}`);
      ids.push({ kind: k, value });
    }
    if (ids.length === 0) return stop(null, 'no_contact');
    // L'accord porte sur un canal : la coordonnée de ce canal doit être donnée [R03].
    const needed: IdentifierKind = channel === 'email' ? 'email' : 'phone';
    if (!ids.some((i) => i.kind === needed)) return stop('R142', 'consent_channel_without_contact');

    const networkId = viewer.networkId;
    const typedName = typeof firstName === 'string' ? firstName.trim() : null;
    // Chaque coordonnée donnée est cherchée : si elles mènent à des fiches différentes, ou si l'une mène à une personne
    // opposée, la preuve ne peut pas être rattachée sûrement à une seule personne. Rien n'est alors ajouté à aucune
    // fiche, aucune tâche n'est créée, et la réponse reste la même [R142, R02, R04, R77].
    const roots: string[] = [];
    for (const id of ids) {
      for (const found of await this.fiche.findByIdentifier(networkId, id.kind, id.value)) {
        const root = await this.fiche.rootOf(found.id);
        if (!roots.includes(root)) roots.push(root);
      }
    }
    const prints = await Promise.all(ids.map((i) => identifierPrint(networkId, i.kind, i.value)));
    // Une coordonnée déjà donnée avec une personne opposée garde la recommandation à l'écart, même sur une fiche neuve.
    const heldBack = await this.db.first(`SELECT 1 FROM partner_recommendation_withheld WHERE network_id = ? AND identifier_sha256 IN (${prints.map(() => '?').join(', ')}) LIMIT 1`, [networkId, ...prints]);
    let opposed = roots.length > 1 || heldBack !== null;
    for (const root of roots) if (!opposed && (await this.opposed(root, at))) opposed = true;
    let referredId: string | null = roots[0] ?? null;
    // Chaque envoi accepté est rangé à part : l'historique du partenaire ne dépend jamais de ce que l'agence en fait [R77].
    const accepted = async (): Promise<{ ok: true; value: { recorded: true } }> => {
      await this.db.run('INSERT INTO partner_recommendation_submissions (id, network_id, partner_id, submitted_at) VALUES (?, ?, ?, ?)', [this.newId(), networkId, viewer.userId, at.toISOString()]);
      return { ok: true, value: { recorded: true } };
    };
    const silent = async (code: string): Promise<{ ok: true; value: { recorded: true } }> => {
      // Le refus est au journal ; le partenaire reçoit la même réponse qu'une recommandation rangée [R77].
      await appendEvent(this.journal, { type: 'recommandation.refusee', actor: this.actor(viewer), subject: `partner:${viewer.userId}`, data: { rule: null, code, origin: 'partner' } }, this.now);
      return accepted();
    };
    if (!opposed && referredId && (await this.db.first('SELECT 1 FROM partner_recommendations WHERE partner_id = ? AND referred_id = ?', [viewer.userId, referredId]))) {
      // Déjà recommandée par ce partenaire : une coordonnée nouvelle rejoint sa fiche, rien d'autre ne change.
      const followed = (await this.fiche.view(referredId)).members.map((m) => m.agent_id).find((a) => a !== null) ?? null;
      for (const id of ids) await this.addContact({ networkId, agentId: followed, personId: referredId, kind: id.kind, value: id.value });
      return silent('already_recommended');
    }
    if (opposed) referredId = roots.length === 1 ? roots[0]! : null;
    const followedBy = referredId ? ((await this.fiche.view(referredId)).members.map((m) => m.agent_id).find((a) => a !== null) ?? null) : null;
    // L'agent qui suit la personne ; sinon celui qui a confié en dernier une mise en relation à ce partenaire et est
    // toujours en activité ; sinon personne, et la direction attribue.
    const lastEntrusting = await this.db.first<{ agent_id: string }>(
      `SELECT p.agent_id AS agent_id FROM partner_referral_steps s
         JOIN partner_referrals r ON r.id = s.referral_id
         JOIN projects p ON p.id = r.project_id
         JOIN agents a ON a.id = p.agent_id AND a.status = 'active'
        WHERE s.state = 'confiee' AND r.network_id = ? AND p.agent_id IS NOT NULL
          AND s.referral_id IN (SELECT referral_id FROM partner_referral_steps WHERE state = 'accord_client' AND partner_id = ?)
        ORDER BY s.at DESC, s.referral_id DESC LIMIT 1`,
      [networkId, viewer.userId],
    );
    const agentId = followedBy ?? lastEntrusting?.agent_id ?? null;

    // Tout est vérifié avant la première écriture. Une fiche déjà là reçoit d'abord son agent et ses coordonnées nouvelles :
    // une panne ensuite ne laisse rien qu'un renvoi ne retrouve.
    if (!opposed && referredId) {
      if (followedBy === null && agentId !== null) await this.handOver(await this.fiche.membersOf(referredId), agentId, at.toISOString());
      for (const id of ids) await this.addContact({ networkId, agentId, personId: referredId, kind: id.kind, value: id.value });
    }
    // Le projet, sa source, l'accord et la recommandation en un seul lot, tout ou rien, avec la fiche quand elle est neuve :
    // un renvoi après une panne ne crée jamais une seconde fiche, un second projet ni un second accord.
    const known = referredId;
    const prepared: { value: { personId: string; projectId: string } | null; statements: SqlStatement[] } = opposed
      ? { value: null, statements: [] }
      : await this.store.prepare(async (draft) => {
          let personId = known;
          if (!personId) {
            personId = (await draft.createPerson({ networkId, agentId, firstName: typedName })).id;
            for (const id of ids) await draft.addIdentifier({ networkId, agentId, personId, kind: id.kind, value: id.value });
          }
          const project = await draft.createProject({ networkId, agentId, personId, kind: projectKind as ProjectKind });
          // La source ne nomme pas le partenaire : la fiche peut être celle d'un autre agent [R16]. Elle suit jusqu'au mandat [R38].
          await draft.addSource({ networkId, agentId, personId, projectId: project.id, channel: REFERRAL_SOURCE, detail: PARTNER_SOURCE_DETAIL, occurredAt: at });
          await draft.addConsent({
            networkId,
            agentId,
            personId,
            purpose: REFERRAL_PURPOSE,
            channel,
            proof: `${RECOMMENDATION_CONSENT_LABELS[kind]} : ${(consent.reference as string).trim()} (transmis par un partenaire)`,
            givenAt,
          });
          return { personId, projectId: project.id };
        });
    if (prepared.value) referredId = prepared.value.personId;
    const id = this.newId();
    const due = opposed ? null : new Date(at.getTime() + REFERRAL_CALL_HOURS * 3_600_000).toISOString();
    // Sur une fiche neuve, la garde passe en premier : une coordonnée arrivée entre-temps sur une fiche annule tout le lot.
    // Une ligne déjà là annule aussi le lot, faute d'`ON CONFLICT` : le perdant ne garde ni projet, ni source, ni accord.
    // Tenue à l'écart, la recommandation n'écrit rien d'autre : un doublon s'ignore simplement.
    const guards: SqlStatement[] = [];
    if (!opposed && known === null) {
      for (const contact of ids) {
        const kinds = contact.kind === 'phone' ? ['phone', 'whatsapp'] : [contact.kind];
        guards.push({
          sql: `INSERT INTO partner_recommendation_race_guard (never)
                SELECT 1 WHERE EXISTS (SELECT 1 FROM person_identifiers WHERE network_id = ? AND kind IN (${kinds.map(() => '?').join(', ')}) AND value IN (?, ?))`,
          params: [networkId, ...kinds, normalizeIdentifier(contact.kind, contact.value), (await storedForms(networkId, contact.kind, contact.value))[1] ?? null],
        });
      }
    }
    let results: { changes: number }[];
    try {
      results = await runBatch(this.db, [
        ...guards,
        ...prepared.statements,
        {
          sql: `INSERT INTO partner_recommendations (id, network_id, partner_id, referred_id, project_id, first_name, agent_id, consent_kind, consent_channel, consent_given_at, call_due_at, call_done_at, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)${opposed ? ' ON CONFLICT (partner_id, referred_id) DO NOTHING' : ''}`,
          params: [id, networkId, viewer.userId, referredId, prepared.value?.projectId ?? null, typedName, opposed ? null : agentId, kind, channel, givenAt.toISOString(), due, this.actor(viewer), at.toISOString()],
        },
      ]);
    } catch (error) {
      // Perdu seulement si ce que le lot refusait existe vraiment maintenant ; sinon c'est une panne, qui remonte.
      if (opposed) throw error;
      const beaten = known !== null ? (await this.db.first('SELECT 1 FROM partner_recommendations WHERE partner_id = ? AND referred_id = ?', [viewer.userId, known])) !== null : (await Promise.all(ids.map((c) => this.fiche.findByIdentifier(networkId, c.kind, c.value)))).some((found) => found.length > 0);
      if (!beaten) throw error;
      return { lost: error };
    }
    const changes = results[results.length - 1]!.changes;
    // Tenue à l'écart, chaque coordonnée donnée garde son empreinte, même quand la ligne existait déjà : une coordonnée
    // nouvelle ne peut pas ensuite rouvrir une fiche neuve pour la même personne [R02, R04].
    let withheldId = id;
    if (changes !== 1 && opposed && referredId !== null) {
      withheldId = (await this.db.first<{ id: string }>('SELECT id FROM partner_recommendations WHERE partner_id = ? AND referred_id = ?', [viewer.userId, referredId]))!.id;
    }
    if (opposed) {
      for (const print of [...new Set(prints)]) {
        await this.db.run('INSERT INTO partner_recommendation_withheld (recommendation_id, network_id, identifier_sha256, created_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING', [withheldId, networkId, print, at.toISOString()]);
      }
    }
    if (changes !== 1) return silent('already_recommended');
    await appendEvent(
      this.journal,
      { type: 'recommandation.rangee', actor: this.actor(viewer), subject: referredId === null ? null : `person:${referredId}`, data: { rule: 'R142', origin: 'partner', call: !opposed } },
      this.now,
    );
    if (!opposed) {
      await appendEvent(
        this.journal,
        { type: 'recommandation.alerte', actor: 'systeme', subject: agentId === null ? null : `agent:${agentId}`, data: { rule: 'R142', recommendation: id, origin: 'partner', to: agentId === null ? 'direction' : 'agent' } },
        this.now,
      );
    }
    return accepted();
  }

  /**
   * Le partenaire relit ses envois acceptés : leur date seulement, un par envoi, qu'ils aient été rangés, réunis à une
   * recommandation déjà faite ou tenus à l'écart ; jamais ce qu'il en est advenu [R77].
   */
  async mine(viewer: Viewer): Promise<RecommendationResult<{ createdAt: string }[]>> {
    if (viewer.role !== 'partner') return this.refused(viewer, null, 'role');
    const p = await this.db.first('SELECT 1 FROM partners WHERE id = ? AND network_id = ?', [viewer.userId, viewer.networkId]);
    if (!p) return this.refused(viewer, `partner:${viewer.userId}`, 'unknown');
    const rows = await this.db.all<{ submitted_at: string }>('SELECT submitted_at FROM partner_recommendation_submissions WHERE network_id = ? AND partner_id = ? ORDER BY submitted_at, id', [viewer.networkId, viewer.userId]);
    return { ok: true, value: rows.map((r) => ({ createdAt: r.submitted_at })) };
  }

  /**
   * Une personne sans agent passe à un agent : ses fiches réunies et tous ses projets encore sans agent passent avec
   * elle, sinon l'agent verrait la personne sans pouvoir travailler sur ses projets (mise en relation, mandat) [R16].
   */
  private async handOver(members: readonly string[], agentId: string, at: string): Promise<void> {
    const marks = members.map(() => '?').join(', ');
    await this.db.run(`UPDATE persons SET agent_id = ?, updated_at = ? WHERE id IN (${marks}) AND agent_id IS NULL`, [agentId, at, ...members]);
    await this.db.run(`UPDATE projects SET agent_id = ?, updated_at = ? WHERE person_id IN (${marks}) AND agent_id IS NULL`, [agentId, at, ...members]);
  }

  /** L'agent qui a aujourd'hui la tâche : celui de la recommandation s'il est en activité, sinon celui qui suit la personne. */
  private async currentOwner(row: PartnerRecommendationRow, at: Date): Promise<string | null> {
    const active = async (agentId: string | null): Promise<boolean> => agentId !== null && !(await agentGone(this.db, row.network_id, agentId, at));
    if (await active(row.agent_id)) return row.agent_id;
    const members = await this.fiche.membersOf(await this.fiche.rootOf(row.referred_id));
    const owners = await this.db.all<{ agent_id: string | null }>(`SELECT agent_id FROM persons WHERE id IN (${members.map(() => '?').join(', ')}) AND agent_id IS NOT NULL ORDER BY id`, members);
    for (const o of owners) if (await active(o.agent_id)) return o.agent_id;
    return null;
  }

  /**
   * La file « à contacter », chacune par le seul canal accepté : pour un agent, ses recommandations de clients (F01) et de partenaires ; pour la direction,
   * les recommandations de partenaires sans agent, à attribuer. Seulement avec un accord en cours, jamais une personne
   * opposée [R142, R02, R04], et seulement les fiches que le lecteur voit aujourd'hui [R16]. Ordre écrit : échéance,
   * puis identifiant [R35].
   */
  async toCall(viewer: Viewer): Promise<RecommendationResult<RecommendationToCall[]>> {
    if (viewer.role !== 'agent' && viewer.role !== 'direction') return this.refused(viewer, null, 'role');
    const blocked = await agentBlocked(this.db, viewer, this.now());
    if (blocked) return this.refused(viewer, null, blocked);
    const at = this.now();
    const out: RecommendationToCall[] = [];
    const push = async (origin: 'client' | 'partner', id: string, referred: string, typed: string | null, dueAt: string, sourceLabel: string, channel: RecommendationConsentChannel): Promise<void> => {
      const root = await this.fiche.rootOf(referred);
      if (await this.opposed(root, at)) return;
      if (!(await this.hasConsent(root, at, channel))) return;
      const read = await this.acces.readFiche(viewer, root);
      if (!read.ok || read.view !== 'full') return;
      out.push({ origin, recommendationId: id, personId: root, firstName: read.value.members.map((m) => m.first_name).find((n) => n) ?? typed, sourceLabel, channel, dueAt, ...(viewer.role === 'direction' ? { assignable: true as const } : {}) });
    };
    if (viewer.role === 'agent') {
      const clients = await this.db.all<{ id: string; referred_id: string; first_name: string | null; call_due_at: string }>(
        'SELECT id, referred_id, first_name, call_due_at FROM referrals WHERE network_id = ? AND agent_id = ? AND call_due_at IS NOT NULL AND call_done_at IS NULL',
        [viewer.networkId, viewer.userId],
      );
      for (const r of clients) await push('client', r.id, r.referred_id, r.first_name, r.call_due_at, 'Recommandé par un client', 'phone');
    }
    const partners = await this.db.all<PartnerRecommendationRow & { business_name: string }>(
      `SELECT r.*, p.business_name AS business_name FROM partner_recommendations r JOIN partners p ON p.id = r.partner_id
        WHERE r.network_id = ? AND r.call_due_at IS NOT NULL AND r.call_done_at IS NULL`,
      [viewer.networkId],
    );
    for (const r of partners) {
      // La tâche suit son agent tant qu'il est en activité ; après son départ, l'agent qui suit aujourd'hui la personne,
      // ou la direction si personne ne la suit [R86].
      const owner = await this.currentOwner(r, at);
      if (viewer.role === 'agent' ? owner !== viewer.userId : owner !== null) continue;
      await push('partner', r.id, r.referred_id, r.first_name, r.call_due_at!, `Recommandé par ${r.business_name}`, r.consent_channel);
    }
    out.sort((a, b) => (a.dueAt < b.dueAt ? -1 : a.dueAt > b.dueAt ? 1 : a.recommendationId < b.recommendationId ? -1 : a.recommendationId > b.recommendationId ? 1 : 0));
    await appendEvent(this.journal, { type: 'recommandations.file_lue', actor: this.actor(viewer), subject: null, data: { rule: 'R16', count: out.length } }, this.now);
    return { ok: true, value: out };
  }

  /** Les agents en activité du réseau, par nom, pour la seule direction : ni chiffre ni classement [R16, R35]. */
  async assignableAgents(viewer: Viewer): Promise<RecommendationResult<AssignableAgent[]>> {
    if (viewer.role !== 'direction') return this.refused(viewer, null, 'role');
    const rows = await this.db.all<{ id: string; first_name: string; last_name: string }>(
      'SELECT id, first_name, last_name FROM agents WHERE network_id = ? AND status = ? ORDER BY last_name, first_name, id',
      [viewer.networkId, 'active'],
    );
    // Un agent au dossier incomplet ou dont le départ est arrivé ne verrait pas la tâche : personne n'appellerait.
    const at = this.now();
    const able: AssignableAgent[] = [];
    for (const a of rows) if ((await agentState(this.db, viewer.networkId, a.id, at)) === 'actif') able.push({ agentId: a.id, firstName: a.first_name, lastName: a.last_name });
    return { ok: true, value: able };
  }

  /** La direction donne à un agent actif une recommandation de partenaire qui n'en avait pas ; une seule fois. */
  async assign(viewer: Viewer, recommendationId: string, agentId: string): Promise<RecommendationResult<{ assigned: true }>> {
    if (viewer.role !== 'direction') return this.refused(viewer, null, 'role');
    const row = await this.db.first<PartnerRecommendationRow>('SELECT * FROM partner_recommendations WHERE id = ? AND network_id = ?', [recommendationId, viewer.networkId]);
    if (!row || row.call_due_at === null) return this.refused(viewer, null, 'unknown');
    if ((await this.currentOwner(row, this.now())) !== null) return { ok: false, rule: null, code: 'already_assigned' };
    const agent = await this.db.first('SELECT 1 FROM agents WHERE id = ? AND network_id = ? AND status = ?', [agentId, viewer.networkId, 'active']);
    if (!agent || (await agentState(this.db, viewer.networkId, agentId, this.now())) !== 'actif') return { ok: false, rule: null, code: 'bad_agent' };
    const members = await this.fiche.membersOf(await this.fiche.rootOf(row.referred_id));
    // La personne a pu être donnée à un agent entre-temps (par une autre recommandation) : la tâche va à lui seul, sinon
    // personne ne pourrait la voir ni la clore [R16].
    const owners = (await this.db.all<{ agent_id: string | null }>(`SELECT agent_id FROM persons WHERE id IN (${members.map(() => '?').join(', ')})`, members)).map((p) => p.agent_id).filter((a): a is string => a !== null);
    if (owners.some((o) => o !== agentId)) {
      // Suivie par un agent parti dont la passation n'est pas encore faite : elle passera par le départ (M14), pas ici.
      for (const o of owners) if (await agentGone(this.db, viewer.networkId, o, this.now())) return { ok: false, rule: null, code: 'awaiting_handover' };
      return { ok: false, rule: null, code: 'followed_by_other' };
    }
    const at = this.now().toISOString();
    await this.handOver(members, agentId, at);
    // La ligne garde l'agent d'origine une fois donné (rien ne se réécrit) ; sans agent, elle reçoit celui-ci.
    await this.db.run('UPDATE partner_recommendations SET agent_id = ? WHERE id = ? AND agent_id IS NULL', [agentId, recommendationId]);
    await appendEvent(this.journal, { type: 'recommandation.alerte', actor: this.actor(viewer), subject: `agent:${agentId}`, data: { rule: 'R142', recommendation: recommendationId, origin: 'partner' } }, this.now);
    return { ok: true, value: { assigned: true } };
  }

  /** « Appel fait » pour une recommandation de partenaire : l'agent qui a la tâche, avec ses droits d'aujourd'hui [R16]. */
  async callDone(viewer: Viewer, recommendationId: string): Promise<RecommendationResult<{ done: true }>> {
    const blocked = await agentBlocked(this.db, viewer, this.now());
    if (blocked) return this.refused(viewer, null, blocked);
    const row = await this.db.first<PartnerRecommendationRow>('SELECT * FROM partner_recommendations WHERE id = ? AND network_id = ?', [recommendationId, viewer.networkId]);
    if (!row || row.call_due_at === null) return this.refused(viewer, null, 'unknown');
    if (viewer.role !== 'agent' || viewer.userId !== (await this.currentOwner(row, this.now()))) return this.refused(viewer, null, 'not_assigned');
    const read = await this.acces.readFiche(viewer, await this.fiche.rootOf(row.referred_id));
    if (!read.ok) return { ok: false, rule: 'R16', code: read.code };
    if (read.view !== 'full') return this.refused(viewer, null, 'not_assigned');
    await this.db.run('UPDATE partner_recommendations SET call_done_at = ? WHERE id = ? AND call_done_at IS NULL', [this.now().toISOString(), recommendationId]);
    return { ok: true, value: { done: true } };
  }
}
