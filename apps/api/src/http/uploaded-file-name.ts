/**
 * The file name a browser meant, recovered from what multipart actually carried.
 *
 * Browsers put a UTF-8 file name straight into `Content-Disposition` — an HTTP
 * header, and headers are bytes — while busboy, the parser under multer, reads
 * that parameter as latin1. `对账单.png` therefore arrives as
 * `å¯¹è´¦å\x8d\x95.png`: a string of characters nobody typed, stored, shown back
 * to whoever reads the message, and — worse — carried to the channel provider as
 * the customer's own download name.
 *
 * Guarded, because the opposite mistake is possible: a client that encodes the
 * name properly (`filename*=UTF-8''…`) already arrives correct, and decoding it
 * again would corrupt it. The two are told apart by round-tripping — a name that
 * was already decoded cannot be re-encoded to the bytes it arrived as — plus the
 * replacement characters a wrong decode leaves behind.
 *
 * Shared rather than written twice, because the two upload routes that take a
 * file — the internal attachment and the outbound one — have no reason to
 * disagree, and the failure of disagreeing is silent: one of them stores names
 * no reader can recognise. It lives at the HTTP edge because that is what it
 * repairs: a transport's reading of a header, not a fact about any domain.
 *
 * @param name - multer's `originalname`.
 * @returns The name the sender actually chose.
 */
export function decodedFileName(name: string): string {
  if (name.includes('�') || /^[\u0000-\u007f]*$/.test(name)) {
    return name;
  }
  const recovered = Buffer.from(name, 'latin1').toString('utf8');
  if (recovered.includes('�') || Buffer.from(recovered, 'utf8').toString('latin1') !== name) {
    return name;
  }
  return recovered;
}
