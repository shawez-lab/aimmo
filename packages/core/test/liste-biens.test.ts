import { describe, expect, it } from 'vitest';
import { LISTINGS_PER_PAGE, communeSlug, parseListingsQuery, renderListingsPage, selectListings, type ListingGate } from '../src/attirer/liste-biens.ts';
import type { PublishedListing } from '../src/attirer/referencement.ts';
import { BUDGETS, budgetProblems, htmlProblems } from '../src/design/audit.ts';

const AT = new Date('2027-07-06T08:05:00.000Z');
const NET = 'reseau-test';
const q = (over: Partial<{ commune: string | null; page: number }> = {}) => ({ commune: null, page: 1, ...over });
const bien = (n: number, over: Partial<PublishedListing> = {}): PublishedListing => ({
  propertyId: `bien-${String(n).padStart(3, '0')}`,
  agentId: 'agent-a',
  city: 'Dijon',
  state: 'en_vente',
  versionId: `v${n}`,
  title: `Appartement inventé ${n}`,
  priceEur: 200_000 + n,
  day: '2027-07-01',
  mentions: 'Honoraires à la charge du vendeur. Classe énergie C.',
  photo: null,
  ...over,
});
const toutPasse = (): ListingGate & { calls: string[] } => {
  const calls: string[] = [];
  return { calls, canDiffuse: async (_n, id) => (calls.push(id), { allowed: true }) };
};
const render = async (biens: PublishedListing[], query = q()) => {
  const selection = await selectListings(biens, toutPasse(), NET, AT, query);
  return renderListingsPage({ ...selection!, query, checkedAt: AT });
};

describe('RS01 · la liste des biens', () => {
  it('[R220] un bien que la porte refuse n’est pas listé, et la porte reçoit le réseau et l’heure de la lecture', async () => {
    const seen: unknown[] = [];
    const gate: ListingGate = {
      canDiffuse: async (n, id, at) => {
        seen.push([n, id, at]);
        return { allowed: id !== 'bien-002' };
      },
    };
    const s = await selectListings([bien(1), bien(2), bien(3)], gate, NET, AT, q());
    expect(s!.items.map((l) => l.propertyId)).toEqual(['bien-001', 'bien-003']);
    expect(seen[0]).toEqual([NET, 'bien-001', AT]);
  });

  it('[R220] l’heure du contrôle est écrite, à l’heure de Paris', async () => {
    expect(await render([bien(1)])).toContain('Mandats vérifiés le 6 juillet 2027 à 10 h 05');
  });

  it('[R14] du plus récent au plus ancien, le même ordre quel que soit l’agent et sans aucune note', async () => {
    const biens = [bien(1, { day: '2027-07-01', agentId: 'b' }), bien(2, { day: '2027-07-03', agentId: 'a' }), bien(3, { day: '2027-07-02', agentId: 'c' }), bien(4, { day: '2027-07-03', agentId: 'z' })];
    const ordre = async (l: PublishedListing[]) => (await selectListings(l, toutPasse(), NET, AT, q()))!.items.map((x) => x.propertyId);
    expect(await ordre(biens)).toEqual(['bien-002', 'bien-004', 'bien-003', 'bien-001']);
    expect(await ordre([...biens].reverse())).toEqual(['bien-002', 'bien-004', 'bien-003', 'bien-001']);
  });

  it('[R220] le nombre de contrôles reste borné par la page demandée', async () => {
    const biens = Array.from({ length: 200 }, (_, i) => bien(i));
    const gate = toutPasse();
    const s = await selectListings(biens, gate, NET, AT, q());
    expect(s!.items).toHaveLength(LISTINGS_PER_PAGE);
    expect(s!.hasNext).toBe(true);
    expect(gate.calls).toHaveLength(LISTINGS_PER_PAGE + 1);
  });

  it('les pages se suivent sans trou ni doublon, même quand la porte en refuse ; une page au-delà de la fin est inconnue', async () => {
    const biens = Array.from({ length: 60 }, (_, i) => bien(i));
    const gate: ListingGate = { canDiffuse: async (_n, id) => ({ allowed: Number(id.slice(-3)) % 5 !== 0 }) };
    const vus: string[] = [];
    let page = 1;
    for (;;) {
      const s = await selectListings(biens, gate, NET, AT, q({ page }));
      vus.push(...s!.items.map((l) => l.propertyId));
      if (!s!.hasNext) break;
      page += 1;
    }
    expect(page).toBe(2);
    expect(vus).toHaveLength(48);
    expect(new Set(vus).size).toBe(48);
    expect(await selectListings(biens, gate, NET, AT, q({ page: 3 }))).toBeNull();
  });

  it('une seule page sans bien dit qu’il n’y en a pas, sans erreur', async () => {
    expect(await selectListings([], toutPasse(), NET, AT, q())).toEqual({ items: [], hasNext: false, communes: [] });
    expect(await render([])).toContain('Aucun bien en vente en ce moment.');
  });

  it('le filtre par commune : accents et tirets, commune inconnue refusée, commune dont tout est retiré dite vide', async () => {
    expect(communeSlug('Saint-Apollinaire')).toBe('saint-apollinaire');
    expect(communeSlug('Fontaine-lès-Dijon')).toBe('fontaine-les-dijon');
    const biens = [bien(1, { city: 'Dijon' }), bien(2, { city: 'Fontaine-lès-Dijon' })];
    const s = await selectListings(biens, toutPasse(), NET, AT, q({ commune: 'fontaine-les-dijon' }));
    expect(s!.items.map((l) => l.propertyId)).toEqual(['bien-002']);
    expect(s!.communes.map((c) => c.name)).toEqual(['Dijon', 'Fontaine-lès-Dijon']);
    expect(await selectListings(biens, toutPasse(), NET, AT, q({ commune: 'beaune' }))).toBeNull();
    const refuse: ListingGate = { canDiffuse: async () => ({ allowed: false }) };
    const vide = await selectListings(biens, refuse, NET, AT, q({ commune: 'dijon' }));
    expect(renderListingsPage({ ...vide!, query: q({ commune: 'dijon' }), checkedAt: AT })).toContain('Aucun bien en vente en ce moment à Dijon.');
  });

  it.each([['page=0'], ['page=abc'], ['page=-1'], ['page=99999'], ['commune=DIJON'], ['commune=a%2Fb'], ['autre=1'], ['page=1&page=2']])('un paramètre inattendu est refusé : %s', (texte) => {
    expect(parseListingsQuery(new URLSearchParams(texte))).toBeNull();
  });

  it('un paramètre attendu est lu', () => {
    expect(parseListingsQuery(new URLSearchParams(''))).toEqual({ commune: null, page: 1 });
    expect(parseListingsQuery(new URLSearchParams('commune=dijon&page=2'))).toEqual({ commune: 'dijon', page: 2 });
  });

  it('[R44] [R46] prix et mentions de la version publiée, tout échappé, aucune adresse', async () => {
    const html = await render([bien(1, { title: 'Maison <b>inventée</b>', priceEur: 321_000, city: null })]);
    expect(html).toContain('Maison &lt;b&gt;inventée&lt;/b&gt;');
    expect(html).not.toContain('<b>inventée');
    expect(html).toMatch(/321.000/);
    expect(html).toContain('Honoraires à la charge du vendeur. Classe énergie C.');
    expect(html).toContain('/biens/bien-001');
    expect(html).not.toMatch(/\brue\b|\bavenue\b|21000/i);
  });

  it('[R48] une photo d’aménagement virtuel porte sa mention sur l’image ; une photo ordinaire n’en porte pas', async () => {
    const virtuel = await render([bien(1, { photo: { ref: 'biens/bien-001/photo.webp', overlay: 'Aménagement virtuel' } })]);
    expect(virtuel).toContain('src="/medias/biens/bien-001/photo.webp"');
    expect(virtuel).toContain('alt="Photo du bien, aménagement virtuel"');
    expect(virtuel).toContain('<span class="virtuel">Aménagement virtuel</span>');
    const ordinaire = await render([bien(1, { photo: { ref: 'biens/bien-001/photo.webp', overlay: null } })]);
    expect(ordinaire).toContain('alt="Photo du bien"');
    expect(ordinaire).not.toContain('class="virtuel"');
  });

  it('[R07] « agents immobiliers », jamais « mandataire »', async () => {
    const html = await render([bien(1)]);
    expect(html).toContain('agents immobiliers');
    expect(html).not.toMatch(/mandataire/i);
  });

  it('les liens de pages gardent la commune', async () => {
    const biens = Array.from({ length: 60 }, (_, i) => bien(i));
    const html = await render(biens, q({ commune: 'dijon', page: 2 }));
    expect(html).toContain('rel="prev" href="/biens?commune=dijon"');
    expect(html).toContain('rel="next" href="/biens?commune=dijon&amp;page=3"');
  });

  it('[R201] une page pleine passe le système de design et tient dans son budget', async () => {
    const biens = Array.from({ length: 60 }, (_, i) => bien(i, { city: i % 2 ? 'Dijon' : 'Talant', photo: { ref: `biens/bien-${i}/photo.webp`, overlay: i % 3 ? null : 'Aménagement virtuel' } }));
    const html = await render(biens);
    expect(htmlProblems(html)).toEqual([]);
    expect(budgetProblems({ html }, BUDGETS.page)).toEqual([]);
  });
});
