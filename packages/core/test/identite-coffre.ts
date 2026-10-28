/**
 * Dépose au coffre de la conformité une pièce d'identité inventée (quelques octets sans signification), comme le fait
 * l'agent : depuis L03, c'est la seule identité vérifiée que lisent les contrôles avant signature (D03) et le dossier de
 * vente (O07) [R92]. `seenAt` donne le jour de vérification (Paris).
 */
import { conformite, localTime, type Acces, type JournalStore, type SqlDatabase, type Viewer } from '../src/index.ts';

const PIECE = new TextEncoder().encode('%PDF-test piece inventee');

class FakeVault implements conformite.VaultStorage {
  private n = 0;
  async put(networkId: string): Promise<string> {
    return `coffre-test/${networkId}/${crypto.randomUUID()}/${++this.n}`;
  }
}

export async function identiteAuCoffre(
  t: { db: SqlDatabase; acces: Acces; journal: JournalStore; now: () => Date },
  viewer: Viewer,
  personId: string,
  input: { piece: string; seenAt: Date; validUntil?: string | null },
): Promise<{ ok: true; id: string } | { ok: false; rule: unknown; code: string }> {
  const coffre = new conformite.CoffreConformite(t.db, t.acces, new FakeVault(), t.journal, { now: t.now });
  const r = await coffre.deposit(viewer, personId, {
    kind: input.piece,
    content: PIECE,
    contentType: 'application/pdf',
    verifiedOn: localTime(input.seenAt, 'Europe/Paris').date,
    validUntil: input.validUntil ?? null,
  });
  return r.ok ? { ok: true, id: r.receipt.pieceId } : r;
}
