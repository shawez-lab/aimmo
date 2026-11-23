/**
 * AU073b · Les tuiles de la carte où l'agent dessine le secteur d'une recherche, servies par le Worker.
 *
 * L'application ne charge rien d'ailleurs (sa politique de contenu n'admet que sa propre adresse) : le Worker lit la
 * tuile chez le fournisseur réglé (`CARTE_TUILES_URL`, un modèle `https://…/{z}/{x}/{y}.png`) et la rend à l'écran,
 * qui la peint dans un canevas. Seuls le niveau et les numéros de la tuile partent : ni client, ni bien, ni secteur.
 * Sans fournisseur réglé, la carte dit qu'elle n'est pas branchée et le rayon autour d'un lieu reste disponible.
 */

export type TileFetch = (url: string, init: { method: 'GET'; headers: Record<string, string> }) => Promise<{
  status: number;
  headers: { get(name: string): string | null };
  arrayBuffer(): Promise<ArrayBuffer>;
}>;

export interface TileSource {
  tile(z: number, x: number, y: number): Promise<{ type: string; bytes: Uint8Array } | null>;
}

/** Les niveaux servis : d'une agglomération (12) à la rue (18). */
export const TILE_ZOOM = Object.freeze({ min: 12, max: 18 });
/** Le plus lourd qu'une tuile peut peser. */
export const TILE_MAX_BYTES = 200_000;

/** Le modèle d'adresse réglé, s'il est sûr : https, les trois champs, rien d'autre à remplir. */
export function tileTemplateOf(value: string | undefined): string | null {
  if (!value) return null;
  const v = value.trim();
  if (!/^https:\/\/[a-z0-9.-]+(?::\d+)?\//i.test(v) || !v.includes('{z}') || !v.includes('{x}') || !v.includes('{y}')) return null;
  if (/\{(?!z\}|x\}|y\})/.test(v)) return null;
  return v;
}

export class HttpTileSource implements TileSource {
  constructor(
    private readonly template: string,
    private readonly fetcher: TileFetch,
    private readonly userAgent = 'AIMMO (carte des secteurs)',
  ) {}

  async tile(z: number, x: number, y: number): Promise<{ type: string; bytes: Uint8Array } | null> {
    const url = this.template.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y));
    const res = await this.fetcher(url, { method: 'GET', headers: { accept: 'image/png,image/jpeg,image/webp', 'user-agent': this.userAgent } });
    if (res.status !== 200) return null;
    const type = (res.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(type)) return null;
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length === 0 || bytes.length > TILE_MAX_BYTES) return null;
    return { type, bytes };
  }
}

/** Le numéro d'une tuile valable à ce niveau. */
export function validTile(z: number, x: number, y: number): boolean {
  if (!Number.isInteger(z) || z < TILE_ZOOM.min || z > TILE_ZOOM.max) return false;
  const n = 2 ** z;
  return Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x < n && y < n;
}

export function base64Of(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
