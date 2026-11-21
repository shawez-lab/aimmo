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
import { Acces } from '../acces/acces.ts';
import type { Viewer } from '../acces/droits.ts';
import type { DiffusionGate } from '../acquereurs/rapprochement.ts';
import { FicheClient } from '../db/fiche-client.ts';
import { Diffusion } from '../documents/retractation.ts';
import { FicheUnique } from '../fiche/fusion.ts';
import { runBatch, type SqlDatabase, type SqlStatement } from '../db/sql.ts';
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

/**
 * L'accusé que Google rend pour un envoi réussi (AU037) : la référence de ce qu'il a rangé (la réponse, la publication,
 * la fiche) et, pour une publication, son lien public. Sans accusé lisible, rien n'est dit « envoyé ».
 */
export interface GbpAck {
  ref: string;
  url?: string | null;
}

/** Pourquoi un envoi réel a échoué, en liste fermée : jamais le texte de Google [R13]. */
export type GbpErrorCode = 'connexion' | 'droits' | 'fiche_introuvable' | 'refuse_google' | 'limite' | 'panne' | 'accuse_absent';
/** Le geste qui règle l'échec : reconnecter le compte Google, relier la fiche, corriger le texte, réessayer, vérifier sur Google. */
export type GbpAction = 'reconnecter' | 'relier' | 'corriger' | 'reessayer' | 'verifier';

export const GBP_ERROR_ACTIONS: Readonly<Record<GbpErrorCode, GbpAction>> = {
  connexion: 'reconnecter',
  droits: 'relier',
  fiche_introuvable: 'relier',
  refuse_google: 'corriger',
  limite: 'reessayer',
  panne: 'reessayer',
  accuse_absent: 'verifier',
};

/**
 * L'erreur qu'un vrai client Google lève. `incertain` : la demande est partie et sa réponse s'est perdue (délai, coupure,
 * panne de Google) : une publication a pu être faite, elle n'est jamais refaite d'elle-même.
 */
export class GbpError extends Error {
  constructor(readonly code: GbpErrorCode | 'incertain') {
    super(`fiche Google : ${code}`);
    this.name = 'GbpError';
  }
}

/** L'API Google Business Profile, réduite à ce qu'AIMMO fait : aucune méthode pour écrire un avis [R64]. */
export interface GbpClient {
  listReviews(locationRef: string): Promise<GbpReview[]>;
  replyToReview(locationRef: string, reviewRef: string, text: string): Promise<GbpAck>;
  createPost(locationRef: string, post: { text: string; linkUri: string }): Promise<GbpAck>;
  updateInfo(locationRef: string, info: GbpInfo): Promise<GbpAck>;
}

/** Ce que l'IA reçoit pour proposer une réponse : la note, le texte de l'avis et le prénom de l'agent, rien d'autre. */
export interface ReviewReplyWriter {
  write(input: { rating: number; comment: string | null; agentFirstName: string }): Promise<string>;
}

export type GbpProblem = 'nom' | 'adresse' | 'montant' | 'dossier' | 'coordonnee' | 'contrepartie' | 'vocabulaire' | 'ia' | 'temoignage' | 'longueur' | 'vide';

export type GbpRefusal =
  | { ok: false; rule: 'R16'; code: 'role' | 'agent_inconnu' | 'agent_parti' | 'inconnu' }
  | { ok: false; rule: 'R154'; code: 'texte_refuse'; problems: GbpProblem[] }
  | { ok: false; rule: 'R154'; code: 'non_valide' | 'texte_change' | 'deja_valide' | 'deja_parti' | 'bien_retire' | 'deja_publie' | 'trop_tot' }
  | { ok: false; rule: null; code: 'sans_fiche' | 'invalide' | 'occupe' | 'sans_service' }
  /** Un envoi réel refusé ou en panne chez Google : son code et le geste qui le règle (AU037). */
  | { ok: false; rule: null; code: 'echec'; error: GbpErrorCode; action: GbpAction }
  /** La réponse de Google s'est perdue : la publication a pu être faite, à vérifier sur la fiche avant tout nouvel essai. */
  | { ok: false; rule: null; code: 'a_verifier'; action: 'verifier' };

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

/**
 * Où en est un texte, dit par le code pour l'écran (AT14) : l'écran n'en déduit rien, il montre le mot et ses gestes.
 * `note_essai` : validé et noté, rien n'est parti [R26] ; `envoi_coupe` : une réservation sans résultat depuis plus d'une
 * heure, que seule la direction peut clore après avoir regardé la fiche Google.
 */
export type GbpDraftState = 'a_valider' | 'a_envoyer' | 'envoi_en_cours' | 'envoi_coupe' | 'echec' | 'note_essai' | 'envoye' | 'bien_retire' | 'texte_a_revoir';

export interface GbpScreenDraft {
  draftId: string;
  body: string;
  linkUri: string | null;
  origin: GbpDraft['origin'];
  validatedAt: string | null;
  state: GbpDraftState;
  /** L'accusé de Google d'un envoi réel réussi (AU037) ; sinon `null`. */
  ackRef: string | null;
  url: string | null;
  /** Le dernier échec réel et son geste, tant que le texte n'est pas parti ; sinon `null`. */
  error: GbpErrorCode | null;
  action: GbpAction | null;
}

/**
 * La liaison avec Google, dite par le code depuis le dernier envoi réel (AU037) : `essai` tant que rien de réel n'est
 * en service, `sans_service` sans client, `a_reconnecter` quand Google refuse la connexion, `a_relier` quand la fiche
 * n'est pas (ou plus) accessible au compte, `pret` sinon.
 */
export interface GbpLink {
  state: 'essai' | 'sans_service' | 'pret' | 'a_reconnecter' | 'a_relier';
  action: GbpAction | null;
  /** Le dernier envoi des informations de la fiche : quand, et l'accusé ou l'échec de Google. */
  info: { at: string; ackRef: string | null; error: GbpErrorCode | null; action: GbpAction | null } | null;
}

/** Ce que l'écran de la fiche Google montre, pour l'agent de la fiche ou la direction [R16]. */
export interface GbpScreen {
  agentId: string;
  agentFirstName: string;
  /** Vrai seulement si l'interface Google existe (H07) : sinon l'écran le dit, sans erreur. */
  connected: boolean;
  mode: 'essai' | 'reel';
  link: GbpLink;
  /** Seule la direction règle la fiche et clôt un envoi coupé. */
  canConfigure: boolean;
  location: Location | null;
  reviewsTotal: number;
  reviewsWaiting: number;
  reviews: { reviewId: string; rating: number; comment: string | null; reviewedAt: string; draft: GbpScreenDraft | null }[];
  publications: GbpScreenDraft[];
}

const MAX_TEXT = 1500;
const CLAIM_RELEASE_MS = 3_600_000;
const SCREEN_REVIEWS = 50;
const SCREEN_POSTS = 20;
const AI_TIMEOUT_MS = 20_000;

/* ---------- Le contrôle des textes ---------- */

/** Un mot sans accent, en minuscules. */
export const foldWord = (w: string): string => w.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const words = (text: string): string[] => text.split(/[^\p{L}]+/u).filter((w) => w.length >= 2);

// Une voie sans ambiguïté, suivie de n'importe quel nom, en majuscules ou non (« rue de la paix », « Rue Monge »).
const STREET = /\b(?:rue|avenue|av\.|boulevard|bd|impasse|all[ée]e(?!\s+(?:priv|centrale|de\s+(?:garage|jardin)))|faubourg)\s+(?:(?:de\s+la|de\s+l['’]|du|des|de|d['’])\s*)?\p{L}{2,}/iu;
// Un mot qui est aussi un mot courant (« mise en place », « en cours ») : voie seulement devant un nom propre.
const STREET_PROPER_NAME = /\b(?:[Cc]hemin|[Pp]lace|[Qq]uai|[Rr]oute|[Ss]quare|[Cc]ours|[Pp]assage|[Ll]otissement|[Rr][ée]sidence)\s+(?:(?:de\s+la|de\s+l['’]|du|des|de|d['’])\s*)?\p{Lu}/u;
const NUMBERED_STREET = /\b\d{1,4}\s*(?:bis|ter)?\s*,?\s*(?:rue|avenue|av\.|boulevard|bd|chemin|all[ée]e|impasse|place|quai|route|square|cours|passage|faubourg|lotissement|r[ée]sidence|hameau|lieu-dit|cit[ée])(?![\p{L}])/iu;
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
  /** Les noms de famille de deux lettres, refusés seulement écrits comme un nom propre. */
  clientShortNames?: ReadonlySet<string>;
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
  for (const w of words(body)) {
    const folded = foldWord(w);
    // Le nom de l'auteur, écrit de n'importe quelle façon, même s'il est aussi celui d'un agent.
    if (authors.size > 0 && authors.has(await sha256Hex(`gbp-auteur:${networkId}:${folded}`))) problems.add('nom');
    // Un prénom ou un nom de famille d'un client de la base, écrit de n'importe quelle façon.
    if (ctx.clientLastNames.has(folded) || ctx.clientFirstNames.has(folded)) problems.add('nom');
    // Un nom de deux lettres, seulement écrit comme un nom propre.
    if (ctx.clientShortNames?.has(folded) && /^\p{Lu}/u.test(w)) problems.add('nom');
  }
  return [...problems].sort();
}

const REDACT_STREETS = [STREET, STREET_PROPER_NAME, NUMBERED_STREET];
const REDACT_OTHERS = [CONTACT, AMOUNT];
const global = (re: RegExp, tail = ''): RegExp => new RegExp(`${re.source}${tail}`, re.flags.includes('g') ? re.flags : `${re.flags}g`);

/**
 * Le texte d'un avis tel que l'IA le reçoit : sans le nom de son auteur ni d'un client de la base, sans adresse, sans
 * coordonnée ni montant, remplacés par « … ». L'IA n'en a pas besoin pour proposer une réponse [R46].
 */
export async function redactForAi(comment: string, ctx: TextContext, networkId: string): Promise<string> {
  let out = comment;
  // Une voie, et les mots qui suivent jusqu'à la ponctuation (son nom) ; une coordonnée ou un montant seuls.
  for (const re of REDACT_STREETS) out = out.replace(global(re, "[\\p{L}'’-]*(?:\\s+[\\p{L}'’-]+){0,3}"), '…');
  for (const re of REDACT_OTHERS) out = out.replace(global(re), '…');
  const authors = new Set(ctx.authorTokenHashes);
  const parts = out.split(/([^\p{L}]+)/u);
  for (let i = 0; i < parts.length; i++) {
    const w = parts[i]!;
    if (w.length < 2 || !/^\p{L}+$/u.test(w)) continue;
    const f = foldWord(w);
    if (authors.has(await sha256Hex(`gbp-auteur:${networkId}:${f}`)) || ctx.clientFirstNames.has(f) || ctx.clientLastNames.has(f) || (ctx.clientShortNames?.has(f) && /^\p{Lu}/u.test(w))) parts[i] = '…';
  }
  return parts.join('');
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

/* ---------- Les accusés de Google (AU037) ---------- */

type GoogleResult =
  | { outcome: 'essai' }
  | { outcome: 'sans_service' }
  | { outcome: 'envoye'; ack: { ref: string; url: string | null } }
  | { outcome: 'echec'; error: GbpErrorCode; action: GbpAction }
  | { outcome: 'incertain' };

/** Ce que le journal garde d'un échec : son code et son geste, jamais le texte de Google [R13]. */
const errorData = (r: GoogleResult): Record<string, string> => (r.outcome === 'echec' ? { error: r.error, action: r.action } : {});

/** L'accusé lu tel que Google l'a rendu : une référence imprimable, et un lien en https seulement ; sinon `null`. */
export function readAck(answer: unknown): { ref: string; url: string | null } | null {
  if (answer === null || typeof answer !== 'object') return null;
  const { ref, url } = answer as { ref?: unknown; url?: unknown };
  if (typeof ref !== 'string' || !/^[\x21-\x7e]{3,300}$/.test(ref)) return null;
  let link: string | null = null;
  if (typeof url === 'string' && url.length <= 500) {
    try {
      const u = new URL(url);
      if (u.protocol === 'https:' && u.username === '' && u.password === '') link = u.toString();
    } catch {
      link = null;
    }
  }
  return { ref, url: link };
}

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
  /** La porte de toute diffusion d'un bien : mandat en vigueur, hors délai de rétractation [R42]. */
  diffusion?: DiffusionGate;
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
  private readonly gate: DiffusionGate;

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
    if (options.diffusion) this.gate = options.diffusion;
    else {
      const store = new FicheClient(db, { now: this.now });
      this.gate = new Diffusion(db, new Acces(db, store, new FicheUnique(db, store, { now: this.now }), journal, { now: this.now }), journal, { now: this.now });
    }
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
    const clientShortNames = new Set<string>();
    for (const p of await this.db.all<{ first_name: string | null; last_name: string | null }>('SELECT DISTINCT first_name, last_name FROM person_known_names WHERE network_id = ?', [networkId])) {
      for (const w of words(p.first_name ?? '')) clientFirstNames.add(foldWord(w));
      // Une particule (« Le Goff », « Da Silva ») n'est pas un nom ; un nom de deux lettres n'est lu que comme un nom propre.
      for (const w of words(p.last_name ?? '')) {
        const f = foldWord(w);
        if (PARTICLES.has(f)) continue;
        (f.length >= 3 ? clientLastNames : clientShortNames).add(f);
      }
    }
    return { kind, authorTokenHashes, clientFirstNames, clientLastNames, clientShortNames, signature };
  }

  /** La fiche Google d'un agent, réglée par la direction. Chaque réglage s'ajoute. */
  async setLocation(viewer: Viewer, agentId: string, input: { locationRef: unknown; title: unknown; websiteUri: unknown }): Promise<{ ok: true } | GbpRefusal> {
    if (viewer.role !== 'direction') return this.refuse(viewer, `agent:${agentId}`, 'role');
    const allowed = await this.allowed(viewer, agentId);
    if (!allowed.ok) return allowed;
    const ref = typeof input.locationRef === 'string' ? input.locationRef.trim() : '';
    const title = typeof input.title === 'string' ? input.title.trim() : '';
    const site = typeof input.websiteUri === 'string' ? input.websiteUri.trim() : '';
    // AU037 : la référence complète (`accounts/…/locations/…`), qu'il faut à Google pour les avis et les publications.
    if (!/^(?:accounts\/[0-9]{1,30}\/)?locations\/[A-Za-z0-9_-]{1,150}$/.test(ref) || title.length < 2 || title.length > 100 || /[<>]/.test(title) || !/^https:\/\/[^\s"'<>]{4,290}$/.test(site)) return { ok: false, rule: null, code: 'invalide' };
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
    // Le lieu de destination compte aussi : une fiche nouvellement réglée reçoit ses informations même inchangées.
    const hash = await sha256Hex(JSON.stringify({ to: loc.locationRef, info }));
    const last = await this.db.first<{ info_sha256: string }>(
      "SELECT info_sha256 FROM gbp_sends WHERE network_id = ? AND agent_id = ? AND kind = 'informations' AND outcome IN ('essai', 'envoye') AND mode = ? ORDER BY sent_at DESC, rowid DESC LIMIT 1",
      [networkId, agentId, this.mode],
    );
    if (last?.info_sha256 === hash) return { ok: true, changed: false, mode: this.mode };
    // La mise à jour de la fiche se refait sans risque : une réponse perdue est un échec à réessayer.
    const result = await this.callGoogle(() => this.client!.updateInfo(loc.locationRef, info), true);
    if (result.outcome === 'sans_service') return { ok: false, rule: null, code: 'sans_service' };
    const outcome = result.outcome === 'incertain' ? 'echec' : result.outcome;
    const sendId = this.newId();
    // L'envoi et son accusé (ou son échec) s'écrivent ensemble, tout ou rien : jamais un « envoyé » sans sa preuve.
    await runBatch(this.db, [
      { sql: "INSERT INTO gbp_sends (id, network_id, agent_id, draft_id, kind, info_sha256, mode, outcome, sent_by, sent_at) VALUES (?, ?, ?, NULL, 'informations', ?, ?, ?, 'system:fiche_google', ?)", params: [sendId, networkId, agentId, hash, this.mode, outcome, this.now().toISOString()] },
      ...this.receipt(sendId, result),
    ]);
    await appendEvent(this.journal, { type: 'attirer.google.informations', actor: 'system:fiche_google', subject: `agent:${agentId}`, data: { rule: 'R26', mode: this.mode, outcome, ...errorData(result) } }, this.now);
    if (result.outcome === 'echec') return { ok: false, rule: null, code: 'echec', error: result.error, action: result.action };
    return { ok: true, changed: true, mode: this.mode };
  }

  /**
   * En mode essai, l'interface n'est jamais appelée pour écrire [R26]. Une panne est notée, jamais avalée. En mode réel,
   * seul un accusé lisible de Google fait dire « envoyé » ; un échec porte son code et son geste (AU037). `replayable` :
   * l'appel se refait sans risque (réponse à un avis, informations), une réponse perdue est alors un échec à réessayer ;
   * sinon (publication) elle est `incertain`, jamais refaite d'elle-même.
   */
  private async callGoogle(call: () => Promise<GbpAck>, replayable: boolean): Promise<GoogleResult> {
    if (this.mode === 'essai') return { outcome: 'essai' };
    if (!this.client) return { outcome: 'sans_service' };
    let answer: unknown;
    try {
      answer = await call();
    } catch (error) {
      const code = error instanceof GbpError ? error.code : 'panne';
      if (code === 'incertain') return replayable ? { outcome: 'echec', error: 'panne', action: 'reessayer' } : { outcome: 'incertain' };
      return { outcome: 'echec', error: code, action: GBP_ERROR_ACTIONS[code] };
    }
    const ack = readAck(answer);
    if (!ack) return replayable ? { outcome: 'echec', error: 'accuse_absent', action: 'verifier' } : { outcome: 'incertain' };
    return { outcome: 'envoye', ack };
  }

  /** L'accusé ou l'échec d'un envoi réel, écrit dans le même lot que l'envoi ; un essai n'en a pas [R26]. */
  private receipt(sendId: string, result: GoogleResult): SqlStatement[] {
    if (result.outcome === 'envoye') {
      return [{ sql: 'INSERT INTO gbp_receipts (send_id, ack_ref, url, error_code, action, done_at) VALUES (?, ?, ?, NULL, NULL, ?)', params: [sendId, result.ack.ref, result.ack.url, this.now().toISOString()] }];
    }
    if (result.outcome === 'echec') {
      return [{ sql: 'INSERT INTO gbp_receipts (send_id, ack_ref, url, error_code, action, done_at) VALUES (?, NULL, NULL, ?, ?, ?)', params: [sendId, result.error, result.action, this.now().toISOString()] }];
    }
    return [];
  }

  /** Les avis de la fiche, lus par l'interface et rangés sans le nom de leur auteur. Un avis déjà lu n'est pas repris. */
  async importReviews(networkId: string, agentId: string): Promise<{ ok: true; added: number } | GbpRefusal> {
    const loc = await this.location(networkId, agentId);
    if (!loc) return { ok: false, rule: null, code: 'sans_fiche' };
    if (!this.client) return { ok: false, rule: null, code: 'sans_service' };
    let reviews: GbpReview[];
    try {
      reviews = await this.client.listReviews(loc.locationRef);
    } catch (error) {
      // La lecture se refait sans risque : une réponse perdue est une panne à réessayer. Le code et le geste sont dits.
      const code: GbpErrorCode = error instanceof GbpError && error.code !== 'incertain' ? error.code : 'panne';
      const action = GBP_ERROR_ACTIONS[code];
      await appendEvent(this.journal, { type: 'attirer.google.avis_illisibles', actor: 'system:fiche_google', subject: `agent:${agentId}`, data: { error: code, action } }, this.now);
      return { ok: false, rule: null, code: 'echec', error: code, action };
    }
    let added = 0;
    const base = await this.context(networkId, 'reponse', [], null);
    for (const r of reviews) {
      const rating = Number(r.rating);
      if (typeof r.reviewRef !== 'string' || r.reviewRef.length < 3 || r.reviewRef.length > 300 || !Number.isInteger(rating) || rating < 1 || rating > 5 || typeof r.reviewedAt !== 'string' || Number.isNaN(Date.parse(r.reviewedAt))) continue;
      const hashes = await nameTokenHashes(typeof r.authorName === 'string' ? r.authorName : null, networkId);
      // L'avis est gardé nettoyé : sans le nom de son auteur ni d'un client, sans adresse, coordonnée ni montant. Il ne
      // désigne plus personne, ce qui le tient hors des demandes d'accès à bon droit [R96, R46].
      const raw = typeof r.comment === 'string' && r.comment.trim() !== '' ? r.comment.trim().slice(0, 4096) : null;
      const comment = raw === null ? null : (await redactForAi(raw, { ...base, authorTokenHashes: hashes }, networkId)).slice(0, 4096);
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
    const proposed = await this.askWriter({ rating, comment: review.comment === null ? null : await redactForAi(review.comment, ctx, viewer.networkId), agentFirstName: allowed.firstName });
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
    // La version publiée ne suffit pas : le mandat doit permettre la diffusion maintenant [R42].
    if (!(await this.gate.canDiffuse(networkId, propertyId, this.now())).allowed) return null;
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
    // Jamais un bien déjà publié sur la fiche ; un texte en attente pour la version en cours n'est pas doublé, un texte
    // périmé (le bien a une nouvelle version) jamais parti est remplacé.
    const candidates = await this.db.all<{ id: string; pending_seq: number | null }>(
      `SELECT p.id, (SELECT d.listing_seq FROM gbp_drafts d WHERE d.property_id = p.id AND d.kind = 'publication' ORDER BY d.created_at DESC, d.rowid DESC LIMIT 1) AS pending_seq
         FROM properties p WHERE p.agent_id = ? AND p.network_id = ?
          AND NOT EXISTS (SELECT 1 FROM gbp_sends s JOIN gbp_drafts d ON d.id = s.draft_id WHERE d.property_id = p.id AND s.kind = 'publication' AND s.mode = ? AND s.outcome IN ('essai', 'envoye'))
        ORDER BY p.id`,
      [agentId, networkId, this.mode],
    );
    const ctx = await this.context(networkId, 'publication', [], signatureOf(agent.first_name));
    for (const c of candidates) {
      const listing = await this.publishedListing(networkId, agentId, c.id);
      if (!listing || (c.pending_seq !== null && Number(c.pending_seq) === listing.seq)) continue;
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
    const r = await this.tryPublish(viewer, draftId);
    // Chaque refus d'envoi est écrit au journal avec sa règle, sans le texte [R13] ; un refus d'accès l'est déjà.
    if (!r.ok && r.rule !== 'R16') {
      await appendEvent(
        this.journal,
        { type: 'attirer.google.envoi_refuse', actor: this.actor(viewer), subject: `network:${viewer.networkId}`, data: { rule: r.rule ?? 'R154', code: r.code, mode: this.mode, ...('problems' in r ? { problems: r.problems } : {}) } },
        this.now,
      );
    }
    return r;
  }

  private async tryPublish(viewer: Viewer, draftId: unknown): Promise<{ ok: true; mode: 'essai' | 'reel' } | GbpRefusal> {
    const row = await this.draftRow(viewer.networkId, draftId);
    if (!row) return this.refuse(viewer, `network:${viewer.networkId}`, 'inconnu');
    const allowed = await this.allowed(viewer, row.agent_id);
    if (!allowed.ok) return allowed;
    if (!row.validated_at || !row.validated_by) return { ok: false, rule: 'R154', code: 'non_valide' };
    if (row.text_sha256 !== (await textHash(row))) return { ok: false, rule: 'R154', code: 'texte_change' };
    const sent = await this.db.first<{ id: string }>("SELECT id FROM gbp_sends WHERE draft_id = ? AND mode = ? AND outcome IN ('essai', 'envoye')", [row.id, this.mode]);
    if (sent) return { ok: false, rule: 'R154', code: 'deja_parti' };
    const invalid = await this.stillValid(row);
    if (invalid) return invalid;
    if (row.kind === 'reponse') {
      const answered = await this.db.first<{ id: string }>(
        "SELECT s.id FROM gbp_sends s JOIN gbp_drafts d ON d.id = s.draft_id WHERE d.review_id = ? AND s.outcome IN ('essai', 'envoye') AND s.mode = ?",
        [row.review_id, this.mode],
      );
      if (answered) return { ok: false, rule: 'R154', code: 'deja_parti' };
    } else {
      // Au plus une publication de bien par agent et par période, comptée au départ aussi : valider d'un coup des textes
      // en retard ne les fait pas partir ensemble.
      const since = new Date(this.now().getTime() - this.postEveryDays * 86_400_000).toISOString();
      const recent = await this.db.first<{ id: string }>(
        "SELECT id FROM gbp_sends WHERE network_id = ? AND agent_id = ? AND kind = 'publication' AND mode = ? AND outcome IN ('essai', 'envoye') AND sent_at > ? LIMIT 1",
        [row.network_id, row.agent_id, this.mode, since],
      );
      if (recent) return { ok: false, rule: 'R154', code: 'trop_tot' };
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
    // Une réponse à un avis remplace la précédente chez Google : elle se refait sans risque. Une publication, non.
    const result = await this.callGoogle(
      () => (row.kind === 'reponse' ? this.client!.replyToReview(loc.locationRef, reviewRef!, row.body) : this.client!.createPost(loc.locationRef, { text: row.body, linkUri: row.link_uri! })),
      row.kind === 'reponse',
    );
    if (result.outcome === 'sans_service') return { ok: false, rule: null, code: 'sans_service' };
    if (result.outcome === 'incertain') {
      // La réservation reste ouverte, sans résultat : rien ne repart avant que la direction ait regardé la fiche Google.
      await appendEvent(this.journal, { type: 'attirer.google.envoi', actor: this.actor(viewer), subject: `agent:${row.agent_id}`, data: { rule: 'R154', kind: row.kind, mode: this.mode, outcome: 'incertain', validatedBy: row.validated_by } }, this.now);
      return { ok: false, rule: null, code: 'a_verifier', action: 'verifier' };
    }
    const sendId = this.newId();
    try {
      // L'envoi et son accusé (ou son échec) s'écrivent ensemble, tout ou rien : jamais un « envoyé » sans sa preuve.
      await runBatch(this.db, [
        {
          sql: 'INSERT INTO gbp_sends (id, network_id, agent_id, draft_id, kind, info_sha256, mode, outcome, sent_by, sent_at) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)',
          params: [sendId, row.network_id, row.agent_id, row.id, row.kind, this.mode, result.outcome, this.actor(viewer), this.now().toISOString()],
        },
        ...this.receipt(sendId, result),
      ]);
    } catch (error) {
      if (/UNIQUE/i.test(String(error))) return { ok: false, rule: 'R154', code: 'deja_parti' };
      throw error;
    }
    await appendEvent(this.journal, { type: 'attirer.google.envoi', actor: this.actor(viewer), subject: `agent:${row.agent_id}`, data: { rule: 'R154', kind: row.kind, mode: this.mode, outcome: result.outcome, validatedBy: row.validated_by, ...errorData(result) } }, this.now);
    if (result.outcome === 'echec') return { ok: false, rule: null, code: 'echec', error: result.error, action: result.action };
    return { ok: true, mode: this.mode };
  }

  /**
   * Une réservation restée sans résultat (l'envoi a été coupé entre la réservation et la réponse de Google) bloque le
   * texte pour toujours. La direction, après avoir regardé la fiche Google, la clôt comme un échec : l'essai suivant
   * prend une nouvelle réservation. Jamais avant une heure, jamais sur une réservation qui a son résultat.
   */
  async releaseClaim(viewer: Viewer, draftId: unknown): Promise<{ ok: true } | GbpRefusal> {
    if (viewer.role !== 'direction') return this.refuse(viewer, `network:${viewer.networkId}`, 'role');
    const row = await this.draftRow(viewer.networkId, draftId);
    if (!row) return this.refuse(viewer, `network:${viewer.networkId}`, 'inconnu');
    const target = row.kind === 'reponse' ? `review:${row.review_id}` : `draft:${row.id}`;
    const claim = await this.db.first<{ draft_id: string; attempt: number; claimed_at: string }>(
      'SELECT draft_id, attempt, claimed_at FROM gbp_claims WHERE target = ? AND mode = ? ORDER BY attempt DESC LIMIT 1',
      [target, this.mode],
    );
    if (!claim) return { ok: false, rule: null, code: 'invalide' };
    const results = await this.db.first<{ n: number }>("SELECT count(*) AS n FROM gbp_sends WHERE draft_id = ? AND mode = ? AND sent_at >= ?", [claim.draft_id, this.mode, claim.claimed_at]);
    if (Number(results?.n) > 0) return { ok: false, rule: null, code: 'invalide' };
    if (this.now().getTime() - Date.parse(claim.claimed_at) < CLAIM_RELEASE_MS) return { ok: false, rule: null, code: 'occupe' };
    await this.db.run("INSERT INTO gbp_sends (id, network_id, agent_id, draft_id, kind, info_sha256, mode, outcome, sent_by, sent_at) VALUES (?, ?, ?, ?, ?, NULL, ?, 'echec', ?, ?)", [
      this.newId(), row.network_id, row.agent_id, claim.draft_id, row.kind, this.mode, this.actor(viewer), this.now().toISOString(),
    ]);
    await appendEvent(this.journal, { type: 'attirer.google.reservation_close', actor: this.actor(viewer), subject: `agent:${row.agent_id}`, data: { rule: 'R154', kind: row.kind, mode: this.mode, attempt: Number(claim.attempt) } }, this.now);
    return { ok: true };
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

  /** Lire les avis depuis l'écran : l'agent de la fiche ou la direction. Sans Google branché, c'est dit, sans erreur (H07). */
  async readReviews(viewer: Viewer, agentId: string): Promise<{ ok: true; added: number } | GbpRefusal> {
    const allowed = await this.allowed(viewer, agentId);
    if (!allowed.ok) return allowed;
    return this.importReviews(viewer.networkId, agentId);
  }

  /** Préparer la prochaine publication depuis l'écran, sous les mêmes limites que `duePost`. Rien de prêt : `null`. */
  async preparePost(viewer: Viewer, agentId: string): Promise<{ ok: true; value: GbpDraft | null } | GbpRefusal> {
    const allowed = await this.allowed(viewer, agentId);
    if (!allowed.ok) return allowed;
    return this.duePost(viewer.networkId, agentId);
  }

  /**
   * La liaison avec Google, lue sur les envois réels depuis le dernier qu'il a confirmé : un refus de connexion demande de
   * reconnecter le compte, un refus de droits ou une fiche introuvable demande de la relier, et cela tient jusqu'au
   * prochain envoi confirmé, même si une panne vient après (AU037).
   */
  private link(sends: readonly { kind: string; sent_at: string; ack_ref: string | null; error_code: GbpErrorCode | null; action: GbpAction | null }[]): GbpLink {
    const infos = sends.filter((x) => x.kind === 'informations');
    const lastInfo = infos[infos.length - 1];
    const info = this.mode === 'reel' && lastInfo ? { at: lastInfo.sent_at, ackRef: lastInfo.ack_ref, error: lastInfo.error_code, action: lastInfo.action } : null;
    if (this.mode === 'essai') return { state: 'essai', action: null, info: null };
    if (!this.client) return { state: 'sans_service', action: null, info };
    let lastAck = -1;
    sends.forEach((x, i) => {
      if (x.ack_ref !== null) lastAck = i;
    });
    const blocking = sends.slice(lastAck + 1).filter((x) => x.error_code === 'connexion' || x.error_code === 'droits' || x.error_code === 'fiche_introuvable');
    const last = blocking[blocking.length - 1];
    if (last?.error_code === 'connexion') return { state: 'a_reconnecter', action: 'reconnecter', info };
    if (last) return { state: 'a_relier', action: 'relier', info };
    return { state: 'pret', action: null, info };
  }

  /**
   * La mise à jour des informations de la fiche, demandée par la direction depuis l'écran (AU037) : en mode réel, elle
   * rend l'accusé de Google, ou l'échec avec le geste qui le règle ; en essai, rien ne part [R26].
   */
  async sendInfo(viewer: Viewer, agentId: string): Promise<{ ok: true; changed: boolean; mode: 'essai' | 'reel' } | GbpRefusal> {
    if (viewer.role !== 'direction') return this.refuse(viewer, `network:${viewer.networkId}`, 'role');
    const allowed = await this.allowed(viewer, agentId);
    if (!allowed.ok) return allowed;
    return this.syncInfo(viewer.networkId, agentId);
  }

  /** La fiche, ses avis et ses publications, chaque texte avec son état, décidé ici. Lecture seule. */
  async screen(viewer: Viewer, agentId: string): Promise<{ ok: true; value: GbpScreen } | GbpRefusal> {
    const allowed = await this.allowed(viewer, agentId);
    if (!allowed.ok) return allowed;
    const networkId = viewer.networkId;
    type SendRow = { draft_id: string | null; kind: string; outcome: 'essai' | 'envoye' | 'echec'; sent_at: string; ack_ref: string | null; url: string | null; error_code: GbpErrorCode | null; action: GbpAction | null };
    const all = await this.db.all<SendRow>(
      `SELECT s.draft_id, s.kind, s.outcome, s.sent_at, r.ack_ref, r.url, r.error_code, r.action
         FROM gbp_sends s LEFT JOIN gbp_receipts r ON r.send_id = s.id
        WHERE s.network_id = ? AND s.agent_id = ? AND s.mode = ? ORDER BY s.sent_at, s.rowid`,
      [networkId, agentId, this.mode],
    );
    const sends = all.filter((x): x is SendRow & { draft_id: string } => x.draft_id !== null);
    const sendsOf = new Map<string, SendRow[]>();
    for (const x of sends) sendsOf.set(x.draft_id, [...(sendsOf.get(x.draft_id) ?? []), x]);
    const departedSend = (draftId: string): SendRow | null => sendsOf.get(draftId)?.find((x) => x.outcome !== 'echec') ?? null;
    const departed = (draftId: string): string | null => departedSend(draftId)?.outcome ?? null;
    const claims = await this.db.all<{ draft_id: string; target: string; claimed_at: string }>(
      'SELECT c.draft_id, c.target, c.claimed_at FROM gbp_claims c JOIN gbp_drafts d ON d.id = c.draft_id WHERE c.network_id = ? AND d.agent_id = ? AND c.mode = ? ORDER BY c.attempt',
      [networkId, agentId, this.mode],
    );
    const lastClaim = new Map(claims.map((c) => [c.target, c]));
    const stateOf = async (row: DraftRow): Promise<GbpDraftState> => {
      const gone = departed(row.id);
      if (gone) return gone === 'essai' ? 'note_essai' : 'envoye';
      const claim = lastClaim.get(row.kind === 'reponse' ? `review:${row.review_id}` : `draft:${row.id}`);
      if (claim && !(sendsOf.get(claim.draft_id) ?? []).some((x) => x.sent_at >= claim.claimed_at)) {
        return this.now().getTime() - Date.parse(claim.claimed_at) < CLAIM_RELEASE_MS ? 'envoi_en_cours' : 'envoi_coupe';
      }
      if (row.kind === 'publication') {
        // Une publication s'écrit depuis l'annonce, sans correction à la main : un texte devenu refusé ne repart qu'avec une nouvelle annonce.
        const invalid = await this.stillValid(row);
        if (invalid && invalid.code === 'bien_retire') return 'bien_retire';
        if (invalid && invalid.code === 'texte_refuse') return 'texte_a_revoir';
      }
      if (!row.validated_at) return 'a_valider';
      return sendsOf.has(row.id) ? 'echec' : 'a_envoyer';
    };
    const toScreen = async (row: DraftRow): Promise<GbpScreenDraft> => {
      const state = await stateOf(row);
      const ok = departedSend(row.id);
      const failed = state === 'echec' ? (sendsOf.get(row.id) ?? []).filter((x) => x.outcome === 'echec').pop() : undefined;
      return {
        draftId: row.id, body: row.body, linkUri: row.link_uri, origin: row.origin, validatedAt: row.validated_at, state,
        ackRef: ok?.ack_ref ?? null, url: ok?.url ?? null, error: failed?.error_code ?? null, action: failed?.action ?? null,
      };
    };
    const count = await this.db.first<{ total: number; waiting: number }>(
      `SELECT count(*) AS total, coalesce(sum(CASE WHEN EXISTS (SELECT 1 FROM gbp_drafts d JOIN gbp_sends x ON x.draft_id = d.id WHERE d.review_id = r.id AND x.mode = ? AND x.outcome IN ('essai', 'envoye')) THEN 0 ELSE 1 END), 0) AS waiting
         FROM gbp_reviews r WHERE r.network_id = ? AND r.agent_id = ?`,
      [this.mode, networkId, agentId],
    );
    const rows = await this.db.all<{ id: string; rating: number; comment: string | null; reviewed_at: string }>(
      `SELECT id, rating, comment, reviewed_at FROM gbp_reviews WHERE network_id = ? AND agent_id = ? ORDER BY reviewed_at DESC, id LIMIT ${SCREEN_REVIEWS}`,
      [networkId, agentId],
    );
    const reviews: GbpScreen['reviews'] = [];
    for (const r of rows) {
      const drafts = await this.db.all<DraftRow>(`${DRAFT_SELECT} WHERE d.review_id = ? ORDER BY d.created_at, d.rowid`, [r.id]);
      // Le texte parti reste celui qu'on montre ; sinon le dernier préparé, le seul qui puisse encore partir.
      const shown = drafts.find((d) => departed(d.id)) ?? drafts[drafts.length - 1];
      reviews.push({ reviewId: r.id, rating: Number(r.rating), comment: r.comment, reviewedAt: r.reviewed_at, draft: shown ? await toScreen(shown) : null });
    }
    // Le dernier texte de chaque bien : un texte périmé, remplacé, ne peut plus partir.
    const posts = await this.db.all<DraftRow>(
      `${DRAFT_SELECT} WHERE d.network_id = ? AND d.agent_id = ? AND d.kind = 'publication'
         AND d.rowid = (SELECT d2.rowid FROM gbp_drafts d2 WHERE d2.property_id = d.property_id AND d2.kind = 'publication' ORDER BY d2.created_at DESC, d2.rowid DESC LIMIT 1)
       ORDER BY d.created_at DESC, d.rowid DESC LIMIT ${SCREEN_POSTS}`,
      [networkId, agentId],
    );
    const publications: GbpScreenDraft[] = [];
    for (const row of posts) publications.push(await toScreen(row));
    return {
      ok: true,
      value: {
        agentId,
        agentFirstName: allowed.firstName,
        connected: this.client !== undefined,
        mode: this.mode,
        link: this.link(all),
        canConfigure: viewer.role === 'direction',
        location: await this.location(networkId, agentId),
        reviewsTotal: Number(count?.total ?? 0),
        reviewsWaiting: Number(count?.waiting ?? 0),
        reviews,
        publications,
      },
    };
  }
}
