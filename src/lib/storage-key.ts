// Build a safe storage key for proxy uploads.
//
// The key is sent to the backend in the `x-upload-key` HTTP header. HTTP header
// values may only contain ISO-8859-1 (Latin-1) characters, so a filename with
// any other code point makes `fetch` throw *before the request is sent*:
//   "Failed to read the 'headers' property from 'RequestInit':
//    String contains non ISO-8859-1 code point."
// This bites constantly on macOS, whose screenshot filenames embed a narrow
// no-break space (U+202F) in the timestamp ("1.33.56 PM").
//
// We also strip characters the server's validateStorageKey rejects (path
// separators, "..", control chars) so a filename can never break key scoping.
export function sanitizeUploadFilename(filename: string): string {
  const dot = filename.lastIndexOf(".");
  const rawName = dot > 0 ? filename.slice(0, dot) : filename;
  const rawExt = dot > 0 ? filename.slice(dot + 1) : "";

  const clean = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
  const name = clean(rawName) || "file";
  const ext = clean(rawExt).toLowerCase();
  return ext ? `${name}.${ext}` : name;
}

/**
 * Compose a listing-image upload key: `${prefix}/${timestamp}_${safeName}`.
 * `prefix` (which carries the userId segment used for ownership scoping) is
 * passed through verbatim; only the untrusted filename is sanitized.
 */
export function buildUploadKey(prefix: string, filename: string): string {
  return `${prefix}/${Date.now()}_${sanitizeUploadFilename(filename)}`;
}
