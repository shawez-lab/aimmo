/**
 * Mise en relation avec l'accord du client, choix du client (M18, U02) [R74, R75].
 *
 * L'agent d'un projet (ou la direction) demande des partenaires d'un métier pour ce projet, dans une zone. L'annuaire
 * (U01) dit lesquels sont proposables ce jour-là [R73] ; parmi eux, un tirage au sort, rejouable par sa graine rangée,
 * en montre au plus `MAX_SHOWN` au client : quand la zone en compte au moins deux, au moins deux sont montrés. Aucun
 * ordre ne vient d'une note, d'un avis ni de l'IA, et rien ici ne choisit à la place du client [R75, R14].
 *
 * Le client choisit avec l'agent : l'agent range l'accord du client, avec le partenaire choisi parmi ceux montrés, la
 * date, le canal et la preuve (une référence de stockage). Sans cet accord, la mise en relation ne peut pas être confiée
 * au partenaire [R74]. Un partenaire devenu indisponible entre-temps ne peut être ni choisi ni confié [R73].
 *
 * Les étapes s'ajoutent à la suite, rien ne change ni ne s'efface [R17] ; chacune est écrite au journal, sans nom [R13].
 * Rien n'est envoyé ici : la demande au partenaire part à son espace (U04) et par le contrôle central des envois (U09).
 */
import type { Viewer } from '../acces/droits.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import { Annuaire, DIAGNOSTIC_DOMAINS, PARTNER_TRADES, type DiagnosticDomain, type PartnerCard, type PartnerTrade } from './annuaire.ts';

/** Nombre de partenaires montrés au client, au plus. Réglage. */
export const MAX_SHOWN = 3;

export const CONSENT_CHANNELS = ['oral', 'ecrit', 'mail', 'sms', 'whatsapp'] as const;
export type ConsentChannel = (typeof CONSENT_CHANNELS)[number];

export type ReferralState = 'proposee' | 'accord_client' | 'confiee' | 'en_cours' | 'terminee' | 'abandonnee';

/** Les étapes permises depuis chaque état ; tout le reste est refusé. */
const NEXT: Readonly<Record<ReferralState, readonly ReferralState[]>> = Object.freeze({
  proposee: ['accord_client', 'abandonnee'],
  accord_client: ['confiee', 'abandonnee'],
  confiee: ['en_cours', 'terminee', 'abandonnee'],
  en_cours: ['terminee', 'abandonnee'],
  terminee: [],
  abandonnee: [],
});

export interface ConsentProofStore {
  /** La référence existe dans le stockage. */
  has(ref: string): Promise<boolean>;
}

export interface Referral {
  referralId: string;
  projectId: string;
  propertyId: string | null;
  trade: PartnerTrade;
  domain: DiagnosticDomain | null;
  postcode: string;
  /** La graine du tirage : `drawOrder(seed, ids)` redonne le même ordre. */
  seed: number;
  /** Les partenaires montrés au client, dans l'ordre du tirage. */
  shown: PartnerCard[];
  state: ReferralState;
  /** Le partenaire choisi par le client, une fois son accord rangé. */
  chosenPartnerId: string | null;
  consent: { at: string; channel: ConsentChannel } | null;
  createdAt: string;
}

export type ReferralRefusal = { ok: false; rule: 'R16' | 'R73' | 'R74' | 'R75' | 'R76' | null; code: string };
export type ReferralResult<T> = { ok: true; value: T } | ReferralRefusal;

/** Un générateur pseudo-aléatoire de 32 bits (mulberry32), déterministe pour une graine. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * L'ordre du tirage : les identifiants rangés d'abord par ordre alphabétique, puis mélangés (Fisher-Yates) avec la
 * graine. La même graine et les mêmes identifiants redonnent toujours le même ordre, sans aucune note [R75].
 */
export function drawOrder(seed: number, ids: readonly string[]): string[] {
  const out = [...new Set(ids)].sort();
  const rand = mulberry32(seed);
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const REF_FILE = new RegExp(`^${UUID}\\.(?:pdf|jpg|png|txt)$`);
const POSTCODE = /^\d{5}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const isTrade = (v: unknown): v is PartnerTrade => typeof v === 'string' && PARTNER_TRADES.some((t) => t.trade === v);

interface ReferralRow {
  id: string;
  network_id: string;
  project_id: string;
  property_id: string | null;
  trade: PartnerTrade;
  domain: string;
  postcode: string;
  seed: number;
  created_at: string;
}

interface StepRow {
  seq: number;
  state: Exclude<ReferralState, 'proposee'>;
  partner_id: string | null;
  consent_at: string | null;
  consent_channel: ConsentChannel | null;
}

export interface MiseEnRelationOptions {
  now?: () => Date;
  newId?: () => string;
  /** La graine du tirage ; par défaut 32 bits tirés par `crypto.getRandomValues`. */
  newSeed?: () => number;
}

export class MiseEnRelation {
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly newSeed: () => number;

  constructor(
    private readonly db: SqlDatabase,
    private readonly annuaire: Annuaire,
    private readonly proofs: ConsentProofStore,
    private readonly journal: JournalStore,
    options: MiseEnRelationOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => crypto.randomUUID());
    this.newSeed = options.newSeed ?? (() => crypto.getRandomValues(new Uint32Array(1))[0]!);
  }

  private actor(viewer: Viewer): string {
    return `${String(viewer.role)}:${viewer.userId}`;
  }

  private async refuse(viewer: Viewer, subject: string, code: string): Promise<ReferralRefusal> {
    await appendEvent(this.journal, { type: 'acces.refuse', actor: this.actor(viewer), subject, data: { rule: 'R16', role: String(viewer.role), kind: 'partner_referral', code } }, this.now);
    return { ok: false, rule: 'R16', code };
  }

  /** L'agent actif du projet et la direction agissent sur ses mises en relation ; tout autre est refusé [R16]. */
  private async gateProject(viewer: Viewer, projectId: unknown): Promise<ReferralRefusal | { agentId: string | null }> {
    const subject = `project:${String(projectId)}`;
    if (typeof projectId !== 'string') return this.refuse(viewer, subject, 'unknown');
    const project = await this.db.first<{ agent_id: string | null }>('SELECT agent_id FROM projects WHERE id = ? AND network_id = ?', [projectId, viewer.networkId]);
    if (!project) return this.refuse(viewer, subject, 'unknown');
    if (viewer.role === 'direction') return { agentId: project.agent_id };
    if (viewer.role !== 'agent') return this.refuse(viewer, subject, 'role');
    if (project.agent_id !== viewer.userId) return this.refuse(viewer, subject, 'not_assigned');
    const agent = await this.db.first<{ status: string }>('SELECT status FROM agents WHERE id = ? AND network_id = ?', [viewer.userId, viewer.networkId]);
    if (agent?.status !== 'active') return this.refuse(viewer, subject, 'agent_inactive');
    return { agentId: project.agent_id };
  }

  private async load(viewer: Viewer, referralId: unknown): Promise<ReferralRefusal | ReferralRow> {
    if (typeof referralId !== 'string') return this.refuse(viewer, `referral:${String(referralId)}`, 'unknown');
    const row = await this.db.first<ReferralRow>('SELECT id, network_id, project_id, property_id, trade, domain, postcode, seed, created_at FROM partner_referrals WHERE id = ? AND network_id = ?', [
      referralId,
      viewer.networkId,
    ]);
    if (!row) return this.refuse(viewer, `referral:${referralId}`, 'unknown');
    const gate = await this.gateProject(viewer, row.project_id);
    if ('ok' in gate) return gate;
    return row;
  }

  /**
   * Prépare la proposition au client : les partenaires proposables du métier dans la zone, tirés au sort, au plus
   * `MAX_SHOWN`. Le code de la zone vient du bien du projet s'il en a un, sinon de la demande [R73, R75].
   */
  async propose(viewer: Viewer, input: { projectId: unknown; trade: unknown; domain?: unknown; postcode?: unknown; propertyId?: unknown }): Promise<ReferralResult<Referral>> {
    const gate = await this.gateProject(viewer, input.projectId);
    if ('ok' in gate) return gate;
    const projectId = input.projectId as string;
    if (!isTrade(input.trade)) return { ok: false, rule: null, code: 'unknown_trade' };
    let domain: DiagnosticDomain | null = null;
    if (input.trade === 'diagnostiqueur') {
      if (typeof input.domain !== 'string' || !DIAGNOSTIC_DOMAINS.includes(input.domain as DiagnosticDomain)) return { ok: false, rule: null, code: 'domain_required' };
      domain = input.domain as DiagnosticDomain;
    } else if (input.domain !== undefined && input.domain !== null && input.domain !== '') return { ok: false, rule: null, code: 'bad_domain' };
    let propertyId: string | null = null;
    let postcode: string | null = typeof input.postcode === 'string' && POSTCODE.test(input.postcode) ? input.postcode : null;
    if (input.propertyId !== undefined && input.propertyId !== null) {
      if (typeof input.propertyId !== 'string') return { ok: false, rule: null, code: 'bad_property' };
      // Le bien doit appartenir au projet : jamais un bien d'un autre client [R16].
      const link = await this.db.first<{ postal_code: string | null }>(
        'SELECT p.postal_code FROM project_properties pp JOIN properties p ON p.id = pp.property_id WHERE pp.project_id = ? AND pp.property_id = ? AND p.network_id = ?',
        [projectId, input.propertyId, viewer.networkId],
      );
      if (!link) return { ok: false, rule: null, code: 'bad_property' };
      propertyId = input.propertyId;
      if (link.postal_code && POSTCODE.test(link.postal_code)) postcode = link.postal_code;
    }
    if (!postcode) return { ok: false, rule: null, code: 'bad_postcode' };
    const found = await this.annuaire.search(viewer, { trade: input.trade, postcode, domain: domain ?? undefined });
    if (!found.ok) return { ok: false, rule: found.rule === 'R73' ? 'R73' : found.rule, code: found.code };
    const proposable = found.value.proposable;
    if (proposable.length === 0) return { ok: false, rule: 'R73', code: 'no_partner' };
    const seed = this.newSeed() >>> 0;
    const order = drawOrder(
      seed,
      proposable.map((p) => p.partnerId),
    ).slice(0, MAX_SHOWN);
    const id = this.newId();
    const at = this.now().toISOString();
    await this.db.run('INSERT INTO partner_referrals (id, network_id, project_id, property_id, trade, domain, postcode, seed, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [
      id,
      viewer.networkId,
      projectId,
      propertyId,
      input.trade,
      domain ?? '',
      postcode,
      seed,
      this.actor(viewer),
      at,
    ]);
    for (const [i, partnerId] of order.entries()) {
      await this.db.run('INSERT INTO partner_referral_options (referral_id, position, partner_id) VALUES (?, ?, ?)', [id, i + 1, partnerId]);
    }
    await appendEvent(
      this.journal,
      { type: 'mise_en_relation.proposee', actor: this.actor(viewer), subject: `referral:${id}`, data: { rule: 'R75', project: `project:${projectId}`, trade: input.trade, domain, eligible: proposable.length, shown: order.length, seed } },
      this.now,
    );
    return { ok: true, value: await this.compute((await this.db.first<ReferralRow>('SELECT id, network_id, project_id, property_id, trade, domain, postcode, seed, created_at FROM partner_referrals WHERE id = ?', [id]))!) };
  }

  /**
   * Range l'accord du client et le partenaire qu'il a choisi, parmi ceux montrés : sa date (après la proposition, pas
   * dans l'avenir), son canal et sa preuve. Le choix est celui du client, rangé par l'agent [R74, R75].
   */
  async recordConsent(viewer: Viewer, referralId: unknown, input: { partnerId: unknown; consentAt: unknown; channel: unknown; proofRef: unknown }): Promise<ReferralResult<Referral>> {
    const row = await this.load(viewer, referralId);
    if ('ok' in row) return row;
    const current = await this.compute(row);
    if (!NEXT[current.state].includes('accord_client')) return { ok: false, rule: null, code: 'bad_state' };
    if (typeof input.partnerId !== 'string' || !current.shown.some((p) => p.partnerId === input.partnerId)) return { ok: false, rule: 'R75', code: 'not_shown' };
    if (typeof input.consentAt !== 'string' || !ISO.test(input.consentAt) || Number.isNaN(Date.parse(input.consentAt))) return { ok: false, rule: 'R74', code: 'bad_consent_date' };
    const consentAt = new Date(input.consentAt).toISOString();
    if (consentAt < row.created_at || Date.parse(consentAt) > this.now().getTime()) return { ok: false, rule: 'R74', code: 'bad_consent_date' };
    if (typeof input.channel !== 'string' || !(CONSENT_CHANNELS as readonly string[]).includes(input.channel)) return { ok: false, rule: 'R74', code: 'bad_channel' };
    const prefix = `relations/${row.id}/`;
    if (typeof input.proofRef !== 'string' || !input.proofRef.startsWith(prefix) || !REF_FILE.test(input.proofRef.slice(prefix.length))) return { ok: false, rule: 'R74', code: 'bad_proof' };
    if (!(await this.proofs.has(input.proofRef))) return { ok: false, rule: 'R74', code: 'not_stored' };
    if (!(await this.annuaire.proposableOn(row.network_id, input.partnerId, this.now(), row.domain === '' ? null : (row.domain as DiagnosticDomain)))) {
      return { ok: false, rule: 'R73', code: 'partner_unavailable' };
    }
    // Les rémunérations déclarées (U03) doivent toutes figurer dans le dernier texte montré au client : rien ne
    // s'efface, donc le nombre de rémunérations ne fait que monter, et le dernier texte doit les citer toutes. On ne se
    // fie pas aux heures, qui peuvent être égales ou se croiser [R76].
    const fees = Number((await this.db.first<{ n: number }>('SELECT COUNT(*) AS n FROM partner_referral_fees WHERE referral_id = ?', [row.id]))?.n ?? 0);
    if (fees > 0) {
      const last = await this.db.first<{ fees_count: number }>('SELECT fees_count FROM partner_referral_disclosures WHERE referral_id = ? ORDER BY rowid DESC LIMIT 1', [row.id]);
      if (!last || Number(last.fees_count) !== fees) return { ok: false, rule: 'R76', code: 'fees_not_disclosed' };
    }
    const done = await this.step(viewer, row, current, 'accord_client', { partnerId: input.partnerId, consentAt, channel: input.channel as ConsentChannel, proofRef: input.proofRef });
    if (done) return done;
    await appendEvent(this.journal, { type: 'mise_en_relation.accord_client', actor: this.actor(viewer), subject: `referral:${row.id}`, data: { rule: 'R74', partner: `partner:${input.partnerId}`, channel: input.channel } }, this.now);
    return { ok: true, value: await this.compute(row) };
  }

  /** Confie la mise en relation au partenaire choisi : seulement après l'accord du client, et s'il est encore proposable [R74, R73]. */
  async entrust(viewer: Viewer, referralId: unknown): Promise<ReferralResult<Referral>> {
    const row = await this.load(viewer, referralId);
    if ('ok' in row) return row;
    const current = await this.compute(row);
    if (current.state === 'proposee') return { ok: false, rule: 'R74', code: 'no_consent' };
    if (!NEXT[current.state].includes('confiee')) return { ok: false, rule: null, code: 'bad_state' };
    if (!(await this.annuaire.proposableOn(row.network_id, current.chosenPartnerId!, this.now(), row.domain === '' ? null : (row.domain as DiagnosticDomain)))) {
      return { ok: false, rule: 'R73', code: 'partner_unavailable' };
    }
    const done = await this.step(viewer, row, current, 'confiee');
    if (done) return done;
    await appendEvent(this.journal, { type: 'mise_en_relation.confiee', actor: this.actor(viewer), subject: `referral:${row.id}`, data: { rule: 'R74', partner: `partner:${current.chosenPartnerId}` } }, this.now);
    return { ok: true, value: await this.compute(row) };
  }

  /** L'agent marque la mise en relation terminée, ou l'abandonne ; rien ne s'efface [R17]. */
  async close(viewer: Viewer, referralId: unknown, outcome: unknown): Promise<ReferralResult<Referral>> {
    if (outcome !== 'terminee' && outcome !== 'abandonnee') return { ok: false, rule: null, code: 'bad_outcome' };
    const row = await this.load(viewer, referralId);
    if ('ok' in row) return row;
    const current = await this.compute(row);
    if (!NEXT[current.state].includes(outcome)) return { ok: false, rule: null, code: 'bad_state' };
    const done = await this.step(viewer, row, current, outcome);
    if (done) return done;
    await appendEvent(this.journal, { type: `mise_en_relation.${outcome}`, actor: this.actor(viewer), subject: `referral:${row.id}`, data: { state: outcome } }, this.now);
    return { ok: true, value: await this.compute(row) };
  }

  /** Lire une mise en relation, pour l'agent du projet ou la direction [R16]. */
  async get(viewer: Viewer, referralId: unknown): Promise<ReferralResult<Referral>> {
    const row = await this.load(viewer, referralId);
    if ('ok' in row) return row;
    return { ok: true, value: await this.compute(row) };
  }

  /** L'état d'une mise en relation et son partenaire confié, sans contrôle d'accès : pour l'espace partenaire (U04). */
  async entrusted(networkId: string, referralId: string): Promise<{ partnerId: string; state: ReferralState } | null> {
    const row = await this.db.first<ReferralRow>('SELECT id, network_id, project_id, property_id, trade, domain, postcode, seed, created_at FROM partner_referrals WHERE id = ? AND network_id = ?', [
      referralId,
      networkId,
    ]);
    if (!row) return null;
    // Seule une étape « confiée » rangée ouvre la mise en relation au partenaire : un accord suivi d'un abandon, sans
    // jamais confier, ne lui donne rien [R74].
    const confided = await this.db.first('SELECT 1 FROM partner_referral_steps WHERE referral_id = ? AND state = ? LIMIT 1', [row.id, 'confiee']);
    if (!confided) return null;
    const r = await this.compute(row);
    return { partnerId: r.chosenPartnerId!, state: r.state };
  }

  private async step(
    viewer: Viewer,
    row: ReferralRow,
    current: Referral,
    state: Exclude<ReferralState, 'proposee'>,
    consent?: { partnerId: string; consentAt: string; channel: ConsentChannel; proofRef: string },
  ): Promise<ReferralRefusal | null> {
    const seq = (await this.db.first<{ n: number }>('SELECT COUNT(*) AS n FROM partner_referral_steps WHERE referral_id = ?', [row.id]))!.n + 1;
    try {
      await this.db.run(
        'INSERT INTO partner_referral_steps (referral_id, seq, state, partner_id, consent_at, consent_channel, consent_proof_ref, actor, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [row.id, seq, state, consent?.partnerId ?? null, consent?.consentAt ?? null, consent?.channel ?? null, consent?.proofRef ?? null, this.actor(viewer), this.now().toISOString()],
      );
    } catch (error) {
      // Deux étapes en même temps : une seule passe ; une preuve déjà servie ne sert pas deux fois.
      if (/UNIQUE|PRIMARY/i.test(String(error))) return { ok: false, rule: null, code: /consent_proof_ref/.test(String(error)) ? 'proof_used' : 'busy' };
      throw error;
    }
    void current;
    return null;
  }

  private async compute(row: ReferralRow): Promise<Referral> {
    const options = await this.db.all<{ partner_id: string; trade: PartnerTrade; business_name: string }>(
      'SELECT o.partner_id, p.trade, p.business_name FROM partner_referral_options o JOIN partners p ON p.id = o.partner_id WHERE o.referral_id = ? ORDER BY o.position',
      [row.id],
    );
    const steps = await this.db.all<StepRow>('SELECT seq, state, partner_id, consent_at, consent_channel FROM partner_referral_steps WHERE referral_id = ? ORDER BY seq', [row.id]);
    const consent = steps.find((s) => s.state === 'accord_client');
    return {
      referralId: row.id,
      projectId: row.project_id,
      propertyId: row.property_id,
      trade: row.trade,
      domain: row.domain === '' ? null : (row.domain as DiagnosticDomain),
      postcode: row.postcode,
      seed: Number(row.seed),
      shown: options.map((o) => ({ partnerId: o.partner_id, trade: o.trade, businessName: o.business_name })),
      state: steps.at(-1)?.state ?? 'proposee',
      chosenPartnerId: consent?.partner_id ?? null,
      consent: consent ? { at: consent.consent_at!, channel: consent.consent_channel! } : null,
      createdAt: row.created_at,
    };
  }
}
