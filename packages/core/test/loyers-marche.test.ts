import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { SqlJournalStore, applyMigrations, fromSyncSqlite, type SqlDatabase } from '../src/index.ts';
import { ANIL_CITATION, LoyersMarche, decimalToCents, medianCents, parseAnilCsv } from '../src/investir/index.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

const NOW = Date.parse('2027-09-14T08:00:00.000Z');
const HEADER = 'id_zone;INSEE_C;LIBGEO;EPCI;DEP;REG;loypredm2;lwr.IPm2;upr.IPm2;TYPPRED;nbobs_com;nbobs_mail;R2_adj';
/** Un jeu inventé au format de la Carte des loyers : communes et chiffres fictifs. */
const CSV = [
  HEADER,
  '1;99001;Commune Une;200000001;99;99;12,3456789;10,1;15,005;commune;120;800;0,71',
  '2;99002;Commune Deux;200000001;99;99;9,995;6,5;14,2;maille;12;40;0,55',
  '3;99003;"Commune ""Trois""";200000001;99;99;10;9,5;10,5;commune;45;300;0,8',
].join('\n');

async function setup() {
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  const journal = new SqlJournalStore(db);
  let clock = NOW;
  const now = (): Date => new Date((clock += 1000));
  await db.run("INSERT INTO networks (id, name, created_at) VALUES ('net-1', 'Réseau test', '2026-01-01T00:00:00.000Z')");
  const loyers = new LoyersMarche(db, journal, { now });
  const direction = { role: 'direction' as const, userId: 'dir-1', networkId: 'net-1' };
  return { db, journal, loyers, direction };
}

/** Des remises de clés inventées, rangées directement : seules les colonnes lues comptent ici. */
async function seedHandovers(db: SqlDatabase, insee: string, items: { rent: number; charges: number; area: number; on: string }[]) {
  await db.exec('PRAGMA foreign_keys = OFF');
  let n = (await db.first<{ n: number }>('SELECT count(*) AS n FROM rental_listings'))!.n;
  for (const it of items) {
    n += 1;
    const id = `l-${n}`;
    await db.run("INSERT INTO rental_listings (id, network_id, property_id, owner_person_id, created_by, created_at) VALUES (?, 'net-1', 'p', 'o', 'agent:a', '2026-01-01')", [id]);
    await db.run("INSERT INTO rental_listing_communes (listing_id, insee_code, recorded_by, recorded_at) VALUES (?, ?, 'agent:a', '2026-01-01')", [id, insee]);
    await db.run(
      `INSERT INTO rental_facts (listing_id, version, furnished, rent_cents, charges_cents, living_area_hundredths, energy_class, final_energy_kwh, build_year,
         electricity_over_15, gas, lease_start, recorded_by, recorded_at) VALUES (?, 1, 0, ?, ?, ?, 'C', 120, 1990, 0, 'aucune', ?, 'agent:a', '2026-01-01')`,
      [id, it.rent, it.charges, it.area, it.on],
    );
    await db.run(
      `INSERT INTO rental_handovers (id, listing_id, network_id, lease_id, inventory_id, handed_on, deposit_payee, first_rent_payee, deposit_cents,
         first_rent_cents, text, text_sha256, recorded_by, recorded_at) VALUES (?, ?, 'net-1', 'b', 'e', ?, 'proprietaire', 'proprietaire', 0, 0, 't', ?, 'agent:a', '2026-01-01')`,
      [`h-${n}`, id, it.on, 'a'.repeat(64)],
    );
  }
  await db.exec('PRAGMA foreign_keys = ON');
}

it('les nombres décimaux sont lus au centime, la moitié vers le haut, sans virgule flottante', () => {
  expect(decimalToCents('12,3456789')).toBe(1235);
  expect(decimalToCents('9,995')).toBe(1000);
  expect(decimalToCents('11.005')).toBe(1101);
  expect(decimalToCents('10')).toBe(1000);
  expect(decimalToCents('0,004')).toBe(0);
  for (const bad of ['', '-3', '12,3,4', 'abc', '1e3', '12 €']) expect(decimalToCents(bad), bad).toBeNull();
  expect(medianCents([3, 1, 2])).toBe(2);
  expect(medianCents([4, 1, 2, 3])).toBe(3);
});

it('un fichier mal formé est refusé ligne à ligne, toutes les lignes en cause nommées', () => {
  const bad = [
    HEADER,
    '1;99001;A;1;99;99;12,3;10;15;commune;120;800;0,7',
    '2;9900;B;1;99;99;12,3;10;15;commune;120;800;0,7',
    '3;99003;C;1;99;99;douze;10;15;commune;120;800;0,7',
    '4;99004;D;1;99;99;12,3;13;15;commune;120;800;0,7',
    '5;99005;E;1;99;99;12,3;10;15;commune;-4;800;0,7',
    '6;99001;F;1;99;99;12,3;10;15;commune;120;800;0,7',
    '7;99007;G;1;99;99;12,3',
  ].join('\n');
  expect(parseAnilCsv(bad)).toEqual({
    ok: false,
    code: 'lignes',
    errors: [
      { line: 3, code: 'insee' },
      { line: 4, code: 'loyer' },
      { line: 5, code: 'bornes' },
      { line: 6, code: 'observations' },
      { line: 7, code: 'doublon' },
      { line: 8, code: 'colonnes' },
    ],
  });
  expect(parseAnilCsv('INSEE_C;loyer\n99001;12')).toMatchObject({ ok: false, code: 'entete' });
  expect(parseAnilCsv(HEADER)).toMatchObject({ ok: false, code: 'vide' });
  const parsed = parseAnilCsv(`﻿${CSV}\r\n`);
  expect(parsed).toEqual({
    ok: true,
    rows: [
      { inseeCode: '99001', rentM2Cents: 1235, lowerM2Cents: 1010, upperM2Cents: 1501, observations: 120 },
      { inseeCode: '99002', rentM2Cents: 1000, lowerM2Cents: 650, upperM2Cents: 1420, observations: 12 },
      { inseeCode: '99003', rentM2Cents: 1000, lowerM2Cents: 950, upperM2Cents: 1050, observations: 45 },
    ],
  });
});

it('[R122] la mention de la source ANIL est exactement celle demandée', () => {
  expect(ANIL_CITATION).toBe('Estimations ANIL, à partir des données du Groupe SeLoger et de leboncoin');
});

it('[R122] aucun loyer écrit dans le code, aucune lecture en direct sur Internet', () => {
  const dir = fileURLToPath(new URL('../src/investir/', import.meta.url));
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.ts'))) {
    const code = readFileSync(dir + file, 'utf8');
    expect(code, file).not.toMatch(/\bfetch\s*\(|https?:\/\/|XMLHttpRequest|WebSocket/);
    // Aucun loyer au m² en dur : ni table de communes, ni montant à côté d'un code INSEE.
    expect(code, file).not.toMatch(/['"]\d{5}['"]\s*:\s*\d/);
  }
});

describeWithSqlite('Y02 · loyers de marché', () => {
  it('[R10] sans donnée, la réponse est « inconnu », jamais une valeur inventée', async () => {
    const t = await setup();
    expect(await t.loyers.marketRent('net-1', '99001', 'apartment')).toEqual({ status: 'inconnu', inseeCode: '99001', kind: 'apartment' });
    expect(await t.loyers.marketRent('net-1', 'Dijon', 'apartment')).toMatchObject({ status: 'inconnu' });
  });

  it('[R122] l’import de la direction est rangé avec source, millésime et empreinte ; la réponse cite l’ANIL et dit sa fiabilité', async () => {
    const t = await setup();
    const r = await t.loyers.importAnil(t.direction, { kind: 'apartment', vintage: 2026, csv: CSV });
    expect(r).toMatchObject({ ok: true, rows: 3, stored: 3, status: 'complet', created: true });
    const one = await t.loyers.marketRent('net-1', '99001', 'apartment');
    expect(one).toMatchObject({
      status: 'connu',
      kind: 'apartment',
      rentM2Cents: 1235,
      lowerM2Cents: 1010,
      upperM2Cents: 1501,
      observations: 120,
      source: 'anil',
      vintage: 2026,
      citation: `${ANIL_CITATION}, millésime 2026`,
      reliability: 'fiable',
      reasons: [],
    });
    expect(one.status === 'connu' && one.asOf).toMatch(/^2027-09-14T/);
    // 12 observations et un intervalle de 77 % : peu d'observations, pour les deux raisons.
    expect(await t.loyers.marketRent('net-1', '99002', 'apartment')).toMatchObject({ reliability: 'peu_observations', reasons: ['observations', 'intervalle'] });
    // Un appartement de 3 pièces sans fichier propre lit celui des appartements.
    expect(await t.loyers.marketRent('net-1', '99003', 'apartment_t3_plus')).toMatchObject({ status: 'connu', kind: 'apartment', rentM2Cents: 1000 });
    // Une maison n'emprunte pas le chiffre des appartements.
    expect(await t.loyers.marketRent('net-1', '99003', 'house')).toMatchObject({ status: 'inconnu' });

    const imp = await t.db.first<{ source: string; vintage: number; file_sha256: string; status: string; imported_by: string }>(
      'SELECT source, vintage, file_sha256, status, imported_by FROM market_rent_imports',
    );
    expect(imp).toMatchObject({ source: 'anil', vintage: 2026, status: 'complet', imported_by: 'direction:dir-1' });
    expect(imp!.file_sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('[R17] un import plus récent s’ajoute, l’ancien reste ; le même fichier ne range rien de plus ; rien ne s’efface', async () => {
    const t = await setup();
    const first = await t.loyers.importAnil(t.direction, { kind: 'apartment', vintage: 2025, csv: CSV });
    expect(await t.loyers.importAnil(t.direction, { kind: 'apartment', vintage: 2025, csv: CSV })).toMatchObject({ ok: true, created: false });
    const newer = CSV.replace('12,3456789;10,1;15,005', '13,10;11;15,2');
    expect(await t.loyers.importAnil(t.direction, { kind: 'apartment', vintage: 2026, csv: newer })).toMatchObject({ ok: true, created: true });
    expect(await t.loyers.marketRent('net-1', '99001', 'apartment')).toMatchObject({ rentM2Cents: 1310, vintage: 2026 });
    expect(Number((await t.db.first<{ n: number }>('SELECT count(*) AS n FROM market_rents'))!.n)).toBe(6);
    expect(Number((await t.db.first<{ n: number }>('SELECT count(*) AS n FROM market_rent_imports'))!.n)).toBe(2);
    const id = first.ok ? first.importId : '';
    await expect(t.db.run('DELETE FROM market_rents WHERE import_id = ?', [id])).rejects.toThrow(/rien ne s'efface/);
    await expect(t.db.run('UPDATE market_rents SET rent_m2_cents = 1 WHERE import_id = ?', [id])).rejects.toThrow(/ne change plus/);
    await expect(t.db.run('UPDATE market_rent_imports SET vintage = 2020 WHERE id = ?', [id])).rejects.toThrow(/ne change plus/);
    await expect(t.db.run('DELETE FROM market_rent_imports WHERE id = ?', [id])).rejects.toThrow(/rien ne s'efface/);
    await expect(
      t.db.run("INSERT INTO market_rents (import_id, insee_code, rent_m2_cents, lower_m2_cents, upper_m2_cents, observations) VALUES (?, '99009', 1000, 900, 1100, 50)", [id]),
    ).rejects.toThrow(/import fermé/);
  });

  it('un gros fichier se range en plusieurs appels, chacun sous la limite de requêtes, repris après les lignes rangées', async () => {
    const t = await setup();
    const rows = Array.from({ length: 100 }, (_, i) => `${i};${String(98000 + i)};C;1;99;99;10,5;9;12;commune;50;100;0,7`);
    const csv = [HEADER, ...rows].join('\n');
    let queries = 0;
    const counted: SqlDatabase = {
      exec: (sql) => t.db.exec(sql),
      run: (sql, params) => ((queries += 1), t.db.run(sql, params)),
      all: (sql, params) => ((queries += 1), t.db.all(sql, params)),
      first: (sql, params) => ((queries += 1), t.db.first(sql, params)),
    };
    const loyers = new LoyersMarche(counted, t.journal, { now: () => new Date(NOW), maxChunksPerCall: 2 });
    const calls: { status: string; stored: number }[] = [];
    let maxQueries = 0;
    for (let n = 0; n < 10; n += 1) {
      queries = 0;
      const r = await loyers.importAnil(t.direction, { kind: 'house', vintage: 2026, csv });
      maxQueries = Math.max(maxQueries, queries);
      if (!r.ok) throw new Error(r.code);
      calls.push({ status: r.status, stored: r.stored });
      if (r.status === 'complet') break;
    }
    // 16 lignes par paquet, 2 paquets par appel : 32, 64, 96, puis 100.
    expect(calls).toEqual([
      { status: 'en_cours', stored: 32 },
      { status: 'en_cours', stored: 64 },
      { status: 'en_cours', stored: 96 },
      { status: 'complet', stored: 100 },
    ]);
    // Les paquets plus les lectures et le journal : bien sous les 1 000 requêtes d'un appel sur D1.
    expect(maxQueries).toBeLessThan(20);
    // Complet, il est lu.
    expect(await t.loyers.marketRent('net-1', '98099', 'house')).toMatchObject({ status: 'connu', rentM2Cents: 1050 });
  });

  it('un import resté en cours n’est jamais lu', async () => {
    const t = await setup();
    const loyers = new LoyersMarche(t.db, t.journal, { now: () => new Date(NOW), maxChunksPerCall: 1 });
    const rows = Array.from({ length: 20 }, (_, i) => `${i};${String(97000 + i)};C;1;99;99;10,5;9;12;commune;50;100;0,7`);
    expect(await loyers.importAnil(t.direction, { kind: 'house', vintage: 2026, csv: [HEADER, ...rows].join('\n') })).toMatchObject({ ok: true, status: 'en_cours', stored: 16 });
    expect(await t.loyers.marketRent('net-1', '97000', 'house')).toMatchObject({ status: 'inconnu' });
  });

  it('un fichier mal formé ne range rien, et le refus va au journal sans aucun chiffre du fichier', async () => {
    const t = await setup();
    const bad = `${CSV}\n4;99004;D;1;99;99;8,77;9,9;15;commune;120;800;0,7`;
    const r = await t.loyers.importAnil(t.direction, { kind: 'apartment', vintage: 2026, csv: bad });
    expect(r).toMatchObject({ ok: false, rule: 'R122', code: 'lignes', errors: [{ line: 5, code: 'bornes' }] });
    expect(Number((await t.db.first<{ n: number }>('SELECT count(*) AS n FROM market_rents'))!.n)).toBe(0);
    expect(Number((await t.db.first<{ n: number }>('SELECT count(*) AS n FROM market_rent_imports'))!.n)).toBe(0);
    expect(await t.loyers.importAnil(t.direction, { kind: 'studio', vintage: 2026, csv: CSV })).toMatchObject({ ok: false, code: 'type' });
    expect(await t.loyers.importAnil(t.direction, { kind: 'apartment', vintage: 2031, csv: CSV })).toMatchObject({ ok: false, code: 'millesime' });
    const events = (await t.journal.all()).filter((e) => e.type === 'investir.loyers.refuse');
    expect(events.map((e) => (e.data as { code: string }).code)).toEqual(['lignes', 'type', 'millesime']);
    expect(JSON.stringify(events)).not.toMatch(/8,77|99004/);
  });

  it('[R16] seule la direction importe ; un agent est refusé, au journal', async () => {
    const t = await setup();
    const r = await t.loyers.importAnil({ role: 'agent', userId: 'a-1', networkId: 'net-1' }, { kind: 'apartment', vintage: 2026, csv: CSV });
    expect(r).toEqual({ ok: false, rule: 'R16', code: 'role' });
    expect((await t.journal.all()).some((e) => e.type === 'acces.refuse' && e.actor === 'agent:a-1')).toBe(true);
    expect(Number((await t.db.first<{ n: number }>('SELECT count(*) AS n FROM market_rent_imports'))!.n)).toBe(0);
  });

  it('[R122] repli sur les locations du réseau : au moins 5 dans la commune sur 24 mois, sinon « inconnu »', async () => {
    const t = await setup();
    const inside = [
      { rent: 60_000, charges: 5_000, area: 5_000, on: '2026-03-01' }, // 13,00 €/m²
      { rent: 70_000, charges: 0, area: 6_000, on: '2026-06-10' }, // 11,67 €/m²
      { rent: 55_000, charges: 4_000, area: 4_500, on: '2027-01-20' }, // 13,11 €/m²
      { rent: 80_000, charges: 8_000, area: 8_000, on: '2027-05-02' }, // 11,00 €/m²
    ];
    await seedHandovers(t.db, '99005', inside);
    // Hors fenêtre de 24 mois, et dans une autre commune : ne comptent pas.
    await seedHandovers(t.db, '99005', [{ rent: 100_000, charges: 0, area: 5_000, on: '2025-09-13' }]);
    await seedHandovers(t.db, '99006', [{ rent: 100_000, charges: 0, area: 5_000, on: '2027-01-01' }]);
    expect(await t.loyers.marketRent('net-1', '99005', 'apartment')).toEqual({ status: 'inconnu', inseeCode: '99005', kind: 'apartment' });
    await seedHandovers(t.db, '99005', [{ rent: 62_000, charges: 3_000, area: 5_200, on: '2027-08-30' }]); // 12,50 €/m²
    const r = await t.loyers.marketRent('net-1', '99005', 'apartment');
    // Calcul à la main : 1100, 1167, 1250, 1300, 1311 → médiane 1250, bornes 1100 et 1311.
    expect(r).toMatchObject({
      status: 'connu',
      kind: 'all',
      source: 'reseau',
      rentM2Cents: 1250,
      lowerM2Cents: 1100,
      upperM2Cents: 1311,
      observations: 5,
      vintage: null,
      importId: null,
      reliability: 'peu_observations',
      reasons: ['observations'],
    });
    expect(r.status === 'connu' && r.citation).toBe('Locations du réseau AIMMO : 5 logements remis aux locataires dans la commune sur 24 mois');
    // L'ANIL, quand elle existe pour la commune, passe avant le réseau.
    await t.loyers.importAnil(t.direction, { kind: 'apartment', vintage: 2026, csv: `${HEADER}\n9;99005;X;1;99;99;14;12;16;commune;80;300;0,7` });
    expect(await t.loyers.marketRent('net-1', '99005', 'apartment')).toMatchObject({ source: 'anil', rentM2Cents: 1400 });
  });
});
