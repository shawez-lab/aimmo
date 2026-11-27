/** Une capture et ses mesures, telles que `captures.json` les garde (DS086). */
export interface Mesure {
  nom: string;
  vue: 'tel' | 'ordi';
  fichier: string;
  ecrans: number;
  boutonsPleins: number;
  deborde: boolean;
}
/** Ce qui a changé entre deux jeux de mesures : une ligne par écran et par vue ; rien pour un écran qui n'a pas bougé. */
export function compareCaptures(before: readonly Mesure[], after: readonly Mesure[]): string[];
