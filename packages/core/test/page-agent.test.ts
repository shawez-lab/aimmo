import { expect, it } from 'vitest';
import { SqlJournalStore, applyMigrations, fromSyncSqlite, type SqlDatabase } from '../src/index.ts';
import { PageAgent, mentionsLine, normalizeRsac, renderAgentPage, type AgentPageInput } from '../src/attirer/index.ts';
import { BUDGETS, budgetProblems, htmlProblems, screenCssProblems } from '../src/design/audit.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

const direction = { role: 'direction' as const, userId: 'dir-1', networkId: 'net-1' };

async function setup() {
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  const journal = new SqlJournalStore(db);
  let clock = Date.parse('2026-10-29T08:00:00.000Z');
  const now = (): Date => new Date((clock += 1000));
  await db.run("INSERT INTO networks (id, name, created_at) VALUES ('net-1', 'Réseau test', '2026-01-01T00:00:00.000Z')");
  await db.run("INSERT INTO networks (id, name, created_at) VALUES ('net-2', 'Autre réseau', '2026-01-01T00:00:00.000Z')");
  // Personnes et biens inventés.
  await db.run("INSERT INTO agents (id, network_id, first_name, last_name, zone, created_at, updated_at) VALUES ('ag-1', 'net-1', 'Camille', 'Exemple', 'Dijon centre', 'x', 'x')");
  await db.run("INSERT INTO agents (id, network_id, first_name, last_name, status, created_at, updated_at) VALUES ('ag-2', 'net-1', 'Paul', 'Parti', 'left', 'x', 'x')");
  await db.run("INSERT INTO agent_public_cards (id, agent_id, network_id, phone, email, set_by, set_at) VALUES ('c1', 'ag-1', 'net-1', '06 00 00 00 00', 'camille@exemple.test', 'direction:dir-1', 'x')");
  const pages = new PageAgent(db, journal, { now });
  return { db, journal, pages };
}

async function complete(db: SqlDatabase, pages: PageAgent) {
  expect(await pages.setLegalMentions(direction, 'ag-1', { rsacNumber: 'RSAC 123456789', rsacRegistry: 'Dijon' })).toEqual({ ok: true });
  await db.run("INSERT INTO listing_settings (id, network_id, card_number, set_by, set_at) VALUES ('s1', 'net-1', 'CPI 9999 0000 000 000 001', 'direction:dir-1', 'x')");
  expect(await pages.setCardHolder(direction, 'Société Exemple')).toEqual({ ok: true });
}

async function listing(db: SqlDatabase, id: string, agent: string, seq: number, state: string, title: string, price: number) {
  await db.exec('PRAGMA foreign_keys = OFF');
  await db.run(
    "INSERT OR IGNORE INTO properties (id, network_id, agent_id, reference, kind, city, created_at, updated_at) VALUES (?, 'net-1', ?, ?, 'home', 'Ville inventée', 'x', 'x')",
    [id, agent, `REF-${id}`],
  );
  await db.run(
    "INSERT INTO listing_versions (id, property_id, network_id, seq, state, draft_id, price_eur, payload, payload_hash, reason, created_at) VALUES (?, ?, 'net-1', ?, ?, ?, ?, ?, 'h', 'test', 'x')",
    [`${id}-${seq}`, id, seq, state, state === 'retiree' ? null : `d-${id}-${seq}`, state === 'retiree' ? null : price, JSON.stringify({ reference: `REF-${id}`, state, title, body: 'Texte', mentions: `Classe énergie D, classe climat C. Honoraires à la charge du vendeur (${id}).`, priceEur: price, media: [] })],
  );
  await db.exec('PRAGMA foreign_keys = ON');
}

let answerSeq = 0;
async function answers(db: SqlDatabase, scores: number[], agent = 'ag-1') {
  let i = answerSeq;
  answerSeq += scores.length;
  for (const score of scores) {
    i++;
    await db.run(
      "INSERT INTO satisfaction_answers (file_id, person_id, network_id, agent_id, score, comment, answered_at) VALUES (?, ?, 'net-1', ?, ?, ?, 'x')",
      [`f-${agent}-${i}`, `p-${i}`, agent, score, score <= 2 ? 'Déçu par le suivi, commentaire inventé' : null],
    );
  }
}

it('[R152] la phrase des mentions dit le statut, le numéro et la carte du titulaire, sans « mandataire » [R07]', () => {
  const line = mentionsLine({ rsacNumber: '123 456 789', rsacRegistry: 'Dijon', cardNumber: 'CPI 1', cardHolder: 'Société Exemple' });
  expect(line).toContain('Agent commercial');
  expect(line).toContain('RSAC) de Dijon sous le n° 123 456 789');
  expect(line).toContain('Habilité par Société Exemple, titulaire de la carte professionnelle n° CPI 1');
  expect(line).not.toMatch(/mandataire|gratuit/i);
  expect(normalizeRsac('RSAC 123.456.789')).toBe('123 456 789');
  expect(normalizeRsac('12345678')).toBeNull();
});

describeWithSqlite('AT03 · page de chaque agent', () => {
  it('[R152] sans statut, numéro et carte du titulaire, la page n\'est pas publiée et la raison est dite', async () => {
    const { db, pages } = await setup();
    expect(await pages.page('net-1', 'ag-1')).toEqual({ ok: false, rule: 'R152', reason: 'statut_manquant' });
    await pages.setLegalMentions(direction, 'ag-1', { rsacNumber: '123 456 789', rsacRegistry: 'Dijon' });
    expect(await pages.page('net-1', 'ag-1')).toEqual({ ok: false, rule: 'R152', reason: 'carte_manquante' });
    await db.run("INSERT INTO listing_settings (id, network_id, card_number, set_by, set_at) VALUES ('s1', 'net-1', 'CPI 0001', 'direction:dir-1', 'x')");
    expect(await pages.page('net-1', 'ag-1')).toEqual({ ok: false, rule: 'R152', reason: 'titulaire_manquant' });
    await pages.setCardHolder(direction, 'Société Exemple');
    const page = await pages.page('net-1', 'ag-1');
    expect(page.ok).toBe(true);
    const html = (page as { html: string }).html;
    // Les mentions sont à côté du nom, dans le même bloc.
    expect(html).toMatch(/<h1 id="nom">Camille Exemple<\/h1><p class="statut">Agent commercial, immatriculé au registre spécial des agents commerciaux \(RSAC\) de Dijon sous le n° 123 456 789\. Habilité par Société Exemple, titulaire de la carte professionnelle n° CPI 0001\.<\/p>/);
    // Un agent parti, inconnu ou d'un autre réseau n'a pas de page.
    expect(await pages.page('net-1', 'ag-2')).toEqual({ ok: false, rule: 'R16', reason: 'agent_parti' });
    expect(await pages.page('net-2', 'ag-1')).toEqual({ ok: false, rule: 'R16', reason: 'agent_inconnu' });
  });

  it('[R16] seule la direction règle les mentions ; un numéro ou un greffe mal formés sont refusés', async () => {
    const { pages } = await setup();
    const agent = { role: 'agent' as const, userId: 'ag-1', networkId: 'net-1' };
    expect(await pages.setLegalMentions(agent, 'ag-1', { rsacNumber: '123 456 789', rsacRegistry: 'Dijon' })).toEqual({ ok: false, rule: 'R16', code: 'role' });
    expect(await pages.setCardHolder(agent, 'X')).toEqual({ ok: false, rule: 'R16', code: 'role' });
    expect(await pages.setLegalMentions(direction, 'ag-1', { rsacNumber: '12', rsacRegistry: 'Dijon' })).toEqual({ ok: false, rule: 'R152', code: 'rsac' });
    expect(await pages.setLegalMentions(direction, 'ag-1', { rsacNumber: '123456789', rsacRegistry: '<b>' })).toEqual({ ok: false, rule: 'R152', code: 'greffe' });
    expect(await pages.setLegalMentions(direction, 'ag-2', { rsacNumber: '123456789', rsacRegistry: 'Dijon' })).toEqual({ ok: false, rule: 'R16', code: 'agent_parti' });
    expect(await pages.setLegalMentions(direction, 'ag-9', { rsacNumber: '123456789', rsacRegistry: 'Dijon' })).toEqual({ ok: false, rule: 'R16', code: 'agent_inconnu' });
  });

  it('[R16] [R46] seuls les biens de l\'agent en vente ou sous offre, depuis leur dernière version publiée, sans donnée de client', async () => {
    const { db, pages } = await setup();
    await complete(db, pages);
    await listing(db, 'b1', 'ag-1', 1, 'en_vente', 'Appartement trois pièces', 210000);
    await listing(db, 'b2', 'ag-1', 1, 'en_vente', 'Maison ancienne', 300000);
    await listing(db, 'b2', 'ag-1', 2, 'vendu', 'Maison ancienne', 300000);
    await listing(db, 'b3', 'ag-1', 1, 'sous_offre', 'Studio', 90000);
    await listing(db, 'b4', 'ag-2', 1, 'en_vente', 'Bien d\'un autre agent', 150000);
    // Mandat rétracté ou mentions manquantes : la dernière version est un retrait.
    await listing(db, 'b5', 'ag-1', 1, 'en_vente', 'Duplex retiré', 250000);
    await listing(db, 'b5', 'ag-1', 2, 'retiree', 'Duplex retiré', 250000);
    const page = (await pages.page('net-1', 'ag-1')) as { ok: true; html: string; input: AgentPageInput };
    expect(page.input.listings.map((l) => [l.propertyId, l.state])).toEqual([['b1', 'en_vente'], ['b3', 'sous_offre']]);
    expect(page.html).toContain('href="/biens/b1"');
    expect(page.html).toMatch(/210\s000/u);
    // Chaque bien montré porte ses mentions obligatoires, comme toute annonce [R43].
    expect(page.html).toContain('<p class="mentions">Classe énergie D, classe climat C. Honoraires à la charge du vendeur (b1).</p>');
    expect(page.html).toContain('Honoraires à la charge du vendeur (b3).');
    expect(page.html).not.toMatch(/Maison ancienne|autre agent|Duplex|REF-|Ville inventée/);
  });

  it('[R64] le lien vers les avis publiés par les clients eux-mêmes ; aucune réponse de satisfaction publiée, ni une à une ni en moyenne', async () => {
    const { db, pages } = await setup();
    await complete(db, pages);
    await answers(db, [5, 5, 1, 2, 4, 3]);
    let page = (await pages.page('net-1', 'ag-1')) as { ok: true; html: string; input: AgentPageInput };
    expect(page.input.reviewsUrl).toBeNull();
    expect(page.html).toContain('Les avis de ses clients seront bientôt en ligne.');
    await db.run("INSERT INTO agent_review_links (id, network_id, agent_id, url, set_by, set_at) VALUES ('r1', 'net-1', 'ag-1', 'https://avis.exemple.test/camille', 'direction:dir-1', 'x')");
    page = (await pages.page('net-1', 'ag-1')) as { ok: true; html: string; input: AgentPageInput };
    expect(page.html).toContain('<a href="https://avis.exemple.test/camille" rel="noopener noreferrer">Lire les avis de ses clients</a>');
    // Ni note, ni moyenne, ni nombre de réponses, ni commentaire : rien qui se lise par différence.
    expect(page.html).not.toMatch(/\/ 5|Déçu|réponses|moyenne/i);
  });

  it('[R201] [R07] la page passe le contrôle du système de design et tient dans 14 Ko compressés', async () => {
    const { db, pages } = await setup();
    await complete(db, pages);
    for (let i = 0; i < 30; i++) await listing(db, `p${i}`, 'ag-1', 1, 'en_vente', `Bien inventé numéro ${i}`, 100000 + i * 1000);
    await answers(db, [5, 4, 4, 5, 3]);
    const page = (await pages.page('net-1', 'ag-1')) as { ok: true; html: string };
    expect(htmlProblems(page.html)).toEqual([]);
    expect(budgetProblems({ html: page.html }, BUDGETS.page)).toEqual([]);
    const css = [...page.html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1]!).join('');
    expect(screenCssProblems(css)).toEqual([]);
    expect(page.html).toContain('Agent immobilier');
    expect(page.html).not.toMatch(/mandataire|gratuit/i);
  });

  it('[R43] une version publiée illisible n\'est pas montrée et c\'est écrit au journal', async () => {
    const { db, pages } = await setup();
    await complete(db, pages);
    await listing(db, 'b1', 'ag-1', 1, 'en_vente', 'Appartement', 210000);
    await db.exec('PRAGMA foreign_keys = OFF');
    await db.run("INSERT INTO properties (id, network_id, agent_id, reference, kind, created_at, updated_at) VALUES ('b9', 'net-1', 'ag-1', 'REF-b9', 'home', 'x', 'x')");
    await db.run("INSERT INTO listing_versions (id, property_id, network_id, seq, state, draft_id, price_eur, payload, payload_hash, reason, created_at) VALUES ('b9-1', 'b9', 'net-1', 1, 'en_vente', 'd', 1000, 'null', 'h', 'test', 'x')");
    const page = (await pages.page('net-1', 'ag-1')) as { ok: true; input: AgentPageInput };
    expect(page.input.listings.map((l) => l.propertyId)).toEqual(['b1']);
    expect((await db.first<{ n: number }>("SELECT count(*) AS n FROM journal WHERE type = 'attirer.page_agent.annonce_illisible' AND subject = 'property:b9'"))!.n).toBe(1);
  });

  it('tout texte est échappé', () => {
    const html = renderAgentPage({
      agentId: 'a',
      firstName: '<script>',
      lastName: 'X',
      zone: '<b>',
      phone: null,
      email: null,
      mentions: { rsacNumber: '1', rsacRegistry: 'D', cardNumber: 'C', cardHolder: 'H' },
      listings: [{ propertyId: 'x"y', title: '<i>', priceEur: 1, state: 'en_vente', mentions: '<u>' }],
      reviewsUrl: 'https://x.test/"><b>',
    });
    expect(html).not.toMatch(/<script>|<b>|<i>|<u>/);
    expect(html).not.toContain('x.test');
    expect(html).toContain('href="/biens/x%22y"');
  });
});
