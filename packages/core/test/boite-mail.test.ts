import { describe, expect, it } from 'vitest';
import { FicheClient, FicheUnique, SqlJournalStore, applyMigrations, fromSyncSqlite, type SqlDatabase } from '../src/index.ts';
import { BoiteMail, forbiddenAttachment, judgeAttachment, type MailAttachmentIn, type MailIn, type MailboxProvider } from '../src/automatismes/boite-mail.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

// Un mardi d'octobre, 10 h à Paris. Réseau, agents, personnes, adresses et fichiers inventés.
const TUE_10H = Date.parse('2027-10-12T08:00:00.000Z');
const MIN = 60_000;
const DAY = 24 * 60 * MIN;

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const pdf = (text: string): Uint8Array => enc(`%PDF-1.4\n% ${text}\n%%EOF`);
const png = (size: number, seed = 0): Uint8Array => {
  const b = new Uint8Array(size);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  b[size - 1] = seed;
  return b;
};
const jpeg = (size: number): Uint8Array => {
  const b = new Uint8Array(size);
  b.set([0xff, 0xd8, 0xff, 0xe0]);
  return b;
};
const att = (fileName: string, contentType: string, bytes: Uint8Array): MailAttachmentIn => ({ fileName, contentType, bytes });

async function setup() {
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  let clock = TUE_10H;
  const now = (): Date => new Date(clock);
  let n = 0;
  const newId = (): string => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
  const journal = new SqlJournalStore(db);
  const store = new FicheClient(db, { now });
  const unique = new FicheUnique(db, store, { now });
  const network = await store.createNetwork('Réseau test');
  const alex = await store.createAgent({ networkId: network.id, firstName: 'Alex', lastName: 'Agent' });
  const lea = await store.createAgent({ networkId: network.id, firstName: 'Léa', lastName: 'Agent' });
  const asAgent = (id: string) => ({ role: 'agent' as const, userId: id, networkId: network.id });
  const direction = { role: 'direction' as const, userId: 'dir-1', networkId: network.id };
  const person = async (firstName: string, email: string, agentId: string = alex.id) => {
    const p = await store.createPerson({ networkId: network.id, agentId, firstName });
    await store.addIdentifier({ networkId: network.id, personId: p.id, kind: 'email', value: email });
    return p.id;
  };
  const puts: { key: string; size: number }[] = [];
  const files = { put: async (key: string, bytes: Uint8Array) => void puts.push({ key, size: bytes.length }) };
  let m = 0;
  const mail = (from: string, body: string, attachments: MailAttachmentIn[] = [], extra: Partial<MailIn> = {}): MailIn => ({
    provider: 'gmail',
    externalId: `msg-${++m}`,
    threadId: `fil-${m}`,
    from,
    body,
    receivedAt: new Date(clock - 10 * MIN),
    attachments,
    ...extra,
  });
  const outbox = () => db.all<{ body: string; person_id: string }>('SELECT m.body, m.person_id FROM trial_outbox o JOIN messages m ON m.id = o.message_id ORDER BY m.rowid');
  const journalText = async () => JSON.stringify(await journal.all());
  return { db, journal, store, unique, network, alex, lea, asAgent, direction, person, puts, mail, outbox, journalText, boite: new BoiteMail(db, journal, files, { now, newId }), setClock: (t: number) => (clock = t) };
}

describe('HX26 · pièces jointes, sans base', () => {
  it('[R410] seuls un PDF, un JPEG ou un PNG confirmés par leurs premiers octets sont utiles ; une petite image est une signature', () => {
    expect(judgeAttachment(att('diagnostics.pdf', 'application/pdf', pdf('dpe')))).toMatchObject({ ok: true, ext: 'pdf' });
    expect(judgeAttachment(att('salon.jpg', 'image/jpeg; name=salon.jpg', jpeg(50_000)))).toMatchObject({ ok: true, ext: 'jpg' });
    expect(judgeAttachment(att('logo.png', 'image/png', png(3_000)))).toEqual({ ok: false, outcome: 'inutile' });
    // Le type annoncé ne suffit pas : les premiers octets doivent le confirmer.
    expect(judgeAttachment(att('faux.pdf', 'application/pdf', jpeg(50_000)))).toEqual({ ok: false, outcome: 'type_refuse' });
    expect(judgeAttachment(att('page.html', 'text/html', enc('<html></html>')))).toEqual({ ok: false, outcome: 'type_refuse' });
    expect(judgeAttachment(att('vide.pdf', 'application/pdf', new Uint8Array(0)))).toEqual({ ok: false, outcome: 'type_refuse' });
  });

  it('[R410] une pièce d’identité, un RIB ou un document fiscal ne sont jamais rangés, quel que soit leur type [R15]', () => {
    for (const name of ['CNI recto.pdf', 'carte_identite.jpg', 'Passeport.PDF', 'RIB-compte.pdf', 'releve bancaire mars.pdf', 'Avis d’imposition 2026.pdf', 'titre-de-séjour.png', 'bulletin de salaire.pdf', 'justificatif_domicile.pdf', 'permis de conduire.jpg', 'attestation-revenus.pdf', 'banque.pdf', 'Relevés bancaires.pdf', 'avis fiscaux.pdf', 'Passport scan.pdf', 'payslips.pdf']) {
      expect(forbiddenAttachment(name)).toBe(true);
      expect(judgeAttachment(att(name, 'application/pdf', pdf('x')))).toEqual({ ok: false, outcome: 'interdit' });
    }
    // Un mot entier seulement : « tribune » n'est pas un RIB, « permis de construire » n'est pas un permis de conduire.
    for (const name of ['tribune.pdf', 'permis de construire.pdf', 'diagnostic-electricite.pdf', 'compromis signé.pdf', 'taxe fonciere.pdf', 'compte rendu de visite.pdf']) expect(forbiddenAttachment(name)).toBe(false);
  });
});

describeWithSqlite('HX26 · tri de la boîte mail de l’agent', () => {
  it('[R408] un mail d’un client connu est rattaché à sa fiche et à son dossier, dans le fil du mail ; une adresse inconnue ne crée rien', async () => {
    const t = await setup();
    const me = t.asAgent(t.alex.id);
    const noa = await t.person('Noa', 'noa@example.test');
    const project = await t.store.createProject({ networkId: t.network.id, agentId: t.alex.id, personId: noa, kind: 'sell' });
    await t.store.createProject({ networkId: t.network.id, agentId: t.alex.id, personId: noa, kind: 'buy', stage: 'abandonne' });

    const r = await t.boite.sort(me, t.mail('  NOA@Example.TEST ', 'Bonjour, voici des nouvelles de la maison.'));
    expect(r).toMatchObject({ ok: true, value: { outcome: 'rattache', personId: noa, projectId: project.id } });
    const msgs = await t.db.all<{ person_id: string; project_id: string; conversation_id: string; direction: string; channel: string }>("SELECT person_id, project_id, conversation_id, direction, channel FROM messages WHERE body LIKE '%nouvelles de la maison%'");
    expect(msgs).toEqual([{ person_id: noa, project_id: project.id, conversation_id: 'email:gmail:fil-1', direction: 'in', channel: 'email' }]);

    // Le même mail relu : rien n'est doublé [R18].
    const again = await t.boite.sort(me, { ...t.mail('noa@example.test', 'Bonjour, voici des nouvelles de la maison.'), externalId: 'msg-1', threadId: 'fil-1' });
    expect(again).toMatchObject({ ok: true, value: { outcome: null } });
    expect(await t.db.all("SELECT id FROM messages WHERE body LIKE '%nouvelles de la maison%'")).toHaveLength(1);

    // Une adresse inconnue : aucune fiche créée, ni adresse ni texte gardés [R13].
    const persons = (await t.db.all('SELECT id FROM persons')).length;
    const unknown = await t.boite.sort(me, t.mail('inconnu@example.test', 'Offre de partenariat secrète'));
    expect(unknown).toMatchObject({ ok: true, value: { outcome: 'inconnu', personId: null, draftId: null } });
    expect(await t.db.all('SELECT id FROM persons')).toHaveLength(persons);
    expect(await t.db.all("SELECT id FROM messages WHERE body LIKE '%partenariat secrète%'")).toHaveLength(0);
    expect(JSON.stringify(await t.db.all('SELECT * FROM mailbox_mails'))).not.toContain('inconnu@example.test');
  });

  it('[R408] jamais la fiche d’un autre agent ; deux fiches possibles laissent le choix à l’agent [R16]', async () => {
    const t = await setup();
    const me = t.asAgent(t.alex.id);
    await t.person('Sam', 'sam@example.test', t.lea.id);
    const r = await t.boite.sort(me, t.mail('sam@example.test', 'Bonjour Alex'));
    expect(r).toMatchObject({ ok: true, value: { outcome: 'inconnu', personId: null } });
    expect(await t.db.all("SELECT id FROM messages WHERE body = 'Bonjour Alex'")).toHaveLength(0);

    await t.person('Eli', 'famille@example.test');
    await t.person('Ari', 'famille@example.test');
    const both = await t.boite.sort(me, t.mail('famille@example.test', 'Bonjour à vous deux'));
    expect(both).toMatchObject({ ok: true, value: { outcome: 'ambigu', personId: null } });

    // Une fiche réunie : une seule fiche gardée, le mail y va.
    const ivy = await t.person('Ivy', 'ivy@example.test');
    const ivy2 = await t.person('Ivy', 'ivy.pro@example.test');
    await t.unique.merge({ survivorId: ivy, mergedId: ivy2, reason: 'même personne (test)' });
    const merged = await t.boite.sort(me, t.mail('ivy.pro@example.test', 'Bonjour'));
    expect(merged).toMatchObject({ ok: true, value: { outcome: 'rattache', personId: ivy } });

    // Seul l'agent de la boîte la trie.
    expect(await t.boite.sort(t.direction, t.mail('ivy@example.test', 'x'))).toMatchObject({ ok: false, rule: 'R16' });
    // Ni adresse au journal [R13].
    const text = await t.journalText();
    for (const s of ['sam@example.test', 'famille@example.test', 'ivy.pro@example.test', 'Bonjour à vous deux']) expect(text).not.toContain(s);
  });

  it('[R410] une pièce jointe est rangée une seule fois dans le dossier, par son empreinte ; jamais une pièce interdite ni sans dossier', async () => {
    const t = await setup();
    const me = t.asAgent(t.alex.id);
    const noa = await t.person('Noa', 'noa@example.test');
    const project = await t.store.createProject({ networkId: t.network.id, agentId: t.alex.id, personId: noa, kind: 'sell' });
    const dpe = pdf('diagnostic de performance énergétique');

    const first = await t.boite.sort(me, t.mail('noa@example.test', 'Voici le DPE', [att('DPE.pdf', 'application/pdf', dpe), att('DPE copie.pdf', 'application/pdf', dpe), att('logo.png', 'image/png', png(2_000)), att('RIB.pdf', 'application/pdf', pdf('banque'))]));
    expect(first).toMatchObject({ ok: true, value: { attachments: ['range', 'inutile', 'interdit'] } });
    expect(t.puts).toHaveLength(1);
    expect(t.puts[0]!.key).toMatch(new RegExp(`^boite/${project.id}/[0-9a-f]{64}\\.pdf$`));

    // Le même fichier, renvoyé sous un autre nom dans un autre mail : déjà rangé, rien n'est écrit de nouveau.
    const second = await t.boite.sort(me, t.mail('noa@example.test', 'Je vous le renvoie', [att('dpe-final.pdf', 'application/pdf', dpe), att('photo.jpg', 'image/jpeg', jpeg(40_000))]));
    expect(second).toMatchObject({ ok: true, value: { attachments: ['deja_range', 'range'] } });
    expect(t.puts).toHaveLength(2);
    expect(await t.db.all('SELECT id FROM mailbox_attachments WHERE project_id = ?', [project.id])).toHaveLength(2);
    // Une ligne rangée ne change ni ne s'efface [R17].
    await expect(t.db.run('DELETE FROM mailbox_attachments')).rejects.toThrow();

    // Deux projets ouverts : l'agent choisit le dossier, rien n'est rangé d'ici là.
    await t.store.createProject({ networkId: t.network.id, agentId: t.alex.id, personId: noa, kind: 'buy' });
    const third = await t.boite.sort(me, t.mail('noa@example.test', 'Encore un document', [att('plan.pdf', 'application/pdf', pdf('plan'))]));
    expect(third).toMatchObject({ ok: true, value: { projectId: null, attachments: ['en_attente'] } });
    expect(t.puts).toHaveLength(2);
    // Aucun nom de fichier, ni en base ni au journal [R13].
    const all = JSON.stringify(await t.db.all('SELECT * FROM mailbox_attachments')) + JSON.stringify(await t.db.all('SELECT * FROM mailbox_attachment_links')) + (await t.journalText());
    for (const s of ['DPE.pdf', 'RIB', 'dpe-final', 'plan.pdf', 'noa@example.test']) expect(all).not.toContain(s);
  });

  it('[R409] aucune réponse ne part sans la validation de l’agent de la boîte, et elle ne part qu’une fois, par le contrôle central', async () => {
    const t = await setup();
    const me = t.asAgent(t.alex.id);
    const noa = await t.person('Noa', 'noa@example.test');
    await t.store.createProject({ networkId: t.network.id, agentId: t.alex.id, personId: noa, kind: 'sell' });
    const r = await t.boite.sort(me, t.mail('noa@example.test', 'Pouvez-vous me rappeler ?'));
    if (!r.ok || !r.value.draftId) throw new Error('réponse attendue');
    const draftId = r.value.draftId;
    // Trier n'envoie rien : ni boîte d'essai, ni journal des envois.
    expect(await t.outbox()).toHaveLength(0);
    expect(await t.db.all('SELECT id FROM send_log')).toHaveLength(0);
    expect(await t.boite.drafts(me)).toMatchObject({ ok: true, value: [{ id: draftId, personId: noa }] });

    // Ni un autre agent, ni la direction ne valident la réponse d'une boîte qui n'est pas la leur.
    expect(await t.boite.validate(t.asAgent(t.lea.id), draftId)).toMatchObject({ ok: false, rule: 'R409' });
    expect(await t.boite.validate(t.direction, draftId)).toMatchObject({ ok: false, rule: 'R409' });
    expect(await t.outbox()).toHaveLength(0);

    const ok = await t.boite.validate(me, draftId);
    expect(ok).toMatchObject({ ok: true, value: { status: 'parti' } });
    const sent = await t.outbox();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.person_id).toBe(noa);
    const draft = await t.db.first<{ body: string; status: string; validated_by: string }>('SELECT body, status, validated_by FROM mailbox_drafts WHERE id = ?', [draftId]);
    expect(sent[0]!.body).toContain(draft!.body.split('\n\n')[0]!);
    expect(draft).toMatchObject({ status: 'parti', validated_by: t.alex.id });
    // Le texte validé est celui préparé : il ne change plus.
    await expect(t.db.run("UPDATE mailbox_drafts SET body = 'autre' WHERE id = ?", [draftId])).rejects.toThrow();

    // Une seconde validation ne renvoie rien.
    expect(await t.boite.validate(me, draftId)).toMatchObject({ ok: false, rule: 'R409', code: 'already_validated' });
    expect(await t.outbox()).toHaveLength(1);
  });

  it('[R408] la lecture de la boîte ne saute jamais un mail : trop de pièces, il est trié quand même ; illisible ou en panne, la lecture le reprend', async () => {
    const t = await setup();
    const me = t.asAgent(t.alex.id);
    const noa = await t.person('Noa', 'noa@example.test');
    await t.store.createProject({ networkId: t.network.id, agentId: t.alex.id, personId: noa, kind: 'sell' });
    // 21 photos et une demande d'arrêt : l'arrêt vaut quand même, les 20 premières pièces sont rangées, la dernière laissée [R04, R410].
    const many = Array.from({ length: 21 }, (_, i) => att(`photo-${i}.jpg`, 'image/jpeg', jpeg(30_000 + i)));
    const queue: MailIn[] = [t.mail('noa@example.test', 'Toutes les photos. Ne me contactez plus.', many, { receivedAt: new Date(TUE_10H - 30 * MIN) }), t.mail('noa@example.test', 'Et un mot', [], { receivedAt: new Date(TUE_10H - 20 * MIN) })];
    const since: (Date | null)[] = [];
    const provider: MailboxProvider = { provider: 'gmail', receivedSince: async (_agent, s) => (since.push(s), queue.filter((q) => s === null || q.receivedAt.getTime() >= s.getTime())) };
    const first = await t.boite.sync(me, provider);
    if (!first.ok) throw new Error('lecture attendue');
    expect(first.value.map((v) => v.outcome)).toEqual(['rattache', 'rattache']);
    expect(first.value[0]!.attachments.filter((o) => o === 'range')).toHaveLength(20);
    expect(first.value[0]!.attachments.at(-1)).toBe('trop');
    expect(first.value[0]!.draftId).toBeNull();
    expect(await t.db.all("SELECT id FROM exclusions WHERE person_id = ? AND reason = 'stop'", [noa])).toHaveLength(1);

    // Un mail illisible : la lecture s'arrête, le plus récent attend, le curseur ne passe pas au-delà.
    queue.push({ ...t.mail('noa@example.test', 'cassé', [], { receivedAt: new Date(TUE_10H - 15 * MIN) }), externalId: '' }, t.mail('noa@example.test', 'Plus tard', [], { receivedAt: new Date(TUE_10H - 10 * MIN) }));
    expect(await t.boite.sync(me, provider)).toMatchObject({ ok: false, rule: 'R408', code: 'bad_mail' });
    expect(await t.db.all("SELECT id FROM messages WHERE body = 'Plus tard'")).toHaveLength(0);
    expect(since[1]?.toISOString()).toBe(new Date(TUE_10H - 20 * MIN).toISOString());
  });

  it('[R410] une panne du stockage rend le mail à la lecture suivante, qui le finit sans rien doubler [R18]', async () => {
    const t = await setup();
    const me = t.asAgent(t.alex.id);
    const noa = await t.person('Noa', 'noa@example.test');
    const project = await t.store.createProject({ networkId: t.network.id, agentId: t.alex.id, personId: noa, kind: 'sell' });
    let broken = true;
    const puts: string[] = [];
    const boite = new BoiteMail(t.db, t.journal, { put: async (key) => { if (broken) throw new Error('stockage indisponible (test)'); puts.push(key); } }, { now: () => new Date(TUE_10H) });
    const mail = t.mail('noa@example.test', 'Le DPE', [att('dpe.pdf', 'application/pdf', pdf('dpe'))]);
    const queue = [mail];
    const provider: MailboxProvider = { provider: 'gmail', receivedSince: async (_a, s) => queue.filter((q) => s === null || q.receivedAt.getTime() >= s.getTime()) };
    await expect(boite.sync(me, provider)).rejects.toThrow('stockage indisponible');
    expect(await t.db.first('SELECT status FROM mailbox_mails')).toEqual({ status: 'a_reprendre' });
    // Un mail plus récent arrive : le curseur reste au mail coupé.
    queue.push(t.mail('noa@example.test', 'Et après', [], { receivedAt: new Date(TUE_10H - 5 * MIN) }));
    broken = false;
    const again = await boite.sync(me, provider);
    if (!again.ok) throw new Error('lecture attendue');
    expect(again.value.map((v) => v.outcome)).toEqual(['rattache', 'rattache']);
    expect(again.value[0]!.attachments).toEqual(['range']);
    expect(again.value[0]!.draftId).not.toBeNull();
    expect(puts).toEqual([expect.stringMatching(new RegExp(`^boite/${project.id}/`))]);
    expect(await t.db.all("SELECT id FROM messages WHERE body = 'Le DPE'")).toHaveLength(1);
    expect(await t.db.all("SELECT status FROM mailbox_mails ORDER BY received_at")).toEqual([{ status: 'rattache' }, { status: 'rattache' }]);
  });

  it('[R409] une fiche passée à un autre agent depuis le tri : sa réponse n’est plus montrée ni validable [R16]', async () => {
    const t = await setup();
    const me = t.asAgent(t.alex.id);
    const noa = await t.person('Noa', 'noa@example.test');
    const r = await t.boite.sort(me, t.mail('noa@example.test', 'Bonjour'));
    if (!r.ok || !r.value.draftId) throw new Error('réponse attendue');
    await t.db.run('UPDATE persons SET agent_id = ? WHERE id = ?', [t.lea.id, noa]);
    expect(await t.boite.drafts(me)).toEqual({ ok: true, value: [] });
    expect(await t.boite.validate(me, r.value.draftId)).toMatchObject({ ok: false, rule: 'R16' });
    expect(await t.outbox()).toHaveLength(0);
    // La réponse reste préparée : rien n'a été pris ni envoyé.
    expect(await t.db.first('SELECT status FROM mailbox_drafts WHERE id = ?', [r.value.draftId])).toEqual({ status: 'prepare' });
  });

  it('[R409] une demande d’arrêt par mail exclut la personne et ne prépare aucune réponse [R04] ; hors des heures, la réponse attend', async () => {
    const t = await setup();
    const me = t.asAgent(t.alex.id);
    const noa = await t.person('Noa', 'noa@example.test');
    const stop = await t.boite.sort(me, t.mail('noa@example.test', 'STOP, ne me contactez plus.'));
    expect(stop).toMatchObject({ ok: true, value: { outcome: 'rattache', draftId: null } });
    expect(await t.db.all("SELECT id FROM exclusions WHERE person_id = ? AND reason = 'stop'", [noa])).toHaveLength(1);

    // Une demande d'arrêt tout au bout d'un très long mail compte aussi : le texte entier est lu.
    const lou = await t.person('Lou', 'lou@example.test');
    const long = await t.boite.sort(me, t.mail('lou@example.test', `${'Bonjour, voici un long récit. '.repeat(1_000)}Ne me contactez plus.`));
    expect(long).toMatchObject({ ok: true, value: { outcome: 'rattache', draftId: null } });
    expect(await t.db.all("SELECT id FROM exclusions WHERE person_id = ? AND reason = 'stop'", [lou])).toHaveLength(1);

    // Un mail reçu la veille, validé un mardi à 22 h : refusé pour l'heure seulement, la réponse reste à valider [R01].
    const ari = await t.person('Ari', 'ari@example.test');
    const late = await t.boite.sort(me, t.mail('ari@example.test', 'Bonjour', [], { receivedAt: new Date(TUE_10H - DAY) }));
    if (!late.ok || !late.value.draftId) throw new Error('réponse attendue');
    t.setClock(TUE_10H + 12 * 60 * MIN);
    expect(await t.boite.validate(me, late.value.draftId)).toMatchObject({ ok: false, rule: 'R01' });
    expect(await t.outbox()).toHaveLength(0);
    t.setClock(TUE_10H + DAY);
    expect(await t.boite.validate(me, late.value.draftId)).toMatchObject({ ok: true, value: { status: 'parti' } });
    expect((await t.outbox()).map((o) => o.person_id)).toEqual([ari]);
  });

  it('[R411] la réponse préparée cite ce qu’elle reprend du dossier : chaque fait renvoie à sa ligne, rien d’autre n’est dit', async () => {
    const t = await setup();
    const me = t.asAgent(t.alex.id);
    const noa = await t.person('Noa', 'noa@example.test');
    await t.store.createProject({ networkId: t.network.id, agentId: t.alex.id, personId: noa, kind: 'sell' });
    // Un rendez-vous jeudi 14 octobre à 14 h 30, heure de Paris.
    await t.db.run(
      "INSERT INTO appointments (id, network_id, agent_id, person_id, property_id, kind, start_at, end_at, status, token_hash, source, created_at, updated_at) VALUES ('rdv-1', ?, ?, ?, NULL, 'estimation', '2027-10-14T12:30:00.000Z', '2027-10-14T13:30:00.000Z', 'booked', 'h-1', 'agent', ?, ?)",
      [t.network.id, t.alex.id, noa, new Date(TUE_10H).toISOString(), new Date(TUE_10H).toISOString()],
    );
    const r = await t.boite.sort(me, t.mail('noa@example.test', 'Voici les documents', [att('taxe fonciere.pdf', 'application/pdf', pdf('tf')), att('plan.pdf', 'application/pdf', pdf('plan'))]));
    if (!r.ok || !r.value.draftId) throw new Error('réponse attendue');
    const drafts = await t.boite.drafts(me);
    if (!drafts.ok) throw new Error('liste attendue');
    const { sentences, body } = drafts.value[0]!;
    expect(sentences.map((s) => s.text)).toEqual([
      'Bonjour Noa,',
      'Bien reçu vos 2 pièces jointes, elles sont rangées dans votre dossier.',
      'Je vous confirme notre rendez-vous du 14/10 à 14 h 30.',
      'Je reviens vers vous très vite.',
      'Alex',
    ]);
    expect(body).toBe(sentences.map((s) => s.text).join('\n\n'));
    for (const s of sentences) {
      // Une phrase sans source ne reprend rien : ni chiffre, ni prénom.
      if (s.sources.length === 0) {
        expect(s.text).not.toMatch(/\d|Noa|Alex/);
        continue;
      }
      for (const src of s.sources) {
        const row = await t.db.first<Record<string, unknown>>(`SELECT * FROM ${src.table} WHERE id = ?`, [src.id]);
        expect(row, `${src.table}:${src.id}`).not.toBeNull();
        expect(row![src.field]).not.toBeNull();
        if (src.table === 'persons' || src.table === 'agents') expect(s.text).toContain(String(row![src.field]));
        if (src.table === 'mailbox_attachments') expect(row!['first_mail_id']).toBe(r.value.mailId);
        if (src.table === 'appointments') expect(row!['start_at']).toBe('2027-10-14T12:30:00.000Z');
      }
    }
    expect(sentences[1]!.sources).toHaveLength(2);
    // Le contrôle central accepte ses chiffres : ce sont ceux du dossier [R10].
    expect(await t.boite.validate(me, r.value.draftId)).toMatchObject({ ok: true, value: { status: 'parti' } });
  });
});
