import type { SqlDatabase, reseau } from '@aimmo/core';

/**
 * AU025 · Le stockage à part du bac à sable, dans le Worker.
 *
 * Les bacs à sable vivent dans leur propre base D1, `aimmo-bac-a-sable`, en juridiction `eu` comme la base du réseau
 * [R602], avec les mêmes migrations, jamais dans la base du réseau [R82]. Chaque agent y a son réseau d'entraînement,
 * nommé d'après lui : rien d'un autre agent n'y coche une de ses étapes. Aucune donnée réelle n'y entre.
 */
export class D1SandboxStorage implements reseau.SandboxStorage {
  constructor(
    private readonly sandbox: SqlDatabase,
    private readonly network: SqlDatabase,
  ) {
    if (sandbox === network) throw new Error('Bac à sable : la base doit être une autre base que celle du réseau.');
  }

  async open(_agentId: string): Promise<SqlDatabase> {
    return this.sandbox;
  }
}
