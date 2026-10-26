// 切换 General/Space Tab 的统一入口。WorkbenchState.setActive 会清除瞬态
// DSH 选择；DSH 本身不是持久化 Space Tab。
export function activateSpaceTab(wb: { setActive: (path: string) => void }, path: string) {
  wb.setActive(path)
}
