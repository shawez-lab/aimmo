import { describe, expect, it } from 'vitest';
import { GbpError } from '../src/attirer/fiche-google.ts';
import { googleBusinessClient, googleError } from '../src/attirer/fiche-google-reel.ts';

// Tout est inventé : identifiants, secrets, jetons, fiches, avis.
const SECRET = 'secret-invente-0123456789';
const REFRESH = 'jeton-rafraichissement-invente-0123456789';
const ACCESS = 'jeton-acces-invente-0123456789';
const LOC = 'accounts/7/locations/42';

type Call = { method: string; url: string; body: string | null; auth: string | null };
type Answer = { status: number; body?: unknown } | 'coupure';

function fakeHttp(answers: Record<string, Answer[]>) {
  const calls: Call[] = [];
  const http = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    const method = init.method ?? 'GET';
    const headers = (init.headers ?? {}) as Record<string, string>;
    calls.push({ method, url, body: typeof init.body === 'string' ? init.body : null, auth: headers.authorization ?? null });
    const key = Object.keys(answers).find((k) => `${method} ${url}`.startsWith(k));
    const a = key ? answers[key]!.shift() : undefined;
    if (!a) throw new Error(`appel imprévu : ${method} ${url}`);
    if (a === 'coupure') throw new TypeError('connexion coupée');
    return new Response(a.body === undefined ? '' : JSON.stringify(a.body), { status: a.status });
  }) as typeof fetch;
  return { http, calls };
}

const TOKEN_OK = (n = 3): Answer[] => Array.from({ length: n }, () => ({ status: 200, body: { access_token: ACCESS, expires_in: 3600 } }));
const make = (answers: Record<string, Answer[]>, now = () => new Date('2026-11-21T10:00:00.000Z')) => {
  const h = fakeHttp({ 'POST https://oauth2.googleapis.com/token': TOKEN_OK(), ...answers });
  return { ...h, client: googleBusinessClient({ credentials: { clientId: 'x.apps.googleusercontent.com', clientSecret: SECRET, refreshToken: REFRESH }, http: h.http, now, timeoutMs: 50 }) };
};
const codeOf = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return 'aucune erreur';
  } catch (error) {
    // Ni le secret, ni le jeton, ni la réponse de Google dans l'erreur [R13].
    expect(String(error)).not.toMatch(/invente|Bearer/);
    return error instanceof GbpError ? error.code : `autre : ${String(error)}`;
  }
};

describe('AU037 · le vrai client de la fiche Google', () => {
  it('une mise à jour des informations rend l’accusé de Google, sur le nom, le téléphone et le site seuls', async () => {
    const t = make({ 'PATCH https://mybusinessbusinessinformation.googleapis.com/v1/locations/42': [{ status: 200, body: { name: 'locations/42', title: 'Camille' } }] });
    expect(await t.client.updateInfo(LOC, { title: 'Camille Exemple, agent immobilier', phone: '06 00 00 00 00', websiteUri: 'https://camille.exemple.test' })).toEqual({ ref: 'locations/42' });
    const patch = t.calls[1]!;
    expect(patch.url).toBe('https://mybusinessbusinessinformation.googleapis.com/v1/locations/42?updateMask=title%2CphoneNumbers.primaryPhone%2CwebsiteUri');
    expect(patch.auth).toBe(`Bearer ${ACCESS}`);
    expect(JSON.parse(patch.body!)).toEqual({ title: 'Camille Exemple, agent immobilier', phoneNumbers: { primaryPhone: '06 00 00 00 00' }, websiteUri: 'https://camille.exemple.test' });
    // Le jeton est tiré une fois du jeton de rafraîchissement, qui ne part que vers Google.
    expect(t.calls[0]!.body).toContain('grant_type=refresh_token');
    expect(t.calls.filter((c) => c.body?.includes(REFRESH)).map((c) => c.url)).toEqual(['https://oauth2.googleapis.com/token']);
  });

  it('une réponse sans la fiche attendue n’est pas un accusé ; sans téléphone, le téléphone n’est pas touché', async () => {
    const t = make({ 'PATCH https://mybusinessbusinessinformation.googleapis.com/v1/locations/42': [{ status: 200, body: { name: 'locations/43' } }, { status: 200, body: {} }] });
    expect(await codeOf(t.client.updateInfo(LOC, { title: 'Camille', phone: null, websiteUri: 'https://camille.exemple.test' }))).toBe('accuse_absent');
    expect(t.calls[1]!.url).toContain('updateMask=title%2CwebsiteUri');
    expect(await codeOf(t.client.updateInfo('locations/42', { title: 'Camille', phone: null, websiteUri: 'https://camille.exemple.test' }))).toBe('accuse_absent');
    // Le jeton est gardé jusqu'à sa fin : un seul tirage pour deux appels.
    expect(t.calls.filter((c) => c.url.includes('oauth2')).length).toBe(1);
  });

  it('[R64] la réponse à un avis part sur cet avis seul, et rend son accusé', async () => {
    const t = make({ [`PUT https://mybusiness.googleapis.com/v4/${LOC}/reviews/r1/reply`]: [{ status: 200, body: { comment: 'Merci', updateTime: '2026-11-21T10:00:01Z' } }, { status: 200, body: {} }] });
    expect(await t.client.replyToReview(LOC, `${LOC}/reviews/r1`, 'Merci')).toEqual({ ref: `${LOC}/reviews/r1/reply` });
    expect(JSON.parse(t.calls[1]!.body!)).toEqual({ comment: 'Merci' });
    expect(await codeOf(t.client.replyToReview(LOC, `${LOC}/reviews/r1`, 'Merci'))).toBe('accuse_absent');
    // Un avis d'une autre fiche, ou une référence mal formée : rien ne part.
    const before = t.calls.length;
    expect(await codeOf(t.client.replyToReview(LOC, 'accounts/7/locations/43/reviews/r1', 'Merci'))).toBe('fiche_introuvable');
    expect(await codeOf(t.client.replyToReview(LOC, `${LOC}/reviews/../../x`, 'Merci'))).toBe('fiche_introuvable');
    expect(t.calls.length).toBe(before);
  });

  it('une publication rend sa référence et son lien public ; sans référence, son issue est inconnue', async () => {
    const posts = `POST https://mybusiness.googleapis.com/v4/${LOC}/localPosts`;
    const t = make({ [posts]: [{ status: 200, body: { name: `${LOC}/localPosts/p9`, searchUrl: 'https://local.google.test/p9' } }, { status: 200, body: { state: 'LIVE' } }] });
    expect(await t.client.createPost(LOC, { text: 'Maison à vendre', linkUri: 'https://reseau.exemple.test/biens/x' })).toEqual({ ref: `${LOC}/localPosts/p9`, url: 'https://local.google.test/p9' });
    expect(JSON.parse(t.calls[1]!.body!)).toEqual({ languageCode: 'fr', topicType: 'STANDARD', summary: 'Maison à vendre', callToAction: { actionType: 'LEARN_MORE', url: 'https://reseau.exemple.test/biens/x' } });
    expect(await codeOf(t.client.createPost(LOC, { text: 'Maison', linkUri: 'https://reseau.exemple.test/biens/x' }))).toBe('incertain');
  });

  it('avis et publications exigent la référence complète de la fiche : l’ancienne, sans compte, demande de la relier', async () => {
    const t = make({});
    expect(await codeOf(t.client.createPost('locations/42', { text: 'Maison', linkUri: 'https://reseau.exemple.test/biens/x' }))).toBe('fiche_introuvable');
    expect(await codeOf(t.client.listReviews('locations/42'))).toBe('fiche_introuvable');
    expect(await codeOf(t.client.listReviews('accounts/7/locations/../42'))).toBe('fiche_introuvable');
    expect(t.calls).toEqual([]);
  });

  it('les avis lus : note, texte, date ; un avis mal formé est laissé', async () => {
    const t = make({ [`GET https://mybusiness.googleapis.com/v4/${LOC}/reviews`]: [{ status: 200, body: { reviews: [
      { name: `${LOC}/reviews/r1`, starRating: 'FOUR', comment: 'Bien', createTime: '2026-11-20T09:00:00Z', reviewer: { displayName: 'Personne Inventée' } },
      { name: `${LOC}/reviews/r2`, starRating: 'STAR_RATING_UNSPECIFIED', createTime: '2026-11-20T09:00:00Z' },
    ] } }] });
    expect(await t.client.listReviews(LOC)).toEqual([{ reviewRef: `${LOC}/reviews/r1`, rating: 4, comment: 'Bien', authorName: 'Personne Inventée', reviewedAt: '2026-11-20T09:00:00Z' }]);
  });

  it('les avis sont lus page après page, jusqu’à la dernière', async () => {
    const base = `GET https://mybusiness.googleapis.com/v4/${LOC}/reviews`;
    const r = (n: number) => ({ name: `${LOC}/reviews/r${n}`, starRating: 'FIVE', createTime: '2026-11-20T09:00:00Z' });
    const t = make({ [base]: [{ status: 200, body: { reviews: [r(1), r(2)], nextPageToken: 'page 2' } }, { status: 200, body: { reviews: [r(3)] } }] });
    expect((await t.client.listReviews(LOC)).map((x) => x.reviewRef)).toEqual([1, 2, 3].map((n) => `${LOC}/reviews/r${n}`));
    expect(t.calls.slice(1).map((c) => c.url.split('?')[1])).toEqual(['pageSize=50', 'pageSize=50&pageToken=page%202']);
  });

  it('une réponse dont le corps traîne est perdue au bout du délai, jamais attendue sans fin', async () => {
    const http = (async (input: string | URL | Request, init: RequestInit = {}) => {
      if (String(input).includes('oauth2')) return new Response(JSON.stringify({ access_token: ACCESS, expires_in: 3600 }), { status: 200 });
      const body = new ReadableStream({
        start(c) {
          init.signal?.addEventListener('abort', () => c.error(new Error('coupé')));
        },
      });
      return new Response(body, { status: 200 });
    }) as typeof fetch;
    const client = googleBusinessClient({ credentials: { clientId: 'x.apps.googleusercontent.com', clientSecret: SECRET, refreshToken: REFRESH }, http, timeoutMs: 30 });
    expect(await codeOf(client.createPost(LOC, { text: 'Maison', linkUri: 'https://reseau.exemple.test/biens/x' }))).toBe('incertain');
    expect(await codeOf(client.updateInfo(LOC, { title: 'Camille', phone: null, websiteUri: 'https://camille.exemple.test' }))).toBe('panne');
  });

  it('chaque erreur de Google devient un code fermé, avec le geste qui la règle', async () => {
    expect(googleError(401, null).code).toBe('connexion');
    expect(googleError(403, { error: { status: 'PERMISSION_DENIED', message: 'texte de Google' } }).code).toBe('droits');
    expect(googleError(404, null).code).toBe('fiche_introuvable');
    expect(googleError(400, { error: { status: 'INVALID_ARGUMENT' } }).code).toBe('refuse_google');
    expect(googleError(429, null).code).toBe('limite');
    expect(googleError(403, { error: { status: 'RESOURCE_EXHAUSTED' } }).code).toBe('limite');
    expect(googleError(503, null).code).toBe('panne');
    const info = 'PATCH https://mybusinessbusinessinformation.googleapis.com/v1/locations/42';
    const t = make({ [info]: [{ status: 401 }, { status: 403 }, { status: 503 }, 'coupure'] });
    const call = () => t.client.updateInfo(LOC, { title: 'Camille', phone: null, websiteUri: 'https://camille.exemple.test' });
    expect(await codeOf(call())).toBe('connexion');
    expect(await codeOf(call())).toBe('droits');
    // La mise à jour se refait sans risque : une panne ou une coupure n'est jamais « incertaine ».
    expect(await codeOf(call())).toBe('panne');
    expect(await codeOf(call())).toBe('panne');
    // Un jeton refusé est oublié : le suivant est tiré de nouveau.
    expect(t.calls.filter((c) => c.url.includes('oauth2')).length).toBe(2);
  });

  it('une publication coupée ou en panne après son départ est « incertaine », jamais une panne à refaire', async () => {
    const posts = `POST https://mybusiness.googleapis.com/v4/${LOC}/localPosts`;
    const t = make({ [posts]: ['coupure', { status: 502 }, { status: 400, body: { error: { status: 'INVALID_ARGUMENT' } } }] });
    const call = () => t.client.createPost(LOC, { text: 'Maison', linkUri: 'https://reseau.exemple.test/biens/x' });
    expect(await codeOf(call())).toBe('incertain');
    expect(await codeOf(call())).toBe('incertain');
    expect(await codeOf(call())).toBe('refuse_google');
  });

  it('un jeton de rafraîchissement retiré demande de reconnecter le compte ; une panne du jeton ne publie rien', async () => {
    const h = fakeHttp({ 'POST https://oauth2.googleapis.com/token': [{ status: 400, body: { error: 'invalid_grant' } }, 'coupure', { status: 200, body: {} }] });
    const client = googleBusinessClient({ credentials: { clientId: 'x.apps.googleusercontent.com', clientSecret: SECRET, refreshToken: REFRESH }, http: h.http, timeoutMs: 50 });
    const post = () => client.createPost(LOC, { text: 'Maison', linkUri: 'https://reseau.exemple.test/biens/x' });
    expect(await codeOf(post())).toBe('connexion');
    expect(await codeOf(post())).toBe('panne');
    expect(await codeOf(post())).toBe('connexion');
    expect(h.calls.every((c) => c.url === 'https://oauth2.googleapis.com/token')).toBe(true);
  });

  it('un compte incomplet n’est jamais fait', () => {
    const http = (async () => new Response('')) as typeof fetch;
    expect(() => googleBusinessClient({ credentials: { clientId: 'x.apps.googleusercontent.com', clientSecret: '', refreshToken: REFRESH }, http })).toThrow();
    expect(() => googleBusinessClient({ credentials: { clientId: 'x.apps.googleusercontent.com', clientSecret: SECRET, refreshToken: ' ' }, http })).toThrow();
  });
});
