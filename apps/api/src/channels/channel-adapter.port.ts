/**
 * The channel transport injection port.
 *
 * Application services depend on the provider-neutral `ChannelAdapter` contract
 * from `@kefu/core` and receive whichever transport the environment binds under
 * {@link CHANNEL_ADAPTER}. Replacing the Mock WeCom transport with a real WeCom
 * client is therefore a module-level binding change, with no service edit.
 */

/** Injection token carrying the channel transport adapter the environment binds. */
export const CHANNEL_ADAPTER = Symbol('CHANNEL_ADAPTER');
