import { expect, it } from 'vitest';
import { FicheClient, SqlJournalStore, applyMigrations, fromSyncSqlite, type SqlDatabase, type Viewer } from '../src/index.ts';
import { PortesPhases, type PhaseConditionReading } from '../src/conditions-phases/index.ts';
import { HOME_REGION, REGIONS, REGION_CHAIN_START, REGION_JOURNAL_GRACE_MS, REGION_SPACING_DAYS, RegionsOuvertes, regionDecisionHash, regionOfDepartment, type RegionsReport } from '../src/regions/index.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

// Tout est inventé : réseaux d'essai, utilisateurs, raisons.
const met = (): PhaseConditionReading => ({ met: true, reasons: [], evidence: { essai: 1 } });

async function setup() {
  const raw = openMemoryDatabase();
  const db: SqlDatabase = fromSyncSqlite(raw);
  await applyMigrations(db, loadMigrations());
  let clock = Date.parse('2028-01-10T09:00:00.000Z');
  const now = (): Date => new Date(clock);
  const setClock = (iso: string) => {
    clock = Date.parse(iso);
  };
  const journal = new SqlJournalStore(db);
  const store = new FicheClient(db, { now });
  const network = await store.createNetwork('Réseau test');
  const other = await store.createNetwork('Autre réseau');
  const as = (role: string, userId: string, networkId = network.id): Viewer => ({ role, userId, networkId }) as Viewer;
  const direction = as('direction', 'direction-1');
  const regions = new RegionsOuvertes(db, journal, { now });
  const portes = new PortesPhases(db, journal, { now, sources: { 1: async () => met(), 2: async () => met(), 3: async () => met(), 4: async () => met() } });
  /** Ouvre les phases 2 à 5 du réseau par la porte des phases (HX71). */
  const openPhase5 = async (v: Viewer = direction) => {
    for (const phase of [2, 3, 4, 5]) {
      const r = await portes.open(v, { phase });
      if (!r.ok) throw new Error(r.code);
    }
  };
  const events = async (type: string) => (await db.all<{ data: string }>('SELECT data FROM journal WHERE type = ?', [type])).map((e) => JSON.parse(e.data) as Record<string, unknown>);
  const report = async (v: Viewer = direction): Promise<RegionsReport> => {
    const r = await regions.report(v);
    if (!r.ok) throw new Error(r.code);
    return r.value;
  };
  const decide = async (region: string, open: boolean, v: Viewer = direction) => regions.decide(v, { region, open, reason: 'Décision d’essai' });
  return { raw, db, journal, network, other, as, direction, regions, openPhase5, events, report, decide, setClock, now };
}

describeWithSqlite('HX72 · Les régions s’ouvrent une par une', () => {
  it('[R650] 18 régions, chaque département dans une seule région, un département inconnu sans région', () => {
    expect(REGIONS).toHaveLength(18);
    expect(REGIONS.filter((r) => r.departments.every((d) => d.length === 3))).toHaveLength(5);
    const all = REGIONS.flatMap((r) => r.departments);
    expect(all).toHaveLength(101);
    expect(new Set(all).size).toBe(101);
    // Chaque département de métropole, de 01 à 95 (sans 20), avec 2A et 2B.
    const metro = Array.from({ length: 95 }, (_, i) => String(i + 1).padStart(2, '0')).filter((d) => d !== '20');
    for (const d of [...metro, '2A', '2B', '971', '972', '973', '974', '976']) expect(regionOfDepartment(d)).not.toBeNull();
    expect(regionOfDepartment('21')).toBe('27');
    expect(regionOfDepartment('2a')).toBe('94');
    expect(regionOfDepartment(' 75 ')).toBe('11');
    expect(regionOfDepartment('69')).toBe('84');
    expect(regionOfDepartment('59')).toBe('32');
    for (const d of ['20', '96', '975', '977', '00', '', 'Dijon', '021']) expect(regionOfDepartment(d)).toBeNull();
    expect(regionOfDepartment(21)).toBeNull();
    expect(regionOfDepartment(null)).toBeNull();
  });

  it('[R650] la région d’origine est ouverte d’office et ne se ferme jamais ; une région inconnue est refusée', async () => {
    const t = await setup();
    const r = await t.report();
    expect(r.regions.filter((l) => l.open).map((l) => [l.code, l.home, l.openSince, l.version])).toEqual([[HOME_REGION, true, null, null]]);
    expect(r.regions.find((l) => l.code === '27')!.name).toBe('Bourgogne-Franche-Comté');
    expect(await t.decide(HOME_REGION, false)).toEqual({ ok: false, rule: 'R650', code: 'region_d_origine' });
    await t.openPhase5();
    expect(await t.decide(HOME_REGION, true)).toEqual({ ok: false, rule: 'R650', code: 'region_d_origine' });
    expect(await t.decide('05', true)).toEqual({ ok: false, rule: 'R650', code: 'region_inconnue' });
    expect(await t.decide('Bretagne', true)).toEqual({ ok: false, rule: 'R650', code: 'region_inconnue' });
    expect(await t.regions.departmentOpen(t.network.id, '21')).toBe(true);
    expect(await t.regions.departmentOpen(t.network.id, '75')).toBe(false);
    expect(await t.regions.departmentOpen(t.network.id, 'inconnu')).toBe(false);
    // La base refuse une ligne pour la région d'origine, même écrite à la main.
    expect(() =>
      t.raw.prepare("INSERT INTO region_decisions (network_id, version, region, is_open, reason, decided_by, decided_at, phase5_hash, prev_hash, hash) VALUES (?, 1, '27', 0, 'essai', 'direction:x', '2028-01-10', NULL, ?, ?)").run(t.network.id, REGION_CHAIN_START, 'a'.repeat(64)),
    ).toThrow();
    expect(await t.db.all('SELECT version FROM region_decisions')).toEqual([]);
  });

  it('[R651] une région ne s’ouvre pas sans la phase 5 ouverte ; l’ouverture range l’empreinte de la phase 5', async () => {
    const t = await setup();
    expect(await t.decide('53', true)).toEqual({ ok: false, rule: 'R651', code: 'phase5_fermee' });
    expect((await t.report()).openable).toEqual({ ok: false, reasons: ['phase5_fermee'], until: null });
    expect((await t.report()).phase5Open).toBe(false);
    // Le réseau voisin a ouvert sa phase 5 : cela n'ouvre rien ici.
    await t.openPhase5(t.as('direction', 'direction-2', t.other.id));
    expect(await t.decide('53', true)).toEqual({ ok: false, rule: 'R651', code: 'phase5_fermee' });
    await t.openPhase5();
    const p5 = await t.db.first<{ evidence_hash: string }>('SELECT evidence_hash FROM phase_openings WHERE network_id = ? AND phase = 5', [t.network.id]);
    expect((await t.report()).openable).toEqual({ ok: true, reasons: [], until: null });
    const r = await t.decide('53', true);
    if (!r.ok) throw new Error(r.code);
    expect(r.value).toMatchObject({ region: '53', version: 1, open: true });
    expect(await t.db.all('SELECT region, is_open, phase5_hash, decided_by FROM region_decisions')).toEqual([{ region: '53', is_open: 1, phase5_hash: p5!.evidence_hash, decided_by: 'direction:direction-1' }]);
    expect(await t.events('regions.decision')).toEqual([{ rule: 'R651', region: '53', version: 1, open: true, hash: r.value.hash }]);
    const line = (await t.report()).regions.find((l) => l.code === '53')!;
    expect(line).toEqual({ code: '53', name: 'Bretagne', home: false, open: true, openSince: '2028-01-10T09:00:00.000Z', version: 1 });
    expect(await t.regions.departmentOpen(t.network.id, '29')).toBe(true);
    // Rien ne s'ouvre dans l'autre réseau.
    expect(await t.regions.openRegionNames(t.other.id)).toEqual(['Bourgogne-Franche-Comté']);
  });

  it('[R651, R17] les versions se suivent, chacune change l’état ; rien ne change ni ne s’efface ; la base refuse le reste', async () => {
    const t = await setup();
    await t.openPhase5();
    expect((await t.decide('53', true)).ok).toBe(true);
    expect(await t.decide('53', true)).toEqual({ ok: false, rule: 'R651', code: 'deja_ouverte' });
    expect(await t.decide('11', false)).toEqual({ ok: false, rule: 'R651', code: 'deja_fermee' });
    expect((await t.decide('53', false)).ok).toBe(true);
    expect(await t.db.all('SELECT version, region, is_open, phase5_hash IS NULL AS sans FROM region_decisions ORDER BY version')).toEqual([
      { version: 1, region: '53', is_open: 1, sans: 0 },
      { version: 2, region: '53', is_open: 0, sans: 1 },
    ]);
    expect(() => t.raw.prepare('UPDATE region_decisions SET reason = ? WHERE version = 1').run('autre')).toThrow();
    expect(() => t.raw.prepare('DELETE FROM region_decisions').run()).toThrow();
    const ins = (version: number, region: string, open: number, p5: string | null) =>
      t.raw
        .prepare('INSERT INTO region_decisions (network_id, version, region, is_open, reason, decided_by, decided_at, phase5_hash, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(t.network.id, version, region, open, 'essai', 'direction:x', '2028-01-10', p5, REGION_CHAIN_START, 'b'.repeat(64));
    // Une version hors suite, un état inchangé, une ouverture sans l'empreinte de la phase 5, une fermeture d'une région jamais ouverte.
    expect(() => ins(4, '11', 0, null)).toThrow();
    expect(() => ins(3, '53', 0, null)).toThrow();
    expect(() => ins(3, '11', 1, null)).toThrow();
    expect(() => ins(3, '11', 1, 'c'.repeat(64))).toThrow();
    expect(() => ins(3, '11', 0, null)).toThrow();
    // Une décision écrite par un autre que la direction.
    expect(() =>
      t.raw
        .prepare("INSERT INTO region_decisions (network_id, version, region, is_open, reason, decided_by, decided_at, phase5_hash, prev_hash, hash) VALUES (?, 3, '53', 1, 'essai', 'agent:x', '2028-01-10', ?, ?, ?)")
        .run(t.network.id, (t.raw.prepare('SELECT evidence_hash FROM phase_openings WHERE phase = 5 AND network_id = ?').get(t.network.id) as { evidence_hash: string }).evidence_hash, REGION_CHAIN_START, 'b'.repeat(64)),
    ).toThrow();
    expect(await t.db.all('SELECT version FROM region_decisions')).toHaveLength(2);
  });

  it(`[R652] une seconde région attend ${REGION_SPACING_DAYS} jours après la précédente encore ouverte`, async () => {
    const t = await setup();
    await t.openPhase5();
    expect((await t.decide('53', true)).ok).toBe(true);
    t.setClock('2028-04-08T08:59:59.000Z');
    const until = '2028-04-09T09:00:00.000Z';
    expect(await t.decide('52', true)).toEqual({ ok: false, rule: 'R652', code: 'region_recente', until });
    expect((await t.report()).openable).toEqual({ ok: false, reasons: ['region_recente'], until });
    expect((await t.events('regions.refuse')).map((e) => [e.rule, e.code])).toEqual([['R652', 'region_recente']]);
    t.setClock(until);
    expect((await t.report()).openable).toEqual({ ok: true, reasons: [], until: null });
    expect((await t.decide('52', true)).ok).toBe(true);
    // Une région fermée entre-temps ne retient rien.
    t.setClock('2028-04-10T09:00:00.000Z');
    expect((await t.decide('11', true)).ok).toBe(false);
    expect((await t.decide('52', false)).ok).toBe(true);
    const r = await t.decide('11', true);
    expect(r.ok).toBe(true);
    // Rouvrir une région fermée suit les mêmes règles.
    expect(await t.decide('52', true)).toMatchObject({ ok: false, rule: 'R652', code: 'region_recente' });
    expect((await t.report()).regions.filter((l) => l.open).map((l) => l.code)).toEqual(['11', '27', '53']);
  });

  it('[R16] la direction seule lit, décide et vérifie ; tout autre rôle est refusé et le refus est au journal', async () => {
    const t = await setup();
    await t.openPhase5();
    for (const role of ['agent', 'conformite', 'assistant', 'client']) {
      const v = t.as(role, `${role}-1`);
      expect(await t.regions.report(v)).toEqual({ ok: false, rule: 'R16', code: 'role' });
      expect(await t.regions.decide(v, { region: '53', open: true, reason: 'essai' })).toEqual({ ok: false, rule: 'R16', code: 'role' });
      expect(await t.regions.verify(v)).toEqual({ ok: false, rule: 'R16', code: 'role' });
    }
    expect((await t.events('acces.refuse')).filter((e) => e.rule === 'R16')).toHaveLength(12);
    expect(await t.db.all('SELECT version FROM region_decisions')).toEqual([]);
    // Un corps illisible ne range rien.
    expect(await t.regions.decide(t.direction, null)).toEqual({ ok: false, rule: null, code: 'bad_shape' });
    expect(await t.regions.decide(t.direction, ['53'])).toEqual({ ok: false, rule: null, code: 'bad_shape' });
    expect(await t.regions.decide(t.direction, { region: '53', open: true, reason: 'essai', force: true })).toEqual({ ok: false, rule: null, code: 'unknown_field' });
    expect(await t.regions.decide(t.direction, { region: '53', open: 'oui', reason: 'essai' })).toEqual({ ok: false, rule: null, code: 'bad_open' });
    expect(await t.regions.decide(t.direction, { region: '53', open: true, reason: ' a ' })).toEqual({ ok: false, rule: null, code: 'bad_reason' });
    expect(await t.regions.decide(t.direction, { region: '53', open: true, reason: 'x'.repeat(201) })).toEqual({ ok: false, rule: null, code: 'bad_reason' });
    expect(await t.db.all('SELECT version FROM region_decisions')).toEqual([]);
    // La lecture est écrite au journal.
    await t.report();
    expect(await t.events('regions.lecture')).toEqual([{ rule: 'R16', open: ['27'] }]);
  });

  it('[R653] le public ne lit que les noms des régions ouvertes, par ordre alphabétique, sans aucun chiffre', async () => {
    const t = await setup();
    expect(await t.regions.openRegionNames(t.network.id)).toEqual(['Bourgogne-Franche-Comté']);
    await t.openPhase5();
    await t.decide('11', true);
    t.setClock('2028-06-01T09:00:00.000Z');
    await t.decide('53', true);
    const names = await t.regions.openRegionNames(t.network.id);
    expect(names).toEqual(['Bourgogne-Franche-Comté', 'Bretagne', 'Île-de-France']);
    expect(names.every((n) => typeof n === 'string' && !/\d/.test(n))).toBe(true);
  });

  it('[R653] Jamais vu : la chaîne des décisions se vérifie, et une ligne réécrite ou retirée est dite avec sa version', async () => {
    const t = await setup();
    const empty = await t.regions.verify(t.direction);
    expect(empty).toEqual({ ok: true, value: { intact: true, versions: 0 } });
    await t.openPhase5();
    const a = await t.decide('11', true);
    const b = await t.decide('11', false);
    const c = await t.decide('53', true);
    if (!a.ok || !b.ok || !c.ok) throw new Error('décision refusée');
    const rows = await t.db.all<{ version: number; prev_hash: string; hash: string }>('SELECT version, prev_hash, hash FROM region_decisions ORDER BY version');
    expect(rows.map((r) => r.prev_hash)).toEqual([REGION_CHAIN_START, a.value.hash, b.value.hash]);
    expect(await t.regions.verify(t.direction)).toEqual({ ok: true, value: { intact: true, versions: 3 } });
    // L'empreinte se recalcule de façon indépendante.
    const first = await t.db.first<Record<string, unknown>>('SELECT * FROM region_decisions WHERE version = 1');
    expect(await regionDecisionHash(first as never)).toBe(a.value.hash);
    // Une ligne réécrite par une écriture directe, garde levée : la version 2 est dite cassée.
    t.raw.exec('DROP TRIGGER region_decisions_fige');
    t.raw.prepare("UPDATE region_decisions SET reason = 'réécrite' WHERE version = 2").run();
    expect(await t.regions.verify(t.direction)).toEqual({ ok: true, value: { intact: false, versions: 3, brokenAt: 2 } });
    // Même réécrite avec une empreinte recalculée, la version 2 reste la première dite cassée : le journal garde son empreinte.
    const two = await t.db.first<Record<string, unknown>>('SELECT * FROM region_decisions WHERE version = 2');
    t.raw.prepare('UPDATE region_decisions SET hash = ? WHERE version = 2').run(await regionDecisionHash(two as never));
    expect(await t.regions.verify(t.direction)).toEqual({ ok: true, value: { intact: false, versions: 3, brokenAt: 2 } });
    // Une ligne retirée : la version qui manque est dite.
    t.raw.exec('DROP TRIGGER region_decisions_garde');
    t.raw.prepare('DELETE FROM region_decisions WHERE version = 1').run();
    expect(await t.regions.verify(t.direction)).toEqual({ ok: true, value: { intact: false, versions: 2, brokenAt: 1 } });
    expect((await t.events('regions.verification')).map((e) => e.intact)).toEqual([true, true, false, false, false]);
  });
  it('[R653] une dernière version retirée ou une chaîne recalculée en entier se voient, recoupées avec le journal', async () => {
    const t = await setup();
    await t.openPhase5();
    await t.decide('11', true);
    await t.decide('11', false);
    t.raw.exec('DROP TRIGGER region_decisions_garde');
    t.raw.prepare('DELETE FROM region_decisions WHERE version = 2').run();
    // La région semble rouverte, mais la vérification le dit.
    expect(await t.regions.openRegionNames(t.network.id)).toContain('Île-de-France');
    expect(await t.regions.verify(t.direction)).toEqual({ ok: true, value: { intact: false, versions: 1, brokenAt: 2 } });

    const u = await setup();
    await u.openPhase5();
    await u.decide('11', true);
    await u.decide('11', false);
    // Chaîne réécrite en entier : raison changée, puis chaque empreinte recalculée dans l'ordre.
    u.raw.exec('DROP TRIGGER region_decisions_fige');
    u.raw.prepare("UPDATE region_decisions SET reason = 'réécrite' WHERE version = 1").run();
    let prev = REGION_CHAIN_START;
    for (const v of [1, 2]) {
      u.raw.prepare('UPDATE region_decisions SET prev_hash = ? WHERE version = ?').run(prev, v);
      const row = await u.db.first<Record<string, unknown>>('SELECT * FROM region_decisions WHERE version = ?', [v]);
      prev = await regionDecisionHash(row as never);
      u.raw.prepare('UPDATE region_decisions SET hash = ? WHERE version = ?').run(prev, v);
    }
    expect(await u.regions.verify(u.direction)).toEqual({ ok: true, value: { intact: false, versions: 2, brokenAt: 1 } });
  });

  it('[R651] deux décisions en même temps : la base garde la première, l’autre est refusée et dite au journal', async () => {
    const t = await setup();
    await t.openPhase5();
    const [a, b] = await Promise.all([t.decide('11', true), t.decide('53', true)]);
    const results = [a, b];
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toEqual([{ ok: false, rule: 'R651', code: 'conflit' }]);
    expect(await t.db.all('SELECT version FROM region_decisions')).toEqual([{ version: 1 }]);
    expect((await t.events('regions.refuse')).map((e) => e.code)).toEqual(['conflit']);
    expect(await t.regions.verify(t.direction)).toEqual({ ok: true, value: { intact: true, versions: 1 } });
  });
  it('[R653] une décision passée pendant la vérification ne la casse pas ; une décision jamais écrite au journal est dite après une minute', async () => {
    const t = await setup();
    await t.openPhase5();
    await t.decide('11', true);
    // Une seconde décision passe juste au moment où la vérification lit le journal.
    let injected = false;
    const db: SqlDatabase = {
      ...t.db,
      all: async (sql: string, params?: unknown[]) => {
        if (!injected && sql.includes('FROM journal')) {
          injected = true;
          const r = await t.decide('11', false);
          if (!r.ok) throw new Error(r.code);
        }
        return t.db.all(sql, params as never);
      },
    } as SqlDatabase;
    const racing = new RegionsOuvertes(db, t.journal, { now: t.now });
    expect(await racing.verify(t.direction)).toEqual({ ok: true, value: { intact: true, versions: 2 } });
    expect(injected).toBe(true);
    // Une décision rangée à la main, chaînée comme il faut, mais jamais écrite au journal.
    const last = await t.db.first<Record<string, unknown>>('SELECT hash FROM region_decisions WHERE version = 2');
    const row = { network_id: t.network.id, version: 3, region: '11', is_open: 1, reason: 'à la main', decided_by: 'direction:x', decided_at: t.now().toISOString(), phase5_hash: (await t.db.first<{ evidence_hash: string }>('SELECT evidence_hash FROM phase_openings WHERE phase = 5 AND network_id = ?', [t.network.id]))!.evidence_hash, prev_hash: last!.hash as string };
    const hash = await regionDecisionHash(row);
    t.raw
      .prepare('INSERT INTO region_decisions (network_id, version, region, is_open, reason, decided_by, decided_at, phase5_hash, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(row.network_id, row.version, row.region, row.is_open, row.reason, row.decided_by, row.decided_at, row.phase5_hash, row.prev_hash, hash);
    expect(await t.regions.verify(t.direction)).toEqual({ ok: true, value: { intact: true, versions: 3 } });
    t.setClock(new Date(t.now().getTime() + REGION_JOURNAL_GRACE_MS).toISOString());
    expect(await t.regions.verify(t.direction)).toEqual({ ok: true, value: { intact: false, versions: 3, brokenAt: 3 } });
  });
});
