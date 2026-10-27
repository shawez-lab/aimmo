import { describe, expect, it } from 'vitest';
import { TransmissionOffres, transmissionText, type Offer } from '../src/offres/index.ts';
import { setupOffre } from './offres-jeu.ts';
import { describeWithSqlite } from './sqlite.ts';

// Vendeur, acquéreur et offres inventés.
const PROOF = 'preuves/0b6f1d2e-9999-4a2b-8c3d-000000000001.pdf';

async function setup() {
  const t = await setupOffre();
  const transmission = new TransmissionOffres(t.db, t.acces, t.journal, { now: t.now });
  // Le vendeur du jeu commun a une adresse mail et a donné son accord pour le suivi de son mandat.
  await t.store.addIdentifier({ networkId: t.network.id, agentId: t.alexId, personId: t.personId, kind: 'email', value: 'vendeur@exemple.test' });
  await t.store.addConsent({ networkId: t.network.id, agentId: t.alexId, personId: t.personId, purpose: 'suivi_mandat', channel: 'email', proof: 'mandat signé', givenAt: new Date('2027-02-10T09:00:00.000Z') });
  return { ...t, transmission };
}

describe('O03 · message au vendeur', () => {
  it('[R19] le texte est écrit par le code : montant, validité, référence ; jamais le nom de l’acquéreur', () => {
    const offer = { amountEur: 205000, validUntil: '2027-03-10' } as Offer;
    expect(transmissionText(offer, 'REF-T-1', 'Léa')).toBe(
      'Bonjour Léa, une offre écrite a été reçue pour votre bien réf. REF-T-1 : 205 000 €, valable jusqu\'au 10/03/2027 inclus. Je vous appelle pour l\'étudier avec vous.',
    );
    expect(transmissionText(offer, 'REF-T-1', null)).toMatch(/^Bonjour, une offre/);
  });
});

describeWithSqlite('O03 · transmission et réponse', () => {
  it('une offre test suivie de bout en bout : reçue, enregistrée, transmise par message, acceptée, avec un historique horodaté', async () => {
    const t = await setup();
    const offer = await t.record();
    expect(await t.transmission.stateOf(offer)).toBe('recue');
    t.setClock(new Date('2027-03-01T11:00:00.000Z'));
    const sent = await t.transmission.transmit(t.agent, offer.id, { via: 'message' });
    expect(sent).toMatchObject({ ok: true, value: { via: 'message' } });
    // Le message est passé par le contrôle central, en mode essai : rangé, rien n'est parti.
    const out = await t.db.all<{ body: string }>('SELECT body FROM messages WHERE person_id = ? AND direction = ?', [t.personId, 'out']);
    expect(out).toHaveLength(1);
    expect(out[0]!.body).toContain('205');
    expect(out[0]!.body).not.toMatch(/Acheteur/);
    expect(await t.transmission.stateOf(offer)).toBe('transmise');
    t.setClock(new Date('2027-03-02T15:00:00.000Z'));
    expect(await t.transmission.respond(t.agent, offer.id, { outcome: 'acceptee', proofRef: PROOF, respondedAt: '2027-03-02T14:30:00.000Z' })).toEqual({ ok: true, value: { outcome: 'acceptee' } });
    const h = await t.transmission.history(t.agent, offer.id);
    expect(h.ok && h.value.state).toBe('acceptee');
    expect(h.ok && h.value.events.map((e) => e.event)).toEqual(['recue', 'enregistree', 'transmise:message', 'reponse:acceptee']);
    expect(h.ok && h.value.events.map((e) => e.at)).toEqual(['2027-03-01T09:00:00.000Z', '2027-03-01T10:00:00.000Z', '2027-03-01T11:00:00.000Z', '2027-03-02T14:30:00.000Z']);
  });

  it('[R57] aucune fonction ne change l’état d’une offre sans une réponse du vendeur rapportée avec preuve', async () => {
    const t = await setup();
    const offer = await t.record();
    await t.transmission.transmit(t.agent, offer.id, { via: 'telephone' });
    // Ni le temps, ni un contrôle, ni une seconde transmission ne l'acceptent ou ne la refusent.
    await t.transmission.alertUntransmitted(t.network.id);
    expect(await t.transmission.transmit(t.agent, offer.id, { via: 'en_personne' })).toEqual({ ok: false, rule: null, code: 'already_transmitted' });
    expect(await t.transmission.stateOf(offer)).toBe('transmise');
    t.setClock(new Date('2027-03-01T11:00:00.000Z'));
    // Sans preuve, pas de réponse ; une réponse unique.
    expect(await t.transmission.respond(t.agent, offer.id, { outcome: 'acceptee', proofRef: 'oui', respondedAt: '2027-03-01T10:30:00.000Z' })).toEqual({ ok: false, rule: null, code: 'bad_proof' });
    expect(await t.transmission.respond(t.agent, offer.id, { outcome: 'peut-etre', proofRef: PROOF, respondedAt: '2027-03-01T10:30:00.000Z' })).toEqual({ ok: false, rule: null, code: 'bad_outcome' });
    expect(await t.transmission.respond(t.agent, offer.id, { outcome: 'refusee', proofRef: PROOF, respondedAt: '2027-03-01T08:00:00.000Z' })).toEqual({ ok: false, rule: null, code: 'bad_date' });
    expect(await t.transmission.respond(t.agent, offer.id, { outcome: 'refusee', proofRef: PROOF, respondedAt: '2027-03-01T10:30:00.000Z' })).toMatchObject({ ok: true });
    expect(await t.transmission.respond(t.agent, offer.id, { outcome: 'acceptee', proofRef: PROOF, respondedAt: '2027-03-01T10:40:00.000Z' })).toEqual({ ok: false, rule: null, code: 'already_answered' });
    expect(await t.transmission.stateOf(offer)).toBe('refusee');
    await expect(t.db.run("UPDATE offer_responses SET outcome = 'acceptee'")).rejects.toThrow(/rien ne change/);
  });

  it('une offre non transmise ne reçoit pas de réponse ; une offre échue ne peut plus être acceptée [R59]', async () => {
    const t = await setup();
    const offer = await t.record({ validUntil: '2027-03-05' });
    expect(await t.transmission.respond(t.agent, offer.id, { outcome: 'acceptee', proofRef: PROOF, respondedAt: '2027-03-01T09:30:00.000Z' })).toEqual({ ok: false, rule: null, code: 'not_transmitted' });
    await t.transmission.transmit(t.agent, offer.id, { via: 'en_personne' });
    t.setClock(new Date('2027-03-06T10:00:00.000Z'));
    expect(await t.transmission.stateOf(offer)).toBe('echue');
    expect(await t.transmission.respond(t.agent, offer.id, { outcome: 'acceptee', proofRef: PROOF, respondedAt: '2027-03-05T23:30:00.000Z' })).toEqual({ ok: false, rule: 'R59', code: 'expired' });
    // Une heure sans fuseau n'est jamais lue selon le serveur.
    expect(await t.transmission.respond(t.agent, offer.id, { outcome: 'acceptee', proofRef: PROOF, respondedAt: '2027-03-05T21:59' })).toEqual({ ok: false, rule: null, code: 'bad_date' });
    expect(await t.transmission.respond(t.agent, offer.id, { outcome: 'acceptee', proofRef: PROOF, respondedAt: '2027-03-05' })).toEqual({ ok: false, rule: null, code: 'bad_date' });
    // Le 5 mars à 22 h 59 à Paris, encore valable ; écrit avec le décalage de Paris.
    expect(await t.transmission.respond(t.agent, offer.id, { outcome: 'acceptee', proofRef: PROOF, respondedAt: '2027-03-05T22:59:00+01:00' })).toMatchObject({ ok: true });
  });

  it('[R59] une offre transmise après son échéance ne peut pas être acceptée : jamais de réponse avant la transmission', async () => {
    const t = await setup();
    const offer = await t.record({ validUntil: '2027-03-05' });
    t.setClock(new Date('2027-03-10T10:00:00.000Z'));
    expect(await t.transmission.transmit(t.agent, offer.id, { via: 'en_personne' })).toMatchObject({ ok: true });
    expect(await t.transmission.respond(t.agent, offer.id, { outcome: 'acceptee', proofRef: PROOF, respondedAt: '2027-03-04T10:00:00.000Z' })).toEqual({ ok: false, rule: null, code: 'bad_date' });
    expect(await t.transmission.respond(t.agent, offer.id, { outcome: 'acceptee', proofRef: PROOF, respondedAt: '2027-03-10T10:00:00.000Z' })).toEqual({ ok: false, rule: 'R59', code: 'expired' });
    expect(await t.transmission.respond(t.agent, offer.id, { outcome: 'refusee', proofRef: PROOF, respondedAt: '2027-03-10T10:00:00.000Z' })).toMatchObject({ ok: true });
  });

  it('[R01] [R02] le message passe par le contrôle central : refusé la nuit ou pour une personne exclue, rien n’est transmis', async () => {
    const t = await setup();
    const offer = await t.record();
    t.setClock(new Date('2027-03-01T21:30:00.000Z')); // 22 h 30 à Paris
    const night = await t.transmission.transmit(t.agent, offer.id, { via: 'message' });
    expect(night).toMatchObject({ ok: false, rule: 'R01', code: 'message_refused' });
    expect(await t.transmission.stateOf(offer)).toBe('recue');
    t.setClock(new Date('2027-03-02T10:00:00.000Z'));
    await t.store.addExclusion({ networkId: t.network.id, agentId: t.alexId, personId: t.personId, reason: 'network_list', notedAt: new Date('2027-03-02T09:00:00.000Z') });
    expect(await t.transmission.transmit(t.agent, offer.id, { via: 'message' })).toMatchObject({ ok: false, rule: 'R02', code: 'message_refused' });
    expect(await t.transmission.stateOf(offer)).toBe('recue');
    // L'agent transmet alors de vive voix, et l'atteste.
    expect(await t.transmission.transmit(t.agent, offer.id, { via: 'telephone' })).toMatchObject({ ok: true });
    expect(await t.transmission.stateOf(offer)).toBe('transmise');
  });

  it('[R56] une offre pas transmise après 24 heures est signalée une fois à l’agent et à la direction', async () => {
    const t = await setup();
    const a = await t.record();
    const b = await t.record();
    await t.transmission.transmit(t.agent, b.id, { via: 'telephone' });
    t.setClock(new Date('2027-03-02T09:59:00.000Z'));
    expect(await t.transmission.alertUntransmitted(t.network.id)).toEqual([]);
    t.setClock(new Date('2027-03-02T10:00:00.000Z'));
    expect(await t.transmission.alertUntransmitted(t.network.id)).toEqual([a.id]);
    expect(await t.transmission.alertUntransmitted(t.network.id)).toEqual([]);
    const alert = (await t.journal.bySubject(`offer:${a.id}`)).find((e) => e.type === 'offre.non_transmise');
    expect(alert?.data).toEqual({ rule: 'R56', agent: `agent:${t.alexId}`, to: ['agent', 'direction'] });
    // Le journal tombe juste après qu'une alerte est rangée : elle est annoncée au passage suivant, une fois.
    const c = await t.record();
    t.setClock(new Date('2027-03-03T10:00:00.000Z'));
    const j = t.journal;
    const failing = { last: () => j.last(), all: () => j.all(), bySubject: (x: string) => j.bySubject(x), byPeriod: (x: string, y: string) => j.byPeriod(x, y), append: async () => { throw new Error('panne du journal'); } };
    await expect(new TransmissionOffres(t.db, t.acces, failing, { now: t.now }).alertUntransmitted(t.network.id)).rejects.toThrow();
    expect(await t.transmission.alertUntransmitted(t.network.id)).toEqual([c.id]);
    expect(await t.transmission.alertUntransmitted(t.network.id)).toEqual([]);
    expect((await t.journal.bySubject(`offer:${c.id}`)).filter((e) => e.type === 'offre.non_transmise')).toHaveLength(1);
  });

  it('[R16] seul l’agent du bien transmet et rapporte une réponse ; la direction lit l’historique', async () => {
    const t = await setup();
    const offer = await t.record();
    expect(await t.transmission.transmit(t.direction, offer.id, { via: 'telephone' })).toEqual({ ok: false, rule: 'R16', code: 'role' });
    expect(await t.transmission.transmit(t.sam, offer.id, { via: 'telephone' })).toMatchObject({ ok: false, rule: 'R16' });
    expect(await t.transmission.history(t.direction, offer.id)).toMatchObject({ ok: true });
    expect(await t.transmission.history(t.sam, offer.id)).toMatchObject({ ok: false, rule: 'R16' });
    expect(await t.transmission.transmit(t.agent, 'offre-inconnue', { via: 'telephone' })).toEqual({ ok: false, rule: null, code: 'unknown_offer' });
  });
});
