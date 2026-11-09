/**
 * Candidatures au réseau (M14, J01).
 *
 * Un candidat dépose sa candidature depuis la page de recrutement : ce qu'il déclare, une coordonnée au moins, la
 * source qui l'a amené, et son accord pour être recontacté au sujet de sa candidature, avec sa preuve. Un candidat
 * n'est pas un client : il vit dans `candidates`, jamais dans la fiche client.
 *
 * Aucune note, aucun score, aucun rang : la liste se lit dans l'ordre d'arrivée, sans autre tri, et seule la direction
 * la lit [R81, R14, R16]. Une même coordonnée ne fait qu'une candidature [R18] ; la réponse est la même, que la
 * candidature soit nouvelle ou déjà rangée. Sans accord, la candidature n'est jamais recontactée [R03].
 * Rien n'est envoyé ici ; aucune coordonnée, aucun nom ni aucune question ne va au journal [R13].
 */
import type { Viewer } from '../acces/droits.ts';
import { runBatch, type SqlDatabase, type SqlStatement } from '../db/sql.ts';
import { normalizeEmail, normalizePhone } from '../fiche/normalize.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';

export const CANDIDATE_STATUSES = ['agent_commercial', 'salarie_immobilier', 'autre_metier', 'sans_emploi', 'etudiant', 'autre'] as const;
export type CandidateStatus = (typeof CANDIDATE_STATUSES)[number];
export const CANDIDATE_EXPERIENCES = ['aucune', 'moins_de_2_ans', 'de_2_a_5_ans', 'plus_de_5_ans'] as const;
export type CandidateExperience = (typeof CANDIDATE_EXPERIENCES)[number];
export const CANDIDATE_SOURCES = ['video', 'podcast', 'page', 'parrain', 'autre'] as const;
export type CandidateSource = (typeof CANDIDATE_SOURCES)[number];

/** Les seuls champs d'une candidature : aucun ne note, ne classe ni ne trie [R81]. */
export const CANDIDATE_FIELDS = ['firstName', 'lastName', 'email', 'phone', 'town', 'currentStatus', 'experience', 'question', 'source', 'sponsorAgentId', 'contactConsent', 'contentCode'] as const;

export interface Candidate {
  id: string;
  firstName: string;
  lastName: string | null;
  email: string | null;
  phone: string | null;
  town: string | null;
  currentStatus: CandidateStatus;
  experience: CandidateExperience;
  question: string | null;
  source: CandidateSource;
  sponsorAgentId: string | null;
  /** Le candidat peut être recontacté au sujet de sa candidature : accord rangé avec sa preuve [R03]. */
  contactable: boolean;
  createdAt: string;
}

interface CandidateRow {
  id: string;
  network_id: string;
  first_name: string;
  last_name: string | null;
  email: string | null;
  phone: string | null;
  town: string | null;
  current_status: CandidateStatus;
  experience: CandidateExperience;
  question: string | null;
  source: CandidateSource;
  sponsor_agent_id: string | null;
  contact_consent_at: string | null;
  contact_consent_proof: string | null;
  created_at: string;
}

export type CandidateRefusal = { ok: false; rule: 'R16' | 'R03' | 'R81' | null; code: string };

export interface CandidaturesOptions {
  now?: () => Date;
  newId?: () => string;
}

const toCandidate = (r: CandidateRow): Candidate => ({
  id: r.id,
  firstName: r.first_name,
  lastName: r.last_name,
  email: r.email,
  phone: r.phone,
  town: r.town,
  currentStatus: r.current_status,
  experience: r.experience,
  question: r.question,
  source: r.source,
  sponsorAgentId: r.sponsor_agent_id,
  contactable: r.contact_consent_at !== null,
  createdAt: r.created_at,
});

const text = (v: unknown, max: number): string | null | undefined => {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string') return undefined;
  const t = v.trim().replace(/\s+/g, ' ');
  if (t === '') return null;
  return t.length > max ? undefined : t;
};

const oneOf = <T extends string>(list: readonly T[], v: unknown): v is T => typeof v === 'string' && (list as readonly string[]).includes(v);

export class Candidatures {
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(
    private readonly db: SqlDatabase,
    private readonly journal: JournalStore,
    options: CandidaturesOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => crypto.randomUUID());
  }

  private async refuse(networkId: string, rule: CandidateRefusal['rule'], code: string): Promise<CandidateRefusal> {
    await appendEvent(this.journal, { type: 'candidature.refusee', actor: 'candidat', subject: `network:${networkId}`, data: { rule, code } }, this.now);
    return { ok: false, rule, code };
  }

  /**
   * Range la candidature déposée sur la page du réseau. La même réponse, que la candidature soit nouvelle ou déjà
   * rangée pour une de ses coordonnées : la page ne dit jamais si une personne a déjà candidaté [R18].
   */
  async apply(networkId: string, input: unknown): Promise<{ ok: true; value: { recorded: true } } | CandidateRefusal> {
    const network = await this.db.first<{ id: string }>('SELECT id FROM networks WHERE id = ?', [networkId]);
    if (!network) return { ok: false, rule: null, code: 'unknown_network' };
    if (input === null || typeof input !== 'object' || Array.isArray(input)) return this.refuse(networkId, null, 'bad_shape');
    const raw = input as Record<string, unknown>;
    // Aucun champ en dehors de la liste : pas de note, de score ni de rang possible [R81].
    if (Object.keys(raw).some((k) => !(CANDIDATE_FIELDS as readonly string[]).includes(k))) return this.refuse(networkId, 'R81', 'unknown_field');

    const firstName = text(raw.firstName, 60);
    if (!firstName) return this.refuse(networkId, null, 'bad_first_name');
    const lastName = text(raw.lastName, 60);
    if (lastName === undefined) return this.refuse(networkId, null, 'bad_last_name');
    const town = text(raw.town, 80);
    if (town === undefined) return this.refuse(networkId, null, 'bad_town');
    const question = text(raw.question, 1000);
    if (question === undefined) return this.refuse(networkId, null, 'bad_question');
    if (!oneOf(CANDIDATE_STATUSES, raw.currentStatus)) return this.refuse(networkId, null, 'bad_status');
    if (!oneOf(CANDIDATE_EXPERIENCES, raw.experience)) return this.refuse(networkId, null, 'bad_experience');
    if (!oneOf(CANDIDATE_SOURCES, raw.source)) return this.refuse(networkId, null, 'bad_source');

    let email: string | null = null;
    let phone: string | null = null;
    if (raw.email !== undefined && raw.email !== null && raw.email !== '') {
      email = typeof raw.email === 'string' && raw.email.length <= 254 ? normalizeEmail(raw.email) : null;
      if (email === null) return this.refuse(networkId, null, 'bad_email');
    }
    if (raw.phone !== undefined && raw.phone !== null && raw.phone !== '') {
      phone = typeof raw.phone === 'string' && raw.phone.length <= 30 ? normalizePhone(raw.phone) : null;
      if (phone === null) return this.refuse(networkId, null, 'bad_phone');
    }
    if (email === null && phone === null) return this.refuse(networkId, null, 'no_contact');

    // L'accord d'être recontacté au sujet de sa candidature : donné, avec sa preuve, ou pas donné du tout [R03].
    let consentProof: string | null = null;
    const consent = raw.contactConsent;
    if (consent !== undefined && consent !== null) {
      if (typeof consent !== 'object' || Array.isArray(consent)) return this.refuse(networkId, 'R03', 'bad_consent');
      const c = consent as Record<string, unknown>;
      if (Object.keys(c).some((k) => k !== 'given' && k !== 'proof') || typeof c.given !== 'boolean') return this.refuse(networkId, 'R03', 'bad_consent');
      if (c.given) {
        const proof = text(c.proof, 300);
        if (!proof) return this.refuse(networkId, 'R03', 'bad_proof');
        consentProof = proof;
      }
    }

    // Un parrain n'est gardé que s'il est un agent actif du réseau ; sinon il est ignoré, sans le dire.
    let sponsor: string | null = null;
    if (raw.sponsorAgentId !== undefined && raw.sponsorAgentId !== null) {
      if (typeof raw.sponsorAgentId !== 'string' || raw.sponsorAgentId.length > 64) return this.refuse(networkId, null, 'bad_sponsor');
      const agent = await this.db.first<{ id: string }>("SELECT id FROM agents WHERE id = ? AND network_id = ? AND status = 'active'", [raw.sponsorAgentId, networkId]);
      sponsor = agent?.id ?? null;
    }

    // Le lien marqué d'une vidéo ou d'un épisode (HX64) : un contenu actif du réseau, sinon ignoré sans le dire [R621].
    // Sa sorte devient la source : le code prouve d'où vient le candidat mieux que ce qu'il a coché.
    let content: { id: string; kind: CandidateSource } | null = null;
    if (raw.contentCode !== undefined && raw.contentCode !== null && raw.contentCode !== '') {
      if (typeof raw.contentCode !== 'string' || raw.contentCode.length > 40) return this.refuse(networkId, null, 'bad_content_code');
      content = await this.db.first<{ id: string; kind: CandidateSource }>(
        'SELECT r.id, r.kind FROM recruiting_contents r WHERE r.code = ? AND r.network_id = ? AND NOT EXISTS (SELECT 1 FROM recruiting_content_withdrawals w WHERE w.content_id = r.id)',
        [raw.contentCode, networkId],
      );
    }
    const source: CandidateSource = content ? content.kind : raw.source;

    const at = this.now().toISOString();
    const id = this.newId();
    // Les index uniques sur le mail et le téléphone font qu'une coordonnée ne range qu'une candidature, même en même temps [R18].
    const statements: SqlStatement[] = [
      {
        sql: `INSERT INTO candidates (id, network_id, first_name, last_name, email, phone, town, current_status, experience, question, source, sponsor_agent_id, contact_consent_at, contact_consent_proof, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
        params: [id, networkId, firstName, lastName, email, phone, town, raw.currentStatus, raw.experience, question, source, sponsor, consentProof ? at : null, consentProof, at],
      },
    ];
    // Dans le même lot : rattachée seulement si la candidature vient d'être rangée et le contenu toujours actif [R621].
    if (content) {
      statements.push({
        sql: `INSERT INTO candidate_content_origins (candidate_id, network_id, content_id, at)
              SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM candidates WHERE id = ? AND network_id = ?)
                AND NOT EXISTS (SELECT 1 FROM recruiting_content_withdrawals WHERE content_id = ?)`,
        params: [id, networkId, content.id, at, id, networkId, content.id],
      });
    }
    const [inserted, origin] = await runBatch(this.db, statements);
    const changes = inserted?.changes ?? 0;
    await appendEvent(
      this.journal,
      changes === 1
        ? {
            type: 'candidature.rangee',
            actor: 'candidat',
            subject: `candidate:${id}`,
            data: { source, contactable: consentProof !== null, ...(origin?.changes === 1 && content ? { contentId: content.id } : {}) },
          }
        : { type: 'candidature.deja_rangee', actor: 'candidat', subject: `network:${networkId}`, data: { rule: 'R18' } },
      this.now,
    );
    return { ok: true, value: { recorded: true } };
  }

  /** Les candidatures du réseau, pour la direction seulement, dans l'ordre d'arrivée et aucun autre [R81, R16]. */
  async list(viewer: Viewer): Promise<{ ok: true; value: Candidate[] } | CandidateRefusal> {
    if (viewer.role !== 'direction') {
      await appendEvent(
        this.journal,
        { type: 'acces.refuse', actor: `${String(viewer.role)}:${viewer.userId}`, subject: `network:${viewer.networkId}`, data: { rule: 'R16', role: String(viewer.role), kind: 'candidates', code: 'role' } },
        this.now,
      );
      return { ok: false, rule: 'R16', code: 'role' };
    }
    const rows = await this.db.all<CandidateRow>('SELECT * FROM candidates WHERE network_id = ? ORDER BY created_at, id', [viewer.networkId]);
    // La lecture est écrite au journal avant que la liste soit rendue [R16].
    await appendEvent(this.journal, { type: 'candidatures.lues', actor: `${String(viewer.role)}:${viewer.userId}`, subject: `network:${viewer.networkId}`, data: { rule: 'R16', count: rows.length } }, this.now);
    return { ok: true, value: rows.map(toCandidate) };
  }

  /** Une candidature peut-elle être recontactée ? Seulement avec l'accord rangé [R03]. */
  async contactable(networkId: string, candidateId: string): Promise<boolean> {
    const row = await this.db.first<{ contact_consent_at: string | null }>('SELECT contact_consent_at FROM candidates WHERE id = ? AND network_id = ?', [candidateId, networkId]);
    return row !== null && row.contact_consent_at !== null;
  }
}
