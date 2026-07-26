# ROI 假设模型

| 项目             | 数值          | Basis               |
| ---------------- | ------------- | ------------------- |
| 每月异常案例     | 200           | configured_estimate |
| 单案例配置基线   | 12 小时       | configured_estimate |
| 单案例目标       | 4 小时        | configured_estimate |
| 配置估算年化价值 | CNY 3,840,000 | configured_estimate |
| 简单年化 ROI     | 6.68          | configured_estimate |
| 已证明收入       | 未知          | unknown             |

年化价值公式：`200 cases/month × 8 hours/case × 200 CNY/hour × 12 months/year = CNY 3,840,000`。

简单年化 ROI 公式：`(3,840,000 - 500,000) / 500,000 = 6.68`。

假设证据：
`assumption:input/outcome-assumptions.yaml@2026-07-26.2#annualValueCny` 和
`assumption:input/outcome-assumptions.yaml@2026-07-26.2#simpleAnnualRoiRate`。

## 反方校验

年化价值不能在第 30 天真实基线完成前用于投资回报承诺。若真实样本、采用率或人工复核成本与假设不符，模型必须重算，不能把估算升级为 observed。
