import { expect, it } from 'vitest';
import { checkText, createCaptation, dossiers as m10, maskIban, maskPayload } from '@aimmo/core';
import { handleRequest } from '../src/app.ts';
import { sha256Hex } from '../src/index.ts';
import { runScheduler } from '../src/planificateur.ts';
import { setupDossier } from '../../core/test/dossiers-jeu.ts';
import { describeWithSqlite } from '../../core/test/sqlite.ts';
import { expectLinear } from '../../core/test/lineaire.ts';

// Réseau, bien, clients, IBAN et clés inventés. L'IBAN est celui des exemples publics, il ne mène à aucun compte.
const BASE = 'https://aimmo-api.example.test';
const IBAN = 'FR76 3000 6000 0112 3456 7890 189';
const KEYS = { alex: 'test-cle-n09-alex-aaaaaaaaaaaaaaaaaaaaaaaaaaaaa', sam: 'test-cle-n09-sam-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' };
type Who = keyof typeof KEYS;

async function setup(withPieces = true) {
  const t = await setupDossier('appartement');
  const ids: Record<Who, { role: string; userId: string }> = { alex: { role: 'agent', userId: t.alexId }, sam: { role: 'agent', userId: t.sam.userId } };
  const apiKeys = JSON.stringify(await Promise.all((Object.keys(KEYS) as Who[]).map(async (w) => ({ sha256: await sha256Hex(KEYS[w]), networkId: t.network.id, ...ids[w] }))));
  const call = async (who: Who | null, method: string, path: string, body?: unknown) => {
    const headers: Record<string, string> = who ? { authorization: `Bearer ${KEYS[who]}` } : {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    const r = await handleRequest(new Request(`${BASE}${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), {
      db: t.db,
      apiKeys,
      mode: 'essai',
      now: t.now,
      ...(withPieces ? { pieces: t.storage } : {}),
    });
    return { status: r.status, body: (await r.json()) as { ok: boolean; data?: any; rule?: string; code?: string } };
  };
  return { ...t, call };
}

it('[R62] le contrôle du texte refuse tout message à un client qui porte un IBAN ou demande de payer', () => {
  const ctx = { audience: 'client' as const, channel: 'email' as const };
  expect(checkText(`Bonjour Léa, voici notre IBAN ${IBAN}.`, ctx).map((p) => p.rule)).toContain('R62');
  expect(checkText('Bonjour Léa, notre RIB est en pièce jointe.', ctx).map((p) => p.rule)).toContain('R62');
  for (const text of ['Bonjour Léa, merci de payer les frais au notaire.', 'Bonjour Léa, versez la somme avant vendredi.', 'Bonjour Léa, il faut régler 2 000 € d’acompte.', 'Bonjour Léa, merci d’effectuer le virement demain.']) {
    expect([text, checkText(text, ctx).map((p) => p.rule)]).toEqual([text, expect.arrayContaining(['R62'])]);
  }
  // Une dictée ou un avis de visiteur ne demande rien : il passe [R62 ne bloque que les coordonnées bancaires].
  for (const text of [
    'Bonjour Léa, réserves : il faut effectuer des travaux dans la salle de bain.',
    'Bonjour Léa, avis du visiteur : il faut régler la question du parking.',
    'Bonjour Léa, réserves : le paiement des charges de copropriété semble élevé.',
    'Bonjour Léa, retrouvez le bien sur le compte Instagram de l’agence.',
    'Bonjour Léa, il faut régler le rendez-vous du 3 juin avec le notaire.',
  ]) {
    expect([text, checkText(text, ctx).map((p) => p.rule)]).not.toEqual([text, expect.arrayContaining(['R62'])]);
  }
  // Les textes écrits par le code de M10 gardent la liste complète.
  expect(m10.fundsInOutgoing('Bonjour Léa, merci de régler la somme convenue sur le compte indiqué.')).toBe(true);
  expect(checkText('Bonjour Léa, votre dossier avance, le notaire vous écrira.', ctx).map((p) => p.rule)).not.toContain('R62');
  expect(checkText('[IBAN masqué]', ctx).map((p) => p.rule)).toContain('R62');
});

it('[R15] un IBAN reçu est masqué, même coupé par des espaces ; le bouclier lit encore le masque', () => {
  expect(maskIban(`Mon RIB : ${IBAN}, merci.`)).toBe('Mon RIB : [IBAN masqué], merci.');
  expect(maskIban('Rien de bancaire ici.')).toBe('Rien de bancaire ici.');
  for (const written of ['FR76 3000 6000 0112 3456\n7890 189', 'FR76 3000 6000 0112  3456 7890 189', 'FR76-3000-6000-0112-3456-7890-189', 'FR76 30006 00001 12345678901 89', 'FR7630006000011234567890189', '30006 00001 12345678901 89', 'GB82 WEST 1234 5698 7654 32', 'GB82WEST12345698765432']) {
    expect([written, maskIban(`${written} POUR VOUS`)]).toEqual([written, '[IBAN masqué] POUR VOUS']);
    expect([written, maskIban(`Voici : ${written} merci beaucoup`)]).toEqual([written, 'Voici : [IBAN masqué] merci beaucoup']);
  }
  // Rien d'autre n'est masqué : téléphone, code postal, référence, surface.
  expect(m10.fundSignals('GB82 WEST 1234 5698 7654 32')).toContain('iban');
  // Un contenu illisible en JSON : les textes sont masqués avant d'être réécrits, retours à la ligne compris.
  const payload = maskPayload(JSON.stringify({ text: 'FR76\n3000\n6000\n0112\n3456\n7890\n189', id: 7 }));
  expect(payload).toBe(JSON.stringify({ text: '[IBAN masqué]', id: 7 }));
  expect(maskPayload(`brut ${IBAN} fin`)).toBe('brut [IBAN masqué] fin');
  // Un texte reçu piégé ne fait pas s'emballer la recherche.
  expectLinear((n) => `FR76${'1'.repeat(30)}abcdefghijklmnop ${'FR76 1 '.repeat(n / 7)}`, maskIban, 14_000);
  for (const plainText of ['Appelez-moi au 06 12 34 56 78.', 'Le lot ab12 avec cela pour vous, merci.', 'Référence 3f2a4b1c-9d8e-4f7a-b6c5-1234567890ab enregistrée.', 'Dijon 21000, bien REF-T-1, T3 de 62 m², 210 000 €.']) expect(maskIban(plainText)).toBe(plainText);
  expect(m10.fundSignals(maskIban(`virement sur ${IBAN}`))).toContain('iban');
});

describeWithSqlite('N09 · branchement de M10 dans le socle', () => {
  it('[R16] les routes des dossiers répondent derrière la clé d’API ; un autre agent est refusé, au journal ; sans stockage des pièces, fermées', async () => {
    const t = await setup();
    expect((await t.call(null, 'GET', `/v1/dossiers/${t.fileId}/pieces`)).status).toBe(401);
    const pieces = await t.call('alex', 'GET', `/v1/dossiers/${t.fileId}/pieces`);
    expect(pieces).toMatchObject({ status: 200, body: { ok: true, data: { complete: false } } });
    expect((await t.call('alex', 'GET', '/v1/dossiers/alertes')).status).toBe(200);
    const before = (await t.journal.all()).filter((e) => e.type === 'acces.refuse').length;
    expect((await t.call('sam', 'GET', `/v1/dossiers/${t.fileId}/chemin`)).body).toMatchObject({ ok: false, rule: 'R16' });
    expect((await t.journal.all()).filter((e) => e.type === 'acces.refuse').length - before).toBe(1);
    const closed = await setup(false);
    expect((await closed.call('alex', 'GET', `/v1/dossiers/${closed.fileId}/pieces`)).body).toMatchObject({ ok: false, code: 'pieces_not_configured' });
  });

  it('le passage des dossiers tourne une fois par créneau avec le stockage des pièces, jamais sans ; rien ne part hors du mode essai', async () => {
    const t = await setup();
    t.setClock(new Date('2027-03-02T09:00:00.000Z'));
    await runScheduler({ db: t.db, mode: 'essai', now: t.now, pieces: t.storage });
    await runScheduler({ db: t.db, mode: 'essai', now: t.now, pieces: t.storage });
    expect(await t.db.all("SELECT slot, outcome FROM scheduled_runs WHERE job = 'dossiers.passage'")).toEqual([{ slot: '2027-03-02T10', outcome: 'ok' }]);
    t.setClock(new Date('2027-03-02T10:00:00.000Z'));
    await runScheduler({ db: t.db, mode: 'essai', now: t.now });
    expect(await t.db.all("SELECT slot FROM scheduled_runs WHERE job = 'dossiers.passage'")).toHaveLength(1);
    expect(await runScheduler({ db: t.db, mode: 'reel', now: t.now, pieces: t.storage })).toBeNull();
  });

  it('[R15, R62] un message reçu d’une partie qui donne un RIB : rangé sans l’IBAN, alerte à l’agent dès le rattachement, rappel en mode essai', async () => {
    const t = await setup();
    await t.store.addIdentifier({ networkId: t.network.id, personId: t.buyerId, kind: 'email', value: 'acheteur@example.test' });
    t.setClock(new Date('2027-03-02T09:00:00.000Z'));
    const { chaine } = createCaptation(t.db, t.journal, { now: t.now, withQualification: false });
    await chaine.receive(t.network.id, 'site_form', { submissionId: 'rib-1', email: 'acheteur@example.test', message: `Bonjour, le notaire me demande le virement de l’acompte sur ce nouveau compte : ${IBAN}` });
    // Nulle part en clair : ni dans le message reçu, ni dans la conversation, ni au journal [R13, R15].
    const stored = JSON.stringify([await t.db.all('SELECT body, subject FROM inbound_messages'), await t.db.all('SELECT body FROM messages'), await t.journal.all()]);
    expect(stored).not.toMatch(/FR76|3000 6000|0112 3456/);
    expect(stored).toContain('[IBAN masqué]');
    // L'alerte est déjà là, sans attendre le passage des dossiers.
    const alerts = await t.call('alex', 'GET', '/v1/dossiers/alertes');
    expect(alerts.body.data.fonds).toHaveLength(1);
    expect(alerts.body.data.fonds[0].signals).toEqual(expect.arrayContaining(['iban', 'virement', 'acompte']));
    // Le filet du passage la relit sans la doubler.
    await runScheduler({ db: t.db, mode: 'essai', now: t.now, pieces: t.storage });
    expect((await t.call('alex', 'GET', '/v1/dossiers/alertes')).body.data.fonds).toHaveLength(1);
  });
});
