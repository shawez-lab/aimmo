import { expect, it } from 'vitest';
import { fundSignals } from '../src/dossiers/bouclier.ts';
import { IBAN_MASK, fundsInOutgoing, maskIban } from '../src/envoi/texte.ts';

// RC73 : ce que le bouclier voit, le socle le masque et le refuse. Le bouclier (`dossiers/bouclier.ts`, voie 2) alerte
// l'agent ; le socle (`envoi/texte.ts` et `envoi/iban-detours.ts`) masque l'IBAN du message rangé [R15] et refuse tout
// texte d'AIMMO qui donne des coordonnées bancaires ou demande un paiement [R62]. Les deux lisent les mêmes détours
// avec deux copies du code, qui peuvent s'écarter. Ce test tient l'écart : chaque détour est écrit en clair et caché ;
// quand le bouclier lit le texte caché alors que le socle le laisse passer, l'écart doit être dans `ECARTS_CONNUS`, avec
// la tâche qui le fermera. Un écart nouveau fait tomber le test ; un écart fermé aussi, pour qu'il sorte de la liste.
// Textes et IBAN inventés : la clé est calculée ici.

function withKey(country: string, bban: string): string {
  const s = `${bban}${country}00`.toUpperCase();
  let r = 0;
  for (const ch of s) {
    const v = ch >= '0' && ch <= '9' ? ch : String(ch.charCodeAt(0) - 55);
    for (const d of v) r = (r * 10 + Number(d)) % 97;
  }
  return `${country}${String(98 - r).padStart(2, '0')}${bban}`;
}

const DIGITS = ['zéro', 'un', 'deux', 'trois', 'quatre', 'cinq', 'six', 'sept', 'huit', 'neuf'];
const FR = withKey('FR', '30006000011234567890189');
const BE = withKey('BE', '539007547034');
const BE_SPLIT = withKey('BE', '539030907034'); // BE.. 5390 3090 7034
const BE_SIX = withKey('BE', '539002306000'); // BE.. 5390 0230 6000
const groups = (iban: string, sep = ' '): string => iban.match(/.{1,4}/g)!.join(sep);
const keyWords = (iban: string): string => iban.slice(2, 4).split('').map((d) => DIGITS[Number(d)]!).join(' ');
const spelled = (iban: string, sep: string): string => [...iban].join(sep);
const digitWords = (iban: string): string =>
  `${iban.slice(0, 2).split('').join(' ')} ${[...iban.slice(2)].map((c) => (c >= '0' && c <= '9' ? DIGITS[Number(c)]! : c)).join(' ')}`;
const ZW = '​';
const CYR_O = 'О';
const mathDigits = (s: string): string => [...s].map((c) => (c >= '0' && c <= '9' ? String.fromCodePoint(0x1d7ce + Number(c)) : c)).join('');

interface Detour {
  id: string;
  /** Le même texte, écrit en clair : le socle le refuse, et le masque s'il porte un IBAN. */
  clear: string;
  /** Le texte caché par un détour que le bouclier lit. */
  hidden: string;
  /** Le détour cache un IBAN : le bouclier doit y lire `iban`, et le socle le masquer. */
  iban?: true;
}

const iban = (id: string, value: string, hidden: string): Detour => ({ id, iban: true, clear: `Voici : ${value}, merci.`, hidden: `Voici : ${hidden}, merci.` });

const DETOURS: Detour[] = [
  // L'IBAN caché (RC67 à RC70, RC72).
  iban('iban-epele-espaces', FR, spelled(FR, ' ')),
  iban('iban-epele-points', FR, spelled(FR, '.').toLowerCase()),
  iban('iban-dicte-chiffres', FR, digitWords(FR)),
  iban('iban-groupes-mille', BE, `B E ${keyWords(BE)}, cinq mille trois cent quatre-vingt-dix, zéro sept cent cinquante-quatre, sept mille trente-quatre`),
  iban('iban-invisibles', FR, spelled(FR, ZW)),
  iban('iban-o-cyrillique', FR, groups(FR).replace(/0/, CYR_O)),
  iban('iban-chiffres-mathematiques', FR, mathDigits(groups(FR))),
  iban('iban-dicte-apres-compose', BE_SPLIT, `B E ${keyWords(BE_SPLIT)}, cinq mille trois cent quatre-vingt-dix, trois mille quatre-vingt-dix sept mille trente-quatre`),
  iban('iban-dicte-cent-trente-six-mille', BE_SIX, `B E ${keyWords(BE_SIX)}, cinq mille trois cent quatre-vingt-dix, zéro deux cent trente six mille`),
  // Les mots des coordonnées bancaires (RC66, RC70 à RC72).
  { id: 'rib-points', clear: 'Voici notre RIB à jour', hidden: 'Voici notre R.I.B à jour' },
  { id: 'rib-espaces', clear: 'Notre RIB a changé', hidden: 'Notre r i b a changé' },
  { id: 'iban-points', clear: 'Utilisez ce IBAN.', hidden: 'Utilisez ce I.B.A.N.' },
  { id: 'rib-grec', clear: 'Voici notre RIB à jour', hidden: 'Voici notre RΙΒ à jour' },
  { id: 'iban-invisible-mot', clear: 'Utilisez cet IBAN', hidden: `Utilisez cet I${ZW}BAN` },
  { id: 'rib-leet', clear: 'Voici le nouveau RIB', hidden: 'Voici le nouveau R1B' },
  { id: 'iban-leet', clear: 'Utilisez cet IBAN', hidden: 'Utilisez cet 1BAN' },
  { id: 'bic-leet', clear: 'Le BIC a changé', hidden: 'Le B1C a changé' },
  { id: 'rib-leet-epele', clear: 'Voici le nouveau RIB', hidden: 'Voici le nouveau R 1 B' },
  { id: 'iban-leet-epele', clear: 'Utilisez cet IBAN', hidden: 'Utilisez cet 1-B-A-N' },
  // La demande de paiement (RC70, RC71).
  { id: 'payez-invisible', clear: 'Payez avant vendredi', hidden: `Pay${ZW}ez avant vendredi` },
  { id: 'payez-leet', clear: 'Payez avant vendredi', hidden: 'P@yez avant vendredi' },
  { id: 'virez-leet', clear: 'Virez la somme ce soir', hidden: 'V1rez la somme ce soir' },
];

/**
 * Les écarts connus, chacun avec la tâche qui le fermera. BR109 a fermé ceux relevés par RC73 (mots épelés, leet, leet
 * épelé, IBAN dicté après un nombre composé) : la liste est vide. Un écart nouveau s'y écrit avec sa tâche.
 */
const ECARTS_CONNUS: Record<string, string> = {};

function ecarts(): string[] {
  const out: string[] = [];
  for (const d of DETOURS) {
    const seen = fundSignals(d.hidden);
    if (seen.length === 0) continue;
    if (seen.includes('iban') && maskIban(d.hidden) === d.hidden) out.push(`${d.id}:masque`);
    if (!fundsInOutgoing(d.hidden)) out.push(`${d.id}:sortie`);
  }
  return out.sort();
}

it('le test parle bien : chaque détour est lu par le bouclier, et son texte clair est refusé par le socle', () => {
  for (const d of DETOURS) {
    expect(fundSignals(d.hidden).length, d.id).toBeGreaterThan(0);
    expect(fundsInOutgoing(d.clear), d.id).toBe(true);
    expect(fundSignals(d.hidden).includes('iban'), d.id).toBe(d.iban === true);
    if (d.iban) {
      expect(fundSignals(d.clear), d.id).toContain('iban');
      expect(maskIban(d.clear), d.id).not.toBe(d.clear);
    }
  }
  expect(new Set(DETOURS.map((d) => d.id)).size).toBe(DETOURS.length);
});

it('[R15] [R62] ce que le bouclier lit, le socle le masque et le refuse, hors des écarts connus et nommés', () => {
  expect(ecarts()).toEqual(Object.keys(ECARTS_CONNUS).sort());
});

it('chaque écart connu porte un détour de la liste et la tâche qui le fermera', () => {
  const ids = new Set(DETOURS.map((d) => d.id));
  for (const [k, why] of Object.entries(ECARTS_CONNUS)) {
    const [id, side] = k.split(':');
    expect(ids.has(id!), k).toBe(true);
    expect(['masque', 'sortie'], k).toContain(side);
    expect(why, k).toMatch(/^voie [12] : /);
  }
});

it('[R15] [R62] un IBAN masqué par le socle ne laisse aucun chiffre du compte, et le texte masqué reste refusé à la sortie', () => {
  for (const d of DETOURS) {
    if (!d.iban) continue;
    const m = maskIban(d.hidden);
    if (m === d.hidden) continue; // écart connu, tenu plus haut
    expect(m, d.id).toBe(`Voici : ${IBAN_MASK}, merci.`);
    expect(fundsInOutgoing(m), d.id).toBe(true);
  }
});
