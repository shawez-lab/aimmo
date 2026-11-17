/**
 * La désinscription de la lettre d'information (HX53, BR112) : la page du lien porté par chaque lettre [R584]. Un GET
 * ne change rien (les messageries ouvrent les liens d'elles-mêmes) : il montre un bouton ; seul le POST du bouton
 * retire l'accord de la lettre, et rien d'autre : ni les alertes, ni le suivi de valeur. Aucune donnée de la personne
 * n'est montrée, aucune n'est écrite au journal [R13]. L'adresse ne porte aucun chiffre [R10].
 */
import { SqlJournalStore, renderPublicPage, type SqlDatabase } from '@aimmo/core';
import { LettreInformation } from '../../core/src/marketing/index.ts';
import { LETTER_UNSUBSCRIBE_PATH } from './marketing-passage.ts';

const CSP = "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

function page(status: number, title: string, body: string): Response {
  const html = renderPublicPage({ title, body, kicker: 'Lettre d’information' });
  return new Response(html, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': CSP, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' },
  });
}

const unknownLink = (): Response => page(404, 'Lien inconnu', '<p>Ce lien de désinscription n’est pas valable.</p>');

/** Rend la page, ou null si l'adresse n'est pas celle de la désinscription de la lettre. */
export async function handleLetterUnsubscribe(request: Request, config: { db: SqlDatabase; now?: () => Date }): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith(LETTER_UNSUBSCRIBE_PATH)) return null;
  const token = url.pathname.slice(LETTER_UNSUBSCRIBE_PATH.length);
  if (!/^[a-z]{32}$/.test(token)) return unknownLink();
  if (request.method === 'GET') {
    return page(
      200,
      'Ne plus recevoir la lettre d’information',
      `<p>Vous ne recevrez plus la lettre d’information de votre agent immobilier. Vos autres choix ne changent pas.</p><form method="post" action="${LETTER_UNSUBSCRIBE_PATH}${token}"><button type="submit">Me désinscrire</button></form>`,
    );
  }
  if (request.method !== 'POST') return page(405, 'Méthode non admise', '<p>Utilisez le bouton de la page.</p>');
  const now = config.now ?? (() => new Date());
  const lettre = new LettreInformation(config.db, new SqlJournalStore(config.db), { now });
  if (!(await lettre.unsubscribe(token))) return unknownLink();
  return page(200, 'C’est fait', '<p>Vous ne recevrez plus la lettre d’information. Votre agent immobilier reste joignable si vous le souhaitez.</p>');
}
