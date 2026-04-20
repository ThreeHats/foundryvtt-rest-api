/**
 * Represents a single entry in the native search index.
 * All world and compendium entities are stored as SearchEntry objects.
 */
export interface SearchEntry {
  documentType: string;      // "Actor", "Item", "Scene", etc.
  id: string;
  name: string;
  uuid: string;
  folder: string | null;     // Folder ID or null for root/compendium entries
  pack: string | null;       // Compendium collection ID (null for world entities)
  packageName: string | null; // Human-readable compendium title
  subType: string;           // entity.type value: "npc", "weapon", "spell", etc.
  icon: string;              // entity.img path or empty string
  tagline: string;           // "Actors Directory", pack title, etc.
  resultType: string;        // "WorldEntity" | "CompendiumEntity"
}

export function parseFilterString(filterStr: string): Record<string, string> {
    if (!filterStr.includes(':')) {
      return { documentType: filterStr };
    }

    const filters: Record<string, string> = {};
    const parts = filterStr.split(',');

    for (const part of parts) {
      if (part.includes(':')) {
        const [key, value] = part.split(':');
        if (key && value) {
          filters[key.trim()] = value.trim();
        }
      }
    }

    return filters;
}

/**
 * Check whether a SearchEntry matches all provided filters.
 * Supports filter keys: documentType, subType, folder, package (compendium), resultType,
 * and any other flat property on SearchEntry.
 */
export function matchesAllFilters(entry: SearchEntry, filters: Record<string, string>): boolean {
    for (const [key, value] of Object.entries(filters)) {
      if (!value) continue;

      if (key === "resultType") {
        if (!entry.resultType || entry.resultType.toLowerCase() !== value.toLowerCase()) {
          return false;
        }
        continue;
      }

      if (key === "package") {
        const packValue = entry.pack;
        if (!packValue) return false;
        if (packValue.toLowerCase() !== value.toLowerCase() &&
            `Compendium.${packValue}`.toLowerCase() !== value.toLowerCase()) {
          return false;
        }
        continue;
      }

      if (key === "folder") {
        const folderValue = entry.folder;
        if (!folderValue) return false;
        if (value === folderValue ||
            value === `Folder.${folderValue}` ||
            `Folder.${value}` === folderValue) {
          continue;
        }
        return false;
      }

      const propertyValue = (entry as any)[key];
      if (propertyValue === undefined ||
          (typeof propertyValue === 'string' &&
           propertyValue.toLowerCase() !== value.toLowerCase())) {
        return false;
      }
    }

    return true;
}
