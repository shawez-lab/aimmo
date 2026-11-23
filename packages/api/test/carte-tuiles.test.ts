import { describe, expect, it } from 'vitest';
import { HttpTileSource, base64Of, tileTemplateOf, validTile, type TileFetch } from '../src/carte.ts';

// AU073b · Fournisseur et tuiles inventés : aucune adresse réelle n'est appelée.
describe('AU073b · les tuiles de la carte des secteurs', () => {
  it('[R16] le modèle réglé n’est pris que sûr : https et les trois champs, rien d’autre', () => {
    expect(tileTemplateOf('https://tuiles.example.test/{z}/{x}/{y}.png')).toBe('https://tuiles.example.test/{z}/{x}/{y}.png');
    for (const bad of [undefined, '', 'http://tuiles.example.test/{z}/{x}/{y}.png', 'https://tuiles.example.test/{z}/{x}.png', 'https://tuiles.example.test/{z}/{x}/{y}.png?cle={cle}']) expect(tileTemplateOf(bad), String(bad)).toBeNull();
    expect([validTile(12, 0, 0), validTile(18, 2 ** 18 - 1, 0), validTile(11, 0, 0), validTile(15, 2 ** 15, 0), validTile(15, -1, 0)]).toEqual([true, true, false, false, false]);
  });

  it('[R16] la tuile lue chez le fournisseur : image seule, pas trop lourde ; sinon rien', async () => {
    const calls: string[] = [];
    let answer = { status: 200, type: 'image/png', bytes: new Uint8Array([1, 2, 3]) };
    const fetcher: TileFetch = async (url) => (calls.push(url), { status: answer.status, headers: { get: () => answer.type }, arrayBuffer: async () => answer.bytes.buffer as ArrayBuffer });
    const source = new HttpTileSource('https://tuiles.example.test/{z}/{x}/{y}.png', fetcher);
    expect(await source.tile(15, 16841, 11706)).toEqual({ type: 'image/png', bytes: new Uint8Array([1, 2, 3]) });
    expect(calls).toEqual(['https://tuiles.example.test/15/16841/11706.png']);
    answer = { status: 200, type: 'text/html', bytes: new Uint8Array([1]) };
    expect(await source.tile(15, 1, 1)).toBeNull();
    answer = { status: 404, type: 'image/png', bytes: new Uint8Array([1]) };
    expect(await source.tile(15, 1, 1)).toBeNull();
    answer = { status: 200, type: 'image/png', bytes: new Uint8Array(300_000) };
    expect(await source.tile(15, 1, 1)).toBeNull();
    expect(base64Of(new Uint8Array([137, 80, 78, 71]))).toBe('iVBORw==');
  });
});
