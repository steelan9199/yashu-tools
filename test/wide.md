| 环节 | 输入物 | 输出物 | 工具 | 退出码含义 | 失败动作 | 责任席 | 备注 |
|:---|:---|:---|:---|:---|:---|:---|:---|
| 转表 | article.md | _t1.png | mdtables | 0 成功 | 停流水线 | AI | 表格逐个转 |
| 查字 | img.html | 报告 | fontlint | 0 合规 | 先修再截 | AI | 三条铁律 |
| 出图 | img.html | png | webshot | 0 成功 | 查选择器 | AI | scale 2 |
