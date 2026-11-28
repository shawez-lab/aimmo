import { expect, it } from 'vitest';
import { DemandesAvis, REVIEW_PURPOSE, RelancesApresVente, Satisfaction, reviewText, type ClosedSale } from '../src/apres-vente/index.ts';
import { checkText } from '../src/envoi/texte.ts';
import { setupAnnonce } from './annonces-jeu.ts';
import { FakeDossiersClos } from './apres-vente-jeu.ts';
import { enClair, tablesContenant } from './boite-essai.ts';
import { MASKED_SECRET } from '../src/envoi/controle.ts';
import { describeWithSqlite } from './sqlite.ts';

const LINK = 'https://g.page/r/CexempleAgent42/review';
const BASE = 'https://aimmo.example.test/satisfaction/';
// Mars 2027, avant le passage à l'heure d'été : Paris = UTC+1.
const paris = (day: string, hour: number, minute = 0) => new Date(`${day}T${String(hour - 1).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00.000Z`);

it('[R64] [R10] le lien de satisfaction s’ajoute à la demande d’avis, sans rien promettre, et le texte passe le contrôle', () => {
  const text = reviewText('Léa', 'vendeur', { city: 'Dijon' }, LINK, `${BASE}bcdefghijklmnopqrstuvwxyzabcdefg`);
  expect(text).toContain(`sans rien publier : ${BASE}bcdefghijklmnopqrstuvwxyzabcdefg Merci !`);
  // Les seuls chiffres du texte sont ceux de ses liens : plus de référence interne (DS053).
  expect(checkText(text, { audience: 'client', channel: 'email', figures: [LINK] })).toEqual([]);
  // Sans adresse réglée, le texte de F02 ne change pas.
  expect(reviewText('Léa', 'vendeur', { city: 'Dijon' }, LINK)).not.toContain('publier');
});

describeWithSqlite('F05 · satisfaction : note et commentaire rangés pour M13', () => {
  let n = 0;
  async function setup() {
    const t = await setupAnnonce();
    const dossiers = new FakeDossiersClos();
    const avis = new DemandesAvis(t.db, t.journal, dossiers, { now: t.now, satisfactionBase: BASE });
    const satisfaction = new Satisfaction(t.db, t.journal, { now: t.now });
    const client = async (firstName: string) => {
      n += 1;
      const p = await t.store.createPerson({ networkId: t.network.id, agentId: t.alexId, firstName, lastName: 'Exemple' });
      await t.store.addIdentifier({ networkId: t.network.id, personId: p.id, kind: 'email', value: `sat${n}@example.test` });
      await t.store.addConsent({ networkId: t.network.id, personId: p.id, purpose: REVIEW_PURPOSE, channel: 'email', proof: 'mandat', givenAt: new Date('2027-02-10T09:00:00.000Z') });
      return p.id;
    };
    const close = (fileId: string, closedOn: string, clients: ClosedSale['clients']) => dossiers.sales.push({ fileId, agentId: t.alexId, closedOn, city: 'Dijon', reference: `REF-${fileId}`, clients });
    // Le lien de satisfaction est rangé masqué : le client le lit dans ce que la boîte d'essai a reçu [HX61, RC16].
    const inbox = (personId: string) => enClair(t.db.all<{ id: string; body: string }>('SELECT m.id, m.body FROM messages m JOIN trial_outbox o ON o.message_id = m.id WHERE m.person_id = ? ORDER BY m.occurred_at', [personId]));
    const tokenOf = async (personId: string, i = 0) => {
      const body = (await inbox(personId))[i]!.body;
      const at = body.indexOf(BASE) + BASE.length;
      return body.slice(at, at + 32);
    };
    t.setClock(paris('2027-03-01', 9));
    const r = await avis.setReviewLink(t.agent, t.alexId, LINK);
    if (!r.ok) throw new Error(r.code);
    return { ...t, dossiers, avis, satisfaction, client, close, inbox, tokenOf };
  }

  it('[R13] le client donne une note et un commentaire, une seule fois ; l’agent les voit, le journal ne garde que la note', async () => {
    const t = await setup();
    const a = await t.client('Ana');
    t.close('f1', '2027-03-08', [{ personId: a, side: 'vendeur' }]);
    t.setClock(paris('2027-03-09', 10, 5));
    expect(await t.avis.run(t.network.id)).toBe(1);
    const token = await t.tokenOf(a);
    expect(token).toMatch(/^[a-z]{32}$/);
    // Rangé masqué : l'agent qui lit la fiche ne peut pas noter à la place du client [HX61, RC16].
    const rangé = await t.db.first<{ body: string }>("SELECT body FROM messages WHERE person_id = ? AND direction = 'out'", [a]);
    expect(rangé!.body).toContain(MASKED_SECRET.lien);
    expect(await tablesContenant(t.db, token)).toEqual([]);
    t.setClock(paris('2027-03-10', 20));
    expect(await t.satisfaction.submit(token, { score: 4, comment: '  Très à l’écoute, merci Alex.  ' })).toEqual({ ok: true });
    // Le lien ne sert qu'une fois.
    expect(await t.satisfaction.submit(token, { score: 1, comment: 'autre' })).toEqual({ ok: false, code: 'used' });
    const list = await t.satisfaction.list(t.agent);
    expect(list.ok && list.value).toEqual([{ fileId: 'f1', personId: a, score: 4, comment: 'Très à l’écoute, merci Alex.', answeredAt: paris('2027-03-10', 20).toISOString() }]);
    const events = await t.journal.bySubject('sale_file:f1');
    const sat = events.filter((e) => e.type === 'apres_vente.satisfaction');
    expect(sat).toHaveLength(1);
    expect(JSON.stringify(events)).not.toMatch(/écoute|Alex|example\.test/);
    expect(JSON.stringify(sat)).not.toContain(token);
    // Une réponse ne s'efface ni ne change.
    await expect(t.db.run('DELETE FROM satisfaction_answers')).rejects.toThrow();
    await expect(t.db.run('UPDATE satisfaction_answers SET score = 5')).rejects.toThrow();
  });

  it('un lien inconnu, expiré, ou une réponse mal formée sont refusés sans rien ranger', async () => {
    const t = await setup();
    const a = await t.client('Ana');
    t.close('f1', '2027-03-08', [{ personId: a, side: 'vendeur' }]);
    t.setClock(paris('2027-03-09', 10, 5));
    await t.avis.run(t.network.id);
    const token = await t.tokenOf(a);
    expect(await t.satisfaction.submit('bcdefghijklmnopqrstuvwxyzabcdefg', { score: 3 })).toEqual({ ok: false, code: 'unknown' });
    expect(await t.satisfaction.submit('pas un jeton', { score: 3 })).toEqual({ ok: false, code: 'unknown' });
    for (const score of [0, 6, 2.5, Number.NaN]) expect(await t.satisfaction.submit(token, { score })).toEqual({ ok: false, code: 'invalid_score' });
    expect(await t.satisfaction.submit(token, { score: 3, comment: 'x'.repeat(1001) })).toEqual({ ok: false, code: 'invalid_comment' });
    for (const comment of ['\u0000', 'bien\u0007', '\u007f']) expect(await t.satisfaction.submit(token, { score: 3, comment })).toEqual({ ok: false, code: 'invalid_comment' });
    // Une réponse refusée ne consomme pas le lien : le client peut réessayer, puis le lien sert une fois.
    t.setClock(paris('2027-03-10', 12));
    expect(await t.satisfaction.submit(token, { score: 3, comment: 'Ligne un\nLigne deux' })).toEqual({ ok: true });
    expect(await t.satisfaction.submit(token, { score: 3 })).toEqual({ ok: false, code: 'used' });
    const list = await t.satisfaction.list(t.direction);
    expect(list.ok && list.value.map((r) => r.comment)).toEqual(['Ligne un\nLigne deux']);
  });

  it('trente jours après la demande, le lien a expiré', async () => {
    const t = await setup();
    const a = await t.client('Ana');
    t.close('f1', '2027-03-08', [{ personId: a, side: 'vendeur' }]);
    t.setClock(paris('2027-03-09', 10, 5));
    await t.avis.run(t.network.id);
    const token = await t.tokenOf(a);
    t.setClock(new Date(paris('2027-03-09', 10, 5).getTime() + 30 * 86_400_000));
    expect(await t.satisfaction.submit(token, { score: 3 })).toEqual({ ok: false, code: 'expired' });
    const list = await t.satisfaction.list(t.direction);
    expect(list.ok && list.value).toEqual([]);
  });

  it('[R64] la note ne trie ni ne bloque aucune demande d’avis, et le commentaire n’est jamais envoyé ni publié', async () => {
    const t = await setup();
    const a = await t.client('Ana');
    t.close('f1', '2027-03-08', [{ personId: a, side: 'vendeur' }]);
    t.setClock(paris('2027-03-09', 10, 5));
    await t.avis.run(t.network.id);
    // La pire note, avec un commentaire.
    expect(await t.satisfaction.submit(await t.tokenOf(a), { score: 1, comment: 'Déçue par le suivi.' })).toEqual({ ok: true });
    // Un nouveau dossier du même client : sa demande d'avis part quand même.
    t.close('f2', '2027-04-05', [{ personId: a, side: 'acquereur' }]);
    t.setClock(paris('2027-04-06', 10, 5));
    expect(await t.avis.run(t.network.id)).toBe(1);
    const box = await t.inbox(a);
    expect(box).toHaveLength(2);
    // Le commentaire n'apparaît dans aucun message, d'aucune personne.
    const all = await t.db.all<{ body: string }>('SELECT body FROM messages');
    expect(all.some((m) => m.body.includes('Déçue'))).toBe(false);
    const sent = await t.avis.list(t.agent);
    expect(sent.ok && sent.value.every((r) => r.status === 'sent')).toBe(true);
  });

  it('[R16] un agent ne voit que les réponses de ses dossiers', async () => {
    const t = await setup();
    const a = await t.client('Ana');
    t.close('f1', '2027-03-08', [{ personId: a, side: 'vendeur' }]);
    t.setClock(paris('2027-03-09', 10, 5));
    await t.avis.run(t.network.id);
    await t.satisfaction.submit(await t.tokenOf(a), { score: 5 });
    const sam = await t.satisfaction.list(t.sam);
    expect(sam.ok && sam.value).toEqual([]);
    const direction = await t.satisfaction.list(t.direction);
    expect(direction.ok && direction.value.map((r) => [r.score, r.comment])).toEqual([[5, null]]);
    expect(await t.satisfaction.list({ role: 'partner', networkId: t.network.id, userId: 'p-1' })).toEqual({ ok: false, rule: 'R16', code: 'role' });
  });

  it('[R16] un agent parti du réseau n’ouvre plus rien après la vente : réponses, demandes, tâches, relances, choix', async () => {
    const t = await setup();
    const a = await t.client('Ana');
    t.close('f1', '2027-03-08', [{ personId: a, side: 'vendeur' }]);
    t.setClock(paris('2027-03-09', 10, 5));
    await t.avis.run(t.network.id);
    await t.satisfaction.submit(await t.tokenOf(a), { score: 5, comment: 'Parfait.' });
    await t.db.run("UPDATE agents SET status = 'left' WHERE id = ?", [t.alexId]);
    const refused = { ok: false, rule: 'R16', code: 'agent_inactive' };
    const relances = new RelancesApresVente(t.db, t.journal, t.dossiers, { now: t.now });
    expect(await t.satisfaction.list(t.agent)).toEqual(refused);
    expect(await t.avis.list(t.agent)).toEqual(refused);
    expect(await t.avis.openTasks(t.agent)).toEqual(refused);
    expect(await t.avis.setReviewLink(t.agent, t.alexId, LINK)).toEqual(refused);
    expect(await relances.list(t.agent)).toEqual(refused);
    expect(await relances.recordChoice(t.agent, 'f1', a, { choice: 'non', proof: 'appel, test' })).toEqual(refused);
    // Chaque refus est au journal.
    const refusals = (await t.journal.all()).filter((e) => e.type === 'acces.refuse' && JSON.stringify(e.data).includes('agent_inactive'));
    expect(refusals).toHaveLength(6);
    // La direction lit toujours les réponses du réseau.
    const direction = await t.satisfaction.list(t.direction);
    expect(direction.ok && direction.value).toHaveLength(1);
  });
});
