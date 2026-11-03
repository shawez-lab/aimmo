import { expect, it } from 'vitest';
import { Acces, FicheClient, FicheUnique, Mandats, RegistreMandats, SqlJournalStore, applyMigrations, fromSyncSqlite, type SqlDatabase, type Viewer } from '../src/index.ts';
import { CompteurPreuve, parisMonth, proofRuns } from '../src/pilotage/index.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

// Tout est inventé : réseau d'essai, agents, clients, registre au préfixe « T- ».
async function setup(start = '2027-01-15T10:00:00.000Z') {
  const raw = openMemoryDatabase();
  const db: SqlDatabase = fromSyncSqlite(raw);
  await applyMigrations(db, loadMigrations());
  let clock = Date.parse(start);
  const now = (): Date => new Date(clock);
  const journal = new SqlJournalStore(db);
  const store = new FicheClient(db, { now });
  const fiche = new FicheUnique(db, store, { now });
  const acces = new Acces(db, store, fiche, journal, { now });
  const mandats = new Mandats(db, fiche, journal, { now });
  const registre = new RegistreMandats(db, journal, { now });
  const network = await store.createNetwork('Réseau test');
  const other = await store.createNetwork('Autre réseau');
  const alex = await store.createAgent({ networkId: network.id, firstName: 'Alex', lastName: 'Agent' });
  const sam = await store.createAgent({ networkId: network.id, firstName: 'Sam', lastName: 'Agent' });
  const as = (role: string, userId: string, networkId = network.id): Viewer => ({ role, userId, networkId }) as Viewer;
  const direction = as('direction', 'direction-1');
  const configured = await registre.configure(direction, { prefix: 'T-', firstNumber: 1, width: 5 });
  if (!configured.ok) throw new Error(configured.code);
  const setClock = (iso: string) => {
    clock = Date.parse(iso);
  };
  const compteur = () => new CompteurPreuve(db, journal, { now });
  let count = 0;
  /** Un mandat signé à cet instant (l'horloge y est posée), sans l'inscrire. */
  const signed = async (at: string, agentId = alex.id): Promise<string> => {
    setClock(at);
    count += 1;
    const p = await store.createPerson({ networkId: network.id, agentId, firstName: `Client${count}` });
    const r = await mandats.record(acces, as('agent', agentId), { personId: p.id, signedAt: new Date(at), source: 'referral' });
    if (!r.ok) throw new Error(r.code);
    return r.id;
  };
  const inscribed = async (at: string, agentId = alex.id): Promise<string> => {
    const id = await signed(at, agentId);
    const r = await registre.inscribe(as('agent', agentId), id);
    if (!r.ok) throw new Error(r.code);
    return id;
  };
  /** `n` mandats inscrits dans un mois, signés le 10 à midi et une minute de plus chacun. */
  const fill = async (month: string, n: number) => {
    const ids: string[] = [];
    for (let i = 0; i < n; i++) ids.push(await inscribed(`${month}-10T10:${String(i).padStart(2, '0')}:00.000Z`));
    return ids;
  };
  return { raw, db, journal, registre, network, other, alex, sam, as, direction, setClock, compteur, signed, inscribed, fill };
}

const monthOf = (value: { months: { month: string }[] }, month: string) => value.months.find((m) => m.month === month) as never as Record<string, number | boolean>;

describeWithSqlite('IN01 · compteur de la preuve à Dijon', () => {
  it('[R210] seuls les mandats inscrits comptent ; signé et pas inscrit se voit à part', async () => {
    const t = await setup();
    await t.inscribed('2027-01-05T10:00:00.000Z');
    await t.signed('2027-01-06T10:00:00.000Z');
    t.setClock('2027-01-20T10:00:00.000Z');
    const r = await t.compteur().read(t.direction);
    if (!r.ok) throw new Error(r.code);
    expect(monthOf(r.value, '2027-01')).toMatchObject({ counted: 1, notInscribed: 1, untyped: 1, simple: 0, exclusive: 0, complete: false });
  });

  it('[R210] le mois est celui de Paris, à la signature figée, pas celui de l’inscription', async () => {
    expect(parisMonth(new Date('2027-01-31T23:30:00.000Z'))).toBe('2027-02');
    expect(parisMonth(new Date('2027-07-31T21:59:00.000Z'))).toBe('2027-07');
    expect(parisMonth(new Date('2027-07-31T22:00:00.000Z'))).toBe('2027-08');
    const t = await setup();
    const id = await t.signed('2027-01-31T23:30:00.000Z');
    t.setClock('2027-03-02T10:00:00.000Z');
    const line = await t.registre.inscribe(t.as('agent', t.alex.id), id);
    if (!line.ok) throw new Error(line.code);
    const r = await t.compteur().read(t.direction);
    if (!r.ok) throw new Error(r.code);
    expect(monthOf(r.value, '2027-01').counted).toBe(0);
    expect(monthOf(r.value, '2027-02').counted).toBe(1);
    expect(monthOf(r.value, '2027-03').counted).toBe(0);
  });

  it('[R210] erreur et rétractation retirent le mandat ; une résiliation le laisse compter et se voit', async () => {
    const t = await setup();
    const [a, b, c] = await t.fill('2027-01', 4);
    t.setClock('2027-02-02T10:00:00.000Z');
    const agent = t.as('agent', t.alex.id);
    for (const [id, reason] of [[a, 'error'], [b, 'withdrawal'], [c, 'termination']] as const) {
      const r = await t.registre.cancel(agent, id!, reason);
      if (!r.ok) throw new Error(r.code);
    }
    const r = await t.compteur().read(t.direction);
    if (!r.ok) throw new Error(r.code);
    expect(monthOf(r.value, '2027-01')).toMatchObject({ counted: 2, cancelledError: 1, withdrawn: 1, terminated: 1, complete: true });
  });

  it('[R210] une rétractation rangée retire le mandat même sans sa ligne d’annulation ; pas inscrit, elle ne reste pas « à inscrire »', async () => {
    const t = await setup();
    const [a] = await t.fill('2027-01', 2);
    const never = await t.signed('2027-01-12T10:00:00.000Z');
    for (const id of [a!, never]) {
      await t.db.run('INSERT INTO mandate_withdrawals (mandate_id, network_id, proof, received_at, recorded_by, created_at) VALUES (?, ?, ?, ?, ?, ?)', [id, t.network.id, 'preuve inventée', '2027-01-13T10:00:00.000Z', 'x', '2027-01-13T10:00:00.000Z']);
    }
    const r = await t.compteur().read(t.direction);
    if (!r.ok) throw new Error(r.code);
    expect(monthOf(r.value, '2027-01')).toMatchObject({ counted: 1, withdrawn: 1, notInscribed: 0 });
  });

  it('[R210] le type vient du document signé du mandat', async () => {
    const t = await setup();
    const [simple, exclusive] = await t.fill('2027-01', 3);
    t.raw.exec('PRAGMA foreign_keys = OFF');
    for (const [id, kind, doc] of [[simple, 'mandat_vente_simple', 'd1'], [exclusive, 'mandat_vente_exclusif', 'd2']] as const) {
      await t.db.run(
        `INSERT INTO documents (id, network_id, template_id, template_version, template_hash, kind, mode, status, missing, agent_id, person_id, property_id, content, content_hash, created_by, created_at)
         VALUES (?, ?, 'tpl', 1, 'h', ?, 'essai', 'signed', '[]', ?, 'p', NULL, 'texte', 'h', 'x', '2027-01-10T10:00:00.000Z')`,
        [doc, t.network.id, kind, t.alex.id],
      );
      await t.db.run(`INSERT INTO signed_documents (document_id, network_id, signed_at, place, scan_ref, mandate_id, registered_by, created_at) VALUES (?, ?, '2027-01-10T10:00:00.000Z', 'agence', 'scan', ?, 'x', '2027-01-10T10:00:00.000Z')`, [doc, t.network.id, id!]);
    }
    const r = await t.compteur().read(t.direction);
    if (!r.ok) throw new Error(r.code);
    expect(monthOf(r.value, '2027-01')).toMatchObject({ counted: 3, simple: 1, exclusive: 1, untyped: 1 });
  });

  it('[R211] la série : 6 mois finis à 10 remplissent, 5 non, un mois à 9 casse, le mois en cours ne compte pas', () => {
    const m = (month: string, targetMet: boolean, complete = true) => ({ month, targetMet, complete });
    const five = ['2027-01', '2027-02', '2027-03', '2027-04', '2027-05'].map((x) => m(x, true));
    expect(proofRuns(five).condition).toEqual({ met: false, metOn: null });
    expect(proofRuns([...five, m('2027-06', true, false)]).condition).toEqual({ met: false, metOn: null });
    const six = [...five, m('2027-06', true)];
    expect(proofRuns(six).condition).toEqual({ met: true, metOn: '2027-06' });
    expect(proofRuns(six).bestRun).toEqual({ length: 6, from: '2027-01', to: '2027-06' });
    const broken = [...five.slice(0, 3), m('2027-04', false), ...five.slice(4), m('2027-06', true), m('2027-07', true)];
    const runs = proofRuns(broken);
    expect(runs.condition.met).toBe(false);
    expect(runs.currentRun).toEqual({ length: 3, from: '2027-05', to: '2027-07' });
    expect(runs.bestRun).toEqual({ length: 3, from: '2027-01', to: '2027-03' });
    // La condition remplie une fois reste datée du premier mois qui la remplit ; la série en cours peut retomber à zéro.
    const after = proofRuns([...six, m('2027-07', false)]);
    expect(after.condition).toEqual({ met: true, metOn: '2027-06' });
    expect(after.currentRun.length).toBe(0);
  });

  it('[R211] sur le registre : 10 mandats par mois pendant 6 mois, puis une annulation tardive défait la condition', async () => {
    const t = await setup('2027-01-01T10:00:00.000Z');
    let last: string[] = [];
    for (const month of ['2027-01', '2027-02', '2027-03', '2027-04', '2027-05', '2027-06']) last = await t.fill(month, 10);
    t.setClock('2027-06-20T10:00:00.000Z');
    let r = await t.compteur().read(t.direction);
    if (!r.ok) throw new Error(r.code);
    expect(r.value.condition.met).toBe(false);
    expect(r.value.currentRun.length).toBe(5);
    t.setClock('2027-07-01T08:00:00.000Z');
    r = await t.compteur().read(t.direction);
    if (!r.ok) throw new Error(r.code);
    expect(r.value.condition).toEqual({ met: true, metOn: '2027-06' });
    const cancelled = await t.registre.cancel(t.as('agent', t.alex.id), last[0]!, 'error');
    if (!cancelled.ok) throw new Error(cancelled.code);
    r = await t.compteur().read(t.direction);
    if (!r.ok) throw new Error(r.code);
    expect(monthOf(r.value, '2027-06')).toMatchObject({ counted: 9, targetMet: false });
    expect(r.value.condition).toEqual({ met: false, metOn: null });
  }, 60_000);

  it('[R211] un registre abîmé : la condition n’est jamais dite remplie', async () => {
    const t = await setup('2027-01-01T10:00:00.000Z');
    await t.fill('2027-01', 1);
    t.setClock('2027-02-02T10:00:00.000Z');
    const ok = await t.compteur().read(t.direction);
    if (!ok.ok) throw new Error(ok.code);
    expect(ok.value.registerSound).toBe(true);
    t.raw.exec('DROP TRIGGER mandate_register_sans_modification');
    await t.db.run("UPDATE mandate_register SET signed_at = '2027-01-02T00:00:00.000Z' WHERE seq = 1");
    const r = await t.compteur().read(t.direction);
    if (!r.ok) throw new Error(r.code);
    expect(r.value.registerSound).toBe(false);
    expect(r.value.condition).toEqual({ met: false, metOn: null });
  });

  it('[R210] rien avant janvier 2027, et aucun mois avant que le compte ne commence', async () => {
    const t = await setup('2026-12-20T10:00:00.000Z');
    await t.inscribed('2026-12-20T10:00:00.000Z');
    let r = await t.compteur().read(t.direction);
    if (!r.ok) throw new Error(r.code);
    expect(r.value.months).toEqual([]);
    expect(r.value.startMonth).toBe('2027-01');
    t.setClock('2027-02-02T10:00:00.000Z');
    r = await t.compteur().read(t.direction);
    if (!r.ok) throw new Error(r.code);
    expect(r.value.months.map((m) => m.counted)).toEqual([0, 0]);
  });

  it('[R14] [R210] aucun chiffre par agent, et les mandats de tous les agents comptent ensemble', async () => {
    const t = await setup();
    await t.inscribed('2027-01-05T10:00:00.000Z', t.alex.id);
    await t.inscribed('2027-01-06T10:00:00.000Z', t.sam.id);
    const r = await t.compteur().read(t.direction);
    if (!r.ok) throw new Error(r.code);
    expect(monthOf(r.value, '2027-01').counted).toBe(2);
    const text = JSON.stringify(r.value);
    expect(text).not.toContain(t.alex.id);
    expect(text).not.toContain(t.sam.id);
    expect(text).not.toMatch(/agent/i);
  });

  it('[R16] [R210] la direction seule ; chaque refus est au journal, sans chiffre ; un autre réseau ne voit rien', async () => {
    const t = await setup();
    await t.inscribed('2027-01-05T10:00:00.000Z');
    for (const role of ['agent', 'compliance', 'site_auto']) {
      const r = await t.compteur().read(t.as(role, 'x-1'));
      expect(r).toMatchObject({ ok: false, rule: 'R16' });
    }
    const refused = (await t.journal.all()).filter((e) => e.type === 'acces.refuse' && JSON.stringify(e.data).includes('proof_counter'));
    expect(refused).toHaveLength(3);
    expect(JSON.stringify(refused)).not.toMatch(/counted/);
    const r = await t.compteur().read(t.as('direction', 'd-2', t.other.id));
    if (!r.ok) throw new Error(r.code);
    expect(monthOf(r.value, '2027-01').counted).toBe(0);
  });
});
