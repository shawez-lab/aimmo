/**
 * « Créer l'accès de Shawez » (Z02), lancé par le travail GitHub du même nom, jamais depuis un poste.
 *
 * 1. Tire au hasard un jeton d'invitation, qui ne vit que dans la mémoire de ce programme et dans le lien du mail.
 * 2. Range en base, par `wrangler d1 execute`, l'empreinte du jeton, son échéance (24 heures), les rôles qu'il ouvre
 *    (agent et direction), et la fiche d'agent de la personne si elle manque. Aucune clé n'est créée ici : le Worker
 *    les tire au moment où le lien sert, et n'en garde que l'empreinte.
 * 3. Envoie le lien, une seule fois, à l'adresse donnée au lancement, par l'envoi de mails de Cloudflare.
 *
 * Ce mail suit R98 : il n'est pas un envoi au sens du contrôle central, il ne s'adresse à aucun client, il va à la
 * personne du réseau, à l'adresse donnée en lançant le travail, et il ne contient que son lien d'accès.
 * Rien n'est écrit dans le dépôt, ni au journal du travail : ni le jeton, ni le lien, ni l'adresse.
 *
 * Le secret `API_KEYS` du Worker n'est jamais lu ni réécrit : ses empreintes restent toutes.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const TTL_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_APP_URL = 'https://aimmo-api.shawez.workers.dev/app/';

export interface AccessRequest {
  firstName: string;
  lastName: string;
  email: string;
  sender: string;
  networkId: string;
  agentId: string;
  appUrl: string;
}

const NAME = /^[\p{L}][\p{L}' -]{0,59}$/u;
const EMAIL = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;
const ID = /^[a-z0-9][a-z0-9-]{1,62}$/;

/** Lit et vérifie la demande ; une valeur douteuse arrête tout avant la moindre écriture. */
export function readRequest(env: Record<string, string | undefined>): AccessRequest {
  const get = (name: string): string => (env[name] ?? '').trim();
  const request: AccessRequest = {
    firstName: get('ACCES_PRENOM'),
    lastName: get('ACCES_NOM'),
    email: get('ACCES_MAIL'),
    sender: get('ACCES_EXPEDITEUR'),
    networkId: get('ACCES_RESEAU'),
    agentId: get('ACCES_AGENT'),
    appUrl: get('ACCES_APP') || DEFAULT_APP_URL,
  };
  if (!NAME.test(request.firstName)) throw new Error('Prénom manquant ou mal formé.');
  if (!NAME.test(request.lastName)) throw new Error('Nom manquant ou mal formé.');
  if (!EMAIL.test(request.email)) throw new Error('Adresse du destinataire manquante ou mal formée.');
  if (!EMAIL.test(request.sender)) throw new Error('Adresse d’expédition manquante ou mal formée.');
  if (!ID.test(request.networkId)) throw new Error('Identifiant du réseau mal formé.');
  if (!ID.test(request.agentId)) throw new Error('Identifiant de l’agent mal formé.');
  let url: URL;
  try {
    url = new URL(request.appUrl);
  } catch {
    throw new Error('Adresse de l’application mal formée.');
  }
  if (url.protocol !== 'https:' || url.search !== '' || url.hash !== '' || !url.pathname.endsWith('/app/')) {
    throw new Error('L’adresse de l’application doit être en https et finir par /app/.');
  }
  return request;
}

/** Un jeton de 32 octets au hasard, en base64url : 43 caractères. */
export function newToken(): string {
  return randomBytes(32).toString('base64url');
}

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

const q = (value: string): string => `'${value.replace(/'/g, "''")}'`;

/**
 * Les instructions SQL de l'invitation : seulement l'empreinte du jeton, jamais le jeton. Le réseau et la fiche de
 * l'agent sont créés s'ils manquent, jamais modifiés ni effacés.
 */
export function invitationSql(request: AccessRequest, tokenSha256: string, now: Date, id: string = randomUUID()): string {
  if (!/^[0-9a-f]{64}$/.test(tokenSha256)) throw new Error('empreinte mal formée');
  const at = now.toISOString();
  const expires = new Date(now.getTime() + TTL_MS).toISOString();
  const grants = JSON.stringify([
    { role: 'agent', userId: request.agentId },
    { role: 'direction', userId: request.agentId },
  ]);
  return [
    `INSERT OR IGNORE INTO networks (id, name, created_at) VALUES (${q(request.networkId)}, 'AIMMO', ${q(at)});`,
    `INSERT OR IGNORE INTO agents (id, network_id, first_name, last_name, status, created_at, updated_at) VALUES (${q(request.agentId)}, ${q(request.networkId)}, ${q(request.firstName)}, ${q(request.lastName)}, 'active', ${q(at)}, ${q(at)});`,
    // Le réseau de l'invitation est lu sur la fiche de l'agent : une fiche absente, d'un autre réseau ou partie donne
    // un réseau vide, refusé par la base, et tout s'arrête avant le mail.
    `INSERT INTO access_invitations (id, network_id, token_sha256, grants, expires_at, created_at) VALUES (${q(id)}, (SELECT network_id FROM agents WHERE id = ${q(request.agentId)} AND network_id = ${q(request.networkId)} AND status = 'active'), ${q(tokenSha256)}, ${q(grants)}, ${q(expires)}, ${q(at)});`,
  ].join('\n');
}

/** Le lien d'invitation : le jeton après `#`, que le navigateur n'envoie jamais au serveur. */
export function invitationLink(appUrl: string, token: string): string {
  return `${appUrl}#invitation=${token}`;
}

function parisTime(date: Date): string {
  return new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', dateStyle: 'full', timeStyle: 'short' }).format(date);
}

/** Le mail : court, en français, sans rien d'autre que le lien et son mode d'emploi. */
export function invitationMail(request: AccessRequest, link: string, now: Date): { to: string; from: string; subject: string; text: string; html: string } {
  const until = parisTime(new Date(now.getTime() + TTL_MS));
  const text = [
    `Bonjour ${request.firstName},`,
    '',
    'Voici votre lien pour entrer dans l’application AIMMO. Ouvrez-le sur votre téléphone : vous serez connecté sans rien saisir.',
    '',
    link,
    '',
    `Il ne sert qu’une fois et reste valable jusqu’au ${until}. Ne le transférez à personne.`,
    'Si vous n’avez rien demandé, ignorez ce mail : sans ce lien, personne n’entre.',
  ].join('\n');
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const html = `<p>Bonjour ${esc(request.firstName)},</p>
<p>Voici votre lien pour entrer dans l’application AIMMO. Ouvrez-le sur votre téléphone : vous serez connecté sans rien saisir.</p>
<p><a href="${esc(link)}">Entrer dans AIMMO</a></p>
<p>Il ne sert qu’une fois et reste valable jusqu’au ${esc(until)}. Ne le transférez à personne.</p>
<p>Si vous n’avez rien demandé, ignorez ce mail : sans ce lien, personne n’entre.</p>`;
  return { to: request.email, from: request.sender, subject: 'Votre accès à AIMMO', text, html };
}

export interface Runner {
  d1(sqlFile: string): { ok: boolean };
  send(mail: ReturnType<typeof invitationMail>): Promise<{ ok: boolean; detail: string }>;
  log(line: string): void;
  now(): Date;
}

/** Le déroulé complet. Les lignes écrites au journal du travail ne portent ni jeton, ni lien, ni adresse. */
export async function createAccess(env: Record<string, string | undefined>, runner: Runner): Promise<boolean> {
  const request = readRequest(env);
  const now = runner.now();
  const token = newToken();
  const dir = mkdtempSync(join(tmpdir(), 'aimmo-acces-'));
  const file = join(dir, 'invitation.sql');
  writeFileSync(file, invitationSql(request, sha256(token), now), { mode: 0o600 });
  if (!runner.d1(file).ok) {
    runner.log('Invitation non rangée en base : aucun mail n’est parti.');
    return false;
  }
  runner.log('Invitation rangée en base (empreinte seule), valable 24 heures.');
  const sent = await runner.send(invitationMail(request, invitationLink(request.appUrl, token), now));
  if (!sent.ok) {
    runner.log(`Le mail n’est pas parti (${sent.detail}). L’invitation, que personne ne connaît, expirera seule dans 24 heures.`);
    return false;
  }
  runner.log('Mail d’invitation envoyé.');
  return true;
}

/** Réduit une réponse de Cloudflare à des codes d'erreur, sans adresse ni contenu. */
export function sendFailureDetail(status: number, body: unknown): string {
  const errors = body !== null && typeof body === 'object' ? (body as { errors?: unknown }).errors : undefined;
  const codes = Array.isArray(errors)
    ? errors.map((e) => (e !== null && typeof e === 'object' && 'code' in e ? String((e as { code: unknown }).code) : '?')).filter((c) => /^[A-Za-z0-9_.-]{1,40}$/.test(c))
    : [];
  return `HTTP ${status}${codes.length ? `, codes ${codes.join(', ')}` : ''}`;
}

async function main(): Promise<void> {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID ?? '';
  const apiToken = process.env.CLOUDFLARE_API_TOKEN ?? '';
  const wrangler = process.env.WRANGLER ?? 'wrangler';
  const ok = await createAccess(process.env, {
    d1(sqlFile) {
      const result = spawnSync('npx', ['-y', wrangler, 'd1', 'execute', 'aimmo', '--remote', '--file', sqlFile], { cwd: 'packages/api', stdio: ['ignore', 'ignore', 'inherit'] });
      return { ok: result.status === 0 };
    },
    async send(mail) {
      const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/email/sending/send`, {
        method: 'POST',
        headers: { authorization: `Bearer ${apiToken}`, 'content-type': 'application/json' },
        body: JSON.stringify(mail),
      });
      let body: unknown = null;
      try {
        body = await response.json();
      } catch {
        body = null;
      }
      const success = response.ok && body !== null && typeof body === 'object' && (body as { success?: unknown }).success === true;
      return { ok: success, detail: sendFailureDetail(response.status, body) };
    },
    log: (line) => console.log(line),
    now: () => new Date(),
  });
  if (!ok) process.exit(1);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((error: unknown) => {
    // Seul le message, écrit par ce programme : jamais un jeton ni une adresse.
    console.error(error instanceof Error ? error.message : 'Erreur inconnue.');
    process.exit(1);
  });
}
