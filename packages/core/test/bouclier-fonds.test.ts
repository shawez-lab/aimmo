import { readdirSync, readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { BouclierFonds, PIECES, SALE_FOLLOW_UP_PURPOSE, fundSignals, fundsInOutgoing, fundsReminderText, reminderText } from '../src/dossiers/index.ts';
import { setupDossier } from './dossiers-jeu.ts';
import { migrationsDir } from './migrations.ts';
import { describeWithSqlite } from './sqlite.ts';

// Un IBAN inventé, au bon format, qui n'existe pas.
const IBAN = 'FR76 3000 1007 9412 3456 7890 185';
// Mars 2027, avant l'heure d'été : Paris est à UTC+1.
const paris = (day: string, hour: number, minute = 0) => new Date(Date.parse(`${day}T00:00:00.000Z`) + (hour - 1) * 3_600_000 + minute * 60_000);

it('[R62] un message reçu qui parle d’argent est reconnu, sans rien garder du texte', () => {
  expect(fundSignals(`Bonjour, le notaire a changé de banque, voici le nouveau RIB : ${IBAN}`)).toEqual(['iban', 'coordonnees_bancaires']);
  expect(fundSignals('Pouvez-vous me confirmer le virement de l’acompte sur le compte séquestre ?')).toEqual(['virement', 'acompte', 'sequestre']);
  expect(fundSignals('Il faut régler la somme avant vendredi, merci de payer par carte')).toEqual(['paiement']);
  expect(fundSignals('Bonjour, je vous envoie le titre de propriété demain. Bonne journée')).toEqual([]);
  expect(fundSignals('Le règlement de copropriété est joint')).toEqual([]);
});

it('[R62] aucun texte d’AIMMO ne porte de coordonnée bancaire ni ne demande un paiement', () => {
  for (const t of [`Voici nos coordonnées bancaires : ${IBAN}`, 'Merci de virer le dépôt sur le compte du notaire', 'Notre RIB est joint', 'Vous pouvez payer à l’ordre de AIMMO', `IBAN ${IBAN.replace(/ /g, '')}`, 'Veuillez effectuer un virement de 10 000 €']) {
    expect([t, fundsInOutgoing(t)]).toEqual([t, true]);
  }
  // Le rappel du bouclier et toutes les relances de pièces passent.
  expect(fundsInOutgoing(fundsReminderText('Léa'))).toBe(false);
  for (const p of PIECES) expect(fundsInOutgoing(reminderText('Léa', p, '2027-03-11', { city: 'Dijon', reference: 'REF-T-1' }))).toBe(false);
});

it('[R62] aucune table de M10 ne reçoit ni ne suit de fonds', () => {
  for (const f of readdirSync(migrationsDir).filter((x) => /^03\d\d_/.test(x))) {
    const sql = readFileSync(migrationsDir + f, 'utf8').replace(/--.*$/gm, '').toLowerCase();
    expect([f, /iban|\brib\b|sequestre|escrow|acompte|deposit|payment|paiement|virement|balance|amount_received/.test(sql)]).toEqual([f, false]);
  }
});

describeWithSqlite('N05 · aucun fonds, bouclier contre le faux RIB', () => {
  async function setup() {
    const t = await setupDossier();
    for (const [personId, email] of [[t.personId, 'vendeuse@example.test'], [t.buyerId, 'acheteur@example.test']] as const) {
      await t.store.addIdentifier({ networkId: t.network.id, personId, kind: 'email', value: email });
      await t.store.addConsent({ networkId: t.network.id, personId, purpose: SALE_FOLLOW_UP_PURPOSE, channel: 'email', proof: 'mandat', givenAt: new Date('2027-02-10T09:00:00.000Z') });
    }
    const bouclier = new BouclierFonds(t.db, t.acces, t.journal, { now: t.now });
    const receive = (personId: string, body: string) => t.store.recordMessage({ networkId: t.network.id, agentId: t.alexId, personId, channel: 'email', direction: 'in', authorKind: 'person', body, occurredAt: t.now() });
    const inbox = (personId: string) => t.db.all<{ body: string }>('SELECT m.body FROM messages m JOIN trial_outbox o ON o.message_id = m.id WHERE m.person_id = ? ORDER BY m.occurred_at', [personId]);
    return { ...t, bouclier, receive, inbox };
  }

  it('[R62] [R18] un message suspect alerte l’agent aussitôt, une seule fois ; l’IBAN n’est rangé nulle part par le bouclier [R15]', async () => {
    const t = await setup();
    t.setClock(paris('2027-03-08', 10));
    const m = await t.receive(t.buyerId, `Bonjour, voici le nouveau RIB de l'étude pour l'acompte : ${IBAN}`);
    const started = Date.now();
    expect(await t.bouclier.scan(m.id)).toEqual(['iban', 'coordonnees_bancaires', 'acompte']);
    expect(Date.now() - started).toBeLessThan(60_000);
    // Lu deux fois, par la réception et par le filet : une seule alerte.
    expect(await t.bouclier.scan(m.id)).toEqual(['iban', 'coordonnees_bancaires', 'acompte']);
    expect(await t.bouclier.run(t.network.id, paris('2027-03-08', 0))).toBe(0);
    const a = await t.bouclier.alertsOf(t.agent);
    expect(a).toMatchObject({ ok: true, alerts: [{ messageId: m.id, fileId: t.fileId, side: 'acquereur', signals: ['iban', 'coordonnees_bancaires', 'acompte'], reminder: 'sent' }] });
    // Ni l'IBAN ni le texte dans l'alerte ni au journal.
    const stored = JSON.stringify(await t.db.all('SELECT * FROM sale_file_fund_alerts'));
    const journal = JSON.stringify(await t.journal.bySubject(`sale_file:${t.fileId}`));
    for (const s of [stored, journal, JSON.stringify(a)]) {
      expect(s).not.toContain('3000');
      expect(s).not.toMatch(/FR76|nouveau RIB/);
    }
    // Le rappel au client : par le contrôle central, en mode essai, sans coordonnée bancaire.
    const sent = await t.inbox(t.buyerId);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toContain('ne vous demandera jamais de virement');
    expect(fundsInOutgoing(sent[0]!.body)).toBe(false);
  });

  it('[R01] [R05] le rappel au client attend les heures d’envoi, et ne part qu’une fois par dossier ; chaque message suspect a son alerte', async () => {
    const t = await setup();
    // Dimanche soir : l'alerte de l'agent tout de suite, le rappel attend lundi.
    t.setClock(paris('2027-03-07', 22, 30));
    const m1 = await t.receive(t.personId, 'Le notaire demande un virement sur un autre compte, pouvez-vous confirmer ?');
    expect(await t.bouclier.scan(m1.id)).toEqual(['coordonnees_bancaires', 'virement']);
    expect(await t.inbox(t.personId)).toEqual([]);
    let a = await t.bouclier.alertsOf(t.agent);
    expect(a.ok && a.alerts.map((x) => [x.side, x.reminder, x.reminderRule])).toEqual([['vendeur', 'waiting', 'R01']]);
    t.setClock(paris('2027-03-08', 6));
    await t.bouclier.run(t.network.id, paris('2027-03-07', 0));
    expect(await t.inbox(t.personId)).toEqual([]);
    t.setClock(paris('2027-03-08', 9));
    expect(await t.bouclier.run(t.network.id, paris('2027-03-07', 0))).toBe(0);
    expect(await t.inbox(t.personId)).toHaveLength(1);
    // Un second message suspect : une seconde alerte, sans second rappel [R05].
    const m2 = await t.receive(t.personId, 'Je fais le versement demain ?');
    expect(await t.bouclier.run(t.network.id, paris('2027-03-08', 0))).toBe(1);
    a = await t.bouclier.alertsOf(t.agent);
    expect(a.ok && a.alerts.map((x) => [x.messageId, x.reminder, x.reminderRule])).toEqual([[m2.id, 'refused', 'R05'], [m1.id, 'sent', null]]);
    expect(await t.inbox(t.personId)).toHaveLength(1);
  });

  it('[R02] un message d’une personne hors d’un dossier en cours, ou sans signal, ne fait rien ; une personne exclue n’a pas de rappel', async () => {
    const t = await setup();
    t.setClock(paris('2027-03-08', 10));
    const stranger = await t.store.createPerson({ networkId: t.network.id, agentId: t.alexId, firstName: 'Autre', lastName: 'Contact' });
    expect(await t.bouclier.scan((await t.receive(stranger.id, `Mon RIB : ${IBAN}`)).id)).toBeNull();
    expect(await t.bouclier.scan((await t.receive(t.buyerId, 'Merci pour la visite, à bientôt')).id)).toBeNull();
    await t.store.addExclusion({ networkId: t.network.id, personId: t.buyerId, reason: 'network_list', notedAt: new Date('2027-03-02T10:00:00.000Z') });
    const m = await t.receive(t.buyerId, 'Je vire l’acompte ce soir');
    expect(await t.bouclier.scan(m.id)).toEqual(['virement', 'acompte']);
    const a = await t.bouclier.alertsOf(t.agent);
    expect(a.ok && a.alerts.map((x) => [x.reminder, x.reminderRule])).toEqual([['refused', 'R02']]);
    expect(await t.inbox(t.buyerId)).toEqual([]);
    await expect(t.db.run('DELETE FROM sale_file_fund_alerts')).rejects.toThrow(/rien ne s'efface/);
    await expect(t.db.run("UPDATE sale_file_fund_alerts SET signals = '[]'")).rejects.toThrow(/rien ne change/);
  });

  it('[R16] les alertes à l’agent du bien seul, chaque lecture au journal', async () => {
    const t = await setup();
    t.setClock(paris('2027-03-08', 10));
    await t.bouclier.scan((await t.receive(t.buyerId, 'Voici mon RIB')).id);
    expect(await t.bouclier.alertsOf(t.direction)).toEqual({ ok: false, rule: 'R16', code: 'not_agent' });
    expect(await t.bouclier.alertsOf(t.sam)).toEqual({ ok: true, alerts: [] });
    expect((await t.journal.bySubject(`agent:${t.alexId}`)).length).toBe(0);
    await t.bouclier.alertsOf(t.agent);
    expect((await t.journal.bySubject(`agent:${t.alexId}`)).map((e) => e.type)).toEqual(['dossier.alertes_fonds_lues']);
  });
});
