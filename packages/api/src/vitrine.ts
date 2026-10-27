/**
 * La vitrine publique de M07 (P10) et le passage de publication toutes les 15 minutes.
 *
 *   GET /biens/:bien          la page du bien, depuis sa dernière version publiée [R46]
 *   GET /biens/:bien/fiche    sa fiche imprimable, deux pages A4
 *   GET /medias/biens/:bien/:fichier   une photo de la version publiée, et seulement elle
 *
 * Rien n'est lu d'un brouillon : la page et la fiche ne viennent que de `listing_versions`, que seul le passage de
 * publication écrit, après la porte de diffusion, la liste de contrôle et la validation de l'agent [R42, R43, R47].
 * Aucune adresse, aucun nom du vendeur : la version publiée n'en porte pas [R46]. Les pages ne sont pas indexées tant
 * que le chantier est en mode essai.
 */
import { Acces, FicheClient, FicheUnique, SqlJournalStore, annonces as m07, type SqlDatabase } from '@aimmo/core';
import { journalError } from './app.ts';
import { syncAnnonces } from './annonces.ts';

export const PAGE_PATH = /^\/biens\/([A-Za-z0-9_-]{1,64})(\/fiche)?$/;
/** Les médias rangés par la fiche du bien : `biens/<bien>/<uuid>.<ext>`. */
export const MEDIA_PATH = /^\/medias\/(biens\/([A-Za-z0-9_-]{1,64})\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|jpeg|png|webp))$/;
const MEDIA_TYPES: Record<string, string> = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };

/** Le seul usage fait du stockage des médias (R2) : lire un objet par sa clé. */
export interface MediaStore {
  get(key: string): Promise<{ body: ReadableStream | ArrayBuffer | string } | null>;
}

// La page n'a ni script ni ressource extérieure ; ses images viennent de ce Worker.
const PAGE_CSP = "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

const headers = (type: string): Record<string, string> => ({
  'content-type': type,
  'content-security-policy': PAGE_CSP,
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-robots-tag': 'noindex, nofollow',
  // Une nouvelle version publiée remplace la page en 5 minutes au plus.
  'cache-control': 'public, max-age=300',
});
const notFound = (): Response => new Response('Page inconnue.', { status: 404, headers: { ...headers('text/plain; charset=utf-8'), 'cache-control': 'no-store' } });

/** Le réseau d'une annonce publiée, lu dans sa dernière version : rien pour un bien jamais publié. */
async function publishedNetwork(db: SqlDatabase, propertyId: string): Promise<string | null> {
  const v = await db.first<{ network_id: string }>('SELECT network_id FROM listing_versions WHERE property_id = ? ORDER BY seq DESC LIMIT 1', [propertyId]);
  return v?.network_id ?? null;
}

function pageBien(db: SqlDatabase, now: () => Date): InstanceType<typeof m07.PageBien> {
  const store = new FicheClient(db, { now });
  const journal = new SqlJournalStore(db);
  return new m07.PageBien(db, new Acces(db, store, new FicheUnique(db, store, { now }), journal, { now }), journal, { now });
}

/** La page publique ou la fiche imprimable d'un bien ; null si l'adresse n'est pas à la vitrine. */
export async function handleVitrine(request: Request, db: SqlDatabase, media: MediaStore | undefined, now: () => Date): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  const page = PAGE_PATH.exec(path);
  const file = page ? null : MEDIA_PATH.exec(path);
  if (!page && !file) return null;
  if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Méthode non admise.', { status: 405, headers: { ...headers('text/plain; charset=utf-8'), allow: 'GET, HEAD' } });
  const propertyId = page ? page[1]! : file![2]!;
  const network = await publishedNetwork(db, propertyId);
  if (!network) return notFound();
  const pages = pageBien(db, now);
  if (page) {
    const html = page[2] ? await pages.print(network, propertyId) : await pages.page(network, propertyId);
    if (html === null) return notFound();
    return new Response(request.method === 'HEAD' ? null : html, { status: 200, headers: headers('text/html; charset=utf-8') });
  }
  // Une photo n'est servie que si la dernière version publiée la porte, et tant que l'annonce n'est pas retirée.
  const input = await pages.inputFor(network, propertyId);
  const ref = file![1]!;
  if (!input || input.payload.state === 'retiree' || !input.photos.some((p) => p.ref === ref)) return notFound();
  if (!media) return notFound();
  const object = await media.get(ref);
  if (!object) return notFound();
  return new Response(request.method === 'HEAD' ? null : object.body, { status: 200, headers: headers(MEDIA_TYPES[file![3]!]!) });
}

/** Le créneau d'un quart d'heure, heure de Paris : `AAAA-MM-JJTHH:MM`. */
export function quarterSlot(at: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(at);
  const get = (type: string) => parts.find((p) => p.type === type)!.value;
  const quarter = String(Math.floor(Number(get('minute')) / 15) * 15).padStart(2, '0');
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${quarter}`;
}

export const LISTING_SYNC_JOB = 'annonces.publication';

/**
 * Le passage de publication de chaque réseau, une seule fois par quart d'heure : le créneau est réservé avant de
 * lancer, deux déclencheurs en même temps n'en font qu'un. Une erreur va au journal, sans donnée [R13].
 */
export async function runListingSync(db: SqlDatabase, now: () => Date = () => new Date()): Promise<{ slot: string; ran: boolean; properties: number; failed: number }> {
  const at = now();
  const slot = quarterSlot(at);
  const claimed = await db.run('INSERT INTO scheduled_runs (job, slot, started_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING', [LISTING_SYNC_JOB, slot, at.toISOString()]);
  if (claimed.changes !== 1) return { slot, ran: false, properties: 0, failed: 0 };
  const journal = new SqlJournalStore(db);
  const store = new FicheClient(db, { now });
  const s = { db, journal, acces: new Acces(db, store, new FicheUnique(db, store, { now }), journal, { now }), now };
  let properties = 0;
  let failed = 0;
  let outcome: 'ok' | 'error' = 'ok';
  try {
    const networks = await db.all<{ id: string }>('SELECT id FROM networks ORDER BY id');
    for (const n of networks) {
      const r = await syncAnnonces(s, n.id);
      properties += r.properties;
      failed += r.failed;
    }
  } catch (error) {
    outcome = 'error';
    await journalError(journal, 'system:planificateur', LISTING_SYNC_JOB, error, now);
  }
  await db.run('UPDATE scheduled_runs SET outcome = ?, finished_at = ? WHERE job = ? AND slot = ?', [outcome, now().toISOString(), LISTING_SYNC_JOB, slot]);
  return { slot, ran: true, properties, failed };
}
