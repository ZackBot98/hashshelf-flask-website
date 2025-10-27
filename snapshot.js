/* global fflate */
(function() {
  const VERSION = 1;
  const NEW_HASH_PREFIX = `#`; // no visible version in URL
  const OLD_HASH_PREFIX = `#v${VERSION}.`; // still accepted for backwards-compat decode

  const allowedIdTypes = new Set(["work", "isbn", "edition"]);
  const allowedStatuses = new Set(["want", "reading", "finished"]);

  function clampRating(value) {
    if (value === null || value === undefined || value === "") return undefined;
    const n = Number(value);
    if (!Number.isFinite(n)) return undefined;
    return Math.max(0, Math.min(5, Math.round(n)));
  }

  function canonicalizeBooks(books) {
    const normalized = [];
    for (const b of books || []) {
      const idType = String(b.idType || "").trim().toLowerCase();
      const id = String(b.id || "").trim();
      if (!id || !allowedIdTypes.has(idType)) continue;
      const rating = clampRating(b.rating);
      const status = String(b.status || "want").trim().toLowerCase();
      const comment = String(b.comment || "").trim();
      if (!allowedStatuses.has(status)) continue;

      // Property insertion order is canonicalized here
      const book = {
        idType,
        id,
        ...(rating !== undefined ? { rating } : {}),
        ...(comment ? { comment } : {}),
        status
      };
      normalized.push(book);
    }

    // Sort by id asc, tiebreaker idType for determinism across mixed types
    normalized.sort((a, b) => a.id.localeCompare(b.id) || a.idType.localeCompare(b.idType));
    return normalized;
  }

  function canonicalSnapshot(books, name) {
    const trimmedName = String(name || "").trim();
    const snapshot = { v: VERSION };
    if (trimmedName) snapshot.name = trimmedName; // fixed key order: v, name, books
    snapshot.books = canonicalizeBooks(books);
    return snapshot;
  }

  function encodeJsonUtf8(json) {
    const encoder = new TextEncoder();
    return encoder.encode(json);
  }

  function decodeUtf8(bytes) {
    const decoder = new TextDecoder();
    return decoder.decode(bytes);
  }

  function base64UrlFromBytes(bytes) {
    let binary = "";
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      const chunk = bytes.subarray(i, i + chunkSize);
      binary += String.fromCharCode.apply(null, chunk);
    }
    let base64 = btoa(binary);
    base64 = base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
    return base64;
  }

  function bytesFromBase64Url(str) {
    const padLen = (4 - (str.length % 4)) % 4; // 0,1,2,3 => pad 0,3,2,1 respectively; base64url uses only 0,2,1
    const base64 = str.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat(padLen);
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  // Baseline SHA-256 in pure JS for non-secure contexts (iOS HTTP, etc.)
  function sha256HexPortable(bytes) {
    // Based on FIPS 180-4. Computes SHA-256 over a Uint8Array and returns hex.
    function rotr(x, n) { return (x >>> n) | (x << (32 - n)); }
    function ch(x, y, z) { return (x & y) ^ (~x & z); }
    function maj(x, y, z) { return (x & y) ^ (x & z) ^ (y & z); }
    function bsig0(x) { return rotr(x, 2) ^ rotr(x, 13) ^ rotr(x, 22); }
    function bsig1(x) { return rotr(x, 6) ^ rotr(x, 11) ^ rotr(x, 25); }
    function ssig0(x) { return rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3); }
    function ssig1(x) { return rotr(x, 17) ^ rotr(x, 19) ^ (x >>> 10); }
    const K = new Uint32Array([
      0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
      0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
      0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
      0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
      0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
      0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
      0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
      0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2
    ]);
    // Initial hash values
    let h0=0x6a09e667, h1=0xbb67ae85, h2=0x3c6ef372, h3=0xa54ff53a,
        h4=0x510e527f, h5=0x9b05688c, h6=0x1f83d9ab, h7=0x5be0cd19;

    // Pre-processing (padding)
    const len = bytes.length;
    const bitLenHi = (len / 0x20000000) | 0; // high 32 bits
    const bitLenLo = (len << 3) >>> 0;       // low 32 bits
    const withOne = len + 1;
    const padLen = ((withOne + 8 + 63) & ~63) - withOne - 8; // total to next 56 mod 64
    const totalLen = len + 1 + padLen + 8;
    const buf = new Uint8Array(totalLen);
    buf.set(bytes, 0);
    buf[len] = 0x80;
    // last 8 bytes: 64-bit big-endian length
    const view = new DataView(buf.buffer);
    view.setUint32(totalLen - 8, bitLenHi, false);
    view.setUint32(totalLen - 4, bitLenLo, false);

    const w = new Uint32Array(64);
    for (let i = 0; i < totalLen; i += 64) {
      // Prepare message schedule
      for (let t = 0; t < 16; t++) {
        const off = i + (t << 2);
        w[t] = (buf[off] << 24) | (buf[off+1] << 16) | (buf[off+2] << 8) | (buf[off+3]);
      }
      for (let t = 16; t < 64; t++) {
        w[t] = (ssig1(w[t-2]) + w[t-7] + ssig0(w[t-15]) + w[t-16]) >>> 0;
      }
      // Initialize working variables
      let a=h0, b=h1, c=h2, d=h3, e=h4, f=h5, g=h6, h=h7;
      // Compression function main loop
      for (let t = 0; t < 64; t++) {
        const T1 = (h + bsig1(e) + ch(e,f,g) + K[t] + w[t]) >>> 0;
        const T2 = (bsig0(a) + maj(a,b,c)) >>> 0;
        h = g; g = f; f = e; e = (d + T1) >>> 0; d = c; c = b; b = a; a = (T1 + T2) >>> 0;
      }
      // Add the compressed chunk to the current hash value
      h0 = (h0 + a) >>> 0;
      h1 = (h1 + b) >>> 0;
      h2 = (h2 + c) >>> 0;
      h3 = (h3 + d) >>> 0;
      h4 = (h4 + e) >>> 0;
      h5 = (h5 + f) >>> 0;
      h6 = (h6 + g) >>> 0;
      h7 = (h7 + h) >>> 0;
    }
    // Produce hex string
    const out = new Uint32Array([h0,h1,h2,h3,h4,h5,h6,h7]);
    let hex = "";
    for (let i = 0; i < out.length; i++) {
      hex += out[i].toString(16).padStart(8, "0");
    }
    return hex;
  }

  async function sha256Hex(bytes) {
    // Use baseline JS SHA-256 everywhere for consistent behavior across contexts
    return sha256HexPortable(bytes);
  }

  async function encodeSnapshot(books, name) {
    const canonical = canonicalSnapshot(books, name);
    const json = JSON.stringify(canonical);
    const deflated = fflate.deflateSync(encodeJsonUtf8(json));
    const payload = base64UrlFromBytes(deflated);
    const digest = await sha256Hex(deflated);
    const integrity = digest.slice(0, 12);
    const hash = `${NEW_HASH_PREFIX}${payload}.${integrity}`;
    return hash;
  }

  async function decodeFromHash(hashStr) {
    if (!hashStr || !hashStr.startsWith('#')) {
      throw new Error("Missing hash prefix");
    }
    let remainder;
    if (hashStr.startsWith(OLD_HASH_PREFIX)) remainder = hashStr.slice(OLD_HASH_PREFIX.length);
    else remainder = hashStr.slice(NEW_HASH_PREFIX.length);
    const parts = remainder.split(".");
    if (parts.length !== 2) throw new Error("Malformed snapshot hash");
    const [payloadB64u, integrity] = parts;
    const bytes = bytesFromBase64Url(payloadB64u);
    const digest = await sha256Hex(bytes);
    const expected = digest.slice(0, 12);
    if (expected !== integrity) throw new Error("Integrity check failed");
    const inflated = fflate.inflateSync(bytes);
    const json = decodeUtf8(inflated);
    let data;
    try {
      data = JSON.parse(json);
    } catch {
      throw new Error("Invalid JSON in snapshot");
    }
    if (!data || data.v !== VERSION || !Array.isArray(data.books)) {
      throw new Error("Unsupported or invalid snapshot schema");
    }
    // Re-canonicalize for UI consumption
    data.books = canonicalizeBooks(data.books);
    return data;
  }

  async function createSnapshotLink(books, name) {
    const hash = await encodeSnapshot(books, name);
    return `${location.origin}/${hash}`;
  }

  window.HashShelfSnapshot = {
    encodeSnapshot,
    decodeFromHash,
    canonicalizeBooks,
    canonicalSnapshot,
    createSnapshotLink,
    version: VERSION,
    hashPrefix: NEW_HASH_PREFIX
  };
})();


