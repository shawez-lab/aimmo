import { describe, expect, it } from 'vitest';
import { ALL_TERMS, AvantContrat, LectureProjet, amountOn, dayOn, excerptsOf, monthsOn, verifyReading, type DraftExcerpt, type DraftReader } from '../src/avant-contrat/index.ts';
import { PROOF, setupDossier } from './dossiers-jeu.ts';
import { describeWithSqlite } from './sqlite.ts';

// Projet de compromis, montants, dates, noms et coordonnées inventés. Mercredi 10 mars 2027, 10 h à Paris.
const WED_10H = new Date('2027-03-10T09:00:00.000Z');

const PAGES = [
  'COMPROMIS DE VENTE\nEntre M. Paul Exemple, demeurant 4 rue des Essais, 21000 Dijon\nné le 2 février 1970 à Beaune\nTéléphone 06 11 22 33 44, paul@exemple.test',
  'PRIX\nLa vente est consentie moyennant le prix de 205 000,00 euros (deux cent cinq mille euros).',
  'Le vendeur déclare que le bien est libre.',
  "CONDITIONS SUSPENSIVES\nCondition suspensive d'obtention d'un prêt de 150 000 € sur une durée de 20 ans au taux maximum de 4 %.\nL'acquéreur devra justifier de l'obtention du prêt au plus tard le 30 avril 2027.",
  "DÉPÔT DE GARANTIE\nL'acquéreur verse la somme de 10 000 € entre les mains du notaire soussigné, séquestre.\nVirement sur le compte IBAN FR76 3000 6000 0112 3456 7890 189, BIC AGRIFRPP.",
  'Carte nationale d’identité n° 123456789012 délivrée le 1er janvier 2020.',
  "RÉITÉRATION\nLa signature de l'acte authentique aura lieu au plus tard le 15/06/2027.",
];

/** Ce qu'un lecteur exact rendrait du projet ci-dessus. */
const EXACT = {
  priceEur: { value: 205000, page: 2 },
  conditions: [{ kind: 'pret', amountEur: 150000, durationMonths: 240, page: 4 }],
  loanDeadline: { value: '2027-04-30', page: 4 },
  deedBy: { value: '2027-06-15', page: 7 },
  deposit: { eur: 10000, holder: 'notaire', page: 5 },
};

class FakeReader implements DraftReader {
  seen: DraftExcerpt[][] = [];
  constructor(private readonly answer: (excerpts: DraftExcerpt[]) => Promise<unknown>) {}
  read(excerpts: DraftExcerpt[]): Promise<unknown> {
    this.seen.push(excerpts);
    return this.answer(excerpts);
  }
}

let refs = 0;
async function setup(reader: DraftReader | null, o: { timeoutMs?: number } = {}) {
  const t = await setupDossier('appartement');
  await t.startCompromis();
  t.setClock(WED_10H);
  t.storage.refs.add(PROOF);
  const lp = new LectureProjet(t.db, t.acces, t.journal, t.storage, reader, { now: t.now, ...(o.timeoutMs === undefined ? {} : { timeoutMs: o.timeoutMs }) });
  const ac = new AvantContrat(t.db, t.acces, t.journal, t.storage, { now: t.now });
  const doc = () => {
    refs += 1;
    const ref = `preuves/0b6f1d2e-6666-4a2b-8c3d-${String(refs).padStart(12, '0')}.pdf`;
    t.storage.refs.add(ref);
    return ref;
  };
  return { ...t, lp, ac, doc };
}

describe('RC39 · lire un terme sur sa page', () => {
  it('[R511] montants, dates et durées retrouvés sous leurs écritures courantes, jamais dans un nombre plus long', () => {
    expect(amountOn('le prix de 205 000,00 euros', 205000)).toBe(true);
    expect(amountOn('le prix de 205 000 €', 205000)).toBe(true);
    expect(amountOn('le prix de 205.000 €', 205000)).toBe(true);
    expect(amountOn('le prix de 205000 €', 205000)).toBe(true);
    expect(amountOn('le prix de 1 205 000 €', 205000)).toBe(false);
    expect(amountOn('le prix de 205 0001 €', 205000)).toBe(false);
    expect(amountOn('le prix de 210 000 €', 205000)).toBe(false);
    expect(amountOn('le prix de 205 000 001 €', 205000)).toBe(false);
    expect(amountOn('soit 205 000 € payés le 2 mai', 205000)).toBe(true);
    expect(dayOn('au plus tard le 30 avril 2027', '2027-04-30')).toBe(true);
    expect(dayOn('au plus tard le 30/04/2027', '2027-04-30')).toBe(true);
    expect(dayOn('le 1er août 2027', '2027-08-01')).toBe(true);
    expect(dayOn('le 5.2.2027', '2027-02-05')).toBe(true);
    expect(dayOn('le 30 avril 2028', '2027-04-30')).toBe(false);
    expect(dayOn('le 130/04/2027', '2027-04-30')).toBe(false);
    expect(monthsOn('sur une durée de 20 ans', 240)).toBe(true);
    expect(monthsOn('sur 240 mois', 240)).toBe(true);
    expect(monthsOn('sur 25 ans', 240)).toBe(false);
  });

  it('[R511] un lecteur exact : chaque terme proposé avec sa page, rien à lire', () => {
    expect(verifyReading(PAGES, EXACT)).toEqual({
      proposal: {
        priceEur: { value: 205000, page: 2 },
        conditions: [{ kind: 'pret', amountEur: 150000, durationMonths: 240, page: 4 }],
        loanDeadline: { value: '2027-04-30', page: 4 },
        deedBy: { value: '2027-06-15', page: 7 },
        deposit: { eur: 10000, page: 5, holder: 'notaire' },
      },
      toRead: [],
    });
  });

  it('[R511] une valeur absente de la page citée, ou une page qui n’existe pas, n’est jamais proposée : à lire', () => {
    const r = verifyReading(PAGES, {
      priceEur: { value: 210000, page: 2 }, // inventé
      conditions: [{ kind: 'pret', amountEur: 150000, durationMonths: 300, page: 4 }, { kind: 'permis_construire', page: 4 }, { kind: 'autre', page: 4 }],
      loanDeadline: { value: '2027-04-30', page: 2 }, // pas sur cette page
      deedBy: { value: '2027-06-15', page: 9 }, // page inexistante
      deposit: { eur: 12000, holder: 'notaire', page: 5 },
    });
    expect(r.proposal).toEqual({ priceEur: null, conditions: [], loanDeadline: null, deedBy: null, deposit: null });
    expect(r.toRead).toEqual([...ALL_TERMS]);
    // Une réponse sans forme : tout est à lire, rien n'est proposé.
    expect(verifyReading(PAGES, 'le prix est de 205 000 €')).toEqual({ proposal: { priceEur: null, conditions: [], loanDeadline: null, deedBy: null, deposit: null }, toRead: [...ALL_TERMS] });
    // Un terme faux n'emporte pas les autres.
    const one = verifyReading(PAGES, { ...EXACT, priceEur: { value: 205000, page: 3 } });
    expect(one.toRead).toEqual(['prix']);
    expect(one.proposal.deedBy).toEqual({ value: '2027-06-15', page: 7 });
    // Le lecteur ne rend aucune condition, ou en oublie une, alors que ses mots sont dans le projet : à lire.
    expect(verifyReading(PAGES, { ...EXACT, conditions: [] }).toRead).toEqual(['conditions']);
    const two = [...PAGES];
    two[3] = `${PAGES[3]}\nCondition suspensive de la vente préalable d'un autre bien.`;
    expect(verifyReading(two, EXACT).toRead).toEqual(['conditions']);
    expect(verifyReading(two, { ...EXACT, conditions: [...EXACT.conditions, { kind: 'vente_autre_bien', page: 4 }] }).toRead).toEqual([]);
    // Une condition écartée par le projet n'est jamais proposée, même si le lecteur la rend ; la négation passe au lecteur.
    const denied = [...PAGES];
    denied[3] = `${PAGES[3]}\nLa vente n'est pas soumise à l'obtention d'un permis de construire.`;
    const rd = verifyReading(denied, { ...EXACT, conditions: [...EXACT.conditions, { kind: 'permis_construire', page: 4 }] });
    expect(rd.proposal.conditions).toEqual([{ kind: 'pret', amountEur: 150000, durationMonths: 240, page: 4 }]);
    expect(rd.toRead).toEqual(['conditions']);
    expect(excerptsOf([denied[3]!])[0]!.lines.at(-1)).toBe("La vente n'est pas soumise à l'obtention d'un permis de construire.");
    // Un projet sans aucun mot de condition, et un lecteur qui n'en rend aucune : rien à lire de ce côté.
    const cash = PAGES.map((p, i) => (i === 3 ? 'Paiement comptant.' : p));
    expect(verifyReading(cash, { ...EXACT, conditions: [], loanDeadline: null }).toRead).toEqual(['date_limite_pret']);
  });

  it('[R512] le destinataire du dépôt n’est proposé que si la ligne du montant le nomme, et lui seul', () => {
    const pages = [...PAGES];
    // Le lecteur dit « notaire », la ligne dit « agence » : le montant est proposé, le destinataire est à lire.
    pages[4] = "DÉPÔT DE GARANTIE\nL'acquéreur verse la somme de 10 000 € à l'agence, qui la conserve.\nLe notaire sera informé.";
    const r = verifyReading(pages, EXACT);
    expect(r.proposal.deposit).toEqual({ eur: 10000, page: 5, holder: null });
    expect(r.toRead).toEqual(['depot_garantie.detenteur']);
    // La ligne nomme l'agence : proposé tel quel, la comparaison le dira bloquant.
    expect(verifyReading(pages, { ...EXACT, deposit: { eur: 10000, holder: 'agence', page: 5 } }).proposal.deposit).toEqual({ eur: 10000, page: 5, holder: 'agence' });
    // Deux destinataires sur la même ligne : à lire.
    pages[4] = "L'acquéreur verse la somme de 10 000 € au notaire, qui la remettra au vendeur.";
    expect(verifyReading(pages, EXACT).proposal.deposit).toEqual({ eur: 10000, page: 5, holder: null });
  });

  it('[R15] seules les lignes utiles partent au lecteur ; IBAN, BIC, pièce d’identité et naissance jamais, mails et téléphones masqués', () => {
    const ex = excerptsOf(PAGES);
    const sent = JSON.stringify(ex);
    expect(sent).not.toMatch(/FR76|AGRIFRPP|IBAN|BIC/);
    expect(sent).not.toMatch(/123456789012|identit/);
    expect(sent).not.toMatch(/1970|Beaune|Paul|rue des Essais/);
    expect(sent).not.toContain('libre');
    expect(ex.map((e) => e.page)).toEqual([2, 4, 5, 7]);
    expect(ex.find((e) => e.page === 5)!.lines).toEqual(['DÉPÔT DE GARANTIE', "L'acquéreur verse la somme de 10 000 € entre les mains du notaire …, séquestre."]);
    expect(ex.find((e) => e.page === 4)!.lines[1]).toBe("Condition suspensive d'obtention d'un prêt de 150 000 € sur une durée de 20 ans au taux maximum de 4 %.");
    // Une ligne utile qui nomme une personne ou une adresse : ni le nom, ni la rue, ni la commune ne sortent.
    const named = excerptsOf(['Prix de vente de 205 000 € pour le bien situé 4 rue des Essais à Dijon, vendu par M. Paul Exemple à Mme Jeanne Essai, Maître Durand notaire.']);
    expect(named[0]!.lines[0]).toBe('Prix de vente de 205 000 € pour le bien … 4 … des … à …, vendu par … à …, Maître … notaire.');
    const masked = excerptsOf(['Prix payé comptant, contact du notaire : etude@notaires.test ou +33 3 80 00 00 00 ou 03.80.11.22.33, dossier 12345678901234']);
    expect(masked[0]!.lines[0]).toBe('Prix payé comptant, … du notaire : … ou … ou …');
    const phones = excerptsOf(['Prix de vente : 205 000 €. Contact du notaire : +33 (0)6 11 22 33 44, 06/11/22/33/44 ou (03) 80 11 22 33 ; acte au plus tard le 15/06/2027, prêt de 1 205 000 € sur 240 mois.']);
    expect(phones[0]!.lines[0]).toBe('Prix de vente : 205 000 €. … du notaire : … ou … ; acte au plus tard le 15/06/2027, prêt de 1 205 000 € sur 240 mois.');
    expect(phones[0]!.lines[0]).not.toMatch(/33|44/);
  });
});

describeWithSqlite('RC39 · le projet du notaire prélu, chaque terme retrouvé sur sa page (Jamais vu)', () => {
  it('[R511] la prélecture propose ce qui est retrouvé, l’agent confirme et range par recordDraft ; la prélecture ne range rien', async () => {
    const reader = new FakeReader(async () => EXACT);
    const t = await setup(reader);
    const r = await t.lp.preRead(t.agent, t.fileId, { documentRef: t.doc(), pages: PAGES });
    if (!r.ok) throw new Error(r.code);
    expect(r.value.source).toBe('ia');
    expect(r.value.toRead).toEqual([]);
    expect(reader.seen).toHaveLength(1);
    expect(await t.db.first<{ n: number }>('SELECT COUNT(*) AS n FROM notary_drafts WHERE file_id = ?', [t.fileId])).toEqual({ n: 0 });
    // Ce que l'agent confirme passe tel quel dans recordDraft, et la comparaison ne voit rien.
    await t.ac.prepare(t.agent, t.fileId, { depositEur: 10000, loanDeadline: '2027-04-30', deedBy: '2027-06-15' });
    const p = r.value.proposal;
    const rec = await t.ac.recordDraft(t.agent, t.fileId, { documentRef: t.doc(), priceEur: p.priceEur, conditions: p.conditions, loanDeadline: p.loanDeadline, deedBy: p.deedBy, deposit: p.deposit });
    expect(rec).toMatchObject({ ok: true, value: { differences: [] } });
  });

  it('[R12] lecteur absent, en panne, trop lent ou illisible : un formulaire vide, tout à lire, jamais une erreur', async () => {
    const empty = { source: 'manuel', proposal: { priceEur: null, conditions: [], loanDeadline: null, deedBy: null, deposit: null }, toRead: [...ALL_TERMS] };
    for (const reader of [
      null,
      new FakeReader(async () => {
        throw new Error('panne');
      }),
      new FakeReader(() => new Promise(() => {})),
      new FakeReader(async () => null),
      new FakeReader(async () => 'je ne sais pas'),
    ]) {
      const t = await setup(reader, { timeoutMs: 20 });
      expect(await t.lp.preRead(t.agent, t.fileId, { documentRef: t.doc(), pages: PAGES })).toEqual({ ok: true, value: empty });
    }
    // Rien d'utile dans les pages : le lecteur n'est pas appelé.
    const reader = new FakeReader(async () => EXACT);
    const t = await setup(reader);
    expect(await t.lp.preRead(t.agent, t.fileId, { documentRef: t.doc(), pages: ['Le vendeur déclare que le bien est libre.'] })).toEqual({ ok: true, value: empty });
    expect(reader.seen).toHaveLength(0);
  });

  it('[R13] au journal : la source et les noms des termes, aucun montant ni date', async () => {
    const t = await setup(new FakeReader(async () => ({ ...EXACT, priceEur: { value: 210000, page: 2 } })));
    await t.lp.preRead(t.agent, t.fileId, { documentRef: t.doc(), pages: PAGES });
    const ev = (await t.journal.bySubject(`sale_file:${t.fileId}`)).filter((e) => e.type === 'avant_contrat.prelecture').at(-1)!;
    expect(ev.data).toEqual({ rule: 'R511', source: 'ia', proposed: ['condition.pret', 'date_limite_pret', 'acte_prevu', 'depot_garantie.montant', 'depot_garantie.detenteur'], toRead: ['prix'] });
    expect(JSON.stringify(ev.data)).not.toMatch(/2027|205|210|150|240|10 ?000/);
  });

  it('[R16] seul l’agent du bien prélit ; direction, conformité et un autre agent refusés au journal', async () => {
    const reader = new FakeReader(async () => EXACT);
    const t = await setup(reader);
    const compliance = { role: 'compliance' as const, networkId: t.network.id, userId: 'c-1' };
    for (const v of [t.direction, compliance]) {
      expect(await t.lp.preRead(v, t.fileId, { documentRef: t.doc(), pages: PAGES })).toEqual({ ok: false, rule: 'R16', code: 'role' });
    }
    expect(await t.lp.preRead(t.sam, t.fileId, { documentRef: t.doc(), pages: PAGES })).toMatchObject({ ok: false, rule: 'R16' });
    expect(reader.seen).toHaveLength(0);
    const refused = (await t.journal.bySubject(`sale_file:${t.fileId}`)).filter((e) => e.type === 'acces.refuse');
    expect(refused.length).toBeGreaterThanOrEqual(3);
  });

  it('[R511] projet mal nommé, absent du stockage ou pages mal formées : refusé avant tout appel au lecteur', async () => {
    const reader = new FakeReader(async () => EXACT);
    const t = await setup(reader);
    expect(await t.lp.preRead(t.agent, t.fileId, { documentRef: 'projet.pdf', pages: PAGES })).toEqual({ ok: false, rule: null, code: 'bad_document' });
    expect(await t.lp.preRead(t.agent, t.fileId, { documentRef: 'preuves/0b6f1d2e-6666-4a2b-8c3d-999999999999.pdf', pages: PAGES })).toEqual({ ok: false, rule: null, code: 'not_stored' });
    for (const pages of [[], 'texte', [1], Array(201).fill('prix'), ['x'.repeat(20_001)]]) {
      expect(await t.lp.preRead(t.agent, t.fileId, { documentRef: t.doc(), pages })).toEqual({ ok: false, rule: null, code: 'bad_pages' });
    }
    expect(await t.lp.preRead(t.agent, 'inconnu', { documentRef: t.doc(), pages: PAGES })).toEqual({ ok: false, rule: null, code: 'unknown_file' });
    expect(reader.seen).toHaveLength(0);
  });
});
