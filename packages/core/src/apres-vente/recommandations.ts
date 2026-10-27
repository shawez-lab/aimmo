/**
 * Recommandations (M11, F01) : un client recommande un proche, qui arrive dans la fiche unique avec la source
 * « recommandation » et le client qui recommande [R66].
 *
 * Une recommandation n'est jamais rémunérée à un particulier (loi Hoguet) : la saisie n'a aucun champ de récompense,
 * et tout texte qui en parle est refusé [R66]. Le proche n'est appelé que s'il l'a accepté, selon le client, avec la
 * preuve rangée comme un accord [R03] ; une personne exclue ou qui a demandé l'arrêt n'est jamais rappelée [R02, R04].
 * Rien n'est envoyé ici. Aucune coordonnée ne va au journal [R13].
 */
import type { Acces } from '../acces/acces.ts';
import type { Viewer } from '../acces/droits.ts';
import type { FicheClient } from '../db/fiche-client.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { PROJECT_KINDS, type IdentifierKind, type ProjectKind } from '../db/types.ts';
import type { FicheUnique } from '../fiche/fusion.ts';
import { normalizeIdentifier } from '../fiche/normalize.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';

export const REFERRAL_SOURCE = 'recommandation';
export const REFERRAL_PURPOSE = 'recommandation';
/** La tâche « appeler » est due le lendemain de la saisie. */
export const REFERRAL_CALL_HOURS = 24;

/** Les seuls champs d'une recommandation : aucun ne parle de récompense. */
export const REFERRAL_FIELDS = ['firstName', 'email', 'phone', 'projectKind', 'callable', 'proof'] as const;

const plain = (s: string): string => s.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase('fr');
/** Tout ce qui promet ou décrit une récompense au client qui recommande [R66]. */
export const REWARD =
  /\b(?:prime|primes|cadeau|cadeaux|commission|commissions|bon d.achat|bons d.achat|cheque|cheques|pourcentage|pourcent|recompense\w*|remuner\w*|gratification\w*|retrocession\w*|parrainage remunere|euros?|eur|carte cadeau|ristourne|dedommag\w*|merci en argent)\b|%|€/;

export function mentionsReward(text: string): boolean {
  return REWARD.test(plain(text));
}

export type ReferralRefusal = { ok: false; rule: 'R16' | 'R66' | 'R03' | null; code: string };

/**
 * Ce que rend une recommandation rangée : la même chose que le proche soit nouveau, déjà client du lecteur, d'un autre
 * agent, exclu ou sans accord ; rien n'y dit qui le suit [R16].
 */
export interface Referral {
  id: string;
  recorded: true;
}

/** Une tâche « appeler » ouverte d'un agent. */
export interface ReferralCall {
  referralId: string;
  personId: string;
  firstName: string | null;
  dueAt: string;
}

interface ReferralRow {
  id: string;
  network_id: string;
  referrer_id: string;
  referred_id: string;
  project_id: string | null;
  first_name: string | null;
  agent_id: string | null;
  callable: number;
  call_due_at: string | null;
  call_done_at: string | null;
  created_by: string;
  created_at: string;
}

export interface RecommandationsOptions {
  now?: () => Date;
  newId?: () => string;
}

export class Recommandations {
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(
    private readonly db: SqlDatabase,
    private readonly store: FicheClient,
    private readonly fiche: FicheUnique,
    private readonly acces: Acces,
    private readonly journal: JournalStore,
    options: RecommandationsOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => crypto.randomUUID());
  }

  private actor(viewer: Viewer): string {
    return `${String(viewer.role)}:${viewer.userId}`;
  }

  private async refused(viewer: Viewer, subject: string | null, code: string): Promise<ReferralRefusal> {
    await appendEvent(this.journal, { type: 'acces.refuse', actor: this.actor(viewer), subject, data: { rule: 'R16', role: String(viewer.role), kind: 'referral', code } }, this.now);
    return { ok: false, rule: 'R16', code };
  }

  /** Une personne opposée : exclusion active ou accord « recommandation » retiré [R02, R03, R04]. */
  private async opposed(personId: string, at: Date): Promise<boolean> {
    const view = await this.fiche.view(personId);
    return (
      view.exclusions.some((e) => e.lifted_at === null || Date.parse(e.lifted_at) > at.getTime()) ||
      view.consents.some((c) => c.purpose === REFERRAL_PURPOSE && c.withdrawn_at !== null)
    );
  }

  /**
   * L'agent du client, ou la direction, range la recommandation d'un proche. Le proche est rattaché à sa fiche s'il en
   * a une, créé sinon. La réponse est la même dans tous les cas [R16] ; chaque refus va au journal, sans donnée [R13].
   */
  async recommend(viewer: Viewer, referrerPersonId: string, input: unknown): Promise<{ ok: true; value: Referral } | ReferralRefusal> {
    if (viewer.role !== 'agent' && viewer.role !== 'direction') return this.refused(viewer, `person:${referrerPersonId}`, 'role');
    const read = await this.acces.readFiche(viewer, referrerPersonId);
    if (!read.ok) return { ok: false, rule: 'R16', code: read.code };
    if (read.view !== 'full') return this.refused(viewer, `person:${referrerPersonId}`, 'not_assigned');
    const referrer = read.value.person;
    const stop = async (rule: ReferralRefusal['rule'], code: string): Promise<ReferralRefusal> => {
      await appendEvent(this.journal, { type: 'recommandation.refusee', actor: this.actor(viewer), subject: `person:${referrer.id}`, data: { rule, code } }, this.now);
      return { ok: false, rule, code };
    };

    // La forme d'abord : aucun champ en dehors de la liste, donc aucun champ de récompense possible [R66].
    if (input === null || typeof input !== 'object' || Array.isArray(input)) return stop(null, 'bad_shape');
    const raw = input as Record<string, unknown>;
    if (Object.keys(raw).some((k) => !(REFERRAL_FIELDS as readonly string[]).includes(k))) return stop('R66', 'unknown_field');
    if (Object.values(raw).some((v) => typeof v === 'string' && mentionsReward(v))) return stop('R66', 'reward');
    const { firstName, email, phone, projectKind, callable, proof } = raw;
    if (firstName !== undefined && firstName !== null && (typeof firstName !== 'string' || firstName.trim() === '' || firstName.trim().length > 60)) return stop(null, 'bad_first_name');
    if (typeof projectKind !== 'string' || !(PROJECT_KINDS as readonly string[]).includes(projectKind)) return stop(null, 'bad_project');
    if (typeof callable !== 'boolean') return stop(null, 'bad_callable');
    if (callable && (typeof proof !== 'string' || proof.trim() === '' || proof.length > 300)) return stop('R03', 'bad_proof');
    const ids: { kind: IdentifierKind; value: string }[] = [];
    for (const [kind, value] of [['email', email], ['phone', phone]] as const) {
      if (value === undefined || value === null) continue;
      if (typeof value !== 'string' || value.length > 254 || normalizeIdentifier(kind, value) === null) return stop(null, `bad_${kind}`);
      ids.push({ kind, value });
    }
    if (ids.length === 0) return stop(null, 'no_contact');

    const networkId = viewer.networkId;
    const referrerAgent = read.value.members.map((m) => m.agent_id).find((a) => a !== null) ?? null;
    const at = this.now();
    const typedName = typeof firstName === 'string' ? firstName.trim() : null;

    // Le proche : sa fiche gardée s'il est connu du réseau. Tout est vérifié avant la première écriture.
    let referredId: string | null = null;
    for (const id of ids) {
      const found = await this.fiche.findByIdentifier(networkId, id.kind, id.value);
      if (found.length > 0) {
        referredId = await this.fiche.rootOf(found[0]!.id);
        break;
      }
    }
    if (referredId && (await this.fiche.membersOf(referredId)).includes(referrer.id)) return stop(null, 'same_person');
    if (referredId && (await this.db.first('SELECT id FROM referrals WHERE referrer_id = ? AND referred_id = ?', [referrer.id, referredId]))) return stop(null, 'already_referred');
    const followedBy = referredId ? ((await this.fiche.view(referredId)).members.map((m) => m.agent_id).find((a) => a !== null) ?? null) : null;
    // L'agent qui suit le proche reçoit la tâche ; un proche sans agent va à celui qui saisit, ou à l'agent du client.
    const agentId = followedBy ?? (viewer.role === 'agent' ? viewer.userId : referrerAgent);
    if (!referredId) referredId = (await this.store.createPerson({ networkId, agentId, firstName: typedName })).id;
    else if (followedBy === null && agentId !== null) {
      // Un proche connu que personne ne suit passe à l'agent de la tâche : sans cela, il ne pourrait pas ouvrir sa fiche.
      const members = await this.fiche.membersOf(referredId);
      await this.db.run(`UPDATE persons SET agent_id = ?, updated_at = ? WHERE id IN (${members.map(() => '?').join(', ')}) AND agent_id IS NULL`, [agentId, at.toISOString(), ...members]);
    }
    for (const id of ids) {
      // Une coordonnée déjà rangée n'est pas ajoutée de nouveau.
      if ((await this.fiche.findByIdentifier(networkId, id.kind, id.value)).length === 0) await this.fiche.addIdentifier({ networkId, agentId, personId: referredId, kind: id.kind, value: id.value });
    }
    const project = await this.store.createProject({ networkId, agentId, personId: referredId, kind: projectKind as ProjectKind });
    // La source ne nomme pas le client : la fiche du proche peut être celle d'un autre agent [R16].
    await this.store.addSource({ networkId, agentId, personId: referredId, projectId: project.id, channel: REFERRAL_SOURCE, detail: 'recommandé par un client', occurredAt: at });

    // Une personne opposée n'est jamais rappelée, et la parole d'un tiers ne vaut pas accord [R02, R03, R04].
    const callTask = callable === true && agentId !== null && !(await this.opposed(referredId, at));
    if (callTask) {
      await this.store.addConsent({ networkId, agentId, personId: referredId, purpose: REFERRAL_PURPOSE, channel: 'phone', proof: `${(proof as string).trim()} (selon le client qui recommande)`, givenAt: at });
    }
    const id = this.newId();
    const due = callTask ? new Date(at.getTime() + REFERRAL_CALL_HOURS * 3_600_000).toISOString() : null;
    const { changes } = await this.db.run(
      `INSERT INTO referrals (id, network_id, referrer_id, referred_id, project_id, first_name, agent_id, callable, call_due_at, call_done_at, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?) ON CONFLICT (referrer_id, referred_id) DO NOTHING`,
      [id, networkId, referrer.id, referredId, project.id, typedName, agentId, callable ? 1 : 0, due, this.actor(viewer), at.toISOString()],
    );
    if (changes !== 1) return stop(null, 'already_referred');
    await appendEvent(
      this.journal,
      { type: 'recommandation.rangee', actor: this.actor(viewer), subject: `person:${referredId}`, data: { rule: 'R66', referrer: `person:${referrer.id}`, call: callTask } },
      this.now,
    );
    return { ok: true, value: { id, recorded: true } };
  }

  /**
   * Qui a recommandé cette personne, et qui elle a recommandé, pour qui voit la fiche [R16]. Du côté du client, le
   * proche est dit par le prénom saisi, jamais par sa fiche ; du côté du proche, le client n'est nommé que si le
   * lecteur voit aussi sa fiche.
   */
  async linksOf(
    viewer: Viewer,
    personId: string,
  ): Promise<{ ok: true; value: { recommendedBy: { firstName: string | null }[]; recommended: { referralId: string; firstName: string | null }[] } } | ReferralRefusal> {
    const read = await this.acces.readFiche(viewer, personId);
    if (!read.ok) return { ok: false, rule: 'R16', code: read.code };
    if (read.view !== 'full') return this.refused(viewer, `person:${personId}`, 'not_assigned');
    const members = read.value.members.map((m) => m.id);
    const marks = members.map(() => '?').join(', ');
    const rows = await this.db.all<ReferralRow>(`SELECT * FROM referrals WHERE network_id = ? AND (referrer_id IN (${marks}) OR referred_id IN (${marks})) ORDER BY created_at, id`, [
      viewer.networkId,
      ...members,
      ...members,
    ]);
    const recommendedBy: { firstName: string | null }[] = [];
    const recommended: { referralId: string; firstName: string | null }[] = [];
    for (const r of rows) {
      if (members.includes(r.referrer_id)) recommended.push({ referralId: r.id, firstName: r.first_name });
      if (members.includes(r.referred_id)) {
        const other = await this.acces.readFiche(viewer, r.referrer_id);
        recommendedBy.push({ firstName: other.ok && other.view === 'full' ? (other.value.members.map((m) => m.first_name).find((n) => n) ?? null) : null });
      }
    }
    return { ok: true, value: { recommendedBy, recommended } };
  }

  /** Les tâches « appeler » ouvertes de l'agent ; une personne devenue opposée n'y figure plus [R02, R04]. */
  async callsOf(viewer: Viewer): Promise<{ ok: true; value: ReferralCall[] } | ReferralRefusal> {
    if (viewer.role !== 'agent') return this.refused(viewer, null, 'role');
    const rows = await this.db.all<ReferralRow>('SELECT * FROM referrals WHERE network_id = ? AND agent_id = ? AND call_due_at IS NOT NULL AND call_done_at IS NULL ORDER BY call_due_at, id', [viewer.networkId, viewer.userId]);
    const at = this.now();
    const calls: ReferralCall[] = [];
    for (const r of rows) {
      const root = await this.fiche.rootOf(r.referred_id);
      if (await this.opposed(root, at)) continue;
      const read = await this.acces.readFiche(viewer, root);
      if (!read.ok || read.view !== 'full') continue;
      calls.push({ referralId: r.id, personId: root, firstName: read.value.members.map((m) => m.first_name).find((n) => n) ?? null, dueAt: r.call_due_at! });
    }
    return { ok: true, value: calls };
  }

  /** « Appel fait » : l'agent qui a la tâche seulement ; la ligne reste [R17]. */
  async callDone(viewer: Viewer, referralId: string): Promise<{ ok: true } | ReferralRefusal> {
    const row = await this.db.first<ReferralRow>('SELECT * FROM referrals WHERE id = ?', [referralId]);
    if (!row || row.network_id !== viewer.networkId || row.call_due_at === null) return this.refused(viewer, `referral:${referralId}`, 'unknown');
    if (viewer.role !== 'agent' || viewer.userId !== row.agent_id) return this.refused(viewer, `referral:${referralId}`, 'not_assigned');
    // Les droits d'aujourd'hui, pas ceux du jour de la recommandation : un agent parti, ou une fiche passée à un autre, ne la marque plus [R16].
    const read = await this.acces.readFiche(viewer, await this.fiche.rootOf(row.referred_id));
    if (!read.ok) return { ok: false, rule: 'R16', code: read.code };
    if (read.view !== 'full') return this.refused(viewer, `referral:${referralId}`, 'not_assigned');
    await this.db.run('UPDATE referrals SET call_done_at = ? WHERE id = ? AND call_done_at IS NULL', [this.now().toISOString(), referralId]);
    return { ok: true };
  }
}
