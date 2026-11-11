// HX61 · Le contrôle central range un message à secret masqué.
import { expect, it } from 'vitest';
import { ControleEnvois, DecisionEnvoi, FakeChannel, FicheClient, FicheUnique, SqlJournalStore, SqlSendJournal, applyMigrations, fromSyncSqlite, type Channel, type SendOrder } from '../src/index.ts';
import { MASKED_SECRET, maskSecrets } from '../src/envoi/controle.ts';
import { trialChannels } from '../src/captation/essai.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';
import { remis, tablesContenant } from './boite-essai.ts';

// Un mardi, 10 h à Paris.
const TUE_1000 = new Date('2026-11-10T09:00:00.000Z');
const TOKEN = 'qzkwxvjrtlmnbpqzkwxvjrtlmnbpqzkwxvjrtlmn';
const LINK = `https://app.example.test/bon/${TOKEN}`;

it('[HX61] le masque remplace chaque secret partout, le plus long d’abord', () => {
  const body = `Votre lien : ${LINK}. Votre code : 482615, je répète 482615.`;
  expect(maskSecrets(body, [{ kind: 'code', value: '482615' }, { kind: 'lien', value: LINK }])).toBe(`Votre lien : ${MASKED_SECRET.lien}. Votre code : ${MASKED_SECRET.code}, je répète ${MASKED_SECRET.code}.`);
  expect(maskSecrets(body, [])).toBe(body);
});

async function setup(trial: boolean) {
  const db = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  const store = new FicheClient(db);
  const fiche = new FicheUnique(db, store);
  const journalStore = new SqlJournalStore(db);
  const fakes = (['email', 'sms', 'whatsapp', 'instagram', 'facebook', 'phone'] as Channel[]).map((c) => new FakeChannel(c));
  const now = () => TUE_1000;
  const controle = new ControleEnvois(db, fiche, new DecisionEnvoi(db, store, fiche), {
    channels: trial ? trialChannels(db, journalStore, now) : fakes,
    journal: new SqlSendJournal(db),
    budget: { allows: async () => true },
    now,
  });
  const network = await store.createNetwork('Réseau test');
  const agent = await store.createAgent({ networkId: network.id, firstName: 'Paul', lastName: 'Essai' });
  const person = await store.createPerson({ networkId: network.id, agentId: agent.id, firstName: 'Léa', lastName: 'Exemple' });
  await store.addIdentifier({ networkId: network.id, personId: person.id, kind: 'email', value: 'lea.exemple@example.test' });
  await store.addConsent({ networkId: network.id, personId: person.id, purpose: 'alert', channel: 'email', proof: 'formulaire test', givenAt: new Date('2026-01-01T00:00:00.000Z') });
  const order = (code: string, n: number): SendOrder => ({
    networkId: network.id,
    agentId: agent.id,
    personId: person.id,
    channel: 'email',
    kind: 'alert',
    subject: `signature:session-${n}`,
    fallbackTexts: [`Bonjour Léa, votre code de signature : ${code}. Votre document : ${LINK}. Ne le donnez à personne.`],
    figures: [code],
    secrets: [
      { kind: 'code', value: code },
      { kind: 'lien', value: LINK },
    ],
  });
  return { db, controle, email: fakes[0]!, order };
}

/** Les tables qui gardent les messages, leurs remises et leurs traces. */
const SENDING_TABLES = ['messages', 'trial_outbox', 'journal', 'send_log', 'send_reservations', 'message_subjects'];

describeWithSqlite('HX61 · le contrôle central range un message à secret masqué', () => {
  it('[HX61] le canal reçoit le texte entier ; ni le code ni le lien ne sont rangés en clair, ni rendus', async () => {
    const t = await setup(false);
    const sent = await t.controle.send(t.order('482615', 1));
    expect(sent.status).toBe('sent');
    expect(t.email.sent).toHaveLength(1);
    expect(t.email.sent[0]!.body).toContain('482615');
    expect(t.email.sent[0]!.body).toContain(LINK);
    const row = await t.db.first<{ body: string }>('SELECT body FROM messages WHERE id = ?', [sent.messageId]);
    expect(row!.body.split('\n\n').at(-1)).toBe(`Bonjour Léa, votre code de signature : ${MASKED_SECRET.code}. Votre document : ${MASKED_SECRET.lien}. Ne le donnez à personne.`);
    // Le résultat rendu à l'appelant, que l'écran de l'agent peut afficher, est masqué lui aussi.
    expect(sent.body).toBe(row!.body);
    expect((await t.db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")).map((r) => r.name)).toEqual(expect.arrayContaining(SENDING_TABLES));
    // Le jeton, long et unique, n'est nulle part dans la base ; le code nulle part où vont les messages.
    expect(await tablesContenant(t.db, TOKEN)).toEqual([]);
    expect(await tablesContenant(t.db, '482615', SENDING_TABLES)).toEqual([]);
  });

  it('[HX61] en mode essai : la boîte d’essai reçoit le texte entier, et ne range que le message masqué', async () => {
    const t = await setup(true);
    const sent = await t.controle.send(t.order('739204', 1));
    expect(sent.status).toBe('sent');
    expect(remis(sent.messageId!)).toContain('739204');
    expect(remis(sent.messageId!)).toContain(LINK);
    const boxed = await t.db.all<{ body: string }>('SELECT m.body FROM messages m JOIN trial_outbox o ON o.message_id = m.id');
    expect(boxed).toHaveLength(1);
    expect(boxed[0]!.body).toContain(MASKED_SECRET.code);
    expect(await tablesContenant(t.db, TOKEN)).toEqual([]);
    expect(await tablesContenant(t.db, '739204', SENDING_TABLES)).toEqual([]);
  });

  it('[HX61] [R05] l’anti-doublon du texte ne bloque pas deux codes différents ; le même code, sur le même sujet, une seule fois', async () => {
    const t = await setup(false);
    expect((await t.controle.send(t.order('482615', 1))).status).toBe('sent');
    // Rangés, les deux messages ont le même texte masqué ; le second, avec un autre code, part quand même.
    expect((await t.controle.send(t.order('905173', 2))).status).toBe('sent');
    expect(t.email.sent.map((m) => /(\d{6})/.exec(m.body)![1])).toEqual(['482615', '905173']);
    const again = await t.controle.send(t.order('905173', 2));
    expect(again).toMatchObject({ status: 'refused', rule: 'R05' });
    expect(t.email.sent).toHaveLength(2);
  });

  it('[HX61] un secret de moins de 4 caractères, ou sans sujet, est une erreur de l’appelant : rien ne part', async () => {
    const t = await setup(false);
    await expect(t.controle.send({ ...t.order('482615', 1), secrets: [{ kind: 'code', value: '48' }] })).rejects.toThrow(/au moins 4/);
    await expect(t.controle.send({ ...t.order('482615', 1), kind: 'reply', subject: undefined })).rejects.toThrow(/cite son sujet/);
    expect(t.email.sent).toHaveLength(0);
  });

  it('[R06] [RC08] un lien dont le jeton commence par « gpt », « robot » ou « assistant » part, entier au canal, masqué dans la base', async () => {
    const t = await setup(false);
    let n = 10;
    for (const start of ['gpt', 'robot', 'assistant', 'chatbot', 'ia']) {
      const link = `https://app.example.test/bon/${start}qzkwxvjrtlmnbpqzkwxvjrtlmnbpq`;
      const text = `Bonjour Léa, votre document : ${link}. Ne le donnez à personne.`;
      const sent = await t.controle.send({ ...t.order('482615', (n += 1)), fallbackTexts: [text], figures: [], secrets: [{ kind: 'lien', value: link }] });
      expect(sent.status).toBe('sent');
      expect(t.email.sent.at(-1)!.body).toContain(link);
      const row = await t.db.first<{ body: string }>('SELECT body FROM messages WHERE id = ?', [sent.messageId]);
      expect(row!.body).not.toContain(link);
      expect(row!.body).toContain(MASKED_SECRET.lien);
    }
  });

  it('[R06] [RC08] le même mot écrit hors du secret est toujours refusé', async () => {
    const t = await setup(false);
    const link = 'https://app.example.test/bon/gptqzkwxvjrtlmnbpqzkwxvjrtlmnbpq';
    const texts = [`Notre assistant vous envoie votre document : ${link}.`, `Votre document, préparé par GPT : ${link}.`];
    for (const [i, text] of texts.entries()) {
      const sent = await t.controle.send({ ...t.order('482615', 20 + i), fallbackTexts: [text], figures: [], secrets: [{ kind: 'lien', value: link }] });
      expect(sent).toMatchObject({ status: 'refused', rule: 'R06' });
    }
    expect(t.email.sent).toHaveLength(0);
  });

  it('[R10] [RC08] les chiffres d’un secret ne sont pas des chiffres écrits ; un chiffre hors du secret reste contrôlé', async () => {
    const t = await setup(false);
    const link = 'https://app.example.test/bon/a1b2c3d4e5f6g7h8i9j0';
    const secrets = [{ kind: 'code' as const, value: '739204' }, { kind: 'lien' as const, value: link }];
    const sent = await t.controle.send({ ...t.order('482615', 30), fallbackTexts: [`Bonjour Léa, votre code : 739204. Votre document : ${link}.`], figures: [], secrets });
    expect(sent.status).toBe('sent');
    expect(t.email.sent.at(-1)!.body).toContain('739204');
    const other = await t.controle.send({ ...t.order('482615', 31), fallbackTexts: ['Bonjour Léa, votre code : 739204. Le bien vaut 250 000 €.'], figures: [], secrets: [secrets[0]!] });
    expect(other).toMatchObject({ status: 'refused', rule: 'R10' });
  });
});
