import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import {
  type CategoryAttribute,
  type FaqItem,
  type FaqItemPatch,
  type FaqQuestionVariant,
  type FaqQuestionVariantPatch,
  type ImportBatchStatus,
  type ImportBatchWithErrors,
  type KnowledgeIndexStatusFilter,
  type KnowledgeIndexStatusSummary,
  type Member,
  type NewCategoryAttribute,
  type NewFaqQuestionVariant,
  type NewProductCategory,
  type NewProductImportBatch,
  type NewProductImportError,
  type NewProductSku,
  type NewProductSpu,
  type Product,
  type ProductCategory,
  type ProductImportApplyResult,
  type ProductImportBatch,
  type ProductImportBatchPatch,
  type ProductImportError,
  type ProductImportParseResult,
  type ProductPatch,
  type ProductSku,
  type ProductSkuPatch,
  type ProductSpu,
  type ProductSpuPatch,
  type Shortcut,
  type ShortcutPatch,
  planProductImport,
} from '@kefu/core';
import { AccessService } from '../platform/access.service';
import { PLATFORM_REPOSITORY, type PlatformRepository } from '../platform/platform-repository';

/** Input used to create a knowledge product. */
export type CreateProductInput = {
  readonly storeId: string;
  readonly sku: string;
  readonly title: string;
  readonly description: string;
};

/** Input used to create a knowledge FAQ entry. */
export type CreateFaqInput = {
  readonly storeId: string;
  readonly question: string;
  readonly answer: string;
  readonly tags: ReadonlyArray<string>;
};

/**
 * Input used to create a knowledge shortcut.
 *
 * `storeId: null` creates a merchant-level phrase every store sees; naming a
 * store creates one that only that store has. `undefined` is refused rather than
 * treated as either, because a caller that forgot the field would otherwise
 * silently get the broader of the two.
 */
export type CreateShortcutInput = {
  readonly storeId: string | null;
  readonly code: string;
  readonly title: string;
  readonly content: string;
  readonly intentCode?: string | null;
  readonly sortOrder?: number;
};

/** Input used to add a near-question to a FAQ. */
export type CreateFaqVariantInput = Omit<NewFaqQuestionVariant, 'tenantId' | 'faqId' | 'now'>;

/**
 * Input used to open an import batch.
 *
 * `createdBy` is absent on purpose: the service fills it from the acting member
 * rather than trusting a body to name someone else as the author.
 */
export type CreateImportBatchInput = Omit<NewProductImportBatch, 'tenantId' | 'createdBy' | 'now'>;

/**
 * Input used to apply an uploaded product file.
 *
 * The parse result rather than the bytes: reading a file is the upload layer's
 * job, and whether an unreadable file is a request error is decided there, where
 * the reasons can be handed back to the caller. What arrives here is a file that
 * was read, and the question is only what to do with it.
 */
export type ApplyImportBatchInput = {
  readonly storeId: string;
  readonly parsed: ProductImportParseResult;
};

/** Input used to create a catalogue category. */
export type CreateCategoryInput = Omit<NewProductCategory, 'tenantId'>;

/** Input used to declare one attribute of a category. */
export type CreateCategoryAttributeInput = Omit<
  NewCategoryAttribute,
  'tenantId' | 'categoryId' | 'now'
>;

/** Input used to create a product (SPU). */
export type CreateSpuInput = Omit<NewProductSpu, 'tenantId' | 'now'>;

/** Input used to create a variant (SKU); its store is the product's store. */
export type CreateSkuInput = Omit<NewProductSku, 'tenantId' | 'spuId' | 'storeId' | 'now'>;

/** A product and the variants it is sold in. */
export type SpuWithSkus = {
  readonly spu: ProductSpu;
  readonly skus: ReadonlyArray<ProductSku>;
};

/**
 * Knowledge base behavior for products, FAQs and shortcuts.
 *
 * Reads are available to every member within their store scope; writes require a
 * tenant or platform administrator and always target a store inside the tenant.
 * A single-record read resolves the record first and then checks its store
 * against the actor scope, so a store mismatch is a 403 rather than a silent
 * 404 — the same distinction the list endpoints make.
 *
 * The reads return 停用 rows too. 停用 is a reversible state rather than a
 * deletion, so the management surface has to be able to see a disabled row and
 * put it back; hiding it would make it unreachable. What a disabled row may no
 * longer do is answer a customer — that rule is applied by the reply pipeline
 * through `usableKnowledge`, and it is the only place it is applied.
 *
 * The catalogue below (categories, their attribute declarations, products and
 * their variants) is a separate model from the flat `products` rows above: those
 * are what the reply pipeline reads today, this is the structure SDD-012 imports
 * into and SDD-014 indexes. Both are served from this one module because they
 * are the same job to the merchant.
 */
@Injectable()
export class KnowledgeService {
  constructor(
    @Inject(PLATFORM_REPOSITORY) private readonly repository: PlatformRepository,
    private readonly access: AccessService,
  ) {}

  async listProducts(
    tenantId: string,
    member: Member,
    storeId?: string,
  ): Promise<ReadonlyArray<Product>> {
    const scope = await this.access.resolveStoreScope(member, tenantId, storeId);
    return this.repository.listProducts(tenantId, scope);
  }

  async getProduct(tenantId: string, member: Member, productId: string): Promise<Product> {
    const product = await this.repository.getProduct(tenantId, productId);
    if (product === undefined) {
      throw new NotFoundException('product not found in tenant scope');
    }
    await this.access.resolveStoreScope(member, tenantId, product.storeId);
    return product;
  }

  async createProduct(
    tenantId: string,
    member: Member,
    input: CreateProductInput,
  ): Promise<Product> {
    this.access.requireConfigurator(member);
    await this.access.assertStoreInTenant(tenantId, input.storeId);
    return this.repository.createProduct({
      tenantId,
      storeId: input.storeId,
      sku: input.sku,
      title: input.title,
      description: input.description,
    });
  }

  /**
   * Change one product, including taking it out of service (`enabled: false`).
   *
   * @param tenantId - Effective tenant scope of the request.
   * @param member - Resolved acting member.
   * @param productId - The product to change.
   * @param patch - Fields to change; an omitted field keeps its value.
   * @returns The product as it now stands.
   * @throws {ForbiddenException} When the member may not change knowledge, or
   * the record lives in a store outside the member scope.
   * @throws {NotFoundException} When the tenant scope has no such product.
   * @throws {BadRequestException} When the patch names no field.
   */
  async updateProduct(
    tenantId: string,
    member: Member,
    productId: string,
    patch: ProductPatch,
  ): Promise<Product> {
    this.access.requireConfigurator(member);
    requireUpdateFields([patch.sku, patch.title, patch.description, patch.enabled]);
    const current = await this.repository.getProduct(tenantId, productId);
    if (current === undefined) {
      throw new NotFoundException('product not found in tenant scope');
    }
    await this.access.resolveStoreScope(member, tenantId, current.storeId);
    const updated = await this.repository.updateProduct(tenantId, productId, patch);
    if (updated === undefined) {
      // The row was there a moment ago and is gone now.
      throw new NotFoundException('product not found in tenant scope');
    }
    return updated;
  }

  async listFaqs(
    tenantId: string,
    member: Member,
    storeId?: string,
  ): Promise<ReadonlyArray<FaqItem>> {
    const scope = await this.access.resolveStoreScope(member, tenantId, storeId);
    return this.repository.listFaqs(tenantId, scope);
  }

  async getFaq(tenantId: string, member: Member, faqId: string): Promise<FaqItem> {
    const faq = await this.repository.getFaq(tenantId, faqId);
    if (faq === undefined) {
      throw new NotFoundException('faq not found in tenant scope');
    }
    await this.access.resolveStoreScope(member, tenantId, faq.storeId);
    return faq;
  }

  async createFaq(tenantId: string, member: Member, input: CreateFaqInput): Promise<FaqItem> {
    this.access.requireConfigurator(member);
    await this.access.assertStoreInTenant(tenantId, input.storeId);
    return this.repository.createFaq({
      tenantId,
      storeId: input.storeId,
      question: input.question,
      answer: input.answer,
      tags: input.tags,
    });
  }

  /**
   * Change one FAQ entry, including taking it out of service (`enabled: false`).
   *
   * @param tenantId - Effective tenant scope of the request.
   * @param member - Resolved acting member.
   * @param faqId - The entry to change.
   * @param patch - Fields to change; an omitted field keeps its value.
   * @returns The entry as it now stands.
   * @throws {ForbiddenException} When the member may not change knowledge, or
   * the record lives in a store outside the member scope.
   * @throws {NotFoundException} When the tenant scope has no such entry.
   * @throws {BadRequestException} When the patch names no field.
   */
  async updateFaq(
    tenantId: string,
    member: Member,
    faqId: string,
    patch: FaqItemPatch,
  ): Promise<FaqItem> {
    this.access.requireConfigurator(member);
    requireUpdateFields([patch.question, patch.answer, patch.tags, patch.enabled]);
    const current = await this.repository.getFaq(tenantId, faqId);
    if (current === undefined) {
      throw new NotFoundException('faq not found in tenant scope');
    }
    await this.access.resolveStoreScope(member, tenantId, current.storeId);
    const updated = await this.repository.updateFaq(tenantId, faqId, patch);
    if (updated === undefined) {
      // The row was there a moment ago and is gone now.
      throw new NotFoundException('faq not found in tenant scope');
    }
    return updated;
  }

  /**
   * What this tenant's index is doing, narrowed to the caller's store scope.
   *
   * The store resolution is the same one every other knowledge read uses
   * ({@link AccessService.resolveStoreScope}): an admin's optional filter is
   * checked against the tenant, an agent is pinned to their own store, and the
   * filter the repository sees always carries the *resolved* scope rather than
   * the requested one — so the store a caller cannot name, they also cannot read.
   */
  async indexStatus(
    tenantId: string,
    member: Member,
    filter: KnowledgeIndexStatusFilter,
  ): Promise<KnowledgeIndexStatusSummary> {
    const scope = await this.access.resolveStoreScope(member, tenantId, filter.storeId);
    return this.repository.knowledgeIndexStatus(tenantId, {
      ...filter,
      ...(scope === undefined ? {} : { storeId: scope }),
    });
  }

  async listShortcuts(
    tenantId: string,
    member: Member,
    storeId?: string,
  ): Promise<ReadonlyArray<Shortcut>> {
    const scope = await this.access.resolveStoreScope(member, tenantId, storeId);
    return this.repository.listShortcuts(tenantId, scope);
  }

  async getShortcut(tenantId: string, member: Member, shortcutId: string): Promise<Shortcut> {
    const shortcut = await this.repository.getShortcut(tenantId, shortcutId);
    if (shortcut === undefined) {
      throw new NotFoundException('shortcut not found in tenant scope');
    }
    await this.access.resolveStoreScope(member, tenantId, shortcut.storeId ?? undefined);
    return shortcut;
  }

  async createShortcut(
    tenantId: string,
    member: Member,
    input: CreateShortcutInput,
  ): Promise<Shortcut> {
    this.access.requireConfigurator(member);
    if (input.storeId !== null) {
      // Nothing to check for a merchant-level phrase: it names no store, so
      // there is no store that could be outside the tenant.
      await this.access.assertStoreInTenant(tenantId, input.storeId);
    }
    return this.repository.createShortcut({
      tenantId,
      storeId: input.storeId,
      code: input.code,
      title: input.title,
      content: input.content,
      ...(input.intentCode === undefined ? {} : { intentCode: input.intentCode }),
      ...(input.sortOrder === undefined ? {} : { sortOrder: input.sortOrder }),
    });
  }

  /**
   * Change one shortcut, including taking it out of service (`enabled: false`).
   *
   * @param tenantId - Effective tenant scope of the request.
   * @param member - Resolved acting member.
   * @param shortcutId - The shortcut to change.
   * @param patch - Fields to change; an omitted field keeps its value.
   * @returns The shortcut as it now stands.
   * @throws {ForbiddenException} When the member may not change knowledge, or
   * the record lives in a store outside the member scope.
   * @throws {NotFoundException} When the tenant scope has no such shortcut.
   * @throws {BadRequestException} When the patch names no field.
   */
  async updateShortcut(
    tenantId: string,
    member: Member,
    shortcutId: string,
    patch: ShortcutPatch,
  ): Promise<Shortcut> {
    this.access.requireConfigurator(member);
    requireUpdateFields([
      patch.code,
      patch.title,
      patch.content,
      patch.intentCode,
      patch.sortOrder,
      patch.enabled,
    ]);
    const current = await this.repository.getShortcut(tenantId, shortcutId);
    if (current === undefined) {
      throw new NotFoundException('shortcut not found in tenant scope');
    }
    await this.access.resolveStoreScope(member, tenantId, current.storeId ?? undefined);
    const updated = await this.repository.updateShortcut(tenantId, shortcutId, patch);
    if (updated === undefined) {
      // The row was there a moment ago and is gone now.
      throw new NotFoundException('shortcut not found in tenant scope');
    }
    return updated;
  }

  // --------------------------------------------------------------------------
  // Catalogue: categories, attribute declarations, products and variants
  //
  // Same authorization as the knowledge writes above: reading needs the member's
  // store scope, writing needs a configurator. A reference to a category is
  // checked before it is written, so a product cannot be filed under another
  // store's branch and a variant cannot hang off another tenant's product.
  // --------------------------------------------------------------------------

  async listCategories(
    tenantId: string,
    member: Member,
    storeId?: string,
  ): Promise<ReadonlyArray<ProductCategory>> {
    const scope = await this.access.resolveStoreScope(member, tenantId, storeId);
    return this.repository.listCategories(tenantId, scope);
  }

  async getCategory(
    tenantId: string,
    member: Member,
    categoryId: string,
  ): Promise<ProductCategory> {
    const category = await this.repository.getCategory(tenantId, categoryId);
    if (category === undefined) {
      throw new NotFoundException('category not found in tenant scope');
    }
    await this.access.resolveStoreScope(member, tenantId, category.storeId);
    return category;
  }

  async createCategory(
    tenantId: string,
    member: Member,
    input: CreateCategoryInput,
  ): Promise<ProductCategory> {
    this.access.requireConfigurator(member);
    await this.access.assertStoreInTenant(tenantId, input.storeId);
    if (input.parentId !== undefined && input.parentId !== null) {
      await this.requireCategoryInStore(tenantId, input.parentId, input.storeId);
    }
    const created = await this.repository.createCategory({ ...input, tenantId });
    if (created === undefined) {
      throw new NotFoundException('parent category not found in tenant scope');
    }
    return created;
  }

  async listCategoryAttributes(
    tenantId: string,
    member: Member,
    categoryId: string,
  ): Promise<ReadonlyArray<CategoryAttribute>> {
    const category = await this.getCategory(tenantId, member, categoryId);
    return this.repository.listCategoryAttributes(tenantId, category.id);
  }

  async createCategoryAttribute(
    tenantId: string,
    member: Member,
    categoryId: string,
    input: CreateCategoryAttributeInput,
  ): Promise<CategoryAttribute> {
    this.access.requireConfigurator(member);
    const category = await this.repository.getCategory(tenantId, categoryId);
    if (category === undefined) {
      throw new NotFoundException('category not found in tenant scope');
    }
    await this.access.resolveStoreScope(member, tenantId, category.storeId);
    const created = await this.repository.createCategoryAttribute({
      ...input,
      tenantId,
      categoryId,
    });
    if (created === undefined) {
      throw new NotFoundException('category not found in tenant scope');
    }
    return created;
  }

  async listSpus(
    tenantId: string,
    member: Member,
    filter: {
      readonly storeId?: string | undefined;
      readonly categoryId?: string | undefined;
    } = {},
  ): Promise<ReadonlyArray<ProductSpu>> {
    const scope = await this.access.resolveStoreScope(member, tenantId, filter.storeId);
    return this.repository.listSpus(tenantId, {
      ...(scope === undefined ? {} : { storeId: scope }),
      ...(filter.categoryId === undefined ? {} : { categoryId: filter.categoryId }),
    });
  }

  async getSpuWithSkus(tenantId: string, member: Member, spuId: string): Promise<SpuWithSkus> {
    const spu = await this.repository.getSpu(tenantId, spuId);
    if (spu === undefined) {
      throw new NotFoundException('product not found in tenant scope');
    }
    await this.access.resolveStoreScope(member, tenantId, spu.storeId);
    return { spu, skus: await this.repository.listSkus(tenantId, spu.id) };
  }

  async createSpu(tenantId: string, member: Member, input: CreateSpuInput): Promise<ProductSpu> {
    this.access.requireConfigurator(member);
    await this.access.assertStoreInTenant(tenantId, input.storeId);
    if (input.categoryId !== undefined && input.categoryId !== null) {
      await this.requireCategoryInStore(tenantId, input.categoryId, input.storeId);
    }
    const created = await this.repository.createSpu({ ...input, tenantId });
    if (created === undefined) {
      throw new NotFoundException('category not found in tenant scope');
    }
    return created;
  }

  /**
   * Change one product, including its shelf state and its category.
   *
   * @param tenantId - Effective tenant scope of the request.
   * @param member - Resolved acting member.
   * @param spuId - The product to change.
   * @param patch - Fields to change; an omitted field keeps its value, and an
   * explicit `null` category files the product under no category.
   * @returns The product as it now stands.
   * @throws {ForbiddenException} When the member may not change knowledge, or
   * the product lives in a store outside the member scope.
   * @throws {NotFoundException} When the tenant scope has no such product.
   * @throws {BadRequestException} When the patch names no field, or files the
   * product under a category of another store.
   */
  async updateSpu(
    tenantId: string,
    member: Member,
    spuId: string,
    patch: ProductSpuPatch,
  ): Promise<ProductSpu> {
    this.access.requireConfigurator(member);
    requireUpdateFields([
      patch.categoryId,
      patch.title,
      patch.subtitle,
      patch.mainImageUrl,
      patch.productUrl,
      patch.sellingPoints,
      patch.commonAttributes,
      patch.shelfStatus,
    ]);
    const current = await this.repository.getSpu(tenantId, spuId);
    if (current === undefined) {
      throw new NotFoundException('product not found in tenant scope');
    }
    await this.access.resolveStoreScope(member, tenantId, current.storeId);
    if (patch.categoryId !== undefined && patch.categoryId !== null) {
      await this.requireCategoryInStore(tenantId, patch.categoryId, current.storeId);
    }
    const updated = await this.repository.updateSpu(tenantId, spuId, patch);
    if (updated === undefined) {
      // The row was there a moment ago and is gone now.
      throw new NotFoundException('product not found in tenant scope');
    }
    return updated;
  }

  async createSku(
    tenantId: string,
    member: Member,
    spuId: string,
    input: CreateSkuInput,
  ): Promise<ProductSku> {
    this.access.requireConfigurator(member);
    const spu = await this.repository.getSpu(tenantId, spuId);
    if (spu === undefined) {
      throw new NotFoundException('product not found in tenant scope');
    }
    await this.access.resolveStoreScope(member, tenantId, spu.storeId);
    // The variant's store is the product's, never the caller's claim: a SKU of
    // another store's product would be invisible to the store that owns it.
    const created = await this.repository.createSku({
      ...input,
      tenantId,
      spuId,
      storeId: spu.storeId,
    });
    if (created === undefined) {
      throw new NotFoundException('product not found in tenant scope');
    }
    return created;
  }

  /**
   * Change one variant, including withdrawing it (`status: 'inactive'`).
   *
   * @param tenantId - Effective tenant scope of the request.
   * @param member - Resolved acting member.
   * @param skuId - The variant to change.
   * @param patch - Fields to change; an omitted field keeps its value.
   * @returns The variant as it now stands.
   * @throws {ForbiddenException} When the member may not change knowledge, or
   * the variant lives in a store outside the member scope.
   * @throws {NotFoundException} When the tenant scope has no such variant.
   * @throws {BadRequestException} When the patch names no field.
   */
  async updateSku(
    tenantId: string,
    member: Member,
    skuId: string,
    patch: ProductSkuPatch,
  ): Promise<ProductSku> {
    this.access.requireConfigurator(member);
    requireUpdateFields([patch.skuCode, patch.variant, patch.searchAttributes, patch.status]);
    const current = await this.repository.getSku(tenantId, skuId);
    if (current === undefined) {
      throw new NotFoundException('variant not found in tenant scope');
    }
    await this.access.resolveStoreScope(member, tenantId, current.storeId);
    const updated = await this.repository.updateSku(tenantId, skuId, patch);
    if (updated === undefined) {
      // The row was there a moment ago and is gone now.
      throw new NotFoundException('variant not found in tenant scope');
    }
    return updated;
  }

  // --------------------------------------------------------------------------
  // FAQ near-questions
  //
  // A variant is a child of one FAQ and inherits its scope, so every method here
  // resolves the FAQ first: reading needs the member's store scope for that FAQ,
  // writing needs a configurator. A variant id from another tenant answers 404,
  // the same as any other out-of-scope id.
  // --------------------------------------------------------------------------

  async listFaqVariants(
    tenantId: string,
    member: Member,
    faqId: string,
  ): Promise<ReadonlyArray<FaqQuestionVariant>> {
    const faq = await this.requireFaq(tenantId, member, faqId);
    return this.repository.listFaqVariants(tenantId, faq.id);
  }

  async createFaqVariant(
    tenantId: string,
    member: Member,
    faqId: string,
    input: CreateFaqVariantInput,
  ): Promise<FaqQuestionVariant> {
    this.access.requireConfigurator(member);
    const faq = await this.requireFaq(tenantId, member, faqId);
    const created = await this.repository.createFaqVariant({
      tenantId,
      faqId: faq.id,
      questionText: input.questionText,
      ...(input.source === undefined ? {} : { source: input.source }),
    });
    if (created === undefined) {
      // The FAQ was there one statement ago; nothing else can produce this.
      throw new NotFoundException('faq not found in tenant scope');
    }
    return created;
  }

  async updateFaqVariant(
    tenantId: string,
    member: Member,
    variantId: string,
    patch: FaqQuestionVariantPatch,
  ): Promise<FaqQuestionVariant> {
    this.access.requireConfigurator(member);
    requireUpdateFields([patch.questionText, patch.status]);
    const current = await this.repository.getFaqVariant(tenantId, variantId);
    if (current === undefined) {
      throw new NotFoundException('faq variant not found in tenant scope');
    }
    await this.requireFaq(tenantId, member, current.faqId);
    const updated = await this.repository.updateFaqVariant(tenantId, variantId, patch);
    if (updated === undefined) {
      throw new NotFoundException('faq variant not found in tenant scope');
    }
    return updated;
  }

  // --------------------------------------------------------------------------
  // Product import batches
  //
  // The record of an upload, not the upload itself: SDD-012 reads the file and
  // writes what it found here. Opening a batch needs a configurator, and reading
  // one needs the member's store scope, because the failure lines quote buyer
  // data that a store may not be entitled to see.
  // --------------------------------------------------------------------------

  async listImportBatches(
    tenantId: string,
    member: Member,
    storeId?: string,
  ): Promise<ReadonlyArray<ProductImportBatch>> {
    const scope = await this.access.resolveStoreScope(member, tenantId, storeId);
    return this.repository.listImportBatches(tenantId, scope);
  }

  async getImportBatchWithErrors(
    tenantId: string,
    member: Member,
    batchId: string,
  ): Promise<ImportBatchWithErrors> {
    const batch = await this.requireImportBatch(tenantId, member, batchId);
    const errors = await this.repository.listImportErrors(tenantId, batch.id);
    return { batch, errors };
  }

  async createImportBatch(
    tenantId: string,
    member: Member,
    input: CreateImportBatchInput,
  ): Promise<ProductImportBatch> {
    this.access.requireConfigurator(member);
    await this.access.assertStoreInTenant(tenantId, input.storeId);
    return this.repository.createImportBatch({
      tenantId,
      storeId: input.storeId,
      sourceType: input.sourceType,
      ...(input.fileObjectKey === undefined ? {} : { fileObjectKey: input.fileObjectKey }),
      ...(input.fileSha256 === undefined ? {} : { fileSha256: input.fileSha256 }),
      createdBy: member.id,
    });
  }

  async updateImportBatch(
    tenantId: string,
    member: Member,
    batchId: string,
    patch: ProductImportBatchPatch,
  ): Promise<ProductImportBatch> {
    this.access.requireConfigurator(member);
    requireUpdateFields([
      patch.status,
      patch.totalRows,
      patch.successRows,
      patch.failedRows,
      patch.startedAt,
      patch.finishedAt,
    ]);
    const current = await this.requireImportBatch(tenantId, member, batchId);
    const updated = await this.repository.updateImportBatch(tenantId, current.id, patch);
    if (updated === undefined) {
      throw new NotFoundException('import batch not found in tenant scope');
    }
    return updated;
  }

  /**
   * Record the lines one import could not take.
   *
   * The counts are not derived here: the caller reports what it read, and a
   * mismatch between the counts and the error rows is a fact about the import
   * worth being able to see rather than one this method should hide by
   * recomputing.
   *
   * @param tenantId - Effective tenant scope of the request.
   * @param member - Acting member; must be a configurator.
   * @param batchId - The batch the lines belong to.
   * @param errors - One entry per failed row.
   * @returns The rows written.
   * @throws {NotFoundException} When the tenant scope has no such batch.
   */
  async appendImportErrors(
    tenantId: string,
    member: Member,
    batchId: string,
    errors: ReadonlyArray<Omit<NewProductImportError, 'tenantId' | 'batchId' | 'now'>>,
  ): Promise<ReadonlyArray<ProductImportError>> {
    this.access.requireConfigurator(member);
    const batch = await this.requireImportBatch(tenantId, member, batchId);
    const written = await this.repository.appendImportErrors({
      tenantId,
      batchId: batch.id,
      errors,
    });
    if (written === undefined) {
      throw new NotFoundException('import batch not found in tenant scope');
    }
    return written;
  }

  /**
   * Apply one already-parsed product file to this store's catalogue.
   *
   * The three facts the plan needs — the store's categories, products and
   * variants — are read here rather than inside the write, because deciding
   * create-versus-update is a pure question about what the store has, and it
   * should be answerable without a transaction open. What follows is one call:
   * the products, the batch that records the attempt and the lines it refused
   * land together, so an operator never sees a partial import described as a
   * complete one.
   *
   * The counts handed to the batch are the receipt, not a recomputation. Two
   * failure counts travel separately because they are different events: a row
   * the parser could not read never reached the catalogue, while a row the plan
   * refused was understood and deliberately not written. Both are rows the
   * operator has to go and fix, and both are reported with their row numbers.
   *
   * @param tenantId - Effective tenant scope of the request.
   * @param member - Acting member; must be a configurator.
   * @param input - The target store and the file's parse result.
   * @returns The batch, its failed lines and the counts.
   * @throws {ForbiddenException} When the member may not change knowledge, or the
   * store is outside the member scope.
   */
  async applyImportBatch(
    tenantId: string,
    member: Member,
    input: ApplyImportBatchInput,
  ): Promise<ProductImportApplyResult> {
    this.access.requireConfigurator(member);
    await this.access.assertStoreInTenant(tenantId, input.storeId);

    const [categories, existingSpus, existingSkus] = await Promise.all([
      this.repository.listCategories(tenantId, input.storeId),
      this.repository.listSpus(tenantId, { storeId: input.storeId }),
      this.repository.listSkusByStore(tenantId, input.storeId),
    ]);

    const plan = planProductImport({
      rows: input.parsed.previewRows,
      categories,
      existingSpus,
      existingSkus,
    });

    const totalRows = input.parsed.summary.totalRows;
    const unreadableRowCount = input.parsed.summary.failedRowCount;
    const successRows = totalRows - unreadableRowCount - plan.rejectedRowCount;
    // Nothing landed and something was refused: the file was readable, and not
    // one line of it could be taken. That is a failure, not a partial success —
    // an operator told "partial" would go looking for the part that worked.
    const status: ImportBatchStatus =
      successRows === 0
        ? 'failed'
        : unreadableRowCount + plan.rejectedRowCount > 0
          ? 'partial_failed'
          : 'completed';

    // The parser's own failures are recorded beside the plan's, because "which
    // lines did not go in, and why" has one answer, not two. File-level issues
    // are left out on purpose: they carry no row number, and a batch's failure
    // list is indexed by row so the operator can line it up against the sheet.
    const errors: ReadonlyArray<Omit<NewProductImportError, 'tenantId' | 'batchId' | 'now'>> = [
      ...input.parsed.issues
        .filter((issue) => issue.severity === 'error' && issue.rowNumber !== null)
        .map((issue) => ({
          rowNumber: issue.rowNumber ?? 0,
          fieldName: issue.field,
          errorCode: issue.code,
          errorMessage: issue.message,
          rawValueMasked: issue.value,
        })),
      ...plan.rejections.map((rejection) => ({
        rowNumber: rejection.rowNumber,
        fieldName: rejection.fieldName,
        errorCode: rejection.errorCode,
        errorMessage: rejection.errorMessage,
        rawValueMasked: rejection.rawValueMasked,
      })),
    ].sort((a, b) => a.rowNumber - b.rowNumber || a.errorCode.localeCompare(b.errorCode));

    const applied = await this.repository.applyProductImportBatch({
      tenantId,
      storeId: input.storeId,
      sourceType: input.parsed.summary.format,
      createdBy: member.id,
      plan,
      errors,
      status,
      totalRows,
      successRows,
      failedRows: totalRows - successRows,
    });

    return {
      batch: applied.batch,
      errors: applied.errors,
      // 提醒只回答、不落库：进 `errors` 的每一行都按数据行号索引（`row_number` 的
      // CHECK 是 `>= 1`），而「这份表没有规格列，已合成默认规格」说的是整批的事，
      // 硬塞一个行号等于编一个号 —— 回执从此对不上文件。所以 `GET 批次` 读不回它们，
      // 这是已知且刻意的取舍（二期方案 §5）。
      warnings: input.parsed.issues.filter((issue) => issue.severity === 'warning'),
      summary: {
        totalRows,
        successRows,
        createdSpuCount: plan.spuWrites.filter((write) => write.action === 'create').length,
        updatedSpuCount: plan.spuWrites.filter((write) => write.action === 'update').length,
        createdSkuCount: plan.skuWrites.filter((write) => write.action === 'create').length,
        updatedSkuCount: plan.skuWrites.filter((write) => write.action === 'update').length,
        rejectedRowCount: plan.rejectedRowCount,
        unreadableRowCount,
      },
    };
  }

  /**
   * Resolve one FAQ and the store scope the member has over it.
   *
   * @param tenantId - Effective tenant scope of the request.
   * @param member - Acting member.
   * @param faqId - The referenced FAQ.
   * @returns The resolved FAQ.
   * @throws {NotFoundException} When the tenant scope has no such FAQ.
   * @throws {ForbiddenException} When the FAQ is outside the member's store scope.
   */
  private async requireFaq(tenantId: string, member: Member, faqId: string): Promise<FaqItem> {
    const faq = await this.repository.getFaq(tenantId, faqId);
    if (faq === undefined) {
      throw new NotFoundException('faq not found in tenant scope');
    }
    await this.access.resolveStoreScope(member, tenantId, faq.storeId);
    return faq;
  }

  /**
   * Resolve one import batch and the store scope the member has over it.
   *
   * @param tenantId - Effective tenant scope of the request.
   * @param member - Acting member.
   * @param batchId - The referenced batch.
   * @returns The resolved batch.
   * @throws {NotFoundException} When the tenant scope has no such batch.
   * @throws {ForbiddenException} When the batch is outside the member's store scope.
   */
  private async requireImportBatch(
    tenantId: string,
    member: Member,
    batchId: string,
  ): Promise<ProductImportBatch> {
    const batch = await this.repository.getImportBatch(tenantId, batchId);
    if (batch === undefined) {
      throw new NotFoundException('import batch not found in tenant scope');
    }
    await this.access.resolveStoreScope(member, tenantId, batch.storeId);
    return batch;
  }

  /**
   * Resolve a category a write is about to reference.
   *
   * The category tree is store-scoped, so a product may only be filed under a
   * category of its own store: a cross-store reference would put the product in
   * a branch its own store cannot list. The adapters refuse it as well; refusing
   * here turns it into a 400 with a reason instead of a vanished write.
   *
   * @param tenantId - Effective tenant scope of the request.
   * @param categoryId - The referenced category.
   * @param storeId - The store the referencing row belongs to.
   * @returns The resolved category.
   * @throws {NotFoundException} When the tenant scope has no such category.
   * @throws {BadRequestException} When the category belongs to another store.
   */
  private async requireCategoryInStore(
    tenantId: string,
    categoryId: string,
    storeId: string,
  ): Promise<ProductCategory> {
    const category = await this.repository.getCategory(tenantId, categoryId);
    if (category === undefined) {
      throw new NotFoundException('category not found in tenant scope');
    }
    if (category.storeId !== storeId) {
      throw new BadRequestException('category belongs to another store');
    }
    return category;
  }
}

/**
 * Refuse an update that names no field.
 *
 * A patch with nothing in it would be a write that only moves `updated_at`,
 * which the management surface and the audit trail would both read as "someone
 * changed this" — a false signal about a row nothing happened to.
 *
 * @param fields - The patch's field values, in the order the patch declares them.
 * @throws {BadRequestException} When every field is absent.
 */
function requireUpdateFields(fields: ReadonlyArray<unknown>): void {
  if (fields.every((value) => value === undefined)) {
    throw new BadRequestException('at least one field must be provided');
  }
}
