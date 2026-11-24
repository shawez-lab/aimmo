import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ControleEnvois,
  DEFAULT_CONTROLE_SETTINGS,
  DecisionEnvoi,
  FakeChannel,
  FicheClient,
  FicheUnique,
  SqlSendJournal,
  applyMigrations,
  checkText,
  fromSyncSqlite,
  mentionFor,
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

type TestOrder = SendOrder & { at: Date };

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
    for (const text of ['Notre ia répond à votre message.', 'Une I.A. vous répond.', 'Notre AI vous répond.', 'Notre IA a analysé votre bien.', 'Mon assistant vous répond.', 'Grâce à l’intelligence artificielle, c’est rapide.', 'Un robot vous répond.']) {
      expect(rules(text, client('email')), text).toContain('R06');
    }
    expect(rules('Votre agent vous rappelle demain.', client('email'))).toEqual([]);
    expect(rules('Je vous ai envoyé le lien, j’ai hâte de vous lire.', client('email'))).toEqual([]);
  });

  it('[R09] jamais d’adresse exacte ; jamais le nom d’un client dans un contenu public', () => {
    expect(rules('La maison du 12 rue des Tilleuls est en vente.', { audience: 'public' })).toContain('R09');
    expect(rules('Visite au 3 bis avenue du Parc.', client('email'))).toContain('R09');
    expect(rules('Une maison au calme, quartier des Tilleuls.', { audience: 'public' })).toEqual([]);
    expect(rules('Merci à Léa Martin pour sa confiance.', { audience: 'public', clientNames: ['Léa Martin', 'Martin'] })).toContain('R09');
    expect(rules('Merci pour votre confiance.', { audience: 'public', clientNames: ['Léa Martin'] })).toEqual([]);
  });

  it('[R09] « 1 place de stationnement » n’est pas une adresse ; une place nommée en est une (BR68)', () => {
    for (const text of [
      'Balcon. 1 place de stationnement. Chauffage collectif.',
      'Avec 1 place de parking en sous-sol.',
      'Vendu avec 1 place de garage.',
      'Une cave et 1 place couverte.',
      '1 place en sous-sol, 2 places extérieures.',
      'Une place au sous-sol : 1 place au sous-sol.',
      'Il reste 1 place libre pour la visite de samedi.',
      'Il reste 1 place disponible.',
      'Stationnement : 1 place.',
      'Stationnement : 1 place',
    ]) {
      expect(rules(text, { audience: 'public' }), text).not.toContain('R09');
      expect(rules(text, client('email')), text).not.toContain('R09');
    }
    for (const text of [
      'La maison du 12 place de la Libération est en vente.',
      'Rendez-vous au 3 place du Théâtre.',
      'Un appartement au 1 place Darcy.',
      'Au 4 place d’Arcy, deuxième étage.',
      'Au 2 place des Cordeliers.',
      'Au 5 place Saint-Michel.',
      'Au 7 bis place de l’Église.',
      'Appartement au 12 place aux Tilleuls.',
      'Au 6 place au Bois.',
      'Au 8 place à l’Huile.',
      'Au 9 place en Ville.',
      'Appartement au 12 place Couverte.',
      'Au 3 place Double.',
      'Au 4 place Libre, deuxième étage.',
      'Au 5 Place de la République.',
      'AU 6 PLACE COUVERTE.',
    ]) {
      expect(rules(text, { audience: 'public' }), text).toContain('R09');
      expect(rules(text, client('email')), text).toContain('R09');
    }
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
  const migrations = loadMigrations().filter((m) => ['0001_fiche_client', '0003_fusion', '0004_envoi', '0005_controle_envois', '0011_relais', '0611_depart_agent'].includes(m.id));

  async function setup(budgetOk = true) {
    const db = fromSyncSqlite(openMemoryDatabase());
    await applyMigrations(db, migrations);
    const store = new FicheClient(db);
    const fiche = new FicheUnique(db, store);
    const decisions = new DecisionEnvoi(db, store, fiche);
    const channels = (['email', 'sms', 'whatsapp', 'instagram', 'facebook', 'phone'] as Channel[]).map((c) => new FakeChannel(c));
    const journal = new SqlSendJournal(db);
    let clock = TUE_1000;
    const now = () => clock;
    const controle = new ControleEnvois(db, fiche, decisions, {
      channels,
      journal,
      budget: { allows: async () => budgetOk },
      now,
    });
    /** L'heure de l'envoi est celle de l'horloge du contrôle, réglée ici pour le test. */
    const go = (o: TestOrder, onto: ControleEnvois = controle) => {
      const { at, ...rest } = o;
      clock = at;
      return onto.send(rest);
    };
    const setClock = (d: Date) => {
      clock = d;
    };
    const network = await store.createNetwork('Réseau test');
    const agent = await store.createAgent({ networkId: network.id, firstName: 'Paul', lastName: 'Essai' });
    const person = await store.createPerson({ networkId: network.id, agentId: agent.id, firstName: 'Léa', lastName: 'Exemple' });
    await store.addIdentifier({ networkId: network.id, personId: person.id, kind: 'email', value: 'lea.exemple@example.test' });
    await store.addIdentifier({ networkId: network.id, personId: person.id, kind: 'phone', value: '06 00 00 00 01' });
    await store.addIdentifier({ networkId: network.id, personId: person.id, kind: 'instagram', value: '@lea_exemple_test' });
    // Le client a écrit il y a une heure sur les canaux de Meta : leur fenêtre de 24 heures est ouverte [R22].
    const metaWindow = async (personId: string) => {
      for (const channel of ['instagram', 'facebook', 'whatsapp'] as Channel[]) {
        await store.recordMessage({ networkId: network.id, personId, conversationId: `fenetre:${channel}`, channel, direction: 'in', authorKind: 'person', body: 'Bonjour', occurredAt: new Date(TUE_1000.getTime() - 3_600_000) });
      }
    };
    await metaWindow(person.id);
    for (const channel of ['email', 'sms', 'whatsapp'] as Channel[]) {
      for (const purpose of ['alert', 'follow_up']) {
        await store.addConsent({ networkId: network.id, personId: person.id, purpose, channel, proof: 'formulaire test', givenAt: LONG_AGO });
      }
    }
    const byChannel = (c: Channel) => channels.find((x) => x.channel === c)!;
    const order = (over: Partial<TestOrder> = {}): TestOrder => ({
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
    return { db, store, fiche, decisions, controle, journal, network, agent, person, byChannel, order, go, now, setClock, metaWindow };
  }

  it('la migration se rejoue sans erreur', async () => {
    const { db } = await setup();
    for (const m of migrations) await db.exec(m.sql);
    expect(await applyMigrations(db, migrations)).toEqual([]);
  });

  it('un envoi permis part par le faux canal, rangé avant d’être envoyé', async () => {
    const { go, byChannel, order, store, person } = await setup();
    const result = await go(order());
    expect(result).toMatchObject({ status: 'sent', fallbackText: true, aiText: false });
    expect(byChannel('email').sent).toHaveLength(1);
    expect(byChannel('email').sent[0]).toMatchObject({ to: 'lea.exemple@example.test', messageId: result.messageId });
    const stored = (await store.listMessages(person.id)).filter((m) => m.direction === 'out');
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ direction: 'out', author_kind: 'system', body: result.body });
  });

  it('[R01] [R04] [R03] la décision de S05 s’applique avant tout, et le refus est journalisé', async () => {
    const { go, decisions, byChannel, order, journal, network, person } = await setup();
    expect(await go(order({ at: SUN_2300 }))).toMatchObject({ status: 'refused', rule: 'R01' });
    expect(await go(order({ channel: 'whatsapp', kind: 'prospecting', subject: 'prospection:1' }))).toMatchObject({ status: 'refused', rule: 'R03' });
    await decisions.recordStopRequest({ networkId: network.id, personId: person.id, at: LONG_AGO });
    expect(await go(order({ channel: 'instagram', kind: 'reply', subject: undefined, conversationId: 'c' }))).toMatchObject({ status: 'refused', rule: 'R04' });
    for (const c of ['email', 'instagram', 'whatsapp'] as Channel[]) expect(byChannel(c).sent).toHaveLength(0);
    expect((await journal.list(person.id)).map((r) => [r.outcome, r.rule])).toEqual([
      ['refused', 'R01'],
      ['refused', 'R03'],
      ['refused', 'R04'],
    ]);
  });

  it('[R05] un même sujet ne part qu’une fois, sur aucun canal', async () => {
    const { go, order } = await setup();
    expect((await go(order())).status).toBe('sent');
    const again = await go(order({ channel: 'sms', at: TUE_1100, fallbackTexts: ['Léa, un bien correspond à votre recherche.'] }));
    expect(again).toMatchObject({ status: 'refused', rule: 'R05' });
  });

  it('[R05] un même bien ne part qu’une fois à la personne, même dans un autre envoi', async () => {
    const { go, order } = await setup();
    expect((await go(order({ subject: undefined, propertyIds: ['bien-1', 'bien-2'] }))).status).toBe('sent');
    const second = await go(
      order({ subject: 'alerte:recherche-2', propertyIds: ['bien-2'], channel: 'whatsapp', at: TUE_1100, fallbackTexts: ['Léa, voici un autre bien.'] }),
    );
    expect(second).toMatchObject({ status: 'refused', rule: 'R05', reason: 'Ce bien a déjà été envoyé à la personne.' });
  });

  it('[R05] jamais deux fois le même texte : le texte de secours suivant prend le relais', async () => {
    const { go, order } = await setup();
    const texts = ['Bonjour Léa, votre agent vous rappelle.', 'Bonjour Léa, votre agent vous rappelle très vite.'];
    expect((await go(order({ kind: 'follow_up', subject: 'relance:1', fallbackTexts: texts }))).body).toContain(texts[0]);
    const second = await go(order({ kind: 'follow_up', subject: 'relance:2', fallbackTexts: texts, channel: 'sms', at: TUE_1100 }));
    expect(second.status).toBe('sent');
    expect(second.body).toContain(texts[1]);
    const third = await go(order({ kind: 'follow_up', subject: 'relance:3', fallbackTexts: texts, channel: 'whatsapp', at: TUE_1100 }));
    expect(third).toMatchObject({ status: 'refused', rule: 'R05' });
  });

  it('[R05] l’anti-doublon vaut pour toutes les fiches fusionnées', async () => {
    const { go, store, fiche, network, agent, person, order } = await setup();
    const other = await store.createPerson({ networkId: network.id, agentId: agent.id, firstName: 'Léa' });
    await store.addIdentifier({ networkId: network.id, personId: other.id, kind: 'email', value: 'lea.exemple@example.test' });
    await store.addConsent({ networkId: network.id, personId: other.id, purpose: 'alert', channel: 'email', proof: 'formulaire test', givenAt: LONG_AGO });
    expect((await go(order({ personId: other.id }))).status).toBe('sent');
    await fiche.merge({ survivorId: person.id, mergedId: other.id, reason: 'même mail' });
    expect(await go(order({ at: TUE_1100 }))).toMatchObject({ status: 'refused', rule: 'R05' });
  });

  it('un envoi d’initiative sans sujet est une erreur de programmation', async () => {
    const { go, order } = await setup();
    await expect(go(order({ subject: undefined }))).rejects.toThrow(/sujet/);
  });

  it('[R06] la mention légale au premier message automatique de la conversation seulement, et enregistrée', async () => {
    const { go, store, network, person, order, journal } = await setup();
    await store.recordMessage({ networkId: network.id, personId: person.id, channel: 'email', conversationId: 'm1', direction: 'in', authorKind: 'person', body: 'Bonjour, je cherche une maison.', occurredAt: new Date(TUE_1000.getTime() - 5 * 60_000) });
    const reply = (text: string, at: Date) => order({ kind: 'reply', subject: undefined, conversationId: 'm1', at, fallbackTexts: [text] });
    const first = await go(reply('Bonjour Léa, merci pour votre message, votre agent vous rappelle.', TUE_1000));
    expect(first).toMatchObject({ status: 'sent', withMention: true });
    expect(first.body).toMatch(/^Réponse immédiate de l’assistant IA de Paul, qui vous recontacte personnellement\.\n\nBonjour Léa/);
    const second = await go(reply('Il vous propose demain matin.', new Date(TUE_1000.getTime() + 60_000)));
    expect(second).toMatchObject({ status: 'sent', withMention: false });
    expect(second.body).toBe('Il vous propose demain matin.');
    expect((await journal.list(person.id)).map((r) => r.with_mention)).toEqual([1, 0]);
  });

  it('[R06] DS052 · devant une voyelle ou un h, la mention dit « d’Alex », jamais « de Alex » ; elle reste reconnue ensuite', async () => {
    const WITH = DEFAULT_CONTROLE_SETTINGS.mentionWithAgent;
    expect(mentionFor(WITH, 'Paul')).toBe('Réponse immédiate de l’assistant IA de Paul, qui vous recontacte personnellement.');
    for (const prenom of ['Alex', 'Inès', 'Élise', 'Hugo', 'Yann', 'olivier']) expect(mentionFor(WITH, prenom)).toBe(`Réponse immédiate de l’assistant IA d’${prenom}, qui vous recontacte personnellement.`);
    for (const prenom of ['Paul', 'Léa', 'Jean-Alex', 'Marion']) expect(mentionFor(WITH, prenom)).toContain(`IA de ${prenom},`);
    // Un gabarit réglé autrement garde son prénom, sans élision forcée.
    expect(mentionFor('{prenom} vous répond avec son assistant IA.', 'Alex')).toBe('Alex vous répond avec son assistant IA.');
    // Dans un vrai envoi : la mention élidée part au premier message, et le suivant n'en porte plus.
    const { go, db, store, network, agent, person, order, journal } = await setup();
    await db.run("UPDATE agents SET first_name = 'Alex' WHERE id = ?", [agent.id]);
    await store.recordMessage({ networkId: network.id, personId: person.id, channel: 'email', conversationId: 'm1', direction: 'in', authorKind: 'person', body: 'Bonjour, je cherche une maison.', occurredAt: new Date(TUE_1000.getTime() - 5 * 60_000) });
    const reply = (text: string, at: Date) => order({ kind: 'reply', subject: undefined, conversationId: 'm1', at, fallbackTexts: [text] });
    const first = await go(reply('Bonjour Léa, merci pour votre message, votre agent vous rappelle.', TUE_1000));
    expect(first).toMatchObject({ status: 'sent', withMention: true });
    expect(first.body).toMatch(/^Réponse immédiate de l’assistant IA d’Alex, qui vous recontacte personnellement\.\n\nBonjour Léa/);
    expect(first.body).not.toContain('de Alex');
    const second = await go(reply('Il vous propose demain matin.', new Date(TUE_1000.getTime() + 60_000)));
    expect(second).toMatchObject({ status: 'sent', withMention: false });
    expect(second.body).toBe('Il vous propose demain matin.');
    expect((await journal.list(person.id)).map((r) => r.with_mention)).toEqual([1, 0]);
  });

  it('[R06] sur Instagram, la mention propre à Instagram', async () => {
    const { go, store, network, person, order } = await setup();
    await store.recordMessage({ networkId: network.id, personId: person.id, channel: 'instagram', conversationId: 'ig', direction: 'in', authorKind: 'person', body: 'Bonjour', occurredAt: TUE_1000 });
    const result = await go(order({ channel: 'instagram', kind: 'reply', subject: undefined, conversationId: 'ig', fallbackTexts: ['Salut Léa, merci pour ton message !'] }));
    expect(result.body).toBe('Réponse rapide de mon assistant IA, je prends le relais moi-même.\n\nSalut Léa, merci pour ton message !');
  });

  it('[R06] [R07] [R08] [R10] un texte de l’IA refusé par le contrôle laisse partir le texte de secours', async () => {
    for (const bad of ['Notre IA a trouvé ce bien.', 'Bonjour Léa, votre mandataire vous rappelle.', 'Bonjour Léa, ton agent te rappelle.', 'Bonjour Léa, ce bien vaut 199 000 €.']) {
      const { go, order } = await setup();
      const result = await go(order({ compose: async () => bad, figures: [250000] }));
      expect(result, bad).toMatchObject({ status: 'sent', aiText: false, fallbackText: true, rule: 'R12' });
      expect(result.body).not.toContain(bad);
    }
  });

  it('[R10] un chiffre fourni par les données passe', async () => {
    const { go, order } = await setup();
    const result = await go(order({ compose: async () => 'Bonjour Léa, une maison de 95 m² à 250 000 € correspond à votre recherche.', figures: [95, 250000] }));
    expect(result).toMatchObject({ status: 'sent', aiText: true });
  });

  it('[R12] plafond de l’IA atteint : texte de secours, sans appeler l’IA', async () => {
    const { go, order, journal, person } = await setup(false);
    let called = false;
    const result = await go(order({ compose: async () => ((called = true), 'Bonjour Léa, votre agent vous rappelle.') }));
    expect(called).toBe(false);
    expect(result).toMatchObject({ status: 'sent', fallbackText: true, rule: 'R12' });
    expect((await journal.list(person.id))[0]).toMatchObject({ outcome: 'sent', rule: 'R12', fallback_text: 1 });
  });

  it('[R12] l’IA en panne ou trop lente : texte de secours', async () => {
    const failing = await setup();
    expect(await failing.go(failing.order({ compose: async () => { throw new Error('panne'); } }))).toMatchObject({ status: 'sent', fallbackText: true, rule: 'R12' });
    const slow = await setup();
    const controle = new ControleEnvois(slow.db, slow.fiche, slow.decisions, {
      channels: [new FakeChannel('email')],
      journal: slow.journal,
      now: slow.now,
      settings: { ...(await import('../src/index.ts')).DEFAULT_CONTROLE_SETTINGS, aiTimeoutMs: 20 },
    });
    const result = await slow.go(slow.order({ compose: () => new Promise((resolve) => setTimeout(() => resolve('trop tard'), 500)) }), controle);
    expect(result).toMatchObject({ status: 'sent', fallbackText: true, rule: 'R12' });
  });

  it('[R12] le texte de secours respecte R01 à R04 : rien à une personne exclue, rien le dimanche', async () => {
    const { go, decisions, network, person, order, byChannel } = await setup(false);
    expect(await go(order({ at: SUN_2300 }))).toMatchObject({ status: 'refused', rule: 'R01' });
    await decisions.recordExclusion({ networkId: network.id, personId: person.id, at: LONG_AGO, reason: 'refused' });
    expect(await go(order())).toMatchObject({ status: 'refused', rule: 'R02' });
    expect(byChannel('email').sent).toHaveLength(0);
  });

  it('[R13] chaque envoi et chaque refus sont au journal avec leur règle, sans donnée personnelle', async () => {
    const { go, order, journal, person, byChannel } = await setup();
    await go(order());
    await go(order({ at: TUE_1100 }));
    await go(order({ at: SUN_2300, subject: 'alerte:dimanche' }));
    byChannel('sms').failWith = new Error('refus pour lea.exemple@example.test');
    const failed = await go(order({ channel: 'sms', subject: 'alerte:sms', fallbackTexts: ['Léa, un bien correspond à votre recherche.'] }));
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
    const { go, order, byChannel } = await setup();
    byChannel('email').failWith = new Error('panne');
    expect((await go(order())).status).toBe('failed');
    byChannel('email').failWith = null;
    const retry = await go(order({ at: TUE_1100 }));
    expect(retry).toMatchObject({ status: 'sent', withMention: true });
    expect(byChannel('email').sent).toHaveLength(1);
  });

  it('un canal non branché ou sans identifiant : refus journalisé, rien ne part', async () => {
    const { go, order, journal, person } = await setup();
    expect(await go(order({ channel: 'facebook', kind: 'follow_up', subject: 'relance:fb', fallbackTexts: ['Léa, votre agent vous rappelle.'] }))).toMatchObject({ status: 'refused', reason: 'Aucun identifiant de la personne pour ce canal.' });
    expect((await journal.list(person.id))[0]).toMatchObject({ outcome: 'refused' });
  });
  it('[R01] l’heure est celle du contrôle, jamais celle que l’appelant fournit', async () => {
    const { controle, order, setClock, byChannel } = await setup();
    setClock(SUN_2300);
    const forged = { ...order(), at: TUE_1000 } as SendOrder;
    expect(await controle.send(forged)).toMatchObject({ status: 'refused', rule: 'R01' });
    expect(byChannel('email').sent).toHaveLength(0);
  });

  it('[R04] un arrêt reçu pendant que l’IA rédige l’emporte : rien ne part', async () => {
    const { go, order, decisions, network, person, byChannel, now } = await setup();
    const compose = async () => {
      await decisions.recordReceived({ networkId: network.id, personId: person.id, channel: 'instagram', conversationId: 'ig', body: 'STOP', occurredAt: now() });
      return 'Bonjour Léa, votre agent vous rappelle.';
    };
    expect(await go(order({ compose }))).toMatchObject({ status: 'refused', rule: 'R04' });
    expect(byChannel('email').sent).toHaveLength(0);
  });

  it('[R06] la longueur se mesure mention comprise', async () => {
    const { go, order } = await setup();
    const long = `Léa, ${'votre agent vous rappelle. '.repeat(17)}`.trim();
    expect(long.length).toBeLessThanOrEqual(480);
    expect(long.length).toBeGreaterThan(400);
    expect(await go(order({ channel: 'sms', fallbackTexts: [long] }))).toMatchObject({ status: 'refused', rule: 'length' });
    expect((await go(order({ channel: 'sms', subject: 'alerte:court', fallbackTexts: ['Léa, votre agent vous rappelle.'] }))).status).toBe('sent');
  });

  it('[R03] une réponse en panne laisse le message reçu en attente : le nouvel essai, plus tard, part sans accord', async () => {
    const { go, order, store, network, person, byChannel } = await setup();
    const received = new Date('2026-11-10T08:00:00.000Z');
    await store.recordMessage({ networkId: network.id, personId: person.id, channel: 'whatsapp', conversationId: 'wa', direction: 'in', authorKind: 'person', body: 'Bonjour, des nouvelles ?', occurredAt: received });
    const reply = (at: Date, text: string) => order({ channel: 'whatsapp', kind: 'reply', subject: undefined, conversationId: 'wa', at, fallbackTexts: [text] });
    byChannel('whatsapp').failWith = new Error('panne');
    expect((await go(reply(new Date(received.getTime() + 5 * 60_000), 'Bonjour Léa, votre agent vous rappelle.'))).status).toBe('failed');
    byChannel('whatsapp').failWith = null;
    const retry = await go(reply(new Date(received.getTime() + 70 * 60_000), 'Bonjour Léa, votre agent vous rappelle.'));
    expect(retry).toMatchObject({ status: 'sent', withMention: true });
  });

  it('[R12] une réponse dont tous les textes de secours sont déjà partis est signalée à l’agent', async () => {
    const { go, order, store, network, person, journal } = await setup(false);
    const text = 'Bonjour Léa, merci pour votre message, votre agent vous rappelle.';
    for (const [conv, at] of [['m1', TUE_1000], ['m2', TUE_1100]] as const) {
      await store.recordMessage({ networkId: network.id, personId: person.id, channel: 'email', conversationId: conv, direction: 'in', authorKind: 'person', body: 'Bonjour', occurredAt: at });
    }
    expect((await go(order({ kind: 'reply', subject: undefined, conversationId: 'm1', fallbackTexts: [text] }))).status).toBe('sent');
    const second = await go(order({ kind: 'reply', subject: undefined, conversationId: 'm2', at: TUE_1100, fallbackTexts: [text] }));
    expect(second).toMatchObject({ status: 'refused', rule: 'R05', needsHuman: true });
    expect((await journal.list(person.id)).at(-1)?.reason).toMatch(/L’agent doit répondre lui-même/);
  });
  it('[R05] deux envois simultanés du même sujet ou du même texte : un seul part', async () => {
    const { controle, order, byChannel, setClock } = await setup();
    setClock(TUE_1000);
    const { at: _a, ...same } = order();
    const results = await Promise.all([controle.send(same), controle.send({ ...same })]);
    expect(results.map((r) => r.status).sort()).toEqual(['refused', 'sent']);
    expect(results.find((r) => r.status === 'refused')).toMatchObject({ rule: 'R05' });
    const fresh = ['Léa, une nouvelle maison correspond à votre recherche.'];
    const { at: _b, ...second } = order({ subject: 'alerte:autre', fallbackTexts: fresh });
    const { at: _c, ...third } = order({ subject: 'alerte:troisieme', channel: 'sms', fallbackTexts: fresh });
    const texts = await Promise.all([controle.send(second), controle.send(third)]);
    expect(texts.map((r) => r.status).sort()).toEqual(['refused', 'sent']);
    expect(byChannel('email').sent.length + byChannel('sms').sent.length).toBe(2);
  });
  it('[R11] demandes d’avis simultanées : le plafond du jour tient, et une place en panne est rendue', async () => {
    const { controle, store, network, agent, order, setClock, byChannel, metaWindow } = await setup();
    setClock(TUE_1000);
    const people: { id: string }[] = [];
    for (const name of ['Ana', 'Bea', 'Cle', 'Dan']) {
      const p = await store.createPerson({ networkId: network.id, agentId: agent.id, firstName: name });
      await metaWindow(p.id);
      await store.addIdentifier({ networkId: network.id, personId: p.id, kind: 'instagram', value: `@${name.toLowerCase()}_essai` });
      people.push(p);
    }
    const ask = (i: number) => {
      const { at: _a, ...o } = order({ personId: people[i]!.id, channel: 'instagram', kind: 'review_request', subject: `avis:${i}`, fallbackTexts: [`Merci pour ta confiance, ton avis compte ${'beaucoup '.repeat(i + 1).trim()}.`] });
      return controle.send(o);
    };
    byChannel('instagram').failWith = new Error('panne');
    expect((await ask(3)).status).toBe('failed');
    byChannel('instagram').failWith = null;
    const results = await Promise.all([ask(0), ask(1), ask(2)]);
    expect(results.filter((r) => r.status === 'sent')).toHaveLength(2);
    expect(results.filter((r) => r.status === 'refused').map((r) => r.rule)).toEqual(['R11']);
    expect(byChannel('instagram').sent).toHaveLength(2);
  });

  it('[R06] deux premiers messages simultanés dans une conversation : une seule mention part', async () => {
    const { controle, order, setClock, byChannel } = await setup();
    setClock(TUE_1000);
    const { at: _a, ...first } = order({ channel: 'instagram', kind: 'follow_up', subject: 'relance:a', fallbackTexts: ['Léa, ton agent te rappelle demain.'] });
    const { at: _b, ...second } = order({ channel: 'instagram', kind: 'follow_up', subject: 'relance:b', fallbackTexts: ['Léa, une visite est possible cette semaine.'] });
    const results = await Promise.all([controle.send(first), controle.send(second)]);
    expect(results.map((r) => r.status).sort()).toEqual(['refused', 'sent']);
    expect(results.find((r) => r.status === 'refused')).toMatchObject({ rule: 'R06' });
    expect(byChannel('instagram').sent.filter((m) => m.body.includes('assistant IA'))).toHaveLength(1);
  });
});
