// lib/lead-magnets/zip-writer.ts
//
// A MINIMAL ZIP WRITER (wave 143, lane 143F) — extracted from lib/lead-magnets/book-publishing.ts so the one caller (buildEpub) imports it
// instead of reaching into its own file. PURE (node:zlib only), no dependency.
//
// WHY IT IS OWN CODE: an EPUB container has two rules a general-purpose zipper does not promise — the FIRST entry must be `mimetype`,
// STORED (uncompressed) with NO extra field, and every name is UTF-8 flagged. This writer keeps entries in the order given and lets the
// caller mark an entry `store:true`. The guard (scripts/book-publishing-guard.ts) reads the result with an INDEPENDENT unzip and checks every
// CRC against node's own crc32, and EPUBCheck (W3C) validates the package — so the writer is not trusted on its own say-so.

import { deflateRawSync } from "node:zlib"

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0 }
  return t
})()
function crc32(buf: Buffer): number { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }

export interface ZipEntry { name: string; data: Buffer; store?: boolean }

/** PURE. A zip with entries in the given order; `store:true` entries are uncompressed (EPUB's `mimetype` must be, and first, with no extra field). */
export function zipEntries(entries: ZipEntry[], when: Date = new Date()): Buffer {
  const y = Math.max(1980, when.getUTCFullYear())
  const dosTime = (when.getUTCHours() << 11) | (when.getUTCMinutes() << 5) | (when.getUTCSeconds() >> 1)
  const dosDate = ((y - 1980) << 9) | ((when.getUTCMonth() + 1) << 5) | when.getUTCDate()
  const locals: Buffer[] = [], centrals: Buffer[] = []
  let offset = 0
  for (const e of entries) {
    const name = Buffer.from(e.name, "utf8")
    const comp = e.store ? e.data : deflateRawSync(e.data)
    const method = e.store ? 0 : 8
    const crc = crc32(e.data)
    const lh = Buffer.alloc(30)
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(method, 8)
    lh.writeUInt16LE(dosTime, 10); lh.writeUInt16LE(dosDate, 12); lh.writeUInt32LE(crc, 14)
    lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(e.data.length, 22); lh.writeUInt16LE(name.length, 26); lh.writeUInt16LE(0, 28)
    locals.push(lh, name, comp)
    const ch = Buffer.alloc(46)
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(method, 10)
    ch.writeUInt16LE(dosTime, 12); ch.writeUInt16LE(dosDate, 14); ch.writeUInt32LE(crc, 16)
    ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(e.data.length, 24); ch.writeUInt16LE(name.length, 28)
    ch.writeUInt16LE(0, 30); ch.writeUInt16LE(0, 32); ch.writeUInt16LE(0, 34); ch.writeUInt16LE(0, 36); ch.writeUInt32LE(0, 38); ch.writeUInt32LE(offset, 42)
    centrals.push(ch, name)
    offset += lh.length + name.length + comp.length
  }
  const cd = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(0, 4); end.writeUInt16LE(0, 6); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16); end.writeUInt16LE(0, 20)
  return Buffer.concat([...locals, cd, end])
}
