/* ============================================================================
   Perch — tools/zip.mjs
   A minimal, deterministic ZIP reader/writer.

   Eagle packages (.eagleplugin, .eaglepack) are ZIP archives, and this project
   has no dependencies and no build step — so the packaging tool implements just
   enough of the format rather than shelling out to a platform-specific archiver.
   That also lets tools/check.mjs open the built package and verify its contents.

   Deterministic on purpose: a fixed DOS timestamp and stable entry order mean
   the same source always produces a byte-identical package.

   Supports: stored and deflate entries, UTF-8 names, single disk. Not ZIP64 —
   packages here are a few hundred KB.
   ========================================================================== */
import { deflateRawSync, inflateRawSync } from 'node:zlib';

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;

const DOS_TIME = 0;        // 00:00:00
const DOS_DATE = 0x0021;   // 1980-01-01, the earliest representable date
const FLAG_UTF8 = 0x0800;
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;

const CRC_TABLE = (() => {
    const table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        table[n] = c;
    }
    return table;
})();

export function crc32(buffer) {
    let c = -1;
    for (let i = 0; i < buffer.length; i++) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
}

/**
 * Build a ZIP from [{ name, data }] (name uses forward slashes, data is a Buffer).
 */
export function createZip(entries) {
    const parts = [];
    const central = [];
    let offset = 0;

    for (const entry of entries) {
        const name = Buffer.from(entry.name, 'utf8');
        const raw = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data);
        const deflated = deflateRawSync(raw, { level: 9 });
        const useDeflate = deflated.length < raw.length;
        const body = useDeflate ? deflated : raw;
        const method = useDeflate ? METHOD_DEFLATE : METHOD_STORE;
        const sum = crc32(raw);

        const local = Buffer.alloc(30);
        local.writeUInt32LE(SIG_LOCAL, 0);
        local.writeUInt16LE(20, 4);            // version needed to extract
        local.writeUInt16LE(FLAG_UTF8, 6);
        local.writeUInt16LE(method, 8);
        local.writeUInt16LE(DOS_TIME, 10);
        local.writeUInt16LE(DOS_DATE, 12);
        local.writeUInt32LE(sum, 14);
        local.writeUInt32LE(body.length, 18);
        local.writeUInt32LE(raw.length, 22);
        local.writeUInt16LE(name.length, 26);
        local.writeUInt16LE(0, 28);            // extra field length
        parts.push(local, name, body);

        const record = Buffer.alloc(46);
        record.writeUInt32LE(SIG_CENTRAL, 0);
        record.writeUInt16LE(20, 4);           // version made by
        record.writeUInt16LE(20, 6);           // version needed
        record.writeUInt16LE(FLAG_UTF8, 8);
        record.writeUInt16LE(method, 10);
        record.writeUInt16LE(DOS_TIME, 12);
        record.writeUInt16LE(DOS_DATE, 14);
        record.writeUInt32LE(sum, 16);
        record.writeUInt32LE(body.length, 20);
        record.writeUInt32LE(raw.length, 24);
        record.writeUInt16LE(name.length, 28);
        record.writeUInt16LE(0, 30);           // extra
        record.writeUInt16LE(0, 32);           // comment
        record.writeUInt16LE(0, 34);           // disk number
        record.writeUInt16LE(0, 36);           // internal attributes
        record.writeUInt32LE(0, 38);           // external attributes
        record.writeUInt32LE(offset, 42);      // offset of local header
        central.push(record, name);

        offset += local.length + name.length + body.length;
    }

    const directory = Buffer.concat(central);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(SIG_EOCD, 0);
    eocd.writeUInt16LE(0, 4);                  // this disk
    eocd.writeUInt16LE(0, 6);                  // disk with central directory
    eocd.writeUInt16LE(entries.length, 8);
    eocd.writeUInt16LE(entries.length, 10);
    eocd.writeUInt32LE(directory.length, 12);
    eocd.writeUInt32LE(offset, 16);
    eocd.writeUInt16LE(0, 20);                 // comment length

    return Buffer.concat([...parts, directory, eocd]);
}

/**
 * Read a ZIP back into [{ name, data, method }].
 * Throws if the archive is malformed, so it doubles as a validity check.
 */
export function readZip(buffer) {
    let eocd = -1;
    const lowest = Math.max(0, buffer.length - 22 - 65536);
    for (let i = buffer.length - 22; i >= lowest; i--) {
        if (buffer.readUInt32LE(i) === SIG_EOCD) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('not a zip archive: no end-of-central-directory record');

    const total = buffer.readUInt16LE(eocd + 10);
    let pointer = buffer.readUInt32LE(eocd + 16);
    const out = [];

    for (let i = 0; i < total; i++) {
        if (buffer.readUInt32LE(pointer) !== SIG_CENTRAL) {
            throw new Error('malformed central directory entry ' + i);
        }
        const method = buffer.readUInt16LE(pointer + 10);
        const compressedSize = buffer.readUInt32LE(pointer + 20);
        const uncompressedSize = buffer.readUInt32LE(pointer + 24);
        const nameLength = buffer.readUInt16LE(pointer + 28);
        const extraLength = buffer.readUInt16LE(pointer + 30);
        const commentLength = buffer.readUInt16LE(pointer + 32);
        const localOffset = buffer.readUInt32LE(pointer + 42);
        const name = buffer.toString('utf8', pointer + 46, pointer + 46 + nameLength);

        if (buffer.readUInt32LE(localOffset) !== SIG_LOCAL) {
            throw new Error('malformed local header for ' + name);
        }
        const localNameLength = buffer.readUInt16LE(localOffset + 26);
        const localExtraLength = buffer.readUInt16LE(localOffset + 28);
        const start = localOffset + 30 + localNameLength + localExtraLength;
        const body = buffer.subarray(start, start + compressedSize);

        let data;
        if (method === METHOD_DEFLATE) data = inflateRawSync(body);
        else if (method === METHOD_STORE) data = Buffer.from(body);
        else throw new Error('unsupported compression method ' + method + ' for ' + name);

        if (data.length !== uncompressedSize) throw new Error('size mismatch for ' + name);

        out.push({ name, data, method: method === METHOD_DEFLATE ? 'deflate' : 'store' });
        pointer += 46 + nameLength + extraLength + commentLength;
    }
    return out;
}
