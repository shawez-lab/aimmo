import type { SqlDatabase } from '../db/sql.ts';
import { readOnly } from './lecture-seule.ts';

/**
 * Lecture de la base D1 `espace-estimation` du site shawez-immo.com, pour la reprise des contacts (I01).
 * Schéma d'origine : `functions/schema.sql` et `functions/_lib/base.js` du dépôt du site.
 * Rien n'est écrit dans cette base : toutes les requêtes passent par `readOnly`.
 */

export interface SiteRequest {
  reference: string;
  /** Type de bien demandé à l'estimation, tel que le site l'a rangé. */
  type: string | null;
  postalCode: string | null;
  city: string | null;
  /** Étape du site : recue, appele, visite, avis, mandat, annonce, visites, offre, compromis, acte, pause, close. */
  status: string;
  /** Raison notée par l'agence pour « Pas maintenant » ou « Perdu ». */
  reason: string | null;
  createdAt: string;
  statusAt: string | null;
}

export type SiteProblem = 'contact_illisible' | 'sans_coordonnees';

export interface SiteContact {
  /** Clé d'origine, stable d'une lecture à l'autre : `site:compte:<id>` ou `site:demande:<référence>`. */
  origin: string;
  /** Coordonnées telles que le site les a rangées, sans doublon ; la normalisation vient à la reprise. */
  emails: string[];
  phones: string[];
  civility: string | null;
  firstName: string | null;
  lastName: string | null;
  createdAt: string;
  /** Date de l'accord donné sur le site, s'il y en a un. */
  consentAt: string | null;
  /** Adresse mail prouvée par un lien reçu. */
  verified: boolean;
  requests: SiteRequest[];
  /** Ce qui n'a pas pu être lu : le contact est gardé et signalé, jamais jeté. */
  problems: SiteProblem[];
}

export interface SiteReading {
  contacts: SiteContact[];
  skipped: {
    /** Demandes marquées robot probable par le site. */
    suspect: number;
    /** Comptes et demandes dont toutes les adresses sont des adresses de test. */
    test: number;
  };
  /** Contacts gardés avec au moins un problème. */
  flagged: number;
}

interface CompteRow {
  id: number;
  email: string | null;
  civilite?: string | null;
  prenom?: string | null;
  nom?: string | null;
  telephone?: string | null;
  verifie?: number | null;
  consentement_le?: string | null;
  cree_le: string;
}

interface DemandeRow {
  id: number;
  reference: string;
  compte_id: number | null;
  type?: string | null;
  code_postal?: string | null;
  commune?: string | null;
  contact?: string | null;
  statut?: string | null;
  raison?: string | null;
  statut_le?: string | null;
  suspect?: number | null;
  cree_le: string;
}

interface ContactJson {
  civilite?: unknown;
  prenom?: unknown;
  nom?: unknown;
  email?: unknown;
  telephone?: unknown;
}

/** Les adresses de test du site, que ses mails n'envoient jamais (`functions/_lib/mail.js`). */
export const isTestAddress = (email: string): boolean => /@(?:[a-z0-9-]+\.)*test\.invalid$/i.test(email);

const text = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
};

function parseContact(raw: string | null | undefined): ContactJson | null {
  if (raw === null || raw === undefined) return null;
  try {
    const value: unknown = JSON.parse(raw);
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as ContactJson) : null;
  } catch {
    return null;
  }
}

const pushUnique = (list: string[], value: string | null): void => {
  if (value !== null && !list.some((item) => item.toLowerCase() === value.toLowerCase())) list.push(value);
};

function toRequest(row: DemandeRow): SiteRequest {
  return {
    reference: row.reference,
    type: text(row.type),
    postalCode: text(row.code_postal),
    city: text(row.commune),
    status: text(row.statut) ?? 'recue',
    reason: text(row.raison),
    createdAt: row.cree_le,
    statusAt: text(row.statut_le),
  };
}

/** Une ligne de demande apporte ses coordonnées au contact ; rend faux si son contact est illisible. */
function addRequestContact(contact: SiteContact, row: DemandeRow): boolean {
  const json = parseContact(row.contact);
  if (json === null) return false;
  pushUnique(contact.emails, text(json.email));
  pushUnique(contact.phones, text(json.telephone));
  contact.civility ??= text(json.civilite);
  contact.firstName ??= text(json.prenom);
  contact.lastName ??= text(json.nom);
  return true;
}

const onlyTestAddresses = (contact: SiteContact): boolean =>
  contact.emails.length > 0 && contact.emails.every(isTestAddress);

/**
 * Lit les contacts à reprendre : un contact par compte, avec ses demandes, et un par demande sans compte.
 * Les tables ou colonnes ajoutées après la première mise en service du site peuvent manquer.
 */
export async function readSiteContacts(source: SqlDatabase): Promise<SiteReading> {
  const db = readOnly(source);
  const tables = new Set(
    (await db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")).map((row) => row.name),
  );
  const comptes = tables.has('comptes') ? await db.all<CompteRow>('SELECT * FROM comptes ORDER BY id') : [];
  const demandes = tables.has('demandes') ? await db.all<DemandeRow>('SELECT * FROM demandes ORDER BY id') : [];

  const reading: SiteReading = { contacts: [], skipped: { suspect: 0, test: 0 }, flagged: 0 };
  const byAccount = new Map<number, SiteContact>();

  for (const row of comptes) {
    const contact: SiteContact = {
      origin: `site:compte:${row.id}`,
      emails: [],
      phones: [],
      civility: text(row.civilite),
      firstName: text(row.prenom),
      lastName: text(row.nom),
      createdAt: row.cree_le,
      consentAt: text(row.consentement_le),
      verified: Number(row.verifie ?? 0) === 1,
      requests: [],
      problems: [],
    };
    pushUnique(contact.emails, text(row.email));
    pushUnique(contact.phones, text(row.telephone));
    byAccount.set(Number(row.id), contact);
  }

  const standalone: SiteContact[] = [];
  for (const row of demandes) {
    if (Number(row.suspect ?? 0) === 1) {
      reading.skipped.suspect += 1;
      continue;
    }
    const owner = row.compte_id === null || row.compte_id === undefined ? undefined : byAccount.get(Number(row.compte_id));
    if (owner) {
      owner.requests.push(toRequest(row));
      if (!addRequestContact(owner, row) && !owner.problems.includes('contact_illisible')) owner.problems.push('contact_illisible');
      continue;
    }
    const contact: SiteContact = {
      origin: `site:demande:${row.reference}`,
      emails: [],
      phones: [],
      civility: null,
      firstName: null,
      lastName: null,
      createdAt: row.cree_le,
      consentAt: null,
      verified: false,
      requests: [toRequest(row)],
      problems: [],
    };
    if (!addRequestContact(contact, row)) contact.problems.push('contact_illisible');
    standalone.push(contact);
  }

  for (const contact of [...byAccount.values(), ...standalone]) {
    if (onlyTestAddresses(contact)) {
      reading.skipped.test += 1;
      continue;
    }
    if (contact.emails.length === 0 && contact.phones.length === 0 && !contact.problems.includes('contact_illisible')) {
      contact.problems.push('sans_coordonnees');
    }
    if (contact.problems.length > 0) reading.flagged += 1;
    reading.contacts.push(contact);
  }
  return reading;
}
