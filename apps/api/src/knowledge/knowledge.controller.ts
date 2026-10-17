import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UploadedFile,
  UseFilters,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Request } from 'express';
import { uploadTooLargeFilter } from '../http/upload-too-large.filter';
import {
  CATALOG_ATTRIBUTE_VALUE_TYPES,
  FAQ_VARIANT_SOURCES,
  FAQ_VARIANT_STATUSES,
  IMPORT_BATCH_STATUSES,
  IMPORT_SOURCE_TYPES,
  KnowledgeIndexStatusSummary,
  MAX_PRODUCT_IMPORT_FILE_BYTES,
  PRODUCT_IMPORT_FILE_FORMATS,
  SKU_STATUSES,
  SPU_SHELF_STATUSES,
  SPU_SOURCE_TYPES,
  parseProductImportFile,
  type CategoryAttribute,
  type FaqItem,
  type FaqQuestionVariant,
  type ImportBatchWithErrors,
  type NewProductImportError,
  type Product,
  type ProductCategory,
  type ProductImportApplyResult,
  type ProductImportBatch,
  type ProductImportColumnMapping,
  type ProductImportError,
  type ProductImportField,
  type ProductImportParseResult,
  type ProductImportFileFormat,
  type ProductSku,
  type ProductSpu,
  type Shortcut,
} from '@kefu/core';
import {
  bodyNullableString,
  bodyOptionalBoolean,
  bodyOptionalCount,
  bodyOptionalEnum,
  bodyOptionalScalarRecord,
  bodyOptionalString,
  bodyOptionalStringArray,
  bodyOptionalStringRecord,
  bodyRecord,
  bodyRequiredEnum,
  bodyRequiredPositiveInt,
  bodyRequiredString,
} from '../http/request-body';
import { AccessService } from '../platform/access.service';
import { parseIndexStatusFilter } from './knowledge-index-status-query';
import { KnowledgeService, type SpuWithSkus } from './knowledge.service';

/** 上传文件在本端点用到的字段。`multer` 不自带类型，为一个 `@types` 包新增依赖不划算。 */
type UploadedImportFile = {
  readonly originalname: string;
  readonly mimetype: string;
  readonly size: number;
  readonly buffer: Buffer;
};

/** 文件名后缀 → 文件格式，只列白名单里的两种。 */
const IMPORT_FILE_EXTENSION_FORMATS: Readonly<Record<string, ProductImportFileFormat>> = {
  '.csv': 'csv',
  '.xlsx': 'xlsx',
};

/**
 * multer 的内存保护线：比业务上限高 1 MiB。
 *
 * 不能直接把它设成业务上限。multer 在字节数**达到** `limits.fileSize` 时就报
 * `LIMIT_FILE_SIZE`，而业务上限的语义是「超过才拒」—— `MAX_PRODUCT_IMPORT_FILE_BYTES`
 * 在 `product-import-parser.ts` 里的判据是 `> `，恰好 10 MiB 的文件是合法的。
 * 把两条线设成同一个值，等于凭空把上限降成 10 MiB − 1 字节，且报出来的是
 * 一句笼统的「超过上限」，看不出差在哪儿。
 *
 * 分开之后各司其职：业务判据由方法体给出精确到字节的 400，multer 只兜住
 * 明显超量的请求，保证服务端不会为一封上传吃掉任意多的内存。
 */
const IMPORT_UPLOAD_MEMORY_BACKSTOP_BYTES = MAX_PRODUCT_IMPORT_FILE_BYTES + 1024 * 1024;

/**
 * 上传闸门，preview 与 apply 共用同一实例。
 *
 * 两个端点必须收下同一批文件：一个预览会拒绝的文件，不该是那个真的被写进库的。
 * 写成同一份而不是各抄一遍，是因为两份会在某次只改一处时悄悄分叉 —— 而分叉的
 * 症状正是「预览说不行，导入却进去了」。
 */
const IMPORT_UPLOAD_INTERCEPTOR = FileInterceptor('file', {
  limits: {
    fileSize: IMPORT_UPLOAD_MEMORY_BACKSTOP_BYTES,
    // 一个文件、少量文本字段：不给调用方留下撑爆内存的口子。
    files: 1,
    fields: 8,
    fieldSize: 64 * 1024,
  },
});

/**
 * 上传超限的 413 收敛回文档化的 400 `bad_request`。
 *
 * 行为在 `../http/upload-too-large.filter.ts` 里写一份，内部会话的附件上传用同一份
 * —— 两个上传口共用「413 → 400」这条映射，各抄一遍则会在某次只改一处时分叉。
 * 这里只留这个端点自己的措辞：它的上限是导入商品文件的业务上限。
 */
const ImportUploadTooLargeFilter = uploadTooLargeFilter(
  `文件超过 ${MAX_PRODUCT_IMPORT_FILE_BYTES} 字节上限`,
);

/**
 * 定导入文件的格式：显式 `format` 优先，否则按文件名后缀推断。
 *
 * 推断不出就拒绝，不猜。`.xls`（Excel 97-2003）不在白名单里 —— 它和 `.xlsx`
 * 是两种完全不同的二进制格式，猜错只会把解析失败推迟到更难定位的地方。
 */
function resolveImportFormat(
  originalName: string,
  declared: string | undefined,
): ProductImportFileFormat {
  if (declared !== undefined) {
    const normalized = declared.trim().toLowerCase().replace(/^\./, '');
    if (!(PRODUCT_IMPORT_FILE_FORMATS as ReadonlyArray<string>).includes(normalized)) {
      throw new BadRequestException([
        `format 只支持 ${PRODUCT_IMPORT_FILE_FORMATS.join(' / ')}，收到 ${declared}`,
      ]);
    }
    return normalized as ProductImportFileFormat;
  }

  const dot = originalName.lastIndexOf('.');
  const extension = dot === -1 ? '' : originalName.slice(dot).toLowerCase();
  const inferred = IMPORT_FILE_EXTENSION_FORMATS[extension];
  if (inferred === undefined) {
    throw new BadRequestException([
      `无法从文件名 ${originalName} 推断格式，请显式传 format=${PRODUCT_IMPORT_FILE_FORMATS.join(' 或 ')}`,
    ]);
  }
  return inferred;
}

/**
 * 解析 multipart 里的 `mapping` 字段：一段 JSON 文本，内容是「我们的字段 → 文件里的列名」。
 *
 * 只校验**形状**（一个对象、值是字符串）；字段名认不认识、列名在不在文件里，交给
 * Parser 判 —— 表头在它手上，而且那三条 reason 是对外稳定的错误码，写两遍会分叉。
 *
 * 坏 JSON 直接 400 而不是忽略。调用方传这段东西，正是因为别名表猜错了列；一段写坏的
 * JSON 若被静默丢掉，他就会在我们**按猜错的那套**读完整份文件之后拿到一个 200 ——
 * 二期方案 §1.1 记的就是这个后果：5,509 个商品会变成 23,328 个，一条错误都不报。
 *
 * 与 `resolveImportFormat` 一样用数组抛 message：全局过滤器只把数组收进 `details`。
 *
 * @returns 映射；没传（或空串）时返回 `undefined`，此时解析行为与加这个字段之前逐位相同。
 */
function resolveImportMapping(
  record: Record<string, unknown>,
): ProductImportColumnMapping | undefined {
  const raw = record['mapping'];
  if (raw === undefined || raw === null) {
    return undefined;
  }
  // 空串等同于没传：`<input>` 为空时前端就是发一个空字符串，那不是一份写坏的映射。
  if (typeof raw === 'string' && raw.trim().length === 0) {
    return undefined;
  }

  let parsed: unknown = raw;
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new BadRequestException([
        `mapping 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`,
      ]);
    }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new BadRequestException([
      'mapping 必须是一个对象，形如 {"product_code":"款式编码","sku_code":"商品编码"}',
    ]);
  }

  const mapping: Partial<Record<ProductImportField, string>> = {};
  for (const [field, column] of Object.entries(parsed)) {
    if (typeof column !== 'string') {
      throw new BadRequestException([
        `mapping.${field} 必须是字符串（文件里的列名），收到 ${typeof column}`,
      ]);
    }
    mapping[field as ProductImportField] = column;
  }
  return mapping;
}

/**
 * 把 Parser 的「整批拒绝」投影成 HTTP 400 的原因清单。
 *
 * 只取 `severity === 'error'` 的 issue：warning（例如「这一列被忽略了」）不是拒绝
 * 的原因，混进来会让调用方以为文件只是被部分接受。文件级 fatal 结果里的 error
 * issue 全部是文件级的（行级 issue 只在非 fatal 的结果里产生）。
 *
 * 为什么是**数组**：`AllExceptionsFilter` 只把数组形式的 message 收进 `details`
 * （`all-exceptions.filter.ts:88`），字符串会被有意隐去，调用方于是只拿到一句
 * "Bad Request"、details 为空 —— 与块 4 修掉的 F1 是同一个坑。因此这里返回数组，
 * 由调用方原样抛给 `BadRequestException`。
 *
 * 兜底一句不可是空数组：那会重新制造一个 `details: []` 的哑 400。正常路径下
 * Parser 的每条 fatal 分支都至少带一条 error issue，所以这一句只在 Parser 未来
 * 新增了一条「忘了带 issue 的 fatal 分支」时才会出现 —— 那时它至少能让调用方
 * 知道是文件本身被拒，而不是自己在别处写错了。
 *
 * @param result - Parser 的输出。
 * @returns 面向调用方的中文原因；至少一条。
 */
function importRejectionReasons(result: ProductImportParseResult): ReadonlyArray<string> {
  const reasons = result.issues
    .filter((issue) => issue.severity === 'error')
    .map((issue) => issue.message);
  return reasons.length > 0 ? reasons : ['文件未通过校验，解析器未给出具体原因'];
}

/**
 * Knowledge base endpoints for products, FAQs and shortcuts.
 *
 * A patch names the fields that change and leaves the rest alone, which is how
 * 停用 is expressed (`{"enabled": false}`) — the row stays, and can be put back
 * with `{"enabled": true}`. A field the request omits is absent from the patch
 * rather than present and `undefined`; `exactOptionalPropertyTypes` makes that
 * distinction the type system's, so "no value" cannot be read as "clear it".
 */
@Controller('knowledge')
export class KnowledgeController {
  constructor(
    private readonly access: AccessService,
    private readonly knowledge: KnowledgeService,
  ) {}

  /**
   * What this tenant's knowledge index is doing: per-state slice counts, how many
   * vectors are stored for the same slices, and the latest recorded failures.
   *
   * A read open to any member, like the product and FAQ lists: the tenant is the
   * caller's own, an agent is pinned to their store, and no other tenant is
   * reachable through any parameter. The filtering itself is
   * {@link parseIndexStatusFilter}'s, which is where a bad value becomes a 400
   * carrying the reason.
   */
  @Get('index-status')
  async indexStatus(
    @Req() req: Request,
    @Query('storeId') storeId?: string,
    @Query('sourceKind') sourceKind?: string,
    @Query('sourceId') sourceId?: string,
    @Query('indexStatus') indexStatus?: string,
  ): Promise<KnowledgeIndexStatusSummary> {
    const member = this.access.resolveMember(req);
    const tenantId = await this.access.resolveTenantScope(req, member);
    return this.knowledge.indexStatus(
      tenantId,
      member,
      parseIndexStatusFilter({ storeId, sourceKind, sourceId, indexStatus }),
    );
  }

  @Get('products')
  async products(
    @Req() req: Request,
    @Query('storeId') storeId?: string,
  ): Promise<ReadonlyArray<Product>> {
    const member = this.access.resolveMember(req);
    const tenantId = await this.access.resolveTenantScope(req, member);
    return this.knowledge.listProducts(tenantId, member, storeId);
  }

  @Get('products/:productId')
  async product(@Req() req: Request, @Param('productId') productId: string): Promise<Product> {
    const member = this.access.resolveMember(req);
    const tenantId = await this.access.resolveTenantScope(req, member);
    return this.knowledge.getProduct(tenantId, member, productId);
  }

  @Post('products')
  async createProduct(@Req() req: Request, @Body() body: unknown): Promise<Product> {
    const member = this.access.resolveMember(req);
    const tenantId = await this.access.resolveTenantScope(req, member);
    const record = bodyRecord(body);
    return this.knowledge.createProduct(tenantId, member, {
      storeId: bodyRequiredString(record, 'storeId'),
      sku: bodyRequiredString(record, 'sku'),
      title: bodyRequiredString(record, 'title'),
      description: bodyOptionalString(record, 'description') ?? '',
    });
  }

  /** Change a product; `{"enabled": false}` takes it out of service. */
  @Patch('products/:productId')
  async updateProduct(
    @Req() req: Request,
    @Param('productId') productId: string,
    @Body() body: unknown,
  ): Promise<Product> {
    const member = this.access.resolveMember(req);
    const tenantId = await this.access.resolveTenantScope(req, member);
    const record = bodyRecord(body);
    const sku = bodyOptionalString(record, 'sku');
    const title = bodyOptionalString(record, 'title');
    const description = bodyOptionalString(record, 'description');
    const enabled = bodyOptionalBoolean(record, 'enabled');
    return this.knowledge.updateProduct(tenantId, member, productId, {
      ...(sku === undefined ? {} : { sku }),
      ...(title === undefined ? {} : { title }),
      ...(description === undefined ? {} : { description }),
      ...(enabled === undefined ? {} : { enabled }),
    });
  }

  @Get('faqs')
  async faqs(
    @Req() req: Request,
    @Query('storeId') storeId?: string,
  ): Promise<ReadonlyArray<FaqItem>> {
    const member = this.access.resolveMember(req);
    const tenantId = await this.access.resolveTenantScope(req, member);
    return this.knowledge.listFaqs(tenantId, member, storeId);
  }

  @Get('faqs/:faqId')
  async faq(@Req() req: Request, @Param('faqId') faqId: string): Promise<FaqItem> {
    const member = this.access.resolveMember(req);
    const tenantId = await this.access.resolveTenantScope(req, member);
    return this.knowledge.getFaq(tenantId, member, faqId);
  }

  @Post('faqs')
  async createFaq(@Req() req: Request, @Body() body: unknown): Promise<FaqItem> {
    const member = this.access.resolveMember(req);
    const tenantId = await this.access.resolveTenantScope(req, member);
    const record = bodyRecord(body);
    return this.knowledge.createFaq(tenantId, member, {
      storeId: bodyRequiredString(record, 'storeId'),
      question: bodyRequiredString(record, 'question'),
      answer: bodyRequiredString(record, 'answer'),
      tags: bodyOptionalStringArray(record, 'tags') ?? [],
    });
  }

  /** Change an FAQ entry; `{"enabled": false}` takes it out of service. */
  @Patch('faqs/:faqId')
  async updateFaq(
    @Req() req: Request,
    @Param('faqId') faqId: string,
    @Body() body: unknown,
  ): Promise<FaqItem> {
    const member = this.access.resolveMember(req);
    const tenantId = await this.access.resolveTenantScope(req, member);
    const record = bodyRecord(body);
    const question = bodyOptionalString(record, 'question');
    const answer = bodyOptionalString(record, 'answer');
    const tags = bodyOptionalStringArray(record, 'tags');
    const enabled = bodyOptionalBoolean(record, 'enabled');
    return this.knowledge.updateFaq(tenantId, member, faqId, {
      ...(question === undefined ? {} : { question }),
      ...(answer === undefined ? {} : { answer }),
      ...(tags === undefined ? {} : { tags }),
      ...(enabled === undefined ? {} : { enabled }),
    });
  }

  // --------------------------------------------------------------------------
  // FAQ near-questions
  //
  // A variant belongs to exactly one FAQ and lives under it, so the faqId is part
  // of every path. The faqId is re-resolved on each call rather than trusted from
  // the path alone, which is what stops a variant id from one FAQ being edited
  // through another's URL.
  // --------------------------------------------------------------------------

  @Get('faqs/:faqId/variants')
  async faqVariants(
    @Req() req: Request,
    @Param('faqId') faqId: string,
  ): Promise<ReadonlyArray<FaqQuestionVariant>> {
    const member = this.access.resolveMember(req);
    const tenantId = await this.access.resolveTenantScope(req, member);
    return this.knowledge.listFaqVariants(tenantId, member, faqId);
  }

  @Post('faqs/:faqId/variants')
  async createFaqVariant(
    @Req() req: Request,
    @Param('faqId') faqId: string,
    @Body() body: unknown,
  ): Promise<FaqQuestionVariant> {
    const member = this.access.resolveMember(req);
    const tenantId = await this.access.resolveTenantScope(req, member);
    const record = bodyRecord(body);
    const source = bodyOptionalEnum(record, 'source', FAQ_VARIANT_SOURCES);
    return this.knowledge.createFaqVariant(tenantId, member, faqId, {
      questionText: bodyRequiredString(record, 'questionText'),
      ...(source === undefined ? {} : { source }),
    });
  }

  /** Change a near-question; `{"status": "disabled"}` stops it matching. */
  @Patch('faq-variants/:variantId')
  async updateFaqVariant(
    @Req() req: Request,
    @Param('variantId') variantId: string,
    @Body() body: unknown,
  ): Promise<FaqQuestionVariant> {
    const member = this.access.resolveMember(req);
    const tenantId = await this.access.resolveTenantScope(req, member);
    const record = bodyRecord(body);
    const questionText = bodyOptionalString(record, 'questionText');
    const status = bodyOptionalEnum(record, 'status', FAQ_VARIANT_STATUSES);
    return this.knowledge.updateFaqVariant(tenantId, member, variantId, {
      ...(questionText === undefined ? {} : { questionText }),
      ...(status === undefined ? {} : { status }),
    });
  }

  // --------------------------------------------------------------------------
  // Product import batches
  //
  // The bookkeeping half of an import; the file itself arrives in SDD-012. A
  // batch is opened, the reader reports progress as it goes, and the lines it
  // could not take are written against it.
  // --------------------------------------------------------------------------

  @Get('import-batches')
  async importBatches(
    @Req() req: Request,
    @Query('storeId') storeId?: string,
  ): Promise<ReadonlyArray<ProductImportBatch>> {
    const member = this.access.resolveMember(req);
    const tenantId = await this.access.resolveTenantScope(req, member);
    return this.knowledge.listImportBatches(tenantId, member, storeId);
  }

  @Get('import-batches/:batchId')
  async importBatch(
    @Req() req: Request,
    @Param('batchId') batchId: string,
  ): Promise<ImportBatchWithErrors> {
    const member = this.access.resolveMember(req);
    const tenantId = await this.access.resolveTenantScope(req, member);
    return this.knowledge.getImportBatchWithErrors(tenantId, member, batchId);
  }

  /**
   * 预览一次商品导入：收下文件，解析成 SPU/SKU 预览与问题清单。
   *
   * 这里是**纯预览** —— 不建批次、不落 SPU/SKU、不碰 MinIO、不发网络请求。
   * 文件走 multipart 本地上传；批次模型上的 `fileObjectKey` 字段保留给二期的对象
   * 存储路径，本端点不读也不写它。
   *
   * 文件大小有两道闸，两条线不重合（原因见 `IMPORT_UPLOAD_MEMORY_BACKSTOP_BYTES`）：
   * multer 的 `limits.fileSize` 是内存保护，先于本方法执行，越过时由
   * `ImportUploadTooLargeFilter` 收敛成 400；方法体里的 `file.size` 检查才是业务判据，
   * 用的比较符和 Parser 一致（`>`），所以「恰好 10 MiB」在两层都放行。
   *
   * **成功是 200，不是 201。** 这是纯预览：不建批次、不落 SPU/SKU、不碰对象存储，
   * 没有任何资源被创建，也没有 `Location` 头可指。Nest 对 POST 默认返回 201，
   * 那等于声称「上传一个只读预览」创建了什么 —— 签名定稿时写的也是 200。
   *
   * **整批拒绝是 400 `bad_request`，不是 422。** Parser 的 `fatal` 只有一种语义
   * （整批不可读），而 422 在本仓库现有语义里表示「格式合法但内容不合业务规则」。
   * 原因放在 `details`（数组形式，见 `importRejectionReasons`）。
   */
  @Post('import-batches/preview')
  @HttpCode(HttpStatus.OK)
  @UseFilters(ImportUploadTooLargeFilter)
  @UseInterceptors(IMPORT_UPLOAD_INTERCEPTOR)
  async previewImportBatch(
    @Req() req: Request,
    @UploadedFile() file: UploadedImportFile | undefined,
    @Body() body: unknown,
  ): Promise<ProductImportParseResult> {
    const member = this.access.resolveMember(req);
    const tenantId = await this.access.resolveTenantScope(req, member);

    const record = bodyRecord(body);
    // 门店是导入的归属，必填。
    //
    // 这两条刻意不用 `bodyRequiredString`：全局过滤器只把**数组**形式的 message
    // 收进 details（`all-exceptions.filter.ts:88`），字符串会被有意隐去，调用方
    // 于是只拿到一句 "Bad Request"、details 为空，无从判断是少了哪个字段。同一个
    // 方法调用的 `resolveImportFormat` 也是用数组抛的，这里跟它保持一致。
    const storeId = record['storeId'];
    if (typeof storeId !== 'string' || storeId.trim().length === 0) {
      throw new BadRequestException(['storeId 必填，且是非空字符串']);
    }
    // 门店必须属于本请求的租户范围。签名里写的「用于租户/门店范围校验」指的就是这一句 ——
    // 预览今天不落库、不读租户数据，所以越界的 storeId 目前没有可见后果，但它是导入的
    // 归属：二期把预览接成真导入时，缺了这一句就是跨租户写。`resolveTenantScope` 只认
    // `x-tenant-id` 与成员的租户是否一致，不校验门店存在性或归属，因此必须另调
    // `assertStoreInTenant`。
    await this.access.assertStoreInTenant(tenantId, storeId);
    if (file === undefined) {
      throw new BadRequestException(['file 必填，且必须是单个文件']);
    }

    const format = resolveImportFormat(file.originalname, bodyOptionalString(record, 'format'));
    if (file.size > MAX_PRODUCT_IMPORT_FILE_BYTES) {
      throw new BadRequestException([
        `文件 ${file.size} 字节，超过 ${MAX_PRODUCT_IMPORT_FILE_BYTES} 字节上限`,
      ]);
    }

    // 纯解析：不写库、不碰 MinIO、不发网络。XLSX 的解压炸弹防护在 Parser 内部
    // （`xlsx-inflate-budget.ts`，在 `exceljs` 拿到字节之前），所以把原始字节直接
    // 交出去是安全的 —— 超预算会以 `file_too_large` 的 issue 返回，而不是打死进程。
    const mapping = resolveImportMapping(record);
    const result = await parseProductImportFile({
      format,
      content: file.buffer,
      ...(mapping === undefined ? {} : { columnMapping: mapping }),
    });

    // 整批不可读 → 400。`fatal` 为真时 `previewRows` 必为空，没有任何可预览内容，
    // 回 200 会让调用方以为拿到了空结果（块 4 的中间态就是这么对外说话的：
    // 上传一个空文件得到 201 Created）。
    if (result.summary.fatal) {
      throw new BadRequestException(importRejectionReasons(result));
    }
    return result;
  }

  /**
   * 导入一份商品文件：收下文件、解析、然后**真的落库**。
   *
   * 闸门与 `previewImportBatch` 逐条相同（同一个拦截器实例、同一套 storeId 与
   * 门店归属校验、同一个字节上限、同一句 fatal 判据），只是这一次文件会被写进
   * 目录。预览与导入对「什么算合法上传」必须给同一个答案，否则会出现「预览说
   * 不行，导入却进去了」。
   *
   * **整批不可读是 400，不建批次。** 这与 `previewImportBatch` 一致，且不是省事：
   * 批次里的失败行按数据行号索引（`product_import_errors.row_number` 的 CHECK 是
   * `>= 1`），而整批不可读的原因全是文件级的、没有行号可挂。硬记一条没有任何行号
   * 的批次，等于给操作员一张写不出原因的收据 —— 不如把原因放在 `details` 里直接回。
   * 批次状态里的 `failed` 因此指的是另一种情形：文件读得懂，但没有一行落得进去。
   *
   * **成功是 201。** 与预览不同：这里确实创建了资源（一个批次与它带进来的商品），
   * 201 是 POST 的默认语义，也是有 `Location` 可指的那种创建。响应体不止批次本身，
   * 还带失败行与计数 —— 操作员要的就是这一份回执。
   */
  @Post('import-batches/apply')
  @UseFilters(ImportUploadTooLargeFilter)
  @UseInterceptors(IMPORT_UPLOAD_INTERCEPTOR)
  async applyImportBatch(
    @Req() req: Request,
    @UploadedFile() file: UploadedImportFile | undefined,
    @Body() body: unknown,
  ): Promise<ProductImportApplyResult> {
    const member = this.access.resolveMember(req);
    const tenantId = await this.access.resolveTenantScope(req, member);

    const record = bodyRecord(body);
    const storeId = record['storeId'];
    if (typeof storeId !== 'string' || storeId.trim().length === 0) {
      throw new BadRequestException(['storeId 必填，且是非空字符串']);
    }
    // 写权限先于读文件：一个只读成员不该让服务端先把 10 MiB 解析一遍再告诉他
    // 没有权限。服务层会再判一次 —— 导入是写路径，判据不能只挂在入口上。
    this.access.requireConfigurator(member);
    await this.access.assertStoreInTenant(tenantId, storeId);
    if (file === undefined) {
      throw new BadRequestException(['file 必填，且必须是单个文件']);
    }

    const format = resolveImportFormat(file.originalname, bodyOptionalString(record, 'format'));
    if (file.size > MAX_PRODUCT_IMPORT_FILE_BYTES) {
      throw new BadRequestException([
        `文件 ${file.size} 字节，超过 ${MAX_PRODUCT_IMPORT_FILE_BYTES} 字节上限`,
      ]);
    }

    const mapping = resolveImportMapping(record);
    const parsed = await parseProductImportFile({
      format,
      content: file.buffer,
      ...(mapping === undefined ? {} : { columnMapping: mapping }),
    });
    if (parsed.summary.fatal) {
      throw new BadRequestException(importRejectionReasons(parsed));
    }
    return this.knowledge.applyImportBatch(tenantId, member, { storeId, parsed });
  }

  @Post('import-batches')
  async createImportBatch(@Req() req: Request, @Body() body: unknown): Promise<ProductImportBatch> {
    const member = this.access.resolveMember(req);
    const tenantId = await this.access.resolveTenantScope(req, member);
    const record = bodyRecord(body);
    const fileObjectKey = bodyNullableString(record, 'fileObjectKey');
    const fileSha256 = bodyNullableString(record, 'fileSha256');
    return this.knowledge.createImportBatch(tenantId, member, {
      storeId: bodyRequiredString(record, 'storeId'),
      sourceType: bodyRequiredEnum(record, 'sourceType', IMPORT_SOURCE_TYPES),
      ...(fileObjectKey === undefined ? {} : { fileObjectKey }),
      ...(fileSha256 === undefined ? {} : { fileSha256 }),
    });
  }

  /** Move an attempt's status and counts as the reader works through it. */
  @Patch('import-batches/:batchId')
  async updateImportBatch(
    @Req() req: Request,
    @Param('batchId') batchId: string,
    @Body() body: unknown,
  ): Promise<ProductImportBatch> {
    const member = this.access.resolveMember(req);
    const tenantId = await this.access.resolveTenantScope(req, member);
    const record = bodyRecord(body);
    const status = bodyOptionalEnum(record, 'status', IMPORT_BATCH_STATUSES);
    const totalRows = bodyOptionalCount(record, 'totalRows');
    const successRows = bodyOptionalCount(record, 'successRows');
    const failedRows = bodyOptionalCount(record, 'failedRows');
    const startedAt = bodyNullableString(record, 'startedAt');
    const finishedAt = bodyNullableString(record, 'finishedAt');
    return this.knowledge.updateImportBatch(tenantId, member, batchId, {
      ...(status === undefined ? {} : { status }),
      ...(totalRows === undefined ? {} : { totalRows }),
      ...(successRows === undefined ? {} : { successRows }),
      ...(failedRows === undefined ? {} : { failedRows }),
      ...(startedAt === undefined ? {} : { startedAt }),
      ...(finishedAt === undefined ? {} : { finishedAt }),
    });
  }

  /**
   * Record the lines an import could not take.
   *
   * The body is a list of rows in the order they were read. `rowNumber` is
   * required and counts from 1, because the point of the record is that an
   * operator can open the sheet and go to that line.
   */
  @Post('import-batches/:batchId/errors')
  async appendImportErrors(
    @Req() req: Request,
    @Param('batchId') batchId: string,
    @Body() body: unknown,
  ): Promise<ReadonlyArray<ProductImportError>> {
    const member = this.access.resolveMember(req);
    const tenantId = await this.access.resolveTenantScope(req, member);
    const record = bodyRecord(body);
    return this.knowledge.appendImportErrors(
      tenantId,
      member,
      batchId,
      importErrorRows(record['errors']),
    );
  }

  @Get('shortcuts')
  async shortcuts(
    @Req() req: Request,
    @Query('storeId') storeId?: string,
  ): Promise<ReadonlyArray<Shortcut>> {
    const member = this.access.resolveMember(req);
    const tenantId = await this.access.resolveTenantScope(req, member);
    return this.knowledge.listShortcuts(tenantId, member, storeId);
  }

  @Get('shortcuts/:shortcutId')
  async shortcut(@Req() req: Request, @Param('shortcutId') shortcutId: string): Promise<Shortcut> {
    const member = this.access.resolveMember(req);
    const tenantId = await this.access.resolveTenantScope(req, member);
    return this.knowledge.getShortcut(tenantId, member, shortcutId);
  }

  /**
   * Create a shortcut.
   *
   * `storeId` is required but may be `null`: naming a store makes a store-level
   * phrase, and `null` makes a merchant-level one every store sees. The field
   * cannot be omitted, because a caller who forgot it would otherwise silently
   * create the broader of the two.
   */
  @Post('shortcuts')
  async createShortcut(@Req() req: Request, @Body() body: unknown): Promise<Shortcut> {
    const member = this.access.resolveMember(req);
    const tenantId = await this.access.resolveTenantScope(req, member);
    const record = bodyRecord(body);
    const storeId = bodyNullableString(record, 'storeId');
    if (storeId === undefined) {
      throw new BadRequestException('storeId is required and may be null');
    }
    const intentCode = bodyOptionalString(record, 'intentCode');
    const sortOrder = bodyOptionalCount(record, 'sortOrder');
    return this.knowledge.createShortcut(tenantId, member, {
      storeId,
      code: bodyRequiredString(record, 'code'),
      title: bodyRequiredString(record, 'title'),
      content: bodyRequiredString(record, 'content'),
      ...(intentCode === undefined ? {} : { intentCode }),
      ...(sortOrder === undefined ? {} : { sortOrder }),
    });
  }

  /** Change a shortcut; `{"enabled": false}` takes it out of service. */
  @Patch('shortcuts/:shortcutId')
  async updateShortcut(
    @Req() req: Request,
    @Param('shortcutId') shortcutId: string,
    @Body() body: unknown,
  ): Promise<Shortcut> {
    const member = this.access.resolveMember(req);
    const tenantId = await this.access.resolveTenantScope(req, member);
    const record = bodyRecord(body);
    const code = bodyOptionalString(record, 'code');
    const title = bodyOptionalString(record, 'title');
    const content = bodyOptionalString(record, 'content');
    const intentCode = bodyNullableString(record, 'intentCode');
    const sortOrder = bodyOptionalCount(record, 'sortOrder');
    const enabled = bodyOptionalBoolean(record, 'enabled');
    return this.knowledge.updateShortcut(tenantId, member, shortcutId, {
      ...(code === undefined ? {} : { code }),
      ...(title === undefined ? {} : { title }),
      ...(content === undefined ? {} : { content }),
      ...(intentCode === undefined ? {} : { intentCode }),
      ...(sortOrder === undefined ? {} : { sortOrder }),
      ...(enabled === undefined ? {} : { enabled }),
    });
  }

  // --------------------------------------------------------------------------
  // Catalogue
  // --------------------------------------------------------------------------

  @Get('categories')
  async categories(
    @Req() req: Request,
    @Query('storeId') storeId?: string,
  ): Promise<ReadonlyArray<ProductCategory>> {
    const member = this.access.resolveMember(req);
    const tenantId = await this.access.resolveTenantScope(req, member);
    return this.knowledge.listCategories(tenantId, member, storeId);
  }

  @Get('categories/:categoryId')
  async category(
    @Req() req: Request,
    @Param('categoryId') categoryId: string,
  ): Promise<ProductCategory> {
    const member = this.access.resolveMember(req);
    const tenantId = await this.access.resolveTenantScope(req, member);
    return this.knowledge.getCategory(tenantId, member, categoryId);
  }

  @Post('categories')
  async createCategory(@Req() req: Request, @Body() body: unknown): Promise<ProductCategory> {
    const member = this.access.resolveMember(req);
    const tenantId = await this.access.resolveTenantScope(req, member);
    const record = bodyRecord(body);
    return this.knowledge.createCategory(tenantId, member, {
      storeId: bodyRequiredString(record, 'storeId'),
      code: bodyRequiredString(record, 'code'),
      name: bodyRequiredString(record, 'name'),
      parentId: bodyNullableString(record, 'parentId'),
    });
  }

  @Get('categories/:categoryId/attributes')
  async categoryAttributes(
    @Req() req: Request,
    @Param('categoryId') categoryId: string,
  ): Promise<ReadonlyArray<CategoryAttribute>> {
    const member = this.access.resolveMember(req);
    const tenantId = await this.access.resolveTenantScope(req, member);
    return this.knowledge.listCategoryAttributes(tenantId, member, categoryId);
  }

  /**
   * Declare an attribute of a category.
   *
   * `allowedValues` is only meaningful for `enum`/`multi_enum`: a free-text
   * attribute that carried a closed value list would silently narrow input the
   * merchant meant to stay open, so the list is dropped for the other kinds.
   */
  @Post('categories/:categoryId/attributes')
  async createCategoryAttribute(
    @Req() req: Request,
    @Param('categoryId') categoryId: string,
    @Body() body: unknown,
  ): Promise<CategoryAttribute> {
    const member = this.access.resolveMember(req);
    const tenantId = await this.access.resolveTenantScope(req, member);
    const record = bodyRecord(body);
    const valueType = bodyRequiredEnum(record, 'valueType', CATALOG_ATTRIBUTE_VALUE_TYPES);
    const allowedValues = bodyOptionalStringArray(record, 'allowedValues');
    const enumerable = valueType === 'enum' || valueType === 'multi_enum';
    return this.knowledge.createCategoryAttribute(tenantId, member, categoryId, {
      attributeCode: bodyRequiredString(record, 'attributeCode'),
      attributeName: bodyRequiredString(record, 'attributeName'),
      valueType,
      isRequired: bodyOptionalBoolean(record, 'isRequired'),
      isSearchable: bodyOptionalBoolean(record, 'isSearchable'),
      allowedValues: enumerable ? allowedValues : undefined,
    });
  }

  @Get('spus')
  async spus(
    @Req() req: Request,
    @Query('storeId') storeId?: string,
    @Query('categoryId') categoryId?: string,
  ): Promise<ReadonlyArray<ProductSpu>> {
    const member = this.access.resolveMember(req);
    const tenantId = await this.access.resolveTenantScope(req, member);
    return this.knowledge.listSpus(tenantId, member, { storeId, categoryId });
  }

  /** One product and the variants it is sold in. */
  @Get('spus/:spuId')
  async spu(@Req() req: Request, @Param('spuId') spuId: string): Promise<SpuWithSkus> {
    const member = this.access.resolveMember(req);
    const tenantId = await this.access.resolveTenantScope(req, member);
    return this.knowledge.getSpuWithSkus(tenantId, member, spuId);
  }

  @Post('spus')
  async createSpu(@Req() req: Request, @Body() body: unknown): Promise<ProductSpu> {
    const member = this.access.resolveMember(req);
    const tenantId = await this.access.resolveTenantScope(req, member);
    const record = bodyRecord(body);
    return this.knowledge.createSpu(tenantId, member, {
      storeId: bodyRequiredString(record, 'storeId'),
      productCode: bodyRequiredString(record, 'productCode'),
      title: bodyRequiredString(record, 'title'),
      categoryId: bodyNullableString(record, 'categoryId'),
      externalProductId: bodyNullableString(record, 'externalProductId'),
      subtitle: bodyNullableString(record, 'subtitle'),
      mainImageUrl: bodyNullableString(record, 'mainImageUrl'),
      productUrl: bodyNullableString(record, 'productUrl'),
      sellingPoints: bodyOptionalStringArray(record, 'sellingPoints'),
      commonAttributes: bodyOptionalScalarRecord(record, 'commonAttributes'),
      shelfStatus: bodyOptionalEnum(record, 'shelfStatus', SPU_SHELF_STATUSES),
      sourceType: bodyOptionalEnum(record, 'sourceType', SPU_SOURCE_TYPES),
    });
  }

  /**
   * Change a product; `{"shelfStatus": "off_shelf"}` takes it off the shelf and
   * `{"categoryId": null}` files it under no category.
   */
  @Patch('spus/:spuId')
  async updateSpu(
    @Req() req: Request,
    @Param('spuId') spuId: string,
    @Body() body: unknown,
  ): Promise<ProductSpu> {
    const member = this.access.resolveMember(req);
    const tenantId = await this.access.resolveTenantScope(req, member);
    const record = bodyRecord(body);
    return this.knowledge.updateSpu(tenantId, member, spuId, {
      categoryId: bodyNullableString(record, 'categoryId'),
      title: bodyOptionalString(record, 'title'),
      subtitle: bodyNullableString(record, 'subtitle'),
      mainImageUrl: bodyNullableString(record, 'mainImageUrl'),
      productUrl: bodyNullableString(record, 'productUrl'),
      sellingPoints: bodyOptionalStringArray(record, 'sellingPoints'),
      commonAttributes: bodyOptionalScalarRecord(record, 'commonAttributes'),
      shelfStatus: bodyOptionalEnum(record, 'shelfStatus', SPU_SHELF_STATUSES),
    });
  }

  /** Add a variant to a product; the store is the product's, not the body's. */
  @Post('spus/:spuId/skus')
  async createSku(
    @Req() req: Request,
    @Param('spuId') spuId: string,
    @Body() body: unknown,
  ): Promise<ProductSku> {
    const member = this.access.resolveMember(req);
    const tenantId = await this.access.resolveTenantScope(req, member);
    const record = bodyRecord(body);
    return this.knowledge.createSku(tenantId, member, spuId, {
      skuCode: bodyRequiredString(record, 'skuCode'),
      externalSkuId: bodyNullableString(record, 'externalSkuId'),
      variant: bodyOptionalStringRecord(record, 'variant'),
      searchAttributes: bodyOptionalStringRecord(record, 'searchAttributes'),
      status: bodyOptionalEnum(record, 'status', SKU_STATUSES),
    });
  }

  /** Change a variant; `{"status": "inactive"}` withdraws it without deleting it. */
  @Patch('skus/:skuId')
  async updateSku(
    @Req() req: Request,
    @Param('skuId') skuId: string,
    @Body() body: unknown,
  ): Promise<ProductSku> {
    const member = this.access.resolveMember(req);
    const tenantId = await this.access.resolveTenantScope(req, member);
    const record = bodyRecord(body);
    return this.knowledge.updateSku(tenantId, member, skuId, {
      skuCode: bodyOptionalString(record, 'skuCode'),
      variant: bodyOptionalStringRecord(record, 'variant'),
      searchAttributes: bodyOptionalStringRecord(record, 'searchAttributes'),
      status: bodyOptionalEnum(record, 'status', SKU_STATUSES),
    });
  }
}

/**
 * Read the `errors` array of an import report.
 *
 * Each entry is a row of the sheet, so `rowNumber` and `errorCode` are required
 * and the rest is optional detail. A body that is not an array, or an entry that
 * is not an object, is a 400 rather than a silently empty report: an import that
 * says it failed on forty rows must not record none of them.
 *
 * @param value - The raw `errors` field of the request body.
 * @returns One record per failed row.
 */
function importErrorRows(
  value: unknown,
): ReadonlyArray<Omit<NewProductImportError, 'tenantId' | 'batchId' | 'now'>> {
  if (value === undefined) {
    throw new BadRequestException('errors is required');
  }
  if (!Array.isArray(value)) {
    throw new BadRequestException('errors must be an array');
  }
  return value.map((entry) => {
    const record = bodyRecord(entry);
    const fieldName = bodyNullableString(record, 'fieldName');
    const errorMessage = bodyNullableString(record, 'errorMessage');
    const rawValueMasked = bodyNullableString(record, 'rawValueMasked');
    return {
      rowNumber: bodyRequiredPositiveInt(record, 'rowNumber'),
      errorCode: bodyRequiredString(record, 'errorCode'),
      ...(fieldName === undefined ? {} : { fieldName }),
      ...(errorMessage === undefined ? {} : { errorMessage }),
      ...(rawValueMasked === undefined ? {} : { rawValueMasked }),
    };
  });
}
