/**
 * Reprise des contacts du site dans la fiche client unique (I02).
 * Chaque contact lu (I01) devient ou complète une fiche : identifiants normalisés, source, projet par demande
 * d'estimation, accord donné sur le site, exclusion pour « Perdu ». Relançable sans rien doubler.
 * Ne crée jamais d'accord de prospection [R03], n'efface rien [R17], n'écrit au journal que des identifiants
 * internes et des nombres [R13]. N'envoie rien.
 */
import { storedForms } from '../fiche/empreinte.ts';
import type { FicheClient } from '../db/fiche-client.ts';
import type { SqlDatabase } from '../db/sql.ts';
import type { Channel, IdentifierKind, Person } from '../db/types.ts';
import { classifyReceived, type DecisionEnvoi, type ReceivedExclusion } from '../envoi/service.ts';
import type { FicheUnique } from '../fiche/fusion.ts';
import { matchKey, normalizeIdentifier } from '../fiche/normalize.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import type { SiteContact, SiteReading, SiteRequest } from './site.ts';

/** Finalité du seul accord repris du site : le suivi de l'estimation que la personne a demandée. */
export const VALUATION_PURPOSE = 'valuation_follow_up';

/** Statut « Perdu » du site. */
export const SITE_LOST = 'close';

/**
 * Un contact à reprendre : un contact du site (I01), ou une ligne d'un fichier d'outil (I03) qui apporte en plus
 * des comptes Instagram, sa propre source et, pour une liste d'exclusion ou un désabonnement, une exclusion.
 */
export interface ImportedContact extends SiteContact {
  instagrams?: string[];
  source?: { channel: string; detail: string };
  /** `network_list` : liste d'exclusion [R02] ; `stop` : désabonné de l'outil [R04]. */
  exclusion?: 'network_list' | 'stop' | null;
}

export interface ImportBatch {
  contacts: ImportedContact[];
  skipped: { suspect: number; test: number };
  flagged: number;
  /** Lignes d'un fichier signalées par leur numéro (I03). */
  unreadableLines?: number[];
  partialLines?: number[];
}

export type ImportOutcome = 'created' | 'matched' | 'merged' | 'apart';

export interface ImportReport {
  read: number;
  created: number;
  matched: number;
  merged: number;
  /** Fiches retrouvées mais suivies par un autre agent : la direction doit attribuer la personne. */
  apart: number;
  /** Contacts gardés avec un problème de lecture, à regarder par l'agent. */
  flagged: number;
  /** Contacts sans aucun identifiant valable : fiche créée quand même, jamais rapprochée d'une autre. */
  withoutIdentifier: number;
  projects: number;
  consents: number;
  exclusions: number;
  skipped: { suspect: number; test: number };
  /** Numéros des lignes de fichier sans coordonnée lisible, ou avec une coordonnée laissée de côté. */
  unreadableLines: number[];
  partialLines: number[];
}

export interface RepriseOptions {
  networkId: string;
  /** L'agent à qui les fiches reprises sont confiées. */
  agentId: string;
  /** Qui lance la reprise, pour le journal. */
  actor: string;
  now?: () => Date;
}

interface Identifier {
  kind: IdentifierKind;
  value: string;
}

const placeholders = (n: number): string => Array.from({ length: n }, () => '?').join(', ');

/** Identifiants valables du contact, normalisés et sans doublon. Une valeur incomprise n'est jamais rapprochée. */
export function contactIdentifiers(contact: Pick<ImportedContact, 'emails' | 'phones' | 'instagrams'>): Identifier[] {
  const out: Identifier[] = [];
  const seen = new Set<string>();
  const add = (kind: IdentifierKind, raw: string): void => {
    const value = normalizeIdentifier(kind, raw);
    if (value === null || seen.has(`${kind}:${value}`)) return;
    seen.add(`${kind}:${value}`);
    out.push({ kind, value });
  };
  for (const email of contact.emails) add('email', email);
  for (const phone of contact.phones) add('phone', phone);
  for (const account of contact.instagrams ?? []) add('instagram', account);
  return out;
}

/** Ce qu'une demande « Perdu » impose. Dans le doute, refus [R02] ; « vendu » ou « stop » si la raison le dit. */
export function lostExclusion(request: SiteRequest): ReceivedExclusion | null {
  if (request.status !== SITE_LOST) return null;
  const said = request.reason === null ? null : classifyReceived(request.reason);
  return said ?? 'refused';
}

export class RepriseSite {
  private readonly now: () => Date;

  constructor(
    private readonly db: SqlDatabase,
    private readonly store: FicheClient,
    private readonly fiche: FicheUnique,
    private readonly decisions: DecisionEnvoi,
    private readonly journal: JournalStore,
    private readonly options: RepriseOptions,
  ) {
    this.now = options.now ?? (() => new Date());
  }

  /** `label` : d'où vient le lot, pour le journal (`site`, `exclusion_list`, `gohighlevel`, `manychat`). */
  async run(reading: SiteReading | ImportBatch, label = 'site'): Promise<ImportReport> {
    const agent = await this.store.getAgent(this.options.agentId);
    if (!agent || agent.network_id !== this.options.networkId || agent.status !== 'active') {
      throw new Error('Reprise : agent inconnu, hors réseau ou parti.');
    }
    const report: ImportReport = {
      read: reading.contacts.length,
      created: 0,
      matched: 0,
      merged: 0,
      apart: 0,
      flagged: reading.flagged,
      withoutIdentifier: 0,
      projects: 0,
      consents: 0,
      exclusions: 0,
      skipped: { ...reading.skipped },
      unreadableLines: 'unreadableLines' in reading ? [...(reading.unreadableLines ?? [])] : [],
      partialLines: 'partialLines' in reading ? [...(reading.partialLines ?? [])] : [],
    };
    let changed = false;
    for (const contact of reading.contacts) {
      if (await this.importContact(contact, report)) changed = true;
    }
    // Une reprise relancée qui ne trouve rien de neuf n'écrit rien, pas même au journal.
    // Des lignes signalées valent une trace même si rien d'autre n'a changé : elles attendent un humain.
    if (changed || report.unreadableLines.length > 0 || report.partialLines.length > 0) {
      await appendEvent(
        this.journal,
        {
          type: 'reprise.lot',
          actor: this.options.actor,
          subject: null,
          data: {
            source: label,
            read: report.read,
            created: report.created,
            matched: report.matched,
            merged: report.merged,
            apart: report.apart,
            projects: report.projects,
            consents: report.consents,
            exclusions: report.exclusions,
            skippedSuspect: report.skipped.suspect,
            skippedTest: report.skipped.test,
            unreadableLines: report.unreadableLines.length,
            partialLines: report.partialLines.length,
          },
        },
        this.now,
      );
    }
    return report;
  }

  /** Rend vrai si la reprise de ce contact a écrit quelque chose. */
  private async importContact(contact: ImportedContact, report: ImportReport): Promise<boolean> {
    const networkId = this.options.networkId;
    const at = this.now();
    const identifiers = contactIdentifiers(contact);
    if (identifiers.length === 0) report.withoutIdentifier += 1;
    const keys = identifiers.map((id) => matchKey(id.kind, id.value)).sort();
    const originKey = contact.origin;
    let changed = false;

    // 1. Retrouver : la fiche déjà reprise pour cette origine, puis toute fiche qui porte un identifiant du contact.
    let roots: Person[] = [];
    const known = await this.importTarget(originKey);
    if (known) roots.push(...(await this.existing([known])));
    for (const id of identifiers) roots.push(...(await this.fiche.findByIdentifier(networkId, id.kind, id.value)));
    roots.push(...(await this.keyOwners(keys)));
    roots = await this.distinctRoots(roots);

    let outcome: ImportOutcome;
    if (roots.length === 0) {
      const created = await this.store.createPerson({
        networkId,
        agentId: this.options.agentId,
        firstName: contact.firstName,
        lastName: contact.lastName,
      });
      roots = [created];
      outcome = 'created';
      changed = true;
    } else {
      outcome = roots.length === 1 ? 'matched' : 'merged';
    }
    // L'origine est notée aussitôt : une reprise coupée net retrouve cette fiche et ne la recrée pas.
    if (await this.claimImport(originKey, 'person', (roots[0] as Person).id, at)) changed = true;
    if (keys.length > 0) await this.claimKeys(roots[0] as Person, keys, at);
    // Une reprise simultanée a peut-être pris l'origine ou une clé avant nous : sa fiche rejoint les nôtres.
    const winner = await this.importTarget(originKey);
    roots.push(...(await this.existing(winner === null ? [] : [winner])), ...(await this.keyOwners(keys)));
    roots = await this.distinctRoots(roots);

    // 2. Une seule fiche par personne : réunir, sauf si un autre agent suit une des fiches.
    const { target, apart, merged } = await this.mergeAll(roots);
    // Seule une fusion vraiment écrite compte : des fiches restées à part ne changent rien à la relance.
    if (merged > 0) changed = true;
    if (apart.length > 0) outcome = 'apart';

    // 3. Compléter : identifiants, nom, source.
    if (await this.complete(target, identifiers, contact)) changed = true;
    if (await this.addContactSource(target, contact)) changed = true;

    // 4. Un projet par demande d'estimation, avec son accord et, pour « Perdu », l'exclusion.
    const exclusionsBefore = report.exclusions;
    for (const request of contact.requests) {
      if (await this.importRequest(target, contact, request, identifiers, report)) changed = true;
      const reason = lostExclusion(request);
      if (reason) {
        const notedAt = new Date(request.statusAt ?? request.createdAt);
        for (const person of [target, ...apart]) {
          const before = await this.activeExclusions(person.id, reason);
          await this.decisions.recordExclusion({ networkId, agentId: person.agent_id, personId: person.id, at: notedAt, reason });
          if ((await this.activeExclusions(person.id, reason)) > before) report.exclusions += 1;
        }
      }
    }
    // Liste d'exclusion [R02] ou désabonnement d'un outil [R04] : sur toutes les fiches de la personne.
    if (contact.exclusion) {
      for (const person of [target, ...apart]) {
        if (await this.addToolExclusion(person, contact.exclusion, at)) report.exclusions += 1;
      }
    }
    // Fiches restées à part : la même personne, donc toute exclusion en cours de l'une vaut pour toutes [R02, R04].
    if (apart.length > 0) report.exclusions += await this.shareExclusions([target, ...apart], at);
    if (report.exclusions > exclusionsBefore) changed = true;

    // 5. L'accord donné en ouvrant son compte sur le site, pour le suivi de ses demandes seulement.
    if (contact.consentAt !== null) {
      const proof = `${contact.origin} · accord du site`;
      if (await this.addConsents(target, identifiers, proof, new Date(contact.consentAt), report)) changed = true;
    }

    report[outcome] += 1;
    if (changed) {
      await appendEvent(
        this.journal,
        {
          type: 'reprise.fiche',
          actor: this.options.actor,
          subject: `person:${target.id}`,
          data: { source: contact.source?.channel ?? 'site', outcome, requests: contact.requests.length, apart: apart.map((p) => `person:${p.id}`) },
        },
        this.now,
      );
    }
    return changed;
  }

  /** Exclusion sur tous les canaux, sauf si la même est déjà en cours. */
  private async addToolExclusion(person: Person, reason: 'network_list' | 'stop', at: Date): Promise<boolean> {
    if ((await this.activeExclusions(person.id, reason)) > 0) return false;
    await this.store.addExclusion({ networkId: person.network_id, agentId: person.agent_id, personId: person.id, reason, channel: null, notedAt: at });
    return true;
  }

  /** Ajoute à chaque fiche du groupe les exclusions en cours des autres qu'elle n'a pas encore. Rend le nombre ajouté. */
  private async shareExclusions(group: readonly Person[], at: Date): Promise<number> {
    const now = at.getTime();
    const active = (e: { noted_at: string; lifted_at: string | null }): boolean =>
      Date.parse(e.noted_at) <= now && (e.lifted_at === null || Date.parse(e.lifted_at) > now);
    const views = await Promise.all(group.map((p) => this.fiche.view(p.id)));
    const reasons = new Set(views.flatMap((v) => v.exclusions.filter(active).map((e) => e.reason)));
    let added = 0;
    for (const [index, person] of group.entries()) {
      const mine = views[index]?.exclusions.filter(active) ?? [];
      for (const reason of reasons) {
        if (mine.some((e) => e.reason === reason)) continue;
        await this.store.addExclusion({ networkId: person.network_id, agentId: person.agent_id, personId: person.id, reason, channel: null, notedAt: at });
        added += 1;
      }
    }
    return added;
  }

  /** La source de la fiche : le site, une seule fois par contact repris, même sans demande d'estimation. */
  private async addContactSource(target: Person, contact: ImportedContact): Promise<boolean> {
    const key = `${contact.origin}:source`;
    if ((await this.importTarget(key)) !== null) return false;
    const source = await this.store.addSource({
      networkId: target.network_id,
      agentId: target.agent_id,
      personId: target.id,
      channel: contact.source?.channel ?? 'site',
      detail:
        contact.source?.detail ??
        (contact.origin.startsWith('site:compte:') ? 'reprise espace estimation · compte' : 'reprise espace estimation · demande'),
      occurredAt: new Date(contact.createdAt),
    });
    // Une autre reprise a pris la clé entre-temps : cette source en trop reste, rien n'est effacé [R17].
    return this.claimImport(key, 'source', source.id, this.now()).then(() => true);
  }

  private async importRequest(
    target: Person,
    contact: SiteContact,
    request: SiteRequest,
    identifiers: readonly Identifier[],
    report: ImportReport,
  ): Promise<boolean> {
    const key = `site:demande:${request.reference}:projet`;
    let changed = false;
    let projectId = await this.importTarget(key);
    if (projectId === null) {
      const project = await this.store.createProject({
        networkId: target.network_id,
        agentId: target.agent_id,
        personId: target.id,
        kind: 'valuation',
        stage: request.status,
        criteria: { type: request.type, postalCode: request.postalCode, city: request.city },
        note: request.reason,
      });
      if (await this.claimImport(key, 'project', project.id, this.now())) {
        projectId = project.id;
        report.projects += 1;
        changed = true;
        await this.store.addSource({
          networkId: target.network_id,
          agentId: target.agent_id,
          personId: target.id,
          projectId,
          channel: 'site',
          detail: `reprise espace estimation · ${request.reference}`,
          occurredAt: new Date(request.createdAt),
        });
      } else {
        // Une autre reprise a pris la clé entre-temps : ce projet en trop reste vide, rien n'est effacé [R17].
        projectId = await this.importTarget(key);
      }
    }
    // La personne a demandé elle-même l'estimation : on peut la suivre sur les coordonnées données, pas la démarcher.
    const proof = `demande d'estimation ${request.reference}`;
    if ((await this.addConsents(target, identifiers, proof, new Date(request.createdAt), report))) changed = true;
    return changed;
  }

  /** Accords de suivi sur mail et téléphone, avec leur preuve ; jamais de prospection [R03]. Pas de doublon par preuve. */
  private async addConsents(
    target: Person,
    identifiers: readonly Identifier[],
    proof: string,
    givenAt: Date,
    report: ImportReport,
  ): Promise<boolean> {
    const channels = (['email', 'phone'] as const).filter((channel: Channel) => identifiers.some((id) => id.kind === channel));
    const members = await this.fiche.membersOf(target.id);
    let changed = false;
    for (const channel of channels) {
      const known = await this.db.first<{ n: number }>(
        `SELECT count(*) AS n FROM consents WHERE person_id IN (${placeholders(members.length)}) AND purpose = ? AND channel = ? AND proof = ?`,
        [...members, VALUATION_PURPOSE, channel, proof],
      );
      if (Number(known?.n ?? 0) > 0) continue;
      await this.store.addConsent({
        networkId: target.network_id,
        agentId: target.agent_id,
        personId: target.id,
        purpose: VALUATION_PURPOSE,
        channel,
        proof,
        givenAt,
      });
      report.consents += 1;
      changed = true;
    }
    return changed;
  }

  private async activeExclusions(personId: string, reason: ReceivedExclusion | 'network_list'): Promise<number> {
    const members = await this.fiche.membersOf(personId);
    const row = await this.db.first<{ n: number }>(
      `SELECT count(*) AS n FROM exclusions WHERE person_id IN (${placeholders(members.length)}) AND reason = ? AND lifted_at IS NULL`,
      [...members, reason],
    );
    return Number(row?.n ?? 0);
  }

  private async importTarget(key: string): Promise<string | null> {
    const row = await this.db.first<{ target_id: string }>(
      'SELECT target_id FROM import_keys WHERE network_id = ? AND key = ?',
      [this.options.networkId, key],
    );
    return row?.target_id ?? null;
  }

  /** Une seule instruction : la première reprise qui prend la clé la garde. Rend vrai si elle vient d'être prise. */
  private async claimImport(key: string, kind: 'person' | 'project' | 'source', targetId: string, at: Date): Promise<boolean> {
    const { changes } = await this.db.run(
      `INSERT INTO import_keys (network_id, key, target_kind, target_id, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (network_id, key) DO NOTHING`,
      [this.options.networkId, key, kind, targetId, at.toISOString()],
    );
    return changes === 1;
  }

  /** Les mêmes clés de contact que le rattachement des messages (C02) : un message et une reprise se retrouvent. */
  private async claimKeys(person: Person, keys: readonly string[], at: Date): Promise<void> {
    await this.db.run(
      `INSERT INTO contact_keys (network_id, key, person_id, created_at)
       VALUES ${keys.map(() => '(?, ?, ?, ?)').join(', ')}
       ON CONFLICT (network_id, key) DO NOTHING`,
      keys.flatMap((key) => [person.network_id, key, person.id, at.toISOString()]),
    );
  }

  private async keyOwners(keys: readonly string[]): Promise<Person[]> {
    if (keys.length === 0) return [];
    const rows = await this.db.all<{ person_id: string }>(
      `SELECT DISTINCT person_id FROM contact_keys WHERE network_id = ? AND key IN (${placeholders(keys.length)})`,
      [this.options.networkId, ...keys],
    );
    return this.existing(rows.map((row) => row.person_id));
  }

  private async existing(ids: readonly string[]): Promise<Person[]> {
    return (await Promise.all(ids.map((id) => this.store.getPerson(id)))).filter((p): p is Person => p !== null);
  }

  private async distinctRoots(persons: readonly Person[]): Promise<Person[]> {
    const ids = [...new Set(await Promise.all(persons.map((p) => this.fiche.rootOf(p.id))))];
    const roots = await this.existing(ids);
    return roots.sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
  }

  private async mergeAll(roots: readonly Person[]): Promise<{ target: Person; apart: Person[]; merged: number }> {
    const [first, ...others] = roots;
    if (!first) throw new Error('Reprise : aucune fiche.');
    const apart: Person[] = [];
    let merged = 0;
    for (const other of others) {
      try {
        await this.fiche.merge({ survivorId: first.id, mergedId: other.id, reason: 'identifiant commun à la reprise du site' });
        merged += 1;
      } catch (error) {
        if ((await this.fiche.rootOf(other.id)) === (await this.fiche.rootOf(first.id))) continue;
        if (error instanceof Error && error.message.includes('deux agents')) apart.push(other);
        else throw error;
      }
    }
    const rootId = await this.fiche.rootOf(first.id);
    const target = rootId === first.id ? first : await this.store.getPerson(rootId);
    if (!target) throw new Error(`Fiche inconnue : ${rootId}`);
    return { target, apart, merged };
  }

  /** Ajoute les identifiants que la fiche n'a pas, le prénom et le nom s'ils manquent. Rien n'est remplacé. */
  private async complete(target: Person, identifiers: readonly Identifier[], contact: ImportedContact): Promise<boolean> {
    const members = await this.fiche.membersOf(target.id);
    let changed = false;
    for (const id of identifiers) {
      const kinds = id.kind === 'phone' ? ['phone', 'whatsapp'] : [id.kind];
      const forms = await storedForms(target.network_id, id.kind, id.value);
      const known = await this.db.first<{ n: number }>(
        `SELECT count(*) AS n FROM person_identifiers
         WHERE person_id IN (${placeholders(members.length)}) AND kind IN (${placeholders(kinds.length)}) AND value IN (?, ?)`,
        [...members, ...kinds, forms[0] ?? id.value, forms[1] ?? id.value],
      );
      if (Number(known?.n ?? 0) > 0) continue;
      await this.fiche.addIdentifier({ networkId: target.network_id, agentId: target.agent_id, personId: target.id, kind: id.kind, value: id.value });
      changed = true;
    }
    const at = this.now().toISOString();
    // Une fiche effacée ne reprend pas de nom : seuls ses identifiants, sous empreinte, la reconnaissent (AU020c).
    if (await this.fiche.isErased(target.id)) return changed;
    for (const [column, value] of [['first_name', contact.firstName], ['last_name', contact.lastName]] as const) {
      if (value === null) continue;
      const { changes } = await this.db.run(
        `UPDATE persons SET ${column} = ?, updated_at = ? WHERE id = ? AND ${column} IS NULL`,
        [value, at, target.id],
      );
      if (changes > 0) changed = true;
    }
    return changed;
  }
}
