/**
 * Le simulateur de prêt du site public (M01, AT08) [R157, R14, R07, R201].
 *
 * Une mensualité de prêt à échéances constantes, plus l'assurance calculée sur le capital emprunté, avec ce que coûte
 * le crédit sur toute sa durée et ce qu'ajoute chaque dixième de point de taux. Le calcul est fait par le code, ici pour
 * l'exemple montré d'emblée, et dans le navigateur de la personne pour ses propres chiffres.
 *
 * Rien n'est gardé [R157] : la page ne dépend d'aucune saisie, ses champs n'ont pas de nom (un formulaire envoyé ne
 * transmettrait rien), son script n'a ni réseau, ni stockage, ni cookie, et ses en-têtes interdisent au navigateur toute
 * connexion et tout envoi de formulaire. Ce module ne connaît ni la base, ni le journal, ni l'envoi.
 *
 * Aucun avis de solvabilité [R14] : ni revenu demandé, ni capacité d'emprunt, ni taux d'endettement.
 */
import { DESIGN_CSS, THEME_COLOR } from '../design/systeme.ts';

/** La mention toujours visible à côté des résultats [R157]. */
export const LOAN_SIMULATOR_NOTICE = 'Simulation indicative : ce n’est pas une offre de prêt.';

/** Les bornes d'une saisie lisible. Les mêmes dans le script de la page. */
export const LOAN_LIMITS = Object.freeze({
  amountEur: Object.freeze({ min: 1000, max: 10_000_000 }),
  years: Object.freeze({ min: 1, max: 35 }),
  ratePct: Object.freeze({ min: 0, max: 20 }),
  insurancePct: Object.freeze({ min: 0, max: 3 }),
});

export interface LoanInput {
  amountEur: number;
  years: number;
  /** Le taux nominal annuel, en pour cent. */
  ratePct: number;
  /** Le taux annuel de l'assurance, en pour cent du capital emprunté. */
  insurancePct: number;
}

export type LoanResult =
  | {
      ok: true;
      months: number;
      creditMonthlyEur: number;
      insuranceMonthlyEur: number;
      totalMonthlyEur: number;
      totalInterestEur: number;
      totalInsuranceEur: number;
      totalCostEur: number;
      /** Ce qu'ajoute à la mensualité du crédit un taux plus haut de 0,1 point. */
      plusTenthMonthlyEur: number;
    }
  | { ok: false; field: keyof LoanInput };

const cents = (v: number): number => Math.round(v * 100) / 100;
const within = (v: number, l: { min: number; max: number }): boolean => Number.isFinite(v) && v >= l.min && v <= l.max;

/** La mensualité d'un capital remboursé en `n` mois au taux mensuel `r`. */
const payment = (p: number, n: number, r: number): number => (r === 0 ? p / n : (p * r) / (1 - Math.pow(1 + r, -n)));

/** Le calcul du simulateur. Une saisie hors des bornes ne donne aucun chiffre et nomme le champ. */
export function simulateLoan(input: LoanInput): LoanResult {
  if (!within(input.amountEur, LOAN_LIMITS.amountEur)) return { ok: false, field: 'amountEur' };
  if (!within(input.years, LOAN_LIMITS.years) || !Number.isInteger(input.years)) return { ok: false, field: 'years' };
  if (!within(input.ratePct, LOAN_LIMITS.ratePct)) return { ok: false, field: 'ratePct' };
  if (!within(input.insurancePct, LOAN_LIMITS.insurancePct)) return { ok: false, field: 'insurancePct' };
  const n = input.years * 12;
  const p = input.amountEur;
  const credit = payment(p, n, input.ratePct / 1200);
  const insurance = (p * input.insurancePct) / 1200;
  const interest = credit * n - p;
  return {
    ok: true,
    months: n,
    creditMonthlyEur: cents(credit),
    insuranceMonthlyEur: cents(insurance),
    totalMonthlyEur: cents(credit + insurance),
    totalInterestEur: cents(interest),
    totalInsuranceEur: cents(insurance * n),
    totalCostEur: cents(interest + insurance * n),
    plusTenthMonthlyEur: cents(payment(p, n, (input.ratePct + 0.1) / 1200) - credit),
  };
}

/** Un montant en euros et centimes, écrit à la française : « 1 209,92 € ». Le même dans le script de la page. */
export function eurosCents(v: number): string {
  const [int, dec] = (Math.round(v * 100) / 100).toFixed(2).split('.');
  return `${int!.replace(/\B(?=(\d{3})+(?!\d))/g, ' ')},${dec} €`;
}

/**
 * Le script de la page : le même calcul, les mêmes bornes et la même écriture que ci-dessus, et rien d'autre. Il ne lit
 * que les champs de la page et n'écrit que ses résultats.
 */
export const LOAN_SIMULATOR_SCRIPT = `(function(){
var d=document,L=${JSON.stringify(LOAN_LIMITS)};
var F=[['montant','amountEur','Le montant va de 1\\u202f000 à 10\\u202f000\\u202f000\\u00a0€.'],['duree','years','La durée est un nombre entier d’années, de 1 à 35.'],['taux','ratePct','Le taux va de 0 à 20\\u00a0%.'],['assurance','insurancePct','L’assurance va de 0 à 3\\u00a0%.']];
var O=['r-total','r-credit','r-assurance','r-interets','r-cout','r-sensibilite'];
function num(s){s=String(s).replace(/[\\s\\u00a0\\u202f€%]/g,'').replace(',','.');return /^\\d+(\\.\\d+)?$/.test(s)?Number(s):NaN}
function pay(p,n,r){return r===0?p/n:p*r/(1-Math.pow(1+r,-n))}
function eur(v){var t=(Math.round(v*100)/100).toFixed(2).split('.');return t[0].replace(/\\B(?=(\\d{3})+(?!\\d))/g,'\\u202f')+','+t[1]+'\\u00a0€'}
function show(){
var v={},bad=null;
for(var i=0;i<F.length;i++){var el=d.getElementById(F[i][0]),x=num(el.value),l=L[F[i][1]];el.removeAttribute('aria-invalid');
if(bad===null&&(!(x>=l.min&&x<=l.max)||(F[i][1]==='years'&&x%1!==0))){bad=F[i];el.setAttribute('aria-invalid','true')}v[F[i][1]]=x}
var e=d.getElementById('erreur');
if(bad){e.textContent=bad[2];for(var j=0;j<O.length;j++)d.getElementById(O[j]).textContent='—';return}
e.textContent='';
var n=v.years*12,p=v.amountEur,c=pay(p,n,v.ratePct/1200),a=p*v.insurancePct/1200,it=c*n-p;
var r=[c+a,c,a,it,it+a*n,pay(p,n,(v.ratePct+0.1)/1200)-c];
for(var k=0;k<O.length;k++)d.getElementById(O[k]).textContent=eur(r[k]);
}
for(var m=0;m<F.length;m++)d.getElementById(F[m][0]).addEventListener('input',show);
d.getElementById('sim').addEventListener('submit',function(ev){ev.preventDefault();show()});
show();
})();`;

const CSS =
  DESIGN_CSS +
  '.tete{display:flex;justify-content:space-between;align-items:center;gap:var(--e-4);padding:var(--e-4)}' +
  'main{max-width:46rem;margin:0 auto;padding:0 var(--e-4) var(--e-8)}' +
  '.intro{margin:var(--e-6) 0 var(--e-5)}.intro h1{font-size:clamp(2rem,8vw,2.8rem);line-height:1.05;letter-spacing:-.02em}' +
  '.metier{margin:0 0 var(--e-2);font-weight:700;color:var(--accent);letter-spacing:.08em;text-transform:uppercase;font-size:var(--t-xs)}' +
  '.champs{display:grid;gap:0 var(--e-4);grid-template-columns:1fr 1fr}.champs div:first-child{grid-column:1/-1}' +
  '.champs label{margin-top:var(--e-3)}.unite{font-weight:400;color:var(--doux)}' +
  '.resultat{margin:var(--e-5) 0 0;padding:var(--e-5) var(--e-4);background:var(--surface);border-radius:var(--r-l);box-shadow:inset 0 4px 0 var(--accent)}' +
  '.resultat .grand{display:block;font:600 clamp(2.2rem,10vw,3.2rem)/1.05 var(--police-titre);color:var(--accent);margin:var(--e-1) 0 var(--e-4)}' +
  '.resultat dl{display:grid;grid-template-columns:1fr auto;gap:var(--e-2) var(--e-4);margin:0}.resultat dt{color:var(--doux)}.resultat dd{margin:0;text-align:right;font-weight:600}' +
  '.effet{margin:var(--e-4) 0 0;padding-top:var(--e-3);border-top:1px solid var(--trait)}' +
  '.avertissement{margin:var(--e-4) 0 0;padding:var(--e-3) var(--e-4);border-radius:var(--r-m);box-shadow:inset 4px 0 0 var(--moutarde);background:var(--surface);font-weight:600}' +
  '.erreur:empty{display:none}.erreur{margin:var(--e-3) 0 0;color:var(--danger);font-weight:600}' +
  'input[aria-invalid=true]{border-color:var(--danger)}' +
  '@media (max-width:22rem){.champs{grid-template-columns:1fr}}';

const DEFAULT = Object.freeze({ amountEur: 200000, years: 20, ratePct: 3.5, insurancePct: 0.3 });
const frNumber = (v: number): string => String(v).replace('.', ',');

/** La page du simulateur. Elle ne prend aucune saisie : rien de ce que la personne tape n'arrive jamais au serveur. */
export function renderLoanSimulatorPage(): string {
  const r = simulateLoan(DEFAULT);
  if (!r.ok) throw new Error('exemple du simulateur hors des bornes');
  const field = (id: string, label: string, unit: string, value: string, mode: 'decimal' | 'numeric', hint: string) =>
    `<div><label for="${id}">${label} <span class="unite">${unit}</span></label><input id="${id}" type="text" inputmode="${mode}" autocomplete="off" spellcheck="false" value="${value}" aria-describedby="${id}-aide"><p class="doux" id="${id}-aide">${hint}</p></div>`;
  const out = (id: string, value: number) => `<output id="${id}" for="montant duree taux assurance">${eurosCents(value)}</output>`;
  return (
    `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="referrer" content="no-referrer"><meta name="robots" content="index"><meta name="theme-color" content="${THEME_COLOR}"><title>Simulateur de prêt immobilier</title><style>${CSS}</style></head>` +
    `<body><header class="tete"><p class="marque">AIMMO</p></header><div class="frise" aria-hidden="true"></div><main>` +
    `<section class="intro" aria-labelledby="titre"><p class="metier">Votre agent immobilier</p><h1 id="titre">Combien par mois ?</h1>` +
    `<p>Changez un chiffre, le calcul suit. Il se fait dans votre téléphone ou votre ordinateur : rien de ce que vous tapez ne quitte cette page, ni n’est gardé.</p></section>` +
    `<form id="sim" novalidate><div class="champs">` +
    field('montant', 'Montant emprunté', '(€)', '200 000', 'numeric', 'De 1 000 à 10 000 000 €.') +
    field('duree', 'Durée', '(années)', String(DEFAULT.years), 'numeric', 'De 1 à 35 ans.') +
    field('taux', 'Taux du crédit', '(% par an)', frNumber(DEFAULT.ratePct), 'decimal', 'Hors assurance.') +
    field('assurance', 'Assurance', '(% par an)', frNumber(DEFAULT.insurancePct), 'decimal', 'Sur le capital emprunté.') +
    `</div><p class="erreur" id="erreur" role="alert"></p><button type="submit">Calculer</button></form>` +
    `<section class="resultat" aria-labelledby="t-res" aria-live="polite"><h2 id="t-res">Mensualité, assurance comprise</h2><span class="grand chiffres">${out('r-total', r.totalMonthlyEur)}</span>` +
    `<dl class="chiffres"><dt>Crédit seul, par mois</dt><dd>${out('r-credit', r.creditMonthlyEur)}</dd><dt>Assurance, par mois</dt><dd>${out('r-assurance', r.insuranceMonthlyEur)}</dd>` +
    `<dt>Intérêts sur toute la durée</dt><dd>${out('r-interets', r.totalInterestEur)}</dd><dt>Coût total du crédit, assurance comprise</dt><dd>${out('r-cout', r.totalCostEur)}</dd></dl>` +
    `<p class="effet">Chaque 0,1 point de taux en plus : <strong class="chiffres">${out('r-sensibilite', r.plusTenthMonthlyEur)}</strong> de plus par mois.</p>` +
    `<p class="avertissement">${LOAN_SIMULATOR_NOTICE}</p>` +
    `<p class="doux">Mensualités constantes, assurance calculée sur le capital emprunté, hors frais de dossier, de garantie et de notaire. Votre banque ou votre courtier vous donnera le coût exact.</p></section>` +
    `</main><script>${LOAN_SIMULATOR_SCRIPT}</script></body></html>`
  );
}

const sha256 = async (text: string): Promise<string> => {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  let bin = '';
  for (const b of digest) bin += String.fromCharCode(b);
  return `'sha256-${btoa(bin)}'`;
};

/**
 * Les en-têtes de la page : le navigateur n'exécute que son script et sa feuille, reconnus par leur empreinte, et n'ouvre
 * aucune connexion ni aucun envoi de formulaire. C'est la preuve, vérifiable par chacun, que rien ne part [R157].
 */
export async function loanSimulatorHeaders(): Promise<Record<string, string>> {
  const csp = [
    "default-src 'none'",
    `script-src ${await sha256(LOAN_SIMULATOR_SCRIPT)}`,
    `style-src ${await sha256(CSS)}`,
    "img-src 'none'",
    "connect-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
  return {
    'content-type': 'text/html; charset=utf-8',
    'content-security-policy': csp,
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'cache-control': 'public, max-age=3600',
  };
}
