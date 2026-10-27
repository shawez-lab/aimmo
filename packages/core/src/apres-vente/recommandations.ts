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

export interface Referral {
  id: string;
  referrerId: string;
  referredId: string;
  /** La tâche « appeler » : seulement pour l'agent qui suit le proche, s'il l'a accepté et n'est pas exclu. */
  callDueAt: string | null;
  callDoneAt: string | null;
}

interface ReferralRow {
  id: string;
  network_id: string;
  referrer_id: string;
  referred_id: string;
  project_id: string | null;
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

  /**
   * L'agent du client, ou la direction, range la recommandation d'un proche. Le proche est rattaché à sa fiche s'il en
   * a une, créé sinon. Rend la recommandation ; la tâche « appeler » n'y figure que si elle est pour ce lecteur.
   */
  async recommend(viewer: Viewer, referrerPersonId: string, input: unknown): Promise<{ ok: true; value: Referral } | ReferralRefusal> {
    if (viewer.role !== 'agent' && viewer.role !== 'direction') return this.refused(viewer, `person:${referrerPersonId}`, 'role');
    const read = await this.acces.readFiche(viewer, referrerPersonId);
    if (!read.ok) return { ok: false, rule: 'R16', code: read.code };
    if (read.view !== 'full') return this.refused(viewer, `person:${referrerPersonId}`, 'not_assigned');

    // La forme d'abord : aucun champ en dehors de la liste, donc aucun champ de récompense possible [R66].
    if (input === null || typeof input !== 'object' || Array.isArray(input)) return { ok: false, rule: null, code: 'bad_shape' };
    const raw = input as Record<string, unknown>;
    if (Object.keys(raw).some((k) => !(REFERRAL_FIELDS as readonly string[]).includes(k))) return { ok: false, rule: 'R66', code: 'unknown_field' };
    const texts = Object.values(raw).filter((v): v is string => typeof v === 'string');
    if (texts.some(mentionsReward)) {
      await appendEvent(this.journal, { type: 'recommandation.refusee', actor: this.actor(viewer), subject: `person:${read.value.person.id}`, data: { rule: 'R66', code: 'reward' } }, this.now);
      return { ok: false, rule: 'R66', code: 'reward' };
    }
    const { firstName, email, phone, projectKind, callable, proof } = raw;
    if (firstName !== undefined && firstName !== null && (typeof firstName !== 'string' || firstName.trim() === '' || firstName.length > 60)) return { ok: false, rule: null, code: 'bad_first_name' };
    if (typeof projectKind !== 'string' || !(PROJECT_KINDS as readonly string[]).includes(projectKind)) return { ok: false, rule: null, code: 'bad_project' };
    if (typeof callable !== 'boolean') return { ok: false, rule: null, code: 'bad_callable' };
    if (callable && (typeof proof !== 'string' || proof.trim() === '' || proof.length > 300)) return { ok: false, rule: 'R03', code: 'bad_proof' };
    const ids: { kind: IdentifierKind; value: string }[] = [];
    for (const [kind, value] of [['email', email], ['phone', phone]] as const) {
      if (value === undefined || value === null) continue;
      if (typeof value !== 'string' || value.length > 254 || normalizeIdentifier(kind, value) === null) return { ok: false, rule: null, code: `bad_${kind}` };
      ids.push({ kind, value });
    }
    if (ids.length === 0) return { ok: false, rule: null, code: 'no_contact' };

    const networkId = viewer.networkId;
    const referrer = read.value.person;
    const referrerAgent = read.value.members.map((m) => m.agent_id).find((a) => a !== null) ?? null;
    const at = this.now();

    // Le proche : sa fiche gardée s'il est connu du réseau, une nouvelle fiche sinon.
    let referredId: string | null = null;
    for (const id of ids) {
      const found = await this.fiche.findByIdentifier(networkId, id.kind, id.value);
      if (found.length > 0) {
        referredId = await this.fiche.rootOf(found[0]!.id);
        break;
      }
    }
    const members = referredId ? (await this.fiche.view(referredId)).members : [];
    if (referredId && (await this.fiche.membersOf(referredId)).includes(referrer.id)) return { ok: false, rule: null, code: 'same_person' };
    const followedBy = members.map((m) => m.agent_id).find((a) => a !== null) ?? null;
    const agentId = referredId ? followedBy : viewer.role === 'agent' ? viewer.userId : referrerAgent;
    if (!referredId) {
      const person = await this.store.createPerson({ networkId, agentId, firstName: typeof firstName === 'string' ? firstName.trim() : null });
      referredId = person.id;
    }
    for (const id of ids) {
      // Une coordonnée déjà rangée sur la fiche n'est pas ajoutée de nouveau.
      const known = await this.fiche.findByIdentifier(networkId, id.kind, id.value);
      if (known.length === 0) await this.fiche.addIdentifier({ networkId, agentId, personId: referredId, kind: id.kind, value: id.value });
    }
    const project = await this.store.createProject({ networkId, agentId, personId: referredId, kind: projectKind as ProjectKind });
    const firstOfReferrer = read.value.members.map((m) => m.first_name).find((n) => n) ?? null;
    await this.store.addSource({ networkId, agentId, personId: referredId, projectId: project.id, channel: REFERRAL_SOURCE, detail: firstOfReferrer ? `recommandé par ${firstOfReferrer}` : 'recommandé par un client', occurredAt: at });

    // Une personne exclue ou qui a demandé l'arrêt n'est jamais rappelée, et la parole d'un tiers ne vaut pas accord [R02, R04].
    const view = await this.fiche.view(referredId);
    const excluded = view.exclusions.some((e) => e.lifted_at === null || Date.parse(e.lifted_at) > at.getTime());
    const withdrawn = view.consents.some((c) => c.purpose === REFERRAL_PURPOSE && c.withdrawn_at !== null);
    const callTask = callable === true && !excluded && !withdrawn && agentId !== null;
    if (callTask) {
      await this.store.addConsent({ networkId, agentId, personId: referredId, purpose: REFERRAL_PURPOSE, channel: 'phone', proof: `${(proof as string).trim()} (selon le client qui recommande)`, givenAt: at });
    }
    const id = this.newId();
    const due = callTask ? new Date(at.getTime() + REFERRAL_CALL_HOURS * 3_600_000).toISOString() : null;
    const { changes } = await this.db.run(
      `INSERT INTO referrals (id, network_id, referrer_id, referred_id, project_id, agent_id, callable, call_due_at, call_done_at, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?) ON CONFLICT (referrer_id, referred_id) DO NOTHING`,
      [id, networkId, referrer.id, referredId, project.id, agentId, callable ? 1 : 0, due, this.actor(viewer), at.toISOString()],
    );
    if (changes !== 1) return { ok: false, rule: null, code: 'already_referred' };
    await appendEvent(
      this.journal,
      { type: 'recommandation.rangee', actor: this.actor(viewer), subject: `person:${referredId}`, data: { rule: 'R66', referrer: `person:${referrer.id}`, call: callTask } },
      this.now,
    );
    // La tâche n'est dite qu'à l'agent qui la reçoit : rien ne dit au lecteur qui suit le proche [R16].
    const mine = callTask && viewer.role === 'agent' && agentId === viewer.userId;
    return { ok: true, value: { id, referrerId: referrer.id, referredId, callDueAt: mine ? due : null, callDoneAt: null } };
  }

  /** Qui a recommandé cette personne, et qui elle a recommandé : sur les deux fiches, pour qui voit la fiche [R16]. */
  async linksOf(viewer: Viewer, personId: string): Promise<{ ok: true; value: { recommendedBy: { personId: string | null; firstName: string | null }[]; recommended: { personId: string | null; firstName: string | null }[] } } | ReferralRefusal> {
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
    // L'autre fiche n'est nommée que si le lecteur la voit aussi ; sinon, seulement qu'il y a un lien.
    const name = async (id: string): Promise<{ personId: string | null; firstName: string | null }> => {
      const other = await this.acces.readFiche(viewer, id);
      if (other.ok && other.view === 'full') return { personId: other.value.person.id, firstName: other.value.members.map((m) => m.first_name).find((n) => n) ?? null };
      return { personId: null, firstName: null };
    };
    const recommendedBy = [];
    const recommended = [];
    for (const r of rows) {
      if (members.includes(r.referred_id)) recommendedBy.push(await name(r.referrer_id));
      if (members.includes(r.referrer_id)) recommended.push(await name(r.referred_id));
    }
    return { ok: true, value: { recommendedBy, recommended } };
  }

  /** « Appel fait » : l'agent qui a la tâche seulement ; la ligne reste [R17]. */
  async callDone(viewer: Viewer, referralId: string): Promise<{ ok: true } | ReferralRefusal> {
    const row = await this.db.first<ReferralRow>('SELECT * FROM referrals WHERE id = ?', [referralId]);
    if (!row || row.network_id !== viewer.networkId || row.call_due_at === null) return this.refused(viewer, `referral:${referralId}`, 'unknown');
    if (viewer.role !== 'agent' || viewer.userId !== row.agent_id) return this.refused(viewer, `referral:${referralId}`, 'not_assigned');
    await this.db.run('UPDATE referrals SET call_done_at = ? WHERE id = ? AND call_done_at IS NULL', [this.now().toISOString(), referralId]);
    return { ok: true };
  }
}
