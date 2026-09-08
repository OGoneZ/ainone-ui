// P22 打赏作者弹窗：微信/支付宝两收款码并排 + 轻文案。
// 收款码已等比缩至 512 宽、底部裁至 700 高，存无损 PNG（均 <120KB），扫码经人工验证可用。

import alipayQr from "@/assets/donate/alipay.png";
import wxpayQr from "@/assets/donate/wxpay.png";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";

export function DonateModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-[560px] donate-modal">
        <DialogHeader>
          <DialogTitle>请作者喝杯咖啡 ☕</DialogTitle>
        </DialogHeader>
        <p className="donate-slogan">
          AI 是硅基的，作者是碳基的——碳基生物的充电口在下面。
        </p>
        <div className="donate-qr-row">
          <figure className="donate-qr">
            <img src={wxpayQr} alt="微信支付收款码" draggable={false} />
            <figcaption>微信支付</figcaption>
          </figure>
          <figure className="donate-qr">
            <img src={alipayQr} alt="支付宝收款码" draggable={false} />
            <figcaption>支付宝</figcaption>
          </figure>
        </div>
      </DialogContent>
    </Dialog>
  );
}
