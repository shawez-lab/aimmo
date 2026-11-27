import { describe, expect, it } from 'vitest';
import { SqlJournalStore, applyMigrations, fromSyncSqlite, type SqlDatabase } from '../src/index.ts';
import { PageBien, agentBlock } from '../src/annonces/index.ts';
import {
  DEFAULT_PROFESSIONAL_TITLE,
  PROFESSIONAL_TITLES,
  PageAgent,
  QualiteAgent,
  professionalTitle,
  renderAgentPage,
  renderSiteHome,
  titleFor,
  type AgentPageInput,
} from '../src/attirer/index.ts';
import { renderSupport } from '../src/boutique/supports.ts';
import type { Acces } from '../src/acces/acces.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

// Réseau, agent et bien inventés.
const direction = { role: 'direction' as const, userId: 'dir-1', networkId: 'net-1' };
const agentViewer = { role: 'agent' as const, userId: 'ag-1', networkId: 'net-1' };
const OPEN = { canDiffuse: async () => ({ allowed: true }) };
const CARD = { firstName: 'Camille', lastName: 'Exemple', phone: '06 00 00 00 00', email: 'camille@exemple.test' };
const PAGE_INPUT: AgentPageInput = {
  agentId: 'ag-1',
  firstName: 'Camille',
  lastName: 'Exemple',
  zone: 'Dijon centre',
  phone: null,
  email: null,
  mentions: { rsacNumber: '123 456 789', rsacRegistry: 'Dijon', cardNumber: 'CPI 0001', cardHolder: 'Société Exemple' },
  listings: [],
  reviewsUrl: null,
};
const PAYLOAD = { reference: 'REF1', version: 1, state: 'en_vente' as const, title: 'Maison inventée', body: 'Texte', mentions: 'Classe énergie D.', priceEur: 200000, media: [] };

async function setup() {
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  const journal = new SqlJournalStore(db);
  let clock = Date.parse('2026-11-18T08:00:00.000Z');
  const now = (): Date => new Date((clock += 1000));
  await db.run("INSERT INTO networks (id, name, created_at) VALUES ('net-1', 'Réseau test', '2026-01-01T00:00:00.000Z')");
  await db.run("INSERT INTO networks (id, name, created_at) VALUES ('net-2', 'Autre réseau', '2026-01-01T00:00:00.000Z')");
  await db.run("INSERT INTO agents (id, network_id, first_name, last_name, zone, created_at, updated_at) VALUES ('ag-1', 'net-1', 'Camille', 'Exemple', 'Dijon centre', 'x', 'x')");
  await db.run("INSERT INTO agent_public_cards (id, agent_id, network_id, phone, email, set_by, set_at) VALUES ('c1', 'ag-1', 'net-1', '06 00 00 00 00', 'camille@exemple.test', 'direction:dir-1', 'x')");
  await db.exec('PRAGMA foreign_keys = OFF');
  await db.run("INSERT INTO properties (id, network_id, agent_id, reference, kind, city, created_at, updated_at) VALUES ('b1', 'net-1', 'ag-1', 'REF1', 'home', 'Ville inventée', 'x', 'x')");
  await db.run(
    "INSERT INTO listing_versions (id, property_id, network_id, seq, state, draft_id, price_eur, payload, payload_hash, reason, created_at) VALUES ('b1-1', 'b1', 'net-1', 1, 'en_vente', 'd1', 200000, ?, 'h', 'test', 'x')",
    [JSON.stringify(PAYLOAD)],
  );
  await db.exec('PRAGMA foreign_keys = ON');
  const pages = new PageAgent(db, journal, { now });
  await pages.setLegalMentions(direction, 'ag-1', { rsacNumber: 'RSAC 123456789', rsacRegistry: 'Dijon' });
  await db.run("INSERT INTO listing_settings (id, network_id, card_number, set_by, set_at) VALUES ('s1', 'net-1', 'CPI 0001', 'direction:dir-1', 'x')");
  await pages.setCardHolder(direction, 'Société Exemple');
  const qualite = new QualiteAgent(db, journal, { now });
  const bien = new PageBien(db, {} as Acces, journal, { now });
  return { db, journal, pages, qualite, bien };
}

describe('AU012 · titre de l’agent selon son statut', () => {
  it('[R07] aucun titre possible ne dit « mandataire » ni ne fait de l’agent le titulaire d’une carte', () => {
    for (const t of PROFESSIONAL_TITLES) {
      expect(t).not.toMatch(/mandataire|titulaire|carte|gratuit/i);
    }
    expect(DEFAULT_PROFESSIONAL_TITLE).toBe('agent immobilier');
  });

  it('[R07] sans réglage, le texte affiché reste « agent immobilier », quel que soit le statut (en attendant H24)', () => {
    expect(titleFor('agent_commercial', null)).toBe('agent immobilier');
    expect(titleFor('inconnu', undefined)).toBe('agent immobilier');
    // Un réglage abîmé ne fait jamais sortir un titre de la liste.
    expect(titleFor('inconnu', 'mandataire immobilier')).toBe('agent immobilier');
    expect(titleFor('agent_commercial', 'agent commercial en immobilier')).toBe('agent commercial en immobilier');
    expect(agentBlock(CARD)).toContain('<strong>Camille Exemple</strong>, agent immobilier</p>');
    const page = renderAgentPage(PAGE_INPUT);
    expect(page).toContain('<title>Camille Exemple, agent immobilier</title>');
    expect(page).toContain('<p class="metier">Agent immobilier · Dijon centre</p>');
  });

  it('[R07] le titre réglé remplace « agent immobilier » partout où le nom de l’agent est montré', () => {
    const title = 'agent commercial en immobilier' as const;
    expect(agentBlock({ ...CARD, title })).toContain('<strong>Camille Exemple</strong>, agent commercial en immobilier</p>');
    const page = renderAgentPage({ ...PAGE_INPUT, title });
    expect(page).toContain('<title>Camille Exemple, agent commercial en immobilier</title>');
    expect(page).toContain('<p class="metier">Agent commercial en immobilier · Dijon centre</p>');
    expect(page).not.toMatch(/agent immobilier/i);
    const card = renderSupport({ support: 'carte', agent: CARD, url: 'https://exemple.test' });
    expect('html' in card && card.html).toContain('<p class="titre">Agent immobilier</p>');
    const titled = renderSupport({ support: 'carte', agent: { ...CARD, title }, url: 'https://exemple.test' });
    expect('html' in titled && titled.html).toContain('<p class="titre">Agent commercial en immobilier</p>');
    expect('html' in titled && titled.html).not.toMatch(/agent immobilier/i);
    // L'accueil du site de l'agent aussi, et sans réglage rien ne change.
    const home = { kind: 'agent' as const, recruiting: false, listings: [], checkedAt: new Date('2026-11-18T08:00:00.000Z') };
    const agentHome = { agentId: 'ag-1', name: 'Camille Exemple', mentions: PAGE_INPUT.mentions };
    expect(renderSiteHome({ ...home, agent: agentHome })).toContain('Camille Exemple, agent immobilier');
    const titledHome = renderSiteHome({ ...home, agent: { ...agentHome, title } });
    expect(titledHome).toContain('Camille Exemple, agent commercial en immobilier');
    expect(titledHome).not.toContain('Camille Exemple, agent immobilier');
    for (const support of ['panneau', 'flyer', 'vitrine'] as const) {
      const r = renderSupport({ support, payload: PAYLOAD, agent: { ...CARD, title }, url: 'https://exemple.test/biens/b1' });
      expect('html' in r).toBe(true);
      if ('html' in r) {
        expect(r.html).toContain('agent commercial en immobilier');
        expect(r.html).not.toMatch(/agent immobilier/i);
      }
    }
  });
});

describeWithSqlite('AU012 · réglage du titre par la direction', () => {
  it('[R07] la page du bien et la page de l’agent lisent le titre réglé par la direction ; sans réglage, rien ne change', async () => {
    const { qualite, pages, bien, db } = await setup();
    expect((await bien.inputFor('net-1', 'b1'))?.agent?.title).toBe('agent immobilier');
    expect(await bien.page('net-1', 'b1')).toContain('<p class="nom">Camille Exemple</p><p class="doux">agent immobilier</p>');
    expect(await qualite.setTitle(direction, 'agent commercial en immobilier')).toEqual({ ok: true, value: 'agent commercial en immobilier' });
    const listing = await bien.page('net-1', 'b1');
    expect(listing).toContain('<p class="nom">Camille Exemple</p><p class="doux">agent commercial en immobilier</p>');
    expect(listing).not.toMatch(/agent immobilier/i);
    const page = await pages.page('net-1', 'ag-1', OPEN);
    expect(page.ok).toBe(true);
    if (page.ok) {
      expect(page.html).toContain('<p class="metier">Agent commercial en immobilier · Dijon centre</p>');
      // La carte reste celle du titulaire, jamais celle de l'agent [R152].
      expect(page.html).toContain('Habilité par Société Exemple, titulaire de la carte professionnelle n° CPI 0001.');
    }
    // Le dernier réglage fait foi ; un autre réseau garde le titre par défaut.
    await qualite.setTitle(direction, 'conseiller immobilier');
    expect(await professionalTitle(db, 'net-1', 'ag-1')).toBe('conseiller immobilier');
    expect(await professionalTitle(db, 'net-2', 'ag-1')).toBe('agent immobilier');
    expect(await qualite.title(direction)).toEqual({ ok: true, value: { setting: 'conseiller immobilier', shown: 'conseiller immobilier', choices: PROFESSIONAL_TITLES } });
  });

  it('[R07] un titre hors de la liste est refusé, et la base le refuse aussi', async () => {
    const { qualite, db } = await setup();
    for (const t of ['mandataire immobilier', 'agent immobilier titulaire de la carte', 'Agent immobilier', '', 12, null]) {
      expect(await qualite.setTitle(direction, t)).toEqual({ ok: false, rule: 'R07', code: 'titre_hors_liste' });
    }
    await expect(
      db.run("INSERT INTO agent_title_settings (id, network_id, title, set_by, set_at) VALUES ('t1', 'net-1', 'mandataire', 'direction:dir-1', 'x')"),
    ).rejects.toThrow();
    expect(await professionalTitle(db, 'net-1', 'ag-1')).toBe('agent immobilier');
  });

  it('[R16] la direction seule règle et lit le titre, le refus est écrit au journal ; rien ne s’efface ni ne se réécrit', async () => {
    const { qualite, db } = await setup();
    expect(await qualite.setTitle(agentViewer, 'conseiller immobilier')).toEqual({ ok: false, rule: 'R16', code: 'role' });
    expect(await qualite.title(agentViewer)).toEqual({ ok: false, rule: 'R16', code: 'role' });
    expect((await db.first<{ n: number }>("SELECT count(*) AS n FROM journal WHERE type = 'acces.refuse' AND data LIKE '%agent_title%'"))!.n).toBe(2);
    expect(await professionalTitle(db, 'net-1', 'ag-1')).toBe('agent immobilier');
    await qualite.setTitle(direction, 'conseiller immobilier');
    await expect(db.run("UPDATE agent_title_settings SET title = 'agent immobilier'")).rejects.toThrow(/rien ne se réécrit/);
    await expect(db.run('DELETE FROM agent_title_settings')).rejects.toThrow(/rien ne s'efface/);
  });
});
