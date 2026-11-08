// Ce que la boîte d'essai a reçu, en clair, pour les tests seulement (HX61).
//
// Un message à secret (code à usage unique, lien de signature ou d'ouverture) est rangé masqué : ni `messages`, ni
// `trial_outbox`, ni le journal ne gardent le secret. Le canal, lui, reçoit le texte entier. Pour qu'un test joue le
// rôle du client qui lit son mail, ce module écoute chaque remise à la boîte d'essai, en mémoire, le temps du test.
import { TrialOutbox } from '../src/captation/essai.ts';
import type { OutboundMessage } from '../src/envoi/canaux.ts';
import type { SqlDatabase } from '../src/db/sql.ts';

const delivered = new Map<string, string>();
const PATCHED = Symbol.for('aimmo.test.boite-essai');
const proto = TrialOutbox.prototype as TrialOutbox & { [PATCHED]?: true };
if (!proto[PATCHED]) {
  const original = proto.deliver;
  proto.deliver = async function (this: TrialOutbox, message: OutboundMessage) {
    delivered.set(message.messageId, message.body);
    return original.call(this, message);
  };
  proto[PATCHED] = true;
}

/** Le texte remis au canal pour ce message rangé. */
export function remis(messageId: string): string {
  const body = delivered.get(messageId);
  if (body === undefined) throw new Error(`Aucune remise à la boîte d'essai pour ${messageId}`);
  return body;
}

/** Les lignes de `messages` (avec `id` et `body`), chaque texte rangé remplacé par celui que le canal a reçu. */
export async function enClair<T extends { id: string; body: string }>(rows: Promise<T[]> | T[]): Promise<T[]> {
  return (await rows).map((r) => ({ ...r, body: remis(r.id) }));
}

/** Les tables de la base (ou seulement celles de `only`) où ce texte paraît en clair, toutes colonnes comprises. */
export async function tablesContenant(db: SqlDatabase, secret: string, only?: readonly string[]): Promise<string[]> {
  const tables = await db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'");
  const found: string[] = [];
  for (const { name } of tables) {
    if (only && !only.includes(name)) continue;
    const cols = await db.all<{ name: string }>(`SELECT name FROM pragma_table_info('${name}')`);
    if (cols.length === 0) continue;
    const where = cols.map((c) => `CAST("${c.name}" AS TEXT) LIKE ?`).join(' OR ');
    const rows = await db.all(`SELECT 1 FROM "${name}" WHERE ${where} LIMIT 1`, cols.map(() => `%${secret}%`));
    if (rows.length > 0) found.push(name);
  }
  return found;
}
