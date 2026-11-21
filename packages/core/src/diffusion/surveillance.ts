/**
 * La diffusion surveillée, portail par portail (HX38) [R470, R471, R472, R473, R474, R475].
 *
 * Comme Modelo et Neo : choix des portails bien par bien, contrôle des champs que chaque portail exige, tâche de
 * correction quand un portail rejette, retrait temporaire, vérification de la mise en ligne, classement des portails.
 * Jamais vu :
 * - l'appli relit chaque annonce en ligne et la compare à la dernière version publiée (P04) : prix, classes énergie et
 *   climat, chaque ligne des mentions ; tout écart est signalé à l'agent, avec ce qui diffère, et une annonce retirée
 *   encore en ligne aussi [R473] ;
 * - le vendeur n'a le lien d'une annonce que quand sa dernière relecture est conforme à la version publiée du moment ;
 *   un écart, ou une version plus récente pas encore relue, le lui retire [R474] ;
 * - le classement des portails se fait sur les contacts et les mandats réels, jamais sur une note donnée [R475].
 *
 * Décidé, lecture prudente :
 * - les portails sont ceux dont la réception reconnaît déjà les mails (`PORTAL_DOMAINS`) : un contact se rattache ainsi à
 *   son portail ; l'annonce en ligne est sur le domaine du portail, en https ;
 * - la publication (P04) et l'export (P07) ne changent pas : `portalListings` filtre le flux d'essai portail par portail ;
 * - les réponses des portails et les relectures arrivent par le planificateur (`networkId`, sans lecteur) ; le lecteur des
 *   annonces en ligne est derrière une interface, un faux dans les tests, les vrais avec H10 ;
 * - le lien va à l'espace du vendeur (`sellerLinks`), rien n'est envoyé ici ; le branchement à l'espace, les routes,
 *   l'écran et le planificateur sont des tâches de la voie 1 ;
 * - une même réponse reçue deux fois n'est rangée qu'une fois ; le texte d'un rejet n'entre jamais au journal ;
 * - un contact compte pour un portail quand la personne nous a écrit par un mail de ce portail sur la période ; un mandat,
 *   quand sa source est « portail » et que le premier mail de portail de la personne, avant la signature, vient de lui.
 */
import type { Acces } from '../acces/acces.ts';
import type { Viewer } from '../acces/droits.ts';
import { agentState } from '../acces/etat-agent.ts';
import { ExportPortails } from '../annonces/portails.ts';
import type { ListingPayload } from '../annonces/publication.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import { PORTAL_DOMAINS } from '../reception/adaptateurs.ts';

/** Les champs qu'un portail peut exiger, dans une liste fermée [R470]. */
export const PORTAL_FIELDS = ['titre', 'texte', 'prix', 'mentions', 'classe_energie'] as const;
export type PortalField = (typeof PORTAL_FIELDS)[number];

export const SUSPENSION_REASONS = ['travaux', 'photos_a_refaire', 'demande_vendeur', 'correction', 'autre'] as const;
export type SuspensionReason = (typeof SUSPENSION_REASONS)[number];

/** Les états d'une annonce que les portails montrent : comme l'export (P07). */
const ON_PORTALS = new Set(['en_vente', 'sous_offre']);

const CODE_OF_REJECTION = /^[a-z0-9][a-z0-9_.-]{0,59}$/;
const DETAIL_MAX = 300;
const DAY = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;

export interface PortalSetting {
  code: string;
  label: string;
  host: string;
  requiredFields: PortalField[];
  minPhotos: number;
  active: boolean;
}

export type PlanStatus = 'a_diffuser' | 'non_choisi' | 'suspendu' | 'champs_manquants' | 'pas_publiee' | 'hors_vente';
export type MissingField = PortalField | 'photos';

export interface PortalPlan {
  portal: string;
  status: PlanStatus;
  /** Les champs exigés que la version publiée n'a pas [R470]. */
  missing: MissingField[];
  until: string | null;
}

/** Ce que l'appli lit d'une annonce en ligne. */
export type OnlineListing =
  | { found: false }
  | { found: true; priceEur: number | null; energyClass: string | null; climateClass: string | null; text: string };

/** Le lecteur d'une annonce en ligne, derrière une interface [R473]. Il lève une erreur quand la page est illisible. */
export interface OnlineListingReader {
  read(portal: string, url: string): Promise<OnlineListing>;
}

export type Gap =
  | { field: 'prix'; published: number | null; online: number | null }
  | { field: 'classe_energie' | 'classe_climat'; published: string | null; online: string | null }
  | { field: 'mention'; line: number }
  | { field: 'absente' }
  | { field: 'retrait' }
  | { field: 'illisible' };

export type CheckOutcome = 'conforme' | 'retiree_absente' | 'ecart' | 'introuvable' | 'illisible' | 'toujours_en_ligne';

export interface OpenTask {
  taskId: string;
  propertyId: string;
  portal: string;
  kind: 'rejet' | 'ecart';
  createdAt: string;
  /** Pour un rejet : le code et le texte du dernier rejet ; pour un écart : ce qui diffère à la dernière relecture. */
  rejection: { code: string; detail: string | null; seq: number } | null;
  gaps: Gap[];
}

export interface SellerLink {
  portal: string;
  label: string;
  url: string;
  verifiedAt: string;
  seq: number;
}

export interface PortalRank {
  rank: number;
  portal: string;
  label: string;
  contacts: number;
  mandates: number;
}

type Refusal = { ok: false; rule: 'R16'; code: string };
type Problem = { ok: false; rule: 'R470' | 'R471' | 'R472' | 'R473' | 'R475' | null; code: string };

/** Une condition relue dans l'instruction même qui écrit : rien ne passe entre la lecture et l'écriture. */
interface Guard {
  sql: string;
  params: (string | number)[];
}

interface VersionRow {
  id: string;
  seq: number;
  state: string;
  payload: string;
}

/** Une annonce relue : espaces fines et insécables ramenées à une espace, blancs réunis [R473]. */
export function plainText(text: string): string {
  return text.normalize('NFC').replace(/[\s   ]+/gu, ' ').trim();
}

/** Les classes énergie et climat lues dans les mentions calculées par le code (P02). */
export function classesOf(mentions: string | null): { energy: string | null; climate: string | null } {
  const m = mentions?.match(/Classe énergie ([A-G]), classe climat ([A-G])\./u);
  return { energy: m?.[1] ?? null, climate: m?.[2] ?? null };
}

/** Les champs exigés qui manquent à une version publiée [R470]. */
export function missingFields(payload: Omit<ListingPayload, 'version'>, setting: Pick<PortalSetting, 'requiredFields' | 'minPhotos'>): MissingField[] {
  const missing: MissingField[] = [];
  const has: Record<PortalField, boolean> = {
    titre: !!payload.title?.trim(),
    texte: !!payload.body?.trim(),
    prix: typeof payload.priceEur === 'number' && payload.priceEur > 0,
    mentions: !!payload.mentions?.trim(),
    classe_energie: classesOf(payload.mentions).energy !== null,
  };
  for (const f of PORTAL_FIELDS) if (setting.requiredFields.includes(f) && !has[f]) missing.push(f);
  if (payload.media.filter((m) => m.kind === 'photo').length < setting.minPhotos) missing.push('photos');
  return missing;
}

/** L'annonce en ligne comparée à la version publiée : ce qui diffère, dans l'ordre de la version [R473]. */
export function compareOnline(payload: Omit<ListingPayload, 'version'>, online: Extract<OnlineListing, { found: true }>): Gap[] {
  const gaps: Gap[] = [];
  if (online.priceEur !== payload.priceEur) gaps.push({ field: 'prix', published: payload.priceEur, online: online.priceEur });
  const c = classesOf(payload.mentions);
  if (c.energy !== null && online.energyClass !== c.energy) gaps.push({ field: 'classe_energie', published: c.energy, online: online.energyClass });
  if (c.climate !== null && online.climateClass !== c.climate) gaps.push({ field: 'classe_climat', published: c.climate, online: online.climateClass });
  const text = plainText(online.text);
  (payload.mentions ?? '').split('\n').forEach((line, i) => {
    const want = plainText(line);
    if (want && !text.includes(want)) gaps.push({ field: 'mention', line: i + 1 });
  });
  return gaps;
}

/** Le domaine d'un portail connu de la réception, par son code. */
const domainOf = (code: string): string | null => Object.entries(PORTAL_DOMAINS).find(([, c]) => c === code)?.[0] ?? null;

const onDomain = (host: string, domain: string): boolean => host === domain || host.endsWith(`.${domain}`);

export class DiffusionSurveillee {
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly exportPortails: ExportPortails;

  constructor(
    private readonly db: SqlDatabase,
    private readonly acces: Acces,
    private readonly journal: JournalStore,
    options: { now?: () => Date; newId?: () => string } = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => crypto.randomUUID());
    this.exportPortails = new ExportPortails(db);
  }

  private actor(viewer: Viewer): string {
    return `${String(viewer.role)}:${viewer.userId}`;
  }

  private async refuse(viewer: Viewer, subject: string | null, code: string): Promise<Refusal> {
    await appendEvent(this.journal, { type: 'acces.refuse', actor: this.actor(viewer), subject, data: { rule: 'R16', role: String(viewer.role), kind: 'diffusion', code } }, this.now);
    return { ok: false, rule: 'R16', code };
  }

  /** L'agent du bien en activité, ou la direction du réseau du bien. */
  private async owner(viewer: Viewer, propertyId: unknown): Promise<Refusal | { ok: true; propertyId: string }> {
    if (viewer.role !== 'agent' && viewer.role !== 'direction') return this.refuse(viewer, null, 'role');
    if (typeof propertyId !== 'string' || !propertyId) return this.refuse(viewer, null, 'unknown');
    const subject = `property:${propertyId}`;
    if (viewer.role === 'agent' && (await agentState(this.db, viewer.networkId, viewer.userId, this.now())) !== 'actif') return this.refuse(viewer, subject, 'agent_inactive');
    const read = await this.acces.readProperty(viewer, propertyId);
    if (!read.ok) return { ok: false, rule: 'R16', code: read.code };
    if (read.value.network_id !== viewer.networkId) return this.refuse(viewer, subject, 'network');
    if (viewer.role === 'agent' && (read.view !== 'full' || read.value.agent_id !== viewer.userId)) return this.refuse(viewer, subject, 'pas_son_bien');
    return { ok: true, propertyId };
  }

  // ------------------------------------------------------------------ Réglages

  /** Régler un portail : la direction seule ; un portail que la réception reconnaît, sur son domaine [R470]. */
  async setPortal(viewer: Viewer, input: { code: unknown; label: unknown; host: unknown; requiredFields: unknown; minPhotos: unknown; active?: unknown }): Promise<{ ok: true } | Refusal | Problem> {
    if (viewer.role !== 'direction') return this.refuse(viewer, null, 'not_direction');
    const domain = typeof input.code === 'string' ? domainOf(input.code) : null;
    if (!domain) return { ok: false, rule: 'R470', code: 'portail_inconnu' };
    if (typeof input.label !== 'string' || !/^[^<>]{1,60}$/u.test(input.label.trim())) return { ok: false, rule: 'R470', code: 'bad_label' };
    if (typeof input.host !== 'string' || !/^[a-z0-9.-]{3,100}$/.test(input.host) || !onDomain(input.host, domain)) return { ok: false, rule: 'R470', code: 'hors_du_portail' };
    const fields = input.requiredFields;
    if (!Array.isArray(fields) || fields.some((f) => !(PORTAL_FIELDS as readonly unknown[]).includes(f)) || new Set(fields).size !== fields.length) return { ok: false, rule: 'R470', code: 'bad_fields' };
    if (typeof input.minPhotos !== 'number' || !Number.isInteger(input.minPhotos) || input.minPhotos < 0 || input.minPhotos > 50) return { ok: false, rule: 'R470', code: 'bad_min_photos' };
    const active = input.active === undefined ? true : input.active;
    if (typeof active !== 'boolean') return { ok: false, rule: 'R470', code: 'bad_active' };
    const ordered = PORTAL_FIELDS.filter((f) => (fields as unknown[]).includes(f));
    await this.db.run(
      `INSERT INTO diffusion_portal_settings (id, network_id, code, label, host, required_fields, min_photos, active, set_by, set_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [this.newId(), viewer.networkId, input.code as string, input.label.trim(), input.host, JSON.stringify(ordered), input.minPhotos, active ? 1 : 0, this.actor(viewer), this.now().toISOString()],
    );
    await appendEvent(this.journal, { type: 'diffusion.portail_regle', actor: this.actor(viewer), subject: `network:${viewer.networkId}`, data: { rule: 'R470', portal: input.code as string, fields: ordered, minPhotos: input.minPhotos, active } }, this.now);
    return { ok: true };
  }

  /** Les portails réglés du réseau, le dernier réglage de chacun. */
  async portals(networkId: string): Promise<PortalSetting[]> {
    const rows = await this.db.all<{ code: string; label: string; host: string; required_fields: string; min_photos: number; active: number }>(
      `SELECT s.code, s.label, s.host, s.required_fields, s.min_photos, s.active FROM diffusion_portal_settings s
       WHERE s.network_id = ? AND s.rowid = (SELECT t.rowid FROM diffusion_portal_settings t WHERE t.network_id = s.network_id AND t.code = s.code ORDER BY t.set_at DESC, t.rowid DESC LIMIT 1)
       ORDER BY s.code`,
      [networkId],
    );
    return rows.map((r) => ({ code: r.code, label: r.label, host: r.host, requiredFields: JSON.parse(r.required_fields) as PortalField[], minPhotos: Number(r.min_photos), active: Number(r.active) === 1 }));
  }

  private async portal(networkId: string, code: unknown): Promise<PortalSetting | null> {
    if (typeof code !== 'string') return null;
    return (await this.portals(networkId)).find((p) => p.code === code) ?? null;
  }

  // ------------------------------------------------------------------ Choix et retraits

  /** Choisir ou écarter un portail pour un bien [R470]. Écarté, ses tâches ouvertes se ferment [R471]. */
  async choose(viewer: Viewer, propertyIdInput: unknown, portalInput: unknown, chosen: unknown): Promise<{ ok: true } | Refusal | Problem> {
    const o = await this.owner(viewer, propertyIdInput);
    if (!o.ok) return o;
    const portal = await this.portal(viewer.networkId, portalInput);
    if (!portal) return { ok: false, rule: 'R470', code: 'portail_inconnu' };
    if (typeof chosen !== 'boolean') return { ok: false, rule: 'R470', code: 'bad_choice' };
    const at = this.now().toISOString();
    await this.db.run(
      'INSERT INTO diffusion_portal_choices (id, network_id, property_id, portal, chosen, by_actor, at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [this.newId(), viewer.networkId, o.propertyId, portal.code, chosen ? 1 : 0, this.actor(viewer), at],
    );
    if (!chosen) {
      for (const t of await this.openTaskRows(o.propertyId, portal.code)) await this.close(t.id, 'portail_abandonne', null);
    }
    await appendEvent(this.journal, { type: chosen ? 'diffusion.portail_choisi' : 'diffusion.portail_ecarte', actor: this.actor(viewer), subject: `property:${o.propertyId}`, data: { rule: 'R470', portal: portal.code } }, this.now);
    return { ok: true };
  }

  /** Retirer un bien d'un portail pour un temps, jusqu'à une date ou jusqu'à la reprise [R472]. */
  async suspend(viewer: Viewer, input: { propertyId: unknown; portal: unknown; reason: unknown; until?: unknown }): Promise<{ ok: true; suspensionId: string } | Refusal | Problem> {
    const o = await this.owner(viewer, input.propertyId);
    if (!o.ok) return o;
    const portal = await this.portal(viewer.networkId, input.portal);
    if (!portal) return { ok: false, rule: 'R472', code: 'portail_inconnu' };
    if (typeof input.reason !== 'string' || !(SUSPENSION_REASONS as readonly string[]).includes(input.reason)) return { ok: false, rule: 'R472', code: 'bad_reason' };
    const at = this.now().toISOString();
    let until: string | null = null;
    if (input.until !== undefined && input.until !== null) {
      if (typeof input.until !== 'string' || !DAY.test(input.until) || Number.isNaN(Date.parse(input.until))) return { ok: false, rule: 'R472', code: 'bad_until' };
      until = new Date(input.until).toISOString();
      if (until <= at) return { ok: false, rule: 'R472', code: 'until_passe' };
    }
    const id = this.newId();
    // Vérifié et écrit en une seule instruction, et gardé par la base : deux retraits en même temps n'en font qu'un [R472].
    let changes = 0;
    try {
      ({ changes } = await this.db.run(
        `INSERT INTO diffusion_portal_suspensions (id, network_id, property_id, portal, reason, until_at, by_actor, at)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?
          WHERE NOT EXISTS (
            SELECT 1 FROM diffusion_portal_suspensions s WHERE s.property_id = ? AND s.portal = ? AND (s.until_at IS NULL OR s.until_at > ?)
              AND NOT EXISTS (SELECT 1 FROM diffusion_portal_resumptions r WHERE r.suspension_id = s.id))`,
        [id, viewer.networkId, o.propertyId, portal.code, input.reason, until, this.actor(viewer), at, o.propertyId, portal.code, at],
      ));
    } catch (e) {
      if (!/déjà en cours/.test(String((e as Error)?.message ?? e))) throw e;
      changes = 0;
    }
    if (changes !== 1) return { ok: false, rule: 'R472', code: 'deja_retire' };
    await appendEvent(this.journal, { type: 'diffusion.retrait_temporaire', actor: this.actor(viewer), subject: `property:${o.propertyId}`, data: { rule: 'R472', portal: portal.code, reason: input.reason, until } }, this.now);
    return { ok: true, suspensionId: id };
  }

  /** Remettre le bien sur le portail avant la date prévue [R472]. */
  async resume(viewer: Viewer, suspensionIdInput: unknown): Promise<{ ok: true } | Refusal | Problem> {
    if (typeof suspensionIdInput !== 'string') return { ok: false, rule: 'R472', code: 'unknown' };
    const s = await this.db.first<{ property_id: string; portal: string; network_id: string }>('SELECT property_id, portal, network_id FROM diffusion_portal_suspensions WHERE id = ?', [suspensionIdInput]);
    if (!s || s.network_id !== viewer.networkId) return { ok: false, rule: 'R472', code: 'unknown' };
    const o = await this.owner(viewer, s.property_id);
    if (!o.ok) return o;
    const active = await this.activeSuspension(s.property_id, s.portal, this.now());
    if (active?.id !== suspensionIdInput) return { ok: false, rule: 'R472', code: 'deja_repris' };
    const { changes } = await this.db.run(
      'INSERT INTO diffusion_portal_resumptions (suspension_id, by_actor, at) SELECT ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM diffusion_portal_resumptions WHERE suspension_id = ?)',
      [suspensionIdInput, this.actor(viewer), this.now().toISOString(), suspensionIdInput],
    );
    if (changes !== 1) return { ok: false, rule: 'R472', code: 'deja_repris' };
    await appendEvent(this.journal, { type: 'diffusion.reprise', actor: this.actor(viewer), subject: `property:${s.property_id}`, data: { rule: 'R472', portal: s.portal } }, this.now);
    return { ok: true };
  }

  private async activeSuspension(propertyId: string, portal: string, at: Date): Promise<{ id: string; until_at: string | null } | null> {
    const iso = at.toISOString();
    return (
      (await this.db.first<{ id: string; until_at: string | null }>(
        `SELECT s.id, s.until_at FROM diffusion_portal_suspensions s
         WHERE s.property_id = ? AND s.portal = ? AND s.at <= ? AND (s.until_at IS NULL OR s.until_at > ?)
           AND NOT EXISTS (SELECT 1 FROM diffusion_portal_resumptions r WHERE r.suspension_id = s.id)
         ORDER BY s.at DESC, s.rowid DESC LIMIT 1`,
        [propertyId, portal, iso, iso],
      )) ?? null
    );
  }

  private async isChosen(propertyId: string, portal: string): Promise<boolean> {
    const r = await this.db.first<{ chosen: number }>('SELECT chosen FROM diffusion_portal_choices WHERE property_id = ? AND portal = ? ORDER BY at DESC, rowid DESC LIMIT 1', [propertyId, portal]);
    return Number(r?.chosen ?? 0) === 1;
  }

  private async latestVersion(networkId: string, propertyId: string): Promise<VersionRow | null> {
    return (await this.db.first<VersionRow>('SELECT id, seq, state, payload FROM listing_versions WHERE network_id = ? AND property_id = ? ORDER BY seq DESC LIMIT 1', [networkId, propertyId])) ?? null;
  }

  // ------------------------------------------------------------------ Plan et flux

  /** Pour chaque portail actif : le bien y va-t-il, et sinon pourquoi [R470, R472]. */
  async plan(networkId: string, propertyId: string): Promise<PortalPlan[]> {
    const version = await this.latestVersion(networkId, propertyId);
    const payload = version ? (JSON.parse(version.payload) as Omit<ListingPayload, 'version'>) : null;
    const out: PortalPlan[] = [];
    for (const p of (await this.portals(networkId)).filter((x) => x.active)) {
      const base = { portal: p.code, missing: [] as MissingField[], until: null as string | null };
      if (!(await this.isChosen(propertyId, p.code))) {
        out.push({ ...base, status: 'non_choisi' });
        continue;
      }
      const s = await this.activeSuspension(propertyId, p.code, this.now());
      if (s) {
        out.push({ ...base, status: 'suspendu', until: s.until_at });
        continue;
      }
      if (!version || !payload) {
        out.push({ ...base, status: 'pas_publiee' });
        continue;
      }
      if (!ON_PORTALS.has(version.state)) {
        out.push({ ...base, status: 'hors_vente' });
        continue;
      }
      const missing = missingFields(payload, p);
      out.push({ ...base, status: missing.length ? 'champs_manquants' : 'a_diffuser', missing });
    }
    return out;
  }

  /** Le flux d'un portail : seulement les biens qui l'ont choisi, sans retrait en cours, aux champs exigés remplis [R470]. */
  async portalListings(networkId: string, portalCode: string): Promise<ListingPayload[]> {
    const portal = await this.portal(networkId, portalCode);
    if (!portal?.active) return [];
    const ids = await this.db.all<{ property_id: string }>('SELECT DISTINCT property_id FROM diffusion_portal_choices WHERE network_id = ? AND portal = ?', [networkId, portal.code]);
    const allowed = new Set<string>();
    for (const { property_id } of ids) {
      const plan = (await this.plan(networkId, property_id)).find((x) => x.portal === portal.code);
      if (plan?.status === 'a_diffuser') allowed.add(property_id);
    }
    const references = new Map<string, string>();
    for (const id of allowed) {
      const r = await this.db.first<{ reference: string }>('SELECT reference FROM properties WHERE id = ?', [id]);
      if (r) references.set(r.reference, id);
    }
    return (await this.exportPortails.listings(networkId)).filter((l) => references.has(l.reference));
  }

  // ------------------------------------------------------------------ Réponses des portails

  /**
   * Ranger la réponse d'un portail à une version publiée [R471, R473]. Un rejet ouvre une seule tâche de correction par
   * bien et portail ; une acceptation d'une version au moins aussi récente que le dernier rejet la ferme.
   */
  async recordFeedback(
    networkId: string,
    input: { portal: unknown; propertyId: unknown; seq: unknown; outcome: unknown; code?: unknown; detail?: unknown; onlineUrl?: unknown },
  ): Promise<{ ok: true; stored: boolean; taskId: string | null } | Problem> {
    const portal = await this.portal(networkId, input.portal);
    if (!portal) return { ok: false, rule: 'R471', code: 'portail_inconnu' };
    if (typeof input.propertyId !== 'string' || typeof input.seq !== 'number' || !Number.isInteger(input.seq)) return { ok: false, rule: 'R471', code: 'version_inconnue' };
    const v = await this.db.first<{ id: string; seq: number }>('SELECT id, seq FROM listing_versions WHERE network_id = ? AND property_id = ? AND seq = ?', [networkId, input.propertyId, input.seq]);
    if (!v) return { ok: false, rule: 'R471', code: 'version_inconnue' };
    const propertyId = input.propertyId;
    const at = this.now().toISOString();
    if (input.outcome === 'rejet') {
      if (typeof input.code !== 'string' || !CODE_OF_REJECTION.test(input.code)) return { ok: false, rule: 'R471', code: 'bad_code' };
      let detail: string | null = null;
      if (input.detail !== undefined && input.detail !== null) {
        if (typeof input.detail !== 'string') return { ok: false, rule: 'R471', code: 'bad_detail' };
        detail = input.detail.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, DETAIL_MAX) || null;
      }
      const id = this.newId();
      const { changes } = await this.db.run(
        `INSERT INTO diffusion_portal_feedback (id, network_id, property_id, portal, version_id, outcome, code, detail, online_url, at)
         SELECT ?, ?, ?, ?, ?, 'rejet', ?, ?, NULL, ?
          WHERE NOT EXISTS (SELECT 1 FROM diffusion_portal_feedback WHERE version_id = ? AND portal = ? AND outcome = 'rejet' AND code = ?)`,
        [id, networkId, propertyId, portal.code, v.id, input.code, detail, at, v.id, portal.code, input.code],
      );
      // Un rejet déjà rangé, ou d'une version plus ancienne qu'une version déjà acceptée, n'ouvre rien. Le contrôle de
      // l'acceptation est fait dans l'instruction même qui ouvre la tâche : une acceptation rangée entre-temps l'empêche,
      // une acceptation rangée après la trouve ouverte et la ferme [R471].
      const newerAccepted = {
        sql: `NOT EXISTS (SELECT 1 FROM diffusion_portal_feedback f JOIN listing_versions lv ON lv.id = f.version_id
               WHERE f.property_id = ? AND f.portal = ? AND f.outcome = 'acceptee' AND lv.seq > ?)`,
        params: [propertyId, portal.code, Number(v.seq)],
      };
      const opened = changes === 1 ? await this.openTask(networkId, propertyId, portal.code, 'rejet', id, newerAccepted) : null;
      const taskId = opened ?? (await this.openTaskRows(propertyId, portal.code)).find((t) => t.kind === 'rejet')?.id ?? null;
      if (changes === 1) await appendEvent(this.journal, { type: 'diffusion.rejet', actor: 'system:diffusion', subject: `property:${propertyId}`, data: { rule: 'R471', portal: portal.code, seq: Number(v.seq), code: input.code, task: taskId } }, this.now);
      return { ok: true, stored: changes === 1, taskId };
    }
    if (input.outcome === 'acceptee') {
      if (typeof input.onlineUrl !== 'string') return { ok: false, rule: 'R473', code: 'sans_lien' };
      let url: URL;
      try {
        url = new URL(input.onlineUrl);
      } catch {
        return { ok: false, rule: 'R473', code: 'bad_url' };
      }
      const domain = domainOf(portal.code);
      if (url.protocol !== 'https:' || url.username || url.password || url.port || !domain || !onDomain(url.hostname, domain) || url.href.length > 500) return { ok: false, rule: 'R473', code: 'hors_du_portail' };
      const id = this.newId();
      const { changes } = await this.db.run(
        `INSERT INTO diffusion_portal_feedback (id, network_id, property_id, portal, version_id, outcome, code, detail, online_url, at)
         SELECT ?, ?, ?, ?, ?, 'acceptee', NULL, NULL, ?, ?
          WHERE NOT EXISTS (SELECT 1 FROM diffusion_portal_feedback WHERE version_id = ? AND portal = ? AND outcome = 'acceptee')`,
        [id, networkId, propertyId, portal.code, v.id, url.href, at, v.id, portal.code],
      );
      // Fermée seulement si aucun rejet d'une version plus récente n'est rangé, contrôlé dans l'instruction même [R471].
      const noNewerRejection = {
        sql: `NOT EXISTS (SELECT 1 FROM diffusion_portal_feedback f JOIN listing_versions lv ON lv.id = f.version_id
               WHERE f.property_id = ? AND f.portal = ? AND f.outcome = 'rejet' AND lv.seq > ?)`,
        params: [propertyId, portal.code, Number(v.seq)],
      };
      for (const t of (await this.openTaskRows(propertyId, portal.code)).filter((x) => x.kind === 'rejet')) await this.close(t.id, 'acceptee', id, noNewerRejection);
      if (changes === 1) await appendEvent(this.journal, { type: 'diffusion.acceptee', actor: 'system:diffusion', subject: `property:${propertyId}`, data: { rule: 'R473', portal: portal.code, seq: Number(v.seq) } }, this.now);
      return { ok: true, stored: changes === 1, taskId: null };
    }
    return { ok: false, rule: 'R471', code: 'bad_outcome' };
  }

  private async openTaskRows(propertyId: string, portal: string): Promise<{ id: string; kind: 'rejet' | 'ecart' }[]> {
    return this.db.all<{ id: string; kind: 'rejet' | 'ecart' }>(
      `SELECT t.id, t.kind FROM diffusion_portal_tasks t WHERE t.property_id = ? AND t.portal = ?
        AND NOT EXISTS (SELECT 1 FROM diffusion_portal_task_closures c WHERE c.task_id = t.id) ORDER BY t.created_at, t.rowid`,
      [propertyId, portal],
    );
  }

  /** Une seule tâche ouverte par bien, portail et sorte ; rend celle qui l'est [R471]. */
  /**
   * Une seule tâche ouverte par bien, portail et sorte ; rend celle qui l'est [R471]. Avec `guard`, la tâche ne s'ouvre
   * que si la condition tient au moment même de l'écriture ; sinon rien, et `null`.
   */
  private async openTask(networkId: string, propertyId: string, portal: string, kind: 'rejet' | 'ecart', ref: string, guard?: Guard): Promise<string | null> {
    const existing = (await this.openTaskRows(propertyId, portal)).find((t) => t.kind === kind);
    if (existing) return existing.id;
    const id = this.newId();
    try {
      const { changes } = await this.db.run(
        `INSERT INTO diffusion_portal_tasks (id, network_id, property_id, portal, kind, agent_id, first_ref, created_at)
         SELECT ?, ?, ?, ?, ?, (SELECT agent_id FROM properties WHERE id = ?), ?, ? WHERE ${guard?.sql ?? '1'}`,
        [id, networkId, propertyId, portal, kind, propertyId, ref, this.now().toISOString(), ...(guard?.params ?? [])],
      );
      if (changes !== 1) return null;
    } catch (e) {
      // Une autre réponse, arrivée en même temps, a ouvert la tâche : la base l'a gardée seule.
      const again = (await this.openTaskRows(propertyId, portal)).find((t) => t.kind === kind);
      if (again) return again.id;
      throw e;
    }
    await appendEvent(this.journal, { type: 'diffusion.tache_ouverte', actor: 'system:diffusion', subject: `property:${propertyId}`, data: { rule: 'R471', portal, kind, task: id } }, this.now);
    return id;
  }

  private async close(taskId: string, reason: 'acceptee' | 'conforme' | 'portail_abandonne', ref: string | null, guard?: Guard): Promise<void> {
    const { changes } = await this.db.run(
      `INSERT INTO diffusion_portal_task_closures (task_id, reason, ref, at) SELECT ?, ?, ?, ?
        WHERE NOT EXISTS (SELECT 1 FROM diffusion_portal_task_closures WHERE task_id = ?) AND ${guard?.sql ?? '1'}`,
      [taskId, reason, ref, this.now().toISOString(), taskId, ...(guard?.params ?? [])],
    );
    if (changes === 1) await appendEvent(this.journal, { type: 'diffusion.tache_fermee', actor: 'system:diffusion', subject: `task:${taskId}`, data: { rule: 'R471', reason } }, this.now);
  }

  // ------------------------------------------------------------------ Relecture en ligne

  /**
   * Relire l'annonce en ligne d'un bien sur un portail et la comparer à la dernière version publiée [R473]. Un écart, une
   * annonce absente quand elle devrait y être, ou encore là quand elle ne devrait plus, ouvre une tâche ; une relecture
   * conforme la ferme. Une page illisible est rangée, sans tâche : la relecture suivante dira.
   */
  async verify(networkId: string, propertyId: string, portalCode: string, reader: OnlineListingReader): Promise<{ ok: true; outcome: CheckOutcome; gaps: Gap[] } | Problem> {
    const portal = await this.portal(networkId, portalCode);
    if (!portal) return { ok: false, rule: 'R473', code: 'portail_inconnu' };
    const acceptance = await this.db.first<{ id: string; online_url: string }>(
      // L'acceptation de la version la plus récente, même arrivée avant celle d'une version plus ancienne [R473].
      `SELECT f.id, f.online_url FROM diffusion_portal_feedback f JOIN listing_versions lv ON lv.id = f.version_id
        WHERE f.property_id = ? AND f.portal = ? AND f.network_id = ? AND f.outcome = 'acceptee' ORDER BY lv.seq DESC, f.at DESC, f.rowid DESC LIMIT 1`,
      [propertyId, portal.code, networkId],
    );
    if (!acceptance) return { ok: false, rule: 'R473', code: 'pas_en_ligne' };
    const version = await this.latestVersion(networkId, propertyId);
    if (!version) return { ok: false, rule: 'R473', code: 'pas_publiee' };
    const payload = JSON.parse(version.payload) as Omit<ListingPayload, 'version'>;
    // L'état de diffusion sur lequel la relecture se fonde : réglage du portail, choix, retraits et reprises, relevés
    // avant la lecture. Un changement rangé pendant la lecture rend le résultat périmé [R473].
    const state = await this.db.first<{ settings: number; choices: number; suspensions: number; resumptions: number }>(
      `SELECT
         (SELECT COALESCE(MAX(rowid), 0) FROM diffusion_portal_settings WHERE network_id = ? AND code = ?) AS settings,
         (SELECT COALESCE(MAX(rowid), 0) FROM diffusion_portal_choices WHERE property_id = ? AND portal = ?) AS choices,
         (SELECT COALESCE(MAX(rowid), 0) FROM diffusion_portal_suspensions WHERE property_id = ? AND portal = ?) AS suspensions,
         (SELECT COALESCE(MAX(r.rowid), 0) FROM diffusion_portal_resumptions r JOIN diffusion_portal_suspensions s ON s.id = r.suspension_id WHERE s.property_id = ? AND s.portal = ?) AS resumptions`,
      [networkId, portal.code, propertyId, portal.code, propertyId, portal.code, propertyId, portal.code],
    );
    const expected = (await this.plan(networkId, propertyId)).find((p) => p.portal === portal.code)?.status === 'a_diffuser';
    let outcome: CheckOutcome;
    let gaps: Gap[];
    try {
      const online = await reader.read(portal.code, acceptance.online_url);
      if (!expected) {
        // Absente comme il se doit : ce n'est pas une annonce vérifiée, le vendeur n'en a pas le lien [R474].
        outcome = online.found ? 'toujours_en_ligne' : 'retiree_absente';
        gaps = online.found ? [{ field: 'retrait' }] : [];
      } else if (!online.found) {
        outcome = 'introuvable';
        gaps = [{ field: 'absente' }];
      } else {
        gaps = compareOnline(payload, online);
        outcome = gaps.length ? 'ecart' : 'conforme';
      }
    } catch {
      outcome = 'illisible';
      gaps = [];
    }
    const id = this.newId();
    await this.db.run(
      'INSERT INTO diffusion_portal_checks (id, network_id, property_id, portal, version_id, acceptance_id, outcome, gaps, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [id, networkId, propertyId, portal.code, version.id, acceptance.id, outcome, JSON.stringify(outcome === 'illisible' ? [{ field: 'illisible' }] : gaps), this.now().toISOString()],
    );
    await appendEvent(this.journal, { type: 'diffusion.relecture', actor: 'system:diffusion', subject: `property:${propertyId}`, data: { rule: 'R473', portal: portal.code, seq: Number(version.seq), outcome, gaps: gaps.map((g) => g.field) } }, this.now);
    // La relecture n'ouvre ni ne ferme rien si, au moment de l'écrire, une version plus récente est publiée, une
    // relecture plus récente est rangée, ou l'état de diffusion relevé avant la lecture a changé : un résultat périmé ne
    // décide pas [R473].
    const current: Guard = {
      sql: `NOT EXISTS (SELECT 1 FROM listing_versions w WHERE w.property_id = ? AND w.seq > ?)
        AND NOT EXISTS (SELECT 1 FROM diffusion_portal_checks k WHERE k.property_id = ? AND k.portal = ? AND k.rowid > (SELECT c.rowid FROM diffusion_portal_checks c WHERE c.id = ?))
        AND NOT EXISTS (SELECT 1 FROM diffusion_portal_settings x WHERE x.network_id = ? AND x.code = ? AND x.rowid > ?)
        AND NOT EXISTS (SELECT 1 FROM diffusion_portal_choices x WHERE x.property_id = ? AND x.portal = ? AND x.rowid > ?)
        AND NOT EXISTS (SELECT 1 FROM diffusion_portal_suspensions x WHERE x.property_id = ? AND x.portal = ? AND x.rowid > ?)
        AND NOT EXISTS (SELECT 1 FROM diffusion_portal_resumptions r JOIN diffusion_portal_suspensions x ON x.id = r.suspension_id WHERE x.property_id = ? AND x.portal = ? AND r.rowid > ?)`,
      params: [
        propertyId, Number(version.seq), propertyId, portal.code, id,
        networkId, portal.code, Number(state?.settings ?? 0),
        propertyId, portal.code, Number(state?.choices ?? 0),
        propertyId, portal.code, Number(state?.suspensions ?? 0),
        propertyId, portal.code, Number(state?.resumptions ?? 0),
      ],
    };
    if (outcome === 'ecart' || outcome === 'introuvable' || outcome === 'toujours_en_ligne') await this.openTask(networkId, propertyId, portal.code, 'ecart', id, current);
    if (outcome === 'conforme' || outcome === 'retiree_absente') for (const t of (await this.openTaskRows(propertyId, portal.code)).filter((x) => x.kind === 'ecart')) await this.close(t.id, 'conforme', id, current);
    return { ok: true, outcome, gaps };
  }

  /**
   * AU068 · La relecture de toutes les annonces acceptées d'un réseau, portail par portail, par le lecteur réel : une
   * baisse de prix pas encore en ligne, ou une annonce retirée encore visible, ouvre une tâche datée [R473]. Une page
   * en panne n'arrête pas les autres. Rend le décompte, sans donnée.
   */
  async verifyAll(networkId: string, reader: OnlineListingReader): Promise<{ checked: number; outcomes: Partial<Record<CheckOutcome, number>>; failed: number }> {
    const rows = await this.db.all<{ property_id: string; portal: string }>(
      `SELECT DISTINCT f.property_id, f.portal FROM diffusion_portal_feedback f JOIN properties p ON p.id = f.property_id
        WHERE f.network_id = ? AND p.network_id = ? AND f.outcome = 'acceptee' ORDER BY f.property_id, f.portal`,
      [networkId, networkId],
    );
    const outcomes: Partial<Record<CheckOutcome, number>> = {};
    let checked = 0;
    let failed = 0;
    for (const r of rows) {
      try {
        const v = await this.verify(networkId, r.property_id, r.portal, reader);
        if (!v.ok) continue;
        checked++;
        outcomes[v.outcome] = (outcomes[v.outcome] ?? 0) + 1;
      } catch {
        failed++;
        await appendEvent(this.journal, { type: 'diffusion.relecture_echec', actor: 'system:diffusion', subject: `property:${r.property_id}`, data: { rule: 'R473', portal: r.portal } }, this.now);
      }
    }
    return { checked, outcomes, failed };
  }

  // ------------------------------------------------------------------ Lectures

  /** Les tâches de correction ouvertes : l'agent, celles de ses biens ; la direction, toutes [R471]. */
  async tasks(viewer: Viewer): Promise<{ ok: true; tasks: OpenTask[] } | Refusal> {
    if (viewer.role !== 'agent' && viewer.role !== 'direction') return this.refuse(viewer, null, 'role');
    const rows = await this.db.all<{ id: string; property_id: string; portal: string; kind: 'rejet' | 'ecart'; created_at: string }>(
      `SELECT t.id, t.property_id, t.portal, t.kind, t.created_at FROM diffusion_portal_tasks t JOIN properties p ON p.id = t.property_id
        WHERE t.network_id = ? AND (? = 'direction' OR p.agent_id = ?)
          AND NOT EXISTS (SELECT 1 FROM diffusion_portal_task_closures c WHERE c.task_id = t.id)
        ORDER BY t.created_at, t.rowid`,
      [viewer.networkId, String(viewer.role), viewer.userId],
    );
    const tasks: OpenTask[] = [];
    for (const r of rows) {
      let rejection: OpenTask['rejection'] = null;
      let gaps: Gap[] = [];
      if (r.kind === 'rejet') {
        const f = await this.db.first<{ code: string; detail: string | null; seq: number }>(
          `SELECT f.code, f.detail, lv.seq FROM diffusion_portal_feedback f JOIN listing_versions lv ON lv.id = f.version_id
            WHERE f.property_id = ? AND f.portal = ? AND f.outcome = 'rejet' ORDER BY f.at DESC, f.rowid DESC LIMIT 1`,
          [r.property_id, r.portal],
        );
        if (f) rejection = { code: f.code, detail: f.detail, seq: Number(f.seq) };
      } else {
        // Ce qui diffère : la dernière relecture qui a trouvé un écart, jamais une relecture conforme périmée [R473].
        const c = await this.db.first<{ gaps: string }>(
          `SELECT gaps FROM diffusion_portal_checks WHERE property_id = ? AND portal = ? AND outcome IN ('ecart', 'introuvable', 'toujours_en_ligne') ORDER BY at DESC, rowid DESC LIMIT 1`,
          [r.property_id, r.portal],
        );
        gaps = c ? (JSON.parse(c.gaps) as Gap[]) : [];
      }
      tasks.push({ taskId: r.id, propertyId: r.property_id, portal: r.portal, kind: r.kind, createdAt: r.created_at, rejection, gaps });
    }
    return { ok: true, tasks };
  }

  /**
   * Les liens que le vendeur peut ouvrir : une annonce par portail où le bien est diffusé, dont la dernière relecture
   * est conforme à la version publiée du moment [R474]. Lu par l'espace du vendeur après son propre contrôle.
   */
  async sellerLinks(networkId: string, propertyId: string): Promise<SellerLink[]> {
    const version = await this.latestVersion(networkId, propertyId);
    if (!version) return [];
    const settings = await this.portals(networkId);
    const links: SellerLink[] = [];
    for (const plan of await this.plan(networkId, propertyId)) {
      if (plan.status !== 'a_diffuser') continue;
      const c = await this.db.first<{ outcome: string; version_id: string; at: string; online_url: string }>(
        `SELECT c.outcome, c.version_id, c.at, f.online_url FROM diffusion_portal_checks c JOIN diffusion_portal_feedback f ON f.id = c.acceptance_id
          WHERE c.property_id = ? AND c.portal = ? AND c.network_id = ? ORDER BY c.at DESC, c.rowid DESC LIMIT 1`,
        [propertyId, plan.portal, networkId],
      );
      if (!c || c.outcome !== 'conforme' || c.version_id !== version.id) continue;
      const s = settings.find((x) => x.code === plan.portal)!;
      links.push({ portal: plan.portal, label: s.label, url: c.online_url, verifiedAt: c.at, seq: Number(version.seq) });
    }
    return links;
  }

  /** Le classement des portails sur une période, par les mandats puis les contacts réels ; la direction seule [R475]. */
  async ranking(viewer: Viewer, period: { from: unknown; to: unknown }): Promise<{ ok: true; ranks: PortalRank[] } | Refusal | Problem> {
    if (viewer.role !== 'direction') return this.refuse(viewer, null, 'not_direction');
    if (typeof period.from !== 'string' || typeof period.to !== 'string' || !DAY.test(period.from) || !DAY.test(period.to)) return { ok: false, rule: 'R475', code: 'bad_period' };
    if (Number.isNaN(Date.parse(period.from)) || Number.isNaN(Date.parse(period.to))) return { ok: false, rule: 'R475', code: 'bad_period' };
    const from = new Date(period.from).toISOString();
    const to = new Date(period.to).toISOString();
    if (from >= to) return { ok: false, rule: 'R475', code: 'bad_period' };
    const rows: Omit<PortalRank, 'rank'>[] = [];
    for (const p of await this.portals(viewer.networkId)) {
      const contacts = await this.db.first<{ n: number }>(
        `SELECT COUNT(DISTINCT person_id) AS n FROM inbound_messages
          WHERE network_id = ? AND kind = 'portal_email' AND portal = ? AND person_id IS NOT NULL AND received_at >= ? AND received_at < ?`,
        [viewer.networkId, p.code, from, to],
      );
      const mandates = await this.db.first<{ n: number }>(
        `SELECT COUNT(*) AS n FROM mandates m
          WHERE m.network_id = ? AND m.source_kind = 'portal' AND m.signed_at >= ? AND m.signed_at < ?
            AND (SELECT i.portal FROM inbound_messages i
                  WHERE i.network_id = m.network_id AND i.person_id = m.person_id AND i.kind = 'portal_email' AND i.portal IS NOT NULL AND i.received_at <= m.signed_at
                  ORDER BY i.received_at, i.id LIMIT 1) = ?`,
        [viewer.networkId, from, to, p.code],
      );
      rows.push({ portal: p.code, label: p.label, contacts: Number(contacts?.n ?? 0), mandates: Number(mandates?.n ?? 0) });
    }
    rows.sort((a, b) => b.mandates - a.mandates || b.contacts - a.contacts || (a.portal < b.portal ? -1 : a.portal > b.portal ? 1 : 0));
    await appendEvent(this.journal, { type: 'diffusion.classement', actor: this.actor(viewer), subject: `network:${viewer.networkId}`, data: { rule: 'R475', from, to, portals: rows.length } }, this.now);
    return { ok: true, ranks: rows.map((r, i) => ({ rank: i + 1, ...r })) };
  }
}
