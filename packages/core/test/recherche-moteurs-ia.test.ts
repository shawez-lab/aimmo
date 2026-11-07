import { describe, expect, it } from 'vitest';
import { SqlJournalStore, applyMigrations, fromSyncSqlite, type SqlDatabase } from '../src/index.ts';
import { OrigineContacts } from '../src/attirer/index.ts';
import {
  MoteursIa,
  aiEngineOf,
  answerPage,
  everyNumberSourced,
  frenchDate,
  frenchNumber,
  llmsTxt,
  looksPersonal,
  numbersIn,
  type LlmsEntry,
  type SourcedFact,
} from '../src/recherche/moteurs-ia.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

// Réseau, sources, chiffres, pages et messages inventés.
const NOW = Date.parse('2027-03-09T09:00:00.000Z');
const NOTAIRES = { name: 'Base des ventes (jeu inventé)', url: 'https://ventes.exemple.fr/dijon?zone=centre#prix', date: '2027-01-15' };
const RESEAU = { name: 'Fichier du réseau (jeu inventé)', url: 'https://reseau.exemple.fr/biens', date: '2027-03-01' };
const BAREME = { name: 'Barème du réseau (jeu inventé)', url: 'https://reseau.exemple.fr/honoraires', date: '2027-02-01' };

const FACTS: SourcedFact[] = [
  { id: 'f1', kind: 'prix_m2', propertyKind: 'appartement', value: 2950, source: NOTAIRES },
  { id: 'f2', kind: 'prix_m2', propertyKind: 'maison', value: 3120, source: NOTAIRES },
  { id: 'f3', kind: 'delai_vente', propertyKind: 'maison', value: 74, source: NOTAIRES },
  { id: 'f4', kind: 'biens_en_vente', value: 12, source: RESEAU },
  { id: 'f5', kind: 'honoraires', value: 4.5, source: BAREME },
];

describe('HX30 · réponses factuelles, chaque chiffre sourcé', () => {
  it('écrit les nombres et les dates à la française', () => {
    expect(frenchNumber(2950)).toBe('2 950');
    expect(frenchNumber(4.5)).toBe('4,5');
    expect(frenchNumber(1234567)).toBe('1 234 567');
    expect(frenchDate('2027-01-15')).toBe('15 janvier 2027');
    expect(frenchDate('2027-03-01')).toBe('1er mars 2027');
    expect(numbersIn('2 950 € et 4,5 % le 15 janvier 2027')).toEqual(['2950', '4,5', '15', '2027']);
  });

  it('chaque chiffre publié renvoie à sa source et à sa date [R429]', () => {
    const r = answerPage('Dijon', FACTS, NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.page.path).toBe('/reponses/dijon');
    expect(r.page.answers.map((a) => a.factId)).toEqual(['f1', 'f2', 'f3', 'f4', 'f5']);
    for (const a of r.page.answers) {
      const fact = FACTS.find((f) => f.id === a.factId)!;
      // Chaque nombre de la réponse est la valeur du fait ou un morceau de la date de sa source.
      expect(everyNumberSourced(a.answer, [frenchNumber(fact.value), frenchDate(fact.source.date)])).toBe(true);
      expect(numbersIn(a.answer)).toContain(numbersIn(frenchNumber(fact.value))[0]);
      expect(a.answer).toContain(fact.source.name);
      expect(a.answer).toContain(frenchDate(fact.source.date));
      expect(a.citation).toEqual({ name: fact.source.name, url: fact.source.url.split(/[?#]/)[0], date: fact.source.date });
      expect(numbersIn(a.question)).toEqual([]);
    }
    expect(r.page.answers[0]!.answer).toBe("Le prix médian d'un appartement à Dijon est de 2 950 € le mètre carré, d'après Base des ventes (jeu inventé), relevé du 15 janvier 2027.");
    expect(r.page.answers[4]!.answer).toBe("Les honoraires du réseau sont de 4,5 % du prix de vente, d'après Barème du réseau (jeu inventé), relevé du 1er février 2027.");
    // Chaque réponse de la page porte un lien vers sa source et la date en clair.
    expect(r.page.html.match(/<section class="reponse">/g)).toHaveLength(5);
    expect(r.page.html.match(/Source : <a href="https:\/\/[^"]+"/g)).toHaveLength(5);
    expect(r.page.html).toContain('<time datetime="2027-01-15">15 janvier 2027</time>');
  });

  it('les données structurées citent la source de chaque réponse [R429]', () => {
    const r = answerPage('Dijon', FACTS, NOW);
    if (!r.ok) throw new Error('page attendue');
    const ld = JSON.parse(r.page.jsonLd);
    expect(ld['@type']).toBe('FAQPage');
    expect(ld.mainEntity).toHaveLength(5);
    for (const q of ld.mainEntity) {
      expect(q['@type']).toBe('Question');
      expect(q.acceptedAnswer.citation.url).toMatch(/^https:\/\//);
      expect(q.acceptedAnswer.citation.datePublished).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(q.acceptedAnswer.citation.name.length).toBeGreaterThan(0);
    }
    expect(r.page.html).toContain(`<script type="application/ld+json">${r.page.jsonLd}</script>`);
  });

  it('écarte un fait sans source sûre, sans date, du futur, périmé, absurde ou d\'une sorte inconnue, et dit pourquoi [R429]', () => {
    const r = answerPage(
      'Dijon',
      [
        { id: 'a', kind: 'prix_m2', propertyKind: 'appartement', value: 2950, source: { ...NOTAIRES, url: 'http://ventes.exemple.fr' } },
        { id: 'b', kind: 'prix_m2', propertyKind: 'maison', value: 3120, source: { ...NOTAIRES, date: '' } },
        { id: 'c', kind: 'delai_vente', propertyKind: 'maison', value: 74, source: { ...NOTAIRES, date: '2027-12-01' } },
        { id: 'd', kind: 'delai_vente', propertyKind: 'appartement', value: 60, source: { ...NOTAIRES, date: '2024-01-01' } },
        { id: 'e', kind: 'biens_en_vente', value: -3, source: RESEAU },
        { id: 'f', kind: 'honoraires', value: 45, source: BAREME },
        { id: 'g', kind: 'rendement' as never, value: 5, source: BAREME },
        { id: 'h', kind: 'prix_m2', value: 2950, source: NOTAIRES },
        { id: 'i', kind: 'biens_en_vente', value: 3, source: { ...RESEAU, name: ' ' } },
        { id: 'j', kind: 'biens_en_vente', value: 3, source: { ...RESEAU, url: 'https://carte.exemple.fr/@47.32173,5.04189' } },
        { id: 'ok', kind: 'biens_en_vente', value: 1, source: RESEAU },
      ],
      NOW,
    );
    expect(r).toMatchObject({ ok: true });
    if (!r.ok) return;
    expect(r.page.answers.map((a) => a.factId)).toEqual(['ok']);
    expect(r.page.answers[0]!.answer).toContain('1 bien en vente');
    expect(Object.fromEntries(r.excluded.map((e) => [e.factId, e.reason]))).toEqual({
      a: 'source',
      b: 'date',
      c: 'future',
      d: 'perimee',
      e: 'valeur',
      f: 'valeur',
      g: 'sorte',
      h: 'sorte',
      i: 'source',
      j: 'source',
    });
  });

  it('un nombre qui ne vient pas de la source fait écarter la réponse ou la page [R429]', () => {
    // Un nom de source qui porte un chiffre glisserait un nombre sans source dans la réponse.
    const r = answerPage('Dijon', [{ id: 'x', kind: 'biens_en_vente', value: 12, source: { ...RESEAU, name: 'Top 10 des agences' } }, FACTS[0]!], NOW);
    expect(r.ok && r.page.answers.map((a) => a.factId)).toEqual(['f1']);
    expect(r.excluded).toEqual([{ factId: 'x', reason: 'chiffre_sans_source' }]);
    // Une introduction ne porte aucun chiffre.
    expect(answerPage('Dijon', FACTS, NOW, 'Les prix ont monté de 8 % en un an.')).toMatchObject({ ok: false, code: 'bad_intro' });
    expect(answerPage('Dijon', FACTS, NOW, 'Nos réponses sur le marché de Dijon.').ok).toBe(true);
    expect(everyNumberSourced('de 3 000 € le mètre carré', ['2 950'])).toBe(false);
    expect(everyNumberSourced('de 2 950 €', ['2 950'])).toBe(true);
  });

  it('garde le fait le plus récent par question, et n\'en garde aucun si deux du même jour se contredisent [R429]', () => {
    const r = answerPage(
      'Dijon',
      [
        { id: 'vieux', kind: 'prix_m2', propertyKind: 'appartement', value: 2800, source: { ...NOTAIRES, date: '2026-06-01' } },
        { id: 'neuf', kind: 'prix_m2', propertyKind: 'appartement', value: 2950, source: NOTAIRES },
        { id: 'm1', kind: 'prix_m2', propertyKind: 'maison', value: 3100, source: NOTAIRES },
        { id: 'm2', kind: 'prix_m2', propertyKind: 'maison', value: 3200, source: NOTAIRES },
      ],
      NOW,
    );
    if (!r.ok) throw new Error('page attendue');
    expect(r.page.answers.map((a) => a.factId)).toEqual(['neuf']);
    expect(r.excluded).toEqual(expect.arrayContaining([{ factId: 'vieux', reason: 'doublon' }, { factId: 'm1', reason: 'doublon' }, { factId: 'm2', reason: 'doublon' }]));
  });

  it('refuse une commune mal écrite et une page sans aucune réponse sourcée', () => {
    for (const c of ['', 'dijon', 'Dijon 21000', '<script>', 42]) expect(answerPage(c, FACTS, NOW)).toMatchObject({ ok: false, code: 'bad_commune' });
    expect(answerPage('Dijon', [], NOW)).toMatchObject({ ok: false, code: 'aucune_reponse' });
    const r = answerPage("Saint-Apollinaire", FACTS, NOW);
    expect(r.ok && r.page.path).toBe('/reponses/saint-apollinaire');
  });

  it('échappe tout texte de la page, et le JSON ne ferme jamais sa balise', () => {
    const r = answerPage('Dijon', [{ id: 'z', kind: 'biens_en_vente', value: 2, source: { ...RESEAU, name: 'Fichier </script><b>gras</b>' } }], NOW);
    if (!r.ok) throw new Error('page attendue');
    expect(r.page.html).not.toContain('<b>');
    expect(r.page.jsonLd).not.toContain('</script>');
    expect(r.page.html.match(/<\/script>/g)).toHaveLength(1);
  });

  it('les textes publics disent « réseau », jamais « mandataire », « gratuit » ni l\'IA', () => {
    const r = answerPage('Dijon', FACTS, NOW);
    if (!r.ok) throw new Error('page attendue');
    expect(r.page.html).not.toMatch(/mandataire|gratuit|\bIA\b|intelligence artificielle/i);
  });
});

describe('HX30 · fichier de présentation pour les robots d\'IA', () => {
  const site = { name: 'Réseau Exemple', baseUrl: 'https://reseau.exemple.fr/', summary: 'Le réseau d\'agents immobiliers de la Côte-d\'Or : prix, quartiers et biens en vente, chaque chiffre sourcé.' };
  const entries: LlmsEntry[] = [
    { kind: 'reponses', path: '/reponses/dijon', title: 'Immobilier à Dijon : les réponses' },
    { kind: 'prix', path: '/prix/dijon', title: 'Prix au mètre carré à Dijon' },
    { kind: 'quartier', path: '/quartiers/dijon/montchapet', title: 'Montchapet' },
    { kind: 'bien', path: '/biens/bien-1', title: 'Maison REF-1' },
    { kind: 'simulateur', path: '/simulateur', title: 'Simulateur de net vendeur' },
  ];

  it('liste les pages publiques de liste fermée, groupées, avec leur adresse complète [R431]', () => {
    const r = llmsTxt(site, entries);
    if (!r.ok) throw new Error('fichier attendu');
    expect(r.text).toBe(
      [
        '# Réseau Exemple',
        '',
        `> ${site.summary}`,
        '',
        'Chaque chiffre de ces pages cite sa source et sa date de relevé.',
        '',
        '## Réponses sourcées',
        '',
        '- [Immobilier à Dijon : les réponses](https://reseau.exemple.fr/reponses/dijon)',
        '',
        "## Prix de l'immobilier",
        '',
        '- [Prix au mètre carré à Dijon](https://reseau.exemple.fr/prix/dijon)',
        '',
        '## Quartiers',
        '',
        '- [Montchapet](https://reseau.exemple.fr/quartiers/dijon/montchapet)',
        '',
        '## Biens en vente',
        '',
        '- [Maison REF-1](https://reseau.exemple.fr/biens/bien-1)',
        '',
        '## Outils',
        '',
        '- [Simulateur de net vendeur](https://reseau.exemple.fr/simulateur)',
        '',
      ].join('\n'),
    );
    expect(r.excluded).toEqual([]);
  });

  it('n\'y met jamais une page privée, une adresse mail ni un numéro [R431]', () => {
    const r = llmsTxt(site, [
      { kind: 'bien', path: '/espace/dossiers/1', title: 'Dossier' },
      { kind: 'agents' as never, path: '/agents/ag-1', title: 'Camille Exemple' },
      { kind: 'bien', path: '/biens/bien-2', title: 'Appelez le 06 12 34 56 78' },
      { kind: 'bien', path: '/biens/bien-3', title: 'Écrire à camille@exemple.fr' },
      { kind: 'prix', path: '/prix/dijon?x=1', title: 'Prix' },
      { kind: 'prix', path: '/prix/dijon', title: '[lien](javascript:alert)' },
      { kind: 'prix', path: '/prix/dijon/centre', title: 'Dijon centre : 2950 € le mètre carré' },
      { kind: 'bien', path: '/biens/bien-4', title: 'Maison REF-4 à 199 000 €' },
      { kind: 'bien', path: '/biens/bien-1', title: 'Maison REF-1' },
    ]);
    if (!r.ok) throw new Error('fichier attendu');
    expect(r.text).not.toMatch(/espace|\/agents|06 12|@|javascript/);
    expect(r.text).toContain('/biens/bien-1');
    expect(Object.fromEntries(r.excluded.map((e) => [e.path, e.reason]))).toEqual({
      '/espace/dossiers/1': 'chemin',
      '/agents/ag-1': 'sorte',
      '/biens/bien-2': 'donnee_personnelle',
      '/biens/bien-3': 'donnee_personnelle',
      '/prix/dijon?x=1': 'chemin',
      '/prix/dijon': 'titre',
      '/prix/dijon/centre': 'chiffre',
      '/biens/bien-4': 'chiffre',
    });
    expect(looksPersonal('+33 6 12 34 56 78')).toBe(true);
    expect(looksPersonal('Maison REF-2027')).toBe(false);
  });

  it('refuse un site mal donné, une présentation chiffrée ou qui porte un contact [R429, R431]', () => {
    expect(llmsTxt({ ...site, baseUrl: 'http://reseau.exemple.fr/' }, entries)).toEqual({ ok: false, code: 'bad_site' });
    expect(llmsTxt({ ...site, baseUrl: 'https://reseau.exemple.fr/espace' }, entries)).toEqual({ ok: false, code: 'bad_site' });
    expect(llmsTxt({ ...site, name: '' }, entries)).toEqual({ ok: false, code: 'bad_name' });
    expect(llmsTxt({ ...site, name: 'Réseau Exemple, 300 ventes' }, entries)).toEqual({ ok: false, code: 'bad_name' });
    expect(llmsTxt({ ...site, summary: 'Le premier réseau avec 300 ventes par an.' }, entries)).toEqual({ ok: false, code: 'bad_summary' });
    expect(llmsTxt({ ...site, summary: 'Écrivez à contact@exemple.fr' }, entries)).toEqual({ ok: false, code: 'bad_summary' });
  });
});

describe('HX30 · le moteur d\'IA d\'où vient un contact', () => {
  it('lit le moteur sur la page d\'où vient la personne, en adresse exacte [R430]', () => {
    expect(aiEngineOf({ referrer: 'https://chatgpt.com/' })).toEqual({ engine: 'chatgpt', method: 'referent' });
    expect(aiEngineOf({ referrer: 'https://www.perplexity.ai/search/abc' })).toEqual({ engine: 'perplexity', method: 'referent' });
    expect(aiEngineOf({ referrer: 'https://gemini.google.com/app' })).toEqual({ engine: 'gemini', method: 'referent' });
    expect(aiEngineOf({ referrer: 'https://claude.ai/chat/x' })).toEqual({ engine: 'claude', method: 'referent' });
    // Une imitation, un moteur de recherche, une adresse non https : rien.
    for (const r of ['https://chatgpt.com.exemple.fr/', 'https://faux-chatgpt.com/', 'https://www.google.com/', 'http://chatgpt.com/', 'pas une adresse', 42]) expect(aiEngineOf({ referrer: r })).toBeNull();
  });

  it('lit le moteur sur le seul utm_source du lien ou de la page d\'arrivée [R430]', () => {
    expect(aiEngineOf({ link: 'https://reseau.exemple.fr/prix/dijon?utm_source=chatgpt.com' })).toEqual({ engine: 'chatgpt', method: 'utm' });
    expect(aiEngineOf({ landingPage: 'https://reseau.exemple.fr/biens/bien-1?utm_source=Perplexity' })).toEqual({ engine: 'perplexity', method: 'utm' });
    expect(aiEngineOf({ link: 'https://reseau.exemple.fr/?utm_source=newsletter' })).toBeNull();
    // Une propriété héritée n'est jamais un moteur de la liste.
    for (const v of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) expect(aiEngineOf({ link: `https://reseau.exemple.fr/?utm_source=${v}` })).toBeNull();
    for (const h of ['constructor', '__proto__']) expect(aiEngineOf({ referrer: `https://${h}/` })).toBeNull();
    // Deux utm_source, ou deux moteurs différents : un doute, rien n'est deviné.
    expect(aiEngineOf({ link: 'https://reseau.exemple.fr/?utm_source=chatgpt.com&utm_source=claude.ai' })).toBeNull();
    expect(aiEngineOf({ referrer: 'https://claude.ai/', link: 'https://reseau.exemple.fr/?utm_source=chatgpt.com' })).toBeNull();
    expect(aiEngineOf({ referrer: 'https://chatgpt.com/', link: 'https://reseau.exemple.fr/?utm_source=chatgpt.com' })).toEqual({ engine: 'chatgpt', method: 'referent' });
  });
});

async function setup() {
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  const journal = new SqlJournalStore(db);
  let clock = Date.parse('2027-03-09T08:00:00.000Z');
  const now = (): Date => new Date((clock += 1000));
  let n = 0;
  const newId = (): string => `id-${++n}`;
  await db.run("INSERT INTO networks (id, name, created_at) VALUES ('net-1', 'Réseau test', '2026-01-01T00:00:00.000Z')");
  await db.run("INSERT INTO networks (id, name, created_at) VALUES ('net-2', 'Autre réseau', '2026-01-01T00:00:00.000Z')");
  const moteurs = new MoteursIa(db, journal, { now, newId });
  let m = 0;
  const inbound = async (o: { conv?: string | null; at?: string; status?: string; network?: string; channel?: string } = {}) => {
    const id = `in-${++m}`;
    await db.run(
      `INSERT INTO inbound_messages (id, network_id, dedup_key, channel, kind, external_id, conversation_ref, sender_name, body, status, received_at, created_at)
       VALUES (?, ?, ?, ?, 'form', ?, ?, 'Personne Inventée', 'Bonjour', ?, ?, 'x')`,
      [id, o.network ?? 'net-1', `k-${id}`, o.channel ?? 'site', `ext-${id}`, o.conv ?? null, o.status ?? 'received', o.at ?? '2027-02-15T10:00:00.000Z'],
    );
    return id;
  };
  return { db, journal, moteurs, inbound, now, newId };
}

const direction = { role: 'direction' as const, userId: 'dir-1', networkId: 'net-1' };

describeWithSqlite('HX30 · contacts venus d\'un moteur d\'IA', () => {
  it('un contact venu d\'un moteur d\'IA est classé comme tel, une seule fois, sans rien d\'autre [R430, R156]', async () => {
    const { db, moteurs, inbound } = await setup();
    const a = await inbound();
    const signals = { referrer: 'https://chatgpt.com/c/question-de-la-personne', link: 'https://reseau.exemple.fr/prix/dijon?utm_source=chatgpt.com&gclid=xyz' };
    expect(await moteurs.record('net-1', a, signals)).toEqual({ ok: true, engine: 'chatgpt', already: false });
    expect(await moteurs.record('net-1', a, { referrer: 'https://claude.ai/' })).toEqual({ ok: true, engine: 'chatgpt', already: true });
    const rows = await db.all<Record<string, unknown>>('SELECT * FROM contact_ai_engines');
    expect(rows).toEqual([{ id: 'id-1', network_id: 'net-1', inbound_id: a, engine: 'chatgpt', method: 'referent', recorded_at: expect.any(String) }]);
    expect(JSON.stringify(rows)).not.toMatch(/question|gclid|reseau\.exemple/);
    const events = await db.all<{ type: string; data: string }>("SELECT type, data FROM journal WHERE type = 'recherche.moteur_ia'");
    expect(events).toHaveLength(1);
    expect(events[0]!.data).not.toMatch(/question|https/);
    // Sans moteur lu, rien n'est rangé ; un message d'un autre réseau n'est pas trouvé.
    const b = await inbound();
    expect(await moteurs.record('net-1', b, { referrer: 'https://www.google.com/' })).toEqual({ ok: true, engine: null, already: false });
    expect(await moteurs.stored(b)).toBeNull();
    expect(await moteurs.record('net-2', a, signals)).toEqual({ ok: false, code: 'unknown_inbound' });
    expect(await moteurs.record('net-1', b, { link: 'https://reseau.exemple.fr/?utm_source=constructor' })).toEqual({ ok: true, engine: null, already: false });
  });

  it('un moteur rangé ne change pas et ne s\'efface pas [R17]', async () => {
    const { db, moteurs, inbound } = await setup();
    const a = await inbound();
    await moteurs.record('net-1', a, { referrer: 'https://perplexity.ai/' });
    await expect(db.run("UPDATE contact_ai_engines SET engine = 'claude'")).rejects.toThrow(/ne change pas/);
    await expect(db.run('DELETE FROM contact_ai_engines')).rejects.toThrow(/rien ne s'efface/);
    await expect(db.run("INSERT INTO contact_ai_engines (id, network_id, inbound_id, engine, method, recorded_at) VALUES ('z', 'net-1', ?, 'google', 'utm', 'x')", [await inbound()])).rejects.toThrow();
  });

  it('la mesure du mois compte les contacts venus d\'une IA, par moteur, comme AT05, pour la direction seule [R430, R16]', async () => {
    const { moteurs, inbound, db, journal, now, newId } = await setup();
    // Une conversation de deux messages, venue de ChatGPT au second : comptée une fois, venue de ChatGPT.
    const c1a = await inbound({ conv: 'conv-1', at: '2027-02-03T10:00:00.000Z' });
    const c1b = await inbound({ conv: 'conv-1', at: '2027-02-03T11:00:00.000Z' });
    await moteurs.record('net-1', c1b, { link: 'https://reseau.exemple.fr/?utm_source=chatgpt.com' });
    const c2 = await inbound({ at: '2027-02-10T10:00:00.000Z' });
    await moteurs.record('net-1', c2, { referrer: 'https://www.perplexity.ai/' });
    const c3 = await inbound({ at: '2027-02-12T10:00:00.000Z' });
    await moteurs.record('net-1', c3, { referrer: 'https://chatgpt.com/' });
    await inbound({ at: '2027-02-20T10:00:00.000Z' });
    // Hors du mois, illisible, ou d'un autre réseau : pas compté.
    await moteurs.record('net-1', await inbound({ at: '2027-01-31T22:30:00.000Z' }), { referrer: 'https://claude.ai/' });
    await moteurs.record('net-1', await inbound({ at: '2027-02-14T10:00:00.000Z', status: 'unreadable' }), { referrer: 'https://claude.ai/' });
    await moteurs.record('net-2', await inbound({ at: '2027-02-14T10:00:00.000Z', network: 'net-2' }), { referrer: 'https://claude.ai/' });
    const r = await moteurs.measure(direction, '2027-02');
    expect(r).toEqual({
      ok: true,
      measure: {
        month: '2027-02',
        contacts: 4,
        fromAi: 3,
        percent: 75,
        byEngine: [
          { engine: 'chatgpt', label: 'ChatGPT', contacts: 2 },
          { engine: 'perplexity', label: 'Perplexity', contacts: 1 },
        ],
      },
    });
    // Le même compte de contacts que la mesure de l'origine de AT05.
    const at05 = await new OrigineContacts(db, journal, { now, newId }).measure(direction, '2027-02');
    expect(at05.ok && at05.measure.contacts).toBe(4);
    expect(c1a).toBeTruthy();
    expect(await moteurs.measure({ role: 'agent', userId: 'ag-1', networkId: 'net-1' } as never, '2027-02')).toEqual({ ok: false, rule: 'R16', code: 'role' });
    expect(await moteurs.measure(direction, '2027-13')).toEqual({ ok: false, rule: null, code: 'bad_month' });
  });
});
