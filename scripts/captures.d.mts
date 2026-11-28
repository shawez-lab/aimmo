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
/** Ce qu'un dossier de captures contient après une demande faite à `since` : un succès seulement si ses mesures sont là, écrites depuis, et non vides. */
export function captureOutcome(dir: string, since: number): { ok: boolean; message: string };
