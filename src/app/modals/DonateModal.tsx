// P22 打赏作者弹窗：微信/支付宝两收款码并排 + 轻文案。
// 收款码已用 sips 压缩（alipay.jpg / wxpay.png，均 <100KB），扫码经人工验证可用。

import alipayQr from "@/assets/donate/alipay.jpg";
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
          你的鼓励是我修 bug 的最大动力（比咖啡更管用）。金额不限，心意已收到。
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
