function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, stableValue(item)]),
    );
  }
  return value;
}

export function deterministicHash(value: unknown): string {
  const input = JSON.stringify(stableValue(value));
  // Exact 64-bit FNV-1a using two 32-bit words. BigInt per character becomes
  // expensive when terrain buffers contribute millions of JSON characters.
  let high = 0xcbf29ce4;
  let low = 0x84222325;
  for (let index = 0; index < input.length; index += 1) {
    low = (low ^ input.charCodeAt(index)) >>> 0;
    const product = low * 0x1b3;
    high =
      (Math.imul(high, 0x1b3) +
        low * 256 +
        Math.floor(product / 0x100000000)) >>>
      0;
    low = product >>> 0;
  }
  return high.toString(16).padStart(8, "0") + low.toString(16).padStart(8, "0");
}
