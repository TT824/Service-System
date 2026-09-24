/**
 * The product catalogue: categories, their attribute declarations, and the
 * SPU/SKU split that expresses colour, size and model variants.
 *
 * The three vocabulary tuples below are the single source of the values the SQL
 * `CHECK` constraints accept. A widened union fails to compile against the label
 * maps that use it, so the database and the domain cannot drift apart silently —
 * the same arrangement `MESSAGE_SOURCES` has.
 *
 * `products` (migration `0002`) is a different, older model: a flat row the reply
 * pipeline reads today. It is untouched here. This module is the structure
 * SDD-012 imports into and SDD-014 indexes.
 *
 * Every optional field below also accepts an explicit `undefined`. A caller that
 * reads a request body field by field gets `undefined` back for a field the
 * request did not name, and should be able to pass that value straight through
 * rather than re-deriving the distinction with a conditional spread. `undefined`
 * means "not named" — the same thing an omitted property means.
 */

/** Lifecycle of a category. Reversible: a category is disabled, never deleted. */
export const CATEGORY_STATUSES = ['enabled', 'disabled'] as const;
/** One category state. */
export type CategoryStatus = (typeof CATEGORY_STATUSES)[number];

/** The value kinds a category attribute may declare. */
export const CATALOG_ATTRIBUTE_VALUE_TYPES = [
  'text',
  'number',
  'boolean',
  'enum',
  'multi_enum',
] as const;
/** One declared value kind. */
export type CatalogAttributeValueType = (typeof CATALOG_ATTRIBUTE_VALUE_TYPES)[number];

/** Whether a channel says the product is for sale. `unknown` is an answer. */
export const SPU_SHELF_STATUSES = ['on_shelf', 'off_shelf', 'unknown'] as const;
/** One shelf state. */
export type SpuShelfStatus = (typeof SPU_SHELF_STATUSES)[number];

/** Where a product row came from. */
export const SPU_SOURCE_TYPES = ['manual', 'csv', 'internal_api', 'channel_api'] as const;
/** One source kind. */
export type SpuSourceType = (typeof SPU_SOURCE_TYPES)[number];

/** Whether a variant can still be sold. */
export const SKU_STATUSES = ['active', 'inactive'] as const;
/** One variant state. */
export type SkuStatus = (typeof SKU_STATUSES)[number];

/** An attribute value: the scalars the declared value types can carry. */
export type CatalogAttributeValue = string | number | boolean;

/** Attribute code → value, as `common_attributes_json` stores it. */
export type CatalogAttributes = Readonly<Record<string, CatalogAttributeValue>>;

/** Variant dimension → value (`颜色=黑`), as `variant_json` stores it. */
export type VariantAttributes = Readonly<Record<string, string>>;

/** A category a merchant files products under. */
export type ProductCategory = {
  readonly id: string;
  readonly tenantId: string;
  readonly storeId: string;
  readonly parentId: string | null;
  readonly code: string;
  readonly name: string;
  readonly status: CategoryStatus;
  readonly updatedAt: string;
  readonly createdAt: string;
};

/** Data used to create a category. */
export type NewProductCategory = {
  readonly tenantId: string;
  readonly storeId: string;
  readonly parentId?: string | null | undefined;
  readonly code: string;
  readonly name: string;
  readonly now?: string;
};

/** A declared extension attribute of one category. */
export type CategoryAttribute = {
  readonly id: string;
  readonly tenantId: string;
  readonly categoryId: string;
  readonly attributeCode: string;
  readonly attributeName: string;
  readonly valueType: CatalogAttributeValueType;
  readonly isRequired: boolean;
  readonly isSearchable: boolean;
  readonly allowedValues: ReadonlyArray<string>;
  readonly updatedAt: string;
  readonly createdAt: string;
};

/** Data used to declare a category attribute. */
export type NewCategoryAttribute = {
  readonly tenantId: string;
  readonly categoryId: string;
  readonly attributeCode: string;
  readonly attributeName: string;
  readonly valueType: CatalogAttributeValueType;
  readonly isRequired?: boolean | undefined;
  readonly isSearchable?: boolean | undefined;
  readonly allowedValues?: ReadonlyArray<string> | undefined;
  readonly now?: string;
};

/** A product: the thing a buyer talks about, independent of which variant. */
export type ProductSpu = {
  readonly id: string;
  readonly tenantId: string;
  readonly storeId: string;
  readonly categoryId: string | null;
  readonly externalProductId: string | null;
  readonly productCode: string;
  readonly title: string;
  readonly subtitle: string | null;
  readonly mainImageUrl: string | null;
  readonly productUrl: string | null;
  readonly sellingPoints: ReadonlyArray<string>;
  readonly commonAttributes: CatalogAttributes;
  readonly shelfStatus: SpuShelfStatus;
  readonly sourceType: SpuSourceType;
  readonly sourceUpdatedAt: string | null;
  readonly updatedAt: string;
  readonly createdAt: string;
};

/** Data used to create a product. */
export type NewProductSpu = {
  readonly tenantId: string;
  readonly storeId: string;
  readonly categoryId?: string | null | undefined;
  readonly externalProductId?: string | null | undefined;
  readonly productCode: string;
  readonly title: string;
  readonly subtitle?: string | null | undefined;
  readonly mainImageUrl?: string | null | undefined;
  readonly productUrl?: string | null | undefined;
  readonly sellingPoints?: ReadonlyArray<string> | undefined;
  readonly commonAttributes?: CatalogAttributes | undefined;
  readonly shelfStatus?: SpuShelfStatus | undefined;
  readonly sourceType?: SpuSourceType | undefined;
  readonly sourceUpdatedAt?: string | null | undefined;
  readonly now?: string;
};

/**
 * The mutable fields of a product; omitted fields keep their value.
 *
 * `categoryId` is `string | null` rather than optional-and-absent, because
 * "file it under no category" is a change a merchant has to be able to make.
 */
export type ProductSpuPatch = {
  readonly categoryId?: string | null | undefined;
  readonly title?: string | undefined;
  readonly subtitle?: string | null | undefined;
  readonly mainImageUrl?: string | null | undefined;
  readonly productUrl?: string | null | undefined;
  readonly sellingPoints?: ReadonlyArray<string> | undefined;
  readonly commonAttributes?: CatalogAttributes | undefined;
  readonly shelfStatus?: SpuShelfStatus | undefined;
};

/** A variant: one sellable combination of the product's dimensions. */
export type ProductSku = {
  readonly id: string;
  readonly tenantId: string;
  readonly storeId: string;
  readonly spuId: string;
  readonly externalSkuId: string | null;
  readonly skuCode: string;
  readonly variant: VariantAttributes;
  readonly searchAttributes: VariantAttributes;
  readonly status: SkuStatus;
  readonly updatedAt: string;
  readonly createdAt: string;
};

/** Data used to create a variant. */
export type NewProductSku = {
  readonly tenantId: string;
  readonly storeId: string;
  readonly spuId: string;
  readonly externalSkuId?: string | null | undefined;
  readonly skuCode: string;
  readonly variant?: VariantAttributes | undefined;
  readonly searchAttributes?: VariantAttributes | undefined;
  readonly status?: SkuStatus | undefined;
  readonly now?: string;
};

/** The mutable fields of a variant; omitted fields keep their value. */
export type ProductSkuPatch = {
  readonly skuCode?: string | undefined;
  readonly variant?: VariantAttributes | undefined;
  readonly searchAttributes?: VariantAttributes | undefined;
  readonly status?: SkuStatus | undefined;
};
