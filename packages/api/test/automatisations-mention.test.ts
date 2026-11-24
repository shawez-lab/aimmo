import { expect, it } from 'vitest';
import {
  ControleEnvois,
  DecisionEnvoi,
  FicheClient,
  FicheUnique,
  PaliersBascule,
  ROLLOUT_MIN_REQUESTS,
  SqlJournalStore,
  SITE_THREAD,
  SqlSendJournal,
  applyMigrations,
  rolloutBucket,
  trialChannels,
  type SqlDatabase,
} from '@aimmo/core';
import { handleRequest, sha256Hex } from '../src/index.ts';
import { fromD1 } from '../src/d1.ts';
import { loadMigrations } from '../../core/test/migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from '../../core/test/sqlite.ts';
import { fakeD1 } from './fake-d1.ts';

// Clé inventée pour les tests, jamais utilisée ailleurs.
const KEY_AUTO = 'test-cle-mention-site-mmmmmmmmmmmmmmmmmmmmmmmmmmmmmm';
const KEY_DIRECTION = 'test-cle-mention-direction-nnnnnnnnnnnnnnnnnnnnnnnnn';
const URL_BASE = 'https://aimmo-api.example.workers.dev/v1/automatisations';
const DAY = 86_400_000;
// Novembre 2026, Paris à UTC+1 : un mardi à 10 h.
const START = Date.parse('2026-11-03T09:00:00.000Z');
const LONG_AGO = new Date('2026-01-01T00:00:00.000Z');
const EMAIL = 'lea.exemple@example.test';
const MENTION = 'Réponse immédiate de l’assistant IA de Paul, qui vous recontacte personnellement.';
const SUBJECT = 'Rappel : visite d’estimation demain';
const textOf = (word: string): string => `${SUBJECT}\n\nBonjour Léa, je passe voir votre bien demain, ${word}.`;
const withMention = (word: string): string => `${SUBJECT}\n\n${MENTION}\n\nBonjour Léa, je passe voir votre bien demain, ${word}.`;

interface Decision {
  status: string;
  rule: string | null;
  decides: boolean;
  stage: string;
  mentionMissing: boolean;
}

async function world() {
  const db: SqlDatabase = fromD1(fakeD1(openMemoryDatabase()));
  await applyMigrations(db, loadMigrations());
  let clock = START;
  const now = (): Date => new Date(clock);
  const fiches = new FicheClient(db, { now });
  const network = await fiches.createNetwork('Réseau test');
  const agent = await fiches.createAgent({ networkId: network.id, firstName: 'Paul', lastName: 'Essai' });
  const person = await fiches.createPerson({ networkId: network.id, agentId: agent.id, firstName: 'Léa', lastName: 'Exemple' });
  await fiches.addIdentifier({ networkId: network.id, personId: person.id, kind: 'email', value: EMAIL });
  await fiches.addConsent({ networkId: network.id, personId: person.id, purpose: 'valuation_follow_up', channel: 'email', proof: 'formulaire test', givenAt: LONG_AGO });
  const config = {
    db,
    mode: 'essai',
    now,
    automationRolloutOpen: true,
    intakeKeys: JSON.stringify([{ sha256: await sha256Hex(KEY_AUTO), networkId: network.id, source: 'site_auto' }]),
    apiKeys: JSON.stringify([{ sha256: await sha256Hex(KEY_DIRECTION), role: 'direction', userId: 'direction-test', networkId: network.id }]),
  };
  const http = (path: string, key: string, body: unknown) =>
    handleRequest(new Request(`${URL_BASE}${path}`, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify(body) }), config);
  const send = async (ref: string, text: string): Promise<Decision> => {
    const res = await http('/envoi', KEY_AUTO, { automation: 'rappel_visite', email: EMAIL, ref, text, figures: [] });
    expect(res.status).toBe(200);
    return ((await res.json()) as { data: Decision }).data;
  };
  const journal = new SqlJournalStore(db);
  const paliers = new PaliersBascule(db, journal, { now });
  /** Passe à 10 % ; à partir de là, seuls les envois tirés sont décidés par le socle. */
  const toTenPercent = async (): Promise<void> => {
    const { stageSince } = await paliers.decide(network.id, 'rappel_visite', 'compte');
    for (let i = 0; i < ROLLOUT_MIN_REQUESTS; i++) await paliers.countRequest(network.id, 'rappel_visite', stageSince);
    clock += 7 * DAY;
    expect((await http('/paliers/rappel_visite/avancer', KEY_DIRECTION, {})).status).toBe(200);
  };
  const rows = () => db.all<{ body: string; author_kind: string }>("SELECT body, author_kind FROM messages WHERE direction = 'out' ORDER BY occurred_at, id");
  const outbox = async () => (await db.all('SELECT message_id FROM trial_outbox')).length;
  const requests = async () => Number((await db.first<{ requests: number }>("SELECT requests FROM automation_rollouts WHERE automation = 'rappel_visite'"))?.requests ?? 0);
  const controle = () => {
    const unique = new FicheUnique(db, fiches, { now });
    return new ControleEnvois(db, unique, new DecisionEnvoi(db, fiches, unique, { now }), {
      channels: trialChannels(db, journal, now),
      journal: new SqlSendJournal(db, undefined, now),
      now,
    });
  };
  const order = { networkId: network.id, agentId: agent.id, personId: person.id, channel: 'email' as const, kind: 'follow_up' as const, purpose: 'valuation_follow_up', figures: [] };
  return { db, fiches, network, agent, person, now, send, journal, toTenPercent, rows, outbox, requests, controle, order };
}

/** Une référence tirée ou non dans les 10 %, en partant d'un rang donné pour ne pas réutiliser une référence. */
async function refIn(drawn: boolean, from = 0): Promise<string> {
  for (let i = from; ; i++) {
    const ref = `tirage-${i}`;
    if ((await rolloutBucket('rappel_visite', ref)) < 10 === drawn) return ref;
  }
}

describeWithSqlite('B04b · la mention de l’assistant, alignée sur le texte du site', () => {
  it('[R06] en ombre, le message rangé est exactement celui du site : aucune mention ajoutée, et son absence est signalée', async () => {
    const w = await world();
    const d = await w.send('visite-1', textOf('comme prévu'));
    expect(d).toMatchObject({ status: 'would_send', rule: null, decides: false, stage: 'shadow', mentionMissing: true });
    const rows = await w.rows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.body).toBe(textOf('comme prévu'));
    expect(rows[0]!.body).not.toContain('assistant');
  });

  it('[R11] un message du site compte une seule fois, même demandé deux fois', async () => {
    const w = await world();
    await w.send('visite-1', textOf('comme prévu'));
    expect(await w.send('visite-1', textOf('comme prévu'))).toMatchObject({ status: 'refused', rule: 'R05' });
    expect(await w.rows()).toHaveLength(1);
    expect(await w.outbox()).toBe(1);
    expect(await w.requests()).toBe(1);
  });

  it('[R06] la mention portée par le site vaut mention : le texte est gardé tel quel, sans en ajouter une seconde', async () => {
    const w = await world();
    const d = await w.send('visite-1', withMention('comme prévu'));
    expect(d).toMatchObject({ status: 'would_send', rule: null, mentionMissing: false });
    const rows = await w.rows();
    expect(rows[0]!.body).toBe(withMention('comme prévu'));
    expect(rows[0]!.body.split('assistant IA')).toHaveLength(2);
    const log = await w.db.first<{ with_mention: number }>("SELECT with_mention FROM send_log WHERE outcome = 'sent'");
    expect(Number(log!.with_mention)).toBe(1);
  });

  it('[R06] quand le socle décide, un premier message sans mention est refusé avec R06, et rien n’est rangé', async () => {
    const w = await world();
    await w.toTenPercent();
    const before = await w.requests();
    const d = await w.send(await refIn(true), textOf('comme prévu'));
    expect(d).toMatchObject({ status: 'refused', rule: 'R06', decides: true, stage: 'ten_percent', mentionMissing: true });
    expect(await w.rows()).toHaveLength(0);
    expect(await w.outbox()).toBe(0);
    // Un refus pour une mention que le site ne met pas encore ne prouve rien pour le palier [R26].
    expect(await w.requests()).toBe(before);
  });

  it('[R06] à 10 %, hors du tirage, le site reste seul maître : le message est rangé, l’absence signalée', async () => {
    const w = await world();
    await w.toTenPercent();
    const d = await w.send(await refIn(false), textOf('comme prévu'));
    expect(d).toMatchObject({ status: 'would_send', rule: null, decides: false, mentionMissing: true });
    expect(await w.rows()).toHaveLength(1);
  });

  it('[R06] quand le socle décide, le premier message qui la porte passe, et le suivant n’a plus à la porter', async () => {
    const w = await world();
    await w.toTenPercent();
    const first = await refIn(true);
    expect(await w.send(first, withMention('comme prévu'))).toMatchObject({ status: 'would_send', decides: true, mentionMissing: false });
    const second = await refIn(true, Number(first.split('-')[1]) + 1);
    expect(await w.send(second, textOf('à l’heure dite'))).toMatchObject({ status: 'would_send', decides: true, mentionMissing: false });
    expect((await w.rows()).map((r) => r.body).sort()).toEqual([withMention('comme prévu'), textOf('à l’heure dite')].sort());
  });

  it('[R06] un message rangé sans mention en ombre ne la tient pas pour donnée : le suivant la doit encore', async () => {
    const w = await world();
    await w.send('visite-1', textOf('comme prévu'));
    await w.toTenPercent();
    expect(await w.send(await refIn(true), textOf('à l’heure dite'))).toMatchObject({ status: 'refused', rule: 'R06', mentionMissing: true });
    expect(await w.rows()).toHaveLength(1);
  });

  it('[R06] la mention ne se répète pas : un second message qui parle de l’IA est refusé', async () => {
    const w = await world();
    await w.send('visite-1', withMention('comme prévu'));
    expect(await w.send('visite-2', withMention('à l’heure dite'))).toMatchObject({ status: 'refused', rule: 'R06', mentionMissing: false });
    expect(await w.rows()).toHaveLength(1);
  });

  it('[R06] seule la mention exacte vaut : un paragraphe qui s’en approche ou la répète est refusé', async () => {
    const texts = [
      `${SUBJECT}\n\n${MENTION} Je suis un robot.\n\nBonjour Léa, à demain.`,
      `${SUBJECT}\n\nRéponse immédiate de l’assistant IA de Marc, qui vous recontacte personnellement.\n\nBonjour Léa, à demain.`,
      `${SUBJECT}\n\n${MENTION}\n\n${MENTION}\n\nBonjour Léa, à demain.`,
      `${SUBJECT}\n\n${MENTION} 这是机器人\n\nBonjour Léa, à demain.`,
      `${SUBJECT}\n\n(${MENTION.replace(',', ' !')} ???)\n\nBonjour Léa, à demain.`,
    ];
    for (const text of texts) {
      const w = await world();
      expect(await w.send('visite-1', text), text).toMatchObject({ status: 'refused', rule: 'R06' });
      expect(await w.rows()).toHaveLength(0);
    }
  });

  it('[R06] DS052 · pour un agent dont le prénom s’élide, la mention exacte est « d’Alex » ; l’ancienne écriture « de Alex » reste reçue', async () => {
    const body = 'Bonjour Léa, je passe voir votre bien demain, comme prévu.';
    for (const written of ['d’Alex', 'de Alex']) {
      const w = await world();
      await w.db.run("UPDATE agents SET first_name = 'Alex' WHERE id = ?", [w.agent.id]);
      const text = `${SUBJECT}\n\nRéponse immédiate de l’assistant IA ${written}, qui vous recontacte personnellement.\n\n${body}`;
      expect(await w.send('visite-1', text), written).toMatchObject({ status: 'would_send', mentionMissing: false });
      expect(await w.rows()).toHaveLength(1);
    }
    // Le prénom d'un autre, même élidé, n'est pas la mention de cet agent.
    const w = await world();
    await w.db.run("UPDATE agents SET first_name = 'Alex' WHERE id = ?", [w.agent.id]);
    expect(await w.send('visite-1', `${SUBJECT}\n\nRéponse immédiate de l’assistant IA d’Inès, qui vous recontacte personnellement.\n\n${body}`)).toMatchObject({ status: 'refused', rule: 'R06' });
  });

  it('[R05] le même texte, avec ou sans la mention, ne compte que pour un', async () => {
    const w = await world();
    await w.send('visite-1', withMention('comme prévu'));
    expect(await w.send('visite-2', textOf('comme prévu'))).toMatchObject({ status: 'refused', rule: 'R05' });
    const v = await world();
    await v.send('visite-1', textOf('comme prévu'));
    expect(await v.send('visite-2', withMention('comme prévu'))).toMatchObject({ status: 'refused', rule: 'R05' });
  });

  it('[R13] le journal dit seulement que la mention manque, sans texte ni adresse', async () => {
    const w = await world();
    await w.send('visite-1', textOf('comme prévu'));
    const entries = await w.journal.all();
    const asked = entries.filter((e) => e.type === 'bascule.demande.essai');
    expect(asked.map((e) => e.data.mention_missing)).toEqual([true]);
    const dump = JSON.stringify(entries);
    for (const secret of [EMAIL, 'visite-1', 'comme prévu', SUBJECT]) expect(dump).not.toContain(secret);
  });

  it('[R26] à aucun palier, rien ne quitte la boîte du mode essai', async () => {
    const w = await world();
    await w.send('visite-1', withMention('comme prévu'));
    expect(await w.outbox()).toBe(1);
    const sent = (await w.journal.all()).filter((e) => e.type === 'envoi.essai');
    expect(sent.map((e) => e.data)).toEqual([{ mode: 'essai', sent: false, channel: 'email' }]);
  });

  it('[R06] un autre appelant du contrôle central ne change pas : la mention reste ajoutée en tête, une seule fois', async () => {
    const w = await world();
    const unique = new FicheUnique(w.db, w.fiches, { now: w.now });
    const controle = new ControleEnvois(w.db, unique, new DecisionEnvoi(w.db, w.fiches, unique, { now: w.now }), {
      channels: trialChannels(w.db, w.journal, w.now),
      journal: new SqlSendJournal(w.db, undefined, w.now),
      now: w.now,
    });
    const order = { networkId: w.network.id, agentId: w.agent.id, personId: w.person.id, channel: 'email' as const, kind: 'follow_up' as const, purpose: 'valuation_follow_up', figures: [] };
    const first = await controle.send({ ...order, subject: 'suivi:1', fallbackTexts: ['Bonjour Léa, voici la suite de votre dossier.'] });
    expect(first).toMatchObject({ status: 'sent', withMention: true, body: `${MENTION}\n\nBonjour Léa, voici la suite de votre dossier.` });
    expect(first.mentionMissing).toBeUndefined();
    const second = await controle.send({ ...order, subject: 'suivi:2', fallbackTexts: ['Votre dossier avance bien.'] });
    expect(second).toMatchObject({ status: 'sent', withMention: false, body: 'Votre dossier avance bien.' });
    // La mention écrite par un appelant ordinaire reste refusée : seul le texte d'un site, déclaré tel quel, la porte.
    const third = await controle.send({ ...order, subject: 'suivi:3', fallbackTexts: [`${MENTION}\n\nBonjour.`] });
    expect(third).toMatchObject({ status: 'refused', rule: 'R06' });
  });

  it('[R06] un message du site sans mention ne dispense pas un autre appelant de la sienne', async () => {
    const w = await world();
    await w.send('visite-1', textOf('comme prévu'));
    const first = await w.controle().send({ ...w.order, subject: 'suivi:1', fallbackTexts: ['Bonjour Léa, voici la suite de votre dossier.'] });
    expect(first).toMatchObject({ status: 'sent', withMention: true, body: `${MENTION}\n\nBonjour Léa, voici la suite de votre dossier.` });
  });

  it('[R06] la mention d’un autre appelant ne vaut pas pour le site : seul son propre texte la donne', async () => {
    const w = await world();
    expect(await w.controle().send({ ...w.order, subject: 'suivi:1', fallbackTexts: ['Bonjour Léa, voici la suite de votre dossier.'] })).toMatchObject({ status: 'sent', withMention: true });
    await w.toTenPercent();
    expect(await w.send(await refIn(true), textOf('comme prévu'))).toMatchObject({ status: 'refused', rule: 'R06', decides: true, mentionMissing: true });
    expect(await w.rows()).toHaveLength(1);
  });

  it('[R21] le fil du site n’entre pas dans la décision : elle reste celle d’un mail sans conversation citée, comme avant', async () => {
    const w = await world();
    const before = new Date(START - DAY).toISOString();
    await w.db.run("INSERT INTO messages (id, network_id, person_id, conversation_id, channel, direction, author_kind, body, occurred_at, created_at) VALUES ('m-humain', ?, ?, ?, 'email', 'out', 'agent', 'Bonjour Léa.', ?, ?)", [w.network.id, w.person.id, SITE_THREAD, before, before]);
    expect(await w.send('visite-1', textOf('comme prévu'))).toMatchObject({ status: 'would_send', rule: null });
  });

  it('un texte déclaré tel quel n’a ni IA, ni secours, ni agent pour l’écrire', async () => {
    const w = await world();
    const unique = new FicheUnique(w.db, w.fiches, { now: w.now });
    const controle = new ControleEnvois(w.db, unique, new DecisionEnvoi(w.db, w.fiches, unique, { now: w.now }), {
      channels: trialChannels(w.db, w.journal, w.now),
      journal: new SqlSendJournal(w.db, undefined, w.now),
      now: w.now,
    });
    const order = { networkId: w.network.id, personId: w.person.id, channel: 'email' as const, kind: 'follow_up' as const, purpose: 'valuation_follow_up', subject: 'suivi:1', asWritten: { refuseWithoutMention: false, thread: 'fil-test' } };
    expect(await controle.send({ ...order, fallbackTexts: ['Bonjour Léa.'], compose: async () => 'Bonjour Léa.' })).toMatchObject({ status: 'refused' });
    expect(await controle.send({ ...order, fallbackTexts: ['Bonjour Léa.', 'Bonjour.'] })).toMatchObject({ status: 'refused' });
    expect(await controle.send({ ...order, agentId: w.agent.id, fallbackTexts: ['Bonjour Léa.'], byAgent: { port: {} as never } })).toMatchObject({ status: 'refused' });
    expect(await w.rows()).toHaveLength(0);
  });
});
