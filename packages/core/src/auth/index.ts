/**
 * Authentication and access-control primitives.
 *
 * This barrel is the package boundary for everything the API authentication
 * module consumes: domain types, credential/token/code primitives, provider
 * interfaces with their deterministic local adapters, the storage port with
 * its in-memory implementation, and the domain service that orchestrates the
 * sign-in, account and session workflows.
 *
 * `serving-store` is here for a second caller: connecting a WeCom account has
 * to name the store the connection writes into, and it has to name the *same*
 * one a newly approved seat serves in — otherwise an account bound to a store
 * nobody reads and a seat placed where the work is would be two answers to one
 * question. The rule is exported rather than re-implemented so the two cannot
 * drift.
 */

export * from './types';
export * from './errors';
export * from './clock';
export * from './password';
export * from './avatar';
export * from './token';
export * from './otp';
export * from './policy';
export * from './providers';
export * from './directory-seed';
export * from './ports';
export * from './memory-repository';
export * from './access-context';
export * from './serving-store';
export * from './trial-workspace';
export * from './onboarding.service';
export * from './auth.service';
export * from './admin.service';
