/**
 * La désinscription des alertes aux acquéreurs (T03) : la page du lien porté par chaque alerte [R49]. Un GET ne change
 * rien (les messageries ouvrent les liens d'elles-mêmes) : il montre un bouton ; seul le POST du bouton retire
 * l'accord. Aucune donnée de la personne n'est montrée, aucune n'est écrite au journal [R13]. L'adresse ne porte aucun
 * chiffre, pour qu'aucun chiffre du texte de l'alerte ne vienne d'ailleurs que du bien [R10].
 */
import { Alertes, SqlJournalStore, type SqlDatabase } from '@aimmo/core';

export const UNSUBSCRIBE_PATH = '/alertes/desinscription/';

const CSP = "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

function page(status: number, title: string, body: string): Response {
  const html = `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${title}</title>
<style>
:root{color-scheme:light dark;--fond:#f7f5f0;--texte:#1d1b18;--accent:#1f4d3a}
@media (prefers-color-scheme:dark){:root{--fond:#161513;--texte:#efece6;--accent:#8fc9ac}}
body{margin:0;background:var(--fond);color:var(--texte);font:17px/1.5 system-ui,sans-serif}
main{max-width:32rem;margin:0 auto;padding:3rem 1rem}
h1{font-size:1.4rem;line-height:1.25;margin:0 0 1rem}
button{font:inherit;border:0;border-radius:.6rem;padding:.8rem 1.2rem;background:var(--accent);color:var(--fond);cursor:pointer;min-height:44px}
button:focus-visible{outline:3px solid var(--texte);outline-offset:3px}
</style>
</head>
<body><main><h1>${title}</h1>${body}</main></body>
</html>`;
  return new Response(html, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': CSP, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' },
  });
}

export interface UnsubscribeConfig {
  db: SqlDatabase;
  now?: () => Date;
}

/** Rend la page, ou null si l'adresse n'est pas celle de la désinscription. */
export async function handleUnsubscribe(request: Request, config: UnsubscribeConfig): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith(UNSUBSCRIBE_PATH)) return null;
  const token = url.pathname.slice(UNSUBSCRIBE_PATH.length);
  if (!/^[a-z]{32}$/.test(token)) return page(404, 'Lien inconnu', '<p>Ce lien de désinscription n’est pas valable.</p>');
  if (request.method === 'GET') {
    return page(
      200,
      'Ne plus recevoir les alertes de biens',
      `<p>Vous ne recevrez plus d’alertes de biens de votre agent immobilier, sur aucun canal.</p><form method="post" action="${UNSUBSCRIBE_PATH}${token}"><button type="submit">Me désinscrire</button></form>`,
    );
  }
  if (request.method !== 'POST') return page(405, 'Méthode non admise', '<p>Utilisez le bouton de la page.</p>');
  const now = config.now ?? (() => new Date());
  const alertes = new Alertes(config.db, new SqlJournalStore(config.db), { now });
  if (!(await alertes.unsubscribe(token))) return page(404, 'Lien inconnu', '<p>Ce lien de désinscription n’est pas valable.</p>');
  return page(200, 'C’est fait', '<p>Vous ne recevrez plus d’alertes de biens. Votre agent immobilier reste joignable si vous le souhaitez.</p>');
}
