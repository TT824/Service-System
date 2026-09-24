/**
 * PII redaction for the one boundary where text leaves this platform: the
 * prompt sent to the generation provider (§4.5, "入模型前脱敏手机号、姓名、
 * 地址、订单号、金额等 PII").
 *
 * ## What this is not
 *
 * It is not a data-loss-prevention filter and it does not run on the way *in*.
 * A customer's message is stored, retrieved and shown to a seat exactly as it
 * arrived — redaction here would cost a seat the order number it needs to help,
 * and the masked copy is not the record. The only thing masked is the copy
 * handed to a model vendor.
 *
 * ## Why labelled fields rather than detectors
 *
 * 姓名 and 地址 cannot be found by pattern in Chinese text: a surname list that
 * catches 张三 also catches 张经理, and an address grammar catches every product
 * name containing 市 or 区. A detector that is wrong this often gets disabled.
 * So names and addresses are masked only when the customer (or a template)
 * wrote them *as a field* — 收货人：张三, 地址：… — which is deterministic,
 * testable, and has no false positives on ordinary sentences.
 *
 * ## Why money is contextual
 *
 * A bare 元 amount is usually a product price, and product prices are the
 * substance of a correct answer: masking 售价 199 元 would break the feature
 * this redaction exists to make safe. Amounts are therefore masked only where a
 * transaction word marks them as *the customer's own* — 实付、退款、订单金额 —
 * which is the reading §4.5 means and the only one we can tell apart.
 */

/** The kinds of PII this module knows how to remove. */
export type PiiKind = 'id_card' | 'phone' | 'order_no' | 'name' | 'address' | 'amount';

/** A redacted string, plus what was removed — the kinds are loggable, the values are not. */
export type PiiMaskResult = {
  readonly text: string;
  /** Distinct kinds found, in the order they were masked. Empty means untouched. */
  readonly kinds: ReadonlyArray<PiiKind>;
};

/** What each kind is replaced with. Bracketed so a reader can see the shape of what was lost. */
const PLACEHOLDERS: Record<PiiKind, string> = Object.freeze({
  id_card: '[证件号]',
  phone: '[手机号]',
  order_no: '[订单号]',
  name: '[姓名]',
  address: '[地址]',
  amount: '[金额]',
});

/**
 * Ordered passes: the order is load-bearing, not cosmetic.
 *
 * An 18-digit ID contains an 11-digit phone-shaped substring, so masking phones
 * first would shred an ID into `[手机号]7X` and lose it. Longest and most
 * specific first, then the labelled passes, whose patterns cannot match inside a
 * placeholder because every placeholder is bracket-and-CJK with no digits.
 */
const PASSES: ReadonlyArray<{
  readonly kind: PiiKind;
  readonly pattern: RegExp;
  /** Index of the capture group to replace; 0 means the whole match. */
  readonly group: number;
}> = Object.freeze([
  // 18-digit mainland ID: 17 digits plus a check digit that may be X.
  { kind: 'id_card', pattern: /\d{17}[\dXx]/g, group: 0 },
  // Order, waybill and payment references: a label, then the value. The label is
  // part of the match so the sentence keeps its shape; only the value is masked.
  // Ahead of the phone pass on purpose: `订单号：13812345678` is an order number
  // that happens to be phone-shaped, and calling it a phone would lose the label
  // that says so.
  {
    kind: 'order_no',
    pattern:
      /(订单号|订单编号|运单号|快递单号|物流单号|交易号|支付流水号)(?:[：:]|是|为|\s){1,3}([A-Za-z0-9][A-Za-z0-9-]{5,})/g,
    group: 2,
  },
  // An unlabelled run this long is a reference number, not prose or a price.
  // `+` from 15 so a 15-digit run is caught while 14-digit ones are left alone.
  { kind: 'order_no', pattern: /\d{15,}/g, group: 0 },
  // Mainland mobile. Deliberately not anchored on word boundaries: Chinese text
  // has no spaces, so `请拨13812345678` is the normal case.
  { kind: 'phone', pattern: /1[3-9]\d{9}/g, group: 0 },
  // Landline, with or without the separator.
  { kind: 'phone', pattern: /0\d{2,3}-\d{7,8}/g, group: 0 },
  // The field marker is required — `(?:[：:]|是|为|\s){1,3}` — rather than
  // optional, because without it `您的地址信息我们已收到` reads as an address
  // field named 地址 with the value 信息我们已收到. A field has a separator.
  {
    kind: 'name',
    pattern: /(姓名|收货人|收件人|联系人|客户名|会员名)(?:[：:]|是|为|\s){1,3}([一-龥·]{2,4})/g,
    group: 2,
  },
  {
    kind: 'address',
    pattern: /(收货地址|详细地址|所在地区|地址)(?:[：:]|是|为|\s){1,3}([^\n，。；！？,;!?]{4,})/g,
    group: 2,
  },
  // The customer's own money, never a catalogue price: see the module note.
  {
    kind: 'amount',
    pattern:
      /(实付|应付|已付|支付|付款|付了|退款|退我|订单金额|下单金额|成交价|运费|邮费)[^\d\n]{0,8}?(\d+(?:\.\d+)?)\s*元?/g,
    group: 2,
  },
]);

/**
 * Redact every kind of PII this module recognises.
 *
 * Idempotent: running it on its own output is a no-op, because a placeholder
 * cannot satisfy any pass. Callers may therefore mask at more than one layer
 * without having to know whether an inner layer already did.
 */
export function maskPii(text: string): PiiMaskResult {
  if (text.length === 0) {
    return Object.freeze({ text, kinds: Object.freeze([]) });
  }

  let masked = text;
  const kinds: PiiKind[] = [];
  for (const pass of PASSES) {
    const replaced = replaceGroup(masked, pass.pattern, pass.group, PLACEHOLDERS[pass.kind]);
    if (replaced !== masked) {
      masked = replaced;
      if (!kinds.includes(pass.kind)) {
        kinds.push(pass.kind);
      }
    }
  }

  if (kinds.length === 0) {
    return Object.freeze({ text, kinds: Object.freeze([]) });
  }
  return Object.freeze({ text: masked, kinds: Object.freeze(kinds) });
}

/** Redact a whole prompt payload, reporting the union of what was found. */
export function maskPiiInParts(parts: ReadonlyArray<string>): {
  readonly parts: ReadonlyArray<string>;
  readonly kinds: ReadonlyArray<PiiKind>;
} {
  const kinds: PiiKind[] = [];
  const maskedParts = parts.map((part) => {
    const result = maskPii(part);
    for (const kind of result.kinds) {
      if (!kinds.includes(kind)) {
        kinds.push(kind);
      }
    }
    return result.text;
  });
  return Object.freeze({ parts: Object.freeze(maskedParts), kinds: Object.freeze(kinds) });
}

/** Replace one capture group in every match, keeping the rest of the match intact. */
function replaceGroup(text: string, pattern: RegExp, group: number, placeholder: string): string {
  // `lastIndex` is per-RegExp-object state and these patterns are module-level
  // constants shared across calls, so a left-over index from a previous call
  // would silently skip matches. `replace` resets it, but a caller that threw
  // mid-scan would not have, so it is cleared explicitly.
  pattern.lastIndex = 0;
  return text.replace(pattern, (match: string, ...rest: unknown[]) => {
    if (group === 0) {
      return placeholder;
    }
    const captures = rest.slice(0, rest.length - 2) as (string | undefined)[];
    const value = captures[group - 1];
    if (value === undefined) {
      return match;
    }
    const at = match.lastIndexOf(value);
    if (at === -1) {
      return match;
    }
    return `${match.slice(0, at)}${placeholder}${match.slice(at + value.length)}`;
  });
}
