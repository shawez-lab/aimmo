import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SEND_SETTINGS,
  DecisionEnvoi,
  FicheClient,
  FicheUnique,
  applyMigrations,
  decideSend,
  frenchHolidays,
  fromSyncSqlite,
  isStopRequest,
  localTime,
  type Channel,
  type SendFacts,
  type SendKind,
  type SendRequest,
} from '../src/index.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

// Novembre 2026 : Paris est à UTC+1. Juin 2027 : UTC+2.
const SAT_1959 = '2026-11-07T18:59:00.000Z';
const SAT_2000 = '2026-11-07T19:00:00.000Z';
const SUN_NOON = '2026-11-08T11:00:00.000Z';
const SUN_2300 = '2026-11-08T22:00:00.000Z';
const TUE_1000 = '2026-11-10T09:00:00.000Z';

const LONG_AGO = '2026-01-01T00:00:00.000Z';
type Facts = { -readonly [K in keyof SendFacts]: SendFacts[K] extends readonly (infer T)[] ? T[] : SendFacts[K] };

function facts(over: Partial<Facts> = {}): Facts {
  return {
    exclusions: [],
    consents: (['email', 'sms', 'whatsapp', 'phone'] as Channel[]).flatMap((channel) =>
      (['alert', 'follow_up', 'reminder', 'review_request', 'partner', 'prospecting'] as SendKind[]).map((purpose) => ({
        channel,
        purpose,
        given_at: LONG_AGO,
        withdrawn_at: null,
      })),
    ),
    messages: [],
    relations: [],
    sentToday: { review_request: 0, partner: 0 },
    ...over,
  };
}

const req = (at: string, over: Partial<SendRequest> = {}): SendRequest => ({
  channel: 'email',
  kind: 'alert',
  at: new Date(at),
  ...over,
});

const minutesBefore = (at: string, minutes: number): string =>
  new Date(Date.parse(at) - minutes * 60_000).toISOString();

const inbound = (at: string, channel: Channel = 'whatsapp', conversation = 'conv-1') => ({
  conversation_id: conversation,
  channel,
  direction: 'in' as const,
  occurred_at: at,
});

describe('S05 · heure de Paris', () => {
  it('jour, date et minutes locales, heure d’hiver et d’été', () => {
    expect(localTime(new Date(SAT_1959), 'Europe/Paris')).toEqual({ date: '2026-11-07', weekday: 6, minutes: 19 * 60 + 59 });
    expect(localTime(new Date('2027-06-05T17:59:00.000Z'), 'Europe/Paris')).toEqual({ date: '2027-06-05', weekday: 6, minutes: 19 * 60 + 59 });
    expect(localTime(new Date('2026-11-08T23:30:00.000Z'), 'Europe/Paris').date).toBe('2026-11-09');
  });

  it('jours fériés, fêtes mobiles comprises', () => {
    const y2027 = frenchHolidays(2027);
    for (const d of ['2027-01-01', '2027-03-29', '2027-05-06', '2027-05-17', '2027-07-14', '2027-11-11', '2027-12-25']) {
      expect(y2027.has(d), d).toBe(true);
    }
    expect(frenchHolidays(2026).has('2026-04-06')).toBe(true);
    expect(y2027.has('2027-03-28')).toBe(false);
  });
});

describe('S05 · décision d’envoi', () => {
  it('[R01] samedi 19 h 59 part, samedi 20 h 00 ne part pas', () => {
    expect(decideSend(req(SAT_1959), facts())).toMatchObject({ allowed: true, rule: null });
    expect(decideSend(req(SAT_2000), facts())).toMatchObject({ allowed: false, rule: 'R01' });
  });

  it('[R01] même limite en heure d’été', () => {
    expect(decideSend(req('2027-06-05T17:59:00.000Z'), facts()).allowed).toBe(true);
    expect(decideSend(req('2027-06-05T18:00:00.000Z'), facts()).rule).toBe('R01');
  });

  it('[R01] le dimanche, aucun envoi d’initiative, de quelque type que ce soit', () => {
    for (const kind of ['alert', 'follow_up', 'reminder', 'review_request', 'partner', 'prospecting'] as SendKind[]) {
      expect(decideSend(req(SUN_NOON, { kind }), facts()), kind).toMatchObject({ allowed: false, rule: 'R01' });
    }
  });

  it('[R01] lundi 7 h 59 non, 8 h 00 oui', () => {
    expect(decideSend(req('2026-11-09T06:59:00.000Z'), facts()).rule).toBe('R01');
    expect(decideSend(req('2026-11-09T07:00:00.000Z'), facts()).allowed).toBe(true);
  });

  it('[R01] réponse à un message reçu il y a 59 minutes : part tout de suite, dimanche soir compris', () => {
    const f = facts({ consents: [], messages: [inbound(minutesBefore(SUN_2300, 59))] });
    const d = decideSend(req(SUN_2300, { kind: 'reply', channel: 'whatsapp', conversationId: 'conv-1' }), f);
    expect(d).toMatchObject({ allowed: true, rule: 'R01' });
  });

  it('[R01] réponse à un message reçu il y a 61 minutes, ou 60 tout juste : attend les heures d’envoi', () => {
    for (const age of [60, 61]) {
      const f = facts({ consents: [], messages: [inbound(minutesBefore(SUN_2300, age))] });
      const d = decideSend(req(SUN_2300, { kind: 'reply', channel: 'whatsapp', conversationId: 'conv-1' }), f);
      expect(d, `${age} min`).toMatchObject({ allowed: false, rule: 'R01' });
    }
  });

  it('[R01] l’exception ne vaut que pour la même conversation et le même canal', () => {
    const recent = minutesBefore(SUN_2300, 5);
    for (const message of [inbound(recent, 'whatsapp', 'autre'), inbound(recent, 'email', 'conv-1')]) {
      const d = decideSend(req(SUN_2300, { kind: 'reply', channel: 'whatsapp', conversationId: 'conv-1' }), facts({ messages: [message] }));
      expect(d.rule).toBe('R01');
      expect(d.allowed).toBe(false);
    }
    expect(() => decideSend(req(SUN_2300, { kind: 'reply' }), facts())).toThrow(/conversation/);
  });

  it('[R03] réponse tardive, en journée : permise sans accord si le message reçu attend encore sa réponse', () => {
    const asked = minutesBefore(TUE_1000, 61);
    const pending = facts({ consents: [], messages: [inbound(asked)] });
    expect(decideSend(req(TUE_1000, { kind: 'reply', channel: 'whatsapp', conversationId: 'conv-1' }), pending)).toMatchObject({
      allowed: true,
    });
    const answered = facts({
      consents: [],
      messages: [inbound(asked), { conversation_id: 'conv-1', channel: 'whatsapp', direction: 'out', occurred_at: minutesBefore(TUE_1000, 60) }],
    });
    expect(decideSend(req(TUE_1000, { kind: 'reply', channel: 'whatsapp', conversationId: 'conv-1' }), answered)).toMatchObject({
      allowed: false,
      rule: 'R03',
    });
  });

  it('[R02] une personne exclue qui écrit ne reçoit aucune réponse automatique, sur aucun canal', () => {
    for (const reason of ['network_list', 'refused', 'sold', 'followed_elsewhere'] as const) {
      const f = facts({
        exclusions: [{ reason, channel: 'instagram', noted_at: LONG_AGO, lifted_at: null }],
        messages: [inbound(minutesBefore(TUE_1000, 1), 'instagram')],
      });
      expect(decideSend(req(TUE_1000, { kind: 'reply', channel: 'instagram', conversationId: 'conv-1' }), f), reason).toMatchObject({
        allowed: false,
        rule: 'R02',
      });
      for (const channel of ['email', 'sms', 'whatsapp', 'phone', 'facebook', 'instagram'] as Channel[]) {
        expect(decideSend(req(TUE_1000, { channel }), f).rule, `${reason} ${channel}`).toBe('R02');
      }
    }
  });

  it('[R02] une exclusion levée, ou notée plus tard, ne bloque pas', () => {
    const lifted = facts({ exclusions: [{ reason: 'sold', channel: null, noted_at: LONG_AGO, lifted_at: '2026-06-01T00:00:00.000Z' }] });
    expect(decideSend(req(TUE_1000), lifted).allowed).toBe(true);
    const later = facts({ exclusions: [{ reason: 'sold', channel: null, noted_at: '2026-12-01T00:00:00.000Z', lifted_at: null }] });
    expect(decideSend(req(TUE_1000), later).allowed).toBe(true);
  });

  it('[R04] un arrêt demandé sur Instagram ferme aussi le mail, le SMS, WhatsApp et le téléphone', () => {
    const f = facts({ exclusions: [{ reason: 'stop', channel: 'instagram', noted_at: LONG_AGO, lifted_at: null }] });
    for (const channel of ['email', 'sms', 'whatsapp', 'phone', 'facebook'] as Channel[]) {
      expect(decideSend(req(TUE_1000, { channel }), f), channel).toMatchObject({ allowed: false, rule: 'R04' });
    }
  });

  it('[R03] sans accord en cours sur ce canal et pour cette finalité, pas d’envoi par téléphone, SMS, WhatsApp ou mail', () => {
    const consent = { channel: 'email' as Channel, purpose: 'alert', given_at: LONG_AGO, withdrawn_at: null };
    expect(decideSend(req(TUE_1000), facts({ consents: [consent] })).allowed).toBe(true);
    expect(decideSend(req(TUE_1000), facts({ consents: [] })).rule).toBe('R03');
    expect(decideSend(req(TUE_1000, { channel: 'sms' }), facts({ consents: [consent] })).rule).toBe('R03');
    expect(decideSend(req(TUE_1000, { kind: 'follow_up' }), facts({ consents: [consent] })).rule).toBe('R03');
    expect(decideSend(req(TUE_1000, { purpose: 'newsletter' }), facts({ consents: [consent] })).rule).toBe('R03');
    const withdrawn = { ...consent, withdrawn_at: '2026-10-01T00:00:00.000Z' };
    expect(decideSend(req(TUE_1000), facts({ consents: [withdrawn] })).rule).toBe('R03');
    const future = { ...consent, given_at: '2026-12-01T00:00:00.000Z' };
    expect(decideSend(req(TUE_1000), facts({ consents: [future] })).rule).toBe('R03');
    for (const channel of ['phone', 'sms', 'whatsapp'] as Channel[]) {
      expect(decideSend(req(TUE_1000, { channel, kind: 'prospecting' }), facts({ consents: [] })).rule, channel).toBe('R03');
    }
  });

  it('[R03] Instagram et Facebook ne demandent pas d’accord préalable enregistré', () => {
    expect(decideSend(req(TUE_1000, { channel: 'instagram' }), facts({ consents: [] })).allowed).toBe(true);
  });

  it('[R11] demandes d’avis : de 9 h à 19 h, 2 par jour, jamais à un collègue, un associé ou un proche', () => {
    const kind = 'review_request';
    expect(decideSend(req('2026-11-10T07:59:00.000Z', { kind }), facts()).rule).toBe('R11');
    expect(decideSend(req('2026-11-10T08:00:00.000Z', { kind }), facts()).allowed).toBe(true);
    expect(decideSend(req('2026-11-10T17:59:00.000Z', { kind }), facts()).allowed).toBe(true);
    expect(decideSend(req('2026-11-10T18:00:00.000Z', { kind }), facts()).rule).toBe('R11');
    expect(decideSend(req(TUE_1000, { kind }), facts({ sentToday: { review_request: 1, partner: 0 } })).allowed).toBe(true);
    expect(decideSend(req(TUE_1000, { kind }), facts({ sentToday: { review_request: 2, partner: 0 } })).rule).toBe('R11');
    for (const relation of ['colleague', 'associate', 'relative'] as const) {
      const f = facts({ relations: [{ relation, noted_at: LONG_AGO, ended_at: null }] });
      expect(decideSend(req(TUE_1000, { kind }), f).rule, relation).toBe('R11');
    }
    const ended = facts({ relations: [{ relation: 'colleague', noted_at: LONG_AGO, ended_at: '2026-02-01T00:00:00.000Z' }] });
    expect(decideSend(req(TUE_1000, { kind }), ended).allowed).toBe(true);
  });

  it('[R11] messages aux partenaires : 5 par jour ouvré, jamais le samedi ni un jour férié', () => {
    const kind = 'partner';
    expect(decideSend(req(TUE_1000, { kind }), facts({ sentToday: { review_request: 0, partner: 4 } })).allowed).toBe(true);
    expect(decideSend(req(TUE_1000, { kind }), facts({ sentToday: { review_request: 0, partner: 5 } })).rule).toBe('R11');
    expect(decideSend(req('2026-11-07T10:00:00.000Z', { kind }), facts()).rule).toBe('R11');
    expect(decideSend(req('2026-11-11T10:00:00.000Z', { kind }), facts()).rule).toBe('R11');
    expect(decideSend(req('2027-03-29T09:00:00.000Z', { kind }), facts()).rule).toBe('R11');
  });

  it('[R13] la raison rendue cite la règle et ne contient aucune donnée de la fiche', () => {
    const d = decideSend(req(SAT_2000, { purpose: 'lea.martin@example.test' }), facts());
    expect(d.reason).not.toMatch(/@|example/);
    expect(d.checked).toEqual(['R04', 'R02', 'R01']);
  });

  it('les nombres sont des réglages', () => {
    const settings = { ...DEFAULT_SEND_SETTINGS, initiativeUntil: 21 * 60 };
    expect(decideSend(req(SAT_2000), facts(), settings).allowed).toBe(true);
  });
});

describe('S05 · demande d’arrêt reconnue', () => {
  it('[R04] les formules d’arrêt', () => {
    for (const text of ['STOP', 'Stop.', 'arrêt', 'Arrêtez', 'stop svp', 'Merci de ne plus me contacter', 'ne m’écrivez plus', 'Retirez-moi de votre liste', 'je veux me désinscrire', 'Plus de SMS svp', 'Je ne veux plus être contacté', 'Je ne souhaite plus recevoir vos messages', 'Je ne veux plus de vos sms', 'Ne plus m’écrire', 'N’écrivez plus', 'Laissez-moi tranquille', 'Supprimez mon numéro', 'Ne me contactez pas', 'Ne m’appelez pas svp', 'Ne nous écrivez plus', 'Ne m’envoyez plus rien', 'Pas intéressé', 'Non merci', 'Vous pouvez arrêter de m’appeler, je ne veux plus être dérangé']) {
      expect(isStopRequest(text), text).toBe(true);
    }
    for (const text of ['Bonjour, le bien est-il disponible ?', 'Il y a un arrêt de bus devant ?', 'Je peux venir samedi', 'Le prix est-il encore négociable ? Je veux en savoir plus', 'Pouvez-vous m’appeler demain ?']) {
      expect(isStopRequest(text), text).toBe(false);
    }
  });
});

describeWithSqlite('S05 · décision d’envoi sur la base', () => {
  const migrations = loadMigrations().filter((m) => ['0001_fiche_client', '0003_fusion', '0004_envoi'].includes(m.id));

  async function setup() {
    const db = fromSyncSqlite(openMemoryDatabase());
    await applyMigrations(db, migrations);
    const store = new FicheClient(db);
    const fiche = new FicheUnique(db, store);
    const envoi = new DecisionEnvoi(db, store, fiche);
    const network = await store.createNetwork('Réseau test');
    const person = await store.createPerson({ networkId: network.id, firstName: 'Léa' });
    return { db, store, fiche, envoi, network, person };
  }

  it('la migration se rejoue sans erreur', async () => {
    const { db } = await setup();
    for (const m of migrations) await db.exec(m.sql);
    expect(await applyMigrations(db, migrations)).toEqual([]);
  });

  it('[R04] « STOP » reçu sur Instagram : plus rien sur le mail, même avec un accord ; une seule exclusion', async () => {
    const { store, envoi, network, person } = await setup();
    await store.addConsent({ networkId: network.id, personId: person.id, purpose: 'alert', channel: 'email', proof: 'formulaire test', givenAt: new Date(LONG_AGO) });
    expect((await envoi.decide(person.id, req(TUE_1000))).allowed).toBe(true);
    const at = new Date('2026-11-10T08:00:00.000Z');
    const { stop } = await envoi.recordReceived({ networkId: network.id, personId: person.id, channel: 'instagram', conversationId: 'c', body: 'STOP', occurredAt: at });
    expect(stop).toMatchObject({ reason: 'stop', channel: null });
    await envoi.recordStopRequest({ networkId: network.id, personId: person.id, at: new Date(TUE_1000) });
    expect(await store.listExclusions(person.id)).toHaveLength(1);
    for (const channel of ['email', 'instagram', 'sms'] as Channel[]) {
      expect(await envoi.decide(person.id, req(TUE_1000, { channel })), channel).toMatchObject({ allowed: false, rule: 'R04' });
    }
  });

  it('[R04] « Ne me contactez pas » reçu par mail : plus rien sur Instagram ni ailleurs', async () => {
    const { envoi, network, person } = await setup();
    expect((await envoi.decide(person.id, req(TUE_1000, { channel: 'instagram', kind: 'follow_up' }))).allowed).toBe(true);
    const { stop } = await envoi.recordReceived({ networkId: network.id, personId: person.id, channel: 'email', conversationId: 'm', body: 'Ne me contactez pas.', occurredAt: new Date(LONG_AGO) });
    expect(stop).not.toBeNull();
    for (const channel of ['instagram', 'facebook', 'email'] as Channel[]) {
      expect((await envoi.decide(person.id, req(TUE_1000, { channel, kind: 'follow_up' }))).rule, channel).toBe('R04');
    }
  });

  it('[R04] un arrêt noté sur une fiche fusionnée vaut pour la fiche gardée, et réciproquement', async () => {
    const { store, fiche, envoi, network, person } = await setup();
    const twin = await store.createPerson({ networkId: network.id });
    await fiche.merge({ survivorId: person.id, mergedId: twin.id, reason: 'mail commun' });
    await envoi.recordReceived({ networkId: network.id, personId: twin.id, channel: 'sms', body: 'Stop', occurredAt: new Date(LONG_AGO) });
    expect((await envoi.decide(person.id, req(TUE_1000))).rule).toBe('R04');
    expect((await envoi.decide(twin.id, req(TUE_1000))).rule).toBe('R04');
  });

  it('[R01] la réponse se fonde sur les messages rangés de la fiche', async () => {
    const { envoi, network, person } = await setup();
    await envoi.recordReceived({ networkId: network.id, personId: person.id, channel: 'whatsapp', conversationId: 'conv-1', body: 'Le bien est-il libre ?', occurredAt: new Date(minutesBefore(SUN_2300, 59)) });
    const reply = req(SUN_2300, { kind: 'reply', channel: 'whatsapp', conversationId: 'conv-1' });
    expect(await envoi.decide(person.id, reply)).toMatchObject({ allowed: true, rule: 'R01' });
    expect((await envoi.decide(person.id, { ...reply, at: new Date(minutesBefore(SUN_2300, -2)) })).rule).toBe('R01');
  });

  it('[R11] le plafond compte les demandes d’avis du jour de Paris, dans tout le réseau', async () => {
    const { store, envoi, network, person } = await setup();
    const other = await store.createPerson({ networkId: network.id });
    await store.addConsent({ networkId: network.id, personId: person.id, purpose: 'review_request', channel: 'email', proof: 'case cochée, test', givenAt: new Date(LONG_AGO) });
    const sent = (personId: string, at: string) =>
      envoi.recordSent({ networkId: network.id, personId, channel: 'email', authorKind: 'system', body: 'Votre avis', occurredAt: new Date(at) }, 'review_request');
    await sent(other.id, '2026-11-09T22:30:00.000Z'); // lundi 23 h 30 à Paris : ne compte pas pour mardi
    await sent(other.id, '2026-11-09T23:30:00.000Z'); // mardi 0 h 30 à Paris
    expect(await envoi.sentToday(network.id, new Date(TUE_1000))).toEqual({ review_request: 1, partner: 0 });
    const ask = req(TUE_1000, { kind: 'review_request' });
    expect((await envoi.decide(person.id, ask)).allowed).toBe(true);
    await sent(other.id, '2026-11-10T08:30:00.000Z');
    expect((await envoi.decide(person.id, ask)).rule).toBe('R11');
  });

  it('[R11] un proche noté sur la fiche ne reçoit jamais de demande d’avis', async () => {
    const { envoi, network, person } = await setup();
    await envoi.addRelation({ networkId: network.id, personId: person.id, relation: 'relative', notedAt: new Date(LONG_AGO) });
    expect((await envoi.decide(person.id, req(TUE_1000, { kind: 'review_request' }))).rule).toBe('R11');
  });
});
