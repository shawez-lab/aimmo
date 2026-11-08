import { expect, it } from 'vitest';
import { Acces, FicheClient, FicheUnique, SqlJournalStore, applyMigrations, fromSyncSqlite, type JournalStore, type SqlDatabase, type Viewer } from '../src/index.ts';
import type { PublishedListing } from '../src/attirer/referencement.ts';
import { Brouillons, MCP_TOOLS, ServeurMcp, type McpCaller } from '../src/mcp/index.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

// Jeu de test inventé : agents, clients, biens, annonces.

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;

it('[R591] le catalogue est fermé : aucun outil ne valide, n’envoie ni n’efface', () => {
  expect(MCP_TOOLS.map((t) => t.name)).toEqual(['biens_diffusables', 'mes_biens', 'lire_bien', 'mes_brouillons', 'brouillon_note', 'brouillon_prix']);
  for (const t of MCP_TOOLS) {
    expect(t.name).not.toMatch(/valid|envo|suppr|effac|decid|publi/);
    expect(t.inputSchema.additionalProperties).toBe(false);
  }
});

describeWithSqlite('HX55 · serveur MCP et API ouverte', () => {
  async function setup(options: { failingJournal?: boolean } = {}) {
    const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
    await applyMigrations(db, loadMigrations());
    const clock = new Date('2027-03-10T10:00:00.000Z');
    const now = () => clock;
    const sql = new SqlJournalStore(db);
    let broken = false;
    const journal: JournalStore = {
      append: async (e) => {
        if (broken) throw new Error('journal en panne');
        return sql.append(e);
      },
      last: () => sql.last(),
      all: () => sql.all(),
      bySubject: (s) => sql.bySubject(s),
      byPeriod: (a, b) => sql.byPeriod(a, b),
    };
    const store = new FicheClient(db, { now });
    const acces = new Acces(db, store, new FicheUnique(db, store, { now }), journal, { now });
    const network = await store.createNetwork('Réseau test');
    const otherNetwork = await store.createNetwork('Autre réseau');
    const alex = await store.createAgent({ networkId: network.id, firstName: 'Alex', lastName: 'Agent' });
    const sam = await store.createAgent({ networkId: network.id, firstName: 'Sam', lastName: 'Agent' });
    const gone = await store.createAgent({ networkId: network.id, firstName: 'Parti', lastName: 'Agent' });
    await db.run("UPDATE agents SET status = 'left' WHERE id = ?", [gone.id]);
    const clientAlex = await store.createPerson({ networkId: network.id, agentId: alex.id, firstName: 'Camille' });
    const clientSam = await store.createPerson({ networkId: network.id, agentId: sam.id, firstName: 'Dominique' });
    const prop = async (id: string, agentId: string, status: string, net = network.id) =>
      db.run(
        "INSERT INTO properties (id, network_id, agent_id, reference, kind, postal_code, city, surface_m2, rooms, price_eur, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'home', '21000', 'Dijon', 80, 4, 250000, ?, ?, ?)",
        [id, net, agentId, `REF-${id}`, status, '2027-01-01T08:00:00.000Z', '2027-01-01T08:00:00.000Z'],
      );
    await prop('bien-alex', alex.id, 'available');
    await prop('bien-alex-brouillon', alex.id, 'draft');
    await prop('bien-sam-vente', sam.id, 'available');
    await prop('bien-sam-vendu', sam.id, 'sold');
    const brouillons = new Brouillons(db, acces, journal, { now });
    // Les annonces publiées : la porte de diffusion refuse `bien-sans-mandat` à cet instant.
    const listing = (propertyId: string, over: Partial<PublishedListing> = {}): PublishedListing => ({
      propertyId,
      agentId: alex.id,
      city: 'Dijon',
      state: 'en_vente',
      versionId: `v-${propertyId}`,
      title: `Maison 4 pièces ${propertyId}`,
      priceEur: 250000,
      day: '2027-03-01',
      mentions: 'Honoraires à la charge du vendeur. DPE C.',
      photo: { ref: 'biens/photo.jpg', overlay: null },
      propertyStatus: 'available',
      ...over,
    });
    const published: PublishedListing[] = [
      listing('bien-alex'),
      listing('bien-sam-vente', { agentId: sam.id, day: '2027-03-05', city: 'Chenôve' }),
      listing('bien-sans-mandat'),
      listing('bien-vendu-socle', { propertyStatus: 'sold' }),
      listing('bien-retire', { state: 'vendu' as 'en_vente' }),
    ];
    const gateCalls: string[] = [];
    const serveur = new ServeurMcp({
      db,
      acces,
      brouillons,
      journal,
      published: { published: async (networkId) => (networkId === network.id ? published : []) },
      gate: {
        canDiffuse: async (_n, propertyId) => {
          gateCalls.push(propertyId);
          return { allowed: propertyId !== 'bien-sans-mandat' };
        },
      },
      now,
    });
    const as = (role: string, userId: string, networkId = network.id): McpCaller => ({ kind: 'agent', viewer: { role, userId, networkId } as Viewer });
    let n = 0;
    const call = async (caller: McpCaller, name: string, args: Record<string, unknown> = {}) => {
      n += 1;
      const res = await serveur.handle(caller, { jsonrpc: '2.0', id: n, method: 'tools/call', params: { name, arguments: args } });
      return res!.result as { isError: boolean; structuredContent: Record<string, unknown>; content: { type: string; text: string }[] };
    };
    const lines = async (type: string) => (await sql.all()).filter((e) => e.type === type);
    const drafts = async () => db.all<Record<string, unknown>>('SELECT * FROM mcp_drafts ORDER BY created_at, kind');
    return {
      db, sql, journal, network, otherNetwork, alex, sam, gone, clientAlex, clientSam, serveur, brouillons, call, lines, drafts, gateCalls,
      agent: as('agent', alex.id),
      other: as('agent', sam.id),
      viewer: { role: 'agent', userId: alex.id, networkId: network.id } as Viewer,
      as,
      breakJournal: () => {
        broken = true;
      },
    };
  }

  it('[R590] initialize et tools/list : l’agent a ses outils, le public le seul outil public', async () => {
    const t = await setup();
    const init = await t.serveur.handle(t.agent, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    expect(init!.result).toMatchObject({ protocolVersion: '2025-06-18', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'aimmo' } });
    const agentTools = await t.serveur.handle(t.agent, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
    expect((agentTools!.result as { tools: { name: string }[] }).tools.map((x) => x.name)).toEqual(MCP_TOOLS.map((x) => x.name));
    const pub: McpCaller = { kind: 'public', networkId: t.network.id };
    const publicTools = await t.serveur.handle(pub, { jsonrpc: '2.0', id: 3, method: 'tools/list' });
    expect((publicTools!.result as { tools: { name: string }[] }).tools.map((x) => x.name)).toEqual(['biens_diffusables']);
    // Le public n'appelle aucun outil d'agent, et rien n'est lu.
    const res = await t.serveur.handle(pub, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'mes_biens', arguments: {} } });
    expect(res!.error).toMatchObject({ code: -32602 });
    expect(await t.lines('bien.lu')).toEqual([]);
    // Notification sans identifiant : aucune réponse. Méthode inconnue : erreur.
    expect(await t.serveur.handle(t.agent, { jsonrpc: '2.0', method: 'notifications/initialized' })).toBeNull();
    expect((await t.serveur.handle(t.agent, { jsonrpc: '2.0', id: 5, method: 'resources/list' }))!.error).toMatchObject({ code: -32601 });
    expect((await t.serveur.handle(t.agent, { id: 6, method: 'ping' }))!.error).toMatchObject({ code: -32600 });
    expect((await t.serveur.handle(t.agent, [1]))!.error).toMatchObject({ code: -32600 });
  });

  it('[R590] [R16] aucun appel hors des droits de l’agent', async () => {
    const t = await setup();
    // Ses biens : les siens seulement, brouillon compris, chacun lu sous ses droits et écrit au journal.
    const mine = await t.call(t.agent, 'mes_biens');
    expect(mine.isError).toBe(false);
    expect((mine.structuredContent.biens as { bien: string }[]).map((b) => b.bien)).toEqual(['bien-alex', 'bien-alex-brouillon']);
    expect((await t.lines('bien.lu')).map((l) => l.subject)).toEqual(['property:bien-alex', 'property:bien-alex-brouillon']);
    // Un bien en vente d'un autre agent : fichier commun. Un bien vendu d'un autre agent : refusé.
    const shared = await t.call(t.agent, 'lire_bien', { bien: 'bien-sam-vente' });
    expect((shared.structuredContent.bien as { vue: string }).vue).toBe('fichier_commun');
    const sold = await t.call(t.agent, 'lire_bien', { bien: 'bien-sam-vendu' });
    expect(sold.isError).toBe(true);
    expect(sold.structuredContent).toEqual({ refus: { regle: 'R16', code: 'not_assigned' } });
    // La fiche d'un client d'un autre agent : aucun brouillon.
    const note = await t.call(t.agent, 'brouillon_note', { fiche: t.clientSam.id, texte: 'Rappeler pour la visite.' });
    expect(note.structuredContent).toEqual({ refus: { regle: 'R16', code: 'not_assigned' } });
    // Un prix sur un bien du fichier commun : refusé, l'agent ne le tient pas.
    const price = await t.call(t.agent, 'brouillon_prix', { bien: 'bien-sam-vente', prix_eur: 1000 });
    expect(price.structuredContent).toEqual({ refus: { regle: 'R16', code: 'not_assigned' } });
    expect(await t.drafts()).toEqual([]);
    // La direction, la conformité, un partenaire : aucun outil, même la lecture publique sous leur nom.
    for (const role of ['direction', 'compliance', 'partner']) {
      for (const tool of ['mes_biens', 'lire_bien', 'biens_diffusables']) {
        const r = await t.call(t.as(role, 'x-1'), tool, tool === 'lire_bien' ? { bien: 'bien-alex' } : {});
        expect(r.structuredContent).toEqual({ refus: { regle: 'R16', code: 'role' } });
      }
    }
    // Un agent parti, un agent inconnu, un agent d'un autre réseau : coupés.
    expect((await t.call(t.as('agent', t.gone.id), 'mes_biens')).structuredContent).toEqual({ refus: { regle: 'R16', code: 'agent_inactive' } });
    expect((await t.call(t.as('agent', 'inconnu'), 'mes_brouillons')).structuredContent).toEqual({ refus: { regle: 'R16', code: 'agent_inactive' } });
    expect((await t.call(t.as('agent', t.alex.id, t.otherNetwork.id), 'lire_bien', { bien: 'bien-alex' })).structuredContent).toEqual({ refus: { regle: 'R16', code: 'agent_inactive' } });
    // Chaque appel et chaque refus est au journal, sans donnée personnelle.
    const appels = await t.lines('mcp.appel');
    expect(appels.length).toBeGreaterThanOrEqual(15);
    expect((await t.lines('mcp.refus')).length).toBeGreaterThanOrEqual(12);
    for (const e of await t.sql.all()) expect(JSON.stringify(e.data)).not.toMatch(/Camille|Dominique|Rappeler/);
  });

  it('[R590] arguments en dehors du schéma et outil inconnu : refusés et écrits au journal', async () => {
    const t = await setup();
    expect((await t.call(t.agent, 'lire_bien', { bien: 'bien-alex', extra: 1 })).structuredContent).toEqual({ refus: { regle: 'R590', code: 'bad_input' } });
    expect((await t.call(t.agent, 'lire_bien', { bien: 'bien-alex', toString: 'x', constructor: 1 })).structuredContent).toEqual({ refus: { regle: 'R590', code: 'bad_input' } });
    expect((await t.call(t.agent, 'lire_bien', JSON.parse('{"bien":"bien-alex","__proto__":{"x":1}}') as Record<string, unknown>)).structuredContent).toEqual({ refus: { regle: 'R590', code: 'bad_input' } });
    expect((await t.call(t.agent, 'lire_bien', {})).structuredContent).toEqual({ refus: { regle: 'R590', code: 'bad_input' } });
    expect((await t.call(t.agent, 'lire_bien', { bien: "x' OR 1=1" })).structuredContent).toEqual({ refus: { regle: 'R590', code: 'bad_input' } });
    expect((await t.call(t.agent, 'brouillon_prix', { bien: 'bien-alex', prix_eur: 10.5 })).structuredContent).toEqual({ refus: { regle: 'R590', code: 'bad_input' } });
    const unknown = await t.serveur.handle(t.agent, { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'valider_brouillon', arguments: { brouillon: 'x' } } });
    expect(unknown!.error).toMatchObject({ code: -32602 });
    expect((await t.lines('mcp.refus')).map((l) => (l.data as { code: string }).code)).toEqual(['bad_input', 'bad_input', 'bad_input', 'bad_input', 'bad_input', 'bad_input', 'unknown_tool']);
    expect(await t.lines('bien.lu')).toEqual([]);
  });

  it('[R591] aucune écriture définitive sans validation : un brouillon, validé par l’agent seul dans l’application', async () => {
    const t = await setup();
    const before = await t.db.all('SELECT * FROM properties ORDER BY id');
    const note = await t.call(t.agent, 'brouillon_note', { fiche: t.clientAlex.id, texte: '  Préfère être rappelée le matin.  ' });
    expect(note.structuredContent).toMatchObject({ statut: 'a_valider', a_valider_dans: 'application' });
    // Le texte ne repart pas vers l'assistant.
    expect(note.content[0]!.text).not.toContain('matin');
    const price = await t.call(t.agent, 'brouillon_prix', { bien: 'bien-alex', prix_eur: 239000 });
    expect(price.structuredContent).toMatchObject({ statut: 'a_valider' });
    // Rien de définitif : le bien n'a pas bougé, les brouillons attendent.
    expect(await t.db.all('SELECT * FROM properties ORDER BY id')).toEqual(before);
    const rows = await t.drafts();
    expect(rows.map((r) => [r.kind, r.subject, r.status])).toEqual([
      ['note', `person:${t.clientAlex.id}`, 'a_valider'],
      ['prix', 'property:bien-alex', 'a_valider'],
    ]);
    expect(JSON.parse(rows[0]!.payload as string)).toEqual({ text: 'Préfère être rappelée le matin.' });
    // La liste des brouillons ne rend pas le texte d'une note.
    const list = await t.call(t.agent, 'mes_brouillons');
    expect(JSON.stringify(list.structuredContent)).not.toContain('matin');
    expect((list.structuredContent.brouillons as { statut: string }[]).map((b) => b.statut)).toEqual(['a_valider', 'a_valider']);
    // Un autre agent, la direction : ne décident pas. La base le refuse aussi.
    const noteId = rows[0]!.id as string;
    const priceId = rows[1]!.id as string;
    expect(await t.brouillons.decide({ role: 'agent', userId: t.sam.id, networkId: t.network.id } as Viewer, noteId, 'valide')).toEqual({ ok: false, rule: 'R16', code: 'not_assigned' });
    expect(await t.brouillons.decide({ role: 'direction', userId: 'd-1', networkId: t.network.id } as Viewer, noteId, 'valide')).toEqual({ ok: false, rule: 'R16', code: 'role' });
    await expect(t.db.run("UPDATE mcp_drafts SET status = 'valide', decided_at = 'x', decided_by = ? WHERE id = ?", [t.sam.id, noteId])).rejects.toThrow();
    expect(await t.brouillons.decide(t.viewer, noteId, 'publie')).toEqual({ ok: false, rule: 'R591', code: 'bad_input' });
    // L'agent valide la note, refuse le prix ; une décision ne change plus.
    const ok = await t.brouillons.decide(t.viewer, noteId, 'valide');
    expect(ok).toMatchObject({ ok: true, value: { status: 'valide', decidedAt: '2027-03-10T10:00:00.000Z' } });
    expect(await t.brouillons.decide(t.viewer, priceId, 'refuse')).toMatchObject({ ok: true, value: { status: 'refuse' } });
    expect(await t.brouillons.decide(t.viewer, noteId, 'refuse')).toEqual({ ok: false, rule: 'R591', code: 'already_decided' });
    await expect(t.db.run("UPDATE mcp_drafts SET payload = '{}' WHERE id = ?", [noteId])).rejects.toThrow(/ne change plus/);
    await expect(t.db.run("UPDATE mcp_drafts SET status = 'a_valider', decided_at = NULL, decided_by = NULL WHERE id = ?", [noteId])).rejects.toThrow();
    await expect(t.db.run('DELETE FROM mcp_drafts WHERE id = ?', [noteId])).rejects.toThrow(/efface/);
    // Remplacer la ligne d'un brouillon décidé : refusé, la décision reste.
    await expect(
      t.db.run("INSERT OR REPLACE INTO mcp_drafts (id, network_id, agent_id, kind, subject, payload, status, created_at) VALUES (?, ?, ?, 'prix', 'property:bien-alex', '{\"priceEur\":1}', 'a_valider', 'x')", [priceId, t.network.id, t.alex.id]),
    ).rejects.toThrow(/une seule fois/);
    expect((await t.drafts()).find((r) => r.id === priceId)).toMatchObject({ status: 'refuse', payload: '{"priceEur":239000}' });
    // Un brouillon ne naît jamais validé.
    await expect(
      t.db.run("INSERT INTO mcp_drafts (id, network_id, agent_id, kind, subject, payload, status, created_at, decided_at, decided_by) VALUES ('d-x', ?, ?, 'note', 'person:p', '{}', 'valide', 'x', 'x', ?)", [t.network.id, t.alex.id, t.alex.id]),
    ).rejects.toThrow();
    expect((await t.lines('mcp.brouillon.valide')).map((l) => l.subject)).toEqual([`mcp_draft:${noteId}`]);
    expect((await t.lines('mcp.brouillon.refuse')).map((l) => l.subject)).toEqual([`mcp_draft:${priceId}`]);
    // Toujours rien de changé sur le bien.
    expect(await t.db.all('SELECT * FROM properties ORDER BY id')).toEqual(before);
  });

  it('[R591] [R16] la validation revérifie les droits : un bien qui n’est plus à l’agent ne se valide plus', async () => {
    const t = await setup();
    await t.call(t.agent, 'brouillon_prix', { bien: 'bien-alex', prix_eur: 239000 });
    const [row] = await t.drafts();
    await t.db.run('UPDATE properties SET agent_id = ? WHERE id = ?', [t.sam.id, 'bien-alex']);
    expect(await t.brouillons.decide(t.viewer, row!.id, 'valide')).toEqual({ ok: false, rule: 'R16', code: 'not_assigned' });
    expect((await t.drafts())[0]!.status).toBe('a_valider');
    // Texte vide, trop long ou avec caractère de contrôle ; prix hors bornes : rien n'est rangé.
    for (const texte of ['   ', 'x'.repeat(2001), 'a\u0000b']) {
      expect((await t.call(t.agent, 'brouillon_note', { fiche: t.clientAlex.id, texte })).structuredContent).toEqual({ refus: { regle: 'R591', code: 'bad_input' } });
    }
    expect((await t.call(t.agent, 'brouillon_prix', { bien: 'bien-alex-brouillon', prix_eur: 0 })).structuredContent).toEqual({ refus: { regle: 'R591', code: 'bad_input' } });
    expect((await t.call(t.agent, 'brouillon_prix', { bien: 'bien-alex-brouillon', prix_eur: 100_000_001 })).structuredContent).toEqual({ refus: { regle: 'R591', code: 'bad_input' } });
    expect(await t.drafts()).toHaveLength(1);
  });

  it('[R590] [R13] journal en panne : rien n’est rendu ni rangé', async () => {
    const t = await setup();
    t.breakJournal();
    await expect(t.call(t.agent, 'mes_biens')).rejects.toThrow(/journal/);
    await expect(t.call(t.agent, 'brouillon_note', { fiche: t.clientAlex.id, texte: 'Note.' })).rejects.toThrow(/journal/);
    await expect(t.call({ kind: 'public', networkId: t.network.id }, 'biens_diffusables')).rejects.toThrow(/journal/);
    expect(await t.drafts()).toEqual([]);
  });

  it('[R592] la lecture publique ne rend que des biens diffusables, sans donnée personnelle', async () => {
    const t = await setup();
    const pub: McpCaller = { kind: 'public', networkId: t.network.id };
    const r = await t.call(pub, 'biens_diffusables');
    expect(r.isError).toBe(false);
    const biens = r.structuredContent.biens as Record<string, unknown>[];
    // Le plus récent d'abord ; ni le bien que la porte refuse, ni le bien vendu dans le socle, ni l'annonce vendue.
    expect(biens.map((b) => b.bien)).toEqual(['bien-sam-vente', 'bien-alex']);
    expect(r.structuredContent.controle_a).toBe('2027-03-10T10:00:00.000Z');
    // Seulement ce que dit l'annonce : aucun agent, aucune photo, aucune adresse.
    for (const b of biens) expect(Object.keys(b).sort()).toEqual(['bien', 'commune', 'etat', 'mentions', 'prix_eur', 'titre']);
    const text = r.content[0]!.text;
    expect(text).not.toContain(t.alex.id);
    expect(text).not.toContain(t.sam.id);
    expect(text).not.toMatch(EMAIL);
    // La porte est demandée à l'instant, pour chaque bien candidat.
    expect(t.gateCalls.sort()).toEqual(['bien-alex', 'bien-sam-vente', 'bien-sans-mandat']);
    // Par commune, sans tenir compte des accents ni de la casse.
    const chenove = await t.call(pub, 'biens_diffusables', { commune: 'CHENOVE' });
    expect((chenove.structuredContent.biens as { bien: string }[]).map((b) => b.bien)).toEqual(['bien-sam-vente']);
    expect((await t.call(pub, 'biens_diffusables', { commune: '' })).structuredContent).toEqual({ refus: { regle: 'R592', code: 'bad_input' } });
    // Un autre réseau ne voit rien de celui-ci.
    const far = await t.call({ kind: 'public', networkId: t.otherNetwork.id }, 'biens_diffusables');
    expect(far.structuredContent.biens).toEqual([]);
    // L'appel public est au journal, sans identité.
    expect((await t.lines('mcp.appel')).every((l) => l.actor === 'public:mcp')).toBe(true);
  });
});
