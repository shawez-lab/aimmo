import { expect, it } from 'vitest';
import { handleRequest, type ApiConfig } from '../src/app.ts';
import { sha256Hex } from '../src/index.ts';
import { FicheClient, SqlJournalStore, applyMigrations, fromSyncSqlite, type SqlDatabase } from '../../core/src/index.ts';
import { CLAUSE_CODES, QUESTION_CODES } from '../../core/src/mandat-questionnaire/questionnaire.ts';
import { loadMigrations } from '../../core/test/migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from '../../core/test/sqlite.ts';

// Réseau, agents, clients, biens, modèles, clauses et clés d'API inventés : aucun texte juridique réel.
const NOW = Date.parse('2027-04-12T09:00:00.000Z');
const KEYS = {
  alex: 'test-cle-br115-alex-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  sam: 'test-cle-br115-sam-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  direction: 'test-cle-br115-direction-cccccccccccccccccccccc',
  conformite: 'test-cle-br115-conformite-ddddddddddddddddddddd',
  /** La même personne que `conformite`, sous le rôle de la direction. */
  meme: 'test-cle-br115-meme-personne-eeeeeeeeeeeeeeeeeee',
};
type Who = keyof typeof KEYS;
const SIMPLE = ['MANDAT DE VENTE SIMPLE (MODÈLE DE TEST)', 'Entre {{mandant.nom}} et {{reseau.nom}}, représenté par {{agent.nom}}.', 'Bien {{bien.reference}}, {{bien.commune}}, au prix de {{bien.prix}}.', 'Honoraires : {{honoraires.montant}}, {{honoraires.charge}}. Durée : {{mandat.duree_mois}}.', 'Numéro au registre : {{registre.numero}}. Fait le {{document.date}}.'].join('\n\n');
const EXCLUSIF = SIMPLE.replace('SIMPLE', 'EXCLUSIF') + '\n\n!! Clause d’exclusivité du modèle de test.';
const BASE = { exclusivite: 'non', lieu_signature: 'agence', vendeurs: 'une', occupation: 'libre', copropriete: 'non', honoraires: 'vendeur' };
const INPUTS = { 'honoraires.montant': 9000, 'mandat.duree_mois': 3 };

async function setup(o: { price?: number } = {}) {
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  const now = (): Date => new Date(NOW);
  const journal = new SqlJournalStore(db);
  const store = new FicheClient(db, { now });
  const network = await store.createNetwork('Réseau test');
  const alex = await store.createAgent({ networkId: network.id, firstName: 'Alex', lastName: 'Agent' });
  const sam = await store.createAgent({ networkId: network.id, firstName: 'Sam', lastName: 'Agent' });
  const person = await store.createPerson({ networkId: network.id, agentId: alex.id, firstName: 'Prénom', lastName: 'Inventé' });
  const property = await store.createProperty({ networkId: network.id, agentId: alex.id, reference: 'REF-BR115', kind: 'home', postalCode: '21000', city: 'Dijon', surfaceM2: 80, rooms: 4, priceEur: o.price ?? 330000 });
  const ids: Record<Who, { role: string; userId: string }> = {
    alex: { role: 'agent', userId: alex.id },
    sam: { role: 'agent', userId: sam.id },
    direction: { role: 'direction', userId: 'direction-1' },
    conformite: { role: 'compliance', userId: 'conformite-1' },
    meme: { role: 'direction', userId: 'conformite-1' },
  };
  const apiKeys = JSON.stringify(await Promise.all((Object.keys(KEYS) as Who[]).map(async (w) => ({ sha256: await sha256Hex(KEYS[w]), networkId: network.id, ...ids[w] }))));
  const config: ApiConfig = { db, apiKeys, mode: 'essai', now };
  const http = async (who: Who, method: string, path: string, body?: unknown, raw?: string) => {
    const headers: Record<string, string> = { authorization: `Bearer ${KEYS[who]}` };
    if (body !== undefined || raw !== undefined) headers['content-type'] = 'application/json';
    const payload = raw ?? (body === undefined ? undefined : JSON.stringify(body));
    const r = await handleRequest(new Request(`https://aimmo-api.example.test/v1${path}`, { method, headers, ...(payload === undefined ? {} : { body: payload }) }), config);
    return { status: r.status, body: (await r.json()) as { ok: boolean; data?: any; rule?: string | null; code?: string; mode?: string; field?: string } };
  };
  /** Les deux modèles de mandat, écrits par la direction et validés par la conformité (D02). */
  const templates = async () => {
    for (const [kind, body] of [['mandat_vente_simple', SIMPLE], ['mandat_vente_exclusif', EXCLUSIF]] as const) {
      const v = await http('direction', 'POST', '/modeles', { kind, body });
      expect(v.status, v.body.code).toBe(200);
      expect((await http('conformite', 'POST', `/modeles/${v.body.data.id}/validation`)).status).toBe(200);
    }
  };
  /** Le texte de chaque clause, écrit par la direction, validé par la conformité si demandé. */
  const clauses = async (validate: boolean) => {
    for (const code of CLAUSE_CODES) {
      const w = await http('direction', 'POST', '/questionnaire-mandat/clauses', { code, body: `Texte de test de la clause ${code}.` });
      expect(w.status, w.body.code).toBe(200);
      if (validate) expect((await http('conformite', 'POST', `/questionnaire-mandat/clauses/${w.body.data.id}/validation`, {})).status).toBe(200);
    }
  };
  const valuation = (low: number, high: number) =>
    db.run(
      `INSERT INTO valuation_reports (id, network_id, property_id, agent_id, status, computed, computed_low, computed_high, agent_low, agent_high, text, text_by, created_at, updated_at, validated_by, validated_at)
       VALUES ('val-1', ?, ?, ?, 'validated', '{}', ?, ?, NULL, NULL, 'Avis de test', 'fallback', '2027-04-01T10:00:00.000Z', '2027-04-01T10:00:00.000Z', ?, '2027-04-01T10:00:00.000Z')`,
      [network.id, property.id, alex.id, low, high, `agent:${alex.id}`],
    );
  const prepare = (who: Who = 'alex', answers: unknown = BASE) => http(who, 'POST', '/questionnaire-mandat/mandats', { personId: person.id, propertyId: property.id, answers, inputs: INPUTS });
  const refusals = async () => (await journal.all()).filter((e) => e.type === 'acces.refuse');
  const count = async (table: string) => Number((await db.first<{ n: number }>(`SELECT count(*) AS n FROM ${table}`))!.n);
  return { db, journal, config, http, templates, clauses, valuation, prepare, refusals, count, person, property };
}

/** Une requête dont le corps ne doit pas être lu : s'il l'était avant le rôle, la route ne répondrait pas 403. */
function untouchable(url: string, init: RequestInit): Request {
  const r = new Request(url, init);
  Object.defineProperty(r, 'text', { value: () => Promise.reject(new Error('corps lu avant le contrôle du rôle')) });
  Object.defineProperty(r, 'json', { value: () => Promise.reject(new Error('corps lu avant le contrôle du rôle')) });
  return r;
}

describeWithSqlite('BR115 · routes du mandat par questionnaire', () => {
  it('[R16] chaque route refuse le mauvais rôle en 403, au journal, avant toute lecture du corps', async () => {
    const t = await setup();
    const cases: [Who, string, string][] = [
      ['alex', 'GET', '/questionnaire-mandat/clauses'],
      ['alex', 'POST', '/questionnaire-mandat/clauses'],
      ['conformite', 'POST', '/questionnaire-mandat/clauses'],
      ['direction', 'POST', '/questionnaire-mandat/clauses/c-1/validation'],
      ['alex', 'POST', '/questionnaire-mandat/clauses/c-1/validation'],
      ['alex', 'POST', '/questionnaire-mandat/reglage'],
      ['conformite', 'POST', '/questionnaire-mandat/reglage'],
      ['conformite', 'POST', '/questionnaire-mandat/mandats'],
      ['direction', 'POST', '/questionnaire-mandat/mandats/q-1/ecart-montre'],
      ['conformite', 'POST', '/questionnaire-mandat/mandats/q-1/ecart-montre'],
    ];
    for (const [who, method, path] of cases) {
      const before = (await t.refusals()).length;
      const r = await t.http(who, method, path, undefined, method === 'POST' ? 'pas du json' : undefined);
      expect(r.status, `${who} ${method} ${path}`).toBe(403);
      expect(r.body).toMatchObject({ ok: false, rule: 'R16', code: 'role' });
      expect((await t.refusals()).length, `${who} ${method} ${path}`).toBe(before + 1);
      if (method === 'POST') {
        const req = untouchable(`https://aimmo-api.example.test/v1${path}`, { method, headers: { authorization: `Bearer ${KEYS[who]}`, 'content-type': 'application/json' }, body: '{}' });
        expect((await handleRequest(req, t.config)).status, `${who} ${method} ${path} (corps)`).toBe(403);
      }
    }
    expect((await t.refusals()).filter((e) => e.data.kind === 'mandat_questionnaire').length).toBe(19);
  });

  it('[R440] les questions et les clauses se lisent en liste fermée, chaque clause avec sa réponse et son texte de loi', async () => {
    const t = await setup();
    for (const who of ['alex', 'direction', 'conformite'] as const) {
      const r = await t.http(who, 'GET', '/questionnaire-mandat');
      expect(r.status).toBe(200);
      expect(r.body.mode).toBe('essai');
      expect(r.body.data.questions.map((q: { code: string }) => q.code)).toEqual(QUESTION_CODES);
      expect(r.body.data.clauses.map((c: { code: string }) => c.code)).toEqual(CLAUSE_CODES);
      for (const c of r.body.data.clauses) {
        expect(c.basis.length).toBeGreaterThan(10);
        for (const w of c.when) {
          const q = r.body.data.questions.find((x: { code: string }) => x.code === w.question);
          expect(q.answers.map((a: { value: string }) => a.value)).toContain(w.answer);
        }
      }
      expect(r.body.data.defaultMaxGapBps).toBe(500);
    }
    expect((await t.http('alex', 'GET', '/questionnaire-mandat?x=1')).body).toMatchObject({ code: 'unknown_field', field: 'x' });
  });

  it('[R442] la direction écrit, la conformité lit et valide, jamais un texte qu’elle a écrit ; une version ne se valide qu’une fois', async () => {
    const t = await setup();
    const w1 = await t.http('direction', 'POST', '/questionnaire-mandat/clauses', { code: 'exclusivite', body: 'Texte de test, première version.' });
    const w2 = await t.http('direction', 'POST', '/questionnaire-mandat/clauses', { code: 'exclusivite', body: 'Texte de test, seconde version.' });
    expect(w1.body.data.version).toBe(1);
    expect(w2.body.data.version).toBe(2);
    expect((await t.http('direction', 'POST', '/questionnaire-mandat/clauses', { code: 'inventee', body: 'Texte.' })).body).toMatchObject({ code: 'unknown_clause', rule: 'R440' });
    expect((await t.http('direction', 'POST', '/questionnaire-mandat/clauses', { code: 'exclusivite', body: 'Texte {{mandant.nom}}.' })).body).toMatchObject({ code: 'field_in_clause' });
    expect((await t.http('direction', 'POST', '/questionnaire-mandat/clauses', { code: 'exclusivite', body: '' })).body).toMatchObject({ code: 'empty_body' });
    expect((await t.http('direction', 'POST', '/questionnaire-mandat/clauses', { code: 'exclusivite', body: 'x', autre: 1 })).body).toMatchObject({ code: 'unknown_field', field: 'autre' });

    const list = await t.http('conformite', 'GET', '/questionnaire-mandat/clauses');
    expect(list.status).toBe(200);
    expect(list.body.data.map((v: { version: number; status: string }) => [v.version, v.status])).toEqual([[2, 'essai'], [1, 'essai']]);
    expect(list.body.data[0]).toMatchObject({ code: 'exclusivite', title: 'Exclusivité', body: 'Texte de test, seconde version.', ownText: false });

    const ok = await t.http('conformite', 'POST', `/questionnaire-mandat/clauses/${w1.body.data.id}/validation`, {});
    expect(ok.status).toBe(200);
    const again = await t.http('conformite', 'POST', `/questionnaire-mandat/clauses/${w1.body.data.id}/validation`, {});
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({ rule: 'R442', code: 'already_validated' });
    expect((await t.http('conformite', 'POST', '/questionnaire-mandat/clauses/inconnue/validation', {})).status).toBe(404);
    const after = await t.http('direction', 'GET', '/questionnaire-mandat/clauses');
    expect(after.body.data.map((v: { version: number; status: string }) => [v.version, v.status])).toEqual([[2, 'essai'], [1, 'valide']]);

    // Un texte que la personne de la conformité a écrit sous le rôle de la direction : elle ne le valide pas [R442].
    const w3 = await t.http('meme', 'POST', '/questionnaire-mandat/clauses', { code: 'copropriete', body: 'Texte de test écrit par la conformité.' });
    expect(w3.status).toBe(200);
    expect((await t.http('conformite', 'GET', '/questionnaire-mandat/clauses')).body.data.find((v: { id: string }) => v.id === w3.body.data.id).ownText).toBe(true);
    const mine = await t.http('conformite', 'POST', `/questionnaire-mandat/clauses/${w3.body.data.id}/validation`, {});
    expect(mine.status).toBe(403);
    expect(mine.body).toMatchObject({ rule: 'R16', code: 'own_clause' });
    expect(await t.count('mandate_clause_validations')).toBe(1);
  });

  it('[R441] le réglage de l’écart : la direction seule, borné ; un prix hors fourchette bloque jusqu’au geste de l’agent du bien', async () => {
    const t = await setup({ price: 360000 });
    await t.templates();
    await t.valuation(280000, 310000);
    expect((await t.http('direction', 'POST', '/questionnaire-mandat/reglage', { maxGapBps: -1 })).body).toMatchObject({ rule: 'R441', code: 'bad_setting' });
    expect((await t.http('direction', 'POST', '/questionnaire-mandat/reglage', { maxGapBps: '500' })).status).toBe(400);
    expect((await t.http('direction', 'POST', '/questionnaire-mandat/reglage', { maxGapBps: 1000 })).status).toBe(200);
    const r = await t.prepare();
    expect(r.status, r.body.code).toBe(200);
    expect(r.body.data.price).toMatchObject({ priceEur: 360000, low: 280000, high: 310000, gapBps: 1613, maxGapBps: 1000, check: 'ecart' });
    expect(r.body.data.mode).toBe('reel');
    const id = r.body.data.id as string;
    expect((await t.http('alex', 'GET', `/questionnaire-mandat/mandats/${id}/avant-signature`)).body.data).toEqual({ ready: false, blockers: ['ecart_prix'] });
    // Un autre agent ne lit ni ne montre à la place de l'agent du bien [R16].
    expect((await t.http('sam', 'GET', `/questionnaire-mandat/mandats/${id}/avant-signature`)).status).toBe(403);
    expect((await t.http('sam', 'POST', `/questionnaire-mandat/mandats/${id}/ecart-montre`, {})).status).toBe(403);
    expect((await t.http('alex', 'POST', `/questionnaire-mandat/mandats/${id}/ecart-montre`, {})).status).toBe(200);
    const twice = await t.http('alex', 'POST', `/questionnaire-mandat/mandats/${id}/ecart-montre`, {});
    expect(twice.status).toBe(409);
    expect(twice.body.code).toBe('already_acknowledged');
    for (const who of ['alex', 'direction', 'conformite'] as const) expect((await t.http(who, 'GET', `/questionnaire-mandat/mandats/${id}/avant-signature`)).body.data).toEqual({ ready: true, blockers: [] });
    expect((await t.http('alex', 'GET', '/questionnaire-mandat/mandats/inconnu/avant-signature')).status).toBe(404);
    // Le journal ne porte ni prix ni texte [R13].
    const events = JSON.stringify(await t.journal.all());
    expect(events).not.toMatch(/360[\s ]?000/);
    expect(events).not.toContain('Inventé');
  });

  it('[R440] [R442] le mandat préparé : chaque clause dit sa réponse ; clauses d’essai = mandat d’essai ; dans la fourchette, rien à montrer', async () => {
    const t = await setup();
    await t.templates();
    await t.valuation(300000, 340000);
    await t.clauses(false);
    const trial = await t.prepare('alex', { ...BASE, exclusivite: 'oui', lieu_signature: 'hors_agence' });
    expect(trial.status, trial.body.code).toBe(200);
    expect(trial.body.data.kind).toBe('mandat_vente_exclusif');
    expect(trial.body.data.mode).toBe('essai');
    expect(trial.body.data.clauses.map((c: { code: string; status: string }) => [c.code, c.status])).toEqual([['exclusivite', 'essai'], ['retractation', 'essai']]);
    expect(trial.body.data.content).toContain('Retenue par la réponse « hors de l’agence (domicile du vendeur) » à la question « Où le mandat est-il signé ? »');
    expect((await t.http('alex', 'GET', `/questionnaire-mandat/mandats/${trial.body.data.id}/avant-signature`)).body.data).toEqual({ ready: false, blockers: ['essai'] });
    expect((await t.http('alex', 'POST', `/questionnaire-mandat/mandats/${trial.body.data.id}/ecart-montre`, {})).body).toMatchObject({ rule: 'R441', code: 'nothing_to_acknowledge' });
    // La direction prépare aussi.
    expect((await t.prepare('direction')).status).toBe(200);
  });

  it('[R440] [R443] des réponses hors liste, un champ inconnu ou des identifiants mal formés ne rangent rien ; tout s’ajoute', async () => {
    const t = await setup();
    await t.templates();
    const bad = await t.prepare('alex', { ...BASE, vendeurs: 'trois' });
    expect(bad.status).toBe(400);
    expect(bad.body).toMatchObject({ rule: 'R440', code: 'bad_answers' });
    expect((await t.prepare('alex', { ...BASE, autre: 'oui' })).body.code).toBe('bad_answers');
    expect((await t.http('alex', 'POST', '/questionnaire-mandat/mandats', { personId: t.person.id, propertyId: t.property.id, answers: BASE, inputs: { 'honoraires.charge': 'vendeur' } })).body.code).toBe('bad_input');
    expect((await t.http('alex', 'POST', '/questionnaire-mandat/mandats', { personId: 'a b', propertyId: t.property.id, answers: BASE })).body.code).toBe('invalid_ids');
    expect((await t.http('alex', 'POST', '/questionnaire-mandat/mandats', { personId: t.person.id, propertyId: t.property.id, answers: BASE, extra: 1 })).body).toMatchObject({ code: 'unknown_field', field: 'extra' });
    expect((await t.http('alex', 'POST', '/questionnaire-mandat/mandats', undefined, '{')).body.code).toBe('invalid_body');
    expect(await t.count('mandate_questionnaires')).toBe(0);
    // Le bien d'un autre agent : refusé par les droits de D02 [R16].
    expect((await t.prepare('sam')).status).toBe(403);
    expect(await t.count('mandate_questionnaires')).toBe(0);
    // Deux préparations s'ajoutent ; aucune ne remplace l'autre [R443].
    expect((await t.prepare()).status).toBe(200);
    expect((await t.prepare()).status).toBe(200);
    expect(await t.count('mandate_questionnaires')).toBe(2);
  });
});

describeWithSqlite('BR117 · relire les mandats préparés d’un bien', () => {
  it('[R16] [R441] l’agent du bien, la direction et la conformité relisent les mandats préparés, avec le geste et le contrôle', async () => {
    const t = await setup({ price: 360000 });
    await t.templates();
    await t.valuation(280000, 310000);
    const first = await t.prepare();
    const second = await t.prepare('alex', { ...BASE, exclusivite: 'oui' });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect((await t.http('alex', 'POST', `/questionnaire-mandat/mandats/${first.body.data.id}/ecart-montre`, {})).status).toBe(200);
    const path = `/questionnaire-mandat/biens/${t.property.id}/mandats`;
    for (const who of ['alex', 'direction', 'conformite'] as const) {
      const r = await t.http(who, 'GET', path);
      expect(r.status, who).toBe(200);
      expect(r.body.data.map((m: { id: string }) => m.id).sort()).toEqual([first.body.data.id, second.body.data.id].sort());
      const a = r.body.data.find((m: { id: string }) => m.id === first.body.data.id);
      const b = r.body.data.find((m: { id: string }) => m.id === second.body.data.id);
      expect(a).toMatchObject({ kind: 'mandat_vente_simple', gapAcknowledged: true, ready: true, blockers: [], price: { priceEur: 360000, low: 280000, high: 310000, check: 'ecart' } });
      expect(b).toMatchObject({ kind: 'mandat_vente_exclusif', gapAcknowledged: false, ready: false, blockers: ['essai', 'manque', 'ecart_prix'], missing: ['clause:exclusivite'] });
      expect(b.clauses.map((c: { code: string; question: string; answer: string; basis: string }) => [c.code, c.question, c.answer])).toEqual([['exclusivite', 'exclusivite', 'oui']]);
      expect(b.clauses[0].basis.length).toBeGreaterThan(10);
      // Le texte du document n'est pas rendu par la liste : il reste avec les documents du bien.
      expect(a.content).toBeUndefined();
      // Le contrôle de la liste dit la même chose que la route du contrôle avant signature.
      for (const m of [a, b]) expect((await t.http(who, 'GET', `/questionnaire-mandat/mandats/${m.id}/avant-signature`)).body.data).toEqual({ ready: m.ready, blockers: m.blockers });
    }
  });

  it('[R16] un autre agent est refusé et noté au journal ; un bien inconnu est 404 ; aucun paramètre admis ; rien n’est écrit', async () => {
    const t = await setup();
    await t.templates();
    const path = `/questionnaire-mandat/biens/${t.property.id}/mandats`;
    // Un bien sans mandat préparé : une liste vide, pas un refus.
    expect((await t.http('alex', 'GET', path)).body).toMatchObject({ ok: true, data: [] });
    expect((await t.prepare()).status).toBe(200);
    const before = (await t.refusals()).length;
    const sam = await t.http('sam', 'GET', path);
    expect(sam.status).toBe(403);
    expect(sam.body).toMatchObject({ rule: 'R16', code: 'not_property_agent' });
    expect((await t.refusals()).length).toBe(before + 1);
    expect((await t.http('alex', 'GET', '/questionnaire-mandat/biens/inconnu/mandats')).status).toBe(404);
    expect((await t.http('alex', 'GET', `${path}?prix=1`)).body).toMatchObject({ code: 'unknown_field', field: 'prix' });
    const rows = await t.count('mandate_questionnaires');
    const acks = await t.count('mandate_questionnaire_gap_acks');
    expect((await t.http('alex', 'GET', path)).body.data).toHaveLength(1);
    expect(await t.count('mandate_questionnaires')).toBe(rows);
    expect(await t.count('mandate_questionnaire_gap_acks')).toBe(acks);
  });
});

describeWithSqlite('BR119 · lire l’écart toléré', () => {
  it('[R441] [R16] [R13] le défaut de 5 % tant que rien n’est réglé, puis le dernier réglage, sans qui l’a réglé ; l’agent n’y a pas accès', async () => {
    const t = await setup();
    for (const who of ['direction', 'conformite'] as const) {
      const r = await t.http(who, 'GET', '/questionnaire-mandat/reglage');
      expect(r.status).toBe(200);
      expect(r.body.data).toEqual({ maxGapBps: 500, isDefault: true, setAt: null });
    }
    expect((await t.http('direction', 'POST', '/questionnaire-mandat/reglage', { maxGapBps: 1000 })).status).toBe(200);
    expect((await t.http('direction', 'POST', '/questionnaire-mandat/reglage', { maxGapBps: 250 })).status).toBe(200);
    const after = await t.http('conformite', 'GET', '/questionnaire-mandat/reglage');
    expect(after.body.data).toEqual({ maxGapBps: 250, isDefault: false, setAt: '2027-04-12T09:00:00.000Z' });
    expect(JSON.stringify(after.body)).not.toContain('direction-1');
    // Chaque réglage s'ajoute : l'ancien reste [R441].
    expect(await t.count('mandate_price_gap_settings')).toBe(2);
    const before = (await t.refusals()).length;
    const agent = await t.http('alex', 'GET', '/questionnaire-mandat/reglage');
    expect(agent.status).toBe(403);
    expect(agent.body).toMatchObject({ ok: false, rule: 'R16', code: 'role' });
    expect((await t.refusals()).length).toBe(before + 1);
    expect((await t.http('direction', 'GET', '/questionnaire-mandat/reglage?reseau=autre')).body).toMatchObject({ code: 'unknown_field', field: 'reseau' });
  });
});
