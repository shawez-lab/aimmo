import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { Acces, FicheClient, FicheUnique, Mandats, RegistreMandats, SqlJournalStore, applyMigrations, fromSyncSqlite, renderPublicPage, type SqlDatabase, type Viewer } from '../src/index.ts';
import { SceauxPreuve, proofPageBody, type PublicProof } from '../src/pilotage/index.ts';
import { BUDGETS, budgetProblems, htmlProblems } from '../src/design/audit.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

// Tout est inventé : réseau d'essai, agents, clients, registre au préfixe « T- ».
const SECRET_NAME = 'Zéphyrine';
async function setup(start = '2027-01-01T10:00:00.000Z') {
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
  const as = (role: string, userId: string, networkId = network.id): Viewer => ({ role, userId, networkId }) as Viewer;
  const direction = as('direction', 'direction-1');
  const agent = as('agent', alex.id);
  const configured = await registre.configure(direction, { prefix: 'T-', firstNumber: 1, width: 5 });
  if (!configured.ok) throw new Error(configured.code);
  const setClock = (iso: string) => {
    clock = Date.parse(iso);
  };
  const sceaux = new SceauxPreuve(db, journal, { now });
  let count = 0;
  const signed = async (at: string): Promise<string> => {
    setClock(at);
    count += 1;
    const p = await store.createPerson({ networkId: network.id, agentId: alex.id, firstName: `${SECRET_NAME}${count}` });
    const r = await mandats.record(acces, agent, { personId: p.id, signedAt: new Date(at), source: 'referral' });
    if (!r.ok) throw new Error(r.code);
    return r.id;
  };
  const fill = async (month: string, n: number) => {
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      const id = await signed(`${month}-10T10:${String(i).padStart(2, '0')}:00.000Z`);
      const r = await registre.inscribe(agent, id);
      if (!r.ok) throw new Error(r.code);
      ids.push(id);
    }
    return ids;
  };
  return { raw, db, journal, registre, network, other, alex, as, direction, agent, setClock, sceaux, signed, fill };
}

const hex = (text: string): string => createHash('sha256').update(text).digest('hex');

/** Un lecteur du fichier public : il n'utilise que ce fichier et node:crypto, aucun code d'AIMMO. */
function verifyLikeAStranger(proof: PublicProof): boolean {
  let prev = '0'.repeat(64);
  for (const s of proof.seals) {
    if (s.prevHash !== prev) return false;
    if (hex(s.lines.map((l) => `${l.number}:${l.hash}\n`).join('')) !== s.linesDigest) return false;
    if (s.lines.length !== s.counted) return false;
    if (hex(JSON.stringify([s.seq, s.month, s.counted, s.simple, s.exclusive, s.untyped, s.terminated, s.withdrawn, s.cancelledError, s.linesDigest, s.sealedAt, s.prevHash])) !== s.hash) return false;
    prev = s.hash;
  }
  return true;
}

describeWithSqlite('IN02 · le mois scellé, puis publié', () => {
  it('[R212] un comptage différent est refusé, avec l’écart ; le bon comptage scelle', async () => {
    const t = await setup();
    await t.fill('2027-01', 3);
    t.setClock('2027-02-02T10:00:00.000Z');
    expect(await t.sceaux.seal(t.direction, { month: '2027-01', manualCount: 4 })).toEqual({ ok: false, rule: 'R212', code: 'count_mismatch', counted: 3, given: 4 });
    expect((await t.sceaux.publication(t.network.id)).seals).toEqual([]);
    const r = await t.sceaux.seal(t.direction, { month: '2027-01', manualCount: 3 });
    if (!r.ok) throw new Error(r.code);
    expect(r.value).toMatchObject({ seq: 1, month: '2027-01', counted: 3, prevHash: '0'.repeat(64) });
    expect(r.value.lines.map((l) => l.number)).toEqual(['T-00001', 'T-00002', 'T-00003']);
    expect(await t.sceaux.seal(t.direction, { month: '2027-01', manualCount: 3 })).toEqual({ ok: false, rule: 'R212', code: 'already_sealed' });
  });

  it('[R212] mois en cours, mois d’avant le compte, registre abîmé, mandat pas inscrit : pas de sceau', async () => {
    const t = await setup();
    await t.fill('2027-01', 1);
    t.setClock('2027-01-20T10:00:00.000Z');
    expect(await t.sceaux.seal(t.direction, { month: '2027-01', manualCount: 1 })).toMatchObject({ ok: false, rule: 'R212', code: 'month_not_finished' });
    expect(await t.sceaux.seal(t.direction, { month: '2027-03', manualCount: 0 })).toMatchObject({ ok: false, rule: 'R212', code: 'month_not_finished' });
    expect(await t.sceaux.seal(t.direction, { month: '2026-12', manualCount: 0 })).toMatchObject({ ok: false, rule: 'R212', code: 'month_not_finished' });
    for (const bad of [{ month: '2027-13', manualCount: 0 }, { month: '2027-01', manualCount: -1 }, { month: '2027-01', manualCount: 1.5 }, { month: '2027-01', manualCount: '1' }, { month: null, manualCount: 1 }]) {
      expect(await t.sceaux.seal(t.direction, bad)).toEqual({ ok: false, rule: null, code: 'bad_input' });
    }
    await t.signed('2027-01-21T10:00:00.000Z');
    t.setClock('2027-02-02T10:00:00.000Z');
    expect(await t.sceaux.seal(t.direction, { month: '2027-01', manualCount: 1 })).toEqual({ ok: false, rule: 'R212', code: 'not_inscribed', notInscribed: 1 });
    t.raw.exec('DROP TRIGGER mandate_register_sans_modification');
    await t.db.run("UPDATE mandate_register SET signed_at = '2027-01-02T00:00:00.000Z' WHERE seq = 1");
    expect(await t.sceaux.seal(t.direction, { month: '2027-01', manualCount: 1 })).toEqual({ ok: false, rule: 'R212', code: 'register_broken' });
  });

  it('[R16] [R212] la direction seule scelle ; le refus est au journal ; un réseau ne touche pas la chaîne d’un autre', async () => {
    const t = await setup();
    await t.fill('2027-01', 1);
    t.setClock('2027-02-02T10:00:00.000Z');
    for (const v of [t.agent, t.as('compliance', 'c-1')]) expect(await t.sceaux.seal(v, { month: '2027-01', manualCount: 1 })).toMatchObject({ ok: false, rule: 'R16' });
    const refused = (await t.journal.all()).filter((e) => e.type === 'acces.refuse' && JSON.stringify(e.data).includes('proof_seal'));
    expect(refused).toHaveLength(2);
    expect(await t.sceaux.seal(t.as('direction', 'd-2', t.other.id), { month: '2027-01', manualCount: 1 })).toMatchObject({ ok: false, rule: 'R212', code: 'count_mismatch', counted: 0 });
    const zero = await t.sceaux.seal(t.as('direction', 'd-2', t.other.id), { month: '2027-01', manualCount: 0 });
    expect(zero).toMatchObject({ ok: true, value: { seq: 1, counted: 0 } });
    expect((await t.sceaux.publication(t.network.id)).seals).toEqual([]);
    expect(await t.sceaux.seal(t.direction, { month: '2027-01', manualCount: 1 })).toMatchObject({ ok: true, value: { seq: 1 } });
  });

  it('[R213] un lecteur recalcule tout seul, depuis le seul fichier public ; une ligne changée se voit', async () => {
    const t = await setup();
    await t.fill('2027-01', 2);
    await t.fill('2027-02', 1);
    t.setClock('2027-03-02T10:00:00.000Z');
    for (const [month, manualCount] of [['2027-01', 2], ['2027-02', 1]] as const) {
      const r = await t.sceaux.seal(t.direction, { month, manualCount });
      if (!r.ok) throw new Error(r.code);
    }
    const proof = JSON.parse(JSON.stringify(await t.sceaux.publication(t.network.id))) as PublicProof;
    expect(proof.seals).toHaveLength(2);
    expect(verifyLikeAStranger(proof)).toBe(true);
    const altered = JSON.parse(JSON.stringify(proof)) as PublicProof;
    altered.seals[0]!.lines[0]!.number = 'T-99999';
    expect(verifyLikeAStranger(altered)).toBe(false);
    const inflated = JSON.parse(JSON.stringify(proof)) as PublicProof;
    inflated.seals[1]!.counted = 12;
    expect(verifyLikeAStranger(inflated)).toBe(false);
  });

  it('[R17] [R212] [R213] une annulation après le sceau ne réécrit rien : le mois se dit changé, le nouveau sceau garde l’ancien', async () => {
    const t = await setup();
    const [first] = await t.fill('2027-01', 2);
    t.setClock('2027-02-02T10:00:00.000Z');
    const firstSeal = await t.sceaux.seal(t.direction, { month: '2027-01', manualCount: 2 });
    if (!firstSeal.ok) throw new Error(firstSeal.code);
    const cancelled = await t.registre.cancel(t.agent, first!, 'error');
    if (!cancelled.ok) throw new Error(cancelled.code);
    let proof = await t.sceaux.publication(t.network.id);
    expect(proof.months[0]).toMatchObject({ month: '2027-01', counted: 2, changedSinceSeal: true, corrected: false });
    const second = await t.sceaux.seal(t.direction, { month: '2027-01', manualCount: 1 });
    if (!second.ok) throw new Error(second.code);
    expect(second.value.prevHash).toBe(firstSeal.value.hash);
    proof = await t.sceaux.publication(t.network.id);
    expect(proof.months[0]).toMatchObject({ counted: 1, sealSeq: 2, changedSinceSeal: false, corrected: true });
    expect(proof.seals.map((s) => s.counted)).toEqual([2, 1]);
    expect(verifyLikeAStranger(proof)).toBe(true);
    await expect(t.db.run('UPDATE proof_seals SET counted = 9 WHERE seq = 1')).rejects.toThrow(/ajout seul/);
    await expect(t.db.run('DELETE FROM proof_seals WHERE seq = 1')).rejects.toThrow(/ajout seul/);
  });

  it('[R213] une résiliation après le sceau change le mois aussi, sans changer le compte', async () => {
    const t = await setup();
    const [first] = await t.fill('2027-01', 2);
    t.setClock('2027-02-02T10:00:00.000Z');
    expect((await t.sceaux.seal(t.direction, { month: '2027-01', manualCount: 2 })).ok).toBe(true);
    const r = await t.registre.cancel(t.agent, first!, 'termination');
    if (!r.ok) throw new Error(r.code);
    expect((await t.sceaux.publication(t.network.id)).months[0]).toMatchObject({ counted: 2, changedSinceSeal: true });
    const again = await t.sceaux.seal(t.direction, { month: '2027-01', manualCount: 2 });
    expect(again).toMatchObject({ ok: true, value: { seq: 2, terminated: 1, counted: 2 } });
  });

  it('[R213] la condition publique : 6 mois scellés à 10 ; un mois pas scellé ou changé, une chaîne abîmée la défont', async () => {
    const t = await setup();
    const months = ['2027-01', '2027-02', '2027-03', '2027-04', '2027-05', '2027-06'];
    const ids: string[][] = [];
    for (const month of months) ids.push(await t.fill(month, 10));
    t.setClock('2027-07-02T10:00:00.000Z');
    for (const month of months.slice(0, 5)) expect((await t.sceaux.seal(t.direction, { month, manualCount: 10 })).ok).toBe(true);
    expect((await t.sceaux.publication(t.network.id)).condition.met).toBe(false);
    expect((await t.sceaux.seal(t.direction, { month: '2027-06', manualCount: 10 })).ok).toBe(true);
    expect((await t.sceaux.publication(t.network.id)).condition).toEqual({ met: true, metOn: '2027-06' });
    t.raw.exec('DROP TRIGGER proof_seals_sans_modification');
    const original = (await t.db.first<{ sealed_at: string }>('SELECT sealed_at FROM proof_seals WHERE seq = 3'))!.sealed_at;
    await t.db.run('UPDATE proof_seals SET sealed_at = ? WHERE seq = 3', ['2027-07-03T10:00:00.000Z']);
    const broken = await t.sceaux.publication(t.network.id);
    expect(broken.chainSound).toBe(false);
    expect(broken.condition).toEqual({ met: false, metOn: null });
    expect(proofPageBody(broken)).toContain('role="alert"');
    await t.db.run('UPDATE proof_seals SET sealed_at = ? WHERE seq = 3', [original]);
    expect((await t.sceaux.publication(t.network.id)).condition.met).toBe(true);
    // Chaîne saine, mais mars n'est plus ce que dit son sceau : la condition tombe, même si son sceau dit 10.
    const c = await t.registre.cancel(t.agent, ids[2]![0]!, 'error');
    if (!c.ok) throw new Error(c.code);
    const changed = await t.sceaux.publication(t.network.id);
    expect(changed.chainSound).toBe(true);
    expect(changed.months[2]).toMatchObject({ counted: 10, changedSinceSeal: true });
    expect(changed.condition.met).toBe(false);
  }, 60_000);

  it('[R212] le compte et les lignes d’un sceau viennent d’une seule lecture : une annulation pendant le sceau ne casse jamais la chaîne', async () => {
    const t = await setup();
    const [first] = await t.fill('2027-01', 2);
    t.setClock('2027-02-02T10:00:00.000Z');
    // Une annulation qui arrive juste après la lecture du registre, n'importe où avant l'écriture du sceau.
    let done = false;
    const racing: SqlDatabase = {
      ...t.db,
      all: async (sql: string, params?: readonly never[]) => {
        const rows = await t.db.all(sql, params as never);
        if (!done && /FROM mandate_register r/.test(sql)) {
          done = true;
          const c = await t.registre.cancel(t.agent, first!, 'error');
          if (!c.ok) throw new Error(c.code);
        }
        return rows;
      },
    } as SqlDatabase;
    const r = await new SceauxPreuve(racing, t.journal, { now: () => new Date('2027-02-02T10:00:00.000Z') }).seal(t.direction, { month: '2027-01', manualCount: 2 });
    expect(done).toBe(true);
    if (!r.ok) throw new Error(r.code);
    expect(r.value.lines).toHaveLength(r.value.counted);
    const proof = await t.sceaux.publication(t.network.id);
    expect(proof.chainSound).toBe(true);
    expect(proof.months[0]).toMatchObject({ changedSinceSeal: true });
    expect(await t.sceaux.seal(t.direction, { month: '2027-01', manualCount: 1 })).toMatchObject({ ok: true, value: { seq: 2, counted: 1 } });
    expect((await t.sceaux.publication(t.network.id)).chainSound).toBe(true);
  });

  it('[R212] deux sceaux en même temps : un conflit dit ; une vraie panne remonte, elle n’est pas maquillée', async () => {
    const t = await setup();
    await t.fill('2027-01', 1);
    await t.fill('2027-02', 1);
    t.setClock('2027-03-02T10:00:00.000Z');
    const failing = (before: () => Promise<void>): SqlDatabase =>
      ({
        ...t.db,
        run: async (sql: string, params?: readonly never[]) => {
          if (/INSERT INTO proof_seals/.test(sql)) {
            await before();
            throw new Error('panne de base inventée');
          }
          return t.db.run(sql, params as never);
        },
      }) as SqlDatabase;
    const now = () => new Date('2027-03-02T10:00:00.000Z');
    await expect(new SceauxPreuve(failing(async () => {}), t.journal, { now }).seal(t.direction, { month: '2027-01', manualCount: 1 })).rejects.toThrow(/panne de base/);
    // L'autre sceau passe juste avant : le rang est pris.
    const lost = await new SceauxPreuve(
      failing(async () => {
        const other = await t.sceaux.seal(t.direction, { month: '2027-02', manualCount: 1 });
        if (!other.ok) throw new Error(other.code);
      }),
      t.journal,
      { now },
    ).seal(t.direction, { month: '2027-01', manualCount: 1 });
    expect(lost).toEqual({ ok: false, rule: 'R212', code: 'conflict' });
    expect((await t.sceaux.publication(t.network.id)).seals.map((s) => s.month)).toEqual(['2027-02']);
  });

  it('[R213] la route publique ne relit pas le registre à chaque lecture : deux requêtes, quel que soit le nombre de mandats ; un sceau et 5 minutes la rafraîchissent', async () => {
    const t = await setup();
    await t.fill('2027-01', 3);
    await t.fill('2027-02', 3);
    t.setClock('2027-03-02T10:00:00.000Z');
    let queries = 0;
    let clock = Date.parse('2027-03-02T10:00:00.000Z');
    const counting: SqlDatabase = {
      ...t.db,
      all: async (sql: string, params?: readonly never[]) => { queries += 1; return t.db.all(sql, params as never); },
      first: async (sql: string, params?: readonly never[]) => { queries += 1; return t.db.first(sql, params as never); },
      run: async (sql: string, params?: readonly never[]) => { queries += 1; return t.db.run(sql, params as never); },
    } as SqlDatabase;
    const served = new SceauxPreuve(counting, t.journal, { now: () => new Date(clock) });
    await served.servedPublication(t.network.id);
    for (let i = 0; i < 3; i++) {
      queries = 0;
      expect((await served.servedPublication(t.network.id)).seals).toEqual([]);
      expect(queries).toBe(2);
    }
    // Un nouveau sceau se voit aussitôt.
    expect((await t.sceaux.seal(t.direction, { month: '2027-01', manualCount: 3 })).ok).toBe(true);
    expect((await served.servedPublication(t.network.id)).seals).toHaveLength(1);
    // Une annulation se voit au plus tard 5 minutes après.
    const [id] = await t.db.all<{ mandate_id: string }>("SELECT mandate_id FROM mandate_register WHERE seq = 1");
    t.setClock('2027-03-02T10:01:00.000Z');
    const c = await t.registre.cancel(t.agent, id!.mandate_id, 'error');
    if (!c.ok) throw new Error(c.code);
    clock += 60_000;
    expect((await served.servedPublication(t.network.id)).months[0]).toMatchObject({ changedSinceSeal: false });
    clock += 5 * 60_000;
    expect((await served.servedPublication(t.network.id)).months[0]).toMatchObject({ changedSinceSeal: true });
  });

  it('[R13] [R14] [R213] rien de personnel, aucun agent ni identifiant interne dans le fichier et la page ; design et budget tenus [R201]', async () => {
    const t = await setup();
    const ids = await t.fill('2027-01', 3);
    t.setClock('2027-02-02T10:00:00.000Z');
    expect((await t.sceaux.seal(t.direction, { month: '2027-01', manualCount: 3 })).ok).toBe(true);
    const proof = await t.sceaux.publication(t.network.id);
    const body = proofPageBody(proof);
    const html = renderPublicPage({ title: 'La preuve à Dijon, mois par mois', body, kicker: 'Compte public' });
    for (const text of [JSON.stringify(proof), html]) {
      expect(text).not.toContain(SECRET_NAME);
      expect(text).not.toContain(t.alex.id);
      expect(text).not.toContain(t.network.id);
      expect(text).not.toContain('direction-1');
      for (const id of ids) expect(text).not.toContain(id);
    }
    expect(htmlProblems(html)).toEqual([]);
    expect(budgetProblems({ html }, BUDGETS.page)).toEqual([]);
    expect(body).toContain('janvier 2027');
    expect(body).toContain('Condition pas encore remplie');
    expect(body).toMatch(/ne promet rien/);
    // Avant tout mois fini : la page le dit, sans tableau vide.
    const empty = await setup('2026-12-20T10:00:00.000Z');
    expect(proofPageBody(await empty.sceaux.publication(empty.network.id))).toContain('le compte commence en janvier 2027');
  });
});
