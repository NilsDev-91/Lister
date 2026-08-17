import type { IncomingMessage } from 'node:http'

/**
 * A small multipart/form-data reader.
 *
 * Node has no built-in parser and the uploads here are a handful of photos from
 * a local form, so a dependency would be more surface than substance. The
 * implementation is deliberately strict: anything it does not recognise is
 * rejected rather than guessed at.
 */

export interface UploadedFile {
  field: string
  filename: string
  contentType: string
  data: Buffer
}

export interface ParsedForm {
  fields: Record<string, string>
  files: UploadedFile[]
}

/** Refuses bodies large enough to be a problem rather than a photo. */
const MAX_BODY_BYTES = 60 * 1024 * 1024

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buf = chunk as Buffer
    total += buf.length
    if (total > MAX_BODY_BYTES) {
      throw new Error(`Request body exceeds ${Math.round(MAX_BODY_BYTES / 1e6)} MB.`)
    }
    chunks.push(buf)
  }
  return Buffer.concat(chunks)
}

function parseContentDisposition(header: string): { name?: string; filename?: string } {
  // The `name` pattern needs a parameter boundary in front: without it,
  // `filename="a.jpg"` also matches `name="a.jpg"`, and a client sending the
  // parameters in the other order gets its field name replaced by a filename.
  const name = /(?:^|[;\s])name="([^"]*)"/i.exec(header)?.[1]
  const filename = /filename="([^"]*)"/i.exec(header)?.[1]
  return { ...(name ? { name } : {}), ...(filename ? { filename } : {}) }
}

/** Reads a urlencoded or multipart body into fields and files. */
export async function parseForm(req: IncomingMessage): Promise<ParsedForm> {
  const contentType = req.headers['content-type'] ?? ''
  const body = await readBody(req)

  if (contentType.startsWith('application/x-www-form-urlencoded')) {
    const params = new URLSearchParams(body.toString('utf8'))
    const fields: Record<string, string> = {}
    for (const [key, value] of params) fields[key] = value
    return { fields, files: [] }
  }

  if (!contentType.startsWith('multipart/form-data')) {
    throw new Error(`Unsupported content type: ${contentType || '(none)'}`)
  }

  const boundaryMatch = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType)
  const boundary = boundaryMatch?.[1] ?? boundaryMatch?.[2]
  if (!boundary) throw new Error('multipart body has no boundary.')

  const delimiter = Buffer.from(`--${boundary}`)
  const fields: Record<string, string> = {}
  const files: UploadedFile[] = []

  // Split on the boundary. Working on the Buffer rather than a string matters:
  // converting binary image data to UTF-8 first would corrupt it.
  let position = body.indexOf(delimiter)
  while (position !== -1) {
    const start = position + delimiter.length
    // "--" right after the delimiter marks the final boundary.
    if (body.slice(start, start + 2).toString('latin1') === '--') break

    const next = body.indexOf(delimiter, start)
    if (next === -1) break

    // Each part is headers, a blank line, then the body.
    const part = body.slice(start, next)
    const separator = part.indexOf('\r\n\r\n')
    if (separator === -1) {
      position = next
      continue
    }

    const rawHeaders = part.slice(0, separator).toString('utf8')
    // Trailing CRLF belongs to the delimiter, not the content.
    const content = part.slice(separator + 4, part.length - 2)

    const disposition = rawHeaders.split(/\r\n/).find((l) => /content-disposition/i.test(l)) ?? ''
    const { name, filename } = parseContentDisposition(disposition)

    if (name) {
      if (filename) {
        // Browsers send an empty part for a file input left untouched.
        if (filename && content.length) {
          const type = /content-type:\s*(.+)/i.exec(rawHeaders)?.[1]?.trim() ?? 'application/octet-stream'
          files.push({ field: name, filename, contentType: type, data: content })
        }
      } else {
        fields[name] = content.toString('utf8')
      }
    }

    position = next
  }

  return { fields, files }
}
