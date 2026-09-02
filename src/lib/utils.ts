import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** shadcn 标配 cn()：clsx 拼接 + tailwind-merge 去冲突类 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
