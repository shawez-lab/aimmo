import { describe, expect, it } from 'vitest';
import { FicheClient, SqlJournalStore, applyMigrations, fromSyncSqlite, type SqlDatabase } from '../src/index.ts';
import { BoiteMail } from '../src/automatismes/boite-mail.ts';
import { GmailMailbox, MAILBOX_BATCH, MailboxError, OutlookMailbox, base64Bytes, headerAddresses, htmlText, mailboxError } from '../src/automatismes/boite-mail-reelle.ts';
import { ACCESS, REFRESH, SECRET, enc, fakeGmail, fakeOutlook, type FakeMail } from './boite-serveurs.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

// Un mardi de novembre 2026, 10 h à Paris. Clients, jetons, adresses et mails inventés.
const NOW = new Date('2026-11-24T09:00:00.000Z');
const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const now = () => NOW;
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const pdf = enc('%PDF-1.4\n% offre de prêt inventée\n%%EOF');
const tokens = new Map([['agent-1', REFRESH]]);
const gmailOf = (h: ReturnType<typeof fakeGmail>) => new GmailMailbox({ client: { clientId: 'x.apps.googleusercontent.com', clientSecret: SECRET }, refreshTokens: tokens, http: h.http, now });
const outlookOf = (h: ReturnType<typeof fakeOutlook>) => new OutlookMailbox({ client: { clientId: '00000000-0000-4000-8000-000000000001', clientSecret: SECRET, tenant: 'common' }, refreshTokens: tokens, http: h.http, now });

const codeOf = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return 'aucune erreur';
  } catch (error) {
    // Ni le jeton, ni le secret, ni une adresse, ni la réponse du service dans l'erreur [R13].
    const text = `${String(error)} ${JSON.stringify(error)}`;
    for (const s of [ACCESS, REFRESH, SECRET, '@exemple.test', 'adresse']) expect(text).not.toContain(s);
    return error instanceof MailboxError ? error.code : `autre : ${String(error)}`;
  }
};

describe('Gmail réel derrière MailboxProvider [R683]', () => {
  it('rend les mails reçus et envoyés de la boîte, avec leur fil, leurs adresses, leur texte et leurs pièces', async () => {
    const mails: FakeMail[] = [
      { id: 'g-2', threadId: 'fil-a', at: ago(2 * DAY), from: 'agent@exemple.test', to: ['Client@Exemple.test', 'autre@exemple.test'], sent: true, text: 'Je vous rappelle demain.' },
      { id: 'g-1', threadId: 'fil-a', at: ago(3 * DAY), from: 'client@exemple.test', html: '<p>Bonjour,</p><p>voici l&#39;offre &amp; le plan.</p><style>p{}</style>', attachments: [{ name: 'offre.pdf', type: 'application/pdf', bytes: pdf }] },
      { id: 'g-0', threadId: 'fil-z', at: ago(DAY), from: 'x@exemple.test', draft: true, text: 'brouillon' },
    ];
    const h = fakeGmail(mails);
    const got = await gmailOf(h).receivedSince('agent-1', ago(10 * DAY));
    expect(got.map((m) => m.externalId)).toEqual(['g-1', 'g-2']);
    const [received, sent] = got as [(typeof got)[0], (typeof got)[0]];
    expect(received).toMatchObject({ provider: 'gmail', threadId: 'fil-a', from: 'client@exemple.test', body: "Bonjour,\nvoici l'offre & le plan." });
    expect(received.direction).toBeUndefined();
    expect(received.receivedAt.toISOString()).toBe(ago(3 * DAY).toISOString());
    expect(received.attachments).toHaveLength(1);
    expect(received.attachments[0]!.fileName).toBe('offre.pdf');
    expect([...received.attachments[0]!.bytes]).toEqual([...pdf]);
    expect(sent).toMatchObject({ direction: 'out', to: ['client@exemple.test', 'autre@exemple.test'], body: 'Je vous rappelle demain.' });
    // Lecture seule : aucune adresse qui envoie, déplace ou efface ; le jeton d'accès est tiré une fois.
    expect(h.calls.every((c) => c.method === 'GET' || c.url === 'https://oauth2.googleapis.com/token')).toBe(true);
    expect(h.calls.some((c) => /send|modify|trash|delete|batch/i.test(new URL(c.url).pathname))).toBe(false);
    expect(h.tokens()).toBe(1);
    // La recherche part une seconde avant le curseur, sans brouillons, indésirables ni corbeille.
    const q = new URL(h.calls.find((c) => c.url.includes('/messages?'))!.url).searchParams.get('q');
    expect(q).toBe(`after:${Math.floor(ago(10 * DAY).getTime() / 1000) - 1} -in:chats -in:spam -in:trash -in:drafts`);
  });

  it('première lecture : 30 jours ; plus de 50 mails : les 50 plus anciens, le reste à la lecture suivante [R18]', async () => {
    const mails: FakeMail[] = Array.from({ length: 70 }, (_, i) => ({ id: `g-${i}`, threadId: `fil-${i}`, at: ago((70 - i) * 10 * MIN), from: 'c@exemple.test', text: `mail ${i}` }));
    const h = fakeGmail(mails);
    const box = gmailOf(h);
    const first = await box.receivedSince('agent-1', null);
    expect(first).toHaveLength(MAILBOX_BATCH);
    expect(first.map((m) => m.externalId)).toEqual(mails.slice(0, 50).map((m) => m.id));
    const q = new URL(h.calls.find((c) => c.url.includes('/messages?'))!.url).searchParams.get('q');
    expect(q).toContain(`after:${Math.floor(ago(30 * DAY).getTime() / 1000) - 1} `);
    const next = await box.receivedSince('agent-1', first[first.length - 1]!.receivedAt);
    expect(next.map((m) => m.externalId)).toEqual(mails.slice(49).map((m) => m.id));
  });

  it('une pièce trop grosse n’est pas téléchargée : elle arrive vide', async () => {
    const big = new Uint8Array(21 * 1024 * 1024);
    const h = fakeGmail([{ id: 'g-1', threadId: 'f', at: ago(DAY), from: 'c@exemple.test', text: 'x', attachments: [{ name: 'gros.pdf', type: 'application/pdf', bytes: big }] }]);
    const [m] = await gmailOf(h).receivedSince('agent-1', ago(2 * DAY));
    expect(m!.attachments[0]!.bytes.length).toBe(0);
    expect(h.calls.some((c) => c.url.includes('/attachments/'))).toBe(false);
  });

  it('chaque panne a son code fermé, sans rien de la réponse [R13]', async () => {
    expect(await codeOf(gmailOf(fakeGmail([], { token: { status: 400, body: { error: 'invalid_grant', error_description: 'adresse client@exemple.test' } } })).receivedSince('agent-1', null))).toBe('connexion');
    expect(await codeOf(gmailOf(fakeGmail([], { list: { status: 403, body: { error: { status: 'PERMISSION_DENIED' } } } })).receivedSince('agent-1', null))).toBe('droits');
    expect(await codeOf(gmailOf(fakeGmail([], { list: { status: 429, body: { error: { status: 'RESOURCE_EXHAUSTED' } } } })).receivedSince('agent-1', null))).toBe('limite');
    expect(await codeOf(gmailOf(fakeGmail([], { list: { status: 500, body: 'adresse client@exemple.test' } })).receivedSince('agent-1', null))).toBe('panne');
    expect(await codeOf(gmailOf(fakeGmail([], { cut: true })).receivedSince('agent-1', null))).toBe('panne');
    // Un agent sans jeton : jamais lu.
    expect(await codeOf(gmailOf(fakeGmail([])).receivedSince('agent-2', null))).toBe('connexion');
    // Plus de 20 pages de clés : trop à lire d'un coup, rien n'est rendu.
    const many: FakeMail[] = Array.from({ length: 10_001 }, (_, i) => ({ id: `g-${i}`, threadId: 'f', at: ago(DAY + i * 1000), from: 'c@exemple.test', text: '' }));
    expect(await codeOf(gmailOf(fakeGmail(many)).receivedSince('agent-1', null))).toBe('trop');
  });
});

describe('Outlook réel derrière MailboxProvider [R683]', () => {
  it('lit la réception et les envoyés, avec la conversation comme fil, et leurs pièces', async () => {
    const h = fakeOutlook([
      { id: 'o-1', threadId: 'conv-1', at: ago(3 * DAY), from: 'Client@Exemple.test', html: '<div>Voici <b>le plan</b></div>', attachments: [{ name: 'plan.pdf', type: 'application/pdf', bytes: pdf }] },
      { id: 'o-2', threadId: 'conv-1', at: ago(2 * DAY), from: 'agent@exemple.test', to: ['client@exemple.test'], sent: true, text: 'Merci.' },
      { id: 'o-3', threadId: 'conv-9', at: ago(DAY), from: 'x@exemple.test', draft: true, text: 'brouillon' },
    ]);
    const got = await outlookOf(h).receivedSince('agent-1', ago(10 * DAY));
    expect(got.map((m) => m.externalId)).toEqual(['o-1', 'o-2']);
    expect(got[0]).toMatchObject({ provider: 'outlook', threadId: 'conv-1', from: 'client@exemple.test', body: 'Voici le plan' });
    expect([...got[0]!.attachments[0]!.bytes]).toEqual([...pdf]);
    expect(got[1]).toMatchObject({ direction: 'out', to: ['client@exemple.test'], body: 'Merci.' });
    expect(h.calls.every((c) => c.method === 'GET' || c.url.startsWith('https://login.microsoftonline.com/common/'))).toBe(true);
    const tokenCall = h.calls.find((c) => c.url.startsWith('https://login.microsoftonline.com/'))!;
    expect(new URLSearchParams(tokenCall.body!).get('scope')).toBe('offline_access https://graph.microsoft.com/Mail.Read');
  });

  it('un dossier coupé : rien de plus récent que son dernier mail n’est rendu, le curseur ne saute rien [R18]', async () => {
    const inbox: FakeMail[] = Array.from({ length: 60 }, (_, i) => ({ id: `in-${i}`, threadId: `c-${i}`, at: ago((60 - i) * 10 * MIN), from: 'c@exemple.test', text: 'x' }));
    const sentLate: FakeMail = { id: 'out-1', threadId: 'c-x', at: ago(MIN), from: 'agent@exemple.test', to: ['c@exemple.test'], sent: true, text: 'y' };
    const box = outlookOf(fakeOutlook([...inbox, sentLate]));
    const first = await box.receivedSince('agent-1', ago(DAY));
    expect(first.map((m) => m.externalId)).toEqual(inbox.slice(0, 50).map((m) => m.id));
    const next = await box.receivedSince('agent-1', first[first.length - 1]!.receivedAt);
    expect(next.map((m) => m.externalId)).toEqual([...inbox.slice(49).map((m) => m.id), 'out-1']);
  });

  it('pannes : codes fermés [R13]', async () => {
    expect(await codeOf(outlookOf(fakeOutlook([], { token: { status: 400, body: { error: 'invalid_grant' } } })).receivedSince('agent-1', null))).toBe('connexion');
    expect(await codeOf(outlookOf(fakeOutlook([], { list: { status: 403, body: { error: { code: 'ErrorAccessDenied' } } } })).receivedSince('agent-1', null))).toBe('droits');
    expect(await codeOf(outlookOf(fakeOutlook([], { cut: true })).receivedSince('agent-1', null))).toBe('panne');
  });
});

describe('outils de lecture', () => {
  it('adresses d’un en-tête, texte d’un HTML, base64url', () => {
    expect(headerAddresses('"Dupont, Jean" <Jean@Exemple.test>, b@exemple.test; <c@exemple.test>')).toEqual(['jean@exemple.test', 'b@exemple.test', 'c@exemple.test']);
    expect(headerAddresses(null)).toEqual([]);
    expect(htmlText('<script>x()</script><p>Un&nbsp;deux</p><br>trois')).toBe('Un deux\n\ntrois');
    expect([...base64Bytes('_-8')!]).toEqual([255, 239]);
    expect(base64Bytes('pas du base64 !')).toBeNull();
    expect(mailboxError(401, null).code).toBe('connexion');
    expect(mailboxError(502, null).code).toBe('panne');
  });
});

describeWithSqlite('Gmail réel trié par HX26 : le mail entre dans la fiche, dans le fil de son message d’origine [R683, R408]', () => {
  it('après l’accord, un mail reçu d’un client est rattaché à sa fiche, une fois, dans la conversation de son fil', async () => {
    const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
    await applyMigrations(db, loadMigrations());
    const store = new FicheClient(db, { now });
    const journal = new SqlJournalStore(db);
    const net = await store.createNetwork('Réseau test');
    const alex = await store.createAgent({ networkId: net.id, firstName: 'Alex', lastName: 'Agent' });
    const p = await store.createPerson({ networkId: net.id, agentId: alex.id, firstName: 'Camille' });
    await store.addIdentifier({ networkId: net.id, personId: p.id, kind: 'email', value: 'camille@exemple.test' });
    const h = fakeGmail([{ id: 'g-1', threadId: 'fil-1', at: ago(DAY), from: 'Camille@Exemple.test', text: 'Bonjour, je confirme la visite.' }]);
    const box = new GmailMailbox({ client: { clientId: 'x.apps.googleusercontent.com', clientSecret: SECRET }, refreshTokens: new Map([[alex.id, REFRESH]]), http: h.http, now });
    const boite = new BoiteMail(db, journal, { put: async () => {} }, { now });
    const viewer = { role: 'agent' as const, userId: alex.id, networkId: net.id };
    const r = await boite.sync(viewer, box);
    expect(r.ok && r.value.map((m) => m.outcome)).toEqual(['rattache']);
    const row = await db.first<{ person_id: string; conversation_id: string; body: string; external_id: string }>(
      'SELECT b.person_id, m.conversation_id, m.body, b.external_id FROM mailbox_mails b JOIN messages m ON m.id = b.message_id',
    );
    expect(row).toEqual({ person_id: p.id, conversation_id: 'email:gmail:fil-1', body: 'Bonjour, je confirme la visite.', external_id: 'g-1' });
    // Relu : rien de plus [R18].
    const again = await boite.sync(viewer, box);
    // Le mail déjà trié n'est plus rendu par la boîte (`skip`), et rien ne double.
    expect(again.ok && again.value).toEqual([]);
    expect((await db.first<{ n: number }>('SELECT COUNT(*) AS n FROM messages'))!.n).toBe(1);
  });
});

describe('Outlook : un seul lot de 50 pour les deux dossiers, pièces lourdes jamais demandées (AU043, Codex)', () => {
  it('40 reçus et 40 envoyés : 50 au plus en tout, les plus anciens d’abord, puis le reste sans rien sauter [R683, R18]', async () => {
    const inbox: FakeMail[] = Array.from({ length: 40 }, (_, i) => ({ id: `in-${i}`, threadId: 'c', at: ago((80 - 2 * i) * MIN), from: 'c@exemple.test', text: 'x' }));
    const sent: FakeMail[] = Array.from({ length: 40 }, (_, i) => ({ id: `out-${i}`, threadId: 'c', at: ago((79 - 2 * i) * MIN), from: 'agent@exemple.test', to: ['c@exemple.test'], sent: true, text: 'y' }));
    const box = outlookOf(fakeOutlook([...inbox, ...sent]));
    const first = await box.receivedSince('agent-1', ago(DAY));
    expect(first).toHaveLength(MAILBOX_BATCH);
    const all = [...inbox, ...sent].sort((a, b) => a.at.getTime() - b.at.getTime()).map((m) => m.id);
    expect(first.map((m) => m.externalId)).toEqual(all.slice(0, 50));
    const next = await box.receivedSince('agent-1', first[first.length - 1]!.receivedAt, new Set(first.map((m) => m.externalId)));
    expect(next.map((m) => m.externalId)).toEqual(all.slice(50));
  });

  it('une pièce de plus de 20 Mo : sa taille seule est lue, jamais son contenu [R410]', async () => {
    const h = fakeOutlook([
      { id: 'o-1', threadId: 'c', at: ago(DAY), from: 'c@exemple.test', text: 'x', attachments: [{ name: 'gros.pdf', type: 'application/pdf', bytes: new Uint8Array(21 * 1024 * 1024) }, { name: 'plan.pdf', type: 'application/pdf', bytes: pdf }] },
    ]);
    const [m] = await outlookOf(h).receivedSince('agent-1', ago(2 * DAY));
    expect(m!.attachments.map((a) => a.bytes.length)).toEqual([0, pdf.length]);
    expect(h.calls.filter((c) => c.url.includes('/attachments')).map((c) => new URL(c.url).pathname.split('/').pop())).toEqual(['attachments', 'piece-1']);
    expect(h.calls.some((c) => c.url.includes('/attachments?') && !c.url.includes('%24select=') && !c.url.includes('$select='))).toBe(false);
  });
});

describeWithSqlite('plus de 50 mails de la même heure : la lecture avance toujours (AU043, Codex) [R18]', () => {
  for (const kind of ['gmail', 'outlook'] as const) {
    it(`${kind} : 51 mails de la même seconde, puis un plus récent, tous triés en trois lectures`, async () => {
      const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
      await applyMigrations(db, loadMigrations());
      const store = new FicheClient(db, { now });
      const net = await store.createNetwork('Réseau test');
      const alex = await store.createAgent({ networkId: net.id, firstName: 'Alex', lastName: 'Agent' });
      const same = ago(DAY);
      const mails: FakeMail[] = [
        ...Array.from({ length: 51 }, (_, i) => ({ id: `m-${String(i).padStart(2, '0')}`, threadId: `f-${i}`, at: same, from: 'inconnu@exemple.test', text: 'x' })),
        { id: 'm-tard', threadId: 'f-tard', at: ago(DAY / 2), from: 'inconnu@exemple.test', text: 'y' },
      ];
      const refresh = new Map([[alex.id, REFRESH]]);
      const box =
        kind === 'gmail'
          ? new GmailMailbox({ client: { clientId: 'x.apps.googleusercontent.com', clientSecret: SECRET }, refreshTokens: refresh, http: fakeGmail(mails).http, now })
          : new OutlookMailbox({ client: { clientId: '00000000-0000-4000-8000-000000000001', clientSecret: SECRET }, refreshTokens: refresh, http: fakeOutlook(mails).http, now });
      const boite = new BoiteMail(db, new SqlJournalStore(db), { put: async () => {} }, { now });
      const viewer = { role: 'agent' as const, userId: alex.id, networkId: net.id };
      for (let i = 0; i < 3; i += 1) await boite.sync(viewer, box);
      const ids = (await db.all<{ external_id: string }>('SELECT external_id FROM mailbox_mails ORDER BY external_id')).map((r) => r.external_id);
      expect(ids).toEqual(mails.map((m) => m.id).sort());
    });
  }
});

describe('toute la boîte, et le texte rangé à part (AU043, Codex)', () => {
  it('Outlook : un mail rangé par une règle ou archivé est lu ; indésirables, supprimés et brouillons jamais [R683]', async () => {
    const h = fakeOutlook([
      { id: 'o-regle', threadId: 'c1', at: ago(3 * DAY), from: 'c@exemple.test', folder: 'clients', text: 'rangé par une règle' },
      { id: 'o-archive', threadId: 'c2', at: ago(2 * DAY), from: 'c@exemple.test', folder: 'archive', text: 'archivé' },
      { id: 'o-pub', threadId: 'c3', at: ago(2 * DAY), from: 'p@exemple.test', folder: 'junkemail', text: 'pub' },
      { id: 'o-jete', threadId: 'c4', at: ago(2 * DAY), from: 'p@exemple.test', folder: 'deleteditems', text: 'jeté' },
      { id: 'o-envoye', threadId: 'c1', at: ago(DAY), from: 'agent@exemple.test', to: ['c@exemple.test'], sent: true, text: 'réponse' },
    ]);
    const got = await outlookOf(h).receivedSince('agent-1', ago(10 * DAY));
    expect(got.map((m) => [m.externalId, m.direction ?? 'in'])).toEqual([
      ['o-regle', 'in'],
      ['o-archive', 'in'],
      ['o-envoye', 'out'],
    ]);
  });

  it('Gmail : une partie de texte rangée à part (`attachmentId`) est le texte du mail, jamais une pièce', async () => {
    const h = fakeGmail([{ id: 'g-1', threadId: 'f', at: ago(DAY), from: 'c@exemple.test', text: 'Merci de ne plus me contacter.', textApart: true }]);
    const [m] = await gmailOf(h).receivedSince('agent-1', ago(2 * DAY));
    expect(m!.body).toBe('Merci de ne plus me contacter.');
    expect(m!.attachments).toEqual([]);
  });
});
