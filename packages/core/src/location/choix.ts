/**
 * Dossiers montrés au propriétaire dans leur ordre d'arrivée, et reçu d'équité (M15, W05) [R105, R104, R14].
 *
 * La présentation est un instantané fait par le code : les seuls dossiers complets (W04), dans leur ordre d'arrivée et
 * lui seul, sans nom, sans note, sans rang, sans tri ni filtre sur un revenu ou une autre donnée. Le propriétaire choisit ;
 * l'agent range son choix avec sa date, son canal et sa preuve. Aucune fonction du code ni de l'IA ne choisit [R105, R14].
 *
 * « Jamais vu » : le reçu d'équité. Chaque candidat, présenté ou encore incomplet, reçoit, préparé une seule fois et jamais envoyé
 * d'ici, la liste des seules pièces qui lui ont été demandées, son jour d'arrivée, son rang d'arrivée et la règle de
 * présentation. Le propriétaire reçoit la preuve que l'ordre montré est celui des arrivées. L'empreinte de chaque
 * présentation et de chaque reçu est écrite au journal : `replay` recalcule l'une et refait les autres, et vérifie, à
 * l'identique, que rien n'a changé et que l'ordre est bien celui des arrivées rangées [R105].
 *
 * Décidé, lecture prudente : le propriétaire voit chaque dossier par son rang d'arrivée, ses pièces et ses garants, sans le
 * nom du candidat, pour que le choix porte sur le dossier ; l'agent lui transmet les pièces elles-mêmes. Un seul choix par
 * mise en location. Rien ne s'efface [R17].
 */
import type { Viewer } from '../acces/droits.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { checkText } from '../envoi/texte.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import { OFFICIAL_PIECES, type ApplicationRow, type Candidatures } from './candidatures.ts';
import { dayInFrench, type LocationRefusal, type MisesEnLocation, type RentalFileStore } from './logement.ts';

export const CHOICE_CHANNELS = ['oral', 'ecrit', 'mail', 'sms', 'whatsapp'] as const;

/** Ce que voit le propriétaire d'un dossier : ni nom, ni note, ni rang autre que celui d'arrivée [R105]. */
export interface PresentedFile {
  arrival: number;
  arrivedOn: string;
  applicationId: string;
  dossierFacile: boolean;
  pieces: string[];
  guarantors: ('personne' | 'visale')[];
}

export interface Presentation {
  presentationId: string;
  listingId: string;
  version: number;
  files: PresentedFile[];
  sha256: string;
  createdAt: string;
}

export type ChoiceRefusal = Omit<LocationRefusal, 'rule'> & { rule: LocationRefusal['rule'] | 'R105' };
export type ChoiceResult<T> = { ok: true; value: T } | ChoiceRefusal;

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const REF_FILE = new RegExp(`^${UUID}\\.(?:pdf|jpg|png|txt)$`);

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Un dossier encore incomplet : non présenté, mais son candidat reçoit aussi son reçu, avec ce qui manque. */
export interface WaitingFile {
  arrival: number;
  arrivedOn: string;
  applicationId: string;
  pieces: string[];
  missing: string[];
}

type FileTuple = [number, string, string, boolean, string[], string[]];
type WaitingTuple = [number, string, string, string[], string[]];
interface Snapshot {
  presentedOn: string;
  files: FileTuple[];
  waiting: WaitingTuple[];
}

/** L'instantané, écrit d'une seule façon : la même présentation donne toujours la même empreinte. */
export const snapshotText = (presentedOn: string, files: readonly PresentedFile[], waiting: readonly WaitingFile[]): string =>
  JSON.stringify({
    presentedOn,
    files: files.map((f): FileTuple => [f.arrival, f.arrivedOn, f.applicationId, f.dossierFacile, f.pieces, f.guarantors]),
    waiting: waiting.map((w): WaitingTuple => [w.arrival, w.arrivedOn, w.applicationId, w.pieces, w.missing]),
  } satisfies Snapshot);

const MISSING_LABELS: Readonly<Record<string, string>> = Object.freeze({
  identite: 'la pièce d’identité, à montrer à votre agent immobilier',
  domicile: 'un justificatif de domicile',
  activite: 'un justificatif d’activité',
  ressources: 'un justificatif de ressources',
  visa_visale: 'le visa de la garantie Visale',
});

/** Le reçu d'un dossier encore incomplet : ses pièces, ce qui manque, et la même règle [R105, R104]. */
export function waitingReceiptText(arrivedOn: string, arrival: number, pieces: readonly string[], missing: readonly string[]): string {
  return (
    `Bonjour, votre dossier de candidature est arrivé le ${dayInFrench(arrivedOn)}, en position ${arrival} dans l'ordre d'arrivée. ` +
    `Les seules pièces qui vous ont été demandées et que vous avez données : ${pieces.length > 0 ? pieces.join(' ; ') : 'aucune pour l’instant'}. ` +
    `Il manque encore : ${missing.join(' ; ')}. Seuls les dossiers complets sont montrés au propriétaire, dans leur ordre d'arrivée, sans note ni classement, et c'est lui qui choisit.`
  );
}

/** Le reçu d'équité du candidat, écrit par le code : ses pièces, son arrivée, la règle. Rien d'autre [R105]. */
export function candidateReceiptText(arrivedOn: string, arrival: number, pieces: readonly string[], dossierFacile: boolean): string {
  const asked = dossierFacile ? 'votre dossier DossierFacile, et aucune autre pièce' : pieces.length > 0 ? pieces.join(' ; ') : 'aucune pièce';
  return (
    `Bonjour, votre dossier de candidature est arrivé le ${dayInFrench(arrivedOn)}, en position ${arrival} dans l'ordre d'arrivée. ` +
    `Les seules pièces qui vous ont été demandées : ${asked}. Votre pièce d'identité est restée chez votre agent immobilier, qui ne la transmet pas. ` +
    `Les dossiers complets sont montrés au propriétaire dans leur ordre d'arrivée, sans note ni classement, et c'est lui qui choisit.`
  );
}

/**
 * La référence de vérification, en lettres seules, par groupes de quatre : tirée de l'empreinte, sans aucun chiffre,
 * pour qu'aucun contrôle des textes ne la prenne pour un montant ou un numéro de compte.
 */
export function verificationCode(fingerprint: string): string {
  const letters = fingerprint.slice(0, 16).replace(/[0-9a-f]/g, (c) => 'abcdefghjkmnpqrs'[parseInt(c, 16)]!);
  return letters.match(/.{4}/g)!.join('-');
}

/** La preuve au propriétaire : combien de dossiers, dans quel ordre, et l'empreinte qui permet de le vérifier. */
export function ownerReceiptText(count: number, presentedOn: string, fingerprint: string): string {
  return (
    `Bonjour, ${count === 1 ? 'le dossier complet reçu vous est présenté' : `les ${count} dossiers complets reçus vous sont présentés`} le ${dayInFrench(presentedOn)}, dans leur ordre d'arrivée, sans note ni classement. ` +
    `Le choix vous appartient. Référence de vérification de cet ordre : ${verificationCode(fingerprint)}.`
  );
}

export interface ChoixOptions {
  now?: () => Date;
  newId?: () => string;
}

export class ChoixProprietaire {
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(
    private readonly db: SqlDatabase,
    private readonly listings: MisesEnLocation,
    private readonly applications: Candidatures,
    private readonly files: RentalFileStore,
    private readonly journal: JournalStore,
    options: ChoixOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => crypto.randomUUID());
  }

  private actor(viewer: Viewer): string {
    return `${String(viewer.role)}:${viewer.userId}`;
  }

  private today(): string {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit' }).format(this.now());
  }

  private arrivedOn(at: string): string {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(at));
  }

  /** Fait la présentation : les seuls dossiers complets, dans leur ordre d'arrivée ; prépare les reçus d'équité [R105]. */
  async present(viewer: Viewer, listingId: unknown): Promise<ChoiceResult<Presentation>> {
    const listing = await this.listings.listing(viewer, listingId, true);
    if ('ok' in listing) return listing;
    if (await this.db.first('SELECT 1 FROM rental_choices WHERE listing_id = ?', [listing.id])) return { ok: false, rule: 'R105', code: 'already_chosen' };
    const rows = await this.db.all<ApplicationRow>(
      'SELECT id, listing_id, network_id, person_id, arrival, dossierfacile_url, arrived_at FROM rental_applications WHERE listing_id = ? ORDER BY arrival',
      [listing.id],
    );
    const files: PresentedFile[] = [];
    const waiting: WaitingFile[] = [];
    const people = new Map<string, string>();
    for (const r of rows) {
      people.set(r.id, r.person_id);
      // Les seules pièces du candidat : celles de ses garants ne lui ont pas été demandées.
      const pieces = await this.db.all<{ sort: string }>("SELECT sort FROM rental_application_pieces WHERE application_id = ? AND holder = 'candidat' ORDER BY added_at, id", [r.id]);
      const completeness = await this.applications.completeness(r);
      if (!completeness.complete) {
        waiting.push({
          arrival: Number(r.arrival),
          arrivedOn: this.arrivedOn(r.arrived_at),
          applicationId: r.id,
          pieces: pieces.map((p) => OFFICIAL_PIECES[p.sort]?.label ?? p.sort),
          missing: completeness.missing.map((m) => `${MISSING_LABELS[m.what] ?? m.what}${m.holder === 'candidat' ? '' : ' de votre garant'}`),
        });
        continue;
      }
      const guarantors = await this.db.all<{ kind: 'personne' | 'visale' }>('SELECT kind FROM rental_guarantors WHERE application_id = ? ORDER BY added_at, id', [r.id]);
      files.push({
        arrival: Number(r.arrival),
        arrivedOn: this.arrivedOn(r.arrived_at),
        applicationId: r.id,
        dossierFacile: r.dossierfacile_url !== null,
        pieces: pieces.map((p) => OFFICIAL_PIECES[p.sort]?.label ?? p.sort),
        guarantors: guarantors.map((g) => g.kind),
      });
    }
    // Sans aucun dossier complet, la présentation se fait quand même pour les reçus des candidats : le propriétaire,
    // lui, n'a rien à voir ni de reçu à recevoir.
    if (files.length === 0 && waiting.length === 0) return { ok: false, rule: null, code: 'no_application' };
    const presentedOn = this.today();
    const text = snapshotText(presentedOn, files, waiting);
    const fingerprint = await sha256(text);
    const id = this.newId();
    const at = this.now().toISOString();
    try {
      await this.db.run(
        `INSERT INTO rental_presentations (id, listing_id, network_id, version, snapshot, snapshot_sha256, created_by, created_at)
         SELECT ?, ?, ?, COALESCE(MAX(version), 0) + 1, ?, ?, ?, ? FROM rental_presentations WHERE listing_id = ?`,
        [id, listing.id, listing.networkId, text, fingerprint, this.actor(viewer), at, listing.id],
      );
    } catch (error) {
      if (/UNIQUE/i.test(String(error))) return { ok: false, rule: null, code: 'busy' };
      throw error;
    }
    const version = Number((await this.db.first<{ version: number }>('SELECT version FROM rental_presentations WHERE id = ?', [id]))!.version);
    // L'empreinte et l'ordre des dossiers, au journal, sans nom : de quoi rejouer la présentation à l'identique.
    await appendEvent(
      this.journal,
      { type: 'location.presentation', actor: this.actor(viewer), subject: `rental:${listing.id}`, data: { rule: 'R105', presentation: `rental_presentation:${id}`, sha256: fingerprint, order: files.map((f) => f.applicationId) } },
      this.now,
    );
    for (const f of files) await this.prepare(id, 'candidat', f.applicationId, people.get(f.applicationId)!, candidateReceiptText(f.arrivedOn, f.arrival, f.pieces, f.dossierFacile));
    for (const w of waiting) await this.prepare(id, 'candidat', w.applicationId, people.get(w.applicationId)!, waitingReceiptText(w.arrivedOn, w.arrival, w.pieces, w.missing));
    if (files.length > 0) await this.prepare(id, 'proprietaire', null, listing.ownerPersonId, ownerReceiptText(files.length, presentedOn, fingerprint));
    return { ok: true, value: { presentationId: id, listingId: listing.id, version, files, sha256: fingerprint, createdAt: at } };
  }

  private async prepare(presentationId: string, recipient: 'candidat' | 'proprietaire', applicationId: string | null, personId: string, text: string): Promise<void> {
    const figures = (text.match(/\d+/g) ?? []).map(Number);
    const problems = checkText(text, { audience: 'client', channel: 'email', figures }).filter((p) => p.rule !== 'R08' && p.rule !== 'length');
    if (problems.length > 0) {
      await appendEvent(this.journal, { type: 'location.recu_refuse', actor: 'system:location', subject: `rental_presentation:${presentationId}`, data: { recipient, rules: problems.map((p) => p.rule) } }, this.now);
      return;
    }
    const r = await this.db.run(
      'INSERT INTO rental_fairness_receipts (id, presentation_id, recipient, application_id, person_id, text, prepared_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING',
      [this.newId(), presentationId, recipient, applicationId, personId, text, this.now().toISOString()],
    );
    // L'empreinte du texte, au journal, pour rejouer le reçu à l'identique ; jamais le texte ni le nom [R13].
    if (r.changes > 0) {
      await appendEvent(
        this.journal,
        { type: 'location.recu_prepare', actor: 'system:location', subject: `rental_presentation:${presentationId}`, data: { rule: 'R105', mode: 'essai', recipient, application: applicationId, sha256: await sha256(text) } },
        this.now,
      );
    }
  }

  /**
   * Rejoue une présentation : l'instantané rangé donne la même empreinte que celle du journal, et son ordre est celui des
   * arrivées rangées. Rend `true` seulement si tout concorde [R105].
   */
  async replay(networkId: string, presentationId: string): Promise<boolean> {
    const p = await this.db.first<{ id: string; listing_id: string; snapshot: string; snapshot_sha256: string }>('SELECT id, listing_id, snapshot, snapshot_sha256 FROM rental_presentations WHERE id = ? AND network_id = ?', [presentationId, networkId]);
    if (!p) return false;
    const event = await this.db.first<{ data: string }>("SELECT data FROM journal WHERE type = 'location.presentation' AND subject = ? AND data LIKE ? ORDER BY seq DESC LIMIT 1", [`rental:${p.listing_id}`, `%rental_presentation:${p.id}%`]);
    if (!event) return false;
    const logged = JSON.parse(event.data) as { sha256: string; order: string[] };
    if ((await sha256(p.snapshot)) !== p.snapshot_sha256 || logged.sha256 !== p.snapshot_sha256) return false;
    const snap = JSON.parse(p.snapshot) as Snapshot;
    const files = snap.files;
    if (JSON.stringify(files.map((f) => f[2])) !== JSON.stringify(logged.order)) return false;
    let last = 0;
    for (const [arrival, , applicationId] of files) {
      const row = await this.db.first<{ arrival: number }>('SELECT arrival FROM rental_applications WHERE id = ? AND listing_id = ?', [applicationId, p.listing_id]);
      if (!row || Number(row.arrival) !== arrival || arrival <= last) return false;
      last = arrival;
    }
    // Chaque reçu : son texte refait depuis l'instantané, identique à celui rangé, et son empreinte au journal.
    const expected = new Map<string, string>();
    for (const [arrival, arrivedOn, applicationId, dossierFacile, pieces] of files) expected.set(`candidat:${applicationId}`, candidateReceiptText(arrivedOn, arrival, pieces, dossierFacile));
    for (const [arrival, arrivedOn, applicationId, pieces, missing] of snap.waiting) expected.set(`candidat:${applicationId}`, waitingReceiptText(arrivedOn, arrival, pieces, missing));
    if (files.length > 0) expected.set('proprietaire:', ownerReceiptText(files.length, snap.presentedOn, p.snapshot_sha256));
    const stored = await this.db.all<{ recipient: string; application_id: string | null; text: string }>('SELECT recipient, application_id, text FROM rental_fairness_receipts WHERE presentation_id = ?', [p.id]);
    const events = await this.db.all<{ data: string }>("SELECT data FROM journal WHERE type = 'location.recu_prepare' AND subject = ?", [`rental_presentation:${p.id}`]);
    const loggedHashes = new Map<string, string>(events.map((e) => JSON.parse(e.data) as { recipient: string; application: string | null; sha256: string }).map((e): [string, string] => [`${e.recipient}:${e.application ?? ''}`, e.sha256]));
    if (stored.length !== expected.size) return false;
    for (const r of stored) {
      const key = `${r.recipient}:${r.application_id ?? ''}`;
      if (expected.get(key) !== r.text || loggedHashes.get(key) !== (await sha256(r.text))) return false;
    }
    return true;
  }

  /** Range le choix du propriétaire parmi les dossiers de la dernière présentation, avec sa date et sa preuve [R105]. */
  async recordChoice(viewer: Viewer, listingId: unknown, input: { presentationId: unknown; applicationId: unknown; decidedAt: unknown; channel: unknown; proofRef: unknown }): Promise<ChoiceResult<{ applicationId: string }>> {
    const listing = await this.listings.listing(viewer, listingId, true);
    if ('ok' in listing) return listing;
    const last = await this.db.first<{ id: string; snapshot: string }>('SELECT id, snapshot FROM rental_presentations WHERE listing_id = ? ORDER BY version DESC LIMIT 1', [listing.id]);
    if (!last || last.id !== input.presentationId) return { ok: false, rule: 'R105', code: 'not_latest_presentation' };
    const presented = (JSON.parse(last.snapshot) as Snapshot).files.map((f) => f[2]);
    if (typeof input.applicationId !== 'string' || !presented.includes(input.applicationId)) return { ok: false, rule: 'R105', code: 'not_presented' };
    if (typeof input.decidedAt !== 'string' || Number.isNaN(Date.parse(input.decidedAt)) || Date.parse(input.decidedAt) > this.now().getTime()) return { ok: false, rule: 'R105', code: 'bad_date' };
    const presentedAt = (await this.db.first<{ created_at: string }>('SELECT created_at FROM rental_presentations WHERE id = ?', [last.id]))!.created_at;
    if (Date.parse(input.decidedAt) < Date.parse(presentedAt)) return { ok: false, rule: 'R105', code: 'before_presentation' };
    if (typeof input.channel !== 'string' || !(CHOICE_CHANNELS as readonly string[]).includes(input.channel)) return { ok: false, rule: 'R105', code: 'bad_channel' };
    const prefix = `location/${listing.id}/choix/`;
    if (typeof input.proofRef !== 'string' || !input.proofRef.startsWith(prefix) || !REF_FILE.test(input.proofRef.slice(prefix.length))) return { ok: false, rule: 'R105', code: 'bad_proof' };
    if (!(await this.files.has(input.proofRef))) return { ok: false, rule: 'R105', code: 'not_stored' };
    const app = (await this.db.first<ApplicationRow>('SELECT id, listing_id, network_id, person_id, arrival, dossierfacile_url, arrived_at FROM rental_applications WHERE id = ?', [input.applicationId]))!;
    if (!(await this.applications.completeness(app)).complete) return { ok: false, rule: 'R105', code: 'incomplete' };
    try {
      await this.db.run('INSERT INTO rental_choices (listing_id, presentation_id, application_id, decided_at, channel, proof_ref, recorded_by, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [
        listing.id,
        last.id,
        input.applicationId,
        new Date(input.decidedAt).toISOString(),
        input.channel,
        input.proofRef,
        this.actor(viewer),
        this.now().toISOString(),
      ]);
    } catch (error) {
      if (/UNIQUE|PRIMARY/i.test(String(error))) return { ok: false, rule: 'R105', code: 'already_chosen' };
      throw error;
    }
    await appendEvent(this.journal, { type: 'location.choix', actor: this.actor(viewer), subject: `rental:${listing.id}`, data: { rule: 'R105', presentation: `rental_presentation:${last.id}`, channel: input.channel } }, this.now);
    return { ok: true, value: { applicationId: input.applicationId } };
  }

  /**
   * La dernière présentation telle qu'elle a été faite (dossiers complets, dans leur ordre d'arrivée, tirés de
   * l'instantané rangé) et le dossier choisi, pour l'écran « Louer » (W11). La lecture est au journal [R16, R105].
   */
  async last(viewer: Viewer, listingId: unknown): Promise<ChoiceResult<{ presentation: Presentation | null; chosenApplicationId: string | null }>> {
    const listing = await this.listings.listing(viewer, listingId, false);
    if ('ok' in listing) return listing;
    await appendEvent(this.journal, { type: 'location.lue', actor: this.actor(viewer), subject: `rental:${listing.id}`, data: { rule: 'R16', what: 'presentation' } }, this.now);
    const r = await this.db.first<{ id: string; version: number; snapshot: string; snapshot_sha256: string; created_at: string }>(
      'SELECT id, version, snapshot, snapshot_sha256, created_at FROM rental_presentations WHERE listing_id = ? ORDER BY version DESC LIMIT 1',
      [listing.id],
    );
    const chosen = await this.chosen(listing.networkId, listing.id);
    const presentation: Presentation | null = r
      ? {
          presentationId: r.id,
          listingId: listing.id,
          version: Number(r.version),
          files: (JSON.parse(r.snapshot) as Snapshot).files.map(([arrival, arrivedOn, applicationId, dossierFacile, pieces, guarantors]) => ({ arrival, arrivedOn, applicationId, dossierFacile, pieces, guarantors: guarantors as PresentedFile['guarantors'] })),
          sha256: r.snapshot_sha256,
          createdAt: r.created_at,
        }
      : null;
    return { ok: true, value: { presentation, chosenApplicationId: chosen?.applicationId ?? null } };
  }

  /** Le candidat choisi par le propriétaire, ou `null` : pour le bail de W06 [R105]. */
  async chosen(networkId: string, listingId: string): Promise<{ applicationId: string; personId: string } | null> {
    const r = await this.db.first<{ application_id: string; person_id: string }>(
      'SELECT c.application_id, a.person_id FROM rental_choices c JOIN rental_applications a ON a.id = c.application_id JOIN rental_listings l ON l.id = c.listing_id WHERE c.listing_id = ? AND l.network_id = ?',
      [listingId, networkId],
    );
    return r ? { applicationId: r.application_id, personId: r.person_id } : null;
  }

  /**
   * Le dossier choisi est-il toujours complet (AU097) ? Un colocataire ajouté après le choix doit avoir ses pièces
   * avant que le bail se fasse ou se signe [R104].
   */
  async chosenComplete(networkId: string, listingId: string): Promise<boolean> {
    const r = await this.db.first<ApplicationRow>(
      'SELECT a.id, a.listing_id, a.network_id, a.person_id, a.arrival, a.dossierfacile_url, a.arrived_at FROM rental_choices c JOIN rental_applications a ON a.id = c.application_id WHERE c.listing_id = ? AND a.network_id = ?',
      [listingId, networkId],
    );
    return r ? (await this.applications.completeness(r)).complete : false;
  }

  /** Les reçus préparés d'une présentation, pour l'agent ; la lecture est au journal avant d'être rendue [R16]. */
  async receipts(viewer: Viewer, listingId: unknown, presentationId: unknown): Promise<ChoiceResult<{ recipient: 'candidat' | 'proprietaire'; applicationId: string | null; text: string }[]>> {
    const listing = await this.listings.listing(viewer, listingId, false);
    if ('ok' in listing) return listing;
    const p = typeof presentationId === 'string' ? await this.db.first('SELECT 1 FROM rental_presentations WHERE id = ? AND listing_id = ?', [presentationId, listing.id]) : null;
    if (!p) return { ok: false, rule: null, code: 'unknown_presentation' };
    await appendEvent(this.journal, { type: 'location.lue', actor: this.actor(viewer), subject: `rental:${listing.id}`, data: { rule: 'R16', what: 'receipts' } }, this.now);
    const rows = await this.db.all<{ recipient: 'candidat' | 'proprietaire'; application_id: string | null; text: string }>('SELECT recipient, application_id, text FROM rental_fairness_receipts WHERE presentation_id = ? ORDER BY prepared_at, id', [presentationId as string]);
    return { ok: true, value: rows.map((r) => ({ recipient: r.recipient, applicationId: r.application_id, text: r.text })) };
  }
}

