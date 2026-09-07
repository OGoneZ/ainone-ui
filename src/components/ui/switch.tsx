"use client"

// P30 滑动开关（左右切换）：radix-ui Switch 薄封装，与 ui/checkbox 同构。
// 用于设置页 harness 卡片的布尔选项（如 Claude Code bypass permissions）。
//
// 视觉对标手机系统设置（iOS/Android WiFi 开关）：加大的轨道（h-6 w-11）+
// 圆形滑块（size-5，打开时 translate-x-5 全程滑动）+ 打开态品牌蓝色轨道
// （bg-primary，与消息气泡同色）+ unchecked 灰轨道。transition-colors +
// transition-transform 双动画，滑动感来自「滑块横移 + 轨道变色同时发生」。
// 尺寸/位移参数取自 shadcn/ui 官方 switch（h-6 w-11 thumb 5 → translate-x-5）。
import * as React from "react"
import { Switch as SwitchPrimitive } from "radix-ui"

import { cn } from "@/lib/utils"

function Switch({
  className,
  ...props
}: React.ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        "peer cursor-pointer inline-flex h-6 w-11 shrink-0 items-center rounded-full border-2 border-transparent transition-colors duration-200 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-primary data-[state=unchecked]:bg-input",
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className={cn(
          "bg-background pointer-events-none block size-5 rounded-full shadow-lg ring-0 transition-transform duration-200 data-[state=checked]:translate-x-5 data-[state=unchecked]:translate-x-0",
        )}
      />
    </SwitchPrimitive.Root>
  )
}

export { Switch }
