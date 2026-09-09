// 切换 Space Tab 的统一入口。DSH 视图由激活 tab 派生（dshVisible = dshEnabled
// && 激活 tab 是 General），点空间 tab 只需 setActive，DSH 内容自动让位。
export function activateSpaceTab(
  wb: { setActive: (path: string) => void },
  path: string,
) {
  wb.setActive(path)
}
