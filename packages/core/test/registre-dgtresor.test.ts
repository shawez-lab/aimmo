import { describe, expect, it } from 'vitest';
import type { Viewer } from '../src/index.ts';
import { ControleGels, lireRegistreDgTresor } from '../src/securite/index.ts';
import { setupAnnonce } from './annonces-jeu.ts';
import { describeWithSqlite } from './sqlite.ts';

// Un fichier inventé, à la forme du fichier public de la DG Trésor : aucune de ces personnes ni sociétés n'existe.
const NOW = new Date('2027-03-09T09:00:00.000Z');

type Detail = { TypeChamp: string; Valeur: Record<string, unknown>[] };
const prenoms = (...p: string[]): Detail => ({ TypeChamp: 'PRENOM', Valeur: p.map((x) => ({ Prenom: x })) });
const alias = (...a: string[]): Detail => ({ TypeChamp: 'ALIAS', Valeur: a.map((x) => ({ Alias: x, Commentaire: '' })) });
const naissance: Detail = { TypeChamp: 'DATE_DE_NAISSANCE', Valeur: [{ Jour: '01', Mois: '02', Annee: '1970' }] };

function fichier(detail: unknown[], date: unknown = '2027-03-01T10:00:00') {
  return { Publications: { DatePublication: date, PublicationDetail: detail } };
}

const ENTREES = [
  { IdRegistre: 9101, Nature: 'Personne physique', Nom: 'FICTIF', RegistreDetail: [prenoms('Marcel', 'Auguste'), alias('Marcel l’Inventé', 'Иван Петров'), naissance] },
  { IdRegistre: 9102, Nature: 'Personne morale', Nom: 'SOCIETE IMAGINAIRE SARL', RegistreDetail: [alias('IMAGINAIRE TRADING')] },
  { IdRegistre: 9103, Nature: 'Navire', Nom: 'NAVIRE INVENTÉ', RegistreDetail: [] },
  { IdRegistre: 9104, Nature: 'Personne physique', Nom: 'AUTREMENT', RegistreDetail: [prenoms('Léa', 'Marie'), alias('Léa Exemple')] },
];

describe('RC49 · lire le fichier public du registre des gels', () => {
  it('[R605] personnes physiques et morales lues, navire compté à part, date reprise', () => {
    const r = lireRegistreDgTresor(fichier(ENTREES));
    expect(r).toEqual({
      ok: true,
      value: {
        publishedAt: '2027-03-01T09:00:00.000Z',
        vessels: 1,
        entries: [
          // L'alias en cyrillique ne donne aucun mot comparable : laissé, comme `importRegistry` le fait.
          { entryId: '9101', nature: 'personne_physique', names: ['FICTIF Marcel Auguste', 'Marcel l’Inventé'] },
          { entryId: '9102', nature: 'personne_morale', names: ['SOCIETE IMAGINAIRE SARL', 'IMAGINAIRE TRADING'] },
          { entryId: '9104', nature: 'personne_physique', names: ['AUTREMENT Léa Marie', 'Léa Exemple'] },
        ],
      },
    });
  });

  it('nature sans casse ni accents, espaces en trop retirés, alias vide laissé, identifiant texte admis', () => {
    const r = lireRegistreDgTresor(fichier([
      { IdRegistre: 'EU.123.45', Nature: ' PERSONNE  PHYSIQUE ', Nom: '  FICTIF  ', RegistreDetail: [prenoms(' Marcel '), { TypeChamp: 'ALIAS', Valeur: [{ Alias: '   ' }, { Alias: null }, {}] }] },
    ]));
    expect(r).toEqual({ ok: true, value: { publishedAt: '2027-03-01T09:00:00.000Z', vessels: 0, entries: [{ entryId: 'EU.123.45', nature: 'personne_physique', names: ['FICTIF Marcel'] }] } });
  });

  it('[R605] une date sans décalage est à l’heure de Paris, hiver comme été ; avec décalage, telle quelle', () => {
    const at = (d: string) => { const r = lireRegistreDgTresor(fichier([ENTREES[0]], d)); return r.ok ? r.value.publishedAt : r.code; };
    expect(at('2027-01-15T08:30:00')).toBe('2027-01-15T07:30:00.000Z');
    expect(at('2027-07-15T08:30:00.123')).toBe('2027-07-15T06:30:00.000Z');
    expect(at('2027-07-15')).toBe('2027-07-14T22:00:00.000Z');
    expect(at('2027-03-28T03:30:00')).toBe('2027-03-28T01:30:00.000Z');
    expect(at('2027-07-15T08:30:00Z')).toBe('2027-07-15T08:30:00.000Z');
    expect(at('2027-07-15T08:30:00+02:00')).toBe('2027-07-15T06:30:00.000Z');
    expect(at('2027-02-30T08:30:00')).toBe('bad_date');
    expect(at('2027-07-15T25:00:00')).toBe('bad_date');
  });

  it('une entrée de 60 alias se lit entière', () => {
    const many = Array.from({ length: 60 }, (_, i) => `FICTIF Alias${i}`);
    const r = lireRegistreDgTresor(fichier([{ IdRegistre: 1, Nature: 'Personne morale', Nom: 'FICTIF GROUPE', RegistreDetail: [alias(...many)] }]));
    if (!r.ok) throw new Error(r.code);
    expect(r.value.entries[0]!.names).toHaveLength(61);
  });

  it('[R13] un fichier qu’on ne sait pas lire entièrement est refusé entier, avec sa raison, jamais un nom', () => {
    const ok = ENTREES[0]!;
    const cases: [unknown, string, string | null][] = [
      [null, 'bad_file', null],
      [{ Publication: {} }, 'bad_file', null],
      [fichier(ENTREES, null), 'bad_date', null],
      [fichier(ENTREES, 1767225600000), 'bad_date', null],
      [fichier(ENTREES, 'hier'), 'bad_date', null],
      [{ Publications: { DatePublication: '2027-03-01', PublicationDetail: {} } }, 'bad_file', null],
      [fichier([]), 'no_entries', null],
      [fichier([ENTREES[2]]), 'no_entries', null],
      [fichier([ok, 'texte']), 'bad_file', null],
      [fichier([{ ...ok, IdRegistre: undefined }]), 'bad_entry_id', null],
      [fichier([{ ...ok, IdRegistre: -4 }]), 'bad_entry_id', null],
      [fichier([{ ...ok, IdRegistre: 'deux mots' }]), 'bad_entry_id', null],
      [fichier([ok, { ...ENTREES[1], IdRegistre: 9101 }]), 'duplicate_entry', '9101'],
      [fichier([{ ...ok, Nature: 'Aéronef' }]), 'unknown_nature', '9101'],
      [fichier([{ ...ok, Nature: undefined }]), 'unknown_nature', '9101'],
      [fichier([{ ...ok, RegistreDetail: { TypeChamp: 'PRENOM' } }]), 'bad_file', '9101'],
      [fichier([{ ...ok, RegistreDetail: [{ TypeChamp: 'PRENOM', Valeur: 'Marcel' }] }]), 'bad_file', '9101'],
      [fichier([{ ...ok, RegistreDetail: [{ TypeChamp: 'ALIAS', Valeur: [{ Alias: 42 }] }] }]), 'bad_file', '9101'],
      [fichier([{ ...ok, RegistreDetail: [{ Valeur: [] }] }]), 'bad_file', '9101'],
      [fichier([{ ...ok, Nom: 12 }]), 'bad_names', '9101'],
      [fichier([{ ...ok, Nom: '', RegistreDetail: [prenoms('Marcel')] }]), 'bad_names', '9101'],
      [fichier([{ ...ok, Nom: 'Иван', RegistreDetail: [alias('Петров')] }]), 'bad_names', '9101'],
      [fichier([{ ...ok, Nom: 'X'.repeat(201), RegistreDetail: [] }]), 'bad_names', '9101'],
      [fichier([{ ...ok, RegistreDetail: [alias(...Array.from({ length: 200 }, (_, i) => `FICTIF A${i}`))] }]), 'too_many_names', '9101'],
    ];
    for (const [input, code, entryId] of cases) {
      const r = lireRegistreDgTresor(input);
      expect(r, JSON.stringify(input)?.slice(0, 120)).toEqual({ ok: false, code, entryId });
      expect(JSON.stringify(r)).not.toMatch(/FICTIF|Marcel|IMAGINAIRE/);
    }
  });
});

describeWithSqlite('RC49 · le registre lu passe tel quel par l’import', () => {
  it('[R603] [R605] importé sans retouche, une partie au nom d’un alias est trouvée', async () => {
    const t = await setupAnnonce();
    t.setClock(NOW);
    const gels = new ControleGels(t.db, t.acces, t.journal, { now: t.now });
    const conformite = { role: 'compliance', userId: 'conformite-1', networkId: t.network.id } as Viewer;
    const lu = lireRegistreDgTresor(fichier(ENTREES));
    if (!lu.ok) throw new Error(lu.code);
    const r = await gels.importRegistry(conformite, { publishedAt: lu.value.publishedAt, entries: lu.value.entries });
    expect(r).toMatchObject({ ok: true, value: { entries: 3, checked: 1 } });
    const list = await gels.matches(conformite);
    if (!list.ok) throw new Error(list.code);
    // La cliente inventée du jeu, « Léa Exemple », porte le nom d'un alias de l'entrée 9104.
    expect(list.value.map((m) => m.check.matches)).toEqual([[{ personId: t.personId, entryId: '9104' }]]);
    // Une entrée de 60 alias s'importe aussi.
    t.setClock(new Date('2027-03-16T09:00:00.000Z'));
    const many = lireRegistreDgTresor(fichier([...ENTREES, { IdRegistre: 9105, Nature: 'Personne morale', Nom: 'FICTIF GROUPE', RegistreDetail: [alias(...Array.from({ length: 60 }, (_, i) => `FICTIF Alias${i}`))] }], '2027-03-15T10:00:00'));
    if (!many.ok) throw new Error(many.code);
    expect(await gels.importRegistry(conformite, { publishedAt: many.value.publishedAt, entries: many.value.entries })).toMatchObject({ ok: true, value: { entries: 4 } });
  });
});
