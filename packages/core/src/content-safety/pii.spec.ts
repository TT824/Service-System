import { describe, expect, it } from 'vitest';
import { maskPii, maskPiiInParts } from './pii';

describe('maskPii', () => {
  it('masks a mobile number wherever it sits in the sentence', () => {
    const result = maskPii('顾客说手机号是13812345678，请尽快回电');

    expect(result.text).toBe('顾客说手机号是[手机号]，请尽快回电');
    expect(result.kinds).toEqual(['phone']);
  });

  it('masks a landline and an 18-digit ID', () => {
    expect(maskPii('座机 0755-12345678').text).toBe('座机 [手机号]');
    expect(maskPii('身份证 11010119900307123X 已核验').text).toBe('身份证 [证件号] 已核验');
  });

  /**
   * The ordering constraint, stated as a test: an ID contains an 11-digit
   * phone-shaped run, so a phone-first implementation leaves `[手机号]7X`.
   */
  it('does not shred an ID into a phone', () => {
    const result = maskPii('11010119900307123X');

    expect(result.text).toBe('[证件号]');
    expect(result.kinds).toEqual(['id_card']);
  });

  it('masks a labelled order number but keeps the label', () => {
    const result = maskPii('您的订单号：A1B2C3D4 已发货');

    expect(result.text).toBe('您的订单号：[订单号] 已发货');
    expect(result.kinds).toEqual(['order_no']);
  });

  it('treats an unlabelled long digit run as a reference number', () => {
    expect(maskPii('流水 62284804025648900 请核对').text).toBe('流水 [订单号] 请核对');
  });

  it('masks a name and an address only where they are written as fields', () => {
    const result = maskPii('收货人：张三，地址：广东省深圳市南山区科技路5号，明天送');

    expect(result.text).toBe('收货人：[姓名]，地址：[地址]，明天送');
    expect(result.kinds).toEqual(['name', 'address']);
  });

  it('leaves an ordinary sentence that merely contains 地址 alone', () => {
    // 地址 without a field marker and a value after it is prose, not a field.
    expect(maskPii('您的地址信息我们已收到').text).toBe('您的地址信息我们已收到');
  });

  describe('amounts', () => {
    it("masks the customer's own money when a transaction word marks it", () => {
      const result = maskPii('我实付 299 元，什么时候退款');

      expect(result.text).toBe('我实付 [金额] 元，什么时候退款');
      expect(result.kinds).toEqual(['amount']);
    });

    /**
     * The deliberate omission. A catalogue price is what a correct answer is
     * made of; masking it would break the feature this redaction protects.
     */
    it('leaves a catalogue price alone', () => {
      expect(maskPii('这款售价 199 元，限时特价 159 元').text).toBe(
        '这款售价 199 元，限时特价 159 元',
      );
      expect(maskPii('售价 199 元').kinds).toEqual([]);
    });
  });

  it('reports nothing for text with no PII, and returns it unchanged', () => {
    const text = '您好，这款有现货，今天下单明天发出。';

    expect(maskPii(text)).toEqual({ text, kinds: [] });
  });

  it('handles empty text', () => {
    expect(maskPii('')).toEqual({ text: '', kinds: [] });
  });

  it('is idempotent, so masking at two layers is safe', () => {
    const once = maskPii('联系 13812345678，收货人：张三，实付 88 元').text;
    const twice = maskPii(once).text;

    expect(twice).toBe(once);
  });

  it('never leaves the original value in the output', () => {
    const result = maskPii('13812345678 张三 11010119900307123X 实付 299 元');

    for (const secret of ['13812345678', '11010119900307123X', '299']) {
      expect(result.text).not.toContain(secret);
    }
  });
});

describe('maskPiiInParts', () => {
  it('masks each part and reports the union of kinds', () => {
    const result = maskPiiInParts(['顾客手机 13812345678', '没有问题', '订单号：A1B2C3D4']);

    expect(result.parts).toEqual(['顾客手机 [手机号]', '没有问题', '订单号：[订单号]']);
    expect(result.kinds).toEqual(['phone', 'order_no']);
  });
});
