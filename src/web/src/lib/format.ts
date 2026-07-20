import type { ApiLocation, AssetStatus, AssetType } from "./api";

export const STATUS_LABELS: Record<AssetStatus, string> = {
  in_stock: "In stock",
  deployed: "Deployed",
  in_repair: "In repair",
  retired: "Retired",
};

export const TYPE_LABELS: Record<AssetType, string> = {
  device: "Device",
  peripheral: "Peripheral",
  license: "License",
};

export function formatDateTime(ms: number): string {
  return new Date(ms).toLocaleString();
}

/**
 * Human path for a location: "Site / Building / Room". Walks parentId
 * through the provided id map; depth is capped at 3 by the API's rank
 * rule, the bound here is just defensive.
 */
export function locationPath(
  location: ApiLocation,
  byId: Map<string, ApiLocation>,
): string {
  const names = [location.name];
  let current = location;
  for (let depth = 0; depth < 4; depth += 1) {
    if (current.parentId === null) break;
    const parent = byId.get(current.parentId);
    if (parent === undefined) break;
    names.unshift(parent.name);
    current = parent;
  }
  return names.join(" / ");
}
