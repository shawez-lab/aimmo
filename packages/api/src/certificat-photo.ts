/**
 * La page publique du certificat d'une photo (M19, X10) : `/certificat-photo/<jeton>`, sans clé, servie par le socle
 * comme les autres pages publiques. Elle dit ce que le Studio a fait de la photo, et rien d'autre : ni adresse, ni bien,
 * ni agent, ni nom [R46, R13]. Ce qu'elle montre vient tel quel du certificat rangé ; elle ne calcule rien [R130].
 *
 * Elle suit le système de design d'AIMMO : le cadre `renderPublicPage`, rien d'extérieur, aucun script [R201].
 */
import { renderPublicPage, SqlJournalStore, studio, type SqlDatabase } from '@aimmo/core';
import { journalError } from './app.ts';

export const CERTIFICATE_PAGE_PATH = studio.CERTIFICATE_PATH;

const CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

const escape = (t: string): string => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** `2027-10-14` → `14 octobre 2027`, sans dépendre de la langue de la machine. */
const MONTHS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
function frenchDate(day: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) return day;
  return `${Number(m[3])}${Number(m[3]) === 1 ? 'er' : ''} ${MONTHS[Number(m[2]) - 1] ?? ''} ${m[1]}`;
}

const CERTIFICATE_TITLE = 'Ce que nous avons fait de cette photo';

/** La page entière du certificat, pour la servir et pour le contrôle du système de design [R201]. */
export function renderCertificatePage(cert: studio.PhotoCertificate): string {
  return renderPublicPage({ title: CERTIFICATE_TITLE, body: renderCertificate(cert), kicker: 'Certificat de photo' });
}

function page(status: number, title: string, body: string): Response {
  return respond(status, renderPublicPage({ title, body, kicker: 'Certificat de photo' }));
}

function respond(status: number, html: string): Response {
  return new Response(html, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': CSP,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'x-frame-options': 'DENY',
    },
  });
}

/** Le corps de la page, depuis le certificat tel que le client le lit. */
export function renderCertificate(cert: studio.PhotoCertificate): string {
  const corrections =
    cert.corrections.length === 0
      ? '<p>Aucune correction : la photo est telle qu’elle a été prise.</p>'
      : `<h2>Corrections faites sur toute l’image</h2><ul>${cert.corrections.map((c) => `<li>${escape(c.detail)}</li>`).join('')}</ul>`;
  const staging = cert.virtualStaging
    ? `<p><strong>Aménagement virtuel.</strong> Du mobilier ou des travaux ont été ajoutés à l’image ; la mention « ${escape(cert.mention ?? 'Aménagement virtuel')} » est posée sur la photo partout où elle paraît.</p>`
    : '<p>Aucune retouche à un endroit précis : rien n’a été effacé, ajouté ni déplacé.</p>';
  return [
    `<p>${escape(cert.statement)}</p>`,
    corrections,
    staging,
    '<h2>Empreintes</h2>',
    '<p class="doux">L’original est gardé. Chaque fichier a son empreinte : la moindre modification la changerait.</p>',
    `<ul class="liste"><li>Photo publiée : <code>${escape(cert.resultSha256)}</code></li><li>Original : <code>${escape(cert.originalSha256)}</code></li></ul>`,
    `<p class="doux">Certificat établi le ${escape(frenchDate(cert.issuedOn))}.</p>`,
  ].join('');
}

export interface CertificatePageConfig {
  db: SqlDatabase;
  now?: () => Date;
}

/** La page du certificat ; `null` hors de son adresse. Un jeton mal formé ou inconnu : la même page « lien inconnu ». */
export async function handleCertificatePage(request: Request, config: CertificatePageConfig): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith(CERTIFICATE_PAGE_PATH)) return null;
  if (request.method !== 'GET' && request.method !== 'HEAD') return page(405, 'Méthode non admise', '<p>Cette page se lit seulement.</p>');
  const token = url.pathname.slice(CERTIFICATE_PAGE_PATH.length);
  const unknown = () => page(404, 'Lien inconnu', '<p>Ce lien de certificat n’est pas valable.</p>');
  if (!/^[0-9a-f]{32}$/.test(token)) return unknown();
  const now = config.now ?? (() => new Date());
  // Le certificat se lit par son jeton seul : aucune autre donnée n'est lue, aucun stockage de fichier n'est ouvert.
  const certs = new studio.CertificatsPhotos(config.db, NO_ACCESS, new SqlJournalStore(config.db), NO_FILES, { now });
  const cert = await certs.certificate(token);
  return cert ? respond(200, renderCertificatePage(cert)) : unknown();
}

/** Une panne de la page publique : au journal, sans donnée [R13]. */
export async function certificatePageError(db: SqlDatabase, error: unknown, now: () => Date): Promise<void> {
  await journalError(new SqlJournalStore(db), 'public:certificat_photo', 'studio.certificat', error, now);
}

// La lecture publique n'a besoin ni des droits ni du stockage : s'ils étaient appelés, c'est une erreur du code.
const refuse = (): never => {
  throw new Error('Lecture publique du certificat : ni droits ni stockage');
};
const NO_ACCESS = new Proxy({}, { get: refuse }) as never;
const NO_FILES = { has: refuse };
