import { expect, it } from 'vitest';
import { SqlJournalStore, applyMigrations, fromSyncSqlite, type SqlDatabase } from '../src/index.ts';
import {
  FicheGoogle,
  checkGbpText,
  fallbackReply,
  listingPostText,
  nameTokenHashes,
  GbpError,
  type GbpAck,
  type GbpClient,
  type GbpReview,
  type ReviewReplyWriter,
  type TextContext,
} from '../src/attirer/fiche-google.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

// Tout est inventé : réseau, agents, clients, avis, biens.
const direction = { role: 'direction' as const, userId: 'dir-1', networkId: 'net-1' };
const agent = { role: 'agent' as const, userId: 'ag-1', networkId: 'net-1' };
const otherAgent = { role: 'agent' as const, userId: 'ag-3', networkId: 'net-1' };
const AUTHOR = 'Gaspard Quenouille';

class FakeGbp implements GbpClient {
  calls: string[] = [];
  reviewsToGive: GbpReview[] = [];
  fail = false;
  /** L'erreur que Google lève à la place de la panne simple (AU037). */
  error: Error | null = null;
  /** L'accusé rendu à la place de celui de Google, pour un accusé absent ou mal formé. */
  ack: unknown = undefined;
  private n = 0;
  private answer(ref: string, url: string | null = null): GbpAck {
    if (this.error) throw this.error;
    if (this.fail) throw new Error('panne inventée');
    return (this.ack === undefined ? { ref, url } : this.ack) as GbpAck;
  }
  async listReviews(): Promise<GbpReview[]> {
    this.calls.push('listReviews');
    if (this.error) throw this.error;
    return this.reviewsToGive;
  }
  async replyToReview(_l: string, reviewRef: string, text: string): Promise<GbpAck> {
    this.calls.push(`reply:${reviewRef}:${text.length}`);
    return this.answer(`${reviewRef}/reply`);
  }
  async createPost(l: string, post: { text: string; linkUri: string }): Promise<GbpAck> {
    this.calls.push(`post:${post.linkUri}`);
    return this.answer(`${l}/localPosts/p${++this.n}`, `https://local.google.test/post/${this.n}`);
  }
  async updateInfo(l: string): Promise<GbpAck> {
    this.calls.push('info');
    return this.answer(l);
  }
  writes(): string[] {
    return this.calls.filter((c) => c !== 'listReviews');
  }
}

const fixedWriter = (text: string): ReviewReplyWriter & { seen: unknown[] } => {
  const seen: unknown[] = [];
  return {
    seen,
    async write(input) {
      seen.push(input);
      return text;
    },
  };
};

async function setup(options: { writer?: ReviewReplyWriter; mode?: 'essai' | 'reel' } = {}) {
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  const journal = new SqlJournalStore(db);
  let clock = Date.parse('2026-10-29T08:00:00.000Z');
  const now = (): Date => new Date((clock += 1000));
  const advanceDays = (d: number) => (clock += d * 86_400_000);
  await db.run("INSERT INTO networks (id, name, created_at) VALUES ('net-1', 'Réseau test', 'x')");
  await db.run("INSERT INTO networks (id, name, created_at) VALUES ('net-2', 'Autre réseau', 'x')");
  await db.run("INSERT INTO agents (id, network_id, first_name, last_name, created_at, updated_at) VALUES ('ag-1', 'net-1', 'Camille', 'Exemple', 'x', 'x')");
  await db.run("INSERT INTO agents (id, network_id, first_name, last_name, status, created_at, updated_at) VALUES ('ag-2', 'net-1', 'Paul', 'Parti', 'left', 'x', 'x')");
  await db.run("INSERT INTO agents (id, network_id, first_name, last_name, created_at, updated_at) VALUES ('ag-3', 'net-1', 'Rémi', 'Voisin', 'x', 'x')");
  await db.run("INSERT INTO agent_public_cards (id, agent_id, network_id, phone, email, set_by, set_at) VALUES ('c1', 'ag-1', 'net-1', '06 00 00 00 00', 'camille@exemple.test', 'direction:dir-1', 'x')");
  // Un client de la base, qui n'a pas écrit l'avis.
  await db.run("INSERT INTO persons (id, network_id, agent_id, first_name, last_name, created_at, updated_at) VALUES ('p-1', 'net-1', 'ag-1', 'Hortense', 'Bérangère-Lunel', 'x', 'x')");
  const client = new FakeGbp();
  // La porte de diffusion inventée : un bien sans mandat en vigueur est dans `noMandate`.
  const noMandate = new Set<string>();
  const diffusion = { canDiffuse: async (_n: string, propertyId: string) => ({ allowed: !noMandate.has(propertyId), reason: noMandate.has(propertyId) ? 'expired' : 'allowed' }) };
  const fiche = new FicheGoogle(db, journal, { now, client, writer: options.writer, mode: options.mode ?? 'essai', timeoutMs: 50, diffusion });
  expect(await fiche.setLocation(direction, 'ag-1', { locationRef: 'locations/123', title: 'Camille Exemple, agent immobilier', websiteUri: 'https://camille.exemple.test' })).toEqual({ ok: true });
  return { db, journal, fiche, client, advanceDays, now, noMandate };
}

async function withReview(s: Awaited<ReturnType<typeof setup>>, rating = 5, comment: string | null = 'Très bon suivi, réactive et à l’écoute.') {
  s.client.reviewsToGive = [{ reviewRef: 'accounts/1/locations/123/reviews/r1', rating, comment, authorName: AUTHOR, reviewedAt: '2026-10-28T10:00:00.000Z' }];
  expect(await s.fiche.importReviews('net-1', 'ag-1')).toEqual({ ok: true, added: 1 });
  return (await s.db.first<{ id: string }>('SELECT id FROM gbp_reviews'))!.id;
}

async function listing(db: SqlDatabase, id: string, seq: number, state: string, title: string) {
  await db.exec('PRAGMA foreign_keys = OFF');
  await db.run("INSERT OR IGNORE INTO properties (id, network_id, agent_id, reference, kind, city, created_at, updated_at) VALUES (?, 'net-1', 'ag-1', ?, 'home', 'Ville inventée', 'x', 'x')", [id, `REF-${id}`]);
  await db.run(
    "INSERT INTO listing_versions (id, property_id, network_id, seq, state, draft_id, price_eur, payload, payload_hash, reason, created_at) VALUES (?, ?, 'net-1', ?, ?, ?, ?, ?, 'h', 'test', 'x')",
    [`${id}-${seq}`, id, seq, state, state === 'retiree' ? null : `d-${id}-${seq}`, state === 'retiree' ? null : 250000, JSON.stringify({ reference: `REF-${id}`, state, title, body: 'Texte', mentions: 'Classe énergie D.', priceEur: 250000, media: [] })],
  );
  await db.exec('PRAGMA foreign_keys = ON');
}

/** Tout ce que la base et le journal gardent, en un seul texte. */
async function everything(db: SqlDatabase): Promise<string> {
  const tables = ['gbp_locations', 'gbp_reviews', 'gbp_drafts', 'gbp_validations', 'gbp_sends', 'journal'];
  const out: unknown[] = [];
  for (const t of tables) out.push(await db.all(`SELECT * FROM ${t}`));
  return JSON.stringify(out);
}

const ctx = (over: Partial<TextContext> = {}): TextContext => ({ kind: 'reponse', authorTokenHashes: [], clientFirstNames: new Set(), clientLastNames: new Set(), signature: 'Camille, votre agent immobilier', ...over });

it('[R154] le contrôle refuse nom, adresse, montant, détail du dossier et coordonnée, et laisse passer une réponse simple', async () => {
  const hashes = await nameTokenHashes(AUTHOR, 'net-1');
  const c = ctx({ authorTokenHashes: hashes, clientFirstNames: new Set(['hortense']), clientLastNames: new Set(['berangere', 'lunel']) });
  expect(await checkGbpText('Merci pour votre avis, au plaisir.\nCamille', c, 'net-1')).toEqual([]);
  expect(await checkGbpText('Merci Gaspard pour votre avis.', c, 'net-1')).toEqual(['nom']);
  expect(await checkGbpText('merci gaspard pour votre avis.', c, 'net-1')).toEqual(['nom']);
  expect(await checkGbpText('Merci Monsieur QUENOUILLE.', c, 'net-1')).toEqual(['nom']);
  expect(await checkGbpText('Merci à Hortense, rencontrée hier.', c, 'net-1')).toEqual(['nom']);
  expect(await checkGbpText('Merci à Bérangère.', c, 'net-1')).toEqual(['nom']);
  expect(await checkGbpText('Ravie pour votre maison rue Monge.', c, 'net-1')).toEqual(['adresse']);
  expect(await checkGbpText('Votre maison Rue Monge a trouvé preneur.', c, 'net-1')).toEqual(['adresse']);
  expect(await checkGbpText('Ravie pour la maison rue de la paix.', c, 'net-1')).toEqual(['adresse']);
  expect(await checkGbpText('Bravo pour la maison Place Darcy.', c, 'net-1')).toEqual(['adresse']);
  // Des mots courants qui ne sont pas des voies.
  expect(await checkGbpText('Merci pour la mise en place du suivi, et sur place tout était en ordre.', c, 'net-1')).toEqual([]);
  expect(await checkGbpText('Maison avec place de parking, en cours de rénovation.', ctx({ kind: 'publication' }), 'net-1')).toEqual([]);
  // Un nom de client écrit en minuscules : son nom de famille, ou son prénom suivi d'un nom.
  expect(await checkGbpText('Merci hortense lunel !', c, 'net-1')).toEqual(['nom']);
  expect(await checkGbpText('Merci hortense, au plaisir !', c, 'net-1')).toEqual(['nom']);
  expect(await checkGbpText('Votre maison au 12 lotissement des lilas est magnifique.', c, 'net-1')).toEqual(['adresse']);
  expect(await checkGbpText('Au 3 résidence du parc, tout est prêt à visiter.', ctx({ kind: 'reponse' }), 'net-1')).toContain('adresse');
  expect(await checkGbpText('merci madame lunel.', c, 'net-1')).toEqual(['nom']);
  // La signature du code n'est pas lue, mais le même prénom ailleurs dans le texte l'est.
  const camille = ctx({ authorTokenHashes: await nameTokenHashes('Camille Rivière', 'net-1') });
  expect(await checkGbpText('Merci pour votre avis.\nCamille, votre agent immobilier', camille, 'net-1')).toEqual([]);
  expect(await checkGbpText('Merci Camille pour votre avis.\nCamille, votre agent immobilier', camille, 'net-1')).toEqual(['nom']);
  expect(await checkGbpText('Au 12 avenue des Tilleuls, tout s’est bien passé.', c, 'net-1')).toEqual(['adresse']);
  expect(await checkGbpText('Vendue 245 000 € en trois semaines !', c, 'net-1')).toEqual(['montant']);
  expect(await checkGbpText('Vendue 245000 euros.', c, 'net-1')).toEqual(['montant']);
  expect(await checkGbpText('Le compromis a été signé chez le notaire.', c, 'net-1')).toEqual(['dossier']);
  expect(await checkGbpText('Votre prêt a enfin été accordé.', c, 'net-1')).toEqual(['dossier']);
  expect(await checkGbpText('Appelez-moi au 06 12 34 56 78.', c, 'net-1')).toEqual(['coordonnee']);
  expect(await checkGbpText('Écrivez à quelquun@exemple.test.', c, 'net-1')).toEqual(['coordonnee']);
  expect(await checkGbpText('', c, 'net-1')).toEqual(['vide']);
  expect(await checkGbpText('a'.repeat(1501), c, 'net-1')).toEqual(['longueur']);
});

it('[R64] [R07] [R06] le contrôle refuse contrepartie, « mandataire », « gratuit », toute mention de l’IA, et un faux témoignage dans une publication', async () => {
  const c = ctx();
  expect(await checkGbpText('Merci ! Une remise vous attend.', c, 'net-1')).toEqual(['contrepartie']);
  expect(await checkGbpText('Un cadeau pour votre prochain avis.', c, 'net-1')).toEqual(['contrepartie']);
  expect(await checkGbpText('Nous vous offrons votre prochaine estimation.', c, 'net-1')).toEqual(['contrepartie']);
  expect(await checkGbpText('Votre mandataire vous remercie.', c, 'net-1')).toEqual(['vocabulaire']);
  expect(await checkGbpText('Estimation gratuite.', c, 'net-1')).toEqual(['vocabulaire']);
  expect(await checkGbpText('Réponse rédigée par notre IA.', c, 'net-1')).toEqual(['ia']);
  expect(await checkGbpText('Notre intelligence artificielle vous remercie.', c, 'net-1')).toEqual(['ia']);
  expect(await checkGbpText('« Une agence parfaite » disent nos clients.', ctx({ kind: 'publication' }), 'net-1')).toEqual(['temoignage']);
  expect(await checkGbpText('Nos clients recommandent Camille.', ctx({ kind: 'publication' }), 'net-1')).toEqual(['temoignage']);
  expect(await checkGbpText('Estimation offerte, sur rendez-vous.', ctx({ kind: 'publication' }), 'net-1')).toEqual([]);
});

it('[R154] le secours du code passe toujours le contrôle, pour chaque note, et la publication d’un bien ne porte jamais son prix', async () => {
  const c = ctx({ authorTokenHashes: await nameTokenHashes(AUTHOR, 'net-1'), clientFirstNames: new Set(['hortense']) });
  for (const rating of [1, 2, 3, 4, 5]) {
    const t = fallbackReply(rating, 'Camille');
    expect(await checkGbpText(t, c, 'net-1'), String(rating)).toEqual([]);
    expect(t).toContain('Camille, votre agent immobilier');
  }
  const post = listingPostText('Maison 5 pièces avec jardin à Talant', 'Camille');
  expect(await checkGbpText(post, ctx({ kind: 'publication' }), 'net-1')).toEqual([]);
  expect(post.endsWith('\nCamille, votre agent immobilier')).toBe(true);
  expect(post).not.toMatch(/€|\d{3}/);
});

describeWithSqlite('AT06 · fiche Google : publications et réponses aux avis préparées, validées', () => {
  it('[R154] Jamais vu : le nom de l’auteur n’est jamais gardé ni donné à l’IA, et pourtant une réponse de l’IA qui le cite est refusée', async () => {
    const writer = fixedWriter('Merci Gaspard pour ce bel avis !');
    const s = await setup({ writer });
    const reviewId = await withReview(s);
    const r = await s.fiche.draftReply(agent, reviewId);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.origin).toBe('secours');
    expect(r.value.body).not.toMatch(/gaspard|quenouille/i);
    // L'IA a reçu la note, le texte de l'avis et le prénom de l'agent, rien d'autre.
    expect(writer.seen).toEqual([{ rating: 5, comment: 'Très bon suivi, réactive et à l’écoute.', agentFirstName: 'Camille' }]);
    const all = await everything(s.db);
    expect(all).not.toMatch(/gaspard|quenouille/i);
    // Le texte refusé n'est jamais rangé : seuls les codes de ses problèmes vont au journal.
    expect(all).not.toContain('bel avis');
    expect(all).toContain('attirer.google.ia_refusee');
  });

  it('[R154] une réponse de l’IA qui cite un autre client de la base, une adresse, un prix ou un détail du dossier laisse place au secours', async () => {
    for (const bad of ['Merci, et bonjour à Hortense !', 'Ravie pour la maison rue Monge.', 'Vendue 245 000 € : bravo.', 'Le compromis est signé, merci.', 'Appelez-moi au 06 12 34 56 78.']) {
      const s = await setup({ writer: fixedWriter(bad) });
      const r = await s.fiche.draftReply(agent, await withReview(s));
      expect(r.ok && r.value.origin, bad).toBe('secours');
    }
    const s = await setup({ writer: fixedWriter('Merci pour votre confiance, au plaisir de vous revoir.\nCamille') });
    const r = await s.fiche.draftReply(agent, await withReview(s));
    expect(r.ok && r.value.origin).toBe('ia');
  });

  it('[R154] une IA absente, en panne ou trop lente laisse place au secours', async () => {
    const slow: ReviewReplyWriter = { write: () => new Promise((res) => setTimeout(() => res('Merci !'), 500)) };
    const broken: ReviewReplyWriter = { write: async () => Promise.reject(new Error('panne inventée')) };
    for (const writer of [undefined, slow, broken]) {
      const s = await setup(writer ? { writer } : {});
      const r = await s.fiche.draftReply(agent, await withReview(s, 2, 'Déçu, commentaire inventé.'));
      expect(r.ok && r.value.origin).toBe('secours');
      expect(r.ok && r.value.body).toContain('désolé');
    }
  });

  it('[R154] aucune réponse ni publication ne part sans la validation nommée d’un humain sur son texte exact', async () => {
    const s = await setup({ mode: 'reel' });
    const reviewId = await withReview(s);
    const d = await s.fiche.draftReply(agent, reviewId);
    if (!d.ok) throw new Error('refusé');
    expect(await s.fiche.publish(agent, d.value.draftId)).toEqual({ ok: false, rule: 'R154', code: 'non_valide' });
    // Un autre agent ne valide pas la fiche d'un collègue.
    expect(await s.fiche.validate(otherAgent, d.value.draftId)).toMatchObject({ ok: false, rule: 'R16', code: 'role' });
    const v = await s.fiche.validate(agent, d.value.draftId);
    expect(v.ok && v.value.validatedBy).toBe('agent:ag-1');
    expect(await s.fiche.validate(agent, d.value.draftId)).toEqual({ ok: false, rule: 'R154', code: 'deja_valide' });
    expect(s.client.writes()).toEqual([]);
    expect(await s.fiche.publish(agent, d.value.draftId)).toEqual({ ok: true, mode: 'reel' });
    expect(s.client.writes()).toEqual([`reply:accounts/1/locations/123/reviews/r1:${d.value.body.length}`]);
    // Un texte ne part qu'une fois, et un avis ne reçoit qu'une réponse.
    expect(await s.fiche.publish(agent, d.value.draftId)).toEqual({ ok: false, rule: 'R154', code: 'deja_parti' });
    const again = await s.fiche.writeReply(agent, reviewId, 'Merci encore pour votre confiance.');
    if (!again.ok) throw new Error('refusé');
    await s.fiche.validate(agent, again.value.draftId);
    expect(await s.fiche.publish(agent, again.value.draftId)).toEqual({ ok: false, rule: 'R154', code: 'deja_parti' });
    expect(s.client.writes()).toHaveLength(1);
  });

  it('[R154] un texte validé puis remplacé par un nouveau texte ne part plus ; un texte rangé ne se réécrit pas', async () => {
    const s = await setup({ mode: 'reel' });
    const reviewId = await withReview(s);
    const d1 = await s.fiche.draftReply(agent, reviewId);
    if (!d1.ok) throw new Error('refusé');
    await s.fiche.validate(agent, d1.value.draftId);
    const d2 = await s.fiche.writeReply(agent, reviewId, 'Merci pour votre avis, à bientôt.');
    expect(d2.ok).toBe(true);
    expect(await s.fiche.publish(agent, d1.value.draftId)).toEqual({ ok: false, rule: 'R154', code: 'texte_change' });
    await expect(s.db.run("UPDATE gbp_drafts SET body = 'Autre texte' WHERE id = ?", [d1.value.draftId])).rejects.toThrow(/rien ne se réécrit/);
    await expect(s.db.run('DELETE FROM gbp_validations')).rejects.toThrow(/rien ne s'efface/);
    expect(s.client.writes()).toEqual([]);
  });

  it('[R154] le texte est recontrôlé au départ : un client entré dans la base après la validation bloque l’envoi', async () => {
    const s = await setup({ mode: 'reel' });
    const reviewId = await withReview(s);
    const d = await s.fiche.writeReply(agent, reviewId, 'Merci Octave, au plaisir.\nCamille');
    if (!d.ok) throw new Error('refusé');
    await s.fiche.validate(agent, d.value.draftId);
    await s.db.run("INSERT INTO persons (id, network_id, agent_id, first_name, last_name, created_at, updated_at) VALUES ('p-2', 'net-1', 'ag-1', 'Octave', 'Inventé', 'x', 'x')");
    expect(await s.fiche.publish(agent, d.value.draftId)).toEqual({ ok: false, rule: 'R154', code: 'texte_refuse', problems: ['nom'] });
    expect(s.client.writes()).toEqual([]);
  });

  it('[R64] aucune contrepartie dans la réponse de l’agent, et l’interface ne sait pas écrire un avis à la place d’un client', async () => {
    const s = await setup();
    const reviewId = await withReview(s);
    expect(await s.fiche.writeReply(agent, reviewId, 'Merci ! Un bon d’achat vous attend.')).toEqual({ ok: false, rule: 'R154', code: 'texte_refuse', problems: ['contrepartie'] });
    // Ce que l'interface sait faire, et rien d'autre : lire les avis, y répondre, publier, tenir la fiche à jour.
    const methods: Record<keyof GbpClient, true> = { listReviews: true, replyToReview: true, createPost: true, updateInfo: true };
    expect(Object.keys(methods).sort()).toEqual(['createPost', 'listReviews', 'replyToReview', 'updateInfo']);
    expect(Object.getOwnPropertyNames(FicheGoogle.prototype).filter((m) => /(?:create|write|post|add|new)Reviews?\b|avis/i.test(m))).toEqual([]);
  });

  it('[R26] en mode essai, rien ne part : l’interface n’est jamais appelée pour écrire, l’envoi est seulement noté', async () => {
    const s = await setup({ mode: 'essai' });
    const reviewId = await withReview(s);
    const d = await s.fiche.draftReply(agent, reviewId);
    if (!d.ok) throw new Error('refusé');
    await s.fiche.validate(direction, d.value.draftId);
    expect(await s.fiche.publish(agent, d.value.draftId)).toEqual({ ok: true, mode: 'essai' });
    await listing(s.db, 'b1', 1, 'en_vente', 'Maison 5 pièces avec jardin à Talant');
    const post = await s.fiche.duePost('net-1', 'ag-1');
    if (!post.ok || !post.value) throw new Error('pas de publication');
    await s.fiche.validate(agent, post.value.draftId);
    expect(await s.fiche.publish(agent, post.value.draftId)).toEqual({ ok: true, mode: 'essai' });
    expect(await s.fiche.syncInfo('net-1', 'ag-1')).toEqual({ ok: true, changed: true, mode: 'essai' });
    expect(s.client.writes()).toEqual([]);
    const sends = await s.db.all<{ mode: string; outcome: string }>('SELECT mode, outcome FROM gbp_sends ORDER BY rowid');
    expect(sends).toEqual([{ mode: 'essai', outcome: 'essai' }, { mode: 'essai', outcome: 'essai' }, { mode: 'essai', outcome: 'essai' }]);
  });

  it('publications régulières : un bien en vente publié, au plus une par période, jamais deux fois le même bien, jamais un bien retiré', async () => {
    const s = await setup({ mode: 'reel' });
    await listing(s.db, 'b1', 1, 'en_vente', 'Maison 5 pièces avec jardin à Talant');
    await listing(s.db, 'b2', 1, 'en_vente', 'Appartement 3 pièces lumineux à Chenôve');
    await listing(s.db, 'b3', 1, 'vendu', 'Studio à Quetigny');
    const p1 = await s.fiche.duePost('net-1', 'ag-1');
    if (!p1.ok || !p1.value) throw new Error('pas de publication');
    expect(p1.value.propertyId).toBe('b1');
    expect(p1.value.body).toBe(listingPostText('Maison 5 pièces avec jardin à Talant', 'Camille'));
    expect(p1.value.linkUri).toBe('https://camille.exemple.test/biens/b1');
    expect(p1.value.body).not.toMatch(/250|€/);
    // Pas une seconde dans la même période.
    expect(await s.fiche.duePost('net-1', 'ag-1')).toEqual({ ok: true, value: null });
    s.advanceDays(8);
    const p2 = await s.fiche.duePost('net-1', 'ag-1');
    expect(p2.ok && p2.value?.propertyId).toBe('b2');
    s.advanceDays(8);
    expect(await s.fiche.duePost('net-1', 'ag-1')).toEqual({ ok: true, value: null });
    // Un bien retiré après la préparation ne se valide ni ne part.
    await listing(s.db, 'b2', 2, 'retiree', 'Appartement 3 pièces lumineux à Chenôve');
    if (!p2.ok || !p2.value) throw new Error('pas de publication');
    expect(await s.fiche.validate(agent, p2.value.draftId)).toEqual({ ok: false, rule: 'R154', code: 'bien_retire' });
    await s.fiche.validate(agent, p1.value.draftId);
    expect(await s.fiche.publish(agent, p1.value.draftId)).toEqual({ ok: true, mode: 'reel' });
    expect(s.client.writes()).toEqual(['post:https://camille.exemple.test/biens/b1']);
  });

  it('[R42] un bien dont le mandat ne permet plus la diffusion n’est ni préparé, ni validé, ni publié', async () => {
    const s = await setup({ mode: 'reel' });
    await listing(s.db, 'b1', 1, 'en_vente', 'Maison 5 pièces avec jardin à Talant');
    await listing(s.db, 'b2', 1, 'en_vente', 'Appartement 3 pièces lumineux à Chenôve');
    s.noMandate.add('b1');
    const p = await s.fiche.duePost('net-1', 'ag-1');
    expect(p.ok && p.value?.propertyId).toBe('b2');
    s.noMandate.add('b2');
    if (!p.ok || !p.value) throw new Error('pas de publication');
    expect(await s.fiche.validate(agent, p.value.draftId)).toEqual({ ok: false, rule: 'R154', code: 'bien_retire' });
    s.noMandate.delete('b2');
    await s.fiche.validate(agent, p.value.draftId);
    s.noMandate.add('b2');
    expect(await s.fiche.publish(agent, p.value.draftId)).toEqual({ ok: false, rule: 'R154', code: 'bien_retire' });
    expect(s.client.writes()).toEqual([]);
  });

  it('un texte périmé jamais parti (nouvelle version du bien) est remplacé ; un bien publié ne l’est plus jamais', async () => {
    const s = await setup({ mode: 'reel' });
    await listing(s.db, 'b1', 1, 'en_vente', 'Maison 5 pièces avec jardin à Talant');
    const p1 = await s.fiche.duePost('net-1', 'ag-1');
    if (!p1.ok || !p1.value) throw new Error('pas de publication');
    await listing(s.db, 'b1', 2, 'en_vente', 'Maison 5 pièces avec grand jardin à Talant');
    s.advanceDays(8);
    const p2 = await s.fiche.duePost('net-1', 'ag-1');
    if (!p2.ok || !p2.value) throw new Error('pas de remplacement');
    expect(p2.value.body).toContain('grand jardin');
    await s.fiche.validate(agent, p2.value.draftId);
    expect(await s.fiche.publish(agent, p2.value.draftId)).toEqual({ ok: true, mode: 'reel' });
    await listing(s.db, 'b1', 3, 'en_vente', 'Maison 5 pièces rénovée à Talant');
    s.advanceDays(8);
    expect(await s.fiche.duePost('net-1', 'ag-1')).toEqual({ ok: true, value: null });
  });

  it('un titre d’annonce qui ne passe pas le contrôle n’est pas publié, et c’est noté sans le texte', async () => {
    const s = await setup();
    await listing(s.db, 'b1', 1, 'en_vente', 'Maison rue Monge à 245 000 €');
    expect(await s.fiche.duePost('net-1', 'ag-1')).toEqual({ ok: true, value: null });
    const all = await everything(s.db);
    expect(all).toContain('attirer.google.texte_refuse');
    expect(all).not.toContain('Monge');
  });

  it('informations de la fiche : depuis les réglages, envoyées seulement quand elles changent ; une panne est notée', async () => {
    const s = await setup({ mode: 'reel' });
    expect(await s.fiche.syncInfo('net-1', 'ag-1')).toEqual({ ok: true, changed: true, mode: 'reel' });
    expect(await s.fiche.syncInfo('net-1', 'ag-1')).toEqual({ ok: true, changed: false, mode: 'reel' });
    expect(await s.fiche.setLocation(direction, 'ag-1', { locationRef: 'locations/123', title: 'Camille Exemple, agent immobilier à Dijon', websiteUri: 'https://camille.exemple.test' })).toEqual({ ok: true });
    s.client.fail = true;
    expect(await s.fiche.syncInfo('net-1', 'ag-1')).toEqual({ ok: false, rule: null, code: 'echec', error: 'panne', action: 'reessayer' });
    s.client.fail = false;
    expect(await s.fiche.syncInfo('net-1', 'ag-1')).toEqual({ ok: true, changed: true, mode: 'reel' });
    expect(s.client.writes()).toEqual(['info', 'info', 'info']);
    expect(await s.fiche.syncInfo('net-1', 'ag-2')).toEqual({ ok: false, rule: null, code: 'sans_fiche' });
  });

  it('[R07] la fiche réglée par la direction seulement, avec un nom qui passe le contrôle', async () => {
    const s = await setup();
    expect(await s.fiche.setLocation(agent, 'ag-1', { locationRef: 'locations/9', title: 'Camille', websiteUri: 'https://x.exemple.test' })).toMatchObject({ ok: false, rule: 'R16' });
    expect(await s.fiche.setLocation(direction, 'ag-1', { locationRef: 'locations/9', title: 'Camille, mandataire', websiteUri: 'https://x.exemple.test' })).toEqual({ ok: false, rule: null, code: 'invalide' });
    expect(await s.fiche.setLocation(direction, 'ag-1', { locationRef: 'pas une fiche', title: 'Camille', websiteUri: 'https://x.exemple.test' })).toEqual({ ok: false, rule: null, code: 'invalide' });
    expect(await s.fiche.setLocation(direction, 'ag-2', { locationRef: 'locations/9', title: 'Paul', websiteUri: 'https://x.exemple.test' })).toMatchObject({ ok: false, rule: 'R16', code: 'agent_parti' });
  });

  it('[R16] avis et textes lus seulement par l’agent de la fiche ou la direction de son réseau ; un avis déjà lu n’est pas repris', async () => {
    const s = await setup();
    const reviewId = await withReview(s);
    expect(await s.fiche.importReviews('net-1', 'ag-1')).toEqual({ ok: true, added: 0 });
    expect(await s.fiche.reviews(otherAgent, 'ag-1')).toMatchObject({ ok: false, rule: 'R16' });
    expect(await s.fiche.draftReply({ ...agent, networkId: 'net-2' }, reviewId)).toMatchObject({ ok: false, rule: 'R16', code: 'inconnu' });
    const r = await s.fiche.reviews(direction, 'ag-1');
    expect(r.ok && r.value.map((x) => [x.rating, x.comment])).toEqual([[5, 'Très bon suivi, réactive et à l’écoute.']]);
    expect(JSON.stringify(r)).not.toMatch(/gaspard/i);
  });

  it('[R154] deux demandes simultanées ne font partir qu’un texte, et un avis ne reçoit qu’une réponse', async () => {
    const s = await setup({ mode: 'reel' });
    const reviewId = await withReview(s);
    const a = await s.fiche.draftReply(agent, reviewId);
    if (!a.ok) throw new Error('refusé');
    await s.fiche.validate(agent, a.value.draftId);
    const results = await Promise.all([s.fiche.publish(agent, a.value.draftId), s.fiche.publish(agent, a.value.draftId), s.fiche.publish(direction, a.value.draftId)]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(s.client.writes()).toHaveLength(1);
    await listing(s.db, 'b1', 1, 'en_vente', 'Maison 5 pièces avec jardin à Talant');
    const p = await s.fiche.duePost('net-1', 'ag-1');
    if (!p.ok || !p.value) throw new Error('pas de publication');
    await s.fiche.validate(agent, p.value.draftId);
    const posts = await Promise.all([s.fiche.publish(agent, p.value.draftId), s.fiche.publish(agent, p.value.draftId)]);
    expect(posts.filter((r) => r.ok)).toHaveLength(1);
    expect(s.client.writes()).toHaveLength(2);
  });

  it('[R154] un client « Le Goff », « Da Silva » ou « Du Pont » ne bloque ni le secours ni les publications, mais son nom reste refusé', async () => {
    const s = await setup();
    for (const [id, first, last] of [['p-3', 'Yann', 'Le Goff'], ['p-4', 'Ana', 'Da Silva'], ['p-5', 'Luc', 'Du Pont'], ['p-6', 'Rui', 'De Oliveira']] as const) {
      await s.db.run("INSERT INTO persons (id, network_id, agent_id, first_name, last_name, created_at, updated_at) VALUES (?, 'net-1', 'ag-1', ?, ?, 'x', 'x')", [id, first, last]);
    }
    s.client.reviewsToGive = [1, 2, 3, 4, 5].map((rating) => ({ reviewRef: `accounts/1/locations/123/reviews/n${rating}`, rating, comment: null, authorName: null, reviewedAt: '2026-10-28T10:00:00.000Z' }));
    expect(await s.fiche.importReviews('net-1', 'ag-1')).toEqual({ ok: true, added: 5 });
    for (const row of await s.db.all<{ id: string; rating: number }>('SELECT id, rating FROM gbp_reviews')) {
      const r = await s.fiche.draftReply(agent, row.id);
      expect(r.ok && r.value.origin, String(row.rating)).toBe('secours');
    }
    await listing(s.db, 'b1', 1, 'en_vente', 'Maison 5 pièces avec jardin à Talant');
    const p = await s.fiche.duePost('net-1', 'ag-1');
    expect(p.ok && p.value?.propertyId).toBe('b1');
    const review = (await s.db.first<{ id: string }>('SELECT id FROM gbp_reviews'))!.id;
    expect(await s.fiche.writeReply(agent, review, 'Merci monsieur le goff.')).toMatchObject({ ok: false, problems: ['nom'] });
    expect(await s.fiche.writeReply(agent, review, 'Merci Madame Oliveira.')).toMatchObject({ ok: false, problems: ['nom'] });
    await s.db.run("INSERT INTO persons (id, network_id, agent_id, first_name, last_name, created_at, updated_at) VALUES ('p-7', 'net-1', 'ag-1', 'Ben', 'Inventé', 'x', 'x')");
    expect(await s.fiche.writeReply(agent, review, 'Merci Ben !')).toMatchObject({ ok: false, problems: ['nom'] });
  });

  it('[R154] le nom de l’auteur est refusé même s’il est aussi le prénom d’un agent du réseau', async () => {
    const s = await setup({ writer: fixedWriter('Merci Rémi pour votre confiance.') });
    s.client.reviewsToGive = [{ reviewRef: 'accounts/1/locations/123/reviews/r9', rating: 5, comment: null, authorName: 'Rémi Inventé', reviewedAt: '2026-10-28T10:00:00.000Z' }];
    await s.fiche.importReviews('net-1', 'ag-1');
    const id = (await s.db.first<{ id: string }>('SELECT id FROM gbp_reviews'))!.id;
    const r = await s.fiche.draftReply(agent, id);
    expect(r.ok && r.value.origin).toBe('secours');
    expect(await s.fiche.writeReply(agent, id, 'Merci rémi !')).toMatchObject({ ok: false, problems: ['nom'] });
  });

  it('[R46] l’IA reçoit le texte de l’avis sans nom, adresse, téléphone, mail ni montant', async () => {
    const writer = fixedWriter('Merci pour votre confiance.');
    const s = await setup({ writer });
    const id = await withReview(s, 5, 'Gaspard Quenouille ici, 12 rue des Lilas, joignable au 06 12 34 56 78 ou gq@exemple.test. Vendu 245 000 €, merci à Hortense pour la visite !');
    await s.fiche.draftReply(agent, id);
    const sent = (writer.seen[0] as { comment: string }).comment;
    expect(sent).not.toMatch(/gaspard|quenouille|lilas|06 12|gq@|245|hortense/i);
    expect(sent).toContain('pour la visite');
    // Ce que la base garde de l'avis n'est pas changé : seule la copie pour l'IA l'est.
    expect((await s.db.first<{ comment: string }>('SELECT comment FROM gbp_reviews'))!.comment).toContain('pour la visite');
  });

  it('au plus une publication par période, comptée aussi au départ : des textes validés en retard ne partent pas ensemble', async () => {
    const s = await setup({ mode: 'reel' });
    await listing(s.db, 'b1', 1, 'en_vente', 'Maison 5 pièces avec jardin à Talant');
    await listing(s.db, 'b2', 1, 'en_vente', 'Appartement 3 pièces lumineux à Chenôve');
    const p1 = await s.fiche.duePost('net-1', 'ag-1');
    s.advanceDays(8);
    const p2 = await s.fiche.duePost('net-1', 'ag-1');
    if (!p1.ok || !p1.value || !p2.ok || !p2.value) throw new Error('pas de publication');
    await s.fiche.validate(agent, p1.value.draftId);
    await s.fiche.validate(agent, p2.value.draftId);
    expect(await s.fiche.publish(agent, p1.value.draftId)).toEqual({ ok: true, mode: 'reel' });
    expect(await s.fiche.publish(agent, p2.value.draftId)).toEqual({ ok: false, rule: 'R154', code: 'trop_tot' });
    s.advanceDays(8);
    expect(await s.fiche.publish(agent, p2.value.draftId)).toEqual({ ok: true, mode: 'reel' });
    expect(s.client.writes()).toHaveLength(2);
  });

  it('[R26] un essai ne consomme pas l’envoi réel : après la mise en service, le texte et le bien peuvent partir pour de bon', async () => {
    const s = await setup({ mode: 'essai' });
    await listing(s.db, 'b1', 1, 'en_vente', 'Maison 5 pièces avec jardin à Talant');
    const p = await s.fiche.duePost('net-1', 'ag-1');
    if (!p.ok || !p.value) throw new Error('pas de publication');
    await s.fiche.validate(agent, p.value.draftId);
    expect(await s.fiche.publish(agent, p.value.draftId)).toEqual({ ok: true, mode: 'essai' });
    const reel = new FicheGoogle(s.db, s.journal, { now: s.now, client: s.client, mode: 'reel', diffusion: { canDiffuse: async () => ({ allowed: true, reason: 'allowed' }) } });
    expect(await reel.publish(agent, p.value.draftId)).toEqual({ ok: true, mode: 'reel' });
    expect(s.client.writes()).toEqual(['post:https://camille.exemple.test/biens/b1']);
    expect(await reel.publish(agent, p.value.draftId)).toEqual({ ok: false, rule: 'R154', code: 'deja_parti' });
  });

  it('[R13] chaque refus d’envoi est écrit au journal avec sa règle, sans le texte', async () => {
    const s = await setup({ mode: 'reel' });
    const d = await s.fiche.writeReply(agent, await withReview(s), 'Merci pour votre avis, texte inventé unique.');
    if (!d.ok) throw new Error('refusé');
    expect(await s.fiche.publish(agent, d.value.draftId)).toMatchObject({ code: 'non_valide' });
    const rows = await s.db.all<{ type: string; data: string }>("SELECT type, data FROM journal WHERE type = 'attirer.google.envoi_refuse'");
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]!.data)).toMatchObject({ rule: 'R154', code: 'non_valide', mode: 'reel' });
    expect(JSON.stringify(await s.db.all('SELECT * FROM journal'))).not.toContain('texte inventé unique');
  });

  it('une fiche réglée sur un autre lieu Google reçoit ses informations, même inchangées', async () => {
    const s = await setup({ mode: 'reel' });
    expect(await s.fiche.syncInfo('net-1', 'ag-1')).toMatchObject({ changed: true });
    await s.fiche.setLocation(direction, 'ag-1', { locationRef: 'locations/456', title: 'Camille Exemple, agent immobilier', websiteUri: 'https://camille.exemple.test' });
    expect(await s.fiche.syncInfo('net-1', 'ag-1')).toMatchObject({ changed: true });
    expect(s.client.writes()).toEqual(['info', 'info']);
  });

  it('[R96] l’avis est gardé nettoyé : rien qui désigne son auteur ni un client', async () => {
    const s = await setup();
    await withReview(s, 4, 'Gaspard Quenouille, 12 rue des Lilas, gq@exemple.test, 06 12 34 56 78 : merci à Hortense, super suivi.');
    const stored = (await s.db.first<{ comment: string }>('SELECT comment FROM gbp_reviews'))!.comment;
    expect(stored).not.toMatch(/gaspard|quenouille|lilas|gq@|06 12|hortense/i);
    expect(stored).toContain('super suivi');
  });

  it('une réservation restée sans résultat peut être close par la direction après une heure, puis l’envoi repart', async () => {
    const s = await setup({ mode: 'reel' });
    const d = await s.fiche.draftReply(agent, await withReview(s));
    if (!d.ok) throw new Error('refusé');
    await s.fiche.validate(agent, d.value.draftId);
    // Un envoi coupé après la réservation : la réservation existe, sans résultat.
    await s.db.run("INSERT INTO gbp_claims (id, network_id, draft_id, target, mode, attempt, claimed_by, claimed_at) VALUES ('c-x', 'net-1', ?, ?, 'reel', 1, 'agent:ag-1', ?)", [
      d.value.draftId, `review:${d.value.reviewId}`, s.now().toISOString(),
    ]);
    expect(await s.fiche.publish(agent, d.value.draftId)).toMatchObject({ code: 'deja_parti' });
    expect(await s.fiche.releaseClaim(agent, d.value.draftId)).toMatchObject({ ok: false, rule: 'R16' });
    expect(await s.fiche.releaseClaim(direction, d.value.draftId)).toEqual({ ok: false, rule: null, code: 'occupe' });
    s.advanceDays(1);
    expect(await s.fiche.releaseClaim(direction, d.value.draftId)).toEqual({ ok: true });
    expect(await s.fiche.publish(agent, d.value.draftId)).toEqual({ ok: true, mode: 'reel' });
    expect(s.client.writes()).toHaveLength(1);
    // Une réservation qui a son résultat ne se clôt pas.
    s.advanceDays(1);
    expect(await s.fiche.releaseClaim(direction, d.value.draftId)).toEqual({ ok: false, rule: null, code: 'invalide' });
  });

  it('une panne en mode réel est notée, et le texte peut repartir ensuite', async () => {
    const s = await setup({ mode: 'reel' });
    const d = await s.fiche.draftReply(agent, await withReview(s));
    if (!d.ok) throw new Error('refusé');
    await s.fiche.validate(agent, d.value.draftId);
    s.client.fail = true;
    expect(await s.fiche.publish(agent, d.value.draftId)).toEqual({ ok: false, rule: null, code: 'echec', error: 'panne', action: 'reessayer' });
    s.client.fail = false;
    expect(await s.fiche.publish(agent, d.value.draftId)).toEqual({ ok: true, mode: 'reel' });
    expect(await s.db.all('SELECT outcome FROM gbp_sends ORDER BY rowid')).toEqual([{ outcome: 'echec' }, { outcome: 'envoye' }]);
  });
});

describeWithSqlite('AT14 · ce que l’écran de la fiche Google montre', () => {
  const screen = async (s: Awaited<ReturnType<typeof setup>>, viewer: typeof agent | typeof direction = agent) => {
    const r = await s.fiche.screen(viewer, 'ag-1');
    if (!r.ok) throw new Error(r.code);
    return r.value;
  };

  it('[R16] un agent ne voit que sa fiche, et le refus est écrit au journal ; la direction voit et règle', async () => {
    const s = await setup();
    await withReview(s);
    expect(await s.fiche.screen(otherAgent, 'ag-1')).toEqual({ ok: false, rule: 'R16', code: 'role' });
    const refused = await s.db.all<{ data: string }>("SELECT data FROM journal WHERE type = 'acces.refuse'");
    expect(refused.some((e) => e.data.includes('fiche_google'))).toBe(true);
    expect(await s.fiche.screen({ role: 'agent', userId: 'ag-2', networkId: 'net-1' }, 'ag-2')).toMatchObject({ ok: false, code: 'agent_parti' });
    expect(await s.fiche.screen({ ...direction, networkId: 'net-2' }, 'ag-1')).toMatchObject({ ok: false, code: 'agent_inconnu' });
    expect(await screen(s)).toMatchObject({ agentId: 'ag-1', canConfigure: false, reviewsTotal: 1, reviewsWaiting: 1 });
    expect(await screen(s, direction)).toMatchObject({ canConfigure: true, location: { locationRef: 'locations/123' } });
    // Le nom de l'auteur n'est jamais gardé, ni montré.
    expect(JSON.stringify(await screen(s))).not.toContain('Gaspard');
    expect(await s.fiche.readReviews(otherAgent, 'ag-1')).toMatchObject({ ok: false, code: 'role' });
    expect(await s.fiche.preparePost(otherAgent, 'ag-1')).toMatchObject({ ok: false, code: 'role' });
    s.client.calls.length = 0;
    expect(await s.fiche.readReviews(otherAgent, 'ag-1')).toMatchObject({ ok: false });
    expect(s.client.calls).toEqual([]);
  });

  it('sans Google branché (H07), l’écran répond sans erreur et le dit ; la lecture répond « pas de service »', async () => {
    const s = await setup();
    const sans = new FicheGoogle(s.db, s.journal, { now: s.now });
    expect(await sans.screen(agent, 'ag-1')).toMatchObject({ ok: true, value: { connected: false, mode: 'essai', reviews: [], publications: [], reviewsTotal: 0, reviewsWaiting: 0 } });
    expect(await sans.readReviews(agent, 'ag-1')).toEqual({ ok: false, rule: null, code: 'sans_service' });
    expect((await screen(s)).connected).toBe(true);
  });

  it('[R154] [R26] en essai, le texte passe de « à valider » à « noté », et Google n’est jamais appelé pour écrire', async () => {
    const s = await setup();
    const id = await withReview(s);
    expect((await screen(s)).reviews[0]!.draft).toBeNull();
    const draft = await s.fiche.draftReply(agent, id);
    if (!draft.ok) throw new Error(draft.code);
    const first = (await screen(s)).reviews[0]!.draft!;
    expect(first).toMatchObject({ draftId: draft.value.draftId, body: draft.value.body, state: 'a_valider', validatedAt: null });
    expect(await s.fiche.publish(agent, first.draftId)).toMatchObject({ ok: false, code: 'non_valide' });
    await s.fiche.validate(agent, first.draftId);
    expect((await screen(s)).reviews[0]!.draft).toMatchObject({ state: 'a_envoyer' });
    expect((await screen(s)).reviewsWaiting).toBe(1);
    expect(await s.fiche.publish(agent, first.draftId)).toEqual({ ok: true, mode: 'essai' });
    const after = await screen(s);
    expect(after.reviews[0]!.draft).toMatchObject({ draftId: first.draftId, state: 'note_essai' });
    expect(after.reviewsWaiting).toBe(0);
    expect(s.client.writes()).toEqual([]);
  });

  it('[R154] un texte corrigé est un nouveau texte à relire ; le texte parti reste celui qu’on montre', async () => {
    const s = await setup();
    const id = await withReview(s);
    const a = await s.fiche.draftReply(agent, id);
    if (!a.ok) throw new Error(a.code);
    await s.fiche.validate(agent, a.value.draftId);
    const b = await s.fiche.writeReply(agent, id, 'Merci beaucoup pour votre confiance.');
    if (!b.ok) throw new Error(b.code);
    expect((await screen(s)).reviews[0]!.draft).toMatchObject({ draftId: b.value.draftId, body: 'Merci beaucoup pour votre confiance.', state: 'a_valider', validatedAt: null });
    // L'ancienne validation ne vaut pas pour le nouveau texte.
    expect(await s.fiche.publish(agent, a.value.draftId)).toMatchObject({ ok: false, code: 'texte_change' });
    await s.fiche.validate(agent, b.value.draftId);
    await s.fiche.publish(agent, b.value.draftId);
    await s.fiche.writeReply(agent, id, 'Un autre merci, sans suite.');
    expect((await screen(s)).reviews[0]!.draft).toMatchObject({ draftId: b.value.draftId, state: 'note_essai' });
  });

  it('un vrai envoi : parti, en échec puis réessayable, en cours, coupé, puis clos par la direction', async () => {
    const s = await setup({ mode: 'reel' });
    const id = await withReview(s);
    const d = await s.fiche.draftReply(agent, id);
    if (!d.ok) throw new Error(d.code);
    await s.fiche.validate(agent, d.value.draftId);
    s.client.fail = true;
    expect(await s.fiche.publish(agent, d.value.draftId)).toMatchObject({ ok: false, code: 'echec' });
    expect((await screen(s)).reviews[0]!.draft!.state).toBe('echec');
    expect((await screen(s)).reviewsWaiting).toBe(1);
    // Une coupure entre la réservation et la réponse de Google.
    await s.db.run("INSERT INTO gbp_claims (id, network_id, draft_id, target, mode, attempt, claimed_by, claimed_at) VALUES ('cut', 'net-1', ?, ?, 'reel', 2, 'agent:ag-1', ?)", [d.value.draftId, `review:${id}`, s.now().toISOString()]);
    expect((await screen(s)).reviews[0]!.draft!.state).toBe('envoi_en_cours');
    s.advanceDays(1);
    expect((await screen(s)).reviews[0]!.draft!.state).toBe('envoi_coupe');
    expect(await s.fiche.releaseClaim(agent, d.value.draftId)).toMatchObject({ ok: false, code: 'role' });
    expect(await s.fiche.releaseClaim(direction, d.value.draftId)).toEqual({ ok: true });
    expect((await screen(s)).reviews[0]!.draft!.state).toBe('echec');
    s.client.fail = false;
    expect(await s.fiche.publish(agent, d.value.draftId)).toEqual({ ok: true, mode: 'reel' });
    expect((await screen(s)).reviews[0]!.draft!.state).toBe('envoye');
    expect((await screen(s)).reviewsWaiting).toBe(0);
  });

  it('[R154] [R42] une publication préparée depuis l’écran : sans prix, à valider, et « retirée » quand le bien ne peut plus être diffusé', async () => {
    const s = await setup();
    expect((await screen(s)).publications).toEqual([]);
    expect(await s.fiche.preparePost(agent, 'ag-1')).toEqual({ ok: true, value: null });
    await listing(s.db, 'b1', 1, 'en_vente', 'Maison lumineuse avec jardin');
    const p = await s.fiche.preparePost(agent, 'ag-1');
    if (!p.ok || !p.value) throw new Error('rien de préparé');
    const shown = (await screen(s)).publications;
    expect(shown).toHaveLength(1);
    expect(shown[0]).toMatchObject({ draftId: p.value.draftId, state: 'a_valider', origin: 'code', linkUri: 'https://camille.exemple.test/biens/b1' });
    expect(shown[0]!.body).not.toContain('250');
    // Au plus une par période, même demandée de nouveau.
    expect(await s.fiche.preparePost(agent, 'ag-1')).toEqual({ ok: true, value: null });
    s.noMandate.add('b1');
    expect((await screen(s)).publications[0]!.state).toBe('bien_retire');
    s.noMandate.delete('b1');
    await listing(s.db, 'b1', 2, 'en_vente', 'Maison lumineuse, nouvelle annonce');
    expect((await screen(s)).publications[0]!.state).toBe('bien_retire');
    // Le texte d'une version plus récente remplace l'ancien : un seul texte par bien à l'écran.
    s.advanceDays(8);
    const q = await s.fiche.preparePost(agent, 'ag-1');
    if (!q.ok || !q.value) throw new Error('rien de préparé');
    expect((await screen(s)).publications.map((x) => [x.draftId, x.state])).toEqual([[q.value.draftId, 'a_valider']]);
  });

  it('[R154] une publication devenue refusée ne garde aucun geste mort : son état le dit, et une nouvelle annonce la remplace', async () => {
    const s = await setup();
    await listing(s.db, 'b1', 1, 'en_vente', 'Maison lumineuse avec verger');
    const p = await s.fiche.preparePost(agent, 'ag-1');
    if (!p.ok || !p.value) throw new Error('rien de préparé');
    await s.db.run("INSERT INTO persons (id, network_id, agent_id, first_name, last_name, created_at, updated_at) VALUES ('p-2', 'net-1', 'ag-1', 'Ondine', 'Verger', 'x', 'x')");
    expect((await screen(s)).publications[0]!.state).toBe('texte_a_revoir');
    expect(await s.fiche.validate(agent, p.value.draftId)).toMatchObject({ ok: false, code: 'texte_refuse' });
    await listing(s.db, 'b1', 2, 'en_vente', 'Maison lumineuse avec terrasse');
    s.advanceDays(8);
    const q = await s.fiche.preparePost(agent, 'ag-1');
    if (!q.ok || !q.value) throw new Error('rien de préparé');
    expect((await screen(s)).publications.map((x) => [x.draftId, x.state])).toEqual([[q.value.draftId, 'a_valider']]);
  });

  it('une fiche non réglée n’empêche pas l’écran, et préparer le dit', async () => {
    const s = await setup();
    await s.db.run("INSERT INTO agents (id, network_id, first_name, last_name, created_at, updated_at) VALUES ('ag-4', 'net-1', 'Inès', 'Neuve', 'x', 'x')");
    const ines = { role: 'agent' as const, userId: 'ag-4', networkId: 'net-1' };
    expect(await s.fiche.screen(ines, 'ag-4')).toMatchObject({ ok: true, value: { location: null, agentFirstName: 'Inès' } });
    expect(await s.fiche.preparePost(ines, 'ag-4')).toMatchObject({ ok: false, code: 'sans_fiche' });
    expect(await s.fiche.readReviews(ines, 'ag-4')).toMatchObject({ ok: false, code: 'sans_fiche' });
  });

  it('l’écran ne montre que les 50 avis les plus récents, et compte les autres', async () => {
    const s = await setup();
    s.client.reviewsToGive = Array.from({ length: 52 }, (_, i) => ({ reviewRef: `reviews/r${i}`, rating: 5, comment: null, authorName: null, reviewedAt: new Date(Date.UTC(2026, 0, i + 1)).toISOString() }));
    expect(await s.fiche.readReviews(agent, 'ag-1')).toEqual({ ok: true, added: 52 });
    const v = await screen(s);
    expect(v.reviews).toHaveLength(50);
    expect(v.reviewsTotal).toBe(52);
    expect(v.reviewsWaiting).toBe(52);
    expect(v.reviews[0]!.reviewedAt).toBe(new Date(Date.UTC(2026, 0, 52)).toISOString());
  });
});

describeWithSqlite('AU037 · l’accusé réel de Google et l’échec qui dit quoi faire', () => {
  const view = async (s: Awaited<ReturnType<typeof setup>>, viewer: typeof agent | typeof direction = agent) => {
    const r = await s.fiche.screen(viewer, 'ag-1');
    if (!r.ok) throw new Error(r.code);
    return r.value;
  };
  const validReply = async (s: Awaited<ReturnType<typeof setup>>) => {
    const id = await withReview(s);
    const d = await s.fiche.draftReply(agent, id);
    if (!d.ok) throw new Error(d.code);
    await s.fiche.validate(agent, d.value.draftId);
    return d.value.draftId;
  };
  const validPost = async (s: Awaited<ReturnType<typeof setup>>) => {
    await listing(s.db, 'b1', 1, 'en_vente', 'Maison lumineuse avec jardin');
    const p = await s.fiche.duePost('net-1', 'ag-1');
    if (!p.ok || !p.value) throw new Error('rien de préparé');
    await s.fiche.validate(agent, p.value.draftId);
    return p.value.draftId;
  };

  it('le constat : une fiche réglée avec sa référence complète chez Google est acceptée, l’ancienne aussi', async () => {
    const s = await setup({ mode: 'reel' });
    expect(await s.fiche.setLocation(direction, 'ag-1', { locationRef: 'accounts/7/locations/42', title: 'Camille Exemple, agent immobilier', websiteUri: 'https://camille.exemple.test' })).toEqual({ ok: true });
    expect((await view(s)).location).toMatchObject({ locationRef: 'accounts/7/locations/42' });
    expect(await s.fiche.setLocation(direction, 'ag-1', { locationRef: 'accounts/x/locations/42', title: 'Camille Exemple', websiteUri: 'https://camille.exemple.test' })).toMatchObject({ ok: false, code: 'invalide' });
  });

  it('[R154] une réponse partie pour de vrai remonte l’accusé de Google, gardé à côté de l’envoi et montré à l’écran', async () => {
    const s = await setup({ mode: 'reel' });
    const draftId = await validReply(s);
    expect(await s.fiche.publish(agent, draftId)).toEqual({ ok: true, mode: 'reel' });
    expect(await s.db.all('SELECT r.ack_ref, r.url, r.error_code, r.action FROM gbp_receipts r JOIN gbp_sends s ON s.id = r.send_id WHERE s.draft_id = ?', [draftId])).toEqual([
      { ack_ref: 'accounts/1/locations/123/reviews/r1/reply', url: null, error_code: null, action: null },
    ]);
    const v = await view(s);
    expect(v.reviews[0]!.draft).toMatchObject({ state: 'envoye', ackRef: 'accounts/1/locations/123/reviews/r1/reply', error: null, action: null });
    expect(v.link).toEqual({ state: 'pret', action: null, info: null });
  });

  it('une publication partie garde sa référence et son lien public chez Google', async () => {
    const s = await setup({ mode: 'reel' });
    const draftId = await validPost(s);
    expect(await s.fiche.publish(agent, draftId)).toEqual({ ok: true, mode: 'reel' });
    expect((await view(s)).publications[0]).toMatchObject({ state: 'envoye', ackRef: 'locations/123/localPosts/p1', url: 'https://local.google.test/post/1' });
  });

  it('une connexion refusée par Google devient « reconnecter » : dit par l’envoi, gardé, et montré sur la fiche jusqu’au retour', async () => {
    const s = await setup({ mode: 'reel' });
    const draftId = await validReply(s);
    s.client.error = new GbpError('connexion');
    expect(await s.fiche.publish(agent, draftId)).toEqual({ ok: false, rule: null, code: 'echec', error: 'connexion', action: 'reconnecter' });
    const v = await view(s);
    expect(v.link).toMatchObject({ state: 'a_reconnecter', action: 'reconnecter' });
    expect(v.reviews[0]!.draft).toMatchObject({ state: 'echec', error: 'connexion', action: 'reconnecter', ackRef: null });
    // Le journal garde le code et le geste, jamais le texte de Google ni celui de la réponse [R13].
    const events = await s.db.all<{ data: string }>("SELECT data FROM journal WHERE type = 'attirer.google.envoi'");
    expect(events.map((e) => JSON.parse(e.data))).toContainEqual(expect.objectContaining({ outcome: 'echec', error: 'connexion', action: 'reconnecter' }));
    expect(JSON.stringify(events)).not.toContain('fiche Google : connexion');
    // Le compte reconnecté : le texte repart, et la fiche redevient prête.
    s.client.error = null;
    expect(await s.fiche.publish(agent, draftId)).toEqual({ ok: true, mode: 'reel' });
    expect((await view(s)).link.state).toBe('pret');
    expect((await view(s)).reviews[0]!.draft).toMatchObject({ state: 'envoye', error: null, action: null });
  });

  it('une mise à jour autorisée de la fiche remonte son accusé réel ; un refus de droits demande de la relier', async () => {
    const s = await setup({ mode: 'reel' });
    expect(await s.fiche.sendInfo(agent, 'ag-1')).toEqual({ ok: false, rule: 'R16', code: 'role' });
    expect(await s.fiche.sendInfo({ ...direction, networkId: 'net-2' }, 'ag-1')).toMatchObject({ ok: false, rule: 'R16' });
    expect(s.client.writes()).toEqual([]);
    expect(await s.fiche.sendInfo(direction, 'ag-1')).toEqual({ ok: true, changed: true, mode: 'reel' });
    expect((await view(s, direction)).link.info).toMatchObject({ ackRef: 'locations/123', error: null, action: null });
    expect(await s.fiche.sendInfo(direction, 'ag-1')).toEqual({ ok: true, changed: false, mode: 'reel' });
    await s.fiche.setLocation(direction, 'ag-1', { locationRef: 'accounts/7/locations/42', title: 'Camille Exemple, agent immobilier', websiteUri: 'https://camille.exemple.test' });
    s.client.error = new GbpError('droits');
    expect(await s.fiche.sendInfo(direction, 'ag-1')).toEqual({ ok: false, rule: null, code: 'echec', error: 'droits', action: 'relier' });
    const v = await view(s, direction);
    expect(v.link).toMatchObject({ state: 'a_relier', action: 'relier', info: { ackRef: null, error: 'droits', action: 'relier' } });
  });

  it('une publication dont la réponse de Google s’est perdue n’est ni dite partie ni refaite : à vérifier', async () => {
    const s = await setup({ mode: 'reel' });
    const draftId = await validPost(s);
    s.client.ack = { state: 'LIVE' };
    expect(await s.fiche.publish(agent, draftId)).toEqual({ ok: false, rule: null, code: 'a_verifier', action: 'verifier' });
    expect(await s.db.all('SELECT id FROM gbp_sends')).toEqual([]);
    expect((await view(s)).publications[0]!.state).toBe('envoi_en_cours');
    s.client.ack = undefined;
    expect(await s.fiche.publish(agent, draftId)).toMatchObject({ ok: false, code: 'deja_parti' });
    expect(s.client.writes().filter((c) => c.startsWith('post:'))).toHaveLength(1);
  });

  it('une réponse à un avis sans accusé est un échec « à vérifier », qui peut repartir : elle remplace la précédente chez Google', async () => {
    const s = await setup({ mode: 'reel' });
    const draftId = await validReply(s);
    s.client.ack = { ref: '' };
    expect(await s.fiche.publish(agent, draftId)).toEqual({ ok: false, rule: null, code: 'echec', error: 'accuse_absent', action: 'verifier' });
    s.client.ack = undefined;
    s.client.error = new GbpError('incertain');
    expect(await s.fiche.publish(agent, draftId)).toEqual({ ok: false, rule: null, code: 'echec', error: 'panne', action: 'reessayer' });
    s.client.error = null;
    expect(await s.fiche.publish(agent, draftId)).toEqual({ ok: true, mode: 'reel' });
  });

  it('un texte refusé par Google demande de le corriger ; la lecture des avis dit aussi son geste', async () => {
    const s = await setup({ mode: 'reel' });
    const draftId = await validReply(s);
    s.client.error = new GbpError('refuse_google');
    expect(await s.fiche.publish(agent, draftId)).toMatchObject({ error: 'refuse_google', action: 'corriger' });
    s.client.error = new GbpError('connexion');
    expect(await s.fiche.importReviews('net-1', 'ag-1')).toEqual({ ok: false, rule: null, code: 'echec', error: 'connexion', action: 'reconnecter' });
  });

  it('[R26] en essai, aucun accusé ni échec n’est gardé, et la fiche dit qu’elle est en essai', async () => {
    const s = await setup();
    const draftId = await validReply(s);
    s.client.error = new GbpError('connexion');
    expect(await s.fiche.publish(agent, draftId)).toEqual({ ok: true, mode: 'essai' });
    expect(await s.fiche.sendInfo(direction, 'ag-1')).toEqual({ ok: true, changed: true, mode: 'essai' });
    expect(await s.db.all('SELECT * FROM gbp_receipts')).toEqual([]);
    expect((await view(s)).link).toEqual({ state: 'essai', action: null, info: null });
  });

  it('[R17] un accusé ne change plus et ne s’efface pas ; un envoi réussi sans référence est refusé par la base', async () => {
    const s = await setup({ mode: 'reel' });
    await s.fiche.publish(agent, await validReply(s));
    await expect(s.db.run("UPDATE gbp_receipts SET ack_ref = 'autre/ref'")).rejects.toThrow();
    await expect(s.db.run('DELETE FROM gbp_receipts')).rejects.toThrow();
    const send = (await s.db.first<{ id: string }>('SELECT id FROM gbp_sends'))!.id;
    await s.db.run("INSERT INTO gbp_sends (id, network_id, agent_id, draft_id, kind, info_sha256, mode, outcome, sent_by, sent_at) VALUES ('s2', 'net-1', 'ag-1', NULL, 'informations', 'h', 'reel', 'envoye', 'system:fiche_google', 'x')");
    await expect(s.db.run("INSERT INTO gbp_receipts (send_id, ack_ref, url, error_code, action, done_at) VALUES ('s2', NULL, NULL, NULL, NULL, 'x')")).rejects.toThrow();
    await expect(s.db.run("INSERT INTO gbp_receipts (send_id, ack_ref, url, error_code, action, done_at) VALUES ('s2', NULL, NULL, 'inventee', 'reessayer', 'x')")).rejects.toThrow();
    await expect(s.db.run("INSERT INTO gbp_receipts (send_id, ack_ref, url, error_code, action, done_at) VALUES ('s2', 'ref/ok', 'http://non.test', NULL, NULL, 'x')")).rejects.toThrow();
    expect(send).toBeTruthy();
  });
});
