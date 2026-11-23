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
    // Le premier délai est clos par l'appel : 24 heures comptent depuis le nouveau message, arrivé le mercredi à 6 h,
    // donc à partir de l'ouverture de 8 h [R682].
    t.setClock(TUESDAY_10H + 45 * HOUR);
    expect(await t.attribution.reassignOverdue(t.network.id)).toEqual([]);
    t.setClock(TUESDAY_10H + 46 * HOUR);
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

describe('AU041 · file de secours fixe', () => {
  it('[R681] un agent plein est passé, le suivant dans l’ordre fixe à partir du tiré ; tous pleins : la direction', () => {
    const agents = ['a', 'b', 'c', 'd'];
    for (const person of ['p1', 'p2', 'p3', 'p4', 'p5']) {
      const chosen = chooseAgent(person, agents)!;
      const next = agents[(agents.indexOf(chosen) + 1) % agents.length];
      expect(chooseAgent(person, agents, new Set(), new Set([chosen]))).toBe(next);
      expect(chooseAgent(person, [...agents].reverse(), new Set(), new Set([chosen]))).toBe(next);
      expect(chooseAgent(person, agents, new Set(), new Set(agents))).toBeNull();
    }
  });

  it('[R681] la règle de capacité est publiée avec les autres', () => {
    expect(ATTRIBUTION_RULES.join(' ')).toMatch(/capacité déclarée/);
  });
});

describeWithSqlite('AU041 · capacité déclarée des agents', () => {
  const direction = (networkId: string) => ({ role: 'direction' as const, networkId, userId: 'dir-1' });
  const agentViewer = (networkId: string, id: string) => ({ role: 'agent' as const, networkId, userId: id });

  it('[R681] constat : un agent à capacité nulle ne reçoit plus de nouveau contact ; seul de sa commune, la direction', async () => {
    const t = await setup();
    await t.attribution.addZone(t.network.id, t.alex.id, 'Talant');
    const r = await t.attribution.declareCapacity(agentViewer(t.network.id, t.alex.id), { capacity: 0, reason: 'Congés de fin d’année' });
    expect(r).toMatchObject({ ok: true, value: { agentId: t.alex.id, capacity: 0, version: 1 } });
    const a = await t.attribution.attribute(await t.contact('zoe', 'Je souhaite vendre ma maison à Talant.'));
    expect(a).toMatchObject({ agent_id: null, reason: 'no_zone' });
    expect(await t.db.all('SELECT full_agents FROM attribution_capacity WHERE attribution_id = ?', [a!.id])).toEqual([{ full_agents: 1 }]);
    const entry = (await t.journal.all()).find((e) => e.type === 'attribution');
    expect(entry?.data).toMatchObject({ toDirection: true, fullAgents: 1 });
  });

  it('[R681] le contact qui serait allé à l’agent plein va au suivant de la file, toujours le même', async () => {
    const t = await setup();
    for (const agent of [t.alex, t.sam, t.lou]) await t.attribution.addZone(t.network.id, agent.id, 'Talant');
    const q = await t.contact('zoe', 'Je souhaite vendre ma maison à Talant.');
    const person = await t.personOf(q);
    const ids = [t.alex.id, t.sam.id, t.lou.id];
    const drawn = chooseAgent(person, ids)!;
    await t.attribution.declareCapacity(direction(t.network.id), { agentId: drawn, capacity: 0, reason: 'Arrêt de travail' });
    const a = await t.attribution.attribute(q);
    expect(a!.agent_id).toBe(chooseAgent(person, ids, new Set(), new Set([drawn])));
    expect(a!.agent_id).not.toBe(drawn);
    expect(a!.reason).toBe('zone');
    expect(await t.db.all('SELECT full_agents FROM attribution_capacity')).toEqual([{ full_agents: 1 }]);
  });

  it('[R681] la capacité compte les contacts en attente de rappel ; un rappel libère une place', async () => {
    const t = await setup();
    await t.attribution.addZone(t.network.id, t.alex.id, 'Talant');
    await t.attribution.declareCapacity(direction(t.network.id), { agentId: t.alex.id, capacity: 1, reason: 'Agent à mi-temps' });
    const q1 = await t.contact('a', 'Je souhaite vendre ma maison à Talant.');
    expect(await t.attribution.attribute(q1)).toMatchObject({ agent_id: t.alex.id });
    expect(await t.attribution.waiting(t.network.id, t.alex.id)).toBe(1);
    expect(await t.attribution.attribute(await t.contact('b', 'Je souhaite vendre ma maison à Talant.'))).toMatchObject({ agent_id: null });
    await t.store.recordMessage({
      networkId: t.network.id,
      agentId: t.alex.id,
      personId: await t.personOf(q1),
      channel: 'phone',
      direction: 'out',
      authorKind: 'agent',
      body: 'Appel passé.',
      occurredAt: new Date(TUESDAY_10H + HOUR),
    });
    t.setClock(TUESDAY_10H + 2 * HOUR);
    expect(await t.attribution.waiting(t.network.id, t.alex.id)).toBe(0);
    expect(await t.attribution.attribute(await t.contact('c', 'Je souhaite vendre ma maison à Talant.'))).toMatchObject({ agent_id: t.alex.id });
  });

  it('[R681] deux contacts en même temps ne dépassent jamais la capacité : la base revérifie à l’écriture', async () => {
    const t = await setup();
    await t.attribution.addZone(t.network.id, t.alex.id, 'Talant');
    await t.attribution.declareCapacity(direction(t.network.id), { agentId: t.alex.id, capacity: 1, reason: 'Agent à mi-temps' });
    const q1 = await t.contact('a', 'Je souhaite vendre ma maison à Talant.');
    const q2 = await t.contact('b', 'Je souhaite vendre ma maison à Talant.');
    const rows = await Promise.all([t.attribution.attribute(q1), t.attribution.attribute(q2)]);
    expect(rows.map((r) => r!.agent_id).sort()).toEqual([null, t.alex.id].sort());
    expect(await t.attribution.waiting(t.network.id, t.alex.id)).toBe(1);
    const persons = await t.db.all<{ agent_id: string | null }>('SELECT agent_id FROM persons WHERE id IN (?, ?)', [await t.personOf(q1), await t.personOf(q2)]);
    expect(persons.filter((p) => p.agent_id === t.alex.id)).toHaveLength(1);
  });

  it('[R681] la file de secours va jusqu’au bout même quand plusieurs contacts se disputent les mêmes agents', async () => {
    const t = await setup();
    const extra = [];
    for (const name of ['Noa', 'Eli']) extra.push(await t.store.createAgent({ networkId: t.network.id, firstName: name, lastName: 'Agent' }));
    const agents = [t.alex, t.sam, t.lou, ...extra];
    for (const agent of agents) {
      await t.attribution.addZone(t.network.id, agent.id, 'Talant');
      await t.attribution.declareCapacity(direction(t.network.id), { agentId: agent.id, capacity: 1, reason: 'Une place chacun' });
    }
    const qs = [];
    for (const who of ['a', 'b', 'c', 'd', 'e']) qs.push(await t.contact(who, 'Je souhaite vendre ma maison à Talant.'));
    const rows = await Promise.all(qs.map((q) => t.attribution.attribute(q)));
    expect(rows.map((r) => r!.agent_id).sort()).toEqual(agents.map((a) => a.id).sort());
    for (const agent of agents) expect(await t.attribution.waiting(t.network.id, agent.id)).toBe(1);
  });

  it('[R681] des fiches réunies comptent une fois, et un rappel sur l’une d’elles libère la place', async () => {
    const t = await setup();
    await t.attribution.addZone(t.network.id, t.alex.id, 'Talant');
    const q1 = await t.contact('a', 'Je souhaite vendre ma maison à Talant.');
    const q2 = await t.contact('b', 'Je souhaite vendre ma maison à Talant.');
    await t.attribution.attribute(q1);
    await t.attribution.attribute(q2);
    expect(await t.attribution.waiting(t.network.id, t.alex.id)).toBe(2);
    const p1 = await t.personOf(q1);
    const p2 = await t.personOf(q2);
    await t.fiche.merge({ survivorId: p1, mergedId: p2, reason: 'même personne' });
    expect(await t.attribution.waiting(t.network.id, t.alex.id)).toBe(1);
    await t.store.recordMessage({
      networkId: t.network.id,
      agentId: t.alex.id,
      personId: p2,
      channel: 'phone',
      direction: 'out',
      authorKind: 'agent',
      body: 'Appel passé.',
      occurredAt: new Date(TUESDAY_10H + HOUR),
    });
    t.setClock(TUESDAY_10H + 2 * HOUR);
    expect(await t.attribution.waiting(t.network.id, t.alex.id)).toBe(0);
  });

  it('[R681] deux attributions d’une fiche à la même heure : la capacité n’est jamais dépassée', async () => {
    const t = await setup();
    await t.attribution.addZone(t.network.id, t.alex.id, 'Talant');
    const q1 = await t.contact('a', 'Je souhaite vendre ma maison à Beaune.');
    const q2 = await t.contact('b', 'Je souhaite vendre ma maison à Talant.');
    expect(await t.attribution.attribute(q1)).toMatchObject({ agent_id: null });
    expect(await t.attribution.attribute(q2)).toMatchObject({ agent_id: t.alex.id });
    await t.fiche.merge({ survivorId: await t.personOf(q1), mergedId: await t.personOf(q2), reason: 'même personne' });
    expect((await t.attribution.current(await t.personOf(q1)))!.agent_id).toBe(t.alex.id);
    expect(await t.attribution.waiting(t.network.id, t.alex.id)).toBe(1);
  });

  it('[R681] un client déjà suivi reste à son agent même plein ; la réattribution passe aussi l’agent plein', async () => {
    const t = await setup();
    await t.attribution.addZone(t.network.id, t.alex.id, 'Talant');
    await t.attribution.addZone(t.network.id, t.sam.id, 'Talant');
    const q1 = await t.contact('zoe', 'Je souhaite vendre ma maison à Talant.');
    const first = (await t.attribution.attribute(q1))!;
    const other = first.agent_id === t.alex.id ? t.sam.id : t.alex.id;
    await t.attribution.declareCapacity(direction(t.network.id), { agentId: first.agent_id, capacity: 0, reason: 'Plus de place' });
    await t.attribution.declareCapacity(direction(t.network.id), { agentId: other, capacity: 0, reason: 'Plus de place' });
    // La personne réécrit : elle reste à son agent.
    expect(await t.attribution.attribute(await t.contact('zoe', 'Je relance ma demande.'))).toMatchObject({ agent_id: first.agent_id, reason: 'already_followed' });
    // Non rappelée : l'autre agent est plein, elle va à la direction.
    t.setClock(TUESDAY_10H + 30 * HOUR);
    const made = await t.attribution.reassignOverdue(t.network.id);
    expect(made).toHaveLength(1);
    expect(made[0]).toMatchObject({ agent_id: null, reason: 'reassigned' });
    expect(await t.db.all('SELECT full_agents FROM attribution_capacity WHERE attribution_id = ?', [made[0]!.id])).toEqual([{ full_agents: 1 }]);
  });

  it('[R681] [R16] [R17] déclarer : l’agent pour lui, la direction pour tous ; versions en ajout seul ; lecture cloisonnée', async () => {
    const t = await setup();
    const dir = direction(t.network.id);
    expect(await t.attribution.declareCapacity(agentViewer(t.network.id, t.alex.id), { agentId: t.sam.id, capacity: 3, reason: 'Pour Sam' })).toMatchObject({ ok: false, rule: 'R16' });
    expect(await t.attribution.declareCapacity({ role: 'assistant', networkId: t.network.id, userId: 'x' }, { capacity: 3, reason: 'Essai' })).toMatchObject({ ok: false, rule: 'R16' });
    expect(await t.attribution.declareCapacity(dir, { agentId: t.alex.id, capacity: -1, reason: 'Essai' })).toMatchObject({ ok: false, code: 'bad_capacity' });
    expect(await t.attribution.declareCapacity(dir, { agentId: t.alex.id, capacity: 2.5, reason: 'Essai' })).toMatchObject({ ok: false, code: 'bad_capacity' });
    expect(await t.attribution.declareCapacity(dir, { agentId: t.alex.id, capacity: 201, reason: 'Essai' })).toMatchObject({ ok: false, code: 'bad_capacity' });
    expect(await t.attribution.declareCapacity(dir, { agentId: t.alex.id, capacity: 3 })).toMatchObject({ ok: false, code: 'bad_reason' });
    expect(await t.attribution.declareCapacity(dir, { agentId: t.alex.id, capacity: 3, reason: 'Essai', autre: 1 })).toMatchObject({ ok: false, code: 'unknown_field' });
    expect(await t.attribution.declareCapacity(dir, { agentId: 'inconnu', capacity: 3, reason: 'Essai' })).toMatchObject({ ok: false, code: 'agent_inconnu' });
    expect(await t.attribution.declareCapacity(dir, { agentId: t.alex.id, capacity: 3, reason: 'Rythme normal' })).toMatchObject({ ok: true, value: { version: 1 } });
    expect(await t.attribution.declareCapacity(dir, { agentId: t.alex.id, capacity: 3, reason: 'Rythme normal' })).toMatchObject({ ok: false, code: 'inchangee' });
    expect(await t.attribution.declareCapacity(dir, { agentId: t.alex.id, capacity: null, reason: 'Sans plafond' })).toMatchObject({ ok: true, value: { version: 2, capacity: null } });
    await expect(t.db.run('UPDATE agent_capacities SET capacity = 9')).rejects.toThrow();
    await expect(t.db.run('DELETE FROM agent_capacities')).rejects.toThrow();
    await expect(
      t.db.run("INSERT INTO agent_capacities (network_id, agent_id, version, capacity, reason, decided_by, decided_at) VALUES (?, ?, 3, 1, 'Pour un autre', ?, '2026-12-08')", [
        t.network.id,
        t.alex.id,
        `agent:${t.sam.id}`,
      ]),
    ).rejects.toThrow();
    const mine = await t.attribution.capacities(agentViewer(t.network.id, t.sam.id));
    expect(mine).toMatchObject({ ok: true, value: [{ agentId: t.sam.id, capacity: null, waiting: 0, full: false, version: 0 }] });
    const all = await t.attribution.capacities(dir);
    expect(all.ok && all.value.map((c) => c.agentId).sort()).toEqual([t.alex.id, t.sam.id, t.lou.id].sort());
    expect(await t.attribution.capacities({ role: 'partner', networkId: t.network.id, userId: 'p' })).toMatchObject({ ok: false, rule: 'R16' });
    expect(JSON.stringify((await t.journal.all()).filter((e) => e.type.startsWith('attribution.capacite')))).not.toMatch(/Rythme|plafond de|Essai/);
  });
});

describeWithSqlite('AU040 · un agent absent n’est jamais candidat', () => {
  /** Une absence inventée de `absentId`, reprise par `coverId`, du jour `from` au jour `until` inclus (J09). */
  async function absence(t: Awaited<ReturnType<typeof setup>>, absentId: string, coverId: string, from: string, until: string): Promise<void> {
    const [a, b] = absentId < coverId ? [absentId, coverId] : [coverId, absentId];
    const pairId = `pair-${absentId}-${from}`;
    await t.db.run('INSERT INTO agent_pairs (id, network_id, agent_a, agent_b, cover_share_pct, written_by, created_at) VALUES (?, ?, ?, ?, 30, ?, ?)', [
      pairId,
      t.network.id,
      a,
      b,
      'direction:dir-1',
      new Date(TUESDAY_10H - 48 * HOUR).toISOString(),
    ]);
    await t.db.run(
      'INSERT INTO agent_absences (id, network_id, agent_id, pair_id, cover_agent_id, from_day, until_day, declared_by, declared_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [`abs-${absentId}-${from}`, t.network.id, absentId, pairId, coverId, from, until, 'direction:dir-1', new Date(TUESDAY_10H - 24 * HOUR).toISOString()],
    );
  }

  it('[R680] constat : seul agent de la commune, absent ce jour : le contact va à la direction, au journal sans nom', async () => {
    const t = await setup();
    await t.attribution.addZone(t.network.id, t.alex.id, 'Talant');
    await absence(t, t.alex.id, t.sam.id, '2026-12-07', '2026-12-11');
    const a = await t.attribution.attribute(await t.contact('zoe', 'Je souhaite vendre ma maison à Talant.'));
    expect(a).toMatchObject({ agent_id: null, reason: 'no_zone' });
    const entry = (await t.journal.all()).find((e) => e.type === 'attribution');
    expect(entry?.data).toMatchObject({ toDirection: true, absentAgents: 1 });
    expect(JSON.stringify(entry)).not.toContain(t.alex.id);
    // Aucune place de capacité n'est comptée pour une absence [R681].
    expect(await t.db.all('SELECT * FROM attribution_capacity')).toEqual([]);
  });

  it('[R680] avant et après l’absence, l’agent reçoit de nouveau ses contacts', async () => {
    const t = await setup();
    await t.attribution.addZone(t.network.id, t.alex.id, 'Talant');
    await absence(t, t.alex.id, t.sam.id, '2026-12-09', '2026-12-10');
    expect(await t.attribution.attribute(await t.contact('a', 'Je souhaite vendre ma maison à Talant.'))).toMatchObject({ agent_id: t.alex.id });
    t.setClock(TUESDAY_10H + 24 * HOUR);
    expect(await t.attribution.attribute(await t.contact('b', 'Je souhaite vendre ma maison à Talant.'))).toMatchObject({ agent_id: null });
    t.setClock(TUESDAY_10H + 72 * HOUR);
    expect(await t.attribution.attribute(await t.contact('c', 'Je souhaite vendre ma maison à Talant.'))).toMatchObject({ agent_id: t.alex.id });
  });

  it('[R680] le jour d’absence est celui de Paris : 0 h 30 à Paris est déjà le premier jour', async () => {
    const t = await setup();
    await t.attribution.addZone(t.network.id, t.alex.id, 'Talant');
    await absence(t, t.alex.id, t.sam.id, '2026-12-09', '2026-12-09');
    // 2026-12-08 à 23 h 30 en temps universel : 0 h 30 le 9 décembre à Paris.
    t.setClock(Date.parse('2026-12-08T23:30:00.000Z'));
    expect(await t.attribution.attribute(await t.contact('a', 'Je souhaite vendre ma maison à Talant.'))).toMatchObject({ agent_id: null });
  });

  it('[R680] le contact tiré pour l’absent va au suivant de la file, toujours le même ; le tirage des autres ne bouge pas', async () => {
    const t = await setup();
    for (const agent of [t.alex, t.sam, t.lou]) await t.attribution.addZone(t.network.id, agent.id, 'Talant');
    const q = await t.contact('zoe', 'Je souhaite vendre ma maison à Talant.');
    const person = await t.personOf(q);
    const ids = [t.alex.id, t.sam.id, t.lou.id];
    const drawn = chooseAgent(person, ids)!;
    const cover = ids.find((id) => id !== drawn)!;
    await absence(t, drawn, cover, '2026-12-08', '2026-12-08');
    const a = await t.attribution.attribute(q);
    expect(a).toMatchObject({ reason: 'zone', agent_id: chooseAgent(person, ids, new Set(), new Set([drawn])) });
    expect(a!.agent_id).not.toBe(drawn);
    expect((await t.journal.all()).find((e) => e.type === 'attribution')?.data).toMatchObject({ absentAgents: 1 });
  });

  it('[R680] un client déjà suivi par l’absent lui reste : rien n’est réattribué pour l’absence', async () => {
    const t = await setup();
    await t.attribution.addZone(t.network.id, t.alex.id, 'Talant');
    await t.attribution.addZone(t.network.id, t.sam.id, 'Talant');
    const followed = await t.store.createPerson({ networkId: t.network.id, agentId: t.alex.id, firstName: 'Zoé' });
    await absence(t, t.alex.id, t.sam.id, '2026-12-08', '2026-12-12');
    const q = await t.contact('zoe', 'Je souhaite vendre ma maison à Talant.');
    await t.fiche.merge({ survivorId: await t.personOf(q), mergedId: followed.id, reason: 'même personne' });
    expect(await t.attribution.attribute(q)).toMatchObject({ agent_id: t.alex.id, reason: 'already_followed' });
    expect((await t.store.getPerson(followed.id))!.agent_id).toBe(t.alex.id);
  });

  it('[R680] la réattribution d’un contact en retard ne va jamais à un agent absent', async () => {
    const t = await setup();
    await t.attribution.addZone(t.network.id, t.alex.id, 'Talant');
    await t.attribution.addZone(t.network.id, t.sam.id, 'Talant');
    const q = await t.contact('zoe', 'Je souhaite vendre ma maison à Talant.');
    const first = (await t.attribution.attribute(q))!;
    const other = first.agent_id === t.alex.id ? t.sam.id : t.alex.id;
    await absence(t, other, first.agent_id!, '2026-12-08', '2026-12-31');
    t.setClock(TUESDAY_10H + 30 * HOUR);
    const [next] = await t.attribution.reassignOverdue(t.network.id);
    expect(next).toMatchObject({ agent_id: null, reason: 'reassigned' });
    expect((await t.journal.all()).find((e) => e.type === 'attribution.reattribuee')?.data).toMatchObject({ toDirection: true, absentAgents: 1 });
  });

  it('[R680] une absence déclarée entre le choix et l’écriture : la base refuse l’absent et le choix est refait', async () => {
    const t = await setup();
    await t.attribution.addZone(t.network.id, t.alex.id, 'Talant');
    const q = await t.contact('zoe', 'Je souhaite vendre ma maison à Talant.');
    // La base revérifie l'absence dans le lot qui attribue : une écriture directe à l'absent n'aboutit pas.
    await absence(t, t.alex.id, t.sam.id, '2026-12-08', '2026-12-08');
    const pick = (t.attribution as unknown as { pick: (...a: unknown[]) => Promise<unknown> }).pick.bind(t.attribution);
    let first = true;
    (t.attribution as unknown as { pick: (...a: unknown[]) => Promise<unknown> }).pick = async (...args: unknown[]) => {
      if (first) {
        first = false;
        return { agentId: t.alex.id, fullAgents: 0, absentAgents: 0 };
      }
      return pick(...args);
    };
    expect(await t.attribution.attribute(q)).toMatchObject({ agent_id: null, reason: 'no_zone' });
  });

  it('[R680] la règle d’absence est publiée avec les autres', () => {
    expect(ATTRIBUTION_RULES.join(' ')).toMatch(/absent/);
  });
});
