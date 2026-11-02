/** 32-bit FNV-1a, enough to tell two states of one list or value apart. */
export function fnv1a(text: string, seed = 0x811c9dc5): number {
    let hash = seed;
    for (let i = 0; i < text.length; i++) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash;
}

/** A short fingerprint of a JSON-serializable value. Equal values give equal fingerprints. */
export function fingerprintOf(value: unknown): string {
    const text = JSON.stringify(value) ?? "";
    return `${text.length.toString(36)}.${fnv1a(text).toString(36)}`;
}
