import { createHmac } from 'node:crypto';
import { expect, it } from 'vitest';
import { Acces, FicheClient, FicheUnique, RendezVous, SqlJournalStore, applyMigrations, parisInstant, type SqlDatabase, type Viewer } from '@aimmo/core';
import { handleRequest } from '../src/index.ts';
import { fromD1 } from '../src/d1.ts';
import worker, { type Env } from '../src/worker.ts';
import { callerOf, runTelephoniePass, twilioSignature } from '../src/telephonie.ts';
import { AssistantVocal } from '../../core/src/voix/assistant.ts';
import { Appels } from '../../core/src/voix/appels.ts';
import { ReservationEnLigne } from '../../core/src/rendezvous/en-ligne.ts';
import { loadMigrations } from '../../core/test/migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from '../../core/test/sqlite.ts';
import { fakeD1 } from './fake-d1.ts';

// Tout est inventé : compte, jeton, numéros. Le 9 novembre 2026 est un lundi.
const ACCOUNT = `AC${'1'.repeat(32)}`;
const TOKEN = 'jeton-twilio-de-test-000000000000';
const BASE = 'https://aimmo-api.example.workers.dev/v1/telephonie';
const AGENT_PHONE = '+33600000911';
const CALLER = '+33600000317';
const SERVICE_NUMBER = '+33900000001';
const WEEK = { weekly: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, from: '09:00', to: '18:00' })) };

/** La signature de Twilio, calculée ici sans le code du Worker : adresse puis champs triés, HMAC-SHA1, base 64. */
function sign(url: string, fields: Record<string, string>, token = TOKEN): string {
  const data = url + Object.keys(fields).sort().map((k) => k + fields[k]).join('');
  return createHmac('sha1', token).update(data).digest('base64');
}

async function world(settings: { mode?: string; accountSid?: string; authToken?: string } = { mode: 'reel', accountSid: ACCOUNT, authToken: TOKEN }) {
  let clock = parisInstant('2026-11-09', 8 * 60)!.getTime();
  const now = (): Date => new Date((clock += 1000));
  const db: SqlDatabase = fromD1(fakeD1(openMemoryDatabase()));
  await applyMigrations(db, loadMigrations());
  const journal = new SqlJournalStore(db);
  const store = new FicheClient(db, { now });
  const fiche = new FicheUnique(db, store, { now });
  const acces = new Acces(db, store, fiche, journal, { now });
  const network = await store.createNetwork('Réseau test');
  const paul = await store.createAgent({ networkId: network.id, firstName: 'Paul', lastName: 'Essai' });
  const asPaul: Viewer = { role: 'agent', userId: paul.id, networkId: network.id };
  await new RendezVous(db, journal, { now, linkBase: 'https://essai.example.test/' }).setAvailability(asPaul, WEEK);
  const appels = new Appels(db, journal, store, fiche, null, { now });
  const assistant = new AssistantVocal(db, journal, acces, new ReservationEnLigne(db, journal, { now }), appels, { now });
  expect(await assistant.setLine(asPaul, { agentId: paul.id, phone: '06 00 00 09 11', enabled: true })).toEqual({ ok: true });
  const person = await store.createPerson({ networkId: network.id, agentId: paul.id, firstName: 'Client' });
  await store.addIdentifier({ networkId: network.id, personId: person.id, kind: 'phone', value: CALLER });

  // Un crochet appelé une fois, juste avant une écriture choisie : pour livrer une requête au milieu d'une autre.
  const hooks: { match: RegExp; run: () => Promise<void> }[] = [];
  const hooked = new Proxy(db, {
    get(target, prop, receiver) {
      if (prop !== 'run') return Reflect.get(target, prop, receiver);
      return async (sql: string, params?: unknown[]) => {
        const i = hooks.findIndex((h) => h.match.test(sql));
        if (i >= 0) await hooks.splice(i, 1)[0]!.run();
        return target.run(sql, params as never);
      };
    },
  }) as SqlDatabase;
  let n = 0;
  const newSid = (): string => `CA${String(++n).padStart(32, '0')}`;
  /** L'écoute rendue en dernier pour chaque appel : le service rappelle exactement cette adresse au tour suivant. */
  const actions = new Map<string, string>();
  const post = async (step: 'appel' | 'tour' | 'fin', fields: Record<string, string>, options: { signature?: string; url?: string } = {}) => {
    const url = options.url ?? `${BASE}/${step}`;
    const all = { AccountSid: ACCOUNT, ...fields };
    const response = await handleRequest(
      new Request(url, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': options.signature ?? sign(url, all) },
        body: new URLSearchParams(all).toString(),
      }),
      { db: hooked, apiKeys: undefined, mode: 'essai', now, telephonie: { mode: settings.mode, accountSid: settings.accountSid, authToken: settings.authToken } },
    );
    const text = await response.text();
    const action = /action="([^"]+)"/.exec(text)?.[1];
    if (action && fields.CallSid) actions.set(fields.CallSid, action.replace(/&amp;/g, '&'));
    return { status: response.status, text };
  };
  /** Un appel renvoyé par l'agent, depuis un téléphone extérieur. */
  const ring = (sid: string, over: Record<string, string> = {}) =>
    post('appel', { CallSid: sid, From: CALLER, To: SERVICE_NUMBER, ForwardedFrom: AGENT_PHONE, CallStatus: 'ringing', Direction: 'inbound', ...over });
  /** Ce que dit l'appelant, à l'adresse de la dernière écoute ; `url` pour relivrer une adresse déjà servie. */
  const speak = (sid: string, words: string, url?: string) =>
    post('tour', { CallSid: sid, SpeechResult: words, Confidence: '0.92', CallStatus: 'in-progress' }, { url: url ?? actions.get(sid) ?? `${BASE}/tour?n=0` });
  const hangUp = (sid: string, status = 'completed') => post('fin', { CallSid: sid, CallStatus: status, CallDuration: '95' });
  const said = (twiml: string): string[] => [...twiml.matchAll(/<Say language="fr-FR">([^<]*)<\/Say>/g)].map((m) => m[1]!.replace(/&apos;/g, "'"));
  const journalText = async () => JSON.stringify(await db.all('SELECT type, actor, subject, data FROM journal'));
  return { db, hooks, now, actions, network, paul, person, post, ring, speak, hangUp, said, newSid, journalText };
}

describeWithSqlite('AU045 · le vrai raccordement téléphonique de l’assistant vocal', () => {
  it('[R710] constat : sans réglages complets, l’adresse du service téléphonique est fermée, jamais ouverte par défaut', async () => {
    for (const settings of [{}, { mode: 'reel', accountSid: ACCOUNT }, { mode: 'essai', accountSid: ACCOUNT, authToken: TOKEN }, { mode: 'reel', accountSid: 'AC12', authToken: TOKEN }]) {
      const w = await world(settings);
      const r = await w.ring(w.newSid());
      expect(r.status).toBe(503);
      expect(await w.db.all('SELECT id FROM voice_assistant_sessions')).toEqual([]);
    }
  });

  it('[R710] une requête mal signée, ou d’un autre compte du service, n’est ni lue ni rangée', async () => {
    const w2 = await world();
    const sid = w2.newSid();
    const bad = await w2.post('appel', { CallSid: sid, From: CALLER, ForwardedFrom: AGENT_PHONE }, { signature: sign(`${BASE}/appel`, { CallSid: sid }, 'autre-jeton-000000000000000000') });
    expect(bad.status).toBe(403);
    const other = await w2.post('appel', { CallSid: sid, From: CALLER, ForwardedFrom: AGENT_PHONE, AccountSid: `AC${'2'.repeat(32)}` });
    expect(other.status).toBe(403);
    const none = await w2.post('appel', { CallSid: sid, From: CALLER, ForwardedFrom: AGENT_PHONE }, { signature: '' });
    expect(none.status).toBe(403);
    expect(await w2.db.all('SELECT id FROM voice_assistant_sessions')).toEqual([]);
    expect(await w2.db.all('SELECT id FROM calls')).toEqual([]);
  });

  it('[R710] la signature suit l’algorithme de Twilio (adresse, champs triés, HMAC-SHA1)', async () => {
    const fields = { To: '+33900000001', CallSid: `CA${'a'.repeat(32)}`, From: '+33600000317', AccountSid: ACCOUNT };
    const url = 'https://exemple.test/v1/telephonie/appel?x=1';
    expect(await twilioSignature(TOKEN, url, new URLSearchParams(fields))).toBe(sign(url, fields));
  });

  it('[R710][R246][R242][R248] un appel renvoyé, depuis un téléphone extérieur : accord, rendez-vous, fiche et passage de main', async () => {
    const w = await world();
    const sid = w.newSid();
    const first = await w.ring(sid);
    expect(first.status).toBe(200);
    // La mention de l'assistant d'abord, puis l'annonce de l'enregistrement et la demande d'accord [R246, R242].
    const opening = w.said(first.text);
    expect(opening[0]).toMatch(/^Bonjour, vous êtes sur l’assistant automatique de Paul, agent immobilier AIMMO/);
    expect(opening[1]).toMatch(/enregistré.*Êtes-vous d’accord \?$/);
    expect(first.text).toContain('<Gather input="speech" language="fr-FR"');
    expect(first.text).toContain(`action="${BASE}/tour?n=0"`);
    // Aucun numéro dit : ni celui de l'agent, ni celui du service, ni celui de l'appelant [R246].
    for (const phone of [AGENT_PHONE, SERVICE_NUMBER, CALLER, '06 00']) expect(first.text).not.toContain(phone);

    expect(w.said((await w.speak(sid, 'Oui, d’accord.')).text)[0]).toBe('Merci.');
    const offer = w.said((await w.speak(sid, 'Je voudrais un rendez-vous avec Paul.')).text);
    expect(offer.join(' ')).toMatch(/Je peux vous proposer .* Lequel vous convient \?/);
    expect(w.said((await w.speak(sid, 'Le premier.')).text).join(' ')).toMatch(/C’est bien cela \?$/);
    const booked = await w.speak(sid, 'Oui.');
    expect(booked.text).toContain('<Hangup/>');

    // Le rendez-vous est pris sur un créneau proposé, la fiche de l'appelant est retrouvée, la main passe à l'agent.
    const handoff = await w.db.all<{ appointment_kind: string; appointment_start: string; call_row_id: string }>('SELECT appointment_kind, appointment_start, call_row_id FROM voice_assistant_calls');
    expect(handoff).toHaveLength(1);
    expect(handoff[0]!.appointment_kind).toBe('appel');
    const call = await w.db.first<{ status: string; person_id: string; consent_announced_at: string | null; consent_given_at: string | null; provider: string }>(
      'SELECT status, person_id, consent_announced_at, consent_given_at, provider FROM calls WHERE id = ?',
      [handoff[0]!.call_row_id],
    );
    expect(call).toMatchObject({ status: 'sans_enregistrement', person_id: w.person.id, provider: 'twilio' });
    const appointments = await w.db.all<{ source: string; start_at: string }>('SELECT source, start_at FROM appointments');
    expect(appointments).toEqual([{ source: 'assistant', start_at: handoff[0]!.appointment_start }]);

    // La fin signalée ensuite par le service ne range rien deux fois [R18] ; l'état de l'appel est effacé.
    expect((await w.hangUp(sid)).status).toBe(200);
    expect(await w.db.all('SELECT id FROM voice_assistant_calls')).toHaveLength(1);
    expect(await w.db.all('SELECT state, ended_at IS NOT NULL AS ended FROM voice_assistant_sessions')).toEqual([{ state: null, ended: 1 }]);
    // Ni numéro ni parole au journal [R13].
    const journal = await w.journalText();
    for (const secret of [CALLER, AGENT_PHONE, '600000317', '600000911', 'rendez-vous avec Paul', 'Le premier']) expect(journal).not.toContain(secret);
    expect(journal).toContain('voix.assistant_decroche');
    expect(journal).toContain('voix.assistant_passage');
  });

  it('[R710][R18] l’appelant raccroche au milieu : l’appel est rangé une fois, avec sa fiche, et la main passe à l’agent', async () => {
    const w = await world();
    const sid = w.newSid();
    await w.ring(sid);
    await w.speak(sid, 'Non.');
    await w.hangUp(sid);
    await w.hangUp(sid);
    // Un tour qui arrive après la fin ne rouvre rien.
    expect((await w.speak(sid, 'Allô ?')).text).toBe('<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>');
    const handoff = await w.db.all<{ call_row_id: string; appointment_kind: string | null }>('SELECT call_row_id, appointment_kind FROM voice_assistant_calls');
    expect(handoff).toHaveLength(1);
    expect(handoff[0]!.appointment_kind).toBeNull();
    // Refusé : l'enregistrement n'a pas d'accord, l'appel reste rattaché à la fiche [R242].
    expect(await w.db.first('SELECT status, person_id, consent_given_at FROM calls')).toEqual({ status: 'sans_enregistrement', person_id: w.person.id, consent_given_at: null });
    // Une seconde livraison de la sonnerie ne reprend pas l'appel fini.
    expect((await w.ring(sid)).text).toContain('<Hangup/>');
    expect(await w.db.all('SELECT id FROM voice_assistant_sessions')).toHaveLength(1);
  });

  it('[R710][R18] une sonnerie livrée deux fois ne prend l’appel qu’une fois', async () => {
    const w = await world();
    const sid = w.newSid();
    await w.ring(sid);
    await w.speak(sid, 'Oui.');
    const turns = await w.db.first<{ turns: number }>('SELECT turns FROM voice_assistant_sessions');
    expect(turns!.turns).toBe(1);
    // La même sonnerie livrée deux fois : un seul appel pris.
    // La même sonnerie livrée deux fois : un seul appel pris, la dernière réponse redite, rien de rejoué.
    const again = await w.ring(sid);
    expect(w.said(again.text)[0]).toBe('Merci.');
    expect(await w.db.all('SELECT id FROM voice_assistant_sessions')).toHaveLength(1);
  });

  it('[R246][R710] un appel direct, une ligne éteinte ou un numéro d’agent inconnu : une phrase fixe, et rien n’est rangé', async () => {
    const w = await world();
    const direct = await w.ring(w.newSid(), { ForwardedFrom: '' });
    expect(w.said(direct.text)).toEqual(['Bonjour, ce numéro ne prend aucun appel direct. Merci de rappeler votre agent AIMMO à son numéro habituel.']);
    expect(direct.text).toContain('<Hangup/>');
    const unknown = await w.ring(w.newSid(), { ForwardedFrom: '+33600000999' });
    expect(w.said(unknown.text)[0]).toMatch(/aucun appel direct/);
    await w.db.run('UPDATE voice_assistant_lines SET enabled = 0');
    const off = await w.ring(w.newSid());
    expect(w.said(off.text)).toEqual(['Bonjour, votre agent AIMMO ne peut pas vous répondre pour le moment. Merci de le rappeler un peu plus tard.']);
    expect(await w.db.all('SELECT id FROM voice_assistant_sessions')).toEqual([]);
    expect(await w.db.all('SELECT id FROM calls')).toEqual([]);
    const journal = await w.journalText();
    expect(journal).toContain('voix.telephonie_refus');
    expect(journal).not.toContain('600000999');
  });

  it('[R244][R710] un numéro masqué ne crée aucune fiche et ne réserve rien', async () => {
    expect(callerOf('anonymous')).toBeNull();
    expect(callerOf('+266696687')).toBeNull();
    expect(callerOf(CALLER)).toBe(CALLER);
    const w = await world();
    const sid = w.newSid();
    await w.ring(sid, { From: 'anonymous' });
    await w.speak(sid, 'Oui.');
    const r = await w.speak(sid, 'Je voudrais un rendez-vous.');
    expect(w.said(r.text).join(' ')).toMatch(/numéro est masqué/);
    await w.hangUp(sid);
    expect(await w.db.first('SELECT status, person_id FROM calls')).toEqual({ status: 'masque', person_id: null });
    expect(await w.db.all('SELECT id FROM appointments')).toEqual([]);
  });

  it('[R710][R248][R18] la fin livrée pendant la réservation : le rendez-vous pris reste dans le passage de main', async () => {
    const w = await world();
    const sid = w.newSid();
    await w.ring(sid);
    await w.speak(sid, 'Oui.');
    await w.speak(sid, 'Je voudrais un rendez-vous.');
    await w.speak(sid, 'Le premier.');
    // L'appelant raccroche pendant que le « oui » réserve : la fin arrive au milieu du tour.
    let fin: { status: number } | null = null;
    w.hooks.push({ match: /INSERT INTO appointments/, run: async () => void (fin = await w.hangUp(sid)) });
    await w.speak(sid, 'Oui.');
    expect(fin!.status).toBe(200);
    const appointments = await w.db.all<{ start_at: string }>('SELECT start_at FROM appointments');
    expect(appointments).toHaveLength(1);
    expect(await w.db.all('SELECT appointment_start FROM voice_assistant_calls')).toEqual([{ appointment_start: appointments[0]!.start_at }]);
    expect(await w.db.first('SELECT state, ended_at IS NOT NULL AS ended, lease_token FROM voice_assistant_sessions')).toEqual({ state: null, ended: 1, lease_token: null });
  });

  it('[R710][R04][R18] la fin livrée pendant un tour qui ne raccroche pas : le tour finit l’appel avec son état, arrêt compris', async () => {
    const w = await world();
    const sid = w.newSid();
    await w.ring(sid);
    await w.speak(sid, 'Oui.');
    await w.speak(sid, 'Je voudrais un rendez-vous.');
    // La fin arrive pendant que le tour range son état : elle ne peut pas prendre l'appel, le tour le finit.
    w.hooks.push({ match: /UPDATE voice_assistant_sessions SET state = \?, turns/, run: async () => void (await w.hangUp(sid)) });
    await w.speak(sid, 'Pardon, plutôt le deuxième.');
    expect(await w.db.first('SELECT state, ended_at IS NOT NULL AS ended FROM voice_assistant_sessions')).toEqual({ state: null, ended: 1 });
    expect(await w.db.all('SELECT id FROM voice_assistant_calls')).toHaveLength(1);
    // Une demande d'arrêt dite au tour où la fin arrive est rangée [R04].
    const v = await world();
    const sid2 = v.newSid();
    await v.ring(sid2);
    await v.speak(sid2, 'Oui.');
    v.hooks.push({ match: /UPDATE voice_assistant_sessions SET state = \?, turns/, run: async () => void (await v.hangUp(sid2)) });
    await v.speak(sid2, 'Ne m’appelez plus.');
    expect(await v.db.all('SELECT id FROM voice_assistant_calls')).toHaveLength(1);
    const passage = await v.db.first<{ data: string }>("SELECT data FROM journal WHERE type = 'voix.assistant_passage'");
    expect(JSON.parse(passage!.data)).toMatchObject({ stop: true });
  });

  it('[R710][R18] un tour tombé en route : la fin reprend l’appel une fois son délai passé', async () => {
    const w = await world();
    const sid = w.newSid();
    await w.ring(sid);
    await w.db.run("UPDATE voice_assistant_sessions SET lease_token = 'tombe', lease_at = '2026-01-01T00:00:00.000Z'");
    await w.hangUp(sid);
    expect(await w.db.first('SELECT ended_at IS NOT NULL AS ended FROM voice_assistant_sessions')).toEqual({ ended: 1 });
    expect(await w.db.all('SELECT id FROM voice_assistant_calls')).toHaveLength(1);
  });

  it('[R710][R18] la fin livrée pendant un tour qui tombe : l’appel est fini quand même, et la main passe à l’agent', async () => {
    const w = await world();
    const sid = w.newSid();
    await w.ring(sid);
    await w.speak(sid, 'Oui.');
    await w.speak(sid, 'Je voudrais un rendez-vous.');
    await w.speak(sid, 'Le premier.');
    w.hooks.push({
      match: /INSERT INTO appointments/,
      run: async () => {
        expect((await w.hangUp(sid)).status).toBe(200);
        throw new Error('panne de la base');
      },
    });
    expect((await w.speak(sid, 'Oui.')).status).toBe(500);
    expect(await w.db.first('SELECT state, ended_at IS NOT NULL AS ended, lease_token FROM voice_assistant_sessions')).toEqual({ state: null, ended: 1, lease_token: null });
    expect(await w.db.all('SELECT appointment_start FROM voice_assistant_calls')).toEqual([{ appointment_start: null }]);
  });

  it('[R710][R18] le passage de reprise finit un appel dit fini que personne n’a pu finir, ou resté sans nouvelle', async () => {
    const w = await world();
    const hung = w.newSid();
    await w.ring(hung);
    await w.speak(hung, 'Oui.');
    // Un tour tombé après avoir rangé son état, la fin livrée pendant ce temps : rien ne la refait.
    await w.db.run("UPDATE voice_assistant_sessions SET lease_token = 'tombe', lease_at = ? WHERE call_id = ?", [w.now().toISOString(), hung]);
    await w.db.run("INSERT INTO voice_call_endings (provider, call_id, ended_at, created_at) VALUES ('twilio', ?, ?, ?)", [hung, w.now().toISOString(), w.now().toISOString()]);
    const silent = w.newSid();
    await w.ring(silent);
    const live = w.newSid();
    await w.ring(live);
    await w.db.run("UPDATE voice_assistant_sessions SET updated_at = '2026-11-09T06:00:00.000Z' WHERE call_id = ?", [silent]);
    // Tant que le tour tombé tient l'appel, il n'est pas repris.
    expect(await runTelephoniePass({ db: w.db, now: w.now, linkBase: null })).toBe(1);
    const later = new Date(w.now().getTime() + 2 * 60_000);
    expect(await runTelephoniePass({ db: w.db, now: () => later, linkBase: null })).toBe(1);
    const rows = await w.db.all<{ call_id: string; ended: number }>('SELECT call_id, ended_at IS NOT NULL AS ended FROM voice_assistant_sessions ORDER BY call_id');
    expect(rows).toEqual([{ call_id: hung, ended: 1 }, { call_id: silent, ended: 1 }, { call_id: live, ended: 0 }]);
    expect(await w.db.all('SELECT id FROM voice_assistant_calls')).toHaveLength(2);
    expect(await runTelephoniePass({ db: w.db, now: () => later, linkBase: null })).toBe(0);
  });

  it('[R710][R18][R248] un même tour livré deux fois : la réponse est redite, la conversation n’avance pas', async () => {
    const w = await world();
    const sid = w.newSid();
    await w.ring(sid);
    await w.speak(sid, 'Oui.');
    await w.speak(sid, 'Je voudrais un rendez-vous.');
    const same = w.actions.get(sid)!;
    const first = await w.speak(sid, 'Le premier.', same);
    const again = await w.speak(sid, 'Le premier.', same);
    expect(w.said(again.text)).toEqual(w.said(first.text));
    expect(w.said(again.text).join(' ')).toMatch(/C’est bien cela \?$/);
    expect(await w.db.first('SELECT turns FROM voice_assistant_sessions')).toEqual({ turns: 3 });
    const yes = await w.speak(sid, 'Oui.');
    expect(yes.text).toContain('<Hangup/>');
    expect(await w.db.all('SELECT id FROM appointments')).toHaveLength(1);
    // Relivré après la fin : l'appel fini raccroche sans rien rejouer.
    expect((await w.speak(sid, 'Oui.', same)).text).toContain('<Hangup/>');
    expect(await w.db.all('SELECT id FROM appointments')).toHaveLength(1);
  });

  it('[R710][R18] la fin livrée avant que l’appel soit décroché : l’appel est rangé et son état effacé', async () => {
    const w = await world();
    const sid = w.newSid();
    w.hooks.push({ match: /INSERT INTO voice_assistant_sessions/, run: async () => void (await w.hangUp(sid)) });
    const r = await w.ring(sid);
    expect(r.text).toContain('<Hangup/>');
    expect(await w.db.first('SELECT state, ended_at IS NOT NULL AS ended FROM voice_assistant_sessions')).toEqual({ state: null, ended: 1 });
    expect(await w.db.first('SELECT status, person_id FROM calls')).toEqual({ status: 'sans_enregistrement', person_id: w.person.id });
    expect(await w.db.all('SELECT id FROM voice_assistant_calls')).toHaveLength(1);
  });

  it('[R710][R248] la réservation faite, l’état du tour non rangé : le rendez-vous est retrouvé au passage de main', async () => {
    const w = await world();
    const sid = w.newSid();
    await w.ring(sid);
    await w.speak(sid, 'Oui.');
    await w.speak(sid, 'Je voudrais un rendez-vous.');
    await w.speak(sid, 'Le premier.');
    w.hooks.push({
      match: /UPDATE voice_assistant_sessions SET state = \?, turns/,
      run: async () => {
        await w.hangUp(sid);
        throw new Error('panne de la base');
      },
    });
    expect((await w.speak(sid, 'Oui.')).status).toBe(500);
    const appointments = await w.db.all<{ start_at: string }>('SELECT start_at FROM appointments');
    expect(appointments).toHaveLength(1);
    expect(await w.db.all('SELECT appointment_start FROM voice_assistant_calls')).toEqual([{ appointment_start: appointments[0]!.start_at }]);
    expect(await w.db.first('SELECT ended_at IS NOT NULL AS ended FROM voice_assistant_sessions')).toEqual({ ended: 1 });
  });

  it('[R710][R18] reprise cinq heures plus tard : l’appel est rangé avec l’heure de fin dite par le service', async () => {
    const w = await world();
    const sid = w.newSid();
    await w.ring(sid);
    await w.speak(sid, 'Oui.');
    const endedAt = new Date(w.now().getTime() + 60_000).toISOString();
    await w.db.run("UPDATE voice_assistant_sessions SET lease_token = 'tombe', lease_at = ?", [w.now().toISOString()]);
    await w.db.run("INSERT INTO voice_call_endings (provider, call_id, ended_at, created_at) VALUES ('twilio', ?, ?, ?)", [sid, endedAt, endedAt]);
    const later = new Date(w.now().getTime() + 5 * 3600_000);
    expect(await runTelephoniePass({ db: w.db, now: () => later, linkBase: null })).toBe(1);
    const call = await w.db.first<{ status: string; ended_at: string }>('SELECT status, ended_at FROM calls');
    expect(call).toEqual({ status: 'sans_enregistrement', ended_at: endedAt });
  });

  it('[R710] le Worker passe TELEPHONIE_MODE et TWILIO_* à l’adresse du service téléphonique', async () => {
    const d1 = fakeD1(openMemoryDatabase());
    await applyMigrations(fromD1(d1), loadMigrations());
    const fields = { AccountSid: ACCOUNT, CallSid: `CA${'b'.repeat(32)}`, From: CALLER, ForwardedFrom: '' };
    const url = `${BASE}/appel`;
    const request = () =>
      new Request(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': sign(url, fields) }, body: new URLSearchParams(fields).toString() });
    const closed: Env = { DB: d1, MODE: 'essai' };
    expect((await worker.fetch(request(), closed)).status).toBe(503);
    const open: Env = { DB: d1, MODE: 'essai', TELEPHONIE_MODE: 'reel', TWILIO_ACCOUNT_SID: ACCOUNT, TWILIO_AUTH_TOKEN: TOKEN };
    const r = await worker.fetch(request(), open);
    expect(r.status).toBe(200);
    expect(await r.text()).toContain('aucun appel direct');
  });
});
