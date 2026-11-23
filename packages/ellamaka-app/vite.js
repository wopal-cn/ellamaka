import { readFileSync } from "node:fs"
import solidPlugin from "vite-plugin-solid"
import tailwindcss from "@tailwindcss/vite"
import { resolveBuildChannel } from "@wopal/ellamaka-release/channel-resolve"
import { fileURLToPath } from "url"

const theme = fileURLToPath(new URL("./public/oc-theme-preload.js", import.meta.url))

const channel = resolveBuildChannel(process.env.ELLAMAKA_CHANNEL, "local")

/**
 * @type {import("vite").PluginOption}
 */
export default [
  {
    name: "opencode-desktop:config",
    config() {
      return {
        resolve: {
          alias: {
            "@": fileURLToPath(new URL("./src", import.meta.url)),
          },
        },
        define: {
          "import.meta.env.ELLAMAKA_CHANNEL": JSON.stringify(channel),
        },
        worker: {
          format: "es",
        },
      }
    },
  },
  {
    name: "opencode-desktop:theme-preload",
    // `pre` so the inline replacement lands before vite:build-html walks the
    // document; a post-order hook runs after it has already resolved the
    // `src` and warned that a classic script cannot be bundled.
    transformIndexHtml: {
      order: "pre",
      handler(html) {
        // The app's own index.html references the script root-relative, while
        // the Electron renderer must reference it relatively (see the desktop
        // html.test.ts contract, where `oc://` would resolve `/foo.js` from
        // the protocol root). Match either form, or the inline replacement
        // silently never fires and the theme flashes before the bundle
        // applies it.
        return html.replace(
          /<script id="oc-theme-preload-script" src="\.?\/oc-theme-preload\.js"><\/script>/,
          `<script id="oc-theme-preload-script">${readFileSync(theme, "utf8")}</script>`,
        )
      },
    },
  },
  tailwindcss(),
  solidPlugin(),
]
