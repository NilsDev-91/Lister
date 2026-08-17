import { describe, it, expect } from 'vitest'
import { imageDimensions } from './image-meta.js'

/**
 * The fixtures are hand-built headers rather than real photos: the parser reads
 * only the header, and a checked-in binary would pin nothing the bytes below do
 * not pin more legibly.
 */

function pngHeader(width: number, height: number): Buffer {
  const b = Buffer.alloc(24)
  b.writeUInt32BE(0x89504e47, 0)
  b.writeUInt32BE(0x0d0a1a0a, 4)
  b.writeUInt32BE(13, 8) // IHDR length
  b.write('IHDR', 12, 'latin1')
  b.writeUInt32BE(width, 16)
  b.writeUInt32BE(height, 20)
  return b
}

function gifHeader(width: number, height: number): Buffer {
  const b = Buffer.alloc(10)
  b.write('GIF89a', 0, 'latin1')
  b.writeUInt16LE(width, 6)
  b.writeUInt16LE(height, 8)
  return b
}

/** A minimal JPEG: SOI, an APP0 segment to skip, then SOF0 with the frame size. */
function jpegHeader(width: number, height: number): Buffer {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x04, 0x00, 0x00]) // 4-byte segment
  const sof = Buffer.alloc(11)
  sof[0] = 0xff
  sof[1] = 0xc0
  sof.writeUInt16BE(8, 2) // segment length
  sof[4] = 8 // bit depth
  sof.writeUInt16BE(height, 5)
  sof.writeUInt16BE(width, 7)
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof])
}

function webpVp8x(width: number, height: number): Buffer {
  const b = Buffer.alloc(30)
  b.write('RIFF', 0, 'latin1')
  b.write('WEBP', 8, 'latin1')
  b.write('VP8X', 12, 'latin1')
  b.writeUIntLE(width - 1, 24, 3)
  b.writeUIntLE(height - 1, 27, 3)
  return b
}

describe('imageDimensions', () => {
  it('reads PNG, GIF, JPEG and WebP headers', () => {
    expect(imageDimensions(pngHeader(2000, 1500))).toEqual({ width: 2000, height: 1500 })
    expect(imageDimensions(gifHeader(640, 480))).toEqual({ width: 640, height: 480 })
    expect(imageDimensions(jpegHeader(3024, 4032))).toEqual({ width: 3024, height: 4032 })
    expect(imageDimensions(webpVp8x(1920, 1080))).toEqual({ width: 1920, height: 1080 })
  })

  it('walks JPEG segments rather than assuming a fixed offset', () => {
    // A large EXIF block in front of the frame header is the normal case for a
    // phone photo, and a fixed-offset reader returns garbage on it.
    const exif = Buffer.alloc(2 + 2 + 300)
    exif[0] = 0xff
    exif[1] = 0xe1
    exif.writeUInt16BE(302, 2)
    const sof = jpegHeader(1000, 800).subarray(2 + 6) // just the SOF segment
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8]), exif, sof])
    expect(imageDimensions(jpeg)).toEqual({ width: 1000, height: 800 })
  })

  it('returns null for anything it cannot prove', () => {
    expect(imageDimensions(Buffer.from('not an image'))).toBeNull()
    expect(imageDimensions(Buffer.alloc(0))).toBeNull()
    // A JPEG that ends before any SOF marker — truncated upload, say.
    expect(imageDimensions(Buffer.from([0xff, 0xd8, 0xff, 0xd9]))).toBeNull()
    // A PNG signature with a mangled IHDR.
    const broken = pngHeader(100, 100)
    broken.write('XXXX', 12, 'latin1')
    expect(imageDimensions(broken)).toBeNull()
  })
})
