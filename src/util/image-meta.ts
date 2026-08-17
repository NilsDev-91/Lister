/**
 * Reads pixel dimensions straight out of image file headers.
 *
 * Exists because Etsy's search-visibility checks are pixel checks — the first
 * photo should be at least 2000px wide, and below 635×635 it is placed worse —
 * and telling a seller that at preflight beats letting Etsy quietly rank the
 * listing down. A full image library would be a native dependency for four
 * header formats; the headers themselves are a handful of bytes each.
 *
 * Returns null for anything it cannot prove. An unreadable header is "unknown",
 * never a guess — the same rule the SEO scoring applies to unmeasured numbers.
 */

export interface ImageDimensions {
  width: number
  height: number
}

export function imageDimensions(bytes: Buffer): ImageDimensions | null {
  return png(bytes) ?? gif(bytes) ?? webp(bytes) ?? jpeg(bytes)
}

/** PNG: an 8-byte signature, then the IHDR chunk carries width and height. */
function png(b: Buffer): ImageDimensions | null {
  if (b.length < 24) return null
  if (b.readUInt32BE(0) !== 0x89504e47 || b.readUInt32BE(4) !== 0x0d0a1a0a) return null
  if (b.toString('latin1', 12, 16) !== 'IHDR') return null
  return valid(b.readUInt32BE(16), b.readUInt32BE(20))
}

/** GIF: "GIF87a"/"GIF89a", then the logical screen descriptor, little-endian. */
function gif(b: Buffer): ImageDimensions | null {
  if (b.length < 10) return null
  const magic = b.toString('latin1', 0, 6)
  if (magic !== 'GIF87a' && magic !== 'GIF89a') return null
  return valid(b.readUInt16LE(6), b.readUInt16LE(8))
}

/** WebP: RIFF container; VP8X carries 24-bit dimensions minus one. */
function webp(b: Buffer): ImageDimensions | null {
  if (b.length < 30) return null
  if (b.toString('latin1', 0, 4) !== 'RIFF' || b.toString('latin1', 8, 12) !== 'WEBP') return null
  const chunk = b.toString('latin1', 12, 16)
  if (chunk === 'VP8X') {
    const width = 1 + b.readUIntLE(24, 3)
    const height = 1 + b.readUIntLE(27, 3)
    return valid(width, height)
  }
  if (chunk === 'VP8 ') {
    // Lossy bitstream: dimensions sit after the 3-byte frame tag + sync code.
    if (b.length < 30 || b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null
    return valid(b.readUInt16LE(26) & 0x3fff, b.readUInt16LE(28) & 0x3fff)
  }
  if (chunk === 'VP8L') {
    if (b.length < 25 || b[20] !== 0x2f) return null
    const bits = b.readUInt32LE(21)
    return valid(1 + (bits & 0x3fff), 1 + ((bits >> 14) & 0x3fff))
  }
  return null
}

/**
 * JPEG: walk the marker segments to the first SOF frame header.
 *
 * The dimensions are not at a fixed offset — EXIF blocks, thumbnails and
 * comments all come first — so this steps segment by segment. SOF markers are
 * C0–CF except C4 (DHT), C8 (reserved) and CC (DAC).
 */
function jpeg(b: Buffer): ImageDimensions | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null

  let offset = 2
  while (offset + 9 < b.length) {
    if (b[offset] !== 0xff) {
      offset++
      continue
    }
    const marker = b[offset + 1]!
    // Padding and restart markers carry no length field.
    if (marker === 0xff) {
      offset++
      continue
    }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2
      continue
    }
    if (marker === 0xd9 || marker === 0xda) return null // end / scan data: no SOF found

    const length = b.readUInt16BE(offset + 2)
    if (length < 2) return null

    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
    if (isSof) {
      if (offset + 9 > b.length) return null
      return valid(b.readUInt16BE(offset + 7), b.readUInt16BE(offset + 5))
    }
    offset += 2 + length
  }
  return null
}

function valid(width: number, height: number): ImageDimensions | null {
  return Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0
    ? { width, height }
    : null
}
