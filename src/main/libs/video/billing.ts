/**
 * billing — 视频成片计费(模式一:AI 分镜 + 在线素材)。
 *
 * pipeline 在【开跑前(生成视频之前)】调 chargeMode1Video(),向 NoobClaw 服务端
 * POST /api/video/charge 预扣"平台基础费"(每条随机 $0.09~$0.18 → 积分);成片
 * 失败再调 refundMode1Video() 按 chargeId 幂等退回。
 *
 * 为什么开跑前预扣(而不是成片后扣):并发任务可能在本任务跑的过程里把余额扣光,
 * 等成片做完再扣就成了「视频做出来了、钱却扣不到」= 我们亏。预扣 = 原子锁住这笔费用。
 *
 * 说明:
 *   · DeepSeek 写稿/搜索词的 token 消耗已在 scriptWriter 调 /api/ai 时实时
 *     扣过了(含 Pro reasoner ×3),这里【不重复扣】,只扣平台基础费。
 *   · 生成前客户端还做了 pre-flight 余额校验(> 200000 积分才放行);服务端
 *     原子 UPDATE 兜底,余额不足返回 402(绝不透支)。
 *   · 两个函数都【不抛】:chargeMode1Video 失败返回 {ok:false, reason} 让 pipeline
 *     判任务失败(不生成);refundMode1Video 失败只返回 false(记日志,不影响清理)。
 */

import { getNoobClawAuthToken } from '../claudeSettings';

function apiBase(): string {
  return process.env.NOOBCLAW_API_BASE_URL || 'https://api.noobclaw.com';
}

export interface VideoChargeResult {
  ok: boolean;
  /** 本笔扣费的 ledger ref_id —— 退款时凭它定位原始扣费行。 */
  chargeId?: string;
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
      chargeId: typeof json?.chargeId === 'string' ? json.chargeId : undefined,
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

/**
 * 退回此前预扣的平台基础费(成片失败时调)。绝不抛错 —— 失败仅返回 false。
 * 幂等:服务端按 chargeId 防重复退,客户端可安全重试。
 */
export async function refundMode1Video(chargeId: string): Promise<boolean> {
  if (!chargeId) return false;
  const token = getNoobClawAuthToken();
  if (!token) return false;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15_000);
  try {
    const resp = await fetch(`${apiBase()}/api/video/refund`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ chargeId }),
      signal: ctrl.signal,
    });
    return resp.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
