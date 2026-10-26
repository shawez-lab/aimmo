/**
 * Fichiers des outils, pour la reprise (I03) : la liste d'exclusion de Shawez, et les contacts de GoHighLevel
 * et de ManyChat avec leurs désinscriptions. Les colonnes reconnues sont décrites dans `docs/REPRISE.md`.
 * Lecture prudente : un désabonnement, un « ne pas déranger » ou un abonnement refusé valent arrêt sur tous les
 * canaux [R04] ; une ligne sans coordonnée valable est signalée par son numéro, jamais jetée ; aucun accord
 * n'est repris de ces outils, faute de preuve [R03].
 */
import { parseCsv } from './csv.ts';
import { contactIdentifiers, type ImportBatch, type ImportedContact } from './reprise.ts';

export const TOOL_FILES = ['exclusion_list', 'gohighlevel', 'manychat'] as const;
export type ToolFile = (typeof TOOL_FILES)[number];

export interface ToolReading extends ImportBatch {
  /** Lignes signalées (numéro de ligne dans le fichier, en-tête = 1) : aucune coordonnée valable lue. */
  unreadableLines: number[];
  /** Lignes reprises avec au moins une coordonnée illisible, laissée de côté : à compléter à la main. */
  partialLines: number[];
}

type Field = 'id' | 'email' | 'phone' | 'instagram' | 'firstName' | 'lastName' | 'optOut' | 'subscribed' | 'tags';

/** En-têtes reconnus, comparés sans accents, sans casse, sans espaces ni ponctuation. */
const HEADERS: Record<Field, string[]> = {
  id: ['id', 'contactid', 'userid', 'subscriberid', 'identifiant'],
  email: ['email', 'emailaddress', 'mail', 'courriel', 'adressemail', 'adresseemail'],
  phone: ['phone', 'phonenumber', 'mobile', 'telephone', 'tel', 'portable', 'whatsappphone', 'whatsapp'],
  instagram: ['instagram', 'instagramusername', 'iguser', 'igusername', 'instagramname'],
  firstName: ['firstname', 'prenom'],
  lastName: ['lastname', 'nom', 'nomdefamille'],
  optOut: ['dnd', 'donotdisturb', 'nepasderanger', 'unsubscribed', 'desabonne', 'desinscrit', 'optout', 'optedout', 'stop', 'dndemail', 'dndsms', 'dndcalls', 'dndwhatsapp'],
  subscribed: ['subscribed', 'optin', 'optedin', 'abonne', 'status', 'statut', 'subscriptionstatus', 'subscriberstatus', 'abonnement'],
  tags: ['tags', 'tag', 'etiquettes', 'etiquette', 'labels', 'label'],
};

/** Mots qui disent une désinscription, dans un en-tête, une valeur ou une étiquette. */
const OPT_OUT_WORDS = /dnd|unsub|optout|optedout|desabon|desinscri|stop|blocked|bloque|nepasderanger|donotdisturb/;

const key = (header: string): string =>
  header
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');

/** Une case « ne pas déranger » remplie d'autre chose qu'un non vaut arrêt : dans le doute, se taire. */
const NOT_SET = new Set(['0', 'false', 'faux', 'no', 'non', 'n', 'off', 'inactive', 'inactif']);
/** Seules ces valeurs, ou une date d'abonnement, disent « abonné » ; toute autre, vide comprise, vaut arrêt. */
const SUBSCRIBED = new Set(['1', 'true', 'vrai', 'yes', 'oui', 'y', 'o', 'active', 'actif', 'subscribed', 'abonne', 'optin', 'optedin']);
/** Une date d'abonnement seule, avec son heure peut-être : rien d'autre dans la case. */
const DATE = /^(?:\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{2,4})(?:[ T][\d:.]+(?:z|[+-]\d{2}:?\d{2})?)?$/i;

const clean = (value: string | undefined): string | null => {
  const trimmed = (value ?? '').trim();
  return trimmed === '' ? null : trimmed;
};

/** Plusieurs valeurs dans une cellule (« a@x.fr, b@x.fr ») : séparées par virgule, point-virgule ou barre. */
const many = (value: string | null): string[] => (value === null ? [] : value.split(/[,;|]/).map((v) => v.trim()).filter((v) => v !== ''));

const SOURCE: Record<ToolFile, { channel: string; detail: string }> = {
  exclusion_list: { channel: 'exclusion_list', detail: "reprise liste d'exclusion" },
  gohighlevel: { channel: 'gohighlevel', detail: 'reprise GoHighLevel' },
  manychat: { channel: 'manychat', detail: 'reprise ManyChat' },
};

async function digest(text: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(bytes)].slice(0, 12).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Lit un fichier d'outil. La clé d'origine de chaque ligne est stable d'un export à l'autre : l'identifiant de
 * l'outil s'il est dans le fichier, sinon une empreinte des coordonnées de la ligne (jamais les coordonnées).
 */
export async function readToolCsv(text: string, tool: ToolFile, createdAt: Date): Promise<ToolReading> {
  const [header, ...lines] = parseCsv(text);
  const columns = new Map<Field, number[]>();
  for (const [index, name] of (header ?? []).entries()) {
    const k = key(name);
    let field = (Object.entries(HEADERS) as [Field, string[]][]).find(([, names]) => names.includes(k))?.[0];
    // Un en-tête qui parle de désinscription (« DND Status », « Email DND », « Unsubscribed At »…) en est une.
    if (field !== 'tags' && OPT_OUT_WORDS.test(k)) field = 'optOut';
    // Dans GoHighLevel, « Status » est l'étape du contact, pas son abonnement.
    if (tool === 'gohighlevel' && field === 'subscribed' && (k === 'status' || k === 'statut')) field = undefined;
    if (field) columns.set(field, [...(columns.get(field) ?? []), index]);
  }
  if (!columns.has('email') && !columns.has('phone') && !columns.has('instagram')) {
    throw new Error("Fichier sans colonne de mail, de téléphone ni d'Instagram : voir docs/REPRISE.md.");
  }
  if (tool !== 'exclusion_list' && !columns.has('optOut') && !columns.has('subscribed') && !columns.has('tags')) {
    throw new Error('Fichier sans colonne de désinscription ni d\'abonnement ni d\'étiquettes : les arrêts seraient perdus. Voir docs/REPRISE.md.');
  }
  const cells = (row: string[], field: Field): string[] =>
    (columns.get(field) ?? []).map((i) => clean(row[i])).filter((v): v is string => v !== null);

  const reading: ToolReading = { contacts: [], skipped: { suspect: 0, test: 0 }, flagged: 0, unreadableLines: [], partialLines: [] };
  for (const [index, row] of lines.entries()) {
    const lineNumber = index + 2;
    if (row.every((cell) => cell.trim() === '')) continue;
    const emails = cells(row, 'email').flatMap(many);
    const phones = cells(row, 'phone').flatMap(many);
    const instagrams = cells(row, 'instagram').flatMap(many);
    const optOut = cells(row, 'optOut').some((v) => !NOT_SET.has(key(v)));
    // Une colonne d'abonnement vide ou qui ne dit pas clairement « abonné » vaut arrêt.
    const unsubscribed = (columns.get('subscribed') ?? []).some((i) => {
      const value = clean(row[i]);
      return value === null || OPT_OUT_WORDS.test(key(value)) || (!SUBSCRIBED.has(key(value)) && !DATE.test(value));
    });
    const tagged = cells(row, 'tags').flatMap(many).some((tag) => OPT_OUT_WORDS.test(key(tag)));
    const exclusion = tool === 'exclusion_list' ? 'network_list' : optOut || unsubscribed || tagged ? 'stop' : null;
    const id = cells(row, 'id')[0] ?? null;
    const valid = contactIdentifiers({ emails, phones, instagrams });
    // Empreinte des coordonnées normalisées : un même numéro écrit autrement d'un export à l'autre garde la même clé.
    const origin = `${tool}:${id ?? (await digest(valid.map((v) => `${v.kind}:${v.value}`).sort().join('|')))}`;
    const contact: ImportedContact = {
      origin,
      emails,
      phones,
      instagrams,
      civility: null,
      firstName: cells(row, 'firstName')[0] ?? null,
      lastName: cells(row, 'lastName')[0] ?? null,
      createdAt: createdAt.toISOString(),
      consentAt: null,
      verified: false,
      requests: [],
      problems: [],
      source: SOURCE[tool],
      exclusion,
    };
    if (valid.length === 0) {
      reading.unreadableLines.push(lineNumber);
      reading.flagged += 1;
      continue;
    }
    // Une coordonnée illisible à côté d'une lisible : la ligne est reprise, et signalée pour être complétée.
    const readable = (kind: 'email' | 'phone' | 'instagram', raw: string): boolean =>
      contactIdentifiers({ emails: kind === 'email' ? [raw] : [], phones: kind === 'phone' ? [raw] : [], instagrams: kind === 'instagram' ? [raw] : [] }).length > 0;
    const lost =
      emails.some((v) => !readable('email', v)) || phones.some((v) => !readable('phone', v)) || instagrams.some((v) => !readable('instagram', v));
    if (lost) {
      reading.partialLines.push(lineNumber);
      reading.flagged += 1;
      contact.problems.push('contact_illisible');
    }
    reading.contacts.push(contact);
  }
  return reading;
}
