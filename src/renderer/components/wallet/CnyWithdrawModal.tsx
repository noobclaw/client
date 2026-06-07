/**
 * CnyWithdrawModal — CNY 人民币提现弹窗(客户端)
 *
 * 后端 routes/withdrawCny.ts 已就绪;本组件只做 UI:
 *   ① 拉额度 summary(可提现/已提现/处理中 + ¥50 起、上限、fee_pct)
 *   ② 选支付宝/微信 + 上传收款码(POST /upload-qr → R2 URL)
 *   ③ 填金额 → POST /api/me/withdraw/cny → 运营 1-3 工作日手动转账
 *   ④ 历史列表(pending/paid/canceled)
 *
 * 共享组件:InviteView(返佣页)和 WalletView(充值页)两处入口都开它。
 * 同时只允许 1 笔 pending(后端强约束),has_pending 时表单禁用。
 */

import React, { useEffect, useRef, useState } from 'react';
import { noobClawApi } from '../../services/noobclawApi';

type Summary = {
  total_earned: string; total_paid: string; total_pending: string;
  withdrawable: string; has_pending: boolean;
  min_amount: number; max_amount: number; fee_pct: number;
};
type HistItem = {
  id: string; amount_cny: string; fee_pct: number; amount_paid_cny: string;
  qr_kind: string; qr_image_url?: string | null; status: 'pending' | 'paid' | 'canceled';
  created_at: string; paid_at: string | null; paid_note: string | null; external_ref: string | null;
};

export const CnyWithdrawModal: React.FC<{
  isZh: boolean;
  onClose: () => void;
  onSuccess?: () => void;
}> = ({ isZh, onClose, onSuccess }) => {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [history, setHistory] = useState<HistItem[]>([]);
  const [loading, setLoading] = useState(true);

  const [amount, setAmount] = useState('');
  const [qrKind, setQrKind] = useState<'alipay' | 'wechat'>('alipay');
  const [qrUrl, setQrUrl] = useState('');         // 上传成功后的 R2 URL
  const [qrUploading, setQrUploading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [msg, setMsg] = useState<{ text: string; color: string }>({ text: '', color: '' });
  const fileRef = useRef<HTMLInputElement>(null);

  const refresh = async (): Promise<HistItem[]> => {
    const [s, h] = await Promise.all([
      noobClawApi.getCnyWithdrawSummary(),
      noobClawApi.getCnyWithdrawHistory(20),
    ]);
    if (s) setSummary(s);
    const items: HistItem[] = h.items || [];
    setHistory(items);
    setLoading(false);
    return items;
  };
  // 打开时预填「上次传过的收款码」(取最近一笔提现的 qr),让用户不必每次重传;
  // 之后可点「删除」清掉再重传。只在挂载时填一次,不覆盖用户当前的选择。
  useEffect(() => {
    void (async () => {
      const items = await refresh();
      const last = items.find((x) => x.qr_image_url);
      if (last?.qr_image_url) {
        setQrUrl((u) => u || last.qr_image_url || '');
        setQrKind(last.qr_kind === 'wechat' ? 'wechat' : 'alipay');
      }
    })();
  }, []);

  const handlePickQr = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setQrUploading(true);
    setMsg({ text: '', color: '' });
    try {
      const r = await noobClawApi.uploadCnyWithdrawQr(file);
      if (r.ok && r.url) setQrUrl(r.url);
      else setMsg({ text: (isZh ? '收款码上传失败:' : 'QR upload failed: ') + (r.error || ''), color: 'text-red-500' });
    } finally {
      setQrUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const handleSubmit = async () => {
    if (submitting || !summary) return;
    const amt = parseFloat(amount);
    if (!Number.isFinite(amt) || amt <= 0) { setMsg({ text: isZh ? '请输入有效金额' : 'Enter a valid amount', color: 'text-red-500' }); return; }
    if (amt < summary.min_amount) { setMsg({ text: (isZh ? '最低提现 ¥' : 'Min ¥') + summary.min_amount, color: 'text-red-500' }); return; }
    if (amt > summary.max_amount) { setMsg({ text: (isZh ? '单笔上限 ¥' : 'Max ¥') + summary.max_amount, color: 'text-red-500' }); return; }
    if (amt > parseFloat(summary.withdrawable)) { setMsg({ text: (isZh ? '超过可提现余额 ¥' : 'Over withdrawable ¥') + summary.withdrawable, color: 'text-red-500' }); return; }
    if (!qrUrl) { setMsg({ text: isZh ? '请先上传收款码' : 'Upload your receive QR first', color: 'text-red-500' }); return; }
    setSubmitting(true);
    setMsg({ text: '', color: '' });
    try {
      const r = await noobClawApi.createCnyWithdraw(amt, qrUrl, qrKind);
      if (r.ok) {
        setMsg({ text: r.message || (isZh ? '✅ 申请已提交,运营会在 1-3 个工作日内转账' : '✅ Submitted, paid in 1-3 business days'), color: 'text-green-500' });
        setAmount(''); // 保留 qrUrl —— 记住收款码,下次提现直接用,省得重传
        await refresh();
        onSuccess?.();
      } else {
        const errMap: Record<string, string> = {
          pending_exists: isZh ? '已有一笔提现处理中,请等运营处理后再申请' : 'A withdrawal is already pending',
          over_withdrawable: (isZh ? '超过可提现余额 ¥' : 'Over withdrawable ¥') + (r.withdrawable || ''),
          below_min: (isZh ? '低于最低提现额 ¥' : 'Below min ¥') + (r.min || ''),
          above_max: (isZh ? '超过单笔上限 ¥' : 'Above max ¥') + (r.max || ''),
        };
        setMsg({ text: errMap[r.error || ''] || (isZh ? '提交失败:' : 'Failed: ') + (r.error || ''), color: 'text-red-500' });
      }
    } finally {
      setSubmitting(false);
    }
  };

  const inputCls = 'w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm dark:text-white focus:outline-none focus:ring-2 focus:ring-green-500/50';
  const statusLabel = (s: string) => isZh
    ? ({ pending: '处理中', paid: '已转账', canceled: '已取消' }[s] || s)
    : s;
  const hasPending = !!summary?.has_pending;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="w-full max-w-lg max-h-[90vh] overflow-y-auto rounded-2xl bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 shadow-2xl p-6">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-lg font-bold dark:text-white">💴 {isZh ? 'CNY 提现' : 'Withdraw CNY'}</h3>
          <button type="button" onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none">×</button>
        </div>

        {loading ? (
          <div className="py-10 text-center text-sm text-gray-500">{isZh ? '加载中...' : 'Loading...'}</div>
        ) : (
          <>
            {/* 额度三数字 */}
            <div className="grid grid-cols-3 gap-2 mb-4">
              {[
                { label: isZh ? '可提现' : 'Withdrawable', val: summary?.withdrawable, hi: true },
                { label: isZh ? '处理中' : 'Pending', val: summary?.total_pending },
                { label: isZh ? '已提现' : 'Paid', val: summary?.total_paid },
              ].map((x, i) => (
                <div key={i} className="rounded-lg border border-gray-200 dark:border-gray-700 p-2.5 text-center">
                  <div className="text-[11px] text-gray-500 dark:text-gray-400 mb-0.5">{x.label}</div>
                  <div className={`text-base font-bold ${x.hi ? 'text-green-500' : 'dark:text-white'}`}>¥{x.val || '0.00'}</div>
                </div>
              ))}
            </div>

            {hasPending && (
              <div className="mb-3 rounded-lg bg-amber-500/10 border border-amber-500/30 px-3 py-2 text-xs text-amber-600 dark:text-amber-400">
                {isZh ? '已有一笔提现处理中,运营处理后才能申请下一笔。' : 'A withdrawal is pending; wait for it to be processed.'}
              </div>
            )}

            {/* 表单 */}
            <fieldset disabled={hasPending || submitting} className={hasPending ? 'opacity-50' : ''}>
              <label className="text-sm font-medium dark:text-gray-200 mb-1.5 block">{isZh ? '收款方式' : 'Receive via'}</label>
              <div className="grid grid-cols-2 gap-2 mb-3">
                {(['alipay', 'wechat'] as const).map((k) => (
                  <button key={k} type="button" onClick={() => setQrKind(k)}
                    className={`rounded-lg border p-2 text-sm ${qrKind === k ? 'border-green-500 bg-green-500/10 text-green-600 dark:text-green-400 font-medium' : 'border-gray-300 dark:border-gray-700 dark:text-gray-300'}`}>
                    {k === 'alipay' ? (isZh ? '支付宝' : 'Alipay') : (isZh ? '微信' : 'WeChat')}
                  </button>
                ))}
              </div>

              <label className="text-sm font-medium dark:text-gray-200 mb-1.5 block">{isZh ? '收款码' : 'Receive QR code'}</label>
              {qrUrl ? (
                // 已有收款码(本次上传 或 记住的上次):展示大图 + 删除 / 重新上传
                <div className="flex items-start gap-3 mb-3">
                  <div className="relative">
                    <img src={qrUrl} alt="qr" className="w-24 h-24 rounded-lg border border-gray-200 dark:border-gray-700 object-cover bg-white" />
                    <button type="button" title={isZh ? '删除' : 'Remove'} onClick={() => setQrUrl('')}
                      className="absolute -top-2 -right-2 w-5 h-5 rounded-full bg-red-500 text-white text-xs leading-none flex items-center justify-center shadow hover:bg-red-600">×</button>
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <span className="text-[11px] text-gray-400">{isZh ? '已上传(可删除后重传)' : 'Uploaded (remove to replace)'}</span>
                    <button type="button" onClick={() => fileRef.current?.click()} disabled={qrUploading}
                      className="px-3 py-1.5 rounded-lg text-xs border border-gray-300 dark:border-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-50 w-fit">
                      {qrUploading ? (isZh ? '上传中...' : 'Uploading...') : (isZh ? '重新上传' : 'Re-upload')}
                    </button>
                  </div>
                </div>
              ) : (
                <div className="flex items-center gap-3 mb-3">
                  <button type="button" onClick={() => fileRef.current?.click()} disabled={qrUploading}
                    className="px-3 py-2 rounded-lg text-sm border border-gray-300 dark:border-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-50">
                    {qrUploading ? (isZh ? '上传中...' : 'Uploading...') : (isZh ? '上传收款码' : 'Upload QR')}
                  </button>
                  <span className="text-[11px] text-gray-400">{isZh ? '支付宝/微信「我的收款码」截图' : 'Your Alipay/WeChat receive-QR screenshot'}</span>
                </div>
              )}
              <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/gif,image/webp" className="hidden" onChange={handlePickQr} />

              <label className="text-sm font-medium dark:text-gray-200 mb-1.5 block">
                {isZh ? '提现金额 (¥)' : 'Amount (¥)'}
                <span className="text-[11px] text-gray-400 ml-1">
                  {isZh ? `¥${summary?.min_amount}起,最多 ¥${summary?.withdrawable}` : `min ¥${summary?.min_amount}, up to ¥${summary?.withdrawable}`}
                </span>
              </label>
              <input className={inputCls} type="number" min={summary?.min_amount} value={amount}
                onChange={(e) => setAmount(e.target.value)} placeholder={String(summary?.min_amount || 50)} />

              {summary && summary.fee_pct > 0 && (
                <p className="text-[11px] text-gray-400 mt-1">{isZh ? `手续费 ${(summary.fee_pct * 100).toFixed(0)}%` : `Fee ${(summary.fee_pct * 100).toFixed(0)}%`}</p>
              )}

              <button type="button" onClick={handleSubmit} disabled={submitting || hasPending}
                className="w-full mt-4 py-2.5 rounded-lg text-sm font-semibold bg-green-500 text-white hover:bg-green-600 disabled:opacity-50">
                {submitting ? (isZh ? '提交中...' : 'Submitting...') : '💴 ' + (isZh ? '申请提现' : 'Request withdrawal')}
              </button>
            </fieldset>

            {msg.text && <p className={`mt-3 text-sm ${msg.color}`}>{msg.text}</p>}

            <p className="mt-3 text-[11px] text-gray-400 leading-relaxed">
              {isZh ? '提交后运营会在 1-3 个工作日内手动扫码转账,转账后状态变「已转账」。' : 'Ops will scan & transfer within 1-3 business days; status turns Paid afterwards.'}
            </p>

            {/* 历史 */}
            {history.length > 0 && (
              <div className="mt-5">
                <div className="text-sm font-medium dark:text-gray-200 mb-2">{isZh ? '提现记录' : 'History'}</div>
                <div className="space-y-1.5">
                  {history.map((h) => (
                    <div key={h.id} className="flex items-center justify-between rounded-lg border border-gray-200 dark:border-gray-700 px-3 py-2 text-xs">
                      <div className="dark:text-gray-200">
                        ¥{h.amount_cny} <span className="text-gray-400">· {h.qr_kind === 'wechat' ? (isZh ? '微信' : 'WeChat') : (isZh ? '支付宝' : 'Alipay')}</span>
                        <div className="text-[10px] text-gray-400">{new Date(h.created_at).toLocaleString()}</div>
                      </div>
                      <span className={`px-2 py-0.5 rounded-full text-[11px] ${h.status === 'paid' ? 'bg-green-500/10 text-green-500' : h.status === 'pending' ? 'bg-amber-500/10 text-amber-500' : 'bg-gray-500/10 text-gray-400'}`}>
                        {statusLabel(h.status)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
};
