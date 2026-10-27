import { describe, expect, it } from 'vitest';
import {
  ATTRIBUTION_RULES,
  Attribution,
  Qualification,
  ReconnaissanceBien,
  SqlJournalStore,
  applyMigrations,
  chooseAgent,
  createCaptation,
  fromSyncSqlite,
  type SqlDatabase,
} from '../src/index.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

const TUESDAY_10H = Date.parse('2026-12-08T09:00:00.000Z');
const HOUR = 3_600_000;

async function setup() {
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  let clock = TUESDAY_10H;
  const now = (): Date => new Date(clock);
  const journal = new SqlJournalStore(db);
  const { chaine, store, fiche, reception } = createCaptation(db, journal, { now });
  const qualification = new Qualification(db, store, fiche, reception, new ReconnaissanceBien(db), journal, { now });
  const attribution = new Attribution(db, fiche, journal, { now });
  const network = await store.createNetwork('Réseau test');
  const alex = await store.createAgent({ networkId: network.id, firstName: 'Alex', lastName: 'Agent' });
  const sam = await store.createAgent({ networkId: network.id, firstName: 'Sam', lastName: 'Agent' });
  const lou = await store.createAgent({ networkId: network.id, firstName: 'Lou', lastName: 'Agent' });
  let seq = 0;
  /** Un formulaire inventé de la personne `who`, qualifié ; rend l'identifiant de la qualification. */
  const contact = async (who: string, message: string): Promise<string> => {
    seq += 1;
    await chaine.receive(network.id, 'site_form', { submissionId: `f-${seq}`, email: `${who}@example.test`, message });
    const row = await db.first<{ id: string }>('SELECT id FROM inbound_messages ORDER BY rowid DESC LIMIT 1');
    return (await qualification.qualify(row!.id))!.id;
  };
  const personOf = async (qualificationId: string) =>
    (await db.first<{ person_id: string }>('SELECT person_id FROM qualifications WHERE id = ?', [qualificationId]))!.person_id;
  return { db, store, fiche, journal, attribution, network, alex, sam, lou, contact, personOf, setClock: (t: number) => (clock = t) };
}

describe('Q03 · tirage fixe', () => {
  it('[R25] même fiche, même agent, quel que soit l’ordre des agents ; jamais un agent déjà essayé', () => {
    const agents = ['a', 'b', 'c', 'd'];
    for (const person of ['p1', 'p2', 'p3', 'p4', 'p5']) {
      const chosen = chooseAgent(person, agents);
      expect(chooseAgent(person, [...agents].reverse())).toBe(chosen);
      expect(chooseAgent(person, ['c', 'a', 'd', 'b'])).toBe(chosen);
      expect(chooseAgent(person, agents, new Set([chosen!]))).not.toBe(chosen);
    }
    expect(chooseAgent('p1', ['a'], new Set(['a']))).toBeNull();
    expect(chooseAgent('p1', [])).toBeNull();
  });

  it('les règles sont publiées, lisibles, et disent qu’aucune IA n’attribue', () => {
    expect(ATTRIBUTION_RULES.length).toBeGreaterThan(3);
    expect(ATTRIBUTION_RULES.join(' ')).toMatch(/Aucune IA/);
  });
});

describeWithSqlite('Q03 · attribution à l’agent de la commune', () => {
  it('[R14] [R25] le contact va à l’agent de sa commune, la fiche passe à lui, au journal sans donnée', async () => {
    const t = await setup();
    await t.attribution.addZone(t.network.id, t.alex.id, 'Talant');
    await t.attribution.addZone(t.network.id, t.sam.id, 'Dijon');
    const q = await t.contact('zoe', 'Je souhaite vendre ma maison à Talant.');
    const a = await t.attribution.attribute(q);
    expect(a).toMatchObject({ agent_id: t.alex.id, reason: 'zone', callback_hours: 24 });
    expect(await t.store.getPerson(await t.personOf(q))).toMatchObject({ agent_id: t.alex.id });
    // Une seule attribution par qualification [R18].
    expect((await t.attribution.attribute(q))!.id).toBe(a!.id);
    const entries = (await t.journal.all()).filter((e) => e.type.startsWith('attribution'));
    expect(entries).toHaveLength(1);
    expect(JSON.stringify(entries)).not.toMatch(/Talant|zoe|example/);
  });

  it('un contact chaud a le délai du jour même', async () => {
    const t = await setup();
    await t.attribution.addZone(t.network.id, t.alex.id, 'Talant');
    expect(await t.attribution.attribute(await t.contact('a', 'Je souhaite vendre ma maison à Talant rapidement.'))).toMatchObject({ callback_hours: 8 });
  });

  it('[R25] commune sans agent : à la direction, jamais au hasard ; un agent parti ne reçoit plus rien', async () => {
    const t = await setup();
    await t.attribution.addZone(t.network.id, t.alex.id, 'Beaune');
    expect(await t.attribution.attribute(await t.contact('a', 'Je souhaite vendre ma maison à Talant.'))).toMatchObject({ agent_id: null, reason: 'no_zone' });
    expect(await t.attribution.attribute(await t.contact('b', 'Je souhaite vendre, sans dire où.'))).toMatchObject({ agent_id: null, reason: 'no_zone' });
    await t.db.run("UPDATE agents SET status = 'left' WHERE id = ?", [t.alex.id]);
    expect(await t.attribution.attribute(await t.contact('c', 'Je souhaite vendre ma maison à Beaune.'))).toMatchObject({ agent_id: null, reason: 'no_zone' });
  });

  it('[R25] une personne exclue ou qui a dit stop n’est jamais attribuée', async () => {
    const t = await setup();
    await t.attribution.addZone(t.network.id, t.alex.id, 'Talant');
    const q = await t.contact('zoe', 'Je souhaite vendre ma maison à Talant.');
    const person = await t.personOf(q);
    await t.store.addExclusion({ networkId: t.network.id, personId: person, reason: 'network_list', notedAt: new Date(TUESDAY_10H - HOUR) });
    expect(await t.attribution.attribute(q)).toBeNull();
    expect(await t.db.all('SELECT * FROM attributions')).toEqual([]);
    expect(await t.store.getPerson(person)).toMatchObject({ agent_id: null });
    const refused = (await t.journal.all()).filter((e) => e.type === 'attribution.refusee');
    expect(refused.map((e) => (e.data as { rule: string }).rule)).toEqual(['R25']);
  });

  it('un client déjà suivi reste à son agent ; un indésirable n’est attribué à personne, un partenaire va à la direction', async () => {
    const t = await setup();
    await t.attribution.addZone(t.network.id, t.alex.id, 'Talant');
    await t.attribution.addZone(t.network.id, t.sam.id, 'Dijon');
    const first = await t.contact('zoe', 'Je souhaite vendre ma maison à Talant.');
    await t.attribution.attribute(first);
    const second = await t.contact('zoe', 'Je cherche aussi un appartement à Dijon.');
    expect(await t.attribution.attribute(second)).toMatchObject({ agent_id: t.alex.id, reason: 'already_followed' });
    expect(await t.attribution.attribute(await t.contact('spam', 'Boostez votre référencement SEO, offre exclusive.'))).toBeNull();
    expect(await t.attribution.attribute(await t.contact('pro', 'Je suis courtier et je vous propose un partenariat à Talant.'))).toMatchObject({ agent_id: null, reason: 'no_zone' });
  });

  it('[R25] une fiche réunie reste à l’agent qui suivait l’une de ses fiches, et la réattribution les déplace ensemble', async () => {
    const t = await setup();
    for (const agent of [t.alex, t.sam, t.lou]) await t.attribution.addZone(t.network.id, agent.id, 'Dijon');
    const followed = await t.store.createPerson({ networkId: t.network.id, agentId: t.alex.id, firstName: 'Zoé' });
    const q = await t.contact('zoe', 'Je souhaite vendre mon appartement à Dijon.');
    const fresh = await t.personOf(q);
    await t.fiche.merge({ survivorId: fresh, mergedId: followed.id, reason: 'même personne' });
    const a = (await t.attribution.attribute(q))!;
    expect(a).toMatchObject({ agent_id: t.alex.id, reason: 'already_followed' });
    // La fiche gardée ne prend pas un autre agent que celui de la fiche réunie.
    expect((await t.store.getPerson(fresh))!.agent_id).toBeNull();
    t.setClock(TUESDAY_10H + 25 * HOUR);
    const [next] = await t.attribution.reassignOverdue(t.network.id);
    expect(next!.agent_id).not.toBe(t.alex.id);
    expect((await t.store.getPerson(followed.id))!.agent_id).toBe(next!.agent_id);
  });

  it('[R25] même contact, même agent, quel que soit l’ordre d’arrivée des contacts', async () => {
    const results: string[][] = [];
    for (const order of [
      ['a', 'b', 'c', 'd'],
      ['d', 'c', 'b', 'a'],
    ]) {
      const t = await setup();
      // Les identifiants des fiches sont tirés au hasard : on compare donc le choix de chaque fiche à son tirage fixe.
      for (const agent of [t.alex, t.sam, t.lou]) await t.attribution.addZone(t.network.id, agent.id, 'Dijon');
      const run: string[] = [];
      for (const who of order) {
        const q = await t.contact(who, 'Je souhaite vendre mon appartement à Dijon.');
        const a = (await t.attribution.attribute(q))!;
        const person = await t.personOf(q);
        expect(a.agent_id).toBe(chooseAgent(person, [t.alex.id, t.sam.id, t.lou.id]));
        run.push(a.reason);
      }
      results.push(run);
    }
    expect(results[0]).toEqual(['zone', 'zone', 'zone', 'zone']);
  });

  it('[R25] non rappelé dans le délai : réattribué une fois par délai, à un autre agent, puis à la direction ; au journal', async () => {
    const t = await setup();
    await t.attribution.addZone(t.network.id, t.alex.id, 'Talant');
    await t.attribution.addZone(t.network.id, t.sam.id, 'Talant');
    const q = await t.contact('zoe', 'Je souhaite vendre ma maison à Talant.');
    const first = (await t.attribution.attribute(q))!;
    const person = await t.personOf(q);

    t.setClock(TUESDAY_10H + 23 * HOUR);
    expect(await t.attribution.reassignOverdue(t.network.id)).toEqual([]);
    t.setClock(TUESDAY_10H + 24 * HOUR);
    const [second] = await t.attribution.reassignOverdue(t.network.id);
    expect(second).toMatchObject({ reason: 'reassigned', replaces_id: first.id });
    expect(second!.agent_id).not.toBe(first.agent_id);
    expect(second!.agent_id).not.toBeNull();
    expect(await t.store.getPerson(person)).toMatchObject({ agent_id: second!.agent_id });
    // Une seule fois par délai, même relancé.
    expect(await t.attribution.reassignOverdue(t.network.id)).toEqual([]);

    t.setClock(TUESDAY_10H + 48 * HOUR);
    const [third] = await t.attribution.reassignOverdue(t.network.id);
    expect(third).toMatchObject({ agent_id: null, replaces_id: second!.id });
    t.setClock(TUESDAY_10H + 96 * HOUR);
    expect(await t.attribution.reassignOverdue(t.network.id)).toEqual([]);
    const logged = (await t.journal.all()).filter((e) => e.type === 'attribution.reattribuee');
    expect(logged).toHaveLength(2);
  });

  it('rappelé dans le délai, ou exclu entre-temps : pas de réattribution', async () => {
    const t = await setup();
    await t.attribution.addZone(t.network.id, t.alex.id, 'Talant');
    await t.attribution.addZone(t.network.id, t.sam.id, 'Talant');
    const called = await t.contact('a', 'Je souhaite vendre ma maison à Talant.');
    const a = (await t.attribution.attribute(called))!;
    await t.store.recordMessage({
      networkId: t.network.id,
      agentId: a.agent_id,
      personId: await t.personOf(called),
      channel: 'phone',
      direction: 'out',
      authorKind: 'agent',
      body: 'Appel passé.',
      occurredAt: new Date(TUESDAY_10H + HOUR),
    });
    const stopped = await t.contact('b', 'Je souhaite vendre ma maison à Talant.');
    await t.attribution.attribute(stopped);
    await t.store.addExclusion({ networkId: t.network.id, personId: await t.personOf(stopped), reason: 'stop', notedAt: new Date(TUESDAY_10H + 2 * HOUR) });
    t.setClock(TUESDAY_10H + 30 * HOUR);
    expect(await t.attribution.reassignOverdue(t.network.id)).toEqual([]);
  });

  it('une commune hors de la liste n’est pas une zone ; une zone retirée ne reçoit plus rien', async () => {
    const t = await setup();
    await expect(t.attribution.addZone(t.network.id, t.alex.id, 'Lyon')).rejects.toThrow();
    const zone = await t.attribution.addZone(t.network.id, t.alex.id, 'Talant');
    await t.attribution.endZone(zone);
    expect(await t.attribution.attribute(await t.contact('a', 'Je souhaite vendre ma maison à Talant.'))).toMatchObject({ agent_id: null });
    expect(await t.db.all('SELECT ended_at FROM agent_zones WHERE ended_at IS NOT NULL')).toHaveLength(1);
  });
});
