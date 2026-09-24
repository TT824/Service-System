import { HttpException, HttpStatus } from '@nestjs/common';
import { CHANNEL_DISABLED, type ChannelProviderId } from '@kefu/core';

/**
 * Raised when a caller invokes a real-channel operation on a channel that is not
 * connected. The MVP keeps the enterprise WeCom channel interface-only, so every
 * channel transport call resolves to this stable `channel_disabled` error.
 */
export class ChannelDisabledException extends HttpException {
  constructor(provider: ChannelProviderId, operation: string) {
    super(
      {
        code: CHANNEL_DISABLED,
        provider,
        operation,
      },
      HttpStatus.SERVICE_UNAVAILABLE,
    );
  }
}
