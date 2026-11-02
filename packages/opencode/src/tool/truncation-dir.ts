import path from "path"
import { Global } from "@wopal/ellamaka-core/global"

export const truncationDir = () => path.join(Global.Path.data, "tool-output")
