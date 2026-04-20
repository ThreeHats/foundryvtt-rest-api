import { ModuleLogger } from "./logger";
import { SearchEntry, matchesAllFilters } from "./search";

export interface SearchResult {
  entry: SearchEntry;
  score: number;
  formattedMatch: string;
}

export interface SearchOptions {
  limit?: number;
  excludeCompendiums?: boolean;
  filters?: Record<string, string>;
}

const TAGLINE_LABELS: Record<string, string> = {
  "Actor": "Actors Directory",
  "Item": "Items Directory",
  "Scene": "Scenes Directory",
  "JournalEntry": "Journal Directory",
  "RollTable": "Roll Tables Directory",
  "Cards": "Cards Directory",
  "Macro": "Macros Directory",
  "Playlist": "Playlists Directory"
};

const INDEXED_TYPES = ["Actor", "Item", "Scene", "JournalEntry", "RollTable", "Cards", "Macro", "Playlist"];

class NativeSearchIndex {
  private worldEntries: Map<string, SearchEntry> = new Map();
  private compendiumEntries: Map<string, SearchEntry> = new Map();
  private compendiumsIndexed: boolean = false;
  private compendiumsBuildPromise: Promise<void> | null = null;
  isReady: boolean = false;

  private getTagline(documentType: string, packageName: string | null): string {
    if (packageName) return packageName;
    return TAGLINE_LABELS[documentType] ?? `${documentType}s Directory`;
  }

  /**
   * Build the world entity index synchronously from all game collections.
   * Safe to call multiple times — clears and rebuilds each time.
   */
  build(): void {
    this.worldEntries.clear();
    const typeCollectionMap: Record<string, any> = {
      "Actor": (game as any).actors,
      "Item": (game as any).items,
      "Scene": (game as any).scenes,
      "JournalEntry": (game as any).journal,
      "RollTable": (game as any).tables,
      "Cards": (game as any).cards,
      "Macro": (game as any).macros,
      "Playlist": (game as any).playlists
    };
    let count = 0;
    for (const [docType, collection] of Object.entries(typeCollectionMap)) {
      for (const entity of collection?.contents ?? []) {
        this.addWorldEntry(entity, docType);
        count++;
      }
    }
    this.isReady = true;
    ModuleLogger.info(`Search index built: ${count} world entities indexed`);
  }

  /**
   * Add or update a single world entity in the index.
   * Called by build() and by Foundry create/update hooks.
   */
  addWorldEntry(entity: any, documentType?: string): void {
    const docType = documentType ?? entity.documentName;
    if (!docType || !entity.uuid || !entity.name) return;
    this.worldEntries.set(entity.uuid, {
      documentType: docType,
      id: entity.id,
      name: entity.name,
      uuid: entity.uuid,
      folder: entity.folder?.id ?? null,
      pack: null,
      packageName: null,
      subType: entity.type || "",
      icon: entity.img || entity.thumbnail || "",
      tagline: this.getTagline(docType, null),
      resultType: "WorldEntity"
    });
  }

  /** Alias used by Foundry create/update hooks. */
  updateFromDocument(entity: any): void {
    this.addWorldEntry(entity);
  }

  /** Remove a world entity from the index by UUID. Called by delete hooks. */
  removeWorldEntry(uuid: string): void {
    this.worldEntries.delete(uuid);
  }

  /**
   * Build the compendium entry index asynchronously.
   * Deduplicated — concurrent callers share the same in-flight promise.
   */
  private async buildCompendiums(): Promise<void> {
    if (this.compendiumsIndexed) return;
    if (this.compendiumsBuildPromise) {
      await this.compendiumsBuildPromise;
      return;
    }
    this.compendiumsBuildPromise = this._doBuildCompendiums();
    await this.compendiumsBuildPromise;
  }

  private async _doBuildCompendiums(): Promise<void> {
    this.compendiumEntries.clear();
    let count = 0;
    for (const pack of (game as any).packs.contents) {
      try {
        const index = await pack.getIndex();
        for (const entry of (index as any).contents) {
          const uuid = entry.uuid ?? `${pack.collection}.${entry._id}`;
          this.compendiumEntries.set(uuid, {
            documentType: pack.documentName,
            id: entry._id,
            name: entry.name,
            uuid,
            folder: null,
            pack: pack.collection,
            packageName: pack.title,
            subType: entry.type || "",
            icon: entry.img || "",
            tagline: pack.title,
            resultType: "CompendiumEntity"
          });
          count++;
        }
      } catch (err) {
        ModuleLogger.warn(`Search index: failed to index compendium ${pack.collection}:`, err);
      }
    }
    this.compendiumsIndexed = true;
    ModuleLogger.info(`Search index: ${count} compendium entries indexed`);
  }

  /**
   * Score a name against a query string.
   * Returns null if no match; otherwise { score, formattedMatch }.
   *
   * Score tiers:
   *   100 — exact match (case-insensitive)
   *    80 — name starts with query
   *    60 — name contains query as a substring
   *    40 — any word in the name starts with query
   *    20 — subsequence match (all query chars appear in order)
   */
  private scoreMatch(name: string, query: string): { score: number; formattedMatch: string } | null {
    if (!name || !query) return null;
    const nameLower = name.toLowerCase();
    const queryLower = query.toLowerCase();

    if (nameLower === queryLower) {
      return { score: 100, formattedMatch: `<strong>${name}</strong>` };
    }

    if (nameLower.startsWith(queryLower)) {
      return {
        score: 80,
        formattedMatch: `<strong>${name.slice(0, query.length)}</strong>${name.slice(query.length)}`
      };
    }

    const idx = nameLower.indexOf(queryLower);
    if (idx !== -1) {
      return {
        score: 60,
        formattedMatch: `${name.slice(0, idx)}<strong>${name.slice(idx, idx + query.length)}</strong>${name.slice(idx + query.length)}`
      };
    }

    const words = name.split(/\s+/);
    for (const word of words) {
      if (word.toLowerCase().startsWith(queryLower)) {
        return { score: 40, formattedMatch: name };
      }
    }

    // Subsequence check: all chars of query appear in name in order
    let qi = 0;
    for (let ni = 0; ni < nameLower.length && qi < queryLower.length; ni++) {
      if (nameLower[ni] === queryLower[qi]) qi++;
    }
    if (qi === queryLower.length) {
      return { score: 20, formattedMatch: name };
    }

    return null;
  }

  /**
   * Search the index for entities matching the query.
   * Results are sorted by score descending, then name ascending for ties.
   */
  async search(query: string, options: SearchOptions = {}): Promise<SearchResult[]> {
    const { limit = 200, excludeCompendiums = false, filters } = options;

    if (!this.isReady) {
      this.build();
    }

    const entries: SearchEntry[] = [...this.worldEntries.values()];

    if (!excludeCompendiums) {
      await this.buildCompendiums();
      for (const entry of this.compendiumEntries.values()) {
        entries.push(entry);
      }
    }

    const results: SearchResult[] = [];
    for (const entry of entries) {
      if (filters && !matchesAllFilters(entry, filters)) continue;
      if (query) {
        const match = this.scoreMatch(entry.name, query);
        if (!match) continue;
        results.push({ entry, score: match.score, formattedMatch: match.formattedMatch });
      } else {
        results.push({ entry, score: 0, formattedMatch: entry.name });
      }
    }

    results.sort((a, b) => b.score - a.score || a.entry.name.localeCompare(b.entry.name));
    return results.slice(0, limit);
  }
}

export const searchIndex = new NativeSearchIndex();
export { INDEXED_TYPES };
