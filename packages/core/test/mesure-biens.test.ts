import { describe, expect, it } from 'vitest';
import { MesureBiens, mondayOf } from '../src/annonces/index.ts';
import { setupAnnonce } from './annonces-jeu.ts';
import { describeWithSqlite } from './sqlite.ts';

// Vues, contacts et visites inventés, sur la semaine du lundi 1er mars 2027.
describe('P08 · semaine de Paris', () => {
  it('le lundi de la semaine se lit à l’heure de Paris', () => {
    expect(mondayOf(new Date('2027-03-01T10:00:00.000Z'))).toBe('2027-03-01');
    expect(mondayOf(new Date('2027-03-07T22:30:00.000Z'))).toBe('2027-03-01'); // dimanche 23 h 30 à Paris
    expect(mondayOf(new Date('2027-03-07T23:30:00.000Z'))).toBe('2027-03-08'); // lundi 0 h 30 à Paris
    expect(mondayOf(new Date('2027-03-28T21:30:00.000Z'))).toBe('2027-03-22'); // heure d'été : dimanche 23 h 30 à Paris
    expect(mondayOf(new Date('2027-03-28T22:30:00.000Z'))).toBe('2027-03-29'); // heure d'été : lundi 0 h 30 à Paris
  });
});

describeWithSqlite('P08 · mesure par bien', () => {
  async function seed() {
    const t = await setupAnnonce();
    t.setClock(new Date('2027-03-08T09:00:00.000Z'));
    const mesure = new MesureBiens(t.db, t.acces, t.journal, { now: t.now });
    const persons = [t.personId];
    for (const n of [2, 3]) persons.push((await t.store.createPerson({ networkId: t.network.id, agentId: t.alexId, firstName: `Test${n}`, lastName: 'Exemple' })).id);
    let k = 0;
    const contact = async (personId: string, at: string) => {
      k++;
      await t.db.run(
        "INSERT INTO inbound_messages (id, network_id, dedup_key, channel, kind, status, person_id, received_at, created_at) VALUES (?, ?, ?, 'instagram', 'direct', 'processed', ?, ?, ?)",
        [`in-${k}`, t.network.id, `d-${k}`, personId, at, at],
      );
      await t.db.run(
        "INSERT INTO qualifications (id, network_id, inbound_id, person_id, category, property_id, source, created_at) VALUES (?, ?, ?, ?, 'buyer', ?, 'rules', ?)",
        [`q-${k}`, t.network.id, `in-${k}`, personId, t.propertyId, at],
      );
    };
    const visit = async (status: string, start: string) => {
      k++;
      const end = new Date(Date.parse(start) + 30 * 60_000).toISOString();
      await t.db.run(
        "INSERT INTO appointments (id, network_id, agent_id, person_id, property_id, kind, start_at, end_at, status, token_hash, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'visite', ?, ?, ?, ?, 'agent', ?, ?)",
        [`rdv-${k}`, t.network.id, t.alexId, persons[0]!, t.propertyId, start, end, status, `h-${k}`, start, start],
      );
    };
    // Contacts : deux personnes dans la semaine (l'une écrit deux fois), une le dimanche soir à Paris, une la semaine d'après.
    await contact(persons[0]!, '2027-03-01T08:00:00.000Z');
    await contact(persons[0]!, '2027-03-03T08:00:00.000Z');
    await contact(persons[1]!, '2027-03-07T22:30:00.000Z');
    await contact(persons[2]!, '2027-03-07T23:30:00.000Z');
    // Visites : une faite, une prévue, une annulée, une la semaine d'avant (dimanche 28 février, 23 h 30 à Paris = dans la semaine d'avant).
    await visit('honored', '2027-03-02T09:00:00.000Z');
    await visit('booked', '2027-03-06T14:00:00.000Z');
    await visit('cancelled', '2027-03-04T14:00:00.000Z');
    await visit('honored', '2027-02-28T22:30:00.000Z');
    // Vues : par canal et par jour.
    expect(await mesure.recordViews(t.network.id, t.propertyId, 'site', '2027-03-01', 120)).toEqual({ ok: true });
    await mesure.recordViews(t.network.id, t.propertyId, 'site', '2027-03-07', 30);
    await mesure.recordViews(t.network.id, t.propertyId, 'portails', '2027-03-02', 300);
    await mesure.recordViews(t.network.id, t.propertyId, 'reseaux', '2027-03-08', 999);
    await mesure.recordViews(t.network.id, t.propertyId, 'google', '2027-02-28', 999);
    return { t, mesure };
  }

  it('compte juste sur un jeu inventé, à l’heure de Paris', async () => {
    const { t, mesure } = await seed();
    const r = await mesure.weekly(t.agent, t.propertyId, '2027-03-01');
    expect(r).toEqual({ ok: true, value: { week: '2027-03-01', views: { site: 150, reseaux: 0, google: 0, portails: 300 }, totalViews: 450, contacts: 2, visits: { done: 1, planned: 1 } } });
  });

  it('un seul relevé par bien, canal et jour ; jamais un jour à venir ; rien ne s’efface', async () => {
    const { t, mesure } = await seed();
    expect(await mesure.recordViews(t.network.id, t.propertyId, 'site', '2027-03-01', 5)).toEqual({ ok: false, rule: null, code: 'already_recorded' });
    expect(await mesure.recordViews(t.network.id, t.propertyId, 'site', '2027-03-09', 5)).toEqual({ ok: false, rule: null, code: 'bad_day' });
    expect(await mesure.recordViews(t.network.id, t.propertyId, 'site', '2027-02-30', 5)).toEqual({ ok: false, rule: null, code: 'bad_day' });
    expect(await mesure.recordViews(t.network.id, t.propertyId, 'site', '2027-03-02', -1)).toEqual({ ok: false, rule: null, code: 'bad_views' });
    expect(await mesure.recordViews(t.network.id, t.propertyId, 'fax' as never, '2027-03-02', 1)).toEqual({ ok: false, rule: null, code: 'bad_channel' });
    expect(await mesure.recordViews('autre-reseau', t.propertyId, 'site', '2027-03-02', 1)).toEqual({ ok: false, rule: null, code: 'unknown_property' });
    await expect(t.db.run('DELETE FROM listing_views')).rejects.toThrow(/rien ne s'efface/);
  });

  it('[R16] seuls l’agent du bien et la direction lisent la mesure ; aucune donnée personnelle', async () => {
    const { t, mesure } = await seed();
    expect(await mesure.weekly(t.sam, t.propertyId, '2027-03-01')).toMatchObject({ ok: false, rule: 'R16' });
    expect(await mesure.weekly(t.direction, t.propertyId, '2027-03-01')).toMatchObject({ ok: true });
    expect(await mesure.weekly(t.agent, t.propertyId, '2027-03-02')).toEqual({ ok: false, rule: null, code: 'not_monday' });
    const r = await mesure.weekly(t.agent, t.propertyId, '2027-03-01');
    expect(JSON.stringify(r)).not.toMatch(/Léa|Test2|Exemple|in-|q-/);
  });
});
