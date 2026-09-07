"use client"

// P30 滑动开关（左右切换）：radix-ui Switch 薄封装，与 ui/checkbox 同构。
// 用于设置页 harness 卡片的布尔选项（如 Claude Code bypass permissions）。
//
// ⚠️ 层叠纪律（实测教训）：本仓库 app.css 的容器按钮重置规则（.adapter-row
// button 等）是 unlayered，恒胜 Tailwind @layer utilities 的颜色类——在
// utilities 层写 bg-primary/bg-input 会被容器规则白底覆盖（滑块白上白不可见）。
// 因此开关的轨道/滑块外观由 app.css「P30 滑动开关」块的 unlayered 规则驱动
// （button[role="switch"] + data-state 选择器 + 语义变量），本组件不写颜色类。
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
      className={cn("switch", className)}
      {...props}
    >
      <SwitchPrimitive.Thumb data-slot="switch-thumb" />
    </SwitchPrimitive.Root>
  )
}

export { Switch }
