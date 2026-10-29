/**
 * Publications prêtes pour chaque bien, visite, offre, vente (M19, X05).
 *
 * À chaque événement, l'agent du bien (ou la direction) prépare une publication :
 * - le texte : une accroche écrite par le code pour l'événement, puis un corps écrit par l'IA derrière une interface,
 *   avec le texte de secours de M07 quand l'IA est absente, lente, en panne, ou que son texte ne passe pas le contrôle
 *   (chaque nombre et chaque fait relié à la fiche, ni adresse, ni critère discriminant, ni mot interdit) [R46, R47] ;
 * - les visuels : seulement des photos certifiées par le Studio (X02), avec leur mention d'aménagement virtuel [R130,
 *   R48].
 *
 * Avant toute publication, chaque visuel a sa liste de contrôle validée par l'agent : aucune adresse lisible, aucune
 * personne reconnaissable sans son accord rangé, et la mention d'aménagement virtuel visible quand il le faut [R132].
 * Puis l'agent du bien valide la publication [R134]. Enfin, en un geste, elle part vers les comptes de l'agent et du
 * réseau, chaque réseau derrière une interface, toujours en mode essai : aucun canal réel n'est accepté [R26, R134]. La
 * porte de diffusion (D05) est relue à la préparation, à la validation et juste avant l'envoi [R42].
 *
 * Au journal : les issues et les règles, jamais le texte [R13].
 */
import type { Acces } from '../acces/acces.ts';
import type { Viewer } from '../acces/droits.ts';
import { fallbackListing, publicTextProblems, sentences, traceListing, type ListingFacts } from '../annonces/annonce-sourcee.ts';
import type { SqlDatabase } from '../db/sql.ts';
import type { PropertyStatus } from '../db/types.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import type { CertifiedPhoto } from './certificats.ts';

export const SOCIAL_EVENTS = ['nouveau_bien', 'visite', 'offre', 'vente'] as const;
export type SocialEvent = (typeof SOCIAL_EVENTS)[number];
export const SOCIAL_CHANNELS = ['instagram', 'facebook', 'linkedin', 'google', 'tiktok', 'youtube'] as const;
export type SocialChannelName = (typeof SOCIAL_CHANNELS)[number];
export const SOCIAL_ACCOUNTS = ['agent', 'reseau'] as const;
export type SocialAccount = (typeof SOCIAL_ACCOUNTS)[number];

/** L'accroche de chaque événement, écrite ici : rien sur le client, rien qui situe. */
export const EVENT_HEADLINES: Readonly<Record<SocialEvent, string>> = Object.freeze({
  nouveau_bien: 'Nouveau bien à découvrir.',
  visite: 'Visites en cours pour ce bien.',
  offre: 'Une offre a été reçue pour ce bien.',
  vente: 'Ce bien a trouvé preneur.',
});

/** L'état du bien que chaque événement exige : on n'annonce pas une offre ou une vente qui n'existe pas [R10]. */
export const EVENT_STATUSES: Readonly<Record<SocialEvent, readonly PropertyStatus[]>> = Object.freeze({
  nouveau_bien: ['available'],
  visite: ['available', 'under_offer'],
  offre: ['under_offer'],
  vente: ['sold'],
});

/**
 * Les événements qui font la publicité d'un bien encore à vendre : comme toute annonce, ils portent les mentions
 * obligatoires, calculées par le code [R43]. Une vente conclue n'annonce plus rien à vendre.
 */
export const AD_EVENTS: readonly SocialEvent[] = Object.freeze(['nouveau_bien', 'visite', 'offre']);

/** La longueur la plus courte admise par les réseaux pour une légende ; au-delà, rien n'est coupé, c'est refusé. */
const MAX_TEXT = 2200;

/** L'IA qui rédige le corps. Elle ne reçoit que les faits du bien et l'événement [R15]. */
export interface SocialWriter {
  write(input: { event: SocialEvent; facts: ListingFacts }): Promise<{ body: string }>;
}

/** Ce que reçoit un réseau. */
export interface SocialPayload {
  postId: string;
  account: SocialAccount;
  text: string;
  visuals: { ref: string; overlay: 'Aménagement virtuel' | null; certificatePath: string }[];
}

/** Un réseau social, derrière une interface. Seul le mode essai existe tant que le plan ne l'a pas mis en service. */
export interface SocialChannel {
  readonly channel: SocialChannelName;
  readonly mode: 'essai';
  post(payload: SocialPayload): Promise<void>;
}

/** Le canal d'essai : rien ne part ; l'essai est rangé avec son issue. */
export const trialSocialChannel = (channel: SocialChannelName): SocialChannel => ({ channel, mode: 'essai', post: async () => {} });

export interface SocialPost {
  id: string;
  propertyId: string;
  event: SocialEvent;
  text: string;
  origin: 'ia' | 'secours';
  visuals: { ref: string; overlay: 'Aménagement virtuel' | null; certificatePath: string; check: 'admis' | 'refuse' | null }[];
  validated: { by: string; at: string } | null;
  sends: { channel: SocialChannelName; account: SocialAccount; outcome: 'envoye' | 'echec' | 'en_cours' }[];
  createdAt: string;
}

export type PostResult<T> = { ok: true; value: T } | { ok: false; rule: 'R16' | 'R10' | 'R42' | 'R43' | 'R46' | 'R47' | 'R130' | 'R132' | 'R134' | 'R26'; code: string };

export interface PostsDeps {
  /** Les faits du bien, ceux de l'annonce de M07. */
  facts: { factsFor(propertyId: string): Promise<{ facts: ListingFacts } | null> };
  /**
   * Les mentions obligatoires du bien, calculées par le code de M07 (`computeMentions`) depuis le mandat en vigueur,
   * la fiche et la carte du réseau [R43] ; null pour un bien inconnu.
   */
  mentions: { checklist(networkId: string, propertyId: string): Promise<{ complete: boolean; text: string; publishedPriceEur: number | null } | null> };
  /** Les photos certifiées du bien (X02). */
  certs: { publishable(propertyId: string): Promise<CertifiedPhoto[]> };
  /** La porte de diffusion de D05 [R42]. */
  diffusion: { canDiffuse(networkId: string, propertyId: string, at?: Date): Promise<{ allowed: boolean }> };
  /** Le stockage des accords des personnes photographiées : seule l'existence d'une référence est lue. */
  consents: { has(ref: string): Promise<boolean> };
  channels: readonly SocialChannel[];
}

export interface PublicationsOptions {
  writer?: SocialWriter | null;
  timeoutMs?: number;
  now?: () => Date;
  newId?: () => string;
}

interface PostRow {
  id: string;
  property_id: string;
  network_id: string;
  event: SocialEvent;
  text: string;
  origin: 'ia' | 'secours';
  visuals: string;
  created_at: string;
}

const MAX_VISUALS = 10;
const MAX_BODY = 1800;
const MAX_ATTEMPTS = 10;
/** Un essai réservé sans issue depuis moins que cela est tenu pour en cours : on ne le double pas. */
const IN_FLIGHT_MS = 10 * 60_000;
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

/** Contrôle d'un texte public : chaque phrase, et le texte entier d'un bloc [R46]. */
function textProblems(text: string): string[] {
  const parts = [...sentences(text), text.replace(/\s+/g, ' ').trim()];
  return [...new Set(parts.flatMap((p) => publicTextProblems(p).map((x) => x.code)))];
}

export class Publications {
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly writer: SocialWriter | null;
  private readonly timeoutMs: number;
  private readonly channels: Map<SocialChannelName, SocialChannel>;

  constructor(
    private readonly db: SqlDatabase,
    private readonly acces: Acces,
    private readonly journal: JournalStore,
    private readonly deps: PostsDeps,
    options: PublicationsOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => crypto.randomUUID());
    this.writer = options.writer ?? null;
    this.timeoutMs = options.timeoutMs ?? 8000;
    this.channels = new Map();
    for (const c of deps.channels) {
      // Aucun canal réel tant que le plan ne l'a pas mis en service [R26, R134].
      if (c.mode !== 'essai') throw new Error(`Canal ${String(c.channel)} refusé : seul le mode essai est en service`);
      if (!(SOCIAL_CHANNELS as readonly string[]).includes(c.channel)) throw new Error('Canal inconnu');
      this.channels.set(c.channel, c);
    }
  }

  /** Prépare une publication pour un événement du bien, avec des photos certifiées. */
  async prepare(viewer: Viewer, propertyId: string, input: { event: unknown; visuals: unknown }): Promise<PostResult<SocialPost>> {
    if (viewer.role !== 'agent' && viewer.role !== 'direction') return this.refused(viewer, `property:${propertyId}`, 'role');
    const seen = await this.full(viewer, propertyId);
    if (!seen.ok) return seen;
    const actor = `${viewer.role}:${viewer.userId}`;
    const bad = (rule: 'R10' | 'R42' | 'R43' | 'R46' | 'R130', code: string) => this.bad<SocialPost>(actor, `property:${propertyId}`, rule, code);
    if (!(SOCIAL_EVENTS as readonly unknown[]).includes(input.event)) return bad('R10', 'evenement_inconnu');
    const event = input.event as SocialEvent;
    if (!EVENT_STATUSES[event].includes(seen.value.status)) return bad('R10', 'evenement_sans_fondement');
    if (!Array.isArray(input.visuals) || input.visuals.length === 0 || input.visuals.length > MAX_VISUALS || input.visuals.some((v) => typeof v !== 'string')) return bad('R10', 'visuels_invalides');
    const refs = [...new Set(input.visuals as string[])];
    if (refs.length !== input.visuals.length) return bad('R10', 'visuels_invalides');
    // Seulement des photos certifiées, avec leur mention [R130, R48].
    const certified = new Map((await this.deps.certs.publishable(propertyId)).map((c) => [c.ref, c]));
    if (refs.some((r) => !certified.has(r))) return bad('R130', 'visuel_sans_certificat');
    if (!(await this.deps.diffusion.canDiffuse(seen.value.networkId, propertyId, this.now())).allowed) return bad('R42', 'bien_non_diffusable');
    const f = await this.deps.facts.factsFor(propertyId);
    if (!f) return bad('R10', 'bien_inconnu');
    const headline = EVENT_HEADLINES[event];
    let body = await this.askWriter(event, f.facts);
    let origin: 'ia' | 'secours' = 'ia';
    // Le corps de l'IA : chaque nombre et chaque fait relié à la fiche, rien d'interdit [R47, R46] ; sinon, secours.
    if (body === null || !traceListing('', body, f.facts).ok || textProblems(`${headline}\n\n${body}`).length > 0) {
      body = fallbackListing(f.facts).body;
      origin = 'secours';
    }
    const core = `${headline}\n\n${body}`;
    if (textProblems(core).length > 0) return bad('R46', 'texte_refuse');
    // Les mentions obligatoires, toutes, sous le texte ; une seule manque et rien n'est préparé [R43].
    const mentions = await this.adMentions(event, seen.value.networkId, propertyId);
    if (mentions === 'incompletes') return bad('R43', 'mentions_incompletes');
    const text = mentions === null ? core : `${core}\n\n${mentions}`;
    if (text.length > MAX_TEXT) return bad('R10', 'texte_trop_long');
    const visuals = refs.map((r) => {
      const c = certified.get(r)!;
      return { ref: c.ref, overlay: c.overlay, certificatePath: c.certificatePath };
    });
    const id = this.newId();
    const at = this.now().toISOString();
    await this.db.run('INSERT INTO social_posts (id, property_id, network_id, event, text, origin, visuals, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [
      id,
      propertyId,
      seen.value.networkId,
      event,
      text,
      origin,
      JSON.stringify(visuals),
      actor,
      at,
    ]);
    await appendEvent(this.journal, { type: 'studio.publication.preparee', actor, subject: `property:${propertyId}`, data: { post: id, event, origin, visuals: visuals.length } }, this.now);
    return { ok: true, value: (await this.view(id))! };
  }

  /**
   * La liste de contrôle d'un visuel, validée par l'agent du bien : une adresse lisible, ou une personne reconnaissable
   * sans accord rangé, la refusent ; un aménagement virtuel exige sa mention visible [R132, R48]. Une fois par visuel.
   */
  async checkVisual(
    viewer: Viewer,
    postId: string,
    input: { ref: unknown; addressVisible: unknown; personVisible: unknown; consentRef?: unknown; stagingLabelVisible?: unknown },
  ): Promise<PostResult<SocialPost>> {
    const post = await this.agentPost(viewer, postId);
    if (!post.ok) return post;
    const actor = `agent:${viewer.userId}`;
    const subject = `property:${post.value.property_id}`;
    const visuals = JSON.parse(post.value.visuals) as SocialPayload['visuals'];
    const visual = visuals.find((v) => v.ref === input.ref);
    if (!visual) return this.bad(actor, subject, 'R10', 'visuel_inconnu');
    if (typeof input.addressVisible !== 'boolean' || typeof input.personVisible !== 'boolean') return this.bad(actor, subject, 'R132', 'liste_incomplete');
    if (await this.db.first('SELECT id FROM social_visual_checks WHERE post_id = ? AND media_ref = ?', [postId, visual.ref])) return this.bad(actor, subject, 'R10', 'deja_controle');
    let consentRef: string | null = null;
    let code: string | null = null;
    if (input.addressVisible) code = 'adresse_visible';
    else if (input.personVisible) {
      const pattern = new RegExp(`^biens/${post.value.property_id.replace(/[^0-9A-Za-z_-]/g, '\\$&')}/accords/${UUID}\\.(?:pdf|jpg|png)$`);
      if (typeof input.consentRef !== 'string' || !pattern.test(input.consentRef)) code = 'personne_sans_accord';
      else {
        let stored = false;
        try {
          stored = await this.deps.consents.has(input.consentRef);
        } catch (error) {
          await appendEvent(this.journal, { type: 'studio.publication.stockage_indisponible', actor, subject, data: { rule: 'R132', error: error instanceof Error ? error.name : 'inconnue' } }, this.now);
          return { ok: false, rule: 'R132', code: 'stockage_indisponible' };
        }
        if (!stored) code = 'personne_sans_accord';
        else consentRef = input.consentRef;
      }
    }
    let staging: number | null = null;
    if (code === null && visual.overlay !== null) {
      if (input.stagingLabelVisible !== true) code = 'amenagement_sans_mention';
      else staging = 1;
    }
    const outcome = code === null ? 'admis' : 'refuse';
    const { changes } = await this.db.run(
      `INSERT INTO social_visual_checks (id, post_id, media_ref, address_visible, person_visible, consent_ref, staging_label_visible, outcome, checked_by, checked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
      [this.newId(), postId, visual.ref, input.addressVisible ? 1 : 0, input.personVisible ? 1 : 0, consentRef, staging, outcome, actor, this.now().toISOString()],
    );
    if (changes !== 1) return this.bad(actor, subject, 'R10', 'deja_controle');
    await appendEvent(this.journal, { type: 'studio.publication.visuel', actor, subject, data: { post: postId, rule: 'R132', outcome, code } }, this.now);
    if (code !== null) return { ok: false, rule: 'R132', code };
    return { ok: true, value: (await this.view(postId))! };
  }

  /** L'agent du bien valide la publication : chaque visuel admis, le texte encore sain, le bien encore diffusable [R134]. */
  async validate(viewer: Viewer, postId: string): Promise<PostResult<SocialPost>> {
    const post = await this.agentPost(viewer, postId);
    if (!post.ok) return post;
    const actor = `agent:${viewer.userId}`;
    const subject = `property:${post.value.property_id}`;
    const current = (await this.view(postId))!;
    if (current.validated) return { ok: true, value: current };
    if (current.visuals.some((v) => v.check !== 'admis')) return this.bad(actor, subject, 'R132', 'visuel_non_controle');
    const stale = await this.stale(post.value);
    if (stale) return this.bad(actor, subject, stale.rule, stale.code);
    if (!(await this.deps.diffusion.canDiffuse(post.value.network_id, post.value.property_id, this.now())).allowed) return this.bad(actor, subject, 'R42', 'bien_non_diffusable');
    await this.db.run('INSERT INTO social_post_validations (post_id, validated_by, validated_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING', [postId, actor, this.now().toISOString()]);
    await appendEvent(this.journal, { type: 'studio.publication.validee', actor, subject, data: { post: postId, rule: 'R134' } }, this.now);
    return { ok: true, value: (await this.view(postId))! };
  }

  /**
   * En un geste, l'agent du bien envoie la publication validée vers les réseaux et les comptes choisis, en mode essai.
   * Juste avant : la porte de D05 et les certificats des visuels sont relus [R42, R130]. Un envoi réussi ne se refait
   * jamais ; un échec se retente au geste suivant.
   */
  async publish(viewer: Viewer, postId: string, targets: unknown): Promise<PostResult<SocialPost>> {
    const post = await this.agentPost(viewer, postId);
    if (!post.ok) return post;
    const actor = `agent:${viewer.userId}`;
    const subject = `property:${post.value.property_id}`;
    if (!Array.isArray(targets) || targets.length === 0 || targets.length > SOCIAL_CHANNELS.length * SOCIAL_ACCOUNTS.length) return this.bad(actor, subject, 'R10', 'cibles_invalides');
    const wanted: { channel: SocialChannelName; account: SocialAccount }[] = [];
    for (const t of targets) {
      if (typeof t !== 'object' || t === null) return this.bad(actor, subject, 'R10', 'cibles_invalides');
      const { channel, account } = t as Record<string, unknown>;
      if (!(SOCIAL_CHANNELS as readonly unknown[]).includes(channel) || !(SOCIAL_ACCOUNTS as readonly unknown[]).includes(account)) return this.bad(actor, subject, 'R10', 'cibles_invalides');
      if (!wanted.some((w) => w.channel === channel && w.account === account)) wanted.push({ channel: channel as SocialChannelName, account: account as SocialAccount });
    }
    const current = (await this.view(postId))!;
    if (!current.validated) return this.bad(actor, subject, 'R134', 'non_validee');
    if (wanted.some((w) => !this.channels.has(w.channel))) return this.bad(actor, subject, 'R26', 'canal_hors_service');
    if (!(await this.deps.diffusion.canDiffuse(post.value.network_id, post.value.property_id, this.now())).allowed) return this.bad(actor, subject, 'R42', 'bien_non_diffusable');
    // L'événement est encore vrai au moment d'envoyer : une offre retirée ne s'annonce plus [R10].
    const status = await this.db.first<{ status: PropertyStatus }>('SELECT status FROM properties WHERE id = ?', [post.value.property_id]);
    if (!status || !EVENT_STATUSES[post.value.event].includes(status.status)) return this.bad(actor, subject, 'R10', 'evenement_sans_fondement');
    const certified = new Set((await this.deps.certs.publishable(post.value.property_id)).map((c) => c.ref));
    if (current.visuals.some((v) => !certified.has(v.ref))) return this.bad(actor, subject, 'R130', 'visuel_sans_certificat');
    // Le texte dit encore vrai : la fiche a pu être corrigée depuis la préparation. Sinon, rien ne part ; il faut
    // préparer et valider une nouvelle publication [R47, R134].
    const stale = await this.stale(post.value);
    if (stale) return this.bad(actor, subject, stale.rule, stale.code);
    for (const w of wanted) {
      const attempt = await this.claim(postId, w, actor);
      if (attempt === null) continue;
      const channel = this.channels.get(w.channel)!;
      let outcome: 'envoye' | 'echec' = 'envoye';
      try {
        await channel.post({ postId, account: w.account, text: post.value.text, visuals: current.visuals.map(({ ref, overlay, certificatePath }) => ({ ref, overlay, certificatePath })) });
      } catch {
        outcome = 'echec';
      }
      await this.db.run('INSERT INTO social_post_sends (attempt_id, outcome, done_at) VALUES (?, ?, ?)', [attempt, outcome, this.now().toISOString()]);
      await appendEvent(this.journal, { type: 'studio.publication.envoi', actor, subject, data: { post: postId, channel: w.channel, account: w.account, mode: 'essai', outcome, rule: 'R26' } }, this.now);
    }
    return { ok: true, value: (await this.view(postId))! };
  }

  /** Les mentions d'un événement d'annonce : leur texte, null si l'événement n'en porte pas, ou « incomplètes » [R43]. */
  private async adMentions(event: SocialEvent, networkId: string, propertyId: string): Promise<string | null | 'incompletes'> {
    if (!AD_EVENTS.includes(event)) return null;
    const m = await this.deps.mentions.checklist(networkId, propertyId);
    return m && m.complete && m.publishedPriceEur !== null && m.text.trim() !== '' ? m.text : 'incompletes';
  }

  /**
   * Le texte rangé dit-il encore vrai ? Ses mentions sont celles du moment, au caractère près [R43] ; son corps passe
   * le contrôle des textes publics [R46] ; chaque nombre et chaque fait se relie encore à la fiche du moment [R47].
   * Sinon, rien ne part : il faut préparer et valider une nouvelle publication.
   */
  private async stale(row: PostRow): Promise<{ rule: 'R43' | 'R46' | 'R47'; code: string } | null> {
    const mentions = await this.adMentions(row.event, row.network_id, row.property_id);
    if (mentions === 'incompletes') return { rule: 'R43', code: 'mentions_incompletes' };
    const suffix = mentions === null ? '' : `\n\n${mentions}`;
    if (!row.text.endsWith(suffix)) return { rule: 'R43', code: 'mentions_perimees' };
    const core = row.text.slice(0, row.text.length - suffix.length);
    if (textProblems(core).length > 0) return { rule: 'R46', code: 'texte_refuse' };
    const headline = `${EVENT_HEADLINES[row.event]}\n\n`;
    const f = await this.deps.facts.factsFor(row.property_id);
    if (!f || !core.startsWith(headline) || !traceListing('', core.slice(headline.length), f.facts).ok) return { rule: 'R47', code: 'texte_perime' };
    return null;
  }

  /** Une publication, pour qui voit le bien en entier [R16]. */
  async read(viewer: Viewer, postId: string): Promise<PostResult<SocialPost>> {
    const row = await this.db.first<PostRow>('SELECT * FROM social_posts WHERE id = ?', [postId]);
    if (!row || row.network_id !== viewer.networkId) return { ok: false, rule: 'R10', code: 'publication_inconnue' };
    const seen = await this.full(viewer, row.property_id);
    if (!seen.ok) return seen;
    return { ok: true, value: (await this.view(postId))! };
  }

  /** Réserve l'essai suivant pour une cible : null s'il est déjà envoyé, en cours, ou pris par un autre passage. */
  private async claim(postId: string, w: { channel: SocialChannelName; account: SocialAccount }, actor: string): Promise<string | null> {
    const rows = await this.db.all<{ id: string; attempt: number; claimed_at: string; outcome: string | null }>(
      `SELECT a.id, a.attempt, a.claimed_at, s.outcome FROM social_post_attempts a LEFT JOIN social_post_sends s ON s.attempt_id = a.id
       WHERE a.post_id = ? AND a.channel = ? AND a.account = ? ORDER BY a.attempt`,
      [postId, w.channel, w.account],
    );
    if (rows.some((r) => r.outcome === 'envoye')) return null;
    if (rows.some((r) => r.outcome === null && this.now().getTime() - Date.parse(r.claimed_at) < IN_FLIGHT_MS)) return null;
    if (rows.length >= MAX_ATTEMPTS) return null;
    const id = this.newId();
    const { changes } = await this.db.run(
      "INSERT INTO social_post_attempts (id, post_id, channel, account, attempt, mode, claimed_by, claimed_at) VALUES (?, ?, ?, ?, ?, 'essai', ?, ?) ON CONFLICT DO NOTHING",
      [id, postId, w.channel, w.account, rows.length, actor, this.now().toISOString()],
    );
    return changes === 1 ? id : null;
  }

  private async askWriter(event: SocialEvent, facts: ListingFacts): Promise<string | null> {
    if (!this.writer) return null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // L'IA reçoit une copie des seuls faits et de l'événement : rien d'autre [R15].
      const out = await Promise.race([
        this.writer.write({ event, facts: structuredClone(facts) }),
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), this.timeoutMs);
        }),
      ]);
      if (!out || typeof out.body !== 'string') return null;
      const body = out.body.trim();
      return body.length >= 10 && body.length <= MAX_BODY ? body : null;
    } catch (error) {
      await appendEvent(this.journal, { type: 'studio.publication.ia_en_panne', actor: 'systeme:studio', subject: null, data: { error: error instanceof Error ? error.name : 'inconnue' } }, this.now);
      return null;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async view(postId: string): Promise<SocialPost | null> {
    const row = await this.db.first<PostRow>('SELECT * FROM social_posts WHERE id = ?', [postId]);
    if (!row) return null;
    const checks = await this.db.all<{ media_ref: string; outcome: 'admis' | 'refuse' }>('SELECT media_ref, outcome FROM social_visual_checks WHERE post_id = ?', [postId]);
    const byRef = new Map(checks.map((c) => [c.media_ref, c.outcome]));
    const val = await this.db.first<{ validated_by: string; validated_at: string }>('SELECT validated_by, validated_at FROM social_post_validations WHERE post_id = ?', [postId]);
    const attempts = await this.db.all<{ channel: SocialChannelName; account: SocialAccount; outcome: 'envoye' | 'echec' | null }>(
      `SELECT a.channel, a.account, s.outcome FROM social_post_attempts a LEFT JOIN social_post_sends s ON s.attempt_id = a.id WHERE a.post_id = ? ORDER BY a.channel, a.account, a.attempt`,
      [postId],
    );
    const last = new Map<string, SocialPost['sends'][number]>();
    for (const a of attempts) {
      const key = `${a.channel}/${a.account}`;
      if (last.get(key)?.outcome === 'envoye') continue;
      last.set(key, { channel: a.channel, account: a.account, outcome: a.outcome ?? 'en_cours' });
    }
    return {
      id: row.id,
      propertyId: row.property_id,
      event: row.event,
      text: row.text,
      origin: row.origin,
      visuals: (JSON.parse(row.visuals) as SocialPayload['visuals']).map((v) => ({ ...v, check: byRef.get(v.ref) ?? null })),
      validated: val ? { by: val.validated_by, at: val.validated_at } : null,
      sends: [...last.values()],
      createdAt: row.created_at,
    };
  }

  /** La publication, pour l'agent du bien seul : c'est lui qui contrôle, valide et publie [R134, R16]. */
  private async agentPost(viewer: Viewer, postId: string): Promise<PostResult<PostRow>> {
    const row = await this.db.first<PostRow>('SELECT * FROM social_posts WHERE id = ?', [postId]);
    if (!row || row.network_id !== viewer.networkId) return { ok: false, rule: 'R10', code: 'publication_inconnue' };
    if (viewer.role !== 'agent') return this.refused(viewer, `property:${row.property_id}`, 'role');
    const read = await this.acces.readProperty(viewer, row.property_id);
    if (!read.ok) return { ok: false, rule: 'R16', code: read.code };
    if (read.view !== 'full' || read.value.agent_id !== viewer.userId) return this.refused(viewer, `property:${row.property_id}`, 'not_assigned');
    return { ok: true, value: row };
  }

  private async full(viewer: Viewer, propertyId: string): Promise<PostResult<{ networkId: string; status: PropertyStatus }>> {
    const read = await this.acces.readProperty(viewer, propertyId);
    if (!read.ok) return { ok: false, rule: 'R16', code: read.code };
    if (read.view !== 'full') return this.refused(viewer, `property:${propertyId}`, 'not_assigned');
    return { ok: true, value: { networkId: read.value.network_id, status: read.value.status } };
  }

  private async bad<T>(actor: string, subject: string, rule: 'R10' | 'R42' | 'R43' | 'R46' | 'R47' | 'R130' | 'R132' | 'R134' | 'R26', code: string): Promise<PostResult<T>> {
    await appendEvent(this.journal, { type: 'studio.publication.refuse', actor, subject, data: { rule, code } }, this.now);
    return { ok: false, rule, code };
  }

  private async refused<T>(viewer: Viewer, subject: string, code: string): Promise<PostResult<T>> {
    await appendEvent(
      this.journal,
      { type: 'acces.refuse', actor: `${String(viewer.role)}:${viewer.userId}`, subject, data: { rule: 'R16', role: String(viewer.role), kind: 'social_post', code } },
      this.now,
    );
    return { ok: false, rule: 'R16', code };
  }
}
