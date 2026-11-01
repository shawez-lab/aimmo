/**
 * Le relevé prouvé de l'espace (EC05, Jamais vu) [R164, R161, R13].
 *
 * Le client télécharge à tout moment un relevé daté de ce que son espace lui montre : chaque visite, avis, offre,
 * document et chiffre, avec sa source et sa date. Le relevé est un simple texte, signé par le réseau (HMAC-SHA-256,
 * clé du Worker, jamais dans le dépôt ni le journal). N'importe qui, avec le relevé seul, le vérifie : la vérification
 * ne dit que « intact, fait le … » ou « modifié », sans rien apprendre d'autre ; aucune base n'est lue pour vérifier.
 * Aucun réseau ni logiciel ne remet au vendeur une preuve vérifiable de ce qui lui a été dit, et quand.
 *
 * Décidé, lecture prudente :
 * - le relevé est fait depuis la vue déjà construite par EC02 à EC04, champ par champ et retenue comprise : il ne porte
 *   rien d'un autre client [R161] ;
 * - le texte est rendu de façon déterministe : la même vue à la même date donne le même relevé et la même empreinte ;
 * - seuls les sauts de ligne Windows sont ramenés à ceux d'Unix avant vérification ; tout autre caractère changé, ajouté
 *   ou retiré rend le relevé « modifié » ;
 * - plusieurs clés peuvent vivre ensemble (rotation) : le relevé nomme la sienne ; une clé inconnue donne « modifié » ;
 * - sans clé, le relevé est indisponible (EC07 range la clé dans les secrets du Worker) ;
 * - le journal ne garde que l'empreinte et la date du relevé [R13].
 */
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import type { ClientViewer } from './entree.ts';

export interface ReleveKey {
  id: string;
  secret: string;
}

export interface Releve {
  text: string;
  madeAt: string;
  digest: string;
}

export type VerificationReleve = { status: 'intact'; madeAt: string } | { status: 'modifie' };

const HEADER = 'Relevé de votre espace';
const SEPARATOR = '— — —';
const KEY_ID = /^[a-z][a-z-]{0,30}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** Les libellés des champs de la vue, en français ; un champ sans libellé garde son nom. */
const LABELS: Record<string, string> = {
  reference: 'Référence',
  city: 'Commune',
  status: 'Statut',
  price: 'Prix',
  visits: 'Visites',
  offers: 'Offres',
  documents: 'Documents',
  appointments: 'Rendez-vous',
  weeklyPoints: 'Points de la semaine',
  deed: 'Acte',
  at: 'Date',
  state: 'État',
  report: 'Compte rendu',
  interest: 'Intérêt',
  receivedAt: 'Reçue le',
  amount: 'Montant',
  netSeller: 'Net vendeur',
  conditions: 'Conditions',
  validUntil: 'Valable jusqu’au',
  title: 'Titre',
  kind: 'Sorte',
  addedAt: 'Ajouté le',
  signature: 'Signature',
  weekOf: 'Semaine du',
  text: 'Texte',
  date: 'Date',
  holds: 'Ce qui la retient',
  rentals: 'Locations',
  applications: 'Candidatures',
  waiting: 'Dossiers incomplets',
  rank: 'Rang d’arrivée',
  complete: 'Complet',
  pieces: 'Pièces',
  guarantors: 'Garants',
  lease: 'Bail',
  inspections: 'États des lieux',
  value: 'Valeur suivie',
  range: 'Fourchette',
  sources: 'Sources',
  properties: 'Biens',
  files: 'Dossiers',
  alerts: 'Alertes',
  requested: 'Demandées',
  favorite: 'Favori',
  investor: 'Investissement',
  grossYield: 'Rendement brut (points de base)',
  netYield: 'Rendement net (points de base)',
  hypotheses: 'Hypothèses',
  constraints: 'Contraintes',
  surface: 'Surface (m²)',
  rooms: 'Pièces principales',
  energyClass: 'Classe énergie',
  publishedAt: 'Publiée le',
  loan: 'Prêt',
  deedDate: 'Date d’acte au plus tôt',
  deedHolds: 'Ce qui la retient',
  openedAt: 'Ouverte le',
  signedAt: 'Signé le',
  startsOn: 'Début',
  rent: 'Loyer',
  charges: 'Charges',
  lowEur: 'Bas',
  highEur: 'Haut',
  holder: 'Titulaire',
  label: 'Libellé',
};

/** Les champs techniques qui ne vont pas au relevé : des identifiants internes, sans sens pour le client. */
const SKIPPED = new Set(['propertyId']);

const isFait = (x: unknown): x is { value: unknown; source?: string; at?: string; label?: string } =>
  !!x && typeof x === 'object' && !Array.isArray(x) && 'value' in x && ('source' in x || 'label' in x);

const scalar = (v: unknown): string => {
  if (v === true) return 'oui';
  if (v === false) return 'non';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'non communiquée';
  if (typeof v === 'string') return v.replace(/[\r\n]+/g, ' ').trim();
  return 'non communiquée';
};

/** Rend la vue en lignes, dans l'ordre des champs de la vue : le même objet donne toujours le même texte. */
export function renderView(view: unknown): string {
  const lines: string[] = [];
  const walk = (x: unknown, label: string, depth: number): void => {
    const pad = '  '.repeat(depth);
    if (isFait(x)) {
      if (x.value === null) lines.push(`${pad}${label} : non communiquée`);
      else if (typeof x.value === 'object') {
        lines.push(`${pad}${label} (${x.source}, ${x.at}) :`);
        walk(x.value, '', depth + 1);
      } else lines.push(`${pad}${label} : ${scalar(x.value)} (${x.source}, ${x.at})`);
      return;
    }
    if (Array.isArray(x)) {
      if (label) lines.push(`${pad}${label} : ${x.length === 0 ? 'aucun' : ''}`.trimEnd());
      x.forEach((e, i) => walk(e, `${i + 1}.`, depth + (label ? 1 : 0)));
      return;
    }
    if (x && typeof x === 'object') {
      if (label) lines.push(`${pad}${label}`);
      for (const [k, v] of Object.entries(x)) {
        if (SKIPPED.has(k) || v === undefined) continue;
        walk(v, LABELS[k] ?? k, depth + (label ? 1 : 0));
      }
      return;
    }
    if (x === null) {
      lines.push(`${pad}${label} : non communiquée`);
      return;
    }
    lines.push(`${pad}${label ? `${label} : ` : ''}${scalar(x)}`);
  };
  walk(view, '', 0);
  return lines.join('\n');
}

async function hmac(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function sha256(text: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Comparaison en temps constant de deux chaînes hexadécimales de même longueur. */
function sameHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const signed = (body: string, madeAt: string, keyId: string): string => `${body}\n${SEPARATOR}\nFait le : ${madeAt}\nClé : ${keyId}`;

export class ReleveEspace {
  private readonly keys: Map<string, string>;
  private readonly current: string | null;
  private readonly now: () => Date;

  /** `keys` : la première est celle qui signe ; les suivantes vérifient seulement (rotation). Vide : indisponible. */
  constructor(
    keys: readonly ReleveKey[],
    private readonly journal: JournalStore,
    options: { now?: () => Date } = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.keys = new Map();
    for (const k of keys) {
      if (!KEY_ID.test(k.id)) throw new Error('nom de clé du relevé invalide');
      if (typeof k.secret !== 'string' || k.secret.length < 32) throw new Error('clé du relevé trop courte (32 caractères au moins)');
      if (this.keys.has(k.id)) throw new Error('nom de clé du relevé en double');
      this.keys.set(k.id, k.secret);
    }
    this.current = keys[0]?.id ?? null;
  }

  get available(): boolean {
    return this.current !== null;
  }

  /** Fait le relevé de la vue de ce client, signée ; `null` sans clé. */
  async make(viewer: ClientViewer, title: string, view: unknown): Promise<Releve | null> {
    if (!this.current) return null;
    const madeAt = this.now().toISOString();
    const body = `${HEADER} · ${scalar(title)}\n\n${renderView(view)}`;
    const head = signed(body, madeAt, this.current);
    const signature = await hmac(this.keys.get(this.current)!, head);
    const text = `${head}\nSignature : ${signature}\n`;
    const digest = await sha256(text);
    await appendEvent(this.journal, { type: 'espaces.releve', actor: `client:${viewer.sessionId}`, subject: `person:${viewer.personId}`, data: { rule: 'R164', digest, madeAt } }, this.now);
    return { text, madeAt, digest };
  }

  /** Vérifie un relevé, seul : « intact, fait le … » ou « modifié », rien d'autre [R164]. */
  async verify(document: unknown): Promise<VerificationReleve> {
    const modified: VerificationReleve = { status: 'modifie' };
    if (typeof document !== 'string' || document.length > 2_000_000) return modified;
    const text = document.replace(/\r\n/g, '\n');
    const m = /^([\s\S]*)\n— — —\nFait le : (\S+)\nClé : (\S+)\nSignature : ([0-9a-f]{64})\n$/u.exec(text);
    if (!m) return modified;
    const [, body, madeAt, keyId, signature] = m as unknown as [string, string, string, string, string];
    if (!body.startsWith(`${HEADER} · `) || !ISO.test(madeAt) || Number.isNaN(Date.parse(madeAt))) return modified;
    const secret = this.keys.get(keyId);
    if (!secret) return modified;
    const expected = await hmac(secret, signed(body, madeAt, keyId));
    return sameHex(expected, signature) ? { status: 'intact', madeAt } : modified;
  }
}
