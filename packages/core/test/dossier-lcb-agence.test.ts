import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { FicheClient, SqlJournalStore, applyMigrations, fromSyncSqlite, type SqlDatabase, type Viewer } from '../src/index.ts';
import { PortesPhases, type PhaseConditionReading } from '../src/conditions-phases/index.ts';
import { CHEMINS_LCB, DOSSIER_LCB_FORMAT, DossierLcbAgences, ORDRE_LCB, filtreLcb, ordreLcb, piecesDe } from '../src/conformite/index.ts';
import { LicencesLogiciel, RepriseDonneesAgence, tablesLcbFt } from '../src/licences/index.ts';
import { ClesAppareil } from '../src/securite/index.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

// Tout est inventé : réseaux d'essai, agences, SIREN (clé juste, aucune entreprise réelle visée), cartes, personnes,
// pièces, signalements et registre des gels.
const met = (): PhaseConditionReading => ({ met: true, reasons: [], evidence: { essai: 1 } });
const AGENCE = { agencyName: 'Agence du Lac (essai)', siren: '123456782', cardNumber: 'CPI 7501 2027 000 000 001', cardExpiresOn: '2030-06-30', department: '75' };
const AUTRE = { agencyName: 'Agence des Prés (essai)', siren: '732829320', cardNumber: 'CPI 2101 2027 000 000 002', cardExpiresOn: '2030-06-30', department: '21' };

async function openDb() {
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  return db;
}

/** Les clés étrangères de chaque table, telles que la base les dit (dans le test seulement). */
async function fksOf(db: SqlDatabase, table: string) {
  return db.all<{ table: string; from: string; to: string }>(`PRAGMA foreign_key_list(${table})`);
}
async function colsOf(db: SqlDatabase, table: string) {
  return (await db.all<{ name: string }>(`PRAGMA table_info(${table})`)).map((r) => r.name);
}

async function setup(opts: { fillLcb?: boolean } = {}) {
  const db = await openDb();
  let clock = Date.parse('2028-01-10T09:00:00.000Z');
  const now = (): Date => new Date(clock);
  const journal = new SqlJournalStore(db);
  const store = new FicheClient(db, { now });
  const network = await store.createNetwork('Réseau test');
  const as = (role: string, userId: string, networkId = network.id): Viewer => ({ role, userId, networkId }) as Viewer;
  const direction = as('direction', 'direction-1');
  const licences = new LicencesLogiciel(db, journal, { now });
  const portes = new PortesPhases(db, journal, { now, sources: { 1: async () => met(), 2: async () => met(), 3: async () => met(), 4: async () => met() } });
  for (const phase of [2, 3, 4, 5]) {
    const r = await portes.open(direction, { phase });
    if (!r.ok) throw new Error(r.code);
  }
  await licences.setTariff(direction, { monthlyCents: 29900, reason: 'Tarif d’essai' });
  const grant = async (input: typeof AGENCE) => {
    const r = await licences.grant(direction, input);
    if (!r.ok) throw new Error(r.code);
    return r.value;
  };
  const lac = await grant(AGENCE);
  const pres = await grant(AUTRE);
  const proofs: { subject: string; stepUpId: unknown }[] = [];
  const gate = {
    requireSecondFactor: async (_v: Viewer, _a: 'export_complet', subject: string, stepUpId: unknown) => {
      proofs.push({ subject, stepUpId });
      return stepUpId === 'preuve-ok' ? ({ ok: true } as const) : ({ ok: false, rule: 'R601', code: 'second_factor_required' } as const);
    },
  };
  const reads: string[] = [];
  const watched: SqlDatabase = {
    ...db,
    all: async (sql, params) => {
      reads.push(sql);
      return db.all(sql, params) as never;
    },
  } as SqlDatabase;
  const dossier = new DossierLcbAgences(watched, journal, gate, { now });
  const reprise = new RepriseDonneesAgence(db, journal, gate, { now });
  const lacCompliance = as('compliance', 'conformite-lac', lac.licenseeNetworkId);
  const lacDirection = as('direction', 'direction-lac', lac.licenseeNetworkId);
  // AU089 : dans chaque agence, la direction a nommé son responsable ; lui seul tire le dossier [R94].
  for (const [net, officer] of [[lac.licenseeNetworkId, 'conformite-lac'], [pres.licenseeNetworkId, 'conformite-pres']] as const) {
    await db.run('INSERT INTO lcb_officers (network_id, seq, officer_user_id, designated_by, designated_at) VALUES (?, 1, ?, ?, ?)', [net, officer, 'direction:essai', '2028-01-01T08:00:00.000Z']);
  }
  const events = async (type: string): Promise<Record<string, unknown>[]> => (await db.all<{ data: string; subject: string }>('SELECT data, subject FROM journal WHERE type = ?', [type])).map((e) => ({ ...(JSON.parse(e.data) as Record<string, unknown>), subject: e.subject }));

  // Un même jeu dans chaque réseau : une personne, une pièce au coffre, un signalement et sa décision, une version du
  // registre des gels et une entrée (table sans `network_id`, trouvée par sa version).
  const at = '2028-01-09T08:00:00.000Z';
  const fill = async (net: string, tag: string) => {
    await db.run('INSERT INTO persons (id, network_id, first_name, last_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', [`personne-${tag}`, net, 'Alix', `Essai ${tag}`, at, at]);
    await db.run(
      "INSERT INTO compliance_vault_pieces (id, network_id, person_id, kind, storage_ref, sha256, content_type, size_bytes, verified_on, deposited_by, deposited_at) VALUES (?, ?, ?, 'carte_identite', ?, ?, 'application/pdf', 1234, '2028-01-09', 'agent:essai', ?)",
      [`piece-${tag}`, net, `personne-${tag}`, `coffre-test/${tag}/1`, tag.charAt(0).repeat(64).replace(/[^a-f]/g, 'e'), at],
    );
    await db.run('INSERT INTO suspicion_reports (id, network_id, case_ref, person_id, note, snapshot, snapshot_sha256, reported_by, reported_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [
      `signalement-${tag}`,
      net,
      `dossier-${tag}`,
      `personne-${tag}`,
      `Paiement proposé en espèces (essai ${tag}). Lien : https://exemple.test/espace/AbCdEf0123456789xyz_${tag}`,
      '{}',
      'c'.repeat(64),
      'agent:essai',
      at,
    ]);
    await db.run("INSERT INTO suspicion_decisions (report_id, network_id, decision, reason, validator_name, decided_by, decided_on, at) VALUES (?, ?, 'pas_de_declaration', 'Explication reçue (essai).', 'Responsable Essai', 'compliance:essai', '2028-01-09', ?)", [
      `signalement-${tag}`,
      net,
      at,
    ]);
    await db.run("INSERT INTO freeze_registry_versions (id, network_id, published_at, sha256, entries, imported_by, imported_at) VALUES (?, ?, '2028-01-08T00:00:00.000Z', ?, 1, 'compliance:essai', ?)", [`gel-${tag}`, net, 'd'.repeat(64), at]);
    await db.run("INSERT INTO freeze_registry_entries (version_id, entry_id, nature, names) VALUES (?, ?, 'personne_physique', ?)", [`gel-${tag}`, `entree-${tag}`, JSON.stringify([`nom inventé ${tag}`])]);
  };
  if (opts.fillLcb !== false) {
    await fill(lac.licenseeNetworkId, 'lac');
    await fill(pres.licenseeNetworkId, 'pres');
    await fill(network.id, 'reseau');
  }
  const tick = (ms: number) => {
    clock += ms;
  };
  return { db, journal, now, network, direction, as, lac, pres, dossier, reprise, licences, lacCompliance, lacDirection, proofs, events, reads, tick };
}

describeWithSqlite('HX76 · Le dossier de la lutte contre le blanchiment de l’agence sous licence', () => {
  it('[R662] l’ordre de lecture couvre chaque table du traitement, une seule fois, et chaque chemin suit une vraie clé', async () => {
    const db = await openDb();
    const lcb = tablesLcbFt();
    expect(new Set(ORDRE_LCB)).toEqual(new Set(lcb));
    expect(ordreLcb()).toHaveLength(lcb.length);
    expect(lcb).toContain('licence_lcb_exports');
    for (const t of lcb) {
      const cols = await colsOf(db, t);
      expect(cols.length, t).toBeGreaterThan(0);
      if (cols.includes('network_id')) {
        expect(CHEMINS_LCB[t], t).toBeUndefined();
        continue;
      }
      // Une table sans `network_id` a un chemin, vers une table du traitement qui en a une, par une vraie clé.
      const path = CHEMINS_LCB[t];
      expect(path, t).toBeDefined();
      const [col, from, key] = path!;
      expect(lcb).toContain(from);
      expect(await colsOf(db, from)).toContain('network_id');
      expect((await fksOf(db, t)).some((f) => f.from === col && f.table === from && f.to === key)).toBe(true);
    }
    for (const t of Object.keys(CHEMINS_LCB)) expect(lcb).toContain(t);
  });

  it('[R662] chaque table se lit avant celles qu’elle désigne, vérifié sur les clés des migrations', async () => {
    const db = await openDb();
    const pos = new Map(ORDRE_LCB.map((t, i) => [t, i]));
    const wrong: string[] = [];
    for (const t of ORDRE_LCB) for (const f of await fksOf(db, t)) if (f.table !== t && pos.has(f.table) && pos.get(f.table)! < pos.get(t)!) wrong.push(`${t}>${f.table}`);
    expect(wrong).toEqual([]);
    expect(filtreLcb('freeze_registry_entries', 'n1')).toEqual({ sql: 'version_id IN (SELECT id FROM freeze_registry_versions WHERE network_id = ?)', params: ['n1'] });
  });

  it('[R662] [R16] seul le responsable de la conformité de l’agence le tire ; ni sa direction, ni le réseau qui donne la licence', async () => {
    const t = await setup();
    expect(await t.dossier.make(t.lacDirection, 'preuve-ok')).toEqual({ ok: false, rule: 'R16', code: 'role' });
    expect(await t.dossier.make(t.as('agent', 'agent-lac', t.lac.licenseeNetworkId), 'preuve-ok')).toEqual({ ok: false, rule: 'R16', code: 'role' });
    expect(await t.dossier.make(t.as('compliance', 'conformite-reseau'), 'preuve-ok')).toEqual({ ok: false, rule: 'R662', code: 'pas_de_licence' });
    expect(t.proofs).toEqual([]);
    expect(t.reads).toEqual([]);
    expect((await t.events('conformite.refuse')).map((e) => e.code)).toEqual(['role', 'role', 'pas_de_licence']);
  });

  it('[R94] AU089 · un compte conformité qui n’est pas le dernier responsable nommé ne tire pas le dossier, rien n’est lu', async () => {
    const t = await setup();
    // Un autre compte conformité de l'agence, jamais nommé.
    expect(await t.dossier.make(t.as('compliance', 'conformite-stagiaire', t.lac.licenseeNetworkId), 'preuve-ok')).toEqual({ ok: false, rule: 'R16', code: 'pas_responsable' });
    // La direction nomme un nouveau responsable : l'ancien ne tire plus rien.
    await t.db.run("INSERT INTO lcb_officers (network_id, seq, officer_user_id, designated_by, designated_at) VALUES (?, 2, 'conformite-lac-2', 'direction:essai', '2028-01-05T08:00:00.000Z')", [t.lac.licenseeNetworkId]);
    expect(await t.dossier.make(t.lacCompliance, 'preuve-ok')).toEqual({ ok: false, rule: 'R16', code: 'pas_responsable' });
    expect(t.proofs).toEqual([]);
    expect(t.reads).toEqual([]);
    const r = await t.dossier.make(t.as('compliance', 'conformite-lac-2', t.lac.licenseeNetworkId), 'preuve-ok');
    expect(r.ok).toBe(true);
  });

  it('[R601] la vraie porte du second facteur accepte le sujet du dossier, et refuse sans preuve', async () => {
    const t = await setup();
    const gate = new ClesAppareil(t.db, t.journal, { rpId: 'app.aimmo.test', origins: ['https://app.aimmo.test'], now: t.now });
    const dossier = new DossierLcbAgences(t.db, t.journal, gate, { now: t.now });
    // Un sujet mal formé donnerait `bad_input` : la porte n'accepterait jamais aucune preuve pour ce dossier.
    expect(await dossier.make(t.lacCompliance)).toEqual({ ok: false, rule: 'R601', code: 'second_factor_required' });
    expect(await dossier.make(t.lacCompliance, 'preuve-inventee')).toEqual({ ok: false, rule: 'R601', code: 'second_factor_required' });
    expect(await t.db.all('SELECT id FROM licence_lcb_exports')).toEqual([]);
  });

  it('[R601] sans second facteur, rien n’est lu', async () => {
    const t = await setup();
    expect(await t.dossier.make(t.lacCompliance)).toEqual({ ok: false, rule: 'R601', code: 'second_factor_required' });
    expect(t.proofs).toEqual([{ subject: `licence_lcb:${t.lac.id}`, stepUpId: undefined }]);
    expect(t.reads).toEqual([]);
    expect(await t.db.all('SELECT id FROM licence_lcb_exports')).toEqual([]);
  });

  it('[R662] le dossier porte chaque table du traitement, toutes les lignes de l’agence et aucune d’un autre réseau', async () => {
    const t = await setup();
    const r = await t.dossier.make(t.lacCompliance, 'preuve-ok');
    if (!r.ok) throw new Error(r.code);
    const doc = r.value.document;
    expect(doc.format).toBe(DOSSIER_LCB_FORMAT);
    expect(Object.keys(doc.tables)).toEqual([...tablesLcbFt()].sort());
    // Lu enfants d'abord, dans l'ordre déclaré.
    expect(t.reads.map((s) => /^SELECT \* FROM (\w+) /.exec(s)?.[1])).toEqual([...ORDRE_LCB]);
    expect(doc.tables.compliance_vault_pieces!.map((p) => p.id)).toEqual(['piece-lac']);
    expect(doc.tables.suspicion_reports!.map((p) => p.id)).toEqual(['signalement-lac']);
    expect(doc.tables.suspicion_decisions!.map((p) => p.report_id)).toEqual(['signalement-lac']);
    expect(doc.tables.freeze_registry_entries!.map((p) => p.entry_id)).toEqual(['entree-lac']);
    const text = JSON.stringify(doc);
    expect(text).not.toMatch(/pres|reseau/);
    expect(text).toContain('Paiement proposé en espèces (essai lac)');
    // Un lien qui porte un jeton est masqué, comme au fichier de reprise.
    expect(text).not.toContain('AbCdEf0123456789xyz');
  });

  it('[R663] AIMMO range l’empreinte seule ; le journal ne porte qu’elle, sans aucun compte', async () => {
    const t = await setup();
    const r = await t.dossier.make(t.lacCompliance, 'preuve-ok');
    if (!r.ok) throw new Error(r.code);
    const stored = await t.db.all('SELECT * FROM licence_lcb_exports');
    expect(stored).toEqual([{ id: expect.any(String), licence_id: t.lac.id, network_id: t.lac.licenseeNetworkId, fingerprint: r.value.fingerprint, made_by: 'compliance:conformite-lac', made_at: '2028-01-10T09:00:00.000Z' }]);
    expect(await t.events('conformite.dossier_lcb_remis')).toEqual([{ rule: 'R663', fingerprint: r.value.fingerprint, subject: `licence:${t.lac.id}` }]);
  });

  it('[R663] [R17] la base refuse une remise par un autre rôle, à un autre réseau, un changement ou un effacement', async () => {
    const t = await setup();
    const ins = (net: string, by: string, fp = 'a'.repeat(64)) =>
      t.db.run('INSERT INTO licence_lcb_exports (id, licence_id, network_id, fingerprint, made_by, made_at) VALUES (?, ?, ?, ?, ?, ?)', [crypto.randomUUID(), t.lac.id, net, fp, by, 'x']);
    await expect(ins(t.lac.licenseeNetworkId, 'direction:direction-lac')).rejects.toThrow();
    await expect(ins(t.network.id, 'compliance:conformite-reseau')).rejects.toThrow(/qu'à l'agence de la licence/);
    await expect(ins(t.pres.licenseeNetworkId, 'compliance:x')).rejects.toThrow(/qu'à l'agence de la licence/);
    await expect(ins(t.lac.licenseeNetworkId, 'compliance:x', 'pas une empreinte')).rejects.toThrow();
    await ins(t.lac.licenseeNetworkId, 'compliance:x');
    await expect(t.db.run('DELETE FROM licence_lcb_exports')).rejects.toThrow(/rien ne s'efface/);
    await expect(t.db.run("UPDATE licence_lcb_exports SET made_at = 'y'")).rejects.toThrow(/ne change plus/);
  });

  it('[R663] Jamais vu : le fichier de reprise de la direction, le registre des remises et le journal sont les mêmes avec ou sans dossier rempli', async () => {
    const vide = await setup({ fillLcb: false });
    const plein = await setup({ fillLcb: true });
    // La même agence, la même fiche de client : seule la lutte contre le blanchiment diffère (pièce, signalement, gel).
    const at = '2028-01-09T08:00:00.000Z';
    await vide.db.run('INSERT INTO persons (id, network_id, first_name, last_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', ['personne-lac', vide.lac.licenseeNetworkId, 'Alix', 'Essai lac', at, at]);
    // Les identifiants tirés au hasard (réseaux, licences, lignes) et les empreintes ne sont pas ceux d'une base à
    // l'autre : ils sont remplacés par des repères, tout le reste est comparé tel quel, comptes compris.
    const norm = (t: typeof vide, v: unknown): string => {
      let out = JSON.stringify(v);
      [t.network.id, t.lac.id, t.lac.licenseeNetworkId, t.pres.id, t.pres.licenseeNetworkId].forEach((id, i) => (out = out.split(id).join(`<id${i}>`)));
      return out.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<uuid>').replace(/\b[0-9a-f]{64}\b/g, '<empreinte>');
    };
    // Une table ou une liste comparée comme un ensemble : son ordre peut suivre un identifiant tiré au hasard.
    const bag = (t: typeof vide, rows: readonly unknown[]) => rows.map((r) => norm(t, r)).sort();
    const reprise = async (t: typeof vide) => {
      const r = await t.reprise.make(t.lacDirection, 'preuve-ok');
      if (!r.ok) throw new Error(r.code);
      const d = r.value.document;
      return {
        tables: Object.fromEntries(Object.entries(d.tables).map(([k, rows]) => [k, bag(t, rows)])),
        laissees: norm(t, d.laissees),
        masquees: norm(t, d.masquees),
        fichiers: bag(t, d.fichiers),
        rows: r.value.rows,
      };
    };
    const traces = async (t: typeof vide) => ({
      journal: bag(t, (await t.db.all<{ type: string; actor: string; subject: string; data: string }>("SELECT type, actor, subject, data FROM journal WHERE type LIKE 'conformite.%' OR type LIKE 'licences.%' OR type LIKE 'acces.%'")).map((e) => ({ ...e, data: JSON.parse(e.data) as unknown }))),
      remises: bag(t, await t.db.all('SELECT * FROM licence_data_exports')),
      dossiers: bag(t, await t.db.all('SELECT * FROM licence_lcb_exports')),
    });
    const seen: unknown[][] = [[], []];
    for (const [i, t] of [vide, plein].entries()) {
      // Une reprise avant le dossier, le dossier, une reprise après : à chaque pas, les mêmes traces.
      seen[i]!.push(await reprise(t));
      t.tick(1000);
      const d = await t.dossier.make(t.lacCompliance, 'preuve-ok');
      if (!d.ok) throw new Error(d.code);
      t.tick(1000);
      seen[i]!.push(await reprise(t));
      seen[i]!.push(await traces(t));
    }
    expect(seen[1]).toEqual(seen[0]);
    // Et le dossier lui-même diffère bien : la comparaison porte sur quelque chose.
    const dv = await vide.dossier.make(vide.lacCompliance, 'preuve-ok');
    const dp = await plein.dossier.make(plein.lacCompliance, 'preuve-ok');
    expect(dv.ok && dp.ok && dv.value.document.tables.suspicion_reports!.length !== dp.value.document.tables.suspicion_reports!.length).toBe(true);
  });

  it('[R662] licence suspendue ou terminée : le dossier se remet toujours, et se vérifie', async () => {
    const t = await setup();
    for (const state of ['suspendue', 'terminee'] as const) {
      const d = await t.licences.decide(t.direction, { licenceId: t.lac.id, state, reason: 'Essai de fin' });
      expect(d.ok).toBe(true);
      t.tick(1000);
      const r = await t.dossier.make(t.lacCompliance, 'preuve-ok');
      if (!r.ok) throw new Error(r.code);
      expect(r.value.document.tables.suspicion_reports!.map((x) => x.id)).toEqual(['signalement-lac']);
      const v = await t.dossier.verify(t.lacCompliance, r.value.document);
      expect(v.ok && v.value.verified).toBe(true);
    }
    expect((await t.db.all('SELECT id FROM licence_lcb_exports')).length).toBe(2);
  });

  it('[R664] chaque pièce du coffre est dite avec sa référence et son empreinte ; la vérification recalcule tout', async () => {
    const t = await setup();
    const r = await t.dossier.make(t.lacCompliance, 'preuve-ok');
    if (!r.ok) throw new Error(r.code);
    const doc = r.value.document;
    expect(doc.pieces).toEqual([{ id: 'piece-lac', storageRef: 'coffre-test/lac/1', sha256: 'e'.repeat(64), contentType: 'application/pdf', sizeBytes: 1234 }]);
    expect(piecesDe(doc.tables)).toEqual(doc.pieces);
    expect(await t.dossier.verify(t.lacCompliance, doc)).toEqual({ ok: true, value: { verified: true, fingerprint: r.value.fingerprint, complete: true, missing: [], piecesComplete: true } });
    // Un octet changé : le dossier n'est plus celui remis.
    const changed = JSON.parse(JSON.stringify(doc)) as typeof doc;
    changed.tables.suspicion_reports![0]!.note = 'Autre texte';
    const v1 = await t.dossier.verify(t.lacCompliance, changed);
    expect(v1.ok && v1.value.verified).toBe(false);
    // Une pièce retirée de la liste : la liste ne concorde plus avec les lignes.
    const sansPiece = { ...doc, pieces: [] };
    const v2 = await t.dossier.verify(t.lacCompliance, sansPiece);
    expect(v2.ok && [v2.value.verified, v2.value.piecesComplete]).toEqual([false, false]);
    // Une table retirée : dite manquante.
    const { suspicion_decisions: _drop, ...rest } = doc.tables;
    const v3 = await t.dossier.verify(t.lacCompliance, { ...doc, tables: rest });
    expect(v3.ok && [v3.value.complete, v3.value.missing]).toEqual([false, ['suspicion_decisions']]);
  });

  it('[R662] la vérification est au responsable de cette agence seul ; un dossier d’un autre réseau n’y est rien', async () => {
    const t = await setup();
    const r = await t.dossier.make(t.lacCompliance, 'preuve-ok');
    if (!r.ok) throw new Error(r.code);
    expect(await t.dossier.verify(t.lacDirection, r.value.document)).toEqual({ ok: false, rule: 'R16', code: 'role' });
    const none = { verified: false, fingerprint: null, complete: false, missing: [], piecesComplete: false };
    expect(await t.dossier.verify(t.as('compliance', 'conformite-pres', t.pres.licenseeNetworkId), r.value.document)).toEqual({ ok: true, value: none });
    expect(await t.dossier.verify(t.lacCompliance, { format: 'autre' })).toEqual({ ok: true, value: none });
    expect(await t.dossier.verify(t.lacCompliance, null)).toEqual({ ok: true, value: none });
  });

  it('[R662] seuls deux fichiers lisent les tables du traitement depuis le registre : la reprise les laisse, le dossier les remet', () => {
    const roots = ['../src', '../../api/src'].map((r) => fileURLToPath(new URL(r, import.meta.url)));
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith('.ts')) files.push(p);
      }
    };
    roots.forEach(walk);
    const users = files.filter((f) => /\btablesLcbFt\(/.test(readFileSync(f, 'utf8'))).map((f) => f.split(/[\\/]/).slice(-2).join('/'));
    expect(users.sort()).toEqual(['conformite/dossier-lcb-agence.ts', 'licences/reprise.ts']);
    // Le dossier ne nomme pas les tables du signalement ni du gel : il ne les lit que pour les remettre entières.
    const src = readFileSync(fileURLToPath(new URL('../src/conformite/dossier-lcb-agence.ts', import.meta.url)), 'utf8');
    expect(src).not.toMatch(/SignalementSoupcon|ControleGels/);
  });
});
