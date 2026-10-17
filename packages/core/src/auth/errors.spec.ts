import { describe, expect, it } from 'vitest';
import { AuthError } from './errors';

/**
 * 域失败投影到平台错误码。
 *
 * 投影按 HTTP 状态归纳是刻意的——客户端能做的动作通常只由状态决定，细分的域码
 * 泄露得越少越好。锁定是唯一的例外：它的状态是 401，但客户端该做的事（等一会儿
 * 再试）与「凭据不对」（换密码）相反，压成 `unauthorized` 就把「等」说成了「错」。
 */
describe('AuthError 的平台错误码', () => {
  it('锁定时保留自己的码，即使 HTTP 状态是 401', () => {
    const locked = new AuthError('account_locked', 'the account is temporarily locked');
    expect(locked.status).toBe(401);
    expect(locked.apiCode).toBe('account_locked');
  });

  it('其余 401 仍归纳为 unauthorized', () => {
    expect(new AuthError('invalid_credentials', 'x').apiCode).toBe('unauthorized');
    expect(new AuthError('session_expired', 'x').apiCode).toBe('unauthorized');
    expect(new AuthError('session_revoked', 'x').apiCode).toBe('unauthorized');
  });

  it('改密码相关失败按状态归纳：当前密码不对是 400，不是 401', () => {
    // 400 而不是 401：调用者已经登录，错的只是「当前密码」这个字符串，把它当成
    // 会话失效会让人当场被踢出正在填的表单。
    expect(new AuthError('password_mismatch', 'x').status).toBe(400);
    expect(new AuthError('password_mismatch', 'x').apiCode).toBe('bad_request');
    expect(new AuthError('password_too_weak', 'x').apiCode).toBe('bad_request');
    expect(new AuthError('password_reuse', 'x').apiCode).toBe('bad_request');
  });
});
