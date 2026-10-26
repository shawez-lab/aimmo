import type { JournalEntry, JournalStore } from "./types.ts";

function clone(entry: JournalEntry): JournalEntry {
  return structuredClone(entry);
}

export class MemoryJournalStore implements JournalStore {
  readonly #entries: JournalEntry[] = [];

  async append(entry: JournalEntry): Promise<void> {
    const expected = (this.#entries.at(-1)?.seq ?? 0) + 1;
    if (entry.seq !== expected) {
      throw new Error(
        `Journal en ajout seul : ligne ${expected} attendue, ${entry.seq} reçue.`,
      );
    }
    this.#entries.push(clone(entry));
  }

  async last(): Promise<JournalEntry | null> {
    const entry = this.#entries.at(-1);
    return entry === undefined ? null : clone(entry);
  }

  async all(): Promise<JournalEntry[]> {
    return this.#entries.map(clone);
  }

  async bySubject(subject: string): Promise<JournalEntry[]> {
    return this.#entries
      .filter((entry) => entry.subject === subject)
      .map(clone);
  }

  async byPeriod(fromIso: string, toIso: string): Promise<JournalEntry[]> {
    return this.#entries
      .filter((entry) => entry.at >= fromIso && entry.at <= toIso)
      .map(clone);
  }
}
