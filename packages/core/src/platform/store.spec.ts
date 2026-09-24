import { describe, expect, it } from 'vitest';
import { KefuStore } from './store';
import { AUDIT_ACTIONS, MESSAGE_SOURCES } from './types';

const T1 = 'tenant-acme';
const T2 = 'tenant-beta';
const S1 = 'store-acme-flagship';
const S2 = 'store-acme-outlet';
const NOW = '2026-09-09T12:00:00.000Z';
const LATER = '2026-09-09T12:30:00.000Z';

/**
 * A create that the test expects to succeed.
 *
 * The catalogue creates answer `undefined` when the parent they name is out of
 * scope, so a test that just wants the row has to unwrap it. Throwing here keeps
 * a broken precondition from being read as a passing assertion about `undefined`.
 *
 * @param value - The created record, or `undefined`.
 * @returns The record.
 */
function created<T>(value: T | undefined): T {
  if (value === undefined) {
    throw new Error('expected the create to succeed');
  }
  return value;
}
describe('KefuStore', () => {
  it('enforces tenant isolation for every tenant-owned read', () => {
    const store = new KefuStore();
    expect(store.listConversations(T1).length).toBeGreaterThan(0);
    expect(store.listConversations(T2)).toEqual([]);
    expect(store.listMessages(T2)).toEqual([]);
    expect(store.getConversation(T2, 'conversation-acme-1')).toBeUndefined();
    expect(store.getMessage(T2, 'message-acme-1-1')).toBeUndefined();
    expect(store.listReviewQueue(T2)).toEqual([]);
    expect(store.listApprovedPhrases(T2)).toEqual([]);
  });

  it('scopes store-owned knowledge and members to their store and tenant', () => {
    const store = new KefuStore();
    expect(store.getStore(T1, 'store-acme-flagship')?.name).toBe('云集服饰旗舰店');
    expect(store.getStore(T2, 'store-acme-flagship')).toBeUndefined();
    expect(store.listMembers(T2).some((member) => member.id === 'u-t1-admin')).toBe(false);
    expect(store.listProducts(T2).every((product) => product.tenantId === T2)).toBe(true);
    expect(store.listProducts(T1).every((product) => product.tenantId === T1)).toBe(true);
    expect(store.listFaqs(T1).length).toBeGreaterThan(0);
  });

  it('refuses a stale claim and accepts the next claim (optimistic CAS)', () => {
    const store = new KefuStore();
    const stale = store.claim(T1, 'conversation-acme-2', 'u-t1-agent-1', 99, NOW);
    expect(stale).toMatchObject({ ok: false, code: 'conflict' });

    const claimed = store.claim(T1, 'conversation-acme-2', 'u-t1-agent-1', 2, NOW);
    expect(claimed.ok).toBe(true);
    if (!claimed.ok) {
      return;
    }
    expect(claimed.conversation.status).toBe('claimed');
    expect(claimed.conversation.version).toBe(3);

    const repeated = store.claim(T1, 'conversation-acme-2', 'u-t1-agent-2', 2, NOW);
    expect(repeated).toMatchObject({ ok: false, code: 'conflict' });
  });

  it('records an audit entry on a successful claim', () => {
    const store = new KefuStore();
    store.claim(T1, 'conversation-acme-2', 'u-t1-agent-1', 2, NOW);
    const audits = store.listAudit(T1);
    expect(audits.some((entry) => entry.action === AUDIT_ACTIONS.conversationClaimed)).toBe(true);
    // Platform-level audit entries stay invisible to tenant queries.
    expect(audits.some((entry) => entry.tenantId === null)).toBe(false);
  });

  it('ingests an inbound message idempotently by dedup key', () => {
    const store = new KefuStore();
    const input = {
      tenantId: T1,
      storeId: 'store-acme-flagship',
      channel: 'wecom',
      externalCustomerId: 'customer-9001',
      externalConversationId: 'wecom-ext-9001',
      content: '在吗？',
      dedupKey: 'wecom:msg-9001',
      now: NOW,
    };
    const first = store.ingestInbound(input);
    expect(first.created).toBe(true);
    const second = store.ingestInbound(input);
    expect(second.created).toBe(false);
    expect(second.message.id).toBe(first.message.id);
    expect(store.listMessages(T1).filter((m) => m.id === first.message.id).length).toBe(1);
  });

  it('reopens a closed conversation on a new inbound message', () => {
    const store = new KefuStore();
    const before = store.getConversation(T1, 'conversation-acme-3');
    expect(before?.status).toBe('closed');

    const result = store.ingestInbound({
      tenantId: T1,
      storeId: 'store-acme-flagship',
      channel: 'manual',
      externalCustomerId: 'customer-1003',
      externalConversationId: 'wecom-ext-1003',
      content: '在的，请问还有什么可以帮您？',
      dedupKey: 'manual:reopen-1',
      now: NOW,
    });
    expect(result.reopened).toBe(true);
    expect(result.conversation.status).toBe('open');
    expect(result.conversation.version).toBe((before === undefined ? 0 : before.version) + 1);
  });

  it('sends outbound messages idempotently and marks candidate sources for review', () => {
    const store = new KefuStore();
    const base = {
      tenantId: T1,
      storeId: 'store-acme-flagship',
      conversationId: 'conversation-acme-1',
      content: '这是直发候选话术',
      dedupKey: 'outbound:dedup-1',
      now: NOW,
    };
    const first = store.sendOutbound({ ...base, source: 'direct_candidate' });
    expect(first.created).toBe(true);
    expect(first.message.reviewEligible).toBe(true);
    expect(first.message.reviewState).toBe('pending');
    const second = store.sendOutbound({ ...base, source: 'direct_candidate' });
    expect(second.created).toBe(false);
    expect(second.message.id).toBe(first.message.id);

    const manual = store.sendOutbound({
      ...base,
      content: '手动输入内容',
      source: 'manual_typed',
      dedupKey: 'outbound:dedup-2',
    });
    expect(manual.message.reviewEligible).toBe(false);
    expect(manual.message.reviewState).toBe('none');

    const queue = store.listReviewQueue(T1);
    expect(queue.some((message) => message.id === first.message.id)).toBe(true);
    expect(queue.some((message) => message.id === manual.message.id)).toBe(false);
  });

  it('approves a candidate message, writes a tenant-scoped phrase and audits the action', () => {
    const store = new KefuStore();
    const result = store.approveMessage(T1, 'message-acme-1-3', 'u-t1-admin', NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.message.reviewState).toBe('approved');
    expect(result.phrase).toMatchObject({
      tenantId: T1,
      phrase: result.message.content,
      approvedBy: 'u-t1-admin',
    });
    expect(store.listApprovedPhrases(T1).some((phrase) => phrase.id === result.phrase.id)).toBe(
      true,
    );
    expect(store.listApprovedPhrases(T2)).toEqual([]);
    expect(
      store
        .listAudit(T1)
        .some(
          (entry) =>
            entry.action === AUDIT_ACTIONS.messageApproved && entry.targetId === 'message-acme-1-3',
        ),
    ).toBe(true);

    const again = store.approveMessage(T1, 'message-acme-1-3', 'u-t1-admin', NOW);
    expect(again).toMatchObject({ ok: false, code: 'already_reviewed' });
  });

  it('does not allow approving a metrics-only message', () => {
    const store = new KefuStore();
    const result = store.approveMessage(T1, 'message-acme-1-2', 'u-t1-admin', NOW);
    expect(result).toMatchObject({ ok: false, code: 'not_eligible' });
  });

  it('exposes a deterministic retention summary for a tenant', () => {
    const store = new KefuStore();
    const summary = store.summarizeRetention(T1, NOW);
    expect(summary.tenantId).toBe(T1);
    expect(summary.totalExpired).toBe(0);
    expect(Object.keys(summary.expiredCountByEntity)).toEqual([
      'message',
      'conversation',
      'audit_log',
      'approved_phrase',
    ]);
  });

  it('accepts only the documented message sources', () => {
    expect(MESSAGE_SOURCES).toEqual([
      'direct_candidate',
      'edited_send',
      'manual_typed',
      'shortcut',
      'faq_auto',
      'other',
    ]);
  });
});

describe('knowledge patches', () => {
  it('changes only the fields the patch names, and moves updatedAt only', () => {
    const store = new KefuStore();
    const created = store.createProduct({
      tenantId: T1,
      storeId: 'store-acme-flagship',
      sku: 'K-301',
      title: '旧标题',
      description: '旧描述',
      now: NOW,
    });

    const updated = store.updateProduct({
      tenantId: T1,
      productId: created.id,
      patch: { title: '新标题' },
      now: LATER,
    });
    expect(updated).toMatchObject({
      id: created.id,
      sku: 'K-301',
      title: '新标题',
      description: '旧描述',
      enabled: true,
      createdAt: NOW,
      updatedAt: LATER,
    });
  });

  it('keeps a 停用 entry readable and listable, so it can be put back', () => {
    const store = new KefuStore();
    const created = store.createFaq({
      tenantId: T1,
      storeId: 'store-acme-flagship',
      question: '可以开发票吗？',
      answer: '可以，下单时备注抬头。',
      tags: ['发票'],
      now: NOW,
    });

    const disabled = store.updateFaq({
      tenantId: T1,
      faqId: created.id,
      patch: { enabled: false },
      now: LATER,
    });
    expect(disabled?.enabled).toBe(false);
    // Both reads still answer: that is what lets the console show the row and
    // undo the 停用. Only the reply pipeline treats it as gone.
    expect(store.getFaq(T1, created.id)?.enabled).toBe(false);
    expect(store.listFaqs(T1).map((faq) => faq.id)).toContain(created.id);

    const restored = store.updateFaq({
      tenantId: T1,
      faqId: created.id,
      patch: { enabled: true },
      now: LATER,
    });
    expect(restored?.enabled).toBe(true);
  });

  it('replaces the tag list, and leaves it alone when the patch omits it', () => {
    const store = new KefuStore();
    const created = store.createFaq({
      tenantId: T1,
      storeId: 'store-acme-flagship',
      question: '多久发货？',
      answer: '48 小时内。',
      tags: ['物流'],
      now: NOW,
    });

    const retagged = store.updateFaq({
      tenantId: T1,
      faqId: created.id,
      patch: { tags: ['售后', '退货'] },
      now: LATER,
    });
    expect(retagged?.tags).toEqual(['售后', '退货']);

    const reworded = store.updateFaq({
      tenantId: T1,
      faqId: created.id,
      patch: { answer: '24 小时内。' },
      now: LATER,
    });
    expect(reworded?.answer).toBe('24 小时内。');
    expect(reworded?.tags).toEqual(['售后', '退货']);
  });

  it('changes a shortcut through the same rules', () => {
    const store = new KefuStore();
    const created = store.createShortcut({
      tenantId: T1,
      storeId: 'store-acme-flagship',
      code: '/hi',
      title: '问候语',
      content: '您好，很高兴为您服务。',
      now: NOW,
    });

    const updated = store.updateShortcut({
      tenantId: T1,
      shortcutId: created.id,
      patch: { content: '您好，请问有什么可以帮您？', enabled: false },
      now: LATER,
    });
    expect(updated).toMatchObject({
      code: '/hi',
      title: '问候语',
      content: '您好，请问有什么可以帮您？',
      enabled: false,
      createdAt: NOW,
      updatedAt: LATER,
    });
  });

  it('refuses to reach a row another tenant owns, and leaves it unchanged', () => {
    const store = new KefuStore();
    const created = store.createShortcut({
      tenantId: T1,
      storeId: 'store-acme-flagship',
      code: '/bye',
      title: '结束语',
      content: '感谢您的咨询。',
      now: NOW,
    });

    const foreign = store.updateShortcut({
      tenantId: T2,
      shortcutId: created.id,
      patch: { title: '越权改名' },
      now: LATER,
    });
    expect(foreign).toBeUndefined();
    expect(store.getShortcut(T1, created.id)?.title).toBe('结束语');
  });

  it('answers undefined for an id that was never created', () => {
    const store = new KefuStore();
    expect(
      store.updateProduct({
        tenantId: T1,
        productId: 'product-does-not-exist',
        patch: { title: 'x' },
        now: LATER,
      }),
    ).toBeUndefined();
    expect(
      store.updateFaq({ tenantId: T1, faqId: 'faq-does-not-exist', patch: { answer: 'x' } }),
    ).toBeUndefined();
    expect(
      store.updateShortcut({
        tenantId: T1,
        shortcutId: 'shortcut-does-not-exist',
        patch: { content: 'x' },
      }),
    ).toBeUndefined();
  });
});

describe('catalogue', () => {
  it('expresses colour and size as variants of one product, not as columns', () => {
    const store = new KefuStore();
    const spuRow = store.createSpu({
      tenantId: T1,
      storeId: 'store-acme-flagship',
      productCode: 'TS-001',
      title: '纯棉圆领 T 恤',
      sellingPoints: ['100% 纯棉'],
      now: NOW,
    });
    const spu = created(spuRow);
    expect(spu).toMatchObject({
      productCode: 'TS-001',
      categoryId: null,
      shelfStatus: 'unknown',
      sourceType: 'manual',
      createdAt: NOW,
    });

    const black = store.createSku({
      tenantId: T1,
      storeId: 'store-acme-flagship',
      spuId: spu.id,
      skuCode: 'TS-001-BLK-M',
      variant: { 颜色: '黑', 尺码: 'M' },
      now: NOW,
    });
    const white = store.createSku({
      tenantId: T1,
      storeId: 'store-acme-flagship',
      spuId: spu.id,
      skuCode: 'TS-001-WHT-L',
      variant: { 颜色: '白', 尺码: 'L' },
      now: NOW,
    });

    expect(black?.variant).toEqual({ 颜色: '黑', 尺码: 'M' });
    expect(white?.status).toBe('active');
    // The product is still one row: the variants point at it, not the reverse.
    expect(store.listSpus(T1).filter((item) => item.id === spu.id).length).toBe(1);
    expect(store.listSkus(T1, spu.id).map((sku) => sku.skuCode)).toEqual([
      'TS-001-BLK-M',
      'TS-001-WHT-L',
    ]);
  });

  it('refuses a variant whose product belongs to another tenant', () => {
    const store = new KefuStore();
    const spu = created(
      store.createSpu({
        tenantId: T1,
        storeId: 'store-acme-flagship',
        productCode: 'TS-002',
        title: '别的租户看不见',
        now: NOW,
      }),
    );

    const foreign = store.createSku({
      tenantId: T2,
      storeId: 'store-beta-official',
      spuId: spu.id,
      skuCode: 'TS-002-BLK-M',
      now: NOW,
    });
    expect(foreign).toBeUndefined();
    expect(store.listSkus(T2, spu.id)).toEqual([]);
  });

  it('keeps a category tree inside one tenant and reports the parent it cannot see', () => {
    const store = new KefuStore();
    const root = store.createCategory({
      tenantId: T1,
      storeId: 'store-acme-flagship',
      code: 'apparel',
      name: '服饰',
      now: NOW,
    });
    const child = store.createCategory({
      tenantId: T1,
      storeId: 'store-acme-flagship',
      parentId: root?.id,
      code: 'shirts',
      name: '衬衫',
      now: NOW,
    });
    expect(child?.parentId).toBe(root?.id);
    expect(child?.status).toBe('enabled');

    const orphan = store.createCategory({
      tenantId: T2,
      storeId: 'store-beta-official',
      parentId: root?.id,
      code: 'shirts',
      name: '越权挂靠',
      now: NOW,
    });
    expect(orphan).toBeUndefined();
    expect(store.listCategories(T2)).toEqual([]);
  });

  it('declares a category attribute once, and only for a category it can see', () => {
    const store = new KefuStore();
    const category = store.createCategory({
      tenantId: T1,
      storeId: 'store-acme-flagship',
      code: 'apparel',
      name: '服饰',
      now: NOW,
    });
    const attribute = store.createCategoryAttribute({
      tenantId: T1,
      categoryId: category?.id ?? '',
      attributeCode: 'sleeve',
      attributeName: '袖长',
      valueType: 'enum',
      isRequired: true,
      isSearchable: true,
      allowedValues: ['长袖', '短袖'],
      now: NOW,
    });
    expect(attribute).toMatchObject({
      attributeCode: 'sleeve',
      valueType: 'enum',
      isRequired: true,
      allowedValues: ['长袖', '短袖'],
    });

    expect(
      store.createCategoryAttribute({
        tenantId: T1,
        categoryId: 'category-does-not-exist',
        attributeCode: 'x',
        attributeName: 'x',
        valueType: 'text',
      }),
    ).toBeUndefined();
    expect(store.listCategoryAttributes(T1, 'category-does-not-exist')).toEqual([]);
  });

  it('moves shelf state and clears the category, keeping what the patch omits', () => {
    const store = new KefuStore();
    const category = store.createCategory({
      tenantId: T1,
      storeId: 'store-acme-flagship',
      code: 'apparel',
      name: '服饰',
      now: NOW,
    });
    const spu = store.createSpu({
      tenantId: T1,
      storeId: 'store-acme-flagship',
      categoryId: category?.id,
      productCode: 'TS-003',
      title: '旧标题',
      subtitle: '旧副标题',
      commonAttributes: { 袖长: '长袖' },
      now: NOW,
    });

    const onShelf = store.updateSpu({
      tenantId: T1,
      spuId: spu?.id ?? '',
      patch: { shelfStatus: 'on_shelf' },
      now: LATER,
    });
    expect(onShelf).toMatchObject({
      title: '旧标题',
      subtitle: '旧副标题',
      commonAttributes: { 袖长: '长袖' },
      shelfStatus: 'on_shelf',
      createdAt: NOW,
      updatedAt: LATER,
    });

    // `null` is a value here, not an absence: it files the product under no
    // category, which is different from leaving the category alone.
    const unfiled = store.updateSpu({
      tenantId: T1,
      spuId: spu?.id ?? '',
      patch: { categoryId: null },
      now: LATER,
    });
    expect(unfiled?.categoryId).toBeNull();
    expect(unfiled?.shelfStatus).toBe('on_shelf');

    const renamed = store.updateSpu({
      tenantId: T1,
      spuId: spu?.id ?? '',
      patch: { title: '新标题' },
      now: LATER,
    });
    expect(renamed?.categoryId).toBeNull();
    expect(renamed?.title).toBe('新标题');
  });

  it('withdraws a variant without deleting it, and refuses another tenant', () => {
    const store = new KefuStore();
    const spu = store.createSpu({
      tenantId: T1,
      storeId: 'store-acme-flagship',
      productCode: 'TS-004',
      title: '停产配色',
      now: NOW,
    });
    const sku = store.createSku({
      tenantId: T1,
      storeId: 'store-acme-flagship',
      spuId: spu?.id ?? '',
      skuCode: 'TS-004-GRN-M',
      variant: { 颜色: '绿' },
      now: NOW,
    });

    const withdrawn = store.updateSku({
      tenantId: T1,
      skuId: sku?.id ?? '',
      patch: { status: 'inactive' },
      now: LATER,
    });
    expect(withdrawn).toMatchObject({
      skuCode: 'TS-004-GRN-M',
      variant: { 颜色: '绿' },
      status: 'inactive',
      createdAt: NOW,
      updatedAt: LATER,
    });
    // Still listed: a withdrawn variant is a state the console has to be able to
    // show and undo, so it does not disappear from the product's variant list.
    expect(store.listSkus(T1, spu?.id ?? '').map((item) => item.id)).toEqual([sku?.id]);

    expect(
      store.updateSku({
        tenantId: T2,
        skuId: sku?.id ?? '',
        patch: { status: 'active' },
        now: LATER,
      }),
    ).toBeUndefined();
    expect(store.getSku(T1, sku?.id ?? '')?.status).toBe('inactive');
  });
});

describe('knowledge variants and imports', () => {
  it('collects the ways one question is asked, and stops using one on its own', () => {
    const store = new KefuStore();
    const faq = store.createFaq({
      tenantId: T1,
      storeId: S1,
      question: '什么时候发货？',
      answer: '付款后 48 小时内发出。',
      tags: ['物流'],
      now: NOW,
    });

    const scheduled = created(
      store.createFaqVariant({
        tenantId: T1,
        faqId: faq.id,
        questionText: '多久能发货',
        source: 'generated',
        now: NOW,
      }),
    );
    const shipped = created(
      store.createFaqVariant({
        tenantId: T1,
        faqId: faq.id,
        questionText: '什么时候能寄出',
        now: NOW,
      }),
    );
    expect(store.listFaqVariants(T1, faq.id).map((item) => item.questionText)).toEqual([
      '多久能发货',
      '什么时候能寄出',
    ]);
    // The default origin is a person: a row nobody labelled is one somebody typed.
    expect(shipped.source).toBe('manual');
    expect(scheduled.source).toBe('generated');

    // Switching one near-question off leaves the FAQ and its siblings alone — the
    // whole reason these are rows rather than one concatenated text column.
    const disabled = store.updateFaqVariant({
      tenantId: T1,
      variantId: scheduled.id,
      patch: { status: 'disabled' },
      now: LATER,
    });
    expect(disabled).toMatchObject({
      questionText: '多久能发货',
      status: 'disabled',
      createdAt: NOW,
      updatedAt: LATER,
    });
    expect(store.listFaqVariants(T1, faq.id)).toHaveLength(2);
    expect(store.listFaqVariants(T1, faq.id).map((item) => item.status)).toEqual([
      'disabled',
      'enabled',
    ]);
  });

  it('refuses a near-question whose FAQ belongs to another tenant', () => {
    const store = new KefuStore();
    const foreign = store.createFaqVariant({
      tenantId: T2,
      faqId: 'faq-acme-1',
      questionText: '别的租户看不见',
      now: NOW,
    });
    expect(foreign).toBeUndefined();
    expect(store.listFaqVariants(T2, 'faq-acme-1')).toEqual([]);
    expect(store.listFaqVariants(T1, 'faq-acme-1')).toEqual([]);
  });

  it('keeps the record of an import, including the lines it could not take', () => {
    const store = new KefuStore();
    const batch = store.createImportBatch({
      tenantId: T1,
      storeId: S1,
      sourceType: 'csv',
      fileObjectKey: 'imports/2026-09/acme.csv',
      fileSha256: 'a'.repeat(64),
      createdBy: 'member-acme-admin',
      now: NOW,
    });
    expect(batch).toMatchObject({
      status: 'uploaded',
      totalRows: 0,
      successRows: 0,
      failedRows: 0,
      startedAt: null,
      finishedAt: null,
    });

    const written = store.appendImportErrors({
      tenantId: T1,
      batchId: batch.id,
      errors: [
        { rowNumber: 7, fieldName: 'sku', errorCode: 'sku_duplicate', rawValueMasked: 'TS-0**' },
        { rowNumber: 3, errorCode: 'price_missing', errorMessage: '价格为空' },
      ],
      now: NOW,
    });
    // Ordered by the row an operator has to go and look at, not by arrival —
    // and the order the lines were reported in is not preserved.
    expect(store.listImportErrors(T1, batch.id).map((item) => item.rowNumber)).toEqual([3, 7]);
    expect(written?.map((item) => item.errorCode)).toEqual(['sku_duplicate', 'price_missing']);
    expect(store.listImportErrors(T1, batch.id)[1]).toMatchObject({
      rowNumber: 7,
      fieldName: 'sku',
      rawValueMasked: 'TS-0**',
      errorMessage: null,
    });

    // A batch that partly failed is a finished batch, not an open one: the
    // counts and the status both move together.
    const finished = store.updateImportBatch({
      tenantId: T1,
      batchId: batch.id,
      patch: { status: 'partial_failed', totalRows: 400, successRows: 398, failedRows: 2 },
      now: LATER,
    });
    expect(finished).toMatchObject({
      status: 'partial_failed',
      successRows: 398,
      failedRows: 2,
      createdAt: NOW,
      updatedAt: LATER,
    });
    // What the batch is *about* cannot be rewritten: the file and its hash are
    // what the row was created from.
    expect(finished?.fileSha256).toBe('a'.repeat(64));
  });

  it('refuses to record a failed line against another tenant batch', () => {
    const store = new KefuStore();
    const batch = store.createImportBatch({
      tenantId: T1,
      storeId: S1,
      sourceType: 'xlsx',
      now: NOW,
    });

    expect(
      store.appendImportErrors({
        tenantId: T2,
        batchId: batch.id,
        errors: [{ rowNumber: 1, errorCode: 'whatever' }],
        now: NOW,
      }),
    ).toBeUndefined();
    expect(store.getImportBatch(T2, batch.id)).toBeUndefined();
    expect(store.listImportErrors(T1, batch.id)).toEqual([]);
  });

  it('shows a store its own phrases and the whole merchant its merchant-level ones', () => {
    const store = new KefuStore();
    const welcome = store.createShortcut({
      tenantId: T1,
      storeId: null,
      code: 'welcome',
      title: '欢迎语',
      content: '您好，很高兴为您服务。',
      sortOrder: 1,
      now: NOW,
    });
    store.createShortcut({
      tenantId: T1,
      storeId: S1,
      code: 'delivery',
      title: '本店发货时效',
      content: '下单后 48 小时内发货。',
      sortOrder: 9,
      now: NOW,
    });

    // The management list is every row the tenant owns, whatever its scope.
    expect(store.listShortcuts(T1).map((item) => item.code)).toContain('welcome');
    // The working list for one store is that store's own plus the merchant's.
    // Store-level rows sort first even though `welcome` carries the lower
    // sortOrder: a store's own phrases are the ones its agents reach for most.
    const flagship = store.listShortcuts(T1, S1);
    expect(flagship.map((item) => item.scopeType)).toEqual(['store', 'store', 'store', 'tenant']);
    expect(flagship.map((item) => item.code)).toContain('welcome');
    expect(flagship.map((item) => item.code)).toContain('delivery');
    // Within one scope the order is `sortOrder`, so `delivery` (9) lands after
    // the seeded phrases (0) rather than wherever it was inserted.
    expect(flagship[flagship.length - 2]?.code).toBe('delivery');
    // A second store of the same tenant sees the merchant's phrase and not the
    // flagship's own.
    const codes = store.listShortcuts(T1, S2).map((item) => item.code);
    expect(codes).toContain('welcome');
    expect(codes).not.toContain('delivery');
    expect(codes).not.toContain('greeting');

    expect(welcome).toMatchObject({ scopeType: 'tenant', storeId: null, sortOrder: 1 });
    // Neither the merchant-level phrase nor anything else of T1's crosses over.
    expect(store.listShortcuts(T2).every((item) => item.tenantId === T2)).toBe(true);
    expect(store.listShortcuts(T2).map((item) => item.code)).not.toContain('welcome');
  });

  it('does not let a shortcut patch move a phrase between stores and the tenant', () => {
    const store = new KefuStore();
    const updated = store.updateShortcut({
      tenantId: T1,
      shortcutId: 'shortcut-acme-greeting',
      patch: { content: '您好，云集服饰为您服务。', intentCode: 'greeting', sortOrder: 5 },
      now: LATER,
    });
    expect(updated).toMatchObject({
      scopeType: 'store',
      storeId: S1,
      code: 'greeting',
      intentCode: 'greeting',
      sortOrder: 5,
      updatedAt: LATER,
    });
  });
});

describe('directory upserts', () => {
  it('appends a directory row the store has never seen', () => {
    const store = new KefuStore();
    store.upsertTenant({
      id: 'tenant-trial-u-1',
      code: 'trial-u-1',
      name: '体验租户',
      enabled: true,
      createdAt: NOW,
    });
    store.upsertStore({
      id: 'store-trial-u-1',
      tenantId: 'tenant-trial-u-1',
      code: 'main',
      name: '默认门店',
      enabled: true,
      createdAt: NOW,
    });
    store.upsertMember({
      id: 'member-trial-u-1',
      tenantId: 'tenant-trial-u-1',
      storeId: 'store-trial-u-1',
      role: 'merchant_admin',
      username: 'u-1',
      displayName: 'u-1',
      enabled: true,
      createdAt: NOW,
    });

    expect(store.getTenant('tenant-trial-u-1')?.code).toBe('trial-u-1');
    expect(store.getStore('tenant-trial-u-1', 'store-trial-u-1')?.code).toBe('main');
    expect(store.getMember('member-trial-u-1')?.role).toBe('merchant_admin');
    expect(store.listMembers('tenant-trial-u-1').map((member) => member.id)).toEqual([
      'member-trial-u-1',
    ]);
  });

  it('replaces the row with the same id instead of appending a second one', () => {
    const store = new KefuStore();
    const before = store.listTenants().length;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      store.upsertTenant({
        id: 'tenant-trial-u-2',
        code: 'trial-u-2',
        name: attempt === 0 ? '体验租户' : '体验租户（已改名）',
        enabled: true,
        createdAt: NOW,
      });
    }
    store.upsertStore({
      id: 'store-trial-u-2',
      tenantId: 'tenant-trial-u-2',
      code: 'main',
      name: '默认门店',
      enabled: true,
      createdAt: NOW,
    });
    store.upsertStore({
      id: 'store-trial-u-2',
      tenantId: 'tenant-trial-u-2',
      code: 'main',
      name: '默认门店（已改名）',
      enabled: true,
      createdAt: NOW,
    });

    expect(store.listTenants().length).toBe(before + 1);
    expect(store.getTenant('tenant-trial-u-2')?.name).toBe('体验租户（已改名）');
    expect(store.listStores('tenant-trial-u-2')).toHaveLength(1);
    expect(store.listStores('tenant-trial-u-2')[0]?.name).toBe('默认门店（已改名）');
  });

  it('renames a seeded row in place, keeping the directory the same size', () => {
    const store = new KefuStore();
    const seeded = store.getTenant(T1);
    expect(seeded).toBeDefined();
    const tenants = store.listTenants().length;

    store.upsertTenant({ ...(seeded as NonNullable<typeof seeded>), name: '云集服饰（重命名）' });

    expect(store.listTenants()).toHaveLength(tenants);
    expect(store.getTenant(T1)?.name).toBe('云集服饰（重命名）');
  });

  it('accepts a platform member that belongs to no tenant', () => {
    const store = new KefuStore();
    store.upsertMember({
      id: 'member-platform-trial',
      tenantId: null,
      storeId: null,
      role: 'platform_admin',
      username: 'platform-admin',
      displayName: '平台管理员',
      enabled: true,
      createdAt: NOW,
    });
    expect(store.getMember('member-platform-trial')?.tenantId).toBeNull();
    expect(store.listMembers(T1).some((member) => member.id === 'member-platform-trial')).toBe(
      false,
    );
  });
});
