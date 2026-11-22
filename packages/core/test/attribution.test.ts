import { describe, expect, it } from 'vitest';
import {
  ATTRIBUTION_RULES,
  Acces,
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
  const { chaine, store, fiche, reception } = createCaptation(db, journal, { now, withQualification: false });
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

  it('[R25] un message de plus ne repousse jamais le délai de rappel en cours', async () => {
    const t = await setup();
    await t.attribution.addZone(t.network.id, t.alex.id, 'Talant');
    await t.attribution.addZone(t.network.id, t.sam.id, 'Talant');
    const q = await t.contact('zoe', 'Je souhaite vendre ma maison à Talant.');
    const first = (await t.attribution.attribute(q))!;
    t.setClock(TUESDAY_10H + 23 * HOUR);
    const q2 = await t.contact('zoe', 'Avez-vous bien reçu mon message ?');
    const second = (await t.attribution.attribute(q2))!;
    expect(second).toMatchObject({ agent_id: first.agent_id, reason: 'already_followed' });
    expect(await t.attribution.reassignOverdue(t.network.id)).toEqual([]);
    t.setClock(TUESDAY_10H + 24 * HOUR);
    const made = await t.attribution.reassignOverdue(t.network.id);
    expect(made).toHaveLength(1);
    expect(made[0]).toMatchObject({ reason: 'reassigned', replaces_id: second.id });
    expect(made[0]!.agent_id).not.toBe(first.agent_id);
    expect(made[0]!.agent_id).not.toBeNull();
    // Une seule réattribution pour ces deux messages, même relancée.
    expect(await t.attribution.reassignOverdue(t.network.id)).toEqual([]);
  });

  it('[R25] un contact devenu chaud raccourcit le délai, le plus court des délais en cours fait foi', async () => {
    const t = await setup();
    await t.attribution.addZone(t.network.id, t.alex.id, 'Talant');
    await t.attribution.addZone(t.network.id, t.sam.id, 'Talant');
    const q = await t.contact('zoe', 'Je souhaite vendre ma maison à Talant.');
    await t.attribution.attribute(q);
    t.setClock(TUESDAY_10H + HOUR);
    const q2 = await t.contact('zoe', 'Encore un message pour ma maison à Talant.');
    await t.db.run("UPDATE contact_scores SET temperature = 'hot' WHERE qualification_id = ?", [q2]);
    expect(await t.attribution.attribute(q2)).toMatchObject({ callback_hours: 8 });
    t.setClock(TUESDAY_10H + 8 * HOUR);
    expect(await t.attribution.reassignOverdue(t.network.id)).toEqual([]);
    t.setClock(TUESDAY_10H + 9 * HOUR);
    expect(await t.attribution.reassignOverdue(t.network.id)).toHaveLength(1);
  });

  it('[R25] un rappel humain clôt le délai ; le message suivant en ouvre un nouveau, à compter de lui', async () => {
    const t = await setup();
    await t.attribution.addZone(t.network.id, t.alex.id, 'Talant');
    await t.attribution.addZone(t.network.id, t.sam.id, 'Talant');
    const q = await t.contact('zoe', 'Je souhaite vendre ma maison à Talant.');
    const first = (await t.attribution.attribute(q))!;
    const person = await t.personOf(q);
    await t.store.recordMessage({
      networkId: t.network.id,
      agentId: first.agent_id,
      personId: person,
      channel: 'phone',
      direction: 'out',
      authorKind: 'agent',
      body: 'Appel passé.',
      occurredAt: new Date(TUESDAY_10H + HOUR),
    });
    t.setClock(TUESDAY_10H + 20 * HOUR);
    await t.attribution.attribute(await t.contact('zoe', 'Une question de plus sur ma maison.'));
    // Le premier délai est clos par l'appel : 24 heures comptent depuis le nouveau message.
    t.setClock(TUESDAY_10H + 30 * HOUR);
    expect(await t.attribution.reassignOverdue(t.network.id)).toEqual([]);
    t.setClock(TUESDAY_10H + 44 * HOUR);
    expect(await t.attribution.reassignOverdue(t.network.id)).toHaveLength(1);
  });

  it('[R25] après un nouveau message, jamais un agent déjà essayé, et la commune d’un message d’avant reste valable', async () => {
    const t = await setup();
    await t.attribution.addZone(t.network.id, t.alex.id, 'Talant');
    await t.attribution.addZone(t.network.id, t.sam.id, 'Talant');
    const q = await t.contact('zoe', 'Je souhaite vendre ma maison à Talant.');
    await t.attribution.attribute(q);
    t.setClock(TUESDAY_10H + 24 * HOUR);
    const [second] = await t.attribution.reassignOverdue(t.network.id);
    // Le nouveau message ne dit pas la commune, et il arrive chez le deuxième agent.
    t.setClock(TUESDAY_10H + 25 * HOUR);
    const q3 = await t.contact('zoe', 'Personne ne m’a rappelée.');
    const third = (await t.attribution.attribute(q3))!;
    expect(third.agent_id).toBe(second!.agent_id);
    t.setClock(TUESDAY_10H + 48 * HOUR);
    // Deux agents couvrent la commune et les deux ont été essayés : la direction, jamais un retour au premier.
    const [fourth] = await t.attribution.reassignOverdue(t.network.id);
    expect(fourth).toMatchObject({ agent_id: null, replaces_id: third.id });

    // La commune d'un message d'avant sert : un agent nouveau sur la zone reçoit le contact, pas la direction.
    const u = await setup();
    await u.attribution.addZone(u.network.id, u.alex.id, 'Talant');
    await u.attribution.addZone(u.network.id, u.sam.id, 'Talant');
    await u.attribution.attribute(await u.contact('zoe', 'Je souhaite vendre ma maison à Talant.'));
    u.setClock(TUESDAY_10H + 23 * HOUR);
    await u.attribution.attribute(await u.contact('zoe', 'Avez-vous reçu mon message ?'));
    u.setClock(TUESDAY_10H + 24 * HOUR);
    const [next] = await u.attribution.reassignOverdue(u.network.id);
    expect(next!.agent_id).not.toBeNull();
  });

  it('attribution et passage de la fiche : tout ou rien, et relançable après une coupure', async () => {
    const t = await setup();
    await t.attribution.addZone(t.network.id, t.alex.id, 'Talant');
    const q = await t.contact('zoe', 'Je souhaite vendre ma maison à Talant.');
    const person = await t.personOf(q);
    await t.db.exec("CREATE TRIGGER coupure BEFORE UPDATE OF agent_id ON persons BEGIN SELECT RAISE(ABORT, 'coupure'); END;");
    await expect(t.attribution.attribute(q)).rejects.toThrow();
    expect(await t.db.first('SELECT id FROM attributions WHERE qualification_id = ?', [q])).toBeNull();
    await t.db.exec('DROP TRIGGER coupure');
    expect(await t.attribution.attribute(q)).toMatchObject({ agent_id: t.alex.id, reason: 'zone' });
    expect((await t.store.getPerson(person))!.agent_id).toBe(t.alex.id);
    expect((await t.journal.all()).filter((e) => e.type === 'attribution')).toHaveLength(1);
  });

  it('une réattribution coupée en plein passage est reprise en entier au passage suivant', async () => {
    const t = await setup();
    await t.attribution.addZone(t.network.id, t.alex.id, 'Talant');
    await t.attribution.addZone(t.network.id, t.sam.id, 'Talant');
    const q = await t.contact('zoe', 'Je souhaite vendre ma maison à Talant.');
    const first = (await t.attribution.attribute(q))!;
    t.setClock(TUESDAY_10H + 24 * HOUR);
    await t.db.exec("CREATE TRIGGER coupure BEFORE UPDATE OF agent_id ON persons BEGIN SELECT RAISE(ABORT, 'coupure'); END;");
    await expect(t.attribution.reassignOverdue(t.network.id)).rejects.toThrow();
    expect(await t.db.first('SELECT id FROM attributions WHERE replaces_id = ?', [first.id])).toBeNull();
    await t.db.exec('DROP TRIGGER coupure');
    const [next] = await t.attribution.reassignOverdue(t.network.id);
    expect((await t.store.getPerson(await t.personOf(q)))!.agent_id).toBe(next!.agent_id);
  });

  it('[R16] le nouvel agent ouvre une fiche réunie qui portait un agent parti, par attribution comme par réattribution', async () => {
    const t = await setup();
    await t.attribution.addZone(t.network.id, t.sam.id, 'Talant');
    const parti = await t.store.createPerson({ networkId: t.network.id, agentId: t.alex.id, firstName: 'Zoé' });
    await t.db.run("UPDATE agents SET status = 'left' WHERE id = ?", [t.alex.id]);
    const q = await t.contact('zoe', 'Je souhaite vendre ma maison à Talant.');
    const fresh = await t.personOf(q);
    await t.fiche.merge({ survivorId: fresh, mergedId: parti.id, reason: 'même personne' });
    expect(await t.attribution.attribute(q)).toMatchObject({ agent_id: t.sam.id, reason: 'zone' });
    expect((await t.store.getPerson(fresh))!.agent_id).toBe(t.sam.id);
    expect((await t.store.getPerson(parti.id))!.agent_id).toBe(t.sam.id);
    const acces = new Acces(t.db, t.store, t.fiche, t.journal);
    const read = await acces.readFiche({ role: 'agent', userId: t.sam.id, networkId: t.network.id }, fresh);
    expect(read).toMatchObject({ ok: true, view: 'full' });

    // Un agent en activité sur une fiche, un agent parti sur l'autre : l'agent en activité garde, et ouvre.
    const u = await setup();
    await u.attribution.addZone(u.network.id, u.lou.id, 'Talant');
    const suivie = await u.store.createPerson({ networkId: u.network.id, agentId: u.sam.id, firstName: 'Zoé' });
    const ancienne = await u.store.createPerson({ networkId: u.network.id, agentId: u.sam.id, firstName: 'Zoé' });
    await u.fiche.merge({ survivorId: suivie.id, mergedId: ancienne.id, reason: 'même personne' });
    const qu = await u.contact('zoe', 'Je souhaite vendre ma maison à Talant.');
    await u.fiche.merge({ survivorId: suivie.id, mergedId: await u.personOf(qu), reason: 'même personne' });
    // La fusion refuse deux agents : l'écart vient d'une fiche passée à un agent, parti depuis.
    await u.db.run('UPDATE persons SET agent_id = ? WHERE id = ?', [u.alex.id, ancienne.id]);
    await u.db.run("UPDATE agents SET status = 'left' WHERE id = ?", [u.alex.id]);
    expect(await u.attribution.attribute(qu)).toMatchObject({ agent_id: u.sam.id, reason: 'already_followed' });
    expect((await u.store.getPerson(ancienne.id))!.agent_id).toBe(u.sam.id);
    const acces2 = new Acces(u.db, u.store, u.fiche, u.journal);
    expect(await acces2.readFiche({ role: 'agent', userId: u.sam.id, networkId: u.network.id }, suivie.id)).toMatchObject({ ok: true, view: 'full' });
  });

  it('[R25] un message reçu après le passage à la direction ne revient pas à l’agent qui n’a pas rappelé', async () => {
    const t = await setup();
    await t.attribution.addZone(t.network.id, t.alex.id, 'Talant');
    await t.attribution.attribute(await t.contact('zoe', 'Je souhaite vendre ma maison à Talant.'));
    t.setClock(TUESDAY_10H + 24 * HOUR);
    const [direction] = await t.attribution.reassignOverdue(t.network.id);
    expect(direction!.agent_id).toBeNull();
    t.setClock(TUESDAY_10H + 25 * HOUR);
    const again = await t.contact('zoe', 'Je souhaite toujours vendre ma maison à Talant.');
    expect(await t.attribution.attribute(again)).toMatchObject({ agent_id: null, reason: 'no_zone' });
    expect((await t.store.getPerson(await t.personOf(again)))!.agent_id).toBeNull();
  });

  it('[R25] l’agent parti, un message sans commune va à l’autre agent de la commune d’avant, pas à la direction', async () => {
    const t = await setup();
    await t.attribution.addZone(t.network.id, t.alex.id, 'Talant');
    await t.attribution.addZone(t.network.id, t.sam.id, 'Talant');
    const first = (await t.attribution.attribute(await t.contact('zoe', 'Je souhaite vendre ma maison à Talant.')))!;
    await t.db.run("UPDATE agents SET status = 'left' WHERE id = ?", [first.agent_id]);
    t.setClock(TUESDAY_10H + 2 * HOUR);
    const next = (await t.attribution.attribute(await t.contact('zoe', 'Avez-vous reçu mon message ?')))!;
    expect(next.reason).toBe('zone');
    expect(next.agent_id).not.toBeNull();
    expect(next.agent_id).not.toBe(first.agent_id);
  });

  it('[R25] un message tiède n’allonge pas le délai d’un contact chaud chez l’agent suivant', async () => {
    const t = await setup();
    await t.attribution.addZone(t.network.id, t.alex.id, 'Talant');
    await t.attribution.addZone(t.network.id, t.sam.id, 'Talant');
    const hot = await t.contact('zoe', 'Je souhaite vendre ma maison à Talant.');
    await t.db.run("UPDATE contact_scores SET temperature = 'hot' WHERE qualification_id = ?", [hot]);
    await t.attribution.attribute(hot);
    t.setClock(TUESDAY_10H + HOUR);
    const cold = await t.contact('zoe', 'Une précision sur ma maison.');
    await t.db.run("UPDATE contact_scores SET temperature = 'cold' WHERE qualification_id = ?", [cold]);
    expect(await t.attribution.attribute(cold)).toMatchObject({ callback_hours: 24 });
    t.setClock(TUESDAY_10H + 8 * HOUR);
    const [next] = await t.attribution.reassignOverdue(t.network.id);
    expect(next).toMatchObject({ reason: 'reassigned', callback_hours: 8 });
  });

  it('[R16] à la réattribution, une fiche réunie qui porte un agent parti passe au nouvel agent, qui l’ouvre', async () => {
    const t = await setup();
    await t.attribution.addZone(t.network.id, t.alex.id, 'Talant');
    await t.attribution.addZone(t.network.id, t.sam.id, 'Talant');
    const q = await t.contact('zoe', 'Je souhaite vendre ma maison à Talant.');
    const first = (await t.attribution.attribute(q))!;
    const fresh = await t.personOf(q);
    const ancienne = await t.store.createPerson({ networkId: t.network.id, agentId: first.agent_id, firstName: 'Zoé' });
    await t.fiche.merge({ survivorId: fresh, mergedId: ancienne.id, reason: 'même personne' });
    // La fusion refuse deux agents : l'écart vient d'une fiche passée à un agent, parti depuis.
    await t.db.run('UPDATE persons SET agent_id = ? WHERE id = ?', [t.lou.id, ancienne.id]);
    await t.db.run("UPDATE agents SET status = 'left' WHERE id = ?", [t.lou.id]);
    t.setClock(TUESDAY_10H + 24 * HOUR);
    const [next] = await t.attribution.reassignOverdue(t.network.id);
    expect((await t.store.getPerson(ancienne.id))!.agent_id).toBe(next!.agent_id);
    const acces = new Acces(t.db, t.store, t.fiche, t.journal, { now: () => new Date(TUESDAY_10H + 24 * HOUR) });
    expect(await acces.readFiche({ role: 'agent', userId: next!.agent_id!, networkId: t.network.id }, fresh)).toMatchObject({ ok: true, view: 'full' });
  });
});

describeWithSqlite('AU040 · un agent absent n’est jamais candidat à l’attribution', () => {
  /** Déclare une absence inventée de `agentId`, reprise par `coverId`, comme le fait M14 (J09). */
  const absent = async (t: Awaited<ReturnType<typeof setup>>, agentId: string, coverId: string, from: string, until: string): Promise<string> => {
    const [a, b] = [agentId, coverId].sort() as [string, string];
    const pair = `pair-${agentId}-${from}`;
    await t.db.run('INSERT INTO agent_pairs (id, network_id, agent_a, agent_b, cover_share_pct, written_by, created_at) VALUES (?, ?, ?, ?, 50, ?, ?)', [
      pair,
      t.network.id,
      a,
      b,
      'direction:test',
      '2026-12-01T08:00:00.000Z',
    ]);
    const id = `absence-${agentId}-${from}`;
    await t.db.run(
      'INSERT INTO agent_absences (id, network_id, agent_id, pair_id, cover_agent_id, from_day, until_day, declared_by, declared_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [id, t.network.id, agentId, pair, coverId, from, until, 'direction:test', '2026-12-01T08:00:00.000Z'],
    );
    return id;
  };
  const skippedOf = (t: Awaited<ReturnType<typeof setup>>, attributionId: string) =>
    t.db.all<{ absent_agent_id: string; absence_id: string; cover_agent_id: string | null }>(
      'SELECT absent_agent_id, absence_id, cover_agent_id FROM attribution_absences WHERE attribution_id = ? ORDER BY absent_agent_id',
      [attributionId],
    );

  it('[R680] constat reproduit : le seul agent de la commune, absent, ne reçoit pas le contact ; son binôme le reçoit', async () => {
    const t = await setup();
    await t.attribution.addZone(t.network.id, t.alex.id, 'Talant');
    const absence = await absent(t, t.alex.id, t.sam.id, '2026-12-07', '2026-12-10');
    const q = await t.contact('zoe', 'Je souhaite vendre ma maison à Talant.');
    const a = (await t.attribution.attribute(q))!;
    expect(a).toMatchObject({ agent_id: t.sam.id, reason: 'zone' });
    expect(await skippedOf(t, a.id)).toEqual([{ absent_agent_id: t.alex.id, absence_id: absence, cover_agent_id: t.sam.id }]);
    // Un nouveau contact : sa fiche va à qui le reçoit.
    expect((await t.store.getPerson(await t.personOf(q)))!.agent_id).toBe(t.sam.id);
    const entry = (await t.journal.all()).find((e) => e.type === 'attribution')!;
    expect(entry.data).toMatchObject({ absentSkipped: 1, byCover: true });
    expect(JSON.stringify(entry)).not.toMatch(/Talant|zoe|example|Alex|Sam/);
  });

  it('[R680] un agent présent de la commune passe avant le binôme d’un absent, par le tirage fixe', async () => {
    const t = await setup();
    await t.attribution.addZone(t.network.id, t.alex.id, 'Dijon');
    await t.attribution.addZone(t.network.id, t.sam.id, 'Dijon');
    await absent(t, t.alex.id, t.lou.id, '2026-12-08', '2026-12-08');
    for (const who of ['zoe', 'max', 'ines', 'leo', 'eva', 'tom']) {
      const a = (await t.attribution.attribute(await t.contact(who, 'Je souhaite vendre mon appartement à Dijon.')))!;
      expect(a).toMatchObject({ agent_id: t.sam.id, reason: 'zone' });
      expect(await skippedOf(t, a.id)).toEqual([expect.objectContaining({ absent_agent_id: t.alex.id, cover_agent_id: null })]);
    }
  });

  it('[R680] tous absents et leurs binômes absents ou partis : la direction, jamais l’absent', async () => {
    const t = await setup();
    await t.attribution.addZone(t.network.id, t.alex.id, 'Talant');
    await absent(t, t.alex.id, t.sam.id, '2026-12-08', '2026-12-09');
    await absent(t, t.sam.id, t.lou.id, '2026-12-08', '2026-12-09');
    const a = (await t.attribution.attribute(await t.contact('zoe', 'Je souhaite vendre ma maison à Talant.')))!;
    expect(a).toMatchObject({ agent_id: null, reason: 'no_zone' });
    expect(await skippedOf(t, a.id)).toEqual([expect.objectContaining({ absent_agent_id: t.alex.id, cover_agent_id: null })]);
    const u = await setup();
    await u.attribution.addZone(u.network.id, u.alex.id, 'Talant');
    await absent(u, u.alex.id, u.sam.id, '2026-12-08', '2026-12-09');
    await u.db.run("UPDATE agents SET status = 'left' WHERE id = ?", [u.sam.id]);
    expect(await u.attribution.attribute(await u.contact('zoe', 'Je souhaite vendre ma maison à Talant.'))).toMatchObject({ agent_id: null });
  });

  it('[R680] un client suivi par un absent va au binôme de l’absence, et sa fiche reste à l’absent ; binôme absent : la direction', async () => {
    const t = await setup();
    await t.attribution.addZone(t.network.id, t.lou.id, 'Talant');
    const zoe = await t.store.createPerson({ networkId: t.network.id, agentId: t.alex.id, firstName: 'Zoé' });
    await absent(t, t.alex.id, t.sam.id, '2026-12-08', '2026-12-12');
    const qz = await t.contact('zoe', 'Je souhaite vendre ma maison à Talant.');
    await t.fiche.merge({ survivorId: await t.personOf(qz), mergedId: zoe.id, reason: 'même personne' });
    const a = (await t.attribution.attribute(qz))!;
    expect(a).toMatchObject({ agent_id: t.sam.id, reason: 'already_followed' });
    expect((await t.store.getPerson(zoe.id))!.agent_id).toBe(t.alex.id);
    expect((await skippedOf(t, a.id))[0]).toMatchObject({ absent_agent_id: t.alex.id, cover_agent_id: t.sam.id });

    const u = await setup();
    const max = await u.store.createPerson({ networkId: u.network.id, agentId: u.alex.id, firstName: 'Max' });
    await absent(u, u.alex.id, u.sam.id, '2026-12-08', '2026-12-12');
    await absent(u, u.sam.id, u.lou.id, '2026-12-08', '2026-12-12');
    const qm = await u.contact('max', 'Je souhaite vendre ma maison à Talant.');
    await u.fiche.merge({ survivorId: await u.personOf(qm), mergedId: max.id, reason: 'même personne' });
    const b = (await u.attribution.attribute(qm))!;
    expect(b).toMatchObject({ agent_id: null, reason: 'already_followed' });
    expect((await u.store.getPerson(max.id))!.agent_id).toBe(u.alex.id);
  });

  it('[R680] une absence passée ou à venir ne retire rien : l’agent reste candidat hors de ses jours d’absence', async () => {
    const t = await setup();
    await t.attribution.addZone(t.network.id, t.alex.id, 'Talant');
    await absent(t, t.alex.id, t.sam.id, '2026-12-09', '2026-12-11');
    await absent(t, t.alex.id, t.lou.id, '2026-12-01', '2026-12-07');
    const a = (await t.attribution.attribute(await t.contact('zoe', 'Je souhaite vendre ma maison à Talant.')))!;
    expect(a).toMatchObject({ agent_id: t.alex.id, reason: 'zone' });
    expect(await skippedOf(t, a.id)).toEqual([]);
    // Le premier jour d'absence, heure de Paris : 00 h 30 le 9 décembre, c'est encore le 8 à Londres.
    t.setClock(Date.parse('2026-12-08T23:30:00.000Z'));
    expect(await t.attribution.attribute(await t.contact('max', 'Je souhaite vendre ma maison à Talant.'))).toMatchObject({ agent_id: t.sam.id });
    t.setClock(Date.parse('2026-12-11T23:30:00.000Z'));
    expect(await t.attribution.attribute(await t.contact('eva', 'Je souhaite vendre ma maison à Talant.'))).toMatchObject({ agent_id: t.alex.id });
  });

  it('[R680] un contact en attente chez un agent devenu absent est réattribué dès le passage, sans attendre le délai, une seule fois', async () => {
    const t = await setup();
    await t.attribution.addZone(t.network.id, t.alex.id, 'Talant');
    await t.attribution.addZone(t.network.id, t.lou.id, 'Dijon');
    const q = await t.contact('zoe', 'Je souhaite vendre ma maison à Talant.');
    const first = (await t.attribution.attribute(q))!;
    expect(first.agent_id).toBe(t.alex.id);
    // Rien à faire tant qu'il est présent et dans le délai.
    expect(await t.attribution.reassignOverdue(t.network.id)).toEqual([]);
    await absent(t, t.alex.id, t.sam.id, '2026-12-08', '2026-12-09');
    t.setClock(TUESDAY_10H + HOUR);
    const [next, ...rest] = await t.attribution.reassignOverdue(t.network.id);
    expect(rest).toEqual([]);
    expect(next).toMatchObject({ agent_id: t.sam.id, reason: 'reassigned', replaces_id: first.id });
    expect(await skippedOf(t, next!.id)).toEqual([expect.objectContaining({ absent_agent_id: t.alex.id, cover_agent_id: t.sam.id })]);
    // La fiche reste à l'absent ; un second passage ne refait rien.
    expect((await t.store.getPerson(await t.personOf(q)))!.agent_id).toBe(t.alex.id);
    expect(await t.attribution.reassignOverdue(t.network.id)).toEqual([]);
    const entry = (await t.journal.all()).find((e) => e.type === 'attribution.reattribuee')!;
    expect(entry.data).toMatchObject({ absentSkipped: 1, byCover: true });
  });

  it('[R680] chez un absent qui a déjà rappelé, rien n’est réattribué', async () => {
    const t = await setup();
    await t.attribution.addZone(t.network.id, t.alex.id, 'Talant');
    const q = await t.contact('zoe', 'Je souhaite vendre ma maison à Talant.');
    const a = (await t.attribution.attribute(q))!;
    await t.store.recordMessage({
      networkId: t.network.id,
      agentId: a.agent_id,
      personId: await t.personOf(q),
      channel: 'phone',
      direction: 'out',
      authorKind: 'agent',
      body: 'Appel passé.',
      occurredAt: new Date(TUESDAY_10H + HOUR / 2),
    });
    await absent(t, t.alex.id, t.sam.id, '2026-12-08', '2026-12-09');
    t.setClock(TUESDAY_10H + HOUR);
    expect(await t.attribution.reassignOverdue(t.network.id)).toEqual([]);
  });

  it('[R680] un contact en attente chez un absent dont le binôme est absent va à la direction, jamais à un autre agent de la commune', async () => {
    const t = await setup();
    await t.attribution.addZone(t.network.id, t.alex.id, 'Talant');
    const q = await t.contact('zoe', 'Je souhaite vendre ma maison à Talant.');
    const first = (await t.attribution.attribute(q))!;
    expect(first.agent_id).toBe(t.alex.id);
    await t.attribution.addZone(t.network.id, t.lou.id, 'Talant');
    await absent(t, t.alex.id, t.sam.id, '2026-12-08', '2026-12-09');
    await absent(t, t.sam.id, t.alex.id, '2026-12-08', '2026-12-09');
    t.setClock(TUESDAY_10H + HOUR);
    const [next] = await t.attribution.reassignOverdue(t.network.id);
    expect(next).toMatchObject({ agent_id: null, reason: 'reassigned', replaces_id: first.id });
    expect(await skippedOf(t, next!.id)).toEqual([expect.objectContaining({ absent_agent_id: t.alex.id, cover_agent_id: null })]);
    expect((await t.store.getPerson(await t.personOf(q)))!.agent_id).toBe(t.alex.id);
  });

  it('les règles publiées disent le sort d’un agent absent', () => {
    expect(ATTRIBUTION_RULES.join(' ')).toMatch(/absent/);
  });
});
