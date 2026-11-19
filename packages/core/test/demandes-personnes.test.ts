import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CorrigerNom, DecisionEnvoi, FicheUnique, applyMigrations, conformite, fromSyncSqlite, verifyChain, type SqlDatabase, type SqlValue, type Viewer } from '../src/index.ts';
import { setupAnnonce } from './annonces-jeu.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

const { CARTE_ACCES, JOURNAL_SUBJECTS, SALE_FILE_EVENTS, REGISTRE_TRAITEMENTS, MASKED, accessOrder, assembleAccess, checkAccessMap, describeAccessGap, readSchema, erasurePlan } = conformite;

// Deux personnes inventées : chaque valeur rangée pour l'une porte son identifiant, pour voir d'où vient chaque donnée.
const A = 'pa-0001';
const B = 'pb-0002';

const gapsOf = (sql: string, carte = CARTE_ACCES, registre = REGISTRE_TRAITEMENTS) =>
  checkAccessMap(readSchema([...loadMigrations(), { id: '9999_essai', sql }]), registre, carte);

describe('L07 · carte des demandes d’accès vérifiée contre la base (Jamais vu)', () => {
  it('[R96] chaque table du registre est dans la carte, et chaque colonne qui désigne une personne y est suivie', () => {
    const gaps = checkAccessMap(readSchema(loadMigrations()), REGISTRE_TRAITEMENTS, CARTE_ACCES);
    expect(gaps.map(describeAccessGap)).toEqual([]);
    // Toutes les tables du registre, ni plus ni moins.
    const registered = REGISTRE_TRAITEMENTS.flatMap((t) => Object.keys(t.tables)).sort();
    expect(Object.keys(CARTE_ACCES).sort()).toEqual(registered);
  });

  it('[R96] une table ajoutée au registre sans la carte, ou une personne non suivie, fait échouer la vérification', () => {
    const registre = [...REGISTRE_TRAITEMENTS, { ...REGISTRE_TRAITEMENTS[0]!, id: 'essai', tables: { essai_contacts: ['person_id', 'note'] } }];
    expect(gapsOf('CREATE TABLE essai_contacts (id TEXT PRIMARY KEY, person_id TEXT, note TEXT);', CARTE_ACCES, registre)).toEqual([{ kind: 'table_absente', table: 'essai_contacts' }]);
    expect(describeAccessGap({ kind: 'table_absente', table: 'essai_contacts' })).toContain('pas dans la carte');
    // Une colonne ajoutée qui désigne une personne, sur une table lue par une autre voie.
    expect(gapsOf('ALTER TABLE visit_slips ADD COLUMN visitor_person_id TEXT;')).toEqual([{ kind: 'personne_non_suivie', table: 'visit_slips', column: 'visitor_person_id' }]);
    // Une table écartée qui gagne une personne : l'écart n'est plus fondé.
    expect(gapsOf('ALTER TABLE agents ADD COLUMN person_id TEXT;')).toEqual([{ kind: 'exclusion_mal_fondee', table: 'agents', column: 'person_id' }]);
    // La lutte contre le blanchiment ne sert d'excuse qu'à ses propres tables.
    const wrong = { ...CARTE_ACCES, messages: { excluded: 'lcb_ft' as const, why: 'essai' } };
    expect(checkAccessMap(readSchema(loadMigrations()), REGISTRE_TRAITEMENTS, wrong).map((g) => g.kind)).toEqual(
      expect.arrayContaining(['exclusion_mal_fondee', 'source_inconnue']),
    );
    // Une source inconnue, une colonne fantôme, une boucle.
    const ghost = { ...CARTE_ACCES, visit_tasks: { locate: [{ column: 'appointment_id', from: 'agents', key: 'id' }] } };
    expect(checkAccessMap(readSchema(loadMigrations()), REGISTRE_TRAITEMENTS, ghost)).toEqual([{ kind: 'source_inconnue', table: 'visit_tasks', from: 'agents' }]);
    const phantom = { ...CARTE_ACCES, consents: { locate: [{ column: 'person_id' }], secrets: ['fantome'] } };
    expect(checkAccessMap(readSchema(loadMigrations()), REGISTRE_TRAITEMENTS, phantom)).toEqual([{ kind: 'colonne_inconnue', table: 'consents', column: 'fantome' }]);
    const loop = { ...CARTE_ACCES, projects: { locate: [{ column: 'person_id' }, { column: 'id', from: 'project_properties', key: 'project_id' }] } };
    expect(checkAccessMap(readSchema(loadMigrations()), REGISTRE_TRAITEMENTS, loop).map((g) => g.kind)).toEqual(['boucle']);
  });
});

/** Chaque préfixe de sujet écrit dans le code de `packages/core/src` et `packages/api/src`. */
function subjectPrefixesInCode(): Map<string, string> {
  const found = new Map<string, string>();
  const root = new URL('../../', import.meta.url).pathname;
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.ts$/.test(name)) {
        const text = readFileSync(path, 'utf8');
        const at = (prefix: string) => {
          if (!found.has(prefix)) found.set(prefix, path.slice(root.length));
        };
        // Un sujet écrit en littéral : `subject: \`<préfixe>:…`, `const subject = '<préfixe>:…'`.
        for (const m of text.matchAll(/subject[A-Za-z]*\s*(?::|=)\s*[`'"]([a-z_]+):/g)) at(m[1]!);
        // Un sujet passé à une fonction d'aide (refus, alerte, attente…) : `this.refuse(viewer, \`<préfixe>:${…}\`…`.
        for (const m of text.matchAll(/this\.[A-Za-z]+\(\s*[A-Za-z.]+\s*,\s*`([a-z_]+):\$\{/g)) at(m[1]!);
        // Un sujet à préfixe construit (`rdv_rappel_${kind}:`) : relevé par sa partie fixe.
        for (const m of text.matchAll(/subject[A-Za-z]*\s*(?::|=)[^\n]*`([a-z_]+_)\$\{[^}]+\}:/g)) at(m[1]!);
        // Un sujet tout construit (`${kind}:${id}`) : il doit être décrit dans DYNAMIC_SUBJECTS.
        for (const m of text.matchAll(/subject[A-Za-z]*\s*(?::|=)\s*`\$\{([^}]+)\}:/g)) at(`\${${m[1]}}@${path.slice(root.length)}`);
      }
    }
  };
  walk(join(root, 'core/src'));
  walk(join(root, 'api/src'));
  return found;
}

/**
 * Les sujets tout construits du code, et les préfixes qu'ils peuvent prendre (relus à la main) : un nouveau sujet
 * construit fait échouer le test tant qu'il n'est pas décrit ici.
 */
const DYNAMIC_SUBJECTS: Readonly<Record<string, readonly string[]>> = {
  // Reprise d'un agent parti : `kind` vaut person, project ou property (`agent_departure_reassignments`).
  '${kind}@core/src/reseau/depart.ts': ['person', 'project', 'property'],
  // Sujet d'un envoi du contrôle central (bascule des automatisations), jamais écrit au journal.
  '${req.automation}@core/src/bascule/automatisations.ts': [],
  // La lecture des projets confiés, au journal de qui lit (un partenaire ou un membre du réseau), jamais d'un client.
  '${String(viewer.role)}@core/src/partenaires/mise-en-relation.ts': [],
};

describe('L07 · chaque sujet du journal écrit dans le code est lu ou écarté', () => {
  it('[R96] un préfixe de sujet du code absent de JOURNAL_SUBJECTS fait échouer la vérification', () => {
    const inCode = subjectPrefixesInCode();
    // Le relevé trouve bien les sujets connus, sinon le test ne prouverait rien.
    for (const known of ['person', 'property', 'referral', 'mandate', 'agent']) expect(inCode.has(known), known).toBe(true);
    const dynamic = [...inCode.keys()].filter((p) => p.startsWith('${'));
    expect(dynamic.sort()).toEqual(Object.keys(DYNAMIC_SUBJECTS).sort());
    const prefixes = [...inCode].filter(([p]) => !p.startsWith('${'));
    for (const produced of Object.values(DYNAMIC_SUBJECTS)) for (const p of produced) prefixes.push([p, 'sujet construit']);
    const missing = prefixes.filter(([prefix]) => !(prefix in JOURNAL_SUBJECTS)).map(([prefix, file]) => `${prefix}: (${file})`);
    expect(missing).toEqual([]);
    // Les sujets passés à une fonction d'aide et les préfixes construits sont bien relevés.
    for (const known of ['vault_piece', 'risk_sheet', 'rdv_rappel_']) expect(inCode.has(known), known).toBe(true);
  });

  it('[R96] un préfixe dit « lu » l’est par la carte du journal, et la carte ne lit aucun préfixe non déclaré', () => {
    const journal = CARTE_ACCES.journal!;
    if (!('locate' in journal)) throw new Error('journal');
    const read = new Set(journal.locate.map((l) => ('prefix' in l ? l.prefix ?? '' : 'startsWith' in l ? l.startsWith?.subject ?? '' : '')).filter(Boolean).map((p) => p.replace(/:$/, '')));
    const declared = Object.entries(JOURNAL_SUBJECTS).filter(([, use]) => use === 'journal').map(([p]) => p);
    expect([...read].sort()).toEqual([...declared].sort());
    // Chaque écart dit pourquoi.
    for (const [prefix, use] of Object.entries(JOURNAL_SUBJECTS)) if (use !== 'journal') expect(use.why.length, prefix).toBeGreaterThan(5);
  });
});

/** Chaque appel `appendEvent(…)` d'un texte, parenthèses équilibrées, chaînes et gabarits sautés. */
function appendEventCalls(text: string): string[] {
  const calls: string[] = [];
  for (const m of text.matchAll(/\bappendEvent\(/g)) {
    let depth = 0;
    let i = m.index! + 'appendEvent'.length;
    let quote: string | null = null;
    for (; i < text.length; i++) {
      const c = text[i]!;
      if (quote) {
        if (c === '\\') i++;
        else if (c === quote) quote = null;
        continue;
      }
      if (c === "'" || c === '"' || c === '`') quote = c;
      else if (c === '(') depth++;
      else if (c === ')' && --depth === 0) break;
    }
    calls.push(text.slice(m.index!, i + 1));
  }
  return calls;
}

/**
 * Chaque événement écrit au journal sous `sale_file:<id>` dans le code : sa sorte, ses fichiers, et s'il nomme son client.
 * Un appel dont le sujet n'est pas un littéral, dans un fichier qui écrit sous `sale_file:`, compte aussi (il peut recevoir
 * ce sujet d'une fonction d'aide). Un appel dont la sorte n'est pas un littéral doit être décrit dans DYNAMIC_SALE_FILE_TYPES.
 */
function saleFileEventsInCode(): { found: Map<string, { files: string[]; client: boolean[] }>; dynamic: Map<string, number> } {
  const found = new Map<string, { files: string[]; client: boolean[] }>();
  const dynamic = new Map<string, number>();
  const root = new URL('../../', import.meta.url).pathname;
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.ts$/.test(name)) {
        const text = readFileSync(path, 'utf8');
        if (!text.includes('sale_file:')) continue;
        const file = path.slice(root.length);
        for (const call of appendEventCalls(text)) {
          const literal = /\bsubject: `sale_file:/.test(call);
          // Un sujet littéral d'une autre sorte (`person:`, `network:`…) ou nul n'est pas du dossier de vente.
          const otherLiteral = /\bsubject: (`(?!sale_file:)|'|"|null|[a-zA-Z]+\()/.test(call);
          if (!literal && otherLiteral) continue;
          const type = call.match(/\btype: '([^']+)'/);
          let types: readonly string[];
          if (type) types = [type[1]!];
          else {
            dynamic.set(file, (dynamic.get(file) ?? 0) + 1);
            types = DYNAMIC_SALE_FILE_TYPES[file]?.types ?? [`<construit>@${file}`];
          }
          for (const t of types) {
            const known = found.get(t) ?? { files: [], client: [] };
            known.files.push(file);
            known.client.push(/\bclient: `person:\$\{/.test(call));
            found.set(t, known);
          }
        }
      }
    }
  };
  walk(join(root, 'core/src'));
  walk(join(root, 'api/src'));
  return { found, dynamic };
}

/**
 * Les fichiers où des appels écrivent une sorte construite (relue à la main) : combien d'appels, et les sortes qu'ils
 * peuvent écrire. Un appel à sorte construite de plus, ou dans un autre fichier, fait échouer le test.
 */
const DYNAMIC_SALE_FILE_TYPES: Readonly<Record<string, { calls: number; types: readonly string[] }>> = {
  'core/src/dossiers/echeancier.ts': { calls: 1, types: ['dossier.date_a_saisir', 'dossier.echeance'] },
  'core/src/pilotage/commissions.ts': { calls: 1, types: ['commission.attente', 'commission.ecart'] },
  'core/src/pilotage/factures.ts': { calls: 1, types: ['facture.emise', 'facture.avoir'] },
};

describe('L07 · chaque événement du dossier de vente revient à sa partie, jamais par défaut', () => {
  it('[R96] une sorte d’événement écrite sous sale_file: absente de SALE_FILE_EVENTS fait échouer la vérification', () => {
    const { found: inCode, dynamic } = saleFileEventsInCode();
    // Le relevé trouve bien les sortes connues, y compris celles des variables, des fonctions d'aide et des sortes construites.
    for (const known of ['dossier.financement', 'apres_vente.satisfaction', 'apres_vente.choix_relances', 'acces.refuse', 'dossier.echeance', 'facture.emise', 'commission.ecart']) expect(inCode.has(known), known).toBe(true);
    expect(Object.fromEntries(dynamic)).toEqual(Object.fromEntries(Object.entries(DYNAMIC_SALE_FILE_TYPES).map(([f, d]) => [f, d.calls])));
    const missing = [...inCode].filter(([type]) => !(type in SALE_FILE_EVENTS)).map(([type, f]) => `${type} (${f.files.join(', ')})`);
    expect(missing).toEqual([]);
    // Ce qui revient à un seul client nomme sa fiche à chaque écriture : sinon il n'irait à personne.
    const unnamed = [...inCode].filter(([type, f]) => SALE_FILE_EVENTS[type] === 'client' && f.client.includes(false)).map(([type, f]) => `${type} (${f.files.join(', ')})`);
    expect(unnamed).toEqual([]);
    for (const [type, use] of Object.entries(SALE_FILE_EVENTS)) if (typeof use === 'object') expect(use.why.length, type).toBeGreaterThan(5);
  });

  it('[R96] le relevé lit un appel écrit sur plusieurs lignes ou avec `now` passé en paramètre', () => {
    const text = "await appendEvent(\n  journal,\n  { type: 'a.un', subject: `sale_file:${id}`, data: { t: ')' } },\n  now,\n);\nawait appendEvent(this.journal, { type: 'a.deux', subject, data: {} }, this.now);";
    expect(appendEventCalls(text).map((c) => c.match(/type: '([^']+)'/)?.[1])).toEqual(['a.un', 'a.deux']);
  });
});

/**
 * Une base où chaque table de la carte reçoit une ligne pour A et une pour B, chaque colonne remplie d'une valeur qui
 * dit à qui elle est. Les protections de la base sont retirées dans cette base de test seulement, pour pouvoir remplir
 * toutes les tables d'un coup.
 */
async function seedEveryTable() {
  const raw = openMemoryDatabase();
  const db: SqlDatabase = fromSyncSqlite(raw);
  await applyMigrations(db, loadMigrations());
  raw.exec('PRAGMA foreign_keys = OFF');
  raw.exec('PRAGMA ignore_check_constraints = ON');
  for (const { name } of await db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'trigger'")) raw.exec(`DROP TRIGGER "${name}"`);
  const seeded = new Map<string, Record<string, Record<string, SqlValue>>>();
  let n = 0;
  const insert = async (table: string, row: Record<string, SqlValue>) => {
    const cols = Object.keys(row);
    await db.run(`INSERT INTO "${table}" (${cols.map((c) => `"${c}"`).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, cols.map((c) => row[c]!));
  };
  for (const table of accessOrder(CARTE_ACCES)) {
    const entry = CARTE_ACCES[table]!;
    if (!('locate' in entry)) continue;
    const info = await db.all<{ name: string; type: string; pk: number }>(`PRAGMA table_info("${table}")`);
    const rows: Record<string, Record<string, SqlValue>> = {};
    for (const p of [A, B]) {
      const row: Record<string, SqlValue> = {};
      // Le plan du jour est celui d'un agent : ses autres colonnes ne sont à aucun client.
      const owner = entry.locate.some((l) => 'json' in l) ? (p === A ? 'agent-1' : 'agent-2') : p;
      for (const c of info) row[c.name] = c.pk === 1 && /^INTEGER$/i.test(c.type) ? ++n : `${owner}|${table}.${c.name}`;
      for (const l of entry.locate) {
        if ('json' in l) {
          // Le plan d'un agent nomme plusieurs personnes : celui de A nomme aussi B.
          const item = (who: string) => ({ personId: who, memberIds: [who], firstName: `${who}|prenom` });
          row[l.json] = JSON.stringify(p === A ? [item(A), item(B)] : [item(B)]);
          continue;
        }
        for (const [c, v] of Object.entries(l.where ?? {})) row[c] = v;
        if ('from' in l && l.jsonPath) {
          row[l.column] = JSON.stringify({ [l.jsonPath]: `${l.prefix ?? ''}${seeded.get(l.from)![p]![l.key]}` });
          for (const [c, start] of Object.entries(l.startsWith ?? {})) row[c] = `${start}${p}`;
          for (const [here, there] of Object.entries(l.alsoMatch ?? {})) row[here] = `${l.alsoMatchPrefix?.[here] ?? ''}${seeded.get(l.from)![p]![there]}`;
        } else if ('from' in l) {
          row[l.column] = `${l.prefix ?? ''}${seeded.get(l.from)![p]![l.key]}`;
          for (const [here, there] of Object.entries(l.alsoMatch ?? {})) row[here] = seeded.get(l.from)![p]![there]!;
          if (l.jsonIs) row.data = JSON.stringify(l.jsonIs);
        }
        else row[l.column] = `${l.prefix ?? ''}${p}`;
      }
      await insert(table, row);
      rows[p] = row;
    }
    seeded.set(table, rows);
  }
  return { db, raw, seeded, insert };
}

describeWithSqlite('L07 · réponse d’accès assemblée par le code', () => {
  it('[R96] la réponse contient chaque donnée de la personne dans chaque table du registre, et rien d’une autre', async () => {
    const { db, seeded } = await seedEveryTable();
    const response = await assembleAccess(db, [A]);
    const text = JSON.stringify(response);
    // Rien de B, nulle part : ni son identifiant ni une seule de ses valeurs.
    expect(response.sections.filter((x) => JSON.stringify(x).includes(B)).map((x) => x.table)).toEqual([]);
    expect(text).not.toContain(B);
    // Une section par table lue, avec la ligne de A entière.
    const located = Object.keys(CARTE_ACCES).filter((t) => 'locate' in CARTE_ACCES[t]!);
    expect(response.sections.map((s) => s.table).sort()).toEqual(located.sort());
    for (const section of response.sections) {
      const entry = CARTE_ACCES[section.table]!;
      if (!('locate' in entry)) throw new Error(section.table);
      const expected = { ...seeded.get(section.table)![A]! };
      for (const c of [...(entry.secrets ?? []), ...(entry.shared ?? [])]) expected[c] = MASKED;
      for (const l of entry.locate) if ('json' in l) expected[l.json] = JSON.stringify([{ personId: A, memberIds: [A], firstName: `${A}|prenom` }]);
      expect(section.rows, section.table).toEqual([expected]);
      // Chaque table vient avec son traitement : finalité, base légale, durée, destinataires (RGPD, article 15).
      const t = REGISTRE_TRAITEMENTS.find((r) => section.table in r.tables)!;
      expect(section).toMatchObject({ traitement: t.id, finalite: t.finalite, duree: t.duree, destinataires: t.destinataires });
    }
    // Les tables écartées disent pourquoi, et la liste est la même pour tout le monde.
    expect(response.notIncluded.map((x) => x.reason)).toEqual(['sans_client', 'agent', 'candidat', 'partenaire', 'non_rattachable', 'lcb_ft']);
    expect(response.notIncluded.find((x) => x.reason === 'lcb_ft')!.text).toContain('CNIL');
    // B reçoit la sienne, sans rien de A ; la même base donne la même réponse.
    const forB = await assembleAccess(db, [B]);
    expect(forB.sections.filter((x) => JSON.stringify(x).includes(A)).map((x) => x.table)).toEqual([]);
    expect(forB.sections.length).toBe(response.sections.length);
    expect(await conformite.sha256Of(await assembleAccess(db, [A]))).toBe(await conformite.sha256Of(response));
  });

  it('[R96] une ligne qui nomme deux personnes ne montre à chacune que ce qui est à elle', async () => {
    const { db, insert } = await seedEveryTable();
    const C = 'pc-0003';
    // A recommande C : A voit qu'il a recommandé quelqu'un, pas qui ; C voit sa recommandation entière.
    await insert('referrals', { id: 'r-ac', network_id: 'n', referrer_id: A, referred_id: C, project_id: 'proj-c', first_name: 'Prénom de C', agent_id: 'ag', callable: 1, call_due_at: 'x', call_done_at: null, created_by: 'ag', created_at: 't' });
    const ofA = (await assembleAccess(db, [A])).sections.find((s) => s.table === 'referrals')!.rows.find((r) => r.id === 'r-ac')!;
    expect(ofA).toMatchObject({ referrer_id: A, referred_id: MASKED, first_name: MASKED, project_id: MASKED, call_due_at: MASKED });
    const ofC = (await assembleAccess(db, [C])).sections.find((s) => s.table === 'referrals')!.rows;
    expect(ofC).toEqual([expect.objectContaining({ referrer_id: MASKED, referred_id: C, first_name: 'Prénom de C' })]);
    // Le vendeur voit le dossier de vente de son bien sans l'acquéreur, ni son offre, ni son financement.
    await insert('mandates', { id: 'm-2', network_id: 'n', agent_id: 'ag', person_id: A, project_id: null, property_id: 'bien-2', signed_at: 't', source_kind: 'x', source_detail: null, source_id: null, recorded_by: 'ag', created_at: 't' });
    await insert('sale_files', { id: 'f-c', network_id: 'n', property_id: 'bien-2', offer_id: 'offre-de-c', buyer_person_id: C, amount_eur: 250000, opened_at: 't', opened_by: 'ag' });
    await insert('sale_file_sellers', { file_id: 'f-c', network_id: 'n', person_id: A, mandate_id: 'm-2', at: 't' });
    await insert('persons', { id: C, network_id: 'n', created_at: 't', updated_at: 't' });
    await insert('sale_file_financing', { file_id: 'f-c', seq: 1, network_id: 'n', step: 'pret_accorde', day: 'd', declared_by: 'ag', at: 't', by: 'ag' });
    await insert('sale_file_steps', { file_id: 'f-c', step: 'compromis', at: 't', by: 'ag' });
    const seller = await assembleAccess(db, [A]);
    expect(seller.sections.find((s) => s.table === 'sale_files')!.rows.find((r) => r.id === 'f-c')).toMatchObject({ buyer_person_id: MASKED, offer_id: MASKED, amount_eur: 250000 });
    expect(seller.sections.find((s) => s.table === 'sale_file_steps')!.rows.some((r) => r.file_id === 'f-c')).toBe(true);
    expect(seller.sections.find((s) => s.table === 'sale_file_financing')!.rows.some((r) => r.file_id === 'f-c')).toBe(false);
    expect(JSON.stringify(seller)).not.toContain(C);
    const buyer = await assembleAccess(db, [C]);
    expect(buyer.sections.find((s) => s.table === 'sale_file_financing')!.rows).toEqual([expect.objectContaining({ file_id: 'f-c', step: 'pret_accorde' })]);
    // Au journal aussi : le financement et les alertes de fonds du dossier sont à l'acquéreur seul.
    await insert('journal', { seq: 8001, at: 't', type: 'dossier.financement', actor: 'ag', subject: 'sale_file:f-c', data: '{"step":"pret_refuse"}', prev_hash: 'p', hash: 'h8001' });
    await insert('journal', { seq: 8002, at: 't', type: 'dossier.alerte_fonds', actor: 'ag', subject: 'sale_file:f-c', data: `{"side":"acquereur","client":"person:${C}","signals":["iban_change"]}`, prev_hash: 'p', hash: 'h8002' });
    const sellerAfter = JSON.stringify(await assembleAccess(db, [A]));
    expect(sellerAfter).not.toContain('pret_refuse');
    expect(sellerAfter).not.toContain('iban_change');
    expect(sellerAfter).not.toContain(C);
    const buyerJournal = (await assembleAccess(db, [C])).sections.find((s) => s.table === 'journal')!.rows.map((r) => r.type);
    expect(buyerJournal.sort()).toEqual(['dossier.alerte_fonds', 'dossier.financement']);
    // L'alerte de fonds du vendeur, sur le même dossier : au vendeur seul.
    await insert('journal', { seq: 8003, at: 't', type: 'dossier.alerte_fonds', actor: 'system:dossiers', subject: 'sale_file:f-c', data: `{"side":"vendeur","client":"person:${A}","message":"message:mess-de-a","signals":["rib_vendeur"]}`, prev_hash: 'p', hash: 'h8003' });
    const sellerJournal = (await assembleAccess(db, [A])).sections.find((s) => s.table === 'journal')!.rows;
    expect(sellerJournal.filter((r) => String(r.subject) === 'sale_file:f-c').map((r) => r.seq)).toEqual([8003]);
    expect(JSON.stringify(await assembleAccess(db, [C]))).not.toContain('rib_vendeur');
    // Le plan d'effacement de A n'efface jamais d'office une ligne partagée : son dossier de vente avec C, la
    // recommandation qui le nomme, sont « à examiner ».
    const plan = conformite.erasurePlan(await conformite.assembleAccessDetail(db, [A]));
    const lines = (table: string) => plan.lines.filter((l) => l.table === table).map((l) => [l.action, l.rows]);
    expect(lines('sale_files')).toEqual([['effacer', 1], ['examiner', 1]]);
    expect(lines('sale_file_steps')).toEqual([['effacer', 1], ['examiner', 1]]);
    expect(lines('referrals')).toEqual([['effacer', 1], ['examiner', 1]]);
    expect(lines('daily_plans')).toEqual([['examiner', 1]]);
  });

  it('[R96] au journal du dossier de vente, chaque sorte va à sa partie : partagée, à l’acquéreur, au seul client qu’elle nomme, ou à personne', async () => {
    const { db, insert } = await seedEveryTable();
    const C = 'pc-0003';
    await insert('mandates', { id: 'm-2', network_id: 'n', agent_id: 'ag', person_id: A, project_id: null, property_id: 'bien-2', signed_at: 't', source_kind: 'x', source_detail: null, source_id: null, recorded_by: 'ag', created_at: 't' });
    await insert('sale_files', { id: 'f-c', network_id: 'n', property_id: 'bien-2', offer_id: 'offre-de-c', buyer_person_id: C, amount_eur: 250000, opened_at: 't', opened_by: 'ag' });
    await insert('sale_file_sellers', { file_id: 'f-c', network_id: 'n', person_id: A, mandate_id: 'm-2', at: 't' });
    await insert('persons', { id: C, network_id: 'n', created_at: 't', updated_at: 't' });
    // D a eu un mandat sur le même bien, avant A : sa note n'est qu'à lui, jamais à A ni à C.
    const D = 'pd-0004';
    await insert('persons', { id: D, network_id: 'n', created_at: 't', updated_at: 't' });
    await insert('mandates', { id: 'm-d', network_id: 'n', agent_id: 'ag', person_id: D, project_id: null, property_id: 'bien-2', signed_at: 't', source_kind: 'x', source_detail: null, source_id: null, recorded_by: 'ag', created_at: 't' });
    const events: [number, string, Record<string, unknown>][] = [
      [8101, 'dossier.date', { rule: 'R61', kind: 'acte' }],
      [8102, 'apres_vente.satisfaction', { side: 'vendeur', client: `person:${A}`, score: 2, comment: false }],
      [8103, 'apres_vente.satisfaction', { score: 5, comment: false }],
      [8104, 'apres_vente.remerciement', { side: 'acquereur', client: `person:${C}`, mode: 'essai', status: 'sent', rule: null }],
      [8105, 'dossier.sorte_inconnue', { rule: 'R00' }],
      [8106, 'commission.etape', { rule: 'R67', status: 'prevue' }],
      [8107, 'facture.emise', { rule: 'R71', kind: 'honoraires', label: 'essai-1', client: `person:${A}` }],
      [8110, 'facture.avoir', { rule: 'R71', kind: 'avoir', label: 'essai-2', client: `person:${C}` }],
      [8111, 'apres_vente.satisfaction', { side: 'vendeur', client: `person:${D}`, score: 1, comment: false }],
      [8108, 'apres_vente.choix_relances', { side: 'vendeur', client: `person:${A}`, choice: 'oui' }],
      [8109, 'dossier.financement', { step: 'pret_accorde' }],
    ];
    for (const [seq, type, data] of events) await insert('journal', { seq, at: 't', type, actor: 'system:essai', subject: 'sale_file:f-c', data: JSON.stringify(data), prev_hash: 'p', hash: `h${seq}` });
    const seqs = async (who: string) => (await assembleAccess(db, [who])).sections.find((s) => s.table === 'journal')!.rows.filter((r) => String(r.subject) === 'sale_file:f-c').map((r) => Number(r.seq)).sort();
    // Le vendeur : l'avancée du dossier, sa note de satisfaction, son choix, sa facture ; jamais ce qui est à l'acquéreur.
    expect(await seqs(A)).toEqual([8101, 8102, 8107, 8108]);
    // L'acquéreur : l'avancée du dossier, son remerciement, son financement, son avoir ; ni la note du vendeur, ni sa facture.
    expect(await seqs(C)).toEqual([8101, 8104, 8109, 8110]);
    // L'autre mandant du bien : sa seule note parmi ce qui est fait pour un client.
    expect((await seqs(D)).filter((n) => [8102, 8104, 8107, 8108, 8110, 8111].includes(n))).toEqual([8111]);
    // Une note sans côté, une sorte inconnue, la rémunération de l'agent : à personne.
    for (const who of [A, C]) expect(await seqs(who)).not.toEqual(expect.arrayContaining([8103]));
    for (const who of [A, B, C]) expect((await seqs(who)).some((n) => n === 8105 || n === 8106)).toBe(false);
  });

  it('[R96] le journal d’un bien possédé est à son propriétaire, et une autre personne nommée dans un événement est masquée', async () => {
    const { db, insert, seeded } = await seedEveryTable();
    // Le bien mis en vente par A : la validation de son avis de valeur, au journal du bien.
    const sold = seeded.get('mandates')![A]!.property_id!;
    await insert('journal', { seq: 9001, at: 't', type: 'avis.valide', actor: 'ag', subject: `property:${sold}`, data: '{"report":"avis-1"}', prev_hash: 'p', hash: 'h9001' });
    // Un bien que A regarde seulement : son journal n'est pas à A.
    await insert('project_properties', { project_id: seeded.get('projects')![A]!.id!, property_id: 'bien-regarde', network_id: 'n', agent_id: 'ag', role: 'interested', created_at: 't' });
    await insert('journal', { seq: 9002, at: 't', type: 'avis.valide', actor: 'ag', subject: 'property:bien-regarde', data: '{"report":"avis-du-voisin"}', prev_hash: 'p', hash: 'h9002' });
    // A est recommandé par B : l'événement est à A, le nom de B y est masqué.
    await insert('journal', { seq: 9003, at: 't', type: 'recommandation.rangee', actor: 'ag', subject: `person:${A}`, data: JSON.stringify({ rule: 'R66', referrer: `person:${B}`, call: true, list: [B] }), prev_hash: 'p', hash: 'h9003' });
    // Le journal d'une mise en relation de A avec un partenaire.
    await insert('journal', { seq: 9004, at: 't', type: 'mise_en_relation.confiee', actor: 'ag', subject: `referral:${seeded.get('partner_referrals')![A]!.id}`, data: '{"partner":"partner:p1"}', prev_hash: 'p', hash: 'h9004' });
    const detail = await conformite.assembleAccessDetail(db, [A]);
    const rows = detail.response.sections.find((s) => s.table === 'journal')!.rows;
    const bySeq = (seq: number) => rows.find((r) => r.seq === seq);
    expect(bySeq(9001)).toMatchObject({ type: 'avis.valide' });
    expect(bySeq(9002)).toBeUndefined();
    expect(JSON.parse(String(bySeq(9003)!.data))).toEqual({ rule: 'R66', referrer: MASKED, call: true, list: [MASKED] });
    expect(bySeq(9004)).toMatchObject({ type: 'mise_en_relation.confiee' });
    expect(JSON.stringify(detail.response)).not.toContain(B);
    // Une ligne qui nommait une autre personne n'est plus à la seule personne (le journal, lui, est gardé par la loi).
    expect(detail.exclusiveRows.journal).toBe(rows.length - 1);
    expect(conformite.erasurePlan(detail).lines.filter((l) => l.table === 'journal').map((l) => l.action)).toEqual(['garder']);
    // Une présentation au propriétaire A : le reçu du candidat C est à C, retrouvé par sa candidature ; A n'a que le sien.
    const C = 'pc-0003';
    const presentation = seeded.get('rental_presentations')![A]!.id!;
    await insert('rental_applications', { ...seeded.get('rental_applications')![B]!, id: 'cand-c', person_id: C, arrival: 99 });
    await insert('journal', { seq: 9005, at: 't', type: 'location.recu_prepare', actor: 'system:location', subject: `rental_presentation:${presentation}`, data: JSON.stringify({ rule: 'R105', recipient: 'candidat', application: 'cand-c', sha256: 'recu-de-c' }), prev_hash: 'p', hash: 'h9005' });
    await insert('journal', { seq: 9006, at: 't', type: 'location.recu_prepare', actor: 'system:location', subject: `rental_presentation:${presentation}`, data: JSON.stringify({ rule: 'R105', recipient: 'proprietaire', application: null, sha256: 'recu-de-a' }), prev_hash: 'p', hash: 'h9006' });
    const ofA = JSON.stringify(await assembleAccess(db, [A]));
    expect(ofA).toContain('recu-de-a');
    expect(ofA).not.toContain('recu-de-c');
    expect(ofA).not.toContain('cand-c');
    const ofC = (await assembleAccess(db, [C])).sections.find((s) => s.table === 'journal')!.rows.map((r) => r.seq);
    expect(ofC).toEqual([9005]);
    // L'arrivée de la candidature de C, au journal du logement de A : à C, pas à A.
    const listingA = seeded.get('rental_listings')![A]!.id!;
    await insert('journal', { seq: 9007, at: 't', type: 'location.candidature', actor: 'ag', subject: `rental:${listingA}`, data: JSON.stringify({ application: 'rental_application:cand-c', arrival: 99 }), prev_hash: 'p', hash: 'h9007' });
    // La signature du bail par le locataire C, au journal du logement : à C ; celle de A reste à A.
    await insert('rental_lease_signatures', { ...seeded.get('rental_lease_signatures')![B]!, id: 'sig-c', person_id: C });
    await insert('journal', { seq: 9008, at: 't', type: 'location.signature_essai', actor: 'ag', subject: `rental:${listingA}`, data: JSON.stringify({ rule: 'R108', session: 'sig-c', party: 'locataire' }), prev_hash: 'p', hash: 'h9008' });
    const sigA = seeded.get('rental_lease_signatures')![A]!.id!;
    await insert('journal', { seq: 9009, at: 't', type: 'location.signature_ouverte', actor: 'ag', subject: `rental:${listingA}`, data: JSON.stringify({ session: sigA, party: 'bailleur' }), prev_hash: 'p', hash: 'h9009' });
    const seqs = async (who: string) => (await assembleAccess(db, [who])).sections.find((s) => s.table === 'journal')!.rows.map((r) => r.seq);
    const journalOfC = await seqs(C);
    expect(journalOfC).toEqual(expect.arrayContaining([9005, 9007, 9008]));
    expect(journalOfC).not.toContain(9009);
    const journalOfA = await seqs(A);
    expect(journalOfA).not.toContain(9007);
    // La signature du locataire n'est pas au propriétaire ; la sienne, si.
    expect(journalOfA).not.toContain(9008);
    expect(journalOfA).toContain(9009);
    expect(journalOfC).not.toContain(9009);
    // L'état des lieux du locataire C, retrouvé par son bail (version 7 du logement de A) : sa signature et la clôture
    // sont à C ; la signature du propriétaire reste à A ; la version 8, d'un autre bail, n'est pas à C.
    await insert('rental_leases', { ...seeded.get('rental_leases')![B]!, id: 'bail-c', listing_id: listingA, application_id: 'cand-c' });
    await insert('rental_inventories', { ...seeded.get('rental_inventories')![B]!, id: 'edl-c', listing_id: listingA, lease_id: 'bail-c', version: 7 });
    await insert('rental_lease_copies', { ...seeded.get('rental_lease_copies')![B]!, lease_id: 'bail-c', listing_id: listingA, content_sha256: 'exemplaire-de-c' });
    const event = (seq: number, type: string, data: Record<string, unknown>) => insert('journal', { seq, at: 't', type, actor: 'ag', subject: `rental:${listingA}`, data: JSON.stringify(data), prev_hash: 'p', hash: `h${seq}` });
    await event(9101, 'location.etat_des_lieux_signe', { rule: 'R106', version: 7, party: 'locataire' });
    await event(9102, 'location.etat_des_lieux_signe', { rule: 'R106', version: 7, party: 'bailleur' });
    await event(9103, 'location.etat_des_lieux_clos', { rule: 'R106', version: 7 });
    await event(9104, 'location.etat_des_lieux_signe', { rule: 'R106', version: 8, party: 'locataire' });
    await event(9105, 'location.bail_exemplaire', { rule: 'R108', party: 'locataire', copy: 'exemplaire-de-c' });
    await event(9106, 'location.bail_exemplaire', { rule: 'R108', party: 'bailleur', copy: 'exemplaire-de-c' });
    const tenant = await seqs(C);
    expect(tenant).toEqual(expect.arrayContaining([9101, 9103, 9105]));
    for (const seq of [9102, 9104, 9106]) expect(tenant).not.toContain(seq);
    const owner = await seqs(A);
    expect(owner).toEqual(expect.arrayContaining([9102, 9103, 9106]));
    for (const seq of [9101, 9104, 9105]) expect(owner).not.toContain(seq);
    // Le même logement, vu d'une autre personne sans bail : rien.
    expect(JSON.stringify(await assembleAccess(db, ['pc-0009']))).not.toContain('etat_des_lieux');
    // Les signatures et les exemplaires de l'état des lieux : chaque partie n'a que les siens.
    for (const party of ['bailleur', 'locataire']) {
      await insert('rental_inventory_signatures', { id: `sig-edl-${party}`, inventory_id: 'edl-c', party, content_sha256: 'x', drawing_sha256: `trace-${party}`, signed_by: 'ag', signed_at: `t-${party}` });
      await insert('rental_inventory_copies', { id: `copie-edl-${party}`, inventory_id: 'edl-c', party, content_sha256: 'x', prepared_at: `t-${party}` });
    }
    const parties = async (who: string, table: string) =>
      (await assembleAccess(db, [who])).sections.find((s) => s.table === table)!.rows.filter((r) => r.inventory_id === 'edl-c').map((r) => r.party);
    expect(await parties(C, 'rental_inventory_signatures')).toEqual(['locataire']);
    expect(await parties(A, 'rental_inventory_signatures')).toEqual(['bailleur']);
    expect(await parties(C, 'rental_inventory_copies')).toEqual(['locataire']);
    expect(await parties(A, 'rental_inventory_copies')).toEqual(['bailleur']);
    // AU097 · une colocataire nommée au bail de C : elle retrouve le bail et son exemplaire, jamais la signature ni
    // l'exemplaire d'état des lieux de C [R96].
    const coloc = 'pc-0008';
    await insert('rental_lease_cotenants', { lease_id: 'bail-c', person_id: coloc, position: 1 });
    const ofColoc = await assembleAccess(db, [coloc]);
    expect(ofColoc.sections.find((s) => s.table === 'rental_lease_copies')!.rows.map((r) => r.lease_id)).toContain('bail-c');
    for (const table of ['rental_inventory_signatures', 'rental_inventory_copies']) expect(ofColoc.sections.find((s) => s.table === table)?.rows ?? []).toEqual([]);
    // Ses événements de signature (ouverture, signature, code faux) sont à elle, jamais à C [R96].
    await insert('rental_lease_cotenant_signatures', { ...seeded.get('rental_lease_signatures')![B]!, id: 'sig-coloc', party: 'colocataire', person_id: coloc, lease_id: 'bail-c' });
    await event(9201, 'location.signature_ouverte', { session: 'sig-coloc', party: 'colocataire', lease: 'rental_lease:bail-c', mode: 'essai' });
    await event(9202, 'location.signature_essai', { rule: 'R108', session: 'sig-coloc', party: 'colocataire' });
    await insert('journal', { seq: 9203, at: 't', type: 'location.signature_code_faux', actor: 'ag', subject: 'lease_signature:sig-coloc', data: JSON.stringify({ attempts: 1, blocked: false }), prev_hash: 'p', hash: 'h9203' });
    // Son avis d'exemplaire nomme sa session : à elle seule, jamais à C ni au bailleur A.
    await event(9204, 'location.bail_exemplaire', { rule: 'R108', party: 'colocataire', copy: 'exemplaire-de-c', session: 'sig-coloc' });
    expect(await seqs(coloc)).toEqual(expect.arrayContaining([9201, 9202, 9203, 9204]));
    for (const seq of [9201, 9202, 9203, 9204]) expect(await seqs(C)).not.toContain(seq);
    for (const seq of [9201, 9202, 9203, 9204]) expect(await seqs(A)).not.toContain(seq);
    // Son ajout comme colocataire nomme sa ligne : il est à elle ; celui d'une autre personne ne l'est pas.
    await insert('rental_cotenant_changes', { id: 'chg-coloc', network_id: seeded.get('rental_applications')![B]!.network_id, application_id: 'cand-c', person_id: coloc, seq: 1, action: 'ajout', changed_by: 'ag', changed_at: 't' });
    await insert('journal', { seq: 9205, at: 't', type: 'location.colocataire', actor: 'ag', subject: 'rental_application:cand-c', data: JSON.stringify({ action: 'ajout', change: 'chg-coloc' }), prev_hash: 'p', hash: 'h9205' });
    await insert('journal', { seq: 9206, at: 't', type: 'location.colocataire', actor: 'ag', subject: 'rental_application:cand-c', data: JSON.stringify({ action: 'ajout', change: 'chg-autre' }), prev_hash: 'p', hash: 'h9206' });
    expect(await seqs(coloc)).toContain(9205);
    expect(await seqs(coloc)).not.toContain(9206);
    // Ni l'avis du locataire C ni celui du bailleur ne sont à elle.
    for (const seq of [9105, 9106]) expect(await seqs(coloc)).not.toContain(seq);
    // Un bail et un état des lieux à deux parties ne sont jamais proposés à l'effacement : « à examiner ».
    const tenantPlan = conformite.erasurePlan(await conformite.assembleAccessDetail(db, [C]));
    for (const table of ['rental_leases', 'rental_inventories']) expect(tenantPlan.lines.filter((l) => l.table === table).map((l) => l.action)).not.toContain('effacer');
    // B, lui, voit l'événement de sa recommandation sous sa propre fiche seulement s'il y est sujet : ici il ne l'est pas.
    expect((await assembleAccess(db, [B])).sections.find((s) => s.table === 'journal')!.rows.some((r) => r.seq === 9003)).toBe(false);
  });

  it('[R96] un élément du plan du jour figé quand deux fiches étaient réunies n’est rendu à aucune après leur séparation', async () => {
    const { db, insert } = await seedEveryTable();
    const C = 'pc-0003';
    const D = 'pc-0004';
    const item = (personId: string, memberIds: string[]) => ({ personId, memberIds, firstName: `${personId}|prenom`, why: `${personId}|projet` });
    await insert('daily_plans', { agent_id: 'agent-9', network_id: 'n', day: '2026-10-01', computed_at: 't', removed: '[]', items: JSON.stringify([item(D, [C, D]), item(C, [C])]) });
    // C a été séparé de D : l'élément de D, figé quand ils étaient réunis, ne sort pas pour C, ni pour D.
    const ofC = JSON.stringify(await assembleAccess(db, [C]));
    expect(ofC).toContain(`${C}|projet`);
    expect(ofC).not.toContain(D);
    expect(JSON.stringify(await assembleAccess(db, [D]))).not.toContain(`${D}|projet`);
    // Réunies de nouveau, les deux fiches retrouvent les deux éléments.
    const both = JSON.stringify(await assembleAccess(db, [C, D]));
    expect(both).toContain(`${C}|projet`);
    expect(both).toContain(`${D}|projet`);
  });

  it('[R96] une conversation d’un autre réseau ou d’un autre canal, un bail à deux parties : rien de l’autre', async () => {
    const { db, insert, seeded } = await seedEveryTable();
    const inbound = seeded.get('inbound_messages')![A]!;
    // Même référence de conversation, autre canal ou autre réseau : la réponse en attente n'est pas à A.
    await insert('pending_human_replies', { network_id: inbound.network_id!, channel: 'autre-canal', external_id: 'x1', conversation_ref: inbound.conversation_ref!, body: 'Réponse à quelqu’un d’autre', sent_at: 't', created_at: 't', applied_at: null });
    await insert('pending_human_replies', { network_id: 'autre-reseau', channel: inbound.channel!, external_id: 'x2', conversation_ref: inbound.conversation_ref!, body: 'Réponse dans un autre réseau', sent_at: 't', created_at: 't', applied_at: null });
    const response = await assembleAccess(db, [A]);
    expect(response.sections.find((s) => s.table === 'pending_human_replies')!.rows).toEqual([seeded.get('pending_human_replies')![A]]);
    // Le bail et l'état des lieux rendus nomment les deux parties : leur texte n'est montré à aucune, l'empreinte reste.
    const lease = response.sections.find((s) => s.table === 'rental_leases')!.rows[0]!;
    expect(lease).toMatchObject({ content: MASKED, content_sha256: seeded.get('rental_leases')![A]!.content_sha256 });
    expect(response.sections.find((s) => s.table === 'rental_inventories')!.rows[0]!.content).toBe(MASKED);
    // Le journal du logement est au propriétaire, sauf l'arrivée d'une candidature, qui est au candidat.
    const listing = `rental:${seeded.get('rental_listings')![A]!.id}`;
    await insert('journal', { seq: 7001, at: 't', type: 'location.faits', actor: 'ag', subject: listing, data: '{"version":2}', prev_hash: 'p', hash: 'h7001' });
    await insert('journal', { seq: 7002, at: 't', type: 'location.candidature', actor: 'ag', subject: listing, data: '{"application":"rental_application:autre","arrival":3}', prev_hash: 'p', hash: 'h7002' });
    const types = (await assembleAccess(db, [A])).sections.find((s) => s.table === 'journal')!.rows.map((r) => r.type);
    expect(types).toContain('location.faits');
    expect(types).not.toContain('location.candidature');
    // Le journal d'une visite, sous `visit:` comme sous `appointment:`.
    await insert('journal', { seq: 7003, at: 't', type: 'visite.confirmee', actor: 'ag', subject: `visit:${seeded.get('appointments')![A]!.id}`, data: '{}', prev_hash: 'p', hash: 'h7003' });
    expect((await assembleAccess(db, [A])).sections.find((s) => s.table === 'journal')!.rows.map((r) => r.type)).toContain('visite.confirmee');
    // L'avis de valeur du bien mis en vente, même pas encore remis ; pas celui d'un bien qu'elle regarde seulement.
    const sold = seeded.get('mandates')![A]!.property_id!;
    await insert('valuation_reports', { id: 'avis-brouillon', network_id: 'n', property_id: sold, agent_id: 'ag', status: 'draft', computed: '{}', computed_low: 1, computed_high: 2, agent_low: null, agent_high: null, text: 'brouillon', text_by: 'ag', created_at: 't', updated_at: 't', validated_by: null, validated_at: null });
    await insert('project_properties', { project_id: seeded.get('projects')![A]!.id!, property_id: 'bien-regarde', network_id: 'n', agent_id: 'ag', role: 'interested', created_at: 't' });
    await insert('valuation_reports', { id: 'avis-autre', network_id: 'n', property_id: 'bien-regarde', agent_id: 'ag', status: 'draft', computed: '{}', computed_low: 1, computed_high: 2, agent_low: null, agent_high: null, text: 'autre', text_by: 'ag', created_at: 't', updated_at: 't', validated_by: null, validated_at: null });
    const reports = (await assembleAccess(db, [A])).sections.find((s) => s.table === 'valuation_reports')!.rows.map((r) => r.id);
    expect(reports).toContain('avis-brouillon');
    expect(reports).not.toContain('avis-autre');
  });

  it('[R96] la lutte contre le blanchiment ne change rien à la réponse : rien ne trahit un signalement', async () => {
    const { db, insert, seeded } = await seedEveryTable();
    const before = await conformite.sha256Of(await assembleAccess(db, [A]));
    await insert('suspicion_reports', { id: 's-1', network_id: 'n', case_ref: 'mandate:x', person_id: A, note: 'note', snapshot: '{}', snapshot_sha256: 'x', reported_by: 'ag', reported_at: 't' });
    await insert('risk_sheets', { id: 'k-1', network_id: 'n', person_id: A, relation: 'vendeur', case_ref: 'mandate:x', grid_version: 'g', inputs: '{}', criteria: '[]', level: 'eleve', fingerprint: 'f', prepared_by: 'ag', prepared_at: 't' });
    for (const [seq, type] of [[9001, 'risque.prepare'], [9002, 'coffre.depose'], [9003, 'vigilance.alerte'], [9004, 'conformite.signalement'], [9005, 'identification.declaree']] as const) {
      await insert('journal', { seq, at: 't', type, actor: 'ag', subject: `person:${A}`, data: '{}', prev_hash: 'p', hash: `h${seq}` });
    }
    // Les gestes de la lutte contre le blanchiment écrits par d'autres modules : refus de lire le coffre, la fiche de
    // risque ou la vigilance, dossier bloqué par l'identification.
    const mandate = `mandate:${seeded.get('mandates')![A]!.id}`;
    const others: [number, string, string, string][] = [
      [9101, 'acces.refuse', `person:${A}`, '{"rule":"R90","kind":"compliance_vault","code":"role"}'],
      [9102, 'acces.refuse', `person:${A}`, '{"rule":"R91","kind":"risk_sheet","code":"role"}'],
      [9103, 'acces.refuse', mandate, '{"rule":"R16","kind":"vigilance","code":"role"}'],
      [9104, 'acces.refuse', `person:${A}`, '{"rule":"R16","kind":"identification","code":"not_assigned"}'],
      [9105, 'dossier.bloque', `sale_file:${seeded.get('sale_files')![A]!.id}`, '{"rule":"R58","code":"identity_missing"}'],
      [9106, 'mandat.refuse', mandate, '{"rule":"R92","code":"identity_missing"}'],
    ];
    for (const [seq, type, subject, data] of others) await insert('journal', { seq, at: 't', type, actor: 'ag', subject, data, prev_hash: 'p', hash: `h${seq}` });
    expect(await conformite.sha256Of(await assembleAccess(db, [A]))).toBe(before);
  });
});

// Un lundi de février, à 10 h à Paris.
const NOW = new Date('2027-02-01T09:00:00.000Z');

async function setup() {
  const t = await setupAnnonce();
  t.setClock(NOW);
  const fiche = new FicheUnique(t.db, t.store, { now: t.now });
  const decisions = new DecisionEnvoi(t.db, t.store, fiche, { now: t.now });
  const demandes = new conformite.DemandesPersonnes(t.db, t.journal, fiche, decisions, { now: t.now });
  const as = (role: string, userId: string): Viewer => ({ role, userId, networkId: t.network.id }) as Viewer;
  const responsable = as('compliance', 'conformite-1');
  const record = async (kind: conformite.PersonRequestKind, personId = t.personId, receivedOn = '2027-02-01') => {
    const r = await demandes.record(responsable, { personId, kind, channel: 'mail', receivedOn });
    if (!r.ok) throw new Error(r.code);
    return r.value;
  };
  return { ...t, fiche, decisions, demandes, responsable, record, partner: as('partner', 'partenaire-1') };
}

const countAll = async (db: SqlDatabase) => {
  const tables = await db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name");
  const out: Record<string, number> = {};
  for (const { name } of tables) out[name] = (await db.first<{ n: number }>(`SELECT count(*) AS n FROM "${name}"`))!.n;
  return out;
};

describeWithSqlite('L07 · demandes des personnes en moins d’un mois, avec preuve', () => {
  it('[R96] [R16] la demande d’accès : réponse de toutes les fiches réunies, empreinte gardée, réponse notée une fois', async () => {
    const t = await setup();
    // Une deuxième fiche de la même personne, réunie à la première ; une autre personne, sans lien.
    const twin = await t.store.createPerson({ networkId: t.network.id, agentId: null, firstName: 'Léa', lastName: 'Exemple' });
    await t.store.addIdentifier({ networkId: t.network.id, personId: twin.id, kind: 'email', value: 'lea.double@example.test' });
    await t.fiche.merge({ survivorId: t.personId, mergedId: twin.id, reason: 'même adresse' });
    const other = await t.store.createPerson({ networkId: t.network.id, agentId: null, firstName: 'Noé', lastName: 'Autre' });
    await t.store.addIdentifier({ networkId: t.network.id, personId: other.id, kind: 'email', value: 'noe.autre@example.test' });
    const request = await t.record('acces', twin.id);
    // Échéance calculée par le code, un mois après la réception.
    expect(request).toMatchObject({ kind: 'acces', receivedOn: '2027-02-01', dueOn: '2027-03-01', noticeOn: '2027-02-22', answeredOn: null });
    // Personne d'autre que le responsable.
    for (const viewer of [t.agent, t.direction, t.partner]) {
      expect(await t.demandes.prepareAccess(viewer, request.id)).toEqual({ ok: false, rule: 'R16', code: 'role' });
      expect(await t.demandes.record(viewer, { personId: t.personId, kind: 'acces', channel: 'mail', receivedOn: '2027-02-01' })).toEqual({ ok: false, rule: 'R16', code: 'role' });
      expect(await t.demandes.list(viewer)).toEqual({ ok: false, rule: 'R16', code: 'role' });
    }
    // Pas de réponse notée sans réponse préparée.
    expect(await t.demandes.answer(t.responsable, request.id, { answeredOn: '2027-02-01' })).toEqual({ ok: false, rule: 'R96', code: 'not_prepared' });
    const prepared = await t.demandes.prepareAccess(t.responsable, request.id);
    if (!prepared.ok) throw new Error(prepared.code);
    const text = JSON.stringify(prepared.value.response);
    expect(prepared.value.response.personIds).toEqual([t.personId, twin.id]);
    expect(text).toContain('lea.double@example.test');
    expect(text).not.toContain('noe.autre@example.test');
    expect(text).not.toContain(other.id);
    const tables = prepared.value.response.sections.map((s) => s.table);
    expect(tables).toEqual(expect.arrayContaining(['persons', 'person_identifiers', 'person_merges', 'mandates', 'documents', 'properties', 'journal', 'person_requests']));
    expect(prepared.value.response.sections.find((s) => s.table === 'persons')!.rows.map((r) => r.id).sort()).toEqual([t.personId, twin.id].sort());
    // La base garde l'empreinte, jamais une copie.
    expect(await t.db.all('SELECT request_id, kind, mode, output_sha256 FROM person_request_outputs')).toEqual([{ request_id: request.id, kind: 'reponse_acces', mode: 'reel', output_sha256: prepared.value.sha256 }]);
    // La réponse notée a l'empreinte de la réponse préparée ; une seule fois.
    const answered = await t.demandes.answer(t.responsable, request.id, { answeredOn: '2027-02-01' });
    expect(answered).toMatchObject({ ok: true, value: { answeredOn: '2027-02-01', answerSha256: prepared.value.sha256, late: false } });
    expect(await t.demandes.answer(t.responsable, request.id, { answeredOn: '2027-02-01' })).toEqual({ ok: false, rule: null, code: 'already_answered' });
    // Au journal, sans donnée personnelle, et la chaîne tient.
    const events = await t.journal.bySubject(`person_request:${request.id}`);
    expect(events.map((e) => e.type)).toEqual(['rgpd.demande', 'rgpd.reponse_acces_preparee', 'rgpd.reponse']);
    expect(JSON.stringify(events)).not.toContain('example.test');
    expect((await verifyChain(await t.journal.all())).ok).toBe(true);
    // Entrées refusées.
    expect(await t.demandes.record(t.responsable, { personId: t.personId, kind: 'acces', channel: 'mail', receivedOn: '2027-02-02' })).toEqual({ ok: false, rule: null, code: 'future_date' });
    expect(await t.demandes.record(t.responsable, { personId: 'inconnue', kind: 'acces', channel: 'mail', receivedOn: '2027-02-01' })).toEqual({ ok: false, rule: null, code: 'unknown_person' });
    expect(await t.demandes.record(t.responsable, { personId: t.personId, kind: 'autre' as never, channel: 'mail', receivedOn: '2027-02-01' })).toEqual({ ok: false, rule: null, code: 'bad_kind' });
    expect(await t.demandes.record(t.responsable, { personId: t.personId, kind: 'acces', channel: 'pigeon' as never, receivedOn: '2027-02-01' })).toEqual({ ok: false, rule: null, code: 'bad_channel' });
    expect(await t.demandes.record(t.responsable, { personId: t.personId, kind: 'acces', channel: 'mail', receivedOn: '2027-02-30' })).toEqual({ ok: false, rule: null, code: 'bad_date' });
  });

  it('[R96] échéance et alertes vérifiées jour par jour : rappel 7 jours avant, puis le jour même, une seule fois', async () => {
    const t = await setup();
    // Reçue le 31 janvier : l'échéance tombe le dernier jour de février.
    t.setClock(new Date('2027-01-31T09:00:00.000Z'));
    const late = await t.record('rectification', t.personId, '2027-01-31');
    const answered = await t.record('acces', t.personId, '2027-01-31');
    expect(late.dueOn).toBe('2027-02-28');
    const raised: Record<string, number> = {};
    for (let d = Date.parse('2027-01-31T09:00:00.000Z'); d <= Date.parse('2027-03-05T09:00:00.000Z'); d += 86_400_000) {
      t.setClock(new Date(d));
      const day = new Date(d).toISOString().slice(0, 10);
      if (day === '2027-02-10') {
        await t.demandes.prepareAccess(t.responsable, answered.id);
        await t.demandes.answer(t.responsable, answered.id, { answeredOn: day });
      }
      const n = await t.demandes.run(t.network.id);
      // Le planificateur repasse le même jour : rien de plus.
      expect(await t.demandes.run(t.network.id)).toBe(0);
      if (n > 0) raised[day] = n;
    }
    expect(raised).toEqual({ '2027-02-21': 1, '2027-02-28': 1 });
    const alerts = await t.demandes.alerts(t.responsable);
    expect(alerts).toMatchObject({
      ok: true,
      value: [
        { requestId: late.id, kind: 'rappel', dueOn: '2027-02-28', text: 'Demande de rectification à traiter avant le 28/02/2027.' },
        { requestId: late.id, kind: 'echeance', text: "Demande de rectification : l'échéance du 28/02/2027 est arrivée, la réponse n'est pas notée." },
      ],
    });
    expect(await t.demandes.alerts(t.agent)).toEqual({ ok: false, rule: 'R16', code: 'role' });
    // Une réponse après l'échéance est notée en retard, avec sa preuve.
    expect(await t.demandes.answer(t.responsable, late.id, { answeredOn: '2027-03-02' })).toMatchObject({ ok: true, value: { late: true, answeredOn: '2027-03-02' } });
    expect(await t.demandes.answer(t.responsable, late.id, { answeredOn: '2027-03-01' })).toEqual({ ok: false, rule: null, code: 'already_answered' });
    // Un planificateur qui a manqué des jours rattrape les deux alertes d'un coup, sans doublon.
    t.setClock(new Date('2027-03-05T09:00:00.000Z'));
    const missed = await t.record('rectification', t.personId, '2027-02-01');
    expect(missed.dueOn).toBe('2027-03-01');
    expect(await t.demandes.run(t.network.id)).toBe(2);
    expect(await t.demandes.run(t.network.id)).toBe(0);
    const list = await t.demandes.list(t.responsable);
    expect(list.ok && list.value.map((r) => [r.dueOn, r.kind, r.answeredOn]).sort()).toEqual([['2027-02-28', 'acces', '2027-02-10'], ['2027-02-28', 'rectification', '2027-03-02'], ['2027-03-01', 'rectification', null]]);
  });

  it('[R96] [R04] l’opposition pose aussitôt l’arrêt sur tous les canaux', async () => {
    const t = await setup();
    const before = await t.decisions.facts(t.personId, NOW);
    expect(before.exclusions.filter((e) => e.lifted_at === null)).toEqual([]);
    const request = await t.record('opposition');
    const facts = await t.decisions.facts(t.personId, NOW);
    expect(facts.exclusions).toEqual([expect.objectContaining({ id: request.exclusionId, reason: 'stop', channel: null, lifted_at: null })]);
    // La réponse : la preuve est l'arrêt posé.
    expect(await t.demandes.answer(t.responsable, request.id, { answeredOn: '2027-02-01' })).toMatchObject({ ok: true, value: { late: false } });
    expect(await t.demandes.prepareAccess(t.responsable, request.id)).toEqual({ ok: false, rule: null, code: 'not_access' });
  });

  it('[R17] [R96] l’effacement, en mode essai tant que H29 n’est pas fait : il garde registre, anti-blanchiment et factures, et n’efface rien', async () => {
    const t = await setup();
    await t.store.addIdentifier({ networkId: t.network.id, personId: t.personId, kind: 'email', value: 'lea.exemple@example.test' });
    await t.decisions.recordStopRequest({ networkId: t.network.id, personId: t.personId, at: NOW });
    const request = await t.record('effacement');
    expect(await t.demandes.prepareErasure(t.agent, request.id)).toEqual({ ok: false, rule: 'R16', code: 'role' });
    const before = await countAll(t.db);
    const r = await t.demandes.prepareErasure(t.responsable, request.id);
    if (!r.ok) throw new Error(r.code);
    expect(r.value.plan.mode).toBe('essai');
    const action = Object.fromEntries(r.value.plan.lines.map((l) => [l.table, l.action]));
    // Le registre des mandats, les documents signés et le journal sont gardés ; la fiche serait effacée.
    expect(action).toMatchObject({ mandate_register: 'garder', mandates: 'garder', documents: 'garder', journal: 'garder', persons: 'effacer' });
    // L'arrêt de la personne reste, ses identifiants sous leur seule empreinte : elle ne sera plus jamais recontactée [R04].
    expect(action).toMatchObject({ exclusions: 'garder', person_identifiers: 'empreinte' });
    expect(r.value.plan.lines.find((l) => l.table === 'mandate_register')!.rows).toBe(1);
    expect(r.value.plan.alwaysKept.join(' ')).toContain('L561');
    // Les factures sont gardées : leur traitement est une obligation légale.
    expect(erasurePlan({ response: { personIds: [], notIncluded: [], sections: [{ table: 'invoices', traitement: 'commissions-factures', finalite: '', baseLegale: '', duree: '', destinataires: [], sousTraitants: [], rows: [{}] }] }, exclusiveRows: { invoices: 1 } }).lines).toEqual([
      expect.objectContaining({ table: 'invoices', action: 'garder' }),
    ]);
    // Rien n'est effacé : seules les lignes de preuve de la demande s'ajoutent.
    const after = await countAll(t.db);
    const changed = Object.keys(after).filter((k) => after[k] !== before[k]);
    expect(changed.sort()).toEqual(['journal', 'person_request_outputs']);
    expect(after.journal).toBe(before.journal! + 1);
    const event = (await t.journal.bySubject(`person_request:${request.id}`)).at(-1)!;
    expect(event).toMatchObject({ type: 'rgpd.effacement_essai', data: { rule: 'R17', mode: 'essai', erased: 0, sha256: r.value.sha256 } });
    expect(await t.demandes.answer(t.responsable, request.id, { answeredOn: '2027-02-01' })).toMatchObject({ ok: true, value: { answerSha256: r.value.sha256 } });
    // Aucun envoi : rien n'est parti vers la personne.
    expect(after.send_log).toBe(before.send_log);
    expect(after.messages).toBe(before.messages);
  });
});

describeWithSqlite('RC35 · une demande de rectification voit le nom corrigé à la demande de la personne', () => {
  const setupRectif = async () => {
    const t = await setup();
    const nom = new CorrigerNom(t.db, t.acces, t.journal, { now: t.now });
    const correct = async (personId: string, reason: 'demande_de_la_personne' | 'faute_de_frappe', lastName: string) => {
      const r = await nom.correct(t.direction, personId, { lastName, reason });
      if (!r.ok) throw new Error(r.code);
    };
    const one = async (id: string) => {
      const list = await t.demandes.list(t.responsable);
      if (!list.ok) throw new Error(list.code);
      return list.value.find((r) => r.id === id)!;
    };
    return { ...t, correct, one };
  };

  it('[R96] la correction du nom faite à la demande de la personne après la réception : son jour, et les alertes le disent', async () => {
    const t = await setupRectif();
    const request = await t.record('rectification', t.personId, '2027-01-28');
    expect(request.rectifiedOn).toBeNull();
    // Le 3 février, la direction corrige le nom à la demande de la personne.
    t.setClock(new Date('2027-02-03T09:00:00.000Z'));
    await t.correct(t.personId, 'demande_de_la_personne', 'Rectifiée');
    t.setClock(new Date('2027-02-05T09:00:00.000Z'));
    await t.correct(t.personId, 'demande_de_la_personne', 'Rectifiéebis');
    expect((await t.one(request.id)).rectifiedOn).toBe('2027-02-03');
    // Rappel puis échéance : le texte dit la correction, la réponse reste à noter.
    t.setClock(new Date('2027-02-28T09:00:00.000Z'));
    expect(await t.demandes.run(t.network.id)).toBe(2);
    const alerts = await t.demandes.alerts(t.responsable);
    expect(alerts.ok && alerts.value.map((a) => a.text)).toEqual([
      'Demande de rectification : nom corrigé le 03/02/2027, la réponse à la personne reste à noter avant le 28/02/2027.',
      "Demande de rectification : nom corrigé le 03/02/2027, l'échéance du 28/02/2027 est arrivée, la réponse n'est pas notée.",
    ]);
    // La demande n'est pas close seule.
    expect((await t.one(request.id)).answeredOn).toBeNull();
    // Aucun nom dans la demande, les alertes ni le journal [R13].
    const text = JSON.stringify([await t.demandes.list(t.responsable), alerts, await t.journal.all()]);
    for (const name of ['Rectifiée', 'Rectifiéebis']) expect(text).not.toContain(name);
  });

  it('[R96] une correction avant la réception, ou pour un autre motif, ne compte pas ; une autre sorte de demande non plus', async () => {
    const t = await setupRectif();
    t.setClock(new Date('2027-01-20T09:00:00.000Z'));
    await t.correct(t.personId, 'demande_de_la_personne', 'Avant');
    t.setClock(NOW);
    const request = await t.record('rectification', t.personId, '2027-02-01');
    const access = await t.record('acces', t.personId, '2027-01-25');
    await t.correct(t.personId, 'faute_de_frappe', 'Frappe');
    expect((await t.one(request.id)).rectifiedOn).toBeNull();
    expect((await t.one(access.id)).rectifiedOn).toBeNull();
    // Le jour même de la réception compte.
    await t.correct(t.personId, 'demande_de_la_personne', 'Pendant');
    expect((await t.one(request.id)).rectifiedOn).toBe('2027-02-01');
    expect((await t.one(access.id)).rectifiedOn).toBeNull();
  });

  it('[R96] fiches réunies : la correction faite sur l’autre fiche compte', async () => {
    const t = await setupRectif();
    const twin = await t.store.createPerson({ networkId: t.network.id, agentId: null, firstName: 'Léa', lastName: 'Exemple' });
    const request = await t.record('rectification', twin.id, '2027-02-01');
    // Correction sur la fiche d'origine, encore à part : la demande de l'autre ne la voit pas.
    await t.correct(t.personId, 'demande_de_la_personne', 'Réunie');
    expect((await t.one(request.id)).rectifiedOn).toBeNull();
    await t.fiche.merge({ survivorId: t.personId, mergedId: twin.id, reason: 'même personne' });
    expect((await t.one(request.id)).rectifiedOn).toBe('2027-02-01');
  });

  it('[R96] la réponse notée garde les corrections dans son empreinte ; celle d’une opposition ne change pas', async () => {
    const answerOf = async (withCorrection: boolean, kind: 'rectification' | 'opposition') => {
      const t = await setupRectif();
      const request = await t.record(kind, t.personId, '2027-02-01');
      if (withCorrection) await t.correct(t.personId, 'demande_de_la_personne', 'Empreinte');
      const r = await t.demandes.answer(t.responsable, request.id, { answeredOn: '2027-02-01' });
      if (!r.ok) throw new Error(r.code);
      // Avec un identifiant de demande fixé, pour comparer deux bases.
      return { sha: r.value.answerSha256, request, t };
    };
    const without = await answerOf(false, 'rectification');
    const withC = await answerOf(true, 'rectification');
    const expected = async (id: string, corrections: string[]) =>
      conformite.sha256Of({ request: id, kind: 'rectification', exclusion: null, answeredOn: '2027-02-01', corrections });
    expect(without.sha).toBe(await expected(without.request.id, []));
    const ids = (await withC.t.db.all<{ id: string }>("SELECT id FROM person_name_corrections WHERE reason = 'demande_de_la_personne'")).map((r) => r.id);
    expect(ids).toHaveLength(1);
    expect(withC.sha).toBe(await expected(withC.request.id, ids));
    // L'opposition garde l'empreinte d'avant, avec ou sans correction.
    for (const c of [false, true]) {
      const o = await answerOf(c, 'opposition');
      expect(o.sha).toBe(await conformite.sha256Of({ request: o.request.id, kind: 'opposition', exclusion: o.request.exclusionId, answeredOn: '2027-02-01' }));
    }
    // Au journal de la réponse : l'empreinte, aucun nom [R13].
    expect(JSON.stringify(await withC.t.journal.all())).not.toContain('Empreinte');
  });
});
