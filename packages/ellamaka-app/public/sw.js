self.addEventListener("install", () => {
  self.skipWaiting()
})

self.addEventListener("activate", (e) => {
  e.waitUntil(self.clients.claim())
})

self.addEventListener("fetch", () => {
  // 空监听，用于通过浏览器 PWA 离线能力检测
})
