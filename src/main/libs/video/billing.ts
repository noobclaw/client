/**
 * billing — 视频成片计费(模式一:AI 分镜 + 在线素材)。
 *
 * pipeline 在【成片成功后】调 chargeMode1Video(),向 NoobClaw 服务端
 * POST /api/video/charge 扣"平台基础费"(每条随机 $0.09~$0.18 → 积分)。
 *
 * 说明:
 *   · DeepSeek 写稿/搜索词的 token 消耗已在 scriptWriter 调 /api/ai 时实时
 *     扣过了(含 Pro reasoner ×3),这里【不重复扣】,只扣平台基础费。
 *   · 生成前客户端已做 pre-flight 余额校验(> 200000 积分才放行),所以这里
 *     正常都能扣成功;服务端原子 UPDATE 兜底,余额不足返回 402(绝不透支)。
 *   · 失败【不抛】:成片已经做出来了,扣费失败只记日志(pre-flight 已极大
 *     降低这种概率),不回滚用户的视频。
 */

import { getNoobClawAuthToken } from '../claudeSettings';

function apiBase(): string {
  return process.env.NOOBCLAW_API_BASE_URL || 'https://api.noobclaw.com';
}

export interface VideoChargeResult {
  ok: boolean;
  /** 实际扣的积分(成功时)。 */
  chargedTokens?: number;
  /** 本条随机基础费(USD)。 */
  feeUsd?: number;
  /** 扣费后余额。 */
  balanceAfter?: number;
  /** 失败原因(余额不足 = 'insufficient',其它 = 'error' / 'no_auth')。 */
  reason?: 'insufficient' | 'error' | 'no_auth';
}

/**
 * 扣模式一平台基础费。绝不抛错 —— 返回 { ok:false, reason } 让 pipeline 记日志。
 */
export async function chargeMode1Video(durationSec: number): Promise<VideoChargeResult> {
  const token = getNoobClawAuthToken();
  if (!token) return { ok: false, reason: 'no_auth' };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15_000);
  try {
    const resp = await fetch(`${apiBase()}/api/video/charge`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ mode: 'stock', durationSec: Math.max(0, Number(durationSec) || 0) }),
      signal: ctrl.signal,
    });
    if (resp.status === 402) return { ok: false, reason: 'insufficient' };
    if (!resp.ok) return { ok: false, reason: 'error' };
    const json: any = await resp.json().catch((): null => null);
    return {
      ok: true,
      chargedTokens: Number(json?.chargedTokens) || 0,
      feeUsd: Number(json?.feeUsd) || 0,
      balanceAfter: Number(json?.balanceAfter) || 0,
    };
  } catch {
    return { ok: false, reason: 'error' };
  } finally {
    clearTimeout(timer);
  }
}
