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
 *
 * Servie sur un site du réseau (M01, AT11), la page du bien porte sa page de référence unique : en-tête `Link`, lien
 * canonique et données structurées sans adresse. Le site d'un agent ne sert ni la page ni la fiche du bien d'un autre
 * agent, ni ses photos [R153].
 *
 * Une annonce en vente ou sous offre repasse la porte de diffusion à chaque lecture (RS01) : un mandat échu ou rétracté
 * ou un bien vendu la retire aussitôt, sans attendre le passage de publication [R220].
 */
import { Acces, Diffusion, FicheClient, FicheUnique, SqlJournalStore, annonces as m07, type SqlDatabase } from '@aimmo/core';
import { LISTABLE_STATUSES } from '../../core/src/attirer/liste-biens.ts';
import { withLegalLinks } from '../../core/src/attirer/mentions-site.ts';
import { journalError } from './app.ts';
import { syncAnnonces, type AnnonceOptions } from './annonces.ts';
import { listingPresence, type ListingReference } from './attirer.ts';
import { countPublicView } from './statistiques-site.ts';

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

/**
 * L'annonce d'un bien vue maintenant : `disponible` tant qu'elle se dit en vente ou sous offre, et `fantome` si le bien n'a
 * plus le droit de l'être, mandat refusé par la porte ou bien vendu ou retiré dans le socle [R220].
 */
async function liveState(db: SqlDatabase, networkId: string, propertyId: string, now: () => Date): Promise<'disponible' | 'fantome' | 'autre'> {
  const last = await db.first<{ state: string }>('SELECT state FROM listing_versions WHERE property_id = ? ORDER BY seq DESC LIMIT 1', [propertyId]);
  if (last?.state !== 'en_vente' && last?.state !== 'sous_offre') return 'autre';
  const property = await db.first<{ status: string }>('SELECT status FROM properties WHERE id = ? AND network_id = ?', [propertyId, networkId]);
  if (!property || !LISTABLE_STATUSES.includes(property.status)) return 'fantome';
  const store = new FicheClient(db, { now });
  const journal = new SqlJournalStore(db);
  const gate = new Diffusion(db, new Acces(db, store, new FicheUnique(db, store, { now }), journal, { now }), journal, { now });
  return (await gate.canDiffuse(networkId, propertyId, now())).allowed ? 'disponible' : 'fantome';
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
  // Ni la page, ni la fiche, ni les photos d'un bien sur un site qui ne doit pas le montrer [R153, R16].
  const presence = await listingPresence({ db, journal: new SqlJournalStore(db), now }, request.url, propertyId, network);
  if (presence.kind === 'masque') return notFound();
  const live = await liveState(db, network, propertyId, now);
  if (live === 'fantome') return notFound();
  // Une annonce disponible peut sortir à tout moment : une réponse en cache ne lui survit qu'une minute.
  const cache: Record<string, string> = live === 'disponible' ? { 'cache-control': 'public, max-age=60' } : {};
  if (page) {
    const html = page[2] ? await pages.print(network, propertyId) : await pages.page(network, propertyId);
    if (html === null) return notFound();
    // La fiche imprimable ne porte pas la référence : seule la page du bien en est une.
    const ref = presence.kind === 'reference' && !page[2] ? presence : null;
    const framed = ref ? withReference(html, ref) : html;
    // Sur un site du réseau, la page du bien mène aux pages légales ; pas sa fiche imprimable, ni l'adresse de l'API.
    const body = !page[2] && presence.kind !== 'hors_site' ? withLegalLinks(framed) : framed;
    // La page du bien servie sur un site du réseau compte une vue (BR41) ; ni sa fiche imprimable, ni la page à l'adresse de l'API [R285].
    if (!page[2] && presence.kind !== 'hors_site') await countPublicView({ db, journal: new SqlJournalStore(db), now }, request, network, 'bien', propertyId);
    return new Response(request.method === 'HEAD' ? null : body, { status: 200, headers: { ...headers('text/html; charset=utf-8'), ...cache, ...(ref ? { link: ref.link } : {}) } });
  }
  // Une photo n'est servie que si la dernière version publiée la porte, et tant que l'annonce n'est pas retirée.
  const input = await pages.inputFor(network, propertyId);
  const ref = file![1]!;
  if (!input || input.payload.state === 'retiree' || !input.photos.some((p) => p.ref === ref)) return notFound();
  if (!media) return notFound();
  const object = await media.get(ref);
  if (!object) return notFound();
  return new Response(request.method === 'HEAD' ? null : object.body, { status: 200, headers: { ...headers(MEDIA_TYPES[file![3]!]!), ...cache } });
}

const attr = (v: string): string => v.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Le lien canonique et les données structurées, posés en fin d'en-tête ; une page sans en-tête reste telle quelle. */
function withReference(html: string, ref: ListingReference): string {
  const at = html.indexOf('</head>');
  if (at < 0) return html;
  return `${html.slice(0, at)}<link rel="canonical" href="${attr(ref.canonical)}"><script type="application/ld+json">${ref.structuredData}</script>${html.slice(at)}`;
}

/**
 * Le créneau d'un quart d'heure, en UTC : `AAAA-MM-JJTHH:MMZ`. En UTC, l'heure qui revient au changement d'heure
 * d'automne garde ses quatre créneaux, chacun distinct.
 */
export function quarterSlot(at: Date): string {
  const quarter = new Date(Math.floor(at.getTime() / 900_000) * 900_000);
  return `${quarter.toISOString().slice(0, 16)}Z`;
}

export const LISTING_SYNC_JOB = 'annonces.publication';

/**
 * Le passage de publication de chaque réseau, une seule fois par quart d'heure : le créneau est réservé avant de
 * lancer, deux déclencheurs en même temps n'en font qu'un. Une erreur va au journal, sans donnée [R13].
 */
export async function runListingSync(db: SqlDatabase, now: () => Date = () => new Date(), options: AnnonceOptions = {}): Promise<{ slot: string; ran: boolean; properties: number; failed: number }> {
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
      // Un réseau en panne n'empêche pas les autres de publier ; la panne va au journal, sans donnée [R13].
      try {
        // AU067 : les mêmes canaux et connecteurs que le retrait immédiat, pour que ce passage réessaie ses échecs.
        const r = await syncAnnonces(s, n.id, options);
        properties += r.properties;
        failed += r.failed;
      } catch (error) {
        outcome = 'error';
        await journalError(journal, 'system:planificateur', LISTING_SYNC_JOB, error, now);
      }
    }
  } catch (error) {
    outcome = 'error';
    await journalError(journal, 'system:planificateur', LISTING_SYNC_JOB, error, now);
  }
  await db.run('UPDATE scheduled_runs SET outcome = ?, finished_at = ? WHERE job = ? AND slot = ?', [outcome, now().toISOString(), LISTING_SYNC_JOB, slot]);
  return { slot, ran: true, properties, failed };
}
