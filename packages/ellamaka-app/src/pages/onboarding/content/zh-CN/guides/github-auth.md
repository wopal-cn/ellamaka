GitHub 身份只决定能力本体能否使用 Fork。它不是使用 WopalSpace 的强制账号门槛。

## 已登录 gh

如果本机 `gh api user` 能读取当前账号，向导会直接识别，不需要再填写 Token。

## 尚未登录 gh

如果本机还没有完成 GitHub CLI 登录，请在终端运行 `gh auth login`。完成登录后回到向导，点击“重新检测 GitHub 登录”。

## 暂不连接 GitHub

选择“放弃 Fork，使用 Clone”即可进入下一步。此时能力本体只使用 Clone；以后仍可在完成 `gh auth login` 后重新使用 Fork。

**预计耗时：** 约 20 秒
