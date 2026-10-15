// Reads title / artist / album / track number / cover art from audio files,
// with no libraries: ID3v2 (+ ID3v1 fallback) for MP3, iTunes atoms for M4A/AAC/ALAC,
// Vorbis comments for FLAC. Everything returned is plain data; callers render it as text.

export async function readTags(file) {
  try {
    const head = await bytes(file, 0, 12);
    if (str(head, 0, 3) === 'ID3') return fill(await id3v2(file, head), file);
    if (str(head, 4, 4) === 'ftyp') return await mp4(file);
    if (str(head, 0, 4) === 'fLaC') return await flac(file);
    return (await id3v1(file)) ?? {};
  } catch (err) {
    console.warn('Could not read tags for', file.name, err);
    return {};
  }
}

// ---------- helpers

async function bytes(file, start, end) {
  return new Uint8Array(await file.slice(start, end).arrayBuffer());
}
const str = (b, off, len) => String.fromCharCode(...b.subarray(off, off + len));
const u32 = (b, o) => ((b[o] << 24) >>> 0) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3];
const u32le = (b, o) => b[o] + (b[o + 1] << 8) + (b[o + 2] << 16) + ((b[o + 3] << 24) >>> 0);
const syncsafe = (b, o) => (b[o] << 21) | (b[o + 1] << 14) | (b[o + 2] << 7) | b[o + 3];
const clean = (s) => (s ?? '').replace(/\0+$/g, '').split('\0')[0].trim() || undefined;
const trackNo = (s) => { const n = parseInt(String(s ?? ''), 10); return Number.isFinite(n) && n > 0 ? n : undefined; };

function sniffImage(b) {
  if (b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg';
  if (b[0] === 0x89 && b[1] === 0x50) return 'image/png';
  if (str(b, 0, 4) === 'GIF8') return 'image/gif';
  if (str(b, 8, 4) === 'WEBP') return 'image/webp';
  return null;
}
function image(data) {
  const type = sniffImage(data);
  return type && data.length > 32 ? new Blob([data], { type }) : undefined;
}

// MP3s sometimes carry only an ID3v1 tag at the end, or fill gaps there.
async function fill(tags, file) {
  if (tags.title && tags.artist && tags.album) return tags;
  const v1 = await id3v1(file);
  return v1 ? { ...v1, ...Object.fromEntries(Object.entries(tags).filter(([, v]) => v !== undefined)) } : tags;
}

// ---------- ID3

function decode(enc, data) {
  if (enc === 1) {
    if (data[0] === 0xfe && data[1] === 0xff) return new TextDecoder('utf-16be').decode(data.subarray(2));
    if (data[0] === 0xff && data[1] === 0xfe) return new TextDecoder('utf-16le').decode(data.subarray(2));
    return new TextDecoder('utf-16le').decode(data);
  }
  if (enc === 2) return new TextDecoder('utf-16be').decode(data);
  if (enc === 3) return new TextDecoder('utf-8').decode(data);
  return new TextDecoder('iso-8859-1').decode(data);
}

// Index just past a string terminator (1 null byte, or 2 aligned null bytes for UTF-16).
function skipTerminated(b, i, wide) {
  if (wide) {
    while (i + 1 < b.length && (b[i] || b[i + 1])) i += 2;
    return i + 2;
  }
  while (i < b.length && b[i]) i++;
  return i + 1;
}

async function id3v2(file, h) {
  const ver = h[3];
  const flags = h[5];
  const size = syncsafe(h, 6);
  const buf = await bytes(file, 10, 10 + size);
  const out = {};
  let p = 0;
  if (flags & 0x40) p = ver === 4 ? syncsafe(buf, 0) : u32(buf, 0) + 4; // extended header

  const idLen = ver === 2 ? 3 : 4;
  const hdrLen = ver === 2 ? 6 : 10;
  let cover, firstPic;
  while (p + hdrLen <= buf.length) {
    const id = str(buf, p, idLen);
    if (!/^[A-Z0-9]+$/.test(id)) break; // padding
    const sz = ver === 2 ? (buf[p + 3] << 16) | (buf[p + 4] << 8) | buf[p + 5]
      : ver === 4 ? syncsafe(buf, p + 4) : u32(buf, p + 4);
    const fflags = ver === 2 ? 0 : buf[p + 9];
    let body = buf.subarray(p + hdrLen, p + hdrLen + sz);
    p += hdrLen + sz;
    if (sz <= 0) continue;
    if (ver === 3 && fflags & 0xc0) continue; // compressed / encrypted
    if (ver === 4 && fflags & 0x0c) continue;
    if (ver === 4 && fflags & 0x01) body = body.subarray(4); // data length indicator

    const text = () => clean(decode(body[0], body.subarray(1)));
    switch (id) {
      case 'TIT2': case 'TT2': out.title ??= text(); break;
      case 'TPE1': case 'TP1': out.artist ??= text(); break;
      case 'TPE2': case 'TP2': out.albumArtist ??= text(); break;
      case 'TALB': case 'TAL': out.album ??= text(); break;
      case 'TRCK': case 'TRK': out.trackNo ??= trackNo(text()); break;
      case 'APIC': case 'PIC': {
        const enc = body[0];
        let i = 1;
        if (id === 'APIC') i = skipTerminated(body, i, false); // MIME type
        else i += 3; // 3-char image format
        const picType = body[i++];
        i = skipTerminated(body, i, enc === 1 || enc === 2); // description
        const blob = image(body.subarray(i));
        if (blob) { if (picType === 3) cover ??= blob; else firstPic ??= blob; }
        break;
      }
    }
  }
  out.art = cover ?? firstPic;
  if (!out.artist) out.artist = out.albumArtist;
  delete out.albumArtist;
  return out;
}

async function id3v1(file) {
  if (file.size < 128) return null;
  const b = await bytes(file, file.size - 128, file.size);
  if (str(b, 0, 3) !== 'TAG') return null;
  const latin = (o, n) => clean(new TextDecoder('iso-8859-1').decode(b.subarray(o, o + n)));
  return {
    title: latin(3, 30), artist: latin(33, 30), album: latin(63, 30),
    trackNo: b[125] === 0 && b[126] ? b[126] : undefined,
  };
}

// ---------- MP4 / M4A

function* boxes(b, start, end) {
  let p = start;
  while (p + 8 <= end) {
    let size = u32(b, p);
    const type = str(b, p + 4, 4);
    let hdr = 8;
    if (size === 1) { size = u32(b, p + 8) * 2 ** 32 + u32(b, p + 12); hdr = 16; }
    else if (size === 0) size = end - p;
    if (size < hdr || p + size > end) return;
    yield { type, start: p + hdr, end: p + size };
    p += size;
  }
}
const child = (b, box, type) => { for (const c of boxes(b, box.start, box.end)) if (c.type === type) return c; return null; };

async function mp4(file) {
  // moov can sit anywhere (often at the end), so walk top-level boxes by their headers.
  let off = 0;
  while (off + 8 <= file.size) {
    const h = await bytes(file, off, off + 16);
    let size = u32(h, 0);
    const type = str(h, 4, 4);
    let hdr = 8;
    if (size === 1) { size = u32(h, 8) * 2 ** 32 + u32(h, 12); hdr = 16; }
    else if (size === 0) size = file.size - off;
    if (size < hdr) break;
    if (type === 'moov') {
      const b = await bytes(file, off + hdr, off + size);
      return ilst(b, { start: 0, end: b.length });
    }
    off += size;
  }
  return {};
}

function ilst(b, moov) {
  const udta = child(b, moov, 'udta');
  let meta = udta && child(b, udta, 'meta');
  meta ??= child(b, moov, 'meta');
  if (!meta) return {};
  const list = child(b, { start: meta.start + 4, end: meta.end }, 'ilst'); // meta is a full box
  if (!list) return {};
  const out = {};
  let albumArtist;
  const utf8 = new TextDecoder('utf-8');
  for (const item of boxes(b, list.start, list.end)) {
    const data = child(b, item, 'data');
    if (!data) continue;
    const payload = b.subarray(data.start + 8, data.end); // skip type + locale
    switch (item.type) {
      case '©nam': out.title = clean(utf8.decode(payload)); break;
      case '©ART': out.artist = clean(utf8.decode(payload)); break;
      case 'aART': albumArtist = clean(utf8.decode(payload)); break;
      case '©alb': out.album = clean(utf8.decode(payload)); break;
      case 'trkn': if (payload.length >= 4) out.trackNo = trackNo((payload[2] << 8) | payload[3]); break;
      case 'covr': out.art ??= image(payload); break;
    }
  }
  out.artist ??= albumArtist;
  return out;
}

// ---------- FLAC

async function flac(file) {
  const out = {};
  let off = 4;
  let albumArtist;
  for (let guard = 0; guard < 64 && off + 4 <= file.size; guard++) {
    const h = await bytes(file, off, off + 4);
    const last = h[0] & 0x80;
    const type = h[0] & 0x7f;
    const len = (h[1] << 16) | (h[2] << 8) | h[3];
    if (type === 4 || type === 6) {
      const b = await bytes(file, off + 4, off + 4 + len);
      if (type === 4) {
        const utf8 = new TextDecoder('utf-8');
        let p = 4 + u32le(b, 0); // vendor string
        const count = u32le(b, p); p += 4;
        for (let i = 0; i < count && p + 4 <= b.length; i++) {
          const n = u32le(b, p); p += 4;
          const entry = utf8.decode(b.subarray(p, p + n)); p += n;
          const eq = entry.indexOf('=');
          if (eq < 0) continue;
          const key = entry.slice(0, eq).toUpperCase();
          const val = clean(entry.slice(eq + 1));
          if (key === 'TITLE') out.title ??= val;
          else if (key === 'ARTIST') out.artist ??= val;
          else if (key === 'ALBUMARTIST') albumArtist ??= val;
          else if (key === 'ALBUM') out.album ??= val;
          else if (key === 'TRACKNUMBER') out.trackNo ??= trackNo(val);
        }
      } else {
        const picType = u32(b, 0);
        let p = 4;
        p += 4 + u32(b, p); // MIME
        p += 4 + u32(b, p); // description
        p += 16; // width, height, depth, colors
        const n = u32(b, p); p += 4;
        const blob = image(b.subarray(p, p + n));
        if (blob && (picType === 3 || !out.art)) out.art = blob;
      }
    }
    off += 4 + len;
    if (last) break;
  }
  out.artist ??= albumArtist;
  return out;
}
