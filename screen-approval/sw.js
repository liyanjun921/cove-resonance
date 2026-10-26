"use strict";
self.addEventListener("install", event => { self.skipWaiting(); });
self.addEventListener("activate", event => { event.waitUntil(self.clients.claim()); });
self.addEventListener("push", event => {
  event.waitUntil(self.registration.showNotification("谢临川发来一条查看申请", {
    body: "打开截图查岗，决定是否授权。",
    tag: "xlc-screen-approval",
    renotify: false,
    data: {path: "/app"}
  }));
});
self.addEventListener("notificationclick", event => {
  event.notification.close();
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({type:"window",includeUncontrolled:true});
    for (const client of windows) {
      if (new URL(client.url).pathname === "/app") return client.focus();
    }
    return self.clients.openWindow("/app");
  })());
});
