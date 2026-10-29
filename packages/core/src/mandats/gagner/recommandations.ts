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
import type { Acces } from '../../acces/acces.ts';
import type { Viewer } from '../../acces/droits.ts';
import { REFERRAL_CALL_HOURS, REFERRAL_PURPOSE, REFERRAL_SOURCE, mentionsReward } from '../../apres-vente/recommandations.ts';
import type { FicheClient } from '../../db/fiche-client.ts';
import type { SqlDatabase } from '../../db/sql.ts';
import { PROJECT_KINDS, type IdentifierKind, type ProjectKind } from '../../db/types.ts';
import type { FicheUnique } from '../../fiche/fusion.ts';
import { normalizeIdentifier } from '../../fiche/normalize.ts';
import { appendEvent } from '../../journal/journal.ts';
import type { JournalStore } from '../../journal/types.ts';
import type { Annuaire } from '../../partenaires/annuaire.ts';

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
  dueAt: string;
}

interface PartnerRecommendationRow {
  id: string;
  network_id: string;
  partner_id: string;
  referred_id: string;
  first_name: string | null;
  agent_id: string | null;
  call_due_at: string | null;
  call_done_at: string | null;
  created_at: string;
}

export interface RecommandationsGagnerOptions {
  now?: () => Date;
  newId?: () => string;
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

  /** Un accord « recommandation » en cours sur la fiche [R142, R03]. */
  private async hasConsent(personId: string, at: Date): Promise<boolean> {
    const view = await this.fiche.view(personId);
    return view.consents.some((c) => c.purpose === REFERRAL_PURPOSE && Date.parse(c.given_at) <= at.getTime() && (c.withdrawn_at === null || Date.parse(c.withdrawn_at) > at.getTime()));
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
   */
  async recommend(viewer: Viewer, input: unknown): Promise<RecommendationResult<{ recorded: true }>> {
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
    let referredId: string | null = null;
    for (const id of ids) {
      const found = await this.fiche.findByIdentifier(networkId, id.kind, id.value);
      if (found.length > 0) {
        referredId = await this.fiche.rootOf(found[0]!.id);
        break;
      }
    }
    if (referredId && (await this.db.first('SELECT 1 FROM partner_recommendations WHERE partner_id = ? AND referred_id = ?', [viewer.userId, referredId]))) return stop(null, 'already_recommended');
    const opposed = referredId !== null && (await this.opposed(referredId, at));
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

    let projectId: string | null = null;
    if (!opposed) {
      // Tout est vérifié avant la première écriture.
      if (!referredId) referredId = (await this.store.createPerson({ networkId, agentId, firstName: typedName })).id;
      else if (followedBy === null && agentId !== null) {
        const members = await this.fiche.membersOf(referredId);
        await this.db.run(`UPDATE persons SET agent_id = ?, updated_at = ? WHERE id IN (${members.map(() => '?').join(', ')}) AND agent_id IS NULL`, [agentId, at.toISOString(), ...members]);
      }
      for (const id of ids) {
        if ((await this.fiche.findByIdentifier(networkId, id.kind, id.value)).length === 0) await this.fiche.addIdentifier({ networkId, agentId, personId: referredId, kind: id.kind, value: id.value });
      }
      projectId = (await this.store.createProject({ networkId, agentId, personId: referredId, kind: projectKind as ProjectKind })).id;
      // La source ne nomme pas le partenaire : la fiche peut être celle d'un autre agent [R16]. Elle suit jusqu'au mandat [R38].
      await this.store.addSource({ networkId, agentId, personId: referredId, projectId, channel: REFERRAL_SOURCE, detail: PARTNER_SOURCE_DETAIL, occurredAt: at });
      await this.store.addConsent({
        networkId,
        agentId,
        personId: referredId,
        purpose: REFERRAL_PURPOSE,
        channel,
        proof: `${RECOMMENDATION_CONSENT_LABELS[kind]} : ${(consent.reference as string).trim()} (transmis par un partenaire)`,
        givenAt,
      });
    }
    const id = this.newId();
    const due = opposed ? null : new Date(at.getTime() + REFERRAL_CALL_HOURS * 3_600_000).toISOString();
    const { changes } = await this.db.run(
      `INSERT INTO partner_recommendations (id, network_id, partner_id, referred_id, project_id, first_name, agent_id, consent_kind, consent_channel, consent_given_at, call_due_at, call_done_at, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?) ON CONFLICT (partner_id, referred_id) DO NOTHING`,
      [id, networkId, viewer.userId, referredId!, projectId, typedName, opposed ? null : agentId, kind, channel, givenAt.toISOString(), due, this.actor(viewer), at.toISOString()],
    );
    if (changes !== 1) return stop(null, 'already_recommended');
    await appendEvent(
      this.journal,
      { type: 'recommandation.rangee', actor: this.actor(viewer), subject: `person:${referredId}`, data: { rule: 'R142', origin: 'partner', call: !opposed } },
      this.now,
    );
    if (!opposed) {
      await appendEvent(
        this.journal,
        { type: 'recommandation.alerte', actor: 'systeme', subject: agentId === null ? null : `agent:${agentId}`, data: { rule: 'R142', recommendation: id, origin: 'partner', to: agentId === null ? 'direction' : 'agent' } },
        this.now,
      );
    }
    return { ok: true, value: { recorded: true } };
  }

  /** Le partenaire relit ses recommandations : leur date seulement, jamais ce qu'il en est advenu [R77]. */
  async mine(viewer: Viewer): Promise<RecommendationResult<{ createdAt: string }[]>> {
    if (viewer.role !== 'partner') return this.refused(viewer, null, 'role');
    const p = await this.db.first('SELECT 1 FROM partners WHERE id = ? AND network_id = ?', [viewer.userId, viewer.networkId]);
    if (!p) return this.refused(viewer, `partner:${viewer.userId}`, 'unknown');
    const rows = await this.db.all<{ created_at: string }>('SELECT created_at FROM partner_recommendations WHERE network_id = ? AND partner_id = ? ORDER BY created_at, id', [viewer.networkId, viewer.userId]);
    return { ok: true, value: rows.map((r) => ({ createdAt: r.created_at })) };
  }

  /**
   * La file « à appeler » : pour un agent, ses recommandations de clients (F01) et de partenaires ; pour la direction,
   * les recommandations de partenaires sans agent, à attribuer. Seulement avec un accord en cours, jamais une personne
   * opposée [R142, R02, R04], et seulement les fiches que le lecteur voit aujourd'hui [R16]. Ordre écrit : échéance,
   * puis identifiant [R35].
   */
  async toCall(viewer: Viewer): Promise<RecommendationResult<RecommendationToCall[]>> {
    if (viewer.role !== 'agent' && viewer.role !== 'direction') return this.refused(viewer, null, 'role');
    const at = this.now();
    const out: RecommendationToCall[] = [];
    const push = async (origin: 'client' | 'partner', id: string, referred: string, typed: string | null, dueAt: string, sourceLabel: string): Promise<void> => {
      const root = await this.fiche.rootOf(referred);
      if (await this.opposed(root, at)) return;
      if (!(await this.hasConsent(root, at))) return;
      const read = await this.acces.readFiche(viewer, root);
      if (!read.ok || read.view !== 'full') return;
      out.push({ origin, recommendationId: id, personId: root, firstName: read.value.members.map((m) => m.first_name).find((n) => n) ?? typed, sourceLabel, dueAt });
    };
    if (viewer.role === 'agent') {
      const clients = await this.db.all<{ id: string; referred_id: string; first_name: string | null; call_due_at: string }>(
        'SELECT id, referred_id, first_name, call_due_at FROM referrals WHERE network_id = ? AND agent_id = ? AND call_due_at IS NOT NULL AND call_done_at IS NULL',
        [viewer.networkId, viewer.userId],
      );
      for (const r of clients) await push('client', r.id, r.referred_id, r.first_name, r.call_due_at, 'Recommandé par un client');
    }
    const partners = await this.db.all<PartnerRecommendationRow & { business_name: string }>(
      `SELECT r.*, p.business_name AS business_name FROM partner_recommendations r JOIN partners p ON p.id = r.partner_id
        WHERE r.network_id = ? AND r.call_due_at IS NOT NULL AND r.call_done_at IS NULL AND ${viewer.role === 'agent' ? 'r.agent_id = ?' : 'r.agent_id IS NULL'}`,
      viewer.role === 'agent' ? [viewer.networkId, viewer.userId] : [viewer.networkId],
    );
    for (const r of partners) await push('partner', r.id, r.referred_id, r.first_name, r.call_due_at!, `Recommandé par ${r.business_name}`);
    out.sort((a, b) => (a.dueAt < b.dueAt ? -1 : a.dueAt > b.dueAt ? 1 : a.recommendationId < b.recommendationId ? -1 : a.recommendationId > b.recommendationId ? 1 : 0));
    await appendEvent(this.journal, { type: 'recommandations.file_lue', actor: this.actor(viewer), subject: null, data: { rule: 'R16', count: out.length } }, this.now);
    return { ok: true, value: out };
  }

  /** La direction donne à un agent actif une recommandation de partenaire qui n'en avait pas ; une seule fois. */
  async assign(viewer: Viewer, recommendationId: string, agentId: string): Promise<RecommendationResult<{ assigned: true }>> {
    if (viewer.role !== 'direction') return this.refused(viewer, null, 'role');
    const row = await this.db.first<PartnerRecommendationRow>('SELECT * FROM partner_recommendations WHERE id = ? AND network_id = ?', [recommendationId, viewer.networkId]);
    if (!row || row.call_due_at === null) return this.refused(viewer, null, 'unknown');
    if (row.agent_id !== null) return { ok: false, rule: null, code: 'already_assigned' };
    const agent = await this.db.first('SELECT 1 FROM agents WHERE id = ? AND network_id = ? AND status = ?', [agentId, viewer.networkId, 'active']);
    if (!agent) return { ok: false, rule: null, code: 'bad_agent' };
    const members = await this.fiche.membersOf(await this.fiche.rootOf(row.referred_id));
    const at = this.now().toISOString();
    await this.db.run(`UPDATE persons SET agent_id = ?, updated_at = ? WHERE id IN (${members.map(() => '?').join(', ')}) AND agent_id IS NULL`, [agentId, at, ...members]);
    await this.db.run('UPDATE partner_recommendations SET agent_id = ? WHERE id = ? AND agent_id IS NULL', [agentId, recommendationId]);
    await appendEvent(this.journal, { type: 'recommandation.alerte', actor: this.actor(viewer), subject: `agent:${agentId}`, data: { rule: 'R142', recommendation: recommendationId, origin: 'partner' } }, this.now);
    return { ok: true, value: { assigned: true } };
  }

  /** « Appel fait » pour une recommandation de partenaire : l'agent qui a la tâche, avec ses droits d'aujourd'hui [R16]. */
  async callDone(viewer: Viewer, recommendationId: string): Promise<RecommendationResult<{ done: true }>> {
    const row = await this.db.first<PartnerRecommendationRow>('SELECT * FROM partner_recommendations WHERE id = ? AND network_id = ?', [recommendationId, viewer.networkId]);
    if (!row || row.call_due_at === null) return this.refused(viewer, null, 'unknown');
    if (viewer.role !== 'agent' || viewer.userId !== row.agent_id) return this.refused(viewer, null, 'not_assigned');
    const read = await this.acces.readFiche(viewer, await this.fiche.rootOf(row.referred_id));
    if (!read.ok) return { ok: false, rule: 'R16', code: read.code };
    if (read.view !== 'full') return this.refused(viewer, null, 'not_assigned');
    await this.db.run('UPDATE partner_recommendations SET call_done_at = ? WHERE id = ? AND call_done_at IS NULL', [this.now().toISOString(), recommendationId]);
    return { ok: true, value: { done: true } };
  }
}
