/**
 * Import des contacts et des biens d'un agent, triés selon la loi (M14, J05) [R84].
 *
 * L'agent (ou la direction pour lui) dépose un export Hektor, Apimo, Excel ou Google en CSV. Chaque contact devient ou
 * complète sa fiche, à cet agent, avec la source « import » (par la reprise : une seule fiche par personne, relançable
 * sans rien doubler [R18]). Chaque contact est trié par ce que l'export prouve, et par rien d'autre :
 * - `client` : un mandat ou une vente figure dans l'export pour ce contact ;
 * - `consent` : un accord figure avec sa date (passée), sa preuve et sa finalité ; il est rangé tel quel [R03] ;
 * - `none` : rien de cela. Aucun accord n'est créé : le contrôle central refusera tout premier message [R03, R84].
 * Un accord sans date, sans preuve, sans finalité reconnue ou daté dans le futur ne vaut rien : la ligne est signalée.
 * Une désinscription dans l'export vaut arrêt sur tous les canaux [R04].
 *
 * Une fiche déjà suivie par un autre agent, ou par personne, n'est jamais reprise ni complétée : le contact va à la
 * direction, qui attribue [R16]. Les biens sont rangés comme biens de l'agent, en brouillon : l'import ne publie rien.
 * Aucune adresse exacte n'est lue. Rien n'est envoyé. Au journal, des nombres et des identifiants internes [R13].
 */
import { keyLookupForms } from '../fiche/empreinte.ts';
import type { Viewer } from '../acces/droits.ts';
import type { FicheClient } from '../db/fiche-client.ts';
import type { SqlDatabase, SqlValue } from '../db/sql.ts';
import type { Channel, Dwelling, Person, PropertyKind } from '../db/types.ts';
import type { DecisionEnvoi } from '../envoi/service.ts';
import type { FicheUnique } from '../fiche/fusion.ts';
import { matchKey } from '../fiche/normalize.ts';
import { personSubject } from '../acces/acces.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import { parseCsv } from '../reprise/csv.ts';
import { RepriseSite, contactIdentifiers, type ImportReport, type ImportedContact } from '../reprise/reprise.ts';

export const AGENT_EXPORT_FORMATS = ['hektor', 'apimo', 'excel', 'google'] as const;
export type AgentExportFormat = (typeof AGENT_EXPORT_FORMATS)[number];

const FORMAT_LABEL: Record<AgentExportFormat, string> = { hektor: 'Hektor', apimo: 'Apimo', excel: 'Excel', google: 'Google' };

export type LegalBasis = 'client' | 'consent' | 'none';

/** Finalités d'un accord reconnues dans un export, en liste fermée ; toute autre ne vaut pas accord. */
const PURPOSES: Readonly<Record<string, string>> = Object.freeze({
  prospection: 'prospecting',
  prospecting: 'prospecting',
  commercial: 'prospecting',
  communicationcommerciale: 'prospecting',
  newsletter: 'prospecting',
  alerte: 'alert',
  alertes: 'alert',
  alert: 'alert',
  alerts: 'alert',
  alertesbiens: 'alert',
  suivi: 'follow_up',
  followup: 'follow_up',
  relance: 'follow_up',
  relances: 'follow_up',
});

/** Canaux d'un accord reconnus ; à défaut de colonne, l'accord vaut pour le mail et le téléphone de la ligne. */
const CHANNELS: Readonly<Record<string, Channel>> = Object.freeze({
  email: 'email',
  mail: 'email',
  courriel: 'email',
  telephone: 'phone',
  tel: 'phone',
  phone: 'phone',
  appel: 'phone',
  sms: 'sms',
  whatsapp: 'whatsapp',
});

const PROPERTY_KINDS: Readonly<Record<string, PropertyKind>> = Object.freeze({
  maison: 'home',
  appartement: 'home',
  appart: 'home',
  studio: 'home',
  duplex: 'home',
  loft: 'home',
  villa: 'home',
  house: 'home',
  apartment: 'home',
  flat: 'home',
  terrain: 'land',
  land: 'land',
  immeuble: 'building',
  building: 'building',
  local: 'commercial',
  localcommercial: 'commercial',
  bureau: 'commercial',
  bureaux: 'commercial',
  commerce: 'commercial',
  commercial: 'commercial',
  murs: 'business_walls',
  murscommerciaux: 'business_walls',
  fondsdecommerce: 'business',
  fonds: 'business',
});

type ContactField =
  | 'id'
  | 'email'
  | 'phone'
  | 'firstName'
  | 'lastName'
  | 'mandate'
  | 'sale'
  | 'consentAt'
  | 'consentProof'
  | 'consentPurpose'
  | 'consentChannel'
  | 'optOut';

/** En-têtes reconnus (Hektor, Apimo, Excel, Google Contacts), comparés sans accents, casse, espaces ni ponctuation. */
const CONTACT_HEADERS: Record<ContactField, string[]> = {
  id: ['id', 'identifiant', 'idcontact', 'contactid', 'numerocontact', 'ncontact', 'reference', 'ref', 'refcontact'],
  email: ['email', 'mail', 'courriel', 'adressemail', 'adresseemail', 'email1', 'email2', 'email1value', 'email2value', 'emailaddress', 'e-mail'],
  phone: [
    'telephone',
    'tel',
    'portable',
    'mobile',
    'telephoneportable',
    'telportable',
    'telephonemobile',
    'telephonefixe',
    'telfixe',
    'fixe',
    'phone',
    'phonenumber',
    'phone1value',
    'phone2value',
    'telephone1',
    'telephone2',
  ],
  firstName: ['prenom', 'firstname', 'givenname'],
  lastName: ['nom', 'nomdefamille', 'lastname', 'familyname'],
  mandate: ['mandat', 'nmandat', 'numeromandat', 'numerodemandat', 'mandats', 'refmandat', 'mandatsigne', 'mandatnumero'],
  sale: ['vente', 'ventes', 'venteconclue', 'dateacte', 'datedevente', 'acte'],
  consentAt: ['dateaccord', 'accordle', 'dateconsentement', 'consentementle', 'consentdate', 'optindate', 'dateoptin', 'datedaccord', 'accorddonnele'],
  consentProof: ['preuveaccord', 'preuveconsentement', 'preuvedaccord', 'consentproof', 'preuve', 'sourceaccord', 'sourceconsentement'],
  consentPurpose: ['finalite', 'finaliteaccord', 'finaliteconsentement', 'consentpurpose', 'purpose', 'objetaccord'],
  consentChannel: ['canalaccord', 'canalconsentement', 'consentchannel', 'canaldaccord'],
  optOut: ['desinscrit', 'desabonne', 'optout', 'unsubscribed', 'stop', 'nepascontacter', 'nepasderanger', 'opposition', 'bloctel', 'donotcontact', 'dnd'],
};

type PropertyField = 'reference' | 'kind' | 'postalCode' | 'city' | 'surface' | 'rooms' | 'price';

const PROPERTY_HEADERS: Record<PropertyField, string[]> = {
  reference: ['reference', 'ref', 'refbien', 'referencebien', 'nmandat', 'numeromandat', 'mandat', 'id', 'identifiant'],
  kind: ['type', 'typedebien', 'typebien', 'nature', 'categorie', 'propertytype'],
  postalCode: ['codepostal', 'cp', 'postalcode', 'zipcode', 'zip'],
  city: ['ville', 'commune', 'localite', 'city'],
  surface: ['surface', 'surfacehabitable', 'surfacem2', 'surfacecarrez', 'm2', 'livingarea'],
  rooms: ['pieces', 'nbpieces', 'nombredepieces', 'rooms'],
  price: ['prix', 'prixdevente', 'prixfai', 'prixhonorairesinclus', 'price'],
};

/** Une case qui dit « non » : rien. Toute autre valeur non vide dit « oui ». */
const NO = new Set(['0', 'false', 'faux', 'no', 'non', 'n', 'off', 'aucun', 'aucune', 'sans', '-', 'na', 'nonrenseigne']);

const key = (value: string): string =>
  value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');

const clean = (value: string | undefined): string | null => {
  const trimmed = (value ?? '').trim();
  return trimmed === '' ? null : trimmed;
};

const many = (value: string): string[] => value.split(/[,;|]/).map((v) => v.trim()).filter((v) => v !== '');

const yes = (value: string | null): boolean => value !== null && !NO.has(key(value));

/** Une tournure qui dit l'absence : « pas de mandat », « non signé », « aucune preuve », « inconnue »… */
const NEGATIVE = /(?:^|[^a-z])(?:pas|non|aucun|aucune|sans|inconnu|inconnue|annule|annulee|nc|na|nr)(?:[^a-z]|$)|nonrenseign|arenseigner|\?/;
const negative = (value: string): boolean =>
  NEGATIVE.test(
    value
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase(),
  );

/** Un mandat ou une vente prouvés : une référence avec un chiffre, ou une date réelle, sans tournure d'absence. */
export const provesDeal = (value: string): boolean => !NO.has(key(value)) && !negative(value) && (/\d/.test(value) || exportDay(value) !== null);

/** Une preuve d'accord : un texte d'au moins 5 lettres qui ne dit pas l'absence. */
export const provesConsent = (value: string): boolean => !NO.has(key(value)) && !negative(value) && key(value).length >= 5;

/** Un identifiant stable, à la forme d'un UUID, tiré d'un texte. */
async function stableId(text: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`bien-importe:${text}`)));
  const hex = [...bytes.slice(0, 16)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

async function digest(text: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(bytes)].slice(0, 12).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Une date d'export : `AAAA-MM-JJ` ou `JJ/MM/AAAA`, avec une heure peut-être, réelle. Rend `AAAA-MM-JJ` ou null. */
export function exportDay(raw: string | null): string | null {
  if (raw === null) return null;
  const value = raw.trim();
  let y: number;
  let m: number;
  let d: number;
  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:[ T][\d:.]+(?:z|[+-]\d{2}:?\d{2})?)?$/i.exec(value);
  const fr = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?: [\d:]+)?$/.exec(value);
  if (iso) [y, m, d] = [Number(iso[1]), Number(iso[2]), Number(iso[3])];
  else if (fr) [d, m, y] = [Number(fr[1]), Number(fr[2]), Number(fr[3])];
  else return null;
  const date = new Date(Date.UTC(y, m - 1, d, 12));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  return date.toISOString().slice(0, 10);
}

export interface ProvedConsent {
  /** `AAAA-MM-JJ`. */
  givenOn: string;
  proof: string;
  purpose: string;
  /** Canaux dits dans l'export ; vide : le mail et le téléphone de la ligne. */
  channels: Channel[];
}

export interface AgentContactLine {
  line: number;
  contact: ImportedContact;
  basis: LegalBasis;
  consent: ProvedConsent | null;
}

export interface AgentContactsReading {
  lines: AgentContactLine[];
  /** Aucune coordonnée lisible : signalée, jamais reprise. */
  unreadableLines: number[];
  /** Une coordonnée illisible à côté d'une lisible : reprise, à compléter. */
  partialLines: number[];
  /** Un accord incomplet (date, preuve, finalité) ou daté dans le futur : il ne vaut rien, la ligne le dit. */
  incompleteConsentLines: number[];
}

function columnsOf<F extends string>(header: readonly string[], names: Record<F, string[]>): Map<F, number[]> {
  const columns = new Map<F, number[]>();
  for (const [index, name] of header.entries()) {
    const k = key(name);
    const field = (Object.entries(names) as [F, string[]][]).find(([, list]) => list.map(key).includes(k))?.[0];
    if (field) columns.set(field, [...(columns.get(field) ?? []), index]);
  }
  return columns;
}

/** Lit un export de contacts d'agent. La clé d'origine est propre à l'agent et stable d'un export à l'autre. */
export async function readAgentContacts(text: string, format: AgentExportFormat, agentId: string, importedAt: Date): Promise<AgentContactsReading> {
  const [header, ...rows] = parseCsv(text);
  const columns = columnsOf(header ?? [], CONTACT_HEADERS);
  if (!columns.has('email') && !columns.has('phone')) {
    throw new Error("Export sans colonne de mail ni de téléphone : voir docs/REPRISE.md, section « Import d'un agent ».");
  }
  const cells = (row: string[], field: ContactField): string[] =>
    (columns.get(field) ?? []).map((i) => clean(row[i])).filter((v): v is string => v !== null);
  const today = importedAt.toISOString().slice(0, 10);
  const reading: AgentContactsReading = { lines: [], unreadableLines: [], partialLines: [], incompleteConsentLines: [] };
  for (const [index, row] of rows.entries()) {
    const line = index + 2;
    if (row.every((cell) => cell.trim() === '')) continue;
    const emails = cells(row, 'email').flatMap(many);
    const phones = cells(row, 'phone').flatMap(many);
    const valid = contactIdentifiers({ emails, phones });
    if (valid.length === 0) {
      reading.unreadableLines.push(line);
      continue;
    }
    const readable = (kind: 'email' | 'phone', raw: string): boolean =>
      contactIdentifiers({ emails: kind === 'email' ? [raw] : [], phones: kind === 'phone' ? [raw] : [] }).length > 0;
    const partial = emails.some((v) => !readable('email', v)) || phones.some((v) => !readable('phone', v));
    if (partial) reading.partialLines.push(line);

    const id = cells(row, 'id')[0] ?? null;
    const origin = `import:${agentId}:${format}:${id === null ? `h${await digest(valid.map((v) => `${v.kind}:${v.value}`).sort().join('|'))}` : `id${await digest(id)}`}`;

    // Accord : seulement daté (pas dans le futur), prouvé, et pour une finalité de la liste fermée.
    const consentCells = [cells(row, 'consentAt')[0] ?? null, cells(row, 'consentProof')[0] ?? null, cells(row, 'consentPurpose')[0] ?? null] as const;
    let consent: ProvedConsent | null = null;
    if (consentCells.some((v) => v !== null && yes(v))) {
      const givenOn = exportDay(consentCells[0]);
      const proof = consentCells[1];
      const purpose = consentCells[2] === null ? undefined : PURPOSES[key(consentCells[2])];
      const channelCells = cells(row, 'consentChannel').flatMap(many);
      const channels = channelCells.map((c) => CHANNELS[key(c)]).filter((c): c is Channel => c !== undefined);
      const channelsOk = channelCells.length === channels.length;
      if (givenOn !== null && givenOn <= today && proof !== null && proof.length <= 200 && provesConsent(proof) && purpose !== undefined && channelsOk) {
        consent = { givenOn, proof, purpose, channels: [...new Set(channels)] };
      } else {
        reading.incompleteConsentLines.push(line);
      }
    }
    const client = cells(row, 'mandate').some(provesDeal) || cells(row, 'sale').some(provesDeal);
    const basis: LegalBasis = client ? 'client' : consent ? 'consent' : 'none';
    const contact: ImportedContact = {
      origin,
      emails,
      phones,
      civility: null,
      firstName: cells(row, 'firstName')[0]?.slice(0, 60) ?? null,
      lastName: cells(row, 'lastName')[0]?.slice(0, 60) ?? null,
      createdAt: importedAt.toISOString(),
      // Jamais d'accord du site : les accords de l'import sont rangés à part, avec leur preuve.
      consentAt: null,
      verified: false,
      requests: [],
      problems: partial ? ['contact_illisible'] : [],
      source: { channel: 'import', detail: `import ${FORMAT_LABEL[format]}` },
      exclusion: cells(row, 'optOut').some(yes) ? 'stop' : null,
    };
    reading.lines.push({ line, contact, basis, consent });
  }
  return reading;
}

export interface AgentPropertyLine {
  line: number;
  origin: string;
  reference: string;
  kind: PropertyKind;
  /** Maison ou appartement, lu dans le type d'origine ; null s'il ne le dit pas (AU070). */
  dwelling: Dwelling | null;
  postalCode: string | null;
  city: string | null;
  surfaceM2: number | null;
  rooms: number | null;
  priceEur: number | null;
}

/** Le type d'origine qui dit maison ou appartement (AU070). */
const DWELLING_WORDS: Readonly<Record<string, Dwelling>> = Object.freeze({
  maison: 'house',
  villa: 'house',
  house: 'house',
  appartement: 'apartment',
  appart: 'apartment',
  studio: 'apartment',
  duplex: 'apartment',
  loft: 'apartment',
  apartment: 'apartment',
  flat: 'apartment',
});

export interface AgentPropertiesReading {
  lines: AgentPropertyLine[];
  /** Sans référence, ou d'un type inconnu : signalée, jamais devinée. */
  unreadableLines: number[];
}

const number = (raw: string | null, integer: boolean): number | null => {
  if (raw === null) return null;
  const compact = raw.replace(/[\s  €]/g, '').replace(/m2|m²/gi, '');
  if (!/^\d+(?:[.,]\d+)?$/.test(compact)) return null;
  const value = Number(compact.replace(',', '.'));
  if (!Number.isFinite(value) || value <= 0) return null;
  return integer ? (Number.isInteger(value) ? value : null) : value;
};

/** Lit un export de biens d'agent. Aucune adresse n'est lue : seulement la commune et le code postal. */
export async function readAgentProperties(text: string, format: AgentExportFormat, agentId: string): Promise<AgentPropertiesReading> {
  const [header, ...rows] = parseCsv(text);
  const columns = columnsOf(header ?? [], PROPERTY_HEADERS);
  if (!columns.has('reference') || !columns.has('kind')) {
    throw new Error("Export de biens sans colonne de référence ni de type : voir docs/REPRISE.md, section « Import d'un agent ».");
  }
  const cell = (row: string[], field: PropertyField): string | null => (columns.get(field) ?? []).map((i) => clean(row[i])).find((v) => v !== null) ?? null;
  const reading: AgentPropertiesReading = { lines: [], unreadableLines: [] };
  for (const [index, row] of rows.entries()) {
    const line = index + 2;
    if (row.every((c) => c.trim() === '')) continue;
    const reference = cell(row, 'reference');
    const rawKind = cell(row, 'kind');
    const kind = rawKind === null ? undefined : PROPERTY_KINDS[key(rawKind)] ?? PROPERTY_KINDS[key(rawKind.split(/\s+/)[0] ?? '')];
    if (reference === null || reference.length > 60 || kind === undefined) {
      reading.unreadableLines.push(line);
      continue;
    }
    const postal = cell(row, 'postalCode');
    reading.lines.push({
      line,
      origin: `import:${agentId}:${format}:bien:${await digest(reference)}`,
      reference,
      kind,
      dwelling: kind === 'home' && rawKind !== null ? (DWELLING_WORDS[key(rawKind)] ?? DWELLING_WORDS[key(rawKind.split(/\s+/)[0] ?? '')] ?? null) : null,
      postalCode: postal !== null && /^\d{5}$/.test(postal) ? postal : null,
      city: cell(row, 'city')?.slice(0, 80) ?? null,
      surfaceM2: number(cell(row, 'surface'), false),
      rooms: number(cell(row, 'rooms'), true),
      priceEur: number(cell(row, 'price'), true),
    });
  }
  return reading;
}

/* ---------- AU030 · Le dossier des biens repris : photos, diagnostics, mandats signés, diffusion. ---------- */

/** Ce qu'une pièce du dossier d'un bien est : média, diagnostic, mandat, annonce diffusée, ou autre document. */
export const PIECE_CATEGORIES = ['photo', 'diagnostic', 'mandate', 'diffusion', 'document'] as const;
export type PieceCategory = (typeof PIECE_CATEGORIES)[number];

/** Pourquoi une pièce n'est pas reprise. Chaque raison est comptée, ligne par ligne, avant comme après validation. */
export const PIECE_SKIPS = ['no_property', 'unknown_property', 'other_agent', 'unknown_type', 'no_source', 'unsafe_link'] as const;
export type PieceSkip = (typeof PIECE_SKIPS)[number];

type PieceField = 'reference' | 'type' | 'file' | 'link' | 'date' | 'signed' | 'portal';

const PIECE_HEADERS: Record<PieceField, string[]> = {
  reference: ['referencebien', 'refbien', 'idbien', 'reference', 'ref', 'bien', 'referenceannonce'],
  type: ['typedepiece', 'typepiece', 'typededocument', 'typedocument', 'type', 'categorie', 'nature'],
  file: ['nomdufichier', 'nomfichier', 'fichier', 'filename', 'file', 'nom', 'titre', 'libelle'],
  link: ['lien', 'url', 'lienannonce', 'urlannonce', 'adresseweb', 'link'],
  date: ['date', 'datedocument', 'datesignature', 'datedesignature', 'datediagnostic', 'datepublication'],
  signed: ['signe', 'signee', 'signature', 'statutsignature', 'etatsignature'],
  portal: ['portail', 'site', 'diffuseur', 'support'],
};

/** Le type d'une pièce, tel que les logiciels l'écrivent, sans accents ni espaces. */
const PIECE_WORDS: Readonly<Record<string, PieceCategory>> = Object.freeze({
  photo: 'photo', photos: 'photo', image: 'photo', images: 'photo', visuel: 'photo', media: 'photo', medias: 'photo', video: 'photo', visitevirtuelle: 'photo',
  diagnostic: 'diagnostic', diagnostics: 'diagnostic', diag: 'diagnostic', ddt: 'diagnostic', dpe: 'diagnostic', ges: 'diagnostic', amiante: 'diagnostic', plomb: 'diagnostic',
  crep: 'diagnostic', electricite: 'diagnostic', gaz: 'diagnostic', termites: 'diagnostic', erp: 'diagnostic', ernmt: 'diagnostic', carrez: 'diagnostic', boutin: 'diagnostic',
  assainissement: 'diagnostic', merule: 'diagnostic', audit: 'diagnostic', auditenergetique: 'diagnostic',
  mandat: 'mandate', mandats: 'mandate', mandatsigne: 'mandate', mandatdevente: 'mandate', avenant: 'mandate',
  annonce: 'diffusion', annonces: 'diffusion', diffusion: 'diffusion', portail: 'diffusion', publication: 'diffusion', lienannonce: 'diffusion',
  document: 'document', documents: 'document', piece: 'document', titredepropriete: 'document', acte: 'document', plan: 'document', plans: 'document',
  taxefonciere: 'document', reglementdecopropriete: 'document', pvag: 'document', autre: 'document',
});

/** Le début d'un type plus long (« Diagnostic amiante », « Mandat exclusif signé », « Annonce SeLoger »). */
const PIECE_STEMS: readonly [string, PieceCategory][] = [
  ['photo', 'photo'], ['diagnostic', 'diagnostic'], ['dpe', 'diagnostic'], ['audit', 'diagnostic'], ['mandat', 'mandate'], ['avenant', 'mandate'], ['annonce', 'diffusion'], ['diffusion', 'diffusion'],
];

export const pieceCategory = (raw: string): PieceCategory | undefined => {
  const k = key(raw);
  return PIECE_WORDS[k] ?? PIECE_WORDS[key(raw.split(/[\s/-]+/)[0] ?? '')] ?? PIECE_STEMS.find(([stem]) => k.startsWith(stem))?.[1];
};

/** Ce qu'une colonne de signature dit d'un mandat : signé, non signé, ou rien de sûr (non renseigné, inconnu, `?`…). */
const UNSIGNED = new Set(['non', 'no', 'n', 'false', 'faux', '0', 'nonsigne', 'nonsignee', 'passigne', 'passignee', 'pasencoresigne', 'asigner', 'ensignature', 'enattente', 'unsigned']);
export const signatureSaid = (raw: string): boolean | null => {
  const k = key(raw);
  if (UNSIGNED.has(k)) return false;
  // Une valeur inconnue n'est ni « signé » ni « non signé » : rien n'est deviné.
  if (/nonrenseign|inconnu|arenseigner|\?/.test(raw.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')) || ['nc', 'na', 'nr', 'nsp'].includes(k)) return null;
  if (DONE.has(k) || /^signe/.test(k) || exportDay(raw) !== null) return true;
  return null;
};

/** Ce que le type d'une pièce dit de la signature d'un mandat : une négation l'emporte toujours sur « signé ». */
export const signatureInType = (raw: string): boolean | null => {
  // Les mots tels qu'écrits, sans accents : « Mandat SCA signé » reste signé, « Mandat à signer » ne l'est pas.
  const words = ` ${raw.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `;
  if (/ (?:non|pas|pas encore|jamais) signee? | a signer | en (?:cours de )?signature | en attente | unsigned | nonsignee? /.test(words)) return false;
  if (/ non renseigne| inconnue? /.test(words)) return null;
  return / signee? /.test(words) ? true : null;
};

/** Un lien gardé : https seulement, sans identifiant ni mot de passe dans l'adresse, 500 signes au plus. */
export const safeLink = (raw: string | null): string | null => {
  if (raw === null || raw.length > 500) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.hostname === '') return null;
    return url.toString().length <= 500 ? url.toString() : null;
  } catch {
    return null;
  }
};

export interface PieceLine {
  line: number;
  /** La clé d'origine du bien, comme l'import des biens la forme. */
  propertyOrigin: string;
  category: PieceCategory;
  label: string;
  fileName: string | null;
  link: string | null;
  datedOn: string | null;
  signed: boolean | null;
  portal: string | null;
  identity: string;
}

export interface PiecesReading {
  lines: PieceLine[];
  skipped: { line: number; reason: PieceSkip }[];
}

/**
 * Lit un export « dossier des biens » : une pièce par ligne, rattachée au bien par la référence de l'export des biens.
 * Rien n'est deviné : une pièce sans bien, d'un type inconnu, sans nom de fichier ni lien, ou avec un seul lien qui
 * n'est pas sûr est rendue avec sa raison.
 */
export async function readAgentPieces(text: string, format: AgentExportFormat, agentId: string): Promise<PiecesReading> {
  const [header, ...rows] = parseCsv(text);
  const columns = columnsOf(header ?? [], PIECE_HEADERS);
  if (!columns.has('reference') || (!columns.has('file') && !columns.has('link'))) {
    throw new Error("Export du dossier des biens sans colonne de référence ni de fichier : voir docs/REPRISE.md, section « Import d'un agent ».");
  }
  const cell = (row: string[], field: PieceField): string | null => (columns.get(field) ?? []).map((i) => clean(row[i])).find((v) => v !== null) ?? null;
  const reading: PiecesReading = { lines: [], skipped: [] };
  for (const [index, row] of rows.entries()) {
    const line = index + 2;
    if (row.every((c) => c.trim() === '')) continue;
    const reference = cell(row, 'reference');
    if (reference === null || reference.length > 60) {
      reading.skipped.push({ line, reason: 'no_property' });
      continue;
    }
    const rawType = cell(row, 'type');
    // Sans colonne de type, une ligne dont le seul lien est une annonce reste un document : rien n'est deviné.
    const category = rawType === null ? 'document' : pieceCategory(rawType);
    if (category === undefined) {
      reading.skipped.push({ line, reason: 'unknown_type' });
      continue;
    }
    const rawFile = cell(row, 'file');
    const fileName = rawFile !== null && rawFile.length <= 200 ? rawFile : null;
    const rawLink = cell(row, 'link');
    const link = safeLink(rawLink);
    if (fileName === null && link === null) {
      reading.skipped.push({ line, reason: rawLink !== null ? 'unsafe_link' : 'no_source' });
      continue;
    }
    const rawSigned = cell(row, 'signed');
    const signed =
      category !== 'mandate' ? null
      : rawSigned !== null ? signatureSaid(rawSigned)
      : rawType !== null ? signatureInType(rawType)
      : null;
    const rawPortal = cell(row, 'portal');
    reading.lines.push({
      line,
      propertyOrigin: `import:${agentId}:${format}:bien:${await digest(reference)}`,
      category,
      label: (rawType ?? 'Document').slice(0, 120),
      fileName,
      link,
      datedOn: exportDay(cell(row, 'date')),
      signed,
      portal: category === 'diffusion' && rawPortal !== null ? rawPortal.slice(0, 80) : null,
      // La pièce telle que l'export l'écrit : relancé, le même fichier du même bien n'est jamais doublé.
      identity: await digest([reference, key(rawType ?? ''), rawFile ?? '', rawLink ?? '', cell(row, 'date') ?? ''].join('|')),
    });
  }
  return reading;
}

/** Une pièce reprise, telle que le dossier du bien la montre. */
export interface ImportedPiece {
  id: string;
  category: PieceCategory;
  label: string;
  fileName: string | null;
  link: string | null;
  datedOn: string | null;
  signed: boolean | null;
  portal: string | null;
  from: string;
}

/** Le bilan d'un dossier des biens : ce qui est repris par sorte, et chaque pièce écartée avec sa raison. */
export interface DossierReport {
  read: number;
  kept: Record<PieceCategory, number>;
  /** Déjà reprises par un import précédent, ou deux fois dans l'export : rien n'est doublé. */
  known: number;
  notTaken: Record<PieceSkip, number[]>;
  /** Mandats repris sans signature dite : à regarder avant de travailler le bien. */
  unsignedMandateLines: number[];
}

const emptyDossier = (reading: PiecesReading): DossierReport => ({
  read: reading.lines.length + reading.skipped.length,
  kept: Object.fromEntries(PIECE_CATEGORIES.map((c) => [c, 0])) as Record<PieceCategory, number>,
  known: 0,
  notTaken: Object.fromEntries(PIECE_SKIPS.map((r) => [r, reading.skipped.filter((x) => x.reason === r).map((x) => x.line)])) as Record<PieceSkip, number[]>,
  unsignedMandateLines: [],
});

/** Le compte rendu de l'aperçu, avant toute écriture : ce qui sera repris et tout ce qui ne le sera pas. */
export interface AgentImportPreview {
  format: AgentExportFormat;
  contacts: { read: number; unreadableLines: number[] };
  properties: { read: number; new: number; known: number; unreadableLines: number[] };
  dossier: DossierReport;
  summary: string[];
}

/* ---------- AU029 · Les échanges, notes de suivi et prochains rappels de l'ancien logiciel. ---------- */

/** Ce qui s'est passé avec un contact, repris tel quel sur sa fiche. */
export type ExchangeKind = 'call' | 'email' | 'sms' | 'whatsapp' | 'meeting' | 'visit' | 'note';
/** Ce que l'agent a prévu de faire : une tâche, jamais un message envoyé. */
export type ReminderAction = Exclude<ExchangeKind, 'note'> | 'task';

/** Les raisons, en liste fermée, d'une ligne d'historique non reprise. */
export const FOLLOW_UP_SKIPS = ['no_contact', 'unknown_contact', 'other_agent', 'ambiguous_contact', 'no_date', 'unknown_type', 'empty'] as const;
export type FollowUpSkip = (typeof FOLLOW_UP_SKIPS)[number];

/** Le texte gardé d'un échange ou d'une note, au plus. Au-delà, il est coupé et la ligne est signalée. */
export const FOLLOW_UP_TEXT_MAX = 2000;

type HistoryField = 'contactId' | 'email' | 'phone' | 'date' | 'due' | 'type' | 'body' | 'status';

const HISTORY_HEADERS: Record<HistoryField, string[]> = {
  contactId: ['idcontact', 'contactid', 'refcontact', 'referencecontact', 'numerocontact', 'ncontact', 'identifiantcontact', 'contactref'],
  email: CONTACT_HEADERS.email,
  phone: CONTACT_HEADERS.phone,
  date: ['date', 'dateaction', 'datedelaction', 'dateechange', 'datehistorique', 'datecreation', 'creele', 'datenote', 'faitle', 'datedevenement', 'dateevenement'],
  due: ['echeance', 'dateecheance', 'daterappel', 'rappelle', 'arappelerle', 'prochainrappel', 'prochaineaction', 'dateprochaineaction', 'duedate', 'pourle', 'aprevoirle', 'datelimite'],
  type: ['type', 'typeaction', 'typedaction', 'action', 'nature', 'canal', 'typeevenement', 'evenement', 'typeechange', 'activite', 'typeactivite'],
  body: ['note', 'notes', 'commentaire', 'commentaires', 'compterendu', 'objet', 'texte', 'description', 'detail', 'details', 'message', 'contenu', 'resume'],
  status: ['statut', 'etat', 'fait', 'realise', 'termine', 'status', 'done', 'cloture', 'traite'],
};

/** Les types d'un export, ramenés à une liste fermée. Un type inconnu n'est jamais deviné : la ligne est signalée. */
const EXCHANGE_TYPES: Readonly<Record<string, ExchangeKind | 'task'>> = Object.freeze({
  appel: 'call', appeltelephonique: 'call', telephone: 'call', tel: 'call', call: 'call', phone: 'call', appelsortant: 'call', appelentrant: 'call',
  mail: 'email', email: 'email', courriel: 'email', emailenvoye: 'email', emailrecu: 'email',
  sms: 'sms', texto: 'sms',
  whatsapp: 'whatsapp',
  rdv: 'meeting', rendezvous: 'meeting', meeting: 'meeting', rencontre: 'meeting', estimation: 'meeting', rdvestimation: 'meeting', entretien: 'meeting',
  visite: 'visit', visit: 'visit',
  note: 'note', notes: 'note', commentaire: 'note', suivi: 'note', memo: 'note', remarque: 'note', compterendu: 'note',
  rappel: 'task', relance: 'task', tache: 'task', todo: 'task', aprevoir: 'task', arappeler: 'task', task: 'task', reminder: 'task',
});

/** Un statut qui dit « fait ». Tout autre, vide compris, laisse un rappel ouvert. */
const DONE = new Set(['fait', 'faite', 'realise', 'realisee', 'termine', 'terminee', 'done', 'completed', 'clos', 'close', 'cloture', 'cloturee', 'traite', 'traitee', 'oui', 'yes', 'true', '1', 'x']);

export interface FollowUpLine {
  line: number;
  /** La clé d'origine du contact dans l'export des contacts (même format, même agent), s'il a un identifiant. */
  contactOrigin: string | null;
  emails: string[];
  phones: string[];
  entry: { as: 'history'; kind: ExchangeKind; on: string } | { as: 'reminder'; action: ReminderAction; on: string };
  /**
   * Ce qui identifie l'élément dans l'ancien logiciel (type, date, échéance), indépendamment de son classement du jour :
   * une action à venir reprise en rappel reste le même élément quand sa date est passée [R18].
   */
  identity: string;
  body: string | null;
  truncated: boolean;
}

export interface FollowUpReading {
  lines: FollowUpLine[];
  /** Les lignes non reprises dès la lecture, par raison. */
  skipped: { line: number; reason: FollowUpSkip }[];
}

/** La clé d'origine d'un contact d'export qui porte un identifiant, telle que `readAgentContacts` la fait. */
async function contactOriginById(agentId: string, format: AgentExportFormat, id: string): Promise<string> {
  return `import:${agentId}:${format}:id${await digest(id)}`;
}

/**
 * Lit un export d'historique (actions, échanges, notes, rappels). Chaque ligne désigne son contact par l'identifiant
 * de l'export des contacts, ou par son mail ou son téléphone. Une ligne datée dans le futur, ou une tâche pas faite,
 * est un rappel ; une ligne passée est un échange (ou une note). Rien n'est deviné : une ligne sans date lisible, sans
 * contact, d'un type inconnu ou d'une note vide est rendue avec sa raison.
 */
export async function readAgentFollowUp(text: string, format: AgentExportFormat, agentId: string, importedAt: Date): Promise<FollowUpReading> {
  const [header, ...rows] = parseCsv(text);
  const columns = columnsOf(header ?? [], HISTORY_HEADERS);
  if ((!columns.has('date') && !columns.has('due')) || (!columns.has('contactId') && !columns.has('email') && !columns.has('phone'))) {
    throw new Error("Export d'historique sans colonne de date ni de contact : voir docs/REPRISE.md, section « Import d'un agent ».");
  }
  const first = (row: string[], field: HistoryField): string | null => (columns.get(field) ?? []).map((i) => clean(row[i])).find((v) => v !== null) ?? null;
  const all = (row: string[], field: HistoryField): string[] => (columns.get(field) ?? []).map((i) => clean(row[i])).filter((v): v is string => v !== null).flatMap(many);
  const today = importedAt.toISOString().slice(0, 10);
  const reading: FollowUpReading = { lines: [], skipped: [] };
  for (const [index, row] of rows.entries()) {
    const line = index + 2;
    if (row.every((cell) => cell.trim() === '')) continue;
    const id = first(row, 'contactId');
    const emails = all(row, 'email');
    const phones = all(row, 'phone');
    if (id === null && contactIdentifiers({ emails, phones }).length === 0) {
      reading.skipped.push({ line, reason: 'no_contact' });
      continue;
    }
    const rawType = first(row, 'type');
    // Sans type dit, une ligne est une note de suivi : son texte seul compte.
    const type: ExchangeKind | 'task' | undefined = rawType === null ? 'note' : (EXCHANGE_TYPES[key(rawType)] ?? EXCHANGE_TYPES[key(rawType.split(/[\s/-]+/)[0] ?? '')]);
    if (type === undefined) {
      reading.skipped.push({ line, reason: 'unknown_type' });
      continue;
    }
    const day = exportDay(first(row, 'date'));
    const due = exportDay(first(row, 'due'));
    const rawStatus = first(row, 'status');
    const done = rawStatus !== null && DONE.has(key(rawStatus));
    // Objet, commentaire, compte rendu… : chaque texte de la ligne est gardé, dans l'ordre de l'export, sans doublon.
    const texts = [...new Set((columns.get('body') ?? []).map((i) => clean(row[i])).filter((v): v is string => v !== null))];
    const rawBody = texts.length === 0 ? null : texts.join(' · ');
    const truncated = rawBody !== null && rawBody.length > FOLLOW_UP_TEXT_MAX;
    const body = rawBody === null ? null : rawBody.slice(0, FOLLOW_UP_TEXT_MAX);

    let entry: FollowUpLine['entry'] | null = null;
    // Un statut dit et qui n'est pas « fait » : l'action reste à faire, même passée.
    const open = !done && rawStatus !== null;
    if (!done && due !== null) entry = { as: 'reminder', action: type === 'note' ? 'task' : type, on: due };
    else if (!done && day !== null && (type === 'task' || open || day > today)) entry = { as: 'reminder', action: type === 'note' ? 'task' : type, on: day };
    else if (day !== null || due !== null) {
      const on = day !== null && day <= today ? day : due !== null && due <= today ? due : null;
      // Un échange daté dans le futur et déjà « fait » : la date ne dit pas vrai, rien n'est deviné.
      if (on !== null) entry = { as: 'history', kind: type === 'task' ? 'note' : type, on };
    }
    if (entry === null) {
      reading.skipped.push({ line, reason: 'no_date' });
      continue;
    }
    // Une note sans texte ne garde rien ; un échange ou un rappel sans texte garde au moins son fait et sa date.
    if (entry.as === 'history' && entry.kind === 'note' && body === null) {
      reading.skipped.push({ line, reason: 'empty' });
      continue;
    }
    // Le jour et l'heure tels que l'export les écrit : deux appels du même jour, au même texte, restent deux appels.
    // Le texte entier, avant toute coupe, en fait partie : deux notes qui ne diffèrent qu'après la coupe restent deux.
    const identity = [type, (first(row, 'date') ?? '').replace(/\s+/g, ' '), (first(row, 'due') ?? '').replace(/\s+/g, ' '), await digest(rawBody ?? '')].join('|');
    reading.lines.push({ line, contactOrigin: id === null ? null : await contactOriginById(agentId, format, id), emails, phones, entry, identity, body, truncated });
  }
  return reading;
}

export interface ImportedExchange {
  id: string;
  kind: ExchangeKind;
  /** `AAAA-MM-JJ`, la date de l'ancien logiciel. */
  on: string;
  body: string | null;
  /** Le logiciel d'où il vient. */
  from: string;
}

export interface ImportedReminder {
  id: string;
  personId: string;
  action: ReminderAction;
  dueOn: string;
  body: string | null;
  from: string;
  done: boolean;
  /** À faire et dont l'échéance est passée. */
  late: boolean;
}

export interface AgentImportReport {
  format: AgentExportFormat;
  contacts: {
    read: number;
    created: number;
    matched: number;
    merged: number;
    /** Déjà suivis par un autre agent ou par personne : passés à la direction, fiche intacte. */
    toDirection: number;
    basis: Record<LegalBasis, number>;
    consents: number;
    exclusions: number;
    unreadableLines: number[];
    partialLines: number[];
    incompleteConsentLines: number[];
  };
  properties: { read: number; created: number; known: number; unreadableLines: number[] };
  /**
   * Les échanges, notes de suivi et prochains rappels de l'ancien logiciel (AU029) : ce qui est repris sur chaque fiche,
   * et le bilan de ce qui ne l'est pas, ligne par ligne, avec sa raison.
   */
  followUp: {
    read: number;
    history: number;
    reminders: number;
    /** Déjà repris par un import précédent, ou deux fois dans l'export : rien n'est doublé. */
    known: number;
    notTaken: Record<FollowUpSkip, number[]>;
    /** Repris, mais le texte dépassait la longueur gardée : coupé, à regarder. */
    truncatedLines: number[];
  };
  /**
   * Le dossier des biens repris (AU030) : photos, diagnostics, mandats, annonces et documents rangés sur chaque bien,
   * et chaque pièce écartée, ligne par ligne, avec sa raison.
   */
  dossier: DossierReport;
  /** Ce que l'agent peut faire maintenant, en une phrase par base. */
  summary: string[];
}

export type AgentImportRefusal = { ok: false; rule: 'R16' | null; code: string };

export interface ImportAgentOptions {
  now?: () => Date;
}

const placeholders = (n: number): string => Array.from({ length: n }, () => '?').join(', ');

/** Le compte rendu d'un import, en français, sans aucune donnée personnelle. */
export function importSummary(report: Pick<AgentImportReport, 'contacts' | 'properties'> & Partial<Pick<AgentImportReport, 'followUp' | 'dossier'>>): string[] {
  const c = report.contacts;
  const plural = (n: number, one: string, many: string): string => `${n} ${n > 1 ? many : one}`;
  const lines = [
    `${plural(c.basis.client, 'client', 'clients')} avec un mandat ou une vente : vous pouvez les suivre pour ce dossier.`,
    `${plural(c.basis.consent, 'contact', 'contacts')} avec un accord prouvé : seulement pour ce qu'ils ont accepté.`,
    `${plural(c.basis.none, 'contact', 'contacts')} sans accord prouvé : aucun premier message, jamais. Ils peuvent vous écrire, vous leur répondrez.`,
  ];
  if (c.toDirection > 0) lines.push(`${plural(c.toDirection, 'contact déjà suivi', 'contacts déjà suivis')} par un autre agent : la direction décide.`);
  const signaled = c.unreadableLines.length + c.partialLines.length + c.incompleteConsentLines.length + report.properties.unreadableLines.length;
  if (signaled > 0) lines.push(`${plural(signaled, 'ligne à regarder', 'lignes à regarder')}, listées par leur numéro.`);
  lines.push(`${plural(report.properties.created + report.properties.known, 'bien rangé', 'biens rangés')} en brouillon : rien n'est publié.`);
  const f = report.followUp;
  if (f && f.read + Object.values(f.notTaken).reduce((n, l) => n + l.length, 0) > 0) {
    lines.push(`${plural(f.history, 'échange ou note repris', 'échanges et notes repris')} sur ${f.history > 1 ? 'leurs fiches' : 'sa fiche'}, à leur date d'origine.`);
    lines.push(`${plural(f.reminders, 'rappel repris', 'rappels repris')} dans vos rappels : rien ne part tout seul.`);
    const skipped = Object.values(f.notTaken).reduce((n, l) => n + l.length, 0);
    lines.push(
      skipped === 0
        ? "Tout l'historique de l'export est repris."
        : `${plural(skipped, 'élément non repris', 'éléments non repris')}, listés par leur numéro de ligne et leur raison.`,
    );
  }
  const d = report.dossier;
  if (d && d.read > 0) lines.push(...dossierSummary(d));
  return lines;
}

/** Le bilan du dossier des biens, en français, sans aucune donnée personnelle (AU030). */
export function dossierSummary(d: DossierReport, future = false): string[] {
  const plural = (n: number, one: string, many: string): string => `${n} ${n > 1 ? many : one}`;
  const k = d.kept;
  const verb = future ? 'seront rangés' : 'rangés';
  const lines = [
    `Dossier des biens : ${plural(k.photo, 'photo ou média', 'photos et médias')}, ${plural(k.diagnostic, 'diagnostic', 'diagnostics')}, ${plural(k.mandate, 'mandat', 'mandats')}, ${plural(k.diffusion, 'annonce', 'annonces')} et ${plural(k.document, 'document', 'documents')} ${verb} sur leur bien.`,
  ];
  if (k.diffusion > 0) lines.push("Les annonces de l'ancien logiciel restent des liens : rien n'est republié, le bien reste en brouillon.");
  if (d.unsignedMandateLines.length > 0) {
    lines.push(d.unsignedMandateLines.length > 1 ? `${d.unsignedMandateLines.length} mandats sans signature dite, listés par leur numéro de ligne.` : '1 mandat sans signature dite, listé par son numéro de ligne.');
  }
  const skipped = Object.values(d.notTaken).reduce((n, l) => n + l.length, 0);
  lines.push(
    skipped === 0
      ? `Toutes les pièces de l'export ${future ? 'seront reprises' : 'sont reprises'}.`
      : `${plural(skipped, 'pièce non reprise', 'pièces non reprises')}, listées par leur numéro de ligne et leur raison.`,
  );
  return lines;
}

export class ImportAgent {
  private readonly now: () => Date;

  constructor(
    private readonly db: SqlDatabase,
    private readonly store: FicheClient,
    private readonly fiche: FicheUnique,
    private readonly decisions: DecisionEnvoi,
    private readonly journal: JournalStore,
    options: ImportAgentOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  private actor(viewer: Viewer): string {
    return `${String(viewer.role)}:${viewer.userId}`;
  }

  /** L'agent importe pour lui-même ; la direction pour un agent du réseau. Personne d'autre [R16]. */
  private async gate(viewer: Viewer, agentId: string): Promise<AgentImportRefusal | null> {
    const agent = await this.store.getAgent(agentId);
    let code: string | null = null;
    if (!agent || agent.network_id !== viewer.networkId) code = 'unknown';
    else if (agent.status !== 'active') code = 'agent_inactive';
    else if (viewer.role === 'direction') return null;
    else if (viewer.role === 'agent') code = viewer.userId === agentId ? null : 'not_assigned';
    else code = 'role';
    if (code === null) return null;
    await appendEvent(
      this.journal,
      { type: 'acces.refuse', actor: this.actor(viewer), subject: `agent:${agentId}`, data: { rule: 'R16', role: String(viewer.role), kind: 'agent_import', code } },
      this.now,
    );
    return { ok: false, rule: code === 'unknown' || code === 'agent_inactive' ? null : 'R16', code };
  }

  async run(
    viewer: Viewer,
    agentId: string,
    input: { format: unknown; contacts?: string; properties?: string; history?: string; pieces?: string },
  ): Promise<{ ok: true; report: AgentImportReport } | AgentImportRefusal> {
    const denied = await this.gate(viewer, agentId);
    if (denied) return denied;
    if (typeof input.format !== 'string' || !(AGENT_EXPORT_FORMATS as readonly string[]).includes(input.format)) return { ok: false, rule: null, code: 'unknown_format' };
    const format = input.format as AgentExportFormat;
    const networkId = viewer.networkId;
    const at = this.now();
    let contacts: AgentContactsReading;
    let properties: AgentPropertiesReading;
    let followUp: FollowUpReading;
    let pieces: PiecesReading;
    try {
      contacts = input.contacts === undefined ? { lines: [], unreadableLines: [], partialLines: [], incompleteConsentLines: [] } : await readAgentContacts(input.contacts, format, agentId, at);
      properties = input.properties === undefined ? { lines: [], unreadableLines: [] } : await readAgentProperties(input.properties, format, agentId);
      followUp = input.history === undefined ? { lines: [], skipped: [] } : await readAgentFollowUp(input.history, format, agentId, at);
      pieces = input.pieces === undefined ? { lines: [], skipped: [] } : await readAgentPieces(input.pieces, format, agentId);
    } catch (error) {
      await appendEvent(this.journal, { type: 'reseau.import_refuse', actor: this.actor(viewer), subject: `agent:${agentId}`, data: { format, code: 'unreadable_file' } }, this.now);
      return { ok: false, rule: null, code: error instanceof Error && error.message.includes('guillemets') ? 'malformed_file' : 'missing_columns' };
    }

    const report: AgentImportReport = {
      format,
      contacts: {
        read: contacts.lines.length,
        created: 0,
        matched: 0,
        merged: 0,
        toDirection: 0,
        basis: { client: 0, consent: 0, none: 0 },
        consents: 0,
        exclusions: 0,
        unreadableLines: contacts.unreadableLines,
        partialLines: contacts.partialLines,
        incompleteConsentLines: contacts.incompleteConsentLines,
      },
      properties: { read: properties.lines.length, created: 0, known: 0, unreadableLines: properties.unreadableLines },
      followUp: {
        read: followUp.lines.length + followUp.skipped.length,
        history: 0,
        reminders: 0,
        known: 0,
        notTaken: Object.fromEntries(FOLLOW_UP_SKIPS.map((r) => [r, followUp.skipped.filter((x) => x.reason === r).map((x) => x.line)])) as Record<FollowUpSkip, number[]>,
        truncatedLines: [],
      },
      dossier: emptyDossier(pieces),
      summary: [],
    };
    let changed = false;

    // 1. Écarter ce qui est suivi par un autre agent : la direction décide, la fiche n'est pas touchée [R16].
    // Deux lignes du même export pour la même personne : la première décide, la seconde suit son sort.
    const mine: AgentContactLine[] = [];
    const referredKeys = new Set<string>();
    for (const line of contacts.lines) {
      const keys = contactIdentifiers(line.contact).map((id) => matchKey(id.kind, id.value));
      const others = (await this.owners(networkId, line.contact)).filter((p) => p.agent_id !== agentId);
      if (others.length > 0 || keys.some((k) => referredKeys.has(k))) {
        for (const k of keys) referredKeys.add(k);
        for (const person of others) {
          const { changes } = await this.db.run(
            `INSERT INTO agent_import_referrals (network_id, origin_key, importing_agent_id, person_id, created_at) VALUES (?, ?, ?, ?, ?)
             ON CONFLICT DO NOTHING`,
            [networkId, line.contact.origin, agentId, person.id, at.toISOString()],
          );
          if (changes === 1) changed = true;
          // La fiche reste à l'autre agent, mais une désinscription dite dans l'export vaut arrêt partout [R04].
          if (line.contact.exclusion === 'stop' && (await this.addStop(person, at))) {
            report.contacts.exclusions += 1;
            changed = true;
          }
        }
        report.contacts.toDirection += 1;
        continue;
      }
      mine.push(line);
    }

    // 2. Les autres passent par la reprise : une seule fiche par personne, source « import », arrêts repris [R18, R04].
    if (mine.length > 0) {
      const reprise = new RepriseSite(this.db, this.store, this.fiche, this.decisions, this.journal, { networkId, agentId, actor: this.actor(viewer), now: this.now });
      const done: ImportReport = await reprise.run(
        { contacts: mine.map((l) => l.contact), skipped: { suspect: 0, test: 0 }, flagged: 0 },
        `import_${format}`,
      );
      report.contacts.created = done.created;
      report.contacts.matched = done.matched;
      report.contacts.merged = done.merged;
      report.contacts.exclusions += done.exclusions;
      // Une fiche retrouvée entre-temps chez un autre agent reste à part : comptée pour la direction.
      report.contacts.toDirection += done.apart;
      if (done.created + done.merged + done.exclusions > 0) changed = true;
    }

    // 3. Le tri de chaque contact, et ses accords prouvés, tels quels [R84, R03].
    for (const line of mine) {
      const target = await this.db.first<{ target_id: string }>('SELECT target_id FROM import_keys WHERE network_id = ? AND key = ?', [networkId, line.contact.origin]);
      if (!target) continue;
      const personId = await this.fiche.rootOf(target.target_id);
      const person = await this.store.getPerson(personId);
      if (!person || person.agent_id !== agentId) continue;
      report.contacts.basis[line.basis] += 1;
      const { changes } = await this.db.run(
        'INSERT INTO agent_import_contacts (network_id, agent_id, origin_key, person_id, basis, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING',
        [networkId, agentId, line.contact.origin, personId, line.basis, at.toISOString()],
      );
      if (changes === 1) changed = true;
      if (line.consent) {
        const added = await this.addConsents(person, line, format);
        report.contacts.consents += added;
        if (added > 0) changed = true;
      }
    }

    // 4. Les biens : à l'agent, en brouillon, une seule fois par référence d'export.
    for (const line of properties.lines) {
      const known = await this.db.first<{ property_id: string }>('SELECT property_id FROM agent_import_properties WHERE network_id = ? AND origin_key = ?', [networkId, line.origin]);
      if (known) {
        report.properties.known += 1;
        continue;
      }
      // Identifiant et référence tirés de la clé d'origine : deux imports en même temps, ou une relance après une
      // coupure entre les deux écritures, retombent sur le même bien [R18].
      const propertyId = await stableId(`${networkId}:${line.origin}`);
      const stamp = at.toISOString();
      const { changes } = await this.db.run(
        `INSERT INTO properties (id, network_id, agent_id, reference, kind, dwelling, postal_code, city, surface_m2, rooms, price_eur, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?) ON CONFLICT DO NOTHING`,
        [propertyId, networkId, agentId, `IMP-${propertyId.slice(0, 18).toUpperCase()}`, line.kind, line.dwelling ?? null, line.postalCode, line.city, line.surfaceM2, line.rooms, line.priceEur, stamp, stamp],
      );
      await this.db.run(
        `INSERT INTO agent_import_properties (network_id, origin_key, agent_id, property_id, export_reference, created_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT DO NOTHING`,
        [networkId, line.origin, agentId, propertyId, line.reference, stamp],
      );
      if (changes === 1) {
        report.properties.created += 1;
        changed = true;
      } else {
        report.properties.known += 1;
      }
    }

    // 5. Le dossier des biens : chaque pièce rejoint le bien repris de l'agent, sinon elle est au bilan (AU030).
    for (const line of pieces.lines) {
      // Les biens de ce dépôt sont déjà rangés (étape 4) : sans bien de l'agent, la pièce est au bilan.
      const target = (await this.pieceTarget(networkId, agentId, line, new Set())) ?? 'unknown_property';
      if ((PIECE_SKIPS as readonly string[]).includes(target)) {
        report.dossier.notTaken[target as PieceSkip].push(line.line);
        continue;
      }
      const origin = `import:${agentId}:${format}:piece:${line.identity}`;
      const { changes } = await this.db.run(
        `INSERT INTO agent_import_property_pieces (network_id, origin_key, agent_id, property_id, category, label, file_name, link_url, dated_on, signed, portal, source_format, export_line, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
        [networkId, origin, agentId, target, line.category, line.label, line.fileName, line.link, line.datedOn, line.signed === null ? null : line.signed ? 1 : 0, line.portal, format, line.line, at.toISOString()],
      );
      if (changes === 1) {
        changed = true;
        report.dossier.kept[line.category] += 1;
        if (line.category === 'mandate' && line.signed !== true) report.dossier.unsignedMandateLines.push(line.line);
      } else {
        report.dossier.known += 1;
      }
    }

    // 6. L'historique : chaque ligne rejoint la fiche de l'agent qui porte son contact, sinon elle est au bilan (AU029).
    for (const line of followUp.lines) {
      const found = await this.followUpTarget(networkId, agentId, line);
      if (typeof found === 'string') {
        report.followUp.notTaken[found].push(line.line);
        continue;
      }
      const personId = found.id;
      const e = line.entry;
      // Le contact tel que l'export le désigne, jamais la fiche du moment : deux fiches réunies depuis ne font pas
      // revenir un élément déjà repris, ni un rappel déjà fait [R18].
      const sourceContact = line.contactOrigin ?? contactIdentifiers({ emails: line.emails, phones: line.phones }).map((i) => `${i.kind}:${i.value}`).sort().join(',');
      const origin = `import:${agentId}:${format}:suivi:${await digest([sourceContact, line.identity].join('|'))}`;
      const stamp = at.toISOString();
      // Déjà repris, en échange ou en rappel : le même élément ne change pas de forme et n'est jamais doublé [R18].
      const already = await this.db.first<{ n: number }>(
        `SELECT (SELECT count(*) FROM agent_import_history WHERE network_id = ? AND origin_key = ?) + (SELECT count(*) FROM agent_import_reminders WHERE network_id = ? AND origin_key = ?) AS n`,
        [networkId, origin, networkId, origin],
      );
      const { changes } = Number(already?.n ?? 0) > 0
        ? { changes: 0 }
        : e.as === 'history'
          ? await this.db.run(
              `INSERT INTO agent_import_history (network_id, origin_key, agent_id, person_id, kind, happened_on, body, source_format, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
              [networkId, origin, agentId, personId, e.kind, e.on, line.body, format, stamp],
            )
          : await this.db.run(
              `INSERT INTO agent_import_reminders (network_id, origin_key, agent_id, person_id, action, due_on, body, source_format, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
              [networkId, origin, agentId, personId, e.action, e.on, line.body, format, stamp],
            );
      if (changes === 1) {
        changed = true;
        if (e.as === 'history') report.followUp.history += 1;
        else report.followUp.reminders += 1;
        if (line.truncated) report.followUp.truncatedLines.push(line.line);
      } else {
        report.followUp.known += 1;
      }
    }

    report.summary = importSummary(report);
    const signaled = report.contacts.unreadableLines.length + report.contacts.partialLines.length + report.contacts.incompleteConsentLines.length + report.properties.unreadableLines.length;
    const followUpSkipped = Object.values(report.followUp.notTaken).reduce((n, l) => n + l.length, 0);
    const piecesSkipped = Object.values(report.dossier.notTaken).reduce((n, l) => n + l.length, 0);
    if (changed || signaled > 0 || followUpSkipped > 0 || piecesSkipped > 0) {
      await appendEvent(
        this.journal,
        {
          type: 'reseau.import',
          actor: this.actor(viewer),
          subject: `agent:${agentId}`,
          data: {
            format,
            read: report.contacts.read,
            created: report.contacts.created,
            toDirection: report.contacts.toDirection,
            client: report.contacts.basis.client,
            consent: report.contacts.basis.consent,
            none: report.contacts.basis.none,
            consents: report.contacts.consents,
            properties: report.properties.created,
            signaledLines: signaled,
            history: report.followUp.history,
            reminders: report.followUp.reminders,
            followUpNotTaken: followUpSkipped,
            pieces: Object.values(report.dossier.kept).reduce((n, v) => n + v, 0),
            piecesNotTaken: piecesSkipped,
          },
        },
        this.now,
      );
    }
    return { ok: true, report };
  }

  /**
   * L'aperçu d'un import, avant toute écriture (AU030) : chaque bien et chaque pièce du dossier qui sera repris, et
   * chaque élément qui ne le sera pas, compté avec son numéro de ligne et sa raison. Rien n'est rangé, rien n'est
   * envoyé ; la validation se fait ensuite par `run`, qui rend le même bilan.
   */
  async preview(
    viewer: Viewer,
    agentId: string,
    input: { format: unknown; contacts?: string; properties?: string; pieces?: string },
  ): Promise<{ ok: true; report: AgentImportPreview } | AgentImportRefusal> {
    const denied = await this.gate(viewer, agentId);
    if (denied) return denied;
    if (typeof input.format !== 'string' || !(AGENT_EXPORT_FORMATS as readonly string[]).includes(input.format)) return { ok: false, rule: null, code: 'unknown_format' };
    const format = input.format as AgentExportFormat;
    const at = this.now();
    let contacts: AgentContactsReading;
    let properties: AgentPropertiesReading;
    let pieces: PiecesReading;
    try {
      contacts = input.contacts === undefined ? { lines: [], unreadableLines: [], partialLines: [], incompleteConsentLines: [] } : await readAgentContacts(input.contacts, format, agentId, at);
      properties = input.properties === undefined ? { lines: [], unreadableLines: [] } : await readAgentProperties(input.properties, format, agentId);
      pieces = input.pieces === undefined ? { lines: [], skipped: [] } : await readAgentPieces(input.pieces, format, agentId);
    } catch (error) {
      return { ok: false, rule: null, code: error instanceof Error && error.message.includes('guillemets') ? 'malformed_file' : 'missing_columns' };
    }
    const networkId = viewer.networkId;
    const report: AgentImportPreview = {
      format,
      contacts: { read: contacts.lines.length, unreadableLines: [...contacts.unreadableLines, ...contacts.partialLines, ...contacts.incompleteConsentLines].sort((a, b) => a - b) },
      properties: { read: properties.lines.length, new: 0, known: 0, unreadableLines: properties.unreadableLines },
      dossier: emptyDossier(pieces),
      summary: [],
    };
    // Les biens de ce dépôt seront rangés avant leurs pièces : une pièce de l'un d'eux sera reprise.
    const coming = new Set<string>();
    for (const line of properties.lines) {
      const known = await this.db.first<{ n: number }>('SELECT count(*) AS n FROM agent_import_properties WHERE network_id = ? AND origin_key = ?', [networkId, line.origin]);
      if (Number(known?.n ?? 0) > 0 || coming.has(line.origin)) report.properties.known += 1;
      else report.properties.new += 1;
      coming.add(line.origin);
    }
    const seen = new Set<string>();
    for (const line of pieces.lines) {
      const target = await this.pieceTarget(networkId, agentId, line, coming);
      if (target !== null && (PIECE_SKIPS as readonly string[]).includes(target)) {
        report.dossier.notTaken[target as PieceSkip].push(line.line);
        continue;
      }
      const origin = `import:${agentId}:${format}:piece:${line.identity}`;
      const known = await this.db.first<{ n: number }>('SELECT count(*) AS n FROM agent_import_property_pieces WHERE network_id = ? AND origin_key = ?', [networkId, origin]);
      if (Number(known?.n ?? 0) > 0 || seen.has(origin)) {
        report.dossier.known += 1;
        continue;
      }
      seen.add(origin);
      report.dossier.kept[line.category] += 1;
      if (line.category === 'mandate' && line.signed !== true) report.dossier.unsignedMandateLines.push(line.line);
    }
    report.summary = [
      `${report.properties.new} ${report.properties.new > 1 ? 'biens seront rangés' : 'bien sera rangé'} en brouillon, ${report.properties.unreadableLines.length} ${report.properties.unreadableLines.length > 1 ? 'lignes de biens à regarder' : 'ligne de biens à regarder'}.`,
      ...(report.dossier.read > 0 ? dossierSummary(report.dossier, true) : []),
      "Rien n'est encore rangé : validez pour lancer l'import.",
    ];
    // Au journal, des nombres seulement [R13].
    await appendEvent(
      this.journal,
      {
        type: 'reseau.import_apercu',
        actor: this.actor(viewer),
        subject: `agent:${agentId}`,
        data: { format, properties: report.properties.new, pieces: Object.values(report.dossier.kept).reduce((n, v) => n + v, 0), piecesNotTaken: Object.values(report.dossier.notTaken).reduce((n, l) => n + l.length, 0) },
      },
      this.now,
    );
    return { ok: true, report };
  }

  /**
   * Le bien repris auquel une pièce revient : celui que le même agent a repris depuis le même logiciel, sous la même
   * référence, et qu'il suit toujours. Rend son identifiant, null s'il arrive dans ce dépôt (aperçu), ou la raison.
   */
  private async pieceTarget(networkId: string, agentId: string, line: PieceLine, coming: Set<string>): Promise<string | PieceSkip | null> {
    const row = await this.db.first<{ property_id: string }>('SELECT property_id FROM agent_import_properties WHERE network_id = ? AND origin_key = ? AND agent_id = ?', [networkId, line.propertyOrigin, agentId]);
    if (!row) return coming.has(line.propertyOrigin) ? null : 'unknown_property';
    const property = await this.db.first<{ agent_id: string | null; network_id: string }>('SELECT agent_id, network_id FROM properties WHERE id = ?', [row.property_id]);
    if (!property || property.network_id !== networkId) return 'unknown_property';
    if (property.agent_id !== agentId) return 'other_agent';
    return row.property_id;
  }

  /**
   * Le dossier repris d'un bien : ses pièces par sorte, dans l'ordre de l'export. L'agent qui suit le bien, ou la
   * direction ; personne d'autre [R16]. Une annonce reprise est un lien, jamais une diffusion.
   */
  async dossierOf(viewer: Viewer, propertyId: string): Promise<{ ok: true; value: { propertyId: string; pieces: ImportedPiece[]; counts: Record<PieceCategory, number> } } | AgentImportRefusal> {
    const property = await this.db.first<{ agent_id: string | null; network_id: string }>('SELECT agent_id, network_id FROM properties WHERE id = ?', [propertyId]);
    let code: string | null = null;
    if (!property || property.network_id !== viewer.networkId) code = 'unknown';
    else if (viewer.role === 'direction') code = null;
    else if (viewer.role !== 'agent') code = 'role';
    else if (property.agent_id !== viewer.userId) code = 'not_assigned';
    if (code !== null) {
      await appendEvent(this.journal, { type: 'acces.refuse', actor: this.actor(viewer), subject: `property:${propertyId}`, data: { rule: 'R16', role: String(viewer.role), kind: 'agent_import_dossier', code } }, this.now);
      return { ok: false, rule: code === 'unknown' ? null : 'R16', code };
    }
    const rows = await this.db.all<{ origin_key: string; category: PieceCategory; label: string; file_name: string | null; link_url: string | null; dated_on: string | null; signed: number | null; portal: string | null; source_format: AgentExportFormat }>(
      `SELECT origin_key, category, label, file_name, link_url, dated_on, signed, portal, source_format FROM agent_import_property_pieces
       WHERE network_id = ? AND property_id = ? ORDER BY CASE category WHEN 'mandate' THEN 0 WHEN 'diagnostic' THEN 1 WHEN 'photo' THEN 2 WHEN 'diffusion' THEN 3 ELSE 4 END, export_line, origin_key`,
      [viewer.networkId, propertyId],
    );
    const pieces: ImportedPiece[] = rows.map((r) => ({
      id: r.origin_key,
      category: r.category,
      label: r.label,
      fileName: r.file_name,
      link: r.link_url,
      datedOn: r.dated_on,
      signed: r.signed === null ? null : r.signed === 1,
      portal: r.portal,
      from: FORMAT_LABEL[r.source_format],
    }));
    const counts = Object.fromEntries(PIECE_CATEGORIES.map((c) => [c, pieces.filter((p) => p.category === c).length])) as Record<PieceCategory, number>;
    // La lecture est au journal avant que rien ne soit rendu [R16] : des nombres seulement, jamais un fichier ni un lien [R13].
    await appendEvent(
      this.journal,
      { type: 'bien.lu', actor: this.actor(viewer), subject: `property:${propertyId}`, data: { rule: 'R16', role: String(viewer.role), via: 'import.dossier', pieces: pieces.length } },
      this.now,
    );
    return { ok: true, value: { propertyId, pieces, counts } };
  }

  /** Les contacts importés à passer à la direction, dans l'ordre d'arrivée. Direction seule [R16]. */
  async referrals(viewer: Viewer): Promise<{ ok: true; value: { personId: string; importingAgentId: string; createdAt: string }[] } | AgentImportRefusal> {
    if (viewer.role !== 'direction') {
      await appendEvent(this.journal, { type: 'acces.refuse', actor: this.actor(viewer), subject: null, data: { rule: 'R16', role: String(viewer.role), kind: 'agent_import_referrals', code: 'role' } }, this.now);
      return { ok: false, rule: 'R16', code: 'role' };
    }
    const rows = await this.db.all<{ person_id: string; importing_agent_id: string; created_at: string }>(
      'SELECT person_id, importing_agent_id, created_at FROM agent_import_referrals WHERE network_id = ? AND resolved_at IS NULL ORDER BY created_at, origin_key',
      [viewer.networkId],
    );
    return { ok: true, value: rows.map((r) => ({ personId: r.person_id, importingAgentId: r.importing_agent_id, createdAt: r.created_at })) };
  }

  /** La base la plus forte prouvée pour une fiche, toutes fiches réunies : `client`, puis `consent`, puis `none`. */
  async basisOf(personId: string): Promise<LegalBasis | null> {
    const members = await this.fiche.membersOf(personId);
    const rows = await this.db.all<{ basis: LegalBasis }>(`SELECT DISTINCT basis FROM agent_import_contacts WHERE person_id IN (${placeholders(members.length)})`, members);
    const set = new Set(rows.map((r) => r.basis));
    return set.has('client') ? 'client' : set.has('consent') ? 'consent' : set.has('none') ? 'none' : null;
  }

  /**
   * La fiche de l'agent à qui une ligne d'historique revient : par l'identifiant du contact de l'export d'abord, puis
   * par son mail ou son téléphone. Une fiche d'un autre agent n'est jamais touchée ; deux fiches possibles : rien
   * n'est deviné. Rend la fiche gardée, ou la raison de ne rien reprendre.
   */
  private async followUpTarget(networkId: string, agentId: string, line: FollowUpLine): Promise<Person | FollowUpSkip> {
    const roots = new Set<string>();
    if (line.contactOrigin !== null) {
      const byOrigin = await this.db.first<{ target_id: string }>('SELECT target_id FROM import_keys WHERE network_id = ? AND key = ?', [networkId, line.contactOrigin]);
      if (byOrigin) roots.add(await this.fiche.rootOf(byOrigin.target_id));
    }
    if (roots.size === 0) {
      for (const id of contactIdentifiers({ emails: line.emails, phones: line.phones })) {
        for (const p of await this.fiche.findByIdentifier(networkId, id.kind, id.value)) roots.add(p.id);
      }
    }
    if (roots.size === 0) return 'unknown_contact';
    const persons = (await Promise.all([...roots].map((id) => this.store.getPerson(id)))).filter((p): p is Person => p !== null);
    const mine = persons.filter((p) => p.agent_id === agentId);
    if (mine.length === 0) return persons.length === 0 ? 'unknown_contact' : 'other_agent';
    if (persons.length > 1) return 'ambiguous_contact';
    // Une fiche effacée ne reçoit jamais de texte en clair [R17] ; elle est dite introuvable, sans dire pourquoi.
    if (await this.fiche.isErased(mine[0]!.id)) return 'unknown_contact';
    return mine[0]!;
  }

  /** L'agent qui suit la fiche, ou la direction du réseau. Personne d'autre ; un refus est au journal [R16]. */
  private async gatePerson(viewer: Viewer, personId: string, kind: string): Promise<{ person: Person } | AgentImportRefusal> {
    const person = await this.store.getPerson(await this.fiche.rootOf(personId)).catch(() => null);
    let code: string | null = null;
    if (!person || person.network_id !== viewer.networkId) code = 'unknown';
    else if (viewer.role === 'direction') return { person };
    else if (viewer.role !== 'agent') code = 'role';
    else if (person.agent_id !== viewer.userId) code = 'not_assigned';
    else return { person };
    await appendEvent(this.journal, { type: 'acces.refuse', actor: this.actor(viewer), subject: `person:${personId}`, data: { rule: 'R16', role: String(viewer.role), kind, code } }, this.now);
    return { ok: false, rule: code === 'unknown' ? null : 'R16', code };
  }

  /**
   * Le suivi repris d'une fiche, toutes fiches réunies : ses échanges et notes, du plus récent au plus ancien, et ses
   * rappels, du plus proche au plus lointain, chacun dit fait ou non, et en retard s'il est passé [R16].
   */
  async followUpOf(viewer: Viewer, personId: string): Promise<{ ok: true; value: { history: ImportedExchange[]; reminders: ImportedReminder[] } } | AgentImportRefusal> {
    const gate = await this.gatePerson(viewer, personId, 'agent_import_follow_up');
    if (!('person' in gate)) return gate;
    const members = await this.fiche.membersOf(gate.person.id);
    const history = await this.db.all<{ origin_key: string; kind: ExchangeKind; happened_on: string; body: string | null; source_format: AgentExportFormat }>(
      `SELECT origin_key, kind, happened_on, body, source_format FROM agent_import_history WHERE network_id = ? AND person_id IN (${placeholders(members.length)})
       ORDER BY happened_on DESC, origin_key`,
      [viewer.networkId, ...members],
    );
    const reminders = await this.remindersWhere(viewer.networkId, `r.person_id IN (${placeholders(members.length)})`, members);
    // La lecture est au journal avant que rien ne soit rendu [R16] : des nombres et des identifiants internes [R13].
    await appendEvent(
      this.journal,
      {
        type: 'fiche.lue',
        actor: this.actor(viewer),
        subject: personSubject(gate.person.id),
        data: { rule: 'R16', role: String(viewer.role), via: 'import.suivi', history: history.length, reminders: reminders.length, members: members.map((m) => personSubject(m)) },
      },
      this.now,
    );
    return {
      ok: true,
      value: {
        history: history.map((h) => ({ id: h.origin_key, kind: h.kind, on: h.happened_on, body: h.body, from: FORMAT_LABEL[h.source_format] })),
        reminders,
      },
    };
  }

  /** Les rappels repris encore à faire de l'agent, du plus en retard au plus lointain. L'agent seul, pour lui-même. */
  async openReminders(viewer: Viewer): Promise<{ ok: true; value: ImportedReminder[] } | AgentImportRefusal> {
    if (viewer.role !== 'agent') {
      await appendEvent(this.journal, { type: 'acces.refuse', actor: this.actor(viewer), subject: null, data: { rule: 'R16', role: String(viewer.role), kind: 'agent_import_reminders', code: 'role' } }, this.now);
      return { ok: false, rule: 'R16', code: 'role' };
    }
    // Les rappels suivent la fiche : ceux que l'agent a repris, et ceux des fiches qu'il suit aujourd'hui, réunies
    // comprises ; puis seule compte la fiche gardée et son agent du moment.
    const all = await this.remindersWhere(
      viewer.networkId,
      `(r.agent_id = ? OR r.person_id IN (SELECT id FROM persons WHERE agent_id = ? AND network_id = r.network_id)
        OR r.person_id IN (SELECT m.merged_id FROM person_merges m JOIN persons p ON p.id = m.survivor_id WHERE m.undone_at IS NULL AND p.agent_id = ?))`,
      [viewer.userId, viewer.userId, viewer.userId],
    );
    const open: ImportedReminder[] = [];
    for (const r of all) {
      if (r.done) continue;
      const person = await this.store.getPerson(await this.fiche.rootOf(r.personId));
      if (person && person.agent_id === viewer.userId) open.push({ ...r, personId: person.id });
    }
    await appendEvent(this.journal, { type: 'reseau.import_rappels_lus', actor: this.actor(viewer), subject: `agent:${viewer.userId}`, data: { rule: 'R16', count: open.length } }, this.now);
    return { ok: true, value: open };
  }

  /** L'agent qui suit la fiche marque un rappel repris comme fait : une fois, jamais défait [R17]. */
  async closeReminder(viewer: Viewer, reminderId: unknown): Promise<{ ok: true; value: { id: string; closedAt: string } } | AgentImportRefusal> {
    if (typeof reminderId !== 'string' || reminderId.length === 0 || reminderId.length > 200) return { ok: false, rule: null, code: 'unknown' };
    const row = await this.db.first<{ person_id: string }>('SELECT person_id FROM agent_import_reminders WHERE network_id = ? AND origin_key = ?', [viewer.networkId, reminderId]);
    if (!row) return { ok: false, rule: null, code: 'unknown' };
    const gate = await this.gatePerson(viewer, row.person_id, 'agent_import_reminder_close');
    if (!('person' in gate)) return gate;
    if (viewer.role !== 'agent') return { ok: false, rule: 'R16', code: 'role' };
    const closedAt = this.now().toISOString();
    const { changes } = await this.db.run(
      'INSERT INTO agent_import_reminder_closures (network_id, origin_key, closed_by, closed_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING',
      [viewer.networkId, reminderId, viewer.userId, closedAt],
    );
    if (changes !== 1) return { ok: false, rule: null, code: 'already_done' };
    await appendEvent(this.journal, { type: 'reseau.import_rappel_fait', actor: this.actor(viewer), subject: `person:${gate.person.id}`, data: {} }, this.now);
    return { ok: true, value: { id: reminderId, closedAt } };
  }

  private async remindersWhere(networkId: string, where: string, params: SqlValue[]): Promise<ImportedReminder[]> {
    const today = this.now().toISOString().slice(0, 10);
    const rows = await this.db.all<{ origin_key: string; person_id: string; action: ReminderAction; due_on: string; body: string | null; source_format: AgentExportFormat; closed_at: string | null }>(
      `SELECT r.origin_key, r.person_id, r.action, r.due_on, r.body, r.source_format, c.closed_at FROM agent_import_reminders r
       LEFT JOIN agent_import_reminder_closures c ON c.network_id = r.network_id AND c.origin_key = r.origin_key
       WHERE r.network_id = ? AND ${where} ORDER BY r.due_on, r.origin_key`,
      [networkId, ...params],
    );
    return rows.map((r) => ({
      id: r.origin_key,
      personId: r.person_id,
      action: r.action,
      dueOn: r.due_on,
      body: r.body,
      from: FORMAT_LABEL[r.source_format],
      done: r.closed_at !== null,
      late: r.closed_at === null && r.due_on < today,
    }));
  }

  /** Les fiches qui portent déjà une coordonnée de la ligne, ou ses clés de contact, ou son origine. */
  private async owners(networkId: string, contact: ImportedContact): Promise<Person[]> {
    const ids = contactIdentifiers(contact);
    const found: Person[] = [];
    for (const id of ids) found.push(...(await this.fiche.findByIdentifier(networkId, id.kind, id.value)));
    const keys = await keyLookupForms(networkId, ids.map((id) => matchKey(id.kind, id.value)));
    const rows = keys.length === 0 ? [] : await this.db.all<{ person_id: string }>(
      `SELECT DISTINCT person_id FROM contact_keys WHERE network_id = ? AND key IN (${placeholders(keys.length)})`,
      [networkId, ...keys],
    );
    const origin = await this.db.first<{ target_id: string }>('SELECT target_id FROM import_keys WHERE network_id = ? AND key = ?', [networkId, contact.origin]);
    const more = [...rows.map((r) => r.person_id), ...(origin ? [origin.target_id] : [])];
    const roots = new Set<string>([...found.map((p) => p.id)]);
    for (const id of more) roots.add(await this.fiche.rootOf(id));
    const persons = await Promise.all([...roots].map((id) => this.store.getPerson(id)));
    return persons.filter((p): p is Person => p !== null);
  }

  /** Arrêt sur tous les canaux, sauf s'il y en a déjà un en cours sur la fiche réunie [R04]. */
  private async addStop(person: Person, at: Date): Promise<boolean> {
    const members = await this.fiche.membersOf(person.id);
    const active = await this.db.first<{ n: number }>(
      `SELECT count(*) AS n FROM exclusions WHERE person_id IN (${placeholders(members.length)}) AND reason = 'stop' AND lifted_at IS NULL`,
      members,
    );
    if (Number(active?.n ?? 0) > 0) return false;
    await this.store.addExclusion({ networkId: person.network_id, agentId: person.agent_id, personId: person.id, reason: 'stop', channel: null, notedAt: at });
    return true;
  }

  private async addConsents(person: Person, line: AgentContactLine, format: AgentExportFormat): Promise<number> {
    const consent = line.consent!;
    const ids = contactIdentifiers(line.contact);
    const hasEmail = ids.some((i) => i.kind === 'email');
    const hasPhone = ids.some((i) => i.kind === 'phone');
    const wanted: Channel[] = consent.channels.length > 0 ? consent.channels : hasEmail ? ['email'] : []; // Sans canal dit, jamais le téléphone : un appel demande un accord prouvé [R03].
    // Un accord ne vaut que sur une coordonnée de la ligne.
    const channels = wanted.filter((c) => (c === 'email' ? hasEmail : hasPhone));
    const proof = `import ${FORMAT_LABEL[format]} · ${consent.proof}`;
    const members = await this.fiche.membersOf(person.id);
    let added = 0;
    const givenAt = `${consent.givenOn}T12:00:00.000Z`;
    for (const channel of channels) {
      // Déjà connu, de n'importe quelle source, ou retiré après la date de cet accord : rien n'est rangé. Un export
      // ancien ne fait jamais revenir un accord que la personne a retiré [R03].
      const known = await this.db.first<{ n: number }>(
        `SELECT count(*) AS n FROM consents WHERE person_id IN (${placeholders(members.length)}) AND purpose = ? AND channel = ?
         AND (proof = ? OR given_at = ? OR (withdrawn_at IS NOT NULL AND withdrawn_at >= ?))`,
        [...members, consent.purpose, channel, proof, givenAt, givenAt],
      );
      if (Number(known?.n ?? 0) > 0) continue;
      await this.store.addConsent({
        networkId: person.network_id,
        agentId: person.agent_id,
        personId: person.id,
        purpose: consent.purpose,
        channel,
        proof,
        givenAt: new Date(givenAt),
      });
      added += 1;
    }
    return added;
  }
}
