import * as React from "react"
import { XIcon } from "lucide-react"
import { Dialog as DialogPrimitive } from "radix-ui"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"

function Dialog({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Root>) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />
}

function DialogTrigger({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Trigger>) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />
}

function DialogPortal({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Portal>) {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />
}

function DialogClose({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Close>) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />
}

function DialogOverlay({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Overlay>) {
  return (
    <DialogPrimitive.Overlay
      data-slot="dialog-overlay"
      className={cn(
        /* P26c：不设 data-[state=closed] 关闭动画——WKWebView 冻结 transition 时
           overlay 永久停在起始帧（p20j 同坑），半透明遮罩残留遮挡全屏（z=50 压过菜单 z=20） */
        "fixed inset-0 z-50 [background:color-mix(in_srgb,var(--bg-base)_60%,transparent)] backdrop-blur-[var(--blur-soft)] data-[state=open]:animate-in data-[state=open]:fade-in-0",
        className
      )}
      {...props}
    />
  )
}

function DialogContent({
  className,
  children,
  showCloseButton = true,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & {
  showCloseButton?: boolean
}) {
  // P26 补丁：macOS WKWebView 原生鼠标不派发 pointerdown（p20m 黑匣子，p22f 同坑第三次），
  // Radix DismissableLayer 的「点遮罩关闭」只挂 document pointerdown 判定（mousedown 仅做
  // interaction 标记不触发 dismiss）→ 真实鼠标点遮罩永远关不掉弹窗。
  // 兜底：捕获 mousedown 且 target 在 Content 外 → 向原 target 派发合成 pointerdown
  // （DismissableLayer 不校验 isTrusted），Radix 原生 outside-close 流程照常接管。
  // 双发副作用防护：paneSwitchFromEvent 等双通道监听自带 200ms 去重窗（p20m）。
  const contentRef = React.useRef<HTMLDivElement | null>(null)
  React.useEffect(() => {
    function onMouseDown(e: MouseEvent) {
      const content = contentRef.current
      if (!content || !(e.target instanceof Node) || content.contains(e.target)) return
      const { clientX, clientY, button, buttons } = e
      e.target.dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          cancelable: true,
          clientX,
          clientY,
          button,
          buttons,
          pointerId: 1,
          pointerType: "mouse",
          isPrimary: true,
        }),
      )
    }
    document.addEventListener("mousedown", onMouseDown, true)
    return () => document.removeEventListener("mousedown", onMouseDown, true)
  }, [])
  return (
    <DialogPortal data-slot="dialog-portal">
      <DialogOverlay />
      <DialogPrimitive.Content
        ref={contentRef}
        data-slot="dialog-content"
        onOpenAutoFocus={(e) => {
          // P39：内容内已显式标注 autoFocus 的控件（如模型面板过滤框）优先获得
          // 初始焦点——Radix 默认把首个焦点给 Content 本体，会抢在子控件前。
          const target = contentRef.current?.querySelector<HTMLElement>("[data-autofocus='true']");
          if (target) {
            e.preventDefault();
            target.focus();
          }
        }}
        className={cn(
          "fixed top-[50%] left-[50%] z-50 grid w-full max-w-[calc(100%-2rem)] translate-x-[-50%] translate-y-[-50%] gap-4 rounded-lg border bg-background p-6 shadow-lg duration-200 outline-none data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 sm:max-w-lg",
          className
        )}
        {...props}
      >
        {children}
        {showCloseButton && (
          <DialogPrimitive.Close
            data-slot="dialog-close"
            className="absolute top-4 right-4 rounded-xs opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:ring-2 focus:ring-ring focus:ring-offset-2 focus:outline-hidden disabled:pointer-events-none data-[state=open]:bg-accent data-[state=open]:text-muted-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4"
          >
            <XIcon />
            <span className="sr-only">Close</span>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Content>
    </DialogPortal>
  )
}

function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-header"
      className={cn("flex flex-col gap-2 text-center sm:text-left", className)}
      {...props}
    />
  )
}

function DialogFooter({
  className,
  showCloseButton = false,
  children,
  ...props
}: React.ComponentProps<"div"> & {
  showCloseButton?: boolean
}) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn(
        "flex flex-col-reverse gap-2 sm:flex-row sm:justify-end",
        className
      )}
      {...props}
    >
      {children}
      {showCloseButton && (
        <DialogPrimitive.Close asChild>
          <Button variant="outline">Close</Button>
        </DialogPrimitive.Close>
      )}
    </div>
  )
}

function DialogTitle({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn("text-lg leading-none font-semibold", className)}
      {...props}
    />
  )
}

function DialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn("text-sm text-muted-foreground", className)}
      {...props}
    />
  )
}

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
}
