import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ControleEnvois,
  DecisionEnvoi,
  FakeChannel,
  FicheClient,
  FicheUnique,
  SqlSendJournal,
  applyMigrations,
  checkText,
  fromSyncSqlite,
  numbersIn,
  type Channel,
  type SendOrder,
} from '../src/index.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

// Novembre 2026 : Paris est à UTC+1.
const TUE_1000 = new Date('2026-11-10T09:00:00.000Z');
const TUE_1100 = new Date('2026-11-10T10:00:00.000Z');
const SUN_2300 = new Date('2026-11-08T22:00:00.000Z');
const LONG_AGO = new Date('2026-01-01T00:00:00.000Z');

const rules = (text: string, context: Parameters<typeof checkText>[1]) => checkText(text, context).map((p) => p.rule);
const client = (channel: Channel, over: Partial<Parameters<typeof checkText>[1]> = {}) => ({ audience: 'client' as const, channel, ...over });

describe('S06 · contrôle du texte', () => {
  it('[R07] « mandataire » et « gratuit » refusés, « agent immobilier » et « offert » permis', () => {
    expect(rules('Votre mandataire vous rappelle.', client('email'))).toContain('R07');
    expect(rules('L’estimation est gratuite.', client('email'))).toContain('R07');
    expect(rules('Votre agent immobilier vous rappelle, l’estimation est offerte.', client('email'))).toEqual([]);
    expect(rules('Estimation GRATUITEMENT', { audience: 'public' })).toContain('R07');
  });

  it('[R08] tutoiement sur Instagram, vouvoiement ailleurs', () => {
    expect(rules('Merci pour votre message.', client('instagram'))).toContain('R08');
    expect(rules('Merci pour ton message.', client('instagram'))).toEqual([]);
    expect(rules('Merci pour ton message.', client('whatsapp'))).toContain('R08');
    expect(rules('Je t’appelle demain.', client('email'))).toContain('R08');
    expect(rules('Merci pour votre message.', client('email'))).toEqual([]);
  });

  it('[R08] le prénom au premier message hors Instagram ; « Salut » seulement au premier', () => {
    expect(rules('Bonjour, merci pour votre message.', client('email', { firstOfConversation: true, firstName: 'Léa' }))).toContain('R08');
    expect(rules('Bonjour Léa, merci pour votre message.', client('email', { firstOfConversation: true, firstName: 'Léa' }))).toEqual([]);
    expect(rules('Salut, merci pour ton message.', client('instagram', { firstOfConversation: true }))).toEqual([]);
    expect(rules('Salut, je reviens vers toi.', client('instagram', { firstOfConversation: false }))).toContain('R08');
  });

  it('[R08] ni parenthèses ni formules administratives', () => {
    expect(rules('Merci pour votre message (et votre patience).', client('email'))).toContain('R08');
    expect(rules('Veuillez agréer mes salutations.', client('email'))).toContain('R08');
    expect(rules('Suite à votre demande, voici le lien.', client('email'))).toContain('R08');
  });

  it('[R06] un texte destiné à un client ne parle pas de l’IA', () => {
    for (const text of ['Notre IA a analysé votre bien.', 'Mon assistant vous répond.', 'Grâce à l’intelligence artificielle, c’est rapide.', 'Un robot vous répond.']) {
      expect(rules(text, client('email')), text).toContain('R06');
    }
    expect(rules('Votre agent vous rappelle demain.', client('email'))).toEqual([]);
  });

  it('[R09] jamais d’adresse exacte ; jamais le nom d’un client dans un contenu public', () => {
    expect(rules('La maison du 12 rue des Tilleuls est en vente.', { audience: 'public' })).toContain('R09');
    expect(rules('Visite au 3 bis avenue du Parc.', client('email'))).toContain('R09');
    expect(rules('Une maison au calme, quartier des Tilleuls.', { audience: 'public' })).toEqual([]);
    expect(rules('Merci à Léa Martin pour sa confiance.', { audience: 'public', clientNames: ['Léa Martin', 'Martin'] })).toContain('R09');
    expect(rules('Merci pour votre confiance.', { audience: 'public', clientNames: ['Léa Martin'] })).toEqual([]);
  });

  it('[R10] chaque chiffre vient des données fournies', () => {
    expect(numbersIn('250 000 €, 82,5 m², 3 pièces, le 12/11')).toEqual(['250000', '82.5', '3', '12', '11']);
    const text = 'Maison de 82,5 m² à 250 000 €, 3 pièces.';
    expect(rules(text, client('email'))).toContain('R10');
    expect(rules(text, client('email', { figures: [250000, '82.5', 3] }))).toEqual([]);
    expect(rules(text, client('email', { figures: [240000, 82.5, 3] }))).toContain('R10');
  });

  it('longueur par canal', () => {
    expect(rules('Merci. '.repeat(100), client('sms'))).toContain('length');
    expect(rules('Merci. '.repeat(100), client('email'))).toEqual([]);
    expect(rules('   ', client('email'))).toContain('length');
  });
});

describe('S06 · une seule porte de sortie', () => {
  it('aucun autre code que le contrôle central n’appelle un canal', () => {
    const src = fileURLToPath(new URL('../../', import.meta.url));
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const path = `${dir}/${name}`;
        if (name === 'node_modules' || name === 'test') continue;
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.(?:ts|js|mjs)$/.test(name)) files.push(path);
      }
    };
    walk(src);
    expect(files.some((f) => f.endsWith('/envoi/controle.ts'))).toBe(true);
    const callers = files.filter((f) => /\.deliver\s*\(|\[\s*['"]deliver['"]\s*\]/.test(readFileSync(f, 'utf8')));
    expect(callers.map((f) => f.slice(src.length).replace(/^\/+/, ''))).toEqual(['core/src/envoi/controle.ts']);
  });
});

describeWithSqlite('S06 · contrôle central des envois', () => {
  const migrations = loadMigrations().filter((m) => ['0001_fiche_client', '0003_fusion', '0004_envoi', '0005_controle_envois'].includes(m.id));

  async function setup(budgetOk = true) {
    const db = fromSyncSqlite(openMemoryDatabase());
    await applyMigrations(db, migrations);
    const store = new FicheClient(db);
    const fiche = new FicheUnique(db, store);
    const decisions = new DecisionEnvoi(db, store, fiche);
    const channels = (['email', 'sms', 'whatsapp', 'instagram', 'facebook', 'phone'] as Channel[]).map((c) => new FakeChannel(c));
    const journal = new SqlSendJournal(db);
    const controle = new ControleEnvois(db, fiche, decisions, {
      channels,
      journal,
      budget: { allows: async () => budgetOk },
    });
    const network = await store.createNetwork('Réseau test');
    const agent = await store.createAgent({ networkId: network.id, firstName: 'Paul', lastName: 'Essai' });
    const person = await store.createPerson({ networkId: network.id, agentId: agent.id, firstName: 'Léa', lastName: 'Exemple' });
    await store.addIdentifier({ networkId: network.id, personId: person.id, kind: 'email', value: 'lea.exemple@example.test' });
    await store.addIdentifier({ networkId: network.id, personId: person.id, kind: 'phone', value: '06 00 00 00 01' });
    await store.addIdentifier({ networkId: network.id, personId: person.id, kind: 'instagram', value: '@lea_exemple_test' });
    for (const channel of ['email', 'sms', 'whatsapp'] as Channel[]) {
      for (const purpose of ['alert', 'follow_up']) {
        await store.addConsent({ networkId: network.id, personId: person.id, purpose, channel, proof: 'formulaire test', givenAt: LONG_AGO });
      }
    }
    const byChannel = (c: Channel) => channels.find((x) => x.channel === c)!;
    const order = (over: Partial<SendOrder> = {}): SendOrder => ({
      networkId: network.id,
      agentId: agent.id,
      personId: person.id,
      channel: 'email',
      kind: 'alert',
      subject: 'alerte:recherche-1',
      fallbackTexts: ['Bonjour Léa, un bien correspond à votre recherche. Votre agent vous rappelle.'],
      at: TUE_1000,
      ...over,
    });
    return { db, store, fiche, decisions, controle, journal, network, agent, person, byChannel, order };
  }

  it('la migration se rejoue sans erreur', async () => {
    const { db } = await setup();
    for (const m of migrations) await db.exec(m.sql);
    expect(await applyMigrations(db, migrations)).toEqual([]);
  });

  it('un envoi permis part par le faux canal, rangé avant d’être envoyé', async () => {
    const { controle, byChannel, order, store, person } = await setup();
    const result = await controle.send(order());
    expect(result).toMatchObject({ status: 'sent', fallbackText: true, aiText: false });
    expect(byChannel('email').sent).toHaveLength(1);
    expect(byChannel('email').sent[0]).toMatchObject({ to: 'lea.exemple@example.test', messageId: result.messageId });
    const stored = await store.listMessages(person.id);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ direction: 'out', author_kind: 'system', body: result.body });
  });

  it('[R01] [R04] [R03] la décision de S05 s’applique avant tout, et le refus est journalisé', async () => {
    const { controle, decisions, byChannel, order, journal, network, person } = await setup();
    expect(await controle.send(order({ at: SUN_2300 }))).toMatchObject({ status: 'refused', rule: 'R01' });
    expect(await controle.send(order({ channel: 'whatsapp', kind: 'prospecting', subject: 'prospection:1' }))).toMatchObject({ status: 'refused', rule: 'R03' });
    await decisions.recordStopRequest({ networkId: network.id, personId: person.id, at: LONG_AGO });
    expect(await controle.send(order({ channel: 'instagram', kind: 'reply', subject: undefined, conversationId: 'c' }))).toMatchObject({ status: 'refused', rule: 'R04' });
    for (const c of ['email', 'instagram', 'whatsapp'] as Channel[]) expect(byChannel(c).sent).toHaveLength(0);
    expect((await journal.list(person.id)).map((r) => [r.outcome, r.rule])).toEqual([
      ['refused', 'R01'],
      ['refused', 'R03'],
      ['refused', 'R04'],
    ]);
  });

  it('[R05] un même sujet ne part qu’une fois, sur aucun canal', async () => {
    const { controle, order } = await setup();
    expect((await controle.send(order())).status).toBe('sent');
    const again = await controle.send(order({ channel: 'sms', at: TUE_1100, fallbackTexts: ['Léa, un bien correspond à votre recherche.'] }));
    expect(again).toMatchObject({ status: 'refused', rule: 'R05' });
  });

  it('[R05] un même bien ne part qu’une fois à la personne, même dans un autre envoi', async () => {
    const { controle, order } = await setup();
    expect((await controle.send(order({ subject: undefined, propertyIds: ['bien-1', 'bien-2'] }))).status).toBe('sent');
    const second = await controle.send(
      order({ subject: 'alerte:recherche-2', propertyIds: ['bien-2'], channel: 'whatsapp', at: TUE_1100, fallbackTexts: ['Léa, voici un autre bien.'] }),
    );
    expect(second).toMatchObject({ status: 'refused', rule: 'R05', reason: 'Ce bien a déjà été envoyé à la personne.' });
  });

  it('[R05] jamais deux fois le même texte : le texte de secours suivant prend le relais', async () => {
    const { controle, order } = await setup();
    const texts = ['Bonjour Léa, votre agent vous rappelle.', 'Bonjour Léa, votre agent vous rappelle très vite.'];
    expect((await controle.send(order({ kind: 'follow_up', subject: 'relance:1', fallbackTexts: texts }))).body).toContain(texts[0]);
    const second = await controle.send(order({ kind: 'follow_up', subject: 'relance:2', fallbackTexts: texts, channel: 'sms', at: TUE_1100 }));
    expect(second.status).toBe('sent');
    expect(second.body).toContain(texts[1]);
    const third = await controle.send(order({ kind: 'follow_up', subject: 'relance:3', fallbackTexts: texts, channel: 'whatsapp', at: TUE_1100 }));
    expect(third).toMatchObject({ status: 'refused', rule: 'R05' });
  });

  it('[R05] l’anti-doublon vaut pour toutes les fiches fusionnées', async () => {
    const { controle, store, fiche, network, agent, person, order } = await setup();
    const other = await store.createPerson({ networkId: network.id, agentId: agent.id, firstName: 'Léa' });
    await store.addIdentifier({ networkId: network.id, personId: other.id, kind: 'email', value: 'lea.exemple@example.test' });
    await store.addConsent({ networkId: network.id, personId: other.id, purpose: 'alert', channel: 'email', proof: 'formulaire test', givenAt: LONG_AGO });
    expect((await controle.send(order({ personId: other.id }))).status).toBe('sent');
    await fiche.merge({ survivorId: person.id, mergedId: other.id, reason: 'même mail' });
    expect(await controle.send(order({ at: TUE_1100 }))).toMatchObject({ status: 'refused', rule: 'R05' });
  });

  it('un envoi d’initiative sans sujet est une erreur de programmation', async () => {
    const { controle, order } = await setup();
    await expect(controle.send(order({ subject: undefined }))).rejects.toThrow(/sujet/);
  });

  it('[R06] la mention légale au premier message automatique de la conversation seulement, et enregistrée', async () => {
    const { controle, store, network, person, order, journal } = await setup();
    await store.recordMessage({ networkId: network.id, personId: person.id, channel: 'email', conversationId: 'm1', direction: 'in', authorKind: 'person', body: 'Bonjour, je cherche une maison.', occurredAt: new Date(TUE_1000.getTime() - 5 * 60_000) });
    const reply = (text: string, at: Date) => order({ kind: 'reply', subject: undefined, conversationId: 'm1', at, fallbackTexts: [text] });
    const first = await controle.send(reply('Bonjour Léa, merci pour votre message, votre agent vous rappelle.', TUE_1000));
    expect(first).toMatchObject({ status: 'sent', withMention: true });
    expect(first.body).toMatch(/^Réponse immédiate de l’assistant IA de Paul, qui vous recontacte personnellement\.\n\nBonjour Léa/);
    const second = await controle.send(reply('Il vous propose demain matin.', new Date(TUE_1000.getTime() + 60_000)));
    expect(second).toMatchObject({ status: 'sent', withMention: false });
    expect(second.body).toBe('Il vous propose demain matin.');
    expect((await journal.list(person.id)).map((r) => r.with_mention)).toEqual([1, 0]);
  });

  it('[R06] sur Instagram, la mention propre à Instagram', async () => {
    const { controle, store, network, person, order } = await setup();
    await store.recordMessage({ networkId: network.id, personId: person.id, channel: 'instagram', conversationId: 'ig', direction: 'in', authorKind: 'person', body: 'Bonjour', occurredAt: TUE_1000 });
    const result = await controle.send(order({ channel: 'instagram', kind: 'reply', subject: undefined, conversationId: 'ig', fallbackTexts: ['Salut Léa, merci pour ton message !'] }));
    expect(result.body).toBe('Réponse rapide de mon assistant IA, je prends le relais moi-même.\n\nSalut Léa, merci pour ton message !');
  });

  it('[R06] [R07] [R08] [R10] un texte de l’IA refusé par le contrôle laisse partir le texte de secours', async () => {
    for (const bad of ['Notre IA a trouvé ce bien.', 'Bonjour Léa, votre mandataire vous rappelle.', 'Bonjour Léa, ton agent te rappelle.', 'Bonjour Léa, ce bien vaut 199 000 €.']) {
      const { controle, order } = await setup();
      const result = await controle.send(order({ compose: async () => bad, figures: [250000] }));
      expect(result, bad).toMatchObject({ status: 'sent', aiText: false, fallbackText: true, rule: 'R12' });
      expect(result.body).not.toContain(bad);
    }
  });

  it('[R10] un chiffre fourni par les données passe', async () => {
    const { controle, order } = await setup();
    const result = await controle.send(order({ compose: async () => 'Bonjour Léa, une maison de 95 m² à 250 000 € correspond à votre recherche.', figures: [95, 250000] }));
    expect(result).toMatchObject({ status: 'sent', aiText: true });
  });

  it('[R12] plafond de l’IA atteint : texte de secours, sans appeler l’IA', async () => {
    const { controle, order, journal, person } = await setup(false);
    let called = false;
    const result = await controle.send(order({ compose: async () => ((called = true), 'Bonjour Léa, votre agent vous rappelle.') }));
    expect(called).toBe(false);
    expect(result).toMatchObject({ status: 'sent', fallbackText: true, rule: 'R12' });
    expect((await journal.list(person.id))[0]).toMatchObject({ outcome: 'sent', rule: 'R12', fallback_text: 1 });
  });

  it('[R12] l’IA en panne ou trop lente : texte de secours', async () => {
    const failing = await setup();
    expect(await failing.controle.send(failing.order({ compose: async () => { throw new Error('panne'); } }))).toMatchObject({ status: 'sent', fallbackText: true, rule: 'R12' });
    const slow = await setup();
    const controle = new ControleEnvois(slow.db, slow.fiche, slow.decisions, {
      channels: [new FakeChannel('email')],
      journal: slow.journal,
      settings: { ...(await import('../src/index.ts')).DEFAULT_CONTROLE_SETTINGS, aiTimeoutMs: 20 },
    });
    const result = await controle.send(slow.order({ compose: () => new Promise((resolve) => setTimeout(() => resolve('trop tard'), 500)) }));
    expect(result).toMatchObject({ status: 'sent', fallbackText: true, rule: 'R12' });
  });

  it('[R12] le texte de secours respecte R01 à R04 : rien à une personne exclue, rien le dimanche', async () => {
    const { controle, decisions, network, person, order, byChannel } = await setup(false);
    expect(await controle.send(order({ at: SUN_2300 }))).toMatchObject({ status: 'refused', rule: 'R01' });
    await decisions.recordExclusion({ networkId: network.id, personId: person.id, at: LONG_AGO, reason: 'refused' });
    expect(await controle.send(order())).toMatchObject({ status: 'refused', rule: 'R02' });
    expect(byChannel('email').sent).toHaveLength(0);
  });

  it('[R13] chaque envoi et chaque refus sont au journal avec leur règle, sans donnée personnelle', async () => {
    const { controle, order, journal, person, byChannel } = await setup();
    await controle.send(order());
    await controle.send(order({ at: TUE_1100 }));
    await controle.send(order({ at: SUN_2300, subject: 'alerte:dimanche' }));
    byChannel('sms').failWith = new Error('refus pour lea.exemple@example.test');
    const failed = await controle.send(order({ channel: 'sms', subject: 'alerte:sms', fallbackTexts: ['Léa, un bien correspond à votre recherche.'] }));
    expect(failed.status).toBe('failed');
    const rows = await journal.list(person.id);
    expect(rows.map((r) => [r.outcome, r.rule])).toEqual([
      ['refused', 'R01'],
      ['sent', null],
      ['sent', null],
      ['failed', null],
      ['refused', 'R05'],
    ]);
    const dump = JSON.stringify(rows);
    for (const secret of ['Léa', 'Exemple', 'lea.exemple', '06 00', '+336', 'lea_exemple', 'Paul', 'correspond']) {
      expect(dump, secret).not.toContain(secret);
    }
  });

  it('un envoi en panne est journalisé et ne bloque pas un nouvel essai', async () => {
    const { controle, order, byChannel } = await setup();
    byChannel('email').failWith = new Error('panne');
    expect((await controle.send(order())).status).toBe('failed');
    byChannel('email').failWith = null;
    const retry = await controle.send(order({ at: TUE_1100 }));
    expect(retry).toMatchObject({ status: 'sent', withMention: true });
    expect(byChannel('email').sent).toHaveLength(1);
  });

  it('un canal non branché ou sans identifiant : refus journalisé, rien ne part', async () => {
    const { controle, order, journal, person } = await setup();
    expect(await controle.send(order({ channel: 'facebook', kind: 'follow_up', subject: 'relance:fb', fallbackTexts: ['Léa, votre agent vous rappelle.'] }))).toMatchObject({ status: 'refused', reason: 'Aucun identifiant de la personne pour ce canal.' });
    expect((await journal.list(person.id))[0]).toMatchObject({ outcome: 'refused' });
  });
});
