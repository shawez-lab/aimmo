import { expect, it } from 'vitest';
import { FicheClient, SqlJournalStore, applyMigrations, fromSyncSqlite, type SqlDatabase, type Viewer } from '../src/index.ts';
import { CARTE_ACCES } from '../src/conformite/carte-acces.ts';
import { PortesPhases, type PhaseConditionReading } from '../src/conditions-phases/index.ts';
import { CARTE_REPRISE_AUTRES, COLONNES_MASQUEES, LicencesLogiciel, ORDRE_REPRISE, REPRISE_LIEN_MASQUE, masquerLiens, masquerTexte, REPRISE_MASQUE, RepriseDonneesAgence, tablesLcbFt, TABLES_RESEAU, carteReprise, type CheminReprise } from '../src/licences/index.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

// Tout est inventé : réseaux d'essai, agences, SIREN (clé juste, aucune entreprise réelle visée), cartes, biens, textes.
const met = (): PhaseConditionReading => ({ met: true, reasons: [], evidence: { essai: 1 } });
const AGENCE = { agencyName: 'Agence du Lac (essai)', siren: '123456782', cardNumber: 'CPI 7501 2027 000 000 001', cardExpiresOn: '2030-06-30', department: '75' };
const AUTRE = { agencyName: 'Agence des Prés (essai)', siren: '732829320', cardNumber: 'CPI 2101 2027 000 000 002', cardExpiresOn: '2030-06-30', department: '21' };
const SECRET = /token|code_hash|key_hash|password|secret/;

interface Fk {
  id: number;
  table: string;
  from: string;
  to: string;
}

async function openDb(extra: { id: string; sql: string }[] = []) {
  const raw = openMemoryDatabase();
  const db: SqlDatabase = fromSyncSqlite(raw);
  await applyMigrations(db, [...loadMigrations(), ...extra]);
  return { raw, db };
}

/** Ce que la base dit d'elle-même : chaque table, ses colonnes et ses clés étrangères (dans le test seulement). */
async function schemaOf(db: SqlDatabase) {
  const tables = (await db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")).map((r) => r.name);
  const cols = new Map<string, string[]>();
  const fks = new Map<string, { table: string; from: string[]; to: string[] }[]>();
  for (const t of tables) {
    cols.set(t, (await db.all<{ name: string }>(`PRAGMA table_info(${t})`)).map((r) => r.name));
    const groups = new Map<number, Fk[]>();
    for (const f of await db.all<Fk>(`PRAGMA foreign_key_list(${t})`)) groups.set(f.id, [...(groups.get(f.id) ?? []), f]);
    fks.set(t, [...groups.values()].map((g) => ({ table: g[0]!.table, from: g.map((f) => f.from), to: g.map((f) => f.to) })));
  }
  return { tables, cols, fks };
}

const list = (v: string | readonly string[]): string[] => (typeof v === 'string' ? [v] : [...v]);
const key = (from: readonly string[], table: string, to: readonly string[]) => `${from.join(',')}>${table}.${to.join(',')}`;

/** Les écarts entre la carte de reprise et la base [R658]. */
async function gapsOf(db: SqlDatabase, carte = carteReprise()): Promise<string[]> {
  const { tables, cols, fks } = await schemaOf(db);
  const gaps: string[] = [];
  for (const t of tables) if (!carte.has(t)) gaps.push(`absente:${t}`);
  for (const t of carte.keys()) if (!cols.has(t)) gaps.push(`inconnue:${t}`);
  const resumed = (t: string) => {
    const e = carte.get(t);
    return e !== undefined && (e === 'reseau' || !('hors' in e));
  };
  for (const [t, e] of carte) {
    const c = cols.get(t);
    if (c === undefined) continue;
    if (e === 'reseau') {
      if (!c.includes('network_id')) gaps.push(`sans_network_id:${t}`);
      continue;
    }
    // Le dossier de la lutte contre le blanchiment est laissé entier, quelles que soient ses colonnes et ses clés.
    if ('hors' in e && e.hors === 'lcb_ft') continue;
    if (c.includes('network_id') && !('soi' in e)) gaps.push(`network_id_non_suivi:${t}`);
    if ('soi' in e) {
      if (!c.includes(e.soi)) gaps.push(`colonne:${t}.${e.soi}`);
      continue;
    }
    const toResumed = fks.get(t)!.filter((f) => resumed(f.table));
    if ('hors' in e) {
      // Une table laissée qui pointe vers une table reprise devrait suivre ce chemin.
      for (const f of toResumed) gaps.push(`cle_non_suivie:${t}:${key(f.from, f.table, f.to)}`);
      continue;
    }
    const paths = (e.via as readonly CheminReprise[]).map(([a, from, b]) => ({ from: list(a), table: from, to: list(b) }));
    const real = new Set(toResumed.map((f) => key(f.from, f.table, f.to)));
    for (const p of paths) {
      if (!resumed(p.table)) gaps.push(`vers_table_laissee:${t}>${p.table}`);
      if (p.from.some((x) => !c.includes(x)) || p.to.some((x) => !(cols.get(p.table) ?? []).includes(x))) gaps.push(`colonne:${t}:${key(p.from, p.table, p.to)}`);
      if (!real.has(key(p.from, p.table, p.to)) && e.sansCle === undefined) gaps.push(`sans_cle_etrangere:${t}:${key(p.from, p.table, p.to)}`);
    }
    // Chaque clé étrangère vers une table reprise est suivie : une ligne dont une seule clé est remplie entre aussi.
    const declared = new Set(paths.map((p) => key(p.from, p.table, p.to)));
    for (const k of real) if (!declared.has(k)) gaps.push(`cle_non_suivie:${t}:${k}`);
    // Une colonne sans clé étrangère n'est déclarée que si la table n'en a aucune vers une table reprise.
    if (e.sansCle !== undefined && real.size > 0) gaps.push(`sans_cle_inutile:${t}`);
  }
  return gaps.sort();
}

async function setup() {
  const { raw, db } = await openDb();
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
  // Une écriture glissée pendant la lecture, juste après la lecture d'une table donnée.
  const hook: { after: string | null; run: (() => Promise<void>) | null } = { after: null, run: null };
  const watched: SqlDatabase = {
    ...db,
    all: async (sql, params) => {
      const out = await db.all(sql, params);
      if (hook.after !== null && hook.run !== null && sql.startsWith(`SELECT * FROM ${hook.after} `)) {
        const run = hook.run;
        hook.run = null;
        await run();
      }
      return out as never;
    },
  } as SqlDatabase;
  const reprise = new RepriseDonneesAgence(watched, journal, gate, { now });
  const lacDirection = as('direction', 'direction-lac', lac.licenseeNetworkId);
  const events = async (type: string) => (await db.all<{ data: string }>('SELECT data FROM journal WHERE type = ?', [type])).map((e) => JSON.parse(e.data) as Record<string, unknown>);

  // Un même jeu dans chaque réseau : un agent et son curseur d'agenda (colonne sans clé étrangère), une invitation (jeton
  // masqué), un bien, une publication, un essai d'envoi puis son issue (deux niveaux de tables filles).
  const fill = async (net: string, tag: string) => {
    const at = '2028-01-09T08:00:00.000Z';
    await db.run('INSERT INTO agents (id, network_id, first_name, last_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', [`agent-${tag}`, net, 'Camille', `Essai ${tag}`, at, at]);
    await db.run('INSERT INTO agenda_cursors (agent_id, cursor, updated_at) VALUES (?, ?, ?)', [`agent-${tag}`, `curseur-${tag}`, at]);
    await db.run('INSERT INTO access_invitations (id, network_id, token_sha256, grants, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)', [
      `invit-${tag}`,
      net,
      ({ lac: 'a', pres: 'b', reseau: 'd' } as Record<string, string>)[tag]!.repeat(64),
      JSON.stringify([{ role: 'agent', userId: `agent-${tag}` }]),
      at,
      at,
    ]);
    await db.run("INSERT INTO properties (id, network_id, reference, kind, city, created_at, updated_at) VALUES (?, ?, ?, 'home', 'Dijon', ?, ?)", [`bien-${tag}`, net, `REF-${tag}`, at, at]);
    await db.run("INSERT INTO social_posts (id, property_id, network_id, event, text, origin, visuals, created_by, created_at) VALUES (?, ?, ?, 'nouveau_bien', ?, 'secours', '[]', 'agent', ?)", [
      `post-${tag}`,
      `bien-${tag}`,
      net,
      `Nouveau bien d’essai ${tag}, lumineux. Décaler : https://exemple.test/rdv/AbCdEf0123456789xyz_${tag} ; site : https://exemple.test/a`,
      at,
    ]);
    await db.run("INSERT INTO social_post_attempts (id, post_id, channel, account, attempt, mode, claimed_by, claimed_at) VALUES (?, ?, 'instagram', 'reseau', 0, 'essai', 'essai', ?)", [`essai-${tag}`, `post-${tag}`, at]);
    await db.run("INSERT INTO social_post_sends (attempt_id, outcome, done_at) VALUES (?, 'envoye', ?)", [`essai-${tag}`, at]);
  };
  await fill(lac.licenseeNetworkId, 'lac');
  await fill(pres.licenseeNetworkId, 'pres');
  await fill(network.id, 'reseau');
  const tick = (ms: number) => {
    clock += ms;
  };
  return { raw, db, network, direction, as, lac, pres, reprise, lacDirection, proofs, events, licences, tick, hook };
}

describeWithSqlite('HX74 · La reprise des données de l’agence sous licence', () => {
  it('[R658] chaque table des migrations est à la carte, une seule fois, avec un vrai chemin', async () => {
    const { db } = await openDb();
    expect(await gapsOf(db)).toEqual([]);
    const { tables, cols } = await schemaOf(db);
    const lcb = new Set(tablesLcbFt());
    expect(lcb.size).toBeGreaterThan(10);
    expect(new Set(TABLES_RESEAU)).toEqual(new Set(tables.filter((t) => cols.get(t)!.includes('network_id') && t !== 'software_licences' && !lcb.has(t))));
    expect(CARTE_REPRISE_AUTRES.software_licences).toEqual({ soi: 'licensee_network_id' });
    expect(carteReprise().size).toBe(tables.length);
    for (const t of Object.keys(CARTE_REPRISE_AUTRES)) expect(TABLES_RESEAU).not.toContain(t);
  });

  it('[R658] une table que la base gagne sans entrer à la carte fait échouer la vérification', async () => {
    const { db } = await openDb([
      {
        id: '9999_essai',
        sql: `CREATE TABLE essai_oubli (id TEXT PRIMARY KEY, network_id TEXT NOT NULL);
              CREATE TABLE essai_fille (id TEXT PRIMARY KEY, post_id TEXT NOT NULL REFERENCES social_posts (id));`,
      },
    ]);
    expect(await gapsOf(db)).toEqual(['absente:essai_fille', 'absente:essai_oubli']);
  });

  it('[R658] une clé étrangère non suivie, un chemin inventé ou une table laissée à tort sont dits', async () => {
    const { db } = await openDb();
    const carte = carteReprise();
    // Une table fille qui ne suit que l'une de ses clés.
    carte.set('ad_campaign_starts', { via: [['campaign_id', 'ad_campaigns', 'id']] });
    // Un chemin sans clé étrangère, non déclaré.
    carte.set('training_turns', { via: [['session_id', 'agents', 'id']] });
    // Une table reprise laissée.
    carte.set('sale_file_steps', { hors: 'technique', why: 'essai' });
    // Une table `network_id` déclarée comme fille.
    carte.set('persons', { via: [['agent_id', 'agents', 'id']] });
    expect(await gapsOf(db, carte)).toEqual([
      'cle_non_suivie:ad_campaign_starts:approval_id>ad_campaign_approvals.id',
      'cle_non_suivie:persons:agent_id,network_id>agents.id,network_id',
      'cle_non_suivie:persons:network_id>networks.id',
      'cle_non_suivie:sale_file_steps:file_id>sale_files.id',
      'cle_non_suivie:training_turns:session_id>training_sessions.id',
      'network_id_non_suivi:persons',
      'sans_cle_etrangere:persons:agent_id>agents.id',
      'sans_cle_etrangere:training_turns:session_id>agents.id',
    ]);
  });

  it('[R659] jetons, codes et empreintes de clés sont masqués, chaque secret de la carte des demandes d’accès compris', async () => {
    const { db } = await openDb();
    const { cols } = await schemaOf(db);
    for (const [t, masked] of Object.entries(COLONNES_MASQUEES)) for (const c of masked) expect(cols.get(t), `${t}.${c}`).toContain(c);
    for (const [t, c] of cols) for (const col of c) if (SECRET.test(col)) expect(COLONNES_MASQUEES[t] ?? [], `${t}.${col}`).toContain(col);
    for (const [t, e] of Object.entries(CARTE_ACCES)) {
      const secrets = (e as { secrets?: readonly string[] }).secrets ?? [];
      for (const s of secrets) expect(COLONNES_MASQUEES[t] ?? [], `${t}.${s}`).toContain(s);
    }
    expect(COLONNES_MASQUEES.access_keys).toContain('sha256');
    expect(COLONNES_MASQUEES.assistant_keys).toContain('sha256');
  });

  it('[R658, R657] le fichier porte chaque ligne de l’agence, et aucune ligne d’un autre réseau', async () => {
    const t = await setup();
    const r = await t.reprise.make(t.lacDirection, 'preuve-ok');
    if (!r.ok) throw new Error(r.code);
    const doc = r.value.document;
    const net = t.lac.licenseeNetworkId;
    // Chaque table de la carte, reprise ou laissée avec sa raison, une seule fois.
    const all = [...carteReprise().keys()].sort();
    expect([...Object.keys(doc.tables), ...Object.keys(doc.laissees)].sort()).toEqual(all);
    expect(doc.laissees.journal?.hors).toBe('commun');
    expect(doc.horsFichier.length).toBe(3);
    for (const lcb of tablesLcbFt()) expect(doc.laissees[lcb]?.hors, lcb).toBe('lcb_ft');
    // Les lignes de l'agence : tables directes, colonne sans clé étrangère, deux niveaux de tables filles, son réseau.
    expect(doc.tables.networks).toEqual([expect.objectContaining({ id: net, name: AGENCE.agencyName })]);
    expect(doc.tables.agents!.map((x) => x.id)).toEqual(['agent-lac']);
    expect(doc.tables.agenda_cursors!.map((x) => x.cursor)).toEqual(['curseur-lac']);
    expect(doc.tables.properties!.map((x) => x.id)).toEqual(['bien-lac']);
    expect(doc.tables.social_posts!.map((x) => x.id)).toEqual(['post-lac']);
    expect(doc.tables.social_post_attempts!.map((x) => x.id)).toEqual(['essai-lac']);
    expect(doc.tables.social_post_sends!.map((x) => x.attempt_id)).toEqual(['essai-lac']);
    // Rien d'une autre agence ni du réseau qui donne la licence : ni ses licences, ni son tarif, ni ses phases.
    const text = JSON.stringify(doc);
    for (const other of ['pres', 'reseau']) expect(text).not.toContain(`-${other}`);
    expect(text).not.toContain(t.network.id);
    expect(text).not.toContain(t.pres.licenseeNetworkId);
    // Sa licence, sans rien du réseau qui la donne [R657].
    expect(doc.tables.software_licences).toEqual([expect.objectContaining({ id: t.lac.id, licensee_network_id: net, siren: AGENCE.siren, network_id: REPRISE_MASQUE, granted_by: REPRISE_MASQUE, phase5_hash: REPRISE_MASQUE })]);
    expect(doc.tables.licence_tariffs).toEqual([]);
    expect(doc.tables.phase_openings).toEqual([]);
    // Chaque ligne d'une table `network_id` est du réseau de l'agence.
    for (const table of TABLES_RESEAU) for (const row of doc.tables[table] ?? []) expect(row.network_id, table).toBe(net);
    expect(r.value.rows).toBe(Object.values(doc.tables).reduce((a, x) => a + x.length, 0));
  });

  it('[R658] l’ordre de lecture : chaque table reprise une fois, avant celles qu’elle désigne', async () => {
    const { db } = await openDb();
    const carte = carteReprise();
    const resumed = [...carte.keys()].filter((t) => {
      const e = carte.get(t)!;
      return e === 'reseau' || !('hors' in e);
    });
    expect([...ORDRE_REPRISE].sort()).toEqual(resumed.sort());
    const at = new Map(ORDRE_REPRISE.map((t, i) => [t, i]));
    const { fks } = await schemaOf(db);
    for (const t of resumed) {
      const e = carte.get(t)!;
      const parents = [...fks.get(t)!.map((f) => f.table), ...(e !== 'reseau' && 'via' in e ? e.via.map((v) => v[1]) : [])];
      for (const p of parents) if (p !== t && at.has(p)) expect(at.get(t)!, `${t} avant ${p}`).toBeLessThan(at.get(p)!);
    }
  });

  it('[R658] une écriture pendant la lecture : aucune ligne du fichier ne désigne une ligne absente', async () => {
    const t = await setup();
    const net = t.lac.licenseeNetworkId;
    const at = '2028-01-10T08:30:00.000Z';
    // Une publication, son essai et son issue écrits juste après la lecture des essais.
    t.hook.after = 'social_post_attempts';
    t.hook.run = async () => {
      await t.db.run("INSERT INTO social_posts (id, property_id, network_id, event, text, origin, visuals, created_by, created_at) VALUES ('post-tard', 'bien-lac', ?, 'visite', 'Visite d’essai tardive.', 'secours', '[]', 'agent', ?)", [net, at]);
      await t.db.run("INSERT INTO social_post_attempts (id, post_id, channel, account, attempt, mode, claimed_by, claimed_at) VALUES ('essai-tard', 'post-tard', 'instagram', 'reseau', 0, 'essai', 'essai', ?)", [at]);
      await t.db.run("INSERT INTO social_post_sends (attempt_id, outcome, done_at) VALUES ('essai-tard', 'envoye', ?)", [at]);
    };
    const r = await t.reprise.make(t.lacDirection, 'preuve-ok');
    if (!r.ok) throw new Error(r.code);
    expect(t.hook.run).toBeNull();
    const tables = r.value.document.tables;
    const ids = (table: string, col = 'id') => new Set(tables[table]!.map((x) => x[col]));
    for (const send of tables.social_post_sends!) expect(ids('social_post_attempts').has(send.attempt_id!)).toBe(true);
    for (const attempt of tables.social_post_attempts!) expect(ids('social_posts').has(attempt.post_id!)).toBe(true);
    for (const post of tables.social_posts!) expect(ids('properties').has(post.property_id!)).toBe(true);
    expect(ids('social_post_attempts').has('essai-tard')).toBe(false);
  });

  it('[R659] liens à jeton : chemin et paramètres seuls, nom d’hôte long gardé, JSON resté lisible', () => {
    expect(masquerLiens('https://agence-immobiliere-du-lac.test')).toBe('https://agence-immobiliere-du-lac.test');
    expect(masquerLiens('https://agence-immobiliere-du-lac.test/biens/maison')).toBe('https://agence-immobiliere-du-lac.test/biens/maison');
    expect(masquerLiens('Voir https://agence-immobiliere-du-lac.test/r?t=AbCdEf0123456789xyz fin')).toBe(`Voir ${REPRISE_LIEN_MASQUE} fin`);
    const json = JSON.stringify({ texte: 'Lien "https://exemple.test/rdv/AbCdEf0123456789xyz"', liste: ['https://exemple.test/a'] });
    const masked = masquerTexte(json);
    expect(JSON.parse(masked)).toEqual({ texte: `Lien "${REPRISE_LIEN_MASQUE}"`, liste: ['https://exemple.test/a'] });
    // Un JSON sans lien à jeton reste au caractère près.
    expect(masquerTexte('{ "a" : "https://exemple.test/a" }')).toBe('{ "a" : "https://exemple.test/a" }');
  });

  it('[R659] jetons masqués dans le fichier, le reste intact', async () => {
    const t = await setup();
    const r = await t.reprise.make(t.lacDirection, 'preuve-ok');
    if (!r.ok) throw new Error(r.code);
    const [invit] = r.value.document.tables.access_invitations!;
    expect(invit).toMatchObject({ id: 'invit-lac', token_sha256: REPRISE_MASQUE });
    expect(JSON.stringify(r.value.document)).not.toContain('a'.repeat(64));
    expect(r.value.document.masquees.access_invitations).toEqual(['token_sha256']);
    // Un lien qui porte un jeton, dans un texte, est masqué ; un lien court reste.
    const [post] = r.value.document.tables.social_posts!;
    expect(post!.text).toBe(`Nouveau bien d’essai lac, lumineux. Décaler : ${REPRISE_LIEN_MASQUE} ; site : https://exemple.test/a`);
    expect(JSON.stringify(r.value.document)).not.toContain('AbCdEf0123456789');
  });

  it('[R659, R16, R601] direction de l’agence seule, second facteur exigé, refus au journal', async () => {
    const t = await setup();
    // Un agent de l'agence.
    expect(await t.reprise.make(t.as('agent', 'agent-lac', t.lac.licenseeNetworkId), 'preuve-ok')).toEqual({ ok: false, rule: 'R16', code: 'role' });
    // La direction du réseau qui donne la licence n'a pas de fichier de reprise à tirer.
    expect(await t.reprise.make(t.direction, 'preuve-ok')).toEqual({ ok: false, rule: 'R657', code: 'pas_de_licence' });
    // Sans preuve : rien n'est lu ni rangé.
    expect(await t.reprise.make(t.lacDirection)).toEqual({ ok: false, rule: 'R601', code: 'second_factor_required' });
    expect(t.proofs.at(-1)).toEqual({ subject: `licence:${t.lac.id}`, stepUpId: undefined });
    expect(await t.db.all('SELECT id FROM licence_data_exports')).toEqual([]);
    const refused = [...(await t.events('acces.refuse')), ...(await t.events('licences.refuse'))].filter((e) => e.kind === 'licence_reprise');
    expect(refused.map((e) => e.code).sort()).toEqual(['pas_de_licence', 'role']);
  });

  it('[R659] licence suspendue ou terminée : la reprise reste ouverte, sans condition', async () => {
    const t = await setup();
    for (const state of ['suspendue', 'terminee'] as const) {
      const d = await t.licences.decide(t.direction, { licenceId: t.lac.id, state, reason: 'Essai de fin' });
      expect(d.ok).toBe(true);
      t.tick(1000);
      const r = await t.reprise.make(t.lacDirection, 'preuve-ok');
      expect(r.ok).toBe(true);
    }
    expect((await t.db.all('SELECT id FROM licence_data_exports WHERE network_id = ?', [t.lac.licenseeNetworkId])).length).toBe(2);
    // Le dernier fichier porte la licence terminée et ses deux états, sans qui les a décidés [R657].
    const r = await t.reprise.make(t.lacDirection, 'preuve-ok');
    if (!r.ok) throw new Error(r.code);
    expect(r.value.document.tables.licence_states!.map((x) => [x.state, x.decided_by])).toEqual([
      ['suspendue', REPRISE_MASQUE],
      ['terminee', REPRISE_MASQUE],
    ]);
    expect(JSON.stringify(r.value.document)).not.toContain(t.network.id);
    expect(JSON.stringify(r.value.document)).not.toContain(t.pres.id);
  });

  it('[R659] empreinte rangée, au journal sans contenu ; un octet changé et la vérification échoue', async () => {
    const t = await setup();
    const r = await t.reprise.make(t.lacDirection, 'preuve-ok');
    if (!r.ok) throw new Error(r.code);
    const stored = await t.db.first<{ fingerprint: string; rows_count: number; tables_count: number; made_by: string }>('SELECT fingerprint, rows_count, tables_count, made_by FROM licence_data_exports WHERE network_id = ?', [
      t.lac.licenseeNetworkId,
    ]);
    expect(stored).toEqual({ fingerprint: r.value.fingerprint, rows_count: r.value.rows, tables_count: Object.keys(r.value.document.tables).length, made_by: 'direction:direction-lac' });
    const [event] = await t.events('licences.reprise');
    expect(event).toEqual({ rule: 'R659', fingerprint: r.value.fingerprint, tables: stored!.tables_count, rows: r.value.rows });
    const copy = JSON.parse(JSON.stringify(r.value.document));
    expect(await t.reprise.verify(copy)).toEqual({ verified: true, fingerprint: r.value.fingerprint, complete: true, missing: [] });
    copy.tables.agents[0].last_name = 'Essai laX';
    expect((await t.reprise.verify(copy)).verified).toBe(false);
    // Un fichier dont une table a été retirée n'est plus complet, et ne se vérifie plus.
    const cut = JSON.parse(JSON.stringify(r.value.document));
    delete cut.tables.agenda_cursors;
    expect(await t.reprise.verify(cut)).toMatchObject({ verified: false, complete: false, missing: ['agenda_cursors'] });
    expect(await t.reprise.verify({ format: 'autre' })).toEqual({ verified: false, fingerprint: null, complete: false, missing: [] });
  });

  it('[R659, R657] la base refuse de ranger un fichier pour un autre réseau que celui de l’agence, et rien ne s’efface', async () => {
    const t = await setup();
    const insert = (net: string) =>
      t.db.run("INSERT INTO licence_data_exports (id, licence_id, network_id, fingerprint, tables_count, rows_count, made_by, made_at) VALUES (?, ?, ?, ?, 1, 0, 'direction:x', 'x')", [
        `x-${net}`,
        t.lac.id,
        net,
        'c'.repeat(64),
      ]);
    await expect(insert(t.network.id)).rejects.toThrow(/agence de la licence/);
    await expect(insert(t.pres.licenseeNetworkId)).rejects.toThrow(/agence de la licence/);
    await insert(t.lac.licenseeNetworkId);
    await expect(t.db.run('DELETE FROM licence_data_exports')).rejects.toThrow(/rien ne s'efface/);
    await expect(t.db.run("UPDATE licence_data_exports SET rows_count = 9")).rejects.toThrow(/ne change plus/);
  });
});
