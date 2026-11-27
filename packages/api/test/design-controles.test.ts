import { describe, expect, it } from 'vitest';
import { renderEstimationPage } from '../../core/src/attirer/page-estimation.ts';
import { renderSiteHome } from '../../core/src/attirer/accueil-site.ts';
import { renderLegalNotice, withLegalLinks } from '../../core/src/attirer/mentions-site.ts';
import { renderListingPage } from '../../core/src/annonces/page-bien.ts';
import { HAUTEUR_MAX, appScreens, filledButtonProblems, filledButtons, htmlProblems, screenCssProblems, screenHeightProblems } from '../../core/src/design/audit.ts';
import { AGENT_APP_FILES } from '../src/agent-app.ts';
import { handleCandidature } from '../src/candidature.ts';
import { PARTNER_SPACE_FILES } from '../src/partenaires.ts';

/**
 * DS087 · deux contrôles de plus au système de design : un seul bouton plein par écran (DS022), et une hauteur d'écran
 * bornée. Tout est inventé : visiteur, agent, bien.
 */
const ESTIMATION = { visitorId: 'visite-0000000000000001', appointmentHref: '/agents' };
const RESULT = { ok: true as const, value: { town: 'Ville-Test', postalCode: '21990', kind: 'house' as const, perM2: { low: 2000, median: 2500, high: 3000 }, sales: 24, period: { from: '2024-01', to: '2024-12' }, data: { lastSale: '2025-12-30', source: 'DVF test', recentMissing: false }, next: 'appointment' as const } };

async function pages(): Promise<{ name: string; html: string; sections?: boolean }[]> {
  const candidature = await handleCandidature(new Request('https://aimmo.example.test/rejoindre'), { db: null as never, networkId: 'n1' });
  return [
    { name: 'application de l’agent', html: AGENT_APP_FILES['/app/']!, sections: true },
    { name: 'espace partenaire', html: PARTNER_SPACE_FILES['/partenaire/']!, sections: true },
    { name: 'estimation en ligne', html: renderEstimationPage({ ...ESTIMATION, open: true }) },
    { name: 'estimation en ligne, sa fourchette', html: renderEstimationPage({ ...ESTIMATION, open: true, values: { postalCode: '21990', town: 'Ville-Test', kind: 'maison' }, result: RESULT }) },
    { name: 'estimation pas encore ouverte', html: renderEstimationPage({ ...ESTIMATION, open: false }) },
    { name: 'candidature', html: await candidature!.text() },
    { name: 'accueil du réseau', html: renderSiteHome({ kind: 'reseau', recruiting: true, agent: null, listings: [], checkedAt: new Date(0) }) },
    { name: 'mentions légales', html: withLegalLinks(renderLegalNotice({ values: {}, cardNumber: null, cardHolder: null, missing: ['x'], launchClosedBy: [] })) },
    {
      name: 'page du bien',
      html: renderListingPage({
        payload: { reference: 'REF-D-1', version: 1, state: 'en_vente', title: 'Maison 5 pièces à Talant', body: 'Un jardin clos.', mentions: 'Prix : 320 000 € honoraires inclus.\nClasse énergie D, classe climat B.', priceEur: 320000, media: [] },
        agent: { firstName: 'Alex', lastName: 'Exemple', phone: '03 00 00 00 00', email: 'alex@exemple.test' },
        photos: [],
      }),
    },
  ];
}

describe('DS087 · le contrôle compte les boutons pleins et la hauteur des écrans', () => {
  it('[R201] un bouton plein est un <button> sans classe filaire ou texte, ou un lien .appel sans classe filaire', () => {
    const html =
      '<button>Signer</button><button class="secondaire">Plus tard</button><button class="second">Autre</button>' +
      '<button class="retour">Retour</button><button class="discret">Annuler</button><button class="danger">Supprimer</button>' +
      '<a class="appel" href="/a">Appeler</a><a class="appel secondaire" href="/b">Écrire</a><a href="/c">Lire</a>' +
      '<button aria-label="Fermer"></button>';
    expect(filledButtons(html)).toEqual(['Signer', 'Supprimer', 'Appeler', 'Fermer']);
  });

  it('[R201] un écran qui a deux boutons pleins est signalé, avec leurs libellés ; un seul passe', () => {
    expect(filledButtonProblems('<!doctype html><main><button>Envoyer</button><a class="appel" href="/x">Appeler</a></main>')).toEqual(['page : 2 boutons pleins pour 1 (Envoyer · Appeler)']);
    expect(filledButtonProblems('<!doctype html><main><button>Envoyer</button><button class="secondaire">Plus tard</button></main>')).toEqual([]);
    // Un bouton caché compte : le jour où le script le montre, il partage l'écran.
    expect(filledButtonProblems('<main><button hidden>Reprendre</button><button>Entrer</button></main>')).toHaveLength(1);
    // Ce que le script ou la feuille contiennent ne compte pas.
    expect(filledButtonProblems('<main><button>Entrer</button><script>"<button>x</button>"</script></main>')).toEqual([]);
  });

  it('[R201] dans une application, chaque section de premier rang est un écran ; les sections imbriquées en font partie', () => {
    const app = '<main><section id="a"><button>Un</button><section><button class="second">Deux</button></section></section><section id="b"><button>Trois</button><section><button>Quatre</button></section></section></main>';
    expect(appScreens(app).map((s) => s.id)).toEqual(['a', 'b']);
    expect(filledButtonProblems(app, { screens: 'sections' })).toEqual(['b : 2 boutons pleins pour 1 (Trois · Quatre)']);
    // Deux écrans d'un bouton plein chacun : la page entière en a deux, l'application aucun problème.
    expect(filledButtonProblems('<main><section id="a"><button>Un</button></section><section id="b"><button>Deux</button></section></main>', { screens: 'sections' })).toEqual([]);
  });

  it('[R201] DS022 · chaque écran d’AIMMO a un bouton plein au plus, et reste dans le système de design', async () => {
    const list = await pages();
    for (const p of list) {
      expect(filledButtonProblems(p.html, { screens: p.sections ? 'sections' : 'page' }), p.name).toEqual([]);
      expect(htmlProblems(p.html), p.name).toEqual([]);
    }
    // Le contrôle voit bien les écrans de l'application, et l'estimation garde son action principale.
    expect(appScreens(AGENT_APP_FILES['/app/']!).length).toBeGreaterThan(20);
    const estimation = list.find((p) => p.name === 'estimation en ligne')!.html;
    expect(filledButtons(estimation)).toEqual(['Voir la fourchette']);
    expect(filledButtons(list.find((p) => p.name === 'estimation en ligne, sa fourchette')!.html)).toEqual(['Prendre rendez-vous avec un agent immobilier']);
    expect(filledButtons(list.find((p) => p.name === 'estimation pas encore ouverte')!.html)).toEqual(['Prendre rendez-vous avec un agent immobilier']);
    // Le lien filaire de l'estimation est une règle locale qui ne lit que des jetons.
    expect(screenCssProblems(/<style>([\s\S]*?)<\/style>/.exec(estimation)![1]!)).toEqual([]);
  });

  it('[R201] la hauteur d’un écran est bornée à six fenêtres ; une mesure absente ou illisible n’est jamais un succès', () => {
    expect(HAUTEUR_MAX.ecrans).toBe(6);
    // Les chiffres de l'audit : l'accueil vide, 4 558 px sur 844 ; chargé, 243 424 px.
    expect(screenHeightProblems([{ name: 'accueil vide', heightPx: 4558, viewportPx: 844 }])).toEqual([]);
    expect(screenHeightProblems([{ name: 'accueil chargé', heightPx: 243424, viewportPx: 844 }])).toEqual(['accueil chargé : 288,4 écrans de haut pour 6']);
    expect(screenHeightProblems([{ name: 'juste', heightPx: 6 * 844, viewportPx: 844 }])).toEqual([]);
    expect(screenHeightProblems([{ name: 'un pixel de trop', heightPx: 6 * 844 + 1, viewportPx: 844 }])).toHaveLength(1);
    expect(screenHeightProblems([])).toEqual(['aucune hauteur mesurée']);
    expect(screenHeightProblems([{ name: 'x', heightPx: Number.NaN, viewportPx: 844 }])).toEqual(['x : hauteur illisible']);
    expect(screenHeightProblems([{ name: 'y', heightPx: 900, viewportPx: 0 }])).toEqual(['y : hauteur illisible']);
  });
});
