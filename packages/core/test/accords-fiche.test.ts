import { describe, expect, it } from 'vitest';
import { Acces, AGENT_CONSENT_CHANNELS, AGENT_CONSENT_PURPOSES, AccordsFiche, DecisionEnvoi, FicheClient, FicheUnique, SqlJournalStore, applyMigrations, fromSyncSqlite, type SqlDatabase, type Viewer } from '../src/index.ts';
import { ALERT_PURPOSE } from '../src/acquereurs/alertes.ts';
import { RENTAL_UPDATE_PURPOSE } from '../src/location/branchement.ts';
import { VALUE_TRACKING_PURPOSE } from '../src/mandats/suivi-valeur.ts';
import { OFFER_PURPOSE } from '../src/offres/transmission.ts';
import { ROUTE_SHARE_PURPOSE } from '../src/rendezvous/tournee.ts';
import { VALUATION_PURPOSE } from '../src/reprise/reprise.ts';
import { SELLER_UPDATE_PURPOSE } from '../src/visites/compte-rendu.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

// Tout est inventé. Le 8 juin 2027 est un mardi, 10 h à Paris : dans les heures d'envoi [R01].
const TUESDAY_10H = Date.parse('2027-06-08T08:00:00.000Z');
const DAY = 86_400_000;
const NOTE = 'Accord donné de vive voix au rendez-vous du 7 juin, pour suivre sa vente par mail.';
const email = 'client.invente@example.test';

async function setup() {
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  let clock = TUESDAY_10H;
  const now = (): Date => new Date((clock += 1000));
  const journal = new SqlJournalStore(db);
  const store = new FicheClient(db, { now });
  const fiche = new FicheUnique(db, store, { now });
  const acces = new Acces(db, store, fiche, journal, { now });
  const accords = new AccordsFiche(store, acces, journal, { now });
  const decision = new DecisionEnvoi(db, store, fiche, { now });
  const network = await store.createNetwork('Réseau test');
  const alexAgent = await store.createAgent({ networkId: network.id, firstName: 'Alex', lastName: 'Agent' });
  const samAgent = await store.createAgent({ networkId: network.id, firstName: 'Sam', lastName: 'Agent' });
  const alex: Viewer = { role: 'agent', userId: alexAgent.id, networkId: network.id };
  const sam: Viewer = { role: 'agent', userId: samAgent.id, networkId: network.id };
  const direction: Viewer = { role: 'direction', userId: 'dir-1', networkId: network.id };
  const person = await store.createPerson({ networkId: network.id, agentId: alexAgent.id, firstName: 'Client', lastName: 'Inventé' });
  await store.addIdentifier({ networkId: network.id, personId: person.id, kind: 'email', value: email });
  const input = (over: Record<string, unknown> = {}) => ({ purpose: 'suivi_vente', channel: 'email', proof: NOTE, givenOn: '2027-06-07', ...over });
  const canSend = async (id = person.id) => decision.decide(id, { channel: 'email', kind: 'follow_up', purpose: 'suivi_vente', at: new Date(clock) });
  const rows = (id = person.id) => db.all<{ id: string; proof: string; given_at: string; withdrawn_at: string | null; agent_id: string | null }>('SELECT * FROM consents WHERE person_id = ?', [id]);
  const events = () => db.all<{ type: string; actor: string; subject: string; data: string }>('SELECT type, actor, subject, data FROM journal ORDER BY rowid');
  return { db, store, fiche, acces, accords, network, alexAgent, alex, sam, direction, person, input, canSend, rows, events, advance: (ms: number) => (clock += ms), nowMs: () => clock };
}

describeWithSqlite('AC01 · l’agent note et retire un accord', () => {
  it('[R03] chaque finalité ouverte à l’agent est bien celle que son module demande, et rien que ce qu’il peut noter', () => {
    expect([...AGENT_CONSENT_PURPOSES].sort()).toEqual(
      [ALERT_PURPOSE, OFFER_PURPOSE, RENTAL_UPDATE_PURPOSE, ROUTE_SHARE_PURPOSE, SELLER_UPDATE_PURPOSE, VALUATION_PURPOSE, VALUE_TRACKING_PURPOSE, 'prospecting', 'rappel_demande'].sort(),
    );
    expect([...AGENT_CONSENT_CHANNELS].sort()).toEqual(['email', 'phone', 'sms', 'whatsapp']);
  });

  it('[R03] [R202] l’accord noté ouvre l’envoi au contrôle central, le retrait le referme', async () => {
    const t = await setup();
    expect((await t.canSend()).rule).toBe('R03');
    const noted = await t.accords.record(t.alex, t.person.id, t.input());
    expect(noted).toMatchObject({ ok: true, value: { already: false } });
    expect((await t.canSend()).allowed).toBe(true);
    const [row] = await t.rows();
    expect(row!.proof).toContain(NOTE);
    expect(row!.proof).toContain(`agent:${t.alexAgent.id}`);
    expect(row!.given_at).toBe('2027-06-06T22:00:00.000Z'); // minuit à Paris
    expect(row!.agent_id).toBe(t.alexAgent.id);

    const taken = await t.accords.withdraw(t.alex, t.person.id, noted.ok ? noted.value.consentId : '');
    expect(taken.ok).toBe(true);
    expect((await t.canSend()).rule).toBe('R03');
  });

  it('[R03] l’accord vaut pour sa finalité et son canal, pas pour les autres', async () => {
    const t = await setup();
    await t.accords.record(t.alex, t.person.id, t.input({ channel: 'sms' }));
    expect((await t.canSend()).rule).toBe('R03');
    await t.accords.record(t.alex, t.person.id, t.input({ purpose: 'suivi_location' }));
    expect((await t.canSend()).rule).toBe('R03');
  });

  it('[R16] la direction peut noter ; un autre agent est refusé, avec le refus au journal et rien de rangé', async () => {
    const t = await setup();
    expect((await t.accords.record(t.direction, t.person.id, t.input())).ok).toBe(true);
    const other = await setup();
    const refused = await other.accords.record(other.sam, other.person.id, other.input());
    expect(refused).toMatchObject({ ok: false, rule: 'R16' });
    expect(await other.rows()).toHaveLength(0);
    expect((await other.events()).some((e) => e.type === 'acces.refuse')).toBe(true);
    expect(await other.accords.withdraw(other.sam, other.person.id, 'x')).toMatchObject({ ok: false, rule: 'R16' });
  });

  it('[R16] un autre rôle est refusé avant toute lecture', async () => {
    const t = await setup();
    const compliance: Viewer = { role: 'compliance', userId: 'c-1', networkId: t.network.id };
    expect(await t.accords.record(compliance, t.person.id, t.input())).toMatchObject({ ok: false, rule: 'R16', code: 'role' });
    expect(await t.accords.withdraw(compliance, t.person.id, 'x')).toMatchObject({ ok: false, rule: 'R16', code: 'role' });
    expect(await t.rows()).toHaveLength(0);
  });

  it('[R02] [R04] une personne exclue ou arrêtée ne reçoit pas d’accord, sur aucune de ses fiches réunies', async () => {
    const t = await setup();
    const stopped = await t.store.addExclusion({ networkId: t.network.id, personId: t.person.id, reason: 'stop', notedAt: new Date(TUESDAY_10H - 2 * DAY) });
    expect(await t.accords.record(t.alex, t.person.id, t.input())).toMatchObject({ ok: false, rule: 'R04', code: 'stopped' });
    await t.store.liftExclusion(stopped.id, new Date(TUESDAY_10H));

    const other = await setup();
    const merged = await other.store.createPerson({ networkId: other.network.id, agentId: other.alexAgent.id, firstName: 'Double', lastName: 'Inventé' });
    await other.store.addExclusion({ networkId: other.network.id, personId: merged.id, reason: 'network_list', notedAt: new Date(TUESDAY_10H - 2 * DAY) });
    await other.fiche.merge({ survivorId: other.person.id, mergedId: merged.id, reason: 'test' });
    expect(await other.accords.record(other.alex, other.person.id, other.input())).toMatchObject({ ok: false, rule: 'R02', code: 'excluded' });
    expect(await other.rows()).toHaveLength(0);
  });

  it('[R03] un retrait ne s’efface pas par une date ancienne : l’accord doit dater d’après', async () => {
    const t = await setup();
    const noted = await t.accords.record(t.alex, t.person.id, t.input());
    await t.accords.withdraw(t.alex, t.person.id, noted.ok ? noted.value.consentId : '');
    expect(await t.accords.record(t.alex, t.person.id, t.input())).toMatchObject({ ok: false, rule: 'R03', code: 'given_before_withdrawal' });
    expect((await t.canSend()).rule).toBe('R03');
    t.advance(DAY);
    const again = await t.accords.record(t.alex, t.person.id, t.input({ givenOn: '2027-06-09' }));
    expect(again.ok).toBe(true);
    t.advance(1000);
    expect((await t.canSend()).allowed).toBe(true);
    expect(await t.rows()).toHaveLength(2);
  });

  it('[R02] [R04] une exclusion levée ne s’efface pas par une date ancienne', async () => {
    const t = await setup();
    const stopped = await t.store.addExclusion({ networkId: t.network.id, personId: t.person.id, reason: 'stop', notedAt: new Date(TUESDAY_10H - 3 * DAY) });
    await t.store.liftExclusion(stopped.id, new Date(TUESDAY_10H - 2 * 3600_000));
    expect(await t.accords.record(t.alex, t.person.id, t.input())).toMatchObject({ ok: false, rule: 'R04', code: 'given_before_lift' });
    expect((await t.accords.record(t.alex, t.person.id, t.input({ givenOn: '2027-06-08' }))).ok).toBe(true);
  });

  it('[R03] un accord déjà en cours n’est pas doublé, même sur une fiche réunie', async () => {
    const t = await setup();
    const first = await t.accords.record(t.alex, t.person.id, t.input());
    const second = await t.accords.record(t.alex, t.person.id, t.input());
    expect(second).toMatchObject({ ok: true, value: { already: true, consentId: first.ok ? first.value.consentId : '' } });
    expect(await t.rows()).toHaveLength(1);

    const other = await setup();
    const merged = await other.store.createPerson({ networkId: other.network.id, agentId: other.alexAgent.id, firstName: 'Double', lastName: 'Inventé' });
    const carried = await other.store.addConsent({ networkId: other.network.id, personId: merged.id, purpose: 'suivi_vente', channel: 'email', proof: 'preuve du doublon', givenAt: new Date(TUESDAY_10H - 2 * DAY) });
    await other.fiche.merge({ survivorId: other.person.id, mergedId: merged.id, reason: 'test' });
    expect(await other.accords.record(other.alex, other.person.id, other.input())).toMatchObject({ ok: true, value: { already: true, consentId: carried.id } });
    expect(await other.rows()).toHaveLength(0);
  });

  it('[R03] [R02] antidater reste refusé quand le retrait ou la levée est sur une fiche réunie', async () => {
    const t = await setup();
    const merged = await t.store.createPerson({ networkId: t.network.id, agentId: t.alexAgent.id, firstName: 'Double', lastName: 'Inventé' });
    const old = await t.store.addConsent({ networkId: t.network.id, personId: merged.id, purpose: 'suivi_vente', channel: 'email', proof: 'preuve du doublon', givenAt: new Date(TUESDAY_10H - 3 * DAY) });
    await t.store.withdrawConsent(old.id, new Date(TUESDAY_10H - 3600_000));
    await t.fiche.merge({ survivorId: t.person.id, mergedId: merged.id, reason: 'test' });
    expect(await t.accords.record(t.alex, t.person.id, t.input())).toMatchObject({ ok: false, rule: 'R03', code: 'given_before_withdrawal' });

    const other = await setup();
    const double = await other.store.createPerson({ networkId: other.network.id, agentId: other.alexAgent.id, firstName: 'Double', lastName: 'Inventé' });
    const excluded = await other.store.addExclusion({ networkId: other.network.id, personId: double.id, reason: 'refused', notedAt: new Date(TUESDAY_10H - 3 * DAY) });
    await other.store.liftExclusion(excluded.id, new Date(TUESDAY_10H - 3600_000));
    await other.fiche.merge({ survivorId: other.person.id, mergedId: double.id, reason: 'test' });
    expect(await other.accords.record(other.alex, other.person.id, other.input())).toMatchObject({ ok: false, rule: 'R02', code: 'given_before_lift' });
  });

  it('[R04] un accord plus ancien qu’une levée ne compte pas comme en cours : la nouvelle preuve est rangée', async () => {
    const t = await setup();
    await t.accords.record(t.alex, t.person.id, t.input());
    const stopped = await t.store.addExclusion({ networkId: t.network.id, personId: t.person.id, reason: 'stop', notedAt: new Date(TUESDAY_10H - 3600_000) });
    await t.store.liftExclusion(stopped.id, new Date(TUESDAY_10H));
    t.advance(60_000);
    const again = await t.accords.record(t.alex, t.person.id, t.input({ givenOn: '2027-06-08', proof: 'Nouvel accord donné après la levée de son arrêt.' }));
    expect(again).toMatchObject({ ok: true, value: { already: false } });
    expect(await t.rows()).toHaveLength(2);
  });

  it('[R03] retirer ferme tous les accords de même finalité et de même canal des fiches réunies', async () => {
    const t = await setup();
    const merged = await t.store.createPerson({ networkId: t.network.id, agentId: t.alexAgent.id, firstName: 'Double', lastName: 'Inventé' });
    const a = await t.store.addConsent({ networkId: t.network.id, personId: t.person.id, purpose: 'suivi_vente', channel: 'email', proof: 'preuve a', givenAt: new Date(TUESDAY_10H - DAY) });
    await t.store.addConsent({ networkId: t.network.id, personId: merged.id, purpose: 'suivi_vente', channel: 'email', proof: 'preuve b', givenAt: new Date(TUESDAY_10H - DAY) });
    const kept = await t.store.addConsent({ networkId: t.network.id, personId: t.person.id, purpose: 'suivi_location', channel: 'email', proof: 'preuve c', givenAt: new Date(TUESDAY_10H - DAY) });
    await t.fiche.merge({ survivorId: t.person.id, mergedId: merged.id, reason: 'test' });
    expect((await t.canSend()).allowed).toBe(true);
    expect((await t.accords.withdraw(t.alex, t.person.id, a.id)).ok).toBe(true);
    expect((await t.canSend()).rule).toBe('R03');
    expect((await t.rows(merged.id))[0]!.withdrawn_at).not.toBeNull();
    expect((await t.rows()).find((r) => r.id === kept.id)!.withdrawn_at).toBeNull();
  });

  it('[R17] retirer garde la ligne et sa preuve ; retirer deux fois rend la même date', async () => {
    const t = await setup();
    const noted = await t.accords.record(t.alex, t.person.id, t.input());
    const id = noted.ok ? noted.value.consentId : '';
    const first = await t.accords.withdraw(t.alex, t.person.id, id);
    t.advance(DAY);
    const second = await t.accords.withdraw(t.alex, t.person.id, id);
    expect(second).toEqual(first);
    const [row] = await t.rows();
    expect(row!.proof).toContain(NOTE);
    expect(row!.withdrawn_at).not.toBeNull();
  });

  it('[R03] le retrait reste possible pour une personne exclue depuis', async () => {
    const t = await setup();
    const noted = await t.accords.record(t.alex, t.person.id, t.input());
    await t.store.addExclusion({ networkId: t.network.id, personId: t.person.id, reason: 'stop', notedAt: new Date(TUESDAY_10H) });
    expect((await t.accords.withdraw(t.alex, t.person.id, noted.ok ? noted.value.consentId : '')).ok).toBe(true);
  });

  it('[R16] on ne retire pas l’accord d’une autre fiche, et rien ne dit qu’il existe', async () => {
    const t = await setup();
    const other = await t.store.createPerson({ networkId: t.network.id, agentId: t.alexAgent.id, firstName: 'Autre', lastName: 'Inventé' });
    const foreign = await t.store.addConsent({ networkId: t.network.id, personId: other.id, purpose: 'suivi_vente', channel: 'email', proof: 'preuve', givenAt: new Date(TUESDAY_10H - DAY) });
    const unknown = await t.accords.withdraw(t.alex, t.person.id, 'inconnu');
    const refused = await t.accords.withdraw(t.alex, t.person.id, foreign.id);
    expect(refused).toEqual(unknown);
    expect(refused).toMatchObject({ ok: false, code: 'unknown_consent' });
    expect((await t.rows(other.id))[0]!.withdrawn_at).toBeNull();
  });

  it('[R202] entrées illisibles refusées, rien de rangé', async () => {
    const t = await setup();
    const cases: [Record<string, unknown>, string][] = [
      [{ purpose: 'appointment' }, 'bad_purpose'],
      [{ purpose: 'prospection_partenaire' }, 'bad_purpose'],
      [{ purpose: 7 }, 'bad_purpose'],
      [{ purpose: '__proto__' }, 'bad_purpose'],
      [{ channel: 'instagram' }, 'bad_channel'],
      [{ channel: null }, 'bad_channel'],
      [{ proof: 'court' }, 'bad_proof'],
      [{ proof: '          ' + 'court' + '          ' }, 'bad_proof'],
      [{ proof: 'x'.repeat(1001) }, 'bad_proof'],
      [{ proof: 'contrôle \u0007 dans la preuve' }, 'bad_proof'],
      [{ proof: 12 }, 'bad_proof'],
      [{ givenOn: 'hier' }, 'bad_date'],
      [{ givenOn: '2027-06-07T10:00:00.000Z' }, 'bad_date'],
      [{ givenOn: '2027-02-31' }, 'bad_date'],
      [{ givenOn: 123 }, 'bad_date'],
      [{ givenOn: undefined }, 'bad_date'],
      [{ givenOn: '2027-06-09' }, 'future_date'],
    ];
    for (const [over, code] of cases) {
      expect(await t.accords.record(t.alex, t.person.id, t.input(over)), code).toMatchObject({ ok: false, code });
    }
    expect(await t.rows()).toHaveLength(0);
  });

  it('[R202] aujourd’hui à Paris vaut l’heure du serveur, y compris juste après minuit', async () => {
    const t = await setup();
    const noted = await t.accords.record(t.alex, t.person.id, t.input({ givenOn: '2027-06-08' }));
    expect(noted.ok).toBe(true);
    expect(Date.parse((await t.rows())[0]!.given_at)).toBeGreaterThan(TUESDAY_10H);
    expect((await t.canSend()).allowed).toBe(true);
  });

  it('[R03] un retrait d’aujourd’hui ferme aujourd’hui comme hier pour la date passée, pas un accord noté après', async () => {
    const t = await setup();
    const noted = await t.accords.record(t.alex, t.person.id, t.input({ givenOn: '2027-06-01' }));
    await t.accords.withdraw(t.alex, t.person.id, noted.ok ? noted.value.consentId : '');
    expect(await t.accords.record(t.alex, t.person.id, t.input({ givenOn: '2027-06-07' }))).toMatchObject({ ok: false, code: 'given_before_withdrawal' });
    expect((await t.accords.record(t.alex, t.person.id, t.input({ givenOn: '2027-06-08' }))).ok).toBe(true);
    expect((await t.canSend()).allowed).toBe(true);
  });

  it('[R03] [R203] noter une demande rouvre vraiment l’appel : demande périmée rangée à neuf ; demande ancienne après un retrait d’une autre finalité non plus retenue', async () => {
    const t = await setup();
    // Une demande de plus de 13 mois n'ouvre plus l'appel : elle ne retient pas la nouvelle.
    await t.store.addConsent({ networkId: t.network.id, personId: t.person.id, purpose: 'rappel_demande', channel: 'phone', proof: 'ancienne demande', givenAt: new Date(TUESDAY_10H - 500 * DAY) });
    const renewed = await t.accords.record(t.alex, t.person.id, t.input({ purpose: 'rappel_demande', channel: 'phone', givenOn: '2027-06-08' }));
    expect(renewed).toMatchObject({ ok: true, value: { already: false } });

    const other = await setup();
    await other.store.addConsent({ networkId: other.network.id, personId: other.person.id, purpose: 'reply', channel: 'phone', proof: 'message reçu', givenAt: new Date(TUESDAY_10H - 90 * DAY) });
    const asked = await other.store.addConsent({ networkId: other.network.id, personId: other.person.id, purpose: 'rappel_demande', channel: 'phone', proof: 'demande', givenAt: new Date(TUESDAY_10H - 80 * DAY) });
    const prospect = await other.store.addConsent({ networkId: other.network.id, personId: other.person.id, purpose: 'prospecting', channel: 'phone', proof: 'accord', givenAt: new Date(TUESDAY_10H - 70 * DAY) });
    await other.store.withdrawConsent(prospect.id, new Date(TUESDAY_10H - 3600_000));
    // Daté de la veille du retrait : accepter serait trompeur, l'appel resterait fermé.
    expect(await other.accords.record(other.alex, other.person.id, other.input({ purpose: 'rappel_demande', channel: 'phone', givenOn: '2027-06-07' }))).toMatchObject({ ok: false, rule: 'R03', code: 'given_before_withdrawal' });
    const again = await other.accords.record(other.alex, other.person.id, other.input({ purpose: 'rappel_demande', channel: 'phone', givenOn: '2027-06-08' }));
    expect(again).toMatchObject({ ok: true, value: { already: false } });
    expect(again.ok && again.value.consentId).not.toBe(asked.id);
  });

  it('[R13] ni preuve, ni adresse, ni nom au journal', async () => {
    const t = await setup();
    const noted = await t.accords.record(t.alex, t.person.id, t.input());
    await t.accords.withdraw(t.alex, t.person.id, noted.ok ? noted.value.consentId : '');
    const events = await t.events();
    expect(events.map((e) => e.type)).toEqual(expect.arrayContaining(['fiche.accord_note', 'fiche.accord_retire']));
    const all = JSON.stringify(events);
    expect(all).not.toContain('vive voix');
    expect(all).not.toContain(email);
    expect(all).not.toContain('Inventé');
    const note = events.find((e) => e.type === 'fiche.accord_note')!;
    expect(note.actor).toBe(`agent:${t.alexAgent.id}`);
    expect(note.subject).toBe(`person:${t.person.id}`);
    expect(JSON.parse(note.data)).toMatchObject({ rule: 'R03', purpose: 'suivi_vente', channel: 'email' });
  });

  describe('AC05 · un accord retiré ne se rouvre jamais', () => {
    const trace = (t: Awaited<ReturnType<typeof setup>>) => ({ journal: new SqlJournalStore(t.db), actor: 'direction:dir-1' });
    const doublon = async (t: Awaited<ReturnType<typeof setup>>) => {
      const other = await t.store.createPerson({ networkId: t.network.id, agentId: t.alexAgent.id, firstName: 'Client', lastName: 'Inventé' });
      return other.id;
    };
    const older = (t: Awaited<ReturnType<typeof setup>>, days: number) => new Date(t.nowMs() - days * DAY);

    it('[R03] [R202] un retrait sur une fiche, un accord ouvert et plus ancien sur son doublon : la fusion ne rouvre pas l’envoi', async () => {
      const t = await setup();
      const b = await doublon(t);
      await t.store.addConsent({ networkId: t.network.id, personId: b, purpose: 'suivi_vente', channel: 'email', proof: 'preuve inventée', givenAt: older(t, 3) });
      const noted = await t.accords.record(t.alex, t.person.id, t.input());
      if (!noted.ok) throw new Error(noted.code);
      await t.store.withdrawConsent(noted.value.consentId, new Date(t.nowMs()));
      t.advance(60_000);
      await t.fiche.merge({ survivorId: t.person.id, mergedId: b, reason: 'identifiant commun' });
      expect((await t.canSend()).rule).toBe('R03');
    });

    it('[R03] [R202] le même accord noté après le retrait rouvre l’envoi ; le doublon ancien ne le fait pas prendre pour déjà en cours', async () => {
      const t = await setup();
      const b = await doublon(t);
      const stale = await t.store.addConsent({ networkId: t.network.id, personId: b, purpose: 'suivi_vente', channel: 'email', proof: 'preuve inventée', givenAt: older(t, 3) });
      const noted = await t.accords.record(t.alex, t.person.id, t.input());
      if (!noted.ok) throw new Error(noted.code);
      await t.store.withdrawConsent(noted.value.consentId, new Date(t.nowMs()));
      t.advance(60_000);
      await t.fiche.merge({ survivorId: t.person.id, mergedId: b, reason: 'identifiant commun' });

      const again = await t.accords.record(t.alex, t.person.id, t.input({ givenOn: '2027-06-08' }));
      expect(again).toMatchObject({ ok: true, value: { already: false } });
      if (again.ok) expect(again.value.consentId).not.toBe(stale.id);
      t.advance(60_000);
      expect((await t.canSend()).allowed).toBe(true);
    });

    it('[R02] [R202] une exclusion levée ne rouvre pas un accord plus ancien qu’elle', async () => {
      const t = await setup();
      const noted = await t.accords.record(t.alex, t.person.id, t.input());
      expect(noted.ok).toBe(true);
      expect((await t.canSend()).allowed).toBe(true);
      const exclusion = await t.store.addExclusion({ networkId: t.network.id, personId: t.person.id, reason: 'refused', notedAt: new Date(t.nowMs()) });
      t.advance(60_000);
      await t.store.liftExclusion(exclusion.id, new Date(t.nowMs()));
      t.advance(60_000);
      expect((await t.canSend()).rule).toBe('R03');
    });

    it('[R04] [R202] un arrêt levé non plus', async () => {
      const t = await setup();
      await t.accords.record(t.alex, t.person.id, t.input());
      const stop = await t.store.addExclusion({ networkId: t.network.id, personId: t.person.id, reason: 'stop', notedAt: new Date(t.nowMs()) });
      t.advance(60_000);
      await t.store.liftExclusion(stop.id, new Date(t.nowMs()));
      t.advance(60_000);
      expect((await t.canSend()).rule).toBe('R03');
    });

    it('[R03] [R17] défaire une fusion ferme sans effacer les accords créés pendant, et le journal le dit sans preuve', async () => {
      const t = await setup();
      const b = await doublon(t);
      const before = await t.store.addConsent({ networkId: t.network.id, personId: b, purpose: 'alertes_biens', channel: 'email', proof: 'preuve inventée', givenAt: older(t, 3) });
      t.advance(60_000);
      const merge = await t.fiche.merge({ survivorId: t.person.id, mergedId: b, reason: 'identifiant commun' });
      t.advance(60_000);
      const during = await t.accords.record(t.alex, t.person.id, t.input());
      if (!during.ok) throw new Error(during.code);
      expect((await t.canSend()).allowed).toBe(true);
      t.advance(60_000);
      const count = await t.db.first<{ n: number }>('SELECT count(*) AS n FROM consents');

      const undoneAt = await t.fiche.undoMerge(merge.id, trace(t));

      expect(await t.db.first<{ n: number }>('SELECT count(*) AS n FROM consents')).toEqual(count);
      const rows = await t.rows();
      expect(rows.find((r) => r.id === during.value.consentId)?.withdrawn_at).toBe(undoneAt);
      expect((await t.rows(b)).find((r) => r.id === before.id)?.withdrawn_at).toBeNull();
      t.advance(60_000);
      expect((await t.canSend()).rule).toBe('R03');
      expect((await t.canSend(b)).rule).toBe('R03');

      const lines = (await t.events()).filter((e) => e.type === 'fiche.fusion_defaite');
      expect(lines).toHaveLength(1);
      expect(lines[0]!.data).toContain(during.value.consentId);
      expect(lines[0]!.data).not.toContain('Accord donné');
      expect(lines[0]!.subject).toBe(`person:${t.person.id}`);
      expect(lines[0]!.data).toContain(merge.id);
    });

    it('[R03] défaire deux fois garde la première date, ne ferme rien de plus et n’écrit qu’une ligne ; une ligne perdue revient', async () => {
      const t = await setup();
      const b = await doublon(t);
      const merge = await t.fiche.merge({ survivorId: t.person.id, mergedId: b, reason: 'identifiant commun' });
      t.advance(60_000);
      const during = await t.accords.record(t.alex, t.person.id, t.input());
      if (!during.ok) throw new Error(during.code);
      const cut = new SqlJournalStore(t.db);
      cut.append = async () => { throw new Error('coupure'); };
      await expect(t.fiche.undoMerge(merge.id, { journal: cut, actor: 'direction:dir-1' })).rejects.toThrow('coupure');
      const closedAt = (await t.rows()).find((r) => r.id === during.value.consentId)?.withdrawn_at;
      expect(closedAt).not.toBeNull();

      t.advance(60_000);
      const after = await t.accords.record(t.alex, t.person.id, t.input({ givenOn: '2027-06-08' }));
      if (!after.ok) throw new Error(after.code);
      expect(await t.fiche.undoMerge(merge.id, trace(t))).toBe(closedAt);
      expect(await t.fiche.undoMerge(merge.id, trace(t))).toBe(closedAt);
      expect((await t.rows()).find((r) => r.id === after.value.consentId)?.withdrawn_at).toBeNull();
      const lines = (await t.events()).filter((e) => e.type === 'fiche.fusion_defaite');
      expect(lines).toHaveLength(1);
      expect(lines[0]!.data).toContain(during.value.consentId);
      expect(lines[0]!.data).not.toContain(after.value.consentId);
    });

    it('[R03] un accord noté pendant une fusion imbriquée est fermé quand la fusion intérieure est défaite', async () => {
      const t = await setup();
      const b = await doublon(t);
      const c = await doublon(t);
      const inner = await t.fiche.merge({ survivorId: b, mergedId: c, reason: 'identifiant commun' });
      await t.fiche.merge({ survivorId: t.person.id, mergedId: b, reason: 'identifiant commun' });
      t.advance(60_000);
      const during = await t.accords.record(t.alex, t.person.id, t.input());
      if (!during.ok) throw new Error(during.code);
      await t.fiche.undoMerge(inner.id, trace(t));
      expect((await t.rows()).find((r) => r.id === during.value.consentId)?.withdrawn_at).not.toBeNull();
    });
  });
});
