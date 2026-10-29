/**
 * La fiche Google de chaque agent (M01, AT06) [R154, R64, R26, R46, R07, R06].
 *
 * Derrière une interface (`GbpClient`, un faux service dans les tests, l'API Google Business Profile plus tard, H07) :
 *
 * - les informations de la fiche (nom, téléphone, site) tenues à jour depuis les réglages, envoyées seulement quand elles
 *   changent ;
 * - des publications régulières tirées des biens publiés, écrites par le code depuis la version publiée de l'annonce,
 *   avec le lien vers sa page : au plus une par agent et par période (réglage), jamais deux fois le même bien ;
 * - des réponses aux avis préparées par l'IA à partir de la note et du texte de l'avis seuls, ou par le secours fait par
 *   le code quand l'IA manque, tarde ou propose un texte refusé.
 *
 * Aucune réponse ni publication ne part sans la validation nommée d'un humain sur son texte exact [R154]. Chaque texte
 * passe un contrôle écrit : ni nom de client, ni adresse, ni montant, ni détail du dossier, ni coordonnée [R154, R46],
 * aucune contrepartie [R64], ni « mandataire » ni « gratuit » [R07], aucune mention de l'IA [R06]. Le texte est recontrôlé
 * au moment de partir.
 *
 * Jamais vu : le nom de l'auteur d'un avis n'est jamais gardé, ni envoyé à l'IA ; seules les empreintes de ses mots le
 * sont, et pourtant aucune réponse ne peut le citer, ni citer un client de la base, même un autre que l'auteur.
 *
 * AIMMO n'écrit jamais d'avis à la place d'un client [R64] : l'interface ne sait que lire les avis et y répondre. En mode
 * essai, rien ne part : l'interface n'est jamais appelée pour écrire, l'envoi est seulement noté [R26].
 */
import type { Viewer } from '../acces/droits.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';

/** Un avis tel que Google le donne. Le nom de son auteur ne sort jamais de la lecture. */
export interface GbpReview {
  reviewRef: string;
  rating: number;
  comment: string | null;
  authorName: string | null;
  reviewedAt: string;
}

export interface GbpInfo {
  title: string;
  phone: string | null;
  websiteUri: string;
}

/** L'API Google Business Profile, réduite à ce qu'AIMMO fait : aucune méthode pour écrire un avis [R64]. */
export interface GbpClient {
  listReviews(locationRef: string): Promise<GbpReview[]>;
  replyToReview(locationRef: string, reviewRef: string, text: string): Promise<void>;
  createPost(locationRef: string, post: { text: string; linkUri: string }): Promise<void>;
  updateInfo(locationRef: string, info: GbpInfo): Promise<void>;
}

/** Ce que l'IA reçoit pour proposer une réponse : la note, le texte de l'avis et le prénom de l'agent, rien d'autre. */
export interface ReviewReplyWriter {
  write(input: { rating: number; comment: string | null; agentFirstName: string }): Promise<string>;
}

export type GbpProblem = 'nom' | 'adresse' | 'montant' | 'dossier' | 'coordonnee' | 'contrepartie' | 'vocabulaire' | 'ia' | 'temoignage' | 'longueur' | 'vide';

export type GbpRefusal =
  | { ok: false; rule: 'R16'; code: 'role' | 'agent_inconnu' | 'agent_parti' | 'inconnu' }
  | { ok: false; rule: 'R154'; code: 'texte_refuse'; problems: GbpProblem[] }
  | { ok: false; rule: 'R154'; code: 'non_valide' | 'texte_change' | 'deja_valide' | 'deja_parti' | 'bien_retire' | 'deja_publie' }
  | { ok: false; rule: null; code: 'sans_fiche' | 'invalide' | 'occupe' | 'echec' | 'sans_service' };

export interface GbpDraft {
  draftId: string;
  agentId: string;
  kind: 'reponse' | 'publication';
  reviewId: string | null;
  propertyId: string | null;
  body: string;
  linkUri: string | null;
  origin: 'ia' | 'secours' | 'code' | 'agent';
  validatedBy: string | null;
  validatedAt: string | null;
}

const MAX_TEXT = 1500;
const AI_TIMEOUT_MS = 20_000;

/* ---------- Le contrôle des textes ---------- */

/** Un mot sans accent, en minuscules. */
export const foldWord = (w: string): string => w.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const words = (text: string): string[] => text.split(/[^\p{L}]+/u).filter((w) => w.length >= 2);

// Une voie sans ambiguïté, suivie de n'importe quel nom, en majuscules ou non (« rue de la paix », « Rue Monge »).
const STREET = /\b(?:rue|avenue|av\.|boulevard|bd|impasse|all[ée]e(?!\s+(?:priv|centrale|de\s+(?:garage|jardin)))|faubourg)\s+(?:(?:de\s+la|de\s+l['’]|du|des|de|d['’])\s*)?\p{L}{2,}/iu;
// Un mot qui est aussi un mot courant (« mise en place », « en cours ») : voie seulement devant un nom propre.
const STREET_PROPER_NAME = /\b(?:[Cc]hemin|[Pp]lace|[Qq]uai|[Rr]oute|[Ss]quare|[Cc]ours|[Pp]assage|[Ll]otissement|[Rr][ée]sidence)\s+(?:(?:de\s+la|de\s+l['’]|du|des|de|d['’])\s*)?\p{Lu}/u;
const NUMBERED_STREET = /\b\d{1,4}\s*(?:bis|ter)?\s*,?\s*(?:rue|avenue|boulevard|chemin|all[ée]e|impasse|place|quai|route|square|cours|passage|faubourg)\b/iu;
const AMOUNT = /\d[\d\s.  ]*(?:,\d+)?\s*(?:€|euros?\b|k€|keur\b)|\b\d{1,3}(?:[\s.  ]\d{3})+\b|\b\d{4,}\b/iu;
const FILE_WORDS = /\b(?:compromis|acte|notaires?|offres?\s+d['’]achat|pr[êe]t|financement|banques?|cr[ée]dit|dossier|signature|r[ée]tractation|succession|h[ée]ritage|divorce|s[ée]paration|d[ée]c[èe]s|mutation|licenciement|apport|diagnostics?)\b/iu;
const CONTACT = /[^\s@]+@[^\s@]+\.[a-z]{2,}|(?:\+33|\b0)\s*[1-9](?:[\s.-]*\d{2}){4}/iu;
const COUNTERPART = /\b(?:r[ée]duction|remise|rembours\w*|cadeau|bon\s+d['’]achat|geste\s+commercial|d[ée]dommag\w*|compensation|ristourne|contrepartie|offrons|offrir|gagner|concours|tirage)\b/iu;
const VOCABULARY = /\b(?:mandataires?|gratuit\w*)\b/iu;
const AI = /\b(?:IA|I\.A\.|intelligence\s+artificielle|assistant\s+virtuel|chatgpt|robot|automatiquement|algorithme)\b/u;
const AI_CI = /\b(?:intelligence\s+artificielle|assistant\s+virtuel|chatgpt|robot|algorithme)\b/iu;
const TESTIMONIAL = /[«»“”"]|\b(?:nos\s+clients?\s+(?:disent|t[ée]moignent|recommandent)|t[ée]moignages?|[ée]toiles?|\d\s*\/\s*5)\b/iu;

export interface TextContext {
  kind: 'reponse' | 'publication';
  /** Les empreintes des mots du nom de l'auteur de l'avis. */
  authorTokenHashes: readonly string[];
  /** Les prénoms et les noms de famille des clients de la base, sans accent ni majuscule. */
  clientFirstNames: ReadonlySet<string>;
  clientLastNames: ReadonlySet<string>;
  /** La signature ajoutée par le code (« Camille, votre agent immobilier »), seule exception aux noms : elle n'est pas lue. */
  signature?: string | null;
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Les empreintes des mots d'un nom : de quoi reconnaître le nom dans un texte, sans pouvoir le relire. */
export async function nameTokenHashes(name: string | null, networkId: string): Promise<string[]> {
  if (!name) return [];
  const out = new Set<string>();
  for (const w of words(name)) out.add(await sha256Hex(`gbp-auteur:${networkId}:${foldWord(w)}`));
  return [...out].sort();
}

/** Le contrôle d'un texte de la fiche Google, avant de le ranger et avant de le faire partir [R154, R64, R07, R06]. */
export async function checkGbpText(text: string, ctx: TextContext, networkId: string): Promise<GbpProblem[]> {
  const problems = new Set<GbpProblem>();
  const t = text.trim();
  if (t === '') problems.add('vide');
  if (t.length > MAX_TEXT) problems.add('longueur');
  if (STREET.test(t) || STREET_PROPER_NAME.test(t) || NUMBERED_STREET.test(t)) problems.add('adresse');
  if (AMOUNT.test(t)) problems.add('montant');
  if (FILE_WORDS.test(t)) problems.add('dossier');
  if (CONTACT.test(t)) problems.add('coordonnee');
  if (COUNTERPART.test(t)) problems.add('contrepartie');
  if (VOCABULARY.test(t)) problems.add('vocabulaire');
  if (AI.test(t) || AI_CI.test(t)) problems.add('ia');
  if (ctx.kind === 'publication' && TESTIMONIAL.test(t)) problems.add('temoignage');
  // La signature du code, seulement si elle est la dernière ligne exacte du texte ; tout le reste est lu.
  const sig = ctx.signature ? `\n${ctx.signature}` : null;
  const body = sig && t.endsWith(sig) ? t.slice(0, -sig.length) : t;
  const authors = new Set(ctx.authorTokenHashes);
  const list = words(body);
  for (let i = 0; i < list.length; i++) {
    const w = list[i]!;
    const folded = foldWord(w);
    // Le nom de l'auteur, écrit de n'importe quelle façon, même s'il est aussi celui d'un agent.
    if (authors.size > 0 && authors.has(await sha256Hex(`gbp-auteur:${networkId}:${folded}`))) problems.add('nom');
    // Un nom de famille d'un client de la base, de n'importe quelle façon ; un prénom écrit comme un nom, ou suivi d'un nom.
    if (ctx.clientLastNames.has(folded)) problems.add('nom');
    if (ctx.clientFirstNames.has(folded) && (/^\p{Lu}/u.test(w) || (i + 1 < list.length && ctx.clientLastNames.has(foldWord(list[i + 1]!))))) problems.add('nom');
  }
  return [...problems].sort();
}

/** La réponse faite par le code quand l'IA manque : sans nom, sans détail, signée du prénom de l'agent. */
export const signatureOf = (agentFirstName: string): string => `${agentFirstName}, votre agent immobilier`;

export function fallbackReply(rating: number, agentFirstName: string): string {
  const sign = `\n${signatureOf(agentFirstName)}`;
  if (rating >= 4) return `Merci pour votre avis et pour votre confiance. C’est une vraie joie de vous avoir accompagné dans votre projet, et je reste à votre écoute pour la suite.${sign}`;
  if (rating === 3) return `Merci d’avoir pris le temps de partager votre avis. Vos remarques comptent : elles m’aident à mieux faire. Je reste à votre écoute si vous souhaitez en parler.${sign}`;
  return `Merci d’avoir pris le temps de nous écrire. Je suis désolé que votre expérience n’ait pas été à la hauteur de vos attentes. Je vous propose d’en parler de vive voix, pour comprendre ce qui n’a pas été.${sign}`;
}

/** La publication d'un bien publié, écrite par le code : le titre de l'annonce et le lien, jamais le prix [R154]. */
export function listingPostText(title: string, agentFirstName: string): string {
  return `${title.trim()}. À découvrir dès maintenant : photos, visite et toutes les informations sur la page du bien.\n${signatureOf(agentFirstName)}`;
}

/** Les particules des noms de famille, qui sont aussi des mots courants. */
const PARTICLES = new Set(['de', 'du', 'des', 'le', 'la', 'les', 'da', 'das', 'do', 'dos', 'di', 'del', 'della', 'van', 'von', 'der', 'den', 'el', 'al', 'ben', 'bin', 'mac', 'mc', 'st', 'saint', 'sainte', 'et', 'y', 'ou', 'au', 'aux', 'en']);

/* ---------- Le service ---------- */

export interface FicheGoogleOptions {
  now?: () => Date;
  newId?: () => string;
  client?: GbpClient | undefined;
  writer?: ReviewReplyWriter | undefined;
  /** `essai` tant que le plan ne l'a pas mis en service : rien ne part [R26]. */
  mode?: 'essai' | 'reel';
  timeoutMs?: number;
  /** Une publication de bien au plus par agent et par période, en jours. */
  postEveryDays?: number;
}

interface DraftRow {
  id: string;
  network_id: string;
  agent_id: string;
  kind: 'reponse' | 'publication';
  review_id: string | null;
  property_id: string | null;
  listing_seq: number | null;
  body: string;
  link_uri: string | null;
  origin: GbpDraft['origin'];
  validated_by: string | null;
  validated_at: string | null;
  text_sha256: string | null;
}

const DRAFT_SELECT =
  'SELECT d.id, d.network_id, d.agent_id, d.kind, d.review_id, d.property_id, d.listing_seq, d.body, d.link_uri, d.origin, v.validated_by, v.validated_at, v.text_sha256 FROM gbp_drafts d LEFT JOIN gbp_validations v ON v.draft_id = d.id';

const toDraft = (r: DraftRow): GbpDraft => ({
  draftId: r.id,
  agentId: r.agent_id,
  kind: r.kind,
  reviewId: r.review_id,
  propertyId: r.property_id,
  body: r.body,
  linkUri: r.link_uri,
  origin: r.origin,
  validatedBy: r.validated_by,
  validatedAt: r.validated_at,
});

const textHash = (r: Pick<DraftRow, 'kind' | 'body' | 'link_uri'>): Promise<string> => sha256Hex(`${r.kind}\n${r.body}\n${r.link_uri ?? ''}`);

interface Location {
  locationRef: string;
  title: string;
  websiteUri: string;
}

export class FicheGoogle {
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly client: GbpClient | undefined;
  private readonly writer: ReviewReplyWriter | undefined;
  private readonly mode: 'essai' | 'reel';
  private readonly timeoutMs: number;
  private readonly postEveryDays: number;

  constructor(
    private readonly db: SqlDatabase,
    private readonly journal: JournalStore,
    options: FicheGoogleOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => crypto.randomUUID());
    this.client = options.client;
    this.writer = options.writer;
    this.mode = options.mode ?? 'essai';
    this.timeoutMs = options.timeoutMs ?? AI_TIMEOUT_MS;
    this.postEveryDays = options.postEveryDays ?? 7;
  }

  private actor(viewer: Viewer): string {
    return `${String(viewer.role)}:${viewer.userId}`;
  }

  private async refuse(viewer: Viewer, subject: string, code: 'role' | 'agent_inconnu' | 'agent_parti' | 'inconnu'): Promise<GbpRefusal> {
    await appendEvent(this.journal, { type: 'acces.refuse', actor: this.actor(viewer), subject, data: { rule: 'R16', role: String(viewer.role), kind: 'fiche_google', code } }, this.now);
    return { ok: false, rule: 'R16', code };
  }

  /** L'agent de la fiche lui-même, ou la direction de son réseau. */
  private async allowed(viewer: Viewer, agentId: string): Promise<{ ok: true; firstName: string } | GbpRefusal> {
    if (viewer.role !== 'direction' && !(viewer.role === 'agent' && viewer.userId === agentId)) return this.refuse(viewer, `agent:${agentId}`, 'role');
    const agent = await this.db.first<{ first_name: string; status: string }>('SELECT first_name, status FROM agents WHERE id = ? AND network_id = ?', [agentId, viewer.networkId]);
    if (!agent) return this.refuse(viewer, `agent:${agentId}`, 'agent_inconnu');
    if (agent.status !== 'active') return this.refuse(viewer, `agent:${agentId}`, 'agent_parti');
    return { ok: true, firstName: agent.first_name };
  }

  private async location(networkId: string, agentId: string): Promise<Location | null> {
    const r = await this.db.first<{ location_ref: string; title: string; website_uri: string }>(
      'SELECT location_ref, title, website_uri FROM gbp_locations WHERE network_id = ? AND agent_id = ? ORDER BY set_at DESC, rowid DESC LIMIT 1',
      [networkId, agentId],
    );
    return r ? { locationRef: r.location_ref, title: r.title, websiteUri: r.website_uri } : null;
  }

  private async context(networkId: string, kind: 'reponse' | 'publication', authorTokenHashes: readonly string[], signature: string | null): Promise<TextContext> {
    const clientFirstNames = new Set<string>();
    const clientLastNames = new Set<string>();
    for (const p of await this.db.all<{ first_name: string | null; last_name: string | null }>('SELECT DISTINCT first_name, last_name FROM persons WHERE network_id = ?', [networkId])) {
      for (const w of words(p.first_name ?? '')) if (!PARTICLES.has(foldWord(w))) clientFirstNames.add(foldWord(w));
      // Une particule (« Le Goff », « Da Silva ») n'est pas un nom ; un nom de deux lettres n'est lu que comme un nom propre.
      for (const w of words(p.last_name ?? '')) {
        const f = foldWord(w);
        if (PARTICLES.has(f)) continue;
        (f.length >= 3 ? clientLastNames : clientFirstNames).add(f);
      }
    }
    return { kind, authorTokenHashes, clientFirstNames, clientLastNames, signature };
  }

  /** La fiche Google d'un agent, réglée par la direction. Chaque réglage s'ajoute. */
  async setLocation(viewer: Viewer, agentId: string, input: { locationRef: unknown; title: unknown; websiteUri: unknown }): Promise<{ ok: true } | GbpRefusal> {
    if (viewer.role !== 'direction') return this.refuse(viewer, `agent:${agentId}`, 'role');
    const allowed = await this.allowed(viewer, agentId);
    if (!allowed.ok) return allowed;
    const ref = typeof input.locationRef === 'string' ? input.locationRef.trim() : '';
    const title = typeof input.title === 'string' ? input.title.trim() : '';
    const site = typeof input.websiteUri === 'string' ? input.websiteUri.trim() : '';
    if (!/^locations\/[A-Za-z0-9_-]{1,190}$/.test(ref) || title.length < 2 || title.length > 100 || /[<>]/.test(title) || !/^https:\/\/[^\s"'<>]{4,290}$/.test(site)) return { ok: false, rule: null, code: 'invalide' };
    if ((await checkGbpText(title, { kind: 'publication', authorTokenHashes: [], clientFirstNames: new Set(), clientLastNames: new Set() }, viewer.networkId)).length > 0) return { ok: false, rule: null, code: 'invalide' };
    await this.db.run('INSERT INTO gbp_locations (id, network_id, agent_id, location_ref, title, website_uri, set_by, set_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [
      this.newId(), viewer.networkId, agentId, ref, title, site, this.actor(viewer), this.now().toISOString(),
    ]);
    await appendEvent(this.journal, { type: 'attirer.google.fiche_reglee', actor: this.actor(viewer), subject: `agent:${agentId}`, data: {} }, this.now);
    return { ok: true };
  }

  /**
   * Les informations de la fiche, tirées des réglages (nom, site) et de la carte publique de l'agent (téléphone),
   * envoyées seulement quand elles ont changé depuis le dernier envoi. En mode essai, rien ne part [R26].
   */
  async syncInfo(networkId: string, agentId: string): Promise<{ ok: true; changed: boolean; mode: 'essai' | 'reel' } | GbpRefusal> {
    const loc = await this.location(networkId, agentId);
    if (!loc) return { ok: false, rule: null, code: 'sans_fiche' };
    const card = await this.db.first<{ phone: string }>('SELECT phone FROM agent_public_cards WHERE agent_id = ? AND network_id = ? ORDER BY set_at DESC, rowid DESC LIMIT 1', [agentId, networkId]);
    const info: GbpInfo = { title: loc.title, phone: card?.phone ?? null, websiteUri: loc.websiteUri };
    const hash = await sha256Hex(JSON.stringify(info));
    const last = await this.db.first<{ info_sha256: string }>(
      "SELECT info_sha256 FROM gbp_sends WHERE network_id = ? AND agent_id = ? AND kind = 'informations' AND outcome IN ('essai', 'envoye') AND mode = ? ORDER BY sent_at DESC, rowid DESC LIMIT 1",
      [networkId, agentId, this.mode],
    );
    if (last?.info_sha256 === hash) return { ok: true, changed: false, mode: this.mode };
    const outcome = await this.callGoogle(() => this.client!.updateInfo(loc.locationRef, info));
    if (outcome === 'sans_service') return { ok: false, rule: null, code: 'sans_service' };
    await this.db.run("INSERT INTO gbp_sends (id, network_id, agent_id, draft_id, kind, info_sha256, mode, outcome, sent_by, sent_at) VALUES (?, ?, ?, NULL, 'informations', ?, ?, ?, 'system:fiche_google', ?)", [
      this.newId(), networkId, agentId, hash, this.mode, outcome, this.now().toISOString(),
    ]);
    await appendEvent(this.journal, { type: 'attirer.google.informations', actor: 'system:fiche_google', subject: `agent:${agentId}`, data: { rule: 'R26', mode: this.mode, outcome } }, this.now);
    if (outcome === 'echec') return { ok: false, rule: null, code: 'echec' };
    return { ok: true, changed: true, mode: this.mode };
  }

  /** En mode essai, l'interface n'est jamais appelée pour écrire [R26]. Une panne est notée, jamais avalée. */
  private async callGoogle(call: () => Promise<void>): Promise<'essai' | 'envoye' | 'echec' | 'sans_service'> {
    if (this.mode === 'essai') return 'essai';
    if (!this.client) return 'sans_service';
    try {
      await call();
      return 'envoye';
    } catch {
      return 'echec';
    }
  }

  /** Les avis de la fiche, lus par l'interface et rangés sans le nom de leur auteur. Un avis déjà lu n'est pas repris. */
  async importReviews(networkId: string, agentId: string): Promise<{ ok: true; added: number } | GbpRefusal> {
    const loc = await this.location(networkId, agentId);
    if (!loc) return { ok: false, rule: null, code: 'sans_fiche' };
    if (!this.client) return { ok: false, rule: null, code: 'sans_service' };
    let reviews: GbpReview[];
    try {
      reviews = await this.client.listReviews(loc.locationRef);
    } catch {
      await appendEvent(this.journal, { type: 'attirer.google.avis_illisibles', actor: 'system:fiche_google', subject: `agent:${agentId}`, data: {} }, this.now);
      return { ok: false, rule: null, code: 'echec' };
    }
    let added = 0;
    for (const r of reviews) {
      const rating = Number(r.rating);
      if (typeof r.reviewRef !== 'string' || r.reviewRef.length < 3 || r.reviewRef.length > 300 || !Number.isInteger(rating) || rating < 1 || rating > 5 || typeof r.reviewedAt !== 'string' || Number.isNaN(Date.parse(r.reviewedAt))) continue;
      const comment = typeof r.comment === 'string' && r.comment.trim() !== '' ? r.comment.trim().slice(0, 4096) : null;
      const hashes = await nameTokenHashes(typeof r.authorName === 'string' ? r.authorName : null, networkId);
      const res = await this.db.run(
        'INSERT INTO gbp_reviews (id, network_id, agent_id, review_ref, rating, comment, author_token_hashes, reviewed_at, imported_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (network_id, review_ref) DO NOTHING',
        [this.newId(), networkId, agentId, r.reviewRef, rating, comment, JSON.stringify(hashes), new Date(r.reviewedAt).toISOString(), this.now().toISOString()],
      );
      if (res.changes > 0) added++;
    }
    await appendEvent(this.journal, { type: 'attirer.google.avis_lus', actor: 'system:fiche_google', subject: `agent:${agentId}`, data: { added } }, this.now);
    return { ok: true, added };
  }

  private async askWriter(input: { rating: number; comment: string | null; agentFirstName: string }): Promise<string | null> {
    if (!this.writer) return null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const out = await Promise.race([
        this.writer.write({ ...input }),
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), this.timeoutMs);
        }),
      ]);
      if (typeof out !== 'string') return null;
      const text = out.trim();
      return text === '' || text.length > MAX_TEXT ? null : text;
    } catch {
      return null;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async store(networkId: string, agentId: string, d: { kind: 'reponse' | 'publication'; reviewId: string | null; propertyId: string | null; listingSeq: number | null; body: string; linkUri: string | null; origin: GbpDraft['origin'] }, by: string): Promise<GbpDraft> {
    const id = this.newId();
    await this.db.run(
      'INSERT INTO gbp_drafts (id, network_id, agent_id, kind, review_id, property_id, listing_seq, body, link_uri, origin, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [id, networkId, agentId, d.kind, d.reviewId, d.propertyId, d.listingSeq, d.body, d.linkUri, d.origin, by, this.now().toISOString()],
    );
    await appendEvent(this.journal, { type: 'attirer.google.texte_prepare', actor: by, subject: `agent:${agentId}`, data: { rule: 'R154', kind: d.kind, origin: d.origin } }, this.now);
    return toDraft((await this.db.first<DraftRow>(`${DRAFT_SELECT} WHERE d.id = ?`, [id]))!);
  }

  private async review(networkId: string, reviewId: unknown): Promise<{ id: string; agent_id: string; rating: number; comment: string | null; author_token_hashes: string } | null> {
    if (typeof reviewId !== 'string') return null;
    return this.db.first('SELECT id, agent_id, rating, comment, author_token_hashes FROM gbp_reviews WHERE id = ? AND network_id = ?', [reviewId, networkId]);
  }

  /** Prépare la réponse à un avis : le texte de l'IA s'il passe le contrôle, sinon le secours du code [R154]. */
  async draftReply(viewer: Viewer, reviewId: unknown): Promise<{ ok: true; value: GbpDraft } | GbpRefusal> {
    const review = await this.review(viewer.networkId, reviewId);
    if (!review) return this.refuse(viewer, `network:${viewer.networkId}`, 'inconnu');
    const allowed = await this.allowed(viewer, review.agent_id);
    if (!allowed.ok) return allowed;
    const ctx = await this.context(viewer.networkId, 'reponse', JSON.parse(review.author_token_hashes) as string[], signatureOf(allowed.firstName));
    const rating = Number(review.rating);
    const proposed = await this.askWriter({ rating, comment: review.comment, agentFirstName: allowed.firstName });
    if (proposed) {
      const problems = await checkGbpText(proposed, ctx, viewer.networkId);
      if (problems.length === 0) return { ok: true, value: await this.store(viewer.networkId, review.agent_id, { kind: 'reponse', reviewId: review.id, propertyId: null, listingSeq: null, body: proposed, linkUri: null, origin: 'ia' }, this.actor(viewer)) };
      // Le texte refusé n'est jamais rangé : seuls les codes de ses problèmes vont au journal [R13].
      await appendEvent(this.journal, { type: 'attirer.google.ia_refusee', actor: 'system:fiche_google', subject: `agent:${review.agent_id}`, data: { rule: 'R154', problems } }, this.now);
    }
    const fallback = fallbackReply(rating, allowed.firstName);
    const problems = await checkGbpText(fallback, ctx, viewer.networkId);
    if (problems.length > 0) {
      // Le secours lui-même refusé (un client porte un mot du modèle) : noté, sans le texte ; l'agent écrit sa réponse.
      await appendEvent(this.journal, { type: 'attirer.google.secours_refuse', actor: 'system:fiche_google', subject: `agent:${review.agent_id}`, data: { rule: 'R154', problems } }, this.now);
      return { ok: false, rule: 'R154', code: 'texte_refuse', problems };
    }
    return { ok: true, value: await this.store(viewer.networkId, review.agent_id, { kind: 'reponse', reviewId: review.id, propertyId: null, listingSeq: null, body: fallback, linkUri: null, origin: 'secours' }, this.actor(viewer)) };
  }

  /** La réponse écrite par l'agent, contrôlée comme celle de l'IA. */
  async writeReply(viewer: Viewer, reviewId: unknown, body: unknown): Promise<{ ok: true; value: GbpDraft } | GbpRefusal> {
    const review = await this.review(viewer.networkId, reviewId);
    if (!review) return this.refuse(viewer, `network:${viewer.networkId}`, 'inconnu');
    const allowed = await this.allowed(viewer, review.agent_id);
    if (!allowed.ok) return allowed;
    if (typeof body !== 'string') return { ok: false, rule: null, code: 'invalide' };
    const text = body.trim();
    const problems = await checkGbpText(text, await this.context(viewer.networkId, 'reponse', JSON.parse(review.author_token_hashes) as string[], signatureOf(allowed.firstName)), viewer.networkId);
    if (problems.length > 0) {
      await appendEvent(this.journal, { type: 'attirer.google.texte_refuse', actor: this.actor(viewer), subject: `agent:${review.agent_id}`, data: { rule: 'R154', problems } }, this.now);
      return { ok: false, rule: 'R154', code: 'texte_refuse', problems };
    }
    return { ok: true, value: await this.store(viewer.networkId, review.agent_id, { kind: 'reponse', reviewId: review.id, propertyId: null, listingSeq: null, body: text, linkUri: null, origin: 'agent' }, this.actor(viewer)) };
  }

  /** La dernière version publiée d'un bien de l'agent, si elle est en vente, avec son titre. */
  private async publishedListing(networkId: string, agentId: string, propertyId: string): Promise<{ seq: number; title: string } | null> {
    const v = await this.db.first<{ seq: number; state: string; payload: string }>(
      `SELECT v.seq, v.state, v.payload FROM listing_versions v JOIN properties p ON p.id = v.property_id
        WHERE v.property_id = ? AND p.agent_id = ? AND p.network_id = ? AND v.network_id = p.network_id
        ORDER BY v.seq DESC LIMIT 1`,
      [propertyId, agentId, networkId],
    );
    if (!v || v.state !== 'en_vente') return null;
    try {
      const payload = JSON.parse(v.payload) as { title?: unknown; body?: unknown; mentions?: unknown };
      if (typeof payload.title !== 'string' || payload.title.trim() === '' || typeof payload.mentions !== 'string' || payload.mentions === '' || typeof payload.body !== 'string' || payload.body === '') return null;
      return { seq: Number(v.seq), title: payload.title };
    } catch {
      return null;
    }
  }

  /**
   * Les biens à publier sur la fiche de l'agent : ses biens en vente jamais publiés sur la fiche, au plus un par
   * période. Le planificateur prépare le premier ; l'agent valide.
   */
  async duePost(networkId: string, agentId: string): Promise<{ ok: true; value: GbpDraft | null } | GbpRefusal> {
    const loc = await this.location(networkId, agentId);
    if (!loc) return { ok: false, rule: null, code: 'sans_fiche' };
    const agent = await this.db.first<{ first_name: string; status: string }>('SELECT first_name, status FROM agents WHERE id = ? AND network_id = ?', [agentId, networkId]);
    if (!agent || agent.status !== 'active') return { ok: true, value: null };
    const since = new Date(this.now().getTime() - this.postEveryDays * 86_400_000).toISOString();
    const recent = await this.db.first<{ n: number }>("SELECT count(*) AS n FROM gbp_drafts WHERE network_id = ? AND agent_id = ? AND kind = 'publication' AND created_at > ?", [networkId, agentId, since]);
    if (Number(recent?.n) > 0) return { ok: true, value: null };
    const candidates = await this.db.all<{ id: string }>(
      `SELECT p.id FROM properties p WHERE p.agent_id = ? AND p.network_id = ?
          AND NOT EXISTS (SELECT 1 FROM gbp_drafts d WHERE d.property_id = p.id AND d.kind = 'publication')
        ORDER BY p.id`,
      [agentId, networkId],
    );
    const ctx = await this.context(networkId, 'publication', [], signatureOf(agent.first_name));
    for (const c of candidates) {
      const listing = await this.publishedListing(networkId, agentId, c.id);
      if (!listing) continue;
      const body = listingPostText(listing.title, agent.first_name);
      // Un titre qui ne passe pas le contrôle n'est pas publié ; c'est noté, sans le texte.
      const problems = await checkGbpText(body, ctx, networkId);
      if (problems.length > 0) {
        await appendEvent(this.journal, { type: 'attirer.google.texte_refuse', actor: 'system:fiche_google', subject: `property:${c.id}`, data: { rule: 'R154', problems } }, this.now);
        continue;
      }
      const linkUri = `${loc.websiteUri.replace(/\/+$/, '')}/biens/${encodeURIComponent(c.id)}`;
      return { ok: true, value: await this.store(networkId, agentId, { kind: 'publication', reviewId: null, propertyId: c.id, listingSeq: listing.seq, body, linkUri, origin: 'code' }, 'system:fiche_google') };
    }
    return { ok: true, value: null };
  }

  private async draftRow(networkId: string, draftId: unknown): Promise<DraftRow | null> {
    if (typeof draftId !== 'string') return null;
    return this.db.first<DraftRow>(`${DRAFT_SELECT} WHERE d.id = ? AND d.network_id = ?`, [draftId, networkId]);
  }

  /** Le texte vaut-il encore : dernier texte préparé pour son avis ou son bien, contrôle passé, bien encore en vente. */
  private async stillValid(row: DraftRow): Promise<GbpRefusal | null> {
    const latest = await this.db.first<{ id: string }>(
      row.kind === 'reponse'
        ? 'SELECT id FROM gbp_drafts WHERE review_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1'
        : "SELECT id FROM gbp_drafts WHERE property_id = ? AND kind = 'publication' ORDER BY created_at DESC, rowid DESC LIMIT 1",
      [row.kind === 'reponse' ? row.review_id : row.property_id],
    );
    if (latest?.id !== row.id) return { ok: false, rule: 'R154', code: 'texte_change' };
    let hashes: string[] = [];
    if (row.kind === 'reponse') {
      const r = await this.db.first<{ author_token_hashes: string }>('SELECT author_token_hashes FROM gbp_reviews WHERE id = ?', [row.review_id]);
      hashes = JSON.parse(r!.author_token_hashes) as string[];
    } else {
      const listing = await this.publishedListing(row.network_id, row.agent_id, row.property_id!);
      if (!listing || listing.seq !== Number(row.listing_seq)) return { ok: false, rule: 'R154', code: 'bien_retire' };
    }
    const agent = await this.db.first<{ first_name: string }>('SELECT first_name FROM agents WHERE id = ? AND network_id = ?', [row.agent_id, row.network_id]);
    const problems = await checkGbpText(row.body, await this.context(row.network_id, row.kind, hashes, agent ? signatureOf(agent.first_name) : null), row.network_id);
    if (problems.length > 0) return { ok: false, rule: 'R154', code: 'texte_refuse', problems };
    return null;
  }

  /** La validation nommée du texte exact, par l'agent de la fiche ou la direction [R154]. */
  async validate(viewer: Viewer, draftId: unknown): Promise<{ ok: true; value: GbpDraft } | GbpRefusal> {
    const row = await this.draftRow(viewer.networkId, draftId);
    if (!row) return this.refuse(viewer, `network:${viewer.networkId}`, 'inconnu');
    const allowed = await this.allowed(viewer, row.agent_id);
    if (!allowed.ok) return allowed;
    if (row.validated_at) return { ok: false, rule: 'R154', code: 'deja_valide' };
    const invalid = await this.stillValid(row);
    if (invalid) return invalid;
    try {
      await this.db.run('INSERT INTO gbp_validations (draft_id, text_sha256, validated_by, validated_at) VALUES (?, ?, ?, ?)', [row.id, await textHash(row), this.actor(viewer), this.now().toISOString()]);
    } catch (error) {
      if (/UNIQUE|PRIMARY/i.test(String(error))) return { ok: false, rule: 'R154', code: 'deja_valide' };
      throw error;
    }
    await appendEvent(this.journal, { type: 'attirer.google.texte_valide', actor: this.actor(viewer), subject: `agent:${row.agent_id}`, data: { rule: 'R154', kind: row.kind } }, this.now);
    return { ok: true, value: toDraft((await this.draftRow(viewer.networkId, row.id))!) };
  }

  /**
   * Fait partir un texte validé : sa validation nommée doit porter sur le texte exact, qui est recontrôlé. En mode
   * essai, rien ne part, l'envoi est seulement noté [R26, R154].
   */
  async publish(viewer: Viewer, draftId: unknown): Promise<{ ok: true; mode: 'essai' | 'reel' } | GbpRefusal> {
    const row = await this.draftRow(viewer.networkId, draftId);
    if (!row) return this.refuse(viewer, `network:${viewer.networkId}`, 'inconnu');
    const allowed = await this.allowed(viewer, row.agent_id);
    if (!allowed.ok) return allowed;
    if (!row.validated_at || !row.validated_by) return { ok: false, rule: 'R154', code: 'non_valide' };
    if (row.text_sha256 !== (await textHash(row))) return { ok: false, rule: 'R154', code: 'texte_change' };
    const sent = await this.db.first<{ id: string }>("SELECT id FROM gbp_sends WHERE draft_id = ? AND outcome IN ('essai', 'envoye')", [row.id]);
    if (sent) return { ok: false, rule: 'R154', code: 'deja_parti' };
    const invalid = await this.stillValid(row);
    if (invalid) return invalid;
    if (row.kind === 'reponse') {
      const answered = await this.db.first<{ id: string }>(
        "SELECT s.id FROM gbp_sends s JOIN gbp_drafts d ON d.id = s.draft_id WHERE d.review_id = ? AND s.outcome IN ('essai', 'envoye') AND s.mode = ?",
        [row.review_id, this.mode],
      );
      if (answered) return { ok: false, rule: 'R154', code: 'deja_parti' };
    }
    const loc = await this.location(row.network_id, row.agent_id);
    if (!loc) return { ok: false, rule: null, code: 'sans_fiche' };
    if (this.mode === 'reel' && !this.client) return { ok: false, rule: null, code: 'sans_service' };
    // La réservation, avant d'appeler Google : une seule demande passe pour ce texte, et pour un avis, une seule réponse.
    const target = row.kind === 'reponse' ? `review:${row.review_id}` : `draft:${row.id}`;
    const failed = await this.db.first<{ n: number }>(
      row.kind === 'reponse'
        ? "SELECT count(*) AS n FROM gbp_sends s JOIN gbp_drafts d ON d.id = s.draft_id WHERE d.review_id = ? AND s.mode = ? AND s.outcome = 'echec'"
        : "SELECT count(*) AS n FROM gbp_sends WHERE draft_id = ? AND mode = ? AND outcome = 'echec'",
      [row.kind === 'reponse' ? row.review_id : row.id, this.mode],
    );
    try {
      await this.db.run('INSERT INTO gbp_claims (id, network_id, draft_id, target, mode, attempt, claimed_by, claimed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [
        this.newId(), row.network_id, row.id, target, this.mode, Number(failed?.n ?? 0) + 1, this.actor(viewer), this.now().toISOString(),
      ]);
    } catch (error) {
      if (/UNIQUE/i.test(String(error))) return { ok: false, rule: 'R154', code: 'deja_parti' };
      throw error;
    }
    const reviewRef =
      row.kind === 'reponse' ? (await this.db.first<{ review_ref: string }>('SELECT review_ref FROM gbp_reviews WHERE id = ?', [row.review_id]))!.review_ref : null;
    const outcome = await this.callGoogle(() =>
      row.kind === 'reponse' ? this.client!.replyToReview(loc.locationRef, reviewRef!, row.body) : this.client!.createPost(loc.locationRef, { text: row.body, linkUri: row.link_uri! }),
    );
    if (outcome === 'sans_service') return { ok: false, rule: null, code: 'sans_service' };
    try {
      await this.db.run('INSERT INTO gbp_sends (id, network_id, agent_id, draft_id, kind, info_sha256, mode, outcome, sent_by, sent_at) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)', [
        this.newId(), row.network_id, row.agent_id, row.id, row.kind, this.mode, outcome, this.actor(viewer), this.now().toISOString(),
      ]);
    } catch (error) {
      if (/UNIQUE/i.test(String(error))) return { ok: false, rule: 'R154', code: 'deja_parti' };
      throw error;
    }
    await appendEvent(this.journal, { type: 'attirer.google.envoi', actor: this.actor(viewer), subject: `agent:${row.agent_id}`, data: { rule: 'R154', kind: row.kind, mode: this.mode, outcome, validatedBy: row.validated_by } }, this.now);
    if (outcome === 'echec') return { ok: false, rule: null, code: 'echec' };
    return { ok: true, mode: this.mode };
  }

  /** Les avis de la fiche et leurs textes préparés, pour l'agent ou la direction. Jamais le nom de l'auteur : il n'est pas gardé. */
  async reviews(viewer: Viewer, agentId: string): Promise<{ ok: true; value: { reviewId: string; rating: number; comment: string | null; reviewedAt: string; drafts: GbpDraft[] }[] } | GbpRefusal> {
    const allowed = await this.allowed(viewer, agentId);
    if (!allowed.ok) return allowed;
    const rows = await this.db.all<{ id: string; rating: number; comment: string | null; reviewed_at: string }>(
      'SELECT id, rating, comment, reviewed_at FROM gbp_reviews WHERE network_id = ? AND agent_id = ? ORDER BY reviewed_at DESC, id',
      [viewer.networkId, agentId],
    );
    const out = [];
    for (const r of rows) {
      const drafts = await this.db.all<DraftRow>(`${DRAFT_SELECT} WHERE d.review_id = ? ORDER BY d.created_at, d.rowid`, [r.id]);
      out.push({ reviewId: r.id, rating: Number(r.rating), comment: r.comment, reviewedAt: r.reviewed_at, drafts: drafts.map(toDraft) });
    }
    return { ok: true, value: out };
  }
}
