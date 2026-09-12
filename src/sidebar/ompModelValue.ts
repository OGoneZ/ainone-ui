// P45：omp 会话级切换的值归一。
//
// 背景：侧栏模型列表来自网关探测（GET /v1/models 的裸 id），而 omp 的
// configOptions 里 model 选项的 value 是 `<provider>/<id>` 形态（omp 内部
// `#re(e){return `${e.provider}/${e.id}`}`），set_config_option 只认后者：
//
//   set "deepseek-v4-flash"        → Unknown ACP model: deepseek-v4-flash
//   set "ainone/deepseek-v4-flash" → OK
//
// 故点选后必须把裸 id 换算成 omp 认得的 ref 再发。换算用**会话自己回报的
// configOptions 反查**（而非硬编码 provider 名）：任何 provider 命名都成立，
// 用户换自配 provider 也不用改代码。

/** omp 未登记的模型兜底用 provider 名：本应用代写 omp 配置恒用 "ainone"
 *  （harness_config::omp_merge_write / omp_set_default_model 同约定）。 */
const FALLBACK_PROVIDER = "ainone";

interface SelectOption {
  value?: unknown;
  description?: unknown;
  options?: unknown;
}

/** 展平 select 选项（扁平数组或分组数组两种形态，ACP SessionConfigSelectOptions）。 */
function flattenOptions(options: unknown): SelectOption[] {
  if (!Array.isArray(options)) return [];
  const out: SelectOption[] = [];
  for (const o of options as SelectOption[]) {
    if (!o || typeof o !== "object") continue;
    if (Array.isArray(o.options)) {
      out.push(...flattenOptions(o.options));
      continue;
    }
    out.push(o);
  }
  return out;
}

/** 剥掉 ref 的首段 provider（`ainone/saver/glm-5.3` → `saver/glm-5.3`）。
 *  只剥一段：模型 id 自身可含斜杠（网关 id `saver/glm-5.3` 即如此），
 *  用 endsWith 匹配会把 `glm-5.3` 错配到 `saver/glm-5.3` 上。 */
function stripProvider(ref: string): string {
  const i = ref.indexOf("/");
  return i < 0 ? ref : ref.slice(i + 1);
}

/** 点选值 → 会话级 set_config_option 应发的值（omp）。
 *
 *  命中规则：选项的 value（或 description，omp 两者同为 `${provider}/${id}`）
 *  等于 picked，或剥掉 provider 首段后等于 picked → 取其 value。
 *  未命中（该模型未登记进 models.yml，会话本就切不过去）→ 回退
 *  `ainone/<picked>`：让错误停在 omp 侧的真实校验上，而非发出一个裸 id
 *  被误判成「harness 不支持」。 */
export function resolveOmpSessionValue(
  picked: string,
  configOptions: Array<{ category?: string | null; type: string; options?: unknown }> | null | undefined,
): string {
  const opt = configOptions?.find((o) => o.category === "model" && o.type === "select");
  for (const o of flattenOptions(opt?.options)) {
    const value = typeof o.value === "string" ? o.value : null;
    if (!value) continue;
    const desc = typeof o.description === "string" ? o.description : null;
    if (value === picked || desc === picked) return value;
    if (stripProvider(value) === picked || (desc && stripProvider(desc) === picked)) return value;
  }
  return `${FALLBACK_PROVIDER}/${picked}`;
}
