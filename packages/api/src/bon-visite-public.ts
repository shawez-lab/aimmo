/**
 * AU075b · Les pages publiques du bon de visite (M08) [R40, R16, R506] : servies sans clé, le jeton du lien seul ouvre.
 *
 *   GET  /visite/signer/<jeton>       le bon à lire, puis le champ du code reçu dans un autre message
 *   POST /visite/signer/<jeton>       code=<6 chiffres> : le visiteur signe, à distance, sans l'agent
 *   GET  /visite/exemplaire/<jeton>   l'exemplaire signé et sa preuve, pendant un an
 *
 * Les pages suivent le système de design (`renderPublicPage`), sans script ni rien d'extérieur : le formulaire est un
 * vrai formulaire, envoyé par le navigateur. Le code tapé n'est gardé nulle part, la page ne dit ni nom ni adresse,
 * et chaque refus est dit en mots, jamais par son code. Le bon affiché est le bon rangé, paragraphe par paragraphe, en
 * texte : son empreinte est celle qui entre dans la preuve.
 */
import { Acces, FicheClient, FicheUnique, renderPublicPage, SignatureBon, SqlJournalStore, Visites, type SqlDatabase } from '@aimmo/core';

export const BON_VISITE_PUBLIC_PATH = '/visite/';
const SIGN = /^\/visite\/signer\/([0-9a-f]{64})$/;
const COPY = /^\/visite\/exemplaire\/([0-9a-f]{64})$/;
const MAX_FORM_BYTES = 2_000;

const CSP = "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";
const HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'content-security-policy': CSP,
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
} as const;

const escape = (t: string): string => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** Chaque refus, dit en mots au visiteur. */
export const PUBLIC_SLIP_REFUSALS: Readonly<Record<string, string>> = Object.freeze({
  unknown: 'Ce lien n’est pas valable.',
  already_signed: 'Ce bon de visite est déjà signé. La preuve de votre signature vous a été envoyée.',
  blocked: 'Cinq codes faux : la signature est bloquée. Votre agent peut vous en envoyer une nouvelle.',
  expired: 'Ce lien ou ce code a expiré. Votre agent peut vous en envoyer un nouveau.',
  not_open: 'Cette signature n’est plus ouverte. Votre agent peut vous en envoyer une nouvelle.',
  slip_changed: 'Le bon a changé depuis l’envoi du lien : votre agent doit vous en envoyer un nouveau.',
  wrong_code: 'Code faux. Vérifiez le code reçu et réessayez.',
  bad_drawing: 'La signature n’a pas pu être lue. Réessayez.',
});

const say = (code: string): string => PUBLIC_SLIP_REFUSALS[code] ?? 'Ce bon ne peut pas être signé pour le moment.';

function page(status: number, title: string, body: string): Response {
  return new Response(renderPublicPage({ title, body, kicker: 'Bon de visite' }), { status, headers: HEADERS });
}

/** La page à signer : le bon en texte, puis le seul champ du code. Rendue par le code, sans script. */
export function renderSlipSignPage(o: { action: string; paragraphs: string[]; slipHash: string; error?: string | null }): string {
  const error = o.error ? `<p class="alerte" role="alert">${escape(o.error)}</p>` : '';
  return renderPublicPage({
    title: 'Votre bon de visite, à signer',
    kicker: 'Bon de visite',
    body:
      '<p class="doux">Lisez votre bon en entier, puis tapez le code reçu dans un autre message. Votre agent ne le connaît pas : ne le donnez à personne.</p>' +
      '<section class="brouillon" aria-label="Le bon de visite">' +
      o.paragraphs.map((p) => `<p>${escape(p).replace(/\n/g, '<br>')}</p>`).join('') +
      '</section>' +
      `<p class="doux">Empreinte du bon (SHA-256) : ${escape(o.slipHash)}</p>` +
      error +
      `<form method="post" action="${escape(o.action)}"><label for="code">Code reçu (6 chiffres)</label>` +
      '<input id="code" name="code" type="text" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required>' +
      '<button type="submit">Signer le bon de visite</button></form>' +
      '<p class="doux">Signature d’essai : sans valeur juridique tant que le dossier de preuve n’est pas validé.</p>',
  });
}

export interface BonVisitePublicConfig {
  db: SqlDatabase;
  now?: () => Date;
  /** Le début des liens (`BON_VISITE_BASE`), pour que la preuve envoyée porte le lien de l'exemplaire. */
  baseUrl: string;
}

/** Les liens du bon, depuis leur début (`https://…/`) : la signature et l'exemplaire. */
export function slipLinks(baseUrl: string): { signUrl: (token: string) => string; copyUrl: (token: string) => string } {
  return { signUrl: (token) => `${baseUrl}visite/signer/${token}`, copyUrl: (token) => `${baseUrl}visite/exemplaire/${token}` };
}

function signatureBon(config: BonVisitePublicConfig): SignatureBon {
  const now = config.now ?? (() => new Date());
  const journal = new SqlJournalStore(config.db);
  const fiches = new FicheClient(config.db, { now });
  const acces = new Acces(config.db, fiches, new FicheUnique(config.db, fiches, { now }), journal, { now });
  return new SignatureBon(config.db, journal, new Visites(config.db, journal, acces, { now }), { now, ...slipLinks(config.baseUrl) });
}

async function readCode(request: Request): Promise<string | null> {
  const type = request.headers.get('content-type') ?? '';
  if (!type.startsWith('application/x-www-form-urlencoded')) return null;
  const raw = await request.text();
  if (raw.length > MAX_FORM_BYTES) return null;
  const code = new URLSearchParams(raw).get('code');
  return code === null ? null : code.trim();
}

/** Les pages publiques du bon, ou `null` si l'adresse n'est pas à elles. */
export async function handleBonVisitePublic(request: Request, config: BonVisitePublicConfig): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  if (!path.startsWith(BON_VISITE_PUBLIC_PATH)) return null;
  const sign = SIGN.exec(path);
  const copy = COPY.exec(path);
  if (!sign && !copy) return page(404, 'Lien inconnu', `<p>${say('unknown')}</p>`);
  const bon = signatureBon(config);
  if (copy) {
    if (request.method !== 'GET' && request.method !== 'HEAD') return page(405, 'Méthode non admise', '<p>Ouvrez le lien reçu.</p>');
    const r = await bon.copy(copy[1]);
    if (!r.ok) return page(r.code === 'expired' ? 410 : 404, 'Exemplaire indisponible', `<p>${r.code === 'expired' ? 'Cet exemplaire n’est plus en ligne : il l’a été un an.' : say('unknown')}</p>`);
    return new Response(r.html, { status: 200, headers: HEADERS });
  }
  const token = sign![1]!;
  const action = `${BON_VISITE_PUBLIC_PATH}signer/${token}`;
  if (request.method === 'GET' || request.method === 'HEAD') {
    const r = await bon.readByLink(token);
    if (!r.ok) return page(r.code === 'unknown' ? 404 : 409, 'Signature indisponible', `<p>${say(r.code)}</p>`);
    return new Response(renderSlipSignPage({ action, paragraphs: r.paragraphs, slipHash: r.slipHash }), { status: 200, headers: HEADERS });
  }
  if (request.method !== 'POST') return page(405, 'Méthode non admise', '<p>Utilisez le bouton de la page.</p>');
  const code = await readCode(request);
  const done = await bon.signByLink(token, { code: code ?? '' });
  if (!done.ok) {
    if (done.code === 'wrong_code') {
      const again = await bon.readByLink(token);
      if (again.ok) return new Response(renderSlipSignPage({ action, paragraphs: again.paragraphs, slipHash: again.slipHash, error: say('wrong_code') }), { status: 422, headers: HEADERS });
      return page(409, 'Signature indisponible', `<p>${say(again.code)}</p>`);
    }
    return page(done.code === 'unknown' ? 404 : 409, 'Signature indisponible', `<p>${say(done.code)}</p>`);
  }
  const p = done.value.proof;
  return page(
    200,
    'Votre bon de visite est signé',
    `<p>Signé à distance, par code à usage unique.</p><p class="doux">Empreinte du bon signé (SHA-256) : ${escape(p.slipHash)}</p>` +
      (done.value.copy === 'remis'
        ? '<p>Vous avez reçu la preuve de votre signature, avec le lien de votre exemplaire, valable un an.</p>'
        : '<p>La preuve n’a pas pu vous être envoyée : votre agent la garde avec la visite et peut vous la montrer.</p>') +
      '<p class="doux">Signature d’essai : sans valeur juridique tant que le dossier de preuve n’est pas validé.</p>',
  );
}
