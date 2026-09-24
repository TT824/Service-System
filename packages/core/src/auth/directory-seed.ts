/**
 * Deterministic directory seed for the in-memory authentication adapter.
 *
 * The in-memory adapter stands in for the durable directory in `test`, so it
 * must describe exactly the same tenants, stores and members the deterministic
 * platform store seeds. Duplicating the facts here (rather than importing the
 * store's private constants) keeps the adapter independent; a unit test asserts
 * the two agree, so drift fails the build instead of silently splitting the
 * identity space.
 */

import type { Member, Store, Tenant } from '../platform/types';

/** The seeded platform super administrator member id. */
export const SEEDED_PLATFORM_ADMIN_MEMBER_ID = 'u-platform-admin';

/** Instant every seeded directory row was created at. */
export const SEEDED_DIRECTORY_CREATED_AT = '2026-08-01T00:00:00.000Z';

/** Tenants the in-memory adapter starts with. */
export const SEEDED_TENANTS: ReadonlyArray<Tenant> = Object.freeze([
  Object.freeze({
    id: 'tenant-acme',
    code: 'acme',
    name: '云集服饰',
    enabled: true,
    createdAt: SEEDED_DIRECTORY_CREATED_AT,
  }),
  Object.freeze({
    id: 'tenant-beta',
    code: 'beta',
    name: '蓝图数码',
    enabled: true,
    createdAt: SEEDED_DIRECTORY_CREATED_AT,
  }),
]);

/** Stores the in-memory adapter starts with. */
export const SEEDED_STORES: ReadonlyArray<Store> = Object.freeze([
  Object.freeze({
    id: 'store-acme-flagship',
    tenantId: 'tenant-acme',
    code: 'flagship',
    name: '云集服饰旗舰店',
    enabled: true,
    createdAt: SEEDED_DIRECTORY_CREATED_AT,
  }),
  Object.freeze({
    id: 'store-acme-distribution',
    tenantId: 'tenant-acme',
    code: 'distribution',
    name: '云集服饰分销店',
    enabled: true,
    createdAt: SEEDED_DIRECTORY_CREATED_AT,
  }),
  Object.freeze({
    id: 'store-beta-official',
    tenantId: 'tenant-beta',
    code: 'official',
    name: '蓝图数码官方店',
    enabled: true,
    createdAt: SEEDED_DIRECTORY_CREATED_AT,
  }),
]);

/** Members the in-memory adapter starts with. */
export const SEEDED_MEMBERS: ReadonlyArray<Member> = Object.freeze([
  Object.freeze({
    id: SEEDED_PLATFORM_ADMIN_MEMBER_ID,
    tenantId: null,
    storeId: null,
    role: 'platform_admin',
    username: 'root',
    displayName: '平台超级管理员',
    enabled: true,
    createdAt: SEEDED_DIRECTORY_CREATED_AT,
  }),
  Object.freeze({
    id: 'u-t1-admin',
    tenantId: 'tenant-acme',
    storeId: null,
    role: 'merchant_admin',
    username: 'acme-owner',
    displayName: '云集管理员',
    enabled: true,
    createdAt: SEEDED_DIRECTORY_CREATED_AT,
  }),
  Object.freeze({
    id: 'u-t1-agent-1',
    tenantId: 'tenant-acme',
    storeId: 'store-acme-flagship',
    role: 'agent',
    username: 'agent-01',
    displayName: '客服小云',
    enabled: true,
    createdAt: SEEDED_DIRECTORY_CREATED_AT,
  }),
  Object.freeze({
    id: 'u-t1-agent-2',
    tenantId: 'tenant-acme',
    storeId: 'store-acme-flagship',
    role: 'agent',
    username: 'agent-02',
    displayName: '客服小蓝',
    enabled: true,
    createdAt: SEEDED_DIRECTORY_CREATED_AT,
  }),
  Object.freeze({
    id: 'u-t2-admin',
    tenantId: 'tenant-beta',
    storeId: null,
    role: 'merchant_admin',
    username: 'beta-owner',
    displayName: '蓝图管理员',
    enabled: true,
    createdAt: SEEDED_DIRECTORY_CREATED_AT,
  }),
  Object.freeze({
    id: 'u-t2-agent-1',
    tenantId: 'tenant-beta',
    storeId: 'store-beta-official',
    role: 'agent',
    username: 'beta-agent',
    displayName: '数码顾问',
    enabled: true,
    createdAt: SEEDED_DIRECTORY_CREATED_AT,
  }),
]);
