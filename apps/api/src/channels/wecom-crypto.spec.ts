import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  decryptWecomPayload,
  readXmlField,
  signatureMatches,
  wecomSignature,
} from './wecom-crypto';
import {
  TEST_CORP_ID,
  TEST_ENCODING_AES_KEY,
  encryptWecomMessage,
  encryptWecomPlaintext,
  wecomCallbackSignature,
  wecomXml,
} from '../../test/wecom-callback-support';

describe('wecomSignature', () => {
  it('matches an independently computed digest over the sorted values', () => {
    expect(wecomSignature('token-a', '1700000000', 'nonce-1', 'CIPHERTEXT')).toBe(
      wecomCallbackSignature('token-a', '1700000000', 'nonce-1', 'CIPHERTEXT'),
    );
  });

  it('depends on the set of values rather than the order they arrive in', () => {
    // WeCom sends the four values as four separate parameters, so the digest
    // has to be independent of which parameter happens to carry which value.
    expect(wecomSignature('z-token', 'a', 'm', 'k')).toBe(wecomSignature('k', 'm', 'a', 'z-token'));
  });

  it('changes when any single value changes', () => {
    const base = wecomSignature('token-a', '1700000000', 'nonce-1', 'CIPHERTEXT');
    expect(wecomSignature('token-b', '1700000000', 'nonce-1', 'CIPHERTEXT')).not.toBe(base);
    expect(wecomSignature('token-a', '1700000001', 'nonce-1', 'CIPHERTEXT')).not.toBe(base);
    expect(wecomSignature('token-a', '1700000000', 'nonce-2', 'CIPHERTEXT')).not.toBe(base);
    expect(wecomSignature('token-a', '1700000000', 'nonce-1', 'CIPHERTEXT2')).not.toBe(base);
  });
});

describe('signatureMatches', () => {
  const expected = wecomCallbackSignature('token-a', '1700000000', 'nonce-1', 'CIPHERTEXT');

  it('accepts the same digest regardless of how the caller cased or padded it', () => {
    expect(signatureMatches(expected, expected)).toBe(true);
    expect(signatureMatches(expected, expected.toUpperCase())).toBe(true);
    expect(signatureMatches(expected, `  ${expected}  `)).toBe(true);
  });

  it('rejects an absent, different or truncated digest', () => {
    expect(signatureMatches(expected, null)).toBe(false);
    expect(signatureMatches(expected, `${expected.slice(0, -1)}0`)).toBe(false);
    expect(signatureMatches(expected, expected.slice(0, 39))).toBe(false);
    expect(signatureMatches(expected, '')).toBe(false);
  });
});

describe('decryptWecomPayload', () => {
  const message = wecomXml({ MsgType: 'text', Content: '请问什么时候发货？' });

  it('recovers the message and the receiver id it was minted for', () => {
    const encrypted = encryptWecomMessage(TEST_ENCODING_AES_KEY, message, TEST_CORP_ID);
    expect(decryptWecomPayload(TEST_ENCODING_AES_KEY, encrypted, TEST_CORP_ID)).toEqual({
      ok: true,
      message,
      receiveId: TEST_CORP_ID,
    });
  });

  it('refuses a payload minted for another corp, but lets the handshake skip the check', () => {
    const encrypted = encryptWecomMessage(TEST_ENCODING_AES_KEY, message, 'ww-someone-else');
    expect(decryptWecomPayload(TEST_ENCODING_AES_KEY, encrypted, TEST_CORP_ID)).toMatchObject({
      ok: false,
      reason: 'the payload was encrypted for a different receiver id',
    });
    // An empty expectation is the one documented exemption, and it still
    // returns the id it found so the caller can compare it itself.
    expect(decryptWecomPayload(TEST_ENCODING_AES_KEY, encrypted, '')).toEqual({
      ok: true,
      message,
      receiveId: 'ww-someone-else',
    });
  });

  it('refuses a payload whose declared length runs past the frame', () => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(4096, 0);
    const encrypted = encryptWecomPlaintext(
      TEST_ENCODING_AES_KEY,
      Buffer.concat([
        randomBytes(16),
        length,
        Buffer.from('short', 'utf8'),
        Buffer.from(TEST_CORP_ID, 'utf8'),
      ]),
    );
    expect(decryptWecomPayload(TEST_ENCODING_AES_KEY, encrypted, TEST_CORP_ID)).toMatchObject({
      ok: false,
      reason: 'the decrypted payload declares an out-of-range length',
    });
  });

  it('refuses a frame that declares an empty message', () => {
    const encrypted = encryptWecomPlaintext(
      TEST_ENCODING_AES_KEY,
      Buffer.concat([randomBytes(16), Buffer.alloc(4), Buffer.from(TEST_CORP_ID, 'utf8')]),
    );
    expect(decryptWecomPayload(TEST_ENCODING_AES_KEY, encrypted, TEST_CORP_ID)).toMatchObject({
      ok: false,
      reason: 'the decrypted payload declares an out-of-range length',
    });
  });

  it('refuses a key that is not the documented 43 characters', () => {
    expect(decryptWecomPayload('too-short', 'AAAA', TEST_CORP_ID)).toMatchObject({
      ok: false,
      reason: 'EncodingAESKey must be 43 characters',
    });
  });

  it('refuses a key whose length is right but whose contents cannot be a key', () => {
    // 43 characters that decode to fewer than 32 bytes.
    const notAKey = 'A'.repeat(40) + '!!!';
    expect(decryptWecomPayload(notAKey, 'AAAA', TEST_CORP_ID)).toMatchObject({ ok: false });
  });

  it('refuses ciphertext that is not a valid AES block sequence, without echoing it', () => {
    const result = decryptWecomPayload(TEST_ENCODING_AES_KEY, 'not-a-ciphertext', TEST_CORP_ID);
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) {
      expect(result.reason).not.toContain('not-a-ciphertext');
      expect(result.reason).not.toContain(TEST_ENCODING_AES_KEY);
    }
  });
});

describe('readXmlField', () => {
  it('reads a plain and a CDATA-wrapped element alike', () => {
    expect(readXmlField('<xml><MsgType>text</MsgType></xml>', 'MsgType')).toBe('text');
    expect(readXmlField('<xml><MsgType><![CDATA[text]]></MsgType></xml>', 'MsgType')).toBe('text');
    expect(readXmlField('<xml><MsgType>\n  <![CDATA[text]]>\n</MsgType></xml>', 'MsgType')).toBe(
      'text',
    );
  });

  it('keeps the inner text of a multi-line payload', () => {
    const line = '<first>\nsecond line & <angle brackets>\n</first>';
    expect(readXmlField(`<xml><Content><![CDATA[${line}]]></Content></xml>`, 'Content')).toBe(line);
  });

  it('returns null for an absent, empty or whitespace-only element', () => {
    expect(readXmlField('<xml><MsgType>text</MsgType></xml>', 'Content')).toBeNull();
    expect(readXmlField('<xml><Content></Content></xml>', 'Content')).toBeNull();
    expect(readXmlField('<xml><Content>   </Content></xml>', 'Content')).toBeNull();
  });

  it('does not confuse a similarly named element for the one asked for', () => {
    expect(readXmlField('<xml><MsgId>7</MsgId><MsgType>text</MsgType></xml>', 'MsgType')).toBe(
      'text',
    );
    expect(readXmlField('<xml><MsgId>7</MsgId></xml>', 'Msg')).toBeNull();
  });
});
