import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { FicheClient, SqlJournalStore, applyMigrations, verifyChain, type SqlDatabase } from '@aimmo/core';
import { handleEmail, handleRequest, parseRawMail, sha256Hex, type InboundEmail } from '../src/index.ts';
import { fromD1, type D1Database } from '../src/d1.ts';
import worker, { type Env } from '../src/worker.ts';
import { loadMigrations } from '../../core/test/migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from '../../core/test/sqlite.ts';
import { fakeD1 } from './fake-d1.ts';

// Clé inventée pour les tests, jamais utilisée ailleurs.
const KEY_SITE = 'test-cle-depot-site-eeeeeeeeeeeeeeeeeeeeeeeeee';
const BASE = 'https://aimmo-api.example.workers.dev';
const MINUTE = 60_000;
// Un mardi à 10 h et un dimanche à 23 h, heure de Paris.
const TUESDAY_10H = Date.parse('2026-12-08T09:00:00.000Z');
const SUNDAY_23H = Date.parse('2026-12-06T22:00:00.000Z');

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

function rawMail(lines: string[]): Uint8Array {
  return enc(lines.join('\r\n'));
}

function emailMessage(bytes: Uint8Array): InboundEmail & { forwarded: string[] } {
  const forwarded: string[] = [];
  return {
    raw: new ReadableStream({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    }),
    rawSize: bytes.length,
    forwarded,
    async forward(to: string) {
      forwarded.push(to);
    },
  };
}

async function world() {
  const d1: D1Database = fakeD1(openMemoryDatabase());
  const db: SqlDatabase = fromD1(d1);
  await applyMigrations(db, loadMigrations());
  const fiches = new FicheClient(db);
  const network = await fiches.createNetwork('Réseau test');
  let clock = TUESDAY_10H;
  const now = (): Date => new Date(clock);
  const mailConfig = {
    db,
    mode: 'essai',
    networkId: network.id,
    forwardTo: 'boite-agent@example.test',
    ownAddresses: 'assistant@example.test',
    now,
  };
  const intakeKeys = JSON.stringify([{ sha256: await sha256Hex(KEY_SITE), networkId: network.id, source: 'site_form' }]);
  const outbox = async () => (await db.all<{ message_id: string; channel: string }>('SELECT * FROM trial_outbox')).length;
  return {
    db,
    d1,
    network,
    mailConfig,
    intakeKeys,
    outbox,
    journal: new SqlJournalStore(db),
    setClock: (t: number) => {
      clock = t;
    },
    now,
  };
}

let seq = 0;
// Prénoms inventés, sans chiffre : un chiffre dans la réponse doit venir des données [R10].
const NAMES = ['Alix', 'Basile', 'Céleste', 'Dorian', 'Elsa', 'Fabien', 'Gaëlle', 'Hugo', 'Inès', 'Jules'];
const nameOf = (i: number): string => `${NAMES[i % NAMES.length]}${i >= NAMES.length ? 'ne' : ''}`;
function clientMail(i: number, at: Date, extra: { portal?: boolean } = {}): Uint8Array {
  seq += 1;
  const from = extra.portal ? 'SeLoger <demandes@contact.seloger.com>' : `${nameOf(i)} Essai <client${i}.mail@example.test>`;
  return rawMail([
    `From: ${from}`,
    ...(extra.portal ? [`Reply-To: ${nameOf(i)} Acheteur <acheteur${i}@example.test>`] : []),
    'To: Agence <agence@example.test>',
    `Subject: =?utf-8?Q?Demande_d=E2=80=99information_n=C2=B0${i}?=`,
    `Date: ${at.toUTCString()}`,
    `Message-ID: <mail-${seq}-${i}@example.test>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: quoted-printable',
    '',
    `Bonjour, je souhaiterais =C3=AAtre rappel=C3=A9 au sujet d'un bien.`,
  ]);
}

function siteForm(i: number, at: Date) {
  seq += 1;
  return {
    submissionId: `envoi-${seq}`,
    firstName: nameOf(i),
    email: `formulaire${i}@example.test`,
    phone: `+33 6 00 00 ${String(10 + (i % 90)).padStart(2, '0')} ${String(10 + seq % 90).padStart(2, '0')}`,
    message: 'Je souhaite être rappelé.',
    submittedAt: at.toISOString(),
  };
}

function postForm(config: { db: SqlDatabase; intakeKeys: string; now: () => Date }, body: unknown, key = KEY_SITE): Promise<Response> {
  const request = new Request(`${BASE}/v1/captation/formulaire`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return handleRequest(request, { db: config.db, apiKeys: undefined, intakeKeys: config.intakeKeys, mode: 'essai', now: config.now });
}

describeWithSqlite('C06 · mail et formulaire du site, en mode essai', () => {
  it('20 mails, de jour comme de nuit, portails compris : chacun a sa réponse prête en moins d’une minute, rien ne part', async () => {
    const w = await world();
    for (let i = 0; i < 20; i += 1) {
      const at = (i % 2 === 0 ? TUESDAY_10H : SUNDAY_23H) + i * MINUTE;
      w.setClock(at);
      const message = emailMessage(clientMail(i, new Date(at), { portal: i % 4 === 1 }));
      const [result] = await handleEmail(message, w.mailConfig);
      expect(result, `mail ${i}`).toMatchObject({ status: 'replied' });
      expect(result!.elapsedMs).toBeLessThan(MINUTE);
      expect(message.forwarded).toEqual(['boite-agent@example.test']);
    }
    expect(await w.outbox()).toBe(20);
    // Chaque réponse prête est au journal, sans texte ni adresse [R13], et la chaîne reste intacte.
    const entries = await w.journal.all();
    const trial = entries.filter((e) => e.type === 'envoi.essai');
    expect(trial).toHaveLength(20);
    expect(JSON.stringify(entries)).not.toMatch(/@example\.test|Bonjour|rappel/);
    expect((await verifyChain(entries)).ok).toBe(true);
  });

  it('[R18] le même mail reçu deux fois ne donne qu’une réponse', async () => {
    const w = await world();
    const bytes = clientMail(1, new Date(TUESDAY_10H));
    const first = await handleEmail(emailMessage(bytes), w.mailConfig);
    w.setClock(TUESDAY_10H + MINUTE);
    const again = await handleEmail(emailMessage(bytes), w.mailConfig);
    expect(first[0]).toMatchObject({ status: 'replied' });
    expect(again[0]).toMatchObject({ status: 'duplicate' });
    expect(await w.outbox()).toBe(1);
  });

  it('20 formulaires « Être rappelé », de jour comme de nuit : chacun a sa réponse prête par mail en moins d’une minute', async () => {
    const w = await world();
    const config = { db: w.db, intakeKeys: w.intakeKeys, now: w.now };
    for (let i = 0; i < 20; i += 1) {
      const at = (i % 2 === 0 ? TUESDAY_10H : SUNDAY_23H) + i * MINUTE;
      w.setClock(at);
      const response = await postForm(config, siteForm(i, new Date(at)));
      expect(response.status, `formulaire ${i}`).toBe(200);
      const body = (await response.json()) as { sent: boolean; data: { status: string }[] };
      expect(body.sent).toBe(false);
      expect(body.data).toEqual([expect.objectContaining({ status: 'replied' })]);
    }
    expect(await w.outbox()).toBe(20);
    const channels = await w.db.all<{ channel: string }>('SELECT DISTINCT channel FROM trial_outbox');
    expect(channels).toEqual([{ channel: 'email' }]);
  });

  it('[R18] le même formulaire envoyé deux fois ne donne qu’une réponse', async () => {
    const w = await world();
    const config = { db: w.db, intakeKeys: w.intakeKeys, now: w.now };
    const form = siteForm(1, new Date(TUESDAY_10H));
    await postForm(config, form);
    const again = (await (await postForm(config, form)).json()) as { data: { status: string }[] };
    expect(again.data[0]).toMatchObject({ status: 'duplicate' });
    expect(await w.outbox()).toBe(1);
  });

  it('une clé de dépôt ne dépose qu’un formulaire : sans elle rien n’entre, avec elle rien ne se lit', async () => {
    const w = await world();
    const config = { db: w.db, intakeKeys: w.intakeKeys, now: w.now };
    expect((await postForm(config, siteForm(1, new Date(TUESDAY_10H)), 'test-cle-inconnue-ffffffffffffffffffffffffff')).status).toBe(401);
    expect((await postForm({ ...config, intakeKeys: '' }, siteForm(2, new Date(TUESDAY_10H)))).status).toBe(503);
    const env: Env = { DB: w.d1, MODE: 'essai', INTAKE_KEYS: w.intakeKeys, API_KEYS: JSON.stringify([{ sha256: '0'.repeat(64), role: 'direction', userId: 'd', networkId: w.network.id }]) };
    const read = await worker.fetch(new Request(`${BASE}/v1/fiches`, { headers: { authorization: `Bearer ${KEY_SITE}` } }), env);
    expect(read.status).toBe(401);
    expect(await w.outbox()).toBe(0);
  });

  it('le Worker reçoit les mails : remis à la boîte de l’agent, jamais rejetés ; hors mode essai, rien n’est traité', async () => {
    const w = await world();
    const env: Env = { DB: w.d1, MODE: 'essai', MAIL_NETWORK_ID: w.network.id, MAIL_FORWARD_TO: 'boite-agent@example.test' };
    const message = emailMessage(clientMail(3, new Date()));
    await worker.email(message, env);
    expect(message.forwarded).toEqual(['boite-agent@example.test']);
    expect(await w.outbox()).toBe(1);
    const closed = emailMessage(clientMail(4, new Date()));
    expect(await handleEmail(closed, { ...w.mailConfig, mode: 'reel' })).toEqual([]);
    expect(closed.forwarded).toHaveLength(1);
    expect(await w.outbox()).toBe(1);
    // Nos propres mails ne sont pas des messages reçus.
    const own = emailMessage(rawMail(['From: assistant@example.test', 'Message-ID: <own-1@example.test>', 'Subject: Test', '', 'Bonjour']));
    expect(await handleEmail(own, w.mailConfig)).toEqual([]);
  });

  it('un mail illisible est rangé et signalé, jamais jeté ni répondu', async () => {
    const w = await world();
    const [result] = await handleEmail(emailMessage(rawMail(['Subject: sans expéditeur', '', 'texte'])), w.mailConfig);
    expect(result).toMatchObject({ status: 'unreadable' });
    expect(await w.db.all("SELECT id FROM inbound_messages WHERE status = 'unreadable'")).toHaveLength(1);
    expect(await w.outbox()).toBe(0);
  });

  it('shawez-immo n’est pas modifié : aucune route ni aucune liaison vers son site dans le Worker', () => {
    const toml = readFileSync(fileURLToPath(new URL('../wrangler.toml', import.meta.url)), 'utf8').replace(/#.*$/gm, '');
    expect(toml).not.toMatch(/shawez-immo\.com/);
    expect(toml).not.toMatch(/^\s*routes?\s*=/m);
    expect(toml).toMatch(/MODE = "essai"/);
  });
});

describeWithSqlite('lecture des mails bruts', () => {
  it('mots encodés, quoted-printable, base64, parties multiples et pièces jointes', () => {
    const mail = parseRawMail(
      rawMail([
        'From: =?utf-8?B?Q2FtaWxsZSBFc3NhaQ==?= <camille@example.test>',
        'Reply-To: camille.reponse@example.test',
        'Subject: =?iso-8859-1?Q?Int=E9ress=E9?= par la maison',
        'Message-ID: <abc@example.test>',
        'In-Reply-To: <parent@example.test>',
        'References: <racine@example.test> <parent@example.test>',
        'Date: Tue, 08 Dec 2026 10:00:00 +0100',
        'Content-Type: multipart/mixed; boundary="ext"',
        '',
        '--ext',
        'Content-Type: multipart/alternative; boundary=alt',
        '',
        '--alt',
        'Content-Type: text/html; charset=utf-8',
        'Content-Transfer-Encoding: base64',
        '',
        btoa('<p>Version HTML</p>'),
        '--alt',
        'Content-Type: text/plain; charset=utf-8',
        'Content-Transfer-Encoding: quoted-printable',
        '',
        'Bonjour, la maison est-elle toujours =C3=A0 vendre ?=',
        ' Merci.',
        '--alt--',
        '--ext',
        'Content-Type: application/pdf; name="plan.pdf"',
        'Content-Disposition: attachment; filename="plan.pdf"',
        'Content-Transfer-Encoding: base64',
        '',
        'JVBERi0=',
        '--ext--',
      ]),
    );
    expect(mail).toMatchObject({
      from: 'Camille Essai <camille@example.test>',
      replyTo: 'camille.reponse@example.test',
      subject: 'Intéressé par la maison',
      messageId: '<abc@example.test>',
      inReplyTo: '<parent@example.test>',
      references: '<racine@example.test> <parent@example.test>',
      attachments: 1,
    });
    expect(mail.text).toBe('Bonjour, la maison est-elle toujours à vendre ? Merci.');
  });

  it('un mail seulement en HTML, ou en latin-1, se lit ; un mail géant n’est pas lu au-delà des en-têtes', () => {
    const html = parseRawMail(rawMail(['From: a@example.test', 'Content-Type: text/html; charset=utf-8', '', '<div>Bonjour&nbsp;!</div><br>Au revoir']));
    expect(html.text).toBe('Bonjour !\nAu revoir');
    const latin = parseRawMail(new Uint8Array([...enc('From: a@example.test\r\nContent-Type: text/plain; charset=iso-8859-1\r\n\r\nD'), 0xe9, ...enc('j'), 0xe0]));
    expect(latin.text).toBe('Déjà');
    const big = parseRawMail(rawMail(['From: a@example.test', 'Subject: Gros', '', 'x'.repeat(10)]), 5_000_000);
    expect(big).toMatchObject({ subject: 'Gros', text: '', attachments: 1 });
  });
});
